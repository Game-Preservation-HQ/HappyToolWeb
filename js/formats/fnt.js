// .fnt: Happy Wars "FTDF" bitmap font, shown read-only the way the desktop FntFileEditor shows it: an info line, then
// the header fields, the glyph table (first 1024 rows), the first 64 mapped codepoints and a hex dump of the first
// 128 KB. Parsing follows FtdfFont.Parse; the report follows FntFileEditor.BuildReport.

import { netFormatFloat, netN0 } from './net-text.js';
import { hexDump } from './vir.js';

const MAX_HEX_BYTES = 128 * 1024;
const GLYPH_RECORD_SIZE = 40;
const GLYPH_TABLE_START = 0x40;
const MAX_GLYPH_ROWS = 1024;
const NL = '\n';

export const looksLikeFtdf = (d) => !!d && d.length >= 4 && d[0] === 0x46 && d[1] === 0x54 && d[2] === 0x44 && d[3] === 0x46;

export const FNT_WARNING = 'This file does not look like a Happy Wars .fnt ("FTDF") bitmap font.';

const u16 = (d, o) => (o + 1 < d.length ? d[o] | (d[o + 1] << 8) : 0);
const u32 = (d, o) => (o + 3 < d.length ? (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0 : 0);
const lef = (d, o) => (o + 3 < d.length ? new DataView(d.buffer, d.byteOffset + o, 4).getFloat32(0, true) : 0);

/** Encoding.ASCII.GetString of a NUL-terminated run of at most `max` bytes (bytes over 127 read as '?'). */
function readCString(d, o, max) {
  if (!d || o < 0 || o >= d.length) return '';
  const end = Math.min(d.length, o + max);
  let s = '';
  for (let n = o; n < end && d[n] !== 0; n++) s += d[n] > 127 ? '?' : String.fromCharCode(d[n]);
  return s;
}

/** FtdfFont.Parse: the fields the report uses (font name, glyph count, codepoint → glyph table). */
export function parseFtdf(d) {
  if (!looksLikeFtdf(d)) throw new Error('Not an FTDF bitmap font.');
  if (d.length < GLYPH_TABLE_START + GLYPH_RECORD_SIZE) throw new Error('FTDF header too short.');
  const nameOff = u32(d, 0x14);
  const fontName = nameOff > 0 && nameOff < d.length ? readCString(d, nameOff, 64) : '';
  let glyphCount = u16(d, 0x0e);
  if (glyphCount <= 0) glyphCount = Math.max(0, Math.trunc((Math.min(nameOff > 0 ? nameOff : d.length, d.length) - GLYPH_TABLE_START) / GLYPH_RECORD_SIZE));
  const lutStart = GLYPH_TABLE_START + glyphCount * GLYPH_RECORD_SIZE;
  const lutEnd = nameOff > lutStart && nameOff <= d.length ? nameOff : d.length;
  const lutCount = Math.max(0, Math.trunc((lutEnd - lutStart) / 2));
  const codepointToGlyph = new Uint16Array(lutCount);
  for (let cp = 0; cp < lutCount; cp++) codepointToGlyph[cp] = u16(d, lutStart + cp * 2);
  return { fontName, glyphCount, codepointToGlyph };
}

/** The font the desktop's report uses: parsed when the magic is right, null when the parse fails. */
export function tryParseFtdf(d) {
  if (!looksLikeFtdf(d)) return null;
  try {
    return parseFtdf(d);
  } catch {
    return null; // the report still shows the raw decode
  }
}

/** "<path>  |  N bytes  |  FTDF bitmap font  |  FontName" (or "not an FTDF font"). */
export function fntInfo(label, d, font) {
  let s = `${label}  |  ${netN0(d.length)} bytes${looksLikeFtdf(d) ? '  |  FTDF bitmap font' : '  |  not an FTDF font'}`;
  if (font && font.fontName) s += '  |  ' + font.fontName;
  return s;
}

const fmt = (f, format) => (Number.isFinite(f) ? netFormatFloat(f, format) : '?');
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');

/** FntFileEditor.BuildReport. Lines end in "\n" where the desktop's StringBuilder.AppendLine writes "\r\n". */
export function buildFntReport(d, font = tryParseFtdf(d)) {
  const valid = looksLikeFtdf(d);
  const out = ['Happy Wars bitmap font (.fnt / "FTDF") — little-endian' + NL, NL];
  if (!valid || d.length < GLYPH_TABLE_START) {
    out.push('(Header too short or missing FTDF magic.)' + NL, NL, 'Raw hex:' + NL, hexDump(d, MAX_HEX_BYTES));
    return out.join('');
  }

  const verLo = d[4];
  const verHi = d[5];
  const bom = u16(d, 6);
  const line0 = u16(d, 0x08);
  const line1 = u16(d, 0x0a);
  const line2 = u16(d, 0x0c);
  const field0E = u16(d, 0x0e);
  const atlas = u16(d, 0x18);
  const stride = u16(d, 0x1a);
  const asciiCount = u16(d, 0x22);
  const nameOff = u32(d, 0x14);

  const recSize = stride > 0 ? stride : GLYPH_RECORD_SIZE;
  const tableEnd = nameOff > GLYPH_TABLE_START && nameOff <= d.length ? nameOff : d.length;
  const glyphCount = font ? font.glyphCount : Math.max(0, Math.trunc((tableEnd - GLYPH_TABLE_START) / recSize));
  const fontName = font ? font.fontName : readCString(d, nameOff | 0, 64); // (int)nameOff
  let mapped = 0;
  if (font) for (const gi of font.codepointToGlyph) if (gi !== 0) mapped++;

  out.push(
    'Magic       : FTDF' + NL,
    `Version     : ${verHi}.${verLo}` + NL,
    'Text codec  : ' + (bom === 0xfeff ? 'UTF-16 (BOM 0xFEFF)' : '0x' + hex4(bom)) + NL,
    'Font name   : ' + (fontName ? fontName : '(none)') + NL,
    `Line metrics: ${line0} / ${line1} / ${line2}   (glyph count @0x0E=${field0E})` + NL,
    `Atlas hint  : ${atlas} wide (height from companion DDS)` + NL,
    `Glyph stride: ${recSize} bytes` + NL,
    `ASCII hint  : ${asciiCount}` + NL,
    `Total glyphs: ${glyphCount}` + NL,
    `Mapped cps  : ${mapped}  (via codepoint LUT after glyph table)` + NL,
    'Name offset : 0x' + nameOff.toString(16).toUpperCase() + NL,
    NL,
    'Banks: glyph class 256/257/258/259 = atlas R/G/B/A channels.' + NL,
    'Export TTF embeds the bitmaps (CBDT/CBLC) from the companion .bres atlas.' + NL,
    NL,
    'Glyphs (index, bank, U0, U1, V, X-off, Y-off, X-adv, height):' + NL,
    'idx    bank   U0       U1       V        Xoff    Yoff    XAdv    Hgt' + NL,
    '-----  -----  -------  -------  -------  ------  ------  ------  ------' + NL,
  );

  const shown = Math.min(glyphCount, MAX_GLYPH_ROWS);
  for (let i = 0; i < shown; i++) {
    const o = GLYPH_TABLE_START + i * recSize;
    if (o + recSize > d.length) break;
    out.push(
      String(i).padStart(5) + '  ' +
        String(u32(d, o + 0x04)).padStart(5) + '  ' +
        fmt(lef(d, o + 0x08), '0.###').padStart(7) + '  ' +
        fmt(lef(d, o + 0x10), '0.###').padStart(7) + '  ' +
        fmt(lef(d, o + 0x14), '0.###').padStart(7) + '  ' +
        fmt(lef(d, o + 0x18), '0.#').padStart(6) + '  ' +
        fmt(lef(d, o + 0x1c), '0.#').padStart(6) + '  ' +
        fmt(lef(d, o + 0x20), '0.##').padStart(6) + '  ' +
        fmt(lef(d, o + 0x24), '0.#').padStart(6) + NL,
    );
  }
  if (glyphCount > shown) out.push(`(… ${glyphCount - shown} more glyphs not shown)` + NL);

  if (font && mapped > 0) {
    out.push(NL, 'Sample codepoint map (first 64 mapped):' + NL);
    let n = 0;
    for (let cp = 0; cp < font.codepointToGlyph.length && n < 64; cp++) {
      const gi = font.codepointToGlyph[cp];
      if (gi === 0) continue;
      const ch = cp >= 0x20 && cp < 0x7f ? `'${String.fromCharCode(cp)}'` : 'U+' + hex4(cp);
      out.push('  ' + ch.padEnd(8) + ' → glyph ' + gi + NL);
      n++;
    }
  }

  out.push(NL, 'Raw hex:' + NL, hexDump(d, MAX_HEX_BYTES));
  return out.join('');
}
