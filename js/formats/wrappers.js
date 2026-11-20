// The outer shells around Happy Wars assets (ports of HappyTool/Formats/BFBR.cs, BSRS.cs and ZRES.cs):
//   BFBR  Steam "wire" wrapper: "BFBR" + Blowfish-ECB over [u32 length + SHA-256(32) + payload + block padding]
//   BSRS  Windows 10 / Xbox One toybox wrapper: "BSRS" + u8 pad + Blowfish-ECB body (read-only, as in HappyTool)
//   ZRES  compression: "ZRES" + u32 uncompressed length + zlib stream
import { Blowfish } from './blowfish.js';
import { ascii4, concat, bytesEqual } from '../util.js';

const BFBR_KEY = '04B915BA43FEB5B6';
const BSRS_KEY = 'zj9ef2gWG5Fy53RaAqD2EcY42g7M7wTE';
let bfbrCipher = null;
let bsrsCipher = null;
const bfbr = () => (bfbrCipher ??= new Blowfish(BFBR_KEY));
const bsrs = () => (bsrsCipher ??= new Blowfish(BSRS_KEY));

async function streamThrough(u8, transform) {
  const stream = new Blob([u8]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---- BFBR ----------------------------------------------------------------------------------------------

export async function bfbrDecrypt(u8) {
  if (ascii4(u8) !== 'BFBR') throw new Error('Expected BFBR header');
  const body = u8.slice(4, 4 + ((u8.length - 4) & ~7));
  bfbr().decrypt(body);
  const view = new DataView(body.buffer);
  const size = view.getInt32(0, true);
  if (size <= 0 || 36 + size > body.length) throw new Error(`BFBR: invalid payload size ${size}`);
  const payload = body.slice(36, 36 + size);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
  if (!bytesEqual(hash, body.subarray(4, 36))) throw new Error('BFBR: SHA-256 of the payload does not match');
  return payload;
}

export async function bfbrEncrypt(payload) {
  const bodyLength = 4 + 32 + payload.length;
  const alignment = (8 - (bodyLength % 8)) % 8;
  const out = new Uint8Array(4 + bodyLength + alignment);
  out.set([0x42, 0x46, 0x42, 0x52], 0); // "BFBR"
  new DataView(out.buffer).setUint32(4, payload.length, true);
  out.set(new Uint8Array(await crypto.subtle.digest('SHA-256', payload)), 8);
  out.set(payload, 40);
  bfbr().encrypt(out.subarray(4));
  return out;
}

// ---- BSRS ----------------------------------------------------------------------------------------------

export function bsrsDecrypt(u8) {
  if (u8.length < 5 || ascii4(u8) !== 'BSRS') throw new Error('Expected BSRS header');
  const pad = u8[4];
  const bodyLength = u8.length - 5;
  const body = u8.slice(5, 5 + (bodyLength - (bodyLength % 8)));
  bsrs().decrypt(body);
  return body.subarray(0, Math.max(0, body.length - pad));
}

// ---- ZRES ----------------------------------------------------------------------------------------------

export async function zresDecompress(u8) {
  if (ascii4(u8) !== 'ZRES') throw new Error('Expected ZRES header');
  const size = new DataView(u8.buffer, u8.byteOffset).getInt32(4, true);
  if (size <= 0) throw new Error('ZRES: invalid payload size');
  if (u8[8] !== 0x78 || u8[9] !== 0x9c) throw new Error('ZRES: invalid zlib header');
  let out;
  try {
    // Same slice HappyTool inflates: the deflate body between the 2-byte zlib header and the Adler-32 trailer.
    out = await streamThrough(u8.subarray(10, u8.length - 4), new DecompressionStream('deflate-raw'));
  } catch (e) {
    out = await streamThrough(u8.subarray(8), new DecompressionStream('deflate'));
  }
  if (out.length !== size) throw new Error(`ZRES: inflated ${out.length} bytes, header says ${size}`);
  return out;
}

export async function zresCompress(payload) {
  const z = await streamThrough(payload, new CompressionStream('deflate')); // zlib: 78 9C + deflate + Adler-32
  const head = new Uint8Array(8);
  head.set([0x5a, 0x52, 0x45, 0x53], 0); // "ZRES"
  new DataView(head.buffer).setUint32(4, payload.length, true);
  return concat([head, z]);
}

// ---- layer chain ---------------------------------------------------------------------------------------

export const SHELLS = ['BFBR', 'BSRS', 'ZRES'];

/**
 * Strip every BFBR / BSRS / ZRES shell, outermost first.
 * @returns {Promise<{layers: string[], payload: Uint8Array}>}
 */
export async function decodeLayers(u8) {
  const layers = [];
  let cur = u8;
  for (let guard = 0; guard < 4; guard++) {
    const magic = ascii4(cur);
    if (magic === 'BFBR') cur = await bfbrDecrypt(cur);
    else if (magic === 'BSRS') cur = bsrsDecrypt(cur);
    else if (magic === 'ZRES') cur = await zresDecompress(cur);
    else break;
    layers.push(magic);
  }
  return { layers, payload: cur };
}

/** Put the shells back, innermost first. BSRS can't be re-applied (HappyTool doesn't either); it is dropped. */
export async function encodeLayers(payload, layers) {
  let cur = payload;
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i] === 'ZRES') cur = await zresCompress(cur);
    else if (layers[i] === 'BFBR') cur = await bfbrEncrypt(cur);
  }
  return cur;
}

export const writableLayers = (layers) => layers.filter((l) => l !== 'BSRS');
