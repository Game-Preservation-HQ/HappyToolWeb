// Find in files, the search behind the desktop's FindInFilesDialog: every file under a folder (optionally only one
// extension) whose text has a line containing the string, case ignored. Files are read as the desktop's StreamReader
// reads them (a BOM picks UTF-8, UTF-16 or UTF-32, otherwise UTF-8) and files over 64 MiB are skipped. No DOM here.
// Broken bytes read as U+FFFD; an unfinished character at the very end is dropped, as StreamReader drops it.

export const MAX_BYTES = 64 * 1024 * 1024;
const PROGRESS_EVERY = 50;

// .NET's char.IsWhiteSpace, which String.Trim() strips (JavaScript's trim() also strips U+FEFF and keeps U+0085).
const NET_SPACE = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

/** String.Trim() as .NET does it. */
export const netTrim = (s) => (s ?? '').replace(NET_SPACE, '');

/** NormalizeExt: '' / '*' / '*.*' mean every file (null); otherwise the extension with its leading dot. */
export function normalizeExt(raw) {
  if (!raw || !netTrim(raw)) return null;
  const t = netTrim(raw);
  if (t === '*' || t === '*.*') return null;
  return t.startsWith('.') ? t : '.' + t;
}

// Where .NET Framework's OrdinalIgnoreCase and the browser's upper case part ways (checked for every UTF-16 unit
// against HappyTool.exe): these letters keep their case on the desktop (micro sign, dotless i, long s, final sigma,
// Georgian, Cherokee and other letters newer than its case table)...
const NET_KEEPS =
  /[\u00b5\u0131\u017f\u019b\u01c5\u01c8\u01cb\u01f2\u023f\u0240\u0252\u025c\u0261\u0264-\u0266\u026a\u026c\u0282\u0287\u029d\u029e\u0345\u03c2\u03d0\u03d1\u03d5\u03d6\u03f0\u03f1\u03f3\u03f5\u0525\u0527\u0529\u052b\u052d\u052f\u10d0-\u10fa\u10fd-\u10ff\u13f8-\u13fd\u1c80-\u1c88\u1c8a\u1d8e\u1e9b\u1fbe\u2c5f\u2cec\u2cee\u2cf3\u2d27\u2d2d\ua661\ua699\ua69b\ua791\ua793\ua794\ua797\ua799\ua79b\ua79d\ua79f\ua7a1\ua7a3\ua7a5\ua7a7\ua7a9\ua7b5\ua7b7\ua7b9\ua7bb\ua7bd\ua7bf\ua7c1\ua7c3\ua7c8\ua7ca\ua7cd\ua7d1\ua7d7\ua7d9\ua7db\ua7f6\uab53\uab70-\uabbf]/;
const NET_KEEPS_ANY = new RegExp(NET_KEEPS.source.slice(0, -1) + '\\u1f80-\\u1faf\\u1fb3\\u1fbc\\u1fc3\\u1fcc\\u1ff3\\u1ffc]');
// ...and the Greek letters with a iota subscript pair small with title case there (the browser spells them as two letters).
const IOTA_PAIRS = { 0x1fb3: 0x1fbc, 0x1fc3: 0x1fcc, 0x1ff3: 0x1ffc };

function upperUnit(c) {
  if (NET_KEEPS.test(c)) return c;
  const n = c.charCodeAt(0);
  if (n >= 0x1f80 && n <= 0x1faf) return String.fromCharCode(n | 8);
  if (IOTA_PAIRS[n]) return String.fromCharCode(IOTA_PAIRS[n]);
  const u = c.toUpperCase();
  return u.length === 1 ? u : c; // sharp s stays sharp s: OrdinalIgnoreCase compares one unit with one unit
}

/** Upper-cases one UTF-16 unit at a time as .NET's OrdinalIgnoreCase does, keeping the length. */
export function toUpperSameLength(s) {
  const up = s.toUpperCase();
  if (up.length === s.length && !NET_KEEPS_ANY.test(s)) return up; // nothing grew or differs: the per-unit mapping
  let out = '';
  for (let i = 0; i < s.length; i++) out += upperUnit(s[i]);
  return out;
}

/** path.EndsWith(ext, OrdinalIgnoreCase). */
export const endsWithIgnoreCase = (path, ext) =>
  path.length >= ext.length && toUpperSameLength(path.slice(path.length - ext.length)) === toUpperSameLength(ext);

function decodeUtf32(bytes, start, little) {
  let out = '';
  for (let i = start; i + 3 < bytes.length; i += 4) {
    const cp = little
      ? (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0
      : ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
    out += cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '\ufffd' : String.fromCodePoint(cp);
  }
  return out; // a last unit cut short is dropped
}

/**
 * The encoding a StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true) reads these bytes with:
 * {encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'utf-32le' | 'utf-32be', start: the byte after the BOM}.
 */
export function detectEncoding(b) {
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return { encoding: 'utf-16be', start: 2 };
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    return b.length >= 4 && b[2] === 0 && b[3] === 0 ? { encoding: 'utf-32le', start: 4 } : { encoding: 'utf-16le', start: 2 };
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { encoding: 'utf-8', start: 3 };
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 0xfe && b[3] === 0xff) return { encoding: 'utf-32be', start: 4 };
  return { encoding: 'utf-8', start: 0 };
}

const CHUNK = 1 << 20;

/**
 * ContainsUtf8LineMatch: does a line of the file contain `needle`, case ignored? A line never holds a line break, so
 * a needle with one never matches; otherwise searching the text is the same as searching it line by line. It reads a
 * MiB at a time and stops at the first hit, as the desktop stops at the first matching line.
 */
export function containsLineMatch(bytes, needle) {
  if (/[\r\n]/.test(needle)) return false;
  const want = needlePattern(needle);
  const { encoding, start } = detectEncoding(bytes);
  if (encoding.startsWith('utf-32')) return want.test(decodeUtf32(bytes, start, encoding === 'utf-32le'));
  // Never flushed: StreamReader never flushes its decoder, so an unfinished character at the end gives nothing.
  const decoder = new TextDecoder(encoding, { ignoreBOM: true });
  let tail = '';
  for (let at = start; ; at += CHUNK) {
    const last = at + CHUNK >= bytes.length;
    const text = tail + decoder.decode(bytes.subarray(at, Math.min(at + CHUNK, bytes.length)), { stream: true });
    if (want.test(text)) return true;
    if (last) return false;
    tail = text.slice(Math.max(0, text.length - (needle.length - 1))); // a hit may straddle two pieces
  }
}

// The text is not upper-cased (slow on big binary files): each needle unit becomes the set of units that upper-case
// to the same one, and a regular expression looks for that.
let caseGroups = null;
let lastNeedle = null;
let lastPattern = null;
function needlePattern(needle) {
  if (needle === lastNeedle) return lastPattern;
  if (!caseGroups) {
    caseGroups = new Map();
    for (let u = 0; u < 0x10000; u++) {
      const k = upperUnit(String.fromCharCode(u)).charCodeAt(0);
      const g = caseGroups.get(k);
      if (g) g.push(u);
      else caseGroups.set(k, [u]);
    }
  }
  const hex = (u) => '\\u' + u.toString(16).padStart(4, '0');
  let source = '';
  for (let i = 0; i < needle.length; i++) {
    const g = caseGroups.get(upperUnit(needle[i]).charCodeAt(0)) ?? [needle.charCodeAt(i)];
    source += g.length === 1 ? hex(g[0]) : '[' + g.map(hex).join('') + ']';
  }
  lastNeedle = needle;
  lastPattern = new RegExp(source);
  return lastPattern;
}

/**
 * Puts paths in Directory.EnumerateFiles(root, "*", AllDirectories) order: a folder's own files (NTFS lists names in
 * upper-case order), then each subfolder in turn, all the way down, before the next one.
 */
export function enumerationOrder(paths) {
  const top = { files: [], dirs: new Map() };
  for (const p of paths) {
    const parts = p.split('/');
    let node = top;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i].toUpperCase();
      let next = node.dirs.get(key);
      if (!next) node.dirs.set(key, (next = { name: parts[i], files: [], dirs: new Map() }));
      node = next;
    }
    node.files.push({ name: parts[parts.length - 1], path: p });
  }
  const upper = (a, b) => {
    const x = toUpperSameLength(a.name), y = toUpperSameLength(b.name);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const out = [];
  const walk = (node) => {
    for (const f of node.files.sort(upper)) out.push(f.path);
    for (const d of [...node.dirs.values()].sort(upper)) walk(d);
  };
  walk(top);
  return out;
}

/**
 * RunSearch over `files` ([{path, size, read()}], paths with '/'), in the desktop's order. `onMatch(file)` gets each
 * hit as it is found; `progress(scanned, matched)` every 50 files scanned. Resolves to {scanned, matched}; `signal`
 * aborts with an AbortError.
 */
export async function findInFiles(files, { needle, ext = null, signal, progress, onMatch }) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  let scanned = 0;
  let matched = 0;
  let tick = 0;
  for (const path of enumerationOrder([...byPath.keys()])) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (ext != null && !endsWithIgnoreCase(path.replace(/\//g, '\\'), ext)) continue; // the desktop's paths use '\'
    ++scanned;
    if (++tick >= PROGRESS_EVERY) {
      tick = 0;
      progress?.(scanned, matched);
    }
    const f = byPath.get(path);
    let hit = false;
    if (f.size <= MAX_BYTES) {
      try {
        hit = containsLineMatch(await f.read(), needle);
      } catch {
        hit = false; // unreadable: not a match, as on the desktop
      }
    }
    if (!hit) continue;
    ++matched;
    onMatch?.(f);
  }
  return { scanned, matched };
}
