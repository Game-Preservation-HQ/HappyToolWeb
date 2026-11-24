// Model fingerprints of embedded .rrm / .rmd meshes, ported from HappyTool/RrmConvert/RrmModelParser.cs
// (TryParseBundledModel, TryComputeModelFingerprint, TryComputeVertexCloudFingerprint,
// TryComputeTriangleSoupFingerprint). Float arithmetic is float32 as on the desktop, values are rounded with
// Math.Round(x, 3, AwayFromZero) and sorted with the desktop's unstable introsort, so -0 / +0 ties land in the
// same order and the SHA-256 of the written stream comes out the same.

import { parseRrm } from '../formats/rrm.js';
import { parseRmdMesh } from '../formats/rmd.js';
import { sha256HexUpper } from './sha256.js';
import { netGetExtension, netRound3, floatCompareTo, netSort, listCapacity } from './dotnet.js';

const f = Math.fround;
const F32_MAX = 3.4028234663852886e38;
const SCALE_MIN = f(1e-5);

/**
 * RrmModelParser.TryParseBundledModel: .rmd as the Xbox mesh, everything else as .rrm.
 * @returns {{positions: Float32Array, indices: Uint32Array} | {error: string}}
 */
export function parseBundledModel(bytes, name) {
  if ((netGetExtension(name ?? '') ?? '').toLowerCase() === '.rmd') return parseRmdMesh(bytes);
  try {
    const m = parseRrm(bytes);
    return { positions: m.positions, indices: m.indices };
  } catch (e) {
    return { error: e.message };
  }
}

function bounds(pos) {
  let minX = F32_MAX, minY = F32_MAX, minZ = F32_MAX, maxX = -F32_MAX, maxY = -F32_MAX, maxZ = -F32_MAX;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const ex = f(f(maxX - minX) * 0.5), ey = f(f(maxY - minY) * 0.5), ez = f(f(maxZ - minZ) * 0.5);
  let scale = ex > ey ? (ex > ez ? ex : ez) : (ey > ez ? ey : ez);
  if (scale < SCALE_MIN) scale = 1;
  return { cx: f(f(minX + maxX) * 0.5), cy: f(f(minY + maxY) * 0.5), cz: f(f(minZ + maxZ) * 0.5), scale };
}

class Stream {
  constructor(size) {
    this.dv = new DataView(new ArrayBuffer(size));
    this.o = 0;
  }
  i32(v) {
    this.dv.setInt32(this.o, v, true);
    this.o += 4;
  }
  f32(v) {
    this.dv.setFloat32(this.o, v, true);
    this.o += 4;
  }
  sha() {
    return sha256HexUpper(new Uint8Array(this.dv.buffer, 0, this.o));
  }
}

function visualShapeHash(mesh) {
  const pos = mesh.positions, idx = mesh.indices;
  const vc = pos.length / 3;
  const { cx, cy, cz, scale } = bounds(pos);
  const nrm = new Float32Array(vc * 3);
  for (let i = 0; i < vc; i++) {
    nrm[i * 3] = netRound3(f(f(pos[i * 3] - cx) / scale));
    nrm[i * 3 + 1] = netRound3(f(f(pos[i * 3 + 1] - cy) / scale));
    nrm[i * 3 + 2] = netRound3(f(f(pos[i * 3 + 2] - cz) / scale));
  }
  const order = Array.from({ length: vc }, (_, i) => i);
  netSort(order, (a, b) => {
    for (let k = 0; k < 3; k++) {
      const fa = nrm[a * 3 + k], fb = nrm[b * 3 + k];
      if (fa < fb) return -1;
      if (fa > fb) return 1;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const oldToNew = new Int32Array(vc);
  for (let n = 0; n < vc; n++) oldToNew[order[n]] = n;
  const triples = [];
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const o0 = idx[i], o1 = idx[i + 1], o2 = idx[i + 2];
    if (o0 >= vc || o1 >= vc || o2 >= vc) continue;
    const a = oldToNew[o0], b = oldToNew[o1], c = oldToNew[o2];
    const x0 = Math.min(a, b, c), x2 = Math.max(a, b, c);
    triples.push([x0, a + b + c - x0 - x2, x2]);
  }
  // Integer triples: ties are identical, so any sort gives the desktop's bytes.
  triples.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  const s = new Stream(8 + vc * 12 + triples.length * 12);
  s.i32(vc);
  for (const v of order) {
    s.f32(nrm[v * 3]);
    s.f32(nrm[v * 3 + 1]);
    s.f32(nrm[v * 3 + 2]);
  }
  s.i32(triples.length);
  for (const t of triples) {
    s.i32(t[0]);
    s.i32(t[1]);
    s.i32(t[2]);
  }
  return s.sha();
}

function vertexCloudHash(mesh) {
  const pos = mesh.positions;
  const vc = pos.length / 3;
  const { cx, cy, cz, scale } = bounds(pos);
  const pts = new Array(vc);
  for (let i = 0; i < vc; i++) {
    pts[i] = [
      netRound3(f(f(pos[i * 3] - cx) / scale)),
      netRound3(f(f(pos[i * 3 + 1] - cy) / scale)),
      netRound3(f(f(pos[i * 3 + 2] - cz) / scale)),
    ];
  }
  netSort(pts, (a, b) => {
    for (let k = 0; k < 3; k++) {
      if (a[k] < b[k]) return -1;
      if (a[k] > b[k]) return 1;
    }
    return 0;
  }, vc);
  const s = new Stream(8 + vc * 12);
  s.i32(vc);
  s.i32(Math.floor(mesh.indices.length / 3));
  for (const p of pts) {
    s.f32(p[0]);
    s.f32(p[1]);
    s.f32(p[2]);
  }
  return s.sha();
}

function triangleSoupHash(mesh) {
  const pos = mesh.positions, idx = mesh.indices;
  const vc = pos.length / 3;
  const { cx, cy, cz, scale } = bounds(pos);
  const px = (v) => f(f(pos[v * 3] - cx) / scale);
  const py = (v) => f(f(pos[v * 3 + 1] - cy) / scale);
  const pz = (v) => f(f(pos[v * 3 + 2] - cz) / scale);
  const dist = (a, b) => {
    const dx = f(px(a) - px(b)), dy = f(py(a) - py(b)), dz = f(pz(a) - pz(b));
    return f(Math.sqrt(f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz))));
  };
  const feats = [];
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
    if (i0 >= vc || i1 >= vc || i2 >= vc) continue;
    const c0 = netRound3(f(f(f(px(i0) + px(i1)) + px(i2)) / 3));
    const c1 = netRound3(f(f(f(py(i0) + py(i1)) + py(i2)) / 3));
    const c2 = netRound3(f(f(f(pz(i0) + pz(i1)) + pz(i2)) / 3));
    let a = netRound3(dist(i0, i1)), b = netRound3(dist(i1, i2)), c = netRound3(dist(i2, i0)), s;
    if (a > b) { s = a; a = b; b = s; }
    if (a > c) { s = a; a = c; c = s; }
    if (b > c) { s = b; b = c; c = s; }
    feats.push([c0, c1, c2, a, b, c]);
  }
  netSort(feats, (p, q) => {
    for (let k = 0; k < 6; k++) {
      const r = floatCompareTo(p[k], q[k]);
      if (r !== 0) return r;
    }
    return 0;
  }, listCapacity(feats.length));
  const s = new Stream(4 + feats.length * 24);
  s.i32(feats.length);
  for (const ft of feats) for (let k = 0; k < 6; k++) s.f32(ft[k]);
  return s.sha();
}

/**
 * Fingerprints of one bundle resource, each computed once: the parse is a pure function of the bytes and the
 * extension, so every desktop call on the same resource gets the same answer. Each returns {fp} or {note}.
 */
export class ModelFingerprints {
  constructor() {
    this.cache = new WeakMap();
  }

  entry(res) {
    let c = this.cache.get(res);
    if (!c) this.cache.set(res, (c = {}));
    return c;
  }

  mesh(res) {
    const c = this.entry(res);
    if (!c.mesh) c.mesh = parseBundledModel(res.data, res.name);
    return c.mesh;
  }

  /** TryComputeModelFingerprint: {fp, note: "visual shape; N verts, T tris"} or {note}. */
  model(res) {
    const c = this.entry(res);
    if (c.model) return c.model;
    if (!res.data || res.data.length === 0) return (c.model = { note: 'empty' });
    const m = this.mesh(res);
    if (m.error) return (c.model = { note: m.error });
    return (c.model = { fp: visualShapeHash(m), note: `visual shape; ${m.positions.length / 3} verts, ${Math.floor(m.indices.length / 3)} tris` });
  }

  /** TryComputeVertexCloudFingerprint. */
  cloud(res) {
    const c = this.entry(res);
    if (c.cloud) return c.cloud;
    if (!res.data || res.data.length === 0) return (c.cloud = { note: 'empty' });
    const m = this.mesh(res);
    if (m.error) return (c.cloud = { note: m.error });
    return (c.cloud = { fp: vertexCloudHash(m), note: `vertex cloud; ${m.positions.length / 3} verts, ${Math.floor(m.indices.length / 3)} tris` });
  }

  /** TryComputeTriangleSoupFingerprint. */
  soup(res) {
    const c = this.entry(res);
    if (c.soup) return c.soup;
    if (!res.data || res.data.length === 0) return (c.soup = { note: 'empty' });
    const m = this.mesh(res);
    if (m.error) return (c.soup = { note: m.error });
    if (m.indices.length < 3) return (c.soup = { note: 'no geometry' });
    return (c.soup = { fp: triangleSoupHash(m) });
  }
}
