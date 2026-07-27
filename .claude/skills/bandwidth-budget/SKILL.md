---
name: bandwidth-budget
description: Per-session wire-bytes budget for the OFLC site (what each stage of a visit actually downloads) and why DuckDB-WASM range reads cannot be measured from the browser tools. Load when discussing page weight, download size, bandwidth, the 100 GB/month Pages soft limit, or when asked to measure what a query fetches.
---

# Per-session bandwidth (measured 2026-07-20)

| Stage | Wire bytes |
|---|---|
| Landing page only (no DuckDB boot) | 0.3 MiB |
| + DuckDB boot on first search/drill | +7.7 MiB |
| + search index | +10.8 MiB |
| Each employer drill (3 charts) | ~1.6 MiB |
| Records table, all years | ~50 MiB |

- The WASM is 33.4 MiB on disk but **7.5 MiB on the wire** (Pages compresses
  it) and is browser-cached across sessions — don't quote the build-output size
  as a bandwidth figure.
- The records table dominates everything; the charts are noise beside it.
  Pruning works (20/86 row groups for an all-years employer) but it's still
  ~50 MiB. `employers_top` (10.0 MiB) is the fixed per-session cost and the
  next target if the 100 GB/month soft limit ever matters.
- **Measuring this is not possible from the browser tools**: DuckDB-WASM issues
  its range reads inside a Web Worker, so they appear in neither
  `performance.getEntriesByType('resource')` (main thread only) nor the CDP
  network recorder — both come back empty. The parquet figures above are
  computed from `parquet_metadata` column-chunk sizes over the row groups a
  query's stats actually match; treat them as per-query upper bounds, since
  DuckDB's object/metadata caches and cache.js suppress repeats.
