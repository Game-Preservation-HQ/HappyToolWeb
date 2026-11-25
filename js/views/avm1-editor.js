// Editor for one AVM1 action block (a DoAction or DoInitAction body, a clip action or a button condition): its p-code,
// edited as text and assembled on Apply (or Ctrl+Enter, or after a pause in typing); the ActionScript 2 it reads as,
// read-only; and its constant pools, whose strings can be edited in place. onChange(bytes) gets the new block after
// each edit that assembles; an error leaves the block as it was and marks its line.
import { el, button, debounce, confirmBox } from '../ui.js';
import { disassemble, assemble, decompile, constantPools, setConstant, binText } from '../formats/avm1.js';

const AUTO_MS = 1200;
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Builds the editor inside `container` for the action bytes `bytes`. Returns `{ root, bytes(), reset(bytes) }`:
 * bytes() is the block as last assembled, reset() loads another block (or the same one again) as the new original.
 */
export function renderActionEditor(container, bytes, onChange) {
  let original = Uint8Array.from(bytes);
  let current = Uint8Array.from(bytes);
  let applied = ''; // the p-code text `current` was assembled from (or disassembled to)
  let asStale = true;
  let poolStale = true;
  let errLine = 0;

  const status = el('span', { class: 'avm1-status' });
  const setStatus = (text, kind = '') => {
    status.textContent = text;
    status.className = `avm1-status ${kind}`;
  };

  // ---- p-code ----
  const ta = el('textarea', { class: 'editor avm1-text', spellcheck: 'false', wrap: 'off', 'aria-label': 'P-code' });
  const gutter = el('pre', { class: 'avm1-gutter', 'aria-hidden': 'true' });
  const mark = el('div', { class: 'avm1-errline', hidden: true });
  const code = el('div', { class: 'avm1-code' }, gutter, el('div', { class: 'avm1-textwrap' }, ta, mark));
  let gutterLines = 0;
  const lineHeight = () => parseFloat(getComputedStyle(ta).lineHeight) || 19.5;
  function paintGutter() {
    const n = ta.value.split('\n').length;
    if (n !== gutterLines) {
      gutterLines = n;
      gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
    }
    gutter.scrollTop = ta.scrollTop;
    if (errLine) {
      const pad = parseFloat(getComputedStyle(ta).paddingTop) || 0;
      mark.style.top = `${pad + (errLine - 1) * lineHeight() - ta.scrollTop}px`;
      mark.style.height = `${lineHeight()}px`;
    }
    mark.hidden = !errLine;
  }
  function showError(line, message, select) {
    errLine = line || 0;
    setStatus(line ? `Line ${line}: ${message}` : message, 'bad');
    paintGutter();
    if (select && line) {
      const lines = ta.value.split('\n');
      const start = lines.slice(0, line - 1).reduce((s, l) => s + l.length + 1, 0);
      ta.focus();
      ta.setSelectionRange(start, start + (lines[line - 1] ?? '').length);
      const want = (line - 1) * lineHeight();
      if (want < ta.scrollTop || want > ta.scrollTop + ta.clientHeight - 2 * lineHeight()) ta.scrollTop = Math.max(0, want - ta.clientHeight / 3);
    }
  }
  const clearError = () => {
    errLine = 0;
    paintGutter();
  };

  // ---- ActionScript (read-only) ----
  const asView = el('textarea', { class: 'editor avm1-as', spellcheck: 'false', wrap: 'off', readonly: true, 'aria-label': 'ActionScript' });
  function paintAS() {
    if (!asStale) return;
    asStale = false;
    try {
      asView.value = decompile(current);
    } catch (e) {
      asView.value = `// The ActionScript view failed: ${e.message}`;
    }
  }

  // ---- constant pools ----
  const filter = el('input', { type: 'search', class: 'avm1-filter', placeholder: 'Filter strings', 'aria-label': 'Filter strings' });
  const pools = el('div', { class: 'avm1-pools' });
  function paintPools() {
    poolStale = false;
    const list = constantPools(current);
    pools.replaceChildren();
    if (!list.length) return void pools.append(el('p', { class: 'muted' }, 'This block has no constant pool.'));
    for (const p of list) {
      const rows = p.strings.map((s, i) => {
        const text = binText(s);
        const input = el('input', { type: 'text', class: 'avm1-const', value: text, spellcheck: 'false', 'aria-label': `Constant ${i}` });
        input.addEventListener('change', () => editConstant(p.pool, i, input));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') input.value = text;
        });
        return el('div', { class: 'avm1-const-row', dataset: { text: text.toLowerCase() } }, el('span', { class: 'avm1-const-index' }, `constant${i}`), input);
      });
      pools.append(el('div', { class: 'avm1-pool' }, el('div', { class: 'avm1-pool-head' }, `ConstantPool ${p.pool + 1} · offset ${p.offset} · ${p.strings.length} strings`), ...rows));
    }
    applyFilter();
  }
  function applyFilter() {
    const q = filter.value.trim().toLowerCase();
    for (const row of pools.querySelectorAll('.avm1-const-row')) row.hidden = !!q && !row.dataset.text.includes(q);
  }
  filter.addEventListener('input', applyFilter);
  function editConstant(pool, index, input) {
    if (ta.value !== applied && !apply(true)) {
      input.value = binText(constantPools(current)[pool].strings[index]);
      return;
    }
    try {
      commit(setConstant(current, pool, index, input.value), true, true);
      input.parentNode.dataset.text = input.value.toLowerCase();
      setStatus(`constant${index} set`, 'ok');
    } catch (e) {
      setStatus(e.message, 'bad');
      input.value = binText(constantPools(current)[pool].strings[index]);
    }
  }

  // ---- state ----
  function load(text) {
    applied = text;
    ta.value = text;
    gutterLines = 0;
    clearError();
  }
  // `next` is the new block; with fromBytes the p-code text is rewritten from it (a constant edit, a revert). A
  // constant edit keeps the pool list as it is, so the field the user moved on to keeps its focus.
  function commit(next, fromBytes, keepPools = false) {
    const changed = !same(next, current);
    current = next;
    asStale = true;
    poolStale = !keepPools;
    if (fromBytes) load(disassemble(current).text);
    if (tab === 'as') paintAS();
    if (tab === 'pool' && poolStale) paintPools();
    revert.disabled = same(current, original);
    if (changed) onChange?.(Uint8Array.from(current));
  }
  function apply(select) {
    const text = ta.value;
    if (text === applied && !errLine) return true;
    try {
      const out = assemble(text);
      applied = text;
      clearError();
      const changed = !same(out, current);
      commit(out, false);
      setStatus(changed ? `Assembled · ${out.length} bytes` : 'No change', 'ok');
      return true;
    } catch (e) {
      showError(e.line, e.message, select);
      return false;
    }
  }
  const autoApply = debounce(() => {
    if (auto.checked && ta.value !== applied) apply(false);
  }, AUTO_MS);

  ta.addEventListener('input', () => {
    paintGutter();
    if (ta.value !== applied) setStatus('Edited · not applied');
    autoApply();
  });
  ta.addEventListener('scroll', paintGutter);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      apply(true);
    } else if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  });
  status.addEventListener('click', () => {
    if (errLine) showError(errLine, status.textContent.replace(/^Line \d+: /, ''), true);
  });

  // ---- toolbar and tabs ----
  const applyBtn = button('Apply', () => apply(true), { class: 'btn btn-primary', title: 'Assemble the p-code (Ctrl+Enter)' });
  const auto = el('input', { type: 'checkbox', checked: true });
  const revert = button(
    'Revert',
    async () => {
      if (!(await confirmBox('Put this block back the way it was when it was opened? Your edits to it are lost.', 'Revert', true))) return;
      commit(Uint8Array.from(original), true);
      setStatus('Reverted', 'ok');
    },
    { disabled: true },
  );
  const panels = {
    pcode: el('div', { class: 'avm1-panel' }, code),
    as: el('div', { class: 'avm1-panel', hidden: true }, asView),
    pool: el('div', { class: 'avm1-panel', hidden: true }, el('div', { class: 'toolbar' }, filter), pools),
  };
  const labels = { pcode: 'P-code', as: 'ActionScript', pool: 'Constants' };
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'View' });
  let tab = 'pcode';
  function show(name) {
    tab = name;
    for (const [k, p] of Object.entries(panels)) p.hidden = k !== name;
    for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.tab === name));
    applyBtn.hidden = auto.parentNode.hidden = name !== 'pcode';
    if (name === 'as') paintAS();
    if (name === 'pool' && poolStale) paintPools();
    if (name === 'pcode') requestAnimationFrame(paintGutter);
  }
  for (const [k, label] of Object.entries(labels)) seg.append(button(label, () => show(k), { dataset: { tab: k }, 'aria-pressed': String(k === tab) }));

  const root = el(
    'div',
    { class: 'view avm1-editor' },
    el('div', { class: 'toolbar tabs-bar' }, seg, applyBtn, el('label', { class: 'avm1-auto', title: `Apply ${AUTO_MS / 1000} s after typing stops` }, auto, ' Apply as I type'), revert, el('span', { class: 'spacer' }), status),
    panels.pcode,
    panels.as,
    panels.pool,
  );
  container.append(root);
  load(disassemble(current).text);
  show('pcode');

  return {
    root,
    bytes: () => Uint8Array.from(current),
    reset(next) {
      original = Uint8Array.from(next);
      current = Uint8Array.from(next);
      asStale = poolStale = true;
      load(disassemble(current).text);
      revert.disabled = true;
      setStatus('');
      show(tab);
    },
  };
}
