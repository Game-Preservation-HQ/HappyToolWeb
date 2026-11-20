// Paged hex dump (16 bytes per row, 4 KB per page) with a jump-to-offset box.
import { el, button } from '../ui.js';

const PAGE = 4096;
const hex2 = (b) => b.toString(16).padStart(2, '0');

function dump(u8, start) {
  const lines = [];
  const end = Math.min(u8.length, start + PAGE);
  for (let off = start; off < end; off += 16) {
    let h = '';
    let a = '';
    for (let i = 0; i < 16; i++) {
      if (off + i < end) {
        const b = u8[off + i];
        h += hex2(b) + (i === 7 ? '  ' : ' ');
        a += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      } else h += i === 7 ? '    ' : '   ';
    }
    lines.push(`${off.toString(16).padStart(8, '0')}  ${h} ${a}`);
  }
  return lines.join('\n');
}

export function renderHex(node, ctx, note) {
  const u8 = node.payload;
  const pages = Math.max(1, Math.ceil(u8.length / PAGE));
  let page = 0;
  const pre = el('pre', { class: 'hex', tabindex: '0', 'aria-label': 'Hex dump' });
  const label = el('span', { class: 'muted' });
  const jump = el('input', { type: 'text', class: 'input input-sm', placeholder: 'Go to offset (hex)', 'aria-label': 'Go to offset in hex', spellcheck: 'false' });
  const show = () => {
    pre.textContent = u8.length ? dump(u8, page * PAGE) : '(empty)';
    label.textContent = `Page ${page + 1} of ${pages}`;
    prev.disabled = page === 0;
    next.disabled = page >= pages - 1;
  };
  const prev = button('‹ Prev', () => (page--, show()));
  const next = button('Next ›', () => (page++, show()));
  jump.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const off = parseInt(jump.value.replace(/^0x/i, ''), 16);
    if (Number.isFinite(off) && off >= 0 && off < u8.length) {
      page = Math.floor(off / PAGE);
      show();
    }
  });
  show();
  return el(
    'div',
    { class: 'view hex-view' },
    note ? el('p', { class: 'note' }, note) : null,
    el('div', { class: 'toolbar' }, prev, next, label, el('span', { class: 'spacer' }), jump),
    pre,
  );
}
