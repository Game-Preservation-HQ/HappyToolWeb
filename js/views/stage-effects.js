// The stage's effects and sounds: its effect table Data/json/stage/<id>_stage_effect.json, the particle effects
// effectArrangeParam_ places (by effect tag) and the sound emitters of effectPlaySeParam_ (a sound cue heard within its
// range). Port of the desktop's StageViewerForm.Effects: reading the table, the edits file's "effects" feature (the ones
// moved by hand), the markers drawn for them and the table with the moved numbers, every other byte as it was.

import { decodeLayers, encodeLayers } from '../formats/wrappers.js';
import { bytesEqual, decodeText, encodeText } from '../util.js';
import { findSection, jsonEntries, jsonFields, setJsonField } from './stage-gimmicks.js';

export const EFFECTS_KEY = 'effects';
const EFFECT_SECTION = 'effectArrangeParam_', SOUND_SECTION = 'effectPlaySeParam_';
const AXES = { effect: ['effectTransX_', 'effectTransY_', 'effectTransZ_'], sound: ['playPosX_', 'playPosY_', 'playPosZ_'] };
export const EFFECT_COLOUR = [1, 0.62, 0.2], SOUND_COLOUR = [0.4, 0.95, 0.75];
export const FILTERS = ['Effects and sounds', 'Effects', 'Sounds'];
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const lower = (s) => (s ? s.toLowerCase() : s);

// ---------- the table's text ----------

const fromLatin1 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return s;
};
const toLatin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** The table's text and how it writes back: as decodeText reads it when that writes back byte for byte (Shift-JIS
 *  comments), else one character per byte (its names and numbers are ASCII), so every byte not edited stays. */
function tableText(plain) {
  const d = decodeText(plain);
  if (bytesEqual(encodeText(d.text, d.encoding), plain)) return d;
  return { text: fromLatin1(plain), encoding: 'latin1' };
}
const textBytes = (text, encoding) => (encoding === 'latin1' ? toLatin1(text) : encodeText(text, encoding));

/**
 * The records that have a position (all three numbers), effects first (EffectRecords): {kind, key, id, open, close,
 * literals, position, fields}. The id is "fx:"/"se:" + key, with "#n" for the nth record of a repeated key.
 */
export function readEffectRecords(text) {
  const out = [];
  for (const kind of ['effect', 'sound']) {
    const sec = findSection(text, kind === 'sound' ? SOUND_SECTION : EFFECT_SECTION);
    if (!sec) continue;
    const seen = new Map();
    for (const e of jsonEntries(text, sec.open, sec.close)) {
      const n = (seen.get(e.key) ?? 0) + 1;
      seen.set(e.key, n);
      const fields = jsonFields(text.slice(e.open, e.close + 1));
      const literals = AXES[kind].map((a) => fields.get(a));
      if (!literals.every((v) => v != null && NUMBER.test(v))) continue;
      out.push({
        kind, key: e.key, id: (kind === 'sound' ? 'se:' : 'fx:') + e.key + (n > 1 ? `#${n}` : ''), open: e.open, close: e.close,
        literals, position: literals.map((v) => Math.fround(parseFloat(v))), fields,
      });
    }
  }
  return out;
}

/** An effect or sound as the panel and the markers use it. */
function effectOf(r) {
  const num = (k, d) => {
    const v = r.fields.get(k);
    return v != null && NUMBER.test(v) ? parseFloat(v) : d;
  };
  const e = { kind: r.kind, key: r.key, id: r.id, position: r.position };
  if (r.kind === 'effect') Object.assign(e, { name: r.fields.get('effectTag_') ?? null, scale: num('effectScale_', 1), group: Math.trunc(num('groupID_', 0)) });
  else Object.assign(e, { name: r.fields.get('seName_') ?? null, range: Math.fround(num('playRange_', 0)), volume: num('playVolume_', 1) });
  return e;
}

/** Its name, else its record's key (EffectName). */
export const effectName = (e) => e.name || e.key;

/**
 * The stage's effect table (LoadEffects): the first of ids with one in json/stage. Returns {name, path, layers, text,
 * encoding, tll, effects, log} or null (no table, or one with no effect or sound that has a position).
 */
export async function loadEffectTable({ ids, dataFiles }) {
  const tables = dataFiles('json/stage');
  let file = null;
  for (const id of ids) if (id && (file = tables.find((f) => lower(f.name) === lower(`${id}_stage_effect.json`)))) break;
  if (!file) return null;
  const d = await decodeLayers(await file.read());
  const { text, encoding } = tableText(d.payload);
  const effects = readEffectRecords(text).map(effectOf);
  const n = effects.filter((e) => e.kind === 'effect').length;
  const log = `effects: ${n} effects and ${effects.length - n} sounds in ${file.name}`;
  if (!effects.length) return null;
  const tll = text.slice(0, 512).includes('Serialize by tll::json::Serializer');
  return { name: file.name, path: file.path, layers: d.layers, text, encoding, tll, effects, log };
}

// ---------- the edits file's "effects" feature: {Moved: {id: [x, y, z]}} ----------

/** The moved ones (id → [x, y, z]); entries that aren't three numbers are dropped. */
export function movedFromFeature(f) {
  const out = new Map();
  const m = f && typeof f === 'object' && !Array.isArray(f) ? f.Moved : null;
  if (m && typeof m === 'object' && !Array.isArray(m))
    for (const [id, p] of Object.entries(m)) if (Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)) out.set(id, p.slice());
  return out;
}
export function effectsFeature(moved) {
  if (!moved?.size) return null;
  const o = {};
  for (const id of [...moved.keys()].sort()) o[id] = moved.get(id).slice();
  return { Moved: o };
}

// ---------- the moved table (MoveEffects) ----------

/** Math.Round(v, 2), to even as .NET rounds. */
function round2(v) {
  const x = v * 100;
  let r = Math.round(x);
  if (r - x === 0.5 && r % 2 !== 0) r -= 1;
  return r / 100;
}
/** FormatPlain: "0" for zero, else the shortest form that reads back, never with an exponent. */
function plain(v) {
  if (v === 0) return '0';
  const s = String(v);
  return /e/i.test(s) ? v.toFixed(20).replace(/\.?0+$/, '') : s;
}
/** A changed number written like the one it replaces (FormatNumberLikeOriginal). */
export function formatLike(v, literal, tll = false) {
  const lit = literal.trim();
  if (Number.isInteger(v) && /^[-+]?\d+$/.test(lit)) return String(v === 0 ? 0 : v);
  const dec = /[eE]/.test(lit) ? 0 : (/\.(\d+)/.exec(lit)?.[1].length ?? 0);
  if (tll && dec > 0) return v.toFixed(dec);
  return plain(v);
}

/**
 * The table with the moved ones' numbers: place(e) is where one is now ([x, y, z]) or null to leave it. Only a number
 * that changes by more than half a centimetre is rewritten: the change added to the number as written, to the
 * hundredth. Returns {text, effects, sounds}, or null when nothing moved. Throws when it doesn't read back.
 */
export function movedEffectTable(table, place) {
  const recs = readEffectRecords(table.text).sort((a, b) => a.open - b.open);
  let out = '', at = 0, effects = 0, sounds = 0;
  const want = new Map();
  for (const r of recs) {
    const to = place(r);
    if (!to) continue;
    let record = table.text.slice(r.open, r.close + 1), moved = false;
    const values = r.literals.map((v) => parseFloat(v));
    for (let k = 0; k < 3; k++) {
      const d = Math.fround(Math.fround(to[k]) - r.position[k]);
      if (!(Math.abs(d) > 0.5)) continue;
      const v = round2(parseFloat(r.literals[k]) + d);
      moved = true;
      if (v === parseFloat(r.literals[k])) continue;
      record = setJsonField(record, AXES[r.kind][k], formatLike(v, r.literals[k], table.tll));
      values[k] = v;
    }
    if (!moved) continue;
    if (r.kind === 'sound') sounds++;
    else effects++;
    want.set(r.id, values);
    out += table.text.slice(at, r.open) + record;
    at = r.close + 1;
  }
  if (!effects && !sounds) return null;
  const text = out + table.text.slice(at);
  // Reads back with the same records, the moved ones at their new numbers.
  const back = readEffectRecords(text);
  const bad = back.length !== recs.length ||
    back.some((r) => {
      const w = want.get(r.id);
      return w ? r.literals.some((v, k) => Math.abs(parseFloat(v) - w[k]) > 0.005) : !recs.some((q) => q.id === r.id);
    });
  if (bad) throw new Error('The edited effect table did not read back.');
  return { text, effects, sounds };
}

/** The table's file bytes, wrapped as it was (BFBR / ZRES) and read back (EncodeEffectTable). */
export async function effectTableBytes(table, text) {
  const raw = textBytes(text, table.encoding);
  const bytes = table.layers?.length ? await encodeLayers(raw, table.layers) : raw;
  if (!bytesEqual((await decodeLayers(bytes)).payload, raw)) throw new Error(`${table.name} did not read back.`);
  return bytes;
}

// ---------- markers (EffectMarkerLines, SoundRing) ----------

export const postOf = (e) => (e.kind === 'sound' ? 220 : 140);

/** An effect: a cross where it plays on a short post, a small diamond on top. A sound: a taller post, a small cross at its foot. */
export function markerLines(out, e, p) {
  const post = postOf(e), arm = e.kind === 'sound' ? 30 : 60;
  const seg = (a, b) => out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  const [x, y, z] = p;
  seg([x, y, z], [x, y + post, z]);
  seg([x - arm, y, z], [x + arm, y, z]);
  seg([x, y, z - arm], [x, y, z + arm]);
  if (e.kind === 'effect') {
    const t = y + post, r = 25;
    seg([x - r, t, z], [x, t + r, z]);
    seg([x, t + r, z], [x + r, t, z]);
    seg([x + r, t, z], [x, t - r, z]);
    seg([x, t - r, z], [x - r, t, z]);
  }
}
/** A sound's range: a ring of 48 at its height (+10). */
export function rangeRing(out, p, range) {
  for (let i = 0; i < 48; i++) {
    const a = (i * Math.PI * 2) / 48, b = ((i + 1) * Math.PI * 2) / 48;
    out.push(p[0] + Math.cos(a) * range, p[1] + 10, p[2] + Math.sin(a) * range, p[0] + Math.cos(b) * range, p[1] + 10, p[2] + Math.sin(b) * range);
  }
}

/** 0.# as .NET formats it. */
export const oneDecimal = (v) => String(Math.round(v * 10) / 10);
/** Its long description (EffectDescription), at p now. */
export function describeEffect(e, p, moved) {
  let s = e.kind === 'sound'
    ? `Sound ${e.name ?? '?'} · heard within ${oneDecimal(e.range / 100)} m · volume ${Math.round(e.volume * 100) / 100}`
    : `Effect ${e.name ?? '?'} · scale ${Math.round(e.scale * 100) / 100} · group ${e.group}`;
  s += `\nAt ${p.map((x) => x.toFixed(0)).join(', ')} (record ${e.key})`;
  if (moved) s += ` · moved by hand from ${e.position.map((x) => x.toFixed(0)).join(', ')}`;
  return s;
}
