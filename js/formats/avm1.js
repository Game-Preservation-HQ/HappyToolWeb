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

// ---------- decompiler: read-only ActionScript 2 ----------

const PROPS = ['_x', '_y', '_xscale', '_yscale', '_currentframe', '_totalframes', '_alpha', '_visible', '_width', '_height', '_rotation', '_target', '_framesloaded', '_name', '_droptarget', '_url', '_highquality', '_focusrect', '_soundbuftime', '_quality', '_xmouse', '_ymouse'];
const IDENT = /^[A-Za-z_$][\w$]*$/;
const PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const IND = '   ';
// operator precedence, higher binds tighter
const P = { assign: 1, cond: 2, or: 3, and: 4, bor: 5, bxor: 6, band: 7, eq: 8, rel: 9, shift: 10, add: 11, mul: 12, unary: 13, post: 14, call: 15, prim: 16 };
const BINARY = {
  0x0a: ['+', P.add], 0x0b: ['-', P.add], 0x0c: ['*', P.mul], 0x0d: ['/', P.mul], 0x0e: ['==', P.eq], 0x0f: ['<', P.rel],
  0x10: ['&&', P.and], 0x11: ['||', P.or], 0x13: ['eq', P.eq], 0x21: ['add', P.add], 0x29: ['lt', P.rel], 0x3f: ['%', P.mul],
  0x47: ['+', P.add], 0x48: ['<', P.rel], 0x49: ['==', P.eq], 0x54: ['instanceof', P.rel], 0x60: ['&', P.band], 0x61: ['|', P.bor],
  0x62: ['^', P.bxor], 0x63: ['<<', P.shift], 0x64: ['>>', P.shift], 0x65: ['>>>', P.shift], 0x66: ['===', P.eq], 0x67: ['>', P.rel], 0x68: ['gt', P.rel],
};
const NEGATED = { '==': '!=', '!=': '==', '===': '!==', '!==': '===', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };
// one-operand actions written as a call, and statements with no operands
const UNARY_CALL = { 0x14: 'length', 0x18: 'int', 0x30: 'random', 0x31: 'mblength', 0x32: 'ord', 0x33: 'chr', 0x36: 'mbord', 0x37: 'mbchr', 0x45: 'targetPath', 0x4a: 'Number', 0x4b: 'String' };
const PLAIN = { 0x04: 'nextFrame', 0x05: 'prevFrame', 0x06: 'play', 0x07: 'stop', 0x08: 'toggleHighQuality', 0x09: 'stopAllSounds', 0x28: 'stopDrag' };
// DefineFunction2 registers filled before the parameters, in register order from 1
const PRELOADS = [[0x0100, 'this'], [0x0400, 'arguments'], [0x1000, 'super'], [0x4000, '_root'], [0x8000, '_parent'], [0x0001, '_global']];

class Unstructured extends Error {}
const fail = (why) => {
  throw new Unstructured(why);
};
const wrap = (e, p) => (e.p < p ? `(${e.s})` : e.s);
const node = (s, p = P.prim, extra) => ({ s, p, ...extra });
const binary = (op, p, a, b) => ({ s: `${wrap(a, p)} ${op} ${wrap(b, p + 1)}`, p, op, a, b });
function notOf(e) {
  if (NEGATED[e.op]) return { ...binary(NEGATED[e.op], e.p, e.a, e.b), negOf: e };
  return { s: `!${wrap(e, P.unary)}`, p: P.unary, not: e };
}
// the condition under which an If does not branch
const negate = (c) => c.not ?? c.negOf ?? notOf(c);
const strNode = (bin) => node(quote(bin), P.prim, { lit: true, str: binText(bin) });
const numNode = (v) => node(Number.isNaN(v) ? 'NaN' : String(v), v < 0 ? P.unary : P.prim, { lit: true, num: v });
const ITER = node('(for-in name)', P.prim, { iter: true });
const ind = (stmts) => stmts.flat().map((l) => IND + l);
const stmt = (lines, props) => Object.assign(lines.flatMap((l) => l.split('\n')), props);
const member = (o, n) => (n.str != null && IDENT.test(n.str) ? `${wrap(o, P.call)}.${n.str}` : `${wrap(o, P.call)}[${n.s}]`);
const varName = (n) => (n.str != null && PATH.test(n.str) ? n.str : null);

/** Registers and declarations of one function body (or of the block's top level). */
class Scope {
  constructor(names, local) {
    this.names = names;
    this.local = local;
    this.declared = new Set();
    this.alias = new Map();
    this.pending = [];
  }
  name(r) {
    return this.names[r] ?? `_loc${r}_`;
  }
  read(r) {
    if (this.alias.has(r)) return this.alias.get(r);
    // a local register read before anything is stored in it is declared where it is first used
    if (this.local && this.names[r] == null && !this.declared.has(r)) {
      this.declared.add(r);
      this.pending.push(`var ${this.name(r)};`);
    }
    return node(this.name(r), P.prim, { pure: true, reg: r });
  }
  write(r) {
    this.alias.delete(r);
    if (this.names[r] == null && !this.declared.has(r)) {
      this.declared.add(r);
      return `var ${this.name(r)}`;
    }
    return this.name(r);
  }
}

/**
 * ActionScript 2 for an action block, for reading: if/else, while, do-while, for-in, with, try, functions,
 * conditional expressions and && / || are rebuilt from the branches; local registers read as _locN_ (or their
 * parameter names). A body whose branches do not form those structures is shown as its p-code in comments instead.
 */
export function decompile(bytes) {
  const d = disassemble(bytes);
  const all = d.actions;
  const at = new Map(all.map((a, i) => [a.offset, i]));
  const poolOf = new Map();
  let pool = null;
  for (const a of all) {
    if (a.code === 0x88 && !a.raw) pool = a.pool;
    poolOf.set(a, pool);
  }
  const pcode = d.text.split('\n');

  // the actions of the body [s, e); a nested body is the one action of its container
  function listOf(s, e) {
    const out = [];
    let i = at.get(s) ?? all.length;
    while (i < all.length && all[i].offset < e) {
      const a = all[i++];
      if (a.code !== 0 || a.line) out.push(a);
      if (a.ends) {
        const last = a.ends[a.ends.length - 1];
        while (i < all.length && all[i].offset < last) i++;
      }
    }
    return out;
  }
  function fallback(why, a) {
    let lines = pcode;
    if (a) {
      lines = [];
      for (let k = a.line, depth = 0; k < pcode.length; k++) {
        const t = pcode[k].trim();
        if (t === '}' && depth === 0) break;
        if (t.endsWith('{')) depth++;
        else if (t === '}') depth--;
        lines.push(t);
      }
    }
    return [`// not decompiled (${why}); its p-code:`, ...lines.filter((l) => l.trim()).map((l) => `// ${l.trim()}`)];
  }
  function fnLines(a) {
    const names = [];
    let params;
    if (a.code === 0x8e) {
      let r = 1;
      for (const [bit, n] of PRELOADS) if (a.flags & bit) names[r++] = n;
      params = a.params.map((p) => {
        const n = binText(p.name);
        if (p.register) names[p.register] = n;
        return n;
      });
    } else params = a.params.map(binText);
    const head = `function${a.fname ? ` ${binText(a.fname)}` : ''}(${params.join(', ')})`;
    let lines;
    try {
      lines = body(new Scope(names, a.code === 0x8e), listOf(a.offset + a.size, a.ends[0]), [a.ends[0]]);
    } catch (e) {
      if (!(e instanceof Unstructured)) throw e;
      lines = fallback(e.message, a);
    }
    return [head, '{', ...ind(lines), '}'];
  }

  function body(fn, list, endOffs) {
    const stop = list.length;
    const idx = new Map(list.map((a, i) => [a.offset, i]));
    for (const e of endOffs) if (!idx.has(e)) idx.set(e, stop);
    const tgt = (i) => {
      const a = list[i];
      const t = idx.get(a.offset + a.size + a.branch);
      return t ?? fail(`a branch to ${a.offset + a.size + a.branch} lands outside its body`);
    };
    // for each loop head, the last backward branch to it
    const backFrom = new Map();
    list.forEach((a, i) => {
      if ((a.code === 0x99 || a.code === 0x9d) && !a.raw) {
        const t = tgt(i);
        if (t <= i) backFrom.set(t, Math.max(backFrom.get(t) ?? -1, i));
      }
    });
    // values left on the stack past `base` are shown as statements
    const spill = (r, base) => {
      for (const v of r.stack.splice(base)) if (!v.lit && !v.pure && !v.iter && !v.enumOf) r.stmts.push(stmt([`${v.s};`]));
    };
    const isPushNull = (a) => a?.code === 0x96 && !a.raw && a.values.length === 1 && a.values[0].t === 2;

    // Statements for list[lo, hi). `join` is where control goes after hi; `skip` is a loop head already being built.
    function run(lo, hi, stack, loop, skip, join) {
      const out = [];
      const flush = () => {
        if (fn.pending.length) out.push(...fn.pending.splice(0).map((l) => [l]));
      };
      const emit = (lines, props) => {
        flush();
        out.push(stmt(lines, props));
      };
      const emitWith = (pre, lines, props) => {
        out.push(...pre.map((l) => [l]));
        emit(lines, props);
      };
      const pop = () => (stack.length ? stack.pop() : fail(`the stack is empty at ${list[i]?.name} ${list[i]?.offset}`));
      const count = () => {
        const c = pop();
        return Number.isInteger(c.num) && c.num >= 0 ? c.num : fail('a count that is not a number');
      };
      // a function written as an argument ends its line, as FFDec writes it
      const args = () => Array.from({ length: count() }, () => pop()).map((v) => (v.fn ? `${v.s}\n` : v.s)).join(',');
      const after = (x) => (x === hi ? join : x);
      const eff = (t) => (t > hi && t === join ? hi : t);
      const isLoopJump = (t) => loop && (t === loop.cont || t === loop.back);

      function loopAt(h, back) {
        const brk = back + 1;
        // Push null; Equals2; Not; If (itself): what a break or return out of a for-in leaves to clear the enumeration
        if (back === h + 3 && isPushNull(list[h]) && list[h + 1].code === 0x49 && list[h + 2].code === 0x12) return brk;
        const pre = fn.pending.splice(0);
        if (list[back].code === 0x9d) {
          const r = run(h, back, [...stack], { brk, cont: -1, back }, h, back);
          if (r.stack.length !== stack.length + 1) fail('a do-while without its condition');
          const c = r.stack.pop();
          emitWith(pre, ['do', '{', ...ind(r.stmts), '}', `while(${c.s});`]);
          return brk;
        }
        const top = stack[stack.length - 1];
        if (top?.enumOf && list[h].code === 0x87 && !list[h].raw && list[h].args[0] === 0 && isPushNull(list[h + 1]) && list[h + 2]?.code === 0x49 && list[h + 3]?.code === 0x9d && tgt(h + 3) === brk) {
          stack.pop();
          fn.alias.set(0, ITER);
          const r = run(h + 4, back, [], { brk, cont: h, back }, -1, back);
          fn.alias.delete(0);
          if (!r.stmts[0]?.forVar) fail('a for-in loop without its variable');
          emitWith(pre, [`for(${r.stmts[0].forVar} in ${top.enumOf.s})`, '{', ...ind(r.stmts.slice(1)), '}']);
          return brk;
        }
        let k = h;
        while (k < back && !(list[k].code === 0x9d && tgt(k) === brk)) k++;
        if (k < back) {
          const saved = new Set(fn.declared);
          const c = run(h, k, [...stack], null, h, k);
          if (!c.stmts.length && c.stack.length === stack.length + 1) {
            const cond = negate(c.stack.pop());
            const r = run(k + 1, back, [...stack], { brk, cont: h, back }, -1, back);
            emitWith(pre, [`while(${cond.s})`, '{', ...ind(r.stmts), '}']);
            return brk;
          }
          fn.declared = saved;
          fn.pending.length = 0;
        }
        const r = run(h, back, [...stack], { brk, cont: h, back }, h, back);
        emitWith(pre, ['while(true)', '{', ...ind(r.stmts), '}']);
        return brk;
      }

      // switch: subject; StoreRegister R; v1; StrictEquals; If case1; Push registerR, v2; StrictEquals; If case2; …;
      // Jump default-or-end; case bodies in order (a break is a Jump to the end). Returns the index after it, or null.
      function switchAt(s) {
        const R = list[s].args[0];
        const subj = stack[stack.length - 1];
        const mark = node(subj.s, subj.p, { pure: true });
        const cases = [];
        let k = s + 1;
        const saved = fn.alias.get(R);
        try {
          for (;;) {
            let q = k;
            while (q + 1 < hi && !(list[q].code === 0x66 && list[q + 1].code === 0x9d)) q++;
            if (q + 1 >= hi) return null;
            if (cases.length) fn.alias.set(R, mark);
            const r = run(k, q, cases.length ? [] : [mark], null, -1, q);
            if (r.stmts.length || r.stack.length !== 2 || r.stack[0] !== mark) return null;
            cases.push({ v: r.stack[1], t: tgt(q + 1) });
            k = q + 2;
            if (list[k]?.code === 0x99) break;
            const p = list[k];
            if (!(p?.code === 0x96 && p.values[0]?.t === 4 && p.values[0].v === R)) return null;
          }
        } catch (e) {
          if (e instanceof Unstructured) return null;
          throw e;
        } finally {
          if (saved) fn.alias.set(R, saved);
          else fn.alias.delete(R);
        }
        const D = eff(tgt(k));
        if (D <= k || D > hi || cases.some((x, n) => x.t <= k || x.t > D || (n && x.t < cases[n - 1].t))) return null;
        let end = D;
        for (let x = k + 1; x < D; x++) {
          if (list[x].code !== 0x99 || list[x].raw) continue;
          const t = eff(tgt(x));
          if (t > end && t <= hi) end = t;
        }
        stack.pop();
        const sw = { brk: end, cont: loop?.cont ?? -1, back: loop?.back ?? -1 };
        const part = (from, to) => ind(ind(run(from, to, [...stack], sw, -1, to).stmts));
        const lines = [`switch(${subj.s})`, '{'];
        for (let n = 0; n < cases.length; n++) {
          lines.push(`${IND}case ${cases[n].v.s}:`);
          const to = n + 1 < cases.length ? cases[n + 1].t : D;
          if (to > cases[n].t) lines.push(...part(cases[n].t, to));
        }
        if (end > D) lines.push(`${IND}default:`, ...part(D, end));
        lines.push('}');
        emitWith(fn.pending.splice(0), lines);
        return end;
      }

      let i = lo;
      while (i < hi) {
        const a = list[i];
        if (a.raw) fail(`${a.name} at ${a.offset} could not be read`);
        const back = i === skip ? undefined : backFrom.get(i);
        if (back != null && back < hi) {
          i = loopAt(i, back);
          continue;
        }
        const next = list[i + 1] && i + 1 < hi ? list[i + 1] : null;
        const c = a.code;
        if (c === 0x9d) {
          const t = eff(tgt(i));
          const cond = pop();
          if (t <= i) {
            if (!isLoopJump(t)) fail('a backward If outside a loop');
            emit([`if(${cond.s})`, '{', `${IND}continue;`, '}']);
            i++;
            continue;
          }
          // a && b, a || b: a; PushDuplicate; [Not;] If L; Pop; b; L:
          const dup = i > lo && (list[i - 1].code === 0x4c || (list[i - 1].code === 0x12 && i - 1 > lo && list[i - 2].code === 0x4c));
          if (dup && next?.code === 0x17 && t <= hi) {
            const left = pop();
            const and = cond.not === left || cond.negOf === left;
            if (!and && cond !== left) fail('a short-circuit without its operand');
            const r = run(i + 2, t, [...stack], loop, -1, after(t));
            if (r.stmts.length || r.stack.length !== stack.length + 1) fail(`a short-circuit right side at ${a.offset}`);
            stack.push(binary(and ? '&&' : '||', and ? P.and : P.or, left, r.stack.pop()));
            i = t;
            continue;
          }
          if (t > hi) {
            const what = loop && t === loop.brk ? 'break' : isLoopJump(t) ? 'continue' : fail(`a branch out of its block at ${a.offset}`);
            emit([`if(${cond.s})`, '{', `${IND}${what};`, '}']);
            i++;
            continue;
          }
          let thenEnd = t;
          let elseEnd = -1;
          const j = list[t - 1];
          if (t - 1 > i && j.code === 0x99 && !j.raw) {
            const e = eff(tgt(t - 1));
            // a then-part that ends in a jump out of the loop or switch is a break, not an else
            if (e > t && e <= hi && !(loop && tgt(t - 1) === loop.brk)) [thenEnd, elseEnd] = [t - 1, e];
          }
          const pre = fn.pending.splice(0);
          const end = elseEnd >= 0 ? elseEnd : t;
          const yes = run(i + 1, thenEnd, [...stack], loop, -1, after(end));
          const no = elseEnd >= 0 ? run(t, elseEnd, [...stack], loop, -1, after(end)) : null;
          const shown = negate(cond);
          if (no && !yes.stmts.length && !no.stmts.length && yes.stack.length === stack.length + 1 && no.stack.length === stack.length + 1) {
            fn.pending.unshift(...pre);
            stack.push(node(`${wrap(shown, P.or)} ? ${wrap(yes.stack.pop(), P.assign)} : ${wrap(no.stack.pop(), P.assign)}`, P.cond));
            i = end;
            continue;
          }
          // values a branch leaves behind (the Flash compiler leaves the results of a class body's calls on the stack)
          for (const r of no ? [yes, no] : [yes]) {
            if (r.stack.length < stack.length) fail(`an if whose branch takes values from before it at ${a.offset}`);
            spill(r, stack.length);
          }
          const lines = [`if(${shown.s})`, '{', ...ind(yes.stmts), '}'];
          if (no && no.stmts.length === 1 && no.stmts[0].isIf) lines.push(`else ${no.stmts[0][0]}`, ...no.stmts[0].slice(1));
          else if (no) lines.push('else', '{', ...ind(no.stmts), '}');
          emitWith(pre, lines, { isIf: true });
          i = end;
          continue;
        }
        if (c === 0x99) {
          const t = eff(tgt(i));
          if (t === hi && i === hi - 1) {
            i++;
            continue;
          }
          if (loop && t === loop.brk) emit(['break;']);
          else if (isLoopJump(t)) {
            if (!(i === hi - 1 && after(hi) === loop.back)) emit(['continue;']);
          } else fail('a jump that is not part of a structure');
          i++;
          continue;
        }
        if (c === 0x9b || c === 0x8e) {
          const f = fnLines(a);
          if (a.fname) emit(f);
          else stack.push(node(f.join('\n'), P.prim, { fn: true }));
          i++;
          continue;
        }
        if (c === 0x94) {
          const obj = pop();
          emit([`with(${obj.s})`, '{', ...ind(body(fn, listOf(a.offset + a.size, a.ends[0]), [a.ends[0]])), '}']);
          i++;
          continue;
        }
        if (c === 0x8f) {
          const ends = a.ends;
          const part = (s, e) => ind(body(fn, listOf(s, e), ends));
          const lines = ['try', '{', ...part(a.offset + a.size, ends[0]), '}'];
          if (a.tflags & 1) lines.push(`catch(${a.tflags & 4 ? fn.name(a.catchRegister) : binText(a.catchName)})`, '{', ...part(ends[0], ends[1]), '}');
          if (a.tflags & 2) lines.push('finally', '{', ...part(ends[1], ends[2]), '}');
          emit(lines);
          i++;
          continue;
        }
        if (c === 0x87) {
          const r = a.args[0];
          const v = stack.length ? stack[stack.length - 1] : fail(`the stack is empty at ${a.name} ${a.offset}`);
          const sw = next?.code === 0x17 ? null : switchAt(i);
          if (sw != null) {
            i = sw;
            continue;
          }
          if (next?.code === 0x17) {
            stack.pop();
            const name = fn.write(r);
            emit([`${name} = ${v.s};`], v.iter ? { forVar: name } : undefined);
            i += 2;
            continue;
          }
          fn.alias.delete(r);
          if (v.pure || v.lit) fn.alias.set(r, v);
          else {
            stack.pop();
            emit([`${fn.write(r)} = ${v.s};`]);
            stack.push(fn.read(r));
          }
          i++;
          continue;
        }
        step(a, next);
        i += a.code === 0x81 || a.code === 0x8c ? (next?.code === 0x06 ? 2 : 1) : 1;
      }
      return { stmts: out, stack };

      // x = x + 1 is x++; with the old value of x still on the stack it is that value's expression, x++
      function postfix(target, op) {
        const top = stack[stack.length - 1];
        if (top && !top.lit && top.s === target) stack[stack.length - 1] = node(`${target}${op}`, P.post);
        else emit([`${target}${op};`]);
      }

      // an action that is not a branch or a body
      function step(a, next) {
        const c = a.code;
        if (c in BINARY) {
          const b = pop();
          const x = pop();
          if (c === 0x0b && x.lit && x.num === 0 && x.s === '0') stack.push(node(`- ${wrap(b, P.unary)}`, P.unary));
          else stack.push(binary(...BINARY[c], x, b));
          return;
        }
        if (c in UNARY_CALL) return void stack.push(node(`${UNARY_CALL[c]}(${pop().s})`, P.call));
        if (c in PLAIN) return void emit([`${PLAIN[c]}();`]);
        switch (c) {
          case 0x00:
          case 0x88:
          case 0x89:
            return;
          case 0x96:
            for (const v of a.values) {
              if (v.t === 0) stack.push(strNode(v.v));
              else if (v.t === 1 || v.t === 6) {
                if (v.t === 1) f64.setUint32(0, v.v);
                else (f64.setUint32(0, v.hi), f64.setUint32(4, v.lo));
                stack.push(numNode(v.t === 1 ? f64.getFloat32(0) : f64.getFloat64(0)));
              } else if (v.t === 2) stack.push(node('null', P.prim, { lit: true }));
              else if (v.t === 3) stack.push(node('undefined', P.prim, { lit: true, undef: true }));
              else if (v.t === 4) stack.push(fn.read(v.v));
              else if (v.t === 5) stack.push(node(v.v ? 'true' : 'false', P.prim, { lit: true, num: v.v ? 1 : 0 }));
              else if (v.t === 7) stack.push(numNode(v.v));
              else {
                const s = poolOf.get(a)?.[v.v];
                stack.push(s == null ? fail(`constant ${v.v} is past the pool`) : strNode(s));
              }
            }
            return;
          case 0x17: {
            // the Flash compiler leaves a Pop of nothing after each class's package checks; the player pops undefined
            if (!stack.length) return;
            const v = pop();
            if (!v.lit && !v.pure && !v.iter) emit([`${v.s};`]);
            return;
          }
          case 0x4c: {
            const v = pop();
            stack.push(v, v);
            return;
          }
          case 0x4d: {
            const v = pop();
            const w = pop();
            stack.push(v, w);
            return;
          }
          case 0x12:
            return void stack.push(notOf(pop()));
          case 0x50:
          case 0x51: {
            const x = pop();
            return void stack.push({ ...binary(c === 0x50 ? '+' : '-', P.add, x, numNode(1)), inc: c === 0x50 ? '++' : '--', of: x });
          }
          case 0x44:
            return void stack.push(node(`typeof ${wrap(pop(), P.unary)}`, P.unary));
          case 0x1c: {
            const n = pop();
            const name = varName(n);
            return void stack.push(name ? node(name, P.prim, { pure: true }) : node(`eval(${n.s})`, P.call));
          }
          case 0x1d: {
            const v = pop();
            const n = pop();
            const name = varName(n);
            if (!name) return void emit([`set(${n.s},${v.s});`]);
            if (v.inc && v.of.s === name) return postfix(name, v.inc);
            return void emit([`${name} = ${v.s};`], v.iter ? { forVar: name } : undefined);
          }
          case 0x3c: {
            const v = pop();
            const name = varName(pop()) ?? fail('a local with a name that is not a name');
            return void emit([`var ${name} = ${v.s};`], v.iter ? { forVar: `var ${name}` } : undefined);
          }
          case 0x41:
            return void emit([`var ${varName(pop()) ?? fail('a local with a name that is not a name')};`]);
          case 0x4e: {
            const n = pop();
            return void stack.push(node(member(pop(), n), P.call));
          }
          case 0x4f: {
            const v = pop();
            const n = pop();
            const target = member(pop(), n);
            if (v.inc && v.of.s === target) return postfix(target, v.inc);
            return void emit([`${target} = ${v.s};`], v.iter ? { forVar: target } : undefined);
          }
          case 0x3a: {
            const n = pop();
            return void stack.push(node(`delete ${member(pop(), n)}`, P.unary));
          }
          case 0x3b: {
            const n = pop();
            return void stack.push(node(`delete ${varName(n) ?? n.s}`, P.unary));
          }
          case 0x3d: {
            const n = pop();
            return void stack.push(node(`${varName(n) ?? `eval(${n.s})`}(${args()})`, P.call));
          }
          case 0x52:
          case 0x53: {
            const n = pop();
            const o = pop();
            const callee = n.undef || n.str === '' ? wrap(o, P.call) : member(o, n);
            return void stack.push(node(`${c === 0x53 ? 'new ' : ''}${callee}(${args()})`, P.call));
          }
          case 0x40: {
            const n = pop();
            return void stack.push(node(`new ${varName(n) ?? `eval(${n.s})`}(${args()})`, P.call));
          }
          case 0x42:
            return void stack.push(node(`[${args()}]`));
          case 0x43: {
            const n = count();
            const pairs = [];
            for (let k = 0; k < n; k++) {
              const v = pop();
              const name = pop();
              pairs.unshift(`${name.str != null && IDENT.test(name.str) ? name.str : name.s}:${v.s}`);
            }
            return void stack.push(node(`{${pairs.join(',')}}`));
          }
          case 0x46:
            return void stack.push(node('(enumeration)', P.prim, { enumOf: node(varName(pop()) ?? fail('an enumeration of a name that is not a name')) }));
          case 0x55:
            return void stack.push(node('(enumeration)', P.prim, { enumOf: pop() }));
          case 0x15:
          case 0x35: {
            const n = pop();
            const k = pop();
            return void stack.push(node(`${c === 0x15 ? 'substring' : 'mbsubstring'}(${pop().s},${k.s},${n.s})`, P.call));
          }
          case 0x34:
            return void stack.push(node('getTimer()', P.call));
          case 0x22: {
            const p = PROPS[pop().num] ?? fail('an unknown property');
            // the property of this clip (an empty target) reads as the property's name
            const t = pop();
            return void stack.push(t.str === '' ? node(p, P.prim, { pure: true }) : node(`getProperty(${t.s},${p})`, P.call));
          }
          case 0x23: {
            const v = pop();
            const p = PROPS[pop().num] ?? fail('an unknown property');
            const t = pop();
            return void emit([t.str === '' ? `${p} = ${v.s};` : `setProperty(${t.s},${p},${v.s});`]);
          }
          case 0x24: {
            const depth = pop();
            const target = pop();
            return void emit([`duplicateMovieClip(${pop().s},${target.s},${depth.s});`]);
          }
          case 0x25:
            return void emit([`removeMovieClip(${pop().s});`]);
          case 0x26:
            return void emit([`trace(${pop().s});`]);
          case 0x27: {
            const target = pop();
            const lock = pop();
            const constrain = pop();
            if (!constrain.num) return void emit([`startDrag(${target.s},${lock.s});`]);
            const [y2, x2, y1, x1] = [pop(), pop(), pop(), pop()];
            return void emit([`startDrag(${target.s},${lock.s},${x1.s},${y1.s},${x2.s},${y2.s});`]);
          }
          case 0x2a:
            return void emit([`throw ${pop().s};`]);
          case 0x3e:
            return void emit([`return ${pop().s};`]);
          case 0x2b: {
            const o = pop();
            return void stack.push(node(`${wrap(pop(), P.call)}(${o.s})`, P.call));
          }
          case 0x2c: {
            const cls = pop();
            return void emit([`${cls.s} implements ${args().split(',').join(', ')};`]);
          }
          case 0x69: {
            const sup = pop();
            return void emit([`${pop().s} extends ${sup.s};`]);
          }
          case 0x2d:
            return void stack.push(node(`FSCommand2(${args()})`, P.call));
          case 0x81:
            return void emit([`${next?.code === 0x06 ? 'gotoAndPlay' : 'gotoAndStop'}(${a.args[0] + 1});`]);
          case 0x8c:
            return void emit([`${next?.code === 0x06 ? 'gotoAndPlay' : 'gotoAndStop'}(${quote(a.args[0])});`]);
          case 0x9f: {
            const f = pop();
            const frame = a.gflags & 2 ? `${wrap(f, P.add)} + ${a.sceneBias}` : f.s;
            return void emit([`${a.gflags & 1 ? 'gotoAndPlay' : 'gotoAndStop'}(${frame});`]);
          }
          case 0x83:
            return void emit([`getURL(${quote(a.args[0])},${quote(a.args[1])});`]);
          case 0x9a: {
            const target = pop();
            const url = pop();
            const m = a.uflags & 3 ? `,"${SEND_VARS[a.uflags & 3]}"` : '';
            const f = a.uflags & 0x80 ? (a.uflags & 0x40 ? 'loadVariables' : 'loadVariablesNum') : a.uflags & 0x40 ? 'loadMovie' : 'getURL';
            return void emit([`${f}(${url.s},${target.s}${m});`]);
          }
          case 0x9e:
            return void emit([`call(${pop().s});`]);
          default:
            fail(`${a.name} is not decompiled`);
        }
      }
    }

    const r = run(0, stop, [], null, -1, stop);
    spill(r, 0);
    if (fn.pending.length) r.stmts.push(...fn.pending.splice(0).map((l) => [l]));
    return r.stmts.flat();
  }

  const top = new Scope([], false);
  let lines;
  try {
    const last = all[all.length - 1];
    lines = body(top, listOf(0, Infinity), [bytes.length, ...(last && !last.line ? [last.offset] : [])]);
  } catch (e) {
    if (!(e instanceof Unstructured)) throw e;
    lines = fallback(e.message, null);
  }
  return lines.join('\n');
}
