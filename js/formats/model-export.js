// 3D model export of an open stage, for Blender and other 3D apps: glTF 2.0 binary (.glb, textures inside) and
// Wavefront OBJ + MTL + PNG textures in a zip (as the desktop StageObjExporter writes them).
//
// The map viewer draws the stage's own coordinates in a right-handed, Y-up frame, which is glTF's frame, so axes are
// kept; the game's unit is the centimetre, so positions are written in metres (x 0.01), glTF's unit. Texture rows are stored top row first and sampled with the stage's UVs as they are, which is
// glTF's UV convention; OBJ counts v from the bottom, so the OBJ writes 1 - v.
import { crc32, makeZip } from './zip.js';
import { utf8, concat } from '../util.js';

const lower = (s) => (s ? s.toLowerCase() : s);
/** Game units (centimetres) to metres. */
const METRES = 0.01;
/** The shader drops texels at or below this alpha. */
const ALPHA_CUTOFF = 0.4;

// ---------- geometry ----------

/**
 * What gets exported: the meshes that are shown and are not sky, with the triangles of hidden objects and collapsed
 * triangles left out and each mesh's vertices cut down to the ones still used. Positions are as edited, in metres.
 * A mesh's batches that use the same texture become one group.
 * @returns {{name: string, positions: Float32Array, normals: Float32Array|null, uvs: Float32Array|null,
 *   uvs2: Float32Array|null, groups: {texture: string|null, indices: Uint32Array}[]}[]}
 */
export function exportGeometry(meshes) {
  const out = [];
  const used = new Set();
  for (const m of meshes) {
    if (!m.visible || m.sky || !m.positions || !m.indices) continue;
    const P = m.positions, I = m.indices, vc = Math.trunc(P.length / 3);
    const N = m.normals?.length === vc * 3 ? m.normals : null;
    const T = m.uvs?.length === vc * 2 ? m.uvs : null;
    const T2 = m.uvs2?.length === vc * 2 ? m.uvs2 : null;
    const hiddenTri = (t) => {
      const k = m.triObject ? m.triObject[t] : -1;
      return k >= 0 && !!m.editObjects?.[k]?.state.hidden;
    };
    const batches = m.batches?.length ? m.batches : [{ firstIndex: 0, indexCount: I.length, texture: null }];
    const remap = new Int32Array(vc).fill(-1);
    let next = 0;
    const byTexture = new Map(); // lower(texture) -> {texture, list}
    for (const b of batches) {
      const end = Math.min(b.firstIndex + b.indexCount, I.length);
      const key = lower(b.texture || '');
      if (!byTexture.has(key)) byTexture.set(key, { texture: b.texture || null, list: [] });
      const list = byTexture.get(key).list;
      for (let i = b.firstIndex; i + 2 < end; i += 3) {
        const a = I[i], c = I[i + 1], d = I[i + 2];
        if (a >= vc || c >= vc || d >= vc || (a === c && c === d) || hiddenTri(i / 3)) continue;
        if (flat(P, a, c, d)) continue;
        for (const v of [a, c, d]) {
          if (remap[v] < 0) remap[v] = next++;
          list.push(remap[v]);
        }
      }
    }
    const groups = [...byTexture.values()].filter((g) => g.list.length).map((g) => ({ texture: g.texture, indices: Uint32Array.from(g.list) }));
    if (!groups.length) continue;
    const pick = (src, n) => {
      if (!src) return null;
      const o = new Float32Array(next * n);
      for (let v = 0; v < vc; v++) if (remap[v] >= 0) for (let k = 0; k < n; k++) o[remap[v] * n + k] = src[v * n + k];
      return o;
    };
    const positions = pick(P, 3);
    for (let i = 0; i < positions.length; i++) positions[i] *= METRES;
    out.push({ name: unique(used, meshName(m.name)), positions, normals: pick(N, 3), uvs: pick(T, 2), uvs2: pick(T2, 2), groups });
  }
  return out;
}

/** A triangle whose corners all sit on one point (a hidden object's leftovers that share no index). */
function flat(P, a, b, c) {
  const x = P[a * 3], y = P[a * 3 + 1], z = P[a * 3 + 2];
  return x === P[b * 3] && y === P[b * 3 + 1] && z === P[b * 3 + 2] && x === P[c * 3] && y === P[c * 3 + 1] && z === P[c * 3 + 2];
}

function meshName(name) {
  const base = (name || 'mesh').replace(/\\/g, '/').split('/').pop().replace(/\.rrm$/i, '');
  return base || 'mesh';
}
function unique(used, name) {
  let n = name, i = 2;
  while (used.has(n.toLowerCase())) n = `${name}_${i++}`;
  used.add(n.toLowerCase());
  return n;
}
/** A name that is safe as an OBJ/MTL token and a file name. */
const safeName = (s) => (s || 'untextured').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+/, '_');

/** One material per texture name used, in order of first use; null is the untextured material. */
function collectMaterials(geo, textures) {
  const byKey = new Map(), list = [], used = new Set();
  for (const g of geo)
    for (const grp of g.groups) {
      const key = lower(grp.texture) || '';
      if (byKey.has(key)) continue;
      const image = key ? textures.get(key) ?? null : null;
      const m = { key, name: unique(used, safeName(grp.texture)), image, alpha: image ? hasAlpha(image) : false, index: list.length };
      byKey.set(key, m);
      list.push(m);
    }
  return { list, of: (texture) => byKey.get(lower(texture) || '') };
}

function hasAlpha(img) {
  const p = img.rgba;
  for (let i = 3; i < p.length; i += 4) if (p[i] / 255 <= ALPHA_CUTOFF) return true;
  return false;
}

// ---------- PNG ----------

async function deflate(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A PNG of a decoded texture ({width, height, rgba}); RGB when every texel is opaque. Rows use the Sub filter. */
export async function encodePng(img) {
  const { width: w, height: h, rgba } = img;
  let opaque = true;
  for (let i = 3; i < rgba.length && opaque; i += 4) opaque = rgba[i] === 255;
  const ch = opaque ? 3 : 4, stride = w * ch + 1;
  const raw = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    raw[row] = 1; // Sub
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = row + 1 + x * ch;
      for (let k = 0; k < ch; k++) raw[d + k] = (rgba[s + k] - (x ? rgba[s - 4 + k] : 0)) & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, opaque ? 2 : 6, 0, 0, 0], 8);
  const chunk = (type, data) => {
    const c = new Uint8Array(12 + data.length), v = new DataView(c.buffer);
    v.setUint32(0, data.length);
    c.set(utf8.encode(type), 4);
    c.set(data, 8);
    v.setUint32(8 + data.length, crc32(c.subarray(4, 8 + data.length)));
    return c;
  };
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** PNGs of the materials' textures, made once each. */
async function materialPngs(mats, progress) {
  const out = new Map();
  const withImage = mats.list.filter((m) => m.image);
  for (let i = 0; i < withImage.length; i++) {
    progress?.(`Writing textures (${i + 1} of ${withImage.length})…`);
    out.set(withImage[i], await encodePng(withImage[i].image));
  }
  return out;
}

// ---------- glTF 2.0 binary ----------

/**
 * The stage as a .glb: one node and mesh per stage mesh, one primitive per texture batch, the textures inside as PNG.
 * UV1 (the lightmap UVs) is kept as TEXCOORD_1; the lightmaps themselves are not part of the materials.
 * @returns {Promise<{bytes: Uint8Array, meshes: number, triangles: number, materials: number, textures: number}>}
 */
export async function stageGlb(meshes, textures, title, progress = null) {
  const geo = exportGeometry(meshes);
  if (!geo.length) throw new Error('Nothing is shown to export (turn a layer on, or show a hidden object).');
  const mats = collectMaterials(geo, textures);
  const pngs = await materialPngs(mats, progress);
  progress?.('Writing the model…');

  const bin = [];
  let binLength = 0;
  const bufferViews = [], accessors = [];
  const addView = (u8, target) => {
    const pad = (4 - (binLength % 4)) % 4;
    if (pad) {
      bin.push(new Uint8Array(pad));
      binLength += pad;
    }
    const view = { buffer: 0, byteOffset: binLength, byteLength: u8.byteLength };
    if (target) view.target = target;
    bin.push(new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength));
    binLength += u8.byteLength;
    bufferViews.push(view);
    return bufferViews.length - 1;
  };
  const addAccessor = (arr, type, componentType, target, extra = {}) => {
    const n = { VEC2: 2, VEC3: 3, SCALAR: 1 }[type];
    accessors.push({ bufferView: addView(arr, target), componentType, count: arr.length / n, type, ...extra });
    return accessors.length - 1;
  };

  const images = [], gltfTextures = [], materials = [];
  for (const m of mats.list) {
    const mat = { name: m.name, doubleSided: true, pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 } };
    const png = pngs.get(m);
    if (png) {
      images.push({ name: m.name, mimeType: 'image/png', bufferView: addView(png) });
      gltfTextures.push({ sampler: 0, source: images.length - 1 });
      mat.pbrMetallicRoughness.baseColorTexture = { index: gltfTextures.length - 1 };
      if (m.alpha) Object.assign(mat, { alphaMode: 'MASK', alphaCutoff: ALPHA_CUTOFF });
    } else mat.pbrMetallicRoughness.baseColorFactor = [0.6, 0.6, 0.6, 1];
    materials.push(mat);
  }

  const gltfMeshes = [], nodes = [];
  let triangles = 0;
  for (const g of geo) {
    const vc = g.positions.length / 3;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < g.positions.length; i += 3)
      for (let k = 0; k < 3; k++) {
        const x = g.positions[i + k];
        if (x < min[k]) min[k] = x;
        if (x > max[k]) max[k] = x;
      }
    const attributes = { POSITION: addAccessor(g.positions, 'VEC3', 5126, 34962, { min, max }) };
    if (g.normals) attributes.NORMAL = addAccessor(unitNormals(g.normals), 'VEC3', 5126, 34962);
    if (g.uvs) attributes.TEXCOORD_0 = addAccessor(g.uvs, 'VEC2', 5126, 34962);
    if (g.uvs2) attributes.TEXCOORD_1 = addAccessor(g.uvs2, 'VEC2', 5126, 34962);
    const primitives = g.groups.map((grp) => {
      triangles += grp.indices.length / 3;
      const small = vc <= 65535;
      const idx = small ? Uint16Array.from(grp.indices) : grp.indices;
      return { attributes, indices: addAccessor(idx, 'SCALAR', small ? 5123 : 5125, 34963), material: mats.of(grp.texture).index, mode: 4 };
    });
    gltfMeshes.push({ name: g.name, primitives });
    nodes.push({ name: g.name, mesh: gltfMeshes.length - 1 });
  }
  const root = nodes.length;
  nodes.push({ name: title, children: nodes.map((_, i) => i) });

  const json = {
    asset: { version: '2.0', generator: 'HappyTool web' },
    scene: 0,
    scenes: [{ name: title, nodes: [root] }],
    nodes,
    meshes: gltfMeshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: 0 }],
  };
  if (images.length) {
    json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
    json.images = images;
    json.textures = gltfTextures;
  }
  const binPad = (4 - (binLength % 4)) % 4;
  json.buffers[0].byteLength = binLength + binPad;
  let jsonBytes = utf8.encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  if (jsonPad) jsonBytes = concat([jsonBytes, new Uint8Array(jsonPad).fill(0x20)]);
  const total = 12 + 8 + jsonBytes.length + 8 + binLength + binPad;
  const head = new Uint8Array(28), hv = new DataView(head.buffer);
  hv.setUint32(0, 0x46546c67, true); // glTF
  hv.setUint32(4, 2, true);
  hv.setUint32(8, total, true);
  hv.setUint32(12, jsonBytes.length, true);
  hv.setUint32(16, 0x4e4f534a, true); // JSON
  const binHead = new Uint8Array(8), bv = new DataView(binHead.buffer);
  bv.setUint32(0, binLength + binPad, true);
  bv.setUint32(4, 0x004e4942, true); // BIN
  const bytes = concat([head.subarray(0, 20), jsonBytes, binHead, ...bin, new Uint8Array(binPad)]);
  return { bytes, meshes: geo.length, triangles, materials: materials.length, textures: images.length };
}

/** Normals scaled to length 1 (glTF requires it), with zero ones pointing up. */
function unitNormals(n) {
  const o = new Float32Array(n.length);
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
    if (l > 1e-8) {
      o[i] = n[i] / l;
      o[i + 1] = n[i + 1] / l;
      o[i + 2] = n[i + 2] / l;
    } else o[i + 1] = 1;
  }
  return o;
}

// ---------- Wavefront OBJ ----------

const num = (x) => {
  const r = Math.round(x * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
};

/**
 * The stage as `<title>.obj`, `<title>.mtl` and one PNG per texture, in a zip: one `o` group per mesh and a `usemtl` per
 * texture it uses.
 * @returns {Promise<{blob: Blob, meshes: number, triangles: number, materials: number, textures: number}>}
 */
export async function stageObjZip(meshes, textures, title, progress = null) {
  const geo = exportGeometry(meshes);
  if (!geo.length) throw new Error('Nothing is shown to export (turn a layer on, or show a hidden object).');
  const mats = collectMaterials(geo, textures);
  const pngs = await materialPngs(mats, progress);
  progress?.('Writing the model…');
  const base = safeName(title), files = [];

  const mtl = ['# HappyTool web', ''];
  for (const m of mats.list) {
    mtl.push(`newmtl ${m.name}`, 'Ka 0 0 0', m.image ? 'Kd 1 1 1' : 'Kd 0.6 0.6 0.6', 'Ks 0 0 0', 'd 1', 'illum 1');
    if (pngs.has(m)) {
      mtl.push(`map_Kd ${m.name}.png`);
      if (m.alpha) mtl.push(`map_d ${m.name}.png`);
      files.push({ name: `${m.name}.png`, data: pngs.get(m) });
    }
    mtl.push('');
  }

  const parts = [`# HappyTool web\nmtllib ${base}.mtl\n`];
  let vOff = 0, tOff = 0, nOff = 0, triangles = 0;
  for (const g of geo) {
    const vc = g.positions.length / 3, lines = [`o ${safeName(g.name)}`];
    const P = g.positions, N = g.normals, T = g.uvs;
    for (let i = 0; i < vc; i++) lines.push(`v ${num(P[i * 3])} ${num(P[i * 3 + 1])} ${num(P[i * 3 + 2])}`);
    if (T) for (let i = 0; i < vc; i++) lines.push(`vt ${num(T[i * 2])} ${num(1 - T[i * 2 + 1])}`);
    if (N) for (let i = 0; i < vc; i++) lines.push(`vn ${num(N[i * 3])} ${num(N[i * 3 + 1])} ${num(N[i * 3 + 2])}`);
    for (const grp of g.groups) {
      lines.push(`usemtl ${mats.of(grp.texture).name}`);
      const I = grp.indices;
      const corner = (k) => {
        const v = I[k] + 1;
        return T && N ? `${v + vOff}/${v + tOff}/${v + nOff}` : T ? `${v + vOff}/${v + tOff}` : N ? `${v + vOff}//${v + nOff}` : `${v + vOff}`;
      };
      for (let k = 0; k + 2 < I.length; k += 3) lines.push(`f ${corner(k)} ${corner(k + 1)} ${corner(k + 2)}`);
      triangles += I.length / 3;
    }
    vOff += vc;
    if (T) tOff += vc;
    if (N) nOff += vc;
    parts.push(lines.join('\n') + '\n');
  }
  files.unshift({ name: `${base}.obj`, data: utf8.encode(parts.join('')) }, { name: `${base}.mtl`, data: utf8.encode(mtl.join('\n')) });
  return { blob: makeZip(files), meshes: geo.length, triangles, materials: mats.list.length, textures: pngs.size };
}
