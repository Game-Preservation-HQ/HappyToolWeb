// Voice macro (.vmd) view: the desktop VmdFileEditor's grid (Category, Usage, ID, Variations, Menu pos, Menu text id),
// its byte-order checkbox, Add row / Delete row and summary line. Saving goes through the app (writeVmd).
import { el, button, toast } from '../ui.js';
import { groupId, csIntTryParse, MAX_MENU_TEXT_ID_CHARS } from '../formats/vmd.js';

const COLUMNS = [
  { key: 'category', label: 'Category', int: true },
  { key: 'usage', label: 'Usage', int: true },
  { key: 'id', label: 'ID' },
  { key: 'variationCount', label: 'Variations', int: true },
  { key: 'menuPosition', label: 'Menu pos', title: 'T0, T5, C12, etc. (T=100+, C=200+ in file)' },
  { key: 'menuTextId', label: 'Menu text id', title: `ASCII text key (max ${MAX_MENU_TEXT_ID_CHARS} chars)` },
];

export function renderVmd(node, ctx) {
  const file = node.model;
  const ui = (node.ui ??= { focused: -1 });
  const summary = el('span');
  const status = el('span', { class: 'muted' });
  const tbody = el('tbody');

  function updateChrome() {
    const endian = file.bigEndian ? 'big-endian (Xbox 360)' : 'little-endian (PC)';
    summary.textContent = `Format: voice macro (.vmd)  •  version ${file.version}  •  ${file.groups.length} groups  •  ${endian}`;
    status.textContent = node.dirty ? 'Modified' : 'Ready';
    delBtn.disabled = ui.focused < 0 || ui.focused >= file.groups.length;
  }
  const changed = () => (ctx.changed(), updateChrome());

  function focusRow(i) {
    ui.focused = i;
    for (const tr of tbody.children) tr.classList.toggle('sel', Number(tr.dataset.i) === i);
    updateChrome();
  }

  function row(g, i) {
    const idCell = el('td', { class: 'num' }, String(groupId(g)));
    const cells = COLUMNS.map((c) => {
      if (c.key === 'id') return idCell;
      const input = el('input', {
        type: 'text',
        class: `vmd-cell${c.int ? ' num' : ''}`,
        value: String(g[c.key] ?? ''),
        spellcheck: 'false',
        'aria-label': `${c.label}, row ${i + 1}`,
        inputmode: c.int ? 'numeric' : null,
      });
      input.addEventListener('change', () => {
        if (c.int) {
          const v = csIntTryParse(input.value);
          if (v === null) {
            toast(`Invalid value for ${c.label}: enter a whole number.`, 'warn');
            input.value = String(g[c.key]);
            return;
          }
          g[c.key] = v;
          input.value = String(v);
          if (c.key === 'category' || c.key === 'usage') idCell.textContent = String(groupId(g));
        } else g[c.key] = input.value;
        changed();
      });
      return el('td', {}, input);
    });
    return el('tr', { dataset: { i }, class: i === ui.focused ? 'sel' : null }, ...cells);
  }

  function fill() {
    tbody.replaceChildren(...file.groups.map(row));
    updateChrome();
  }

  tbody.addEventListener('focusin', (e) => {
    const tr = e.target.closest('tr');
    if (tr) focusRow(Number(tr.dataset.i));
  });

  const bigEndian = el('input', { type: 'checkbox', checked: file.bigEndian });
  bigEndian.addEventListener('change', () => {
    file.bigEndian = bigEndian.checked;
    changed();
  });

  const addBtn = button('Add row', () => {
    file.groups.push({ category: 0, usage: 0, variationCount: 0, menuPosition: '', menuTextId: '' });
    ui.focused = file.groups.length - 1;
    fill();
    changed();
    tbody.lastElementChild?.querySelector('input')?.focus();
  });
  const delBtn = button('Delete row', () => {
    if (ui.focused < 0 || ui.focused >= file.groups.length) return;
    file.groups.splice(ui.focused, 1);
    ui.focused = Math.min(ui.focused, file.groups.length - 1);
    fill();
    changed();
  });

  const table = el(
    'table',
    { class: 'grid vmd-grid', 'aria-label': 'Voice groups' },
    el('thead', {}, el('tr', {}, ...COLUMNS.map((c) => el('th', { title: c.title ?? null, class: c.int || c.key === 'id' ? 'num' : null }, c.label)))),
    tbody,
  );
  fill();

  return el(
    'div',
    { class: 'view vmd-view' },
    el('div', { class: 'toolbar' }, el('label', { class: 'check' }, bigEndian, 'Big-endian (Xbox 360)'), addBtn, delBtn),
    el('div', { class: 'grid-wrap' }, table),
    el('div', { class: 'meta-row' }, summary, el('span', { class: 'spacer' }), status),
  );
}
