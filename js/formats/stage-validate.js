// The export's last look at the bundle before it is written, ported from HappyTool/GUI/StageViewerForm.Export.cs
// (ValidateExport). Every resource the objects, collision, shadow and nav steps changed is read back the way the game's
// readers take it, and anything structural that moved (vertex or index counts, an object record lost, a nav or
// waypoint index out of range, a collision header that no longer adds up, a lightmap that changed size or doesn't
// decode) stops the export with the desktop's message, so a broken bundle is never downloaded.
//
// The desktop checks the names its bake steps report as changed; here a resource counts as changed when its stored
// bytes are no longer the source bundle's own (a new name, or an entry whose data differs). The web writes no .rrt and
// appends no object records yet (Added objects isn't ported), so the desktop's .rrt checks have nothing to look at and
// every changed .rrm must keep its size.

import { decodeLayers } from './wrappers.js';
import { decodeDds } from './dds.js';
import { parseStageRrm } from './rrm.js';
import { parseInlineModelData } from './steam-stage.js';
import { parseNavMesh, parsePathGraph } from './stage-nav.js';

const fail = (text) => {
  throw new Error(text);
};
const ends = (name, ext) => name.toLowerCase().endsWith(ext);
const payload = async (e) => (e && !e.pointer && e.data?.length ? (await decodeLayers(e.data)).payload : null);
/** The same stored bytes (the same array, or equal contents: a step may write back what was there). */
const sameBytes = (a, b) => {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const decodes = (bytes) => {
  try {
    decodeDds(bytes);
    return true;
  } catch {
    return false;
  }
};

/**
 * The changed resources of baked (entries) next to source (the bundle as loaded): [{name, before, after}], where before
 * is null for a name the source doesn't have and after is null for an entry left without data.
 */
export async function changedResources(source, baked) {
  const at = new Map();
  for (const e of source) if (e?.name && !at.has(e.name.toLowerCase())) at.set(e.name.toLowerCase(), e);
  const seen = new Set(), out = [];
  for (const e of baked) {
    const key = (e?.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const s = at.get(key);
    if (s && !!s.pointer === !!e.pointer && sameBytes(s.data, e.data)) continue;
    out.push({ name: e.name, before: s ? await payload(s) : null, after: await payload(e) });
  }
  return out;
}

/**
 * Throws with the desktop's text when a changed resource of baked doesn't read back as it should; returns the names
 * checked. source and baked are bundle entry lists ({name, pointer, data}, data possibly wrapped in layers).
 */
export async function validateExport(source, baked) {
  const list = await changedResources(source, baked);
  for (const { name, before, after: bytes } of list) {
    if (!bytes) fail(`${name} is missing from the exported bundle.`);
    if (ends(name, '.rrt')) continue; // the web writes none (see above)
    if (!before) {
      // Only textures imported from other stages are new.
      if (!ends(name, '.dds')) fail(`${name} is new in the exported bundle but isn't an imported texture.`);
      if (!decodes(bytes)) fail(`Imported texture ${name} doesn't decode.`);
      continue;
    }
    if (ends(name, '.dds')) {
      // A lightmap with baked shadows cleared: same layout, still decodes.
      if (bytes.length !== before.length) fail(`${name} changed size while clearing baked shadows.`);
      if (!decodes(bytes)) fail(`Lightmap ${name} doesn't decode after clearing baked shadows.`);
      continue;
    }
    if (ends(name, '.rrm')) {
      if (bytes.length !== before.length) fail(`${name} changed size, which an in-place edit never does.`);
      const a = parseStageRrm(before);
      if (a) {
        const b = parseStageRrm(bytes);
        if (!b || b.positions.length !== a.positions.length || b.indices.length !== a.indices.length || b.batches.length !== a.batches.length)
          fail(`${name} no longer reads back the same after the edit.`);
      } else {
        const expected = parseInlineModelData(before).length, got = parseInlineModelData(bytes).length;
        if (got !== expected)
          fail(`${name} reads back ${got} of its ${expected} objects after the edit (an object may have been moved or scaled too far).`);
      }
    } else if (ends(name, '.spd')) {
      // Rewritten navigation must read back with every index in range.
      const nav = parseNavMesh(bytes), path = parsePathGraph(bytes);
      if (!nav && !path) fail(`${name} doesn't read back after the navigation rebuild.`);
      if (nav)
        for (const c of nav.cells)
          for (const l of c.links) if (Math.abs(l) >= nav.cells.length) fail(`${name} has a link to a cell that doesn't exist.`);
      if (path) {
        const nodes = path.nodes.length, links = path.links.length;
        const out = (v, n) => v < 0 || v >= n;
        for (const n of path.nodes)
          for (const l of n.links) if (out(l, links)) fail(`${name} has a waypoint listing a link that doesn't exist.`);
        for (const r of path.regions)
          if (r.nodes.some((v) => out(v, nodes)) || r.gates.some((v) => out(v, nodes)) || r.links.some((v) => out(v, links)))
            fail(`${name} has a region listing something that doesn't exist.`);
      }
    } else if (ends(name, '.ccp')) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes.length < 16 || bytes[0] !== 0x43 || bytes[1] !== 0x43 || bytes[2] !== 0x50 || dv.getUint32(8, true) !== bytes.length || dv.getUint32(12, true) === 0)
        fail(`${name} collision header is inconsistent after the edit.`);
    }
  }
  return list.map((x) => x.name);
}
