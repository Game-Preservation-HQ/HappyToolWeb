// Quick Open's search, a port of HappyTool/GUI/QuickOpen (FuzzyMatcher.cs, QuickOpenSearcher.cs, QuickOpenIndex.cs):
// fzf-style fuzzy matching of file paths, file-name matches ranked above folder matches, the best 200 kept in a
// bounded heap, the last hits narrowed as the query grows, and recent / pinned files lifted to the top when they
// score close to the best. No DOM: node can run it.
//
// The desktop matches Windows paths ('\' separators, '/' typed in the query is folded to '\'). The web's paths use
// '/', so the index keeps a '\' copy of each path for matching; the highlights are character positions, the same in
// either spelling.

export const NO_MATCH = -2147483648; // int.MinValue
export const MAX_TERM_LENGTH = 64;
const MAX_TERMS = 8;
const SCORE_MATCH = 16;
const SCORE_GAP_START = -3;
const SCORE_GAP_EXTENSION = -1;
const BONUS_BOUNDARY = SCORE_MATCH / 2; // 8
const BONUS_SEPARATOR = BONUS_BOUNDARY + 1; // 9
const BONUS_START = BONUS_BOUNDARY + 2; // 10
const BONUS_CAMEL = BONUS_BOUNDARY + SCORE_GAP_EXTENSION; // 7
const BONUS_CONSECUTIVE = -(SCORE_GAP_START + SCORE_GAP_EXTENSION); // 4
const BONUS_WORD_END = BONUS_BOUNDARY;
const BONUS_FIRST_CHAR_MULTIPLIER = 2;
export const FILE_NAME_TIER_BONUS = 1 << 16;
const EXACT_NAME_BONUS = 64;
export const DEFAULT_MAX_RESULTS = 200;
const HISTORY_LIFT_SLACK = 96;
export const MAX_FILES = 400000; // QuickOpenIndex.MaxFiles

/** char.ToLowerInvariant on one UTF-16 unit (kept when lower-casing would change the length). */
const lowerChar = (c) => {
  const l = c.toLowerCase();
  return l.length === 1 ? l : c;
};
const upperChar = (c) => {
  const u = c.toUpperCase();
  return u.length === 1 ? u : c;
};

/** FuzzyMatcher.ToLowerSameLength. */
export function toLowerSameLength(text) {
  if (!text) return text ?? '';
  let out = '';
  for (const c of text.split('')) out += lowerChar(c);
  return out;
}

/** string.Compare(a, b, StringComparison.OrdinalIgnoreCase): both sides upper-cased per character, then by code. */
export function compareOrdinalIgnoreCase(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = upperChar(a[i]).charCodeAt(0), y = upperChar(b[i]).charCodeAt(0);
    if (x !== y) return x - y;
  }
  return a.length - b.length;
}

const isWhiteSpace = (c) => /\s/.test(c);

/** A parsed query (FuzzyQuery): lower-cased terms split on white space, '/' folded to '\'; at most 8 terms of 64. */
export class FuzzyQuery {
  constructor(text, terms) {
    this.text = text;
    this.terms = terms;
    this.termHasSeparator = terms.map((t) => t.includes('\\'));
  }
  get isEmpty() {
    return this.terms.length === 0;
  }
  static parse(text) {
    if (text == null || !text.trim()) return EMPTY;
    const trimmed = text.trim();
    const terms = [];
    let sb = '';
    const flush = () => {
      if (sb.length) terms.push(sb);
      sb = '';
    };
    for (const raw of trimmed.split('')) {
      if (isWhiteSpace(raw)) {
        flush();
        continue;
      }
      const c = raw === '/' ? '\\' : lowerChar(raw);
      if (sb.length < MAX_TERM_LENGTH) sb += c;
    }
    flush();
    if (terms.length > MAX_TERMS) terms.length = MAX_TERMS;
    return terms.length === 0 ? EMPTY : new FuzzyQuery(trimmed, terms);
  }
  /** True when every term of `previous` is a subsequence of this query's term at the same place (the hits only shrink). */
  narrows(previous) {
    if (!previous || previous.isEmpty || this.isEmpty) return false;
    if (this.terms.length < previous.terms.length) return false;
    for (let i = 0; i < previous.terms.length; i++) if (!isSubsequence(previous.terms[i], this.terms[i], 0)) return false;
    return true;
  }
}
const EMPTY = new FuzzyQuery('', []);
FuzzyQuery.EMPTY = EMPTY;

export function isSubsequence(pattern, text, start) {
  const pl = pattern.length;
  if (pl === 0) return true;
  let pi = 0;
  let want = pattern[0];
  for (let j = start; j < text.length; j++) {
    if (text[j] !== want) continue;
    if (++pi === pl) return true;
    want = pattern[pi];
  }
  return false;
}

/** Every term is a subsequence of the lower-cased text (the cheap filter before scoring). */
export function isCandidate(query, lowerText) {
  if (!query || query.isEmpty) return true;
  if (lowerText == null) return false;
  for (const t of query.terms) if (!isSubsequence(t, lowerText, 0)) return false;
  return true;
}

function isExactName(lower, nameStart, term) {
  const nameLen = lower.length - nameStart;
  if (term.length === nameLen) return lower.slice(nameStart) === term;
  const dot = lower.lastIndexOf('.');
  if (dot <= nameStart) return false;
  const stemLen = dot - nameStart;
  return term.length === stemLen && lower.slice(nameStart, dot) === term;
}

const isDelimiter = (c) => c === '\\' || c === '/' || c === '_' || c === '-' || c === '.' || c === ' ';
const CLASS_OTHER = 0, CLASS_LOWER = 1, CLASS_UPPER = 2, CLASS_DIGIT = 3;
function classify(c) {
  const code = c.charCodeAt(0);
  if (code < 128) {
    if (c >= 'a' && c <= 'z') return CLASS_LOWER;
    if (c >= 'A' && c <= 'Z') return CLASS_UPPER;
    if (c >= '0' && c <= '9') return CLASS_DIGIT;
    return CLASS_OTHER;
  }
  if (/\p{Ll}/u.test(c)) return CLASS_LOWER;
  if (/\p{Lu}/u.test(c)) return CLASS_UPPER;
  if (/\p{Nd}/u.test(c)) return CLASS_DIGIT;
  return /\p{L}/u.test(c) ? CLASS_LOWER : CLASS_OTHER;
}
function isHump(before, after) {
  if (before === CLASS_OTHER || after === CLASS_OTHER) return false;
  if (before === CLASS_LOWER && after === CLASS_UPPER) return true;
  return (before === CLASS_DIGIT) !== (after === CLASS_DIGIT);
}
function bonusAt(text, j, start) {
  if (j === start) return BONUS_START;
  const prev = text[j - 1];
  if (prev === '\\' || prev === '/') return BONUS_SEPARATOR;
  if (isDelimiter(prev)) return BONUS_BOUNDARY;
  return isHump(classify(prev), classify(text[j])) ? BONUS_CAMEL : 0;
}
function isWordEnd(text, j, end) {
  if (j + 1 >= end) return true;
  const next = text[j + 1];
  if (isDelimiter(next)) return true;
  return isHump(classify(text[j]), classify(next));
}

// Scratch rows, grown as needed (FuzzyMatcher.Scratch).
let H0 = new Int32Array(128), H1 = new Int32Array(128), R0 = new Int32Array(128), R1 = new Int32Array(128);
let TRACE = new Int32Array(1024);
function ensureRows(width) {
  if (H0.length >= width) return;
  const n = Math.max(width, H0.length * 2);
  H0 = new Int32Array(n);
  H1 = new Int32Array(n);
  R0 = new Int32Array(n);
  R1 = new Int32Array(n);
}

/** The best alignment of `pattern` in text[start, end): its score (or NO_MATCH), the matched positions into `positions`. */
function align(text, lower, start, end, pattern, positions) {
  const m = pattern.length;
  if (m === 0 || end - start < m) return NO_MATCH;
  let pi = 0, first = -1;
  for (let j = start; j < end && pi < m; j++) {
    if (lower[j] !== pattern[pi]) continue;
    if (pi === 0) first = j;
    ++pi;
  }
  if (pi < m) return NO_MATCH;
  let last = end - 1;
  const lastChar = pattern[m - 1];
  while (lower[last] !== lastChar) --last;
  const w = last - first + 1;
  ensureRows(w);
  let trace = null;
  if (positions) {
    if (TRACE.length < m * w) TRACE = new Int32Array(Math.max(m * w, TRACE.length * 2));
    trace = TRACE;
  }
  let hPrev = H0, hCur = H1, rPrev = R0, rCur = R1;
  for (let i = 0; i < m; i++) {
    const pc = pattern[i];
    let gapBest = NO_MATCH, gapFrom = -1;
    for (let k = 0; k < w; k++) {
      if (i > 0) {
        if (gapBest !== NO_MATCH) gapBest += SCORE_GAP_EXTENSION;
        if (k >= 2 && hPrev[k - 2] !== NO_MATCH) {
          const cand = hPrev[k - 2] + SCORE_GAP_START;
          if (cand > gapBest) {
            gapBest = cand;
            gapFrom = k - 2;
          }
        }
      }
      if (lower[first + k] !== pc) {
        hCur[k] = NO_MATCH;
        continue;
      }
      const b = bonusAt(text, first + k, start);
      let best, from, runBonus;
      if (i === 0) {
        best = SCORE_MATCH + b * BONUS_FIRST_CHAR_MULTIPLIER;
        from = -1;
        runBonus = b;
      } else {
        best = NO_MATCH;
        from = -1;
        runBonus = 0;
        if (gapBest !== NO_MATCH) {
          best = gapBest + SCORE_MATCH + b;
          from = gapFrom;
          runBonus = b;
        }
        if (k >= 1 && hPrev[k - 1] !== NO_MATCH) {
          const prevRunBonus = rPrev[k - 1];
          let charBonus, nextRunBonus;
          if (b >= BONUS_BOUNDARY && b > prevRunBonus) {
            charBonus = b;
            nextRunBonus = b;
          } else {
            charBonus = Math.max(b, Math.max(prevRunBonus, BONUS_CONSECUTIVE));
            nextRunBonus = prevRunBonus;
          }
          let cand = hPrev[k - 1] + SCORE_MATCH + charBonus;
          if (isWordEnd(text, first + k, end)) cand += BONUS_WORD_END;
          if (cand >= best) {
            best = cand;
            from = k - 1;
            runBonus = nextRunBonus;
          }
        }
        if (best === NO_MATCH) {
          hCur[k] = NO_MATCH;
          continue;
        }
      }
      hCur[k] = best;
      rCur[k] = runBonus;
      if (trace) trace[i * w + k] = from;
    }
    [hPrev, hCur] = [hCur, hPrev];
    [rPrev, rCur] = [rCur, rPrev];
  }
  let bestScore = NO_MATCH, bestK = -1;
  for (let k = 0; k < w; k++) {
    if (hPrev[k] > bestScore) {
      bestScore = hPrev[k];
      bestK = k;
    }
  }
  if (positions && bestK >= 0) {
    let k = bestK;
    for (let i = m - 1; i >= 0; i--) {
      positions[i] = first + k;
      if (i > 0) k = trace[i * w + k];
    }
  }
  return bestScore;
}

/**
 * FuzzyMatcher.Score: the sum of each term's best alignment, a term without a separator tried on the file name first
 * (FILE_NAME_TIER_BONUS, plus 64 when it is the whole name or its stem), then on the whole path. `positions` (an array,
 * or null) receives the highlighted character positions, sorted and without repeats.
 */
export function score(query, text, lowerText, nameStart, positions = null) {
  if (positions) positions.length = 0;
  if (!query || query.isEmpty) return 0;
  if (!text || lowerText == null || lowerText.length !== text.length) return NO_MATCH;
  if (nameStart < 0 || nameStart > text.length) nameStart = 0;
  let total = 0;
  const terms = query.terms;
  for (let t = 0; t < terms.length; t++) {
    const term = terms[t];
    const termPositions = positions ? new Array(term.length) : null;
    let s = NO_MATCH;
    if (!query.termHasSeparator[t] && nameStart < text.length) {
      s = align(text, lowerText, nameStart, text.length, term, termPositions);
      if (s !== NO_MATCH) {
        s += FILE_NAME_TIER_BONUS;
        if (isExactName(lowerText, nameStart, term)) s += EXACT_NAME_BONUS;
      }
    }
    if (s === NO_MATCH) {
      s = align(text, lowerText, 0, text.length, term, termPositions);
      if (s === NO_MATCH) {
        if (positions) positions.length = 0;
        return NO_MATCH;
      }
    }
    total += s;
    if (positions) for (let k = 0; k < term.length; k++) positions.push(termPositions[k]);
  }
  if (positions && terms.length > 1) {
    positions.sort((a, b) => a - b);
    let w = 0;
    for (let r = 0; r < positions.length; r++) if (w === 0 || positions[r] !== positions[w - 1]) positions[w++] = positions[r];
    positions.length = w;
  }
  return total;
}

/**
 * The file index (QuickOpenIndex): `paths` are the open files' paths ('/' separators). `root` is the folder they are
 * shown relative to ('' for none). Kept: the relative path with '\' (matched), its lower-case copy and where the
 * name starts. More than 400,000 files are cut, as on the desktop.
 */
export function buildIndex(paths, root = '') {
  const base = root ? root.toLowerCase() + '/' : '';
  const full = [], rel = [], lower = [], nameStarts = [];
  for (const p of walkOrder(paths.filter((p) => !base || p.toLowerCase().startsWith(base)), base.length)) {
    if (full.length >= MAX_FILES) return { root, full, paths: rel, lowerPaths: lower, nameStarts, count: full.length, truncated: true };
    const r = p.slice(base.length).replace(/\//g, '\\');
    full.push(p);
    rel.push(r);
    lower.push(toLowerSameLength(r));
    nameStarts.push(r.lastIndexOf('\\') + 1);
  }
  return { root, full, paths: rel, lowerPaths: lower, nameStarts, count: full.length, truncated: false };
}

/**
 * Puts `paths` in the order the desktop's folder walk finds them, so files that rank the same are kept and listed as
 * there: a folder's own files first (NTFS lists names in upper-case order), then its subfolders, the last one first
 * (they go on a stack). Files more than 48 folders deep are left out, as on the desktop. `skip` is the root's length.
 */
function walkOrder(paths, skip) {
  const top = { files: [], dirs: new Map() };
  for (const p of paths) {
    const parts = p.slice(skip).split('/');
    let node = top;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i].toUpperCase();
      let next = node.dirs.get(key);
      if (!next) node.dirs.set(key, (next = { name: parts[i], files: [], dirs: new Map() }));
      node = next;
    }
    node.files.push({ name: parts[parts.length - 1], path: p });
  }
  const out = [];
  const pending = [{ node: top, depth: 0 }];
  while (pending.length) {
    const { node, depth } = pending.pop();
    node.files.sort((a, b) => compareOrdinalIgnoreCase(a.name, b.name));
    for (const f of node.files) out.push(f.path);
    if (depth >= 48) continue;
    const dirs = [...node.dirs.values()].sort((a, b) => compareOrdinalIgnoreCase(a.name, b.name));
    for (const d of dirs) pending.push({ node: d, depth: depth + 1 });
  }
  return out;
}

/** The relative path of `path` under `root` with '\' separators, or null when it is not under it (TryMakeRelative). */
function relativeUnder(root, path) {
  if (!root) return path.replace(/\//g, '\\');
  const base = root.toLowerCase() + '/';
  return path.toLowerCase().startsWith(base) ? path.slice(base.length).replace(/\//g, '\\') : null;
}

/**
 * SortKey: score first (best = smallest key), then the shorter file name, then the shorter path. The desktop packs
 * this in a long; here it is -score·2^32 + (name<<16 | path), the same order while |score| < 2^20 (the most 8 terms of
 * 64 characters can score is about 2^19).
 */
function sortKey(s, nameLength, pathLength) {
  return -s * 4294967296 + Math.min(nameLength, 0xffff) * 65536 + Math.min(pathLength, 0xffff);
}

function heapPush(keys, items, count, key, item) {
  let n = count;
  while (n > 0) {
    const parent = (n - 1) >> 1;
    if (keys[parent] >= key) break;
    keys[n] = keys[parent];
    items[n] = items[parent];
    n = parent;
  }
  keys[n] = key;
  items[n] = item;
}
function heapReplaceRoot(keys, items, count, key, item) {
  let n = 0;
  for (;;) {
    let child = 2 * n + 1;
    if (child >= count) break;
    if (child + 1 < count && keys[child + 1] > keys[child]) ++child;
    if (keys[child] <= key) break;
    keys[n] = keys[child];
    items[n] = items[child];
    n = child;
  }
  keys[n] = key;
  items[n] = item;
}

/** One row of the result: kind 'file', 'recent' or 'pinned'; displayPath uses '\' (show it with '/'). */
function makeItem(fullPath, displayPath, highlights, s, kind, missing) {
  const nameStart = displayPath.lastIndexOf('\\') + 1;
  return {
    fullPath,
    displayPath,
    nameStart,
    highlights: highlights ?? [],
    score: s,
    kind,
    missing,
    isHistory: kind !== 'file',
    fileName: displayPath.slice(nameStart),
    folder: nameStart > 0 ? displayPath.slice(0, nameStart - 1) : '',
  };
}

function compareRanked(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  if (a.isHistory !== b.isHistory) return a.isHistory ? -1 : 1;
  const c = a.displayPath.length - a.nameStart - (b.displayPath.length - b.nameStart);
  if (c) return c;
  if (a.displayPath.length !== b.displayPath.length) return a.displayPath.length - b.displayPath.length;
  return compareOrdinalIgnoreCase(a.displayPath, b.displayPath);
}

/** QuickOpenSearcher: keeps the last query's hits so a longer query only re-checks those. */
export class QuickOpenSearcher {
  /** `exists(path)` says whether a recent / pinned path is still among the files (the desktop's File.Exists). */
  constructor(index, exists = () => true) {
    this.index = index;
    this.exists = exists;
    this.lastQuery = null;
    this.lastHits = null;
  }
  setIndex(index) {
    if (this.index === index) return;
    this.index = index;
    this.lastQuery = null;
    this.lastHits = null;
  }

  buildHistory(pinned, recent) {
    const list = [], seen = new Set();
    const add = (path, kind) => {
      if (!path || !path.trim()) return;
      const key = path.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const rel = relativeUnder(this.index?.root ?? '', path);
      const display = rel ?? path.replace(/\//g, '\\');
      list.push({ fullPath: path, displayPath: display, lowerPath: toLowerSameLength(display), kind, underRoot: rel != null });
    };
    for (const p of pinned ?? []) add(p, 'pinned');
    for (const p of recent ?? []) add(p, 'recent');
    return list;
  }

  /** Search(text, pinned, recent, maxResults): {query, items, indexMatches, historyMatches, elapsedMs}. */
  search(text, pinned, recent, maxResults = DEFAULT_MAX_RESULTS) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const elapsed = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    const query = FuzzyQuery.parse(text);
    const history = this.buildHistory(pinned, recent);
    const items = [];
    if (query.isEmpty) {
      for (const h of history) items.push(makeItem(h.fullPath, h.displayPath, null, 0, h.kind, !this.exists(h.fullPath)));
      this.lastQuery = null;
      this.lastHits = null;
      return { query, items, indexMatches: 0, historyMatches: 0, elapsedMs: elapsed() };
    }
    const shownRelative = new Set(); // lower-cased: the desktop's OrdinalIgnoreCase set
    const historyHits = [];
    history.forEach((h, i) => {
      const pos = [];
      const s = score(query, h.displayPath, h.lowerPath, h.displayPath.lastIndexOf('\\') + 1, pos);
      if (s === NO_MATCH) return;
      historyHits.push({ item: makeItem(h.fullPath, h.displayPath, pos, s, h.kind, !this.exists(h.fullPath)), order: i });
      if (h.underRoot) shownRelative.add(h.displayPath.toLowerCase());
    });
    const rest = [];
    let indexMatches = 0;
    if (this.index && this.index.count > 0) indexMatches = this.searchIndex(query, maxResults, shownRelative, rest);
    let best = rest.length > 0 ? rest[0].score : NO_MATCH;
    for (const hit of historyHits) best = Math.max(best, hit.item.score);
    const lifted = [];
    let mergedHistory = false;
    for (const hit of historyHits) {
      if (hit.item.score >= best - HISTORY_LIFT_SLACK) lifted.push(hit);
      else {
        rest.push(hit.item);
        mergedHistory = true;
      }
    }
    lifted.sort((a, b) => b.item.score - a.item.score || a.order - b.order);
    if (mergedHistory) {
      rest.sort(compareRanked);
      if (rest.length > maxResults) rest.length = maxResults;
    }
    for (const hit of lifted) items.push(hit.item);
    items.push(...rest);
    return { query, items, indexMatches, historyMatches: historyHits.length, elapsedMs: elapsed() };
  }

  searchIndex(query, maxResults, skipRelative, items) {
    const index = this.index;
    const narrow = this.lastHits != null && query.narrows(this.lastQuery);
    const candidates = narrow ? this.lastHits : null;
    const candidateCount = narrow ? candidates.length : index.count;
    const { paths, lowerPaths: lower, nameStarts } = index;
    const capacity = Math.max(1, maxResults + skipRelative.size);
    const heapKeys = new Float64Array(capacity), heapIndex = new Int32Array(capacity);
    let heapCount = 0;
    const hits = [];
    for (let c = 0; c < candidateCount; c++) {
      const i = candidates == null ? c : candidates[c];
      const lp = lower[i];
      if (!isCandidate(query, lp)) continue;
      const s = score(query, paths[i], lp, nameStarts[i], null);
      if (s === NO_MATCH) continue;
      hits.push(i);
      const key = sortKey(s, lp.length - nameStarts[i], lp.length);
      if (heapCount < capacity) heapPush(heapKeys, heapIndex, heapCount++, key, i);
      else if (key < heapKeys[0]) heapReplaceRoot(heapKeys, heapIndex, heapCount, key, i);
    }
    this.lastHits = hits;
    this.lastQuery = query;
    const top = [];
    for (let h = 0; h < heapCount; h++) {
      const i = heapIndex[h];
      if (skipRelative.size > 0 && skipRelative.has(paths[i].toLowerCase())) continue;
      top.push({ key: heapKeys[h], i });
    }
    top.sort((a, b) => a.key - b.key || compareOrdinalIgnoreCase(paths[a.i], paths[b.i]));
    if (top.length > maxResults) top.length = maxResults;
    for (const t of top) {
      const pos = [];
      const s = score(query, paths[t.i], lower[t.i], nameStarts[t.i], pos);
      items.push(makeItem(index.full[t.i], paths[t.i], pos, s, 'file', false));
    }
    return hits.length;
  }
}
