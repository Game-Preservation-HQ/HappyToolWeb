// Small byte, text and download helpers shared by the format modules and the UI.

export const ascii4 = (u8, off = 0) =>
  u8.length >= off + 4 ? String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]) : '';

export function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function sha256Hex(u8) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', u8));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Growable little/big-endian byte writer. */
export class ByteWriter {
  constructor(capacity = 1024) {
    this.buf = new Uint8Array(capacity);
    this.pos = 0;
  }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }
  u8(v) {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
  }
  u32(v, littleEndian = true) {
    this.ensure(4);
    new DataView(this.buf.buffer).setUint32(this.pos, v >>> 0, littleEndian);
    this.pos += 4;
  }
  bytes(u8) {
    this.ensure(u8.length);
    this.buf.set(u8, this.pos);
    this.pos += u8.length;
  }
  zeros(n) {
    this.ensure(n);
    this.buf.fill(0, this.pos, this.pos + n);
    this.pos += n;
  }
  patchU32(at, v, littleEndian = true) {
    new DataView(this.buf.buffer).setUint32(at, v >>> 0, littleEndian);
  }
  result() {
    return this.buf.slice(0, this.pos);
  }
}

export const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');
export const decodeUtf8 = (u8) => utf8Decoder.decode(u8);

// Shift-JIS: the game's scripts (.nut) carry Japanese comments in it. Browsers decode it but have no encoder, so the
// encoder is the decoder's table turned around (built once, on first use; ~7,000 double-byte codes).
let sjisTable = null;
function sjisEncoder() {
  if (sjisTable) return sjisTable;
  sjisTable = new Map();
  const dec = new TextDecoder('shift_jis');
  const pair = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfc; lead++) {
    if (lead >= 0xa0 && lead <= 0xdf) continue;
    pair[0] = lead;
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue;
      pair[1] = trail;
      const s = dec.decode(pair);
      if (s.length === 1 && s !== '�' && !sjisTable.has(s)) sjisTable.set(s, (lead << 8) | trail);
    }
  }
  return sjisTable;
}
/** Shift-JIS bytes for this text; a character it has no code for becomes '?'. */
export function encodeShiftJis(text) {
  const map = sjisEncoder();
  const out = new Uint8Array(text.length * 2);
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out[n++] = c;
    else if (c >= 0xff61 && c <= 0xff9f) out[n++] = c - 0xff61 + 0xa1; // half-width katakana
    else {
      const v = map.get(ch);
      if (v === undefined) out[n++] = 0x3f;
      else (out[n++] = v >> 8), (out[n++] = v & 0xff);
    }
  }
  return out.slice(0, n);
}
const isUtf8 = (u8) => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(u8);
    return true;
  } catch {
    return false;
  }
};

/** Decode text with a BOM-aware guess: UTF-8 (default), UTF-16 LE/BE when a BOM says so, Shift-JIS when the bytes are
 *  not UTF-8 but are Shift-JIS that writes back byte for byte. */
export function decodeText(u8) {
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf)
    return { text: decodeUtf8(u8.subarray(3)), encoding: 'utf-8-bom' };
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe)
    return { text: new TextDecoder('utf-16le').decode(u8.subarray(2)), encoding: 'utf-16le-bom' };
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff)
    return { text: new TextDecoder('utf-16be').decode(u8.subarray(2)), encoding: 'utf-16be-bom' };
  if (!isUtf8(u8)) {
    const text = new TextDecoder('shift_jis').decode(u8);
    if (bytesEqual(encodeShiftJis(text), u8)) return { text, encoding: 'shift_jis' };
  }
  return { text: decodeUtf8(u8), encoding: 'utf-8' };
}

export function encodeText(text, encoding) {
  switch (encoding) {
    case 'utf-8-bom':
      return concat([new Uint8Array([0xef, 0xbb, 0xbf]), utf8.encode(text)]);
    case 'utf-16le-bom':
    case 'utf-16be-bom': {
      const be = encoding === 'utf-16be-bom';
      const out = new Uint8Array(2 + text.length * 2);
      out[0] = be ? 0xfe : 0xff;
      out[1] = be ? 0xff : 0xfe;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        out[2 + i * 2] = be ? c >> 8 : c & 0xff;
        out[3 + i * 2] = be ? c & 0xff : c >> 8;
      }
      return out;
    }
    case 'shift_jis':
      return encodeShiftJis(text);
    default:
      return utf8.encode(text);
  }
}

/** True when the first bytes look like text (no NULs, few control characters). */
export function looksLikeText(u8, sample = 4096) {
  const n = Math.min(u8.length, sample);
  if (n === 0) return false;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = u8[i];
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32)) bad++;
  }
  return bad / n < 0.02;
}

export function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function downloadBytes(u8, name, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([u8], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export const baseName = (path) => path.split(/[\\/]/).pop();
export const extOf = (name) => {
  const b = baseName(name);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i).toLowerCase() : '';
};

/**
 * Textareas turn every CRLF into LF. Many game text files use CRLF, often mixed with LF, so keep each line's ending:
 * lineEndings() records them, restoreLineEndings() puts them back after an edit. Unchanged lines at the start and
 * end keep their own endings; edited and new lines get the file's most common one.
 */
export function lineEndings(text) {
  const lines = text.split('\n');
  const last = lines.length - 1;
  const cr = lines.map((l, i) => i < last && l.endsWith('\r'));
  const plain = lines.map((l, i) => (cr[i] ? l.slice(0, -1) : l));
  const crlf = cr.reduce((n, c) => n + c, 0);
  const crMostly = crlf * 2 > last;
  return { plain, cr, any: crlf > 0, crMostly, eol: crMostly ? '\r\n' : '\n' };
}

export function restoreLineEndings(edited, base) {
  if (!base.any) return edited;
  const lines = edited.split('\n');
  const n = lines.length;
  const m = base.plain.length;
  let p = 0;
  while (p < n && p < m && lines[p] === base.plain[p]) p++;
  let s = 0;
  while (s < n - p && s < m - p && lines[n - 1 - s] === base.plain[m - 1 - s]) s++;
  const parts = [];
  for (let i = 0; i < n; i++) {
    parts.push(lines[i]);
    if (i === n - 1) break;
    // the old last line had no line break after it, so a break added there is new
    const cr = i < p && i < m - 1 ? base.cr[i] : i >= n - s ? base.cr[m - (n - i)] : base.crMostly;
    parts.push(cr ? '\r\n' : '\n');
  }
  return parts.join('');
}
