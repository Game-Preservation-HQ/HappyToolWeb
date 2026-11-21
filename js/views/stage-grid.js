// The map editor's floor grid and snapping, as the desktop has them (StageViewerForm.Grid.cs): a Blender-like grid at a
// height with three levels of lines (the grid step, ×10, ×100), each fading in as its lines spread apart on screen and
// out towards the edge; the map's X axis red and Z axis green; snapping puts what moves on the grid (holding Ctrl does
// the opposite while dragging); X / Y / Z arrows in the lower-left corner turn with the camera. Kept in this browser.

/** Grid steps in cm, as the desktop offers them. */
export const GRID_SIZES = [10, 25, 50, 100, 200, 250, 500, 1000];
/** 0 off, 1 on (hidden behind the map), 2 on top of everything. */
export const GRID_SHOW = ['off', 'on', 'on top of everything'];
const KEY = 'happytool-web-grid';

export function loadGrid() {
  const g = { show: 1, size: 100, snap: false, height: 0, axes: true };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && typeof s === 'object') {
      if ([0, 1, 2].includes(s.show)) g.show = s.show;
      if (GRID_SIZES.includes(s.size)) g.size = s.size;
      if (typeof s.snap === 'boolean') g.snap = s.snap;
      if (Number.isFinite(s.height)) g.height = s.height;
      if (typeof s.axes === 'boolean') g.axes = s.axes;
    }
  } catch {
    // kept settings that can't be read: the defaults
  }
  return g;
}

export function saveGrid(g) {
  try {
    localStorage.setItem(KEY, JSON.stringify(g));
  } catch {
    // private browsing: the grid still works, it just isn't remembered
  }
}

/** "1 m", "25 cm". */
export const sizeText = (cm) => (cm >= 100 ? `${cm / 100} m` : `${cm} cm`);
/** The grid's state in a few words ("grid 1 m · snap"). */
export const gridSummary = (g) => `${g.show ? `grid ${sizeText(g.size)}` : 'grid off'}${g.snap ? ' · snap' : ''}`;

/** The next finer (-1) or coarser (+1) grid step. */
export function stepSize(g, dir) {
  const i = GRID_SIZES.indexOf(g.size);
  return GRID_SIZES[Math.max(0, Math.min(GRID_SIZES.length - 1, (i < 0 ? 3 : i) + dir))];
}

export const snapToGrid = (g, v) => Math.round(v / g.size) * g.size;
/** A height on one of the grid's levels (counted from the grid's own height). */
export const snapHeight = (g, y) => g.height + snapToGrid(g, y - g.height);

/** A move along a world axis, snapped: along X or Z the centre lands on a line, up or down the base lands on a level. */
export function snapAxisMove(g, axis, delta, centre, baseY) {
  if (axis === 1) return snapHeight(g, baseY + delta) - baseY;
  return snapToGrid(g, centre[axis] + delta) - centre[axis];
}

/** A carry's move, snapped: the footprint centre on the grid, and in the air the base on a level too. */
export function snapCarryMove(g, move, centre, baseY, onSurface) {
  const m = move.slice();
  m[0] = snapToGrid(g, centre[0] + m[0]) - centre[0];
  m[2] = snapToGrid(g, centre[2] + m[2]) - centre[2];
  if (!onSurface) m[1] = snapHeight(g, baseY + m[1]) - baseY;
  return m;
}

// ----- drawing -----

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aColor;
layout(location=2) in float aRadius;
uniform mat4 uViewProj;
out vec2 vXZ;
out vec4 vColor;
out float vRadius;
void main() {
  vXZ = aPos.xz;
  vColor = aColor;
  vRadius = aRadius;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;
const FS = `#version 300 es
precision highp float;
uniform vec2 uCentre;
in vec2 vXZ;
in vec4 vColor;
in float vRadius;
out vec4 outColor;
void main() {
  float t = length(vXZ - uCentre) / vRadius;
  float a = t >= 1.0 ? 0.0 : vColor.a * (1.0 - t * t) * (1.0 - t * t);
  if (a < 0.004) discard;
  outColor = vec4(vColor.rgb, a);
}`;

function program(gl) {
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'grid shader');
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, shader(gl.VERTEX_SHADER, VS));
  gl.attachShader(p, shader(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'grid program');
  return { p, vp: gl.getUniformLocation(p, 'uViewProj'), c: gl.getUniformLocation(p, 'uCentre') };
}

const LINE = [0.62, 0.62, 0.66];
const AXIS_X = [0.92, 0.28, 0.3], AXIS_Y = [0.35, 0.55, 1], AXIS_Z = [0.5, 0.82, 0.22];
const FLOATS = 8; // x y z r g b a radius

/**
 * Returns draw(grid, {vp, eye, f, viewH, fov, far}) for this GL context, or null when it can't be set up. The grid sits
 * around the point a little ahead of the camera, so looking along the floor shows more of it in front than behind.
 */
export function gridDrawer(gl) {
  let prog;
  try {
    prog = program(gl);
  } catch (e) {
    console.warn(`Map editor: the grid can't be drawn: ${e.message}`);
    return null;
  }
  const vao = gl.createVertexArray(), buf = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, FLOATS * 4, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, FLOATS * 4, 12);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, FLOATS * 4, 28);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  let data = new Float32Array(FLOATS * 2 * 4096);

  return function draw(g, { vp, eye, f, viewH, fov, far }) {
    if (!g.show) return;
    const h = g.height;
    const d = Math.max(Math.abs(eye[1] - h), g.size * 0.5);
    const radius = Math.min(far, Math.max(d * 25, g.size * 40));
    const fl = Math.hypot(f[0], f[2]);
    const c = fl > 1e-3 ? [eye[0] + (f[0] / fl) * radius * 0.35, eye[2] + (f[2] / fl) * radius * 0.35] : [eye[0], eye[2]];
    const pxPerCm = Math.max(1, viewH) / (2 * Math.tan(fov / 2)) / d;
    const y = h + Math.max(0.5, d * 0.0004); // just above the plane, so ground lying exactly on it doesn't hide it
    let n = 0;
    const line = (x0, z0, x1, z1, col, a, r) => {
      if (n + FLOATS * 2 > data.length) {
        const more = new Float32Array(data.length * 2);
        more.set(data);
        data = more;
      }
      data.set([x0, y, z0, col[0], col[1], col[2], a, r, x1, y, z1, col[0], col[1], col[2], a, r], n);
      n += FLOATS * 2;
    };
    for (let level = 0; level < 3; level++) {
      const s = g.size * 10 ** level, px = s * pxPerCm;
      // Fades in between 6 and 24 pixels apart; the next level up draws every tenth line itself.
      const a = Math.min(1, Math.max(0, (px - 6) / 18)) * [0.32, 0.5, 0.62][level];
      if (a <= 0.01) continue;
      const r = Math.min(radius, s * 160);
      const i0 = Math.floor((c[0] - r) / s), i1 = Math.ceil((c[0] + r) / s);
      const j0 = Math.floor((c[1] - r) / s), j1 = Math.ceil((c[1] + r) / s);
      const nextShown = level < 2 && Math.min(1, Math.max(0, (px * 10 - 6) / 18)) > 0.99;
      for (let i = i0; i <= i1; i++) if (i !== 0 && !(nextShown && i % 10 === 0)) line(i * s, c[1] - r, i * s, c[1] + r, LINE, a, r);
      for (let j = j0; j <= j1; j++) if (j !== 0 && !(nextShown && j % 10 === 0)) line(c[0] - r, j * s, c[0] + r, j * s, LINE, a, r);
    }
    // The map's axes: X red (along z = 0), Z green (along x = 0), as Blender colours its floor axes.
    if (Math.abs(c[1]) < radius) line(c[0] - radius, 0, c[0] + radius, 0, AXIS_X, 0.9, radius);
    if (Math.abs(c[0]) < radius) line(0, c[1] - radius, 0, c[1] + radius, AXIS_Z, 0.9, radius);
    if (!n) return;
    gl.useProgram(prog.p);
    gl.uniformMatrix4fv(prog.vp, false, vp);
    gl.uniform2f(prog.c, c[0], c[1]);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, n), gl.STREAM_DRAW);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    if (g.show === 2) gl.disable(gl.DEPTH_TEST);
    else gl.enable(gl.DEPTH_TEST);
    gl.drawArrays(gl.LINES, 0, n / FLOATS);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  };
}

/** The X / Y / Z arrows in the lower-left corner, turning with the camera (basis: the camera's r, u, f). */
export function drawAxisIndicator(g2, viewH, { r, u, f }) {
  const R = 34, cx = 16 + R + 8, cy = viewH - 16 - R - 8;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const axes = [
    ['X', [1, 0, 0], AXIS_X],
    ['Y', [0, 1, 0], AXIS_Y],
    ['Z', [0, 0, 1], AXIS_Z],
  ]
    .map(([name, v, col]) => ({ name, x: dot(v, r), y: dot(v, u), z: -dot(v, f), col }))
    .sort((a, b) => a.z - b.z); // farthest first
  g2.save();
  g2.fillStyle = 'rgb(0 0 0 / 0.22)';
  g2.beginPath();
  g2.arc(cx, cy, R + 9, 0, Math.PI * 2);
  g2.fill();
  g2.lineWidth = 2;
  g2.lineCap = 'round';
  g2.font = 'bold 11px system-ui, sans-serif';
  g2.textAlign = 'center';
  g2.textBaseline = 'middle';
  for (const ax of axes) {
    const tx = cx + ax.x * R, ty = cy - ax.y * R;
    const dim = ax.z < -0.2 ? 0.55 : 1; // pointing away from the viewer
    const rgb = `rgb(${ax.col.map((v) => Math.round(v * dim * 255)).join(' ')})`;
    g2.strokeStyle = rgb;
    g2.beginPath();
    g2.moveTo(cx, cy);
    g2.lineTo(tx, ty);
    g2.stroke();
    g2.fillStyle = 'rgb(10 13 15 / 0.85)';
    g2.beginPath();
    g2.arc(tx, ty, 7, 0, Math.PI * 2);
    g2.fill();
    g2.fillStyle = rgb;
    g2.fillText(ax.name, tx, ty + 0.5);
  }
  g2.restore();
}
