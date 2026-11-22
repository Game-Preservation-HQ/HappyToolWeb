// HappyTool's CSV and Excel import/export for .lng text tables (GUI/LngFileEditor.cs Export/Import CSV and Excel,
// TextResource/TextResourceLngCsv.cs and TextResourceLngExcel.cs). Export takes the catalog the grid builds
// (lng-tools fileFromRows); import returns a new catalog plus the counts and warnings the desktop's message shows.
import { validateLng } from './lng.js';
import { makeZip, readZip, deflateRaw } from './zip.js';
import { utf8 } from '../util.js';

const MAX_KEY = 256;
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Every key of the catalog, sorted ordinal, with one text per language ("" where a language lacks the key). */
function table(file) {
  const maps = file.languages.map((l) => new Map(l.entries.map((e) => [e.key, e.text ?? ''])));
  const keys = [...new Set(file.languages.flatMap((l) => l.entries.map((e) => e.key)))].sort(ordinal);
  return { names: file.languages.map((l) => l.name), rows: keys.map((k) => [k, ...maps.map((m) => m.get(k) ?? '')]) };
}

function checkForSave(file) {
  const problems = validateLng(file);
  if (problems.length) throw new Error(problems[0]);
}

// ---- import (shared) ----

/** Applies imported rows to a catalog. `rows` are { row, cells }; `langs` are [name, column] in column order. */
function applyRows(file, rows, keyCol, langs, tooLong) {
  const order = file.languages.map((l) => l.name);
  const maps = new Map(file.languages.map((l) => [l.name, new Map(l.entries.map((e) => [e.key, e.text ?? '']))]));
  const keys = new Set(file.languages.flatMap((l) => l.entries.map((e) => e.key)));
  for (const [name] of langs) {
    if (!maps.has(name)) {
      maps.set(name, new Map());
      order.push(name);
    }
  }
  const warnings = [];
  let keysAdded = 0, keysUpdated = 0;
  for (const { row, cells } of rows) {
    const key = (cells[keyCol] ?? '').trim();
    if (!key) continue;
    if (key.length >= MAX_KEY) {
      warnings.push(tooLong(row, key));
      continue;
    }
    if (keys.has(key)) keysUpdated++;
    else {
      keys.add(key);
      keysAdded++;
    }
    for (const [name, col] of langs) {
      const text = cells[col] ?? '';
      const m = maps.get(name);
      if (text !== '') m.set(key, text);
      else if (!m.has(key)) m.set(key, '');
    }
  }
  const sorted = [...keys].sort(ordinal);
  const out = { ...file, languages: order.map((name) => ({ name, entries: sorted.map((key) => ({ key, text: maps.get(name).get(key) ?? '' })) })) };
  checkForSave(out);
  return { file: out, keysAdded, keysUpdated, warnings };
}

/** ShowImportResultMessage text. */
export function importMessage(r) {
  const lines = ['Import complete.', `Keys added: ${r.keysAdded}`, `Keys updated: ${r.keysUpdated}`];
  if (r.warnings.length) {
    lines.push('', 'Warnings:');
    const max = Math.min(r.warnings.length, 12);
    for (let i = 0; i < max; i++) lines.push(`  • ${r.warnings[i]}`);
    if (r.warnings.length > max) lines.push(`  • … and ${r.warnings.length - max} more`);
  }
  return lines.join('\n');
}

// ---- CSV ----

const csvCell = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** UTF-8 with a BOM, comma separated, CRLF; header TEXT_ID then the language names. */
export function catalogToCsv(file) {
  checkForSave(file);
  const { names, rows } = table(file);
  const lines = [['TEXT_ID', ...names], ...rows].map((r) => r.map(csvCell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** CSV records. The desktop's field rules (a " toggles quoting anywhere, "" inside quotes is a quote), but a quoted
 *  field may span lines, so what Export CSV writes reads back. Empty lines are skipped. */
export function parseCsvRecords(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records = [];
  let rec = [], field = '', quoted = false;
  const endRecord = () => {
    rec.push(field);
    if (rec.length > 1 || rec[0] !== '') records.push(rec);
    rec = [];
    field = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      rec.push(field);
      field = '';
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRecord();
    } else field += c;
  }
  if (field !== '' || rec.length) endRecord();
  return records;
}

/** Import CSV: the key is column 0, languages are the other columns with a header. */
export function importCsv(file, text) {
  if (!text.replace(/^﻿/, '')) throw new Error('CSV file is empty.');
  const records = parseCsvRecords(text);
  if (!records.length) throw new Error('CSV file has no rows.');
  const header = records[0];
  if (header.length < 2) throw new Error('CSV header must include a key column and at least one language.');
  const langs = [];
  header.forEach((h, col) => {
    const name = h.trim();
    if (col > 0 && name && !langs.some(([n]) => n === name)) langs.push([name, col]);
  });
  if (!langs.length) throw new Error('No language columns in CSV header.');
  const rows = records.slice(1).map((cells, i) => ({ row: i + 2, cells }));
  return applyRows(file, rows, 0, langs, (row, key) => `Row ${row}: key is too long: ${key}`);
}

// ---- Excel (.xlsx) ----

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml';

const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** OOXML string escape: characters XML can't hold (and CR, which XML parsers fold into LF) become _xHHHH_,
 *  and a literal "_xHHHH_" keeps its underscore as _x005F_. */
const ooxmlText = (s) =>
  xmlEscape(s.replace(/_(?=x[0-9a-fA-F]{4}_)/g, '_x005F_').replace(/[\x00-\x08\x0b\x0c\x0d\x0e-\x1f￾￿]/g, (c) => `_x${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`));
const ooxmlDecode = (s) => s.replace(/_x([0-9a-fA-F]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

const colName = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const colIndex = (ref) => {
  let n = 0;
  for (const c of ref.toUpperCase().match(/^[A-Z]+/)?.[0] ?? '') n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
};

/** Export Excel: one sheet "Strings", A1 TEXT_ID, then the language names; every cell a string. Columns are sized
 *  to their longest line, 8 to 80 wide (the desktop's AutoFitColumns(8, 80) measures with the font). */
export async function catalogToXlsx(file) {
  checkForSave(file);
  const { names, rows } = table(file);
  const all = [['TEXT_ID', ...names], ...rows];
  const shared = new Map();
  const sst = (s) => {
    let i = shared.get(s);
    if (i === undefined) shared.set(s, (i = shared.size));
    return i;
  };
  const widths = all[0].map(() => 8);
  const sheetRows = all.map((r, ri) => {
    const cells = r.map((s, ci) => {
      const w = Math.max(...s.split(/\r?\n/).map((l) => l.length)) + 2;
      if (w > widths[ci]) widths[ci] = Math.min(80, w);
      return s === '' ? '' : `<c r="${colName(ci)}${ri + 1}" t="s"><v>${sst(s)}</v></c>`;
    });
    return `<row r="${ri + 1}">${cells.join('')}</row>`;
  });
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const sheet = `${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><dimension ref="A1:${colName(all[0].length - 1)}${all.length}"/>` +
    `<cols>${cols}</cols><sheetData>${sheetRows.join('')}</sheetData></worksheet>`;
  const strings = [...shared.keys()].map((s) => `<si><t${/^\s|\s$/.test(s) ? ' xml:space="preserve"' : ''}>${ooxmlText(s)}</t></si>`);
  const sstXml = `${XML_HEAD}<sst xmlns="${NS_MAIN}" count="${all.reduce((a, r) => a + r.filter((s) => s !== '').length, 0)}" uniqueCount="${shared.size}">${strings.join('')}</sst>`;
  const parts = [
    ['[Content_Types].xml', `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      `<Override PartName="/xl/workbook.xml" ContentType="${CT}.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${CT}.worksheet+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="${CT}.styles+xml"/>` +
      `<Override PartName="/xl/sharedStrings.xml" ContentType="${CT}.sharedStrings+xml"/></Types>`],
    ['_rels/.rels', `${XML_HEAD}<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets><sheet name="Strings" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${XML_HEAD}<Relationships xmlns="${NS_PKG}">` +
      `<Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId3" Type="${NS_REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`],
    ['xl/styles.xml', `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>` +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
    ['xl/worksheets/sheet1.xml', sheet],
    ['xl/sharedStrings.xml', sstXml],
  ];
  const files = [];
  for (const [name, xml] of parts) {
    const data = utf8.encode(xml);
    files.push({ name, data, deflated: await deflateRaw(data) });
  }
  const blob = makeZip(files);
  return new Blob([blob], { type: `${CT}.sheet` });
}

const parseXml = (u8) => {
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(u8), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('The Excel file is damaged (bad XML).');
  return doc;
};
const kids = (node, name) => [...node.getElementsByTagNameNS('*', name)];
/** The text of an <si> or <is>: its <t>, or the <t> of each rich-text run; phonetic runs (<rPh>) left out. */
const richText = (node) => kids(node, 't').filter((t) => t.parentNode.localName !== 'rPh').map((t) => t.textContent).join('');

/** Resolve a relationship target against the part it belongs to (xl/workbook.xml → xl/…). */
const resolve = (base, target) => {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const p of target.split('/')) {
    if (p === '..') parts.pop();
    else if (p !== '.') parts.push(p);
  }
  return parts.join('/');
};

/** The used rows of the "Strings" sheet (any case), else the first sheet: [{ row, cells }] with cells by column index. */
export async function readXlsxRows(u8) {
  let zip;
  try {
    zip = readZip(u8);
  } catch {
    throw new Error('This is not an Excel .xlsx workbook.');
  }
  const get = async (name) => {
    const key = [...zip.keys()].find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? parseXml(await zip.get(key)()) : null;
  };
  const wb = await get('xl/workbook.xml');
  if (!wb) throw new Error('This is not an Excel .xlsx workbook.');
  const sheets = kids(wb, 'sheet');
  if (!sheets.length) throw new Error('The Excel file has no worksheet data.');
  const sheet = sheets.find((s) => (s.getAttribute('name') ?? '').toLowerCase() === 'strings') ?? sheets[0];
  const rid = sheet.getAttributeNS(NS_REL, 'id') ?? sheet.getAttribute('r:id');
  const rels = await get('xl/_rels/workbook.xml.rels');
  const rel = rels && kids(rels, 'Relationship').find((r) => r.getAttribute('Id') === rid);
  const sheetDoc = rel ? await get(resolve('xl/workbook.xml', rel.getAttribute('Target'))) : null;
  if (!sheetDoc) throw new Error('The Excel file has no worksheet data.');
  const sstRel = rels && kids(rels, 'Relationship').find((r) => /\/sharedStrings$/.test(r.getAttribute('Type') ?? ''));
  const sstDoc = await get(sstRel ? resolve('xl/workbook.xml', sstRel.getAttribute('Target')) : 'xl/sharedStrings.xml');
  const sst = sstDoc ? kids(sstDoc, 'si').map((si) => ooxmlDecode(richText(si))) : [];
  const rows = [];
  let lastRow = 0;
  for (const r of kids(sheetDoc, 'row')) {
    const row = Number(r.getAttribute('r')) || lastRow + 1;
    lastRow = row;
    const cells = [];
    let lastCol = -1;
    for (const c of [...r.children].filter((x) => x.localName === 'c')) {
      const ref = c.getAttribute('r');
      const col = ref ? colIndex(ref) : lastCol + 1;
      lastCol = col;
      const t = c.getAttribute('t') ?? 'n';
      const v = kids(c, 'v')[0]?.textContent ?? '';
      let text;
      if (t === 's') text = sst[Number(v)] ?? '';
      else if (t === 'inlineStr') text = ooxmlDecode(kids(c, 'is').map(richText).join(''));
      else if (t === 'str') text = ooxmlDecode(v);
      else if (t === 'b') text = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : v;
      else text = v; // numbers and errors: the stored value (Excel would show it through the cell's number format)
      cells[col] = text;
    }
    rows.push({ row, cells });
  }
  if (!rows.length) throw new Error('The Excel file has no worksheet data.');
  return rows;
}

const KEY_HEADERS = new Set(['text_id', 'textid', 'key', 'id']);

/** Import Excel: header in row 1; the key column is the first headed TEXT_ID/Key/ID (any case), else column A. */
export async function importXlsx(file, u8) {
  const rows = await readXlsxRows(u8);
  const headerRow = rows.find((r) => r.row === 1);
  const header = headerRow ? [...headerRow.cells].map((s) => (s ?? '').trim()) : [];
  let keyCol = header.findIndex((h) => KEY_HEADERS.has(h.toLowerCase()));
  if (keyCol < 0) keyCol = 0;
  const langs = [];
  header.forEach((name, col) => {
    if (col !== keyCol && name && !langs.some(([n]) => n === name)) langs.push([name, col]);
  });
  if (!langs.length) throw new Error('No language columns were found in the header row.');
  return applyRows(file, rows.filter((r) => r.row >= 2), keyCol, langs, (row, key) => `Row ${row}: key is too long (max 255 ASCII bytes): ${key}`);
}
