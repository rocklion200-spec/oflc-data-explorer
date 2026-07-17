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

// Serialize queries through one connection; convert Arrow rows to plain JS.
let chain = Promise.resolve();
export function query(sql) {
  const run = async () => {
    const conn = await getConn();
    const table = await conn.query(sql);
    return table.toArray().map((row) => {
      const o = row.toJSON();
      for (const k of Object.keys(o)) if (typeof o[k] === "bigint") o[k] = Number(o[k]);
      return o;
    });
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
