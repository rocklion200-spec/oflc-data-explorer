// Persistent LRU cache for chart/summary query results (never table rows).
// The disclosure data only changes when the pipeline republishes, so a result
// stays valid until datasets.json changes; a fingerprint of the manifest
// invalidates the whole store on republish. Entries mirror to localStorage —
// capped well below quota — so drill-downs someone has visited before render
// without repeating the row-level scan, even across sessions.
const STORE_KEY = "oflc-qcache-v1";
const MAX_ENTRIES = 100;
const MAX_CHARS = 1_500_000; // JSON length cap (~3 MB of UTF-16)

let mem = new Map(); // key -> {t, d}, kept in LRU order (oldest first)
let fp = null;
let timer = null;

export function initCache(manifest) {
  let files = 0, bytes = 0;
  for (const list of Object.values(manifest.programs || {}))
    for (const f of list) { files++; bytes += f.bytes || 0; }
  for (const f of Object.values(manifest.aggregates || {})) { files++; bytes += f.bytes || 0; }
  fp = `${files}:${bytes}`;
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (s && s.fp === fp && Array.isArray(s.entries)) {
      mem = new Map(s.entries.map((e) => [e.k, { t: e.t, d: e.d }]));
    } else if (s) {
      localStorage.removeItem(STORE_KEY); // data was republished
    }
  } catch { mem = new Map(); }
}

function persistSoon() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      let entries = [...mem].map(([k, v]) => ({ k, t: v.t, d: v.d }));
      let s = JSON.stringify({ fp, entries });
      while (s.length > MAX_CHARS && entries.length > 1) {
        entries = entries.slice(Math.ceil(entries.length / 4)); // shed oldest quarter
        s = JSON.stringify({ fp, entries });
      }
      localStorage.setItem(STORE_KEY, s);
    } catch { /* quota exceeded or storage unavailable — memory cache still works */ }
  }, 400);
}

// Return the cached result for `key`, or run `fn` and cache what it returns.
// A throwing `fn` (including stale-cancelled queries) caches nothing.
export async function cachedQuery(key, fn) {
  const hit = mem.get(key);
  if (hit !== undefined) {
    mem.delete(key); hit.t = Date.now(); mem.set(key, hit); // refresh LRU slot
    persistSoon();
    return hit.d;
  }
  const d = await fn();
  mem.set(key, { t: Date.now(), d });
  while (mem.size > MAX_ENTRIES) mem.delete(mem.keys().next().value);
  persistSoon();
  return d;
}
