// "Compare two folders", a port of HappyTool's CompareFoldersDialog: lists the files only one folder has and the
// pairs that differ in size, time or (when asked) contents. Each folder is one among the open files (the left starts
// as the open Data folder) or one picked from disk with Browse; double-click or Enter opens a row's file when it is
// among the open files.
import { el, button, openDialog, pickFiles, toast } from '../ui.js';
import { netTrim, toUpperSameLength } from '../tools/find-in-files.js';
import { compareFolders, doneText, n0, utcMinutes } from '../tools/compare-folders.js';

// The last comparison, shown again when the window opens next: opening a file has to close it here.
let last = null;

const clean = (s) => netTrim(s).replace(/\\/g, '/').replace(/\/+$/, '');
const under = (root, path) => path.toLowerCase().startsWith(root.toLowerCase() + '/');

/**
 * Shows Compare two folders. `files()` gives the open files ([{path, size, lastModified, read()}]); `root()` the open
 * Data folder ('' for every open file, null when nothing is open); `open(path)` opens a file and returns false when
 * it could not.
 */
export function showCompareFolders({ files, root, open }) {
  let ctl = null;
  const picked = last?.picked ?? { left: null, right: null }; // {root, files} of folders read from disk with Browse
  let rows = last?.rows ?? [];
  let at = -1;
  return openDialog((dlg, done) => {
    dlg.style.width = 'min(1080px, calc(100vw - 32px))';
    const close = (v) => {
      ctl?.abort();
      done(v);
    };
    dlg.addEventListener('cancel', () => {
      ctl?.abort();
      remember();
    });
    const statusLine = el('div', { class: 'muted small refs-status', role: 'status', 'aria-live': 'polite' },
      last?.status ?? 'Pick two folders, then Compare.');
    const start = root();
    const folderBox = (side, value) => el('input', { class: 'input input-sm', type: 'text', value, 'aria-label': `${side} folder`,
      placeholder: 'A folder among the open files, e.g. Data/json, or Browse', spellcheck: 'false' });
    const leftBox = folderBox('Left', last?.left ?? (start || ''));
    const rightBox = folderBox('Right', last?.right ?? '');
    const hashBox = el('input', { type: 'checkbox', checked: last?.hash ?? false });
    const identBox = el('input', { type: 'checkbox', checked: last?.ident ?? false });
    const tbody = el('tbody');
    const table = el('table', { class: 'grid cf-grid', tabindex: '0', 'aria-label': 'Differences' },
      el('thead', {}, el('tr', {}, ...['Relative path', 'Status', 'Left size', 'Right size', 'Left modified (UTC)', 'Right modified (UTC)']
        .map((h, i) => el('th', i >= 2 && i <= 3 ? { class: 'num' } : {}, h)))), tbody);
    const browseLeft = button('Browse…', () => browse('left', leftBox));
    const browseRight = button('Browse…', () => browse('right', rightBox));
    const compareBtn = button('Compare', () => (ctl ? ctl.abort() : run()), { class: 'btn btn-primary' });

    const remember = () =>
      (last = { left: leftBox.value, right: rightBox.value, hash: hashBox.checked, ident: identBox.checked, rows, status: statusLine.textContent, picked });
    function select(i, scroll = true) {
      const trs = tbody.rows;
      if (!trs.length) return;
      at = Math.max(0, Math.min(i, trs.length - 1));
      [...trs].forEach((r, j) => r.classList.toggle('sel', j === at));
      if (scroll) trs[at].scrollIntoView({ block: 'nearest' });
    }
    const dash = (f, g) => (f ? g(f) : '—');
    const rowEl = (r, i) =>
      el('tr', { dataset: { i }, title: r.open.path },
        el('td', { class: 'name' }, r.rel), el('td', {}, r.status),
        el('td', { class: 'num' }, dash(r.left, (f) => n0(f.size))), el('td', { class: 'num' }, dash(r.right, (f) => n0(f.size))),
        el('td', {}, dash(r.left, (f) => utcMinutes(f.lastModified))), el('td', {}, dash(r.right, (f) => utcMinutes(f.lastModified))));
    async function openRow(i) {
      const r = rows[i];
      if (!r) return;
      remember();
      if ((await open(r.open.path)) !== false) close(r);
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

    // A side's folder: the one picked with Browse when the box still names it, else the open files under the path.
    // Null when it holds no file (the web cannot see an empty folder).
    function resolve(side, box) {
      const r = clean(box.value);
      if (!r) return null;
      const p = picked[side];
      const list = p && r === p.root ? p.files : files().filter((f) => under(r, f.path));
      if (!list.length) return null;
      return {
        id: p && r === p.root ? p : toUpperSameLength(r),
        files: list.map((f) => ({ ...f, rel: f.path.slice(r.length + 1) })),
      };
    }
    function setBusy(on) {
      compareBtn.textContent = on ? 'Cancel' : 'Compare';
      browseLeft.disabled = browseRight.disabled = leftBox.disabled = rightBox.disabled = hashBox.disabled = identBox.disabled = on;
    }
    async function run() {
      const left = resolve('left', leftBox);
      if (!left) return toast('Choose a valid left folder.', 'warn');
      const right = resolve('right', rightBox);
      if (!right) return toast('Choose a valid right folder.', 'warn');
      if (left.id === right.id) return toast('Left and right folders are the same.');
      ctl = new AbortController();
      setBusy(true);
      rows = [];
      tbody.replaceChildren();
      at = -1;
      statusLine.textContent = 'Scanning…';
      try {
        const res = await compareFolders(left.files, right.files, {
          contentHash: hashBox.checked,
          showIdentical: identBox.checked,
          signal: ctl.signal,
          progress: (side, n) => (statusLine.textContent = `Scanning ${side}… ${n0(n)} files`),
          onRow: (r) => {
            rows.push(r);
            tbody.append(rowEl(r, rows.length - 1));
          },
        });
        statusLine.textContent = doneText(res);
      } catch (e) {
        statusLine.textContent = e.name === 'AbortError' ? 'Cancelled.' : `Error: ${e.message}`;
      } finally {
        ctl = null;
        setBusy(false);
        remember();
      }
    }
    // Browse: a folder read from disk; its name goes in the box.
    async function browse(side, box) {
      const list = await pickFiles({ directory: true });
      if (!list.length) return;
      const all = list.map((f) => ({ path: f.webkitRelativePath || f.name, size: f.size, lastModified: f.lastModified, read: async () => new Uint8Array(await f.arrayBuffer()) }));
      const top = all[0].path.includes('/') ? all[0].path.slice(0, all[0].path.indexOf('/')) : '';
      picked[side] = { root: top, files: all };
      box.value = top;
      remember();
    }

    const row = (label, box, btn) => [el('label', { class: 'fif-label' }, label), box, btn];
    dlg.append(
      el('h2', { class: 'dialog-title' }, 'Compare two folders'),
      el('div', { class: 'cf-top' },
        ...row('Left folder:', leftBox, browseLeft),
        ...row('Right folder:', rightBox, browseRight),
        el('div', { class: 'cf-options' },
          el('label', {}, hashBox, ' Compare file contents (SHA-256 when sizes match)'),
          el('label', {}, identBox, ' Include identical files in the list'),
          compareBtn)),
      el('div', { class: 'grid-wrap fif-wrap' }, table),
      el('div', { class: 'dialog-actions refs-actions' }, statusLine, el('span', { class: 'spacer' }),
        button('Close', () => (remember(), close(null)))),
    );
    tbody.replaceChildren(...rows.map(rowEl));
    requestAnimationFrame(() => (leftBox.value ? rightBox : leftBox).focus());
  });
}
