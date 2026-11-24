// .rml: Xbox One material definition, a tree of "0MF" nodes (port of HappyTool/Formats/RmlDocument.cs).
// Every node is an 8-byte NUL-padded ASCII name, a little-endian uint32 total size (header included) and then either
// child nodes or a payload. 0SP / 0UIP / 0IP / 0FP / 0V3P / 0V4P / 0UI16P are always typed leaves; any other node
// whose payload splits cleanly into nodes with plausible names is a container, else a raw leaf. Bytes after the last
// root node are kept as they are.

import { netAsciiBytes, netAsciiString, netFloatTryParse, netFormatFloat, netIntTryParse, netTrim, netUIntTryParse, netUShortTryParse, setNetFloat } from './net-text.js';

const HEADER = 12;
const NAME = 8;
const LEAF_NAMES = new Set(['0SP', '0UIP', '0IP', '0FP', '0V3P', '0V4P', '0UI16P']);
const TYPE_BY_NAME = { '0SP': 'String', '0UIP': 'UInt32', '0IP': 'Int32', '0FP': 'Float', '0V3P': 'Vector3', '0V4P': 'Vector4', '0UI16P': 'UInt16' };

const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;

/** Root name begins with "0MF" and its declared size fits the buffer. */
export function looksLikeRml(d) {
  if (!d || d.length < HEADER) return false;
  if (d[0] !== 0x30 || d[1] !== 0x4d || d[2] !== 0x46) return false;
  const size = u32(d, NAME);
  return size >= HEADER && size <= d.length;
}

function decodeName(raw) {
  let len = 0;
  while (len < raw.length && raw[len] !== 0) len++;
  return netAsciiString(raw.subarray(0, len));
}

function looksLikeName(d, o) {
  const first = d[o];
  if (first < 0x21 || first > 0x7e) return false;
  let padding = false;
  for (let i = 0; i < NAME; i++) {
    const b = d[o + i];
    if (b === 0) {
      padding = true;
      continue;
    }
    if (padding) return false; // non-NUL after NUL padding: not a real name field
    if (b < 0x20 || b > 0x7e) return false;
  }
  return true;
}

function tryReadNode(d, offset) {
  if (offset < 0 || offset + HEADER > d.length) return null;
  const size = u32(d, offset + NAME);
  if (size < HEADER || offset + size > d.length) return null;
  const nameRaw = d.slice(offset, offset + NAME);
  const node = { name: decodeName(nameRaw), nameRaw, children: null, payload: null };
  const start = offset + HEADER;
  const len = size - HEADER;
  const children = LEAF_NAMES.has(node.name) ? null : tryParseChildren(d, start, len);
  if (children) node.children = children;
  else node.payload = d.slice(start, start + len);
  return node;
}

function tryParseChildren(d, start, length) {
  if (length < HEADER) return null;
  const list = [];
  let o = start;
  const end = start + length;
  while (o + HEADER <= end) {
    const size = u32(d, o + NAME);
    if (size < HEADER || o + size > end) return null;
    if (!looksLikeName(d, o)) return null;
    const child = tryReadNode(d, o);
    if (!child) return null;
    list.push(child);
    o += size;
  }
  if (o !== end || list.length === 0) return null;
  return list;
}

/** @returns {{roots: object[], trailing: Uint8Array}} */
export function parseRml(d) {
  const doc = { roots: [], trailing: new Uint8Array(0) };
  let offset = 0;
  while (offset + HEADER <= d.length) {
    const node = tryReadNode(d, offset);
    if (!node) break;
    doc.roots.push(node);
    offset += totalSize(node);
  }
  if (offset < d.length) doc.trailing = d.slice(offset);
  if (doc.roots.length === 0) throw new Error('Not a recognizable .rml (0MF) document.');
  return doc;
}

export const isContainer = (n) => n.children != null;

export function totalSize(n) {
  if (!isContainer(n)) return HEADER + (n.payload?.length ?? 0);
  let sum = HEADER;
  for (const c of n.children) sum += totalSize(c);
  return sum;
}

function writeNode(n, out, o) {
  out.set(n.nameRaw.subarray(0, NAME), o);
  const size = totalSize(n);
  out[o + 8] = size & 0xff;
  out[o + 9] = (size >>> 8) & 0xff;
  out[o + 10] = (size >>> 16) & 0xff;
  out[o + 11] = (size >>> 24) & 0xff;
  o += HEADER;
  if (isContainer(n)) for (const c of n.children) o = writeNode(c, out, o);
  else if (n.payload) {
    out.set(n.payload, o);
    o += n.payload.length;
  }
  return o;
}

export function serializeRml(doc) {
  let len = doc.trailing?.length ?? 0;
  for (const r of doc.roots) len += totalSize(r);
  const out = new Uint8Array(len);
  let o = 0;
  for (const r of doc.roots) o = writeNode(r, out, o);
  if (doc.trailing?.length) out.set(doc.trailing, o);
  return out;
}

/** Every node, depth first (RmlDocument.EnumerateAll). */
export function* enumerateRml(doc) {
  function* walk(n) {
    yield n;
    if (n.children) for (const c of n.children) yield* walk(c);
  }
  for (const r of doc.roots) yield* walk(r);
}

/** Container, String, UInt32, Int32, Float, Vector3, Vector4, UInt16 or Raw. */
export const valueType = (n) => (isContainer(n) ? 'Container' : TYPE_BY_NAME[n.name] ?? 'Raw');

export const isEditable = (n) => {
  const t = valueType(n);
  return t !== 'Container' && t !== 'Raw';
};

const view = (p) => new DataView(p.buffer, p.byteOffset, p.byteLength);

export function getString(n) {
  if (!n.payload) return '';
  let len = 0;
  while (len < n.payload.length && n.payload[len] !== 0) len++;
  return netAsciiString(n.payload.subarray(0, len));
}
const getUInt32 = (n) => (n.payload && n.payload.length >= 4 ? u32(n.payload, 0) : 0);
const getUInt16 = (n) => (n.payload && n.payload.length >= 2 ? n.payload[0] | (n.payload[1] << 8) : 0);
const getFloat = (n) => (n.payload && n.payload.length >= 4 ? view(n.payload).getFloat32(0, true) : 0);
function getFloats(n) {
  if (!n.payload) return [];
  const dv = view(n.payload);
  return Array.from({ length: Math.floor(n.payload.length / 4) }, (_, i) => dv.getFloat32(i * 4, true));
}

export function displayValue(n) {
  switch (valueType(n)) {
    case 'Container':
      return '';
    case 'String':
      return getString(n);
    case 'UInt32':
      return String(getUInt32(n));
    case 'Int32':
      return String(getUInt32(n) | 0);
    case 'UInt16':
      return String(getUInt16(n));
    case 'Float':
      return netFormatFloat(getFloat(n), '0.######');
    case 'Vector3':
    case 'Vector4':
      return getFloats(n).map((f) => netFormatFloat(f, '0.######')).join(', ');
    default:
      return n.payload == null ? '' : `(${n.payload.length} bytes)`;
  }
}

/** Container label: its name, plus " — <string>" when its first child is a non-empty 0SP. */
export function nodeLabel(n) {
  if (isContainer(n) && n.children.length > 0 && n.children[0].name === '0SP') {
    const s = getString(n.children[0]);
    if (s) return `${n.name} — ${s}`;
  }
  return n.name;
}

export const typeLabel = (n) => (isContainer(n) ? '' : valueType(n));

function setString(n, value) {
  if (!n.payload) return false;
  const ascii = netAsciiBytes(value ?? '');
  if (ascii.length > n.payload.length - 1) return false; // keep at least one NUL terminator inside the fixed buffer
  const buf = new Uint8Array(n.payload.length);
  buf.set(ascii);
  n.payload = buf;
  return true;
}
function setUInt32(n, v) {
  if (!n.payload || n.payload.length < 4) n.payload = new Uint8Array(4);
  view(n.payload).setUint32(0, v >>> 0, true);
}
function setUInt16(n, v) {
  if (!n.payload || n.payload.length < 2) n.payload = new Uint8Array(2);
  n.payload[0] = v & 0xff;
  n.payload[1] = (v >>> 8) & 0xff;
}
function setFloat(n, f) {
  if (!n.payload || n.payload.length < 4) n.payload = new Uint8Array(4);
  setNetFloat(view(n.payload), 0, f);
}

/** RmlNode.TrySetFromText: parse the text for the node's type and store it; false leaves the node unchanged. */
export function trySetFromText(n, text) {
  text ??= '';
  switch (valueType(n)) {
    case 'String':
      return setString(n, text);
    case 'UInt32': {
      const v = netUIntTryParse(text);
      if (v === null) return false;
      setUInt32(n, v);
      return true;
    }
    case 'Int32': {
      const v = netIntTryParse(text);
      if (v === null) return false;
      setUInt32(n, v);
      return true;
    }
    case 'UInt16': {
      const v = netUShortTryParse(text);
      if (v === null) return false;
      setUInt16(n, v);
      return true;
    }
    case 'Float': {
      const f = netFloatTryParse(text);
      if (f === null) return false;
      setFloat(n, f);
      return true;
    }
    case 'Vector3':
    case 'Vector4': {
      const parts = text.split(',').filter((p) => p !== '');
      const expected = Math.floor(n.payload.length / 4);
      if (parts.length !== expected) return false;
      const vals = [];
      for (const p of parts) {
        const f = netFloatTryParse(netTrim(p));
        if (f === null) return false;
        vals.push(f);
      }
      const dv = view(n.payload);
      vals.forEach((f, i) => setNetFloat(dv, i * 4, f));
      return true;
    }
    default:
      return false;
  }
}

/** The editor's "Value doesn't fit" text for a node whose new value was refused. */
export const invalidValueMessage = (n) =>
  `Value doesn't fit this field type (${valueType(n)}${valueType(n) === 'String' ? `, max ${(n.payload?.length ?? 1) - 1} chars` : ''}).`;

/** The summary line under the tree. */
export function rmlSummary(doc) {
  let nodes = 0;
  for (const _ of enumerateRml(doc)) nodes++;
  const root = doc.roots.length > 0 ? doc.roots[0].name : '?';
  return `Format: material definition (.rml)  •  root ${root}  •  ${nodes} nodes`;
}
