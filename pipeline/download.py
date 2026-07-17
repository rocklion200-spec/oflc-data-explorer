#!/usr/bin/env python3
"""Download OFLC disclosure .xlsx files from the DOL performance page.

Scrapes https://www.dol.gov/agencies/eta/foreign-labor/performance for
disclosure-file links, filters to the requested programs and fiscal years,
and downloads them into data/raw/ (skipping files already present).

Usage:
    python pipeline/download.py --list                 # show what would be downloaded
    python pipeline/download.py --min-fy 2025          # download FY2025+ files
    python pipeline/download.py --min-fy 2020 --program lca
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

PERF_URL = "https://www.dol.gov/agencies/eta/foreign-labor/performance"
BASE = "https://www.dol.gov"
RAW_DIR = Path(__file__).resolve().parent.parent / "data" / "raw"
# dol.gov returns 403 to python-urllib; curl works fine.
CURL = ["curl", "-sL", "--fail", "--retry", "3"]

# Patterns for the modern-era disclosure files we support (FY2020+).
# Older eras (different schemas) can be added as (pattern, program, era) rows.
PATTERNS = [
    # program, era, regex on the URL basename
    ("lca",  "flag", re.compile(r"LCA_Disl?closure_Data_FY(\d{4})(?:_Q(\d))?\.xlsx$", re.I)),
    ("perm", "flag", re.compile(r"PERM_Disclosure_Data(?:_New_Form)?_FY(\d{4})(?:_Q(\d))?\.xlsx$", re.I)),
    ("pwd",  "flag", re.compile(r"PWD?_Disclosure_Data_FY(\d{4})(?:_Q(\d))?(?:_(?:old|revised|new)_form)?\.xlsx$", re.I)),
]


def scrape_links() -> list[str]:
    html = subprocess.run(CURL + [PERF_URL], capture_output=True, text=True,
                          check=True, timeout=120).stdout
    hrefs = re.findall(r'href="([^"]+\.xlsx)"', html, re.I)
    out = []
    for h in hrefs:
        if h.startswith("/"):
            h = BASE + h
        out.append(h)
    return sorted(set(out))


def build_manifest(min_fy: int, programs: set[str]) -> list[dict]:
    entries = []
    for url in scrape_links():
        name = url.rsplit("/", 1)[-1]
        for program, era, pat in PATTERNS:
            m = pat.search(name)
            if not m:
                continue
            fy = int(m.group(1))
            if fy < min_fy or fy < 2020 or program not in programs:
                continue
            entries.append({
                "program": program,
                "era": era,
                "fy": fy,
                "quarter": int(m.group(2)) if m.group(2) else None,
                "url": url,
                # normalize the DOL typo ("Dislclosure") in the local filename
                "file": name.replace("Dislclosure", "Disclosure"),
            })
            break
    # newest first
    entries.sort(key=lambda e: (e["fy"], e["quarter"] or 9), reverse=True)
    return entries


def download(entries: list[dict]) -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    for e in entries:
        dest = RAW_DIR / e["file"]
        if dest.exists() and dest.stat().st_size > 0:
            print(f"skip (exists)  {e['file']}")
            continue
        print(f"downloading    {e['file']} ...", flush=True)
        tmp = dest.with_suffix(".part")
        subprocess.run(CURL + ["-o", str(tmp), e["url"]], check=True)
        tmp.rename(dest)
        print(f"done           {e['file']} ({dest.stat().st_size/1e6:.0f} MB)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-fy", type=int, default=2025)
    ap.add_argument("--program", choices=["lca", "perm", "pwd"], action="append",
                    help="repeatable; default: all three")
    ap.add_argument("--list", action="store_true", help="print manifest as JSON and exit")
    args = ap.parse_args()

    programs = set(args.program) if args.program else {"lca", "perm", "pwd"}
    entries = build_manifest(args.min_fy, programs)
    if args.list:
        json.dump(entries, sys.stdout, indent=2)
        print()
        return
    download(entries)


if __name__ == "__main__":
    main()
