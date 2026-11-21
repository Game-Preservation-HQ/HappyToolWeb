// Controller support, as the desktop HappyTool has it (Input/GamepadNavigationService.cs over XInput), through the
// browser's Gamepad API (standard mapping). A view can take the pad while it is in use (the map does, as the desktop's
// map editor does); everywhere else the pad moves around the page like the desktop's: the left stick or the D-pad are
// the arrow keys (first repeat after 400 ms, then every 95 ms), A clicks, B is Esc, X is Tab, Y is Shift+Tab, View goes
// back and Menu opens Find a feature.

/** Standard-mapping button numbers. */
export const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

/** The desktop's dead zones (XInput's 32767 / 255 scale) as fractions. */
export const DEAD = { left: 7849 / 32767, right: 8689 / 32767, nav: 12000 / 32767, trigger: 30 / 255 };

/** A stick value past its dead zone, scaled back to 0..1 (the desktop's Axis). */
export const axis = (v, dead) => (v > dead ? (v - dead) / (1 - dead) : v < -dead ? (v + dead) / (1 - dead) : 0);

const hosts = [];
let menu = null, running = false, last = 0, prev = 0;
const due = new Map(); // direction → next repeat time (ms)

/**
 * Lets a view take the pad. `handler(pad)` runs every frame with
 * `{ buttons, prev, held(b), edge(b), released(b), lx, ly, rx, ry, lt, rt, dt }` (sticks up and right positive,
 * dead zones applied) and returns true when it took the pad this frame. Returns the function that lets go.
 */
export function takePad(handler) {
  hosts.push(handler);
  return () => {
    const i = hosts.indexOf(handler);
    if (i >= 0) hosts.splice(i, 1);
  };
}

/** Starts listening for controllers; `onMenu` runs on the Menu button outside a view that took the pad. */
export function startGamepad({ onMenu = null } = {}) {
  menu = onMenu;
  if (!navigator.getGamepads) return;
  window.addEventListener('gamepadconnected', run);
  run();
}

function firstPad() {
  for (const p of navigator.getGamepads?.() || []) if (p && p.connected !== false) return p;
  return null;
}

function run() {
  if (running || !firstPad()) return;
  running = true;
  last = performance.now();
  prev = bitsOf(firstPad());
  requestAnimationFrame(poll);
}

function bitsOf(p) {
  let b = 0;
  p.buttons.forEach((x, i) => (x.pressed || x.value > 0.5) && i < 31 && (b |= 1 << i));
  return b;
}

function poll(now) {
  const p = firstPad();
  if (!p) {
    running = false;
    due.clear();
    return;
  }
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  const b = bitsOf(p), was = prev;
  prev = b;
  const ax = (i) => p.axes[i] || 0;
  const trig = (i) => {
    const v = p.buttons[i]?.value ?? 0;
    return v > DEAD.trigger ? v : 0;
  };
  const pad = {
    buttons: b,
    prev: was,
    held: (k) => (b & (1 << k)) !== 0,
    edge: (k) => (b & (1 << k)) !== 0 && (was & (1 << k)) === 0,
    released: (k) => (b & (1 << k)) === 0 && (was & (1 << k)) !== 0,
    lx: axis(ax(0), DEAD.left),
    ly: -axis(ax(1), DEAD.left),
    rx: axis(ax(2), DEAD.right),
    ry: -axis(ax(3), DEAD.right),
    lt: trig(PAD.LT),
    rt: trig(PAD.RT),
    dt,
    raw: { lx: ax(0), ly: -ax(1) },
  };
  let took = false;
  for (let i = hosts.length - 1; i >= 0 && !took; i--) {
    try {
      took = !!hosts[i](pad);
    } catch (e) {
      console.error(e);
    }
  }
  if (took) due.clear();
  else navigate(pad, now);
  requestAnimationFrame(poll);
}

/** True on the press, then after 400 ms, then every 95 ms while held (RepeatNavEdge). */
function repeat(dir, on, now) {
  if (!on) return due.delete(dir), false;
  const t = due.get(dir);
  if (t === undefined) return due.set(dir, now + 400), true;
  if (now < t) return false;
  due.set(dir, now + 95);
  return true;
}

const active = () => (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);
const typing = (e) => e && (e.isContentEditable || e.tagName === 'TEXTAREA' || (e.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(e.type)));

function navigate(pad, now) {
  const s = DEAD.nav, { lx, ly } = pad.raw;
  const dirs = {
    left: lx < -s || pad.held(PAD.LEFT),
    right: lx > s || pad.held(PAD.RIGHT),
    up: ly > s || pad.held(PAD.UP),
    down: ly < -s || pad.held(PAD.DOWN),
  };
  for (const [d, on] of Object.entries(dirs)) if (repeat(d, on, now)) arrow(d);
  if (pad.edge(PAD.VIEW)) return send(window, 'ArrowLeft', { altKey: true }); // the app's back (Alt+Left)
  if (pad.edge(PAD.MENU)) return menu?.();
  if (pad.edge(PAD.A)) press();
  if (pad.edge(PAD.B)) escape();
  if (pad.edge(PAD.X)) tab(1);
  if (pad.edge(PAD.Y)) tab(-1);
}

/** Sends a key down and up to `target`; true when something handled it (prevented the default). */
function send(target, key, mods = {}) {
  const down = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });
  const taken = !target.dispatchEvent(down);
  target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true, ...mods }));
  return taken;
}

function arrow(dir) {
  const key = { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown' }[dir];
  const t = active();
  if (send(t || document.body, key)) return;
  if (typing(t) && (t.tagName === 'TEXTAREA' || t.isContentEditable || dir === 'left' || dir === 'right')) return;
  // What the key would do by itself (a sent key does nothing on its own): step a list or a slider, else move focus.
  if (t?.tagName === 'SELECT' && (dir === 'up' || dir === 'down')) {
    const i = Math.max(0, Math.min(t.options.length - 1, t.selectedIndex + (dir === 'down' ? 1 : -1)));
    if (i !== t.selectedIndex) {
      t.selectedIndex = i;
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return;
  }
  if (t?.type === 'range' && (dir === 'left' || dir === 'right')) {
    dir === 'right' ? t.stepUp() : t.stepDown();
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  moveFocus(dir);
}

function press() {
  const t = active();
  if (!t) return moveFocus('down');
  if (typing(t) || t.tagName === 'SELECT') return send(t, 'Enter');
  t.click();
}

function escape() {
  const t = active();
  if (send(t || document.body, 'Escape')) return;
  const dlg = [...document.querySelectorAll('dialog[open]')].pop();
  if (dlg && dlg.dispatchEvent(new Event('cancel', { cancelable: true }))) dlg.close();
}

/** What the pad can move to: in the open dialog if there is one, shown and enabled. */
function focusables() {
  const root = [...document.querySelectorAll('dialog[open]')].pop() || document;
  return [...root.querySelectorAll('a[href], button, input, select, textarea, summary, canvas[tabindex], [tabindex]:not([tabindex="-1"])')].filter(
    (e) => !e.disabled && e.tabIndex >= 0 && e.getClientRects().length && !e.closest('[hidden], [inert]') && getComputedStyle(e).visibility !== 'hidden',
  );
}

function focus(e) {
  e.focus();
  e.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

function tab(dir) {
  const list = focusables();
  if (!list.length) return;
  const i = list.indexOf(active());
  focus(list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length]);
}

/** Moves focus to the nearest control on that side (straight ahead counts more than off to the side). */
function moveFocus(dir) {
  const list = focusables(), cur = active();
  if (!list.length) return;
  if (!cur || !list.includes(cur)) return focus(list[0]);
  const a = cur.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  const [dx, dy] = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir];
  let best = null, score = Infinity;
  for (const e of list) {
    if (e === cur) continue;
    const r = e.getBoundingClientRect(), x = r.left + r.width / 2 - ax, y = r.top + r.height / 2 - ay;
    const along = x * dx + y * dy;
    if (along <= 1) continue;
    const s = along + 2 * Math.abs(x * dy + y * dx);
    if (s < score) (score = s), (best = e);
  }
  if (best) focus(best);
}
