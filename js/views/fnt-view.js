// Bitmap font (.fnt) view: the desktop FntFileEditor, read-only. Its info line (path, size, FTDF, font name) sits over
// the header, glyph table and codepoint report; a loose file that isn't FTDF gets the desktop's warning (app.js).
import { el } from '../ui.js';
import { baseName } from '../util.js';
import { fntInfo, buildFntReport, tryParseFtdf } from '../formats/fnt.js';

export function renderFnt(node) {
  const font = tryParseFtdf(node.payload);
  const label = node.parent ? `${baseName(node.parent.name)} → ${node.name}` : node.name;
  return el(
    'div',
    { class: 'view fnt-view' },
    el('div', { class: 'meta-row' }, el('span', { class: 'fnt-info' }, fntInfo(label, node.payload, font))),
    el('pre', { class: 'hex', tabindex: '0', 'aria-label': 'Font report' }, buildFntReport(node.payload, font)),
  );
}
