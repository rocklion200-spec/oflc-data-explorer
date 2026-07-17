"""SQL expression builders for the entity-group columns.

Three logical groupings are computed at publish time (see convert.py):

  employer_group  algorithmic name normalization (case, punctuation, legal
                  suffixes, d/b/a) + curated families from
                  employer_families.json (subsidiaries/rebrands of major
                  filers, e.g. Ayco -> Goldman Sachs, AWS -> Amazon)
  soc_group       SOC code normalized to XX-XXXX (keeping meaningful O*NET
                  .XX details) + a crosswalk collapsing SOC-2000/2010/hybrid
                  vintages and legacy 3-digit DOT-era codes into one key
  title_group     job title with sub-specialty tails, seniority prefixes and
                  level suffixes stripped ("SR. ANALYST" -> "ANALYST",
                  "Vice President, Software Engineering" -> "VICE PRESIDENT")

Group keys are stable strings; display labels for non-curated groups are the
modal raw spelling, computed when the aggregate files are built.
"""
import json
from pathlib import Path

FAMILIES_FILE = Path(__file__).resolve().parent / "employer_families.json"

_SUFFIX_RE = (
    r"( (INC|INCORPORATED|LLC|L L C|LLP|LP|L P|LTD|LIMITED|PLC|PLLC|PC|PA"
    r"|CORP|CORPORATION|CO|COMPANY|COMPANIES|& CO|AND CO))+$"
)


def employer_norm(col: str) -> str:
    """Algorithmically normalized employer name (the curation match target)."""
    x = f"upper(trim({col}))"
    x = f"replace({x}, '&AMP;', '&')"                        # HTML entity leftovers
    x = f"""regexp_replace({x}, '[.,''"!?*]', '', 'g')"""    # punctuation
    x = f"regexp_replace({x}, '[()\\[\\]/]', ' ', 'g')"      # parens etc -> space
    x = f"trim(regexp_replace({x}, '\\s+', ' ', 'g'))"
    x = f"regexp_replace({x}, ' (DBA|D B A) .*$', '')"       # keep legal name, drop d/b/a

    x = f"regexp_replace({x}, '^THE ', '')"
    x = f"regexp_replace({x}, '{_SUFFIX_RE}', '')"           # twice: "& CO LLC"
    x = f"regexp_replace({x}, '{_SUFFIX_RE}', '')"
    x = f"nullif(trim(regexp_replace({x}, '[ &,-]+$', '')), '')"
    return x


def employer_group(col: str) -> str:
    """Curated family label if a pattern matches the normalized name, else it."""
    families = json.loads(FAMILIES_FILE.read_text())["families"]
    norm = employer_norm(col)
    whens = []
    for f in families:
        label = f["group"].replace("'", "''")
        conds = " OR ".join(f"n LIKE '{p}'"
                            for p in (pat.replace("'", "''") for pat in f["patterns"]))
        whens.append(f"WHEN {conds} THEN '{label}'")
    return (f"(SELECT CASE WHEN n IS NULL THEN NULL {' '.join(whens)} ELSE n END "
            f"FROM (SELECT {norm} AS n))")


def curated_labels() -> list[str]:
    """The curated family names (their group key doubles as display label)."""
    return [f["group"] for f in json.loads(FAMILIES_FILE.read_text())["families"]]


# SOC vintage crosswalk -> one group key per occupation. Targets are SOC-2018
# codes where a clean official mapping exists; O*NET-detail keys are kept when
# they identify a distinct occupation. Legacy 3-digit DOT-era codes (EFILE
# FY2008-09; Excel strips their leading zeros) map where the target clearly
# dominates. Unlisted codes stay their own group, labeled by modal title.
SOC_MAP = {
    # SOC-2000 -> 2018
    "15-1011": "15-1221", "15-1021": "15-1251", "15-1031": "15-1252",
    "15-1032": "15-1252", "15-1041": "15-1232", "15-1051": "15-1211",
    "15-1061": "15-1242", "15-1071": "15-1244", "15-1081": "15-1241",
    "15-1099": "15-1299",
    # SOC-2010 -> 2018
    "15-1111": "15-1221", "15-1121": "15-1211", "15-1122": "15-1212",
    "15-1131": "15-1251", "15-1132": "15-1252", "15-1133": "15-1252",
    "15-1134": "15-1254", "15-1141": "15-1242", "15-1142": "15-1244",
    "15-1143": "15-1241", "15-1151": "15-1232", "15-1152": "15-1231",
    "15-1199": "15-1299",
    # O*NET details of 15-1199 that are distinct occupations
    "15-1199.01": "15-1253", "15-1199.02": "15-1299.08",
    "15-1199.06": "15-1243", "15-1199.07": "15-1243.01",
    "15-1199.08": "15-2051.01", "15-1199.09": "15-1299.09",
    # OFLC hybrid R&D / non-R&D splits
    "15-1034": "15-1252", "15-1035": "15-1252", "15-1036": "15-1252",
    "15-1295": "15-1252", "15-1296": "15-1252", "15-1297": "15-1253",
    "15-1298": "15-1253", "15-1799": "15-1299",
    # physicians (2010 -> 2018 reshuffle, top codes only)
    "29-1062": "29-1215", "29-1063": "29-1216", "29-1066": "29-1223",
    "29-1069": "29-1229",
    # legacy 3-digit DOT-era occupation codes
    "30": "15-1252", "39": "15-1299", "31": "15-1241", "3": "17-2071",
    "7": "17-2141", "5": "17-2051", "12": "17-2112", "160": "13-2011",
    "161": "13-1111", "70": "29-1229", "22": "19-2031", "41": "19-1029",
    "50": "19-3011",
}


def soc_norm(col: str) -> str:
    """SOC code -> 'XX-XXXX' (or 'XX-XXXX.XX' for meaningful O*NET details)."""
    c = f"upper(trim({col}))"
    return f"""(SELECT CASE
        WHEN c IS NULL OR c = '' THEN NULL
        WHEN regexp_matches(c, '^\\d{{2}}-\\d{{4}}') THEN
          CASE WHEN regexp_extract(c, '^\\d{{2}}-\\d{{4}}\\.(\\d{{2}})', 1)
                    NOT IN ('', '00')
               THEN regexp_extract(c, '^\\d{{2}}-\\d{{4}}\\.\\d{{2}}')
               ELSE regexp_extract(c, '^\\d{{2}}-\\d{{4}}') END
        WHEN regexp_matches(c, '^\\d{{6}}$') THEN c[1:2] || '-' || c[3:6]
        ELSE c END
      FROM (SELECT nullif({c}, '') AS c))"""


def soc_group(col: str) -> str:
    whens = " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in SOC_MAP.items())
    return f"(SELECT CASE s {whens} ELSE s END FROM (SELECT {soc_norm(col)} AS s))"


def title_group(col: str) -> str:
    """Normalized job title: base title without specialty/seniority/level."""
    x = f"upper(trim({col}))"
    x = f"regexp_replace({x}, '\\s*[,;/(–—•·].*$', '')"      # cut specialty tail
    x = f"regexp_replace({x}, '\\s+[-–—]\\s.*$', '')"        # " - Payments" etc
    x = f"regexp_replace({x}, '^((SR|SNR|JR)\\.? |SENIOR |JUNIOR |LEAD |PRINCIPAL |STAFF )+', '')"
    x = f"regexp_replace({x}, '( (I|II|III|IV|V|VI|VII|[0-9]{{1,2}}|LEVEL ?[0-9IVX]+|L[0-9]))+$', '')"
    x = f"nullif(trim(regexp_replace({x}, '\\s+', ' ', 'g')), '')"
    return f"COALESCE({x}, nullif(upper(trim({col})), ''))"
