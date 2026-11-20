// Folder browser in the style of HappyTool's Game Data editor: Places and a folder tree on the left, an icon grid
// (or details list) of the shown folder on the right, stage bundles as picture tiles.
import { el, button } from './ui.js';
import { formatSize } from './util.js';
import { fileType, fileIconSvg, folderIconSvg, stageArtSvg, iconEl } from './icons.js';
import { readStagePictures, PICTURE_BUNDLE, STAGE_TABLE } from './formats/stage-pictures.js';

// The desktop Workshop's notes for well-known Data subfolders (GameDataEditor.Workshop.cs FolderNotes).
const FOLDER_NOTES = {
  stage: 'Stage maps',
  json: 'Game tables',
  character: 'Characters & equipment',
  gimmick: 'Siege weapons & props',
  campaign: 'Campaign',
  audio: 'Audio',
  sound: 'Audio',
  scaleform: 'Menus (Flash)',
  nut: 'Scripts',
  script: 'Scripts',
  font: 'Fonts',
  effect: 'Effects',
  motion: 'Animations',
  stagedeco: 'Seasonal decorations',
  text: 'Text',
  lng: 'Text',
  movie: 'Videos',
};
export const folderNote = (name) => FOLDER_NOTES[name.toLowerCase()] ?? '';

const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** Folder tree from the loaded files' paths. Returns the root and a path → folder map ('' is the root). */
export function buildTree(files) {
  const root = { name: '', path: '', dirs: new Map(), files: [], parent: null };
  const dirs = new Map([['', root]]);
  for (const rec of files) {
    const parts = rec.path.split('/');
    let d = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = d.dirs.get(parts[i]);
      if (!next) {
        next = { name: parts[i], path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [], parent: d };
        d.dirs.set(parts[i], next);
        dirs.set(next.path, next);
      }
      d = next;
    }
    d.files.push(rec);
  }
  return { root, dirs };
}

const sortedDirs = (d) => [...d.dirs.values()].sort((a, b) => byName(a.name, b.name));
const countFiles = (d) => d.files.length + [...d.dirs.values()].reduce((n, c) => n + countFiles(c), 0);

/** The stage id of a stage bundle (`…/stage/sligA.bres` → `sligA`), as StageSelectPictures.StageIdForBundle; else null. */
export function stageIdFor(path) {
  const parts = path.split('/');
  if (parts.length < 2 || parts.at(-2).toLowerCase() !== 'stage') return null;
  const m = /^(.+)\.bres$/i.exec(parts.at(-1));
  if (!m || /^navi_/i.test(m[1]) || !/^[A-Za-z][A-Za-z0-9_]{1,39}$/.test(m[1])) return null;
  return m[1];
}

/** `sforA` → `STAGE_SFOR_A`, the id the official tables use (StageNames.DefaultTableId). */
export function stageTableId(id) {
  const m = /^([a-z]+)([A-Z])$/.exec(id);
  return m ? `STAGE_${m[1].toUpperCase()}_${m[2]}` : `STAGE_${id.toUpperCase()}`;
}

const baseOf = (path) => path.slice(path.lastIndexOf('/') + 1);

/**
 * The stage-select pictures of an opened Data folder as PNG object URLs by lower-case stage id (read from
 * scaleform/UI_main.bres and the stage table, as the desktop Workshop does). The caller revokes the URLs.
 * @returns {Promise<{urls: Map<string,string>, problem: string|null}>}
 */
export async function loadStagePictureUrls(files) {
  const find = (rel) => files.find((r) => `/${r.path.toLowerCase()}`.endsWith(`/${rel.toLowerCase()}`));
  const bundle = find(PICTURE_BUNDLE);
  const urls = new Map();
  if (!bundle) return { urls, problem: `${PICTURE_BUNDLE} isn't in this folder.` };
  const table = find(STAGE_TABLE);
  const read = async (r) => new Uint8Array(await r.file.arrayBuffer());
  const { pictures, problem } = await readStagePictures(await read(bundle), table ? await read(table) : null);
  const canvas = document.createElement('canvas');
  for (const [id, pic] of pictures) {
    canvas.width = pic.width;
    canvas.height = pic.height;
    canvas.getContext('2d').putImageData(new ImageData(pic.rgba, pic.width, pic.height), 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (blob) urls.set(id.toLowerCase(), URL.createObjectURL(blob));
  }
  return { urls, problem };
}

// ---------- sidebar ----------

/**
 * Places (the Data folder and its subfolders, pins, recent files) and the folder tree.
 * @param {{tree, browse: string|null, currentPath: string|null, expanded: Set<string>, pins: string[], recent: string[]}} s
 * @param {{browse(path:string):void, open(path:string):void, toggle(path:string):void}} act
 */
export function renderSidebar(s, act) {
  const { tree } = s;
  const out = [];
  const tops = sortedDirs(tree.root);
  const placeItems = [];
  for (const top of tops) {
    placeItems.push(placeRow(top.path, top.name, folderIconSvg(20), `${countFiles(top)} files`, s.browse === top.path, () => act.browse(top.path)));
    for (const sub of sortedDirs(top)) {
      const note = folderNote(sub.name);
      if (note) placeItems.push(placeRow(sub.path, sub.name, folderIconSvg(20), note, s.browse === sub.path, () => act.browse(sub.path), true));
    }
  }
  if (placeItems.length) out.push(section('Places', placeItems));

  const pinned = s.pins.filter((p) => tree.dirs.has(p) || findFile(tree, p));
  if (pinned.length)
    out.push(
      section(
        'Pinned',
        pinned.map((p) =>
          tree.dirs.has(p)
            ? placeRow(p, baseOf(p), folderIconSvg(20), parentLabel(p), s.browse === p, () => act.browse(p))
            : placeRow(p, baseOf(p), fileIconSvg(p, 20), parentLabel(p), s.currentPath === p, () => act.open(p)),
        ),
      ),
    );
  const recent = s.recent.filter((p) => findFile(tree, p)).slice(0, 8);
  if (recent.length) out.push(section('Recent', recent.map((p) => placeRow(p, baseOf(p), fileIconSvg(p, 20), parentLabel(p), s.currentPath === p, () => act.open(p)))));

  if (tops.length) {
    const ul = el('ul', { class: 'tree', role: 'tree' });
    const add = (d, depth) => {
      const kids = sortedDirs(d);
      const open = s.expanded.has(d.path);
      const active = s.browse === d.path;
      ul.append(
        el(
          'li',
          { role: 'treeitem', 'aria-expanded': kids.length ? String(open) : null, 'aria-selected': String(active), class: active ? 'active' : null },
          el(
            'div',
            { class: 'tree-row', style: `padding-left:${4 + depth * 14}px` },
            kids.length
              ? el('button', { type: 'button', class: 'twisty', 'aria-label': open ? `Collapse ${d.name}` : `Expand ${d.name}`, onclick: () => act.toggle(d.path) }, open ? '▾' : '▸')
              : el('span', { class: 'twisty', 'aria-hidden': 'true' }),
            el('button', { type: 'button', class: 'tree-item', title: d.path, onclick: () => act.browse(d.path) }, iconEl(folderIconSvg(18, open && kids.length > 0)), el('span', { class: 'tree-name' }, d.name)),
          ),
        ),
      );
      if (open) for (const k of kids) add(k, depth + 1);
    };
    for (const t of tops) add(t, 0);
    out.push(section('Folders', [ul], true));
  }
  return out;
}

function section(title, items, raw = false) {
  return el('section', { class: 'side-section' }, el('h2', { class: 'side-head' }, title), raw ? items[0] : el('ul', { class: 'places' }, ...items));
}

function placeRow(path, name, icon, note, active, onclick, indent = false) {
  return el(
    'li',
    { class: [active ? 'active' : '', indent ? 'indent' : ''].join(' ').trim() || null },
    el('button', { type: 'button', class: 'place', title: path, onclick, 'aria-current': active ? 'true' : null }, iconEl(icon), el('span', { class: 'place-name' }, name), note ? el('span', { class: 'place-note' }, note) : null),
  );
}

const parentLabel = (p) => {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : '';
};

export function findFile(tree, path) {
  const i = path.lastIndexOf('/');
  const d = tree.dirs.get(i > 0 ? path.slice(0, i) : '');
  return d?.files.find((r) => r.path === path) ?? null;
}

// ---------- folder view ----------

/**
 * The shown folder as icons or a details list.
 * @param {{tree, browse: string, mode: 'icons'|'details', pins: string[]}} s
 * @param {{browse(path:string):void, openRec(rec):void, openStage(rec):void, setMode(m:string):void, togglePin(path:string):void}} act
 */
export function renderFolder(s, act) {
  const dir = s.tree.dirs.get(s.browse) ?? s.tree.root;
  const subdirs = sortedDirs(dir);
  const files = [...dir.files].sort((a, b) => byName(baseOf(a.path), baseOf(b.path)));
  const stages = files.filter((r) => stageIdFor(r.path));
  const others = files.filter((r) => !stageIdFor(r.path));
  const note = dir.path ? folderNote(dir.name) : '';
  const pinned = s.pins.includes(dir.path);

  const bar = el(
    'div',
    { class: 'toolbar' },
    iconEl(folderIconSvg(22)),
    el('strong', {}, dir.name || 'Opened files'),
    note ? el('span', { class: 'muted' }, note) : null,
    el('span', { class: 'muted small' }, `${subdirs.length ? `${subdirs.length} folder${subdirs.length === 1 ? '' : 's'}, ` : ''}${files.length} file${files.length === 1 ? '' : 's'}`),
    el('span', { class: 'spacer' }),
    dir.path ? button(pinned ? 'Unpin' : 'Pin to Places', () => act.togglePin(dir.path), { title: pinned ? 'Remove this folder from Pinned' : 'Keep this folder under Pinned' }) : null,
    el(
      'div',
      { class: 'seg', role: 'group', 'aria-label': 'View' },
      button('Icons', () => act.setMode('icons'), { 'aria-pressed': String(s.mode === 'icons') }),
      button('Details', () => act.setMode('details'), { 'aria-pressed': String(s.mode === 'details') }),
    ),
  );

  let body;
  if (!subdirs.length && !files.length) body = el('p', { class: 'muted' }, 'This folder is empty.');
  else if (s.mode === 'details') body = detailsTable(subdirs, files, act);
  else {
    body = el('div', { class: 'folder-scroll' });
    if (stages.length) {
      body.append(
        el('h3', { class: 'group-head' }, 'Maps'),
        el(
          'div',
          { class: 'tiles stage-tiles' },
          ...stages.map((r) => {
            const id = stageIdFor(r.path);
            const pic = s.pics?.get(id.toLowerCase());
            return el(
              'button',
              { type: 'button', class: `tile stage-tile${r.dirty ? ' dirty' : ''}`, title: `${r.path}\nOpen the map`, onclick: () => act.openStage(r) },
              pic ? el('span', { class: 'stage-pic' }, el('img', { src: pic, alt: '' })) : iconEl(stageArtSvg(), 'stage-pic'),
              el('span', { class: 'tile-name' }, id),
              el('span', { class: 'tile-note' }, stageTableId(id)),
            );
          }),
        ),
      );
      if (subdirs.length || others.length) body.append(el('h3', { class: 'group-head' }, 'Other files'));
    }
    body.append(
      el(
        'div',
        { class: 'tiles' },
        ...subdirs.map((d) =>
          el('button', { type: 'button', class: 'tile', title: `${d.path}\n${countFiles(d)} files`, onclick: () => act.browse(d.path) }, iconEl(folderIconSvg(48)), el('span', { class: 'tile-name' }, d.name), folderNote(d.name) ? el('span', { class: 'tile-note' }, folderNote(d.name)) : null),
        ),
        ...others.map((r) =>
          el(
            'button',
            { type: 'button', class: `tile${r.dirty ? ' dirty' : ''}`, title: `${r.path}\n${fileType(r.path).name}, ${formatSize(r.file.size)}`, onclick: () => act.openRec(r) },
            iconEl(fileIconSvg(r.path, 48)),
            el('span', { class: 'tile-name' }, baseOf(r.path)),
          ),
        ),
      ),
    );
  }
  return el('div', { class: 'view folder-view' }, bar, body);
}

function detailsTable(subdirs, files, act) {
  const row = (icon, name, type, size, onclick, dirty) =>
    el(
      'tr',
      {},
      el('td', { class: 'name' }, el('button', { type: 'button', class: `row-open${dirty ? ' dirty' : ''}`, onclick }, iconEl(icon), el('span', {}, name))),
      el('td', {}, type),
      el('td', { class: 'num' }, size),
    );
  return el(
    'div',
    { class: 'grid-wrap' },
    el(
      'table',
      { class: 'grid details' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Type'), el('th', { class: 'num' }, 'Size'))),
      el(
        'tbody',
        {},
        ...subdirs.map((d) => row(folderIconSvg(20), d.name, folderNote(d.name) || 'Folder', `${countFiles(d)} files`, () => act.browse(d.path))),
        ...files.map((r) => {
          const id = stageIdFor(r.path);
          return row(fileIconSvg(r.path, 20), baseOf(r.path), id ? `Stage map (${stageTableId(id)})` : fileType(r.path).name, formatSize(r.file.size), () => (id ? act.openStage(r) : act.openRec(r)), r.dirty);
        }),
      ),
    ),
  );
}
