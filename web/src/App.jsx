import { useEffect, useMemo, useRef, useState } from "react";
import { loadManifest, isStale } from "./db.js";
import {
  scope, whereClause, fetchStats, fetchTrend, fetchRows, fetchColumnValues,
  hasAggregates, searchGroups, fetchOverviewTop, fetchTopGroups, fetchEntityTop,
} from "./queries.js";
import { ProgramTabs, YearRange } from "./components/Filters.jsx";
import { ResultsTable, loadColumns } from "./components/ResultsTable.jsx";
import { MonthlyLine, TopBars, fmtNum, fmtUsd } from "./components/charts.jsx";
import { SearchHero, Chips } from "./components/SearchHero.jsx";
import { EntityPage } from "./components/EntityPage.jsx";

const PAGE_SIZE = 50;
const EMPTY_SEL = { employer: null, soc: null, title: null, loc: null };

const DIMS = ["employer", "soc", "title", "loc"];
const TOP_TITLES = {
  employer: "Top employers", soc: "Top roles",
  title: "Top job titles", loc: "Top locations",
};
// cube files backing the top charts when they can (landing page and single
// selection); anything else falls back to row-level queries
const OVERVIEW_FILES = { employer: "employers_top", soc: "soc_top", loc: "locations_top" };
const ENTITY_CUBES = {
  employer: { soc: "emp_soc", title: "emp_title", loc: "emp_loc" },
  soc: { employer: "soc_emp", loc: "soc_loc" },
  title: { employer: "title_emp" },
};
// row-level top-N spec per dimension; labelExpr turns group keys into labels
const ROW_CHARTS = {
  employer: { col: "employer_group", labelExpr: "employer_group" },
  soc: { col: "soc_group", labelExpr: "mode(soc_title)" },
  title: {
    col: "title_group",
    labelExpr: `coalesce(mode(job_title) FILTER (upper(trim(job_title)) = title_group
                AND trim(job_title) <> upper(trim(job_title))), title_group)`,
  },
  loc: {
    col: "upper(trim(worksite_city)) || '|' || worksite_state",
    labelExpr: "mode(worksite_city || ', ' || worksite_state)",
  },
};

// 'CITYKEY|ST' (city) or bare 'ST' (statewide) -> loc selection
const locSelFromKey = (k, label) => {
  const [a, b] = k.split("|");
  return b === undefined ? { state: a, cityKey: null, label }
    : { state: b, cityKey: a, label };
};

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// selection <-> URL hash (shareable drill-down links)
function selToHash(sel) {
  const p = new URLSearchParams();
  if (sel.employer) { p.set("e", sel.employer.k); p.set("el", sel.employer.label); }
  if (sel.soc) { p.set("s", sel.soc.k); p.set("sl", sel.soc.label); }
  if (sel.title) { p.set("t", sel.title.k); p.set("tl", sel.title.label); }
  if (sel.loc) {
    p.set("lst", sel.loc.state);
    if (sel.loc.cityKey) p.set("lc", sel.loc.cityKey);
    p.set("ll", sel.loc.label);
  }
  const s = p.toString();
  return s ? `#${s}` : "";
}

function selFromHash() {
  const p = new URLSearchParams(window.location.hash.slice(1));
  const sel = { ...EMPTY_SEL };
  if (p.get("e")) sel.employer = { k: p.get("e"), label: p.get("el") || p.get("e") };
  if (p.get("s")) sel.soc = { k: p.get("s"), label: p.get("sl") || p.get("s") };
  if (p.get("t")) sel.title = { k: p.get("t"), label: p.get("tl") || p.get("t") };
  if (p.get("lst")) sel.loc = {
    state: p.get("lst"), cityKey: p.get("lc") || null,
    label: p.get("ll") || [p.get("lc"), p.get("lst")].filter(Boolean).join(", "),
  };
  return sel;
}

export default function App() {
  const [manifest, setManifest] = useState(null);
  const [error, setError] = useState(null);
  const [program, setProgram] = useState("lca");
  const [selectedYears, setSelectedYears] = useState(null); // null until manifest loads
  const [colFilters, setColFilters] = useState({});
  const [columns, setColumns] = useState(() => loadColumns("lca"));
  const [sel, setSel] = useState(selFromHash);
  const debouncedColFilters = useDebounced(colFilters, 350);

  const [stats, setStats] = useState(null);
  const [trend, setTrend] = useState([]);
  const [tops, setTops] = useState({});
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState({ col: "decision_date", dir: "desc" });
  const [rowsBusy, setRowsBusy] = useState(false);
  const [aggBusy, setAggBusy] = useState(false);
  const rowsRun = useRef(0);
  const aggRun = useRef(0);
  const topsRun = useRef(0);

  const selCount = Object.values(sel).filter(Boolean).length;
  const soleDim = selCount === 1
    ? Object.keys(sel).find((d) => sel[d]) : null;
  const mode = selCount === 0 ? "home"
    : soleDim && soleDim !== "loc" ? "entity" : "drill";

  // top charts show every unselected dimension; job titles only join in once
  // something is selected (rarely the first thing people filter by)
  const topDims = DIMS.filter((d) => !sel[d] && (selCount > 0 || d !== "title"));

  useEffect(() => {
    loadManifest().then(setManifest).catch((e) => setError(String(e)));
  }, []);

  // keep URL hash and back button in sync with the selection
  const fromPop = useRef(false);
  useEffect(() => {
    const onPop = () => { fromPop.current = true; setSel(selFromHash()); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    if (fromPop.current) { fromPop.current = false; return; }
    const hash = selToHash(sel);
    if (hash !== window.location.hash) {
      history.pushState(null, "", hash || window.location.pathname + window.location.search);
    }
  }, [sel]);

  const years = useMemo(() => {
    if (!manifest) return [];
    return (manifest.programs[program] || []).filter((f) => f.rows > 100).map((f) => f.fy);
  }, [manifest, program]);

  // Year default for the records section: all years when an employer group is
  // selected (row files are sorted by employer_group, so those queries prune
  // to a few row groups per file); otherwise the last two years — role/title
  // predicates can't prune, and a full-history scan over HTTP would be slow.
  // Entity-page charts always cover all years regardless (cube-backed).
  useEffect(() => {
    if (years.length) setSelectedYears(sel.employer ? years : years.slice(-2));
  }, [program, manifest]); // eslint-disable-line
  const prevYearKey = useRef(null);
  useEffect(() => {
    if (!years.length) return;
    const key = sel.employer ? "emp" : selCount ? "other" : "none";
    if (prevYearKey.current === key) return;
    prevYearKey.current = key;
    setSelectedYears(key === "emp" ? years : years.slice(-2));
  }, [sel, selCount, years]); // eslint-disable-line

  // reset paging when inputs change
  useEffect(() => { setPage(0); }, [program, selectedYears, debouncedColFilters, sort, sel]);

  // selection helpers: search picks and chart clicks ADD to the selection
  const addSel = (dim, v) => setSel((s) => ({ ...s, [dim]: v }));
  const removeSel = (dim) => setSel((s) => ({ ...s, [dim]: null }));
  const pickFromSearch = (dim, k, label) => {
    if (dim === "loc") addSel("loc", locSelFromKey(k, label));
    else addSel(dim, { k, label });
  };

  // top charts: cube-backed where a precomputed file covers the current
  // selection (landing page, single-entity pages), row-level otherwise
  useEffect(() => {
    if (!manifest || !selectedYears) return;
    const id = ++topsRun.current;
    const stale = () => id !== topsRun.current;
    setTops({});
    (async () => {
      const cubes = hasAggregates(manifest);
      const cubeDim = selCount === 1 && soleDim !== "loc" && cubes ? soleDim : null;
      let from = null, where = "";
      for (const dim of topDims) {
        let entry;
        if (selCount === 0 && cubes && OVERVIEW_FILES[dim]) {
          const r = await fetchOverviewTop(manifest, OVERVIEW_FILES[dim], stale, 12,
            dim === "loc" ? "city_key IS NOT NULL" : null);
          entry = { scope: "cube", rows: r.map((d) => ({
            label: d.label, n: d.n, median_wage: d.median_wage,
            sel: dim === "loc" ? { state: d.state, cityKey: d.city_key, label: d.label }
              : { k: d.k, label: d.label },
          })) };
        } else if (cubeDim && ENTITY_CUBES[cubeDim]?.[dim]) {
          const r = await fetchEntityTop(manifest, ENTITY_CUBES[cubeDim][dim],
            sel[cubeDim].k, stale);
          entry = { scope: "cube", rows: r.map((d) => ({
            label: d.label2, n: d.n, median_wage: d.median_wage,
            sel: dim === "loc" ? { state: d.state, cityKey: d.city_key, label: d.label2 }
              : { k: d.k2, label: d.label2 },
          })) };
        } else {
          if (from == null) {
            from = (await scope(manifest, program, selectedYears)) || "";
            if (stale()) return;
            where = whereClause(debouncedColFilters, sel);
          }
          const spec = ROW_CHARTS[dim];
          const r = from
            ? await fetchTopGroups(from, where, spec.col, spec.labelExpr, stale) : [];
          entry = { scope: "rows", rows: r.map((d) => ({
            label: d.label ?? d.k, n: d.n, median_wage: d.median_wage,
            sel: dim === "loc" ? locSelFromKey(d.k, d.label ?? d.k)
              : { k: d.k, label: d.label ?? d.k },
          })) };
        }
        if (stale()) return;
        setTops((t) => ({ ...t, [dim]: entry }));
      }
    })().catch((e) => {
      if (!isStale(e) && id === topsRun.current) setError(String(e));
    });
  }, [manifest, program, selectedYears, debouncedColFilters, sel]); // eslint-disable-line

  // aggregates (tiles + trend): refetched when scope, filters or drill change
  useEffect(() => {
    if (!manifest || !selectedYears) return;
    const id = ++aggRun.current;
    const stale = () => id !== aggRun.current;
    setAggBusy(true);
    (async () => {
      const from = await scope(manifest, program, selectedYears);
      if (stale()) return;
      if (!from) { setStats(null); setTrend([]); setAggBusy(false); return; }
      const where = whereClause(debouncedColFilters, sel);
      const s = await fetchStats(from, where, stale);
      if (stale()) return;
      setStats(s);
      if (mode !== "entity") {
        const t = await fetchTrend(from, where, stale);
        if (stale()) return;
        setTrend(t);
      }
      setError(null); setAggBusy(false);
    })().catch((e) => {
      if (isStale(e)) return;
      if (id === aggRun.current) { setError(String(e)); setAggBusy(false); }
    });
  }, [manifest, program, selectedYears, debouncedColFilters, sel, mode]); // eslint-disable-line

  // table rows: also refetched on sort/page, without redoing the aggregates
  useEffect(() => {
    if (!manifest || !selectedYears) return;
    const id = ++rowsRun.current;
    const stale = () => id !== rowsRun.current;
    setRowsBusy(true);
    (async () => {
      const from = await scope(manifest, program, selectedYears);
      if (stale()) return;
      if (!from) { setRows([]); setRowsBusy(false); return; }
      const where = whereClause(debouncedColFilters, sel);
      const r = await fetchRows(from, where, sort, page, PAGE_SIZE, stale);
      if (stale()) return;
      setRows(r); setError(null); setRowsBusy(false);
    })().catch((e) => {
      if (isStale(e)) return;
      if (id === rowsRun.current) { setError(String(e)); setRowsBusy(false); }
    });
  }, [manifest, program, selectedYears, debouncedColFilters, sel, sort, page]);

  // Excel-style column filter dropdowns: distinct values of the column under
  // every OTHER active filter, most frequent first
  const fetchColValues = async (col, text, staleFn) => {
    const from = await scope(manifest, program, selectedYears);
    if (!from || staleFn()) return [];
    const rest = { ...colFilters };
    delete rest[col];
    const where = whereClause(rest, sel);
    return fetchColumnValues(from, where, col, text.trim(), staleFn);
  };

  const switchProgram = (p) => {
    setProgram(p); setColFilters({});
    setColumns(loadColumns(p)); setSelectedYears(null);
  };

  const busy = rowsBusy || aggBusy;

  if (error && !manifest) return <div className="status-line error">Failed to load: {error}</div>;
  if (!manifest || !selectedYears) return <div className="status-line">Loading datasets…</div>;

  const searchable = hasAggregates(manifest);

  const topCharts = topDims.length > 0 && (
    <div className="top-charts">
      {topDims.map((dim) => {
        const t = tops[dim];
        return (
          <div className="panel" key={dim}>
            <h2>{TOP_TITLES[dim]}
              <span className="scope-note">
                {t?.scope === "rows" ? "current records" : "all programs & years"}
              </span>
            </h2>
            {t ? (
              <TopBars extraLabel="Median wage"
                data={t.rows.map((r) => ({ label: r.label, value: r.n, extra: r.median_wage, row: r }))}
                onPick={(d) => addSel(dim, d.row.sel)} />
            ) : <div className="chart-note">Loading…</div>}
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      <header className="app">
        <h1>OFLC Data Explorer</h1>
        <span className="sub">U.S. DOL foreign labor certification disclosure data</span>
      </header>

      {searchable && (
        <SearchHero
          search={(text, stale) => searchGroups(manifest, text, stale)}
          onPick={pickFromSearch} />
      )}
      <Chips sel={sel} onRemove={removeSel} onClear={() => setSel(EMPTY_SEL)} />

      {mode === "entity" ? (
        <EntityPage manifest={manifest} dim={soleDim} sel={sel[soleDim]} onError={setError}>
          {topCharts}
        </EntityPage>
      ) : topCharts}

      <div className="records-head">
        <h2>{mode === "home" ? "Explore records" : "Matching records"}</h2>
        <span className="sub">
          {mode === "home"
            ? "Search above or click a chart to drill in; filter the raw filings directly in the table."
            : "Raw filings for the current selection. Narrow further with the column filters."}
        </span>
      </div>

      <ProgramTabs programs={Object.keys(manifest.programs)} program={program} onChange={switchProgram} />

      <div className="panel year-panel">
        <YearRange years={years} selectedYears={selectedYears}
          onYears={(y) => y.length && setSelectedYears(y)} />
      </div>

      <div className="status-line">{busy ? "Querying…" : error ? <span className="error">{error}</span> : ""}</div>

      {mode !== "entity" && (
        <>
          <div className="tiles">
            <div className="tile"><div className="label">Records</div>
              <div className="value">{stats ? fmtNum(stats.n) : "–"}</div></div>
            <div className="tile"><div className="label">Employers</div>
              <div className="value">{stats ? fmtNum(stats.employers) : "–"}</div></div>
            <div className="tile"><div className="label">Median annual wage</div>
              <div className="value">{stats && stats.median_wage != null ? fmtUsd(stats.median_wage) : "–"}</div></div>
            <div className="tile"><div className="label">{program === "pwd" ? "Determinations issued" : "Certified"}</div>
              <div className="value">{stats && stats.pct_certified != null ? `${stats.pct_certified}%` : "–"}</div></div>
          </div>

          <div className="charts">
            <div className="panel">
              <h2>Applications per month (by decision date)</h2>
              <MonthlyLine data={trend.map((d) => ({ month: d.month, value: d.n }))} valueLabel="Records" />
            </div>
            <div className="panel">
              <h2>Median annual wage per month</h2>
              <MonthlyLine data={trend.map((d) => ({ month: d.month, value: d.median_wage }))}
                valueFmt={fmtUsd} valueLabel="Median wage" />
            </div>
          </div>
        </>
      )}

      <ResultsTable program={program} rows={rows} total={stats?.n ?? 0} page={page} pageSize={PAGE_SIZE}
        onPage={setPage} sort={sort} onSort={setSort}
        columns={columns} onColumns={setColumns}
        colFilters={colFilters} onColFilters={setColFilters}
        fetchColValues={fetchColValues} />

      <footer className="app">
        Source: <a href="https://www.dol.gov/agencies/eta/foreign-labor/performance" target="_blank" rel="noreferrer">
        DOL OFLC disclosure data</a>. Wages annualized from the reported unit of pay; implausible
        unit combinations are corrected or excluded. Employers, roles and job titles are grouped
        across name variants, subsidiaries and SOC vintages; grouping is heuristic and editable
        in the pipeline. Queries run entirely in your browser via DuckDB-WASM.
      </footer>
    </>
  );
}
