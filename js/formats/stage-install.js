// Installing the map editor's bundle into the game, ported from HappyTool/RrmConvert/StageInstaller.cs (CreatePlan,
// Install, CreateBackupSet, WriteManifest, RollBack, RestoreEntry) and StageRegistration.cs (the Data root,
// ReadRegistration, the stageFileList.nut scan, StageNames).
//
// This first part installs over the stage the map came from (the desktop's "Replace an existing stage" with that
// stage picked): Data\stage\<id>.bres, and Data\stage\mini\<id>.bres too when the game has one (the game loads that
// copy on lower graphics settings; the full bundle works there). Every file that changes is copied first into a backup
// set in HappyTool Backups next to Data, in the desktop's layout and manifest, so the desktop's Backups list shows the
// set and can restore it. Each write is read back and its SHA-256 checked; a failure puts the files back from the set.
//
// A browser folder handle can't reach its parent, and the backups go next to Data, so the folder to pick is the game
// folder (the one holding Data). The game can't be seen running from a browser, so the plan always says to close it.

import { decodeLayers, encodeLayers } from './wrappers.js';
import { parseBres } from './bres.js';
import { stripJsonComments } from './json.js';

export const FILE_LIST = 'stage\\stageFileList.nut';
export const TABLE = 'json\\stage\\gemini_stage_table.json';
export const BACKUP_FOLDER = 'HappyTool Backups';
export const MANIFEST = 'manifest.json';
export const MANIFEST_FORMAT = 'HappyTool.StageBackup/1';
const SKIRMISH_SLOTS = 11; // HappyWars.exe lists MenuNum 1-11 in Skirmish
const GATED_SLOT = 12; // unlocked by an entitlement check
const STAGE_TABLE_SUFFIXES = ['_stage_set_table.json', '_stage_gimmick.json', '_stage_effect.json'];
const ARRAY_NAME = 'gStageFileList';
const FRIENDLY = new Map(
  Object.entries({
    sligA: 'Rainbow', sligB: 'Snowman', sdarA: 'Twilight', sdarB: 'Pumpkin', sdesA: 'Desert', sdesB: 'Zodiac',
    sseaA: 'Coral', sseaB: 'Deep Sea', scloA: 'Bird God', scloB: 'Sunset', sbabA: 'Ketchup Avenue', sbabB: '(360-only)',
    sforA: 'Forest', scolA: 'Colosseum',
  }).map(([k, v]) => [k.toLowerCase(), v]),
);

export const isValidStageId = (id) => typeof id === 'string' && /^[A-Za-z][A-Za-z0-9_]{1,39}$/.test(id);
export const friendlyName = (id) => (id == null ? null : FRIENDLY.get(String(id).toLowerCase()) ?? null);
/** "sbabA — Ketchup Avenue", or just the id when unknown. */
export const describeStage = (id) => (friendlyName(id) == null ? id ?? '' : `${id} — ${friendlyName(id)}`);
const visibleSlot = (n) => n != null && n >= 1 && n <= SKIRMISH_SLOTS;
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
/** StringComparer.OrdinalIgnoreCase order. */
const cmpIgnoreCase = (a, b) => {
  const x = a.toUpperCase(), y = b.toUpperCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Byte-preserving text (each byte one char), as the desktop reads the registration files. */
function latin1(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return s;
}

export async function sha256(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

// ----- folder access (Windows names are case-insensitive; browser handles look names up exactly) -----

const parts = (rel) => rel.split(/[\\/]/).filter(Boolean);

async function child(dir, name, kind) {
  try {
    return kind === 'directory' ? await dir.getDirectoryHandle(name) : await dir.getFileHandle(name);
  } catch (e) {
    if (e?.name !== 'NotFoundError' && e?.name !== 'TypeMismatchError') throw e;
  }
  const want = name.toLowerCase();
  for await (const h of dir.values()) if (h.kind === kind && h.name.toLowerCase() === want) return h;
  return null;
}

/** The file at a relative path, or null. */
async function fileAt(dir, rel) {
  const p = parts(rel);
  for (const d of p.slice(0, -1)) {
    dir = await child(dir, d, 'directory');
    if (!dir) return null;
  }
  return child(dir, p[p.length - 1], 'file');
}

/** The folder holding a relative path's file (created when missing) and the file's name. */
async function parentOf(dir, rel, create) {
  const p = parts(rel);
  for (const d of p.slice(0, -1)) {
    const next = await child(dir, d, 'directory');
    if (next) dir = next;
    else if (create) dir = await dir.getDirectoryHandle(d, { create: true });
    else return null;
  }
  return { dir, name: p[p.length - 1] };
}

/** The file at a relative path, created (with its folders) when missing. */
async function fileFor(dir, rel) {
  const { dir: d, name } = await parentOf(dir, rel, true);
  return (await child(d, name, 'file')) || d.getFileHandle(name, { create: true });
}

const readBytes = async (fh) => new Uint8Array(await (await fh.getFile()).arrayBuffer());

/** Written through a swap file the browser moves into place on close (the desktop's AtomicFileWrites). */
async function writeBytes(fh, bytes) {
  const w = await fh.createWritable();
  try {
    await w.write(bytes);
  } catch (e) {
    await w.abort().catch(() => {});
    throw e;
  }
  await w.close();
}

async function hasRegistration(dir) {
  return !!(await fileAt(dir, FILE_LIST)) && !!(await fileAt(dir, TABLE));
}

/**
 * The picked folder as {game, data}: the game folder holding Data with both registration files. Throws with what to
 * pick instead when it is Data itself, Data\stage or neither.
 */
export async function openGameFolder(picked) {
  const why = `the backups go next to Data, in ${BACKUP_FOLDER}, and a browser can't reach a folder's parent`;
  if (await hasRegistration(picked))
    throw new Error(`"${picked.name}" is the Data folder itself. Pick the folder that holds it (the game folder): ${why}.`);
  const data = await child(picked, 'Data', 'directory');
  if (data && (await hasRegistration(data))) return { game: picked, data };
  if (picked.name.toLowerCase() === 'stage' && (await child(picked, 'stageFileList.nut', 'file')))
    throw new Error(`"${picked.name}" is Data\\stage. Pick the game folder, the one that holds Data: ${why}.`);
  throw new Error(`"${picked.name}" isn't the Happy Wars game folder: it has no Data folder with ${FILE_LIST} and ${TABLE}.`);
}

/** The bundle names in stageFileList.nut's gStageFileList array (StageFileListText.TryScan). */
export function scanFileList(text) {
  const name = indexOfCode(text, ARRAY_NAME);
  if (name < 0) throw new Error(`${ARRAY_NAME} not found.`);
  const open = text.indexOf('[', name);
  if (open < 0) throw new Error(`${ARRAY_NAME} has no '['.`);
  const list = [];
  for (let i = open + 1; i < text.length; ) {
    const c = text[i];
    if (c === ']') return list;
    if (c === '/' && text[i + 1] === '/') {
      const eol = text.indexOf('\n', i);
      i = eol < 0 ? text.length : eol + 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) break;
      list.push(text.slice(i + 1, end));
      i = end + 1;
    } else i++;
  }
  throw new Error(`${ARRAY_NAME} is not closed with ']'.`);
}

/** First occurrence of token outside comments. */
function indexOfCode(text, token) {
  for (let i = 0; i < text.length; ) {
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (text[i] === '/' && text[i + 1] === '/') {
      const eol = text.indexOf('\n', i);
      i = eol < 0 ? text.length : eol + 1;
    } else if (text.startsWith(token, i)) return i;
    else i++;
  }
  return -1;
}

/** (int) on a Json.NET number: Convert.ToInt32, which rounds half to even. */
const toInt = (v) => (Number.isInteger(v) ? v : Math.abs(v % 1) === 0.5 ? 2 * Math.round(v / 2) : Math.round(v));

/**
 * The game's stage registration (StageDataRoot.ReadRegistration): the file list and table (unwrapped), and the slots
 * (table entries, stage\*.bres files and listed bundles) in menu order.
 */
export async function readRegistration(data) {
  const read = async (rel) => {
    const fh = await fileAt(data, rel);
    if (!fh) throw new Error(`Data\\${rel} is missing.`);
    const raw = await readBytes(fh);
    const { layers, payload } = await decodeLayers(raw);
    return { raw, layers, plain: payload };
  };
  const fileList = await read(FILE_LIST);
  const table = await read(TABLE);
  let listed;
  try {
    listed = scanFileList(latin1(fileList.plain));
  } catch (e) {
    throw new Error(`${FILE_LIST}: ${e.message}`);
  }
  let stages;
  try {
    stages = JSON.parse(stripJsonComments(latin1(table.plain)).text)?.JsonStageInfomationTable?.stage_;
  } catch (e) {
    throw new Error(`${TABLE}: JSON parse failed: ${e.message}`);
  }
  if (!stages || typeof stages !== 'object' || Array.isArray(stages))
    throw new Error(`${TABLE}: "JsonStageInfomationTable"."stage_" not found.`);

  const slots = new Map();
  for (const [id, o] of Object.entries(stages)) {
    const s = { id, inTable: true, tableId: null, nameTextId: null, menuNum: null };
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      s.tableId = o.id_ == null ? null : String(o.id_);
      s.nameTextId = o.NameTextID == null ? null : String(o.NameTextID);
      if (typeof o.MenuNum === 'number') s.menuNum = toInt(o.MenuNum);
    }
    slots.set(id.toLowerCase(), s);
  }
  const names = async (rel) => {
    const out = new Map();
    const { dir } = (await parentOf(data, `${rel}\\x`, false)) || {};
    if (dir) for await (const h of dir.values()) if (h.kind === 'file') out.set(h.name.toLowerCase(), h);
    return out;
  };
  const stageFiles = await names('stage');
  const tableFiles = await names('json\\stage');
  const extra = (id) => {
    if (isValidStageId(id) && !slots.has(id.toLowerCase())) slots.set(id.toLowerCase(), { id, inTable: false, tableId: null, nameTextId: null, menuNum: null });
  };
  for (const h of stageFiles.values()) if (h.name.toLowerCase().endsWith('.bres')) extra(h.name.slice(0, -5));
  for (const b of listed) extra(b.toLowerCase().endsWith('.bres') ? b.slice(0, -5) : b);
  for (const s of slots.values()) {
    const want = `${s.id}.bres`;
    const bundle = stageFiles.get(want.toLowerCase());
    s.bundleExists = !!bundle;
    s.bundleLength = bundle ? (await bundle.getFile()).size : 0;
    const listedAs = listed.find((b) => sameName(b, want));
    s.listedInFileList = listedAs != null;
    s.listedAs = listedAs != null && listedAs !== want ? listedAs : null;
    s.hasStageTables = tableFiles.has(`${s.id}_stage_set_table.json`.toLowerCase());
  }
  // Menu order first (what the player sees), then everything without a MenuNum alphabetically.
  const list = [...slots.values()].sort(
    (a, b) => (a.menuNum == null) - (b.menuNum == null) || (a.menuNum ?? 0) - (b.menuNum ?? 0) || cmpIgnoreCase(a.id, b.id),
  );
  return { fileList, table, listed, slots: list, find: (id) => (id ? slots.get(String(id).trim().toLowerCase()) ?? null : null) };
}

/**
 * The install plan for putting the bundle into stage id's slot in place of the bundle there (CreatePlan for
 * ReplaceExisting): {id, slot, bundleRel, miniRel, targetExists, miniExists, findings: [{severity, code, message,
 * detail}], steps, hasErrors}. A slot stageFileList.nut doesn't list is refused here: adding it isn't ported yet.
 */
export async function createPlan(data, snap, stageId) {
  const id = String(stageId ?? '').trim();
  const plan = { id, slot: null, findings: [], steps: [], hasErrors: false };
  const add = (severity, code, message, detail) => {
    plan.findings.push({ severity, code, message, detail });
    if (severity === 'error') plan.hasErrors = true;
  };
  if (!isValidStageId(id)) {
    add('error', 'INVALID_ID', `Invalid stage id '${id}'`, 'Use letters, digits and underscores only (e.g. sforA).');
    return plan;
  }
  const slot = snap.find(id);
  const sid = slot?.id ?? id;
  plan.slot = slot;
  plan.bundleRel = `stage\\${sid}.bres`;
  plan.miniRel = `stage\\mini\\${sid}.bres`;
  plan.targetExists = !!slot?.bundleExists;
  plan.miniExists = !!(await fileAt(data, plan.miniRel));
  if (!slot) {
    add('error', 'SLOT_UNKNOWN', `'${id}' is not an installed or registered stage`,
      'Open a bundle of one of the game\'s stages to install it in its place, or add it as a new stage with the desktop HappyTool.');
    return plan;
  }
  if (!slot.listedInFileList)
    add('error', 'NOT_LISTED', `'${sid}' isn't listed in stage\\stageFileList.nut`,
      'Adding a stage to the list isn\'t in the web version yet: install it with the desktop HappyTool, or open a stage the list has.');
  const menu = slot.menuNum;
  if (menu == null)
    add('warning', 'NOT_IN_MENU', `'${id}' has no MenuNum — it won't appear in Skirmish`,
      slot.inTable
        ? `The file is replaced, but the stage has no Skirmish slot. Replace a stage with MenuNum 1–${SKIRMISH_SLOTS} to play it.`
        : "The stage has no gemini_stage_table.json entry at all, so the menu can't list it.");
  else if (menu === GATED_SLOT)
    add('warning', 'SLOT_GATED', `MenuNum ${GATED_SLOT} is DLC-gated — the stage won't show in Skirmish`,
      `Slot ${GATED_SLOT} is unlocked by an entitlement check in HappyWars.exe, not by data.`);
  else if (!visibleSlot(menu))
    add('warning', 'SLOT_BEYOND_CAP', `MenuNum ${menu} is outside the ${SKIRMISH_SLOTS} visible Skirmish slots`,
      `The stage is registered but will not appear in the menu. Replace one of MenuNum 1–${SKIRMISH_SLOTS} to play it.`);
  if (visibleSlot(menu))
    add('info', 'SLOT', `Skirmish slot ${menu}: ${describeStage(sid)}`,
      plan.targetExists
        ? `Replaces Data\\stage\\${sid}.bres; the current file is backed up first.`
        : `${sid}.bres is not installed yet — this fills the slot (restoring removes it again).`);
  if (!slot.hasStageTables) {
    const missing = [];
    for (const s of STAGE_TABLE_SUFFIXES) if (!(await fileAt(data, `json\\stage\\${id}${s}`))) missing.push(id + s);
    if (missing.length)
      add('warning', 'STAGE_TABLES_MISSING', `json\\stage has no gameplay tables for '${id}'`,
        `Missing: ${missing.join(', ')}. The game reads area / gimmick / effect data from these files; without them the stage may crash or play without objectives. Replacing an existing stage avoids this.`);
  }
  add('info', 'CLOSE_GAME', 'Close Happy Wars first',
    "It keeps stage files open, and it only reads the stage list at startup. A browser can't see whether it is running.");

  const target = `Data\\stage\\${sid}.bres`;
  if (plan.targetExists) plan.steps.push(`Back up the current ${target}`);
  plan.steps.push(`${plan.targetExists ? 'Replace' : 'Write'} ${target} (byte-for-byte copy)`);
  if (plan.miniExists)
    plan.steps.push(`Back up and replace Data\\stage\\mini\\${sid}.bres too (the game loads that copy instead on lower graphics settings)`);
  plan.steps.push('Read every written file back and verify its SHA-256');
  return plan;
}

const WRITE_COPY = ' (byte-for-byte copy)';
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The parts of CreatePlan that need the bundle's lint (stage-lint.js), added once the bundle is built: the plan itself
 * is made first, while the folder pick still counts as the user's click. Re-wrapping is on, as the desktop's default;
 * renaming another stage's files for this slot (Retarget) isn't in the web yet, so a bundle made for another stage gets
 * the desktop's renaming-off warning.
 */
export function applyLint(plan, lint, { rewrap = true } = {}) {
  plan.lint = lint;
  plan.willRewrap = !!(rewrap && lint?.readable && !lint.isSteamWrapped);
  const id = plan.slot?.id ?? plan.id;
  const authoredFor = lint?.detectedStageId;
  const otherStage = isValidStageId(authoredFor) && authoredFor.toLowerCase() !== id.toLowerCase();
  const found = [];
  if (otherStage)
    found.push({ severity: 'warning', code: 'NOT_RETARGETED', message: `The bundle's files are named for '${authoredFor}', not '${id}'`,
      detail: `The game loads ${id}.rrm, ${id}_Chit.ccp … when it loads this slot; with renaming off they keep their ${authoredFor} names and may not be found.` });
  if (otherStage && plan.slot?.hasStageTables)
    found.push({ severity: 'info', code: 'SLOT_TABLES_MISMATCH', message: `Installing '${authoredFor}' into the '${id}' slot`,
      detail: `The slot keeps json\\stage\\${id}_stage_*.json (areas, gimmicks, effects authored for ${friendlyName(id) ?? id}), so objectives are placed at ${id}'s coordinates.` });
  // The desktop adds these just before its game-running check, which the web's close-the-game note stands for.
  const at = plan.findings.findIndex((f) => f.code === 'CLOSE_GAME');
  plan.findings.splice(at < 0 ? plan.findings.length : at, 0, ...found);
  if (plan.willRewrap) {
    const i = plan.steps.findIndex((x) => x.endsWith(WRITE_COPY));
    if (i >= 0) plan.steps[i] = plan.steps[i].slice(0, -WRITE_COPY.length) + ' (re-wrapped as ZRES + BFBR)';
  }
  return plan;
}

const RANK = { info: 0, warning: 1, error: 2 };

/**
 * Bundle and plan findings as the user should see them, most severe first ({source: 'Bundle'|'Target', severity, code,
 * message, detail}). A wrapping warning the install is about to fix is shown as a note, so it doesn't ask for a
 * confirmation. Within a severity the checks keep their own order.
 */
export function combinedFindings(lint, plan) {
  const list = [];
  for (const f of lint?.findings ?? []) {
    if (f.code === 'NOT_STEAM_WRAPPED' && plan?.willRewrap)
      list.push({ source: 'Bundle', severity: 'info', code: 'REWRAP', message: 'Not BFBR + ZRES wrapped — will be re-wrapped on install',
        detail: 'The installed copy is ZRES-compressed then BFBR-encrypted like the shipped Steam stages; your file is not modified.' });
    else list.push({ source: 'Bundle', ...f });
  }
  for (const f of plan?.findings ?? []) list.push({ source: 'Target', ...f });
  return list.map((x, i) => [x, i]).sort((a, b) => RANK[b[0].severity] - RANK[a[0].severity] || a[1] - b[1]).map((t) => t[0]);
}

// ----- backups -----

const pad = (n, w = 2) => String(n).padStart(w, '0');
/** The set folder's stamp, local time yyyyMMdd-HHmmss. */
const localStamp = (d) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
/** .NET's round-trip "o" format of a UTC time (seven fractional digits). */
const roundTrip = (d) => `${d.toISOString().slice(0, 23)}0000Z`;
const roleOf = (rel) => (sameName(rel, FILE_LIST) ? 'file list' : sameName(rel, TABLE) ? 'stage table' : 'bundle');

/**
 * <game>\HappyTool Backups\<yyyyMMdd-HHmmss> <stage>\ holding a hash-checked copy of each existing file under files\
 * plus manifest.json (status "pending"). Throws, leaving the game untouched and no set behind, on any problem.
 */
async function createBackupSet(root, operation, stageId, source, note, rels, step) {
  const now = new Date();
  const base = `${localStamp(now)} ${stageId}${operation === 'install' ? '' : ` (${operation})`}`;
  const backups = (await child(root.game, BACKUP_FOLDER, 'directory')) || (await root.game.getDirectoryHandle(BACKUP_FOLDER, { create: true }));
  let name = base;
  for (let n = 2; await child(backups, name, 'directory'); n++) name = `${base} #${n}`;
  const dir = await backups.getDirectoryHandle(name, { create: true });
  const set = { name, dir, createdUtc: now, operation, stageId, source, note, status: 'pending', lastRestoredUtc: null, entries: [] };
  try {
    for (const rel of rels) {
      const fh = await fileAt(root.data, rel);
      const entry = { role: roleOf(rel), path: rel, existed: !!fh, length: 0, sha256: null, backup: null, writtenSha256: null };
      if (fh) {
        step?.(40, `Backing up Data\\${rel}…`);
        entry.backup = `files\\${rel}`;
        const bytes = await readBytes(fh);
        const copy = await fileFor(dir, entry.backup);
        await writeBytes(copy, bytes);
        entry.length = bytes.length;
        entry.sha256 = await sha256(bytes);
        if ((await sha256(await readBytes(copy))) !== entry.sha256) throw new Error(`Backup copy of ${rel} does not match the original.`);
      }
      set.entries.push(entry);
    }
    await writeManifest(root, set);
  } catch (e) {
    // Nothing in the game was touched yet; drop the half-written set so it never shows up as restorable.
    await backups.removeEntry(name, { recursive: true }).catch(() => {});
    throw e;
  }
  return set;
}

/** manifest.json as the desktop writes it (explicit keys in its order, Json.NET's indented layout, UTF-8 without BOM). */
async function writeManifest(root, set) {
  const o = {
    format: MANIFEST_FORMAT,
    operation: set.operation,
    stageId: set.stageId,
    stageName: friendlyName(set.stageId),
    // A set read back keeps its own text (the desktop's has seven fractional digits; a Date keeps three).
    createdUtc: set.createdText ?? roundTrip(set.createdUtc),
    // The desktop writes the full Data path; a browser only knows the folder names. Nothing reads it back.
    dataRoot: `${root.game.name}\\${root.data.name}`,
    source: set.source,
    note: set.note,
    status: set.status,
    lastRestoredUtc: set.lastRestoredText ?? (set.lastRestoredUtc ? roundTrip(set.lastRestoredUtc) : null),
    tool: 'HappyTool Web',
    files: set.entries.map((e) => ({
      role: e.role, path: e.path, existed: e.existed, length: e.length, sha256: e.sha256, backup: e.backup, writtenSha256: e.writtenSha256,
    })),
  };
  const text = JSON.stringify(o, null, 2).replace(/\n/g, '\r\n');
  await writeBytes(await set.dir.getFileHandle(MANIFEST, { create: true }), new TextEncoder().encode(text));
}

/** One file put back as the set has it: deleted when it didn't exist, left alone when it already matches. */
async function restoreEntry(root, set, e) {
  const fh = await fileAt(root.data, e.path);
  if (!e.existed) {
    if (fh) {
      const { dir } = await parentOf(root.data, e.path, false);
      await dir.removeEntry(fh.name);
    }
    return;
  }
  // Already the backed-up bytes (e.g. the write that failed never happened): nothing to undo.
  if (fh && e.sha256 && (await sha256(await readBytes(fh))) === e.sha256) return;
  const copy = await fileAt(set.dir, e.backup || '');
  if (!copy) throw new Error('the backup copy is missing');
  const target = fh || (await fileFor(root.data, e.path));
  await writeBytes(target, await readBytes(copy));
  if (e.sha256 && (await sha256(await readBytes(target))) !== e.sha256) throw new Error('verification failed');
}

async function rollBack(root, set, applied) {
  const problems = [];
  for (const w of applied) {
    try {
      await restoreEntry(root, set, set.entries.find((x) => sameName(x.path, w.rel)));
    } catch (e) {
      problems.push(`${w.rel}: ${e.message}`);
    }
  }
  return problems.length ? problems.join('; ') : null;
}

/**
 * Installs bytes (the bundle as Download bundle writes it) by plan into root ({game, data} from openGameFolder):
 * backup set first, then each write read back, rolled back from the set on any failure. source names the bundle in the
 * manifest. Resolves to {ok, message, log, set}; onStep(pct, text) reports progress.
 */
export async function install(root, plan, bytes, { source, onStep, lint } = {}) {
  const log = [];
  const step = (pct, text) => {
    log.push(text);
    onStep?.(pct, text);
  };
  const done = (ok, message, set = null) => ({ ok, message, log, set });
  if (!plan || plan.hasErrors || !plan.slot) return done(false, 'The install plan has errors; nothing was changed.');
  if (!lint || !lint.readable || lint.hasErrors) return done(false, 'The bundle failed the pre-install check; nothing was changed.');
  if (lint.sha256 && (await sha256(bytes)) !== lint.sha256.toLowerCase())
    return done(false, 'The bundle changed after it was checked. Check it again, then install; nothing was changed.');
  const id = plan.slot.id;
  // The bytes going to disk must still open as a BRES container.
  let payload;
  try {
    payload = (await decodeLayers(bytes)).payload;
    parseBres(payload);
  } catch (e) {
    return done(false, `The bundle doesn't open as a BRES container (${e.message}); nothing was changed.`);
  }
  if (plan.willRewrap) {
    step(10, 'Re-wrapping bundle as ZRES + BFBR…');
    bytes = await encodeLayers(payload, ['BFBR', 'ZRES']);
    const check = await decodeLayers(bytes);
    if (check.layers.join() !== 'BFBR,ZRES' || !sameBytes(check.payload, payload))
      return done(false, 'Re-wrapped bundle did not decode back to the original payload; nothing was changed.');
  }
  // Registration read again (not the plan's snapshot) so a change since the plan isn't missed.
  step(20, 'Preparing registration changes…');
  let snap;
  try {
    snap = await readRegistration(root.data);
  } catch (e) {
    return done(false, `${e.message} Nothing was changed.`);
  }
  if (!snap.find(id)?.listedInFileList) return done(false, `'${id}' is no longer listed in stage\\stageFileList.nut; nothing was changed.`);

  const writes = [{ role: 'bundle', rel: plan.bundleRel, bytes }];
  // Lower quality levels load stage\mini\<id>.bres instead when it exists; the full-size bundle works in its place.
  if (await fileAt(root.data, plan.miniRel)) writes.push({ role: 'low-quality bundle', rel: plan.miniRel, bytes });

  step(35, 'Backing up files that will change…');
  let set;
  try {
    set = await createBackupSet(root, 'install', id, source, `Installed ${source} as ${id}.bres`, writes.map((w) => w.rel), step);
  } catch (e) {
    return done(false, `Backup failed, so nothing was installed: ${e.message}`);
  }
  step(60, `Backup set: ${BACKUP_FOLDER}\\${set.name}`);

  const applied = [];
  const want = await sha256(bytes);
  try {
    let n = 0;
    for (const w of writes) {
      step(65 + Math.trunc((25 * n++) / writes.length), `Writing Data\\${w.rel}…`);
      const fh = await fileFor(root.data, w.rel);
      applied.push(w);
      await writeBytes(fh, w.bytes);
      const written = await sha256(await readBytes(fh));
      if (written !== want) throw new Error(`Read-back verification failed for ${w.rel}.`);
      const e = set.entries.find((x) => sameName(x.path, w.rel));
      e.writtenSha256 = written;
      e.role = w.role;
    }
    set.status = 'complete';
    await writeManifest(root, set);
  } catch (e) {
    step(95, `Install failed (${e.message}) — rolling back…`);
    const problem = await rollBack(root, set, applied);
    set.status = problem == null ? 'rolled-back' : 'failed';
    await writeManifest(root, set).catch(() => {});
    // .NET messages end in a full stop; the browser's often don't.
    const why = /[.!?]$/.test(e.message) ? e.message : `${e.message}.`;
    return done(
      false,
      `Install failed: ${why}` +
        (problem == null ? ' All changes were rolled back from the backup.' : ` Rollback problem: ${problem} — restore backup set '${set.name}' manually.`),
      set,
    );
  }
  const message = `Installed ${id}.bres (${writes.length} file(s) written and verified).`;
  step(100, message);
  return done(true, message, set);
}

// ----- the backups list and restore (StageInstaller ListBackupSets, StageBackupSets, CompareWithCurrent, Restore, PutBack) -----

const COMPANION_SUFFIXES = ['_stage_set_table.json', '_stage_gimmick.json', '_stage_tactics.json', '_stage_effect.json'];
const DECO_SEASONS = ['easter', 'halloween', 'newyear', 'thanksgiving', 'valentine', 'xmas'];
const DECO_SUFFIXES = ['_stage_gimmick.json', '_stage_effect.json'];
const backslashed = (rel) => (rel ?? '').replace(/\//g, '\\');

/** Stage bundles (stage\<id>.bres, stage\mini\<id>.bres) and the two registration files. */
function isRegistrationOrStageBundle(rel) {
  // The registration files are matched as written, before / becomes \, as the desktop does.
  if (sameName(rel ?? '', FILE_LIST) || sameName(rel ?? '', TABLE)) return true;
  const n = backslashed(rel);
  if (!/^stage\\/i.test(n) || !/\.bres$/i.test(n) || n.length <= 11) return false;
  let id = n.slice(6, -5);
  if (/^mini\\/i.test(id)) id = id.slice(5);
  return isValidStageId(id);
}

const isStageScript = (p) => p.length === 3 && sameName(p[0], 'ssn') && isValidStageId(p[1]) && sameName(p[2], 'stage_setting.nut');

/** Restore guard: what installs write (stage bundles, registration, json\stage and json\stagedeco\<season> tables, GameEnvironment.json, stage scripts). */
export function isRestorableDataFile(rel) {
  if (isRegistrationOrStageBundle(rel)) return true;
  const n = backslashed(rel);
  // .NET's Path.GetInvalidPathChars: the double quote, < > | and the control characters.
  if (n.includes('..') || /["<>|\x00-\x1f]/.test(n)) return false;
  if (sameName(n, 'json\\game\\GameEnvironment.json')) return true;
  const p = n.split('\\');
  if (isStageScript(p)) return true;
  const last = p[p.length - 1];
  if (!(/\.json$/i.test(last) || /\.nut$/i.test(last)) || !sameName(p[0], 'json')) return false;
  if (p.length === 3 && sameName(p[1], 'stage')) return true;
  return p.length === 4 && sameName(p[1], 'stagedeco') && DECO_SEASONS.some((s) => sameName(s, p[2]));
}

/** A stage's own files: its bundles, its json\stage and stagedeco tables and its script; never the shared registration files. */
export function isStageOwnedFile(rel, id) {
  if (!rel || !isValidStageId(id)) return false;
  const n = backslashed(rel);
  if (sameName(n, `stage\\${id}.bres`) || sameName(n, `stage\\mini\\${id}.bres`)) return true;
  if (sameName(n, TABLE) || sameName(n, FILE_LIST) || !isRestorableDataFile(n)) return false;
  const p = n.split('\\');
  const named = (suffixes) => suffixes.some((s) => sameName(p[p.length - 1], id + s));
  if (isStageScript(p)) return sameName(p[1], id);
  if (!sameName(p[0], 'json')) return false;
  if (p.length === 3 && sameName(p[1], 'stage')) return named(COMPANION_SUFFIXES);
  return p.length === 4 && sameName(p[1], 'stagedeco') && named(DECO_SUFFIXES);
}

const SET_NAME = /^(\d{8}-\d{6}) (.+?)(?: \(([^()]*)\))?(?: #\d+)?$/;

/** Whether an unreadable set might hold a stage's own files, by its folder name (StageInstaller.MayHoldStageFiles). */
function mayHoldStageFiles(set, id) {
  const m = SET_NAME.exec(set.name);
  if (!m) return true;
  const op = m[3] ?? 'install';
  if (op === 'pre-restore') return false;
  return op !== 'install' || !isValidStageId(m[2]) || sameName(m[2], id);
}

/**
 * .NET's round-trip "o" text as {date, key, text}: key (BigInt 100 ns ticks since 1970, UTC) keeps all seven
 * fractional digits so sets made within one millisecond still sort; null when the text isn't one.
 */
function parseRoundTrip(text) {
  const m = typeof text === 'string' && /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,7}))?(Z|[+-]\d\d:\d\d)?$/.exec(text);
  if (!m) return null;
  let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (Number.isNaN(ms)) return null;
  // No zone (DateTimeKind.Unspecified) counts as UTC, as TryParseUtc does.
  if (m[8] && m[8] !== 'Z') ms -= (m[8][0] === '-' ? -1 : 1) * (+m[8].slice(1, 3) * 60 + +m[8].slice(4, 6)) * 60000;
  const frac = BigInt((m[7] ?? '').padEnd(7, '0'));
  return { date: new Date(ms + Number(frac / 10000n)), key: BigInt(ms) * 10000n + frac, text };
}

/** The set folder's own stamp (local yyyyMMdd-HHmmss) as a time: a browser can't see a folder's creation time. */
function stampTime(name) {
  const m = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d) /.exec(name);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

async function readManifest(name, dir, fh) {
  const fallback = stampTime(name) ?? new Date((await fh.getFile()).lastModified);
  const set = {
    name, dir, createdUtc: fallback, createdKey: BigInt(fallback.getTime()) * 10000n, createdText: null, operation: null, stageId: null,
    source: null, note: null, status: null, lastRestoredUtc: null, lastRestoredText: null, entries: [], loadError: null,
  };
  try {
    const o = JSON.parse(new TextDecoder().decode(await readBytes(fh)).replace(/^\uFEFF/, ''));
    if (o?.format !== MANIFEST_FORMAT) throw new Error(`unknown manifest format '${o?.format ?? ''}'`);
    const str = (v) => (v == null ? null : String(v));
    set.operation = str(o.operation);
    set.stageId = str(o.stageId);
    set.source = str(o.source);
    set.note = str(o.note);
    set.status = str(o.status);
    const created = parseRoundTrip(o.createdUtc);
    if (created) Object.assign(set, { createdUtc: created.date, createdKey: created.key, createdText: created.text });
    const restored = parseRoundTrip(o.lastRestoredUtc);
    if (restored) Object.assign(set, { lastRestoredUtc: restored.date, lastRestoredText: restored.text });
    for (const f of Array.isArray(o.files) ? o.files : []) {
      if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
      set.entries.push({
        role: str(f.role), path: str(f.path), existed: f.existed === true, length: Number(f.length) || 0,
        sha256: str(f.sha256), backup: str(f.backup), writtenSha256: str(f.writtenSha256),
      });
    }
    if (!set.entries.length) throw new Error('manifest lists no files');
  } catch (e) {
    set.loadError = e.message;
  }
  return set;
}

/** Every backup set under <game>\HappyTool Backups, newest first; an unreadable manifest is listed with loadError. */
export async function listBackupSets(root) {
  const backups = await child(root.game, BACKUP_FOLDER, 'directory');
  if (!backups) return [];
  const list = [];
  for await (const h of backups.values()) {
    if (h.kind !== 'directory') continue;
    const fh = await child(h, MANIFEST, 'file');
    if (fh) list.push(await readManifest(h.name, h, fh));
  }
  return list.sort((a, b) => (a.createdKey !== b.createdKey ? (a.createdKey < b.createdKey ? 1 : -1) : -cmpIgnoreCase(a.name, b.name)));
}

/** The sets that touched a stage: its own installs and restores, sets holding its files, and unreadable sets that might. */
export async function stageBackupSets(root, id, all = null) {
  return (all ?? (await listBackupSets(root))).filter((s) =>
    s.loadError != null ? mayHoldStageFiles(s, id) : sameName(s.stageId ?? '', id) || s.entries.some((e) => isStageOwnedFile(e.path, id)));
}

/** Each file of a set against the game now, by path: 'as-backed-up', 'as-written' (what the operation wrote) or 'changed'. */
export async function compareWithCurrent(root, set) {
  const states = new Map();
  for (const e of set.entries) {
    let now = null;
    try {
      checkDataPath(e.path);
      const fh = await fileAt(root.data, e.path);
      now = fh ? await sha256(await readBytes(fh)) : null;
    } catch {
      now = null;
    }
    const original = e.existed ? e.sha256?.toLowerCase() ?? null : null;
    states.set(e.path, now === original ? 'as-backed-up' : e.writtenSha256 && now === e.writtenSha256.toLowerCase() ? 'as-written' : 'changed');
  }
  return states;
}

/** A Data-relative path checked as StageDataRoot.Resolve checks it: not rooted, never above Data. */
function checkDataPath(rel) {
  if (!rel || !rel.trim() || /^([A-Za-z]:|[\\/])/.test(rel)) throw new Error(`Invalid Data-relative path: ${rel}`);
  let depth = 0;
  for (const p of parts(rel)) {
    if (p === '..') depth--;
    else if (p !== '.') depth++;
    if (depth < 0) throw new Error(`Path escapes the Data folder: ${rel}`);
  }
}

/**
 * Puts every file of a set back as it was before that operation (StageInstaller.Restore): the whole set is checked
 * first, the current files become a "pre-restore" set, each write is read back, and a failure puts the previous state
 * back. Resolves to {ok, message, log, preRestore}; onStep(pct, text) reports progress.
 */
export async function restoreBackupSet(root, set, { onStep } = {}) {
  const log = [];
  const step = (pct, text) => {
    log.push(text);
    onStep?.(pct, text);
  };
  const done = (ok, message, preRestore = null) => ({ ok, message, log, preRestore });
  if (!set || set.loadError != null) return done(false, `This backup set can't be restored: ${set?.loadError ?? 'no set selected'}.`);

  step(5, `Verifying backup set ${set.name}…`);
  const byPath = new Map();
  for (const e of set.entries) {
    try {
      checkDataPath(e.path);
    } catch (err) {
      return done(false, err.message);
    }
    if (!isRestorableDataFile(e.path)) return done(false, `Backup manifest names an unexpected file: ${e.path}.`);
    if (!e.existed) continue;
    const copy = await backupCopy(set, e);
    if (!copy) return done(false, `Backup copy missing for ${e.path}.`);
    const bytes = await readBytes(copy);
    if (e.sha256 && (await sha256(bytes)) !== e.sha256.toLowerCase())
      return done(false, `Backup copy of ${e.path} is corrupt (SHA-256 mismatch); nothing was restored.`);
    byPath.set(e.path.toLowerCase(), bytes);
  }

  // The desktop writes the set folder's full path as the source; a browser only knows the names below the game folder.
  const r = await putBack(root, set.stageId ?? 'stage', `${root.game.name}\\${BACKUP_FOLDER}\\${set.name}`,
    `State before restoring '${set.name}'`, set.entries, byPath, step);
  if (!r.ok) return done(false, r.message, r.pre);
  set.lastRestoredUtc = new Date();
  set.lastRestoredText = null;
  await writeManifest(root, set).catch(() => {});
  const message = `Restored ${set.entries.length} file(s) from ${set.name}.`;
  step(100, message);
  return done(true, message, r.pre);
}

/**
 * StageInstaller.PutBack: saves the current files as a "pre-restore" set (so this can itself be undone), then writes each
 * entry's bytes from byPath (lowercased path → bytes) or removes the file, reading every write back; a failure puts the
 * previous state back from that set. Resolves to {ok, message, pre}.
 */
async function putBack(root, stageId, source, note, entries, byPath, step) {
  step(20, 'Saving the current state as a pre-restore backup…');
  let pre;
  try {
    pre = await createBackupSet(root, 'pre-restore', stageId, source, note, entries.map((e) => e.path), step);
  } catch (err) {
    return { ok: false, message: `Could not back up the current state, so nothing was restored: ${err.message}`, pre: null };
  }
  const applied = [];
  try {
    let n = 0;
    for (const e of entries) {
      step(40 + Math.trunc((50 * n++) / entries.length), `${e.existed ? 'Restoring' : 'Removing'} Data\\${e.path}…`);
      applied.push({ rel: e.path });
      if (e.existed) {
        const bytes = byPath.get(e.path.toLowerCase());
        const fh = await fileFor(root.data, e.path);
        await writeBytes(fh, bytes);
        const written = await sha256(await readBytes(fh));
        if (written !== (await sha256(bytes))) throw new Error(`Read-back verification failed for ${e.path}.`);
        // Lets "changed since" work when this pre-restore set is itself restored later.
        pre.entries.find((x) => sameName(x.path, e.path)).writtenSha256 = written;
      } else {
        const fh = await fileAt(root.data, e.path);
        if (fh) await (await parentOf(root.data, e.path, false)).dir.removeEntry(fh.name);
      }
    }
    pre.status = 'complete';
    await writeManifest(root, pre);
  } catch (err) {
    step(95, `Restore failed (${err.message}) — putting the previous state back…`);
    const problem = await rollBack(root, pre, applied);
    pre.status = problem == null ? 'rolled-back' : 'failed';
    await writeManifest(root, pre).catch(() => {});
    const why = /[.!?]$/.test(err.message) ? err.message : `${err.message}.`;
    return { ok: false, pre, message: `Restore failed: ${why}` +
      (problem == null ? ' The previous state was put back.' : ` Could not undo: ${problem} — restore '${pre.name}' manually.`) };
  }
  return { ok: true, message: null, pre };
}

// ------------------------------------------------------------------ back to stock (StageInstaller.cs 1196-1339, 1461, 1510)

const isStageListFile = (rel) => sameName(backslashed(rel), FILE_LIST) || sameName(backslashed(rel), TABLE);
const isBundleOf = (e, id) => sameName(backslashed(e.path), `stage\\${id}.bres`);
/** Where a set keeps its copy of an entry (BackupCopyPath), or null when it is missing or would lie outside the set. */
const backupCopy = async (set, e) => (e.backup && !parts(e.backup).includes('..') ? await fileAt(set.dir, e.backup) : null);
const byCreated = (a, b) => (a.createdKey === b.createdKey ? 0 : a.createdKey < b.createdKey ? -1 : 1);
const quoted = (names) => names.map((s) => `'${s}'`).join(', ');

/**
 * What putting a stage's own files back to stock would do (PlanStockRestore): each file from the oldest install or
 * settings set holding it (pre-restore sets hold what a restore replaced, so they never count as stock), with whether it
 * is already stock. {stageId, files: [{path, set, entry, alreadyStock}], unreadableSets, stageListSets, addedByHappyTool,
 * toChange, noBackups}; all = listBackupSets(root) when the caller has it.
 */
export async function planStockRestore(root, id, all = null) {
  all ??= await listBackupSets(root);
  const plan = { stageId: id, files: [], unreadableSets: [], stageListSets: [], addedByHappyTool: false };
  for (const set of all.filter((s) => s.loadError != null).sort(byCreated))
    if (mayHoldStageFiles(set, id)) plan.unreadableSets.push(set.name);
  const sets = all.filter((s) => s.loadError == null && (s.operation === 'install' || s.operation === 'settings'))
    .sort((a, b) => byCreated(a, b) || cmpIgnoreCase(a.name, b.name));
  const oldest = new Map();
  for (const set of sets) {
    let holds = false;
    for (const e of set.entries) {
      if (!isStageOwnedFile(e.path, id)) continue;
      holds = true;
      if (!oldest.has(e.path.toLowerCase())) oldest.set(e.path.toLowerCase(), { path: e.path, set, entry: e, alreadyStock: false });
    }
    if (holds && set.operation === 'install' && set.entries.some((e) => isStageListFile(e.path))) plan.stageListSets.push(set.name);
  }
  for (const f of [...oldest.values()].sort((a, b) => cmpIgnoreCase(a.path, b.path))) {
    checkDataPath(f.path);
    const fh = await fileAt(root.data, f.path);
    const now = fh ? await sha256(await readBytes(fh)) : null;
    const stock = f.entry.existed ? await stockHash(f) : null;
    f.alreadyStock = f.entry.existed ? stock != null && now === stock : now == null;
    plan.files.push(f);
    if (!f.entry.existed && isBundleOf(f.entry, id)) plan.addedByHappyTool = true;
  }
  plan.toChange = plan.files.filter((f) => !f.alreadyStock).length;
  plan.noBackups = plan.files.length === 0;
  return plan;
}

/** The stock file's hash: the manifest's, or the backup copy's when an old manifest didn't record one. */
async function stockHash(f) {
  if (f.entry.sha256) return f.entry.sha256.toLowerCase();
  const copy = await backupCopy(f.set, f.entry);
  return copy ? sha256(await readBytes(copy)) : null;
}

/** Two plans for the same stage would do the same: same files, from the same sets, in the same state. */
function sameStockPlan(a, b) {
  const same = (x, y) => x.length === y.length && x.every((s, i) => sameName(s, y[i]));
  if (a.addedByHappyTool !== b.addedByHappyTool || a.files.length !== b.files.length || !same(a.unreadableSets, b.unreadableSets)
      || !same(a.stageListSets, b.stageListSets)) return false;
  return a.files.every((x, i) => {
    const y = b.files[i];
    return sameName(x.path, y.path) && x.alreadyStock === y.alreadyStock && x.entry.existed === y.entry.existed && sameName(x.set.name, y.set.name);
  });
}

/** The newest readable install set that wrote stage id's bundle with this hash (FindInstallThatWrote), or null. */
export async function findInstallThatWrote(root, id, sha, all = null) {
  if (!sha) return null;
  return (all ?? (await listBackupSets(root))).find((s) => s.loadError == null && s.operation === 'install'
    && s.entries.some((e) => isBundleOf(e, id) && e.writtenSha256?.toLowerCase() === sha.toLowerCase())) ?? null;
}

/**
 * What the game has for a stage now, for the Restore stock page's status line (StageViewerForm.GameStateLine):
 * {plan, state: 'unknown' | 'no-bundle' | 'as-found' | 'added' | 'stock' | 'changed', map: 'stock' | 'installed' | 'changed',
 * install (the set that wrote the bundle, for 'installed'), tables (changed files besides the bundle)}.
 */
export async function stockState(root, id, all = null) {
  all ??= await listBackupSets(root);
  const plan = await planStockRestore(root, id, all);
  const r = { plan, state: 'changed', map: null, install: null, tables: 0 };
  const bundle = await fileAt(root.data, `stage\\${id}.bres`);
  if (plan.unreadableSets.length) r.state = 'unknown';
  else if (!bundle) r.state = 'no-bundle';
  else if (plan.noBackups) r.state = 'as-found';
  else if (plan.addedByHappyTool) r.state = 'added';
  else if (plan.toChange === 0) r.state = 'stock';
  else {
    const own = plan.files.find((f) => sameName(f.path, `stage\\${id}.bres`));
    if (own == null || own.alreadyStock) r.map = 'stock';
    else {
      r.install = await findInstallThatWrote(root, id, await sha256(await readBytes(bundle)), all);
      r.map = r.install ? 'installed' : 'changed';
    }
    r.tables = plan.files.filter((f) => !f.alreadyStock && f !== own).length;
  }
  return r;
}

/**
 * Puts a stage's own files back to stock (StageInstaller.RestoreStock): each from the oldest backup holding it, removed
 * when the stock game has no such file. Every copy is verified first and the current files become a pre-restore set
 * (source "stock"), so this can be undone from Backups. Refuses unreadable sets that may hold the stage's files, a stage
 * HappyTool added, and a plan that no longer matches the files. Resolves to {ok, message, log, preRestore}.
 */
export async function restoreStock(root, plan, { onStep } = {}) {
  const log = [];
  const step = (pct, text) => {
    log.push(text);
    onStep?.(pct, text);
  };
  const done = (ok, message, preRestore = null) => ({ ok, message, log, preRestore });
  if (plan?.unreadableSets.length)
    return done(false, `HappyTool can't read backup set(s) ${quoted(plan.unreadableSets)}, which may hold this stage's original files, so it `
      + `can't tell what stock is. Repair or remove them, or use Steam's "Verify integrity of game files".`);
  if (!plan || plan.noBackups)
    return done(false, "HappyTool has no backup of this stage's original files, so it can't put them back. "
      + `Steam's "Verify integrity of game files" restores every original file.`);
  const id = plan.stageId;
  const todo = plan.files.filter((f) => !f.alreadyStock);
  if (!todo.length) {
    const message = plan.addedByHappyTool
      ? `'${id}' was added by HappyTool and its files are already gone from the game.`
      : `'${id}' is already as the game shipped it.`;
    step(100, message);
    return done(true, message);
  }
  // The desktop names the installer's "Restore backups" tab; here the backups are listed under Restore stock….
  if (plan.addedByHappyTool)
    return done(false, `'${id}' was added by HappyTool, so the stock game doesn't have it. To remove it, restore its first install `
      + 'from Backups under Restore stock… (that also takes it out of the stage list).');
  // No running-game check: a browser can't see processes (the confirmation asks to close Happy Wars).
  if (!sameStockPlan(plan, await planStockRestore(root, id)))
    return done(false, `The files of '${id}' or HappyTool's backups changed after this was planned (another install?), so nothing was `
      + 'changed. Try again to see what it would do now.');

  step(5, 'Verifying the backed-up original files…');
  const entries = [];
  const byPath = new Map();
  for (const f of todo) {
    entries.push(f.entry);
    if (!f.entry.existed) continue;
    const copy = await backupCopy(f.set, f.entry);
    if (!copy) return done(false, `The original of ${f.path} is missing from backup set '${f.set.name}'; nothing was changed.`);
    const bytes = await readBytes(copy);
    if (f.entry.sha256 && (await sha256(bytes)) !== f.entry.sha256.toLowerCase())
      return done(false, `The original of ${f.path} in backup set '${f.set.name}' is corrupt (SHA-256 mismatch); nothing was changed.`);
    byPath.set(f.path.toLowerCase(), bytes);
  }
  const r = await putBack(root, id, 'stock', `State before putting '${id}' back to stock`, entries, byPath, step);
  if (!r.ok) return done(false, r.message, r.pre);
  const message = `Put ${todo.length} file(s) of '${id}' back to stock (undo: restore '${r.pre.name}' from Backups under Restore stock…).`;
  step(100, message);
  return done(true, message, r.pre);
}

// ------------------------------------------------------------------ the map as it ships (StageInstaller.FindStockBundle, StageViewerForm.StockBundle)

/**
 * Stage id's bundle as the game shipped it, as far as HappyTool's backups know (FindStockBundle): the copy the oldest
 * install or settings set holding stage\<id>.bres saved before changing it, as {set, entry, file, sha256}. Null when no
 * backup holds the bundle, the stock game has none (HappyTool added the stage) or the copy is gone.
 */
export async function findStockBundle(root, id, all = null) {
  all ??= await listBackupSets(root);
  const sets = all.filter((s) => s.loadError == null && (s.operation === 'install' || s.operation === 'settings'))
    .sort((a, b) => byCreated(a, b) || cmpIgnoreCase(a.name, b.name));
  for (const set of sets) {
    const e = set.entries.find((x) => isBundleOf(x, id));
    if (!e) continue;
    if (!e.existed) return null;
    const file = await backupCopy(set, e);
    return file && e.sha256 ? { set, entry: e, file, sha256: e.sha256.toLowerCase() } : null;
  }
  return null;
}

/**
 * The stage as it ships, for "start over" (StageViewerForm.StockBundle): {bytes, sha256, set} from the stock copy in
 * HappyTool's backups, else the game's own file when no backup holds it (HappyTool never changed it), else null.
 */
export async function stockBundle(root, id, all = null) {
  if (!isValidStageId(id)) return null;
  all ??= await listBackupSets(root);
  const stock = await findStockBundle(root, id, all);
  if (stock) return { bytes: await readBytes(stock.file), sha256: stock.sha256, set: stock.set };
  const game = await fileAt(root.data, `stage\\${id}.bres`);
  const own = `stage\\${id}.bres`;
  if (!game || (await stageBackupSets(root, id, all)).some((s) => (s.entries ?? []).some((e) => sameName(e.path ?? '', own)))) return null;
  const bytes = await readBytes(game);
  return { bytes, sha256: await sha256(bytes), set: null };
}

// ------------------------------------------------------------------ back to an original the user chose (StageInstaller.cs 1340-1435)

async function dirAt(dir, rel) {
  for (const d of parts(rel)) {
    dir = await child(dir, d, 'directory');
    if (!dir) return null;
  }
  return dir;
}

/** Every file under a folder as [relative path, handle], deepest folders included. */
async function filesUnder(dir, rel, deep) {
  const out = [];
  for await (const h of dir.values()) {
    if (h.kind === 'file') out.push([`${rel}\\${h.name}`, h]);
    else if (deep) out.push(...(await filesUnder(h, `${rel}\\${h.name}`, true)));
  }
  return out;
}

/**
 * How to put stage id back from an original the user chose (PlanRestoreFromCopy): source.file (a .bres) goes back as
 * stage\<id>.bres; source.folder (another copy's game folder or its Data folder) brings that copy's stage\<id>.bres and
 * the stage's other own files it has (isStageOwnedFile: tables, decoration tables, mini bundle, stage script). Files the
 * copy doesn't have are left as they are. {plan: {stageId, source, sourceName, sourceData, files: [{path, file, differs}],
 * toChange}} or {error}.
 */
export async function planRestoreFromCopy(root, id, source) {
  if (!isValidStageId(id)) return { error: `'${id}' isn't a stage id.` };
  const bundleRel = `stage\\${id}.bres`;
  let bundle, sourceData = null, sourceName;
  if (source?.folder) {
    const picked = source.folder;
    const data = await child(picked, 'Data', 'directory');
    const inData = data ? await fileAt(data, bundleRel) : null;
    sourceData = inData ? data : picked;
    bundle = inData ?? (await fileAt(picked, bundleRel));
    if (!bundle) return { error: `"${picked.name}" has no Data\\${bundleRel}. Choose another copy's game folder or its Data folder.` };
    sourceName = inData ? `${picked.name}\\Data\\${bundleRel}` : `${picked.name}\\${bundleRel}`;
  } else {
    bundle = source?.file;
    sourceName = bundle?.name ?? '';
    try {
      if (!bundle) throw new Error();
      await bundle.getFile();
    } catch {
      return { error: `File not found: ${sourceName}` };
    }
  }
  const own = await fileAt(root.data, bundleRel);
  if (own && (await own.isSameEntry(bundle)))
    return { error: `That is the game's own ${id}.bres, the one to be replaced. Choose the original from another copy of the game, `
      + 'a download or a file you saved.' };
  const plan = { stageId: id, source, sourceName, sourceData: !!sourceData, files: [] };
  const add = async (rel, file) => {
    checkDataPath(rel);
    const now = await fileAt(root.data, rel);
    const differs = !now || (await sha256(await readBytes(now))) !== (await sha256(await readBytes(file)));
    plan.files.push({ path: rel, file, differs });
  };
  await add(bundleRel, bundle);
  if (sourceData)
    for (const sub of ['stage\\mini', 'json\\stage', 'json\\stagedeco', `ssn\\${id}`]) {
      const folder = await dirAt(sourceData, sub);
      if (!folder) continue;
      const found = (await filesUnder(folder, sub, sub === 'json\\stagedeco')).sort((a, b) => cmpIgnoreCase(a[0], b[0]));
      for (const [rel, fh] of found) if (!sameName(rel, bundleRel) && isStageOwnedFile(rel, id)) await add(rel, fh);
    }
  plan.toChange = plan.files.filter((f) => f.differs).length;
  return { plan };
}

/**
 * Puts a stage's files back from the original the user chose (RestoreFromCopy): the plan is made again and must match,
 * every file that differs is read, and the current state is saved as a pre-restore set first, so this can be undone from
 * Backups. Resolves to {ok, message, log, preRestore}.
 */
export async function restoreFromCopy(root, plan, { onStep } = {}) {
  const log = [];
  const step = (pct, text) => {
    log.push(text);
    onStep?.(pct, text);
  };
  const done = (ok, message, preRestore = null) => ({ ok, message, log, preRestore });
  if (!plan || plan.files.length === 0) return done(false, 'Nothing was chosen to put back.');
  const id = plan.stageId;
  const todo = plan.files.filter((f) => f.differs);
  if (!todo.length) {
    const message = `'${id}' is already the same as the chosen original.`;
    step(100, message);
    return done(true, message);
  }
  // No running-game check: a browser can't see processes (the confirmation asks to close Happy Wars).
  const again = await planRestoreFromCopy(root, id, plan.source);
  if (!again.plan || again.plan.files.length !== plan.files.length
      || !again.plan.files.every((f, i) => f.path === plan.files[i].path && f.differs === plan.files[i].differs))
    return done(false, again.error ?? "The game's files or the chosen original changed after this was planned, so nothing was changed. "
      + 'Try again to see what it would do now.');

  step(5, 'Reading the chosen original…');
  const entries = [];
  const byPath = new Map();
  for (const f of todo) {
    entries.push({ path: f.path, existed: true });
    byPath.set(f.path.toLowerCase(), await readBytes(f.file));
  }
  const r = await putBack(root, id, plan.sourceName, `State before putting '${id}' back from ${plan.sourceName}`, entries, byPath, step);
  if (!r.ok) return done(false, r.message, r.pre);
  const message = `Put ${todo.length} file(s) of '${id}' back from ${plan.sourceName} (undo: restore '${r.pre.name}' from Backups under Restore stock…).`;
  step(100, message);
  return done(true, message, r.pre);
}
