// Happy Wars Xbox 360 UI scenes (.tanda, magic "TLAD"), ported from HappyTool/Formats/TandaDocument.cs (Load,
// Parse*, BindSprites, BuildFullReport). Every multi-byte field is big-endian; the Xbox One copies are
// little-endian and the desktop doesn't read them either.

export const WIDGET_NAME_SIZE = 64;
const SPRITE_STRIDE = 24;
const COLOR_STRIDE = 20;
const RESOURCE_STRIDE = 128;
const LEAF_SECTION_TABLE_BYTES = 0x38;
const CHILD_LIST_OFFSET = 0x6c;

let sjisDecoder = null;
try {
  sjisDecoder = new TextDecoder('shift_jis');
} catch {
  sjisDecoder = null;
}

// .NET Framework's Encoding.GetEncoding(932).GetString, which differs from the WHATWG decoder only where a byte is not
// a defined character (checked over every single byte and every two-byte sequence): a lead byte (0x81-0x9F, 0xE0-0xFC)
// takes the next byte with it whatever it is and gives U+30FB '・' when the pair is undefined or the input ends;
// 0xA0 and 0xFD-0xFF are U+F8F0-U+F8F3.
let pairTable = null;
const isLead = (b) => (b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc);
function sjisPairs() {
  if (pairTable) return pairTable;
  pairTable = new Uint16Array(0x10000);
  const two = new Uint8Array(2);
  for (let l = 0x81; l <= 0xfc; l++) {
    if (!isLead(l)) continue;
    two[0] = l;
    for (let t = 0; t < 256; t++) {
      two[1] = t;
      const s = sjisDecoder.decode(two);
      pairTable[(l << 8) | t] = s.length === 1 && s !== '�' ? s.charCodeAt(0) : 0x30fb;
    }
  }
  return pairTable;
}
function decodeCp932(u8) {
  const pairs = sjisPairs();
  let out = '';
  for (let i = 0; i < u8.length; i++) {
    const b = u8[i];
    if (b <= 0x80) out += String.fromCharCode(b);
    else if (b >= 0xa1 && b <= 0xdf) out += String.fromCharCode(0xff61 + b - 0xa1);
    else if (b === 0xa0) out += '';
    else if (b >= 0xfd) out += String.fromCharCode(0xf8f1 + b - 0xfd);
    else if (i + 1 >= u8.length) out += '・';
    else out += String.fromCharCode(pairs[(b << 8) | u8[++i]]);
  }
  return out;
}

// TandaDocument.ReadFixedAscii (Encoding.ASCII turns bytes >= 0x80 into '?').
export function readFixedAscii(d, off, max) {
  if (off < 0 || off >= d.length) return '';
  const end = Math.min(d.length, off + max);
  let n = off;
  while (n < end && d[n] !== 0) n++;
  let s = '';
  for (let i = off; i < n; i++) s += d[i] < 0x80 ? String.fromCharCode(d[i]) : '?';
  return s;
}

function be32(d, o) {
  if (o + 4 > d.length || o < 0) return 0;
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) | 0; // as C#'s (int)BE32
}
function be16(d, o) {
  if (o + 2 > d.length || o < 0) return 0;
  return (d[o] << 8) | d[o + 1];
}
const f32 = new DataView(new ArrayBuffer(4));
function bef(d, o) {
  if (o + 4 > d.length || o < 0) return 0;
  f32.setUint8(0, d[o]);
  f32.setUint8(1, d[o + 1]);
  f32.setUint8(2, d[o + 2]);
  f32.setUint8(3, d[o + 3]);
  return f32.getFloat32(0, false);
}

export function isTlad(u8) {
  return !!u8 && u8.length >= 4 && u8[0] === 0x54 && u8[1] === 0x4c && u8[2] === 0x41 && u8[3] === 0x44;
}

// TandaDocument.Load. Returns the whole document: header fields, widgets (tree), sprites, colors, resources, notes.
export function parseTanda(u8) {
  const d = u8 ?? new Uint8Array(0);
  const doc = {
    data: d,
    isValid: isTlad(d),
    sceneName: '',
    versionMajor: 0,
    versionMinor: 0,
    textCodec: '',
    declaredSize: 0,
    widgetOffset: 0,
    widgetCount: 0,
    spriteOffset: 0,
    spriteCount: 0,
    colorOffset: 0,
    colorCount: 0,
    resourceOffset: 0,
    resourceCount: 0,
    widgets: [],
    sprites: [],
    colors: [],
    resources: [],
    notes: [],
  };
  if (!doc.isValid || d.length < 0x60) {
    doc.notes.push('Missing TLAD magic or header too short.');
    return doc;
  }
  doc.sceneName = readFixedAscii(d, 0x04, 32);
  doc.versionMajor = d[0x24];
  doc.versionMinor = d[0x26];
  doc.textCodec = readFixedAscii(d, 0x28, 16);
  doc.declaredSize = be32(d, 0x3c);
  doc.widgetOffset = be32(d, 0x40);
  doc.widgetCount = be32(d, 0x44);
  doc.spriteOffset = be32(d, 0x48);
  doc.spriteCount = be32(d, 0x4c);
  doc.colorOffset = be32(d, 0x50);
  doc.colorCount = be32(d, 0x54);
  doc.resourceOffset = be32(d, 0x58);
  doc.resourceCount = be32(d, 0x5c);

  parseResources(doc);
  parseColors(doc);
  parseSprites(doc);
  parseWidgets(doc);
  bindSprites(doc);
  return doc;
}

function parseResources(doc) {
  const d = doc.data;
  const off = doc.resourceOffset;
  const count = doc.resourceCount;
  if (count <= 0 || off <= 0 || off >= d.length) return;
  for (let i = 0; i < count; i++) {
    const b = off + i * RESOURCE_STRIDE;
    if (b >= d.length) break;
    doc.resources.push(readFixedAscii(d, b, Math.min(RESOURCE_STRIDE, d.length - b)));
  }
}

function parseColors(doc) {
  const d = doc.data;
  const off = doc.colorOffset;
  const count = doc.colorCount;
  if (count <= 0 || off <= 0 || off + count * COLOR_STRIDE > d.length) return;
  for (let i = 0; i < count; i++) {
    const b = off + i * COLOR_STRIDE;
    doc.colors.push({ index: be32(d, b), width: be16(d, b + 4), height: be16(d, b + 6), r: bef(d, b + 8), g: bef(d, b + 12), b: bef(d, b + 16) });
  }
}

function parseSprites(doc) {
  const d = doc.data;
  const off = doc.spriteOffset;
  const count = doc.spriteCount;
  if (count <= 0 || off <= 0 || off + count * SPRITE_STRIDE > d.length) return;
  for (let i = 0; i < count; i++) {
    const b = off + i * SPRITE_STRIDE;
    doc.sprites.push({
      index: i,
      page: be16(d, b),
      slot: be16(d, b + 2),
      width: be16(d, b + 4),
      height: be16(d, b + 6),
      u0: bef(d, b + 8),
      u1: bef(d, b + 12),
      v0: bef(d, b + 16),
      v1: bef(d, b + 20),
    });
  }
}

function parseWidgets(doc) {
  const d = doc.data;
  const off = doc.widgetOffset;
  let end = doc.spriteOffset > off ? doc.spriteOffset : d.length;
  if (off <= 0 || off >= d.length) return;
  if (end <= off || end > d.length) end = d.length;
  const section = d.subarray(off, end);
  let pos = 0;
  let parsed = 0;
  while (pos + 0x44 <= section.length) {
    const size = be32(section, pos + WIDGET_NAME_SIZE);
    if (size < 0x44 || pos + size > section.length) {
      doc.notes.push(`Widget walk stopped at section+0x${hex(pos)} (size=0x${hex(size)}, remaining=${section.length - pos}).`);
      break;
    }
    doc.widgets.push(parseWidgetNode(section, pos, size, off + pos, 0));
    pos += size;
    parsed++;
  }
  if (parsed !== doc.widgetCount) doc.notes.push(`Header widget count=${doc.widgetCount}, size-walked top-level nodes=${parsed}.`);
  if (pos < section.length) doc.notes.push(`Widget section has ${section.length - pos} trailing byte(s) after last node.`);
}

// int.ToString("X"): two's complement for negatives.
export function hex(v) {
  return (v >>> 0).toString(16).toUpperCase();
}

function parseWidgetNode(blob, baseOff, size, fileOffset, depth) {
  const index = be32(blob, baseOff + 0x44);
  const w = {
    name: readFixedAscii(blob, baseOff, WIDGET_NAME_SIZE),
    fileOffset,
    size,
    depth,
    index,
    spritePage: (index >> 16) & 0xff,
    widgetType: (index >> 8) & 0xff,
    localId: index & 0xff,
    width: be16(blob, baseOff + 0x48),
    height: be16(blob, baseOff + 0x4a),
    frameRate: bef(blob, baseOff + 0x4c),
    unk50: bef(blob, baseOff + 0x50),
    unk54: bef(blob, baseOff + 0x54),
    payloadOff0: be32(blob, baseOff + 0x58),
    payloadOff1: be32(blob, baseOff + 0x5c),
    payloadOff2: be32(blob, baseOff + 0x60),
    childOrSectionOff: be32(blob, baseOff + 0x64),
    childOrSectionCount: be32(blob, baseOff + 0x68),
    isContainer: false,
    isLeaf: false,
    layoutX: 0,
    layoutY: 0,
    halfWidth: 0,
    halfHeight: 0,
    scaleX: 1,
    scaleY: 1,
    sprite: null,
    fontName: '',
    fontSize: 0,
    fontFlags: 0,
    fontR: 1,
    fontG: 1,
    fontB: 1,
    textureUnMerge: false,
    hasFontControl: false,
    hasPattern: false,
    stretchTags: [],
    labels: [],
    children: [],
    sections: [],
    taggedBlocks: [],
    stateTransitions: [],
  };

  // Parent: children packed immediately at +0x6C.
  if (w.childOrSectionOff === CHILD_LIST_OFFSET && w.childOrSectionCount > 0) {
    w.isContainer = true;
    let cpos = baseOff + CHILD_LIST_OFFSET;
    for (let i = 0; i < w.childOrSectionCount; i++) {
      if (cpos + 0x44 > baseOff + size) break;
      const csz = be32(blob, cpos + WIDGET_NAME_SIZE);
      if (csz < 0x44 || cpos + csz > baseOff + size) break;
      w.children.push(parseWidgetNode(blob, cpos, csz, fileOffset + (cpos - baseOff), depth + 1));
      cpos += csz;
    }
    return w;
  }

  // Leaf: local section directory of 0x38 bytes starting at +0x64.
  if (w.childOrSectionOff === LEAF_SECTION_TABLE_BYTES) {
    w.isLeaf = true;
    parseLeafSections(blob, baseOff, size, w);
  }
  extractTaggedBlocks(blob, baseOff, size, w);
  extractFontAndLabels(blob, baseOff, size, w);
  return w;
}

function parseLeafSections(blob, baseOff, size, w) {
  // Seven (relOff, count) pairs at +0x6C; relative offsets are from +0x48.
  for (let i = 0; i < 7; i++) {
    const ent = baseOff + 0x6c + i * 8;
    if (ent + 8 > baseOff + size) break;
    const rel = be32(blob, ent);
    const cnt = be32(blob, ent + 4);
    if (rel === 0 && cnt === 0) continue;
    const abs = (0x48 + rel) | 0;
    if (abs < 0 || abs >= size) continue;
    const avail = Math.min(size - abs, Math.imul(Math.max(cnt, 1), 48)); // C# int arithmetic
    const floats = Math.max(0, Math.trunc(avail / 4));
    const values = new Array(floats);
    for (let k = 0; k < floats; k++) values[k] = bef(blob, baseOff + abs + k * 4);
    w.sections.push({ slot: i, relativeOffset: rel, absoluteOffset: abs, count: cnt, values });
    // sec0: half-extents (size/2); sec3: center position; sec4: scale.
    if (i === 0 && floats >= 3) {
      w.halfWidth = values[1];
      w.halfHeight = values[2];
    }
    if (i === 3 && floats >= 3) {
      w.layoutX = values[1];
      w.layoutY = values[2];
    }
    if (i === 4 && floats >= 3) {
      w.scaleX = values[1];
      w.scaleY = values[2];
    }
  }
}

// TandaDocument.BindSprites: each widget's sprite page against the sprite table (first entry per page).
function bindSprites(doc) {
  const byPage = new Map();
  for (const s of doc.sprites) if (!byPage.has(s.page)) byPage.set(s.page, s);
  for (const w of enumerateWidgets(doc.widgets)) {
    const spr = byPage.get(w.spritePage);
    if (spr) w.sprite = spr;
  }
}

function extractTaggedBlocks(blob, baseOff, size, w) {
  const end = baseOff + size;
  let i = baseOff + 0x6c;
  while (i + 8 < end) {
    // Tagged field: u16 type, u16 flag, then ASCII name (NUL-padded, typically 32 bytes).
    if (blob[i + 2] === 0 && blob[i + 3] <= 9 && blob[i + 4] >= 0x40 && blob[i + 4] < 0x7f) {
      const nameStart = i + 4;
      let nameEnd = nameStart;
      while (nameEnd < end && blob[nameEnd] >= 0x20 && blob[nameEnd] < 0x7f) nameEnd++;
      const nameLen = nameEnd - nameStart;
      if (nameLen >= 4 && nameLen <= 32 && (nameEnd === end || blob[nameEnd] === 0)) {
        let name = '';
        for (let k = nameStart; k < nameEnd; k++) name += String.fromCharCode(blob[k]);
        const block = { offset: i - baseOff, type: be16(blob, i), flag: be16(blob, i + 2), name, stateCount: 0, states: [] };
        const lower = name.toLowerCase();
        if (name === 'State Label') parseStateLabelFollowup(blob, baseOff, size, i, block, w);
        else if (lower.includes('stretch') || lower.includes('strech')) w.stretchTags.push(name);
        else if (name === 'Texture UnMerge') w.textureUnMerge = true;
        else if (name === 'Font Controll' || name === 'Font Control') w.hasFontControl = true;
        else if (name === 'pattern') w.hasPattern = true;
        w.taggedBlocks.push(block);
        i = nameStart + 32;
        continue;
      }
    }
    i++;
  }
}

function parseStateLabelFollowup(blob, baseOff, size, tagOff, block, w) {
  // After the 32-byte name field: u16 type=0x254, u16 count, u32 pad, then count x 0x50 entries:
  // u32 kind, char[32] from, char[32] to, 12 bytes, f32 time.
  if (w.stateTransitions.length > 0) return;
  const afterName = tagOff + 4 + 32;
  const searchEnd = Math.min(baseOff + size, afterName + 0x80);
  for (let p = afterName; p + 8 < searchEnd; p++) {
    if (be16(blob, p) !== 0x254) continue;
    const count = be16(blob, p + 2);
    block.stateCount = count;
    let ent = p + 8;
    for (let s = 0; s < count && ent + 0x50 <= baseOff + size; s++) {
      const st = { kind: be32(blob, ent), from: readFixedAscii(blob, ent + 4, 32), to: readFixedAscii(blob, ent + 36, 32), time: bef(blob, ent + 0x4c) };
      w.stateTransitions.push(st);
      block.states.push(st);
      ent += 0x50;
    }
    break;
  }
}

function sjis(blob, start, len) {
  return decodeCp932(blob.subarray(start, start + len));
}

function extractFontAndLabels(blob, baseOff, size, w) {
  // Font name commonly sits at +0x224 (32-byte ASCII) followed by size/flags + RGB floats.
  if (size >= 0x260) {
    tryReadFontAt(blob, baseOff, 0x224, w);
    if (!w.fontName) tryReadFontAt(blob, baseOff, 0x280, w);
    if (!w.fontName) tryReadFontAt(blob, baseOff, 0x244, w);
  }
  // Shift-JIS / UTF-16 display strings in payload regions.
  for (const po of [w.payloadOff0, w.payloadOff1, w.payloadOff2]) {
    if (po <= 0 || po + 4 >= size) continue;
    if (blob[baseOff + po] === 0 && blob[baseOff + po + 1] >= 0x20 && blob[baseOff + po + 1] < 0x7f) {
      let sb = '';
      for (let k = po; k + 1 < size && k < po + 64; k += 2) {
        const ch = (blob[baseOff + k] << 8) | blob[baseOff + k + 1];
        if (ch === 0) break;
        if (ch < 0x20 || ch > 0xfffd) break;
        sb += String.fromCharCode(ch);
      }
      if (sb.length > 0) w.labels.push(sb);
    } else if (sjisDecoder && blob[baseOff + po] >= 0x80) {
      let end = po;
      while (end < size && end < po + 64 && blob[baseOff + end] !== 0) end++;
      const t = sjis(blob, baseOff + po, end - po);
      if (containsJapanese(t)) w.labels.push(t);
    } else if (blob[baseOff + po] >= 0x40 && blob[baseOff + po] < 0x7f) {
      const s = readFixedAscii(blob, baseOff + po, Math.min(64, size - po));
      if (s.length >= 2 && !looksLikeFont(s) && !isStructuralTag(s)) w.labels.push(s);
    }
  }
  // Also scan for SJIS strings after the transform block.
  if (sjisDecoder) {
    for (let o = 0x100; o + 4 < size; o++) {
      if (blob[baseOff + o] < 0x80) continue;
      if (o > 0 && blob[baseOff + o - 1] !== 0 && blob[baseOff + o - 1] >= 0x20) continue;
      let end = o;
      while (end < size && end < o + 48 && blob[baseOff + end] !== 0) end++;
      if (end - o < 2) continue;
      const t = sjis(blob, baseOff + o, end - o);
      if (containsJapanese(t) && !w.labels.includes(t)) w.labels.push(t);
    }
  }
}

function tryReadFontAt(blob, baseOff, rel, w) {
  if (rel + 40 > w.size) return;
  const b0 = blob[baseOff + rel];
  if (b0 < 0x40 || b0 >= 0x7f) return;
  const name = readFixedAscii(blob, baseOff + rel, 32);
  if (!looksLikeFont(name)) return;
  w.fontName = name;
  w.fontSize = be16(blob, baseOff + rel + 32);
  w.fontFlags = be16(blob, baseOff + rel + 34);
  w.fontR = bef(blob, baseOff + rel + 36);
  w.fontG = bef(blob, baseOff + rel + 40);
  w.fontB = bef(blob, baseOff + rel + 44);
}

function looksLikeFont(s) {
  return (
    s.includes('Gothic') ||
    s.includes('Happiness') ||
    s.includes('Rodin') ||
    s.includes('Mincho') ||
    s.includes('Kurokane') ||
    s.endsWith('-EB') ||
    s.endsWith('-DB') ||
    s.endsWith('-B')
  );
}

function isStructuralTag(s) {
  const l = s.toLowerCase();
  return (
    s === 'State Label' ||
    s === 'Font Controll' ||
    s === 'Font Control' ||
    s === 'pattern' ||
    s === 'Texture UnMerge' ||
    s === 'HLS' ||
    s === 'Follow-up Point' ||
    s === 'Point' ||
    l.startsWith('strech') ||
    l.startsWith('stretch')
  );
}

function containsJapanese(s) {
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if ((c >= 0x3040 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef)) return true;
  }
  return false;
}

export function* enumerateWidgets(list) {
  for (const w of list) {
    yield w;
    yield* enumerateWidgets(w.children);
  }
}

export function countWidgets(list) {
  let n = 0;
  for (const w of list) n += 1 + countWidgets(w.children);
  return n;
}

// .NET Framework float custom format ("0.##" etc.): 7 significant digits first, then half-up rounding to
// `maxDec` places; a value that rounds to zero prints without a sign.
export function netFloat(v, maxDec) {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  if (v === 0) return '0';
  const neg = v < 0;
  const [mant, ex] = Math.abs(v).toExponential(6).split('e');
  const digits = mant.replace('.', '').split('').map(Number); // 7 digits
  const point = parseInt(ex, 10) + 1; // digits before the decimal point
  // Build integer and fraction digit arrays.
  let intD = [];
  let fracD = [];
  for (let i = 0; i < Math.max(point, 0); i++) intD.push(i < digits.length ? digits[i] : 0);
  for (let i = 0; i < -point; i++) fracD.push(0);
  for (let i = Math.max(point, 0); i < digits.length; i++) fracD.push(digits[i]);
  // Round at maxDec.
  if (fracD.length > maxDec) {
    const up = fracD[maxDec] >= 5;
    fracD = fracD.slice(0, maxDec);
    if (up) {
      const all = [...intD, ...fracD];
      let i = all.length - 1;
      while (i >= 0 && all[i] === 9) all[i--] = 0;
      if (i >= 0) all[i]++;
      else all.unshift(1);
      const nInt = all.length - fracD.length;
      intD = all.slice(0, nInt);
      fracD = all.slice(nInt);
    }
  }
  while (fracD.length && fracD[fracD.length - 1] === 0) fracD.pop();
  while (intD.length > 1 && intD[0] === 0) intD.shift();
  if (intD.length === 0) intD = [0];
  const zero = intD.every((x) => x === 0) && fracD.length === 0;
  const s = intD.join('') + (fracD.length ? '.' + fracD.join('') : '');
  return neg && !zero ? '-' + s : s;
}

// .NET Framework Single.ToString() / "R" (what a PropertyGrid shows): G7 when it round-trips, else G9.
export function netFloatR(v) {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  if (v === 0) return '0';
  const p = Math.fround(parseFloat(v.toPrecision(7))) === v ? 7 : 9;
  const [m, e] = Math.abs(v).toExponential(p - 1).split('e');
  const exp = parseInt(e, 10);
  const digits = m.replace('.', '').replace(/0+$/, '') || '0';
  let s;
  if (exp > -5 && exp < p) {
    if (exp >= 0) {
      const int = digits.slice(0, exp + 1).padEnd(exp + 1, '0');
      const frac = digits.slice(exp + 1);
      s = int + (frac ? '.' + frac : '');
    } else s = '0.' + '0'.repeat(-exp - 1) + digits;
  } else s = digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : '') + 'E' + (exp < 0 ? '-' : '+') + String(Math.abs(exp)).padStart(2, '0');
  return (v < 0 ? '-' : '') + s;
}

// TandaFileEditor.ResolveTemplateRef: "_name" -> the top-level widget "name" (or "name 2" -> "name").
export function resolveTemplateRef(doc, refName) {
  if (!refName) return null;
  const key = refName.startsWith('_') ? refName.slice(1) : refName;
  const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
  for (const w of doc.widgets) if (eq(w.name, key) || eq(w.name, refName)) return w;
  const sp = key.indexOf(' ');
  if (sp > 0) {
    const base = key.slice(0, sp);
    for (const w of doc.widgets) if (eq(w.name, base)) return w;
  }
  return null;
}

// TandaFileEditor.FindSceneRoot: the top-level widget named like the scene, else the largest top-level container.
export function findSceneRoot(doc) {
  for (const w of doc.widgets) if (w.name.toLowerCase() === doc.sceneName.toLowerCase()) return w;
  let best = null;
  let bestArea = 0;
  for (const w of doc.widgets) {
    if (!w.isContainer) continue;
    const area = Math.max(1, w.width) * Math.max(1, w.height);
    if (area > bestArea) {
      bestArea = area;
      best = w;
    }
  }
  return best;
}

// Math.Round (banker's) of a float * 255, clamped (TandaColor.Clamp).
function clampByte(f) {
  const x = Math.fround(f * 255);
  let r = Math.round(x);
  if (Math.abs(x % 1) === 0.5) r = 2 * Math.round(x / 2);
  if (Number.isNaN(x)) r = 0;
  return Math.max(0, Math.min(255, r));
}

export function colorRgb(c) {
  return [clampByte(c.r), clampByte(c.g), clampByte(c.b)];
}

export function colorHex(c) {
  return '#' + colorRgb(c).map((v) => v.toString(16).toUpperCase().padStart(2, '0')).join('');
}

const n0 = (v) => v.toLocaleString('en-US');
const padL = (s, n) => String(s).padStart(n);

function dirRow(name, off, count, next) {
  const stride = count > 0 && next > off ? Math.trunc((next - off) / count) : 0;
  return '  ' + name.padEnd(11) + '  ' + ('0x' + hex(off).padStart(6, '0')).padEnd(9) + '  ' + padL(count, 6) + '  ' + padL(stride, 6);
}

// TandaDocument.BuildFullReport (lines joined with \n).
export function buildFullReport(doc) {
  const out = [];
  out.push('Happy Wars UI scene (.tanda / "TLAD") — Xbox 360, big-endian');
  out.push('');
  if (!doc.isValid) {
    out.push('(Not a valid TLAD file.)');
    return out.join('\n') + '\n';
  }
  out.push('Scene name : ' + doc.sceneName);
  out.push('Version    : ' + doc.versionMajor + '.' + doc.versionMinor);
  out.push('Text codec : ' + (doc.textCodec || '(none)'));
  out.push('File size  : ' + n0(doc.data.length) + ' bytes' + (doc.declaredSize > 0 ? ' (header declares ' + n0(doc.declaredSize) + ')' : ''));
  out.push('');
  out.push('Section directory');
  out.push('  Section      Offset     Count   Stride');
  out.push('  -----------  ---------  ------  ------');
  out.push(dirRow('Widgets', doc.widgetOffset, doc.widgetCount, doc.spriteOffset));
  out.push(dirRow('Sprites', doc.spriteOffset, doc.spriteCount, doc.colorOffset));
  out.push(dirRow('Colors', doc.colorOffset, doc.colorCount, doc.resourceOffset));
  out.push(dirRow('Resources', doc.resourceOffset, doc.resourceCount, doc.declaredSize > 0 ? doc.declaredSize : doc.data.length));
  out.push('');
  if (doc.notes.length > 0) {
    out.push('Parse notes');
    for (const n of doc.notes) out.push('  • ' + n);
    out.push('');
  }
  out.push('Resources (' + doc.resources.length + ')');
  doc.resources.forEach((r, i) => out.push('  ' + padL(i, 3) + '  ' + r));
  out.push('');
  out.push('Colors (' + doc.colors.length + ')');
  for (const c of doc.colors)
    out.push(`  ${padL(c.index, 3)}  ${c.width}x${c.height}  (${netFloat(c.r, 2)}, ${netFloat(c.g, 2)}, ${netFloat(c.b, 2)})  ${colorHex(c)}`);
  out.push('');
  out.push('Sprites (' + doc.sprites.length + ')');
  out.push('  Idx   Page  Slot  W     H     U0     U1     V0     V1     Resource');
  for (const s of doc.sprites) {
    const res = s.slot >= 0 && s.slot < doc.resources.length ? doc.resources[s.slot] : '';
    out.push(
      '  ' + padL(s.index, 4) + '  ' + padL(s.page, 4) + '  ' + padL(s.slot, 4) + '  ' + padL(s.width, 4) + '  ' + padL(s.height, 4) + '  ' +
        padL(netFloat(s.u0, 3), 5) + '  ' + padL(netFloat(s.u1, 3), 5) + '  ' + padL(netFloat(s.v0, 3), 5) + '  ' + padL(netFloat(s.v1, 3), 5) + '  ' + res,
    );
  }
  out.push('');
  out.push('Widget tree (' + doc.widgets.length + ' top-level, ' + countWidgets(doc.widgets) + ' total nodes)');
  for (const w of doc.widgets) widgetReport(out, w, 0);
  return out.join('\n') + '\n';
}

function widgetReport(out, w, depth) {
  const pad = ' '.repeat(depth * 2);
  let line = `${pad}${w.name}  [0x${hex(w.fileOffset)} size=0x${hex(w.size)} idx=${w.index} ${w.width}x${w.height}]`;
  if (w.isContainer) line += '  children=' + w.children.length;
  if (w.isLeaf) line += '  leaf';
  line += '  type=' + w.widgetType + ' page=' + w.spritePage;
  if (w.sprite) line += ` spr=${w.sprite.index} ${w.sprite.width}x${w.sprite.height}`;
  if (w.fontName) line += '  font=' + w.fontName + '@' + w.fontSize;
  if (w.stateTransitions.length > 0) line += '  states=' + w.stateTransitions.length;
  if (w.labels.length > 0) line += '  label="' + w.labels[0] + '"';
  if (w.layoutX !== 0 || w.layoutY !== 0 || w.halfWidth !== 0 || w.halfHeight !== 0)
    line += `  pos=(${netFloat(w.layoutX, 1)},${netFloat(w.layoutY, 1)}) size=(${netFloat(Math.fround(w.halfWidth * 2), 1)}x${netFloat(Math.fround(w.halfHeight * 2), 1)})`;
  out.push(line);
  for (const st of w.stateTransitions) out.push(`${pad}    ${st.from} → ${st.to}  t=${netFloat(st.time, 3)}  kind=${st.kind}`);
  for (const c of w.children) widgetReport(out, c, depth + 1);
}
