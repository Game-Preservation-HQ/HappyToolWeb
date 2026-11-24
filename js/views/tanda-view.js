// HappyTool's UI layout viewer (GUI/TandaFileEditor.cs) for Happy Wars .tanda ("TLAD") scenes. Read-only: a widget
// tree with its properties and a scene preview, the decoded textures of the companion bundle, the sprite and colour
// tables, and the text report.
import { el, button, toast, downloadBlob, openDialog } from '../ui.js';
import { baseName } from '../util.js';
import {
  parseTanda,
  hex,
  countWidgets,
  netFloat,
  netFloatR,
  resolveTemplateRef,
  findSceneRoot,
  colorRgb,
  colorHex,
  buildFullReport,
} from '../formats/tanda.js';
import { loadTandaTextures } from '../formats/x360tex.js';

const ORANGE = 'rgb(255, 165, 0)';
const TRANSIENT = new Set(['enter', 'over', 'overed', 'unover', 'out', 'disabled', 'hide']);
const PT = 96 / 72; // GDI+ font points to pixels on a 96 dpi bitmap
const n0 = (v) => v.toLocaleString('en-US');
const trunc = (s, n) => (!s ? '' : s.length <= n ? s : s.slice(0, n) + '…');
// (int)Math.Round(f * 255f), clamped (TandaFileEditor.Clamp255; Math.Round is banker's).
function clamp255(f) {
  const x = Math.fround(f * 255);
  let r = Math.round(x);
  if (Math.abs(x % 1) === 0.5) r = 2 * Math.round(x / 2);
  return Number.isNaN(r) ? 0 : Math.max(0, Math.min(255, r));
}

// One parse and one texture load per opened payload, kept across re-renders.
const cache = new WeakMap();

/** The companion bundle of the open file: the bundle itself for an entry, else FindCompanionBres's candidates. */
function textureSource(node, ctx) {
  const list = (rel) => (ctx.folderFiles ? ctx.folderFiles(rel) : []);
  const reader = (files, name) => ({
    name,
    read: async (fileName, existsOnly) => {
      const f = files.find((r) => r.name.toLowerCase() === fileName.toLowerCase());
      if (!f) return null;
      return existsOnly ? true : f.read();
    },
  });
  if (node.parent) {
    // An entry of a bundle: TandaTextureCatalog.LoadFromBundle(bytes, the bundle file's path).
    const path = ctx.filePath ?? '';
    return reader(list(''), baseName(path));
  }
  const path = ctx.filePath ?? node.name;
  const stem = baseName(path).replace(/\.[^.]*$/, '');
  const parts = path.split('/');
  const dirName = parts.length >= 2 ? parts.at(-2) : '';
  const here = list('');
  const up = parts.length >= 2 ? list('..') : [];
  const has = (files, name) => files.some((r) => r.name.toLowerCase() === name.toLowerCase());
  for (const [files, name] of [
    [here, stem + '.bres'],
    [up, stem + '.bres'],
    [up, dirName + '.bres'],
  ]) {
    if (name !== '.bres' && has(files, name)) return reader(files, name);
  }
  return null;
}

function stateFor(node, ctx) {
  let st = cache.get(node.payload);
  if (st) return st;
  st = { doc: null, error: null, textures: null, texError: null, texFailed: false, texPromise: null, canvases: new Map(), selected: null, tab: 'scene', expanded: new Set() };
  try {
    st.doc = parseTanda(node.payload);
  } catch (e) {
    st.error = e.message;
  }
  if (st.doc?.isValid) {
    const src = textureSource(node, ctx);
    st.texPromise = (src
      ? loadTandaTextures(node.payload, src.name, src.read)
      : Promise.resolve({ entries: [], error: 'No companion .bres/.pres bundle found next to this .tanda.' })
    ).then(
      (r) => {
        st.textures = r.entries;
        st.texError = r.error;
      },
      (e) => {
        st.textures = [];
        st.texFailed = true;
        console.debug('tanda textures:', e.message);
      },
    );
  }
  cache.set(node.payload, st);
  return st;
}

function textureCanvas(st, i) {
  if (st.canvases.has(i)) return st.canvases.get(i);
  const t = st.textures[i];
  let c = null;
  if (t?.rgba) {
    c = document.createElement('canvas');
    c.width = t.width;
    c.height = t.height;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(t.rgba.buffer, t.rgba.byteOffset, t.width * t.height * 4), t.width, t.height), 0, 0);
  }
  st.canvases.set(i, c);
  return c;
}

// TandaFileEditor.ResolveSpriteBitmap.
function spriteSource(st, s) {
  if (!st.textures || !s) return null;
  const doc = st.doc;
  const resName = s.slot >= 0 && s.slot < doc.resources.length ? doc.resources[s.slot] : '';
  if (resName) {
    let logical = resName;
    const slash = Math.max(logical.lastIndexOf('\\'), logical.lastIndexOf('/'));
    if (slash >= 0) logical = logical.slice(slash + 1);
    const dot = logical.indexOf('.');
    if (dot > 0) logical = logical.slice(0, dot);
    const lo = logical.toLowerCase();
    for (let i = 0; i < st.textures.length; i++) {
      const t = st.textures[i];
      if (!t.rgba) continue;
      const n = t.name.toLowerCase();
      if (n === lo || n.endsWith('/' + lo) || n.endsWith('\\' + lo) || baseName(n) === lo) return textureCanvas(st, i);
    }
  }
  if (s.page >= 0 && s.page < st.textures.length && st.textures[s.page].rgba) return textureCanvas(st, s.page);
  for (let i = 0; i < st.textures.length; i++) if (st.textures[i].rgba) return textureCanvas(st, i);
  return null;
}

function drawChecker(g, w, h, c) {
  for (let y = 0; y < h; y += c)
    for (let x = 0; x < w; x += c) {
      g.fillStyle = ((x / c + y / c) & 1) === 0 ? 'rgb(70, 70, 70)' : 'rgb(90, 90, 90)';
      g.fillRect(x, y, c, c);
    }
}

function isTransient(name) {
  const n = (name ?? '').replace(/^_/, '').toLowerCase();
  return TRANSIENT.has(n);
}

function drawImageWidget(g, st, w, hi) {
  const hw = Math.fround(w.halfWidth * (w.scaleX !== 0 ? w.scaleX : 1));
  const hh = Math.fround(w.halfHeight * (w.scaleY !== 0 ? w.scaleY : 1));
  const left = w.layoutX - hw;
  const top = w.layoutY - hh;
  const dw = hw * 2;
  const dh = hh * 2;
  let src = w.sprite ? spriteSource(st, w.sprite) : null;
  if (src) {
    const s = w.sprite;
    try {
      g.drawImage(src, s.u0 * src.width, s.v0 * src.height, Math.max(1, (s.u1 - s.u0) * src.width), Math.max(1, (s.v1 - s.v0) * src.height), left, top, dw, dh);
    } catch {
      src = null;
    }
  }
  if (!src) {
    g.fillStyle = `rgba(80, 140, 220, ${(hi ? 120 : 60) / 255})`;
    g.fillRect(left, top, dw, dh);
  }
  if (hi || !src) {
    g.strokeStyle = hi ? ORANGE : `rgba(180, 200, 255, ${140 / 255})`;
    g.lineWidth = hi ? 2 : 1;
    g.strokeRect(left, top, dw, dh);
  }
}

function drawTextWidget(g, w, hi) {
  const text = w.labels.length > 0 ? w.labels[0] : w.name;
  if (!text) return;
  const size = w.fontSize > 0 ? Math.max(8, w.fontSize * 0.55) : 14;
  let [r, gg, b] = [clamp255(w.fontR), clamp255(w.fontG), clamp255(w.fontB)];
  if (r + gg + b < 40) [r, gg, b] = [255, 255, 255];
  g.font = `bold ${size * PT}px "Segoe UI", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = `rgba(0, 0, 0, ${160 / 255})`;
  g.fillText(text, w.layoutX + 1, w.layoutY + 1);
  g.fillStyle = hi ? ORANGE : `rgb(${r}, ${gg}, ${b})`;
  g.fillText(text, w.layoutX, w.layoutY);
  g.textAlign = 'start';
  g.textBaseline = 'alphabetic';
}

function drawWidgetTree(g, st, w, drawn, highlight) {
  if (!w || drawn.has(w)) return;
  drawn.add(w);
  const hi = w === highlight;
  // Three independent checks, as the desktop: a template leaf with a label draws its text and its template.
  if (w.isLeaf && w.widgetType === 2 && w.halfWidth > 0.5 && w.halfHeight > 0.5 && !isTransient(w.name)) drawImageWidget(g, st, w, hi);
  if (
    w.isLeaf &&
    (w.widgetType === 0 || w.fontName || w.labels.length > 0) &&
    (w.layoutX !== 0 || w.layoutY !== 0) &&
    w.widgetType !== 1 &&
    w.widgetType !== 2 &&
    !isTransient(w.name)
  )
    drawTextWidget(g, w, hi);
  if (w.isLeaf && w.widgetType === 4) {
    const target = resolveTemplateRef(st.doc, w.name);
    if (target) drawWidgetTree(g, st, target, drawn, highlight);
  }
  for (const c of w.children) drawWidgetTree(g, st, c, drawn, highlight);
}

// TandaFileEditor.RebuildPreview.
function rebuildPreview(canvas, st, highlight) {
  const doc = st.doc;
  if (!doc?.isValid) {
    canvas.width = 0;
    canvas.height = 0;
    return;
  }
  let cw = 1280;
  let ch = 720;
  for (const w of doc.widgets)
    if (w.width >= 640 && w.height >= 360) {
      cw = Math.max(cw, w.width);
      ch = Math.max(ch, w.height);
    }
  cw = Math.min(Math.max(cw, 320), 1920);
  ch = Math.min(Math.max(ch, 240), 1080);
  canvas.width = cw;
  canvas.height = ch;
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.fillStyle = 'rgb(28, 28, 32)';
  g.fillRect(0, 0, cw, ch);
  drawChecker(g, cw, ch, 16);
  let root = highlight?.isContainer ? highlight : null;
  if (!root) root = findSceneRoot(doc);
  const drawn = new Set();
  if (root) drawWidgetTree(g, st, root, drawn, highlight);
  else for (const w of doc.widgets) drawWidgetTree(g, st, w, drawn, highlight);

  if (highlight && (highlight.layoutX !== 0 || highlight.layoutY !== 0 || highlight.halfWidth > 0 || highlight.halfHeight > 0)) {
    const hw = highlight.halfWidth > 0 ? highlight.halfWidth * highlight.scaleX : Math.max(20, highlight.width) * 0.5;
    const hh = highlight.halfHeight > 0 ? highlight.halfHeight * highlight.scaleY : Math.max(12, highlight.height) * 0.5;
    const left = highlight.layoutX - hw;
    const top = highlight.layoutY - hh;
    g.fillStyle = `rgba(255, 160, 0, ${50 / 255})`;
    g.fillRect(left, top, hw * 2, hh * 2);
    g.strokeStyle = ORANGE;
    g.lineWidth = 2;
    g.strokeRect(left, top, hw * 2, hh * 2);
    g.font = `bold ${9 * PT}px "Segoe UI", sans-serif`;
    g.textBaseline = 'top';
    g.fillStyle = ORANGE;
    g.fillText(highlight.name, left + 2, top + 2);
  }
  g.font = `${9 * PT}px "Segoe UI", sans-serif`;
  g.textBaseline = 'top';
  g.fillStyle = `rgba(220, 220, 220, ${200 / 255})`;
  g.fillText(root ? `Scene: ${root.name}  (${cw}×${ch})` : `All roots  (${cw}×${ch})`, 8, 8);
  g.textBaseline = 'alphabetic';
}

// TandaFileEditor.WidgetProps, categories in the order a Categorized PropertyGrid shows them (alphabetical).
function widgetProps(w, doc) {
  const s = w.sprite;
  const tags = w.taggedBlocks.map((t) => t.name);
  for (const t of w.stretchTags) if (!tags.includes(t)) tags.push(t);
  if (w.textureUnMerge) tags.push('Texture UnMerge');
  if (w.hasFontControl) tags.push('Font Controll');
  if (w.hasPattern) tags.push('pattern');
  const bool = (b) => (b ? 'True' : 'False');
  const sections = w.sections
    .map((x) => `[${x.slot}] +0x${hex(x.absoluteOffset)}×${x.count}` + (x.values && x.values.length >= 3 ? ` (${netFloat(x.values[1], 1)},${netFloat(x.values[2], 1)})` : ''))
    .join('; ');
  return [
    [
      'Content',
      [
        ['Labels', w.labels.join(' | ')],
        ['ChildCount', w.children.length],
        ['StateCount', w.stateTransitions.length],
        ['States', w.stateTransitions.map((t) => `${t.from}→${t.to}@${netFloat(t.time, 2)}`).join('; ')],
        ['Tags', tags.join(', ')],
      ],
    ],
    [
      'Font',
      [
        ['FontName', w.fontName ?? ''],
        ['FontSize', w.fontSize],
        ['FontFlags', w.fontFlags],
        ['FontColor', `(${netFloat(w.fontR, 2)}, ${netFloat(w.fontG, 2)}, ${netFloat(w.fontB, 2)})`],
      ],
    ],
    [
      'Identity',
      [
        ['Name', w.name],
        ['FileOffset', '0x' + hex(w.fileOffset)],
        ['Size', `0x${hex(w.size)} (${w.size})`],
        ['Index', w.index],
        ['Depth', w.depth],
        ['WidgetType', w.widgetType],
        ['SpritePage', w.spritePage],
        ['LocalId', w.localId],
        ['IsContainer', bool(w.isContainer)],
        ['IsLeaf', bool(w.isLeaf)],
      ],
    ],
    [
      'Layout',
      [
        ['Width', w.width],
        ['Height', w.height],
        ['LayoutX', netFloatR(w.layoutX)],
        ['LayoutY', netFloatR(w.layoutY)],
        ['HalfWidth', netFloatR(w.halfWidth)],
        ['HalfHeight', netFloatR(w.halfHeight)],
        ['DrawSize', `${netFloat(Math.fround(Math.fround(w.halfWidth * 2) * w.scaleX), 1)}×${netFloat(Math.fround(Math.fround(w.halfHeight * 2) * w.scaleY), 1)}`],
        ['ScaleX', netFloatR(w.scaleX)],
        ['ScaleY', netFloatR(w.scaleY)],
        ['FrameRate', netFloatR(w.frameRate)],
      ],
    ],
    [
      'Payload',
      [
        ['PayloadOff0', '0x' + hex(w.payloadOff0)],
        ['PayloadOff1', '0x' + hex(w.payloadOff1)],
        ['PayloadOff2', '0x' + hex(w.payloadOff2)],
        ['Sections', sections],
      ],
    ],
    [
      'Sprite',
      [
        ['Sprite', s ? `#${s.index} page=${s.page} slot=${s.slot} ${s.width}×${s.height}` : '(none)'],
        ['Resource', s && s.slot >= 0 && s.slot < doc.resources.length ? doc.resources[s.slot] : ''],
      ],
    ],
  ];
}

function propsTable(w, doc) {
  if (!w) return el('div', { class: 'note', style: 'padding: 8px' }, 'Select a widget to see its properties.');
  const rows = [];
  for (const [cat, props] of widgetProps(w, doc)) {
    rows.push(el('tr', {}, el('th', { colspan: 2 }, cat)));
    for (const [k, v] of props) rows.push(el('tr', {}, el('td', {}, k), el('td', {}, String(v))));
  }
  return el('table', {}, el('tbody', {}, rows));
}

function widgetLabel(w) {
  let label = w.name;
  if (w.children.length > 0) label += '  [' + w.children.length + ']';
  if (w.fontName) label += '  font';
  if (w.stateTransitions.length > 0) label += '  states';
  if (w.labels.length > 0) label += '  "' + trunc(w.labels[0], 16) + '"';
  return label;
}

/** The widget tree (TreeView): click or arrow keys select, the twisty or Left/Right fold. */
function widgetTree(st, onSelect) {
  const host = el('div', { class: 'tanda-tree', role: 'tree', 'aria-label': 'Widgets' });
  const items = new Map();
  const build = (w, depth) => {
    const kids = w.children;
    const open = st.expanded.has(w);
    const item = el('div', { class: 'tree-item' + (st.selected === w ? ' sel' : ''), tabindex: st.selected === w ? 0 : -1, role: 'treeitem', 'aria-selected': String(st.selected === w), title: widgetLabel(w) }, widgetLabel(w));
    if (kids.length) item.setAttribute('aria-expanded', String(open));
    const twisty = el('button', { type: 'button', class: 'twisty', tabindex: -1, 'aria-hidden': 'true' }, kids.length ? (open ? '▾' : '▸') : '');
    const row = el('div', { class: 'tree-row', style: `padding-left: ${depth * 14}px` }, twisty, item);
    items.set(w, item);
    item.addEventListener('click', () => onSelect(w));
    twisty.addEventListener('click', () => toggle(w));
    const box = el('div', {}, row);
    if (kids.length && open) for (const c of kids) box.append(build(c, depth + 1));
    return box;
  };
  const visible = () => [...host.querySelectorAll('.tree-item')];
  const redraw = () => {
    items.clear();
    host.replaceChildren(...st.doc.widgets.map((w) => build(w, 0)));
    if (!st.selected) visible()[0]?.setAttribute('tabindex', '0');
  };
  const toggle = (w) => {
    if (st.expanded.has(w)) st.expanded.delete(w);
    else st.expanded.add(w);
    redraw();
    items.get(st.selected ?? w)?.focus();
  };
  const parentOf = (target, list = st.doc.widgets, parent = null) => {
    for (const w of list) {
      if (w === target) return parent;
      const p = parentOf(target, w.children, w);
      if (p !== undefined) return p;
    }
    return undefined;
  };
  host.addEventListener('keydown', (e) => {
    const rows = visible();
    const ws = [...items.keys()].filter((w) => rows.includes(items.get(w)));
    ws.sort((a, b) => rows.indexOf(items.get(a)) - rows.indexOf(items.get(b)));
    const cur = st.selected ?? ws[0];
    const i = ws.indexOf(cur);
    let next = null;
    if (e.key === 'ArrowDown') next = ws[Math.min(ws.length - 1, i + 1)];
    else if (e.key === 'ArrowUp') next = ws[Math.max(0, i - 1)];
    else if (e.key === 'Home') next = ws[0];
    else if (e.key === 'End') next = ws.at(-1);
    else if (e.key === 'ArrowRight' && cur?.children.length) {
      if (!st.expanded.has(cur)) toggle(cur);
      else next = cur.children[0];
    } else if (e.key === 'ArrowLeft' && cur) {
      if (st.expanded.has(cur)) toggle(cur);
      else next = parentOf(cur) ?? null;
    } else return;
    e.preventDefault();
    if (next) onSelect(next);
  });
  const select = (w) => {
    for (const [k, it] of items) {
      const on = k === w;
      it.classList.toggle('sel', on);
      it.setAttribute('aria-selected', String(on));
      it.tabIndex = on ? 0 : -1;
    }
    const it = items.get(w);
    if (it) {
      it.focus({ preventScroll: true });
      it.scrollIntoView({ block: 'nearest' });
    }
  };
  redraw();
  return { host, select };
}

function sceneTab(st) {
  const props = el('div', { class: 'tanda-props' });
  const canvas = el('canvas', { 'aria-label': 'Scene preview' });
  const preview = el('div', { class: 'tanda-preview' }, canvas);
  const choose = (w) => {
    st.selected = w;
    tree.select(w);
    props.replaceChildren(propsTable(w, st.doc));
    rebuildPreview(canvas, st, w);
  };
  const tree = widgetTree(st, choose);
  props.append(propsTable(st.selected, st.doc));
  rebuildPreview(canvas, st, st.selected);
  return { el: el('div', { class: 'tanda-scene' }, tree.host, props, preview), refresh: () => rebuildPreview(canvas, st, st.selected) };
}

function textureThumb(src) {
  const c = el('canvas', { width: 128, height: 128 });
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  drawChecker(g, 128, 128, 8);
  const scale = Math.min(128 / src.width, 128 / src.height);
  const w = Math.max(1, Math.trunc(src.width * scale));
  const h = Math.max(1, Math.trunc(src.height * scale));
  g.drawImage(src, Math.trunc((128 - w) / 2), Math.trunc((128 - h) / 2), w, h);
  return c;
}

function showTexture(st, i) {
  const t = st.textures[i];
  const src = textureCanvas(st, i);
  openDialog((dlg, done) => {
    dlg.classList.add('tanda-detail');
    const big = el('canvas', { width: t.width, height: t.height, 'aria-label': t.name });
    big.getContext('2d').drawImage(src, 0, 0);
    const save = () =>
      src.toBlob((blob) => (blob ? downloadBlob(blob, baseName(t.name) + '.png') : toast('Could not encode the PNG.', 'error')), 'image/png');
    dlg.append(
      el('h2', { class: 'dialog-title' }, `${t.name} — ${t.format} ${t.width}x${t.height}`),
      big,
      el('div', { class: 'dialog-actions' }, button('Save PNG…', save), button('Close', () => done(null), { autofocus: true })),
    );
  });
}

function texturesTab(st) {
  if (!st.textures) return el('div', { class: 'note' }, 'Loading textures…');
  if (st.texFailed) return el('div', { class: 'note' }, '');
  if (st.textures.length === 0) return el('div', { class: 'note', style: 'padding: 10px 0' }, '  ' + (st.texError ?? 'No textures found.'));
  const tiles = st.textures.map((t, i) => {
    const src = t.rgba ? textureCanvas(st, i) : null;
    const label = src ? `${t.name}\n${t.format} ${t.width}x${t.height}` : `${t.name}\n(${t.note ?? 'not decoded'})`;
    const tile = el(
      'div',
      { class: 'tile', tabindex: 0, title: label, ondblclick: () => src && showTexture(st, i), onkeydown: (e) => e.key === 'Enter' && src && showTexture(st, i) },
      src ? textureThumb(src) : el('div', { style: 'width: 128px; height: 128px' }),
      el('div', { class: 'tile-name' }, label),
    );
    return tile;
  });
  return el('div', { class: 'tiles tanda-tex' }, tiles);
}

function spritesTab(doc) {
  const head = ['Idx', 'Page', 'Slot', 'Size', 'U0', 'U1', 'V0', 'V1', 'Resource'];
  const rows = doc.sprites.map((s) =>
    el(
      'tr',
      {},
      el('td', {}, s.index),
      el('td', {}, s.page),
      el('td', {}, s.slot),
      el('td', {}, `${s.width}×${s.height}`),
      ...[s.u0, s.u1, s.v0, s.v1].map((v) => el('td', {}, netFloat(v, 3))),
      el('td', { class: 'name' }, s.slot >= 0 && s.slot < doc.resources.length ? doc.resources[s.slot] : ''),
    ),
  );
  return el('div', { class: 'grid-wrap' }, el('table', { class: 'grid' }, el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))), el('tbody', {}, rows)));
}

function colorsTab(doc) {
  const head = ['Idx', 'Size', 'RGB', 'Hex', 'Swatch'];
  const rows = doc.colors.map((c) => {
    const [r, g, b] = colorRgb(c);
    return el(
      'tr',
      {},
      el('td', {}, c.index),
      el('td', {}, `${c.width}×${c.height}`),
      el('td', {}, `(${netFloat(c.r, 2)}, ${netFloat(c.g, 2)}, ${netFloat(c.b, 2)})`),
      el('td', {}, colorHex(c)),
      el('td', {}, el('span', { class: 'tanda-swatch', style: `background: rgb(${r}, ${g}, ${b})`, title: colorHex(c) })),
    );
  });
  return el('div', { class: 'grid-wrap' }, el('table', { class: 'grid' }, el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))), el('tbody', {}, rows)));
}

export function renderTanda(node, ctx) {
  const p = node.payload;
  // BresBundleEditor opens a bundle entry only when it starts with TLAD (LooksLikeTanda).
  if (node.parent && !(p.length >= 4 && p[0] === 0x54 && p[1] === 0x4c && p[2] === 0x41 && p[3] === 0x44))
    return el('div', { class: 'view tanda-view' }, el('div', { class: 'banner', role: 'status' }, 'This entry is not a .tanda UI scene.'));
  const st = stateFor(node, ctx);
  const doc = st.doc;
  const title = node.parent ? `${baseName(ctx.filePath ?? '')} → ${node.name}` : ctx.filePath ?? node.name;
  let header = node.parent ? title : ctx.filePath ?? title;
  if (doc) {
    header += '  |  ' + n0(node.payload.length) + ' bytes';
    if (doc.isValid)
      header += `  |  TLAD “${doc.sceneName}”  |  ${countWidgets(doc.widgets)} widgets, ${doc.sprites.length} sprites, ${doc.colors.length} colors, ${doc.resources.length} resources`;
    else header += '  |  not a TLAD scene';
  }
  const view = el('div', { class: 'view tanda-view' }, el('div', { class: 'toolbar' }, el('span', { class: 'note', title: 'UI layout (.tanda)' }, header)));
  if (!doc) {
    view.append(el('div', { class: 'banner banner-error', role: 'alert' }, `Could not open file: ${st.error}`));
    return view;
  }
  if (!doc.isValid) view.append(el('div', { class: 'banner banner-warn', role: 'alert' }, 'This file does not look like a Happy Wars .tanda ("TLAD") UI scene.'));
  if (doc.isValid && st.selected == null && doc.widgets.length) st.expanded.add(doc.widgets[0]);

  const texLabel = () => (!st.textures ? 'Textures' : st.texFailed ? 'Textures (error)' : st.textures.length === 0 ? 'Textures (0)' : `Textures (${st.textures.filter((t) => t.rgba).length})`);
  const tabs = [
    ['scene', () => `Scene (${countWidgets(doc.widgets)})`],
    ['textures', texLabel],
    ['sprites', () => `Sprites (${doc.sprites.length})`],
    ['colors', () => `Colors (${doc.colors.length})`],
    ['info', () => 'Info'],
  ];
  const body = el('div', { class: 'tanda-body', style: 'flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: auto' });
  const bar = el('div', { class: 'seg', role: 'group', 'aria-label': 'UI scene views' });
  let scene = null;
  const show = (key) => {
    st.tab = key;
    for (const b of bar.children) b.setAttribute('aria-pressed', String(b.dataset.tab === key));
    if (key === 'scene') {
      scene = sceneTab(st);
      body.replaceChildren(scene.el);
    } else {
      scene = null;
      if (key === 'textures') body.replaceChildren(texturesTab(st));
      else if (key === 'sprites') body.replaceChildren(spritesTab(doc));
      else if (key === 'colors') body.replaceChildren(colorsTab(doc));
      else body.replaceChildren(el('pre', { class: 'lng-report', style: 'margin: 0; white-space: pre; overflow: auto' }, buildFullReport(doc)));
    }
  };
  for (const [key, label] of tabs) bar.append(button(label(), () => show(key), { dataset: { tab: key } }));
  view.append(el('div', { class: 'tabs-bar' }, bar), body);
  show(st.tab);
  // Textures load after the scene; then the tab count and the preview catch up (LoadTextures → RebuildPreview).
  st.texPromise?.then(() => {
    if (!view.isConnected) return;
    const tb = bar.querySelector('[data-tab="textures"]');
    if (tb) tb.textContent = texLabel();
    if (st.tab === 'textures') show('textures');
    else scene?.refresh();
  });
  return view;
}
