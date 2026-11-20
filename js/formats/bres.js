// BRES: Happy Wars' resource-bundle archive (port of HappyTool/Formats/BRES.cs).
// A tree of 4-byte-aligned chunks: BRES > INFO + ASET; ASET holds "name"/"target" string properties and FILE
// entries (a "size" int property, a "name" string property, an optional "cmd" string property, then the content
// in an FB (inline) or FBP (pointer) chunk). Little-endian on Steam/Win32; big-endian on Xbox 360, where every
// tag is stored byte-reversed ("SERB"). BRES, ASET and FILE chunk lengths carry the high bit as a flag.
import { ByteWriter, utf8, decodeUtf8, ascii4 } from '../util.js';

const SIZE_FLAG = 0x80000000;
const INFO_MAGIC = 0x11223344;
const FLAGGED = new Set(['BRES', 'ASET', 'FILE']);
const KNOWN_TARGETS = ['xboxdg', 'castor']; // Happy Dungeons lang bundles; Win10/Xbox One toybox dictionaries

const tagValue = (tag) =>
  (tag.charCodeAt(0) | (tag.charCodeAt(1) << 8) | (tag.charCodeAt(2) << 16) | (tag.charCodeAt(3) << 24)) >>> 0;

export function isBres(u8) {
  const m = ascii4(u8);
  return m === 'BRES' || m === 'SERB';
}

class Reader {
  constructor(u8, le) {
    this.u8 = u8;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.le = le;
  }
  u32(off) {
    return this.dv.getUint32(off, this.le);
  }
  /** Read a chunk at `off` (must be `tag`); returns {start, size, next}. */
  chunk(off, end, tag) {
    if (off + 8 > end) throw new Error(`BRES: expected ${tag.trim()} chunk at 0x${off.toString(16)}, found end of data`);
    const got = this.u32(off);
    if (got !== tagValue(tag)) throw new Error(`BRES: invalid chunk header 0x${got.toString(16)} at 0x${off.toString(16)} (expected ${tag.trim()})`);
    let size = this.u32(off + 4);
    if (FLAGGED.has(tag)) size = (size - SIZE_FLAG) | 0;
    if (size < 0 || (size === 0 && tag !== 'FB  ') || size % 4 !== 0 || off + 8 + size > end)
      throw new Error(`BRES: invalid ${tag.trim()} chunk size ${size}`);
    return { start: off + 8, size, next: off + 8 + size };
  }
  peekIs(off, tag) {
    return off + 4 <= this.u8.length && this.u32(off) === tagValue(tag);
  }
  cstr(off, end) {
    let i = off;
    while (i < end && this.u8[i] !== 0) i++;
    if (i >= end || i === off) throw new Error('BRES: unterminated or empty string');
    return { value: decodeUtf8(this.u8.subarray(off, i)), next: i + 1 };
  }
  /** A property chunk ("PS  " or "PI  "): name\0 + value. Returns {valueStart, end, next}. */
  property(off, end, tag, name) {
    const c = this.chunk(off, end, tag);
    const n = this.cstr(c.start, c.start + c.size);
    if (n.value !== name) throw new Error(`BRES: invalid property name (${n.value}), expected (${name})`);
    return { valueStart: n.next, end: c.start + c.size, next: c.next };
  }
  stringProperty(off, end, name) {
    const p = this.property(off, end, 'PS  ', name);
    return { value: this.cstr(p.valueStart, p.end).value, next: p.next };
  }
  intProperty(off, end, name) {
    const p = this.property(off, end, 'PI  ', name);
    if (p.end - p.valueStart < 4) throw new Error('BRES: int property too short');
    return { value: this.u32(p.valueStart), next: p.next };
  }
}

/**
 * @typedef {{name: string, cmd: string|null, pointer: boolean, size: number, data: Uint8Array}} BresEntry
 * For a pointer (FBP) entry, `data` is the 4-byte stub and `size` the streamed size.
 * @typedef {{name: string, target: string, littleEndian: boolean, entries: BresEntry[]}} BresArchive
 */

/** @returns {BresArchive} */
export function parseBres(u8) {
  const magic = ascii4(u8);
  if (magic !== 'BRES' && magic !== 'SERB') throw new Error('Expected BRES header');
  const le = magic === 'BRES';
  const r = new Reader(u8, le);
  const top = r.chunk(0, u8.length, 'BRES');
  const end = top.next;

  const info = r.chunk(top.start, end, 'INFO');
  if (info.size !== 8) throw new Error(`BRES: invalid INFO chunk size ${info.size}`);
  if (r.u32(info.start) !== (le ? 0 : 1)) throw new Error('BRES: invalid INFO tag');
  if (r.u32(info.start + 4) !== INFO_MAGIC) throw new Error('BRES: invalid INFO magic');

  const aset = r.chunk(info.next, end, 'ASET');
  const asetEnd = aset.next;
  const name = r.stringProperty(aset.start, asetEnd, 'name');
  const target = r.stringProperty(name.next, asetEnd, 'target');
  const expected = le ? 'Win32' : 'Xbox360';
  if (target.value !== expected && !KNOWN_TARGETS.includes(target.value.toLowerCase()))
    throw new Error(`BRES: unknown ASET target ${target.value}`);

  const entries = [];
  let off = target.next;
  while (off < asetEnd) {
    const file = r.chunk(off, asetEnd, 'FILE');
    const fileEnd = file.next;
    const size = r.intProperty(file.start, fileEnd, 'size');
    const ename = r.stringProperty(size.next, fileEnd, 'name');
    let p = ename.next;
    let cmd = null;
    if (r.peekIs(p, 'PS  ')) {
      const c = r.stringProperty(p, fileEnd, 'cmd');
      cmd = c.value;
      p = c.next;
    }
    if (r.peekIs(p, 'FBP ')) {
      const fbp = r.chunk(p, fileEnd, 'FBP ');
      if (fbp.size !== 4) throw new Error(`BRES: invalid FBP size ${fbp.size}`);
      entries.push({ name: ename.value, cmd, pointer: true, size: size.value, data: u8.slice(fbp.start, fbp.start + 4) });
    } else {
      const fb = r.chunk(p, fileEnd, 'FB  ');
      if (fb.size < size.value) throw new Error(`BRES: FB block of ${ename.value} is ${fb.size} bytes, expected ${size.value}`);
      entries.push({ name: ename.value, cmd, pointer: false, size: size.value, data: u8.slice(fb.start, fb.start + size.value) });
    }
    off = fileEnd;
  }
  return { name: name.value, target: target.value, littleEndian: le, entries };
}

/** Serialise a BresArchive with the same layout HappyTool writes. */
export function writeBres(archive) {
  const le = archive.littleEndian;
  const w = new ByteWriter(64 * 1024);
  const open = (tag) => {
    w.u32(tagValue(tag), le); // written in file byte order, so a big-endian file gets the reversed tag ("SERB")
    w.u32(0, le);
    return { tag, at: w.pos };
  };
  const close = (c) => {
    const payload = w.pos - c.at;
    if (payload === 0 && c.tag !== 'FB  ') throw new Error('BRES: empty chunk');
    const pad = (4 - (payload % 4)) % 4;
    w.zeros(pad);
    let size = payload + pad;
    if (FLAGGED.has(c.tag)) size = (size + SIZE_FLAG) >>> 0;
    w.patchU32(c.at - 4, size, le);
  };
  const cstr = (s) => {
    w.bytes(utf8.encode(s));
    w.u8(0);
  };
  const strProp = (name, value) => {
    const c = open('PS  ');
    cstr(name);
    cstr(value);
    close(c);
  };
  const intProp = (name, value) => {
    const c = open('PI  ');
    cstr(name);
    w.u32(value, le);
    close(c);
  };

  const bres = open('BRES');
  const info = open('INFO');
  w.u32(le ? 0 : 1, le);
  w.u32(INFO_MAGIC, le);
  close(info);
  const aset = open('ASET');
  strProp('name', archive.name);
  strProp('target', archive.target || (le ? 'Win32' : 'Xbox360'));
  for (const e of archive.entries) {
    const file = open('FILE');
    intProp('size', e.pointer ? e.size : e.data.length);
    strProp('name', e.name);
    if (e.cmd) strProp('cmd', e.cmd);
    const body = open(e.pointer ? 'FBP ' : 'FB  ');
    w.bytes(e.pointer ? (e.data?.length === 4 ? e.data : new Uint8Array(4)) : e.data);
    close(body);
    close(file);
  }
  close(aset);
  close(bres);
  return w.result();
}
