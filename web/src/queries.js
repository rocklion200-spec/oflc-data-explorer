import { query, registerParquet } from "./db.js";

const esc = (s) => s.replace(/'/g, "''");

// Column types drive how per-column filters are parsed and rendered.
export const COLUMN_TYPES = {
  case_number: "text", case_status: "text", visa_class: "text",
  employer_name: "text", employer_city: "text", employer_state: "text",
  naics_code: "text", job_title: "text", soc_code: "text", soc_title: "text",
  worksite_city: "text", worksite_county: "text", worksite_state: "text",
  worksite_postal_code: "text", wage_unit: "text", pw_wage_level: "text",
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

function columnPredicate(col, raw) {
  const v = raw.trim();
  if (!v || !(col in COLUMN_TYPES)) return null;
  const type = COLUMN_TYPES[col];
  if (type === "num") return numPredicate(col, v);
  if (type === "date") return datePredicate(col, v);
  return `${col} ILIKE '%${esc(v)}%'`;
}

export function whereClause(f, colFilters = {}) {
  const w = [];
  if (f.employer) w.push(`(employer_name ILIKE '%${esc(f.employer)}%')`);
  if (f.jobTitle) w.push(`(job_title ILIKE '%${esc(f.jobTitle)}%')`);
  if (f.soc) w.push(`(soc_code ILIKE '%${esc(f.soc)}%' OR soc_title ILIKE '%${esc(f.soc)}%')`);
  if (f.state) w.push(`worksite_state = '${esc(f.state)}'`);
  if (f.city) w.push(`(worksite_city ILIKE '%${esc(f.city)}%')`);
  if (f.status) w.push(`case_status = '${esc(f.status)}'`);
  if (f.visaClass) w.push(`visa_class = '${esc(f.visaClass)}'`);
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

export async function fetchTrend(from, where, stale) {
  return query(`
    SELECT strftime(date_trunc('month', decision_date), '%Y-%m') AS month,
           count(*)::INT AS n,
           round(median(wage_annual))::INT AS median_wage
    FROM ${from} ${andWhere(where, "decision_date IS NOT NULL")}
    GROUP BY 1 ORDER BY 1`, stale);
}

export async function fetchTopEmployers(from, where, stale, limit = 15) {
  return query(`
    SELECT employer_name, count(*)::INT AS n, round(median(wage_annual))::INT AS median_wage
    FROM ${from} ${andWhere(where, "employer_name IS NOT NULL")}
    GROUP BY 1 ORDER BY n DESC LIMIT ${limit}`, stale);
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
           worksite_city, worksite_county, worksite_state, worksite_postal_code,
           wage_annual, wage_from, wage_to, wage_unit,
           pw_annual, pw_wage, pw_wage_level,
           full_time_position, total_workers, fiscal_year
    FROM ${from} ${where}
    ORDER BY ${sort.col} ${sort.dir === "asc" ? "ASC" : "DESC"} NULLS LAST
    LIMIT ${pageSize} OFFSET ${page * pageSize}`, stale);
}

export async function fetchOptions(from, col, stale) {
  const rows = await query(
    `SELECT DISTINCT ${col} AS v FROM ${from} WHERE ${col} IS NOT NULL ORDER BY 1 LIMIT 200`,
    stale);
  return rows.map((r) => r.v);
}

// Autocomplete: distinct values of `col` matching the typed text, under every
// other active filter, most frequent first. Values remain partial-match
// filters when applied, so picking a suggestion never narrows to one spelling.
export async function fetchSuggestions(from, where, col, text, stale, limit = 12) {
  const cond = text
    ? `${col} IS NOT NULL AND ${col} ILIKE '%${esc(text)}%'`
    : `${col} IS NOT NULL`;
  const rows = await query(`
    SELECT ${col} AS v, count(*)::INT AS n
    FROM ${from} ${andWhere(where, cond)}
    GROUP BY 1 ORDER BY n DESC, v LIMIT ${limit}`, stale);
  return rows;
}
