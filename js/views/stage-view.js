// Map viewer and editor: draws a Steam stage bundle with WebGL2 — terrain, models, prop packs and sky, colour
// textures on UV0 and baked lightmaps on UV1 — with an orbit/fly camera, layer toggles and click to inspect (slice 1),
// and moves, turns, scales and hides objects with a gizmo, keys and a placement panel (slice 2, see stage-edit.js).
// Lighting, lightmap modes and sky placement follow HappyTool/GUI/StageViewerForm.cs (InitGl, DrawMesh, sky pass).
// The sky can be swapped for another stage's, a picture or a colour preset (slice 3, see stage-sky.js).
import { el, button, toast, downloadBlob, pickFiles, confirmBox, debounce } from '../ui.js';
import { decodeLayers, encodeLayers, writableLayers } from '../formats/wrappers.js';
import { writeBres } from '../formats/bres.js';
import { downloadBytes } from '../util.js';
import { decodeDds } from '../formats/dds.js';
import { buildSteamStage } from '../formats/steam-stage.js';
import { stripTextureExtension } from '../formats/rrm.js';
import {
  IDENTITY, AXES, UNIFORM, History, collectObjects, writeObject, withState, sameState, isEmpty, wrapDegrees, niceStep,
  shortObjectName, editsFile, readEditsFile, loadStored, store, stageKey, ringPoint, distanceToSegment,
  closestParamOnAxis, screenAngle, screenTurnSign, turnAbout, isIdentityTransform, rotation,
} from './stage-edit.js';
import {
  SKY_PRESETS, cloneSky, sameSky, skyLabel, presetSky, pictureSky, textureRoles, readSkyPack, bakeSky, encodeDxt1Dds,
  storePicture, loadPicture,
} from './stage-sky.js';
import {
  makeFog, sameFog, fogHex, withHex, metres, fogFromFeature, readFog, readFogFromFile, bakeFog, fogPreviewOn, setFogPreview, fogRgb,
} from './stage-fog.js';
import { readCollision, edgesOf } from './stage-collision.js';

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
/** Preset name → its dome picture, made once. */
const presetDomes = new Map();
/** Whether the fog differs from the stage's own (only then is it kept and written, as on the desktop). */
const fogChanged = (e) => !!e.fogStock && !!e.fog && !sameFog(e.fog, e.fogStock);
/** The edits file's Features: other features kept as read, plus the fog when it is changed (or as stored, until read). */
function fogFeatures(e) {
  const out = { ...e.otherFeatures };
  const fog = e.fogStock ? (fogChanged(e) ? e.fog : null) : e.storedFog;
  if (fog) out.fog = { Enable: fog.Enable, Near: fog.Near, Far: fog.Far, Color: fog.Color };
  return Object.keys(out).length ? out : null;
}
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
uniform bool uFogOn;
uniform vec3 uFogColor;
uniform vec2 uFogRange;
uniform vec3 uFwd;
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
  if (uFogOn) {
    float d = dot(vWorld - uEye, uFwd);
    c = mix(uFogColor, c, clamp((uFogRange.y - d) / (uFogRange.y - uFogRange.x), 0.0, 1.0));
  }
  outColor = vec4(mix(c, uTint.rgb, uTint.a), 1.0);
}`;

// The collision overlay's lines: one flat colour, pulled 0.3% of the way toward the eye so they show over the surface
// they lie on (the desktop draws them with a polygon offset, which WebGL doesn't apply to lines).
const LINE_VS = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uViewProj;
uniform vec3 uEye;
void main() { gl_Position = uViewProj * vec4(uEye + (aPos - uEye) * 0.997, 1.0); }`;
const LINE_FS = `#version 300 es
precision mediump float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = uColor; }`;

const MAP_UNIFORMS = ['uViewProj', 'uEye', 'uSkyRadius', 'uTex0', 'uTex1', 'uMode', 'uLit', 'uLmScale', 'uTint', 'uFogOn', 'uFogColor', 'uFogRange', 'uFwd'];

function compile(gl, vs = VS, fs = FS, names = MAP_UNIFORMS) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  for (const name of names) u[name] = gl.getUniformLocation(p, name);
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
  const edit = {
    objects: collectObjects(scene.meshes),
    history: new History(),
    stage: stageKey(model.name),
    restored: 0,
    sky: null, // the sky setting (SkyEdit), null = the stage's own
    skyPicture: null, // {name, width, height, rgba, canvas}: the dome picture in picture mode
    storedPicture: null, // the picture kept in this browser
    fog: null, // the fog setting {Enable, Near, Far, Color}, read with the stage's own (fogStock)
    fogStock: null,
    storedFog: null, // the fog kept in this browser, until the stage's own is read
    otherFeatures: {}, // edits-file features this page doesn't edit, kept as read
    fogPreview: fogPreviewOn(),
  };
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
    edit.sky = cloneSky(stored.Sky);
    if (stored.Features && typeof stored.Features === 'object' && !Array.isArray(stored.Features)) {
      const { fog, ...rest } = stored.Features;
      edit.storedFog = fogFromFeature(fog);
      edit.otherFeatures = rest;
    }
    if (edit.sky?.Mode === 'picture')
      edit.pictureJob = loadPicture(edit.stage).then((pic) => {
        edit.storedPicture = pic;
        if (pic && pic.name === edit.sky?.Picture && !edit.skyPicture) edit.skyPicture = pic;
      });
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
  const skyBox = el('div', { class: 'stage-sky' }, el('p', { class: 'muted' }, 'Reading the stage…'));
  const fogBox = el('div', { class: 'stage-sky stage-fog' }, el('p', { class: 'muted' }, 'Reading the stage…'));
  const downloadBox = el('div', { class: 'stage-sky' }, el('p', { class: 'muted' }, 'Reading the stage…'));
  const canvas = el('canvas', { class: 'stage-canvas', tabindex: '0', 'aria-label': 'Stage map' });
  const overlay = el('canvas', { class: 'stage-overlay', 'aria-hidden': 'true' });
  const hint = el(
    'div',
    { class: 'stage-hint' },
    'Drag: orbit · Right-drag: pan · Wheel: zoom · WASD/QE: fly · Click: select · 1/2/3: move/rotate/scale · Arrows, PgUp/PgDn: nudge (Ctrl: rotate, Shift: ×5) · [ ]: scale · Del: hide · Ctrl+Z/Y: undo/redo · F: frame · R: reset view · H: collision',
  );
  const host = el('div', { class: 'stage-canvas-host' }, canvas, overlay, hint);
  const lmSelect = el('select', { class: 'input input-sm', 'aria-label': 'Lightmap mode' }, LM_MODES.map(([v, label]) => el('option', { value: v }, label)));
  lmSelect.value = localStorage.getItem(LM_KEY) || 'normal';
  const texBox = el('input', { type: 'checkbox', checked: true });
  const colBox = el('input', { type: 'checkbox', disabled: true });
  const colLabel = el('label', { class: 'check muted', title: 'Reading the collision…' }, colBox, ' Collision');
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
      colLabel,
      resetBtn,
      el('span', { class: 'spacer' }),
      status,
    ),
    el(
      'div',
      { class: 'stage-body' },
      el('aside', { class: 'stage-side' }, el('h3', {}, 'Placement'), placeBox, el('h3', {}, 'Inspect'), inspectBox, el('h3', {}, 'Sky'), skyBox, el('h3', {}, 'Fog'), fogBox, el('h3', {}, 'Download'), downloadBox, el('h3', {}, 'Layers'), layersBox),
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
    const saveSoon = debounce(() => store(edit.stage, edit.objects, edit.sky, fogFeatures(edit)), 250);

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
      const skyList = skyMeshes();
      const hasSky = skyList.length > 0;
      let far = toCentre + sceneRadius * 4 + 10;
      if (hasSky) far = Math.max(far, SKY_RADIUS * 1.05);
      vp = mul(perspective(FOV, w / h, near, far), lookAt(eye, f, r, u));
      viewW = canvas.clientWidth;
      viewH = canvas.clientHeight;
      gl.useProgram(prog.program);
      const U = prog.u;
      gl.uniformMatrix4fv(U.uViewProj, false, vp);
      gl.uniform3fv(U.uEye, eye);
      gl.uniform3fv(U.uFwd, f);
      const fogShown = edit.fogPreview && !!edit.fogStock && !!edit.fog?.Enable;
      if (fogShown) {
        gl.uniform3fv(U.uFogColor, fogRgb(edit.fog).map((v) => v / 255));
        gl.uniform2f(U.uFogRange, Math.max(0, edit.fog.Near), Math.max(edit.fog.Near + 1, edit.fog.Far));
      }
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
        gl.uniform1i(U.uFogOn, fogShown && !skyPass ? 1 : 0);
        for (const m of skyPass ? skyList : scene.meshes) {
          if (!m.visible || m.sky !== skyPass) continue;
          gl.bindVertexArray(meshGpu(m).vao);
          const useTex = (skyPass || texturesOn) && !!m.uvs;
          const s0 = selection?.mesh === m ? selection.first : 0, s1 = selection?.mesh === m ? selection.first + selection.count : 0;
          for (const b of m.batches) {
            const colour = useTex && b.texture ? (skyPass ? skyTexture(b.texture) : glTex.get(lower(b.texture))) : null;
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
      if (lineProg) drawCollision(vp, eye);
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
      step.action?.undo();
      edit.history.redo.push(step);
      edit.history.breakMerge();
      edited();
      status.textContent = `Undid: ${step.label}`;
    }
    function redo() {
      const step = edit.history.redo.pop();
      if (!step) return;
      for (const c of step.changes) apply(c.obj, c.after);
      step.action?.redo();
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
        el('p', { class: 'muted stage-col-info' }),
        el('div', { class: 'toolbar stage-tools' }, toolBtns),
        el('div', { class: 'stage-xyz' }, el('span'), head('X'), head('Y'), head('Z'), head('Offset'), fields.t, head('Rotate°'), fields.r, head('Scale'), fields.s),
        el('div', { class: 'stage-checks' }, el('label', { class: 'check', title: 'Scale handles scale all three axes (hold Shift for one)' }, uniformBox, ' Uniform'), hiddenLabel, solidLabel),
        el('div', { class: 'toolbar' }, button('Reset', () => placementKey({}, 'home'), { title: 'Undo every move, turn and scale of this object (Home)' }), undoBtn, redoBtn),
        countLine,
        fileRow,
      );
      syncPanel();
    }
    /** The selected object's collision, as the desktop's placement panel says it (CollisionSummary). */
    function collisionSummary(o) {
      const col = edit.colRead, m = edit.colMatch, st = o.state, shapeTris = Math.trunc(o.indexCount / 3);
      const lines = [];
      if (st.solid)
        lines.push(shapeTris > 100 ? 'Solid: collides as its bounding box' : `Solid: ${shapeTris.toLocaleString()} triangles generated from its shape`);
      if (!col) {
        if (!st.solid) lines.push('Reading the collision…');
      } else if (!col.live || m?.error) {
        if (!st.solid) lines.push(!col.layers.length ? 'This stage has no collision files.' : 'Collision here is view-only (unfamiliar layout).');
      } else if (!m?.owners) lines.push(`Collision: matching to objects… ${m?.pct ?? 0}%`);
      else {
        const own = (m.objTris[o.index]?.length ?? 0) / 9;
        lines.push(own ? `Collision: ${own.toLocaleString()} triangle${own === 1 ? '' : 's'} — moves with it` : `No collision of its own${st.solid ? '' : ' — tick Solid (K) to add'}`);
      }
      return lines.join('\n');
    }
    function renderColInfo() {
      const p = placeBox.querySelector('.stage-col-info'), o = selected();
      if (p && o) p.textContent = collisionSummary(o);
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
      renderColInfo();
    }

    function saveFile() {
      const file = editsFile(edit.stage, edit.objects, edit.sky, fogFeatures(edit));
      if (!Object.keys(file.Objects).length && !file.Sky && !file.Features) return toast('There are no edits to save yet.');
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
      // The file's sky, when it has one (a picture by name only: the one held here if the names match).
      const acts = [];
      let skyNote = '';
      const sky = cloneSky(res.sky);
      if (res.sky && !sameSky(sky, edit.sky)) {
        const picture = sky?.Mode === 'picture' ? (edit.skyPicture?.name === sky.Picture ? edit.skyPicture : null) : edit.skyPicture;
        const before = skyState(), after = { sky, picture };
        applySky(after);
        acts.push({ undo: () => applySky(before), redo: () => applySky(after) });
        skyNote = ` Sky: ${skyLabel(sky)}.`;
        if (sky?.Mode === 'picture' && !picture) skyNote += ' Choose the picture again in the Sky panel to see it.';
      }
      // The file's fog (a "fog" feature), and the features this page doesn't edit, kept as they are.
      const { fog: fileFog, ...rest } = res.features;
      Object.assign(edit.otherFeatures, rest);
      const fog = fogFromFeature(fileFog);
      if (fog && edit.fogStock && !sameFog(fog, edit.fog)) {
        const before = edit.fog;
        applyFog(fog);
        acts.push({ undo: () => applyFog(before), redo: () => applyFog(fog) });
        skyNote += ` Fog: ${fog.Enable ? `${metres(fog.Near)} → ${metres(fog.Far)}` : 'off'}.`;
      }
      const action = acts.length
        ? { undo: () => acts.slice().reverse().forEach((a) => a.undo()), redo: () => acts.forEach((a) => a.redo()) }
        : null;
      edit.history.push(changes, 'Load edits file', null, action);
      edit.history.breakMerge();
      edited();
      renderPanel();
      const missed = res.unmatched.length ? `; ${res.unmatched.length} not on this stage` : '';
      toast(`${f.name}: ${changes.length} object${changes.length === 1 ? '' : 's'} placed${missed}.${skyNote}`);
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
      store(edit.stage, edit.objects, edit.sky, fogFeatures(edit));
      if (edit.colMatch?.worker) {
        edit.colMatch.worker.terminate();
        edit.colMatch = null;
      } else if (edit.colMatch) edit.colMatch.onChange = null;
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

    // ----- sky (StageViewerForm.Sky.cs) -----
    const ownSky = scene.meshes.filter((m) => m.sky);
    const imgTex = new Map(); // decoded picture → its GL texture, uploaded when first drawn
    const skyOver = new Map(); // lower texture name → GL texture drawn in its place (the dome picture, clear clouds)
    let skyShown = ownSky, skyPackTextures = null, skyProblem = '', skyToken = 0, clearTex = null;
    const texOf = (img) => imgTex.get(img) || imgTex.set(img, uploadTexture(gl, img, aniso)).get(img);
    const meshGpu = (m) => gpu.get(m) || gpu.set(m, uploadMesh(gl, m)).get(m);
    /** The sky meshes to draw: another stage's while this stage's Sky layer is on, else this stage's visible ones. */
    function skyMeshes() {
      if (skyShown === ownSky) return ownSky.filter((m) => m.visible);
      return !ownSky.length || ownSky.some((m) => m.visible) ? skyShown : [];
    }
    function skyTexture(name) {
      const k = lower(name);
      const img = skyPackTextures?.get(k);
      return skyOver.get(k) || (img ? texOf(img) : glTex.get(k)) || null;
    }
    /** Another stage's sky, read once per scene from its bundle among the open files. */
    function skyPack(id) {
      const packs = scene.skyPacks || (scene.skyPacks = new Map());
      const key = id.toLowerCase();
      let job = packs.get(key);
      if (!job) {
        const src = ctx.stageBundles?.().find((b) => b.id.toLowerCase() === key);
        if (!src) return Promise.reject(new Error(`stage ${id} isn't among the open files (open the Data folder to use another stage's sky)`));
        job = src
          .read()
          .then((bytes) => readSkyPack(src.id, bytes))
          .then((pack) => {
            for (const m of pack.meshes) Object.assign(m, { sky: true, kind: 'sky', visible: true, positions: unitDirections(m.positions) });
            return pack;
          });
        job.catch(() => packs.delete(key));
        packs.set(key, job);
      }
      return job;
    }
    /** The dome's picture for the setting: a preset's, or your picture when it is here. */
    function domeImage(s) {
      if (s?.Mode === 'preset') {
        const p = SKY_PRESETS.find((x) => x.name === s.Preset);
        if (!p) return null;
        if (!presetDomes.has(p.name)) presetDomes.set(p.name, presetSky(p));
        return presetDomes.get(p.name);
      }
      if (s?.Mode === 'picture') return edit.skyPicture?.name === s.Picture ? edit.skyPicture : null;
      return null;
    }
    /** Shows the sky setting in the view: another stage's meshes and textures, the dome picture, clear clouds (ApplySkyPreview). */
    async function showSky() {
      const token = ++skyToken;
      const s = edit.sky;
      let pack = null, problem = '';
      if (s?.Mode === 'stage') {
        try {
          pack = await skyPack(s.Stage);
        } catch (e) {
          problem = `Stage ${s.Stage}'s sky can't be shown: ${e.message}.`;
        }
        if (token !== skyToken || stopped) return;
      } else if (s?.Mode === 'dungeon') problem = 'Happy Dungeons skies need the desktop HappyTool (they come from the Happy Dungeons game folder).';
      const shown = pack ? pack.meshes : ownSky;
      const roles = textureRoles(shown);
      skyOver.clear();
      const dome = domeImage(s);
      if (s?.Mode === 'picture' && !dome) problem = `The picture ${s.Picture} isn't here: choose it again to see it.`;
      if (dome && roles.dome) skyOver.set(lower(roles.dome), texOf(dome));
      if (s?.HideClouds) {
        clearTex ||= uploadTexture(gl, { width: 4, height: 4, rgba: new Uint8Array(64) }, null);
        for (const c of roles.clouds) skyOver.set(lower(c), clearTex);
      }
      skyShown = shown;
      skyPackTextures = pack?.textures ?? null;
      skyProblem = problem;
      dirty = true;
      renderSky();
    }
    const skyState = () => ({ sky: cloneSky(edit.sky), picture: edit.skyPicture });
    /** Puts a sky state in place (set, undo, redo): keeps it in this browser and shows it. */
    function applySky(st) {
      edit.sky = cloneSky(st.sky);
      edit.skyPicture = st.picture;
      const keep = edit.sky?.Mode === 'picture' ? edit.skyPicture : null;
      if (keep !== edit.storedPicture) {
        if (!storePicture(edit.stage, keep)) toast('The sky picture is too big to keep in this browser; it stays until you close the map.', 'error');
        edit.storedPicture = keep;
      }
      saveSoon();
      showSky();
      renderDownload();
    }
    /** Changes the sky as one undo step (SetSky). */
    function setSky(next, label, picture = edit.skyPicture) {
      const before = skyState(), after = { sky: cloneSky(next), picture };
      if (sameSky(before.sky, after.sky) && before.picture === after.picture) return renderSky();
      applySky(after);
      edit.history.push([], label, null, { undo: () => applySky(before), redo: () => applySky(after) });
      syncPanel();
    }
    /** Keeps the clouds setting when the sky changes, hiding them by default for a picture (WithMode). */
    const withMode = (mode, fields) => ({ Mode: mode, ...fields, HideClouds: edit.sky ? !!edit.sky.HideClouds : mode === 'picture' });

    const skySelect = el('select', { class: 'input input-sm', 'aria-label': 'Sky' });
    const cloudsBox = el('input', { type: 'checkbox' });
    const skyLine = el('p', { class: 'muted stage-count' });
    const skyNote = el('p', { class: 'muted stage-count' });
    skySelect.addEventListener('change', async () => {
      const v = skySelect.value;
      if (v === 'own') return setSky(edit.sky?.HideClouds ? { HideClouds: true } : null, "Sky: this stage's own");
      if (v.startsWith('preset:')) return setSky(withMode('preset', { Preset: v.slice(7) }), `Sky: ${v.slice(7)}`);
      if (v.startsWith('stage:')) return setSky(withMode('stage', { Stage: v.slice(6) }), `Sky: stage ${v.slice(6)}`);
      if (v === 'picture' && edit.skyPicture) return setSky(withMode('picture', { Picture: edit.skyPicture.name }), `Sky picture: ${edit.skyPicture.name}`);
      // A new picture (ChooseSkyPicture): clouds hidden, as the desktop does.
      const [f] = await pickFiles({ accept: 'image/*' });
      if (!f) return renderSky();
      try {
        const pic = { name: f.name, ...(await pictureSky(f)) };
        setSky({ ...withMode('picture', { Picture: f.name }), HideClouds: true }, `Sky picture: ${f.name}`, pic);
      } catch (e) {
        toast(`That picture can't be read: ${e.message}`, 'error');
        renderSky();
      }
    });
    cloudsBox.addEventListener('change', () => {
      const s = cloneSky(edit.sky) || {};
      s.HideClouds = cloudsBox.checked;
      setSky(!s.Mode && !s.HideClouds ? null : s, cloudsBox.checked ? 'Hide clouds' : 'Show clouds');
    });
    function renderSky() {
      const s = edit.sky;
      const opt = (value, label) => el('option', { value }, label);
      const others = (ctx.stageBundles?.() ?? []).map((b) => b.id).filter((id) => id.toLowerCase() !== edit.stage.toLowerCase());
      if (s?.Mode === 'stage' && !others.some((id) => id.toLowerCase() === s.Stage.toLowerCase())) others.push(s.Stage);
      others.sort((a, b) => a.localeCompare(b));
      skySelect.replaceChildren(
        opt('own', "This stage's own"),
        el('optgroup', { label: 'Colours' }, SKY_PRESETS.map((p) => opt(`preset:${p.name}`, p.name))),
        el(
          'optgroup',
          { label: 'Your picture' },
          edit.skyPicture ? opt('picture', `Picture: ${edit.skyPicture.name}`) : null,
          opt('picture:new', edit.skyPicture ? 'Another picture…' : 'Choose a picture…'),
        ),
        others.length
          ? el('optgroup', { label: "Another stage's sky" }, others.map((id) => opt(`stage:${id}`, id)))
          : el('optgroup', { label: "Another stage's sky: open the Data folder" }),
      );
      skySelect.value =
        s?.Mode === 'preset' ? `preset:${s.Preset}` : s?.Mode === 'stage' ? `stage:${s.Stage}` : s?.Mode === 'picture' && edit.skyPicture?.name === s.Picture ? 'picture' : 'own';
      if (skySelect.selectedIndex < 0) skySelect.value = 'own';
      cloudsBox.checked = !!s?.HideClouds;
      skyLine.textContent = skyLabel(s);
      skyNote.textContent = skyProblem;
      skyNote.hidden = !skyProblem;
      if (!skyBox.contains(skySelect))
        skyBox.replaceChildren(
          skyLine,
          skySelect,
          el('label', { class: 'check', title: 'Make the cloud textures clear (the download writes them clear)' }, cloudsBox, ' Hide clouds'),
          skyNote,
        );
    }
    // ----- fog (StageViewerForm.Fog.cs) -----
    const fogLine = el('p', { class: 'muted stage-count' });
    const fogShowBox = el('input', { type: 'checkbox' });
    const fogOnBox = el('input', { type: 'checkbox' });
    const fogNear = el('input', { type: 'number', class: 'input input-sm', min: '0', step: '10', 'aria-label': 'Fog starts at, in metres' });
    const fogFar = el('input', { type: 'number', class: 'input input-sm', min: '10', step: '10', 'aria-label': 'Fog full at, in metres' });
    const fogColour = el('input', { type: 'color', 'aria-label': 'Fog colour' });
    const fogStages = el('select', { class: 'input input-sm', 'aria-label': "Take another stage's fog" });
    const fogOwnBtn = button("Back to this stage's own", () => setFog(edit.fogStock, "Stage's own fog"));
    let fogRead = false;
    function fogSummary() {
      const f = edit.fog, changed = fogChanged(edit) ? ' · changed' : '';
      return f.Enable ? `${metres(f.Near)} → ${metres(f.Far)}${changed}${edit.fogPreview ? ' · shown' : ''}` : `off${changed}`;
    }
    /** Puts a fog value in place (set, undo, redo): keeps it in this browser and redraws. */
    function applyFog(v) {
      edit.fog = v;
      saveSoon();
      dirty = true;
      renderFog();
      renderDownload();
    }
    /** Changes the fog as one undo step; steps of the same kind (kind) merge, as the desktop's SetFog does. */
    function setFog(next, label, kind = null) {
      if (!edit.fogStock || sameFog(next, edit.fog)) return renderFog();
      const action = {
        before: edit.fog,
        after: next,
        undo() { applyFog(this.before); },
        redo() { applyFog(this.after); },
        merge(o) { this.after = o.after; return true; },
        drop() { return sameFog(this.before, this.after); },
      };
      applyFog(next);
      edit.history.push([], label, kind, action);
      syncPanel();
    }
    fogShowBox.addEventListener('change', () => {
      edit.fogPreview = fogShowBox.checked;
      setFogPreview(edit.fogPreview);
      dirty = true;
      renderFog();
    });
    fogOnBox.addEventListener('change', () => {
      const f = edit.fog;
      setFog(makeFog(fogOnBox.checked, f.Near, f.Far, f.Color), fogOnBox.checked ? 'Fog on' : 'Fog off');
    });
    fogNear.addEventListener('change', () => {
      const f = edit.fog, m = Number(fogNear.value);
      if (fogNear.value === '' || !Number.isFinite(m)) return renderFog();
      setFog(makeFog(f.Enable, Math.max(0, Math.min(f.Far - 1000, Math.round(m) * 100)), f.Far, f.Color), 'Fog start', 'fog-near');
    });
    fogFar.addEventListener('change', () => {
      const f = edit.fog, m = Number(fogFar.value);
      if (fogFar.value === '' || !Number.isFinite(m)) return renderFog();
      setFog(makeFog(f.Enable, f.Near, Math.max(f.Near + 1000, Math.round(m) * 100), f.Color), 'Fog distance', 'fog-far');
    });
    fogColour.addEventListener('change', () => setFog(withHex(edit.fog, fogColour.value), 'Fog colour'));
    fogStages.addEventListener('change', async () => {
      const id = fogStages.value;
      fogStages.value = '';
      if (!id) return;
      const src = ctx.stageBundles?.().find((b) => b.id === id);
      if (!src) return toast(`${id} isn't among the open files.`);
      try {
        const fog = await readFogFromFile(await src.read());
        if (stopped) return;
        if (!fog) return toast(`No fog found in ${id}.`, 'error');
        setFog(fog, `${id}'s fog`);
        if (!edit.fogPreview) {
          edit.fogPreview = true;
          setFogPreview(true);
          dirty = true;
          renderFog();
        }
        toast(`Fog of ${id}: ${fogSummary()}`);
      } catch (e) {
        toast(`No fog found in ${id}: ${e.message}`, 'error');
      }
    });
    function renderFog() {
      if (!edit.fogStock) {
        fogBox.replaceChildren(el('p', { class: 'muted' }, fogRead ? "This stage has no fog settings to read (StageCameraParam.json)." : 'Reading the fog…'));
        return;
      }
      const f = edit.fog, own = edit.fogStock;
      fogLine.textContent = `This stage's own: ${own.Enable ? `${metres(own.Near)} → ${metres(own.Far)}` : 'off'}. Now: ${fogSummary()}`;
      fogShowBox.checked = edit.fogPreview;
      fogOnBox.checked = f.Enable;
      fogNear.value = String(Math.round(f.Near / 100));
      fogFar.value = String(Math.round(f.Far / 100));
      fogColour.value = fogHex(f);
      fogOwnBtn.disabled = !fogChanged(edit);
      const others = (ctx.stageBundles?.() ?? []).map((b) => b.id).filter((id) => id.toLowerCase() !== edit.stage.toLowerCase());
      others.sort((a, b) => a.localeCompare(b));
      fogStages.replaceChildren(
        el('option', { value: '' }, others.length ? "Take another stage's fog…" : "Another stage's fog: open the Data folder"),
        ...others.map((id) => el('option', { value: id }, id)),
      );
      fogStages.disabled = !others.length;
      if (!fogBox.contains(fogOnBox))
        fogBox.replaceChildren(
          fogLine,
          el('label', { class: 'check', title: "Draw the fog over the map as the game does (the sky stays clear). Only a preview: it doesn't change the map." }, fogShowBox, ' Show it here'),
          el('label', { class: 'check', title: 'Whether the game draws fog on this map' }, fogOnBox, ' Fog in the game'),
          el('label', { class: 'stage-fog-row', title: 'Closer than this the air is clear' }, 'Starts at', fogNear, 'm'),
          el('label', { class: 'stage-fog-row', title: "From here on everything is the fog's colour (the game draws nothing beyond the camera's far clip)" }, 'Full at', fogFar, 'm'),
          el('label', { class: 'stage-fog-row', title: 'The colour far-away things fade into' }, 'Colour', fogColour),
          fogStages,
          el('div', { class: 'toolbar' }, fogOwnBtn),
        );
    }
    readFog(model).then(
      (stock) => {
        if (stopped) return;
        fogRead = true;
        edit.fogStock = stock;
        if (stock) edit.fog = edit.storedFog || stock;
        dirty = true;
        renderFog();
        renderDownload();
      },
      (e) => {
        fogRead = true;
        console.warn(`Map editor: the fog of ${edit.stage} could not be read: ${e.message}`);
        renderFog();
      },
    );

    // ----- download (the sky and fog written into a copy of the bundle, as the desktop export does) -----
    const downloadNote = el('p', { class: 'muted stage-count' });
    const bakeBtn = button('Download bundle', bakeBundle, {
      title: "Write the sky and fog into a copy of the stage bundle, as the desktop export does (object placement isn't written yet)",
    });
    function bakeParts() {
      const parts = [];
      if (edit.sky && edit.sky.Mode !== 'dungeon') parts.push('sky');
      if (fogChanged(edit)) parts.push('fog');
      return parts;
    }
    function renderDownload() {
      const parts = bakeParts();
      downloadNote.textContent = parts.length
        ? `Writes the ${parts.join(' and ')} into a copy of ${edit.stage}.bres. Object placement isn't written yet: keep it with Save edits.`
        : 'Change the sky or fog to write them into a copy of the bundle.';
      bakeBtn.disabled = !parts.length;
      if (!downloadBox.contains(bakeBtn)) downloadBox.replaceChildren(downloadNote, el('div', { class: 'toolbar' }, bakeBtn));
    }
    /** Downloads a copy of the bundle with the sky (ApplySkyToBundle) and fog (FogExport) written in. */
    async function bakeBundle() {
      const parts = bakeParts();
      if (!parts.length) return toast('Change the sky or fog first.');
      bakeBtn.disabled = true;
      const was = status.textContent;
      try {
        let archive = model;
        const lines = [];
        if (parts.includes('sky')) {
          const s = edit.sky;
          const pack = s.Mode === 'stage' ? await skyPack(s.Stage) : null;
          const dome = domeImage(s);
          if (s.Mode === 'picture' && !dome) throw new Error(`the sky picture ${s.Picture} isn't here; choose it again`);
          status.textContent = 'Writing the bundle…';
          await pause();
          const domeDds = dome ? encodeDxt1Dds(dome.width, dome.height, dome.rgba) : null;
          const r = await bakeSky(archive, s, pack, textureRoles(pack ? pack.meshes : ownSky), domeDds);
          archive = r.archive;
          lines.push(r.summary);
        }
        if (parts.includes('fog')) {
          const r = await bakeFog(archive, edit.fog);
          archive = r.archive;
          lines.push(r.summary);
        }
        status.textContent = 'Writing the bundle…';
        await pause();
        const bytes = await encodeLayers(writeBres(archive), writableLayers(node.layers || []));
        downloadBytes(bytes, `${edit.stage}.bres`);
        toast(`${edit.stage}.bres downloaded. ${lines.join(' ')} Object placement isn't written into it yet: keep it with Save edits.`, 'ok', 10000);
      } catch (e) {
        toast(`The bundle could not be written: ${e.message}`, 'error', 10000);
      } finally {
        status.textContent = was;
        renderDownload();
      }
    }
    renderFog();
    renderDownload();

    // ----- collision (CcpCollisionParser: every .ccp layer, drawn as lines; key H) -----
    let lineProg = null;
    try {
      lineProg = compile(gl, LINE_VS, LINE_FS, ['uViewProj', 'uEye', 'uColor']);
    } catch (e) {
      console.warn(`Map editor: the collision lines can't be drawn: ${e.message}`);
    }
    // Colours as on the desktop (StageViewerForm.Collision.cs).
    const COL_OWNED = [0.15, 1, 0.35], COL_STAGE = [0.35, 0.75, 1], COL_MOVED = [0.75, 1, 0.55], COL_SOLID = [1, 0.6, 0.15];
    const COL_SELECTED = [1, 1, 0.45];
    /** Above this many triangles a Solid object collides as its bounding box instead of its own triangles. */
    const SOLID_BOX_THRESHOLD = 100;
    const BOX_TRIS = [0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5, 2, 6, 7, 2, 7, 3, 0, 1, 5, 0, 5, 4];
    const BOX_TOP = [2, 6, 7, 2, 7, 3];
    const colGpu = []; // per layer: {pos, main: owned triangles left in place (all before matching), stage: unowned}
    let colRead = null; // {layers, unread, live} once read
    let staticKey = null; // the displaced or hidden owners when main was last built
    const dyn = { vao: null, buf: null, a: 0, b: 0, key: [] }; // moved objects' collision, then Solid shapes
    const sel = { vao: null, buf: null, a: 0, b: 0, key: [] }; // the selected object's collision, then its Solid shape
    const solidCache = new Map();
    colBox.checked = !!job.showCollision;
    const displaced = (st) => st.hidden || !isIdentityTransform(st);
    const sameList = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
    const matchDone = () => (edit.colMatch?.owners ? edit.colMatch : null);

    function layerVao(pos) {
      const vao = gl.createVertexArray(), ebo = gl.createBuffer();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, pos);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
      gl.bindVertexArray(null);
      return { vao, ebo, count: 0 };
    }
    function setEdges(part, edges) {
      gl.bindVertexArray(part.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, part.ebo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, edges, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      part.count = edges.length;
    }
    /** Uploads each layer's vertices and edge list once read (UploadCollision). */
    function uploadCollision(col) {
      for (const l of col.layers) {
        const pos = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, pos);
        gl.bufferData(gl.ARRAY_BUFFER, l.positions, gl.STATIC_DRAW);
        const g = { pos, main: layerVao(pos), stage: layerVao(pos) };
        setEdges(g.main, l.edges);
        colGpu.push(g);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    /** A line list's buffers get the lines of a, then of b (a and b: x, y, z per line end). */
    function fillLines(list, a, b) {
      if (!list.vao) {
        list.vao = gl.createVertexArray();
        list.buf = gl.createBuffer();
        gl.bindVertexArray(list.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, list.buf);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
      }
      const data = new Float32Array(a.length + b.length);
      data.set(a);
      data.set(b, a.length);
      gl.bindBuffer(gl.ARRAY_BUFFER, list.buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      list.a = a.length / 3;
      list.b = b.length / 3;
    }
    /** Where a stock point lands under a placement, as the object's vertices do (placePoint, rotation worked out once). */
    function placer(st, pv) {
      const R = rotation(st.r), t = st.t, s = st.s;
      return (out, at, x, y, z) => {
        const a = (x - pv[0]) * s[0], b = (y - pv[1]) * s[1], c = (z - pv[2]) * s[2];
        out[at] = R[0] * a + R[1] * b + R[2] * c + pv[0] + t[0];
        out[at + 1] = R[3] * a + R[4] * b + R[5] * c + pv[1] + t[1];
        out[at + 2] = R[6] * a + R[7] * b + R[8] * c + pv[2] + t[2];
      };
    }
    /** Adds the edges of triangles (9 floats each, stock) as placed lines. */
    function addLines(out, tris, place) {
      const p = new Float32Array(9);
      for (let i = 0; i + 8 < tris.length; i += 9) {
        place(p, 0, tris[i], tris[i + 1], tris[i + 2]);
        place(p, 3, tris[i + 3], tris[i + 4], tris[i + 5]);
        place(p, 6, tris[i + 6], tris[i + 7], tris[i + 8]);
        out.push(p[0], p[1], p[2], p[3], p[4], p[5], p[3], p[4], p[5], p[6], p[7], p[8], p[6], p[7], p[8], p[0], p[1], p[2]);
      }
    }
    /** What a Solid object collides as, stock (SolidShape): its own triangles, or past 100 its bounding box. */
    function solidOf(o) {
      let tris = solidCache.get(o);
      if (tris) return tris;
      const P = o.mesh.baked?.positions ?? o.mesh.positions, I = o.mesh.indices, n = Math.trunc(o.indexCount / 3);
      if (n <= SOLID_BOX_THRESHOLD) {
        tris = new Float32Array(n * 9);
        for (let i = 0; i < n * 3; i++) {
          const v = I[o.firstIndex + i] * 3;
          tris[i * 3] = P[v];
          tris[i * 3 + 1] = P[v + 1];
          tris[i * 3 + 2] = P[v + 2];
        }
      } else {
        const { min, max } = boundsOf(P, o.firstVertex, o.vertexCount);
        const idx = max[1] - min[1] < 1 ? BOX_TOP : BOX_TRIS; // flat: its top only
        tris = new Float32Array(idx.length * 3);
        idx.forEach((k, i) => tris.set([k & 1 ? max[0] : min[0], k & 2 ? max[1] : min[1], k & 4 ? max[2] : min[2]], i * 3));
      }
      solidCache.set(o, tris);
      return tris;
    }
    /** Rebuilds the in-place lists when an owner starts or stops being moved or hidden (owned: green; unowned: blue). */
    function syncStatic(m) {
      const key = m.ownerList.filter((i) => displaced(edit.objects[i].state)).join(',');
      if (key === staticKey) return;
      const first = staticKey === null;
      staticKey = key;
      const off = new Set(key ? key.split(',').map(Number) : []);
      colRead.layers.forEach((l, li) => {
        const own = m.owners[li], I = l.indices, keep = [], stage = [];
        for (let t = 0; t < own.length; t++) {
          const o = own[t];
          if (o < 0) {
            if (first) stage.push(I[t * 3], I[t * 3 + 1], I[t * 3 + 2]);
          } else if (!off.has(o)) keep.push(I[t * 3], I[t * 3 + 1], I[t * 3 + 2]);
        }
        setEdges(colGpu[li].main, edgesOf(keep));
        if (first) setEdges(colGpu[li].stage, edgesOf(stage));
      });
    }
    /** Moved objects' collision placed with them (pale green) and Solid objects' shapes (orange); hidden ones draw nothing. */
    function syncDyn(m) {
      const list = [m];
      for (const o of edit.objects) {
        const st = o.state;
        if (!st.hidden && (st.solid || (m?.objTris[o.index] && !isIdentityTransform(st)))) list.push(o, st);
      }
      if (sameList(list, dyn.key)) return;
      dyn.key = list;
      const a = [], b = [];
      for (let i = 1; i < list.length; i += 2) {
        const o = list[i], st = list[i + 1], place = placer(st, o.pivot), tris = m?.objTris[o.index];
        if (tris && !isIdentityTransform(st)) addLines(a, tris, place);
        if (st.solid) addLines(b, solidOf(o), place);
      }
      fillLines(dyn, a, b);
    }
    function syncSel(m, o) {
      const st = o.state, key = [m, o, st];
      if (sameList(key, sel.key)) return;
      sel.key = key;
      const a = [], b = [];
      if (!st.hidden) {
        const place = placer(st, o.pivot);
        if (m?.objTris[o.index]) addLines(a, m.objTris[o.index], place);
        if (st.solid) addLines(b, solidOf(o), place);
      }
      fillLines(sel, a, b);
    }
    /** The collision over the map (DrawLiveCollision), depth-tested; the selected object's on top, in yellow. */
    function drawCollision(vp, eye) {
      const on = colBox.checked && colGpu.length > 0, o = selected();
      if (!on && !o) return;
      const m = matchDone();
      const colour = (c) => gl.uniform4f(lineProg.u.uColor, c[0], c[1], c[2], 1);
      gl.useProgram(lineProg.program);
      gl.uniformMatrix4fv(lineProg.u.uViewProj, false, vp);
      gl.uniform3fv(lineProg.u.uEye, eye);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(false);
      if (on) {
        if (m) syncStatic(m);
        syncDyn(m);
        colour(COL_OWNED);
        for (const g of colGpu) {
          gl.bindVertexArray(g.main.vao);
          gl.drawElements(gl.LINES, g.main.count, gl.UNSIGNED_INT, 0);
        }
        if (m) {
          colour(COL_STAGE);
          for (const g of colGpu) {
            if (!g.stage.count) continue;
            gl.bindVertexArray(g.stage.vao);
            gl.drawElements(gl.LINES, g.stage.count, gl.UNSIGNED_INT, 0);
          }
        }
        gl.bindVertexArray(dyn.vao);
        if (dyn.a) {
          colour(COL_MOVED);
          gl.drawArrays(gl.LINES, 0, dyn.a);
        }
        if (dyn.b) {
          colour(COL_SOLID);
          gl.drawArrays(gl.LINES, dyn.a, dyn.b);
        }
      }
      if (o) {
        syncSel(m, o);
        if (sel.a + sel.b) {
          gl.disable(gl.DEPTH_TEST);
          colour(COL_SELECTED);
          gl.bindVertexArray(sel.vao);
          gl.drawArrays(gl.LINES, 0, sel.a + sel.b);
          gl.enable(gl.DEPTH_TEST);
        }
      }
      gl.depthMask(true);
      gl.useProgram(prog.program);
    }
    /** Each object's collision triangles (9 floats each, stock) from the owners, and the desktop's log line. */
    function buildObjTris(col, m, owners) {
      const n = edit.objects.length, count = new Int32Array(n), fill = new Int32Array(n);
      let total = 0, owned = 0;
      for (const own of owners) {
        total += own.length;
        for (const o of own)
          if (o >= 0) {
            count[o]++;
            owned++;
          }
      }
      const objTris = new Array(n).fill(null), ownerList = [];
      for (let i = 0; i < n; i++)
        if (count[i]) {
          objTris[i] = new Float32Array(count[i] * 9);
          ownerList.push(i);
        }
      col.layers.forEach((l, li) => {
        const own = owners[li], P = l.positions, I = l.indices;
        for (let t = 0; t < own.length; t++) {
          const o = own[t];
          if (o < 0) continue;
          const out = objTris[o];
          for (let k = 0; k < 3; k++) {
            const v = I[t * 3 + k] * 3;
            out[fill[o]++] = P[v];
            out[fill[o]++] = P[v + 1];
            out[fill[o]++] = P[v + 2];
          }
        }
      });
      Object.assign(m, { owners, objTris, ownerList, owned, total, pct: 100 });
      console.info(`Map editor: live collision: ${owned} of ${total} triangles matched to ${ownerList.length} objects in ${m.ms} ms`);
    }
    /** Matches the collision to the objects in a worker, once per stage (StartOwnerMatching); kept while the page lives. */
    function startMatching(col) {
      if (!col.live) return;
      let m = edit.colMatch;
      if (!m) {
        m = edit.colMatch = { pct: 0, owners: null, objTris: null, ownerList: null, owned: 0, total: 0, ms: 0, error: null, worker: null, onChange: null };
        const meshes = [], at = new Map(), objects = new Int32Array(edit.objects.length * 3);
        edit.objects.forEach((o, i) => {
          if (!at.has(o.mesh)) {
            at.set(o.mesh, meshes.length);
            meshes.push({ positions: o.mesh.baked?.positions ?? o.mesh.positions, indices: o.mesh.indices });
          }
          objects[i * 3] = at.get(o.mesh);
          objects[i * 3 + 1] = o.firstIndex;
          objects[i * 3 + 2] = o.indexCount;
        });
        const layers = col.layers.map((l) => ({
          groups: l.groups.map((g) => ({ vertices: g.vertices, triangles: g.triangles, minX: g.minX, minY: g.minY, minZ: g.minZ, maxX: g.maxX, maxY: g.maxY, maxZ: g.maxZ })),
        }));
        const fail = (msg) => {
          m.worker?.terminate();
          m.worker = null;
          m.error = msg;
          console.warn(`Map editor: the collision couldn't be matched to objects: ${msg}`);
          m.onChange?.();
        };
        try {
          const w = (m.worker = new Worker(new URL('./stage-collision-worker.js', import.meta.url), { type: 'module' }));
          w.onmessage = (ev) => {
            const d = ev.data;
            if (d.error) return fail(d.error);
            if (d.owners) {
              w.terminate();
              m.worker = null;
              m.ms = d.ms;
              buildObjTris(col, m, d.owners);
            } else m.pct = d.pct;
            m.onChange?.();
          };
          w.onerror = (e) => fail(e.message || 'the worker stopped');
          w.postMessage({ layers, meshes, objects });
        } catch (e) {
          fail(e.message);
        }
      }
      m.onChange = () => {
        if (stopped) return;
        staticKey = null;
        dyn.key = [];
        sel.key = [];
        renderCollision();
        renderColInfo();
        dirty = true;
      };
    }
    function renderCollision() {
      const col = colRead, n = col?.layers.length ?? 0;
      const tris = n ? col.layers.reduce((s, l) => s + l.triangles, 0) : 0;
      const notRead = col?.unread.length ? ` Not read: ${col.unread.join(', ')}.` : '';
      colBox.disabled = !n || !lineProg;
      colLabel.classList.toggle('muted', colBox.disabled);
      if (!col) colLabel.title = 'Reading the collision…';
      else if (!n) colLabel.title = `No collision (.ccp) in this stage.${notRead}`;
      else if (!lineProg) colLabel.title = "This browser couldn't set up the collision lines.";
      else {
        const m = edit.colMatch;
        const how = !col.live
          ? " It's view-only here (an unfamiliar layout), so it doesn't follow moved objects."
          : m?.error
            ? " It couldn't be matched to objects, so it doesn't follow moved objects."
            : m?.owners
              ? ` ${m.owned.toLocaleString()} triangles belong to ${m.ownerList.length.toLocaleString()} objects and follow them: green stays put, pale green has moved, blue is the stage's own, orange is Solid objects, yellow is the selected object's.`
              : ` Matching it to objects… ${m?.pct ?? 0}%`;
        colLabel.title =
          `Show the stage's collision (H): ${n} layer${n === 1 ? '' : 's'}, ${tris.toLocaleString()} triangles ` +
          `(${col.layers.map((l) => l.name).join(', ')}).${how}${notRead}`;
      }
    }
    function showCollision() {
      job.showCollision = colBox.checked;
      dirty = true;
    }
    function toggleCollision() {
      if (colBox.disabled) return toast(colLabel.title);
      colBox.checked = !colBox.checked;
      showCollision();
    }
    colBox.addEventListener('change', showCollision);
    (job.collision || (job.collision = readCollision(model))).then(
      (col) => {
        if (stopped) return;
        colRead = edit.colRead = col;
        uploadCollision(col);
        startMatching(col);
        renderCollision();
        renderColInfo();
        dirty = true;
      },
      (e) => {
        if (stopped) return;
        colRead = edit.colRead = { layers: [], unread: [], live: false };
        console.warn(`Map editor: the collision of ${edit.stage} could not be read: ${e.message}`);
        renderCollision();
        renderColInfo();
      },
    );
    renderCollision();
    renderSky();
    if (edit.sky) showSky();
    edit.pictureJob?.then(() => !stopped && showSky());

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
      else if (k === 'h') toggleCollision();
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
