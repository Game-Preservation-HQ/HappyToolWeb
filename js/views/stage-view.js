// Map viewer and editor: draws a Steam stage bundle with WebGL2 — terrain, models, prop packs and sky, colour
// textures on UV0 and baked lightmaps on UV1 — with an orbit/fly camera, layer toggles and click to inspect (slice 1),
// and moves, turns, scales and hides objects with a gizmo, keys and a placement panel (slice 2, see stage-edit.js).
// Lighting, lightmap modes and sky placement follow HappyTool/GUI/StageViewerForm.cs (InitGl, DrawMesh, sky pass).
// The sky can be swapped for another stage's, a picture or a colour preset (slice 3, see stage-sky.js).
// The stage's collision can be erased by hand and added to with walls, blocks, floors and ramps (see stage-colnav.js).
import { el, button, toast, downloadBlob, pickFiles, confirmBox, debounce, openDialog } from '../ui.js';
import { BRUSH_TOOLS, RAISE, MIN_BRUSH, MAX_BRUSH, MIN_STRENGTH, MAX_STRENGTH, BRUSH_COLOURS, stockBounds, groundPieces, coverGround, groundHeights, sculptObject, liftFor, brushGroundY, brushStep, encodeSculpt, decodeSculpt, sculptWarp, warpNav } from './stage-terraform.js';
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
import { setViewCommands, openPalette } from '../palette.js';
import { takePad, PAD } from '../gamepad.js';
import { decodeDds } from '../formats/dds.js';
import { buildSteamStage } from '../formats/steam-stage.js';
import { stripTextureExtension } from '../formats/rrm.js';
import {
  IDENTITY, AXES, UNIFORM, History, collectObjects, writeObject, withState, sameState, isEmpty, wrapDegrees, niceStep,
  shortObjectName, editsFile, readEditsFile, loadStored, store, stageKey, ringPoint, distanceToSegment,
  closestParamOnAxis, screenAngle, screenTurnSign, turnAbout, isIdentityTransform, rotation, turnState, turnStateBy,
  scaleState, rotationDelta,
} from './stage-edit.js';
import {
  GRID_SHOW, loadGrid, saveGrid, sizeText, gridSummary, stepSize, snapAxisMove, snapCarryMove, gridDrawer, drawAxisIndicator,
} from './stage-grid.js';
import { forgeMenu } from '../forge-menu.js';
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
import { readNav, navLines, parseNavMesh, parsePathGraph, writeNavMesh, writePathGraph, is360Spd, spd360ToSteam } from '../formats/stage-nav.js';
import { parseGpt, writeGpt, followedPath, movedPaths } from '../formats/gimmick-paths.js';
import { latin1 } from '../formats/gimmick-script.js';
import {
  SETUP_KEY, cleanSetup, setupFeature, setupFromFeature, readStageScript, applyStageScript, applyTactics, gimmickSetupRules,
} from './stage-gimmick-setup.js';
import { rebuildNav, Blocker, MIN_REF, nodeRefKey, navSummary, navChanged, pathChanged } from '../formats/stage-nav-edit.js';
import {
  COLNAV_KEY, CN_SHAPES, CN_SIZES, CN_MIN_BRUSH, CN_MAX_BRUSH, readColNav, cloneColNav, colNavFeature, removedFlags,
  setRemovedFlags, volumeTriangles, rayTriangle, rayTris, eraseAt,
} from '../formats/stage-colnav.js';
import {
  STAGE_VOLUMES_KEY, removedFromFeature, volumesFeature, parseStageVolumes, readTrapZones, volumeFrame, gimmickFrame,
  carried as carriedFrame, trapLines, volumeLines, volumeBounds, ownerOf, trapKindName, trapKindColour, VOLUME_COLOUR, cssColour,
  describeVolume, describeTrap, movedVolumeRecord, rewriteStageVolumes, stageVolumeTriangles,
} from './stage-zones.js';
import { PLAY, PlayWorld, isCharacterLayer, newPlayer, playStep, playCamera, playWheel, shadowPoint, hudText, playDrawer } from './stage-play.js';
import { startAvatar, avatarStep, avatarHud, avatarDrawer } from './stage-avatar.js';
import { gimmickUse, writePosed } from './stage-gimmick-play.js';
import { shadowInputs, eraseShadows } from '../formats/stage-shadows.js';
import { loadAvatar } from '../formats/avatar.js';
import {
  EFFECTS_KEY, EFFECT_COLOUR, SOUND_COLOUR, FILTERS as EFFECT_FILTERS, effectName, movedFromFeature, effectsFeature,
  loadEffectTable, movedEffectTable, effectTableBytes, postOf, markerLines, rangeRing, oneDecimal, describeEffect,
} from './stage-effects.js';
import {
  MINIMAP_KEY, STOCK, EDITED, WHOLE, PICTURE, MODE_NAMES as MINIMAP_MODES, isMinimapName, readStockMinimap, minimapFromFeature,
  minimapFeature, pictureFileName, seaColour, changedFootprints, changeMask, mixMinimap, averageSamples, topDownMatrix,
  TOP_DOWN_EYE, leftOutOfMinimap, pictureMinimap, minimapDds, stepMode, storeMinimapPicture, loadMinimapPicture, pictureDataUrl,
} from './stage-minimap.js';

// The play test's warrior, loaded once per Data folder (Avatar()): folder -> {promise, done, avatar, note}.
const avatarJobs = new Map();
const FOV = Math.PI / 4;
const MAX_GRAB = 3000; // cm: a box select leaves out objects this wide or tall (MaxGrabSize), gimmicks excepted
const SKY_RADIUS = 920; // ClipFar 1000 * 0.92 when StageCameraParam.json isn't read (ComputeSkyRenderRadius)
const LM_KEY = 'happytool-web-lightmap';
const PANEL_KEY = 'happytool-web-map-panel'; // '0' while the side panel is hidden
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
 * the collision edits, linked objects and gimmick setup when there are any.
 */
function fogFeatures(e) {
  const out = { ...e.otherFeatures };
  const fog = e.fogStock ? (fogChanged(e) ? e.fog : null) : e.storedFog;
  if (fog) out.fog = { Enable: fog.Enable, Near: fog.Near, Far: fog.Far, Color: fog.Color };
  const cn = colNavFeature(e.colnav);
  if (cn) out[COLNAV_KEY] = cn;
  // Linked objects (StageViewerForm.Linking.cs LinkEdits): groups of object names; as read until the map reads them.
  if (e.links) {
    if (e.links.length) out.links = { Groups: e.links.map((l) => l.map((o) => o.name)) };
  } else if (e.storedLinks) out.links = e.storedLinks;
  // Gimmick setup (StageViewerForm.GimmickSetup.cs): only tags the loaded table has; with no table, every edit as read.
  const gs = setupFeature(e.gimmickSetup, e.gimmickTags?.() ?? null);
  if (gs) out[SETUP_KEY] = gs;
  // Stage collision left out of the map (StageViewerForm.Zones.cs StageVolumeEdits).
  const sv = volumesFeature(e.zoneRemoved);
  if (sv) out[STAGE_VOLUMES_KEY] = sv;
  // Effects and sounds moved by hand (StageViewerForm.Effects.cs EffectEdits).
  const fx = effectsFeature(e.effectMoved);
  if (fx) out[EFFECTS_KEY] = fx;
  // The minimap (StageViewerForm.Minimap.cs): none while it's the stage's own.
  const mm = minimapFeature(e.minimap);
  if (mm) out[MINIMAP_KEY] = mm;
  return Object.keys(out).length ? out : null;
}
const lower = (s) => (s ? s.toLowerCase() : s);
const shortName = (n) => n.replace(/\\/g, '/').split('/').slice(-2).join('/');
const sameBytes = (a, b) => a.length === b.length && a.every((x, k) => x === b[k]);

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
  // The stage's effects and sounds (its effect table; StageViewerForm.Effects.cs LoadEffects).
  let effects = null;
  if (source?.dataFiles) {
    try {
      effects = await loadEffectTable({ ids: [gimmicks?.table.stageId, ...source.ids], dataFiles: source.dataFiles });
      if (effects) console.info(`Map viewer: ${effects.log}`);
    } catch (e) {
      console.warn(`Map viewer: the effect table could not be read: ${e.message}`);
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
    effects,
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
function pick(scene, o, d, skip = null) {
  let best = null;
  const skipped = skip ? new Set(Array.isArray(skip) ? skip : [skip]) : null;
  for (const m of scene.meshes) {
    if (!m.visible || m.sky || !rayHitsBox(o, d, m.bounds)) continue;
    const p = m.positions, idx = m.indices;
    const own = new Set();
    if (skipped && m.triObject) m.editObjects.forEach((x, i) => skipped.has(x) && own.add(i));
    for (let t = 0; t + 2 < idx.length; t += 3) {
      if (own.size && own.has(m.triObject[t / 3])) continue; // `skip` (objects being carried) is not hit
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
    links: null, // linked objects [[object, ...], ...] once the map has read them (Ctrl+G)
    sculpt: null, // the terraforming grid (Sculpt) once read or started
    sculptFile: null, // the edits file's Sculpt as kept ({OriginX, …, Data}), null when nothing is terraformed
    tfGround: null, // the ground pieces (a Set) once terraforming has looked for them
    tfHeights: null, // the stage's ground height at each grid point (NaN off the ground)
    storedLinks: null, // the stored "links" feature, until then
    colnav: readColNav(null), // collision erased by hand and pieces added (the "colnav" feature)
    gimmickSetup: {}, // tag → {Team, Build, RamTarget, Number}: gimmicks set up differently (the "gimmickSetup" feature)
    zoneRemoved: new Set(), // names of the stage collision entries left out of the map (the "stagevolumes" feature)
    effectMoved: new Map(), // effect and sound ids → where they were moved by hand (the "effects" feature)
    minimap: { Mode: STOCK, Picture: null }, // the minimap setting (the "minimap" feature)
    minimapStock: null, // the bundle's own minimap: {name, n, rgba}, or {name, error}
    minimapPicture: null, // {name, blob}: the picture for the Picture mode, kept in this browser
    gimmickTags: scene.gimmicks ? () => new Set(scene.gimmicks.placements.map((g) => g.tag)) : null,
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
    edit.sculptFile = stored.Sculpt && typeof stored.Sculpt === 'object' && !Array.isArray(stored.Sculpt) ? stored.Sculpt : null;
    if (stored.Features && typeof stored.Features === 'object' && !Array.isArray(stored.Features)) {
      const { fog, [COLNAV_KEY]: cn, links, [SETUP_KEY]: gs, [STAGE_VOLUMES_KEY]: sv, [EFFECTS_KEY]: fx, [MINIMAP_KEY]: mm, ...rest } = stored.Features;
      edit.minimap = minimapFromFeature(mm);
      Object.assign(edit.gimmickSetup, setupFromFeature(gs));
      edit.zoneRemoved = removedFromFeature(sv);
      edit.effectMoved = movedFromFeature(fx);
      edit.storedFog = fogFromFeature(fog);
      edit.storedLinks = links ?? null;
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
    job.ids = ids;
    job.promise = loadScene(model, (t) => job.report?.(t), { ids, dataFiles: ctx.dataFiles });
    jobs.set(model, job);
  }
  job.report = (t) => (status.textContent = t);

  const layersBox = el('div', { class: 'stage-layers' });
  const placeBox = el('div', { class: 'stage-place' }, el('p', { class: 'muted' }, 'Reading the stage…'));
  const inspectBox = el('div', { class: 'stage-inspect' }, el('p', { class: 'muted' }, 'Click the map to select an object.'));
  const skyBox = el('div', { class: 'stage-sky' }, el('p', { class: 'muted' }, 'Reading the stage…'));
  const fogBox = el('div', { class: 'stage-sky stage-fog' }, el('p', { class: 'muted' }, 'Reading the stage…'));
  const minimapBox = el('div', { class: 'stage-sky stage-fog' }, el('p', { class: 'muted' }, 'Reading the stage…'));
  const terraformBox = el('div', { class: 'stage-sky stage-fog' }, el('p', { class: 'muted' }, 'Reading the stage…'));
  const downloadBox = el('div', { class: 'stage-sky' }, el('p', { class: 'muted' }, 'Reading the stage…'));
  const modelBox = el('div', { class: 'stage-sky' }, el('p', { class: 'muted' }, 'Reading the stage…'));
  const gimmickBox = el('div', { class: 'stage-gimmicks' }, el('p', { class: 'muted' }, 'Reading the stage…'));
  const cnBox = el('div', { class: 'stage-sky stage-cn' }, el('p', { class: 'muted' }, 'Reading the stage…'));
  const zoneBox = el('div', { class: 'stage-sky stage-zones' }, el('p', { class: 'muted' }, 'Reading the stage…'));
  const effectBox = el('div', { class: 'stage-sky stage-zones' }, el('p', { class: 'muted' }, 'Reading the stage…'));
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
  // Gimmick paths (the bundle's .gpt routes): shown only when the stage has some. gptFiles: entry name → its bytes.
  const gptPaths = [], gptFiles = new Map();
  const gptBox = el('input', { type: 'checkbox' });
  const gptLabel = el('label', {
    class: 'check',
    title: "The routes moving gimmicks follow (Rainbow's rafts …). A raft path's ends follow their harbours when you move them; the bundle download writes the moved paths.",
  }, gptBox, ' Paths');
  gptLabel.hidden = true;
  const resetBtn = button('Reset view', null, { title: 'Frame the whole stage (R)' });
  // The side panel (Placement … Layers): the ☰ button hides it to give the map the room, kept for the next visit.
  const side = el('aside', { class: 'stage-side' }, el('h3', {}, 'Placement'), placeBox, el('h3', {}, 'Inspect'), inspectBox, el('h3', {}, 'Gimmicks'), gimmickBox, el('h3', {}, 'Collision edits'), cnBox, el('h3', {}, 'Invisible zones'), zoneBox, el('h3', {}, 'Effects and sounds'), effectBox, el('h3', {}, 'Sky'), skyBox, el('h3', {}, 'Fog'), fogBox, el('h3', {}, 'Minimap'), minimapBox, el('h3', {}, 'Terraform'), terraformBox, el('h3', {}, 'Download'), downloadBox, el('h3', {}, 'Export 3D model'), modelBox, el('h3', {}, 'Layers'), layersBox);
  const panelBtn = button('☰', null, { class: 'btn btn-icon' });
  const showPanel = (on) => {
    const what = on ? 'Hide the side panel' : 'Show the side panel';
    side.hidden = !on;
    panelBtn.setAttribute('aria-expanded', String(on));
    panelBtn.setAttribute('aria-label', what);
    panelBtn.title = `${what} (Placement, Inspect, Gimmicks, Collision edits, Invisible zones, Effects and sounds, Sky, Fog, Minimap, Terraform, Download, Layers)`;
  };
  panelBtn.addEventListener('click', () => {
    const on = side.hidden;
    showPanel(on);
    try {
      localStorage.setItem(PANEL_KEY, on ? '1' : '0');
    } catch {
      /* private mode: kept for this visit only */
    }
  });
  try {
    showPanel(localStorage.getItem(PANEL_KEY) !== '0');
  } catch {
    showPanel(true);
  }
  const view = el(
    'div',
    { class: 'view stage-view' },
    el(
      'div',
      { class: 'toolbar' },
      panelBtn,
      button('← Entries', ctx.back, { title: 'Back to the list of entries in this bundle' }),
      el('strong', {}, model.name),
      lmSelect,
      el('label', { class: 'check' }, texBox, ' Textures'),
      colLabel,
      navLabel,
      gptLabel,
      resetBtn,
      el('span', { class: 'spacer' }),
      status,
    ),
    el(
      'div',
      { class: 'stage-body' },
      side,
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
    /** writeObject's hook: the terraforming grid on the object just placed. */
    const tfHook = (o) => edit.sculpt && sculptObject(o, edit.sculpt, !!edit.tfGround?.has(o));
    if (!edit.gimmicksPlaced) {
      // The gimmick meshes hold their models unturned: place them by their state once.
      edit.gimmicksPlaced = true;
      for (const o of edit.objects) if (o.gimmick) writeObject(o, tfHook);
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
    let selection = null; // {mesh, object, hit}: the main selected object
    let extra = []; // more selected objects (Ctrl+click, Ctrl+drag), after the main one
    let linkOf = new Map(); // object → the link it is in (Ctrl+G)
    let boxDrag = null; // a Ctrl+drag box: {x0, y0, x1, y1, remove, moved}
    let menu = null; // the controller menu, made with the map's other controls further down
    const grid = loadGrid();
    const drawGrid = gridDrawer(gl);
    // Selected objects' triangles as index buffers, for their tinted copies (made when an object is first drawn tinted).
    const selEbos = new Map();
    const selectionEbo = (o) => {
      let buffer = selEbos.get(o);
      if (buffer) return buffer;
      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, o.triangles, gl.STATIC_DRAW);
      selEbos.set(o, buffer);
      return buffer;
    };
    let tool = 0; // 0 move, 1 rotate, 2 scale
    let hover = -1; // gizmo handle under the pointer
    let gdrag = null; // gizmo drag in progress
    let dirty = true, overlayDirty = true;
    // The invisible zones' panel, lines and labels (set up with the gimmicks, below).
    let zoneRefresh = () => {}, drawZones = () => {}, drawZoneLabels = () => {};
    let effectRefresh = () => {}, drawEffects = () => {}, drawEffectLabels = () => {}, effectToolOff = () => {};
    // Terraforming (set up further down): the brush, the stroke and where the brush aims.
    let tfOn = false, tfTool = RAISE, tfRadius = 900, tfStrength = 1, tfStroke = null, tfPoint = null, tfAim = null;
    let tfReaim = false, tfCamSig = '', tfCtrl = false, tfSaveSeq = 0, terraformOff = () => {};
    let vp = null, viewW = 1, viewH = 1;
    const keys = new Set();
    // The play test (set up further down): {world, p, avatar, camDist, shadow, move, run, jump, attack, blow, guard}
    // while walking the map.
    let play = null, playGfx = null, avatarGfx = null, avatarWait = false;
    let flyMul = 1; // the controller's fly speed (LB/RB), also for WASD
    let carry = null; // the object the controller carries: {o, start, surface, lift, dist, offset, twisted, sig}
    let releasePad = null;
    let last = performance.now();
    const saveSoon = debounce(() => store(edit.stage, edit.objects, edit.sky, fogFeatures(edit), gimmickEdits(edit), edit.sculptFile), 250);

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
      const tintOf = new Map(); // mesh → its selected objects
      for (const o of play ? [] : selectedAll()) tintOf.has(o.mesh) ? tintOf.get(o.mesh).push(o) : tintOf.set(o.mesh, [o]);
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
          // The selected objects' triangles (spread through the mesh's batches) drawn again tinted, each from its own
          // index buffer, per batch span, pulled just in front of the untinted copy.
          const tinted = tintOf.get(m);
          if (tinted) {
            gl.depthFunc(gl.LEQUAL);
            gl.enable(gl.POLYGON_OFFSET_FILL);
            gl.polygonOffset(-1, -1);
            for (const so of tinted) {
              if (!so.spans.length) continue;
              gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, selectionEbo(so));
              for (let k = 0; k + 2 < so.spans.length; k += 3) {
                useBatch(m.batches[so.spans[k]]);
                range(so.spans[k + 1], so.spans[k + 1] + so.spans[k + 2], true);
              }
            }
            gl.disable(gl.POLYGON_OFFSET_FILL);
            gl.depthFunc(gl.LESS);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, meshGpu(m).ebo);
          }
        }
      }
      if (lineProg) drawCollision(vp, eye);
      if (lineProg) drawNav(vp, eye);
      if (lineProg) drawZones(vp, eye);
      if (lineProg) drawEffects(vp, eye);
      if (play) {
        if (play.avatar) (avatarGfx ??= avatarDrawer(gl)).draw(vp, play.p, play.avatar);
        (playGfx ??= playDrawer(gl)).draw(vp, play.p, play.shadow, !play.avatar);
      }
      if (drawGrid) drawGrid(grid, { vp, eye, f, viewH, fov: FOV, far });
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
    /** Everything selected: the main object first, then the others, each with the objects linked to it. */
    function selectedAll() {
      const o = selected();
      if (!o) return [];
      const out = [], seen = new Set();
      for (const x of [o, ...extra]) for (const y of [x, ...(linkOf.get(x) || [])]) if (!seen.has(y)) seen.add(y), out.push(y);
      return out;
    }
    /** The box round objects' world bounds (null when none has any). */
    function unionBounds(list) {
      let b = null;
      for (const o of list) {
        if (!o.bounds) continue;
        if (!b) b = { min: o.bounds.min.slice(), max: o.bounds.max.slice() };
        else
          for (let k = 0; k < 3; k++) {
            b.min[k] = Math.min(b.min[k], o.bounds.min[k]);
            b.max[k] = Math.max(b.max[k], o.bounds.max[k]);
          }
      }
      return b;
    }
    /** A gimmick's table has no scale and no Solid. */
    const fit = (o, st) => (st && o.gimmick && (st.solid || st.s.some((x) => x !== 1)) ? { ...st, s: [1, 1, 1], solid: false } : st);

    /** World point → CSS pixels in the canvas, or null behind the eye. */
    function project(p) {
      if (!vp) return null;
      const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
      const y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
      const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
      if (w <= 1e-6) return null;
      return { x: ((x / w) * 0.5 + 0.5) * viewW, y: (0.5 - (y / w) * 0.5) * viewH };
    }
    /**
     * The selection's gizmo: origin at the object's pivot + offset (several objects: the middle of their bounds), arms
     * 12% of the distance to the eye (GizmoLength).
     */
    function gizmo() {
      if (play) return null;
      const all = selectedAll(), o = all[0];
      if (!o) return null;
      const b = all.length > 1 ? unionBounds(all) : null;
      const origin = b ? centre(b) : o.pivot.map((x, k) => x + o.state.t[k]);
      const { eye } = basis();
      return { o, all, origin, len: Math.max(1e-3, Math.hypot(origin[0] - eye[0], origin[1] - eye[1], origin[2] - eye[2]) * 0.12) };
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
      drawGimmickPaths(g2);
      drawZoneLabels(g2);
      drawEffectLabels(g2);
      if (cnMode) drawCnOverlay(g2);
      if (tfOn) drawTfOverlay(g2);
      if (play) drawPlayHud(g2);
      // The axis indicator sits in the bottom-left corner, above the hint line that runs along the bottom.
      if (grid.axes) drawAxisIndicator(g2, hint.offsetParent ? hint.offsetTop - overlay.offsetTop : overlay.clientHeight, basis());
      if (boxDrag?.moved) {
        const x = Math.min(boxDrag.x0, boxDrag.x1), y = Math.min(boxDrag.y0, boxDrag.y1);
        const bw = Math.abs(boxDrag.x1 - boxDrag.x0), bh = Math.abs(boxDrag.y1 - boxDrag.y0);
        g2.fillStyle = boxDrag.remove ? 'rgb(240 82 95 / 0.08)' : 'rgb(255 212 59 / 0.08)';
        g2.fillRect(x, y, bw, bh);
        g2.strokeStyle = boxDrag.remove ? '#f0525f' : '#ffd43b';
        g2.lineWidth = 1;
        g2.setLineDash([5, 4]);
        g2.strokeRect(x + 0.5, y + 0.5, bw, bh);
        g2.setLineDash([]);
      }
      const g = gizmo();
      if (!g) return;
      g2.strokeStyle = 'rgb(255 212 59 / 0.7)';
      g2.lineWidth = 1;
      g2.beginPath();
      for (const o of g.all.slice(0, 500)) {
        const b = o.bounds;
        if (!b) continue;
        const corner = Array.from({ length: 8 }, (_, i) => project([0, 1, 2].map((k) => ((i >> k) & 1 ? b.max[k] : b.min[k]))));
        for (const [i, j] of BOX_EDGES)
          if (corner[i] && corner[j]) {
            g2.moveTo(corner[i].x, corner[i].y);
            g2.lineTo(corner[j].x, corner[j].y);
          }
      }
      g2.stroke();
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
      d.all = g.all.map((o) => ({ o, before: o.state }));
      d.b0 = unionBounds(g.all);
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
      // Snapping to the grid when it is on, or while Ctrl is held when it is off (the desktop's SnapActive).
      const d = gdrag, multi = d.all.length > 1, snap = grid.snap !== (e.ctrlKey || e.metaKey);
      let fn;
      if (d.tool === 0) {
        const { o: ro, d: rd } = rayAt(p.x, p.y);
        const s = closestParamOnAxis(d.origin, AXES[d.axis], ro, rd);
        if (s == null) return;
        const lim = Math.max(1, sceneRadius * 4);
        let delta = Math.max(-lim, Math.min(lim, s - d.s0));
        if (snap) delta = d.b0 ? snapAxisMove(grid, d.axis, delta, centre(d.b0), d.b0.min[1]) : Math.round(delta / grid.size) * grid.size;
        fn = (st) => withState(st, { t: st.t.map((x, k) => (k === d.axis ? x + delta : x)) });
      } else if (d.tool === 1) {
        const a = screenAngle(d.c, p);
        let da = a - d.prev;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        d.prev = a;
        d.acc += da;
        let deg = ((d.acc * 180) / Math.PI) * d.sign;
        if (snap) deg = Math.round(deg / 15) * 15;
        fn = multi
          ? (st, o) => turnState(st, o.pivot, d.origin, d.axis, deg)
          : (st) => withState(st, { r: st.r.map((x, k) => (k === d.axis ? wrapDegrees(x + deg) : x)) });
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
        fn = multi
          ? (st, o) => scaleState(st, o.pivot, d.origin, f, [0, 1, 2].map((k) => all || k === d.axis))
          : (st) => withState(st, { s: st.s.map((x, k) => (all || k === d.axis ? x * f : x)) });
      }
      for (const { o, before } of d.all) apply(o, fit(o, fn(before, o)));
      syncPanel();
    }

    function endGizmo() {
      const d = gdrag;
      gdrag = null;
      edit.history.push(d.all.map(({ o, before }) => ({ obj: o, before, after: o.state })), ['Move', 'Rotate', 'Scale'][d.tool]);
      edit.history.breakMerge();
      edited();
    }

    function cancelDrag() {
      const d = gdrag;
      gdrag = null;
      for (const { o, before } of d.all) apply(o, before);
      syncPanel();
    }

    // ----- placement edits -----
    /** Places an object and sends its vertices to the GPU. */
    function apply(o, st) {
      o.state = st;
      writeObject(o, tfHook);
      upload(o);
    }
    /** An object's written vertices to the GPU. */
    function upload(o) {
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
        const after = fit(o, fn(before, o));
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
      zoneRefresh();
      effectRefresh();
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
      // Several objects (or a link) turn and size about the middle of their bounds, as one.
      const list = selectedAll(), multi = list.length > 1, mid = multi && unionBounds(list), origin = mid ? centre(mid) : null;
      const MOVE = { arrowleft: [0, -1], arrowright: [0, 1], arrowup: [2, -1], arrowdown: [2, 1], pageup: [1, 1], pagedown: [1, -1] };
      const TURN = { arrowleft: [1, -1], arrowright: [1, 1], arrowup: [0, 1], arrowdown: [0, -1], pageup: [2, 1], pagedown: [2, -1] };
      if (MOVE[k]) {
        if (ctrl) {
          const [axis, sign] = TURN[k], deg = sign * (coarse ? 45 : 5);
          change(
            list,
            origin ? (st, x) => turnState(st, x.pivot, origin, axis, deg) : (st) => withState(st, { r: st.r.map((x, i) => (i === axis ? wrapDegrees(x + deg) : x)) }),
            'Rotate',
            'key-rotate',
          );
        } else {
          const [axis, sign] = MOVE[k];
          change(list, (st) => withState(st, { t: st.t.map((x, i) => (i === axis ? x + sign * nudgeStep * (coarse ? 5 : 1) : x)) }), 'Move', 'key-move');
        }
        return true;
      }
      if (ctrl) return false;
      const up = [']', '}', '+', '='].includes(k), down = ['[', '{', '-', '_'].includes(k);
      if (up || down) {
        const f = (coarse ? 1.25 : 1.05) ** (up ? 1 : -1);
        change(list, origin ? (st, x) => scaleState(st, x.pivot, origin, f) : (st) => withState(st, { s: st.s.map((x) => x * f) }), 'Scale', 'key-scale');
        return true;
      }
      // Hide and Solid follow the main object, so a mixed selection ends up all one way.
      const hide = !o.state.hidden, solid = !o.state.solid;
      if (k === 'home') change(list, (st, x) => ({ ...(x.stock ?? IDENTITY), hidden: st.hidden, solid: st.solid }), 'Reset');
      else if (k === 'delete') change(list, (st) => ({ ...st, hidden: hide }), hide ? 'Hide' : 'Show');
      else if (k === 'k') change(list, (st) => ({ ...st, solid }), 'Solid');
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
        el(
          'div',
          { class: 'stage-place-name', title: o.name },
          shortObjectName(o.name),
          selectedAll().length > 1
            ? el('span', { class: 'muted', title: 'The gizmo and the keys move them all; the boxes here are the first one\'s' }, ` + ${selectedAll().length - 1} more`)
            : null,
        ),
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

    async function saveFile() {
      tfEnd();
      const sculpt = edit.sculpt ? await encodeSculpt(edit.sculpt) : edit.sculptFile;
      const file = editsFile(edit.stage, edit.objects, edit.sky, fogFeatures(edit), gimmickEdits(edit), sculpt);
      if (!Object.keys(file.Objects).length && !file.Sky && !file.Features && !file.Gimmicks && !file.Sculpt) return toast('There are no edits to save yet.');
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
      const { fog: fileFog, [COLNAV_KEY]: fileCn, links: fileLinks, [SETUP_KEY]: fileSetup, [STAGE_VOLUMES_KEY]: fileSv, [EFFECTS_KEY]: fileFx, [MINIMAP_KEY]: fileMm, ...rest } = res.features;
      // The file's minimap setting (a "minimap" feature) replaces this one.
      if (fileMm && typeof fileMm === 'object' && !Array.isArray(fileMm)) {
        const before = { ...edit.minimap }, after = minimapFromFeature(fileMm);
        if (before.Mode !== after.Mode || before.Picture !== after.Picture) {
          setMinimap(after);
          acts.push({ undo: () => setMinimap(before), redo: () => setMinimap(after) });
          skyNote += ` Minimap: ${MINIMAP_MODES[after.Mode]}${after.Mode === PICTURE ? ` (${pictureFileName(after.Picture)})` : ''}.`;
        }
      }
      // The file's moved effects and sounds (an "effects" feature) replace these.
      if (fileFx && typeof fileFx === 'object' && !Array.isArray(fileFx)) {
        const before = new Map(edit.effectMoved), after = movedFromFeature(fileFx);
        if (JSON.stringify(effectsFeature(before)) !== JSON.stringify(effectsFeature(after))) {
          setEffectMoved(after);
          acts.push({ undo: () => setEffectMoved(before), redo: () => setEffectMoved(after) });
          skyNote += ` Effects and sounds: ${after.size} moved.`;
        }
      }
      // The file's removed stage collision (a "stagevolumes" feature) replaces this.
      if (fileSv && typeof fileSv === 'object' && !Array.isArray(fileSv)) {
        const before = new Set(edit.zoneRemoved), after = removedFromFeature(fileSv);
        if (JSON.stringify(volumesFeature(before)) !== JSON.stringify(volumesFeature(after))) {
          setZoneRemoved(after);
          acts.push({ undo: () => setZoneRemoved(before), redo: () => setZoneRemoved(after) });
          skyNote += ` Stage collision: ${after.size} removed.`;
        }
      }
      // The file's gimmick setup (a "gimmickSetup" feature) replaces this one.
      if (fileSetup && typeof fileSetup === 'object' && !Array.isArray(fileSetup)) {
        const before = setupFromFeature(edit.gimmickSetup), after = setupFromFeature(fileSetup);
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          setSetup(after);
          acts.push({ undo: () => setSetup(before), redo: () => setSetup(after) });
          const n = Object.keys(after).length;
          skyNote += ` Gimmick setup: ${n} gimmick${n === 1 ? '' : 's'}.`;
        }
      }
      // The file's linked objects (a "links" feature) replace these.
      if (fileLinks && typeof fileLinks === 'object') {
        const before = edit.links || [], after = readLinks(fileLinks);
        setLinks(after);
        acts.push({ undo: () => setLinks(before), redo: () => setLinks(after) });
        if (after.length) skyNote += ` ${after.length} link${after.length === 1 ? '' : 's'}.`;
      }
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
      // The file's terraforming (Sculpt) replaces this.
      if (res.sculpt) {
        try {
          const s = await decodeSculpt(res.sculpt);
          if (s) {
            edit.tfGround ??= groundPieces(edit.objects);
            const before = { sculpt: edit.sculpt, heights: edit.tfHeights }, after = { sculpt: s, heights: groundHeights(s, edit.tfGround) };
            setSculpt(after);
            acts.push({ undo: () => setSculpt(before), redo: () => setSculpt(after) });
            skyNote += ` Terraforming: a ${s.width} × ${s.depth} grid.`;
          }
        } catch (e) {
          skyNote += ` The terraforming can't be read (${e.message}).`;
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
      if (play) playTick(dt);
      else {
        if (fly(dt)) dirty = true;
        if (tfOn) tfFrame(dt);
      }
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
      releasePad?.();
      menu?.dispose();
      if (carry) cancelCarry(); // a carried object goes back to where it was picked up
      store(edit.stage, edit.objects, edit.sky, fogFeatures(edit), gimmickEdits(edit), edit.sculptFile);
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
      const speed = Math.max(5, sceneRadius * 0.35) * flyMul * (keys.has('shift') ? 4 : 1) * dt;
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

    // ----- minimap (StageViewerForm.Minimap.cs): the bundle's minimap_*.dds as it is, redrawn from above, or a picture -----
    const MINIMAP_DESC = "Stock: the stage's own. Edited areas: the map drawn from above where you changed it. Whole map: drawn from above everywhere. Picture: an image of your own.";
    const mmLine = el('p', { class: 'muted stage-count' });
    const mmMode = el('select', { class: 'input input-sm', 'aria-label': 'Minimap' }, MINIMAP_MODES.map((t, i) => el('option', { value: String(i) }, t)));
    const mmCanvas = el('canvas', { class: 'stage-minimap', width: '256', height: '256', 'aria-label': 'The minimap the download writes' });
    const mmNote = el('p', { class: 'muted stage-count' });
    const mmPickBtn = button('Choose a picture…', () => chooseMinimapPicture(), {
      title: "Any image; it's scaled to the minimap. North (−Z) is up, the map's centre is the picture's centre, and the picture spans 600 m.",
    });
    const mmUpdateBtn = button('Update the preview', () => updateMinimapPreview(), { title: 'Draws the minimap again from the map as it is now (the download always draws it fresh)' });
    const mmSaveBtn = button('Save it as PNG…', () => saveMinimapPng(), { title: 'Saves the minimap the download would write, to paint over in an image editor and bring back as a picture' });
    let mmRead = false, mmWhat = '', mmJob = 0;
    /** The picture the setting names is here (the desktop checks the file exists). */
    const hasMinimapPicture = () => !!edit.minimapPicture && edit.minimapPicture.name === pictureFileName(edit.minimap.Picture);
    /** Puts a minimap setting in place (SetMinimap): kept with the edits, then the preview drawn again. */
    function setMinimap(m) {
      edit.minimap = { Mode: m.Mode, Picture: m.Picture ?? null };
      saveSoon();
      renderDownload();
      updateMinimapPreview();
    }
    /** The next or previous setting (StepMinimapMode), past Picture while no picture is kept. */
    function stepMinimap(d) {
      const mode = stepMode(edit.minimap.Mode, d, !!edit.minimapPicture);
      setMinimap({ Mode: mode, Picture: mode === PICTURE ? edit.minimapPicture.name : edit.minimap.Picture });
    }
    mmMode.addEventListener('change', () => {
      const mode = Number(mmMode.value);
      if (mode === PICTURE && !edit.minimapPicture) return chooseMinimapPicture().finally(renderMinimap);
      setMinimap({ Mode: mode, Picture: mode === PICTURE ? edit.minimapPicture.name : edit.minimap.Picture });
    });
    /**
     * The minimap for setting m at the stock size (BuildMinimap): {rgba, what}, what saying what it holds. The redraws
     * draw the map as it is now; the picture is the one kept in this browser.
     */
    async function buildMinimap(m) {
      const st = edit.minimapStock, n = st.n;
      if (m.Mode === PICTURE) {
        if (!hasMinimapPicture()) throw new Error(`The minimap picture is missing: ${pictureFileName(m.Picture) || '(none chosen)'}; choose it again`);
        return { rgba: await pictureMinimap(edit.minimapPicture.blob, n), what: `your picture (${edit.minimapPicture.name})` };
      }
      if (m.Mode === STOCK) return { rgba: st.rgba, what: "the stage's own" };
      const sea = seaColour(st.rgba, n);
      const render = renderTopDown(n, sea);
      if (m.Mode === WHOLE) return { rgba: render, what: 'the whole map redrawn from above' };
      const { mask, areas } = changeMask(n, changedFootprints(edit.objects, isEdited, (o) => placementFromState(o).position));
      return {
        rgba: mixMinimap(st.rgba, render, mask),
        what: areas ? `${areas} changed area${areas === 1 ? '' : 's'} redrawn from above` : "the stage's own (nothing changed to redraw)",
      };
    }
    /**
     * The map drawn straight down over the minimap square at n × n (RenderTopDown): off screen at twice that, averaged;
     * textures on whatever the view shows, the lightmap as the view has it, every layer but the sky, rainbow and mist.
     * Where nothing was drawn (open sea) it is the sea colour.
     */
    function renderTopDown(n, sea) {
      const most = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), ...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
      let ss = 2;
      if (n * ss > most) ss = 1;
      if (n * ss > most) throw new Error(`The graphics card can't draw a ${n}-pixel minimap.`);
      const size = n * ss, samples = new Uint8Array(size * size * 4);
      const fbo = gl.createFramebuffer(), colour = gl.createRenderbuffer(), depth = gl.createRenderbuffer();
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.bindRenderbuffer(gl.RENDERBUFFER, colour);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, size, size);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colour);
        gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, size, size);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
        const fs = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (fs !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`The graphics card can't draw off screen (${fs}).`);
        gl.viewport(0, 0, size, size);
        gl.clearColor(0, 0, 0, 0);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.depthFunc(gl.LESS);
        gl.disable(gl.CULL_FACE);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.useProgram(prog.program);
        const U = prog.u;
        gl.uniformMatrix4fv(U.uViewProj, false, topDownMatrix());
        gl.uniform3fv(U.uEye, TOP_DOWN_EYE);
        gl.uniform3fv(U.uFwd, [0, -1, 0]);
        gl.uniform1i(U.uTex0, 0);
        gl.uniform1i(U.uTex1, 1);
        gl.uniform1f(U.uLmScale, lmSelect.value === 'bright' ? 2 : 1);
        gl.uniform1f(U.uSkyRadius, 0);
        gl.uniform1i(U.uFogOn, 0);
        gl.uniform4f(U.uTint, 0, 0, 0, 0);
        const lmOn = lmSelect.value !== 'off';
        for (const m of scene.meshes) {
          if (m.sky || leftOutOfMinimap(m)) continue;
          gl.bindVertexArray(meshGpu(m).vao);
          const useTex = !!m.uvs;
          for (const b of m.batches) {
            if (b.indexCount <= 0) continue;
            const tex = useTex && b.texture ? glTex.get(lower(b.texture)) : null;
            const light = useTex && m.uvs2 && b.lightmap ? glTex.get(lower(b.lightmap)) : null;
            const useLight = !!light && lmOn;
            let mode = 0;
            if (useTex) mode = tex ? (useLight ? 3 : 2) : light ? 4 : 1;
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, (mode === 4 ? light : tex) || null);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, mode === 3 ? light : null);
            gl.uniform1i(U.uMode, mode);
            gl.uniform1i(U.uLit, useLight ? 0 : 1);
            gl.drawElements(gl.TRIANGLES, b.indexCount, gl.UNSIGNED_INT, b.firstIndex * 4);
          }
        }
        gl.bindVertexArray(null);
        gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
        gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, samples);
      } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        gl.deleteRenderbuffer(colour);
        gl.deleteRenderbuffer(depth);
        gl.deleteFramebuffer(fbo);
        dirty = true; // the view draws itself again (its viewport and clear colour are set each frame)
      }
      return averageSamples(samples, n, ss, sea);
    }
    /** Draws the preview again from the setting and the map as they are now (UpdateMinimapPreview). */
    async function updateMinimapPreview() {
      const st = edit.minimapStock;
      if (!st?.rgba) return renderMinimap();
      const job = ++mmJob;
      try {
        const r = await buildMinimap(edit.minimap);
        if (job !== mmJob || stopped) return;
        mmCanvas.width = mmCanvas.height = st.n;
        mmCanvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.rgba), st.n, st.n), 0, 0);
        mmWhat = r.what;
      } catch (e) {
        if (job !== mmJob) return;
        mmWhat = '';
        console.warn(`Map editor: minimap preview: ${e.message}`);
      }
      renderMinimap();
    }
    /** Any image, kept in this browser for the stage (ChooseMinimapPicture); the setting goes to Picture. */
    async function chooseMinimapPicture() {
      const [f] = await pickFiles({ accept: 'image/*' });
      if (!f || stopped) return;
      let url;
      try {
        url = await pictureDataUrl(f);
      } catch (e) {
        return toast(`That picture can't be read: ${e.message}`, 'error');
      }
      edit.minimapPicture = { name: f.name, blob: f };
      if (!storeMinimapPicture(edit.stage, { name: f.name, url }))
        toast("This browser has no room to keep the picture: it's used until you leave the page.", 'error');
      setMinimap({ Mode: PICTURE, Picture: f.name });
      toast(`Minimap: ${f.name}`);
    }
    /** The minimap the download would write, as a PNG (SaveMinimapPng), named after the bundle's minimap. */
    async function saveMinimapPng() {
      const st = edit.minimapStock;
      if (!st?.rgba) return;
      try {
        const r = await buildMinimap(edit.minimap);
        const c = document.createElement('canvas');
        c.width = c.height = st.n;
        c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.rgba), st.n, st.n), 0, 0);
        const blob = await new Promise((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error('the PNG could not be made'))), 'image/png'));
        const name = pictureFileName(st.name).replace(/\.[^.]*$/, '') + '.png';
        downloadBytes(new Uint8Array(await blob.arrayBuffer()), name, 'image/png');
        toast(`Saved ${name}`);
      } catch (e) {
        toast(`Could not save the minimap: ${e.message}`, 'error');
      }
    }
    /**
     * The bundle with the minimap entry rewritten (MinimapExport): the entry the stage's own came from (else the first
     * minimap_*.dds) gets a one-level DXT1 of the minimap drawn fresh. Returns {archive, summary}; throws when it doesn't
     * read back.
     */
    async function bakeMinimap(archive) {
      const st = edit.minimapStock;
      const r = await buildMinimap(edit.minimap);
      const dds = minimapDds(st.n, st.n, r.rgba);
      const entries = archive.entries.slice();
      let i = entries.findIndex((e) => e.name === st.name);
      if (i < 0) i = entries.findIndex((e) => isMinimapName(e.name));
      if (i < 0) throw new Error(`the bundle has no ${st.name}`);
      entries[i] = { ...entries[i], pointer: false, size: dds.length, data: dds };
      let back;
      try {
        back = decodeDds(entries[i].data);
      } catch (e) {
        throw new Error(`the minimap did not read back (${e.message})`);
      }
      if (back.width !== st.n || back.height !== st.n) throw new Error('the minimap did not read back');
      console.info(`Map editor: ${entries[i].name}: ${r.what}`);
      return { archive: { ...archive, entries }, summary: `Minimap: ${r.what}.` };
    }
    function renderMinimap() {
      const st = edit.minimapStock;
      if (!st?.rgba) {
        minimapBox.replaceChildren(
          el('p', { class: 'muted' },
            !mmRead ? 'Reading the minimap…'
              : st ? `${st.name} can't be read (${st.error}); it is left as it is.`
              : 'This stage has no minimap in its bundle (minimap_*.dds).'),
        );
        return;
      }
      const m = edit.minimap;
      mmMode.value = String(m.Mode);
      mmLine.textContent = `${st.name}, ${st.n} × ${st.n}${m.Mode === PICTURE ? ` · ${pictureFileName(m.Picture)}` : ''}`;
      mmNote.textContent = m.Mode === PICTURE && !hasMinimapPicture()
        ? `The picture ${pictureFileName(m.Picture)} isn't kept in this browser: choose it again.`
        : mmWhat ? `Shows ${mmWhat}${m.Mode === EDITED || m.Mode === WHOLE ? ' (Update the preview after more changes; the download draws it fresh)' : ''}.` : '';
      if (!minimapBox.contains(mmMode))
        minimapBox.replaceChildren(
          mmLine,
          el('label', { class: 'stage-fog-row', title: MINIMAP_DESC }, 'Minimap', mmMode),
          mmCanvas,
          mmNote,
          el('div', { class: 'toolbar' }, mmPickBtn, mmUpdateBtn, mmSaveBtn),
        );
    }
    const minimapPage = {
      title: 'Minimap',
      status: () => (edit.minimapStock?.name ?? '') + (edit.minimap.Mode === PICTURE ? ` · ${pictureFileName(edit.minimap.Picture)}` : ''),
      items: () => [
        { text: 'Minimap', value: () => MINIMAP_MODES[edit.minimap.Mode], activate: () => stepMinimap(1), adjust: (dir) => stepMinimap(dir), desc: MINIMAP_DESC },
        { text: 'Choose a picture…', activate: () => (menu.close(), chooseMinimapPicture()), desc: "Any image; it's scaled to the minimap. North (−Z) is up, the map's centre is the picture's centre, and the picture spans 600 m." },
        { text: 'Update the preview', activate: () => updateMinimapPreview(), desc: 'Draws the minimap again from the map as it is now (the download always draws it fresh); the preview is in the side panel' },
        { text: 'Save it as PNG…', activate: () => (menu.close(), saveMinimapPng()), desc: 'Saves the minimap the download would write, to paint over in an image editor and bring back as a picture' },
      ],
    };
    renderMinimap();
    Promise.all([readStockMinimap(model), loadMinimapPicture(edit.stage)]).then(
      ([stock, pic]) => {
        if (stopped) return;
        mmRead = true;
        edit.minimapStock = stock;
        if (pic) edit.minimapPicture = pic;
        if (stock?.rgba) console.info(`Map editor: minimap: ${stock.name} ${stock.n}×${stock.n}, mode ${MINIMAP_MODES[edit.minimap.Mode]}`);
        else if (stock) console.info(`Map editor: minimap: ${stock.name} can't be read (or isn't square); left as it is`);
        renderDownload();
        // Drawn after this turn; Update the preview draws it again once more of the map has loaded or changed.
        setTimeout(() => !stopped && updateMinimapPreview(), 0);
      },
      (e) => {
        mmRead = true;
        console.warn(`Map editor: the minimap of ${edit.stage} could not be read: ${e.message}`);
        renderMinimap();
      },
    );

    // ----- gimmick setup: the rules and the files it writes (StageViewerForm.GimmickSetup.cs), read with the gimmicks -----
    const setupFiles = { bundle: null, loose: null, tactics: null }; // each {path, bytes, layers}
    const setupCtx = {
      placements: () => scene.gimmicks?.placements ?? [],
      tableText: () => scene.gimmicks?.table.text ?? null,
      setup: edit.gimmickSetup,
      nut: null,
      bundle: (m) => scene.gimmicks?.kit.bundle(m) ?? null,
      tactics: null,
    };
    const setupRules = gimmickSetupRules(setupCtx);

    // ----- download (objects, sky and fog written into a copy of the bundle, as the desktop export does) -----
    const downloadNote = el('p', { class: 'muted stage-count' });
    const bakeBtn = button('Download bundle', bakeBundle, {
      title: 'Write the moved, hidden and Solid objects, the collision edits, the sky and the fog into a copy of the stage bundle, as the desktop export does',
    });
    function bakeParts() {
      const parts = [];
      if (edit.objects.some((o) => !o.gimmick && !isEmpty(o.state))) parts.push('objects');
      if (edit.sculpt ? !edit.sculpt.isEmpty : !!edit.sculptFile) parts.push('terraforming');
      if (Object.keys(edit.colnav.RemovedCollision).length || edit.colnav.Volumes.length) parts.push('collision');
      if (navHandEdited()) parts.push('bot navigation');
      if (edit.sky && edit.sky.Mode !== 'dungeon') parts.push('sky');
      if (fogChanged(edit)) parts.push('fog');
      if (edit.minimapStock?.rgba && edit.minimap.Mode !== STOCK) parts.push('minimap');
      if (gptPaths.length && movedPaths(gptPaths, gptHarbours()).length) parts.push('gimmick paths');
      if (setupFiles.bundle && setupExport()?.planEmpty === false) parts.push('stage script');
      return parts;
    }
    /** Nav painted or erased, or waypoints added, deleted, linked or unlinked by hand. */
    function navHandEdited() {
      const c = edit.colnav;
      return !!(c.NavCells.length || c.NavErase.length || c.Waypoints.length || c.RemovedWaypoints.length || c.Links.length || c.Cuts.length);
    }
    /**
     * The nav files rewritten as the live nav stands (CollectExportNav, StageNavBaker.Apply): the nav mesh and the
     * waypoint graph each only when it changed, a 360 file written back in its own byte order. With terraforming (warp)
     * the cells' corners and the waypoints then follow the reshaped ground (WarpExportNav). Returns the summary line, or
     * null when the stage has no nav or nothing in the bundle can change it.
     */
    async function bakeNav(archive, touched, warp = null) {
      const r = navRead;
      const rebuild = touched || navHandEdited();
      if (!r || (!r.nav && !r.path) || (!rebuild && !warp)) return null;
      const put = async (name, bytes) => {
        const i = archive.entries.findIndex((e) => e.name.toLowerCase() === name.toLowerCase());
        if (i < 0) return;
        const e = archive.entries[i], was = e.pointer || !e.data?.length ? null : (await decodeLayers(e.data)).payload;
        if (is360Spd(was)) bytes = spd360ToSteam(bytes); // the same lane swap both ways
        archive.entries[i] = { ...e, pointer: false, size: bytes.length, data: bytes };
        console.info(`Map editor export: ${name}: rewritten (${bytes.length} bytes)`);
      };
      let line = null, live = null, navBytes = null, pathBytes = null;
      if (rebuild) {
        for (let nm = edit.navMatch; nm && !nm.done && !stopped; nm = edit.navMatch) {
          status.textContent = 'Matching the nav to the objects…';
          await new Promise((ok) => setTimeout(ok, 250));
        }
        const nm = edit.navMatch;
        if (!nm?.done) return "Bot navigation was left as it was (matching wasn't finished when you exported).";
        if (nm.error) return `Bot navigation was left as it was (it couldn't be matched to the objects: ${nm.error}).`;
        navNow(true);
        live = navLive;
        if (!live) return "Bot navigation was left as it was (the rebuild failed; the console has why).";
        if (live.nav && r.navName && navChanged(live)) navBytes = writeNavMesh(live.nav);
        if (live.path && r.pathName && pathChanged(live)) pathBytes = writePathGraph(live.path);
        if (navBytes || pathBytes) line = navSummary(live);
      }
      if (warp) {
        // Copies of the nav as it now stands (rebuilt, or the stage's own), so the live nav on the map stays as it is.
        const navCur = live?.nav ?? r.nav, pathNow = live?.path ?? r.path;
        const nav = r.navName && navCur ? parseNavMesh(navBytes ?? writeNavMesh(navCur)) : null;
        const path = r.pathName && pathNow ? parsePathGraph(pathBytes ?? writePathGraph(pathNow)) : null;
        const { cells, waypoints } = warpNav(warp, nav, path);
        if (cells && nav) navBytes = writeNavMesh(nav);
        if (waypoints && path) pathBytes = writePathGraph(path);
        const w = `Reshaped ground: ${cells.toLocaleString()} nav cell(s) and ${waypoints.toLocaleString()} waypoint(s) follow it.`;
        line = line ? `${line} ${w}` : w;
      }
      if (navBytes) await put(r.navName, navBytes);
      if (pathBytes) await put(r.pathName, pathBytes);
      return line;
    }
    /** The bundle's stage_setting.nut with the setup's teams, build states and bundles written in (GimmickSetupExport). */
    async function bakeStageScript(archive) {
      const sx = setupExport();
      if (!sx || sx.planEmpty || !setupFiles.bundle) return [];
      const i = archive.entries.findIndex((e) => (e.name || '').toLowerCase() === 'stage_setting.nut');
      if (i < 0) throw new Error('stage_setting.nut is missing from the bundle');
      const r = applyStageScript(setupFiles.bundle.bytes, sx.plan);
      if (!readStageScript(r.bytes) || !sameBytes((await decodeLayers(r.bytes)).payload, r.bytes))
        throw new Error('stage_setting.nut did not read back');
      archive.entries[i] = { ...archive.entries[i], pointer: false, size: r.bytes.length, data: r.bytes };
      console.info(`Map editor export: stage_setting.nut: ${r.changed} value(s) changed, ${r.inserted} line(s) added, ${r.filesAdded} bundle(s) listed`);
      return sx.lines.filter((l) => l.startsWith('Stage script:'));
    }
    const listOf = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : a[0]);
    function renderDownload() {
      const parts = bakeParts();
      downloadNote.textContent = parts.length
        ? `Writes the ${listOf(parts)} into a copy of ${edit.stage}.bres.`
        : 'Move, hide or make objects Solid, terraform the ground, change the sky, fog or minimap, edit the collision, or set up the castle gimmicks, to write them into a copy of the bundle.';
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
     * the collision no moved object takes along reshaped with terraformed ground (warp), and the changed layers' stale
     * .mtf copies dropped. Returns {entries, line} or null when there's nothing to do; the entries are replaced in place
     * (at: lower-case name -> index).
     */
    async function bakeCollision(edits, solids, added, entries, at, warp = null) {
      const ccp = [];
      entries.forEach((e, i) => /\.ccp$/i.test(e.name || '') && !e.pointer && e.data?.length && ccp.push(i));
      if (!ccp.length && !solids.length && !added.length) return null;
      const erased = Object.keys(edit.colnav.RemovedCollision).length > 0;
      const moving = edits.filter((e) => !e.warp); // ground pieces carrying the warp keep their collision, reshaped
      const notes = [];
      let col = null, owners = null;
      if ((moving.length || erased) && ccp.length) {
        const lost = [moving.length ? "doesn't follow the moved objects" : '', erased ? 'keeps the triangles erased by hand' : ''].filter(Boolean).join(' and ');
        status.textContent = 'Reading the collision…';
        try {
          col = await (job.collision || (job.collision = readCollision(model)));
        } catch (e) {
          notes.push(`The collision couldn't be read (${e.message}), so it ${lost}.`);
        }
        if (col && !col.live) {
          notes.push(`The collision has an unfamiliar layout, so it ${lost}.`);
          col = null;
        } else if (col && moving.length) {
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
        const own = owners && li >= 0 ? owners[li] : null;
        let out = (li >= 0 && (own || removed)) || warp ? patchCollision(data, name, own ? edits : [], edit.objects, own, rep, removed, warp) : null;
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
      if (rep.trianglesWarped) what.push(`${rep.trianglesWarped.toLocaleString()} reshaped with the ground`);
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
      if (!parts.length) return toast('Nothing to write into the bundle yet.');
      bakeBtn.disabled = true;
      const was = status.textContent;
      try {
        let archive = model;
        const lines = [];
        let warp = null;
        if (parts.includes('terraforming')) {
          if (!edit.sculpt && edit.sculptJob) {
            status.textContent = 'Reading the terraforming…';
            await edit.sculptJob;
          }
          warp = sculptWarp(edit.sculpt);
          if (!edit.sculpt) lines.push("Terraforming: left out (the grid kept with the edits can't be read).");
          else if (warp) edit.tfGround ??= groundPieces(edit.objects);
        }
        if (parts.includes('objects') || parts.includes('collision') || warp) {
          status.textContent = 'Writing the objects…';
          await pause();
          const { edits, skipped } = collectExportEdits(edit.objects, warp, warp ? edit.tfGround : null);
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
          if (warp) lines.push(`Ground reshaped: ${n.groundReshaped.toLocaleString()} ground piece(s) follow the terraforming.`);
          const c = edits.length || solids.length || added.length || erased || warp ? await bakeCollision(edits, solids, added, entries, at, warp) : null;
          if (c) lines.push(c.line);
          archive = { ...archive, entries: c ? c.entries : entries };
        }
        {
          // Hidden objects take their baked shadows with them (StageShadowEraser, between the edits and the nav as on the desktop).
          const { casters, receivers } = shadowInputs(edit.objects, scene.meshes);
          if (casters.length) {
            status.textContent = 'Clearing baked shadows…';
            await pause();
            const at = new Map();
            archive.entries.forEach((e, i) => at.has(e.name.toLowerCase()) || at.set(e.name.toLowerCase(), i));
            const s = await eraseShadows(casters, receivers, async (lightmap) => {
              const e = archive.entries[at.get(`${lightmap}.dds`.toLowerCase())];
              return e && !e.pointer && e.data?.length ? { name: e.name, data: (await decodeLayers(e.data)).payload.slice() } : null;
            });
            if (s.changed.length) {
              const entries = archive.entries.slice();
              for (const { name, data } of s.changed) {
                const i = at.get(name.toLowerCase());
                entries[i] = { ...entries[i], pointer: false, size: data.length, data };
              }
              archive = { ...archive, entries };
            }
            const wide = s.tooWide ? `${s.tooWide} hidden object(s) too wide to clear a shadow under (left as baked).` : '';
            if (s.line || wide) lines.push([s.line, wide].filter(Boolean).join(' '));
          }
        }
        {
          const touched = parts.includes('objects') || parts.includes('collision');
          archive = { ...archive, entries: archive.entries.slice() };
          const line = await bakeNav(archive, touched, warp);
          if (line) lines.push(line);
        }
        if (parts.includes('gimmick paths')) {
          const line = await bakeGimmickPaths(archive);
          if (line) lines.push(line);
        }
        if (parts.includes('stage script')) lines.push(...(await bakeStageScript(archive)));
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
        if (parts.includes('minimap')) {
          status.textContent = 'Drawing the minimap…';
          await pause();
          const r = await bakeMinimap(archive);
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

    // ----- gimmick paths: the .gpt routes moving gimmicks follow (StageViewerForm.GimmickPaths.cs) -----
    gptBox.checked = !!job.showGpt;
    function showGpt() {
      job.showGpt = gptBox.checked;
      dirty = true;
    }
    function toggleGpt() {
      gptBox.checked = !gptBox.checked;
      showGpt();
    }
    gptBox.addEventListener('change', showGpt);
    /** Every .gpt of the bundle that reads ({name, data, paths}), logged as the desktop does (LoadGimmickPaths). */
    async function readGimmickPaths(arc) {
      const files = [];
      for (const e of arc.entries) {
        if (!/\.gpt$/i.test(e.name)) continue;
        const d = e.pointer || !e.data?.length ? null : (await decodeLayers(e.data)).payload;
        const paths = parseGpt(e.name, d);
        if (!paths) {
          console.warn(`Map editor: gimmick paths: ${e.name} isn't laid out as expected; left as it is`);
          continue;
        }
        console.info(`Map editor: gimmick paths: ${e.name} — ${paths.map((p) => `${p.name} (${p.points.length} points)`).join(', ')}`);
        files.push({ name: e.name, data: d, paths });
      }
      return files;
    }
    (job.gpt || (job.gpt = readGimmickPaths(model))).then(
      (files) => {
        if (stopped || !files.length) return;
        for (const f of files) {
          gptFiles.set(f.name.toLowerCase(), f.data);
          gptPaths.push(...f.paths);
        }
        gptLabel.hidden = false;
        downloadRefresh();
        dirty = true;
      },
      (e) => console.warn(`Map editor: the gimmick paths of ${edit.stage} could not be read: ${e.message}`),
    );
    /**
     * The stage's own RaftHarbor placements (not new, this season's), each as it stands now: the harbours a raft path's
     * ends follow (HarbourShift). A harbour with no model (sligA's have none) can only be moved by an edits file, whose
     * entry waits in edit.gimmickOther.
     */
    function gptHarbours() {
      const gm = scene.gimmicks;
      if (!gm || !gptPaths.length) return [];
      return gm.placements
        .filter((g) => g.type === 'RaftHarbor' && !g.isNew && g.season == null)
        .map((g) => {
          const o = gimmickObjects.get(g);
          if (o) return placementFromState(o);
          const s = edit.gimmickOther.find((x) => x.Tag === g.tag && (x.Season ?? null) === null);
          if (!s) return g;
          const copy = { ...g, position: g.position.slice(), rotation: g.rotation.slice() };
          applyGimmickEdit(copy, s);
          return copy;
        });
    }
    /** Each path as a cyan line 20 cm up, green at its start and red at its end, with its name (DrawGimmickPaths). */
    function drawGimmickPaths(g2) {
      if (!gptBox.checked || !gptPaths.length) return;
      const harbours = gptHarbours();
      g2.save();
      g2.lineWidth = 2.5;
      g2.lineJoin = 'round';
      g2.font = '12px system-ui, sans-serif';
      for (const p of gptPaths) {
        const pts = (followedPath(p, harbours) ?? p.points).map((v) => project([v[0], v[1] + 20, v[2]]));
        g2.strokeStyle = 'rgb(77 242 242)';
        g2.beginPath();
        let pen = false;
        for (const q of pts) {
          if (q && pen) g2.lineTo(q.x, q.y);
          else if (q) g2.moveTo(q.x, q.y);
          pen = !!q;
        }
        g2.stroke();
        const dot = (q, colour) => {
          if (!q) return;
          g2.fillStyle = colour;
          g2.fillRect(q.x - 4.5, q.y - 4.5, 9, 9);
        };
        dot(pts[0], 'rgb(77 255 102)');
        dot(pts.at(-1), 'rgb(255 115 89)');
        const at = pts[Math.floor(pts.length / 2)] || pts.find(Boolean);
        if (at) {
          g2.fillStyle = 'rgb(0 0 0 / 0.6)';
          g2.fillText(p.name, at.x + 7, at.y - 5);
          g2.fillStyle = 'rgb(77 242 242)';
          g2.fillText(p.name, at.x + 6, at.y - 6);
        }
      }
      g2.restore();
    }
    /**
     * The moved paths' points written into their .gpt entries of archive (in place), every other byte as it was, each
     * read back (GimmickPathsExport). Returns the summary line, or null when no path follows a moved harbour.
     */
    async function bakeGimmickPaths(archive) {
      const moved = movedPaths(gptPaths, gptHarbours());
      if (!moved.length) return null;
      const byFile = new Map();
      for (const m of moved) {
        const key = m[0].file.toLowerCase();
        if (!byFile.has(key)) byFile.set(key, []);
        byFile.get(key).push(m);
      }
      for (const [key, list] of byFile) {
        const bytes = writeGpt(gptFiles.get(key), list);
        const i = archive.entries.findIndex((e) => e.name.toLowerCase() === key);
        if (i < 0) throw new Error(`${list[0][0].file} is missing from the bundle.`);
        archive.entries[i] = { ...archive.entries[i], pointer: false, size: bytes.length, data: bytes };
        const back = (await decodeLayers(archive.entries[i].data)).payload;
        if (back.length !== bytes.length || back.some((x, k) => x !== bytes[k]) || !parseGpt(key, back))
          throw new Error(`${list[0][0].file} did not read back.`);
        console.info(`Map editor export: ${list[0][0].file}: ${list.length} path(s) moved with their harbours`);
      }
      return `Gimmick paths: ${moved.length} raft path(s) moved with their harbours, written into the map.`;
    }

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
      if (mode) effectToolOff(), terraformOff(), playOff();
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
      extra = [];
      selectionChanged();
    }
    function select(o) {
      selection = o ? { mesh: o.mesh, object: o, hit: null } : null;
      extra = [];
      selectionChanged();
    }
    /** Selects these objects, the first the main one (the gizmo's and the panel's). */
    function setSelectionList(list) {
      if (!list.length) return select(null);
      selection = { mesh: list[0].mesh, object: list[0], hit: null };
      extra = list.slice(1);
      selectionChanged();
    }
    /** Ctrl+click: adds the object (with what is linked to it) or takes it out; empty space keeps the selection (ToggleSelectAt). */
    function toggleSelect(hit) {
      const o = hit?.object;
      if (!o) return;
      const mates = linkOf.get(o) || [o], now = selectedAll();
      if (now.includes(o)) {
        setSelectionList(now.filter((x) => !mates.includes(x)));
        toast(`Took ${shortObjectName(o.name)} out of the selection`);
      } else {
        setSelectionList([...now, ...mates]);
        toast(`Added ${shortObjectName(o.name)} — ${selectedAll().length} objects selected`);
      }
    }
    /** Ctrl+drag: adds the objects whose middle is in the box; with Shift, takes them out (BoxSelect). */
    function boxSelect(r, remove) {
      const x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1), y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1);
      const hits = new Set();
      for (const o of edit.objects) {
        if (!o.mesh.visible || o.state.hidden || !o.bounds) continue;
        if (!o.gimmick) {
          if (o.mesh.kind === 'terrain') continue;
          const s = [0, 1, 2].map((k) => o.bounds.max[k] - o.bounds.min[k]);
          if (Math.max(s[0], s[2]) >= MAX_GRAB || s[1] >= MAX_GRAB) continue;
        }
        const c = project(centre(o.bounds));
        if (c && c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1) for (const y of linkOf.get(o) || [o]) hits.add(y);
      }
      if (!hits.size) return toast('Nothing in the box (the ground and very large objects are left out)');
      const now = selectedAll();
      let next, n;
      if (remove) {
        next = now.filter((x) => !hits.has(x));
        n = now.length - next.length;
      } else {
        const add = [...hits].filter((x) => !now.includes(x));
        next = [...now, ...add];
        n = add.length;
      }
      setSelectionList(next);
      toast(`${remove ? `Took ${n} out` : `Added ${n}`} — ${next.length} object${next.length === 1 ? '' : 's'} selected`);
    }
    function setLinks(list) {
      edit.links = list;
      linkOf = new Map();
      for (const l of list) for (const o of l) linkOf.set(o, l);
      dirty = overlayDirty = true;
    }
    function pushLinks(next, label) {
      const before = edit.links || [];
      setLinks(next);
      edit.history.push([], label, null, { undo: () => setLinks(before), redo: () => setLinks(next) });
      edit.history.breakMerge();
      edited();
    }
    /** Ctrl+G: the selected objects become one object that is selected, moved and carried together (LinkSelection). */
    function linkSelection() {
      const list = selectedAll();
      if (!list.length) return toast('Select the objects to link first (Ctrl+click or Ctrl+drag)');
      if (list.length < 2) return toast('Select two or more objects to link (Ctrl+click adds one)');
      const chosen = new Set(list), next = [];
      for (const l of edit.links || []) {
        const rest = l.filter((o) => !chosen.has(o)); // links that lose pieces keep the rest when two or more are left
        if (rest.length >= 2) next.push(rest);
      }
      next.push(list);
      pushLinks(next, 'Link');
      toast(`Linked ${list.length} pieces into one object — Ctrl+Shift+G unlinks`);
    }
    /** Ctrl+Shift+G: the links in the selection come apart (UnlinkSelection). */
    function unlinkSelection() {
      const chosen = new Set(selectedAll()), links = edit.links || [];
      const hit = links.filter((l) => l.some((o) => chosen.has(o)));
      if (!hit.length) return toast('Nothing linked is selected');
      pushLinks(links.filter((l) => !hit.includes(l)), 'Unlink');
      toast('Unlinked — each piece is its own object again');
    }
    /** The objects of a "links" feature ({Groups: [[name, ...], ...]}), matched by exact name; links of two or more. */
    function readLinks(feature) {
      const groups = feature?.Groups;
      if (!Array.isArray(groups)) return [];
      const byName = new Map();
      for (const o of edit.objects) if (!byName.has(o.name)) byName.set(o.name, o);
      const used = new Set(), out = [];
      for (const names of groups) {
        if (!Array.isArray(names)) continue;
        const l = [];
        for (const n of names) {
          const o = typeof n === 'string' ? byName.get(n) : null;
          if (o && !used.has(o)) used.add(o), l.push(o);
        }
        if (l.length >= 2) out.push(l);
      }
      return out;
    }
    function selectionChanged() {
      if (gdrag) cancelDrag();
      if (carry && selected() !== carry.o) dropCarry();
      const keep = new Set(selectedAll());
      for (const [o, b] of selEbos) if (!keep.has(o)) gl.deleteBuffer(b), selEbos.delete(o);
      menu?.refresh();
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
      title: "Write the moved, turned, removed and set-up gimmicks into a copy of the stage's gimmick table, as the desktop export does, " +
        'with the installed stage script (<stage>_ssn_stage_setting.nut) and bot tactics (<stage>_stage_tactics.json) when the setup changes them',
    });
    const gimmickList = el('div', { class: 'stage-gimmick-list' });
    const setupBox = el('div', { class: 'stage-gimmick-setup', hidden: true });
    const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    // ----- invisible zones (StageViewerForm.Zones.cs) -----
    // The gimmicks' trigger zones (from their behaviour files in json/gimmick) and the gimmick table's extra stage
    // collision (collisionEntries_), drawn over the map. A collision entry inside a movable stage object moves, turns and
    // goes with it; any one can be removed (undoable), and Download gimmick table writes the change.
    const zoneShow = job.zoneShow || (job.zoneShow = { traps: false, volumes: false });
    const zoneVolumes = parseStageVolumes(scene.gimmicks?.table.text ?? null);
    let trapZones = null; // gimmick type → its zones, once read
    // Each entry's stage object (null: none): the smallest movable one whose box, as built, holds its footprint.
    const zoneOwners = new Map();
    if (zoneVolumes.length) {
      const cands = [];
      for (const o of edit.objects) {
        if (o.gimmick || o.mesh.sky) continue;
        const b = boundsOf(o.mesh.baked?.positions ?? o.mesh.positions, o.firstVertex, o.vertexCount);
        if (!(b.min[0] <= b.max[0])) continue;
        if (Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) >= MAX_GRAB || b.max[1] - b.min[1] >= MAX_GRAB) continue; // the ground stays put
        cands.push({ o, b });
      }
      for (const v of zoneVolumes) zoneOwners.set(v.name, ownerOf(v, cands));
    }
    const zoneOwner = (v) => zoneOwners.get(v.name) ?? null;
    /** Removed by hand, or its object was hidden. */
    const zoneGone = (v) => edit.zoneRemoved.has(v.name) || !!zoneOwner(v)?.state.hidden;
    /** Its object moved, turned or scaled it. */
    const zoneMoved = (v) => {
      const o = zoneOwner(v);
      return !!o && !o.state.hidden && !isIdentityTransform(o.state);
    };
    /** Its frame now: as the table has it, carried by its object. */
    const zoneFrame = (v) => {
      const o = zoneOwner(v), f = volumeFrame(v);
      return o ? carriedFrame(f, o.state, o.pivot) : f;
    };
    const zoneStateText = (v) => (edit.zoneRemoved.has(v.name) ? 'Removed' : zoneGone(v) ? 'Gone with its object' : zoneMoved(v) ? 'Moved with its object' : 'Kept');
    const volumesEdited = () => zoneVolumes.some((v) => zoneGone(v) || zoneMoved(v));
    /** The gimmick table with the gone entries left out and the moved ones' records rewritten. */
    function withVolumeEdits(table) {
      const byName = new Map();
      for (const v of zoneVolumes) if (!byName.has(v.name)) byName.set(v.name, v);
      return rewriteStageVolumes(table, (name, record) => {
        const v = byName.get(name);
        if (!v) return record;
        if (zoneGone(v)) return null;
        return zoneMoved(v) ? movedVolumeRecord(record, v, zoneFrame(v)) : record;
      });
    }
    /** The export's summary line for the stage collision, or null when it is as the table has it. */
    function volumesLine() {
      if (!volumesEdited()) return null;
      const gone = zoneVolumes.filter(zoneGone).length, moved = zoneVolumes.filter((v) => !zoneGone(v) && zoneMoved(v)).length;
      return 'Stage collision: ' + (gone ? `${gone} extra volume(s) left out of the map's gimmick table` : '') + (gone && moved ? ', ' : '') +
        (moved ? `${moved} moved with their objects` : '') + '.';
    }
    /** A placement as it is now (its object's state read back), or as the table has it when it has no model. */
    const livePlacement = (g) => {
      const o = gimmickObjects.get(g);
      return o ? placementFromState(o) : g;
    };
    function setZoneRemoved(next) {
      edit.zoneRemoved = new Set(next);
      dirty = overlayDirty = true;
    }
    function showZones(which) {
      zoneShow[which] = true;
      (which === 'traps' ? zoneTrapsBox : zoneVolBox).checked = true;
      dirty = overlayDirty = true;
    }
    /** Remove or keep an entry, undoable as "Remove <name>" / "Keep <name>" (ToggleStageVolume). */
    function toggleZone(v) {
      const before = new Set(edit.zoneRemoved), next = new Set(before), removing = !next.has(v.name);
      if (removing) next.add(v.name);
      else next.delete(v.name);
      setZoneRemoved(next);
      const label = `${removing ? 'Remove' : 'Keep'} ${v.name}`;
      edit.history.push([], label, null, { undo: () => setZoneRemoved(before), redo: () => setZoneRemoved(next) });
      edit.history.breakMerge();
      showZones('volumes');
      edited();
      status.textContent = label;
    }
    /** The camera looks down at an entry (LookAtStageVolume). */
    function lookAtZone(v) {
      const { min, max } = volumeBounds(v, zoneFrame(v));
      cam.target = min.map((x, k) => (x + max[k]) / 2);
      cam.dist = Math.max(1200, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * 1.6);
      cam.pitch = Math.min(cam.pitch, -0.45);
      showZones('volumes');
    }
    const zoneTrapsBox = el('input', { type: 'checkbox' }), zoneVolBox = el('input', { type: 'checkbox' });
    zoneTrapsBox.checked = zoneShow.traps;
    zoneVolBox.checked = zoneShow.volumes;
    for (const [box, key] of [[zoneTrapsBox, 'traps'], [zoneVolBox, 'volumes']])
      box.addEventListener('change', () => {
        zoneShow[key] = box.checked;
        dirty = overlayDirty = true;
      });
    const zoneToggles = el(
      'div',
      { class: 'stage-zone-toggles' },
      el('label', {
        class: 'check',
        title: "Where gimmicks react to players, from their behaviour files: a gate's opening box and the push plate in its doorway, a ram's " +
          'hand-in sphere, the bomb stones’ climb-on cylinders, launch pads … They move with their gimmick.',
      }, zoneTrapsBox, ' Gimmick trigger zones'),
      el('label', {
        class: 'check',
        title: "Boxes and spheres the stage's gimmick table adds to the ground (collisionEntries_): players stand on and bump into them, but no model shows them.",
      }, zoneVolBox, ' Stage collision'),
    );
    const zoneNote = el('p', { class: 'muted stage-count' });
    const zoneList = el('div', { class: 'stage-gimmick-list stage-zone-list' });
    function renderZones() {
      const gm = scene.gimmicks;
      if (!gm) {
        zoneBox.replaceChildren(
          el('p', { class: 'muted' }, ctx.dataFiles?.('json/stage').length
            ? 'No gimmick table found for this stage, so no trigger zones or extra collision to show.'
            : "Open the game's Data folder to see this stage's trigger zones and extra collision (json/gimmick and the stage's gimmick table)."),
        );
        return;
      }
      const placed = gm.placements.map(livePlacement).filter((g) => !g.removed);
      const gone = zoneVolumes.filter(zoneGone).length;
      zoneNote.textContent = (trapZones ? `${placed.filter((g) => trapZones.has(g.type)).length} gimmicks with zones` : 'Reading the trigger zones…') +
        ` · ${zoneVolumes.length} collision${gone ? ` (${gone} removed)` : ''}`;
      const rows = [];
      if (zoneVolumes.length) rows.push(el('div', { class: 'stage-zone-head' }, 'Stage collision'));
      for (const v of zoneVolumes) {
        const o = zoneOwner(v), removed = edit.zoneRemoved.has(v.name);
        const about = `${v.signature} at ${v.trans.map((x) => x.toFixed(0)).join(', ')}.` +
          (o ? ` Belongs to ${shortObjectName(o.name)}: it moves, turns and goes with it.` : ' Stays where it is when the map changes.') +
          " Removed: the exported map's gimmick table leaves it out, so the game no longer adds it.";
        rows.push(el(
          'div',
          { class: 'stage-layer stage-zone', title: about },
          el('span', { class: 'stage-zone-swatch', style: `background: ${cssColour(VOLUME_COLOUR)}` }),
          el('span', { class: 'stage-layer-name' }, `${v.name} · ${describeVolume(v)}`),
          el(
            'span',
            { class: 'stage-zone-acts' },
            el('span', { class: 'muted' }, zoneStateText(v)),
            button('Look at', () => lookAtZone(v), { class: 'btn btn-sm', title: `Point the camera at ${v.name}` }),
            button(removed ? 'Keep' : 'Remove', () => toggleZone(v), {
              class: 'btn btn-sm',
              title: removed ? 'Keep it: the game adds it again' : 'Remove it: the downloaded gimmick table leaves it out',
            }),
          ),
        ));
      }
      if (trapZones) {
        const kinds = new Map();
        for (const g of placed)
          for (const z of trapZones.get(g.type) ?? []) {
            const k = trapKindName(z.kind), e = kinds.get(k);
            if (e) e.n++;
            else kinds.set(k, { n: 1, z });
          }
        if (kinds.size) rows.push(el('div', { class: 'stage-zone-head' }, 'Trigger zones on this map'));
        for (const [k, { n, z }] of [...kinds].sort((a, b) => a[0].localeCompare(b[0], 'en')))
          rows.push(el(
            'div',
            { class: 'stage-layer stage-zone' },
            el('span', { class: 'stage-zone-swatch', style: `background: ${cssColour(trapKindColour(z.kind))}` }),
            el('span', { class: 'stage-layer-name' }, k),
            el('span', { class: 'muted' }, `${n} × ${describeTrap(z)}`),
          ));
      }
      zoneList.replaceChildren(...rows);
      zoneList.hidden = !rows.length;
      if (!zoneBox.contains(zoneList)) zoneBox.replaceChildren(zoneToggles, zoneNote, zoneList);
    }
    // The lines (one buffer, a run per colour) and the labels drawn over them.
    const zoneGpu = {};
    let zoneLabelList = [];
    function drawZonesNow(vp, eye) {
      zoneLabelList = [];
      const gm = scene.gimmicks;
      if (!gm || (!zoneShow.traps && !zoneShow.volumes)) return;
      const groups = new Map(), labels = [];
      const into = (c) => {
        const k = c.join();
        let g = groups.get(k);
        if (!g) groups.set(k, (g = { c, lines: [] }));
        return g.lines;
      };
      if (zoneShow.traps && trapZones?.size)
        for (const g0 of gm.placements) {
          const zones = trapZones.get(g0.type);
          if (!zones) continue;
          const g = livePlacement(g0);
          if (g.removed) continue;
          const f = gimmickFrame(g.position, g.rotation);
          for (const z of zones) {
            const c = trapKindColour(z.kind), top = trapLines(into(c), z, f);
            labels.push({ at: [top[0], top[1] + 60, top[2]], text: trapKindName(z.kind) + (z.team ? ` · ${z.team.toLowerCase()}` : ''), c });
          }
        }
      if (zoneShow.volumes)
        for (const v of zoneVolumes) {
          if (zoneGone(v)) continue;
          const f = zoneFrame(v);
          volumeLines(into(VOLUME_COLOUR), v, f);
          const { min, max } = volumeBounds(v, f);
          labels.push({ at: [(min[0] + max[0]) / 2, max[1] + 60, (min[2] + max[2]) / 2], text: `${v.name} · invisible collision`, c: VOLUME_COLOUR });
        }
      zoneLabelList = labels;
      if (!groups.size) return;
      const data = [], runs = [];
      for (const { c, lines } of groups.values()) {
        runs.push({ c, first: data.length / 3, count: lines.length / 3 });
        for (const x of lines) data.push(x);
      }
      fillLines(zoneGpu, data, []);
      // Two passes, as the desktop draws them: faint through the ground, then solid where they are in view. WebGL
      // draws lines 1 px wide.
      gl.useProgram(lineProg.program);
      gl.uniformMatrix4fv(lineProg.u.uViewProj, false, vp);
      gl.uniform3fv(lineProg.u.uEye, eye);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.bindVertexArray(zoneGpu.vao);
      for (const [depth, alpha] of [[false, 0.5], [true, 1]]) {
        if (depth) gl.enable(gl.DEPTH_TEST);
        else gl.disable(gl.DEPTH_TEST);
        for (const r of runs) {
          gl.uniform4f(lineProg.u.uColor, r.c[0], r.c[1], r.c[2], alpha);
          gl.drawArrays(gl.LINES, r.first, r.count);
        }
      }
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.useProgram(prog.program);
    }
    function drawZoneLabelsNow(g2) {
      if (!zoneLabelList.length) return;
      g2.save();
      g2.font = '12px system-ui, sans-serif';
      g2.textAlign = 'center';
      for (const l of zoneLabelList) {
        const q = project(l.at);
        if (!q || q.x < -300 || q.y < -40 || q.x > viewW + 300 || q.y > viewH + 40) continue;
        g2.fillStyle = 'rgb(0 0 0 / 0.6)';
        g2.fillText(l.text, q.x + 1, q.y + 1);
        g2.fillStyle = cssColour(l.c);
        g2.fillText(l.text, q.x, q.y);
      }
      g2.restore();
    }
    zoneRefresh = renderZones;
    drawZones = drawZonesNow;
    drawZoneLabels = drawZoneLabelsNow;
    renderZones();
    if (scene.gimmicks && ctx.dataFiles)
      (job.trapZones || (job.trapZones = readTrapZones(ctx.dataFiles))).then(
        (z) => {
          if (stopped) return;
          trapZones = z;
          console.info(`Map editor: trigger zones for ${z.size} gimmick types; ${zoneVolumes.length} stage collision entries`);
          renderZones();
          dirty = overlayDirty = true;
        },
        (e) => console.warn(`Map editor: the gimmicks' trigger zones could not be read: ${e.message}`),
      );
    else trapZones = new Map();

    // ----- effects and sounds (StageViewerForm.Effects.cs) -----
    // The stage's effect table: the particle effects it places and its sound emitters, drawn as markers (J). The move
    // tool (Shift+J) drags one on its level and the wheel raises or lowers it, each change one undo step; Download
    // effect table writes the moved numbers into a copy of the table.
    const fxTable = scene.effects ?? null;
    const fxList = fxTable?.effects ?? [];
    const fxShow = job.effectShow || (job.effectShow = { on: false, filter: 0 });
    let fxTool = false, fxSel = null, fxHover = null, fxDrag = null, fxWheelTimer = 0, fxRows = [];
    const fxAt = (e) => edit.effectMoved.get(e.id) ?? e.position;
    const fxMoved = (e) => edit.effectMoved.has(e.id);
    const fxPasses = (e) => fxShow.filter === 0 || (fxShow.filter === 1) === (e.kind === 'effect');
    const fxShown = (e) => fxShow.on && fxPasses(e);
    const fxKind = (e) => (e.kind === 'sound' ? 'sound' : 'effect');
    const fxSame = (a, b) => (a && b ? a.every((x, k) => Math.abs(x - b[k]) <= 0.05) : a === b);
    const fxCounts = () => {
      const n = fxList.filter((e) => e.kind === 'effect').length;
      return `${n} effects, ${fxList.length - n} sounds`;
    };
    const fxHud = (e) => `Effects and sounds — ${fxKind(e)} ${effectName(e)} (${e.key}) · at ${fxAt(e).map((x) => x.toFixed(0)).join(', ')}` +
      (fxMoved(e) ? ' · moved by hand' : '');
    const fxOrder = (a, b) => byText(effectName(a), effectName(b)) || byText(a.key, b.key);
    /** Puts one at p; null, or where the stage has it, puts it back. */
    function placeEffect(e, p) {
      if (!p || fxSame(p, e.position)) edit.effectMoved.delete(e.id);
      else edit.effectMoved.set(e.id, p.slice());
      dirty = overlayDirty = true;
    }
    function setEffectMoved(next) {
      edit.effectMoved = new Map([...next].map(([id, p]) => [id, p.slice()]));
      dirty = overlayDirty = true;
    }
    /**
     * One undo step for a change to one (EndEffectChange): from before (null: where the stage has it) to where it is
     * now. Steps with the same merge key (a held key, a turn of the wheel) make one.
     */
    function effectStep(e, before, label, mergeKey = null) {
      const after = edit.effectMoved.get(e.id)?.slice() ?? null;
      if (fxSame(before, after) && !mergeKey) return;
      const act = {
        after,
        undo: () => placeEffect(e, before),
        redo: () => placeEffect(e, act.after),
        merge: (next) => ((act.after = next.after), true),
        drop: () => fxSame(before, act.after),
      };
      edit.history.push([], label, mergeKey, act);
      if (!mergeKey) edit.history.breakMerge();
      edited();
      status.textContent = fxHud(e);
    }
    const fxWas = (e) => edit.effectMoved.get(e.id)?.slice() ?? null;
    function nudgeEffect(e, d, mergeKey) {
      const was = fxWas(e), p = fxAt(e);
      placeEffect(e, [p[0] + d[0], p[1] + d[1], p[2] + d[2]]);
      effectStep(e, was, `Move ${fxKind(e)} ${effectName(e)}`, mergeKey);
    }
    /** Back where the stage has it, undoable as "Put back <name>" (ResetEffect). */
    function putBackEffect(e) {
      const was = fxWas(e);
      if (!was) return (status.textContent = `${effectName(e)} is where the stage has it`);
      placeEffect(e, null);
      effectStep(e, was, `Put back ${effectName(e)}`);
      status.textContent = `${effectName(e)} is back where the stage has it`;
    }
    function putBackAllEffects() {
      const was = new Map(edit.effectMoved);
      if (!was.size) return (status.textContent = 'Every effect and sound is where the stage has it');
      setEffectMoved(new Map());
      edit.history.push([], 'Put back every effect and sound', null, { undo: () => setEffectMoved(was), redo: () => setEffectMoved(new Map()) });
      edit.history.breakMerge();
      edited();
      status.textContent = `${was.size} put back where the stage has them`;
    }
    function selectEffect(e) {
      if (fxSel !== e) edit.history.breakMerge();
      fxSel = e;
      if (e) status.textContent = fxHud(e);
      renderEffects();
      dirty = overlayDirty = true;
    }
    /** Shows them (and this one, past the filter). */
    function showEffects(e = null) {
      fxShow.on = fxShowBox.checked = true;
      if (e && !fxPasses(e)) {
        fxShow.filter = 0;
        fxFilter.value = '0';
        renderEffects(true);
      }
      dirty = overlayDirty = true;
    }
    /** The camera looks down at one (LookAtEffect). */
    function lookAtEffect(e) {
      showEffects(e);
      cam.target = fxAt(e).slice();
      cam.pitch = Math.min(cam.pitch, -0.45);
      cam.dist = Math.max(1200, (e.range ?? 0) * 1.6);
      dirty = true;
    }
    function toggleEffects() {
      if (!fxTable) return (status.textContent = 'This stage has no effect table the editor found');
      fxShow.on = fxShowBox.checked = !fxShow.on;
      if (!fxShow.on && fxTool) setEffectTool(false);
      status.textContent = fxShow.on ? `Effects and sounds shown (${fxCounts()})` : 'Effects and sounds hidden';
      dirty = overlayDirty = true;
    }
    const FX_HINT = 'Effects and sounds: click one to select it, drag to move, wheel to raise or lower, arrows and PgUp/PgDn to nudge, Tab the next one, Delete puts it back — Shift+J done';
    function setEffectTool(on) {
      if (on === fxTool) return;
      if (on && !fxTable) return (status.textContent = 'This stage has no effect table the editor found');
      if (on) {
        if (cnMode) setCnMode(0);
        terraformOff();
        playOff();
        select(null);
        showEffects();
      } else cancelEffectDrag();
      fxTool = on;
      fxHover = null;
      canvas.style.cursor = '';
      status.textContent = on ? FX_HINT : 'Effects and sounds: done';
      edit.history.breakMerge();
      renderEffects();
      dirty = overlayDirty = true;
    }
    effectToolOff = () => setEffectTool(false);
    /** The next shown one in the list's order, the camera on it (Tab). */
    function cycleEffect(d) {
      const list = fxList.filter(fxShown).sort(fxOrder);
      if (!list.length) return;
      const i = list.indexOf(fxSel), e = list[i < 0 ? (d > 0 ? 0 : list.length - 1) : (i + d + list.length) % list.length];
      selectEffect(e);
      lookAtEffect(e);
    }
    /** The shown one drawn nearest a point of the view, within 24 px of its post (EffectNear). */
    function effectNear(p) {
      let best = 24 * 24, found = null;
      for (const e of fxList) {
        if (!fxShown(e)) continue;
        const a = fxAt(e), q = project([a[0], a[1] + 60, a[2]]);
        if (!q) continue;
        const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
        if (d < best) {
          best = d;
          found = e;
        }
      }
      return found;
    }
    function effectHover(p) {
      const h = fxShow.on ? effectNear(p) : null;
      if (h === fxHover) return;
      fxHover = h;
      dirty = overlayDirty = true;
      if (fxTool) canvas.style.cursor = h ? 'pointer' : '';
    }
    /** Where a view ray meets the level y. */
    function fxOnLevel(p, y) {
      const { o, d } = rayAt(p.x, p.y);
      if (Math.abs(d[1]) < 1e-6) return null;
      const t = (y - o[1]) / d[1];
      return t > 0 ? [o[0] + d[0] * t, y, o[2] + d[2] * t] : null;
    }
    /** Left on a marker selects it and grabs it on its level; the drag starts past 4 px (BeginEffectChange). */
    function effectPointerDown(p) {
      const e = effectNear(p);
      if (!e) return false;
      selectEffect(e);
      const at = fxAt(e), hit = fxOnLevel(p, at[1]);
      fxDrag = { e, was: fxWas(e), x0: p.x, y0: p.y, moving: false, off: hit ? [at[0] - hit[0], 0, at[2] - hit[2]] : [0, 0, 0], y: at[1] };
      return true;
    }
    function effectDragMove(p) {
      const g = fxDrag;
      if (!g.moving && Math.hypot(p.x - g.x0, p.y - g.y0) <= 4) return;
      g.moving = true;
      const hit = fxOnLevel(p, g.y);
      if (!hit) return;
      placeEffect(g.e, [hit[0] + g.off[0], g.y, hit[2] + g.off[2]]);
      status.textContent = fxHud(g.e);
    }
    function effectDragEnd() {
      const g = fxDrag;
      fxDrag = null;
      if (g?.moving) effectStep(g.e, g.was, `Move ${fxKind(g.e)} ${effectName(g.e)}`);
    }
    function cancelEffectDrag() {
      const g = fxDrag;
      fxDrag = null;
      if (g?.moving) {
        placeEffect(g.e, g.was);
        status.textContent = fxHud(g.e);
      }
    }
    /** The wheel raises or lowers the selected one: 50 a notch, Shift 10. */
    function effectWheel(ev) {
      const d = ev.deltaY || ev.deltaX; // Shift turns the wheel sideways in some browsers
      if (!d) return;
      nudgeEffect(fxSel, [0, (d < 0 ? 1 : -1) * (ev.shiftKey ? 10 : 50), 0], `fxw:${fxSel.id}`);
      clearTimeout(fxWheelTimer);
      fxWheelTimer = setTimeout(() => edit.history.breakMerge(), 600);
    }
    /** The tool's keys (EffectKey); true when one was used. */
    function effectKey(ev, k) {
      if (k === 'escape') {
        if (fxDrag) cancelEffectDrag();
        else if (fxSel) selectEffect(null);
        else setEffectTool(false);
        return true;
      }
      if (k === 'tab') return cycleEffect(ev.shiftKey ? -1 : 1), true;
      const e = fxSel;
      if (!e || fxDrag) return false;
      if (k === 'delete' || k === 'home') return putBackEffect(e), true;
      if (k === 'pageup' || k === 'pagedown') return nudgeEffect(e, [0, (k === 'pageup' ? 1 : -1) * (ev.shiftKey ? 250 : 50), 0], `fxk:${e.id}`), true;
      const arrows = { arrowup: [1, 0], arrowdown: [-1, 0], arrowleft: [0, -1], arrowright: [0, 1] }[k];
      if (!arrows) return false;
      // Along the view, flattened: up away from the camera, right to the view's right.
      const { f, r } = basis(), s = ev.shiftKey ? 500 : 50;
      const flat = (v) => {
        const n = Math.hypot(v[0], v[2]);
        return n > 1e-6 ? [v[0] / n, 0, v[2] / n] : [0, 0, 0];
      };
      const fw = flat(f), rt = flat(r);
      nudgeEffect(e, [0, 1, 2].map((i) => (fw[i] * arrows[0] + rt[i] * arrows[1]) * s), `fxk:${e.id}`);
      return true;
    }
    async function downloadEffectTable() {
      if (!fxTable) return;
      let r, bytes;
      try {
        r = movedEffectTable(fxTable, (rec) => edit.effectMoved.get(rec.id) ?? null);
        if (!r) return toast('No effect or sound has been moved yet.');
        bytes = await effectTableBytes(fxTable, r.text);
      } catch (e) {
        console.error(e);
        return toast(`The effect table could not be written: ${e.message}`, 'error');
      }
      downloadBytes(bytes, fxTable.name, 'application/json');
      const parts = [];
      if (r.effects) parts.push(`${r.effects} effect${r.effects === 1 ? '' : 's'}`);
      if (r.sounds) parts.push(`${r.sounds} sound${r.sounds === 1 ? '' : 's'}`);
      toast(`Effects and sounds: ${parts.join(' and ')} moved by hand — written to ${fxTable.name}.`, 'ok', 10000);
    }
    // The panel: show and filter, the tool, the list (Look at, Put back) and the download.
    const fxShowBox = el('input', { type: 'checkbox' });
    fxShowBox.checked = fxShow.on;
    fxShowBox.addEventListener('change', () => {
      if (fxShowBox.checked !== fxShow.on) toggleEffects();
    });
    const fxFilter = el('select', { title: 'Which ones to show and list' }, ...EFFECT_FILTERS.map((t, i) => el('option', { value: String(i) }, t)));
    fxFilter.value = String(fxShow.filter);
    fxFilter.addEventListener('change', () => {
      fxShow.filter = Number(fxFilter.value);
      if (fxSel && !fxPasses(fxSel)) fxSel = null;
      renderEffects(true);
      dirty = overlayDirty = true;
    });
    const fxToolBtn = button('Move tool', () => setEffectTool(!fxTool), {
      class: 'btn btn-sm',
      title: 'Click an effect or sound to select it, drag it on its level, the wheel raises or lowers it (Shift+J)',
    });
    const fxBackAllBtn = button('Put back all', putBackAllEffects, { class: 'btn btn-sm', title: 'Put back every effect and sound' });
    const fxDownloadBtn = button('Download effect table', downloadEffectTable, {
      class: 'btn btn-sm',
      title: "Write the moved effects and sounds into a copy of the stage's effect table (<stage>_stage_effect.json), every other byte as it was",
    });
    const fxNote = el('p', { class: 'muted stage-count' });
    const fxInfo = el('p', { class: 'muted stage-effect-info' });
    const fxListBox = el('div', { class: 'stage-gimmick-list stage-zone-list' });
    function effectRow(e) {
      const state = el('span', { class: 'muted' });
      const back = button('Put back', () => putBackEffect(e), { class: 'btn btn-sm', title: `Put ${effectName(e)} back where the stage has it` });
      const c = e.kind === 'sound' ? SOUND_COLOUR : EFFECT_COLOUR;
      const row = el(
        'div',
        { class: 'stage-layer stage-zone', title: describeEffect(e, e.position, false) },
        el('span', { class: 'stage-zone-swatch', style: `background: ${cssColour(c)}` }),
        el('span', { class: 'stage-layer-name' }, effectName(e) + (e.name && e.name !== e.key ? `  ·  ${e.key}` : '')),
        el(
          'span',
          { class: 'stage-zone-acts' },
          state,
          button('Look at', () => (selectEffect(e), lookAtEffect(e)), { class: 'btn btn-sm', title: `Point the camera at ${effectName(e)}` }),
          back,
        ),
      );
      row.update = () => {
        state.textContent = fxMoved(e) ? 'moved' : '';
        back.disabled = !fxMoved(e);
        row.classList.toggle('active', fxSel === e);
      };
      return row;
    }
    function renderEffects(rebuild = false) {
      if (!fxTable) {
        effectBox.replaceChildren(
          el('p', { class: 'muted' }, ctx.dataFiles?.('json/stage').length
            ? 'No effect table found for this stage (json/stage/<stage>_stage_effect.json), so no effects or sounds to show.'
            : "Open the game's Data folder to see this stage's effects and sounds (json/stage/<stage>_stage_effect.json)."),
        );
        return;
      }
      const moved = fxList.filter(fxMoved).length;
      fxNote.textContent = `${fxCounts()}${moved ? ` · ${moved} moved` : ''} · ${fxTable.name}`;
      fxToolBtn.setAttribute('aria-pressed', String(fxTool));
      fxBackAllBtn.disabled = fxDownloadBtn.disabled = !moved;
      fxInfo.hidden = !fxSel;
      fxInfo.textContent = fxSel ? describeEffect(fxSel, fxAt(fxSel), fxMoved(fxSel)) : '';
      if (rebuild || !fxRows.length) {
        fxRows = fxList.filter(fxPasses).sort(fxOrder).map(effectRow);
        fxListBox.replaceChildren(...fxRows);
      }
      for (const r of fxRows) r.update();
      if (!effectBox.contains(fxListBox))
        effectBox.replaceChildren(
          el('div', { class: 'stage-zone-toggles' }, el('label', {
            class: 'check',
            title: 'Where the stage plays its particle effects (orange, a diamond on top) and its sounds (green, a ring where they are heard) (J)',
          }, fxShowBox, ' Show'), fxFilter),
          fxNote,
          el('div', { class: 'toolbar' }, fxToolBtn, fxBackAllBtn, fxDownloadBtn),
          fxInfo,
          fxListBox,
        );
    }
    // The markers (one buffer, a run per colour and pass) and the labels drawn over them.
    const fxGpu = {};
    let fxLabelList = [];
    function drawEffectsNow(vp, eye) {
      fxLabelList = [];
      if (!fxTable || !fxShow.on) return;
      const aimed = fxDrag ? fxDrag.e : fxHover, sel = fxSel;
      const focus = (e) => e === aimed || e === sel;
      const lines = { effect: [], sound: [], ring: [], fxFocus: [], seFocus: [], fxBack: [], seBack: [] };
      const near = [];
      for (const e of fxList) {
        if (!fxShown(e)) continue;
        const p = fxAt(e), snd = e.kind === 'sound';
        if (focus(e)) {
          const out = snd ? lines.seFocus : lines.fxFocus;
          markerLines(out, e, p);
          if (snd && e.range > 0) rangeRing(out, p, e.range);
          if (fxMoved(e)) (snd ? lines.seBack : lines.fxBack).push(...e.position, ...p);
          continue;
        }
        markerLines(snd ? lines.sound : lines.effect, e, p);
        if (snd && e.range > 0) rangeRing(lines.ring, p, e.range);
        const d = (p[0] - eye[0]) ** 2 + (p[1] - eye[1]) ** 2 + (p[2] - eye[2]) ** 2;
        if (d < 3000 * 3000) near.push({ d, e, p });
      }
      // Labels: the few nearest the camera, then the aimed and the selected one with more.
      near.sort((a, b) => a.d - b.d);
      const label = (e, p, more) => {
        let text = effectName(e);
        if (more) {
          if (e.name && e.name !== e.key) text += `  ·  ${e.key}`;
          if (e.kind === 'sound' && e.range > 0) text += `  ·  heard within ${oneDecimal(e.range / 100)} m`;
          if (fxMoved(e)) text += '  ·  moved';
        }
        fxLabelList.push({ at: [p[0], p[1] + postOf(e) + 40, p[2]], text, c: e.kind === 'sound' ? SOUND_COLOUR : EFFECT_COLOUR, a: more ? 1 : 200 / 255 });
      };
      for (const { e, p } of near.slice(0, 12)) label(e, p, false);
      for (const e of new Set([aimed, sel])) if (e && fxShown(e)) label(e, fxAt(e), true);
      const brighter = (c) => c.map((x) => Math.min(1, x + 0.2));
      const runs = [], data = [];
      const run = (list, c, a, both) => {
        if (!list.length) return;
        runs.push({ c, a, both, first: data.length / 3, count: list.length / 3 });
        for (const x of list) data.push(x);
      };
      run(lines.effect, EFFECT_COLOUR, 1, true);
      run(lines.sound, SOUND_COLOUR, 1, true);
      run(lines.ring, SOUND_COLOUR, 0.7, true);
      run(lines.fxFocus, brighter(EFFECT_COLOUR), 1, false);
      run(lines.seFocus, brighter(SOUND_COLOUR), 1, false);
      run(lines.fxBack, EFFECT_COLOUR, 0.5, false);
      run(lines.seBack, SOUND_COLOUR, 0.5, false);
      if (!runs.length) return;
      fillLines(fxGpu, data, []);
      // Faint through the ground, then solid where they are in view; the aimed and the selected one on top.
      gl.useProgram(lineProg.program);
      gl.uniformMatrix4fv(lineProg.u.uViewProj, false, vp);
      gl.uniform3fv(lineProg.u.uEye, eye);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.bindVertexArray(fxGpu.vao);
      for (const [depth, alpha] of [[false, 0.22], [true, 0.9]]) {
        if (depth) gl.enable(gl.DEPTH_TEST);
        else gl.disable(gl.DEPTH_TEST);
        for (const r of runs)
          if (r.both) {
            gl.uniform4f(lineProg.u.uColor, r.c[0], r.c[1], r.c[2], alpha * r.a);
            gl.drawArrays(gl.LINES, r.first, r.count);
          }
      }
      gl.disable(gl.DEPTH_TEST);
      for (const r of runs)
        if (!r.both) {
          gl.uniform4f(lineProg.u.uColor, r.c[0], r.c[1], r.c[2], r.a);
          gl.drawArrays(gl.LINES, r.first, r.count);
        }
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.useProgram(prog.program);
    }
    function drawEffectLabelsNow(g2) {
      if (!fxLabelList.length) return;
      g2.save();
      g2.font = '12px system-ui, sans-serif';
      g2.textAlign = 'center';
      for (const l of fxLabelList) {
        const q = project(l.at);
        if (!q || q.x < -300 || q.y < -40 || q.x > viewW + 300 || q.y > viewH + 40) continue;
        g2.fillStyle = 'rgb(0 0 0 / 0.6)';
        g2.fillText(l.text, q.x + 1, q.y + 1);
        g2.fillStyle = `rgb(${l.c.map((x) => Math.trunc(x * 255)).join(' ')} / ${l.a.toFixed(3)})`;
        g2.fillText(l.text, q.x, q.y);
      }
      g2.restore();
    }
    effectRefresh = renderEffects;
    drawEffects = drawEffectsNow;
    drawEffectLabels = drawEffectLabelsNow;
    renderEffects();

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
      const tags = edit.gimmickTags?.();
      const setUp = Object.keys(edit.gimmickSetup).filter((t) => !tags || tags.has(t)).length;
      const sx = setupExport();
      const setupWrites = !!sx && (sx.records > 0 || (!sx.planEmpty && !!setupFiles.loose) || (sx.tacticsEdit && !!setupFiles.tactics));
      gimmickNote.textContent =
        `${own} placements in ${gm.table.name}; ${[...gimmickObjects.keys()].filter((g) => !g.isNew).length} shown with their models. ` +
        (changed.length || setUp
          ? `Edited: ${moved} moved, ${removed} removed${added ? `, ${added} added` : ''}${setUp ? `, ${setUp} set up differently` : ''}.`
          : 'Select one to move, turn or remove (Del) it, or set up its team.');
      gimmickBtn.disabled = !changed.length && !setupWrites && !volumesEdited();
      renderSetup();
      if (!gimmickBox.contains(gimmickList))
        gimmickBox.replaceChildren(gimmickNote, el('div', { class: 'toolbar' }, gimmickBtn, addBtn), catalogBox, setupBox, gimmickList);
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
        writeObject(o, tfHook);
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
      const sx = setupExport(); // also brings the placements up to date
      const files = [];
      let r;
      try {
        r = editedGimmickTable(gm.table.text, gm.placements, setupRules.setupFields);
        // The stage collision removed or moved with its object (WithStageVolumeEdits), on top of the gimmicks' edits.
        const text = volumesEdited() ? withVolumeEdits(r?.text ?? gm.table.text) : r?.text;
        if (text != null && text !== gm.table.text) files.push([await gimmickTableBytes(gm.table, text), gm.table.name, 'application/json']);
        // The installed copies the setup changes, wrapped like them and named as the desktop export names them.
        const nutName = `${edit.stage}_ssn_stage_setting.nut`, tacticsName = `${edit.stage}_stage_tactics.json`;
        if (sx && !sx.planEmpty && setupFiles.loose)
          files.push([await companionBytes(setupFiles.loose, (b) => applyStageScript(b, sx.plan).bytes, nutName), nutName, 'text/plain']);
        if (sx?.tacticsEdit && setupFiles.tactics)
          files.push([await companionBytes(setupFiles.tactics, (b) => applyTactics(b, sx.copies, sx.values, sx.moves), tacticsName), tacticsName, 'application/json']);
      } catch (e) {
        console.error(e);
        return toast(`The gimmick table could not be written: ${e.message}`, 'error');
      }
      if (!files.length)
        return toast(sx && !sx.planEmpty && setupFiles.bundle
          ? 'This setup only changes the stage script inside the map: use Download bundle.'
          : 'No gimmick has been moved, turned, removed or set up yet.');
      for (const f of files) downloadBytes(...f);
      const lines = r ? [`Gimmicks: ${r.moved} moved, ${r.removed} removed, ${r.added} added — table written to ${gm.table.name}.`] : [];
      const vl = volumesLine();
      if (vl) lines.push(vl);
      toast([...lines, ...(sx?.lines ?? [])].join(' '), 'ok', 10000);
    }
    /** An edited companion table, wrapped like the installed one and read back (WriteCompanion). */
    async function companionBytes(file, change, name) {
      const plain = change(file.bytes);
      const bytes = file.layers?.length ? await encodeLayers(plain, file.layers) : plain;
      if (!sameBytes((await decodeLayers(bytes)).payload, plain)) throw new Error(`${name} did not read back`);
      return bytes;
    }
    /** The setup as it would be written now (exportPlan), the placements brought up to date first; null with no table. */
    function setupExport() {
      if (!scene.gimmicks) return null;
      for (const o of gimmickObjects.values()) placementFromState(o);
      return setupRules.exportPlan({ inBundle: !!setupFiles.bundle, loose: !!setupFiles.loose });
    }
    /** Replaces the setup in place (the rules hold edit.gimmickSetup). */
    function setSetup(next) {
      for (const k of Object.keys(edit.gimmickSetup)) delete edit.gimmickSetup[k];
      Object.assign(edit.gimmickSetup, setupFromFeature(next));
    }
    /** The selected gimmick's setup rows (GimmickSetupRows): the arrows step each one; Ctrl+Z undoes it. */
    function renderSetup() {
      const o = selected();
      const g = o?.gimmick ? placementFromState(o) : null;
      const rows = g ? setupRules.rows(g) : [];
      setupBox.hidden = !rows.length;
      if (!rows.length) return setupBox.replaceChildren();
      setupBox.replaceChildren(
        el('div', { class: 'stage-setup-head' }, `Setup · ${g.type} ${g.tag}`),
        ...rows.map((r) => {
          const back = button('◀', () => stepSetup(g, r, -1), { title: `${r.label}: the one before` });
          const next = button('▶', () => stepSetup(g, r, 1), { title: `${r.label}: the next one` });
          back.disabled = next.disabled = !r.enabled;
          return el('div', { class: 'stage-setup-row', title: r.title },
            el('span', { class: 'stage-setup-label' }, r.label), back, el('span', { class: 'stage-setup-value' }, r.value), next);
        }),
      );
    }
    /** One step of a setup row, undoable as "<what> · <tag>" (ChangeSetup). */
    function stepSetup(g, r, d) {
      const s = r.step(d);
      if (!s) return;
      const tag = g.tag, was = setupRules.setupOf(g);
      const before = was ? cleanSetup(was) : null, after = s.edit ? cleanSetup(s.edit) : null;
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      const put = (e) => (e ? (edit.gimmickSetup[tag] = { ...e }) : delete edit.gimmickSetup[tag]);
      put(after);
      edit.history.push([], `${s.what} · ${tag}`, null, { undo: () => put(before), redo: () => put(after) });
      edit.history.breakMerge();
      edited();
      status.textContent = `${s.what} · ${tag}`;
    }
    /**
     * The stage script and bot tactics the setup writes (LoadGimmickSetup): the bundle's stage_setting.nut, the installed
     * Data/ssn/<id>/stage_setting.nut and Data/json/stage/<id>_stage_tactics.json, each {path, bytes, layers}.
     */
    async function readSetupFiles() {
      const out = { bundle: null, loose: null, tactics: null };
      const e = model.entries.find((x) => (x.name || '').toLowerCase() === 'stage_setting.nut');
      if (e && !e.pointer && e.data?.length) out.bundle = { path: e.name, bytes: (await decodeLayers(e.data)).payload, layers: [] };
      const read = async (f) => {
        const d = await decodeLayers(await f.read());
        return { path: f.path, bytes: d.payload, layers: d.layers };
      };
      const ids = [...new Set([scene.gimmicks?.table.stageId, ...(job.ids ?? [])].filter(Boolean))];
      for (const id of ids) {
        const nut = out.loose ? null : ctx.dataFiles?.(`ssn/${id}`).find((f) => f.name.toLowerCase() === 'stage_setting.nut');
        if (nut) out.loose = await read(nut);
        const want = `${id}_stage_tactics.json`.toLowerCase();
        const tf = out.tactics ? null : ctx.dataFiles?.('json/stage').find((f) => f.name.toLowerCase() === want);
        if (tf) out.tactics = await read(tf);
      }
      return out;
    }
    if (scene.gimmicks)
      (job.setupFiles || (job.setupFiles = readSetupFiles())).then(
        (f) => {
          if (stopped) return;
          Object.assign(setupFiles, f);
          const master = f.bundle ?? f.loose;
          setupCtx.nut = master ? readStageScript(master.bytes)?.info ?? null : null;
          setupCtx.tactics = f.tactics ? latin1(f.tactics.bytes) : null;
          console.info(
            `Map editor: gimmick setup: stage script ${setupCtx.nut ? `${setupCtx.nut.calls.length} gimmick calls` : 'not found'}` +
              (f.loose ? `, installed copy ${f.loose.path}` : '') + (f.tactics ? ', tactics found' : ''),
          );
          renderGimmicks();
          downloadRefresh();
        },
        (e) => console.warn(`Map editor: the gimmick setup files of ${edit.stage} could not be read: ${e.message}`),
      );
    gimmickRefresh = renderGimmicks;
    renderGimmicks();
    setLinks(edit.links ?? readLinks(edit.storedLinks));

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
      if (play) {
        // Playing: any button turns the view around the player.
        drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, pan: false, moved: false };
        return;
      }
      if (fxTool && e.button === 0) {
        // The effects tool: a marker is grabbed; anywhere else turns the view, and a click there lets go of the selection.
        if (effectPointerDown(local(e))) return;
        drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, pan: e.shiftKey, moved: false, fx: true };
        return;
      }
      if (tfOn && e.button === 0) return tfBegin(local(e), e.ctrlKey || e.metaKey ? -1 : 1);
      if (cnMode && e.button === 0) return cnPointerDown(local(e), e.shiftKey);
      if (e.button === 0 && !gdrag) {
        const p = local(e), handle = gizmoHit(p);
        if (handle >= 0 && startGizmo(handle, p)) return;
        if (!cnMode && (e.ctrlKey || e.metaKey)) {
          boxDrag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, remove: e.shiftKey, moved: false };
          return;
        }
      }
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, pan: cnMode || tfOn ? e.button === 1 : e.button !== 0 || e.shiftKey, moved: false };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (play && !drag) return;
      if (fxDrag) return effectDragMove(local(e));
      if (gdrag) return moveGizmo(local(e), e);
      if (boxDrag) {
        const p = local(e);
        Object.assign(boxDrag, { x1: p.x, y1: p.y });
        if (Math.hypot(p.x - boxDrag.x0, p.y - boxDrag.y0) > 5) boxDrag.moved = true;
        overlayDirty = true;
        return;
      }
      if (tfOn && !drag) return tfPointerMove(local(e), e.ctrlKey || e.metaKey);
      if (cnMode && !drag) return cnPointerMove(local(e), e.shiftKey);
      if (!drag && fxShow.on) effectHover(local(e));
      if (!drag && fxTool) return;
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
        cam.pitch = play ? playPitch(cam.pitch - dy * 0.006) : Math.max(-1.55, Math.min(1.55, cam.pitch - dy * 0.006));
      }
      dirty = true;
    });
    canvas.addEventListener('pointerup', (e) => {
      if (play) {
        drag = null;
        return;
      }
      if (fxDrag) return effectDragEnd();
      if (gdrag) return endGizmo();
      if (tfStroke) return tfEnd();
      if (cnStroke) return cnStrokeEnd();
      if (boxDrag) {
        const b = boxDrag;
        boxDrag = null;
        overlayDirty = true;
        if (b.moved) return boxSelect(b, b.remove);
        const { o, d: dir } = rayAt(b.x0, b.y0);
        return toggleSelect(pick(scene, o, dir));
      }
      const d = drag;
      drag = null;
      if (!d || d.moved || e.button !== 0) return;
      if (d.fx) return selectEffect(null);
      const p = local(e);
      const { o, d: dir } = rayAt(p.x, p.y);
      inspect(pick(scene, o, dir));
    });
    canvas.addEventListener('pointercancel', () => {
      cancelEffectDrag();
      if (gdrag) cancelDrag();
      cnStrokeEnd();
      tfEnd();
      drag = null;
      boxDrag = null;
      overlayDirty = true;
    });
    canvas.addEventListener('dblclick', (e) => {
      if (cnMode || tfOn) return;
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
        if (play) return void (play.camDist = playWheel(play.camDist, e.deltaY < 0));
        if (fxTool && fxSel && !e.altKey) return effectWheel(e);
        if (tfOn && !e.altKey) return tfWheel(e);
        if (cnMode && cnMode !== 4 && !e.altKey) return cnWheel(e);
        cam.dist = Math.max(near(), cam.dist * Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
        dirty = true;
      },
      { passive: false },
    );
    canvas.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      if (play) return playKey(e, k);
      if (k === 'f5' && !ctrl && !e.altKey) {
        e.preventDefault();
        return startPlay();
      }
      if (ctrl && !e.altKey && (k === 'z' || k === 'y')) {
        e.preventDefault();
        cnStrokeEnd();
        tfEnd();
        if (k === 'y' || e.shiftKey) redo();
        else undo();
        return;
      }
      if (k === 'f3' && !ctrl) {
        e.preventDefault();
        return setCnMode(cnMode ? 0 : colRead?.live ? 1 : 2);
      }
      if (k === 'f2' && !ctrl) {
        e.preventDefault();
        return setTerraform(!tfOn);
      }
      if (ctrl && !e.altKey && !e.shiftKey && k === 'd') {
        e.preventDefault();
        return duplicateGimmick();
      }
      if (ctrl && !e.altKey && k === 'g') {
        e.preventDefault();
        return e.shiftKey ? unlinkSelection() : linkSelection();
      }
      if (k === 'f10') {
        e.preventDefault();
        return openMenu();
      }
      if (tfOn && !ctrl && !e.altKey && tfKey(k)) return e.preventDefault();
      if (fxTool && !ctrl && !e.altKey && effectKey(e, k)) return e.preventDefault();
      // J shows the effects and sounds, Shift+J is their move tool.
      if (k === 'j' && !ctrl && !e.altKey && (e.shiftKey || !cnMode)) {
        e.preventDefault();
        return e.shiftKey ? setEffectTool(!fxTool) : toggleEffects();
      }
      if (cnMode && !ctrl && cnKey(e, k)) return e.preventDefault();
      if (k === 'u' && !e.altKey) {
        e.preventDefault();
        return gridKey(ctrl, e.shiftKey);
      }
      // Esc: lets go of a drag, then of the selection; with nothing selected it opens the menu (as the desktop's).
      if (k === 'escape') return gdrag ? cancelDrag() : selection ? select(null) : openMenu();
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

    // ----- controller (StageViewerForm.Forge.cs PollGamepad): fly, look, grab and carry -----
    const PAD_HINT =
      'Left stick: fly · Right stick: look · RT/LT: up/down · A: grab · B: deselect · X: add a gimmick · Y: placement panel · D-pad ←/→: undo/redo, ↓: collision · LB/RB: fly speed · R3: frame · View: controls · Menu: menu';
    const CARRY_HINT =
      'Carrying · A: drop · B: put back · X: stamp a copy · Y: surface/air · Hold LB or RB + sticks: turn (tap: 15°) · D-pad ←/→: size, ↑/↓: lift (in the air: distance) · R3: reset turn and size';
    const PAD_HELP = [
      ['Left stick', 'Fly (hold L3 to go faster)'],
      ['Right stick', 'Look around'],
      ['RT / LT', 'Fly up / down'],
      ['A', 'Grab the object in the middle of the view; A again drops it there'],
      ['B', 'Clear the selection; while carrying, put the object back'],
      ['X', 'Add a gimmick; while carrying a gimmick, drop it and carry a copy'],
      ['Y', 'Go to the placement panel (B comes back); while carrying, place on surfaces or in the air'],
      ['LB / RB', 'Fly slower / faster; while carrying, hold one and use the sticks to turn it, tap to turn 15°'],
      ['D-pad', 'Left / right: undo / redo, down: collision lines; while carrying, left / right: size, up / down: lift (in the air: distance)'],
      ['R3', 'Frame the object in the middle of the view; while carrying, reset its turn and size'],
      ['View', 'This list'],
      ['Menu', 'The menu: undo, link, grid and snapping, layers, save and more (B: back, Menu: close)'],
      ['Outside the map', 'Stick or D-pad: move between controls, A: press, B: back out, X / Y: next / previous control, View: back'],
    ];
    let padUsed = false;
    const padDue = new Map();
    /** True on the press, then after 0.35 s, then every 0.12 s while held (the desktop's Repeat). */
    const padRepeat = (key, on) => {
      const now = performance.now();
      if (!on) return padDue.delete(key), false;
      const t = padDue.get(key);
      if (t === undefined) return padDue.set(key, now + 350), true;
      if (now < t) return false;
      padDue.set(key, now + 120);
      return true;
    };
    const padClamp = (v, a, b) => Math.max(a, Math.min(b, v));
    /** What the middle of the view aims at (leaving out `skip`). */
    const aimed = (skip = null) => {
      const { o, d } = rayAt(canvas.clientWidth / 2, canvas.clientHeight / 2);
      return pick(scene, o, d, skip);
    };
    const eyeTo = (p) => {
      const { eye } = basis();
      return Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]);
    };
    function setPadHint() {
      if (play) {
        const t = play.avatar ? (padUsed ? AVATAR_PAD_HINT : AVATAR_HINT) : padUsed ? PLAY_PAD_HINT : PLAY_HINT;
        if (hint.textContent !== t) hint.textContent = t;
        return;
      }
      if (cnMode) return;
      if (tfOn) {
        const t = tfHint();
        if (hint.textContent !== t) hint.textContent = t;
        return;
      }
      const t = padUsed ? (carry ? CARRY_HINT : PAD_HINT) : baseHint;
      if (hint.textContent !== t) hint.textContent = t;
    }
    /** The carried objects: the one grabbed first, then the rest of the selection or its link. */
    const carried = () => [carry.o, ...carry.mates.map((m) => m.o)];
    /**
     * Picks an object up (the desktop's Grab) with the rest of the selection when it is in it: they keep their place
     * against the surface under the aim until moved.
     */
    function startCarry(o) {
      if (o.state.hidden) return false;
      if (!o.bounds) apply(o, o.state);
      const sel = selectedAll(), list = sel.includes(o) ? [o, ...sel.filter((x) => x !== o)] : [o];
      const b = unionBounds(list) || o.bounds, c = centre(b), hit = aimed(list);
      const mates = list.slice(1).map((x) => ({ o: x, start: x.state }));
      carry = { o, start: o.state, mates, surface: !!hit, lift: 0, dist: 0, offset: [0, 0, 0], twisted: false, sig: '' };
      if (hit) {
        carry.offset = [c[0] - hit.point[0], 0, c[2] - hit.point[2]];
        carry.lift = padClamp(b.min[1] - hit.point[1], -2000, 4000);
      } else carry.dist = padClamp(eyeTo(c), 150, 30000);
      edit.history.breakMerge();
      const what = mates.length ? `${list.length} objects` : shortObjectName(o.name);
      flash(`Carrying ${what}: A drops ${mates.length ? 'them' : 'it'}, B puts ${mates.length ? 'them' : 'it'} back`);
      return true;
    }
    /** The carried object follows the aim: on the surface under it, or in the air ahead (UpdateHeld). */
    function followCarry() {
      const o = carry.o;
      const sig = [cam.yaw, cam.pitch, cam.dist, ...cam.target, carry.surface, carry.lift, carry.dist, ...o.state.r, ...o.state.s, grid.snap, grid.size, grid.height].join();
      const all = carried(), b = unionBounds(all);
      if (sig === carry.sig || !b) return;
      carry.sig = sig;
      const c = centre(b);
      let to;
      if (carry.surface) {
        const hit = aimed(all);
        if (!hit) return;
        to = [hit.point[0] + carry.offset[0], hit.point[1] + carry.lift + (c[1] - b.min[1]), hit.point[2] + carry.offset[2]];
      } else {
        const { f, eye } = basis();
        to = eye.map((x, k) => x + f[k] * carry.dist);
      }
      let dt = to.map((x, k) => x - c[k]);
      if (grid.snap) dt = snapCarryMove(grid, dt, c, b.min[1], carry.surface);
      if (Math.abs(dt[0]) + Math.abs(dt[1]) + Math.abs(dt[2]) < 1e-6) return;
      for (const x of all) apply(x, withState(x.state, { t: x.state.t.map((v, k) => v + dt[k]) }));
    }
    /** Puts the carried object down where it is: one undo step from where it was picked up. */
    function dropCarry() {
      if (!carry) return;
      const items = [{ o: carry.o, start: carry.start }, ...carry.mates];
      const final = new Map(items.map(({ o }) => [o, o.state]));
      carry = null;
      for (const { o, start } of items) apply(o, start);
      change(items.map(({ o }) => o), (st, o) => final.get(o), 'Carry');
      edit.history.breakMerge();
      setPadHint();
    }
    /** Puts the carried object back where it was picked up. */
    function cancelCarry() {
      if (!carry) return;
      const items = [{ o: carry.o, start: carry.start }, ...carry.mates];
      carry = null;
      for (const { o, start } of items) apply(o, start);
      setPadHint();
    }
    /** Turns the carried object; the rest of a carried group turns the same way about it. */
    function twistCarry(d) {
      const o = carry.o, r0 = o.state.r, r1 = r0.map((x, i) => wrapDegrees(x + d[i]));
      apply(o, withState(o.state, { r: r1 }));
      if (!carry.mates.length) return;
      const M = rotationDelta(r0, r1), about = o.pivot.map((x, k) => x + o.state.t[k]);
      for (const { o: x } of carry.mates) apply(x, turnStateBy(x.state, x.pivot, about, M));
    }
    function padHelp() {
      openDialog((dlg, done) => {
        dlg.append(
          el('h2', { class: 'dialog-title' }, 'Controller'),
          el('dl', { class: 'stage-pad-help' }, PAD_HELP.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
          el('div', { class: 'dialog-actions' }, button('Close', () => done(null), { autofocus: true })),
        );
      });
    }
    function padFlyLook(pad) {
      const { f, r } = basis();
      const speed = Math.max(5, sceneRadius * 0.35) * flyMul * (pad.held(PAD.L3) ? 4 : 1) * pad.dt;
      const up = pad.rt - pad.lt;
      if (pad.lx || pad.ly || up) {
        cam.target = cam.target.map((x, k) => x + (f[k] * pad.ly + r[k] * pad.lx + (k === 1 ? up : 0)) * speed);
        dirty = true;
      }
      if (pad.rx || pad.ry) {
        // Turn the camera where it stands (the desktop looks from the eye, not about a centre).
        const { eye } = basis();
        cam.yaw += pad.rx * 2.6 * pad.dt;
        cam.pitch = padClamp(cam.pitch + pad.ry * 2.6 * pad.dt, -1.55, 1.55);
        const nf = basis().f;
        cam.target = eye.map((x, k) => x + nf[k] * cam.dist);
        dirty = true;
      }
    }
    function padCarry(pad) {
      const o = carry.o;
      if (pad.edge(PAD.LB) || pad.edge(PAD.RB)) carry.twisted = false;
      if (pad.held(PAD.LB) || pad.held(PAD.RB)) {
        const k = 110 * pad.dt, d = [-(pad.ly + pad.ry) * k, pad.lx * k, -pad.rx * k]; // tilt, turn, lean (TwistRate)
        if (d.some((x) => x)) {
          carry.twisted = true;
          twistCarry(d);
        }
      } else padFlyLook(pad);
      for (const [b, s] of [[PAD.LB, -1], [PAD.RB, 1]]) if (pad.released(b) && !carry.twisted) twistCarry([0, 15 * s, 0]);
      if (pad.edge(PAD.A)) return dropCarry();
      if (pad.edge(PAD.B)) return cancelCarry(), flash('Put back');
      if (pad.edge(PAD.X)) {
        if (!o.gimmick || carry.mates.length) return toast('Only a single gimmick can be copied here so far.');
        dropCarry();
        // Stamp: the copy comes in at the aim and is carried on (DuplicateGimmick).
        return duplicateGimmick().then(() => {
          const n = selected();
          if (n && n !== o && !carry && !stopped) startCarry(n);
          setPadHint();
        });
      }
      if (pad.edge(PAD.Y)) {
        carry.surface = !carry.surface;
        if (carry.surface) (carry.lift = 0), (carry.offset = [0, 0, 0]);
        else carry.dist = padClamp(eyeTo(centre(unionBounds(carried()) || o.bounds)), 150, 30000);
        toast(carry.surface ? 'Placing on surfaces' : 'Placing in the air (D-pad up / down: farther / closer)');
      } else if (pad.edge(PAD.R3)) {
        if (carry.mates.length) {
          // A group goes back to how it was picked up, where it is now.
          const dt = o.state.t.map((x, k) => x - carry.start.t[k]);
          for (const { o: x, start } of [{ o, start: carry.start }, ...carry.mates]) apply(x, withState(start, { t: start.t.map((v, k) => v + dt[k]) }));
        } else {
          const s0 = o.stock ?? IDENTITY;
          apply(o, withState(o.state, { r: s0.r.slice(), s: s0.s.slice() }));
        }
      }
      const sl = padRepeat('left', pad.held(PAD.LEFT)), sr = padRepeat('right', pad.held(PAD.RIGHT));
      if (sl || sr) {
        if (carry.mates.length) {
          const all = carried(), b = unionBounds(all), f = sr ? 1.1 : 1 / 1.1;
          if (b) for (const x of all) apply(x, fit(x, scaleState(x.state, x.pivot, centre(b), f)));
        } else if (!o.gimmick) apply(o, withState(o.state, { s: o.state.s.map((x) => padClamp(x * (sr ? 1.1 : 1 / 1.1), 0.01, 100)) }));
        else if (pad.edge(PAD.LEFT) || pad.edge(PAD.RIGHT)) toast("A gimmick's table has no size.");
      }
      const lu = padRepeat('up', pad.held(PAD.UP)), ld = padRepeat('down', pad.held(PAD.DOWN));
      if (lu || ld) {
        if (carry.surface) carry.lift = padClamp(carry.lift + (lu ? 1 : -1) * nudgeStep, -2000, 4000);
        else carry.dist = padClamp(carry.dist * (lu ? 1.12 : 1 / 1.12), 150, 30000);
      }
      followCarry();
    }
    function padFree(pad) {
      padFlyLook(pad);
      if (tfOn) return padTerraform(pad);
      if (cnMode) {
        // The collision & nav editor keeps its own keys; the pad flies, looks and can leave it with B.
        if (pad.edge(PAD.B)) canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        return;
      }
      if (pad.edge(PAD.A)) {
        const hit = aimed();
        if (hit?.object && !hit.object.state.hidden) {
          // Aiming at part of the selection carries all of it; anything else is selected first (with its link).
          if (!selectedAll().includes(hit.object)) inspect(hit);
          startCarry(hit.object);
        } else toast('Aim at an object to grab it, or press X for new gimmicks.');
      } else if (pad.edge(PAD.B)) {
        if (selection) select(null), flash('Selection cleared');
      } else if (pad.edge(PAD.X)) {
        if (!scene.gimmicks) toast('This stage has no gimmick table.');
        else toggleCatalog(true).then(() => (catalogBox.querySelector('.stage-gimmick') || catalogBox.querySelector('input'))?.focus());
      } else if (pad.edge(PAD.Y)) {
        const c = selected() && placeBox.querySelector('input, select, button');
        if (c) c.focus();
        else toast('Select an object first (A grabs the one you aim at).');
      } else if (pad.edge(PAD.R3)) {
        const hit = aimed();
        if (hit?.object?.bounds) {
          Object.assign(cam, framed(hit.object.bounds, cam));
          dirty = true;
        } else frameSelection();
      }
      if (pad.edge(PAD.LEFT)) undo();
      else if (pad.edge(PAD.RIGHT)) redo();
      else if (pad.edge(PAD.UP)) startPlay();
      else if (pad.edge(PAD.DOWN)) toggleCollision();
      const sl = padRepeat('lb', pad.held(PAD.LB)), sr = padRepeat('rb', pad.held(PAD.RB));
      if (sl || sr) {
        flyMul = Math.round(padClamp(flyMul + (sr ? 0.1 : -0.1), 0.1, 5) * 10) / 10;
        const t = `Fly speed ${flyMul.toFixed(1)}×`;
        if (pad.edge(PAD.LB) || pad.edge(PAD.RB)) toast(t);
        flash(t);
      }
    }
    // ----- play test (StageViewerForm.Play.cs, part 1; F5 / D-pad up) -----
    // Walks the map as a stand-in player against its collision as it is now: the stage's (the character layer when
    // there is one) lifted with the terraforming, moved objects' collision where they are, Solid objects, the collision
    // editor's pieces, the gimmick table's extra collision and the gimmicks' own models.
    const PLAY_HINT = 'Play test · WASD: walk · Shift: run · Space: jump · E: use · Drag: look around · Wheel: camera distance · H / P: collision / nav lines · Esc or F5: stop';
    const PLAY_PAD_HINT = 'Play test · Left stick: walk · RB or L3: run · A: jump · X: use · Right stick: look around · B, Menu, View or D-pad up: stop';
    // With the warrior: the game's buttons. Guard is Shift here, not the desktop's Ctrl: Ctrl+W would close the tab.
    const AVATAR_HINT = 'Play test · WASD: walk · Space: attack · Q: strong attack · Shift: guard · E: use · Drag: look around · Wheel: camera distance · H / P: collision / nav lines · Esc or F5: stop';
    const AVATAR_PAD_HINT = 'Play test · Left stick: walk · X: attack · Y: strong attack · LB or LT: guard · A: use · Right stick: look around · B, Menu, View or D-pad up: stop';
    const playPitch = (p) => Math.max(-1.45, Math.min(0.9, p));
    /** The triangles the player collides with (BuildPlayWorld). */
    function buildPlayWorld() {
      const w = new PlayWorld(), layers = colRead?.layers ?? [];
      const chit = layers.some((l) => isCharacterLayer(l.name)), use = (l) => !chit || isCharacterLayer(l.name);
      if (colRead?.live) {
        const m = matchDone(), flags = erasedFlags(), sc = edit.sculpt, owned = new Map();
        const lift = (x, z) => (sc ? sc.at(x, z) : 0);
        // An object the sculpt lifts whole (SculptLiftFor) counts as moved, as on the desktop (_objHasXform): its
        // collision leaves the ground pass and goes in below, placed and lifted like the object.
        const lifts = new Map();
        const liftOf = (o) => {
          let v = lifts.get(o);
          if (v === undefined) lifts.set(o, (v = sc && !(edit.tfGround?.has(o) && isIdentityTransform(o.state)) ? liftFor(o, sc) : 0));
          return v;
        };
        const apart = (o) => o.state.hidden || !isIdentityTransform(o.state) || liftOf(o) !== 0;
        layers.forEach((l, li) => {
          if (!use(l)) return;
          const P = l.positions, I = l.indices, own = m?.owners[li], f = flags[li];
          for (let t = 0; t * 3 + 2 < I.length; t++) {
            if (f && f[t]) continue; // erased by hand
            const o = own ? own[t] : -1, a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
            if (o >= 0) {
              let list = owned.get(o);
              if (!list) owned.set(o, (list = []));
              list.push(P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]);
              if (apart(edit.objects[o])) continue; // placed with its object below
            }
            w.add(P[a], P[a + 1] + lift(P[a], P[a + 2]), P[a + 2], P[b], P[b + 1] + lift(P[b], P[b + 2]), P[b + 2], P[c], P[c + 1] + lift(P[c], P[c + 2]), P[c + 2], o);
          }
        });
        for (const o of edit.objects) {
          const st = o.state, tris = owned.get(o.index), up = st.hidden ? 0 : liftOf(o);
          const moved = !!tris && (up !== 0 || !isIdentityTransform(st));
          if (st.hidden || o.gimmick || !(moved || st.solid)) continue;
          const at = placer(st, o.pivot), place = up ? (out, i, x, y, z) => (at(out, i, x, y, z), (out[i + 1] += up)) : at;
          if (moved) w.addFlat(tris, o.index, place);
          if (st.solid) w.addFlat(solidOf(o), o.index, place);
        }
      } else
        for (const l of layers) {
          const P = l.positions, I = l.indices;
          if (!use(l) || !P || !I) continue;
          for (let t = 0; t + 2 < I.length; t += 3) {
            const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
            w.add(P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2], -1);
          }
        }
      for (const v of edit.colnav.Volumes) w.addFlat(volumeTriangles(v), -1);
      for (const v of zoneVolumes) if (!zoneGone(v)) w.addFlat(stageVolumeTriangles(v, zoneFrame(v)), -1);
      for (const o of edit.objects) {
        if (!o.gimmick || o.state.hidden || !(o.triCount >= 1)) continue;
        const P = o.mesh.positions, T = o.triangles;
        for (let t = 0; t < o.triCount; t++) {
          const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
          w.add(P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2], o.index);
        }
      }
      return w.finish();
    }
    /** What the player stands on, for the HUD. */
    const playDescribe = (i) => {
      const o = edit.objects[i];
      if (!o) return 'stage ground';
      return `standing on ${o.label || o.name}${o.state.solid && !o.gimmick ? ' (Solid)' : ''}`;
    };
    /** The warrior for this stage's Data folder (Avatar()), loading it the first time; null when it can't be read. */
    function avatarJob() {
      const parts = (ctx.filePath ?? '').split('/');
      if (!ctx.dataFiles || parts.length < 2 || parts.at(-2).toLowerCase() !== 'stage') return null;
      const key = parts.slice(0, -2).join('/').toLowerCase();
      let job = avatarJobs.get(key);
      if (!job) {
        job = { done: false, avatar: null, note: '' };
        job.promise = loadAvatar(ctx.dataFiles)
          .then((r) => ((job.avatar = r.avatar ?? null), (job.note = r.note ?? '')), (e) => (job.note = String(e?.message ?? e)))
          .finally(() => {
            job.done = true;
            console.info('play avatar: ' + (job.avatar ? 'warrior loaded' : 'not loaded') + (job.note ? ' — ' + job.note : ''));
          });
        avatarJobs.set(key, job);
      }
      return job;
    }
    /** Starts playing where the view looks at the ground (StartPlay). */
    function startPlay() {
      if (play || gdrag || avatarWait) return;
      if (!colRead) return flash('Reading the collision… try again in a moment');
      const job = avatarJob();
      if (job && !job.done) {
        avatarWait = true;
        flash('Loading the warrior…');
        job.promise.then(() => {
          avatarWait = false;
          if (!stopped && canvas.isConnected) startPlay();
        });
        return;
      }
      if (carry) dropCarry();
      if (cnMode) setCnMode(0);
      terraformOff();
      effectToolOff();
      const w = buildPlayWorld();
      if (!w.count) return flash('Play needs collision — this stage has none the editor can read');
      // Where the view points, else straight down from the eye. The desktop looks 60000 ahead; the web's opening view
      // frames the whole map from further away than that, so it looks at least twice the camera's distance.
      const { f, eye } = basis(), reach = Math.max(60000, cam.dist * 2);
      let d = f, h = w.raycast(eye, d, reach);
      if (!h) (d = [0, -1, 0]), (h = w.raycast(eye, d, reach));
      if (!h) return flash('Point the view at the ground to start playing there');
      const spawn = [eye[0] + d[0] * h.t, eye[1] + d[1] * h.t + 5, eye[2] + d[2] * h.t];
      const avatar = job?.avatar ?? null;
      play = { world: w, p: newPlayer(spawn, Math.atan2(f[0], f[2])), avatar, camDist: PLAY.camDist, shadow: null, move: [0, 0], run: false, jump: false, attack: false, blow: false, guard: false };
      if (avatar) startAvatar(avatar, play.p);
      // Using gimmicks (GimmickPlay): E / the pad's use button plays a gimmick's clip; an open gate's collision is left out.
      play.gim = gimmickUse({
        gimmicks: () => gimmickObjects,
        live: livePlacement,
        zonesOf: (type) => trapZones?.get(type) ?? [],
        pose: (o, deltaOf) => {
          writePosed(o, deltaOf, tfHook);
          upload(o);
        },
        rest: (o) => apply(o, o.state),
      });
      w.off = play.gim.off;
      if (cam.pitch > -0.05) cam.pitch = -0.3;
      cam.pitch = playPitch(cam.pitch);
      keys.clear();
      drag = null;
      playCam();
      canvas.style.cursor = '';
      flash(`Play mode — ${w.count.toLocaleString()} collision triangles` + (avatar ? ' · Space / X attack, Q / Y strong attack, Shift / LB guard, E / A use' : ''));
      setPadHint();
      dirty = true;
    }
    function stopPlay() {
      if (!play) return;
      play.gim.end();
      play = null;
      keys.clear();
      drag = null;
      flash('Play stopped — back to editing');
      hint.textContent = baseHint;
      setPadHint();
      dirty = true;
    }
    function playOff() {
      if (play) stopPlay();
    }
    function togglePlay() {
      if (play) stopPlay();
      else startPlay();
    }
    /** The camera behind the player and the shadow under it. */
    function playCam() {
      const c = playCamera(play.world, play.p, basis().f, play.camDist, play.avatar ? play.avatar.height + 15 : undefined);
      play.camDist = c.camDist;
      cam.target = c.target;
      cam.dist = c.dist;
      play.shadow = shadowPoint(play.world, play.p);
    }
    /** One frame of play: the keys and the controller's stick move the player, then the camera follows. */
    function playTick(dt) {
      dt = Math.min(dt, 0.05);
      const mv = [play.move[0], play.move[1]];
      if (keys.has('w') || keys.has('arrowup')) mv[1] += 1;
      if (keys.has('s') || keys.has('arrowdown')) mv[1] -= 1;
      if (keys.has('d') || keys.has('arrowright')) mv[0] += 1;
      if (keys.has('a') || keys.has('arrowleft')) mv[0] -= 1;
      const l = Math.hypot(mv[0], mv[1]);
      if (l > 1) (mv[0] /= l), (mv[1] /= l);
      const used = play.gim.tick(dt, keys.has('e') || !!play.use, play.p.pos);
      if (used) flash(used);
      const msg = play.avatar
        ? avatarStep(play.world, play.avatar, play.p, dt, mv, keys.has(' ') || play.attack, keys.has('q') || play.blow, keys.has('shift') || play.guard, basis().f, cam.yaw)
        : playStep(play.world, play.p, dt, mv, keys.has('shift') || play.run, keys.has(' ') || play.jump, basis().f, cam.yaw);
      if (msg) flash(msg);
      playCam();
      dirty = true;
    }
    /** The keyboard while playing: Esc or F5 stops, H and P show the collision and the nav, the rest moves. */
    function playKey(e, k) {
      if (k === 'escape' || k === 'f5') {
        e.preventDefault();
        return stopPlay();
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (k === 'h') return toggleCollision();
      if (k === 'p') return toggleNav();
      if (['w', 'a', 's', 'd', 'shift', ' ', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        keys.add(k);
        e.preventDefault();
      }
    }
    /** The controller while playing. */
    function padPlay(pad) {
      if (pad.edge(PAD.B) || pad.edge(PAD.MENU) || pad.edge(PAD.VIEW) || pad.edge(PAD.UP)) return stopPlay();
      cam.yaw += pad.rx * 2.6 * pad.dt;
      cam.pitch = playPitch(cam.pitch + pad.ry * 2.6 * pad.dt);
      play.move = [pad.lx, pad.ly];
      play.run = pad.held(PAD.RB) || pad.held(PAD.L3);
      if (play.avatar) {
        // As in the game: X attack, Y strong attack, LB / LT guard.
        play.attack = pad.held(PAD.X);
        play.blow = pad.held(PAD.Y);
        play.guard = pad.held(PAD.LB) || pad.lt > 64 / 255;
        play.use = pad.held(PAD.A);
      } else {
        play.jump = pad.held(PAD.A);
        play.use = pad.held(PAD.X); // X: use a gimmick
      }
    }
    /** The HUD box in the top-left corner (DrawPlayHud). */
    function drawPlayHud(g2) {
      const t = hudText(play.world, play.p, playDescribe) + (play.avatar ? avatarHud(play.avatar, play.p) : '');
      g2.font = '12px ui-monospace, Consolas, monospace';
      const w = g2.measureText(t).width + 16;
      g2.fillStyle = 'rgba(0, 0, 0, 0.55)';
      g2.fillRect(8, 8, w, 24);
      g2.fillStyle = '#fff';
      g2.textBaseline = 'middle';
      g2.fillText(t, 16, 20);
    }

    if (!stopped)
      releasePad = takePad((pad) => {
        if (stopped || !canvas.isConnected || document.querySelector('dialog[open]')) return false;
        const a = document.activeElement;
        if (a && a !== canvas && a !== document.body) {
          if (carry) dropCarry();
          // B in the map's side panels: Esc there first (closes the catalogue), else back to the map.
          if (pad.edge(PAD.B) && view.contains(a)) {
            if (a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))) canvas.focus({ preventScroll: true });
            return true;
          }
          return false;
        }
        if (pad.buttons || pad.lx || pad.ly || pad.rx || pad.ry || pad.lt || pad.rt) padUsed = true;
        if (play) {
          padPlay(pad);
          setPadHint();
          return true;
        }
        if (pad.edge(PAD.MENU)) openMenu();
        else if (pad.edge(PAD.VIEW)) padHelp();
        else if (carry) padCarry(pad);
        else padFree(pad);
        setPadHint();
        return true;
      });
    // Keyboard or mouse on the map: the hint goes back to the keys, and a carried object is put down first
    // (Ctrl+Z / Ctrl+Y put it back instead, then undo or redo as usual).
    canvas.addEventListener(
      'keydown',
      (e) => {
        padUsed = false;
        if (carry) {
          const k = e.key.toLowerCase();
          if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) cancelCarry();
          else dropCarry();
        }
        setPadHint();
      },
      true,
    );
    canvas.addEventListener(
      'pointerdown',
      () => {
        padUsed = false;
        dropCarry();
        setPadHint();
      },
      true,
    );

    // ----- the grid (StageViewerForm.Grid.cs): U shows it, Shift+U snaps, Ctrl+U finer, Ctrl+Shift+U coarser -----
    function gridChanged() {
      saveGrid(grid);
      dirty = overlayDirty = true;
      if (carry) carry.sig = '';
      menu?.refresh();
    }
    function gridKey(ctrl, shift) {
      if (ctrl) {
        grid.size = stepSize(grid, shift ? 1 : -1);
        toast(`Grid ${sizeText(grid.size)}`);
      } else if (shift) {
        grid.snap = !grid.snap;
        toast(grid.snap ? `Snapping to the grid (${sizeText(grid.size)}) — hold Ctrl to move freely` : 'Snapping off — hold Ctrl to snap');
      } else {
        grid.show = (grid.show + 1) % GRID_SHOW.length;
        toast(`Grid: ${GRID_SHOW[grid.show]}`);
      }
      gridChanged();
    }

    // ----- terraforming (Edit/StageTerraform.cs, F2): raise, lower, smooth, flatten and restore the ground with a brush -----
    const TF_REACH = 80000; // how far away the brush still finds the ground (AimGround)
    const tfM = (u) => String(Math.round(u / 10) / 10);
    const tfStatus = () => `${BRUSH_TOOLS[tfTool]}  ·  ${tfM(tfRadius)} m  ·  ${tfStrength.toFixed(2)}×`;
    const tfChangedGround = () => (edit.sculpt ? !edit.sculpt.isEmpty : !!edit.sculptFile);
    const tfHint = () =>
      padUsed
        ? `Terraform · A: ${tfTool === RAISE ? 'raise · X: lower' : BRUSH_TOOLS[tfTool].toLowerCase()} · R3: brush · LB/RB: size · D-pad up/down: strength · D-pad left/right: undo/redo · Y: options · B: done`
        : `Terraform · ${tfTool === RAISE ? 'Drag: raise · Ctrl+drag: lower' : `Drag: ${BRUSH_TOOLS[tfTool].toLowerCase()}`} · 1-4: brush · Wheel or [ ]: size · Ctrl+wheel or - +: strength · Right-drag: orbit · Middle-drag: pan · O: options · F2/Esc: done · Ctrl+Z/Y: undo/redo`;
    /** The grid over the ground and the ground's height under it (EnsureSculpt); false when the stage has no ground. */
    function tfEnsure() {
      edit.tfGround ??= groundPieces(edit.objects);
      if (!edit.tfGround.size) return false;
      if (!edit.sculpt) {
        edit.sculpt = coverGround(edit.tfGround);
        edit.tfHeights = null;
        if (!edit.sculpt) return false;
      }
      if (!edit.tfHeights) {
        const t0 = performance.now();
        edit.tfHeights = groundHeights(edit.sculpt, edit.tfGround);
        const g = edit.sculpt;
        console.info(`Map editor: terraforming: ${edit.tfGround.size} ground pieces, a ${g.width} × ${g.depth} grid every ${tfM(g.cell)} m (${Math.round(performance.now() - t0)} ms)`);
      }
      return true;
    }
    function setTerraform(on) {
      if (on === tfOn) return;
      if (on) playOff();
      if (on) {
        if (edit.sculptJob && !edit.sculpt && !edit.sculptBroken) {
          flash('Reading the terraforming kept for this stage…');
          edit.sculptJob.then(() => !stopped && !tfOn && setTerraform(true));
          return;
        }
        if (carry) dropCarry();
        if (cnMode) setCnMode(0);
        effectToolOff();
        if (!tfEnsure()) return flash('This stage has no ground pieces to terraform');
        if (gdrag) cancelDrag();
        select(null);
        tfOn = true;
        tfReaim = true;
        canvas.style.cursor = 'crosshair';
        flash(`Terraforming — ${BRUSH_TOOLS[tfTool]}`);
      } else {
        tfEnd();
        tfOn = false;
        tfAim = null;
        canvas.style.cursor = '';
        hint.textContent = baseHint;
        flash('Terraforming off');
      }
      edit.history.breakMerge();
      setPadHint();
      renderTerraform();
      if (menu?.isOpen) menu.refresh();
      dirty = overlayDirty = true;
    }
    terraformOff = () => setTerraform(false);
    /** Where the brush is: the ground under the pointer (or the middle of the view on the controller). */
    function tfAimNow() {
      const p = tfPoint || { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
      const { o, d } = rayAt(p.x, p.y);
      const hit = pick(scene, o, d);
      return hit && hit.dist <= TF_REACH ? hit.point : null;
    }
    function tfPointerMove(p, ctrl) {
      tfPoint = p;
      tfReaim = true;
      if (ctrl !== tfCtrl) (tfCtrl = ctrl), (overlayDirty = true);
    }
    /** Each frame: aims again when the pointer or the view moved (every frame while stroking), and brushes. */
    function tfFrame(dt) {
      const sig = `${cam.yaw},${cam.pitch},${cam.dist},${cam.target.join(',')}`;
      if (sig !== tfCamSig) (tfCamSig = sig), (tfReaim = true);
      if (tfStroke || tfReaim) {
        tfReaim = false;
        const at = tfAimNow();
        if (at || !tfStroke) tfAim = at;
        overlayDirty = true;
      }
      if (tfStroke && tfAim) tfApply(dt);
    }
    function tfApply(dt) {
      const s = tfStroke, g = edit.sculpt;
      const rg = brushStep(g, edit.tfHeights, s.tool, s.dir, tfAim, tfRadius, tfStrength, dt, s.flattenTo);
      if (!rg) return;
      s.rg = s.rg ? { ax: Math.min(s.rg.ax, rg.ax), bx: Math.max(s.rg.bx, rg.bx), az: Math.min(s.rg.az, rg.az), bz: Math.max(s.rg.bz, rg.bz) } : rg;
      tfRefresh(g.box(rg));
    }
    /** Writes again the objects over a world box (RefreshSculpted): the ground pieces and what rides on them. */
    function tfRefresh([x0, z0, x1, z1]) {
      for (const o of edit.objects) {
        if (o.state.hidden) continue;
        const b = o.bounds ?? stockBounds(o);
        if (!b || b.max[0] < x0 || b.min[0] > x1 || b.max[2] < z0 || b.min[2] > z1) continue;
        apply(o, o.state);
      }
    }
    function tfRefreshAll() {
      for (const o of edit.objects) if (!o.state.hidden) apply(o, o.state);
    }
    /** BeginStroke: a press on the ground starts one undo step; flatten levels to the height pressed on. */
    function tfBegin(p, dir, pad = null) {
      tfEnd();
      if (p) tfPoint = p;
      tfAim = tfAimNow();
      overlayDirty = true;
      if (!tfAim) return flash('Point at the ground to terraform it');
      tfStroke = { tool: tfTool, dir: tfTool === RAISE ? dir : 1, before: edit.sculpt.delta.slice(), rg: null, flattenTo: tfAim[1], pad };
    }
    /** EndStroke: the points the stroke changed, before and after, as one undo step. */
    function tfEnd() {
      const s = tfStroke;
      tfStroke = null;
      if (!s?.rg) return;
      const g = edit.sculpt, rg = s.rg;
      const before = g.copy(rg, s.before), after = g.copy(rg);
      if (before.every((v, i) => v === after[i])) return;
      const box = g.box(rg);
      const put = (v) => {
        g.paste(rg, v);
        if (edit.sculpt === g) tfRefresh(box), tfSave(), renderTerraform();
      };
      const label = s.tool === RAISE ? (s.dir < 0 ? 'Lower ground' : 'Raise ground') : ['', 'Smooth ground', 'Flatten ground', 'Restore ground'][s.tool];
      edit.history.push([], label, null, { undo: () => put(before), redo: () => put(after) });
      edit.history.breakMerge();
      tfSave();
      edited();
      renderTerraform();
    }
    /** Keeps the grid with the edits in this browser (as the edits file's Sculpt), the newest one winning. */
    function tfSave() {
      const seq = ++tfSaveSeq;
      encodeSculpt(edit.sculpt).then(
        (e) => {
          if (seq !== tfSaveSeq) return;
          edit.sculptFile = e;
          saveSoon();
          if (!stopped) renderTerraform();
        },
        (e) => console.warn(`Map editor: the terraforming could not be kept: ${e.message}`),
      );
    }
    /** Puts in a whole grid (an edits file's, or back as it was): every object is written again. */
    function setSculpt({ sculpt, heights }) {
      tfStroke = null;
      edit.sculpt = sculpt;
      edit.tfHeights = heights;
      edit.sculptBroken = false;
      if (!sculpt && tfOn) setTerraform(false);
      tfRefreshAll();
      tfSave();
      renderTerraform();
    }
    function tfClear() {
      tfEnd();
      const g = edit.sculpt;
      if (!g || g.isEmpty) return flash('Nothing is terraformed');
      const before = g.delta.slice(), after = new Float32Array(before.length);
      const put = (v) => {
        g.delta.set(v);
        if (edit.sculpt === g) tfRefreshAll(), tfSave(), renderTerraform();
      };
      put(after);
      edit.history.push([], 'Clear terraforming', null, { undo: () => put(before), redo: () => put(after) });
      edit.history.breakMerge();
      edited();
      flash('Terraforming cleared');
    }
    function tfChanged(msg) {
      flash(msg ?? tfStatus());
      setPadHint();
      renderTerraform();
      if (menu?.isOpen) menu.refresh();
      overlayDirty = true;
    }
    function tfSetTool(t) {
      tfEnd();
      tfTool = ((t % BRUSH_TOOLS.length) + BRUSH_TOOLS.length) % BRUSH_TOOLS.length;
      tfChanged();
    }
    const tfSetRadius = (r) => {
      tfRadius = Math.max(MIN_BRUSH, Math.min(MAX_BRUSH, Math.round(r)));
      tfChanged();
    };
    const tfSetStrength = (v) => {
      tfStrength = Math.max(MIN_STRENGTH, Math.min(MAX_STRENGTH, Math.round(v * 100) / 100));
      tfChanged();
    };
    const tfSize = (n) => tfSetRadius(tfRadius * 1.15 ** n);
    const tfStrengthStep = (n) => tfSetStrength(tfStrength + n * 0.25);
    /** The wheel sizes the brush; with Ctrl it sets the strength. */
    function tfWheel(e) {
      const n = -e.deltaY / (e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 1 : 100);
      const steps = Math.sign(n) * Math.max(1, Math.round(Math.abs(n)));
      if (!steps) return;
      if (e.ctrlKey || e.metaKey) tfStrengthStep(steps);
      else tfSize(steps);
    }
    /** Terraforming's keys; true when the key was one of them. */
    function tfKey(k) {
      if (k === 'escape') return setTerraform(false), true;
      if (k.length === 1 && k >= '1' && k <= '4') return tfSetTool(Number(k) - 1), true;
      if (k === '[' || k === ']') return tfSize(k === ']' ? 1 : -1), true;
      if (k === '-' || k === '_') return tfStrengthStep(-1), true;
      if (k === '=' || k === '+') return tfStrengthStep(1), true;
      if (k === 'o') return tfEnd(), menu?.open(tfPage), true;
      return k === 'delete' || k === 'home'; // nothing is selected to delete or put back
    }
    /** The controller while terraforming: the brush is in the middle of the view. */
    function padTerraform(pad) {
      if (padUsed) tfPoint = null;
      if (tfStroke?.pad) {
        if (!pad.held(tfStroke.pad)) tfEnd();
      } else if (pad.edge(PAD.A)) tfBegin(null, 1, PAD.A);
      else if (pad.edge(PAD.X) && tfTool === RAISE) tfBegin(null, -1, PAD.X);
      if (pad.edge(PAD.B)) return setTerraform(false);
      if (pad.edge(PAD.Y)) return tfEnd(), menu?.open(tfPage);
      if (pad.edge(PAD.R3)) tfSetTool(tfTool + 1);
      if (padRepeat('tf-lb', pad.held(PAD.LB))) tfSize(-1);
      if (padRepeat('tf-rb', pad.held(PAD.RB))) tfSize(1);
      if (padRepeat('tf-up', pad.held(PAD.UP))) tfStrengthStep(1);
      if (padRepeat('tf-down', pad.held(PAD.DOWN))) tfStrengthStep(-1);
      if (pad.edge(PAD.LEFT)) tfEnd(), undo();
      else if (pad.edge(PAD.RIGHT)) tfEnd(), redo();
    }
    /** The brush (DrawBrush): rings at its size and half of it over the ground, and an arrow up or down. */
    function drawTfOverlay(g2) {
      if (!tfAim || menu?.isOpen) return;
      const lowering = tfTool === RAISE && (tfStroke ? tfStroke.dir < 0 : tfCtrl);
      const c = BRUSH_COLOURS[tfTool === RAISE ? (lowering ? 'lower' : 'raise') : tfTool];
      const [x, y, z] = tfAim, g = edit.sculpt, h = edit.tfHeights;
      const colour = (k) => `rgb(${Math.round(c[0] * k)} ${Math.round(c[1] * k)} ${Math.round(c[2] * k)} / 0.95)`;
      g2.save();
      const ring = (r, width, k) => {
        g2.strokeStyle = colour(k);
        g2.lineWidth = width;
        g2.beginPath();
        let open = false;
        for (let i = 0; i <= 64; i++) {
          const a = (i / 64) * 2 * Math.PI, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
          const p = project([px, brushGroundY(g, h, px, pz, y) + 8, pz]);
          if (!p) {
            open = false;
            continue;
          }
          if (open) g2.lineTo(p.x, p.y);
          else g2.moveTo(p.x, p.y);
          open = true;
        }
        g2.stroke();
      };
      ring(tfRadius, 2.5, 1);
      ring(tfRadius / 2, 1.2, 0.75);
      const len = Math.max(120, tfRadius * 0.25), a = project([x, y, z]), b = project([x, y + (lowering ? -len : len), z]);
      if (a && b) {
        g2.strokeStyle = colour(1);
        g2.lineWidth = 2;
        g2.beginPath();
        g2.moveTo(a.x, a.y);
        g2.lineTo(b.x, b.y);
        g2.stroke();
      }
      g2.restore();
    }
    // Ctrl held shows the brush lowering before the press.
    const tfCtrlKey = (e) => {
      if (e.key !== 'Control' && e.key !== 'Meta') return;
      const on = e.type === 'keydown';
      if (on !== tfCtrl) (tfCtrl = on), (overlayDirty = true);
    };
    canvas.addEventListener('keydown', tfCtrlKey);
    canvas.addEventListener('keyup', tfCtrlKey);
    canvas.addEventListener('blur', () => (tfCtrl = false));
    // The side panel.
    const tfLine = el('p', { class: 'muted' });
    const tfToolSel = el('select', { class: 'input input-sm', 'aria-label': 'Brush' }, ...BRUSH_TOOLS.map((n, i) => el('option', { value: String(i) }, n)));
    tfToolSel.addEventListener('change', () => tfSetTool(Number(tfToolSel.value)));
    const tfSizeIn = el('input', { type: 'number', class: 'input input-sm', min: String(MIN_BRUSH / 100), max: String(MAX_BRUSH / 100), step: '0.5', 'aria-label': 'Brush size, in metres' });
    tfSizeIn.addEventListener('change', () => Number(tfSizeIn.value) > 0 && tfSetRadius(Number(tfSizeIn.value) * 100));
    const tfStrIn = el('input', { type: 'number', class: 'input input-sm', min: String(MIN_STRENGTH), max: String(MAX_STRENGTH), step: '0.25', 'aria-label': 'Brush strength' });
    tfStrIn.addEventListener('change', () => Number(tfStrIn.value) > 0 && tfSetStrength(Number(tfStrIn.value)));
    const tfOnBtn = button('Terraform', () => setTerraform(!tfOn), { title: 'F2' });
    const tfClearBtn = button('Clear all', () => tfClear(), { title: "Every change back to the stage's own ground (undo brings it back)" });
    const tfNote = el('p', { class: 'muted' }, 'Kept with the edits (Save edits… writes it, as the desktop HappyTool reads it). Download bundle writes it into the stage: the ground reshaped, what stands on it dropped with it, and its collision and bot navigation following.');
    function renderTerraform() {
      const ground = (edit.tfGround ??= groundPieces(edit.objects));
      if (!ground.size) return terraformBox.replaceChildren(el('p', { class: 'muted' }, 'This stage has no ground pieces to terraform.'));
      const changed = tfChangedGround();
      tfLine.textContent = `${plural(ground.size, 'ground piece')} · ${changed ? 'Ground changed' : 'Ground as the stage has it'}${tfOn ? ' · terraforming' : ''}`;
      if (document.activeElement !== tfToolSel) tfToolSel.value = String(tfTool);
      if (document.activeElement !== tfSizeIn) tfSizeIn.value = tfM(tfRadius);
      if (document.activeElement !== tfStrIn) tfStrIn.value = tfStrength.toFixed(2);
      tfOnBtn.textContent = tfOn ? 'Stop terraforming' : 'Terraform';
      tfClearBtn.disabled = !edit.sculpt || !changed;
      if (!terraformBox.contains(tfLine))
        terraformBox.replaceChildren(
          tfLine,
          el('label', { class: 'stage-fog-row' }, 'Brush', tfToolSel),
          el('label', { class: 'stage-fog-row' }, 'Size (m)', tfSizeIn),
          el('label', { class: 'stage-fog-row' }, 'Strength', tfStrIn),
          el('div', { class: 'toolbar' }, tfOnBtn, tfClearBtn),
          tfNote,
        );
    }
    // The menu's Terraform page (the desktop's options page: O or Y while terraforming).
    const tfPage = {
      title: 'Terraform',
      status: () => `${tfStatus()}  ·  ${tfChangedGround() ? 'Ground changed' : 'Ground as the stage has it'}`,
      items: () => [
        {
          text: 'Brush',
          value: () => BRUSH_TOOLS[tfTool],
          activate: () => tfSetTool(tfTool + 1),
          adjust: (dir) => tfSetTool(tfTool + dir),
          desc: 'Raise / lower moves the ground up (or down with Ctrl or X); Smooth evens it out; Flatten levels it to where the stroke began; Restore puts it back as the stage has it.',
        },
        { text: 'Brush size', value: () => `${tfM(tfRadius)} m`, activate: () => tfSize(1), adjust: (dir) => tfSize(dir), desc: 'LB / RB or the mouse wheel.' },
        { text: 'Strength', value: () => `${tfStrength.toFixed(2)}×`, activate: () => tfStrengthStep(1), adjust: (dir) => tfStrengthStep(dir), desc: 'D-pad up / down or Ctrl + wheel.' },
        { text: 'Clear all terraforming', enabled: () => !!edit.sculpt && !edit.sculpt.isEmpty, activate: () => tfClear(), desc: "Every change back to the stage's own ground (undo brings it back)." },
        { text: tfOn ? 'Stop terraforming' : 'Start terraforming', activate: closeThen(() => setTerraform(!tfOn)), desc: 'F2 / B' },
        { text: 'Map editor menu…', activate: () => menu.push(mainPage), desc: 'The rest of the map editor.' },
      ],
    };
    // The terraforming kept in this browser: read once per stage, then shown on the map.
    if (edit.sculptFile && !edit.sculpt && !edit.sculptJob)
      edit.sculptJob = decodeSculpt(edit.sculptFile).then(
        (s) => {
          if (!s) return void (edit.sculptBroken = true);
          edit.tfGround ??= groundPieces(edit.objects);
          edit.sculpt = s;
          edit.tfHeights = groundHeights(s, edit.tfGround);
          console.info(`Map editor: terraforming kept for ${edit.stage}: a ${s.width} × ${s.depth} grid`);
        },
        (e) => {
          edit.sculptBroken = true;
          console.warn(`Map editor: the terraforming kept for ${edit.stage} can't be read: ${e.message}`);
        },
      );
    edit.sculptJob?.then(() => {
      if (stopped || edit.sculptShown || !edit.sculpt) return;
      edit.sculptShown = true;
      tfRefreshAll();
      renderTerraform();
    });
    renderTerraform();

    // ----- the menu (GUI/Forge/ForgeMenu.cs): controller Menu, F10, or Esc with nothing selected -----
    menu = forgeMenu(host, { onClose: () => !stopped && canvas.focus({ preventScroll: true }) });
    const onOff = (v) => (v ? 'on' : 'off');
    const closeThen = (fn) => () => {
      menu.close();
      fn();
    };
    function openMenu() {
      if (cnMode) return toast('Leave the collision & nav editor first (F3).');
      if (carry) dropCarry();
      tfEnd();
      menu?.open(tfOn ? tfPage : mainPage);
    }
    const mainPage = {
      title: 'Map editor',
      status: () => {
        const n = selectedAll().length;
        return `${n ? `${n} selected` : 'Nothing selected'} · ${gridSummary(grid)}`;
      },
      items: () => [
        { text: 'Resume', desc: 'Back to the map (Menu, B or Esc)', activate: () => menu.close() },
        { header: true, text: 'Edit' },
        { text: 'Undo', value: () => edit.history.undo.at(-1)?.label || '', enabled: () => edit.history.undo.length > 0, activate: undo, desc: 'Ctrl+Z · D-pad left on the map' },
        { text: 'Redo', value: () => edit.history.redo.at(-1)?.label || '', enabled: () => edit.history.redo.length > 0, activate: redo, desc: 'Ctrl+Y · D-pad right on the map' },
        { text: 'Link the selection', value: () => (selectedAll().length > 1 ? `${selectedAll().length} objects` : ''), enabled: () => selectedAll().length > 1, activate: linkSelection, desc: 'Makes the selected objects one object that is selected, moved and carried together (Ctrl+G); saved with the edits' },
        { text: 'Unlink', enabled: () => selectedAll().some((x) => linkOf.has(x)), activate: unlinkSelection, desc: 'Each linked piece in the selection is its own object again (Ctrl+Shift+G)' },
        { text: 'Clear the selection', enabled: () => !!selection, activate: () => select(null), desc: 'Esc · B on the map. Ctrl+click adds or takes out an object, Ctrl+drag a box of them' },
        scene.gimmicks
          ? { text: 'Add gimmicks…', activate: closeThen(() => toggleCatalog(true).then(() => (catalogBox.querySelector('.stage-gimmick') || catalogBox.querySelector('input'))?.focus())), desc: "The stage's gimmick catalogue (X on the map)" }
          : null,
        { text: 'Placement panel', enabled: () => !!selected(), activate: closeThen(() => placeBox.querySelector('input, select, button')?.focus()), desc: 'Offset, turn, size, Hidden and Solid of the selected object (Y on the map)' },
        { text: 'Save edits…', activate: closeThen(saveFile), desc: 'Downloads the edits file the desktop HappyTool reads too' },
        { text: 'Load edits…', activate: closeThen(loadFile), desc: 'Applies an edits file saved here or by the desktop HappyTool' },
        { header: true, text: 'View' },
        { text: 'Grid and snapping…', value: () => gridSummary(grid), activate: () => menu.push(gridPage), desc: 'The floor grid, its size and height, and snapping to it (U)' },
        { text: 'Collision lines', value: () => onOff(colBox.checked), enabled: () => !colBox.disabled, activate: toggleCollision, desc: 'H · D-pad down on the map' },
        { text: 'Nav lines', value: () => onOff(navBox.checked), enabled: () => !navBox.disabled, activate: toggleNav, desc: 'P' },
        gptPaths.length
          ? { text: 'Gimmick paths', value: () => onOff(gptBox.checked), activate: toggleGpt, desc: "The routes moving gimmicks follow (Rainbow's rafts …). A raft path's ends follow their harbours when you move them; the bundle download writes the moved paths" }
          : null,
        { text: 'Collision & nav editor', activate: closeThen(() => setCnMode(colRead?.live ? 1 : 2)), desc: 'Erase or add collision, paint nav, edit waypoints (F3)' },
        { text: tfOn ? 'Stop terraforming' : 'Terraform', activate: closeThen(() => setTerraform(!tfOn)), desc: 'Raise, lower, smooth and flatten the ground with a brush (F2)' },
        { text: play ? 'Stop the play test' : 'Play test', activate: closeThen(togglePlay), desc: 'Walk the map as a player to try its collision (F5 / D-pad up)' },
        fxTable
          ? { text: 'Effects and sounds', value: () => onOff(fxShow.on), activate: toggleEffects, desc: 'Where the stage plays its particle effects and sounds (J)' }
          : null,
        fxTable
          ? { text: 'Move effects and sounds', activate: closeThen(() => setEffectTool(true)), desc: 'Drag one on its level, the wheel raises or lowers it; Download effect table writes them (Shift+J)' }
          : null,
        edit.minimapStock?.rgba
          ? { text: 'Minimap…', value: () => MINIMAP_MODES[edit.minimap.Mode], activate: () => menu.push(minimapPage), desc: 'The stage\'s own, redrawn from above where you changed the map, redrawn whole, or a picture of your own; the bundle download writes it' }
          : null,
        {
          text: 'Textures',
          value: () => onOff(texBox.checked),
          activate: () => {
            texBox.checked = !texBox.checked;
            dirty = true;
          },
        },
        {
          text: 'Lightmap',
          value: () => lmSelect.selectedOptions[0]?.textContent || '',
          adjust: (dir) => {
            const n = lmSelect.options.length;
            lmSelect.selectedIndex = (lmSelect.selectedIndex + dir + n) % n;
            lmSelect.dispatchEvent(new Event('change'));
          },
        },
        { text: 'Fly speed', value: () => `${flyMul.toFixed(1)}×`, adjust: (dir) => (flyMul = Math.round(padClamp(flyMul + dir * 0.1, 0.1, 5) * 10) / 10), desc: 'LB / RB on the map' },
        { text: 'Fit the map in view', activate: closeThen(() => resetBtn.click()), desc: 'R' },
        { text: 'Frame the selection', enabled: () => !!selection, activate: closeThen(frameSelection), desc: 'F · R3 on the map frames what you aim at' },
        { header: true, text: 'More' },
        { text: 'Download the map as .glb', activate: closeThen(() => exportModel('glb')), desc: 'For Blender and other 3D tools, with the edits' },
        { text: 'Controls', activate: closeThen(padHelp), desc: "The controller's buttons (View)" },
        { text: 'Find a feature…', activate: closeThen(openPalette), desc: 'Every command of the page by name (Ctrl+K)' },
      ],
    };
    const gridPage = {
      title: 'Grid and snapping',
      status: () => gridSummary(grid),
      items: () => {
        const set = (fn) => () => (fn(), gridChanged());
        const base = () => unionBounds(selectedAll());
        return [
          { text: 'Grid', value: () => GRID_SHOW[grid.show], activate: set(() => (grid.show = (grid.show + 1) % 3)), adjust: (dir) => set(() => (grid.show = (grid.show + dir + 3) % 3))(), desc: 'Off, on (the map hides it), or on top of everything (U)' },
          { text: 'Grid size', value: () => sizeText(grid.size), adjust: (dir) => set(() => (grid.size = stepSize(grid, dir)))(), desc: 'Ctrl+U finer, Ctrl+Shift+U coarser' },
          { text: 'Height', value: () => `${Math.round(grid.height) / 100} m`, adjust: (dir) => set(() => (grid.height += dir * grid.size))(), desc: 'Raises or lowers the grid one step' },
          { text: "Put it at the selection's base", enabled: () => !!base(), activate: set(() => (grid.height = Math.round(base().min[1] * 100) / 100)), desc: 'The grid goes to the bottom of the selected objects' },
          { text: "Back to the map's 0", enabled: () => grid.height !== 0, activate: set(() => (grid.height = 0)) },
          { text: 'Snapping', value: () => onOff(grid.snap), activate: set(() => (grid.snap = !grid.snap)), adjust: () => set(() => (grid.snap = !grid.snap))(), desc: 'Moves land on the grid, turns on 15°, sizes on 10% steps; holding Ctrl while dragging does the opposite (Shift+U)' },
          { text: 'Axis indicator', value: () => onOff(grid.axes), activate: set(() => (grid.axes = !grid.axes)), adjust: () => set(() => (grid.axes = !grid.axes))(), desc: 'The X / Y / Z arrows in the corner' },
        ];
      },
    };

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
        cmd(tfOn ? 'Stop terraforming' : 'Terraform', 'F2', press('F2'), 'Raise, lower, smooth and flatten the ground with a brush'),
        cmd(play ? 'Stop the play test' : 'Play test', 'F5', press('F5'), 'Walk the map as a player to try its collision'),
        cmd('Collision lines on or off', 'H', press('h')),
        cmd('Nav lines on or off', 'P', press('p')),
        cmd('Frame the selected object', 'F', press('f')),
        cmd('Menu', 'F10', openMenu, 'The map editor menu; also Esc with nothing selected, or Menu on a controller'),
        cmd('Grid: off, on, on top of everything', 'U', press('u')),
        cmd('Snapping to the grid on or off', 'Shift+U', press('U', { shiftKey: true })),
        cmd('Finer grid', 'Ctrl+U', press('u', { ctrlKey: true })),
        cmd('Coarser grid', 'Ctrl+Shift+U', press('U', { ctrlKey: true, shiftKey: true })),
        cmd('Add to the selection', 'Ctrl+click, Ctrl+drag', () => canvas.focus(), 'Ctrl+click adds or takes out one object, Ctrl+drag a box of them (Ctrl+Shift+drag takes them out)'),
        cmd('Fly the camera', 'W A S D  Q E', () => canvas.focus(), 'Click the map, then hold the keys; drag to look, wheel to zoom'),
      ];
      if (tfOn) {
        BRUSH_TOOLS.forEach((n, i) => list.push(cmd(`${n} brush`, String(i + 1), press(String(i + 1)))));
        list.push(
          cmd('Bigger or smaller brush', '] [', () => canvas.focus(), 'Or the mouse wheel'),
          cmd('Stronger or weaker brush', '+ -', () => canvas.focus(), 'Or Ctrl + the mouse wheel'),
          cmd('Terraform options', 'O', press('o')),
          cmd('Stop terraforming', 'Esc', press('Escape')),
        );
      } else if (cnMode) {
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
            cmd('Link the selection into one object', 'Ctrl+G', press('g', { ctrlKey: true })),
            cmd('Unlink the selection', 'Ctrl+Shift+G', press('G', { ctrlKey: true, shiftKey: true })),
          );
      }
      return list;
    });
  }

  return view;
}
