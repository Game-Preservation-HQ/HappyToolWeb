// Standalone .rra animation clips (magic 0x013290DD), ported from HappyTool/Formats/RraDocument.cs (Load,
// SampleTrack, Nlerp) and HappyRraCatalog.IsStandaloneRra. FMC catalogs and CMF clips aren't read here; the
// player's clips in motion/player.bres are all standalone.

export const RRA_MAGIC = 0x013290dd;
const BONE_TABLE = 0xd0;
const BONE_STRIDE = 160;
const BONE_NAME = 0x80;
const KEY_STRIDE = 20;
const CHANNELS = 3; // 0 position, 1 rotation, 2 scale

function ascii(u8, o, max) {
  if (o < 0 || o >= u8.length) return '';
  const end = Math.min(u8.length, o + max);
  let n = o;
  while (n < end && u8[n] !== 0) n++;
  let s = '';
  for (let i = o; i < n; i++) s += String.fromCharCode(u8[i] & 0x7f);
  return s;
}

// HappyRraCatalog.IsStandaloneRra
export function isStandaloneRra(u8) {
  if (!u8 || u8.length < BONE_TABLE + BONE_STRIDE) return false;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== RRA_MAGIC) return false;
  const tag = ascii(u8, 0x20, 16);
  if (tag.startsWith('anm.') || tag.toLowerCase().endsWith('.rra')) return true;
  const bones = dv.getInt32(0xa4, true);
  const frames = dv.getInt32(0xb0, true);
  return bones > 0 && bones <= 512 && frames > 0 && frames <= 10000 && u8.length >= BONE_TABLE + bones * BONE_STRIDE;
}

// RraDocument.Load for a standalone clip. Returns null when it isn't one; otherwise
// { name, typeTag, version, declaredSize, frameCount, keyCount, bones: [{ name, tracks: [keys | null] x3 }], notes }
// where keys is an array of { frame, x, y, z, w }.
export function parseRra(u8, name = '') {
  if (!isStandaloneRra(u8)) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const le32 = (o) => (o + 4 > u8.length ? 0 : dv.getInt32(o, true));
  const lef = (o) => (o + 4 > u8.length ? 0 : dv.getFloat32(o, true));
  const clip = {
    name,
    typeTag: ascii(u8, 0x20, 16),
    version: le32(0x08),
    declaredSize: le32(0x0c),
    boneCount: le32(0xa4),
    frameCount: le32(0xb0),
    keyCount: 0,
    bones: [],
    notes: [],
  };
  if (clip.boneCount <= 0 || clip.boneCount > 512) {
    clip.notes.push('Unreasonable bone count: ' + clip.boneCount);
    clip.boneCount = 0;
    return clip;
  }
  const pool = BONE_TABLE + clip.boneCount * BONE_STRIDE;
  if (pool > u8.length) {
    clip.notes.push('Bone table exceeds file length.');
    return clip;
  }
  let total = 0;
  const ranges = [];
  for (let i = 0; i < clip.boneCount; i++) {
    const o = BONE_TABLE + i * BONE_STRIDE;
    const r = [];
    for (let ch = 0; ch < CHANNELS; ch++) {
      const start = le32(o + 0x80 + ch * 8);
      const count = le32(o + 0x80 + ch * 8 + 4);
      r.push([start, count]);
      if (count > 0) {
        if (start < 0 || count < 0 || start + count < start) clip.notes.push(`bone ${i} channel ${ch}: bad range`);
        else total = Math.max(total, start + count);
      }
    }
    ranges.push(r);
    clip.bones.push({ name: ascii(u8, o, BONE_NAME) || 'bone_' + i, tracks: [null, null, null] });
  }
  if (pool + total * KEY_STRIDE > u8.length) {
    clip.notes.push(`Keyframe pool truncated: need ${pool + total * KEY_STRIDE} bytes, have ${u8.length}.`);
    total = Math.max(0, Math.floor((u8.length - pool) / KEY_STRIDE));
  }
  clip.keyCount = total;
  for (let i = 0; i < clip.bones.length; i++) {
    for (let ch = 0; ch < CHANNELS; ch++) {
      const [start, count] = ranges[i][ch];
      if (count <= 0) continue;
      const n = Math.min(count, Math.max(0, total - start));
      const keys = new Array(n);
      for (let k = 0; k < n; k++) {
        const ko = pool + (start + k) * KEY_STRIDE;
        keys[k] = { frame: le32(ko), x: lef(ko + 4), y: lef(ko + 8), z: lef(ko + 12), w: lef(ko + 16) };
      }
      clip.bones[i].tracks[ch] = keys;
    }
  }
  return clip;
}

// RraDocument.SampleTrack: [x, y, z, w] at a frame, or null for an empty track. Rotation (channel 1) is nlerped.
export function sampleTrack(keys, frame, channel) {
  if (!keys || keys.length === 0) return null;
  const k0 = keys[0];
  if (keys.length === 1 || frame <= k0.frame) return [k0.x, k0.y, k0.z, k0.w];
  const kl = keys[keys.length - 1];
  if (frame >= kl.frame) return [kl.x, kl.y, kl.z, kl.w];
  let hi = 1;
  while (hi < keys.length && keys[hi].frame < frame) hi++;
  const a = keys[hi - 1];
  const b = keys[hi];
  const t = b.frame > a.frame ? (frame - a.frame) / (b.frame - a.frame) : 0;
  const lerp = (p, q) => p + (q - p) * t;
  if (channel !== 1) return [lerp(a.x, b.x), lerp(a.y, b.y), lerp(a.z, b.z), lerp(a.w, b.w)];
  const s = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1;
  const x = lerp(a.x, s * b.x);
  const y = lerp(a.y, s * b.y);
  const z = lerp(a.z, s * b.z);
  const w = lerp(a.w, s * b.w);
  const len = Math.sqrt(x * x + y * y + z * z + w * w);
  return len > 1e-8 ? [x / len, y / len, z / len, w / len] : [x, y, z, w];
}

// ---------- The animation viewer's full document (RraDocument with its CMF and FMC forms) ----------
// The exports above stay as they are for the stage play test; what follows is the desktop's RraDocument.Load,
// LoadFromCmf, InferParents and BuildReport, used by views/rra-view.js.

const CHANNEL_NAMES = ['Position', 'Rotation', 'Scale'];
const f32 = Math.fround;

// Encoding.ASCII.GetString of a zero-terminated name: bytes over 0x7F become '?'.
function netAscii(u8, o, max) {
  if (o < 0 || o >= u8.length) return '';
  const end = Math.min(u8.length, o + max);
  let s = '';
  for (let i = o; i < end && u8[i] !== 0; i++) s += u8[i] < 0x80 ? String.fromCharCode(u8[i]) : '?';
  return s;
}

/** HappyRraCatalog.IsFmcMotion: a pak motion catalog blob ("FMC\x01"). */
export const isFmcMotion = (u8) => !!u8 && u8.length >= 8 && u8[0] === 0x46 && u8[1] === 0x4d && u8[2] === 0x43 && u8[3] === 1;
/** HappyCmfCatalog.IsCmf: a gimmick clip ("CMF\x01", at least 0xA0 bytes). */
export const isCmf = (u8) => !!u8 && u8.length >= 0xa0 && u8[0] === 0x43 && u8[1] === 0x4d && u8[2] === 0x46 && u8[3] === 1;
/** HappyRraCatalog.IsAnimationPayload: what the desktop opens in its animation player. */
export const isAnimationPayload = (u8) => isStandaloneRra(u8) || isFmcMotion(u8) || isCmf(u8);

function newDoc(u8, name) {
  return { data: u8, isValid: false, isFmc: false, isCmf: false, typeTag: '', name: name ?? '', declaredSize: 0, versionField: 0, boneCount: 0, frameCount: 0, keyframePoolOffset: 0, keyframeCount: 0, bones: [], notes: [], fmcName: '', fmcFrameCount: 0 };
}
const track = (ch, start = 0, count = 0) => ({ channel: ch, channelName: CHANNEL_NAMES[ch], startIndex: start, count, keys: [] });

/**
 * RraDocument.Load: a standalone .rra, a CMF clip or an FMC catalog blob. Bones are { index, name, fileOffset,
 * parentIndex, tracks: [position, rotation, scale] } with tracks { channel, channelName, startIndex, count, keys }.
 */
export function loadRraDocument(u8, fallbackName = '') {
  const doc = newDoc(u8 ?? new Uint8Array(0), fallbackName);
  const d = doc.data;
  if (isFmcMotion(d)) {
    doc.isFmc = true;
    doc.isValid = true;
    const fmc = d.length >= 12 + 64 ? netAscii(d, 12, 64) : null;
    doc.fmcName = fmc ?? doc.name;
    doc.fmcFrameCount = d.length >= 6 ? (d[4] << 8) | d[5] : 0;
    doc.frameCount = doc.fmcFrameCount;
    doc.name = doc.fmcName ? doc.fmcName : doc.name;
    doc.notes.push('FMC motion-catalog blob (pak layout). Standalone anm.rra keyframe decode does not apply.');
    return doc;
  }
  if (isCmf(d)) {
    loadCmf(doc, doc.name, null, null);
    return doc;
  }
  if (!isStandaloneRra(d) || d.length < BONE_TABLE + BONE_STRIDE) {
    doc.notes.push('Not a Happy Wars .rra / .cmf clip or FMC catalog.');
    return doc;
  }
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const le32 = (o) => (o + 4 > d.length ? 0 : dv.getInt32(o, true));
  const lef = (o) => (o + 4 > d.length ? 0 : dv.getFloat32(o, true));
  doc.isValid = true;
  doc.typeTag = netAscii(d, 0x20, 16);
  doc.versionField = le32(0x08);
  doc.declaredSize = le32(0x0c);
  doc.boneCount = le32(0xa4);
  doc.frameCount = le32(0xb0);
  if (doc.boneCount <= 0 || doc.boneCount > 512) {
    doc.notes.push('Unreasonable bone count: ' + doc.boneCount);
    doc.boneCount = 0;
    return doc;
  }
  if (BONE_TABLE + doc.boneCount * BONE_STRIDE > d.length) {
    doc.notes.push('Bone table exceeds file length.');
    return doc;
  }
  doc.keyframePoolOffset = BONE_TABLE + doc.boneCount * BONE_STRIDE;
  let totalKeys = 0;
  for (let i = 0; i < doc.boneCount; i++) {
    const o = BONE_TABLE + i * BONE_STRIDE;
    const bone = { index: i, name: netAscii(d, o, BONE_NAME) || 'bone_' + i, fileOffset: o, parentIndex: -1, tracks: [null, null, null] };
    for (let ch = 0; ch < CHANNELS; ch++) {
      const start = le32(o + 0x80 + ch * 8);
      const count = le32(o + 0x80 + ch * 8 + 4);
      bone.tracks[ch] = track(ch, start, count);
      if (count > 0) {
        // C# int arithmetic: start + count wraps at 32 bits.
        if (start < 0 || count < 0 || ((start + count) | 0) < start) doc.notes.push(`${bone.name}.${CHANNEL_NAMES[ch]}: bad range start=${start} count=${count}`);
        else totalKeys = Math.max(totalKeys, (start + count) | 0);
      }
    }
    doc.bones.push(bone);
  }
  doc.keyframeCount = totalKeys;
  const need = (doc.keyframePoolOffset + Math.imul(totalKeys, KEY_STRIDE)) | 0;
  if (need > d.length) {
    doc.notes.push(`Keyframe pool truncated: need ${need} bytes, have ${d.length}.`);
    doc.keyframeCount = Math.max(0, Math.trunc((d.length - doc.keyframePoolOffset) / KEY_STRIDE));
  }
  for (const bone of doc.bones)
    for (const t of bone.tracks) {
      if (t.count <= 0) continue;
      const n = Math.min(t.count, Math.max(0, doc.keyframeCount - t.startIndex));
      t.keys = new Array(n);
      for (let k = 0; k < n; k++) {
        const ko = doc.keyframePoolOffset + (t.startIndex + k) * KEY_STRIDE;
        t.keys[k] = { frame: le32(ko), x: lef(ko + 4), y: lef(ko + 8), z: lef(ko + 12), w: lef(ko + 16) };
      }
      t.count = n;
    }
  const trail = d.length - (doc.keyframePoolOffset + doc.keyframeCount * KEY_STRIDE);
  if (trail > 16) doc.notes.push(`${trail} trailing byte(s) after keyframe pool.`);
  inferParents(doc);
  return doc;
}

// RraDocument.InferParents: a best-effort hierarchy from the player and gimmick bone names.
function inferParents(doc) {
  const byName = new Map();
  doc.bones.forEach((b, i) => byName.set(b.name.toLowerCase(), i));
  const has = (n) => byName.has(n.toLowerCase());
  const lo = (s) => s.toLowerCase();
  doc.bones.forEach((b, i) => {
    const n = b.name;
    const l = lo(n);
    let parent = null;
    if (l === 'hips') parent = null;
    else if (l.endsWith('bone') && n.length > 4) parent = n.slice(0, -4);
    else if (l.startsWith('left') || l.startsWith('right')) {
      const side = l.startsWith('left') ? 'Left' : 'Right';
      if (l.endsWith('upleg')) parent = has('Hipsbone') ? 'Hipsbone' : 'Hips';
      else if (l.endsWith('leg')) parent = side + 'UpLeg';
      else if (l.endsWith('foot') || l.endsWith('toe')) parent = side + 'Leg';
      else if (l.endsWith('arm') && !n.includes('Fore')) parent = 'Spine1';
      else if (n.includes('ForeArm')) parent = side + 'Arm';
      else if (n.includes('Hand')) parent = side + 'ForeArm';
      else if (n.includes('Weapon2')) parent = side + 'ForeArm';
      else if (n.includes('Weapon')) parent = side + 'ForeArm';
      else if (n.includes('Shoulder')) parent = 'Spine1';
    } else if (l === 'spine') parent = has('Hipsbone') ? 'Hipsbone' : 'Hips';
    else if (l.startsWith('spine') && n.length > 5) parent = 'Spine';
    else if (l === 'head' || l === 'neck') parent = has('Spine1') ? 'Spine1' : 'Spine';
    const pi = parent != null ? byName.get(parent.toLowerCase()) : undefined;
    b.parentIndex = pi !== undefined && pi !== i ? pi : -1;
  });
}

/** RraDocument.LoadCmf: a CMF clip with bone names and parents from its sibling .cjf (parseCjf), when there is one. */
export function loadCmfDocument(u8, fallbackName = null, boneNames = null, parents = null) {
  const doc = newDoc(u8 ?? new Uint8Array(0), fallbackName ?? '');
  if (!isCmf(doc.data)) doc.notes.push('Not a Happy Wars .cmf clip (CMF\\x01).');
  else loadCmf(doc, fallbackName, boneNames, parents);
  return doc;
}

// RraDocument.LoadFromCmf: frames u16 @4, bones u16 @6, name @0x0C, rotation / position / scale blocks @0x94/0x98/0x9C.
function loadCmf(doc, fallbackName, boneNames, parents) {
  const d = doc.data;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const u16 = (o) => dv.getUint16(o, true);
  const u32 = (o) => dv.getUint32(o, true) | 0;
  const frames = u16(4);
  const bones = u16(6);
  if (frames <= 0 || frames > 10000 || bones <= 0 || bones > 512) {
    doc.notes.push(`Unreasonable CMF header: frames=${frames} bones=${bones}`);
    return;
  }
  const rotOff = u32(0x94);
  const posOff = u32(0x98);
  const sclOff = u32(0x9c);
  if (rotOff < 0xa0 || posOff <= rotOff || sclOff <= posOff || sclOff >= d.length) {
    const h = (v) => (v >>> 0).toString(16).toUpperCase();
    doc.notes.push(`CMF section offsets look wrong: rot=0x${h(rotOff)} pos=0x${h(posOff)} scl=0x${h(sclOff)}`);
    return;
  }
  const clipName = netAscii(d, 0x0c, 0x40);
  if (clipName) doc.name = clipName;
  else if (!doc.name) doc.name = fallbackName ?? 'clip';
  doc.isCmf = true;
  doc.isValid = true;
  doc.typeTag = 'cmf';
  doc.frameCount = frames;
  doc.boneCount = bones;
  doc.declaredSize = d.length;
  doc.keyframePoolOffset = 0;

  const span = (tableOff, i, endOff) => {
    if (tableOff < 0 || i < 0 || i >= bones || tableOff + (i + 1) * 4 > d.length) return null;
    const rel = u32(tableOff + i * 4);
    if (rel === 0) return null;
    const start = tableOff + rel;
    if (start < tableOff || start + 4 > d.length) return null;
    let end = i + 1 < bones ? tableOff + u32(tableOff + (i + 1) * 4) : endOff > 0 ? Math.min(endOff, d.length) : d.length;
    if (end < start) end = d.length;
    return [start, end];
  };
  const read = (ch, tableOff, i, endOff) => {
    const t = track(ch);
    const s = span(tableOff, i, endOff);
    if (!s) return t;
    const [start, end] = s;
    let count = u16(start);
    if (count <= 0 || count > 10000) return t;
    const stride = ch === 1 ? 8 : 12;
    const framePtr = start + 2;
    let valuePtr = (framePtr + count * 2 + 3) & ~3;
    if (valuePtr + count * stride > d.length) valuePtr = framePtr + count * 2;
    count = Math.min(count, Math.max(0, Math.trunc((Math.min(end, d.length) - valuePtr) / stride)));
    const keys = [];
    for (let k = 0; k < count; k++) {
      if (framePtr + k * 2 + 2 > d.length || valuePtr + k * stride + stride > d.length) break;
      const v = valuePtr + k * stride;
      const frame = u16(framePtr + k * 2);
      if (ch === 1) {
        const q = f32(1 / 32767);
        keys.push({ frame, x: f32(dv.getInt16(v, true) * q), y: f32(dv.getInt16(v + 2, true) * q), z: f32(dv.getInt16(v + 4, true) * q), w: f32(dv.getInt16(v + 6, true) * q) });
      } else keys.push({ frame, x: dv.getFloat32(v, true), y: dv.getFloat32(v + 4, true), z: dv.getFloat32(v + 8, true), w: 1 });
    }
    keys.sort((a, b) => a.frame - b.frame);
    t.keys = keys;
    t.count = keys.length;
    return t;
  };
  for (let i = 0; i < bones; i++) {
    const name = (boneNames && i < boneNames.length && boneNames[i]) || 'bone_' + i;
    const parentIndex = parents && i < parents.length ? parents[i] : i === 0 ? -1 : i === 1 ? 0 : 1;
    const bone = { index: i, name, fileOffset: 0, parentIndex, tracks: [read(0, posOff, i, sclOff), read(1, rotOff, i, posOff), read(2, sclOff, i, d.length)] };
    if (bone.tracks[2].keys.length === 0) bone.tracks[2] = { ...track(2, 0, 1), keys: [{ frame: 0, x: 1, y: 1, z: 1, w: 1 }] };
    doc.bones.push(bone);
  }
  doc.keyframeCount = doc.bones.reduce((n, b) => n + b.tracks.reduce((m, t) => m + t.keys.length, 0), 0);
  doc.notes.push('Decoded from CMF\\x01 gimmick clip (quantized i16 rotations, f32 pos/scale).');
}

/** CjfDocument: a gimmick skeleton ("CJF\x01") giving a CMF clip its bone names and parents. */
export function parseCjf(u8) {
  const doc = { isValid: false, rootName: '', boneNames: [], parents: [] };
  if (!u8 || u8.length < 0x44 || u8[0] !== 0x43 || u8[1] !== 0x4a || u8[2] !== 0x46 || u8[3] !== 1) return doc;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  doc.rootName = netAscii(u8, 4, 32);
  const count = dv.getInt32(0x24, true);
  const nameOff = dv.getInt32(0x2c, true);
  if (count <= 0 || count > 512 || nameOff < 0 || nameOff + count * 0x24 > u8.length) return doc;
  doc.isValid = true;
  for (let i = 0; i < count; i++) {
    doc.boneNames.push(netAscii(u8, nameOff + i * 0x24 + 4, 32) || 'joint_' + i);
    doc.parents.push(-1);
  }
  // A child list (1, 2, 3, ... count-1) after the names, or no parents at all, both mean root -> bone 1 -> the rest.
  const afterNames = nameOff + count * 0x24;
  const regionEnd = dv.getInt32(0x34, true);
  let chain = false;
  if (regionEnd > afterNames && regionEnd <= u8.length && regionEnd - afterNames >= 8 && count >= 2)
    for (let o = afterNames; o + 4 <= regionEnd && !chain; o += 2) {
      if (dv.getInt16(o, true) !== 1) continue;
      let p = o + 2;
      let match = true;
      for (let expect = 2; expect < count; expect++, p += 2)
        if (p + 2 > regionEnd || dv.getInt16(p, true) !== expect) { match = false; break; }
      chain = match;
    }
  if (chain || !doc.parents.some((v) => v >= 0)) {
    doc.parents[0] = -1;
    if (count > 1) doc.parents[1] = 0;
    for (let i = 2; i < count; i++) doc.parents[i] = 1;
  }
  return doc;
}

/** RraDocument.Sample: [x, y, z, w] of a bone's channel at a (fractional) frame, or null when the track is empty. */
export function sampleBone(doc, boneIndex, channel, frame) {
  const b = doc.bones[boneIndex];
  return b ? sampleTrack(b.tracks[channel]?.keys, frame, channel) : null;
}

const n0 = (v) => v.toLocaleString('en-US');
const truncName = (s, n) => (!s ? '' : s.length <= n ? s : s.slice(0, n - 1) + '…');

/** RraDocument.BuildReport. */
export function rraReport(doc) {
  const L = [];
  if (doc.isFmc) {
    L.push('Happy Wars motion catalog (FMC) — pak-embedded blob', '', 'Name   : ' + doc.fmcName, 'Frames : ' + doc.fmcFrameCount, 'Size   : ' + n0(doc.data.length) + ' bytes', '');
    L.push('This is the runtime catalog form used inside player .pak/.pack archives.', 'Standalone disk .rra files use the anm.rra keyframe layout instead.');
    return L.join('\n') + '\n';
  }
  L.push(doc.isCmf ? 'Happy Wars gimmick animation (.cmf / "CMF\\x01") — little-endian' : 'Happy Wars animation (.rra / "anm.rra") — little-endian', '');
  if (!doc.isValid) {
    L.push('(Not a recognised animation payload.)');
    return L.join('\n') + '\n';
  }
  L.push('Name        : ' + (doc.name || '(unnamed)'));
  L.push('Type tag    : ' + doc.typeTag);
  L.push('Version fld : ' + doc.versionField);
  L.push('File size   : ' + n0(doc.data.length) + ' bytes' + (doc.declaredSize > 0 ? ' (header ' + n0(doc.declaredSize) + ')' : ''));
  L.push('Frames      : ' + doc.frameCount);
  L.push('Bones       : ' + doc.bones.length);
  L.push('Keyframes   : ' + doc.keyframeCount + '  (@ 0x' + doc.keyframePoolOffset.toString(16).toUpperCase() + ', 20 bytes each)', '');
  if (doc.notes.length) L.push('Parse notes', ...doc.notes.map((n) => '  • ' + n), '');
  L.push('Bones', '  Idx  Name              Parent       Pos   Rot   Scl', '  ---  ----------------  -----------  ----  ----  ----');
  for (const b of doc.bones) {
    const parent = b.parentIndex >= 0 && b.parentIndex < doc.bones.length ? doc.bones[b.parentIndex].name : '-';
    const c = (ch) => String(b.tracks[ch]?.count ?? 0).padStart(4);
    L.push('  ' + String(b.index).padStart(3) + '  ' + truncName(b.name, 16).padEnd(16) + '  ' + truncName(parent, 11).padEnd(11) + '  ' + c(0) + '  ' + c(1) + '  ' + c(2));
  }
  return L.join('\n') + '\n';
}
