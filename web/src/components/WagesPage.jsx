import { useEffect, useMemo, useRef, useState } from "react";
import { isStale } from "../db.js";
import {
  loadWageIndex, fetchWageTrend, fetchWageRowsMulti, fetchCityCounties,
  fetchEntityTop, fetchTopGroupsMulti, scope, whereClause, locFromPlace,
  NEW_ENGLAND,
} from "../queries.js";
import { downloadXlsx } from "../xlsx.js";
import {
  WageLevelsChart, MultiLineChart, TopBars, fmtUsd, fmtNum, fmtFyRange,
} from "./charts.jsx";

// The wage-levels view: pick an occupation and a county once, see every wage
// year at once — the selection survives switching years/sources, which is the
// navigation the DOL wage search makes painful (it resets criteria whenever
// the data series changes). Several occupations OR several counties can be
// selected at once; the chart then compares one wage level across them.

const SRC_LABELS = { alc: "All industries (OEWS)", edc: "Higher education (ACWIA)" };
const HOURS_YEAR = 2080;

// compare-mode cap = the categorical palette's validated slot count
const MAX_SERIES = 8;
const CAT_COLORS = Array.from({ length: MAX_SERIES }, (_, i) => `var(--cat-${i + 1})`);
const LEVELS = [
  ["l1", "Level 1"], ["l2", "Level 2"], ["l3", "Level 3"], ["l4", "Level 4"],
  ["avg", "Average"],
];
const LEVEL_LABELS = Object.fromEntries(LEVELS);

const spanLabel = (y) => `${y}–${String((y + 1) % 100).padStart(2, "0")}`;
const norm = (s) => s.toLowerCase();
const squash = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

// view state <-> URL hash. Selections: s=15-1252,15-1253 (occupation codes)
// and p=CA|SANTACLARA,WA|KING (era-stable county keys). Legacy single-place
// params still parse and are written for cross-links that carry them: st/co
// (state + county display name), ck (county key), ct (a raw city-name
// fallback for pre-2025 New England, whose wage areas are towns).
export function wagesHash(p = {}) {
  const occs = p.occs ?? (p.soc ? [p.soc] : p.s ? String(p.s).split(",") : []);
  let places = p.places;
  if (!places) {
    if (p.st) places = [{ st: p.st, county: p.county || null, key: p.ck || null, ct: p.ct || null }];
    else if (p.p) {
      places = String(p.p).split(",").map((t) => {
        const [st, key] = t.split("|");
        return { st, key };
      });
    } else places = [];
  }
  const q = new URLSearchParams();
  if (occs.length) q.set("s", occs.join(","));
  if (occs.length === 1 && p.socLabel) q.set("sl", p.socLabel);
  // p-form only for pure {st, key} tokens: a legacy token keeps its co/ct
  // params (ct in particular changes which place the key resolves to)
  const pure = places.every((pl) => pl.st && pl.key && !pl.ct && !pl.county);
  if (pure && places.length) {
    q.set("p", places.map((pl) => `${pl.st}|${pl.key}`).join(","));
  } else if (places.length) {
    const pl = places[0];
    q.set("st", pl.st);
    if (pl.county) q.set("co", pl.county);
    if (pl.key) q.set("ck", pl.key);
    if (pl.ct) q.set("ct", pl.ct);
  }
  if (p.src && p.src !== "alc") q.set("src", p.src);
  if (p.unit && p.unit !== "annual") q.set("u", p.unit);
  const lvl = p.lvl ?? p.lv;
  if (lvl && lvl !== "l1") q.set("lv", lvl);
  const s = q.toString();
  return "#wages" + (s ? "?" + s : "");
}

function wagesFromHash() {
  const h = window.location.hash;
  const q = new URLSearchParams(h.startsWith("#wages") ? h.split("?")[1] || "" : "");
  const occs = (q.get("s") || "").split(",").filter(Boolean);
  let places = [];
  if (q.get("p")) {
    places = q.get("p").split(",").map((t) => {
      const [st, key] = t.split("|");
      return { st, key };
    }).filter((pl) => pl.st && pl.key);
  } else if (q.get("st")) {
    places = [{
      st: q.get("st"), county: q.get("co"),
      key: q.get("ck"), ct: q.get("ct"),
    }];
  }
  return {
    occs, socLabel: q.get("sl"), places,
    src: q.get("src") || "alc", unit: q.get("u") || "annual",
    lvl: q.get("lv") || "l1",
  };
}

// Generic combobox over an in-memory list: `filter(text)` returns items,
// `render(item)` a row, `onPick(item)` commits. (Used by the export panel.)
function Combo({ placeholder, filter, render, onPick }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef(null);

  useEffect(() => {
    const onDown = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const items = open ? filter(text) : [];
  const pick = (it) => { onPick(it); setText(""); setOpen(false); };
  const onKey = (e) => {
    if (!open || !items.length) return;
    if (e.key === "ArrowDown" || e.key === "Down") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
    else if (e.key === "ArrowUp" || e.key === "Up") { e.preventDefault(); setActive((a) => Math.max(a - 1, -1)); }
    else if (e.key === "Enter" || e.key === "Return") { e.preventDefault(); pick(items[Math.max(active, 0)]); }
    else if (e.key === "Escape") setOpen(false);
  };

  return (
    <div className="hero wage-combo" ref={boxRef}>
      <input type="search" className="hero-input" autoComplete="off" placeholder={placeholder}
        value={text}
        onChange={(e) => { setText(e.target.value); setOpen(true); setActive(-1); }}
        onFocus={() => setOpen(true)} onKeyDown={onKey} />
      {open && (
        <div className="hero-list" role="listbox">
          {items.length === 0 && <div className="hero-note">No matches.</div>}
          <ul>
            {items.map((it, i) => (
              <li key={it.key} role="option" aria-selected={i === active}
                className={i === active ? "active" : ""}
                onMouseDown={(e) => { e.preventDefault(); pick(it); }}>
                {render(it)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// One search box over occupations AND counties, like the case explorer's.
// The section with more matches leads — "New York" matches counties, not
// occupations, so counties come first there. Enter picks the top item.
function WageSearch({ occSearch, placeSearch, occRow, placeRow, onPickOcc, onPickPlace }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef(null);

  useEffect(() => {
    const onDown = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const sections = [];
  const items = [];
  if (open) {
    const occ = occSearch ? { dim: "occ", label: "Occupations", ...occSearch(text, 8) } : null;
    const pl = placeSearch ? { dim: "place", label: "Counties", ...placeSearch(text, 8) } : null;
    for (const s of (pl && occ && text.trim() && pl.total > occ.total)
      ? [pl, occ] : [occ, pl]) {
      if (!s || !s.items.length) continue;
      const sec = { dim: s.dim, label: s.label, items: [] };
      for (const it of s.items) {
        const item = { ...it, dim: s.dim, i: items.length,
          uid: s.dim + (it.listKey ?? it.key) };
        items.push(item);
        sec.items.push(item);
      }
      sections.push(sec);
    }
  }

  const pick = (it) => {
    if (it.dim === "occ") onPickOcc(it); else onPickPlace(it);
    setText(""); setActive(-1);
  };
  const onKey = (e) => {
    if (!open || !items.length) return;
    if (e.key === "ArrowDown" || e.key === "Down") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
    else if (e.key === "ArrowUp" || e.key === "Up") { e.preventDefault(); setActive((a) => Math.max(a - 1, -1)); }
    else if (e.key === "Enter" || e.key === "Return") { e.preventDefault(); pick(items[Math.max(active, 0)]); }
    else if (e.key === "Escape") setOpen(false);
  };

  return (
    <div className="hero" ref={boxRef}>
      <input type="search" className="hero-input" autoComplete="off"
        placeholder="Search an occupation or county — e.g. Software Developers, Santa Clara"
        value={text}
        onChange={(e) => { setText(e.target.value); setOpen(true); setActive(-1); }}
        onFocus={() => setOpen(true)} onKeyDown={onKey} />
      {open && (
        <div className="hero-list" role="listbox">
          {items.length === 0 && <div className="hero-note">No matches.</div>}
          {sections.map((s) => (
            <div key={s.dim}>
              <div className="hero-section">{s.label}</div>
              <ul>
                {s.items.map((it) => (
                  <li key={it.uid} role="option" aria-selected={it.i === active}
                    className={it.i === active ? "active" : ""}
                    onMouseDown={(e) => { e.preventDefault(); pick(it); }}>
                    {s.dim === "occ" ? occRow(it) : placeRow(it)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const MAX_PICKS = 25;
const HOURLY_TO_ANNUAL = (v, annual) =>
  v == null ? null : Math.round(annual ? v : v * HOURS_YEAR);

// Spreadsheet download of wage levels for ANY set of occupations × counties.
// Rows are the raw published values plus annualized columns; one row per wage
// year, occupation, county.
function WageExport({ manifest, index, src, initSocs, initPlaces, filterOccs, filterPlaces, onError }) {
  const [open, setOpen] = useState(false);
  const [socs, setSocs] = useState([]);
  const [places, setPlaces] = useState([]);
  const [busy, setBusy] = useState(false);

  const show = () => {
    if (!open) {
      // seed with whatever is currently charted
      if (!socs.length && initSocs?.length) setSocs(initSocs.slice(0, MAX_PICKS));
      if (!places.length && initPlaces?.length) setPlaces(initPlaces.slice(0, MAX_PICKS));
    }
    setOpen(!open);
  };
  const addSoc = (o) => setSocs((xs) =>
    xs.length < MAX_PICKS && !xs.some((x) => x.code === o.code) ? [...xs, o] : xs);
  const addPlace = (p) => setPlaces((xs) =>
    xs.length < MAX_PICKS && !xs.some((x) => x.st === p.st && x.key === p.key)
      ? [...xs, p] : xs);

  const doExport = async () => {
    if (busy || !socs.length || !places.length) return;
    setBusy(true);
    try {
      const rows = await fetchWageRowsMulti(
        manifest, socs.map((s) => s.code), places, src);
      const titles = new Map(index.occs.map((o) => [o.code, o.title]));
      const data = rows.map((r) => ({
        wage_year: spanLabel(r.wage_year),
        state: r.state_ab, county: r.county, area: r.area_name,
        soc: r.soc_2018, occupation: titles.get(r.soc_2018) ?? r.soc_2018,
        soc_in_file: r.soc_code,
        basis: r.annual ? "Annual" : "Hourly",
        level1: r.level1, level2: r.level2, level3: r.level3, level4: r.level4,
        average: r.average,
        a1: HOURLY_TO_ANNUAL(r.level1, r.annual),
        a2: HOURLY_TO_ANNUAL(r.level2, r.annual),
        a3: HOURLY_TO_ANNUAL(r.level3, r.annual),
        a4: HOURLY_TO_ANNUAL(r.level4, r.annual),
        aavg: HOURLY_TO_ANNUAL(r.average, r.annual),
        note: r.note,
      }));
      const meta = [
        ["Dataset", `OFLC wage library — ${SRC_LABELS[src]}`],
        ["Occupations", socs.map((s) => `${s.title} (${s.code})`).join("; ")],
        ["Counties", places.map((p) => `${p.county}, ${p.st}`).join("; ")],
        ["Rows", data.length],
        ["Notes", `Wage years run July–June. Levels are as published (see Basis); annualized columns convert hourly figures at ${HOURS_YEAR.toLocaleString()} hours/year. Missing (occupation, county, year) combinations have no published wage.`],
        ["Generated", new Date().toISOString()],
        ["Source", "https://flag.dol.gov/wage-data/wage-data-downloads"],
        ["Exported from", window.location.href.split("#")[0] + "#wages"],
      ].map(([k, v]) => ({ k, v }));
      downloadXlsx("oflc-wage-levels.xlsx", [
        { name: "Wage levels",
          columns: [
            { key: "wage_year", label: "Wage year" }, { key: "state", label: "State" },
            { key: "county", label: "County" }, { key: "area", label: "Wage area" },
            { key: "soc", label: "SOC (2018)" }, { key: "occupation", label: "Occupation" },
            { key: "soc_in_file", label: "SOC in source file" }, { key: "basis", label: "Basis" },
            { key: "level1", label: "Level 1" }, { key: "level2", label: "Level 2" },
            { key: "level3", label: "Level 3" }, { key: "level4", label: "Level 4" },
            { key: "average", label: "Average" },
            { key: "a1", label: "Level 1 (annualized)" }, { key: "a2", label: "Level 2 (annualized)" },
            { key: "a3", label: "Level 3 (annualized)" }, { key: "a4", label: "Level 4 (annualized)" },
            { key: "aavg", label: "Average (annualized)" }, { key: "note", label: "Note" },
          ],
          rows: data },
        { name: "About this export",
          columns: [{ key: "k", label: "Field" }, { key: "v", label: "Value" }],
          rows: meta },
      ]);
    } catch (e) {
      if (!isStale(e)) onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className="tool-btn" onClick={show}>
        {open ? "Close download ✕" : "⬇ Excel"}
      </button>
      {open && (
        <div className="panel wage-export">
          <h2>Download wage levels
            <span className="scope-note">
              {SRC_LABELS[src]} · all wage years · up to {MAX_PICKS} occupations × {MAX_PICKS} counties
            </span>
          </h2>
          <div className="wage-pickers">
            <div>
              <div className="chips-row">
                {socs.map((o) => (
                  <span className="chip" key={o.code}>{o.title} ({o.code})
                    <button aria-label="Remove" onClick={() =>
                      setSocs((xs) => xs.filter((x) => x.code !== o.code))}>×</button>
                  </span>
                ))}
              </div>
              <Combo placeholder="Add an occupation…"
                filter={filterOccs} onPick={addSoc}
                render={(o) => <span className="v">{o.title} <span className="code">{o.code}</span></span>} />
            </div>
            <div>
              <div className="chips-row">
                {places.map((p) => (
                  <span className="chip" key={`${p.st}|${p.key}`}>{p.county}, {p.st}
                    <button aria-label="Remove" onClick={() =>
                      setPlaces((xs) => xs.filter((x) => !(x.st === p.st && x.key === p.key)))}>×</button>
                  </span>
                ))}
              </div>
              <Combo placeholder="Add a county…"
                filter={filterPlaces} onPick={addPlace}
                render={(p) => (
                  <span className="v">{p.county}, {p.st}
                    <span className="code"> {p.area_name}</span>
                  </span>
                )} />
            </div>
          </div>
          <div className="wage-controls">
            <button className="tool-btn" disabled={busy || !socs.length || !places.length}
              onClick={doExport}>
              {busy ? "Preparing…" : "Download .xlsx"}
            </button>
            <span className="chart-note">
              One row per wage year, occupation and county — as published plus annualized values.
            </span>
          </div>
        </div>
      )}
    </>
  );
}

export function WagesPage({ manifest, onError, onOpenCases }) {
  const [state, setState] = useState(wagesFromHash);
  const [index, setIndex] = useState(null);
  const [trends, setTrends] = useState(null); // one row-array per series combo
  const [busy, setBusy] = useState(false);
  const [topRoles, setTopRoles] = useState(null);
  const [topPlaces, setTopPlaces] = useState(null);
  const run = useRef(0);
  const rolesRun = useRef(0);
  const placesRun = useRef(0);
  const fromPop = useRef(false);
  const years = manifest.wages?.years ?? [];

  useEffect(() => {
    loadWageIndex(manifest)
      .then(setIndex)
      .catch((e) => onError(String(e)));
  }, [manifest]); // eslint-disable-line

  // hash sync (and back/forward)
  useEffect(() => {
    const onPop = () => {
      if (!window.location.hash.startsWith("#wages")) return; // App switches views
      fromPop.current = true;
      setState(wagesFromHash());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    if (fromPop.current) { fromPop.current = false; return; }
    const hash = wagesHash(state);
    if (hash !== window.location.hash) history.pushState(null, "", hash);
  }, [state]);

  // resolve selected codes/keys against the index (labels can arrive via the
  // hash before the index loads; backfill once it does)
  const occsResolved = useMemo(() => state.occs.map((code) =>
    index?.occs.find((o) => o.code === code)
      ?? { code, title: (state.occs.length === 1 && state.socLabel) || code }),
  [state.occs, state.socLabel, index]);

  const placesResolved = useMemo(() => state.places.map((tok) => {
    const ps = index?.places;
    if (!ps) return { ...tok, county: tok.county ?? tok.key ?? tok.ct };
    const inSt = (f) => ps.find((p) => p.st === tok.st && f(p));
    // town-name match first: for NE cities the town key carries the long
    // 2005–2024 series, the county key only 2025+
    return (tok.ct && inSt((p) => p.key === squash(tok.ct)))
      || (tok.key && inSt((p) => p.key === tok.key))
      || (tok.county && inSt((p) => p.county === tok.county))
      || { st: tok.st, county: tok.county ?? tok.key ?? tok.ct, key: null, area_name: null };
  }), [state.places, index]);

  // one series per chart line: several occupations at one place, or one
  // occupation across several places (never both — adding to one dimension
  // trims the other back to a single selection)
  const combos = useMemo(() => {
    if (!occsResolved.length || !placesResolved.length) return [];
    if (occsResolved.length > 1) {
      return occsResolved.map((o) => ({ occ: o, place: placesResolved[0] }));
    }
    return placesResolved.map((pl) => ({ occ: occsResolved[0], place: pl }));
  }, [occsResolved, placesResolved]);
  const multiDim = occsResolved.length > 1 ? "occ"
    : placesResolved.length > 1 ? "place" : null;
  const single = combos.length === 1;
  const combosKey = combos
    .map((c) => `${c.occ.code}|${c.place.st}|${c.place.key}`).join(",");

  useEffect(() => {
    if (!combos.length) { setTrends(null); return; }
    if (!combos.every((c) => c.place.key)) {
      if (index) setTrends(combos.map(() => [])); // unknown place in the hash
      return;
    }
    const id = ++run.current;
    const stale = () => id !== run.current;
    setBusy(true);
    Promise.all(combos.map((c) =>
      fetchWageTrend(manifest, c.occ.code, c.place.st, c.place.key, state.src, stale)))
      .then((rs) => { if (!stale()) { setTrends(rs); setBusy(false); } })
      .catch((e) => {
        if (isStale(e)) return;
        if (id === run.current) { onError(String(e)); setBusy(false); }
      });
  }, [manifest, combosKey, index, state.src]); // eslint-disable-line

  // ---- selection edits ------------------------------------------------
  const addOcc = (o) => setState((s) => {
    if (!o || s.occs.includes(o.code) || s.occs.length >= MAX_SERIES) return s;
    const occs = [...s.occs, o.code];
    // only one dimension may hold multiple selections
    const places = occs.length > 1 && s.places.length > 1
      ? s.places.slice(0, 1) : s.places;
    return { ...s, occs, places, socLabel: occs.length === 1 ? o.title : null };
  });
  const addPlace = (p) => setState((s) => {
    if (!p?.key || s.places.some((x) => x.st === p.st && x.key === p.key)
      || s.places.length >= MAX_SERIES) return s;
    // normalize any legacy cross-link token to its resolved {st, key} so the
    // whole list serializes in the compact p= hash form
    const prior = s.places.map((tok, i) =>
      placesResolved[i]?.key ? { st: placesResolved[i].st, key: placesResolved[i].key } : tok);
    if (prior.some((x) => x.st === p.st && x.key === p.key)) return s;
    const places = [...prior, { st: p.st, key: p.key }];
    const occs = places.length > 1 && s.occs.length > 1 ? s.occs.slice(0, 1) : s.occs;
    return { ...s, occs, places };
  });
  const removeOcc = (code) => setState((s) =>
    ({ ...s, occs: s.occs.filter((c) => c !== code), socLabel: null }));
  const removePlace = (i) => setState((s) =>
    ({ ...s, places: s.places.filter((_, j) => j !== i) }));
  const clearAll = () => setState((s) => ({ ...s, occs: [], places: [], socLabel: null }));

  // ---- search / pickers -----------------------------------------------
  const occMatches = (text, limit = 20) => {
    if (!index) return { items: [], total: 0 };
    const t = norm(text.trim());
    const hit = t
      ? index.occs.filter((o) => norm(o.title).includes(t) || o.code.startsWith(t))
      : index.occs;
    const rank = (o) => (t && norm(o.title).startsWith(t) ? 0 : 1);
    return {
      items: [...hit].sort((a, b) => rank(a) - rank(b))
        .slice(0, limit).map((o) => ({ ...o, key: o.code })),
      total: hit.length,
    };
  };
  const placeMatches = (text, limit = 20) => {
    if (!index) return { items: [], total: 0 };
    const t = norm(text.trim());
    const hit = t
      ? index.places.filter((p) =>
          norm(p.county).includes(t) || norm(p.state).includes(t)
          || norm(p.st) === t || norm(p.area_name).includes(t))
      : index.places;
    // counties whose name starts with the query first, then the rest
    const rank = (p) => (t && norm(p.county).startsWith(t) ? 0 : 1);
    return {
      items: hit.map((p) => ({ ...p, key: p.key, listKey: `${p.st}|${p.key}` }))
        .sort((a, b) => rank(a) - rank(b)).slice(0, limit),
      total: hit.length,
    };
  };
  const coverage = (p) =>
    p.y0 === years[0] && p.y1 === years[years.length - 1]
      ? null : `${spanLabel(p.y0)} to ${spanLabel(p.y1)}`;
  const occRow = (o) => (
    <span className="v">{o.title} <span className="code">{o.code}
      {o.in_alc && !o.in_edc ? " · all-industries table only"
        : o.in_edc && !o.in_alc ? " · ACWIA table only" : ""}</span></span>
  );
  const placeRow = (p) => (
    <span className="v">{p.county}, {p.st}
      <span className="code"> {p.area_name}{coverage(p) ? ` · ${coverage(p)}` : ""}</span>
    </span>
  );

  // adding is legal while under the cap and the OTHER dimension isn't
  // already holding the multiple selections
  const canAddOcc = occsResolved.length === 0
    || (occsResolved.length < MAX_SERIES && placesResolved.length <= 1);
  const canAddPlace = placesResolved.length === 0
    || (placesResolved.length < MAX_SERIES && occsResolved.length <= 1);

  // ---- top charts (drill-down entry points) ---------------------------
  // disclosure soc_group -> wage-library occupation (socs.parquet carries
  // group_code, the occupation's disclosure group)
  const occForGroup = useMemo(() => {
    const m = new Map();
    for (const o of index?.occs ?? []) if (!m.has(o.code)) m.set(o.code, o);
    for (const o of index?.occs ?? []) {
      if (o.group_code && !m.has(o.group_code)) m.set(o.group_code, o);
    }
    return (k) => {
      const base = /^(\d{2}-\d{4})/.exec(k || "")?.[1];
      return base ? m.get(base) ?? null : null;
    };
  }, [index]);

  const firstPlace = placesResolved[0];
  const firstOcc = occsResolved[0];

  // Top roles: global (by filings, from the landing manifest) or, once a
  // county is picked, the roles actually filed there (recent LCA records).
  useEffect(() => {
    if (!index || !canAddOcc) { setTopRoles(null); return; }
    const id = ++rolesRun.current;
    const stale = () => id !== rolesRun.current;
    const mapRows = (rows) => rows
      .map((d) => ({ ...d, occ: occForGroup(d.k) }))
      .filter((d) => d.occ).slice(0, 12);
    if (!firstPlace?.key) {
      setTopRoles({ scope: "global", rows: mapRows(manifest.landing?.tops?.soc ?? []) });
      return;
    }
    (async () => {
      const fys = (manifest.programs?.lca ?? [])
        .filter((f) => f.rows > 100).map((f) => f.fy).slice(-2);
      const from = await scope(manifest, "lca", fys);
      if (!from || stale()) { if (!stale()) setTopRoles({ scope: "global", rows: [] }); return; }
      const where = whereClause({}, { loc: locFromPlace(firstPlace) });
      const res = await fetchTopGroupsMulti(from, where,
        [{ dim: "soc", col: "soc_group", labelExpr: "mode(soc_title)" }], stale, 20);
      if (stale()) return;
      setTopRoles({ scope: "place", place: firstPlace, rows: mapRows(res.soc ?? []) });
    })().catch((e) => {
      if (!isStale(e) && id === rolesRun.current) onError(String(e));
    });
  }, [index, canAddOcc, firstPlace?.st, firstPlace?.key, manifest]); // eslint-disable-line

  // Top locations: disclosure tops are cities — resolve each to its county
  // (or its pre-2025 New England town) and merge counts per wage-area place.
  useEffect(() => {
    if (!index || !canAddPlace) { setTopPlaces(null); return; }
    const id = ++placesRun.current;
    const stale = () => id !== placesRun.current;
    (async () => {
      let cities, scopeLbl;
      if (firstOcc) {
        const gk = firstOcc.group_code || firstOcc.code;
        const rows = await fetchEntityTop(manifest, "soc_loc", gk, stale, 40);
        cities = rows.map((d) => ({ state: d.state, city_key: d.city_key, n: d.n,
          fy_lo: d.fy_lo, fy_hi: d.fy_hi }));
        scopeLbl = "occ";
      }
      if (!cities?.length) {
        cities = (manifest.landing?.tops?.loc ?? [])
          .filter((d) => d.city_key)
          .map((d) => ({ state: d.state, city_key: d.city_key, n: d.n,
            fy_lo: d.fy_lo, fy_hi: d.fy_hi }));
        scopeLbl = "global";
      }
      if (stale()) return;
      const ccMap = await fetchCityCounties(manifest, cities, stale);
      if (stale()) return;
      const bySt = new Map();
      for (const p of index.places) {
        if (!bySt.has(p.st)) bySt.set(p.st, []);
        bySt.get(p.st).push(p);
      }
      const resolve = (st, cityKey, countyKey) => {
        const ps = bySt.get(st) ?? [];
        return (NEW_ENGLAND.includes(st) && ps.find((p) => p.key === squash(cityKey)))
          || (countyKey && ps.find((p) => p.key === countyKey)) || null;
      };
      const agg = new Map();
      for (const c of cities) {
        const pl = resolve(c.state, c.city_key, ccMap[`${c.state}|${c.city_key}`]);
        if (!pl) continue;
        const k = `${pl.st}|${pl.key}`;
        const cur = agg.get(k) ?? { place: pl, n: 0, fy_lo: null, fy_hi: null };
        cur.n += Number(c.n);
        // several cities fold into one wage area: keep the widest span
        if (c.fy_lo != null) cur.fy_lo = Math.min(cur.fy_lo ?? c.fy_lo, c.fy_lo);
        if (c.fy_hi != null) cur.fy_hi = Math.max(cur.fy_hi ?? c.fy_hi, c.fy_hi);
        agg.set(k, cur);
      }
      const rows = [...agg.values()].sort((a, b) => b.n - a.n).slice(0, 12)
        .map(({ place, n, fy_lo, fy_hi }) =>
          ({ label: `${place.county}, ${place.st}`, n, fy_lo, fy_hi, place }));
      setTopPlaces({ scope: scopeLbl, occ: firstOcc, rows });
    })().catch((e) => {
      if (!isStale(e) && id === placesRun.current) onError(String(e));
    });
  }, [index, canAddPlace, firstOcc?.code, manifest]); // eslint-disable-line

  // ---- display helpers ------------------------------------------------
  // unit conversion: annual-basis rows already hold yearly figures
  const disp = (v, annual) => {
    if (v == null) return null;
    const yearly = annual ? v : v * HOURS_YEAR;
    return state.unit === "annual" ? Math.round(yearly) : Math.round((yearly / HOURS_YEAR) * 100) / 100;
  };
  const fmt = state.unit === "annual" ? fmtUsd : (v) => (v == null ? "–" : `$${v.toFixed(2)}`);
  const lvlKey = state.lvl === "avg" ? "average" : state.lvl;
  const placeName = (p) => `${p.county}, ${p.st}`;
  const seriesName = (c) => (multiDim === "occ" ? c.occ.title : placeName(c.place));

  // single-selection chart: all four levels + the OEWS average
  const trend = single ? trends?.[0] : null;
  const byYear = new Map((trend ?? []).map((r) => [r.year, r]));
  const chartData = years.map((y) => {
    const r = byYear.get(y);
    const d = {
      label: spanLabel(y), missing: !r,
      l1: r ? disp(r.l1, r.annual) : null, l2: r ? disp(r.l2, r.annual) : null,
      l3: r ? disp(r.l3, r.annual) : null, l4: r ? disp(r.l4, r.annual) : null,
      avg: r ? disp(r.average, r.annual) : null,
    };
    d.tip = r ? [
      ["", `${spanLabel(y)} · ${r.area_name}`],
      ["Level 4", fmt(d.l4)], ["Level 3", fmt(d.l3)],
      ["Level 2", fmt(d.l2)], ["Level 1", fmt(d.l1)], ["Average", fmt(d.avg)],
      ...(r.codes.includes("+") ? [["", `avg of ${r.codes} (SOC revision)`]] : []),
    ] : [["", `${spanLabel(y)} — no published wage`]];
    return d;
  });
  const latest = [...(trend ?? [])].reverse().find((r) => r.l4 != null || r.average != null);
  const missing = single && trend && years.filter((y) => !byYear.has(y));

  // compare chart: the selected level, one line per occupation/county
  const multiSeries = !single ? combos.map((c, i) => {
    const by = new Map((trends?.[i] ?? []).map((r) => [r.year, r]));
    return {
      name: seriesName(c), color: CAT_COLORS[i],
      values: years.map((y) => {
        const r = by.get(y);
        return r ? disp(r[lvlKey], r.annual) : null;
      }),
    };
  }) : [];
  const emptySeries = !single && trends
    ? combos.filter((_, i) => !(trends[i] ?? []).length).map(seriesName) : [];

  const ready = combos.length > 0;
  const atCap = occsResolved.length >= MAX_SERIES || placesResolved.length >= MAX_SERIES;

  const chips = (occsResolved.length > 0 || placesResolved.length > 0) && (
    <div className="chips-row">
      <div className="chips">
        {occsResolved.map((o, i) => (
          <span key={o.code} className="chip">
            <span className="kind">Role</span>
            {multiDim === "occ" && <i className="swatch" style={{ background: CAT_COLORS[i] }} />}
            {o.title}
            <button aria-label={`Remove ${o.title}`} onClick={() => removeOcc(o.code)}>×</button>
          </span>
        ))}
        {placesResolved.map((p, i) => (
          <span key={`${p.st}|${p.key ?? p.county}`} className="chip">
            <span className="kind">County</span>
            {multiDim === "place" && <i className="swatch" style={{ background: CAT_COLORS[i] }} />}
            {placeName(p)}
            <button aria-label={`Remove ${placeName(p)}`} onClick={() => removePlace(i)}>×</button>
          </span>
        ))}
        {occsResolved.length + placesResolved.length > 1 && (
          <button className="linkish" onClick={clearAll}>Clear all</button>
        )}
      </div>
      {atCap && <span className="wage-note">Compare is capped at {MAX_SERIES} series.</span>}
    </div>
  );

  const topCharts = index && (canAddOcc || canAddPlace) && (
    <div className="top-charts">
      {canAddOcc && (
        <div className="panel">
          <h2>Top roles
            <span className="scope-note">
              {topRoles?.scope === "place"
                ? `filings in ${placeName(topRoles.place)} · recent LCA`
                : "by filings · all programs & years"}
            </span>
          </h2>
          {topRoles ? (
            <TopBars extraLabel="Median wage"
              data={topRoles.rows.map((r) => ({ label: r.label, value: r.n, extra: r.median_wage,
                years: fmtFyRange(r.fy_lo, r.fy_hi), row: r }))}
              onPick={(d) => addOcc(d.row.occ)} />
          ) : <div className="chart-note">Loading…</div>}
        </div>
      )}
      {canAddPlace && (
        <div className="panel">
          <h2>Top locations
            <span className="scope-note">
              {topPlaces?.scope === "occ"
                ? `filings for ${topPlaces.occ.title} · all years`
                : "by filings · all programs & years"}
            </span>
          </h2>
          {topPlaces ? (
            <TopBars
              data={topPlaces.rows.map((r) => ({ label: r.label, value: r.n,
                years: fmtFyRange(r.fy_lo, r.fy_hi), row: r }))}
              onPick={(d) => addPlace(d.row.place)} />
          ) : <div className="chart-note">Loading…</div>}
        </div>
      )}
    </div>
  );

  return (
    <>
      <WageSearch
        occSearch={canAddOcc ? occMatches : null}
        placeSearch={canAddPlace ? placeMatches : null}
        occRow={occRow} placeRow={placeRow}
        onPickOcc={addOcc} onPickPlace={addPlace} />
      {chips}

      <div className="wage-controls">
        <div className="tabs">
          {Object.entries(SRC_LABELS).map(([k, label]) => (
            <button key={k} className={state.src === k ? "active" : ""}
              onClick={() => setState((s) => ({ ...s, src: k }))}>{label}</button>
          ))}
        </div>
        <div className="year-presets">
          {["annual", "hourly"].map((u) => (
            <button key={u} className={state.unit === u ? "on" : ""}
              onClick={() => setState((s) => ({ ...s, unit: u }))}>
              {u === "annual" ? "Annual" : "Hourly"}
            </button>
          ))}
        </div>
        {!single && ready && (
          <div className="year-presets">
            {LEVELS.map(([k, label]) => (
              <button key={k} className={state.lvl === k ? "on" : ""}
                onClick={() => setState((s) => ({ ...s, lvl: k }))}>{label}</button>
            ))}
          </div>
        )}
        {firstOcc && (
          <button className="linkish" onClick={() => onOpenCases(
            index?.occs.find((o) => o.code === firstOcc.code) ?? { code: firstOcc.code },
            firstOcc.title, firstPlace)}>
            Filings for this occupation{firstPlace?.key ? " here" : ""} →
          </button>
        )}
      </div>

      {index && (
        <WageExport manifest={manifest} index={index} src={state.src}
          initSocs={occsResolved.filter((o) => o.title !== o.code)}
          initPlaces={placesResolved.filter((p) => p.key)}
          filterOccs={(t) => occMatches(t).items}
          filterPlaces={(t) => placeMatches(t).items}
          onError={onError} />
      )}

      {!ready && (
        <div className="panel wage-intro">
          <h2>Prevailing wage levels over time</h2>
          <p>
            Pick an occupation and a county — search above or click the charts below — to
            chart the OFLC wage library&apos;s four prevailing wage levels (plus the OEWS
            average) across every wage year
            {years.length ? ` (${spanLabel(years[0])} through ${spanLabel(years[years.length - 1])})` : ""}.
            Add more counties (or more occupations) to compare one level, up
            to {MAX_SERIES} at a time. Wage years run July–June.
          </p>
        </div>
      )}

      {ready && single && (
        <>
          {latest && (
            <div className={`tiles${busy ? " updating" : ""}`}>
              {[["Level 1", "l1"], ["Level 2", "l2"], ["Level 3", "l3"], ["Level 4", "l4"], ["Average", "average"]].map(([label, k]) => (
                <div className="tile" key={k}>
                  <div className="label">{label} · {spanLabel(latest.year)}</div>
                  <div className="value">{fmt(disp(latest[k], latest.annual))}</div>
                </div>
              ))}
            </div>
          )}

          <div className={`panel${busy ? " updating" : ""}`}>
            <h2>
              {combos[0].occ.title} — {placeName(combos[0].place)}
              <span className="scope-note">{SRC_LABELS[state.src]} · {state.unit}</span>
            </h2>
            <WageLevelsChart data={chartData} valueFmt={fmt} />
            {missing && missing.length > 0 && trend.length > 0 && (
              <div className="chart-note">
                No published wage for {missing.map((y) => spanLabel(y)).join(", ")} — the
                occupation or area definition differs in those years’ files.
              </div>
            )}
            {trend && trend.length === 0 && (() => {
              const o = index?.occs.find((x) => x.code === combos[0].occ.code);
              const other = state.src === "alc" ? "edc" : "alc";
              return o && o[`in_${other}`] && !o[`in_${state.src}`] ? (
                <div className="chart-note">
                  This occupation is only published in the {SRC_LABELS[other]} table —
                  switch the source above.
                </div>
              ) : null;
            })()}
          </div>

          <div className={`panel${busy ? " updating" : ""}`}>
            <h2>Values by wage year</h2>
            <div className="table-wrap">
              <table className="results">
                <thead>
                  <tr>
                    <th>Wage year</th><th>Wage area</th>
                    <th className="num">Level 1</th><th className="num">Level 2</th>
                    <th className="num">Level 3</th><th className="num">Level 4</th>
                    <th className="num">Average</th><th>Basis</th>
                  </tr>
                </thead>
                <tbody>
                  {years.map((y) => {
                    const r = byYear.get(y);
                    return (
                      <tr key={y}>
                        <td>{spanLabel(y)}</td>
                        <td>{r ? r.area_name : "—"}</td>
                        {["l1", "l2", "l3", "l4", "average"].map((k) => (
                          <td className="num" key={k}>{r ? fmt(disp(r[k], r.annual)) : "–"}</td>
                        ))}
                        <td>{r ? (r.annual ? "Annual" : "Hourly")
                          + (r.note && r.note !== "Annual Wage" ? ` · ${r.note}` : "")
                          + (r.codes.includes("+") ? ` · avg of ${r.codes}` : "") : "no data"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="chart-note">
              Hourly figures annualized at {HOURS_YEAR.toLocaleString()} hours/year; occupations
              OEWS publishes on an annual basis are converted the other way for the hourly view.
            </div>
          </div>
        </>
      )}

      {ready && !single && (
        <>
          <div className={`panel${busy ? " updating" : ""}`}>
            <h2>
              {multiDim === "occ"
                ? `${LEVEL_LABELS[state.lvl]} by occupation — ${placeName(combos[0].place)}`
                : `${combos[0].occ.title} — ${LEVEL_LABELS[state.lvl]} by county`}
              <span className="scope-note">{SRC_LABELS[state.src]} · {state.unit}</span>
            </h2>
            <div className="wage-legend">
              {multiSeries.map((s) => (
                <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>
              ))}
            </div>
            <MultiLineChart
              data={years.map((y) => ({ label: spanLabel(y) }))}
              series={multiSeries} valueFmt={fmt} />
            {emptySeries.length > 0 && (
              <div className="chart-note">
                No published wages in this table for {emptySeries.join("; ")}.
              </div>
            )}
          </div>

          <div className={`panel${busy ? " updating" : ""}`}>
            <h2>{LEVEL_LABELS[state.lvl]} by wage year</h2>
            <div className="table-wrap">
              <table className="results">
                <thead>
                  <tr>
                    <th>Wage year</th>
                    {multiSeries.map((s) => <th className="num" key={s.name}>{s.name}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {years.map((y, yi) => (
                    <tr key={y}>
                      <td>{spanLabel(y)}</td>
                      {multiSeries.map((s) => (
                        <td className="num" key={s.name}>{fmt(s.values[yi])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="chart-note">
              Hourly figures annualized at {HOURS_YEAR.toLocaleString()} hours/year. Switch the
              level with the buttons above; blanks mean no published wage that year.
            </div>
          </div>
        </>
      )}

      {topCharts}
    </>
  );
}
