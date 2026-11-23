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
