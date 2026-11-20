// Writing placement edits into a Steam stage's geometry, ported from HappyTool/RrmConvert/StageEditBaker.cs (Bake's
// edit pass: RecordLayout, PatchVertices, RecomputeBounds, Affine) and GUI/StageViewerForm.Export.cs
// (CollectExportEdits). Each moved object's vertices are rewritten in place in its ModelData record (positions and
// direction streams through the placement, under the record's scene node); a hidden object's vertices collapse onto
// its pivot. The bounds of every batch an edit touched are refitted, so the game doesn't cull what moved.
// The collision follows (PatchCollision, BuildGroup, TileGroups, ClipToTiles, DropStaleCollisionCopies): a moved
// object's triangles leave their group for new groups cut to the game's 1000-unit tiles, placed like the object; a
// hidden object's triangles are dropped; everything else stays where it is. Solid objects get collision generated from
// their own shapes (SolidCollision, CollisionSized, SolidTriangles, FlatTriangles, AppendCollisionGroups), appended to the
// character and environment layers. Collision erased by hand in the Collision panel (removedByHand) neither stays nor
// travels with its object.

import { isIdentityTransform, rotation } from '../views/stage-edit.js';
import { parseCollisionGroups } from '../views/stage-collision.js';
import { makeShape, ensureBounds } from '../views/stage-collision-match.js';

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

// ===================== collision (.ccp): triangles travel with their objects =====================

const CCH_SIZE = 0x28;
const CCB_SIZE = 8 + 43 * 4;
/** Side of the XZ tiles collision groups are filed by (CollisionTile): the game only finds a group inside its tile. */
const COLLISION_TILE = 1000;
const TILE_MAX_TRIANGLES = 20000;

const groupNear = (g, s, m) =>
  g.minX <= s.maxX + m && g.maxX >= s.minX - m && g.minY <= s.maxY + m && g.maxY >= s.minY - m && g.minZ <= s.maxZ + m && g.maxZ >= s.minZ - m;

/**
 * One CCH/CCB/CCV/CCI group from some of src's triangles ({node, vertices, triangles}), vertices renumbered in
 * first-use order, optionally placed by world. keepBounds (the source's 43 CCB floats) keeps the authored sphere and box,
 * which still enclose a subset; otherwise they are fitted fresh. The boxes and diagonal extents are always refitted.
 */
function buildGroup(src, tris, world, keepBounds) {
  const remap = new Map(), verts = [], idx = new Int32Array(tris.length * 3);
  for (let k = 0; k < tris.length; k++)
    for (let j = 0; j < 3; j++) {
      const v = src.triangles[tris[k] * 3 + j];
      let nv = remap.get(v);
      if (nv === undefined) {
        nv = remap.size;
        remap.set(v, nv);
        let x = src.vertices[v * 3], y = src.vertices[v * 3 + 1], z = src.vertices[v * 3 + 2];
        if (world) [x, y, z] = Affine.point(world, x, y, z);
        verts.push(x, y, z);
      }
      idx[k * 3 + j] = nv;
    }
  const vc = verts.length / 3, ic = idx.length;
  if (vc > 0xffff || ic > 0xffff) throw new Error('A collision group would exceed 65535 vertices or indices.');

  const mn = [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE], mx = [-Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE];
  const dmn = new Array(6).fill(Number.MAX_VALUE), dmx = new Array(6).fill(-Number.MAX_VALUE);
  for (let i = 0; i < vc; i++) {
    const x = verts[i * 3], y = verts[i * 3 + 1], z = verts[i * 3 + 2];
    mn[0] = Math.min(mn[0], x); mn[1] = Math.min(mn[1], y); mn[2] = Math.min(mn[2], z);
    mx[0] = Math.max(mx[0], x); mx[1] = Math.max(mx[1], y); mx[2] = Math.max(mx[2], z);
    const diag = [x + y, x - y, x + z, x - z, y + z, y - z];
    for (let k = 0; k < 6; k++) {
      dmn[k] = Math.min(dmn[k], diag[k]);
      dmx[k] = Math.max(dmx[k], diag[k]);
    }
  }
  const cx = (mn[0] + mx[0]) * 0.5, cy = (mn[1] + mx[1]) * 0.5, cz = (mn[2] + mx[2]) * 0.5;
  const hx = (mx[0] - mn[0]) * 0.5, hy = (mx[1] - mn[1]) * 0.5, hz = (mx[2] - mn[2]) * 0.5;
  const f = new Float64Array(43);
  if (keepBounds) f.set(keepBounds);
  else {
    let r2 = 0;
    for (let i = 0; i < vc; i++) {
      const dx = verts[i * 3] - cx, dy = verts[i * 3 + 1] - cy, dz = verts[i * 3 + 2] - cz;
      r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
    }
    // Authored spheres carry ~0.1% slack over the farthest vertex.
    f[0] = cx; f[1] = cy; f[2] = cz; f[3] = Math.max(Math.sqrt(r2) * 1.001, 0.01);
    // OBB: centre, three axis rows, half extents, with the up axis last like every shipped group.
    f[10] = cx; f[11] = cy; f[12] = cz;
    f[13] = 1; // u = +x
    f[18] = 1; // w = u × n = +z
    f[20] = 1; // n = +y
    f[22] = hx; f[23] = hz; f[24] = hy;
  }
  f[4] = cx; f[5] = cy; f[6] = cz;
  f[7] = hx; f[8] = hy; f[9] = hz;
  f[25] = mn[0]; f[26] = mn[1]; f[27] = mn[2];
  for (let k = 0; k < 6; k++) f[28 + k] = dmn[k];
  f[34] = mx[0]; f[35] = mx[1]; f[36] = mx[2];
  for (let k = 0; k < 6; k++) f[37 + k] = dmx[k];

  const ccvSize = 12 + vc * 12, cciSize = 8 + ((ic * 2 + 3) & ~3);
  const size = CCH_SIZE + CCB_SIZE + ccvSize + cciSize;
  const o = new Uint8Array(size), dv = view(o);
  let p = 0;
  const putTag = (t, n) => {
    o[p] = t.charCodeAt(0); o[p + 1] = t.charCodeAt(1); o[p + 2] = t.charCodeAt(2); o[p + 3] = 0;
    dv.setUint32(p + 4, n, true);
    p += 8;
  };
  const putU32 = (v) => { dv.setUint32(p, v >>> 0, true); p += 4; };
  const putF32 = (v) => { dv.setFloat32(p, v, true); p += 4; };
  // CCH node: type, attribute, group size, 0, (vertices, 12), (indices, 6), 0, (triangles, 0); the counts' high halves
  // (strides) and the zero words come from the source group.
  const n = src.node;
  putTag('CCH', CCH_SIZE);
  putU32(n[0]);
  putU32(n[1]);
  putU32(size);
  putU32(n[3]);
  putU32((n[4] & 0xffff0000) | vc);
  putU32((n[5] & 0xffff0000) | ic);
  putU32(n[6]);
  putU32((n[7] & 0xffff0000) | (ic / 3));
  putTag('CCB', CCB_SIZE);
  for (let k = 0; k < 43; k++) putF32(f[k]);
  putTag('CCV', ccvSize);
  putU32(0);
  for (const v of verts) putF32(v);
  putTag('CCI', cciSize);
  for (let i = 0; i < ic; i++) {
    o[p++] = idx[i] & 0xff;
    o[p++] = (idx[i] >> 8) & 0xff;
  }
  return o; // the CCI tail pad (to 4 bytes) is already zero
}

/** Some of a group's triangles in world space, 9 numbers each, placed by world (WorldTriangles). */
function worldTriangles(g, tris, world) {
  return tris.map((t) => {
    const f = new Float64Array(9);
    for (let j = 0; j < 3; j++) {
      const v = g.triangles[t * 3 + j] * 3, x = g.vertices[v], y = g.vertices[v + 1], z = g.vertices[v + 2];
      const q = world ? Affine.point(world, x, y, z) : [x, y, z];
      f[j * 3] = q[0]; f[j * 3 + 1] = q[1]; f[j * 3 + 2] = q[2];
    }
    return f;
  });
}

function hasArea(f, at) {
  const ux = f[at + 3] - f[at], uy = f[at + 4] - f[at + 1], uz = f[at + 5] - f[at + 2];
  const vx = f[at + 6] - f[at], vy = f[at + 7] - f[at + 1], vz = f[at + 8] - f[at + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const n2 = nx * nx + ny * ny + nz * nz;
  return n2 >= 1e-6 && !Number.isNaN(n2);
}

/** One Sutherland–Hodgman pass: the part of a convex polygon at or above (or at or below) p[axis] = bound. */
function clipAxis(poly, axis, bound, above) {
  const o = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const dp = above ? p[axis] - bound : bound - p[axis], dq = above ? q[axis] - bound : bound - q[axis];
    if (dp >= 0) o.push(p);
    if (dp >= 0 !== dq >= 0) {
      const t = dp / (dp - dq);
      const r = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
      r[axis] = bound;
      o.push(r);
    }
  }
  return o;
}

/**
 * Triangles (9 numbers each) cut along the tile lines so every piece lies inside one tile, as [[tileX, tileZ, pieces]]
 * in X-then-Z order (ClipToTiles). A piece lying on a tile line goes to the tile on its high side only.
 */
export function clipToTiles(tris) {
  const byTile = new Map();
  const add = (x, z, f) => {
    const key = `${x},${z}`;
    let t = byTile.get(key);
    if (!t) byTile.set(key, (t = [x, z, []]));
    t[2].push(f);
  };
  for (const f of tris) {
    const x0 = Math.min(f[0], f[3], f[6]), x1 = Math.max(f[0], f[3], f[6]);
    const z0 = Math.min(f[2], f[5], f[8]), z1 = Math.max(f[2], f[5], f[8]);
    const ix0 = Math.floor(x0 / COLLISION_TILE), ix1 = Math.floor(x1 / COLLISION_TILE);
    const iz0 = Math.floor(z0 / COLLISION_TILE), iz1 = Math.floor(z1 / COLLISION_TILE);
    if (ix0 === ix1 && iz0 === iz1) {
      add(ix0, iz0, f);
      continue;
    }
    const tri = [[f[0], f[1], f[2]], [f[3], f[4], f[5]], [f[6], f[7], f[8]]];
    for (let ix = ix0; ix <= ix1; ix++)
      for (let iz = iz0; iz <= iz1; iz++) {
        const lx = ix * COLLISION_TILE, hx = lx + COLLISION_TILE, lz = iz * COLLISION_TILE, hz = lz + COLLISION_TILE;
        const poly = clipAxis(clipAxis(clipAxis(clipAxis(tri, 0, lx, true), 0, hx, false), 2, lz, true), 2, hz, false);
        if (poly.length < 3) continue;
        let cx = 0, cz = 0;
        for (const q of poly) {
          cx += q[0];
          cz += q[2];
        }
        cx /= poly.length;
        cz /= poly.length;
        if (cx >= hx || cz >= hz) continue; // lies on the high tile line: the next tile has it
        for (let i = 1; i + 1 < poly.length; i++) {
          const piece = [...poly[0], ...poly[i], ...poly[i + 1]];
          if (hasArea(piece, 0)) add(ix, iz, piece);
        }
      }
  }
  return [...byTile.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * Collision groups for free triangles (9 numbers each): cut to tiles, one group per tile (≤ 20000 triangles), corners
 * at the same float spot shared, with the CCH node words of node (TileGroups).
 */
function tileGroups(node, tris, count) {
  const groups = [];
  for (const [, , pieces] of clipToTiles(tris))
    for (let k = 0; k < pieces.length; k += TILE_MAX_TRIANGLES) {
      const n = Math.min(TILE_MAX_TRIANGLES, pieces.length - k);
      const verts = [], shared = new Map(), idx = [], keep = [];
      for (let t = 0; t < n; t++) {
        const f = pieces[k + t], c = [0, 0, 0];
        for (let j = 0; j < 3; j++) {
          const x = Math.fround(f[j * 3]), y = Math.fround(f[j * 3 + 1]), z = Math.fround(f[j * 3 + 2]);
          const key = `${x},${y},${z}`;
          let v = shared.get(key);
          if (v === undefined) {
            v = verts.length / 3;
            shared.set(key, v);
            verts.push(x, y, z);
          }
          c[j] = v;
        }
        if (c[0] === c[1] || c[1] === c[2] || c[0] === c[2]) continue; // collapsed by float rounding
        keep.push(idx.length / 3);
        idx.push(...c);
      }
      if (!keep.length) continue;
      groups.push(buildGroup({ node, vertices: verts, triangles: idx }, keep, null, null));
      if (count) count.written += keep.length;
    }
  return groups;
}

/**
 * A layer's .ccp with the edited objects' triangles moved along (or dropped for hidden ones), or null when nothing in it
 * changes (PatchCollision). owners: the owning object index of every triangle in file order across the groups, -1 for
 * none (the map editor's matching, the desktop's TriangleOwner). objects: the editor's objects, indexed like the edits'
 * shape. removed: per triangle in file order, truthy for the ones erased by hand (ColNav's RemovedCollision), or null.
 * report gains warnings, log lines and triangle counts.
 */
export function patchCollision(d, name, edits, objects, owners, report, removed = null) {
  report.warnings ??= [];
  report.log ??= [];
  const groups = parseCollisionGroups(d);
  if (!groups) {
    report.warnings.push(`${name} has an unfamiliar layout, so its collision was left as it was.`);
    return null;
  }
  const dv = view(d);
  if (u32(dv, 12) !== groups.length) {
    report.warnings.push(`${name}: its node count doesn't match its group list, so its collision was left as it was.`);
    return null;
  }
  const firstTri = [];
  let triCount = 0;
  for (const g of groups) {
    firstTri.push(triCount);
    triCount += g.triangles.length / 3;
  }
  // Triangles erased by hand (numbered across the groups in file order, as the editor reads them).
  if (removed && removed.length !== triCount) {
    report.warnings.push(`${name}: the collision erased by hand doesn't match this file's triangles, so it was kept.`);
    removed = null;
  }
  const handGroups = new Uint8Array(groups.length);
  let handTotal = 0;
  if (removed)
    groups.forEach((g, gi) => {
      for (let t = 0, tc = g.triangles.length / 3; t < tc; t++)
        if (removed[firstTri[gi] + t]) {
          handGroups[gi] = 1;
          handTotal++;
        }
    });
  const gone = (gi, t) => handGroups[gi] && removed[firstTri[gi] + t];
  const editOf = new Map();
  if (edits.length && (!owners || owners.length !== triCount)) {
    report.warnings.push(`${name}: the collision matching doesn't fit this file, so the edited objects' collision stays where it was.`);
    if (!handTotal) return null;
  } else for (const e of edits) if (e && e.shape != null && objects[e.shape]) editOf.set(e.shape, e);
  // Shapes that matter: the edited objects, at their stock place (what the collision was matched against).
  const wanted = [];
  for (const i of editOf.keys()) {
    const o = objects[i];
    const s = makeShape(i, o.mesh.baked?.positions ?? o.mesh.positions, o.triangles);
    if (ensureBounds(s)) wanted.push(s);
  }
  if (!wanted.length && !handTotal) return null;

  // Owners that move, only for groups near an edited shape (as the desktop limits its matching).
  const own = new Array(groups.length).fill(null);
  let ownedTotal = 0;
  groups.forEach((g, gi) => {
    if (!wanted.some((s) => groupNear(g, s, 100.0))) return;
    const tc = g.triangles.length / 3, base = firstTri[gi];
    let a = null;
    for (let t = 0; t < tc; t++) {
      const si = owners[base + t];
      if (si < 0 || !editOf.has(si)) continue;
      a ??= new Int32Array(tc).fill(-1);
      a[t] = si;
      ownedTotal++;
    }
    own[gi] = a;
  });
  if (!ownedTotal && !handTotal) return null;

  let moved = 0, dropped = 0, erased = 0, newGroups = 0, droppedGroups = 0;
  const out = [];
  groups.forEach((g, gi) => {
    let a = own[gi];
    if (!a && !handGroups[gi]) {
      out.push(d.subarray(g.start, g.start + g.length));
      return;
    }
    a ??= new Int32Array(g.triangles.length / 3).fill(-1);
    const stays = [], byShape = new Map();
    let leaving = false;
    for (let t = 0; t < a.length; t++) {
      if (gone(gi, t)) {
        // Erased by hand: neither stays nor travels with its object.
        leaving = true;
        erased++;
        continue;
      }
      const si = a[t];
      if (si < 0) stays.push(t);
      else {
        leaving = true;
        if (!byShape.has(si)) byShape.set(si, []);
        byShape.get(si).push(t);
      }
    }
    // What stays keeps the authored sphere and box (they still enclose a subset); an emptied group is dropped.
    if (!leaving) out.push(d.subarray(g.start, g.start + g.length));
    else if (stays.length) {
      const kept = [];
      for (let k = 0; k < 43; k++) kept.push(f32(dv, g.ccb + k * 4));
      out.push(buildGroup(g, stays, null, kept));
    } else droppedGroups++;
    for (const si of [...byShape.keys()].sort((x, y) => x - y)) {
      const e = editOf.get(si), tris = byShape.get(si);
      if (e.deleted) dropped += tris.length;
      else {
        const placed = tileGroups(g.node, worldTriangles(g, tris, e.world));
        out.push(...placed);
        moved += tris.length;
        newGroups += placed.length;
      }
    }
  });
  if (!out.length) {
    // An empty collision file crashes the game while it sizes its collision heap; keep the first group.
    out.push(d.subarray(groups[0].start, groups[0].start + groups[0].length));
    report.warnings.push(`${name}: kept one collision group, as the game can't load a stage file with none.`);
  }
  report.trianglesMoved = (report.trianglesMoved || 0) + moved;
  report.trianglesRemoved = (report.trianglesRemoved || 0) + dropped;
  report.trianglesErased = (report.trianglesErased || 0) + erased;
  report.log.push(
    `${name}: ${moved} triangle(s) moved (${newGroups} new group(s)), ${dropped} removed, ${erased} erased by hand, ` +
      `${droppedGroups} emptied group(s) dropped; ` +
      `${groups.length} -> ${out.length} groups`,
  );

  let total = 0x10;
  for (const b of out) total += b.length;
  const result = new Uint8Array(total);
  result.set(d.subarray(0, 0x10), 0);
  let at = 0x10;
  for (const b of out) {
    result.set(b, at);
    at += b.length;
  }
  const rv = view(result);
  rv.setUint32(8, total, true);
  rv.setUint32(12, out.length, true);
  return result;
}

/**
 * The entries without the .mtf collision copies of the layers whose .ccp changed (DropStaleCollisionCopies): they hold
 * the old ground's collision. Returns {entries, dropped: [names]}.
 */
export function dropStaleCollisionCopies(entries, changedNames) {
  const stem = (n) => n.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '').toLowerCase();
  const changed = new Set(changedNames.filter((n) => /\.ccp$/i.test(n)).map(stem));
  if (!changed.size) return { entries, dropped: [] };
  const dropped = [];
  const kept = entries.filter((e) => {
    const gone = /\.mtf$/i.test(e?.name || '') && changed.has(stem(e.name));
    if (gone) dropped.push(e.name);
    return !gone;
  });
  return { entries: dropped.length ? kept : entries, dropped };
}

// ===================== Solid objects: collision generated from their own shapes =====================

/** Layers a Solid object's generated triangles go into (SolidLayers): characters (_Chit) and the environment (_Ehit). */
export const SOLID_LAYERS = ['_chit.ccp', '_ehit.ccp'];
/** Longest collision edge written (MaxCollisionEdge): shipped stages have none over 1714, and characters fall through
 * a long one. */
const MAX_COLLISION_EDGE = 1500;

const placeAt = (world, p, at) => (world ? Affine.point(world, p[at], p[at + 1], p[at + 2]) : [p[at], p[at + 1], p[at + 2]]);
const dist = (x, y) => Math.sqrt((x[0] - y[0]) * (x[0] - y[0]) + (x[1] - y[1]) * (x[1] - y[1]) + (x[2] - y[2]) * (x[2] - y[2]));
const longest = (a, b, c) => Math.max(dist(a, b), Math.max(dist(b, c), dist(c, a)));
/** A solid's triangle list; null means its positions are a triangle soup (3 corners per triangle, in order). */
const trianglesOf = (so) => so.triangles ?? Uint32Array.from({ length: so.positions.length / 3 }, (_, i) => i);

/**
 * A solid ({name, positions, triangles?, world}) with every triangle longer than 1500 cut into a k×k grid of smaller
 * ones, placed, so the object's scale counts (CollisionSized); zero-area triangles are dropped. The solid itself when no
 * triangle is too long.
 */
function collisionSized(so) {
  const p = so?.positions;
  if (!p) return so;
  const tri = trianglesOf(so);
  const ok = (a, b, c) => a >= 0 && b >= 0 && c >= 0 && a + 2 < p.length && b + 2 < p.length && c + 2 < p.length;
  let cut = false;
  for (let t = 0; t + 2 < tri.length && !cut; t += 3) {
    const a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3;
    if (!ok(a, b, c)) continue;
    cut = longest(placeAt(so.world, p, a), placeAt(so.world, p, b), placeAt(so.world, p, c)) > MAX_COLLISION_EDGE;
  }
  if (!cut) return so;
  const pos = [], idx = [];
  for (let t = 0; t + 2 < tri.length; t += 3) {
    const a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3;
    if (!ok(a, b, c)) continue;
    const pa = placeAt(so.world, p, a), pb = placeAt(so.world, p, b), pc = placeAt(so.world, p, c);
    const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2], vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz < 1e-6 || Number.isNaN(nx + ny + nz)) continue;
    const k = Math.max(1, Math.ceil(longest(pa, pb, pc) / MAX_COLLISION_EDGE));
    // Grid point (i, j) = a + u·i/k + v·j/k for i + j <= k; triangles keep the source winding.
    const first = pos.length / 3;
    const at = (i, j) => first + i * (k + 1) - (i * (i - 1)) / 2 + j;
    for (let i = 0; i <= k; i++)
      for (let j = 0; j <= k - i; j++)
        pos.push(
          Math.fround(pa[0] + (ux * i + vx * j) / k),
          Math.fround(pa[1] + (uy * i + vy * j) / k),
          Math.fround(pa[2] + (uz * i + vz * j) / k),
        );
    for (let i = 0; i < k; i++)
      for (let j = 0; j < k - i; j++) {
        idx.push(at(i, j), at(i + 1, j), at(i, j + 1));
        if (j < k - i - 1) idx.push(at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
      }
  }
  return { name: so.name, world: null, positions: Float32Array.from(pos), triangles: Int32Array.from(idx) };
}

/** A solid's usable triangles, placed (9 numbers each); zero-area ones carry no surface (SolidTriangles). */
function solidTriangles(so) {
  const tris = [], p = so?.positions;
  if (!p) return tris;
  const tri = trianglesOf(so);
  for (let t = 0; t + 2 < tri.length; t += 3) {
    const a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3;
    if (a < 0 || b < 0 || c < 0 || a + 2 >= p.length || b + 2 >= p.length || c + 2 >= p.length) continue;
    const f = [...placeAt(so.world, p, a), ...placeAt(so.world, p, b), ...placeAt(so.world, p, c)];
    if (hasArea(f, 0)) tris.push(f);
  }
  return tris;
}

/** Placed triangles moved flat to their median corner height; ones left with no ground area dropped (FlatTriangles). */
function flatTriangles(tris) {
  if (!tris.length) return tris;
  const ys = [];
  for (const f of tris) ys.push(f[1], f[4], f[7]);
  ys.sort((a, b) => a - b);
  const y = ys[ys.length >> 1];
  const flat = [];
  for (const f of tris) {
    const g = f.slice();
    g[1] = g[4] = g[7] = y;
    const ax = g[3] - g[0], az = g[5] - g[2], bx = g[6] - g[0], bz = g[8] - g[2];
    if (Math.abs(ax * bz - az * bx) > 1e-3) flat.push(g);
  }
  return flat;
}

/**
 * Generated collision for Solid objects (SolidCollision): each solid's own triangles placed like it, cut to edges of at
 * most 1500 and split into 1000-unit tiles like the authored groups. layers: [{name, data}] (the stage's .ccp payloads;
 * only _Chit and _Ehit are used). A solid is {name, positions, triangles? (null: a triangle soup), world (3×4 or null),
 * attribute? (CCH +4: 0 plain, 200 water that drowns, 300 magma), onlyLayer?, flatten?}. Each group copies the CCH node
 * words of an attribute-0 group of its file. Returns Map layer name → [group bytes]; report gains warnings, a log line,
 * collisionTrianglesGenerated (per layer) and solidObjects.
 */
export function solidCollision(layers, solids, report) {
  report.warnings ??= [];
  report.log ??= [];
  const result = new Map();
  if (!solids?.length) return result;
  const targets = [];
  for (const l of layers) {
    const lower = l.name.toLowerCase();
    if (!SOLID_LAYERS.some((x) => lower.endsWith(x))) continue;
    const groups = parseCollisionGroups(l.data);
    if (!groups?.length) {
      report.warnings.push(`${l.name} has an unfamiliar layout, so Solid objects add no collision to it.`);
      continue;
    }
    const node = (groups.find((g) => g.attribute === 0) ?? groups[0]).node.slice();
    node[1] = 0; // plain surface
    targets.push({ name: l.name, node });
  }
  if (!targets.length) {
    report.warnings.push('This stage has no character / environment collision layer, so Solid objects add no collision.');
    return result;
  }
  let objects = 0, triangles = 0, special = 0;
  for (const solid of solids) {
    let tris = solidTriangles(collisionSized(solid));
    if (solid.flatten) tris = flatTriangles(tris);
    if (!tris.length) continue;
    objects++;
    if (solid.attribute) special++;
    const count = { written: 0 };
    for (const t of targets) {
      if (solid.onlyLayer && !t.name.toLowerCase().endsWith(solid.onlyLayer.toLowerCase())) continue;
      let node = t.node;
      if (solid.attribute) {
        node = node.slice();
        node[1] = solid.attribute >>> 0;
      }
      if (!result.has(t.name)) result.set(t.name, []);
      count.written = 0; // per layer, as the desktop counts it
      for (const g of tileGroups(node, tris, count)) result.get(t.name).push(g);
    }
    triangles += count.written;
  }
  report.collisionTrianglesGenerated = (report.collisionTrianglesGenerated || 0) + triangles;
  report.solidObjects = (report.solidObjects || 0) + objects;
  report.log.push(
    `solid: ${objects} object(s) (${special} water / magma), ${triangles} generated triangle(s) per layer into ${targets.length} layer(s)`,
  );
  return result;
}

/** A .ccp with groups appended after its own, its size and group count updated (AppendCollisionGroups). */
export function appendCollisionGroups(d, groups) {
  let total = d.length;
  for (const g of groups) total += g.length;
  const o = new Uint8Array(total);
  o.set(d, 0);
  let at = d.length;
  for (const g of groups) {
    o.set(g, at);
    at += g.length;
  }
  const dv = view(o);
  dv.setUint32(8, total, true);
  dv.setUint32(12, (u32(view(d), 12) + groups.length) >>> 0, true);
  return o;
}
