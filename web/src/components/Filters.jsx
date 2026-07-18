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

export function YearRange({ years, selectedYears, onYears }) {
  if (!years.length) return null;
  const lo = selectedYears[0], hi = selectedYears[selectedYears.length - 1];
  const setRange = (from, to) => {
    if (from > to) [from, to] = [to, from];
    onYears(years.filter((y) => y >= from && y <= to));
  };
  const isAll = selectedYears.length === years.length;
  const last = (n) => selectedYears.length === n && hi === years[years.length - 1];
  return (
    <div className="year-range" aria-label="Fiscal years">
      <span className="year-label">Fiscal years</span>
      <label>from
        <select value={lo} onChange={(e) => setRange(Number(e.target.value), hi)}>
          {years.map((y) => <option key={y} value={y}>FY{y}</option>)}
        </select>
      </label>
      <label>to
        <select value={hi} onChange={(e) => setRange(lo, Number(e.target.value))}>
          {years.map((y) => <option key={y} value={y}>FY{y}</option>)}
        </select>
      </label>
      <div className="year-presets">
        <button className={isAll ? "on" : ""} onClick={() => setRange(years[0], years[years.length - 1])}>
          All years
        </button>
        {[2, 5].map((n) => years.length > n && (
          <button key={n} className={!isAll && last(n) ? "on" : ""}
            onClick={() => setRange(years[years.length - n], years[years.length - 1])}>
            Last {n}
          </button>
        ))}
      </div>
    </div>
  );
}
