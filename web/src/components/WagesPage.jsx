import { useEffect, useMemo, useRef, useState } from "react";
import { isStale } from "../db.js";
import { loadWageIndex, fetchWageTrend, fetchWageRowsMulti } from "../queries.js";
import { downloadXlsx } from "../xlsx.js";
import { WageLevelsChart, fmtUsd } from "./charts.jsx";

// The wage-levels view: pick an occupation and a county once, see every wage
// year at once — the selection survives switching years/sources, which is the
// navigation the DOL wage search makes painful (it resets criteria whenever
// the data series changes).

const SRC_LABELS = { alc: "All industries (OEWS)", edc: "Higher education (ACWIA)" };
const HOURS_YEAR = 2080;

const spanLabel = (y) => `${y}–${String((y + 1) % 100).padStart(2, "0")}`;

// view state <-> URL hash: #wages?s=15-1252&sl=…&st=CA&co=Santa Clara County
// ck is the era-stable county key (used by cross-links from the case
// explorer); ct is a raw city name fallback for pre-2025 New England, whose
// wage areas are towns rather than counties.
export function wagesHash(p = {}) {
  const q = new URLSearchParams();
  if (p.soc) q.set("s", p.soc);
  if (p.socLabel) q.set("sl", p.socLabel);
  if (p.st) q.set("st", p.st);
  if (p.county) q.set("co", p.county);
  if (p.ck) q.set("ck", p.ck);
  if (p.ct) q.set("ct", p.ct);
  if (p.src && p.src !== "alc") q.set("src", p.src);
  if (p.unit && p.unit !== "annual") q.set("u", p.unit);
  const s = q.toString();
  return "#wages" + (s ? "?" + s : "");
}

function wagesFromHash() {
  const h = window.location.hash;
  const q = new URLSearchParams(h.startsWith("#wages") ? h.split("?")[1] || "" : "");
  return {
    soc: q.get("s"), socLabel: q.get("sl") || q.get("s"),
    st: q.get("st"), county: q.get("co"),
    ck: q.get("ck"), ct: q.get("ct"),
    src: q.get("src") || "alc", unit: q.get("u") || "annual",
  };
}

// Generic combobox over an in-memory list: `filter(text)` returns items,
// `render(item)` a row, `onPick(item)` commits.
function Combo({ placeholder, value, filter, render, onPick, onClear }) {
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

  if (value) {
    return (
      <div className="wage-pick">
        <span className="chip">{value}
          <button aria-label="Clear" onClick={onClear}>×</button>
        </span>
      </div>
    );
  }
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

const norm = (s) => s.toLowerCase();

const MAX_PICKS = 25;
const HOURLY_TO_ANNUAL = (v, annual) =>
  v == null ? null : Math.round(annual ? v : v * HOURS_YEAR);

// Spreadsheet download of wage levels for ANY set of occupations × counties
// (the chart above only shows one pair at a time). Rows are the raw published
// values plus annualized columns; one row per wage year, occupation, county.
function WageExport({ manifest, index, src, initSoc, initPlace, filterOccs, filterPlaces, onError }) {
  const [open, setOpen] = useState(false);
  const [socs, setSocs] = useState([]);
  const [places, setPlaces] = useState([]);
  const [busy, setBusy] = useState(false);

  const show = () => {
    if (!open) {
      // seed with whatever is currently charted
      if (!socs.length && initSoc) setSocs([initSoc]);
      if (!places.length && initPlace?.key) setPlaces([initPlace]);
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
        {open ? "Close download ✕" : "⬇ Spreadsheet"}
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
              <Combo placeholder="Add an occupation…" value={null}
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
              <Combo placeholder="Add a county…" value={null}
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
  const [trend, setTrend] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = useRef(0);
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

  // labels can arrive via hash without the index; backfill them once it loads
  const socTitle = useMemo(() => {
    if (!state.soc) return null;
    return index?.occs.find((o) => o.code === state.soc)?.title
      ?? (state.socLabel !== state.soc ? state.socLabel : state.soc);
  }, [state.soc, state.socLabel, index]);
  const place = useMemo(() => {
    if (!state.st || (!state.county && !state.ck && !state.ct)) return null;
    const ps = index?.places;
    if (!ps) {
      return state.county ? { st: state.st, county: state.county, area_name: null } : null;
    }
    const squash = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const inSt = (f) => ps.find((p) => p.st === state.st && f(p));
    // town-name match first: for NE cities the town key carries the long
    // 2005–2024 series, the county key only 2025+
    return (state.ct && inSt((p) => p.key === squash(state.ct)))
      || (state.ck && inSt((p) => p.key === state.ck))
      || (state.county && inSt((p) => p.county === state.county))
      || (state.county ? { st: state.st, county: state.county, area_name: null } : null);
  }, [state.st, state.county, state.ck, state.ct, index]);

  useEffect(() => {
    if (!state.soc || !place) { setTrend(null); return; }
    if (!place.key) { if (index) setTrend([]); return; } // unknown place in the hash
    const id = ++run.current;
    const stale = () => id !== run.current;
    setBusy(true);
    fetchWageTrend(manifest, state.soc, place.st, place.key, state.src, stale)
      .then((rows) => { if (!stale()) { setTrend(rows); setBusy(false); } })
      .catch((e) => {
        if (isStale(e)) return;
        if (id === run.current) { onError(String(e)); setBusy(false); }
      });
  }, [manifest, state.soc, place, index, state.src]); // eslint-disable-line

  const filterOccs = (text) => {
    if (!index) return [];
    const t = norm(text.trim());
    const hit = t
      ? index.occs.filter((o) => norm(o.title).includes(t) || o.code.startsWith(t))
      : index.occs;
    return hit.slice(0, 20).map((o) => ({ ...o, key: o.code }));
  };
  const filterPlaces = (text) => {
    if (!index) return [];
    const t = norm(text.trim());
    const hit = t
      ? index.places.filter((p) =>
          norm(p.county).includes(t) || norm(p.state).includes(t)
          || norm(p.st) === t || norm(p.area_name).includes(t))
      : index.places;
    // counties whose name starts with the query first, then the rest
    const rank = (p) => (t && norm(p.county).startsWith(t) ? 0 : 1);
    return hit.map((p) => ({ ...p, key: `${p.st}|${p.county}` }))
      .sort((a, b) => rank(a) - rank(b)).slice(0, 20);
  };
  const coverage = (p) =>
    p.y0 === years[0] && p.y1 === years[years.length - 1]
      ? null : `${spanLabel(p.y0)} to ${spanLabel(p.y1)}`;

  // unit conversion: annual-basis rows already hold yearly figures
  const disp = (v, annual) => {
    if (v == null) return null;
    const yearly = annual ? v : v * HOURS_YEAR;
    return state.unit === "annual" ? Math.round(yearly) : Math.round((yearly / HOURS_YEAR) * 100) / 100;
  };
  const fmt = state.unit === "annual" ? fmtUsd : (v) => (v == null ? "–" : `$${v.toFixed(2)}`);

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
  const missing = state.soc && place && trend && years.filter((y) => !byYear.has(y));

  const ready = state.soc && place;
  return (
    <>
      <div className="wage-pickers">
        <Combo placeholder="Occupation — e.g. Software Developers, 15-1252"
          value={state.soc ? `${socTitle} (${state.soc})` : null}
          filter={filterOccs}
          render={(o) => (<>
            <span className="v">{o.title} <span className="code">{o.code}
              {o.in_alc && !o.in_edc ? " · all-industries table only"
                : o.in_edc && !o.in_alc ? " · ACWIA table only" : ""}</span></span>
          </>)}
          onPick={(o) => setState((s) => ({ ...s, soc: o.code, socLabel: o.title }))}
          onClear={() => setState((s) => ({ ...s, soc: null, socLabel: null }))} />
        <Combo placeholder="County — e.g. Santa Clara County, or a metro area name"
          value={place ? `${place.county}, ${place.st}` : null}
          filter={filterPlaces}
          render={(p) => (<>
            <span className="v">{p.county}, {p.st}
              <span className="code"> {p.area_name}{coverage(p) ? ` · ${coverage(p)}` : ""}</span>
            </span>
          </>)}
          onPick={(p) => setState((s) => ({ ...s, st: p.st, county: p.county, ck: p.key, ct: null }))}
          onClear={() => setState((s) => ({ ...s, st: null, county: null, ck: null, ct: null }))} />
      </div>

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
        {state.soc && (
          <button className="linkish" onClick={() => onOpenCases(
            index?.occs.find((o) => o.code === state.soc) ?? { code: state.soc },
            socTitle, place)}>
            Filings for this occupation{place?.key ? " here" : ""} →
          </button>
        )}
      </div>

      {index && (
        <WageExport manifest={manifest} index={index} src={state.src}
          initSoc={index.occs.find((o) => o.code === state.soc)}
          initPlace={place?.key ? place : null}
          filterOccs={filterOccs} filterPlaces={filterPlaces}
          onError={onError} />
      )}

      {!ready ? (
        <div className="panel wage-intro">
          <h2>Prevailing wage levels over time</h2>
          <p>
            Pick an occupation and a county to chart the OFLC wage library&apos;s four
            prevailing wage levels (plus the OEWS average) across every wage year
            {years.length ? ` (${spanLabel(years[0])} through ${spanLabel(years[years.length - 1])})` : ""} —
            no re-selecting criteria per data series. Wage years run July–June.
          </p>
        </div>
      ) : (
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
              {socTitle} — {place.county}, {place.st}
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
              const o = index?.occs.find((x) => x.code === state.soc);
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
    </>
  );
}
