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
  worksite_address, worksite_city, worksite_county, worksite_state,
  worksite_postal_code,
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

import groups
from download import identify

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
STAGE = ROOT / "data" / "stage"
WEB_DATA = ROOT / "web" / "public" / "data"


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
    return f"try_cast(replace(replace({col}, ',', ''), '$', '') AS DOUBLE)"


def addr(*cols: str) -> str:
    """Join street-address line columns, dropping blank lines."""
    parts = ", ".join(f"nullif(trim({c}), '')" for c in cols)
    return f"nullif(concat_ws(', ', {parts}), '')"


def norm_status(expr: str) -> str:
    """Normalize case-status casing across eras (legacy files are UPPERCASE)."""
    return f"""(CASE upper(trim({expr}))
        WHEN 'CERTIFIED' THEN 'Certified'
        WHEN 'CERTIFIED-WITHDRAWN' THEN 'Certified - Withdrawn'
        WHEN 'CERTIFIED - WITHDRAWN' THEN 'Certified - Withdrawn'
        WHEN 'DENIED' THEN 'Denied'
        WHEN 'WITHDRAWN' THEN 'Withdrawn'
        WHEN 'REJECTED' THEN 'Rejected'
        WHEN 'INVALIDATED' THEN 'Invalidated'
        WHEN 'DETERMINATION ISSUED' THEN 'Determination Issued'
        ELSE trim({expr}) END)"""


def annual(amount_expr: str, unit_col: str) -> str:
    """Annualize a wage given its unit-of-pay column.

    Filers sometimes report an annual salary with unit "Hour" (or vice
    versa), which would annualize to hundreds of millions. If the result
    is implausible but the raw amount looks like an annual salary, use the
    raw amount; otherwise NULL rather than poison averages.
    """
    return f"""(WITH b AS (SELECT round({amount_expr} * CASE
        WHEN {unit_col} ILIKE 'year%%'  OR upper(trim({unit_col})) = 'YR'  THEN 1
        WHEN {unit_col} ILIKE 'month%%' OR upper(trim({unit_col})) = 'MTH' THEN 12
        WHEN {unit_col} ILIKE 'bi%%'                                      THEN 26
        WHEN {unit_col} ILIKE 'week%%'  OR upper(trim({unit_col})) = 'WK'  THEN 52
        WHEN {unit_col} ILIKE 'hour%%'  OR upper(trim({unit_col})) = 'HR'  THEN 2080
        END, 0) AS v)
      SELECT CASE
        WHEN v BETWEEN 10000 AND 3000000 THEN v
        WHEN {amount_expr} BETWEEN 10000 AND 3000000 THEN round({amount_expr}, 0)
        END FROM b)"""


NULL_UNIT = "CAST(NULL AS VARCHAR)"  # unknown unit; annual() keeps plausible values

# target column -> SQL over the raw (all_varchar) sheet, per (program, era).
# A value may be a list of candidate expressions: the first whose referenced
# columns exist in the file is used (handles per-year drift within an era).
# Legacy headers with spaces/digits are double-quoted with their exact case.
# Eras: "flag" = FLAG system (FY2020+); the rest are detected in era_of().
MAPPINGS: dict[tuple[str, str], dict] = {
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
        "worksite_address": [addr("WORKSITE_ADDRESS1", "WORKSITE_ADDRESS2"),
                             addr("WORKSITE_ADDRESS1")],
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
        "worksite_address": [addr("PRIMARY_WORKSITE_ADDR1", "PRIMARY_WORKSITE_ADDR2"),
                             addr("PRIMARY_WORKSITE_ADDR1")],
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
        "worksite_address": [addr("WORKSITE_ADDRESS_1", "WORKSITE_ADDRESS_2"),
                             addr("WORKSITE_ADDRESS_1")],
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
        "worksite_address": [addr("PRIMARY_WORKSITE_ADDRESS_1", "PRIMARY_WORKSITE_ADDRESS_2"),
                             addr("PRIMARY_WORKSITE_ADDRESS_1")],
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
    # --- LCA, FY2019 (single-file layout with numbered worksite blocks) ---
    ("lca", "h1b19"): {
        "case_number": "CASE_NUMBER",
        "case_status": "CASE_STATUS",
        "received_date": d("CASE_SUBMITTED"),
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
        "worksite_address": [addr("WORKSITE_ADDRESS1_1", "WORKSITE_ADDRESS2_1"),
                             addr("WORKSITE_ADDRESS1_1")],
        "worksite_city": "WORKSITE_CITY_1",
        "worksite_county": "WORKSITE_COUNTY_1",
        "worksite_state": st("WORKSITE_STATE_1"),
        "worksite_postal_code": "WORKSITE_POSTAL_CODE_1",
        "wage_from": n("WAGE_RATE_OF_PAY_FROM_1"),
        "wage_to": n("WAGE_RATE_OF_PAY_TO_1"),
        "wage_unit": "WAGE_UNIT_OF_PAY_1",
        "wage_annual": annual(n("WAGE_RATE_OF_PAY_FROM_1"), "WAGE_UNIT_OF_PAY_1"),
        "pw_wage": n("PREVAILING_WAGE_1"),
        "pw_unit": "PW_UNIT_OF_PAY_1",
        "pw_annual": annual(n("PREVAILING_WAGE_1"), "PW_UNIT_OF_PAY_1"),
        "pw_wage_level": "PW_WAGE_LEVEL_1",
        "full_time_position": "FULL_TIME_POSITION",
        "begin_date": d("PERIOD_OF_EMPLOYMENT_START_DATE"),
        "end_date": d("PERIOD_OF_EMPLOYMENT_END_DATE"),
        "total_workers": "try_cast(TOTAL_WORKER_POSITIONS AS INT)",
    },
    # --- LCA, FY2015-FY2018 ---
    ("lca", "h1b15"): {
        "case_number": "CASE_NUMBER",
        "case_status": "CASE_STATUS",
        "received_date": d("CASE_SUBMITTED"),
        "decision_date": d("DECISION_DATE"),
        "visa_class": "VISA_CLASS",
        "employer_name": "EMPLOYER_NAME",
        "employer_city": "EMPLOYER_CITY",
        "employer_state": st("EMPLOYER_STATE"),
        "employer_postal_code": "EMPLOYER_POSTAL_CODE",
        "naics_code": ["NAICS_CODE", "NAIC_CODE"],
        "job_title": "JOB_TITLE",
        "soc_code": "SOC_CODE",
        "soc_title": "SOC_NAME",
        "worksite_city": "WORKSITE_CITY",
        "worksite_county": "WORKSITE_COUNTY",
        "worksite_state": st("WORKSITE_STATE"),
        "worksite_postal_code": "WORKSITE_POSTAL_CODE",
        "wage_from": [n("WAGE_RATE_OF_PAY_FROM"), n("WAGE_RATE_OF_PAY")],
        "wage_to": n("WAGE_RATE_OF_PAY_TO"),
        "wage_unit": "WAGE_UNIT_OF_PAY",
        "wage_annual": [annual(n("WAGE_RATE_OF_PAY_FROM"), "WAGE_UNIT_OF_PAY"),
                        annual(n("WAGE_RATE_OF_PAY"), "WAGE_UNIT_OF_PAY")],
        "pw_wage": n("PREVAILING_WAGE"),
        "pw_unit": "PW_UNIT_OF_PAY",
        "pw_annual": annual(n("PREVAILING_WAGE"), "PW_UNIT_OF_PAY"),
        "pw_wage_level": "PW_WAGE_LEVEL",
        "full_time_position": "FULL_TIME_POSITION",
        "begin_date": d("EMPLOYMENT_START_DATE"),
        "end_date": d("EMPLOYMENT_END_DATE"),
        "total_workers": ["try_cast(TOTAL_WORKERS AS INT)",
                          'try_cast("TOTAL WORKERS" AS INT)'],
    },
    # --- LCA, iCERT era FY2009-FY2014 ---
    ("lca", "icert"): {
        "case_number": "LCA_CASE_NUMBER",
        "case_status": "STATUS",
        "received_date": d("LCA_CASE_SUBMIT"),
        "decision_date": d("DECISION_DATE"),
        "visa_class": ["VISA_CLASS", "'H-1B'"],
        "employer_name": "LCA_CASE_EMPLOYER_NAME",
        "employer_city": "LCA_CASE_EMPLOYER_CITY",
        "employer_state": st("LCA_CASE_EMPLOYER_STATE"),
        "employer_postal_code": "LCA_CASE_EMPLOYER_POSTAL_CODE",
        "naics_code": "LCA_CASE_NAICS_CODE",
        "job_title": "LCA_CASE_JOB_TITLE",
        "soc_code": "LCA_CASE_SOC_CODE",
        "soc_title": "LCA_CASE_SOC_NAME",
        "worksite_city": ["LCA_CASE_WORKLOC1_CITY", "WORK_LOCATION_CITY1"],
        "worksite_state": [st("LCA_CASE_WORKLOC1_STATE"), st("WORK_LOCATION_STATE1")],
        "wage_from": n("LCA_CASE_WAGE_RATE_FROM"),
        "wage_to": n("LCA_CASE_WAGE_RATE_TO"),
        "wage_unit": "LCA_CASE_WAGE_RATE_UNIT",
        "wage_annual": [annual(n("LCA_CASE_WAGE_RATE_FROM"), "LCA_CASE_WAGE_RATE_UNIT"),
                        annual(n("LCA_CASE_WAGE_RATE_FROM"), NULL_UNIT)],
        "pw_wage": n("PW_1"),
        "pw_unit": "PW_UNIT_1",
        "pw_annual": annual(n("PW_1"), "PW_UNIT_1"),
        "full_time_position": "FULL_TIME_POS",
        "begin_date": d("LCA_CASE_EMPLOYMENT_START_DATE"),
        "end_date": d("LCA_CASE_EMPLOYMENT_END_DATE"),
        "total_workers": "try_cast(TOTAL_WORKERS AS INT)",
    },
    # --- LCA, EFILE era FY2008-FY2009 (H-1B Case Data) ---
    ("lca", "efile"): {
        "case_number": "CASE_NO",
        "case_status": "APPROVAL_STATUS",
        "received_date": d("SUBMITTED_DATE"),
        "decision_date": d("DOL_DECISION_DATE"),
        "visa_class": "'H-1B'",
        "employer_name": ["EMPLOYER_NAME", "NAME"],
        "employer_city": ["EMPLOYER_CITY", "CITY"],
        "employer_state": [st("EMPLOYER_STATE"), st("STATE")],
        "employer_postal_code": ["EMPLOYER_POSTAL_CODE", "POSTAL_CODE"],
        "job_title": "JOB_TITLE",
        "soc_code": ["OCCUPATIONAL_CODE", "JOB_CODE"],
        "soc_title": "OCCUPATIONAL_TITLE",
        "worksite_city": "CITY_1",
        "worksite_state": st("STATE_1"),
        "wage_from": n("WAGE_RATE_1"),
        "wage_to": n("MAX_RATE_1"),
        "wage_unit": "RATE_PER_1",
        "wage_annual": annual(n("WAGE_RATE_1"), "RATE_PER_1"),
        "pw_wage": n("PREVAILING_WAGE_1"),
        "pw_annual": annual(n("PREVAILING_WAGE_1"), "RATE_PER_1"),
        "begin_date": d("BEGIN_DATE"),
        "end_date": d("END_DATE"),
        "total_workers": "try_cast(NBR_IMMIGRANTS AS INT)",
    },
    # --- PERM, ETA-9089 era FY2015-FY2019 ---
    ("perm", "perm9089"): {
        "case_number": "CASE_NUMBER",
        "case_status": "CASE_STATUS",
        "received_date": d("CASE_RECEIVED_DATE"),
        "decision_date": d("DECISION_DATE"),
        "visa_class": "'PERM'",
        "employer_name": "EMPLOYER_NAME",
        "employer_city": "EMPLOYER_CITY",
        "employer_state": st("EMPLOYER_STATE"),
        "employer_postal_code": "EMPLOYER_POSTAL_CODE",
        "naics_code": "NAICS_US_CODE",
        "job_title": "JOB_INFO_JOB_TITLE",
        "soc_code": "PW_SOC_CODE",
        "soc_title": "PW_SOC_TITLE",
        "worksite_city": "JOB_INFO_WORK_CITY",
        "worksite_state": st("JOB_INFO_WORK_STATE"),
        "worksite_postal_code": "JOB_INFO_WORK_POSTAL_CODE",
        "wage_from": [n("WAGE_OFFER_FROM_9089"), n("WAGE_OFFERED_FROM_9089")],
        "wage_to": [n("WAGE_OFFER_TO_9089"), n("WAGE_OFFERED_TO_9089")],
        "wage_unit": ["WAGE_OFFER_UNIT_OF_PAY_9089", "WAGE_OFFERED_UNIT_OF_PAY_9089"],
        "wage_annual": [annual(n("WAGE_OFFER_FROM_9089"), "WAGE_OFFER_UNIT_OF_PAY_9089"),
                        annual(n("WAGE_OFFERED_FROM_9089"), "WAGE_OFFER_UNIT_OF_PAY_9089"),
                        annual(n("WAGE_OFFERED_FROM_9089"), "WAGE_OFFERED_UNIT_OF_PAY_9089")],
        "pw_wage": n("PW_AMOUNT_9089"),
        "pw_unit": "PW_UNIT_OF_PAY_9089",
        "pw_annual": annual(n("PW_AMOUNT_9089"), "PW_UNIT_OF_PAY_9089"),
        "pw_wage_level": "PW_LEVEL_9089",
    },
    # --- PERM, FY2008-FY2014 (short layout; FY2009 headers contain spaces) ---
    ("perm", "perm_old"): {
        "case_number": ["CASE_NUMBER", "CASE_NO"],
        "case_status": ["CASE_STATUS", '"CASE STATUS"'],
        "decision_date": [d("DECISION_DATE"), d('"DECISION DATE"')],
        "visa_class": "'PERM'",
        "employer_name": ["EMPLOYER_NAME", '"EMPLOYER NAME"'],
        "employer_city": ["EMPLOYER_CITY", '"EMPLOYER CITY"'],
        "employer_state": [st("EMPLOYER_STATE"), st('"EMPLOYER STATE"')],
        "employer_postal_code": ["EMPLOYER_POSTAL_CODE", '"EMPLOYER POSTAL CODE"'],
        "naics_code": ['"2007_NAICS_US_CODE"', '"2007 NAICS US CODE"',
                       '"2007_NAICS_US_Code"'],
        "job_title": ["PW_JOB_TITLE_9089", '"PW JOB TITLE 9089"'],
        "soc_code": ["PW_SOC_CODE", '"PW SOC CODE"'],
        "soc_title": ["PW_SOC_TITLE", '"PW SOC Title"'],
        "worksite_city": ["JOB_INFO_WORK_CITY", '"JOB INFO WORK CITY"'],
        "worksite_state": [st("JOB_INFO_WORK_STATE"), st('"JOB INFO WORK STATE"')],
        "wage_from": [n("WAGE_OFFER_FROM_9089"), n("WAGE_OFFERED_FROM_9089"),
                      n('"WAGE OFFER FROM 9089"')],
        "wage_to": [n("WAGE_OFFER_TO_9089"), n("WAGE_OFFERED_TO_9089"),
                    n('"WAGE OFFER TO 9089"')],
        "wage_unit": ["WAGE_OFFER_UNIT_OF_PAY_9089", "WAGE_OFFERED_UNIT_OF_PAY_9089",
                      '"WAGE OFFER UNIT OF PAY 9089"'],
        "wage_annual": [annual(n("WAGE_OFFER_FROM_9089"), "WAGE_OFFER_UNIT_OF_PAY_9089"),
                        annual(n("WAGE_OFFERED_FROM_9089"), "WAGE_OFFERED_UNIT_OF_PAY_9089"),
                        annual(n('"WAGE OFFER FROM 9089"'), '"WAGE OFFER UNIT OF PAY 9089"'),
                        annual(n("WAGE_OFFERED_FROM_9089"), NULL_UNIT)],
        "pw_wage": [n("PW_AMOUNT_9089"), n('"PW AMOUNT 9089"')],
        "pw_unit": ["PW_UNIT_OF_PAY_9089", '"PW UNIT OF PAY 9089"'],
        "pw_annual": [annual(n("PW_AMOUNT_9089"), "PW_UNIT_OF_PAY_9089"),
                      annual(n('"PW AMOUNT 9089"'), '"PW UNIT OF PAY 9089"')],
        "pw_wage_level": ["PW_LEVEL_9089", '"PW LEVEL 9089"'],
    },
    # --- PWD, FY2016-FY2019 ---
    ("pwd", "pw16"): {
        "case_number": "CASE_NUMBER",
        "case_status": "CASE_STATUS",
        "received_date": d("SUBMIT_DATE"),
        "decision_date": d("DETERMINATION_DATE"),
        "visa_class": "VISA_CLASS",
        "employer_name": "BUSINESS_NAME",
        "employer_city": ["EMPLOYER_CITY", '"EMPLOYER _CITY"'],
        "employer_state": [st("EMPLOYER_STATE"), st('"EMPLOYER _STATE"')],
        "employer_postal_code": ["EMPLOYER_POSTAL_CODE", '"EMPLOYER_ POSTAL _CODE"'],
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
        "pw_wage_level": "PWD_WAGE_LEVEL",
    },
    # --- PWD, FY2015 (one-off layout) ---
    ("pwd", "pw15"): {
        "case_number": "CASE_NUMBER",
        "case_status": "STATUS",
        "received_date": d("SUBMIT_DATE"),
        "decision_date": d("DETERMINATION_ISSUED"),
        "visa_class": "VISA_CLASS",
        "employer_name": "BUSINESS_NAME",
        "employer_city": '"EMPLOYER CITY"',
        "employer_state": st('"EMPLOYER STATE"'),
        "employer_postal_code": '"EMPLOYER POSTAL CODE"',
        "naics_code": "NAIC_ID",
        "job_title": "JOB_TITLE",
        "soc_code": "SOC_CODE",
        "soc_title": "SOC_CODE_NAME",
        "worksite_address": [addr("WORKSITE_ADDRESS_1", "WORKSITE_ADDRESS_2"),
                             addr("WORKSITE_ADDRESS_1")],
        "worksite_city": "WORKSITE_CITY",
        "worksite_county": "WORKSITE_COUNTY",
        "worksite_state": st("WORKSITE_STATE"),
        "worksite_postal_code": "WORKSITE_ZIP",
        "wage_from": n("PREVAIL_WAGE"),
        "wage_unit": "PAY_RANGE_DESC",
        "wage_annual": [annual(n("PREVAIL_WAGE"), "PAY_RANGE_DESC"),
                        annual(n("PREVAIL_WAGE"), NULL_UNIT)],
        "pw_wage": n("PREVAIL_WAGE"),
        "pw_unit": "PAY_RANGE_DESC",
        "pw_annual": [annual(n("PREVAIL_WAGE"), "PAY_RANGE_DESC"),
                      annual(n("PREVAIL_WAGE"), NULL_UNIT)],
        "pw_wage_level": "WAGE_LEVEL",
    },
    # --- PWD, FY2010-FY2014 ---
    ("pwd", "pw10"): {
        "case_number": "CASE_NUMBER",
        "case_status": ["CASE_STATUS", "STATUS"],
        "decision_date": [d("PW_DETERMINATION_DATE"), d("PW_DETERM_DATE")],
        "visa_class": ["VISA_CLASS", NULL_UNIT],
        "employer_name": ["EMPLOYER_LEGAL_BUSINESS_NAME", "EMPLYER_LEGAL_BUSINESS_NAME"],
        "employer_city": ["EMPLOYER_CITY", '"EMPLOYER CITY"'],
        "employer_state": [st("EMPLOYER_STATE"), st('"EMPLOYER STATE"')],
        "employer_postal_code": ["EMPLOYER_POSTAL_CODE", '"EMPLOYER POSTAL CODE"'],
        "naics_code": ["NAICS_US_CODE", "NAIC_US_CODE", "NAICS_CODE"],
        "job_title": "PW_JOB_TITLE",
        "soc_code": "PWD_SOC_CODE",
        "soc_title": ["PWD_SOC_TITLE", "PWD_SOC_CODE_TITLE", "PW_SOC_TITLE"],
        "worksite_city": "PRIMARY_WORKSITE_CITY",
        "worksite_county": "PRIMARY_WORKSITE_COUNTY",
        "worksite_state": st("PRIMARY_WORKSITE_STATE"),
        "worksite_postal_code": "PRIMARY_WORKSITE_POSTAL_CODE",
        "wage_from": n("PWD_WAGE_RATE"),
        "wage_unit": ["PWD_UNIT_OF_PAY", "PW_UNIT_OF_PAY"],
        "wage_annual": [annual(n("PWD_WAGE_RATE"), "PWD_UNIT_OF_PAY"),
                        annual(n("PWD_WAGE_RATE"), "PW_UNIT_OF_PAY")],
        "pw_wage": n("PWD_WAGE_RATE"),
        "pw_unit": ["PWD_UNIT_OF_PAY", "PW_UNIT_OF_PAY"],
        "pw_annual": [annual(n("PWD_WAGE_RATE"), "PWD_UNIT_OF_PAY"),
                      annual(n("PWD_WAGE_RATE"), "PW_UNIT_OF_PAY")],
        "pw_wage_level": "PWD_WAGE_LEVEL",
    },
}

CORE_COLUMNS = [
    "case_number", "case_status", "received_date", "decision_date",
    "visa_class", "employer_name", "employer_city", "employer_state",
    "employer_postal_code", "naics_code", "job_title", "soc_code",
    "soc_title", "worksite_address", "worksite_city", "worksite_county",
    "worksite_state", "worksite_postal_code", "wage_from", "wage_to", "wage_unit",
    "wage_annual", "pw_wage", "pw_unit", "pw_annual", "pw_wage_level",
    "full_time_position", "begin_date", "end_date", "total_workers",
]
DATE_COLS = {"received_date", "decision_date", "begin_date", "end_date"}
NUM_COLS = {"wage_from", "wage_to", "wage_annual", "pw_wage", "pw_annual"}
INT_COLS = {"total_workers"}


def era_of(program: str, have: set[str]) -> str | None:
    """Schema era for a file, from its actual (uppercased) header columns."""
    if program == "lca":
        if "LCA_CASE_NUMBER" in have:
            return "icert"
        if "APPROVAL_STATUS" in have:
            return "efile"
        if "WORKSITE_CITY_1" in have:
            return "h1b19"
        if "CASE_SUBMITTED" in have:
            return "h1b15"
        if "RECEIVED_DATE" in have:
            return "flag"
    if program == "perm":
        if "EMP_BUSINESS_NAME" in have:
            return "flag"
        if "EMPLOYER_STATE_PROVINCE" in have:
            return "legacy"
        if "CASE_RECEIVED_DATE" in have:
            return "perm9089"
        return "perm_old"
    if program == "pwd":
        if "REQUESTOR_POC_LAST_NAME" in have or "TYPE_OF_REPRESENTATION" in have:
            return "flag"
        if "DETERMINATION_ISSUED" in have:
            return "pw15"
        if "BUSINESS_NAME" in have:
            return "pw16"
        if "PW_JOB_TITLE" in have:
            return "pw10"
    return None


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
    "WITH", "NULL", "COALESCE", "CAST",
}


def referenced_cols(expr: str) -> set[str]:
    """Raw sheet columns an expression references, uppercased.

    Unquoted identifiers are written UPPERCASE by convention here; double-
    quoted identifiers (headers with spaces/digits/mixed case) as-is.
    """
    quoted = set(re.findall(r'"([^"]+)"', expr))
    bare = re.sub(r"'[^']*'", "", expr)
    bare = re.sub(r'"[^"]*"', "", bare)
    tokens = set(re.findall(r"\b[A-Z][A-Z0-9_]+\b", bare)) - SQL_WORDS
    return {t.upper() for t in tokens | quoted}


def pick(candidates, have: set[str]) -> str | None:
    """First candidate expression whose referenced columns all exist."""
    if isinstance(candidates, str):
        candidates = [candidates]
    for expr in candidates:
        if referenced_cols(expr) <= have:
            return expr
    return None


def stage_file(con: duckdb.DuckDBPyConnection, path: Path, program: str,
               era: str, have: set[str]) -> None:
    out = STAGE / program / (path.stem + ".parquet")
    out.parent.mkdir(parents=True, exist_ok=True)
    mapping = MAPPINGS[(program, era)]

    def target_expr(c: str) -> str:
        expr = pick(mapping[c], have) if c in mapping else None
        if expr is None:
            return f"CAST(NULL AS {col_type(c)}) AS {c}"
        if c == "case_status":
            expr = norm_status(expr)
        return f"try_cast(({expr}) AS {col_type(c)}) AS {c}"

    select = ",\n  ".join(target_expr(c) for c in CORE_COLUMNS)
    print(f"staging        {path.name} [{era}] ...", flush=True)
    con.execute(f"""
        COPY (
          SELECT * FROM (
            SELECT '{program}' AS program, {select}, '{path.name}' AS source_file
            FROM read_xlsx('{path.as_posix()}', all_varchar=true)
          ) WHERE case_number IS NOT NULL
        ) TO '{out.as_posix()}' (FORMAT parquet, COMPRESSION zstd)
    """)
    rows = con.execute(f"SELECT count(*) FROM '{out.as_posix()}'").fetchone()[0]
    print(f"staged         {out.relative_to(ROOT)} ({rows:,} rows)")


def stage_all(con: duckdb.DuckDBPyConnection) -> None:
    for path in sorted(RAW.glob("*.xlsx")):
        ident = identify(path.name)
        if not ident:
            print(f"unrecognized   {path.name} (skipped)")
            continue
        program, _, _ = ident
        out = STAGE / program / (path.stem + ".parquet")
        if out.exists() and out.stat().st_mtime >= path.stat().st_mtime:
            print(f"staged (skip)  {path.name}")
            continue
        have = {r[0].upper() for r in con.execute(
            f"DESCRIBE SELECT * FROM read_xlsx('{path.as_posix()}', all_varchar=true)").fetchall()}
        era = era_of(program, have)
        if era is None:
            print(f"unsupported    {path.name} (skipped; add era mapping)")
            continue
        stage_file(con, path, program, era, have)


def publish(con: duckdb.DuckDBPyConnection) -> None:
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    manifest = {"programs": {}}
    for program in ("lca", "perm", "pwd"):
        staged = sorted((STAGE / program).glob("*.parquet"))
        if not staged:
            continue
        files = ", ".join(f"'{p.as_posix()}'" for p in staged)
        # newest source file wins for duplicated case numbers
        # materialized: the group expressions + dedupe window are pricey, and
        # the per-FY COPY loop below would otherwise recompute them each pass
        con.execute(f"""
            CREATE OR REPLACE TEMP TABLE pub AS
            SELECT *,
                   {groups.employer_group("employer_name")} AS employer_group,
                   {groups.soc_group("soc_code")} AS soc_group,
                   {groups.title_group("job_title")} AS title_group,
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
            # sorted by group so entity-filtered queries prune to few row groups
            con.execute(f"""
                COPY (SELECT * EXCLUDE (rn) FROM pub WHERE fiscal_year = {fy}
                      ORDER BY employer_group, soc_group)
                TO '{out.as_posix()}' (FORMAT parquet, COMPRESSION zstd)
            """)
            rows = con.execute(f"SELECT count(*) FROM '{out.as_posix()}'").fetchone()[0]
            prog_files.append({"fy": fy, "file": out.name, "rows": rows,
                               "bytes": out.stat().st_size})
            print(f"published      {out.name}: {rows:,} rows, {out.stat().st_size/1e6:.1f} MB")
        manifest["programs"][program] = prog_files
        con.execute("DROP TABLE pub")
    manifest["aggregates"] = publish_aggregates(con)
    (WEB_DATA / "datasets.json").write_text(json.dumps(manifest, indent=2))
    print(f"wrote          {(WEB_DATA / 'datasets.json').relative_to(ROOT)}")


# The precomputed aggregate ("cube") files that power the drill-down UI.
# Summaries carry program/fiscal-year grain plus GROUPING SETS rollups (so
# all-years/all-programs medians are exact); pairwise cubes are all-years
# rollups only, sorted by their leading key so DuckDB-WASM's HTTP range
# reads prune to one or two row groups per entity lookup.
def publish_aggregates(con: duckdb.DuckDBPyConnection) -> dict:
    agg_dir = WEB_DATA / "agg"
    agg_dir.mkdir(parents=True, exist_ok=True)
    row_files = sorted(WEB_DATA.glob("*_fy*.parquet"))
    files = ", ".join(f"'{p.as_posix()}'" for p in row_files)
    curated = ", ".join("'" + g.replace("'", "''") + "'"
                        for g in groups.curated_labels())
    con.execute(f"""
        CREATE OR REPLACE TEMP VIEW allpub AS
        SELECT regexp_extract(parse_filename(filename), '^([a-z]+)_fy', 1) AS program,
               fiscal_year, employer_group, soc_group, title_group,
               worksite_state, worksite_city,
               upper(trim(worksite_city)) AS city_key, wage_annual,
               (case_status ILIKE 'Certified%' OR
                case_status ILIKE 'Determination Issued%') AS is_cert,
               employer_name, soc_code, soc_title, job_title
        FROM read_parquet([{files}], union_by_name=true, filename=true)
    """)
    # display labels: curated family names as-is, else the modal raw spelling.
    # Several source years are ALL CAPS, so prefer a mixed-case spelling when
    # one exists (FILTER mixed(...)) before falling back to the overall mode.
    mixed = lambda c: f"(trim({c}) <> upper(trim({c})))"
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE lab_emp AS
        SELECT employer_group AS k,
               CASE WHEN employer_group IN ({curated}) THEN employer_group
                    ELSE COALESCE(mode(employer_name) FILTER ({mixed('employer_name')}),
                                  mode(employer_name)) END AS label
        FROM allpub WHERE employer_group IS NOT NULL GROUP BY employer_group
    """)
    # prefer the group's own target-code title (modern SOC vintage) over the
    # corpus-wide mode, which legacy vintages can outnumber
    con.execute("""
        CREATE OR REPLACE TEMP TABLE lab_soc AS
        SELECT soc_group AS k,
               COALESCE(mode(soc_title) FILTER (soc_code LIKE soc_group || '%'),
                        mode(soc_title), soc_group) AS label
        FROM allpub WHERE soc_group IS NOT NULL GROUP BY soc_group
    """)
    # prefer the spelling of titles that ARE the base title (not variants)
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE lab_title AS
        SELECT title_group AS k,
               COALESCE(mode(job_title) FILTER (upper(trim(job_title)) = title_group
                                                AND {mixed('job_title')}),
                        mode(job_title) FILTER (upper(trim(job_title)) = title_group),
                        mode(job_title), title_group) AS label
        FROM allpub WHERE title_group IS NOT NULL GROUP BY title_group
    """)

    measures = """count(*)::BIGINT AS n,
               count(*) FILTER (is_cert)::BIGINT AS n_cert,
               round(median(wage_annual))::BIGINT AS median_wage"""
    specs = {}
    # per-dimension summaries: (key [, program] [, fy]) grains via grouping sets
    for name, key, lab in (("employers", "employer_group", "lab_emp"),
                           ("soc", "soc_group", "lab_soc"),
                           ("titles", "title_group", "lab_title")):
        specs[name] = f"""
            SELECT l.label, a.* FROM (
              SELECT {key} AS k, program, fiscal_year AS fy, {measures}
              FROM allpub WHERE {key} IS NOT NULL
              GROUP BY GROUPING SETS (({key}), ({key}, program), ({key}, fy),
                                      ({key}, program, fy))
            ) a JOIN {lab} l ON l.k = a.k
            ORDER BY a.k, a.program NULLS FIRST, a.fy NULLS FIRST"""
        specs[f"{name}_top"] = f"""
            SELECT * FROM read_parquet('{(agg_dir / (name + '.parquet')).as_posix()}')
            WHERE program IS NULL AND fy IS NULL ORDER BY n DESC"""
    # pairwise drill cubes: all-years all-programs rollups, sorted by lead key
    pair = lambda k1, k2, l1, l2: f"""
        SELECT la.label AS label, lb.label AS label2, a.* FROM (
          SELECT {k1} AS k, {k2} AS k2, {measures}
          FROM allpub WHERE {k1} IS NOT NULL AND {k2} IS NOT NULL
          GROUP BY 1, 2
        ) a JOIN {l1} la ON la.k = a.k JOIN {l2} lb ON lb.k = a.k2
        ORDER BY a.k, a.n DESC"""
    specs["emp_soc"] = pair("employer_group", "soc_group", "lab_emp", "lab_soc")
    specs["emp_title"] = pair("employer_group", "title_group", "lab_emp", "lab_title")
    specs["soc_emp"] = pair("soc_group", "employer_group", "lab_soc", "lab_emp")
    specs["title_emp"] = pair("title_group", "employer_group", "lab_title", "lab_emp")
    loc = lambda k, l: f"""
        SELECT la.label AS label, a.* FROM (
          SELECT {k} AS k, worksite_state AS state, city_key,
                 COALESCE(mode(worksite_city) FILTER ({mixed('worksite_city')}),
                          mode(worksite_city)) AS city, {measures}
          FROM allpub WHERE {k} IS NOT NULL AND worksite_state IS NOT NULL
          GROUP BY GROUPING SETS (({k}, worksite_state),
                                  ({k}, worksite_state, city_key))
        ) a JOIN {l} la ON la.k = a.k
        ORDER BY a.k, a.state, a.city_key NULLS FIRST"""
    specs["emp_loc"] = loc("employer_group", "lab_emp")
    specs["soc_loc"] = loc("soc_group", "lab_soc")

    entries = {}
    for name, sql in specs.items():
        out = agg_dir / f"{name}.parquet"
        con.execute(f"COPY ({sql}) TO '{out.as_posix()}' "
                    f"(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 65536)")
        rows = con.execute(f"SELECT count(*) FROM '{out.as_posix()}'").fetchone()[0]
        entries[name] = {"file": f"agg/{out.name}", "rows": rows,
                         "bytes": out.stat().st_size}
        print(f"aggregate      agg/{out.name}: {rows:,} rows, "
              f"{out.stat().st_size/1e6:.1f} MB")
    return entries


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage-only", action="store_true")
    ap.add_argument("--republish", action="store_true",
                    help="skip staging, just rebuild web parquet from stage/")
    ap.add_argument("--agg-only", action="store_true",
                    help="rebuild only the aggregate files from published parquet")
    args = ap.parse_args()
    con = duckdb.connect()
    con.execute("INSTALL excel; LOAD excel;")
    # let the materialized publish table spill to disk instead of OOMing
    con.execute(f"SET temp_directory = '{(ROOT / 'data' / '.duckdb_tmp').as_posix()}'")
    if args.agg_only:
        manifest = json.loads((WEB_DATA / "datasets.json").read_text())
        manifest["aggregates"] = publish_aggregates(con)
        (WEB_DATA / "datasets.json").write_text(json.dumps(manifest, indent=2))
        return
    if not args.republish:
        stage_all(con)
    if not args.stage_only:
        publish(con)


if __name__ == "__main__":
    main()
