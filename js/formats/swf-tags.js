// The movie editor's lossless model of a Scaleform movie (.sgfx / .gfx: CFX / GFX) or SWF (CWS / FWS), and a decoder /
// encoder for each tag type the game's movies use. Every tag keeps its header form (short or long) and its body bytes;
// DefineSprite keeps its own tag list. writeMovieBody writes untouched tags from their bytes, so an unchanged movie writes
// its input again, and encodeMovie hands back the input itself (no recompression) when nothing changed.
// A decoded tag re-encodes to its exact bytes (bit-packed records keep their bit counts while the values fit); a tag
// whose bytes don't come back the same is left as raw bytes by the editor.
import { decompressMovie, tagName } from './sgfx.js';

// ---------- bytes and bits ----------

const utf8Enc = new TextEncoder();
const utf8Dec = new TextDecoder('utf-8', { fatal: true });

export class Reader {
  constructor(b, p = 0) {
    this.b = b;
    this.p = p;
    this.bit = 0;
  }
  need(n) {
    if (this.p + n > this.b.length) throw new RangeError(`needs ${n} more byte${n === 1 ? '' : 's'} at ${this.p}, the tag has ${this.b.length}`);
  }
  align() {
    if (this.bit) {
      this.bit = 0;
      this.p++;
    }
  }
  u8() {
    this.align();
    this.need(1);
    return this.b[this.p++];
  }
  u16() {
    this.align();
    this.need(2);
    const v = this.b[this.p] | (this.b[this.p + 1] << 8);
    this.p += 2;
    return v;
  }
  s16() {
    const v = this.u16();
    return v >= 0x8000 ? v - 0x10000 : v;
  }
  u32() {
    this.align();
    this.need(4);
    const v = (this.b[this.p] | (this.b[this.p + 1] << 8) | (this.b[this.p + 2] << 16) | (this.b[this.p + 3] << 24)) >>> 0;
    this.p += 4;
    return v;
  }
  f32() {
    this.align();
    this.need(4);
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.p, 4).getFloat32(0, true);
    this.p += 4;
    return v;
  }
  bytes(n) {
    this.align();
    this.need(n);
    const v = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return v;
  }
  rest() {
    this.align();
    const v = this.b.subarray(this.p);
    this.p = this.b.length;
    return v;
  }
  get left() {
    return this.b.length - this.p - (this.bit ? 1 : 0);
  }
  /** A NUL-terminated UTF-8 string (throws on bytes that aren't UTF-8, so the tag stays raw). */
  cstr() {
    this.align();
    let e = this.p;
    while (e < this.b.length && this.b[e] !== 0) e++;
    if (e >= this.b.length) throw new RangeError(`a string at ${this.p} has no terminating zero`);
    const s = utf8Dec.decode(this.b.subarray(this.p, e));
    this.p = e + 1;
    return s;
  }
  /** A length-prefixed (u8) Latin-1 string, as Scaleform's tags store file and export names. */
  pstr() {
    const n = this.u8();
    const v = this.bytes(n);
    return String.fromCharCode(...v);
  }
  ub(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.p >= this.b.length) throw new RangeError(`bits past the end at ${this.p}`);
      v = v * 2 + ((this.b[this.p] >> (7 - this.bit)) & 1);
      if (++this.bit === 8) {
        this.bit = 0;
        this.p++;
      }
    }
    return v;
  }
  sb(n) {
    const v = this.ub(n);
    return n && v >= 2 ** (n - 1) ? v - 2 ** n : v;
  }
}

export class Writer {
  constructor(cap = 256) {
    this.buf = new Uint8Array(cap);
    this.len = 0;
    this.acc = 0;
    this.nacc = 0;
  }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  align() {
    if (this.nacc) {
      this.ensure(1);
      this.buf[this.len++] = (this.acc << (8 - this.nacc)) & 0xff;
      this.acc = 0;
      this.nacc = 0;
    }
  }
  u8(v) {
    this.align();
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new RangeError(`${v} is not a byte (0 to 255)`);
    this.ensure(1);
    this.buf[this.len++] = v;
  }
  u16(v) {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError(`${v} is not a 16-bit value (0 to 65535)`);
    this.align();
    this.ensure(2);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = v >> 8;
  }
  s16(v) {
    if (!Number.isInteger(v) || v < -0x8000 || v > 0x7fff) throw new RangeError(`${v} is not a signed 16-bit value (-32768 to 32767)`);
    this.u16(v & 0xffff);
  }
  u32(v) {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new RangeError(`${v} is not a 32-bit value`);
    this.align();
    this.ensure(4);
    for (let i = 0; i < 4; i++) this.buf[this.len++] = (v >>> (8 * i)) & 0xff;
  }
  f32(v) {
    this.align();
    this.ensure(4);
    new DataView(this.buf.buffer, this.len, 4).setFloat32(0, v, true);
    this.len += 4;
  }
  bytes(u8) {
    this.align();
    this.ensure(u8.length);
    this.buf.set(u8, this.len);
    this.len += u8.length;
  }
  cstr(s) {
    const b = utf8Enc.encode(String(s ?? ''));
    if (b.includes(0)) throw new RangeError('a string can’t hold a NUL character');
    this.bytes(b);
    this.u8(0);
  }
  pstr(s) {
    s = String(s ?? '');
    if (s.length > 255) throw new RangeError(`“${s.slice(0, 20)}…” is longer than 255 characters`);
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c > 255) throw new RangeError(`“${s}” has a character outside Latin-1`);
      b[i] = c;
    }
    this.u8(b.length);
    this.bytes(b);
  }
  ub(n, v) {
    if (!Number.isInteger(v) || v < 0 || v >= 2 ** n) throw new RangeError(`${v} doesn’t fit in ${n} bits`);
    for (let i = n - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | (Math.floor(v / 2 ** i) & 1);
      if (++this.nacc === 8) {
        this.ensure(1);
        this.buf[this.len++] = this.acc & 0xff;
        this.acc = 0;
        this.nacc = 0;
      }
    }
  }
  sb(n, v) {
    if (!fits(v, n)) throw new RangeError(`${v} doesn’t fit in ${n} signed bits`);
    this.ub(n, v < 0 ? v + 2 ** n : v);
  }
  result() {
    this.align();
    return this.buf.slice(0, this.len);
  }
}

const fits = (v, n) => Number.isInteger(v) && (n === 0 ? v === 0 : v >= -(2 ** (n - 1)) && v < 2 ** (n - 1));
const minBits = (v) => {
  let n = 0;
  while (!fits(v, n)) n++;
  return n;
};
/** The stored bit count while every value fits in it, else the fewest bits that hold them all. */
function bitsFor(stored, values, max) {
  const n = stored != null && values.every((v) => fits(v, stored)) ? stored : Math.max(0, ...values.map(minBits));
  if (n > max) throw new RangeError(`${values.find((v) => !fits(v, max))} is too large for this field`);
  return n;
}

export const bytesEqual = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

// ---------- records ----------

export function readRect(r) {
  r.align();
  const nbits = r.ub(5);
  const rc = { nbits, xMin: r.sb(nbits), xMax: r.sb(nbits), yMin: r.sb(nbits), yMax: r.sb(nbits) };
  r.align();
  return rc;
}
export function writeRect(w, rc) {
  w.align();
  const v = [rc.xMin, rc.xMax, rc.yMin, rc.yMax];
  const n = bitsFor(rc.nbits, v, 31);
  w.ub(5, n);
  for (const x of v) w.sb(n, x);
  w.align();
}

/** MATRIX: scale and rotate / skew are 16.16 fixed-point (65536 = 1), translate is in twips (20 = 1 px). */
export function readMatrix(r) {
  r.align();
  const m = { scale: null, rotate: null, translateBits: 0, tx: 0, ty: 0 };
  if (r.ub(1)) {
    const n = r.ub(5);
    m.scale = { nbits: n, x: r.sb(n), y: r.sb(n) };
  }
  if (r.ub(1)) {
    const n = r.ub(5);
    m.rotate = { nbits: n, r0: r.sb(n), r1: r.sb(n) };
  }
  m.translateBits = r.ub(5);
  m.tx = r.sb(m.translateBits);
  m.ty = r.sb(m.translateBits);
  r.align();
  return m;
}
export function writeMatrix(w, m) {
  w.align();
  w.ub(1, m.scale ? 1 : 0);
  if (m.scale) {
    const n = bitsFor(m.scale.nbits, [m.scale.x, m.scale.y], 31);
    w.ub(5, n);
    w.sb(n, m.scale.x);
    w.sb(n, m.scale.y);
  }
  w.ub(1, m.rotate ? 1 : 0);
  if (m.rotate) {
    const n = bitsFor(m.rotate.nbits, [m.rotate.r0, m.rotate.r1], 31);
    w.ub(5, n);
    w.sb(n, m.rotate.r0);
    w.sb(n, m.rotate.r1);
  }
  const n = bitsFor(m.translateBits, [m.tx, m.ty], 31);
  w.ub(5, n);
  w.sb(n, m.tx);
  w.sb(n, m.ty);
  w.align();
}
export const identityMatrix = () => ({ scale: null, rotate: null, translateBits: 0, tx: 0, ty: 0 });

/** CXFORM / CXFORMWITHALPHA: multiply terms are 8.8 fixed-point (256 = 1), add terms are added to 0-255 channels. */
export function readCxform(r, alpha) {
  r.align();
  const hasAdd = r.ub(1), hasMult = r.ub(1), nbits = r.ub(4);
  const k = alpha ? 4 : 3;
  const c = { nbits, mult: null, add: null };
  if (hasMult) c.mult = Array.from({ length: k }, () => r.sb(nbits));
  if (hasAdd) c.add = Array.from({ length: k }, () => r.sb(nbits));
  r.align();
  return c;
}
export function writeCxform(w, c, alpha) {
  w.align();
  const k = alpha ? 4 : 3;
  for (const t of [c.mult, c.add]) if (t && t.length !== k) throw new RangeError(`a colour transform here has ${k} terms`);
  const n = bitsFor(c.nbits, [...(c.mult ?? []), ...(c.add ?? [])], 15);
  w.ub(1, c.add ? 1 : 0);
  w.ub(1, c.mult ? 1 : 0);
  w.ub(4, n);
  for (const v of c.mult ?? []) w.sb(n, v);
  for (const v of c.add ?? []) w.sb(n, v);
  w.align();
}

const readRgb = (r) => [r.u8(), r.u8(), r.u8()];
const readRgba = (r) => [r.u8(), r.u8(), r.u8(), r.u8()];
const writeColor = (w, c, n) => {
  if (!Array.isArray(c) || c.length !== n) throw new RangeError(`a colour here has ${n} channels`);
  for (const v of c) w.u8(v);
};

// FILTERLIST (PlaceObject3, DefineButton2 records): kept as bytes; the sizes come from each filter's fields.
export const FILTER_NAMES = ['DropShadow', 'Blur', 'Glow', 'Bevel', 'GradientGlow', 'Convolution', 'ColorMatrix', 'GradientBevel'];
function readFilterList(r) {
  r.align();
  const start = r.p;
  const count = r.u8();
  const kinds = [];
  for (let i = 0; i < count; i++) {
    const id = r.u8();
    kinds.push(FILTER_NAMES[id] ?? `Filter ${id}`);
    let size;
    if (id === 0) size = 23;
    else if (id === 1) size = 9;
    else if (id === 2) size = 15;
    else if (id === 3) size = 27;
    else if (id === 4 || id === 7) {
      r.need(1);
      size = 20 + 5 * r.b[r.p];
    } else if (id === 5) {
      r.need(2);
      size = 15 + 4 * r.b[r.p] * r.b[r.p + 1];
    } else if (id === 6) size = 80;
    else throw new RangeError(`unknown filter ${id}`);
    r.bytes(size);
  }
  return { bytes: r.b.subarray(start, r.p), kinds };
}

// ---------- the movie ----------

const SIG_SET = new Set(['CFX', 'GFX', 'CWS', 'FWS']);
export const isCompressedSig = (sig) => sig[0] === 'C';
let uid = 0;
const tagIds = new WeakMap();
/** A number for a tag object that stays the same while the editor is open (the tree's keys). */
export const tagUid = (t) => {
  let v = tagIds.get(t);
  if (v == null) tagIds.set(t, (v = ++uid));
  return v;
};

/** Tags from `pos` to `end`: [{code, long, body}] (DefineSprite: {code, long, sprite: {id, frameCount, tags, tail}}). */
function parseTags(b, pos, end, nested) {
  const tags = [];
  while (pos < end) {
    if (pos + 2 > end) throw new RangeError(`a tag header at ${pos} runs past the end (${end})`);
    const cl = b[pos] | (b[pos + 1] << 8);
    const code = cl >> 6;
    let len = cl & 0x3f;
    let h = 2;
    const long = len === 0x3f;
    if (long) {
      if (pos + 6 > end) throw new RangeError(`the long tag header at ${pos} runs past the end (${end})`);
      len = (b[pos + 2] | (b[pos + 3] << 8) | (b[pos + 4] << 16) | (b[pos + 5] << 24)) >>> 0;
      h = 6;
    }
    if (pos + h + len > end) throw new RangeError(`${tagName(code)} at ${pos} says it is ${len} bytes long, past the end (${end})`);
    const body = b.subarray(pos + h, pos + h + len);
    const tag = { code, long, body };
    if (code === 39) {
      // A sprite whose own tags don't parse stays one block of bytes.
      try {
        if (len < 4) throw new RangeError('too short');
        const inner = parseTags(body, 4, len, true);
        tag.sprite = { id: body[0] | (body[1] << 8), frameCount: body[2] | (body[3] << 8), tags: inner.tags, tail: body.subarray(inner.end) };
        tag.body = null;
      } catch {
        /* raw */
      }
    }
    tags.push(tag);
    pos += h + len;
    if (code === 0) break;
  }
  if (!nested && tags.at(-1)?.code !== 0) throw new RangeError('the movie has no End tag');
  return { tags, end: pos };
}

/**
 * Reads a movie: {signature, version, rect, frameRate (8.8 fixed, 256 = 1 fps), frameCount, tags, trailing, source}.
 * `source` keeps the input and its uncompressed bytes, so an unchanged movie can be handed back as it came.
 */
export async function parseMovie(u8) {
  if (!u8 || u8.length < 8) throw new Error('A movie needs at least 8 bytes of header.');
  const signature = String.fromCharCode(u8[0], u8[1], u8[2]);
  if (!SIG_SET.has(signature)) throw new Error(`Not a Scaleform movie or SWF (starts with ${JSON.stringify(signature)}).`);
  let swf;
  try {
    swf = await decompressMovie(u8);
  } catch (e) {
    throw new Error(`The zlib body could not be decompressed: ${e.message}`);
  }
  if (!swf) throw new Error('The movie is too short to hold a header.');
  const r = new Reader(swf, 8);
  const rect = readRect(r);
  const frameRate = r.u16();
  const frameCount = r.u16();
  const headerEnd = r.p;
  const { tags, end } = parseTags(swf, headerEnd, swf.length, false);
  const movie = {
    signature,
    version: u8[3],
    declaredLength: (u8[4] | (u8[5] << 8) | (u8[6] << 16) | (u8[7] << 24)) >>> 0,
    rect,
    frameRate,
    frameCount,
    tags,
    trailing: swf.subarray(end),
  };
  movie.source = { bytes: u8, body: swf, header: swf.subarray(8, headerEnd), rect: { ...rect }, frameRate, frameCount };
  return movie;
}

/** A tag's body bytes (a sprite's are written from its tag list). */
export function tagBody(tag) {
  if (!tag.sprite) return tag.body;
  const w = new Writer(1024);
  w.u16(tag.sprite.id);
  w.u16(tag.sprite.frameCount);
  writeTags(w, tag.sprite.tags);
  w.bytes(tag.sprite.tail);
  return w.result();
}

/** True when this tag must use the long header: it was long, or its body is 63 bytes or more. */
export const needsLong = (tag, len) => tag.long || len >= 0x3f;

function writeTags(w, tags) {
  for (const t of tags) {
    if (!Number.isInteger(t.code) || t.code < 0 || t.code > 1023) throw new RangeError(`tag code ${t.code} is not 0 to 1023`);
    const body = tagBody(t);
    if (needsLong(t, body.length)) {
      w.u16((t.code << 6) | 0x3f);
      w.u32(body.length);
    } else w.u16((t.code << 6) | body.length);
    w.bytes(body);
  }
}

const sameRect = (a, b) => a.nbits === b.nbits && a.xMin === b.xMin && a.xMax === b.xMax && a.yMin === b.yMin && a.yMax === b.yMax;

/** The movie as uncompressed bytes (8-byte header with the signature, version and the real length, then the rest). */
export function writeMovieBody(movie) {
  const w = new Writer(Math.max(1024, movie.source?.body?.length ?? 0) + 64);
  const sig = movie.signature;
  if (!SIG_SET.has(sig)) throw new RangeError(`${sig} is not CFX, GFX, CWS or FWS`);
  for (let i = 0; i < 3; i++) w.u8(sig.charCodeAt(i));
  w.u8(movie.version);
  w.u32(0);
  const s = movie.source;
  if (s && sameRect(movie.rect, s.rect) && movie.frameRate === s.frameRate && movie.frameCount === s.frameCount) w.bytes(s.header);
  else {
    writeRect(w, movie.rect);
    w.u16(movie.frameRate);
    w.u16(movie.frameCount);
  }
  writeTags(w, movie.tags);
  w.bytes(movie.trailing);
  const out = w.result();
  new DataView(out.buffer).setUint32(4, out.length, true);
  return out;
}

async function zlib(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The movie's file bytes: CFX / CWS zlib-compress everything after the 8-byte header, GFX / FWS are stored as is.
 * When the uncompressed bytes equal the input's (whatever the first three letters), the input comes back with only the
 * signature changed, as the desktop's SGFX ↔ SWF conversion writes it.
 */
export async function encodeMovie(movie) {
  const body = writeMovieBody(movie);
  const s = movie.source;
  if (s && s.bytes[0] === body[0] && bytesEqual(body.subarray(3), s.body.subarray(3))) {
    if (body[0] === s.bytes[0] && body[1] === s.bytes[1] && body[2] === s.bytes[2]) return s.bytes;
    const out = s.bytes.slice();
    out.set(body.subarray(0, 3));
    return out;
  }
  if (!isCompressedSig(movie.signature)) return body;
  const z = await zlib(body.subarray(8));
  const out = new Uint8Array(8 + z.length);
  out.set(body.subarray(0, 8));
  out.set(z, 8);
  return out;
}

/** The ShowFrame tags in a tag list. */
export const showFrames = (tags) => tags.reduce((n, t) => n + (t.code === 1 ? 1 : 0), 0);

/** Calls fn(tag, list, index, owner) for every tag, sprites' tags included (owner: the DefineSprite tag or null). */
export function walkTags(tags, fn, owner = null) {
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    if (fn(t, tags, i, owner) === false) return false;
    if (t.sprite && walkTags(t.sprite.tags, fn, t) === false) return false;
  }
  return true;
}

/** Where a tag sits: {list, index, owner} or null. */
export function locateTag(movie, tag) {
  let hit = null;
  walkTags(movie.tags, (t, list, index, owner) => {
    if (t !== tag) return true;
    hit = { list, index, owner };
    return false;
  });
  return hit;
}

/** A tag from its code and body bytes; a DefineSprite's bytes become its tag list when they parse. */
export function makeTag(code, body, long = false) {
  const tag = { code, long, body };
  if (code === 39 && body.length >= 4) {
    try {
      const inner = parseTags(body, 4, body.length, true);
      tag.sprite = { id: body[0] | (body[1] << 8), frameCount: body[2] | (body[3] << 8), tags: inner.tags, tail: body.subarray(inner.end) };
      tag.body = null;
    } catch {
      /* raw */
    }
  }
  return tag;
}

/** A copy of a tag (a sprite's tags are copied too; bodies are shared, they are never changed in place). */
export function cloneTag(t) {
  if (!t.sprite) return { code: t.code, long: t.long, body: t.body };
  return { code: t.code, long: t.long, body: null, sprite: { ...t.sprite, tags: t.sprite.tags.map(cloneTag) } };
}

// ---------- tag codecs ----------

const flag = (v, m) => (v & m) !== 0;
const bit = (on, m) => (on ? m : 0);

function readFill(r, v, morph) {
  const f = { type: r.u8() };
  const color = () => (v >= 3 || morph ? readRgba(r) : readRgb(r));
  if (f.type === 0x00) {
    f.color = color();
    if (morph) f.endColor = readRgba(r);
  } else if (f.type === 0x10 || f.type === 0x12 || f.type === 0x13) {
    f.matrix = readMatrix(r);
    if (morph) f.endMatrix = readMatrix(r);
    const g = (f.gradient = { spread: r.ub(2), interpolation: r.ub(2), records: [] });
    const count = r.ub(4);
    for (let i = 0; i < count; i++) {
      const rec = { ratio: r.u8(), color: color() };
      if (morph) Object.assign(rec, { endRatio: r.u8(), endColor: readRgba(r) });
      g.records.push(rec);
    }
    if (f.type === 0x13) {
      g.focal = r.s16();
      if (morph) g.endFocal = r.s16();
    }
  } else if (f.type >= 0x40 && f.type <= 0x43) {
    f.bitmapId = r.u16();
    f.matrix = readMatrix(r);
    if (morph) f.endMatrix = readMatrix(r);
  } else throw new RangeError(`unknown fill style type 0x${f.type.toString(16)}`);
  return f;
}
function writeFill(w, f, v, morph) {
  w.u8(f.type);
  const n = v >= 3 || morph ? 4 : 3;
  if (f.type === 0x00) {
    writeColor(w, f.color, n);
    if (morph) writeColor(w, f.endColor, 4);
  } else if (f.type === 0x10 || f.type === 0x12 || f.type === 0x13) {
    writeMatrix(w, f.matrix);
    if (morph) writeMatrix(w, f.endMatrix);
    const g = f.gradient;
    if (g.records.length > 15) throw new RangeError('a gradient holds at most 15 colours');
    w.ub(2, g.spread);
    w.ub(2, g.interpolation);
    w.ub(4, g.records.length);
    for (const rec of g.records) {
      w.u8(rec.ratio);
      writeColor(w, rec.color, n);
      if (morph) {
        w.u8(rec.endRatio);
        writeColor(w, rec.endColor, 4);
      }
    }
    if (f.type === 0x13) {
      w.s16(g.focal);
      if (morph) w.s16(g.endFocal);
    }
  } else if (f.type >= 0x40 && f.type <= 0x43) {
    w.u16(f.bitmapId);
    writeMatrix(w, f.matrix);
    if (morph) writeMatrix(w, f.endMatrix);
  } else throw new RangeError(`unknown fill style type 0x${f.type.toString(16)}`);
}

function readCount(r, v) {
  let n = r.u8();
  let ext = false;
  if (n === 0xff && v >= 2) {
    n = r.u16();
    ext = true;
  }
  return { n, ext };
}
function writeCount(w, n, ext, v) {
  if (v >= 2 && (ext || n >= 0xff)) {
    w.u8(0xff);
    w.u16(n);
  } else {
    if (n > 0xff) throw new RangeError('DefineShape holds at most 255 styles of a kind');
    w.u8(n);
  }
}

/** Styles of a shape (v 1-4) or a morph shape (morph v 1-2). */
function readStyles(r, v, morph) {
  const fc = readCount(r, morph ? 2 : v);
  const fills = [];
  for (let i = 0; i < fc.n; i++) fills.push(readFill(r, v, morph));
  const lc = readCount(r, morph ? 2 : v);
  const lines = [];
  for (let i = 0; i < lc.n; i++) {
    const l = { width: r.u16() };
    if (morph) l.endWidth = r.u16();
    const style2 = morph ? v >= 2 : v >= 4;
    if (style2) {
      l.startCap = r.ub(2);
      l.join = r.ub(2);
      const hasFill = r.ub(1);
      l.noHScale = r.ub(1);
      l.noVScale = r.ub(1);
      l.pixelHinting = r.ub(1);
      l.reserved = r.ub(5);
      l.noClose = r.ub(1);
      l.endCap = r.ub(2);
      if (l.join === 2) l.miter = r.u16();
      if (hasFill) l.fill = readFill(r, 4, morph);
      else {
        l.color = readRgba(r);
        if (morph) l.endColor = readRgba(r);
      }
    } else {
      l.color = v >= 3 || morph ? readRgba(r) : readRgb(r);
      if (morph) l.endColor = readRgba(r);
    }
    lines.push(l);
  }
  return { fills, lines, fillsExt: fc.ext, linesExt: lc.ext };
}
function writeStyles(w, s, v, morph) {
  writeCount(w, s.fills.length, s.fillsExt, morph ? 2 : v);
  for (const f of s.fills) writeFill(w, f, v, morph);
  writeCount(w, s.lines.length, s.linesExt, morph ? 2 : v);
  for (const l of s.lines) {
    w.u16(l.width);
    if (morph) w.u16(l.endWidth);
    const style2 = morph ? v >= 2 : v >= 4;
    if (style2) {
      w.ub(2, l.startCap);
      w.ub(2, l.join);
      w.ub(1, l.fill ? 1 : 0);
      w.ub(1, l.noHScale);
      w.ub(1, l.noVScale);
      w.ub(1, l.pixelHinting);
      w.ub(5, l.reserved);
      w.ub(1, l.noClose);
      w.ub(2, l.endCap);
      if (l.join === 2) w.u16(l.miter ?? 0);
      if (l.fill) writeFill(w, l.fill, 4, morph);
      else {
        writeColor(w, l.color, 4);
        if (morph) writeColor(w, l.endColor, 4);
      }
    } else {
      writeColor(w, l.color, v >= 3 || morph ? 4 : 3);
      if (morph) writeColor(w, l.endColor, 4);
    }
  }
}

const SHAPE_V = { 2: 1, 22: 2, 32: 3, 83: 4 };
const shapeCodec = {
  decode(r, code) {
    const v = SHAPE_V[code];
    const f = { id: r.u16(), bounds: readRect(r) };
    if (v === 4) {
      f.edgeBounds = readRect(r);
      f.flags = r.u8(); // reserved 5 bits, fill winding rule, non-scaling strokes, scaling strokes
    }
    Object.assign(f, readStyles(r, v, false));
    f.records = r.rest(); // NumFillBits / NumLineBits and the shape records, as they are
    return f;
  },
  encode(w, f, code) {
    const v = SHAPE_V[code];
    w.u16(f.id);
    writeRect(w, f.bounds);
    if (v === 4) {
      writeRect(w, f.edgeBounds);
      w.u8(f.flags);
    }
    writeStyles(w, f, v, false);
    w.bytes(f.records);
  },
};

const morphCodec = {
  decode(r, code) {
    const v = code === 84 ? 2 : 1;
    const f = { id: r.u16(), startBounds: readRect(r), endBounds: readRect(r) };
    if (v === 2) {
      f.startEdgeBounds = readRect(r);
      f.endEdgeBounds = readRect(r);
      f.flags = r.u8();
    }
    const offset = r.u32();
    const at = r.p;
    Object.assign(f, readStyles(r, v, true));
    if (at + offset < r.p || at + offset > r.b.length) throw new RangeError('the end-edges offset points inside the styles');
    f.startEdges = r.b.subarray(r.p, at + offset);
    f.endEdges = r.b.subarray(at + offset);
    r.p = r.b.length;
    return f;
  },
  encode(w, f, code) {
    const v = code === 84 ? 2 : 1;
    w.u16(f.id);
    writeRect(w, f.startBounds);
    writeRect(w, f.endBounds);
    if (v === 2) {
      writeRect(w, f.startEdgeBounds);
      writeRect(w, f.endEdgeBounds);
      w.u8(f.flags);
    }
    const s = new Writer();
    writeStyles(s, f, v, true);
    const styles = s.result();
    w.u32(styles.length + f.startEdges.length);
    w.bytes(styles);
    w.bytes(f.startEdges);
    w.bytes(f.endEdges);
  },
};

const EDIT_FLAGS = ['wordWrap', 'multiline', 'password', 'readOnly', 'autoSize', 'noSelect', 'border', 'wasStatic', 'html', 'useOutlines'];
const editTextCodec = {
  decode(r) {
    const f = { id: r.u16(), bounds: readRect(r) };
    const a = r.u8(), b = r.u8();
    Object.assign(f, {
      wordWrap: flag(a, 0x40), multiline: flag(a, 0x20), password: flag(a, 0x10), readOnly: flag(a, 0x08),
      autoSize: flag(b, 0x40), noSelect: flag(b, 0x10), border: flag(b, 0x08), wasStatic: flag(b, 0x04), html: flag(b, 0x02), useOutlines: flag(b, 0x01),
    });
    f.fontId = flag(a, 0x01) ? r.u16() : null;
    f.fontClass = flag(b, 0x80) ? r.cstr() : null;
    f.fontHeight = f.fontId != null || f.fontClass != null ? r.u16() : null;
    f.color = flag(a, 0x04) ? readRgba(r) : null;
    f.maxLength = flag(a, 0x02) ? r.u16() : null;
    f.layout = flag(b, 0x20) ? { align: r.u8(), leftMargin: r.u16(), rightMargin: r.u16(), indent: r.u16(), leading: r.s16() } : null;
    f.variableName = r.cstr();
    f.text = flag(a, 0x80) ? r.cstr() : null;
    return f;
  },
  encode(w, f) {
    w.u16(f.id);
    writeRect(w, f.bounds);
    const hasFont = f.fontId != null, hasClass = f.fontClass != null;
    w.u8(bit(f.text != null, 0x80) | bit(f.wordWrap, 0x40) | bit(f.multiline, 0x20) | bit(f.password, 0x10) | bit(f.readOnly, 0x08) | bit(f.color != null, 0x04) | bit(f.maxLength != null, 0x02) | bit(hasFont, 0x01));
    w.u8(bit(hasClass, 0x80) | bit(f.autoSize, 0x40) | bit(f.layout != null, 0x20) | bit(f.noSelect, 0x10) | bit(f.border, 0x08) | bit(f.wasStatic, 0x04) | bit(f.html, 0x02) | bit(f.useOutlines, 0x01));
    if (hasFont) w.u16(f.fontId);
    if (hasClass) w.cstr(f.fontClass);
    if (hasFont || hasClass) w.u16(f.fontHeight ?? 240);
    if (f.color != null) writeColor(w, f.color, 4);
    if (f.maxLength != null) w.u16(f.maxLength);
    if (f.layout) {
      w.u8(f.layout.align);
      w.u16(f.layout.leftMargin);
      w.u16(f.layout.rightMargin);
      w.u16(f.layout.indent);
      w.s16(f.layout.leading);
    }
    w.cstr(f.variableName);
    if (f.text != null) w.cstr(f.text);
  },
};

/** PlaceObject2 (26) and PlaceObject3 (70). Absent fields are null; clip actions stay bytes. */
const placeCodec = {
  decode(r, code) {
    const a = r.u8();
    const b = code === 70 ? r.u8() : 0;
    const f = { move: flag(a, 0x01), depth: r.u16() };
    if (code === 70) Object.assign(f, { reserved: flag(b, 0x80), hasImage: flag(b, 0x10) });
    f.className = code === 70 && (flag(b, 0x08) || (flag(b, 0x10) && flag(a, 0x02))) ? r.cstr() : null;
    f.characterId = flag(a, 0x02) ? r.u16() : null;
    f.matrix = flag(a, 0x04) ? readMatrix(r) : null;
    f.cxform = flag(a, 0x08) ? readCxform(r, true) : null;
    f.ratio = flag(a, 0x10) ? r.u16() : null;
    f.name = flag(a, 0x20) ? r.cstr() : null;
    f.clipDepth = flag(a, 0x40) ? r.u16() : null;
    if (code === 70) {
      f.filters = flag(b, 0x01) ? readFilterList(r) : null;
      f.blendMode = flag(b, 0x02) ? r.u8() : null;
      f.bitmapCache = flag(b, 0x04) ? r.u8() : null;
      f.visible = flag(b, 0x20) ? r.u8() : null;
      f.background = flag(b, 0x40) ? readRgba(r) : null;
    }
    f.clipActions = flag(a, 0x80) ? r.rest() : null;
    return f;
  },
  encode(w, f, code) {
    w.u8(bit(f.clipActions != null, 0x80) | bit(f.clipDepth != null, 0x40) | bit(f.name != null, 0x20) | bit(f.ratio != null, 0x10) | bit(f.cxform != null, 0x08) | bit(f.matrix != null, 0x04) | bit(f.characterId != null, 0x02) | bit(f.move, 0x01));
    if (code === 70) {
      const hasClass = f.className != null && !(f.hasImage && f.characterId != null);
      w.u8(bit(f.reserved, 0x80) | bit(f.background != null, 0x40) | bit(f.visible != null, 0x20) | bit(f.hasImage, 0x10) | bit(hasClass, 0x08) | bit(f.bitmapCache != null, 0x04) | bit(f.blendMode != null, 0x02) | bit(f.filters != null, 0x01));
    } else if (f.className != null || f.filters || f.blendMode != null || f.bitmapCache != null || f.visible != null || f.background) {
      throw new RangeError('class names, filters, blend modes, bitmap caching, visibility and backgrounds need PlaceObject3');
    }
    w.u16(f.depth);
    if (code === 70 && (f.className != null || (f.hasImage && f.characterId != null))) w.cstr(f.className ?? '');
    if (f.characterId != null) w.u16(f.characterId);
    if (f.matrix) writeMatrix(w, f.matrix);
    if (f.cxform) writeCxform(w, f.cxform, true);
    if (f.ratio != null) w.u16(f.ratio);
    if (f.name != null) w.cstr(f.name);
    if (f.clipDepth != null) w.u16(f.clipDepth);
    if (code === 70) {
      if (f.filters) w.bytes(f.filters.bytes);
      if (f.blendMode != null) w.u8(f.blendMode);
      if (f.bitmapCache != null) w.u8(f.bitmapCache);
      if (f.visible != null) w.u8(f.visible);
      if (f.background) writeColor(w, f.background, 4);
    }
    if (f.clipActions) w.bytes(f.clipActions);
  },
};

const assetsCodec = {
  decode(r, code) {
    const f = {};
    if (code !== 56) f.url = r.cstr();
    if (code === 71) f.reserved = [r.u8(), r.u8()];
    const n = r.u16();
    f.symbols = [];
    for (let i = 0; i < n; i++) f.symbols.push({ id: r.u16(), name: r.cstr() });
    return f;
  },
  encode(w, f, code) {
    if (code !== 56) w.cstr(f.url);
    if (code === 71) {
      w.u8(f.reserved?.[0] ?? 1);
      w.u8(f.reserved?.[1] ?? 0);
    }
    w.u16(f.symbols.length);
    for (const s of f.symbols) {
      w.u16(s.id);
      w.cstr(s.name);
    }
  },
};

const fontCodec = {
  decode(r) {
    const f = { id: r.u16(), flags: r.u8(), language: r.u8() };
    f.name = utf8Dec.decode(r.bytes(r.u8()));
    f.glyphs = r.rest(); // NumGlyphs onwards, as it is
    return f;
  },
  encode(w, f) {
    w.u16(f.id);
    w.u8(f.flags);
    w.u8(f.language);
    const name = utf8Enc.encode(f.name);
    if (name.length > 255) throw new RangeError('a font name is at most 255 bytes');
    w.u8(name.length);
    w.bytes(name);
    w.bytes(f.glyphs);
  },
};

/** DefineFont2 / 3's glyph table: the glyph count, the characters, and where the ascent / descent / leading sit. */
export function fontLayout(f) {
  const g = f.glyphs;
  if (g.length < 2) return null;
  const n = g[0] | (g[1] << 8);
  const wideOffsets = flag(f.flags, 0x08), wideCodes = flag(f.flags, 0x04), hasLayout = flag(f.flags, 0x80);
  const out = { glyphCount: n, chars: '', layoutAt: -1 };
  if (!n) return out;
  const ow = wideOffsets ? 4 : 2;
  const tableAt = 2;
  const rd = (p, w) => (w === 4 ? (g[p] | (g[p + 1] << 8) | (g[p + 2] << 16) | (g[p + 3] << 24)) >>> 0 : g[p] | (g[p + 1] << 8));
  if (tableAt + ow * (n + 1) > g.length) return out;
  const codeAt = tableAt + rd(tableAt + ow * n, ow);
  const cw = wideCodes ? 2 : 1;
  if (codeAt + cw * n > g.length) return out;
  const codes = [];
  for (let i = 0; i < n; i++) codes.push(cw === 2 ? g[codeAt + 2 * i] | (g[codeAt + 2 * i + 1] << 8) : g[codeAt + i]);
  out.chars = String.fromCharCode(...codes.slice(0, 4096));
  if (hasLayout && codeAt + cw * n + 6 <= g.length) {
    out.layoutAt = codeAt + cw * n;
    const s = (p) => ((g[p] | (g[p + 1] << 8)) << 16) >> 16;
    Object.assign(out, { ascent: s(out.layoutAt), descent: s(out.layoutAt + 2), leading: s(out.layoutAt + 4) });
  }
  return out;
}

const buttonCodec = {
  decode(r) {
    const f = { id: r.u16(), flags: r.u8() };
    const offsetAt = r.p;
    const actionOffset = r.u16();
    f.records = [];
    for (;;) {
      const b = r.u8();
      if (b === 0) break;
      const rec = { flags: b & 0xcf, characterId: r.u16(), depth: r.u16(), matrix: readMatrix(r), cxform: readCxform(r, true) };
      rec.filters = flag(b, 0x10) ? readFilterList(r) : null;
      rec.blendMode = flag(b, 0x20) ? r.u8() : null;
      f.records.push(rec);
    }
    if (actionOffset && offsetAt + actionOffset !== r.p) throw new RangeError('the action offset doesn’t point after the button records');
    f.actions = r.rest();
    return f;
  },
  encode(w, f) {
    w.u16(f.id);
    w.u8(f.flags);
    const recs = new Writer();
    for (const rec of f.records) {
      recs.u8((rec.flags & 0xcf) | bit(rec.filters != null, 0x10) | bit(rec.blendMode != null, 0x20));
      recs.u16(rec.characterId);
      recs.u16(rec.depth);
      writeMatrix(recs, rec.matrix);
      writeCxform(recs, rec.cxform, true);
      if (rec.filters) recs.bytes(rec.filters.bytes);
      if (rec.blendMode != null) recs.u8(rec.blendMode);
    }
    recs.u8(0);
    const rb = recs.result();
    w.u16(f.actions.length ? 2 + rb.length : 0);
    w.bytes(rb);
    w.bytes(f.actions);
  },
};

const simple = (decode, encode) => ({ decode, encode });
const empty = simple(() => ({}), () => {});

/** The decoder and encoder of each tag code: decode(reader, code) → fields, encode(writer, fields, code). */
export const CODECS = {
  0: empty,
  1: empty,
  2: shapeCodec,
  22: shapeCodec,
  32: shapeCodec,
  83: shapeCodec,
  46: morphCodec,
  84: morphCodec,
  4: simple(
    (r) => {
      const f = { characterId: r.u16(), depth: r.u16(), matrix: readMatrix(r) };
      f.cxform = r.left > 0 ? readCxform(r, false) : null;
      return f;
    },
    (w, f) => {
      w.u16(f.characterId);
      w.u16(f.depth);
      writeMatrix(w, f.matrix);
      if (f.cxform) writeCxform(w, f.cxform, false);
    },
  ),
  5: simple((r) => ({ characterId: r.u16(), depth: r.u16() }), (w, f) => (w.u16(f.characterId), w.u16(f.depth))),
  9: simple((r) => ({ color: readRgb(r) }), (w, f) => writeColor(w, f.color, 3)),
  12: simple((r) => ({ actions: r.rest() }), (w, f) => w.bytes(f.actions)),
  26: placeCodec,
  70: placeCodec,
  28: simple((r) => ({ depth: r.u16() }), (w, f) => w.u16(f.depth)),
  34: buttonCodec,
  37: editTextCodec,
  43: simple(
    (r) => ({ name: r.cstr(), anchor: r.left ? r.u8() : null }),
    (w, f) => {
      w.cstr(f.name);
      if (f.anchor != null) w.u8(f.anchor);
    },
  ),
  48: fontCodec,
  75: fontCodec,
  56: assetsCodec,
  57: assetsCodec,
  71: assetsCodec,
  59: simple((r) => ({ spriteId: r.u16(), actions: r.rest() }), (w, f) => (w.u16(f.spriteId), w.bytes(f.actions))),
  69: simple(
    (r) => ({ flags: r.u8(), reserved: r.bytes(3) }),
    (w, f) => {
      w.u8(f.flags);
      w.bytes(f.reserved);
    },
  ),
  74: simple(
    (r) => ({ textId: r.u16(), useFlashType: r.ub(2), gridFit: r.ub(3), reservedBits: r.ub(3), thickness: r.f32(), sharpness: r.f32(), reserved: r.u8() }),
    (w, f) => {
      w.u16(f.textId);
      w.ub(2, f.useFlashType);
      w.ub(3, f.gridFit);
      w.ub(3, f.reservedBits);
      w.f32(f.thickness);
      w.f32(f.sharpness);
      w.u8(f.reserved);
    },
  ),
  76: simple(
    (r) => {
      const n = r.u16();
      const symbols = [];
      for (let i = 0; i < n; i++) symbols.push({ id: r.u16(), name: r.cstr() });
      return { symbols };
    },
    (w, f) => {
      w.u16(f.symbols.length);
      for (const s of f.symbols) (w.u16(s.id), w.cstr(s.name));
    },
  ),
  77: simple((r) => ({ xml: r.cstr() }), (w, f) => w.cstr(f.xml)),
  78: simple((r) => ({ characterId: r.u16(), splitter: readRect(r) }), (w, f) => (w.u16(f.characterId), writeRect(w, f.splitter))),
  88: simple((r) => ({ fontId: r.u16(), name: r.cstr(), copyright: r.cstr() }), (w, f) => (w.u16(f.fontId), w.cstr(f.name), w.cstr(f.copyright))),
  1000: simple(
    (r) => {
      const f = { version: r.u16() };
      f.flags = f.version >= 0x10a ? r.u32() : null;
      Object.assign(f, { bitmapFormat: r.u16(), prefix: r.pstr(), swfName: r.pstr() });
      // Then (when present) a u16 count and that many u32 code offsets, as FFDec reads them.
      f.codeOffsets = r.left >= 2 ? Array.from({ length: r.u16() }, () => r.u32()) : null;
      return f;
    },
    (w, f) => {
      w.u16(f.version);
      if (f.version >= 0x10a) w.u32(f.flags ?? 0);
      w.u16(f.bitmapFormat);
      w.pstr(f.prefix);
      w.pstr(f.swfName);
      if (f.codeOffsets) {
        w.u16(f.codeOffsets.length);
        for (const v of f.codeOffsets) w.u32(v);
      }
    },
  ),
  1001: simple(
    (r) => ({ id: r.u16(), format: r.u16(), width: r.u16(), height: r.u16(), file: r.pstr() }),
    (w, f) => (w.u16(f.id), w.u16(f.format), w.u16(f.width), w.u16(f.height), w.pstr(f.file)),
  ),
  1008: simple(
    (r) => ({ id: r.u16(), imageId: r.u16(), x1: r.u16(), y1: r.u16(), x2: r.u16(), y2: r.u16() }),
    (w, f) => {
      for (const k of ['id', 'imageId', 'x1', 'y1', 'x2', 'y2']) w.u16(f[k]);
    },
  ),
  1009: simple(
    (r) => ({ id: r.u16(), idType: r.u16(), format: r.u16(), width: r.u16(), height: r.u16(), exportName: r.pstr(), file: r.pstr() }),
    (w, f) => {
      for (const k of ['id', 'idType', 'format', 'width', 'height']) w.u16(f[k]);
      w.pstr(f.exportName);
      w.pstr(f.file);
    },
  ),
};

/** Fields → body bytes for a tag code (throws a RangeError naming the field that doesn't fit). */
export function encodeFields(code, f) {
  const c = CODECS[code];
  if (!c) throw new Error(`${tagName(code)} has no field editor`);
  const w = new Writer();
  c.encode(w, f, code);
  if (f.extra) w.bytes(f.extra);
  return w.result();
}

const decoded = new WeakMap(); // body → {fields} | {error}

/**
 * A tag's fields: {fields} when its bytes decode and encode back to the same bytes, else {error} (the editor shows its
 * bytes only). Bytes after the fields a tag type knows are kept in `fields.extra`. Results are cached by body.
 */
export function decodeTag(tag) {
  if (tag.sprite) return { fields: { id: tag.sprite.id, frameCount: tag.sprite.frameCount } };
  const body = tag.body;
  const hit = decoded.get(body);
  if (hit && hit.code === tag.code) return hit.result;
  let result;
  const c = CODECS[tag.code];
  if (!c) result = { error: tag.code === 39 ? 'The sprite’s own tags don’t parse.' : null };
  else {
    try {
      const r = new Reader(body);
      const fields = c.decode(r, tag.code);
      if (r.left > 0) fields.extra = r.rest();
      const back = encodeFields(tag.code, fields);
      result = bytesEqual(back, body) ? { fields } : { error: `Its fields don’t encode back to the same ${body.length} bytes (they give ${back.length}), so it is kept as bytes.` };
    } catch (e) {
      result = { error: `Its bytes don’t decode (${e.message}), so it is kept as bytes.` };
    }
  }
  decoded.set(body, { code: tag.code, result });
  return result;
}

// ---------- character ids ----------

/** Codes whose first two bytes are the character id they define. */
export const DEFINES = new Set([2, 6, 7, 10, 11, 14, 20, 21, 22, 32, 33, 34, 35, 36, 37, 38, 39, 46, 48, 60, 75, 83, 84, 87, 90, 91, 1001, 1003, 1005, 1006, 1008, 1009]);

/** The character id a tag defines, or null. */
export function definedId(tag) {
  if (tag.sprite) return tag.sprite.id;
  if (!DEFINES.has(tag.code) || !tag.body || tag.body.length < 2) return null;
  return tag.body[0] | (tag.body[1] << 8);
}

/** Gives a defining tag another character id (returns the new tag; the bytes are copied). */
export function withDefinedId(tag, id) {
  if (tag.sprite) return { ...cloneTag(tag), sprite: { ...cloneTag(tag).sprite, id } };
  const body = tag.body.slice();
  body[0] = id & 0xff;
  body[1] = id >> 8;
  return { code: tag.code, long: tag.long, body };
}

/** The character ids a tag uses: [{id, how}]. */
export function referencedIds(tag) {
  const b = tag.body;
  const out = [];
  try {
    switch (tag.code) {
      case 26:
        if (b[0] & 0x02) out.push({ id: b[3] | (b[4] << 8), how: 'places' });
        break;
      case 70: {
        if (!(b[0] & 0x02)) break;
        const f = decodeTag(tag).fields;
        if (f?.characterId != null) out.push({ id: f.characterId, how: 'places' });
        break;
      }
      case 4:
      case 5:
        out.push({ id: b[0] | (b[1] << 8), how: tag.code === 4 ? 'places' : 'removes' });
        break;
      case 56:
      case 76: {
        const f = decodeTag(tag).fields;
        for (const s of f?.symbols ?? []) out.push({ id: s.id, how: `${tag.code === 56 ? 'exports' : 'names'} it as “${s.name}”` });
        break;
      }
      case 59:
        out.push({ id: b[0] | (b[1] << 8), how: 'runs init actions for it' });
        break;
      case 74:
      case 78:
        out.push({ id: b[0] | (b[1] << 8), how: tag.code === 74 ? 'sets its text rendering' : 'gives it a 9-slice grid' });
        break;
      case 13:
      case 62:
      case 73:
      case 88:
        out.push({ id: b[0] | (b[1] << 8), how: 'describes the font' });
        break;
      case 37: {
        const f = decodeTag(tag).fields;
        if (f?.fontId != null) out.push({ id: f.fontId, how: 'uses the font' });
        break;
      }
      case 1008:
        out.push({ id: b[2] | (b[3] << 8), how: 'cuts a sub-image from it' });
        break;
      case 2:
      case 22:
      case 32:
      case 83:
      case 46:
      case 84: {
        const f = decodeTag(tag).fields;
        for (const s of [...(f?.fills ?? []), ...(f?.lines ?? []).map((l) => l.fill).filter(Boolean)]) if (s.bitmapId != null && s.bitmapId !== 0xffff) out.push({ id: s.bitmapId, how: 'fills with the bitmap' });
        break;
      }
      case 34: {
        const f = decodeTag(tag).fields;
        for (const rec of f?.records ?? []) out.push({ id: rec.characterId, how: 'shows it in a button state' });
        break;
      }
    }
  } catch {
    /* a short tag uses nothing we can read */
  }
  return out;
}

/** Every tag that uses character `id` (sprites' tags included), except `skip`: [{tag, owner, how}]. */
export function usesOf(movie, id, skip = null) {
  const hits = [];
  walkTags(movie.tags, (t, list, i, owner) => {
    if (t === skip) return true;
    for (const ref of referencedIds(t)) if (ref.id === id) hits.push({ tag: t, owner, how: ref.how });
    return true;
  });
  return hits;
}

/** The ids the movie defines or imports. */
export function usedCharacterIds(movie) {
  const ids = new Set();
  walkTags(movie.tags, (t) => {
    const id = definedId(t);
    if (id != null) ids.add(id);
    if (t.code === 57 || t.code === 71) for (const s of decodeTag(t).fields?.symbols ?? []) ids.add(s.id);
  });
  return ids;
}

/** The lowest character id from 1 up that nothing in the movie defines or imports. */
export function freeCharacterId(movie) {
  const ids = usedCharacterIds(movie);
  let id = 1;
  while (ids.has(id)) id++;
  if (id > 0xffff) throw new RangeError('every character id is taken');
  return id;
}

/** Export names by character id (ExportAssets anywhere in the movie). */
export function exportNames(movie) {
  const names = new Map();
  walkTags(movie.tags, (t) => {
    if (t.code !== 56) return;
    for (const s of decodeTag(t).fields?.symbols ?? []) {
      if (!names.has(s.id)) names.set(s.id, []);
      names.get(s.id).push(s.name);
    }
  });
  return names;
}

// ---------- hex ----------

export const toHex = (u8, perLine = 16) => {
  const lines = [];
  for (let i = 0; i < u8.length; i += perLine) lines.push(Array.from(u8.subarray(i, i + perLine), (b) => b.toString(16).padStart(2, '0')).join(' '));
  return lines.join('\n');
};

/** Hex digits (spaces, new lines, commas and 0x prefixes ignored) → bytes; throws on anything else. */
export function fromHex(text) {
  const clean = String(text).replace(/0x/gi, '').replace(/[\s,]+/g, '');
  if (/[^0-9a-f]/i.test(clean)) throw new Error(`“${clean.match(/[^0-9a-f]/i)[0]}” is not a hex digit`);
  if (clean.length % 2) throw new Error('an odd number of hex digits');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/** A fresh, changeable copy of a tag's decoded fields (call after decodeTag gave fields). */
export function freshFields(tag) {
  if (tag.sprite) return { id: tag.sprite.id, frameCount: tag.sprite.frameCount };
  const r = new Reader(tag.body);
  const f = CODECS[tag.code].decode(r, tag.code);
  if (r.left > 0) f.extra = r.rest();
  return f;
}

// ---------- the app's model of an open movie ----------

/**
 * What the app keeps as an open movie's model. The movie is read in the background (`ready`); edits call changed(),
 * which writes the movie again a moment later (compressing a large movie takes a while), and flush() waits for that.
 * bytes() gives the current file bytes and throws while a write is due.
 */
export function openMovieDoc(bytes) {
  const doc = { original: bytes, movie: null, error: null, encoded: bytes, encodeError: null, due: false, running: null, timer: 0 };
  doc.ready = parseMovie(bytes).then(
    (m) => (doc.movie = m),
    (e) => (doc.error = e.message),
  );
  const write = () => {
    clearTimeout(doc.timer);
    doc.timer = 0;
    if (doc.running) return doc.running;
    doc.due = false;
    doc.running = encodeMovie(doc.movie)
      .then(
        (b) => ((doc.encoded = b), (doc.encodeError = null)),
        (e) => (doc.encodeError = e.message),
      )
      .finally(() => {
        doc.running = null;
        if (doc.due) doc.timer = setTimeout(write, 400);
      });
    return doc.running;
  };
  doc.changed = () => {
    doc.due = true;
    if (!doc.running) {
      clearTimeout(doc.timer);
      doc.timer = setTimeout(write, 400);
    }
  };
  doc.flush = async () => {
    await doc.ready;
    while (doc.due || doc.running) await (doc.running ?? write());
    if (doc.encodeError) throw new Error(doc.encodeError);
  };
  doc.bytes = () => {
    if (doc.due || doc.running) throw new Error('The movie is still being written; try again in a moment.');
    if (doc.encodeError) throw new Error(doc.encodeError);
    return doc.encoded;
  };
  return doc;
}
