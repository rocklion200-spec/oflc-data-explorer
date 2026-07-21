import { query, registerParquet } from "./db.js";
import { cachedQuery } from "./cache.js";

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

// Exact-match predicates for drill-down selections (group chips). A location
// can pin a city, or a whole county via the pipeline's county_key column
// (each city's filings carry its modal county, era-normalized).
export function selClause(sel = {}) {
  const w = [];
  if (sel.employer) w.push(`employer_group = '${esc(sel.employer.k)}'`);
  if (sel.soc) w.push(`soc_group = '${esc(sel.soc.k)}'`);
  if (sel.title) w.push(`title_group = '${esc(sel.title.k)}'`);
  if (sel.loc) {
    w.push(`worksite_state = '${esc(sel.loc.state)}'`);
    if (sel.loc.cityKey) w.push(`upper(trim(worksite_city)) = '${esc(sel.loc.cityKey)}'`);
    if (sel.loc.countyKey) w.push(`county_key = '${esc(sel.loc.countyKey)}'`);
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

const CERT_FILTER = `case_status ILIKE 'Certified%'
                 OR case_status ILIKE 'Determination Issued%'`;

const WAGE_QUANTILES = `
           count(wage_annual)::INT AS nw,
           round(min(wage_annual))::INT AS lo,
           round(quantile_cont(wage_annual, 0.05))::INT AS p05,
           round(quantile_cont(wage_annual, 0.25))::INT AS p25,
           round(median(wage_annual))::INT AS p50,
           round(quantile_cont(wage_annual, 0.75))::INT AS p75,
           round(quantile_cont(wage_annual, 0.95))::INT AS p95,
           round(max(wage_annual))::INT AS hi`;

// Header tiles and the per-FY wage distribution (quartile box, 5th–95th
// percentile whiskers — raw min/max are outlier-prone, a single $3M filing
// would flatten the chart, so they only go in the tooltip) come out of ONE
// row-level scan: an overall grouping-set row plus one row per fiscal year.
// Scans dominate load time over HTTP, so never pay for the same one twice.
export function fetchOverview(from, where, withWages, stale) {
  return cachedQuery(`ov|${withWages ? 1 : 0}|${from}|${where}`,
    () => fetchOverviewLive(from, where, withWages, stale));
}

async function fetchOverviewLive(from, where, withWages, stale) {
  const measures = `
           count(*)::INT AS n,
           count(DISTINCT employer_name)::INT AS employers,
           round(median(wage_annual))::INT AS median_wage,
           round(100.0 * count(*) FILTER (${CERT_FILTER})
                 / nullif(count(*),0), 1) AS pct_certified`;
  if (!withWages) {
    const [r] = await query(`SELECT ${measures} FROM ${from} ${where}`, stale);
    return { stats: r, wages: [] };
  }
  const rows = await query(`
    SELECT (GROUPING(fiscal_year) = 0) AS by_fy, fiscal_year AS fy,
           ${measures}, ${WAGE_QUANTILES}
    FROM ${from} ${where}
    GROUP BY GROUPING SETS ((), (fiscal_year))
    ORDER BY by_fy, fy`, stale);
  return {
    stats: rows.find((r) => !r.by_fy) || null,
    wages: rows.filter((r) => r.by_fy && r.nw > 0)
      .map((r) => ({ ...r, n: r.nw })),
  };
}

// `order` is a list of {col, dir} applied in sequence (tie-breakers).
export async function fetchRows(from, where, order, page, pageSize, stale) {
  const by = order
    .map((s) => `${s.col} ${s.dir === "asc" ? "ASC" : "DESC"} NULLS LAST`)
    .join(", ");
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
    ORDER BY ${by}
    LIMIT ${pageSize} OFFSET ${page * pageSize}`, stale, "bulk");
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
  // With a query, the dimension holding the most matching records leads —
  // "New York" appears in employer names too, but the location matches carry
  // far more filings, so that's almost surely what's meant. Without a query
  // (the focus dropdown), keep the canonical section order.
  const dimOrder = t
    ? "dim_n DESC"
    : `CASE dim WHEN 'employer' THEN 0 WHEN 'soc' THEN 1
       WHEN 'title' THEN 2 ELSE 3 END`;
  return query(`
    SELECT dim, k, label, n FROM (
      SELECT *, row_number() OVER (PARTITION BY dim ORDER BY n DESC) AS rn,
             sum(n) OVER (PARTITION BY dim) AS dim_n
      FROM search_groups ${cond}
    ) WHERE rn <= ${perDim}
    ORDER BY ${dimOrder}, n DESC`,
    stale);
}

const SUMMARY_FILE = { employer: "employers", soc: "soc", title: "titles" };

// Home-page tiles + wage chart without any row-level scan: the program_stats
// cube has one row per (program, fy) plus preset ranges (all years, last 2,
// last 5). It's ~70 rows, so it's fetched once and kept in memory.
let programStatsCache = null;
export function fetchProgramStats(manifest) {
  if (!programStatsCache) {
    programStatsCache = (async () => {
      const from = await aggFrom(manifest, "program_stats");
      if (!from) return null;
      return query(`SELECT * FROM ${from}`);
    })();
    programStatsCache.catch(() => { programStatsCache = null; }); // allow retry
  }
  return programStatsCache;
}

// One fetch returns everything the entity page header needs: the all-years
// all-programs rollup, per-program rollups, and the per-FY trend.
export function fetchEntitySummary(manifest, dim, key, stale) {
  return cachedQuery(`es|${dim}|${key}`,
    () => fetchEntitySummaryLive(manifest, dim, key, stale));
}

async function fetchEntitySummaryLive(manifest, dim, key, stale) {
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

export function fetchEntityTop(manifest, cube, key, stale, limit = 12) {
  return cachedQuery(`et|${cube}|${limit}|${key}`,
    () => fetchEntityTopLive(manifest, cube, key, stale, limit));
}

async function fetchEntityTopLive(manifest, cube, key, stale, limit) {
  const from = await aggFrom(manifest, cube);
  if (!from) return [];
  if (cube === "emp_loc" || cube === "soc_loc") {
    return query(`
      SELECT city || ', ' || state AS label2, state, city, city_key, n, median_wage,
             fy_lo, fy_hi
      FROM ${from} WHERE k = '${esc(key)}' AND city_key IS NOT NULL
      ORDER BY n DESC LIMIT ${limit}`, stale);
  }
  return query(`
    SELECT k2, label2, n, median_wage, fy_lo, fy_hi
    FROM ${from} WHERE k = '${esc(key)}' ORDER BY n DESC LIMIT ${limit}`, stale);
}

// Wage-library place -> case-explorer location selection ("closest match"):
// county_key joins directly, except pre-2025 New England places, which are
// towns rather than counties — there the town name doubles as the city.
export const NEW_ENGLAND = ["CT", "MA", "ME", "NH", "RI", "VT"];
export function locFromPlace(place) {
  if (!place?.key) return null;
  const label = `${place.county}, ${place.st}`;
  if (NEW_ENGLAND.includes(place.st) && place.y1 != null && place.y1 < 2025) {
    const city = place.county
      .replace(/\s+(town|city|plantation|gore|grant|location|purchase|township)$/i, "")
      .toUpperCase();
    return { state: place.st, cityKey: city, countyKey: null, label };
  }
  return { state: place.st, cityKey: null, countyKey: place.key, label };
}

// Batch city -> modal county key lookup for the wage view's top-locations
// chart (disclosure tops are cities; the wage library keys on counties).
export async function fetchCityCounties(manifest, cities, stale) {
  const from = await aggFrom(manifest, "city_county");
  if (!from || !cities.length) return {};
  const list = cities
    .map((c) => `'${esc(`${c.state}|${c.city_key}`)}'`).join(", ");
  const rows = await query(`
    SELECT state, city_key, county_key FROM ${from}
    WHERE state || '|' || city_key IN (${list})`, stale);
  const out = {};
  for (const r of rows) out[`${r.state}|${r.city_key}`] = r.county_key;
  return out;
}

// City -> its modal county key (the pipeline's agg/city_county file), used
// to carry a city selection over to the wage library's county picker.
export async function fetchCityCounty(manifest, state, cityKey, stale) {
  const from = await aggFrom(manifest, "city_county");
  if (!from) return null;
  const [r] = await query(`
    SELECT county_key FROM ${from}
    WHERE state = '${esc(state)}' AND city_key = '${esc(cityKey)}'`, stale);
  return r?.county_key ?? null;
}

// Full-width export of the current selection: every published column (not
// just the ones shown in the table), dates rendered as ISO strings. The
// row cap keeps the resulting .xlsx openable in Excel / Google Sheets.
export async function fetchExport(from, where, order, cap, stale) {
  const by = order
    .map((s) => `${s.col} ${s.dir === "asc" ? "ASC" : "DESC"} NULLS LAST`)
    .join(", ");
  const cols = await query(`DESCRIBE SELECT * FROM ${from} LIMIT 0`, stale);
  const limit = typeof cap === "function" ? cap(cols.length) : cap;
  const dates = cols.filter((c) => c.column_type === "DATE")
    .map((c) => c.column_name);
  const replace = dates.length
    ? `REPLACE (${dates.map((c) => `strftime(${c}, '%Y-%m-%d') AS ${c}`).join(", ")})`
    : "";
  const rows = await query(`
    SELECT * ${replace} FROM ${from} ${where}
    ORDER BY ${by} LIMIT ${limit}`, stale, "bulk");
  return { rows, columns: cols.map((c) => c.column_name) };
}

// Landing-page overview: first rows of the ordered *_top files (already
// sorted by n DESC, so LIMIT stops after the first row group). `cond` lets
// the locations chart keep to cities (statewide rollups would crowd it out).
export function fetchOverviewTop(manifest, name, stale, limit = 12, cond = null) {
  return cachedQuery(`ot|${name}|${limit}|${cond || ""}`, async () => {
    const from = await aggFrom(manifest, name);
    if (!from) return [];
    return query(
      `SELECT * FROM ${from} ${cond ? `WHERE ${cond}` : ""} LIMIT ${limit}`, stale);
  });
}

// ---------------------------------------------------------------------------
// Wage library (OFLC wage-data downloads): OEWS-based prevailing wage levels
// per (wage year, area, SOC, source). Trend lookups key on soc_2018 — the
// pipeline bridges the 2021-22 file's SOC-2010 codes — and resolve a picked
// county to each year's area code via the per-year geo table, which keeps
// trends honest across OMB area redefinitions (a county simply has no row in
// years whose geography doesn't list it).

export const hasWages = (manifest) => !!manifest.wages;

// wages is sharded across several parquets (GitHub's file-size cap); the
// manifest entry then carries `files` instead of `file`
async function wageFrom(manifest, name) {
  const e = manifest.wages?.files?.[name];
  const files = e?.files ?? (e?.file ? [e.file] : []);
  if (!files.length) return null;
  await Promise.all(files.map(registerParquet));
  return `read_parquet([${files.map((f) => `'${f}'`).join(", ")}])`;
}

// Picker indexes, loaded once: ~1k occupations (incl. OFLC's R&D/non-R&D
// split codes, which the ACWIA table uses exclusively for some roles) and ~5.7k
// county/town keys with their year coverage. Places group on county_key, the
// pipeline's era-stable name (legacy years spell counties differently), shown
// under their most recent spelling; keys that only exist in one era (e.g. New
// England towns before the 2025 switch to counties) surface their y0–y1 span.
let wageIndexCache = null;
export function loadWageIndex(manifest) {
  if (!wageIndexCache) {
    wageIndexCache = (async () => {
      const occ = await wageFrom(manifest, "socs");
      const geo = await wageFrom(manifest, "geo");
      if (!occ || !geo) return null;
      // SELECT * so the optional group_code column (the occupation's
      // disclosure-data soc_group, for cross-linking to filings) comes
      // along when the published file has it
      const occs = await query(`SELECT * FROM ${occ}`);
      const places = await query(`
        SELECT state_ab AS st, arg_max(state, wage_year) AS state,
               county_key AS key, arg_max(county, wage_year) AS county,
               min(wage_year)::INT AS y0, max(wage_year)::INT AS y1,
               arg_max(area_name, wage_year) AS area_name
        FROM ${geo} GROUP BY state_ab, county_key ORDER BY st, county`);
      return { occs, places };
    })();
    wageIndexCache.catch(() => { wageIndexCache = null; }); // allow retry
  }
  return wageIndexCache;
}

// One row per wage year for a (SOC, county, source) pick; countyKey is the
// era-stable place key, not the display name. Where the SOC bridge folds
// several old codes into one modern one (pre-2022 wage years), levels are
// averaged and `codes` names the constituents.
export function fetchWageTrend(manifest, soc, st, countyKey, source, stale) {
  return cachedQuery(`wt|${source}|${st}|${countyKey}|${soc}`, async () => {
    const w = await wageFrom(manifest, "wages");
    const g = await wageFrom(manifest, "geo");
    if (!w || !g) return [];
    return query(`
      SELECT w.wage_year AS year, any_value(g.area_name) AS area_name,
             string_agg(DISTINCT w.soc_code, ' + ') AS codes,
             avg(w.level1) AS l1, avg(w.level2) AS l2,
             avg(w.level3) AS l3, avg(w.level4) AS l4,
             avg(w.average) AS average,
             bool_or(w.annual) AS annual, any_value(w.note) AS note
      FROM ${w} w JOIN ${g} g ON g.wage_year = w.wage_year AND g.area = w.area
      WHERE w.soc_2018 = '${esc(soc)}' AND w.source = '${esc(source)}'
        AND g.state_ab = '${esc(st)}' AND g.county_key = '${esc(countyKey)}'
      GROUP BY 1 ORDER BY 1`, stale);
  });
}

// Wage-library export: raw published rows (no cross-code averaging — the
// original soc_code column says which vintage's code each row carried) for
// any set of occupations and counties under one source table.
export async function fetchWageRowsMulti(manifest, socs, places, source, stale) {
  if (!socs.length || !places.length) return [];
  const w = await wageFrom(manifest, "wages");
  const g = await wageFrom(manifest, "geo");
  if (!w || !g) return [];
  const socList = socs.map((s) => `'${esc(s)}'`).join(", ");
  const placeList = places
    .map((p) => `'${esc(`${p.st}|${p.key}`)}'`).join(", ");
  return query(`
    SELECT w.wage_year, w.source, w.soc_2018, w.soc_code,
           g.state_ab, g.county, g.area_name,
           w.level1, w.level2, w.level3, w.level4, w.average,
           w.annual, w.note
    FROM ${w} w JOIN ${g} g ON g.wage_year = w.wage_year AND g.area = w.area
    WHERE w.source = '${esc(source)}' AND w.soc_2018 IN (${socList})
      AND g.state_ab || '|' || g.county_key IN (${placeList})
    ORDER BY w.soc_2018, g.state_ab, g.county, w.wage_year, w.soc_code`,
    stale, "bulk");
}

// Row-level top-N for the combined drill view (2+ selections). All requested
// dimensions share ONE scan via grouping sets; ranking happens per set with a
// window so each dimension gets its own top-N. labelExpr turns group keys
// into readable labels. Returns { dim: [{k, label, n, median_wage}] }.
export function fetchTopGroupsMulti(from, where, dims, stale, limit = 10) {
  if (!dims.length) return Promise.resolve({});
  return cachedQuery(
    `tg|${limit}|${dims.map((d) => d.dim).join(",")}|${from}|${where}`,
    () => fetchTopGroupsMultiLive(from, where, dims, stale, limit));
}

async function fetchTopGroupsMultiLive(from, where, dims, stale, limit) {
  const keyCols = dims.map((d) => `${d.col} AS k_${d.dim}`);
  const labCols = dims.map((d) => `${d.labelExpr} AS lab_${d.dim}`);
  const sets = dims.map((d) => `(${d.col})`).join(", ");
  // per-set NULL keys (rows missing that column) would otherwise rank first
  const notNull = dims
    .map((d) => `(GROUPING(${d.col}) = 1 OR ${d.col} IS NOT NULL)`)
    .join(" AND ");
  const rows = await query(`
    SELECT * FROM (
      SELECT g.*, row_number() OVER (PARTITION BY gid ORDER BY n DESC) AS rn
      FROM (
        SELECT GROUPING_ID(${dims.map((d) => d.col).join(", ")}) AS gid,
               ${dims.map((d) => `(GROUPING(${d.col}) = 0) AS is_${d.dim}`).join(", ")},
               ${keyCols.join(", ")}, ${labCols.join(", ")},
               count(*)::INT AS n,
               round(median(wage_annual))::INT AS median_wage,
               min(fiscal_year)::INT AS fy_lo, max(fiscal_year)::INT AS fy_hi
        FROM ${from} ${where}
        GROUP BY GROUPING SETS (${sets})
        HAVING ${notNull}
      ) g
    ) WHERE rn <= ${limit}
    ORDER BY gid, rn`, stale);
  const out = {};
  for (const d of dims) out[d.dim] = [];
  for (const r of rows) {
    const d = dims.find((d) => r[`is_${d.dim}`]);
    if (d) out[d.dim].push({
      k: r[`k_${d.dim}`], label: r[`lab_${d.dim}`],
      n: r.n, median_wage: r.median_wage, fy_lo: r.fy_lo, fy_hi: r.fy_hi,
    });
  }
  return out;
}
