// DuckDB-WASM setup: bundled locally (no CDN), parquet files registered as
// HTTP-range-readable URLs so only the row groups a query needs are fetched.
import * as duckdb from "@duckdb/duckdb-wasm";
import wasmMvp from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import workerMvp from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import wasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import workerEh from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";

// Data files live under DATA_BASE — by default the app's own data/ dir.
// Production points VITE_DATA_BASE at the separate oflc-data Pages repo so
// code deploys don't invalidate the CDN cache of ~840 MB of parquet.
const DATA_BASE = (() => {
  const b = new URL(import.meta.env.VITE_DATA_BASE || "data/", document.baseURI).href;
  return b.endsWith("/") ? b : `${b}/`;
})();

let connPromise = null;
let registered = new Set();
let dbRef = null;

async function init() {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: wasmMvp, mainWorker: workerMvp },
    eh: { mainModule: wasmEh, mainWorker: workerEh },
  });
  const worker = new Worker(bundle.mainWorker, { type: "module" });
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  dbRef = db;
  const conn = await db.connect();
  // Cache parquet footers between queries — every screen refetch otherwise
  // re-reads the metadata of all ~19 per-FY files over HTTP. Setting names
  // vary across DuckDB versions, so try both and ignore what's unsupported.
  for (const s of ["SET enable_object_cache=true",
                   "SET parquet_metadata_cache=true"]) {
    await conn.query(s).catch(() => {});
  }
  return conn;
}

function getConn() {
  if (!connPromise) connPromise = init();
  return connPromise;
}

export async function registerParquet(fileName) {
  if (registered.has(fileName)) return;
  await getConn(); // ensure db exists
  const url = new URL(fileName, DATA_BASE).href;
  await dbRef.registerFileURL(fileName, url, duckdb.DuckDBDataProtocol.HTTP, false);
  registered.add(fileName);
}

// Sentinel error for queries skipped or cancelled because their result is
// no longer wanted (a newer filter state superseded them).
export const STALE = Symbol("stale-query");
export const isStale = (e) => e === STALE;

function toRows(batchLike) {
  return batchLike.toArray().map((row) => {
    const o = row.toJSON();
    for (const k of Object.keys(o)) if (typeof o[k] === "bigint") o[k] = Number(o[k]);
    return o;
  });
}

// Queries run one at a time through a two-lane scheduler: the fast lane
// (charts, summaries, search — small cube reads) always runs before queued
// bulk work (table row scans over the per-FY files), so one long scan can't
// hold up the charts. The running query is never preempted — DuckDB-WASM
// executes a single query at a time regardless.
// `stale` (optional) is polled: queued queries whose result is already
// obsolete are skipped, and an in-flight query is cancelled via DuckDB's
// pending-query protocol instead of running to completion.
// Bulk work additionally waits for the fast lane to be quiet for a moment:
// chart queries enqueue one at a time (each awaits the previous), so without
// the grace period a bulk scan would grab the connection in the instant
// between two chart queries and block the rest for its whole run.
const BULK_DELAY = 400;
const queues = { fast: [], bulk: [] };
let running = false;
let lastFast = 0;
function pump() {
  if (running) return;
  const fast = queues.fast.shift();
  const job = fast || queues.bulk[0];
  if (!job) return;
  if (!fast) {
    const wait = lastFast + BULK_DELAY - Date.now();
    if (wait > 0) { setTimeout(pump, wait); return; }
    queues.bulk.shift();
  } else {
    lastFast = Date.now();
  }
  running = true;
  job().finally(() => {
    if (fast) lastFast = Date.now();
    running = false; pump();
  });
}

export function query(sql, stale, lane = "fast") {
  if (lane === "fast") lastFast = Date.now();
  const run = async () => {
    if (stale?.()) throw STALE;
    const conn = await getConn();
    if (!stale) {
      const table = await conn.query(sql);
      return toRows(table);
    }
    // conn.send() executes through the cancellable pending-query path.
    const watchdog = setInterval(() => {
      if (stale()) conn.cancelSent().catch(() => {});
    }, 100);
    try {
      const reader = await conn.send(sql);
      const rows = [];
      for await (const batch of reader) rows.push(...toRows(batch));
      if (stale()) throw STALE;
      return rows;
    } catch (e) {
      throw stale() ? STALE : e;
    } finally {
      clearInterval(watchdog);
    }
  };
  return new Promise((resolve, reject) => {
    queues[lane].push(() => run().then(resolve, reject));
    pump();
  });
}

export async function loadManifest() {
  const res = await fetch(new URL("datasets.json", DATA_BASE));
  if (!res.ok) throw new Error(`datasets.json: HTTP ${res.status}`);
  return res.json();
}
