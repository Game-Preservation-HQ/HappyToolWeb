// Matches a stage's collision triangles to its movable objects off the page's thread (the desktop's InitLiveCollision
// runs it in the background too: 15–35 s on a large stage). In: {layers: [{groups: [{vertices, triangles, minX…maxZ}]}],
// meshes: [{positions}] (stock positions), objects: Int32Array of each object's mesh, triangles: [Uint32Array of each
// object's vertex indices, three per triangle]}.
// Out: {pct} now and then, then {owners: [Int32Array per layer, an object index or -1 per triangle], ms} or {error}.

import { makeShape, groupOwners } from './stage-collision-match.js';

self.onmessage = (ev) => {
  try {
    const t0 = performance.now();
    const { layers, meshes, objects, triangles } = ev.data;
    const shapes = [];
    for (let i = 0; i < objects.length; i++) shapes.push(makeShape(i, meshes[objects[i]].positions, triangles[i]));
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
