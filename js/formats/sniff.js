// Decide which viewer a payload gets, by content first and extension second.
import { ascii4, extOf, looksLikeText } from '../util.js';
import { isBres } from './bres.js';
import { isDds } from './dds.js';
import { looksLikeLngHeader, parseLng } from './lng.js';
import { looksLikeRml } from './rml.js';

const TEXT_EXT = new Set(['.txt', '.xml', '.csv', '.cfg', '.ini', '.nut', '.lua', '.html', '.htm', '.js', '.css', '.yml', '.yaml', '.md', '.log', '.shader', '.fx', '.hlsl']);
const IMAGE_MAGIC = [
  [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x47, 0x49, 0x46, 0x38], 'image/gif'],
  [[0x42, 0x4d], 'image/bmp'],
];

export const KIND_LABELS = {
  bres: 'Bundle',
  lng: 'Text table',
  json: 'JSON',
  text: 'Text',
  dds: 'DDS texture',
  image: 'Image',
  nutc: 'Compiled script',
  vmd: 'Voice macro',
  rml: 'Material definition',
  hex: 'Binary',
};

function firstNonSpace(u8) {
  let i = 0;
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) i = 3;
  while (i < u8.length && (u8[i] === 0x20 || u8[i] === 0x09 || u8[i] === 0x0a || u8[i] === 0x0d)) i++;
  return u8[i];
}

/** @returns {{kind: string, mime?: string}} */
export function sniff(u8, name = '') {
  const ext = extOf(name);
  if (isBres(u8)) return { kind: 'bres' };
  if (isDds(u8)) return { kind: 'dds' };
  for (const [magic, mime] of IMAGE_MAGIC) if (magic.every((b, i) => u8[i] === b)) return { kind: 'image', mime };
  if (u8.length >= 2 && u8[0] === 0xfa && u8[1] === 0xfa) return { kind: 'nutc' }; // Squirrel bytecode
  if (ext === '.vmd') return { kind: 'vmd' }; // the desktop opens .vmd by name; a bad header shows its error
  if (looksLikeRml(u8) || ext === '.rml') return { kind: 'rml' }; // bundles open any 0MF entry (.rmd too) as a material
  if (ext === '.lng' || (looksLikeLngHeader(u8) && !looksLikeText(u8))) {
    try {
      parseLng(u8);
      return { kind: 'lng' };
    } catch {
      /* fall through */
    }
  }
  const c = firstNonSpace(u8);
  if ((ext === '.json' || c === 0x7b || c === 0x5b) && looksLikeText(u8)) return { kind: 'json' };
  if (TEXT_EXT.has(ext) && (looksLikeText(u8) || u8.length === 0)) return { kind: 'text' };
  if (looksLikeText(u8) && u8.length > 0) return { kind: 'text' };
  if (u8[0] === 0xff && u8[1] === 0xfe) return { kind: 'text' };
  return { kind: 'hex' };
}

export const describeMagic = (u8) => {
  const m = ascii4(u8);
  return /^[\x20-\x7e]{4}$/.test(m) ? m : Array.from(u8.subarray(0, 4), (b) => b.toString(16).padStart(2, '0')).join(' ');
};
