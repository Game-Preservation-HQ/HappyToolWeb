// RRM model / stage-terrain geometry, ported from HappyTool/RrmConvert/RrmModelParser.cs
// (TryParse, TryParseStage and their stream helpers). Little- and big-endian headers for TryParse; stage
// texturing (batches, normals, UV1) is little-endian only, as on the desktop.

const MAX_VC = 8_000_000;
const MAX_IC = 24_000_000;

const STAGE_MAT_PTR = 0x140;
const STAGE_MAT_COUNT = 0x144;
const STAGE_BATCH_COUNT = 0x154;
const STAGE_MAT_PREFIX = 0xc0;
const STAGE_MAT_STRIDE = 0x390;
const STAGE_MAT_ATLAS = 0x100;
const STAGE_MAT_SRC = 0x80;
const STAGE_BATCH_TABLE = 0x1e0;
const STAGE_BATCH_STRIDE = 0xe0;
const STAGE_NORMAL_PTR = 0x170;
const STAGE_RECORD_BASE = 0xc0;
const STAGE_UV1_PTR = 0x180;

const isRestart = (u) => u === 0xffffffff || u === 0xfffffffe;

function reader(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return {
    u32: (o, be = false) => dv.getUint32(o, !be),
    f32: (o, be = false) => dv.getFloat32(o, !be),
  };
}

const looksLikeLeHeader = (r) => {
  const v = r.u32(0);
  return v > 19000000 && v < 21000000;
};

const rangeOk = (u8, off, size) => off >= 0 && size >= 0 && off < u8.length && off + size <= u8.length;

export function readFixedAscii(u8, off, max) {
  if (off < 0 || off >= u8.length) return null;
  let end = off;
  const limit = Math.min(u8.length, off + max);
  while (end < limit && u8[end] !== 0) end++;
  return end > off ? String.fromCharCode(...u8.subarray(off, end)) : null;
}

export function stripTextureExtension(name) {
  if (!name) return null;
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (slash >= 0) name = name.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  if (dot > 0) name = name.slice(0, dot);
  return name;
}

function looksLikeUvFloat2(u8, r, off, vc, be) {
  if (vc <= 0 || !rangeOk(u8, off, vc * 8)) return false;
  const check = Math.min(vc, 12);
  let ok = 0;
  for (let i = 0; i < check; i++) {
    const u = r.f32(off + i * 8, be);
    const v = r.f32(off + i * 8 + 4, be);
    if (!Number.isFinite(u) || !Number.isFinite(v) || Math.abs(u) > 1e5 || Math.abs(v) > 1e5) continue;
    ok++;
  }
  return ok >= Math.min(4, check);
}

function readUvStream(u8, r, off, vc, be) {
  if (vc <= 0 || !rangeOk(u8, off, vc * 8)) return null;
  const out = new Float32Array(vc * 2);
  for (let i = 0; i < vc * 2; i++) out[i] = r.f32(off + i * 4, be);
  return out;
}

export function trianglesFromList(entries, vc) {
  const out = [];
  for (let i = 0; i + 2 < entries.length; i += 3) {
    const a = entries[i], b = entries[i + 1], c = entries[i + 2];
    if (isRestart(a) || isRestart(b) || isRestart(c)) continue;
    if (a >= vc || b >= vc || c >= vc || a === b || b === c || a === c) continue;
    out.push(a, b, c);
  }
  return out;
}

export function trianglesFromStrip(entries, vc) {
  const out = [];
  let parity = 0, p1 = -1, p2 = -1;
  for (const u of entries) {
    if (isRestart(u) || u >= vc) {
      parity = 0;
      p1 = p2 = -1;
      continue;
    }
    if (p1 < 0) { p1 = u; continue; }
    if (p2 < 0) { p2 = u; continue; }
    let a = p1, b = p2;
    const c = u;
    if (parity & 1) [a, b] = [b, a];
    if (a !== b && b !== c && a !== c) out.push(a, b, c);
    p1 = p2;
    p2 = u;
    parity++;
  }
  return out;
}

function scoreTriangles(pos, idx) {
  if (idx.length < 3) return -Infinity;
  const vc = pos.length / 3;
  let area = 0, valid = 0, degenerate = 0;
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    if (idx[i] >= vc || idx[i + 1] >= vc || idx[i + 2] >= vc) continue;
    const abx = pos[b] - pos[a], aby = pos[b + 1] - pos[a + 1], abz = pos[b + 2] - pos[a + 2];
    const acx = pos[c] - pos[a], acy = pos[c + 1] - pos[a + 1], acz = pos[c + 2] - pos[a + 2];
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    const a2 = Math.hypot(nx, ny, nz);
    if (a2 < 1e-7) { degenerate++; continue; }
    area += a2;
    valid++;
  }
  return valid * 10 + area - degenerate * 25;
}

function scoreUvUsability(pos, idx, uvs) {
  const vc = pos.length / 3;
  if (!uvs || uvs.length !== vc * 2 || idx.length < 3) return -Infinity;
  let good = 0, collapsed = 0;
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const ia = idx[i], ib = idx[i + 1], ic = idx[i + 2];
    const a = ia * 3, b = ib * 3, c = ic * 3;
    const abx = pos[b] - pos[a], aby = pos[b + 1] - pos[a + 1], abz = pos[b + 2] - pos[a + 2];
    const acx = pos[c] - pos[a], acy = pos[c + 1] - pos[a + 1], acz = pos[c + 2] - pos[a + 2];
    const area = Math.hypot(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx);
    if (area < 1e-7) continue;
    const u0 = uvs[ia * 2], v0 = uvs[ia * 2 + 1], u1 = uvs[ib * 2], v1 = uvs[ib * 2 + 1], u2 = uvs[ic * 2], v2 = uvs[ic * 2 + 1];
    if (Math.abs((u1 - u0) * (v2 - v0) - (v1 - v0) * (u2 - u0)) < 1e-8) collapsed += area;
    else good += area;
  }
  return good - collapsed * 2;
}

function looksLikeUnitNormals(u8, r, off, vc) {
  if (vc <= 0 || !rangeOk(u8, off, vc * 12)) return false;
  const check = Math.min(vc, 32);
  let valid = 0, unit = 0;
  for (let i = 0; i < check; i++) {
    const x = r.f32(off + i * 12), y = r.f32(off + i * 12 + 4), z = r.f32(off + i * 12 + 8);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    valid++;
    const m = Math.hypot(x, y, z);
    if (m > 0.9 && m < 1.1) unit++;
  }
  return valid > 0 && unit >= Math.floor((valid * 3 + 3) / 4);
}

function readStageNormals(u8, r, be, vc) {
  if (vc <= 0 || be) return null;
  const hdr = r.u32(STAGE_NORMAL_PTR) + STAGE_RECORD_BASE;
  const calc = r.u32(0xb4) + vc * 12;
  for (const cand of hdr === calc ? [calc] : [hdr, calc]) {
    if (!rangeOk(u8, cand, vc * 12) || !looksLikeUnitNormals(u8, r, cand, vc)) continue;
    const out = new Float32Array(vc * 3);
    for (let i = 0; i < vc * 3; i++) out[i] = r.f32(cand + i * 4);
    return out;
  }
  return null;
}

function readStageUv0(u8, r, be, vc) {
  if (vc <= 0 || be) return null;
  const base = r.u32(0xb4);
  const bones = r.u32(0x14c);
  const shift = bones > 0 && bones <= 64 ? vc * 20 : 0;
  let off = base + vc * 40 + shift;
  if (!rangeOk(u8, off, vc * 8)) {
    off = base + vc * 40;
    if (!rangeOk(u8, off, vc * 8)) return null;
  }
  return readUvStream(u8, r, off, vc, false);
}

function readStageUv1(u8, r, vc, uv0) {
  if (vc <= 0 || !uv0 || uv0.length !== vc * 2) return null;
  const bones = r.u32(0x14c);
  const shift = bones > 0 && bones <= 64 ? vc * 20 : 0;
  const after = r.u32(0xb4) + vc * 48 + shift;
  const hdr = r.u32(STAGE_UV1_PTR) + STAGE_RECORD_BASE;
  for (const cand of hdr === after ? [after] : [hdr, after]) {
    if (cand <= 0 || !rangeOk(u8, cand, vc * 8)) continue;
    const uvs = readUvStream(u8, r, cand, vc, false);
    let finite = true, minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < vc && finite; i++) {
      const u = uvs[i * 2], v = uvs[i * 2 + 1];
      if (!Number.isFinite(u) || !Number.isFinite(v) || Math.abs(u) > 64 || Math.abs(v) > 64) finite = false;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    if (finite && (maxU - minU > 1e-4 || maxV - minV > 1e-4)) return uvs;
  }
  return null;
}

/**
 * Plain RRM mesh: positions, triangle indices (list or strip, whichever the restart markers / scores pick),
 * the better-scoring UV set and the authored normals when present.
 * @returns {{positions:Float32Array, indices:Uint32Array, uvs:Float32Array|null, uvsAlt:Float32Array|null, normals:Float32Array|null}}
 */
export function parseRrm(u8) {
  if (!u8 || u8.length < 0x1a0) throw new Error('RRM payload is too small.');
  const r = reader(u8);
  const be = !looksLikeLeHeader(r);
  const idxOff = r.u32(0xb0, be), base = r.u32(0xb4, be), ic = r.u32(0x15c, be), vc = r.u32(0x164, be), bones = r.u32(0x14c, be);
  if (vc < 1 || vc > MAX_VC) throw new Error('Invalid vertex count in RRM header (0x164).');
  if (ic < 3 || ic > MAX_IC) throw new Error('RRM has no usable index buffer.');
  if (!rangeOk(u8, idxOff, ic * 4)) throw new Error('RRM index buffer is out of range.');
  const entries = new Uint32Array(ic);
  let maxIndex = -1, restarts = 0;
  for (let i = 0; i < ic; i++) {
    const v = r.u32(idxOff + i * 4, be);
    entries[i] = v;
    if (isRestart(v)) { restarts++; continue; }
    if (v > 0x7fffffff) throw new Error('RRM index value is too large.');
    if (v > maxIndex) maxIndex = v;
  }
  if (maxIndex >= vc) throw new Error(`RRM index references vertex ${maxIndex} but header vertex count is ${vc} (see 0x164).`);
  if (!rangeOk(u8, base, vc * 12)) throw new Error('RRM position stream is out of range.');
  const positions = new Float32Array(vc * 3);
  for (let i = 0; i < vc * 3; i++) positions[i] = r.f32(base + i * 4, be);

  const shift = bones > 0 ? vc * 20 : 0;
  const calc0 = base + vc * 40 + shift;
  if (calc0 > u8.length) throw new Error('RRM computed UV offset is out of range.');
  const calc1 = rangeOk(u8, calc0 + vc * 8, vc * 8) ? calc0 + vc * 8 : calc0;
  const hdr0 = r.u32(0x17c, be), hdr1 = r.u32(0x180, be);
  let uv0 = calc0;
  if (!looksLikeUvFloat2(u8, r, calc0, vc, be)) {
    if (hdr0 !== calc0 && looksLikeUvFloat2(u8, r, hdr0, vc, be)) uv0 = hdr0;
    else if (hdr1 !== calc0 && looksLikeUvFloat2(u8, r, hdr1, vc, be)) uv0 = hdr1;
  }
  let uv1 = calc1;
  if (calc1 !== uv0 && looksLikeUvFloat2(u8, r, calc1, vc, be)) uv1 = calc1;
  else if (hdr1 !== uv0 && looksLikeUvFloat2(u8, r, hdr1, vc, be)) uv1 = hdr1;
  else if (hdr0 !== uv0 && looksLikeUvFloat2(u8, r, hdr0, vc, be)) uv1 = hdr0;
  const s0 = readUvStream(u8, r, uv0, vc, be);
  const s1 = uv1 !== uv0 ? readUvStream(u8, r, uv1, vc, be) : null;

  const list = trianglesFromList(entries, vc);
  const strip = trianglesFromStrip(entries, vc);
  let chosen;
  if (restarts > 0 && strip.length >= 3) chosen = strip;
  else if (restarts === 0 && list.length >= 3) chosen = list;
  else chosen = scoreTriangles(positions, strip) > scoreTriangles(positions, list) * 1.1 ? strip : list;
  if (chosen.length < 3) chosen = strip.length >= list.length ? strip : list;
  if (chosen.length < 3) throw new Error('RRM indices could not be expanded to triangles.');
  const indices = Uint32Array.from(chosen);

  let uvs = s0, uvsAlt = s1;
  if (s0 && s1 && scoreUvUsability(positions, indices, s1) > scoreUvUsability(positions, indices, s0) * 1.05) [uvs, uvsAlt] = [s1, s0];
  else if (!s0) [uvs, uvsAlt] = [s1, null];
  return { positions, indices, uvs, uvsAlt, normals: readStageNormals(u8, r, be, vc) };
}

/**
 * Stage world/terrain RRM: geometry plus per-material batches (colour texture on UV0, lightmap atlas on UV1).
 * Returns null (caller falls back to parseRrm, untextured) for strips, big-endian files or missing tables.
 */
export function parseStageRrm(u8) {
  let mesh;
  try {
    mesh = parseRrm(u8);
  } catch {
    return null;
  }
  const r = reader(u8);
  if (!looksLikeLeHeader(r)) return null;
  const idxOff = r.u32(0xb0), idxCount = r.u32(0x15c), vc = mesh.positions.length / 3;
  if (idxCount < 3 || !rangeOk(u8, idxOff, idxCount * 4)) return null;
  const tri = Math.floor(idxCount / 3);
  const indices = new Uint32Array(tri * 3);
  for (let i = 0; i < tri * 3; i++) {
    const u = r.u32(idxOff + i * 4);
    if (isRestart(u)) return null;
    indices[i] = u < vc ? u : 0;
  }
  const matPtr = r.u32(STAGE_MAT_PTR), matCount = r.u32(STAGE_MAT_COUNT), batchCount = r.u32(STAGE_BATCH_COUNT);
  if (matCount <= 0 || matCount > 4096 || batchCount <= 0 || batchCount > 200000) return null;
  const matBase = matPtr + STAGE_MAT_PREFIX;
  if (matBase + matCount * STAGE_MAT_STRIDE > u8.length) return null;
  const atlas = [], baseTex = [], lightmap = [];
  for (let m = 0; m < matCount; m++) {
    const rec = matBase + m * STAGE_MAT_STRIDE;
    const src = stripTextureExtension(readFixedAscii(u8, rec + STAGE_MAT_SRC, 128));
    const a = stripTextureExtension(readFixedAscii(u8, rec + STAGE_MAT_ATLAS, 128));
    atlas.push(a || src);
    baseTex.push(src || null);
    lightmap.push(!a || (src && a.toLowerCase() === src.toLowerCase()) ? null : a);
  }
  const nodes = [];
  for (let i = 0; i < batchCount; i++) {
    const o = STAGE_BATCH_TABLE + i * STAGE_BATCH_STRIDE;
    if (o + 16 > u8.length) break;
    nodes.push([r.u32(o), r.u32(o + 8), r.u32(o + 12)]);
  }
  const uvs = readStageUv0(u8, r, false, vc);
  const model = {
    positions: mesh.positions,
    normals: readStageNormals(u8, r, false, vc),
    uvs,
    uvs2: readStageUv1(u8, r, vc, uvs),
    indices,
    batches: [],
  };
  // Tile [0, idxCount): at each cursor take the shortest batch starting there (the leaf), as the desktop does.
  let cursor = 0, guard = 0;
  while (cursor < idxCount && guard++ < batchCount + 8) {
    let best = -1, bestCount = Infinity;
    nodes.forEach(([mat, first, count], i) => {
      if (first === cursor && count > 0 && mat < matCount && count < bestCount) {
        best = i;
        bestCount = count;
      }
    });
    if (best < 0) break;
    const [mat, first, count] = nodes[best];
    model.batches.push({
      firstIndex: first,
      indexCount: Math.min(count, indices.length - first),
      texture: atlas[mat],
      baseTexture: baseTex[mat],
      lightmap: lightmap[mat],
    });
    cursor += count;
  }
  if (cursor < idxCount) model.batches.push({ firstIndex: cursor, indexCount: indices.length - cursor, texture: null, baseTexture: null, lightmap: null });
  return model;
}
