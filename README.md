# OFLC Data Explorer

Browse, filter, and chart the U.S. Department of Labor's
[OFLC disclosure data](https://www.dol.gov/agencies/eta/foreign-labor/performance)
— LCA programs (H-1B, H-1B1, E-3), PERM, and Prevailing Wage Determinations —
entirely in the browser. No server: the site is static (GitHub Pages friendly)
and queries per-fiscal-year Parquet files with
[DuckDB-WASM](https://github.com/duckdb/duckdb-wasm), fetching only the byte
ranges each query needs. Works on desktop and mobile.

**Currently included: FY2008–FY2026** — every LCA, PERM, and PW disclosure
file on the DOL performance page, spanning the EFILE (FY2008–09), iCERT
(FY2009–2019), and FLAG (FY2020+) eras. PW data begins FY2010 (none published
before that).

## Layout

```
pipeline/download.py   scrape the DOL performance page, download .xlsx (newest first)
pipeline/convert.py    xlsx -> normalized parquet (stage), then dedupe + publish per FY
data/raw/              downloaded .xlsx           (gitignored, ~6 GB)
data/stage/            per-source-file parquet    (gitignored)
web/                   Vite + React app
web/public/data/       published parquet + datasets.json (its own repo: oflc-data)
```

## Refreshing / extending the data

```bash
python3 -m venv .venv && .venv/bin/pip install duckdb   # once
.venv/bin/python pipeline/download.py --min-fy 2026     # fetch new/missing files
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

## Data hosting

The published data (`web/public/data/`, ~840 MB of parquet) is **not** part
of this repo: it lives in its own repo (`oflc-data`) served by its own GitHub
Pages site, and the production build reads it from there
(`VITE_DATA_BASE` in `web/.env.production`). Pages invalidates its CDN cache
on every deploy, so keeping the data in a repo that only changes when the
data actually changes means app deploys never re-cold-start ~840 MB of
range-read caching. Both sites share the `<user>.github.io` origin, so no
CORS is involved.

- Local dev (`npm run dev`) reads `web/public/data/` directly — make that
  directory a clone of `oflc-data` (or run the pipeline to regenerate it).
- Publishing new data: run the pipeline (below), then commit + push inside
  `web/public/data/`. The app repo needs no deploy for data-only updates.

## Data notes

- The three programs are normalized into one core schema (case, employer,
  job/SOC, worksite, wage) so one UI serves all of them; original wage units
  are preserved alongside a derived `wage_annual`.
- Wages are annualized from the reported unit of pay. Records where the filer
  clearly picked the wrong unit (e.g. an annual salary marked "Hour", which
  would annualize to $400M+) are corrected when unambiguous, otherwise the
  annualized value is left null so averages aren't poisoned. Raw values are
  kept in `wage_from` / `wage_unit`.
- Each file's schema era (11 distinct layouts across 2008–2026) is detected
  from its actual header, not its filename; per-field candidate lists absorb
  year-to-year drift, including legacy headers with embedded spaces and typos
  (`"TOTAL WORKERS"`, `EMPLYER_LEGAL_BUSINESS_NAME`).
- Full state names in older files are normalized to USPS codes; UPPERCASE
  legacy case statuses are normalized to the modern casing.
- FY2008–09 EFILE H-1B files have no visa-class column (H-1B assumed) and use
  3-digit occupation codes rather than SOC codes.

### Adding a new schema era

Add a mapping to `MAPPINGS` in `pipeline/convert.py` keyed by
(program, era), teach `era_of()` to recognize the era from a signature
column, and add a filename rule in `pipeline/download.py` if needed.
Everything downstream (dedupe, publish, web app) picks it up automatically.
