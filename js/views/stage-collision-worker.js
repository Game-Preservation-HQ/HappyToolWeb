// Matches a stage's collision triangles to its movable objects off the page's thread (the desktop's InitLiveCollision
// runs it in the background too: 15–35 s on a large stage). In: {layers: [{groups: [{vertices, triangles, minX…maxZ}]}],
// meshes: [{positions, indices}] (stock positions), objects: Int32Array of (mesh, firstIndex, indexCount) per object}.
// Out: {pct} now and then, then {owners: [Int32Array per layer, an object index or -1 per triangle], ms} or {error}.

import { makeShape, groupOwners } from './stage-collision-match.js';

self.onmessage = (ev) => {
  try {
    const t0 = performance.now();
    const { layers, meshes, objects } = ev.data;
    const shapes = [];
    for (let i = 0; i * 3 < objects.length; i++) {
      const m = meshes[objects[i * 3]], first = objects[i * 3 + 1], count = objects[i * 3 + 2];
      const I = m.indices;
      shapes.push(makeShape(i, m.positions, I.subarray ? I.subarray(first, first + count) : I.slice(first, first + count)));
    }
    let total = 0;
    for (const l of layers) for (const g of l.groups) total += Math.trunc(g.triangles.length / 3);
    let done = 0, shown = 0;
    const owners = [];
    for (const l of layers) {
      let n = 0;
      for (const g of l.groups) n += Math.trunc(g.triangles.length / 3);
      const own = new Int32Array(n);
      let at = 0;
      for (const g of l.groups) {
        const o = groupOwners(g, shapes);
        own.set(o, at);
        at += o.length;
        done += o.length;
        const pct = total ? Math.floor((done * 100) / total) : 100;
        if (pct >= shown + 5) {
          shown = pct;
          self.postMessage({ pct });
        }
      }
      owners.push(own);
    }
    self.postMessage({ owners, ms: Math.round(performance.now() - t0) }, owners.map((o) => o.buffer));
  } catch (e) {
    self.postMessage({ error: String(e?.stack || e) });
  }
};
