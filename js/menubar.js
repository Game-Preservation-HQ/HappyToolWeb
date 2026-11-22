// A menu bar (File, Edit, View…) and a right-click menu, as the desktop editors' menus. The editor keeps the focus
// (and its selection) while a menu is open: ↑ / ↓ move through it, Enter picks, Esc closes, ← / → go to the next menu
// of the bar. A controller reaches the items like any button.
// Items: {label, keys?, run, enabled?(), checked?()}, or null for a line between groups. `items` may be a function, so
// the labels and states are read when the menu opens.
import { el } from './ui.js';

let open = null; // the menu on screen: {pop, owner, close}

/** Closes the menu on screen, if any. */
export function closeMenu() {
  open?.close();
}

function show(items, x, y, { owner = null, keyboard = false, onSwitch = null, onClose = null } = {}) {
  closeMenu();
  const rows = []; // {b, item}
  const pop = el('div', { class: 'menu-pop', role: 'menu' });
  for (const item of typeof items === 'function' ? items() : items) {
    if (!item) {
      if (rows.length && !pop.lastChild?.classList.contains('menu-sep')) pop.append(el('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    const on = item.run && (!item.enabled || item.enabled() !== false);
    const checked = item.checked ? !!item.checked() : null;
    const i = rows.length;
    const b = el(
      'button',
      {
        type: 'button',
        class: 'menu-item',
        role: checked == null ? 'menuitem' : 'menuitemcheckbox',
        'aria-checked': checked == null ? null : String(checked),
        disabled: !on,
        onmousedown: (e) => e.preventDefault(), // the editor keeps its focus and selection
        onmousemove: () => setActive(i),
        onfocus: () => setActive(i),
        onclick: () => pick(i),
      },
      el('span', { class: 'menu-check', 'aria-hidden': 'true' }, checked ? '✓' : ''),
      el('span', { class: 'menu-label' }, item.label),
      el('span', { class: 'menu-keys' }, item.keys || ''),
    );
    rows.push({ b, item });
    pop.append(b);
  }
  if (pop.lastChild?.classList.contains('menu-sep')) pop.lastChild.remove();
  document.body.append(pop);
  // Inside the window: a bar's menu drops below its button, a right-click menu opens up when there's no room below.
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = `${Math.max(4, Math.min(x, innerWidth - w - 4))}px`;
  pop.style.top = `${Math.max(4, y + h > innerHeight - 4 ? (owner ? innerHeight - h - 4 : y - h) : y)}px`;

  let at = -1;
  function setActive(i) {
    if (rows[at]) rows[at].b.classList.remove('is-active');
    at = i;
    if (rows[at]) rows[at].b.classList.add('is-active');
  }
  function move(d) {
    for (let n = 0, i = at; n < rows.length; n++) {
      i = (i + d + rows.length) % rows.length;
      if (!rows[i].b.disabled) return setActive(i);
    }
  }
  if (keyboard) move(1);
  function pick(i) {
    const r = rows[i];
    if (!r || r.b.disabled) return;
    close();
    r.item.run();
  }
  function onKey(e) {
    const k = e.key;
    const take = () => (e.preventDefault(), e.stopPropagation());
    if (k === 'ArrowDown' || k === 'ArrowUp') return take(), move(k === 'ArrowDown' ? 1 : -1);
    if (k === 'Home' || k === 'End') return take(), setActive(-1), move(k === 'Home' ? 1 : -1);
    if (k === 'Enter' || k === ' ') return take(), at >= 0 ? pick(at) : close();
    if (k === 'Escape') return take(), close();
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && onSwitch) return take(), onSwitch(k === 'ArrowLeft' ? -1 : 1);
    if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta') return;
    close(); // any other key closes the menu and does its usual job
  }
  const outside = (e) => !pop.contains(e.target) && !owner?.contains(e.target) && close();
  const closeNow = () => close();
  function close() {
    if (open?.pop !== pop) return;
    open = null;
    pop.remove();
    removeEventListener('keydown', onKey, true);
    removeEventListener('pointerdown', outside, true);
    removeEventListener('wheel', outside, true);
    removeEventListener('resize', closeNow);
    removeEventListener('blur', closeNow);
    onClose?.();
  }
  addEventListener('keydown', onKey, true);
  addEventListener('pointerdown', outside, true);
  addEventListener('wheel', outside, true);
  addEventListener('resize', closeNow);
  addEventListener('blur', closeNow);
  open = { pop, owner, close };
}

/** A right-click menu at this point of the window (clientX/Y); `keyboard` highlights the first item. */
export function contextMenu(items, x, y, keyboard = false) {
  show(items, x, y, { keyboard });
}

/** A menu bar: [{label, items}]. Click (or Enter, ↓) opens a menu; while one is open, pointing at another opens it. */
export function menuBar(menus, label = 'Menu') {
  const bar = el('div', { class: 'menubar', role: 'menubar', 'aria-label': label });
  const buttons = menus.map((m, i) =>
    el(
      'button',
      {
        type: 'button',
        class: 'menubar-item',
        role: 'menuitem',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        onmousedown: (e) => e.preventDefault(),
        // detail 0: Enter, Space or a controller's A, so the first item lights up for the arrow keys
        onclick: (e) => (open?.owner === buttons[i] ? closeMenu() : openAt(i, e.detail === 0)),
        onmouseenter: () => open?.owner && open.owner !== buttons[i] && buttons.includes(open.owner) && openAt(i, false),
        onkeydown: (e) => e.key === 'ArrowDown' && (e.preventDefault(), openAt(i, true)),
      },
      m.label,
    ),
  );
  function openAt(i, keyboard) {
    const r = buttons[i].getBoundingClientRect();
    show(menus[i].items, r.left, r.bottom + 2, {
      owner: buttons[i],
      keyboard,
      onSwitch: (d) => openAt((i + d + menus.length) % menus.length, true),
      onClose: () => buttons[i].setAttribute('aria-expanded', 'false'),
    });
    buttons[i].setAttribute('aria-expanded', 'true');
  }
  bar.append(...buttons);
  return bar;
}
