// Minimal .xlsx writer: an OOXML workbook is a zip of XML parts, and fflate
// gives us the zip. Strings go in as inline strings (no shared-string table
// needed), numbers as native numeric cells, so Excel, Google Sheets and
// LibreOffice all open the result and sort/filter it correctly.
import { strToU8, zipSync } from "fflate";

const XML_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;

const escXml = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  // control chars are illegal in XML 1.0 and crash Excel's parser
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

// 0 -> A, 25 -> Z, 26 -> AA ...
function colRef(i) {
  let s = "";
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) {
    s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  }
  return s;
}

// columns: [{key, label}], rows: array of objects
function sheetXml(columns, rows) {
  const parts = [XML_HEAD,
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`,
    `<sheetData>`];
  parts.push(`<row r="1">` + columns.map((c, i) =>
    `<c r="${colRef(i)}1" t="inlineStr" s="1"><is><t>${escXml(c.label)}</t></is></c>`
  ).join("") + `</row>`);
  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri];
    const cells = [];
    for (let ci = 0; ci < columns.length; ci++) {
      const v = r[columns[ci].key];
      if (v == null || v === "") continue;
      const ref = `${colRef(ci)}${ri + 2}`;
      if (typeof v === "number" && Number.isFinite(v)) {
        cells.push(`<c r="${ref}"><v>${v}</v></c>`);
      } else if (typeof v === "boolean") {
        cells.push(`<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`);
      } else {
        cells.push(`<c r="${ref}" t="inlineStr"><is><t>${escXml(v)}</t></is></c>`);
      }
    }
    parts.push(`<row r="${ri + 2}">${cells.join("")}</row>`);
  }
  parts.push(`</sheetData></worksheet>`);
  return parts.join("");
}

const STYLES = XML_HEAD + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="2"><xf xfId="0"/><xf fontId="1" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>`;

const sheetName = (s) => s.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet";

// sheets: [{name, columns: [{key, label}], rows: [...]}] -> triggers download
export function downloadXlsx(filename, sheets) {
  const files = {
    "[Content_Types].xml": XML_HEAD +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      sheets.map((_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      ).join("") + `</Types>`,
    "_rels/.rels": XML_HEAD +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
    "xl/workbook.xml": XML_HEAD +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
      sheets.map((s, i) =>
        `<sheet name="${escXml(sheetName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
      ).join("") + `</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": XML_HEAD +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets.map((_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
      ).join("") +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`,
    "xl/styles.xml": STYLES,
  };
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s.columns, s.rows));
  });
  for (const k of Object.keys(files)) {
    if (typeof files[k] === "string") files[k] = strToU8(files[k]);
  }
  const blob = new Blob([zipSync(files, { level: 6 })], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// How many rows an export may carry: a total-cell budget (rows × columns)
// keeps files small enough that Excel and Google Sheets open them without
// choking, with a hard row cap as belt-and-braces.
export const exportRowCap = (ncols) =>
  Math.max(1000, Math.min(50000, Math.floor(2_000_000 / Math.max(ncols, 1))));
