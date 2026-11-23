// Terraforming (StageViewerForm.Terraform.cs; the grid is RrmConvert.StageSculpt): height changes on a regular grid over
// the stage's ground, painted with a brush. Ground pieces that sit where the stage has them follow the grid vertex by
// vertex (their normals tilt with the slope); everything else rides on the change under its footprint centre. The grid
// is kept in the edits file as Sculpt {OriginX, OriginZ, Cell, Width, Depth, Data}, Data being the float32 heights
// deflated (raw, as .NET's DeflateStream writes) and base64'd.
import { boundsOf, isIdentityTransform, placePoint } from './stage-edit.js';
import { deflateRaw } from '../formats/zip.js';

export const BRUSH_TOOLS = ['Raise / lower', 'Smooth', 'Flatten', 'Restore'];
export const RAISE = 0, SMOOTH = 1, FLATTEN = 2, RESTORE = 3;
export const MIN_BRUSH = 150, MAX_BRUSH = 6000;
export const MIN_STRENGTH = 0.25, MAX_STRENGTH = 4;
/** Brush colours (DrawBrush), as 0-255 RGB: raise, lower, smooth, flatten, restore. */
export const BRUSH_COLOURS = { raise: [115, 255, 128], lower: [255, 140, 77], 1: [115, 204, 255], 2: [255, 230, 89], 3: [217, 153, 255] };
const MAX_GRAB = 3000; // MaxGrabSize: a piece this wide counts as ground unless it's a building
const LIMIT = 6000; // the most a point is raised or lowered

/** C#'s Math.Round (halves go to the even number). */
const roundEven = (v) => {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 && r % 2 ? r - 1 : r;
};

export class Sculpt {
  constructor(originX, originZ, cell, width, depth, delta = null) {
    this.originX = originX;
    this.originZ = originZ;
    this.cell = cell;
    this.width = width;
    this.depth = depth;
    this.delta = delta || new Float32Array(width * depth);
  }
  static cover(minX, minZ, maxX, maxZ, cell) {
    const ox = Math.floor(minX / cell) * cell, oz = Math.floor(minZ / cell) * cell;
    return new Sculpt(ox, oz, cell, Math.ceil((maxX - ox) / cell) + 2, Math.ceil((maxZ - oz) / cell) + 2);
  }
  get isEmpty() {
    for (const d of this.delta) if (d !== 0) return false;
    return true;
  }
  get(x, z) {
    return x < 0 || z < 0 || x >= this.width || z >= this.depth ? 0 : this.delta[z * this.width + x];
  }
  /** The change at a world point: bilinear between grid points, zero outside. */
  at(x, z) {
    const fx = (x - this.originX) / this.cell, fz = (z - this.originZ) / this.cell;
    if (fx < -1 || fz < -1 || fx > this.width || fz > this.depth) return 0;
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    const a = this.get(ix, iz), b = this.get(ix + 1, iz), c = this.get(ix, iz + 1), d = this.get(ix + 1, iz + 1);
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }
  gradient(x, z) {
    const h = this.cell * 0.25;
    return [(this.at(x + h, z) - this.at(x - h, z)) / (2 * h), (this.at(x, z + h) - this.at(x, z - h)) / (2 * h)];
  }
  /** The grid points covering a world box, clamped to the grid; null when it misses. */
  range(x0, z0, x1, z1) {
    const ax = Math.max(0, Math.floor((x0 - this.originX) / this.cell)), bx = Math.min(this.width - 1, Math.ceil((x1 - this.originX) / this.cell));
    const az = Math.max(0, Math.floor((z0 - this.originZ) / this.cell)), bz = Math.min(this.depth - 1, Math.ceil((z1 - this.originZ) / this.cell));
    return ax > bx || az > bz ? null : { ax, bx, az, bz };
  }
  /** True when any point that influences the world box (x0, z0)-(x1, z1) is non-zero (Touches). */
  touches(x0, z0, x1, z1) {
    const ax = Math.max(0, Math.floor((x0 - this.originX) / this.cell)), bx = Math.min(this.width - 1, Math.ceil((x1 - this.originX) / this.cell));
    const az = Math.max(0, Math.floor((z0 - this.originZ) / this.cell)), bz = Math.min(this.depth - 1, Math.ceil((z1 - this.originZ) / this.cell));
    for (let z = az; z <= bz; z++) for (let x = ax; x <= bx; x++) if (this.delta[z * this.width + x] !== 0) return true;
    return false;
  }
  /** A copy of the points in a range (row by row). */
  copy({ ax, bx, az, bz }, src = this.delta) {
    const w = bx - ax + 1, out = new Float32Array(w * (bz - az + 1));
    for (let z = az; z <= bz; z++) out.set(src.subarray(z * this.width + ax, z * this.width + bx + 1), (z - az) * w);
    return out;
  }
  paste({ ax, bx, az, bz }, values) {
    const w = bx - ax + 1;
    for (let z = az; z <= bz; z++) this.delta.set(values.subarray((z - az) * w, (z - az + 1) * w), z * this.width + ax);
  }
  /** The world box a range of points influences (one cell around it). */
  box({ ax, bx, az, bz }) {
    const c = this.cell;
    return [this.originX + (ax - 1) * c, this.originZ + (az - 1) * c, this.originX + (bx + 1) * c, this.originZ + (bz + 1) * c];
  }
}

// ---------- which pieces are ground ----------

/** The positions an object had before any edit (the mesh's baked copy once one is kept). */
const stockPositions = (m) => m.baked?.positions ?? m.positions;

/** The object's bounds as the stage has it; null for an empty one. */
export function stockBounds(o) {
  if (o.tfBounds === undefined) o.tfBounds = o.vertexCount > 0 ? boundsOf(stockPositions(o.mesh), o.firstVertex, o.vertexCount) : null;
  return o.tfBounds;
}

/** The Forge's object categories (ObjectCategory, for the stage's own objects). */
export function objectCategory(o) {
  const l = (o.label || o.name || '').toLowerCase(), has = (...w) => w.some((x) => l.includes(x));
  const rrm = (o.name || '').includes('.rrm#v');
  if (rrm && has('ground', 'kiwa', 'cliff')) return 'Terrain';
  if (has('tree', 'mofu', 'alice', 'flower', 'grass', 'bush', 'plant', 'leaf', 'polymsh', 'cactus', 'palm')) return 'Nature';
  if (has('rock', 'stone', 'cliff')) return 'Rocks';
  if (has('castle', 'wall', 'gate', 'tower', 'step', 'bridge', 'fort', 'house', 'hut', 'roof', 'pillar')) return 'Buildings';
  if (has('water', 'fall', 'sea', 'river')) return 'Water';
  if (has('objset', 'prop', 'barrel', 'box', 'crate')) return 'Props';
  if (rrm) return 'Terrain';
  return 'Props';
}

/** The ground pieces (GroundFlags): the stage's terrain and water, and any piece 30 m wide that isn't a building. */
export function groundPieces(objects) {
  const out = new Set();
  for (const o of objects) {
    if (o.gimmick) continue;
    const b = stockBounds(o);
    if (!b) continue;
    const k = objectCategory(o);
    if (k === 'Terrain' || k === 'Water' || (Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) >= MAX_GRAB && k !== 'Buildings')) out.add(o);
  }
  return out;
}

/** A new empty grid over the ground pieces (EnsureSculpt): 10 m past them, a point every 1 m or more (1200 across). */
export function coverGround(ground) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const o of ground) {
    const b = stockBounds(o);
    x0 = Math.min(x0, b.min[0]);
    z0 = Math.min(z0, b.min[2]);
    x1 = Math.max(x1, b.max[0]);
    z1 = Math.max(z1, b.max[2]);
  }
  if (x0 > x1) return null;
  const cell = Math.max(100, Math.max(x1 - x0, z1 - z0) / 1200);
  return Sculpt.cover(x0 - 1000, z0 - 1000, x1 + 1000, z1 + 1000, roundEven(cell));
}

/** The stage's own ground height at every grid point (the highest ground triangle over it); NaN where there's none. */
export function groundHeights(sculpt, ground) {
  const g = sculpt, h = new Float32Array(g.width * g.depth).fill(NaN);
  for (const o of ground) {
    const pos = stockPositions(o.mesh), tri = o.triangles;
    for (let t = 0; t + 2 < tri.length; t += 3) {
      const a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3;
      const ax = pos[a], az = pos[a + 2], bx = pos[b], bz = pos[b + 2], cx = pos[c], cz = pos[c + 2];
      const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(den) < 1e-6) continue;
      const gx0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - g.originX) / g.cell));
      const gx1 = Math.min(g.width - 1, Math.floor((Math.max(ax, bx, cx) - g.originX) / g.cell));
      const gz0 = Math.max(0, Math.ceil((Math.min(az, bz, cz) - g.originZ) / g.cell));
      const gz1 = Math.min(g.depth - 1, Math.floor((Math.max(az, bz, cz) - g.originZ) / g.cell));
      for (let z = gz0; z <= gz1; z++)
        for (let x = gx0; x <= gx1; x++) {
          const px = g.originX + x * g.cell, pz = g.originZ + z * g.cell;
          const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / den;
          const l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / den;
          const l3 = 1 - l1 - l2;
          if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
          const y = Math.fround(l1 * pos[a + 1] + l2 * pos[b + 1] + l3 * pos[c + 1]);
          const k = z * g.width + x;
          if (Number.isNaN(h[k]) || y > h[k]) h[k] = y;
        }
    }
  }
  return h;
}

// ---------- showing it ----------

/**
 * Adds the grid to an object just written from its placement (writeObject's hook): a ground piece where the stage has
 * it gets the change at each vertex and its normals tilted with the slope; anything else is lifted by the change under
 * the centre of its footprint.
 */
export function sculptObject(o, sculpt, isGround) {
  const m = o.mesh, pos = m.positions, nrm = m.normals, st = o.state;
  const a = o.firstVertex * 3, end = (o.firstVertex + o.vertexCount) * 3;
  if (isGround && isIdentityTransform(st)) {
    for (let i = a; i < end; i += 3) {
      const d = sculpt.at(pos[i], pos[i + 2]);
      if (d === 0) continue;
      pos[i + 1] += d;
      const [gx, gz] = sculpt.gradient(pos[i], pos[i + 2]);
      const tx = nrm[i] - gx * nrm[i + 1], ty = nrm[i + 1], tz = nrm[i + 2] - gz * nrm[i + 1], l2 = tx * tx + ty * ty + tz * tz;
      if (l2 > 1e-12) {
        const l = Math.sqrt(l2);
        nrm[i] = tx / l;
        nrm[i + 1] = ty / l;
        nrm[i + 2] = tz / l;
      }
    }
    return;
  }
  const lift = liftFor(o, sculpt);
  if (lift) for (let i = a + 1; i < end; i += 3) pos[i] += lift;
}

/** How far the grid lifts an object that rides on it (SculptLiftFor): the change under its footprint centre. */
export function liftFor(o, sculpt) {
  const b = stockBounds(o);
  if (!b || o.state.hidden) return 0;
  let foot = [(b.min[0] + b.max[0]) * 0.5, b.min[1], (b.min[2] + b.max[2]) * 0.5];
  if (!isIdentityTransform(o.state)) foot = placePoint(o.state, o.pivot, foot);
  return sculpt.at(foot[0], foot[2]);
}

/** Ground height under a brush-ring point (BrushGroundY): the stage's ground plus the change, the aim's height elsewhere. */
export function brushGroundY(sculpt, heights, x, z, fallback) {
  if (!sculpt || !heights) return fallback;
  const ix = Math.round((x - sculpt.originX) / sculpt.cell), iz = Math.round((z - sculpt.originZ) / sculpt.cell);
  if (ix < 0 || iz < 0 || ix >= sculpt.width || iz >= sculpt.depth) return fallback;
  const h = heights[iz * sculpt.width + ix];
  return Number.isNaN(h) ? fallback : h + sculpt.at(x, z);
}

// ---------- the brush ----------

/**
 * One frame of brush (ApplyBrush) at world point at with radius r: raise (dir 1) or lower (dir -1), smooth, flatten to
 * flattenTo or restore. Returns the range of grid points it covered, or null when it misses the grid.
 */
export function brushStep(sculpt, heights, tool, dir, at, r, strength, dt, flattenTo) {
  const g = sculpt, rg = g.range(at[0] - r, at[2] - r, at[0] + r, at[2] + r);
  if (!rg) return null;
  const { ax, bx, az, bz } = rg;
  dt = Math.min(dt, 0.05);
  const rate = Math.fround(650 * strength * dt), k = Math.fround(Math.min(1, 5 * strength * dt));
  const d = g.delta, W = g.width;
  // Smooth reads the heights as they were before this frame: a copy of the points it reaches (two past the brush).
  let snap = null, sx = 0, sz = 0, sw = 0;
  if (tool === SMOOTH) {
    sx = Math.max(0, ax - 2);
    sz = Math.max(0, az - 2);
    const ex = Math.min(W - 1, bx + 2), ez = Math.min(g.depth - 1, bz + 2);
    sw = ex - sx + 1;
    snap = g.copy({ ax: sx, bx: ex, az: sz, bz: ez });
  }
  const total = (x, z, v) => {
    const gh = heights ? heights[z * W + x] : NaN;
    return Number.isNaN(gh) ? NaN : Math.fround(gh + v);
  };
  for (let z = az; z <= bz; z++)
    for (let x = ax; x <= bx; x++) {
      const px = g.originX + x * g.cell, pz = g.originZ + z * g.cell;
      const dist = Math.sqrt((px - at[0]) * (px - at[0]) + (pz - at[2]) * (pz - at[2]));
      if (dist >= r) continue;
      const t = Math.fround(dist / r), w = Math.fround(1 - t * t * (3 - 2 * t)), i = z * W + x;
      if (tool === RAISE) d[i] += dir * rate * w;
      else if (tool === SMOOTH) {
        const here = total(x, z, snap[(z - sz) * sw + (x - sx)]);
        if (Number.isNaN(here)) continue;
        let sum = 0, n = 0;
        for (let dz = -2; dz <= 2; dz++)
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx, zz = z + dz;
            if (xx < 0 || zz < 0 || xx >= W || zz >= g.depth) continue;
            const v = total(xx, zz, snap[(zz - sz) * sw + (xx - sx)]);
            if (!Number.isNaN(v)) {
              sum += v;
              n++;
            }
          }
        if (n > 0) d[i] += (sum / n - here) * k * w;
      } else if (tool === FLATTEN) {
        const here = total(x, z, d[i]);
        if (!Number.isNaN(here)) d[i] += (flattenTo - here) * k * w;
      } else {
        d[i] -= d[i] * k * w;
        if (Math.abs(d[i]) < 0.5) d[i] = 0;
      }
      d[i] = Math.max(-LIMIT, Math.min(LIMIT, d[i]));
    }
  return rg;
}

// ---------- export: the grid as a height warp ----------

const unit = (x, y, z, f) => {
  const l = Math.sqrt(x * x + y * y + z * z);
  return l < 1e-12 ? [f[0], f[1], f[2]] : [x / l, y / l, z / l];
};

/**
 * The terraforming as the bundle download writes it (StageHeightWarp.SculptOnly: no hills, every height in a column
 * moves by the grid): mapY gives a point's new height, normals go through the warp's inverse-transpose Jacobian and
 * tangents through its Jacobian. Null when nothing is sculpted.
 */
export function sculptWarp(sculpt) {
  if (!sculpt || sculpt.isEmpty) return null;
  return {
    sculpt,
    mapY: (x, y, z) => y + sculpt.at(x, z),
    moves: (x, y, z) => sculpt.at(x, z) !== 0,
    /** True when the warp can move anything inside the box (Affects). */
    affects: (x0, z0, x1, z1) => sculpt.touches(x0, z0, x1, z1),
    normal(x, y, z, n) {
      const [a, c] = sculpt.gradient(x, z);
      return unit(n[0] - a * n[1], n[1], n[2] - c * n[1], n);
    },
    tangent(x, y, z, t) {
      const [a, c] = sculpt.gradient(x, z);
      return unit(t[0], a * t[0] + t[1] + c * t[2], t[2], t);
    },
  };
}

/** Moves the nav cells' corners and the waypoints with the warp (StageHeightWarp.Apply). Returns {cells, waypoints} moved. */
export function warpNav(warp, nav, path) {
  let cells = 0, waypoints = 0;
  if (nav)
    for (const c of nav.cells) {
      let moved = false;
      for (let k = 0; k < 3; k++) {
        const y = c.v[k * 3 + 1], ny = warp.mapY(c.v[k * 3], y, c.v[k * 3 + 2]);
        if (ny !== y) {
          c.v[k * 3 + 1] = ny;
          moved = true;
        }
      }
      if (moved) cells++;
    }
  if (path)
    for (const n of path.nodes) {
      const ny = warp.mapY(n.x, n.y, n.z);
      if (ny !== n.y) {
        n.y = Math.fround(ny);
        waypoints++;
      }
    }
  return { cells, waypoints };
}

// ---------- the edits file ----------

const toBase64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (b) => {
  const s = atob(b), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
};
const inflateRaw = async (u8) =>
  new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());

/** The grid as the edits file keeps it (SaveSculptToEdits); null when nothing is terraformed. */
export async function encodeSculpt(s) {
  if (!s || s.isEmpty) return null;
  const bytes = new Uint8Array(s.delta.length * 4), dv = new DataView(bytes.buffer);
  s.delta.forEach((v, i) => dv.setFloat32(i * 4, v, true));
  return { OriginX: s.originX, OriginZ: s.originZ, Cell: s.cell, Width: s.width, Depth: s.depth, Data: toBase64(await deflateRaw(bytes)) };
}

/** The grid from an edits file's Sculpt (LoadSculpt); null when there's none, an error when its data is broken. */
export async function decodeSculpt(e) {
  if (!e || typeof e !== 'object' || typeof e.Data !== 'string' || !e.Data) return null;
  const w = e.Width, d = e.Depth, cell = Number(e.Cell);
  if (!Number.isInteger(w) || !Number.isInteger(d) || w <= 0 || d <= 0 || !(cell > 0)) return null;
  const bytes = await inflateRaw(fromBase64(e.Data));
  if (bytes.length < w * d * 4) throw new Error('terraforming data is short');
  const dv = new DataView(bytes.buffer, bytes.byteOffset), delta = new Float32Array(w * d);
  for (let i = 0; i < delta.length; i++) delta[i] = dv.getFloat32(i * 4, true);
  return new Sculpt(Number(e.OriginX) || 0, Number(e.OriginZ) || 0, cell, w, d, delta);
}
