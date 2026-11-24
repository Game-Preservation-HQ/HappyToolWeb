// .vmd: Happy Wars voice-macro table (port of HappyTool/Formats/VoiceMacroCatalog.cs).
// A 12-byte header (version, group count, offset of the first group = 12) and 28-byte groups: id, variation count,
// menu position (int32 each) and a 16-byte NUL-padded ASCII menu text id. Little-endian on PC, big-endian on Xbox 360;
// the header decides which. The id is category * 1000 + usage; menu positions of 100+ show as T<n>, 200+ as C<n>.

import { netIntTryParse as csIntTryParse } from './net-text.js';

export { csIntTryParse };
const HEADER = 12;
const GROUP = 28;
const TEXT_BYTES = 16;
export const MAX_MENU_TEXT_ID_CHARS = 15;

export const groupId = (g) => (Math.imul(g.category, 1000) + g.usage) | 0;

export function decodeMenuPosition(menuPos) {
  if (menuPos >= 200) return 'C' + (menuPos - 200);
  if (menuPos >= 100) return 'T' + (menuPos - 100);
  if (menuPos === 0) return '';
  return String(menuPos);
}

export function encodeMenuPosition(cell) {
  if (cell == null || !cell.trim()) return 0;
  const s = cell.trim();
  let base;
  if (/^t/i.test(s)) base = 100;
  else if (/^c/i.test(s)) base = 200;
  else return csIntTryParse(s) ?? 0;
  if (s.length <= 1) return base;
  const num = csIntTryParse(s.slice(1));
  return num === null ? 0 : (base + num) | 0;
}

const readI32 = (d, off, be) =>
  be ? (d[off] << 24) | (d[off + 1] << 16) | (d[off + 2] << 8) | d[off + 3] : d[off] | (d[off + 1] << 8) | (d[off + 2] << 16) | (d[off + 3] << 24);

const looksLikeValidHeader = (version, count, top, len) =>
  version >= 1 && version <= 100 && count >= 0 && count <= 100000 && top === HEADER && len === HEADER + count * GROUP;

function detectBigEndian(d) {
  const ok = (be) => looksLikeValidHeader(readI32(d, 0, be), readI32(d, 4, be), readI32(d, 8, be), d.length);
  const le = ok(false);
  const be = ok(true);
  if (le) return false;
  if (be) return true;
  throw new Error('Unrecognized .vmd header (invalid version, count, or file size).');
}

/** Encoding.ASCII.GetString up to the first NUL: bytes above 127 read as '?'. */
function readAsciiField(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b === 0) break;
    s += b > 127 ? '?' : String.fromCharCode(b);
  }
  return s;
}

/**
 * @typedef {{category: number, usage: number, variationCount: number, menuPosition: string, menuTextId: string}} VoiceGroup
 * @typedef {{version: number, bigEndian: boolean, groups: VoiceGroup[]}} VmdFile
 * @returns {VmdFile}
 */
export function parseVmd(d, embedded = false) {
  if (embedded && d.length === 0) throw new Error('No data.'); // VoiceMacroCatalog.TryLoadFromBytes (bundle entries)
  if (d.length < HEADER) throw new Error('File is too small to be a valid .vmd file.');
  const bigEndian = detectBigEndian(d);
  const version = readI32(d, 0, bigEndian);
  const count = readI32(d, 4, bigEndian);
  if (!looksLikeValidHeader(version, count, readI32(d, 8, bigEndian), d.length)) throw new Error('Invalid .vmd header.');
  const groups = [];
  let off = HEADER;
  for (let i = 0; i < count; i++) {
    if (off + GROUP > d.length) throw new Error('Unexpected end of file while reading voice groups.');
    const id = readI32(d, off, bigEndian);
    groups.push({
      category: Math.trunc(id / 1000),
      usage: id % 1000,
      variationCount: readI32(d, off + 4, bigEndian),
      menuPosition: decodeMenuPosition(readI32(d, off + 8, bigEndian)),
      menuTextId: readAsciiField(d.subarray(off + 12, off + 12 + TEXT_BYTES)),
    });
    off += GROUP;
  }
  groups.sort((a, b) => groupId(a) - groupId(b));
  return { version, bigEndian, groups };
}

/** The desktop's check before saving; throws with its message. */
export function validateVmd(file) {
  if (!file.groups) throw new Error('Voice group list is missing.');
  const ids = new Set();
  for (const g of file.groups) {
    if (g.category < 0 || g.usage < 0) throw new Error('Category and usage must be non-negative.');
    if (g.variationCount < 0) throw new Error('Variation count must be non-negative.');
    const id = groupId(g);
    if (ids.has(id)) throw new Error('Duplicate voice group id: ' + id);
    ids.add(id);
    const text = g.menuTextId ?? '';
    if (text.length > MAX_MENU_TEXT_ID_CHARS)
      throw new Error(`Menu text id is too long (max ${MAX_MENU_TEXT_ID_CHARS} ASCII chars): ${text}`);
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) throw new Error('Menu text id must be ASCII: ' + text);
  }
}

/** Header, then the groups ordered by id (stable), in the file's byte order. */
export function writeVmd(file) {
  validateVmd(file);
  const groups = file.groups.map((g, i) => [g, i]).sort((a, b) => groupId(a[0]) - groupId(b[0]) || a[1] - b[1]).map((p) => p[0]);
  const out = new Uint8Array(HEADER + groups.length * GROUP);
  const dv = new DataView(out.buffer);
  const le = !file.bigEndian;
  dv.setInt32(0, file.version <= 0 ? 1 : file.version, le);
  dv.setInt32(4, groups.length, le);
  dv.setInt32(8, HEADER, le);
  let off = HEADER;
  for (const g of groups) {
    dv.setInt32(off, groupId(g), le);
    dv.setInt32(off + 4, g.variationCount, le);
    dv.setInt32(off + 8, encodeMenuPosition(g.menuPosition), le);
    const text = g.menuTextId ?? '';
    for (let i = 0; i < Math.min(text.length, TEXT_BYTES); i++) out[off + 12 + i] = text.charCodeAt(i);
    off += GROUP;
  }
  return out;
}

/** True when the bytes parse as a .vmd (the desktop's test for opening a bundle entry). */
export function isVmd(d) {
  try {
    if (!d || d.length === 0) return false;
    parseVmd(d);
    return true;
  } catch {
    return false;
  }
}
