// Resource descriptor (.vir) view: the desktop VirFileEditor, read-only. Its info line (path, size, TRF version) sits
// over the word-by-word report and hex dump; a file that isn't TRF gets the desktop's warning (app.js sets node.warning).
import { el } from '../ui.js';
import { baseName } from '../util.js';
import { virInfo, buildVirReport } from '../formats/vir.js';

export function renderVir(node) {
  const label = node.parent ? `${baseName(node.parent.name)} → ${node.name}` : node.name;
  return el(
    'div',
    { class: 'view vir-view' },
    el('div', { class: 'meta-row' }, el('span', { class: 'vir-info' }, virInfo(label, node.payload))),
    el('pre', { class: 'hex', tabindex: '0', 'aria-label': 'Descriptor report' }, buildVirReport(node.payload)),
  );
}
