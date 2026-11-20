// DDS preview: decodes the top mip level of DXT1/DXT3/DXT5, ATI1/ATI2 (BC4/BC5), DX10 BC1-BC5 and
// uncompressed 8/16/24/32-bit textures to RGBA8. Faces past the first and BC6H/BC7 are not decoded.
import { ascii4 } from '../util.js';

const DX10_FORMATS = {
  71: 'DXT1', 72: 'DXT1', 74: 'DXT3', 75: 'DXT3', 77: 'DXT5', 78: 'DXT5', 80: 'ATI1', 81: 'ATI1', 83: 'ATI2', 84: 'ATI2',
  87: 'BGRA8', 88: 'BGRX8', 28: 'RGBA8', 29: 'RGBA8',
};

export const isDds = (u8) => ascii4(u8) === 'DDS ';

export function ddsInfo(u8) {
  if (!isDds(u8) || u8.length < 128) throw new Error('Not a DDS file');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const height = dv.getUint32(12, true);
  const width = dv.getUint32(16, true);
  const mips = Math.max(1, dv.getUint32(28, true));
  const pfFlags = dv.getUint32(80, true);
  let fourCC = ascii4(u8, 84);
  const bits = dv.getUint32(88, true);
  const masks = [92, 96, 100, 104].map((o) => dv.getUint32(o, true));
  let dataOffset = 128;
  let format;
  if (pfFlags & 0x4) {
    if (fourCC === 'DX10') {
      const dxgi = dv.getUint32(128, true);
      dataOffset = 148;
      format = DX10_FORMATS[dxgi] || `DXGI ${dxgi}`;
    } else if (fourCC === 'BC4U' || fourCC === 'BC4S') format = 'ATI1';
    else if (fourCC === 'BC5U' || fourCC === 'BC5S') format = 'ATI2';
    else format = fourCC;
  } else {
    fourCC = '';
    format = `RGB${bits}`;
  }
  return { width, height, mips, format, bits, masks, dataOffset, flags: pfFlags };
}

function rgb565(c) {
  return [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
}

function colorBlock(u8, off, out, w, h, bx, by, dxt1) {
  const c0 = u8[off] | (u8[off + 1] << 8);
  const c1 = u8[off + 2] | (u8[off + 3] << 8);
  const a = rgb565(c0);
  const b = rgb565(c1);
  const pal = [[...a, 255], [...b, 255]];
  if (!dxt1 || c0 > c1) {
    pal.push([(2 * a[0] + b[0]) / 3, (2 * a[1] + b[1]) / 3, (2 * a[2] + b[2]) / 3, 255]);
    pal.push([(a[0] + 2 * b[0]) / 3, (a[1] + 2 * b[1]) / 3, (a[2] + 2 * b[2]) / 3, 255]);
  } else {
    pal.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, 255]);
    pal.push([0, 0, 0, 0]);
  }
  const bitsWord = u8[off + 4] | (u8[off + 5] << 8) | (u8[off + 6] << 16) | (u8[off + 7] << 24);
  for (let i = 0; i < 16; i++) {
    const x = bx + (i & 3);
    const y = by + (i >> 2);
    if (x >= w || y >= h) continue;
    const p = pal[(bitsWord >>> (2 * i)) & 3];
    const o = (y * w + x) * 4;
    out[o] = p[0];
    out[o + 1] = p[1];
    out[o + 2] = p[2];
    out[o + 3] = p[3];
  }
}

/** 8 bytes of BC4-style interpolated values → 16 values. */
function alphaBlock(u8, off) {
  const a0 = u8[off];
  const a1 = u8[off + 1];
  const pal = [a0, a1];
  if (a0 > a1) for (let i = 1; i < 7; i++) pal.push(((7 - i) * a0 + i * a1) / 7);
  else {
    for (let i = 1; i < 5; i++) pal.push(((5 - i) * a0 + i * a1) / 5);
    pal.push(0, 255);
  }
  const vals = new Array(16);
  let bitsLo = u8[off + 2] | (u8[off + 3] << 8) | (u8[off + 4] << 16);
  let bitsHi = u8[off + 5] | (u8[off + 6] << 8) | (u8[off + 7] << 16);
  for (let i = 0; i < 8; i++) vals[i] = pal[(bitsLo >> (3 * i)) & 7];
  for (let i = 0; i < 8; i++) vals[8 + i] = pal[(bitsHi >> (3 * i)) & 7];
  return vals;
}

function putChannel(out, w, h, bx, by, vals, ch) {
  for (let i = 0; i < 16; i++) {
    const x = bx + (i & 3);
    const y = by + (i >> 2);
    if (x < w && y < h) out[(y * w + x) * 4 + ch] = vals[i];
  }
}

function maskShift(mask) {
  if (!mask) return { shift: 0, max: 0 };
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift++;
  return { shift, max: mask >>> shift };
}

/** @returns {{width:number, height:number, rgba: Uint8ClampedArray, info: object}} */
export function decodeDds(u8) {
  const info = ddsInfo(u8);
  const { width: w, height: h, format } = info;
  if (!w || !h || w > 16384 || h > 16384) throw new Error(`Unsupported DDS size ${w}×${h}`);
  const out = new Uint8ClampedArray(w * h * 4);
  let off = info.dataOffset;
  const bw = Math.ceil(w / 4);
  const bh = Math.ceil(h / 4);
  const need = (n) => {
    if (off + n > u8.length) throw new Error('DDS data is truncated');
  };
  switch (format) {
    case 'DXT1':
      need(bw * bh * 8);
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++, off += 8) colorBlock(u8, off, out, w, h, bx * 4, by * 4, true);
      break;
    case 'DXT2':
    case 'DXT3':
      need(bw * bh * 16);
      for (let by = 0; by < bh; by++)
        for (let bx = 0; bx < bw; bx++, off += 16) {
          colorBlock(u8, off + 8, out, w, h, bx * 4, by * 4, false);
          const vals = [];
          for (let i = 0; i < 8; i++) vals.push((u8[off + i] & 15) * 17, (u8[off + i] >> 4) * 17);
          putChannel(out, w, h, bx * 4, by * 4, vals, 3);
        }
      break;
    case 'DXT4':
    case 'DXT5':
      need(bw * bh * 16);
      for (let by = 0; by < bh; by++)
        for (let bx = 0; bx < bw; bx++, off += 16) {
          colorBlock(u8, off + 8, out, w, h, bx * 4, by * 4, false);
          putChannel(out, w, h, bx * 4, by * 4, alphaBlock(u8, off), 3);
        }
      break;
    case 'ATI1':
      need(bw * bh * 8);
      for (let by = 0; by < bh; by++)
        for (let bx = 0; bx < bw; bx++, off += 8) {
          const v = alphaBlock(u8, off);
          for (let ch = 0; ch < 3; ch++) putChannel(out, w, h, bx * 4, by * 4, v, ch);
          putChannel(out, w, h, bx * 4, by * 4, new Array(16).fill(255), 3);
        }
      break;
    case 'ATI2':
      need(bw * bh * 16);
      for (let by = 0; by < bh; by++)
        for (let bx = 0; bx < bw; bx++, off += 16) {
          putChannel(out, w, h, bx * 4, by * 4, alphaBlock(u8, off), 0);
          putChannel(out, w, h, bx * 4, by * 4, alphaBlock(u8, off + 8), 1);
          putChannel(out, w, h, bx * 4, by * 4, new Array(16).fill(0), 2);
          putChannel(out, w, h, bx * 4, by * 4, new Array(16).fill(255), 3);
        }
      break;
    case 'BGRA8':
    case 'BGRX8':
    case 'RGBA8': {
      need(w * h * 4);
      const swap = format !== 'RGBA8';
      for (let i = 0; i < w * h; i++, off += 4) {
        out[i * 4] = u8[off + (swap ? 2 : 0)];
        out[i * 4 + 1] = u8[off + 1];
        out[i * 4 + 2] = u8[off + (swap ? 0 : 2)];
        out[i * 4 + 3] = format === 'BGRX8' ? 255 : u8[off + 3];
      }
      break;
    }
    default: {
      if (!format.startsWith('RGB')) throw new Error(`DDS format ${format} is not supported for preview`);
      const bytes = info.bits / 8;
      if (![1, 2, 3, 4].includes(bytes)) throw new Error(`DDS: ${info.bits}-bit pixels are not supported`);
      need(w * h * bytes);
      const hasAlpha = (info.flags & 0x1) !== 0 || (info.flags & 0x2) !== 0;
      const luminance = (info.flags & 0x20000) !== 0;
      const ms = info.masks.map(maskShift);
      for (let i = 0; i < w * h; i++, off += bytes) {
        let px = 0;
        for (let b = 0; b < bytes; b++) px |= u8[off + b] << (8 * b);
        px >>>= 0;
        const chan = (k) => (ms[k].max ? (((px & info.masks[k]) >>> ms[k].shift) * 255) / ms[k].max : 0);
        if (luminance) {
          const l = chan(0);
          out.set([l, l, l, hasAlpha ? chan(3) : 255], i * 4);
        } else out.set([chan(0), chan(1), chan(2), hasAlpha && ms[3].max ? chan(3) : 255], i * 4);
      }
    }
  }
  return { width: w, height: h, rgba: out, info };
}
