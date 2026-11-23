// Invisible zones the game puts on a stage, drawn so a map maker can see them. Port of the desktop's
// StageViewerForm.Zones:
//  - Gimmick trigger zones: the spheres, boxes and cylinders a gimmick's behaviour file (json/gimmick/<acts>.json, picked
//    by GimmickModelParam.json → actsName_) registers with command::TrapSphere / TrapBox / TrapCylinder / TrapCapsule:
//    where a castle gate opens, where a battering ram takes materials, where you climb on a bomb stone … They move and
//    turn with their gimmick.
//  - Extra stage collision: the gimmick table's collisionEntries_, boxes and spheres the game adds to the terrain that no
//    model shows. One inside a movable stage object moves, turns and goes with it; any one can be removed (the edits
//    file's "stagevolumes" feature), and the downloaded gimmick table leaves it out or rewrites its record.
// From the game code (0.5.2): a trap's centre is in its gimmick's frame, a box trap's extent is its half size. A
// collision entry is trans + R(pos + shape), R turning about X, then Y, then Z (rotation() here); a BOX's widths are
// full sizes, a SPHERE uses radius_.
//
// Frames are { M, T }: M a row-major 3x3 acting on column vectors (as stage-edit.js), world = M·p + T.

import { decodeLayers } from '../formats/wrappers.js';
import { findSection, jsonEntries, setJsonField, num } from './stage-gimmicks.js';
import { rotation, eulerOf } from './stage-edit.js';

export const STAGE_VOLUMES_KEY = 'stagevolumes';
const SECTION = 'collisionEntries_';

// ---------- reading ----------

const FLAT_FIELD = /"([A-Za-z0-9_@:]+)"\s*:\s*("[^"\n]*"|[-+0-9.eE]+|true|false)/g;

/** The scalar fields of a flat JSON object's text (strings without their quotes). FlatFields. */
export function flatFields(body) {
  const d = new Map();
  for (const m of (body ?? '').matchAll(FLAT_FIELD)) d.set(m[1], m[2].length >= 2 && m[2][0] === '"' ? m[2].slice(1, -1) : m[2]);
  return d;
}
const fieldFloat = (f, key) => {
  const s = f.get(key);
  const v = s == null || s === '' ? NaN : Number(s);
  return Number.isFinite(v) ? v : 0;
};
const fieldVec = (f, prefix) => [fieldFloat(f, `${prefix}X_`), fieldFloat(f, `${prefix}Y_`), fieldFloat(f, `${prefix}Z_`)];

/** Gimmick type → behaviour file name (actsName_) from GimmickModelParam.json. ParseActsNames. */
export function parseActsNames(text) {
  const d = new Map();
  if (!text) return d;
  for (const m of text.matchAll(/\n\t"([^"\n]+)"\s*:\s*\{([\s\S]*?)\n\t\}/g)) {
    const a = /"actsName_"\s*:\s*"([^"]+)"/.exec(m[2]);
    if (a) d.set(m[1], a[1]);
  }
  return d;
}

/** Every trap shape a behaviour file registers, with the action it is in. ParseTrapZones. */
export function parseTrapZones(acts) {
  const list = [];
  if (!acts) return list;
  const actions = [...acts.matchAll(/"([^"\n]+)"\s*:\s*\[/g)];
  for (const m of acts.matchAll(/\{[^{}]*"@class"\s*:\s*"command::Trap(Sphere|Box|Cylinder|Capsule)"[^{}]*\}/g)) {
    const f = flatFields(m[0]), shape = m[1];
    const z = {
      shape, name: f.get('name_') ?? '', kind: f.get('kind_') ?? null, team: f.get('team_') ?? null,
      action: actions.filter((a) => a.index < m.index).at(-1)?.[1] ?? null, radius: fieldFloat(f, 'radius_'),
      a: [0, 0, 0], b: [0, 0, 0],
    };
    if (shape === 'Sphere' || shape === 'Box') z.a = fieldVec(f, 'center');
    if (shape === 'Box') z.b = fieldVec(f, 'extent');
    if (shape === 'Cylinder' || shape === 'Capsule') {
      z.a = fieldVec(f, 'from');
      z.b = fieldVec(f, 'to');
    }
    list.push(z);
  }
  return list;
}

/** The collisionEntries_ of a stage gimmick table (empty when it has none). ParseStageVolumes. */
export function parseStageVolumes(table) {
  const sec = table == null ? null : findSection(table, SECTION);
  if (!sec) return [];
  return jsonEntries(table, sec.open, sec.close).map((e) => {
    const f = flatFields(table.slice(e.open, e.close + 1)), type = f.get('type_') ?? '';
    return {
      name: e.key, signature: f.get('signature_') ?? '', type, isBox: type.toUpperCase() === 'BOX', isSphere: type.toUpperCase() === 'SPHERE',
      radius: fieldFloat(f, 'radius_'), pos: fieldVec(f, 'pos'), width: fieldVec(f, 'width'), rot: fieldVec(f, 'rot'), trans: fieldVec(f, 'trans'),
    };
  });
}

/**
 * Trap zones by gimmick type, from the Data folder's json/gimmick (types with none are left out). A file that is
 * missing or can't be read gives no zones, as on the desktop. dataFiles(folder) lists a Data folder's files.
 */
export async function readTrapZones(dataFiles) {
  const byName = new Map((dataFiles?.('json/gimmick') ?? []).map((f) => [f.name.toLowerCase(), f]));
  const text = async (name) => {
    const f = byName.get(name.toLowerCase());
    if (!f) return null;
    try {
      return new TextDecoder('utf-8').decode((await decodeLayers(await f.read())).payload);
    } catch {
      return null;
    }
  };
  const out = new Map(), byActs = new Map();
  for (const [type, acts] of parseActsNames(await text('GimmickModelParam.json'))) {
    const k = acts.toLowerCase();
    if (!byActs.has(k)) byActs.set(k, parseTrapZones(await text(`${acts}.json`)));
    if (byActs.get(k).length) out.set(type, byActs.get(k));
  }
  return out;
}

// ---------- frames and shapes ----------

const apply = (f, p) => {
  const M = f.M;
  return [M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + f.T[0], M[3] * p[0] + M[4] * p[1] + M[5] * p[2] + f.T[1], M[6] * p[0] + M[7] * p[1] + M[8] * p[2] + f.T[2]];
};
const axis = (f, k) => [f.M[k], f.M[3 + k], f.M[6 + k]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => scale(a, 1 / (length(a) || 1));

/** A collision entry's frame as the table has it: its turn, then trans_. */
export const volumeFrame = (v) => ({ M: rotation(v.rot), T: v.trans.slice() });
/** A trap's frame in the world: its gimmick's turn, then its position. GimmickFrame. */
export const gimmickFrame = (position, rot) => ({ M: rotation(rot), T: position.slice() });
/** A frame carried by an object's placement (state st about pivot pv), as the object's vertices are (placePoint). */
export function carried(f, st, pv) {
  const R = rotation(st.r), s = st.s, M = f.M, RS = R.map((x, i) => x * s[i % 3]);
  const m = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[r * 3 + c] = RS[r * 3] * M[c] + RS[r * 3 + 1] * M[3 + c] + RS[r * 3 + 2] * M[6 + c];
  const d = sub(f.T, pv), q = [0, 1, 2].map((r) => RS[r * 3] * d[0] + RS[r * 3 + 1] * d[1] + RS[r * 3 + 2] * d[2]);
  return { M: m, T: [q[0] + pv[0] + st.t[0], q[1] + pv[1] + st.t[1], q[2] + pv[2] + st.t[2]] };
}
/** How much a frame scales (its first axis's length; objects scale evenly). FrameScale. */
export const frameScale = (f) => length(axis(f, 0));

const BOX_CORNERS = [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]];
const BOX_EDGES = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
/** A box's 8 corners in the world (centre and half size in the frame). BoxWorld. */
const boxWorld = (centre, half, f) => BOX_CORNERS.map((c) => apply(f, [centre[0] + c[0] * half[0], centre[1] + c[1] * half[1], centre[2] + c[2] * half[2]]));

/** Unit vectors perpendicular to an axis. Perpendiculars. */
function perpendiculars(ax) {
  const a = ax[0] * ax[0] + ax[1] * ax[1] + ax[2] * ax[2] > 1e-6 ? unit(ax) : [0, 1, 0];
  const u = unit(cross(a, Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  return [u, cross(a, u)];
}

// Line builders: each adds x, y, z per line end to out.
const line = (out, p, q) => out.push(p[0], p[1], p[2], q[0], q[1], q[2]);
function circle(out, o, u, v, r, seg = 32) {
  const at = (i) => {
    const a = (2 * Math.PI * i) / seg;
    return add(o, add(scale(u, r * Math.cos(a)), scale(v, r * Math.sin(a))));
  };
  for (let i = 0; i < seg; i++) line(out, at(i), at(i + 1));
}
function wireBox(out, c) {
  for (let i = 0; i < BOX_EDGES.length; i += 2) line(out, c[BOX_EDGES[i]], c[BOX_EDGES[i + 1]]);
}
function wireSphere(out, o, r, f) {
  const x = axis(f, 0), y = axis(f, 1), z = axis(f, 2);
  circle(out, o, x, z, r);
  circle(out, o, x, y, r);
  circle(out, o, y, z, r);
}
function wireCylinder(out, a, b, r) {
  const [u, v] = perpendiculars(sub(b, a));
  circle(out, a, u, v, r);
  circle(out, b, u, v, r);
  for (let i = 0; i < 4; i++) {
    const t = (Math.PI * i) / 2, d = add(scale(u, r * Math.cos(t)), scale(v, r * Math.sin(t)));
    line(out, add(a, d), add(b, d));
  }
}

/** A trap's outline in the world (lines into out); returns the point its label goes above. DrawTrap. */
export function trapLines(out, z, f) {
  if (z.shape === 'Box') {
    wireBox(out, boxWorld(z.a, z.b, f));
    return apply(f, [z.a[0], z.a[1] + z.b[1], z.a[2]]);
  }
  if (z.shape === 'Cylinder' || z.shape === 'Capsule') {
    const a = apply(f, z.a), b = apply(f, z.b);
    wireCylinder(out, a, b, z.radius);
    const top = a[1] > b[1] ? a : b;
    return [top[0], top[1] + (z.shape === 'Capsule' ? z.radius : 0), top[2]];
  }
  const o = apply(f, z.a);
  wireSphere(out, o, z.radius, f);
  return [o[0], o[1] + z.radius, o[2]];
}

/** A collision entry's outline in the world. */
export function volumeLines(out, v, f) {
  if (v.isBox) wireBox(out, boxWorld(v.pos, scale(v.width, 0.5), f));
  else wireSphere(out, apply(f, v.pos), v.radius, f);
}

/** The world box around a collision entry in a frame. StageVolumeBounds. */
export function volumeBounds(v, f) {
  if (v.isSphere) {
    const o = apply(f, v.pos), r = v.radius * frameScale(f);
    return { min: o.map((x) => x - r), max: o.map((x) => x + r) };
  }
  const c = boxWorld(v.pos, scale(v.width, 0.5), f);
  return { min: [0, 1, 2].map((k) => Math.min(...c.map((p) => p[k]))), max: [0, 1, 2].map((k) => Math.max(...c.map((p) => p[k]))) };
}

/**
 * The object a collision entry belongs to, or null: the smallest (x × z) of the candidates ({ o, b }: a movable stage
 * object and its box as built) whose box holds the entry's whole footprint at its height. Rainbow's FlatA pillar is
 * the collision of the tree it stands in. FindStageVolumeOwner; the caller leaves out the sky, gimmicks and pieces too
 * big to pick up.
 */
export function ownerOf(v, candidates) {
  const { min: lo, max: hi } = volumeBounds(v, volumeFrame(v));
  const cy = (lo[1] + hi[1]) / 2;
  let best = null, bestArea = Infinity;
  for (const { o, b } of candidates) {
    if (lo[0] < b.min[0] || hi[0] > b.max[0] || lo[2] < b.min[2] || hi[2] > b.max[2] || cy < b.min[1] - 100 || cy > b.max[1] + 100) continue;
    const area = (b.max[0] - b.min[0]) * (b.max[2] - b.min[2]);
    if (area < bestArea) [best, bestArea] = [o, area];
  }
  return best;
}

// ---------- names, colours and text ----------

const KIND_NAMES = {
  CastleGateOpen: 'Gate opens', LaunchPad: 'Launch pad', BatteringRamPutMaterials: 'Ram: hand in materials', BombStoneRide: 'Bomb stone: climb on',
  QuetzalRide: 'Quetzal: ride', TornadoWindUp: 'Tornado updraft', Capture: 'Capture', Sanctuary: 'Sanctuary', WindTrap: 'Wind trap', CyclonenTrap: 'Cyclone trap',
};
/** A trap kind's name for people. TrapKindName. */
export const trapKindName = (kind) => (kind && Object.hasOwn(KIND_NAMES, kind) ? KIND_NAMES[kind] : (kind ?? 'Trap').replace(/(?<=[a-z])(?=[A-Z])/g, ' '));
const KIND_COLOURS = {
  CastleGateOpen: [0.35, 1, 0.45], LaunchPad: [1, 0.6, 0.2], BatteringRamPutMaterials: [1, 0.9, 0.3], BombStoneRide: [1, 0.4, 0.35], QuetzalRide: [0.45, 0.8, 1], TornadoWindUp: [0.3, 1, 1],
};
/** A trap kind's colour (0–1 each). TrapKindColour. */
export const trapKindColour = (kind) => (Object.hasOwn(KIND_COLOURS, kind ?? '') ? KIND_COLOURS[kind] : [0.8, 0.6, 1]);
export const VOLUME_COLOUR = [1, 0.3, 0.85];
export const cssColour = (c) => `rgb(${c.map((x) => Math.trunc(x * 255)).join(' ')})`;

/** Centimetres as metres, "0.##". */
export const metres = (cm) => String(Math.round((cm / 100) * 100) / 100);
/** DescribeStageVolume. */
export const describeVolume = (v) =>
  v.isBox ? `box ${metres(v.width[0])} × ${metres(v.width[1])} × ${metres(v.width[2])} m` : `sphere ${metres(v.radius * 2)} m across`;
/** A trap's size for the zone list. */
export const describeTrap = (z) =>
  z.shape === 'Box' ? `${metres(z.b[0] * 2)} × ${metres(z.b[1] * 2)} × ${metres(z.b[2] * 2)} m box`
    : z.shape === 'Sphere' ? `${metres(z.radius)} m radius` : `${metres(z.radius)} m radius, ${metres(length(sub(z.b, z.a)))} m tall`;

// ---------- the edited table ----------

/**
 * A record placed by a new frame (the table's frame carried by its object's move): trans_ is the frame's origin, rot_
 * its turn (X, then Y, then Z, as the game builds it), and a scaled object scales the shape (pos_, width_ / radius_).
 * Other fields are kept as they were. MovedStageVolumeRecord.
 */
export function movedVolumeRecord(record, v, f) {
  const s = frameScale(f), rot = eulerOf(f.M.map((x) => x / s));
  ['X', 'Y', 'Z'].forEach((a, k) => {
    record = setJsonField(record, `trans${a}_`, num(f.T[k]));
  });
  ['X', 'Y', 'Z'].forEach((a, k) => {
    record = setJsonField(record, `rot${a}_`, num(rot[k]));
  });
  if (Math.abs(s - 1) > 1e-4) {
    if (v.pos.some((x) => x !== 0) || record.includes('"posX_"')) ['X', 'Y', 'Z'].forEach((a, k) => (record = setJsonField(record, `pos${a}_`, num(v.pos[k] * s))));
    if (v.isSphere) record = setJsonField(record, 'radius_', num(v.radius * s));
    else ['X', 'Y', 'Z'].forEach((a, k) => (record = setJsonField(record, `width${a}_`, num(v.width[k] * s))));
  }
  return record;
}

/**
 * A gimmick table's text with each collisionEntries_ record passed through edit(name, record) → its new text, or
 * null to leave it out; the same text when nothing changes. RewriteStageVolumes.
 */
export function rewriteStageVolumes(table, edit) {
  const sec = table == null ? null : findSection(table, SECTION);
  if (!sec) return table;
  const { open, close } = sec;
  const entries = jsonEntries(table, open, close).sort((a, b) => a.open - b.open);
  if (!entries.length) return table;
  // Each record's text runs from just after the comma before it (the first: from the brace) to its own brace, so the
  // kept ones joined with commas are the section as it was, minus the left-out ones.
  const kept = [];
  let changed = false, from = open + 1;
  for (const e of entries) {
    const record = table.slice(e.open, e.close + 1), now = edit(e.key, record);
    if (now != null) kept.push(table.slice(from, e.open) + now);
    if (now !== record) changed = true;
    let k = e.close + 1;
    while (k < close && /\s/.test(table[k])) k++;
    from = k < close && table[k] === ',' ? k + 1 : e.close + 1;
  }
  if (!changed) return table;
  const last = entries.at(-1).close + 1;
  return table.slice(0, open + 1) + kept.join(',') + table.slice(last, close).replace(/^(\s*),/, '$1') + table.slice(close);
}

/** The names a "stagevolumes" feature removes. */
export const removedFromFeature = (f) => new Set(Array.isArray(f?.Removed) ? f.Removed.filter((n) => typeof n === 'string') : []);
/** The "stagevolumes" feature for the removed names (sorted ordinal, as the desktop writes them); null when none. */
export const volumesFeature = (removed) => (removed?.size ? { Removed: [...removed].sort() } : null);
