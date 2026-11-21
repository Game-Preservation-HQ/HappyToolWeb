// Find a feature (Ctrl+K): a search over every button, switch and field on the page, labelled with the section it
// sits in and its tooltip, plus the shortcuts of the view that is open. Typing filters; Enter or a click runs a button
// or switch, or takes you to a field and highlights it.
import { el, toast } from './ui.js';

/** The open view's own commands (its keyboard shortcuts), as a function so they follow the view's state. */
let viewCommands = null;
/** The app's own commands that have no button (Back). */
let appCommands = null;

/** @param {(() => ({label: string, keys?: string, hint?: string, section?: string, run: () => void}[] | null)) | null} fn */
export function setViewCommands(fn) {
  viewCommands = fn;
}
export function setAppCommands(fn) {
  appCommands = fn;
}

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const hasWord = (s) => /[\p{L}\p{N}]/u.test(s || '');

/** What a control is called: its text, its label, or its aria-label, title or placeholder. */
function labelOf(c) {
  if (c.tagName === 'BUTTON' || c.tagName === 'SUMMARY') {
    // A tile's name and note are separate spans; its icon's badge text is not part of the name.
    const parts = [...c.childNodes]
      .filter((n) => !(n.nodeType === 1 && (n.classList.contains('icon') || n.getAttribute('aria-hidden') === 'true')))
      .map((n) => clean(n.textContent))
      .filter(hasWord);
    const text = parts.join(' · ');
    return hasWord(text) ? text : clean(c.getAttribute('aria-label') || c.title);
  }
  const own = c.closest('label');
  const text = own ? clean(own.textContent) : '';
  if (hasWord(text) && c.tagName === 'INPUT' && (c.type === 'checkbox' || c.type === 'radio')) return text;
  return clean(c.getAttribute('aria-label') || text || c.placeholder || c.title);
}

/** The heading a control sits under: the nearest h2/h3/h4 before it in its section, else the bar or panel it is in. */
function sectionOf(c) {
  if (c.closest('.topbar')) return 'Top bar';
  if (c.closest('#infobar')) return 'File';
  if (c.closest('#crumbs')) return 'Location';
  if (c.closest('.sidebar, #side-tree')) return 'Files';
  for (let n = c; n && n.id !== 'view'; n = n.parentElement) {
    for (let p = n.previousElementSibling; p; p = p.previousElementSibling) {
      if (/^H[2-4]$/.test(p.tagName)) return clean(p.textContent);
      const inner = p.querySelector?.('h2, h3, h4');
      if (inner && p.tagName !== 'ASIDE') break;
    }
    if (n.classList?.contains('toolbar') && n.parentElement?.classList.contains('view')) return 'Toolbar';
  }
  return c.closest('.folder-view') ? 'In this folder' : 'Page';
}

/** Every visible button, switch and field on the page outside dialogs. */
function pageControls() {
  const out = [];
  const roots = [document.querySelector('.topbar'), document.getElementById('infobar'), document.getElementById('crumbs'), document.getElementById('view')];
  for (const root of roots) {
    if (!root || root.hidden) continue;
    for (const c of root.querySelectorAll('button, select, input, textarea, summary')) {
      if (c.type === 'hidden' || c.type === 'file' || c.closest('[hidden], dialog') || !c.getClientRects().length) continue;
      if (c.id === 'btn-find') continue;
      const label = labelOf(c);
      if (!label) continue;
      const kind = c.tagName === 'BUTTON' || c.tagName === 'SUMMARY' ? 'button' : c.type === 'checkbox' || c.type === 'radio' ? 'switch' : 'field';
      const on = kind === 'switch' ? c.checked : c.getAttribute('aria-pressed') === 'true' ? true : null;
      out.push({
        label,
        section: sectionOf(c),
        hint: clean(c.title || c.closest('label')?.title || ''),
        kind,
        state: on === true ? 'on' : kind === 'switch' ? 'off' : '',
        disabled: c.disabled,
        target: c,
      });
    }
  }
  return out;
}

function allItems() {
  const list = [];
  const add = (fn, kind) => {
    let got = null;
    try {
      got = fn?.();
    } catch (e) {
      console.warn(`Find a feature: ${e.message}`);
    }
    for (const c of got || []) list.push({ section: 'Shortcuts', hint: '', ...c, kind });
  };
  add(viewCommands, 'command');
  list.push(...pageControls());
  add(appCommands, 'command');
  return list;
}

/** Items whose words all appear, best first: label starts with the query, then a word of the label, then anywhere. */
function rank(items, query) {
  const q = query.toLowerCase().trim();
  if (!q) return items;
  const words = q.split(/\s+/);
  const scored = [];
  items.forEach((it, i) => {
    const label = it.label.toLowerCase();
    const all = `${label} ${it.section} ${it.keys || ''} ${it.hint}`.toLowerCase();
    if (!words.every((w) => all.includes(w))) return;
    const score = label.startsWith(q) ? 0 : label.includes(q) ? 1 : words.every((w) => label.includes(w)) ? 2 : 3;
    scored.push([score, i, it]);
  });
  return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((s) => s[2]);
}

function flash(c) {
  c.classList.remove('palette-flash');
  void c.offsetWidth;
  c.classList.add('palette-flash');
  setTimeout(() => c.classList.remove('palette-flash'), 1600);
}

function runItem(it) {
  if (it.kind === 'command') return it.run();
  const c = it.target;
  if (!c.isConnected) return toast('That control is gone (the page changed).');
  c.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  flash(c.closest('label') || c);
  if (it.disabled) return toast(`${it.label} is not available right now.${it.hint ? ` ${it.hint}` : ''}`);
  if (it.kind === 'field') return c.focus();
  c.click();
}

let open = null;

/** Opens Find a feature, or focuses it when it is open. */
export function openPalette() {
  if (open) return open.querySelector('input')?.focus();
  const items = allItems();
  const input = el('input', {
    type: 'search',
    class: 'input',
    placeholder: 'Find a feature, menu or shortcut…',
    'aria-label': 'Find a feature',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-controls': 'palette-list',
  });
  const list = el('ul', { class: 'palette-list', id: 'palette-list', role: 'listbox' });
  const count = el('p', { class: 'muted small palette-count' });
  const dlg = el('dialog', { class: 'dialog palette', 'aria-label': 'Find a feature' }, input, list, count);
  let shown = [], at = 0;
  const close = () => {
    dlg.close();
    dlg.remove();
    open = null;
  };
  const choose = (it) => {
    close();
    setTimeout(() => runItem(it), 0);
  };
  const paint = () => {
    shown = rank(items, input.value).slice(0, 80);
    at = Math.min(at, Math.max(0, shown.length - 1));
    list.replaceChildren(
      ...shown.map((it, i) =>
        el(
          'li',
          {
            class: `palette-item${i === at ? ' active' : ''}${it.disabled ? ' disabled' : ''}`,
            role: 'option',
            'aria-selected': String(i === at),
            onclick: () => choose(it),
            onmousemove: () => {
              if (at !== i) {
                at = i;
                mark();
              }
            },
          },
          el(
            'div',
            { class: 'palette-line' },
            el('span', { class: 'palette-label' }, it.label),
            it.state ? el('span', { class: `palette-state ${it.state}` }, it.state) : null,
            el('span', { class: 'palette-section muted' }, it.section),
            it.keys ? el('kbd', {}, it.keys) : null,
          ),
          it.hint ? el('div', { class: 'palette-hint muted small' }, it.hint) : null,
        ),
      ),
    );
    count.textContent = shown.length
      ? `${shown.length === 80 ? 'First 80 of many' : shown.length} · ↑↓ to move, Enter to use, Esc to close`
      : 'Nothing matches. Open a file or the map viewer to find its tools.';
  };
  const mark = () => {
    [...list.children].forEach((li, i) => {
      li.classList.toggle('active', i === at);
      li.setAttribute('aria-selected', String(i === at));
    });
    list.children[at]?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => {
    at = 0;
    paint();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shown.length) return;
      at = (at + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      mark();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[at]) choose(shown[at]);
    }
  });
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  dlg.addEventListener('click', (e) => e.target === dlg && close());
  document.body.append(dlg);
  open = dlg;
  paint();
  dlg.showModal();
  input.focus();
}
