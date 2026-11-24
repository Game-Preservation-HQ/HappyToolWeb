// Scaleform movie (.sgfx / .gfx, CFX / GFX) and plain .swf (CWS / FWS) view, read-only. The info line and the download
// sit over what the movie exports and imports, the image files its Scaleform tags name and its top-level tag list.
import { el, button, toast } from '../ui.js';
import { baseName, formatSize, downloadBytes } from '../util.js';
import { readMovieInfo, sgfxToSwf, swfToSgfx, swfNameForEntry, sgfxNameForSwf, sgfxConverts } from '../formats/sgfx.js';

const table = (head, rows) =>
  el(
    'div',
    { class: 'grid-wrap sgfx-table' },
    el(
      'table',
      { class: 'grid' },
      el('thead', {}, el('tr', {}, ...head.map(([label, num]) => el('th', num ? { class: 'num' } : {}, label)))),
      el('tbody', {}, ...rows.map((cells) => el('tr', {}, ...cells.map((c, i) => el('td', head[i][1] ? { class: 'num' } : head[i][2] ? { class: 'name' } : {}, c))))),
    ),
  );

function downloadButton(node) {
  if (sgfxConverts(node.payload))
    return button('Download as .swf', () => downloadBytes(sgfxToSwf(node.payload), swfNameForEntry(node.name)), {
      title: 'The same bytes with CWS / FWS as the first three letters, as the desktop’s Export SWF… writes them',
    });
  return button('Download as .sgfx', () => {
    try {
      downloadBytes(swfToSgfx(node.payload), sgfxNameForSwf(node.name));
    } catch (e) {
      toast(e.message, 'error');
    }
  }, { title: 'The same bytes with CFX (zlib) or GFX (uncompressed) as the first three letters' });
}

function body(node, ctx, info) {
  const label = node.parent ? `${baseName(node.parent.name)} → ${node.name}` : node.name;
  const kind = `${info.signature} (${info.compressed ? 'zlib' : 'uncompressed'})`;
  const line = `${label} · ${kind} · SWF ${info.version} · ${formatSize(info.length)} unpacked · ${info.width} × ${info.height} px · ${info.frameRate} fps · ${info.frameCount} frame${info.frameCount === 1 ? '' : 's'} · ${info.tags.length} tags`;
  const out = [
    el('div', { class: 'meta-row' }, el('span', { class: 'sgfx-info' }, line), downloadButton(node)),
    el('p', { class: 'note' }, 'JPEXS FFDec opens the downloaded .swf.'),
  ];
  if (info.problem) out.push(el('div', { class: 'banner banner-warn' }, info.problem));
  const sections = [];
  if (info.exporter)
    sections.push(el('p', { class: 'muted small' }, `Exported by Scaleform ${info.exporter.version} as ${info.exporter.swfName || '(no name)'}, bitmap format ${info.exporter.bitmapFormat}.`));
  // An external image's file is usually an entry of the same bundle: offer to open it.
  const siblings = node.parent?.model?.entries ?? [];
  const sibling = (file) => siblings.findIndex((e) => !e.pointer && e.name.toLowerCase() === String(file).toLowerCase());
  if (info.files.length) {
    sections.push(el('h3', {}, `External files (${info.files.length})`));
    sections.push(
      table([['Tag'], ['Id', true], ['File', false, true], ['Size'], ['Export name'], ['']], info.files.map((f) => {
        const i = ctx.openSibling ? sibling(f.file) : -1;
        return [f.tag, f.id ?? '', f.file, f.width != null ? `${f.width} × ${f.height}` : '', f.exportName ?? '', i >= 0 ? button('Open', () => ctx.openSibling(i), { title: `Open ${f.file} from this bundle` }) : ''];
      })),
    );
  }
  if (info.exports.length) {
    sections.push(el('h3', {}, `Exported names (${info.exports.length})`));
    sections.push(table([['Id', true], ['Name', false, true]], info.exports.map((e) => [e.id, e.name])));
  }
  if (info.imports.length) {
    sections.push(el('h3', {}, `Imports (${info.imports.length})`));
    sections.push(table([['From', false, true], ['Id', true], ['Name', false, true]], info.imports.flatMap((m) => m.symbols.map((s) => [m.url, s.id, s.name]))));
  }
  sections.push(el('h3', {}, `Tags (${info.tags.length})`));
  sections.push(table([['#', true], ['Code', true], ['Name'], ['Offset', true], ['Length', true]], info.tags.map((t, i) => [i, t.code, t.name, t.offset, t.length])));
  out.push(el('div', { class: 'sgfx-body' }, ...sections));
  return out;
}

export function renderSgfx(node, ctx) {
  const view = el('div', { class: 'view sgfx-view' }, el('div', { class: 'busy' }, el('div', { class: 'spinner' }), 'Reading the movie…'));
  node.movieInfo ??= readMovieInfo(node.payload).then((info) => ({ info }), (e) => ({ error: e.message }));
  node.movieInfo.then((r) =>
    view.replaceChildren(...(r.info ? body(node, ctx, r.info) : [el('div', { class: 'banner banner-error' }, `This movie can't be read: ${r.error}`), el('div', { class: 'meta-row' }, downloadButton(node))])),
  );
  return view;
}
