// Pre-install check of a stage bundle, ported from HappyTool/RrmConvert/StageLint.cs (LintBytes, CheckWrapping,
// CheckCollision, CheckNavigation, CheckGameplayData, CheckGeometryParses, DetectByteOrder, DetectStageId). It carries
// what was learned porting stages, so a bundle that would crash the game is stopped before it is written: no .ccp
// collision (the engine sizes its CollisionHeap with a zero stride and dies with INT_DIVIDE_BY_ZERO), big-endian Xbox 360
// resources (the little-endian engine follows byte-swapped offsets and faults), unconverted Xbox formats, pointer stubs.
// Pure logic: it never writes anything.
//
// One difference from the desktop: for the "can HappyTool's parsers read this .rrm" check the desktop also tries its
// older descriptor-scan parser, which the web doesn't have; the web tries the stage terrain, inline ModelData and plain
// model parsers.

import { bfbrDecrypt, bsrsDecrypt, zresDecompress } from './wrappers.js';
import { parseBres } from './bres.js';
import { parseRrm, parseStageRrm } from './rrm.js';
import { parseInlineModelData } from './steam-stage.js';
import { sha256, isValidStageId } from './stage-install.js';

export const SEVERITY_RANK = { info: 0, warning: 1, error: 2 };

const MAGIC_RR_CONTAINER = 0x013290dd; // .rrl / .rrt / .rra, stored little-endian on Steam
const MAGIC_MODEL_DATA = 0x0132b421; // .rrm
const MAX_NAMES_IN_DETAIL = 8;
const NAVIGATION_NAMES = ['navi000.spd', 'path000.spd'];
const STAGE_SET_TABLE = 'StageSetTable.json';
const STAGE_SETTING_NUT = 'stage_setting.nut';
const GAMEPLAY_JSON_SUFFIXES = ['StageCameraParam.json', 'CharacterLightParam0.json'];
const XBOX_ONLY = new Set(['.rrmv', '.rrmp', '.vir', '.phy', '.rmd']);

const ascii = (u8, n) => String.fromCharCode(...u8.subarray(0, n));
const headEquals = (u8, s) => !!u8 && u8.length >= s.length && ascii(u8, s.length) === s;
const u32le = (u8, o) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;
const u32be = (u8, o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
const lower = (s) => s.toLowerCase();

/** The lowercased extension with its dot ('' when the name has none), as StageLint.Ext. */
export const ext = (name) => {
  const dot = (name ?? '').lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
};

/** Path.GetFileNameWithoutExtension: the part after the last \ or /, without its last extension. */
const fileStem = (path) => {
  const leaf = String(path ?? '').split(/[\\/]/).pop();
  const dot = leaf.lastIndexOf('.');
  return dot < 0 ? leaf : leaf.slice(0, dot);
};

/** At most eight names, then " and N more". */
const joinNames = (names) => {
  const shown = names.slice(0, MAX_NAMES_IN_DETAIL).join(', ');
  return names.length > MAX_NAMES_IN_DETAIL ? `${shown} and ${names.length - MAX_NAMES_IN_DETAIL} more` : shown;
};

const magicOrder = (d, magic) => {
  if (d.length < 4) return 'unrecognised';
  if (u32le(d, 0) === magic) return 'little';
  if (u32be(d, 0) === magic) return 'big';
  return 'unrecognised';
};

/** For a header word that is a small count or size: whichever reading is small wins. */
const smallWordOrder = (d, offset) => {
  if (d.length < offset + 4) return 'unrecognised';
  const le = u32le(d, offset), be = u32be(d, offset), small = 0xffff;
  if (le <= small && (be > small || le === be)) return 'little';
  if (be <= small && le > small) return 'big';
  return 'unrecognised';
};

/**
 * A resource's byte order from its header: 'little' (Steam), 'big' (Xbox 360), 'unrecognised' (a byte-order-sensitive
 * type matching neither form) or 'n/a' (text, textures and other types that don't care).
 */
export function detectByteOrder(name, d) {
  switch (ext(name)) {
    case '.rrl':
    case '.rrt':
    case '.rra':
      return magicOrder(d, MAGIC_RR_CONTAINER);
    case '.rrm':
      return magicOrder(d, MAGIC_MODEL_DATA);
    case '.ccp':
      return headEquals(d, 'CCP\0') ? 'little' : headEquals(d, '\0PCC') ? 'big' : 'unrecognised';
    case '.spd':
      if (headEquals(d, 'navm') || headEquals(d, 'spd_')) return 'little';
      if (headEquals(d, 'mvan') || headEquals(d, '_dps')) return 'big';
      return 'unrecognised';
    case '.emt':
      // .emt keeps "EVMT" either way, but its header-size word at +8 (0x1C) flips.
      if (!headEquals(d, 'EVMT') && !headEquals(d, 'TMVE')) return 'unrecognised';
      return smallWordOrder(d, 8);
    case '.gpt':
      return smallWordOrder(d, 0);
    case '.mtf':
      if (headEquals(d, 'RIFF')) return 'little';
      if (headEquals(d, 'RIFX') || headEquals(d, 'FFIR')) return 'big';
      return 'unrecognised';
    default:
      return 'n/a';
  }
}

/** The stage the resources were made for: the BRES name, else the <id>.bres#… prefix of a resource, else the file stem. */
export function detectStageId(bres, stem) {
  if (isValidStageId(bres?.name)) return bres.name;
  for (const e of bres?.entries ?? []) {
    const name = e?.name ?? '';
    const hash = name.toLowerCase().indexOf('.bres#');
    if (hash > 0 && isValidStageId(name.slice(0, hash))) return name.slice(0, hash);
  }
  return isValidStageId(stem) ? stem : null;
}

/** True when one of the web's RRM parsers (stage terrain, inline ModelData pack, plain model) reads the bytes. */
export function geometryParses(rrm) {
  if (!rrm || rrm.length < 16) return false;
  try {
    if (parseStageRrm(rrm)) return true;
  } catch {
    // next parser
  }
  try {
    if (rrm.length >= 48 && parseInlineModelData(rrm, null, null).length > 0) return true;
  } catch {
    // next parser
  }
  try {
    parseRrm(rrm);
    return true;
  } catch {
    return false;
  }
}

/** BresBundleIo.DecodeToBresPayload: an outer BFBR (or BSRS, read-only), then one ZRES. */
async function decodeLikeDesktop(raw) {
  let hadBfbr = false, hadZres = false;
  let cur = raw;
  if (cur && cur.length >= 4) {
    if (headEquals(cur, 'BFBR')) {
      hadBfbr = true;
      cur = await bfbrDecrypt(cur);
    } else if (headEquals(cur, 'BSRS')) {
      cur = bsrsDecrypt(cur);
    }
    if (cur && cur.length >= 4 && headEquals(cur, 'ZRES')) {
      hadZres = true;
      cur = await zresDecompress(cur);
    }
  }
  return { payload: cur, hadBfbr, hadZres };
}

/**
 * Lints a bundle's on-disk bytes (any wrapping). displayName is its file name (the stage id falls back to its stem).
 * Never throws for bad content: an unreadable bundle is an error finding. Findings are
 * {severity: 'error'|'warning'|'info', code, message, detail}, in the desktop's order.
 */
export async function lintBundle(raw, displayName = '') {
  const report = {
    bundlePath: displayName,
    fileSize: raw?.length ?? 0,
    sha256: raw ? await sha256(raw) : null,
    readable: false,
    outerHadBfbr: false,
    innerHadZres: false,
    get isSteamWrapped() {
      return this.outerHadBfbr && this.innerHadZres;
    },
    littleEndianContainer: false,
    bundleName: null,
    detectedStageId: null,
    resourceCount: 0,
    geometryCount: 0,
    collisionCount: 0,
    navigationCount: 0,
    textureCount: 0,
    findings: [],
    get hasErrors() {
      return this.findings.some((f) => f.severity === 'error');
    },
  };
  const add = (severity, code, message, detail) => report.findings.push({ severity, code, message, detail });

  let bres;
  try {
    const d = await decodeLikeDesktop(raw);
    report.outerHadBfbr = d.hadBfbr;
    report.innerHadZres = d.hadZres;
    if (!d.payload || d.payload.length < 8) throw new Error('File is empty or too small to be a BRES bundle.');
    bres = parseBres(d.payload);
  } catch (e) {
    add('error', 'BUNDLE_UNREADABLE', 'Not a readable BRES stage bundle',
      `Decoding failed: ${e.message}. Only BRES bundles (optionally BFBR/ZRES wrapped) can be installed.`);
    return report;
  }

  report.readable = true;
  report.littleEndianContainer = bres.littleEndian;
  report.bundleName = bres.name;
  const resources = bres.entries ?? [];
  report.resourceCount = resources.length;
  report.detectedStageId = detectStageId(bres, fileStem(displayName));

  if (!report.isSteamWrapped) {
    const have = report.outerHadBfbr ? 'BFBR only' : report.innerHadZres ? 'ZRES only (Xbox 360 style)' : 'plain BRES (no wrapper)';
    add('warning', 'NOT_STEAM_WRAPPED', 'Bundle is not BFBR + ZRES wrapped like the Steam stages',
      `It is ${have}. Every shipped Steam stage is ZRES-compressed then BFBR-encrypted; enable "Re-wrap as BFBR + ZRES" to write it in that form.`);
  }
  if (!report.littleEndianContainer) {
    add('error', 'BE_CONTAINER', 'Bundle container is big-endian (Xbox 360)',
      `The BRES container itself is the Xbox 360 byte order (target '${bres.target ?? 'Xbox360'}'). The Steam engine only reads little-endian Win32 bundles. Convert it with the Xbox 360 stage converter first.`);
  }

  const byName = new Map(); // lowercased name -> entry (the last of a repeated name wins, as the desktop's dictionary)
  const pointerStubs = [], xboxOnly = [], bigEndian = [], unrecognised = [], empty = [], badTextures = [];
  const geometry = [], collision = [];
  for (const r of resources) {
    const name = r?.name ?? '';
    if (!name) continue;
    byName.set(lower(name), r);
    const x = ext(name);
    if (r.pointer) {
      pointerStubs.push(name);
      continue;
    }
    const d = r.data;
    if (d.length === 0) empty.push(name);
    if (XBOX_ONLY.has(x)) {
      xboxOnly.push(name);
      continue;
    }
    if (x === '.rrm') {
      geometry.push(name);
      report.geometryCount++;
    } else if (x === '.ccp') {
      collision.push(name);
      report.collisionCount++;
    } else if (x === '.spd') {
      report.navigationCount++;
    } else if (x === '.dds') {
      report.textureCount++;
      if (d.length > 0 && !headEquals(d, 'DDS ')) badTextures.push(name);
      continue;
    }
    if (d.length === 0) continue;
    const order = detectByteOrder(name, d);
    if (order === 'big') bigEndian.push(name);
    else if (order === 'unrecognised') unrecognised.push(name);
  }

  if (pointerStubs.length)
    add('error', 'POINTER_RESOURCES', `${pointerStubs.length} resource(s) are pointer stubs with no data`,
      `Their bytes live in an external .pres pool (Xbox 360 layout), so the bundle is not self-contained: ${joinNames(pointerStubs)}. Convert the stage to Steam format first.`);
  if (xboxOnly.length)
    add('error', 'XBOX_FORMAT', 'Unconverted Xbox resources (.rrmv/.rrmp/.vir/.phy/.rmd)',
      `The Steam engine cannot load Xbox geometry/texture formats: ${joinNames(xboxOnly)}. Run the stage through the Xbox 360 / Xbox One stage converter first.`);
  if (bigEndian.length)
    add('error', 'BIG_ENDIAN_RESOURCE', `${bigEndian.length} big-endian (Xbox 360) binary resource(s)`,
      `The little-endian engine reads their byte-swapped offsets as pointers and crashes with an access violation: ${joinNames(bigEndian)}. Re-convert (the 360 converter endian-swaps .ccp and .spd) or remove them.`);
  if (unrecognised.length)
    add('warning', 'UNRECOGNISED_RESOURCE', `${unrecognised.length} binary resource(s) with an unknown header`,
      `Header matches neither the Steam (little-endian) nor the Xbox 360 form, so the byte order can't be verified: ${joinNames(unrecognised)}.`);
  if (empty.length) add('warning', 'EMPTY_RESOURCE', `${empty.length} empty resource(s)`, `Zero-length entries: ${joinNames(empty)}.`);

  if (report.geometryCount === 0)
    add('error', 'NO_GEOMETRY', 'No .rrm geometry in the bundle',
      'A stage needs at least one little-endian ModelData .rrm (e.g. <stage>.rrm) or the map renders nothing.');

  // ---- collision ----
  if (!collision.length) {
    add('error', 'NO_COLLISION', 'No .ccp collision in the bundle',
      "Confirmed crash: with zero collision the engine sizes its CollisionHeap with a zero element stride and dies with INT_DIVIDE_BY_ZERO while loading the stage. Carry the stage's own (little-endian) .ccp files (<stage>_Chit / _Dhit / _Ehit / _Chit_fort).");
  } else {
    // Root header (LE): "CCP\0" · hdrSize · totalSize · hullCount. No hulls is the same zero-stride divide as no .ccp.
    const emptyHulls = [];
    let usable = 0;
    for (const name of collision) {
      if (bigEndian.includes(name)) continue;
      const d = byName.get(lower(name))?.data;
      if (d && !byName.get(lower(name)).pointer && d.length >= 16 && headEquals(d, 'CCP\0')) {
        if (u32le(d, 0x0c) === 0 || d.length <= 16) emptyHulls.push(name);
        else usable++;
      }
    }
    if (emptyHulls.length)
      add(usable === 0 ? 'error' : 'warning', 'EMPTY_COLLISION',
        usable === 0 ? 'Every .ccp collision container is empty' : `${emptyHulls.length} empty .ccp collision container(s)`,
        `No collision hulls in: ${joinNames(emptyHulls)}.${usable === 0 ? ' An empty CollisionHeap hits the same INT_DIVIDE_BY_ZERO as a missing .ccp.' : ''}`);
  }

  // ---- navigation ----
  const missingNav = NAVIGATION_NAMES.filter((n) => !byName.has(n));
  if (missingNav.length)
    add('warning', 'NO_NAV',
      missingNav.length === NAVIGATION_NAMES.length ? "No navigation (.spd) — bots won't path" : `Incomplete navigation: missing ${missingNav.join(', ')}`,
      'Bots use navi000.spd (nav mesh) and path000.spd (waypoints). The stage still loads without them, but bots stand still.');

  // ---- gameplay data ----
  const names = resources.map((r) => lower(r?.name ?? ''));
  const missing = [];
  if (!names.includes(lower(STAGE_SET_TABLE))) missing.push(STAGE_SET_TABLE);
  for (const suffix of GAMEPLAY_JSON_SUFFIXES) if (!names.some((n) => n.endsWith(lower(suffix)))) missing.push(`…#${suffix}`);
  if (!names.includes(lower(STAGE_SETTING_NUT))) missing.push(STAGE_SETTING_NUT);
  if (missing.length)
    add('warning', 'MISSING_GAMEPLAY_DATA', `Missing gameplay data: ${missing.join(', ')}`,
      'Steam stages carry StageSetTable.json (spawn / set table), <stage>.bres#StageCameraParam.json, <stage>.bres#CharacterLightParam0-2.json and stage_setting.nut. Without them spawns, cameras or lighting may be wrong.');

  if (report.textureCount === 0 && report.geometryCount > 0)
    add('warning', 'NO_TEXTURES', 'No .dds textures in the bundle', 'Geometry will render untextured (Steam stages embed their .dds textures).');
  if (badTextures.length)
    add('warning', 'BAD_TEXTURE', `${badTextures.length} .dds resource(s) without a DDS header`, `${joinNames(badTextures)}.`);

  // ---- geometry the parsers can read ----
  if (report.littleEndianContainer) {
    const failed = [];
    for (const name of geometry) {
      if (bigEndian.includes(name)) continue;
      const r = byName.get(lower(name));
      if (!geometryParses(r && !r.pointer ? r.data : null)) failed.push(name);
    }
    if (failed.length)
      add('warning', 'GEOMETRY_UNPARSED', `${failed.length} .rrm file(s) HappyTool's parsers can't read`,
        `${joinNames(failed)}. Neither the terrain, multi-submesh nor model parser accepted them, so the layout is unverified and may not load in-game.`);
  }

  if (!report.hasErrors)
    add('info', 'SUMMARY', 'Bundle structure looks installable',
      `${report.resourceCount} resources: ${report.geometryCount} geometry, ${report.collisionCount} collision, ${report.navigationCount} navigation, ${report.textureCount} textures.`);
  return report;
}
