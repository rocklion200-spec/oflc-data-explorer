# Pipeline notes

See the repo-root `CLAUDE.md` for the two-repo topology, Pages size limits and
the commands to run these scripts. This file carries what only matters once you
are editing the pipeline itself.

## Data quirks

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

## Compression (zstd level 22)

Every *published* parquet is written at `COMPRESSION_LEVEL 22`, not DuckDB's
default 3: measured 7–20% smaller across the tree (128 MiB total) for **zero**
read cost, because zstd decompression speed is independent of compression
level — a level-22 point query benchmarked marginally *faster* than level 3
(less I/O). It costs write time only: ~0.3s → ~7.5s for a 60 MB cube.
Staging parquet deliberately stays at the default — it is never published and
is re-read repeatedly during a run.

`pipeline/recompress.py` applies this to an already-published tree without a
re-stage, verifying each file by joining on parquet's physical row index
(`file_row_number`) and comparing whole-row hashes. Two traps it encodes:
- A plain `SELECT * FROM file` → `COPY` **does** preserve physical row order,
  so row-group pruning survives. Don't "verify" this with `string_agg` or
  `lag() OVER ()` — neither guarantees input order, and both will falsely
  report scrambling.
- Table aliases in the verification query must not collide with a column name.
  The cubes have a column `n`, so aliasing the table `n` makes `hash(n)` hash
  that column instead of the row, reporting every row as differing.
