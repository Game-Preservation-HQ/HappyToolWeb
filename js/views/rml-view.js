// Material definition (.rml) view: the desktop RmlFileEditor's tree (Node / property, Type, Value), opened to level 2,
// with Expand all / Collapse all, Value editing for typed leaves and its summary line. Saving goes through the app
// (serializeRml).
import { el, button, toast } from '../ui.js';
import { displayValue, invalidValueMessage, isContainer, isEditable, nodeLabel, rmlSummary, trySetFromText, typeLabel } from '../formats/rml.js';

/** TreeList.ExpandToLevel(2): every container at depth 0, 1 or 2 starts open. */
function expandToLevel(doc, level) {
  const open = new Set();
  const walk = (n, depth) => {
    if (!isContainer(n)) return;
    if (depth <= level) open.add(n);
    for (const c of n.children) walk(c, depth + 1);
  };
  for (const r of doc.roots) walk(r, 0);
  return open;
}

export function renderRml(node, ctx) {
  const doc = node.model;
  const ui = (node.ui ??= { open: expandToLevel(doc, 2) });
  const summary = el('span');
  const status = el('span', { class: 'muted' });
  const tbody = el('tbody');
  const labelCells = new Map(); // container -> its Node / property cell, for the 0SP label refresh

  function updateChrome() {
    summary.textContent = rmlSummary(doc);
    status.textContent = node.dirty ? 'Modified' : 'Ready';
  }

  function valueCell(n, parent) {
    if (isContainer(n)) return el('td');
    if (!isEditable(n)) return el('td', { class: 'muted' }, displayValue(n));
    const input = el('input', { type: 'text', class: 'vmd-cell', value: displayValue(n), spellcheck: 'false', 'aria-label': `Value of ${n.name}` });
    input.addEventListener('change', () => {
      if (trySetFromText(n, input.value)) {
        input.value = displayValue(n); // the normalized value
        if (n.name === '0SP' && parent && parent.children[0] === n) {
          const cell = labelCells.get(parent);
          if (cell) cell.lastChild.textContent = nodeLabel(parent);
        }
        ctx.changed();
        updateChrome();
      } else {
        toast(invalidValueMessage(n), 'warn');
        input.value = displayValue(n);
      }
    });
    return el('td', { class: 'rml-value' }, input);
  }

  function rows(n, parent, depth, out) {
    const open = ui.open.has(n);
    const twisty = isContainer(n)
      ? el('button', { type: 'button', class: 'twisty', 'aria-label': `${open ? 'Collapse' : 'Expand'} ${n.name}`, 'aria-expanded': String(open), onclick: () => toggle(n) }, open ? '▾' : '▸')
      : el('span', { class: 'twisty', 'aria-hidden': 'true' });
    const label = el('td', { class: 'rml-node', style: `padding-left: ${4 + depth * 16}px` }, twisty, el('span', {}, nodeLabel(n)));
    if (isContainer(n)) labelCells.set(n, label);
    out.push(el('tr', {}, label, el('td', {}, typeLabel(n)), valueCell(n, parent)));
    if (open) for (const c of n.children) rows(c, n, depth + 1, out);
  }

  function fill() {
    labelCells.clear();
    const out = [];
    for (const r of doc.roots) rows(r, null, 0, out);
    tbody.replaceChildren(...out);
    updateChrome();
  }

  function toggle(n) {
    if (ui.open.has(n)) ui.open.delete(n);
    else ui.open.add(n);
    fill();
  }

  const expandAll = button('Expand all', () => {
    ui.open = expandToLevel(doc, Infinity);
    fill();
  });
  const collapseAll = button('Collapse all', () => {
    ui.open = new Set();
    fill();
  });

  const table = el(
    'table',
    { class: 'grid rml-grid', 'aria-label': 'Material nodes' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Node / property'), el('th', {}, 'Type'), el('th', {}, 'Value'))),
    tbody,
  );
  fill();

  return el(
    'div',
    { class: 'view rml-view' },
    el('div', { class: 'toolbar' }, expandAll, collapseAll),
    el('div', { class: 'grid-wrap' }, table),
    el('div', { class: 'meta-row' }, summary, el('span', { class: 'spacer' }), status),
  );
}
