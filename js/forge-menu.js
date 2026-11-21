// A menu over the map that works with a controller, the keyboard or the mouse, as the desktop's Forge menu does
// (GUI/Forge/ForgeMenu.cs): pages of rows, each row with its text, an optional value, a line describing it, and an
// action (A / Enter / click) or an adjustment (left / right). Controller: up / down move (first repeat after 0.38 s,
// then every 0.075 s), A picks, left / right change a value, B goes back a page (closes from the first), Menu or View
// closes. Keyboard: arrows, Enter or Space, Esc or Backspace.
//
// A page is {title, status?: () => string, items: () => rows}; a row is {text, value?: () => string, desc?,
// activate?: () => void, adjust?: (dir) => void, enabled?: () => boolean, header?: true}.

import { el } from './ui.js';
import { takePad, PAD, DEAD } from './gamepad.js';

const NAV = 16000 / 32767; // the desktop's stick threshold for moving through the rows

export function forgeMenu(host, { onClose = null } = {}) {
  const titleEl = el('div', { class: 'forge-title' });
  const statusEl = el('div', { class: 'forge-status muted' });
  const list = el('div', { class: 'forge-rows', role: 'menu' });
  const descEl = el('div', { class: 'forge-desc muted' });
  const hintEl = el('div', { class: 'forge-hint muted' }, 'A / Enter: pick · ←/→: change · B / Esc: back · Menu: close');
  const box = el('div', { class: 'forge-menu', tabindex: '-1', hidden: true }, titleEl, statusEl, list, descEl, hintEl);
  host.append(box);
  const stack = []; // [{page, index}]
  let rows = [];
  let release = null;
  const due = new Map();

  const top = () => stack.at(-1);
  const usable = (r) => !!r && !r.header;
  const enabled = (r) => !r.enabled || r.enabled();

  function render() {
    const t = top();
    if (!t) return;
    rows = t.page.items().filter(Boolean);
    if (!usable(rows[t.index])) t.index = Math.max(0, rows.findIndex(usable));
    titleEl.textContent = t.page.title;
    const status = t.page.status?.() || '';
    statusEl.textContent = status;
    statusEl.hidden = !status;
    list.replaceChildren(
      ...rows.map((r, i) => {
        if (r.header) return el('div', { class: 'forge-head' }, r.text);
        const value = r.value?.();
        const row = el(
          'div',
          {
            class: `forge-row${i === t.index ? ' sel' : ''}${enabled(r) ? '' : ' off'}`,
            role: 'menuitem',
            'aria-disabled': String(!enabled(r)),
          },
          r.adjust ? el('button', { class: 'forge-arrow', tabindex: '-1', 'aria-label': 'Less', onclick: (e) => (e.stopPropagation(), pick(i), adjust(-1)) }, '‹') : null,
          el('span', { class: 'forge-text' }, r.text),
          value != null && value !== '' ? el('span', { class: 'forge-value' }, value) : null,
          r.adjust ? el('button', { class: 'forge-arrow', tabindex: '-1', 'aria-label': 'More', onclick: (e) => (e.stopPropagation(), pick(i), adjust(1)) }, '›') : null,
        );
        row.addEventListener('click', () => {
          pick(i);
          activate();
        });
        row.addEventListener('pointermove', () => t.index !== i && pick(i));
        return row;
      }),
    );
    descEl.textContent = rows[t.index]?.desc || '';
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }
  function pick(i) {
    const t = top();
    if (!t || !usable(rows[i])) return;
    t.index = i;
    render();
  }
  function move(dir) {
    const t = top();
    if (!t || !rows.length) return;
    let i = t.index;
    for (let k = 0; k < rows.length; k++) {
      i = (i + dir + rows.length) % rows.length;
      if (usable(rows[i])) break;
    }
    pick(i);
  }
  function activate() {
    const r = rows[top()?.index];
    if (!r || r.header || !enabled(r)) return;
    if (r.activate) r.activate();
    else if (r.adjust) r.adjust(1);
    if (stack.length) render();
  }
  function adjust(dir) {
    const r = rows[top()?.index];
    if (!r?.adjust || !enabled(r)) return;
    r.adjust(dir);
    if (stack.length) render();
  }
  /** True on the press, then after 0.38 s, then every 0.075 s while held (ForgeMenu's repeat). */
  function repeat(key, on) {
    const now = performance.now();
    if (!on) return due.delete(key), false;
    const t = due.get(key);
    if (t === undefined) return due.set(key, now + 380), true;
    if (now < t) return false;
    due.set(key, now + 75);
    return true;
  }
  function padUpdate(pad) {
    if (!stack.length) return false;
    if (pad.edge(PAD.MENU) || pad.edge(PAD.VIEW)) close();
    else if (pad.edge(PAD.B)) back();
    else if (pad.edge(PAD.A)) activate();
    else {
      const sy = pad.raw?.ly ?? pad.ly, sx = pad.raw?.lx ?? pad.lx;
      if (repeat('up', pad.held(PAD.UP) || sy > NAV)) move(-1);
      if (repeat('down', pad.held(PAD.DOWN) || sy < -NAV)) move(1);
      if (repeat('left', pad.held(PAD.LEFT) || sx < -Math.max(NAV, DEAD.left))) adjust(-1);
      if (repeat('right', pad.held(PAD.RIGHT) || sx > Math.max(NAV, DEAD.left))) adjust(1);
    }
    return true;
  }
  box.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowUp') move(-1);
    else if (k === 'ArrowDown') move(1);
    else if (k === 'ArrowLeft') adjust(-1);
    else if (k === 'ArrowRight') adjust(1);
    else if (k === 'Enter' || k === ' ') activate();
    else if (k === 'Escape' || k === 'Backspace') back();
    else if (k === 'Home') pick(rows.findIndex(usable));
    else if (k === 'End') pick(rows.findLastIndex(usable));
    else if (k === 'Tab') close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  function push(page) {
    stack.push({ page, index: 0 });
    if (!release) release = takePad(padUpdate);
    box.hidden = false;
    render();
    box.focus({ preventScroll: true });
  }
  function back() {
    stack.pop();
    if (!stack.length) return close();
    render();
  }
  function close() {
    if (box.hidden && !stack.length) return;
    stack.length = 0;
    due.clear();
    box.hidden = true;
    release?.();
    release = null;
    onClose?.();
  }
  return {
    /** Opens the menu at this page (its first page). */
    open(page) {
      stack.length = 0;
      push(page);
    },
    push,
    back,
    close,
    refresh: () => stack.length && render(),
    get isOpen() {
      return stack.length > 0;
    },
    dispose() {
      close();
      box.remove();
    },
  };
}
