// .lng text resources (port of HappyTool/TextResource/TextResourceLngCatalog.cs).
// Header: Fire, Ver, LangNum, NumOffset (16), then LangNum u32 block offsets (padded to 4 entries).
// Each language block: 32-byte ASCII name, MaxWord, LabelOff, DataOff, pad; then MaxWord (labelIdx, strIdx)
// pairs; an ASCII label pool; a UTF-16 string pool (indices in characters). Xbox 360 / Happy Dungeons files
// are big-endian.

const MAX_LANGUAGES = 16;
const MAX_KEY_BYTES = 256;

function int32(u8, off, be) {
  return be
    ? (u8[off] << 24) | (u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3]
    : u8[off] | (u8[off + 1] << 8) | (u8[off + 2] << 16) | (u8[off + 3] << 24);
}

function detectBigEndian(u8) {
  if (u8.length < 16) return false;
  const langLe = int32(u8, 8, false);
  const langBe = int32(u8, 8, true);
  const offLe = int32(u8, 12, false);
  const offBe = int32(u8, 12, true);
  const leLangOk = langLe > 0 && langLe <= MAX_LANGUAGES;
  const beLangOk = langBe > 0 && langBe <= MAX_LANGUAGES;
  const leOk = leLangOk && offLe >= 16 && offLe < u8.length;
  const beOk = beLangOk && offBe >= 16 && offBe < u8.length;
  if (leOk && !beOk) return false;
  if (beOk && !leOk) return true;
  if (leOk && beOk) {
    if (offBe === 16 && offLe !== 16) return true;
    if (offLe === 16 && offBe !== 16) return false;
  }
  return !leLangOk && beLangOk;
}

/** Fast header check, as HappyTool uses to classify pack entries. */
export function looksLikeLngHeader(u8) {
  if (!u8 || u8.length < 32) return false;
  const be = detectBigEndian(u8);
  const langNum = int32(u8, 8, be);
  const numOffset = int32(u8, 12, be);
  return langNum > 0 && langNum <= MAX_LANGUAGES && numOffset >= 16 && numOffset < u8.length && numOffset + langNum * 4 <= u8.length;
}

function cstrAscii(u8, off, end) {
  let s = '';
  while (off < end && u8[off] !== 0) s += String.fromCharCode(u8[off++]);
  return s;
}

function cstrUtf16(u8, off, end, be) {
  const codes = [];
  while (off + 1 < end) {
    const ch = be ? (u8[off] << 8) | u8[off + 1] : u8[off] | (u8[off + 1] << 8);
    if (ch === 0) break;
    codes.push(ch);
    off += 2;
  }
  let s = '';
  for (let i = 0; i < codes.length; i += 8192) s += String.fromCharCode.apply(null, codes.slice(i, i + 8192));
  return s;
}

const asciiByte = (c) => (c > 0x7f ? 0x3f : c); // .NET's ASCII encoder writes '?' for anything else
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @typedef {{key: string, text: string}} LngEntry
 * @typedef {{name: string, entries: LngEntry[]}} LngLanguage
 * @typedef {{fire: number, ver: number, bigEndian: boolean, languages: LngLanguage[]}} LngFile
 * @returns {LngFile}
 */
export function parseLng(u8) {
  if (u8.length < 32) throw new Error('File is too small to be a valid .lng file.');
  const be = detectBigEndian(u8);
  const langNum = int32(u8, 8, be);
  if (langNum <= 0 || langNum > MAX_LANGUAGES) throw new Error(`Unsupported language count: ${langNum}`);
  const numOffset = int32(u8, 12, be);
  if (numOffset < 16 || numOffset >= u8.length) throw new Error(`Invalid language table offset: ${numOffset}`);
  const offsets = [];
  for (let i = 0; i < langNum; i++) offsets.push(int32(u8, numOffset + i * 4, be));
  const tablePad = langNum % 4 !== 0 ? (4 - (langNum % 4)) * 4 : 0;
  const dataBase = numOffset + langNum * 4 + tablePad;

  const file = { fire: int32(u8, 0, be), ver: int32(u8, 4, be), bigEndian: be, languages: [] };
  for (let li = 0; li < langNum; li++) {
    const start = dataBase + offsets[li];
    if (start + 48 > u8.length) throw new Error('Language header is out of range.');
    const name = cstrAscii(u8, start, start + 32) || `Lang_${li}`;
    const maxWord = int32(u8, start + 32, be);
    const labelPool = start + int32(u8, start + 36, be);
    const stringPool = start + int32(u8, start + 40, be);
    if (labelPool > u8.length || stringPool > u8.length || labelPool > stringPool)
      throw new Error(`Invalid pool offsets for language ${name}.`);
    const entries = [];
    for (let i = 0; i < maxWord; i++) {
      const entryOff = start + 48 + i * 8;
      if (entryOff + 8 > labelPool) break;
      const key = cstrAscii(u8, labelPool + int32(u8, entryOff, be), stringPool);
      const text = cstrUtf16(u8, stringPool + int32(u8, entryOff + 4, be) * 2, u8.length, be);
      if (key.length > 0) entries.push({ key, text });
    }
    entries.sort((a, b) => ordinal(a.key, b.key));
    file.languages.push({ name, entries });
  }
  return file;
}

/** Problems that would stop a save (same rules as HappyTool's ValidateForSave). */
export function validateLng(file) {
  const problems = [];
  if (file.languages.length === 0 || file.languages.length > MAX_LANGUAGES)
    problems.push(`A .lng file holds 1 to ${MAX_LANGUAGES} languages (this one has ${file.languages.length})`);
  for (const lang of file.languages) {
    if ((lang.name || '').length >= 32) problems.push(`Language name too long: ${lang.name}`);
    const seen = new Set();
    for (const e of lang.entries) {
      const key = (e.key || '').trim();
      if (!key) continue;
      if (/[^\x00-\x7f]/.test(key)) problems.push(`[${lang.name}] key is not ASCII: ${key}`);
      if (key.length >= MAX_KEY_BYTES) problems.push(`[${lang.name}] key too long: ${key.slice(0, 40)}…`);
      if (seen.has(key)) problems.push(`[${lang.name}] duplicate key: ${key}`);
      seen.add(key);
    }
  }
  return problems;
}

/** Serialise an LngFile exactly as HappyTool's Save does. */
export function writeLng(file) {
  const be = file.bigEndian;
  const langs = file.languages.map((lang) => {
    const entries = lang.entries
      .filter((e) => e.key && e.key.trim())
      .map((e) => ({ key: e.key.trim(), text: e.text ?? '' }))
      .sort((a, b) => ordinal(a.key, b.key));
    const labelIdx = [];
    const strIdx = [];
    let labels = '';
    let strings = '';
    entries.forEach((e, i) => {
      labelIdx.push(i === 0 ? 0 : labels.length + 1);
      strIdx.push(i === 0 ? 0 : strings.length + 1);
      labels = i === 0 ? e.key : `${labels}\0${e.key}`;
      strings = i === 0 ? e.text : `${strings}\0${e.text}`;
    });
    labels = entries.length === 0 ? '\0' : `${labels}\0`;
    strings = entries.length === 0 ? '\0' : `${strings}\0`;
    const pad16 = (n) => (n % 16 !== 0 ? 16 - (n % 16) : 0);
    const indexBytes = entries.length * 8 + (entries.length % 2 !== 0 ? 8 : 0);
    const labelBytes = labels.length + pad16(labels.length);
    const stringBytes = strings.length * 2 + pad16(strings.length * 2);
    return { name: lang.name || '', entries, labelIdx, strIdx, labels, strings, indexBytes, labelBytes, stringBytes };
  });

  const langNum = langs.length;
  const tablePad = langNum % 4 !== 0 ? (4 - (langNum % 4)) * 4 : 0;
  let total = 16 + langNum * 4 + tablePad;
  const blockOffsets = [];
  let running = 0;
  for (const l of langs) {
    blockOffsets.push(running);
    running += 48 + l.indexBytes + l.labelBytes + l.stringBytes;
  }
  total += running;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let pos = 0;
  const wi = (v) => {
    dv.setInt32(pos, v, !be);
    pos += 4;
  };
  wi(file.fire);
  wi(file.ver);
  wi(langNum);
  wi(16);
  blockOffsets.forEach(wi);
  pos += tablePad;
  for (const l of langs) {
    const start = pos;
    for (let i = 0; i < Math.min(l.name.length, 31); i++) out[pos + i] = asciiByte(l.name.charCodeAt(i));
    pos += 32;
    wi(l.entries.length);
    wi(48 + l.indexBytes);
    wi(48 + l.indexBytes + l.labelBytes);
    wi(0);
    for (let i = 0; i < l.entries.length; i++) {
      wi(l.labelIdx[i]);
      wi(l.strIdx[i]);
    }
    pos = start + 48 + l.indexBytes;
    for (let i = 0; i < l.labels.length; i++) out[pos + i] = asciiByte(l.labels.charCodeAt(i));
    pos += l.labelBytes;
    for (let i = 0; i < l.strings.length; i++) {
      const c = l.strings.charCodeAt(i);
      out[pos + i * 2] = be ? c >> 8 : c & 0xff;
      out[pos + i * 2 + 1] = be ? c & 0xff : c >> 8;
    }
    pos += l.stringBytes;
  }
  return out;
}
