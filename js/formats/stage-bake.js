// Writing placement edits into a Steam stage's geometry, ported from HappyTool/RrmConvert/StageEditBaker.cs (Bake's
// edit pass: RecordLayout, PatchVertices, RecomputeBounds, Affine) and GUI/StageViewerForm.Export.cs
// (CollectExportEdits). Each moved object's vertices are rewritten in place in its ModelData record (positions and
// direction streams through the placement, under the record's scene node); a hidden object's vertices collapse onto
// its pivot. The bounds of every batch an edit touched are refitted, so the game doesn't cull what moved.

import { isIdentityTransform, rotation } from '../views/stage-edit.js';

export const MODELDATA_MAGIC = 0x0132b421;
const BATCH_STRIDE = 0xe0;
const BATCH_BOUNDS_OFF = 0x7c;

const view = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
const u32 = (dv, o) => dv.getUint32(o, true);
const f32 = (dv, o) => dv.getFloat32(o, true);
const w32 = (dv, o, v) => dv.setFloat32(o, v, true);
const hex = (n) => n.toString(16).toUpperCase();

// ===================== affine 3×4 matrices (row-major, column vectors) =====================

export const Affine = {
  mul(a, b) {
    const m = new Array(12);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) m[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c];
      m[r * 4 + 3] = a[r * 4] * b[3] + a[r * 4 + 1] * b[7] + a[r * 4 + 2] * b[11] + a[r * 4 + 3];
    }
    return m;
  },
  point: (m, x, y, z) => [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ],
  direction: (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z, m[4] * x + m[5] * y + m[6] * z, m[8] * x + m[9] * y + m[10] * z],
  invert(m) {
    const [a, b, c] = [m[0], m[1], m[2]], [d, e, f] = [m[4], m[5], m[6]], [g, h, i] = [m[8], m[9], m[10]];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-18 || Number.isNaN(det)) return null;
    const inv = 1 / det;
    const r = new Array(12).fill(0);
    r[0] = A * inv; r[1] = -(b * i - c * h) * inv; r[2] = (b * f - c * e) * inv;
    r[4] = B * inv; r[5] = (a * i - c * g) * inv; r[6] = -(a * f - c * d) * inv;
    r[8] = C * inv; r[9] = -(a * h - b * g) * inv; r[10] = (a * e - b * d) * inv;
    r[3] = -(r[0] * m[3] + r[1] * m[7] + r[2] * m[11]);
    r[7] = -(r[4] * m[3] + r[5] * m[7] + r[6] * m[11]);
    r[11] = -(r[8] * m[3] + r[9] * m[7] + r[10] * m[11]);
    return r;
  },
  /** The transpose of the inverse's linear part: how normals turn under m. */
  normalMatrix(m) {
    const inv = Affine.invert(m);
    if (!inv) return null;
    return [inv[0], inv[4], inv[8], 0, inv[1], inv[5], inv[9], 0, inv[2], inv[6], inv[10], 0];
  },
};

/**
 * A placement {t, r, s} about pivot as a 3×4 matrix, built as the desktop's ObjectState.ToMatrix (translate to the
 * pivot, scale, rotate X then Y then Z, translate back plus the move; scale and rotation dropped when they're nearly
 * none), in single precision as it is there.
 */
export function placementMatrix(st, pivot) {
  const scaled = !st.s.every((x) => Math.abs(x - 1) < 1e-5);
  const turned = !st.r.every((x) => Math.abs(x) < 1e-4);
  const s = scaled ? st.s : [1, 1, 1];
  const R = turned ? rotation(st.r) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const m = new Array(12);
  for (let r = 0; r < 3; r++) {
    let shift = 0;
    for (let c = 0; c < 3; c++) {
      m[r * 4 + c] = R[r * 3 + c] * s[c];
      shift += m[r * 4 + c] * pivot[c];
    }
    m[r * 4 + 3] = pivot[r] + st.t[r] - shift;
  }
  return m.map(Math.fround);
}

// ===================== ModelData records =====================

/** A ModelData record's streams (StageEditBaker.RecordLayout.Read). Throws on a header that doesn't add up. */
export function readRecord(u8, rec, resource) {
  const dv = view(u8);
  const where = `${resource} record @0x${hex(rec)}`;
  if (rec < 0 || rec + 0x200 > u8.length) throw new Error(`${where} is outside the file.`);
  const io = u32(dv, rec + 0x98), ic = u32(dv, rec + 0x9c), vo = u32(dv, rec + 0xa0), vc = u32(dv, rec + 0xa4);
  const end = u32(dv, rec + 0xd4);
  if (vc === 0 || vc > 20_000_000 || ic < 3 || ic > 60_000_000 || vo <= io || end <= vo)
    throw new Error(`${where} has an unexpected vertex/index header.`);
  if (rec + vo + vc * 12 > u8.length || rec + end > u8.length) throw new Error(`${where} streams run past the end of the file.`);
  let elem = 0;
  for (let c = 4; c >= 2; c -= 2) {
    const pad = vo - (io + ic * c);
    if (pad >= 0 && pad <= 16) {
      elem = c;
      break;
    }
  }
  if (!elem) throw new Error(`${where} index buffer size doesn't match its header.`);
  const r = {
    base: rec,
    vertexCount: vc,
    positionAbs: rec + vo,
    indexAbs: rec + io,
    indexCount: ic,
    indexSize: elem,
    batchAbs: rec + u32(dv, rec + 0x90),
    batchCount: u32(dv, rec + 0x94),
    directionStreams: [],
    uvStreams: [],
  };
  if (r.batchCount > 1_000_000 || r.batchAbs + r.batchCount * BATCH_STRIDE > u8.length) throw new Error(`${where} batch table is out of range.`);
  const offsets = [vo];
  for (let k = 0xb0; k <= 0xd0; k += 4) {
    const v = u32(dv, rec + k);
    if (v > vo && v < end && !offsets.includes(v)) offsets.push(v);
  }
  offsets.sort((a, b) => a - b);
  offsets.push(end);
  for (let i = 0; i + 1 < offsets.length; i++) {
    const off = offsets[i], size = offsets[i + 1] - off;
    if (off !== vo && size >= vc * 8 && size < vc * 8 + 16) r.uvStreams.push(rec + off);
    if (off === vo || size < vc * 12 || size >= vc * 12 + 16) continue;
    if (looksUnit(dv, rec + off, vc)) r.directionStreams.push(rec + off);
  }
  return r;
}

const indexAt = (dv, rec, i) => (rec.indexSize === 4 ? u32(dv, rec.indexAbs + i * 4) | 0 : dv.getUint16(rec.indexAbs + i * 2, true));

/** The last batch whose bounding cube repeats the record's AABB (FindBatchRepeatedByAabb), or -1. */
function findBatchRepeatedByAabb(dv, rec) {
  let found = -1;
  for (let b = 0; b < rec.batchCount; b++) {
    const f = rec.batchAbs + b * BATCH_STRIDE + BATCH_BOUNDS_OFF;
    let same = true;
    for (let k = 0; k < 6 && same; k++) {
      const x = f32(dv, f + k * 4);
      same = Math.abs(x - f32(dv, rec.base + 0xdc + k * 4)) <= 1e-3 * Math.max(1, Math.abs(x));
    }
    if (same) found = b;
  }
  return found;
}

/** Whether a 12-byte-per-vertex stream holds unit vectors (most of 32 samples about length 1). */
function looksUnit(dv, abs, vc) {
  const samples = Math.min(vc, 32), step = Math.max(1, Math.trunc(vc / Math.max(1, samples)));
  let seen = 0, unit = 0;
  for (let i = 0; i < vc && seen < samples; i += step) {
    const p = abs + i * 12;
    if (p + 12 > dv.byteLength) break;
    const x = f32(dv, p), y = f32(dv, p + 4), z = f32(dv, p + 8);
    seen++;
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 0.9 && len < 1.1) unit++;
  }
  return seen > 0 && unit * 4 >= seen * 3;
}

function orthonormal(r) {
  for (let a = 0; a < 3; a++) {
    const len = r[a * 3] * r[a * 3] + r[a * 3 + 1] * r[a * 3 + 1] + r[a * 3 + 2] * r[a * 3 + 2];
    if (Number.isNaN(len) || Math.abs(len - 1) > 1e-2) return false;
    for (let b = a + 1; b < 3; b++)
      if (Math.abs(r[a * 3] * r[b * 3] + r[a * 3 + 1] * r[b * 3 + 1] + r[a * 3 + 2] * r[b * 3 + 2]) > 1e-2) return false;
  }
  return true;
}

/** Rewrites one edited object's vertices (PatchVertices without the ground warp). Returns how many it wrote. */
function patchVertices(dv, rec, e, touched) {
  const node = e.nodeMatrix ? e.nodeMatrix.map(Math.fround) : null;
  const nodeInv = node ? Affine.invert(node) : null;
  if (node && !nodeInv) throw new Error(`${e.name}: its scene node transform can't be inverted.`);
  let local = null, normalMat = null, collapse = null;
  if (e.deleted) {
    const p = e.pivot ?? [0, 0, 0];
    collapse = nodeInv ? Affine.point(nodeInv, p[0], p[1], p[2]) : [p[0], p[1], p[2]];
  } else {
    if (!e.world || e.world.length !== 12) throw new Error(`${e.name}: missing placement matrix.`);
    local = node ? Affine.mul(nodeInv, Affine.mul(e.world, node)) : e.world.slice();
    normalMat = Affine.normalMatrix(local);
    if (!normalMat) throw new Error(`${e.name}: its placement can't be inverted (zero scale?).`);
  }
  const count = e.vertices ? e.vertices.length : rec.vertexCount;
  for (let k = 0; k < count; k++) {
    const v = e.vertices ? e.vertices[k] : k;
    if (!(v >= 0 && v < rec.vertexCount)) throw new Error(`${e.name}: vertex ${v} is outside its record.`);
    touched[v] = 1;
    const pa = rec.positionAbs + v * 12;
    if (collapse) {
      w32(dv, pa, collapse[0]);
      w32(dv, pa + 4, collapse[1]);
      w32(dv, pa + 8, collapse[2]);
      continue;
    }
    const q = Affine.point(local, f32(dv, pa), f32(dv, pa + 4), f32(dv, pa + 8));
    w32(dv, pa, q[0]);
    w32(dv, pa + 4, q[1]);
    w32(dv, pa + 8, q[2]);
    for (let s = 0; s < rec.directionStreams.length; s++) {
      const na = rec.directionStreams[s] + v * 12;
      const n = Affine.direction(s === 0 ? normalMat : local, f32(dv, na), f32(dv, na + 4), f32(dv, na + 8));
      const len = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
      if (len < 1e-12) continue;
      w32(dv, na, n[0] / len);
      w32(dv, na + 4, n[1] / len);
      w32(dv, na + 8, n[2] / len);
    }
  }
  return count;
}

/**
 * Refits the bounds of every batch of rec that uses a touched vertex (RecomputeBounds): sphere and cube from the
 * batch's vertices, the oriented box along its authored axes. A pack record's own cube then holds every batch.
 */
function recomputeBounds(dv, rec, touched, aabbBatch) {
  let rebuilt = 0;
  const seen = new Int32Array(rec.vertexCount);
  let stamp = 0;
  for (let b = 0; b < rec.batchCount; b++) {
    const e = rec.batchAbs + b * BATCH_STRIDE;
    const first = u32(dv, e + 8) | 0, cnt = u32(dv, e + 12) | 0;
    if (first < 0 || cnt <= 0 || first + cnt > rec.indexCount) continue;
    let hit = false;
    for (let i = first; i < first + cnt && !hit; i++) {
      const v = indexAt(dv, rec, i);
      hit = v >= 0 && v < rec.vertexCount && touched[v] === 1;
    }
    if (!hit) continue;
    stamp++;
    const verts = [];
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = first; i < first + cnt; i++) {
      const v = indexAt(dv, rec, i);
      if (!(v >= 0 && v < rec.vertexCount) || seen[v] === stamp) continue;
      seen[v] = stamp;
      verts.push(v);
      const pa = rec.positionAbs + v * 12;
      const x = f32(dv, pa), y = f32(dv, pa + 4), z = f32(dv, pa + 8);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    if (!verts.length) continue;
    const cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5, cz = (z0 + z1) * 0.5;
    let r2 = 0;
    for (const v of verts) {
      const pa = rec.positionAbs + v * 12;
      const dx = f32(dv, pa) - cx, dy = f32(dv, pa + 4) - cy, dz = f32(dv, pa + 8) - cz;
      r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
    }
    // A fully collapsed (hidden) batch keeps a small non-zero volume so nothing downstream divides by zero.
    const radius = Math.max(Math.sqrt(r2), 1);
    // OBB: keep the authored axes (rows), refit centre and half extents along them.
    const f = e + BATCH_BOUNDS_OFF;
    let axes = [];
    for (let k = 0; k < 9; k++) axes.push(f32(dv, f + (13 + k) * 4));
    if (!orthonormal(axes)) axes = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const v of verts) {
      const pa = rec.positionAbs + v * 12;
      const x = f32(dv, pa), y = f32(dv, pa + 4), z = f32(dv, pa + 8);
      for (let a = 0; a < 3; a++) {
        const t = axes[a * 3] * x + axes[a * 3 + 1] * y + axes[a * 3 + 2] * z;
        if (t < lo[a]) lo[a] = t;
        if (t > hi[a]) hi[a] = t;
      }
    }
    let ox = 0, oy = 0, oz = 0;
    const half = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      const mid = (lo[a] + hi[a]) * 0.5;
      half[a] = Math.max((hi[a] - lo[a]) * 0.5, 0.5);
      ox += axes[a * 3] * mid;
      oy += axes[a * 3 + 1] * mid;
      oz += axes[a * 3 + 2] * mid;
    }
    const vals = [cx - radius, cy - radius, cz - radius, cx + radius, cy + radius, cz + radius, cx, cy, cz, radius, ox, oy, oz, ...axes, ...half];
    for (let k = 0; k < 25; k++) w32(dv, f + k * 4, vals[k]);
    if (b === aabbBatch) for (let k = 0; k < 6; k++) w32(dv, rec.base + 0xdc + k * 4, vals[k]);
    rebuilt++;
  }
  // A pack record is culled by its AABB, so there it holds every batch (one batch on authored records; several on a
  // record the editor merged). Terrain keeps the authored rule above.
  if (rebuilt > 0 && rec.batchCount > 1 && u32(dv, 0x88) > 0) {
    const cube = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let b = 0; b < rec.batchCount; b++) {
      const f = rec.batchAbs + b * BATCH_STRIDE + BATCH_BOUNDS_OFF;
      for (let k = 0; k < 3; k++) {
        cube[k] = Math.min(cube[k], f32(dv, f + k * 4));
        cube[k + 3] = Math.max(cube[k + 3], f32(dv, f + (k + 3) * 4));
      }
    }
    for (let k = 0; k < 6; k++) w32(dv, rec.base + 0xdc + k * 4, cube[k]);
  }
  return rebuilt;
}

// ===================== edits =====================

/**
 * The placement edits to write, from the map editor's objects (CollectExportEdits, without the ground warp): every
 * moved or hidden object whose mesh can be written back. Returns {edits, skipped} (objects that moved but can't be
 * written, e.g. an Xbox 360 model).
 */
export function collectExportEdits(objects) {
  const edits = [];
  let skipped = 0;
  for (const o of objects) {
    const s = o.state;
    if (!s.hidden && isIdentityTransform(s)) continue;
    const mesh = o.mesh;
    if (!mesh.sourceResource || o.recordOffset == null || o.recordOffset < 0) {
      skipped++;
      continue;
    }
    const pivot = o.pivot.map(Math.fround);
    edits.push({
      name: o.name,
      resource: mesh.sourceResource,
      recordOffset: o.recordOffset,
      nodeMatrix: o.nodeMatrix ?? null,
      vertices: mesh.sourceVertex ? mesh.sourceVertex.subarray(o.firstVertex, o.firstVertex + o.vertexCount) : null,
      world: s.hidden ? null : placementMatrix(s, pivot),
      deleted: !!s.hidden,
      pivot,
      shape: o.index,
    });
  }
  return { edits, skipped };
}

/**
 * Writes edits into copies of their resources. read(name) gives a resource's bytes (its decoded payload). Returns
 * {changed: Map name → Uint8Array, report: {objectsWritten, objectsHidden, verticesWritten, batchesRebounded}}.
 */
export async function bakeEdits(edits, read) {
  const report = { objectsWritten: 0, objectsHidden: 0, verticesWritten: 0, batchesRebounded: 0 };
  const perResource = new Map();
  for (const e of edits) {
    if (!e?.resource) continue;
    const key = e.resource.toLowerCase();
    if (!perResource.has(key)) perResource.set(key, { name: e.resource, list: [] });
    perResource.get(key).list.push(e);
  }
  const changed = new Map();
  for (const { name, list } of perResource.values()) {
    const src = await read(name);
    if (!src) throw new Error(`The bundle has no resource named ${name}.`);
    const data = new Uint8Array(src); // a copy: the scene keeps reading the stock bytes
    const dv = view(data);
    if (data.length < 0x200 || u32(dv, 0) !== MODELDATA_MAGIC) throw new Error(`${name} is not a Steam ModelData file.`);
    // Records first take note of which batch cube their AABB repeats (before any vertex moves).
    const touched = new Map(), aabbBatch = new Map();
    for (const e of list) {
      const rec = readRecord(data, e.recordOffset, name);
      if (!touched.has(rec.base)) {
        touched.set(rec.base, new Uint8Array(rec.vertexCount));
        aabbBatch.set(rec.base, findBatchRepeatedByAabb(dv, rec));
      }
      report.verticesWritten += patchVertices(dv, rec, e, touched.get(rec.base));
      report.objectsWritten++;
      if (e.deleted) report.objectsHidden++;
    }
    for (const [base, t] of touched) report.batchesRebounded += recomputeBounds(dv, readRecord(data, base, name), t, aabbBatch.get(base));
    changed.set(name, data);
  }
  return { changed, report };
}
