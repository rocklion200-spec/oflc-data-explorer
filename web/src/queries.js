import { query, registerParquet } from "./db.js";

const esc = (s) => s.replace(/'/g, "''");

// FROM clause over the parquet files for the selected program + fiscal years
export async function scope(manifest, program, years) {
  const files = (manifest.programs[program] || [])
    .filter((f) => years.includes(f.fy) && f.rows > 100)
    .map((f) => f.file);
  await Promise.all(files.map(registerParquet));
  if (!files.length) return null;
  return `read_parquet([${files.map((f) => `'${f}'`).join(",")}], union_by_name=true)`;
}

export function whereClause(f) {
  const w = [];
  if (f.employer) w.push(`(employer_name ILIKE '%${esc(f.employer)}%')`);
  if (f.jobTitle) w.push(`(job_title ILIKE '%${esc(f.jobTitle)}%')`);
  if (f.soc) w.push(`(soc_code ILIKE '%${esc(f.soc)}%' OR soc_title ILIKE '%${esc(f.soc)}%')`);
  if (f.state) w.push(`worksite_state = '${esc(f.state)}'`);
  if (f.city) w.push(`(worksite_city ILIKE '%${esc(f.city)}%')`);
  if (f.status) w.push(`case_status = '${esc(f.status)}'`);
  if (f.visaClass) w.push(`visa_class = '${esc(f.visaClass)}'`);
  return w.length ? `WHERE ${w.join(" AND ")}` : "";
}

export async function fetchStats(from, where) {
  const [r] = await query(`
    SELECT count(*)::INT AS n,
           count(DISTINCT employer_name)::INT AS employers,
           round(median(wage_annual))::INT AS median_wage,
           round(100.0 * count(*) FILTER (case_status ILIKE 'Certified%') / nullif(count(*),0), 1) AS pct_certified
    FROM ${from} ${where}`);
  return r;
}

export async function fetchTrend(from, where) {
  return query(`
    SELECT strftime(date_trunc('month', decision_date), '%Y-%m') AS month,
           count(*)::INT AS n,
           round(median(wage_annual))::INT AS median_wage
    FROM ${from} ${where}
    ${where ? "AND" : "WHERE"} decision_date IS NOT NULL
    GROUP BY 1 ORDER BY 1`);
}

export async function fetchTopEmployers(from, where, limit = 15) {
  return query(`
    SELECT employer_name, count(*)::INT AS n, round(median(wage_annual))::INT AS median_wage
    FROM ${from} ${where}
    ${where ? "AND" : "WHERE"} employer_name IS NOT NULL
    GROUP BY 1 ORDER BY n DESC LIMIT ${limit}`);
}

export async function fetchRows(from, where, sort, page, pageSize) {
  return query(`
    SELECT case_number, case_status, visa_class,
           strftime(decision_date, '%Y-%m-%d') AS decision_date,
           employer_name, job_title, soc_code, soc_title,
           worksite_city, worksite_state,
           wage_annual, wage_from, wage_to, wage_unit, pw_annual, pw_wage_level
    FROM ${from} ${where}
    ORDER BY ${sort.col} ${sort.dir === "asc" ? "ASC" : "DESC"} NULLS LAST
    LIMIT ${pageSize} OFFSET ${page * pageSize}`);
}

export async function fetchOptions(from, col) {
  const rows = await query(
    `SELECT DISTINCT ${col} AS v FROM ${from} WHERE ${col} IS NOT NULL ORDER BY 1 LIMIT 200`);
  return rows.map((r) => r.v);
}
