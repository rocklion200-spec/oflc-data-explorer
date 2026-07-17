import { fmtUsd } from "./charts.jsx";

const COLS = [
  ["decision_date", "Decision date", false],
  ["case_status", "Status", false],
  ["employer_name", "Employer", false],
  ["job_title", "Job title", false],
  ["soc_code", "SOC", false],
  ["worksite_city", "Worksite city", false],
  ["worksite_state", "State", false],
  ["wage_annual", "Wage (annual)", true],
  ["pw_annual", "Prevailing (annual)", true],
  ["visa_class", "Visa", false],
  ["case_number", "Case number", false],
];

export function ResultsTable({ rows, total, page, pageSize, onPage, sort, onSort }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="panel">
      <h2>Records</h2>
      <div className="table-wrap">
        <table className="results">
          <thead>
            <tr>
              {COLS.map(([key, label, num]) => (
                <th key={key} className={num ? "num" : ""}
                  onClick={() => onSort({ col: key, dir: sort.col === key && sort.dir === "desc" ? "asc" : "desc" })}
                  title="Click to sort">
                  {label}{sort.col === key ? (sort.dir === "desc" ? " ↓" : " ↑") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.case_number + r.decision_date}>
                {COLS.map(([key, , num]) => (
                  <td key={key} className={num ? "num" : ""} title={r[key] ?? ""}>
                    {num ? fmtUsd(r[key]) : r[key] ?? "–"}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={COLS.length} style={{ color: "var(--text-muted)" }}>No matching records.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <button disabled={page === 0} onClick={() => onPage(0)}>« First</button>
        <button disabled={page === 0} onClick={() => onPage(page - 1)}>‹ Prev</button>
        <span className="info">Page {page + 1} of {pages.toLocaleString()} · {total.toLocaleString()} records</span>
        <button disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>Next ›</button>
      </div>
    </div>
  );
}
