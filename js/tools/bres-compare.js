// Compare the embedded .rrm / .rmd models of two BRES bundles, ported from HappyTool/GUI/BresBundleCompareDialog.cs
// (BresBundleCompareEngine.Build and its helpers) and BresBundlePreviewIo (paired .dds lookup, DDS extent). The
// desktop works in one synchronous pass; this port keeps that pass and its order, so the rows, statuses and
// details come out the same, and remembers each resource's fingerprints instead of recomputing them.

import { ascii4 } from '../util.js';
import { parseBres } from '../formats/bres.js';
import { bfbrDecrypt, bsrsDecrypt, zresDecompress } from '../formats/wrappers.js';
import { sha256HexUpper } from './sha256.js';
import { ModelFingerprints } from './model-fingerprint.js';
import {
  netGetFileName, netGetFileNameWithoutExtension, netGetExtension, eqIgnoreCase, endsWithIC, ignoreCaseKey,
} from './dotnet.js';

export const STATUS_RENAMED = 'Renamed (same mesh)';
export const STATUS_SAME = 'Same name & mesh';
export const STATUS_NAME_ONLY = 'Name only (mesh differs)';
export const STATUS_MISSING = 'Not in new bundle';
export const STATUS_WORKSHOP_ONLY = 'Only in Workshop';
export const NONE = '—';
const DOT = ' · ';

/** BresBundleIo.LoadFile: BFBR or BSRS shell, then at most one ZRES, then BRES. */
export async function loadBundle(u8) {
  let cur = u8;
  const magic = ascii4(cur);
  if (magic === 'BFBR') cur = await bfbrDecrypt(cur);
  else if (magic === 'BSRS') cur = bsrsDecrypt(cur);
  if (ascii4(cur) === 'ZRES') cur = await zresDecompress(cur);
  return parseBres(cur);
}

const isModelName = (name) => {
  const ext = (netGetExtension(name ?? '') ?? '').toLowerCase();
  return ext === '.rrm' || ext === '.rmd';
};

/** BresBundlePreviewIo.TryReadDdsLogicalExtent: header width / height, 1..16384, or null. */
export function ddsLogicalExtent(dds) {
  if (!dds || dds.length < 32) return null;
  if (dds[0] !== 0x44 || dds[1] !== 0x44 || dds[2] !== 0x53 || dds[3] !== 0x20) return null;
  const dv = new DataView(dds.buffer, dds.byteOffset, dds.byteLength);
  const dwSize = dv.getUint32(4, true);
  if (dwSize < 124 || dds.length < 4 + (dwSize | 0)) return null;
  const height = dv.getUint32(12, true) | 0, width = dv.getUint32(16, true) | 0;
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384) return null;
  return { width, height };
}

/** Per-archive lookups, with the desktop's linear scans (and their path-character checks) kept in order. */
class Bundle {
  constructor(archive) {
    this.entries = archive?.entries ?? [];
    this.fileKeys = new Array(this.entries.length);
  }

  fileKey(i) {
    let k = this.fileKeys[i];
    if (k === undefined) {
      try {
        k = { key: ignoreCaseKey(netGetFileName(this.entries[i].name)) };
      } catch (e) {
        k = { error: e };
      }
      this.fileKeys[i] = k;
    }
    if (k.error) throw k.error;
    return k.key;
  }

  /** FindEmbeddedResourceIndexByFileName: first inline resource whose file name matches, case ignored. */
  findByFileName(fileName) {
    if (!fileName) return -1;
    const want = netGetFileName(fileName);
    if (!want) return -1;
    const key = ignoreCaseKey(want);
    for (let i = 0; i < this.entries.length; i++) {
      const r = this.entries[i];
      if (r.name == null || r.pointer) continue;
      if (this.fileKey(i) === key) return i;
    }
    return -1;
  }

  /** FindPairedDdsArchiveIndex: <basename>.dds next to a .rrm / .rmd. */
  pairedDds(index) {
    if (index < 0 || index >= this.entries.length) return -1;
    const rnm = this.entries[index].name ?? '';
    if (!endsWithIC(rnm, '.rrm') && !endsWithIC(rnm, '.rmd')) return -1;
    const bas = netGetFileNameWithoutExtension(rnm);
    if (!bas) return -1;
    const d = this.findByFileName(bas + '.dds');
    return d >= 0 ? d : this.findByFileName(bas + '.DDS');
  }

  pairedDdsBytes(modelName) {
    if (!modelName) return null;
    const m = this.findByFileName(modelName);
    if (m < 0) return null;
    const d = this.pairedDds(m);
    return d < 0 ? null : this.entries[d];
  }

  findName(name) {
    for (const r of this.entries) if (eqIgnoreCase(r.name, name)) return r.name;
    return null;
  }
}

/**
 * BresBundleCompareEngine.Build(reference, workshop): one row per reference model (matched, name-only or missing)
 * and one per Workshop model left over.
 * @returns {{oldName: string, newName: string, status: string, details: string}[]}
 */
export function compareBundles(oldArchive, newArchive, fps = new ModelFingerprints()) {
  const rows = [];
  if (!oldArchive?.entries || !newArchive?.entries) return rows;
  const oldB = new Bundle(oldArchive), newB = new Bundle(newArchive);
  const shaCache = new WeakMap();
  const sha = (res) => {
    let h = shaCache.get(res);
    if (h === undefined) shaCache.set(res, (h = sha256HexUpper(res.data)));
    return h;
  };

  const ddsToken = (bundle, modelName) => {
    const dds = bundle.pairedDdsBytes(modelName);
    return !dds || dds.data.length === 0 ? 'none' : sha(dds);
  };
  const ddsNote = (oldName, newName) => {
    const o = ddsToken(oldB, oldName), n = ddsToken(newB, newName);
    if (o === 'none' && n === 'none') return '';
    if (o === 'none') return DOT + 'DDS: workshop only';
    if (n === 'none') return DOT + 'DDS: reference only';
    return o === n ? DOT + 'DDS: same bytes' : DOT + 'DDS: different bytes (meshes matched)';
  };
  const poolKey = (bundle, res) => {
    const texTok = ddsToken(bundle, res.name);
    const m = fps.model(res);
    const tail = texTok === 'none' ? '' : DOT + 'has paired DDS';
    if (m.fp) return { key: 'm:' + m.fp, detail: 'Visual shape match; ' + m.note + tail };
    return { key: 'd:' + sha(res), detail: `${res.data.length} bytes (byte hash; parse: ${m.note ?? '?'})` + tail };
  };

  const matched = new Set();
  const isMatched = (name) => matched.has(ignoreCaseKey(name));
  const markMatched = (name) => matched.add(ignoreCaseKey(name));

  const pool = new Map();
  for (const r of newB.entries) {
    if (!r.name || !isModelName(r.name) || r.pointer) continue;
    const { key } = poolKey(newB, r);
    if (!pool.has(key)) pool.set(key, []);
    pool.get(key).push(r.name);
  }

  const freeModels = function* () {
    for (const r of newB.entries) {
      if (!r.name || isMatched(r.name)) continue;
      if (!isModelName(r.name) || r.pointer) continue;
      yield r;
    }
  };
  const cloudTwin = (old) => {
    const want = fps.cloud(old).fp;
    if (!want) return null;
    for (const r of freeModels()) if (fps.cloud(r).fp === want) return r.name;
    return null;
  };
  const crossTwin = (old, kind) => {
    const want = fps[kind](old).fp;
    if (!want) return null;
    const stem = netGetFileNameWithoutExtension(old.name ?? '');
    const refExt = (netGetExtension(old.name ?? '') ?? '').toLowerCase();
    if (!stem || (refExt !== '.rrm' && refExt !== '.rmd')) return null;
    const altExt = refExt === '.rrm' ? '.rmd' : '.rrm';
    const refFile = netGetFileName(old.name ?? '');
    for (const r of newB.entries) {
      // Here the desktop tests "inline" before the extension.
      if (!r.name || isMatched(r.name) || r.pointer || !isModelName(r.name)) continue;
      const cand = netGetFileName(r.name);
      if (!eqIgnoreCase(netGetFileNameWithoutExtension(cand), stem)) continue;
      if (!eqIgnoreCase(netGetExtension(cand), altExt)) continue;
      if (eqIgnoreCase(refFile, cand)) continue;
      if (fps[kind](r).fp === want) return r.name;
    }
    return null;
  };

  const patches = [];
  for (const old of oldB.entries) {
    if (!old.name || old.pointer || !isModelName(old.name)) continue;
    const { key, detail } = poolKey(oldB, old);
    const q = pool.get(key);
    if (q && q.length > 0) {
      const nn = q.shift();
      markMatched(nn);
      rows.push({ oldName: old.name, newName: nn, status: eqIgnoreCase(old.name, nn) ? STATUS_SAME : STATUS_RENAMED, details: detail + ddsNote(old.name, nn) });
      continue;
    }
    const byName = newB.findName(old.name);
    const cloud = !byName ? cloudTwin(old) : null;
    const cross = !byName && !cloud ? crossTwin(old, 'cloud') : null;
    const crossSoup = !byName && !cloud && !cross ? crossTwin(old, 'soup') : null;
    const nn = byName || cloud || cross || crossSoup || null;
    const soup = !nn ? fps.soup(old) : null;
    if (nn) markMatched(nn);
    let status;
    if (!nn) status = STATUS_MISSING;
    else if (byName) status = STATUS_NAME_ONLY;
    else status = eqIgnoreCase(old.name, nn) ? STATUS_SAME : STATUS_RENAMED;
    let details = detail + ' (reference)';
    if (!byName && cloud) details += DOT + 'vertex-cloud twin: ' + netGetFileName(cloud) + ddsNote(old.name, cloud);
    else if (!byName && cross) details += DOT + 'Steam↔Xbox (.rrm↔.rmd) vertex cloud: ' + netGetFileName(cross) + ddsNote(old.name, cross);
    else if (!byName && crossSoup) details += DOT + 'Steam↔Xbox (.rrm↔.rmd) triangle soup: ' + netGetFileName(crossSoup) + ddsNote(old.name, crossSoup);
    if (soup?.fp) {
      const row = { oldName: old.name, newName: NONE, status: STATUS_MISSING, details: detail + ' (reference)' };
      rows.push(row);
      patches.push({ row, want: soup.fp, old, detail });
    } else rows.push({ oldName: old.name, newName: nn ?? NONE, status, details });
  }

  resolveGlobalSoupTwins(patches, { oldB, newB, fps, freeModels, markMatched, ddsNote });

  for (const r of newB.entries) {
    if (!r.name || !isModelName(r.name) || isMatched(r.name)) continue;
    const details = r.pointer ? 'Pointer' : poolKey(newB, r).detail;
    rows.push({ oldName: NONE, newName: r.name, status: STATUS_WORKSHOP_ONLY, details });
  }
  return rows;
}

function soupTwinCost(ctx, old, cand) {
  let cost = 0;
  const extent = (bundle, name) => {
    const dds = bundle.pairedDdsBytes(name);
    return dds ? ddsLogicalExtent(dds.data) : null;
  };
  const o = extent(ctx.oldB, old.name), n = extent(ctx.newB, cand.name);
  if (o && n) cost += o.width === n.width && o.height === n.height ? -200_000 : (Math.abs(o.width - n.width) + Math.abs(o.height - n.height)) * 4;
  else cost += 5000;
  const m1 = ctx.fps.mesh(old);
  const m2 = m1.error ? null : ctx.fps.mesh(cand);
  if (!m1.error && !m2.error) cost += Math.abs(m1.positions.length / 3 - m2.positions.length / 3) * 8;
  else cost += 50_000;
  return cost;
}

/** ResolveGlobalSoupTwins: hands out same-soup Workshop models, cheapest pairing first. */
function resolveGlobalSoupTwins(patches, ctx) {
  if (patches.length === 0) return;
  const buckets = new Map();
  for (const r of ctx.freeModels()) {
    const h = ctx.fps.soup(r).fp;
    if (!h) continue;
    if (!buckets.has(h)) buckets.set(h, []);
    buckets.get(h).push(r);
  }
  let pending = patches.filter((p) => buckets.get(p.want)?.length > 0);
  while (pending.length > 0) {
    pending = pending.filter((p) => buckets.get(p.want)?.length > 0);
    if (pending.length === 0) break;
    let bestP = -1, bestC = -1, bestCost = 2147483647;
    for (let pi = 0; pi < pending.length; pi++) {
      const list = buckets.get(pending[pi].want);
      for (let ci = 0; ci < list.length; ci++) {
        const c = soupTwinCost(ctx, pending[pi].old, list[ci]);
        if (c < bestCost) {
          bestCost = c;
          bestP = pi;
          bestC = ci;
        }
      }
    }
    if (bestP < 0) break;
    const win = pending[bestP];
    const [cand] = buckets.get(win.want).splice(bestC, 1);
    ctx.markMatched(cand.name);
    pending.splice(bestP, 1);
    const nn = cand.name;
    win.row.newName = nn;
    win.row.status = eqIgnoreCase(win.old.name, nn) ? STATUS_SAME : STATUS_RENAMED;
    win.row.details = win.detail + ' (reference)' + DOT + 'triangle-soup twin: ' + netGetFileName(nn) + ctx.ddsNote(win.old.name, nn);
  }
}

/** The "Matches only" filter: rows whose meshes were paired. */
export const isMatchRow = (row) => row.status === STATUS_RENAMED || row.status === STATUS_SAME;
