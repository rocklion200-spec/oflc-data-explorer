import { useEffect, useMemo, useRef, useState } from "react";
import { loadManifest } from "./db.js";
import { scope, whereClause, fetchStats, fetchTrend, fetchTopEmployers, fetchRows, fetchOptions } from "./queries.js";
import { ProgramTabs, Filters } from "./components/Filters.jsx";
import { ResultsTable } from "./components/ResultsTable.jsx";
import { MonthlyLine, TopBars, fmtNum, fmtUsd } from "./components/charts.jsx";

const PAGE_SIZE = 50;
const EMPTY_FILTERS = { employer: "", jobTitle: "", soc: "", state: "", city: "", status: "", visaClass: "" };

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function App() {
  const [manifest, setManifest] = useState(null);
  const [error, setError] = useState(null);
  const [program, setProgram] = useState("lca");
  const [selectedYears, setSelectedYears] = useState(null); // null until manifest loads
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const debounced = useDebounced(filters, 350);

  const [options, setOptions] = useState({ states: [], statuses: [], visaClasses: [] });
  const [stats, setStats] = useState(null);
  const [trend, setTrend] = useState([]);
  const [top, setTop] = useState([]);
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState({ col: "decision_date", dir: "desc" });
  const [busy, setBusy] = useState(false);
  const runId = useRef(0);

  useEffect(() => {
    loadManifest().then(setManifest).catch((e) => setError(String(e)));
  }, []);

  const years = useMemo(() => {
    if (!manifest) return [];
    return (manifest.programs[program] || []).filter((f) => f.rows > 100).map((f) => f.fy);
  }, [manifest, program]);

  // default: most recent two fiscal years
  useEffect(() => {
    if (years.length) setSelectedYears(years.slice(-2));
  }, [program, manifest]); // eslint-disable-line

  // reset paging when inputs change
  useEffect(() => { setPage(0); }, [program, selectedYears, debounced, sort]);

  // filter options per program+years
  useEffect(() => {
    if (!manifest || !selectedYears) return;
    (async () => {
      const from = await scope(manifest, program, selectedYears);
      if (!from) return;
      const [states, statuses, visaClasses] = await Promise.all([
        fetchOptions(from, "worksite_state"),
        fetchOptions(from, "case_status"),
        fetchOptions(from, "visa_class"),
      ]);
      setOptions({ states, statuses, visaClasses });
    })().catch((e) => setError(String(e)));
  }, [manifest, program, selectedYears]);

  // main data fetch
  useEffect(() => {
    if (!manifest || !selectedYears) return;
    const id = ++runId.current;
    setBusy(true);
    (async () => {
      const from = await scope(manifest, program, selectedYears);
      if (!from) { setStats(null); setTrend([]); setTop([]); setRows([]); setBusy(false); return; }
      const where = whereClause(debounced);
      const [s, t, e] = [await fetchStats(from, where), await fetchTrend(from, where), await fetchTopEmployers(from, where)];
      if (id !== runId.current) return;
      setStats(s); setTrend(t); setTop(e);
      const r = await fetchRows(from, where, sort, page, PAGE_SIZE);
      if (id !== runId.current) return;
      setRows(r); setError(null); setBusy(false);
    })().catch((e) => { if (id === runId.current) { setError(String(e)); setBusy(false); } });
  }, [manifest, program, selectedYears, debounced, sort, page]);

  const switchProgram = (p) => { setProgram(p); setFilters(EMPTY_FILTERS); setSelectedYears(null); };

  if (error && !manifest) return <div className="status-line error">Failed to load: {error}</div>;
  if (!manifest || !selectedYears) return <div className="status-line">Loading datasets…</div>;

  return (
    <>
      <header className="app">
        <h1>OFLC Data Explorer</h1>
        <span className="sub">U.S. DOL foreign labor certification disclosure data</span>
      </header>

      <ProgramTabs programs={Object.keys(manifest.programs)} program={program} onChange={switchProgram} />

      <Filters years={years} selectedYears={selectedYears} onYears={(y) => y.length && setSelectedYears(y)}
        filters={filters} onFilters={setFilters} options={options} program={program} />

      <div className="status-line">{busy ? "Querying…" : error ? <span className="error">{error}</span> : ""}</div>

      <div className="tiles">
        <div className="tile"><div className="label">Records</div>
          <div className="value">{stats ? fmtNum(stats.n) : "–"}</div></div>
        <div className="tile"><div className="label">Employers</div>
          <div className="value">{stats ? fmtNum(stats.employers) : "–"}</div></div>
        <div className="tile"><div className="label">Median annual wage</div>
          <div className="value">{stats && stats.median_wage != null ? fmtUsd(stats.median_wage) : "–"}</div></div>
        <div className="tile"><div className="label">Certified</div>
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

      <div className="panel">
        <h2>Top employers (by record count)</h2>
        <TopBars data={top.map((d) => ({ label: d.employer_name, value: d.n, extra: d.median_wage }))}
          extraLabel="Median wage" />
      </div>

      <ResultsTable rows={rows} total={stats?.n ?? 0} page={page} pageSize={PAGE_SIZE}
        onPage={setPage} sort={sort} onSort={setSort} />

      <footer className="app">
        Source: <a href="https://www.dol.gov/agencies/eta/foreign-labor/performance" target="_blank" rel="noreferrer">
        DOL OFLC disclosure data</a>. Wages annualized from the reported unit of pay; implausible
        unit combinations are corrected or excluded. Queries run entirely in your browser via DuckDB-WASM.
      </footer>
    </>
  );
}
