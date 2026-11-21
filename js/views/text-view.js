// Plain text and JSON editor. Keeps the file's original encoding (UTF-8, UTF-8 BOM, UTF-16 LE/BE BOM, Shift-JIS).
import { el, button, debounce, confirmBox, toast } from '../ui.js';
import { parseGameJson, reindentJson } from '../formats/json.js';
import { lineEndings, restoreLineEndings } from '../util.js';

const ENCODING_LABELS = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8 with BOM',
  'utf-16le-bom': 'UTF-16 LE',
  'utf-16be-bom': 'UTF-16 BE',
  shift_jis: 'Shift-JIS',
};

export function renderText(node, ctx) {
  const model = node.model;
  const isJson = node.kind === 'json';
  const ta = el('textarea', { class: 'editor', spellcheck: 'false', wrap: 'off', 'aria-label': 'File contents' });
  ta.value = model.text;
  let base = lineEndings(model.text); // the textarea reads back LF only; this keeps the file's own line endings
  const status = el('span', { class: 'muted', 'aria-live': 'polite' });

  // Comments are allowed, as in the game's own files (HappyTool validates the same way).
  const validate = () => {
    if (!isJson) return null;
    try {
      const r = parseGameJson(ta.value);
      status.textContent = r.comments ? `Valid JSON · ${r.comments.toLocaleString()} comment${r.comments === 1 ? '' : 's'}` : 'Valid JSON';
      status.className = 'ok';
      return r;
    } catch (e) {
      status.textContent = e.message;
      status.className = 'bad';
      return null;
    }
  };
  const validateSoon = debounce(validate, 400);
  const setText = (t) => {
    ta.value = t;
    model.text = t;
    base = lineEndings(t);
    ctx.changed();
    validate();
  };
  ta.addEventListener('input', () => {
    model.text = restoreLineEndings(ta.value, base);
    ctx.changed();
    validateSoon();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input'));
  });

  const wrapBtn = button('Wrap lines', () => {
    const on = ta.getAttribute('wrap') === 'off';
    ta.setAttribute('wrap', on ? 'soft' : 'off');
    wrapBtn.setAttribute('aria-pressed', String(on));
  }, { 'aria-pressed': 'false' });

  const tools = [wrapBtn];
  if (isJson) {
    const reformat = async (indent) => {
      const verb = indent ? 'Format' : 'Minify';
      const r = validate();
      if (!r) return toast(`Cannot ${verb.toLowerCase()}: ${status.textContent}`, 'error');
      const n = r.comments;
      if (n && !(await confirmBox(`${indent ? 'Formatting' : 'Minifying'} removes the ${n.toLocaleString()} comment${n === 1 ? '' : 's'} in this file. Continue?`, verb))) return;
      setText(reindentJson(r.clean, indent, base.eol) + (/\n\s*$/.test(ta.value) ? base.eol : ''));
    };
    tools.unshift(
      button('Format', () => reformat(2), { title: 'Indent with 2 spaces. Strings and numbers stay exactly as written.' }),
      button('Minify', () => reformat(0), { title: 'Remove all spacing. Strings and numbers stay exactly as written.' }),
    );
  }
  validate();
  const lines = model.text.length ? model.text.split('\n').length : 0;
  return el(
    'div',
    { class: 'view text-view' },
    el('div', { class: 'toolbar' }, ...tools, el('span', { class: 'spacer' }), status, el('span', { class: 'chip' }, ENCODING_LABELS[model.encoding] || model.encoding), el('span', { class: 'muted' }, `${lines.toLocaleString()} lines`)),
    ta,
  );
}
