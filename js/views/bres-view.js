// BRES bundle view: entry table with selection, open, extract, replace, add, rename, delete and extract-all.
import { el, button, toast, ask, confirmBox, pickFiles, downloadBlob } from '../ui.js';
import { sniff, KIND_LABELS } from '../formats/sniff.js';
import { SHELLS } from '../formats/wrappers.js';
import { makeZip } from '../formats/zip.js';
import { looksLikeStage } from './stage-view.js';
import { ascii4, formatSize, baseName, downloadBytes } from '../util.js';
import { canExportSwf, sgfxToSwf, swfNameForEntry } from '../formats/sgfx.js';

const kindCache = new WeakMap();
function entryType(e) {
  if (e.pointer) return 'Streamed (pointer)';
  let t = kindCache.get(e.data);
  if (!t) {
    const magic = ascii4(e.data);
    t = SHELLS.includes(magic) ? `${magic} wrapped` : KIND_LABELS[sniff(e.data, e.name).kind];
    kindCache.set(e.data, t);
  }
  return t;
}

export function renderBres(node, ctx) {
  const arc = node.model;
  // Selection, filter and scroll live on the node so they survive opening an entry and coming back.
  const ui = (node.ui ??= { selected: new Set(), anchor: -1, filter: '', scroll: 0 });
  const selected = ui.selected;
  const tbody = el('tbody');
  const count = el('span', { class: 'muted' });
  const filterBox = el('input', { type: 'search', class: 'input input-sm', placeholder: 'Filter entries', 'aria-label': 'Filter entries' });
  const table = el(
    'table',
    { class: 'grid', tabindex: '0', 'aria-label': 'Bundle entries', 'aria-multiselectable': 'true' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Type'), el('th', { class: 'num' }, 'Size'), el('th', {}, 'Command'))),
    tbody,
  );

  const visible = () => arc.entries.map((e, i) => i).filter((i) => !ui.filter || arc.entries[i].name.toLowerCase().includes(ui.filter));
  const selection = () => [...selected].sort((a, b) => a - b);
  const one = () => (selected.size === 1 ? [...selected][0] : -1);

  function fill() {
    const rows = visible();
    tbody.replaceChildren(
      ...rows.map((i) => {
        const e = arc.entries[i];
        return el(
          'tr',
          { dataset: { i }, class: selected.has(i) ? 'sel' : null, 'aria-selected': String(selected.has(i)) },
          el('td', { class: 'name' }, e.name),
          el('td', {}, entryType(e)),
          el('td', { class: 'num' }, formatSize(e.pointer ? e.size : e.data.length)),
          el('td', { class: 'muted' }, e.cmd || ''),
        );
      }),
    );
    count.textContent = ui.filter ? `${rows.length} of ${arc.entries.length} entries` : `${arc.entries.length} entries`;
    updateButtons();
  }

  function select(i, ev) {
    if (ev?.shiftKey && ui.anchor >= 0) {
      const rows = visible();
      const [a, b] = [rows.indexOf(ui.anchor), rows.indexOf(i)].sort((x, y) => x - y);
      if (!(ev.ctrlKey || ev.metaKey)) selected.clear();
      rows.slice(a, b + 1).forEach((r) => selected.add(r));
    } else if (ev?.ctrlKey || ev?.metaKey) {
      selected.has(i) ? selected.delete(i) : selected.add(i);
      ui.anchor = i;
    } else {
      selected.clear();
      selected.add(i);
      ui.anchor = i;
    }
    for (const tr of tbody.children) {
      const on = selected.has(Number(tr.dataset.i));
      tr.classList.toggle('sel', on);
      tr.setAttribute('aria-selected', String(on));
    }
    updateButtons();
  }

  tbody.addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr');
    if (tr) select(Number(tr.dataset.i), ev);
  });
  tbody.addEventListener('dblclick', (ev) => {
    const tr = ev.target.closest('tr');
    if (tr) ctx.openChild(Number(tr.dataset.i));
  });
  table.addEventListener('keydown', (ev) => {
    const rows = visible();
    if (!rows.length) return;
    const cur = rows.indexOf(ui.anchor);
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, cur + (ev.key === 'ArrowDown' ? 1 : -1)))];
      select(next, ev.shiftKey ? ev : null);
      tbody.querySelector(`tr[data-i="${next}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (ev.key === 'Enter' && one() >= 0) ctx.openChild(one());
    else if (ev.key === 'Delete' && selected.size) del();
    else if (ev.key === 'a' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      rows.forEach((r) => selected.add(r));
      fill();
    }
  });
  filterBox.addEventListener('input', () => {
    ui.filter = filterBox.value.trim().toLowerCase();
    fill();
  });

  const changed = () => {
    ctx.changed();
    fill();
  };
  const inlineOnly = (idx) => idx.filter((i) => !arc.entries[i].pointer);

  function extract(indices) {
    const ok = inlineOnly(indices);
    if (ok.length < indices.length) toast(`${indices.length - ok.length} streamed entr${indices.length - ok.length === 1 ? 'y has' : 'ies have'} no data here and ${indices.length - ok.length === 1 ? 'was' : 'were'} skipped`, 'warn');
    if (!ok.length) return;
    if (ok.length === 1) {
      const e = arc.entries[ok[0]];
      downloadBlob(new Blob([e.data]), baseName(e.name));
    } else {
      const base = baseName(node.name).replace(/\.[^.]*$/, '') || 'bundle';
      downloadBlob(makeZip(ok.map((i) => ({ name: arc.entries[i].name, data: arc.entries[i].data }))), `${base}.zip`);
    }
  }

  async function replace() {
    const i = one();
    const [f] = await pickFiles();
    if (!f) return;
    const e = arc.entries[i];
    e.data = new Uint8Array(await f.arrayBuffer());
    e.pointer = false;
    e.size = e.data.length;
    changed();
    toast(`Replaced ${e.name} with ${f.name} (${formatSize(e.size)})`, 'ok');
  }

  async function add() {
    const files = await pickFiles({ multiple: true });
    let added = 0;
    let replaced = 0;
    for (const f of files) {
      const data = new Uint8Array(await f.arrayBuffer());
      const existing = arc.entries.find((e) => e.name === f.name);
      if (existing) {
        if (!(await confirmBox(`${f.name} is already in this bundle. Replace it?`, 'Replace'))) continue;
        Object.assign(existing, { data, pointer: false, size: data.length });
        replaced++;
      } else {
        arc.entries.push({ name: f.name, cmd: null, pointer: false, size: data.length, data });
        added++;
      }
    }
    if (added || replaced) {
      changed();
      toast(`Added ${added}, replaced ${replaced}`, 'ok');
    }
  }

  async function rename() {
    const e = arc.entries[one()];
    const name = (await ask('Rename entry', e.name, 'Rename'))?.trim();
    if (!name || name === e.name) return;
    if (arc.entries.some((x) => x !== e && x.name === name)) return toast(`An entry named ${name} already exists`, 'error');
    e.name = name;
    changed();
  }

  async function del() {
    const idx = selection();
    const what = idx.length === 1 ? arc.entries[idx[0]].name : `${idx.length} entries`;
    if (!(await confirmBox(`Delete ${what} from this bundle? You can undo this only by reopening the file without saving.`, 'Delete', true))) return;
    const drop = new Set(idx);
    arc.entries = arc.entries.filter((_, i) => !drop.has(i));
    selected.clear();
    ui.anchor = -1;
    changed();
  }

  const btn = {
    open: button('Open', () => ctx.openChild(one()), { title: 'Open the selected entry (Enter or double-click)' }),
    extract: button('Extract', () => extract(selection()), { title: 'Download the selected entries (several go in a .zip)' }),
    swf: button('Export SWF…', () => {
      const e = arc.entries[one()];
      downloadBytes(sgfxToSwf(e.data), swfNameForEntry(e.name));
    }, { title: 'Download the selected .sgfx / .gfx movie as a .swf (CFX → CWS, GFX → FWS) for JPEXS FFDec' }),
    replace: button('Replace…', replace, { title: 'Replace the selected entry with a file from disk' }),
    rename: button('Rename…', rename),
    del: button('Delete', del, { class: 'btn btn-danger-quiet' }),
  };
  function updateButtons() {
    const single = one();
    btn.open.disabled = single < 0 || arc.entries[single]?.pointer;
    btn.extract.disabled = selected.size === 0;
    btn.swf.disabled = single < 0 || !canExportSwf(arc.entries[single]);
    btn.replace.disabled = single < 0;
    btn.rename.disabled = single < 0;
    btn.del.disabled = selected.size === 0;
  }

  filterBox.value = ui.filter;
  fill();
  const wrap = el('div', { class: 'grid-wrap' }, table);
  wrap.addEventListener('scroll', () => (ui.scroll = wrap.scrollTop), { passive: true });
  requestAnimationFrame(() => (wrap.scrollTop = ui.scroll));
  const platform =arc.littleEndian ? 'Little-endian (PC / Steam)' : 'Big-endian (Xbox 360)';
  return el(
    'div',
    { class: 'view bres-view' },
    el('div', { class: 'meta-row' }, el('strong', {}, arc.name), el('span', { class: 'chip' }, arc.target), el('span', { class: 'muted' }, platform)),
    el(
      'div',
      { class: 'toolbar' },
      looksLikeStage(arc) ? button('View map', () => ((node.showMap = true), ctx.rerender()), { title: 'Draw this stage in 3D' }) : null,
      btn.open,
      btn.extract,
      btn.swf,
      btn.replace,
      button('Add files…', add, { title: 'Add files from disk as new entries' }),
      btn.rename,
      btn.del,
      button('Extract all', () => extract(arc.entries.map((_, i) => i)), { title: 'Download every entry as a .zip' }),
      el('span', { class: 'spacer' }),
      count,
      filterBox,
    ),
    wrap,
  );
}
