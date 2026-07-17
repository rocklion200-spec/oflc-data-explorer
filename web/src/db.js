// DuckDB-WASM setup: bundled locally (no CDN), parquet files registered as
// HTTP-range-readable URLs so only the row groups a query needs are fetched.
import * as duckdb from "@duckdb/duckdb-wasm";
import wasmMvp from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import workerMvp from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import wasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import workerEh from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";

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
  return db.connect();
}

function getConn() {
  if (!connPromise) connPromise = init();
  return connPromise;
}

export async function registerParquet(fileName) {
  if (registered.has(fileName)) return;
  await getConn(); // ensure db exists
  const url = new URL(`data/${fileName}`, document.baseURI).href;
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

// Serialize queries through one connection; convert Arrow rows to plain JS.
// `stale` (optional) is polled: queued queries whose result is already
// obsolete are skipped, and an in-flight query is cancelled via DuckDB's
// pending-query protocol instead of running to completion.
let chain = Promise.resolve();
export function query(sql, stale) {
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
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

export async function loadManifest() {
  const res = await fetch(new URL("data/datasets.json", document.baseURI));
  if (!res.ok) throw new Error(`datasets.json: HTTP ${res.status}`);
  return res.json();
}
