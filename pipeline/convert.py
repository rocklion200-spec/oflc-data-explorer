#!/usr/bin/env python3
"""Convert raw OFLC .xlsx disclosure files into web-ready parquet.

Two phases:
  stage    each data/raw/*.xlsx -> data/stage/<program>/<name>.parquet,
           normalized to a unified core schema (skips files already staged)
  publish  union all staged files per program, dedupe by case number,
           write web/public/data/<program>_fy<YYYY>.parquet + datasets.json

The unified core schema lets one web UI serve LCA, PERM and PWD:
  program, case_number, case_status, received_date, decision_date,
  visa_class, employer_name, employer_city, employer_state,
  employer_postal_code, naics_code, job_title, soc_code, soc_title,
  worksite_city, worksite_county, worksite_state, worksite_postal_code,
  wage_from, wage_to, wage_unit, wage_annual, pw_wage, pw_unit, pw_annual,
  pw_wage_level, full_time_position, begin_date, end_date, total_workers,
  fiscal_year

Usage:
    python pipeline/convert.py            # stage new files, then publish
    python pipeline/convert.py --stage-only
    python pipeline/convert.py --republish
"""
import argparse
import json
import re
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
STAGE = ROOT / "data" / "stage"
WEB_DATA = ROOT / "web" / "public" / "data"

FILE_PAT = re.compile(
    r"^(LCA|PERM|PW|PWD)_Disclosure_Data(?:_New_Form)?_FY(\d{4})"
    r"(?:_Q(\d))?(?:_(?:old|revised|new)_form)?\.xlsx$", re.I)
PROGRAM_OF = {"LCA": "lca", "PERM": "perm", "PW": "pwd", "PWD": "pwd"}


STATES = {
    "ALABAMA": "AL", "ALASKA": "AK", "ARIZONA": "AZ", "ARKANSAS": "AR",
    "CALIFORNIA": "CA", "COLORADO": "CO", "CONNECTICUT": "CT", "DELAWARE": "DE",
    "DISTRICT OF COLUMBIA": "DC", "FLORIDA": "FL", "GEORGIA": "GA", "GUAM": "GU",
    "HAWAII": "HI", "IDAHO": "ID", "ILLINOIS": "IL", "INDIANA": "IN",
    "IOWA": "IA", "KANSAS": "KS", "KENTUCKY": "KY", "LOUISIANA": "LA",
    "MAINE": "ME", "MARYLAND": "MD", "MASSACHUSETTS": "MA", "MICHIGAN": "MI",
    "MINNESOTA": "MN", "MISSISSIPPI": "MS", "MISSOURI": "MO", "MONTANA": "MT",
    "NEBRASKA": "NE", "NEVADA": "NV", "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ",
    "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC",
    "NORTH DAKOTA": "ND", "NORTHERN MARIANA ISLANDS": "MP", "OHIO": "OH",
    "OKLAHOMA": "OK", "OREGON": "OR", "PENNSYLVANIA": "PA", "PUERTO RICO": "PR",
    "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD",
    "TENNESSEE": "TN", "TEXAS": "TX", "UTAH": "UT", "VERMONT": "VT",
    "VIRGIN ISLANDS": "VI", "VIRGINIA": "VA", "WASHINGTON": "WA",
    "WEST VIRGINIA": "WV", "WISCONSIN": "WI", "WYOMING": "WY",
}


def st(col: str) -> str:
    """Normalize a state column: full names -> USPS codes, else upper 2-letter."""
    whens = " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in STATES.items())
    return (f"(CASE upper(trim({col})) {whens} "
            f"ELSE CASE WHEN length(trim({col})) = 2 THEN upper(trim({col})) END END)")


def d(col: str) -> str:
    """Excel-serial-or-text date -> DATE."""
    return (f"COALESCE(DATE '1899-12-30' + try_cast(try_cast({col} AS DOUBLE) AS INT), "
            f"try_cast({col} AS DATE))")


def n(col: str) -> str:
    return f"try_cast(replace({col}, ',', '') AS DOUBLE)"


def annual(amount_expr: str, unit_col: str) -> str:
    """Annualize a wage given its unit-of-pay column.

    Filers sometimes report an annual salary with unit "Hour" (or vice
    versa), which would annualize to hundreds of millions. If the result
    is implausible but the raw amount looks like an annual salary, use the
    raw amount; otherwise NULL rather than poison averages.
    """
    return f"""(WITH b AS (SELECT round({amount_expr} * CASE
        WHEN {unit_col} ILIKE 'year%%'  THEN 1
        WHEN {unit_col} ILIKE 'month%%' THEN 12
        WHEN {unit_col} ILIKE 'bi%%'    THEN 26
        WHEN {unit_col} ILIKE 'week%%'  THEN 52
        WHEN {unit_col} ILIKE 'hour%%'  THEN 2080
        END, 0) AS v)
      SELECT CASE
        WHEN v BETWEEN 10000 AND 3000000 THEN v
        WHEN {amount_expr} BETWEEN 10000 AND 3000000 THEN round({amount_expr}, 0)
        END FROM b)"""


# target column -> SQL over the raw (all_varchar) sheet, per (program, era).
# "flag" era = FLAG system files, FY2020 and later.
MAPPINGS: dict[tuple[str, str], dict[str, str]] = {
    ("lca", "flag"): {
        "case_number": "CASE_NUMBER",
        "case_status": "CASE_STATUS",
        "received_date": d("RECEIVED_DATE"),
        "decision_date": d("DECISION_DATE"),
        "visa_class": "VISA_CLASS",
        "employer_name": "EMPLOYER_NAME",
        "employer_city": "EMPLOYER_CITY",
        "employer_state": st("EMPLOYER_STATE"),
        "employer_postal_code": "EMPLOYER_POSTAL_CODE",
        "naics_code": "NAICS_CODE",
        "job_title": "JOB_TITLE",
        "soc_code": "SOC_CODE",
        "soc_title": "SOC_TITLE",
        "worksite_city": "WORKSITE_CITY",
        "worksite_county": "WORKSITE_COUNTY",
        "worksite_state": st("WORKSITE_STATE"),
        "worksite_postal_code": "WORKSITE_POSTAL_CODE",
        "wage_from": n("WAGE_RATE_OF_PAY_FROM"),
        "wage_to": n("WAGE_RATE_OF_PAY_TO"),
        "wage_unit": "WAGE_UNIT_OF_PAY",
        "wage_annual": annual(n("WAGE_RATE_OF_PAY_FROM"), "WAGE_UNIT_OF_PAY"),
        "pw_wage": n("PREVAILING_WAGE"),
        "pw_unit": "PW_UNIT_OF_PAY",
        "pw_annual": annual(n("PREVAILING_WAGE"), "PW_UNIT_OF_PAY"),
        "pw_wage_level": "PW_WAGE_LEVEL",
        "full_time_position": "FULL_TIME_POSITION",
        "begin_date": d("BEGIN_DATE"),
        "end_date": d("END_DATE"),
        "total_workers": "try_cast(TOTAL_WORKER_POSITIONS AS INT)",
    },
    ("perm", "flag"): {  # "new form" PERM files (FY2024 New_Form, FY2025+)
        "case_number": "CASE_NUMBER",
        "case_status": "CASE_STATUS",
        "received_date": d("RECEIVED_DATE"),
        "decision_date": d("DECISION_DATE"),
        "visa_class": "'PERM'",
        "employer_name": "EMP_BUSINESS_NAME",
        "employer_city": "EMP_CITY",
        "employer_state": st("EMP_STATE"),
        "employer_postal_code": "EMP_POSTCODE",
        "naics_code": "EMP_NAICS",
        "job_title": "JOB_TITLE",
        "soc_code": "PWD_SOC_CODE",
        "soc_title": "PWD_SOC_TITLE",
        "worksite_city": "PRIMARY_WORKSITE_CITY",
        "worksite_county": "PRIMARY_WORKSITE_COUNTY",
        "worksite_state": st("PRIMARY_WORKSITE_STATE"),
        "worksite_postal_code": "PRIMARY_WORKSITE_POSTAL_CODE",
        "wage_from": n("JOB_OPP_WAGE_FROM"),
        "wage_to": n("JOB_OPP_WAGE_TO"),
        "wage_unit": "JOB_OPP_WAGE_PER",
        "wage_annual": annual(n("JOB_OPP_WAGE_FROM"), "JOB_OPP_WAGE_PER"),
        "full_time_position": "OTHER_REQ_IS_FULLTIME_EMP",
    },
    ("perm", "legacy"): {  # PERM files before the 2023 form change (FY2020-FY2024)
        "case_number": "CASE_NUMBER",
        "case_status": "CASE_STATUS",
        "received_date": d("RECEIVED_DATE"),
        "decision_date": d("DECISION_DATE"),
        "visa_class": "'PERM'",
        "employer_name": "EMPLOYER_NAME",
        "employer_city": "EMPLOYER_CITY",
        "employer_state": st("EMPLOYER_STATE_PROVINCE"),
        "employer_postal_code": "EMPLOYER_POSTAL_CODE",
        "naics_code": "NAICS_CODE",
        "job_title": "JOB_TITLE",
        "soc_code": "PW_SOC_CODE",
        "soc_title": "PW_SOC_TITLE",
        "worksite_city": "WORKSITE_CITY",
        "worksite_state": st("WORKSITE_STATE"),
        "worksite_postal_code": "WORKSITE_POSTAL_CODE",
        "wage_from": n("WAGE_OFFER_FROM"),
        "wage_to": n("WAGE_OFFER_TO"),
        "wage_unit": "WAGE_OFFER_UNIT_OF_PAY",
        "wage_annual": annual(n("WAGE_OFFER_FROM"), "WAGE_OFFER_UNIT_OF_PAY"),
        "pw_wage": n("PW_WAGE"),
        "pw_unit": "PW_UNIT_OF_PAY",
        "pw_annual": annual(n("PW_WAGE"), "PW_UNIT_OF_PAY"),
        "pw_wage_level": "PW_SKILL_LEVEL",
    },
    ("pwd", "flag"): {
        "case_number": "CASE_NUMBER",
        "case_status": "CASE_STATUS",
        "received_date": d("RECEIVED_DATE"),
        "decision_date": d("DETERMINATION_DATE"),
        "visa_class": "VISA_CLASS",
        "employer_name": "EMPLOYER_LEGAL_BUSINESS_NAME",
        "employer_city": "EMPLOYER_CITY",
        "employer_state": st("EMPLOYER_STATE"),
        "employer_postal_code": "EMPLOYER_POSTAL_CODE",
        "naics_code": "NAICS_CODE",
        "job_title": "JOB_TITLE",
        "soc_code": "PWD_SOC_CODE",
        "soc_title": "PWD_SOC_TITLE",
        "worksite_city": "PRIMARY_WORKSITE_CITY",
        "worksite_county": "PRIMARY_WORKSITE_COUNTY",
        "worksite_state": st("PRIMARY_WORKSITE_STATE"),
        "worksite_postal_code": "PRIMARY_WORKSITE_POSTAL_CODE",
        "wage_from": n("PWD_WAGE_RATE"),
        "wage_unit": "PWD_UNIT_OF_PAY",
        "wage_annual": annual(n("PWD_WAGE_RATE"), "PWD_UNIT_OF_PAY"),
        "pw_wage": n("PWD_WAGE_RATE"),
        "pw_unit": "PWD_UNIT_OF_PAY",
        "pw_annual": annual(n("PWD_WAGE_RATE"), "PWD_UNIT_OF_PAY"),
        "pw_wage_level": "PWD_OES_WAGE_LEVEL",
    },
}

CORE_COLUMNS = [
    "case_number", "case_status", "received_date", "decision_date",
    "visa_class", "employer_name", "employer_city", "employer_state",
    "employer_postal_code", "naics_code", "job_title", "soc_code",
    "soc_title", "worksite_city", "worksite_county", "worksite_state",
    "worksite_postal_code", "wage_from", "wage_to", "wage_unit",
    "wage_annual", "pw_wage", "pw_unit", "pw_annual", "pw_wage_level",
    "full_time_position", "begin_date", "end_date", "total_workers",
]
DATE_COLS = {"received_date", "decision_date", "begin_date", "end_date"}
NUM_COLS = {"wage_from", "wage_to", "wage_annual", "pw_wage", "pw_annual"}
INT_COLS = {"total_workers"}


def era_of(con: duckdb.DuckDBPyConnection, path: Path, program: str, fy: int) -> str | None:
    """Which schema era a file belongs to; None = not yet supported.

    PERM is detected from the actual header because old-form and new-form
    files coexist (FY2024 has one of each).
    """
    if fy < 2020:
        return None
    if program != "perm":
        return "flag"
    cols = {r[0] for r in con.execute(
        f"DESCRIBE SELECT * FROM read_xlsx('{path.as_posix()}', all_varchar=true)").fetchall()}
    return "flag" if "EMP_BUSINESS_NAME" in cols else "legacy"


def col_type(c: str) -> str:
    if c in DATE_COLS:
        return "DATE"
    if c in NUM_COLS:
        return "DOUBLE"
    if c in INT_COLS:
        return "INTEGER"
    return "VARCHAR"


SQL_WORDS = {
    "DATE", "INT", "INTEGER", "DOUBLE", "VARCHAR", "CASE", "WHEN", "THEN",
    "ELSE", "END", "ILIKE", "BETWEEN", "AND", "OR", "AS", "SELECT", "FROM",
    "WITH", "NULL", "COALESCE",
}


def referenced_cols(expr: str) -> set[str]:
    """Raw sheet columns an expression references (identifiers are UPPERCASE)."""
    no_strings = re.sub(r"'[^']*'", "", expr)
    tokens = set(re.findall(r"\b[A-Z][A-Z0-9_]+\b", no_strings))
    return {t for t in tokens if t not in SQL_WORDS and not t.startswith("TRY_CAST")}


def stage_file(con: duckdb.DuckDBPyConnection, path: Path, program: str, era: str) -> None:
    out = STAGE / program / (path.stem + ".parquet")
    if out.exists() and out.stat().st_mtime >= path.stat().st_mtime:
        print(f"staged (skip)  {path.name}")
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    mapping = MAPPINGS[(program, era)]
    have = {r[0] for r in con.execute(
        f"DESCRIBE SELECT * FROM read_xlsx('{path.as_posix()}', all_varchar=true)").fetchall()}
    select = ",\n  ".join(
        f"try_cast(({mapping[c]}) AS {col_type(c)}) AS {c}"
        if c in mapping and referenced_cols(mapping[c]) <= have
        else f"CAST(NULL AS {col_type(c)}) AS {c}"
        for c in CORE_COLUMNS)
    print(f"staging        {path.name} ...", flush=True)
    con.execute(f"""
        COPY (
          SELECT '{program}' AS program, {select}, '{path.name}' AS source_file
          FROM read_xlsx('{path.as_posix()}', all_varchar=true)
          WHERE CASE_NUMBER IS NOT NULL
        ) TO '{out.as_posix()}' (FORMAT parquet, COMPRESSION zstd)
    """)
    rows = con.execute(f"SELECT count(*) FROM '{out.as_posix()}'").fetchone()[0]
    print(f"staged         {out.relative_to(ROOT)} ({rows:,} rows)")


def stage_all(con: duckdb.DuckDBPyConnection) -> None:
    for path in sorted(RAW.glob("*.xlsx")):
        m = FILE_PAT.match(path.name)
        if not m:
            print(f"unrecognized   {path.name} (skipped)")
            continue
        program, fy = PROGRAM_OF[m.group(1).upper()], int(m.group(2))
        era = era_of(con, path, program, fy)
        if era is None:
            print(f"unsupported FY {path.name} (skipped; add era mapping)")
            continue
        stage_file(con, path, program, era)


def publish(con: duckdb.DuckDBPyConnection) -> None:
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    manifest = {"programs": {}}
    for program in ("lca", "perm", "pwd"):
        staged = sorted((STAGE / program).glob("*.parquet"))
        if not staged:
            continue
        files = ", ".join(f"'{p.as_posix()}'" for p in staged)
        # newest source file wins for duplicated case numbers
        con.execute(f"""
            CREATE OR REPLACE TEMP VIEW pub AS
            SELECT *,
                   year(COALESCE(decision_date, received_date))
                   + CASE WHEN month(COALESCE(decision_date, received_date)) >= 10
                          THEN 1 ELSE 0 END AS fiscal_year
            FROM (
              SELECT * EXCLUDE (source_file)
              FROM (
                SELECT *, row_number() OVER (
                  PARTITION BY case_number
                  ORDER BY decision_date DESC NULLS LAST, source_file DESC
                ) AS rn
                FROM read_parquet([{files}])
              ) WHERE rn = 1
            )
            WHERE fiscal_year IS NOT NULL
        """)
        fys = [r[0] for r in con.execute(
            "SELECT DISTINCT fiscal_year FROM pub ORDER BY 1").fetchall()]
        prog_files = []
        for fy in fys:
            out = WEB_DATA / f"{program}_fy{fy}.parquet"
            con.execute(f"""
                COPY (SELECT * EXCLUDE (rn) FROM pub WHERE fiscal_year = {fy}
                      ORDER BY decision_date)
                TO '{out.as_posix()}' (FORMAT parquet, COMPRESSION zstd)
            """)
            rows = con.execute(f"SELECT count(*) FROM '{out.as_posix()}'").fetchone()[0]
            prog_files.append({"fy": fy, "file": out.name, "rows": rows,
                               "bytes": out.stat().st_size})
            print(f"published      {out.name}: {rows:,} rows, {out.stat().st_size/1e6:.1f} MB")
        manifest["programs"][program] = prog_files
    (WEB_DATA / "datasets.json").write_text(json.dumps(manifest, indent=2))
    print(f"wrote          {(WEB_DATA / 'datasets.json').relative_to(ROOT)}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage-only", action="store_true")
    ap.add_argument("--republish", action="store_true",
                    help="skip staging, just rebuild web parquet from stage/")
    args = ap.parse_args()
    con = duckdb.connect()
    con.execute("INSTALL excel; LOAD excel;")
    if not args.republish:
        stage_all(con)
    if not args.stage_only:
        publish(con)


if __name__ == "__main__":
    main()
