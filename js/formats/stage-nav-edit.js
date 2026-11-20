// The live nav mesh and waypoints of an edited stage, ported from HappyTool/RrmConvert/StageNav.cs (StageNavEditor):
// cells and waypoints that belong to a moved object move with it, a hidden object's go, the walkable space an object
// now stands on is carved away, edges are re-stitched to whatever they now meet, and the hand edits kept in the colnav
// file (painted and erased nav, waypoints placed, deleted, linked or cut by hand) are applied. No DOM.
//
// Cells are {head, v: Float32Array(9), links: [int]} and waypoints {x, y, z, radius, …, links} as stage-nav.js reads
// them. The desktop keeps cell corners in single precision and does some sums there; Math.fround stands in for that.

import { NAV_HEAD, defaultLinkWords } from './stage-nav.js';
import { Affine } from './stage-bake.js';

const f = Math.fround;
const TWO32 = 4294967296;

/** Corners closer than this are the same point (authored shared edges match exactly). */
const WELD = 1.0;
/** How far apart two cell edges may be and still be joined. */
const STITCH_TOLERANCE = 40.0;
/** Character height used for carving: an object blocks a cell when it overlaps this span above it. */
const CHARACTER_HEIGHT = 180.0;
/** Longest waypoint link made automatically (authored median ≈ 950). */
const MAX_NEW_LINK = 1600.0;
/** Radius of a waypoint added on a detour, and the dry ground kept round it and round a gate moved ashore. */
const DETOUR_RADIUS = 100.0;

/**
 * Something standing where bots used to walk: the XZ cells its placed triangles cover, each with the height span the
 * object fills there (a wall spans bottom to top, a floor plate a thin band, an open courtyard nothing at all).
 * `before`: for a moved object, where it stood before; space it already filled there was never walkable, so it isn't
 * carved again. `water`: water or magma that kills wherever its surface lies above the ground.
 */
export class Blocker {
  constructor(obj) {
    this.object = obj;
    this.cell = 50.0;
    this.spans = new Map();
    this.before = null;
    this.water = false;
  }

  /** Rasterises an object's triangles (placed by world, or as baked when null) on a grid of `cell` units (0: sized to the object). */
  static fromTriangles(obj, pos, tris, world, cell = 0) {
    const b = new Blocker(obj);
    if (!pos || !tris || tris.length < 3) return b;
    const nv = Math.trunc(pos.length / 3);
    const placed = new Float64Array(pos.length);
    let minX = Number.MAX_VALUE, maxX = -Number.MAX_VALUE, minZ = Number.MAX_VALUE, maxZ = -Number.MAX_VALUE;
    const used = new Uint8Array(nv);
    for (const v of tris) if (v >= 0 && v < nv) used[v] = 1;
    for (let v = 0; v < nv; v++) {
      if (!used[v]) continue;
      let x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      if (world) [x, y, z] = Affine.point(world, x, y, z);
      placed[v * 3] = x; placed[v * 3 + 1] = y; placed[v * 3 + 2] = z;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    if (minX > maxX) return b;
    b.cell = cell > 0 ? cell : Math.max(25.0, Math.min(200.0, Math.max(maxX - minX, maxZ - minZ) / 300.0));
    for (let t = 0; t + 2 < tris.length; t += 3) {
      const i0 = tris[t], i1 = tris[t + 1], i2 = tris[t + 2];
      if (i0 < 0 || i1 < 0 || i2 < 0 || i0 >= nv || i1 >= nv || i2 >= nv) continue;
      b.addTriangle(placed, i0 * 3, i1 * 3, i2 * 3);
    }
    return b;
  }

  /** Marks the cells under a triangle by sampling it every half cell (so walls of any slope register). */
  addTriangle(p, a, c1, c2) {
    const e1x = p[c1] - p[a], e1y = p[c1 + 1] - p[a + 1], e1z = p[c1 + 2] - p[a + 2];
    const e2x = p[c2] - p[a], e2y = p[c2 + 1] - p[a + 1], e2z = p[c2 + 2] - p[a + 2];
    const longest = Math.max(Math.sqrt(e1x * e1x + e1z * e1z), Math.max(Math.sqrt(e2x * e2x + e2z * e2z),
      Math.sqrt((e2x - e1x) * (e2x - e1x) + (e2z - e1z) * (e2z - e1z))));
    const n = Math.max(1, Math.min(200, Math.ceil(longest / (this.cell * 0.5))));
    for (let i = 0; i <= n; i++)
      for (let j = 0; i + j <= n; j++) {
        const u = i / n, w = j / n;
        this.mark(p[a] + e1x * u + e2x * w, p[a + 1] + e1y * u + e2y * w, p[a + 2] + e1z * u + e2z * w);
      }
  }

  key(x, z) {
    return Math.floor(x / this.cell) * TWO32 + (Math.floor(z / this.cell) >>> 0);
  }

  mark(x, y, z) {
    const k = this.key(x, z), s = this.spans.get(k), fy = f(y);
    if (s) {
      if (y < s[0]) s[0] = fy;
      if (y > s[1]) s[1] = fy;
    } else this.spans.set(k, [fy, fy]);
  }

  /** True when the object now fills part of a character's height (20–180 units) above the point where it didn't before; for water, when the point is under its surface. */
  occupies(x, y, z) {
    return this.fills(x, y, z) && (!this.before || !this.before.fills(x, y, z));
  }

  fills(x, y, z) {
    const s = this.spans.get(this.key(x, z));
    return !!s && (this.water ? s[1] > y : s[0] < y + CHARACTER_HEIGHT && s[1] > y + 20.0);
  }
}

/**
 * A waypoint reference that survives rebuilds: a stage waypoint's source index (≥ 0) or a hand-placed one's -(id + 1).
 * Copies of waypoints have none (MIN_REF). The key of an unordered pair of references.
 */
export const MIN_REF = -2147483648;
export const nodeRefKey = (a, b) => (a < b ? a * TWO32 + (b >>> 0) : b * TWO32 + (a >>> 0));

/**
 * Rebuilds the nav mesh and waypoints for the edits in `input`:
 *   nav, path: the stage's (stage-nav.js), either may be null;
 *   cellOwner, nodeOwner: per source cell / node, the owning object (-1 none), null when not matched;
 *   hidden(o), world(o): whether an object is hidden, and its placement (row-major 3×4) or null when it hasn't moved;
 *   copies [{source, object, world}], blockers [Blocker], extraCells [{v, object, hand}], eraseStamps [[x, y, z, r]],
 *   handNodes [{id, x, y, z, radius}], removedNodes Set, handLinks [[a, b]], cutLinks Set of nodeRefKey.
 * Returns the result: {nav, path, cellGroup, cellObject, nodeGroup, nodeObject, nodeRef, and the counts}; a group is
 * -1 unchanged, ≥ 0 the moved object, ≤ -2 copy (or extra cell) number -(g + 2).
 */
export function rebuildNav(input) {
  const inp = {
    nav: null, path: null, cellOwner: null, nodeOwner: null, hidden: () => false, world: () => null, copies: [],
    blockers: [], extraCells: [], eraseStamps: [], handNodes: [], removedNodes: new Set(), handLinks: [],
    cutLinks: new Set(), ...input,
  };
  const res = {
    nav: null, path: null, cellGroup: null, nodeGroup: null, cellObject: null, nodeObject: null, nodeRef: null,
    cellsMoved: 0, cellsRemoved: 0, cellsAdded: 0, cellsCarved: 0, edgesStitched: 0, edgesCut: 0,
    nodesMoved: 0, nodesRemoved: 0, nodesAdded: 0, linksAdded: 0, linksRemoved: 0,
    copyIslandCells: 0, copyIslandNodes: 0, gatesKept: 0, sliverCells: 0,
    pocketsJoined: 0, pocketsDropped: 0, pocketsLeft: 0, gatesMoved: 0, detourNodes: 0,
    cellsPainted: 0, cellsGenerated: 0, cellsErased: 0,
  };
  if (inp.nav) rebuildCells(inp, res);
  if (inp.path) rebuildPath(inp, res);
  return res;
}

export const navChanged = (r) =>
  r.cellsMoved + r.cellsRemoved + r.cellsAdded + r.cellsCarved + r.edgesStitched + r.edgesCut + r.cellsPainted +
    r.cellsGenerated + r.cellsErased > 0;
export const pathChanged = (r) =>
  r.nodesMoved + r.nodesRemoved + r.nodesAdded + r.linksAdded + r.linksRemoved + r.gatesMoved + r.detourNodes > 0;

/** The desktop's one-line summary of a rebuild (Result.Summary). */
export function navSummary(r) {
  let s = `Bot navigation: ${r.cellsMoved} cell(s) moved, ${r.cellsRemoved} removed, ${r.cellsAdded} copied, ${r.cellsCarved} carved under objects, ` +
    `${r.edgesStitched} edge(s) re-stitched, ${r.edgesCut} cut; ${r.nodesMoved} waypoint(s) moved, ${r.nodesRemoved} removed, ` +
    `${r.nodesAdded} copied, ${r.linksAdded} link(s) added, ${r.linksRemoved} dropped.`;
  if (r.copyIslandCells + r.copyIslandNodes + r.gatesKept)
    s += ` Unreachable copies dropped: ${r.copyIslandCells} cell(s), ${r.copyIslandNodes} waypoint(s); ${r.gatesKept} region gate(s) kept under objects.`;
  if (r.sliverCells) s += ` ${r.sliverCells} stranded sliver cell(s) dropped.`;
  if (r.cellsPainted + r.cellsGenerated + r.cellsErased)
    s += ` ${r.cellsPainted} cell(s) painted by hand, ${r.cellsGenerated} generated on placed objects, ${r.cellsErased} erased by hand.`;
  if (r.gatesMoved + r.detourNodes)
    s += ` ${r.gatesMoved} region gate(s) moved out of water; ${r.detourNodes} waypoint(s) added to lead round what's in the way.`;
  if (r.pocketsJoined + r.pocketsDropped + r.pocketsLeft)
    s += ` Cut-off waypoint groups re-joined: ${r.pocketsJoined}${r.pocketsDropped > 0 ? `, ${r.pocketsDropped} too small to keep dropped` : ''}` +
      `${r.pocketsLeft > 0 ? `, ${r.pocketsLeft} still cut off` : ''}.`;
  return s;
}

// ===================== nav mesh =====================

const cloneCell = (c) => ({ head: c.head.slice(), v: c.v.slice(), links: [] });

function rebuildCells(input, res) {
  const src = input.nav.cells, n = src.length;
  const cells = [], group = [], owner = [];
  const fromSource = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const o = input.cellOwner && i < input.cellOwner.length ? input.cellOwner[i] : -1;
    if (o >= 0 && input.hidden(o)) {
      res.cellsRemoved++;
      continue;
    }
    const w = o >= 0 ? input.world(o) : null;
    const c = cloneCell(src[i]);
    if (w) {
      transform(c.v, w);
      res.cellsMoved++;
    }
    fromSource[i] = cells.length;
    cells.push(c);
    group.push(w ? o : -1);
    owner.push(o);
  }
  // Copies bring the cells their source stands on.
  const copyMaps = [];
  input.copies.forEach((cp, k) => {
    const map = new Map();
    copyMaps.push(map);
    if (!input.cellOwner) return;
    for (let i = 0; i < n && i < input.cellOwner.length; i++) {
      if (input.cellOwner[i] !== cp.source) continue;
      const c = cloneCell(src[i]);
      transform(c.v, cp.world);
      map.set(i, cells.length);
      cells.push(c);
      group.push(-(k + 2));
      owner.push(cp.object);
      res.cellsAdded++;
    }
  });
  // Painted / generated cells: each its own group, so stitching joins them to each other and to everything else.
  const firstExtra = cells.length;
  const hand = new Uint8Array(cells.length + input.extraCells.length);
  input.extraCells.forEach((ec, j) => {
    if (!ec?.v || ec.v.length < 9) return;
    hand[cells.length] = ec.hand ? 1 : 0;
    cells.push({ head: new Uint8Array(NAV_HEAD), v: Float32Array.from(ec.v), links: [] });
    group.push(-(input.copies.length + 2 + j));
    owner.push(ec.object ?? -1);
  });

  // Links of the source cells, where both ends survive and still meet.
  const removed = new Uint8Array(cells.length);
  for (let i = 0; i < n; i++) {
    const a = fromSource[i];
    if (a < 0) continue;
    for (const l of src[i].links) {
      const j = Math.abs(l);
      if (j >= n || fromSource[j] < 0) continue;
      const b = fromSource[j];
      if (group[a] === group[b]) cells[a].links.push(l >= 0 ? b : -b);
      else if (l >= 0 && sharedEdge(cells[a].v, cells[b].v)) cells[a].links.push(b);
      else res.edgesCut++;
    }
  }
  input.copies.forEach((cp, k) => {
    for (const [from, to] of copyMaps[k])
      for (const l of src[from].links) {
        const b = copyMaps[k].get(Math.abs(l));
        if (b !== undefined) cells[to].links.push(l >= 0 ? b : -b);
      }
  });

  // Carve the walkable space objects now stand on (never an object's own cells).
  if (input.blockers.length)
    for (let c = 0; c < cells.length; c++)
      for (const bl of input.blockers)
        if (owner[c] !== bl.object && blocks(bl, cells[c].v)) {
          removed[c] = 1;
          res.cellsCarved++;
          break;
        }
  // Nav erased by hand (painted cells are taken out of their list instead).
  if (input.eraseStamps.length)
    for (let c = 0; c < cells.length; c++) {
      if (removed[c] || hand[c]) continue;
      const v = cells[c].v;
      const cx = f(f(v[0] + v[3]) + v[6]) / 3, cy = f(f(v[1] + v[4]) + v[7]) / 3, cz = f(f(v[2] + v[5]) + v[8]) / 3;
      for (const s of input.eraseStamps) {
        const dx = f(cx) - s[0], dz = f(cz) - s[2];
        if (dx * dx + dz * dz <= s[3] * s[3] && Math.abs(f(cy) - s[1]) <= 300.0) {
          removed[c] = 1;
          res.cellsErased++;
          break;
        }
      }
    }

  // Re-stitch the edges of moved / copied cells to whatever they now meet.
  const grid = new XzGrid(400.0);
  for (let c = 0; c < cells.length; c++) if (!removed[c]) grid.add(c, cells[c].v, STITCH_TOLERANCE);
  const scratch = [];
  for (let c = 0; c < cells.length; c++) {
    if (removed[c] || group[c] === -1) continue;
    for (let e = 0; e < 3; e++) {
      if (edgeCovered(cells, c, e, removed)) continue;
      grid.query(cells[c].v, STITCH_TOLERANCE, scratch);
      for (const d of scratch) {
        if (d === c || removed[d] || group[d] === group[c] || cells[c].links.includes(d)) continue;
        let joined = false;
        for (let g = 0; g < 3 && !joined; g++)
          if (!edgeCovered(cells, d, g, removed) && edgesMeet(cells[c].v, e, cells[d].v, g)) {
            cells[c].links.push(d);
            cells[d].links.push(c);
            res.edgesStitched++;
            joined = true;
          }
        if (joined) break;
      }
    }
  }
  // Painted / generated cells rarely line up edge to edge with the stage's own triangles: one that overlaps another
  // walkable cell at about the same height is its neighbour too (up to 3 such links per cell).
  for (let c = firstExtra; c < cells.length; c++) {
    if (removed[c]) continue;
    grid.query(cells[c].v, 0.0, scratch);
    let added = 0;
    for (const d of scratch) {
      if (added >= 3) break;
      if (d === c || removed[d] || group[d] === group[c] || cells[c].links.includes(d) || !overlapXz(cells[c].v, cells[d].v) ||
        !sameHeight(cells[c].v, cells[d].v))
        continue;
      cells[c].links.push(d);
      if (!cells[d].links.includes(c)) cells[d].links.push(c);
      res.edgesStitched++;
      added++;
    }
  }

  // Carving around new objects can strand a cell or two between them (a sliver of what was one big walkable area):
  // islands of 3 cells or fewer, all from a big piece of the source mesh, are dropped. Authored small islands stay.
  {
    const srcComp = new Int32Array(n).fill(-1), srcSize = new Map(), st0 = [];
    for (let s0 = 0; s0 < n; s0++) {
      if (srcComp[s0] >= 0) continue;
      let size = 0;
      srcComp[s0] = s0;
      st0.push(s0);
      while (st0.length) {
        const v = st0.pop();
        size++;
        for (const l of src[v].links) if (l >= 0 && l < n && srcComp[l] < 0) { srcComp[l] = s0; st0.push(l); }
      }
      srcSize.set(s0, size);
    }
    const origin = new Int32Array(cells.length).fill(-1);
    for (let i = 0; i < n; i++) if (fromSource[i] >= 0) origin[fromSource[i]] = i;
    const seen = new Uint8Array(cells.length), stack = [], piece = [];
    for (let s = 0; s < cells.length; s++) {
      if (seen[s] || removed[s]) continue;
      piece.length = 0;
      seen[s] = 1;
      stack.push(s);
      while (stack.length) {
        const c = stack.pop();
        piece.push(c);
        for (const l of cells[c].links) if (l >= 0 && l < cells.length && !removed[l] && !seen[l]) { seen[l] = 1; stack.push(l); }
      }
      if (piece.length > 3) continue;
      let sliver = true;
      for (const c of piece) if (origin[c] < 0 || srcSize.get(srcComp[origin[c]]) <= 3) { sliver = false; break; }
      if (!sliver) continue;
      for (const c of piece) { removed[c] = 1; res.sliverCells++; }
    }
  }

  // Copied cells that joined nothing (a house's roof copied into a field) are islands no bot can reach: drop them.
  {
    const seen = new Uint8Array(cells.length), stack = [], members = [];
    for (let s = 0; s < cells.length; s++) {
      if (seen[s] || removed[s] || group[s] > -2) continue;
      members.length = 0;
      let reachesOriginal = false;
      seen[s] = 1;
      stack.push(s);
      while (stack.length) {
        const c = stack.pop();
        members.push(c);
        if (group[c] > -2 || hand[c]) reachesOriginal = true;
        for (const l of cells[c].links) if (l >= 0 && l < cells.length && !removed[l] && !seen[l]) { seen[l] = 1; stack.push(l); }
      }
      if (reachesOriginal) continue;
      for (const c of members) {
        removed[c] = 1;
        if (c < firstExtra) res.cellsAdded--;
        res.copyIslandCells++;
      }
    }
  }

  // Compact away carved cells.
  const remap = new Int32Array(cells.length);
  const outNav = { version: input.nav.version, cells: [] }, outGroup = [], outObject = [];
  for (let c = 0; c < cells.length; c++) {
    remap[c] = removed[c] ? -1 : outNav.cells.length;
    if (removed[c]) continue;
    outNav.cells.push(cells[c]);
    outGroup.push(group[c]);
    outObject.push(owner[c]);
    if (c >= firstExtra) {
      if (hand[c]) res.cellsPainted++;
      else res.cellsGenerated++;
    }
  }
  for (const c of outNav.cells) {
    const links = [];
    for (const l of c.links) {
      const t = remap[Math.abs(l)];
      if (t < 0 || (l < 0 && t === 0)) continue; // a drop link can't point at cell 0 (-0 is 0)
      const v = l >= 0 ? t : -t;
      if (!links.includes(v)) links.push(v);
    }
    c.links = links;
  }
  res.nav = outNav;
  res.cellGroup = Int32Array.from(outGroup);
  res.cellObject = Int32Array.from(outObject);
}

/** Whether two cells overlap seen from above (separating axes on their six edge normals; under 5 units of overlap doesn't count). */
function overlapXz(a, b) {
  for (let pass = 0; pass < 2; pass++) {
    const t = pass === 0 ? a : b;
    for (let e = 0; e < 3; e++) {
      const p = e * 3, q = ((e + 1) % 3) * 3;
      let nx = -f(t[q + 2] - t[p + 2]), nz = f(t[q] - t[p]);
      const len = Math.sqrt(nx * nx + nz * nz);
      if (len < 1e-6) continue;
      nx /= len;
      nz /= len;
      let aMin = Number.MAX_VALUE, aMax = -Number.MAX_VALUE, bMin = Number.MAX_VALUE, bMax = -Number.MAX_VALUE;
      for (let k = 0; k < 3; k++) {
        const pa = a[k * 3] * nx + a[k * 3 + 2] * nz, pb = b[k * 3] * nx + b[k * 3 + 2] * nz;
        aMin = Math.min(aMin, pa); aMax = Math.max(aMax, pa);
        bMin = Math.min(bMin, pb); bMax = Math.max(bMax, pb);
      }
      if (aMax < bMin + 5.0 || bMax < aMin + 5.0) return false;
    }
  }
  return true;
}

/**
 * Whether two overlapping cells are one walkable level: somewhere they overlap (a corner, edge middle or centre of
 * either that lies in both), their surfaces are within 60 units of each other.
 */
function sameHeight(a, b) {
  for (let pass = 0; pass < 2; pass++) {
    const t = pass === 0 ? a : b;
    for (let s = 0; s < 7; s++) {
      let x, z;
      if (s < 3) { x = t[s * 3]; z = t[s * 3 + 2]; }
      else if (s < 6) {
        const p = (s - 3) * 3, q = ((s - 2) % 3) * 3;
        x = f(t[p] + t[q]) * 0.5; z = f(t[p + 2] + t[q + 2]) * 0.5;
      } else { x = f(f(t[0] + t[3]) + t[6]) / 3.0; z = f(f(t[2] + t[5]) + t[8]) / 3.0; }
      if (!insideXz(a, x, z) || !insideXz(b, x, z)) continue;
      const ya = planeY(a, x, z), yb = planeY(b, x, z);
      if (!Number.isNaN(ya) && !Number.isNaN(yb) && Math.abs(ya - yb) <= 60.0) return true;
    }
  }
  return false;
}

/** A cell's surface height at (x, z) (its plane carried there); NaN for a vertical cell. */
function planeY(t, x, z) {
  const ux = f(t[3] - t[0]), uy = f(t[4] - t[1]), uz = f(t[5] - t[2]);
  const vx = f(t[6] - t[0]), vy = f(t[7] - t[1]), vz = f(t[8] - t[2]);
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (Math.abs(ny) < 1e-9) return NaN;
  return t[1] - (nx * (x - t[0]) + nz * (z - t[2])) / ny;
}

/** Whether (x, z) lies in a cell seen from above (edges included, a little slack). */
function insideXz(t, x, z) {
  const d1 = (x - t[3]) * f(t[2] - t[5]) - f(t[0] - t[3]) * (z - t[5]);
  const d2 = (x - t[6]) * f(t[5] - t[8]) - f(t[3] - t[6]) * (z - t[8]);
  const d3 = (x - t[0]) * f(t[8] - t[2]) - f(t[6] - t[0]) * (z - t[2]);
  const area = Math.abs(f(f(f(t[3] - t[0]) * f(t[8] - t[2])) - f(f(t[6] - t[0]) * f(t[5] - t[2]))));
  const slack = Math.max(1e-6, area) * 1e-3;
  const neg = d1 < -slack || d2 < -slack || d3 < -slack, pos = d1 > slack || d2 > slack || d3 > slack;
  return !(neg && pos);
}

function sharedEdge(a, b) {
  let shared = 0;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      if (dist(a, i, b, j) <= WELD) { shared++; break; }
  return shared >= 2;
}

/** Whether edge e (corners e, e+1) of a cell already has a neighbour across it. */
function edgeCovered(cells, c, e, removed) {
  const v = cells[c].v;
  for (const l of cells[c].links) {
    if (l < 0 || l >= cells.length || removed[l]) continue;
    for (let g = 0; g < 3; g++) if (edgesMeet(v, e, cells[l].v, g)) return true;
  }
  return false;
}

/**
 * Two cell edges meet when they run along each other: their overlap (projected on the longer one) covers at least a
 * third of the shorter, and across that overlap they stay within STITCH_TOLERANCE.
 */
function edgesMeet(a, e, b, g) {
  const a0 = e * 3, a1 = ((e + 1) % 3) * 3, b0 = g * 3, b1 = ((g + 1) % 3) * 3;
  const la = len(a, a0, a1), lb = len(b, b0, b1);
  const aLong = la >= lb;
  const L = aLong ? a : b, S = aLong ? b : a;
  const l0 = aLong ? a0 : b0, l1 = aLong ? a1 : b1, s0 = aLong ? b0 : a0, s1 = aLong ? b1 : a1;
  const ln = Math.max(la, lb), shorter = Math.min(la, lb);
  if (ln < 1e-3 || shorter < 1e-3) return false;
  const dx = f(L[l1] - L[l0]) / ln, dy = f(L[l1 + 1] - L[l0 + 1]) / ln, dz = f(L[l1 + 2] - L[l0 + 2]) / ln;
  const p0 = f(S[s0] - L[l0]) * dx + f(S[s0 + 1] - L[l0 + 1]) * dy + f(S[s0 + 2] - L[l0 + 2]) * dz;
  const p1 = f(S[s1] - L[l0]) * dx + f(S[s1 + 1] - L[l0 + 1]) * dy + f(S[s1 + 2] - L[l0 + 2]) * dz;
  const lo = Math.max(0, Math.min(p0, p1)), hi = Math.min(ln, Math.max(p0, p1));
  if (hi - lo < Math.max(shorter / 3.0, 5.0) || Math.abs(p1 - p0) < 1e-6) return false;
  for (const t of [lo, hi]) {
    const u = (t - p0) / (p1 - p0);
    const qx = S[s0] + f(S[s1] - S[s0]) * u, qy = S[s0 + 1] + f(S[s1 + 1] - S[s0 + 1]) * u, qz = S[s0 + 2] + f(S[s1 + 2] - S[s0 + 2]) * u;
    const px = L[l0] + dx * t, py = L[l0 + 1] + dy * t, pz = L[l0 + 2] + dz * t;
    const gx = px - qx, gy = py - qy, gz = pz - qz;
    if (gx * gx + gy * gy + gz * gz > STITCH_TOLERANCE * STITCH_TOLERANCE) return false;
  }
  return true;
}

/** Sample point s of a cell for carving (Blocks): 0–2 its corners, 3–5 its edge midpoints, 6 its centre. */
function blockSample(v, s) {
  if (s < 3) return [v[s * 3], v[s * 3 + 1], v[s * 3 + 2]];
  if (s < 6) {
    const a = (s - 3) * 3, c = ((s - 2) % 3) * 3;
    return [f(v[a] + v[c]) * 0.5, f(v[a + 1] + v[c + 1]) * 0.5, f(v[a + 2] + v[c + 2]) * 0.5];
  }
  return [f(f(v[0] + v[3]) + v[6]) / 3.0, f(f(v[1] + v[4]) + v[7]) / 3.0, f(f(v[2] + v[5]) + v[8]) / 3.0];
}

/**
 * An object blocks a cell when it fills a character's height over most of it: 4 of 7 sample points. Small props and
 * thin walls therefore never delete a big cell; links across them are dropped instead (crossesBlocker).
 */
function blocks(b, v) {
  let inside = 0;
  for (let s = 0; s < 7; s++) {
    const [x, y, z] = blockSample(v, s);
    if (b.occupies(x, y, z) && ++inside >= 4) return true;
  }
  return false;
}

// ===================== shared helpers =====================

/** How many of a cell's 7 sample points (centre, corners, edge midpoints) something now stands on. */
function blockedSamples(blockers, v) {
  let count = 0;
  for (let s = 0; s < 7; s++) {
    const p = centre(v, s);
    for (const bl of blockers) if (bl.occupies(p[0], p[1], p[2])) { count++; break; }
  }
  return count;
}

/** Sample point s of a cell: 0 its centre, 1–3 its corners, 4–6 its edge midpoints. */
function centre(v, s) {
  if (s === 0) return [f(f(v[0] + v[3]) + v[6]) / 3.0, f(f(v[1] + v[4]) + v[7]) / 3.0, f(f(v[2] + v[5]) + v[8]) / 3.0];
  if (s < 4) return [v[(s - 1) * 3], v[(s - 1) * 3 + 1], v[(s - 1) * 3 + 2]];
  const a = (s - 4) * 3, c = ((s - 3) % 3) * 3;
  return [f(v[a] + v[c]) * 0.5, f(v[a + 1] + v[c + 1]) * 0.5, f(v[a + 2] + v[c + 2]) * 0.5];
}

/** The middle of the edge two neighbouring cells share (corners within STITCH_TOLERANCE), or null when they share none. */
function portal(a, b) {
  const shared = [];
  for (let i = 0; i < 3 && shared.length < 2; i++)
    for (let j = 0; j < 3; j++)
      if (dist(a, i, b, j) <= STITCH_TOLERANCE) { shared.push(i); break; }
  if (shared.length < 2) return null;
  const p = shared[0] * 3, q = shared[1] * 3;
  return [f(a[p] + a[q]) * 0.5, f(a[p + 1] + a[q + 1]) * 0.5, f(a[p + 2] + a[q + 2]) * 0.5];
}

/** Moves a waypoint by a placement, scaling its radius by the placement's overall scale (0.25–4×). */
function place(node, w) {
  const p = Affine.point(w, node.x, node.y, node.z);
  node.x = f(p[0]); node.y = f(p[1]); node.z = f(p[2]);
  const det = w[0] * (w[5] * w[10] - w[6] * w[9]) - w[1] * (w[4] * w[10] - w[6] * w[8]) + w[2] * (w[4] * w[9] - w[5] * w[8]);
  const s = Math.pow(Math.abs(det), 1.0 / 3.0);
  if (!Number.isNaN(s) && s > 0) node.radius = f(node.radius * Math.max(0.25, Math.min(4.0, s)));
}

function transform(v, w) {
  for (let k = 0; k < 3; k++) {
    const p = Affine.point(w, v[k * 3], v[k * 3 + 1], v[k * 3 + 2]);
    v[k * 3] = p[0]; v[k * 3 + 1] = p[1]; v[k * 3 + 2] = p[2]; // Float32Array: rounded to single as (float) does
  }
}

function dist(a, i, b, j) {
  const dx = f(a[i * 3] - b[j * 3]), dy = f(a[i * 3 + 1] - b[j * 3 + 1]), dz = f(a[i * 3 + 2] - b[j * 3 + 2]);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function len(v, a, b) {
  const dx = f(v[b] - v[a]), dy = f(v[b + 1] - v[a + 1]), dz = f(v[b + 2] - v[a + 2]);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Coarse XZ bucket grid over cells (by bounds), for neighbour searches. */
class XzGrid {
  constructor(size) {
    this.size = size;
    this.cells = new Map();
    this.seen = new Set();
  }

  range(v, pad) {
    const minX = Math.min(v[0], Math.min(v[3], v[6])) - pad, maxX = Math.max(v[0], Math.max(v[3], v[6])) + pad;
    const minZ = Math.min(v[2], Math.min(v[5], v[8])) - pad, maxZ = Math.max(v[2], Math.max(v[5], v[8])) + pad;
    return [Math.floor(minX / this.size), Math.floor(maxX / this.size), Math.floor(minZ / this.size), Math.floor(maxZ / this.size)];
  }

  add(id, v, pad) {
    const [x0, x1, z0, z1] = this.range(v, pad);
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++) {
        const k = x * TWO32 + (z >>> 0);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(id);
      }
  }

  query(v, pad, result) {
    result.length = 0;
    this.seen.clear();
    const [x0, x1, z0, z1] = this.range(v, pad);
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++) {
        const list = this.cells.get(x * TWO32 + (z >>> 0));
        if (list) for (const id of list) if (!this.seen.has(id)) { this.seen.add(id); result.push(id); }
      }
  }
}

// ===================== waypoints =====================

const cloneNode = (n) => ({ ...n, reserved: n.reserved.slice(), links: [] });
const newNode = (x, y, z, radius) => ({ x: f(x), y: f(y), z: f(z), radius: f(radius), flag: 0, reserved: [0, 0, 0, 0, 0, 0, 0, 0], links: [] });
const pairKey = (a, b) => (a < b ? a * TWO32 + b : b * TWO32 + a);
/** Neighbours of node i within MAX_NEW_LINK across and 500 up or down, nearest first (ties by index). */
function nearNodes(nodes, removed, i, skip) {
  const near = [];
  for (let j = 0; j < nodes.length; j++) {
    if (j === i || removed[j] || skip(j)) continue;
    const dx = f(nodes[j].x - nodes[i].x), dz = f(nodes[j].z - nodes[i].z), dy = f(nodes[j].y - nodes[i].y);
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d <= MAX_NEW_LINK && Math.abs(dy) < 500) near.push([d, j]);
  }
  near.sort((p, q) => (p[0] !== q[0] ? p[0] - q[0] : p[1] - q[1]));
  return near;
}

function rebuildPath(input, res) {
  const src = input.path, n = src.nodes.length;
  const nodes = [], group = [], owner = [];
  const srcIdx = []; // source node index, -1 for copies
  const nodeRef = []; // see nodeRefKey
  const fromSource = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const o = input.nodeOwner && i < input.nodeOwner.length ? input.nodeOwner[i] : -1;
    if ((o >= 0 && input.hidden(o)) || input.removedNodes.has(i)) {
      res.nodesRemoved++;
      continue;
    }
    const w = o >= 0 ? input.world(o) : null;
    const node = cloneNode(src.nodes[i]);
    if (w) {
      place(node, w);
      res.nodesMoved++;
    }
    fromSource[i] = nodes.length;
    nodes.push(node);
    group.push(w ? o : -1);
    owner.push(o);
    srcIdx.push(i);
    nodeRef.push(i);
  }
  const copyMaps = [];
  input.copies.forEach((cp, k) => {
    const map = new Map();
    copyMaps.push(map);
    if (!input.nodeOwner) return;
    for (let i = 0; i < n && i < input.nodeOwner.length; i++) {
      if (input.nodeOwner[i] !== cp.source) continue;
      const node = cloneNode(src.nodes[i]);
      node.flag = 0; // gate nodes are region boundaries; a copy is an ordinary waypoint
      place(node, cp.world);
      map.set(i, nodes.length);
      nodes.push(node);
      group.push(-(k + 2));
      owner.push(cp.object);
      srcIdx.push(-1);
      nodeRef.push(MIN_REF);
      res.nodesAdded++;
    }
  });
  // Waypoints placed by hand: each its own group (so it is linked to its neighbours like a moved one).
  const firstHand = nodes.length;
  const byRef = new Map();
  for (let i = 0; i < n; i++) if (fromSource[i] >= 0) byRef.set(i, fromSource[i]);
  input.handNodes.forEach((h, j) => {
    byRef.set(-(h.id + 1), nodes.length);
    nodes.push(newNode(h.x, h.y, h.z, h.radius));
    group.push(-(input.copies.length + 2 + j));
    owner.push(-1);
    srcIdx.push(-1);
    nodeRef.push(-(h.id + 1));
    res.nodesAdded++;
  });
  const walk = res.nav ? new NavQuery(res.nav) : input.nav ? new NavQuery(input.nav) : null;
  if (walk && input.nav) walk.ground = res.nav ? new NavQuery(input.nav) : walk;
  // Gates moved out of water and waypoints added on detours: each its own group, like a hand-placed one.
  let nextGroup = -(input.copies.length + 2 + input.handNodes.length);
  const movedGates = [];
  // Waypoints now inside something that was placed there are gone.
  const removed = new Array(nodes.length).fill(false);
  for (const bl of input.blockers)
    for (let i = 0; i < nodes.length; i++)
      if (!removed[i] && owner[i] !== bl.object && bl.occupies(nodes[i].x, nodes[i].y, nodes[i].z)) {
        // Region gates hand bots from one area to the next; losing one can cut a region off, so it stays. In water
        // that kills, bots heading for it would drown: it goes to the nearest dry ground instead.
        if (nodes[i].flag === 1) {
          if (bl.water && walk && ashore(nodes[i], owner[i], input.blockers, walk)) {
            group[i] = nextGroup--;
            movedGates.push(i);
            res.gatesMoved++;
          } else res.gatesKept++;
          continue;
        }
        removed[i] = true;
        res.nodesRemoved++;
      }

  const links = [];
  const linkSource = []; // source link index, -1 for new
  const seen = new Set();
  const cut = (a, b) =>
    input.cutLinks.size > 0 && nodeRef[a] !== MIN_REF && nodeRef[b] !== MIN_REF && input.cutLinks.has(nodeRefKey(nodeRef[a], nodeRef[b]));
  const tryAdd = (a, b, words, from) => {
    if (a === b || removed[a] || removed[b] || cut(a, b)) return false;
    const key = pairKey(a, b);
    if (seen.has(key)) return false;
    seen.add(key);
    links.push({ a, b, words });
    linkSource.push(from);
    return true;
  };
  src.links.forEach((l, li) => {
    const a = fromSource[l.a], b = fromSource[l.b];
    if (a < 0 || b < 0 || removed[a] || removed[b]) {
      res.linksRemoved++;
      return;
    }
    const sameGroup = group[a] === group[b];
    const keep = !crossesBlocker(input.blockers, nodes[a], owner[a], nodes[b], owner[b], walk) &&
      (sameGroup || !walk || walk.supported(nodes[a], nodes[b]));
    if (keep && !cut(a, b)) tryAdd(a, b, l.words.slice(), li);
    else res.linksRemoved++;
  });
  input.copies.forEach((cp, k) => {
    for (const l of src.links) {
      const a = copyMaps[k].get(l.a), b = copyMaps[k].get(l.b);
      if (a !== undefined && b !== undefined && tryAdd(a, b, l.words.slice(), -1)) res.linksAdded++;
    }
  });
  // Links made by hand go in as they are (no walkability check: the author knows the way).
  for (const [ka, kb] of input.handLinks) {
    const a = byRef.get(ka), b = byRef.get(kb);
    if (a !== undefined && b !== undefined && tryAdd(a, b, defaultLinkWords(), -1)) res.linksAdded++;
  }

  // Link moved / copied waypoints that used to connect outside their object to their new neighbours.
  if (walk) {
    const want = new Int32Array(nodes.length);
    for (const l of src.links) {
      const oa = input.nodeOwner && l.a < input.nodeOwner.length ? input.nodeOwner[l.a] : -1;
      const ob = input.nodeOwner && l.b < input.nodeOwner.length ? input.nodeOwner[l.b] : -1;
      if (oa === ob) continue;
      // A link leaving an object: its end on the object wants an outside link wherever that end now is.
      for (const [end, own] of [[l.a, oa], [l.b, ob]]) {
        if (own < 0) continue;
        const mapped = fromSource[end];
        if (mapped >= 0 && group[mapped] !== -1) want[mapped]++;
        input.copies.forEach((cp, k) => {
          const c = cp.source === own ? copyMaps[k].get(end) : undefined;
          if (c !== undefined) want[c]++;
        });
      }
    }
    const outside = new Int32Array(nodes.length);
    for (const l of links) if (group[l.a] !== group[l.b]) { outside[l.a]++; outside[l.b]++; }
    for (let i = 0; i < nodes.length; i++) {
      if (removed[i] || want[i] === 0 || outside[i] >= want[i]) continue;
      let tries = 0;
      for (const [, j] of nearNodes(nodes, removed, i, (j) => group[j] === group[i])) {
        if (outside[i] >= want[i] || ++tries > 8) break;
        if (walk.supported(nodes[i], nodes[j]) && !crossesBlocker(input.blockers, nodes[i], owner[i], nodes[j], owner[j], walk) &&
          tryAdd(i, j, defaultLinkWords(), -1)) {
          outside[i]++;
          outside[j]++;
          res.linksAdded++;
        }
      }
    }
  }

  if (walk) {
    // Waypoints that lost links to something placed in their way get new ones around it (up to what they had, max 2).
    const degree = new Int32Array(nodes.length);
    const linked = new Set();
    for (const l of links) {
      degree[l.a]++;
      degree[l.b]++;
      linked.add(pairKey(l.a, l.b));
    }
    for (let i = 0; i < nodes.length; i++) {
      const handNode = i >= firstHand;
      if (removed[i] || (srcIdx[i] < 0 && !handNode)) continue;
      // A waypoint placed by hand is linked to its two nearest reachable neighbours.
      const target = handNode ? 2 : Math.min(2, src.nodes[srcIdx[i]].links.length);
      if (degree[i] >= target) continue;
      let tries = 0;
      for (const [, j] of nearNodes(nodes, removed, i, () => false)) {
        if (degree[i] >= target || ++tries > 10) break;
        const key = pairKey(i, j);
        if (linked.has(key)) continue;
        if (walk.supported(nodes[i], nodes[j]) && !crossesBlocker(input.blockers, nodes[i], owner[i], nodes[j], owner[j], walk) &&
          tryAdd(i, j, defaultLinkWords(), -1)) {
          linked.add(key);
          degree[i]++;
          degree[j]++;
          res.linksAdded++;
        }
      }
    }
  }
  // A detour: new waypoints from waypoint `from` along the nav mesh to the nearest of `targets`, linked in a chain
  // (they join `region`, or the region of the nearest waypoint when it's -1).
  const regionHint = new Map();
  const detour = (from, targets, region) => {
    const r = route(walk, input.blockers, nodes, owner, from, targets);
    if (!r) return false;
    let prev = from;
    for (const p of r.way) {
      const k = nodes.length;
      nodes.push(newNode(p[0], p[1], p[2], DETOUR_RADIUS));
      group.push(nextGroup--);
      owner.push(-1);
      srcIdx.push(-1);
      nodeRef.push(MIN_REF);
      removed.push(false);
      if (region >= 0) regionHint.set(k, region);
      res.detourNodes++;
      if (tryAdd(prev, k, defaultLinkWords(), -1)) res.linksAdded++;
      prev = k;
    }
    if (tryAdd(prev, r.reached, defaultLinkWords(), -1)) res.linksAdded++;
    return true;
  };
  // A gate moved out of water keeps a link into every region it joins: when none of its links reaches one, a detour
  // leads from the gate to that region's nearest waypoint.
  if (walk)
    for (const gi of movedGates)
      src.regions.forEach((reg, r) => {
        if (!reg.gates.includes(srcIdx[gi])) return;
        const members = [];
        for (const v of reg.nodes) if (v >= 0 && v < n && fromSource[v] >= 0 && !removed[fromSource[v]]) members.push(fromSource[v]);
        let reaches = false;
        for (const l of links)
          if ((l.a === gi && members.includes(l.b)) || (l.b === gi && members.includes(l.a))) { reaches = true; break; }
        if (!reaches && members.length > 0) detour(gi, members, r);
      });
  if (walk) joinPockets(nodes, links, removed, srcIdx, src, owner, input.blockers, walk, tryAdd, detour, res);
  {
    // Copied waypoints that ended up joined to no original waypoint can't be reached by any bot: drop them.
    const adj = nodes.map(() => []);
    for (const l of links) { adj[l.a].push(l.b); adj[l.b].push(l.a); }
    const visited = new Uint8Array(nodes.length), stack = [], members = [];
    for (let s = 0; s < nodes.length; s++) {
      if (visited[s] || removed[s] || srcIdx[s] >= 0 || s >= firstHand) continue;
      members.length = 0;
      let reachesOriginal = false;
      visited[s] = 1;
      stack.push(s);
      while (stack.length) {
        const v = stack.pop();
        members.push(v);
        if (srcIdx[v] >= 0 || v >= firstHand) reachesOriginal = true;
        for (const w of adj[v]) if (!removed[w] && !visited[w]) { visited[w] = 1; stack.push(w); }
      }
      if (reachesOriginal) continue;
      for (const v of members) {
        removed[v] = true;
        res.nodesAdded--;
        res.copyIslandNodes++;
      }
    }
  }

  // Compact nodes, rebuild per-node link lists and the region lists.
  const remap = new Int32Array(nodes.length);
  const g = { version: src.version, nodes: [], links: [], regions: [] };
  const outGroup = [], outObject = [], outRef = [];
  for (let i = 0; i < nodes.length; i++) {
    remap[i] = removed[i] ? -1 : g.nodes.length;
    if (removed[i]) continue;
    g.nodes.push(nodes[i]);
    outGroup.push(group[i]);
    outObject.push(owner[i]);
    outRef.push(nodeRef[i]);
  }
  const linkRemap = new Map();
  links.forEach((l, li) => {
    if (remap[l.a] < 0 || remap[l.b] < 0) {
      if (linkSource[li] < 0) res.linksAdded--; // a new link of a dropped copy
      return;
    }
    l.a = remap[l.a];
    l.b = remap[l.b];
    const idx = g.links.length;
    g.links.push(l);
    g.nodes[l.a].links.push(idx);
    g.nodes[l.b].links.push(idx);
    if (linkSource[li] >= 0) linkRemap.set(linkSource[li], idx);
  });
  // Source node index → output index, for region membership (copies join their source's region).
  const nodeOut = new Int32Array(n);
  for (let i = 0; i < n; i++) nodeOut[i] = fromSource[i] >= 0 ? remap[fromSource[i]] : -1;
  const regionOfSource = new Map();
  src.regions.forEach((reg, r) => {
    for (const v of reg.nodes) if (!regionOfSource.has(v)) regionOfSource.set(v, r);
  });
  const regionOfOut = new Map();
  for (const sr of src.regions) {
    const r = { id: sr.id, reserved: sr.reserved.slice(), nodes: [], gates: [], links: [] };
    for (const v of sr.nodes)
      if (v >= 0 && v < n && nodeOut[v] >= 0) {
        r.nodes.push(nodeOut[v]);
        regionOfOut.set(nodeOut[v], g.regions.length);
      }
    for (const v of sr.gates) if (v >= 0 && v < n && nodeOut[v] >= 0) r.gates.push(nodeOut[v]);
    for (const li of sr.links) if (linkRemap.has(li)) r.links.push(linkRemap.get(li));
    g.regions.push(r);
  }
  input.copies.forEach((cp, k) => {
    for (const [from, to] of copyMaps[k]) {
      const o = remap[to], r = regionOfSource.get(from);
      if (o >= 0 && r !== undefined && r < g.regions.length) {
        g.regions[r].nodes.push(o);
        regionOfOut.set(o, r);
      }
    }
  });
  // Waypoints placed by hand join the region of the nearest waypoint that has one (a gate's detour, the gate's region
  // it leads into).
  for (let i = firstHand; i < nodes.length; i++) {
    const o = remap[i];
    if (o < 0) continue;
    let region = regionHint.get(i);
    if (region === undefined || region >= g.regions.length) {
      region = -1;
      let best = Number.MAX_VALUE;
      for (const [k, v] of regionOfOut) {
        const m = g.nodes[k];
        const dx = f(m.x - nodes[i].x), dy = f(m.y - nodes[i].y), dz = f(m.z - nodes[i].z), d = dx * dx + dy * dy + dz * dz;
        if (d < best) { best = d; region = v; }
      }
    }
    if (region >= 0) {
      g.regions[region].nodes.push(o);
      regionOfOut.set(o, region);
    }
  }
  const listed = new Set();
  for (const r of g.regions) for (const li of r.links) listed.add(li);
  g.links.forEach((l, li) => {
    if (listed.has(li)) return;
    const r = regionOfOut.has(l.a) ? regionOfOut.get(l.a) : regionOfOut.get(l.b);
    if (r !== undefined) g.regions[r].links.push(li);
  });
  res.path = g;
  res.nodeGroup = Int32Array.from(outGroup);
  res.nodeObject = Int32Array.from(outObject);
  res.nodeRef = Int32Array.from(outRef);
}

/**
 * Waypoint groups the edits cut off from the rest (a wall placed across a corridor): each is joined back to the
 * largest group by the shortest walkable link that clears everything placed (up to 2 × MAX_NEW_LINK), or a detour
 * when there's none. Groups of 3 or fewer with no gate that can't be joined go. Up to 8 passes (a join can make room for
 * the next).
 */
function joinPockets(nodes, links, removed, srcIdx, src, owner, blockers, walk, tryAdd, detour, res) {
  for (let pass = 0; pass < 8; pass++) {
    const n = nodes.length;
    const comp = new Int32Array(n).fill(-1);
    const adj = [];
    for (let i = 0; i < n; i++) adj.push([]);
    for (const l of links) { adj[l.a].push(l.b); adj[l.b].push(l.a); }
    const sizes = [];
    const stack = [];
    for (let s = 0; s < n; s++) {
      if (removed[s] || comp[s] >= 0) continue;
      const c = sizes.length;
      let size = 0;
      comp[s] = c;
      stack.push(s);
      while (stack.length) {
        const v = stack.pop();
        size++;
        for (const w of adj[v]) if (!removed[w] && comp[w] < 0) { comp[w] = c; stack.push(w); }
      }
      sizes.push(size);
    }
    if (sizes.length <= 1) return;
    let main = 0;
    for (let c = 1; c < sizes.length; c++) if (sizes[c] > sizes[main]) main = c;
    let joinedAny = false;
    let left = 0;
    for (let c = 0; c < sizes.length; c++) {
      if (c === main) continue;
      // Only groups that were part of the graph before (never the authored lone waypoints).
      let wasLinked = false;
      for (let i = 0; i < n && !wasLinked; i++)
        if (comp[i] === c && srcIdx[i] >= 0 && src.nodes[srcIdx[i]].links.length > 0) wasLinked = true;
      if (!wasLinked) continue;
      const pairs = [];
      for (let i = 0; i < n; i++) {
        if (comp[i] !== c) continue;
        for (let j = 0; j < n; j++) {
          if (comp[j] !== main) continue;
          const dx = f(nodes[j].x - nodes[i].x), dz = f(nodes[j].z - nodes[i].z), dy = f(nodes[j].y - nodes[i].y);
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d <= MAX_NEW_LINK * 2 && Math.abs(dy) < 500) pairs.push([d, i, j]);
        }
      }
      // Stable by distance (the desktop's List.Sort only differs on exactly equal distances).
      pairs.sort((p, q) => p[0] - q[0]);
      let joined = false;
      for (let k = 0; k < pairs.length && k < 40 && !joined; k++) {
        const [, i, j] = pairs[k];
        if (walk.supported(nodes[i], nodes[j]) && !crossesBlocker(blockers, nodes[i], owner[i], nodes[j], owner[j], walk) &&
          tryAdd(i, j, defaultLinkWords(), -1)) {
          joined = true;
          res.linksAdded++;
        }
      }
      if (!joined) {
        const mainNodes = [];
        for (let j = 0; j < n; j++) if (comp[j] === main) mainNodes.push(j);
        const starts = [];
        for (let i = 0; i < n; i++) {
          if (comp[i] !== c) continue;
          let best = Number.MAX_VALUE;
          for (const j of mainNodes) {
            const dx = f(nodes[j].x - nodes[i].x), dz = f(nodes[j].z - nodes[i].z);
            best = Math.min(best, dx * dx + dz * dz);
          }
          starts.push([best, i]);
        }
        starts.sort((p, q) => p[0] - q[0]);
        for (let k = 0; k < starts.length && k < 4 && !joined; k++) joined = detour(starts[k][1], mainNodes, -1);
      }
      if (joined) {
        res.pocketsJoined++;
        joinedAny = true;
      } else if (sizes[c] <= 3 && !hasGate(nodes, comp, c)) {
        // A waypoint or two no bot can walk to any more (a speck of dry ground at the rim of new water): bots heading
        // for it would only walk into what's in the way, so it goes. Gates stay.
        for (let i = 0; i < n; i++)
          if (comp[i] === c) { removed[i] = true; res.nodesRemoved++; }
        res.pocketsDropped++;
      } else left++;
    }
    if (!joinedAny) {
      res.pocketsLeft += left;
      return;
    }
  }
}

function hasGate(nodes, comp, c) {
  for (let i = 0; i < comp.length; i++) if (comp[i] === c && nodes[i].flag === 1) return true;
  return false;
}

/**
 * Whether a link now runs through something placed in its way (an object's own waypoints are exempt). Water is tested
 * at the ground under the link (walk.ground), not at the line's height: a link climbing a slope can pass above a lake's
 * surface while the ground a bot walks on is under it.
 */
function crossesBlocker(blockers, a, ownerA, b, ownerB, walk) {
  if (blockers.length === 0) return false;
  const dx = f(b.x - a.x), dy = f(b.y - a.y), dz = f(b.z - a.z);
  const steps = Math.max(2, Math.ceil(Math.sqrt(dx * dx + dz * dz) / 50.0));
  for (const bl of blockers) {
    if (bl.object === ownerA || bl.object === ownerB) continue;
    for (let s = 1; s < steps; s++) {
      const t = s / steps, x = a.x + dx * t, y = a.y + dy * t, z = a.z + dz * t;
      if (bl.occupies(x, bl.water ? groundAt(walk, x, y, z) : y, z)) return true;
    }
  }
  return false;
}

/** Height of the stage's walkable ground under a point (its nav mesh before the edits), or the point's own height where there's none. */
function groundAt(walk, x, y, z) {
  const ground = walk ? walk.ground : null;
  if (!ground) return y;
  const c = ground.cellAt(x, y, z);
  const g = c < 0 ? NaN : ground.groundY(c, x, z);
  return Number.isNaN(g) ? y : g;
}

/** Whether a point and the ring of 8 points `margin` around it (at its height) are free of everything placed (an object's own blockers excepted; water tested at the ground there). */
function clear(blockers, own, x, y, z, margin, walk) {
  for (const bl of blockers) {
    if (bl.object === own) continue;
    for (let s = -1; s < 8; s++) {
      const a = (s * Math.PI) / 4, px = s < 0 ? x : x + margin * Math.cos(a), pz = s < 0 ? z : z + margin * Math.sin(a);
      if (bl.occupies(px, bl.water ? groundAt(walk, px, y, pz) : y, pz)) return false;
    }
  }
  return true;
}

/**
 * Moves a waypoint standing in new water to the nearest walkable ground with DETOUR_RADIUS of dry ground round it
 * (rings 100 units apart, out to 3000), and shrinks its radius to the dry ground it has there. False (and unmoved) when
 * there's no such ground.
 */
function ashore(node, own, blockers, walk) {
  for (let r = 100; r <= 3000; r += 100) {
    const steps = Math.max(12, Math.ceil((2 * Math.PI * r) / 100.0));
    for (let s = 0; s < steps; s++) {
      const a = (2 * Math.PI * s) / steps, x = node.x + r * Math.cos(a), z = node.z + r * Math.sin(a);
      const c = walk.cellAt(x, node.y, z);
      if (c < 0) continue;
      const y = walk.groundY(c, x, z);
      if (Number.isNaN(y) || !clear(blockers, own, x, y, z, DETOUR_RADIUS, walk)) continue;
      let radius = node.radius;
      while (radius > DETOUR_RADIUS && !clear(blockers, own, x, y, z, radius, walk)) radius *= 0.75;
      node.x = f(x); node.y = f(y); node.z = f(z);
      node.radius = f(Math.max(DETOUR_RADIUS, Math.min(node.radius, radius)));
      return true;
    }
  }
  return false;
}

/** Min-heap of [cost, cell], ordered by cost then cell (as the desktop's SortedSet of (double, int)). */
class CostHeap {
  constructor() { this.h = []; }
  get size() { return this.h.length; }
  static less(a, b) { return a[0] !== b[0] ? a[0] < b[0] : a[1] < b[1]; }
  push(e) {
    const h = this.h;
    h.push(e);
    for (let i = h.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (!CostHeap.less(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }
  pop() {
    const h = this.h, top = h[0], last = h.pop();
    if (h.length) {
      h[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && CostHeap.less(h[l], h[m])) m = l;
        if (r < h.length && CostHeap.less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * A way round what blocks the straight line from waypoint `from` to the nearest (by walking) of `targets`: the
 * shortest path over the nav cells (a cell partly under something placed costs more) pulled taut into legs of at most
 * MAX_NEW_LINK, each walkable and unblocked, every new waypoint with DETOUR_RADIUS of free ground round it. Returns
 * {way: the new waypoints' positions in order, reached: the target the last leg ends on}, or null when there's no such way.
 */
function route(walk, blockers, nodes, owner, from, targets) {
  const a = nodes[from];
  const start = walk.cellAt(a.x, a.y, a.z);
  if (start < 0) return null;
  const goal = new Map();
  for (const t of targets) {
    const c = walk.cellAt(nodes[t].x, nodes[t].y, nodes[t].z);
    if (c >= 0 && !goal.has(c)) goal.set(c, t);
  }
  if (goal.size === 0) return null;
  const cells = walk.nav.cells;
  const adj = walk.neighbours();
  const dist = new Float64Array(cells.length).fill(Number.MAX_VALUE);
  const prev = new Int32Array(cells.length).fill(-1);
  const wet = new Int32Array(cells.length).fill(-1);
  // Lazy deletion: an entry whose cost is above its cell's current distance was replaced (the SortedSet removes it).
  const open = new CostHeap();
  dist[start] = 0;
  open.push([0, start]);
  let end = -1;
  while (open.size) {
    const top = open.pop();
    const c = top[1];
    if (top[0] > dist[c]) continue;
    if (goal.has(c)) { end = c; break; }
    const pc = centre(cells[c].v, 0);
    for (const d of adj[c]) {
      if (wet[d] < 0) wet[d] = blockedSamples(blockers, cells[d].v);
      const pd = centre(cells[d].v, 0);
      const sx = pd[0] - pc[0], sy = pd[1] - pc[1], sz = pd[2] - pc[2];
      const cost = top[0] + Math.sqrt(sx * sx + sy * sy + sz * sz) * (1 + 2 * wet[d]);
      if (cost < dist[d]) {
        dist[d] = cost;
        prev[d] = c;
        open.push([cost, d]);
      }
    }
  }
  if (end < 0) return null;
  const reached = goal.get(end);
  const path = [];
  for (let c = end; c >= 0; c = prev[c]) path.push(c);
  path.reverse();
  // Points a leg may end on: where the path crosses from one cell to the next, and each cell's centre.
  const points = [];
  for (let i = 1; i < path.length; i++) {
    const gate = portal(cells[path[i - 1]].v, cells[path[i]].v);
    if (gate) points.push(gate);
    points.push(centre(cells[path[i]].v, 0));
  }
  const b = nodes[reached];
  points.push([b.x, b.y, b.z]);
  const way = [];
  let here = a, hereOwner = owner[from], at = -1;
  for (;;) {
    let best = -1;
    for (let k = at + 1; k < points.length; k++) {
      const p = points[k];
      const dx = p[0] - here.x, dz = p[2] - here.z;
      if (dx * dx + dz * dz > MAX_NEW_LINK * MAX_NEW_LINK) continue;
      const last = k === points.length - 1;
      if (!last && !clear(blockers, -1, p[0], p[1], p[2], DETOUR_RADIUS, walk)) continue;
      const there = { x: f(p[0]), y: f(p[1]), z: f(p[2]) };
      if (walk.supported(here, there) && !crossesBlocker(blockers, here, hereOwner, there, last ? owner[reached] : -1, walk)) best = k;
    }
    if (best < 0 || way.length > 60) return null;
    if (best === points.length - 1) return { way, reached };
    const q = points[best];
    way.push([f(q[0]), f(q[1]), f(q[2])]);
    here = { x: f(q[0]), y: f(q[1]), z: f(q[2]) };
    hereOwner = -1;
    at = best;
  }
}

/** Where on a nav mesh a point stands, and whether a straight walk between two points stays on it. */
class NavQuery {
  static SIZE = 300.0;
  /** A sample counts as on the mesh within this horizontal distance of a cell (waypoints sit near edges). */
  static SLACK = 60.0;
  static HEIGHT = 250.0;

  constructor(nav) {
    this.nav = nav;
    /** The stage's nav mesh as it was before the edits (nothing carved): where the ground is, for water tests. */
    this.ground = null;
    this.cells = new Map();
    this._neighbours = null;
    const S = NavQuery.SIZE, L = NavQuery.SLACK;
    nav.cells.forEach((cell, c) => {
      const v = cell.v;
      const x0 = Math.floor((Math.min(v[0], v[3], v[6]) - L) / S), x1 = Math.floor((Math.max(v[0], v[3], v[6]) + L) / S);
      const z0 = Math.floor((Math.min(v[2], v[5], v[8]) - L) / S), z1 = Math.floor((Math.max(v[2], v[5], v[8]) + L) / S);
      for (let x = x0; x <= x1; x++)
        for (let z = z0; z <= z1; z++) {
          const k = x * TWO32 + (z >>> 0);
          let list = this.cells.get(k);
          if (!list) this.cells.set(k, (list = []));
          list.push(c);
        }
    });
  }

  bucket(x, z) {
    return this.cells.get(Math.floor(x / NavQuery.SIZE) * TWO32 + (Math.floor(z / NavQuery.SIZE) >>> 0));
  }

  /** The cell a point stands on (see near; of several, the one whose plane is nearest its height), -1 none. */
  cellAt(x, y, z) {
    const list = this.bucket(x, z);
    if (!list) return -1;
    let best = -1, bestDy = Number.MAX_VALUE;
    for (const c of list) {
      const v = this.nav.cells[c].v;
      if (!NavQuery.near(v, x, y, z)) continue;
      const dy = Math.abs(planeY(v, x, z) - y);
      if (dy < bestDy) { bestDy = dy; best = c; }
    }
    return best;
  }

  /** Height of cell c's plane at (x, z). */
  groundY(c, x, z) {
    return planeY(this.nav.cells[c].v, x, z);
  }

  /** Per cell, the cells a bot can walk to across an edge (positive links, both ways; drops left out). */
  neighbours() {
    if (this._neighbours) return this._neighbours;
    const cells = this.nav.cells, n = cells.length;
    const nb = [];
    for (let c = 0; c < n; c++) nb.push([]);
    for (let c = 0; c < n; c++)
      for (const l of cells[c].links)
        if (l >= 0 && l < n && l !== c) {
          if (!nb[c].includes(l)) nb[c].push(l);
          if (!nb[l].includes(c)) nb[l].push(c);
        }
    return (this._neighbours = nb);
  }

  supported(a, b) {
    const dx = f(b.x - a.x), dy = f(b.y - a.y), dz = f(b.z - a.z);
    const steps = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dz * dz) / 150.0));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      if (!this.onMesh(a.x + dx * t, a.y + dy * t, a.z + dz * t)) return false;
    }
    return true;
  }

  onMesh(x, y, z) {
    const list = this.bucket(x, z);
    if (!list) return false;
    for (const c of list) if (NavQuery.near(this.nav.cells[c].v, x, y, z)) return true;
    return false;
  }

  /** Within SLACK of the cell in XZ, and within HEIGHT of its plane there. */
  static near(v, x, y, z) {
    const ax = v[0], az = v[2], bx = v[3], bz = v[5], cx = v[6], cz = v[8];
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-9) return false;
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
    const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
    const l3 = 1 - l1 - l2;
    const py = l1 * v[1] + l2 * v[4] + l3 * v[7];
    if (Math.abs(py - y) > NavQuery.HEIGHT) return false;
    if (l1 >= 0 && l2 >= 0 && l3 >= 0) return true;
    const s2 = NavQuery.SLACK * NavQuery.SLACK;
    return segDist2(x, z, ax, az, bx, bz) <= s2 || segDist2(x, z, bx, bz, cx, cz) <= s2 || segDist2(x, z, cx, cz, ax, az) <= s2;
  }
}

function segDist2(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz;
  let t = l2 > 0 ? ((px - ax) * vx + (pz - az) * vz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + vx * t - px, qz = az + vz * t - pz;
  return qx * qx + qz * qz;
}
