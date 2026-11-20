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
 * Every collision layer of a parsed stage bundle (CollectCollisionMeshes): {layers: [{name, positions, edges,
 * triangles}], unread: names that aren't in the bundle itself or don't read as collision}.
 */
export async function readCollision(arc) {
  const layers = [], unread = [];
  for (const e of arc.entries) {
    if (!/\.ccp$/i.test(e.name || '')) continue;
    try {
      const m = e.pointer || !e.data?.length ? null : parseCcp((await decodeLayers(e.data)).payload);
      if (m) layers.push({ name: e.name, positions: m.positions, edges: edgesOf(m.indices), triangles: m.indices.length / 3 });
      else unread.push(e.name);
    } catch {
      unread.push(e.name);
    }
  }
  return { layers, unread };
}
