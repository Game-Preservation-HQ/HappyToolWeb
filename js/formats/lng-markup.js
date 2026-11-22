// Font colour markup in .lng strings, as HappyTool's LngFontColorMarkup: <font color="#rrggbb">…</font> and <img …>.
// The game draws the colour; the preview here shows it the way HappyTool's in-game preview does.

const OPEN = /<font\s+color\s*=\s*"(#?[0-9a-fA-F]{3,8})"\s*>/gi;
const CLOSE = /<\/font\s*>/gi;
const IMG = /<img\b[^>]*>/gi;
const OPEN_TAG = /^<font\s+color\s*=\s*"(#?[0-9a-fA-F]{3,8})"\s*>$/i;
const IMG_TAG = /^<img\b[^>]*>$/i;
const CLOSE_ONE = /<\/font\s*>/i;

/** True when the text has a font colour tag HappyTool recognises (double-quoted hex only). */
export const hasFontColor = (s) => !!s && new RegExp(OPEN.source, 'i').test(s);

/** HappyTool's "Has markup" filter: a plain "<font" anywhere, any case. Looser than hasFontColor. */
export const hasFontText = (s) => !!s && /<font/i.test(s);

/** Blank gives #ffffff; otherwise trimmed, with a leading # and lower case. */
export function normalizeHex(hex) {
  const s = String(hex ?? '').trim();
  if (!s) return '#ffffff';
  return (s.startsWith('#') ? s : '#' + s).toLowerCase();
}

/** [r, g, b] for #rgb or #rrggbb, else null (the tag regex allows 3-8 digits, but only these two forms draw). */
export function parseColor(hex) {
  const s = normalizeHex(hex);
  if (/^#[0-9a-f]{3}$/.test(s)) return [1, 2, 3].map((i) => parseInt(s[i], 16) * 17);
  if (/^#[0-9a-f]{6}$/.test(s)) return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  return null;
}

export const toHex6 = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

/** The colours of the font tags in the text, normalised, in order of appearance, each once. */
export function colorsIn(s) {
  const out = [];
  if (!s) return out;
  for (const m of s.matchAll(OPEN)) {
    const h = normalizeHex(m[1]);
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

export const wrapColor = (inner, hex) => `<font color="${normalizeHex(hex)}">${inner}</font>`;

/** Removes font open and close tags and img tags, keeping the text between them (up to 8 passes, as HappyTool). */
export function stripMarkup(s) {
  if (!s) return s;
  for (let pass = 0; pass < 8; pass++) {
    const next = s.replace(OPEN, '').replace(CLOSE, '').replace(IMG, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * The in-game preview as DOM nodes, built as HappyTool's BuildPreviewHtml: each line on its own, a font tag colours
 * up to the first close tag after it (or the end of the line), an img tag shows as [img], other tags are dropped, and
 * an unclosed '<' leaves the rest of the line as plain text.
 */
export function renderPreview(text, into) {
  into.replaceChildren();
  if (!text) {
    into.append(Object.assign(document.createElement('i'), { textContent: '(empty)' }));
    return into;
  }
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .forEach((line, i) => {
      if (i) into.append(document.createElement('br'));
      convertLine(line, into);
    });
  return into;
}

function convertLine(s, parent) {
  let i = 0;
  const put = (t) => t && parent.append(t);
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) return put(s.slice(i));
    put(s.slice(i, lt));
    const gt = s.indexOf('>', lt);
    if (gt < 0) return put(s.slice(lt));
    const tag = s.slice(lt, gt + 1);
    const open = OPEN_TAG.exec(tag);
    if (open) {
      const rest = s.slice(gt + 1);
      const close = CLOSE_ONE.exec(rest);
      const inner = close ? rest.slice(0, close.index) : rest;
      const rgb = parseColor(open[1]);
      if (rgb) {
        const span = document.createElement('span');
        span.style.color = `rgb(${rgb.join(',')})`;
        convertLine(inner, span);
        parent.append(span);
      } else put(tag + inner);
      i = close ? gt + 1 + close.index + close[0].length : s.length;
      continue;
    }
    if (IMG_TAG.test(tag)) put('[img]');
    i = gt + 1;
  }
}
