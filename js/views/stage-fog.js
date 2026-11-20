// The stage's distance fog, ported from HappyTool/GUI/StageViewerForm.Fog.cs. Every stage's StageCameraParam.json
// carries the fog the game draws: fogEnable, fogNear / fogFar (cm: clear before, full colour from there) and fogColor
// (0x00BBGGRR). The map view can show it, change it or take another stage's; the download writes the four values into
// the bundle's own StageCameraParam.json with every other line kept as the game wrote it. Height fog is left alone.

import { decodeLayers } from '../formats/wrappers.js';
import { parseBres } from '../formats/bres.js';
import { parseGameJson } from '../formats/json.js';

const CAMERA_PARAM = /StageCameraParam\.json$/i;
const f32 = Math.fround;

/** One fog setting: {Enable, Near, Far, Color}, the desktop sidecar's "fog" feature shape. */
export const makeFog = (enable, near, far, color) => ({ Enable: !!enable, Near: f32(near), Far: f32(far), Color: Math.trunc(color) });
export const sameFog = (a, b) => !!a && !!b && a.Enable === b.Enable && a.Near === b.Near && a.Far === b.Far && a.Color === b.Color;
export const fogRgb = (f) => [f.Color & 0xff, (f.Color >> 8) & 0xff, (f.Color >> 16) & 0xff];
export const fogHex = (f) => '#' + fogRgb(f).map((v) => v.toString(16).padStart(2, '0')).join('');
/** The fog with its colour from "#rrggbb", the top byte kept (WithRgb). */
export function withHex(f, hex) {
  const v = parseInt(hex.slice(1), 16);
  const r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
  return makeFog(f.Enable, f.Near, f.Far, (f.Color - (f.Color % 0x1000000)) + ((b << 16) | (g << 8) | r));
}
export const metres = (cm) => `${Math.round(cm / 100)} m`;
/** The edits file's "fog" feature (the desktop's FogEdit) as a fog, or null when it isn't one. */
export function fogFromFeature(f) {
  if (!f || typeof f !== 'object' || ![f.Near, f.Far, f.Color].every((v) => v !== null && v !== '' && Number.isFinite(Number(v)))) return null;
  return makeFog(f.Enable ?? true, Number(f.Near), Number(f.Far), Number(f.Color));
}

/** The fog in a camera file's text, or null when it has none (ParseFog). */
export function parseFog(text) {
  try {
    const cam = parseGameJson(text).value?.jsonStageCamera;
    if (!cam || cam.fogNear == null || cam.fogFar == null || cam.fogColor == null) return null;
    return makeFog(cam.fogEnable ?? true, Number(cam.fogNear), Number(cam.fogFar), Number(cam.fogColor));
  } catch {
    return null;
  }
}

const cameraEntry = (arc) => arc.entries.find((e) => CAMERA_PARAM.test(e.name || ''));
const textOf = async (e) => (e && !e.pointer && e.data?.length ? new TextDecoder().decode((await decodeLayers(e.data)).payload) : null);

/** The fog in a parsed bundle, or null (ReadFog). */
export async function readFog(arc) {
  const text = await textOf(cameraEntry(arc));
  return text == null ? null : parseFog(text);
}

/** The fog in a stage bundle file's bytes, or null. */
export async function readFogFromFile(fileBytes) {
  return readFog(parseBres((await decodeLayers(fileBytes)).payload));
}

/** The camera file with only the four fog values replaced, the rest kept as it was (WriteFog). */
export function writeFog(text, fog) {
  const set = (s, key, value) => {
    const re = new RegExp(`("${key}"\\s*:\\s*)(true|false|-?[0-9][0-9.]*(?:[eE][-+]?[0-9]+)?)`);
    if (!re.test(s)) throw new Error(`${key} is missing from StageCameraParam.json.`);
    return s.replace(re, (_, head) => head + value);
  };
  text = set(text, 'fogEnable', fog.Enable ? 'true' : 'false');
  text = set(text, 'fogNear', fog.Near.toFixed(6));
  text = set(text, 'fogFar', fog.Far.toFixed(6));
  return set(text, 'fogColor', String(fog.Color));
}

/** A copy of the archive with the fog written into its StageCameraParam.json (FogExport); returns {archive, summary}. */
export async function bakeFog(arc, fog) {
  const at = arc.entries.findIndex((e) => CAMERA_PARAM.test(e.name || ''));
  if (at < 0) throw new Error('StageCameraParam.json is missing from the bundle.');
  const old = await textOf(arc.entries[at]);
  if (old == null) throw new Error(`${arc.entries[at].name} can't be read.`);
  const text = writeFog(old, fog);
  if (!sameFog(parseFog(text), fog)) throw new Error(`${arc.entries[at].name}: the fog did not read back.`);
  const data = new TextEncoder().encode(text);
  const entries = arc.entries.slice();
  entries[at] = { ...entries[at], pointer: false, size: data.length, data };
  return { archive: { ...arc, entries }, summary: `Fog: ${fog.Enable ? `${metres(fog.Near)} to ${metres(fog.Far)}` : 'off'}.` };
}

// Whether the fog is drawn in the view: an editor setting, as on the desktop (FogPreview).
const PREVIEW_KEY = 'happytool-web-fog-preview';
export const fogPreviewOn = () => localStorage.getItem(PREVIEW_KEY) === '1';
export function setFogPreview(on) {
  try {
    localStorage.setItem(PREVIEW_KEY, on ? '1' : '0');
  } catch {
    /* kept for this page only */
  }
}
