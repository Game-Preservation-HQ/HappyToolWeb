// Squirrel script (.nut) editor, a port of the desktop's script editor (GUI/SquirrelEditor*.cs,
// Controls/SquirrelCodeTextBox*.cs, Controls/CodeFindBar.cs, Controls/SquirrelScriptIndex.cs): highlighting in the
// desktop's colours, line numbers, brace matching, find and replace, go to line, comment toggle, auto-indent, code
// assist and call tips from the engine catalogue, the functions list, go to definition across the Data folder's
// scripts with back / forward (F12 or Ctrl+click), the engine toolbox, zoom, line-ending conversion, and the desktop's
// File / Edit / View / Navigate menus and right-click menu. The file keeps its encoding
// (most of the game's scripts are Shift-JIS) and line endings.
import { el, button, toast, ask, debounce } from '../ui.js';
import { lineEndings, restoreLineEndings, decodeText, encodeShiftJis } from '../util.js';
import { decodeLayers } from '../formats/wrappers.js';
import { tokenize, outline, lineIndex, wordAt, callAt, KEYWORDS } from '../formats/squirrel.js';
import { setViewCommands } from '../palette.js';
import { menuBar, contextMenu } from '../menubar.js';
import { textKeyAt } from '../formats/lng-refs.js';
import { showKeyReferences } from './lng-refs-dialog.js';

const INDENT = 4; // the desktop indents with 4 spaces
const ZOOM_KEY = 'happytool-web-nut-zoom';
const TOOLBOX_KEY = 'happytool-web-nut-toolbox';
const ZOOMS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];
const MAX_MATCHES = 20000;
const ASSIST_MAX = 200;
const HISTORY_MAX = 50;
const ENCODING_LABELS = { 'utf-8': 'UTF-8', 'utf-8-bom': 'UTF-8 with BOM', 'utf-16le-bom': 'UTF-16 LE', 'utf-16be-bom': 'UTF-16 BE', shift_jis: 'Shift-JIS' };
const KINDS = {
  N: ['E', 'Engine function'],
  K: ['K', 'Engine class'],
  C: ['C', 'Constant'],
  S: ['S', 'Script function'],
  G: ['G', 'Script global'],
  kw: ['k', 'Keyword'],
  here: ['ƒ', 'Defined in this script'],
  index: ['ƒ', 'Defined in another script'],
  id: ['·', 'Name used in this script'],
};
const TOOLBOX_GROUPS = [
  ['N', 'Engine functions'],
  ['C', 'Constants'],
  ['K', 'Engine classes'],
  ['S', 'Script functions'],
  ['G', 'Script globals'],
];
const SNIPPETS = [
  ['function', 'function name()\n{\n    \n}'],
  ['class', 'class Name\n{\n    constructor()\n    {\n    }\n}'],
  ['foreach', 'foreach (i, v in list)\n{\n    \n}'],
  ['for', 'for (local i = 0; i < n; i++)\n{\n    \n}'],
  ['if / else', 'if (condition)\n{\n    \n}\nelse\n{\n    \n}'],
];

// ---- the engine catalogue (generated from the desktop's SquirrelEngineCatalog.Data.cs) ----
let catalogue = null;
function loadCatalogue() {
  return (catalogue ??= import('../formats/squirrel-catalog.js').then(({ default: tsv }) => {
    const map = new Map();
    for (const line of tsv.split('\n')) {
      const [kind, name, group, uses, usualArgs, example, where, params] = line.split('\t');
      if (name && !map.has(name)) map.set(name, { kind, name, group, uses: +uses || 0, usualArgs: +usualArgs, example, where, params });
    }
    return map;
  }));
}
let cat = null; // the loaded catalogue, once ready
loadCatalogue().then((m) => (cat = m));

/** The argument names of a catalogue entry: its params, or those written in its example call. */
function argsOf(entry) {
  if (entry.params) return entry.params.split(/,\s*/);
  const m = /\((.*)\)\s*$/.exec(entry.example || '');
  if (!m || !m[1].trim()) return entry.usualArgs > 0 ? Array.from({ length: entry.usualArgs }, (_, i) => `arg${i + 1}`) : [];
  const out = [];
  let depth = 0, cur = '';
  for (const c of m[1]) {
    if (c === ',' && depth === 0) out.push(cur.trim()), (cur = '');
    else {
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      cur += c;
    }
  }
  out.push(cur.trim());
  return out.map((a, i) => (/^[A-Za-z_]\w*$/.test(a) ? a : `arg${i + 1}`));
}

// ---- the Data folder's script index (SquirrelScriptIndex): every .nut's definitions, built once in the background ----
let index = null; // {key, byName: Map(name → [{path, item}]), count, ready: Promise}
function scriptIndex(ctx, onProgress) {
  const list = ctx.scripts?.() || [];
  const key = list.map((r) => r.path).join('|');
  if (index?.key === key) return index;
  const byName = new Map();
  index = { key, byName, count: 0, total: list.length, done: false };
  const mine = index;
  mine.ready = (async () => {
    for (const r of list) {
      try {
        const u8 = await r.read();
        let payload = u8;
        try {
          payload = (await decodeLayers(u8)).payload;
        } catch {}
        const text = decodeText(payload).text;
        for (const item of outline(text)) {
          if (!byName.has(item.name)) byName.set(item.name, []);
          byName.get(item.name).push({ path: r.path, item });
        }
      } catch {}
      mine.count++;
      if (mine.count % 10 === 0 || mine.count === list.length) onProgress?.(mine);
    }
    mine.done = true;
    onProgress?.(mine);
  })();
  return mine;
}

// ---- back / forward through the places jumped from (50 each way, across scripts) ----
const history = { back: [], fwd: [] };

const esc = (s) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
const readJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (key, v) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
};

export function renderNut(node, ctx) {
  const model = node.model;
  let base = lineEndings(model.text);
  const ta = el('textarea', { class: 'nut-ta', spellcheck: 'false', wrap: 'off', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Script' });
  ta.value = base.plain.join('\n');
  const hl = el('pre', { class: 'nut-hl', 'aria-hidden': 'true' });
  const marks = el('pre', { class: 'nut-marks', 'aria-hidden': 'true' });
  const curLine = el('div', { class: 'nut-curline' });
  const layer = el('div', { class: 'nut-layer' }, curLine, marks, hl);
  const gutterPre = el('pre', { 'aria-hidden': 'true' });
  const gutter = el('div', { class: 'nut-gutter' }, gutterPre);
  const measure = el('span', { class: 'nut-measure', 'aria-hidden': 'true' });
  const area = el('div', { class: 'nut-area' }, layer, ta, measure);
  const assistBox = el('div', { class: 'nut-assist', role: 'listbox', hidden: true });
  const tip = el('div', { class: 'nut-tip', hidden: true });
  const code = el('div', { class: 'nut-code' }, gutter, area, assistBox, tip);

  // State from the last render
  let toks = [];
  let items = []; // outline of this script
  let lineOf = () => 0;
  let pairs = new Map(); // brace position → its partner
  let names = new Set(); // identifiers used here
  let lineCount = 0;
  let found = []; // find matches [[s, e]]
  let foundAt = -1;
  let message = '';
  let zoom = readJson(ZOOM_KEY, 100);

  // ---- status bar ----
  const msgEl = el('span', { class: 'nut-msg muted', 'aria-live': 'polite' });
  const posEl = el('span', { class: 'muted' });
  const linesEl = el('span', { class: 'muted' });
  const lossEl = el('span', { class: 'bad', hidden: true });
  const eolSel = el('select', { class: 'nut-select', title: 'Line endings: pick one to convert the whole script' }, el('option', { value: 'crlf' }, 'CRLF'), el('option', { value: 'lf' }, 'LF'), el('option', { value: 'mixed', disabled: true }, 'Mixed'));
  const zoomSel = el('select', { class: 'nut-select', title: 'Zoom (Ctrl+Plus, Ctrl+Minus, Ctrl+0, Ctrl+wheel)' }, ...ZOOMS.map((z) => el('option', { value: String(z) }, `${z}%`)));
  const statusBar = el(
    'div',
    { class: 'nut-status' },
    msgEl,
    el('span', { class: 'spacer' }),
    lossEl,
    posEl,
    linesEl,
    eolSel,
    el('span', { class: 'chip' }, ENCODING_LABELS[model.encoding] || model.encoding),
    zoomSel,
  );
  const say = (text, kind = 'muted') => {
    message = text;
    msgEl.textContent = text;
    msgEl.className = `nut-msg ${kind}`;
  };
  const showEol = () => {
    const crs = base.cr.slice(0, -1);
    eolSel.value = crs.some(Boolean) && !crs.every(Boolean) ? 'mixed' : base.any ? 'crlf' : 'lf';
  };
  eolSel.addEventListener('change', () => {
    const eol = eolSel.value === 'crlf' ? '\r\n' : '\n';
    model.text = ta.value.split('\n').join(eol);
    base = lineEndings(model.text);
    ctx.changed();
    showEol();
    say(`Line endings are now ${eol === '\n' ? 'LF' : 'CRLF'}.`);
  });
  const applyZoom = () => {
    const fs = Math.round(14 * zoom) / 100;
    code.style.fontSize = `${fs}px`;
    code.style.lineHeight = `${Math.round(fs * 1.45)}px`;
    zoomSel.value = String(zoom);
    if (![...zoomSel.options].some((o) => o.value === String(zoom))) zoomSel.append(el('option', { value: String(zoom) }, `${zoom}%`)), (zoomSel.value = String(zoom));
    writeJson(ZOOM_KEY, zoom);
    syncScroll();
  };
  const setZoom = (z) => {
    zoom = Math.min(400, Math.max(30, Math.round(z)));
    applyZoom();
  };
  zoomSel.addEventListener('change', () => setZoom(+zoomSel.value));
  code.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const i = ZOOMS.findIndex((z) => z >= zoom);
      setZoom(e.deltaY < 0 ? ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS[i] === zoom ? i + 1 : i)] : ZOOMS[Math.max(0, i - 1)]);
    },
    { passive: false },
  );

  // ---- rendering ----
  const lh = () => parseFloat(code.style.lineHeight) || 20;
  const PAD = 8; // matches .nut-ta padding-top
  function identClass(w) {
    const e = cat?.get(w);
    if (!e) return '';
    if (e.kind === 'N' || e.kind === 'K') return 'sq-engine';
    if (e.kind === 'C') return 'sq-const';
    return '';
  }
  function renderText() {
    const text = ta.value;
    toks = tokenize(text);
    items = outline(text, toks);
    lineOf = lineIndex(text);
    pairs = new Map();
    names = new Set();
    const open = [];
    const bad = new Set();
    for (const t of toks) {
      if (t.t === 'ident' && t.e - t.s >= 3) names.add(text.slice(t.s, t.e));
      if (t.t !== 'op') continue;
      const c = text[t.s];
      if (c === '{' || c === '(' || c === '[') open.push(t.s);
      else if (c === '}' || c === ')' || c === ']') {
        const o = open.at(-1);
        if (o !== undefined && text[o] === { '}': '{', ')': '(', ']': '[' }[c]) {
          open.pop();
          pairs.set(o, t.s).set(t.s, o);
        } else bad.add(t.s);
      }
    }
    for (const o of open) bad.add(o);
    let h = '';
    for (const t of toks) {
      const s = esc(text.slice(t.s, t.e));
      if (t.t === 'space') h += s;
      else if (t.t === 'op') h += bad.has(t.s) ? `<span class="sq-bad">${s}</span>` : s;
      else if (t.t === 'ident') {
        const k = identClass(text.slice(t.s, t.e));
        h += k ? `<span class="${k}">${s}</span>` : s;
      } else h += `<span class="sq-${t.t}">${s}</span>`;
    }
    hl.innerHTML = h + '\n';
    const n = text.split('\n').length;
    if (n !== lineCount) {
      lineCount = n;
      gutterPre.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n') + '\n';
      linesEl.textContent = `${n.toLocaleString()} lines`;
    }
    fillFunctions();
    if (findBar.hidden === false) refreshFind(false);
    else renderMarks();
  }
  let renderQueued = false;
  const renderSoon = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderText();
      updateCaret();
    });
  };
  function syncScroll() {
    layer.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
    gutterPre.style.transform = `translateY(${-ta.scrollTop}px)`;
    if (!assistBox.hidden || !tip.hidden) placePopups();
  }
  ta.addEventListener('scroll', syncScroll);

  /** Background marks: find matches, other copies of the selected word, the brace pair at the caret. */
  function renderMarks() {
    const text = ta.value;
    const ranges = [];
    found.forEach(([s, e], i) => ranges.push([s, e, i === foundAt ? 'm-cur' : 'm-find']));
    const { selectionStart: a, selectionEnd: b } = ta;
    if (b > a && b - a <= 80) {
      const w = text.slice(a, b);
      if (/^[A-Za-z_]\w*$/.test(w)) {
        const re = new RegExp(`\\b${w}\\b`, 'g');
        let m, k = 0;
        while ((m = re.exec(text)) && k++ < 2000) if (m.index !== a) ranges.push([m.index, m.index + w.length, 'm-word']);
      }
    }
    for (const p of [a - 1, a]) {
      if (pairs.has(p) && a === b) {
        ranges.push([p, p + 1, 'm-brace'], [pairs.get(p), pairs.get(p) + 1, 'm-brace']);
        break;
      }
    }
    ranges.sort((x, y) => x[0] - y[0]);
    let h = '', at = 0;
    for (const [s, e, c] of ranges) {
      if (s < at) continue;
      h += esc(text.slice(at, s)) + `<mark class="${c}">${esc(text.slice(s, e))}</mark>`;
      at = e;
    }
    marks.innerHTML = ranges.length ? h + esc(text.slice(at)) + '\n' : '';
  }

  // ---- caret ----
  const lineStart = (pos) => ta.value.lastIndexOf('\n', pos - 1) + 1;
  const lineEnd = (pos) => {
    const i = ta.value.indexOf('\n', pos);
    return i < 0 ? ta.value.length : i;
  };
  function caretXY(pos) {
    const ls = lineStart(pos);
    measure.textContent = ta.value.slice(ls, pos);
    return { x: measure.offsetWidth + 12, y: PAD + lineOf(pos) * lh() };
  }
  function updateCaret() {
    const { selectionStart: a, selectionEnd: b } = ta;
    const line = lineOf(b);
    const col = b - lineStart(b) + 1;
    posEl.textContent = `Ln ${line + 1}, Col ${col}${b !== a ? ` (${Math.abs(b - a).toLocaleString()} selected)` : ''}`;
    curLine.style.top = `${PAD + line * lh()}px`;
    curLine.style.height = `${lh()}px`;
    curLine.hidden = a !== b;
    renderMarks();
    syncFunction(line);
    updateTip();
    node.nutUi = { a, b, top: ta.scrollTop, left: ta.scrollLeft };
  }
  let caretQueued = false;
  const caretSoon = () => {
    if (caretQueued) return;
    caretQueued = true;
    requestAnimationFrame(() => ((caretQueued = false), updateCaret()));
  };
  document.addEventListener('selectionchange', () => document.activeElement === ta && caretSoon());
  /** Selects [s, e) and scrolls it into view, a third down from the top when it was off screen. */
  function select(s, e = s, focus = true) {
    if (focus) ta.focus({ preventScroll: true });
    ta.setSelectionRange(s, e);
    const y = PAD + lineOf(s) * lh();
    if (y < ta.scrollTop || y + lh() > ta.scrollTop + ta.clientHeight) ta.scrollTop = Math.max(0, y - ta.clientHeight / 3);
    const { x } = caretXY(s);
    if (x < ta.scrollLeft + 40 || x > ta.scrollLeft + ta.clientWidth - 40) ta.scrollLeft = Math.max(0, x - ta.clientWidth / 2);
    syncScroll();
    caretSoon();
  }
  const gotoLine = (line, name) => {
    const lines = ta.value.split('\n');
    line = Math.max(0, Math.min(lines.length - 1, line));
    let s = 0;
    for (let i = 0; i < line; i++) s += lines[i].length + 1;
    const k = name ? lines[line].search(new RegExp(`\\b${name}\\b`)) : -1;
    if (k >= 0) select(s + k, s + k + name.length);
    else select(s + (lines[line].length - lines[line].trimStart().length));
  };

  // ---- editing (through execCommand, so the browser's own undo keeps every step) ----
  function edit(s, e, str, selS, selE) {
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(s, e);
    const ok = str ? document.execCommand('insertText', false, str) : s === e || document.execCommand('delete');
    if (!ok) {
      ta.setRangeText(str, s, e, 'end');
      ta.dispatchEvent(new Event('input'));
    }
    if (selS != null) ta.setSelectionRange(selS, selE ?? selS);
  }
  const indentOf = (line) => /^[ \t]*/.exec(line)[0];
  const colOf = (s) => {
    let c = 0;
    for (const ch of s) c = ch === '\t' ? c + INDENT - (c % INDENT) : c + 1;
    return c;
  };
  /** Indents (dir 1) or outdents (dir -1) every line the selection touches. */
  function shiftLines(dir) {
    const { selectionStart: a, selectionEnd: b } = ta;
    const s = lineStart(a);
    const e = lineEnd(b > a && ta.value[b - 1] === '\n' ? b - 1 : b);
    const lines = ta.value.slice(s, e).split('\n');
    const out = lines.map((l) => {
      if (dir > 0) return l.trim() ? ' '.repeat(INDENT) + l : l;
      const m = /^( {1,4}|\t)/.exec(l);
      return m ? l.slice(m[0].length) : l;
    });
    const text = out.join('\n');
    edit(s, e, text, s, s + text.length);
  }
  /** Ctrl+/: comments out the selected lines with //, or removes it when every one has it. */
  function toggleComment() {
    const { selectionStart: a, selectionEnd: b } = ta;
    const s = lineStart(a);
    const e = lineEnd(b > a && ta.value[b - 1] === '\n' ? b - 1 : b);
    const lines = ta.value.slice(s, e).split('\n');
    const used = lines.filter((l) => l.trim());
    if (!used.length) return;
    const all = used.every((l) => /^\s*\/\//.test(l));
    let out;
    if (all) out = lines.map((l) => l.replace(/^(\s*)\/\/ ?/, '$1'));
    else {
      const min = Math.min(...used.map((l) => indentOf(l).length));
      out = lines.map((l) => (l.trim() ? l.slice(0, min) + '// ' + l.slice(min) : l));
    }
    const text = out.join('\n');
    edit(s, e, text, s, s + text.length);
  }
  function newLine() {
    const { selectionStart: a, selectionEnd: b } = ta;
    const ls = lineStart(a);
    const before = ta.value.slice(ls, a);
    let ind = indentOf(before);
    const opens = /\{\s*$/.test(before);
    const closes = /^\s*\}/.test(ta.value.slice(b, lineEnd(b)));
    if (opens) {
      const inner = ind + ' '.repeat(INDENT);
      if (closes) return edit(a, b, '\n' + inner + '\n' + ind, a + 1 + inner.length);
      ind = inner;
    }
    edit(a, b, '\n' + ind);
  }
  /** Typing } on a line of only spaces lines it up with its {. */
  function closeBrace() {
    const { selectionStart: a, selectionEnd: b } = ta;
    const ls = lineStart(a);
    if (a !== b || ta.value.slice(ls, a).trim()) return false;
    let depth = 0, want = null;
    for (let k = toks.length - 1; k >= 0; k--) {
      const t = toks[k];
      if (t.s >= a || t.t !== 'op') continue;
      const c = ta.value[t.s];
      if (c === '}') depth++;
      else if (c === '{' && depth-- === 0) {
        want = indentOf(ta.value.slice(lineStart(t.s), t.s));
        break;
      }
    }
    if (want == null) return false;
    edit(ls, a, want + '}');
    return true;
  }
  function insertTab() {
    const { selectionStart: a, selectionEnd: b } = ta;
    const col = colOf(ta.value.slice(lineStart(a), a));
    edit(a, b, ' '.repeat(INDENT - (col % INDENT)));
  }

  // ---- find and replace (CodeFindBar) ----
  const findIn = el('input', { class: 'nut-find-in', placeholder: 'Find', 'aria-label': 'Find', spellcheck: 'false' });
  const replIn = el('input', { class: 'nut-find-in', placeholder: 'Replace', 'aria-label': 'Replace with', spellcheck: 'false' });
  const toggle = (label, title) => {
    const b = button(label, () => {
      b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
      refreshFind(true);
      findIn.focus();
    }, { class: 'btn nut-toggle', title, 'aria-pressed': 'false' });
    return b;
  };
  const caseBtn = toggle('Aa', 'Match case (Alt+C)');
  const wordBtn = toggle('ab', 'Whole word (Alt+W)');
  const regexBtn = toggle('.*', 'Regular expression (Alt+R)');
  const countEl = el('span', { class: 'nut-count muted' });
  const replRow = el('div', { class: 'nut-find-row', hidden: true }, replIn, button('Replace', () => replaceOne(), { title: 'Replace this match (Enter in the Replace box)' }), button('Replace all', () => replaceAll(), { title: 'Replace every match, as one undo step (Ctrl+Alt+Enter)' }));
  const findBar = el(
    'div',
    { class: 'nut-find', hidden: true },
    el('div', { class: 'nut-find-row' }, findIn, caseBtn, wordBtn, regexBtn, countEl, button('↑', () => step(-1), { title: 'Previous match (Shift+F3, Shift+Enter)' }), button('↓', () => step(1), { title: 'Next match (F3, Enter)' }), button('×', () => closeFind(), { title: 'Close (Esc)' })),
    replRow,
  );
  const on = (b) => b.getAttribute('aria-pressed') === 'true';
  function pattern() {
    const q = findIn.value;
    if (!q) return null;
    let src = on(regexBtn) ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (on(wordBtn)) src = `\\b(?:${src})\\b`;
    return new RegExp(src, on(caseBtn) ? 'gm' : 'gim');
  }
  function refreshFind(jump) {
    found = [];
    foundAt = -1;
    let re;
    try {
      re = pattern();
    } catch (e) {
      countEl.textContent = 'Invalid pattern';
      countEl.className = 'nut-count bad';
      return renderMarks();
    }
    if (re) {
      const text = ta.value;
      let m;
      while ((m = re.exec(text)) && found.length < MAX_MATCHES) {
        if (!m[0].length) {
          re.lastIndex++;
          continue;
        }
        found.push([m.index, m.index + m[0].length]);
      }
    }
    const a = ta.selectionStart;
    foundAt = found.length ? Math.max(0, found.findIndex(([s]) => s >= a)) : -1;
    if (jump && foundAt >= 0) select(found[foundAt][0], found[foundAt][1], false);
    showCount();
    renderMarks();
  }
  function showCount() {
    countEl.className = `nut-count ${findIn.value && !found.length ? 'bad' : 'muted'}`;
    countEl.textContent = !findIn.value ? '' : found.length ? `${(foundAt + 1).toLocaleString()} of ${found.length.toLocaleString()}${found.length >= MAX_MATCHES ? '+' : ''}` : 'No results';
  }
  function step(dir) {
    if (findBar.hidden) return openFind(false);
    if (!found.length) return refreshFind(true);
    const { selectionStart: a, selectionEnd: b } = ta;
    const exact = found.findIndex(([s, e]) => s === a && e === b);
    if (exact >= 0) foundAt = (exact + dir + found.length) % found.length;
    else {
      const k = found.findIndex(([s]) => s >= (dir > 0 ? b : a));
      foundAt = dir > 0 ? (k < 0 ? 0 : k) : ((k < 0 ? found.length : k) - 1 + found.length) % found.length;
    }
    select(found[foundAt][0], found[foundAt][1], false);
    showCount();
    renderMarks();
  }
  function replacement(matchText) {
    if (!on(regexBtn)) return replIn.value;
    const one = new RegExp(pattern().source, on(caseBtn) ? '' : 'i');
    return matchText.replace(one, replIn.value);
  }
  function replaceOne() {
    if (!found.length) return refreshFind(true);
    const { selectionStart: a, selectionEnd: b } = ta;
    const k = found.findIndex(([s, e]) => s === a && e === b);
    if (k < 0) return step(1);
    const r = replacement(ta.value.slice(a, b));
    edit(a, b, r, a + r.length);
    refreshFind(false);
    step(1);
    replIn.focus();
  }
  function replaceAll() {
    refreshFind(false);
    if (!found.length) return;
    const text = ta.value;
    const s = found[0][0], e = found.at(-1)[1];
    let out = '', at = s;
    for (const [ms, me] of found) {
      out += text.slice(at, ms) + replacement(text.slice(ms, me));
      at = me;
    }
    const n = found.length;
    edit(s, e, out + text.slice(at, e));
    refreshFind(false);
    say(`Replaced ${n.toLocaleString()} match${n === 1 ? '' : 'es'}.`);
    replIn.focus();
  }
  function openFind(withReplace) {
    findBar.hidden = false;
    replRow.hidden = !withReplace && replRow.hidden;
    if (withReplace) replRow.hidden = false;
    const { selectionStart: a, selectionEnd: b } = ta;
    const sel = ta.value.slice(a, b);
    if (sel && !sel.includes('\n')) findIn.value = sel;
    else if (!sel) {
      const w = wordAt(ta.value, a);
      if (w && !findIn.value) findIn.value = w.word;
    }
    findIn.focus();
    findIn.select();
    refreshFind(false);
  }
  function closeFind() {
    findBar.hidden = true;
    found = [];
    foundAt = -1;
    renderMarks();
    ta.focus();
  }
  const refindSoon = debounce(() => refreshFind(true), 120);
  findIn.addEventListener('input', refindSoon);
  findBar.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFind();
    else if (e.key === 'Enter' && e.ctrlKey && e.altKey) replaceAll();
    else if (e.key === 'Enter' && e.target === replIn) replaceOne();
    else if (e.key === 'Enter' || e.key === 'F3') step(e.shiftKey ? -1 : 1);
    else if (e.altKey && /^[cwr]$/i.test(e.key)) ({ c: caseBtn, w: wordBtn, r: regexBtn })[e.key.toLowerCase()].click();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  // ---- functions list (the desktop's dropdown above the editor) ----
  const fnSel = el('select', { class: 'nut-select nut-functions', 'aria-label': 'Functions in this script' });
  let fnItems = [];
  function fillFunctions() {
    const list = items.filter((i) => i.kind === 'function' || i.kind === 'method' || i.kind === 'class');
    const key = list.map((i) => i.kind + i.name + i.line).join(',');
    if (fnSel.dataset.key === key) return;
    fnSel.dataset.key = key;
    fnItems = list;
    fnSel.replaceChildren(
      el('option', { value: '-1' }, list.length ? `Functions (${list.length})` : 'No functions'),
      ...list.map((i, k) => el('option', { value: String(k) }, `${i.kind === 'class' ? 'class ' : i.owner ? '    ' : ''}${i.owner && i.kind !== 'class' ? i.owner + '::' : ''}${i.name}${i.kind === 'class' ? '' : `(${i.params ?? ''})`}`)),
    );
  }
  function syncFunction(line) {
    let k = -1;
    for (let i = 0; i < fnItems.length && fnItems[i].line <= line; i++) k = i;
    if (fnSel.value !== String(k)) fnSel.value = String(k);
  }
  fnSel.addEventListener('change', () => {
    const it = fnItems[+fnSel.value];
    if (it) remember(), gotoLine(it.line, it.name);
  });
  function nextFunction(dir) {
    const line = lineOf(ta.selectionStart);
    const it = dir > 0 ? fnItems.find((i) => i.line > line) : fnItems.findLast((i) => i.line < line);
    if (it) gotoLine(it.line, it.name);
    else say(dir > 0 ? 'No function below.' : 'No function above.');
  }

  // ---- go to definition, back / forward ----
  const here = () => ({ path: ctx.filePath, node, pos: ta.selectionStart, end: ta.selectionEnd });
  function remember() {
    history.back.push(here());
    if (history.back.length > HISTORY_MAX) history.back.shift();
    history.fwd.length = 0;
  }
  function goPlace(p) {
    if (p.node === node || p.path === ctx.filePath) return select(p.pos, p.end ?? p.pos);
    ctx.openScript?.(p.path, { pos: p.pos, end: p.end });
  }
  function goBack(dir) {
    const from = dir < 0 ? history.back : history.fwd;
    const to = dir < 0 ? history.fwd : history.back;
    const p = from.pop();
    if (!p) return false;
    to.push(here());
    goPlace(p);
    return true;
  }
  function openScriptByName(rel, pos) {
    // The scripts write paths with escaped backslashes: "character\\characterBresFileList.nut".
    const want = rel.replace(/[\\/]+/g, '/').replace(/^\.?\//, '').toLowerCase();
    const list = ctx.scripts?.() || [];
    const hit = list.find((r) => r.path.toLowerCase() === want) || list.find((r) => r.path.toLowerCase().endsWith('/' + want));
    if (!hit) return say(`${rel} is not in the open Data folder.`, 'bad'), false;
    remember();
    ctx.openScript(hit.path, pos);
    return true;
  }
  // ---- text keys (HappyTool's Find text key references / Open text key in .lng editor) ----
  // `wide`: the commands also take any upper-case key-shaped word (the Revival's keys miss the desktop's prefixes);
  // Ctrl+click and F12 keep the desktop's narrower test, so they still reach function names.
  const keyAtCaret = (wide) => textKeyAt(ta.value, ta.selectionStart, wide);
  function keyReferences(key = keyAtCaret(true)) {
    if (!key) return say('Put the caret on a text resource key (e.g. TXCMA00311) first.', 'bad');
    showKeyReferences(key, { searchFiles: ctx.searchFiles ?? (() => ({ root: '', label: '', files: [] })), open: (path, line) => (remember(), ctx.openAt?.(path, line, key) ?? false) });
  }
  async function openKeyInLng() {
    const key = keyAtCaret(true);
    if (!key) return say('Put the caret on a text resource key (e.g. TXCMA00311) first.', 'bad');
    if (!ctx.openTextKey) return say('There is no .lng editor here.', 'bad');
    const problem = await ctx.openTextKey(key);
    if (problem) say(problem, 'bad');
  }
  async function goToDefinition() {
    const text = ta.value;
    const a = ta.selectionStart;
    const tok = toks.find((t) => t.s <= a && a <= t.e && t.t === 'string') || toks.find((t) => t.s < a && a < t.e);
    // 1. a quoted script path: "nut/sq_util.nut"
    if (tok?.t === 'string') {
      const str = text.slice(tok.s + 1, tok.e - 1);
      if (/\.nut$/i.test(str)) return openScriptByName(str);
    }
    // 2. a text resource key: its references in the Data folder's scripts and JSON
    const tk = textKeyAt(text, a);
    if (tk) return keyReferences(tk);
    let w = wordAt(text, a);
    // 3. RunScriptFunction(x, "name"): the function named in the string
    if (tok?.t === 'string') {
      const c = callAt(text, tok.s);
      const name = text.slice(tok.s + 1, tok.e - 1);
      if (c?.name === 'RunScriptFunction' && /^[A-Za-z_]\w*$/.test(name)) w = { word: name };
    }
    if (!w) return say('Put the caret on a name first.');
    const name = w.word;
    // 4. this script (read by the scanner, so commented-out code doesn't count)
    const mine = items.filter((i) => i.name === name);
    if (mine.length) {
      const best = mine.find((i) => !i.owner) || mine[0];
      remember();
      gotoLine(best.line, best.name);
      return say(mine.length > 1 ? `${name}: ${mine.length} definitions here (${mine.map((i) => `line ${i.line + 1}`).join(', ')}).` : `${name}: line ${best.line + 1}.`);
    }
    // 5. the Data folder's other scripts: top-level definitions first, then the same folder, then by path
    const idx = scriptIndex(ctx, indexProgress);
    if (!idx.done) say(`Indexing the Data folder's scripts (${idx.count} of ${idx.total})…`);
    await idx.ready;
    const dir = (ctx.filePath || '').replace(/[^/]*$/, '').toLowerCase();
    const hits = (idx.byName.get(name) || []).filter((h) => h.path !== ctx.filePath);
    if (hits.length) {
      hits.sort((x, y) => !!x.item.owner - !!y.item.owner || (y.path.toLowerCase().startsWith(dir) - x.path.toLowerCase().startsWith(dir)) || x.path.localeCompare(y.path));
      const [h, ...more] = hits;
      remember();
      ctx.openScript(h.path, { line: h.item.line, name });
      if (more.length) toast(`${name} is also defined in ${more.slice(0, 4).map((m) => `${m.path}:${m.item.line + 1}`).join(', ')}${more.length > 4 ? ` and ${more.length - 4} more` : ''}.`);
      return;
    }
    const e = (await loadCatalogue()).get(name);
    if (KEYWORDS.has(name)) return say(`${name} is a Squirrel keyword.`);
    if (e) return say(`${name} is ${e.kind === 'N' ? 'built into the game (engine function)' : e.kind === 'C' ? 'an engine constant' : e.kind === 'K' ? 'an engine class' : 'a script name'}${e.example ? `: ${e.example}` : ''}${e.where ? ` · ${e.where}` : ''}.`);
    say(`No definition of ${name} found.`, 'bad');
  }
  function indexProgress(idx) {
    if (!message.startsWith('Index')) return;
    say(idx.done ? `Index: ${idx.total.toLocaleString()} scripts.` : `Indexing the Data folder's scripts (${idx.count} of ${idx.total})…`);
  }

  // ---- code assist (completion and call tips) ----
  let assist = null; // {start, list, at}
  function candidates(prefix) {
    const lower = prefix.toLowerCase();
    const seen = new Set();
    const out = [];
    const rank = (n) => (n.startsWith(prefix) ? 0 : n.toLowerCase().startsWith(lower) ? 1 : n.toLowerCase().includes(lower) ? 2 : fuzzy(n.toLowerCase(), lower) ? 3 : -1);
    const add = (name, kind, detail, uses = 0) => {
      if (seen.has(name) || name === prefix) return;
      const r = rank(name);
      if (r < 0) return;
      seen.add(name);
      out.push({ name, kind, detail, r, uses });
    };
    for (const i of items) add(i.name, 'here', i.kind === 'class' ? 'class' : i.params != null ? `(${i.params})` : i.kind, 1e6);
    for (const k of KEYWORDS) add(k, 'kw', '', 5e5);
    if (cat) for (const e of cat.values()) add(e.name, e.kind, e.example || e.where || '', e.uses);
    if (index?.byName) for (const [n, hs] of index.byName) add(n, 'index', hs[0].path, 0);
    for (const n of names) add(n, 'id', '', -1);
    out.sort((x, y) => x.r - y.r || y.uses - x.uses || x.name.length - y.name.length || x.name.localeCompare(y.name));
    return out.slice(0, ASSIST_MAX);
  }
  function fuzzy(name, q) {
    let i = 0;
    for (const c of name) if (c === q[i] && ++i === q.length) return true;
    return false;
  }
  function openAssist(force) {
    const a = ta.selectionStart;
    if (a !== ta.selectionEnd) return closeAssist();
    const w = wordAt(ta.value, a);
    const start = w && w.e === a ? w.s : a;
    const prefix = ta.value.slice(start, a);
    if (!force && prefix.length < 3) return closeAssist();
    const tokHere = toks.find((t) => t.s < a && a <= t.e && (t.t === 'comment' || t.t === 'string'));
    if (tokHere && !force) return closeAssist();
    const list = candidates(prefix);
    if (!list.length) return closeAssist();
    assist = { start, list, at: 0 };
    drawAssist();
  }
  function drawAssist() {
    assistBox.replaceChildren(
      ...assist.list.map((c, i) =>
        el(
          'div',
          { class: `nut-assist-row${i === assist.at ? ' sel' : ''}`, role: 'option', 'aria-selected': String(i === assist.at), title: KINDS[c.kind]?.[1] || '', onmousedown: (e) => (e.preventDefault(), (assist.at = i), acceptAssist()) },
          el('span', { class: `nut-kind k-${c.kind}` }, KINDS[c.kind]?.[0] || '?'),
          el('span', { class: 'nut-assist-name' }, c.name),
          el('span', { class: 'nut-assist-detail muted' }, c.detail),
        ),
      ),
    );
    assistBox.hidden = false;
    placePopups();
    assistBox.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }
  function closeAssist() {
    assist = null;
    assistBox.hidden = true;
  }
  function acceptAssist() {
    const c = assist?.list[assist.at];
    if (!c) return closeAssist();
    const a = ta.selectionStart;
    const w = wordAt(ta.value, a);
    const end = w && w.s <= assist.start && w.e >= a ? w.e : a;
    edit(assist.start, end, c.name);
    closeAssist();
  }
  function signature(name) {
    const mine = items.find((i) => i.name === name && i.params != null);
    if (mine) return { args: mine.params ? mine.params.split(', ') : [], note: `line ${mine.line + 1}` };
    const e = cat?.get(name);
    if (e && (e.kind === 'N' || e.kind === 'S' || e.kind === 'K')) return { args: argsOf(e), note: `${KINDS[e.kind][1]}${e.uses ? ` · used ${e.uses.toLocaleString()}×` : ''}${e.where ? ` · ${e.where}` : ''}` };
    const hs = index?.byName?.get(name)?.find((h) => h.item.params != null);
    if (hs) return { args: hs.item.params ? hs.item.params.split(', ') : [], note: `${hs.path}:${hs.item.line + 1}` };
    return null;
  }
  function updateTip() {
    const a = ta.selectionStart;
    const c = document.activeElement === ta && a === ta.selectionEnd ? callAt(ta.value, a) : null;
    const sig = c && signature(c.name);
    if (!sig) return (tip.hidden = true);
    tip.replaceChildren(
      el('span', { class: 'nut-tip-name' }, c.name),
      '(',
      ...sig.args.flatMap((arg, i) => [i ? ', ' : '', el('span', { class: i === c.arg ? 'nut-tip-cur' : '' }, arg)]),
      ')',
      sig.note ? el('span', { class: 'muted' }, `  ${sig.note}`) : '',
    );
    tip.dataset.pos = String(c.open);
    tip.hidden = false;
    placePopups();
  }
  function placePopups() {
    const gw = gutter.offsetWidth;
    if (!assistBox.hidden && assist) {
      const { x, y } = caretXY(assist.start);
      const top = y - ta.scrollTop + lh() + 2;
      const below = top + 220 < code.clientHeight;
      assistBox.style.left = `${Math.max(0, Math.min(code.clientWidth - 360, gw + x - ta.scrollLeft - 22))}px`;
      assistBox.style.top = below ? `${top}px` : '';
      assistBox.style.bottom = below ? '' : `${code.clientHeight - (y - ta.scrollTop) + 2}px`;
    }
    if (!tip.hidden) {
      const { x, y } = caretXY(+tip.dataset.pos);
      const above = y - ta.scrollTop - lh() - 6 > 0;
      tip.style.left = `${Math.max(0, Math.min(code.clientWidth - tip.offsetWidth - 4, gw + x - ta.scrollLeft - 12))}px`;
      tip.style.top = `${above ? y - ta.scrollTop - lh() - 6 : y - ta.scrollTop + lh() + 4}px`;
      if (!above && !assistBox.hidden) tip.hidden = true;
    }
  }

  // ---- engine toolbox ----
  const tbState = readJson(TOOLBOX_KEY, { open: false, groups: ['N'] });
  const tbFilter = el('input', { class: 'nut-tb-filter', placeholder: 'Filter', 'aria-label': 'Filter the toolbox', spellcheck: 'false' });
  const tbList = el('div', { class: 'nut-tb-list' });
  const toolbox = el('aside', { class: 'nut-toolbox', hidden: !tbState.open, 'aria-label': 'Engine toolbox' }, el('div', { class: 'nut-tb-head' }, el('strong', {}, 'Engine toolbox'), tbFilter), tbList);
  const insertName = (e) => {
    const fn = e.kind === 'N' || e.kind === 'S' || (e.kind === 'K' && e.usualArgs >= 0);
    const { selectionStart: a, selectionEnd: b } = ta;
    edit(a, b, fn ? `${e.name}()` : e.name, fn ? a + e.name.length + 1 : a + e.name.length);
  };
  function fillToolbox() {
    if (!cat) return loadCatalogue().then(fillToolbox);
    const q = tbFilter.value.trim().toLowerCase();
    const rows = (list, make) => list.map(make);
    const groups = TOOLBOX_GROUPS.map(([kind, title]) => {
      const list = [...cat.values()].filter((e) => e.kind === kind && (!q || e.name.toLowerCase().includes(q))).sort((x, y) => x.name.localeCompare(y.name));
      if (!list.length) return null;
      const det = el(
        'details',
        { open: !!q || tbState.groups.includes(kind) },
        el('summary', {}, `${title} (${list.length.toLocaleString()})`),
        ...rows(list, (e) =>
          el(
            'div',
            {
              class: 'nut-tb-item',
              draggable: 'true',
              tabindex: '0',
              title: `${e.example || e.name}${e.uses ? `\nUsed ${e.uses.toLocaleString()}× in the game's scripts` : ''}${e.where ? `\n${e.where}` : ''}\nDouble-click or Enter inserts it; or drag it into the script.`,
              ondblclick: () => insertName(e),
              onkeydown: (ev) => ev.key === 'Enter' && (ev.preventDefault(), insertName(e)),
              ondragstart: (ev) => ev.dataTransfer.setData('text/plain', e.kind === 'N' || e.kind === 'S' ? `${e.name}()` : e.name),
            },
            el('span', { class: `nut-kind k-${e.kind}` }, KINDS[e.kind][0]),
            e.name,
          ),
        ),
      );
      det.addEventListener('toggle', () => {
        if (q) return;
        tbState.groups = tbState.groups.filter((g) => g !== kind);
        if (det.open) tbState.groups.push(kind);
        writeJson(TOOLBOX_KEY, tbState);
      });
      return det;
    }).filter(Boolean);
    const snippets = el(
      'details',
      { open: !!q || tbState.groups.includes('snip') },
      el('summary', {}, `Snippets (${SNIPPETS.length})`),
      ...SNIPPETS.filter(([n]) => !q || n.includes(q)).map(([n, body]) =>
        el('div', { class: 'nut-tb-item', tabindex: '0', title: `${body}\nDouble-click or Enter inserts it.`, ondblclick: () => insertSnippet(body), onkeydown: (ev) => ev.key === 'Enter' && (ev.preventDefault(), insertSnippet(body)) }, el('span', { class: 'nut-kind k-kw' }, '{}'), n),
      ),
    );
    snippets.addEventListener('toggle', () => {
      if (q) return;
      tbState.groups = tbState.groups.filter((g) => g !== 'snip');
      if (snippets.open) tbState.groups.push('snip');
      writeJson(TOOLBOX_KEY, tbState);
    });
    tbList.replaceChildren(...groups, snippets);
  }
  function insertSnippet(body) {
    const { selectionStart: a, selectionEnd: b } = ta;
    const ind = indentOf(ta.value.slice(lineStart(a), a));
    const text = body.split('\n').join('\n' + ind);
    edit(a, b, text, a + text.length);
  }
  tbFilter.addEventListener('input', debounce(fillToolbox, 150));
  const tbBtn = button('Toolbox', () => setToolbox(toolbox.hidden), { title: 'Show or hide the engine toolbox', 'aria-pressed': String(tbState.open) });
  function setToolbox(open) {
    toolbox.hidden = !open;
    tbBtn.setAttribute('aria-pressed', String(open));
    tbState.open = open;
    writeJson(TOOLBOX_KEY, tbState);
    if (open && !tbList.childElementCount) fillToolbox();
  }
  if (tbState.open) fillToolbox();

  // ---- input and keys ----
  ta.addEventListener('input', (e) => {
    model.text = restoreLineEndings(ta.value, base);
    ctx.changed();
    renderSoon();
    lossSoon();
    if (assist || (e.inputType === 'insertText' && /^[A-Za-z0-9_]$/.test(e.data || ''))) requestAnimationFrame(() => openAssist(!!assist && wordAt(ta.value, ta.selectionStart)));
    else if (e.inputType?.startsWith('delete') && assist) requestAnimationFrame(() => openAssist(false));
  });
  ta.addEventListener('blur', () => setTimeout(() => document.activeElement !== ta && (closeAssist(), (tip.hidden = true)), 120));
  ta.addEventListener('mousedown', () => closeAssist());
  const lossSoon = debounce(() => {
    if (model.encoding !== 'shift_jis') return;
    const back = new TextDecoder('shift_jis').decode(encodeShiftJis(ta.value));
    let n = 0;
    if (back !== ta.value) for (const ch of ta.value) if (ch.codePointAt(0) >= 0x80 && encodeShiftJis(ch)[0] === 0x3f) n++;
    lossEl.hidden = !n;
    lossEl.textContent = n ? `${n} character${n === 1 ? '' : 's'} can't be written in Shift-JIS (saved as ?)` : '';
  }, 500);

  function keys(e) {
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (assist) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'PageDown' || k === 'PageUp') {
        const d = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[k];
        assist.at = Math.max(0, Math.min(assist.list.length - 1, assist.at + d));
        drawAssist();
        return true;
      }
      if (k === 'Enter' || k === 'Tab') return acceptAssist(), true;
      if (k === 'Escape') return closeAssist(), true;
    }
    if (ctrl && !e.altKey && (k === ' ' || k.toLowerCase() === 'j') && !e.shiftKey) return openAssist(true), true;
    if (ctrl && !e.shiftKey && k.toLowerCase() === 'f') return openFind(false), true;
    if (ctrl && !e.shiftKey && k.toLowerCase() === 'h') return openFind(true), true;
    if (ctrl && !e.shiftKey && k.toLowerCase() === 'g') return goToLinePrompt(), true;
    if (ctrl && (k === '/' || e.code === 'Slash')) return toggleComment(), true;
    if (ctrl && e.shiftKey && k === 'ArrowUp') return nextFunction(-1), true;
    if (ctrl && e.shiftKey && k === 'ArrowDown') return nextFunction(1), true;
    if (ctrl && (k === '=' || k === '+')) return zoomBy(1), true;
    if (ctrl && k === '-') return zoomBy(-1), true;
    if (ctrl && k === '0') return setZoom(100), true;
    if (k === 'F3') return step(e.shiftKey ? -1 : 1), true;
    if (k === 'F12') return goToDefinition(), true;
    if (ctrl && e.shiftKey && !e.altKey && k.toLowerCase() === 'r') return keyReferences(), true;
    if (ctrl && e.shiftKey && !e.altKey && k.toLowerCase() === 'l') return openKeyInLng(), true;
    if (e.altKey && !ctrl && (k === 'ArrowLeft' || k === 'ArrowRight')) return goBack(k === 'ArrowLeft' ? -1 : 1);
    if (e.target !== ta) return false;
    if (k === 'Tab' && !ctrl && !e.altKey) {
      const { selectionStart: a, selectionEnd: b } = ta;
      if (e.shiftKey || ta.value.slice(a, b).includes('\n')) shiftLines(e.shiftKey ? -1 : 1);
      else insertTab();
      return true;
    }
    if (k === 'Enter' && !ctrl && !e.altKey && !e.shiftKey) return newLine(), true;
    if (k === '}' && !ctrl && !e.altKey) return closeBrace();
    if (k === 'Escape' && !findBar.hidden) return closeFind(), true;
    if (k === 'Escape' && !tip.hidden) return (tip.hidden = true), true;
    return false;
  }
  const root = el('div', { class: 'view nut-view' });
  root.addEventListener('keydown', (e) => {
    if (keys(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  // Ctrl+click (Cmd+click on a Mac) on a name goes to its definition, as F12: the click has already put the caret there.
  ta.addEventListener('click', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.button !== 0 || ta.selectionStart !== ta.selectionEnd) return;
    const a = ta.selectionStart;
    if (wordAt(ta.value, a) || toks.some((t) => t.t === 'string' && t.s < a && a < t.e)) goToDefinition();
  });
  // A hand pointer while Ctrl is held, so the click reads as "go to".
  ta.addEventListener('mousemove', (e) => ta.classList.toggle('nut-ctrl', e.ctrlKey || e.metaKey));
  for (const type of ['keydown', 'keyup']) ta.addEventListener(type, (e) => (e.key === 'Control' || e.key === 'Meta') && ta.classList.toggle('nut-ctrl', type === 'keydown'));
  ta.addEventListener('blur', () => ta.classList.remove('nut-ctrl'));

  // ---- the desktop's menus (GUI/SquirrelEditor.Commands.cs) ----
  const zoomBy = (d) => setZoom((d > 0 ? ZOOMS.find((z) => z > zoom) : ZOOMS.findLast((z) => z < zoom)) ?? zoom);
  // Undo and redo use the browser's own history, which holds every edit (edit() goes through execCommand).
  function native(cmd, keys) {
    ta.focus({ preventScroll: true });
    if (!document.execCommand(cmd)) say(`The browser would not ${cmd} from the menu; press ${keys}.`, 'bad');
  }
  async function copy(cut) {
    const { selectionStart: a, selectionEnd: b } = ta;
    if (a === b) return;
    try {
      await navigator.clipboard.writeText(ta.value.slice(a, b));
    } catch {
      ta.focus({ preventScroll: true });
      if (!document.execCommand(cut ? 'cut' : 'copy')) say(`The browser would not ${cut ? 'cut' : 'copy'} from the menu; press Ctrl+${cut ? 'X' : 'C'}.`, 'bad');
      return;
    }
    if (cut) edit(a, b, '');
    else ta.focus({ preventScroll: true });
  }
  async function paste() {
    const { selectionStart: a, selectionEnd: b } = ta;
    let s;
    try {
      s = await navigator.clipboard.readText();
    } catch {
      ta.focus({ preventScroll: true });
      return say('The browser would not share the clipboard with the menu; press Ctrl+V.', 'bad');
    }
    if (s) edit(a, b, s.replace(/\r\n?/g, '\n'));
    else ta.focus({ preventScroll: true });
  }
  const file = ctx.file || {};
  const hasSel = () => ta.selectionEnd > ta.selectionStart;
  const editItems = () => [
    { label: 'Undo', keys: 'Ctrl+Z', run: () => native('undo', 'Ctrl+Z') },
    { label: 'Redo', keys: 'Ctrl+Y', run: () => native('redo', 'Ctrl+Y') },
    null,
    { label: 'Cut', keys: 'Ctrl+X', run: () => copy(true), enabled: hasSel },
    { label: 'Copy', keys: 'Ctrl+C', run: () => copy(false), enabled: hasSel },
    { label: 'Paste', keys: 'Ctrl+V', run: paste, enabled: () => !!navigator.clipboard?.readText },
    { label: 'Select all', keys: 'Ctrl+A', run: () => (ta.focus({ preventScroll: true }), ta.select(), updateCaret()) },
    null,
    { label: 'Toggle line comment', keys: 'Ctrl+/', run: toggleComment },
  ];
  const definitionItem = { label: 'Go to definition / open include', keys: 'F12, Ctrl+click', run: goToDefinition };
  const menus = [
    {
      label: 'File',
      items: () => [
        { label: 'Open…', run: file.open },
        { label: 'Save', keys: 'Ctrl+S', run: file.save },
        { label: 'Save as…', run: file.saveAs },
        null,
        { label: file.closeLabel || 'Close', run: file.close },
      ],
    },
    {
      label: 'Edit',
      items: () => [
        ...editItems(),
        null,
        { label: 'Find…', keys: 'Ctrl+F', run: () => openFind(false) },
        { label: 'Replace…', keys: 'Ctrl+H', run: () => openFind(true) },
        { label: 'Find next', keys: 'F3', run: () => step(1) },
        { label: 'Find previous', keys: 'Shift+F3', run: () => step(-1) },
        { label: 'Go to line…', keys: 'Ctrl+G', run: goToLinePrompt },
      ],
    },
    {
      label: 'View',
      items: () => [
        { label: 'Engine toolbox', checked: () => !toolbox.hidden, run: () => setToolbox(toolbox.hidden) },
        null,
        { label: 'Zoom in', keys: 'Ctrl+Plus', run: () => zoomBy(1) },
        { label: 'Zoom out', keys: 'Ctrl+Minus', run: () => zoomBy(-1) },
        { label: 'Reset zoom', keys: 'Ctrl+0', run: () => setZoom(100) },
      ],
    },
    {
      label: 'Navigate',
      items: () => [
        { label: 'Back', keys: 'Alt+←', run: () => goBack(-1), enabled: () => history.back.length > 0 },
        { label: 'Forward', keys: 'Alt+→', run: () => goBack(1), enabled: () => history.fwd.length > 0 },
        null,
        definitionItem,
        { label: 'Find text key references…', keys: 'Ctrl+Shift+R', run: () => keyReferences() },
        { label: 'Open text key in .lng editor…', keys: 'Ctrl+Shift+L', run: openKeyInLng },
        null,
        { label: 'Previous function', keys: 'Ctrl+Shift+↑', run: () => nextFunction(-1) },
        { label: 'Next function', keys: 'Ctrl+Shift+↓', run: () => nextFunction(1) },
      ],
    },
  ];
  // Right-click (or the Menu key / Shift+F10): the desktop's editor menu. A right-click outside the selection has
  // already moved the caret there, so the commands act on what was clicked.
  const contextItems = () => [definitionItem, null, ...editItems(), null, { label: 'Find…', keys: 'Ctrl+F', run: () => openFind(false) }];
  // From the keyboard the menu opens under the caret, with its first item lit for the arrow keys.
  function caretMenu() {
    closeAssist();
    const r = code.getBoundingClientRect();
    const { x, y } = caretXY(ta.selectionEnd);
    contextMenu(contextItems, r.left + gutter.offsetWidth + x - ta.scrollLeft, r.top + y - ta.scrollTop + lh(), true);
  }
  ta.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (e.button !== 2) return caretMenu();
    closeAssist();
    contextMenu(contextItems, e.clientX, e.clientY);
  });
  // Not every browser turns these keys into a contextmenu event, so the editor opens the menu itself.
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey)) return;
    e.preventDefault();
    caretMenu();
  });
  async function goToLinePrompt() {
    const v = await ask(`Go to line (1–${lineCount.toLocaleString()})`, String(lineOf(ta.selectionStart) + 1), 'Go');
    if (v == null) return ta.focus();
    const n = parseInt(v, 10);
    if (!(n >= 1)) return toast('Enter a line number.', 'error');
    remember();
    gotoLine(n - 1);
  }

  setViewCommands(() =>
    root.isConnected
      ? [
          { label: 'Find', keys: 'Ctrl+F', section: 'Script', run: () => openFind(false) },
          { label: 'Replace', keys: 'Ctrl+H', section: 'Script', run: () => openFind(true) },
          { label: 'Find next / previous', keys: 'F3 / Shift+F3', section: 'Script', run: () => step(1) },
          { label: 'Go to line', keys: 'Ctrl+G', section: 'Script', run: goToLinePrompt },
          { label: 'Toggle line comment', keys: 'Ctrl+/', section: 'Script', run: toggleComment },
          { label: 'Code assist (complete a name)', keys: 'Ctrl+Space / Ctrl+J', section: 'Script', run: () => (ta.focus(), openAssist(true)) },
          { label: 'Go to definition (or open the script a quoted path names)', keys: 'F12 / Ctrl+click', section: 'Script', run: goToDefinition },
          { label: 'Back to where I jumped from', keys: 'Alt+←', section: 'Script', run: () => goBack(-1) || say('Nothing to go back to.') },
          { label: 'Forward again', keys: 'Alt+→', section: 'Script', run: () => goBack(1) || say('Nothing to go forward to.') },
          { label: 'Previous / next function', keys: 'Ctrl+Shift+↑ / ↓', section: 'Script', run: () => nextFunction(1) },
          { label: 'Indent / outdent lines', keys: 'Tab / Shift+Tab', section: 'Script', run: () => shiftLines(1) },
          { label: 'Zoom in / out / reset', keys: 'Ctrl+Plus / Ctrl+Minus / Ctrl+0', section: 'Script', run: () => setZoom(100) },
          { label: 'Engine toolbox', section: 'Script', run: () => setToolbox(toolbox.hidden) },
        ]
      : null,
  );

  // ---- layout ----
  const toolbar = el(
    'div',
    { class: 'toolbar nut-toolbar' },
    menuBar(menus, 'Script editor menu'),
    el('span', { class: 'nut-bar-sep', 'aria-hidden': 'true' }),
    button('‹', () => nextFunction(-1), { title: 'Previous function (Ctrl+Shift+↑)', 'aria-label': 'Previous function' }),
    fnSel,
    button('›', () => nextFunction(1), { title: 'Next function (Ctrl+Shift+↓)', 'aria-label': 'Next function' }),
    el('span', { class: 'spacer' }),
    tbBtn,
  );
  root.append(toolbar, findBar, el('div', { class: 'nut-main' }, code, toolbox), statusBar);

  renderText();
  showEol();
  applyZoom();
  lossSoon();
  const jump = ctx.takeJump?.();
  const ui = node.nutUi;
  requestAnimationFrame(() => {
    if (jump?.line != null) gotoLine(jump.line, jump.name);
    else if (jump?.pos != null) select(jump.pos, jump.end ?? jump.pos);
    else if (ui) {
      ta.setSelectionRange(ui.a, ui.b);
      ta.scrollTop = ui.top;
      ta.scrollLeft = ui.left;
      syncScroll();
      ta.focus({ preventScroll: true });
    } else ta.setSelectionRange(0, 0);
    updateCaret();
    // Index the Data folder's scripts in the background, for go to definition and code assist.
    const idx = scriptIndex(ctx, indexProgress);
    if (!idx.done && idx.total) say(`Indexing the Data folder's scripts (${idx.count} of ${idx.total})…`);
  });
  return root;
}
