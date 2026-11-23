// "Text key references" window, a port of HappyTool's TextKeyReferencesForm: the .nut / .json / .zson lines under
// the Data folder that name a .lng key. It searches as it opens; double-click or Enter on a line opens that file there.
import { el, button, openDialog, pickFiles } from '../ui.js';
import { findKeyReferences, isSearchable, relativeTo } from '../formats/lng-refs.js';

const MAX_ROWS = 5000; // rows drawn; the status line still counts them all

/**
 * Shows the references to `key`. ctx.searchFiles() gives the default Data folder ({root, label, files}); `open(path,
 * line)` opens a hit (line is 1-based) and returns false when it could not.
 */
export function showKeyReferences(key, { searchFiles, open }) {
  key = (key ?? '').trim();
  let source = searchFiles();
  let ctl = null;
  let hits = [];
  let at = -1;
  return openDialog((dlg, done) => {
    dlg.style.width = 'min(920px, calc(100vw - 32px))';
    const close = (v) => {
      ctl?.abort();
      done(v);
    };
    dlg.addEventListener('cancel', () => ctl?.abort());
    const statusLine = el('div', { class: 'muted small refs-status', role: 'status', 'aria-live': 'polite' });
    const label = el('div', { class: 'refs-label' });
    const tbody = el('tbody');
    const table = el('table', { class: 'grid refs-grid', tabindex: '0', 'aria-label': 'References' },
      el('thead', {}, el('tr', {}, el('th', { style: 'width:44px' }, 'Type'), el('th', { class: 'num', style: 'width:44px' }, 'Line'),
        el('th', { style: 'width:260px' }, 'Relative path'), el('th', {}, 'Preview'))),
      tbody);
    const searchBtn = button('Search again', () => (ctl ? ctl.abort() : run()));
    const folderBtn = button('Data folder…', chooseFolder);

    const setLabel = () => (label.textContent = `Searching .nut / .json / .zson under ${source.label || 'Data'} for: ${key}`);
    function select(i, scroll = true) {
      const rows = tbody.rows;
      if (!rows.length) return;
      at = Math.max(0, Math.min(i, rows.length - 1));
      [...rows].forEach((r, j) => r.classList.toggle('sel', j === at));
      if (scroll) rows[at].scrollIntoView({ block: 'nearest' });
    }
    function fill() {
      at = -1;
      tbody.replaceChildren(...hits.slice(0, MAX_ROWS).map((h, i) =>
        el('tr', { dataset: { i }, title: h.path },
          el('td', {}, h.kind), el('td', { class: 'num' }, String(h.line)), el('td', { class: 'name' }, relativeTo(source.root, h.path)),
          el('td', { class: 'refs-prev' }, h.preview))));
    }
    async function openHit(i) {
      const h = hits[i];
      if (!h) return;
      if ((await open(h.path, h.line)) !== false) close(h);
    }
    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (tr) select(+tr.dataset.i, false);
    });
    tbody.addEventListener('dblclick', (e) => {
      const tr = e.target.closest('tr');
      if (tr) openHit(+tr.dataset.i);
    });
    table.addEventListener('keydown', (e) => {
      const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[e.key];
      if (step) select(at < 0 ? 0 : at + step);
      else if (e.key === 'Home') select(0);
      else if (e.key === 'End') select(tbody.rows.length - 1);
      else if (e.key === 'Enter' && at >= 0) openHit(at);
      else return;
      e.preventDefault();
    });

    async function run() {
      if (!key) return (statusLine.textContent = 'No text key to search for.');
      if (!source.files.length) return (statusLine.textContent = 'Choose a valid Data folder.');
      ctl = new AbortController();
      searchBtn.textContent = 'Cancel';
      folderBtn.disabled = true;
      statusLine.textContent = 'Searching…';
      hits = [];
      fill();
      try {
        hits = await findKeyReferences(source.files, key, {
          signal: ctl.signal,
          progress: (scanned, found) => (statusLine.textContent = `Searching… ${scanned.toLocaleString()} file(s), ${found.toLocaleString()} match(es)`),
        });
        fill();
        statusLine.textContent = `${hits.length.toLocaleString()} reference(s) in scripts/JSON (${source.label || 'the open files'}).` +
          (hits.length > MAX_ROWS ? ` The first ${MAX_ROWS.toLocaleString()} are listed.` : '');
        if (hits.length) select(0);
      } catch (e) {
        statusLine.textContent = e.name === 'AbortError' ? 'Cancelled.' : `Error: ${e.message}`;
      } finally {
        ctl = null;
        searchBtn.textContent = 'Search again';
        folderBtn.disabled = false;
      }
    }
    // The web searches a folder read from disk in place; its files open here when they are among the open files.
    async function chooseFolder() {
      const picked = await pickFiles({ directory: true });
      if (!picked.length) return;
      const list = picked.map((f) => ({ path: f.webkitRelativePath || f.name, size: f.size, read: async () => new Uint8Array(await f.arrayBuffer()) }));
      const root = list[0].path.includes('/') ? list[0].path.slice(0, list[0].path.indexOf('/')) : '';
      source = { root, label: root || 'the picked folder', files: list.filter((f) => isSearchable(f.path)) };
      setLabel();
      run();
    }

    setLabel();
    dlg.append(
      el('h2', { class: 'dialog-title' }, `Text key references — ${key || '(none)'}`),
      label,
      el('div', { class: 'grid-wrap refs-wrap' }, table),
      el('div', { class: 'dialog-actions refs-actions' }, statusLine, el('span', { class: 'spacer' }), folderBtn, searchBtn,
        button('Close', () => close(null), { class: 'btn btn-primary' })),
    );
    if (source.files.length) queueMicrotask(run);
    else statusLine.textContent = 'Choose the game Data folder, then search.';
    requestAnimationFrame(() => table.focus());
  });
}
