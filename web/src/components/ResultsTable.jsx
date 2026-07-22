import { useEffect, useRef, useState } from "react";
import { COLUMN_TYPES } from "../queries.js";
import { fmtNum, fmtUsd } from "./charts.jsx";

const LABELS = {
  program: "Program", pw_unit: "PW unit", pwd_number: "PWD number",
  employer_postal_code: "Employer ZIP", county_key: "County group",
  employer_name: "Employer name", soc_title: "SOC title", job_title: "Job title",
  worksite_city: "Worksite city", worksite_state: "State",
  wage_annual: "Wage (annual)", pw_annual: "Prevailing (annual)",
  received_date: "Received", begin_date: "Begin date", wage_to: "Wage to",
  total_workers: "Positions", decision_date: "Decision date",
  case_status: "Status", case_number: "Case number", visa_class: "Visa class",
  soc_code: "SOC code", employer_city: "Employer city",
  employer_state: "Employer state", naics_code: "NAICS",
  worksite_address: "Worksite address",
  worksite_county: "Worksite county", worksite_postal_code: "Worksite ZIP",
  wage_from: "Wage from", wage_unit: "Wage unit", pw_wage: "Prevailing (raw)",
  pw_wage_level: "PW level", full_time_position: "Full-time",
  end_date: "End date", fiscal_year: "Fiscal year",
  employer_group: "Employer group", soc_group: "Role group", title_group: "Title group",
};

// full label map, shared with the Excel export (which carries ALL columns)
export const COLUMN_LABELS = LABELS;

const DEFAULT_VISIBLE = {
  lca: ["employer_name", "soc_title", "job_title", "worksite_city", "worksite_state",
    "wage_annual", "pw_annual", "pw_wage_level", "received_date",
    "begin_date", "wage_to", "total_workers", "decision_date", "case_status",
    "case_number", "visa_class", "soc_code"],
  perm: ["employer_name", "soc_title", "job_title", "worksite_city", "worksite_state",
    "wage_annual", "wage_to", "pw_annual", "pw_wage_level", "received_date",
    "decision_date", "case_status", "case_number", "soc_code"],
  pwd: ["employer_name", "soc_title", "job_title", "worksite_city", "worksite_state",
    "pw_annual", "pw_wage_level", "received_date", "decision_date", "case_status",
    "case_number", "visa_class", "soc_code"],
};

const USD_COLS = new Set(["wage_annual", "wage_from", "wage_to", "pw_annual", "pw_wage"]);
const isNum = (c) => COLUMN_TYPES[c] === "num";

const storageKey = (program) => `oflc-columns-${program}`;

export function loadColumns(program) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(program)));
    if (Array.isArray(saved) && saved.length && saved.every((c) => c in LABELS)) return saved;
  } catch { /* fall through to defaults */ }
  return DEFAULT_VISIBLE[program] || DEFAULT_VISIBLE.lca;
}

function saveColumns(program, cols) {
  try { localStorage.setItem(storageKey(program), JSON.stringify(cols)); } catch { /* ignore */ }
}

const FILTER_HINT = {
  text: "contains…",
  num: "e.g. >150k",
  date: "e.g. 2025-03 or >=2024",
};

// Excel-style filter for text columns: type for a contains match, check
// specific values (fetched with counts under all other active filters), or
// "Select all" to keep everything containing the typed text as a term —
// terms accumulate, so you can OR several contains-matches together.
// Checked values and terms take precedence over the typed text.
function ValueFilter({ col, value, onChange, fetchValues }) {
  const text = value?.text || "";
  const selected = value?.values || [];
  const terms = value?.terms || [];
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const timer = useRef(null);
  const boxRef = useRef(null);
  const inputRef = useRef(null);

  const load = (t, delay = 250) => {
    const id = ++seq.current;
    clearTimeout(timer.current);
    setLoading(true);
    timer.current = setTimeout(() => {
      fetchValues(col, t, () => id !== seq.current)
        .then((rows) => { if (id === seq.current) { setItems(rows); setLoading(false); } })
        .catch(() => { if (id === seq.current) setLoading(false); });
    }, delay);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    // the page reflows (charts refresh) and scrolls under the fixed dropdown;
    // track the input's rect every frame so the dropdown stays glued to it
    let raf;
    const track = () => {
      const r = inputRef.current?.getBoundingClientRect();
      if (r) {
        const left = Math.min(r.left, window.innerWidth - 280), top = r.bottom + 4;
        setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
      }
      raf = requestAnimationFrame(track);
    };
    raf = requestAnimationFrame(track);
    return () => {
      document.removeEventListener("mousedown", onDown);
      cancelAnimationFrame(raf);
    };
  }, [open]);

  const commit = (t, values, tms = terms) =>
    onChange(t || values.length || tms.length ? { text: t, values, terms: tms } : null);
  const toggle = (v) => commit(text,
    selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  // "Select all": keep everything containing the typed text, beyond the top 50
  // shown — stored as a contains-term; checked values it implies are dropped
  const addTerm = () => {
    const t = text.trim();
    if (!t) return;
    const low = t.toLowerCase();
    const tms = terms.some((x) => x.toLowerCase() === low) ? terms : [...terms, t];
    commit("", selected.filter((v) => !v.toLowerCase().includes(low)), tms);
    load("", 0);
  };
  const impliedByTerm = (v) => terms.some((t) => v.toLowerCase().includes(t.toLowerCase()));
  const nSelected = selected.length + terms.length;
  const show = () => {
    const r = inputRef.current.getBoundingClientRect();
    setPos({ left: Math.min(r.left, window.innerWidth - 280), top: r.bottom + 4 });
    setOpen(true);
    load(text, 0);
  };

  // keep checked values visible even when they fall outside the fetched top-N
  const shown = [
    ...selected.filter((v) => !items.some((it) => it.v === v)).map((v) => ({ v, n: null })),
    ...items,
  ];

  return (
    <div className="val-filter" ref={boxRef}>
      <input ref={inputRef} type="search" value={text}
        className={nSelected ? "has-sel" : ""}
        placeholder={nSelected ? `${nSelected} selected` : FILTER_HINT.text}
        onChange={(e) => { commit(e.target.value, selected); if (!open) show(); load(e.target.value); }}
        onFocus={show}
        onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }} />
      {open && pos && (
        <div className="val-list" style={{ left: pos.left, top: pos.top }}>
          <div className="val-head">
            <span>{loading ? "Loading…" : items.length >= 50 ? "Top 50 values" : `${items.length} values`}</span>
            <span className="val-actions">
              {text.trim() && (
                <button className="linkish" title={`Keep every value containing “${text.trim()}”`}
                  onMouseDown={(e) => { e.preventDefault(); addTerm(); }}>
                  Select all
                </button>
              )}
              {(nSelected > 0 || text) && (
                <button className="linkish"
                  onMouseDown={(e) => { e.preventDefault(); commit("", [], []); load("", 0); }}>
                  Clear
                </button>
              )}
            </span>
          </div>
          {terms.length > 0 && (
            <div className="val-terms">
              {terms.map((t) => (
                <span key={t} className="val-term">contains “{t}”
                  <button title="Remove"
                    onMouseDown={(e) => { e.preventDefault(); commit(text, selected, terms.filter((x) => x !== t)); }}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {shown.map((it) => {
            const implied = impliedByTerm(it.v);
            return (
              <label key={it.v ?? "null"} className="val-item">
                <input type="checkbox" checked={implied || selected.includes(it.v)}
                  disabled={implied} title={implied ? "Included by a “contains” term above" : undefined}
                  onChange={() => toggle(it.v)} />
                <span className="v" title={it.v}>{it.v}</span>
                {it.n != null && <span className="n">{fmtNum(it.n)}</span>}
              </label>
            );
          })}
          {!loading && shown.length === 0 && <div className="val-empty">No matching values.</div>}
        </div>
      )}
    </div>
  );
}

function ColumnManager({ program, columns, onColumns, onClose }) {
  const hidden = Object.keys(LABELS).filter((c) => !columns.includes(c));
  const dragFrom = useRef(null);
  const ref = useRef(null);
  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);
  const move = (from, to) => {
    const next = [...columns];
    next.splice(to, 0, ...next.splice(from, 1));
    onColumns(next);
  };
  return (
    <div className="col-manager" ref={ref}>
      <div className="col-manager-head">
        <span>Shown (drag to reorder)</span>
        <button className="linkish" onClick={() => onColumns(DEFAULT_VISIBLE[program] || DEFAULT_VISIBLE.lca)}>
          Reset
        </button>
      </div>
      <ul>
        {columns.map((c, i) => (
          <li key={c} draggable
            onDragStart={() => { dragFrom.current = i; }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (dragFrom.current != null) move(dragFrom.current, i); dragFrom.current = null; }}>
            <span className="grip">⋮⋮</span>
            <label>
              <input type="checkbox" checked readOnly
                onClick={() => columns.length > 1 && onColumns(columns.filter((x) => x !== c))} />
              {LABELS[c]}
            </label>
          </li>
        ))}
      </ul>
      {hidden.length > 0 && <div className="col-manager-head"><span>Hidden</span></div>}
      <ul>
        {hidden.map((c) => (
          <li key={c}>
            <span className="grip" style={{ visibility: "hidden" }}>⋮⋮</span>
            <label>
              <input type="checkbox" checked={false} readOnly
                onClick={() => onColumns([...columns, c])} />
              {LABELS[c]}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ResultsTable({ program, rows, total, page, pageSize, onPage, sort, onSort,
  columns, onColumns, colFilters, onColFilters, fetchColValues, onExport, exporting }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const [managing, setManaging] = useState(false);
  const dragCol = useRef(null);

  const setColumns = (next) => { saveColumns(program, next); onColumns(next); };
  const setFilter = (col, v) => {
    const next = { ...colFilters };
    if (v) next[col] = v; else delete next[col];
    onColFilters(next);
  };
  const hasFilters = Object.keys(colFilters).length > 0;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Records</h2>
        <div className="panel-tools">
          {hasFilters && (
            <button className="linkish" onClick={() => onColFilters({})}>Clear column filters</button>
          )}
          {onExport && (
            <button className="tool-btn" disabled={exporting} onClick={onExport}
              title="Download the matching records as an Excel file — every column, not just the ones shown (capped at 50,000 rows)">
              {exporting ? "Preparing…" : "⬇ Excel"}
            </button>
          )}
          <button className="tool-btn" onClick={() => setManaging((m) => !m)}>Columns ▾</button>
          {managing && (
            <ColumnManager program={program} columns={columns}
              onColumns={setColumns} onClose={() => setManaging(false)} />
          )}
        </div>
      </div>
      <div className="table-wrap">
        <table className="results">
          <thead>
            <tr>
              {columns.map((key) => (
                <th key={key} className={isNum(key) ? "num" : ""} draggable
                  onDragStart={() => { dragCol.current = key; }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    const from = columns.indexOf(dragCol.current), to = columns.indexOf(key);
                    if (from >= 0 && to >= 0 && from !== to) {
                      const next = [...columns];
                      next.splice(to, 0, ...next.splice(from, 1));
                      setColumns(next);
                    }
                    dragCol.current = null;
                  }}
                  onClick={() => onSort({ col: key, dir: sort.col === key && sort.dir === "desc" ? "asc" : "desc" })}
                  title="Click to sort · drag to reorder">
                  {LABELS[key]}{sort.col === key ? (sort.dir === "desc" ? " ↓" : " ↑") : ""}
                </th>
              ))}
            </tr>
            <tr className="col-filter-row">
              {columns.map((key) => (
                <th key={key}>
                  {COLUMN_TYPES[key] === "text" ? (
                    <ValueFilter col={key} value={colFilters[key]}
                      onChange={(v) => setFilter(key, v)} fetchValues={fetchColValues} />
                  ) : (
                    <input type="search" value={colFilters[key] || ""}
                      placeholder={FILTER_HINT[COLUMN_TYPES[key]] || "filter…"}
                      onChange={(e) => setFilter(key, e.target.value)} />
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.case_number + r.decision_date}>
                {columns.map((key) => (
                  <td key={key} className={isNum(key) ? "num" : ""} title={r[key] ?? ""}>
                    {USD_COLS.has(key) ? fmtUsd(r[key]) : r[key] ?? "–"}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={columns.length} style={{ color: "var(--text-muted)" }}>No matching records.</td></tr>
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
