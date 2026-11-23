// Play test: using gimmicks (a gate opens, a bridge breaks, a bomb stone fires), ported from
// HappyTool/GUI/StageViewerForm.GimmickPlay.cs. A gimmick's .rrm nodes and .rra clips come with its model
// (stage-gimmicks.js buildModel: mesh.rig, mesh.vertexNode). Using one plays its clip on the drawn mesh only, so the
// map's placements stay as they are; an open gate's collision is left out of the play world (PlayWorld.off) until it
// shuts, and stopping play puts every gimmick back.

import { sampleTrack } from '../formats/rra.js';
import { trs, mul4 } from '../formats/skin.js';
import { PLAY } from './stage-play.js';
import { gimmickFrame } from './stage-zones.js';
import { rotation, boundsOf } from './stage-edit.js';

export const GIMMICK_CLIP_FPS = 30;
export const GATE_OPEN_SECONDS = 6;
export const GIMMICK_USE_REACH = 400;

export const isGateType = (type) => typeof type === 'string' && type.startsWith('CastleGate');

/** Clip names using a gimmick prefers, in order (a gate opens, a bridge breaks, a bomb stone fires). */
const USE_CLIP_WORDS = ['open', 'break', 'shot', 'appear'];

/** The clip using a gimmick plays: the first named like an action in USE_CLIP_WORDS, else the first. UseClip. */
export function useClip(rig) {
  for (const w of USE_CLIP_WORDS) for (const [name, clip] of rig.clips) if (name.toLowerCase().includes(w)) return clip;
  return rig.clips.values().next().value ?? null;
}

/** Whether point p (in the gimmick's frame) is inside a trigger zone. InTrapZone. */
export function inTrapZone(z, p) {
  if (z.shape === 'Box') {
    return Math.abs(p[0] - z.a[0]) <= z.b[0] && Math.abs(p[1] - z.a[1]) <= z.b[1] && Math.abs(p[2] - z.a[2]) <= z.b[2];
  }
  if (z.shape === 'Cylinder' || z.shape === 'Capsule') {
    const ax = [z.b[0] - z.a[0], z.b[1] - z.a[1], z.b[2] - z.a[2]], d = [p[0] - z.a[0], p[1] - z.a[1], p[2] - z.a[2]];
    const len2 = ax[0] * ax[0] + ax[1] * ax[1] + ax[2] * ax[2];
    const t = len2 > 1e-6 ? (d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2]) / len2 : 0;
    if (z.shape === 'Cylinder' && (t < 0 || t > 1)) return false;
    const c = Math.max(0, Math.min(1, t));
    return Math.hypot(d[0] - ax[0] * c, d[1] - ax[1] * c, d[2] - ax[2] * c) <= z.radius;
  }
  return Math.hypot(p[0] - z.a[0], p[1] - z.a[1], p[2] - z.a[2]) <= z.radius;
}

/** A world point in a frame ({M, T}, M a turn): Mᵀ(p − T). */
function toLocal(f, p) {
  const M = f.M, d = [p[0] - f.T[0], p[1] - f.T[1], p[2] - f.T[2]];
  return [0, 1, 2].map((c) => M[c] * d[0] + M[3 + c] * d[1] + M[6 + c] * d[2]);
}

/** A node pose as a column-major matrix: scale, then turn, then move (the desktop's S·R·T for row vectors). */
function poseMatrix(p, q, s) {
  const l2 = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
  const l = l2 > 1e-8 ? Math.sqrt(l2) : 0;
  const m = l ? trs(p[0], p[1], p[2], q[0] / l, q[1] / l, q[2] / l, q[3] / l) : trs(p[0], p[1], p[2], 0, 0, 0, 1);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] *= s[c];
  return m;
}

/** The inverse of an affine column-major matrix, or null when it has none. */
function invertAffine(m) {
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], k = m[10];
  const A = e * k - f * h, B = f * g - d * k, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-30)) return null;
  const i = 1 / det;
  // Rows of the inverse 3x3.
  const r0 = [A * i, (c * h - b * k) * i, (b * f - c * e) * i];
  const r1 = [B * i, (a * k - c * g) * i, (c * d - a * f) * i];
  const r2 = [C * i, (b * g - a * h) * i, (a * e - b * d) * i];
  const t = [m[12], m[13], m[14]];
  const tx = -(r0[0] * t[0] + r0[1] * t[1] + r0[2] * t[2]);
  const ty = -(r1[0] * t[0] + r1[1] * t[1] + r1[2] * t[2]);
  const tz = -(r2[0] * t[0] + r2[1] * t[1] + r2[2] * t[2]);
  return Float32Array.of(r0[0], r1[0], r2[0], 0, r0[1], r1[1], r2[1], 0, r0[2], r1[2], r2[2], 0, tx, ty, tz, 1);
}

/**
 * The clip's transform of a node at a frame, as a change from the node's rest pose (model space), column-major; null
 * for no change (the clip doesn't move that node). NodeDelta.
 */
export function nodeDelta(clip, node, frame) {
  let bone = clip.bones.findIndex((b) => b.name === node.name);
  if (bone < 0 && clip.bones.length === 1) bone = 0;
  if (bone < 0) return null;
  const tr = clip.bones[bone].tracks;
  const p = sampleTrack(tr[0], frame, 0) ?? node.pos, q = sampleTrack(tr[1], frame, 1) ?? node.rot;
  const s = sampleTrack(tr[2], frame, 2) ?? node.scale;
  const rest = invertAffine(poseMatrix(node.pos, node.rot, node.scale));
  return rest ? mul4(poseMatrix(p, q, s), rest) : null;
}

/**
 * A node change ready for writePosed: the matrix, its normal matrix (the 3x3's cofactors, signed by the determinant:
 * the inverse transpose up to a scale) and whether it flattens the piece (no inverse: drawn collapsed, as the desktop does).
 */
function prepared(m) {
  if (!m) return null;
  const A = (r, c) => m[c * 4 + r];
  const n = new Float64Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      n[r * 3 + c] = A((r + 1) % 3, (c + 1) % 3) * A((r + 2) % 3, (c + 2) % 3) - A((r + 1) % 3, (c + 2) % 3) * A((r + 2) % 3, (c + 1) % 3);
  const det = A(0, 0) * n[0] + A(0, 1) * n[1] + A(0, 2) * n[2];
  if (!(Math.abs(det) > 1e-30)) return { m, n, collapse: true };
  if (det < 0) for (let k = 0; k < 9; k++) n[k] = -n[k];
  return { m, n, collapse: false };
}

/**
 * Rewrites a gimmick object's vertices posed (writeObject with each vertex's node change first, in model space:
 * UpdateObjectVertices with a pose). deltaOf(node) gives a prepared change or null. after(o) as for writeObject.
 */
export function writePosed(o, deltaOf, after = null) {
  const m = o.mesh;
  if (!m.baked) m.baked = { positions: m.positions.slice(), normals: m.normals.slice() };
  const P = m.baked.positions, N = m.baked.normals, pos = m.positions, nrm = m.normals, nodes = m.vertexNode;
  const st = o.state, pv = o.pivot, t = st.t, s = st.s, R = rotation(st.r);
  const end = o.firstVertex + o.vertexCount;
  for (let v = o.firstVertex; v < end; v++) {
    const i = v * 3, d = deltaOf(nodes ? nodes[v] : 0);
    let x = P[i] - pv[0], y = P[i + 1] - pv[1], z = P[i + 2] - pv[2], nx = N[i], ny = N[i + 1], nz = N[i + 2];
    if (d?.collapse) {
      pos[i] = pv[0];
      pos[i + 1] = pv[1];
      pos[i + 2] = pv[2];
      nrm[i] = nx;
      nrm[i + 1] = ny;
      nrm[i + 2] = nz;
      continue;
    }
    if (d) {
      const M = d.m, n = d.n;
      [x, y, z] = [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]];
      [nx, ny, nz] = [n[0] * nx + n[1] * ny + n[2] * nz, n[3] * nx + n[4] * ny + n[5] * nz, n[6] * nx + n[7] * ny + n[8] * nz];
    }
    x *= s[0];
    y *= s[1];
    z *= s[2];
    pos[i] = R[0] * x + R[1] * y + R[2] * z + pv[0] + t[0];
    pos[i + 1] = R[3] * x + R[4] * y + R[5] * z + pv[1] + t[1];
    pos[i + 2] = R[6] * x + R[7] * y + R[8] * z + pv[2] + t[2];
    nx /= s[0];
    ny /= s[1];
    nz /= s[2];
    const ax = R[0] * nx + R[1] * ny + R[2] * nz, ay = R[3] * nx + R[4] * ny + R[5] * nz, az = R[6] * nx + R[7] * ny + R[8] * nz;
    const l = Math.hypot(ax, ay, az) || 1;
    nrm[i] = ax / l;
    nrm[i + 1] = ay / l;
    nrm[i + 2] = az / l;
  }
  after?.(o);
  o.bounds = boundsOf(pos, o.firstVertex, o.vertexCount);
  for (let k = 0; k < 3; k++) {
    m.bounds.min[k] = Math.min(m.bounds.min[k], o.bounds.min[k]);
    m.bounds.max[k] = Math.max(m.bounds.max[k], o.bounds.max[k]);
  }
}

/** A gimmick play test can use: shown, with animation nodes and at least one clip. Usable. */
export const usable = (o) => !!o && !o.state.hidden && o.vertexCount > 0 && o.mesh.rig?.nodes.length > 0 && o.mesh.rig.clips.size > 0;

/**
 * Gimmick use for one play test. gimmicks(): [placement, its object] pairs; live(g): the placement as it is now;
 * zonesOf(type): its trigger zones; pose(o, deltaOf): write o posed and upload it; rest(o): o back where the map has it.
 * off holds the objects whose collision is left out (give it to PlayWorld.off); tick returns a line to flash or null.
 */
export function gimmickUse({ gimmicks, live, zonesOf, pose, rest }) {
  const anims = [], off = new Set();
  let held = false;

  /** The gimmick the player would use: whose trigger zone the body is in, else the nearest usable one in reach. GimmickToUse. */
  function toUse(feet) {
    let best = null, bestD = GIMMICK_USE_REACH;
    for (const [g0, o] of gimmicks()) {
      if (!usable(o)) continue;
      const g = live(g0);
      if (g.removed) continue;
      const f = gimmickFrame(g.position, g.rotation);
      for (const z of zonesOf(g0.type) ?? [])
        for (let h = 10; h <= PLAY.height; h += 40) if (inTrapZone(z, toLocal(f, [feet[0], feet[1] + h, feet[2]]))) return { g: g0, o };
      const d = Math.hypot(g.position[0] - feet[0], g.position[2] - feet[2]);
      if (d < bestD && Math.abs(g.position[1] - feet[1]) < 600) {
        bestD = d;
        best = { g: g0, o };
      }
    }
    return best;
  }

  /** Starts a gimmick's clip, or turns an open gate round. UseGimmick. */
  function use({ g, o }) {
    const playing = anims.find((a) => a.g === g);
    if (playing) {
      if (playing.gate) {
        playing.dir = playing.dir < 0 ? 1 : -1;
        playing.hold = 0;
      } else {
        playing.frame = 0;
        playing.dir = 1;
      }
      return playing.gate ? (playing.dir > 0 ? 'Gate opens' : 'Gate closes') : `${g.type}: ${playing.clip.name}`;
    }
    const a = { g, o, clip: useClip(o.mesh.rig), frame: 0, dir: 1, hold: 0, gate: isGateType(g.type), posed: NaN };
    anims.push(a);
    if (a.gate) off.add(o.index);
    return `${a.gate ? 'Gate opens' : g.type} — ${a.clip.name}`;
  }

  /** Moves a playing gimmick's object by its nodes' poses at the clip's frame. PoseGimmick. */
  function poseOf(a) {
    if (a.posed === a.frame) return;
    a.posed = a.frame;
    const nodes = a.o.mesh.rig.nodes, cache = new Array(nodes.length);
    pose(a.o, (n) => {
      if (!(n >= 0 && n < nodes.length)) n = 0;
      return cache[n] === undefined ? (cache[n] = prepared(nodeDelta(a.clip, nodes[n], a.frame))) : cache[n];
    });
  }

  return {
    off,
    /** One play-test step: the use button (on its press) and every playing clip. TickGimmickUse. */
    tick(dt, useDown, feet) {
      let msg = null;
      if (useDown && !held) {
        const g = toUse(feet);
        msg = g ? use(g) : 'Nothing to use here';
      }
      held = useDown;
      for (let k = anims.length - 1; k >= 0; k--) {
        const a = anims[k], last = Math.max(0, a.clip.frameCount - 1);
        if (a.dir > 0) {
          a.frame += dt * GIMMICK_CLIP_FPS;
          if (a.frame >= last) {
            a.frame = last;
            a.dir = 0;
            a.hold = a.gate ? GATE_OPEN_SECONDS : 0;
          }
        } else if (a.dir < 0) {
          a.frame -= dt * GIMMICK_CLIP_FPS;
          if (a.frame <= 0) {
            // Shut: back to its place, solid again.
            off.delete(a.o.index);
            rest(a.o);
            anims.splice(k, 1);
            continue;
          }
        } else if (a.gate && (a.hold -= dt) <= 0) a.dir = -1;
        poseOf(a);
      }
      return msg;
    },
    /** How many gimmicks are playing a clip (for the test page). */
    get playing() {
      return anims.length;
    },
    /** Play stopped: every gimmick back where the map has it, all collision back. EndGimmickUse. */
    end() {
      for (const a of anims) rest(a.o);
      anims.length = 0;
      off.clear();
      held = false;
    },
  };
}
