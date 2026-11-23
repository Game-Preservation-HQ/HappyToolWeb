// Hidden objects take their baked shadows with them, ported from HappyTool/RrmConvert/StageShadowEraser.cs and
// GUI/StageViewerForm.Export.cs (CollectExportShadows). Steam stages bake every tree's, post's and wall's shadow into
// the ground's lightmap atlas (UV1), so hiding the object leaves a dark patch on the ground where nothing stands any
// more. This brightens the ground lightmap around each hidden object back up to the lit ground just around it. Only
// lightmap texels of ground the game still draws, near a hidden object and darker than its lit surroundings, change;
// every other DXT1 block of the atlas (and of its mip chain) keeps its original bytes.
//
// The desktop's arithmetic is kept: single-precision floats where it uses float (Math.fround), doubles where it uses
// double, Math.Round's round-half-to-even, and the .NET Framework's List.Sort (an unstable introsort), whose order of
// equal keys decides which texels a lit level averages.

import { isIdentityTransform } from '../views/stage-edit.js';
import { stockBounds } from '../views/stage-terraform.js';
import { dxt1Block } from '../views/stage-sky.js';

const f = Math.fround;

/** Things lower than this cast no shadow worth clearing (decals, grass, the shadow quads themselves). */
const MIN_CASTER_HEIGHT = 30;
/** Ground more than this above or below where an object stood isn't where its shadow fell. */
const GROUND_BAND = 250;
/** Objects wider than this (a rainbow arching over half the map) are skipped. */
const MAX_CASTER_SPAN = 3000;
/** The lit ground a patch is matched to: this far beyond the patch. */
const RING_WIDTH = 500;
const GRID = 1000;
const F035 = f(0.35);

/** How far around its footprint an object of this height darkened the ground. */
const reach = (height) => Math.min(400, f(60 + f(F035 * height)));
const cell = (v) => Math.floor(f(v / GRID));
const key = (gx, gz) => `${gx},${gz}`;
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : f(f(t * t) * f(3 - f(2 * t))));
/** Math.Round (to even at .5). */
function roundEven(x) {
  const lo = Math.floor(x), d = x - lo;
  return d > 0.5 ? lo + 1 : d < 0.5 ? lo : lo % 2 === 0 ? lo : lo + 1;
}

/**
 * What clearing baked shadows needs (CollectExportShadows): every hidden stage object where it was baked
 * ({name, minX, minY, minZ, maxX, maxY, maxZ}), and the lightmapped surfaces the game still draws
 * ({lightmap, positions, uv1, triangles}; triangles of hidden or moved objects left out). Gimmicks and their meshes
 * aren't stage objects. Positions are the stage's own (the baked copy once an edit wrote the mesh).
 */
export function shadowInputs(objects, meshes) {
  const casters = [], receivers = [];
  const stage = objects.filter((o) => !o.gimmick);
  for (const o of stage) {
    if (!o.state?.hidden) continue;
    const b = stockBounds(o);
    if (!b || !(b.min[0] <= b.max[0]) || !(b.min[1] <= b.max[1]) || !(b.min[2] <= b.max[2])) continue;
    casters.push({ name: o.name, minX: b.min[0], minY: b.min[1], minZ: b.min[2], maxX: b.max[0], maxY: b.max[1], maxZ: b.max[2] });
  }
  if (!casters.length) return { casters, receivers };
  const owners = new Map();
  stage.forEach((o, i) => {
    const m = o.mesh;
    if (!m?.positions) return;
    let own = owners.get(m);
    if (!own) owners.set(m, (own = new Int32Array(Math.trunc(m.positions.length / 3)).fill(-1)));
    for (let v = o.firstVertex; v < o.firstVertex + o.vertexCount && v < own.length; v++) own[v] = i;
  });
  for (const m of meshes) {
    if (m.gimmick || !m.batches || !m.uvs2 || !m.indices || !m.positions) continue;
    const own = owners.get(m), I = m.indices, positions = m.baked?.positions ?? m.positions;
    for (const b of m.batches) {
      if (!b.lightmap) continue;
      const tris = [];
      const end = Math.min(b.firstIndex + b.indexCount, I.length);
      for (let k = b.firstIndex; k + 2 < end; k += 3) {
        const a = I[k];
        const o = own && a < own.length ? own[a] : -1;
        if (o >= 0 && (stage[o].state.hidden || !isIdentityTransform(stage[o].state))) continue;
        tris.push(a, I[k + 1], I[k + 2]);
      }
      if (tris.length) receivers.push({ lightmap: b.lightmap, positions, uv1: m.uvs2, triangles: Int32Array.from(tris) });
    }
  }
  return { casters, receivers };
}

/**
 * Brightens the ground lightmaps under the hidden objects (StageShadowEraser.Apply). readDds(lightmap) gives the
 * atlas's entry as {name, data} (data a copy that may be changed) or null. Returns {changed: [{name, data}], line,
 * notes, tooWide}: the line as the desktop's report has it (null when nothing changed), the report's log lines, and how
 * many hidden objects were too wide to clear a shadow under.
 */
export async function eraseShadows(casters, receivers, readDds) {
  const out = { changed: [], line: null, notes: [], tooWide: 0 };
  if (!casters?.length || !receivers?.length) return out;
  const used = [];
  let tooWide = 0;
  for (const c of casters) {
    if (f(c.maxY - c.minY) < MIN_CASTER_HEIGHT) continue;
    if (Math.max(f(c.maxX - c.minX), f(c.maxZ - c.minZ)) > MAX_CASTER_SPAN) {
      tooWide++;
      continue;
    }
    used.push(c);
  }
  if (!used.length) return out;
  // Casters by grid cell, over everything they can reach plus the ring their lit level is read from.
  const cells = new Map();
  used.forEach((c, i) => {
    const pad = f(reach(f(c.maxY - c.minY)) + RING_WIDTH);
    for (let gx = cell(f(c.minX - pad)); gx <= cell(f(c.maxX + pad)); gx++)
      for (let gz = cell(f(c.minZ - pad)); gz <= cell(f(c.maxZ + pad)); gz++) {
        const k = key(gx, gz);
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(i);
      }
  });

  const byLightmap = new Map(); // lower-case name -> {name, list}
  for (const r of receivers) {
    if (!r?.lightmap || !r.positions || !r.uv1 || !r.triangles) continue;
    const k = r.lightmap.toLowerCase();
    if (!byLightmap.has(k)) byLightmap.set(k, { name: r.lightmap, list: [] });
    byLightmap.get(k).list.push(r);
  }

  let texelsTotal = 0, atlases = 0;
  const cleared = new Set();
  for (const { name, list } of byLightmap.values()) {
    const res = await readDds(name);
    const dds = res?.data;
    const lay = dds ? dxt1Layout(dds) : null;
    if (!lay) continue;
    const changed = eraseIn(dds, lay.w, lay.h, lay.mips, list, used, cells, cleared);
    if (!changed) continue;
    out.changed.push({ name: res.name, data: dds });
    out.notes.push(`${res.name}: ${n0(changed)} lightmap texel(s) brightened`);
    texelsTotal += changed;
    atlases++;
  }
  if (atlases > 0)
    out.line = `Baked shadows cleared under ${cleared.size} hidden object(s): ${n0(texelsTotal)} lightmap texel(s) in ${atlases} atlas(es).`;
  out.tooWide = tooWide;
  if (tooWide > 0) out.notes.push(`${tooWide} hidden object(s) too wide to clear a shadow under (left as baked)`);
  return out;
}

/** {0:N0} in the invariant culture. */
const n0 = (n) => n.toLocaleString('en-US');
const i32 = (d, o) => d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24);

/** A plain DXT1 .dds whose mip chain fits the file (the layout every shipped stage atlas uses): {w, h, mips} or null. */
function dxt1Layout(d) {
  if (d.length < 128 || d[0] !== 0x44 || d[1] !== 0x44 || d[2] !== 0x53 || d[3] !== 0x20) return null;
  if (d[84] !== 0x44 || d[85] !== 0x58 || d[86] !== 0x54 || d[87] !== 0x31) return null;
  const h = i32(d, 12), w = i32(d, 16), mips = Math.max(1, i32(d, 28));
  if (w < 4 || h < 4 || (w & 3) !== 0 || (h & 3) !== 0) return null;
  let need = 128;
  for (let m = 0, lw = w, lh = h; m < mips; m++, lw = Math.max(1, lw >> 1), lh = Math.max(1, lh >> 1))
    need += Math.max(1, (lw + 3) >> 2) * Math.max(1, (lh + 3) >> 2) * 8;
  return need <= d.length ? { w, h, mips } : null;
}

function eraseIn(dds, w, h, mips, receivers, casters, cells, cleared) {
  let rgb = null; // level 0, decoded on first need
  let weight = null; // per texel: strongest pull towards a caster's lit level
  let owner = null; // per texel: that caster + 1
  const ring = new Map(); // caster -> lit-ground texels around it
  const near = [];
  for (const r of receivers) {
    const p = r.positions, uv = r.uv1, t = r.triangles;
    for (let k = 0; k + 2 < t.length; k += 3) {
      const a = t[k], b = t[k + 1], c = t[k + 2];
      if (a * 3 + 2 >= p.length || b * 3 + 2 >= p.length || c * 3 + 2 >= p.length || a * 2 + 1 >= uv.length || b * 2 + 1 >= uv.length || c * 2 + 1 >= uv.length)
        continue;
      // Ground only: a wall's lightmap isn't where a post's shadow fell.
      const e1x = p[b * 3] - p[a * 3], e1y = p[b * 3 + 1] - p[a * 3 + 1], e1z = p[b * 3 + 2] - p[a * 3 + 2];
      const e2x = p[c * 3] - p[a * 3], e2y = p[c * 3 + 1] - p[a * 3 + 1], e2z = p[c * 3 + 2] - p[a * 3 + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl < 1e-9 || Math.abs(ny) / nl < 0.5) continue;
      const minX = Math.min(p[a * 3], p[b * 3], p[c * 3]), maxX = Math.max(p[a * 3], p[b * 3], p[c * 3]);
      const minZ = Math.min(p[a * 3 + 2], p[b * 3 + 2], p[c * 3 + 2]), maxZ = Math.max(p[a * 3 + 2], p[b * 3 + 2], p[c * 3 + 2]);
      const minY = Math.min(p[a * 3 + 1], p[b * 3 + 1], p[c * 3 + 1]), maxY = Math.max(p[a * 3 + 1], p[b * 3 + 1], p[c * 3 + 1]);
      near.length = 0;
      for (let gx = cell(minX); gx <= cell(maxX); gx++)
        for (let gz = cell(minZ); gz <= cell(maxZ); gz++) {
          const list = cells.get(key(gx, gz));
          if (!list) continue;
          for (const ci of list) {
            if (near.includes(ci)) continue;
            const cc = casters[ci];
            const pad = f(reach(f(cc.maxY - cc.minY)) + RING_WIDTH);
            if (maxX < f(cc.minX - pad) || minX > f(cc.maxX + pad) || maxZ < f(cc.minZ - pad) || minZ > f(cc.maxZ + pad)) continue;
            if (maxY < f(cc.minY - GROUND_BAND) || minY > f(cc.minY + GROUND_BAND)) continue;
            near.push(ci);
          }
        }
      if (!near.length) continue;
      if (!rgb) {
        rgb = decodeLevel0(dds, w, h);
        weight = new Float32Array(w * h);
        owner = new Int32Array(w * h);
      }
      rasterTriangle(p, a, b, c, f(uv[a * 2] * w), f(uv[a * 2 + 1] * h), f(uv[b * 2] * w), f(uv[b * 2 + 1] * h), f(uv[c * 2] * w), f(uv[c * 2 + 1] * h), w, h, (texel, x, y, z) => {
        for (const ci of near) {
          const cc = casters[ci];
          if (Math.abs(f(y - cc.minY)) > GROUND_BAND) continue;
          const dx = Math.max(0, Math.max(f(cc.minX - x), f(x - cc.maxX))), dz = Math.max(0, Math.max(f(cc.minZ - z), f(z - cc.maxZ)));
          const d = f(Math.sqrt(f(f(dx * dx) + f(dz * dz))));
          const re = reach(f(cc.maxY - cc.minY));
          if (d <= re) {
            const inner = f(re * 0.5);
            const wgt = d <= inner ? 1 : smooth(f(f(re - d) / f(re - inner)));
            if (wgt > weight[texel]) {
              weight[texel] = wgt;
              owner[texel] = ci + 1;
            }
          } else if (d <= f(re + RING_WIDTH)) {
            if (!ring.has(ci)) ring.set(ci, []);
            ring.get(ci).push(texel);
          }
        }
      });
    }
  }
  if (!rgb) return 0;

  // Each caster's lit level: the brighter half of the ground around it (its own and its neighbours' dark patches fall
  // in the lower half), averaged so the patch keeps the ground's tint.
  const target = new Map();
  const all = [];
  for (const [ci, texels] of ring) {
    const lit = litLevel(rgb, texels);
    if (lit) target.set(ci, lit);
    for (const x of texels) all.push(x);
  }
  const fallback = litLevel(rgb, all);

  let changed = 0;
  const dirty = new Set();
  const bw = w >> 2;
  for (let i = 0; i < weight.length; i++) {
    if (weight[i] <= 0) continue;
    const ci = owner[i] - 1;
    const lit = target.get(ci) ?? fallback;
    if (!lit) continue;
    const o = i * 3;
    let any = false;
    for (let ch = 0; ch < 3; ch++) {
      const v = rgb[o + ch];
      if (lit[ch] <= v) continue;
      const nv = roundEven(f(v + f((lit[ch] - v) * weight[i])));
      if (nv > v) {
        rgb[o + ch] = Math.min(255, nv);
        any = true;
      }
    }
    if (!any) continue;
    changed++;
    cleared.add(ci);
    const x = i % w, y = Math.trunc(i / w);
    dirty.add((y >> 2) * bw + (x >> 2));
  }
  if (changed > 0) writeDirtyBlocks(dds, w, h, mips, rgb, dirty);
  return changed;
}

/** The lit level of these texels: the 50% to 95% of them by luminance, averaged; null under 12 texels. */
function litLevel(rgb, texels) {
  const n = texels?.length ?? 0;
  if (n < 12) return null;
  const keys = new Int32Array(n), vals = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    const o = texels[k] * 3;
    keys[k] = rgb[o] * 3 + rgb[o + 1] * 6 + rgb[o + 2];
    vals[k] = texels[k];
  }
  introspectiveSort(keys, vals, n);
  const from = n >> 1, to = Math.max(from + 1, Math.trunc((n * 95) / 100));
  let r = 0, g = 0, b = 0;
  for (let k = from; k < to; k++) {
    const o = vals[k] * 3;
    r += rgb[o];
    g += rgb[o + 1];
    b += rgb[o + 2];
  }
  const c = to - from;
  return [Math.trunc(r / c), Math.trunc(g / c), Math.trunc(b / c)];
}

// ---------- the .NET Framework's List<T>.Sort(Comparison<T>) (ArraySortHelper.IntrospectiveSort) ----------
// Sorts keys (and vals with them) by key alone, in the same order the desktop's sort leaves equal keys. The depth
// limit is 2 * FloorLog2 of the list's backing array, which the desktop sizes to the count.

function introspectiveSort(k, v, n) {
  if (n < 2) return;
  let depth = 0;
  for (let x = n; x >= 1; x = Math.trunc(x / 2)) depth++;
  introSort(k, v, 0, n - 1, 2 * depth);
}
function swap(k, v, a, b) {
  const t = k[a];
  k[a] = k[b];
  k[b] = t;
  const u = v[a];
  v[a] = v[b];
  v[b] = u;
}
function swapIfGreater(k, v, a, b) {
  if (a !== b && k[a] > k[b]) swap(k, v, a, b);
}
function introSort(k, v, lo, hi, depth) {
  while (hi > lo) {
    const size = hi - lo + 1;
    if (size <= 16) {
      if (size === 1) return;
      if (size === 2) return swapIfGreater(k, v, lo, hi);
      if (size === 3) {
        swapIfGreater(k, v, lo, hi - 1);
        swapIfGreater(k, v, lo, hi);
        swapIfGreater(k, v, hi - 1, hi);
        return;
      }
      return insertionSort(k, v, lo, hi);
    }
    if (depth === 0) return heapSort(k, v, lo, hi);
    depth--;
    const p = pickPivotAndPartition(k, v, lo, hi);
    introSort(k, v, p + 1, hi, depth);
    hi = p - 1;
  }
}
function pickPivotAndPartition(k, v, lo, hi) {
  const mid = lo + ((hi - lo) >> 1);
  swapIfGreater(k, v, lo, mid);
  swapIfGreater(k, v, lo, hi);
  swapIfGreater(k, v, mid, hi);
  const pivot = k[mid];
  swap(k, v, mid, hi - 1);
  let left = lo, right = hi - 1;
  while (left < right) {
    while (k[++left] < pivot);
    while (pivot < k[--right]);
    if (left >= right) break;
    swap(k, v, left, right);
  }
  swap(k, v, left, hi - 1);
  return left;
}
function heapSort(k, v, lo, hi) {
  const n = hi - lo + 1;
  for (let i = n >> 1; i >= 1; i--) downHeap(k, v, i, n, lo);
  for (let i = n; i > 1; i--) {
    swap(k, v, lo, lo + i - 1);
    downHeap(k, v, 1, i - 1, lo);
  }
}
function downHeap(k, v, i, n, lo) {
  const dk = k[lo + i - 1], dv = v[lo + i - 1];
  while (i <= n >> 1) {
    let child = 2 * i;
    if (child < n && k[lo + child - 1] < k[lo + child]) child++;
    if (!(dk < k[lo + child - 1])) break;
    k[lo + i - 1] = k[lo + child - 1];
    v[lo + i - 1] = v[lo + child - 1];
    i = child;
  }
  k[lo + i - 1] = dk;
  v[lo + i - 1] = dv;
}
function insertionSort(k, v, lo, hi) {
  for (let i = lo; i < hi; i++) {
    let j = i;
    const tk = k[i + 1], tv = v[i + 1];
    while (j >= lo && tk < k[j]) {
      k[j + 1] = k[j];
      v[j + 1] = v[j];
      j--;
    }
    k[j + 1] = tk;
    v[j + 1] = tv;
  }
}

/**
 * Visits the texels of a UV triangle (in texel units), padded by one texel so bilinear filtering at the triangle's
 * edge reads the new values too, with the world position each texel stands for.
 */
function rasterTriangle(p, a, b, c, ax, ay, bx, by, cx, cy, w, h, visit) {
  const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  if (Math.abs(area) < 1e-6) return;
  const la = Math.sqrt((cx - bx) * (cx - bx) + (cy - by) * (cy - by));
  const lb = Math.sqrt((ax - cx) * (ax - cx) + (ay - cy) * (ay - cy));
  const lc = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 1)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx) + 1));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy) - 1)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy) + 1));
  const aa = Math.abs(area);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      // barycentrics; each one's distance to its edge in texels is wa * (edge length) / |area|
      let wa = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area;
      let wb = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area;
      let wc = 1 - wa - wb;
      if ((wa * aa) / Math.max(la, 1e-9) < -1 || (wb * aa) / Math.max(lb, 1e-9) < -1 || (wc * aa) / Math.max(lc, 1e-9) < -1) continue;
      wa = Math.max(0, wa);
      wb = Math.max(0, wb);
      wc = Math.max(0, wc);
      const s = wa + wb + wc;
      wa /= s;
      wb /= s;
      wc /= s;
      visit(
        y * w + x,
        f(p[a * 3] * wa + p[b * 3] * wb + p[c * 3] * wc),
        f(p[a * 3 + 1] * wa + p[b * 3 + 1] * wb + p[c * 3 + 1] * wc),
        f(p[a * 3 + 2] * wa + p[b * 3 + 2] * wb + p[c * 3 + 2] * wc),
      );
    }
}

// ---------- DXT1 ----------

function decodeLevel0(dds, w, h) {
  const rgb = new Uint8Array(w * h * 3);
  const pal = new Int32Array(12);
  let at = 128;
  for (let by = 0; by < h; by += 4)
    for (let bx = 0; bx < w; bx += 4, at += 8) {
      palette(dds, at, pal);
      const bits = i32(dds, at + 4) >>> 0;
      for (let k = 0; k < 16; k++) {
        const idx = (bits >>> (k * 2)) & 3;
        const o = ((by + (k >> 2)) * w + bx + (k & 3)) * 3;
        rgb[o] = pal[idx * 3];
        rgb[o + 1] = pal[idx * 3 + 1];
        rgb[o + 2] = pal[idx * 3 + 2];
      }
    }
  return rgb;
}

function palette(d, at, pal) {
  const c0 = d[at] | (d[at + 1] << 8), c1 = d[at + 2] | (d[at + 3] << 8);
  expand(c0, pal, 0);
  expand(c1, pal, 3);
  for (let ch = 0; ch < 3; ch++) {
    if (c0 > c1) {
      pal[6 + ch] = Math.trunc((2 * pal[ch] + pal[3 + ch] + 1) / 3);
      pal[9 + ch] = Math.trunc((pal[ch] + 2 * pal[3 + ch] + 1) / 3);
    } else {
      pal[6 + ch] = (pal[ch] + pal[3 + ch]) >> 1;
      pal[9 + ch] = 0;
    }
  }
}

function expand(c, pal, o) {
  const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
  pal[o] = (r << 3) | (r >> 2);
  pal[o + 1] = (g << 2) | (g >> 4);
  pal[o + 2] = (b << 3) | (b >> 2);
}

/**
 * Re-encodes the changed blocks of level 0 and, down the mip chain, every block whose area holds one (box-filtered
 * from the edited level 0, as the chain was built); all other blocks keep their bytes.
 */
function writeDirtyBlocks(dds, w, h, mips, rgb, dirty) {
  let level = rgb, lw = w, lh = h, at = 128;
  const pix = new Uint8Array(64), block = new Uint8Array(8);
  for (let m = 0; m < mips; m++) {
    const bw = Math.max(1, (lw + 3) >> 2), bh = Math.max(1, (lh + 3) >> 2);
    for (const blk of dirty) {
      const bx = (blk % bw) * 4, by = Math.trunc(blk / bw) * 4;
      for (let py = 0; py < 4; py++)
        for (let px = 0; px < 4; px++) {
          const sx = Math.min(bx + px, lw - 1), sy = Math.min(by + py, lh - 1);
          const s = (sy * lw + sx) * 3, d = (py * 4 + px) * 4;
          pix[d] = level[s];
          pix[d + 1] = level[s + 1];
          pix[d + 2] = level[s + 2];
          pix[d + 3] = 255;
        }
      dxt1Block(pix, block, 0);
      dds.set(block, at + blk * 8);
    }
    at += bw * bh * 8;
    if (m + 1 >= mips || (lw === 1 && lh === 1)) break;
    const nw = Math.max(1, lw >> 1), nh = Math.max(1, lh >> 1);
    const next = new Uint8Array(nw * nh * 3);
    for (let y = 0; y < nh; y++)
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(x * 2, lw - 1), x1 = Math.min(x * 2 + 1, lw - 1), y0 = Math.min(y * 2, lh - 1), y1 = Math.min(y * 2 + 1, lh - 1);
        for (let c = 0; c < 3; c++)
          next[(y * nw + x) * 3 + c] =
            (level[(y0 * lw + x0) * 3 + c] + level[(y0 * lw + x1) * 3 + c] + level[(y1 * lw + x0) * 3 + c] + level[(y1 * lw + x1) * 3 + c] + 2) >> 2;
      }
    const nbw = Math.max(1, (nw + 3) >> 2);
    const nd = new Set();
    for (const blk of dirty) nd.add((Math.trunc(blk / bw) >> 1) * nbw + ((blk % bw) >> 1));
    dirty = nd;
    level = next;
    lw = nw;
    lh = nh;
  }
}
