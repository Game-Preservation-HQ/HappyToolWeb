// Splitting a baked terrain into movable objects, ported from HappyTool/GUI/StageViewerForm.Objects.cs
// (SplitIntoPieceObjects). Baked terrain fuses every rock, wall and tree into one buffer; its connected pieces (vertices
// sharing a position count as connected, so UV seams don't cut an object apart) become objects. Tiny pieces (grass,
// flower and leaf cards) are grouped per draw batch and map area, so a patch moves together. The vertex arrays are
// reordered so each object is a contiguous range; the triangle order, and so every batch, is kept.

/** Pieces with at most this many triangles are grouped with their neighbours (SmallPieceTris). */
const SMALL_PIECE_TRIS = 16;

/** C#'s Math.Round: halves go to the even neighbour. */
function roundEven(x) {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** A copy of a per-vertex array with element i moved to newIndex[i]; missing or mismatched arrays pass through. */
function reorder(src, width, newIndex, vc) {
  if (!src || src.length !== vc * width) return src;
  const dst = new src.constructor(src.length);
  for (let i = 0; i < vc; i++) for (let k = 0; k < width; k++) dst[newIndex[i] * width + k] = src[i * width + k];
  return dst;
}

/**
 * Splits mesh m ({name, positions, normals, uvs, uvs2, indices, batches}) into piece objects in place: reorders its
 * vertices, remaps its indices, sets m.sourceVertex (each vertex's index in the file) and m.objects ([{name,
 * firstVertex, vertexCount, recordOffset}], names "<mesh>#v<lowest original vertex>"). Returns the object count.
 */
export function splitIntoPieceObjects(m, recordOffset = null) {
  if (!m?.positions || !m.indices || m.indices.length < 3) return 0;
  const pos = m.positions, idx = m.indices, vc = Math.trunc(pos.length / 3);
  if (vc < 3) return 0;
  const parent = new Int32Array(vc);
  for (let i = 0; i < vc; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  };
  const node = m.vertexNode && m.vertexNode.length === vc ? m.vertexNode : null;
  const nodeOf = (v) => (node ? node[v] : 0);

  // Weld coincident vertices (0.1-unit grid).
  let weld = new Map();
  for (let i = 0; i < vc; i++) {
    const key = `${roundEven(Math.fround(pos[i * 3] * 10))},${roundEven(Math.fround(pos[i * 3 + 1] * 10))},${roundEven(Math.fround(pos[i * 3 + 2] * 10))},${nodeOf(i)}`;
    const other = weld.get(key);
    if (other !== undefined) union(i, other);
    else weld.set(key, i);
  }
  weld = null;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (a === b && b === c) continue;
    if (a >= vc || b >= vc || c >= vc) continue;
    union(a, b);
    union(a, c);
  }

  // Piece stats before grouping: triangle count and centroid per piece root.
  const piece = new Int32Array(vc);
  for (let i = 0; i < vc; i++) piece[i] = find(i);
  const triCount = new Int32Array(vc);
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t];
    if (a < vc && !(a === idx[t + 1] && a === idx[t + 2])) triCount[piece[a]]++;
  }
  const sumX = new Float64Array(vc), sumZ = new Float64Array(vc), verts = new Int32Array(vc);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < vc; i++) {
    const r = piece[i], x = pos[i * 3], z = pos[i * 3 + 2];
    sumX[r] += x;
    sumZ[r] += z;
    verts[r]++;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const cell = Math.max(500, Math.fround(Math.max(Math.fround(maxX - minX), Math.fround(maxZ - minZ)) / 40));

  // Group small pieces that share a draw batch (one material) and a map cell.
  const ranges = m.batches?.length ? m.batches.map((b) => [b.firstIndex, b.indexCount]) : [[0, idx.length]];
  for (const [first, count] of ranges) {
    const rep = new Map();
    const end = Math.min(idx.length, first + count);
    for (let t = Math.max(0, first); t + 2 < end; t += 3) {
      const a = idx[t];
      if (a >= vc) continue;
      const r = piece[a];
      if (triCount[r] === 0 || triCount[r] > SMALL_PIECE_TRIS) continue;
      const key = `${Math.floor(sumX[r] / verts[r] / cell)},${Math.floor(sumZ[r] / verts[r] / cell)},${nodeOf(r)}`;
      const other = rep.get(key);
      if (other !== undefined) union(r, other);
      else rep.set(key, r);
    }
  }

  // Final groups, ordered by their lowest original vertex (stable names across loads).
  const group = new Int32Array(vc), minVertex = new Map();
  for (let i = 0; i < vc; i++) {
    const g = find(i);
    group[i] = g;
    if (!minVertex.has(g)) minVertex.set(g, i);
  }
  const order = [...minVertex.keys()].sort((x, y) => minVertex.get(x) - minVertex.get(y));
  const slot = new Map();
  order.forEach((g, k) => slot.set(g, k));

  // Counting sort of vertices by group (stable), then remap every per-vertex array and the index values.
  const counts = new Int32Array(order.length);
  for (let i = 0; i < vc; i++) counts[slot.get(group[i])]++;
  const starts = new Int32Array(order.length);
  for (let k = 1; k < order.length; k++) starts[k] = starts[k - 1] + counts[k - 1];
  const next = starts.slice(), newIndex = new Int32Array(vc);
  for (let i = 0; i < vc; i++) newIndex[i] = next[slot.get(group[i])]++;

  m.positions = reorder(m.positions, 3, newIndex, vc);
  m.normals = reorder(m.normals, 3, newIndex, vc);
  m.uvs = reorder(m.uvs, 2, newIndex, vc);
  m.uvs2 = reorder(m.uvs2, 2, newIndex, vc);
  if (node) {
    const moved = new Int32Array(vc);
    for (let i = 0; i < vc; i++) moved[newIndex[i]] = node[i];
    m.vertexNode = moved;
  }
  // Where every vertex came from, so an export can write edits back in the file's vertex order.
  const source = new Int32Array(vc), chained = m.sourceVertex && m.sourceVertex.length === vc;
  for (let i = 0; i < vc; i++) source[newIndex[i]] = chained ? m.sourceVertex[i] : i;
  m.sourceVertex = source;
  const remapped = new idx.constructor(idx.length);
  for (let t = 0; t < idx.length; t++) remapped[t] = idx[t] < vc ? newIndex[idx[t]] : idx[t];
  m.indices = remapped;

  const objects = order.map((g, k) => ({ name: `${m.name ?? 'mesh'}#v${minVertex.get(g)}`, firstVertex: starts[k], vertexCount: counts[k], recordOffset }));
  // One piece keeps the mesh's own name.
  if (objects.length === 1) objects[0].name = m.name;
  m.objects = objects;
  return objects.length;
}
