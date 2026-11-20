// .lng text table editor: language picker, searchable key list, text editor with the other languages beside it,
// add/delete key, CSV export and import.
import { el, button, toast, ask, confirmBox, pickFiles, downloadBlob, debounce } from '../ui.js';
import { lngToCsv, mergeCsv } from '../formats/lng.js';
import { baseName } from '../util.js';

const ROW_LIMIT = 1000;
const MAX_KEY = 256;
const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); // ordinal, like HappyTool

export function renderLng(node, ctx) {
  const file = node.model;
  const ui = (node.ui ??= { lang: 0, filter: '', key: null, scroll: 0 });
  if (ui.lang >= file.languages.length) ui.lang = 0;
  const lang = () => file.languages[ui.lang];

  const langSel = el(
    'select',
    { class: 'input input-sm', 'aria-label': 'Language' },
    file.languages.map((l, i) => el('option', { value: i, selected: i === ui.lang }, `${l.name} (${l.entries.length})`)),
  );
  const filterBox = el('input', { type: 'search', class: 'input input-sm', placeholder: 'Search keys and text', 'aria-label': 'Search keys and text', value: ui.filter });
  const count = el('span', { class: 'muted' });
  const list = el('div', { class: 'lng-list', role: 'listbox', tabindex: '0', 'aria-label': 'Keys' });
  const editor = el('div', { class: 'lng-editor' });

  const matches = () => {
    const f = ui.filter.toLowerCase();
    return lang().entries.filter((e) => !f || e.key.toLowerCase().includes(f) || e.text.toLowerCase().includes(f));
  };

  function fillList() {
    const all = matches();
    const shown = all.slice(0, ROW_LIMIT);
    list.replaceChildren(
      ...shown.map((e) =>
        el(
          'div',
          { class: `lng-row${e.key === ui.key ? ' sel' : ''}`, role: 'option', 'aria-selected': String(e.key === ui.key), dataset: { key: e.key } },
          el('span', { class: 'lng-key' }, e.key),
          el('span', { class: 'lng-text' }, e.text.replace(/\r?\n/g, ' ⏎ ') || '(empty)'),
        ),
      ),
      ...(all.length > ROW_LIMIT ? [el('p', { class: 'note' }, `Showing the first ${ROW_LIMIT} of ${all.length.toLocaleString()} matches. Search to narrow the list.`)] : []),
    );
    count.textContent = ui.filter ? `${all.length.toLocaleString()} of ${lang().entries.length.toLocaleString()}` : `${lang().entries.length.toLocaleString()} keys`;
  }

  function fillEditor() {
    const entry = lang().entries.find((e) => e.key === ui.key);
    if (!entry) {
      editor.replaceChildren(el('p', { class: 'muted empty-hint' }, 'Pick a key to edit its text.'));
      return;
    }
    const ta = el('textarea', { class: 'editor lng-textarea', spellcheck: 'false', 'aria-label': `Text for ${entry.key} in ${lang().name}` });
    ta.value = entry.text;
    const refreshRow = debounce(() => {
      const row = list.querySelector(`.lng-row[data-key="${CSS.escape(entry.key)}"] .lng-text`);
      if (row) row.textContent = entry.text.replace(/\r?\n/g, ' ⏎ ') || '(empty)';
    }, 200);
    ta.addEventListener('input', () => {
      entry.text = ta.value;
      ctx.changed();
      refreshRow();
    });
    const others = file.languages
      .map((l, i) => ({ l, i, e: l.entries.find((x) => x.key === entry.key) }))
      .filter(({ i }) => i !== ui.lang);
    editor.replaceChildren(
      el('div', { class: 'lng-editor-head' }, el('code', { class: 'lng-key-full' }, entry.key), el('span', { class: 'chip' }, lang().name)),
      ta,
    );
    if (others.length)
      editor.append(
        el(
          'div',
          { class: 'lng-others' },
          el('h3', {}, 'Other languages'),
          ...others.map(({ l, i, e }) =>
            el(
              'button',
              { type: 'button', class: 'lng-other', title: `Switch to ${l.name}`, onclick: () => switchLang(i) },
              el('span', { class: 'chip' }, l.name),
              el('span', { class: e ? null : 'muted' }, e ? e.text || '(empty)' : '(missing)'),
            ),
          ),
        ),
      );
  }

  function pick(key) {
    ui.key = key;
    for (const r of list.querySelectorAll('.lng-row')) {
      const on = r.dataset.key === key;
      r.classList.toggle('sel', on);
      r.setAttribute('aria-selected', String(on));
    }
    fillEditor();
  }
  function switchLang(i) {
    ui.lang = i;
    langSel.value = String(i);
    fillList();
    fillEditor();
  }

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.lng-row');
    if (row) pick(row.dataset.key);
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = [...list.querySelectorAll('.lng-row')];
    const cur = rows.findIndex((r) => r.dataset.key === ui.key);
    const next = rows[Math.max(0, Math.min(rows.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      pick(next.dataset.key);
      next.scrollIntoView({ block: 'nearest' });
    }
  });
  list.addEventListener('scroll', () => (ui.scroll = list.scrollTop), { passive: true });
  langSel.addEventListener('change', () => switchLang(Number(langSel.value)));
  filterBox.addEventListener(
    'input',
    debounce(() => {
      ui.filter = filterBox.value.trim();
      fillList();
    }, 150),
  );

  async function addKey() {
    const key = (await ask('New key (added to every language)', '', 'Add'))?.trim();
    if (!key) return;
    if (/[^\x20-\x7e]/.test(key)) return toast('Keys can only use printable ASCII characters', 'error');
    if (key.length >= MAX_KEY) return toast(`Keys must be shorter than ${MAX_KEY} characters`, 'error');
    if (file.languages.some((l) => l.entries.some((e) => e.key === key))) return toast(`${key} already exists`, 'error');
    for (const l of file.languages) {
      l.entries.push({ key, text: '' });
      l.entries.sort(byKey);
    }
    ctx.changed();
    ui.filter = '';
    filterBox.value = '';
    ui.key = key;
    fillList();
    fillEditor();
    list.querySelector(`.lng-row[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'center' });
  }

  async function deleteKey() {
    if (!ui.key) return toast('Pick a key first', 'warn');
    if (!(await confirmBox(`Delete ${ui.key} from every language?`, 'Delete', true))) return;
    for (const l of file.languages) l.entries = l.entries.filter((e) => e.key !== ui.key);
    ui.key = null;
    ctx.changed();
    fillList();
    fillEditor();
    langSel.replaceChildren(...file.languages.map((l, i) => el('option', { value: i, selected: i === ui.lang }, `${l.name} (${l.entries.length})`)));
  }

  const stem = baseName(node.name).replace(/\.[^.]*$/, '') || 'text';
  const exportCsv = () => downloadBlob(new Blob([lngToCsv(file)], { type: 'text/csv;charset=utf-8' }), `${stem}.csv`);
  async function importCsv() {
    const [f] = await pickFiles({ accept: '.csv,text/csv' });
    if (!f) return;
    try {
      const { updated, added } = mergeCsv(file, await f.text());
      if (updated || added) ctx.changed();
      toast(`CSV merged: ${updated} updated, ${added} added`, 'ok');
      fillList();
      fillEditor();
    } catch (e) {
      toast(`CSV import failed: ${e.message}`, 'error');
    }
  }

  fillList();
  fillEditor();
  requestAnimationFrame(() => (list.scrollTop = ui.scroll));
  const order = file.bigEndian ? 'Big-endian (Xbox 360)' : 'Little-endian (PC / Steam)';
  return el(
    'div',
    { class: 'view lng-view' },
    el('div', { class: 'meta-row' }, el('strong', {}, `${file.languages.length} language${file.languages.length === 1 ? '' : 's'}`), el('span', { class: 'muted' }, `${order} · version ${file.ver}`)),
    el(
      'div',
      { class: 'toolbar' },
      langSel,
      filterBox,
      count,
      el('span', { class: 'spacer' }),
      button('Add key…', addKey),
      button('Delete key', deleteKey, { class: 'btn btn-danger-quiet' }),
      button('Export CSV', exportCsv, { title: 'One row per key, one column per language' }),
      button('Import CSV…', importCsv, { title: 'Merge a CSV with a "key" column and one column per language name' }),
    ),
    el('div', { class: 'lng-layout' }, list, editor),
  );
}
