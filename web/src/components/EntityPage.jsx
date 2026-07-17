import { useEffect, useRef, useState } from "react";
import { isStale } from "../db.js";
import { fetchEntitySummary, fetchEntityTop } from "../queries.js";
import { MonthlyLine, TopBars, fmtNum, fmtUsd } from "./charts.jsx";

const PROGRAM_LABELS = { lca: "LCA (H-1B)", perm: "PERM", pwd: "Prevailing Wage" };
const DIM_TITLE = { employer: "Employer", soc: "Role (SOC)", title: "Job title" };

// cube panels shown for each entity type; `pick` maps a clicked row to the
// next drill-down selection
const PANELS = {
  employer: [
    { title: "Top roles", cube: "emp_soc",
      pick: (r) => ["soc", { k: r.k2, label: r.label2 }] },
    { title: "Top job titles", cube: "emp_title",
      pick: (r) => ["title", { k: r.k2, label: r.label2 }] },
    { title: "Top locations", cube: "emp_loc",
      pick: (r) => ["loc", { state: r.state, cityKey: r.city_key, label: r.label2 }] },
  ],
  soc: [
    { title: "Top employers", cube: "soc_emp",
      pick: (r) => ["employer", { k: r.k2, label: r.label2 }] },
    { title: "Top locations", cube: "soc_loc",
      pick: (r) => ["loc", { state: r.state, cityKey: r.city_key, label: r.label2 }] },
  ],
  title: [
    { title: "Top employers", cube: "title_emp",
      pick: (r) => ["employer", { k: r.k2, label: r.label2 }] },
  ],
};

// Entity page for a single selected group: all years, all programs, entirely
// served by the precomputed cubes (no row-level scans).
export function EntityPage({ manifest, dim, sel, onDrill, onError }) {
  const [summary, setSummary] = useState(null);
  const [tops, setTops] = useState({});
  const run = useRef(0);

  useEffect(() => {
    const id = ++run.current;
    const stale = () => id !== run.current;
    setSummary(null); setTops({});
    (async () => {
      const s = await fetchEntitySummary(manifest, dim, sel.k, stale);
      if (stale()) return;
      setSummary(s);
      for (const p of PANELS[dim]) {
        const rows = await fetchEntityTop(manifest, p.cube, sel.k, stale);
        if (stale()) return;
        setTops((t) => ({ ...t, [p.cube]: rows }));
      }
    })().catch((e) => { if (!isStale(e) && id === run.current) onError(String(e)); });
  }, [manifest, dim, sel.k]); // eslint-disable-line

  const o = summary?.overall;
  const trend = summary?.trend ?? [];
  const years = trend.length
    ? `FY${trend[0].fy}–FY${trend[trend.length - 1].fy}` : "–";
  const pct = o && o.n ? Math.round((1000 * o.n_cert) / o.n) / 10 : null;

  return (
    <>
      <div className="entity-head">
        <span className="entity-kind">{DIM_TITLE[dim]}</span>
        <h2>{sel.label}</h2>
        {dim === "soc" && <span className="entity-code">{sel.k}</span>}
        <span className="entity-programs">
          {(summary?.programs ?? []).map((p) => (
            <span key={p.program} className="prog-pill">
              {PROGRAM_LABELS[p.program] || p.program}: {fmtNum(p.n)}
            </span>
          ))}
        </span>
      </div>

      <div className="tiles">
        <div className="tile"><div className="label">Records (all years)</div>
          <div className="value">{o ? fmtNum(o.n) : "–"}</div></div>
        <div className="tile"><div className="label">Median annual wage</div>
          <div className="value">{o?.median_wage != null ? fmtUsd(o.median_wage) : "–"}</div></div>
        <div className="tile"><div className="label">Certified / issued</div>
          <div className="value">{pct != null ? `${pct}%` : "–"}</div></div>
        <div className="tile"><div className="label">Active years</div>
          <div className="value">{years}</div></div>
      </div>

      <div className="charts">
        <div className="panel">
          <h2>Records per fiscal year</h2>
          <MonthlyLine xLabel="Fiscal year" valueLabel="Records"
            data={trend.map((d) => ({ month: `FY${d.fy}`, value: d.n }))} />
        </div>
        <div className="panel">
          <h2>Median annual wage per fiscal year</h2>
          <MonthlyLine xLabel="Fiscal year" valueLabel="Median wage" valueFmt={fmtUsd}
            data={trend.map((d) => ({ month: `FY${d.fy}`, value: d.median_wage }))} />
        </div>
      </div>

      <div className="entity-panels">
        {PANELS[dim].map((p) => (
          <div className="panel" key={p.cube}>
            <h2>{p.title}</h2>
            <TopBars extraLabel="Median wage"
              data={(tops[p.cube] ?? []).map((r) => ({
                label: r.label2, value: r.n, extra: r.median_wage, row: r,
              }))}
              onPick={(d) => onDrill(...p.pick(d.row))} />
          </div>
        ))}
      </div>
    </>
  );
}
