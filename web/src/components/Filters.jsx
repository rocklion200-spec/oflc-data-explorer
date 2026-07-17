const PROGRAM_LABELS = { lca: "LCA (H-1B, H-1B1, E-3)", perm: "PERM", pwd: "Prevailing Wage" };

export function ProgramTabs({ programs, program, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {programs.map((p) => (
        <button key={p} role="tab" aria-selected={p === program}
          className={p === program ? "active" : ""} onClick={() => onChange(p)}>
          {PROGRAM_LABELS[p] || p.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export function Filters({ years, selectedYears, onYears, filters, onFilters, options, program }) {
  const set = (k) => (e) => onFilters({ ...filters, [k]: e.target.value });
  return (
    <div className="panel">
      <h2>Filters</h2>
      <div className="filters">
        <label>Employer name
          <input type="search" placeholder="e.g. Google" value={filters.employer} onChange={set("employer")} />
        </label>
        <label>Job title
          <input type="search" placeholder="e.g. Software Engineer" value={filters.jobTitle} onChange={set("jobTitle")} />
        </label>
        <label>SOC code or title
          <input type="search" placeholder="e.g. 15-1252 or Developers" value={filters.soc} onChange={set("soc")} />
        </label>
        <label>Worksite state
          <select value={filters.state} onChange={set("state")}>
            <option value="">All states</option>
            {options.states.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label>Worksite city
          <input type="search" placeholder="e.g. Austin" value={filters.city} onChange={set("city")} />
        </label>
        <label>Case status
          <select value={filters.status} onChange={set("status")}>
            <option value="">All statuses</option>
            {options.statuses.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        {program !== "perm" && (
          <label>Visa class
            <select value={filters.visaClass} onChange={set("visaClass")}>
              <option value="">All visa classes</option>
              {options.visaClasses.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="year-chips" aria-label="Fiscal years">
        {years.map((fy) => (
          <button key={fy} className={selectedYears.includes(fy) ? "on" : ""}
            onClick={() => onYears(
              selectedYears.includes(fy)
                ? selectedYears.filter((y) => y !== fy)
                : [...selectedYears, fy].sort()
            )}>
            FY{fy}
          </button>
        ))}
      </div>
    </div>
  );
}
