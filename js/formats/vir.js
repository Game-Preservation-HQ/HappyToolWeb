// .vir: Happy Wars resource descriptor ("TRF" + version byte), shown read-only the way the desktop VirFileEditor
// shows it: an info line, then every 32-bit word decoded big-endian (hex, uint32, int16 pair, float) and a hex dump
// of the first 256 KB.

import { netFormatFloat, netN0 } from './net-text.js';

const MAX_HEX_BYTES = 256 * 1024;
const F_1E_4 = Math.fround(1e-4);
const NL = '\n';

export const isTrf = (d) => d.length >= 4 && d[0] === 0x54 && d[1] === 0x52 && d[2] === 0x46;
export const trfVersion = (d) => (d.length >= 4 ? d[3] : 0);

/** "<path>  |  N bytes  |  TRF vX" (or "not a TRF descriptor"). */
export const virInfo = (label, d) => `${label}  |  ${netN0(d.length)} bytes${isTrf(d) ? `  |  TRF v${trfVersion(d)}` : '  |  not a TRF descriptor'}`;

export const VIR_WARNING = 'This file does not look like a Happy Wars .vir ("TRF") descriptor.';

function formatFloat(f) {
  const abs = Math.abs(f);
  if (abs !== 0 && (abs < F_1E_4 || abs >= 1e7)) return netFormatFloat(f, '0.###e+00');
  return netFormatFloat(f, '0.####'); // NaN and infinities come out as float.ToString() does
}

const hex2 = (b) => b.toString(16).toUpperCase().padStart(2, '0');

/** VirFileEditor.HexDump: 16 bytes a line, offset, hex, ASCII; a note when the file is longer than maxBytes. */
export function hexDump(d, maxBytes = MAX_HEX_BYTES) {
  if (!d || d.length === 0) return '';
  const len = Math.min(d.length, maxBytes);
  const out = [];
  for (let offset = 0; offset < len; offset += 16) {
    let s = offset.toString(16).toUpperCase().padStart(8, '0') + '  ';
    for (let i = 0; i < 16; i++) s += offset + i < len ? hex2(d[offset + i]) + ' ' : '   ';
    s += ' ';
    for (let i = 0; i < 16 && offset + i < len; i++) {
      const ch = d[offset + i];
      s += ch >= 32 && ch < 127 ? String.fromCharCode(ch) : '.';
    }
    out.push(s + NL);
  }
  if (len < d.length) out.push(NL + `(truncated — showing first ${netN0(len)} bytes)`);
  return out.join('');
}

/** VirFileEditor.BuildReport. */
export function buildVirReport(d) {
  const valid = isTrf(d);
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const out = ['Happy Wars resource descriptor (.vir)' + NL];
  if (valid) out.push(`Magic: TRF   Version: ${trfVersion(d)}` + NL);
  out.push(NL);
  out.push('Offset  Hex        UInt32        Int16 pair       Float' + NL);
  out.push('------  --------   -----------   --------------   ------------' + NL);
  for (let o = 0; o + 4 <= d.length; o += 4) {
    const u = dv.getUint32(o, false);
    const a = (u >>> 16) << 16 >> 16;
    const b = (u & 0xffff) << 16 >> 16;
    const f = dv.getFloat32(o, false);
    const note = o === 0 && valid ? "   magic 'TRF' + version" : '';
    out.push(
      '+' + String(o).padStart(2, '0') + '     ' +
        u.toString(16).toUpperCase().padStart(8, '0') + '   ' +
        String(u).padStart(11) + '   ' +
        `(${a},${b})`.padEnd(15) + '  ' +
        formatFloat(f).padStart(12) +
        note + NL,
    );
  }
  out.push(NL);
  out.push('Raw hex:' + NL);
  out.push(hexDump(d));
  return out.join('');
}
