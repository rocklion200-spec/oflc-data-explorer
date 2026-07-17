# OFLC Data Explorer

Browse, filter, and chart the U.S. Department of Labor's
[OFLC disclosure data](https://www.dol.gov/agencies/eta/foreign-labor/performance)
— LCA programs (H-1B, H-1B1, E-3), PERM, and Prevailing Wage Determinations —
entirely in the browser. No server: the site is static (GitHub Pages friendly)
and queries per-fiscal-year Parquet files with
[DuckDB-WASM](https://github.com/duckdb/duckdb-wasm), fetching only the byte
ranges each query needs. Works on desktop and mobile.

**Currently included: FY2020–FY2026** (all files published by OFLC's FLAG-era
disclosure system). Earlier years use older layouts — see
"Adding older years" below.

## Layout

```
pipeline/download.py   scrape the DOL performance page, download .xlsx (newest first)
pipeline/convert.py    xlsx -> normalized parquet (stage), then dedupe + publish per FY
data/raw/              downloaded .xlsx           (gitignored, ~4 GB)
data/stage/            per-source-file parquet    (gitignored)
web/                   Vite + React app
web/public/data/       published parquet + datasets.json (committed, ~235 MB)
```

## Refreshing / extending the data

```bash
python3 -m venv .venv && .venv/bin/pip install duckdb   # once
.venv/bin/python pipeline/download.py --min-fy 2020     # fetch new/missing files
.venv/bin/python pipeline/convert.py                    # stage new files + republish
```

- Quarterly files within a fiscal year overlap (some are cumulative); the
  publish step dedupes by case number, keeping the newest decision.
- OFLC posts new quarterly files a few weeks after each fiscal quarter ends
  (Jan/Apr/Jul/Oct) — rerun the two commands above to pick them up.

## Web app

```bash
cd web
npm install
npm run dev      # local dev at http://localhost:5173
npm run build    # static site in web/dist
```

## Deploying to GitHub Pages

1. Create a GitHub repository and push this project (`main` branch).
2. In the repo settings, set **Pages → Source → GitHub Actions**.
3. The included workflow (`.github/workflows/deploy.yml`) builds the site and
   deploys it on every push to `main`.

## Data notes

- The three programs are normalized into one core schema (case, employer,
  job/SOC, worksite, wage) so one UI serves all of them; original wage units
  are preserved alongside a derived `wage_annual`.
- Wages are annualized from the reported unit of pay. Records where the filer
  clearly picked the wrong unit (e.g. an annual salary marked "Hour", which
  would annualize to $400M+) are corrected when unambiguous, otherwise the
  annualized value is left null so averages aren't poisoned. Raw values are
  kept in `wage_from` / `wage_unit`.
- Old-form vs new-form files (PERM's 2023 form change, PW's revised form) are
  mapped by inspecting each file's actual header, not its filename.
- Full state names in older files are normalized to USPS codes.

### Adding older years (pre-FY2020)

Pre-2020 files (iCERT and legacy eras) use different column layouts, described
in the record-layout `.pdf`/`.doc` files on the DOL performance page. To add
them: extend `PATTERNS` in `pipeline/download.py`, add a mapping in
`MAPPINGS` in `pipeline/convert.py` (keyed by program + era), and extend
`era_of()` to detect the era from the file header. Everything downstream
(dedupe, publish, web app) picks the new years up automatically.
