// Play test (StageViewerForm.Play.cs): walk the map as a stand-in player to try its collision. This is part 1: the
// collision world, the walk, run and jump, the camera behind the player, the stand-in figure and its HUD line. The
// warrior avatar and its actions (part 2b) are in stage-avatar.js; using the gimmicks and starting at a castle (part 2c)
// are not ported yet.

/** Sizes and speeds in the game's units (cm), as the desktop's Play* constants. */
export const PLAY = {
  cell: 400, // grid cell for the triangle lookup (PlayCell)
  radius: 45, // the player's collision spheres (PlayRadius)
  height: 180, // PlayHeight
  walk: 550,
  run: 850,
  gravity: 2400,
  jump: 820,
  step: 40, // highest kerb climbed without a jump (PlayStepHeight)
  walkable: 0.6, // steepest ground stood on: its normal's y (PlayWalkable)
  camDist: 560,
  camMin: 150, // the stage camera's distanceNear / distanceFar when it has them; the web reads neither yet
  camMax: 3000,
};

/** The layer the characters collide with (_Chit), when the stage has one. IsCharacterLayer. */
export const isCharacterLayer = (name) => String(name ?? '').toLowerCase().includes('_chit');

const cellKey = (gx, gz) => (gx + 32768) * 65536 + (gz + 32768);
const BIG_CELLS = 400; // a triangle over more cells than this goes in the list every lookup checks

/** The triangles the player collides with, in a grid for the lookups (PlayWorld). */
export class PlayWorld {
  constructor() {
    this.t = []; // 9 numbers per triangle
    this.n = []; // its unit normal
    this.owner = []; // its object's index, or -1 for the stage's own
    this.count = 0;
    this.minY = Infinity;
    this.maxY = -Infinity;
    this.cells = new Map();
    this.big = [];
  }
  /** Adds one triangle (AddPlayTri); degenerate ones are left out. */
  add(ax, ay, az, bx, by, bz, cx, cy, cz, owner) {
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len >= 1e-4)) return; // too small, or NaN
    const i = this.count++;
    this.t.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    this.n.push(nx / len, ny / len, nz / len);
    this.owner.push(owner);
    this.minY = Math.min(this.minY, ay, by, cy);
    this.maxY = Math.max(this.maxY, ay, by, cy);
    const C = PLAY.cell;
    const x0 = Math.floor(Math.min(ax, bx, cx) / C), x1 = Math.floor(Math.max(ax, bx, cx) / C);
    const z0 = Math.floor(Math.min(az, bz, cz) / C), z1 = Math.floor(Math.max(az, bz, cz) / C);
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > BIG_CELLS) {
      this.big.push(i);
      return;
    }
    for (let gx = x0; gx <= x1; gx++)
      for (let gz = z0; gz <= z1; gz++) {
        const k = cellKey(gx, gz), l = this.cells.get(k);
        if (l) l.push(i);
        else this.cells.set(k, [i]);
      }
  }
  /** Adds triangles given as 9 numbers each, each corner through place(out, at, x, y, z) when given (AddPlayTris). */
  addFlat(f, owner, place = null) {
    const p = new Float64Array(9);
    for (let k = 0; k + 8 < f.length; k += 9) {
      if (place) {
        place(p, 0, f[k], f[k + 1], f[k + 2]);
        place(p, 3, f[k + 3], f[k + 4], f[k + 5]);
        place(p, 6, f[k + 6], f[k + 7], f[k + 8]);
        this.add(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], owner);
      } else this.add(f[k], f[k + 1], f[k + 2], f[k + 3], f[k + 4], f[k + 5], f[k + 6], f[k + 7], f[k + 8], owner);
    }
  }
  /** Done adding: the lists become arrays the lookups read fast. */
  finish() {
    this.t = Float64Array.from(this.t);
    this.n = Float64Array.from(this.n);
    this.owner = Int32Array.from(this.owner);
    this.stamp = new Int32Array(this.count);
    this.stampNo = 0;
    return this;
  }
  /** The triangles whose cells meet the box (x0, z0)–(x1, z1), each once, and the big ones (PlayQuery). */
  query(x0, z0, x1, z1) {
    const out = [], s = ++this.stampNo, C = PLAY.cell;
    const gx0 = Math.floor(x0 / C), gx1 = Math.floor(x1 / C), gz0 = Math.floor(z0 / C), gz1 = Math.floor(z1 / C);
    for (let gx = gx0; gx <= gx1; gx++)
      for (let gz = gz0; gz <= gz1; gz++) {
        const l = this.cells.get(cellKey(gx, gz));
        if (l)
          for (const i of l)
            if (this.stamp[i] !== s) {
              this.stamp[i] = s;
              out.push(i);
            }
      }
    for (const i of this.big) out.push(i);
    return out;
  }
  /** The nearest triangle along a ray within maxDist: { t, tri } or null (PlayRaycast). */
  raycast(o, d, maxDist) {
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len * len < 1e-8) return null;
    const dx = d[0] / len, dy = d[1] / len, dz = d[2] / len, C = PLAY.cell;
    let hitT = Infinity, hit = -1;
    for (let s0 = 0; s0 < maxDist && s0 <= hitT; s0 += C) {
      const s1 = Math.min(maxDist, s0 + C);
      const ax = o[0] + dx * s0, az = o[2] + dz * s0, bx = o[0] + dx * s1, bz = o[2] + dz * s1;
      for (const i of this.query(Math.min(ax, bx) - 1, Math.min(az, bz) - 1, Math.max(ax, bx) + 1, Math.max(az, bz) + 1)) {
        const t = rayTriangle(this.t, i, o, dx, dy, dz);
        if (t > 0 && t < hitT && t <= maxDist) {
          hitT = t;
          hit = i;
        }
      }
    }
    return hit >= 0 ? { t: hitT, tri: hit } : null;
  }
}

/** Möller–Trumbore: the distance along a unit ray to triangle i, or -1 (RayTriangle). */
function rayTriangle(T, i, o, dx, dy, dz) {
  const k = i * 9, ax = T[k], ay = T[k + 1], az = T[k + 2];
  const e1x = T[k + 3] - ax, e1y = T[k + 4] - ay, e1z = T[k + 5] - az;
  const e2x = T[k + 6] - ax, e2y = T[k + 7] - ay, e2z = T[k + 8] - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-7) return -1;
  const inv = 1 / det, sx = o[0] - ax, sy = o[1] - ay, sz = o[2] - az;
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 0.01 ? t : -1;
}

/** The point of triangle i nearest p, into q (Ericson, Real-Time Collision Detection 5.1.5; ClosestOnTriangle). */
function closestOnTriangle(T, i, p, q) {
  const k = i * 9, ax = T[k], ay = T[k + 1], az = T[k + 2], bx = T[k + 3], by = T[k + 4], bz = T[k + 5], cx = T[k + 6], cy = T[k + 7], cz = T[k + 8];
  const set = (x, y, z) => ((q[0] = x), (q[1] = y), (q[2] = z));
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return set(ax, ay, az);
  const bpx = p[0] - bx, bpy = p[1] - by, bpz = p[2] - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return set(ax + abx * v, ay + aby * v, az + abz * v);
  }
  const cpx = p[0] - cx, cpy = p[1] - cy, cpz = p[2] - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return set(ax + acx * w, ay + acy * w, az + acz * w);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return set(bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w);
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return set(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

/** A player standing at spawn, facing that way (an angle about y: 0 looks along +z). StartPlay. */
export const newPlayer = (spawn, facing) => ({
  pos: spawn.slice(),
  vel: [0, 0, 0],
  spawn: spawn.slice(),
  facing,
  ground: false,
  groundTri: -1,
  air: 0,
  jumpHeld: true, // a key already down doesn't jump at once
});

/**
 * One step of the walk (PlayStep): move = (right, forward) in -1..1 relative to the view's forward f (yaw is the
 * fallback when looking straight down). Speeds ease in, gravity pulls, the move is split into sub-steps no longer than
 * half the radius with the contacts resolved after each, and walking off a kerb snaps down onto ground just below.
 * Returns a message when the player fell out of the map and was put back.
 */
export function playStep(w, p, dt, move, run, jump, f, yaw) {
  let fx = f[0], fz = f[2];
  const fl = Math.hypot(fx, fz);
  if (fl > 1e-3) (fx /= fl), (fz /= fl);
  else (fx = Math.sin(yaw)), (fz = -Math.cos(yaw));
  const rx = -fz, rz = fx; // cross(forward, up)
  const wx = fx * move[1] + rx * move[0], wz = fz * move[1] + rz * move[0];
  const speed = run ? PLAY.run : PLAY.walk, k = Math.min(1, (p.ground ? 14 : 3) * dt), v = p.vel;
  v[0] += (wx * speed - v[0]) * k;
  v[2] += (wz * speed - v[2]) * k;
  if (wx * wx + wz * wz > 1e-4) p.facing = Math.atan2(wx, wz);
  let jumped = false;
  if (jump && !p.jumpHeld && p.ground) {
    v[1] = PLAY.jump;
    p.ground = false;
    jumped = true;
  }
  p.jumpHeld = jump;
  v[1] = Math.max(v[1] - PLAY.gravity * dt, -5000);
  const wasGround = p.ground;
  p.ground = false;
  const dx = v[0] * dt, dy = v[1] * dt, dz = v[2] * dt;
  const steps = Math.max(1, Math.min(12, Math.ceil(Math.hypot(dx, dy, dz) / (PLAY.radius * 0.5))));
  for (let s = 0; s < steps; s++) {
    p.pos[0] += dx / steps;
    p.pos[1] += dy / steps;
    p.pos[2] += dz / steps;
    resolveContacts(w, p);
  }
  if (!p.ground && wasGround && !jumped && v[1] <= 0) {
    // Walked off a kerb or down a slope: stay on the ground just below.
    const from = [p.pos[0], p.pos[1] + PLAY.step, p.pos[2]];
    const h = w.raycast(from, [0, -1, 0], PLAY.step + PLAY.radius);
    if (h && w.n[h.tri * 3 + 1] >= PLAY.walkable) {
      p.pos[1] = from[1] - h.t;
      p.ground = true;
      p.groundTri = h.tri;
      v[1] = 0;
    }
  }
  p.air = p.ground ? 0 : p.air + dt;
  if (p.pos[1] < w.minY - 3000) {
    p.pos = p.spawn.slice();
    p.vel = [0, 0, 0];
    p.ground = false;
    p.groundTri = -1;
    p.air = 0;
    return 'Fell out of the map — back to where play started';
  }
  return null;
}

/**
 * Pushes the player's three spheres (feet, middle, head) out of the triangles they overlap (ResolvePlayContacts):
 * ground under the feet lifts them and stands the player on it, a low kerb edge at foot height is climbed, anything
 * else pushes back and takes the speed into it away.
 */
export function resolveContacts(w, p) {
  const R = PLAY.radius, heights = [R, PLAY.height * 0.5, PLAY.height - R], T = w.t, N = w.n, pos = p.pos, v = p.vel;
  const near = w.query(pos[0] - R - 1, pos[2] - R - 1, pos[0] + R + 1, pos[2] + R + 1);
  const q = [0, 0, 0], c = [0, 0, 0];
  for (let iter = 0; iter < 4; iter++) {
    let any = false;
    for (let si = 0; si < heights.length; si++) {
      c[0] = pos[0];
      c[1] = pos[1] + heights[si];
      c[2] = pos[2];
      for (const t of near) {
        closestOnTriangle(T, t, c, q);
        const vx = c[0] - q[0], vy = c[1] - q[1], vz = c[2] - q[2], d2 = vx * vx + vy * vy + vz * vz;
        if (d2 >= R * R) continue;
        const d = Math.sqrt(d2), fx = N[t * 3], fy = N[t * 3 + 1], fz = N[t * 3 + 2];
        let nx, ny, nz;
        if (d > 1e-3) (nx = vx / d), (ny = vy / d), (nz = vz / d);
        else {
          const s = fx * vx + fy * vy + fz * vz >= 0 ? 1 : -1;
          (nx = fx * s), (ny = fy * s), (nz = fz * s);
        }
        const depth = R - d;
        any = true;
        if (si === 0 && ny >= PLAY.walkable) {
          // Standing on it: lift straight up until clear.
          const lift = Math.min(R, depth / Math.max(ny, 0.2));
          pos[1] += lift;
          c[1] += lift;
          if (v[1] < 0) v[1] = 0;
          p.ground = true;
          p.groundTri = t;
        } else if (si === 0 && Math.abs(fy) < 0.3 && q[1] - pos[1] <= PLAY.step && v[1] <= 50) {
          // A kerb / step edge at foot height: climb onto it.
          const lift = q[1] - pos[1] + 1;
          pos[1] += lift;
          c[1] += lift;
        } else {
          pos[0] += nx * depth;
          pos[1] += ny * depth;
          pos[2] += nz * depth;
          c[0] += nx * depth;
          c[1] += ny * depth;
          c[2] += nz * depth;
          const into = v[0] * nx + v[1] * ny + v[2] * nz;
          if (into < 0) (v[0] -= nx * into), (v[1] -= ny * into), (v[2] -= nz * into);
          if (ny < -0.5 && v[1] > 0) v[1] = 0;
        }
      }
    }
    if (!any) break;
  }
}

/**
 * The camera behind the player along the view's forward f, just over the head, pulled in where a wall is in the way
 * (UpdatePlayCamera). Returns { target, dist, camDist } (camDist: the zoom clamped to its range).
 */
export function playCamera(w, p, f, camDist, lift = PLAY.height * 0.85) {
  const target = [p.pos[0], p.pos[1] + lift, p.pos[2]];
  const want = Math.max(PLAY.camMin, Math.min(PLAY.camMax, camDist));
  const h = w.raycast(target, [-f[0], -f[1], -f[2]], want);
  return { target, camDist: want, dist: h ? Math.max(30, h.t - 20) : want };
}

/** The play zoom one wheel notch further: in (up) × 0.85, out × 1.18, in range (PlayWheel). */
export const playWheel = (camDist, up) => Math.max(PLAY.camMin, Math.min(PLAY.camMax, camDist * (up ? 0.85 : 1.18)));

/** Where the player's shadow lies (the ground under it, raised 2), or null. */
export function shadowPoint(w, p) {
  const h = w.raycast([p.pos[0], p.pos[1] + 20, p.pos[2]], [0, -1, 0], 5000);
  return h ? [p.pos[0], p.pos[1] + 20 - h.t + 2, p.pos[2]] : null;
}

/** The HUD line (DrawPlayHud): where the player is, what it stands on (describe(owner) for a triangle's owner), speed. */
export function hudText(w, p, describe) {
  const on = !p.ground ? (p.air > 2 ? 'falling' : 'in the air') : p.groundTri < 0 ? 'ground' : describe(w.owner[p.groundTri]);
  const r = (x) => String(Math.round(x));
  return `PLAYER  X ${r(p.pos[0])}  Y ${r(p.pos[1])}  Z ${r(p.pos[2])}   ·   ${on}   ·   speed ${r(Math.hypot(p.vel[0], p.vel[2]))}`;
}

// ---------- the stand-in figure (DrawPlayer) ----------

// Ellipsoids about the feet, nose along +z: centre, radii, colour.
const PARTS = [
  [[0, 70, 0], [45, 62, 38.25], [0.18, 0.42, 0.95]], // body
  [[0, 148, 0], [34, 32, 34], [1, 0.82, 0.66]], // head
  [[0, 160, -2], [37, 22, 37], [0.75, 0.78, 0.84]], // helmet
  [[0, 146, 32], [8, 8, 10], [1, 0.6, 0.45]], // nose
  [[-17, 9, 6], [14, 9, 20], [0.25, 0.18, 0.12]], // feet
  [[17, 9, 6], [14, 9, 20], [0.25, 0.18, 0.12]],
];

/** 8 rings × 12 segments of flat-shaded quads (PlayEllipsoid): x, y, z, normal, colour per corner. */
function ellipsoid(out, centre, radii, col) {
  const unit = (th, ph) => [Math.cos(th) * Math.sin(ph), Math.sin(th), Math.cos(th) * Math.cos(ph)];
  const put = (u, n) => out.push(centre[0] + u[0] * radii[0], centre[1] + u[1] * radii[1], centre[2] + u[2] * radii[2], n[0], n[1], n[2], col[0], col[1], col[2]);
  for (let r = 0; r < 8; r++)
    for (let s = 0; s < 12; s++) {
      const t0 = (Math.PI * r) / 8 - Math.PI / 2, t1 = (Math.PI * (r + 1)) / 8 - Math.PI / 2;
      const p0 = (2 * Math.PI * s) / 12, p1 = (2 * Math.PI * (s + 1)) / 12;
      const a = unit(t0, p0), b = unit(t0, p1), c = unit(t1, p1), d = unit(t1, p0);
      const sum = [a[0] + b[0] + c[0] + d[0], a[1] + b[1] + c[1] + d[1], a[2] + b[2] + c[2] + d[2]];
      const l = Math.hypot(sum[0], sum[1], sum[2]) || 1, n = [sum[0] / l, sum[1] / l, sum[2] / l];
      for (const u of [a, b, c, a, c, d]) put(u, n);
    }
}

const PLAYER_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec3 aCol;
uniform mat4 uViewProj;
uniform vec3 uAt;
uniform float uFacing;
out vec3 vCol;
void main() {
  float c = cos(uFacing), s = sin(uFacing);
  vec3 p = vec3(c * aPos.x + s * aPos.z, aPos.y, -s * aPos.x + c * aPos.z);
  vec3 n = vec3(c * aNrm.x + s * aNrm.z, aNrm.y, -s * aNrm.x + c * aNrm.z);
  vCol = aCol * (0.45 + 0.55 * max(dot(n, normalize(vec3(0.35, 0.85, 0.4))), 0.0));
  gl_Position = uViewProj * vec4(uAt + p, 1.0);
}`;
const PLAYER_FS = `#version 300 es
precision mediump float;
in vec3 vCol;
uniform float uAlpha;
out vec4 outColor;
void main() { outColor = vec4(vCol, uAlpha); }`;

/** The figure's drawer: draw(vp, player, shadow, figure) draws the stand-in where the player is (unless figure is false) and its shadow disc. */
export function playDrawer(gl) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, PLAYER_VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, PLAYER_FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const U = Object.fromEntries(['uViewProj', 'uAt', 'uFacing', 'uAlpha'].map((n) => [n, gl.getUniformLocation(prog, n)]));
  const upload = (data) => {
    const vao = gl.createVertexArray(), buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    for (let a = 0; a < 3; a++) {
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 3, gl.FLOAT, false, 36, a * 12);
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return { vao, count: data.length / 9 };
  };
  const parts = [];
  for (const [c, r, col] of PARTS) ellipsoid(parts, c, r, col);
  const disc = [];
  for (let i = 0; i < 20; i++) {
    const a0 = (2 * Math.PI * i) / 20, a1 = (2 * Math.PI * (i + 1)) / 20, R = PLAY.radius;
    for (const [x, z] of [[0, 0], [Math.cos(a0) * R, Math.sin(a0) * R], [Math.cos(a1) * R, Math.sin(a1) * R]]) disc.push(x, 0, z, 0, 1, 0, 0, 0, 0);
  }
  const body = upload(parts), shadow = upload(disc);
  return {
    draw(vp, p, shadowAt, figure = true) {
      gl.useProgram(prog);
      gl.uniformMatrix4fv(U.uViewProj, false, vp);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.DEPTH_TEST);
      gl.uniform3fv(U.uAt, p.pos);
      gl.uniform1f(U.uFacing, p.facing);
      gl.uniform1f(U.uAlpha, 1);
      if (figure) {
        gl.bindVertexArray(body.vao);
        gl.drawArrays(gl.TRIANGLES, 0, body.count);
      }
      if (shadowAt) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.uniform3fv(U.uAt, shadowAt);
        gl.uniform1f(U.uFacing, 0);
        gl.uniform1f(U.uAlpha, 0.35);
        gl.bindVertexArray(shadow.vao);
        gl.drawArrays(gl.TRIANGLES, 0, shadow.count);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }
      gl.bindVertexArray(null);
    },
  };
}
