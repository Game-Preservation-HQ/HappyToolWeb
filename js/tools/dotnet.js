// Small .NET Framework 4.8 behaviours that ported desktop code relies on for identical results: System.IO.Path
// name helpers (with their "Illegal characters in path." check), OrdinalIgnoreCase equality, Math.Round(x, 3,
// MidpointRounding.AwayFromZero), float.CompareTo and the unstable introsort behind Array.Sort / List<T>.Sort.

import { toUpperSameLength } from './find-in-files.js';

const ILLEGAL_PATH = /["<>|\u0000-\u001f]/;

function checkPathChars(path) {
  if (ILLEGAL_PATH.test(path)) throw new Error('Illegal characters in path.');
}

const isSep = (c) => c === '\\' || c === '/' || c === ':';

/** Path.GetFileName: the text after the last \, / or :. */
export function netGetFileName(path) {
  if (path == null) return path;
  checkPathChars(path);
  for (let i = path.length; --i >= 0;) if (isSep(path[i])) return path.slice(i + 1);
  return path;
}

/** Path.GetFileNameWithoutExtension: the file name cut at its last dot. */
export function netGetFileNameWithoutExtension(path) {
  const name = netGetFileName(path);
  if (name == null) return name;
  const dot = name.lastIndexOf('.');
  return dot < 0 ? name : name.slice(0, dot);
}

/** Path.GetExtension: from the last dot of the file name, "" when there is none or it ends the name. */
export function netGetExtension(path) {
  if (path == null) return path;
  checkPathChars(path);
  const n = path.length;
  for (let i = n; --i >= 0;) {
    const c = path[i];
    if (c === '.') return i !== n - 1 ? path.slice(i) : '';
    if (isSep(c)) break;
  }
  return '';
}

/** string.Equals(a, b, StringComparison.OrdinalIgnoreCase). */
export function eqIgnoreCase(a, b) {
  if (a == null || b == null) return a === b;
  return a.length === b.length && (a === b || toUpperSameLength(a) === toUpperSameLength(b));
}

/** string.EndsWith(suffix, StringComparison.OrdinalIgnoreCase). */
export function endsWithIC(s, suffix) {
  return s.length >= suffix.length && eqIgnoreCase(s.slice(s.length - suffix.length), suffix);
}

/** The key a StringComparer.OrdinalIgnoreCase set or dictionary files a string under. */
export const ignoreCaseKey = (s) => toUpperSameLength(s);

/** (float)Math.Round((double)f, 3, MidpointRounding.AwayFromZero), -0 kept as BinaryWriter would write it. */
export function netRound3(v) {
  if (!(Math.abs(v) < 1e16)) return Math.fround(v);
  let x = v * 1000;
  const whole = Math.trunc(x);
  const frac = x - whole;
  x = whole;
  if (Math.abs(frac) >= 0.5) x += Math.sign(frac);
  return Math.fround(x / 1000);
}

/** float.CompareTo: NaN below everything (and equal to NaN), -0 equal to 0. */
export function floatCompareTo(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  if (a === b) return 0;
  if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : -1;
  return 1;
}

/** Backing-array length of a List<T> filled by Add from empty: 0, then 4, doubling. */
export function listCapacity(count) {
  if (count === 0) return 0;
  let cap = 4;
  while (cap < count) cap *= 2;
  return cap;
}

const INCONSISTENT = 'Unable to sort because the IComparer.Compare() method returns inconsistent results. Either a value does not compare equal to itself, or one value repeatedly compared to another value yields different results.';

function floorLog2(n) {
  let r = 0;
  while (n >= 1) {
    r++;
    n = Math.floor(n / 2);
  }
  return r;
}

function swapIfGreater(k, cmp, a, b) {
  if (a !== b && cmp(k[a], k[b]) > 0) {
    const t = k[a];
    k[a] = k[b];
    k[b] = t;
  }
}

function swap(k, i, j) {
  const t = k[i];
  k[i] = k[j];
  k[j] = t;
}

function insertionSort(k, lo, hi, cmp) {
  for (let i = lo; i < hi; i++) {
    let j = i;
    const t = k[i + 1];
    while (j >= lo && cmp(t, k[j]) < 0) {
      k[j + 1] = k[j];
      j--;
    }
    k[j + 1] = t;
  }
}

function downHeap(k, i, n, lo, cmp) {
  const d = k[lo + i - 1];
  while (i <= Math.floor(n / 2)) {
    let child = 2 * i;
    if (child < n && cmp(k[lo + child - 1], k[lo + child]) < 0) child++;
    if (!(cmp(d, k[lo + child - 1]) < 0)) break;
    k[lo + i - 1] = k[lo + child - 1];
    i = child;
  }
  k[lo + i - 1] = d;
}

function heapsort(k, lo, hi, cmp) {
  const n = hi - lo + 1;
  for (let i = Math.floor(n / 2); i >= 1; i--) downHeap(k, i, n, lo, cmp);
  for (let i = n; i > 1; i--) {
    swap(k, lo, lo + i - 1);
    downHeap(k, 1, i - 1, lo, cmp);
  }
}

function pickPivotAndPartition(k, lo, hi, cmp) {
  const middle = lo + ((hi - lo) >> 1);
  swapIfGreater(k, cmp, lo, middle);
  swapIfGreater(k, cmp, lo, hi);
  swapIfGreater(k, cmp, middle, hi);
  const pivot = k[middle];
  swap(k, middle, hi - 1);
  let left = lo, right = hi - 1;
  while (left < right) {
    while (cmp(k[++left], pivot) < 0) if (left >= hi) throw new Error(INCONSISTENT);
    while (cmp(pivot, k[--right]) < 0) if (right <= lo) throw new Error(INCONSISTENT);
    if (left >= right) break;
    swap(k, left, right);
  }
  swap(k, left, hi - 1);
  return left;
}

function introSort(k, lo, hi, depthLimit, cmp) {
  while (hi > lo) {
    const size = hi - lo + 1;
    if (size <= 16) {
      if (size === 2) swapIfGreater(k, cmp, lo, hi);
      else if (size === 3) {
        swapIfGreater(k, cmp, lo, hi - 1);
        swapIfGreater(k, cmp, lo, hi);
        swapIfGreater(k, cmp, hi - 1, hi);
      } else insertionSort(k, lo, hi, cmp);
      return;
    }
    if (depthLimit === 0) {
      heapsort(k, lo, hi, cmp);
      return;
    }
    depthLimit--;
    const p = pickPivotAndPartition(k, lo, hi, cmp);
    introSort(k, p + 1, hi, depthLimit, cmp);
    hi = p - 1;
  }
}

/**
 * Array.Sort(T[], Comparison) / List<T>.Sort(Comparison) of .NET Framework 4.5+: introsort, not stable, so equal
 * keys end up where the desktop puts them. `capacity` is the length of the backing array (a List's Capacity),
 * which sets the depth limit.
 */
export function netSort(keys, cmp, capacity = keys.length) {
  if (keys.length >= 2) introSort(keys, 0, keys.length - 1, 2 * floorLog2(capacity), cmp);
  return keys;
}
