// Map viewer (map editor slice 1): draws a Steam stage bundle with WebGL2 — terrain, models, prop packs and sky,
// colour textures on UV0 and baked lightmaps on UV1 — with an orbit/fly camera, layer toggles and click to inspect.
// Lighting, lightmap modes and sky placement follow HappyTool/GUI/StageViewerForm.cs (InitGl, DrawMesh, sky pass).
import { el, button } from '../ui.js';
import { decodeLayers } from '../formats/wrappers.js';
import { decodeDds } from '../formats/dds.js';
import { buildSteamStage } from '../formats/steam-stage.js';
import { stripTextureExtension } from '../formats/rrm.js';

const FOV = Math.PI / 4;
const SKY_RADIUS = 920; // ClipFar 1000 * 0.92 when StageCameraParam.json isn't read (ComputeSkyRenderRadius)
const LM_KEY = 'happytool-web-lightmap';
const LM_MODES = [
  ['normal', 'Lightmap: normal'],
  ['bright', 'Lightmap: bright (×2)'],
  ['off', 'Lightmap: off'],
];
const GROUPS = [
  ['terrain', 'Terrain'],
  ['pack', 'Object packs'],
  ['model', 'Models'],
  ['sky', 'Sky'],
];

/** bres model → {promise, report, camera}: the built scene survives re-renders of the view. */
const jobs = new WeakMap();
const pause = () => new Promise((r) => setTimeout(r, 0));
const lower = (s) => (s ? s.toLowerCase() : s);
const shortName = (n) => n.replace(/\\/g, '/').split('/').slice(-2).join('/');

/** True for little-endian bundles that hold .rrm models (Steam stage bundles). */
export const looksLikeStage = (arc) => !!arc?.littleEndian && arc.entries.some((e) => /\.rrm$/i.test(e.name) && !e.pointer);

// ---------- scene ----------

async function loadScene(model, report) {
  const rrm = [];
  for (const e of model.entries) {
    if (!/\.rrm$/i.test(e.name) || e.pointer || !e.data?.length) continue;
    rrm.push({ name: e.name, pointer: false, data: (await decodeLayers(e.data)).payload });
  }
  const ddsEntries = model.entries.filter((e) => /\.dds$/i.test(e.name));
  report(`Building ${rrm.length} models…`);
  await pause();
  const built = buildSteamStage([...rrm, ...ddsEntries.map((e) => ({ name: e.name, pointer: true, data: null }))]);

  const textures = new Map();
  let n = 0;
  for (const e of ddsEntries) {
    const key = lower(stripTextureExtension(e.name));
    if (!built.textures.has(key) || textures.has(key) || e.pointer || !e.data?.length) continue;
    if (n++ % 6 === 0) {
      report(`Decoding textures (${n} of ${built.textures.size})…`);
      await pause();
    }
    try {
      textures.set(key, decodeDds((await decodeLayers(e.data)).payload));
    } catch (err) {
      console.warn(`Map viewer: ${e.name} could not be decoded: ${err.message}`);
    }
  }

  const meshes = built.meshes.filter((m) => m.positions.length >= 9 && m.indices.length >= 3);
  for (const m of meshes) {
    m.sky = /sky/i.test(m.name);
    if (m.sky) m.kind = 'sky';
    m.normals = patchNormals(m.positions, m.indices, m.normals);
    if (m.sky) m.positions = unitDirections(m.positions);
    m.bounds = boundsOf(m.positions, 0, m.positions.length / 3);
    m.visible = true;
  }
  const solid = meshes.filter((m) => !m.sky);
  return {
    meshes,
    skipped: built.skipped,
    textures,
    missing: [...built.textures].filter((k) => !textures.has(k)),
    bounds: unionBounds((solid.length ? solid : meshes).map((m) => m.bounds)),
  };
}

/** Authored normals where they exist, smooth computed ones for meshes (or merged records) that had none. */
function patchNormals(pos, idx, authored) {
  const vc = pos.length / 3;
  let needed = !authored || authored.length !== pos.length;
  if (!needed) for (let i = 0; i < vc && !needed; i++) needed = Math.hypot(authored[i * 3], authored[i * 3 + 1], authored[i * 3 + 2]) < 1e-6;
  if (!needed) return authored;
  const n = new Float32Array(vc * 3);
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) {
      n[k] += nx;
      n[k + 1] += ny;
      n[k + 2] += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
    if (authored?.length === pos.length && Math.hypot(authored[i], authored[i + 1], authored[i + 2]) >= 1e-6) {
      n[i] = authored[i];
      n[i + 1] = authored[i + 1];
      n[i + 2] = authored[i + 2];
    } else if (l > 1e-12) {
      n[i] /= l;
      n[i + 1] /= l;
      n[i + 2] /= l;
    } else n[i + 1] = 1;
  }
  return n;
}

/** Sky domes are drawn around the eye: keep only each vertex's direction (NormalizeSkyDirections). */
function unitDirections(pos) {
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const l = Math.hypot(pos[i], pos[i + 1], pos[i + 2]);
    if (l < 1e-6) out[i + 1] = 1;
    else {
      out[i] = pos[i] / l;
      out[i + 1] = pos[i + 1] / l;
      out[i + 2] = pos[i + 2] / l;
    }
  }
  return out;
}

function boundsOf(pos, firstVertex, count) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let v = firstVertex; v < firstVertex + count; v++)
    for (let k = 0; k < 3; k++) {
      const x = pos[v * 3 + k];
      if (x < min[k]) min[k] = x;
      if (x > max[k]) max[k] = x;
    }
  return { min, max };
}

function unionBounds(list) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const b of list)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], b.min[k]);
      max[k] = Math.max(max[k], b.max[k]);
    }
  if (!Number.isFinite(min[0])) return { min: [-1, -1, -1], max: [1, 1, 1] };
  return { min, max };
}

const centre = (b) => b.min.map((v, k) => (v + b.max[k]) / 2);
const radius = (b) => Math.max(0.5, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2);

// ---------- maths (column-major 4x4) ----------

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

function lookAt(eye, f, r, u) {
  const d = (a) => a[0] * eye[0] + a[1] * eye[1] + a[2] * eye[2];
  return new Float32Array([r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, -d(r), -d(u), d(f), 1]);
}

function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}

const norm3 = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

// ---------- GL ----------

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec2 aUv0;
layout(location=3) in vec2 aUv1;
uniform mat4 uViewProj;
uniform vec3 uEye;
uniform float uSkyRadius;
out vec3 vNrm; out vec2 vUv0; out vec2 vUv1; out vec3 vWorld;
void main() {
  vec3 p = uSkyRadius > 0.0 ? uEye + aPos * uSkyRadius : aPos;
  vWorld = p; vNrm = aNrm; vUv0 = aUv0; vUv1 = aUv1;
  gl_Position = uViewProj * vec4(p, 1.0);
}`;

// uMode: 0 hemisphere colour (no textures), 1 grey (batch without texture), 2 colour, 3 colour x lightmap,
// 4 lightmap alone on UV1. Fixed-function equivalent: clamp(vertexColour * (ambient + diffuse*N.L)) * texture,
// then * lightmap * scale on the second unit, with lighting off whenever the lightmap is used.
const FS = `#version 300 es
precision highp float;
in vec3 vNrm; in vec2 vUv0; in vec2 vUv1; in vec3 vWorld;
uniform sampler2D uTex0;
uniform sampler2D uTex1;
uniform int uMode;
uniform bool uLit;
uniform float uLmScale;
uniform vec3 uEye;
uniform vec4 uTint;
out vec4 outColor;
const vec3 LIGHT = normalize(vec3(0.4, 1.0, 0.6));
void main() {
  vec3 n = normalize(vNrm);
  vec3 mat = vec3(1.0);
  vec4 tex = vec4(1.0);
  if (uMode == 0) mat = mix(vec3(0.30, 0.31, 0.37), vec3(0.92, 0.92, 0.88), clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
  else if (uMode == 1) mat = vec3(0.72, 0.73, 0.75);
  else if (uMode == 4) tex = texture(uTex0, vUv1);
  else tex = texture(uTex0, vUv0);
  if (tex.a <= 0.4) discard;
  vec3 c = mat;
  if (uLit) {
    vec3 ln = dot(n, uEye - vWorld) < 0.0 ? -n : n;
    c = min(mat * (vec3(0.46, 0.46, 0.50) + vec3(0.85, 0.84, 0.80) * max(dot(ln, LIGHT), 0.0)), vec3(1.0));
  }
  c *= tex.rgb;
  if (uMode == 3) c = min(c * texture(uTex1, vUv1).rgb * uLmScale, vec3(1.0));
  outColor = vec4(mix(c, uTint.rgb, uTint.a), 1.0);
}`;

function compile(gl) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  for (const name of ['uViewProj', 'uEye', 'uSkyRadius', 'uTex0', 'uTex1', 'uMode', 'uLit', 'uLmScale', 'uTint']) u[name] = gl.getUniformLocation(p, name);
  return { program: p, u };
}

function uploadMesh(gl, m) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const attr = (data, loc, size) => {
    if (!data) return gl.disableVertexAttribArray(loc);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  };
  attr(m.positions, 0, 3);
  attr(m.normals, 1, 3);
  attr(m.uvs, 2, 2);
  attr(m.uvs2, 3, 2);
  const ebo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return vao;
}

function uploadTexture(gl, img, aniso) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength));
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
  return t;
}

// ---------- picking ----------

function rayHitsBox(o, d, b) {
  let t0 = 0, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    const inv = 1 / d[k];
    let a = (b.min[k] - o[k]) * inv, c = (b.max[k] - o[k]) * inv;
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
    if (t0 > t1) return false;
  }
  return true;
}

function pick(scene, o, d) {
  let best = null;
  for (const m of scene.meshes) {
    if (!m.visible || m.sky || !rayHitsBox(o, d, m.bounds)) continue;
    const p = m.positions, idx = m.indices;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
      const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
      const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const tx = o[0] - p[a], ty = o[1] - p[a + 1], tz = o[2] - p[a + 2];
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (dist > 1e-6 && (!best || dist < best.dist)) best = { mesh: m, tri: t / 3, dist };
    }
  }
  if (!best) return null;
  best.point = [o[0] + d[0] * best.dist, o[1] + d[1] * best.dist, o[2] + d[2] * best.dist];
  const first = best.tri * 3;
  best.batch = best.mesh.batches.find((b) => first >= b.firstIndex && first < b.firstIndex + b.indexCount) || null;
  best.object = best.mesh.objects?.find((ob) => first >= ob.firstIndex && first < ob.firstIndex + ob.indexCount) || null;
  return best;
}

// ---------- view ----------

/** The map view of a stage bundle node. ctx.back returns to the entry list. */
export function renderStage(node, ctx) {
  const model = node.model;
  let job = jobs.get(model);
  const status = el('span', { class: 'muted stage-status' }, 'Reading the stage…');
  if (!job) {
    job = { report: null, camera: null };
    job.promise = loadScene(model, (t) => job.report?.(t));
    jobs.set(model, job);
  }
  job.report = (t) => (status.textContent = t);

  const layersBox = el('div', { class: 'stage-layers' });
  const inspectBox = el('div', { class: 'stage-inspect' }, el('p', { class: 'muted' }, 'Click the map to inspect a piece.'));
  const canvas = el('canvas', { class: 'stage-canvas', tabindex: '0', 'aria-label': 'Stage map' });
  const hint = el('div', { class: 'stage-hint' }, 'Drag: orbit · Right-drag: pan · Wheel: zoom · WASD/QE: fly (Shift: fast) · Click: inspect · Double-click: focus · F: frame · R: reset');
  const host = el('div', { class: 'stage-canvas-host' }, canvas, hint);
  const lmSelect = el('select', { class: 'input input-sm', 'aria-label': 'Lightmap mode' }, LM_MODES.map(([v, label]) => el('option', { value: v }, label)));
  lmSelect.value = localStorage.getItem(LM_KEY) || 'normal';
  const texBox = el('input', { type: 'checkbox', checked: true });
  const resetBtn = button('Reset view', null, { title: 'Frame the whole stage (R)' });
  const view = el(
    'div',
    { class: 'view stage-view' },
    el(
      'div',
      { class: 'toolbar' },
      button('← Entries', ctx.back, { title: 'Back to the list of entries in this bundle' }),
      el('strong', {}, model.name),
      lmSelect,
      el('label', { class: 'check' }, texBox, ' Textures'),
      resetBtn,
      el('span', { class: 'spacer' }),
      status,
    ),
    el('div', { class: 'stage-body' }, el('aside', { class: 'stage-side' }, el('h3', {}, 'Layers'), layersBox, el('h3', {}, 'Inspect'), inspectBox), host),
  );

  job.promise.then(
    (scene) => view.isConnected && start(scene),
    (e) => {
      console.error(e);
      status.textContent = `Could not build the map: ${e.message}`;
      jobs.delete(model);
    },
  );

  function start(scene) {
    const gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) {
      status.textContent = 'This browser has no WebGL2, so the map cannot be drawn.';
      return;
    }
    let prog;
    try {
      prog = compile(gl);
    } catch (e) {
      status.textContent = `Shader error: ${e.message}`;
      return;
    }
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    const vaos = new Map(scene.meshes.map((m) => [m, uploadMesh(gl, m)]));
    const glTex = new Map([...scene.textures].map(([k, img]) => [k, uploadTexture(gl, img, aniso)]));
    const tris = scene.meshes.reduce((s, m) => s + m.indices.length / 3, 0);
    status.textContent =
      `${scene.meshes.length} meshes · ${Math.round(tris).toLocaleString()} triangles · ${glTex.size} textures` +
      (scene.missing.length ? ` (${scene.missing.length} not in this bundle)` : '') +
      (scene.skipped.length ? ` · ${scene.skipped.length} models not read` : '');
    if (scene.missing.length) status.title = `Textures not in this bundle: ${scene.missing.join(', ')}`;

    const sceneCentre = centre(scene.bounds), sceneRadius = radius(scene.bounds);
    const cam = job.camera || (job.camera = framed(scene.bounds, { yaw: 0.6, pitch: -0.55 }));
    let selection = null;
    let dirty = true;
    const keys = new Set();
    let last = performance.now();

    function framed(b, from) {
      return { yaw: from.yaw, pitch: from.pitch, target: centre(b), dist: (radius(b) / Math.sin(FOV / 2)) * 1.05 };
    }
    function basis() {
      const cp = Math.cos(cam.pitch);
      const f = [cp * Math.sin(cam.yaw), Math.sin(cam.pitch), -cp * Math.cos(cam.yaw)];
      const r = norm3([-f[2], 0, f[0]]);
      const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
      const eye = [cam.target[0] - f[0] * cam.dist, cam.target[1] - f[1] * cam.dist, cam.target[2] - f[2] * cam.dist];
      return { f, r, u, eye };
    }

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.clearColor(0.04, 0.05, 0.06, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const { f, r, u, eye } = basis();
      const toCentre = Math.hypot(eye[0] - sceneCentre[0], eye[1] - sceneCentre[1], eye[2] - sceneCentre[2]);
      const near = Math.max(0.05, sceneRadius * 0.001);
      const hasSky = scene.meshes.some((m) => m.sky && m.visible);
      let far = toCentre + sceneRadius * 4 + 10;
      if (hasSky) far = Math.max(far, SKY_RADIUS * 1.05);
      const vp = mul(perspective(FOV, w / h, near, far), lookAt(eye, f, r, u));
      gl.useProgram(prog.program);
      const U = prog.u;
      gl.uniformMatrix4fv(U.uViewProj, false, vp);
      gl.uniform3fv(U.uEye, eye);
      gl.uniform1i(U.uTex0, 0);
      gl.uniform1i(U.uTex1, 1);
      gl.uniform1f(U.uLmScale, lmSelect.value === 'bright' ? 2 : 1);
      gl.disable(gl.CULL_FACE);
      const texturesOn = texBox.checked;
      const lmOn = lmSelect.value !== 'off';
      for (const pass of ['sky', 'solid']) {
        const skyPass = pass === 'sky';
        if (skyPass) {
          gl.disable(gl.DEPTH_TEST);
          gl.depthMask(false);
        } else {
          gl.enable(gl.DEPTH_TEST);
          gl.depthMask(true);
        }
        gl.uniform1f(U.uSkyRadius, skyPass ? SKY_RADIUS : 0);
        for (const m of scene.meshes) {
          if (!m.visible || m.sky !== skyPass) continue;
          gl.bindVertexArray(vaos.get(m));
          const useTex = (skyPass || texturesOn) && !!m.uvs;
          for (const b of m.batches) {
            const colour = useTex && b.texture ? glTex.get(lower(b.texture)) : null;
            const light = useTex && m.uvs2 && b.lightmap ? glTex.get(lower(b.lightmap)) : null;
            const useLight = !!light && lmOn;
            let mode = 0;
            if (useTex) mode = colour ? (useLight ? 3 : 2) : light ? 4 : 1;
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, mode === 4 ? light : colour);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, mode === 3 ? light : null);
            gl.uniform1i(U.uMode, mode);
            gl.uniform1i(U.uLit, skyPass || useLight ? 0 : 1);
            const sel = selection && selection.mesh === m && b.firstIndex >= selection.first && b.firstIndex < selection.first + selection.count;
            gl.uniform4f(U.uTint, 1, 0.78, 0.2, sel ? 0.35 : 0);
            gl.drawElements(gl.TRIANGLES, b.indexCount, gl.UNSIGNED_INT, b.firstIndex * 4);
          }
        }
      }
      gl.bindVertexArray(null);
    }

    function fly(dt) {
      if (!keys.size) return false;
      const { f, r } = basis();
      const speed = Math.max(5, sceneRadius * 0.35) * (keys.has('shift') ? 4 : 1) * dt;
      const mv = [0, 0, 0];
      const add = (v, s) => v.forEach((x, k) => (mv[k] += x * s));
      if (keys.has('w') || keys.has('arrowup')) add(f, 1);
      if (keys.has('s') || keys.has('arrowdown')) add(f, -1);
      if (keys.has('d') || keys.has('arrowright')) add(r, 1);
      if (keys.has('a') || keys.has('arrowleft')) add(r, -1);
      if (keys.has('e')) add([0, 1, 0], 1);
      if (keys.has('q')) add([0, 1, 0], -1);
      if (!mv.some((x) => x)) return false;
      cam.target = cam.target.map((x, k) => x + mv[k] * speed);
      return true;
    }

    let stopped = false;
    function frame(now) {
      if (stopped) return;
      if (!canvas.isConnected) return stop();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (fly(dt)) dirty = true;
      if (dirty) {
        dirty = false;
        draw();
      }
      requestAnimationFrame(frame);
    }
    function stop() {
      stopped = true;
      resize.disconnect();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    const resize = new ResizeObserver(() => (dirty = true));
    resize.observe(host);
    requestAnimationFrame(frame);

    // ----- layers -----
    function renderLayers() {
      const rows = [];
      for (const [kind, title] of GROUPS) {
        const list = scene.meshes.filter((m) => m.kind === kind);
        if (!list.length) continue;
        const all = el('input', { type: 'checkbox', checked: list.every((m) => m.visible), title: `Show or hide all ${title.toLowerCase()}` });
        all.addEventListener('change', () => {
          list.forEach((m) => (m.visible = all.checked));
          dirty = true;
          renderLayers();
        });
        rows.push(el('label', { class: 'stage-group-head' }, all, ` ${title}`, el('span', { class: 'muted' }, ` ${list.length}`)));
        for (const m of list) {
          const box = el('input', { type: 'checkbox', checked: m.visible });
          box.addEventListener('change', () => {
            m.visible = box.checked;
            dirty = true;
          });
          const extra = m.objects ? `${m.objects.length} obj` : `${Math.round(m.indices.length / 3).toLocaleString()} tris`;
          rows.push(el('label', { class: 'stage-layer', title: m.name }, box, el('span', { class: 'stage-layer-name' }, shortName(m.name)), el('span', { class: 'muted' }, extra)));
        }
      }
      if (scene.skipped.length)
        rows.push(el('p', { class: 'muted stage-skipped', title: scene.skipped.join('\n') }, `${scene.skipped.length} model files not shown (format not read yet).`));
      if (!scene.meshes.length) rows.push(el('p', { class: 'muted' }, 'No stage geometry was found in this bundle.'));
      layersBox.replaceChildren(...rows);
    }
    renderLayers();

    // ----- inspect -----
    const fmt = (v) => v.map((x) => x.toFixed(2)).join(', ');
    function inspect(hit) {
      if (!hit) {
        selection = null;
        inspectBox.replaceChildren(el('p', { class: 'muted' }, 'Nothing there. Click the map to inspect a piece.'));
        dirty = true;
        return;
      }
      const m = hit.mesh, ob = hit.object, b = hit.batch;
      selection = ob ? { mesh: m, first: ob.firstIndex, count: ob.indexCount, object: ob } : { mesh: m, first: 0, count: m.indices.length };
      const texName = (n) => (n ? (scene.textures.has(lower(n)) ? n : `${n} (not in this bundle)`) : '—');
      const rows = [
        ['Object', ob ? shortName(ob.name) : shortName(m.name)],
        ob?.label ? ['Node', ob.label] : null,
        ['File', m.name.split('/')[0]],
        ['Layer', GROUPS.find(([k]) => k === m.kind)?.[1] || m.kind],
        ['Texture', texName(b?.texture)],
        ['Lightmap', texName(b?.lightmap)],
        ['Triangles', Math.round((ob ? ob.indexCount : m.indices.length) / 3).toLocaleString()],
        ['Point', fmt(hit.point)],
        ob?.recordOffset != null ? ['Record', `0x${ob.recordOffset.toString(16).toUpperCase()}`] : null,
      ].filter(Boolean);
      inspectBox.replaceChildren(
        el('dl', {}, rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v))])),
        el(
          'div',
          { class: 'toolbar' },
          button('Frame', frameSelection, { title: 'Move the camera to this piece (F)' }),
          button('Hide layer', () => {
            m.visible = false;
            inspect(null);
            renderLayers();
          }),
        ),
      );
      dirty = true;
    }
    function frameSelection() {
      let b = scene.bounds;
      if (selection?.object) b = boundsOf(selection.mesh.positions, selection.object.firstVertex, selection.object.vertexCount);
      else if (selection) b = selection.mesh.bounds;
      Object.assign(cam, framed(b, cam));
      dirty = true;
    }

    // ----- input -----
    const rayAt = (x, y) => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      const nx = (x / w) * 2 - 1, ny = 1 - (y / h) * 2, t = Math.tan(FOV / 2);
      const { f, r, u, eye } = basis();
      return { o: eye, d: norm3([0, 1, 2].map((k) => f[k] + r[k] * nx * t * (w / h) + u[k] * ny * t)) };
    };
    let drag = null;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      canvas.focus();
      canvas.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, pan: e.button !== 0 || e.shiftKey, moved: false };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) drag.moved = true;
      if (drag.pan) {
        const { r, u } = basis();
        const s = (2 * cam.dist * Math.tan(FOV / 2)) / Math.max(1, canvas.clientHeight);
        cam.target = cam.target.map((x, k) => x - r[k] * dx * s + u[k] * dy * s);
      } else {
        cam.yaw += dx * 0.006;
        cam.pitch = Math.max(-1.55, Math.min(1.55, cam.pitch - dy * 0.006));
      }
      dirty = true;
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = drag;
      drag = null;
      if (!d || d.moved || e.button !== 0) return;
      const rect = canvas.getBoundingClientRect();
      const { o, d: dir } = rayAt(e.clientX - rect.left, e.clientY - rect.top);
      inspect(pick(scene, o, dir));
    });
    canvas.addEventListener('dblclick', (e) => {
      const rect = canvas.getBoundingClientRect();
      const { o, d } = rayAt(e.clientX - rect.left, e.clientY - rect.top);
      const hit = pick(scene, o, d);
      if (!hit) return;
      const f = norm3(hit.point.map((x, k) => x - o[k]));
      cam.target = hit.point;
      cam.dist = Math.max(near(), hit.dist);
      cam.pitch = Math.asin(Math.max(-1, Math.min(1, f[1])));
      cam.yaw = Math.atan2(f[0], -f[2]);
      dirty = true;
    });
    const near = () => Math.max(0.05, sceneRadius * 0.002);
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        cam.dist = Math.max(near(), cam.dist * Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
        dirty = true;
      },
      { passive: false },
    );
    canvas.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (['w', 'a', 's', 'd', 'q', 'e', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        keys.add(k);
        e.preventDefault();
      } else if (k === 'f') frameSelection();
      else if (k === 'r' || k === 'home') {
        Object.assign(cam, framed(scene.bounds, { yaw: 0.6, pitch: -0.55 }));
        dirty = true;
      } else if (k === 'escape') inspect(null);
    });
    canvas.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
    canvas.addEventListener('blur', () => keys.clear());
    resetBtn.addEventListener('click', () => {
      Object.assign(cam, framed(scene.bounds, { yaw: 0.6, pitch: -0.55 }));
      dirty = true;
    });
    lmSelect.addEventListener('change', () => {
      localStorage.setItem(LM_KEY, lmSelect.value);
      dirty = true;
    });
    texBox.addEventListener('change', () => (dirty = true));
  }

  return view;
}
