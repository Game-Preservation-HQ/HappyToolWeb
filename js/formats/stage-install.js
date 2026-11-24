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

import { decodeLayers } from './wrappers.js';
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
    createdUtc: roundTrip(set.createdUtc),
    // The desktop writes the full Data path; a browser only knows the folder names. Nothing reads it back.
    dataRoot: `${root.game.name}\\${root.data.name}`,
    source: set.source,
    note: set.note,
    status: set.status,
    lastRestoredUtc: set.lastRestoredUtc ? roundTrip(set.lastRestoredUtc) : null,
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
export async function install(root, plan, bytes, { source, onStep } = {}) {
  const log = [];
  const step = (pct, text) => {
    log.push(text);
    onStep?.(pct, text);
  };
  const done = (ok, message, set = null) => ({ ok, message, log, set });
  if (!plan || plan.hasErrors || !plan.slot) return done(false, 'The install plan has errors; nothing was changed.');
  const id = plan.slot.id;
  // The bytes going to disk must still open as a BRES container.
  try {
    parseBres((await decodeLayers(bytes)).payload);
  } catch (e) {
    return done(false, `The bundle doesn't open as a BRES container (${e.message}); nothing was changed.`);
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
