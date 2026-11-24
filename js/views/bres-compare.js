// "Compare two bundles", a port of HappyTool's BresBundleCompareDialog: pairs the embedded .rrm / .rmd models of a
// Reference .bres with those of the Workshop .bres (same mesh under a new name, same name with a new mesh, gone,
// new). The desktop opens it from the file browser on a .bres with that file as the Workshop; the web also lets the
// Workshop be chosen here. The desktop's 3D previews of the selected row are left out.
import { el, button, openDialog, pickFiles, toast } from '../ui.js';
import { loadBundle, compareBundles, isMatchRow } from '../tools/bres-compare.js';
import { ModelFingerprints } from '../tools/model-fingerprint.js';

const TITLE = 'Compare BRES models (.rrm / .rmd)';
const HINT = 'Only embedded .rrm / .rmd (standalone .dds omitted). Steam builds often use .rrm; Xbox One often uses .rmd for the same basename — those pair when vertex-cloud matches even if strict shape keys differ. Renames (different basenames) can still pair via triangle-soup hash when tri count/geometry match but vertex welding differs; when several workshop models share one soup hash, the matcher picks the best pair using paired DDS size (logical WxH) and closest vertex count. Order: strict visual-shape → same-name → vertex-cloud → .rrm↔.rmd cloud → cross-format tri soup → global tri soup (scored). DDS bytes are not in the key; details note DDS after a match. Matches only · Swap ↔.';

/**
 * Shows the compare window. `workshop` is the bundle it opens on ({path, read()}, or null to choose one here).
 */
export function showBresCompare({ workshop = null } = {}) {
  let pathWorkshop = workshop, pathReference = null;
  let allRows = [];
  let at = -1;
  return openDialog((dlg, done) => {
    dlg.style.width = 'min(1200px, calc(100vw - 32px))';
    const lblNew = el('div', { class: 'bc-path' });
    const lblOld = el('div', { class: 'bc-path' });
    const statusLine = el('div', { class: 'muted small refs-status', role: 'status', 'aria-live': 'polite' });
    const onlyBox = el('input', { type: 'checkbox' });
    const tbody = el('tbody');
    const table = el('table', { class: 'grid bc-grid', tabindex: '0', 'aria-label': 'Model pairs' },
      el('thead', {}, el('tr', {}, ...['Reference (old) name', 'Workshop (new) name', 'Status', 'Details'].map((h) => el('th', {}, h)))), tbody);
    const swapBtn = button('Swap ↔', () => {
      [pathWorkshop, pathReference] = [pathReference, pathWorkshop];
      refresh();
    });
    const compareBtn = button('Compare', run, { class: 'btn btn-primary' });

    const pick = async (title) => {
      const [f] = await pickFiles({ accept: '.bres' });
      return f ? { path: f.name, read: async () => new Uint8Array(await f.arrayBuffer()), title } : null;
    };
    function refresh() {
      lblNew.textContent = 'Workshop (compare column): ' + (pathWorkshop?.path ?? '(not chosen)');
      lblOld.textContent = pathReference ? 'Reference: ' + pathReference.path : 'Reference: (not chosen)';
      swapBtn.disabled = !(pathWorkshop && pathReference);
      allRows = [];
      populate();
      statusLine.textContent = '';
    }
    function select(i, scroll = true) {
      const trs = tbody.rows;
      if (!trs.length) return;
      at = Math.max(0, Math.min(i, trs.length - 1));
      [...trs].forEach((r, j) => r.classList.toggle('sel', j === at));
      if (scroll) trs[at].scrollIntoView({ block: 'nearest' });
    }
    function populate() {
      const shown = onlyBox.checked ? allRows.filter(isMatchRow) : allRows;
      tbody.replaceChildren(...shown.map((r, i) =>
        el('tr', { dataset: { i } }, el('td', { class: 'name' }, r.oldName ?? ''), el('td', { class: 'name' }, r.newName ?? ''),
          el('td', {}, r.status), el('td', { class: 'bc-details' }, r.details ?? ''))));
      at = -1;
      if (shown.length) select(0, false);
    }
    async function run() {
      if (!pathReference) return toast('Choose the other .bres file for the Reference column first (can be older or newer than Workshop).');
      if (!pathWorkshop) return toast('Workshop bundle path is missing.', 'warn');
      compareBtn.disabled = true;
      statusLine.textContent = 'Comparing…';
      await new Promise((r) => setTimeout(r));
      try {
        const oldA = await loadBundle(await pathReference.read());
        const newA = await loadBundle(await pathWorkshop.read());
        allRows = compareBundles(oldA, newA, new ModelFingerprints());
        populate();
        const m = allRows.filter(isMatchRow).length;
        statusLine.textContent = `${allRows.length} rows, ${m} matched.`;
      } catch (e) {
        allRows = [];
        populate();
        statusLine.textContent = '';
        toast(e.message, 'error');
      } finally {
        compareBtn.disabled = false;
      }
    }

    onlyBox.addEventListener('change', populate);
    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (tr) select(+tr.dataset.i, false);
    });
    table.addEventListener('keydown', (e) => {
      const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[e.key];
      if (step) select(at < 0 ? 0 : at + step);
      else if (e.key === 'Home') select(0);
      else if (e.key === 'End') select(tbody.rows.length - 1);
      else return;
      e.preventDefault();
    });

    dlg.append(
      el('h2', { class: 'dialog-title' }, TITLE),
      el('div', { class: 'bc-top' },
        lblNew, button('Choose Workshop .bres…', async () => {
          const f = await pick();
          if (f) (pathWorkshop = f), refresh();
        }),
        lblOld, button('Choose other / newer .bres…', async () => {
          const f = await pick();
          if (f) (pathReference = f), refresh();
        }),
        el('div', { class: 'bc-options' }, swapBtn, compareBtn, el('label', {}, onlyBox, ' Matches only'))),
      el('p', { class: 'muted small bc-hint' }, HINT),
      el('div', { class: 'grid-wrap fif-wrap' }, table),
      el('div', { class: 'dialog-actions refs-actions' }, statusLine, el('span', { class: 'spacer' }), button('Close', () => done(null))),
    );
    refresh();
  });
}
