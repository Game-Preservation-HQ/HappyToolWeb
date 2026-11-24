// Xbox 360 UI textures behind a .tanda scene, ported from HappyTool/RrmConvert/Xbox360TextureDecoder.cs
// (FormatFromCode, HeightForSize, Decode: Swap16, Xenos un-tile, DXT1/3/5 and 8_8_8_8),
// HappyWars360StageParser.LoadPresPool and HappyTool/Formats/TandaTextureCatalog.cs (LoadCore, LoadBundle,
// FindExternalBundleRefs, DecodePhy). Output pixels are RGBA (the desktop builds BGRA bitmaps).

import { decodeLayers } from './wrappers.js';
import { parseBres } from './bres.js';

export const FORMAT_NAMES = { 1: 'DXT1', 2: 'DXT3', 3: 'DXT5', 4: 'RGBA32' };
const DXT1 = 1;
const DXT3 = 2;
const DXT5 = 3;
const RGBA32 = 4;

export function formatFromCode(code) {
  switch (code) {
    case 0x52:
      return DXT1;
    case 0x53:
      return DXT3;
    case 0x54:
      return DXT5;
    case 0x86:
    case 0x06:
      return RGBA32;
    default:
      return 0;
  }
}

const bytesPerBlock = (f) => (f === DXT1 ? 8 : 16);

export function heightForSize(fmt, width, size) {
  if (width <= 0 || size <= 0) return 0;
  let texels;
  if (fmt === DXT1) texels = size * 2;
  else if (fmt === DXT3 || fmt === DXT5) texels = size;
  else if (fmt === RGBA32) texels = Math.trunc(size / 4);
  else return 0;
  if (texels % width !== 0) return 0;
  return texels / width;
}

// Canonical Xenos 2D tiled address (block coordinates in, linear block index out).
function tiledOffset(x, y, width, texelPitch) {
  const alignedWidth = (width + 31) & ~31;
  const logBpp = (texelPitch >> 2) + ((texelPitch >> 1) >> (texelPitch >> 2));
  const macro = ((x >> 5) + (y >> 5) * (alignedWidth >> 5)) << (logBpp + 7);
  const micro = ((x & 7) + ((y & 6) << 2)) << logBpp;
  const offset = macro + ((micro & ~15) << 1) + (micro & 15) + ((y & 8) << (3 + logBpp)) + ((y & 1) << 4);
  return (((offset & ~511) << 3) + ((offset & 448) << 2) + (offset & 63) + ((y & 16) << 7) + (((((y & 8) >> 2) + (x >> 3)) & 3) << 6)) >> logBpp;
}

function swap16(src) {
  const o = new Uint8Array(src.length);
  const n = src.length & ~1;
  for (let i = 0; i < n; i += 2) {
    o[i] = src[i + 1];
    o[i + 1] = src[i];
  }
  if (src.length & 1) o[src.length - 1] = src[src.length - 1];
  return o;
}

function untile(src, width, height, tp) {
  const bw = Math.trunc(width / 4);
  const bh = Math.trunc(height / 4);
  const out = new Uint8Array(bw * bh * tp);
  for (let dy = 0; dy < bh; dy++) {
    for (let dx = 0; dx < bw; dx++) {
      const srcByte = tiledOffset(dx, dy, bw, tp) * tp;
      const dstByte = (dy * bw + dx) * tp;
      if (srcByte >= 0 && srcByte + tp <= src.length) out.set(src.subarray(srcByte, srcByte + tp), dstByte);
    }
  }
  return out;
}

function color565(c, i, cr, cg, cb) {
  cr[i] = Math.trunc((((c >> 11) & 31) * 255) / 31);
  cg[i] = Math.trunc((((c >> 5) & 63) * 255) / 63);
  cb[i] = Math.trunc(((c & 31) * 255) / 31);
}

function decodeDxt(data, width, height, fmt) {
  const out = new Uint8ClampedArray(width * height * 4);
  const bw = Math.trunc(width / 4);
  const bh = Math.trunc(height / 4);
  const tp = bytesPerBlock(fmt);
  const cr = [0, 0, 0, 0];
  const cg = [0, 0, 0, 0];
  const cb = [0, 0, 0, 0];
  const alpha = new Uint8Array(16);
  const at = new Array(8);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const o = (by * bw + bx) * tp;
      if (o + tp > data.length) continue;
      let colorOff = o;
      let hasAlpha = false;
      if (fmt === DXT3) {
        for (let i = 0; i < 8; i++) {
          const pair = data[o + i];
          alpha[i * 2] = (pair & 0x0f) * 17;
          alpha[i * 2 + 1] = (pair >> 4) * 17;
        }
        colorOff = o + 8;
        hasAlpha = true;
      } else if (fmt === DXT5) {
        const a0 = data[o];
        const a1 = data[o + 1];
        at.fill(0);
        at[0] = a0;
        at[1] = a1;
        if (a0 > a1) {
          for (let k = 1; k <= 6; k++) at[k + 1] = Math.trunc(((7 - k) * a0 + k * a1) / 7);
        } else {
          for (let k = 1; k <= 4; k++) at[k + 1] = Math.trunc(((5 - k) * a0 + k * a1) / 5);
          at[6] = 0;
          at[7] = 255;
        }
        let abits = 0; // 48 bits: exact in a double
        for (let i = 0; i < 6; i++) abits += data[o + 2 + i] * 2 ** (8 * i);
        for (let i = 0; i < 16; i++) alpha[i] = at[Math.floor(abits / 2 ** (3 * i)) & 7];
        colorOff = o + 8;
        hasAlpha = true;
      }
      const c0 = data[colorOff] | (data[colorOff + 1] << 8);
      const c1 = data[colorOff + 2] | (data[colorOff + 3] << 8);
      const bits = (data[colorOff + 4] | (data[colorOff + 5] << 8) | (data[colorOff + 6] << 16) | (data[colorOff + 7] << 24)) >>> 0;
      color565(c0, 0, cr, cg, cb);
      color565(c1, 1, cr, cg, cb);
      const punch = fmt === DXT1 && c0 <= c1;
      if (!punch) {
        cr[2] = Math.trunc((2 * cr[0] + cr[1]) / 3);
        cg[2] = Math.trunc((2 * cg[0] + cg[1]) / 3);
        cb[2] = Math.trunc((2 * cb[0] + cb[1]) / 3);
        cr[3] = Math.trunc((cr[0] + 2 * cr[1]) / 3);
        cg[3] = Math.trunc((cg[0] + 2 * cg[1]) / 3);
        cb[3] = Math.trunc((cb[0] + 2 * cb[1]) / 3);
      } else {
        cr[2] = (cr[0] + cr[1]) >> 1;
        cg[2] = (cg[0] + cg[1]) >> 1;
        cb[2] = (cb[0] + cb[1]) >> 1;
        cr[3] = cg[3] = cb[3] = 0;
      }
      for (let i = 0; i < 16; i++) {
        const sel = (bits >>> (2 * i)) & 3;
        const px = bx * 4 + (i & 3);
        const py = by * 4 + (i >> 2);
        if (px >= width || py >= height) continue;
        const di = (py * width + px) * 4;
        out[di] = cr[sel];
        out[di + 1] = cg[sel];
        out[di + 2] = cb[sel];
        let a = 255;
        if (hasAlpha) a = alpha[i];
        else if (punch && sel === 3) a = 0;
        out[di + 3] = a;
      }
    }
  }
  return out;
}

function decodeRgba32(tiled, width, height) {
  // 8_8_8_8 is stored tiled with a 32-bit texel; endian-swap each texel then un-tile per pixel.
  const sw = new Uint8Array(tiled.length);
  const n = tiled.length & ~3;
  for (let i = 0; i < n; i += 4) {
    sw[i] = tiled[i + 3];
    sw[i + 1] = tiled[i + 2];
    sw[i + 2] = tiled[i + 1];
    sw[i + 3] = tiled[i];
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = tiledOffset(x, y, width, 4) * 4;
      const di = (y * width + x) * 4;
      if (src + 4 > sw.length) continue;
      // swapped texel is A,R,G,B
      out[di] = sw[src + 1];
      out[di + 1] = sw[src + 2];
      out[di + 2] = sw[src + 3];
      out[di + 3] = sw[src];
    }
  }
  return out;
}

// Xbox360TextureDecoder.Decode -> RGBA bytes (width*height*4), or null.
export function decodeX360(tiled, width, height, fmt) {
  if (!tiled || width < 1 || height < 1 || !fmt) return null;
  if (fmt === RGBA32) return decodeRgba32(tiled, width, height);
  const tp = bytesPerBlock(fmt);
  return decodeDxt(untile(swap16(tiled), width, height, tp), width, height, fmt);
}

// HappyWars360StageParser.LoadPresPool: pointer entries in file order, each slice padded to 16 bytes.
// Returns Map(lower-case name -> bytes).
export function presPool(entries, pool) {
  const map = new Map();
  if (!entries || !pool) return map;
  let off = 0;
  for (const r of entries) {
    if (!r.pointer) continue;
    const size = r.size;
    if (size <= 0) continue;
    if (off + size <= pool.length && r.name) map.set(r.name.toLowerCase(), pool.slice(off, off + size));
    off += size;
    const rem = off % 16;
    if (rem !== 0) off += 16 - rem;
  }
  return map;
}

// char.IsLetterOrDigit for a byte cast to char (Latin-1).
function isLetterOrDigit(b) {
  return (
    (b >= 0x30 && b <= 0x39) ||
    (b >= 0x41 && b <= 0x5a) ||
    (b >= 0x61 && b <= 0x7a) ||
    b === 0xaa ||
    b === 0xb5 ||
    b === 0xba ||
    (b >= 0xc0 && b <= 0xff && b !== 0xd7 && b !== 0xf7)
  );
}

// TandaTextureCatalog.FindExternalBundleRefs: "..\name\" or "../name/" in the raw scene bytes.
export function findExternalBundleRefs(data) {
  const names = [];
  const seen = new Set();
  if (!data) return names;
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] !== 0x2e || data[i + 1] !== 0x2e) continue;
    let j = i + 2;
    if (j >= data.length || (data[j] !== 0x5c && data[j] !== 0x2f)) continue;
    j++;
    const start = j;
    while (j < data.length && (isLetterOrDigit(data[j]) || data[j] === 0x5f)) j++;
    if (j > start && j < data.length && (data[j] === 0x5c || data[j] === 0x2f)) {
      let name = '';
      for (let k = start; k < j; k++) name += data[k] < 0x80 ? String.fromCharCode(data[k]) : '?';
      if (!seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        names.push(name);
      }
    }
  }
  return names;
}

const stripExt = (name, ext) => (name.toLowerCase().endsWith(ext) ? name.slice(0, -ext.length) : name);

// TandaTextureCatalog.DecodePhy. Returns { name, width, height, format, rgba, note } or null without pool data.
function decodePhy(phyName, display, pool, virByName) {
  const data = pool.get(phyName.toLowerCase());
  if (!data || data.length === 0) return null;
  const logical = stripExt(phyName, '.phy');
  const entry = { name: display ?? logical, width: 0, height: 0, format: null, rgba: null, note: null };
  const vir = virByName.get((logical + '.vir').toLowerCase());
  if (!vir || vir.length < 44) {
    entry.note = 'no .vir descriptor';
    return entry;
  }
  const fmt = formatFromCode(vir[43]);
  let width = (vir[36] & 0x7f) * 128;
  if (!fmt) {
    entry.note = 'unsupported format 0x' + vir[43].toString(16).toUpperCase().padStart(2, '0');
    return entry;
  }
  let height;
  if (fmt === RGBA32 && width === 0) {
    const x = Math.sqrt(data.length / 4);
    let side = Math.round(x);
    if (Math.abs(x % 1) === 0.5) side = 2 * Math.round(x / 2); // Math.Round is banker's
    width = side;
    height = side;
  } else {
    height = heightForSize(fmt, width, data.length);
  }
  entry.format = FORMAT_NAMES[fmt];
  entry.width = width;
  entry.height = height;
  if (width < 1 || height < 1) {
    entry.note = 'could not derive dimensions';
    return entry;
  }
  try {
    entry.rgba = decodeX360(data, width, height, fmt);
    if (!entry.rgba) entry.note = 'decode failed';
  } catch (e) {
    entry.note = e.message;
  }
  return entry;
}

// TandaTextureCatalog.LoadBundle. readInDir(fileName) -> Promise<Uint8Array|null> reads a file next to the bundle.
async function loadBundle(bresName, prefix, readInDir, list, seen) {
  let entries;
  let pool;
  try {
    const raw = await readInDir(bresName);
    if (!raw) throw new Error('file not found');
    const bres = parseBres((await decodeLayers(raw)).payload);
    entries = bres.entries;
    pool = new Map();
    const presName = bresName.replace(/\.[^./\\]*$/, '') + '.pres';
    const presRaw = await readInDir(presName);
    if (presRaw) {
      let payload = null;
      try {
        payload = (await decodeLayers(presRaw)).payload;
      } catch {
        payload = null;
      }
      if (payload) pool = presPool(entries, payload);
    }
  } catch (e) {
    return `Could not read bundle '${bresName.split(/[\\/]/).pop()}': ${e.message}`;
  }
  if (!entries) return null;
  const virByName = new Map();
  for (const r of entries) if (r.name && !r.pointer && r.name.toLowerCase().endsWith('.vir')) virByName.set(r.name.toLowerCase(), r.data);
  for (const r of entries) {
    if (!r.name || !r.pointer || !r.name.toLowerCase().endsWith('.phy')) continue;
    const display = prefix + r.name.slice(0, -4);
    if (seen.has(display.toLowerCase())) continue;
    seen.add(display.toLowerCase());
    const entry = decodePhy(r.name, display, pool, virByName);
    if (entry) list.push(entry);
  }
  return null;
}

// TandaTextureCatalog.LoadCore: the scene's companion bundle, then the external bundles it references
// (..\shared\ -> shared.bres next to the companion). Returns { entries, error }.
export async function loadTandaTextures(tandaBytes, bresName, readInDir) {
  const list = [];
  if (!bresName) return { entries: list, error: 'No companion .bres/.pres bundle found for this scene.' };
  const seen = new Set();
  const error = await loadBundle(bresName, '', readInDir, list, seen);
  for (const bundle of findExternalBundleRefs(tandaBytes)) {
    const ext = bundle + '.bres';
    if (ext.toLowerCase() === bresName.toLowerCase()) continue;
    if (!(await readInDir(ext, true))) continue;
    await loadBundle(ext, bundle + '/', readInDir, list, seen);
  }
  return { entries: list, error };
}
