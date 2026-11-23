// The stage's minimap: the bundle's minimap_*.dds (1024 × 1024 DXT1 on the shipped stages), a picture of the 60000 cm
// square round the origin, X to the right and Z down. Port of the desktop's StageViewerForm.Minimap: kept as the stage's
// own, redrawn from above where the map was changed (soft edges), redrawn whole, or your own picture; the edits file's
// "minimap" feature keeps the choice and the bundle download writes it into the minimap's entry.

import { decodeLayers } from '../formats/wrappers.js';
import { decodeDds } from '../formats/dds.js';
import { isIdentityTransform, rotation } from './stage-edit.js';
import { dxt1Block } from './stage-sky.js';

export const MINIMAP_KEY = 'minimap';
export const STOCK = 0, EDITED = 1, WHOLE = 2, PICTURE = 3;
export const MODE_NAMES = ['Stock', 'Edited areas redrawn', 'Whole map redrawn', 'Picture'];
const ENUM_NAMES = ['stock', 'editedareas', 'wholemap', 'picture'];
export const SPAN = 60000; // cm the minimap covers, centred on the origin
const AREA_PAD = 250; // cm round each changed footprint

/** A bundle entry the game reads as the minimap (StartsWith "minimap_", EndsWith ".dds"). */
export const isMinimapName = (name) => /^minimap_[\s\S]*\.dds$/i.test(name || '');

/**
 * The stage's own minimap (LoadMinimap): {name, n, rgba} from the first minimap_*.dds entry, or {name, error} when it
 * can't be read or isn't square (at least 64 px), or null when the bundle has none.
 */
export async function readStockMinimap(archive) {
  const e = archive.entries.find((x) => isMinimapName(x?.name));
  if (!e) return null;
  try {
    if (e.pointer || !e.data?.length) throw new Error('its data is in another file');
    const d = decodeDds((await decodeLayers(e.data)).payload);
    if (d.width !== d.height || d.width < 64) throw new Error(`it is ${d.width}×${d.height}, not square`);
    return { name: e.name, n: d.width, rgba: new Uint8Array(d.rgba.buffer, d.rgba.byteOffset, d.rgba.byteLength) };
  } catch (err) {
    return { name: e.name, error: err.message };
  }
}

// ---------- the edits file's "minimap" feature: {Mode: 0..3, Picture: file | null} (MinimapEdit) ----------

/** The setting the feature holds ({Mode, Picture}); Stock when there is none. The mode may be a number or its enum name. */
export function minimapFromFeature(f) {
  const m = { Mode: STOCK, Picture: null };
  if (!f || typeof f !== 'object' || Array.isArray(f)) return m;
  let mode = f.Mode;
  if (typeof mode === 'string') mode = ENUM_NAMES.indexOf(mode.toLowerCase().replace(/\s+/g, ''));
  if (Number.isInteger(mode) && mode >= 0 && mode < 4) m.Mode = mode;
  if (typeof f.Picture === 'string' && f.Picture) m.Picture = f.Picture;
  return m;
}
/** The feature for a setting: none for Stock (SetMinimap). */
export const minimapFeature = (m) => (m && m.Mode !== STOCK ? { Mode: m.Mode, Picture: m.Picture ?? null } : null);
/** A file name from a path the desktop saved (C:\…\map.png → map.png). */
export const pictureFileName = (p) => (p || '').replace(/\\/g, '/').split('/').pop();

// ---------- building it (BuildMinimap) ----------

/** The stock picture's sea: the average of its four corner squares (SeaColour). */
export function seaColour(rgba, n) {
  const k = Math.max(4, Math.trunc(n / 32));
  let r = 0, g = 0, b = 0, c = 0;
  for (const oy of [0, n - k])
    for (const ox of [0, n - k])
      for (let y = oy; y < oy + k; y++)
        for (let x = ox; x < ox + k; x++) {
          const i = (y * n + x) * 4;
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
          c++;
        }
  return [Math.trunc(r / c), Math.trunc(g / c), Math.trunc(b / c)];
}

/** X/Z bounds of an object's vertices placed by state st (writeObject's maths, nothing written): [x0, z0, x1, z1]. */
export function boundsAt(o, st) {
  const m = o.mesh, P = m.baked ? m.baked.positions : m.positions, pv = o.pivot, t = st.t, s = st.s, R = rotation(st.r);
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  const end = (o.firstVertex + o.vertexCount) * 3;
  for (let i = o.firstVertex * 3; i < end; i += 3) {
    const x = (P[i] - pv[0]) * s[0], y = (P[i + 1] - pv[1]) * s[1], z = (P[i + 2] - pv[2]) * s[2];
    const wx = R[0] * x + R[1] * y + R[2] * z + pv[0] + t[0], wz = R[6] * x + R[7] * y + R[8] * z + pv[2] + t[2];
    if (wx < x0) x0 = wx;
    if (wx > x1) x1 = wx;
    if (wz < z0) z0 = wz;
    if (wz > z1) z1 = wz;
  }
  return x0 <= x1 ? [x0, z0, x1, z1] : null;
}

/**
 * The footprints that changed (MinimapChangeMask's boxes): a changed gimmick where it is now (unless removed) and where
 * the table has it (unless new); a moved, turned, sized or hidden object where it was and where it is now (unless
 * hidden). edited(o) says whether a gimmick differs from its table; position(o) is where its placement is now.
 */
export function changedFootprints(objects, edited, position) {
  const out = [];
  for (const o of objects) {
    if (!o.vertexCount) continue;
    const st = o.state;
    if (o.gimmick) {
      if (!edited(o)) continue;
      const b = boundsAt(o, { ...st, hidden: false });
      if (!b) continue;
      if (!st.hidden) out.push(b);
      if (!o.gimmick.isNew) {
        const p = position(o), p0 = o.gimmick.position0, dx = p0[0] - p[0], dz = p0[2] - p[2];
        out.push([b[0] + dx, b[1] + dz, b[2] + dx, b[3] + dz]);
      }
      continue;
    }
    if (!st.hidden && isIdentityTransform(st)) continue;
    const was = boundsAt(o, { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] });
    if (was) out.push(was);
    if (!st.hidden && o.bounds) out.push([o.bounds.min[0], o.bounds.min[2], o.bounds.max[0], o.bounds.max[2]]);
  }
  return out;
}

/** Per pixel how much of the redraw shows (0 stock … 1 redrawn), soft-edged: {mask, areas} (MinimapChangeMask). */
export function changeMask(n, footprints) {
  const mask = new Float32Array(n * n);
  const s = Math.fround(n / SPAN), h = Math.fround(n * 0.5);
  let areas = 0;
  for (const [x0, z0, x1, z1] of footprints) {
    const px0 = Math.max(0, Math.floor(Math.fround(h + Math.fround(Math.fround(x0 - AREA_PAD) * s))));
    const px1 = Math.min(n - 1, Math.ceil(Math.fround(h + Math.fround(Math.fround(x1 + AREA_PAD) * s))));
    const py0 = Math.max(0, Math.floor(Math.fround(h + Math.fround(Math.fround(z0 - AREA_PAD) * s))));
    const py1 = Math.min(n - 1, Math.ceil(Math.fround(h + Math.fround(Math.fround(z1 + AREA_PAD) * s))));
    if (px0 > px1 || py0 > py1) continue;
    for (let y = py0; y <= py1; y++) mask.fill(1, y * n + px0, y * n + px1 + 1);
    areas++;
  }
  if (areas) {
    const r = Math.max(2, Math.trunc(n / 256)); // a soft edge a few pixels wide
    boxBlur(mask, n, r);
    boxBlur(mask, n, r);
  }
  return { mask, areas };
}

/** A box blur of radius r along rows then columns, edges clamped, in float as the desktop's BoxBlur. */
export function boxBlur(m, n, r) {
  const t = new Float32Array(m.length), f = Math.fround, d = 2 * r + 1, cl = (v) => (v < 0 ? 0 : v > n - 1 ? n - 1 : v);
  for (let y = 0; y < n; y++) {
    const row = y * n;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum = f(sum + m[row + cl(x)]);
    for (let x = 0; x < n; x++) {
      t[row + x] = sum / d;
      sum = f(sum + f(m[row + Math.min(n - 1, x + r + 1)] - m[row + Math.max(0, x - r)]));
    }
  }
  for (let x = 0; x < n; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum = f(sum + t[cl(y) * n + x]);
    for (let y = 0; y < n; y++) {
      m[y * n + x] = sum / d;
      sum = f(sum + f(t[Math.min(n - 1, y + r + 1) * n + x] - t[Math.max(0, y - r) * n + x]));
    }
  }
}

/** Math.Round as .NET does it: halves to even. */
const roundEven = (v) => {
  const r = Math.round(v);
  return r - v === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

/** stock where the mask is 0, render where it is 1, blended between (Mix), opaque. */
export function mixMinimap(stock, render, mask) {
  const out = new Uint8Array(stock.length), f = Math.fround;
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const t = mask[i];
    if (t <= 0) out.set(stock.subarray(p, p + 3), p);
    else if (t >= 1) out.set(render.subarray(p, p + 3), p);
    else {
      const u = f(1 - t);
      for (let c = 0; c < 3; c++) out[p + c] = roundEven(f(f(stock[p + c] * u) + f(render[p + c] * t)));
    }
    out[p + 3] = 255;
  }
  return out;
}

/**
 * The map drawn from above (RenderTopDown's averaging): samples is the framebuffer read back (size = n·ss, rows
 * bottom-up), a sample with alpha 0 had nothing drawn on it and takes the sea colour; each ss × ss block averaged.
 */
export function averageSamples(samples, n, ss, sea) {
  const size = n * ss, out = new Uint8Array(n * n * 4), c = ss * ss;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const k = ((size - 1 - (y * ss + sy)) * size + x * ss + sx) * 4; // GL rows run bottom-up
          if (samples[k + 3] === 0) {
            r += sea[0];
            g += sea[1];
            b += sea[2];
          } else {
            r += samples[k];
            g += samples[k + 1];
            b += samples[k + 2];
          }
        }
      const o = (y * n + x) * 4;
      out[o] = Math.trunc(r / c);
      out[o + 1] = Math.trunc(g / c);
      out[o + 2] = Math.trunc(b / c);
      out[o + 3] = 255;
    }
  return out;
}

/** The ortho camera straight down over the minimap square (column-major): eye (0, 500000, 0), up −Z, near 10, far 1e6. */
export function topDownMatrix() {
  const h = SPAN / 2, N = 10, F = 1e6, eye = 500000, k = 2 / (F - N), c = (2 * (eye - N)) / (F - N) - 1;
  return new Float32Array([1 / h, 0, 0, 0, 0, 0, -k, 0, 0, -1 / h, 0, 0, 0, 0, c, 1]);
}
export const TOP_DOWN_EYE = [0, 500000, 0];
/** Air, not ground: Rainbow's rainbow arcs and Baby's mist are left out of the redraw (MinimapLeavesOut). */
export const leftOutOfMinimap = (m) => [m.sourceResource, m.name].some((s) => s && /rainbow|_mist/i.test(s));

/** Your picture drawn over the whole n × n, high quality, on black. */
export async function pictureMinimap(blob, n) {
  const src = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = n;
  const g = canvas.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, n, n);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, n, n);
  src.close?.();
  const d = g.getImageData(0, 0, n, n).data;
  const rgba = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return rgba;
}

/** The minimap as the entry's bytes: one-level DXT1, laid out as the desktop's BuildDxt1DdsFromRgba. */
export function minimapDds(w, h, rgba) {
  const out = new Uint8Array(128 + Math.ceil(w / 4) * Math.ceil(h / 4) * 8);
  const dv = new DataView(out.buffer);
  const u32 = (o, v) => dv.setUint32(o, v >>> 0, true);
  out.set([0x44, 0x44, 0x53, 0x20], 0); // "DDS "
  u32(4, 124);
  u32(8, 0x1 | 0x2 | 0x4 | 0x1000 | 0x80000);
  u32(12, h);
  u32(16, w);
  u32(20, Math.max(1, Math.trunc((w + 3) / 4)) * 8);
  u32(76, 32);
  u32(80, 4);
  out.set([0x44, 0x58, 0x54, 0x31], 84); // "DXT1"
  u32(108, 0x1000);
  const pix = new Uint8Array(64);
  let at = 128;
  for (let by = 0; by < h; by += 4)
    for (let bx = 0; bx < w; bx += 4) {
      for (let py = 0; py < 4; py++)
        for (let px = 0; px < 4; px++) {
          const s = (Math.min(by + py, h - 1) * w + Math.min(bx + px, w - 1)) * 4, d = (py * 4 + px) * 4;
          pix[d] = rgba[s];
          pix[d + 1] = rgba[s + 1];
          pix[d + 2] = rgba[s + 2];
          pix[d + 3] = rgba[s + 3];
        }
      dxt1Block(pix, out, at);
      at += 8;
    }
  return out;
}

/** The step to the next mode (StepMinimapMode): ±1 round the four, Picture skipped while none is chosen. */
export function stepMode(mode, d, hasPicture) {
  let m = (mode + d + 4) % 4;
  if (m === PICTURE && !hasPicture) m = (m + d + 4) % 4;
  return m;
}

// ---------- your picture, kept in this browser ----------

const PICTURE_STORE = 'happytool-web-minimap-picture:';

/** Keeps the minimap picture ({name, url}: a JPEG data URL) for the stage; false when the browser has no room for it. */
export function storeMinimapPicture(stage, pic) {
  const key = PICTURE_STORE + stage.toLowerCase();
  try {
    if (!pic) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ name: pic.name, url: pic.url }));
    return true;
  } catch {
    return false;
  }
}
/** The kept picture: {name, blob}, or null. */
export async function loadMinimapPicture(stage) {
  try {
    const raw = localStorage.getItem(PICTURE_STORE + stage.toLowerCase());
    if (!raw) return null;
    const { name, url } = JSON.parse(raw);
    return { name, blob: await (await fetch(url)).blob() };
  } catch {
    return null;
  }
}
/** A picture file as a JPEG data URL at most 2048 px across, for keeping. */
export async function pictureDataUrl(blob) {
  const src = await createImageBitmap(blob);
  const k = Math.min(1, 2048 / Math.max(src.width, src.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(src.width * k));
  canvas.height = Math.max(1, Math.round(src.height * k));
  const g = canvas.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, canvas.width, canvas.height);
  src.close?.();
  return canvas.toDataURL('image/jpeg', 0.9);
}
