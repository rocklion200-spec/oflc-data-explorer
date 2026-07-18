import { useEffect, useRef, useState } from "react";
import { fmtNum } from "./charts.jsx";

const DIM_LABELS = { employer: "Employers", soc: "Roles (SOC)", title: "Job titles", loc: "Locations" };

// The primary navigation: one search box over all group dimensions.
// Suggestions come from the precomputed group index (searchGroups), shown in
// three sections; picking one selects that entity and opens its page.
export function SearchHero({ search, onPick }) {
  const [text, setText] = useState("");
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const timer = useRef(null);
  const boxRef = useRef(null);

  const load = (q, delay = 200) => {
    const id = ++seq.current;
    clearTimeout(timer.current);
    setLoading(true);
    timer.current = setTimeout(() => {
      search(q, () => id !== seq.current)
        .then((rows) => {
          if (id !== seq.current) return;
          setItems(rows); setActive(-1); setLoading(false);
        })
        .catch(() => { if (id === seq.current) setLoading(false); });
    }, delay);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    const onDown = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const pick = (it) => {
    onPick(it.dim, it.k, it.label);
    setText(""); setOpen(false);
  };
  const onKey = (e) => {
    if (!open || !items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, -1)); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(items[active]); }
    else if (e.key === "Escape") setOpen(false);
  };

  // group flat results into dim sections, preserving order
  const sections = [];
  items.forEach((it, i) => {
    const last = sections[sections.length - 1];
    if (!last || last.dim !== it.dim) sections.push({ dim: it.dim, items: [] });
    sections[sections.length - 1].items.push({ ...it, i });
  });

  return (
    <div className="hero" ref={boxRef}>
      <input type="search" className="hero-input" autoComplete="off"
        placeholder="Search an employer, role, job title, or location — e.g. Goldman Sachs, Austin"
        value={text}
        onChange={(e) => { setText(e.target.value); setOpen(true); load(e.target.value); }}
        onFocus={() => { setOpen(true); load(text, 0); }}
        onKeyDown={onKey} />
      {open && (
        <div className="hero-list" role="listbox">
          {loading && items.length === 0 && (
            <div className="hero-note">Loading search index…</div>
          )}
          {!loading && items.length === 0 && (
            <div className="hero-note">No matching groups.</div>
          )}
          {sections.map((s) => (
            <div key={s.dim}>
              <div className="hero-section">{DIM_LABELS[s.dim]}</div>
              <ul>
                {s.items.map((it) => (
                  <li key={s.dim + it.k} role="option" aria-selected={it.i === active}
                    className={it.i === active ? "active" : ""}
                    onMouseDown={(e) => { e.preventDefault(); pick(it); }}>
                    <span className="v">
                      {it.label}
                      {s.dim === "soc" && <span className="code"> {it.k}</span>}
                    </span>
                    <span className="n">{fmtNum(it.n)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Active drill-down selections as removable chips.
const CHIP_KIND = { employer: "Employer", soc: "Role", title: "Title", loc: "Location" };

export function Chips({ sel, onRemove, onClear }) {
  const entries = Object.entries(sel).filter(([, v]) => v);
  if (!entries.length) return null;
  return (
    <div className="chips">
      {entries.map(([dim, v]) => (
        <span key={dim} className="chip">
          <span className="kind">{CHIP_KIND[dim]}</span>
          {v.label}
          <button aria-label={`Remove ${v.label}`} onClick={() => onRemove(dim)}>×</button>
        </span>
      ))}
      {entries.length > 1 && (
        <button className="linkish" onClick={onClear}>Clear all</button>
      )}
    </div>
  );
}
