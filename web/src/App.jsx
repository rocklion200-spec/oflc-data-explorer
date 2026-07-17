import { useEffect, useMemo, useRef, useState } from "react";
import { loadManifest, isStale } from "./db.js";
import {
  scope, whereClause, fetchStats, fetchTrend, fetchRows, fetchOptions,
  fetchSuggestions, hasAggregates, searchGroups, searchGroupsIn,
  fetchOverviewTop, fetchTopGroups,
} from "./queries.js";
import { ProgramTabs, Filters } from "./components/Filters.jsx";
import { ResultsTable, loadColumns } from "./components/ResultsTable.jsx";
import { MonthlyLine, TopBars, fmtNum, fmtUsd } from "./components/charts.jsx";
import { SearchHero, Chips } from "./components/SearchHero.jsx";
import { EntityPage } from "./components/EntityPage.jsx";

const PAGE_SIZE = 50;
const EMPTY_FILTERS = { employer: "", jobTitle: "", soc: "", state: "", city: "", status: "", visaClass: "" };
const EMPTY_SEL = { employer: null, soc: null, title: null, loc: null };

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
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [colFilters, setColFilters] = useState({});
  const [columns, setColumns] = useState(() => loadColumns("lca"));
  const [sel, setSel] = useState(selFromHash);
  const debounced = useDebounced(filters, 350);
  const debouncedColFilters = useDebounced(colFilters, 350);

  const [options, setOptions] = useState({ states: [], statuses: [], visaClasses: [] });
  const [overview, setOverview] = useState({ employers: [], soc: [] });
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

  const selCount = Object.values(sel).filter(Boolean).length;
  const soleDim = selCount === 1
    ? Object.keys(sel).find((d) => sel[d]) : null;
  const mode = selCount === 0 ? "home"
    : soleDim && soleDim !== "loc" ? "entity" : "drill";

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
  useEffect(() => { setPage(0); }, [program, selectedYears, debounced, debouncedColFilters, sort, sel]);

  // selection helpers
  const addSel = (dim, v) => setSel((s) => ({ ...s, [dim]: v }));
  const selectOnly = (dim, k, label) => setSel({ ...EMPTY_SEL, [dim]: { k, label } });
  const removeSel = (dim) => setSel((s) => ({ ...s, [dim]: null }));

  // landing overview (cube-backed, filter-independent)
  useEffect(() => {
    if (!manifest || !hasAggregates(manifest)) return;
    (async () => {
      const employers = await fetchOverviewTop(manifest, "employers_top");
      const soc = await fetchOverviewTop(manifest, "soc_top");
      setOverview({ employers, soc });
    })().catch((e) => setError(String(e)));
  }, [manifest]);

  // filter options: derived from the two most recent years (values are stable
  // across years; scanning the full range over HTTP would be wasteful)
  useEffect(() => {
    if (!manifest || !years.length) return;
    (async () => {
      const from = await scope(manifest, program, years.slice(-2));
      if (!from) return;
      const [states, statuses, visaClasses] = await Promise.all([
        fetchOptions(from, "worksite_state"),
        fetchOptions(from, "case_status"),
        fetchOptions(from, "visa_class"),
      ]);
      setOptions({ states, statuses, visaClasses });
    })().catch((e) => setError(String(e)));
  }, [manifest, program, years]);

  // row-level charts for the current mode: which "top N" panels to fetch
  const drillCharts = useMemo(() => {
    const c = [];
    if (mode === "home" || (mode === "drill" && !sel.employer)) {
      c.push({ id: "employer", title: "Top employers", col: "employer_group",
        labelExpr: "employer_group",
        pick: (r) => addSel("employer", { k: r.k, label: r.label }) });
    }
    if (mode === "drill" && !sel.soc) {
      c.push({ id: "soc", title: "Top roles", col: "soc_group",
        labelExpr: "mode(soc_title)",
        pick: (r) => addSel("soc", { k: r.k, label: r.label }) });
    }
    if (mode === "drill" && !sel.title) {
      c.push({ id: "title", title: "Top job titles", col: "title_group",
        labelExpr: `coalesce(mode(job_title) FILTER (upper(trim(job_title)) = title_group
                    AND trim(job_title) <> upper(trim(job_title))), title_group)`,
        pick: (r) => addSel("title", { k: r.k, label: r.label }) });
    }
    if (mode === "drill" && !sel.loc) {
      c.push({ id: "loc", title: "Top cities",
        col: "upper(trim(worksite_city)) || '|' || worksite_state",
        labelExpr: "mode(worksite_city || ', ' || worksite_state)",
        pick: (r) => {
          const [cityKey, state] = r.k.split("|");
          addSel("loc", { state, cityKey, label: r.label });
        } });
    }
    return c;
  }, [mode, sel]); // eslint-disable-line

  // aggregates (tiles + charts): refetched when scope, filters or drill change
  useEffect(() => {
    if (!manifest || !selectedYears) return;
    const id = ++aggRun.current;
    const stale = () => id !== aggRun.current;
    setAggBusy(true);
    (async () => {
      const from = await scope(manifest, program, selectedYears);
      if (stale()) return;
      if (!from) { setStats(null); setTrend([]); setTops({}); setAggBusy(false); return; }
      const where = whereClause(debounced, debouncedColFilters, sel);
      const s = await fetchStats(from, where, stale);
      if (stale()) return;
      setStats(s);
      if (mode !== "entity") {
        const t = await fetchTrend(from, where, stale);
        if (stale()) return;
        setTrend(t);
        for (const c of drillCharts) {
          const rows = await fetchTopGroups(from, where, c.col, c.labelExpr, stale);
          if (stale()) return;
          setTops((prev) => ({ ...prev, [c.id]: rows }));
        }
      }
      setError(null); setAggBusy(false);
    })().catch((e) => {
      if (isStale(e)) return;
      if (id === aggRun.current) { setError(String(e)); setAggBusy(false); }
    });
  }, [manifest, program, selectedYears, debounced, debouncedColFilters, sel, mode]); // eslint-disable-line

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
      const where = whereClause(debounced, debouncedColFilters, sel);
      const r = await fetchRows(from, where, sort, page, PAGE_SIZE, stale);
      if (stale()) return;
      setRows(r); setError(null); setRowsBusy(false);
    })().catch((e) => {
      if (isStale(e)) return;
      if (id === rowsRun.current) { setError(String(e)); setRowsBusy(false); }
    });
  }, [manifest, program, selectedYears, debounced, debouncedColFilters, sel, sort, page]);

  // filter autocompletes: group suggestions for employer/role/title fields,
  // row-level distinct values for the rest
  const GROUP_FIELDS = { employer: "employer", soc: "soc", jobTitle: "title" };
  const suggest = async (field, col, text, staleFn) => {
    if (GROUP_FIELDS[field] && hasAggregates(manifest)) {
      return searchGroupsIn(manifest, GROUP_FIELDS[field], text.trim(), staleFn);
    }
    const from = await scope(manifest, program, selectedYears);
    if (!from || staleFn()) return [];
    const where = whereClause({ ...filters, [field]: "" }, colFilters, sel);
    return fetchSuggestions(from, where, col, text.trim(), staleFn);
  };
  const pickGroup = (field, item) => {
    if (GROUP_FIELDS[field] && item.k != null) {
      addSel(GROUP_FIELDS[field], { k: item.k, label: item.label });
      setFilters((f) => ({ ...f, [field]: "" }));
    } else {
      setFilters((f) => ({ ...f, [field]: item.v })); // raw-value suggestion
    }
  };

  const switchProgram = (p) => {
    setProgram(p); setFilters(EMPTY_FILTERS); setColFilters({});
    setColumns(loadColumns(p)); setSelectedYears(null);
  };

  const busy = rowsBusy || aggBusy;

  if (error && !manifest) return <div className="status-line error">Failed to load: {error}</div>;
  if (!manifest || !selectedYears) return <div className="status-line">Loading datasets…</div>;

  const searchable = hasAggregates(manifest);

  return (
    <>
      <header className="app">
        <h1>OFLC Data Explorer</h1>
        <span className="sub">U.S. DOL foreign labor certification disclosure data</span>
      </header>

      {searchable && (
        <SearchHero
          search={(text, stale) => searchGroups(manifest, text, stale)}
          onPick={selectOnly} />
      )}
      <Chips sel={sel} onRemove={removeSel} onClear={() => setSel(EMPTY_SEL)} />

      {mode === "home" && searchable && (
        <div className="charts">
          <div className="panel">
            <h2>Top employers — all programs, all years</h2>
            <TopBars extraLabel="Median wage"
              data={overview.employers.map((d) => ({ label: d.label, value: d.n, extra: d.median_wage, row: d }))}
              onPick={(d) => selectOnly("employer", d.row.k, d.row.label)} />
          </div>
          <div className="panel">
            <h2>Top roles — all programs, all years</h2>
            <TopBars extraLabel="Median wage"
              data={overview.soc.map((d) => ({ label: d.label, value: d.n, extra: d.median_wage, row: d }))}
              onPick={(d) => selectOnly("soc", d.row.k, d.row.label)} />
          </div>
        </div>
      )}

      {mode === "entity" && (
        <EntityPage manifest={manifest} dim={soleDim} sel={sel[soleDim]}
          onDrill={addSel} onError={setError} />
      )}

      <div className="records-head">
        <h2>{mode === "home" ? "Explore records" : "Matching records"}</h2>
        <span className="sub">
          {mode === "home"
            ? "Filter the raw filings below, or search above to drill into an employer, role or title."
            : "Raw filings for the current selection. Narrow further with the filters."}
        </span>
      </div>

      <ProgramTabs programs={Object.keys(manifest.programs)} program={program} onChange={switchProgram} />

      <Filters years={years} selectedYears={selectedYears} onYears={(y) => y.length && setSelectedYears(y)}
        filters={filters} onFilters={setFilters} options={options} program={program}
        suggest={suggest} onPickGroup={pickGroup} />

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

          <div className={drillCharts.length > 1 ? "charts" : ""}>
            {drillCharts.map((c) => (
              <div className="panel" key={c.id}>
                <h2>{c.title} (by record count)</h2>
                <TopBars extraLabel="Median wage"
                  data={(tops[c.id] ?? []).map((d) => ({ label: d.label ?? d.k, value: d.n, extra: d.median_wage, row: d }))}
                  onPick={(d) => c.pick(d.row)} />
              </div>
            ))}
          </div>
        </>
      )}

      <ResultsTable program={program} rows={rows} total={stats?.n ?? 0} page={page} pageSize={PAGE_SIZE}
        onPage={setPage} sort={sort} onSort={setSort}
        columns={columns} onColumns={setColumns}
        colFilters={colFilters} onColFilters={setColFilters} />

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
