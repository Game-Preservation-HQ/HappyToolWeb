// Scaleform movies: Happy Wars' .sgfx / .gfx (a SWF whose first three bytes read CFX or GFX instead of CWS or FWS) and
// plain .swf. The conversions are the desktop's HHelper.TryConvertSgfxBytesToSwf (bundle editor "Export SWF…") and the
// main window's "Convert To SGFX"; readMovieInfo reads the header and the tag list the way JPEXS FFDec does.

// ---------- detection and conversion ----------

const SIGS = new Set(['CFX', 'GFX', 'CWS', 'FWS']);
const sigOf = (u8) => (u8 && u8.length >= 3 ? String.fromCharCode(u8[0], u8[1], u8[2]) : '');

/** A Scaleform movie or an uncompressed / zlib SWF: CFX, GFX, CWS or FWS and a SWF version from 1 to 64. */
export function isScaleformMovie(u8) {
  return !!u8 && u8.length >= 8 && SIGS.has(sigOf(u8)) && u8[3] >= 1 && u8[3] <= 64;
}

/** SGFX (CFX / GFX) → SWF (CWS / FWS), the same length with the first three bytes changed. Throws the desktop's texts. */
export function sgfxToSwf(u8) {
  if (!u8 || u8.length < 3) throw new Error('SGFX data is too short.');
  const sig = sigOf(u8);
  if (sig !== 'CFX' && sig !== 'GFX') throw new Error('Not a recognized SGFX header (expected CFX or GFX).');
  const out = u8.slice();
  out.set(sig === 'CFX' ? [0x43, 0x57, 0x53] : [0x46, 0x57, 0x53]); // CWS / FWS
  return out;
}

/** SWF (CWS / FWS) → SGFX (CFX / GFX). The desktop's Convert To SGFX writes CFX over any header; this keeps FWS as GFX. */
export function swfToSgfx(u8) {
  if (!u8 || u8.length < 3) throw new Error('SWF data is too short.');
  const sig = sigOf(u8);
  if (sig !== 'CWS' && sig !== 'FWS') throw new Error('Not a recognized SWF header (expected CWS or FWS).');
  const out = u8.slice();
  out.set(sig === 'CWS' ? [0x43, 0x46, 0x58] : [0x47, 0x46, 0x58]); // CFX / GFX
  return out;
}

/** True when the first three bytes are CFX or GFX (the header TryConvertSgfxBytesToSwf converts). */
export const sgfxConverts = (u8) => !!u8 && u8.length >= 3 && (sigOf(u8) === 'CFX' || sigOf(u8) === 'GFX');

/** The bundle editor's IsSgfxEntryName: the entry name ends in .sgfx or .gfx (any case). */
export const isSgfxEntryName = (name) => /\.(sgfx|gfx)$/i.test(name || '');

/** BresBundleEditor.CanConvertSgfxEntry: an embedded entry with an .sgfx / .gfx name whose header converts. */
export const canExportSwf = (entry) => !!entry && !entry.pointer && isSgfxEntryName(entry.name) && sgfxConverts(entry.data);

// Path.GetInvalidFileNameChars on Windows: " < > | NUL, 1-31, : * ? \ /
const INVALID_NAME = /["<>|\x00-\x1f:*?\\/]/g;
const sanitizeSegment = (s) => (s ? s.replace(INVALID_NAME, '_') : '_');

/** .NET Path.ChangeExtension on a name without directory separators. */
function changeExtension(name, ext) {
  const dot = name.lastIndexOf('.');
  return (dot >= 0 ? name.slice(0, dot) : name) + ext;
}

/**
 * The file name the desktop's Export SWF… offers for a bundle entry: the last part of the entry name with invalid file
 * name characters as `_` and the extension changed to .swf (JpexsFfdecTool's staging path, as BresBundleEditor reads it).
 */
export function swfNameForEntry(entryName) {
  const name = entryName || 'flash.sgfx';
  if (/[\\/]/.test(name)) {
    // EntryNameToSwfRelativePath: split on / and \, sanitize each part, change the last part's extension.
    const parts = name.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.length ? changeExtension(sanitizeSegment(parts[parts.length - 1]), '.swf') : 'flash.swf';
  }
  // BundleEntryToRelativeSwfPath: Path.GetFileName (which also splits at the drive colon), sanitize, change extension.
  return changeExtension(sanitizeSegment(name.slice(name.lastIndexOf(':') + 1)), '.swf');
}

/** The .sgfx name for a .swf (the desktop's Convert To SGFX renames .swf to .sgfx). */
export const sgfxNameForSwf = (name) => changeExtension(sanitizeSegment(String(name || 'flash.swf').split(/[\\/]/).pop()), '.sgfx');

// ---------- reading bytes ----------

async function inflate(u8, format) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The movie's uncompressed bytes (CFX/CWS: zlib after the 8-byte header; GFX/FWS: as stored), or null. */
export async function decompressMovie(sgfx) {
  if (!sgfx || sgfx.length < 10) return null;
  const sig = String.fromCharCode(sgfx[0], sgfx[1], sgfx[2]);
  if (sig === 'GFX' || sig === 'FWS') return sgfx;
  if (sig !== 'CFX' && sig !== 'CWS') return null;
  let body;
  try {
    body = await inflate(sgfx.subarray(8), 'deflate');
  } catch {
    // As HappyTool: the raw deflate data after the 2-byte zlib header, checksum ignored.
    body = await inflate(sgfx.subarray(10, sgfx.length - 4), 'deflate-raw');
  }
  const out = new Uint8Array(8 + body.length);
  out.set(sgfx.subarray(0, 8));
  out.set(body, 8);
  return out;
}

export function u8At(b, p) {
  if (p < 0 || p >= b.length) throw new RangeError('past the end');
  return b[p];
}
export const u16 = (b, p) => u8At(b, p) | (u8At(b, p + 1) << 8);
export const i32 = (b, p) => u16(b, p) | (u16(b, p + 2) << 16);
const u32 = (b, p) => i32(b, p) >>> 0;

export class BitReader {
  constructor(b, pos) {
    this.b = b;
    this.pos = pos;
    this.bit = 0;
  }
  read(bits) {
    let v = 0;
    for (let i = 0; i < bits; i++) {
      v = (v << 1) | ((u8At(this.b, this.pos) >> (7 - this.bit)) & 1);
      if (++this.bit === 8) {
        this.bit = 0;
        this.pos++;
      }
    }
    return v;
  }
  signed(bits) {
    const v = this.read(bits);
    return bits && v & (1 << (bits - 1)) ? v - (1 << bits) : v;
  }
  get end() {
    return this.pos + (this.bit ? 1 : 0);
  }
}

export const rectLength = (b, pos) => ((5 + (u8At(b, pos) >> 3) * 4 + 7) / 8) | 0;

export function skipMatrix(b, pos) {
  const r = new BitReader(b, pos);
  if (r.read(1)) { const n = r.read(5); r.read(n); r.read(n); } // scale
  if (r.read(1)) { const n = r.read(5); r.read(n); r.read(n); } // rotate / skew
  { const n = r.read(5); r.read(n); r.read(n); } // translate
  return r.end;
}

export function skipColorTransform(b, pos) {
  const r = new BitReader(b, pos);
  const hasAdd = r.read(1), hasMul = r.read(1), n = r.read(4);
  const fields = (hasAdd ? 4 : 0) + (hasMul ? 4 : 0);
  for (let i = 0; i < fields; i++) r.read(n);
  return r.end;
}

export function readCString(b, at) {
  let p = at.p;
  while (u8At(b, p) !== 0) p++;
  const s = new TextDecoder().decode(b.subarray(at.p, p));
  at.p = p + 1;
  return s;
}

export function readPascalString(b, at) {
  const n = u8At(b, at.p++);
  if (at.p + n > b.length) throw new RangeError('past the end');
  const s = String.fromCharCode(...b.subarray(at.p, at.p + n));
  at.p += n;
  return s;
}

/** The tags from `pos` to `end` as `{code, data}`; stops at End (0) or a tag that runs past `end`. */
export function readTags(b, pos, end) {
  const tags = [];
  while (pos + 2 <= end) {
    const codeAndLength = u16(b, pos);
    const code = codeAndLength >> 6;
    let length = codeAndLength & 0x3f;
    let header = 2;
    if (length === 0x3f) {
      if (pos + 6 > end) break;
      length = i32(b, pos + 2);
      header = 6;
    }
    if (length < 0 || pos + header + length > end) break;
    tags.push({ code, data: b.subarray(pos + header, pos + header + length) });
    pos += header + length;
    if (code === 0) break;
  }
  return tags;
}

// ---------- the movie's header and tags ----------

/** Tag names as JPEXS FFDec 26.2.1 calls them (the ID and NAME constants of its tag classes). */
export const TAG_NAMES = {
  0: 'End', 1: 'ShowFrame', 2: 'DefineShape', 3: 'FreeCharacter', 4: 'PlaceObject', 5: 'RemoveObject', 6: 'DefineBits',
  7: 'DefineButton', 8: 'JPEGTables', 9: 'SetBackgroundColor', 10: 'DefineFont', 11: 'DefineText', 12: 'DoAction',
  13: 'DefineFontInfo', 14: 'DefineSound', 15: 'StartSound', 17: 'DefineButtonSound', 18: 'SoundStreamHead',
  19: 'SoundStreamBlock', 20: 'DefineBitsLossless', 21: 'DefineBitsJPEG2', 22: 'DefineShape2', 23: 'DefineButtonCxform',
  24: 'Protect', 25: 'PathsArePostScript', 26: 'PlaceObject2', 28: 'RemoveObject2', 29: 'SyncFrame', 31: 'FreeAll',
  32: 'DefineShape3', 33: 'DefineText2', 34: 'DefineButton2', 35: 'DefineBitsJPEG3', 36: 'DefineBitsLossless2',
  37: 'DefineEditText', 38: 'DefineVideo', 39: 'DefineSprite', 40: 'NameCharacter', 41: 'ProductInfo',
  42: 'DefineTextFormat', 43: 'FrameLabel', 45: 'SoundStreamHead2', 46: 'DefineMorphShape', 48: 'DefineFont2',
  49: 'GenCommand', 51: 'CharacterSet', 52: 'FontRef', 56: 'ExportAssets', 57: 'ImportAssets', 58: 'EnableDebugger',
  59: 'DoInitAction', 60: 'DefineVideoStream', 61: 'VideoFrame', 62: 'DefineFontInfo2', 63: 'DebugID',
  64: 'EnableDebugger2', 65: 'ScriptLimits', 66: 'SetTabIndex', 69: 'FileAttributes', 70: 'PlaceObject3',
  71: 'ImportAssets2', 72: 'DoABC', 73: 'DefineFontAlignZones', 74: 'CSMSettings', 75: 'DefineFont3', 76: 'SymbolClass',
  77: 'Metadata', 78: 'DefineScalingGrid', 82: 'DoABC2', 83: 'DefineShape4', 84: 'DefineMorphShape2',
  85: 'PlaceImagePrivate', 86: 'DefineSceneAndFrameLabelData', 87: 'DefineBinaryData', 88: 'DefineFontName',
  89: 'StartSound2', 90: 'DefineBitsJPEG4', 91: 'DefineFont4', 93: 'EnableTelemetry', 94: 'PlaceObject4',
  // Scaleform GFx's own tags
  1000: 'ExporterInfo', 1001: 'DefineExternalImage', 1002: 'FontTextureInfo', 1003: 'DefineExternalGradient',
  1004: 'DefineGradientMap', 1005: 'DefineCompactedFont', 1006: 'DefineExternalSound', 1007: 'DefineExternalStreamSound',
  1008: 'DefineSubImage', 1009: 'DefineExternalImage2',
};
export const tagName = (code) => TAG_NAMES[code] ?? `Unknown (${code})`;

/** Scaleform's tags hold their files and ids at fixed places: read what each one names, or null. */
export function readScaleformTag(code, d) {
  const at = { p: 0 };
  switch (code) {
    case 1000: { // ExporterInfo: version, [flags], bitmap format, prefix, SWF name
      const version = u16(d, 0);
      const long = version >= 0x10a;
      const flags = long ? u32(d, 2) : 0;
      const bitmapFormat = u16(d, long ? 6 : 2);
      at.p = long ? 8 : 4;
      const prefix = readPascalString(d, at);
      return { version, flags, bitmapFormat, prefix, swfName: readPascalString(d, at) };
    }
    case 1001: // DefineExternalImage: id, format, width, height, file name
      at.p = 8;
      return { id: u16(d, 0), format: u16(d, 2), width: u16(d, 4), height: u16(d, 6), file: readPascalString(d, at) };
    case 1002: // FontTextureInfo: texture id (32-bit), format, file name, …
      at.p = 6;
      return { id: u32(d, 0), format: u16(d, 4), file: readPascalString(d, at) };
    case 1003: // DefineExternalGradient: id, format, size, file name
      at.p = 6;
      return { id: u16(d, 0), format: u16(d, 2), size: u16(d, 4), file: readPascalString(d, at) };
    case 1006: { // DefineExternalSound: id, format, bits, channels, rate, samples, seek, export name, file name
      at.p = 20;
      const exportName = readPascalString(d, at);
      return { id: u16(d, 0), exportName, file: readPascalString(d, at) };
    }
    case 1007: // DefineExternalStreamSound: format, bits, channels, rate, samples, seek, start, last frame, file name
      at.p = 26;
      return { file: readPascalString(d, at) };
    case 1008: // DefineSubImage: id, image id, x1, y1, x2, y2
      return { id: u16(d, 0), image: u16(d, 2), x1: u16(d, 4), y1: u16(d, 6), x2: u16(d, 8), y2: u16(d, 10) };
    case 1009: { // DefineExternalImage2: image id, id type, format, width, height, export name, file name
      at.p = 10;
      const exportName = readPascalString(d, at);
      return { id: u16(d, 0), idType: u16(d, 2), format: u16(d, 4), width: u16(d, 6), height: u16(d, 8), exportName, file: readPascalString(d, at) };
    }
    default:
      return null;
  }
}

/** ExportAssets: `[{id, name}]`. ImportAssets / ImportAssets2: `{url, symbols: [{id, name}]}`. */
function readAssets(code, d) {
  const at = { p: 0 };
  const url = code === 56 ? null : readCString(d, at);
  if (code === 71) at.p += 2; // two reserved bytes
  const count = u16(d, at.p);
  at.p += 2;
  const symbols = [];
  for (let i = 0; i < count; i++) {
    const id = u16(d, at.p);
    at.p += 2;
    symbols.push({ id, name: readCString(d, at) });
  }
  return { url, symbols };
}

/**
 * What a movie holds: its header, every top-level tag with its offset and length, what it exports and imports, and the
 * files Scaleform's tags name. Throws when the header can't be read or the body can't be decompressed; a tag list that
 * stops early is reported in `problem`.
 */
export async function readMovieInfo(u8) {
  if (!u8 || u8.length < 8) throw new Error('A movie needs at least 8 bytes of header.');
  const signature = sigOf(u8);
  if (!SIGS.has(signature)) throw new Error(`Not a Scaleform movie or SWF (starts with ${JSON.stringify(signature)}).`);
  const compressed = signature[0] === 'C';
  const version = u8[3];
  const declaredLength = u32(u8, 4);
  let swf;
  try {
    swf = await decompressMovie(u8);
  } catch (e) {
    throw new Error(`The zlib body could not be decompressed: ${e.message}`);
  }
  if (!swf) throw new Error('The movie is too short to hold a header.');

  const r = new BitReader(swf, 8);
  const bits = r.read(5);
  const [xMin, xMax, yMin, yMax] = [r.signed(bits), r.signed(bits), r.signed(bits), r.signed(bits)];
  const after = r.end;
  const frameRate = u16(swf, after) / 256;
  const frameCount = u16(swf, after + 2);
  const headerLength = after + 4;

  const tags = [];
  const exports = [];
  const imports = [];
  const files = [];
  const subImages = [];
  let exporter = null;
  let problem = null;
  let showFrames = 0;
  let pos = headerLength;
  const end = swf.length;
  while (pos < end) {
    if (pos + 2 > end) {
      problem = `A tag header at ${pos} runs past the end of the movie (${end} bytes).`;
      break;
    }
    const codeAndLength = u16(swf, pos);
    const code = codeAndLength >> 6;
    let length = codeAndLength & 0x3f;
    let header = 2;
    if (length === 0x3f) {
      if (pos + 6 > end) {
        problem = `The long tag header at ${pos} runs past the end of the movie (${end} bytes).`;
        break;
      }
      length = u32(swf, pos + 2);
      header = 6;
    }
    if (pos + header + length > end) {
      problem = `${tagName(code)} at ${pos} says it is ${length} bytes long, past the end of the movie (${end} bytes).`;
      break;
    }
    const data = swf.subarray(pos + header, pos + header + length);
    tags.push({ code, name: tagName(code), offset: pos, header, length });
    pos += header + length;
    try {
      if (code === 1) showFrames++;
      else if (code === 56) exports.push(...readAssets(code, data).symbols);
      else if (code === 57 || code === 71) imports.push(readAssets(code, data));
      else if (code >= 1000 && code <= 1009) {
        const t = readScaleformTag(code, data);
        if (code === 1000) exporter = t;
        else if (code === 1008) subImages.push(t);
        else if (t?.file !== undefined) files.push({ tag: tagName(code), ...t });
      }
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      problem ??= `${tagName(code)} at ${tags[tags.length - 1].offset} is shorter than its fields.`;
    }
    if (code === 0) break;
  }
  if (!problem && pos !== end) problem = `The End tag is at ${tags[tags.length - 1].offset}; ${end - pos} more bytes follow it.`;
  else if (!problem && tags[tags.length - 1]?.code !== 0) problem = 'The movie has no End tag.';

  return {
    signature,
    compressed,
    version,
    declaredLength,
    length: swf.length,
    stage: { xMin, xMax, yMin, yMax },
    width: (xMax - xMin) / 20,
    height: (yMax - yMin) / 20,
    frameRate,
    frameCount,
    showFrames,
    headerLength,
    tags,
    tagsEnd: pos,
    exports,
    imports,
    exporter,
    files,
    subImages,
    problem,
  };
}
