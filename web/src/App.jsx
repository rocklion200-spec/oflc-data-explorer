import { useEffect, useMemo, useRef, useState } from "react";
import { loadManifest, isStale } from "./db.js";
import { initCache } from "./cache.js";
import {
  scope, whereClause, fetchOverview, fetchRows, fetchColumnValues,
  hasAggregates, searchGroups, fetchOverviewTop, fetchTopGroupsMulti,
  fetchEntityTop, fetchProgramStats, fetchEntityCount, hasWages,
} from "./queries.js";
import { WagesPage, wagesHash } from "./components/WagesPage.jsx";
import { ProgramTabs, YearRange } from "./components/Filters.jsx";
import { ResultsTable, loadColumns } from "./components/ResultsTable.jsx";
import { WageDistribution, TopBars, fmtNum, fmtUsd } from "./components/charts.jsx";
import { SearchHero, Chips } from "./components/SearchHero.jsx";
import { EntityPage } from "./components/EntityPage.jsx";

const PAGE_SIZE = 50;
const EMPTY_SEL = { employer: null, soc: null, title: null, loc: null };

// top charts show TOP_N rows; "Show more" reveals up to TOP_N_FULL in a
// scrollable panel (data is fetched at TOP_N_FULL up front, so expanding is
// instant everywhere except the landing page, whose inlined tops carry TOP_N)
const TOP_N = 12;
const TOP_N_FULL = 50;

// default record order until a column header is clicked; begin_date only
// exists on LCA filings
const DEFAULT_SORT = { col: "received_date", dir: "desc" };
const defaultOrder = (program) => [
  DEFAULT_SORT,
  ...(program === "lca" ? [{ col: "begin_date", dir: "desc" }] : []),
  { col: "decision_date", dir: "desc" },
];

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
  // two top-level views share the URL hash: the case explorer's drill
  // selection (#e=…) and the wage-levels lookup (#wages?…)
  const [view, setView] = useState(() =>
    window.location.hash.startsWith("#wages") ? "wages" : "cases");
  const lastWagesHash = useRef(null);
  const [program, setProgram] = useState("lca");
  const [selectedYears, setSelectedYears] = useState(null); // null until manifest loads
  const [colFilters, setColFilters] = useState({});
  const [columns, setColumns] = useState(() => loadColumns("lca"));
  const [sel, setSel] = useState(selFromHash);
  const debouncedColFilters = useDebounced(colFilters, 350);

  const [stats, setStats] = useState(null);
  const [wages, setWages] = useState([]);
  const [tops, setTops] = useState({});
  const [topsBusy, setTopsBusy] = useState(false);
  const [expanded, setExpanded] = useState({}); // per-dim "Show more" state
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState(null); // null -> program default order
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
    loadManifest()
      .then((m) => { initCache(m); setManifest(m); })
      .catch((e) => setError(String(e)));
  }, []);

  // keep URL hash and back button in sync with the selection
  const fromPop = useRef(false);
  useEffect(() => {
    const onPop = () => {
      const wages = window.location.hash.startsWith("#wages");
      setView(wages ? "wages" : "cases");
      if (wages) lastWagesHash.current = window.location.hash;
      else { fromPop.current = true; setSel(selFromHash()); }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    if (view === "wages") return; // WagesPage owns the hash there
    if (fromPop.current) { fromPop.current = false; return; }
    const hash = selToHash(sel);
    if (hash !== window.location.hash) {
      history.pushState(null, "", hash || window.location.pathname + window.location.search);
    }
  }, [sel, view]);

  // view switching pushes the target view's hash itself; a role link keeps
  // the county/source/unit from the last wage-view visit
  const openWages = (params) => {
    let hash = lastWagesHash.current || wagesHash();
    if (params) {
      const prev = new URLSearchParams((lastWagesHash.current || "").split("?")[1] || "");
      hash = wagesHash({
        st: prev.get("st"), county: prev.get("co"),
        src: prev.get("src"), unit: prev.get("u"), ...params,
      });
    }
    history.pushState(null, "", hash);
    setView("wages");
  };
  const openCases = (nextSel) => {
    if (window.location.hash.startsWith("#wages")) {
      lastWagesHash.current = window.location.hash;
    }
    const s = nextSel ?? sel;
    fromPop.current = true; // hash is pushed here, not by the sel effect
    history.pushState(null, "", selToHash(s)
      || window.location.pathname + window.location.search);
    if (nextSel) setSel(nextSel);
    setView("cases");
  };

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

  // overview-cube (and landing-JSON) rows share one shape -> chart entry
  const cubeRow = (dim) => (d) => ({
    label: d.label, n: d.n, median_wage: d.median_wage,
    sel: dim === "loc" ? { state: d.state, cityKey: d.city_key, label: d.label }
      : { k: d.k, label: d.label },
  });

  // top charts: cube-backed where a precomputed file covers the current
  // selection (landing page, single-entity pages), row-level otherwise
  useEffect(() => {
    if (!manifest || !selectedYears) return;
    const id = ++topsRun.current;
    const stale = () => id !== topsRun.current;
    // the landing page's charts ship inside datasets.json — render them
    // synchronously, before DuckDB has even booted; `full: false` marks them
    // as TOP_N-deep so "Show more" knows to pull TOP_N_FULL from the cubes
    if (selCount === 0 && manifest.landing) {
      const entries = {};
      for (const dim of topDims) {
        entries[dim] = { scope: "cube", full: false,
          rows: (manifest.landing.tops[dim] || []).map(cubeRow(dim)) };
      }
      setTops((t) => ({ ...t, ...entries }));
      setTopsBusy(false);
      return;
    }
    // keep the previous charts visible (dimmed) while refetching so the page
    // doesn't collapse and shift under an open column-filter dropdown
    setTopsBusy(true);
    (async () => {
      const cubes = hasAggregates(manifest);
      const cubeDim = selCount === 1 && soleDim !== "loc" && cubes ? soleDim : null;
      const rowDims = [];
      for (const dim of topDims) {
        let entry;
        if (selCount === 0 && cubes && OVERVIEW_FILES[dim]) {
          const r = await fetchOverviewTop(manifest, OVERVIEW_FILES[dim], stale, TOP_N_FULL,
            dim === "loc" ? "city_key IS NOT NULL" : null);
          entry = { scope: "cube", full: true, rows: r.map(cubeRow(dim)) };
        } else if (cubeDim && ENTITY_CUBES[cubeDim]?.[dim]) {
          const r = await fetchEntityTop(manifest, ENTITY_CUBES[cubeDim][dim],
            sel[cubeDim].k, stale, TOP_N_FULL);
          entry = { scope: "cube", full: true, rows: r.map((d) => ({
            label: d.label2, n: d.n, median_wage: d.median_wage,
            sel: dim === "loc" ? { state: d.state, cityKey: d.city_key, label: d.label2 }
              : { k: d.k2, label: d.label2 },
          })) };
        } else {
          rowDims.push(dim);
          continue;
        }
        if (stale()) return;
        setTops((t) => ({ ...t, [dim]: entry }));
      }
      // all remaining dimensions come out of one row-level scan
      if (rowDims.length) {
        const from = (await scope(manifest, program, selectedYears)) || "";
        if (stale()) return;
        const where = whereClause(debouncedColFilters, sel);
        const res = from
          ? await fetchTopGroupsMulti(from, where,
              rowDims.map((dim) => ({ dim, ...ROW_CHARTS[dim] })), stale, TOP_N_FULL)
          : {};
        if (stale()) return;
        for (const dim of rowDims) {
          const entry = { scope: "rows", full: true, rows: (res[dim] || []).map((d) => ({
            label: d.label ?? d.k, n: d.n, median_wage: d.median_wage,
            sel: dim === "loc" ? locSelFromKey(d.k, d.label ?? d.k)
              : { k: d.k, label: d.label ?? d.k },
          })) };
          setTops((t) => ({ ...t, [dim]: entry }));
        }
      }
      if (!stale()) setTopsBusy(false);
    })().catch((e) => {
      if (isStale(e)) return;
      if (id === topsRun.current) { setError(String(e)); setTopsBusy(false); }
    });
  }, [manifest, program, selectedYears, debouncedColFilters, sel]); // eslint-disable-line

  // landing charts ship only TOP_N rows inside datasets.json; the first
  // "Show more" on one of them upgrades that chart to TOP_N_FULL from the
  // cube files (marked full so this doesn't loop)
  const expandRun = useRef(0);
  useEffect(() => {
    if (!manifest || selCount !== 0 || !hasAggregates(manifest)) return;
    const id = ++expandRun.current;
    const tid = topsRun.current;
    const stale = () => id !== expandRun.current || tid !== topsRun.current;
    for (const dim of DIMS) {
      if (!expanded[dim] || !tops[dim] || tops[dim].full || !OVERVIEW_FILES[dim]) continue;
      fetchOverviewTop(manifest, OVERVIEW_FILES[dim], stale, TOP_N_FULL,
        dim === "loc" ? "city_key IS NOT NULL" : null)
        .then((r) => {
          if (stale()) return;
          setTops((t) => ({ ...t, [dim]: { scope: "cube", full: true, rows: r.map(cubeRow(dim)) } }));
        })
        .catch((e) => { if (!isStale(e) && !stale()) setError(String(e)); });
    }
  }, [manifest, expanded, tops, selCount]); // eslint-disable-line

  // aggregates (tiles + trend): refetched when scope, filters or drill change
  useEffect(() => {
    if (!manifest || !selectedYears) return;
    const id = ++aggRun.current;
    const stale = () => id !== aggRun.current;
    setAggBusy(true);
    (async () => {
      const cubes = hasAggregates(manifest);
      const unfiltered = whereClause(debouncedColFilters, {}) === "";
      // Cube fast paths (no column filters): the landing page reads tiles and
      // the wage chart out of the tiny program_stats file, and entity pages
      // get the table's record count from the summary cube — no row scans.
      let cubeWages = null;
      if (unfiltered && cubes && mode === "home"
          && (manifest.landing?.stats || manifest.aggregates.program_stats)) {
        // stats ship inside datasets.json (landing); parquet is the fallback
        const all = manifest.landing?.stats || await fetchProgramStats(manifest);
        if (stale()) return;
        if (all) {
          const lo = Math.min(...selectedYears), hi = Math.max(...selectedYears);
          const mine = all.filter((r) => r.program === program);
          cubeWages = mine
            .filter((r) => r.fy_lo === r.fy_hi && r.fy_lo >= lo && r.fy_hi <= hi && r.nw > 0)
            .map((r) => ({ fy: r.fy_lo, ...r, n: r.nw }));
          const exact = mine.find((r) => r.fy_lo === lo && r.fy_hi === hi);
          if (exact) {
            setStats({ ...exact,
              pct_certified: exact.n ? Math.round((1000 * exact.n_cert) / exact.n) / 10 : null });
            setWages(cubeWages);
            setError(null); setAggBusy(false);
            return;
          }
          // custom year range: the per-fy chart rows are still exact — only
          // the tiles need a row-level pass below
          setWages(cubeWages);
        }
      }
      if (unfiltered && cubes && mode === "entity") {
        const n = await fetchEntityCount(manifest, soleDim, sel[soleDim].k,
          program, selectedYears, stale);
        if (stale()) return;
        if (n != null) {
          setStats({ n }); setWages([]);
          setError(null); setAggBusy(false);
          return;
        }
      }
      const from = await scope(manifest, program, selectedYears);
      if (stale()) return;
      if (!from) { setStats(null); setWages([]); setAggBusy(false); return; }
      const where = whereClause(debouncedColFilters, sel);
      const withWages = mode !== "entity" && !cubeWages;
      const { stats: s, wages: w } = await fetchOverview(from, where, withWages, stale);
      if (stale()) return;
      setStats(s);
      if (withWages) setWages(w);
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
      const order = sort ? [sort] : defaultOrder(program);
      const r = await fetchRows(from, where, order, page, PAGE_SIZE, stale);
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
    setProgram(p); setColFilters({}); setSort(null);
    setColumns(loadColumns(p)); setSelectedYears(null);
  };

  const busy = rowsBusy || aggBusy;

  if (error && !manifest) return <div className="status-line error">Failed to load: {error}</div>;
  if (!manifest || !selectedYears) return <div className="status-line">Loading datasets…</div>;

  const searchable = hasAggregates(manifest);

  const topCharts = topDims.length > 0 && (
    <div className={`top-charts${topsBusy ? " updating" : ""}`}>
      {topDims.map((dim) => {
        const t = tops[dim];
        const isExp = !!expanded[dim];
        const canExpand = t && (t.rows.length > TOP_N
          || (!t.full && mode === "home" && OVERVIEW_FILES[dim]));
        const rows = t ? (isExp ? t.rows : t.rows.slice(0, TOP_N)) : [];
        return (
          <div className="panel" key={dim}>
            <h2>{TOP_TITLES[dim]}
              <span className="scope-note">
                {t?.scope === "rows" ? "current records" : "all programs & years"}
              </span>
              {canExpand && (
                <button className="linkish chart-more"
                  onClick={() => setExpanded((x) => ({ ...x, [dim]: !isExp }))}>
                  {isExp ? `Top ${TOP_N} ↑` : "Show more ↓"}
                </button>
              )}
            </h2>
            {t ? (
              <div className={isExp ? "chart-scroll" : undefined}>
                <TopBars extraLabel="Median wage"
                  data={rows.map((r) => ({ label: r.label, value: r.n, extra: r.median_wage, row: r }))}
                  onPick={(d) => addSel(dim, d.row.sel)} />
              </div>
            ) : <div className="chart-note">Loading…</div>}
          </div>
        );
      })}
    </div>
  );

  // link a selected role (and its wage-library counterpart) across views;
  // group keys keep O*NET .XX details the wage library doesn't have
  const socBase = sel.soc && /^\d{2}-\d{4}/.test(sel.soc.k) ? sel.soc.k.slice(0, 7) : null;

  if (view === "wages") {
    return (
      <>
        <header className="app">
          <h1>OFLC Data Explorer</h1>
          <span className="sub">U.S. DOL foreign labor certification disclosure data</span>
          <nav className="tabs view-tabs">
            <button onClick={() => openCases()}>Case explorer</button>
            <button className="active">Wage levels</button>
          </nav>
        </header>
        {error && <div className="status-line"><span className="error">{error}</span></div>}
        <WagesPage manifest={manifest} onError={setError}
          onOpenCases={(code, label) =>
            openCases({ ...EMPTY_SEL, soc: { k: code, label: label || code } })} />
        <footer className="app">
          Source: <a href="https://flag.dol.gov/wage-data/wage-data-downloads" target="_blank" rel="noreferrer">
          OFLC wage data downloads</a> (OEWS survey based). Each wage year is effective July through
          June. Levels 1–4 are the OFLC prevailing wage levels; the average is the OEWS mean.
          Queries run entirely in your browser via DuckDB-WASM.
        </footer>
      </>
    );
  }

  return (
    <>
      <header className="app">
        <h1>OFLC Data Explorer</h1>
        <span className="sub">U.S. DOL foreign labor certification disclosure data</span>
        {hasWages(manifest) && (
          <nav className="tabs view-tabs">
            <button className="active">Case explorer</button>
            <button onClick={() => openWages(null)}>Wage levels</button>
          </nav>
        )}
      </header>

      {searchable && (
        <SearchHero
          search={(text, stale) => searchGroups(manifest, text, stale)}
          onPick={pickFromSearch} />
      )}
      <div className="chips-row">
        <Chips sel={sel} onRemove={removeSel} onClear={() => setSel(EMPTY_SEL)} />
        {socBase && hasWages(manifest) && (
          <button className="linkish" onClick={() =>
            openWages({ soc: socBase, socLabel: sel.soc.label })}>
            Wage levels for this role →
          </button>
        )}
      </div>

      <div className="scope-bar">
        <ProgramTabs programs={Object.keys(manifest.programs)} program={program} onChange={switchProgram} />
        <div className="panel year-panel">
          <YearRange years={years} selectedYears={selectedYears}
            onYears={(y) => y.length && setSelectedYears(y)} />
        </div>
      </div>

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

      <div className="status-line">{busy ? "Querying…" : error ? <span className="error">{error}</span> : ""}</div>

      {mode !== "entity" && (
        <>
          <div className={`tiles${aggBusy ? " updating" : ""}`}>
            <div className="tile"><div className="label">Records</div>
              <div className="value">{stats ? fmtNum(stats.n) : "–"}</div></div>
            <div className="tile"><div className="label">Employers</div>
              <div className="value">{stats ? fmtNum(stats.employers) : "–"}</div></div>
            <div className="tile"><div className="label">Median annual wage</div>
              <div className="value">{stats && stats.median_wage != null ? fmtUsd(stats.median_wage) : "–"}</div></div>
            <div className="tile"><div className="label">{program === "pwd" ? "Determinations issued" : "Certified"}</div>
              <div className="value">{stats && stats.pct_certified != null ? `${stats.pct_certified}%` : "–"}</div></div>
          </div>

          <div className={`panel${aggBusy ? " updating" : ""}`}>
            <h2>Annual wage by fiscal year
              <span className="scope-note">box 25th–75th pct · whiskers 5th–95th · min/max on hover</span>
            </h2>
            <WageDistribution data={wages} />
          </div>
        </>
      )}

      <ResultsTable program={program} rows={rows} total={stats?.n ?? 0} page={page} pageSize={PAGE_SIZE}
        onPage={setPage} sort={sort ?? DEFAULT_SORT} onSort={setSort}
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
