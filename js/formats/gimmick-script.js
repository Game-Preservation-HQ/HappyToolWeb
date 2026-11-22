// Stage script: the gimmick calls of a stage's stage_setting.nut — SetGimmickColor / SetGimmickBuild( "tag", VALUE ) in
// GimmickSetting's cases — and its gStageGimmickFileList, read and rewritten in place. Values are swapped where they
// stand and missing calls / entries are inserted after their siblings; every other byte (Shift-JIS comments, line
// endings, the loose copy's marker line) stays as it was. Port of the desktop's StageGimmickScript and
// GameplayJsonRecords (HappyTool/Formats/StageGimmickScript.cs).
//
// `case 2` (sbabA, sligB) has the castles' colours swapped relative to `case 0`; a team set for a tag is written swapped
// in any case where that tag starts swapped, or — for a tag that starts neutral or has no call there yet — where the
// stage's castles do. What settingID_ selects is not known.

import { tokenize } from './squirrel.js';
import { decodeText, encodeText, bytesEqual } from '../util.js';

export const SET_COLOR = 'SetGimmickColor', SET_BUILD = 'SetGimmickBuild', SETUP_FUNCTION = 'GimmickSetting';
export const WHITE = 'POWER_COLOR_WHITE', BLACK = 'POWER_COLOR_BLACK', NEUTRAL = 'POWER_COLOR_UNKNOWN';
export const swapColor = (c) => (c === WHITE ? BLACK : c === BLACK ? WHITE : c);

/** The script's tokens without spaces and comments: {kind: 'ident'|'string'|'number'|'op', text, start, length}. Keywords
 *  count as names, as in the desktop's lexer; a string's text is without its quotes. */
function lex(text) {
  const out = [];
  for (const k of tokenize(text)) {
    if (k.t === 'space' || k.t === 'comment') continue;
    const raw = text.slice(k.s, k.e);
    const t = k.t === 'string' ? raw.slice(raw[0] === '@' ? 2 : 1, raw.length > 1 ? -1 : undefined) : raw;
    out.push({ kind: k.t === 'keyword' ? 'ident' : k.t, text: t, start: k.s, length: k.e - k.s });
  }
  return out;
}

/**
 * The script's gimmick calls ({fn, case, name, tag, value, nameStart, valueStart, valueLength, end, spaced}; end: just
 * after its `;`, or its `)` when there is none), GimmickSetting's case labels in file order with where each is
 * ([word start, just after its `:`]), and its file list (filesOpen: just after the `[`, −1 = no list; filesLastStart /
 * filesEnd: the last entry, −1 = an empty list). Read.
 */
export function readGimmickScript(text) {
  const info = { calls: [], setupCases: [], setupCaseAt: new Map(), files: [], filesOpen: -1, filesLastStart: -1, filesEnd: -1, filesCommas: false };
  const tk = lex(text);
  const is = (j, s) => j < tk.length && tk[j].kind === 'op' && tk[j].text === s;
  let func = null, label = null, depth = 0, funcDepth = -1;
  for (let i = 0; i < tk.length; i++) {
    const t = tk[i];
    if (is(i, '{')) {
      depth++;
      continue;
    }
    if (is(i, '}')) {
      depth--;
      if (depth <= funcDepth) [func, label, funcDepth] = [null, null, -1];
      continue;
    }
    if (t.kind !== 'ident') continue;
    if (t.text === 'function' && tk[i + 1]?.kind === 'ident') {
      [func, funcDepth, label] = [tk[i + 1].text, depth, null];
      continue;
    }
    const isCase = t.text === 'case' && is(i + 2, ':');
    if (isCase || (t.text === 'default' && is(i + 1, ':'))) {
      label = isCase ? `case ${tk[i + 1].text}` : 'default';
      if (func === SETUP_FUNCTION && !info.setupCases.includes(label)) {
        info.setupCases.push(label);
        info.setupCaseAt.set(label, [t.start, tk[i + (isCase ? 2 : 1)].start + 1]);
      }
      continue;
    }
    if ((t.text === SET_COLOR || t.text === SET_BUILD) && i + 5 < tk.length && is(i + 1, '(') && tk[i + 2].kind === 'string' &&
        is(i + 3, ',') && tk[i + 4].kind === 'ident' && is(i + 5, ')')) {
      const end = is(i + 6, ';') ? tk[i + 6].start + 1 : tk[i + 5].start + 1;
      info.calls.push({
        fn: func, case: label, name: t.text, tag: tk[i + 2].text, value: tk[i + 4].text, nameStart: t.start,
        valueStart: tk[i + 4].start, valueLength: tk[i + 4].length, end, spaced: text[tk[i + 1].start + 1] === ' ',
      });
      i += 5;
      continue;
    }
    if (t.text === 'gStageGimmickFileList') {
      let j = i + 1;
      while (j < tk.length && !is(j, '[') && tk[j].kind !== 'ident') j++;
      if (!is(j, '[')) continue;
      info.filesOpen = tk[j].start + 1;
      for (j++; j < tk.length && !is(j, ']'); j++) {
        if (is(j, ',')) info.filesCommas = true;
        if (tk[j].kind !== 'string') continue;
        info.files.push(tk[j].text);
        info.filesLastStart = tk[j].start;
        info.filesEnd = tk[j].start + tk[j].length;
      }
      i = j;
    }
  }
  return info;
}

const setupCalls = (info, name) => info.calls.filter((c) => c.fn === SETUP_FUNCTION && c.name === name);
const callText = (name, tag, value, spaced) => (spaced ? `${name}( "${tag}", ${value} );` : `${name}("${tag}", ${value});`);

/** Only spaces / tabs from `from` up to `to`. */
function onlySpace(t, from, to) {
  for (let i = from; i < to; i++) if (t[i] !== ' ' && t[i] !== '\t') return false;
  return true;
}
/** The line holding `at`: its start, its end (before \r\n / \n) and its end-of-line (the line before's for a last line
 *  that has none). */
function lineAround(t, at) {
  let start = at;
  while (start > 0 && t[start - 1] !== '\n') start--;
  let end = at;
  while (end < t.length && t[end] !== '\n') end++;
  const crlf = end < t.length ? end > start && t[end - 1] === '\r' : start >= 2 && t[start - 2] === '\r';
  if (crlf && end < t.length) end--;
  return { start, end, eol: crlf ? '\r\n' : '\n' };
}
function leadingSpace(t, start) {
  let i = start;
  while (i < t.length && (t[i] === ' ' || t[i] === '\t')) i++;
  return t.slice(start, i);
}
const onlyComment = (rest) => rest.length === 0 || (rest.startsWith('//') && !rest.includes('/*'));
/** Where a call goes after `anchor`: at the end of its line when only a comment follows it there, else right after it;
 *  indented as the anchor when it starts its line, else one tab in from its line. InsertAt. */
function insertAt(t, anchor) {
  const line = lineAround(t, anchor.end);
  const nameLine = lineAround(t, anchor.nameStart).start;
  const indent = onlySpace(t, nameLine, anchor.nameStart) ? t.slice(nameLine, anchor.nameStart) : `${leadingSpace(t, nameLine)}\t`;
  return { at: onlyComment(t.slice(anchor.end, line.end).trim()) ? line.end : anchor.end, eol: line.eol, indent };
}
/** Where a call goes under a case label with nothing to follow: as insertAt, after the label's `:`. AfterLabel. */
function afterLabel(t, word, colonEnd) {
  const line = lineAround(t, colonEnd);
  const indent = `${leadingSpace(t, lineAround(t, word).start)}\t`;
  return { at: onlyComment(t.slice(colonEnd, Math.max(colonEnd, line.end)).trim()) ? line.end : colonEnd, eol: line.eol, indent };
}

/** The script's brace depth at its end, or null when it closes more than it opens. */
function braceBalance(text) {
  let d = 0;
  for (const k of lex(text)) {
    if (k.kind !== 'op') continue;
    if (k.text === '{') d++;
    else if (k.text === '}' && --d < 0) return null;
  }
  return d;
}

/**
 * The script with the plan applied ({teams: {tag: POWER_COLOR_* as in the first case}, builds: {tag:
 * RULE_BUILDING_STATE_*}, files: [bundle names]}). Teams: every GimmickSetting call for the tag gets the team (swapped in
 * a case where the tag starts swapped); a case with colour calls but none for the tag gets one. Builds: the tag's calls
 * get the state, or one is added to the first case (after its build calls, else its colour calls). Returns {text,
 * changed, inserted, filesAdded}; throws when the result doesn't read back as planned. Apply.
 */
export function applyGimmickScript(original, plan) {
  const res = { changed: 0, inserted: 0, filesAdded: 0 };
  const info = readGimmickScript(original);
  const edits = []; // [offset, length replaced, text]
  const replace = (at, length, text) => edits.push([at, length, text]);
  const expectColor = new Map(), expectBuild = new Map(); // "case|tag" → value

  const colors = setupCalls(info, SET_COLOR);
  const first = info.setupCases[0] ?? null;
  // Per case: do the castles start swapped relative to the first case?
  const swappedCase = new Map();
  for (const c of info.setupCases) {
    let same = 0, swapped = 0;
    for (const call of colors.filter((x) => x.case === c)) {
      const f = colors.find((x) => x.case === first && x.tag === call.tag);
      if (!f || f.value === NEUTRAL || call.value === NEUTRAL) continue;
      if (call.value === f.value) same++;
      else if (call.value === swapColor(f.value)) swapped++;
    }
    swappedCase.set(c, swapped > same);
  }

  for (const [tag, team] of Object.entries(plan.teams ?? {})) {
    const own = colors.filter((x) => x.tag === tag);
    const f = own.find((x) => x.case === first);
    for (const call of own) {
      // Swapped where this tag already starts swapped; a tag that starts neutral (or is missing from the first case)
      // follows the castles.
      const swap = !f || f.value === NEUTRAL ? !!swappedCase.get(call.case ?? '') : call !== f && call.value === swapColor(f.value);
      const want = swap ? swapColor(team) : team;
      expectColor.set(`${call.case}|${tag}`, want);
      if (call.value !== want) {
        replace(call.valueStart, call.valueLength, want);
        res.changed++;
      }
    }
    // Into each case with colour calls, after its last one; a script whose cases have none gets it under every case
    // label (a team that can't be written anywhere is an error, not a silent skip).
    let placed = own.length;
    for (const c of info.setupCases) {
      if (own.some((x) => x.case === c)) continue;
      const anchor = colors.filter((x) => x.case === c).pop();
      const want = swappedCase.get(c) ? swapColor(team) : team;
      let where;
      if (anchor) where = insertAt(original, anchor);
      else if (!colors.length && info.setupCaseAt.has(c)) where = afterLabel(original, ...info.setupCaseAt.get(c));
      else continue;
      const spaced = anchor?.spaced ?? info.calls[0]?.spaced ?? true;
      replace(where.at, 0, where.eol + where.indent + callText(SET_COLOR, tag, want, spaced));
      expectColor.set(`${c}|${tag}`, want);
      res.inserted++;
      placed++;
    }
    if (!placed) throw new Error(`stage_setting.nut has no ${SETUP_FUNCTION} cases to add ${tag}'s starting team to.`);
  }

  const builds = setupCalls(info, SET_BUILD);
  for (const [tag, state] of Object.entries(plan.builds ?? {})) {
    const own = builds.filter((x) => x.tag === tag);
    for (const call of own) {
      expectBuild.set(`${call.case}|${tag}`, state);
      if (call.value !== state) {
        replace(call.valueStart, call.valueLength, state);
        res.changed++;
      }
    }
    if (own.length || first == null) continue;
    const anchor = builds.filter((x) => x.case === first).pop() ?? colors.filter((x) => x.case === first).pop();
    if (!anchor) throw new Error(`stage_setting.nut has no gimmick calls in ${SETUP_FUNCTION} to add ${tag}'s build state next to.`);
    const where = insertAt(original, anchor);
    replace(where.at, 0, where.eol + where.indent + callText(SET_BUILD, tag, state, anchor.spaced));
    expectBuild.set(`${first}|${tag}`, state);
    res.inserted++;
  }

  const have = new Set(info.files.map((f) => f.toLowerCase())), addFiles = [];
  for (const f of plan.files ?? []) {
    if (have.has(f.toLowerCase())) continue;
    have.add(f.toLowerCase());
    addFiles.push(f);
  }
  if (addFiles.length) {
    if (info.filesOpen < 0) throw new Error(`stage_setting.nut has no gStageGimmickFileList to add ${addFiles.join(', ')} to.`);
    // After the last entry: on lines of their own when it has its own line, else beside it ("[ "a" "b" ]"); in an empty
    // list, right after its "[".
    const empty = info.filesEnd < 0, at = empty ? info.filesOpen : info.filesEnd;
    const line = lineAround(original, at);
    const ownLine = !empty && onlySpace(original, line.start, info.filesLastStart);
    const indent = leadingSpace(original, line.start);
    let s = '';
    for (const f of addFiles) {
      if (!empty || s.length) s += (info.filesCommas ? ',' : '') + (ownLine ? line.eol + indent : ' ');
      s += `"${f}"`;
    }
    replace(at, 0, s);
    res.filesAdded = addFiles.length;
  }

  // Back to front, so earlier offsets stay valid; at one offset, keep the order they were added in.
  let text = original;
  const order = edits.map((e, n) => [e, n]).sort((a, b) => b[0][0] - a[0][0] || b[1] - a[1]);
  for (const [[at, length, s]] of order) text = text.slice(0, at) + s + text.slice(at + length);

  // Read back: every planned value in place, exactly the planned number of calls and files more.
  const back = readGimmickScript(text);
  if (back.calls.length !== info.calls.length + res.inserted || back.files.length !== info.files.length + res.filesAdded)
    throw new Error('The edited stage_setting.nut did not read back (calls or bundle entries miscounted).');
  for (const [name, expect] of [[SET_COLOR, expectColor], [SET_BUILD, expectBuild]])
    for (const [key, v] of expect)
      if (!setupCalls(back, name).some((c) => `${c.case}|${c.tag}` === key && c.value === v))
        throw new Error(`The edited stage_setting.nut did not read back: ${key} is not ${v}.`);
  // The desktop parses the result as a script; here its braces must balance as the original's do.
  if (braceBalance(text) !== braceBalance(original)) throw new Error("The edited stage_setting.nut's braces don't match.");
  return { text, ...res };
}

/** The script's text from its file bytes, and how to write it back (null when it can't be written back byte for byte). */
export function scriptText(bytes) {
  const { text, encoding } = decodeText(bytes);
  return bytesEqual(encodeText(text, encoding), bytes) ? { text, encoding } : null;
}

/** applyGimmickScript on the file's bytes: {bytes, changed, inserted, filesAdded}. */
export function applyGimmickScriptBytes(bytes, plan) {
  const s = scriptText(bytes);
  if (!s) throw new Error("stage_setting.nut can't be read and written back byte for byte.");
  const r = applyGimmickScript(s.text, plan);
  return { ...r, bytes: encodeText(r.text, s.encoding) };
}

// ---------- JSON-with-comments records (the tactics' invadeSetting_), one character per byte ----------

/** Bytes as a string of one character per byte (offsets are byte offsets), and back. */
export const latin1 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return s;
};
export const latin1Bytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function skipTrivia(t, i) {
  if (t[i] === '"') {
    for (let k = i + 1; k < t.length; k++) {
      if (t[k] === '\\') k++;
      else if (t[k] === '"') return k + 1;
    }
    return t.length;
  }
  if (t[i] === '/' && t[i + 1] === '/') {
    const e = t.indexOf('\n', i);
    return e < 0 ? t.length : e + 1;
  }
  if (t[i] === '/' && t[i + 1] === '*') {
    const e = t.indexOf('*/', i + 2);
    return e < 0 ? t.length : e + 2;
  }
  return i;
}
/** The first "name" string outside comments; −1 = none. FindKey. */
function findKey(t, name) {
  for (let i = 0; i < t.length; ) {
    const j = skipTrivia(t, i);
    if (j === i) {
      i++;
      continue;
    }
    if (t[i] === '"' && j - i - 2 === name.length && t.startsWith(name, i + 1)) return i;
    i = j;
  }
  return -1;
}
function matchBrace(t, open) {
  let depth = 0;
  for (let i = open; i < t.length; ) {
    const j = skipTrivia(t, i);
    if (j !== i) {
      i = j;
      continue;
    }
    if (t[i] === '{') depth++;
    else if (t[i] === '}' && --depth === 0) return i;
    i++;
  }
  return -1;
}
/** The object-valued members directly inside the braces at open: [{key, keyStart, keyEnd, open, close}]. Entries. */
function entries(t, open, close) {
  const list = [];
  let key = null, keyStart = -1, keyEnd = -1;
  for (let i = open + 1; i < close; ) {
    if (t[i] === '"') {
      const j = skipTrivia(t, i);
      [key, keyStart, keyEnd] = [t.slice(i + 1, j - 1), i, j];
      i = j;
      continue;
    }
    const k = skipTrivia(t, i);
    if (k !== i) {
      i = k;
      continue;
    }
    if (t[i] === '{') {
      const c = matchBrace(t, i);
      if (c < 0) break;
      list.push({ key, keyStart, keyEnd, open: i, close: c });
      i = c + 1;
      continue;
    }
    i++;
  }
  return list;
}
function sectionOf(t, docName, section) {
  const key = findKey(t, section);
  const open = key < 0 ? -1 : t.indexOf('{', key);
  const close = open < 0 ? -1 : matchBrace(t, open);
  if (close < 0) throw new Error(`${docName} has no ${section} section.`);
  return entries(t, open, close);
}
/** The literal of a record's top-level field (null = none), and the record with it replaced. */
const fieldRe = (key) => new RegExp(`("${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|[^,\\r\\n}]+)`);
export const jsonLiteral = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

/**
 * Records added to and set in a section of a JSON-with-comments table (text: one character per byte). copies: [[new
 * key, record to copy]] — keys already in the section are left alone, so a table that has them from an earlier install
 * isn't given them twice. replace: [[existing key, record whose body (as the original has it) replaces its own]].
 * values: {record key: {field: value}}, set after both (the field must be there). Returns {text, inserted}; throws when
 * the result doesn't read back. GameplayJsonRecords.Apply.
 */
export function applyJsonRecords(original, docName, section, copies = [], values = {}, replace = []) {
  let t = original, inserted = 0;
  let bodies = null;
  if (replace.length) {
    bodies = new Map();
    for (const e of sectionOf(original, docName, section)) if (!bodies.has(e.key)) bodies.set(e.key, original.slice(e.open, e.close + 1));
    for (const [k, from] of replace)
      if (!bodies.has(k) || !bodies.has(from)) throw new Error(`${docName} has no record ${bodies.has(k) ? from : k}.`);
  }
  if (copies.length) {
    const list = sectionOf(t, docName, section);
    if (!list.length) throw new Error(`${docName}'s ${section} has no record to copy.`);
    const last = list[list.length - 1];
    const lineStart = t.lastIndexOf('\n', last.keyStart) + 1;
    let indent = t.slice(lineStart, last.keyStart);
    if (indent.trim().length) indent = '\t';
    const eol = lineStart >= 2 && t[lineStart - 2] === '\r' ? '\r\n' : '\n';
    let s = '';
    for (const [key, from] of copies) {
      if (list.some((e) => e.key === key) || s.includes(`"${key}"`)) continue;
      const tmpl = list.find((e) => e.key === from);
      if (!tmpl) throw new Error(`${docName} has no record ${from} to copy for ${key}.`);
      s += `,${eol}${indent}"${key}"${t.slice(tmpl.keyEnd, tmpl.open)}${t.slice(tmpl.open, tmpl.close + 1)}`;
      inserted++;
    }
    if (inserted) t = t.slice(0, last.close + 1) + s + t.slice(last.close + 1);
  }
  if (bodies) {
    const want = new Map(replace);
    // Last first, so the offsets of the ones before stay put.
    for (const e of sectionOf(t, docName, section).filter((e) => want.has(e.key)).sort((a, b) => b.open - a.open))
      t = t.slice(0, e.open) + bodies.get(want.get(e.key)) + t.slice(e.close + 1);
  }
  // Values, through each record's first entry (a twin that isn't there is skipped, as on the desktop).
  const sets = Object.entries(values);
  if (sets.length) {
    const list = sectionOf(t, docName, section), done = new Set();
    const targets = [];
    for (const e of list) if (!done.has(e.key) && values[e.key]) done.add(e.key), targets.push(e);
    for (const e of targets.sort((a, b) => b.open - a.open)) {
      let rec = t.slice(e.open, e.close + 1);
      for (const [field, v] of Object.entries(values[e.key])) {
        const m = fieldRe(field).exec(rec);
        if (!m) throw new Error(`${docName}: ${e.key} has no ${field}.`);
        const at = m.index + m[1].length;
        rec = rec.slice(0, at) + jsonLiteral(v) + rec.slice(at + m[2].trimEnd().length);
      }
      t = t.slice(0, e.open) + rec + t.slice(e.close + 1);
    }
  }
  // Read back: the section still walks, the copies are there and every value reads as set.
  const back = sectionOf(t, docName, section);
  for (const [key] of copies) if (!back.some((e) => e.key === key)) throw new Error(`${docName}: record ${key} did not read back.`);
  for (const [key, fields] of sets) {
    const e = back.find((x) => x.key === key);
    if (!e) continue;
    const rec = t.slice(e.open, e.close + 1);
    for (const [field, v] of Object.entries(fields))
      if (fieldRe(field).exec(rec)?.[2].trimEnd() !== jsonLiteral(v)) throw new Error(`${docName} did not read back: ${key} ${field}.`);
  }
  return { text: t, inserted };
}
