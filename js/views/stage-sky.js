// Sky replacement for the map editor (HappyTool/GUI/StageViewerForm.Sky.cs). A stage's sky is 00_sky.rrm (with its
// cloud animation 00_sky.rrl) and its textures: a lat-long dome (skybase: U goes round, V runs from the zenith to the
// nadir, so a 360° equirectangular picture fits it as is), a cloud band under the horizon and cloud cards. The sky can
// be another stage's, a picture of your own or a colour preset, with its clouds shown or hidden. The view shows it
// live; the download writes it into a copy of the bundle (another stage's sky files and textures copied in, renamed
// when a name is taken), as the desktop export does.
import { decodeLayers } from '../formats/wrappers.js';
import { parseBres } from '../formats/bres.js';
import { decodeDds } from '../formats/dds.js';
import { buildSteamStage } from '../formats/steam-stage.js';
import { stripTextureExtension } from '../formats/rrm.js';
import { bytesEqual } from '../util.js';

const lower = (s) => (s ? s.toLowerCase() : s);
const texStem = (name) => lower(stripTextureExtension(name));
export const isSkyFile = (name) => /^00_sky\./i.test(name || '');

// ---------- the setting (StagePlacementEdits.SkyEdit) ----------

/** The sky setting in the desktop edits file's shape: {Mode?, Stage?, Picture?, Preset?, HideClouds?}, or null for the stage's own. */
export function cloneSky(s) {
  if (!s || typeof s !== 'object') return null;
  const mode = ['stage', 'picture', 'preset', 'dungeon'].includes(s.Mode) ? s.Mode : null;
  if (!mode && !s.HideClouds) return null;
  const o = {};
  if (mode) o.Mode = mode;
  if (typeof s.Stage === 'string' && s.Stage) o.Stage = s.Stage;
  if (typeof s.Picture === 'string' && s.Picture) o.Picture = s.Picture;
  if (typeof s.Preset === 'string' && s.Preset) o.Preset = s.Preset;
  if (s.HideClouds) o.HideClouds = true;
  return o;
}

export const sameSky = (a, b) => JSON.stringify(cloneSky(a)) === JSON.stringify(cloneSky(b));

/** The menu's status line (SkyLabel). */
export function skyLabel(s) {
  const clouds = s?.HideClouds ? ' · no clouds' : '';
  if (!s?.Mode) return `This stage's own${clouds}`;
  const what =
    s.Mode === 'stage' ? `Stage ${s.Stage}` : s.Mode === 'dungeon' ? `Happy Dungeons: ${s.Stage}` : s.Mode === 'picture' ? `Picture: ${s.Picture}` : `Preset: ${s.Preset}`;
  return what + clouds;
}

// ---------- pictures for the dome ----------

export const SKY_PRESETS = [
  { name: 'Clear day', top: [52, 128, 228], horizon: [206, 232, 255], bottom: [150, 196, 246] },
  { name: 'Sunset', top: [46, 62, 140], horizon: [255, 152, 86], bottom: [120, 70, 96] },
  { name: 'Dusk', top: [28, 22, 72], horizon: [206, 96, 146], bottom: [52, 32, 76] },
  { name: 'Night', top: [4, 7, 24], horizon: [34, 46, 92], bottom: [6, 8, 22], stars: true },
  { name: 'Overcast', top: [126, 136, 148], horizon: [196, 200, 206], bottom: [150, 156, 162] },
  { name: 'Storm', top: [34, 38, 52], horizon: [104, 112, 130], bottom: [44, 48, 62] },
  { name: 'Golden hour', top: [94, 150, 214], horizon: [255, 214, 140], bottom: [214, 160, 110] },
  { name: 'Toxic', top: [38, 70, 30], horizon: [176, 226, 96], bottom: [60, 92, 40] },
];

/** System.Random(seed) as .NET seeds it (Knuth's subtractive generator), so a preset's stars match the desktop's. */
function dotnetRandom(seed) {
  const MBIG = 2147483647;
  const sa = new Array(56).fill(0);
  let mj = 161803398 - (seed === -2147483648 ? 2147483647 : Math.abs(seed));
  sa[55] = mj;
  let mk = 1;
  for (let i = 1; i < 55; i++) {
    const ii = (21 * i) % 55;
    sa[ii] = mk;
    mk = mj - mk;
    if (mk < 0) mk += MBIG;
    mj = sa[ii];
  }
  for (let k = 1; k < 5; k++)
    for (let i = 1; i < 56; i++) {
      sa[i] -= sa[1 + ((i + 30) % 55)];
      if (sa[i] < 0) sa[i] += MBIG;
    }
  let inext = 0, inextp = 21;
  return {
    next(max) {
      if (++inext >= 56) inext = 1;
      if (++inextp >= 56) inextp = 1;
      let r = sa[inext] - sa[inextp];
      if (r === MBIG) r--;
      if (r < 0) r += MBIG;
      sa[inext] = r;
      return Math.trunc(r * (1 / MBIG) * max);
    },
  };
}

/** A 2:1 lat-long sky from a colour preset: top → horizon → bottom, stars for night (PresetSky). */
export function presetSky(p) {
  const w = 1024, h = 512;
  const rgba = new Uint8Array(w * h * 4);
  const mix = (a, b, t) => a.map((x, k) => Math.trunc(x + (b[k] - x) * t));
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    const c = v < 0.5 ? mix(p.top, p.horizon, Math.pow(v / 0.5, 2.2)) : mix(p.horizon, p.bottom, Math.pow((v - 0.5) / 0.5, 0.6));
    for (let x = 0; x < w; x++) rgba.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
  }
  if (p.stars) {
    const rnd = dotnetRandom(7);
    // Two-texel stars, so they survive the stretch over the whole sky.
    for (let k = 0; k < 700; k++) {
      const x = rnd.next(w - 1), y = rnd.next(Math.trunc((h * 45) / 100));
      const a = 150 + rnd.next(106);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) rgba.set([a, a, Math.min(255, a + 20), 255], ((y + dy) * w + x + dx) * 4);
    }
  }
  return { width: w, height: h, rgba };
}

/** Your picture as the dome, 2048 × 1024: a 360° panorama (2:1) as it is, anything else stretched round the sky (PictureSky). */
export async function pictureSky(blob) {
  const src = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 1024;
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, canvas.width, canvas.height);
  src.close?.();
  const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
  return { width: canvas.width, height: canvas.height, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), canvas };
}

// ---------- which texture is what ----------

/** The dome's texture (skybase, else the first sky batch's) and the cloud textures (every other one) (SkyTextureRoles). */
export function textureRoles(meshes) {
  const all = meshes.flatMap((m) => (m.batches || []).map((b) => b.texture)).filter(Boolean);
  const dome = all.find((t) => /skybase/i.test(t)) ?? all[0] ?? null;
  const clouds = [];
  for (const t of all) if (lower(t) !== lower(dome) && !clouds.some((c) => lower(c) === lower(t))) clouds.push(t);
  return { dome, clouds };
}

// ---------- another stage's sky ----------

/**
 * Reads another stage's sky from its bundle file (ReadSkyPack): its 00_sky files and the textures its batches use
 * (their stored bytes, which the download copies as the desktop does), its sky meshes and their decoded textures (for
 * the view).
 */
export async function readSkyPack(id, fileBytes) {
  const arc = parseBres((await decodeLayers(fileBytes)).payload);
  const files = [];
  for (const e of arc.entries)
    if (isSkyFile(e.name) && !e.pointer && e.data?.length) files.push({ name: e.name, cmd: e.cmd, raw: e.data, data: (await decodeLayers(e.data)).payload });
  if (!files.some((f) => /\.rrm$/i.test(f.name))) throw new Error(`${id} has no sky.`);
  const dds = arc.entries.filter((e) => /\.dds$/i.test(e.name));
  const built = buildSteamStage([
    ...files.filter((f) => /\.rrm$/i.test(f.name)).map((f) => ({ name: f.name, pointer: false, data: f.data })),
    ...dds.map((e) => ({ name: e.name, pointer: true, data: null })),
  ]);
  let meshes = built.meshes.filter((m) => m.positions.length >= 9 && m.indices.length >= 3);
  const named = meshes.filter((m) => /sky/i.test(m.name));
  if (named.length) meshes = named;
  const used = new Set(meshes.flatMap((m) => (m.batches || []).map((b) => lower(b.texture)).filter(Boolean)));
  const textures = new Map(), texFiles = [];
  for (const e of dds) {
    const key = texStem(e.name);
    if (!used.has(key) || textures.has(key) || e.pointer || !e.data?.length) continue;
    const data = (await decodeLayers(e.data)).payload;
    texFiles.push({ name: e.name, cmd: e.cmd, raw: e.data });
    try {
      textures.set(key, decodeDds(data));
    } catch (err) {
      console.warn(`Sky of ${id}: ${e.name} could not be decoded: ${err.message}`);
    }
  }
  return { id, files, texFiles, meshes, textures };
}

// ---------- the download ----------

/**
 * A copy of the bundle with the sky applied (ApplySkyToBundle): another stage's textures added (renamed when this
 * stage has a different texture under that name) and its sky files in place of this stage's; the dome replaced by
 * domeDds; the cloud textures made clear. Returns the new archive and a one-line summary.
 */
export async function bakeSky(arc, sky, pack, roles, domeDds) {
  const res = arc.entries.map((e) => ({ ...e }));
  const find = (name) => res.findIndex((e) => lower(e.name) === lower(name));
  const findTexture = (stem) => res.findIndex((e) => /\.dds$/i.test(e.name) && texStem(e.name) === lower(stem));
  const payloadOf = async (e) => (e.pointer || !e.data?.length ? null : (await decodeLayers(e.data)).payload);
  const put = (i, data) => (res[i] = { ...res[i], pointer: false, size: data.length, data });
  const lines = [];
  const rename = new Map();
  if (pack) {
    for (const t of pack.texFiles) {
      const stem = t.name.replace(/\.[^.]*$/, '');
      const at = find(t.name);
      if (at >= 0 && !res[at].pointer && res[at].data && bytesEqual(res[at].data, t.raw)) continue;
      let name = stem;
      if (at >= 0) {
        name = `${pack.id}_${stem}`;
        for (let n = 2; find(`${name}.dds`) >= 0; n++) name = `${pack.id}_${stem}${n}`;
        rename.set(lower(stem), name);
      }
      res.push({ name: `${name}.dds`, cmd: t.cmd, pointer: false, size: t.raw.length, data: t.raw });
    }
    for (let i = res.length - 1; i >= 0; i--) if (isSkyFile(res[i].name) && pack.files.some((f) => lower(f.name) === lower(res[i].name))) res.splice(i, 1);
    for (const f of pack.files) {
      let data = f.raw;
      if (/\.rrm$/i.test(f.name) && rename.size) {
        data = f.data.slice(); // the decoded model, so the rename works on a wrapped entry too
        for (const [from, to] of rename)
          if (!renameTextureField(data, from, to)) throw new Error(`Could not rename the sky texture ${from} (its name field is too short).`);
      }
      res.push({ name: f.name, cmd: f.cmd, pointer: false, size: data.length, data });
    }
    lines.push(`Sky: stage ${pack.id}'s (${pack.texFiles.length} texture(s)${rename.size ? `, ${rename.size} renamed` : ''}).`);
  }
  const final = (t) => rename.get(lower(t)) ?? t;
  if (domeDds && roles.dome) {
    const at = findTexture(final(roles.dome));
    if (at < 0) throw new Error(`The sky's dome texture ${roles.dome} isn't in the bundle.`);
    put(at, domeDds);
    lines.push(sky.Mode === 'picture' ? `Sky picture: ${sky.Picture}.` : `Sky colours: ${sky.Preset}.`);
  }
  if (sky.HideClouds) {
    let hidden = 0;
    for (const c of roles.clouds) {
      const at = findTexture(final(c));
      if (at < 0) continue;
      const clear = clearDds(await payloadOf(res[at]));
      if (!clear) continue;
      put(at, clear);
      hidden++;
    }
    lines.push(`Clouds hidden (${hidden} texture(s) made clear).`);
  }
  return { archive: { ...arc, entries: res }, summary: lines.join(' ') };
}

/**
 * Renames a texture in a model's material table in place: every "old.ext" that starts a name field and whose field
 * has room (zeros) for the new name. False when one doesn't fit or none was found (RenameTextureField).
 */
export function renameTextureField(rrm, oldName, newName) {
  const find = [...`${oldName}.`].map((c) => c.toLowerCase().charCodeAt(0));
  let any = false;
  for (let i = 1; i + find.length < rrm.length; i++) {
    if (rrm[i - 1] !== 0) continue;
    let match = true;
    for (let k = 0; k < find.length && match; k++) match = String.fromCharCode(rrm[i + k]).toLowerCase().charCodeAt(0) === find[k];
    if (!match) continue;
    const end = rrm.indexOf(0, i);
    if (end < 0) continue;
    const ext = String.fromCharCode(...rrm.subarray(i + oldName.length, end)); // ".psd"
    const repl = [...(newName + ext)].map((c) => c.charCodeAt(0) & 0x7f);
    if (repl.length > 0x7f) return false;
    for (let k = end; k <= i + repl.length; k++) if (k >= rrm.length || rrm[k] !== 0) return false;
    rrm.set(repl, i);
    any = true;
    i += repl.length;
  }
  return any;
}

/** The same DDS (size, format, mips) fully transparent: DXT3 / DXT5 all-zero blocks, DXT1 punch-through blocks (ClearDds). */
export function clearDds(dds) {
  if (!dds || dds.length < 128 || dds[0] !== 0x44 || dds[1] !== 0x44 || dds[2] !== 0x53) return null;
  const four = String.fromCharCode(dds[84], dds[85], dds[86], dds[87]);
  const o = dds.slice();
  const data = four === 'DX10' ? 148 : 128;
  o.fill(0, data);
  if (four === 'DXT1') for (let i = data; i + 7 < o.length; i += 8) o.set([0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], i); // colour0 < colour1, every texel index 3
  else if (four !== 'DXT3' && four !== 'DXT5') return null;
  return o;
}

// ---------- DXT1 encoder (StageKitWriter.EncodeDds) ----------

/** One DXT1 block of 16 RGBA texels: the box's darkest and brightest corners as ends, nearest of four colours each (EncodeDxt1Block). */
function dxt1Block(pix, out, o) {
  let minR = 255, minG = 255, minB = 255, maxR = 0, maxG = 0, maxB = 0;
  for (let i = 0; i < 16; i++) {
    const r = pix[i * 4], g = pix[i * 4 + 1], b = pix[i * 4 + 2];
    if (r < minR) minR = r;
    if (g < minG) minG = g;
    if (b < minB) minB = b;
    if (r > maxR) maxR = r;
    if (g > maxG) maxG = g;
    if (b > maxB) maxB = b;
  }
  let c0 = ((maxR >> 3) << 11) | ((maxG >> 2) << 5) | (maxB >> 3);
  let c1 = ((minR >> 3) << 11) | ((minG >> 2) << 5) | (minB >> 3);
  const pack = (indices) => {
    out[o] = c0 & 0xff;
    out[o + 1] = c0 >> 8;
    out[o + 2] = c1 & 0xff;
    out[o + 3] = c1 >> 8;
    out[o + 4] = indices & 0xff;
    out[o + 5] = (indices >>> 8) & 0xff;
    out[o + 6] = (indices >>> 16) & 0xff;
    out[o + 7] = (indices >>> 24) & 0xff;
  };
  if (c0 === c1) return pack(0);
  if (c0 < c1) [c0, c1] = [c1, c0];
  const e0 = [(c0 >> 11) << 3, ((c0 >> 5) & 0x3f) << 2, (c0 & 0x1f) << 3];
  const e1 = [(c1 >> 11) << 3, ((c1 >> 5) & 0x3f) << 2, (c1 & 0x1f) << 3];
  const pal = [e0, e1, e0.map((x, k) => Math.trunc((2 * x + e1[k] + 1) / 3)), e0.map((x, k) => Math.trunc((x + 2 * e1[k] + 1) / 3))];
  let indices = 0;
  for (let i = 0; i < 16; i++) {
    let best = 0, bestDist = Infinity;
    for (let p = 0; p < 4; p++) {
      const dr = pix[i * 4] - pal[p][0], dg = pix[i * 4 + 1] - pal[p][1], db = pix[i * 4 + 2] - pal[p][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    indices |= best << (i * 2);
  }
  pack(indices >>> 0);
}

/** An opaque DXT1 DDS with a full, box-filtered mip chain, laid out as the desktop writes it. */
export function encodeDxt1Dds(w, h, rgba) {
  let mips = 1;
  for (let s = Math.max(w, h); s > 1; s >>= 1) mips++;
  let total = 128;
  for (let m = 0, lw = w, lh = h; m < mips; m++, lw = Math.max(1, lw >> 1), lh = Math.max(1, lh >> 1)) total += Math.ceil(lw / 4) * Math.ceil(lh / 4) * 8;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  const u32 = (o, v) => dv.setUint32(o, v >>> 0, true);
  out.set([0x44, 0x44, 0x53, 0x20], 0); // "DDS "
  u32(4, 124);
  u32(8, 0xa1007);
  u32(12, h);
  u32(16, w);
  u32(20, Math.max(1, Math.trunc((w + 3) / 4)) * Math.max(1, Math.trunc((h + 3) / 4)) * 8);
  u32(28, mips);
  u32(76, 32);
  u32(80, 4);
  out.set([0x44, 0x58, 0x54, 0x31], 84); // "DXT1"
  u32(108, 0x401008);
  let at = 128;
  let level = rgba, lw = w, lh = h;
  const pix = new Uint8Array(64);
  for (let m = 0; m < mips; m++) {
    for (let by = 0; by < lh; by += 4)
      for (let bx = 0; bx < lw; bx += 4) {
        for (let py = 0; py < 4; py++)
          for (let px = 0; px < 4; px++) {
            const s = (Math.min(by + py, lh - 1) * lw + Math.min(bx + px, lw - 1)) * 4, d = (py * 4 + px) * 4;
            pix[d] = level[s];
            pix[d + 1] = level[s + 1];
            pix[d + 2] = level[s + 2];
            pix[d + 3] = level[s + 3];
          }
        dxt1Block(pix, out, at);
        at += 8;
      }
    if (lw === 1 && lh === 1) break;
    const nw = Math.max(1, lw >> 1), nh = Math.max(1, lh >> 1);
    const next = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++)
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(x * 2, lw - 1), x1 = Math.min(x * 2 + 1, lw - 1), y0 = Math.min(y * 2, lh - 1), y1 = Math.min(y * 2 + 1, lh - 1);
        const s0 = (y0 * lw + x0) * 4, s1 = (y0 * lw + x1) * 4, s2 = (y1 * lw + x0) * 4, s3 = (y1 * lw + x1) * 4, d = (y * nw + x) * 4;
        for (let c = 0; c < 4; c++) next[d + c] = (level[s0 + c] + level[s1 + c] + level[s2 + c] + level[s3 + c] + 2) >> 2;
      }
    level = next;
    lw = nw;
    lh = nh;
  }
  return at === total ? out : out.subarray(0, at);
}

// ---------- your picture, kept in this browser ----------

const PICTURE_STORE = 'happytool-web-sky-picture:';

/** Keeps the dome picture (as a JPEG) with the stage's edits; false when the browser has no room for it. */
export function storePicture(stage, pic) {
  const key = PICTURE_STORE + stage.toLowerCase();
  try {
    if (!pic) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ name: pic.name, url: pic.canvas.toDataURL('image/jpeg', 0.9) }));
    return true;
  } catch {
    return false;
  }
}

export async function loadPicture(stage) {
  try {
    const raw = localStorage.getItem(PICTURE_STORE + stage.toLowerCase());
    if (!raw) return null;
    const { name, url } = JSON.parse(raw);
    const blob = await (await fetch(url)).blob();
    return { name, ...(await pictureSky(blob)) };
  } catch {
    return null;
  }
}
