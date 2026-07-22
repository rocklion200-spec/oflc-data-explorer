// Static "how to read this data" page. Everything here is explanatory prose;
// the only dynamic bits are the year ranges pulled from the manifest.

const spanLabel = (y) => `${y}–${String((y + 1) % 100).padStart(2, "0")}`;

export function HelpPage({ manifest }) {
  const fyRange = (prog) => {
    const fys = (manifest.programs[prog] || []).filter((f) => f.rows > 100).map((f) => f.fy);
    return fys.length ? `FY${Math.min(...fys)}–FY${Math.max(...fys)}` : "—";
  };
  const wy = manifest.wages?.years ?? [];
  const wyRange = wy.length ? `${spanLabel(wy[0])} through ${spanLabel(wy[wy.length - 1])}` : "—";

  return (
    <div className="help">
      <div className="panel">
        <h2>What this site is</h2>
        <p>
          This explorer sits on top of two public datasets from the U.S. Department of Labor&apos;s
          Office of Foreign Labor Certification (OFLC): the quarterly <strong>disclosure files </strong>
          of employer applications (the <em>Case explorer</em> tab), and the OFLC <strong>wage
          library</strong> of prevailing wage levels (the <em>Wage levels</em> tab). Everything runs
          in your browser — the tables you filter are queried directly from the published data files,
          and your searches are never sent to or run on a server.
        </p>
      </div>

      <div className="panel">
        <h2>The three case programs</h2>
        <table className="results help-table">
          <thead>
            <tr><th>Tab</th><th>What it is</th><th>Coverage</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>LCA</strong></td>
              <td>Labor Condition Applications (Form ETA-9035) that employers file before petitioning
                for H-1B, H-1B1 (Chile/Singapore) or E-3 (Australia) workers. One LCA can cover several
                positions (see the <em>Positions</em> column) and does not by itself mean anyone was
                hired — it is a prerequisite, filed before the H-1B petition to USCIS.</td>
              <td>{fyRange("lca")}</td>
            </tr>
            <tr>
              <td><strong>PERM</strong></td>
              <td>Applications for permanent labor certification (Form ETA-9089) — the first step of the
                employment-based green card process. A certified PERM means DOL agreed no qualified U.S.
                worker was available for that position at that wage.</td>
              <td>{fyRange("perm")}</td>
            </tr>
            <tr>
              <td><strong>Prevailing Wage</strong></td>
              <td>Prevailing Wage Determinations (Form ETA-9141) — employers ask DOL what the required
                wage is for a given occupation, worksite and skill level before filing a PERM or certain
                visa applications. These are wage rulings, not job applications.</td>
              <td>{fyRange("pwd")}</td>
            </tr>
          </tbody>
        </table>
        <p>
          Fiscal years run October–September (FY2026 began October 2025). Records are deduplicated by
          case number, keeping the latest decision; a case shows up in the fiscal year of its decision
          date (or received date when no decision has been made yet).
        </p>
      </div>

      <div className="panel">
        <h2>Reading a record</h2>
        <ul>
          <li><strong>Status.</strong> <em>Certified</em> means DOL approved the application — not that a
            visa was issued or the person was hired. <em>Certified – Withdrawn</em> usually means the
            employer withdrew after certification. <em>Denied</em> and <em>Withdrawn</em> are what they
            say. Prevailing-wage cases use <em>Determination Issued</em> instead.</li>
          <li><strong>Wage (annual).</strong> Employers report wages in different units (hour, week,
            month, year). This column annualizes them (hourly × 2,080 etc.). Filers sometimes pick the
            wrong unit — an annual salary labeled &quot;Hour&quot; would annualize to hundreds of millions —
            so implausible results are corrected to the raw amount when that looks like a salary, and
            otherwise left blank rather than poisoning the medians.</li>
          <li><strong>Prevailing (annual).</strong> The DOL-determined prevailing wage for the position,
            annualized the same way. The offered wage must be at least this.</li>
          <li><strong>PW level.</strong> The skill level (I–IV) the prevailing wage was set at — see the
            wage levels section below.</li>
          <li><strong>Positions.</strong> On LCAs, the number of workers the application covers. Counting
            records counts applications, not workers.</li>
        </ul>
      </div>

      <div className="panel">
        <h2>How employers, roles and places are grouped</h2>
        <p>
          Raw filings spell things every possible way, so the pipeline adds group columns that the
          charts, chips and search box use:
        </p>
        <ul>
          <li><strong>Employer group.</strong> Name variants (&quot;Google Inc.&quot;, &quot;GOOGLE LLC&quot;) are
            normalized, and a curated list folds known subsidiaries and rebrands into one family
            (e.g. AWS under Amazon). Grouping is heuristic — check the <em>Employer name</em> column
            when it matters.</li>
          <li><strong>Role group.</strong> Occupations are keyed by SOC code, with a crosswalk collapsing
            the 2000/2010/2018 SOC revisions (and older 3-digit codes) into one key, so a role&apos;s
            history spans the renumbering.</li>
          <li><strong>Title group.</strong> Job titles with seniority prefixes and level suffixes stripped
            (&quot;Sr. Software Engineer II&quot; → &quot;Software Engineer&quot;). Titles are only
            compared within an employer, since each one names the same job differently.</li>
          <li><strong>County group.</strong> Each worksite city is assigned its county (the most common
            county filed for that city), normalized across eras. Older files have no county column at
            all and New England files used towns — the grouping bridges both, which is what lets a
            county selection here match the wage library&apos;s county-level wage areas. Cities that
            straddle county lines get their single most common county.</li>
        </ul>
      </div>

      <div className="panel">
        <h2>Prevailing wage levels (the Wage levels tab)</h2>
        <p>
          The OFLC wage library publishes, for every occupation × wage area, four prevailing wage
          levels derived from the OEWS survey, effective each July through June
          (covering {wyRange}):
        </p>
        <ul>
          <li><strong>Level 1 (entry)</strong> — roughly the 17th percentile of surveyed wages;</li>
          <li><strong>Level 2 (qualified)</strong> — roughly the 34th percentile;</li>
          <li><strong>Level 3 (experienced)</strong> — the 50th percentile (median);</li>
          <li><strong>Level 4 (fully competent)</strong> — roughly the 67th percentile;</li>
          <li>plus the <strong>OEWS average</strong> (mean) wage.</li>
        </ul>
        <p>
          When DOL issues a prevailing wage determination it assigns one of these levels based on the
          job&apos;s requirements; that figure becomes the minimum the employer may offer. The
          &quot;Higher education (ACWIA)&quot; source is the separate table used for universities and
          affiliated nonprofits; it is generally lower than the all-industries table. Occupations OEWS
          publishes on an annual basis (teachers, athletes, pilots) are marked <em>Annual</em>; the
          hourly toggle converts at 2,080 hours/year.
        </p>
        <p>
          Some series show gaps: wage areas get redefined (New England switched from town-level to
          county-level areas in 2025), SOC codes get renumbered, and a few occupations only exist in
          one of the two source tables. Before wage year 2005 a different two-level system was used,
          so 2005 is as far back as the library goes.
        </p>
        <p>
          <strong>Comparing.</strong> Add several counties (or several occupations — one dimension at
          a time, up to 8) and the chart switches to a single wage level, one colored line per
          selection; the level buttons pick which. The top charts double as shortcuts: with an
          occupation selected they rank where it&apos;s filed most, and clicking a bar adds that county
          to the comparison.
        </p>
      </div>

      <div className="panel">
        <h2>Using the explorer</h2>
        <ul>
          <li><strong>Search</strong> for any employer, occupation or place; picking a result
            adds it as a chip. Chips combine — e.g. an employer plus a county shows that employer&apos;s
            filings there.</li>
          <li><strong>Job titles</strong> aren&apos;t searchable, because the same role is written a
            different way at every employer. Select an employer and a <em>Top job titles</em> chart
            appears alongside the others; click a bar there to add a title chip.</li>
          <li><strong>Click any bar</strong> in the top charts to drill into it; the back button undoes
            steps, and the URL always encodes the current view, so you can share or bookmark it.</li>
          <li><strong>Column filters</strong> sit under each table header. Text columns take a contains
            match or a checklist of values; numeric columns understand <code>&gt;150k</code>,{" "}
            <code>100k-200k</code>; date columns understand <code>2024-03</code> or{" "}
            <code>&gt;=2024-10-01</code>.</li>
          <li><strong>Columns ▾</strong> hides, shows and reorders columns (drag the headers works too);
            your layout is remembered per program.</li>
          <li><strong>⬇ Excel</strong> downloads the currently matching records with <em>every</em>{" "}
            column, capped at 50,000 rows so the file stays openable — narrow the filters or year range
            to get a complete set. The wage levels tab has its own <strong>⬇ Excel</strong>{" "}
            download that can cover many occupations and counties at once.</li>
          <li><strong>Cross-links.</strong> &quot;Wage levels for this role&quot; jumps from your chips to
            the wage library. It also works from a location alone, or from both at once
            (&quot;…for this role &amp; location&quot;), carrying the selected county — or the selected
            city&apos;s county — along; a statewide pick has no counterpart there, since the wage
            library is keyed by county. &quot;Filings for this occupation&quot; goes the other way.</li>
          <li><strong>Fiscal years</strong> default to the last two for speed; &quot;All years&quot; is
            fastest when an employer is selected (the data files are organized by employer).</li>
        </ul>
      </div>

      <div className="panel">
        <h2>Honest limitations</h2>
        <ul>
          <li>Applications ≠ people hired. LCAs especially are filed speculatively and can cover
            multiple positions; H-1B petitions, lottery selection and visa issuance happen elsewhere
            (USCIS/State) and are not in this data.</li>
          <li>All figures are as filed by employers. Typos, wrong units and misspelled cities exist;
            the pipeline corrects the systematic ones but not everything.</li>
          <li>Grouping (employers, titles, counties) is heuristic and errs on the side of merging
            common variants; the raw columns are always available for verification.</li>
          <li>Older files (before FY2020, and especially FY2008–2014) have fewer columns — no worksite
            address, sometimes no county or visa class — so those columns come up blank for old
            records, and derived ones (like county group) are inferred from the city.</li>
          <li><strong>PW level is blank for every FY2016 LCA.</strong> DOL dropped the wage-level column
            from that one year&apos;s H-1B disclosure file entirely (FY2015 and FY2017 both have it), so
            the field was never published rather than simply going unreported case by case. FY2016 PERM
            and prevailing-wage records are unaffected.</li>
          <li>DOL publishes disclosure files quarterly, so the current quarter is always incomplete.</li>
          <li>Nothing here is legal advice; for filings that matter, consult the official DOL/USCIS
            sources.</li>
        </ul>
        <p>
          Sources: <a href="https://www.dol.gov/agencies/eta/foreign-labor/performance" target="_blank"
          rel="noreferrer">OFLC performance disclosure data</a> and{" "}
          <a href="https://flag.dol.gov/wage-data/wage-data-downloads" target="_blank" rel="noreferrer">
          OFLC wage data downloads</a>.
        </p>
      </div>
    </div>
  );
}
