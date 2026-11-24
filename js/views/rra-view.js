// HappyTool's animation player (GUI/RraFileEditor.cs) for Happy Wars .rra ("anm.rra") clips, .cmf gimmick clips and
// FMC catalog blobs. Read-only: the clip played at 30 fps on the default warrior (cbod000 with cmon000, cwea000 and
// cshi000) or on the gimmick bundle's own mesh, an orbit camera, the bone tree with each track's keys, and the report.
import { el, button } from '../ui.js';
import { baseName } from '../util.js';
import { parseBres } from '../formats/bres.js';
import { decodeLayers } from '../formats/wrappers.js';
import { parseRrm } from '../formats/rrm.js';
import { decodeDds } from '../formats/dds.js';
import { skinnedModel, steamSkeleton, trs, mul4, invertRigid, transformPoint, identity4 } from '../formats/skin.js';
import { isCmf, isAnimationPayload, loadRraDocument, loadCmfDocument, parseCjf, sampleBone, rraReport } from '../formats/rra.js';
import { netFloat } from '../formats/tanda.js';

const FPS = 30;
const SPEEDS = [0.25, 0.5, 1, 1.5, 2];
const SPEED_LABELS = ['0.25×', '0.5×', '1×', '1.5×', '2×'];
const VIEWS = ['Front', 'Side', 'Top'];
const CHANNELS = ['Position', 'Rotation', 'Scale'];
const n0 = (v) => v.toLocaleString('en-US');
const pt = (n) => (n * 96) / 72 + 'px'; // GDI points at 96 dpi
/** Path.GetFileNameWithoutExtension. */
const stem = (name) => {
  const b = baseName(name ?? '');
  const d = b.lastIndexOf('.');
  return d >= 0 ? b.slice(0, d) : b;
};
const extLower = (name) => {
  const b = baseName(name ?? '');
  const d = b.lastIndexOf('.');
  return d >= 0 ? b.slice(d).toLowerCase() : '';
};

// One load per opened payload (document, joint names, meshes), kept across re-renders with the player's state.
const cache = new WeakMap();
/** The player's state for an opened payload ({promise, doc, mesh, frame, ...}), or undefined before it is opened. */
export const rraViewState = (payload) => cache.get(payload);

const list = (ctx, rel) => (ctx.folderFiles ? ctx.folderFiles(rel) : []);
const findFile = (files, name) => files.find((f) => f.name.toLowerCase() === name.toLowerCase()) ?? null;
const readBundle = async (f) => parseBres((await decodeLayers(await f.read())).payload).entries;
const isData = (e) => e && e.name && !e.pointer;

// PlayerMotionPreviewAssets.FindEntry: a data entry with this base name and extension, ignoring case.
function findEntry(entries, base, ext) {
  if (!base || !base.trim()) return -1;
  const want = base.trim().toLowerCase();
  return entries.findIndex((e) => isData(e) && extLower(e.name) === ext && stem(e.name).toLowerCase() === want);
}
const firstWith = (entries, exts) => entries.findIndex((e) => isData(e) && exts.includes(extLower(e.name)));

function tryDds(u8) {
  try {
    const t = decodeDds(u8);
    return t?.rgba ? { width: t.width, height: t.height, rgba: t.rgba } : null;
  } catch {
    return null;
  }
}

/** ResolveAnimationBundleHint: the bundle that goes with the clip (its .cjf joints and meshes), from the open file's folder. */
function bundleHint(node, ctx) {
  const here = list(ctx, '');
  const path = ctx.filePath ?? node.name;
  const self = findFile(here, baseName(path));
  if (node.parent) {
    // assetHintPath is the bundle; filePath is empty for an entry.
    if (self && extLower(self.name) !== '.bres') return findFile(here, stem(path) + '.bres') ?? self;
    return self;
  }
  if (self) {
    const sib = findFile(here, stem(path) + '.bres');
    if (sib) return sib;
    const b = stem(path).toLowerCase();
    const bres = here.filter((f) => extLower(f.name) === '.bres').sort((x, y) => (x.name.toUpperCase() < y.name.toUpperCase() ? -1 : 1));
    for (const f of bres) if (b && b.startsWith(stem(f.name).toLowerCase())) return f;
  }
  return self;
}

// TryLoadSiblingCjf.
async function siblingCjf(hint) {
  if (!hint) return { cjf: null, note: 'No sibling .cjf found (open the parent .bres for joint names).' };
  try {
    const entries = await readBundle(hint);
    if (!entries.length) return { cjf: null, note: null };
    for (const e of entries) {
      if (!e?.name || !e.name.toLowerCase().endsWith('.cjf') || e.pointer) continue;
      const cjf = parseCjf(e.data);
      if (cjf.isValid) return { cjf, note: 'Joints from ' + hint.name + ' → ' + baseName(e.name) };
    }
    return { cjf: null, note: 'No valid .cjf in ' + hint.name };
  } catch (err) {
    return { cjf: null, note: 'Could not read sibling .cjf: ' + err.message };
  }
}

// ResolveCharacterDirectory: <dir>/character or its parent's, from the clip's folder up to four levels.
function characterFolder(ctx) {
  for (let i = 0; i < 4; i++) {
    for (const rel of ['../'.repeat(i) + 'character', '../'.repeat(i + 1) + 'character']) {
      const files = list(ctx, rel);
      const head = findFile(files, 'cmon.bres');
      if (head) return { files, dir: head.path.slice(0, head.path.length - head.name.length) };
    }
  }
  return null;
}
const NO_CHARACTER = 'Character folder not found (expected Data\\character next to Data\\motion).';

// TryLoadSkinnedFromBundleFile: a skinned body (Steam skeleton) or a gimmick mesh with its own bone table.
async function loadSkinned(f, preferredBase, useSteam) {
  try {
    const entries = await readBundle(f);
    let i = -1;
    if (preferredBase) {
      i = findEntry(entries, preferredBase, '.rrm');
      if (i < 0) i = findEntry(entries, preferredBase, '.rmd');
    }
    if (i < 0) i = firstWith(entries, ['.rrm', '.rmd']);
    if (i < 0) return { note: 'No .rrm/.rmd in ' + f.name };
    const e = entries[i];
    let mesh;
    try {
      mesh = parseRrm(e.data);
    } catch (err) {
      return { note: err.message || 'Failed to parse model.' };
    }
    const rig = skinnedModel(mesh, e.data, useSteam);
    let t = findEntry(entries, stem(e.name), '.dds');
    if (t < 0) t = firstWith(entries, ['.dds']);
    const label = f.name + ' → ' + e.name;
    const body = { ...rig, texture: t >= 0 ? tryDds(entries[t].data) : null, label };
    return { body, note: (useSteam ? 'Body preview: ' : 'Gimmick mesh: ') + label };
  } catch (err) {
    return { note: 'Model load failed: ' + err.message };
  }
}

// TryLoadRigidAttach: a rigid part on a named bone, bound at a Steam skeleton bone's bind pose.
async function loadPart(cf, bundleName, base, bone, bindIndex) {
  if (!cf) return { note: NO_CHARACTER };
  const f = findFile(cf.files, bundleName);
  if (!f) return { note: 'Missing ' + cf.dir + bundleName };
  try {
    const entries = await readBundle(f);
    let r = findEntry(entries, base, '.rrm');
    if (r < 0) r = findEntry(entries, base, '.rmd');
    const t = findEntry(entries, base, '.dds');
    if (r < 0) return { note: base + '.rrm not found in ' + bundleName };
    let mesh;
    try {
      mesh = parseRrm(entries[r].data);
    } catch (err) {
      return { note: err.message || 'Failed to parse ' + base };
    }
    const label = f.name + ' → ' + entries[r].name;
    const bind = steamSkeleton().bindWorld[bindIndex] ?? identity4();
    const part = { mesh, texture: t >= 0 ? tryDds(entries[t].data) : null, label, bone, bindInverse: invertRigid(bind) };
    return { part, note: base + ' → ' + bone + ': ' + label };
  } catch (err) {
    return { note: base + ' load failed: ' + err.message };
  }
}

// MapSkeletonToRra: each mesh skeleton bone's clip bone, by name, else bone 0 (one-bone clips) or the same index.
function mapSkeleton(doc, names, fallbackCount) {
  const n = names?.length || fallbackCount;
  const map = new Array(n).fill(-1);
  const bones = doc.bones;
  if (!bones.length) return map;
  if (names) {
    for (let i = 0; i < names.length && i < n; i++) {
      const want = names[i];
      if (!want) continue;
      const lo = want.toLowerCase();
      const j = bones.findIndex((b) => (b.name ?? '').toLowerCase() === lo);
      if (j >= 0) map[i] = j;
    }
  }
  for (let i = 0; i < n; i++) if (map[i] < 0 && (bones.length === 1 ? true : i < bones.length)) map[i] = bones.length === 1 ? 0 : i;
  return map;
}

// TryAttachPlayerMeshes.
async function attachMeshes(st, hint, ctx) {
  const doc = st.doc;
  const notes = [];
  let extras = '';
  const m = { body: null, head: null, weapon: null, shield: null, skelToRra: null };
  let gimmick = false;
  if (hint) {
    try {
      gimmick = firstWith(await readBundle(hint), ['.rrm', '.rmd']) >= 0;
    } catch {
      gimmick = false;
    }
  }
  const g = gimmick ? await loadSkinned(hint, null, false) : null;
  if (g?.body) {
    m.body = g.body;
    m.skelToRra = mapSkeleton(doc, g.body.names, g.body.bindInverse.length);
    const label = g.body.label;
    extras += '  |  mesh ' + stem(label.includes('→') ? label.slice(label.lastIndexOf('→') + 1).trim() : 'gimmick');
    if (g.note) notes.push(g.note);
  } else {
    if (gimmick && g?.note) notes.push(g.note);
    const cf = characterFolder(ctx);
    let b;
    if (!cf) b = { note: NO_CHARACTER };
    else {
      const f = findFile(cf.files, 'cbod.bres');
      b = f ? await loadSkinned(f, 'cbod000', true) : { note: 'Missing ' + cf.dir + 'cbod.bres' };
    }
    if (b.body) {
      m.body = b.body;
      m.skelToRra = mapSkeleton(doc, b.body.names, b.body.bindInverse.length);
      extras += '  |  body cbod000';
    }
    if (b.note) notes.push(b.note);
    const h = await loadPart(cf, 'cmon.bres', 'cmon000', 'Head', 8);
    if (h.part) {
      m.head = h.part;
      extras += '  |  head cmon000';
      notes.push('Head preview: ' + h.part.label);
    } else if (h.note) notes.push(h.note);
    const w = await loadPart(cf, 'cwea.bres', 'cwea000', 'RightWeapon', 15);
    if (w.part) {
      m.weapon = w.part;
      extras += '  |  weap cwea000';
    }
    if (w.note) notes.push(w.note);
    const s = await loadPart(cf, 'cshi.bres', 'cshi000', 'LeftWeapon', 11);
    if (s.part) {
      m.shield = s.part;
      extras += '  |  shield cshi000';
    }
    if (s.note) notes.push(s.note);
  }
  st.mesh = m;
  st.meshNotes = notes;
  st.extras = extras;
}

async function load(st, node, ctx) {
  const data = node.payload;
  // The entry constructor gets displayName = the entry name without its extension, and LoadFile strips one more.
  const clipName = node.parent ? stem(stem(node.name)) : stem(ctx.filePath ?? node.name);
  const hint = bundleHint(node, ctx);
  if (isCmf(data)) {
    const { cjf, note } = await siblingCjf(hint);
    st.doc = loadCmfDocument(data, clipName, cjf ? cjf.boneNames : null, cjf ? cjf.parents : null);
    if (note) st.doc.notes.push(note);
  } else st.doc = loadRraDocument(data, clipName);
  const doc = st.doc;
  st.report = rraReport(doc);
  if (doc.isValid && !doc.isFmc) await attachMeshes(st, hint, ctx);
  st.playing = doc.isValid && !doc.isFmc && doc.frameCount > 1;
}

function stateFor(node, ctx) {
  let st = cache.get(node.payload);
  if (st) return st;
  st = {
    ready: false,
    error: null,
    doc: null,
    report: '',
    mesh: null,
    meshNotes: [],
    extras: '',
    frame: 0,
    playing: false,
    speed: 2,
    loop: true,
    bones: true,
    view: 0,
    yaw: 0,
    pitch: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
    selected: -1,
    channel: 1,
    tab: 'player',
    expanded: new Set([-1]),
    run: 0,
  };
  st.promise = load(st, node, ctx).then(
    () => (st.ready = true),
    (e) => {
      st.ready = true;
      st.error = e.message;
    },
  );
  cache.set(node.payload, st);
  return st;
}

// ---- pose (RebuildPreview's sampling and forward kinematics) ----

const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qrot = (q, v) => qmul(qmul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]);

/** The clip's world pose at st.frame: { n, wp, wr, parentOf }. */
export function rraPose(st) {
  const doc = st.doc;
  const n = doc.bones.length;
  const lp = new Array(n);
  const lr = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = sampleBone(doc, i, 0, st.frame);
    lp[i] = p ? [p[0], p[1], p[2]] : [0, 0, 0];
    const r = sampleBone(doc, i, 1, st.frame);
    lr[i] = r ? [r[0], r[1], r[2], r[3]] : [0, 0, 0, 1];
  }
  let fk = null;
  const body = st.mesh?.body;
  const map = st.mesh?.skelToRra;
  if (body?.parents && map) {
    fk = doc.bones.map((b) => b.parentIndex);
    for (let s = 0; s < body.parents.length && s < map.length; s++) {
      const child = map[s];
      const ps = body.parents[s];
      if (child < 0 || child >= n) continue;
      if (ps < 0 || ps >= map.length) {
        fk[child] = -1;
        continue;
      }
      const pr = map[ps];
      fk[child] = pr >= 0 && pr < n ? pr : -1;
    }
  }
  const parentOf = (i) => (fk ? fk[i] : doc.bones[i].parentIndex);
  const wp = new Array(n);
  const wr = new Array(n);
  const done = new Array(n).fill(false);
  for (let guard = 0; guard < n * 2; guard++) {
    let progress = false;
    for (let i = 0; i < n; i++) {
      if (done[i]) continue;
      const p = parentOf(i);
      if (p >= 0 && p < n && !done[p]) continue;
      if (p < 0 || p >= n) {
        wr[i] = lr[i];
        wp[i] = lp[i];
      } else {
        wr[i] = qmul(wr[p], lr[i]);
        const r = qrot(wr[p], lp[i]);
        wp[i] = [wp[p][0] + r[0], wp[p][1] + r[1], wp[p][2] + r[2]];
      }
      done[i] = true;
      progress = true;
    }
    if (!progress) break;
  }
  for (let i = 0; i < n; i++) {
    if (done[i]) continue;
    wp[i] = lp[i];
    wr[i] = lr[i];
  }
  return { n, wp, wr, parentOf };
}

const boneIndex = (doc, name) => doc.bones.findIndex((b) => (b.name ?? '').toLowerCase() === name.toLowerCase());
const anim = (p, q) => trs(p[0], p[1], p[2], q[0], q[1], q[2], q[3]);

// BuildSkeletonSkinMatrices.
function skinMatrices(st, pose) {
  const body = st.mesh.body;
  const inv = body.bindInverse;
  const map = st.mesh.skelToRra;
  return inv.map((bi, i) => {
    const r = map && i < map.length ? map[i] : -1;
    if (!(r >= 0 && r < pose.wp.length)) return identity4();
    return mul4(anim(pose.wp[r], pose.wr[r]), bi ?? inv[0]);
  });
}

// PlayerMotionPreviewAssets.SkinVertex.
function skinVertex(pos, i, indices, weights, mats) {
  const bx = pos[i * 3];
  const by = pos[i * 3 + 1];
  const bz = pos[i * 3 + 2];
  let ox = 0;
  let oy = 0;
  let oz = 0;
  let sum = 0;
  for (let s = 0; s < 4; s++) {
    const bi = indices[i * 4 + s];
    const w = weights[i * 4 + s];
    if (bi === 0xff || w <= 0 || bi >= mats.length || !mats[bi]) continue;
    const t = transformPoint(mats[bi], bx, by, bz);
    ox += t[0] * w;
    oy += t[1] * w;
    oz += t[2] * w;
    sum += w;
  }
  if (sum < 1e-5) return [bx, by, bz];
  if (Math.abs(sum - 1) > 1e-3) return [ox / sum, oy / sum, oz / sum];
  return [ox, oy, oz];
}

// The rigid parts: [part, its bone] for the head, weapon and shield that have a bone in this clip.
function rigidParts(st) {
  const doc = st.doc;
  const out = [];
  for (const key of ['weapon', 'shield', 'head']) {
    const part = st.mesh?.[key];
    if (!part?.mesh) continue;
    const bi = boneIndex(doc, part.bone);
    if (bi >= 0 && bi < doc.bones.length) out.push([key, part, bi]);
  }
  return out;
}

// ---- drawing (RebuildPreview / DrawSkinnedTriangles) ----

let glState = null;
function glRenderer() {
  if (glState !== null) return glState || null;
  glState = false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: true });
    if (!gl) return null;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(
      prog,
      sh(
        gl.VERTEX_SHADER,
        `#version 300 es
in vec2 aPos; in vec2 aUv; in vec4 aCol; uniform vec2 uSize; out vec2 vUv; out vec4 vCol;
void main() { vUv = aUv; vCol = aCol; gl_Position = vec4(aPos.x / uSize.x * 2.0 - 1.0, 1.0 - aPos.y / uSize.y * 2.0, 0.0, 1.0); }`,
      ),
    );
    gl.attachShader(
      prog,
      sh(
        gl.FRAGMENT_SHADER,
        `#version 300 es
precision mediump float;
in vec2 vUv; in vec4 vCol; uniform sampler2D uTex; uniform bool uTextured; out vec4 o;
void main() {
  if (uTextured) {
    if (vUv.x < 0.0 || vUv.x > 1.0 || vUv.y < 0.0 || vUv.y > 1.0) discard;
    vec4 t = texture(uTex, vUv);
    o = vec4(t.rgb * vCol.rgb, t.a);
  } else o = vCol;
}`,
      ),
    );
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    const buf = gl.createBuffer();
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const attr = (name, size, off) => {
      const loc = gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 32, off);
    };
    attr('aPos', 2, 0);
    attr('aUv', 2, 8);
    attr('aCol', 4, 16);
    glState = { canvas, gl, prog, vao, buf, textures: new WeakMap(), uSize: gl.getUniformLocation(prog, 'uSize'), uTex: gl.getUniformLocation(prog, 'uTex'), uTextured: gl.getUniformLocation(prog, 'uTextured') };
  } catch (e) {
    console.debug('rra preview: no WebGL2 (' + e.message + '), drawing untextured');
    glState = false;
  }
  return glState || null;
}

function glTexture(r, tex) {
  let t = r.textures.get(tex);
  if (t) return t;
  const gl = r.gl;
  t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tex.width, tex.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(tex.rgba.buffer, tex.rgba.byteOffset, tex.width * tex.height * 4));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  r.textures.set(tex, t);
  return t;
}

// The triangles of one mesh, far first: [a, b, c, z, lit] (DrawSkinnedTriangles' list and sort).
function sortedTris(mesh, sx, sy, depth, vCount) {
  const idx = mesh.indices;
  const tris = [];
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t];
    const b = idx[t + 1];
    const c = idx[t + 2];
    if (a < 0 || b < 0 || c < 0 || a >= vCount || b >= vCount || c >= vCount) continue;
    const area2 = (sx[b] - sx[a]) * (sy[c] - sy[a]) - (sy[b] - sy[a]) * (sx[c] - sx[a]);
    if (Math.abs(area2) < 1e-4) continue;
    tris.push([a, b, c, (depth[a] + depth[b] + depth[c]) / 3, 0.55 + 0.45 * Math.min(1, Math.abs(area2) / 400)]);
  }
  tris.sort((l, r) => r[3] - l[3]);
  return tris;
}

const solidShade = (lit) => Math.max(40, Math.min(255, Math.trunc(180 * lit)));

/** Draws the meshes' triangles in order (each mesh far to near) onto the 2D context. */
function drawMeshes(g, w, h, batches) {
  const r = glRenderer();
  if (!r) {
    for (const { mesh, sx, sy, tris } of batches) {
      for (const [a, b, c, , lit] of tris) {
        const s = solidShade(lit);
        g.beginPath();
        g.moveTo(sx[a], sy[a]);
        g.lineTo(sx[b], sy[b]);
        g.lineTo(sx[c], sy[c]);
        g.closePath();
        g.fillStyle = `rgba(${s}, ${Math.trunc(s * 0.85)}, ${Math.trunc(s * 0.7)}, ${220 / 255})`;
        g.fill();
        g.strokeStyle = `rgba(30, 25, 20, ${70 / 255})`;
        g.lineWidth = 0.5;
        g.stroke();
      }
      void mesh;
    }
    return;
  }
  const gl = r.gl;
  if (r.canvas.width !== w) r.canvas.width = w;
  if (r.canvas.height !== h) r.canvas.height = h;
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(r.prog);
  gl.bindVertexArray(r.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, r.buf);
  gl.uniform2f(r.uSize, w, h);
  gl.uniform1i(r.uTex, 0);
  for (const { mesh, sx, sy, tris, texture, vCount } of batches) {
    const uv = mesh.uvs;
    const textured = !!texture && !!uv && uv.length >= vCount * 2;
    const out = new Float32Array(tris.length * 24);
    let k = 0;
    for (const [a, b, c, , lit] of tris) {
      let cr;
      let cg;
      let cb;
      let ca;
      if (textured) {
        // DrawTexturedTri maps the triangle onto the picture (v flipped) and skips one whose texels have no area.
        const sx1 = (uv[b * 2] - uv[a * 2]) * texture.width;
        const sy1 = (uv[a * 2 + 1] - uv[b * 2 + 1]) * texture.height;
        const sx2 = (uv[c * 2] - uv[a * 2]) * texture.width;
        const sy2 = (uv[a * 2 + 1] - uv[c * 2 + 1]) * texture.height;
        if (Math.abs(sx1 * sy2 - sx2 * sy1) < 1e-4) continue;
        const s = Math.max(0.35, Math.min(1, lit));
        cr = cg = cb = s;
        ca = 1;
      } else {
        const s = solidShade(lit);
        cr = s / 255;
        cg = Math.trunc(s * 0.85) / 255;
        cb = Math.trunc(s * 0.7) / 255;
        ca = 220 / 255;
      }
      for (const v of [a, b, c]) {
        out[k++] = sx[v];
        out[k++] = sy[v];
        out[k++] = textured ? uv[v * 2] : 0;
        out[k++] = textured ? 1 - uv[v * 2 + 1] : 0;
        out[k++] = cr;
        out[k++] = cg;
        out[k++] = cb;
        out[k++] = ca;
      }
    }
    if (!k) continue;
    gl.uniform1i(r.uTextured, textured ? 1 : 0);
    if (textured) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, glTexture(r, texture));
    }
    gl.bufferData(gl.ARRAY_BUFFER, out.subarray(0, k), gl.STREAM_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, k / 8);
  }
  g.drawImage(r.canvas, 0, 0);
}

/** RebuildPreview into the canvas (sized like the desktop's bitmap, stretched over the host). */
function drawPreview(st, canvas, host) {
  const doc = st.doc;
  const g = canvas.getContext('2d');
  if (!doc.isValid || doc.isFmc || !doc.bones.length) {
    canvas.width = 720;
    canvas.height = 480;
    g.fillStyle = 'rgb(24, 24, 28)';
    g.fillRect(0, 0, 720, 480);
    g.font = `${pt(11)} "Segoe UI", system-ui, sans-serif`;
    g.textBaseline = 'top';
    g.fillStyle = 'rgb(220, 220, 220)';
    g.fillText(doc.isFmc ? 'FMC catalog — open a standalone anm.rra to play' : 'No animation data', 20, 20);
    return;
  }
  const w = Math.min(1600, Math.max(640, host.clientWidth));
  const h = Math.min(1200, Math.max(400, host.clientHeight));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  g.fillStyle = 'rgb(24, 24, 28)';
  g.fillRect(0, 0, w, h);
  const pose = rraPose(st);
  const { n, wp, wr, parentOf } = pose;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const expand = (p) => {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
    if (p[2] < minZ) minZ = p[2];
    if (p[2] > maxZ) maxZ = p[2];
  };
  for (let i = 0; i < n; i++) expand(wp[i]);
  const body = st.mesh?.body;
  let bodySkin = null;
  if (body?.mesh) {
    bodySkin = skinMatrices(st, pose);
    const bpos = body.mesh.positions;
    const bv = Math.floor(bpos.length / 3);
    const stride = Math.max(1, Math.trunc(bv / 120));
    for (let i = 0; i < bv; i += stride) expand(skinVertex(bpos, i, body.indices, body.weights, bodySkin));
  }
  const parts = rigidParts(st).map(([key, part, bi]) => [key, part, mul4(anim(wp[bi], wr[bi]), part.bindInverse)]);
  for (const [, part, skin] of parts) {
    const pos = part.mesh.positions;
    const hv = Math.floor(pos.length / 3);
    const stride = Math.max(1, Math.trunc(hv / 80));
    for (let i = 0; i < hv; i += stride) expand(transformPoint(skin, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
  }
  if (minX > maxX) {
    minX = -50;
    maxX = 50;
    minY = 0;
    maxY = 100;
    minZ = -50;
    maxZ = 50;
  }
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const hx = Math.max(4, (maxX - minX) * 0.5);
  const hy = Math.max(4, (maxY - minY) * 0.5);
  const hz = Math.max(4, (maxZ - minZ) * 0.5);
  const radius = Math.sqrt(hx * hx + hy * hy + hz * hz);
  const pad = 48;
  const scale = (Math.min(w - pad * 2, h - pad * 2) / Math.max(8, radius * 2)) * Math.max(0.12, st.zoom);
  const cyw = Math.cos(st.yaw);
  const syw = Math.sin(st.yaw);
  const cp = Math.cos(st.pitch);
  const sp = Math.sin(st.pitch);
  // ProjectOrbit: [screen x, screen y, depth].
  const project = (p) => {
    const x = p[0] - cx;
    const y = p[1] - cy;
    const z = p[2] - cz;
    const x1 = x * cyw + z * syw;
    const z1 = -x * syw + z * cyw;
    const y2 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;
    return [w * 0.5 + x1 * scale + st.panX, h * 0.55 - y2 * scale + st.panY, -z2];
  };

  g.lineCap = 'butt';
  const g0 = project([-200, 0, 0]);
  const g1 = project([200, 0, 0]);
  g.strokeStyle = `rgba(255, 255, 255, ${40 / 255})`;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(g0[0], g0[1]);
  g.lineTo(g1[0], g1[1]);
  g.stroke();

  const batch = (mesh, texture, worldOf) => {
    const pos = mesh.positions;
    if (!pos || !mesh.indices || pos.length < 9 || mesh.indices.length < 3) return null;
    const vCount = Math.floor(pos.length / 3);
    const sx = new Float32Array(vCount);
    const sy = new Float32Array(vCount);
    const depth = new Float32Array(vCount);
    for (let i = 0; i < vCount; i++) {
      const s = project(worldOf(i));
      sx[i] = s[0];
      sy[i] = s[1];
      depth[i] = s[2];
    }
    return { mesh, texture, sx, sy, vCount, tris: sortedTris(mesh, sx, sy, depth, vCount) };
  };
  const batches = [];
  if (bodySkin) batches.push(batch(body.mesh, body.texture, (i) => skinVertex(body.mesh.positions, i, body.indices, body.weights, bodySkin)));
  for (const [, part, skin] of parts) {
    const pos = part.mesh.positions;
    batches.push(batch(part.mesh, part.texture, (i) => transformPoint(skin, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])));
  }
  drawMeshes(
    g,
    w,
    h,
    batches.filter((b) => b),
  );

  const map = (p) => project(p);
  if (st.bones) {
    const orange = 'rgb(255, 165, 0)';
    for (let i = 0; i < n; i++) {
      const p = parentOf(i);
      if (p < 0 || p >= n) continue;
      const hi = i === st.selected || p === st.selected;
      const a = map(wp[p]);
      const b = map(wp[i]);
      g.strokeStyle = hi ? orange : `rgba(100, 190, 255, ${220 / 255})`;
      g.lineWidth = hi ? 4 : 3;
      g.beginPath();
      g.moveTo(a[0], a[1]);
      g.lineTo(b[0], b[1]);
      g.stroke();
    }
    g.font = `${pt(8)} "Segoe UI", system-ui, sans-serif`;
    g.textBaseline = 'top';
    for (let i = 0; i < n; i++) {
      const q = map(wp[i]);
      const hi = i === st.selected;
      const root = parentOf(i) < 0;
      const r = hi ? 6 : root ? 5 : 3.5;
      g.fillStyle = hi ? orange : root ? `rgba(80, 200, 120, ${220 / 255})` : `rgba(235, 235, 245, ${230 / 255})`;
      g.beginPath();
      g.arc(q[0], q[1], r, 0, Math.PI * 2);
      g.fill();
      if (hi || n <= 24) {
        g.fillStyle = hi ? orange : 'rgb(220, 220, 220)';
        g.fillText(doc.bones[i].name ?? '', q[0] + 7, q[1] - 7);
      }
    }
  }
  g.textBaseline = 'top';
  g.font = `bold ${pt(10)} "Segoe UI", system-ui, sans-serif`;
  g.fillStyle = `rgba(230, 230, 235, ${220 / 255})`;
  g.fillText(`${doc.name}   ${netFloat(st.frame, 2)} / ${Math.max(0, doc.frameCount - 1)}`, 12, 10);
  g.font = `${pt(8.5)} "Segoe UI", system-ui, sans-serif`;
  g.fillStyle = `rgba(200, 200, 210, ${180 / 255})`;
  g.fillText(`orbit  ·  ${n} bones  ·  ${st.playing ? 'playing' : 'paused'}  ·  LMB rotate · RMB pan · wheel zoom`, 12, 30);
  const t = doc.frameCount > 1 ? st.frame / (doc.frameCount - 1) : 0;
  g.fillStyle = `rgba(0, 0, 0, ${80 / 255})`;
  g.fillRect(0, h - 6, w, 6);
  g.fillStyle = `rgba(255, 160, 40, ${200 / 255})`;
  g.fillRect(0, h - 6, Math.trunc(w * t), 6);
}

// ---- the view ----

function applyView(st, view, resetPanZoom) {
  st.view = view;
  if (view === 1) {
    st.yaw = Math.PI * 0.5;
    st.pitch = 0;
  } else if (view === 2) {
    st.yaw = 0;
    st.pitch = Math.PI * 0.5 - 0.02;
  } else {
    st.yaw = 0;
    st.pitch = 0;
  }
  if (resetPanZoom) {
    st.zoom = 1;
    st.panX = 0;
    st.panY = 0;
  }
}

/** The bone tree (TreeView): the root "name (N bones)" open, bones nested under their parents. */
function boneTree(st, onSelect) {
  const doc = st.doc;
  const host = el('div', { class: 'tanda-tree', role: 'tree', 'aria-label': 'Bones' });
  if (doc.isFmc || !doc.bones.length) {
    host.append(el('div', { class: 'tree-row' }, el('span', { class: 'twisty' }), el('div', { class: 'tree-item', role: 'treeitem' }, doc.isFmc ? '(FMC catalog — no bone tree)' : '(no bones)')));
    return host;
  }
  const n = doc.bones.length;
  const kids = Array.from({ length: n + 1 }, () => []); // index n holds the root's children
  for (let i = 0; i < n; i++) {
    const p = doc.bones[i].parentIndex;
    kids[p >= 0 && p < n && p !== i ? p : n].push(i);
  }
  const label = (i) => {
    if (i < 0) return `${doc.name} (${n} bones)`;
    const b = doc.bones[i];
    return `${b.name}  [P${b.tracks[0]?.count ?? 0} R${b.tracks[1]?.count ?? 0} S${b.tracks[2]?.count ?? 0}]`;
  };
  const render = () => {
    host.replaceChildren();
    const build = (i, depth) => {
      const children = kids[i < 0 ? n : i];
      const open = st.expanded.has(i);
      const sel = i >= 0 && st.selected === i;
      const item = el('div', { class: 'tree-item' + (sel ? ' sel' : ''), role: 'treeitem', tabindex: -1, 'aria-selected': String(sel), title: label(i) }, label(i));
      if (children.length) item.setAttribute('aria-expanded', String(open));
      const twisty = el('button', { type: 'button', class: 'twisty', tabindex: -1, 'aria-hidden': 'true' }, children.length ? (open ? '▾' : '▸') : '');
      twisty.addEventListener('click', () => {
        if (open) st.expanded.delete(i);
        else st.expanded.add(i);
        render();
      });
      item.addEventListener('click', () => {
        onSelect(i);
        render();
      });
      const box = el('div', {}, el('div', { class: 'tree-row', style: `padding-left: ${depth * 14}px` }, twisty, item));
      if (open) for (const c of children) box.append(build(c, depth + 1));
      return box;
    };
    host.append(build(-1, 0));
  };
  render();
  return host;
}

export function renderRra(node, ctx) {
  // BresBundleEditor opens an entry in the player only when it is an animation payload (LooksLikeRra).
  if (node.parent && !isAnimationPayload(node.payload))
    return el('div', { class: 'view rra-view' }, el('div', { class: 'banner', role: 'status' }, 'This entry is not a Happy Wars .rra / .cmf animation.'));
  const st = stateFor(node, ctx);
  const title = node.parent ? stem(node.name) : baseName(ctx.filePath ?? node.name);
  const headerBase = node.parent ? title : ctx.filePath ?? title;
  if (!st.ready) {
    const wait = el('div', { class: 'view rra-view' }, el('div', { class: 'toolbar' }, el('span', { class: 'note' }, headerBase)), el('p', { class: 'note' }, 'Loading animation…'));
    st.promise.then(() => wait.isConnected && ctx.rerender());
    return wait;
  }
  const doc = st.doc;
  if (st.error || !doc) {
    return el('div', { class: 'view rra-view' }, el('div', { class: 'toolbar' }, el('span', { class: 'note' }, headerBase)), el('div', { class: 'banner banner-error', role: 'alert' }, `Could not open file: ${st.error}`));
  }
  let header = headerBase + '  |  ' + n0(node.payload.length) + ' bytes';
  if (doc.isValid) {
    if (doc.isFmc) {
      header += '  |  FMC catalog';
      if (doc.fmcFrameCount > 0) header += '  |  ' + doc.fmcFrameCount + ' frames';
      if (doc.fmcName) header += '  |  ' + doc.fmcName;
    } else {
      header += `  |  ${doc.isCmf ? 'cmf' : 'anm.rra'} player  |  ${doc.frameCount} frames @ ${FPS} fps  |  ${doc.bones.length} bones  |  ${doc.keyframeCount} keys`;
    }
  }
  header += st.extras;
  const memo = (st.report + (st.meshNotes.length ? '\n' + st.meshNotes.join('\n') : '')).trim();

  const view = el('div', { class: 'view rra-view', tabindex: -1 }, el('div', { class: 'toolbar' }, el('span', { class: 'note', title: 'Animation (.rra / .cmf)' }, header)));
  if (!doc.isValid) view.append(el('div', { class: 'banner banner-warn', role: 'alert' }, 'This file does not look like a Happy Wars .rra / .cmf animation.'));

  const run = ++st.run;
  const maxFrame = () => Math.max(0, doc.frameCount - 1);
  const host = el('div', { class: 'anim-host' });
  const canvas = el('canvas', { tabindex: 0, 'aria-label': 'Animation preview', style: 'cursor: move' });
  host.append(canvas);
  const redraw = () => drawPreview(st, canvas, host);

  // Transport row (Prev, Play, Stop, Next, Loop, Bones, Speed, View, Keys, frame, fps) and the scrubber.
  const playBtn = button(st.playing ? '❚❚ Pause' : '▶ Play', () => (st.playing ? stop() : start()));
  const scrub = el('input', { type: 'range', min: 0, max: doc.frameCount > 0 ? maxFrame() : 0, step: 1, value: Math.round(st.frame), 'aria-label': 'Frame', style: 'width: 100%' });
  const frameLbl = el('span', { class: 'note', style: 'min-width: 9em' });
  const updateLabel = () => (frameLbl.textContent = `Frame ${netFloat(st.frame, 2)} / ${doc.frameCount > 0 ? maxFrame() : 0}`);
  const setFrame = (f, sync) => {
    if (doc.frameCount <= 0) {
      st.frame = 0;
      return;
    }
    st.frame = Math.min(maxFrame(), Math.max(0, f));
    if (sync) scrub.value = String(Math.min(Number(scrub.max), Math.max(0, Math.round(st.frame))));
    updateLabel();
    redraw();
  };
  const tick = (now) => {
    if (run !== st.run || !st.playing || !canvas.isConnected) return;
    let dt = (now - st.last) / 1000;
    st.last = now;
    if (dt <= 0 || dt > 0.25) dt = 1 / 60;
    const max = maxFrame();
    let next = st.frame + dt * FPS * SPEEDS[st.speed];
    if (next > max) {
      if (st.loop) next %= max + 1;
      else {
        next = max;
        stop();
      }
    }
    setFrame(next, true);
    if (st.playing) requestAnimationFrame(tick);
  };
  function start() {
    if (!doc.isValid || doc.isFmc || doc.frameCount <= 0) return;
    st.playing = true;
    playBtn.textContent = '❚❚ Pause';
    st.last = performance.now();
    requestAnimationFrame(tick);
  }
  function stop() {
    st.playing = false;
    playBtn.textContent = '▶ Play';
  }
  const select = (label, options, index, onChange) => {
    const s = el('select', { class: 'input', 'aria-label': label });
    options.forEach((o, i) => s.append(el('option', { value: String(i) }, o)));
    s.value = String(index);
    s.addEventListener('change', () => onChange(Number(s.value)));
    return s;
  };
  const check = (label, on, onChange) => {
    const c = el('input', { type: 'checkbox' });
    c.checked = on;
    c.addEventListener('change', () => onChange(c.checked));
    return el('label', { class: 'check' }, c, ' ' + label);
  };

  // Key list (ListView): the selected bone's keys on one channel; the last key at or before the frame is selected.
  const keysHost = el('div', { class: 'grid-wrap anim-keys' });
  const refreshKeys = () => {
    keysHost.replaceChildren();
    const b = st.selected >= 0 && st.selected < doc.bones.length ? doc.bones[st.selected] : null;
    const track = b?.tracks[st.channel];
    const head = el('tr', {}, ...['Frame' + (track?.keys ? ` (${track.channelName})` : ''), 'X', 'Y', 'Z', 'W'].map((t) => el('th', {}, t)));
    const tbody = el('tbody');
    keysHost.append(el('table', { class: 'grid' }, el('thead', {}, head), tbody));
    if (!track?.keys) return;
    let hi = -1;
    track.keys.forEach((k, i) => {
      const tr = el('tr', {}, el('td', {}, String(k.frame)), ...[k.x, k.y, k.z, k.w].map((v) => el('td', { class: 'num' }, netFloat(v, 4))));
      tr.addEventListener('dblclick', () => setFrame(k.frame, true));
      tbody.append(tr);
      if (k.frame <= st.frame) hi = i;
    });
    if (hi >= 0) {
      const tr = tbody.children[hi];
      tr.classList.add('sel');
      requestAnimationFrame(() => tr.scrollIntoView({ block: 'nearest' }));
    }
  };

  const tree = boneTree(st, (i) => {
    st.selected = i;
    refreshKeys();
    redraw();
  });

  const row1 = el(
    'div',
    { class: 'toolbar', style: 'flex-wrap: wrap; gap: 6px; align-items: center' },
    button('|◀', () => (stop(), setFrame(Math.floor(st.frame) - 1, true)), { title: 'Previous frame' }),
    playBtn,
    button('■', () => (stop(), setFrame(0, true)), { title: 'Stop' }),
    button('▶|', () => (stop(), setFrame(Math.floor(st.frame) + 1, true)), { title: 'Next frame' }),
    check('Loop', st.loop, (v) => (st.loop = v)),
    check('Bones', st.bones, (v) => ((st.bones = v), redraw())),
    el('span', { class: 'note' }, 'Speed'),
    select('Speed', SPEED_LABELS, st.speed, (v) => (st.speed = v)),
    el('span', { class: 'note' }, 'View'),
    select('View', VIEWS, st.view, (v) => (applyView(st, v, false), redraw())),
    el('span', { class: 'note' }, 'Keys'),
    select('Key channel', CHANNELS, st.channel, (v) => ((st.channel = Math.max(0, Math.min(2, v))), refreshKeys())),
    frameLbl,
    el('span', { class: 'note' }, FPS + ' fps'),
  );
  scrub.addEventListener('input', () => setFrame(Number(scrub.value), false));

  // Orbit camera: LMB rotates, RMB / MMB pans, the wheel zooms, a double-click resets the view.
  let drag = null;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, orbit: e.button === 0, pan: e.button === 1 || e.button === 2 };
    canvas.setPointerCapture(e.pointerId);
    canvas.focus();
    if (e.button === 1) e.preventDefault();
  });
  canvas.addEventListener('pointerup', (e) => {
    drag = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = Math.round(e.clientX) - Math.round(drag.x);
    const dy = Math.round(e.clientY) - Math.round(drag.y);
    if (!dx && !dy) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.orbit) {
      st.yaw += dx * 0.012;
      st.pitch = Math.max(-1.45, Math.min(1.45, st.pitch + dy * 0.012));
    }
    if (drag.pan) {
      st.panX += dx;
      st.panY += dy;
    }
    redraw();
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (!e.deltaY) return;
      st.zoom = Math.max(0.12, Math.min(12, st.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      redraw();
    },
    { passive: false },
  );
  canvas.addEventListener('dblclick', () => (applyView(st, st.view, true), redraw()));
  view.addEventListener('keydown', (e) => {
    if (st.tab !== 'player' || /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)) return;
    if (e.key === ' ') st.playing ? stop() : start();
    else if (e.key === 'ArrowLeft') (stop(), setFrame(st.frame - 1, true));
    else if (e.key === 'ArrowRight') (stop(), setFrame(st.frame + 1, true));
    else if (e.key === 'Home') (stop(), setFrame(0, true));
    else if (e.key === 'End') (stop(), setFrame(Number(scrub.max), true));
    else return;
    e.preventDefault();
  });

  const player = el(
    'div',
    { style: 'flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px' },
    el('div', { class: 'anim-body' }, host, el('div', { class: 'anim-side' }, tree, el('span', { class: 'note' }, 'Keys'), keysHost)),
    row1,
    scrub,
  );
  const info = el('pre', { class: 'lng-report', style: 'margin: 0; white-space: pre; overflow: auto' }, memo);
  const body = el('div', { style: 'flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: auto' });
  const bar = el('div', { class: 'seg', role: 'group', 'aria-label': 'Animation views' });
  const show = (key) => {
    st.tab = key;
    for (const b of bar.children) b.setAttribute('aria-pressed', String(b.dataset.tab === key));
    body.replaceChildren(key === 'player' ? player : info);
    if (key === 'player') redraw();
  };
  bar.append(button(doc.isFmc ? 'Player (FMC)' : `Player (${doc.frameCount}f)`, () => show('player'), { dataset: { tab: 'player' } }), button('Info', () => show('info'), { dataset: { tab: 'info' } }));
  view.append(el('div', { class: 'tabs-bar' }, bar), body);
  updateLabel();
  refreshKeys();
  show(st.tab);
  new ResizeObserver(() => canvas.isConnected && run === st.run && !st.playing && redraw()).observe(host);
  if (st.playing) start();
  return view;
}
