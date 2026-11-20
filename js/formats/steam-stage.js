// Steam stage scene build, ported from HappyTool/RrmConvert/HappyWarsSteamStageParser.cs (inline ModelData packs,
// multi-record terrain, material tables, node matrices) and StageViewerForm.cs AppendSteamMeshes /
// AppendTerrainRecords / AppendSteamMultiSubmeshMeshes. Not ported yet: the legacy descriptor scan
// (CollectDescriptors / TryEmitSubmesh) for non-ModelData packs, Xbox One .rmd and Xbox 360 .rrmv stages.
import { parseRrm, parseStageRrm, stripTextureExtension } from './rrm.js';
import { splitIntoPieceObjects } from './stage-pieces.js';

const MODELDATA_MAGIC = 0x0132b421;
const MAT_STRIDE = 0x390;
const MAT_SRC = 0x80;
const MAT_ATLAS = 0x100;
const DESC_REL = 0x98;
const NODE_BASE = 0x84;
const NODE_COUNT = 0x88;
const NODE_STRIDE = 0xe0;
const SHAPE_NODE = 0xd8;
const STREAM_FIRST = 0xb0;
const STREAM_LAST = 0xd0;
const VERT_END = 0xd4;
const MAT_INDEX = 0x120;

const lower = (s) => (s ? s.toLowerCase() : s);

function rd(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return {
    u32: (o) => dv.getUint32(o, true),
    i32: (o) => dv.getInt32(o, true),
    u16: (o) => dv.getUint16(o, true),
    f32: (o) => dv.getFloat32(o, true),
  };
}

function readAscii(u8, off, max) {
  if (off < 0 || off >= u8.length) return null;
  let end = off;
  const limit = Math.min(u8.length, off + max);
  while (end < limit && u8[end] !== 0 && u8[end] >= 0x20 && u8[end] <= 0x7e) end++;
  return end - off >= 3 ? String.fromCharCode(...u8.subarray(off, end)) : null;
}

function readName(u8, off) {
  if (off < 0 || off >= u8.length) return null;
  let end = off;
  while (end < u8.length && end < off + 64 && u8[end] !== 0) end++;
  return end > off ? String.fromCharCode(...u8.subarray(off, end)) : null;
}

function looksLikeName(u8, off) {
  if (off < 0 || off >= u8.length) return false;
  const b = u8[off];
  if (!((b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95)) return false;
  for (let i = off; i < u8.length && i < off + 64; i++) {
    if (u8[i] === 0) return i > off;
    if (u8[i] < 0x20 || u8[i] > 0x7e) return false;
  }
  return false;
}

function isTextureLikeName(s) {
  if (!s || s.length < 5 || s.length > 96 || !/^[A-Za-z0-9_.\-/]+$/.test(s)) return false;
  const l = s.toLowerCase();
  return /\.(psd|tga|dds|bmp)$/.test(l) || l.includes('_col') || l.includes('_alp') || l.includes('set0');
}

const looksLikeMaterialRecord = (u8, rec) => isTextureLikeName(readAscii(u8, rec + MAT_SRC, 128)) || isTextureLikeName(readAscii(u8, rec + MAT_ATLAS, 128));

export const isInlineModelData = (u8) => !!u8 && u8.length >= 0x200 && rd(u8).u32(0) === MODELDATA_MAGIC;
export const isMultiRecordTerrain = (u8) => isInlineModelData(u8) && rd(u8).u32(0x90) > 1 && rd(u8).u32(0x88) === 0;

/** Lower-cased .dds base names in the bundle → true. */
export function textureIndex(entries) {
  const set = new Set();
  for (const e of entries) if (/\.dds$/i.test(e.name)) set.add(lower(stripTextureExtension(e.name)));
  return set;
}

function addMaterial(t, u8, rec) {
  const src = stripTextureExtension(readAscii(u8, rec + MAT_SRC, 128));
  const atlas = stripTextureExtension(readAscii(u8, rec + MAT_ATLAS, 128));
  t.piece.push(src);
  t.atlas.push(atlas || src);
}

/** Material table: pack base (0xA8, to EOF), else header 0x140/0x144, else the scanned run resolving most DDS. */
export function parseMaterialTables(u8, dds) {
  const t = { piece: [], atlas: [] };
  if (!u8 || u8.length < MAT_STRIDE) return t;
  const r = rd(u8);
  const real = (base, n) => {
    let c = 0;
    for (let i = 0; i < n; i++) if (looksLikeMaterialRecord(u8, base + i * MAT_STRIDE)) c++;
    return c;
  };
  if (r.u32(0) === MODELDATA_MAGIC && (r.u32(0x90) > 1 || (r.u32(0x90) === 1 && r.u32(0x84) !== 0))) {
    const base = r.u32(0xa8);
    if (base > 0x200 && base < u8.length && (u8.length - base) % MAT_STRIDE === 0) {
      const n = (u8.length - base) / MAT_STRIDE;
      if (n <= 4096 && real(base, n) >= Math.max(1, Math.floor(n / 2))) {
        for (let m = 0; m < n; m++) addMaterial(t, u8, base + m * MAT_STRIDE);
        return t;
      }
    }
  }
  const ptr = r.u32(0x140), count = r.u32(0x144);
  if (count > 0 && count <= 4096 && ptr > 0) {
    const base = ptr + 0xc0;
    if (base + count * MAT_STRIDE <= u8.length && real(base, count) >= Math.max(1, Math.floor(count / 2))) {
      for (let m = 0; m < count; m++) addMaterial(t, u8, base + m * MAT_STRIDE);
      return t;
    }
  }
  const resolves = (rec) => {
    if (!dds || !dds.size) return false;
    const s = stripTextureExtension(readAscii(u8, rec + MAT_SRC, 128));
    const a = stripTextureExtension(readAscii(u8, rec + MAT_ATLAS, 128));
    return (s && dds.has(lower(s))) || (a && dds.has(lower(a)));
  };
  let bestBase = -1, bestCount = 0, bestScore = 0;
  for (let base = 0; base + MAT_STRIDE <= u8.length; base += 0x10) {
    let run = 0, score = 0;
    for (let i = 0; i < 512 && base + (i + 1) * MAT_STRIDE <= u8.length; i++) {
      const rec = base + i * MAT_STRIDE;
      if (!looksLikeMaterialRecord(u8, rec)) break;
      run++;
      if (resolves(rec)) score++;
    }
    if (run >= 1 && (score > bestScore || (score === bestScore && run > bestCount))) {
      bestScore = score;
      bestCount = run;
      bestBase = base;
    }
  }
  for (let i = 0; i < bestCount && bestBase >= 0; i++) addMaterial(t, u8, bestBase + i * MAT_STRIDE);
  return t;
}

function resolveMeshTexture(mats, i, dds) {
  if (!mats || i < 0) return null;
  const ok = (n) => n && (!dds || !dds.size || dds.has(lower(n)));
  const atlas = mats.atlas[i], piece = mats.piece[i];
  return ok(atlas) ? atlas : ok(piece) ? piece : null;
}

function inferLightmap(material, packStem, dds, exclude) {
  if (!material || !packStem || !dds) return null;
  const cut = material.indexOf('_');
  const lead = cut > 0 ? material.slice(0, cut) : material;
  const m = /^(.*?)(\d*)$/.exec(lead);
  const letters = m[1], digits = m[2];
  if (!letters || !/^[A-Za-z]+$/.test(letters)) return null;
  const abbreviated = letters.length <= 2;
  let found = null;
  for (const key of dds) {
    const us = key.indexOf('_');
    if (us <= 0 || us === key.length - 1 || key.indexOf('_', us + 1) >= 0) continue;
    if (key === lower(exclude) || !lower(packStem).startsWith(key.slice(0, us))) continue;
    const word = key.slice(us + 1);
    let match = word === lower(lead);
    if (!match && abbreviated) {
      const wm = /^(.*?)(\d*)$/.exec(word);
      match = word.startsWith(lower(letters)) && wm[1].length > letters.length && wm[2] === digits;
    }
    if (!match) continue;
    if (found) return null;
    found = key;
  }
  return found;
}

/** Colour texture (UV0) and optional lightmap (UV1) for a material: see ResolveBaseAndLightmap on the desktop. */
function resolveBaseAndLightmap(mats, i, dds, packStem) {
  if (!mats || i < 0) return { baseTexture: null, lightmap: null };
  const piece = mats.piece[i], atlas = mats.atlas[i];
  const known = (n) => n && dds && dds.has(lower(n));
  if (known(piece)) return { baseTexture: piece, lightmap: known(atlas) && lower(atlas) !== lower(piece) ? atlas : null };
  if (known(atlas)) return { baseTexture: atlas, lightmap: inferLightmap(piece, packStem, dds, atlas) };
  return { baseTexture: null, lightmap: null };
}

function readSubBatches(u8, rec, indexCount, mats, dds, packStem) {
  const r = rd(u8);
  if (rec + 0x98 > u8.length) return null;
  const table = rec + r.u32(rec + 0x90), count = r.u32(rec + 0x94);
  if (count <= 1 || count > 100000 || table < rec || table + count * 0xe0 > u8.length) return null;
  const out = [];
  for (let b = 0; b < count; b++) {
    const e = table + b * 0xe0;
    const mat = r.i32(e), first = r.u32(e + 8), n = r.u32(e + 12);
    if (n <= 0 || first + n > indexCount) return null;
    out.push({ firstIndex: first, indexCount: n, texture: resolveMeshTexture(mats, mat, dds), ...resolveBaseAndLightmap(mats, mat, dds, packStem) });
  }
  out.sort((a, b) => a.firstIndex - b.firstIndex);
  let cursor = 0;
  for (const b of out) {
    if (b.firstIndex !== cursor) return null;
    cursor += b.indexCount;
  }
  return cursor === indexCount ? out : null;
}

function positionsSane(pos) {
  if (!pos || pos.length < 9) return false;
  const step = Math.max(1, Math.floor(pos.length / 3 / 16));
  for (let i = 0; i < pos.length; i += 3 * step)
    for (let k = 0; k < 3; k++) if (!Number.isFinite(pos[i + k]) || Math.abs(pos[i + k]) > 150000) return false;
  return true;
}

function uvVaries(uv) {
  if (!uv || uv.length < 4) return false;
  for (let i = 2; i < uv.length; i += 2) if (Math.abs(uv[i] - uv[0]) > 1e-4 || Math.abs(uv[i + 1] - uv[1]) > 1e-4) return true;
  return false;
}

function normalsUnit(u8, abs, vc) {
  const r = rd(u8);
  const samples = Math.min(vc, 24);
  if (samples <= 0) return false;
  const step = Math.max(1, Math.floor(vc / samples));
  let n = 0, unit = 0;
  for (let i = 0; i < vc && n < samples; i += step) {
    const p = abs + i * 12;
    if (p + 12 > u8.length) break;
    const x = r.f32(p), y = r.f32(p + 4), z = r.f32(p + 8);
    if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) return false;
    n++;
    const l = Math.hypot(x, y, z);
    if (l > 0.9 && l < 1.1) unit++;
  }
  return n > 0 && unit >= Math.floor((n * 3) / 4);
}

function streamOffsets(u8, rec, vo) {
  const r = rd(u8);
  const end = r.u32(rec + VERT_END);
  if (end <= vo) return null;
  const offs = [vo];
  for (let rel = STREAM_FIRST; rel <= STREAM_LAST; rel += 4) {
    const v = r.u32(rec + rel);
    if (v > vo && v < end) offs.push(v);
  }
  offs.push(end);
  return offs.sort((a, b) => a - b);
}

function findUv0(u8, rec, vo, vc) {
  const offs = vc > 0 && rec + VERT_END + 4 <= u8.length ? streamOffsets(u8, rec, vo) : null;
  if (!offs) return -1;
  for (let i = 0; i + 1 < offs.length; i++) {
    const size = offs[i + 1] - offs[i];
    if (size > 0 && size % vc === 0 && size / vc === 8) return offs[i];
  }
  return -1;
}

function findUv1(u8, rec, vc, uv0) {
  if (vc <= 0 || uv0 <= 0 || rec + VERT_END + 4 > u8.length) return -1;
  const r = rd(u8);
  const start = uv0 + vc * 8;
  let next = r.u32(rec + VERT_END);
  for (let rel = STREAM_FIRST; rel <= STREAM_LAST; rel += 4) {
    const v = r.u32(rec + rel);
    if (v > start && v < next) next = v;
  }
  const size = next - start;
  return size >= vc * 8 && size < vc * 8 + 32 ? start : -1;
}

function findNormals(u8, rec, vo, vc) {
  const offs = vc > 0 && rec + VERT_END + 4 <= u8.length ? streamOffsets(u8, rec, vo) : null;
  if (!offs) return -1;
  for (let i = 0; i + 1 < offs.length; i++) {
    const off = offs[i], size = offs[i + 1] - off;
    if (off === vo || size <= 0 || size % vc !== 0 || size / vc !== 12) continue;
    if (normalsUnit(u8, rec + off, vc)) return off;
  }
  return -1;
}

const floats = (u8, abs, n) => {
  const r = rd(u8);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = r.f32(abs + i * 4);
  return a;
};

const safeScale = (v) => (!Number.isFinite(v) || v <= 0 || v > 10000 ? 1 : v);

function localNodeMatrix(u8, o) {
  const r = rd(u8);
  const tx = r.f32(o + 0x80), ty = r.f32(o + 0x84), tz = r.f32(o + 0x88);
  let qx = r.f32(o + 0x90), qy = r.f32(o + 0x94), qz = r.f32(o + 0x98), qw = r.f32(o + 0x9c);
  const sx = safeScale(r.f32(o + 0xa0)), sy = safeScale(r.f32(o + 0xa4)), sz = safeScale(r.f32(o + 0xa8));
  let n = qx * qx + qy * qy + qz * qz + qw * qw;
  if (!(n >= 1e-8)) { qx = qy = qz = 0; qw = 1; n = 1; }
  const inv = 1 / Math.sqrt(n);
  qx *= inv; qy *= inv; qz *= inv; qw *= inv;
  const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy - wz) * sy, 2 * (xz + wy) * sz, tx,
    2 * (xy + wz) * sx, (1 - 2 * (xx + zz)) * sy, 2 * (yz - wx) * sz, ty,
    2 * (xz - wy) * sx, 2 * (yz + wx) * sy, (1 - 2 * (xx + yy)) * sz, tz,
  ];
}

function mulAffine(a, b) {
  const m = new Array(12);
  for (let r = 0; r < 3; r++) {
    const ar = r * 4;
    for (let c = 0; c < 3; c++) m[ar + c] = a[ar] * b[c] + a[ar + 1] * b[4 + c] + a[ar + 2] * b[8 + c];
    m[ar + 3] = a[ar] * b[3] + a[ar + 1] * b[7] + a[ar + 2] * b[11] + a[ar + 3];
  }
  return m;
}

function composeNodeMatrix(u8, base, count, node) {
  const r = rd(u8);
  let acc = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  for (let guard = 0; node >= 0 && node < count && guard < 64; guard++) {
    const o = base + node * NODE_STRIDE;
    acc = mulAffine(localNodeMatrix(u8, o), acc);
    const parent = r.i32(o + 0xb0);
    if (parent < 0 || parent === node) break;
    node = parent;
  }
  return acc;
}

const isIdentity = (m) => m.every((v, i) => Math.abs(v - (i % 4 === Math.floor(i / 4) ? 1 : 0)) <= (i % 4 === 3 ? 1e-3 : 1e-6));

/** Records of an inline little-endian ModelData pack (props, sky, sbabA-style terrain), placed by their scene nodes. */
export function parseInlineModelData(u8, mats, dds, packStem) {
  const list = [];
  if (!isInlineModelData(u8)) return list;
  const r = rd(u8);
  const ms = u8.length;
  const nodeBase = r.u32(NODE_BASE), nodeCount = r.u32(NODE_COUNT);
  const haveNodes = nodeBase > 0 && nodeCount > 0 && nodeBase + nodeCount * NODE_STRIDE <= ms;
  const seen = new Set();
  for (let o = 0x98; o + 16 <= ms; o += 4) {
    const io = r.u32(o), ic = r.u32(o + 4), vo = r.u32(o + 8), vc = r.u32(o + 12);
    if (ic < 3 || ic % 3 || ic > 20_000_000 || vc < 3 || vc > 20_000_000 || io < 0x200 || vo <= io) continue;
    const rec = o - DESC_REL;
    if (rec < 0 || seen.has(rec) || !looksLikeName(u8, rec)) continue;
    seen.add(rec);
    let elem = 0;
    for (let c = 2; c <= 4; c += 2) {
      const pad = vo - (io + ic * c);
      if (pad >= 0 && pad <= 16) { elem = c; break; }
    }
    if (!elem) continue;
    const idxAbs = rec + io, vertAbs = rec + vo;
    if (idxAbs + ic * elem > ms || vertAbs + vc * 12 > ms) continue;
    const pos = floats(u8, vertAbs, vc * 3);
    let nodeMat = null, nodeName = null;
    if (haveNodes) {
      const node = r.i32(rec + SHAPE_NODE);
      if (node >= 0 && node < nodeCount) {
        nodeMat = composeNodeMatrix(u8, nodeBase, nodeCount, node);
        nodeName = readAscii(u8, nodeBase + node * NODE_STRIDE, 0x40);
      }
      if (nodeMat && isIdentity(nodeMat)) nodeMat = null;
      if (nodeMat) transform(pos, nodeMat, true);
    }
    if (!positionsSane(pos)) continue;
    const idx = new Uint32Array(ic);
    let ok = true;
    for (let i = 0; i < ic; i++) {
      const v = elem === 4 ? r.u32(idxAbs + i * 4) : r.u16(idxAbs + i * 2);
      if (v >= vc) { ok = false; break; }
      idx[i] = v;
    }
    if (!ok) continue;
    let uvs = null, uvs2 = null;
    const uvRel = findUv0(u8, rec, vo, vc);
    if (uvRel > 0 && rec + uvRel + vc * 8 <= ms) {
      uvs = floats(u8, rec + uvRel, vc * 2);
      const uv1Rel = findUv1(u8, rec, vc, uvRel);
      if (uv1Rel > 0 && rec + uv1Rel + vc * 8 <= ms) uvs2 = floats(u8, rec + uv1Rel, vc * 2);
      if (!uvVaries(uvs2)) uvs2 = null;
    }
    let nrm = null;
    const nRel = findNormals(u8, rec, vo, vc);
    if (nRel > 0 && rec + nRel + vc * 12 <= ms) {
      nrm = floats(u8, rec + nRel, vc * 3);
      transform(nrm, nodeMat, false);
    }
    let tex = null, bl = { baseTexture: null, lightmap: null };
    if (mats && rec + MAT_INDEX + 4 <= ms) {
      const mi = r.i32(rec + MAT_INDEX);
      tex = resolveMeshTexture(mats, mi, dds);
      bl = resolveBaseAndLightmap(mats, mi, dds, packStem);
    }
    list.push({
      name: readName(u8, rec), positions: pos, normals: nrm, uvs, uvs2, indices: idx, texture: tex, ...bl,
      recordOffset: rec, nodeMatrix: nodeMat, nodeName: nodeName?.trim() || null,
      subBatches: mats ? readSubBatches(u8, rec, ic, mats, dds, packStem) : null,
    });
  }
  return list;
}

/** Applies a row-major 3x4 affine to xyz triplets; normals use the linear part and are re-normalised. */
function transform(a, m, isPoint) {
  for (let i = 0; i < a.length; i += 3) {
    let x = a[i], y = a[i + 1], z = a[i + 2];
    if (m) {
      const rx = m[0] * x + m[1] * y + m[2] * z + (isPoint ? m[3] : 0);
      const ry = m[4] * x + m[5] * y + m[6] * z + (isPoint ? m[7] : 0);
      const rz = m[8] * x + m[9] * y + m[10] * z + (isPoint ? m[11] : 0);
      x = rx; y = ry; z = rz;
    }
    if (!isPoint) {
      const l = Math.hypot(x, y, z);
      if (l > 1e-6) { x /= l; y /= l; z /= l; }
    }
    a[i] = x; a[i + 1] = y; a[i + 2] = z;
  }
}

/** Records of a multi-record terrain file (Deep Sea's 01_sseaB.rrm): walked from 0x8C by their sizes at +0xD4. */
export function parseTerrainRecords(u8, mats, dds, packStem) {
  const list = [];
  if (!isMultiRecordTerrain(u8)) return list;
  const r = rd(u8);
  let rec = r.u32(0x8c);
  const count = r.u32(0x90);
  for (let k = 0; k < count && rec > 0 && rec + 0x200 <= u8.length; k++) {
    const size = r.u32(rec + 0xd4);
    const t = readTerrainRecord(u8, rec, mats, dds, packStem);
    if (t) list.push(t);
    if (size <= 0) break;
    rec += size;
  }
  return list;
}

function readTerrainRecord(u8, rec, mats, dds, packStem) {
  const r = rd(u8);
  const io = r.u32(rec + 0x98), ic = r.u32(rec + 0x9c), vo = r.u32(rec + 0xa0), vc = r.u32(rec + 0xa4);
  if (vc <= 0 || ic < 3 || vo <= io || rec + vo + vc * 12 > u8.length) return null;
  let elem = 0;
  for (let c = 4; c >= 2; c -= 2) {
    const pad = vo - (io + ic * c);
    if (pad >= 0 && pad <= 16) { elem = c; break; }
  }
  if (!elem) return null;
  const pos = floats(u8, rec + vo, vc * 3);
  if (!positionsSane(pos)) return null;
  const idx = new Uint32Array(ic);
  for (let i = 0; i < ic; i++) {
    const v = elem === 4 ? r.u32(rec + io + i * 4) : r.u16(rec + io + i * 2);
    idx[i] = v < vc ? v : 0;
  }
  const stream = (rel, width) => {
    const off = r.u32(rec + rel);
    return off <= vo || rec + off + vc * width * 4 > u8.length ? null : floats(u8, rec + off, vc * width);
  };
  let nrm = stream(0xb0, 3);
  if (nrm && !normalsUnit(u8, rec + r.u32(rec + 0xb0), vc)) nrm = null;
  const uv0 = stream(0xbc, 2);
  let uv1 = uv0 ? stream(0xc0, 2) : null;
  if (!uvVaries(uv1)) uv1 = null;
  let batches = readSubBatches(u8, rec, ic, mats, dds, packStem);
  if (!batches) {
    const mi = r.i32(rec + MAT_INDEX);
    batches = [{ firstIndex: 0, indexCount: ic, texture: resolveMeshTexture(mats, mi, dds), ...resolveBaseAndLightmap(mats, mi, dds, packStem) }];
  }
  return { recordOffset: rec, name: readName(u8, rec), positions: pos, normals: nrm, uvs: uv0, uvs2: uv1, indices: idx, batches };
}

/** Colour on UV0 plus lightmap on UV1; falls back to the legacy single texture when neither resolved. */
const colourAndLightmap = (firstIndex, indexCount, colour, lightmap, legacy) => ({
  firstIndex,
  indexCount,
  texture: colour || (lightmap ? null : legacy || null),
  lightmap: lightmap || null,
});

const stemOf = (name) => stripTextureExtension(name) || name;

/**
 * Builds the renderable meshes of a Steam stage bundle (port of AppendSteamMeshes). Each mesh:
 * {name, kind: 'terrain'|'model'|'pack', positions, normals, uvs, uvs2, indices, batches:[{firstIndex,indexCount,texture,lightmap}], objects?}
 * @param {{name:string, data:Uint8Array}[]} entries bundle entries with their payloads
 */
export function buildSteamStage(entries) {
  const dds = textureIndex(entries);
  const meshes = [];
  const skipped = [];
  const rrms = entries.filter((e) => /\.rrm$/i.test(e.name) && !e.pointer && e.data?.length);
  const stageParsed = new Map();
  const stageOf = (e) => {
    if (!stageParsed.has(e)) stageParsed.set(e, parseStageRrm(e.data));
    return stageParsed.get(e);
  };

  for (const e of rrms) {
    const bytes = e.data;
    if (isMultiRecordTerrain(bytes)) {
      const mats = parseMaterialTables(bytes, dds);
      const records = parseTerrainRecords(bytes, mats, dds, stemOf(e.name));
      for (const t of records) {
        const uv2Ok = t.uvs && t.uvs2 && t.uvs2.length === t.uvs.length;
        meshes.push({
          // The desktop's names (AppendTerrainRecords): the record's name only when the file has several.
          name: records.length > 1 ? `${e.name}/${t.name || 'record'}` : e.name, kind: 'terrain', positions: t.positions, normals: t.normals, uvs: t.uvs, uvs2: uv2Ok ? t.uvs2 : null, indices: t.indices,
          batches: t.batches.map((b) => colourAndLightmap(b.firstIndex, b.indexCount, b.baseTexture, uv2Ok ? b.lightmap : null, b.texture)),
        });
        // Baked terrain fuses every rock, wall and tree into one buffer: split it into its connected pieces.
        splitIntoPieceObjects(meshes[meshes.length - 1], t.recordOffset);
      }
      continue;
    }
    const stage = stageOf(e);
    if (isInlineModelData(bytes) && !stage) continue; // a pack: handled below
    if (stage) {
      const vc = stage.positions.length / 3;
      const uvOk = stage.uvs && stage.uvs.length === vc * 2;
      const uv2Ok = uvOk && stage.uvs2 && stage.uvs2.length === stage.uvs.length;
      meshes.push({
        name: e.name, kind: 'terrain', positions: stage.positions,
        normals: stage.normals && stage.normals.length === stage.positions.length ? stage.normals : null,
        uvs: uvOk ? stage.uvs : null, uvs2: uv2Ok ? stage.uvs2 : null, indices: stage.indices,
        batches: stage.batches.map((b) => {
          const colour = b.baseTexture && dds.has(lower(b.baseTexture)) ? b.baseTexture : null;
          return colourAndLightmap(b.firstIndex, b.indexCount, colour, uv2Ok ? b.lightmap : null, b.texture);
        }),
      });
      // Little-endian ModelData terrain is one record (its base is cached at 0x8C); export patches it in place.
      const record = isInlineModelData(bytes) && rd(bytes).u32(0x90) === 1 ? rd(bytes).u32(0x8C) : null;
      splitIntoPieceObjects(meshes[meshes.length - 1], record);
      continue;
    }
    try {
      const m = parseRrm(bytes);
      if (m.positions.length >= 9 && m.indices.length >= 3) {
        meshes.push({ name: e.name, kind: 'model', positions: m.positions, normals: m.normals, uvs: null, uvs2: null, indices: m.indices, batches: [{ firstIndex: 0, indexCount: m.indices.length, texture: null, lightmap: null }] });
        continue;
      }
    } catch {
      /* fall through */
    }
    skipped.push(e.name);
  }

  // Multi-record packs (props, sky): one merged mesh per .rrm, one object per record.
  for (const e of rrms) {
    if (stageOf(e) || isMultiRecordTerrain(e.data)) continue;
    const mats = parseMaterialTables(e.data, dds);
    const subs = parseInlineModelData(e.data, mats, dds, stemOf(e.name));
    if (!subs.length) continue;
    const i = skipped.indexOf(e.name);
    if (i >= 0) skipped.splice(i, 1);
    meshes.push(mergePack(e.name, subs));
  }
  return { meshes, skipped, textures: neededTextures(meshes) };
}

function mergePack(label, subs) {
  let vTotal = 0, iTotal = 0;
  const parts = subs.filter((s) => s.positions?.length >= 9 && s.indices?.length >= 3);
  for (const s of parts) {
    vTotal += s.positions.length / 3;
    iTotal += s.indices.length;
  }
  const positions = new Float32Array(vTotal * 3), normals = new Float32Array(vTotal * 3);
  const uvs = new Float32Array(vTotal * 2), uvs2 = new Float32Array(vTotal * 2);
  const indices = new Uint32Array(iTotal);
  const batches = [], objects = [];
  let anyUv = false, anyUv2 = false, v = 0, ii = 0;
  const names = new Set();
  for (const s of parts) {
    const vc = s.positions.length / 3;
    positions.set(s.positions, v * 3);
    if (s.normals?.length === s.positions.length) normals.set(s.normals, v * 3);
    if (s.uvs?.length === vc * 2) { uvs.set(s.uvs, v * 2); anyUv = true; }
    const smUv2 = s.uvs2?.length === vc * 2;
    if (smUv2) { uvs2.set(s.uvs2, v * 2); anyUv2 = true; }
    for (let k = 0; k < s.indices.length; k++) indices[ii + k] = s.indices[k] + v;
    let name = `${label}/${s.name || 'obj'}`;
    for (let dup = 2; names.has(name.toLowerCase()); dup++) name = `${label}/${s.name || 'obj'}~${dup}`;
    names.add(name.toLowerCase());
    objects.push({ name, label: s.nodeName, firstVertex: v, vertexCount: vc, firstIndex: ii, indexCount: s.indices.length, recordOffset: s.recordOffset });
    const ranges = s.subBatches || [{ firstIndex: 0, indexCount: s.indices.length, texture: s.texture, baseTexture: s.baseTexture, lightmap: s.lightmap }];
    for (const p of ranges) batches.push(colourAndLightmap(ii + p.firstIndex, p.indexCount, p.baseTexture, smUv2 ? p.lightmap : null, p.texture));
    v += vc;
    ii += s.indices.length;
  }
  if (objects.length === 1) objects[0].name = label;
  return { name: label, kind: 'pack', positions, normals, uvs: anyUv ? uvs : null, uvs2: anyUv && anyUv2 ? uvs2 : null, indices, batches, objects };
}

function neededTextures(meshes) {
  const s = new Set();
  for (const m of meshes)
    for (const b of m.batches) {
      if (b.texture) s.add(lower(b.texture));
      if (b.lightmap) s.add(lower(b.lightmap));
    }
  return s;
}
