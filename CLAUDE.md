# OFLC Data Explorer

Static web app for browsing U.S. DOL foreign-labor-certification disclosure data
(LCA H-1B/H-1B1/E-3, PERM, Prevailing Wage; FY2008–FY2026, ~9M records) plus the
OFLC wage library (prevailing wage levels by occupation × county, wage years
2005–2026). Python pipeline converts DOL Excel files to parquet; the site is a
Vite + React app querying that parquet in-browser via bundled DuckDB-WASM over
HTTP range requests. No server.

## Two-repo topology (important)

- **App repo** (this one → `rocklion200-spec/oflc-data-explorer`): pipeline + web app.
  GitHub Pages via Actions workflow, auto-deploys on push to main (~25s).
  Live: https://rocklion200-spec.github.io/oflc-data-explorer/
- **Data repo** (`rocklion200-spec/oflc-data`): ~1 GB of published parquet.
  `web/public/data/` **is a clone of it** (gitignored in the app repo). Publish data
  by committing + pushing *inside that directory*. Pages legacy branch build
  (no Actions workflow shows up), same github.io origin → no CORS.
  Production reads `VITE_DATA_BASE` from `web/.env.production`; dev serves the local clone.
- **Every data-repo deploy purges the Fastly edge cache for all ~1 GB.** First
  reads after a deploy run ~0.5–1.5s per MB (vs ~30ms warm) — users will report
  the site "slow" for a while after any data publish. App deploys do NOT touch
  the data cache. Don't push the data repo for trivia; batch data changes.
- Data repo watch-outs: GitHub rejects files >100 MB (wages parquet is sharded
  for this). Pages build status can report "errored" yet still deploy after an
  internal retry — verify what's actually live (`curl -r` a parquet footer,
  check `last-modified`) before re-triggering builds.
- **Pages size limits — two different 1 GBs, don't conflate them:**
  - *Published site* — 1 GB **hard**; exceeding it fails the deploy. This is the
    binding constraint. The tree is **1,038,992,208 B = 0.968 GiB**, i.e. ~33 MiB
    of headroom. The limit is binary (2^30), not decimal: at 1.039 decimal GB the
    site deploys fine, so 1 GB here can only mean GiB. Only shrinking *published
    bytes* helps — a column/encoding trim, dropping cubes, sharding to a second
    host. Cube growth is the threat (the fy_lo/fy_hi rebuild alone cost +25 MB).
  - *Source repo* — 1 GB **recommended** (soft, no enforcement). History was
    squashed to one orphan commit on 2026-07-20 for this; note GitHub's reported
    repo size does not drop until its own background gc runs, which no API call
    or push triggers.
  - Squashing history does **nothing** for the published-site limit — git history
    isn't part of the published artifact. It only ever addressed the soft one.
  - Also soft: 100 GB/month bandwidth, 10 builds/hour, 10 min deploy timeout.
- If you do squash again, do it right after a data deploy: the force-push
  retriggers the Pages build and purges the ~1 GB CDN cache, which is free while
  the cache is still cold anyway.
- Pages caches `index.html` up to 10 min — verify deploys with a `?cachebuster`
  URL and check the loaded bundle hash, or you'll measure the old code.

## Commands

```sh
# web app (from repo root)
npx vite build          # in web/ — fast syntax/import check, do this before browser testing
npm --prefix web run dev  # dev server :5173 — but use the Browser pane launch config "oflc-web"

# pipeline (long-running; full re-stage takes hours and re-downloads from DOL)
python3 pipeline/download.py      # scrape DOL performance page (curl only; python-urllib gets 403)
python3 pipeline/convert.py       # stage xlsx -> parquet, publish to web/public/data/
python3 pipeline/convert.py --agg-only [names…]  # rebuild just aggregate/cube files (cheap)
python3 pipeline/wages.py         # wage library from flag.dol.gov + Wayback legacy archives
```

## Web app architecture (web/src/)

- `db.js` — DuckDB-WASM boot; `query(sql, stale, lane)` with a fast lane and a
  "bulk" lane for table-row/export scans, plus a 400ms grace so chart queries
  aren't starved; stale-query cancellation via `conn.send()` + watchdog.
  Sets `enable_object_cache` + `parquet_metadata_cache` (critical: parquet
  footers are re-read every query otherwise).
- `queries.js` — all SQL. Two layers: row-level scans over per-FY parquet, and
  precomputed **cubes** in `data/agg/` (`*_top` per-dim tops = search corpus,
  pairwise cubes `emp_soc`/`soc_loc`/…, `program_stats`, summary files with
  GROUPING SETS rollups). Cube paths only apply when no column filters are
  active. `datasets.json` carries a `landing` block (top-12s + program stats)
  so the home page renders before DuckDB even boots.
- `cache.js` — localStorage LRU keyed on the datasets.json fingerprint, wraps
  the chart/summary fetchers (`cachedQuery`).
- `App.jsx` — case-explorer view + view switching (`#…` sel hash, `#wages?…`,
  `#help`); selection = chips {employer, soc, title, loc}, added by search
  picks and chart clicks. Top-N charts are cube-backed on home/single-entity,
  row-level (one GROUPING SETS scan) in drill mode.
- `components/WagesPage.jsx` — wage-levels view. Unified search over
  occupations + counties; multi-select up to 8 in ONE dimension (adding to the
  other trims it back to one); single pair → 4-level chart, multi → one level
  (`lv` hash param) compared across selections with `--cat-1..8` colors.
  Top roles/locations charts: landing-based globally, `soc_loc` cube once an
  occupation is picked, row-level LCA scan once a county is picked.
  Hash: `s=` comma SOC codes, `p=ST|COUNTYKEY,…`; legacy `st/co/ck/ct` params
  still parse (cross-links use them; `ct` = pre-2025 New England town name).
- `components/charts.jsx` — hand-rolled SVG charts (dataviz-skill mark specs).
  `MultiLineChart` = compare chart; capped at 8 series because the categorical
  palette's 8 slots are the validated max (order is CVD-safety, don't shuffle).
- `xlsx.js` — hand-rolled OOXML writer over fflate. Export buttons say
  "⬇ Excel" in both views (keep them consistent).
- Search ranking: `searchGroups` orders dimension sections by total matching
  record count ("New York" → locations first); Enter picks the top item.

## Data quirks (pipeline)

- Dedupe by CASE_NUMBER, never trust file names (LCA quarterly, PERM/PW annual
  files are cumulative; FY2026_Q2 spans two quarters).
- Dates arrive as Excel serials under all_varchar: `DATE '1899-12-30' + serial`.
- Wage plausibility: employers file annual salaries with unit "Hour";
  `wage_annual` uses a 10k–3M band correction.
- Form eras are detected from actual file headers, not filenames (PERM old/new
  coexist in FY2024; 11 legacy schema layouts FY2008–2019; EFILE FY2008-09 has
  no visa class — H-1B assumed).
- Groups computed at publish (`pipeline/groups.py`): employer_group (curated
  families in `employer_families.json` + normalization), soc_group (SOC vintage
  crosswalk incl. 3-digit DOT), title_group, county_key (era-normalized county;
  each city assigned its modal county — the raw county field is junk-ridden).
  Row parquet sorted by (employer_group, soc_group) → row-group pruning, which
  is why "all years" is only fast when an employer is selected.
- Wage library: wage years labeled by START year (July–June); 2005 is the hard
  floor (2-level system before). Pre-2025 New England areas are towns, not
  counties. 2021-22 files use SOC-2010 codes (bridged); ACWIA publishes only
  R&D/non-R&D split codes for some roles. Legacy 2005–2020 zips exist only as
  pinned Wayback captures (flcdatacenter.com is gone).

## Conventions & gotchas

- Match existing code style: small hand-rolled components, no new deps without
  need, comments explain *why*/constraints only.
- Charts follow the dataviz skill (load it before chart work): CSS-var colors
  validated per light/dark mode, text in text tokens, tooltips + table views.
- Browser-pane testing: keyboard events can't be synthesized via `computer key`
  (use JS `dispatchEvent` or refs); coordinate clicks land wrong (use refs);
  screenshots are blank after scrolling (resize taller, screenshot at top);
  `navigate` to a same-origin hash URL doesn't reload.
- Bash tool cwd persists across calls — a stray `cd web/public/data` later makes
  git commands hit the DATA repo instead of the app repo. Use absolute paths or
  re-`cd` explicitly before git operations.
- `GROUP BY ALL` fails when a label expression mixes aggregate + group column —
  use `GROUP BY 1`.
- CSS: `table.results td` beats `.help-table td` — overrides need the `table.`
  prefix. `tr.col-filter-row input` width rules must stay scoped to
  `[type="search"]`.
- gh CLI works for API calls; `gh repo create` is blocked from Claude (user runs it).
- Verify UI changes in the Browser pane (launch config `oflc-web`) before
  calling them done; `npx vite build` first to catch import errors cheaply.

## Working style for this project

Prefer reading `queries.js`/`App.jsx` selectively (grep for the function) over
whole-file reads; the files above are the complete map. Check `MEMORY.md` /
auto-memory for session-to-session state. When the user reports live-site
slowness, check data-repo Pages deploy times and CDN cache headers before
touching code — it's almost always the post-deploy cold edge cache.
