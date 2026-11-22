// .lng text table editor, as HappyTool's: a grid of keys × languages, the picked cell's text below it with an in-game
// colour preview, a filter with "Missing only" and "Has markup", File and Edit menus, Find & Replace, font colour tools
// and a status line. Keys are edited in the grid (double-click or Enter), text in the box below.
import { el, button, toast, ask, confirmBox, pickFiles, downloadBlob, debounce, openDialog } from '../ui.js';
import { menuBar } from '../menubar.js';
import { parseLng, looksLikeLngHeader } from '../formats/lng.js';
import { decodeLayers } from '../formats/wrappers.js';
import { parseBres } from '../formats/bres.js';
import { fileFromRows, validateRows, statisticsReport, fillMissing, mergeLng, mergeMessage, compareReport } from '../formats/lng-tools.js';
import { catalogToCsv, importCsv as csvToCatalog, catalogToXlsx, importXlsx as xlsxToCatalog, importMessage } from '../formats/lng-sheets.js';
import { hasFontText, colorsIn, parseColor, normalizeHex, toHex6, wrapColor, stripMarkup, renderPreview } from '../formats/lng-markup.js';
import { baseName } from '../util.js';

const ROW_H = 24;
const MAX_KEY = 256;
const TIP_MAX = 12000;
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // HappyTool compares and sorts keys ordinally
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isTyping = (t) =>
  t instanceof Element && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
    (t.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(t.type)));

/** One grid row per key across every language; a language without the key holds null ("missing"). */
function buildRows(file) {
  const map = new Map();
  file.languages.forEach((l, i) => {
    for (const e of l.entries) {
      let r = map.get(e.key);
      if (!r) map.set(e.key, (r = { key: e.key, t: new Array(file.languages.length).fill(null) }));
      r.t[i] = e.text;
    }
  });
  return [...map.values()].sort((a, b) => ordinal(a.key, b.key));
}

export function renderLng(node, ctx) {
  const file = node.model;
  const langs = file.languages;
  const ui = (node.ui ??= {});
  if (ui.file !== file) {
    Object.assign(ui, { file, rows: buildRows(file), aligned: false, filter: '', missing: false, markup: false, sort: null,
      sel: new Set(), focus: null, detail: null, sticky: 0, scroll: 0, scrollLeft: 0, extra: new Set(), hex: '#2dc6ff',
      find: { text: '', repl: '', scope: 'all', matchCase: false, pos: null, open: false } });
  }
  const F = ui.find;
  let vis = [];

  // Text edits write straight into the entry at the row's index; anything that adds, removes or renames rows
  // rewrites every language's list from the grid (every key in every language, missing as "", as HappyTool saves).
  function syncAll() {
    langs.forEach((l, i) => (l.entries = ui.rows.map((r) => ({ key: r.key, text: r.t[i] ?? '' }))));
    ui.rows.forEach((r, j) => (r.j = j));
    ui.aligned = true;
  }
  function setCell(row, li, v) {
    if (row.t[li] === v) return false;
    row.t[li] = v;
    if (ui.aligned) langs[li].entries[row.j].text = v;
    else syncAll();
    return true;
  }
  function setKey(row, v) {
    if (row.key === v) return false;
    row.key = v;
    syncAll();
    return true;
  }
  const cellText = (row, c) => (c < 0 ? row.key : row.t[c] ?? '');

  // ---- filter, sort, visible rows ----
  function computeVisible() {
    const f = ui.filter.trim().toLowerCase();
    vis = ui.rows.filter(
      (r) =>
        ui.extra.has(r) ||
        ((!f || r.key.toLowerCase().includes(f) || r.t.some((s) => s != null && s.toLowerCase().includes(f))) &&
          (!ui.missing || r.t.some((s) => s == null || s === '')) &&
          (!ui.markup || r.t.some(hasFontText))),
    );
    if (ui.sort) {
      const { col, dir } = ui.sort;
      const v = (r) => (col < 0 ? r.key : r.t[col]);
      vis.sort((a, b) => {
        const x = v(a), y = v(b);
        return dir * (x == null ? (y == null ? 0 : -1) : y == null ? 1 : ordinal(x, y));
      });
    }
    sizer.style.height = `${vis.length * ROW_H}px`;
    // The translated row body counts toward the scroll height, so clear it first: the browser then clamps scrollTop
    // to the new list before paint reads it.
    body.style.transform = '';
    body.replaceChildren();
  }

  // ---- DOM ----
  const cols = `minmax(200px, 1.2fr) repeat(${langs.length}, minmax(200px, 1fr))`;
  const minW = `${200 + 200 * langs.length}px`;
  const grid = el('div', { class: 'lng-grid', tabindex: '0', role: 'grid', 'aria-label': 'Keys and texts', 'aria-multiselectable': 'true' });
  grid.style.setProperty('--lng-cols', cols);
  grid.style.setProperty('--lng-min', minW);
  const head = el('div', { class: 'lng-head', role: 'row' });
  const sizer = el('div', { class: 'lng-sizer' });
  const body = el('div', { class: 'lng-body' });
  sizer.append(body);
  grid.append(head, sizer);
  function fillHead() {
    const arrow = (c) => (ui.sort?.col === c ? (ui.sort.dir > 0 ? ' ▲' : ' ▼') : '');
    head.replaceChildren(
      ...[-1, ...langs.keys()].map((c) =>
        el('button', { type: 'button', role: 'columnheader', tabindex: '-1', title: 'Sort by this column (click again to reverse, a third time to clear)', onclick: () => sortBy(c) },
          (c < 0 ? 'Key' : langs[c].name) + arrow(c)),
      ),
    );
  }
  function sortBy(c) {
    ui.sort = ui.sort?.col !== c ? { col: c, dir: 1 } : ui.sort.dir > 0 ? { col: c, dir: -1 } : null;
    fillHead();
    refresh();
  }

  function paint() {
    const top = Math.max(0, grid.scrollTop - ROW_H);
    const h = grid.clientHeight || 600;
    const start = Math.max(0, Math.floor(top / ROW_H) - 4);
    const end = Math.min(vis.length, Math.ceil((top + h) / ROW_H) + 4);
    body.style.transform = `translateY(${start * ROW_H}px)`;
    const out = [];
    for (let v = start; v < end; v++) out.push(rowEl(vis[v], v));
    body.replaceChildren(...out);
  }
  function rowEl(r, v) {
    const isSel = ui.sel.has(r);
    const cur = ui.focus?.row === r ? ui.focus.col : null;
    return el(
      'div',
      { class: `lng-gr${isSel ? ' sel' : ''}`, role: 'row', 'aria-selected': String(isSel), dataset: { v } },
      el('div', { class: `lng-c k${cur === -1 ? ' cur' : ''}`, role: 'gridcell', dataset: { c: -1 }, title: r.key },
        el('span', { class: 'lng-tx' }, r.key || el('i', { class: 'muted' }, '(empty key)'))),
      ...r.t.map((s, c) => {
        const swatches = s ? colorsIn(s).map(parseColor).filter(Boolean) : [];
        return el(
          'div',
          { class: `lng-c${cur === c ? ' cur' : ''}`, role: 'gridcell', dataset: { c }, title: s ? `${r.key}\n\n${s.length > TIP_MAX ? s.slice(0, TIP_MAX) + '…' : s}` : null },
          el('span', { class: 'lng-tx' }, s ? s.replace(/\r?\n/g, ' ⏎ ') : ''),
          swatches.length ? el('span', { class: 'lng-sw' }, swatches.map((rgb) => el('i', { style: `background:rgb(${rgb.join(',')})` }))) : null,
        );
      }),
    );
  }
  let painting = 0;
  grid.addEventListener('scroll', () => {
    ui.scroll = grid.scrollTop;
    ui.scrollLeft = grid.scrollLeft;
    if (!painting) painting = requestAnimationFrame(() => ((painting = 0), paint()));
  }, { passive: true });

  function refresh() {
    computeVisible();
    paint();
    status();
  }

  // ---- selection and focus ----
  let anchor = null;
  const visIndex = (row) => (row ? vis.indexOf(row) : -1);
  function focusCell(row, col, { select = true, extend = false, toggle = false, scroll = true } = {}) {
    if (!row) return;
    if (extend && anchor && vis.includes(anchor)) {
      const a = visIndex(anchor), b = visIndex(row);
      ui.sel = new Set(vis.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else if (toggle) {
      ui.sel.has(row) ? ui.sel.delete(row) : ui.sel.add(row);
      anchor = row;
    } else if (select) {
      ui.sel = new Set([row]);
      anchor = row;
    }
    ui.focus = { row, col };
    loadDetail(row, col < 0 ? ui.sticky : col);
    if (col >= 0) ui.sticky = col;
    if (scroll) scrollToRow(row, col);
    paint();
  }
  function scrollToRow(row, col) {
    const v = visIndex(row);
    if (v < 0) return;
    const y = v * ROW_H + ROW_H; // below the header
    const h = grid.clientHeight;
    if (y < grid.scrollTop + ROW_H) grid.scrollTop = y - ROW_H;
    else if (y + ROW_H > grid.scrollTop + h) grid.scrollTop = y + ROW_H - h;
    const hc = col != null && head.children[col + 1];
    if (hc) {
      if (hc.offsetLeft < grid.scrollLeft) grid.scrollLeft = hc.offsetLeft;
      else if (hc.offsetLeft + hc.offsetWidth > grid.scrollLeft + grid.clientWidth) grid.scrollLeft = hc.offsetLeft + hc.offsetWidth - grid.clientWidth;
    }
  }
  const focusedRow = () => (ui.focus && ui.rows.includes(ui.focus.row) ? ui.focus.row : null);

  grid.addEventListener('mousedown', (e) => {
    const cell = e.target.closest('.lng-c');
    if (!cell || e.button !== 0) return;
    const row = vis[Number(cell.parentElement.dataset.v)];
    focusCell(row, Number(cell.dataset.c), { extend: e.shiftKey, toggle: e.ctrlKey || e.metaKey, scroll: false });
  });
  grid.addEventListener('dblclick', (e) => {
    const cell = e.target.closest('.lng-c');
    if (!cell) return;
    const row = vis[Number(cell.parentElement.dataset.v)];
    if (Number(cell.dataset.c) < 0) editKeyInline(row);
    else memo.focus();
  });
  grid.addEventListener('keydown', (e) => {
    if (e.target !== grid) return;
    const nav = { ArrowDown: 1, ArrowUp: -1, PageDown: 'pd', PageUp: 'pu', Home: 'home', End: 'end' }[e.key];
    const nc = langs.length;
    const f = ui.focus && vis.includes(ui.focus.row) ? ui.focus : null;
    if (nav != null && !e.altKey) {
      e.preventDefault();
      if (!vis.length) return;
      const page = Math.max(1, Math.floor(grid.clientHeight / ROW_H) - 1);
      let v = f ? visIndex(f.row) : -1;
      if (nav === 'home') v = 0;
      else if (nav === 'end') v = vis.length - 1;
      else if (nav === 'pd') v += page;
      else if (nav === 'pu') v -= page;
      else v += nav;
      v = Math.max(0, Math.min(vis.length - 1, v));
      focusCell(vis[v], f ? f.col : 0, { extend: e.shiftKey });
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey && f) {
      e.preventDefault();
      focusCell(f.row, Math.max(-1, Math.min(nc - 1, f.col + (e.key === 'ArrowRight' ? 1 : -1))), { select: false });
    } else if (e.key === 'Tab' && f && !e.ctrlKey && !e.altKey) {
      const c = f.col + (e.shiftKey ? -1 : 1);
      if (c < -1 || c >= nc) return;
      e.preventDefault();
      focusCell(f.row, c, { select: false });
    } else if (e.key === 'Enter' && f && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (f.col < 0) editKeyInline(f.row);
      else memo.focus();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !e.altKey) {
      e.preventDefault();
      ui.sel = new Set(vis);
      paint();
    } else if (e.key === ' ' && f) {
      e.preventDefault();
      focusCell(f.row, f.col, { toggle: true, scroll: false });
    }
  });

  // ---- inline key editor ----
  let inline = null;
  function editKeyInline(row) {
    if (!commitInline()) return;
    const v = visIndex(row);
    if (v < 0) return;
    scrollToRow(row, -1);
    const input = el('input', { type: 'text', class: 'lng-inline', spellcheck: 'false', maxlength: '255', 'aria-label': 'Key', value: row.key });
    input.style.top = `${v * ROW_H}px`;
    input.style.width = `${Math.max(180, body.querySelector(`[data-v="${v}"] [data-c="-1"]`)?.offsetWidth || 220)}px`;
    inline = { row, input };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (commitInline()) grid.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelInline();
        grid.focus();
      }
    });
    // Leaving the box keeps a good key and drops a bad one (with the reason), so a click elsewhere never traps you.
    input.addEventListener('blur', () => {
      if (inline?.input !== input) return;
      const problem = keyProblem(input.value.trim(), row);
      if (problem) {
        toast(`${problem} The key was not changed.`, 'error');
        cancelInline();
      } else commitInline();
    });
    sizer.append(input);
    input.focus();
    input.select();
  }
  /** Checks and stores the inline key; false (and the editor stays) when it is too long or a duplicate. */
  function commitInline() {
    if (!inline) return true;
    const { row, input } = inline;
    const problem = keyProblem(input.value.trim(), row);
    if (problem) {
      toast(problem, 'error');
      input.focus();
      return false;
    }
    inline = null;
    input.remove();
    if (setKey(row, input.value)) changed();
    if (ui.detail?.row === row) caption.textContent = `${row.key}  —  ${langs[ui.detail.lang].name}`;
    paint();
    return true;
  }
  function cancelInline() {
    if (!inline) return;
    inline.input.remove();
    inline = null;
  }
  function keyProblem(key, row) {
    if (!key) return null; // an empty key is allowed while editing; the row is left out when saved
    if (key.length >= MAX_KEY) return 'Key is too long (max 255 ASCII bytes).';
    if (/[^\x00-\x7f]/.test(key)) return 'Keys can only use ASCII characters.';
    if (ui.rows.some((r) => r !== row && r.key.trim() === key)) return `Duplicate key: ${key}`;
    return null;
  }

  // ---- detail: caption, text box, preview ----
  const caption = el('div', { class: 'lng-caption' });
  const memo = el('textarea', { class: 'editor lng-memo', spellcheck: 'false', 'aria-label': 'Text' });
  const preview = el('div', { class: 'lng-preview', 'aria-label': 'In-game preview' });
  function loadDetail(row, li) {
    if (!row || li == null || li >= langs.length) {
      ui.detail = null;
      caption.textContent = 'Select a row — edit Key in the grid, text markup below';
      memo.value = '';
      memo.disabled = true;
      renderPreview('', preview);
      return;
    }
    ui.detail = { row, lang: li };
    caption.textContent = `${row.key}  —  ${langs[li].name}`;
    memo.disabled = false;
    memo.value = row.t[li] ?? '';
    renderPreview(memo.value, preview);
  }
  const repaintSoon = debounce(() => (paint(), status()), 150);
  memo.addEventListener('input', () => {
    const d = ui.detail;
    if (!d) return;
    if (setCell(d.row, d.lang, memo.value)) changed();
    renderPreview(memo.value, preview);
    repaintSoon();
  });
  function changed() {
    ctx.changed();
  }

  // ---- status ----
  const statusLine = el('div', { class: 'lng-status', role: 'status' });
  const status = debounce(() => {
    const parts = ['Happy Wars text resource (.lng)', `Grid keys: ${ui.rows.length.toLocaleString()}`];
    langs.forEach((l, i) => {
      const n = ui.rows.reduce((a, r) => a + (r.t[i] == null || r.t[i] === '' ? 1 : 0), 0);
      if (n) parts.push(`${l.name} empty: ${n.toLocaleString()}`);
    });
    if (vis.length !== ui.rows.length) parts.push(`Visible: ${vis.length.toLocaleString()}`);
    statusLine.textContent = parts.join('  |  ');
  }, 60);

  // ---- entry commands ----
  function newEntry() {
    if (!commitInline()) return;
    const row = { key: '', t: langs.map(() => '') };
    ui.rows.push(row);
    ui.extra.add(row);
    syncAll();
    changed();
    refresh();
    focusCell(row, -1);
    editKeyInline(row);
  }
  async function deleteEntries() {
    const targets = ui.sel.size ? [...ui.sel].filter((r) => ui.rows.includes(r)) : focusedRow() ? [focusedRow()] : [];
    if (!targets.length) return toast('Select a row first.', 'warn');
    const msg =
      targets.length > 1 ? `Delete ${targets.length.toLocaleString()} selected entries?` : targets[0].key ? `Delete entry "${targets[0].key}"?` : 'Delete this empty entry?';
    if (!(await confirmBox(msg, 'Delete', true))) return;
    cancelInline();
    const gone = new Set(targets);
    const v = visIndex(focusedRow());
    ui.rows = ui.rows.filter((r) => !gone.has(r));
    syncAll();
    ui.sel = new Set();
    changed();
    computeVisible();
    const next = vis[Math.min(Math.max(0, v), vis.length - 1)];
    ui.focus = next ? { row: next, col: ui.focus?.col ?? 0 } : null;
    if (next) ui.sel.add(next);
    loadDetail(null);
    paint();
    status();
    grid.focus();
  }
  function suggestDuplicateKey(src) {
    const base = src.trim() || 'NEW_KEY';
    const keys = new Set(ui.rows.map((r) => r.key.trim()));
    for (let i = 1; i <= 999; i++) {
      const k = `${base}_copy${i === 1 ? '' : i}`;
      if (!keys.has(k) && k.length < MAX_KEY) return k;
    }
    return `${base}_copy`;
  }
  function duplicateEntry() {
    const src = focusedRow();
    if (!src) return toast('Select a row to duplicate.', 'warn');
    if (!commitInline()) return;
    const row = { key: suggestDuplicateKey(src.key), t: src.t.slice() };
    ui.rows.push(row);
    ui.extra.add(row);
    syncAll();
    changed();
    refresh();
    focusCell(row, -1);
    editKeyInline(row);
  }
  async function renameKey() {
    const row = focusedRow();
    if (!row) return toast('Select a row first.', 'warn');
    const v = await ask('Rename key — new key name:', row.key, 'Rename');
    const key = v?.trim();
    if (!key || key === row.key) return;
    const problem = keyProblem(key, row);
    if (problem) return toast(problem, 'error');
    setKey(row, key);
    changed();
    loadDetail(row, ui.detail?.lang ?? ui.sticky);
    paint();
  }
  async function copy(what) {
    let s = '';
    if (what === 'key') {
      const row = focusedRow();
      if (!row) return toast('Select a row first.', 'warn');
      s = row.key;
    } else {
      if (document.activeElement === memo || ui.detail) s = memo.value;
      else if (ui.focus && ui.focus.col >= 0) s = ui.focus.row.t[ui.focus.col] ?? '';
      if (!s) return toast('No text to copy.', 'warn');
    }
    try {
      await navigator.clipboard.writeText(s);
      toast(what === 'key' ? 'Key copied' : 'Text copied', 'ok', 1500);
    } catch (e) {
      toast(`Could not copy: ${e.message}`, 'error');
    }
  }
  async function goToKey() {
    const cur = ui.detail?.row.key.trim() ?? focusedRow()?.key ?? '';
    const key = (await ask('Go to key — enter the string key to select:', cur, 'Go'))?.trim();
    if (!key) return;
    ui.filter = key;
    filterBox.value = key;
    ui.extra.clear();
    refresh();
    const row = vis.find((r) => r.key.trim() === key);
    if (!row) return toast(`No row matches key "${key}".`, 'warn');
    focusCell(row, langs.length ? 0 : -1);
    grid.focus();
  }
  function insertLineBreak() {
    if (!ui.detail) return toast('Select a text cell to edit first.', 'warn');
    const a = memo.selectionStart;
    memo.focus();
    memo.setRangeText('\n', a, a, 'end');
    memo.setSelectionRange(a + 1, a + 1);
    memo.dispatchEvent(new Event('input'));
  }

  // ---- font colour tools ----
  const hexBox = el('input', { type: 'text', class: 'input input-sm lng-hex', spellcheck: 'false', 'aria-label': 'Font colour (hex)', value: ui.hex, title: 'Hex colour for Wrap font color, e.g. #2dc6ff' });
  const picker = el('input', { type: 'color', class: 'lng-picker', 'aria-label': 'Pick a font colour', title: 'Pick a colour' });
  const syncPicker = () => {
    const rgb = parseColor(hexBox.value);
    if (rgb) picker.value = toHex6(rgb);
  };
  syncPicker();
  hexBox.addEventListener('input', () => ((ui.hex = hexBox.value), syncPicker()));
  picker.addEventListener('input', () => ((hexBox.value = ui.hex = picker.value.toLowerCase())));
  function wrapFont() {
    const hex = hexBox.value;
    if (!parseColor(hex)) return toast('Enter a valid hex color (e.g. #2dc6ff).', 'warn');
    const target = ui.detail ? memo : inline?.input;
    if (!target) return toast('Select a text cell first (double-click to edit, or focus a language column).', 'warn');
    const a = target.selectionStart, b = target.selectionEnd;
    const open = `<font color="${normalizeHex(hex)}">`;
    target.focus();
    target.setRangeText(wrapColor(target.value.slice(a, b), hex), a, b, 'end');
    if (a === b) target.setSelectionRange(a + open.length, a + open.length); // empty tag: the caret goes between the tags
    if (target === memo) memo.dispatchEvent(new Event('input'));
  }
  function stripCurrent() {
    if (!ui.detail) return toast('Select a text cell first.', 'warn');
    const s = stripMarkup(memo.value);
    if (s === memo.value) return toast('No font markup in this text.', 'info', 2000);
    memo.value = s;
    memo.dispatchEvent(new Event('input'));
  }
  function stripAll() {
    let n = 0;
    for (const r of ui.rows)
      r.t.forEach((s, i) => {
        if (!s) return;
        const t = stripMarkup(s);
        if (t !== s) {
          setCell(r, i, t);
          n++;
        }
      });
    if (!n) return toast('No font markup found.', 'info');
    changed();
    if (ui.detail) loadDetail(ui.detail.row, ui.detail.lang);
    refresh();
    toast(`Stripped markup from ${n.toLocaleString()} cell(s).`, 'ok');
  }

  // ---- Find & Replace (one panel, stays open while you work in the grid) ----
  const findBox = el('input', { type: 'text', class: 'input input-sm', spellcheck: 'false', 'aria-label': 'Find', value: F.text });
  const replBox = el('input', { type: 'text', class: 'input input-sm', spellcheck: 'false', 'aria-label': 'Replace', value: F.repl });
  const scopeSel = el('select', { class: 'input input-sm', 'aria-label': 'Scope' },
    [['all', 'All language columns'], ['current', 'Current language column'], ['keys', 'Keys only']].map(([v, t]) => el('option', { value: v, selected: v === F.scope }, t)));
  const caseBox = el('input', { type: 'checkbox', checked: F.matchCase });
  findBox.addEventListener('input', () => (F.text = findBox.value));
  replBox.addEventListener('input', () => (F.repl = replBox.value));
  scopeSel.addEventListener('change', () => (F.scope = scopeSel.value));
  caseBox.addEventListener('change', () => (F.matchCase = caseBox.checked));
  const findPanel = el(
    'div',
    { class: 'lng-find', role: 'dialog', 'aria-label': 'Find & Replace', hidden: !F.open },
    el('div', { class: 'lng-find-title' }, el('strong', {}, 'Find & Replace'), button('×', () => closeFind(), { class: 'btn btn-quiet btn-sm', title: 'Close (Esc)', 'aria-label': 'Close' })),
    el('label', {}, 'Find:'), findBox,
    el('label', {}, 'Replace:'), replBox,
    el('label', {}, 'Scope:'), el('div', { class: 'lng-find-opts' }, scopeSel, el('label', { class: 'check' }, caseBox, ' Match case')),
    el('div', { class: 'lng-find-btns' },
      button('Find next', () => findStep(1), { class: 'btn btn-primary btn-sm' }),
      button('Find previous', () => findStep(-1), { class: 'btn btn-sm' }),
      button('Replace', replaceOne, { class: 'btn btn-sm' }),
      button('Replace all', replaceAll, { class: 'btn btn-sm' }),
      button('Close', () => closeFind(), { class: 'btn btn-sm' })),
    el('p', { class: 'lng-find-hint' }, 'Shortcuts: Enter → find next  •  Shift+Enter → find previous  •  Esc → close'),
  );
  findPanel.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' && !e.ctrlKey && !e.altKey && e.target.tagName !== 'BUTTON') || e.key === 'F3') {
      e.preventDefault();
      e.stopPropagation();
      findStep(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeFind(true);
    }
  });
  function openFind(replace) {
    F.open = true;
    findPanel.hidden = false;
    const box = replace ? replBox : findBox;
    box.focus();
    box.select();
  }
  function closeFind(refocus) {
    F.open = false;
    findPanel.hidden = true;
    if (refocus) grid.focus();
  }
  function scopeCols() {
    if (F.scope === 'keys') return [-1];
    if (F.scope === 'current') return [ui.detail ? ui.detail.lang : ui.focus && ui.focus.col >= 0 ? ui.focus.col : 0];
    return [...langs.keys()];
  }
  const finder = (g) => new RegExp(escRe(F.text), (F.matchCase ? '' : 'i') + (g ? 'g' : ''));
  function findStep(dir) {
    if (!F.text) return toast('Enter text to find.', 'warn'), false;
    if (!commitInline()) return false;
    const nr = vis.length;
    if (!nr) return toast('No rows to search.', 'warn'), false;
    const sc = scopeCols();
    const nc = sc.length;
    const total = nr * nc;
    const start = F.pos && F.pos.v < nr && F.pos.c < nc ? F.pos.v * nc + F.pos.c : Math.max(0, visIndex(focusedRow())) * nc;
    const re = finder(false);
    for (let step = 1; step <= total; step++) {
      const lin = (((start + dir * step) % total) + total) % total;
      const v = Math.floor(lin / nc), c = lin % nc;
      if (re.test(cellText(vis[v], sc[c]))) {
        F.pos = { v, c };
        focusCell(vis[v], sc[c]);
        return true;
      }
    }
    F.pos = null;
    toast('No more matches.', 'info');
    return false;
  }
  function replaceOne() {
    if (!F.text) return toast('Enter text to find.', 'warn');
    const sc = scopeCols();
    const row = F.pos && vis[F.pos.v];
    const c = F.pos && sc[F.pos.c];
    const m = row && c !== undefined ? finder(false).exec(cellText(row, c)) : null;
    if (!m) return findStep(1);
    const s = cellText(row, c);
    const next = s.slice(0, m.index) + F.repl + s.slice(m.index + m[0].length);
    if (c < 0) setKey(row, next);
    else setCell(row, c, next);
    changed();
    loadDetail(row, c < 0 ? ui.sticky : c);
    paint();
    findStep(1);
  }
  function replaceAll() {
    if (!F.text) return toast('Enter text to find.', 'warn');
    if (!commitInline()) return;
    const sc = scopeCols();
    const re = finder(true);
    let n = 0;
    let keys = false;
    for (const row of vis)
      for (const c of sc) {
        const s = cellText(row, c);
        const t = s.replace(re, () => F.repl);
        if (t === s) continue;
        n++;
        if (c < 0) {
          row.key = t;
          keys = true;
        } else setCell(row, c, t);
      }
    if (keys) syncAll();
    if (!n) return toast('No matches found.', 'info');
    changed();
    if (ui.detail) loadDetail(ui.detail.row, ui.detail.lang);
    paint();
    status();
    toast(`Replaced in ${n.toLocaleString()} cell(s).`, 'ok');
  }

  // ---- CSV and Excel (HappyTool's Export/Import CSV and Excel) ----
  const stem = baseName(node.name).replace(/\.[^.]*$/, '') || 'text';
  async function exportSheet(csv) {
    if (!prep()) return;
    const name = `${stem}.${csv ? 'csv' : 'xlsx'}`;
    try {
      const cat = fileFromRows(file, ui.rows);
      downloadBlob(csv ? new Blob([catalogToCsv(cat)], { type: 'text/csv;charset=utf-8' }) : await catalogToXlsx(cat), name);
    } catch (e) {
      return toast(`Export ${csv ? 'CSV' : 'Excel'}: ${e.message}`, 'error');
    }
    toast(`Exported ${ui.rows.length.toLocaleString()} keys to ${name}.`, 'ok');
  }
  async function importSheet(csv) {
    const what = csv ? 'CSV' : 'Excel';
    const [f] = await pickFiles({ accept: csv ? '.csv,text/csv' : '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    if (!f) return;
    if (node.dirty && !(await confirmBox(`Import merges ${what} data into the current strings and marks the file as changed. Continue?`, 'Continue'))) return;
    if (!prep()) return;
    let r;
    try {
      const cat = fileFromRows(file, ui.rows);
      r = csv ? csvToCatalog(cat, await f.text()) : await xlsxToCatalog(cat, new Uint8Array(await f.arrayBuffer()));
    } catch (e) {
      return toast(`Import ${what}: ${e.message}`, 'error');
    }
    applyCatalog(r.file);
    message(`Import ${what}`, importMessage(r));
  }

  // ---- checks, merge and compare (HappyTool's Validate, Statistics, Fill missing, Merge from .lng, Compare with .lng) ----
  const names = () => langs.map((l) => l.name);
  function prep() {
    if (!commitInline()) return false;
    if (!ui.aligned) syncAll();
    return true;
  }
  /** The desktop's read-only text report window. */
  function report(title, text, w = 640, h = 480) {
    return openDialog((dlg, done) => {
      const area = el('textarea', { class: 'input lng-report', spellcheck: 'false', wrap: 'off', 'aria-label': title });
      area.readOnly = true;
      area.value = text;
      area.style.height = `min(${h}px, 60vh)`;
      dlg.style.width = `min(${w}px, calc(100vw - 32px))`;
      dlg.append(
        el('h2', { class: 'dialog-title' }, title),
        area,
        el('div', { class: 'dialog-actions' },
          button('Save as .txt…', () => downloadBlob(new Blob([text.replace(/\n/g, '\r\n')], { type: 'text/plain;charset=utf-8' }), `${stem} - ${title}.txt`)),
          button('Close', () => done(null), { class: 'btn btn-primary', autofocus: true })));
    });
  }
  function message(title, text) {
    return openDialog((dlg, done) => {
      const p = el('p', { class: 'dialog-text' }, text);
      p.style.whiteSpace = 'pre-wrap';
      p.style.overflowWrap = 'anywhere';
      dlg.append(el('h2', { class: 'dialog-title' }, title), p,
        el('div', { class: 'dialog-actions' }, button('OK', () => done(null), { class: 'btn btn-primary', autofocus: true })));
    });
  }
  /** A small options window; resolves true for OK. */
  function options(title, body, okLabel) {
    return openDialog((dlg, done) => {
      dlg.append(el('form', { method: 'dialog', class: 'lng-options', onsubmit: (e) => (e.preventDefault(), done(true)) },
        el('h2', { class: 'dialog-title' }, title), ...body,
        el('div', { class: 'dialog-actions' }, button('Cancel', () => done(false)),
          el('button', { type: 'submit', class: 'btn btn-primary', autofocus: true }, okLabel))));
    }).then((v) => v === true);
  }
  /** A bundle with several tables (Dict_*.bres holds Lang, Atrb, Voice, ActCmd): pick one, the same family as this file first. */
  const family = (n) => baseName(n).replace(/_[^_]*\.lng$/i, '').toLowerCase();
  async function chooseTable(bundle, list) {
    const want = family(node.name);
    const pick = el('select', { class: 'input', 'aria-label': 'Text table' },
      ...list.map((x, i) => el('option', { value: String(i), selected: family(x.name) === want }, baseName(x.name))));
    const ok = await options('Pick a text table', [
      el('p', { class: 'dialog-text' }, `${bundle} holds ${list.length} text tables.`),
      el('label', { class: 'lng-optrow' }, 'Table:', pick)], 'OK');
    return ok ? list[Number(pick.value)] : null;
  }
  /** Another .lng from disk: plain, BFBR/ZRES-wrapped, or the first .lng inside a bundle (langbres/Dict_*.bres). */
  async function pickOtherLng() {
    const [f] = await pickFiles({ accept: '.lng,.bres' });
    if (!f) return null;
    let u8 = (await decodeLayers(new Uint8Array(await f.arrayBuffer()))).payload;
    let label = f.name;
    if (!looksLikeLngHeader(u8)) {
      let bres = null;
      try {
        bres = parseBres(u8);
      } catch {
        // not a bundle either
      }
      const list = bres?.entries.filter((x) => !x.pointer && /\.lng$/i.test(x.name)) ?? [];
      if (!list.length) throw new Error(`${f.name} is not a .lng text table.`);
      const e = list.length === 1 ? list[0] : await chooseTable(f.name, list);
      if (!e) return null;
      u8 = (await decodeLayers(e.data)).payload;
      label = baseName(e.name);
    }
    return { file: parseLng(u8), label };
  }

  function validate() {
    if (!prep()) return;
    const { keys, lines } = validateRows(ui.rows, names());
    if (!lines.length) return toast(`All ${keys} keys have text in every language.`, 'ok');
    report('Validation report', lines.join('\n'), 560, 420);
  }
  function statistics() {
    if (prep()) report('Translation statistics', statisticsReport(ui.rows, names()));
  }
  async function fillFrom() {
    if (!langs.length || !prep()) return;
    const pick = el('select', { class: 'input', 'aria-label': 'Copy from language' }, ...langs.map((l, i) => el('option', { value: String(i) }, l.name)));
    const only = el('input', { type: 'checkbox', checked: true });
    const ok = await options('Fill missing translations', [
      el('label', { class: 'lng-optrow' }, 'Copy from language:', pick),
      el('label', { class: 'check lng-optrow' }, only, ' Only fill empty cells (leave existing text)')], 'Fill');
    if (!ok) return;
    const src = Number(pick.value);
    const n = fillMissing(ui.rows, names(), src, only.checked, setCell);
    if (!n) return toast('No empty cells were filled.');
    changed();
    refresh();
    loadDetail(ui.detail?.row, ui.detail?.lang);
    toast(`Filled ${n} cell(s) from ${langs[src].name}.`, 'ok');
  }
  async function mergeFrom() {
    let other;
    try {
      other = await pickOtherLng();
    } catch (e) {
      return toast(`Merge: ${e.message}`, 'error');
    }
    if (!other) return;
    const over = el('input', { type: 'checkbox' });
    if (!(await options('Merge options', [el('label', { class: 'check lng-optrow' }, over, ' Overwrite existing non-empty strings')], 'Merge'))) return;
    if (!prep()) return;
    let r;
    try {
      r = mergeLng(fileFromRows(file, ui.rows), other.file, over.checked);
    } catch (e) {
      return toast(`Merge: ${e.message}`, 'error');
    }
    applyCatalog(r.file);
    message('Merge', mergeMessage(r));
  }
  /** The grid is rebuilt from a merged or imported catalog (re-sorted, rows without a key gone), as the desktop's RebuildGrid. */
  function applyCatalog(next) {
    file.languages.splice(0, file.languages.length, ...next.languages);
    Object.assign(ui, { rows: buildRows(file), sel: new Set(), focus: null, detail: null });
    ui.extra.clear();
    syncAll();
    changed();
    ctx.rerender();
  }
  async function compareWith() {
    if (!prep()) return;
    const current = fileFromRows(file, ui.rows);
    let other;
    try {
      other = await pickOtherLng();
    } catch (e) {
      return toast(`Compare: ${e.message}`, 'error');
    }
    if (other) report('Compare .lng files', compareReport(current, other.file, baseName(node.name), other.label));
  }

  // ---- toolbar, menus, keys ----
  const filterBox = el('input', { type: 'search', class: 'input input-sm lng-filter', placeholder: 'Key or text…', 'aria-label': 'Filter keys and texts', value: ui.filter });
  filterBox.addEventListener('input', debounce(() => {
    ui.filter = filterBox.value;
    ui.extra.clear();
    refresh();
  }, 150));
  const check = (label, prop) =>
    el('label', { class: 'check' },
      el('input', { type: 'checkbox', checked: ui[prop], onchange: (e) => ((ui[prop] = e.target.checked), ui.extra.clear(), refresh()) }), ` ${label}`);
  const file_ = ctx.file;
  const menus = [
    {
      label: 'File',
      items: () => [
        file_?.open && { label: 'Open…', run: file_.open },
        file_?.save && { label: 'Save', keys: 'Ctrl+S', run: file_.save },
        file_?.saveAs && { label: 'Save as…', run: file_.saveAs },
        null,
        { label: 'Export Excel…', run: () => exportSheet(false) },
        { label: 'Import Excel…', run: () => importSheet(false) },
        { label: 'Merge from .lng…', run: mergeFrom },
        { label: 'Compare with .lng…', run: compareWith },
        { label: 'Export CSV…', run: () => exportSheet(true) },
        { label: 'Import CSV…', run: () => importSheet(true) },
        null,
        file_?.close && { label: file_.closeLabel || 'Close', run: file_.close },
      ].filter((x) => x !== undefined && x !== false),
    },
    {
      label: 'Edit',
      items: () => [
        { label: 'New entry', keys: 'Alt+N', run: newEntry },
        { label: 'Delete entry', keys: 'Delete', run: deleteEntries, enabled: () => !!(ui.sel.size || focusedRow()) },
        { label: 'Duplicate entry', keys: 'Ctrl+D', run: duplicateEntry, enabled: () => !!focusedRow() },
        null,
        { label: 'Find & replace…', keys: 'Ctrl+H', run: () => openFind(false) },
        { label: 'Copy key', keys: 'Ctrl+Shift+C', run: () => copy('key'), enabled: () => !!focusedRow() },
        { label: 'Copy text', keys: 'Alt+T', run: () => copy('text') },
        { label: 'Go to key…', keys: 'Ctrl+G', run: goToKey },
        { label: 'Rename key…', keys: 'F2', run: renameKey, enabled: () => !!focusedRow() },
        null,
        { label: 'Fill missing from language…', run: fillFrom },
        null,
        { label: 'Strip font markup (current text)', run: stripCurrent, enabled: () => !!ui.detail },
        { label: 'Strip font markup (all strings)', run: stripAll },
        { label: 'Validate translations…', run: validate },
        null,
        { label: 'Translation statistics…', run: statistics },
      ],
    },
  ];
  const root = el('div', { class: 'view lng-view' });
  root.addEventListener('keydown', (e) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const typing = isTyping(e.target);
    let run = null;
    if (ctrl && !e.altKey && !e.shiftKey && k === 'f') run = () => openFind(false);
    else if (ctrl && !e.altKey && !e.shiftKey && k === 'h') run = () => openFind(true);
    else if (ctrl && !e.altKey && !e.shiftKey && k === 'g') run = goToKey;
    else if (ctrl && !e.altKey && !e.shiftKey && k === 'd') run = duplicateEntry;
    else if (ctrl && !e.altKey && e.shiftKey && k === 'c') run = () => copy('key');
    else if (e.altKey && !ctrl && !e.shiftKey && k === 'n') run = newEntry;
    else if (e.altKey && !ctrl && !e.shiftKey && k === 't') run = () => copy('text');
    else if (!typing && !ctrl && !e.altKey && !e.shiftKey && k === 'Delete') run = deleteEntries;
    else if (!typing && !ctrl && !e.altKey && !e.shiftKey && k === 'F2') run = renameKey;
    else if (!ctrl && !e.altKey && k === 'F3' && F.text) run = () => findStep(e.shiftKey ? -1 : 1);
    else if (k === 'Escape' && F.open && !typing && !e.defaultPrevented) run = () => closeFind(true);
    if (!run) return;
    e.preventDefault();
    e.stopPropagation();
    run();
  });

  const order = file.bigEndian ? ' (big-endian / Xbox 360)' : '';
  root.append(
    el('div', { class: 'meta-row' },
      el('strong', {}, `${langs.length} language${langs.length === 1 ? '' : 's'}`),
      el('span', { class: 'muted' }, `Happy Wars text resource (.lng)${order} · version ${file.ver} · ${langs.map((l) => `${l.name}: ${l.entries.length.toLocaleString()} strings`).join(' · ')}`)),
    el('div', { class: 'toolbar lng-toolbar' },
      menuBar(menus, 'Text table menu'),
      el('label', { class: 'lng-lbl' }, 'Filter:'), filterBox,
      check('Missing only', 'missing'),
      check('Has markup', 'markup'),
      el('span', { class: 'spacer' }),
      button('Insert \\n', insertLineBreak, { class: 'btn btn-sm', title: 'Insert a line break at the caret in the text box' }),
      el('label', { class: 'lng-lbl' }, 'Font:'), hexBox, picker,
      button('Wrap font color', wrapFont, { class: 'btn btn-sm', title: 'Wrap the selected text in <font color="…">…</font>' })),
    el('div', { class: 'lng-layout' },
      grid,
      el('div', { class: 'lng-detail' },
        caption,
        memo,
        el('div', { class: 'lng-prevwrap' }, el('span', { class: 'muted lng-prevlbl' }, 'In-game preview (font colors):'), preview))),
    statusLine,
    findPanel,
  );

  fillHead();
  computeVisible();
  const d = ui.detail && ui.rows.includes(ui.detail.row) ? ui.detail : null;
  loadDetail(d?.row, d?.lang);
  requestAnimationFrame(() => {
    grid.scrollTop = ui.scroll;
    grid.scrollLeft = ui.scrollLeft;
    paint();
  });
  paint();
  status();
  return root;
}
