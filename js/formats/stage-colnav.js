// The Collision & nav editor's saved state and shapes, ported from HappyTool/GUI/StageViewerForm.ColNav.cs: collision
// erased by hand (RemovedCollision: layer name -> triangle numbers in file order) and collision added as pieces
// (Volumes: walls, blocks, floors and ramps standing on a point, turned about the vertical). The state is the edits
// file's "colnav" feature, in the desktop's shape; the nav parts (cells, waypoints) are kept as read until the web
// edits them.

export const COLNAV_KEY = 'colnav';
export const CN_SHAPES = ['Wall', 'Block', 'Floor', 'Ramp'];
/** Each shape's first size: width (across), height, depth (along; a ramp rises this way). */
export const CN_SIZES = { Wall: [600, 400, 60], Block: [300, 300, 300], Floor: [600, 30, 600], Ramp: [300, 200, 600] };
export const CN_MIN_BRUSH = 50;
export const CN_MAX_BRUSH = 3000;

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (x, d) => (Number.isFinite(+x) ? +x : d);

/** A full ColNavEdit from a stored feature (or nothing), unknown parts kept as they are. */
export function readColNav(f) {
  const c = isObj(f) ? { ...f } : {};
  const removed = {};
  if (isObj(c.RemovedCollision))
    for (const [k, v] of Object.entries(c.RemovedCollision))
      if (Array.isArray(v)) {
        const list = [...new Set(v.filter((t) => Number.isInteger(t) && t >= 0))].sort((a, b) => a - b);
        if (list.length) removed[k] = list;
      }
  c.RemovedCollision = removed;
  c.Volumes = Array.isArray(c.Volumes) ? c.Volumes.filter(isObj).map(readVolume) : [];
  for (const k of ['NavCells', 'NavErase', 'Waypoints', 'RemovedWaypoints', 'Links', 'Cuts']) if (!Array.isArray(c[k])) c[k] = [];
  c.NextWaypointId = num(c.NextWaypointId, 0);
  c.AutoCollision = c.AutoCollision !== false;
  c.AutoNav = c.AutoNav !== false;
  return c;
}

function readVolume(v) {
  const shape = CN_SHAPES.includes(v.Shape) ? v.Shape : 'Wall';
  const [w, h, d] = CN_SIZES[shape];
  return { Shape: shape, X: num(v.X, 0), Y: num(v.Y, 0), Z: num(v.Z, 0), W: num(v.W, w), H: num(v.H, h), D: num(v.D, d), Yaw: num(v.Yaw, 0) };
}

export const cloneColNav = (c) => readColNav(JSON.parse(JSON.stringify(c)));

/** Something on the map changed (IsDefault leaves out the settings). */
export const colNavHasMapEdits = (c) =>
  !!c &&
  (Object.keys(c.RemovedCollision).length > 0 ||
    ['Volumes', 'NavCells', 'NavErase', 'Waypoints', 'RemovedWaypoints', 'Links', 'Cuts'].some((k) => c[k].length > 0));

/** The feature as saved, or null when it is all defaults (the desktop then leaves it out). */
export const colNavFeature = (c) => (c && (colNavHasMapEdits(c) || !c.AutoCollision || !c.AutoNav) ? c : null);

/** Triangles erased by hand in a layer, as one flag per triangle (null when none). */
export function removedFlags(c, layerName, triCount) {
  const key = Object.keys(c.RemovedCollision).find((k) => k.toLowerCase() === layerName.toLowerCase());
  const list = key ? c.RemovedCollision[key] : null;
  if (!list?.length) return null;
  const f = new Uint8Array(triCount);
  let any = false;
  for (const t of list)
    if (t < triCount) {
      f[t] = 1;
      any = true;
    }
  return any ? f : null;
}

/** A layer's flags back into the saved lists (after a brush stroke). */
export function setRemovedFlags(c, layerName, flags) {
  for (const k of Object.keys(c.RemovedCollision)) if (k.toLowerCase() === layerName.toLowerCase()) delete c.RemovedCollision[k];
  if (!flags) return;
  const list = [];
  for (let t = 0; t < flags.length; t++) if (flags[t]) list.push(t);
  if (list.length) c.RemovedCollision[layerName] = list;
}

/**
 * A piece's triangles in world space (9 floats each), wound outward like the stage's collision (VolumeTriangles): a box,
 * or a ramp rising along its depth to its full height at the far end, standing on (X, Y, Z) and turned by Yaw.
 */
export function volumeTriangles(v) {
  const hw = Math.max(1, v.W) * 0.5, h = Math.max(1, v.H), hd = Math.max(1, v.D) * 0.5;
  let corners, faces;
  if (v.Shape === 'Ramp') {
    // 0-3 bottom, 4-5 the top edge at the far end.
    corners = [[-hw, 0, -hd], [hw, 0, -hd], [-hw, 0, hd], [hw, 0, hd], [-hw, h, hd], [hw, h, hd]];
    faces = [[0, 1, 3, 2], [2, 3, 5, 4], [0, 1, 5, 4], [0, 2, 4], [1, 3, 5]];
  } else {
    corners = [];
    for (let k = 0; k < 8; k++) corners.push([k & 1 ? hw : -hw, k & 2 ? h : 0, k & 4 ? hd : -hd]);
    faces = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5], [2, 3, 7, 6], [0, 1, 5, 4]];
  }
  const yaw = (v.Yaw * Math.PI) / 180, cs = Math.fround(Math.cos(yaw)), sn = Math.fround(Math.sin(yaw));
  const world = corners.map((p) => [v.X + p[0] * cs + p[2] * sn, v.Y + p[1], v.Z - p[0] * sn + p[2] * cs].map(Math.fround));
  const centre = [0, 0, 0];
  for (const p of world) for (let k = 0; k < 3; k++) centre[k] += p[k] / world.length;
  const out = [];
  for (const face of faces)
    for (let k = 1; k + 1 < face.length; k++) {
      const a = world[face[0]];
      let b = world[face[k]], c = world[face[k + 1]];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      let dot = 0;
      for (let i = 0; i < 3; i++) dot += n[i] * ((a[i] + b[i] + c[i]) / 3 - centre[i]);
      if (dot < 0) [b, c] = [c, b];
      out.push(...a, ...b, ...c);
    }
  return new Float32Array(out);
}

/** Möller–Trumbore: the distance along the ray to the triangle, or -1. */
export function rayTriangle(o, d, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-9) return -1;
  const inv = 1 / det, tx = o[0] - ax, ty = o[1] - ay, tz = o[2] - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 1e-4 ? t : -1;
}

/** Nearest hit of a ray on a layer's triangles (positions + indices), skipping those skip(t) rejects; maxT when none. */
export function rayLayer(o, d, P, I, maxT, skip = null) {
  let best = maxT;
  for (let t = 0, n = I.length / 3; t < n; t++) {
    if (skip && skip(t)) continue;
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const h = rayTriangle(o, d, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]);
    if (h >= 0 && h < best) best = h;
  }
  return best;
}

/** Nearest hit of a ray on triangles given as 9 floats each; maxT when none. */
export function rayTris(o, d, f, maxT) {
  let best = maxT;
  for (let i = 0; i + 8 < f.length; i += 9) {
    const h = rayTriangle(o, d, f[i], f[i + 1], f[i + 2], f[i + 3], f[i + 4], f[i + 5], f[i + 6], f[i + 7], f[i + 8]);
    if (h >= 0 && h < best) best = h;
  }
  return best;
}

/**
 * Erases (or brings back) every triangle of a layer whose centre is within radius of at (EraseCollisionAt), skipping
 * those skip(t) rejects (carried off with a moved object). flags: the layer's per-triangle flags, made when null.
 * Returns {flags, n} with n the triangles changed.
 */
export function eraseAt(P, I, flags, at, radius, erase, skip = null) {
  const r2 = radius * radius, n = I.length / 3;
  let changed = 0;
  for (let t = 0; t < n; t++) {
    if (!!(flags && flags[t]) === erase) continue;
    if (skip && skip(t)) continue;
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const x = (P[a] + P[b] + P[c]) / 3 - at[0], y = (P[a + 1] + P[b + 1] + P[c + 1]) / 3 - at[1], z = (P[a + 2] + P[b + 2] + P[c + 2]) / 3 - at[2];
    if (x * x + y * y + z * z > r2) continue;
    flags ??= new Uint8Array(n);
    flags[t] = erase ? 1 : 0;
    changed++;
  }
  return { flags, n: changed };
}
