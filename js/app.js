// HappyTool web: open Happy Wars data files, unwrap them, browse and edit, save with the original wrappers.
import { el, button, toast, pickFiles, openDialog, ask, confirmBox } from './ui.js';
import { decodeLayers, encodeLayers, writableLayers } from './formats/wrappers.js';
import { parseBres, writeBres } from './formats/bres.js';
import { parseLng, writeLng, validateLng } from './formats/lng.js';
import { parseVmd, writeVmd } from './formats/vmd.js';
import { parseRml, serializeRml } from './formats/rml.js';
import { isTrf, VIR_WARNING } from './formats/vir.js';
import { looksLikeFtdf, FNT_WARNING } from './formats/fnt.js';
import { sniff, KIND_LABELS, describeMagic } from './formats/sniff.js';
import { decodeText, encodeText, bytesEqual, formatSize, baseName, downloadBytes } from './util.js';
import { renderBres } from './views/bres-view.js';
import { renderStage } from './views/stage-view.js';
import { renderLng } from './views/lng-view.js';
import { renderText } from './views/text-view.js';
import { renderNut } from './views/nut-view.js';
import { renderMedia } from './views/media-view.js';
import { renderHex } from './views/hex-view.js';
import { renderVmd } from './views/vmd-view.js';
import { renderRml } from './views/rml-view.js';
import { renderVir } from './views/vir-view.js';
import { renderFnt } from './views/fnt-view.js';
import { renderTanda } from './views/tanda-view.js';
import { renderRra } from './views/rra-view.js';
import { dataRootOf, preferredLng, isSearchable } from './formats/lng-refs.js';
import { buildTree, renderSidebar, renderFolder, findFile, stageIdFor, loadStagePictures } from './browser.js';
import { loadHandle, saveHandle, forgetHandle, readDirectory } from './data-folder.js';
import { openPalette, setAppCommands } from './palette.js';
import { menuBar, contextMenu } from './menubar.js';
import { openQuickOpen } from './views/quick-open.js';
import { showFindInFiles } from './views/find-in-files.js';
import { showCompareFolders } from './views/compare-folders.js';
import { showBresCompare } from './views/bres-compare.js';
import { startGamepad } from './gamepad.js';

const $ = (id) => document.getElementById(id);
const dom = {
  list: $('file-list'),
  tree: $('side-tree'),
  filter: $('file-filter'),
  count: $('file-count'),
  crumbs: $('crumbs'),
  info: $('infobar'),
  view: $('view'),
  save: $('btn-save'),
  overlay: $('drop-overlay'),
};

/** @type {{path: string, file: File, stack: any[] | null, dirty: boolean, li?: HTMLElement}[]} */
let files = [];
let current = null;
let pendingJump = null; // where a script opened from go to definition should put the caret
const stack = () => current?.stack ?? [];
const top = () => stack().at(-1);

// ---------- folder browser state ----------

let tree = buildTree([]);
/** The folder shown when no file is open ('' = the top level), or null before anything is loaded. */
let browse = null;
/** Stage-select pictures for the map tiles: read again whenever files are added, the first time a folder with stages is shown. */
let stagePics = null;
function stagePicturesFor(dir) {
  if (stagePics?.tree === tree) return stagePics.pics;
  if (!dir || !dir.files.some((r) => stageIdFor(r.path))) return null;
  const job = (stagePics = { tree, pics: new Map(), problem: null, done: false });
  loadStagePictures(files)
    .then(({ pics, problem }) => {
      if (stagePics !== job) return;
      Object.assign(job, { pics, problem, done: true });
      if (problem) console.info(`Stage pictures: ${problem}`);
      if (!top() && pics.size) renderView();
    })
    .catch((e) => Object.assign(job, { problem: e.message, done: true }));
  return job.pics;
}
const expanded = new Set();
let savedHandle = null;
/** Whether to open the Data folder by itself on later visits: 'yes', 'no', or null (not asked yet). */
const REMEMBER_KEY = 'happytool-web-remember-data';
// Opera has showDirectoryPicker, but picking a folder with it can end with no permission prompt (so nothing opens), and
// reopening a folder handle kept in IndexedDB can crash it; there the plain folder picker (an <input>) is used instead.
const isOpera = /\bOPR\//.test(navigator.userAgent) || !!navigator.userAgentData?.brands?.some((b) => /opera/i.test(b.brand));
const folderAccess = !!window.showDirectoryPicker && !isOpera;
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const usesTree = () => tree.root.dirs.size > 0;

function readPref(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function writePref(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: preferences last for this visit only */
  }
}
const prefs = {
  mode: readPref('happytool-web-view', 'icons') === 'details' ? 'details' : 'icons',
  pins: [].concat(readPref('happytool-web-pins', [])).filter((p) => typeof p === 'string'),
  recent: [].concat(readPref('happytool-web-recent', [])).filter((p) => typeof p === 'string'),
};

function expandTo(path) {
  for (let d = path; d; d = dirOf(d)) expanded.add(d);
}

function browseTo(path) {
  browse = path;
  current = null;
  expandTo(path);
  render();
}

function noteRecent(path) {
  prefs.recent = [path, ...prefs.recent.filter((p) => p !== path)].slice(0, 20);
  writePref('happytool-web-recent', prefs.recent);
}

function togglePin(path) {
  prefs.pins = prefs.pins.includes(path) ? prefs.pins.filter((p) => p !== path) : [...prefs.pins, path];
  writePref('happytool-web-pins', prefs.pins);
  render();
}

async function openStage(rec) {
  await openFile(rec);
  const root = current === rec ? rec.stack?.[0] : null;
  if (root && root.kind === 'bres' && !root.showHex) {
    root.showMap = true;
    render();
  }
}

const sidebarActions = {
  browse: browseTo,
  open: (path) => {
    const rec = findFile(tree, path);
    if (rec) openFile(rec);
  },
  toggle: (path) => {
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
    renderFileList();
  },
};
const folderActions = {
  browse: browseTo,
  openRec: (rec) => openFile(rec),
  openStage,
  setMode: (m) => {
    prefs.mode = m;
    writePref('happytool-web-view', m);
    renderView();
  },
  togglePin,
  menu: (target, x, y, keyboard) => contextMenu(browserMenu(target), x, y, keyboard),
};

/**
 * The file browser's right-click menu, the desktop's (GameDataEditor ctxTree) less what a browser cannot do: Open in
 * Explorer, Install or check this stage… and Delete…; Open with BRES editor is left out too, as every .bres here
 * already opens in the bundle view. The full path is the path among the open files.
 */
function browserMenu({ rec = null, stage = false, dir = null }) {
  const path = rec ? rec.path : dir.path;
  const copy = (s) => navigator.clipboard.writeText(s).catch(() => {});
  return [
    { label: 'Open with editor', run: () => (stage ? openStage(rec) : openFile(rec)), enabled: () => !!rec },
    { label: 'Compare .rrm / .rmd models with other .bres…', run: () => compareBundlesOf(path), enabled: () => !!rec && /\.bres$/i.test(path) },
    { label: 'Copy full path', run: () => copy(path) },
    { label: 'Copy name', run: () => copy(baseName(path.replace(/[\\/]+$/, ''))) },
    { label: prefs.pins.includes(path) ? 'Unpin from Places' : 'Pin to Places', run: () => togglePin(path) },
  ];
}

// ---------- nodes: one decoded level (a file, or an entry inside a bundle) ----------

async function makeNode(name, raw, parent = null, entry = null) {
  const node = { name, raw, parent, entry, layers: [], payload: raw, kind: 'hex', model: null, dirty: false, showHex: false };
  try {
    const d = await decodeLayers(raw);
    node.layers = d.layers;
    node.payload = d.payload;
  } catch (e) {
    node.error = `Could not unwrap this file: ${e.message}`;
    return node;
  }
  loadModel(node);
  return node;
}

function loadModel(node) {
  const s = sniff(node.payload, node.name);
  node.kind = s.kind;
  node.mime = s.mime;
  node.model = null;
  node.error = node.warning = null;
  node.ui = null;
  try {
    if (s.kind === 'bres') node.model = parseBres(node.payload);
    else if (s.kind === 'lng') node.model = parseLng(node.payload);
    else if (s.kind === 'vmd') node.model = parseVmd(node.payload, !!node.parent);
    else if (s.kind === 'rml') node.model = parseRml(node.payload);
    else if (s.kind === 'vir' && !isTrf(node.payload)) node.warning = VIR_WARNING;
    else if (s.kind === 'fnt' && !looksLikeFtdf(node.payload)) {
      if (node.parent) node.kind = 'hex'; // the desktop's bundle editor opens only FTDF .fnt entries as fonts
      else node.warning = FNT_WARNING;
    }
    else if (s.kind === 'json' || s.kind === 'text') {
      node.model = decodeText(node.payload);
      if (!bytesEqual(encodeText(node.model.text, node.model.encoding), node.payload))
        node.warning = 'Some bytes in this file are not valid text in its encoding. Saving after an edit replaces them.';
    }
  } catch (e) {
    node.error = `This looks like a ${KIND_LABELS[s.kind].toLowerCase()} but could not be read: ${e.message}`;
    node.kind = 'hex';
    node.model = null;
  }
}

/** The node's current contents (without wrappers). Throws when the edits can't be saved. */
function serialize(node) {
  if (!node.dirty) return node.payload;
  switch (node.kind) {
    case 'bres':
      return writeBres(node.model);
    case 'lng': {
      const problems = validateLng(node.model);
      if (problems.length) throw new Error(problems.slice(0, 3).join('; ') + (problems.length > 3 ? ` (and ${problems.length - 3} more)` : ''));
      return writeLng(node.model);
    }
    case 'json':
    case 'text':
      return encodeText(node.model.text, node.model.encoding);
    case 'vmd':
      return writeVmd(node.model);
    case 'rml':
      return serializeRml(node.model);
    default:
      return node.payload;
  }
}

/** Write a child's edits back into its parent bundle entry, re-wrapping it the way it was stored. */
async function commit(node) {
  if (!node.dirty || !node.parent) return;
  const payload = serialize(node);
  const layers = writableLayers(node.layers);
  const bytes = await encodeLayers(payload, layers);
  Object.assign(node.entry, { data: bytes, size: bytes.length, pointer: false });
  Object.assign(node, { payload, raw: bytes, layers, dirty: false });
  node.parent.dirty = true;
}

// ---------- navigation ----------

async function openFile(rec) {
  browse = dirOf(rec.path);
  expandTo(browse);
  noteRecent(rec.path);
  if (current === rec && rec.stack) return render();
  current = rec;
  if (!rec.stack) {
    setBusy(`Opening ${rec.path}…`);
    try {
      rec.stack = [await makeNode(rec.path, new Uint8Array(await rec.file.arrayBuffer()))];
    } catch (e) {
      toast(`Could not read ${rec.path}: ${e.message}`, 'error');
      rec.stack = null;
      current = null;
    }
  }
  render();
}

async function openChild(index) {
  const parent = top();
  const entry = parent?.model?.entries?.[index];
  if (!entry) return;
  if (entry.pointer) return toast(`${entry.name} is streamed from another file, so this bundle holds no data for it`, 'warn');
  setBusy(`Opening ${entry.name}…`);
  current.stack.push(await makeNode(entry.name, entry.data, parent, entry));
  render();
}

/**
 * Opens the game's .lng at a text key (the script editor's "Open text key in .lng editor"): the .lng HappyTool
 * prefers under the open file's Data folder, or the .lng entry of plxDict_en.bres / Dict_en.bres. Returns a message
 * when there is none.
 */
async function openTextKey(key) {
  const paths = files.map((r) => r.path);
  const root = dataRootOf(current?.path ?? '');
  const hit = preferredLng(paths, root);
  if (!hit) return `No .lng file under ${root || 'the open files'}.`;
  const rec = files.find((r) => r.path === hit.path);
  pendingJump = { key };
  if (!hit.bundle) return void openFile(rec);
  await openFile(rec);
  if (current !== rec || !rec.stack) return null;
  const entries = rec.stack[0].model?.entries ?? [];
  const index = entries.findIndex((e) => /\.lng$/i.test(e.name) && !e.pointer);
  if (index < 0) return (pendingJump = null), `${baseName(rec.path)} has no .lng entry.`;
  if (rec.stack[1]?.entry === entries[index]) return null; // already open there: the render above took the key
  if (rec.stack.length > 1 && !(await popTo(0))) return null;
  pendingJump = { key };
  await openChild(index);
  return null;
}

/** Close levels above `level`, folding each one's edits into its parent first. */
async function popTo(level) {
  const s = stack();
  while (s.length - 1 > level) {
    const node = s.at(-1);
    try {
      await commit(node);
    } catch (e) {
      toast(`${node.name} can't be saved back yet: ${e.message}`, 'error');
      render();
      return false;
    }
    s.pop();
  }
  render();
  return true;
}

async function save(name) {
  if (!current?.stack) return;
  if (typeof name !== 'string' || !name.trim()) name = baseName(current.path);
  const s = current.stack;
  dom.save.disabled = true;
  try {
    for (let i = s.length - 1; i > 0; i--) await commit(s[i]);
    const root = s[0];
    const payload = serialize(root);
    const layers = writableLayers(root.layers);
    const bytes = await encodeLayers(payload, layers);
    downloadBytes(bytes, name);
    Object.assign(root, { payload, raw: bytes, layers, dirty: false });
    current.dirty = false;
    toast(`Saved ${name} (${formatSize(bytes.length)}). Your browser puts it in its downloads folder.`, 'ok');
  } catch (e) {
    toast(`Save failed: ${e.message}`, 'error', 10000);
  }
  render();
}

// ---------- rendering ----------

function setBusy(text) {
  dom.view.replaceChildren(el('div', { class: 'busy', role: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), text));
}

function render() {
  renderFileList();
  renderCrumbs();
  renderInfo();
  renderView();
  updateSave();
}

function updateSave() {
  dom.save.disabled = !current?.dirty;
  document.title = current ? `${current.dirty ? '• ' : ''}${baseName(current.path)} · HappyTool web` : 'HappyTool web';
}

function markDirty() {
  const node = top();
  if (!node) return;
  node.dirty = true;
  if (!current.dirty) {
    current.dirty = true;
    current.li?.classList.add('dirty');
    updateSave();
  }
}

function renderFileList() {
  const f = dom.filter.value.trim().toLowerCase();
  const asTree = usesTree() && !f;
  dom.tree.hidden = !asTree;
  dom.list.hidden = asTree;
  if (asTree) {
    dom.tree.replaceChildren(...renderSidebar({ tree, browse: current ? null : browse, currentPath: current?.path ?? null, expanded, pins: prefs.pins, recent: prefs.recent }, sidebarActions));
    dom.count.textContent = `${files.length} file${files.length === 1 ? '' : 's'}`;
    return;
  }
  const shown = files.filter((r) => !f || r.path.toLowerCase().includes(f));
  dom.list.replaceChildren(
    ...shown.map((r) => {
      const slash = r.path.lastIndexOf('/');
      r.li = el(
        'li',
        { class: [r === current ? 'active' : '', r.dirty ? 'dirty' : ''].join(' ').trim() || null },
        el(
          'button',
          { type: 'button', class: 'file-item', title: r.path, onclick: () => openFile(r), 'aria-current': r === current ? 'true' : null },
          el('span', { class: 'file-name' }, r.path.slice(slash + 1)),
          slash > 0 ? el('span', { class: 'file-dir' }, r.path.slice(0, slash)) : null,
          el('span', { class: 'file-size' }, formatSize(r.file.size)),
        ),
      );
      return r.li;
    }),
  );
  dom.count.textContent = files.length ? (f ? `${shown.length} of ${files.length} files` : `${files.length} file${files.length === 1 ? '' : 's'}`) : '';
}

function renderCrumbs() {
  const s = stack();
  // Folder segments first (each one shows that folder), then the open file and the bundle entries opened inside it.
  const folder = current ? dirOf(current.path) : browse;
  const items = [];
  if (usesTree() && folder) {
    const parts = folder.split('/');
    parts.forEach((p, i) => {
      const path = parts.slice(0, i + 1).join('/');
      items.push(!s.length && i === parts.length - 1 ? el('span', { class: 'crumb current', 'aria-current': 'page' }, p) : button(p, () => browseTo(path), { class: 'crumb', title: `Show ${path}` }));
    });
  }
  s.forEach((n, i) => {
    const label = i === 0 ? baseName(n.name) : n.name;
    items.push(i === s.length - 1 ? el('span', { class: 'crumb current', 'aria-current': 'page' }, label) : button(label, () => popTo(i), { class: 'crumb' }));
  });
  dom.crumbs.hidden = !items.length;
  dom.crumbs.replaceChildren(...items.flatMap((item, i) => (i ? [el('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›'), item] : [item])));
}

function renderInfo() {
  const node = top();
  dom.info.hidden = !node;
  if (!node) return;
  const parts = [el('span', { class: 'kind' }, KIND_LABELS[node.kind]), el('span', { class: 'muted' }, formatSize(node.payload.length))];
  if (node.layers.length) {
    parts.push(el('span', { class: 'muted' }, 'stored as'), ...node.layers.map((l) => el('span', { class: 'chip chip-layer', title: LAYER_HELP[l] }, l)));
  }
  parts.push(el('span', { class: 'spacer' }));
  if (node.kind !== 'hex' && node.kind !== 'nutc')
    parts.push(button(node.showHex ? 'Show preview' : 'Show bytes', () => ((node.showHex = !node.showHex), renderInfo(), renderView())));
  if (node.layers.length)
    parts.push(button('Download unwrapped', downloadUnwrapped, { title: 'Save the contents without the BFBR / ZRES shells' }));
  if (node.parent) parts.push(button('Replace…', replaceNode, { title: 'Replace this entry with a file from disk' }));
  else if (usesTree()) {
    const pinned = prefs.pins.includes(current.path);
    parts.push(button(pinned ? 'Unpin' : 'Pin to Places', () => togglePin(current.path), { title: pinned ? 'Remove this file from Pinned' : 'Keep this file under Pinned' }));
  }
  const banners = [];
  if (node.layers.includes('BSRS'))
    banners.push(el('p', { class: 'banner banner-warn' }, 'BSRS encryption can be read but not written (HappyTool works the same way). If you save, this part is stored without it.'));
  if (node.warning) banners.push(el('p', { class: 'banner banner-warn' }, node.warning));
  dom.info.replaceChildren(el('div', { class: 'info-row' }, ...parts), ...banners);
}

const LAYER_HELP = {
  BFBR: 'Blowfish-encrypted with a SHA-256 check',
  BSRS: 'Blowfish-encrypted (read only)',
  ZRES: 'zlib-compressed',
};

function renderView() {
  const node = top();
  if (!node) {
    dom.view.replaceChildren(files.length && browse !== null ? renderFolder({ tree, browse, mode: prefs.mode, pins: prefs.pins, pics: stagePicturesFor(tree.dirs.get(browse) ?? tree.root) }, folderActions) : emptyState());
    return;
  }
  const ctx = {
    node,
    changed: markDirty,
    rerender: () => (renderInfo(), renderView()),
    openChild,
    /** The File menu of an editor view (the script editor's): open, save, save as, close. */
    file: {
      open: openFilesPicker,
      save: () => (current?.dirty ? save() : toast('No changes to save.')),
      saveAs: async () => {
        const name = await ask('Save as', baseName(current.path), 'Save');
        if (name?.trim()) save(name.trim());
      },
      // Inside a bundle, Close goes back to it (the edits go with it); a file of its own goes back to its folder and
      // keeps its edits until it is saved.
      close: () => (stack().length > 1 ? popTo(stack().length - 2) : browseTo(browse ?? '')),
      closeLabel: stack().length > 1 ? 'Close (back to the bundle)' : 'Close',
      /** Back to the last saved bytes (inside a bundle: the last ones folded into it), as HappyTool's Reload. */
      reload: async () => {
        if (node.dirty && !(await confirmBox('Discard unsaved changes?', 'Discard', true))) return;
        loadModel(node);
        node.dirty = false;
        current.dirty = current.stack.some((n) => n.dirty);
        if (!current.dirty) current.li?.classList.remove('dirty');
        updateSave();
        render();
      },
    },
    showHex: () => ((node.showHex = true), renderInfo(), renderView()),
    /** The stage bundles among the open files (the map editor's "another stage's sky"), read from disk when asked. */
    stageBundles: () =>
      files
        .filter((r) => stageIdFor(r.path))
        .map((r) => ({ id: stageIdFor(r.path), path: r.path, read: async () => new Uint8Array(await r.file.arrayBuffer()) })),
    /** The open file's path (forward slashes). */
    filePath: current?.path ?? null,
    /**
     * The files of a Data folder beside the open stage bundle's own (`gimmick`, `json/stage`: Data/stage/x.bres →
     * Data/<dir>/…), not those in its subfolders, read from disk when asked.
     */
    dataFiles: (dir) => {
      const parts = (current?.path ?? '').split('/');
      if (parts.length < 2 || parts.at(-2).toLowerCase() !== 'stage') return [];
      const base = [...parts.slice(0, -2), ...dir.split('/')].join('/').toLowerCase() + '/';
      return files
        .filter((r) => r.path.toLowerCase().startsWith(base) && !r.path.slice(base.length).includes('/'))
        .map((r) => ({ name: r.path.slice(base.length), path: r.path, read: async () => new Uint8Array(await r.file.arrayBuffer()) }));
    },
    /**
     * The files of the open file's folder (or of `rel` from it, `..` for its parent), not those in its subfolders,
     * read from disk when asked: the .tanda viewer's companion bundle.
     */
    folderFiles: (rel = '') => {
      const parts = (current?.path ?? '').split('/').slice(0, -1);
      for (const seg of rel.split('/').filter(Boolean)) {
        if (seg !== '..') parts.push(seg);
        else if (!parts.length) return [];
        else parts.pop();
      }
      const base = parts.length ? parts.join('/').toLowerCase() + '/' : '';
      return files
        .filter((r) => r.path.toLowerCase().startsWith(base) && !r.path.slice(base.length).includes('/'))
        .map((r) => ({ name: r.path.slice(base.length), path: r.path, read: async () => new Uint8Array(await r.file.arrayBuffer()) }));
    },
    /** Every .nut script among the open files (the script editor's go to definition and code assist), read when asked. */
    scripts: () => files.filter((r) => /\.nut$/i.test(r.path)).map((r) => ({ path: r.path, read: async () => new Uint8Array(await r.file.arrayBuffer()) })),
    /** Opens an open file by path and hands the script editor where to put the caret ({line, name} or {pos, end}). */
    openScript: (path, jump) => {
      const rec = files.find((r) => r.path === path);
      if (!rec) return toast(`${path} is not open`, 'warn');
      pendingJump = jump ?? null;
      openFile(rec);
    },
    takeJump: () => {
      const j = pendingJump;
      pendingJump = null;
      return j;
    },
    /** The .nut / .json / .zson files of the open file's Data folder (every open file when it has none), for the text key search. */
    searchFiles: () => {
      const root = dataRootOf(current?.path ?? '');
      const base = root ? root.toLowerCase() + '/' : '';
      const list = files.filter((r) => r.path.toLowerCase().startsWith(base) && isSearchable(r.path));
      return { root, label: root, files: list.map((r) => ({ path: r.path, size: r.file.size, read: async () => new Uint8Array(await r.file.arrayBuffer()) })) };
    },
    /** Opens a text key search hit at its line (1-based), the key selected there; false when the file isn't open. */
    openAt: (path, line, key) => {
      const rec = files.find((r) => r.path === path);
      if (!rec) return toast(`${path} is not among the open files. Open its Data folder to edit it.`, 'warn'), false;
      pendingJump = { line: line - 1, name: /^\w+$/.test(key ?? '') ? key : undefined };
      openFile(rec);
      return true;
    },
    openTextKey,
  };
  let view;
  try {
    view = pickView(node, ctx);
  } catch (e) {
    console.error(e);
    view = renderHex(node, ctx, `This view failed (${e.message}); showing the bytes instead.`);
  }
  dom.view.replaceChildren(view);
}

function pickView(node, ctx) {
  if (node.error) return renderHex(node, ctx, node.error);
  if (node.showHex) {
    let shown = node;
    try {
      if (node.dirty) shown = { payload: serialize(node) };
    } catch (e) {
      return renderHex(node, ctx, `Showing the bytes as loaded; the edits can't be written yet: ${e.message}`);
    }
    return renderHex(shown, ctx, node.dirty ? 'Showing the bytes with your unsaved edits.' : null);
  }
  switch (node.kind) {
    case 'bres':
      if (node.showMap) return renderStage(node, { ...ctx, back: () => ((node.showMap = false), ctx.rerender()) });
      return renderBres(node, ctx);
    case 'lng':
      return renderLng(node, ctx);
    case 'json':
    case 'text':
      if (/\.nut$/i.test(node.name)) return renderNut(node, ctx);
      return renderText(node, ctx);
    case 'dds':
    case 'image':
      return renderMedia(node, ctx, ctx.showHex);
    case 'tanda':
      return renderTanda(node, ctx);
    case 'rra':
      return renderRra(node, ctx);
    case 'nutc':
      return renderHex(node, ctx, 'Compiled Squirrel script (bytecode). Shown as bytes.');
    case 'vmd':
      return renderVmd(node, ctx);
    case 'rml':
      return renderRml(node, ctx);
    case 'vir':
      return renderVir(node);
    case 'fnt':
      return renderFnt(node);
    default:
      return renderHex(node, ctx, node.payload.length ? `Binary data (starts with ${describeMagic(node.payload)}). Shown as bytes.` : null);
  }
}

function emptyState() {
  return el(
    'div',
    { class: 'empty' },
    el('h1', {}, 'Open Happy Wars data files'),
    el('p', {}, 'Point it at the game’s Data folder to browse it like HappyTool, or drop files or a folder anywhere on this page. Bundles (.bres), text tables (.lng), JSON, scripts and DDS textures are unwrapped from BFBR, BSRS and ZRES automatically, and stage bundles open as maps.'),
    el(
      'div',
      { class: 'empty-actions' },
      button('Open Data folder…', openDataFolder, { class: savedHandle && readPref(REMEMBER_KEY, null) === 'yes' ? 'btn' : 'btn btn-primary' }),
      savedHandle
        ? button(`Reopen ${savedHandle.name}`, reopenDataFolder, {
            class: readPref(REMEMBER_KEY, null) === 'yes' ? 'btn btn-primary' : 'btn',
            title: 'Open the folder you used last time. The browser asks to allow it again; “Allow on every visit” lets it open by itself next time.',
          })
        : null,
      button('Open files…', openFilesPicker),
    ),
    el('p', { class: 'muted small' }, 'On Steam the Data folder is usually C:\\Program Files (x86)\\Steam\\steamapps\\common\\Happy Wars\\Data.'),
    el(
      'p',
      { class: 'muted small' },
      folderAccess
        ? 'If the folder doesn’t open, drag the Data folder from File Explorer onto this page instead.'
        : 'If the browser asks to “upload” the files, they still stay on your computer. You can also drag the Data folder onto this page.',
    ),
    el('p', { class: 'muted small' }, 'Everything runs in this browser tab. Files are not uploaded anywhere; saving downloads a copy.'),
  );
}

async function downloadUnwrapped() {
  const node = top();
  try {
    const bytes = serialize(node);
    downloadBytes(bytes, baseName(node.name));
  } catch (e) {
    toast(`Can't write the edits yet: ${e.message}`, 'error');
  }
}

async function replaceNode() {
  const node = top();
  const [f] = await pickFiles();
  if (!f) return;
  const data = new Uint8Array(await f.arrayBuffer());
  // A file that already carries its own shells replaces the stored bytes as-is; a plain file is wrapped like the original.
  let decoded;
  try {
    decoded = await decodeLayers(data);
  } catch (e) {
    return toast(`${f.name} could not be unwrapped: ${e.message}`, 'error');
  }
  if (decoded.layers.length) node.layers = decoded.layers;
  node.payload = decoded.payload;
  loadModel(node);
  node.dirty = true;
  markDirty();
  toast(`Replaced ${node.name} with ${f.name}`, 'ok');
  renderInfo();
  renderView();
}

// ---------- adding files ----------

function addFiles(list) {
  let added = 0;
  let skipped = 0;
  for (const { file, path } of list) {
    const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
    const existing = files.find((r) => r.path === clean);
    if (existing) {
      if (existing.dirty) {
        skipped++;
        continue;
      }
      Object.assign(existing, { file, stack: null });
    } else files.push({ path: clean, file, stack: null, dirty: false });
    added++;
  }
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
  tree = buildTree(files);
  if (skipped) toast(`${skipped} file${skipped === 1 ? ' has' : 's have'} unsaved edits and ${skipped === 1 ? 'was' : 'were'} not reloaded`, 'warn');
  if (current && !current.stack) current = null;
  if (added === 1 || (!current && files.length === 1)) {
    const rec = files.find((r) => r.path === list[0].path.replace(/\\/g, '/').replace(/^\/+/, ''));
    if (rec) return openFile(rec);
  }
  if (added > 1) {
    // Show the folder that holds what was just added (the picked folder itself for a folder pick).
    const paths = list.map((x) => x.path.replace(/\\/g, '/').replace(/^\/+/, ''));
    let common = dirOf(paths[0]);
    for (const p of paths) while (common && !p.startsWith(`${common}/`)) common = dirOf(common);
    current = null;
    browse = common;
    expandTo(common);
    toast(`Added ${added} files.`, 'ok');
  }
  render();
}

async function openDataFolder() {
  if (!folderAccess) return openFolderPicker();
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'happywars-data', mode: 'read' });
  } catch (e) {
    if (e.name === 'AbortError') return;
    toast(`The browser would not open the folder that way (${e.message}). Pick it again in this dialog.`, 'warn');
    return openFolderPicker();
  }
  await loadDataFolder(handle);
}

async function reopenDataFolder() {
  try {
    if ((await savedHandle.queryPermission({ mode: 'read' })) !== 'granted' && (await savedHandle.requestPermission({ mode: 'read' })) !== 'granted')
      return toast('The browser did not allow reading that folder. Use Open Data folder… instead.', 'warn');
  } catch (e) {
    return toast(`Could not reopen ${savedHandle.name}: ${e.message}`, 'error');
  }
  await loadDataFolder(savedHandle);
}

async function loadDataFolder(handle) {
  setBusy(`Reading ${handle.name}…`);
  let list;
  try {
    list = await readDirectory(handle, (n) => setBusy(`Reading ${handle.name}… ${n} files`));
  } catch (e) {
    toast(`Could not read ${handle.name}: ${e.message}`, 'error');
    return render();
  }
  savedHandle = handle;
  if (!list.length) {
    toast(`${handle.name} has no files.`, 'warn');
    return render();
  }
  addFiles(list);
  if (list.length > 1) browseTo(handle.name);
  rememberFolder(handle);
}

/**
 * The first time a Data folder opens, asks whether to open it by itself on later visits (opt in or out); then keeps
 * the folder's handle (yes) or forgets it (no). Closing the question with Esc decides nothing, so it comes back.
 */
async function rememberFolder(handle) {
  let choice = readPref(REMEMBER_KEY, null);
  if (choice == null) {
    choice = await openDialog((dlg, done) =>
      dlg.append(
        el('h2', { class: 'dialog-title' }, 'Open this Data folder by itself next time?'),
        el(
          'p',
          { class: 'dialog-text' },
          `HappyTool web can remember ${handle.name} in this browser and open it again when you come back. The folder stays on your computer and nothing is uploaded. ` +
            'The browser may ask you to allow the folder again; “Allow on every visit” there lets it open without a click.',
        ),
        el('p', { class: 'dialog-text muted small' }, 'You can change this later in Find a feature (Ctrl+K): “Data folder”.'),
        el(
          'div',
          { class: 'dialog-actions' },
          button('Don’t remember', () => done('no')),
          button('Remember it', () => done('yes'), { class: 'btn btn-primary', autofocus: true }),
        ),
      ),
    );
    if (choice == null) return;
    writePref(REMEMBER_KEY, choice);
    toast(choice === 'yes' ? `${handle.name} will open by itself next time.` : `${handle.name} won’t be remembered.`, 'ok');
  }
  if (choice === 'yes') saveHandle(handle);
  else forgetHandle();
}

function setRememberFolder(on) {
  writePref(REMEMBER_KEY, on ? 'yes' : 'no');
  if (on && savedHandle) saveHandle(savedHandle);
  if (!on) {
    forgetHandle();
    if (!files.length) savedHandle = null;
  }
  toast(
    on ? (savedHandle ? `${savedHandle.name} will open by itself next time.` : 'The next Data folder you open will open by itself on later visits.') : 'The Data folder won’t be remembered.',
    'ok',
  );
  if (!files.length) render();
}

async function openFilesPicker() {
  const picked = await pickFiles({ multiple: true });
  if (picked.length) addFiles(picked.map((f) => ({ file: f, path: f.name })));
}

async function openFolderPicker() {
  const picked = await pickFiles({ directory: true });
  if (picked.length) addFiles(picked.map((f) => ({ file: f, path: f.webkitRelativePath || f.name })));
}

async function filesFromDrop(dt) {
  // webkitGetAsEntry must be called before the first await, while the drop event's data is still readable.
  const entries = [...dt.items].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files].map((f) => ({ file: f, path: f.name }));
  const out = [];
  const read = (reader) => new Promise((res, rej) => reader.readEntries(res, rej));
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (let batch = await read(reader); batch.length; batch = await read(reader))
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
    }
  }
  for (const e of entries) await walk(e, '');
  return out;
}

// ---------- wiring ----------

$('btn-open').addEventListener('click', openFilesPicker);
$('btn-open-folder').addEventListener('click', openDataFolder);
dom.save.addEventListener('click', save);
dom.filter.addEventListener('input', renderFileList);

const THEME_KEY = 'happytool-web-theme';
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  $('btn-theme').setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  $('btn-theme').textContent = dark ? '☀' : '☾';
}
try {
  applyTheme(localStorage.getItem(THEME_KEY));
} catch {
  applyTheme(null);
}
$('btn-theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* private mode */
  }
});

// The ☰ button hides the file list beside the page for more room; the choice is kept for the next visit.
const SIDEBAR_KEY = 'happytool-web-sidebar';
function showSidebar(on) {
  const what = on ? 'Hide the file list' : 'Show the file list';
  $('sidebar').hidden = !on;
  $('btn-sidebar').setAttribute('aria-expanded', String(on));
  $('btn-sidebar').setAttribute('aria-label', what);
  $('btn-sidebar').title = what;
}
showSidebar(readPref(SIDEBAR_KEY, true) !== false);
$('btn-sidebar').addEventListener('click', () => {
  const on = $('sidebar').hidden;
  showSidebar(on);
  writePref(SIDEBAR_KEY, on);
});

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dom.overlay.hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dom.overlay.hidden = true;
  }
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dom.overlay.hidden = true;
  const list = await filesFromDrop(e.dataTransfer);
  if (list.length) addFiles(list);
});

/**
 * One step back, as the desktop's controller Back does (GameDataEditor.HandleGamepadBack, BresBundleEditor's): out of a
 * bundle opened inside another, out of a file to its folder (its edits stay until it is saved), or up a folder.
 * False when there is nowhere to go.
 */
function stepBack() {
  if (current) {
    if (stack().length > 1) popTo(stack().length - 2);
    else browseTo(browse ?? dirOf(current.path));
    return true;
  }
  if (!canGoUp()) return false;
  browseTo(dirOf(browse));
  return true;
}
// The picked folder is the top, as the Data folder is on the desktop: above it is only that one folder again.
const canGoUp = () => !!browse && !(!dirOf(browse) && !tree.root.files.length && tree.root.dirs.size === 1);
/** What steps back from here, for Find a feature; null when nothing does. */
const stepBackLabel = () =>
  current ? (stack().length > 1 ? 'Back to the bundle this came from' : 'Back to the folder') : canGoUp() ? 'Up a folder' : null;
// The map takes Esc itself (deselect, leave a tool) and has its own way out (← Entries).
const mapShown = () => !!dom.view.querySelector('.stage-view');
const typingIn = (t) =>
  t instanceof Element &&
  (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
    (t.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(t.type)));

window.addEventListener('keydown', (e) => {
  const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
  if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowLeft' && (stack().length > 1 || !mapShown())) {
    // Alt+← (and the controller's View button, which sends it) steps back like the desktop's controller Back.
    e.preventDefault();
    stepBack();
  } else if (
    plain &&
    // Esc steps back from a folder or a file, Backspace goes up a folder in the browser, as the desktop's does.
    (e.key === 'Escape' || (e.key === 'Backspace' && !current)) &&
    !e.defaultPrevented &&
    !typingIn(e.target) &&
    !document.querySelector('dialog[open]') &&
    !mapShown()
  ) {
    if (stepBack()) e.preventDefault();
  } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (current?.dirty) save();
  }
});

// ---------- search and compare tools (the desktop's Quick Open, Find in files, Compare two folders) ----------

/** The Data folder the tools work in: the open file's, else the first one opened, else the opened folder ('' for loose files, null for none). */
function toolsRoot() {
  if (!files.length) return null;
  const data = dataRootOf(current?.path ?? '') || dataRootOf(files.find((r) => dataRootOf(r.path))?.path ?? '');
  if (data) return data;
  const top = files[0].path.split('/')[0];
  return files.every((r) => r.path.startsWith(top + '/')) ? top : '';
}

/** Shows a file in the browser with the focus on its tile (Quick Open's Ctrl+Enter, the desktop's reveal). */
function revealFile(path) {
  browseTo(dirOf(path));
  const name = path.slice(path.lastIndexOf('/') + 1);
  const hit = [...dom.view.querySelectorAll('.tile, .row-open')].find((b) => b.title.split('\n')[0] === path || (!b.title && b.textContent === name));
  hit?.focus();
  hit?.scrollIntoView({ block: 'nearest' });
}

function quickOpen() {
  openQuickOpen({
    files: () => files.map((r) => r.path),
    root: toolsRoot,
    // The desktop pins files only; a folder pinned to Places stays out of the list.
    pinned: () => prefs.pins.filter((p) => !tree.dirs.has(p)),
    recent: () => prefs.recent,
    togglePin: (p) => (togglePin(p), prefs.pins.includes(p)),
    unpin: (p) => prefs.pins.includes(p) && togglePin(p),
    removeRecent: (p) => {
      prefs.recent = prefs.recent.filter((x) => x !== p);
      writePref('happytool-web-recent', prefs.recent);
      renderFileList();
    },
    open: (p) => sidebarActions.open(p),
    reveal: revealFile,
  });
}

/** The open files as the search tools read them. */
const toolFiles = () => files.map((r) => ({ path: r.path, size: r.file.size, lastModified: r.file.lastModified, read: async () => new Uint8Array(await r.file.arrayBuffer()) }));

/** Opens a file a tool lists; false (with a note) when it is not among the open files. */
function openToolFile(path) {
  const rec = findFile(tree, path);
  if (!rec) return toast(`${path} is not among the open files. Open its Data folder to edit it.`, 'warn'), false;
  openFile(rec);
  return true;
}

function findInFiles() {
  showFindInFiles({
    files: toolFiles,
    root: toolsRoot,
    open: openToolFile,
  });
}

function compareFolders() {
  showCompareFolders({ files: toolFiles, root: toolsRoot, open: openToolFile });
}

/** Compare two bundles on the .bres `path` among the open files (the browser's context menu), or on none (Tools). */
function compareBundlesOf(path = null) {
  const rec = path ? findFile(tree, path) : null;
  showBresCompare({ workshop: rec ? { path: rec.path, read: async () => new Uint8Array(await rec.file.arrayBuffer()) } : null });
}

const toolItems = [
  { label: 'Quick Open…', keys: 'Ctrl+P', hint: 'Find a file in the Data folder by name (fuzzy)', run: quickOpen },
  { label: 'Find in files…', hint: 'Search the text of every file under a folder', run: findInFiles },
  { label: 'Compare two folders…', hint: 'List the files two folders do not share or that differ', run: compareFolders },
  { label: 'Compare two bundles…', hint: 'Pair the .rrm / .rmd models of two .bres bundles (renamed, changed, gone, new)', run: () => compareBundlesOf() },
];
$('btn-find').before(menuBar([{ label: 'Tools', items: toolItems }], 'Tools'));

// Quick Open: Ctrl+P anywhere, as in the desktop Workshop (inside Quick Open it moves down the list).
window.addEventListener(
  'keydown',
  (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'p' && !document.querySelector('dialog.quick-open[open]')) {
      e.preventDefault();
      e.stopPropagation();
      if (!document.querySelector('dialog[open]')) quickOpen();
    }
  },
  true,
);

// Find a feature: Ctrl+K anywhere (caught before the map viewer's own keys, where K toggles Solid).
window.addEventListener(
  'keydown',
  (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      e.stopPropagation();
      openPalette();
    }
  },
  true,
);
$('btn-find').addEventListener('click', openPalette);
// Controller: moves around the page like the desktop's (stick/D-pad, A, B, X/Y); Menu opens Find a feature.
startGamepad({ onMenu: openPalette });
setAppCommands(() => [
  ...toolItems.map((t) => ({ label: t.label, keys: t.keys, hint: t.hint, section: 'Tools', run: t.run })),
  ...(stepBackLabel() && !(mapShown() && stack().length < 2)
    ? [{ label: stepBackLabel(), keys: current ? 'Esc · Alt+←' : 'Esc · Backspace · Alt+←', section: 'Location', run: stepBack }]
    : []),
  ...(folderAccess
    ? [
        readPref(REMEMBER_KEY, null) === 'yes'
          ? { label: 'Stop opening the Data folder by itself (forget it)', section: 'Data folder', run: () => setRememberFolder(false) }
          : { label: 'Open the Data folder by itself next time (remember it)', section: 'Data folder', run: () => setRememberFolder(true) },
      ]
    : []),
]);

window.addEventListener('beforeunload', (e) => {
  if (files.some((r) => r.dirty)) e.preventDefault();
});

const problems = [];
if (!window.isSecureContext || !crypto?.subtle)
  problems.push('This page is not on a secure address (https or http://localhost), so the browser blocks the SHA-256 check that BFBR files need. Serve it as the README describes.');
if (typeof DecompressionStream === 'undefined')
  problems.push('This browser has no built-in zlib (DecompressionStream), so ZRES files cannot be opened. Use a current Chrome, Edge, Firefox or Safari.');
if (problems.length) $('env-warning').replaceChildren(...problems.map((p) => el('p', { class: 'banner banner-error' }, p)));

render();
if (folderAccess && readPref(REMEMBER_KEY, null) !== 'no')
  loadHandle().then(async (h) => {
    if (!h || files.length) return;
    savedHandle = h;
    let state = 'prompt';
    try {
      state = await h.queryPermission({ mode: 'read' });
    } catch {
      /* treated as not allowed yet */
    }
    // Asking for permission needs a click, so without it the Reopen button does the asking.
    if (readPref(REMEMBER_KEY, null) === 'yes' && state === 'granted' && !files.length) return loadDataFolder(h);
    render();
  });

// ---------- about ----------

const SOURCE_URL = 'https://github.com/Game-Preservation-HQ/HappyToolWeb';
$('btn-about').addEventListener('click', () =>
  openDialog((dlg, done) => {
    const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener' }, text);
    dlg.append(
      el(
        'div',
        { class: 'about' },
        el('h2', { class: 'dialog-title' }, 'HappyTool web'),
        el('p', {}, 'Copyright (C) 2026 Serenity, Game Preservation HQ.'),
        el(
          'p',
          {},
          'This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public ' +
            'License as published by the Free Software Foundation, version 3.',
        ),
        el(
          'p',
          {},
          'This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty ' +
            'of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.',
        ),
        el(
          'p',
          {},
          'If you share HappyTool web or a changed version of it, or run a changed version for other people over a network, keep this ' +
            'notice and the credit, and give those people its source code under the same license.',
        ),
        el('p', { class: 'about-links' }, link(`${SOURCE_URL}/blob/main/LICENSE`, 'License (GNU AGPL v3)'), link(SOURCE_URL, 'Source code')),
        el('div', { class: 'dialog-actions' }, button('Close', () => done(null), { autofocus: true })),
      ),
    );
  }),
);
