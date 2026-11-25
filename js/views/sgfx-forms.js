// The movie editor's field forms: one per tag type, built from a list of field specs. A form edits a fresh copy of the
// tag's fields; each change calls io.commit(), which encodes them into the tag's bytes (false when they don't fit, and
// the change is taken back). Fields that can be left out have a tick box; bytes the editor doesn't take apart (shape
// edges, clip actions, glyphs) are shown with their size.
import { el, button, toast, openDialog } from '../ui.js';
import { fontLayout, toHex, fromHex, FILTER_NAMES } from '../formats/swf-tags.js';
import { actionBlocksOfTag, replaceActionBlock } from '../formats/avm1.js';

// ---------- the action seam ----------

/**
 * The editor of a DoAction / DoInitAction body (AVM1 bytecode). This one shows the bytes and edits them as hex; an
 * ActionScript p-code editor can take its place with the same arguments. onChange(newBytes) puts new bytes in the tag.
 */
export function renderActionEditor(container, bytes, onChange) {
  container.replaceChildren(
    el('div', { class: 'meta-row' }, el('span', { class: 'muted small' }, `${bytes.length} bytes of ActionScript 1/2 bytecode`), el('span', { class: 'spacer' }), button('Edit as hex…', async () => {
      const next = await editHex(`Actions (${bytes.length} bytes)`, bytes);
      if (next) onChange(next);
    })),
    hexBlock(bytes),
  );
}

let actionEditor = renderActionEditor;
/** Puts another action editor (same arguments as renderActionEditor) in the forms; null goes back to the hex one. */
export function setActionEditor(fn) {
  actionEditor = fn ?? renderActionEditor;
}

// ---------- shared pieces ----------

/** A hex dump (offset, bytes, text) of the first `limit` bytes, with a button for the rest. */
export function hexBlock(u8, limit = 1024) {
  const pre = el('pre', { class: 'sgfx-hex' });
  const draw = (n) => {
    const lines = [];
    for (let i = 0; i < Math.min(n, u8.length); i += 16) {
      const row = u8.subarray(i, Math.min(i + 16, u8.length));
      const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0')).join(' ');
      const text = Array.from(row, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
      lines.push(`${i.toString(16).padStart(6, '0')}  ${hex.padEnd(48)}  ${text}`);
    }
    pre.textContent = lines.join('\n') || '(no bytes)';
  };
  draw(limit);
  if (u8.length <= limit) return pre;
  const more = button(`Show all ${u8.length} bytes`, () => {
    draw(Math.min(u8.length, 1 << 20));
    more.remove();
  }, { class: 'btn btn-sm' });
  return el('div', {}, pre, u8.length > 1 << 20 ? el('p', { class: 'muted small' }, 'Over 1 MB: Export .bin shows the rest.') : null, more);
}

/** A dialog that edits bytes as hex. Resolves to the new bytes, or null. */
export function editHex(title, bytes, note = null) {
  if (bytes.length > 512 * 1024) {
    toast('Over 512 KB: export the bytes as .bin, change them in a hex editor and import them back.', 'error');
    return Promise.resolve(null);
  }
  return openDialog((dlg, done) => {
    dlg.classList.add('dialog-wide');
    const ta = el('textarea', { class: 'input sgfx-hex-input', spellcheck: 'false', rows: 14, autofocus: true });
    ta.value = toHex(bytes);
    const err = el('p', { class: 'muted small' }, 'Hex digits; spaces, new lines and 0x are ignored.');
    const ok = () => {
      try {
        done(fromHex(ta.value));
      } catch (e) {
        err.textContent = e.message;
        err.className = 'banner banner-error';
      }
    };
    dlg.append(el('h2', { class: 'dialog-title' }, title), note ? el('p', { class: 'dialog-text' }, note) : null, ta, err, el('div', { class: 'dialog-actions' }, button('Cancel', () => done(null)), button('OK', ok, { class: 'btn btn-primary' })));
  });
}

const hex2 = (v) => v.toString(16).padStart(2, '0');
const colorHex = (c) => `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`;
export const colorText = (c) => (c.length === 4 && c[3] !== 255 ? `${colorHex(c)} α${c[3]}` : colorHex(c));

// ---------- field specs ----------

const RANGES = { u8: [0, 0xff], u16: [0, 0xffff], s16: [-0x8000, 0x7fff], u32: [0, 0xffffffff], twips: [-(2 ** 30), 2 ** 30 - 1], char: [0, 0xffff], int: [-(2 ** 31), 2 ** 31 - 1] };

const rectSpecs = [
  { k: 'xMin', l: 'Left', t: 'twips' },
  { k: 'xMax', l: 'Right', t: 'twips' },
  { k: 'yMin', l: 'Top', t: 'twips' },
  { k: 'yMax', l: 'Bottom', t: 'twips' },
];
const rect = (k, l) => ({ k, l, t: 'obj', specs: rectSpecs, sum: (r) => `${(r.xMax - r.xMin) / 20} × ${(r.yMax - r.yMin) / 20} px at ${r.xMin / 20}, ${r.yMin / 20}` });

const matrixSpecs = [
  { k: 'scale', l: 'Scale', t: 'obj', opt: () => ({ nbits: null, x: 65536, y: 65536 }), specs: [{ k: 'x', l: 'X', t: 'fixed16' }, { k: 'y', l: 'Y', t: 'fixed16' }] },
  { k: 'rotate', l: 'Rotate / skew', t: 'obj', opt: () => ({ nbits: null, r0: 0, r1: 0 }), specs: [{ k: 'r0', l: 'Skew 0', t: 'fixed16' }, { k: 'r1', l: 'Skew 1', t: 'fixed16' }] },
  { k: 'tx', l: 'Move X', t: 'twips' },
  { k: 'ty', l: 'Move Y', t: 'twips' },
];
const matrixSum = (m) => {
  const parts = [];
  if (m.scale) parts.push(`scale ${+(m.scale.x / 65536).toFixed(4)}, ${+(m.scale.y / 65536).toFixed(4)}`);
  if (m.rotate) parts.push(`skew ${+(m.rotate.r0 / 65536).toFixed(4)}, ${+(m.rotate.r1 / 65536).toFixed(4)}`);
  parts.push(`at ${m.tx / 20}, ${m.ty / 20} px`);
  return parts.join(' · ');
};
const matrix = (k, l, opt = false) => ({ k, l, t: 'obj', specs: matrixSpecs, sum: matrixSum, opt: opt ? () => ({ scale: null, rotate: null, translateBits: 0, tx: 0, ty: 0 }) : null });

const cxSpecs = (n) => [
  { k: 'mult', l: 'Multiply (256 = ×1)', t: 'ints', n, opt: () => Array(n).fill(256) },
  { k: 'add', l: 'Add', t: 'ints', n, opt: () => Array(n).fill(0) },
];
const cxform = (k, l, n, opt = false) => ({ k, l, t: 'obj', specs: cxSpecs(n), opt: opt ? () => ({ nbits: null, mult: null, add: null }) : null, sum: (c) => [c.mult && `× ${c.mult.join(', ')}`, c.add && `+ ${c.add.join(', ')}`].filter(Boolean).join(' · ') || 'no change' });

const BLEND = [[0, 'Normal (0)'], [1, 'Normal'], [2, 'Layer'], [3, 'Multiply'], [4, 'Screen'], [5, 'Lighten'], [6, 'Darken'], [7, 'Difference'], [8, 'Add'], [9, 'Subtract'], [10, 'Invert'], [11, 'Alpha'], [12, 'Erase'], [13, 'Overlay'], [14, 'Hard light']];
const FILL_TYPES = { 0x00: 'Solid colour', 0x10: 'Linear gradient', 0x12: 'Radial gradient', 0x13: 'Focal radial gradient', 0x40: 'Repeating bitmap', 0x41: 'Clipped bitmap', 0x42: 'Repeating bitmap, not smoothed', 0x43: 'Clipped bitmap, not smoothed' };

function fillSpecs(f, alpha, morph) {
  const col = alpha || morph ? 'rgba' : 'rgb';
  const specs = [{ k: 'type', l: 'Type', t: 'enum', ro: true, options: Object.entries(FILL_TYPES).map(([v, l]) => [+v, l]) }];
  if (f.type === 0x00) {
    specs.push({ k: 'color', l: morph ? 'Start colour' : 'Colour', t: col });
    if (morph) specs.push({ k: 'endColor', l: 'End colour', t: 'rgba' });
  } else if (f.gradient) {
    specs.push(matrix('matrix', morph ? 'Start gradient matrix' : 'Gradient matrix'));
    if (morph) specs.push(matrix('endMatrix', 'End gradient matrix'));
    specs.push({
      k: 'gradient', l: 'Gradient', t: 'obj', specs: [
        { k: 'spread', l: 'Spread', t: 'enum', options: [[0, 'Pad'], [1, 'Reflect'], [2, 'Repeat'], [3, 'Reserved (3)']] },
        { k: 'interpolation', l: 'Interpolation', t: 'enum', options: [[0, 'Normal RGB'], [1, 'Linear RGB'], [2, 'Reserved (2)'], [3, 'Reserved (3)']] },
        {
          k: 'records', l: 'Colours', t: 'list', max: 15, table: true,
          item: morph ? [{ k: 'ratio', l: 'Start ratio', t: 'u8' }, { k: 'color', l: 'Start colour', t: 'rgba' }, { k: 'endRatio', l: 'End ratio', t: 'u8' }, { k: 'endColor', l: 'End colour', t: 'rgba' }] : [{ k: 'ratio', l: 'Ratio', t: 'u8' }, { k: 'color', l: 'Colour', t: col }],
          add: (list) => {
            const last = list.at(-1);
            return morph ? { ratio: 255, color: last?.color ?? [0, 0, 0, 255], endRatio: 255, endColor: last?.endColor ?? [0, 0, 0, 255] } : { ratio: 255, color: last?.color ?? (col === 'rgba' ? [0, 0, 0, 255] : [0, 0, 0]) };
          },
        },
        ...(f.type === 0x13 ? [{ k: 'focal', l: 'Focal point (256 = 1)', t: 's16' }, ...(morph ? [{ k: 'endFocal', l: 'End focal point', t: 's16' }] : [])] : []),
      ],
    });
  } else {
    specs.push({ k: 'bitmapId', l: 'Bitmap id', t: 'char' });
    specs.push(matrix('matrix', morph ? 'Start bitmap matrix' : 'Bitmap matrix'));
    if (morph) specs.push(matrix('endMatrix', 'End bitmap matrix'));
  }
  return specs;
}
const fillSum = (f) => (f.type === 0 ? `${FILL_TYPES[0]} ${colorText(f.color)}` : f.gradient ? `${FILL_TYPES[f.type]}, ${f.gradient.records.length} colours` : `${FILL_TYPES[f.type] ?? 'Fill'} of ${f.bitmapId}`);

function lineSpecs(l, alpha, morph, style2) {
  const specs = [{ k: 'width', l: morph ? 'Start width (twips)' : 'Width (twips)', t: 'u16' }];
  if (morph) specs.push({ k: 'endWidth', l: 'End width (twips)', t: 'u16' });
  if (style2) {
    const caps = [[0, 'Round'], [1, 'None'], [2, 'Square'], [3, 'Reserved (3)']];
    specs.push(
      { k: 'startCap', l: 'Start cap', t: 'enum', options: caps },
      { k: 'endCap', l: 'End cap', t: 'enum', options: caps },
      { k: 'join', l: 'Join', t: 'enum', options: [[0, 'Round'], [1, 'Bevel'], [2, 'Miter'], [3, 'Reserved (3)']], redraw: true },
      { k: 'miter', l: 'Miter limit (256 = 1)', t: 'u16', show: (x) => x.join === 2 },
      { k: 'noHScale', l: 'No horizontal scaling', t: 'bit' },
      { k: 'noVScale', l: 'No vertical scaling', t: 'bit' },
      { k: 'pixelHinting', l: 'Pixel hinting', t: 'bit' },
      { k: 'noClose', l: 'Don’t close', t: 'bit' },
    );
    if (l.fill) specs.push({ k: 'fill', l: 'Fill', t: 'obj', specs: (x) => fillSpecs(x, true, morph), sum: fillSum });
    else specs.push({ k: 'color', l: morph ? 'Start colour' : 'Colour', t: 'rgba' }, ...(morph ? [{ k: 'endColor', l: 'End colour', t: 'rgba' }] : []));
  } else {
    specs.push({ k: 'color', l: morph ? 'Start colour' : 'Colour', t: alpha || morph ? 'rgba' : 'rgb' });
    if (morph) specs.push({ k: 'endColor', l: 'End colour', t: 'rgba' });
  }
  return specs;
}
const lineSum = (l) => `${l.width / 20} px${l.color ? ` ${colorText(l.color)}` : l.fill ? `, ${fillSum(l.fill)}` : ''}`;

function styleSpecs(alpha, morph, style2) {
  return [
    { k: 'fills', l: 'Fill styles', t: 'list', fixed: true, itemSpecs: (f) => fillSpecs(f, alpha, morph), itemSum: fillSum, itemLabel: (i) => `Fill ${i + 1}` },
    { k: 'lines', l: 'Line styles', t: 'list', fixed: true, itemSpecs: (l) => lineSpecs(l, alpha, morph, style2), itemSum: lineSum, itemLabel: (i) => `Line ${i + 1}` },
  ];
}

const placeSpecs = (code) => [
  { k: 'move', l: 'Changes what is at this depth (Move)', t: 'bool' },
  { k: 'depth', l: 'Depth', t: 'u16' },
  ...(code === 70 ? [{ k: 'className', l: 'Class name', t: 'str', opt: () => '' }, { k: 'hasImage', l: 'Has image', t: 'bool' }] : []),
  { k: 'characterId', l: 'Character id', t: 'char', opt: () => 1 },
  matrix('matrix', 'Matrix', true),
  cxform('cxform', 'Colour transform', 4, true),
  { k: 'ratio', l: 'Ratio (morph position)', t: 'u16', opt: () => 0 },
  { k: 'name', l: 'Instance name', t: 'str', opt: () => '' },
  { k: 'clipDepth', l: 'Clip depth (masks up to)', t: 'u16', opt: () => 0 },
  ...(code === 70
    ? [
        { k: 'filters', l: 'Filters', t: 'filters' },
        { k: 'blendMode', l: 'Blend mode', t: 'enum', options: BLEND, opt: () => 1 },
        { k: 'bitmapCache', l: 'Cache as bitmap', t: 'u8', opt: () => 1 },
        { k: 'visible', l: 'Visible', t: 'u8', opt: () => 1 },
        { k: 'background', l: 'Opaque background', t: 'rgba', opt: () => [0, 0, 0, 255] },
        { k: 'reserved', l: 'Reserved flag', t: 'bool' },
      ]
    : []),
  { k: 'clipActions', l: 'Clip actions', t: 'actionList', code: 26, prefix: [0x80, 0, 0], removable: true },
];

const symbolList = (l) => ({ k: 'symbols', l, t: 'list', table: true, item: [{ k: 'id', l: 'Id', t: 'char' }, { k: 'name', l: 'Name', t: 'str' }], add: (list) => ({ id: list.at(-1)?.id ?? 1, name: '' }) });

/** The field specs of a tag type, or null when it has none. */
export function specsFor(code, f) {
  switch (code) {
    case 2:
    case 22:
    case 32:
    case 83: {
      const v = { 2: 1, 22: 2, 32: 3, 83: 4 }[code];
      return [
        { k: 'id', l: 'Character id', t: 'u16' },
        rect('bounds', 'Bounds'),
        ...(v === 4 ? [rect('edgeBounds', 'Edge bounds'), { k: 'flags', l: 'Flags', t: 'bits', bits: [[4, 'Fill winding rule'], [2, 'Has non-scaling strokes'], [1, 'Has scaling strokes']] }] : []),
        ...styleSpecs(v >= 3, false, v === 4),
        { k: 'records', l: 'Edges (shape records)', t: 'bytes' },
      ];
    }
    case 46:
    case 84:
      return [
        { k: 'id', l: 'Character id', t: 'u16' },
        rect('startBounds', 'Start bounds'),
        rect('endBounds', 'End bounds'),
        ...(code === 84 ? [rect('startEdgeBounds', 'Start edge bounds'), rect('endEdgeBounds', 'End edge bounds'), { k: 'flags', l: 'Flags', t: 'bits', bits: [[2, 'Has non-scaling strokes'], [1, 'Has scaling strokes']] }] : []),
        ...styleSpecs(true, true, code === 84),
        { k: 'startEdges', l: 'Start edges', t: 'bytes' },
        { k: 'endEdges', l: 'End edges', t: 'bytes' },
      ];
    case 4:
      return [{ k: 'characterId', l: 'Character id', t: 'char' }, { k: 'depth', l: 'Depth', t: 'u16' }, matrix('matrix', 'Matrix'), cxform('cxform', 'Colour transform', 3, true)];
    case 5:
      return [{ k: 'characterId', l: 'Character id', t: 'char' }, { k: 'depth', l: 'Depth', t: 'u16' }];
    case 9:
      return [{ k: 'color', l: 'Background colour', t: 'rgb' }];
    case 12:
      return [{ k: 'actions', l: 'Actions', t: 'actions' }];
    case 59:
      return [{ k: 'spriteId', l: 'Sprite id', t: 'char' }, { k: 'actions', l: 'Actions', t: 'actions' }];
    case 26:
    case 70:
      return placeSpecs(code);
    case 28:
      return [{ k: 'depth', l: 'Depth', t: 'u16' }];
    case 34:
      return [
        { k: 'id', l: 'Character id', t: 'u16' },
        { k: 'flags', l: 'Flags', t: 'bits', bits: [[1, 'Track as menu']] },
        {
          k: 'records', l: 'Button records', t: 'list', fixed: true, itemLabel: (i) => `Record ${i + 1}`,
          itemSum: (r) => `${['up', 'over', 'down', 'hit'].filter((_, i) => r.flags & (1 << i)).join(', ') || 'no state'}: ${r.characterId} at depth ${r.depth}`,
          itemSpecs: () => [
            { k: 'flags', l: 'States', t: 'bits', bits: [[1, 'Up'], [2, 'Over'], [4, 'Down'], [8, 'Hit test']] },
            { k: 'characterId', l: 'Character id', t: 'char' },
            { k: 'depth', l: 'Depth', t: 'u16' },
            matrix('matrix', 'Matrix'),
            cxform('cxform', 'Colour transform', 4),
            { k: 'filters', l: 'Filters', t: 'filters' },
            { k: 'blendMode', l: 'Blend mode', t: 'enum', options: BLEND, opt: () => 1 },
          ],
        },
        { k: 'actions', l: 'Condition actions', t: 'actionList', code: 34, prefix: [0, 0, 0, 2, 0] },
      ];
    case 37:
      return [
        { k: 'id', l: 'Character id', t: 'u16' },
        rect('bounds', 'Bounds'),
        { k: 'variableName', l: 'Variable name', t: 'str' },
        { k: 'text', l: 'Initial text', t: 'text', opt: () => '' },
        { k: 'html', l: 'HTML text', t: 'bool' },
        { k: 'fontId', l: 'Font id', t: 'char', opt: (o) => ((o.fontHeight ??= 240), 1) },
        { k: 'fontClass', l: 'Font class', t: 'str', opt: (o) => ((o.fontHeight ??= 240), '') },
        { k: 'fontHeight', l: 'Font height (twips)', t: 'u16', show: (o) => o.fontId != null || o.fontClass != null },
        { k: 'color', l: 'Text colour', t: 'rgba', opt: () => [0, 0, 0, 255] },
        { k: 'maxLength', l: 'Max length', t: 'u16', opt: () => 0 },
        {
          k: 'layout', l: 'Layout', t: 'obj', opt: () => ({ align: 0, leftMargin: 0, rightMargin: 0, indent: 0, leading: 0 }),
          sum: (o) => ['left', 'right', 'center', 'justify'][o.align] ?? `align ${o.align}`,
          specs: [
            { k: 'align', l: 'Align', t: 'enum', options: [[0, 'Left'], [1, 'Right'], [2, 'Center'], [3, 'Justify']] },
            { k: 'leftMargin', l: 'Left margin (twips)', t: 'u16' },
            { k: 'rightMargin', l: 'Right margin (twips)', t: 'u16' },
            { k: 'indent', l: 'Indent (twips)', t: 'u16' },
            { k: 'leading', l: 'Leading (twips)', t: 's16' },
          ],
        },
        { k: 'wordWrap', l: 'Word wrap', t: 'bool' },
        { k: 'multiline', l: 'Multiline', t: 'bool' },
        { k: 'password', l: 'Password', t: 'bool' },
        { k: 'readOnly', l: 'Read only', t: 'bool' },
        { k: 'autoSize', l: 'Auto size', t: 'bool' },
        { k: 'noSelect', l: 'Not selectable', t: 'bool' },
        { k: 'border', l: 'Border', t: 'bool' },
        { k: 'wasStatic', l: 'Was static text', t: 'bool' },
        { k: 'useOutlines', l: 'Use outlines', t: 'bool' },
      ];
    case 43:
      return [{ k: 'name', l: 'Label', t: 'str' }, { k: 'anchor', l: 'Named anchor', t: 'u8', opt: () => 1 }];
    case 48:
    case 75:
      return [
        { k: 'id', l: 'Font id', t: 'u16' },
        { k: 'name', l: 'Font name', t: 'str' },
        { k: 'flags', l: 'Flags', t: 'bits', bits: [[0x80, 'Has layout', true], [0x40, 'Shift-JIS'], [0x20, 'Small text'], [0x10, 'ANSI'], [0x08, 'Wide offsets', true], [0x04, 'Wide codes', true], [0x02, 'Italic'], [0x01, 'Bold']] },
        { k: 'language', l: 'Language code', t: 'u8' },
        { k: 'glyphs', l: 'Glyphs', t: 'font' },
      ];
    case 56:
      return [symbolList('Exported names')];
    case 57:
      return [{ k: 'url', l: 'From movie', t: 'str' }, symbolList('Imported names')];
    case 71:
      return [{ k: 'url', l: 'From movie', t: 'str' }, symbolList('Imported names'), { k: 'reserved', l: 'Reserved bytes', t: 'ints', n: 2, ro: false, range: [0, 255] }];
    case 69:
      return [
        { k: 'flags', l: 'Flags', t: 'bits', bits: [[0x40, 'Use direct blit'], [0x20, 'Use GPU'], [0x10, 'Has metadata'], [0x08, 'ActionScript 3'], [0x04, 'No cross-domain cache'], [0x01, 'Use network'], [0x80, 'Reserved 0x80'], [0x02, 'Reserved 0x02']] },
        { k: 'reserved', l: 'Reserved', t: 'bytes' },
      ];
    case 74:
      return [
        { k: 'textId', l: 'Text id', t: 'char' },
        { k: 'useFlashType', l: 'Renderer', t: 'enum', options: [[0, 'Normal'], [1, 'Advanced (FlashType)'], [2, 'Reserved (2)'], [3, 'Reserved (3)']] },
        { k: 'gridFit', l: 'Grid fit', t: 'enum', options: [[0, 'None'], [1, 'Pixel'], [2, 'Sub-pixel'], [3, '3'], [4, '4'], [5, '5'], [6, '6'], [7, '7']] },
        { k: 'thickness', l: 'Thickness', t: 'f32' },
        { k: 'sharpness', l: 'Sharpness', t: 'f32' },
        { k: 'reservedBits', l: 'Reserved bits', t: 'int', range: [0, 7] },
        { k: 'reserved', l: 'Reserved byte', t: 'u8' },
      ];
    case 76:
      return [symbolList('Classes')];
    case 77:
      return [{ k: 'xml', l: 'Metadata (XML)', t: 'text' }];
    case 78:
      return [{ k: 'characterId', l: 'Character id', t: 'char' }, rect('splitter', '9-slice grid')];
    case 88:
      return [{ k: 'fontId', l: 'Font id', t: 'char' }, { k: 'name', l: 'Name', t: 'str' }, { k: 'copyright', l: 'Copyright', t: 'str' }];
    case 1000:
      return [
        { k: 'version', l: 'Exporter version', t: 'u16', hex: true, redraw: true },
        { k: 'flags', l: 'Flags', t: 'u32', hex: true, show: (o) => o.version >= 0x10a },
        { k: 'bitmapFormat', l: 'Bitmap format', t: 'u16' },
        { k: 'prefix', l: 'Prefix', t: 'pstr' },
        { k: 'swfName', l: 'SWF name', t: 'pstr' },
        { k: 'codeOffsets', l: 'Code offsets', t: 'list', table: true, item: [{ k: 'v', l: 'Offset', t: 'u32' }], scalar: true, add: () => 0 },
      ];
    case 1001:
      return [{ k: 'id', l: 'Character id', t: 'u16' }, { k: 'format', l: 'Format', t: 'u16' }, { k: 'width', l: 'Width', t: 'u16' }, { k: 'height', l: 'Height', t: 'u16' }, { k: 'file', l: 'File name', t: 'pstr' }];
    case 1008:
      return [{ k: 'id', l: 'Character id', t: 'u16' }, { k: 'imageId', l: 'Image id', t: 'char' }, { k: 'x1', l: 'Left', t: 'u16' }, { k: 'y1', l: 'Top', t: 'u16' }, { k: 'x2', l: 'Right', t: 'u16' }, { k: 'y2', l: 'Bottom', t: 'u16' }];
    case 1009:
      return [
        { k: 'id', l: 'Character id', t: 'u16' },
        { k: 'idType', l: 'Id type', t: 'u16' },
        { k: 'format', l: 'Format', t: 'enum', options: [[0, 'Default (0)'], [1, 'TGA (1)'], [2, 'DDS (2)'], [3, '3'], [4, '4'], [5, '5'], [6, '6'], [7, '7'], [8, '8'], [9, '9'], [10, '10'], [11, '11'], [12, '12'], [13, 'DDS (13)'], [14, '14']], free: true },
        { k: 'width', l: 'Width', t: 'u16' },
        { k: 'height', l: 'Height', t: 'u16' },
        { k: 'exportName', l: 'Export name', t: 'pstr' },
        { k: 'file', l: 'File name', t: 'pstr' },
      ];
    case 39:
      return [{ k: 'id', l: 'Sprite id', t: 'u16' }, { k: 'frameCount', l: 'Frame count', t: 'u16' }];
    default:
      return null;
  }
}

// ---------- the form ----------

/**
 * Draws the fields of `obj` (a tag's fields) into a new element. io: {commit() → bool, redraw(), charInfo(id) → text,
 * goto(id), actions(container, bytes, onChange)}.
 */
export function fieldsForm(specs, obj, io) {
  const host = el('div', { class: 'sgfx-form' });
  addFields(host, specs, obj, io);
  if (obj.extra?.length) host.append(row('Bytes after the fields', bytesInfo(obj.extra, null)));
  return host;
}

function addFields(host, specs, obj, io) {
  for (const s of typeof specs === 'function' ? specs(obj) : specs) {
    if (s.show && !s.show(obj)) continue;
    host.append(field(s, obj, io));
  }
}

const row = (label, control, title = null) => el('div', { class: 'sgfx-field' }, el('span', { class: 'sgfx-label', title }, label), el('div', { class: 'sgfx-control' }, control));

/** Sets obj[k] and encodes; on failure puts the old value back. */
function setValue(obj, k, v, io) {
  const old = obj[k];
  obj[k] = v;
  if (io.commit()) return true;
  obj[k] = old;
  return false;
}

function field(s, obj, io) {
  const v = obj[s.k];
  // Optional fields: a tick box that adds or drops them.
  if (s.opt && s.t !== 'bytes' && s.t !== 'filters') {
    const box = el('input', { type: 'checkbox', checked: v != null, 'aria-label': `Has ${s.l}` });
    box.addEventListener('change', () => {
      if (setValue(obj, s.k, box.checked ? s.opt(obj) : null, io)) io.redraw();
      else box.checked = obj[s.k] != null;
    });
    const label = el('label', { class: 'sgfx-label sgfx-opt' }, box, ` ${s.l}`);
    if (v == null) return el('div', { class: 'sgfx-field' }, label, el('div', { class: 'sgfx-control muted small' }, '(not set)'));
    return el('div', { class: 'sgfx-field' }, label, el('div', { class: 'sgfx-control' }, control(s, obj, io)));
  }
  if (s.t === 'obj' || s.t === 'list') return control(s, obj, io);
  return row(s.l, control(s, obj, io));
}

/** A number typed as decimal or 0x hex (NaN for anything else, empty included). */
const parseNumber = (text) => (text === '' ? NaN : /^-0x/i.test(text) ? -Number(text.slice(1)) : Number(text));

function numberInput(s, obj, io, { get = (x) => x, put = (x) => x } = {}) {
  const [min, max] = s.range ?? RANGES[s.t] ?? RANGES.int;
  const shown = (x) => (s.hex ? `0x${x.toString(16)}` : String(get(x)));
  const input = el('input', { type: 'text', class: 'input sgfx-num', inputmode: 'decimal', value: shown(obj[s.k]), spellcheck: 'false', 'aria-label': s.l, disabled: s.ro });
  input.addEventListener('change', () => {
    const text = input.value.trim();
    const n = put(parseNumber(text));
    if (!Number.isInteger(n) || n < min || n > max) {
      toast(`${s.l}: ${text} is not a whole number from ${min} to ${max}`, 'error');
      input.value = shown(obj[s.k]);
      return;
    }
    if (!setValue(obj, s.k, n, io)) input.value = shown(obj[s.k]);
    else if (s.redraw) io.redraw();
    else input.value = shown(obj[s.k]);
  });
  return input;
}

function colorControl(s, obj, io) {
  const c = obj[s.k];
  const pick = el('input', { type: 'color', value: colorHex(c), 'aria-label': s.l });
  const alpha = c.length === 4 ? el('input', { type: 'text', class: 'input sgfx-num sgfx-alpha', value: String(c[3]), title: 'Alpha, 0 (clear) to 255 (solid)', 'aria-label': `${s.l} alpha` }) : null;
  const text = el('span', { class: 'muted small' }, colorText(c));
  const apply = () => {
    const h = pick.value;
    const next = [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    if (alpha) {
      const a = Number(alpha.value);
      if (!Number.isInteger(a) || a < 0 || a > 255) {
        toast(`${s.l}: alpha is 0 to 255`, 'error');
        alpha.value = String(obj[s.k][3]);
        return;
      }
      next.push(a);
    }
    if (setValue(obj, s.k, next, io)) text.textContent = colorText(next);
  };
  pick.addEventListener('change', apply);
  alpha?.addEventListener('change', apply);
  return el('span', { class: 'sgfx-inline' }, pick, alpha ? el('span', { class: 'muted small' }, 'α') : null, alpha, text);
}

function bytesInfo(u8, onRemove) {
  return el('details', { class: 'sgfx-bytes' }, el('summary', {}, `${u8.length} byte${u8.length === 1 ? '' : 's'}`, onRemove ? ' ' : null, onRemove ? button('Remove', (e) => (e.preventDefault(), onRemove()), { class: 'btn btn-sm btn-danger-quiet' }) : null), hexBlock(u8, 512));
}

/**
 * The action blocks inside a field that holds several (a place tag's clip actions, a DefineButton2's conditions): one
 * action editor per block, opened on demand. s.prefix is the bytes that make the field a tag body of type s.code for
 * actionBlocksOfTag; each edit finds the block again in the field as it is now, so the sizes after it stay right.
 */
function actionListControl(s, obj, io) {
  const v = obj[s.k];
  if (v == null || !v.length) return el('span', { class: 'muted small' }, '(none)');
  const pre = Uint8Array.from(s.prefix);
  const body = () => {
    const cur = obj[s.k];
    const b = new Uint8Array(pre.length + cur.length);
    b.set(pre);
    b.set(cur, pre.length);
    return b;
  };
  const version = io.version ?? 10;
  const remove = s.removable ? button('Remove', () => setValue(obj, s.k, null, io) && io.redraw(), { class: 'btn btn-sm btn-danger-quiet' }) : null;
  let blocks;
  try {
    blocks = actionBlocksOfTag(s.code, body(), version);
  } catch (e) {
    return el('span', { class: 'sgfx-inline' }, bytesInfo(v, null), el('span', { class: 'muted small' }, ` ${e.message}`), remove);
  }
  const editor = io.actions ?? actionEditor;
  const wrap = el('div', { class: 'sgfx-action-list' },
    el('div', { class: 'meta-row' }, el('span', { class: 'muted small' }, `${blocks.length} action block${blocks.length === 1 ? '' : 's'} · ${v.length} bytes`), el('span', { class: 'spacer' }), remove));
  blocks.forEach((blk, i) => {
    const box = el('div', { class: 'sgfx-actions' });
    const size = el('span', { class: 'muted small' }, ` · ${blk.length} bytes`);
    const det = el('details', { class: 'sgfx-action-block' }, el('summary', {}, blk.name, size), box);
    det.addEventListener('toggle', () => {
      if (!det.open || box.childNodes.length) return;
      const cur = body();
      const b = actionBlocksOfTag(s.code, cur, version)[i];
      editor(box, cur.slice(b.offset, b.offset + b.length), (next) => {
        let out;
        try {
          const now = body();
          out = replaceActionBlock(now, actionBlocksOfTag(s.code, now, version)[i], next).slice(pre.length);
        } catch (e) {
          toast(`That doesn’t fit: ${e.message}`, 'error');
          return io.redraw();
        }
        if (!setValue(obj, s.k, out, io) || editor === renderActionEditor) return io.redraw();
        size.textContent = ` · ${next.length} bytes`;
      });
    });
    wrap.append(det);
  });
  return wrap;
}

function control(s, obj, io) {
  const v = obj[s.k];
  switch (s.t) {
    case 'u8':
    case 'u16':
    case 's16':
    case 'u32':
    case 'int':
      return numberInput(s, obj, io);
    case 'twips': {
      const input = numberInput(s, obj, io);
      return el('span', { class: 'sgfx-inline' }, input, el('span', { class: 'muted small' }, `twips = ${v / 20} px`));
    }
    case 'char': {
      const input = numberInput(s, obj, io);
      const info = io.charInfo?.(v);
      return el('span', { class: 'sgfx-inline' }, input, info ? button(info, () => io.goto(obj[s.k]), { class: 'btn btn-sm btn-link', title: 'Go to the tag that defines it' }) : el('span', { class: 'muted small' }, v === 0xffff ? '(none)' : 'not defined in this movie'));
    }
    case 'fixed16':
      return el('span', { class: 'sgfx-inline' }, numberInput({ ...s, range: [-(2 ** 30), 2 ** 30 - 1] }, obj, io, { get: (x) => +(x / 65536).toFixed(6), put: (x) => Math.round(x * 65536), step: 0 }), el('span', { class: 'muted small' }, '1 = 100%'));
    case 'f32': {
      const input = el('input', { type: 'text', class: 'input sgfx-num', value: String(v), 'aria-label': s.l });
      input.addEventListener('change', () => {
        const n = Number(input.value);
        if (!Number.isFinite(n)) return (toast(`${s.l}: not a number`, 'error'), (input.value = String(obj[s.k])));
        if (!setValue(obj, s.k, Math.fround(n), io)) input.value = String(obj[s.k]);
      });
      return input;
    }
    case 'bool':
    case 'bit': {
      const box = el('input', { type: 'checkbox', checked: !!v, 'aria-label': s.l });
      box.addEventListener('change', () => {
        if (!setValue(obj, s.k, s.t === 'bit' ? (box.checked ? 1 : 0) : box.checked, io)) box.checked = !!obj[s.k];
      });
      return box;
    }
    case 'bits': {
      const wrap = el('span', { class: 'sgfx-bits' });
      for (const [mask, label, ro] of s.bits) {
        const box = el('input', { type: 'checkbox', checked: (v & mask) !== 0, disabled: ro, title: ro ? 'Changing this would break the bytes after it' : null });
        box.addEventListener('change', () => {
          if (!setValue(obj, s.k, box.checked ? obj[s.k] | mask : obj[s.k] & ~mask, io)) box.checked = (obj[s.k] & mask) !== 0;
        });
        wrap.append(el('label', { class: 'check' }, box, label));
      }
      const known = s.bits.reduce((m, b) => m | b[0], 0);
      if (v & ~known) wrap.append(el('span', { class: 'muted small' }, `other bits 0x${(v & ~known).toString(16)}`));
      return wrap;
    }
    case 'str':
    case 'pstr': {
      const input = el('input', { type: 'text', class: 'input sgfx-str', value: v, spellcheck: 'false', 'aria-label': s.l });
      input.addEventListener('change', () => {
        if (!setValue(obj, s.k, input.value, io)) input.value = obj[s.k];
      });
      return input;
    }
    case 'text': {
      const ta = el('textarea', { class: 'input sgfx-text', spellcheck: 'false', rows: Math.min(12, Math.max(2, String(v).split('\n').length + 1)), 'aria-label': s.l });
      ta.value = v;
      ta.addEventListener('change', () => {
        if (!setValue(obj, s.k, ta.value, io)) ta.value = obj[s.k];
      });
      return ta;
    }
    case 'rgb':
    case 'rgba':
      return colorControl(s, obj, io);
    case 'enum': {
      const opts = s.options.some(([x]) => x === v) ? s.options : [...s.options, [v, String(v)]];
      const sel = el('select', { class: 'input', disabled: s.ro, 'aria-label': s.l }, ...opts.map(([x, label]) => el('option', { value: String(x), selected: x === v }, label)));
      sel.addEventListener('change', () => {
        if (!setValue(obj, s.k, Number(sel.value), io)) sel.value = String(obj[s.k]);
        else if (s.redraw) io.redraw();
      });
      return sel;
    }
    case 'ints': {
      const wrap = el('span', { class: 'sgfx-inline' });
      const names = v.length === 2 ? ['', ''] : ['R', 'G', 'B', 'A'];
      v.forEach((x, i) => {
        const input = el('input', { type: 'text', class: 'input sgfx-num sgfx-small', value: String(x), 'aria-label': `${s.l} ${names[i] || i + 1}` });
        input.addEventListener('change', () => {
          const n = Number(input.value);
          const [min, max] = s.range ?? [-16384, 16383];
          if (!Number.isInteger(n) || n < min || n > max) {
            toast(`${s.l}: ${input.value} is not a whole number from ${min} to ${max}`, 'error');
            input.value = String(obj[s.k][i]);
            return;
          }
          const next = obj[s.k].slice();
          next[i] = n;
          if (!setValue(obj, s.k, next, io)) input.value = String(obj[s.k][i]);
        });
        wrap.append(names[i] ? el('span', { class: 'muted small' }, names[i]) : null, input);
      });
      return wrap;
    }
    case 'bytes':
      if (v == null) return el('span', { class: 'muted small' }, '(none)');
      return bytesInfo(v, null);
    case 'filters':
      if (v == null) return el('span', { class: 'muted small' }, '(none)');
      return el('span', { class: 'sgfx-inline' }, el('span', {}, `${v.kinds.join(', ')} (${v.bytes.length} bytes)`), button('Remove', () => setValue(obj, s.k, null, io) && io.redraw(), { class: 'btn btn-sm btn-danger-quiet' }));
    case 'actions': {
      const box = el('div', { class: 'sgfx-actions' });
      const editor = io.actions ?? actionEditor;
      // The hex editor shows the bytes, so it is drawn again; a p-code editor already shows its new block and keeps its
      // place (tab, caret). A change that doesn't fit is taken back and the editor is drawn again from the tag.
      editor(box, v, (next) => {
        if (!setValue(obj, s.k, next, io) || editor === renderActionEditor) io.redraw();
      });
      return box;
    }
    case 'actionList':
      return actionListControl(s, obj, io);
    case 'font':
      return fontControl(obj, io);
    case 'obj': {
      const fs = el('fieldset', { class: 'sgfx-group' }, el('legend', {}, s.l, s.sum ? el('span', { class: 'muted small' }, ` · ${s.sum(v)}`) : null));
      addFields(fs, s.specs, v, io);
      return fs;
    }
    case 'list':
      return listControl(s, obj, io);
    default:
      return el('span', { class: 'muted' }, String(v));
  }
}

/** Glyph table of DefineFont2 / 3: read-only, except ascent, descent and leading, which are patched in place. */
function fontControl(obj, io) {
  const lay = fontLayout(obj);
  if (!lay) return el('span', { class: 'muted small' }, `${obj.glyphs.length} bytes`);
  const out = el('div', { class: 'sgfx-form' }, row('Glyphs', el('span', {}, `${lay.glyphCount} glyphs, ${obj.glyphs.length} bytes (outlines are not editable here)`)));
  if (lay.chars) out.append(row('Characters', el('div', { class: 'sgfx-chars' }, lay.chars.length > 400 ? `${lay.chars.slice(0, 400)}…` : lay.chars)));
  if (lay.layoutAt >= 0) {
    for (const [k, label, off] of [['ascent', 'Ascent', 0], ['descent', 'Descent', 2], ['leading', 'Leading', 4]]) {
      const holder = { [k]: lay[k] };
      const input = numberInput({ k, l: label, t: 's16' }, holder, {
        commit: () => {
          const g = obj.glyphs.slice();
          const at = lay.layoutAt + off;
          g[at] = holder[k] & 0xff;
          g[at + 1] = (holder[k] >> 8) & 0xff;
          const old = obj.glyphs;
          obj.glyphs = g;
          if (io.commit()) return true;
          obj.glyphs = old;
          return false;
        },
      });
      out.append(row(`${label} (EM units)`, input));
    }
  }
  return out;
}

function listControl(s, obj, io) {
  const list = obj[s.k];
  const fs = el('fieldset', { class: 'sgfx-group' }, el('legend', {}, `${s.l} (${list?.length ?? 0})`));
  if (!list) return (fs.append(el('span', { class: 'muted small' }, '(none)')), fs);
  const change = (next) => setValue(obj, s.k, next, io) && io.redraw();
  const canAdd = s.add && !s.fixed && (!s.max || list.length < s.max);
  if (s.table) {
    const limit = io.listLimit?.(s.k) ?? 200;
    const table = el('table', { class: 'grid sgfx-list' }, el('thead', {}, el('tr', {}, el('th', { class: 'num' }, '#'), ...s.item.map((it) => el('th', {}, it.l)), el('th', {}, ''))));
    const tbody = el('tbody');
    list.slice(0, limit).forEach((item, i) => {
      // A list of plain values (code offsets) edits each value through a holder.
      const holder = s.scalar ? { v: item } : item;
      const rowIo = s.scalar
        ? { ...io, commit: () => { const next = list.slice(); next[i] = holder.v; const old = obj[s.k]; obj[s.k] = next; if (io.commit()) return true; obj[s.k] = old; holder.v = old[i]; return false; } }
        : io;
      tbody.append(
        el('tr', {}, el('td', { class: 'num muted' }, String(i)), ...s.item.map((it) => el('td', {}, control(it, holder, rowIo))), el('td', {}, s.fixed ? null : button('×', () => change(list.filter((_, j) => j !== i)), { class: 'btn btn-sm btn-danger-quiet', title: 'Remove this row' }))),
      );
    });
    table.append(tbody);
    fs.append(el('div', { class: 'sgfx-list-wrap' }, table));
    if (list.length > limit) fs.append(button(`Show all ${list.length}`, () => (io.setListLimit?.(s.k, list.length), io.redraw()), { class: 'btn btn-sm' }));
  } else {
    list.forEach((item, i) => {
      const sub = el('fieldset', { class: 'sgfx-group sgfx-item' }, el('legend', {}, s.itemLabel ? s.itemLabel(i) : `${i + 1}`, s.itemSum ? el('span', { class: 'muted small' }, ` · ${s.itemSum(item)}`) : null));
      addFields(sub, s.itemSpecs ? s.itemSpecs(item) : s.item, item, io);
      if (!s.fixed) sub.append(button('Remove', () => change(list.filter((_, j) => j !== i)), { class: 'btn btn-sm btn-danger-quiet' }));
      fs.append(sub);
    });
  }
  if (canAdd) fs.append(button('Add', () => change([...list, s.add(list)]), { class: 'btn btn-sm' }));
  return fs;
}

export { FILTER_NAMES };
