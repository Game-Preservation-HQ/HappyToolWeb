// Placement editing for the map view (map editor slice 2): the movable objects of a stage, their placements, undo,
// the gizmo maths and the edits file. Port of HappyTool/GUI/StageViewerForm.Objects.cs, .Placement.cs, .Gizmo.cs and
// StagePlacementEdits.cs. The stage files are never changed: an edit rewrites the object's baked vertices in memory,
// and the edits are kept in the browser and saved as the desktop's sidecar JSON (version 2, or 4 with Solid).

export const MIN_SCALE = 0.001;
export const MAX_SCALE = 1000;
export const IDENTITY = Object.freeze({ t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1], hidden: false, solid: false });
const DEG = Math.PI / 180;
const STORE = 'happytool-web-edits:';

const near0 = (v) => v.every((x) => Math.abs(x) < 1e-6);
const near1 = (v) => v.every((x) => Math.abs(x - 1) < 1e-6);
export const isIdentityTransform = (st) => near0(st.t) && near0(st.r) && near1(st.s);
export const isEmpty = (st) => !st.hidden && !st.solid && isIdentityTransform(st);
export const sameState = (a, b) =>
  a.hidden === b.hidden && a.solid === b.solid && ['t', 'r', 's'].every((k) => a[k].every((x, i) => x === b[k][i]));

/** Scale components keep at least MIN_SCALE magnitude (and at most MAX_SCALE) so the placement stays invertible. */
const clampScale = (s) => s.map((x) => (x < 0 ? -1 : 1) * Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.abs(x) || MIN_SCALE)));
export const withState = (st, patch) => ({ ...st, ...patch, s: clampScale(patch.s ?? st.s) });

/** Wraps to (-180, 180] so repeated nudges keep tidy values. */
export function wrapDegrees(d) {
  d %= 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return Math.abs(d) < 1e-9 ? 0 : d;
}

/** A tidy step near v: 1, 2 or 5 times a power of ten (NiceStep). */
export function niceStep(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

// ---------- placement maths ----------
// A baked vertex v is placed at  pivot + t + Rz·Ry·Rx·S·(v − pivot)  (right-handed, degrees about world X, then Y,
// then Z), as ObjectState.ToMatrix on the desktop. Matrices here are row-major 3x3 acting on column vectors.

function rotX(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
function rotY(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
function rotZ(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}
function m3mul(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}
const m3apply = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const m3transpose = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
export const rotation = (deg) => m3mul(rotZ(deg[2] * DEG), m3mul(rotY(deg[1] * DEG), rotX(deg[0] * DEG)));

/** Where a baked point lands under a placement. */
export function placePoint(st, pivot, v) {
  const p = m3apply(rotation(st.r), [(v[0] - pivot[0]) * st.s[0], (v[1] - pivot[1]) * st.s[1], (v[2] - pivot[2]) * st.s[2]]);
  return [p[0] + pivot[0] + st.t[0], p[1] + pivot[1] + st.t[1], p[2] + pivot[2] + st.t[2]];
}

/** The baked point that a placement puts at world point w. */
export function unplacePoint(st, pivot, w) {
  const q = m3apply(m3transpose(rotation(st.r)), [w[0] - pivot[0] - st.t[0], w[1] - pivot[1] - st.t[1], w[2] - pivot[2] - st.t[2]]);
  return [q[0] / st.s[0] + pivot[0], q[1] / st.s[1] + pivot[1], q[2] / st.s[2] + pivot[2]];
}

/** Turns p about the line through origin along world axis (0 X, 1 Y, 2 Z) by deg. */
export function turnAbout(p, origin, axis, deg) {
  const R = axis === 0 ? rotX(deg * DEG) : axis === 1 ? rotY(deg * DEG) : rotZ(deg * DEG);
  const q = m3apply(R, [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]]);
  return [q[0] + origin[0], q[1] + origin[1], q[2] + origin[2]];
}

export function boundsOf(pos, firstVertex, count) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let v = firstVertex; v < firstVertex + count; v++)
    for (let k = 0; k < 3; k++) {
      const x = pos[v * 3 + k];
      if (x < min[k]) min[k] = x;
      if (x > max[k]) max[k] = x;
    }
  return { min, max };
}

// ---------- objects ----------

/**
 * The movable objects of the scene (CollectObjects): each record of an object pack, and every other non-sky mesh
 * whole. Each object: {index, mesh, name, label, recordOffset, firstVertex, vertexCount, firstIndex, indexCount,
 * pivot, state}. The mesh gets editObjects (sorted by firstIndex) for picking.
 */
export function collectObjects(meshes) {
  const out = [];
  for (const m of meshes) {
    if (m.sky) continue;
    const vc = m.positions.length / 3;
    const ranges = m.objects?.length ? m.objects : [{ name: m.name, firstVertex: 0, vertexCount: vc, firstIndex: 0, indexCount: m.indices.length }];
    m.editObjects = [];
    for (const r of ranges) {
      if (!r.vertexCount || !r.indexCount || r.firstVertex + r.vertexCount > vc) continue;
      const b = boundsOf(m.positions, r.firstVertex, r.vertexCount);
      const o = {
        index: out.length,
        mesh: m,
        name: r.name,
        label: r.label || null,
        recordOffset: r.recordOffset ?? null,
        firstVertex: r.firstVertex,
        vertexCount: r.vertexCount,
        firstIndex: r.firstIndex,
        indexCount: r.indexCount,
        pivot: b.min.map((x, k) => (x + b.max[k]) / 2),
        bounds: b,
        state: IDENTITY,
      };
      out.push(o);
      m.editObjects.push(o);
    }
    m.editObjects.sort((a, b) => a.firstIndex - b.firstIndex);
  }
  return out;
}

/** "sligAstageobj.rrm/obj_12" → "sligAstageobj obj_12"; other names keep their last two path parts. */
export function shortObjectName(name) {
  const parts = name.replace(/\\/g, '/').split('/');
  const tail = parts.slice(-2).join('/');
  return tail.replace(/\.rrm\//i, ' ').replace(/\.rrm$/i, '');
}

/**
 * Rewrites an object's vertices in its mesh from the baked copy, placed by its state (UpdateObjectVertices). A hidden
 * object collapses to its pivot, so its triangles draw and pick nothing. Updates the object's and the mesh's bounds.
 */
export function writeObject(o) {
  const m = o.mesh;
  if (!m.baked) m.baked = { positions: m.positions.slice(), normals: m.normals.slice() };
  const P = m.baked.positions, N = m.baked.normals, pos = m.positions, nrm = m.normals;
  const st = o.state, pv = o.pivot, t = st.t, s = st.s;
  const R = rotation(st.r);
  const end = (o.firstVertex + o.vertexCount) * 3;
  if (st.hidden) {
    for (let i = o.firstVertex * 3; i < end; i += 3) {
      pos[i] = pv[0];
      pos[i + 1] = pv[1];
      pos[i + 2] = pv[2];
      nrm[i] = N[i];
      nrm[i + 1] = N[i + 1];
      nrm[i + 2] = N[i + 2];
    }
    o.bounds = null;
    return;
  }
  for (let i = o.firstVertex * 3; i < end; i += 3) {
    const x = (P[i] - pv[0]) * s[0], y = (P[i + 1] - pv[1]) * s[1], z = (P[i + 2] - pv[2]) * s[2];
    pos[i] = R[0] * x + R[1] * y + R[2] * z + pv[0] + t[0];
    pos[i + 1] = R[3] * x + R[4] * y + R[5] * z + pv[1] + t[1];
    pos[i + 2] = R[6] * x + R[7] * y + R[8] * z + pv[2] + t[2];
    // Normals use the inverse transpose of R·S, which is R·S⁻¹.
    const nx = N[i] / s[0], ny = N[i + 1] / s[1], nz = N[i + 2] / s[2];
    const ax = R[0] * nx + R[1] * ny + R[2] * nz, ay = R[3] * nx + R[4] * ny + R[5] * nz, az = R[6] * nx + R[7] * ny + R[8] * nz;
    const l = Math.hypot(ax, ay, az) || 1;
    nrm[i] = ax / l;
    nrm[i + 1] = ay / l;
    nrm[i + 2] = az / l;
  }
  o.bounds = boundsOf(pos, o.firstVertex, o.vertexCount);
  for (let k = 0; k < 3; k++) {
    m.bounds.min[k] = Math.min(m.bounds.min[k], o.bounds.min[k]);
    m.bounds.max[k] = Math.max(m.bounds.max[k], o.bounds.max[k]);
  }
}

// ---------- undo ----------

/**
 * Undo history: each step is placement changes [{obj, before, after}] and/or an action {undo(), redo()} for edits that
 * aren't an object's state (the sky); steps with the same merge key coalesce.
 */
export class History {
  constructor() {
    this.undo = [];
    this.redo = [];
  }
  push(changes, label, mergeKey = null, action = null) {
    changes = changes.filter((c) => !sameState(c.before, c.after));
    if (!changes.length && !action) return;
    if (action) {
      // A step that only runs an action merges into the previous one of the same kind when that action can take it
      // (merge returns true; drop() true when the two cancel out).
      const top = this.undo.at(-1);
      if (mergeKey && top?.mergeKey === mergeKey && !changes.length && !top.changes.length && top.action?.merge?.(action)) {
        if (top.action.drop?.()) this.undo.pop();
      } else this.undo.push({ changes, label, mergeKey, action });
      this.redo.length = 0;
      return;
    }
    const top = this.undo.at(-1);
    if (mergeKey && top?.mergeKey === mergeKey && top.changes.length === changes.length && top.changes.every((c, k) => c.obj === changes[k].obj)) {
      changes.forEach((c, k) => (top.changes[k].after = c.after));
      if (top.changes.every((c) => sameState(c.before, c.after))) this.undo.pop();
    } else this.undo.push({ changes, label, mergeKey });
    this.redo.length = 0;
  }
  /** The next change starts a new step even when its merge key matches (a released key, a new selection). */
  breakMerge() {
    const top = this.undo.at(-1);
    if (top) top.mergeKey = null;
  }
}

// ---------- edits file (StagePlacementEdits) ----------

export const stageKey = (name) => name.replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '');

/**
 * The edits in the desktop sidecar's shape: {Version, Stage, Objects: {index: {Name, Translate, Rotate?, Scale?, Pivot?,
 * Deleted, Solid?}}, Sky?}; a sky makes it version 5, as the desktop writes it.
 */
export function editsFile(stage, objects, sky = null, features = null) {
  const Objects = {};
  let solid = false;
  for (const o of objects) {
    const st = o.state;
    if (isEmpty(st)) continue;
    const e = { Name: o.name, Translate: st.t.slice() };
    if (!near0(st.r)) e.Rotate = st.r.slice();
    if (!near1(st.s)) e.Scale = st.s.slice();
    if (e.Rotate || e.Scale) e.Pivot = o.pivot.slice();
    e.Deleted = st.hidden;
    if (st.solid) e.Solid = solid = true;
    Objects[o.index] = e;
  }
  const hasFeatures = !!features && Object.keys(features).length > 0;
  const file = { Version: hasFeatures ? 6 : sky ? 5 : solid ? 4 : 2, Stage: stage, Objects };
  if (sky) file.Sky = sky;
  if (hasFeatures) file.Features = features;
  return file;
}

const vec = (v, fallback) => (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? v.map(Number) : fallback.slice());

/**
 * Reads a sidecar's entries onto the objects, matched by name (case-insensitive) as the desktop does; returns the
 * objects whose state changed and the names that matched nothing. Objects not in the file are left as they are.
 */
export function readEditsFile(json, objects) {
  const isObj = (v) => !!v && typeof v === 'object';
  if (!isObj(json) || (!isObj(json.Objects) && !isObj(json.Sky) && !isObj(json.Features)))
    throw new Error('This is not a HappyTool stage edits file.');
  const byName = new Map(objects.map((o) => [o.name.toLowerCase(), o]));
  const changed = [], unmatched = [];
  for (const e of Object.values(json.Objects || {})) {
    const o = e && typeof e.Name === 'string' ? byName.get(e.Name.toLowerCase()) : null;
    if (!o) {
      if (e?.Name) unmatched.push(e.Name);
      continue;
    }
    const st = withState(IDENTITY, { t: vec(e.Translate, [0, 0, 0]), r: vec(e.Rotate, [0, 0, 0]), s: vec(e.Scale, [1, 1, 1]), hidden: !!e.Deleted, solid: !!e.Solid });
    const pivot = Array.isArray(e.Pivot) ? vec(e.Pivot, o.pivot) : o.pivot;
    if (sameState(st, o.state) && pivot.every((x, k) => x === o.pivot[k])) continue;
    changed.push({ obj: o, before: o.state, after: st, pivot });
  }
  return { changed, unmatched, sky: isObj(json.Sky) ? json.Sky : null, features: isObj(json.Features) ? json.Features : {} };
}

export function loadStored(stage) {
  try {
    const raw = localStorage.getItem(STORE + stage.toLowerCase());
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function store(stage, objects, sky = null, features = null) {
  const file = editsFile(stage, objects, sky, features);
  const key = STORE + stage.toLowerCase();
  try {
    if (Object.keys(file.Objects).length || file.Sky || file.Features) localStorage.setItem(key, JSON.stringify(file));
    else localStorage.removeItem(key);
  } catch (e) {
    console.warn(`Map editor: edits could not be kept in this browser: ${e.message}`);
  }
}

// ---------- gizmo maths ----------

export const AXES = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
export const UNIFORM = 3;

/** Two unit vectors spanning the plane of axis a's rotate ring. */
export const ringBasis = (a) => (a === 0 ? [AXES[1], AXES[2]] : a === 1 ? [AXES[2], AXES[0]] : [AXES[0], AXES[1]]);

export const ringPoint = (origin, a, len, angle) => {
  const [u, v] = ringBasis(a);
  return origin.map((x, k) => x + (u[k] * Math.cos(angle) + v[k] * Math.sin(angle)) * len);
};

export function distanceToSegment(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y, len2 = vx * vx + vy * vy;
  let t = len2 > 1e-6 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a.x + vx * t - p.x, a.y + vy * t - p.y);
}

/** Parameter s of the point origin + s·axis closest to the ray ro + t·rd; null when the axis runs along the ray. */
export function closestParamOnAxis(origin, axis, ro, rd) {
  const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const w0 = [origin[0] - ro[0], origin[1] - ro[1], origin[2] - ro[2]];
  const a = dot(axis, axis), b = dot(axis, rd), c = dot(rd, rd), d = dot(axis, w0), e = dot(rd, w0);
  const denom = a * c - b * b;
  if (denom < 1e-4 * a * c) return null;
  const s = (b * e - c * d) / denom;
  return Number.isFinite(s) ? s : null;
}

export const screenAngle = (c, p) => Math.atan2(p.y - c.y, p.x - c.x);

/** +1 when going from a to b turns anticlockwise on screen (increasing angle) around c. */
export function screenTurnSign(c, a, b) {
  let d = screenAngle(c, b) - screenAngle(c, a);
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d >= 0 ? 1 : -1;
}
