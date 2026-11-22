// Gimmick paths: the routes in a stage bundle's .gpt files that moving gimmicks follow (Rainbow's rafts,
// gligA_raftpath.gpt; the circuit paths of sdarB, …). Port of the desktop's StageViewerForm.GimmickPaths.cs.
//
// Format (little-endian, checked on sligA and sdarB by the desktop): u32 path count, then per path a 52-byte header —
// name (20 bytes, NUL-padded), 12 runtime bytes, u32 point count, u32 0, u32 offset of its points, f32 100, f32 (per
// path) — then the points, float3 in cm, each path's block ending where the next one's begins.
//
// A raft path's ends follow their harbours: moving a RaftHarbor gimmick moves the end of the path that starts or stops at
// it, blended along the path (the far end stays). Only X / Z move: the raft floats at the path's own height. The maths is
// rounded to float32 at every step, as the desktop's Vector3 does it.

const HEADER = 52;
/** A path end this close (X / Z, cm) to a harbour's stage position belongs to that harbour (PathHarbourReach). */
export const HARBOUR_REACH = 1500;
const f = Math.fround;

/** The paths of one .gpt ({file, name, offset, points: [[x, y, z]…]}), or null when it isn't laid out as expected. */
export function parseGpt(file, d) {
  if (!d || d.length < 4) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const n = v.getInt32(0, true);
  if (n <= 0 || n > 256 || 4 + n * HEADER > d.length) return null;
  const paths = [];
  let expect = 4 + n * HEADER;
  for (let i = 0; i < n; i++) {
    const h = 4 + i * HEADER;
    const count = v.getInt32(h + 32, true), offset = v.getInt32(h + 40, true);
    if (offset !== expect || count < 0 || offset + count * 12 > d.length) return null; // each path's points follow the previous one's
    let len = d.subarray(h, h + 20).indexOf(0);
    if (len < 0) len = 20;
    // Encoding.ASCII: bytes above 0x7F read as '?'.
    const name = Array.from(d.subarray(h, h + len), (c) => (c > 0x7f ? '?' : String.fromCharCode(c))).join('');
    const points = [];
    for (let k = 0; k < count; k++) {
      const at = offset + k * 12;
      points.push([v.getFloat32(at, true), v.getFloat32(at + 4, true), v.getFloat32(at + 8, true)]);
    }
    paths.push({ file, name, offset, points });
    expect = offset + count * 12;
  }
  return expect === d.length ? paths : null;
}

/** A copy of original with the given paths' points written over theirs ([[path, points]…]); nothing else changes. */
export function writeGpt(original, moved) {
  const o = original.slice();
  const v = new DataView(o.buffer, o.byteOffset, o.byteLength);
  for (const [p, pts] of moved) {
    if (pts.length !== p.points.length) throw new Error(`${p.name}: a path can't change its number of points.`);
    for (let k = 0; k < pts.length; k++) {
      const at = p.offset + k * 12;
      v.setFloat32(at, pts[k][0], true);
      v.setFloat32(at + 4, pts[k][1], true);
      v.setFloat32(at + 8, pts[k][2], true);
    }
  }
  return o;
}

const length3 = (x, y, z) => f(Math.sqrt(f(f(f(x * x) + f(y * y)) + f(z * z))));

/**
 * How far the harbour an end sits at has moved (X / Z), or null for none. harbours: the stage's own RaftHarbor
 * placements (not new, this season) as {position0, position, removed}; the nearest within the reach owns the end.
 */
export function harbourShift(end, harbours) {
  let best = null, bestD = HARBOUR_REACH;
  for (const g of harbours) {
    const dx = f(g.position0[0] - end[0]), dz = f(g.position0[2] - end[2]);
    const d = f(Math.sqrt(f(f(dx * dx) + f(dz * dz))));
    if (d < bestD) [best, bestD] = [g, d];
  }
  return !best || best.removed ? null : [f(best.position[0] - best.position0[0]), 0, f(best.position[2] - best.position0[2])];
}

/**
 * Where a path's points go now: each end moved with its harbour, the points between blended by how far along the path
 * they are (FollowedPath). Null when nothing moved.
 */
export function followedPath(p, harbours) {
  const pts = p.points, n = pts.length;
  if (n < 2) return null;
  const a = harbourShift(pts[0], harbours) ?? [0, 0, 0], b = harbourShift(pts[n - 1], harbours) ?? [0, 0, 0];
  const sq = (s) => f(f(f(s[0] * s[0]) + f(s[1] * s[1])) + f(s[2] * s[2]));
  if (sq(a) < f(0.01) && sq(b) < f(0.01)) return null;
  const along = new Array(n).fill(0);
  for (let k = 1; k < n; k++)
    along[k] = f(along[k - 1] + length3(f(pts[k][0] - pts[k - 1][0]), f(pts[k][1] - pts[k - 1][1]), f(pts[k][2] - pts[k - 1][2])));
  const total = Math.max(f(1e-3), along[n - 1]);
  return pts.map((q, k) => {
    const t = f(along[k] / total), u = f(1 - t);
    return [0, 1, 2].map((c) => f(f(q[c] + f(a[c] * u)) + f(b[c] * t)));
  });
}

/** Every path moved by its harbours now: [[path, points]…]. */
export const movedPaths = (paths, harbours) =>
  paths.map((p) => [p, followedPath(p, harbours)]).filter((x) => x[1]);
