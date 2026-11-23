// A gimmick model's animation nodes, ported from HappyTool/GUI/StageViewerForm.GimmickPlay.cs (ReadRrmNodes,
// ReadRrmVertexNodes). Offsets are from the record base R = 0xC0 of an inline-ModelData .rrm.
// Node table at R+0x88 (count R+0x8C), 0xE0 a node: name (0x80), position at +0x80, rotation quaternion xyzw at +0x90,
// scale at +0xA0, parent at +0xB0. Skinning: R+0xAC four palette indices a vertex (bytes, 255 = none), picking a node
// through the draw batch's palette (batch table at R+0x90, count R+0x94, 0xE0 each: material, 1, first index, index
// count, then 16 node numbers, -1 = unused).

const R = 0xc0;
const NODE_SIZE = 0xe0;

/** The node table of an .rrm: [{ name, pos, rot, scale, parent }] (empty when it has none or it doesn't read). ReadRrmNodes. */
export function readRrmNodes(u8) {
  const list = [];
  if (!u8 || u8.length < R + 0x90) return list;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const I = (o) => dv.getInt32(o, true), F = (o) => dv.getFloat32(o, true);
  const off = I(R + 0x88), n = I(R + 0x8c);
  if (off <= 0 || n <= 0 || n > 256 || R + off + n * NODE_SIZE > u8.length) return list;
  for (let k = 0; k < n; k++) {
    const o = R + off + k * NODE_SIZE;
    let end = o;
    while (end < o + 0x80 && u8[end] !== 0) end++;
    let name = '';
    for (let i = o; i < end; i++) name += u8[i] < 0x80 ? String.fromCharCode(u8[i]) : '?'; // Encoding.ASCII
    list.push({
      name,
      pos: [F(o + 0x80), F(o + 0x84), F(o + 0x88)],
      rot: [F(o + 0x90), F(o + 0x94), F(o + 0x98), F(o + 0x9c)],
      scale: [F(o + 0xa0), F(o + 0xa4), F(o + 0xa8)],
      parent: I(o + 0xb0),
    });
  }
  return list;
}

/**
 * The node each vertex of a single-record .rrm follows (its first palette index through its batch's palette), or null
 * when the model has fewer than two nodes or the streams don't read. Vertices in file order. ReadRrmVertexNodes.
 */
export function readRrmVertexNodes(u8, vertexCount) {
  if (!u8 || u8.length < R + 0xc4 || vertexCount <= 0) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const I = (o) => dv.getInt32(o, true);
  const nodes = I(R + 0x8c), vc = I(R + 0xa4), ic = I(R + 0x9c), io = I(R + 0x98), vo = I(R + 0xa0), blend = I(R + 0xac);
  const table = I(R + 0x90), batches = I(R + 0x94);
  if (nodes < 2 || nodes > 256 || vc !== vertexCount || ic < 3 || batches <= 0 || batches > 256 ||
      blend <= 0 || R + blend + vc * 4 > u8.length || table <= 0 || R + table + batches * 0xe0 > u8.length)
    return null;
  // u32 indices when they fit before the vertices, else u16 (as the stage parser decides).
  const elem = vo - (io + ic * 4) >= 0 ? 4 : 2;
  if (R + io + ic * elem > u8.length) return null;
  const node = new Int32Array(vc);
  for (let b = 0; b < batches; b++) {
    const e = R + table + b * 0xe0, first = I(e + 8), n = I(e + 12);
    if (first < 0 || n <= 0 || first + n > ic) return null;
    for (let t = first; t < first + n; t++) {
      const v = elem === 4 ? I(R + io + t * 4) : dv.getUint16(R + io + t * 2, true);
      if (v < 0 || v >= vc) continue;
      const slot = u8[R + blend + v * 4];
      const nd = slot < 16 ? I(e + 16 + slot * 4) : -1;
      node[v] = nd >= 0 && nd < nodes ? nd : 0;
    }
  }
  return node;
}
