// The pictures the game's own stage select shows (port of HappyTool/GUI/StageSelectPictures.cs).
// The preview is the sprite placed as "mapflame" in scaleform/UI_main.bres › multiplay_true.sgfx; the game calls
// gotoAndStop(kind + 1), where kind is the stage's place in the STAGE_KIND enum (its id_ in
// json/stage/gemini_stage_table.json). Each frame places one shape whose bitmap fill is a sub-image (tag 1008) of a DDS
// atlas (tag 1009) stored next to the movie in the same bundle.
import { decodeLayers } from './wrappers.js';
import { parseBres } from './bres.js';
import { decodeDds } from './dds.js';
import { parseGameJson } from './json.js';
import { decompressMovie, u8At, u16, rectLength, skipMatrix, skipColorTransform, readCString, readPascalString, readTags } from './sgfx.js';

export { decompressMovie };

export const PICTURE_BUNDLE = 'scaleform/UI_main.bres';
export const STAGE_TABLE = 'json/stage/gemini_stage_table.json';
const MOVIE = 'multiplay_true.sgfx';
const INSTANCE = 'mapflame';

/** STAGE_KIND order of the 12 real stages; STAGE_EXTRA_02… follow as kinds 12…. */
const STOCK_KINDS = [
  'STAGE_SCLO_A', 'STAGE_SCLO_B', 'STAGE_SDAR_A', 'STAGE_SDAR_B', 'STAGE_SDES_A', 'STAGE_SDES_B',
  'STAGE_SLIG_A', 'STAGE_SLIG_B', 'STAGE_SSEA_A', 'STAGE_SSEA_B', 'STAGE_SBAB_A', 'STAGE_SBAB_B',
];

/** `STAGE_SLIG_A` → 6, `STAGE_EXTRA_02` → 12; -1 for anything else (debug maps). */
export function kindOf(tableId) {
  if (!tableId) return -1;
  const up = String(tableId).toUpperCase();
  const i = STOCK_KINDS.indexOf(up);
  if (i >= 0) return i;
  const m = /^STAGE_EXTRA_(\d+)$/.exec(up);
  const n = m ? Number(m[1]) : NaN;
  return n >= 2 && n <= 15 ? STOCK_KINDS.length + n - 2 : -1;
}

/** Stage id → kind from the stage table's text (Latin-1 JSON with comments), or the stock ids when it can't be read. */
export function stageKinds(tableText) {
  const kinds = new Map();
  try {
    const stages = parseGameJson(tableText).value?.JsonStageInfomationTable?.stage_;
    for (const [id, v] of Object.entries(stages ?? {})) {
      const kind = kindOf(v?.id_);
      if (kind >= 0) kinds.set(id, kind);
    }
  } catch {
    // fall back to the stock ids below
  }
  if (!kinds.size) {
    STOCK_KINDS.forEach((t, kind) => {
      const m = /^STAGE_([A-Z]+)_([A-Z])$/.exec(t);
      kinds.set(m[1].toLowerCase() + m[2], kind);
    });
  }
  return kinds;
}

// ---------- the movie ----------

/** PlaceObject2 / PlaceObject3: the character placed (-1 when it only moves one) and the instance name, or null. */
function readPlaceObject(t) {
  try {
    const d = t.data;
    const flags = u8At(d, 0), flags2 = t.code === 70 ? u8At(d, 1) : 0;
    const at = { p: t.code === 70 ? 4 : 3 }; // flags (+ flags2), depth
    if (t.code === 70 && ((flags2 & 0x08) || ((flags2 & 0x10) && (flags & 0x02)))) readCString(d, at); // class name
    let character = -1, name = null;
    if (flags & 0x02) {
      character = u16(d, at.p);
      at.p += 2;
    }
    if (flags & 0x04) at.p = skipMatrix(d, at.p);
    if (flags & 0x08) at.p = skipColorTransform(d, at.p);
    if (flags & 0x10) at.p += 2; // ratio
    if (flags & 0x20) name = readCString(d, at);
    return { character, name };
  } catch (e) {
    if (e instanceof RangeError) return null;
    throw e;
  }
}

/** The character id of a shape's first bitmap fill, or -1. */
function firstBitmapFill(shape) {
  try {
    const d = shape.data;
    let p = 2;
    p += rectLength(d, p); // bounds
    if (shape.code === 83) {
      p += rectLength(d, p); // edge bounds
      p += 1; // flags
    }
    let count = u8At(d, p++);
    if (count === 0xff && shape.code !== 2) {
      count = u16(d, p);
      p += 2;
    }
    const rgba = shape.code === 32 || shape.code === 83;
    for (let i = 0; i < count; i++) {
      const type = u8At(d, p++);
      if (type === 0x00) p += rgba ? 4 : 3;
      else if (type === 0x10 || type === 0x12 || type === 0x13) {
        p = skipMatrix(d, p);
        const records = u8At(d, p++) & 0x0f;
        p += records * (1 + (rgba ? 4 : 3));
        if (type === 0x13) p += 2; // focal point
      } else if (type >= 0x40 && type <= 0x43) {
        const id = u16(d, p);
        if (id !== 0xffff) return id;
        p = skipMatrix(d, p + 2);
      } else return -1;
    }
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
  }
  return -1;
}

/**
 * The pictures of the mapflame sprite, one per frame (null where a frame shows none):
 * `{file, imageWidth, imageHeight, x1, y1, x2, y2}`, a rectangle of a DDS atlas stored in the bundle.
 */
export function readPreviewFrames(swf) {
  const result = [];
  if (!swf || swf.length < 12) return result;
  const tags = readTags(swf, 8 + rectLength(swf, 8) + 4, swf.length); // header, stage rect, frame rate, frame count

  const shapes = new Map();
  const subImages = new Map(); // id → [image id, x1, y1, x2, y2]
  const images = new Map(); // image id → file name and declared size
  const sprites = new Map();
  for (const t of tags) {
    if (t.data.length < 2) continue;
    const id = u16(t.data, 0);
    switch (t.code) {
      case 2:
      case 22:
      case 32:
      case 83:
        shapes.set(id, t);
        break;
      case 1008: // DefineSubImage: id, image id, x1, y1, x2, y2
        if (t.data.length >= 12) subImages.set(id, [2, 4, 6, 8, 10].map((o) => u16(t.data, o)));
        break;
      case 1009: // DefineExternalImage2: id, ?, format, width, height, export name, file name
        if (t.data.length >= 12) {
          try {
            const at = { p: 10 };
            readPascalString(t.data, at); // export name
            const file = readPascalString(t.data, at);
            if (file) images.set(id, { file, imageWidth: u16(t.data, 6), imageHeight: u16(t.data, 8) });
          } catch (e) {
            if (!(e instanceof RangeError)) throw e;
          }
        }
        break;
      case 39: // DefineSprite: id, frame count, its own tags
        if (t.data.length >= 4) sprites.set(id, readTags(t.data, 4, t.data.length));
        break;
    }
  }

  let previewSprite = -1;
  for (const spriteTags of [tags, ...sprites.values()]) {
    for (const t of spriteTags) {
      if (t.code !== 26 && t.code !== 70) continue;
      const po = readPlaceObject(t);
      if (po && po.character >= 0 && po.name === INSTANCE) previewSprite = po.character;
    }
  }
  const frameTags = sprites.get(previewSprite);
  if (previewSprite < 0 || !frameTags) return result;

  // Walk the frames: what is placed at each depth when a frame is shown.
  const placed = new Map();
  for (const t of frameTags) {
    if ((t.code === 26 || t.code === 70) && t.data.length >= 3) {
      const depth = u16(t.data, t.code === 70 ? 2 : 1);
      const po = readPlaceObject(t);
      if (po && po.character >= 0) placed.set(depth, po.character);
    } else if (t.code === 28 && t.data.length >= 2) placed.delete(u16(t.data, 0));
    else if (t.code === 5 && t.data.length >= 4) placed.delete(u16(t.data, 2));
    else if (t.code === 1) {
      let picture = null;
      for (const depth of [...placed.keys()].sort((a, b) => a - b)) {
        const shape = shapes.get(placed.get(depth));
        if (!shape) continue;
        const fill = firstBitmapFill(shape);
        const sub = fill >= 0 ? subImages.get(fill) : null;
        const img = sub ? images.get(sub[0]) : null;
        if (img) {
          picture = { ...img, x1: sub[1], y1: sub[2], x2: sub[3], y2: sub[4] };
          break;
        }
      }
      result.push(picture);
    }
  }
  return result;
}

// ---------- the pictures ----------

/** A rectangle of an RGBA image as its own `{width, height, rgba}`. */
function crop(img, x1, y1, x2, y2) {
  const w = x2 - x1, h = y2 - y1;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) rgba.set(img.rgba.subarray(((y1 + y) * img.width + x1) * 4, ((y1 + y) * img.width + x2) * 4), y * w * 4);
  return { width: w, height: h, rgba };
}

/**
 * The stage-select pictures of a Data folder, from the bytes of scaleform/UI_main.bres and (optional)
 * json/stage/gemini_stage_table.json, both as stored. Never throws for a bad file: `problem` says what was missing.
 * @returns {Promise<{pictures: Map<string, {frame:number, width:number, height:number, rgba:Uint8ClampedArray}>, frames:number, problem:string|null}>}
 */
export async function readStagePictures(bundleBytes, tableBytes) {
  const pictures = new Map();
  try {
    const arc = parseBres((await decodeLayers(bundleBytes)).payload);
    const resources = new Map();
    for (const e of arc.entries) {
      const key = e.name.toLowerCase();
      if (!e.pointer && !resources.has(key)) resources.set(key, e.data);
    }
    const movie = resources.get(MOVIE);
    if (!movie) return { pictures, frames: 0, problem: `${PICTURE_BUNDLE} has no ${MOVIE}.` };
    const frames = readPreviewFrames(await decompressMovie((await decodeLayers(movie)).payload));
    if (!frames.length) return { pictures, frames: 0, problem: `${MOVIE} has no ${INSTANCE} pictures.` };

    let tableText = null;
    if (tableBytes) {
      try {
        tableText = new TextDecoder('latin1').decode((await decodeLayers(tableBytes)).payload);
      } catch {
        tableText = null;
      }
    }
    const atlases = new Map();
    for (const [id, kind] of stageKinds(tableText ?? '')) {
      const frame = kind + 1;
      const fp = frame >= 1 && frame <= frames.length ? frames[frame - 1] : null;
      if (!fp) continue;
      const key = fp.file.toLowerCase();
      if (!atlases.has(key)) {
        let atlas = null;
        try {
          const dds = resources.get(key);
          atlas = dds ? decodeDds((await decodeLayers(dds)).payload) : null;
        } catch {
          atlas = null;
        }
        atlases.set(key, atlas);
      }
      const atlas = atlases.get(key);
      if (!atlas) continue;
      // The sub-image is in the declared image size; scale it if the DDS was stored at another size.
      const sx = fp.imageWidth > 0 ? atlas.width / fp.imageWidth : 1, sy = fp.imageHeight > 0 ? atlas.height / fp.imageHeight : 1;
      const x1 = Math.max(0, Math.round(fp.x1 * sx)), y1 = Math.max(0, Math.round(fp.y1 * sy));
      const x2 = Math.min(atlas.width, Math.round(fp.x2 * sx)), y2 = Math.min(atlas.height, Math.round(fp.y2 * sy));
      if (x2 - x1 < 8 || y2 - y1 < 8) continue;
      pictures.set(id, { frame, ...crop(atlas, x1, y1, x2, y2) });
    }
    return { pictures, frames: frames.length, problem: pictures.size ? null : `No stage in the table has a picture in ${MOVIE}.` };
  } catch (e) {
    return { pictures, frames: 0, problem: `Couldn't read the stage-select pictures: ${e.message}` };
  }
}
