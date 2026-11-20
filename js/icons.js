// File-type icons for the folder browser. Inline SVG drawn with theme tokens, so the same icon works on light and dark.

const TYPES = [
  { exts: ['bres'], key: 'bres', label: 'BRES', color: '#7b5bd6', glyph: 'box', name: 'Resource bundle' },
  { exts: ['pres'], key: 'bres', label: 'PRES', color: '#7b5bd6', glyph: 'box', name: 'Resource pool (Xbox 360)' },
  { exts: ['lng'], key: 'lng', label: 'LNG', color: '#2f9e6e', glyph: 'lines', name: 'Text resource' },
  { exts: ['json', 'zson'], key: 'json', label: 'JSON', color: '#c98512', glyph: 'braces', name: 'JSON table' },
  { exts: ['nut'], key: 'nut', label: 'NUT', color: '#2f6fdb', glyph: 'code', name: 'Squirrel script' },
  { exts: ['dds', 'tpd'], key: 'image', label: 'DDS', color: '#cf3f78', glyph: 'picture', name: 'Texture' },
  { exts: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'], key: 'image', label: '', color: '#cf3f78', glyph: 'picture', name: 'Picture' },
  { exts: ['rrm'], key: 'model', label: 'RRM', color: '#16939f', glyph: 'cube', name: 'Model (Steam)' },
  { exts: ['rmd'], key: 'model', label: 'RMD', color: '#16939f', glyph: 'cube', name: 'Model (Xbox One)' },
  { exts: ['rml'], key: 'model', label: 'RML', color: '#16939f', glyph: 'lines', name: 'Materials (Xbox One)' },
  { exts: ['rra', 'pack'], key: 'motion', label: '', color: '#5f7d1e', glyph: 'motion', name: 'Animation' },
  { exts: ['pck', 'bnk', 'xwb', 'xsb', 'xgs', 'wav', 'ogg', 'wma'], key: 'audio', label: '', color: '#c2583a', glyph: 'note', name: 'Audio' },
  { exts: ['swf', 'gfx', 'sgfx'], key: 'flash', label: '', color: '#d24a2c', glyph: 'play', name: 'Scaleform movie' },
  { exts: ['fnt', 'ttf', 'otf'], key: 'font', label: '', color: '#6b6f7a', glyph: 'font', name: 'Font' },
  { exts: ['txt', 'xml', 'csv', 'ini', 'cfg', 'md', 'log'], key: 'text', label: '', color: '#6b7488', glyph: 'lines', name: 'Text' },
  { exts: ['zip', 'pak'], key: 'archive', label: '', color: '#8a6a3c', glyph: 'box', name: 'Package' },
];
const BY_EXT = new Map(TYPES.flatMap((t) => t.exts.map((e) => [e, t])));

const extOf = (name) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/** What kind of file a name is: key (for styling), short label, badge colour and a readable type name. */
export function fileType(name) {
  const ext = extOf(name);
  const t = BY_EXT.get(ext);
  if (t) return { ...t, label: t.label || ext.toUpperCase().slice(0, 4) };
  return { key: 'file', label: ext.toUpperCase().slice(0, 4), color: '#7a8294', glyph: null, name: ext ? `${ext.toUpperCase()} file` : 'File' };
}

const GLYPHS = {
  box: '<path d="M14 11h20v4H14zM15 15h18v8H15z"/><path d="M21 18h6"/>',
  lines: '<path d="M15 10h18M15 14h18M15 18h12M15 22h16"/>',
  braces: '<path d="M20 9c-3 0-3 2-3 4s0 3-2 3c2 0 2 1 2 3s0 4 3 4M28 9c3 0 3 2 3 4s0 3 2 3c-2 0-2 1-2 3s0 4-3 4"/>',
  code: '<path d="M19 11l-5 5 5 5M29 11l5 5-5 5M26 9l-4 14"/>',
  picture: '<rect x="13" y="9" width="22" height="15" rx="1.5"/><circle cx="19" cy="14" r="2"/><path d="M14 23l7-6 4 4 3-2 6 4"/>',
  cube: '<path d="M24 8l8 4v9l-8 4-8-4v-9z"/><path d="M16 12l8 4 8-4M24 16v9"/>',
  motion: '<circle cx="27" cy="10" r="2"/><path d="M26 13l-3 5 4 2 1 5M23 18l-5-1M24 14l5 2"/>',
  note: '<path d="M21 22V10l11-2v12"/><circle cx="18.5" cy="22" r="2.5"/><circle cx="29.5" cy="20" r="2.5"/>',
  play: '<circle cx="24" cy="16" r="8"/><path d="M22 12.5v7l6-3.5z"/>',
  font: '<path d="M17 23l7-15 7 15M20 18h8"/>',
};

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** SVG markup for a file icon (48×48 grid). */
export function fileIconSvg(name, size = 48) {
  const t = fileType(name);
  const glyph = t.glyph ? `<g fill="none" stroke="${t.color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[t.glyph]}</g>` : '';
  const label = t.label
    ? `<rect x="5" y="27" width="30" height="12" rx="2" fill="${t.color}"/><text x="20" y="36" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="${t.label.length > 3 ? 7.5 : 8.5}" font-weight="700" fill="#fff">${esc(t.label)}</text>`
    : '';
  return `<svg class="ficon" width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true"><path d="M11 3.5h19l10 10V43a1.5 1.5 0 0 1-1.5 1.5h-27A1.5 1.5 0 0 1 10 43V5a1.5 1.5 0 0 1 1-1.5z" fill="var(--icon-page)" stroke="var(--icon-edge)" stroke-width="1.2"/><path d="M30 3.5V12a1.5 1.5 0 0 0 1.5 1.5H40" fill="var(--icon-fold)" stroke="var(--icon-edge)" stroke-width="1.2" stroke-linejoin="round"/>${glyph}${label}</svg>`;
}

/** SVG markup for a folder icon. */
export function folderIconSvg(size = 48, open = false) {
  const front = open
    ? '<path d="M7 19.5h37.5l-4 21a1.5 1.5 0 0 1-1.5 1.2H4.8a1 1 0 0 1-1-1.2z" fill="#f2c766" stroke="#c98a1e" stroke-width="1"/>'
    : '<path d="M3.5 17h41v23a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 40z" fill="#f2c766" stroke="#c98a1e" stroke-width="1"/>';
  return `<svg class="ficon" width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true"><path d="M3.5 9A1.5 1.5 0 0 1 5 7.5h13l4 4h21A1.5 1.5 0 0 1 44.5 13v27H3.5z" fill="#e0a43a" stroke="#c98a1e" stroke-width="1"/>${front}</svg>`;
}

/** A small landscape drawn in place of a stage's picture. */
export function stageArtSvg() {
  return `<svg class="stage-art" viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="160" height="90" fill="#8fc3ea"/><circle cx="124" cy="22" r="10" fill="#fff3b0"/><path d="M0 62l28-22 20 14 30-28 34 30 20-12 28 20v26H0z" fill="#6f9a4a"/><path d="M0 72l40-12 36 8 40-10 44 12v20H0z" fill="#4f7d34"/><path d="M66 74h28l-4-10H70z" fill="#9b7a4c"/></svg>`;
}

/** A span holding icon markup (the markup above is built from fixed strings and escaped labels). */
export function iconEl(markup, cls = 'icon') {
  const span = document.createElement('span');
  span.className = cls;
  span.innerHTML = markup;
  return span;
}
