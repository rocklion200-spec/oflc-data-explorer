#!/usr/bin/env python3
"""Download and convert the OFLC wage library (prevailing wage levels).

Sources, one zip per wage year (effective July–June), containing the
OEWS-based wage estimates the DOL wage search serves:
  wage years 2021+  https://flag.dol.gov/wage-data/wage-data-downloads
  wage years 2005–2020  the retired FLC Data Center's OWL_<Y>_TEXT.zip
                    (named by the wage year's END year), via pinned Wayback
                    Machine captures — flcdatacenter.com now redirects
                    everything to flag.dol.gov and flag hosts nothing older
                    than 2021. Wage years before 2005-06 used a two-level
                    wage system and were never downloadable, so 2005 is the
                    floor.
Zip members (names vary by era; normalized to alc/edc/geo/occ.csv at
extract, tab-delimited members rewritten as comma CSV):
  ALC_Export.csv / ALC_WAGE.txt   all-industries wages: Area, SocCode,
                    GeoLvl, Level1..Level4 [, Average (2011+)] [, Label]
  EDC_Export.csv / EDC_ACWIA_WAGE.txt  ACWIA higher-education wages
  Geography.csv/.txt  Area -> AreaName + one row per county. Naming drifts
                    by era: 2005 proper case with suffix ("Abbeville
                    County", "Abington town"); 2006–2018 bare UPPERCASE
                    ("CHESTERFIELD", cities as "FAIRFAX CITY", New England
                    towns as "DUKES (CHILMARK)"); 2019+ modern ("Page
                    County", "Fairfax city", towns "Chilmark town" until
                    the 2025 switch to counties). county_key (below)
                    bridges them.
  oes_soc_occs.csv / soc_2010_directory.csv / Soc.txt  SOC titles

Published files (web/public/data/wages/):
  wages-*.parquet  one row per (wage_year, source, area, soc), sharded by
                 wage-year range to stay under GitHub's 100 MB cap; soc_2018
                 carries the SOC-2018 code (the 2021-22 wage year uses
                 SOC-2010 codes — bridged so trends span the revision;
                 OFLC's hybrid R&D/non-R&D split codes are NOT bridged,
                 they are distinct occupations with distinct wages);
                 sorted by (soc_2018, area) so a SOC lookup prunes to
                 few row groups
  socs.parquet   occupation picker index: one row per soc_2018 with the
                 latest title and which sources publish it (the ACWIA
                 table only publishes the split codes for some
                 occupations, never the plain one)
  geo.parquet    per-year county/town -> area mapping (the UI joins this
                 to resolve a picked county to that year's area code);
                 county_key normalizes the era naming drift (case,
                 County/Parish/etc. suffixes, the legacy "COUNTY (TOWN)"
                 New England form) so one pick spans all eras — the "city"
                 suffix is kept outside New England (VA/MD independent
                 cities share names with real counties) and stripped
                 inside it (NE city-form towns are the same place as
                 their legacy bare-name rows)
  occ.parquet    per-year SOC titles
plus a "wages" block merged into datasets.json.

Data quirks handled here:
  - Everything before 2023-24 lacks the Label column; annual-basis rows
    (occupations OEWS publishes yearly: teachers, athletes, pilots) are
    detected by magnitude instead (hourly values never exceed ~210).
  - Legacy years lack the Average column before wage year 2010 (it was
    added for the H-2 programs) and pad numbers with spaces.
  - Wage years 2005–2010 use SOC-2000 codes, 2011–2020 SOC-2010; both are
    bridged to soc_2018 like the 2021-22 year already was.
  - The FLC Data Center also published OWL_2021_1/_2 splits carrying the
    Oct 2020 IFR percentile wages that courts vacated that December; the
    plain OWL_2021 zip holds the standard OEWS data and is the one used.
  - "High Wage" rows carry only Average; "No Leveled Wage"/"No ACWIA"
    rows carry nothing and are dropped.
  - 2024-25 and 2025-26 zips nest their files inside a subdirectory.
  - Some years' CSVs are not UTF-8 (cp1252/other stray bytes); members
    are transcoded to UTF-8 during extraction.
  - oes_soc_occs.csv leaves commas in the description field unquoted (and
    names its columns differently across years), so it is re-written as a
    clean two-column soccode,title CSV during extraction.

Usage:
    python pipeline/wages.py               # download new years + publish
    python pipeline/wages.py --no-download
"""
import argparse
import csv
import io
import json
import subprocess
import zipfile
from datetime import date
from pathlib import Path

import duckdb

import groups

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "wages"
STAGE = ROOT / "data" / "stage" / "wages"
OUT = ROOT / "web" / "public" / "data" / "wages"
DATASETS = ROOT / "web" / "public" / "data" / "datasets.json"

ZIP_URL = "https://flag.dol.gov/sites/default/files/wages/OFLC_Wages_{span}.zip"
FIRST_YEAR = 2021  # earliest zip flag.dol.gov offers
CURL = ["curl", "-sL", "--fail", "--retry", "3", "-A", "Mozilla/5.0"]

# Legacy wage years from Wayback captures of the FLC Data Center. Keyed by
# START year like everything else; the OWL zip label is the END year, so
# wage year 2005 (July 2005–June 2006) is OWL_2006_TEXT.zip. Timestamps pin
# the capture each zip was validated against.
WAYBACK_URL = ("https://web.archive.org/web/{ts}id_/"
               "http://flcdatacenter.com/download/OWL_{label}_TEXT.zip")
LEGACY = {
    2005: "20101225170518", 2006: "20101031031415", 2007: "20170513022842",
    2008: "20170513022813", 2009: "20160317044401", 2010: "20160317044452",
    2011: "20120509171713", 2012: "20160317045451", 2013: "20170225143004",
    2014: "20170426221614", 2015: "20171203190232", 2016: "20190807231704",
    2017: "20190807215121", 2018: "20201017041735", 2019: "20201017045805",
    2020: "20221017163140",
}

# OFLC hybrid R&D / non-R&D split codes: groups.SOC_MAP folds these into
# their parent SOC for grouping disclosure filings, but in the wage library
# they are separate occupations with separate wage levels (and for some
# occupations the ACWIA table publishes only the splits), so the trend
# bridge must leave them alone.
KEEP_SPLIT = {"15-1034", "15-1035", "15-1036",
              "15-1295", "15-1296", "15-1297", "15-1298", "15-1799"}


def soc_bridge(col: str) -> str:
    """SOC vintage renames -> SOC-2018, leaving hybrid split codes as-is."""
    whens = " ".join(f"WHEN '{k}' THEN '{v}'"
                     for k, v in groups.SOC_MAP.items() if k not in KEEP_SPLIT)
    return f"(CASE trim({col}) {whens} ELSE trim({col}) END)"

MEMBERS = {  # zip member basename -> staged name, across all eras
    "alc_export.csv": "alc.csv", "alc_wage.txt": "alc.csv",
    "edc_export.csv": "edc.csv", "edc_acwia_wage.txt": "edc.csv",
    "geography.csv": "geo.csv", "geography.txt": "geo.csv",
    "oes_soc_occs.csv": "occ.csv", "soc_2010_directory.csv": "occ.csv",
    "soc.txt": "occ.csv",
}
STAGED = ("alc.csv", "edc.csv", "geo.csv", "occ.csv")


def spans() -> list[tuple[int, str]]:
    """(start_year, 'YYYY-YY') for every wage year that could exist by now."""
    today = date.today()
    last = today.year if today.month >= 7 else today.year - 1
    return [(y, f"{y}-{(y + 1) % 100:02d}") for y in range(FIRST_YEAR, last + 1)]


def zip_path(year: int) -> Path:
    if year in LEGACY:
        return RAW / f"OWL_{year + 1}_TEXT.zip"
    return RAW / f"OFLC_Wages_{year}-{(year + 1) % 100:02d}.zip"


def download() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    urls = {y: WAYBACK_URL.format(ts=ts, label=y + 1) for y, ts in LEGACY.items()}
    urls |= {y: ZIP_URL.format(span=span) for y, span in spans()}
    for year, url in sorted(urls.items()):
        dest = zip_path(year)
        if dest.exists() and dest.stat().st_size > 0:
            print(f"skip (exists)  {dest.name}")
            continue
        print(f"downloading    {dest.name} ...", flush=True)
        tmp = dest.with_suffix(".part")
        r = subprocess.run(CURL + ["-o", str(tmp), url])
        if r.returncode:
            tmp.unlink(missing_ok=True)
            print(f"not available  {dest.name}")
            continue
        tmp.rename(dest)
        print(f"done           {dest.name} ({dest.stat().st_size / 1e6:.0f} MB)")


def decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "cp1252"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            pass
    return data.decode("latin-1", errors="replace")


def extract() -> list[int]:
    """Unpack each zip's needed members (as UTF-8) into stage/wages/wy<Y>/."""
    years = []
    for year in sorted(LEGACY | dict(spans())):
        zpath = zip_path(year)
        if not zpath.exists():
            continue
        years.append(year)
        out = STAGE / f"wy{year}"
        if out.exists() and all((out / n).exists() for n in STAGED):
            continue
        out.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zpath) as zf:
            found = {}
            for info in zf.infolist():
                base = info.filename.rsplit("/", 1)[-1].lower()
                if base in MEMBERS:
                    found[MEMBERS[base]] = info
            missing = set(STAGED) - found.keys()
            if missing:
                raise SystemExit(f"{zpath.name}: missing members {missing}")
            for name, info in found.items():
                text = decode(zf.read(info))
                delim = "\t" if "\t" in text.partition("\n")[0] else ","
                if name == "occ.csv":
                    # keep only the code and title fields: descriptions hold
                    # unquoted commas in some years, junk empty columns in
                    # others, and header names vary across all of them
                    rows = list(csv.reader(io.StringIO(text), delimiter=delim))
                    buf = io.StringIO()
                    w = csv.writer(buf)
                    w.writerow(["soccode", "title"])
                    w.writerows(r[:2] for r in rows[1:] if len(r) >= 2 and r[0].strip())
                    text = buf.getvalue()
                elif delim == "\t":
                    # the 2005 wage year ships tab-delimited members
                    rows = csv.reader(io.StringIO(text), delimiter="\t")
                    buf = io.StringIO()
                    csv.writer(buf).writerows(rows)
                    text = buf.getvalue()
                (out / name).write_text(text, encoding="utf-8")
        print(f"extracted      wy{year}")
    return years


def csv_cols(con: duckdb.DuckDBPyConnection, path: Path) -> list[str]:
    return [r[0] for r in con.execute(
        f"DESCRIBE SELECT * FROM read_csv('{path.as_posix()}', all_varchar=true)"
    ).fetchall()]


NEW_ENGLAND = "('CT','MA','ME','NH','RI','VT')"

# minor-division suffixes seen across eras; CITY AND BOROUGH before BOROUGH
# so Juneau loses the whole phrase, and CITY only inside New England (a
# city-form town is the same place as its legacy bare-name row, while a VA/MD
# independent city must stay distinct from the county sharing its name).
# Applied twice: 2005-era MA names stack suffixes ("Barnstable Town city").
SUFFIXES = ("COUNTY|PARISH|MUNICIPIO|CITY AND BOROUGH|BOROUGH|CENSUS AREA|"
            "MUNICIPALITY|TOWN|TOWNSHIP|PLANTATION|GORE|GRANT|LOCATION|PURCHASE")


def county_key(county: str, state_ab: str) -> str:
    """SQL: era-stable join key for a county/town name (see module docstring)."""
    strip = lambda k, sfx: f"regexp_replace({k}, ' ({sfx})$', '')"
    k = f"upper(strip_accents(trim({county})))"
    # the 2005 era marks counties of multi-state MSAs: 'Bristol County, MA (pt.)'
    k = f"regexp_replace({k}, ' \\(PT\\.?\\)$', '')"
    k = f"regexp_replace({k}, ', [A-Z][A-Z]$', '')"
    # legacy New England rows are 'COUNTY (TOWN)' — the town is the identity;
    # innermost name wins for the odd nested 'DUKES (AQUINNAH (GAY HEAD))'
    k = f"""(CASE WHEN k1 LIKE '% (%)' THEN regexp_extract(k1, '\\(([^()]+)\\)+$', 1)
                  ELSE k1 END)""".replace("k1", f"({k})")
    sfx = f"{SUFFIXES}|CITY"
    k = (f"(CASE WHEN upper(trim({state_ab})) IN {NEW_ENGLAND} "
         f"THEN {strip(strip(k, sfx), sfx)} ELSE {strip(strip(k, SUFFIXES), SUFFIXES)} END)")
    return f"regexp_replace({k}, '[^A-Z0-9]', '', 'g')"


def publish(con: duckdb.DuckDBPyConnection, years: list[int]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    num = lambda c: f"try_cast(nullif(trim({c}), '') AS DOUBLE)"

    wage_parts, geo_parts, occ_parts = [], [], []
    for year in years:
        d = STAGE / f"wy{year}"
        for source in ("alc", "edc"):
            path = d / f"{source}.csv"
            cols = csv_cols(con, path)
            has_label = "Label" in cols
            # Average arrived with the H-2 programs in wage year 2010
            avg = num("Average") if "Average" in cols else "NULL"
            # pre-Label years mark annual-basis occupations by magnitude
            # only: hourly figures top out around $210, annual ones start
            # in the tens of thousands
            annual = ("upper(trim(Label)) = 'ANNUAL WAGE'" if has_label
                      else f"COALESCE({avg}, {num('Level1')}) > 500")
            note = "nullif(trim(Label), '')" if has_label else "NULL"
            wage_parts.append(f"""
                SELECT {year} AS wage_year, '{source}' AS source,
                       trim(Area) AS area, trim(SocCode) AS soc_code,
                       {soc_bridge('SocCode')} AS soc_2018,
                       try_cast(GeoLvl AS TINYINT) AS geo_lvl,
                       {num('Level1')} AS level1, {num('Level2')} AS level2,
                       {num('Level3')} AS level3, {num('Level4')} AS level4,
                       {avg} AS average,
                       COALESCE({annual}, false) AS annual,
                       {note} AS note
                FROM read_csv('{path.as_posix()}', all_varchar=true)""")
        geo_parts.append(f"""
            SELECT {year} AS wage_year, trim(Area) AS area,
                   trim(AreaName) AS area_name, trim(StateAb) AS state_ab,
                   trim(State) AS state, trim(CountyTownName) AS county,
                   {county_key('CountyTownName', 'StateAb')} AS county_key
            FROM read_csv('{(d / 'geo.csv').as_posix()}', all_varchar=true)""")
        occ_parts.append(f"""
            SELECT {year} AS wage_year, trim(soccode) AS soc_code,
                   {soc_bridge('soccode')} AS soc_2018, trim(title) AS title
            FROM read_csv('{(d / 'occ.csv').as_posix()}', all_varchar=true)""")

    entries = {}

    def copy(name: str, sql: str, shards: dict[str, str] | None = None) -> None:
        """Publish one parquet, or several (GitHub caps files at 100 MB).

        Shard conditions replace the /*shard*/ marker inside the query's own
        WHERE clause so the trailing ORDER BY (which row-group pruning relies
        on) stays in effect.
        """
        parts = shards or {f"{name}.parquet": ""}
        rows, size = 0, 0
        for fname, cond in parts.items():
            out = OUT / fname
            q = sql.replace("/*shard*/", f"AND ({cond})" if cond else "")
            con.execute(f"COPY ({q}) TO '{out.as_posix()}' "
                        f"(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 65536)")
            rows += con.execute(f"SELECT count(*) FROM '{out.as_posix()}'").fetchone()[0]
            size += out.stat().st_size
        files = [f"wages/{f}" for f in parts]
        entries[name] = ({"file": files[0]} if not shards else {"files": files}) \
            | {"rows": rows, "bytes": size}
        print(f"published      {', '.join(files)}: {rows:,} rows, "
              f"{size / 1e6:.1f} MB")

    # rows with no figures at all ("No Leveled Wage", "No ACWIA") are noise
    copy("wages", f"""
        SELECT * FROM ({' UNION ALL '.join(wage_parts)})
        WHERE COALESCE(level1, level2, level3, level4, average) IS NOT NULL
          /*shard*/
        ORDER BY soc_2018, area, source, wage_year""",
        shards={"wages-2005.parquet": "wage_year < 2016",
                "wages-2016.parquet": "wage_year >= 2016"})
    # a handful of keys (ME unorganized territories, NE towns sharing a name
    # across counties) map to several areas in one year; keep one row per
    # (year, state, county_key) so UI joins stay 1:1
    copy("geo", f"""
        SELECT wage_year, area, area_name, state_ab, state, county, county_key
        FROM (
          SELECT *, row_number() OVER (
            PARTITION BY wage_year, state_ab, county_key ORDER BY area) AS rn
          FROM ({' UNION ALL '.join(geo_parts)})
        ) WHERE rn = 1
        ORDER BY state_ab, county_key, wage_year""")
    copy("occ", f"""
        SELECT * FROM ({' UNION ALL '.join(occ_parts)})
        ORDER BY soc_code, wage_year""")
    # occupation picker index: every code that has wage rows, its freshest
    # title (split codes drop out of oes_soc_occs.csv after 2023 but keep
    # publishing wages), and which sources cover it
    # group_code folds OFLC's hybrid split codes (left alone by soc_bridge)
    # into the disclosure data's soc_group, so "Filings for this occupation"
    # can cross-link split-code picks to actual filings
    copy("socs", f"""
        SELECT *, {groups.soc_group('code')} AS group_code FROM (
          SELECT w.soc_2018 AS code,
                 COALESCE(any_value(t.title), w.soc_2018) AS title,
                 bool_or(w.source = 'alc') AS in_alc,
                 bool_or(w.source = 'edc') AS in_edc
          FROM (SELECT DISTINCT soc_2018, source
                FROM read_parquet('{(OUT / 'wages-*.parquet').as_posix()}')) w
          LEFT JOIN (
            SELECT soc_2018, arg_max(title, wage_year) AS title
            FROM read_parquet('{(OUT / 'occ.parquet').as_posix()}')
            GROUP BY 1
          ) t ON t.soc_2018 = w.soc_2018
          GROUP BY 1
        ) ORDER BY 1""")

    manifest = json.loads(DATASETS.read_text()) if DATASETS.exists() else {}
    manifest["wages"] = {"years": years, "files": entries}
    DATASETS.write_text(json.dumps(manifest, indent=2))
    print(f"wrote          wages block into {DATASETS.relative_to(ROOT)}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-download", action="store_true")
    args = ap.parse_args()
    if not args.no_download:
        download()
    years = extract()
    if not years:
        raise SystemExit("no wage zips in data/raw/wages")
    publish(duckdb.connect(), years)


if __name__ == "__main__":
    main()
