// The play test's warrior avatar, ported from HappyTool/GUI/StageViewerForm.PlayAvatar.cs (LoadAvatar, RoundOff,
// ReadActionScript, ReadAvatarNumbers, ReadAvatarLook, ArmAvatar, AvatarWear, DressAvatarHead, AvatarItemModel,
// AvatarBundleOf, ComposeTinted, Unturn) and PlayerMotionPreviewAssets.TryLoadPart. The body is skinned on the Steam
// skeleton; the face, hair, head item, sword and shield are rigid parts on the Head / RightWeapon / LeftWeapon bones.
// `.rmd` (Xbox) models aren't read, so a part that only has one is left off.

import { decodeLayers } from './wrappers.js';
import { parseBres } from './bres.js';
import { parseRrm } from './rrm.js';
import { decodeDds } from './dds.js';
import { parseGameJson } from './json.js';
import { parseRra } from './rra.js';
import { skinnedModel } from './skin.js';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const HEAD = 'Head', WEAPON = 'RightWeapon', SHIELD = 'LeftWeapon';
const HEAD_MODEL = 'cmon000', BODY_MODEL = 'cbod000', WEAPON_MODEL = 'cwea000', SHIELD_MODEL = 'cshi000';

const baseName = (n) => String(n ?? '').replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
const extOf = (n) => (String(n ?? '').match(/\.[^.\\/]*$/)?.[0] ?? '').toLowerCase();
const pad = (n, d) => String(n).padStart(d, '0');

/** The desktop's PlayAvatar numbers before the game's files are read (its field defaults). */
const DEFAULTS = {
  turnSpeed: 880, attackTurnSpeed: 750, guardSpeedRate: 0.45, attackSpeedRate: 0.5, fallDistance: 125,
  fallDamageDistance: 1010, fallDamageDistanceMax: 6200, fallDamageHp: 20, fallDamageHpMax: 200, fallDieY: -7000,
  respawnHpPer: 25, moveSpeed: 850, hpMax: 80,
};

/** RoundOff: PN triangles, each triangle split `steps` times along an edge onto the curved patch its normals make. */
export function roundOff(mesh, steps) {
  const P = mesh.positions, N = mesh.normals, T = mesh.uvs, idx = mesh.indices;
  const vc = Math.floor(P.length / 3);
  if (steps < 2 || !N || N.length < vc * 3) return mesh;
  const hasUv = T && T.length >= vc * 2;
  const pos = [], nrm = [], uv = [], ind = [];
  const v3 = (a, i) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
  const edge = (pa, pb, na) => {
    const d = (pb[0] - pa[0]) * na[0] + (pb[1] - pa[1]) * na[1] + (pb[2] - pa[2]) * na[2];
    return [0, 1, 2].map((k) => (2 * pa[k] + pb[k] - d * na[k]) / 3);
  };
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const i1 = idx[t], i2 = idx[t + 1], i3 = idx[t + 2];
    if (i1 >= vc || i2 >= vc || i3 >= vc) continue;
    const p1 = v3(P, i1), p2 = v3(P, i2), p3 = v3(P, i3);
    const ax = p2[0] - p1[0], ay = p2[1] - p1[1], az = p2[2] - p1[2];
    const bx = p3[0] - p1[0], by = p3[1] - p1[1], bz = p3[2] - p1[2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    if (cx * cx + cy * cy + cz * cz < 1e-12) continue;
    const n1 = v3(N, i1), n2 = v3(N, i2), n3 = v3(N, i3);
    const b210 = edge(p1, p2, n1), b120 = edge(p2, p1, n2), b021 = edge(p2, p3, n2);
    const b012 = edge(p3, p2, n3), b102 = edge(p3, p1, n3), b201 = edge(p1, p3, n1);
    const b111 = [0, 1, 2].map((k) => {
      const e = (b210[k] + b120[k] + b021[k] + b012[k] + b102[k] + b201[k]) / 6;
      const mid = (p1[k] + p2[k] + p3[k]) / 3;
      return e + (e - mid) / 2;
    });
    const first = pos.length / 3;
    for (let r = 0; r <= steps; r++) {
      for (let c = 0; c <= r; c++) {
        const u = (r - c) / steps, v = c / steps, w = 1 - u - v;
        for (let k = 0; k < 3; k++) {
          pos.push(
            p1[k] * w * w * w + p2[k] * u * u * u + p3[k] * v * v * v
            + 3 * b210[k] * w * w * u + 3 * b120[k] * w * u * u + 3 * b201[k] * w * w * v
            + 3 * b021[k] * u * u * v + 3 * b102[k] * w * v * v + 3 * b012[k] * u * v * v + 6 * b111[k] * w * u * v,
          );
        }
        let nx = n1[0] * w + n2[0] * u + n3[0] * v, ny = n1[1] * w + n2[1] * u + n3[1] * v, nz = n1[2] * w + n2[2] * u + n3[2] * v;
        const l = Math.hypot(nx, ny, nz);
        if (l > 0) (nx /= l), (ny /= l), (nz /= l);
        nrm.push(nx, ny, nz);
        if (hasUv) uv.push(T[i1 * 2] * w + T[i2 * 2] * u + T[i3 * 2] * v, T[i1 * 2 + 1] * w + T[i2 * 2 + 1] * u + T[i3 * 2 + 1] * v);
      }
    }
    const at = (r, c) => first + (r * (r + 1)) / 2 + c;
    for (let r = 0; r < steps; r++) {
      for (let c = 0; c <= r; c++) {
        ind.push(at(r, c), at(r + 1, c), at(r + 1, c + 1));
        if (c < r) ind.push(at(r, c), at(r + 1, c + 1), at(r, c + 1));
      }
    }
  }
  if (!ind.length) return mesh;
  return { positions: new Float32Array(pos), indices: new Uint32Array(ind), uvs: hasUv ? new Float32Array(uv) : null, normals: new Float32Array(nrm) };
}

/**
 * ComposeTinted: a grey picture overlay-blended with a tint, then each layer (a picture at a pixel offset, scaled to
 * the output) painted over by its alpha. The output is as big as the biggest picture; its alpha is the grey's.
 * Pictures are { width, height, rgba } as decodeDds returns them.
 */
export function composeTinted(grey, tint, layers) {
  if (!grey) return null;
  const sw = grey.width, sh = grey.height, src = grey.rgba;
  let w = sw, h = sh;
  for (const l of layers) (w = Math.max(w, l.picture.width)), (h = Math.max(h, l.picture.height));
  const out = new Uint8ClampedArray(w * h * 4);
  const at = (x, y) => (((((y % sh) + sh) % sh) * sw + (((x % sw) + sw) % sw)) * 4);
  const overlay = (t, c) => (c < 0.5 ? 2 * t * c : 1 - 2 * (1 - t) * (1 - c));
  const byte = (f) => Math.max(0, Math.min(255, Math.trunc(f * 255 + 0.5)));
  const b = [0, 0, 0, 0], col = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = ((x + 0.5) / w) * sw - 0.5, v = ((y + 0.5) / h) * sh - 0.5;
      const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
      const a00 = at(x0, y0), a10 = at(x0 + 1, y0), a01 = at(x0, y0 + 1), a11 = at(x0 + 1, y0 + 1);
      for (let k = 0; k < 4; k++) {
        const top = src[a00 + k] / 255 + (src[a10 + k] / 255 - src[a00 + k] / 255) * fx;
        const bottom = src[a01 + k] / 255 + (src[a11 + k] / 255 - src[a01 + k] / 255) * fx;
        b[k] = top + (bottom - top) * fy;
      }
      for (let k = 0; k < 3; k++) col[k] = overlay(b[k], tint[k]);
      for (const l of layers) {
        const lw = l.picture.width, lh = l.picture.height;
        const lx = Math.floor((x * lw) / w) - l.x, ly = Math.floor((y * lh) / h) - l.y;
        if (lx < 0 || ly < 0 || lx >= lw || ly >= lh) continue;
        const p = (ly * lw + lx) * 4, px = l.picture.rgba, a = px[p + 3] / 255;
        for (let k = 0; k < 3; k++) col[k] += (px[p + k] / 255 - col[k]) * a;
      }
      const o = (y * w + x) * 4;
      out[o] = byte(col[0]);
      out[o + 1] = byte(col[1]);
      out[o + 2] = byte(col[2]);
      out[o + 3] = byte(b[3]);
    }
  }
  return { width: w, height: h, rgba: out };
}

/** Unturn: the inverse of a bind matrix's rotation (OpenTK ExtractRotation: each row normalised), as a column-major matrix. */
export function unturn(bindWorld) {
  const m = new Float32Array(16);
  m[15] = 1;
  for (let c = 0; c < 3; c++) {
    const l = Math.hypot(bindWorld[c * 4], bindWorld[c * 4 + 1], bindWorld[c * 4 + 2]) || 1;
    for (let r = 0; r < 3; r++) m[r * 4 + c] = bindWorld[c * 4 + r] / l;
  }
  return m;
}

/** AvatarBundleOf: the character bundle a model id is in. */
export function avatarBundleOf(model) {
  const kind = model && model.length >= 4 ? model.slice(0, 4).toLowerCase() : '';
  switch (kind) {
    case 'chat': case 'cmet': case 'dful': case 'dhat': case 'dmet': return 'cful';
    case 'clin': return 'chea';
    case 'dwea': return 'cwea';
    case 'dshi': return 'cshi';
    case 'dbod': case 'cpan': return 'cbod';
    default: return kind;
  }
}

/** ReadActionScript: state name -> [{ kind, anim, value }] from json/action/player_common.json. */
export function readActionScript(root) {
  const script = new Map();
  if (!root || typeof root !== 'object') return script;
  const num = (c, f) => (c[f] != null ? Number(c[f]) || 0 : 0);
  for (const [state, cmds] of Object.entries(root)) {
    const list = [];
    for (const c of Array.isArray(cmds) ? cmds : []) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
      const cls = String(c['@class'] ?? ''), kind = cls.slice(cls.lastIndexOf(':') + 1);
      switch (kind) {
        case 'Anm': list.push({ kind, anim: c.animeName_ == null ? null : String(c.animeName_), value: num(c, 'frame_') }); break;
        case 'LerpFrame': list.push({ kind, value: num(c, 'lerpFrame_') }); break;
        case 'Frame': list.push({ kind, value: num(c, 'frame_') }); break;
        case 'AttackWait': list.push({ kind, value: num(c, 'wait_') }); break;
        case 'TempSpeed': list.push({ kind, value: num(c, 'rate_') }); break;
        case 'FrameEnd': case 'Hit': case 'HitEnd': list.push({ kind, value: 0 }); break;
      }
    }
    script.set(state, list);
  }
  return script;
}

/**
 * LoadAvatar: the warrior from the game's Data folder, or { avatar: null, note } when its body, clips or action script
 * aren't there. dataFiles(dir) lists the files of Data/<dir> as [{ name, read() }].
 */
export async function loadAvatar(dataFiles) {
  const dirs = new Map();
  const files = (dir) => {
    if (!dirs.has(dir)) dirs.set(dir, Promise.resolve().then(() => dataFiles(dir)).then((l) => l || [], () => []));
    return dirs.get(dir);
  };
  const file = async (dir, name) => (await files(dir)).find((f) => f.name.toLowerCase() === name.toLowerCase()) ?? null;
  const json = async (dir, name) => {
    try {
      const f = await file(dir, name);
      if (!f) return null;
      const text = new TextDecoder('utf-8').decode((await decodeLayers(await f.read())).payload).replace(/^﻿/, '');
      return parseGameJson(text).value;
    } catch {
      return null;
    }
  };
  const bundles = new Map();
  const bundle = (name) => {
    if (!bundles.has(name)) {
      bundles.set(name, (async () => {
        try {
          const f = await file('character', name + '.bres');
          return f ? parseBres((await decodeLayers(await f.read())).payload).entries : null;
        } catch {
          return null;
        }
      })());
    }
    return bundles.get(name);
  };
  const payload = async (e) => (await decodeLayers(e.data)).payload;
  const texture = async (entries, name) => {
    const e = entries?.find((x) => x?.name && x.data?.length && extOf(x.name) === '.dds' && baseName(x.name).toLowerCase() === String(name).toLowerCase());
    if (!e) return null;
    try {
      return decodeDds(await payload(e));
    } catch {
      return null;
    }
  };
  const log = [];

  // Body (TryLoadSkinnedFromBundleFile with the Steam skeleton).
  const cbod = await bundle('cbod');
  const models = (cbod ?? []).filter((e) => e?.name && e.data?.length && extOf(e.name) === '.rrm');
  const bodyEntry = models.find((e) => baseName(e.name).toLowerCase() === BODY_MODEL) ?? models[0];
  if (!bodyEntry) return { avatar: null, note: 'No warrior body (character/cbod.bres) in the Data folder' };
  let rig, bodyTexture = null;
  try {
    const u8 = await payload(bodyEntry);
    rig = skinnedModel(parseRrm(u8), u8, true);
  } catch (e) {
    return { avatar: null, note: 'The warrior body did not load: ' + e.message };
  }
  const bodyTex = (cbod ?? []).filter((e) => e?.name && e.data?.length && extOf(e.name) === '.dds');
  const bt = bodyTex.find((e) => baseName(e.name).toLowerCase() === baseName(bodyEntry.name).toLowerCase()) ?? bodyTex[0];
  if (bt) bodyTexture = await texture(cbod, baseName(bt.name));

  const a = {
    rig, bodyTexture, body: baseName(bodyEntry.name), parts: [], clips: new Map(), script: new Map(), ...DEFAULTS,
    skinTint: [220 / 255, 183 / 255, 152 / 255], hairTint: [205 / 255, 204 / 255, 190 / 255],
    headItem: null, headItemType: null, headPart: -1, faceLayers: [], height: 0, log,
  };
  const boneOf = (name) => rig.names.findIndex((b) => b.toLowerCase() === name.toLowerCase());

  // AvatarWear (TryLoadWornPart / TryLoadPart): a rigid part on a bone.
  const wear = async (bundleName, model, tex, bone, compose = null, round = false) => {
    const entries = await bundle(bundleName);
    const me = entries?.find((e) => e?.name && e.data?.length && extOf(e.name) === '.rrm' && baseName(e.name).toLowerCase() === String(model).toLowerCase());
    if (!me) {
      log.push(model + ': not in character/' + bundleName + '.bres');
      return false;
    }
    let mesh;
    try {
      mesh = parseRrm(await payload(me));
    } catch (e) {
      log.push(model + ': ' + e.message);
      return false;
    }
    const b = boneOf(bone);
    const picture = (tex ? await texture(entries, tex) : null) ?? (await texture(entries, model));
    a.parts.push({
      mesh: round ? roundOff(mesh, 4) : mesh,
      texture: (compose && compose(picture)) || picture,
      bone: b,
      unturn: unturn(rig.bindWorld[b] ?? IDENTITY),
      name: tex == null || tex === model ? model : model + ' (' + tex + ')',
    });
    return true;
  };

  // AvatarItemModel: an item id's model and texture.
  const seeds = [(await json('json/item', 'ItemSeedParam.json'))?.JsonItemParam?.itemSeedParam_, (await json('json/item', 'ItemSeedParamBOT.json'))?.JsonItemParam?.itemSeedParam_];
  const detail = (await json('character', 'CharacterModelDetail.json'))?.JsonCharacterModelDetail;
  const itemModel = (id) => {
    if (!id) return null;
    let entry = null;
    for (const s of seeds) if ((entry = s && typeof s === 'object' ? s[id] : null) != null) break;
    const dataId = entry?.DataID_Black_Man == null ? '' : String(entry.DataID_Black_Man);
    if (!dataId) return null;
    const r = { model: dataId, texture: dataId, type: entry.ItemType == null ? null : String(entry.ItemType) };
    for (const sheet of Object.values(detail && typeof detail === 'object' ? detail : {})) {
      const d = sheet && typeof sheet === 'object' ? sheet[dataId] : null;
      if (d && typeof d === 'object' && !Array.isArray(d)) {
        r.model = String(d.Name ?? '') + String(d.ModelId ?? '');
        r.texture = String(d.Name ?? '') + String(d.TextureId ?? '');
        break;
      }
    }
    return r;
  };

  // ReadAvatarLook: DressAvatarHead, then ArmAvatar.
  const style = (await json('json/player', 'PlayerClassSetting.json'))?.JsonPlayerParam?.styleProfile_?.Warrior ?? null;
  const preset = (await json('json/player', 'PlayerPresetParam.json'))?.JsonPlayerParam ?? null;
  const field = (f) => (style?.[f] == null ? null : String(style[f]));
  const num = (f, prefix) => {
    const v = field(f) ?? '';
    if (!v.startsWith(prefix)) return 0;
    const s = v.slice(prefix.length).trim();
    return /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : 0;
  };
  const colour = (sheet, set, fallback) => {
    const c = preset?.[sheet]?.['ColorSet' + pad(set, 2)];
    return c?.colorR != null ? [Number(c.colorR) / 255, Number(c.colorG) / 255, Number(c.colorB) / 255] : fallback;
  };
  const offset = (sheet, type, setType) => {
    const rows = preset?.[sheet];
    for (const row of rows && typeof rows === 'object' && !Array.isArray(rows) ? Object.values(rows) : []) {
      if (row && String(row.type) === 'TYPE_' + pad(type, 2) && String(row.setType) === (setType ?? 'DEFAULT'))
        return [row.posX == null ? 0 : Math.trunc(Number(row.posX)), row.posY == null ? 0 : Math.trunc(Number(row.posY))];
    }
    return [0, 0];
  };
  a.skinTint = colour('skinColorSet_', num('SkinColorType', 'SKIN_COLOR_'), a.skinTint);
  a.hairTint = colour('hairColorSet_', num('HairColorType', 'HAIR_COLOR_'), a.hairTint);
  const equip = field('EquipHead');
  const item = itemModel(equip);
  if (item) (a.headItem = equip), (a.headItemType = item.type);
  const hairShows = !item || item.type === 'HAT';
  if (!(item && item.type === 'FULLFACE')) {
    const eye = num('EyeType', 'EYE_'), mouth = num('MouthType', 'MOUTH_');
    const layers = [];
    const cmon = await bundle('cmon');
    for (const [name, [x, y]] of [
      ['ceye' + pad(eye, 3), offset('eyePositionSet_', eye, field('EyeOffsetType'))],
      ['cmou' + pad(mouth, 3), offset('mouthPositionSet_', mouth, field('MouthOffsetType'))],
    ]) {
      const picture = await texture(cmon, name);
      if (!picture) continue;
      layers.push({ picture, x, y });
      a.faceLayers.push(name + ' ' + x + ',' + y);
    }
    const at = a.parts.length;
    // Rounded off unless under a helmet: the helmet is made to fit the face as modelled.
    await wear('cmon', HEAD_MODEL, null, HEAD, (skin) => composeTinted(skin, a.skinTint, layers), hairShows);
    if (a.parts.length > at) a.headPart = at;
    else a.faceLayers.length = 0;
  }
  if (hairShows) {
    const hair = num('HairType', 'HAIR_');
    const lines = await texture(await bundle('chea'), 'clin' + pad(hair, 3));
    await wear('chea', 'chea' + pad(hair, 3), null, HEAD, (grey) => composeTinted(grey, a.hairTint, lines ? [{ picture: lines, x: 0, y: 0 }] : []));
  }
  if (item) await wear(avatarBundleOf(item.model), item.model, item.texture, HEAD);
  for (const [f, bone, fallback] of [['EquipWeapon', WEAPON, WEAPON_MODEL], ['EquipShield', SHIELD, SHIELD_MODEL]]) {
    const it = itemModel(field(f));
    if (!it || !(await wear(avatarBundleOf(it.model), it.model, it.texture, bone))) await wear(avatarBundleOf(fallback), fallback, null, bone);
  }

  // Clips: every standalone .rra in motion/player.bres with frames.
  try {
    const f = await file('motion', 'player.bres');
    for (const e of f ? parseBres((await decodeLayers(await f.read())).payload).entries : []) {
      if (!e?.name || !e.data?.length || extOf(e.name) !== '.rra') continue;
      const clip = parseRra(await payload(e), baseName(e.name));
      if (clip && clip.frameCount > 0) a.clips.set(baseName(e.name), clip);
    }
  } catch (e) {
    log.push('motion/player.bres: ' + e.message);
  }
  a.script = readActionScript(await json('json/action', 'player_common.json'));
  if (!a.clips.size) return { avatar: null, note: 'No warrior clips (motion/player.bres) in the Data folder' };
  if (!a.script.has('stand') || !a.script.has('run')) return { avatar: null, note: 'No warrior action script (json/action/player_common.json)' };

  // ReadAvatarNumbers.
  const basic = (await json('json/player', 'PlayerBasicParam.json'))?.JsonPlayerParam?.basicParam_?.normal;
  const n = (t, f, fallback) => (t?.[f] != null ? Number(t[f]) : fallback);
  a.turnSpeed = n(basic, 'turnSpeed_', a.turnSpeed);
  a.attackTurnSpeed = n(basic, 'attackTurnSpeed_', a.attackTurnSpeed);
  a.guardSpeedRate = n(basic, 'guardSpeedRate_', a.guardSpeedRate);
  a.attackSpeedRate = n(basic, 'attackSpeedRate_', a.attackSpeedRate);
  a.fallDistance = n(basic, 'fallDistance_', a.fallDistance);
  a.fallDamageDistance = n(basic, 'fallDamageDistance_', a.fallDamageDistance);
  a.fallDamageDistanceMax = n(basic, 'fallDamageDistanceMax_', a.fallDamageDistanceMax);
  a.fallDamageHp = n(basic, 'fallDamageHp_', a.fallDamageHp);
  a.fallDamageHpMax = n(basic, 'fallDamageHpMax_', a.fallDamageHpMax);
  a.fallDieY = n(basic, 'fallDieY_', a.fallDieY);
  a.respawnHpPer = n(basic, 'respawnHpPer_', a.respawnHpPer);
  const warrior = (await json('json/player', 'PlayerJobParam.json'))?.JsonPlayerParam?.warriorParam_?.Lvl1;
  a.moveSpeed = n(warrior, 'MoveSpeed', a.moveSpeed / 100) * 100; // m/s -> cm/s
  a.hpMax = n(warrior, 'HpMax', a.hpMax);

  const ys = rig.mesh.positions;
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < ys.length; i += 3) (lo = Math.min(lo, ys[i])), (hi = Math.max(hi, ys[i]));
  a.height = hi > lo ? hi - lo : 0;
  return { avatar: a, note: '' };
}
