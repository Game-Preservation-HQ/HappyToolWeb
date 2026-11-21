// Map viewer and editor: draws a Steam stage bundle with WebGL2 — terrain, models, prop packs and sky, colour
// textures on UV0 and baked lightmaps on UV1 — with an orbit/fly camera, layer toggles and click to inspect (slice 1),
// and moves, turns, scales and hides objects with a gizmo, keys and a placement panel (slice 2, see stage-edit.js).
// Lighting, lightmap modes and sky placement follow HappyTool/GUI/StageViewerForm.cs (InitGl, DrawMesh, sky pass).
// The sky can be swapped for another stage's, a picture or a colour preset (slice 3, see stage-sky.js).
// The stage's collision can be erased by hand and added to with walls, blocks, floors and ramps (see stage-colnav.js).
import { el, button, toast, downloadBlob, pickFiles, confirmBox, debounce } from '../ui.js';
import { decodeLayers, encodeLayers, writableLayers } from '../formats/wrappers.js';
import { writeBres } from '../formats/bres.js';
import {
  collectExportEdits,
  bakeEdits,
  patchCollision,
  dropStaleCollisionCopies,
  solidCollision,
  appendCollisionGroups,
  placementMatrix,
} from '../formats/stage-bake.js';
import { downloadBytes } from '../util.js';
import { stageGlb, stageObjZip } from '../formats/model-export.js';
import { setViewCommands } from '../palette.js';
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
import {
  loadGimmicks, stateOfPlacement, placementFromState, placementChanged, gimmickEdit, applyGimmickEdit, editedGimmickTable,
  gimmickTableBytes, placementMesh, newPlacement, newGimmickTag, newPlacementsOf,
} from './stage-gimmicks.js';
import { readNav, navLines, writeNavMesh, writePathGraph, is360Spd, spd360ToSteam } from '../formats/stage-nav.js';
import { rebuildNav, Blocker, MIN_REF, nodeRefKey, navSummary, navChanged, pathChanged } from '../formats/stage-nav-edit.js';
import {
  COLNAV_KEY, CN_SHAPES, CN_SIZES, CN_MIN_BRUSH, CN_MAX_BRUSH, readColNav, cloneColNav, colNavFeature, removedFlags,
  setRemovedFlags, volumeTriangles, rayTriangle, rayTris, eraseAt,
} from '../formats/stage-colnav.js';

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
  ['gimmick', 'Gimmicks'],
  ['sky', 'Sky'],
];

/** bres model → {promise, report, camera}: the built scene survives re-renders of the view. */
const jobs = new WeakMap();
const pause = () => new Promise((r) => setTimeout(r, 0));
/** Preset name → its dome picture, made once. */
const presetDomes = new Map();
/** Whether the fog differs from the stage's own (only then is it kept and written, as on the desktop). */
const fogChanged = (e) => !!e.fogStock && !!e.fog && !sameFog(e.fog, e.fogStock);
/**
 * The edits file's Features: other features kept as read, plus the fog when it is changed (or as stored, until read) and
 * the collision edits when there are any.
 */
function fogFeatures(e) {
  const out = { ...e.otherFeatures };
  const fog = e.fogStock ? (fogChanged(e) ? e.fog : null) : e.storedFog;
  if (fog) out.fog = { Enable: fog.Enable, Near: fog.Near, Far: fog.Far, Color: fog.Color };
  const cn = colNavFeature(e.colnav);
  if (cn) out[COLNAV_KEY] = cn;
  return Object.keys(out).length ? out : null;
}
const lower = (s) => (s ? s.toLowerCase() : s);
const shortName = (n) => n.replace(/\\/g, '/').split('/').slice(-2).join('/');

/** True for little-endian bundles that hold .rrm models (Steam stage bundles). */
export const looksLikeStage = (arc) => !!arc?.littleEndian && arc.entries.some((e) => /\.rrm$/i.test(e.name) && !e.pointer);

// ---------- scene ----------

async function loadScene(model, report, source = null) {
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
  // The stage's gimmicks, after the stage's own meshes so those keep their object numbers.
  let gimmicks = null;
  if (source?.dataFiles) {
    try {
      const kept = loadStored(stageKey(model.name));
      const saved = Array.isArray(kept?.Gimmicks) ? kept.Gimmicks : [];
      gimmicks = await loadGimmicks({ ids: source.ids, dataFiles: source.dataFiles, textures, report, saved });
      if (gimmicks) {
        for (const line of gimmicks.log) console.info(`Map viewer: ${line}`);
        meshes.push(...gimmicks.meshes);
      }
    } catch (e) {
      console.warn(`Map viewer: the gimmicks could not be read: ${e.message}`);
      gimmicks = null;
    }
  }
  for (const m of meshes) {
    m.sky = m.kind !== 'gimmick' && /sky/i.test(m.name);
    if (m.sky) m.kind = 'sky';
    m.normals = patchNormals(m.positions, m.indices, m.normals);
    if (m.sky) m.positions = unitDirections(m.positions);
    m.bounds = boundsOf(m.positions, 0, m.positions.length / 3);
    m.visible = true;
  }
  const solid = meshes.filter((m) => !m.sky && m.kind !== 'gimmick');
  return {
    meshes,
    gimmicks,
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
  return { vao, pos, nrm, ebo };
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

/** Where a ray enters a box {lo, hi} (0 when it starts inside), or -1 when it misses (RayHitsBox). */
function boxEnter(o, d, lo, hi) {
  let t0 = 0, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) {
      if (o[k] < lo[k] || o[k] > hi[k]) return -1;
      continue;
    }
    let a = (lo[k] - o[k]) / d[k], c = (hi[k] - o[k]) / d[k];
    if (a > c) [a, c] = [c, a];
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t0 > t1) return -1;
  }
  return t0;
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
  const k = best.mesh.triObject ? best.mesh.triObject[best.tri] : -1;
  best.object = k >= 0 ? best.mesh.editObjects[k] : null;
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
    colnav: readColNav(null), // collision erased by hand and pieces added (the "colnav" feature)
    fogPreview: fogPreviewOn(),
  };
  // Gimmicks: pivot at the table's position, the stock state its rotation (and removal), so the state reads back as the
  // placement. Their meshes are placed by their state when the view starts.
  edit.gimmickOther = []; // Gimmicks entries of the edits file for other seasons or placements not shown, kept as read
  for (const o of edit.objects) if (o.mesh.gimmick) setUpGimmick(o);
  const stored = loadStored(edit.stage);
  if (stored) {
    try {
      const res = readEditsFile(stored, edit.objects);
      for (const c of res.changed) {
        c.obj.pivot = c.pivot;
        c.obj.state = c.after;
        writeObject(c.obj);
        edit.restored++;
      }
      for (const c of readGimmickEdits(edit, res.gimmicks)) {
        c.obj.state = c.after;
        edit.restored++;
      }
    } catch (e) {
      console.warn(`Map editor: the edits kept for ${edit.stage} could not be read: ${e.message}`);
    }
    edit.sky = cloneSky(stored.Sky);
    if (stored.Features && typeof stored.Features === 'object' && !Array.isArray(stored.Features)) {
      const { fog, [COLNAV_KEY]: cn, ...rest } = stored.Features;
      edit.storedFog = fogFromFeature(fog);
      edit.colnav = readColNav(cn);
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

/** A gimmick object: pivot at the table's position, its stock state the table's rotation and removal. */
function setUpGimmick(o) {
  const g = o.mesh.gimmick;
  o.gimmick = g;
  o.pivot = g.position0.slice();
  o.label = `${g.type} · ${g.tag}`;
  o.stock = stateOfPlacement({ ...g, position: g.position0, rotation: g.rotation0, removed: g.removed0 });
  o.state = o.stock;
}

/** Whether an object differs from the stage files (a gimmick: from its table). */
const isEdited = (o) => (o.gimmick ? placementChanged(placementFromState(o)) : !isEmpty(o.state));

/** The edits file's Gimmicks list: the placements that differ from the table, and the entries kept as read. */
function gimmickEdits(edit) {
  const out = [...(edit.gimmickOther ?? [])];
  for (const o of edit.objects) {
    if (!o.gimmick) continue;
    const e = gimmickEdit(placementFromState(o));
    if (e) out.push(e);
  }
  return out.length ? out : null;
}

/**
 * Reads an edits file's Gimmicks entries onto the gimmicks (by tag, this season's only): returns the objects whose
 * state changes; the others are kept as read (ApplyGimmickEdit).
 */
function readGimmickEdits(edit, list) {
  const changes = [];
  for (const s of list) {
    if (typeof s.Tag !== 'string') continue;
    const season = s.Season ?? null;
    const objs = season == null ? edit.objects.filter((o) => o.gimmick && o.gimmick.tag === s.Tag) : [];
    if (!objs.length) {
      edit.gimmickOther = edit.gimmickOther.filter((x) => !(x.Tag === s.Tag && (x.Season ?? null) === season));
      edit.gimmickOther.push(s);
      continue;
    }
    for (const o of objs) {
      const g = placementFromState(o), copy = { ...g, position: g.position.slice(), rotation: g.rotation.slice() };
      applyGimmickEdit(copy, s);
      const after = stateOfPlacement(copy);
      if (!sameState(o.state, after)) changes.push({ obj: o, before: o.state, after });
    }
  }
  return changes;
}

// ---------- view ----------

/** The map view of a stage bundle node. ctx.back returns to the entry list. */
export function renderStage(node, ctx) {
  const model = node.model;
  let job = jobs.get(model);
  const status = el('span', { class: 'muted stage-status' }, 'Reading the stage…');
  if (!job) {
    job = { report: null, camera: null };
    const id = stageKey(model.name);
    const ids = [...new Set([id, id.replace(/_harness$/i, ''), ctx.filePath ? stageKey(ctx.filePath) : null].filter(Boolean))];
    job.promise = loadScene(model, (t) => job.report?.(t), { ids, dataFiles: ctx.dataFiles });
    jobs.set(model, job);
  }
  job.report = (t) => (status.textContent = t);

  const layersBox = el('div', { class: 'stage-layers' });
  const placeBox = el('div', { class: 'stage-place' }, el('p', { class: 'muted' }, 'Reading the stage…'));
  const inspectBox = el('div', { class: 'stage-inspect' }, el('p', { class: 'muted' }, 'Click the map to select an object.'));
  const skyBox = el('div', { class: 'stage-sky' }, el('p', { class: 'muted' }, 'Reading the stage…'));
  const fogBox = el('div', { class: 'stage-sky stage-fog' }, el('p', { class: 'muted' }, 'Reading the stage…'));
  const downloadBox = el('div', { class: 'stage-sky' }, el('p', { class: 'muted' }, 'Reading the stage…'));
  const modelBox = el('div', { class: 'stage-sky' }, el('p', { class: 'muted' }, 'Reading the stage…'));
  const gimmickBox = el('div', { class: 'stage-gimmicks' }, el('p', { class: 'muted' }, 'Reading the stage…'));
  const cnBox = el('div', { class: 'stage-sky stage-cn' }, el('p', { class: 'muted' }, 'Reading the stage…'));
  const canvas = el('canvas', { class: 'stage-canvas', tabindex: '0', 'aria-label': 'Stage map' });
  const overlay = el('canvas', { class: 'stage-overlay', 'aria-hidden': 'true' });
  const hint = el(
    'div',
    { class: 'stage-hint' },
    'Drag: orbit · Right-drag: pan · Wheel: zoom · WASD/QE: fly · Click: select · 1/2/3: move/rotate/scale · Arrows, PgUp/PgDn: nudge (Ctrl: rotate, Shift: ×5) · [ ]: scale · Del: hide · Ctrl+Z/Y: undo/redo · F: frame · R: reset view · H: collision · P: nav · F3: edit collision',
  );
  const host = el('div', { class: 'stage-canvas-host' }, canvas, overlay, hint);
  const lmSelect = el('select', { class: 'input input-sm', 'aria-label': 'Lightmap mode' }, LM_MODES.map(([v, label]) => el('option', { value: v }, label)));
  lmSelect.value = localStorage.getItem(LM_KEY) || 'normal';
  const texBox = el('input', { type: 'checkbox', checked: true });
  const colBox = el('input', { type: 'checkbox', disabled: true });
  const colLabel = el('label', { class: 'check muted', title: 'Reading the collision…' }, colBox, ' Collision');
  const navBox = el('input', { type: 'checkbox', disabled: true });
  const navLabel = el('label', { class: 'check muted', title: 'Reading the nav mesh…' }, navBox, ' Nav');
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
      navLabel,
      resetBtn,
      el('span', { class: 'spacer' }),
      status,
    ),
    el(
      'div',
      { class: 'stage-body' },
      el('aside', { class: 'stage-side' }, el('h3', {}, 'Placement'), placeBox, el('h3', {}, 'Inspect'), inspectBox, el('h3', {}, 'Gimmicks'), gimmickBox, el('h3', {}, 'Collision edits'), cnBox, el('h3', {}, 'Sky'), skyBox, el('h3', {}, 'Fog'), fogBox, el('h3', {}, 'Download'), downloadBox, el('h3', {}, 'Export 3D model'), modelBox, el('h3', {}, 'Layers'), layersBox),
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
    if (!edit.gimmicksPlaced) {
      // The gimmick meshes hold their models unturned: place them by their state once.
      edit.gimmicksPlaced = true;
      for (const o of edit.objects) if (o.gimmick) writeObject(o);
    }
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
    let selection = null; // {mesh, object, hit}
    // The selected object's triangles as an index buffer, for its tinted copy (made when the object is first drawn).
    let selEbo = null;
    const selectionEbo = (o) => {
      if (selEbo?.object === o) return selEbo.buffer;
      if (selEbo) gl.deleteBuffer(selEbo.buffer);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, o.triangles, gl.STATIC_DRAW);
      selEbo = { object: o, buffer };
      return buffer;
    };
    let tool = 0; // 0 move, 1 rotate, 2 scale
    let hover = -1; // gizmo handle under the pointer
    let gdrag = null; // gizmo drag in progress
    let dirty = true, overlayDirty = true;
    let vp = null, viewW = 1, viewH = 1;
    const keys = new Set();
    let last = performance.now();
    const saveSoon = debounce(() => store(edit.stage, edit.objects, edit.sky, fogFeatures(edit), gimmickEdits(edit)), 250);

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
          const useBatch = (b) => {
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
          };
          // A selection without an object (a mesh that has none) tints the whole mesh.
          const whole = selection?.mesh === m && !selection.object;
          for (const b of m.batches) {
            useBatch(b);
            range(b.firstIndex, b.firstIndex + b.indexCount, whole);
          }
          // The selected object's triangles (spread through the mesh's batches) drawn again tinted, from its own
          // index buffer, per batch span, pulled just in front of the untinted copy.
          const so = selection?.mesh === m ? selection.object : null;
          if (so?.spans.length) {
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, selectionEbo(so));
            gl.depthFunc(gl.LEQUAL);
            gl.enable(gl.POLYGON_OFFSET_FILL);
            gl.polygonOffset(-1, -1);
            for (let k = 0; k + 2 < so.spans.length; k += 3) {
              useBatch(m.batches[so.spans[k]]);
              range(so.spans[k + 1], so.spans[k + 1] + so.spans[k + 2], true);
            }
            gl.disable(gl.POLYGON_OFFSET_FILL);
            gl.depthFunc(gl.LESS);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, meshGpu(m).ebo);
          }
        }
      }
      if (lineProg) drawCollision(vp, eye);
      if (lineProg) drawNav(vp, eye);
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
      if (cnMode) drawCnOverlay(g2);
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
        const before = o.state;
        let after = fn(before, o);
        // A gimmick's table has no scale and no Solid.
        if (after && o.gimmick && (after.solid || after.s.some((x) => x !== 1))) after = { ...after, s: [1, 1, 1], solid: false };
        if (!after || sameState(before, after)) continue;
        apply(o, after);
        changes.push({ obj: o, before, after });
      }
      if (!changes.length) return;
      edit.history.push(changes, label, mergeKey);
      edited();
    }
    let downloadRefresh = () => {}, gimmickRefresh = () => {};
    function edited() {
      saveSoon();
      syncPanel();
      downloadRefresh();
      gimmickRefresh();
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
      if (k === 'home') change([o], (st) => ({ ...(o.stock ?? IDENTITY), hidden: st.hidden, solid: st.solid }), 'Reset');
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
          `${o.vertexCount.toLocaleString()} vertices · ${o.triCount.toLocaleString()} triangles · pivot ${o.pivot.map((x) => x.toFixed(1)).join(', ')}`,
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
      const col = edit.colRead, m = edit.colMatch, st = o.state, shapeTris = o.triCount;
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
      const nav = navSummaryLine(o.index);
      if (nav) lines.push(nav);
      return lines.join('\n');
    }
    function renderColInfo() {
      const p = placeBox.querySelector('.stage-col-info'), o = selected();
      if (p && o) p.textContent = collisionSummary(o);
    }
    /** Shows the selection's current placement and the edit count; force also rewrites the focused field. */
    function syncPanel(force = false) {
      const n = edit.objects.reduce((s, o) => s + (isEdited(o) ? 1 : 0), 0);
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
      const file = editsFile(edit.stage, edit.objects, edit.sky, fogFeatures(edit), gimmickEdits(edit));
      if (!Object.keys(file.Objects).length && !file.Sky && !file.Features && !file.Gimmicks) return toast('There are no edits to save yet.');
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
      if (scene.gimmicks && res.gimmicks.some((s) => typeof s?.Model === 'string' && !s.Removed)) {
        try {
          const fresh = newPlacementsOf(res.gimmicks, await scene.gimmicks.catalogue(), scene.gimmicks.placements.map((g) => g.tag));
          if (fresh.length) await addPlacements(fresh);
        } catch (e) {
          console.warn(`Map editor: the new gimmicks of ${f.name} could not be made: ${e.message}`);
        }
      }
      const changes = [];
      for (const c of [...res.changed, ...readGimmickEdits(edit, res.gimmicks)]) {
        if (c.pivot) c.obj.pivot = c.pivot;
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
      const { fog: fileFog, [COLNAV_KEY]: fileCn, ...rest } = res.features;
      Object.assign(edit.otherFeatures, rest);
      const fog = fogFromFeature(fileFog);
      if (fog && edit.fogStock && !sameFog(fog, edit.fog)) {
        const before = edit.fog;
        applyFog(fog);
        acts.push({ undo: () => applyFog(before), redo: () => applyFog(fog) });
        skyNote += ` Fog: ${fog.Enable ? `${metres(fog.Near)} → ${metres(fog.Far)}` : 'off'}.`;
      }
      // The file's collision edits (a "colnav" feature) replace these.
      if (fileCn && typeof fileCn === 'object' && !Array.isArray(fileCn)) {
        const before = cloneColNav(edit.colnav), after = readColNav(fileCn);
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          applyColNav(cloneColNav(after));
          acts.push({ undo: () => applyColNav(cloneColNav(before)), redo: () => applyColNav(cloneColNav(after)) });
          const n = after.Volumes.length, e = cnErasedCount();
          skyNote += ` Collision: ${e.toLocaleString()} triangle${e === 1 ? '' : 's'} erased, ${n} piece${n === 1 ? '' : 's'} added.`;
        }
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
      const list = edit.objects.filter(isEdited);
      if (!list.length) return toast('There are no edits to clear.');
      if (!(await confirmBox(`Put all ${list.length} edited objects back where the stage file has them? Undo can bring the edits back.`, 'Clear all', true))) return;
      change(list, (st, o) => o.stock ?? IDENTITY, 'Clear all edits');
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
      store(edit.stage, edit.objects, edit.sky, fogFeatures(edit), gimmickEdits(edit));
      if (edit.navMatch && !edit.navMatch.done) {
        // Unfinished (the worker running, or the nav still being read): the next view starts it again.
        edit.navMatch.worker?.terminate();
        edit.navMatch.done = true;
        edit.colMatch = edit.navMatch = null;
      } else {
        if (edit.colMatch) edit.colMatch.onChange = null;
        if (edit.navMatch) edit.navMatch.onChange = null;
      }
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

    // ----- download (objects, sky and fog written into a copy of the bundle, as the desktop export does) -----
    const downloadNote = el('p', { class: 'muted stage-count' });
    const bakeBtn = button('Download bundle', bakeBundle, {
      title: 'Write the moved, hidden and Solid objects, the collision edits, the sky and the fog into a copy of the stage bundle, as the desktop export does',
    });
    function bakeParts() {
      const parts = [];
      if (edit.objects.some((o) => !o.gimmick && !isEmpty(o.state))) parts.push('objects');
      if (Object.keys(edit.colnav.RemovedCollision).length || edit.colnav.Volumes.length) parts.push('collision');
      if (navHandEdited()) parts.push('bot navigation');
      if (edit.sky && edit.sky.Mode !== 'dungeon') parts.push('sky');
      if (fogChanged(edit)) parts.push('fog');
      return parts;
    }
    /** Nav painted or erased, or waypoints added, deleted, linked or unlinked by hand. */
    function navHandEdited() {
      const c = edit.colnav;
      return !!(c.NavCells.length || c.NavErase.length || c.Waypoints.length || c.RemovedWaypoints.length || c.Links.length || c.Cuts.length);
    }
    /**
     * The nav files rewritten as the live nav stands (CollectExportNav, StageNavBaker.Apply): the nav mesh and the
     * waypoint graph each only when it changed, a 360 file written back in its own byte order. Returns the summary
     * line, or null when the stage has no nav or nothing in the bundle can change it.
     */
    async function bakeNav(archive, touched) {
      const r = navRead;
      if (!r || (!r.nav && !r.path) || (!touched && !navHandEdited())) return null;
      for (let nm = edit.navMatch; nm && !nm.done && !stopped; nm = edit.navMatch) {
        status.textContent = 'Matching the nav to the objects…';
        await new Promise((ok) => setTimeout(ok, 250));
      }
      const nm = edit.navMatch;
      if (!nm?.done) return "Bot navigation was left as it was (matching wasn't finished when you exported).";
      if (nm.error) return `Bot navigation was left as it was (it couldn't be matched to the objects: ${nm.error}).`;
      navNow(true);
      const live = navLive;
      if (!live) return "Bot navigation was left as it was (the rebuild failed; the console has why).";
      const put = async (name, bytes) => {
        const i = archive.entries.findIndex((e) => e.name.toLowerCase() === name.toLowerCase());
        if (i < 0) return;
        const e = archive.entries[i], was = e.pointer || !e.data?.length ? null : (await decodeLayers(e.data)).payload;
        if (is360Spd(was)) bytes = spd360ToSteam(bytes); // the same lane swap both ways
        archive.entries[i] = { ...e, pointer: false, size: bytes.length, data: bytes };
        console.info(`Map editor export: ${name}: rewritten (${bytes.length} bytes)`);
      };
      if (live.nav && r.navName && navChanged(live)) await put(r.navName, writeNavMesh(live.nav));
      if (live.path && r.pathName && pathChanged(live)) await put(r.pathName, writePathGraph(live.path));
      return navChanged(live) || pathChanged(live) ? navSummary(live) : null;
    }
    const listOf = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : a[0]);
    function renderDownload() {
      const parts = bakeParts();
      downloadNote.textContent = parts.length
        ? `Writes the ${listOf(parts)} into a copy of ${edit.stage}.bres.`
        : 'Move, hide or make objects Solid, change the sky or fog, or edit the collision, to write them into a copy of the bundle.';
      bakeBtn.disabled = !parts.length;
      if (!downloadBox.contains(bakeBtn)) downloadBox.replaceChildren(downloadNote, el('div', { class: 'toolbar' }, bakeBtn));
    }
    /** Solid objects for export (CollectExportSolids): each one's collision shape, placed like the object. */
    function exportSolids() {
      const list = [];
      for (const o of edit.objects) {
        const st = o.state;
        if (!st.solid || st.hidden) continue;
        const world = isIdentityTransform(st) ? null : placementMatrix(st, o.pivot.map(Math.fround));
        list.push({ name: o.name, positions: solidOf(o), triangles: null, world });
      }
      return list;
    }
    /** The pieces added by hand, as shapes already in place (the volumes CollectExportSolids adds as "collision <shape>"). */
    const exportPieces = () =>
      edit.colnav.Volumes.map((v) => ({ name: `collision ${v.Shape}`, positions: volumeTriangles(v), triangles: null, world: null }));
    /**
     * The collision written as the desktop export does: the edited objects' triangles moved along in every .ccp layer
     * (PatchCollision, once the collision is matched to the objects), the triangles erased by hand left out, Solid
     * objects' generated collision and the pieces added by hand appended to the _Chit and _Ehit layers (SolidCollision),
     * and the changed layers' stale .mtf copies dropped. Returns {entries, line} or null when there's nothing to do; the
     * entries are replaced in place (at: lower-case name -> index).
     */
    async function bakeCollision(edits, solids, added, entries, at) {
      const ccp = [];
      entries.forEach((e, i) => /\.ccp$/i.test(e.name || '') && !e.pointer && e.data?.length && ccp.push(i));
      if (!ccp.length && !solids.length && !added.length) return null;
      const erased = Object.keys(edit.colnav.RemovedCollision).length > 0;
      const notes = [];
      let col = null, owners = null;
      if ((edits.length || erased) && ccp.length) {
        const lost = [edits.length ? "doesn't follow the moved objects" : '', erased ? 'keeps the triangles erased by hand' : ''].filter(Boolean).join(' and ');
        status.textContent = 'Reading the collision…';
        try {
          col = await (job.collision || (job.collision = readCollision(model)));
        } catch (e) {
          notes.push(`The collision couldn't be read (${e.message}), so it ${lost}.`);
        }
        if (col && !col.live) {
          notes.push(`The collision has an unfamiliar layout, so it ${lost}.`);
          col = null;
        } else if (col && edits.length) {
          if (!edit.colMatch) startMatching(col);
          for (let m = edit.colMatch; m && !m.owners && !m.error; m = edit.colMatch) {
            status.textContent = `Matching the collision to the objects… ${m.pct ?? 0}%`;
            await new Promise((ok) => setTimeout(ok, 250));
          }
          const m = edit.colMatch;
          if (m?.owners) owners = m.owners;
          else notes.push(`The collision couldn't be matched to objects${m?.error ? ` (${m.error})` : ''}, so it doesn't follow the moved objects.`);
        }
      }
      status.textContent = 'Writing the collision…';
      await pause();
      const rep = { log: [], warnings: [] }, changed = [], payloads = [];
      for (const i of ccp) payloads.push([i, (await decodeLayers(entries[i].data)).payload]);
      const all = solids.concat(added);
      const extra = all.length ? solidCollision(payloads.map(([i, data]) => ({ name: entries[i].name, data })), all, rep) : new Map();
      const from = added.length ? (solids.length ? 'Solid objects and added pieces' : 'added pieces') : 'Solid objects';
      for (const [i, data] of payloads) {
        const name = entries[i].name;
        const li = col ? col.layers.findIndex((l) => l.name.toLowerCase() === name.toLowerCase()) : -1;
        const removed = li >= 0 && erased ? removedFlags(edit.colnav, name, col.layers[li].indices.length / 3) : null;
        let out = li >= 0 && (owners || removed) ? patchCollision(data, name, owners ? edits : [], edit.objects, owners ? owners[li] : null, rep, removed) : null;
        const add = extra.get(name);
        if (add?.length) {
          out = appendCollisionGroups(out ?? data, add);
          rep.log.push(`${name}: +${add.length} group(s) from ${from}`);
        }
        if (!out) continue;
        entries[i] = { ...entries[i], pointer: false, size: out.length, data: out };
        changed.push(name);
      }
      for (const l of rep.log) console.info(`Map editor export: ${l}`);
      const { entries: kept, dropped } = dropStaleCollisionCopies(entries, changed);
      const what = [];
      if (owners) what.push(`${(rep.trianglesMoved || 0).toLocaleString()} triangles moved, ${(rep.trianglesRemoved || 0).toLocaleString()} removed`);
      if (rep.trianglesErased) what.push(`${rep.trianglesErased.toLocaleString()} erased by hand`);
      if (rep.collisionTrianglesGenerated) {
        const p = Math.min(added.length, rep.solidObjects || 0), k = (rep.solidObjects || 0) - p;
        const who = [k ? `${k.toLocaleString()} Solid object${k === 1 ? '' : 's'}` : '', p ? `${p.toLocaleString()} added piece${p === 1 ? '' : 's'}` : ''].filter(Boolean);
        what.push(`${rep.collisionTrianglesGenerated.toLocaleString()} generated for ${listOf(who)}`);
      }
      const line =
        (changed.length
          ? `Collision: ${what.join('; ')} in ${listOf(changed)}` +
            (dropped.length ? `; dropped ${listOf(dropped)} (the old collision copies).` : '.')
          : `Collision: left as it was${owners ? ' (none of it belongs to the edited objects)' : ''}.`) +
        [...notes, ...rep.warnings].map((x) => ` ${x}`).join('');
      return { entries: kept, line };
    }
    /** Downloads a copy of the bundle with the objects (and their collision), sky (ApplySkyToBundle) and fog (FogExport) written in. */
    async function bakeBundle() {
      const parts = bakeParts();
      if (!parts.length) return toast('Change the sky or fog first.');
      bakeBtn.disabled = true;
      const was = status.textContent;
      try {
        let archive = model;
        const lines = [];
        if (parts.includes('objects') || parts.includes('collision')) {
          status.textContent = 'Writing the objects…';
          await pause();
          const { edits, skipped } = collectExportEdits(edit.objects);
          const solids = exportSolids(), added = exportPieces();
          const erased = Object.keys(edit.colnav.RemovedCollision).length > 0;
          const at = new Map();
          archive.entries.forEach((e, i) => at.has(e.name.toLowerCase()) || at.set(e.name.toLowerCase(), i));
          const entryOf = (name) => archive.entries[at.get(name.toLowerCase())];
          const r = await bakeEdits(edits, async (name) => {
            const e = entryOf(name);
            return e && !e.pointer && e.data?.length ? (await decodeLayers(e.data)).payload : null;
          });
          const entries = archive.entries.slice();
          for (const [name, data] of r.changed) {
            const i = at.get(name.toLowerCase());
            entries[i] = { ...entries[i], pointer: false, size: data.length, data };
          }
          const n = r.report;
          if (edits.length || skipped)
            lines.push(
              `Objects: ${n.objectsWritten.toLocaleString()} written${n.objectsHidden ? ` (${n.objectsHidden.toLocaleString()} hidden)` : ''}, ` +
                `${n.verticesWritten.toLocaleString()} vertices, ${n.batchesRebounded.toLocaleString()} batch bounds refitted.` +
                (skipped ? ` ${skipped.toLocaleString()} moved object(s) can't be written back (no Steam record).` : ''),
            );
          const c = edits.length || solids.length || added.length || erased ? await bakeCollision(edits, solids, added, entries, at) : null;
          if (c) lines.push(c.line);
          archive = { ...archive, entries: c ? c.entries : entries };
        }
        {
          const touched = parts.includes('objects') || parts.includes('collision');
          archive = { ...archive, entries: archive.entries.slice() };
          const line = await bakeNav(archive, touched);
          if (line) lines.push(line);
        }
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
        toast(`${edit.stage}.bres downloaded. ${lines.join(' ')}`, 'ok', 10000);
      } catch (e) {
        toast(`The bundle could not be written: ${e.message}`, 'error', 10000);
      } finally {
        status.textContent = was;
        renderDownload();
      }
    }
    renderFog();
    renderDownload();
    downloadRefresh = renderDownload;

    // ----- 3D model (.glb for Blender, Unity, Godot and others; OBJ + MTL + PNG as the desktop's Export stage as OBJ) -----
    const glbBtn = button('Download .glb', () => exportModel('glb'), {
      title: 'glTF 2.0 binary with the textures inside. Blender: File > Import > glTF 2.0. Also opens in Unity, Godot, Unreal, 3ds Max, Maya and most 3D apps',
    });
    const objBtn = button('Download .obj (zip)', () => exportModel('obj'), {
      title: 'Wavefront OBJ + MTL + PNG textures in a zip, as the desktop app writes them. Blender: unzip, then File > Import > Wavefront (.obj)',
    });
    modelBox.replaceChildren(
      el(
        'p',
        { class: 'muted stage-count' },
        'Saves the stage as it is shown, in metres: the layers that are on, moved objects where they are now, hidden objects left out, with its textures. ' +
          (scene.missing.length ? `${scene.missing.length} textures are not in this bundle and come out grey.` : ''),
      ),
      el('div', { class: 'toolbar' }, glbBtn, objBtn),
    );
    async function exportModel(kind) {
      glbBtn.disabled = objBtn.disabled = true;
      const was = status.textContent;
      const progress = (t) => (status.textContent = t);
      try {
        await pause();
        const r = kind === 'glb'
          ? await stageGlb(scene.meshes, scene.textures, edit.stage, progress)
          : await stageObjZip(scene.meshes, scene.textures, edit.stage, progress);
        const name = kind === 'glb' ? `${edit.stage}.glb` : `${edit.stage}-obj.zip`;
        if (kind === 'glb') downloadBytes(r.bytes, name, 'model/gltf-binary');
        else downloadBlob(r.blob, name);
        toast(`${name} downloaded: ${r.meshes} meshes, ${Math.round(r.triangles).toLocaleString()} triangles, ${r.textures} textures.`, 'ok', 8000);
      } catch (e) {
        toast(`The 3D model could not be written: ${e.message}`, 'error', 10000);
      } finally {
        status.textContent = was;
        glbBtn.disabled = objBtn.disabled = false;
      }
    }

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
    const COL_PIECE = [0.75, 0.45, 1]; // pieces added by hand
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
      const P = o.mesh.baked?.positions ?? o.mesh.positions, T = o.triangles, n = o.triCount;
      if (n <= SOLID_BOX_THRESHOLD) {
        tris = new Float32Array(n * 9);
        for (let i = 0; i < n * 3; i++) {
          const v = T[i] * 3;
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
    /**
     * Rebuilds the in-place lists when an owner starts or stops being moved or hidden, and the layers whose erased
     * triangles changed (owned: green; unowned: blue); erased triangles draw nothing.
     */
    function syncStatic(m) {
      const key = m.ownerList.filter((i) => displaced(edit.objects[i].state)).join(',');
      if (key === staticKey && !cnTouched.size) return;
      const first = staticKey === null, all = first || key !== staticKey || cnTouched.has(-1);
      staticKey = key;
      const off = new Set(key ? key.split(',').map(Number) : []), flags = erasedFlags();
      colRead.layers.forEach((l, li) => {
        const touched = first || cnTouched.has(-1) || cnTouched.has(li);
        if (!all && !touched) return;
        const own = m.owners[li], f = flags[li], I = l.indices, keep = [], stage = [];
        for (let t = 0; t < own.length; t++) {
          if (f && f[t]) continue;
          const o = own[t];
          if (o < 0) {
            if (touched) stage.push(I[t * 3], I[t * 3 + 1], I[t * 3 + 2]);
          } else if (!off.has(o)) keep.push(I[t * 3], I[t * 3 + 1], I[t * 3 + 2]);
        }
        setEdges(colGpu[li].main, edgesOf(keep));
        if (touched) setEdges(colGpu[li].stage, edgesOf(stage));
      });
      cnTouched.clear();
    }
    /** Before (or without) matching: each layer's lines less the triangles erased by hand, rebuilt where they changed. */
    function syncPlain() {
      if (!cnTouched.size) return;
      const flags = erasedFlags();
      colRead.layers.forEach((l, li) => {
        if (!cnTouched.has(-1) && !cnTouched.has(li)) return;
        const f = flags[li];
        if (!f) return setEdges(colGpu[li].main, l.edges);
        const I = l.indices, keep = [];
        for (let t = 0; t < f.length; t++) if (!f[t]) keep.push(I[t * 3], I[t * 3 + 1], I[t * 3 + 2]);
        setEdges(colGpu[li].main, edgesOf(keep));
      });
      cnTouched.clear();
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
      const cnOn = (colBox.checked || cnMode > 0) && edit.colnav.Volumes.length > 0;
      if (!on && !o && !cnOn) return;
      const m = matchDone();
      const colour = (c) => gl.uniform4f(lineProg.u.uColor, c[0], c[1], c[2], 1);
      gl.useProgram(lineProg.program);
      gl.uniformMatrix4fv(lineProg.u.uViewProj, false, vp);
      gl.uniform3fv(lineProg.u.uEye, eye);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(false);
      if (on) {
        if (m) syncStatic(m);
        else syncPlain();
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
      if (cnOn) drawPieces(colour);
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
    /** Each object's collision triangles (9 floats each, stock) from the owners, leaving out those erased by hand. */
    function fillObjTris(col, m) {
      const n = edit.objects.length, count = new Int32Array(n), fill = new Int32Array(n);
      const flags = col.live ? col.layers.map((l) => removedFlags(edit.colnav, l.name, l.indices.length / 3)) : [];
      m.owners.forEach((own, li) => {
        const f = flags[li];
        for (let t = 0; t < own.length; t++) if (own[t] >= 0 && !(f && f[t])) count[own[t]]++;
      });
      const objTris = new Array(n).fill(null), ownerList = [];
      for (let i = 0; i < n; i++)
        if (count[i]) {
          objTris[i] = new Float32Array(count[i] * 9);
          ownerList.push(i);
        }
      col.layers.forEach((l, li) => {
        const own = m.owners[li], f = flags[li], P = l.positions, I = l.indices;
        for (let t = 0; t < own.length; t++) {
          const o = own[t];
          if (o < 0 || (f && f[t])) continue;
          const out = objTris[o];
          for (let k = 0; k < 3; k++) {
            const v = I[t * 3 + k] * 3;
            out[fill[o]++] = P[v];
            out[fill[o]++] = P[v + 1];
            out[fill[o]++] = P[v + 2];
          }
        }
      });
      Object.assign(m, { objTris, ownerList });
    }
    /** The owners from the worker, each object's triangles, and the desktop's log line. */
    function buildObjTris(col, m, owners) {
      let total = 0, owned = 0;
      for (const own of owners) {
        total += own.length;
        for (const o of own) if (o >= 0) owned++;
      }
      Object.assign(m, { owners, owned, total, pct: 100 });
      fillObjTris(col, m);
      console.info(`Map editor: live collision: ${owned} of ${total} triangles matched to ${m.ownerList.length} objects in ${m.ms} ms`);
    }
    /**
     * Matches the collision triangles, nav cells and waypoints to the objects in a worker, once per stage
     * (StartOwnerMatching; the nav is read first); kept while the page lives. edit.colMatch only when the collision is
     * live, edit.navMatch always.
     */
    function startMatching(col) {
      let m = edit.colMatch, nm = edit.navMatch;
      if (!nm) {
        if (col.live) m = edit.colMatch = { pct: 0, owners: null, objTris: null, ownerList: null, owned: 0, total: 0, ms: 0, error: null, worker: null, onChange: null };
        nm = edit.navMatch = { done: false, cellOwner: null, nodeOwner: null, worker: null, onChange: null };
        const meshes = [], at = new Map(), objects = new Int32Array(edit.objects.length), triangles = [];
        edit.objects.forEach((o, i) => {
          if (!at.has(o.mesh)) {
            at.set(o.mesh, meshes.length);
            meshes.push({ positions: o.mesh.baked?.positions ?? o.mesh.positions });
          }
          objects[i] = at.get(o.mesh);
          triangles.push(o.gimmick ? new Uint32Array(0) : o.triangles); // gimmicks own no stage collision
        });
        const layers = !col.live ? [] : col.layers.map((l) => ({
          groups: l.groups.map((g) => ({ vertices: g.vertices, triangles: g.triangles, minX: g.minX, minY: g.minY, minZ: g.minZ, maxX: g.maxX, maxY: g.maxY, maxZ: g.maxZ })),
        }));
        const fail = (msg) => {
          nm.worker?.terminate();
          nm.worker = null;
          nm.done = true;
          nm.error = msg;
          if (m) {
            m.worker = null;
            m.error = msg;
          }
          console.warn(`Map editor: the collision and nav couldn't be matched to objects: ${msg}`);
          m?.onChange?.();
          nm.onChange?.();
        };
        (job.nav || (job.nav = readNav(model))).catch(() => null).then((r) => {
          if (nm.done) return; // the view closed meanwhile
          const navCells = r?.nav ? r.nav.cells.map((c) => Array.from(c.v)) : null;
          const navNodes = r?.path ? Float32Array.from(r.path.nodes.flatMap((n) => [n.x, n.y, n.z])) : null;
          if (!m && !navCells && !navNodes) return void (nm.done = true);
          try {
            const w = (nm.worker = new Worker(new URL('./stage-collision-worker.js', import.meta.url), { type: 'module' }));
            if (m) m.worker = w;
            w.onmessage = (ev) => {
              const d = ev.data;
              if (d.error) return fail(d.error);
              if (d.owners) {
                w.terminate();
                nm.worker = null;
                if (m) {
                  m.worker = null;
                  m.ms = d.ms;
                  buildObjTris(col, m, d.owners);
                }
                Object.assign(nm, { done: true, cellOwner: d.cellOwner, nodeOwner: d.nodeOwner });
                if (d.cellOwner || d.nodeOwner) {
                  const owned = (a) => (a ? a.reduce((s, o) => s + (o >= 0 ? 1 : 0), 0) : 0);
                  console.info(
                    `Map editor: live nav: ${owned(d.cellOwner)} of ${d.cellOwner?.length ?? 0} cells and ` +
                      `${owned(d.nodeOwner)} of ${d.nodeOwner?.length ?? 0} waypoints matched to objects`,
                  );
                }
                nm.onChange?.();
              } else if (m) m.pct = d.pct;
              m?.onChange?.();
            };
            w.onerror = (e) => fail(e.message || 'the worker stopped');
            w.postMessage({ layers, meshes, objects, triangles, navCells, navNodes });
          } catch (e) {
            fail(e.message);
          }
        });
      }
      nm.onChange = () => {
        if (stopped) return;
        navKey = null;
        renderNav();
        renderColInfo();
        dirty = true;
      };
      if (!m) return;
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
              ? ` ${m.owned.toLocaleString()} triangles belong to ${m.ownerList.length.toLocaleString()} objects and follow them: green stays put, pale green has moved, blue is the stage's own, orange is Solid objects, violet is pieces added by hand, yellow is the selected object's.`
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
        renderColNav();
        dirty = true;
      },
      (e) => {
        if (stopped) return;
        colRead = edit.colRead = { layers: [], unread: [], live: false };
        console.warn(`Map editor: the collision of ${edit.stage} could not be read: ${e.message}`);
        startMatching(colRead);
        renderCollision();
        renderColInfo();
        renderColNav();
      },
    );
    renderCollision();

    // ----- nav mesh and waypoints (StageViewerForm.Nav.cs DrawLiveNav; key P) -----
    // Colours as on the desktop: nav cells cyan and depth-tested, the ones that moved pale blue; drops, waypoint links
    // and waypoints on top, the waypoints that moved yellow.
    const NAV_CELL = [0.15, 0.85, 1], NAV_CELL_MOVED = [0.75, 0.95, 1], NAV_DROP = [1, 0.3, 0.9], NAV_LINK = [1, 0.75, 0.3];
    const NAV_NODE = [1, 0.55, 0.1], NAV_NODE_MOVED = [1, 0.95, 0.2];
    const navGpu = { vao: null, buf: null, parts: [], drops: 0 }; // parts: {first, count, colour, depth}
    let navRead = null; // {nav, navName, path, pathName, unread} once read
    // The live nav (EnsureNavRebuilt): rebuilt from the stage's when what it follows changes, at most every 120 ms.
    let navKey = null, navLive = null, navAt = 0, navTimer = 0, navWinding = 0;
    let navRev = 0; // bumped when a brush stroke changes edit.colnav in place
    const navWorlds = [], navBlockers = [], navBefore = []; // per object, cached by its state and collision
    navBox.checked = !!job.showNav;
    /** Uploads the nav cells, drop links, waypoint links and waypoint rings as one line list (UploadLiveNav). */
    function uploadNav(nav, path, cellGroup = null, nodeGroup = null) {
      const moved = (g) => g && Array.from(g, (v) => v !== -1);
      const l = navLines(nav, path, moved(cellGroup), moved(nodeGroup));
      const lists = [
        [l.cells, NAV_CELL, true],
        [l.changed, NAV_CELL_MOVED, true],
        [l.drops, NAV_DROP, false],
        [l.links, NAV_LINK, false],
        [l.nodes, NAV_NODE, false],
        [l.nodesChanged, NAV_NODE_MOVED, false],
      ];
      navGpu.drops = l.drops.length / 6;
      const data = new Float32Array(lists.reduce((s, [a]) => s + a.length, 0));
      let at = 0;
      navGpu.parts = [];
      for (const [a, colour, depth] of lists) {
        data.set(a, at);
        if (a.length) navGpu.parts.push({ first: at / 3, count: a.length / 3, colour, depth });
        at += a.length;
      }
      if (navGpu.vao) gl.deleteVertexArray(navGpu.vao);
      if (navGpu.buf) gl.deleteBuffer(navGpu.buf);
      navGpu.vao = navGpu.buf = null;
      if (!navGpu.parts.length) return;
      navGpu.vao = gl.createVertexArray();
      navGpu.buf = gl.createBuffer();
      gl.bindVertexArray(navGpu.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, navGpu.buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    /** An object's placement now (row-major 3×4), or null when it hasn't moved. */
    function navWorld(i) {
      const o = edit.objects[i];
      if (!o) return null;
      const c = navWorlds[i];
      if (c && c.st === o.state) return c.w;
      const w = isIdentityTransform(o.state) ? null : placementMatrix(o.state, o.pivot.map(Math.fround));
      navWorlds[i] = { st: o.state, w };
      return w;
    }
    /**
     * Where a moved or Solid object now keeps bots out (NavBlocker): its own collision plus, when Solid, what it
     * collides as, placed where it stands; `before` is where it stood. Null when it blocks nothing.
     */
    function navBlocker(i, m) {
      const o = edit.objects[i], st = o.state, own = m?.objTris?.[i] ?? null;
      if (st.hidden || !(st.solid || !isIdentityTransform(st)) || !(st.solid || own?.length)) return null;
      const c = navBlockers[i];
      if (c && c.st === st && c.own === own) return c.b;
      const solid = st.solid ? solidOf(o) : null, nOwn = own?.length ?? 0;
      const pos = new Float32Array(nOwn + (solid?.length ?? 0));
      if (own) pos.set(own);
      if (solid) pos.set(solid, nOwn);
      const tris = new Int32Array(pos.length / 3);
      for (let k = 0; k < tris.length; k++) tris[k] = k;
      const world = navWorld(i);
      let before = null;
      if (world) {
        // The desktop caches this per object only; here it follows the object's collision and Solid too.
        const bc = navBefore[i];
        if (bc && bc.own === own && bc.solid === !!st.solid) before = bc.b;
        else navBefore[i] = { own, solid: !!st.solid, b: (before = Blocker.fromTriangles(i, pos, tris, null)) };
      }
      const b = Blocker.fromTriangles(i, pos, tris, world, before?.cell ?? 0);
      b.before = before;
      navBlockers[i] = { st, own, b: b.spans.size ? b : null };
      return navBlockers[i].b;
    }
    /** A walkable cell on a triangle, wound like the stage's own cells (NavCellFrom). */
    function navCellFrom(t, k) {
      if (!navWinding) {
        let up = 0, down = 0;
        for (const cell of navRead?.nav?.cells ?? []) {
          const v = cell.v, ny = Math.fround(Math.fround((v[5] - v[2]) * (v[6] - v[0])) - Math.fround((v[3] - v[0]) * (v[8] - v[2])));
          if (ny > 0) up++;
          else if (ny < 0) down++;
        }
        navWinding = down > up ? -1 : 1;
      }
      const ny = (t[k + 5] - t[k + 2]) * (t[k + 6] - t[k]) - (t[k + 3] - t[k]) * (t[k + 8] - t[k + 2]);
      const v = Float32Array.from(t.subarray(k, k + 9));
      if (ny > 0 !== navWinding > 0) v.set([t[k + 6], t[k + 7], t[k + 8], t[k + 3], t[k + 4], t[k + 5]], 3);
      return v;
    }
    /** What the rebuild follows (NavInput and AddColNavInput): the objects, and the hand edits in the colnav file. */
    function navInput(r, nm, m) {
      const c = edit.colnav, input = {
        nav: r.nav, path: r.path, cellOwner: nm?.cellOwner ?? null, nodeOwner: nm?.nodeOwner ?? null,
        hidden: (i) => !!edit.objects[i]?.state.hidden, world: navWorld,
        blockers: [], extraCells: [], eraseStamps: [], handNodes: [], removedNodes: new Set(), handLinks: [], cutLinks: new Set(),
      };
      for (let i = 0; i < edit.objects.length; i++) {
        const b = navBlocker(i, m);
        if (b) input.blockers.push(b);
      }
      for (const v of c.NavCells) if (Array.isArray(v) && v.length >= 9) input.extraCells.push({ v: Float32Array.from(v.slice(0, 9)), hand: true });
      for (const s of c.NavErase) if (Array.isArray(s) && s.length >= 4) input.eraseStamps.push(s.map(Number));
      for (const w of c.Waypoints)
        if (w) {
          const n = (x, d = 0) => Math.fround(Number.isFinite(+x) ? +x : d);
          input.handNodes.push({ id: Math.trunc(+w.Id || 0), x: n(w.X), y: n(w.Y), z: n(w.Z), radius: n(w.Radius, 150) });
        }
      for (const i of c.RemovedWaypoints) if (Number.isInteger(i)) input.removedNodes.add(i);
      for (const l of c.Links) if (Array.isArray(l) && l.length >= 2) input.handLinks.push([l[0], l[1]]);
      for (const l of c.Cuts) if (Array.isArray(l) && l.length >= 2) input.cutLinks.add(nodeRefKey(l[0], l[1]));
      // Added collision blocks bots where it stands, and its walkable tops (a floor, a ramp) are walkable.
      c.Volumes.forEach((vol, k) => {
        const t = volumeTriangles(vol), id = -1000 - k, idx = new Int32Array(t.length / 3);
        for (let j = 0; j < idx.length; j++) idx[j] = j;
        const b = Blocker.fromTriangles(id, t, idx, null);
        if (b.spans.size) input.blockers.push(b);
        for (let j = 0; j + 8 < t.length; j += 9) {
          const ex = t[j + 3] - t[j], ey = t[j + 4] - t[j + 1], ez = t[j + 5] - t[j + 2];
          const fx = t[j + 6] - t[j], fy = t[j + 7] - t[j + 1], fz = t[j + 8] - t[j + 2];
          const nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx, len = Math.hypot(nx, ny, nz);
          if (len > 1 && ny / len >= 0.7071) input.extraCells.push({ v: navCellFrom(t, j), object: id });
        }
      });
      return input;
    }
    /** Rebuilds the live nav when something it follows changed, at most every 120 ms (EnsureNavRebuilt). */
    function syncNav() {
      const r = navRead;
      if (!r || (!r.nav && !r.path)) return;
      const nm = edit.navMatch, m = edit.colMatch;
      const key = [edit.colnav, navRev, nm?.cellOwner, nm?.nodeOwner, m?.objTris];
      for (const o of edit.objects) key.push(o.state);
      if (navKey && sameList(key, navKey)) return;
      const now = performance.now();
      if (navKey && now - navAt < 120) {
        if (!navTimer) navTimer = setTimeout(() => ((navTimer = 0), (dirty = true)), 120 - (now - navAt));
        return;
      }
      navKey = key;
      navAt = now;
      try {
        const navIn = navInput(r, nm, m);
        navLive = rebuildNav(navIn);
        navLive.ms = performance.now() - now;
        uploadNav(navLive.nav, navLive.path, navLive.cellGroup, navLive.nodeGroup);
      } catch (e) {
        navLive = null;
        console.warn(`Map editor: live nav: rebuild failed: ${e?.message ?? e}`);
        uploadNav(r.nav, r.path);
      }
      if (cnMode >= 3) overlayDirty = true;
      renderNav();
    }
    /** Rebuilds the live nav now if anything it follows changed (force: even within 120 ms of the last rebuild). */
    function navNow(force = false) {
      if (force) navAt = -Infinity;
      syncNav();
    }
    /** The selected object's nav line (NavSummaryLine): how many nav cells and waypoints move with it. */
    function navSummaryLine(i) {
      const nm = edit.navMatch;
      if (!nm?.done || (!nm.cellOwner && !nm.nodeOwner)) return ''; // (owners only come with a nav read)
      let cells = 0, nodes = 0;
      if (nm.cellOwner) for (const o of nm.cellOwner) if (o === i) cells++;
      if (nm.nodeOwner) for (const o of nm.nodeOwner) if (o === i) nodes++;
      if (!cells && !nodes) return '';
      return `Nav: ${cells.toLocaleString()} cell${cells === 1 ? '' : 's'} · ${nodes.toLocaleString()} waypoint${nodes === 1 ? '' : 's'} move with it`;
    }
    function drawNav(vp, eye) {
      if (!navBox.checked) return;
      syncNav();
      if (!navGpu.vao) return;
      gl.useProgram(lineProg.program);
      gl.uniformMatrix4fv(lineProg.u.uViewProj, false, vp);
      gl.uniform3fv(lineProg.u.uEye, eye);
      gl.depthMask(false);
      gl.bindVertexArray(navGpu.vao);
      for (const p of navGpu.parts) {
        if (p.depth) gl.enable(gl.DEPTH_TEST);
        else gl.disable(gl.DEPTH_TEST);
        gl.uniform4f(lineProg.u.uColor, p.colour[0], p.colour[1], p.colour[2], 1);
        gl.drawArrays(gl.LINES, p.first, p.count);
      }
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.useProgram(prog.program);
    }
    function renderNav() {
      const r = navRead, nav = navLive?.nav ?? r?.nav, path = navLive?.path ?? r?.path;
      const notRead = r?.unread.length ? ` Not read: ${r.unread.join(', ')}.` : '';
      navBox.disabled = !(r?.nav || r?.path) || !lineProg;
      navLabel.classList.toggle('muted', navBox.disabled);
      if (!r) navLabel.title = 'Reading the nav mesh…';
      else if (!r.nav && !r.path) navLabel.title = `No nav mesh or waypoints (navi/path .spd) in this stage.${notRead}`;
      else if (!lineProg) navLabel.title = "This browser couldn't set up the nav lines.";
      else {
        const parts = [];
        if (nav) parts.push(`${nav.cells.length.toLocaleString()} nav cells, ${navGpu.drops.toLocaleString()} drops (${r.navName})`);
        if (path) {
          parts.push(
            `${path.nodes.length.toLocaleString()} waypoints, ${path.links.length.toLocaleString()} links, ` +
              `${path.regions.length.toLocaleString()} regions (${r.pathName})`,
          );
        }
        const nm = edit.navMatch;
        let live = '';
        if (nm && !nm.done) live = ' Matching it to the objects…';
        else if (navKey && !navLive) live = " The rebuild failed, so this is the stage's as it was.";
        else if (navLive && (navChanged(navLive) || pathChanged(navLive))) live = ` ${navSummary(navLive)}`;
        navLabel.title =
          `Show where the bots walk (P): ${parts.join('; ')}. Cyan: nav cells; magenta: one-way drops; ` +
          'orange: waypoints and their links. It follows moved, hidden and Solid objects and the collision edits: ' +
          `pale blue cells and yellow waypoints have moved.${live}${notRead}`;
      }
    }
    function showNav() {
      job.showNav = navBox.checked;
      dirty = true;
    }
    function toggleNav() {
      if (navBox.disabled) return toast(navLabel.title);
      navBox.checked = !navBox.checked;
      showNav();
    }
    navBox.addEventListener('change', showNav);
    (job.nav || (job.nav = readNav(model))).then(
      (r) => {
        if (stopped) return;
        navRead = r;
        navKey = null;
        if (lineProg) uploadNav(r.nav, r.path);
        renderNav();
        renderColNav();
        dirty = true;
      },
      (e) => {
        if (stopped) return;
        navRead = { nav: null, path: null, unread: [] };
        console.warn(`Map editor: the nav mesh of ${edit.stage} could not be read: ${e.message}`);
        renderNav();
        renderColNav();
      },
    );
    renderNav();

    // ----- collision edits: erase collision by hand, add pieces (StageViewerForm.ColNav.cs) -----
    let cnMode = 0; // 0 off, 1 erase collision, 2 add collision, 3 paint nav, 4 waypoints
    let cnBrush = 300, cnShape = 'Wall', cnYaw = 0, cnSel = -1, cnStroke = null, cnAim = null, cnShift = false;
    let cnFlags = null, cnColWas = false, cnNavWas = false, cnPending = null;
    let cnCell = 100, cnNode = MIN_REF, cnHover = MIN_REF; // nav square size; the selected and the hovered waypoint
    const cnSizes = Object.fromEntries(CN_SHAPES.map((s) => [s, CN_SIZES[s].slice()]));
    /** Layers whose erased triangles changed since their lines were last built (-1: all of them). */
    const cnTouched = new Set(Object.keys(edit.colnav.RemovedCollision).length ? [-1] : []);
    const pieces = { vao: null, buf: null, a: 0, b: 0, key: null }; // unselected pieces, then the selected one
    const CN_REACH = 80000;
    const CN_NAMES = ['Off', 'Erase collision', 'Add collision', 'Paint nav', 'Waypoints'];
    const CN_HINTS = [
      null,
      'Erase collision · Drag: erase · Shift+drag: bring back · Wheel or [ ]: brush size · Right-drag: orbit · Middle-drag: pan · 2-4, Tab: other tools · F3/Esc: leave · Ctrl+Z/Y: undo/redo',
      'Add collision · Click: place or select a piece · Shift+click: delete it · Wheel: turn (Shift: 5°) · R: shape · [ ]: width (Shift: height) · - +: depth · Arrows, PgUp/PgDn: move (Shift: ×8) · Del: delete · Right-drag: orbit · 1, 3, 4, Tab: other tools · F3/Esc: leave',
      'Paint nav · Drag: paint where bots walk · Shift+drag: erase nav · Wheel or [ ]: brush size · Right-drag: orbit · Middle-drag: pan · 1, 2, 4, Tab: other tools · F3/Esc: leave · Ctrl+Z/Y: undo/redo',
      'Waypoints · Click a waypoint: select it · Click another: link or unlink them · Click the map: add one (linked to the selected one) · Shift+click or Del: delete · Esc: let go · Wheel: zoom · 1-3, Tab: other tools · F3: leave',
    ];
    const baseHint = hint.textContent;
    const fmtM = (u) => String(Math.round(u) / 100);
    const flash = (t) => (status.textContent = t);
    const plural = (n, w, ws = `${w}s`) => `${n.toLocaleString()} ${n === 1 ? w : ws}`;
    const f32 = Math.fround;
    /** C#'s Math.Round: halves go to the even neighbour. */
    const roundEven = (x) => {
      const r = Math.round(x);
      return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
    };
    /** The shortest decimal that reads back as the same single-precision number (what the saved file keeps). */
    const f32Num = (x) => {
      const v = f32(x);
      for (let p = 1; p < 10; p++) {
        const s = Number(v.toPrecision(p));
        if (f32(s) === v) return s;
      }
      return v;
    };

    /** Each live collision layer's triangles erased by hand (null where none); [] until the collision is live. */
    function erasedFlags() {
      if (!colRead?.live) return [];
      return (cnFlags ??= colRead.layers.map((l) => removedFlags(edit.colnav, l.name, l.indices.length / 3)));
    }
    function cnErasedCount() {
      return Object.values(edit.colnav.RemovedCollision).reduce((s, l) => s + l.length, 0);
    }
    /** The erased triangles changed as a whole (an undo, a loaded file): every line list built from them goes stale. */
    function cnErased() {
      cnFlags = null;
      cnTouched.add(-1);
      const m = matchDone();
      if (m && colRead?.live) fillObjTris(colRead, m);
      dyn.key = [];
      sel.key = [];
    }
    /** Puts a collision-edits state in place (a change, an undo, a redo, a loaded file) and redraws what it touches. */
    function applyColNav(c) {
      const erasedSame = JSON.stringify(c.RemovedCollision) === JSON.stringify(edit.colnav.RemovedCollision);
      edit.colnav = c;
      if (!erasedSame) cnErased();
      pieces.key = null;
      if (cnSel >= c.Volumes.length) cnSel = -1;
      saveSoon();
      renderColNav();
      downloadRefresh();
      dirty = true;
      overlayDirty = true;
    }
    /** One undoable change: fn edits a copy (returning false, or changing nothing, does nothing). */
    function colNavChange(label, fn, mergeKey = null) {
      const before = cloneColNav(edit.colnav), next = cloneColNav(edit.colnav);
      if (fn(next) === false) return false;
      const after = cloneColNav(next);
      if (JSON.stringify(after) === JSON.stringify(before)) return false;
      const action = {
        before,
        after,
        undo() {
          applyColNav(cloneColNav(this.before));
        },
        redo() {
          applyColNav(cloneColNav(this.after));
        },
        merge(o) {
          this.after = o.after;
          return true;
        },
        drop() {
          return JSON.stringify(this.before) === JSON.stringify(this.after);
        },
      };
      applyColNav(cloneColNav(after));
      edit.history.push([], label, mergeKey, action);
      syncPanel();
      return true;
    }

    // Drawing: the pieces as lines (violet, the selected one yellow on top), the brush ring and the next piece's outline.
    function syncPieces() {
      if (pieces.key === cnSel) return;
      const a = [], b = [];
      const asIs = (out, at, x, y, z) => {
        out[at] = x;
        out[at + 1] = y;
        out[at + 2] = z;
      };
      edit.colnav.Volumes.forEach((v, i) => addLines(i === cnSel ? b : a, volumeTriangles(v), asIs));
      fillLines(pieces, a, b);
      pieces.key = cnSel;
    }
    function drawPieces(colour) {
      syncPieces();
      gl.bindVertexArray(pieces.vao);
      if (pieces.a) {
        colour(COL_PIECE);
        gl.drawArrays(gl.LINES, 0, pieces.a);
      }
      if (pieces.b) {
        gl.disable(gl.DEPTH_TEST);
        colour(COL_SELECTED);
        gl.drawArrays(gl.LINES, pieces.a, pieces.b);
        gl.enable(gl.DEPTH_TEST);
      }
    }
    /** A horizontal circle in the world, split where it goes behind the camera. */
    function cnRing(g2, x, y, z, r, segs) {
      g2.beginPath();
      let open = false;
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * 2 * Math.PI, p = project([x + Math.cos(a) * r, y, z + Math.sin(a) * r]);
        if (!p) {
          open = false;
          continue;
        }
        if (open) g2.lineTo(p.x, p.y);
        else g2.moveTo(p.x, p.y);
        open = true;
      }
      g2.stroke();
    }
    /** Waypoints (DrawCnWaypoints): green posts on yours, the selected and hovered rings, and the link the next click makes or breaks. */
    function drawCnWaypoints(g2) {
      const live = navLive;
      if (!live?.path || !live.nodeRef) return;
      const nodes = live.path.nodes;
      g2.strokeStyle = 'rgb(102 255 115 / 0.95)';
      g2.lineWidth = 2;
      g2.beginPath();
      for (let i = 0; i < nodes.length && i < live.nodeRef.length; i++) {
        const ref = live.nodeRef[i];
        if (ref >= 0 || ref === MIN_REF) continue;
        const n = nodes[i], a = project([n.x, n.y, n.z]), b = project([n.x, n.y + 140, n.z]);
        if (!a || !b) continue;
        g2.moveTo(a.x, a.y);
        g2.lineTo(b.x, b.y);
      }
      g2.stroke();
      const sel = cnNodeOf(cnNode), hov = cnHover !== cnNode ? cnNodeOf(cnHover) : null;
      const ring = (n, colour, width) => {
        g2.strokeStyle = colour;
        g2.lineWidth = width;
        cnRing(g2, n.x, n.y + 18, n.z, Math.max(40, n.radius) * 1.15, 32);
      };
      if (sel && hov) {
        const a = project([sel.x, sel.y + 18, sel.z]), b = project([hov.x, hov.y + 18, hov.z]);
        if (a && b) {
          g2.strokeStyle = cnLinked(cnNode, cnHover) ? 'rgb(255 89 77 / 0.95)' : 'rgb(102 255 115 / 0.95)';
          g2.lineWidth = 3;
          g2.beginPath();
          g2.moveTo(a.x, a.y);
          g2.lineTo(b.x, b.y);
          g2.stroke();
        }
      }
      if (hov) ring(hov, 'rgb(255 255 255 / 0.95)', 2);
      if (sel) ring(sel, 'rgb(255 255 115 / 0.95)', 3);
    }
    function drawCnOverlay(g2) {
      if (cnMode === 4) return drawCnWaypoints(g2);
      if (!cnAim) return;
      if (cnMode === 3) {
        const erase = cnStroke ? cnStroke.dir < 0 : cnShift;
        g2.strokeStyle = erase ? 'rgb(255 115 89 / 0.95)' : 'rgb(77 230 255 / 0.95)';
        g2.lineWidth = 2.5;
        cnRing(g2, cnAim[0], cnAim[1] + 8, cnAim[2], cnBrush, 64);
        return;
      }
      if (cnMode === 1) {
        const restore = cnStroke ? cnStroke.dir < 0 : cnShift;
        g2.strokeStyle = restore ? 'rgb(115 255 128 / 0.9)' : 'rgb(255 102 89 / 0.9)';
        g2.lineWidth = 2;
        g2.beginPath();
        let open = false;
        for (let i = 0; i <= 48; i++) {
          const a = (i / 48) * 2 * Math.PI;
          const p = project([cnAim[0] + Math.cos(a) * cnBrush, cnAim[1], cnAim[2] + Math.sin(a) * cnBrush]);
          if (!p) {
            open = false;
            continue;
          }
          if (open) g2.lineTo(p.x, p.y);
          else g2.moveTo(p.x, p.y);
          open = true;
        }
        g2.stroke();
      } else if (cnMode === 2 && cnSel < 0) {
        const f = volumeTriangles(cnGhost());
        g2.strokeStyle = 'rgb(191 115 255 / 0.85)';
        g2.lineWidth = 1.5;
        g2.setLineDash([5, 4]);
        g2.beginPath();
        for (let i = 0; i + 8 < f.length; i += 9) {
          const p = [0, 3, 6].map((k) => project([f[i + k], f[i + k + 1], f[i + k + 2]]));
          if (p.some((x) => !x)) continue;
          g2.moveTo(p[0].x, p[0].y);
          g2.lineTo(p[1].x, p[1].y);
          g2.lineTo(p[2].x, p[2].y);
          g2.closePath();
        }
        g2.stroke();
        g2.setLineDash([]);
      }
    }

    /** Where a ray first meets the map, the collision left in place or a piece (CnRay); null when nothing is in reach. */
    /** How far a ray looks: the desktop's 800 m, or as far as the map reaches when the view is pulled back to see it all. */
    const cnReach = (o) =>
      Math.max(CN_REACH, Math.hypot(o[0] - sceneCentre[0], o[1] - sceneCentre[1], o[2] - sceneCentre[2]) + sceneRadius);
    /**
     * The nearest hit along a ray within maxT (CnRay): objects as drawn, the collision where it stands (not erased, not
     * carried off by its object), and added pieces; maxT when nothing is hit. Collision groups are tested by their box
     * first (1 unit wider), as on the desktop.
     */
    function cnCast(o, d, maxT) {
      let best = Math.min(maxT, pick(scene, o, d)?.dist ?? maxT);
      if (colRead?.live) {
        const m = matchDone(), flags = erasedFlags();
        colRead.layers.forEach((l, li) => {
          const f = flags[li], own = m?.owners[li], P = l.positions, I = l.indices;
          for (const s of cnSpans(l)) {
            if (s.lo) {
              const enter = boxEnter(o, d, s.lo, s.hi);
              if (enter < 0 || enter >= best) continue;
            }
            for (let t = s.first, end = s.first + s.n; t < end; t++) {
              if ((f && f[t]) || (own && own[t] >= 0 && displaced(edit.objects[own[t]].state))) continue;
              const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
              const h = rayTriangle(o, d, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]);
              if (h >= 0 && h < best) best = h;
            }
          }
        });
      }
      for (const v of edit.colnav.Volumes) best = rayTris(o, d, volumeTriangles(v), best);
      return best;
    }
    /**
     * A layer's triangles in runs with the box around each (its collision groups, 1 unit wider); one unboxed run when
     * the groups don't number the triangles the same way (no groups, or a triangle the reader dropped).
     */
    function cnSpans(l) {
      if (l.cnSpans) return l.cnSpans;
      const total = l.indices.length / 3;
      let first = 0;
      const spans = (l.groups ?? []).map((g) => {
        const s = { first, n: g.triangles.length / 3, lo: [g.minX - 1, g.minY - 1, g.minZ - 1], hi: [g.maxX + 1, g.maxY + 1, g.maxZ + 1] };
        first += s.n;
        return s;
      });
      return (l.cnSpans = spans.length && first === total ? spans : [{ first: 0, n: total, lo: null, hi: null }]);
    }
    function cnRay(o, d) {
      const reach = cnReach(o), t = cnCast(o, d, reach);
      return t < reach ? o.map((x, k) => x + d[k] * t) : null;
    }
    /** The surface height under (x, z) looking down from `from` (CnSurfaceBelow, single precision); null when none. */
    function cnSurfaceBelow(x, from, z, depth) {
      const t = cnCast([x, from, z], [0, -1, 0], depth);
      return t < depth ? f32(from - f32(t)) : null;
    }
    function cnRayAt(p) {
      const { o, d } = rayAt(p.x, p.y);
      return cnRay(o, d);
    }

    // Erase collision: a brush stroke is one undo step.
    function cnStrokeStart(restore) {
      if (cnMode === 3) {
        if (!cnAim) return; // a stroke starts on a surface (BeginColNavStroke)
        cnStroke = { dir: restore ? -1 : 1, before: cloneColNav(edit.colnav), n: 0, nav: true };
        cnDab();
        overlayDirty = true;
        return;
      }
      if (!colRead?.live) return flash("The collision can't be erased here (it isn't read yet, or has an unfamiliar layout)");
      cnStroke = { dir: restore ? -1 : 1, before: cloneColNav(edit.colnav), n: 0, layers: new Set() };
      cnDab();
      overlayDirty = true;
    }
    function cnDab() {
      if (!cnStroke || !cnAim) return;
      if (cnStroke.nav) {
        cnStroke.n += cnStroke.dir > 0 ? paintNavAt(cnAim, cnBrush) : eraseNavAt(cnAim, cnBrush);
        return;
      }
      const m = matchDone(), flags = erasedFlags(), erase = cnStroke.dir > 0;
      colRead.layers.forEach((l, li) => {
        const own = m?.owners[li];
        // Collision carried off with a moved or hidden object is left alone.
        const skip = own ? (t) => own[t] >= 0 && displaced(edit.objects[own[t]].state) : null;
        const r = eraseAt(l.positions, l.indices, flags[li], cnAim, cnBrush, erase, skip);
        if (!r.n) return;
        flags[li] = r.flags;
        cnStroke.n += r.n;
        cnStroke.layers.add(li);
        cnTouched.add(li);
        dirty = true;
      });
    }
    function cnStrokeEnd() {
      const s = cnStroke;
      if (!s) return;
      cnStroke = null;
      overlayDirty = true;
      if (!s.n) return;
      if (s.nav) {
        const before = s.before, after = cloneColNav(edit.colnav);
        edit.history.push([], s.dir > 0 ? 'Paint nav' : 'Erase nav', null, {
          undo: () => applyColNav(cloneColNav(before)),
          redo: () => applyColNav(cloneColNav(after)),
        });
        edit.history.breakMerge();
        flash(s.dir > 0 ? `Painted ${plural(s.n, 'square')} where bots walk` : 'Erased nav');
        edited();
        renderColNav();
        return;
      }
      const flags = erasedFlags();
      for (const li of s.layers) setRemovedFlags(edit.colnav, colRead.layers[li].name, flags[li]);
      const before = s.before, after = cloneColNav(edit.colnav);
      edit.history.push([], s.dir > 0 ? 'Erase collision' : 'Restore collision', null, {
        undo: () => applyColNav(cloneColNav(before)),
        redo: () => applyColNav(cloneColNav(after)),
      });
      edit.history.breakMerge();
      const m = matchDone();
      if (m) fillObjTris(colRead, m);
      dyn.key = [];
      sel.key = [];
      flash(`${s.dir > 0 ? 'Erased' : 'Brought back'} ${plural(s.n, 'triangle')}`);
      edited();
      renderColNav();
    }

    // Paint nav (PaintNavAt / EraseNavAt): single precision where the desktop is float.
    const cnCen = (v, k) => f32(f32(f32(f32(v[k]) + f32(v[k + 3])) + f32(v[k + 6])) / 3);
    /** Whether a live nav cell already covers (x, z) at about this height (WalkableAlready, InsideXz). */
    function walkableAlready(x, y, z) {
      for (const c of navLive?.nav?.cells ?? []) {
        const v = c.v;
        if (Math.abs(f32(cnCen(v, 1) - y)) > 150) continue;
        const d1 = f32(f32(f32(x - v[3]) * f32(v[2] - v[5])) - f32(f32(v[0] - v[3]) * f32(z - v[5])));
        const d2 = f32(f32(f32(x - v[6]) * f32(v[5] - v[8])) - f32(f32(v[3] - v[6]) * f32(z - v[8])));
        const d3 = f32(f32(f32(x - v[0]) * f32(v[8] - v[2])) - f32(f32(v[6] - v[0]) * f32(z - v[2])));
        if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return true;
      }
      return false;
    }
    /**
     * Lays walkable squares (two cells each, on a cnCell grid) on the surface under the brush, leaving out steep or
     * broken ground and squares that are walkable already; returns how many were laid.
     */
    function paintNavAt(at, radius) {
      navNow(); // what is walkable already (throttled while the brush moves)
      const s = f32(cnCell), X = f32(at[0]), Y = f32(at[1]), Z = f32(at[2]), r = f32(radius);
      // CnCellKey: a long of ix's low 24 bits, iz's low 20 and the height in 2.5 m steps' low 20.
      const key = (ix, iz, y) => `${ix & 0xffffff},${iz & 0xfffff},${roundEven(f32(y / 250)) & 0xfffff}`;
      const have = new Set();
      for (const v of edit.colnav.NavCells)
        if (Array.isArray(v) && v.length >= 9) have.add(key(Math.floor(f32(cnCen(v, 0) / s)), Math.floor(f32(cnCen(v, 2) / s)), cnCen(v, 1)));
      const x0 = Math.floor(f32(f32(X - r) / s)), x1 = Math.floor(f32(f32(X + r) / s));
      const z0 = Math.floor(f32(f32(Z - r) / s)), z1 = Math.floor(f32(f32(Z + r) / s));
      const top = f32(Y + Math.max(300, f32(s * 3))), depth = Math.max(900, f32(s * 9)), r2 = f32(r * r), steep = f32(s * f32(1.2));
      const heights = new Map(); // a corner's height, shared by the squares round it (same ray each time)
      const below = (gx, gz) => {
        const k = `${gx},${gz}`;
        if (!heights.has(k)) heights.set(k, cnSurfaceBelow(f32(gx * s), top, f32(gz * s), depth));
        return heights.get(k);
      };
      let added = 0;
      for (let ix = x0; ix <= x1; ix++)
        for (let iz = z0; iz <= z1; iz++) {
          const cx = f32(f32(ix + 0.5) * s), cz = f32(f32(iz + 0.5) * s), dx = f32(cx - X), dz = f32(cz - Z);
          if (f32(f32(dx * dx) + f32(dz * dz)) > r2) continue;
          const y = [];
          for (let k = 0; k < 4; k++) {
            const h = below(ix + (k & 1), iz + (k >> 1));
            if (h === null) break;
            y.push(h);
          }
          if (y.length < 4 || f32(Math.max(...y) - Math.min(...y)) > steep) continue; // steeper than ~50°, or a ledge
          const cy = f32(f32(f32(f32(y[0] + y[1]) + y[2]) + y[3]) / 4), k = key(ix, iz, cy);
          if (have.has(k)) continue;
          have.add(k);
          if (walkableAlready(cx, cy, cz)) continue;
          const p = [0, 1, 2, 3].map((k) => [f32((ix + (k & 1)) * s), f32(y[k] + 2), f32((iz + (k >> 1)) * s)]);
          for (const [a, b, c] of [[0, 1, 3], [0, 3, 2]])
            edit.colnav.NavCells.push(Array.from(navCellFrom(Float32Array.from([...p[a], ...p[b], ...p[c]]), 0), f32Num));
          added++;
        }
      if (added) {
        navRev++;
        dirty = true;
      }
      return added;
    }
    /** Takes painted cells under the brush out, and stamps out the stage's nav there; 1 when anything changed. */
    function eraseNavAt(at, radius) {
      const X = f32(at[0]), Y = f32(at[1]), Z = f32(at[2]), r = f32(radius), r2 = f32(r * r);
      const near = (v) => {
        const dx = f32(cnCen(v, 0) - X), dz = f32(cnCen(v, 2) - Z);
        return f32(f32(dx * dx) + f32(dz * dz)) <= r2 && Math.abs(f32(cnCen(v, 1) - Y)) <= 300;
      };
      const c = edit.colnav, before = c.NavCells.length;
      c.NavCells = c.NavCells.filter((v) => !(Array.isArray(v) && v.length >= 9 && near(v)));
      let any = c.NavCells.length !== before;
      // A stamp only where there is other nav to erase (and not right on top of the last one).
      if ((navLive?.nav?.cells ?? []).some((cell) => near(cell.v))) {
        const last = c.NavErase.length ? c.NavErase[c.NavErase.length - 1] : null, round1 = (x) => roundEven(x * 10) / 10;
        if (!last || Math.abs(last[0] - X) + Math.abs(last[2] - Z) > r * 0.25 || Math.abs(last[3] - r) > 1)
          c.NavErase.push([round1(X), round1(Y), round1(Z), round1(r)]);
        any = true;
      }
      if (!any) return 0;
      navRev++;
      navNow(true);
      dirty = true;
      return 1;
    }

    // Waypoints: select, link / unlink, add, delete (CnWaypointAt, CnWaypointClick, CnDeleteWaypoint).
    /** The live waypoint drawn nearest p on screen (within 22 pixels): its reference, or MIN_REF. */
    function cnWaypointAt(p) {
      const live = navLive;
      if (!live?.path || !live.nodeRef || !p) return MIN_REF;
      let best = 22 * 22, found = MIN_REF;
      for (let i = 0; i < live.path.nodes.length && i < live.nodeRef.length; i++) {
        if (live.nodeRef[i] === MIN_REF) continue; // a copy's waypoint follows its object
        const n = live.path.nodes[i], q = project([n.x, n.y + 15, n.z]);
        if (!q) continue;
        const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
        if (d < best) [best, found] = [d, live.nodeRef[i]];
      }
      return found;
    }
    const cnNodeIndex = (ref) => (ref === MIN_REF || !navLive?.nodeRef ? -1 : navLive.nodeRef.indexOf(ref));
    const cnNodeOf = (ref) => navLive?.path?.nodes[cnNodeIndex(ref)] ?? null;
    function cnLinked(a, b) {
      const ia = cnNodeIndex(a), ib = cnNodeIndex(b);
      return ia >= 0 && ib >= 0 && navLive.path.links.some((l) => (l.a === ia && l.b === ib) || (l.a === ib && l.b === ia));
    }
    function typicalWaypointRadius() {
      const radii = (navRead?.path?.nodes ?? []).map((n) => n.radius).filter((r) => r > 0).sort((a, b) => a - b);
      return radii.length ? radii[radii.length >> 1] : 150;
    }
    function cnWaypointClick(p) {
      navNow(true);
      const hit = cnWaypointAt(p);
      overlayDirty = true;
      if (hit !== MIN_REF) {
        if (cnNode === MIN_REF || cnNode === hit) {
          cnNode = cnNode === hit ? MIN_REF : hit;
          flash(cnNode === MIN_REF ? 'Deselected' : 'Waypoint selected — click another to link / unlink, Delete removes it');
        } else {
          const a = cnNode, b = hit, linked = cnLinked(a, b), key = nodeRefKey(a, b);
          colNavChange(linked ? 'Unlink waypoints' : 'Link waypoints', (c) => {
            c.Links = c.Links.filter((l) => nodeRefKey(l[0], l[1]) !== key);
            c.Cuts = c.Cuts.filter((l) => nodeRefKey(l[0], l[1]) !== key);
            (linked ? c.Cuts : c.Links).push([a, b]);
          });
          flash(linked ? "Unlinked — bots won't go straight between these two" : 'Linked');
          cnNode = b; // keep chaining
        }
        return renderColNav();
      }
      const at = cnRayAt(p);
      if (!at) return flash('Point at a surface to add a waypoint');
      const id = edit.colnav.NextWaypointId, prev = cnNode;
      const w = { Id: id, X: f32Num(at[0]), Y: f32Num(f32(f32(at[1]) + 20)), Z: f32Num(at[2]), Radius: f32Num(typicalWaypointRadius()) };
      colNavChange('Add waypoint', (c) => {
        c.NextWaypointId++;
        c.Waypoints.push(w);
        if (prev !== MIN_REF) c.Links.push([prev, -(id + 1)]);
      });
      cnNode = -(id + 1);
      renderColNav();
      flash(prev !== MIN_REF ? 'Waypoint added, linked to the selected one' : 'Waypoint added — linked to its nearest neighbours');
    }
    function cnDeleteWaypoint(ref) {
      if (ref === MIN_REF) return flash('Select a waypoint first (click it)');
      colNavChange('Delete waypoint', (c) => {
        if (ref < 0) {
          const id = -ref - 1, other = (l) => l[0] !== ref && l[1] !== ref;
          c.Waypoints = c.Waypoints.filter((w) => w.Id !== id);
          c.Links = c.Links.filter(other);
          c.Cuts = c.Cuts.filter(other);
        } else if (!c.RemovedWaypoints.includes(ref)) c.RemovedWaypoints.push(ref);
      });
      if (cnNode === ref) cnNode = MIN_REF;
      cnHover = MIN_REF;
      overlayDirty = true;
      renderColNav();
      flash('Waypoint deleted');
    }
    function cnClearNav() {
      colNavChange('Clear nav edits', (c) => {
        c.NavCells = [];
        c.NavErase = [];
      });
    }
    function cnClearWaypoints() {
      cnNode = MIN_REF;
      colNavChange('Clear waypoint edits', (c) => {
        c.Waypoints = [];
        c.RemovedWaypoints = [];
        c.Links = [];
        c.Cuts = [];
      });
    }

    // Add collision: pieces standing where the pointer meets the map.
    function cnGhost() {
      const [W, H, D] = cnSizes[cnShape], r = (x) => Math.round(x * 10) / 10;
      return { Shape: cnShape, X: r(cnAim[0]), Y: r(cnAim[1]), Z: r(cnAim[2]), W, H, D, Yaw: cnYaw };
    }
    function cnSelect(i) {
      cnSel = i;
      edit.history.breakMerge();
      renderColNav();
      dirty = overlayDirty = true;
    }
    function cnClick(p, shift) {
      if (shift) return cnDelete();
      const { o, d } = rayAt(p.x, p.y);
      let best = -1, bestT = cnReach(o);
      edit.colnav.Volumes.forEach((v, i) => {
        const t = rayTris(o, d, volumeTriangles(v), bestT);
        if (t < bestT) [best, bestT] = [i, t];
      });
      // An object in front of the piece wins.
      if (best >= 0) {
        const hit = pick(scene, o, d);
        if (hit && hit.dist < bestT - 1) best = -1;
      }
      if (best >= 0) return cnSelect(cnSel === best ? -1 : best);
      if (cnSel >= 0) return cnSelect(-1);
      const at = cnRay(o, d);
      if (!at) return flash('Point at a surface to place collision');
      cnAim = at;
      const v = cnGhost(), shape = v.Shape.toLowerCase();
      if (!colNavChange(`Add ${shape}`, (c) => void c.Volumes.push(v))) return;
      cnSelect(edit.colnav.Volumes.length - 1);
      flash(`Added a ${shape} — bots walk around it${v.Shape === 'Wall' || v.Shape === 'Block' ? '' : ' and on it'}`);
    }
    function cnDelete() {
      const v = edit.colnav.Volumes[cnSel];
      if (!v) return flash('Select an added piece first (click it)');
      const i = cnSel;
      cnSel = -1;
      colNavChange(`Delete ${v.Shape}`, (c) => void c.Volumes.splice(i, 1));
      flash(`Deleted the ${v.Shape}`);
    }
    function cnTurn(deg) {
      const i = cnSel;
      if (i >= 0) colNavChange('Turn piece', (c) => void (c.Volumes[i].Yaw = wrapDegrees(c.Volumes[i].Yaw + deg)), `cn-turn:${i}`);
      else {
        cnYaw = wrapDegrees(cnYaw + deg);
        overlayDirty = true;
        renderColNav();
      }
    }
    /** Makes the piece (or the next one) 25% bigger or 20% smaller along W, H or D; its shape then starts at that size. */
    function cnResize(axis, up) {
      const i = cnSel, v = edit.colnav.Volumes[i], shape = v ? v.Shape : cnShape, key = 'WHD'[axis];
      const n = Math.max(10, Math.min(20000, Math.round((v ? v[key] : cnSizes[shape][axis]) * (up ? 1.25 : 0.8))));
      cnSizes[shape][axis] = n;
      if (v) colNavChange('Size piece', (c) => void (c.Volumes[i][key] = n), `cn-size:${i}:${axis}`);
      else {
        overlayDirty = true;
        renderColNav();
      }
      const s = v ? edit.colnav.Volumes[i] : null, [W, H, D] = s ? [s.W, s.H, s.D] : cnSizes[shape];
      flash(`${shape}: ${fmtM(W)} × ${fmtM(H)} × ${fmtM(D)} m`);
    }
    function cnSetShape(s) {
      const i = cnSel;
      cnShape = s;
      if (i >= 0) {
        const [W, H, D] = cnSizes[s];
        colNavChange('Change shape', (c) => void Object.assign(c.Volumes[i], { Shape: s, W, H, D }));
      }
      overlayDirty = true;
      renderColNav();
      flash(`Shape: ${s}`);
    }
    function cnCycleShape(dir) {
      const cur = cnSel >= 0 ? edit.colnav.Volumes[cnSel].Shape : cnShape, n = CN_SHAPES.length;
      cnSetShape(CN_SHAPES[(CN_SHAPES.indexOf(cur) + dir + n) % n]);
    }
    /** Moves the selected piece along the view's forward and right, snapped to the nearer world axis, or up and down. */
    function cnMove(k, coarse) {
      const i = cnSel;
      if (i < 0) return false;
      const step = coarse ? 200 : 25, { f } = basis();
      const fw = Math.abs(f[0]) >= Math.abs(f[2]) ? [Math.sign(f[0]), 0, 0] : [0, 0, Math.sign(f[2])];
      const rt = [-fw[2], 0, fw[0]], neg = (a) => a.map((x) => -x);
      const dir = { arrowup: fw, arrowdown: neg(fw), arrowright: rt, arrowleft: neg(rt), pageup: [0, 1, 0], pagedown: [0, -1, 0] }[k];
      colNavChange(
        'Move piece',
        (c) => {
          const v = c.Volumes[i];
          v.X += dir[0] * step;
          v.Y += dir[1] * step;
          v.Z += dir[2] * step;
        },
        `cn-move:${i}`,
      );
      return true;
    }
    function cnSetBrush(r) {
      cnBrush = Math.max(CN_MIN_BRUSH, Math.min(CN_MAX_BRUSH, r)); // unrounded: small wheel steps add up
      overlayDirty = true;
      renderColNav();
      flash(`Brush: ${fmtM(cnBrush)} m`);
    }
    function cnRestoreAll() {
      if (colNavChange('Bring back erased collision', (c) => void (c.RemovedCollision = {}))) flash('Brought back all erased collision');
    }

    /** Why a tool can't be used on this stage (null when it can). */
    function cnBlocked(mode) {
      if (mode === 1 && !colRead?.live)
        return colRead ? "The collision can't be erased here: it isn't read, or has an unfamiliar layout" : 'Reading the collision…';
      if (mode === 2 && !colRead?.layers.length) return colRead ? 'This stage has no collision (.ccp) to add to' : 'Reading the collision…';
      if (mode === 3 && !navRead?.nav) return navRead ? 'This stage has no nav mesh (navi .spd) to paint' : 'Reading the nav mesh…';
      if (mode === 4 && !navRead?.path) return navRead ? 'This stage has no waypoints (path .spd) to edit' : 'Reading the waypoints…';
      return null;
    }
    /** Tab: the next tool this stage can use. */
    function cnCycle(dir) {
      for (let k = 1, m = cnMode; k <= 4; k++) {
        m = ((m - 1 + dir + 4) % 4) + 1;
        if (!cnBlocked(m)) return setCnMode(m);
      }
    }
    /**
     * Turns the tool on (1 erase or 2 add collision, 3 paint nav, 4 waypoints) or off (0); the collision lines show
     * while it is on, and the nav while painting it or editing waypoints.
     */
    function setCnMode(mode) {
      if (mode === cnMode) return;
      const why = mode ? cnBlocked(mode) : null;
      if (why) return flash(why);
      cnStrokeEnd();
      const was = cnMode;
      cnMode = mode;
      cnNode = cnHover = MIN_REF;
      const navTool = (m) => m === 3 || m === 4;
      if (navTool(mode) && !navTool(was)) {
        cnNavWas = navBox.checked;
        if (!navBox.disabled && !navBox.checked) {
          navBox.checked = true;
          showNav();
        }
        navNow(true);
      } else if (!navTool(mode) && navTool(was) && navBox.checked !== cnNavWas) {
        navBox.checked = cnNavWas;
        showNav();
      }
      if (!was) {
        select(null);
        cnColWas = colBox.checked;
        if (!colBox.disabled && !colBox.checked) {
          colBox.checked = true;
          showCollision();
        }
      } else if (!mode && colBox.checked !== cnColWas) {
        colBox.checked = cnColWas;
        showCollision();
      }
      if (mode !== 2) cnSel = -1;
      if (!mode) cnAim = null;
      edit.history.breakMerge();
      hint.textContent = mode ? CN_HINTS[mode] : baseHint;
      canvas.style.cursor = mode ? 'crosshair' : '';
      flash(mode ? `Collision & nav: ${CN_NAMES[mode]} — 1-4 / Tab switch tools, F3 done` : 'Left the collision tool');
      renderColNav();
      dirty = overlayDirty = true;
    }
    function cnPointerDown(p, shift) {
      cnShift = shift;
      if (cnMode === 2) return cnClick(p, shift);
      if (cnMode === 4) {
        if (!shift) return cnWaypointClick(p);
        navNow(true);
        const hit = cnWaypointAt(p);
        return hit === MIN_REF ? flash('Shift+click a waypoint to delete it') : cnDeleteWaypoint(hit);
      }
      cnAim = cnRayAt(p);
      cnStrokeStart(shift);
    }
    /** Aims at most once a frame (a ray against the map and the whole collision), dabbing while a stroke is on. */
    function cnPointerMove(p, shift) {
      if (cnShift !== shift) overlayDirty = true;
      cnShift = shift;
      if (!cnPending)
        requestAnimationFrame(() => {
          const q = cnPending;
          cnPending = null;
          if (stopped || !cnMode) return;
          if (cnMode === 4) cnHover = cnWaypointAt(q);
          else cnAim = cnRayAt(q);
          overlayDirty = true;
          if (cnStroke) cnDab();
        });
      cnPending = p;
    }
    /**
     * The wheel in the tool: brush size in Erase (x1.15 a notch), turning the selected piece in Add (15°, Shift 5°). A
     * notch is 100 pixels (3 lines) of wheel, so a trackpad's many small events add up to the same as a mouse's notches.
     */
    let cnWheelAcc = 0;
    function cnWheel(e) {
      const delta = e.deltaY || e.deltaX;
      if (!delta) return;
      const notches = -delta / (e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 1 : 100);
      if (cnMode === 1 || cnMode === 3) return cnSetBrush(cnBrush * Math.pow(1.15, notches));
      cnWheelAcc += notches;
      const n = Math.trunc(cnWheelAcc + Math.sign(cnWheelAcc) * 1e-6); // 0.3 + 0.3 + 0.3 + 0.1 is a whole notch
      if (!n) return;
      cnWheelAcc -= n;
      cnTurn(n * (e.shiftKey ? 5 : 15));
    }
    /** The tool's keys; true when one was used. */
    function cnKey(e, k) {
      const shift = e.shiftKey;
      if (k === 'escape') {
        cnStrokeEnd();
        if (cnMode === 4 && cnNode !== MIN_REF) {
          cnNode = MIN_REF;
          overlayDirty = true;
          flash('Deselected');
          renderColNav();
        } else if (cnSel >= 0) cnSelect(-1);
        else setCnMode(0);
        return true;
      }
      if (e.altKey) return false;
      if (['1', '2', '3', '4'].includes(k)) return setCnMode(Number(k)), true;
      if (k === 'tab') return cnCycle(shift ? -1 : 1), true;
      if (['g', 'b', 'n', 'k', 'home'].includes(k)) return true;
      if (cnMode === 1 || cnMode === 3) {
        if (k === '[' || k === '{') return cnSetBrush(cnBrush / 1.15), true;
        if (k === ']' || k === '}') return cnSetBrush(cnBrush * 1.15), true;
        return false;
      }
      if (cnMode === 4) {
        if (k === 'delete' || k === 'backspace') return cnDeleteWaypoint(cnNode !== MIN_REF ? cnNode : cnHover), true;
        return false;
      }
      if (k === 'delete' || k === 'backspace') return cnDelete(), true;
      if (k === 'r') return cnCycleShape(shift ? -1 : 1), true;
      if (k === '[' || k === '{') return cnResize(shift ? 1 : 0, false), true;
      if (k === ']' || k === '}') return cnResize(shift ? 1 : 0, true), true;
      if (k === '-' || k === '_') return cnResize(2, false), true;
      if (k === '+' || k === '=') return cnResize(2, true), true;
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'pageup', 'pagedown'].includes(k)) return cnMove(k, shift);
      return false;
    }

    // The panel.
    const cnBtns = [
      button('Off', () => setCnMode(0), { 'aria-pressed': 'true', title: 'Leave the collision tool (F3, Esc)' }),
      button('Erase', () => setCnMode(1), { 'aria-pressed': 'false', title: 'Erase collision by hand: drag over it (F3, 1)' }),
      button('Add', () => setCnMode(2), { 'aria-pressed': 'false', title: 'Add collision: walls, blocks, floors and ramps (2)' }),
      button('Paint nav', () => setCnMode(3), { 'aria-pressed': 'false', title: 'Paint where bots can walk, or Shift+drag to erase it (3)' }),
      button('Waypoints', () => setCnMode(4), { 'aria-pressed': 'false', title: 'Add, link, unlink and delete the waypoints bots head for (4)' }),
    ];
    const cnNum = (label, min, max, step) => el('input', { type: 'number', class: 'input input-sm', min, max, step, 'aria-label': label });
    const cnBrushIn = cnNum('Brush radius, in metres', String(CN_MIN_BRUSH / 100), String(CN_MAX_BRUSH / 100), '0.5');
    const cnShapeSel = el('select', { class: 'input input-sm', 'aria-label': 'Piece shape' }, CN_SHAPES.map((s) => el('option', { value: s }, s)));
    const cnDims = ['Width', 'Height', 'Depth'].map((n) => cnNum(`${n}, in metres`, '0.1', '200', '0.5'));
    const cnYawIn = cnNum('Turn, in degrees', '-180', '180', '5');
    const cnDelBtn = button('Delete piece', cnDelete, { title: 'Delete the selected piece (Del, or Shift+click it)' });
    const cnRestoreBtn = button('Bring back erased', cnRestoreAll, { title: 'Bring back all the collision erased by hand (one undo step)' });
    const cnRow = (label, input, unit, title) => el('label', { class: 'stage-fog-row', title }, label, input, el('span', {}, unit));
    const cnBrushRow = cnRow('Brush', cnBrushIn, 'm', 'Triangles whose centre is this close to the pointer are erased');
    const cnPieceRows = [
      cnRow('Shape', cnShapeSel, '', 'Wall and Block: bots walk around it; Floor and Ramp: also on it (R)'),
      cnRow('Width', cnDims[0], 'm', 'Across ([ ])'),
      cnRow('Height', cnDims[1], 'm', 'Shift+[ ]'),
      cnRow('Depth', cnDims[2], 'm', 'Along; a ramp rises this way (- +)'),
      cnRow('Turn', cnYawIn, '°', 'About the vertical (wheel)'),
    ];
    const cnCellIn = cnNum('Nav square size, in metres', '0.5', '4', '0.25');
    const cnCellRow = cnRow('Squares', cnCellIn, 'm', 'Each dab lays nav squares this size on the surface under the brush');
    const cnClearNavBtn = button('Clear nav edits', cnClearNav, { title: 'Take back every square painted and every patch erased (one undo step)' });
    const cnClearWpBtn = button('Clear waypoint edits', cnClearWaypoints, {
      title: 'Take back every waypoint added or deleted and every link made or cut (one undo step)',
    });
    const cnTools = el('div', { class: 'toolbar' }, cnDelBtn, cnRestoreBtn, cnClearNavBtn, cnClearWpBtn);
    const cnLine = el('p', { class: 'muted stage-count' });
    const cnNote = el('p', { class: 'muted' });
    const cnInput = (inp, fn) =>
      inp.addEventListener('change', () => {
        const x = Number(inp.value);
        if (inp.value === '' || !Number.isFinite(x)) return renderColNav();
        fn(x);
      });
    cnInput(cnBrushIn, (m) => cnSetBrush(m * 100));
    cnInput(cnCellIn, (m) => {
      cnCell = Math.max(50, Math.min(400, Math.round((m * 100) / 25) * 25));
      overlayDirty = true;
      renderColNav();
    });
    cnShapeSel.addEventListener('change', () => cnSetShape(cnShapeSel.value));
    cnDims.forEach((inp, axis) =>
      cnInput(inp, (m) => {
        const i = cnSel, v = edit.colnav.Volumes[i], key = 'WHD'[axis];
        const n = Math.max(10, Math.min(20000, Math.round(m * 100)));
        cnSizes[v ? v.Shape : cnShape][axis] = n;
        if (v) colNavChange('Size piece', (c) => void (c.Volumes[i][key] = n));
        overlayDirty = true;
        renderColNav();
      }),
    );
    cnInput(cnYawIn, (deg) => {
      const i = cnSel;
      if (i >= 0) colNavChange('Turn piece', (c) => void (c.Volumes[i].Yaw = wrapDegrees(deg)));
      else cnYaw = wrapDegrees(deg);
      overlayDirty = true;
      renderColNav();
    });
    function renderColNav() {
      if (!cnBox.contains(cnLine))
        cnBox.replaceChildren(el('div', { class: 'toolbar' }, cnBtns), cnBrushRow, cnCellRow, ...cnPieceRows, cnTools, cnLine, cnNote);
      const live = !!colRead?.live, layers = colRead?.layers.length ?? 0;
      cnBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(i === cnMode)));
      cnBtns[1].disabled = !live;
      cnBtns[2].disabled = !layers;
      cnBtns[3].disabled = !navRead?.nav;
      cnBtns[4].disabled = !navRead?.path;
      const c = edit.colnav;
      const navEdits = c.NavCells.length + c.NavErase.length, wpEdits = c.Waypoints.length + c.RemovedWaypoints.length + c.Links.length + c.Cuts.length;
      cnCellIn.value = fmtM(cnCell);
      cnCellRow.hidden = cnMode !== 3;
      cnClearNavBtn.hidden = cnMode !== 3 || !navEdits;
      cnClearWpBtn.hidden = cnMode !== 4 || !wpEdits;
      cnBrushRow.title = cnMode === 3 ? 'Nav is painted, or erased, within this distance of the pointer' : 'Triangles whose centre is this close to the pointer are erased';
      const v = edit.colnav.Volumes[cnSel] || null, shape = v ? v.Shape : cnShape, dims = v ? [v.W, v.H, v.D] : cnSizes[shape];
      cnBrushIn.value = fmtM(cnBrush);
      cnShapeSel.value = shape;
      cnDims.forEach((inp, k) => (inp.value = fmtM(dims[k])));
      cnYawIn.value = String(Math.round((v ? v.Yaw : cnYaw) * 10) / 10);
      cnBrushRow.hidden = cnMode !== 1 && cnMode !== 3;
      cnPieceRows.forEach((r) => (r.hidden = cnMode !== 2));
      cnDelBtn.hidden = cnMode !== 2;
      cnDelBtn.disabled = !v;
      const erased = cnErasedCount(), n = edit.colnav.Volumes.length;
      cnRestoreBtn.hidden = !erased || cnMode >= 3;
      cnTools.hidden = cnDelBtn.hidden && cnRestoreBtn.hidden && cnClearNavBtn.hidden && cnClearWpBtn.hidden;
      const sq = Math.ceil(c.NavCells.length / 2), hand = c.Waypoints.length;
      cnLine.textContent =
        cnMode === 3
          ? `${plural(sq, 'square')} painted · ${plural(c.NavErase.length, 'patch', 'patches')} erased`
          : cnMode === 4
            ? `${plural(hand, 'waypoint')} added · ${c.RemovedWaypoints.length} deleted · ${plural(c.Links.length, 'link')} made · ${c.Cuts.length} cut${cnNode !== MIN_REF ? ' · one selected' : ''}`
            : `${plural(erased, 'triangle')} erased · ${plural(n, 'piece')} added${v ? ` · piece ${cnSel + 1} selected` : ''}`;
      cnNote.textContent =
        cnMode === 3
          ? 'Drag over the ground to paint where bots walk (cyan); Shift+drag erases it (red). Bots use it once it joins the nav they already walk on.'
          : cnMode === 4
            ? 'Click empty ground to add a waypoint; click one to select it, then another to link or unlink them; Shift+click or Del deletes one. Your waypoints have green posts.'
            : cnNoteText(v, shape, live, layers);
    }
    function cnNoteText(v, shape, live, layers) {
      return !colRead
        ? 'Reading the collision…'
        : !layers
          ? 'This stage has no collision (.ccp) to edit.'
          : cnMode === 1
            ? 'Drag over the collision to erase it (red); Shift+drag brings it back (green). Collision carried off with a moved object is left alone.'
            : cnMode === 2
              ? v
                ? 'Arrows and PgUp/PgDn move it, the wheel turns it, Del deletes it; click it again or Esc to let go.'
                : `Click the map to place a ${shape.toLowerCase()}; click a piece to select it.`
              : `F3, Erase, Add, Paint nav or Waypoints: change the collision and the bot navigation the download writes; the changes are saved with the edits.${live ? '' : " This collision has an unfamiliar layout, so it can't be erased here."}`;
    }
    renderColNav();
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
      selection = { mesh: m, object: ob || null, hit };
      selectionChanged();
    }
    function select(o) {
      selection = o ? { mesh: o.mesh, object: o, hit: null } : null;
      selectionChanged();
    }
    function selectionChanged() {
      if (gdrag) cancelDrag();
      edit.history.breakMerge();
      hover = -1;
      canvas.style.cursor = '';
      renderInspect();
      renderPanel();
      gimmickRefresh();
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
      const { mesh: m, object: ob, hit } = selection;
      const b = hit?.batch || (ob ? (ob.spans.length ? m.batches[ob.spans[0]] : null) : m.batches[0]) || null;
      const texName = (n) => (n ? (scene.textures.has(lower(n)) ? n : `${n} (not in this bundle)`) : '—');
      const rows = [
        ['Object', ob ? shortObjectName(ob.name) : shortName(m.name)],
        ob?.label ? ['Node', ob.label] : null,
        ['File', m.name.split('/')[0]],
        ['Layer', GROUPS.find(([k]) => k === m.kind)?.[1] || m.kind],
        ['Texture', texName(b?.texture)],
        ['Lightmap', texName(b?.lightmap)],
        ['Triangles', (ob ? ob.triCount : Math.round(m.indices.length / 3)).toLocaleString()],
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

    // ----- gimmicks: the stage's gimmick table (Data/json/stage/<id>_stage_gimmick.json) -----
    const gimmickObjects = new Map(edit.objects.filter((o) => o.gimmick).map((o) => [o.gimmick, o]));
    const gimmickNote = el('p', { class: 'muted stage-count' });
    const gimmickBtn = button('Download gimmick table', downloadGimmickTable, {
      title: "Write the moved, turned and removed gimmicks into a copy of the stage's gimmick table, as the desktop export does",
    });
    const gimmickList = el('div', { class: 'stage-gimmick-list' });
    const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    function renderGimmicks() {
      const gm = scene.gimmicks;
      if (!gm) {
        gimmickBox.replaceChildren(
          el('p', { class: 'muted' }, ctx.dataFiles?.('json/stage').length
            ? 'No gimmick table found for this stage'
            : "Open the game's Data folder to see this stage's gimmicks (the table is in json/stage, the models in gimmick)."),
        );
        return;
      }
      for (const o of gimmickObjects.values()) placementFromState(o);
      const changed = gm.placements.filter(placementChanged);
      const added = changed.filter((g) => g.isNew).length, removed = changed.filter((g) => g.removed && !g.removed0).length;
      const moved = changed.length - removed - added, own = gm.placements.filter((g) => !g.isNew).length;
      gimmickNote.textContent =
        `${own} placements in ${gm.table.name}; ${[...gimmickObjects.keys()].filter((g) => !g.isNew).length} shown with their models. ` +
        (changed.length
          ? `Edited: ${moved} moved, ${removed} removed${added ? `, ${added} added` : ''}.`
          : 'Select one to move, turn or remove (Del) it.');
      gimmickBtn.disabled = !changed.length;
      if (!gimmickBox.contains(gimmickList))
        gimmickBox.replaceChildren(gimmickNote, el('div', { class: 'toolbar' }, gimmickBtn, addBtn), catalogBox, gimmickList);
      const sel = selected();
      const rows = gm.placements
        .filter((g) => !(g.isNew && g.removed))
        .sort((a, b) => byText(a.type, b.type) || byText(a.tag, b.tag))
        .map((g) => {
          const o = gimmickObjects.get(g);
          const value = !o ? 'no model' : g.removed ? 'removed' : placementChanged(g) ? (g.isNew ? 'new' : 'moved') : g.removed0 ? 'off' : '';
          const row = el(
            'div',
            { class: `stage-layer stage-gimmick${o ? '' : ' nomodel'}${o && o === sel ? ' on' : ''}`, title: `${g.model} at ${g.position.map((x) => x.toFixed(2)).join(', ')}` },
            el('span', { class: 'stage-layer-name' }, `${g.type} · ${g.tag}`),
            el('span', { class: 'muted' }, value),
          );
          if (o) {
            row.tabIndex = 0;
            row.setAttribute('role', 'button');
            const go = () => {
              select(o);
              frameSelection();
              canvas.focus({ preventScroll: true }); // so Del, the arrows and the gizmo keys act on it at once
            };
            row.addEventListener('click', go);
            row.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), go()));
          }
          return row;
        });
      gimmickList.replaceChildren(...rows);
    }
    // New gimmicks: a kind from the catalogue (every model the game's stage tables place), or a copy of the selected one.
    const addBtn = button('Add a gimmick…', () => toggleCatalog(), {
      title: "Place a new gimmick, set up like one from any stage's table (the game decides how it behaves from its type)",
    });
    const catalogBox = el('div', { class: 'stage-gimmick-catalog' });
    catalogBox.hidden = true;
    let catalogKinds = null, adding = false;
    async function toggleCatalog(show = catalogBox.hidden) {
      catalogBox.hidden = !show;
      addBtn.setAttribute('aria-expanded', String(show));
      if (!show) return;
      if (!catalogKinds) {
        catalogBox.replaceChildren(el('p', { class: 'muted' }, "Reading every stage's gimmick table…"));
        try {
          catalogKinds = await scene.gimmicks.catalogue();
        } catch (e) {
          catalogBox.replaceChildren(el('p', { class: 'muted' }, `The gimmick catalogue could not be read: ${e.message}`));
          return;
        }
      }
      const filter = el('input', { type: 'search', class: 'stage-gimmick-filter', placeholder: 'Filter by type or model', 'aria-label': 'Filter the gimmicks to add' });
      const list = el('div', { class: 'stage-gimmick-list' });
      const fill = () => {
        const q = filter.value.trim().toLowerCase();
        const kinds = catalogKinds.filter((k) => !q || `${k.type} ${k.model} ${k.stage}`.toLowerCase().includes(q));
        list.replaceChildren(
          ...(kinds.length
            ? kinds.map((k) => {
                const row = el(
                  'div',
                  { class: 'stage-layer stage-gimmick', tabindex: '0', role: 'button', title: `Set up like ${k.tag} in ${k.stage}. The game decides how it behaves from its type.` },
                  el('span', { class: 'stage-layer-name' }, `${k.type} · ${k.model}`),
                  el('span', { class: 'muted' }, k.stage),
                );
                row.addEventListener('click', () => addGimmick(k));
                row.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), addGimmick(k)));
                return row;
              })
            : [el('p', { class: 'muted' }, catalogKinds.length ? 'No gimmick matches the filter' : 'No gimmick models found')]),
        );
      };
      filter.addEventListener('input', fill);
      filter.addEventListener('keydown', (e) => e.key === 'Escape' && (e.preventDefault(), toggleCatalog(false), addBtn.focus()));
      catalogBox.replaceChildren(filter, list);
      fill();
      filter.focus();
    }
    /** Makes hidden new placements objects of the map (their models loaded first); returns their objects. */
    async function addPlacements(list) {
      const gm = scene.gimmicks, was = status.textContent;
      let templates;
      try {
        templates = await gm.kit.load(list.map((g) => g.model), (t) => (status.textContent = t));
      } finally {
        status.textContent = was;
      }
      for (const [k, img] of scene.textures) if (!glTex.has(k)) glTex.set(k, uploadTexture(gl, img, aniso));
      const out = [];
      for (const g of list) {
        const tpl = templates.get(lower(g.model));
        if (!tpl) continue;
        const m = placementMesh(tpl, g);
        m.normals = patchNormals(m.positions, m.indices, m.normals);
        m.bounds = boundsOf(m.positions, 0, m.positions.length / 3);
        m.visible = true;
        m.sky = false;
        const [o] = collectObjects([m]);
        o.index = edit.objects.length; // after the stage's: its collision and nav owners are numbered by object
        setUpGimmick(o);
        writeObject(o);
        scene.meshes.push(m);
        meshGpu(m);
        edit.objects.push(o);
        gimmickObjects.set(g, o);
        gm.placements.push(g);
        out.push(o);
      }
      return out;
    }
    /** Where a new gimmick goes: the ground under the middle of the view, else the point the camera turns about. */
    function groundAhead() {
      const { o, d } = rayAt(canvas.clientWidth / 2, canvas.clientHeight / 2);
      const hit = pick(scene, o, d);
      return hit ? hit.point : cam.target.slice();
    }
    async function addGimmick(kind, at = null, turn = [0, 0, 0]) {
      const gm = scene.gimmicks;
      if (!gm || adding) return;
      adding = true;
      try {
        const used = new Set([...gm.placements.map((g) => g.tag), ...edit.gimmickOther.map((x) => x.Tag)]);
        const g = newPlacement(kind, newGimmickTag(kind, used, gm.table.text), at ?? groundAhead(), turn);
        const [o] = await addPlacements([g]);
        if (!o) return toast(`The model ${kind.model} could not be built.`, 'error');
        change([o], () => stateOfPlacement({ ...g, removed: false }), `Add ${kind.type}`);
        edit.history.breakMerge();
        select(o);
        canvas.focus({ preventScroll: true });
        toast(`Added ${kind.type} · ${g.tag}. Move it into place; Del removes it, Ctrl+Z takes it back.`);
      } catch (e) {
        console.error(e);
        toast(`The gimmick could not be added: ${e.message}`, 'error');
      } finally {
        adding = false;
      }
    }
    /** Ctrl+D: a new placement of the selected gimmick's model, turned as it is, beside it (DuplicateGimmick). */
    async function duplicateGimmick() {
      const o = selected();
      if (!o?.gimmick) return toast(o ? 'Only gimmicks can be duplicated here so far.' : 'Select a gimmick to duplicate it.');
      const gm = scene.gimmicks, g = placementFromState(o);
      let kinds;
      try {
        kinds = catalogKinds ?? (catalogKinds = await gm.catalogue((t) => (status.textContent = t)));
      } catch (e) {
        return toast(`The gimmick catalogue could not be read: ${e.message}`, 'error');
      }
      const kind = kinds.find((k) => lower(k.model) === lower(g.model));
      if (!kind) return toast('No gimmick of this model to copy settings from.');
      // Like the desktop: the copy keeps the turn and goes where the view aims.
      await addGimmick(kind, null, g.rotation.slice());
    }
    async function downloadGimmickTable() {
      const gm = scene.gimmicks;
      if (!gm) return;
      for (const o of gimmickObjects.values()) placementFromState(o);
      let r;
      try {
        r = editedGimmickTable(gm.table.text, gm.placements);
        if (!r) return toast('No gimmick has been moved, turned or removed yet.');
        downloadBytes(await gimmickTableBytes(gm.table, r.text), gm.table.name, 'application/json');
      } catch (e) {
        console.error(e);
        return toast(`The gimmick table could not be written: ${e.message}`, 'error');
      }
      toast(`Gimmicks: ${r.moved} moved, ${r.removed} removed, ${r.added} added — table written to ${gm.table.name}.`);
    }
    gimmickRefresh = renderGimmicks;
    renderGimmicks();

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
      if (cnMode && e.button === 0) return cnPointerDown(local(e), e.shiftKey);
      if (e.button === 0 && !gdrag) {
        const p = local(e), handle = gizmoHit(p);
        if (handle >= 0 && startGizmo(handle, p)) return;
      }
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, pan: cnMode ? e.button === 1 : e.button !== 0 || e.shiftKey, moved: false };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (gdrag) return moveGizmo(local(e), e);
      if (cnMode && !drag) return cnPointerMove(local(e), e.shiftKey);
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
      if (cnStroke) return cnStrokeEnd();
      const d = drag;
      drag = null;
      if (!d || d.moved || e.button !== 0) return;
      const p = local(e);
      const { o, d: dir } = rayAt(p.x, p.y);
      inspect(pick(scene, o, dir));
    });
    canvas.addEventListener('pointercancel', () => {
      if (gdrag) cancelDrag();
      cnStrokeEnd();
      drag = null;
    });
    canvas.addEventListener('dblclick', (e) => {
      if (cnMode) return;
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
        if (cnMode && cnMode !== 4 && !e.altKey) return cnWheel(e);
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
        cnStrokeEnd();
        if (k === 'y' || e.shiftKey) redo();
        else undo();
        return;
      }
      if (k === 'f3' && !ctrl) {
        e.preventDefault();
        return setCnMode(cnMode ? 0 : colRead?.live ? 1 : 2);
      }
      if (ctrl && !e.altKey && !e.shiftKey && k === 'd') {
        e.preventDefault();
        return duplicateGimmick();
      }
      if (cnMode && !ctrl && cnKey(e, k)) return e.preventDefault();
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
      else if (k === 'p') toggleNav();
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

    // ----- Find a feature (Ctrl+K): the map's keyboard shortcuts, sent to the map as the key would be -----
    const press = (key, mods = {}) => () => {
      canvas.focus();
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }));
      canvas.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true, ...mods }));
    };
    setViewCommands(() => {
      if (!view.isConnected) return null;
      const cmd = (label, keys, run, hint = '') => ({ label, keys, run, hint, section: 'Map shortcuts' });
      const list = [
        cmd('Undo', 'Ctrl+Z', press('z', { ctrlKey: true })),
        cmd('Redo', 'Ctrl+Y', press('y', { ctrlKey: true })),
        cmd(cnMode ? 'Leave the collision & nav editor' : 'Collision & nav editor', 'F3', press('F3'), 'Erase or add collision, paint nav, edit waypoints'),
        cmd('Collision lines on or off', 'H', press('h')),
        cmd('Nav lines on or off', 'P', press('p')),
        cmd('Frame the selected object', 'F', press('f')),
        cmd('Fly the camera', 'W A S D  Q E', () => canvas.focus(), 'Click the map, then hold the keys; drag to look, wheel to zoom'),
      ];
      if (cnMode) {
        CN_NAMES.slice(1).forEach((n, i) => list.push(cmd(`${n} tool`, String(i + 1), press(String(i + 1)))));
        list.push(cmd('Next tool', 'Tab', press('Tab')), cmd('Leave the tool or deselect', 'Esc', press('Escape')));
      } else {
        ['Move', 'Rotate', 'Scale'].forEach((n, i) => list.push(cmd(`${n} tool`, String(i + 1), press(String(i + 1)))));
        if (selected())
          list.push(
            cmd('Hide or show the selected object', 'Delete', press('Delete')),
            cmd('Make the selected object Solid or not', 'K', press('k')),
            cmd('Put the selected object back where it was', 'Home', press('Home')),
            cmd('Select the next object', 'Tab', press('Tab')),
            cmd('Nudge the selected object', 'Arrows, Page Up/Down', () => canvas.focus(), 'Shift for bigger steps, Ctrl to turn it'),
            cmd('Deselect', 'Esc', press('Escape')),
          );
      }
      return list;
    });
  }

  return view;
}
