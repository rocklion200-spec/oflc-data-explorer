#!/usr/bin/env python3
"""Download and convert the OFLC wage library (prevailing wage levels).

Source: https://flag.dol.gov/wage-data/wage-data-downloads — one zip per
wage year (effective July–June), containing the OEWS-based wage estimates
the DOL wage search serves:
  ALC_Export.csv    all-industries wages: Area, SocCode, GeoLvl,
                    Level1..Level4, Average [, Label]
  EDC_Export.csv    ACWIA higher-education wages, same shape
  Geography.csv     Area -> AreaName + one row per county (2021–2024 list
                    New England towns instead of counties; 2025+ counties)
  oes_soc_occs.csv  SOC code -> title/description (header names vary)

Published files (web/public/data/wages/):
  wages.parquet  one row per (wage_year, source, area, soc); soc_2018
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
                 to resolve a picked county to that year's area code)
  occ.parquet    per-year SOC titles
plus a "wages" block merged into datasets.json.

Data quirks handled here:
  - 2021-22 and 2022-23 exports lack the Label column; annual-basis rows
    (occupations OEWS publishes yearly: teachers, athletes, pilots) are
    detected by magnitude instead (hourly values never exceed ~210).
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

MEMBERS = {  # zip member basename -> staged name
    "alc_export.csv": "alc.csv",
    "edc_export.csv": "edc.csv",
    "geography.csv": "geo.csv",
    "oes_soc_occs.csv": "occ.csv",
}


def spans() -> list[tuple[int, str]]:
    """(start_year, 'YYYY-YY') for every wage year that could exist by now."""
    today = date.today()
    last = today.year if today.month >= 7 else today.year - 1
    return [(y, f"{y}-{(y + 1) % 100:02d}") for y in range(FIRST_YEAR, last + 1)]


def download() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    for _, span in spans():
        dest = RAW / f"OFLC_Wages_{span}.zip"
        if dest.exists() and dest.stat().st_size > 0:
            print(f"skip (exists)  {dest.name}")
            continue
        print(f"downloading    {dest.name} ...", flush=True)
        tmp = dest.with_suffix(".part")
        r = subprocess.run(CURL + ["-o", str(tmp), ZIP_URL.format(span=span)])
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
    for year, span in spans():
        zpath = RAW / f"OFLC_Wages_{span}.zip"
        if not zpath.exists():
            continue
        years.append(year)
        out = STAGE / f"wy{year}"
        if out.exists() and all((out / n).exists() for n in MEMBERS.values()):
            continue
        out.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zpath) as zf:
            found = {}
            for info in zf.infolist():
                base = info.filename.rsplit("/", 1)[-1].lower()
                if base in MEMBERS:
                    found[MEMBERS[base]] = info
            missing = set(MEMBERS.values()) - found.keys()
            if missing:
                raise SystemExit(f"{zpath.name}: missing members {missing}")
            for name, info in found.items():
                text = decode(zf.read(info))
                if name == "occ.csv":
                    # description holds unquoted commas — reparse, keep
                    # only the (cleanly quoted) code and title fields
                    rows = list(csv.reader(io.StringIO(text)))
                    buf = io.StringIO()
                    w = csv.writer(buf)
                    w.writerow(["soccode", "title"])
                    w.writerows(r[:2] for r in rows[1:] if len(r) >= 2)
                    text = buf.getvalue()
                (out / name).write_text(text, encoding="utf-8")
        print(f"extracted      wy{year}")
    return years


def csv_cols(con: duckdb.DuckDBPyConnection, path: Path) -> list[str]:
    return [r[0] for r in con.execute(
        f"DESCRIBE SELECT * FROM read_csv('{path.as_posix()}', all_varchar=true)"
    ).fetchall()]


def publish(con: duckdb.DuckDBPyConnection, years: list[int]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    num = lambda c: f"try_cast(nullif(trim({c}), '') AS DOUBLE)"

    wage_parts, geo_parts, occ_parts = [], [], []
    for year in years:
        d = STAGE / f"wy{year}"
        for source in ("alc", "edc"):
            path = d / f"{source}.csv"
            has_label = "Label" in csv_cols(con, path)
            # pre-Label years mark annual-basis occupations by magnitude
            # only: hourly figures top out around $210, annual ones start
            # in the tens of thousands
            annual = ("upper(trim(Label)) = 'ANNUAL WAGE'" if has_label
                      else f"COALESCE({num('Average')}, {num('Level1')}) > 500")
            note = "nullif(trim(Label), '')" if has_label else "NULL"
            wage_parts.append(f"""
                SELECT {year} AS wage_year, '{source}' AS source,
                       trim(Area) AS area, trim(SocCode) AS soc_code,
                       {soc_bridge('SocCode')} AS soc_2018,
                       try_cast(GeoLvl AS TINYINT) AS geo_lvl,
                       {num('Level1')} AS level1, {num('Level2')} AS level2,
                       {num('Level3')} AS level3, {num('Level4')} AS level4,
                       {num('Average')} AS average,
                       COALESCE({annual}, false) AS annual,
                       {note} AS note
                FROM read_csv('{path.as_posix()}', all_varchar=true)""")
        geo_parts.append(f"""
            SELECT {year} AS wage_year, trim(Area) AS area,
                   trim(AreaName) AS area_name, trim(StateAb) AS state_ab,
                   trim(State) AS state, trim(CountyTownName) AS county
            FROM read_csv('{(d / 'geo.csv').as_posix()}', all_varchar=true)""")
        occ_parts.append(f"""
            SELECT {year} AS wage_year, trim(soccode) AS soc_code,
                   {soc_bridge('soccode')} AS soc_2018, trim(title) AS title
            FROM read_csv('{(d / 'occ.csv').as_posix()}', all_varchar=true)""")

    entries = {}

    def copy(name: str, sql: str) -> None:
        out = OUT / f"{name}.parquet"
        con.execute(f"COPY ({sql}) TO '{out.as_posix()}' "
                    f"(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 65536)")
        rows = con.execute(f"SELECT count(*) FROM '{out.as_posix()}'").fetchone()[0]
        entries[name] = {"file": f"wages/{out.name}", "rows": rows,
                         "bytes": out.stat().st_size}
        print(f"published      wages/{out.name}: {rows:,} rows, "
              f"{out.stat().st_size / 1e6:.1f} MB")

    # rows with no figures at all ("No Leveled Wage", "No ACWIA") are noise
    copy("wages", f"""
        SELECT * FROM ({' UNION ALL '.join(wage_parts)})
        WHERE COALESCE(level1, level2, level3, level4, average) IS NOT NULL
        ORDER BY soc_2018, area, source, wage_year""")
    # a handful of keys (ME unorganized territories) map to several areas in
    # one year; keep one row per (year, state, county) so UI joins stay 1:1
    copy("geo", f"""
        SELECT wage_year, area, area_name, state_ab, state, county FROM (
          SELECT *, row_number() OVER (
            PARTITION BY wage_year, state_ab, county ORDER BY area) AS rn
          FROM ({' UNION ALL '.join(geo_parts)})
        ) WHERE rn = 1
        ORDER BY state_ab, county, wage_year""")
    copy("occ", f"""
        SELECT * FROM ({' UNION ALL '.join(occ_parts)})
        ORDER BY soc_code, wage_year""")
    # occupation picker index: every code that has wage rows, its freshest
    # title (split codes drop out of oes_soc_occs.csv after 2023 but keep
    # publishing wages), and which sources cover it
    copy("socs", f"""
        SELECT w.soc_2018 AS code,
               COALESCE(any_value(t.title), w.soc_2018) AS title,
               bool_or(w.source = 'alc') AS in_alc,
               bool_or(w.source = 'edc') AS in_edc
        FROM (SELECT DISTINCT soc_2018, source
              FROM read_parquet('{(OUT / 'wages.parquet').as_posix()}')) w
        LEFT JOIN (
          SELECT soc_2018, arg_max(title, wage_year) AS title
          FROM read_parquet('{(OUT / 'occ.parquet').as_posix()}')
          GROUP BY 1
        ) t ON t.soc_2018 = w.soc_2018
        GROUP BY 1 ORDER BY 1""")

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
