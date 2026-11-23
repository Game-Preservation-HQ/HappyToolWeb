// Skinned character models and posing, ported from HappyTool/Formats/PlayerMotionPreviewAssets.cs (the Steam
// skeleton table, TrsMatrix, Mul4, InvertRigidOrIdentity, TryReadSkinStreams, TryReadBoneTableFromRrm,
// TryLoadSkinnedFromBundleFile) and HappyTool/GUI/StageViewerForm.PlayAvatar.cs (ClipMap, SampleLocal, PoseAvatar
// and the skinning in DrawAvatar). Matrices are column-major Float32Array(16), the same memory as the desktop's
// float[]; OpenTK's row-vector products there are written here as the column-major products they equal.

import { sampleTrack } from './rra.js';

const BONE_STRIDE = 224;
// HappyTool/RrmConvert/RrmBoneTable.cs: the 16-bone Steam player skeleton (224-byte records).
const STEAM_TABLE_B64 = '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';

export function identity4() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

// PlayerMotionPreviewAssets.TrsMatrix
export function trs(px, py, pz, qx, qy, qz, qw) {
  const xx = qx * qx, yy = qy * qy, zz = qz * qz;
  const xy = qx * qy, xz = qx * qz, yz = qy * qz;
  const wx = qw * qx, wy = qw * qy, wz = qw * qz;
  return Float32Array.of(
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
    px, py, pz, 1,
  );
}

// PlayerMotionPreviewAssets.Mul4 (a * b, column-major)
export function mul4(a, b) {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let row = 0; row < 4; row++)
      r[c * 4 + row] = a[row] * b[c * 4] + a[4 + row] * b[c * 4 + 1] + a[8 + row] * b[c * 4 + 2] + a[12 + row] * b[c * 4 + 3];
  return r;
}

// PlayerMotionPreviewAssets.InvertRigidOrIdentity
export function invertRigid(m) {
  const tx = m[12], ty = m[13], tz = m[14];
  return Float32Array.of(
    m[0], m[4], m[8], 0,
    m[1], m[5], m[9], 0,
    m[2], m[6], m[10], 0,
    -(m[0] * tx + m[1] * ty + m[2] * tz), -(m[4] * tx + m[5] * ty + m[6] * tz), -(m[8] * tx + m[9] * ty + m[10] * tz), 1,
  );
}

export const transformPoint = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
export const transformVector = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z,
  m[1] * x + m[5] * y + m[9] * z,
  m[2] * x + m[6] * y + m[10] * z,
];

// The FK walk shared by the bone tables: each bone's world after its parent's; unresolved bones get identity.
function bindWorlds(local, parents) {
  const n = local.length;
  const world = new Array(n).fill(null);
  for (let guard = 0; guard < n * 2; guard++) {
    let progress = false;
    for (let i = 0; i < n; i++) {
      if (world[i]) continue;
      const p = parents[i];
      if (p >= 0 && !world[p]) continue;
      world[i] = p < 0 ? Float32Array.from(local[i]) : mul4(world[p], local[i]);
      progress = true;
    }
    if (!progress) break;
  }
  return world.map((w) => w || identity4());
}

// A 224-byte-record bone table: name (up to 64 ASCII), position at +0x80, quaternion at +0x90, parent at +0xB0.
function readBoneTable(u8, off, count) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const names = [];
  const parents = [];
  const local = [];
  for (let i = 0; i < count; i++) {
    const o = off + i * BONE_STRIDE;
    let e = o;
    while (e < o + 64 && u8[e] !== 0) e++;
    let name = '';
    for (let k = o; k < e; k++) name += String.fromCharCode(u8[k] & 0x7f);
    names.push(name);
    const f = (k) => dv.getFloat32(o + k, true);
    let p = dv.getInt32(o + 0xb0, true);
    if (p < 0 || p >= count) p = -1;
    parents.push(p);
    local.push(trs(f(0x80), f(0x84), f(0x88), f(0x90), f(0x94), f(0x98), f(0x9c)));
  }
  return { names, parents, bindWorld: bindWorlds(local, parents) };
}

let steam = null;
// ReadBoneNames / ReadBoneParents / ComputeBindWorlds on RrmBoneTable.Data
export function steamSkeleton() {
  if (steam) return steam;
  const bin = atob(STEAM_TABLE_B64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  steam = readBoneTable(u8, 0, Math.floor(u8.length / BONE_STRIDE));
  // The desktop reads names with ASCII and keeps empty ones; the table has none.
  return steam;
}

// TryReadBoneTableFromRrm: a model's own skeleton (gimmicks), table at u32 0xAC, count at u32 0x14C.
export function readRrmBoneTable(u8) {
  if (!u8 || u8.length < 0x150) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const count = dv.getUint32(0x14c, true);
  const tbl = dv.getUint32(0xac, true);
  if (count === 0 || count > 256 || tbl === 0) return null;
  if (tbl + count * BONE_STRIDE > u8.length) return null;
  const t = readBoneTable(u8, tbl, count);
  t.names = t.names.map((n, i) => n || 'bone_' + i);
  return t;
}

function validSkinPair(u8, dv, bw, bi, vc) {
  if (bw < 0 || bi < 0 || vc <= 0) return false;
  if (bw + vc * 16 > u8.length || bi + vc * 4 > u8.length) return false;
  const sample = Math.min(vc, 64);
  let goodW = 0;
  let goodI = 0;
  for (let v = 0; v < sample; v++) {
    let sum = 0;
    let ok = true;
    for (let s = 0; s < 4; s++) {
      const w = dv.getFloat32(bw + v * 16 + s * 4, true);
      if (Number.isNaN(w) || w < -0.05 || w > 1.05) ok = false;
      sum += w;
      const idx = u8[bi + v * 4 + s];
      if (idx <= 15 || idx === 0xff) goodI++;
    }
    if (ok && sum > 0.85 && sum < 1.15) goodW++;
  }
  return goodW >= Math.floor((sample * 3) / 4) && goodI >= Math.floor((sample * 4 * 3) / 4);
}

// TryReadSkinStreams: { indices: Uint8Array(vc*4), weights: Float32Array(vc*4), at } or { error }.
// Weights (vc x 4 f32) and then indices (vc x 4 u8) follow the positions; else the header's 0x168 / 0x16C, else
// those plus 16 x 12.
export function readSkinStreams(u8) {
  if (!u8 || u8.length < 0x170) return { error: 'RRM too small for skin header.' };
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const vc = dv.getUint32(0x164, true);
  const bones = dv.getUint32(0x14c, true);
  const base = dv.getUint32(0xb4, true);
  const hbw = dv.getUint32(0x168, true);
  const hbi = dv.getUint32(0x16c, true);
  if (vc < 1 || vc > 100000 || bones === 0) return { error: 'RRM has no bone skinning.' };
  const tries = [
    ['after positions', base + vc * 12, base + vc * 12 + vc * 16],
    ['header', hbw, hbi],
    ['header + 192', hbw + 192, hbi + 192],
  ];
  const hit = tries.find(([, bw, bi]) => validSkinPair(u8, dv, bw, bi, vc));
  if (!hit) return { error: 'Could not locate bone weight/index streams.' };
  const [at, bw, bi] = hit;
  const weights = new Float32Array(vc * 4);
  const indices = new Uint8Array(vc * 4);
  for (let v = 0; v < vc; v++)
    for (let s = 0; s < 4; s++) {
      weights[v * 4 + s] = dv.getFloat32(bw + v * 16 + s * 4, true);
      indices[v * 4 + s] = u8[bi + v * 4 + s];
    }
  return { indices, weights, at };
}

// The skinning half of TryLoadSkinnedFromBundleFile, on an already parsed mesh (parseRrm) and its RRM bytes:
// { mesh, indices, weights, names, parents, bindWorld, bindInverse, note }. A mesh without skin streams follows
// bone 0 rigidly. useSteam takes the Steam player skeleton; otherwise the model's own table, else bones guessed
// from the indices with identity binds.
export function skinnedModel(mesh, u8, useSteam) {
  const vc = Math.floor(mesh.positions.length / 3);
  let { indices, weights, error } = readSkinStreams(u8);
  let note = '';
  if (!indices) {
    indices = new Uint8Array(vc * 4).fill(0xff);
    weights = new Float32Array(vc * 4);
    for (let v = 0; v < vc; v++) {
      indices[v * 4] = 0;
      weights[v * 4] = 1;
    }
    if (error) note = 'Rigid mesh (no skin streams): ' + error;
  }
  let sk = useSteam ? steamSkeleton() : readRrmBoneTable(u8);
  if (!sk) {
    let max = 0;
    for (const b of indices) if (b !== 0xff && b > max) max = b;
    const n = Math.max(1, max + 1);
    sk = {
      names: Array.from({ length: n }, (_, i) => (i === 0 ? 'null' : 'bone_' + i)),
      parents: new Array(n).fill(-1),
      bindWorld: Array.from({ length: n }, identity4),
    };
  }
  return {
    mesh,
    indices,
    weights,
    names: sk.names,
    parents: sk.parents,
    bindWorld: sk.bindWorld,
    bindInverse: sk.bindWorld.map(invertRigid),
    note,
  };
}

// OpenTK Quaternion.Slerp (as PoseAvatar's cross-fade uses it).
function slerp(a, b, t) {
  const la = a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3];
  const lb = b[0] * b[0] + b[1] * b[1] + b[2] * b[2] + b[3] * b[3];
  if (la === 0) return lb === 0 ? [0, 0, 0, 1] : b.slice();
  if (lb === 0) return a.slice();
  let cos = a[3] * b[3] + a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (cos >= 1 || cos <= -1) return a.slice();
  let q = b;
  if (cos < 0) {
    q = [-b[0], -b[1], -b[2], -b[3]];
    cos = -cos;
  }
  let wa;
  let wb;
  if (cos < 0.99) {
    const half = Math.acos(cos);
    const inv = 1 / Math.sin(half);
    wa = Math.sin(half * (1 - t)) * inv;
    wb = Math.sin(half * t) * inv;
  } else {
    wa = 1 - t;
    wb = t;
  }
  const r = [wa * a[0] + wb * q[0], wa * a[1] + wb * q[1], wa * a[2] + wb * q[2], wa * a[3] + wb * q[3]];
  const l = r[0] * r[0] + r[1] * r[1] + r[2] * r[2] + r[3] * r[3];
  if (l <= 0) return [0, 0, 0, 1];
  const s = 1 / Math.sqrt(l);
  return r.map((v) => v * s);
}

// ClipMap: each skeleton bone's index in the clip (by name, ignoring case), or -1. Cached on the clip.
export function clipMap(rig, clip) {
  clip.maps ||= new Map();
  let map = clip.maps.get(rig.names);
  if (!map) {
    const lower = clip.bones.map((b) => b.name.toLowerCase());
    map = rig.names.map((n) => lower.indexOf(n.toLowerCase()));
    clip.maps.set(rig.names, map);
  }
  return map;
}

// SampleLocal: { p, q } for a skeleton bone, or null when the clip doesn't have the bone.
function sampleLocal(rig, clip, frame, bone) {
  if (!clip) return null;
  const b = clipMap(rig, clip)[bone];
  if (b < 0) return null;
  const tracks = clip.bones[b].tracks;
  const pos = sampleTrack(tracks[0], frame, 0);
  const rot = sampleTrack(tracks[1], frame, 1);
  const p = pos ? [pos[0], pos[1], pos[2]] : [0, 0, 0];
  let q = rot ? [rot[0], rot[1], rot[2], rot[3]] : [0, 0, 0, 1];
  const l = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
  if (l > 1e-8) {
    const s = 1 / Math.sqrt(l);
    q = q.map((v) => v * s);
  } else q = [0, 0, 0, 1];
  return { p, q };
}

// PoseAvatar: every bone's model-space matrix for a clip at a frame, cross-faded from fromClip by blend (0 = all
// from, 1 = all to). Bones neither clip animates keep their bind pose relative to their parent.
export function poseSkeleton(rig, clip, frame, fromClip = null, fromFrame = 0, blend = 1) {
  const n = rig.names.length;
  const world = new Array(n).fill(null);
  for (let guard = 0; guard < n * 2; guard++) {
    let progress = false;
    for (let s = 0; s < n; s++) {
      if (world[s]) continue;
      const p = s < rig.parents.length ? rig.parents[s] : -1;
      if (p >= 0 && !world[p]) continue;
      let got = sampleLocal(rig, clip, frame, s);
      const from = blend < 1 ? sampleLocal(rig, fromClip, fromFrame, s) : null;
      if (from) {
        if (!got) got = from;
        else {
          const pp = from.p.map((v, k) => v + (got.p[k] - v) * blend);
          got = { p: pp, q: slerp(from.q, got.q, blend) };
        }
      }
      let local;
      if (got) local = trs(got.p[0], got.p[1], got.p[2], got.q[0], got.q[1], got.q[2], got.q[3]);
      else local = p >= 0 ? mul4(rig.bindInverse[p], rig.bindWorld[s]) : Float32Array.from(rig.bindWorld[s]);
      world[s] = p >= 0 ? mul4(world[p], local) : local;
      progress = true;
    }
    if (!progress) break;
  }
  return world.map((w, s) => w || Float32Array.from(rig.bindWorld[s]));
}

// DrawAvatar's skinning: { positions, normals } (Float32Array, vc x 3) of the rig's mesh in a pose. Linear blend of
// up to 4 influences (index 0xFF or weight <= 0 skipped), divided by the weight sum; a vertex with none stays put.
// normals is null when the mesh has none.
export function skinPositions(rig, pose) {
  const skin = pose.map((m, s) => mul4(m, rig.bindInverse[s]));
  const src = rig.mesh.positions;
  const srcN = rig.mesh.normals;
  const vc = Math.floor(src.length / 3);
  const hasN = srcN && srcN.length >= vc * 3;
  const positions = new Float32Array(vc * 3);
  const normals = hasN ? new Float32Array(vc * 3) : null;
  for (let i = 0; i < vc; i++) {
    const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
    const nx = hasN ? srcN[i * 3] : 0, ny = hasN ? srcN[i * 3 + 1] : 0, nz = hasN ? srcN[i * 3 + 2] : 0;
    let sx = 0, sy = 0, sz = 0, tx = 0, ty = 0, tz = 0, ws = 0;
    for (let k = 0; k < 4; k++) {
      const bi = rig.indices[i * 4 + k];
      const w = rig.weights[i * 4 + k];
      if (bi === 0xff || w <= 0 || bi >= skin.length) continue;
      const m = skin[bi];
      sx += (m[0] * x + m[4] * y + m[8] * z + m[12]) * w;
      sy += (m[1] * x + m[5] * y + m[9] * z + m[13]) * w;
      sz += (m[2] * x + m[6] * y + m[10] * z + m[14]) * w;
      tx += (m[0] * nx + m[4] * ny + m[8] * nz) * w;
      ty += (m[1] * nx + m[5] * ny + m[9] * nz) * w;
      tz += (m[2] * nx + m[6] * ny + m[10] * nz) * w;
      ws += w;
    }
    if (ws > 1e-5) {
      positions[i * 3] = sx / ws;
      positions[i * 3 + 1] = sy / ws;
      positions[i * 3 + 2] = sz / ws;
    } else {
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      tx = nx;
      ty = ny;
      tz = nz;
    }
    if (normals) {
      const l = Math.hypot(tx, ty, tz) || 1;
      normals[i * 3] = tx / l;
      normals[i * 3 + 1] = ty / l;
      normals[i * 3 + 2] = tz / l;
    }
  }
  return { positions, normals };
}
