// Matching collision triangles to the objects they belong to, ported from HappyTool/RrmConvert/StageEditBaker.cs
// (GroupOwners, TriangleOwner, EnclosingOwner, TriangleGrid, PointTriangleDistance2) so the map editor's collision follows
// moved and hidden objects exactly as the desktop's does (StageViewerForm.Collision.cs). Each triangle goes to the object
// whose surface it lies on (mean distance of its corners and centre, tolerance max(30, 0.2 × size)); failing that, to the
// smallest object whose box encloses it; failing that, to a surface within three times the tolerance. No DOM: it runs in
// a worker (stage-collision-worker.js).

/** The last tier's tolerance factor (LooseTolerance). */
const LOOSE_TOLERANCE = 3.0;
/** Objects at least this wide (X or Z) are ground: they never claim collision by enclosure (EnclosingMaxSize). */
const ENCLOSING_MAX_SIZE = 6000.0;
const NEVER = 0x7fffffff; // int.MaxValue: a triangle with a corner outside the positions, never tested

/** A movable object as a matching shape (SceneShape): its mesh's positions, its triangles (indices into them), its index. */
export const makeShape = (index, positions, triangles) => ({
  index, positions, triangles, hasBounds: false, minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0, grid: null,
});

/** The box of the vertices the shape's triangles use; false when it has none (EnsureBounds). */
export function ensureBounds(s) {
  if (s.hasBounds) return s.minX <= s.maxX;
  s.hasBounds = true;
  s.minX = s.minY = s.minZ = Number.MAX_VALUE;
  s.maxX = s.maxY = s.maxZ = -Number.MAX_VALUE;
  const P = s.positions, T = s.triangles;
  if (!P || !T) return false;
  for (let i = 0; i < T.length; i++) {
    const p = T[i] * 3;
    if (p < 0 || p + 2 >= P.length) continue;
    const x = P[p], y = P[p + 1], z = P[p + 2];
    if (x < s.minX) s.minX = x;
    if (x > s.maxX) s.maxX = x;
    if (y < s.minY) s.minY = y;
    if (y > s.maxY) s.maxY = y;
    if (z < s.minZ) s.minZ = z;
    if (z > s.maxZ) s.maxZ = z;
  }
  return s.minX <= s.maxX;
}

const overlaps = (x0, y0, z0, x1, y1, z1, s, m) =>
  x0 <= s.maxX + m && x1 >= s.minX - m && y0 <= s.maxY + m && y1 >= s.minY - m && z0 <= s.maxZ + m && z1 >= s.minZ - m;

/** Distance from a point to a shape's box (0 inside). */
function boxDistance(s, x, y, z) {
  const dx = x < s.minX ? s.minX - x : x > s.maxX ? x - s.maxX : 0;
  const dy = y < s.minY ? s.minY - y : y > s.maxY ? y - s.maxY : 0;
  const dz = z < s.minZ ? s.minZ - z : z > s.maxZ ? z - s.maxZ : 0;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

const dist = (ax, ay, az, bx, by, bz) => Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by) + (az - bz) * (az - bz));

/** Squared distance from a point to a triangle (closest-point regions, Ericson §5.1.5). */
export function pointTriangleDistance2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) {
    qx = ax; qy = ay; qz = az;
  } else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) {
      qx = bx; qy = by; qz = bz;
    } else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const v = d1 / (d1 - d3);
      qx = ax + abx * v; qy = ay + aby * v; qz = az + abz * v;
    } else if (d6 >= 0 && d5 <= d6) {
      qx = cx; qy = cy; qz = cz;
    } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const w = d2 / (d2 - d6);
      qx = ax + acx * w; qy = ay + acy * w; qz = az + acz * w;
    } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
      qx = bx + (cx - bx) * w; qy = by + (cy - by) * w; qz = bz + (cz - bz) * w;
    } else {
      const denom = va + vb + vc;
      if (Math.abs(denom) < 1e-30) {
        qx = ax; qy = ay; qz = az;
      } else {
        const v = vb / denom, w = vc / denom;
        qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

const gap = (v, lo, hi) => (v < lo ? lo - v : v > hi ? v - hi : 0);

/**
 * A uniform grid over one shape's triangles for nearest-surface queries (TriangleGrid). Cells are keyed relative to the
 * shape's lowest cell, which holds every triangle; a triangle spanning more than 512 cells is kept apart and always
 * tested.
 */
class TriangleGrid {
  constructor(s) {
    this.s = s;
    const ext = Math.max(s.maxX - s.minX, Math.max(s.maxY - s.minY, s.maxZ - s.minZ));
    const cell = (this.cell = Math.max(25.0, ext / 24.0));
    this.x0 = Math.floor(s.minX / cell);
    this.y0 = Math.floor(s.minY / cell);
    this.z0 = Math.floor(s.minZ / cell);
    this.nx = Math.floor(s.maxX / cell) - this.x0 + 1;
    this.ny = Math.floor(s.maxY / cell) - this.y0 + 1;
    this.nz = Math.floor(s.maxZ / cell) - this.z0 + 1;
    this.cells = new Map();
    this.cellList = [];
    this.huge = [];
    const P = s.positions, T = s.triangles, tris = Math.trunc(T.length / 3);
    this.stamp = new Int32Array(tris);
    this.query = 0;
    for (let t = 0; t < tris; t++) {
      const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
      if (a + 2 >= P.length || b + 2 >= P.length || c + 2 >= P.length) {
        this.stamp[t] = NEVER;
        continue;
      }
      const x0 = this.cellOf(Math.min(P[a], P[b], P[c])), x1 = this.cellOf(Math.max(P[a], P[b], P[c]));
      const y0 = this.cellOf(Math.min(P[a + 1], P[b + 1], P[c + 1])), y1 = this.cellOf(Math.max(P[a + 1], P[b + 1], P[c + 1]));
      const z0 = this.cellOf(Math.min(P[a + 2], P[b + 2], P[c + 2])), z1 = this.cellOf(Math.max(P[a + 2], P[b + 2], P[c + 2]));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 512) {
        this.huge.push(t);
        continue;
      }
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          for (let z = z0; z <= z1; z++) {
            const key = this.key(x, y, z);
            let cell = this.cells.get(key);
            if (!cell) {
              cell = { x, y, z, tris: [] };
              this.cells.set(key, cell);
              this.cellList.push(cell);
            }
            cell.tris.push(t);
          }
    }
  }

  cellOf(v) {
    return Math.floor(v / this.cell);
  }

  /** The cell's key, or -1 outside the shape's cells (where no triangle is). */
  key(x, y, z) {
    const i = x - this.x0, j = y - this.y0, k = z - this.z0;
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return -1;
    return (i * this.ny + j) * this.nz + k;
  }

  /** Distance from a point to the nearest triangle, or cap when none is closer. */
  distance(px, py, pz, cap) {
    if (++this.query === NEVER) {
      this.stamp.fill(0);
      this.query = 1;
    }
    let best2 = cap * cap;
    for (const t of this.huge) best2 = this.test(t, px, py, pz, best2);
    const x0 = this.cellOf(px - cap), x1 = this.cellOf(px + cap);
    const y0 = this.cellOf(py - cap), y1 = this.cellOf(py + cap);
    const z0 = this.cellOf(pz - cap), z1 = this.cellOf(pz + cap);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > this.cellList.length) {
      // A wide search over a sparse grid: visit the occupied cells, skipping any farther than the best so far.
      for (const cell of this.cellList) {
        if (this.cellDistance2(cell, px, py, pz) >= best2) continue;
        for (const t of cell.tris) best2 = this.test(t, px, py, pz, best2);
      }
    } else {
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          for (let z = z0; z <= z1; z++) {
            const key = this.key(x, y, z);
            const cell = key < 0 ? undefined : this.cells.get(key);
            if (!cell || this.cellDistance2(cell, px, py, pz) >= best2) continue;
            for (const t of cell.tris) best2 = this.test(t, px, py, pz, best2);
          }
    }
    return Math.sqrt(best2);
  }

  cellDistance2(c, px, py, pz) {
    const w = this.cell;
    const dx = gap(px, c.x * w, (c.x + 1) * w), dy = gap(py, c.y * w, (c.y + 1) * w), dz = gap(pz, c.z * w, (c.z + 1) * w);
    return dx * dx + dy * dy + dz * dz;
  }

  test(t, px, py, pz, best2) {
    const st = this.stamp[t];
    if (st === this.query || st === NEVER) return best2;
    this.stamp[t] = this.query;
    const P = this.s.positions, T = this.s.triangles;
    const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
    const d2 = pointTriangleDistance2(px, py, pz, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]);
    return d2 < best2 ? d2 : best2;
  }
}

/** The shape whose surface the triangle lies on, within max(30, 0.2 × size) × tolScale; null when none is close enough. */
function surfaceOwner(ax, ay, az, bx, by, bz, cx, cy, cz, cands, tolScale = 1.0) {
  const size = Math.max(dist(ax, ay, az, bx, by, bz), Math.max(dist(bx, by, bz, cx, cy, cz), dist(cx, cy, cz, ax, ay, az)));
  // Collision is a simplified copy of the visible surface: corners sit within a few tens of units of it.
  const tol = Math.max(30.0, size * 0.2) * tolScale, cap = tol * 2.0;
  const x0 = Math.min(ax, bx, cx), y0 = Math.min(ay, by, cy), z0 = Math.min(az, bz, cz);
  const x1 = Math.max(ax, bx, cx), y1 = Math.max(ay, by, cy), z1 = Math.max(az, bz, cz);
  const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;
  // Nearest box first: the mean distance to a shape's box bounds the mean distance to its surface from below.
  const order = [];
  for (const s of cands) {
    if (!overlaps(x0, y0, z0, x1, y1, z1, s, cap)) continue;
    const lb =
      (Math.min(boxDistance(s, ax, ay, az), cap) + Math.min(boxDistance(s, bx, by, bz), cap) +
        Math.min(boxDistance(s, cx, cy, cz), cap) + Math.min(boxDistance(s, mx, my, mz), cap)) / 4;
    order.push({ lb, s });
  }
  // Ties (a triangle on two coincident surfaces) go to the lower shape index.
  order.sort((p, q) => (p.lb !== q.lb ? p.lb - q.lb : p.s.index - q.s.index));
  let best = Number.MAX_VALUE, owner = null;
  for (const { lb, s } of order) {
    if (lb > best || lb > tol) break;
    if (!s.grid) s.grid = new TriangleGrid(s);
    const limit = Math.min(best, cap) * 4;
    let sum = s.grid.distance(ax, ay, az, cap);
    if (sum >= limit) continue;
    sum += s.grid.distance(bx, by, bz, cap);
    if (sum >= limit) continue;
    sum += s.grid.distance(cx, cy, cz, cap);
    if (sum >= limit) continue;
    sum += s.grid.distance(mx, my, mz, cap);
    const score = sum / 4;
    if (score < best) {
      best = score;
      owner = s;
    }
  }
  return owner && best <= tol ? owner : null;
}

const inside = (s, m, v, p) =>
  v[p] >= s.minX - m && v[p] <= s.maxX + m && v[p + 1] >= s.minY - m && v[p + 1] <= s.maxY + m && v[p + 2] >= s.minZ - m && v[p + 2] <= s.maxZ + m;

/** The smallest shape (by box diagonal) whose box, grown by a tenth of its size (at least 60), holds all three corners. */
function enclosingOwner(v, a, b, c, cands) {
  let best = null, bestDiag = Number.MAX_VALUE;
  for (const s of cands) {
    const sx = s.maxX - s.minX, sy = s.maxY - s.minY, sz = s.maxZ - s.minZ;
    if (sx >= ENCLOSING_MAX_SIZE || sz >= ENCLOSING_MAX_SIZE) continue;
    const diag = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (diag > bestDiag || (diag === bestDiag && best && s.index > best.index)) continue;
    const m = Math.max(60.0, 0.1 * Math.max(sx, Math.max(sy, sz)));
    if (inside(s, m, v, a) && inside(s, m, v, b) && inside(s, m, v, c)) {
      best = s;
      bestDiag = diag;
    }
  }
  return best;
}

/** A group triangle's owner: its surface, else the smallest box enclosing it, else a surface within 3× the tolerance. */
function triangleOwner(g, t, cands) {
  const v = g.vertices;
  const a = g.triangles[t * 3] * 3, b = g.triangles[t * 3 + 1] * 3, c = g.triangles[t * 3 + 2] * 3;
  return (
    surfaceOwner(v[a], v[a + 1], v[a + 2], v[b], v[b + 1], v[b + 2], v[c], v[c + 1], v[c + 2], cands) ??
    enclosingOwner(v, a, b, c, cands) ??
    surfaceOwner(v[a], v[a + 1], v[a + 2], v[b], v[b + 1], v[b + 2], v[c], v[c + 1], v[c + 2], cands, LOOSE_TOLERANCE)
  );
}

/**
 * The object a free-standing triangle (a nav cell's 9 corner values) lies on, by the surface rule alone; -1 when
 * nothing is close enough (OwnerOfTriangle).
 */
export function navCellOwner(v, shapes) {
  const x0 = Math.min(v[0], v[3], v[6]), x1 = Math.max(v[0], v[3], v[6]);
  const y0 = Math.min(v[1], v[4], v[7]), y1 = Math.max(v[1], v[4], v[7]);
  const z0 = Math.min(v[2], v[5], v[8]), z1 = Math.max(v[2], v[5], v[8]);
  const cands = [];
  for (const s of shapes) if (s && ensureBounds(s) && overlaps(x0, y0, z0, x1, y1, z1, s, 200.0)) cands.push(s);
  if (!cands.length) return -1;
  const owner = surfaceOwner(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], cands);
  return owner ? owner.index : -1;
}

/** The object whose surface is nearest a point (a waypoint), closer than tol; -1 when none. Ties go to the earlier shape (OwnerOfPoint). */
export function pointOwner(x, y, z, shapes, tol) {
  let best = tol, owner = -1;
  for (const s of shapes) {
    if (!s || !ensureBounds(s) || boxDistance(s, x, y, z) >= best) continue;
    if (!s.grid) s.grid = new TriangleGrid(s);
    const d = s.grid.distance(x, y, z, best);
    if (d < best) {
      best = d;
      owner = s.index;
    }
  }
  return owner;
}

/**
 * The owning shape index of every triangle of a group ({vertices, triangles, minX…maxZ}), -1 where no object is close
 * enough (GroupOwners). Shapes must have index set to their list position.
 */
export function groupOwners(g, shapes) {
  const n = Math.trunc(g.triangles.length / 3);
  const own = new Int32Array(n).fill(-1);
  const cands = [];
  for (const s of shapes)
    if (s && ensureBounds(s) && overlaps(g.minX, g.minY, g.minZ, g.maxX, g.maxY, g.maxZ, s, 200.0)) cands.push(s);
  if (!cands.length) return own;
  for (let t = 0; t < n; t++) {
    const s = triangleOwner(g, t, cands);
    if (s) own[t] = s.index;
  }
  return own;
}
