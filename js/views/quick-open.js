// Quick Open (Ctrl+P), the desktop Workshop's QuickOpenForm: fuzzy search over every open file under the Data folder,
// pinned and recent files on top, matched letters in bold. The matching and ranking live in tools/quick-open.js.
import { el } from '../ui.js';
import { fileIconSvg, iconEl } from '../icons.js';
import { buildIndex, QuickOpenSearcher, MAX_FILES } from '../tools/quick-open.js';

const MIN_ROWS = 6;
const MAX_ROWS = 14;
const PIN_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><g transform="rotate(35 8 8)" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">' +
  '<path d="M5.5 2h5l-.8 1.2v3.3l2 2v1H4.3v-1l2-2V3.2z"/><path d="M8 9.5V15" fill="none"/></g></svg>';

// The index of the last Data folder searched, kept between openings as the desktop keeps it (EnsureFreshAsync); F5
// or a different file list builds it again.
let cache = null;
let openNow = null;

/**
 * Shows Quick Open, or brings the open one forward. `app` is how it reaches the page:
 *   files() the open files' paths; root() the Data folder they are shown under ('' for all of them, null when no
 *   folder is open); pinned() / recent() the history (paths); togglePin(path) → now pinned?; unpin(path);
 *   removeRecent(path); open(path); reveal(path) (optional: shows the file in the browser, Ctrl+Enter).
 */
export function openQuickOpen(app) {
  if (openNow?.isConnected) return openNow.querySelector('.qo-search')?.focus();
  const dlg = el('dialog', { class: 'dialog quick-open', 'aria-label': 'Quick Open' });
  openNow = dlg;
  const search = el('input', {
    type: 'text',
    class: 'input qo-search',
    placeholder: 'Search files by name (fuzzy: "sbaba", "gstage", "json/stage set")',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Search files by name',
  });
  const list = el('ul', { class: 'qo-list', role: 'listbox', 'aria-label': 'Files' });
  const status = el('span', { class: 'qo-status' });
  const hints = el('span', { class: 'qo-hints' }, app.reveal
    ? 'Enter open · Ctrl+Enter reveal · Ctrl+D pin · Shift+Del remove · F5 re-index · Esc'
    : 'Enter open · Ctrl+D pin · Shift+Del remove · F5 re-index · Esc');
  dlg.append(search, list, el('div', { class: 'qo-footer muted small' }, status, hints));

  const root = app.root();
  let index = null;
  let searcher = null;
  let result = null;
  let items = [];
  let sel = -1;
  let transient = null;
  let have = new Set();

  function ensureIndex(force) {
    if (root == null) return;
    const paths = app.files();
    const key = `${root}\n${paths.length}\n${paths[0]}\n${paths[paths.length - 1]}`;
    if (force || cache?.key !== key) cache = { key, index: buildIndex(paths, root), have: new Set(paths) };
    index = cache.index;
    have = cache.have;
  }

  function runSearch(keepSelection) {
    const keep = keepSelection ? items[sel]?.fullPath : null;
    if (!searcher) searcher = new QuickOpenSearcher(index ?? buildIndex([], ''), (p) => have.has(p));
    else if (index && searcher.index !== index) searcher.setIndex(index);
    result = searcher.search(search.value, app.pinned(), app.recent());
    transient = null;
    items = result.items;
    let select = 0;
    if (keep != null) {
      const k = keep.toLowerCase();
      const i = items.findIndex((it) => it.fullPath.toLowerCase() === k);
      if (i >= 0) select = i;
    }
    sel = items.length ? select : -1;
    paint();
    updateStatus();
  }

  function updateStatus() {
    let text;
    if (transient != null) text = transient;
    else if (root == null) text = 'No Data folder open — showing recent and pinned files only.';
    else if (!result || result.query.isEmpty) {
      let pinned = 0, recent = 0;
      for (const it of result?.items ?? []) it.kind === 'pinned' ? ++pinned : ++recent;
      const files = index ? `${index.count.toLocaleString()} files indexed` : 'Indexing…';
      text = pinned + recent === 0 ? `${files} · no recent files yet — type to search` : `${files} · ${pinned} pinned · ${recent} recent`;
    } else {
      const total = result.indexMatches + result.historyMatches;
      text = total.toLocaleString() + (total === 1 ? ' match' : ' matches');
      if (total > result.items.length) text += ` (top ${result.items.length} shown)`;
      text += ` · ${result.elapsedMs.toFixed(1)} ms`;
    }
    if (index?.truncated) text += ` · index capped at ${MAX_FILES.toLocaleString()} files`;
    status.textContent = text;
    // A one-off message (missing file, pinned, …) gets the whole footer.
    hints.hidden = transient != null;
  }

  // One row: icon, the file name and then its folder (matched letters bold), a "missing"/"recent" tag, the pin.
  function row(it, i) {
    const marks = new Set(it.highlights);
    const runs = (start, end) => {
      const out = [];
      for (let a = start; a < end; ) {
        const on = marks.has(a);
        let b = a + 1;
        while (b < end && marks.has(b) === on) b++;
        const text = it.displayPath.slice(a, b).replace(/\\/g, '/');
        out.push(on ? el('b', {}, text) : text);
        a = b;
      }
      return out;
    };
    const tag = it.missing ? 'missing' : it.kind === 'recent' ? 'recent' : null;
    const pin = el('span', {
      class: `qo-pin${it.kind === 'pinned' ? ' on' : ''}`,
      title: it.kind === 'pinned' ? 'Unpin (Ctrl+D)' : 'Pin (Ctrl+D)',
      onclick: (e) => {
        e.stopPropagation();
        sel = i;
        togglePinSelected();
      },
    });
    pin.innerHTML = PIN_SVG;
    return el(
      'li',
      {
        class: `qo-row${i === sel ? ' active' : ''}${it.missing ? ' missing' : ''}`,
        role: 'option',
        'aria-selected': String(i === sel),
        title: it.fullPath,
        onmousedown: (e) => e.preventDefault(), // typing stays in the search box
        onclick: (e) => {
          sel = i;
          accept(e.ctrlKey || e.metaKey);
        },
      },
      iconEl(fileIconSvg(it.fileName, 16), 'qo-icon'),
      el('span', { class: 'qo-name' }, ...runs(it.nameStart, it.displayPath.length)),
      it.folder ? el('span', { class: 'qo-folder' }, el('span', { dir: 'ltr' }, ...runs(0, it.folder.length))) : el('span', { class: 'qo-folder' }),
      tag ? el('span', { class: 'qo-tag' }, tag) : null,
      pin,
    );
  }

  function paint() {
    list.replaceChildren(...items.map(row));
    const rows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, items.length));
    list.style.height = `calc(${rows} * var(--qo-row))`;
    list.children[sel]?.scrollIntoView({ block: 'nearest' });
  }

  function move(delta) {
    if (!items.length) return;
    sel = Math.max(0, Math.min(items.length - 1, Math.max(0, sel) + delta));
    for (const [i, li] of [...list.children].entries()) {
      li.classList.toggle('active', i === sel);
      li.setAttribute('aria-selected', String(i === sel));
    }
    list.children[sel]?.scrollIntoView({ block: 'nearest' });
  }

  const pageSize = () => {
    const h = list.firstElementChild?.offsetHeight || 1;
    return Math.max(1, Math.floor(list.clientHeight / h) - 1);
  };

  function close() {
    dlg.close();
    dlg.remove();
    if (openNow === dlg) openNow = null;
  }

  function accept(reveal) {
    const it = items[sel];
    if (!it) return;
    if (!have.has(it.fullPath)) {
      transient = it.isHistory
        ? `"${it.fileName}" no longer exists — Shift+Del removes it from the list.`
        : `"${it.fileName}" no longer exists — re-indexing…`;
      updateStatus();
      if (!it.isHistory) reindex();
      return;
    }
    close();
    (reveal && app.reveal ? app.reveal : app.open)(it.fullPath);
  }

  function togglePinSelected() {
    const it = items[sel];
    if (!it) return;
    const pinned = app.togglePin(it.fullPath);
    runSearch(true);
    transient = (pinned ? 'Pinned ' : 'Unpinned ') + it.fileName;
    updateStatus();
  }

  function removeSelected() {
    const it = items[sel];
    if (!it) return;
    let message;
    if (it.kind === 'pinned') {
      app.unpin(it.fullPath);
      message = 'Unpinned ' + it.fileName;
    } else if (it.kind === 'recent') {
      app.removeRecent(it.fullPath);
      message = `Removed ${it.fileName} from recent files`;
    } else {
      transient = 'Only recent or pinned entries can be removed.';
      updateStatus();
      return;
    }
    const at = sel;
    runSearch(false);
    if (items.length) move(Math.min(at, items.length - 1) - sel);
    transient = message;
    updateStatus();
  }

  function reindex() {
    if (root == null) return updateStatus();
    ensureIndex(true);
    runSearch(true);
  }

  search.addEventListener('input', () => runSearch(false));
  dlg.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    let done = true;
    if (k === 'ArrowUp' || (ctrl && e.shiftKey && k.toLowerCase() === 'p')) move(-1);
    else if (k === 'ArrowDown' || (ctrl && !e.shiftKey && k.toLowerCase() === 'p')) move(1);
    else if (k === 'PageUp') move(-pageSize());
    else if (k === 'PageDown') move(pageSize());
    else if (ctrl && k === 'Home') move(-items.length);
    else if (ctrl && k === 'End') move(items.length);
    else if (k === 'Enter' && !e.shiftKey && !e.altKey) accept(ctrl);
    else if (ctrl && !e.shiftKey && k.toLowerCase() === 'd') togglePinSelected();
    else if (e.shiftKey && !ctrl && k === 'Delete') removeSelected();
    else if (k === 'F5' && !ctrl) reindex();
    else done = false;
    if (done) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  // Closes when it loses focus, as the desktop palette does: a click outside lands on the dialog's backdrop.
  dlg.addEventListener('mousedown', (e) => {
    if (e.target === dlg) {
      const r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
    }
  });

  document.body.append(dlg);
  dlg.showModal();
  ensureIndex(false);
  runSearch(false);
  search.focus();
}
