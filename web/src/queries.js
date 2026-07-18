import { query, registerParquet } from "./db.js";

const esc = (s) => s.replace(/'/g, "''");

// Column types drive how per-column filters are parsed and rendered.
export const COLUMN_TYPES = {
  case_number: "text", case_status: "text", visa_class: "text",
  employer_name: "text", employer_city: "text", employer_state: "text",
  employer_group: "text", soc_group: "text", title_group: "text",
  naics_code: "text", job_title: "text", soc_code: "text", soc_title: "text",
  worksite_address: "text", worksite_city: "text", worksite_county: "text",
  worksite_state: "text", worksite_postal_code: "text",
  wage_unit: "text", pw_wage_level: "text",
  full_time_position: "text",
  wage_from: "num", wage_to: "num", wage_annual: "num",
  pw_wage: "num", pw_annual: "num", total_workers: "num", fiscal_year: "num",
  received_date: "date", decision_date: "date",
  begin_date: "date", end_date: "date",
};

// FROM clause over the parquet files for the selected program + fiscal years
export async function scope(manifest, program, years) {
  const files = (manifest.programs[program] || [])
    .filter((f) => years.includes(f.fy) && f.rows > 100)
    .map((f) => f.file);
  await Promise.all(files.map(registerParquet));
  if (!files.length) return null;
  return `read_parquet([${files.map((f) => `'${f}'`).join(",")}], union_by_name=true)`;
}

// "175000", "$175,000", "150k", ">=100000", "<150k", "100k-200k" -> predicate
function numPredicate(col, raw) {
  const amount = (s) => {
    const m = s.trim().match(/^\$?([\d.,]+)\s*([km])?$/i);
    if (!m) return null;
    const v = parseFloat(m[1].replace(/,/g, ""));
    if (!Number.isFinite(v)) return null;
    return v * (m[2]?.toLowerCase() === "m" ? 1e6 : m[2] ? 1e3 : 1);
  };
  const cmp = raw.match(/^(>=|<=|>|<|=)\s*(.+)$/);
  if (cmp) {
    const v = amount(cmp[2]);
    return v == null ? null : `${col} ${cmp[1]} ${v}`;
  }
  const range = raw.match(/^(.+?)\s*(?:-|\.\.)\s*(\$?[\d.,]+\s*[km]?)$/i);
  if (range) {
    const lo = amount(range[1]), hi = amount(range[2]);
    if (lo != null && hi != null) return `${col} BETWEEN ${lo} AND ${hi}`;
  }
  const v = amount(raw);
  return v == null ? null : `${col} = ${v}`;
}

// "2024", "2024-03", "2024-03-15", ">=2024-01-01", "<2025" -> predicate
function datePredicate(col, raw) {
  const cmp = raw.match(/^(>=|<=|>|<)\s*(\d{4}(?:-\d{2})?(?:-\d{2})?)$/);
  if (cmp) {
    const iso = cmp[2].length === 4 ? `${cmp[2]}-01-01`
      : cmp[2].length === 7 ? `${cmp[2]}-01` : cmp[2];
    return `${col} ${cmp[1]} DATE '${iso}'`;
  }
  if (/^[\d-]+$/.test(raw)) return `strftime(${col}, '%Y-%m-%d') LIKE '${esc(raw)}%'`;
  return null;
}

// Text columns carry an Excel-style filter object: checked values and
// "select all" contains-terms OR together and win over the typed text
// (which otherwise applies as a contains match).
function columnPredicate(col, raw) {
  if (!(col in COLUMN_TYPES)) return null;
  if (raw && typeof raw === "object") {
    const parts = [];
    if (raw.values?.length) {
      parts.push(`${col} IN (${raw.values.map((v) => `'${esc(v)}'`).join(",")})`);
    }
    for (const t of raw.terms || []) parts.push(`${col} ILIKE '%${esc(t)}%'`);
    if (parts.length) return parts.join(" OR ");
    raw = raw.text || "";
  }
  const v = raw.trim();
  if (!v) return null;
  const type = COLUMN_TYPES[col];
  if (type === "num") return numPredicate(col, v);
  if (type === "date") return datePredicate(col, v);
  return `${col} ILIKE '%${esc(v)}%'`;
}

// Exact-match predicates for drill-down selections (group chips).
export function selClause(sel = {}) {
  const w = [];
  if (sel.employer) w.push(`employer_group = '${esc(sel.employer.k)}'`);
  if (sel.soc) w.push(`soc_group = '${esc(sel.soc.k)}'`);
  if (sel.title) w.push(`title_group = '${esc(sel.title.k)}'`);
  if (sel.loc) {
    w.push(`worksite_state = '${esc(sel.loc.state)}'`);
    if (sel.loc.cityKey) w.push(`upper(trim(worksite_city)) = '${esc(sel.loc.cityKey)}'`);
  }
  return w;
}

export function whereClause(colFilters = {}, sel = {}) {
  const w = selClause(sel);
  for (const [col, raw] of Object.entries(colFilters)) {
    const pred = columnPredicate(col, raw);
    if (pred) w.push(`(${pred})`);
  }
  return w.length ? `WHERE ${w.join(" AND ")}` : "";
}

const andWhere = (where, cond) => (where ? `${where} AND ${cond}` : `WHERE ${cond}`);

export async function fetchStats(from, where, stale) {
  const [r] = await query(`
    SELECT count(*)::INT AS n,
           count(DISTINCT employer_name)::INT AS employers,
           round(median(wage_annual))::INT AS median_wage,
           round(100.0 * count(*) FILTER (case_status ILIKE 'Certified%'
                 OR case_status ILIKE 'Determination Issued%') / nullif(count(*),0), 1) AS pct_certified
    FROM ${from} ${where}`, stale);
  return r;
}

// Wage distribution per fiscal year for the box-style annual wage chart:
// quartile box, 5th–95th percentile whiskers (raw min/max are outlier-prone
// — a single $3M filing would flatten the chart — so they only go in the
// tooltip).
export async function fetchWageByYear(from, where, stale) {
  return query(`
    SELECT fiscal_year AS fy, count(*)::INT AS n,
           round(min(wage_annual))::INT AS lo,
           round(quantile_cont(wage_annual, 0.05))::INT AS p05,
           round(quantile_cont(wage_annual, 0.25))::INT AS p25,
           round(median(wage_annual))::INT AS p50,
           round(quantile_cont(wage_annual, 0.75))::INT AS p75,
           round(quantile_cont(wage_annual, 0.95))::INT AS p95,
           round(max(wage_annual))::INT AS hi
    FROM ${from} ${andWhere(where, "wage_annual IS NOT NULL")}
    GROUP BY 1 ORDER BY 1`, stale);
}

export async function fetchRows(from, where, sort, page, pageSize, stale) {
  return query(`
    SELECT case_number, case_status, visa_class,
           strftime(received_date, '%Y-%m-%d') AS received_date,
           strftime(decision_date, '%Y-%m-%d') AS decision_date,
           strftime(begin_date, '%Y-%m-%d') AS begin_date,
           strftime(end_date, '%Y-%m-%d') AS end_date,
           employer_name, employer_city, employer_state, naics_code,
           job_title, soc_code, soc_title,
           worksite_address, worksite_city, worksite_county, worksite_state,
           worksite_postal_code,
           wage_annual, wage_from, wage_to, wage_unit,
           pw_annual, pw_wage, pw_wage_level,
           full_time_position, total_workers, fiscal_year,
           employer_group, soc_group, title_group
    FROM ${from} ${where}
    ORDER BY ${sort.col} ${sort.dir === "asc" ? "ASC" : "DESC"} NULLS LAST
    LIMIT ${pageSize} OFFSET ${page * pageSize}`, stale);
}

// Excel-style column filter values: distinct values of `col` matching the
// typed text, under every other active filter, most frequent first.
export async function fetchColumnValues(from, where, col, text, stale, limit = 50) {
  const cond = text
    ? `${col} IS NOT NULL AND ${col} ILIKE '%${esc(text)}%'`
    : `${col} IS NOT NULL`;
  const rows = await query(`
    SELECT ${col} AS v, count(*)::INT AS n
    FROM ${from} ${andWhere(where, cond)}
    GROUP BY 1 ORDER BY n DESC, v LIMIT ${limit}`, stale);
  return rows;
}

// ---------------------------------------------------------------------------
// Precomputed aggregate ("cube") layer — powers group search, entity pages and
// clickable drill-down without scanning row-level parquet. Files are sorted by
// their leading key, so HTTP range reads prune to a couple of row groups.

async function aggFrom(manifest, name) {
  const f = manifest.aggregates?.[name]?.file;
  if (!f) return null;
  await registerParquet(f);
  return `read_parquet('${f}')`;
}

export const hasAggregates = (manifest) => !!manifest.aggregates;

// Unified group search: the *_top files (one row per group, ordered by
// size) are loaded once into a local table so every keystroke is in-memory.
let searchReady = null;
export function ensureSearchTable(manifest) {
  if (!searchReady) {
    searchReady = (async () => {
      const parts = [];
      for (const [dim, name] of [["employer", "employers_top"],
                                 ["soc", "soc_top"], ["title", "titles_top"],
                                 ["loc", "locations_top"]]) {
        const from = await aggFrom(manifest, name);
        if (from) parts.push(`SELECT '${dim}' AS dim, k, label, n FROM ${from}`);
      }
      if (!parts.length) throw new Error("aggregate files missing");
      await query(`CREATE TABLE IF NOT EXISTS search_groups AS
                   ${parts.join(" UNION ALL ")}`);
    })();
    searchReady.catch(() => { searchReady = null; }); // allow retry
  }
  return searchReady;
}

export async function searchGroups(manifest, text, stale, perDim = 5) {
  await ensureSearchTable(manifest);
  const t = esc(text.trim());
  const cond = t ? `WHERE label ILIKE '%${t}%' OR k ILIKE '%${t}%'` : "";
  return query(`
    SELECT dim, k, label, n FROM (
      SELECT *, row_number() OVER (PARTITION BY dim ORDER BY n DESC) AS rn
      FROM search_groups ${cond}
    ) WHERE rn <= ${perDim}
    ORDER BY CASE dim WHEN 'employer' THEN 0 WHEN 'soc' THEN 1
             WHEN 'title' THEN 2 ELSE 3 END, n DESC`,
    stale);
}

const SUMMARY_FILE = { employer: "employers", soc: "soc", title: "titles" };

// One fetch returns everything the entity page header needs: the all-years
// all-programs rollup, per-program rollups, and the per-FY trend.
export async function fetchEntitySummary(manifest, dim, key, stale) {
  const from = await aggFrom(manifest, SUMMARY_FILE[dim]);
  if (!from) return null;
  const rows = await query(
    `SELECT * FROM ${from} WHERE k = '${esc(key)}'`, stale);
  return {
    overall: rows.find((r) => r.program == null && r.fy == null) || null,
    programs: rows.filter((r) => r.program != null && r.fy == null),
    trend: rows.filter((r) => r.program == null && r.fy != null)
      .sort((a, b) => a.fy - b.fy),
  };
}

export async function fetchEntityTop(manifest, cube, key, stale, limit = 12) {
  const from = await aggFrom(manifest, cube);
  if (!from) return [];
  if (cube === "emp_loc" || cube === "soc_loc") {
    return query(`
      SELECT city || ', ' || state AS label2, state, city, city_key, n, median_wage
      FROM ${from} WHERE k = '${esc(key)}' AND city_key IS NOT NULL
      ORDER BY n DESC LIMIT ${limit}`, stale);
  }
  return query(`
    SELECT k2, label2, n, median_wage
    FROM ${from} WHERE k = '${esc(key)}' ORDER BY n DESC LIMIT ${limit}`, stale);
}

// Landing-page overview: first rows of the ordered *_top files (already
// sorted by n DESC, so LIMIT stops after the first row group). `cond` lets
// the locations chart keep to cities (statewide rollups would crowd it out).
export async function fetchOverviewTop(manifest, name, stale, limit = 12, cond = null) {
  const from = await aggFrom(manifest, name);
  if (!from) return [];
  return query(
    `SELECT * FROM ${from} ${cond ? `WHERE ${cond}` : ""} LIMIT ${limit}`, stale);
}

// Row-level top-N for the combined drill view (2+ selections), one query per
// unselected dimension. labelExpr turns group keys into readable labels.
export async function fetchTopGroups(from, where, col, labelExpr, stale, limit = 10) {
  return query(`
    SELECT ${col} AS k, ${labelExpr} AS label, count(*)::INT AS n,
           round(median(wage_annual))::INT AS median_wage
    FROM ${from} ${andWhere(where, `${col} IS NOT NULL`)}
    GROUP BY 1 ORDER BY n DESC LIMIT ${limit}`, stale);
}
