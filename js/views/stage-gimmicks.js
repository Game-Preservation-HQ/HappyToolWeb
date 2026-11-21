// The stage's gimmicks (castle monuments, gates, ballistas, catapults …): its gimmick table
// Data/json/stage/<id>_stage_gimmick.json and the models it places from Data/gimmick. Port of the desktop's
// StageViewerForm.Gimmicks: reading the table, showing every placement with its model, the edits file's Gimmicks list
// and the edited table.
//
// Each placement is one object of the map editor (a mesh of kind 'gimmick', no object ranges, so its pieces move
// together as the desktop's group does). Its mesh is the model at the table's position, not turned; its pivot is that
// position and its rotation starts at the table's numbers, so the object's state reads back as the placement:
// Position = pivot + t (as the desktop's SaveGimmickState), Rotation = the state's rotation.

import { decodeLayers, encodeLayers } from '../formats/wrappers.js';
import { parseBres } from '../formats/bres.js';
import { buildSteamStage } from '../formats/steam-stage.js';
import { stripTextureExtension } from '../formats/rrm.js';
import { decodeDds } from '../formats/dds.js';
import { IDENTITY, rotation, wrapDegrees } from './stage-edit.js';

const lower = (s) => (s ? s.toLowerCase() : s);
const SECTION = 'gimmickArrangeParam_';
const CAMERA_SECTION = 'gimmickCameraParam_';
const pause = () => new Promise((r) => setTimeout(r, 0));

// ---------- the table's text (the game's tables carry comments, so they are walked as text, as on the desktop) ----------

/** Skips a string or comment starting at i; returns the index after it (i when neither). SkipJsonTrivia. */
export function skipTrivia(t, i) {
  if (t[i] === '"') {
    for (let k = i + 1; k < t.length; k++) {
      if (t[k] === '\\') {
        k++;
        continue;
      }
      if (t[k] === '"') return k + 1;
    }
    return t.length;
  }
  if (t[i] === '/' && t[i + 1] === '/') {
    const e = t.indexOf('\n', i);
    return e < 0 ? t.length : e + 1;
  }
  if (t[i] === '/' && t[i + 1] === '*') {
    const e = t.indexOf('*/', i + 2);
    return e < 0 ? t.length : e + 2;
  }
  return i;
}

/** The matching '}' for the '{' at open, or -1. MatchBrace. */
export function matchBrace(t, open) {
  let depth = 0;
  for (let i = open; i < t.length; ) {
    const j = skipTrivia(t, i);
    if (j !== i) {
      i = j;
      continue;
    }
    if (t[i] === '{') depth++;
    else if (t[i] === '}' && --depth === 0) return i;
    i++;
  }
  return -1;
}

/** The object-valued entries directly inside the object whose braces are at open/close: [{key, open, close}]. */
export function jsonEntries(t, open, close) {
  const list = [];
  let key = null;
  for (let i = open + 1; i < close; ) {
    if (t[i] === '"') {
      const j = skipTrivia(t, i);
      key = t.slice(i + 1, j - 1);
      i = j;
      continue;
    }
    const k = skipTrivia(t, i);
    if (k !== i) {
      i = k;
      continue;
    }
    if (t[i] === '{') {
      const c = matchBrace(t, i);
      if (c < 0) break;
      list.push({ key, open: i, close: c });
      i = c + 1;
      continue;
    }
    i++;
  }
  return list;
}

/** The braces of the object-valued entry `name` anywhere in the text (a table's sections), or null. FindJsonSection. */
export function findSection(t, name) {
  const at = t.indexOf(`"${name}"`);
  if (at < 0) return null;
  const open = t.indexOf('{', at);
  if (open < 0) return null;
  const close = matchBrace(t, open);
  return close > open ? { open, close } : null;
}

const FIELD = /"([A-Za-z0-9_]+)"\s*:\s*("(?:[^"\\]|\\.)*"|[^,\r\n}]+)/g;

/** A record's fields as text (quotes taken off strings). JsonFields. */
export function jsonFields(record) {
  const d = new Map();
  for (const m of record.matchAll(FIELD)) {
    let v = m[2].trim();
    if (v.startsWith('"')) v = v.slice(1, -1);
    d.set(m[1], v);
  }
  return d;
}

const FLOAT = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/;
const jsonFloat = (f, key) => {
  const v = f.get(key);
  return v != null && FLOAT.test(v) ? Math.fround(parseFloat(v)) : 0;
};

/** The model a placement shows: its first model, else its tag without the team letter and number. GimmickModelName. */
export function gimmickModelName(tag, f) {
  const m = f.get('firstModelName_');
  if (m) return m;
  let t = tag;
  if (t.length > 2 && (t[0] === 'W' || t[0] === 'B') && t[1] === 'g') t = t.slice(1);
  const u = t.lastIndexOf('_');
  return u > 0 ? t.slice(0, u) : t;
}

/** The placements of a table's gimmickArrangeParam_ section (records without a position, rafts, are left out). */
export function readPlacements(text) {
  const sec = findSection(text, SECTION);
  if (!sec) return null;
  const list = [];
  for (const e of jsonEntries(text, sec.open, sec.close)) {
    const f = jsonFields(text.slice(e.open, e.close + 1));
    if (!f.has('transX_')) continue; // attached ones (rafts) move with their parent
    const position = ['transX_', 'transY_', 'transZ_'].map((k) => jsonFloat(f, k));
    const rot = ['rotX_', 'rotY_', 'rotZ_'].map((k) => jsonFloat(f, k));
    const removed = f.get('enable_') === 'false';
    list.push({
      tag: e.key, type: f.get('gimmickType_') ?? 'Gimmick', model: gimmickModelName(e.key, f), season: null, isNew: false,
      position, rotation: rot, removed, position0: position.slice(), rotation0: rot.slice(), removed0: removed,
    });
  }
  return list;
}

const len3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Whether a placement differs from the table (GimmickPlacement.Changed). */
export const placementChanged = (g) =>
  g.isNew ? !g.removed : g.removed !== g.removed0 || len3(g.position, g.position0) > 0.01 || len3(g.rotation, g.rotation0) > 0.01;

// ---------- placements ↔ the map editor's object state ----------

/** The state that shows a placement (pivot = the table's position, rotation = the placement's numbers). GimmickPieceState. */
export function stateOfPlacement(g) {
  return {
    ...IDENTITY,
    t: [0, 1, 2].map((k) => Math.fround(g.position[k] - g.position0[k])),
    r: g.rotation.map(wrapDegrees),
    hidden: g.removed,
  };
}

/** Reads a gimmick object's state back into its placement (SaveGimmickState: the model's origin and the rotation). */
export function placementFromState(o) {
  const g = o.gimmick, st = o.state, pv = o.pivot, P0 = g.position0;
  const R = rotation(st.r), d = [0, 1, 2].map((k) => (P0[k] - pv[k]) * st.s[0]);
  for (let k = 0; k < 3; k++) g.position[k] = Math.fround(R[k * 3] * d[0] + R[k * 3 + 1] * d[1] + R[k * 3 + 2] * d[2] + pv[k] + st.t[k]);
  g.removed = !!st.hidden;
  // The state's rotation is wrapped to (-180, 180]; until the placement is edited it keeps the table's own numbers
  // (251.66, not -108.34), as the desktop only takes the view's rotation once the placement moves.
  const r = st.r.map((x) => Math.fround(x));
  const turned = r.some((x, k) => Math.abs(wrapDegrees(x - g.rotation0[k])) > 1e-4);
  const edited = turned || len3(g.position, g.position0) > 0.01 || g.removed !== g.removed0;
  g.rotation = edited || g.isNew ? r : g.rotation0.slice();
  return g;
}

/** The edits file's Gimmicks entry of a placement, or null when it matches the table (SaveGimmickEdit). */
export function gimmickEdit(g) {
  if (!placementChanged(g)) return null;
  const e = { Tag: g.tag };
  if (g.season != null) e.Season = g.season;
  if (g.isNew) {
    e.Model = g.model;
    e.Type = g.type;
    if (g.templateTag) e.Template = g.templateTag;
  }
  e.Position = g.position.slice();
  e.Rotation = g.rotation.slice();
  if (g.removed) e.Removed = true;
  return e;
}

/** Applies a stored edit to a placement (ApplyGimmickEdit). */
export function applyGimmickEdit(g, s) {
  const ok = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(Number(x)));
  if (ok(s.Position)) g.position = s.Position.map((x) => Math.fround(Number(x)));
  if (ok(s.Rotation)) g.rotation = s.Rotation.map((x) => Math.fround(Number(x)));
  g.removed = !!s.Removed;
}

// ---------- loading ----------

/** The Data\gimmick bundle of a model (gfmo → gfmoA when only the team versions exist). GimmickBundle. */
function bundleOf(byName, model) {
  for (const n of [model, `${model}A`, `${model}01`]) {
    const f = byName.get(lower(`${n}.bres`));
    if (f) return f;
  }
  return null;
}

const stemOf = (f) => lower(f.name.replace(/\.bres$/i, ''));
const ddsNames = (arc) => new Set(arc.entries.filter((e) => /\.dds$/i.test(e.name)).map((e) => lower(stripTextureExtension(e.name))));

/** A gimmick bundle's geometry, built as a stage's (AppendSteamMeshes). Throws when it has none, as LoadAssetStage. */
async function buildModel(arc) {
  const rrm = [];
  for (const e of arc.entries) {
    if (!/\.rrm$/i.test(e.name) || e.pointer || !e.data?.length) continue;
    rrm.push({ name: e.name, pointer: false, data: (await decodeLayers(e.data)).payload });
  }
  const dds = arc.entries.filter((e) => /\.dds$/i.test(e.name)).map((e) => ({ name: e.name, pointer: true, data: null }));
  const built = buildSteamStage([...rrm, ...dds]);
  const meshes = built.meshes.filter((m) => m.positions.length >= 9 && m.indices.length >= 3);
  if (!meshes.length) throw new Error('It has no Steam stage geometry.');
  return { meshes, need: built.textures };
}

/** One buffer for a model: its meshes merged, texture names turned into the keys the decoded pictures are kept under. */
function mergeModel(meshes, keyOf) {
  let vc = 0, ic = 0;
  for (const m of meshes) {
    vc += m.positions.length / 3;
    ic += m.indices.length;
  }
  const positions = new Float32Array(vc * 3), normals = new Float32Array(vc * 3);
  const uvs = new Float32Array(vc * 2), uvs2 = new Float32Array(vc * 2), indices = new Uint32Array(ic);
  const batches = [];
  let anyUv = false, anyUv2 = false, v = 0, ii = 0;
  for (const m of meshes) {
    const n = m.positions.length / 3;
    positions.set(m.positions, v * 3);
    if (m.normals?.length === m.positions.length) normals.set(m.normals, v * 3);
    if (m.uvs?.length === n * 2) {
      uvs.set(m.uvs, v * 2);
      anyUv = true;
    }
    if (m.uvs2?.length === n * 2) {
      uvs2.set(m.uvs2, v * 2);
      anyUv2 = true;
    }
    for (let k = 0; k < m.indices.length; k++) indices[ii + k] = m.indices[k] + v;
    for (const b of m.batches) batches.push({ ...b, firstIndex: b.firstIndex + ii, texture: keyOf(b.texture), lightmap: keyOf(b.lightmap) });
    v += n;
    ii += m.indices.length;
  }
  return { positions, normals, uvs: anyUv ? uvs : null, uvs2: anyUv && anyUv2 ? uvs2 : null, indices, batches };
}

/** A placement's mesh: the model at the table's position (not turned: the object's rotation turns it). */
function placementMesh(tpl, g) {
  const P = g.position0, src = tpl.positions, positions = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    positions[i] = src[i] + P[0];
    positions[i + 1] = src[i + 1] + P[1];
    positions[i + 2] = src[i + 2] + P[2];
  }
  return {
    name: `gimmick/${g.tag}`, kind: 'gimmick', gimmick: g, positions, normals: tpl.normals.slice(), uvs: tpl.uvs, uvs2: tpl.uvs2,
    indices: tpl.indices, batches: tpl.batches.map((b) => ({ ...b })),
  };
}

/**
 * Reads the stage's gimmick table and builds a mesh for every placement whose model is found (LoadGimmicks): returns
 * {table: {name, path, stageId, text, layers}, placements, meshes, log} or null when the stage has no table. Decoded
 * textures go into `textures` under `gimmick:<bundle>/<name>`.
 * @param {{ids: string[], dataFiles: (dir: string) => {name, path, read}[], textures: Map, report: (t: string) => void}} o
 */
export async function loadGimmicks({ ids, dataFiles, textures, report = () => {} }) {
  const tables = dataFiles('json/stage');
  let file = null, stageId = null;
  for (const id of ids) {
    file = tables.find((f) => lower(f.name) === lower(`${id}_stage_gimmick.json`));
    if (file) {
      stageId = id;
      break;
    }
  }
  if (!file) return null;
  let text, layers;
  try {
    const d = await decodeLayers(await file.read());
    layers = d.layers;
    text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(d.payload);
  } catch (e) {
    console.warn(`Gimmicks: could not read ${file.path}: ${e.message}`);
    return null;
  }
  const placements = readPlacements(text);
  if (!placements) return null;
  const log = [`gimmicks: ${placements.length} placements in ${file.name}`];
  const table = { name: file.name, path: file.path, stageId, text, layers };

  const bundles = dataFiles('gimmick')
    .filter((f) => /\.bres$/i.test(f.name))
    .sort((a, b) => (lower(a.name) < lower(b.name) ? -1 : lower(a.name) > lower(b.name) ? 1 : 0));
  const byName = new Map(bundles.map((f) => [lower(f.name), f]));
  const arcs = new Map();
  const readArc = async (f) => {
    if (!arcs.has(f)) {
      let arc = null;
      try {
        arc = parseBres((await decodeLayers(await f.read())).payload);
      } catch (e) {
        console.warn(`Gimmicks: ${f.path} could not be read: ${e.message}`);
      }
      arcs.set(f, arc);
    }
    return arcs.get(f);
  };

  // The models (one per name), built as stages are.
  const models = new Map();
  const names = [...new Set(placements.map((g) => lower(g.model)))];
  for (const [i, m] of names.entries()) {
    const f = bundleOf(byName, m);
    if (!f) continue;
    report(`Gimmick models (${i + 1} of ${names.length})…`);
    await pause();
    const arc = await readArc(f);
    if (!arc) continue;
    try {
      models.set(m, { file: f, arc, own: ddsNames(arc), ...(await buildModel(arc)) });
    } catch (e) {
      console.warn(`Gimmicks: model ${m}: ${e.message}`);
    }
  }

  // Textures a model lacks, from the other gimmick bundles (FindSharedGimmickTextures): gall01 first, then bundles
  // named like a wanted texture, then the rest.
  const wanted = new Set();
  for (const md of models.values()) for (const t of md.need) if (!md.own.has(t)) wanted.add(t);
  const where = new Map(); // texture → {file, arc}
  if (wanted.size) {
    const rank = (f) => (stemOf(f) === 'gall01' ? 0 : [...wanted].some((w) => stemOf(f).startsWith(w.length > 3 ? w.slice(0, 4) : w)) ? 1 : 2);
    const order = bundles.map((f, i) => ({ f, i, r: rank(f) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.f);
    for (const f of order) {
      if ([...wanted].every((w) => where.has(w))) break;
      const arc = await readArc(f);
      if (!arc) continue;
      for (const t of ddsNames(arc)) if (wanted.has(t) && !where.has(t)) where.set(t, { file: f, arc });
    }
  }

  // Decoded pictures, once per bundle and name.
  const failed = new Set();
  const decode = async (file, arc, name) => {
    const key = `gimmick:${stemOf(file)}/${name}`;
    if (textures.has(key)) return key;
    if (failed.has(key)) return null;
    const e = arc.entries.find((x) => /\.dds$/i.test(x.name) && lower(stripTextureExtension(x.name)) === name && !x.pointer && x.data?.length);
    try {
      if (!e) throw new Error('not in the bundle');
      textures.set(key, decodeDds((await decodeLayers(e.data)).payload));
      return key;
    } catch (err) {
      console.warn(`Gimmicks: texture ${name} of ${file.name} could not be decoded: ${err.message}`);
      failed.add(key);
      return null;
    }
  };
  const templates = new Map();
  for (const [m, md] of models) {
    report(`Gimmick textures (${m})…`);
    await pause();
    const keys = new Map();
    for (const t of md.need) {
      const src = md.own.has(t) ? { file: md.file, arc: md.arc } : where.get(t);
      keys.set(t, src ? await decode(src.file, src.arc, t) : null);
    }
    templates.set(m, mergeModel(md.meshes, (n) => (n ? keys.get(lower(n)) ?? null : null)));
  }

  const meshes = [];
  for (const g of placements) {
    const tpl = templates.get(lower(g.model));
    if (tpl) meshes.push(placementMesh(tpl, g));
  }
  log.push(`gimmicks: shown ${meshes.length} with their models`);
  return { table, placements, meshes, log };
}

// ---------- the edited table ----------

/** Math.Round(v, 4) (to even) as "0.####". Num. */
export function num(v) {
  const x = Math.fround(v) * 1e4;
  let r = Math.round(x);
  if (r - x === 0.5 && r % 2 !== 0) r -= 1; // to even, as .NET rounds
  const out = r / 1e4;
  return Object.is(out, -0) || out === 0 ? '0' : String(out);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Sets (or adds, first in the record) a field's literal inside one record's text. SetJsonField. */
export function setJsonField(record, key, literal) {
  const m = new RegExp(`("${escapeRe(key)}"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|[^,\\r\\n}]+)`).exec(record);
  if (m) {
    const at = m.index + m[1].length;
    return record.slice(0, at) + literal + record.slice(at + m[2].length);
  }
  const brace = record.indexOf('{');
  return `${record.slice(0, brace + 1)}\n\t\t"${key}" : ${literal},${record.slice(brace + 1)}`;
}

/** A record with a placement's numbers. PlaceRecord (no ground warp on the web yet: dy 0). */
export function placeRecord(record, g, dy = 0) {
  record = setJsonField(record, 'transX_', num(g.position[0]));
  record = setJsonField(record, 'transY_', num(g.position[1] + dy));
  record = setJsonField(record, 'transZ_', num(g.position[2]));
  if (Math.abs(g.rotation[0]) > 0.001 || record.includes('"rotX_"')) record = setJsonField(record, 'rotX_', num(g.rotation[0]));
  record = setJsonField(record, 'rotY_', num(g.rotation[1]));
  if (Math.abs(g.rotation[2]) > 0.001 || record.includes('"rotZ_"')) record = setJsonField(record, 'rotZ_', num(g.rotation[2]));
  if (g.removed) record = setJsonField(record, 'enable_', 'false');
  else if (record.includes('"enable_"')) record = setJsonField(record, 'enable_', 'true');
  return record;
}

/**
 * The table with every edit applied (EditedGimmickTable): moved / turned placements get their new numbers, removed
 * ones `enable_ : false`, new ones are appended (copies of their template, with its camera entry). Returns
 * {text, moved, removed, added}, or null when nothing changed.
 */
export function editedGimmickTable(text, placements) {
  const moves = (g) => placementChanged(g);
  if (text == null || !placements.some(moves)) return null;
  const sec = findSection(text, SECTION);
  if (!sec) return null;
  let out = '', at = 0, moved = 0, removed = 0, added = 0;
  const seen = new Map();
  for (const e of jsonEntries(text, sec.open, sec.close).sort((a, b) => a.open - b.open)) {
    const nth = seen.get(e.key) ?? 0;
    seen.set(e.key, nth + 1);
    const g = placements.filter((x) => !x.isNew && x.tag === e.key)[nth];
    if (!g || !moves(g)) continue;
    out += text.slice(at, e.open) + placeRecord(text.slice(e.open, e.close + 1), g);
    at = e.close + 1;
    if (g.removed && !g.removed0) removed++;
    else moved++;
  }
  let end = sec.close;
  while (end > sec.open && /\s/.test(text[end - 1])) end--;
  out += text.slice(at, end);
  const fresh = placements.filter((g) => g.isNew && !g.removed);
  for (const g of fresh) {
    out += `,\n\t"${g.tag}":${placeRecord(g.templateText, g)}`;
    added++;
  }
  let result = out + text.slice(end);
  const cams = fresh.filter((g) => g.templateCamera != null);
  const cs = cams.length ? findSection(result, CAMERA_SECTION) : null;
  if (cs) {
    let ce = cs.close;
    while (ce > cs.open && /\s/.test(result[ce - 1])) ce--;
    result = result.slice(0, ce) + cams.map((g) => `,\n\t"${g.tag}":${g.templateCamera}`).join('') + result.slice(ce);
  }
  // Must still read back to the same placements (WriteGimmickTable).
  const back = findSection(result, SECTION);
  if (!back || jsonEntries(result, back.open, back.close).length < placements.filter((g) => !g.isNew || !g.removed).length)
    throw new Error('The edited gimmick table did not read back.');
  return { text: result, moved, removed, added };
}

/** The edited table's file bytes, wrapped as the table was (BFBR / ZRES). */
export async function gimmickTableBytes(table, text) {
  const plain = new TextEncoder().encode(text);
  return table.layers?.length ? encodeLayers(plain, table.layers) : plain;
}
