// HappyTool's .lng checks and merges: Validate translations, Translation statistics and Fill missing from language
// (GUI/LngFileEditor.cs), Merge (TextResource/TextResourceLngCatalog.cs Merge) and Compare (TextResourceLngCompare.cs).
// Grid rows are { key, t: [text or null per language] }, as the .lng view keeps them.
import { validateLng } from './lng.js';

const MAX_LANGUAGES = 16;
const MAX_KEY = 256;
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const OPEN_FONT = /<font\s+color\s*=\s*"(#?[0-9a-fA-F]{3,8})"\s*>/i; // LngFontColorMarkup.OpenFontTag
const n0 = (n) => n.toLocaleString(); // .NET "N0"

/** True when the text has a <font color="…"> tag (LngFontColorMarkup.ContainsFontColor). */
export const containsFontColor = (s) => !!s && OPEN_FONT.test(s);

/** BuildCatalogFromGrid: every row with a key, in every language, missing text as "". */
export function fileFromRows(file, rows) {
  const keyed = rows.map((r) => [r.key.trim(), r]).filter(([k]) => k);
  return {
    ...file,
    languages: file.languages.map((l, i) => ({ name: l.name, entries: keyed.map(([key, r]) => ({ key, text: r.t[i] ?? '' })) })),
  };
}

/** Validate translations: empty texts per language. Returns { keys, lines } (no lines = all filled). */
export function validateRows(rows, names) {
  const keys = new Set();
  const missing = new Map();
  for (const r of rows) {
    const key = r.key.trim();
    if (!key) continue;
    keys.add(key);
    names.forEach((n, i) => {
      if ((r.t[i] ?? '') !== '') return;
      if (!missing.has(n)) missing.set(n, []);
      missing.get(n).push(key);
    });
  }
  const lines = [];
  for (const [n, list] of [...missing].sort((a, b) => ordinal(a[0], b[0]))) {
    lines.push(`${n}: ${list.length} empty translation(s).`);
    const show = Math.min(list.length, 8);
    for (let i = 0; i < show; i++) lines.push(`  • ${n} / ${list[i]}`);
    if (list.length > show) lines.push(`  • … and ${list.length - show} more`);
  }
  return { keys: keys.size, lines };
}

/** Translation statistics report text. Empty and markup counts include rows without a key, as the desktop's do. */
export function statisticsReport(rows, names) {
  const out = [`Keys: ${rows.filter((r) => r.key.trim()).length}`, `Languages: ${names.length}`, ''];
  names.forEach((n, i) => {
    let empty = 0, markup = 0, chars = 0;
    for (const r of rows) {
      const text = r.t[i] ?? '';
      if (text.length === 0) empty++;
      else chars += text.length;
      if (containsFontColor(text)) markup++;
    }
    out.push(n, `  Empty: ${empty}`, `  With font markup: ${markup}`, `  Total characters: ${n0(chars)}`, '');
  });
  return out.join('\n').trimEnd();
}

/** Fill missing from language: copies language `src` into the others, over every row (hidden ones too).
 *  `set(row, langIndex, text)` writes a cell. Returns the number of cells written. */
export function fillMissing(rows, names, src, onlyEmpty, set) {
  let filled = 0;
  for (const r of rows) {
    const source = r.t[src] ?? '';
    if (!source) continue;
    names.forEach((n, i) => {
      if (n === names[src]) return;
      const cur = r.t[i] ?? '';
      if (onlyEmpty && cur.length > 0) return;
      if (cur === source) return;
      set(r, i, source);
      filled++;
    });
  }
  return filled;
}

/** TextResourceLngCatalog.Merge. Throws what ValidateForSave would (and on a duplicate key in the target). */
export function mergeLng(target, source, overwrite) {
  const merged = { ...target, languages: target.languages.map((l) => ({ name: l.name, entries: l.entries.map((e) => ({ key: e.key, text: e.text ?? '' })) })) };
  const warnings = [];
  let keysAdded = 0, keysUpdated = 0, languagesAdded = 0;
  for (const sl of source.languages) {
    let tl = merged.languages.find((l) => l.name === sl.name);
    if (!tl) {
      if (merged.languages.length >= MAX_LANGUAGES) {
        warnings.push(`Skipped language (max ${MAX_LANGUAGES}): ${sl.name}`);
        continue;
      }
      tl = { name: sl.name, entries: [] };
      merged.languages.push(tl);
      languagesAdded++;
    }
    const byKey = new Map();
    for (const e of tl.entries) {
      if (byKey.has(e.key)) throw new Error(`An item with the same key has already been added. Key: ${e.key}`);
      byKey.set(e.key, e);
    }
    for (const se of sl.entries ?? []) {
      const key = (se.key ?? '').trim();
      if (!key) continue;
      if (key.length >= MAX_KEY) {
        warnings.push(`Skipped key (too long): ${key}`);
        continue;
      }
      const text = se.text ?? '';
      const existing = byKey.get(key);
      if (existing) {
        if (!overwrite && existing.text) continue;
        existing.text = text;
        keysUpdated++;
      } else {
        const e = { key, text };
        tl.entries.push(e);
        byKey.set(key, e);
        keysAdded++;
      }
    }
    tl.entries.sort((a, b) => ordinal(a.key, b.key));
  }
  const problems = validateLng(merged);
  if (problems.length) throw new Error(problems[0]);
  return { file: merged, keysAdded, keysUpdated, languagesAdded, warnings };
}

/** The Merge message box text. */
export function mergeMessage(r) {
  const lines = ['Merge complete.', `Keys added: ${r.keysAdded}`, `Keys updated: ${r.keysUpdated}`];
  if (r.languagesAdded > 0) lines.push(`Languages added: ${r.languagesAdded}`);
  if (r.warnings.length) {
    lines.push('', 'Warnings:');
    const max = Math.min(r.warnings.length, 10);
    for (let i = 0; i < max; i++) lines.push(`  • ${r.warnings[i]}`);
    if (r.warnings.length > max) lines.push(`  • … and ${r.warnings.length - max} more`);
  }
  return lines.join('\n');
}

function keyLangMap(file) {
  const map = new Map();
  for (const l of file?.languages ?? []) {
    for (const e of l.entries ?? []) {
      const key = (e.key ?? '').trim();
      if (!key) continue;
      if (!map.has(key)) map.set(key, new Map());
      map.get(key).set(l.name, e.text ?? '');
    }
  }
  return map;
}

function summarize(text) {
  if (!text) return '(empty)';
  const one = text.replace(/\r\n/g, '\\n').replace(/\n/g, '\\n');
  return one.length > 120 ? `${one.slice(0, 120)}…` : one;
}

/** TextResourceLngCompare.BuildReport with the default options (identical keys counted, not listed). */
export function compareReport(current, other, curLabel, otherLabel) {
  const cur = curLabel?.trim() || 'Current';
  const oth = otherLabel?.trim() || 'Other';
  const left = keyLangMap(current);
  const right = keyLangMap(other);
  const all = [...new Set([...left.keys(), ...right.keys()])].sort(ordinal);
  const langs = [];
  for (const f of [current, other]) for (const l of f?.languages ?? []) if (!langs.includes(l.name)) langs.push(l.name);
  const out = [`Compare: ${cur}  vs  ${oth}`, `Keys in ${cur}: ${left.size}`, `Keys in ${oth}: ${right.size}`, `Languages: ${langs.join(', ')}`, ''];
  let onlyLeft = 0, onlyRight = 0, diffs = 0, same = 0;
  for (const key of all) {
    const l = left.get(key);
    const r = right.get(key);
    if (!l) {
      onlyRight++;
      out.push(`+ [${oth} only] ${key}`);
      continue;
    }
    if (!r) {
      onlyLeft++;
      out.push(`- [${cur} only] ${key}`);
      continue;
    }
    const lines = [];
    for (const lang of langs) {
      const lv = l.get(lang) ?? '';
      const rv = r.get(lang) ?? '';
      if (lv !== rv) lines.push(`  ${lang}:`, `    ${cur}: ${summarize(lv)}`, `    ${oth}: ${summarize(rv)}`);
    }
    if (!lines.length) {
      same++;
      continue;
    }
    diffs++;
    out.push(`≠ ${key}`, ...lines);
  }
  out.push('', 'Summary', `  Keys only in ${cur}: ${onlyLeft}`, `  Keys only in ${oth}: ${onlyRight}`, `  Keys with text differences: ${diffs}`, `  Identical keys: ${same}`);
  return out.join('\n').trimEnd();
}
