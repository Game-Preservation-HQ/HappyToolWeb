// Matches a stage's collision triangles to its movable objects off the page's thread (the desktop's InitLiveCollision
// runs it in the background too: 15–35 s on a large stage). In: {layers: [{groups: [{vertices, triangles, minX…maxZ}]}],
// meshes: [{positions}] (stock positions), objects: Int32Array of each object's mesh, triangles: [Uint32Array of each
// object's vertex indices, three per triangle], navCells: [nine numbers per nav cell] or null, navNodes: Float32Array
// of each waypoint's x, y, z or null}.
// Out: {pct} now and then, then {owners: [Int32Array per layer, an object index or -1 per triangle], cellOwner,
// nodeOwner (Int32Array or null: an object index or -1 per nav cell / waypoint), ms} or {error}.
// The nav owners are the desktop's MatchNavCells / MatchNavNodes (StageViewerForm.Nav.cs): a cell belongs to the
// object whose surface it lies on, a waypoint to the object within 120 units of it.

import { makeShape, groupOwners, navCellOwner, pointOwner } from './stage-collision-match.js';

self.onmessage = (ev) => {
  try {
    const t0 = performance.now();
    const { layers, meshes, objects, triangles, navCells, navNodes } = ev.data;
    const shapes = [];
    for (let i = 0; i < objects.length; i++) shapes.push(makeShape(i, meshes[objects[i]].positions, triangles[i]));
    let total = 0;
    for (const l of layers) for (const g of l.groups) total += Math.trunc(g.triangles.length / 3);
    const navWork = (navCells?.length ?? 0) + (navNodes ? navNodes.length / 3 : 0);
    total += navWork;
    let done = 0, shown = 0;
    const tick = (n) => {
      done += n;
      const pct = total ? Math.floor((done * 100) / total) : 100;
      if (pct >= shown + 5) {
        shown = pct;
        self.postMessage({ pct });
      }
    };
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
        tick(o.length);
      }
      owners.push(own);
    }
    let cellOwner = null, nodeOwner = null;
    if (navCells) {
      cellOwner = new Int32Array(navCells.length);
      for (let i = 0; i < navCells.length; i++) {
        cellOwner[i] = navCellOwner(navCells[i], shapes);
        if ((i & 255) === 255) tick(256);
      }
      tick(navCells.length & 255);
    }
    if (navNodes) {
      const n = navNodes.length / 3;
      nodeOwner = new Int32Array(n);
      for (let i = 0; i < n; i++) nodeOwner[i] = pointOwner(navNodes[i * 3], navNodes[i * 3 + 1], navNodes[i * 3 + 2], shapes, 120.0);
      tick(n);
    }
    const transfer = owners.map((o) => o.buffer);
    if (cellOwner) transfer.push(cellOwner.buffer);
    if (nodeOwner) transfer.push(nodeOwner.buffer);
    self.postMessage({ owners, cellOwner, nodeOwner, ms: Math.round(performance.now() - t0) }, transfer);
  } catch (e) {
    self.postMessage({ error: String(e?.stack || e) });
  }
};
