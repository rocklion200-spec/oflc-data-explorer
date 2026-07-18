// Small custom SVG charts following the dataviz mark specs:
// 2px lines, >=8px end markers with a 2px surface ring, <=24px bars with a
// 4px rounded data-end (square at the baseline), hairline solid gridlines,
// text in text tokens (never the series color), hover tooltips.
import { useRef, useState, useLayoutEffect } from "react";

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => setW(Math.max(240, es[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceTicks(max, count = 4) {
  if (!max || max <= 0) return [0, 1];
  const step = Math.pow(10, Math.floor(Math.log10(max / count)));
  const err = max / count / step;
  const mult = err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
  const s = mult * step;
  const top = Math.ceil(max / s) * s;
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += s) ticks.push(v);
  return ticks;
}

const fmtCompact = (v) =>
  v == null ? "–" : Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M`
  : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(Math.abs(v) >= 1e5 ? 0 : 1)}K` : `${Math.round(v)}`;
export const fmtNum = (v) => (v == null ? "–" : Number(v).toLocaleString("en-US"));
export const fmtUsd = (v) => (v == null ? "–" : `$${Number(v).toLocaleString("en-US")}`);

function Tooltip({ tip }) {
  if (!tip) return null;
  return (
    <div className="viz-tooltip" style={{ left: tip.x + 12, top: tip.y + 12 }}>
      {tip.lines.map(([k, v]) => (
        <div key={k}><span className="k">{k}</span>{v}</div>
      ))}
    </div>
  );
}

// data: [{month:'2025-10', value:n}], single series (no legend needed)
export function MonthlyLine({ data, valueFmt = fmtNum, valueLabel = "Value", xLabel = "Month" }) {
  const [ref, width] = useWidth();
  const [tip, setTip] = useState(null);
  const height = 200, mL = 44, mR = 14, mT = 10, mB = 24;
  const iw = width - mL - mR, ih = height - mT - mB;
  const vals = data.map((d) => d.value ?? 0);
  const ticks = niceTicks(Math.max(...vals, 1));
  const yMax = ticks[ticks.length - 1];
  const x = (i) => mL + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v) => mT + ih - (v / yMax) * ih;

  const onMove = (e) => {
    if (!data.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = Math.round(((px - mL) / Math.max(iw, 1)) * (data.length - 1));
    const c = Math.max(0, Math.min(data.length - 1, i));
    setTip({
      x: e.clientX, y: e.clientY, i: c,
      lines: [[xLabel, data[c].month], [valueLabel, valueFmt(data[c].value)]],
    });
  };

  const path = data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.value ?? 0).toFixed(1)}`).join("");
  const last = data.length - 1;
  const xLabelEvery = Math.ceil(data.length / Math.max(3, Math.floor(iw / 90)));

  return (
    <div ref={ref} style={{ position: "relative" }}>
      {data.length === 0 ? (
        <div className="chart-note" style={{ minHeight: height - 20 }}>No data for this selection.</div>
      ) : (
        <svg width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setTip(null)} role="img">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={mL} x2={width - mR} y1={y(t)} y2={y(t)}
                stroke={t === 0 ? "var(--baseline)" : "var(--grid)"} strokeWidth="1" />
              <text x={mL - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)">
                {fmtCompact(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) =>
            i % xLabelEvery === 0 ? (
              <text key={d.month} x={x(i)} y={height - 7} textAnchor="middle" fontSize="11" fill="var(--text-muted)">
                {d.month}
              </text>
            ) : null)}
          {tip && (
            <line x1={x(tip.i)} x2={x(tip.i)} y1={mT} y2={mT + ih} stroke="var(--baseline)" strokeWidth="1" />
          )}
          <path d={path} fill="none" stroke="var(--series-1)" strokeWidth="2"
            strokeLinejoin="round" strokeLinecap="round" />
          {tip && data[tip.i] && (
            <circle cx={x(tip.i)} cy={y(data[tip.i].value ?? 0)} r="4.5"
              fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth="2" />
          )}
          {last >= 0 && (
            <>
              <circle cx={x(last)} cy={y(data[last].value ?? 0)} r="4"
                fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth="2" />
              <text x={x(last) - 6} y={y(data[last].value ?? 0) - 8} textAnchor="end"
                fontSize="11.5" fontWeight="600" fill="var(--text-primary)">
                {valueFmt(data[last].value)}
              </text>
            </>
          )}
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}

// data: [{fy, n, lo, p05, p25, p50, p75, p95, hi}] — one distribution column
// per fiscal year: 5th–95th pct whisker, p25–p75 box, median tick. Raw
// min/max live in the tooltip only; as axis bounds they'd flatten the boxes.
export function WageDistribution({ data }) {
  const [ref, width] = useWidth();
  const [tip, setTip] = useState(null);
  const height = 240, mL = 56, mR = 14, mT = 12, mB = 24;
  const iw = Math.max(40, width - mL - mR), ih = height - mT - mB;
  const ticks = niceTicks(Math.max(...data.map((d) => d.p95 ?? 0), 1), 5);
  const yMax = ticks[ticks.length - 1];
  const y = (v) => mT + ih - ((v ?? 0) / yMax) * ih;
  const slot = iw / Math.max(data.length, 1);
  const boxW = Math.min(46, Math.max(8, slot * 0.5));
  const cx = (i) => mL + slot * (i + 0.5);
  const labelEvery = Math.ceil(data.length / Math.max(3, Math.floor(iw / 64)));
  const last = data.length - 1;

  const showTip = (e, d) => setTip({
    x: e.clientX, y: e.clientY,
    lines: [["", `FY${d.fy}`], ["Records", fmtNum(d.n)],
      ["Max", fmtUsd(d.hi)], ["95th pct", fmtUsd(d.p95)], ["75th pct", fmtUsd(d.p75)],
      ["Median", fmtUsd(d.p50)], ["25th pct", fmtUsd(d.p25)],
      ["5th pct", fmtUsd(d.p05)], ["Min", fmtUsd(d.lo)]],
  });

  return (
    <div ref={ref} style={{ position: "relative" }}>
      {data.length === 0 ? (
        <div className="chart-note" style={{ minHeight: height - 20 }}>No wage data for this selection.</div>
      ) : (
        <svg width={width} height={height} role="img" onMouseLeave={() => setTip(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={mL} x2={width - mR} y1={y(t)} y2={y(t)}
                stroke={t === 0 ? "var(--baseline)" : "var(--grid)"} strokeWidth="1" />
              <text x={mL - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)">
                {t === 0 ? "0" : `$${fmtCompact(t)}`}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = cx(i), hw = boxW / 2;
            const boxTop = y(d.p75), boxH = Math.max(2, y(d.p25) - y(d.p75));
            return (
              <g key={d.fy}
                onMouseMove={(e) => showTip(e, d)}>
                <rect x={x - slot / 2} y={mT} width={slot} height={ih} fill="transparent" />
                {/* 5th–95th percentile whisker with end caps */}
                <line x1={x} x2={x} y1={y(d.p95)} y2={y(d.p05)}
                  stroke="var(--series-1)" strokeWidth="2" opacity="0.45" />
                <line x1={x - hw * 0.55} x2={x + hw * 0.55} y1={y(d.p95)} y2={y(d.p95)}
                  stroke="var(--series-1)" strokeWidth="2" opacity="0.45" />
                <line x1={x - hw * 0.55} x2={x + hw * 0.55} y1={y(d.p05)} y2={y(d.p05)}
                  stroke="var(--series-1)" strokeWidth="2" opacity="0.45" />
                {/* p25–p75 box */}
                <rect x={x - hw} y={boxTop} width={boxW} height={boxH} rx="3"
                  fill="var(--series-1-wash)" stroke="var(--series-1)" strokeWidth="1.5" />
                {/* median tick */}
                <line x1={x - hw} x2={x + hw} y1={y(d.p50)} y2={y(d.p50)}
                  stroke="var(--series-1)" strokeWidth="2.5" />
                {i === last && (
                  <text x={x} y={y(d.p50) - 7} textAnchor="middle" fontSize="11.5" fontWeight="600"
                    fill="var(--text-primary)" stroke="var(--surface-1)" strokeWidth="3"
                    paintOrder="stroke">
                    {fmtUsd(d.p50)}
                  </text>
                )}
                {i % labelEvery === 0 && (
                  <text x={x} y={height - 7} textAnchor="middle" fontSize="11" fill="var(--text-muted)">
                    FY{d.fy}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}

// data: [{label, value, extra}] horizontal bars, single hue, value at tip.
// onPick (optional) makes rows clickable — used for drill-down selection.
export function TopBars({ data, valueFmt = fmtNum, extraLabel, onPick }) {
  const [ref, width] = useWidth();
  const [tip, setTip] = useState(null);
  const rowH = 26, barH = 16, labelW = Math.min(230, Math.max(120, width * 0.34));
  const mR = 56;
  const height = data.length * rowH + 6;
  const iw = Math.max(40, width - labelW - mR);
  const max = Math.max(...data.map((d) => d.value), 1);

  const bar = (v) => {
    const w = Math.max(2, (v / max) * iw);
    const r = Math.min(4, w / 2);
    // square at the baseline (left), 4px rounded data-end (right)
    return `M${labelW},0 h${w - r} a${r},${r} 0 0 1 ${r},${r} v${barH - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${w - r} Z`;
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      {data.length === 0 ? <div className="chart-note">No data for this selection.</div> : (
        <svg width={width} height={height} role="img" onMouseLeave={() => setTip(null)}>
          {data.map((d, i) => (
            <g key={i} transform={`translate(0,${i * rowH + 4})`}
              style={onPick ? { cursor: "pointer" } : undefined}
              onClick={onPick ? () => onPick(d) : undefined}
              onMouseMove={(e) => setTip({
                x: e.clientX, y: e.clientY,
                lines: [["", d.label], ["Records", fmtNum(d.value)],
                  ...(extraLabel && d.extra != null ? [[extraLabel, fmtUsd(d.extra)]] : []),
                  ...(onPick ? [["", "Click to drill in"]] : [])],
              })}>
              <rect x="0" y="-2" width={width} height={rowH - 2} fill="transparent" />
              <text x={labelW - 8} y={barH - 4} textAnchor="end" fontSize="11.5" fill="var(--text-secondary)">
                {d.label.length > (labelW - 12) / 7.5
                  ? d.label.slice(0, Math.floor((labelW - 12) / 7.5) - 1) + "…"
                  : d.label}
              </text>
              <path d={bar(d.value)} fill="var(--series-1)" />
              <text x={labelW + Math.max(2, (d.value / max) * iw) + 6} y={barH - 4}
                fontSize="11" fill="var(--text-muted)">
                {valueFmt(d.value)}
              </text>
            </g>
          ))}
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}
