// Compare two folders, the comparison behind the desktop's CompareFoldersDialog: every file under either folder by
// its path inside it (case ignored), sorted as .NET's OrdinalIgnoreCase sorts the desktop's '\' paths, and told apart
// by size, then last-write time, then (when asked) SHA-256 of the contents. No DOM here.
import { toUpperSameLength } from './find-in-files.js';

export const MAX_ROWS = 25000;
const PROGRESS_EVERY = 400;

/** Integer with thousands separators, as .NET's ToString("N0") gives it in English. */
export const n0 = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

/** A last-write time (ms since 1970) as the desktop shows it: yyyy-MM-dd HH:mm in UTC. */
export function utcMinutes(ms) {
  const d = new Date(ms);
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// The key OrdinalIgnoreCase compares: each unit upper-cased as .NET does, with the desktop's '\' between folders.
const keyOf = (rel) => toUpperSameLength(rel.replace(/\//g, '\\'));

/**
 * ScanTree: the files under one side ([{rel, size, lastModified, ...}], rel = path inside the folder with '/'), as a
 * map that ignores case. `progress(n)` every 400 files, as the desktop's "Scanning Left... n files".
 */
export function scanTree(files, { signal, progress } = {}) {
  const map = new Map();
  let n = 0;
  for (const f of files) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (++n % PROGRESS_EVERY === 0) progress?.(n);
    const k = keyOf(f.rel);
    const had = map.get(k);
    map.set(k, had ? { ...f, rel: had.rel } : f); // the indexer keeps the first spelling of a key
  }
  return map;
}

async function sha256(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.read());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * RunCompare. `left`/`right` are [{rel, size, lastModified (ms), read()}]. `onRow(row)` gets each row as it is found:
 * {rel, status, left, right, open} where `open` is the side a double-click opens. Resolves to
 * {differences, identical, rows, truncated}; `signal` aborts with an AbortError.
 */
export async function compareFolders(left, right, { contentHash = false, showIdentical = false, signal, progress, onRow } = {}) {
  const check = () => {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  };
  const leftMap = scanTree(left, { signal, progress: (n) => progress?.('Left', n) });
  check();
  const rightMap = scanTree(right, { signal, progress: (n) => progress?.('Right', n) });
  check();

  let differences = 0;
  let identical = 0;
  let rows = 0;
  let truncated = false;
  const addRow = (rel, status, L, R, open) => {
    if (rows >= MAX_ROWS) {
      truncated = true;
      return;
    }
    onRow?.({ rel, status, left: L, right: R, open });
    ++rows;
  };

  // Union keeps the left spelling of a path both sides have; OrderBy is a stable sort.
  const keys = [...leftMap.keys()];
  for (const k of rightMap.keys()) if (!leftMap.has(k)) keys.push(k);
  keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const k of keys) {
    check();
    if (truncated) break;
    const L = leftMap.get(k);
    const R = rightMap.get(k);
    if (L && !R) {
      ++differences;
      addRow(L.rel, 'Left only', L, null, L);
      continue;
    }
    if (!L && R) {
      ++differences;
      addRow(R.rel, 'Right only', null, R, R);
      continue;
    }
    if (L.size !== R.size) {
      ++differences;
      addRow(L.rel, 'Different size', L, R, L);
      continue;
    }
    if (L.lastModified !== R.lastModified) {
      ++differences;
      addRow(L.rel, 'Same size, different time', L, R, L);
      continue;
    }
    let contentDiff = false;
    if (contentHash && L.size > 0) {
      const hL = await sha256(L);
      check();
      const hR = await sha256(R);
      if (hL !== hR) contentDiff = true;
    }
    if (contentDiff) {
      ++differences;
      addRow(L.rel, 'Same size, different content', L, R, L);
      continue;
    }
    ++identical;
    if (showIdentical) addRow(L.rel, 'Identical', L, R, L);
  }
  return { differences, identical, rows, truncated };
}

/** The final status line. */
export const doneText = ({ differences, identical, rows, truncated }) =>
  `Done. ${n0(differences)} difference(s), ${n0(identical)} identical file pair(s), ${n0(rows)} row(s) shown.` +
  (truncated ? ` List truncated at ${n0(MAX_ROWS)} rows.` : '');
