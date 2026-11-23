// Text key references, a port of HappyTool's TextResource/TextResourceNutCrossRef.cs: which script and JSON lines
// under the Data folder name a .lng key, the key under the caret in a script, and which .lng file the game reads.
import { decodeLayers } from './wrappers.js';
import { decodeText } from '../util.js';

export const SEARCH_EXTENSIONS = ['.nut', '.json', '.zson'];
const MAX_BYTES = 5 * 1024 * 1024; // the desktop skips bigger files
const TOKEN = /\b(?:TXC[A-Z0-9_]{2,12}|CUSTOMIZE_\d{2}|KEYNAME_[A-Z0-9_]+|DXTIP\d+|MENU_[A-Z0-9_]+|TIP_[A-Z0-9_]+)\b/;
const QUOTED = /["']([A-Z][A-Z0-9_]{2,14})["']/g;
// The web also takes any upper-case word of that shape when asked outright (Find text key references / Open text key
// in .lng editor): the Revival's keys (DDRPS0005, STRG_…) don't match the desktop's prefixes.
const KEY_SHAPE = /^[A-Z][A-Z0-9_]{2,14}$/;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isIdent = (c) => c === '_' || /[\p{L}\p{N}]/u.test(c);

/** The desktop's test: 3 to 15 characters, one of the known key families. */
export function isLikelyTextKey(value, wide = false) {
  const v = (value ?? '').trim();
  if (v.length > 15 || v.length < 3) return false;
  return TOKEN.test(v) || (wide && KEY_SHAPE.test(v));
}

/** The word of letters, digits and _ at `index` (the desktop's GetIdentifierAt). */
export function identifierAt(text, index) {
  if (!text) return '';
  let i = Math.max(0, Math.min(index, text.length - 1));
  if (!isIdent(text[i]) && i > 0 && isIdent(text[i - 1])) i--;
  if (!isIdent(text[i])) return '';
  let s = i, e = i + 1;
  while (s > 0 && isIdent(text[s - 1])) s--;
  while (e < text.length && isIdent(text[e])) e++;
  return text.slice(s, e);
}

/**
 * The text key at a caret (the desktop's TryGetTextKeyAtIndex): a quoted key on the caret's line whose text holds
 * the caret, else the word at the caret. `wide` also accepts any upper-case key-shaped word (see KEY_SHAPE).
 */
export function textKeyAt(text, index, wide = false) {
  if (!text) return null;
  if (index >= text.length) index = text.length - 1;
  if (index < 0) index = 0;
  const lineStart = text.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  let lineEnd = text.indexOf('\n', index);
  if (lineEnd < 0) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd);
  const inLine = index - lineStart;
  for (const m of line.matchAll(QUOTED)) {
    const start = m.index + 1, end = start + m[1].length - 1;
    if (inLine >= start && inLine <= end && isLikelyTextKey(m[1], wide)) return m[1];
  }
  const id = identifierAt(text, index);
  return isLikelyTextKey(id, wide) ? id : null;
}

/** Readable text of a Data file: BFBR / ZRES shells taken off, then decoded as the editors do. */
export async function readDataText(bytes) {
  const { payload } = await decodeLayers(bytes);
  return decodeText(payload).text;
}

const extOf = (path) => {
  const m = /(\.[^./\\]*)$/.exec(path);
  return m ? m[1] : '';
};
export const isSearchable = (path) => SEARCH_EXTENSIONS.includes(extOf(path).toLowerCase());

function trimPreview(line, max = 240) {
  const s = line.trim();
  return s.length <= max ? s : s.slice(0, max) + '…';
}

/**
 * Every line of the .nut / .json / .zson files that names `key` (the desktop's FindInDataFiles): quoted "KEY" or
 * 'KEY', or KEY as a whole word. `files` are {path, size, read()}; progress(scanned, found) runs every 25 files and
 * at the end; an aborted `signal` stops the search with an AbortError. Unreadable files are skipped.
 */
export async function findKeyReferences(files, key, { progress, signal } = {}) {
  const matches = [];
  key = (key ?? '').trim();
  if (!key) return matches;
  const dq = `"${key}"`, sq = `'${key}'`;
  const bare = new RegExp(`\\b${escRe(key)}\\b`);
  let scanned = 0;
  for (const f of files) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const ext = extOf(f.path).toLowerCase();
    if (!SEARCH_EXTENSIONS.includes(ext)) continue;
    scanned++;
    if (scanned % 25 === 0) {
      progress?.(scanned, matches.length);
      await new Promise((r) => setTimeout(r)); // let the page paint and Cancel be clicked
    }
    let text;
    try {
      if (f.size > MAX_BYTES) continue;
      text = await readDataText(await f.read());
    } catch {
      continue;
    }
    if (!text) continue;
    const kind = ext.slice(1);
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    lines.forEach((line, i) => {
      if (line && (line.includes(dq) || line.includes(sq) || bare.test(line)))
        matches.push({ path: f.path, kind, line: i + 1, preview: trimPreview(line) });
    });
  }
  progress?.(scanned, matches.length);
  return matches;
}

/** The Data folder a file sits in: the nearest folder up its path named Data or OriginalData ('' when none). */
export function dataRootOf(path) {
  const parts = (path ?? '').split('/').slice(0, -1);
  for (let i = parts.length - 1; i >= 0; i--) if (/^(data|originaldata)$/i.test(parts[i])) return parts.slice(0, i + 1).join('/');
  return '';
}

/** `path` relative to `root`, compared without case (the desktop's relative path column). */
export function relativeTo(root, path) {
  if (!root) return path;
  const r = root.toLowerCase() + '/';
  return path.toLowerCase().startsWith(r) ? path.slice(r.length) : path;
}

/**
 * The .lng file the game reads, among `paths` under `root` (the desktop's FindPreferredLngFile):
 * langbresPollux/plxLang_en.lng, lang/plxLang_en.lng, any plxLang*.lng, any .lng. The Revival keeps its text only
 * in bundles, so the web then falls back to langbresPollux/plxDict_en.bres and langbres/Dict_en.bres
 * ({path, bundle: true}: open its .lng entry).
 */
export function preferredLng(paths, root = '') {
  const under = paths.filter((p) => !root || p.toLowerCase().startsWith(root.toLowerCase() + '/'));
  const rel = (p) => relativeTo(root, p).toLowerCase();
  const name = (p) => p.slice(p.lastIndexOf('/') + 1).toLowerCase();
  const pick =
    under.find((p) => rel(p) === 'langbrespollux/plxlang_en.lng') ||
    under.find((p) => rel(p) === 'lang/plxlang_en.lng') ||
    under.find((p) => /^plxlang.*\.lng$/.test(name(p))) ||
    under.find((p) => name(p).endsWith('.lng'));
  if (pick) return { path: pick, bundle: false };
  const bres = under.find((p) => rel(p) === 'langbrespollux/plxdict_en.bres') || under.find((p) => rel(p) === 'langbres/dict_en.bres');
  return bres ? { path: bres, bundle: true } : null;
}
