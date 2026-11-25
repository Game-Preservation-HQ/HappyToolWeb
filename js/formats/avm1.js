// AVM1 (ActionScript 1 and 2) bytecode of SWF movies up to version 10, as Scaleform movies carry it in DoAction,
// DoInitAction, PlaceObject2/3 clip actions and DefineButton/DefineButton2 actions:
//   disassemble(bytes) → p-code text in JPEXS FFDec's syntax (labels for branch targets, the constant pool's strings in
//   Push, nested function, With and Try bodies), assemble(text) → the bytes again (byte-equal for unedited text, labels
//   and body sizes recomputed after edits), decompile(bytes) → read-only ActionScript 2, and helpers that find and
//   replace the action blocks inside a tag's body. No DOM: it runs in node and the browser.
//
// Text the bytes need to come back exactly, beyond FFDec's syntax:
//   (string)"x"        a string pushed as itself although the constant pool holds it ("x" alone pushes the constant)
//   (constant16)"x"    a pool reference stored as constant16 with an index below 256 (constant8 otherwise)
//   constant12         a pool reference by number (an index past the pool, or a string the pool holds more than once)
//   (boolean)2         a boolean byte other than 0 or 1;  (double)0x… / (float)0x…  NaNs by their bits
//   Jump +12 / -7      a branch to a byte that is not the start of an action, as its signed offset
//   Unknown 0x9c 0a 0b an action kept as its code and payload bytes (unknown codes, or a payload this cannot read back)
//   .bytes 00 01       bytes after the block's End that are not actions;  .noend  the block does not end with End
// The End that closes a block is not shown (as in FFDec); assemble adds it back unless the text says .noend.

// ---------- action table ----------

export const ACTION_NAMES = {
  0x00: 'End', 0x04: 'NextFrame', 0x05: 'PrevFrame', 0x06: 'Play', 0x07: 'Stop', 0x08: 'ToggleQuality', 0x09: 'StopSounds',
  0x0a: 'Add', 0x0b: 'Subtract', 0x0c: 'Multiply', 0x0d: 'Divide', 0x0e: 'Equals', 0x0f: 'Less', 0x10: 'And', 0x11: 'Or',
  0x12: 'Not', 0x13: 'StringEquals', 0x14: 'StringLength', 0x15: 'StringExtract', 0x17: 'Pop', 0x18: 'ToInteger',
  0x1c: 'GetVariable', 0x1d: 'SetVariable', 0x20: 'SetTarget2', 0x21: 'StringAdd', 0x22: 'GetProperty', 0x23: 'SetProperty',
  0x24: 'CloneSprite', 0x25: 'RemoveSprite', 0x26: 'Trace', 0x27: 'StartDrag', 0x28: 'EndDrag', 0x29: 'StringLess',
  0x2a: 'Throw', 0x2b: 'CastOp', 0x2c: 'ImplementsOp', 0x2d: 'FSCommand2', 0x30: 'RandomNumber', 0x31: 'MBStringLength',
  0x32: 'CharToAscii', 0x33: 'AsciiToChar', 0x34: 'GetTime', 0x35: 'MBStringExtract', 0x36: 'MBCharToAscii',
  0x37: 'MBAsciiToChar', 0x3a: 'Delete', 0x3b: 'Delete2', 0x3c: 'DefineLocal', 0x3d: 'CallFunction', 0x3e: 'Return',
  0x3f: 'Modulo', 0x40: 'NewObject', 0x41: 'DefineLocal2', 0x42: 'InitArray', 0x43: 'InitObject', 0x44: 'TypeOf',
  0x45: 'TargetPath', 0x46: 'Enumerate', 0x47: 'Add2', 0x48: 'Less2', 0x49: 'Equals2', 0x4a: 'ToNumber', 0x4b: 'ToString',
  0x4c: 'PushDuplicate', 0x4d: 'StackSwap', 0x4e: 'GetMember', 0x4f: 'SetMember', 0x50: 'Increment', 0x51: 'Decrement',
  0x52: 'CallMethod', 0x53: 'NewMethod', 0x54: 'InstanceOf', 0x55: 'Enumerate2', 0x60: 'BitAnd', 0x61: 'BitOr',
  0x62: 'BitXor', 0x63: 'BitLShift', 0x64: 'BitRShift', 0x65: 'BitURShift', 0x66: 'StrictEquals', 0x67: 'Greater',
  0x68: 'StringGreater', 0x69: 'Extends',
  0x81: 'GotoFrame', 0x83: 'GetURL', 0x87: 'StoreRegister', 0x88: 'ConstantPool', 0x89: 'StrictMode', 0x8a: 'WaitForFrame',
  0x8b: 'SetTarget', 0x8c: 'GoToLabel', 0x8d: 'WaitForFrame2', 0x8e: 'DefineFunction2', 0x8f: 'Try', 0x94: 'With',
  0x96: 'Push', 0x99: 'Jump', 0x9a: 'GetURL2', 0x9b: 'DefineFunction', 0x9d: 'If', 0x9e: 'Call', 0x9f: 'GotoFrame2',
};
const CODE_OF = new Map(Object.entries(ACTION_NAMES).map(([c, n]) => [n.toLowerCase(), Number(c)]));
CODE_OF.set('gotolabel', 0x8c).set('previousframe', 0x05);

// Long actions whose payload is a fixed list of fields (in byte and text order).
const FIELDS = { 0x81: ['u16'], 0x83: ['str', 'str'], 0x87: ['u8'], 0x89: ['u8'], 0x8a: ['u16', 'u8'], 0x8b: ['str'], 0x8c: ['str'], 0x8d: ['u8'], 0x9e: [] };
const DF2_FLAGS = ['preloadParent', 'preloadRoot', 'suppressSuper', 'preloadSuper', 'suppressArguments', 'preloadArguments', 'suppressThis', 'preloadThis', 'preloadGlobal'];
const DF2_BITS = [0x8000, 0x4000, 0x2000, 0x1000, 0x0800, 0x0400, 0x0200, 0x0100, 0x0001];
const SEND_VARS = ['none', 'GET', 'POST'];

// ---------- strings: bytes as a binary string (one char per byte), text with escapes ----------

const binOf = (u8, s, e) => {
  let r = '';
  for (let i = s; i < e; i += 8192) r += String.fromCharCode.apply(null, u8.subarray(i, Math.min(e, i + 8192)));
  return r;
};
const hex2 = (n) => n.toString(16).padStart(2, '0');

/** A UTF-8 byte string as a quoted p-code literal; bytes that are not UTF-8 are written \xNN. */
export function quote(bin) {
  let out = '"';
  const n = bin.length;
  const b = (k) => bin.charCodeAt(k);
  const cont = (k) => k < n && (b(k) & 0xc0) === 0x80;
  for (let i = 0; i < n; ) {
    const c = b(i);
    let cp = -1;
    let len = 1;
    if (c < 0x80) cp = c;
    else if (c >= 0xc2 && c <= 0xdf && cont(i + 1)) [cp, len] = [((c & 0x1f) << 6) | (b(i + 1) & 0x3f), 2];
    else if (c >= 0xe0 && c <= 0xef && cont(i + 1) && cont(i + 2)) {
      const v = ((c & 0x0f) << 12) | ((b(i + 1) & 0x3f) << 6) | (b(i + 2) & 0x3f);
      if (v >= 0x800 && (v < 0xd800 || v > 0xdfff)) [cp, len] = [v, 3];
    } else if (c >= 0xf0 && c <= 0xf4 && cont(i + 1) && cont(i + 2) && cont(i + 3)) {
      const v = ((c & 0x07) << 18) | ((b(i + 1) & 0x3f) << 12) | ((b(i + 2) & 0x3f) << 6) | (b(i + 3) & 0x3f);
      if (v >= 0x10000 && v <= 0x10ffff) [cp, len] = [v, 4];
    }
    if (cp < 0) out += `\\x${hex2(c)}`;
    else if (cp === 0x22) out += '\\"';
    else if (cp === 0x27) out += "\\'";
    else if (cp === 0x5c) out += '\\\\';
    else if (cp === 0x0a) out += '\\n';
    else if (cp === 0x0d) out += '\\r';
    else if (cp === 0x09) out += '\\t';
    else if (cp === 0x08) out += '\\b';
    else if (cp === 0x0c) out += '\\f';
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${hex2(cp)}`;
    else out += String.fromCodePoint(cp);
    i += len;
  }
  return out + '"';
}

/** Text (a JS string) → its UTF-8 byte string. */
export function utf8Bin(s) {
  let r = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) r += ch;
    else if (cp < 0x800) r += String.fromCharCode(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) r += String.fromCharCode(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else r += String.fromCharCode(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return r;
}

/** A UTF-8 byte string → text for display (bytes that are not UTF-8 become U+FFFD). */
export function binText(bin) {
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(u8);
}

// ---------- numbers ----------

const f64 = new DataView(new ArrayBuffer(8));
function doubleText(hi, lo) {
  f64.setUint32(0, hi);
  f64.setUint32(4, lo);
  const v = f64.getFloat64(0);
  if (Number.isNaN(v)) return hi === 0x7ff80000 && lo === 0 ? 'NaN' : `(double)0x${hi.toString(16).padStart(8, '0')}${lo.toString(16).padStart(8, '0')}`;
  if (Object.is(v, -0)) return '-0.0';
  const s = String(v);
  return /[.eIN]/.test(s) ? s : `${s}.0`;
}
// FFDec writes a float as the double it widens to with an f after it (1.5f, 0.10000000149011612f).
function floatText(bits) {
  f64.setUint32(0, bits);
  const v = f64.getFloat32(0);
  if (Number.isNaN(v)) return bits === 0x7fc00000 ? 'NaNf' : `(float)0x${bits.toString(16).padStart(8, '0')}`;
  if (Object.is(v, -0)) return '-0f';
  return `${v}f`;
}

// ---------- reading ----------

class Payload {
  constructor(u8) {
    this.b = u8;
    this.i = 0;
  }
  need(n) {
    if (this.i + n > this.b.length) throw BAD;
  }
  u8() {
    this.need(1);
    return this.b[this.i++];
  }
  u16() {
    this.need(2);
    const v = this.b[this.i] | (this.b[this.i + 1] << 8);
    this.i += 2;
    return v;
  }
  s16() {
    return (this.u16() << 16) >> 16;
  }
  u32() {
    this.need(4);
    const v = (this.b[this.i] | (this.b[this.i + 1] << 8) | (this.b[this.i + 2] << 16) | (this.b[this.i + 3] << 24)) >>> 0;
    this.i += 4;
    return v;
  }
  str() {
    const z = this.b.indexOf(0, this.i);
    if (z < 0) throw BAD;
    const s = binOf(this.b, this.i, z);
    this.i = z + 1;
    return s;
  }
  get done() {
    return this.i === this.b.length;
  }
}
const BAD = new Error('bad payload');

/** One action's fields, or `raw: true` when the payload is not one this module writes back the same way. */
function decodeAction(code, payload, offset, size) {
  const a = { offset, size, code, name: ACTION_NAMES[code] ?? 'Unknown', raw: false };
  if (code < 0x80) {
    if (!(code in ACTION_NAMES)) a.raw = true;
    return a;
  }
  a.payload = payload;
  const r = new Payload(payload);
  try {
    if (code in FIELDS) a.args = FIELDS[code].map((k) => r[k]());
    else if (code === 0x99 || code === 0x9d) a.branch = r.s16();
    else if (code === 0x88) {
      const n = r.u16();
      a.pool = [];
      for (let i = 0; i < n; i++) a.pool.push(r.str());
    } else if (code === 0x96) {
      a.values = [];
      while (!r.done) {
        const t = r.u8();
        if (t === 0) a.values.push({ t, v: r.str() });
        else if (t === 1) a.values.push({ t, v: r.u32() });
        else if (t === 2 || t === 3) a.values.push({ t });
        else if (t === 4 || t === 5 || t === 8) a.values.push({ t, v: r.u8() });
        else if (t === 6) a.values.push({ t, hi: r.u32(), lo: r.u32() });
        else if (t === 7) a.values.push({ t, v: r.u32() | 0 });
        else if (t === 9) a.values.push({ t, v: r.u16() });
        else throw BAD;
      }
    } else if (code === 0x9b) {
      a.fname = r.str();
      const n = r.u16();
      a.params = [];
      for (let i = 0; i < n; i++) a.params.push(r.str());
      a.sizes = [r.u16()];
    } else if (code === 0x8e) {
      a.fname = r.str();
      const n = r.u16();
      a.registerCount = r.u8();
      a.flags = r.u16be();
      if (a.flags & 0x00fe) throw BAD;
      a.params = [];
      for (let i = 0; i < n; i++) a.params.push({ register: r.u8(), name: r.str() });
      a.sizes = [r.u16()];
    } else if (code === 0x94) a.sizes = [r.u16()];
    else if (code === 0x8f) {
      a.tflags = r.u8();
      a.sizes = [r.u16(), r.u16(), r.u16()];
      if (a.tflags & 0xf8 || (!(a.tflags & 1) && a.sizes[1]) || (!(a.tflags & 2) && a.sizes[2])) throw BAD;
      if (a.tflags & 4) a.catchRegister = r.u8();
      else a.catchName = r.str();
    } else if (code === 0x9a) {
      a.uflags = r.u8();
      if (a.uflags & 0x3c) throw BAD;
    } else if (code === 0x9f) {
      a.gflags = r.u8();
      if (a.gflags & 0xfc) throw BAD;
      if (a.gflags & 2) a.sceneBias = r.u16();
    } else throw BAD;
    if (!r.done) throw BAD;
  } catch (e) {
    if (e !== BAD) throw e;
    a.raw = true;
  }
  return a;
}
Payload.prototype.u16be = function () {
  // DefineFunction2's flags: the first byte holds the high bits (PreloadParent … PreloadThis), the second PreloadGlobal.
  this.need(2);
  const v = (this.b[this.i] << 8) | this.b[this.i + 1];
  this.i += 2;
  return v;
};

const isContainer = (a) => !a.raw && a.sizes != null;

/**
 * The block's actions in byte order, with the containers (function, With and Try bodies) that line up with action
 * boundaries, the End that stops it and any bytes after that End.
 */
export function readActions(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const all = [];
  let pos = 0;
  let cut = b.length;
  while (pos < b.length) {
    const code = b[pos];
    let size = 1;
    let payload = null;
    if (code >= 0x80) {
      if (pos + 3 > b.length || pos + 3 + (b[pos + 1] | (b[pos + 2] << 8)) > b.length) {
        cut = pos;
        break;
      }
      size = 3 + (b[pos + 1] | (b[pos + 2] << 8));
      payload = b.subarray(pos + 3, pos + size);
    }
    all.push(decodeAction(code, payload, pos, size));
    pos += size;
  }
  const parsedEnd = cut;
  const starts = new Set(all.map((a) => a.offset));
  // Containers whose bodies end on action boundaries and nest inside the part (body, catch or finally) they start in.
  const lastEnd = (c) => c.ends[c.ends.length - 1];
  const stack = [];
  for (const a of all) {
    while (stack.length && lastEnd(stack[stack.length - 1]) <= a.offset) stack.pop();
    if (!isContainer(a)) continue;
    let e = a.offset + a.size;
    a.ends = a.sizes.map((s) => (e += s));
    const parent = stack[stack.length - 1];
    const limit = parent ? parent.ends.find((x) => x > a.offset) : parsedEnd;
    if (!a.ends.every((x) => x === parsedEnd || starts.has(x)) || e > limit) {
      a.raw = true;
      delete a.ends;
      continue;
    }
    stack.push(a);
  }
  // The first End outside every body stops the block; whatever follows it is kept as bytes.
  let kept = all.length;
  let stopped = false;
  stack.length = 0;
  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    while (stack.length && lastEnd(stack[stack.length - 1]) <= a.offset) stack.pop();
    if (a.code === 0 && !stack.length) {
      kept = i + 1;
      cut = a.offset + 1;
      stopped = true;
      break;
    }
    if (a.ends) stack.push(a);
  }
  const actions = all.slice(0, kept);
  const hiddenEnd = stopped && cut === b.length;
  return { actions, end: cut, trailing: b.subarray(cut), hiddenEnd, length: b.length };
}

// ---------- disassembler ----------

const labelName = (pos) => `loc${pos.toString(16).padStart(4, '0')}`;
const hexBytes = (u8) => Array.from(u8, hex2).join(' ');

function pushValueText(v, pool, first) {
  switch (v.t) {
    case 0:
      return first?.has(v.v) ? `(string)${quote(v.v)}` : quote(v.v);
    case 1:
      return floatText(v.v);
    case 2:
      return 'null';
    case 3:
      return 'undefined';
    case 4:
      return `register${v.v}`;
    case 5:
      return v.v === 0 ? 'false' : v.v === 1 ? 'true' : `(boolean)${v.v}`;
    case 6:
      return doubleText(v.hi, v.lo);
    case 7:
      return String(v.v);
    case 8:
    case 9: {
      const s = pool && v.v < pool.length ? pool[v.v] : null;
      const named = s != null && first.get(s) === v.v;
      const wide = v.t === 9;
      if (named) return wide === v.v >= 256 ? quote(s) : `(constant${wide ? 16 : 8})${quote(s)}`;
      return wide === v.v >= 256 ? `constant${v.v}` : `(constant${wide ? 16 : 8})constant${v.v}`;
    }
  }
  throw new Error(`push type ${v.t}`);
}

function firstIndexes(pool) {
  const m = new Map();
  pool.forEach((s, i) => m.has(s) || m.set(s, i));
  return m;
}

function actionText(a, ctx) {
  if (a.raw) return a.code >= 0x80 ? `Unknown 0x${hex2(a.code)}${a.payload.length ? ` ${hexBytes(a.payload)}` : ''}` : `Unknown 0x${hex2(a.code)}`;
  const n = a.name;
  switch (a.code) {
    case 0x88:
      return a.pool.length ? `${n} ${a.pool.map(quote).join(', ')}` : n;
    case 0x96:
      return a.values.length ? `${n} ${a.values.map((v) => pushValueText(v, ctx.pool, ctx.first)).join(', ')}` : n;
    case 0x99:
    case 0x9d: {
      const t = a.offset + a.size + a.branch;
      return `${n} ${ctx.labels.has(t) ? labelName(t) : (a.branch < 0 ? '' : '+') + a.branch}`;
    }
    case 0x9b:
      // FFDec's spacing: each parameter name is followed by a space
      return `${n} ${quote(a.fname)}, ${a.params.length}${a.params.map((p) => `, ${quote(p)} `).join('')} {`;
    case 0x8e:
      return `${n} ${[quote(a.fname), a.params.length, a.registerCount, ...DF2_BITS.map((m) => !!(a.flags & m)), ...a.params.flatMap((p) => [p.register, quote(p.name)])].join(', ')} {`;
    case 0x94:
      return `${n} {`;
    case 0x8f: {
      const c = a.tflags & 4 ? `register${a.catchRegister}` : a.catchName === '' && !(a.tflags & 1) ? '' : quote(a.catchName);
      return `${n} ${c ? `${c} ` : ''}{`;
    }
    case 0x9a: // loadVariables (bit 7), loadTarget (bit 6), send method (bits 0-1), as players and FFDec read it
      return `${n} ${!!(a.uflags & 0x80)}, ${!!(a.uflags & 0x40)}, ${a.uflags & 3}`;
    case 0x9f: // sceneBias flag, play flag[, scene bias]
      return `${n} ${!!(a.gflags & 2)}, ${!!(a.gflags & 1)}${a.gflags & 2 ? `, ${a.sceneBias}` : ''}`;
  }
  if (a.args) return a.args.length ? `${n} ${a.args.map((x, i) => (FIELDS[a.code][i] === 'str' ? quote(x) : String(x))).join(', ')}` : n;
  return n;
}

/**
 * Disassembles one action block (a DoAction body, a DoInitAction body after its sprite id, a clip action record's or a
 * button condition's actions) into p-code. Returns `{ text, actions }`: the actions in byte order, each with its
 * `offset`, `size`, `code`, `name` and the 1-based `line` it is on.
 */
export function disassemble(bytes, opts = {}) {
  const indentUnit = opts.indent ?? '';
  const blk = readActions(bytes);
  const shown = blk.hiddenEnd ? blk.actions.slice(0, -1) : blk.actions;
  const finalPos = blk.hiddenEnd ? blk.actions[blk.actions.length - 1].offset : blk.end;
  const targets = new Set(shown.map((a) => a.offset));
  targets.add(finalPos);
  const labels = new Set();
  for (const a of shown) if (!a.raw && (a.code === 0x99 || a.code === 0x9d)) {
    const t = a.offset + a.size + a.branch;
    if (targets.has(t)) labels.add(t);
  }
  const lines = [];
  const open = []; // [{ends:[...], k}] the bodies open at this point
  const ctx = { pool: null, first: null, labels };
  const ind = () => indentUnit.repeat(open.length);
  const closeAt = (pos) => {
    while (open.length) {
      const top = open[open.length - 1];
      if (top.ends[top.k] !== pos) break;
      open.pop();
      lines.push(`${ind()}}`);
      top.k++;
      while (top.k < top.ends.length && top.heads[top.k] == null) top.k++;
      if (top.k < top.ends.length) {
        lines.push(`${ind()}${top.heads[top.k]} {`);
        open.push(top);
      }
    }
  };
  for (const a of shown) {
    closeAt(a.offset);
    const text = actionText(a, ctx);
    a.line = lines.length + 1;
    lines.push(`${ind()}${labels.has(a.offset) ? `${labelName(a.offset)}:` : ''}${text}`);
    if (a.code === 0x88 && !a.raw) [ctx.pool, ctx.first] = [a.pool, firstIndexes(a.pool)];
    if (a.ends) {
      const heads = a.code === 0x8f ? [null, a.tflags & 1 ? 'Catch' : null, a.tflags & 2 ? 'Finally' : null] : [null];
      const o = { ends: a.ends, heads, k: 0 };
      open.push(o);
    }
  }
  closeAt(finalPos);
  if (labels.has(finalPos)) lines.push(`${labelName(finalPos)}:`);
  if (blk.trailing.length) lines.push(`.bytes ${hexBytes(blk.trailing)}`);
  if (!blk.hiddenEnd) lines.push('.noend');
  if (blk.hiddenEnd) blk.actions[blk.actions.length - 1].line = 0;
  return { text: lines.join('\n') + (lines.length ? '\n' : ''), actions: blk.actions, trailing: blk.trailing, hiddenEnd: blk.hiddenEnd };
}

// ---------- assembler ----------

export class AsmError extends Error {
  constructor(line, message) {
    super(message);
    this.line = line;
    this.name = 'AsmError';
  }
}

class Writer {
  constructor() {
    this.b = new Uint8Array(1024);
    this.n = 0;
  }
  room(k) {
    if (this.n + k <= this.b.length) return;
    const nb = new Uint8Array(Math.max(this.b.length * 2, this.n + k));
    nb.set(this.b.subarray(0, this.n));
    this.b = nb;
  }
  u8(v) {
    this.room(1);
    this.b[this.n++] = v & 0xff;
  }
  u16(v) {
    this.u8(v);
    this.u8(v >> 8);
  }
  u32(v) {
    this.u16(v & 0xffff);
    this.u16(v >>> 16);
  }
  bin(s) {
    this.room(s.length);
    for (let i = 0; i < s.length; i++) this.b[this.n++] = s.charCodeAt(i);
  }
  str(s) {
    this.bin(s);
    this.u8(0);
  }
  put16(at, v) {
    this.b[at] = v & 0xff;
    this.b[at + 1] = (v >> 8) & 0xff;
  }
  get bytes() {
    return this.b.slice(0, this.n);
  }
}

// Operand tokens: {t:'str', v:binary}, {t:'num', s}, {t:'id', s}, {t:'cast', s}, {t:','}, {t:'{'}
const NUM_RE = /^[+-]?(?:0x[0-9a-f]+|(?:Infinity|NaN|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)f?)(?![\w$])/i;
const ID_RE = /^[A-Za-z_$][\w$]*/;

function lexString(s, i, line) {
  const q = s[i];
  let out = '';
  i++;
  while (i < s.length && s[i] !== q) {
    let c = s[i];
    if (c !== '\\') {
      const cp = s.codePointAt(i);
      out += utf8Bin(String.fromCodePoint(cp));
      i += cp > 0xffff ? 2 : 1;
      continue;
    }
    c = s[i + 1];
    i += 2;
    if (c === 'n') out += '\n';
    else if (c === 'r') out += '\r';
    else if (c === 't') out += '\t';
    else if (c === 'b') out += '\b';
    else if (c === 'f') out += '\f';
    else if (c === 'v') out += '\v';
    else if (c === '0' && !/[0-9]/.test(s[i] ?? '')) out += '\0';
    else if (c === 'x') {
      const h = s.slice(i, i + 2);
      if (!/^[0-9a-f]{2}$/i.test(h)) throw new AsmError(line, 'A \\x escape needs two hex digits.');
      out += String.fromCharCode(parseInt(h, 16));
      i += 2;
    } else if (c === 'u') {
      let h;
      if (s[i] === '{') {
        const e = s.indexOf('}', i);
        h = e > i ? s.slice(i + 1, e) : '';
        i = e + 1;
      } else {
        h = s.slice(i, i + 4);
        i += 4;
      }
      if (!/^[0-9a-f]{1,6}$/i.test(h) || parseInt(h, 16) > 0x10ffff) throw new AsmError(line, 'A \\u escape needs four hex digits (or \\u{…}).');
      let cp = parseInt(h, 16);
      // a surrogate pair written as two \u escapes
      if (cp >= 0xd800 && cp <= 0xdbff && s.slice(i, i + 2) === '\\u' && /^[0-9a-f]{4}$/i.test(s.slice(i + 2, i + 6))) {
        const lo = parseInt(s.slice(i + 2, i + 6), 16);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
          i += 6;
        }
      }
      out += utf8Bin(String.fromCodePoint(cp));
    } else if (c === undefined) throw new AsmError(line, 'The string is not closed.');
    else out += utf8Bin(c);
  }
  if (i >= s.length) throw new AsmError(line, 'The string is not closed.');
  if (out.includes('\0')) throw new AsmError(line, 'A string cannot hold a zero byte.');
  return [out, i + 1];
}

function lex(s, line) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') i++;
    else if (c === ';') break;
    else if (c === ',' || c === '{' || c === '}') {
      toks.push({ t: c });
      i++;
    } else if (c === '"' || c === "'") {
      const [v, j] = lexString(s, i, line);
      toks.push({ t: 'str', v });
      i = j;
    } else if (c === '(') {
      const m = /^\(\s*([A-Za-z]\w*)\s*\)/.exec(s.slice(i));
      if (!m) throw new AsmError(line, `Expected a type such as (string) at "${s.slice(i, i + 12)}".`);
      toks.push({ t: 'cast', s: m[1].toLowerCase() });
      i += m[0].length;
    } else {
      const rest = s.slice(i);
      const m = NUM_RE.exec(rest) || ID_RE.exec(rest);
      if (!m) throw new AsmError(line, `Unexpected "${rest.slice(0, 12)}".`);
      toks.push({ t: NUM_RE.test(rest) && m[0] === NUM_RE.exec(rest)[0] ? 'num' : 'id', s: m[0] });
      i += m[0].length;
    }
  }
  return toks;
}

/** Splits operand tokens at commas; a trailing `{` is returned separately. */
function operands(toks, line) {
  let brace = false;
  if (toks.length && toks[toks.length - 1].t === '{') {
    brace = true;
    toks = toks.slice(0, -1);
  }
  const ops = [];
  let cur = [];
  for (const t of toks) {
    if (t.t === ',') {
      if (!cur.length) throw new AsmError(line, 'A value is missing before a comma.');
      ops.push(cur);
      cur = [];
    } else if (t.t === '{' || t.t === '}') throw new AsmError(line, `Unexpected "${t.t}".`);
    else cur.push(t);
  }
  if (cur.length) ops.push(cur);
  else if (ops.length) throw new AsmError(line, 'A value is missing after the last comma.');
  return { ops, brace };
}

const one = (op, line, what) => {
  if (op.length !== 1) throw new AsmError(line, `Expected ${what}.`);
  return op[0];
};
function intOp(op, line, what, min, max) {
  const t = one(op, line, what);
  if (t.t !== 'num' || !/^[+-]?(\d+|0x[0-9a-f]+)$/i.test(t.s)) throw new AsmError(line, `Expected ${what}, found "${t.s ?? t.v ?? t.t}".`);
  const v = Number(t.s);
  if (!(v >= min && v <= max)) throw new AsmError(line, `${what[0].toUpperCase()}${what.slice(1)} must be from ${min} to ${max}.`);
  return v;
}
function strOp(op, line, what) {
  const t = one(op, line, what);
  if (t.t !== 'str') throw new AsmError(line, `Expected ${what} in quotes.`);
  return t.v;
}
function boolOp(op, line, what) {
  const t = one(op, line, what);
  const s = (t.s ?? '').toLowerCase();
  if (t.t === 'id' && (s === 'true' || s === 'false')) return s === 'true';
  if (t.t === 'num' && (t.s === '0' || t.s === '1')) return t.s === '1';
  throw new AsmError(line, `Expected true or false for ${what}.`);
}
function regOp(op, line) {
  const t = one(op, line, 'a register');
  const m = t.t === 'id' && /^register(\d+)$/i.exec(t.s);
  if (!m || +m[1] > 255) throw new AsmError(line, 'Expected a register such as register1 (0 to 255).');
  return +m[1];
}

function writePushValue(w, op, line, pool) {
  let cast = null;
  if (op[0].t === 'cast') {
    cast = op[0].s;
    op = op.slice(1);
  }
  const t = one(op, line, 'a value');
  const lookup = (s) => {
    const k = pool ? pool.first.get(s) : undefined;
    return k;
  };
  if (t.t === 'str') {
    if (cast === 'string') {
      w.u8(0);
      return w.str(t.v);
    }
    if (cast && cast !== 'constant8' && cast !== 'constant16') throw new AsmError(line, `A string cannot be (${cast}).`);
    const k = lookup(t.v);
    if (k == null) {
      if (cast) throw new AsmError(line, `${quote(t.v)} is not in the constant pool.`);
      w.u8(0);
      return w.str(t.v);
    }
    const wide = cast ? cast === 'constant16' : k >= 256;
    if (!wide && k >= 256) throw new AsmError(line, `Constant ${k} does not fit constant8.`);
    w.u8(wide ? 9 : 8);
    return wide ? w.u16(k) : w.u8(k);
  }
  if (t.t === 'id') {
    const s = t.s.toLowerCase();
    let m;
    if (cast && !(/^constant\d+$/.test(s) && (cast === 'constant8' || cast === 'constant16')) && !(cast === 'float' && (s === 'nan' || s === 'infinity')))
      throw new AsmError(line, `"${t.s}" cannot be (${cast}).`);
    if (s === 'null') return w.u8(2);
    if (s === 'undefined') return w.u8(3);
    if (s === 'true' || s === 'false') {
      w.u8(5);
      return w.u8(s === 'true' ? 1 : 0);
    }
    if ((m = /^register(\d+)$/.exec(s))) {
      if (+m[1] > 255) throw new AsmError(line, 'Registers go from 0 to 255.');
      w.u8(4);
      return w.u8(+m[1]);
    }
    if ((m = /^constant(\d+)$/.exec(s))) {
      const k = +m[1];
      const wide = cast ? cast === 'constant16' : k >= 256;
      if (k > 65535 || (!wide && k > 255)) throw new AsmError(line, `Constant ${k} does not fit ${wide ? 'constant16' : 'constant8'}.`);
      w.u8(wide ? 9 : 8);
      return wide ? w.u16(k) : w.u8(k);
    }
    throw new AsmError(line, `Unknown value "${t.s}" (a string needs quotes).`);
  }
  if (t.t !== 'num') throw new AsmError(line, 'Expected a value.');
  const hex = /^[+-]?0x/i.test(t.s);
  const fsuf = !hex && /f$/i.test(t.s);
  const s = fsuf ? t.s.slice(0, -1) : t.s;
  if (fsuf && cast && cast !== 'float') throw new AsmError(line, `A float (…f) cannot be (${cast}).`);
  if (fsuf) cast = 'float';
  if (cast === 'boolean') {
    const v = Number(s);
    if (!Number.isInteger(v) || v < 0 || v > 255) throw new AsmError(line, 'A (boolean) byte goes from 0 to 255.');
    w.u8(5);
    return w.u8(v);
  }
  if (cast === 'float') {
    w.u8(1);
    if (hex) {
      if (s.length > 10 || s[0] === '-' || s[0] === '+') throw new AsmError(line, 'A (float) bit pattern is 0x and up to 8 hex digits.');
      return w.u32(Number(s) >>> 0);
    }
    f64.setFloat32(0, Number(s));
    return w.u32(f64.getUint32(0));
  }
  if (cast === 'double' || /[.eEIN]/.test(s.replace(/^[+-]?0x.*/i, ''))) {
    if (cast && cast !== 'double') throw new AsmError(line, `A number cannot be (${cast}).`);
    w.u8(6);
    if (hex) {
      if (s.length > 18 || s[0] === '-' || s[0] === '+') throw new AsmError(line, 'A (double) bit pattern is 0x and up to 16 hex digits.');
      const h = s.slice(2).padStart(16, '0');
      w.u32(parseInt(h.slice(0, 8), 16));
      return w.u32(parseInt(h.slice(8), 16));
    }
    f64.setFloat64(0, Number(s));
    w.u32(f64.getUint32(0));
    return w.u32(f64.getUint32(4));
  }
  if (cast) throw new AsmError(line, `A number cannot be (${cast}).`);
  const v = Number(s);
  if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 && !hex) {
    w.u8(7);
    return w.u32(v >>> 0);
  }
  if (hex) throw new AsmError(line, 'Hex numbers are only for (float) and (double) bit patterns.');
  w.u8(6);
  f64.setFloat64(0, v);
  w.u32(f64.getUint32(0));
  return w.u32(f64.getUint32(4));
}

function parseHex(s, line) {
  const h = s.replace(/[\s,]+/g, '');
  if (!/^([0-9a-f]{2})*$/i.test(h)) throw new AsmError(line, 'Expected hex bytes such as 0a 1b 2c.');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

/**
 * Assembles p-code (the text `disassemble` writes, edited or not) into an action block. Throws an AsmError with the
 * 1-based `line` and a message when the text is not valid. `opts.poolEdit = {pool, index, value}` replaces one string
 * of the `pool`-th ConstantPool (0-based) while Push keeps pointing at the same constant numbers.
 */
export function assemble(text, opts = {}) {
  const w = new Writer();
  const labels = new Map();
  const fixups = [];
  const stack = []; // open bodies: {kind, line, start, sizeAt:[...], k, a}
  let pool = null;
  let poolNo = 0;
  let noEnd = false;
  let pendingTry = null; // a Try whose block just closed: Catch / Finally may follow
  const srcLines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const finishTry = (t) => {
    w.b[t.flagsAt] = t.flags;
    pendingTry = null;
  };
  for (let li = 0; li < srcLines.length; li++) {
    const line = li + 1;
    let s = srcLines[li];
    // label(s) at the start of the line
    let m;
    while ((m = /^\s*([A-Za-z_$][\w$]*)\s*:(?![:)])/.exec(s)) && !/^\s*\(/.test(s)) {
      if (labels.has(m[1])) throw new AsmError(line, `The label ${m[1]} is defined twice.`);
      labels.set(m[1], w.n);
      s = s.slice(m[0].length);
    }
    s = s.trim();
    if (!s || s[0] === ';') continue;
    // closing braces, and Catch { / Finally { after a Try block
    while (s[0] === '}') {
      if (pendingTry) finishTry(pendingTry);
      const top = stack.pop();
      if (!top) throw new AsmError(line, 'This } closes nothing.');
      w.put16(top.sizeAt[top.k], w.n - top.start);
      if (top.kind === 'try') {
        pendingTry = top;
        top.k++;
      }
      s = s.slice(1).trim();
    }
    if (!s || s[0] === ';') continue;
    const word = /^[.A-Za-z_][\w.]*/.exec(s)?.[0] ?? '';
    const rest = s.slice(word.length);
    const lw = word.toLowerCase();
    if (pendingTry && (lw === 'catch' || lw === 'finally')) {
      const t = pendingTry;
      const toks = lex(rest, line);
      if (toks.length !== 1 || toks[0].t !== '{') throw new AsmError(line, `Expected "${word} {".`);
      const want = lw === 'catch' ? 1 : 2;
      if (t.k > want) throw new AsmError(line, `${word} must come ${lw === 'catch' ? 'before Finally' : 'once'}.`);
      t.k = want;
      t.flags |= want === 1 ? 1 : 2;
      t.start = w.n;
      stack.push(t);
      pendingTry = null;
      continue;
    }
    if (pendingTry) finishTry(pendingTry);
    if (lw === '.noend') {
      noEnd = true;
      continue;
    }
    if (lw === '.bytes') {
      const u = parseHex(rest.replace(/;.*$/, ''), line);
      for (const x of u) w.u8(x);
      continue;
    }
    if (lw === 'unknown') {
      const mm = /^\s+0x([0-9a-f]{1,2})\b(.*)$/i.exec(rest.replace(/;.*$/, ''));
      if (!mm) throw new AsmError(line, 'Expected Unknown 0xNN followed by the payload bytes.');
      const code = parseInt(mm[1], 16);
      const u = parseHex(mm[2], line);
      w.u8(code);
      if (code >= 0x80) {
        if (u.length > 65535) throw new AsmError(line, 'A payload holds at most 65535 bytes.');
        w.u16(u.length);
        for (const x of u) w.u8(x);
      } else if (u.length) throw new AsmError(line, 'Actions below 0x80 have no payload.');
      continue;
    }
    const code = CODE_OF.get(lw);
    if (code == null) throw new AsmError(line, `Unknown instruction "${word || s.slice(0, 16)}".`);
    const { ops, brace } = operands(lex(rest, line), line);
    const container = code === 0x9b || code === 0x8e || code === 0x94 || code === 0x8f;
    if (brace !== container) throw new AsmError(line, container ? `${ACTION_NAMES[code]} needs "{" at the end of the line.` : `Unexpected "{".`);
    const name = ACTION_NAMES[code];
    const need = (n) => {
      if (ops.length !== n) throw new AsmError(line, `${name} takes ${n === 0 ? 'no values' : n === 1 ? 'one value' : `${n} values`}.`);
    };
    w.u8(code);
    if (code < 0x80) {
      need(0);
      continue;
    }
    const lenAt = w.n;
    w.u16(0);
    const start = w.n;
    if (code in FIELDS) {
      const spec = FIELDS[code];
      need(spec.length);
      spec.forEach((k, i) => {
        if (k === 'str') w.str(strOp(ops[i], line, 'a string'));
        else if (k === 'u8') w.u8(intOp(ops[i], line, 'a number', 0, 255));
        else w.u16(intOp(ops[i], line, 'a number', 0, 65535));
      });
    } else if (code === 0x99 || code === 0x9d) {
      need(1);
      const t = one(ops[0], line, 'a label');
      if (t.t === 'num' && /^[+-]\d+$/.test(t.s)) {
        const v = Number(t.s);
        if (v < -32768 || v > 32767) throw new AsmError(line, 'A branch offset goes from -32768 to +32767.');
        w.u16(v & 0xffff);
      } else if (t.t === 'id') {
        fixups.push({ at: w.n, from: w.n + 2, label: t.s, line });
        w.u16(0);
      } else throw new AsmError(line, `${name} needs a label (or a signed offset such as +4).`);
    } else if (code === 0x88) {
      const list = ops.map((o) => strOp(o, line, 'a string'));
      if (list.length > 65535) throw new AsmError(line, 'A constant pool holds at most 65535 strings.');
      const out = list.slice();
      const pe = opts.poolEdit;
      if (pe && pe.pool === poolNo) {
        if (!(pe.index >= 0 && pe.index < out.length)) throw new AsmError(line, `The pool has no string ${pe.index}.`);
        out[pe.index] = pe.value;
      }
      poolNo++;
      w.u16(out.length);
      for (const x of out) w.str(x);
      pool = { list, first: firstIndexes(list) };
    } else if (code === 0x96) {
      for (const op of ops) writePushValue(w, op, line, pool);
    } else if (code === 0x9b) {
      if (ops.length < 2) throw new AsmError(line, 'DefineFunction takes a name, the parameter count and the parameter names.');
      w.str(strOp(ops[0], line, 'the function name'));
      const n = intOp(ops[1], line, 'the parameter count', 0, 65535);
      if (ops.length !== 2 + n) throw new AsmError(line, `DefineFunction says ${n} parameter${n === 1 ? '' : 's'} but names ${ops.length - 2}.`);
      w.u16(n);
      for (let i = 0; i < n; i++) w.str(strOp(ops[2 + i], line, 'a parameter name'));
      stack.push({ kind: 'fn', line, sizeAt: [w.n], k: 0, start: w.n + 2 });
      w.u16(0);
    } else if (code === 0x8e) {
      if (ops.length < 12) throw new AsmError(line, 'DefineFunction2 takes a name, the parameter count, the register count, 9 flags and register, name pairs.');
      w.str(strOp(ops[0], line, 'the function name'));
      const n = intOp(ops[1], line, 'the parameter count', 0, 65535);
      if (ops.length !== 12 + 2 * n) throw new AsmError(line, `DefineFunction2 says ${n} parameter${n === 1 ? '' : 's'} but lists ${(ops.length - 12) / 2}.`);
      w.u16(n);
      w.u8(intOp(ops[2], line, 'the register count', 0, 255));
      let flags = 0;
      DF2_FLAGS.forEach((f, i) => {
        if (boolOp(ops[3 + i], line, f)) flags |= DF2_BITS[i];
      });
      w.u8(flags >> 8);
      w.u8(flags);
      for (let i = 0; i < n; i++) {
        w.u8(intOp(ops[12 + 2 * i], line, 'a parameter register', 0, 255));
        w.str(strOp(ops[13 + 2 * i], line, 'a parameter name'));
      }
      stack.push({ kind: 'fn', line, sizeAt: [w.n], k: 0, start: w.n + 2 });
      w.u16(0);
    } else if (code === 0x94) {
      need(0);
      stack.push({ kind: 'with', line, sizeAt: [w.n], k: 0, start: w.n + 2 });
      w.u16(0);
    } else if (code === 0x8f) {
      if (ops.length > 1) throw new AsmError(line, 'Try takes the catch variable (a name in quotes or a register) or nothing.');
      const t = ops[0] ? one(ops[0], line, 'the catch variable') : null;
      const reg = t && t.t === 'id' ? regOp(ops[0], line) : null;
      const nameBin = t && t.t === 'str' ? t.v : '';
      if (t && reg == null && t.t !== 'str') throw new AsmError(line, 'The catch variable is a name in quotes or a register.');
      const flagsAt = w.n;
      w.u8(0);
      const sizeAt = [w.n, w.n + 2, w.n + 4];
      w.u16(0);
      w.u16(0);
      w.u16(0);
      if (reg != null) w.u8(reg);
      else w.str(nameBin);
      const entry = { kind: 'try', line, sizeAt, k: 0, start: w.n, flagsAt, flags: reg != null ? 4 : 0 };
      stack.push(entry);
    } else if (code === 0x9a) {
      if (ops.length !== 3) throw new AsmError(line, 'GetURL2 takes the load-variables flag, the load-target flag and the send method.');
      const lv = boolOp(ops[0], line, 'the load-variables flag');
      const lt = boolOp(ops[1], line, 'the load-target flag');
      const t = one(ops[2], line, 'the send method');
      const mth = t.t === 'num' ? Number(t.s) : SEND_VARS.findIndex((x) => x.toLowerCase() === String(t.s ?? '').toLowerCase());
      if (!(mth >= 0 && mth <= 3) || !Number.isInteger(mth)) throw new AsmError(line, 'The send method is 0 (none), 1 (GET) or 2 (POST).');
      w.u8((lv ? 0x80 : 0) | (lt ? 0x40 : 0) | mth);
    } else if (code === 0x9f) {
      if (ops.length < 2 || ops.length > 3) throw new AsmError(line, 'GotoFrame2 takes the scene-bias flag, the play flag and, when the first is true, the scene bias.');
      const bias = boolOp(ops[0], line, 'the scene-bias flag');
      const play = boolOp(ops[1], line, 'the play flag');
      if (bias !== (ops.length === 3)) throw new AsmError(line, bias ? 'GotoFrame2 true, … needs the scene bias as a third value.' : 'GotoFrame2 false, … takes no scene bias.');
      w.u8((play ? 1 : 0) | (bias ? 2 : 0));
      if (bias) w.u16(intOp(ops[2], line, 'the scene bias', 0, 65535));
    }
    const len = w.n - start;
    if (len > 65535) throw new AsmError(line, 'This action is longer than 65535 bytes.');
    w.put16(lenAt, len);
  }
  if (pendingTry) finishTry(pendingTry);
  if (stack.length) {
    const top = stack[stack.length - 1];
    throw new AsmError(top.line, 'This block is not closed with }.');
  }
  for (const f of fixups) {
    if (!labels.has(f.label)) throw new AsmError(f.line, `There is no label ${f.label}.`);
    const off = labels.get(f.label) - f.from;
    if (off < -32768 || off > 32767) throw new AsmError(f.line, `${f.label} is too far away for a branch (${off} bytes).`);
    w.put16(f.at, off & 0xffff);
  }
  if (!noEnd) w.u8(0);
  return w.bytes;
}

// ---------- constant pools ----------

/** The block's constant pools in byte order: `{ pool, offset, strings }` (strings as UTF-8 byte strings). */
export function constantPools(bytes) {
  return readActions(bytes)
    .actions.filter((a) => a.code === 0x88 && !a.raw)
    .map((a, pool) => ({ pool, offset: a.offset, strings: a.pool }));
}

/** The block with string `index` of constant pool `pool` (0-based, byte order) set to `value` (text). */
export function setConstant(bytes, pool, index, value) {
  const bin = utf8Bin(String(value));
  if (bin.includes('\0')) throw new Error('A constant cannot hold a zero character.');
  return assemble(disassemble(bytes).text, { poolEdit: { pool, index, value: bin } });
}

// ---------- action blocks inside tags ----------

export const CLIP_EVENTS = [
  'load', 'enterFrame', 'unload', 'mouseMove', 'mouseDown', 'mouseUp', 'keyDown', 'keyUp', 'data', 'initialize',
  'press', 'release', 'releaseOutside', 'rollOver', 'rollOut', 'dragOver', 'dragOut', 'keyPress', 'construct',
];
const BUTTON_ONLY = new Set(['press', 'release', 'releaseOutside', 'rollOver', 'rollOut', 'dragOver', 'dragOut', 'keyPress', 'construct']);

/** "on(press, release)" or "onClipEvent(load)" for a clip action record's event flags. */
export function clipEventName(flags, keyCode) {
  const ev = CLIP_EVENTS.filter((_, i) => flags & (1 << i));
  const names = ev.map((e) => (e === 'keyPress' && keyCode != null ? `keyPress ${keyCode}` : e));
  return ev.length && ev.every((e) => BUTTON_ONLY.has(e)) ? `on(${names.join(', ')})` : `onClipEvent(${names.join(', ')})`;
}

/** "on(press, release)" for a DefineButton2 condition word (a key press as "keyPress 13"). */
export function buttonConditionName(cond) {
  const names = ['rollOver', 'rollOut', 'press', 'release', 'dragOut', 'dragOver', 'releaseOutside', 'dragOver', 'dragOut'];
  const ev = names.filter((_, i) => cond & (1 << i));
  const key = (cond >> 9) & 0x7f;
  if (key) ev.push(`keyPress ${key}`);
  return `on(${[...new Set(ev)].join(', ')})`;
}

class Bits {
  constructor(b, pos) {
    this.b = b;
    this.p = pos * 8;
  }
  ub(n) {
    let v = 0;
    for (let i = 0; i < n; i++, this.p++) {
      if (this.p >> 3 >= this.b.length) throw BAD;
      v = v * 2 + ((this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1);
    }
    return v;
  }
  get pos() {
    return (this.p + 7) >> 3;
  }
}
function matrixEnd(b, pos) {
  const r = new Bits(b, pos);
  if (r.ub(1)) r.ub(2 * r.ub(5));
  if (r.ub(1)) r.ub(2 * r.ub(5));
  r.ub(2 * r.ub(5));
  return r.pos;
}
function cxformEnd(b, pos, alpha) {
  const r = new Bits(b, pos);
  const add = r.ub(1);
  const mult = r.ub(1);
  const n = r.ub(4);
  r.ub(n * (alpha ? 4 : 3) * (add + mult));
  return r.pos;
}
const FILTER_SIZE = { 0: 23, 1: 9, 2: 15, 3: 27, 6: 80 };
function filtersEnd(b, pos) {
  const n = b[pos++];
  for (let i = 0; i < n; i++) {
    const id = b[pos++];
    if (id in FILTER_SIZE) pos += FILTER_SIZE[id];
    else if (id === 4 || id === 7) pos += 1 + 5 * b[pos] + 19;
    else if (id === 5) pos += 2 + 8 + 4 * b[pos] * b[pos + 1] + 5;
    else throw BAD;
  }
  if (pos > b.length) throw BAD;
  return pos;
}
const cstrEnd = (b, pos) => {
  const z = b.indexOf(0, pos);
  if (z < 0) throw BAD;
  return z + 1;
};
const u16At = (b, p) => b[p] | (b[p + 1] << 8);
const u32At = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;

/**
 * The action blocks in one tag's body (DefineSprite's nested tags are the caller's to walk):
 * `[{ kind, offset, length, name, sizeAt, sizeBytes, sizeExtra, flags?, keyCode?, conditions?, spriteId? }]` with
 * offsets into `data`. Throws on a body it cannot read. `swfVersion` below 6 means 16-bit clip event flags.
 */
export function actionBlocksOfTag(code, data, swfVersion = 10) {
  const b = data;
  const out = [];
  const block = (o) => out.push({ sizeAt: null, sizeBytes: 0, sizeExtra: 0, ...o });
  if (code === 12) block({ kind: 'DoAction', offset: 0, length: b.length, name: 'DoAction' });
  else if (code === 59) {
    if (b.length < 2) throw new Error('DoInitAction is shorter than its sprite id.');
    block({ kind: 'DoInitAction', offset: 2, length: b.length - 2, spriteId: u16At(b, 0), name: `DoInitAction ${u16At(b, 0)}` });
  } else if (code === 7) {
    let p = 2;
    try {
      while (b[p]) p = matrixEnd(b, p + 5);
    } catch (e) {
      if (e !== BAD) throw e;
      p = b.length;
    }
    p++;
    if (p > b.length) throw new Error('DefineButton ends inside its button records.');
    block({ kind: 'DefineButton', offset: p, length: b.length - p, name: 'on(release)' });
  } else if (code === 34) {
    const first = u16At(b, 3);
    if (first) {
      let p = 3 + first;
      for (;;) {
        if (p + 4 > b.length) throw new Error('DefineButton2 ends inside a condition header.');
        const size = u16At(b, p);
        const cond = u16At(b, p + 2);
        const end = size ? p + size : b.length;
        if (end > b.length || (size && size < 4)) throw new Error('A DefineButton2 condition runs past the tag.');
        block({ kind: 'ButtonCondAction', offset: p + 4, length: end - p - 4, conditions: cond, sizeAt: size ? p : null, sizeBytes: 2, sizeExtra: 4, name: buttonConditionName(cond) });
        if (!size) break;
        p = end;
      }
    }
  } else if (code === 26 || code === 70) {
    const f = b[0];
    const f2 = code === 70 ? b[1] : 0;
    let p = code === 26 ? 3 : 4;
    try {
      if (code === 70 && (f2 & 0x08 || (f2 & 0x10 && f & 0x02))) p = cstrEnd(b, p);
      if (f & 0x02) p += 2;
      if (f & 0x04) p = matrixEnd(b, p);
      if (f & 0x08) p = cxformEnd(b, p, true);
      if (f & 0x10) p += 2;
      if (f & 0x20) p = cstrEnd(b, p);
      if (f & 0x40) p += 2;
      if (code === 70) {
        if (f2 & 0x01) p = filtersEnd(b, p);
        if (f2 & 0x02) p++;
        if (f2 & 0x04) p++;
        if (f2 & 0x20) p++;
        if (f2 & 0x40) p += 4;
      }
    } catch (e) {
      if (e !== BAD) throw e;
      throw new Error('The place tag ends inside its fields.');
    }
    if (f & 0x80) {
      const wide = swfVersion >= 6;
      const fw = wide ? 4 : 2;
      p += 2 + fw;
      for (;;) {
        if (p + fw > b.length) throw new Error('The clip actions end without their end flag.');
        const flags = wide ? u32At(b, p) : u16At(b, p);
        if (!flags) break;
        const sizeAt = p + fw;
        const size = u32At(b, sizeAt);
        let q = sizeAt + 4;
        const key = flags & 0x20000 ? b[q++] : null;
        const end = sizeAt + 4 + size;
        if (end > b.length || q > end) throw new Error('A clip action record runs past the tag.');
        block({ kind: 'ClipAction', offset: q, length: end - q, flags, keyCode: key, sizeAt, sizeBytes: 4, sizeExtra: key == null ? 0 : 1, name: clipEventName(flags, key) });
        p = end;
      }
    }
  }
  return out;
}

/** The tag body with `block` (one of actionBlocksOfTag's results) replaced by `bytes`, its size field updated. */
export function replaceActionBlock(data, block, bytes) {
  const out = new Uint8Array(data.length - block.length + bytes.length);
  out.set(data.subarray(0, block.offset));
  out.set(bytes, block.offset);
  out.set(data.subarray(block.offset + block.length), block.offset + bytes.length);
  if (block.sizeAt != null) {
    const v = bytes.length + block.sizeExtra;
    if (block.sizeBytes === 2) {
      if (v > 0xffff) throw new Error('The button condition is longer than 65535 bytes.');
      out[block.sizeAt] = v & 0xff;
      out[block.sizeAt + 1] = v >> 8;
    } else for (let i = 0; i < 4; i++) out[block.sizeAt + i] = (v >>> (8 * i)) & 0xff;
  }
  return out;
}
