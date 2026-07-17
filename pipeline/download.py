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
import urllib.parse
from pathlib import Path

PERF_URL = "https://www.dol.gov/agencies/eta/foreign-labor/performance"
BASE = "https://www.dol.gov"
RAW_DIR = Path(__file__).resolve().parent.parent / "data" / "raw"
# dol.gov returns 403 to python-urllib; curl works fine.
CURL = ["curl", "-sL", "--fail", "--retry", "3"]

# Filename rules covering every era of LCA/PERM/PW disclosure files back to
# FY2008. Excludes Appendix A / Worksites companion files. FY may be 2-digit.
FILE_RULES = [
    ("lca",  r"LCA_Disl?closure_Data_FY(\d{2,4})(?:_Q(\d))?"),
    ("lca",  r"H-1B_Disclosure_Data_FY(\d{2,4})(?:_Q(\d))?(?:_EOY)?"),
    ("lca",  r"H-1B_iCert_LCA_FY(\d{2,4})(?:_Q(\d))?"),
    ("lca",  r"Icert_?\s?LCA_?\s?FY(\d{2,4})"),
    ("lca",  r"LCA_FY(\d{2,4})(?:_Q(\d))?"),
    ("lca",  r"H-1B_FY(\d{2,4})(?:_Q(\d))?"),
    ("lca",  r"H-1B_Case_Data_FY(\d{2,4})"),
    ("perm", r"PERM_Disclosure_Data(?:_New_Form)?_FY(\d{2,4})(?:_Q(\d))?(?:_EOY)?"),
    ("perm", r"PERM_FY(\d{2,4})(?:_Q(\d))?"),
    ("pwd",  r"PWD?_Disclosure_Data_FY(\d{2,4})(?:_Q(\d))?(?:_EOY)?(?:_(?:old|revised|new)_form)?"),
    ("pwd",  r"PW_Case_Data_FY(\d{2,4})"),
    ("pwd",  r"PW_FY(\d{2,4})"),
]
FILE_RULES = [(p, re.compile(rx + r"\.xlsx$", re.I)) for p, rx in FILE_RULES]


def identify(basename: str):
    """(program, fy, quarter) for a disclosure filename, else None."""
    for program, pat in FILE_RULES:
        m = pat.fullmatch(basename)
        if not m:
            continue
        fy = int(m.group(1))
        if fy < 100:
            fy += 2000
        q = m.group(2) if m.re.groups > 1 else None
        return program, fy, int(q) if q else None
    return None


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
        name = urllib.parse.unquote(url.rsplit("/", 1)[-1])
        ident = identify(name)
        if not ident:
            continue
        program, fy, quarter = ident
        if fy < min_fy or program not in programs:
            continue
        entries.append({
            "program": program,
            "fy": fy,
            "quarter": quarter,
            "url": url,
            # normalize the DOL typo ("Dislclosure") and stray spaces
            "file": name.replace("Dislclosure", "Disclosure").replace(" ", ""),
        })
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
        url = urllib.parse.quote(e["url"], safe=":/%")  # some old links contain spaces
        subprocess.run(CURL + ["-o", str(tmp), url], check=True)
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
