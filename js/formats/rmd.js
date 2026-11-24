// Xbox One .rmd weapon / armour mesh, ported from HappyTool/RrmConvert/XboxRmdParser.cs (Parse) and
// RrmModelParser.TryParseXboxRmd. Only what the model fingerprints need is kept: positions (float32), the vertex
// counts of the normal and UV streams, and the triangle indices. Out-of-range reads in the bone streams throw, as
// the desktop's array reads do.

import { trianglesFromList, trianglesFromStrip } from './rrm.js';

const MAX_VC = 8_000_000;
const MAX_IC = 24_000_000;
const isRestart = (u) => u === 0xffffffff || u === 0xfffffffe;
const OUT_OF_BOUNDS = 'Index was outside the bounds of the array.';

function matches4(d, i, s) {
  return i + 3 < d.length && d[i] === s.charCodeAt(0) && d[i + 1] === s.charCodeAt(1) && d[i + 2] === s.charCodeAt(2) && d[i + 3] === s.charCodeAt(3);
}

/** Encoding.ASCII.GetString of the bytes up to a NUL, the end of the data or maxLen. */
function readAscii(d, start, maxLen) {
  let s = '';
  for (let e = start; e < d.length && e < start + maxLen && d[e] !== 0; e++) s += d[e] < 0x80 ? String.fromCharCode(d[e]) : '?';
  return s;
}

/** BitConverter.ToUInt32 / ToSingle bounds behaviour: an offset past the end throws. */
function checkRead(d, off) {
  if (off < 0 || off >= d.length) throw new Error('Index was out of range. Must be non-negative and less than the size of the collection.\r\nParameter name: startIndex');
  if (off > d.length - 4) throw new Error('Destination array is not long enough to copy all the items in the collection. Check array index and length.');
}

/**
 * XboxRmdParser.Parse: scans for 0VC (stream name) / 0V3L / 0V2L / 0UIL blocks; the last position, normal, UV and
 * index streams win.
 * @returns {{positions: Float32Array, normalCount: number, uvCount: number, indices: Uint32Array}}
 */
export function parseXboxRmd(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const u32 = (o) => dv.getUint32(o, true);
  let positions = new Float32Array(0), normalCount = 0, uvCount = 0, indices = new Uint32Array(0);
  let state = null;
  let i = 0;
  while (i < d.length - 4) {
    if (d[i] === 0x30 && d[i + 1] === 0x56 && d[i + 2] === 0x43 && d[i + 3] === 0) {
      const sp = i + 12;
      if (sp + 12 < d.length && d[sp] === 0x30 && d[sp + 1] === 0x53 && d[sp + 2] === 0x50) state = readAscii(d, sp + 12, 64);
      i += 4;
      continue;
    }
    const v3 = matches4(d, i, '0V3L');
    if (v3 || matches4(d, i, '0V2L')) {
      const uip = i + 12;
      if (uip + 16 <= d.length && matches4(d, uip, '0UIP')) {
        const count = u32(uip + 12), ds = uip + 16;
        if (ds + count * (v3 ? 12 : 8) > d.length) {
          i += 4;
          continue;
        }
        if (v3) {
          if (state === 'position') positions = new Float32Array(d.slice(ds, ds + count * 12).buffer);
          else if (state === 'normal') normalCount = count;
        } else uvCount = count;
      }
      i += 4;
      continue;
    }
    if (matches4(d, i, '0UIL')) {
      const uip = i + 12;
      if (uip + 16 <= d.length && matches4(d, uip, '0UIP')) {
        const count = u32(uip + 12), ds = uip + 16;
        if (ds + count * 4 <= d.length) {
          indices = new Uint32Array(count);
          for (let j = 0; j < count; j++) indices[j] = u32(ds + j * 4);
        }
      }
      i += 4;
      continue;
    }
    if ((state === 'boneId' || state === 'weight') && matches4(d, i, '0UIP')) {
      checkRead(d, i + 12);
      const count = u32(i + 12), ds = i + 16;
      const vc = Math.floor(count / 2);
      if (state === 'boneId') {
        if (vc > 0 && ds + vc * 2 - 1 >= d.length) throw new Error(OUT_OF_BOUNDS);
        i = ds + (count | 0);
      } else {
        // Reads every 4 bytes from ds; the first read that does not fit throws.
        if (vc > 0 && ds + (vc * 2 - 1) * 4 > d.length - 4) checkRead(d, ds + 4 * Math.max(0, Math.floor((d.length - 4 - ds) / 4) + 1));
        i = ds + Math.imul(count | 0, 4);
      }
      state = null;
      continue;
    }
    i += 2;
  }
  return { positions, normalCount, uvCount, indices };
}

/**
 * RrmModelParser.TryParseXboxRmd: the mesh, or {error} with the desktop's message. The index list is padded with
 * its last value in threes up to a multiple of six; a count that is not a multiple of three never gets there and
 * the desktop runs out of memory.
 * @returns {{positions: Float32Array, indices: Uint32Array} | {error: string}}
 */
export function parseRmdMesh(u8) {
  if (!u8 || u8.length < 32) return { error: 'RMD payload is too small.' };
  const x = parseXboxRmd(u8);
  const vc = x.positions.length / 3;
  if (vc < 1 || vc > MAX_VC) return { error: 'RMD has no usable vertices.' };
  if (x.normalCount !== vc || x.uvCount !== vc) return { error: 'RMD vertex/normal/UV stream length mismatch.' };
  if (x.indices.length < 3) return { error: 'RMD has no usable index buffer.' };
  let entries = x.indices;
  if (entries.length % 3 !== 0) throw new Error("Exception of type 'System.OutOfMemoryException' was thrown.");
  if (entries.length % 6 !== 0) {
    const last = entries[entries.length - 1];
    const padded = new Uint32Array(entries.length + 3);
    padded.set(entries);
    padded.fill(last, entries.length);
    entries = padded;
  }
  if (entries.length > MAX_IC) return { error: 'RMD index buffer is too large.' };
  let maxIndex = -1, restarts = 0;
  for (const v of entries) {
    if (isRestart(v)) { restarts++; continue; }
    if (v > 0x7fffffff) return { error: 'RMD index value is too large.' };
    if (v > maxIndex) maxIndex = v;
  }
  if (maxIndex >= vc) return { error: `RMD index references vertex ${maxIndex} but vertex count is ${vc}.` };
  const list = trianglesFromList(entries, vc);
  const strip = trianglesFromStrip(entries, vc);
  // The score comparison only runs when one candidate is empty, and the fallback then takes the longer one.
  let chosen;
  if (restarts > 0 && strip.length >= 3) chosen = strip;
  else if (restarts === 0 && list.length >= 3) chosen = list;
  else chosen = strip.length >= list.length ? strip : list;
  if (chosen.length < 3) return { error: 'RMD indices could not be expanded to triangles.' };
  return { positions: x.positions, indices: Uint32Array.from(chosen) };
}
