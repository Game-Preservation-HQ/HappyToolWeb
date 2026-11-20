// Map viewer and editor: draws a Steam stage bundle with WebGL2 — terrain, models, prop packs and sky, colour
// textures on UV0 and baked lightmaps on UV1 — with an orbit/fly camera, layer toggles and click to inspect (slice 1),
// and moves, turns, scales and hides objects with a gizmo, keys and a placement panel (slice 2, see stage-edit.js).
// Lighting, lightmap modes and sky placement follow HappyTool/GUI/StageViewerForm.cs (InitGl, DrawMesh, sky pass).
import { el, button, toast, downloadBlob, pickFiles, confirmBox, debounce } from '../ui.js';
import { decodeLayers } from '../formats/wrappers.js';
import { decodeDds } from '../formats/dds.js';
import { buildSteamStage } from '../formats/steam-stage.js';
import { stripTextureExtension } from '../formats/rrm.js';
import {
  IDENTITY, AXES, UNIFORM, History, collectObjects, writeObject, withState, sameState, isEmpty, wrapDegrees, niceStep,
  shortObjectName, editsFile, readEditsFile, loadStored, store, stageKey, ringPoint, distanceToSegment,
  closestParamOnAxis, screenAngle, screenTurnSign, turnAbout,
} from './stage-edit.js';

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

/** The mesh's vertex array, plus its position and normal buffers, which placement edits rewrite in place. */
function uploadMesh(gl, m) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const attr = (data, loc, size, usage = gl.STATIC_DRAW) => {
    if (!data) return gl.disableVertexAttribArray(loc);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data instanceof Float32Array ? data : new Float32Array(data), usage);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    return b;
  };
  const pos = attr(m.positions, 0, 3, m.sky ? gl.STATIC_DRAW : gl.DYNAMIC_DRAW);
  const nrm = attr(m.normals, 1, 3, m.sky ? gl.STATIC_DRAW : gl.DYNAMIC_DRAW);
  attr(m.uvs, 2, 2);
  attr(m.uvs2, 3, 2);
  const ebo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, pos, nrm };
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
  best.object = best.mesh.editObjects?.find((ob) => first >= ob.firstIndex && first < ob.firstIndex + ob.indexCount) || null;
  return best;
}

/**
 * The scene's movable objects and undo history, made once per scene, with the edits kept in this browser for the
 * stage put back on them.
 */
function setUpEdits(scene, model) {
  for (const m of scene.meshes) {
    if (m.sky) continue;
    if (!(m.positions instanceof Float32Array)) m.positions = Float32Array.from(m.positions);
    if (!(m.normals instanceof Float32Array)) m.normals = Float32Array.from(m.normals);
  }
  const edit = { objects: collectObjects(scene.meshes), history: new History(), stage: stageKey(model.name), restored: 0 };
  const stored = loadStored(edit.stage);
  if (stored) {
    try {
      for (const c of readEditsFile(stored, edit.objects).changed) {
        c.obj.pivot = c.pivot;
        c.obj.state = c.after;
        writeObject(c.obj);
        edit.restored++;
      }
    } catch (e) {
      console.warn(`Map editor: the edits kept for ${edit.stage} could not be read: ${e.message}`);
    }
  }
  return edit;
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
  const placeBox = el('div', { class: 'stage-place' }, el('p', { class: 'muted' }, 'Reading the stage…'));
  const inspectBox = el('div', { class: 'stage-inspect' }, el('p', { class: 'muted' }, 'Click the map to select an object.'));
  const canvas = el('canvas', { class: 'stage-canvas', tabindex: '0', 'aria-label': 'Stage map' });
  const overlay = el('canvas', { class: 'stage-overlay', 'aria-hidden': 'true' });
  const hint = el(
    'div',
    { class: 'stage-hint' },
    'Drag: orbit · Right-drag: pan · Wheel: zoom · WASD/QE: fly · Click: select · 1/2/3: move/rotate/scale · Arrows, PgUp/PgDn: nudge (Ctrl: rotate, Shift: ×5) · [ ]: scale · Del: hide · Ctrl+Z/Y: undo/redo · F: frame · R: reset view',
  );
  const host = el('div', { class: 'stage-canvas-host' }, canvas, overlay, hint);
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
    el(
      'div',
      { class: 'stage-body' },
      el('aside', { class: 'stage-side' }, el('h3', {}, 'Placement'), placeBox, el('h3', {}, 'Inspect'), inspectBox, el('h3', {}, 'Layers'), layersBox),
      host,
    ),
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
    const edit = scene.edit || (scene.edit = setUpEdits(scene, model));
    const gpu = new Map(scene.meshes.map((m) => [m, uploadMesh(gl, m)]));
    const glTex = new Map([...scene.textures].map(([k, img]) => [k, uploadTexture(gl, img, aniso)]));
    const tris = scene.meshes.reduce((s, m) => s + m.indices.length / 3, 0);
    status.textContent =
      `${scene.meshes.length} meshes · ${edit.objects.length.toLocaleString()} objects · ${Math.round(tris).toLocaleString()} triangles · ${glTex.size} textures` +
      (scene.missing.length ? ` (${scene.missing.length} not in this bundle)` : '') +
      (scene.skipped.length ? ` · ${scene.skipped.length} models not read` : '');
    if (scene.missing.length) status.title = `Textures not in this bundle: ${scene.missing.join(', ')}`;
    if (edit.restored && !edit.announced) {
      edit.announced = true;
      toast(`${edit.restored} edited object${edit.restored === 1 ? '' : 's'} put back from this browser.`);
    }

    const sceneCentre = centre(scene.bounds), sceneRadius = radius(scene.bounds);
    const nudgeStep = niceStep(Math.max(1, sceneRadius * 0.01)); // NudgeStep
    const cam = job.camera || (job.camera = framed(scene.bounds, { yaw: 0.6, pitch: -0.55 }));
    let selection = null; // {mesh, first, count, object, hit}
    let tool = 0; // 0 move, 1 rotate, 2 scale
    let hover = -1; // gizmo handle under the pointer
    let gdrag = null; // gizmo drag in progress
    let dirty = true, overlayDirty = true;
    let vp = null, viewW = 1, viewH = 1;
    const keys = new Set();
    let last = performance.now();
    const saveSoon = debounce(() => store(edit.stage, edit.objects), 250);

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
      vp = mul(perspective(FOV, w / h, near, far), lookAt(eye, f, r, u));
      viewW = canvas.clientWidth;
      viewH = canvas.clientHeight;
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
      // Draws indices [a, z) of the bound mesh, tinted when they are the selected object's.
      const range = (a, z, tinted) => {
        if (z <= a) return;
        gl.uniform4f(U.uTint, 1, 0.78, 0.2, tinted ? 0.35 : 0);
        gl.drawElements(gl.TRIANGLES, z - a, gl.UNSIGNED_INT, a * 4);
      };
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
          gl.bindVertexArray(gpu.get(m).vao);
          const useTex = (skyPass || texturesOn) && !!m.uvs;
          const s0 = selection?.mesh === m ? selection.first : 0, s1 = selection?.mesh === m ? selection.first + selection.count : 0;
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
            const b0 = b.firstIndex, b1 = b.firstIndex + b.indexCount, lo = Math.max(b0, s0), hi = Math.min(b1, s1);
            if (lo >= hi) range(b0, b1, false);
            else {
              range(b0, lo, false);
              range(lo, hi, true);
              range(hi, b1, false);
            }
          }
        }
      }
      gl.bindVertexArray(null);
      overlayDirty = true;
    }

    // ----- gizmo (StageViewerForm.Gizmo.cs) -----
    const AXIS_COLOURS = ['#f0525f', '#5fcf62', '#4d8fff'];
    const ACTIVE = '#ffd43b';
    const GRAB = 9; // px
    const RING = 64;
    const BOX_EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const selected = () => selection?.object || null;

    /** World point → CSS pixels in the canvas, or null behind the eye. */
    function project(p) {
      if (!vp) return null;
      const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
      const y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
      const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
      if (w <= 1e-6) return null;
      return { x: ((x / w) * 0.5 + 0.5) * viewW, y: (0.5 - (y / w) * 0.5) * viewH };
    }
    /** The selected object's gizmo: origin at pivot + offset, arms 12% of the distance to the eye (GizmoLength). */
    function gizmo() {
      const o = selected();
      if (!o) return null;
      const origin = o.pivot.map((x, k) => x + o.state.t[k]);
      const { eye } = basis();
      return { o, origin, len: Math.max(1e-3, Math.hypot(origin[0] - eye[0], origin[1] - eye[1], origin[2] - eye[2]) * 0.12) };
    }
    const tipOf = (g, a) => project(g.origin.map((x, k) => x + AXES[a][k] * g.len));
    const ringOf = (g, a) => Array.from({ length: RING + 1 }, (_, i) => project(ringPoint(g.origin, a, g.len, (i / RING) * 2 * Math.PI)));

    /** The handle under p: 0-2 an axis, UNIFORM the scale centre, -1 none (HitTestGizmo). */
    function gizmoHit(p) {
      const g = gizmo();
      const c = g && project(g.origin);
      if (!c) return -1;
      if (tool === 2 && Math.hypot(p.x - c.x, p.y - c.y) <= GRAB + 3) return UNIFORM;
      let best = -1, bestD = GRAB;
      for (let a = 0; a < 3; a++) {
        let d = Infinity;
        if (tool === 1) {
          const ring = ringOf(g, a);
          for (let i = 1; i < ring.length; i++) if (ring[i - 1] && ring[i]) d = Math.min(d, distanceToSegment(p, ring[i - 1], ring[i]));
        } else {
          const tip = tipOf(g, a);
          if (tip) d = distanceToSegment(p, { x: c.x + (tip.x - c.x) * 0.2, y: c.y + (tip.y - c.y) * 0.2 }, tip);
        }
        if (d < bestD) [best, bestD] = [a, d];
      }
      return best;
    }

    function drawOverlay() {
      overlayDirty = false;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(overlay.clientWidth * dpr)), h = Math.max(1, Math.round(overlay.clientHeight * dpr));
      if (overlay.width !== w || overlay.height !== h) {
        overlay.width = w;
        overlay.height = h;
      }
      const g2 = overlay.getContext('2d');
      g2.setTransform(1, 0, 0, 1, 0, 0);
      g2.clearRect(0, 0, w, h);
      g2.setTransform(dpr, 0, 0, dpr, 0, 0);
      const g = gizmo();
      if (!g) return;
      const b = g.o.bounds;
      if (b) {
        const corner = Array.from({ length: 8 }, (_, i) => project([0, 1, 2].map((k) => ((i >> k) & 1 ? b.max[k] : b.min[k]))));
        g2.strokeStyle = 'rgb(255 212 59 / 0.7)';
        g2.lineWidth = 1;
        g2.beginPath();
        for (const [i, j] of BOX_EDGES)
          if (corner[i] && corner[j]) {
            g2.moveTo(corner[i].x, corner[i].y);
            g2.lineTo(corner[j].x, corner[j].y);
          }
        g2.stroke();
      }
      const c = project(g.origin);
      if (!c) return;
      const active = gdrag ? gdrag.axis : hover;
      const style = (a) => {
        g2.strokeStyle = g2.fillStyle = a === active ? ACTIVE : AXIS_COLOURS[a];
        g2.lineWidth = a === active ? 3.5 : 2.2;
      };
      g2.lineCap = 'round';
      if (tool === 1) {
        for (let a = 0; a < 3; a++) {
          style(a);
          g2.beginPath();
          let pen = false;
          for (const q of ringOf(g, a)) {
            if (!q) pen = false;
            else if (pen) g2.lineTo(q.x, q.y);
            else {
              g2.moveTo(q.x, q.y);
              pen = true;
            }
          }
          g2.stroke();
        }
        return;
      }
      for (let a = 0; a < 3; a++) {
        const tip = tipOf(g, a);
        if (!tip) continue;
        style(a);
        g2.beginPath();
        g2.moveTo(c.x, c.y);
        g2.lineTo(tip.x, tip.y);
        g2.stroke();
        const l = Math.hypot(tip.x - c.x, tip.y - c.y) || 1, ux = (tip.x - c.x) / l, uy = (tip.y - c.y) / l;
        g2.beginPath();
        if (tool === 0) {
          g2.moveTo(tip.x + ux * 11, tip.y + uy * 11);
          g2.lineTo(tip.x - uy * 5, tip.y + ux * 5);
          g2.lineTo(tip.x + uy * 5, tip.y - ux * 5);
          g2.closePath();
        } else g2.rect(tip.x - 5, tip.y - 5, 10, 10);
        g2.fill();
      }
      if (tool === 2) {
        g2.fillStyle = active === UNIFORM ? ACTIVE : '#e8e8e8';
        g2.fillRect(c.x - 6, c.y - 6, 12, 12);
      }
    }

    function startGizmo(handle, p) {
      const g = gizmo();
      const d = { axis: handle, tool, o: g.o, before: g.o.state, origin: g.origin, len: g.len, startY: p.y };
      if (tool === 0 || (tool === 2 && handle !== UNIFORM)) {
        const { o: ro, d: rd } = rayAt(p.x, p.y);
        const s0 = closestParamOnAxis(g.origin, AXES[handle], ro, rd);
        if (s0 == null) return false;
        // A scale drag measures against the grab point, kept off the origin so the factor can't blow up.
        d.s0 = tool === 2 && Math.abs(s0) < g.len * 0.1 ? (s0 < 0 ? -1 : 1) * g.len * 0.1 : s0;
      } else if (tool === 1) {
        const c = project(g.origin);
        if (!c) return false;
        Object.assign(d, { c, prev: screenAngle(c, p), acc: 0, sign: 1 });
        // Which way a positive turn about the axis goes on screen, at the ring point nearest the pointer
        // (RotationScreenSign).
        let near = null, nearD = Infinity;
        for (let i = 0; i < RING; i++) {
          const w = ringPoint(g.origin, handle, g.len, (i / RING) * 2 * Math.PI), q = project(w);
          const dq = q ? Math.hypot(q.x - p.x, q.y - p.y) : Infinity;
          if (dq < nearD) [near, nearD] = [{ w, q }, dq];
        }
        const turned = near && project(turnAbout(near.w, g.origin, handle, 2));
        if (turned) d.sign = screenTurnSign(c, near.q, turned);
      }
      gdrag = d;
      edit.history.breakMerge();
      overlayDirty = true;
      return true;
    }

    function moveGizmo(p, e) {
      const d = gdrag, st = d.before, snap = e.ctrlKey || e.metaKey;
      let next;
      if (d.tool === 0) {
        const { o: ro, d: rd } = rayAt(p.x, p.y);
        const s = closestParamOnAxis(d.origin, AXES[d.axis], ro, rd);
        if (s == null) return;
        const lim = Math.max(1, sceneRadius * 4);
        let delta = Math.max(-lim, Math.min(lim, s - d.s0));
        if (snap) delta = Math.round(delta / nudgeStep) * nudgeStep;
        next = withState(st, { t: st.t.map((x, k) => (k === d.axis ? x + delta : x)) });
      } else if (d.tool === 1) {
        const a = screenAngle(d.c, p);
        let da = a - d.prev;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        d.prev = a;
        d.acc += da;
        let deg = ((d.acc * 180) / Math.PI) * d.sign;
        if (snap) deg = Math.round(deg / 15) * 15;
        next = withState(st, { r: st.r.map((x, k) => (k === d.axis ? wrapDegrees(x + deg) : x)) });
      } else {
        let f;
        if (d.axis === UNIFORM) f = Math.pow(2, (d.startY - p.y) / 120);
        else {
          const { o: ro, d: rd } = rayAt(p.x, p.y);
          const s = closestParamOnAxis(d.origin, AXES[d.axis], ro, rd);
          if (s == null) return;
          f = Math.max(0.02, Math.min(50, s / d.s0));
        }
        if (snap) f = Math.max(0.1, Math.round(f * 10) / 10);
        const all = d.axis === UNIFORM || (uniformBox.checked && !e.shiftKey);
        next = withState(st, { s: st.s.map((x, k) => (all || k === d.axis ? x * f : x)) });
      }
      apply(d.o, next);
      syncPanel();
    }

    function endGizmo() {
      const d = gdrag;
      gdrag = null;
      edit.history.push([{ obj: d.o, before: d.before, after: d.o.state }], ['Move', 'Rotate', 'Scale'][d.tool]);
      edit.history.breakMerge();
      edited();
    }

    function cancelDrag() {
      const d = gdrag;
      gdrag = null;
      apply(d.o, d.before);
      syncPanel();
    }

    // ----- placement edits -----
    /** Places an object and sends its vertices to the GPU. */
    function apply(o, st) {
      o.state = st;
      writeObject(o);
      const g = gpu.get(o.mesh), a = o.firstVertex * 3, z = (o.firstVertex + o.vertexCount) * 3;
      gl.bindBuffer(gl.ARRAY_BUFFER, g.pos);
      gl.bufferSubData(gl.ARRAY_BUFFER, a * 4, o.mesh.positions.subarray(a, z));
      if (g.nrm) {
        gl.bindBuffer(gl.ARRAY_BUFFER, g.nrm);
        gl.bufferSubData(gl.ARRAY_BUFFER, a * 4, o.mesh.normals.subarray(a, z));
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      dirty = true;
    }
    /** Changes objects' placements as one undo step (merged with the last when mergeKey matches). */
    function change(list, fn, label, mergeKey = null) {
      const changes = [];
      for (const o of list) {
        const before = o.state, after = fn(before, o);
        if (!after || sameState(before, after)) continue;
        apply(o, after);
        changes.push({ obj: o, before, after });
      }
      if (!changes.length) return;
      edit.history.push(changes, label, mergeKey);
      edited();
    }
    function edited() {
      saveSoon();
      syncPanel();
      dirty = true;
    }
    function undo() {
      const step = edit.history.undo.pop();
      if (!step) return;
      for (const c of [...step.changes].reverse()) apply(c.obj, c.before);
      edit.history.redo.push(step);
      edit.history.breakMerge();
      edited();
      status.textContent = `Undid: ${step.label}`;
    }
    function redo() {
      const step = edit.history.redo.pop();
      if (!step) return;
      for (const c of step.changes) apply(c.obj, c.after);
      edit.history.undo.push(step);
      edit.history.breakMerge();
      edited();
      status.textContent = `Redid: ${step.label}`;
    }

    /** Keyboard placement of the selection (HandlePlacementKey); true when the key was used. */
    function placementKey(e, k) {
      const o = selected();
      if (!o) return false;
      const ctrl = e.ctrlKey || e.metaKey, coarse = e.shiftKey;
      const MOVE = { arrowleft: [0, -1], arrowright: [0, 1], arrowup: [2, -1], arrowdown: [2, 1], pageup: [1, 1], pagedown: [1, -1] };
      const TURN = { arrowleft: [1, -1], arrowright: [1, 1], arrowup: [0, 1], arrowdown: [0, -1], pageup: [2, 1], pagedown: [2, -1] };
      if (MOVE[k]) {
        if (ctrl) {
          const [axis, sign] = TURN[k];
          change([o], (st) => withState(st, { r: st.r.map((x, i) => (i === axis ? wrapDegrees(x + sign * (coarse ? 45 : 5)) : x)) }), 'Rotate', 'key-rotate');
        } else {
          const [axis, sign] = MOVE[k];
          change([o], (st) => withState(st, { t: st.t.map((x, i) => (i === axis ? x + sign * nudgeStep * (coarse ? 5 : 1) : x)) }), 'Move', 'key-move');
        }
        return true;
      }
      if (ctrl) return false;
      const up = [']', '}', '+', '='].includes(k), down = ['[', '{', '-', '_'].includes(k);
      if (up || down) {
        const f = coarse ? 1.25 : 1.05;
        change([o], (st) => withState(st, { s: st.s.map((x) => (up ? x * f : x / f)) }), 'Scale', 'key-scale');
        return true;
      }
      if (k === 'home') change([o], (st) => ({ ...IDENTITY, hidden: st.hidden, solid: st.solid }), 'Reset');
      else if (k === 'delete') change([o], (st) => ({ ...st, hidden: !st.hidden }), o.state.hidden ? 'Show' : 'Hide');
      else if (k === 'k') change([o], (st) => ({ ...st, solid: !st.solid }), 'Solid');
      else return false;
      return true;
    }

    function setTool(t) {
      tool = t;
      hover = -1;
      overlayDirty = true;
      toolBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(i === t)));
    }

    // ----- placement panel -----
    const fmtNum = (x) => String(Math.round(x * 1000) / 1000);
    const uniformBox = el('input', { type: 'checkbox' });
    const toolBtns = ['Move', 'Rotate', 'Scale'].map((label, i) => button(label, () => setTool(i), { 'aria-pressed': String(i === tool), title: `${label} tool (${i + 1})` }));
    const undoBtn = button('Undo', undo, { title: 'Undo (Ctrl+Z)' });
    const redoBtn = button('Redo', redo, { title: 'Redo (Ctrl+Y)' });
    const countLine = el('p', { class: 'muted stage-count' });
    const fileRow = el(
      'div',
      { class: 'toolbar stage-file' },
      button('Save edits…', saveFile, { title: 'Download the edits as a HappyTool stage edits file, the same JSON the desktop app keeps in stage_edits' }),
      button('Load edits…', loadFile, { title: 'Apply a stage edits file saved here or by the desktop HappyTool' }),
      button('Clear all', clearAll, { title: 'Put every edited object back where the stage file has it' }),
    );
    let fields = null;

    function renderPanel() {
      const o = selected();
      if (!o) {
        fields = null;
        placeBox.replaceChildren(
          el('p', { class: 'muted' }, 'Click an object on the map to move, rotate, scale or hide it.'),
          el('div', { class: 'toolbar' }, undoBtn, redoBtn),
          countLine,
          fileRow,
        );
        return syncPanel();
      }
      const num = (g, k, title) => {
        const input = el('input', { type: 'number', class: 'input input-sm', step: 'any', title, 'aria-label': title });
        input.addEventListener('change', () => {
          const v = input.value === '' ? NaN : Number(input.value);
          if (Number.isFinite(v)) change([o], (st) => withState(st, { [g]: st[g].map((x, i) => (i === k ? (g === 'r' ? wrapDegrees(v) : v) : x)) }), title);
          syncPanel(true);
        });
        return input;
      };
      const check = (label, key, title) => {
        const box = el('input', { type: 'checkbox' });
        box.addEventListener('change', () => change([o], (st) => ({ ...st, [key]: box.checked }), label));
        return [box, el('label', { class: 'check', title }, box, ` ${label}`)];
      };
      const [hiddenBox, hiddenLabel] = check('Hidden', 'hidden', 'Hide the object (Delete); the desktop app writes it as Deleted');
      const [solidBox, solidLabel] = check('Solid', 'solid', 'Mark the object as blocking the player (K)');
      fields = {
        t: [0, 1, 2].map((k) => num('t', k, `Offset ${'XYZ'[k]}`)),
        r: [0, 1, 2].map((k) => num('r', k, `Rotate ${'XYZ'[k]} (degrees)`)),
        s: [0, 1, 2].map((k) => num('s', k, `Scale ${'XYZ'[k]}`)),
        hidden: hiddenBox,
        solid: solidBox,
      };
      const head = (t) => el('span', { class: 'stage-xyz-head' }, t);
      placeBox.replaceChildren(
        el('div', { class: 'stage-place-name', title: o.name }, shortObjectName(o.name)),
        el(
          'p',
          { class: 'muted stage-place-info' },
          `${o.vertexCount.toLocaleString()} vertices · ${Math.round(o.indexCount / 3).toLocaleString()} triangles · pivot ${o.pivot.map((x) => x.toFixed(1)).join(', ')}`,
        ),
        el('div', { class: 'toolbar stage-tools' }, toolBtns),
        el('div', { class: 'stage-xyz' }, el('span'), head('X'), head('Y'), head('Z'), head('Offset'), fields.t, head('Rotate°'), fields.r, head('Scale'), fields.s),
        el('div', { class: 'stage-checks' }, el('label', { class: 'check', title: 'Scale handles scale all three axes (hold Shift for one)' }, uniformBox, ' Uniform'), hiddenLabel, solidLabel),
        el('div', { class: 'toolbar' }, button('Reset', () => placementKey({}, 'home'), { title: 'Undo every move, turn and scale of this object (Home)' }), undoBtn, redoBtn),
        countLine,
        fileRow,
      );
      syncPanel();
    }
    /** Shows the selection's current placement and the edit count; force also rewrites the focused field. */
    function syncPanel(force = false) {
      const n = edit.objects.reduce((s, o) => s + (isEmpty(o.state) ? 0 : 1), 0);
      countLine.textContent = n ? `${n} object${n === 1 ? '' : 's'} edited · kept in this browser` : 'No edits yet.';
      undoBtn.disabled = !edit.history.undo.length;
      redoBtn.disabled = !edit.history.redo.length;
      const o = selected();
      if (!fields || !o) return;
      for (const g of ['t', 'r', 's'])
        fields[g].forEach((input, k) => {
          if (force || document.activeElement !== input) input.value = fmtNum(o.state[g][k]);
        });
      fields.hidden.checked = o.state.hidden;
      fields.solid.checked = o.state.solid;
    }

    function saveFile() {
      const file = editsFile(edit.stage, edit.objects);
      if (!Object.keys(file.Objects).length) return toast('There are no edits to save yet.');
      downloadBlob(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }), `${edit.stage}.json`);
    }
    async function loadFile() {
      const [f] = await pickFiles({ accept: '.json,application/json' });
      if (!f) return;
      let res;
      try {
        res = readEditsFile(JSON.parse((await f.text()).replace(/^﻿/, '')), edit.objects);
      } catch (e) {
        return toast(`${f.name} could not be read: ${e.message}`, 'error');
      }
      const changes = [];
      for (const c of res.changed) {
        c.obj.pivot = c.pivot;
        apply(c.obj, c.after);
        changes.push({ obj: c.obj, before: c.before, after: c.after });
      }
      edit.history.push(changes, 'Load edits file');
      edit.history.breakMerge();
      edited();
      renderPanel();
      const missed = res.unmatched.length ? `; ${res.unmatched.length} not on this stage` : '';
      toast(`${f.name}: ${changes.length} object${changes.length === 1 ? '' : 's'} placed${missed}.`);
      if (res.unmatched.length) console.info('Map editor: names in the edits file not on this stage:', res.unmatched);
    }
    async function clearAll() {
      const list = edit.objects.filter((o) => !isEmpty(o.state));
      if (!list.length) return toast('There are no edits to clear.');
      if (!(await confirmBox(`Put all ${list.length} edited objects back where the stage file has them? Undo can bring the edits back.`, 'Clear all', true))) return;
      change(list, () => IDENTITY, 'Clear all edits');
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
      if (overlayDirty) drawOverlay();
      requestAnimationFrame(frame);
    }
    function stop() {
      stopped = true;
      resize.disconnect();
      store(edit.stage, edit.objects);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    const resize = new ResizeObserver(() => (dirty = true));
    resize.observe(host);
    requestAnimationFrame(frame);

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

    // ----- selection and inspect -----
    const fmt = (v) => v.map((x) => x.toFixed(2)).join(', ');
    /** Selects what a click hit (null clears the selection). */
    function inspect(hit) {
      if (!hit) return select(null);
      const ob = hit.object, m = hit.mesh;
      selection = ob ? { mesh: m, first: ob.firstIndex, count: ob.indexCount, object: ob, hit } : { mesh: m, first: 0, count: m.indices.length, object: null, hit };
      selectionChanged();
    }
    function select(o) {
      selection = o ? { mesh: o.mesh, first: o.firstIndex, count: o.indexCount, object: o, hit: null } : null;
      selectionChanged();
    }
    function selectionChanged() {
      if (gdrag) cancelDrag();
      edit.history.breakMerge();
      hover = -1;
      canvas.style.cursor = '';
      renderInspect();
      renderPanel();
      dirty = true;
    }
    function cycle(dir) {
      const list = edit.objects.filter((o) => o.mesh.visible);
      if (!list.length) return;
      const i = list.indexOf(selected());
      select(list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length]);
    }
    function renderInspect() {
      if (!selection) {
        inspectBox.replaceChildren(el('p', { class: 'muted' }, 'Click the map to select an object.'));
        return;
      }
      const { mesh: m, object: ob, hit, first, count } = selection;
      const b = hit?.batch || m.batches.find((x) => x.firstIndex + x.indexCount > first && x.firstIndex < first + count);
      const texName = (n) => (n ? (scene.textures.has(lower(n)) ? n : `${n} (not in this bundle)`) : '—');
      const rows = [
        ['Object', ob ? shortObjectName(ob.name) : shortName(m.name)],
        ob?.label ? ['Node', ob.label] : null,
        ['File', m.name.split('/')[0]],
        ['Layer', GROUPS.find(([k]) => k === m.kind)?.[1] || m.kind],
        ['Texture', texName(b?.texture)],
        ['Lightmap', texName(b?.lightmap)],
        ['Triangles', Math.round(count / 3).toLocaleString()],
        hit ? ['Point', fmt(hit.point)] : null,
        ob?.recordOffset != null ? ['Record', `0x${ob.recordOffset.toString(16).toUpperCase()}`] : null,
      ].filter(Boolean);
      inspectBox.replaceChildren(
        el('dl', {}, rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v))])),
        el(
          'div',
          { class: 'toolbar' },
          button('Frame', frameSelection, { title: 'Move the camera to this object (F)' }),
          button('Hide layer', () => {
            m.visible = false;
            select(null);
            renderLayers();
          }),
        ),
      );
    }
    function frameSelection() {
      let b = scene.bounds;
      const o = selected();
      if (o) {
        const at = o.pivot.map((x, k) => x + o.state.t[k]);
        b = o.bounds || { min: at, max: at };
      } else if (selection) b = selection.mesh.bounds;
      Object.assign(cam, framed(b, cam));
      dirty = true;
    }
    renderPanel();

    // ----- input -----
    const rayAt = (x, y) => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      const nx = (x / w) * 2 - 1, ny = 1 - (y / h) * 2, t = Math.tan(FOV / 2);
      const { f, r, u, eye } = basis();
      return { o: eye, d: norm3([0, 1, 2].map((k) => f[k] + r[k] * nx * t * (w / h) + u[k] * ny * t)) };
    };
    const local = (e) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    let drag = null;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      canvas.focus();
      canvas.setPointerCapture(e.pointerId);
      if (e.button === 0 && !gdrag) {
        const p = local(e), handle = gizmoHit(p);
        if (handle >= 0 && startGizmo(handle, p)) return;
      }
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, pan: e.button !== 0 || e.shiftKey, moved: false };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (gdrag) return moveGizmo(local(e), e);
      if (!drag) {
        const h = gizmoHit(local(e));
        if (h !== hover) {
          hover = h;
          overlayDirty = true;
          canvas.style.cursor = h >= 0 ? 'pointer' : '';
        }
        return;
      }
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
      if (gdrag) return endGizmo();
      const d = drag;
      drag = null;
      if (!d || d.moved || e.button !== 0) return;
      const p = local(e);
      const { o, d: dir } = rayAt(p.x, p.y);
      inspect(pick(scene, o, dir));
    });
    canvas.addEventListener('pointercancel', () => {
      if (gdrag) cancelDrag();
      drag = null;
    });
    canvas.addEventListener('dblclick', (e) => {
      const p = local(e);
      const { o, d } = rayAt(p.x, p.y);
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
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && !e.altKey && (k === 'z' || k === 'y')) {
        e.preventDefault();
        if (k === 'y' || e.shiftKey) redo();
        else undo();
        return;
      }
      if (k === 'escape') return gdrag ? cancelDrag() : select(null);
      // Tab cycles the selection once there is one; with nothing selected it moves focus as usual.
      if (k === 'tab' && selected() && !ctrl && !e.altKey) {
        e.preventDefault();
        return cycle(e.shiftKey ? -1 : 1);
      }
      if (e.altKey) return;
      if (!ctrl && (k === '1' || k === '2' || k === '3')) return setTool(Number(k) - 1);
      if (!gdrag && placementKey(e, k)) return e.preventDefault();
      if (ctrl) return;
      if (['w', 'a', 's', 'd', 'q', 'e', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        keys.add(k);
        e.preventDefault();
      } else if (k === 'f') frameSelection();
      else if (k === 'r' || k === 'home') {
        Object.assign(cam, framed(scene.bounds, { yaw: 0.6, pitch: -0.55 }));
        dirty = true;
      }
    });
    canvas.addEventListener('keyup', (e) => {
      keys.delete(e.key.toLowerCase());
      edit.history.breakMerge(); // a released key ends its burst of nudges
    });
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
