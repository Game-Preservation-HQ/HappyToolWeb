// The stage's bot navigation, ported from HappyTool/RrmConvert/StageNav.cs (NavMeshData, PathGraphData) and the map
// view's nav overlay (StageViewerForm.Nav.cs InitLiveNav / UploadLiveNav, key P). A stage bundle carries two .spd files:
//
//  - navi000.spd, the nav mesh (where bots can walk). Little-endian "navm", version (1), cell count, a u32 offset
//    table, then the cells: a 0x20-byte head (zero apart from an area value at +4 on a few cells), the triangle's
//    three corners (9 floats at +0x20), a link count at +0x44 and the links at +0x48. A link >= 0 is the neighbour
//    across a shared edge; a negative one (-index) is a one-way drop down a ledge. An empty list still holds one
//    placeholder word (0xFFFFFFFF).
//  - path000.spd, the waypoint graph (the routes bots take). Little-endian "spd_", version (1), node, link and region
//    counts, three u32 offset tables, then the nodes, links and regions back to back. A node is its centre, radius,
//    flag (1 on the gates between regions), 8 reserved words, a link count, a pointer to the list (right after the
//    node) and the indices of the links touching it. A link is 48 bytes: two node indices and ten more words. A region
//    is its id, node / gate / link counts, 8 reserved words, three list pointers, then those three lists.
//
// The Xbox 360 files are the same layout big-endian ("mvan", "_dps") and made only of 4-byte lanes, so swapping every
// lane gives the Steam file (Spd360ToSteamConverter).

import { decodeLayers } from './wrappers.js';

export const NAV_HEAD = 0x20;

const magic = (d, s) => d[0] === s.charCodeAt(0) && d[1] === s.charCodeAt(1) && d[2] === s.charCodeAt(2) && d[3] === s.charCodeAt(3);

/** Whether the bytes start as a Steam nav mesh (LooksLikeNav). */
export const looksLikeNav = (d) => !!d && d.length >= 12 && magic(d, 'navm');
/** Whether the bytes start as a Steam waypoint graph (LooksLikePath). */
export const looksLikePath = (d) => !!d && d.length >= 0x14 && magic(d, 'spd_');
/** Whether the bytes start as an Xbox 360 .spd, either kind (Is360Spd). */
export const is360Spd = (d) => !!d && d.length >= 16 && (magic(d, 'mvan') || magic(d, '_dps'));

/** A 360 .spd as the Steam file: every 4-byte lane swapped (Spd360ToSteamConverter.Convert). */
export function spd360ToSteam(d) {
  const o = new Uint8Array(d.length);
  let k = 0;
  for (; k + 4 <= d.length; k += 4) {
    o[k] = d[k + 3];
    o[k + 1] = d[k + 2];
    o[k + 2] = d[k + 1];
    o[k + 3] = d[k];
  }
  for (; k < d.length; k++) o[k] = d[k];
  return o;
}

const view = (d) => new DataView(d.buffer, d.byteOffset, d.byteLength);

/** A nav mesh {version, cells: [{head, v, links}]}, or null when the layout isn't the one above (NavMeshData.Parse). */
export function parseNavMesh(d) {
  if (!looksLikeNav(d)) return null;
  const dv = view(d), n = dv.getInt32(8, true);
  if (n < 0 || 12 + 4 * n > d.length) return null;
  const nav = { version: dv.getUint32(4, true), cells: [] };
  for (let i = 0; i < n; i++) {
    const o = dv.getInt32(12 + 4 * i, true);
    if (o < 12 + 4 * n || o + 0x48 > d.length) return null;
    const c = dv.getInt32(o + 0x44, true);
    if (c < 0 || c > 256 || o + 0x48 + 4 * c > d.length) return null;
    const v = new Float32Array(9), links = new Array(c);
    for (let k = 0; k < 9; k++) v[k] = dv.getFloat32(o + 0x20 + 4 * k, true);
    for (let k = 0; k < c; k++) links[k] = dv.getInt32(o + 0x48 + 4 * k, true);
    nav.cells.push({ head: d.slice(o, o + NAV_HEAD), v, links });
  }
  return nav;
}

/** The nav mesh's bytes (NavMeshData.Write). */
export function writeNavMesh(nav) {
  const n = nav.cells.length;
  let size = 12 + 4 * n;
  for (const c of nav.cells) size += 0x48 + 4 * Math.max(1, c.links.length);
  const o = new Uint8Array(size), dv = view(o);
  o.set([0x6e, 0x61, 0x76, 0x6d]);
  dv.setUint32(4, nav.version >>> 0, true);
  dv.setUint32(8, n, true);
  let at = 12 + 4 * n;
  nav.cells.forEach((c, i) => {
    dv.setUint32(12 + 4 * i, at, true);
    o.set(c.head.subarray(0, NAV_HEAD), at);
    for (let k = 0; k < 9; k++) dv.setFloat32(at + 0x20 + 4 * k, c.v[k], true);
    dv.setUint32(at + 0x44, c.links.length, true);
    c.links.forEach((l, k) => dv.setInt32(at + 0x48 + 4 * k, l, true));
    if (!c.links.length) dv.setUint32(at + 0x48, 0xffffffff, true); // the empty list's placeholder word
    at += 0x48 + 4 * Math.max(1, c.links.length);
  });
  return o;
}

export const cloneNavMesh = (nav) => ({
  version: nav.version,
  cells: nav.cells.map((c) => ({ head: c.head.slice(), v: c.v.slice(), links: c.links.slice() })),
});

/** The words a plain authored link carries (Link.DefaultWords). */
export const defaultLinkWords = () => [0, 0, 0, -1, 0, 0, 0, 0, 0, 0];

/**
 * A waypoint graph {version, nodes: [{x, y, z, radius, flag, reserved, links}], links: [{a, b, words}],
 * regions: [{id, reserved, nodes, gates, links}]}, or null when the layout isn't the one above (PathGraphData.Parse).
 */
export function parsePathGraph(d) {
  if (!looksLikePath(d)) return null;
  const dv = view(d), nn = dv.getInt32(8, true), nl = dv.getInt32(12, true), nr = dv.getInt32(16, true);
  if (nn < 0 || nl < 0 || nr < 0 || 0x14 + 4 * (nn + nl + nr) > d.length) return null;
  const g = { version: dv.getUint32(4, true), nodes: [], links: [], regions: [] };
  const ints = (at, count) => Array.from({ length: count }, (_, k) => dv.getInt32(at + 4 * k, true));
  let tbl = 0x14;
  for (let i = 0; i < nn; i++) {
    const o = dv.getInt32(tbl + 4 * i, true);
    if (o < 0 || o + 0x3c > d.length) return null;
    const c = dv.getInt32(o + 0x34, true), p = dv.getInt32(o + 0x38, true);
    if (c < 0 || c > 4096 || p !== o + 0x3c || p + 4 * c > d.length) return null;
    g.nodes.push({
      x: dv.getFloat32(o, true),
      y: dv.getFloat32(o + 4, true),
      z: dv.getFloat32(o + 8, true),
      radius: dv.getFloat32(o + 12, true),
      flag: dv.getInt32(o + 16, true),
      reserved: ints(o + 20, 8),
      links: ints(p, c),
    });
  }
  tbl += 4 * nn;
  for (let i = 0; i < nl; i++) {
    const o = dv.getInt32(tbl + 4 * i, true);
    if (o < 0 || o + 48 > d.length) return null;
    const a = dv.getInt32(o, true), b = dv.getInt32(o + 4, true);
    if (a < 0 || a >= nn || b < 0 || b >= nn) return null;
    g.links.push({ a, b, words: ints(o + 8, 10) });
  }
  tbl += 4 * nl;
  for (let i = 0; i < nr; i++) {
    const o = dv.getInt32(tbl + 4 * i, true);
    if (o < 0 || o + 0x3c > d.length) return null;
    const n1 = dv.getInt32(o + 4, true), n2 = dv.getInt32(o + 8, true), n3 = dv.getInt32(o + 12, true);
    const p1 = dv.getInt32(o + 0x30, true), p2 = dv.getInt32(o + 0x34, true), p3 = dv.getInt32(o + 0x38, true);
    if (n1 < 0 || n2 < 0 || n3 < 0 || p1 !== o + 0x3c || p2 !== p1 + 4 * n1 || p3 !== p2 + 4 * n2 || p3 + 4 * n3 > d.length) return null;
    g.regions.push({ id: dv.getInt32(o, true), reserved: ints(o + 0x10, 8), nodes: ints(p1, n1), gates: ints(p2, n2), links: ints(p3, n3) });
  }
  return g;
}

/** The waypoint graph's bytes (PathGraphData.Write). */
export function writePathGraph(g) {
  const nn = g.nodes.length, nl = g.links.length, nr = g.regions.length;
  let size = 0x14 + 4 * (nn + nl + nr) + 48 * nl;
  for (const n of g.nodes) size += 0x3c + 4 * n.links.length;
  for (const r of g.regions) size += 0x3c + 4 * (r.nodes.length + r.gates.length + r.links.length);
  const o = new Uint8Array(size), dv = view(o);
  const put = (at, list) => list.forEach((v, k) => dv.setInt32(at + 4 * k, v, true));
  o.set([0x73, 0x70, 0x64, 0x5f]);
  dv.setUint32(4, g.version >>> 0, true);
  dv.setUint32(8, nn, true);
  dv.setUint32(12, nl, true);
  dv.setUint32(16, nr, true);
  let tbl = 0x14, at = 0x14 + 4 * (nn + nl + nr);
  g.nodes.forEach((n, i) => {
    dv.setUint32(tbl + 4 * i, at, true);
    dv.setFloat32(at, n.x, true);
    dv.setFloat32(at + 4, n.y, true);
    dv.setFloat32(at + 8, n.z, true);
    dv.setFloat32(at + 12, n.radius, true);
    dv.setInt32(at + 16, n.flag, true);
    put(at + 20, n.reserved);
    dv.setUint32(at + 0x34, n.links.length, true);
    dv.setUint32(at + 0x38, at + 0x3c, true);
    put(at + 0x3c, n.links);
    at += 0x3c + 4 * n.links.length;
  });
  tbl += 4 * nn;
  g.links.forEach((l, i) => {
    dv.setUint32(tbl + 4 * i, at, true);
    dv.setInt32(at, l.a, true);
    dv.setInt32(at + 4, l.b, true);
    put(at + 8, l.words);
    at += 48;
  });
  tbl += 4 * nl;
  g.regions.forEach((r, i) => {
    dv.setUint32(tbl + 4 * i, at, true);
    const p1 = at + 0x3c, p2 = p1 + 4 * r.nodes.length, p3 = p2 + 4 * r.gates.length;
    dv.setInt32(at, r.id, true);
    dv.setUint32(at + 4, r.nodes.length, true);
    dv.setUint32(at + 8, r.gates.length, true);
    dv.setUint32(at + 12, r.links.length, true);
    put(at + 0x10, r.reserved);
    dv.setUint32(at + 0x30, p1, true);
    dv.setUint32(at + 0x34, p2, true);
    dv.setUint32(at + 0x38, p3, true);
    put(p1, r.nodes);
    put(p2, r.gates);
    put(p3, r.links);
    at = p3 + 4 * r.links.length;
  });
  return o;
}

export const clonePathGraph = (g) => ({
  version: g.version,
  nodes: g.nodes.map((n) => ({ ...n, reserved: n.reserved.slice(), links: n.links.slice() })),
  links: g.links.map((l) => ({ a: l.a, b: l.b, words: l.words.slice() })),
  regions: g.regions.map((r) => ({ id: r.id, reserved: r.reserved.slice(), nodes: r.nodes.slice(), gates: r.gates.slice(), links: r.links.slice() })),
});

/**
 * The stage's nav mesh and waypoint graph read exactly (InitLiveNav): {nav, navName, path, pathName, unread}, the
 * first readable file of each kind; files that hold neither, or an unfamiliar layout, are listed in unread.
 */
export async function readNav(arc) {
  const out = { nav: null, navName: null, path: null, pathName: null, unread: [] };
  for (const e of arc.entries) {
    if (!/\.spd$/i.test(e.name || '')) continue;
    try {
      let d = e.pointer || !e.data?.length ? null : (await decodeLayers(e.data)).payload;
      if (d && is360Spd(d)) d = spd360ToSteam(d);
      if (d && !out.nav && looksLikeNav(d)) {
        out.nav = parseNavMesh(d);
        if (out.nav) out.navName = e.name;
        else out.unread.push(e.name);
      } else if (d && !out.path && looksLikePath(d)) {
        out.path = parsePathGraph(d);
        if (out.path) out.pathName = e.name;
        else out.unread.push(e.name);
      } else if (!d || (!looksLikeNav(d) && !looksLikePath(d))) out.unread.push(e.name);
    } catch {
      out.unread.push(e.name);
    }
  }
  return out;
}

const centre = (v) => [(v[0] + v[3] + v[6]) / 3, (v[1] + v[4] + v[7]) / 3, (v[2] + v[5] + v[8]) / 3];

/**
 * The overlay's line lists (UploadLiveNav), x, y, z per line end: the cells' edges (cyan; cellChanged[c] true: the
 * moved / copied ones), the drop links between cell centres 20 above (magenta), the waypoint links 15 above (orange)
 * and a 20-sided circle per waypoint at least 20 across, 15 above (nodeChanged[i] true: the moved / copied ones).
 */
export function navLines(nav, path, cellChanged = null, nodeChanged = null) {
  const cells = [], changed = [], drops = [], nodes = [], nodesChanged = [], links = [];
  if (nav)
    nav.cells.forEach((c, i) => {
      const v = c.v, dst = cellChanged?.[i] ? changed : cells;
      dst.push(v[0], v[1], v[2], v[3], v[4], v[5], v[3], v[4], v[5], v[6], v[7], v[8], v[6], v[7], v[8], v[0], v[1], v[2]);
      for (const l of c.links) {
        if (l >= 0 || -l >= nav.cells.length) continue;
        const a = centre(v), b = centre(nav.cells[-l].v);
        drops.push(a[0], a[1] + 20, a[2], b[0], b[1] + 20, b[2]);
      }
    });
  if (path) {
    const SEG = 20;
    path.nodes.forEach((n, i) => {
      const dst = nodeChanged?.[i] ? nodesChanged : nodes, r = Math.max(20, n.radius), y = n.y + 15;
      for (let k = 0; k < SEG; k++) {
        const a0 = (k * 2 * Math.PI) / SEG, a1 = ((k + 1) * 2 * Math.PI) / SEG;
        dst.push(n.x + r * Math.cos(a0), y, n.z + r * Math.sin(a0), n.x + r * Math.cos(a1), y, n.z + r * Math.sin(a1));
      }
    });
    for (const l of path.links) {
      const a = path.nodes[l.a], b = path.nodes[l.b];
      links.push(a.x, a.y + 15, a.z, b.x, b.y + 15, b.z);
    }
  }
  const f = (x) => Float32Array.from(x);
  return { cells: f(cells), changed: f(changed), drops: f(drops), nodes: f(nodes), nodesChanged: f(nodesChanged), links: f(links) };
}
