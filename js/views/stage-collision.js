// The stage's collision, ported from HappyTool/RrmConvert/CcpCollisionParser.cs and the map view's collision overlay
// (StageViewerForm.CollectCollisionMeshes / DrawCollisionOverlay, key H). Every .ccp resource in a stage bundle is one
// collision layer (_Chit and the others): a flat chunk list from 0x10, one group per hull, each CCH (tree node), CCB
// (bounds), CCV (8-byte header, a 4-byte field, then float3 vertices) and CCI (8-byte header, then u16 triangle indices
// into that hull's vertices). Steam is little-endian with "CCP\0"; the Xbox 360 is big-endian with "\0PCC" and the tags
// "\0VCC" / "\0ICC". The vertices are already in world space, as the map's meshes are, so nothing is transformed.

import { decodeLayers } from '../formats/wrappers.js';

const C = 0x43, P = 0x50, V = 0x56, I = 0x49;

/** Whether the bytes start as a collision file, in either byte order (LooksLikeCcp). */
export const looksLikeCcp = (d) =>
  !!d && d.length >= 16 && ((d[0] === C && d[1] === C && d[2] === P && d[3] === 0) || (d[0] === 0 && d[1] === P && d[2] === C && d[3] === C));

/**
 * A .ccp's triangles as one mesh {positions, indices}, or null when it isn't one or holds none (Parse). Indices out of
 * their hull or repeating a corner are padding and skipped; reading stops at the first broken chunk, keeping the rest.
 */
export function parseCcp(d) {
  if (!looksLikeCcp(d)) return null;
  const le = d[0] === C;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const positions = [], indices = [];
  let pos = 0x10, hull = 0, base = 0; // hull: the current hull's vertex count (0 when it has none)
  while (pos + 8 <= d.length) {
    const size = dv.getUint32(pos + 4, le);
    if (size < 8 || pos + size > d.length) break;
    // Steam tags read "CCV", "CCI" (4th byte not checked); 360 tags read "\0VCC", "\0ICC".
    const kind = le ? (d[pos] === C && d[pos + 1] === C ? d[pos + 2] : 0) : d[pos] === 0 && d[pos + 2] === C && d[pos + 3] === C ? d[pos + 1] : 0;
    if (kind === V) {
      const n = Math.trunc((size - 12) / 12);
      if (n > 0 && pos + 12 + n * 12 <= d.length) {
        base = positions.length / 3;
        hull = n;
        for (let i = 0; i < n * 3; i++) positions.push(dv.getFloat32(pos + 12 + i * 4, le));
      } else hull = 0;
    } else if (kind === I && hull) {
      const tris = Math.trunc(Math.trunc((size - 8) / 2) / 3);
      for (let t = 0; t < tris; t++) {
        const o = pos + 8 + t * 6;
        const a = dv.getUint16(o, le), b = dv.getUint16(o + 2, le), c = dv.getUint16(o + 4, le);
        if (a >= hull || b >= hull || c >= hull || a === b || b === c || a === c) continue;
        indices.push(base + a, base + b, base + c);
      }
    }
    pos += size;
  }
  if (positions.length < 9 || indices.length < 3) return null;
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

const CCH_SIZE = 0x28; // CCH chunk: 8-byte header + 32-byte node
const CCB_SIZE = 8 + 43 * 4;

/** "CCP\0", "CCH\0"…: three letters then a zero (Tag). */
const tag = (d, o, t) => o + 4 <= d.length && d[o] === t.charCodeAt(0) && d[o + 1] === t.charCodeAt(1) && d[o + 2] === t.charCodeAt(2) && d[o + 3] === 0;

/**
 * A Steam .ccp split into its CCH/CCB/CCV/CCI groups exactly as export reads it (StageEditBaker.ParseCollisionGroups):
 * [{start, length, type, attribute, node, ccb, vertices, triangles, minX…maxZ}], or null when the layout isn't the
 * familiar one (then the collision stays view-only, as on the desktop). The bounds cover all of a group's vertices.
 */
export function parseCollisionGroups(d) {
  if (!d || d.length < 0x10 || !tag(d, 0, 'CCP')) return null;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const u32 = (o) => dv.getUint32(o, true);
  if (u32(4) !== 0x10 || u32(8) !== d.length) return null;
  const groups = [];
  let pos = 0x10;
  while (pos < d.length) {
    if (pos + CCH_SIZE > d.length || !tag(d, pos, 'CCH') || u32(pos + 4) !== CCH_SIZE) return null;
    const len = u32(pos + 16);
    const vc = d[pos + 24] | (d[pos + 25] << 8), ic = d[pos + 28] | (d[pos + 29] << 8), tc = d[pos + 36] | (d[pos + 37] << 8);
    if (len < CCH_SIZE || pos + len > d.length || ic !== tc * 3 || tc === 0) return null;
    const g = { start: pos, length: len, type: u32(pos + 8), attribute: u32(pos + 12), node: [], ccb: 0, vertices: null, triangles: null };
    for (let k = 0; k < 8; k++) g.node.push(u32(pos + 8 + k * 4));
    let c = pos + CCH_SIZE;
    const end = pos + len;
    while (c + 8 <= end) {
      const size = u32(c + 4);
      if (size < 8 || c + size > end) return null;
      if (tag(d, c, 'CCB')) {
        if (size !== CCB_SIZE) return null;
        g.ccb = c + 8;
      } else if (tag(d, c, 'CCV')) {
        if (size !== 12 + vc * 12) return null;
        g.vertices = new Float32Array(vc * 3);
        for (let i = 0; i < vc * 3; i++) g.vertices[i] = dv.getFloat32(c + 12 + i * 4, true);
      } else if (tag(d, c, 'CCI')) {
        if (size !== 8 + ((ic * 2 + 3) & ~3)) return null;
        g.triangles = new Uint16Array(ic);
        for (let i = 0; i < ic; i++) {
          const v = d[c + 8 + i * 2] | (d[c + 9 + i * 2] << 8);
          if (v >= vc) return null;
          g.triangles[i] = v;
        }
      } else return null;
      c += size;
    }
    if (!g.ccb || !g.vertices || !g.triangles || c !== end) return null;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    const v = g.vertices;
    for (let i = 0; i < v.length; i += 3) {
      if (v[i] < x0) x0 = v[i];
      if (v[i] > x1) x1 = v[i];
      if (v[i + 1] < y0) y0 = v[i + 1];
      if (v[i + 1] > y1) y1 = v[i + 1];
      if (v[i + 2] < z0) z0 = v[i + 2];
      if (v[i + 2] > z1) z1 = v[i + 2];
    }
    Object.assign(g, { minX: x0, minY: y0, minZ: z0, maxX: x1, maxY: y1, maxZ: z1 });
    groups.push(g);
    pos += len;
  }
  return groups.length ? groups : null;
}

/** The triangles' edges, each once, as a line list: WebGL has no wireframe mode for triangles. */
export function edgesOf(indices) {
  const seen = new Set(), out = [];
  const add = (a, b) => {
    const lo = Math.min(a, b), hi = Math.max(a, b), key = lo * 4294967296 + hi;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(lo, hi);
  };
  for (let t = 0; t + 2 < indices.length; t += 3) {
    add(indices[t], indices[t + 1]);
    add(indices[t + 1], indices[t + 2]);
    add(indices[t + 2], indices[t]);
  }
  return Uint32Array.from(out);
}

/**
 * Every collision layer of a parsed stage bundle (CollectCollisionMeshes): {layers: [{name, positions, indices, edges,
 * triangles, groups}], unread: names that aren't in the bundle itself or don't read as collision, live}. live is true
 * when every layer reads exactly as groups (InitLiveCollision): then each layer's positions and indices are its groups'
 * vertices and triangles, group after group, and its collision can follow the objects. Otherwise it is view-only.
 */
export async function readCollision(arc) {
  const layers = [], unread = [];
  for (const e of arc.entries) {
    if (!/\.ccp$/i.test(e.name || '')) continue;
    try {
      const d = e.pointer || !e.data?.length ? null : (await decodeLayers(e.data)).payload;
      const m = d ? parseCcp(d) : null;
      if (!m) {
        unread.push(e.name);
        continue;
      }
      let groups = null;
      try {
        groups = parseCollisionGroups(d);
      } catch {
        groups = null;
      }
      layers.push({ name: e.name, positions: m.positions, indices: m.indices, groups });
    } catch {
      unread.push(e.name);
    }
  }
  const live = layers.length > 0 && !unread.length && layers.every((l) => l.groups);
  for (const l of layers) {
    if (live) {
      let vc = 0, ic = 0;
      for (const g of l.groups) {
        vc += g.vertices.length;
        ic += g.triangles.length;
      }
      l.positions = new Float32Array(vc);
      l.indices = new Uint32Array(ic);
      let vbase = 0, at = 0;
      for (const g of l.groups) {
        l.positions.set(g.vertices, vbase * 3);
        for (const v of g.triangles) l.indices[at++] = vbase + v;
        vbase += g.vertices.length / 3;
      }
    } else l.groups = null;
    l.edges = edgesOf(l.indices);
    l.triangles = l.indices.length / 3;
  }
  return { layers, unread, live };
}
