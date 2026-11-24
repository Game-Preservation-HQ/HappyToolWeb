// "Find in files", a port of HappyTool's FindInFilesDialog: every file under a folder that has a line containing the
// string (case ignored), optionally only files ending in one extension. The folder is the open Data folder, a folder
// typed under "Custom path", or one picked from disk; double-click or Enter opens a hit when it is among the open files.
import { el, button, openDialog, pickFiles, toast } from '../ui.js';
import { findInFiles, normalizeExt, netTrim } from '../tools/find-in-files.js';

// The last search, shown again when the window opens next: opening a file has to close it here, where the desktop's
// editor opens over the window and leaves it as it was.
let last = null;

const under = (root, path) => (root ? path.toLowerCase().startsWith(root.toLowerCase() + '/') : true);
const relativeUnder = (root, path) => (root && under(root, path) ? path.slice(root.length + 1) : path);

/**
 * Shows Find in files. `files()` gives the open files ([{path, size, read()}]); `root()` the open Data folder ('' for
 * every open file, null when nothing is open); `open(path)` opens a hit and returns false when it could not.
 */
export function showFindInFiles({ files, root, open }) {
  let ctl = null;
  let picked = last?.picked ?? null; // {root, files} of a folder read from disk with Select folder
  let rows = last?.rows ?? [];
  let at = -1;
  return openDialog((dlg, done) => {
    dlg.style.width = 'min(880px, calc(100vw - 32px))';
    const close = (v) => {
      ctl?.abort();
      done(v);
    };
    dlg.addEventListener('cancel', () => {
      ctl?.abort();
      remember();
    });
    const statusLine = el('div', { class: 'muted small refs-status', role: 'status', 'aria-live': 'polite' },
      last?.status ?? 'Choose a folder, enter text, then Start search.');
    const custom = el('input', { type: 'checkbox', checked: last?.custom ?? false });
    const rootBox = el('input', { class: 'input input-sm fif-root', type: 'text', value: last?.rootText ?? '', disabled: !(last?.custom ?? false),
      'aria-label': 'Folder', placeholder: 'A folder among the open files, e.g. Data/json', spellcheck: 'false' });
    const needleBox = el('input', { class: 'input input-sm fif-needle', type: 'text', value: last?.needle ?? '', 'aria-label': 'String to find', spellcheck: 'false' });
    const extBox = el('input', { class: 'input input-sm fif-ext', type: 'text', value: last?.ext ?? '', 'aria-label': 'File extension', spellcheck: 'false' });
    const tbody = el('tbody');
    const table = el('table', { class: 'grid fif-grid', tabindex: '0', 'aria-label': 'Matching files' },
      el('thead', {}, el('tr', {}, el('th', { style: 'width:45%' }, 'Relative path'), el('th', {}, 'Full path'))), tbody);
    const folderBtn = button('Select folder…', chooseFolder);
    const startBtn = button('Start search', () => (ctl ? ctl.abort() : start()));
    custom.addEventListener('change', () => (rootBox.disabled = !custom.checked));

    const remember = () =>
      (last = { custom: custom.checked, rootText: rootBox.value, needle: needleBox.value, ext: extBox.value, rows, status: statusLine.textContent, picked });
    function select(i, scroll = true) {
      const trs = tbody.rows;
      if (!trs.length) return;
      at = Math.max(0, Math.min(i, trs.length - 1));
      [...trs].forEach((r, j) => r.classList.toggle('sel', j === at));
      if (scroll) trs[at].scrollIntoView({ block: 'nearest' });
    }
    const rowEl = (r, i) => el('tr', { dataset: { i }, title: r.path }, el('td', { class: 'name' }, r.rel), el('td', {}, r.path));
    async function openRow(i) {
      const r = rows[i];
      if (!r) return;
      remember();
      if ((await open(r.path)) !== false) close(r);
    }
    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (tr) select(+tr.dataset.i, false);
    });
    tbody.addEventListener('dblclick', (e) => {
      const tr = e.target.closest('tr');
      if (tr) openRow(+tr.dataset.i);
    });
    table.addEventListener('keydown', (e) => {
      const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[e.key];
      if (step) select(at < 0 ? 0 : at + step);
      else if (e.key === 'Home') select(0);
      else if (e.key === 'End') select(tbody.rows.length - 1);
      else if (e.key === 'Enter' && at >= 0) openRow(at);
      else return;
      e.preventDefault();
    });

    // ResolveSearchRoot: the custom path when ticked, else the open Data folder. Null when there is no such folder.
    function resolve() {
      if (custom.checked) {
        const r = netTrim(rootBox.value).replace(/\\/g, '/').replace(/\/+$/, '');
        if (picked && r === picked.root) return { root: r, files: picked.files };
        const list = r ? files().filter((f) => under(r, f.path)) : [];
        return list.length ? { root: r, files: list } : null;
      }
      const r = root();
      return r == null ? null : { root: r, files: files().filter((f) => under(r, f.path)) };
    }
    function setSearching(on) {
      startBtn.textContent = on ? 'Cancel search' : 'Start search';
      folderBtn.disabled = custom.disabled = needleBox.disabled = extBox.disabled = on;
      rootBox.disabled = on || !custom.checked;
    }
    async function start() {
      const needle = netTrim(needleBox.value);
      if (!needle) return toast('Enter the string to search for.');
      const source = resolve();
      if (!source) return toast('Choose a valid folder (use Select folder or enable Custom path).', 'warn');
      const ext = normalizeExt(extBox.value);
      ctl = new AbortController();
      setSearching(true);
      rows = [];
      tbody.replaceChildren();
      at = -1;
      statusLine.textContent = 'Searching…';
      try {
        const r = await findInFiles(source.files, {
          needle,
          ext,
          signal: ctl.signal,
          progress: (s, m) => (statusLine.textContent = `Searching… ${s} files, ${m} matches`),
          onMatch: (f) => {
            const row = { rel: relativeUnder(source.root, f.path), path: f.path };
            rows.push(row);
            tbody.append(rowEl(row, rows.length - 1));
          },
        });
        statusLine.textContent = `Done. ${r.matched} file(s) matched (${r.scanned} files scanned).`;
      } catch (e) {
        statusLine.textContent = e.name === 'AbortError' ? 'Cancelled.' : `Error: ${e.message}`;
      } finally {
        ctl = null;
        setSearching(false);
        remember();
      }
    }
    // Select folder: a folder read from disk becomes the custom path; its files open here when they are open files.
    async function chooseFolder() {
      const list = await pickFiles({ directory: true });
      if (!list.length) return;
      const all = list.map((f) => ({ path: f.webkitRelativePath || f.name, size: f.size, read: async () => new Uint8Array(await f.arrayBuffer()) }));
      const top = all[0].path.includes('/') ? all[0].path.slice(0, all[0].path.indexOf('/')) : '';
      picked = { root: top, files: all };
      custom.checked = true;
      rootBox.disabled = false;
      rootBox.value = top;
      remember();
    }

    dlg.append(
      el('h2', { class: 'dialog-title' }, 'Find in files'),
      el('div', { class: 'fif-top' },
        el('div', { class: 'fif-buttons' }, folderBtn, startBtn),
        el('label', { class: 'fif-custom' }, custom, ' Custom path'), rootBox,
        el('label', { class: 'fif-label' }, 'String to find:'), needleBox,
        el('label', { class: 'fif-label' }, 'File extension:'), extBox),
      el('div', { class: 'grid-wrap fif-wrap' }, table),
      el('div', { class: 'dialog-actions refs-actions' }, statusLine, el('span', { class: 'spacer' }),
        button('Close', () => (remember(), close(null)), { class: 'btn btn-primary' })),
    );
    tbody.replaceChildren(...rows.map(rowEl));
    requestAnimationFrame(() => needleBox.focus());
  });
}
