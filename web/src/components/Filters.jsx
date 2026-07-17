import { useEffect, useRef, useState } from "react";
import { fmtNum } from "./charts.jsx";

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

// Text input with async suggestions. Free text stays a partial match; picking
// a suggestion just fills in that exact spelling (still matched with ILIKE).
function Autocomplete({ label, placeholder, value, onChange, suggest }) {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const seq = useRef(0);
  const timer = useRef(null);
  const boxRef = useRef(null);

  const load = (text, delay = 250) => {
    const id = ++seq.current; // invalidates any in-flight fetch immediately
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      suggest(text, () => id !== seq.current)
        .then((rows) => { if (id === seq.current) { setItems(rows); setActive(-1); } })
        .catch(() => {});
    }, delay);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const pick = (v) => { onChange(v); setOpen(false); };
  const onKey = (e) => {
    if (!open || !items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, -1)); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(items[active].v); }
    else if (e.key === "Escape") setOpen(false);
  };

  return (
    <label className="combo" ref={boxRef}>{label}
      <input type="search" placeholder={placeholder} value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); load(e.target.value); }}
        onFocus={() => { setOpen(true); load(value, 0); }}
        onKeyDown={onKey} autoComplete="off" />
      {open && items.length > 0 && (
        <ul className="combo-list" role="listbox">
          {items.map((it, i) => (
            <li key={it.v} role="option" aria-selected={i === active}
              className={i === active ? "active" : ""}
              onMouseDown={(e) => { e.preventDefault(); pick(it.v); }}>
              <span className="v">{it.v}</span>
              <span className="n">{fmtNum(it.n)}</span>
            </li>
          ))}
        </ul>
      )}
    </label>
  );
}

function YearRange({ years, selectedYears, onYears }) {
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

export function Filters({ years, selectedYears, onYears, filters, onFilters, options, program, suggest }) {
  const set = (k) => (e) => onFilters({ ...filters, [k]: e.target.value });
  const setVal = (k) => (v) => onFilters({ ...filters, [k]: v });
  const sug = (field, col) => (text, stale) => suggest(field, col, text, stale);
  return (
    <div className="panel">
      <h2>Filters</h2>
      <div className="filters">
        <Autocomplete label="Employer name" placeholder="e.g. Google" value={filters.employer}
          onChange={setVal("employer")} suggest={sug("employer", "employer_name")} />
        <Autocomplete label="Job title" placeholder="e.g. Software Engineer" value={filters.jobTitle}
          onChange={setVal("jobTitle")} suggest={sug("jobTitle", "job_title")} />
        <Autocomplete label="SOC code or title" placeholder="e.g. 15-1252 or Developers" value={filters.soc}
          onChange={setVal("soc")} suggest={sug("soc", "soc_title")} />
        <label>Worksite state
          <select value={filters.state} onChange={set("state")}>
            <option value="">All states</option>
            {options.states.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <Autocomplete label="Worksite city" placeholder="e.g. Austin" value={filters.city}
          onChange={setVal("city")} suggest={sug("city", "worksite_city")} />
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
      <YearRange years={years} selectedYears={selectedYears} onYears={onYears} />
    </div>
  );
}
