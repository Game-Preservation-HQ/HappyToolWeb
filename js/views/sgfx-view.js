// Scaleform movie (.sgfx / .gfx, CFX / GFX) and plain .swf (CWS / FWS) editor. The tree on the left lists the movie's
// frames and tags (sprites open into their own frames); the panel on the right edits the header and overview (what
// the movie exports and imports, the image files its Scaleform tags name), a tag's fields, or a frame. Every change
// goes on the undo list and the movie is written again in the background; Save folds it into the bundle or file.
import { el, button, toast, pickFiles, confirmBox, openDialog } from '../ui.js';
import { baseName, formatSize, downloadBytes } from '../util.js';
import { menuBar } from '../menubar.js';
import { swfNameForEntry, tagName, TAG_NAMES, readScaleformTag } from '../formats/sgfx.js';
import {
  tagUid, tagBody, decodeTag, freshFields, encodeFields, CODECS, showFrames, walkTags, locateTag, makeTag, cloneTag,
  definedId, withDefinedId, usesOf, freeCharacterId, exportNames, bytesEqual, fromHex,
} from '../formats/swf-tags.js';
import { specsFor, fieldsForm, hexBlock, editHex, colorText, renderActionEditor, setActionEditor } from './sgfx-forms.js';
import { renderActionEditor as renderPcodeEditor } from './avm1-editor.js';

export { renderActionEditor, setActionEditor };

// Action blocks open in the p-code editor; one it can't read falls back to the hex view with the reason.
setActionEditor((container, bytes, onChange) => {
  try {
    return renderPcodeEditor(container, bytes, onChange);
  } catch (e) {
    const draw = (b) => {
      renderActionEditor(container, b, (next) => (onChange(next), draw(next)));
      container.prepend(el('p', { class: 'muted small' }, `The p-code editor can’t read this block (${e.message}); it is shown as bytes.`));
    };
    draw(bytes);
  }
});

const SIGNATURES = [
  ['CFX', 'CFX: Scaleform, zlib'],
  ['GFX', 'GFX: Scaleform, uncompressed'],
  ['CWS', 'CWS: SWF, zlib'],
  ['FWS', 'FWS: SWF, uncompressed'],
];
const GROUP_LIMIT = 300; // tags shown per frame before "Show more"
const FRAME_LIMIT = 500; // frame rows shown per movie or sprite before "Show more"
const SEARCH_LIMIT = 500;

const typing = (t) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
const withExt = (name, ext) => {
  const base = baseName(name || 'movie');
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base) + ext;
};
const clip = (s, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);
const quote = (s) => `“${clip(String(s).replace(/\s+/g, ' '))}”`;

/** The frames of a tag list: [{start, end, shown}] (shown: it ends with a ShowFrame; the last group may not). */
function frameGroups(list) {
  const groups = [];
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i].code !== 1) continue;
    groups.push({ start, end: i + 1, shown: true });
    start = i + 1;
  }
  if (start < list.length) groups.push({ start, end: list.length, shown: false });
  return groups;
}
const frameOf = (list, index) => {
  let f = 0;
  for (let i = 0; i < index; i++) if (list[i].code === 1) f++;
  return f;
};

/** One line about a tag for the tree. */
function summary(tag, names) {
  const named = (id) => (names.get(id)?.length ? ` ${quote(names.get(id)[0])}` : '');
  if (tag.sprite) return `${tag.sprite.frameCount} frame${tag.sprite.frameCount === 1 ? '' : 's'}, ${tag.sprite.tags.length} tags`;
  const f = decodeTag(tag).fields;
  const len = tag.body.length;
  if (!f) return CODECS[tag.code] || tag.code === 39 ? `${len} bytes, kept as bytes` : `${len} bytes`;
  switch (tag.code) {
    case 1:
    case 0:
      return '';
    case 4:
    case 26:
    case 70: {
      const parts = [`depth ${f.depth}`];
      if (f.characterId != null) parts.push(`${f.move ? 'replace with' : 'place'} ${f.characterId}${named(f.characterId)}`);
      else if (f.move) parts.push('move');
      if (f.name != null) parts.push(`as ${quote(f.name)}`);
      if (f.matrix) parts.push(`at ${f.matrix.tx / 20}, ${f.matrix.ty / 20}`);
      if (f.clipDepth != null) parts.push(`masks to ${f.clipDepth}`);
      return parts.join(' · ');
    }
    case 5:
    case 28:
      return `depth ${f.depth}`;
    case 9:
      return colorText(f.color);
    case 12:
      return `${f.actions.length} bytes of actions`;
    case 59:
      return `for ${f.spriteId}${named(f.spriteId)}, ${f.actions.length} bytes`;
    case 43:
      return quote(f.name);
    case 37:
      return [f.variableName && `var ${quote(f.variableName)}`, f.text != null && quote(f.text)].filter(Boolean).join(' · ') || `${(f.bounds.xMax - f.bounds.xMin) / 20} × ${(f.bounds.yMax - f.bounds.yMin) / 20}`;
    case 2:
    case 22:
    case 32:
    case 83:
      return `${(f.bounds.xMax - f.bounds.xMin) / 20} × ${(f.bounds.yMax - f.bounds.yMin) / 20} px · ${f.fills.length} fill${f.fills.length === 1 ? '' : 's'}, ${f.lines.length} line${f.lines.length === 1 ? '' : 's'}`;
    case 46:
    case 84:
      return `${f.fills.length} fills, ${f.lines.length} lines`;
    case 56:
    case 57:
    case 71:
      return `${f.url != null ? `from ${quote(f.url)}: ` : ''}${f.symbols.slice(0, 3).map((s) => `${s.id} ${quote(s.name)}`).join(', ')}${f.symbols.length > 3 ? ` and ${f.symbols.length - 3} more` : ''}`;
    case 74:
    case 78:
      return `for ${f.textId ?? f.characterId}`;
    case 48:
    case 75:
      return quote(f.name);
    case 1000:
      return `Scaleform ${f.version.toString(16)} ${f.swfName ? quote(f.swfName) : ''}`;
    case 1001:
    case 1009:
      return `${quote(f.file)} ${f.width} × ${f.height}`;
    case 1008:
      return `from ${f.imageId}, ${f.x2 - f.x1} × ${f.y2 - f.y1} at ${f.x1}, ${f.y1}`;
    case 77:
      return `${f.xml.length} characters`;
    case 69:
      return `flags 0x${f.flags.toString(16)}`;
    default:
      return `${len} bytes`;
  }
}

export function renderSgfx(node, ctx) {
  const doc = node.model;
  const view = el('div', { class: 'view sgfx-view' }, el('div', { class: 'busy' }, el('span', { class: 'spinner' }), 'Reading the movie…'));
  if (!doc?.ready) {
    view.replaceChildren(el('div', { class: 'banner banner-error' }, 'This movie has no model; reopen it.'));
    return view;
  }
  doc.ready.then(() => {
    if (doc.error) {
      view.replaceChildren(
        el('div', { class: 'banner banner-error' }, `This movie can't be read: ${doc.error}`),
        el('div', { class: 'meta-row' }, button('Show bytes', () => ctx.showHex()), ...downloadButtons(node, doc)),
      );
      return;
    }
    editor(node, ctx, doc, view);
  });
  return view;
}

/** The current file bytes with the first three letters changed for the kind of file asked for. */
async function bytesAs(doc, kind) {
  await doc.flush();
  const b = doc.bytes();
  const zlib = b[0] === 0x43; // C
  const sig = kind === 'swf' ? (zlib ? 'CWS' : 'FWS') : zlib ? 'CFX' : 'GFX';
  const out = b.slice();
  for (let i = 0; i < 3; i++) out[i] = sig.charCodeAt(i);
  return out;
}

function download(node, doc, kind) {
  const name = kind === 'swf' ? swfNameForEntry(node.name) : withExt(node.name, `.${kind}`);
  bytesAs(doc, kind).then((b) => downloadBytes(b, name), (e) => toast(`Can't write the movie: ${e.message}`, 'error'));
}

function downloadButtons(node, doc) {
  return [
    button('Download .sgfx', () => download(node, doc, 'sgfx'), { title: 'The movie with CFX (zlib) or GFX (uncompressed) as its first letters, edits included' }),
    button('.gfx', () => download(node, doc, 'gfx'), { title: 'The same bytes named .gfx' }),
    button('.swf', () => download(node, doc, 'swf'), { title: 'CWS / FWS as the first letters, as the desktop’s Export SWF… writes them; JPEXS FFDec opens it' }),
  ];
}

function editor(node, ctx, doc, view) {
  const movie = doc.movie;
  const ui = (node.ui ??= { sel: { type: 'header' }, open: new Set(), more: new Map(), undo: [], redo: [], filter: '', version: 0, listLimits: new Map() });
  let rows = []; // [{item, el}] of the tree, for the keyboard
  let defsCache = null;

  // ---------- undo ----------
  const run = (c) => {
    if (c.t === 'set') c.obj[c.key] = c.after;
    else if (c.t === 'splice') c.list.splice(c.index, c.removed.length, ...c.inserted);
    else c.cmds.forEach(run);
  };
  const unrun = (c) => {
    if (c.t === 'set') c.obj[c.key] = c.before;
    else if (c.t === 'splice') c.list.splice(c.index, c.inserted.length, ...c.removed);
    else [...c.cmds].reverse().forEach(unrun);
  };
  const info = el('span', { class: 'sgfx-info' });
  const drawInfo = () => { info.textContent = `${label} · ${movie.signature} (${movie.signature[0] === 'C' ? 'zlib' : 'uncompressed'}) · SWF ${movie.version} · ${(movie.rect.xMax - movie.rect.xMin) / 20} × ${(movie.rect.yMax - movie.rect.yMin) / 20} px · ${+(movie.frameRate / 256).toFixed(2)} fps · ${movie.frameCount} frame${movie.frameCount === 1 ? '' : 's'}`; };
  const changed = (keepPanel) => {
    ui.version++;
    defsCache = null;
    drawInfo();
    doc.changed();
    ctx.changed();
    drawTree();
    if (keepPanel) drawStatus();
    else drawPanel();
  };
  function apply(cmd, keepPanel = false) {
    run(cmd);
    ui.undo.push(cmd);
    if (ui.undo.length > 1000) ui.undo.shift();
    ui.redo.length = 0;
    changed(keepPanel);
  }
  const set = (obj, key, after) => ({ t: 'set', obj, key, before: obj[key], after });
  function undo() {
    const c = ui.undo.pop();
    if (!c) return toast('Nothing to undo.');
    unrun(c);
    ui.redo.push(c);
    changed(false);
  }
  function redo() {
    const c = ui.redo.pop();
    if (!c) return toast('Nothing to redo.');
    run(c);
    ui.undo.push(c);
    changed(false);
  }
  /** A structural change in `list`, plus the frame count kept in step when it matched the ShowFrame count before. */
  function structural(list, owner, cmds) {
    const counted = owner ? owner.sprite : movie;
    const before = showFrames(list);
    const matched = counted.frameCount === before;
    cmds.forEach(run);
    const after = showFrames(list);
    [...cmds].reverse().forEach(unrun);
    if (matched && after !== before) cmds.push(set(counted, 'frameCount', after));
    return cmds.length === 1 ? cmds[0] : { t: 'group', cmds };
  }

  // ---------- lookups ----------
  const defs = () => {
    if (defsCache) return defsCache;
    const byId = new Map();
    walkTags(movie.tags, (t) => {
      const id = definedId(t);
      if (id != null && !byId.has(id)) byId.set(id, t);
    });
    return (defsCache = { byId, names: exportNames(movie) });
  };
  const charInfo = (id) => {
    const t = defs().byId.get(id);
    if (!t) return null;
    const n = defs().names.get(id);
    return `${tagName(t.code)} ${id}${n?.length ? ` ${quote(n[0])}` : ''} →`;
  };
  const containerName = (owner) => (owner ? `sprite ${owner.sprite.id}` : 'the movie');
  const where = (tag) => {
    const loc = locateTag(movie, tag);
    if (!loc) return null;
    const f = frameOf(loc.list, loc.index);
    const groups = frameGroups(loc.list);
    const frame = f < groups.length && groups[f].shown ? `frame ${f + 1}` : 'after the last frame';
    return { ...loc, text: `#${loc.index} in ${frame} of ${containerName(loc.owner)}` };
  };

  // ---------- tree ----------
  const ckey = (owner) => (owner ? `s${tagUid(owner)}` : 'm');
  const isOpen = (key, byDefault) => (ui.open.has(key) ? !byDefault : byDefault);
  const toggle = (key) => (ui.open.has(key) ? ui.open.delete(key) : ui.open.add(key));
  const groupDefault = (owner, g) => !owner && g === 0;
  const selKey = (item) => (item.type === 'tag' ? `t${tagUid(item.tag)}` : item.type === 'frame' ? `f${item.key}` : item.type);

  const tree = el('div', { class: 'sgfx-tree', tabindex: '0', role: 'tree', 'aria-label': 'Frames and tags' });
  const panel = el('div', { class: 'sgfx-panel' });
  const status = el('span', { class: 'muted small sgfx-status' });
  const search = el('input', { type: 'search', class: 'input input-sm sgfx-search', placeholder: 'Find tags (name, id, text)…', value: ui.filter, 'aria-label': 'Find tags' });
  let searchTimer = 0;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      ui.filter = search.value.trim();
      drawTree();
    }, 200);
  });

  function tagRow(tag, list, index, owner, depth, names, path = null) {
    const id = definedId(tag);
    const sprite = !!tag.sprite;
    const key = sprite ? `s${tagUid(tag)}` : null;
    const open = sprite && isOpen(key, false);
    const twisty = sprite
      ? el('button', { type: 'button', class: 'twisty', tabindex: '-1', 'aria-label': open ? 'Collapse' : 'Expand', onclick: (e) => (e.stopPropagation(), toggle(key), drawTree()) }, open ? '▾' : '▸')
      : el('span', { class: 'twisty' });
    const n = id != null ? names.get(id) : null;
    const row = el(
      'div',
      { class: 'sgfx-row', role: 'treeitem', style: `padding-left:${depth * 16}px`, 'aria-expanded': sprite ? String(open) : null },
      twisty,
      el('span', { class: 'sgfx-idx muted' }, `#${index}`),
      el('span', { class: 'sgfx-name' }, tagName(tag.code)),
      id != null ? el('span', { class: 'chip' }, String(id)) : null,
      n?.length ? el('span', { class: 'sgfx-export' }, n.join(', ')) : null,
      el('span', { class: 'sgfx-sum muted' }, path ? `${summary(tag, names)} · ${path}` : summary(tag, names)),
    );
    return { item: { type: 'tag', tag, list, index, owner }, el: row, open, key };
  }

  function addContainer(out, list, owner, depth, names) {
    const groups = frameGroups(list);
    const ck = ckey(owner);
    // A sprite with a single frame lists its tags straight under it.
    const flat = owner && groups.length <= 1;
    const frameLimit = ui.more.get(`${ck}:frames`) ?? FRAME_LIMIT;
    groups.slice(0, flat ? 1 : frameLimit).forEach((g, gi) => {
      let d = depth;
      if (!flat) {
        const key = `${ck}:${gi}`;
        const open = isOpen(key, groupDefault(owner, gi));
        const labels = [];
        for (let i = g.start; i < g.end; i++) if (list[i].code === 43) labels.push(decodeTag(list[i]).fields?.name ?? '?');
        const title = g.shown ? `Frame ${gi + 1}` : gi ? `After frame ${gi}` : 'Tags';
        const row = el(
          'div',
          { class: 'sgfx-row sgfx-frame', role: 'treeitem', style: `padding-left:${depth * 16}px`, 'aria-expanded': String(open) },
          el('button', { type: 'button', class: 'twisty', tabindex: '-1', 'aria-label': open ? 'Collapse' : 'Expand', onclick: (e) => (e.stopPropagation(), toggle(key), drawTree()) }, open ? '▾' : '▸'),
          el('span', { class: 'sgfx-name' }, title),
          labels.length ? el('span', { class: 'sgfx-export' }, labels.map(quote).join(', ')) : null,
          el('span', { class: 'sgfx-sum muted' }, `${g.end - g.start} tag${g.end - g.start === 1 ? '' : 's'}`),
        );
        out.push({ item: { type: 'frame', key, list, owner, group: g, frame: gi, title }, el: row, open, key });
        if (!open) return;
        d = depth + 1;
      }
      const gk = `${ck}:${gi}:tags`;
      const limit = ui.more.get(gk) ?? GROUP_LIMIT;
      const end = Math.min(g.end, g.start + limit);
      for (let i = g.start; i < end; i++) {
        const r = tagRow(list[i], list, i, owner, d, names);
        out.push(r);
        if (r.open) addContainer(out, list[i].sprite.tags, list[i], d + 1, names);
      }
      if (g.end > end) out.push(moreRow(d, g.end - end, gk, limit));
    });
    if (!flat && groups.length > frameLimit) out.push(moreRow(depth, groups.length - frameLimit, `${ck}:frames`, frameLimit, 'frames'));
  }
  const moreRow = (depth, left, key, limit, what = 'tags') => ({
    item: { type: 'more' },
    el: el('div', { class: 'sgfx-row sgfx-more', style: `padding-left:${depth * 16 + 18}px` },
      button(`Show ${Math.min(left, limit)} more`, () => (ui.more.set(key, limit + Math.min(left, limit)), drawTree()), { class: 'btn btn-sm' }),
      left > limit ? button(`Show all (${left} more ${what})`, () => (ui.more.set(key, Infinity), drawTree()), { class: 'btn btn-sm' }) : null),
  });

  function searchRows(names) {
    const q = ui.filter.toLowerCase();
    const out = [];
    let total = 0;
    walkTags(movie.tags, (t, list, i, owner) => {
      const id = definedId(t);
      const hay = `${tagName(t.code)} ${t.code} ${id ?? ''} ${(id != null && names.get(id)?.join(' ')) || ''} ${summary(t, names)}`.toLowerCase();
      if (!hay.includes(q)) return true;
      total++;
      if (out.length < SEARCH_LIMIT) out.push(tagRow(t, list, i, owner, 0, names, `frame ${frameOf(list, i) + 1} of ${containerName(owner)}`));
      return true;
    });
    const head = el('div', { class: 'sgfx-row sgfx-frame' }, el('span', { class: 'sgfx-name' }, `${total} tag${total === 1 ? '' : 's'} match`), total > SEARCH_LIMIT ? el('span', { class: 'muted small' }, ` (the first ${SEARCH_LIMIT} are listed)`) : null);
    return [{ item: { type: 'more' }, el: head }, ...out];
  }

  function drawTree() {
    const names = defs().names;
    const out = [];
    if (ui.filter) out.push(...searchRows(names));
    else {
      out.push({ item: { type: 'header' }, el: el('div', { class: 'sgfx-row sgfx-frame', role: 'treeitem' }, el('span', { class: 'twisty' }), el('span', { class: 'sgfx-name' }, 'Movie header and overview'), el('span', { class: 'sgfx-sum muted' }, `${movie.signature} · SWF ${movie.version} · ${movie.tags.length} tags`)) });
      addContainer(out, movie.tags, null, 0, names);
    }
    rows = out.filter((r) => r.item.type !== 'more');
    const sk = selKey(ui.sel);
    for (const r of rows) {
      r.el.addEventListener('click', () => select(r.item));
      r.el.addEventListener('dblclick', () => {
        if (r.key) (toggle(r.key), drawTree());
      });
      if (selKey(r.item) === sk) {
        r.el.classList.add('sel');
        r.el.setAttribute('aria-selected', 'true');
        if (r.item.type === 'frame') ui.sel = r.item; // fresh indices after an edit
      }
    }
    const top = tree.scrollTop;
    tree.replaceChildren(...out.map((r) => r.el));
    tree.scrollTop = top;
  }

  function select(item, scroll = false) {
    ui.sel = item;
    for (const r of rows) {
      const on = selKey(r.item) === selKey(item);
      r.el.classList.toggle('sel', on);
      if (on) {
        r.el.setAttribute('aria-selected', 'true');
        if (scroll) r.el.scrollIntoView({ block: 'nearest' });
      } else r.el.removeAttribute('aria-selected');
    }
    drawPanel();
  }

  /** Selects a tag, opening the frames and sprite it sits in. */
  function reveal(tag) {
    const loc = locateTag(movie, tag);
    if (!loc) return toast('That tag is no longer in the movie.', 'warn');
    const chain = [];
    for (let l = loc; l; ) {
      chain.push(l);
      l = l.owner ? locateTag(movie, l.owner) : null;
    }
    for (const l of chain) {
      const ck = ckey(l.owner);
      const groups = frameGroups(l.list);
      const gi = Math.min(frameOf(l.list, l.index), groups.length - 1);
      const flat = l.owner && groups.length <= 1;
      const key = `${ck}:${gi}`;
      if (!flat && !isOpen(key, groupDefault(l.owner, gi))) toggle(key);
      if (!flat && gi >= (ui.more.get(`${ck}:frames`) ?? FRAME_LIMIT)) ui.more.set(`${ck}:frames`, gi + 1);
      const gk = `${ck}:${gi}:tags`;
      const offset = l.index - groups[gi].start;
      if (offset >= (ui.more.get(gk) ?? GROUP_LIMIT)) ui.more.set(gk, offset + 1);
      if (l.owner && !isOpen(`s${tagUid(l.owner)}`, false)) toggle(`s${tagUid(l.owner)}`);
    }
    if (ui.filter) {
      ui.filter = '';
      search.value = '';
    }
    ui.sel = { type: 'tag', tag, list: loc.list, index: loc.index, owner: loc.owner };
    drawTree();
    select(ui.sel, true);
  }
  const gotoId = (id) => {
    const t = defs().byId.get(id);
    if (t) reveal(t);
    else toast(`Nothing in this movie defines ${id}.`, 'warn');
  };

  tree.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const i = rows.findIndex((r) => selKey(r.item) === selKey(ui.sel));
    const r = rows[i];
    let next = null;
    if (e.key === 'ArrowDown') next = rows[Math.min(rows.length - 1, i + 1)];
    else if (e.key === 'ArrowUp') next = rows[Math.max(0, i - 1)];
    else if (e.key === 'Home') next = rows[0];
    else if (e.key === 'End') next = rows.at(-1);
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Enter') && r?.key) {
      if ((e.key === 'ArrowRight' && r.open) || (e.key === 'ArrowLeft' && !r.open)) return;
      e.preventDefault();
      toggle(r.key);
      drawTree();
      return;
    } else return;
    e.preventDefault();
    if (next) select(next.item, true);
  });

  // ---------- tag operations ----------
  const selTag = () => (ui.sel.type === 'tag' && locateTag(movie, ui.sel.tag) ? ui.sel.tag : null);
  const movable = (loc, d) => {
    const j = loc.index + d;
    return j >= 0 && j < loc.list.length && loc.list[loc.index].code !== 0 && loc.list[j].code !== 0;
  };

  async function deleteTag(tag = selTag()) {
    if (!tag) return;
    const loc = locateTag(movie, tag);
    if (tag.code === 0) return toast('The End tag closes the tag list; it stays.', 'warn');
    const id = definedId(tag);
    if (id != null) {
      const uses = usesOf(movie, id, tag).filter((u) => definedId(u.tag) !== id || u.tag.code === 56);
      if (uses.length) {
        const list = uses.slice(0, 6).map((u) => `${tagName(u.tag.code)} in ${containerName(u.owner)} ${u.how}`).join('; ');
        const ok = await confirmBox(`${uses.length} tag${uses.length === 1 ? ' uses' : 's use'} character ${id}: ${list}${uses.length > 6 ? '; …' : ''}. Delete ${tagName(tag.code)} ${id} anyway? The movie may not play.`, 'Delete', true);
        if (!ok) return;
      }
    }
    apply(structural(loc.list, loc.owner, [{ t: 'splice', list: loc.list, index: loc.index, removed: [tag], inserted: [] }]));
    const next = loc.list[Math.min(loc.index, loc.list.length - 1)];
    if (next) reveal(next);
  }

  function duplicateTag(tag = selTag()) {
    if (!tag) return;
    if (tag.code === 0) return toast('A movie has one End tag per tag list.', 'warn');
    const loc = locateTag(movie, tag);
    let copy = cloneTag(tag);
    const id = definedId(tag);
    if (id != null) {
      const fresh = freeCharacterId(movie);
      copy = withDefinedId(tag, fresh);
      toast(`The copy defines character ${fresh} (the original keeps ${id}).`);
    }
    apply(structural(loc.list, loc.owner, [{ t: 'splice', list: loc.list, index: loc.index + 1, removed: [], inserted: [copy] }]));
    reveal(copy);
  }

  function moveTag(d, tag = selTag()) {
    if (!tag) return;
    const loc = locateTag(movie, tag);
    if (!movable(loc, d)) return toast(tag.code === 0 ? 'The End tag stays last.' : 'It can’t move further.', 'warn');
    const j = loc.index + d;
    const lo = Math.min(loc.index, j);
    const pair = [loc.list[lo], loc.list[lo + 1]];
    apply(structural(loc.list, loc.owner, [{ t: 'splice', list: loc.list, index: lo, removed: pair, inserted: [pair[1], pair[0]] }]));
    reveal(tag);
  }

  /** New bytes for a tag (a sprite's are read into its tag list again, so the tag is replaced). */
  function setTagBytes(tag, bytes) {
    if (bytesEqual(bytes, tagBody(tag))) return toast('The bytes are the same.');
    const loc = locateTag(movie, tag);
    if (tag.code === 39) {
      const next = makeTag(39, bytes, tag.long);
      apply({ t: 'splice', list: loc.list, index: loc.index, removed: [tag], inserted: [next] });
      if (!next.sprite) toast('The sprite’s tags don’t parse; it is kept as bytes.', 'warn');
      reveal(next);
      return;
    }
    apply(set(tag, 'body', bytes));
    const d = decodeTag(tag);
    if (CODECS[tag.code] && d.error) toast(`${tagName(tag.code)} keeps the new bytes, but ${d.error.charAt(0).toLowerCase()}${d.error.slice(1)}`, 'warn', 8000);
  }

  async function hexEditTag(tag = selTag()) {
    if (!tag) return;
    const next = await editHex(`${tagName(tag.code)} bytes`, tagBody(tag), 'The tag’s body, without its 2- or 6-byte tag header.');
    if (next) setTagBytes(tag, next);
  }
  const binName = (tag) => `${withExt(node.name, '')}-${tagName(tag.code).replace(/\W+/g, '')}${definedId(tag) != null ? `-${definedId(tag)}` : ''}.bin`;
  function exportTag(tag = selTag()) {
    if (tag) downloadBytes(tagBody(tag), binName(tag));
  }
  async function importTag(tag = selTag()) {
    if (!tag) return;
    const [f] = await pickFiles();
    if (f) setTagBytes(tag, new Uint8Array(await f.arrayBuffer()));
  }

  /** Where "Add tag" puts a tag: after the selected tag, at the end of the selected frame, else in the movie's first frame. */
  function insertPoint() {
    const tag = selTag();
    if (tag) {
      const loc = locateTag(movie, tag);
      return { ...loc, index: tag.code === 0 ? loc.index : loc.index + 1 };
    }
    if (ui.sel.type === 'frame') {
      const { list, owner, group } = ui.sel;
      const last = list[group.end - 1];
      return { list, owner, index: last && (last.code === 1 || last.code === 0) ? group.end - 1 : group.end };
    }
    const first = movie.tags.findIndex((t) => t.code === 1 || t.code === 0);
    return { list: movie.tags, owner: null, index: first < 0 ? movie.tags.length : first };
  }

  async function addTag() {
    const at = insertPoint();
    const res = await openDialog((dlg, done) => {
      dlg.classList.add('dialog-wide');
      const codes = Object.keys(TAG_NAMES).map(Number).sort((a, b) => a - b);
      const code = el('input', { type: 'text', class: 'input sgfx-num', value: '12', 'aria-label': 'Tag code' });
      const pick = el('select', { class: 'input', 'aria-label': 'Tag type' }, ...codes.map((c) => el('option', { value: String(c), selected: c === 12 }, `${TAG_NAMES[c]} (${c})`)));
      pick.addEventListener('change', () => (code.value = pick.value));
      code.addEventListener('input', () => (pick.value = String(Number(code.value))));
      const long = el('input', { type: 'checkbox' });
      const ta = el('textarea', { class: 'input sgfx-hex-input', rows: 10, spellcheck: 'false', autofocus: true, placeholder: 'Body bytes as hex, for example 00 00' });
      const err = el('p', { class: 'muted small' }, `It goes in at #${at.index} of ${containerName(at.owner)}. The body is the tag without its 2- or 6-byte header.`);
      const ok = () => {
        const c = Number(code.value);
        if (!Number.isInteger(c) || c < 0 || c > 1023) return ((err.textContent = 'A tag code is a whole number from 0 to 1023.'), (err.className = 'banner banner-error'));
        try {
          done({ code: c, body: fromHex(ta.value), long: long.checked });
        } catch (e) {
          err.textContent = e.message;
          err.className = 'banner banner-error';
        }
      };
      dlg.append(
        el('h2', { class: 'dialog-title' }, 'Add a tag'),
        el('div', { class: 'meta-row' }, el('label', {}, 'Type '), pick, el('label', {}, 'Code '), code, el('label', { class: 'check' }, long, ' Long header')),
        ta,
        err,
        el('div', { class: 'dialog-actions' }, button('Cancel', () => done(null)), button('Add', ok, { class: 'btn btn-primary' })),
      );
    });
    if (!res) return;
    const tag = makeTag(res.code, res.body, res.long);
    apply(structural(at.list, at.owner, [{ t: 'splice', list: at.list, index: at.index, removed: [], inserted: [tag] }]));
    const d = decodeTag(tag);
    if (CODECS[res.code] && d.error) toast(`Added, but ${d.error.charAt(0).toLowerCase()}${d.error.slice(1)}`, 'warn', 8000);
    reveal(tag);
  }

  // ---------- panel ----------
  function drawStatus() {
    // After a field edit: the tag's size and hex in the panel follow its new bytes, the form stays as it is.
    const tag = selTag();
    const hex = panel.querySelector('.sgfx-panel-hex');
    const size = panel.querySelector('.sgfx-size');
    if (tag && hex) hex.replaceChildren(hexBlock(tagBody(tag)));
    if (tag && size) size.textContent = sizeText(tag);
  }
  const sizeText = (tag) => {
    const n = tagBody(tag).length;
    return `${n} byte${n === 1 ? '' : 's'} + ${tag.long || n >= 63 ? 6 : 2}-byte header`;
  };

  function drawPanel() {
    const top = panel.scrollTop;
    const sel = ui.sel;
    if (sel.type === 'tag' && selTag()) panel.replaceChildren(...tagPanel(sel.tag));
    else if (sel.type === 'frame') panel.replaceChildren(...framePanel(sel));
    else {
      ui.sel = { type: 'header' };
      panel.replaceChildren(...headerPanel());
    }
    if (selKey(sel) === panel.dataset.key) panel.scrollTop = top;
    panel.dataset.key = selKey(sel);
  }

  const section = (title, ...children) => el('section', { class: 'sgfx-section' }, el('h3', {}, title), ...children);
  const table = (head, rows) =>
    el('div', { class: 'grid-wrap sgfx-table' },
      el('table', { class: 'grid' },
        el('thead', {}, el('tr', {}, ...head.map(([label, num]) => el('th', num ? { class: 'num' } : {}, label)))),
        el('tbody', {}, ...rows.map((cells) => el('tr', {}, ...cells.map((c, i) => el('td', head[i][1] ? { class: 'num' } : head[i][2] ? { class: 'name' } : {}, c)))))));

  function headerPanel() {
    // Each header change is one undo step on the movie.
    const num = (label, value, min, max, put, step = 1) => {
      const input = el('input', { type: 'text', class: 'input sgfx-num', value: String(value), 'aria-label': label });
      input.addEventListener('change', () => {
        const n = Number(input.value);
        if (!Number.isFinite(n) || n < min || n > max || (step === 1 && !Number.isInteger(n))) {
          toast(`${label}: ${input.value} is not ${step === 1 ? 'a whole number' : 'a number'} from ${min} to ${max}`, 'error');
          input.value = String(value);
          return;
        }
        put(n);
      });
      return input;
    };
    const field = (label, control, hint = null) => el('div', { class: 'sgfx-field' }, el('span', { class: 'sgfx-label' }, label), el('div', { class: 'sgfx-control' }, control, hint ? el('span', { class: 'muted small' }, ` ${hint}`) : null));
    const sig = el('select', { class: 'input', 'aria-label': 'Signature' }, ...SIGNATURES.map(([v, l]) => el('option', { value: v, selected: v === movie.signature }, l)));
    sig.addEventListener('change', () => apply(set(movie, 'signature', sig.value)));
    // A new rect object (the bit width is kept while the values fit), so undo puts the old one back.
    const setRect = (k, v) => apply(set(movie, 'rect', { ...movie.rect, [k]: v }));
    const twips = (k, label) => num(label, movie.rect[k], -(2 ** 30), 2 ** 30 - 1, (v) => setRect(k, v));
    const frames = showFrames(movie.tags);
    const bg = movie.tags.find((t) => t.code === 9);
    const bgField = bg && decodeTag(bg).fields;
    let bgControl;
    if (bgField) {
      const pick = el('input', { type: 'color', value: `#${bgField.color.map((x) => x.toString(16).padStart(2, '0')).join('')}`, 'aria-label': 'Background colour' });
      pick.addEventListener('change', () => {
        const h = pick.value;
        apply(set(bg, 'body', encodeFields(9, { color: [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) })));
      });
      bgControl = el('span', { class: 'sgfx-inline' }, pick, el('span', { class: 'muted small' }, colorText(bgField.color)), button('Go to tag', () => reveal(bg), { class: 'btn btn-sm' }));
    } else
      bgControl = button('Add a SetBackgroundColor tag', () => {
        const at = Math.max(0, movie.tags.findIndex((t) => t.code !== 69));
        const tag = makeTag(9, encodeFields(9, { color: [0, 0, 0] }));
        apply({ t: 'splice', list: movie.tags, index: at, removed: [], inserted: [tag] });
      }, { class: 'btn btn-sm' });
    const out = [
      el('div', { class: 'sgfx-panel-head' }, el('h2', {}, 'Movie header'), el('span', { class: 'muted small' }, `${formatSize(doc.encoded.length)} as last written · ${movie.tags.length} top-level tags`)),
      el('div', { class: 'sgfx-form' },
        field('Signature', sig, 'Letters 1-3: C… is zlib-compressed'),
        field('SWF version', num('SWF version', movie.version, 0, 255, (v) => apply(set(movie, 'version', v)))),
        field('Stage left / right', el('span', { class: 'sgfx-inline' }, twips('xMin', 'Stage left'), twips('xMax', 'Stage right')), `twips; ${(movie.rect.xMax - movie.rect.xMin) / 20} px wide`),
        field('Stage top / bottom', el('span', { class: 'sgfx-inline' }, twips('yMin', 'Stage top'), twips('yMax', 'Stage bottom')), `twips; ${(movie.rect.yMax - movie.rect.yMin) / 20} px high`),
        field('Frame rate', num('Frame rate', +(movie.frameRate / 256).toFixed(4), 0, 255.996, (v) => apply(set(movie, 'frameRate', Math.round(v * 256))), 0), `fps (stored as ${movie.frameRate} / 256)`),
        field('Frame count', el('span', { class: 'sgfx-inline' }, num('Frame count', movie.frameCount, 0, 65535, (v) => apply(set(movie, 'frameCount', v))), frames !== movie.frameCount ? button(`Set to ${frames}`, () => apply(set(movie, 'frameCount', frames)), { class: 'btn btn-sm', title: 'The number of ShowFrame tags in the movie' }) : null), `${frames} ShowFrame tag${frames === 1 ? '' : 's'}`),
        field('Background', bgControl),
      ),
    ];
    out.push(...overview());
    return out;
  }

  function overview() {
    const out = [];
    const tops = movie.tags;
    const exporter = tops.find((t) => t.code === 1000);
    const ex = exporter && decodeTag(exporter).fields;
    if (ex) out.push(el('p', { class: 'muted small' }, `Exported by Scaleform ${ex.version.toString(16)} as ${ex.swfName || '(no name)'}, bitmap format ${ex.bitmapFormat}. `, button('Go to tag', () => reveal(exporter), { class: 'btn btn-sm' })));
    const siblings = node.parent?.model?.entries ?? [];
    const sibling = (file) => siblings.findIndex((e) => !e.pointer && e.name.toLowerCase() === String(file).toLowerCase());
    const files = [];
    for (const t of tops) {
      if (t.code < 1001 || t.code > 1009 || t.code === 1008 || t.code === 1000) continue;
      let f = decodeTag(t).fields;
      if (!f) {
        try {
          f = readScaleformTag(t.code, t.body);
        } catch {
          f = null;
        }
      }
      if (f?.file !== undefined) files.push({ tag: t, ...f });
    }
    if (files.length) {
      out.push(section(`External files (${files.length})`, table([['Tag'], ['Id', true], ['File', false, true], ['Size'], ['Export name'], ['']], files.slice(0, 1000).map((f) => {
        const i = ctx.openSibling ? sibling(f.file) : -1;
        return [tagName(f.tag.code), f.id ?? '', f.file, f.width != null ? `${f.width} × ${f.height}` : '', f.exportName ?? '',
          el('span', { class: 'sgfx-inline' }, button('Edit', () => reveal(f.tag), { class: 'btn btn-sm', title: 'Select the tag to change the file name' }), i >= 0 ? button('Open', () => ctx.openSibling(i), { class: 'btn btn-sm', title: `Open ${f.file} from this bundle` }) : null)];
      }))));
    }
    const exports = [];
    const imports = [];
    for (const t of tops) {
      const f = (t.code === 56 || t.code === 57 || t.code === 71) && decodeTag(t).fields;
      if (!f) continue;
      for (const s of f.symbols) (t.code === 56 ? exports : imports).push({ tag: t, url: f.url, ...s });
    }
    if (exports.length)
      out.push(section(`Exported names (${exports.length})`, table([['Id', true], ['Name', false, true], ['']], exports.slice(0, 1000).map((e) => [e.id, e.name, button('Go to', () => gotoId(e.id), { class: 'btn btn-sm', title: 'Select the tag that defines it' })]))));
    if (imports.length) out.push(section(`Imports (${imports.length})`, table([['From', false, true], ['Id', true], ['Name', false, true], ['']], imports.slice(0, 1000).map((m) => [m.url, m.id, m.name, button('Edit', () => reveal(m.tag), { class: 'btn btn-sm' })]))));
    return out;
  }

  function framePanel(sel) {
    const { list, owner, group, title } = sel;
    const tags = list.slice(group.start, group.end);
    const counts = new Map();
    for (const t of tags) counts.set(tagName(t.code), (counts.get(tagName(t.code)) ?? 0) + 1);
    return [
      el('div', { class: 'sgfx-panel-head' }, el('h2', {}, `${title} of ${containerName(owner)}`), el('span', { class: 'muted small' }, `tags #${group.start} to #${group.end - 1}`)),
      el('div', { class: 'meta-row' }, button('Add tag here…', addTag, { title: 'Adds a tag at the end of this frame, before its ShowFrame' })),
      section('Tags in this frame', table([['Tag'], ['Count', true]], [...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]))),
    ];
  }

  function tagPanel(tag) {
    const loc = where(tag);
    const id = definedId(tag);
    const d = decodeTag(tag);
    const body = tagBody(tag);
    const longBox = el('input', { type: 'checkbox', checked: tag.long || body.length >= 63, disabled: body.length >= 63, 'aria-label': 'Long tag header' });
    longBox.addEventListener('change', () => apply(set(tag, 'long', longBox.checked), true));
    const ops = el('div', { class: 'meta-row sgfx-ops' },
      button('Delete', () => deleteTag(tag), { class: 'btn btn-sm btn-danger-quiet', disabled: tag.code === 0, title: 'Delete (Delete)' }),
      button('Duplicate', () => duplicateTag(tag), { class: 'btn btn-sm', disabled: tag.code === 0, title: 'Duplicate (Ctrl+D)' }),
      button('Move up', () => moveTag(-1, tag), { class: 'btn btn-sm', disabled: !movable(loc, -1), title: 'Move up (Alt+↑)' }),
      button('Move down', () => moveTag(1, tag), { class: 'btn btn-sm', disabled: !movable(loc, 1), title: 'Move down (Alt+↓)' }),
      button('Edit hex…', () => hexEditTag(tag), { class: 'btn btn-sm' }),
      button('Export .bin', () => exportTag(tag), { class: 'btn btn-sm', title: 'Download the tag’s body' }),
      button('Import .bin…', () => importTag(tag), { class: 'btn btn-sm', title: 'Replace the tag’s body with a file' }),
      button('Add tag after…', addTag, { class: 'btn btn-sm' }),
      el('label', { class: 'check', title: 'A 6-byte header with a 32-bit length; bodies of 63 bytes or more always have one' }, longBox, ' Long header'),
    );
    const out = [
      el('div', { class: 'sgfx-panel-head' },
        el('h2', {}, `${tagName(tag.code)} (${tag.code})${id != null ? ` · id ${id}` : ''}`),
        el('span', { class: 'muted small' }, `${loc.text} · `, el('span', { class: 'sgfx-size' }, sizeText(tag)))),
      ops,
    ];
    if (id != null) {
      const names = defs().names.get(id);
      const uses = usesOf(movie, id, tag);
      const shown = uses.slice(0, 40);
      out.push(el('div', { class: 'sgfx-uses' },
        names?.length ? el('div', {}, el('span', { class: 'muted small' }, 'Exported as '), names.map(quote).join(', ')) : null,
        el('div', {}, el('span', { class: 'muted small' }, uses.length ? `Used by ${uses.length} tag${uses.length === 1 ? '' : 's'}: ` : 'Nothing in this movie uses it.'),
          ...shown.map((u) => button(`${tagName(u.tag.code)}${u.owner ? ` in sprite ${u.owner.sprite.id}` : ''}`, () => reveal(u.tag), { class: 'btn btn-sm btn-link', title: u.how })),
          uses.length > shown.length ? el('span', { class: 'muted small' }, ` and ${uses.length - shown.length} more`) : null)));
    }
    const formHost = el('div', { class: 'sgfx-form-host' });
    if (d.fields) {
      const specs = specsFor(tag.code, d.fields);
      const fields = freshFields(tag);
      const io = {
        version: movie.version,
        commit: () => {
          if (tag.sprite) {
            const cmds = [];
            if (fields.id !== tag.sprite.id) cmds.push(set(tag.sprite, 'id', fields.id));
            if (fields.frameCount !== tag.sprite.frameCount) cmds.push(set(tag.sprite, 'frameCount', fields.frameCount));
            if (cmds.length) apply({ t: 'group', cmds }, true);
            return true;
          }
          let next;
          try {
            next = encodeFields(tag.code, fields);
          } catch (e) {
            toast(`That doesn’t fit: ${e.message}`, 'error');
            return false;
          }
          if (!bytesEqual(next, tag.body)) apply(set(tag, 'body', next), true);
          return true;
        },
        redraw: () => formHost.replaceChildren(fieldsForm(specs, fields, io)),
        charInfo,
        goto: gotoId,
        listLimit: (k) => ui.listLimits.get(`${tagUid(tag)}:${k}`),
        setListLimit: (k, n) => ui.listLimits.set(`${tagUid(tag)}:${k}`, n),
      };
      if (specs) io.redraw();
      if (tag.sprite) {
        const n = showFrames(tag.sprite.tags);
        formHost.append(el('p', { class: 'muted small' }, `${tag.sprite.tags.length} tags, ${n} ShowFrame${n === 1 ? '' : 's'}. `, n !== tag.sprite.frameCount ? button(`Set the frame count to ${n}`, () => apply(set(tag.sprite, 'frameCount', n)), { class: 'btn btn-sm' }) : null));
      }
    } else if (d.error) out.push(el('div', { class: 'banner banner-warn' }, d.error, ' Edit hex… changes it.'));
    else if (tag.code === 1) out.push(el('p', { class: 'muted' }, 'ShowFrame ends a frame: the tags above it, up to the last ShowFrame, are one frame.'));
    else if (tag.code !== 0) out.push(el('p', { class: 'muted' }, 'This tag type has no field editor; Edit hex… changes its bytes.'));
    out.push(formHost);
    if (!tag.sprite) out.push(el('details', { class: 'sgfx-hexbox', open: !d.fields && body.length > 0 && body.length <= 4096 }, el('summary', {}, 'Bytes'), el('div', { class: 'sgfx-panel-hex' }, hexBlock(body))));
    return out;
  }

  // ---------- frame ----------
  const fileMenu = ctx.file;
  const menus = [
    {
      label: 'File',
      items: () => [
        fileMenu?.open && { label: 'Open…', run: fileMenu.open, enabled: () => !node.parent },
        fileMenu?.save && { label: 'Save', keys: 'Ctrl+S', run: fileMenu.save },
        fileMenu?.saveAs && { label: 'Save as…', run: fileMenu.saveAs },
        null,
        { label: 'Download as .sgfx', run: () => download(node, doc, 'sgfx') },
        { label: 'Download as .gfx', run: () => download(node, doc, 'gfx') },
        { label: 'Download as .swf', run: () => download(node, doc, 'swf') },
        null,
        fileMenu?.reload && { label: 'Reload', run: fileMenu.reload },
        fileMenu?.close && { label: fileMenu.closeLabel ?? 'Close', run: fileMenu.close },
      ].filter((x) => x !== undefined && x !== false),
    },
    {
      label: 'Edit',
      items: () => [
        { label: 'Undo', keys: 'Ctrl+Z', run: undo, enabled: () => ui.undo.length > 0 },
        { label: 'Redo', keys: 'Ctrl+Y', run: redo, enabled: () => ui.redo.length > 0 },
        null,
        { label: 'Delete tag', keys: 'Delete', run: () => deleteTag(), enabled: () => !!selTag() && selTag().code !== 0 },
        { label: 'Duplicate tag', keys: 'Ctrl+D', run: () => duplicateTag(), enabled: () => !!selTag() && selTag().code !== 0 },
        { label: 'Move up', keys: 'Alt+↑', run: () => moveTag(-1), enabled: () => !!selTag() && movable(locateTag(movie, selTag()), -1) },
        { label: 'Move down', keys: 'Alt+↓', run: () => moveTag(1), enabled: () => !!selTag() && movable(locateTag(movie, selTag()), 1) },
        null,
        { label: 'Find tags', keys: 'Ctrl+F', run: () => search.focus() },
      ],
    },
    {
      label: 'Tag',
      items: () => [
        { label: 'Edit hex…', run: () => hexEditTag(), enabled: () => !!selTag() },
        { label: 'Export body .bin', run: () => exportTag(), enabled: () => !!selTag() },
        { label: 'Import body…', run: () => importTag(), enabled: () => !!selTag() },
        null,
        { label: 'Add tag from hex…', run: addTag },
        null,
        { label: 'Movie header', run: () => select({ type: 'header' }, true) },
      ],
    },
  ];
  const label = node.parent ? `${baseName(node.parent.name)} → ${node.name}` : node.name;
  view.addEventListener('keydown', (e) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const t = typing(e.target) && e.target !== tree;
    let act = null;
    if (ctrl && !e.altKey && k === 'f' && !e.shiftKey) act = () => (search.focus(), search.select());
    else if (t) return;
    else if (ctrl && !e.altKey && ((k === 'z' && !e.shiftKey) || false)) act = undo;
    else if (ctrl && !e.altKey && (k === 'y' || (k === 'z' && e.shiftKey))) act = redo;
    else if (ctrl && !e.altKey && !e.shiftKey && k === 'd') act = () => duplicateTag();
    else if (!ctrl && !e.altKey && !e.shiftKey && k === 'Delete') act = () => deleteTag();
    else if (e.altKey && !ctrl && (k === 'ArrowUp' || k === 'ArrowDown')) act = () => moveTag(k === 'ArrowUp' ? -1 : 1);
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    act();
  });

  view.replaceChildren(
    el('div', { class: 'meta-row' }, info, el('span', { class: 'spacer' }), ...downloadButtons(node, doc)),
    el('div', { class: 'toolbar sgfx-toolbar' }, menuBar(menus, 'Movie editor menu'), button('Undo', undo, { class: 'btn btn-sm', title: 'Undo (Ctrl+Z)' }), button('Redo', redo, { class: 'btn btn-sm', title: 'Redo (Ctrl+Y)' }), search, status),
    el('div', { class: 'sgfx-editor' }, tree, panel),
  );
  status.textContent = movie.trailing.length ? `${movie.trailing.length} bytes after the End tag are kept` : '';
  drawInfo();
  drawTree();
  drawPanel();
}
