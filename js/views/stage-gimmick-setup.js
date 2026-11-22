// Gimmick setup: what a stage gives its gimmicks at the start of a match — a castle, gate or monument's team, whether a
// ballista or cannon starts built, which gate a battering ram drives at, a field monument's number. Port of the desktop's
// StageViewerForm.GimmickSetup.cs.
//
// The team and build state live in the stage script (stage_setting.nut, in the stage bundle and installed loose under
// Data\ssn\<id>), a ladder / barricade / ram's team and a ram's gate in its gimmick table record (param0_ / param1_), a
// monument's number in param0_. New field monuments get the bots' tactics records (Data\json\stage\<id>_stage_tactics.json)
// of the nearest shipped one; a shipped target moved to another's stock spot takes that one's.
//
// Edits are kept per tag as {Team, Build, RamTarget, Number} (the desktop's GimmickSetupEdit), null = the stage's own.

import {
  SET_COLOR, SET_BUILD, SETUP_FUNCTION, WHITE, BLACK, NEUTRAL, readGimmickScript, scriptText, applyGimmickScriptBytes,
  latin1, latin1Bytes, applyJsonRecords,
} from '../formats/gimmick-script.js';
import { findSection, jsonEntries, jsonFields } from './stage-gimmicks.js';

export const SETUP_KEY = 'gimmickSetup';
export const TACTICS_SECTION = 'invadeSetting_';
const SCRIPT_TEAM_TYPES = new Set(['CastleMonument', 'CastleGateWhite', 'CastleGateBlack', 'FieldMonument', 'CastleBarricade']);
const RECORD_TEAM_TYPES = new Set(['Ladder', 'CastleBarricade', 'BatteringRam']);
const BUILD_TYPES = new Set(['Ballista', 'Cannon']);
export const TEAM_CYCLE = [WHITE, BLACK, NEUTRAL];
export const BUILD_CYCLE = ['RULE_BUILDING_STATE_COMPLETE', 'RULE_BUILDING_STATE_MATERIALS', 'RULE_BUILDING_STATE_BROKEN'];

export const teamName = (c) => (c === WHITE ? 'White' : c === BLACK ? 'Black' : c === NEUTRAL ? 'Neutral' : c ?? '—');
export const buildName = (b) =>
  b === BUILD_CYCLE[0] ? 'Built' : b === BUILD_CYCLE[1] ? 'As materials' : b === BUILD_CYCLE[2] ? 'Broken' : b ?? 'Game default';

const f = Math.fround;
const xz2 = (a, b) => {
  const dx = f(a[0] - b[0]), dz = f(a[2] - b[2]);
  return f(f(dx * dx) + f(dz * dz));
};
/** The first of the list nearest `to` (OrderBy … First: ties keep list order); null for none. */
const nearest = (list, at, to) => {
  let best = null, bestD = Infinity;
  for (const x of list) {
    const d = xz2(at(x), to);
    if (d < bestD) [best, bestD] = [x, d];
  }
  return best;
};
const isWhiteCastle = (g) => g.tag.startsWith('gcmoA') || (!g.tag.startsWith('gcmoB') && (g.model ?? '').endsWith('A'));
const byTagOrder = (a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0);
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
const PARAM_INT = /^\s*[-+]?\d+\s*$/;

export const isEmptySetup = (e) => !e || (e.Team == null && e.Build == null && e.RamTarget == null && e.Number == null);
/** A setup edit with only its known fields (the desktop writes all four, null for unset). */
export const cleanSetup = (e) => ({
  Team: e?.Team ?? null, Build: e?.Build ?? null, RamTarget: e?.RamTarget ?? null,
  Number: Number.isInteger(e?.Number) ? e.Number : null,
});

/** The edits file's gimmickSetup feature: tag → edit, without empty ones; null when none is left. */
export function setupFeature(setup, tags = null) {
  const out = {};
  for (const [tag, e] of Object.entries(setup ?? {}))
    if ((!tags || tags.has(tag)) && !isEmptySetup(e)) out[tag] = cleanSetup(e);
  return Object.keys(out).length ? out : null;
}

/** A stored gimmickSetup feature as the editor keeps it (tag → edit). */
export function setupFromFeature(v) {
  const out = {};
  if (v && typeof v === 'object')
    for (const [tag, e] of Object.entries(v)) if (e && typeof e === 'object' && !isEmptySetup(e)) out[tag] = cleanSetup(e);
  return out;
}

/** The bots' tactics records (invadeSetting_): tag → [{key, color}] in file order; null when the table has none. */
function tacticsByTag(text) {
  const sec = text == null ? null : findSection(text, TACTICS_SECTION);
  if (!sec) return null;
  const by = new Map();
  for (const e of jsonEntries(text, sec.open, sec.close).sort((a, b) => a.open - b.open)) {
    const fl = jsonFields(text.slice(e.open, e.close + 1));
    const tag = fl.get('tagName');
    if (tag == null) continue;
    if (!by.has(tag)) by.set(tag, []);
    by.get(tag).push({ key: e.key, color: fl.get('targetColor') ?? null });
  }
  return by;
}

/**
 * The setup rules over a stage's gimmicks. ctx: placements() (the gimmicks shown), tableText() (the gimmick table's
 * text, null = none loaded), setup (tag → edit, changed in place), nut (the stage script read, or null), bundle(model)
 * (the gimmick bundle's file name a model loads from, or null), tactics (the tactics table's text, one character per byte,
 * or null).
 */
export function gimmickSetupRules(ctx) {
  let recordsOf = null, records = new Map();
  /** The gimmick table's records: tag → fields (GimmickRecords). */
  const tableRecords = () => {
    const t = ctx.tableText();
    if (t === recordsOf) return records;
    records = new Map();
    recordsOf = t;
    const sec = t == null ? null : findSection(t, 'gimmickArrangeParam_');
    if (sec) for (const e of jsonEntries(t, sec.open, sec.close)) records.set(e.key, jsonFields(t.slice(e.open, e.close + 1)));
    return records;
  };
  const list = () => ctx.placements();
  const setupOf = (g) => (g && Object.hasOwn(ctx.setup, g.tag) ? ctx.setup[g.tag] : null);
  const recordField = (g, key) =>
    g.isNew ? (g.templateText != null ? jsonFields(g.templateText).get(key) ?? null : null) : tableRecords().get(g.tag)?.get(key) ?? null;
  const scriptCalls = (name, tag) => (ctx.nut?.calls ?? []).filter((c) => c.fn === SETUP_FUNCTION && c.name === name && c.tag === tag);

  const hasScriptTeam = (g) => SCRIPT_TEAM_TYPES.has(g.type ?? '') || scriptCalls(SET_COLOR, g.tag).length > 0;
  const hasTeam = (g) => hasScriptTeam(g) || RECORD_TEAM_TYPES.has(g.type ?? '');
  const typeTeam = (g) =>
    g.type === 'CastleGateWhite' ? WHITE : g.type === 'CastleGateBlack' ? BLACK : g.type === 'CastleMonument' ? (isWhiteCastle(g) ? WHITE : BLACK) : null;
  const powerColor = (p) => (p != null && p.startsWith('POWER_COLOR_') ? p : null);

  /** The team the stage gives it: its first stage-script call (the first case's first), else its record's param0_, else its type's. */
  const originalTeam = (g) => {
    if (g.isNew) return null;
    const first = ctx.nut?.setupCases?.[0];
    const calls = scriptCalls(SET_COLOR, g.tag);
    const call = calls.find((c) => c.case === first) ?? calls[0];
    if (call) return call.value;
    return powerColor(recordField(g, 'param0_')) ?? typeTeam(g);
  };
  /** A new gimmick's team: a field monument starts neutral, anything else takes its type's, else the nearer castle's. */
  const defaultTeam = (g) => {
    if (g.type === 'FieldMonument') return NEUTRAL;
    if (typeTeam(g) != null) return typeTeam(g);
    const castles = list().filter((c) => c.season == null && !c.removed && c.type === 'CastleMonument' && c !== g);
    const castle = nearest(castles, (c) => c.position, g.position);
    if (castle) return isWhiteCastle(castle) ? WHITE : BLACK;
    return powerColor(recordField(g, 'param0_')) ?? NEUTRAL;
  };
  const teamOf = (g) => setupOf(g)?.Team ?? (g.isNew ? defaultTeam(g) : originalTeam(g));

  const hasBuild = (g) => BUILD_TYPES.has(g.type ?? '') || scriptCalls(SET_BUILD, g.tag).length > 0;
  const originalBuild = (g) => (g.isNew ? null : scriptCalls(SET_BUILD, g.tag)[0]?.value ?? null);
  const buildOf = (g) => setupOf(g)?.Build ?? originalBuild(g);

  const gates = () =>
    list().filter((x) => x.season == null && !x.removed && x.type != null && x.type.startsWith('CastleGate')).sort(byTagOrder);
  const originalRamTarget = (g) => (g.isNew ? null : recordField(g, 'param1_'));
  /** A new ram attacks the nearest gate of the other team (or the nearest gate). */
  const defaultRamTarget = (g) => {
    const team = teamOf(g), all = gates();
    const enemy = all.filter((x) => teamOf(x) !== team && teamOf(x) !== NEUTRAL);
    return nearest(enemy.length ? enemy : all, (x) => x.position, g.position)?.tag ?? recordField(g, 'param1_');
  };
  const ramTargetOf = (g) => setupOf(g)?.RamTarget ?? (g.isNew ? defaultRamTarget(g) : originalRamTarget(g));

  const originalNumber = (g) => {
    const p = g.isNew ? null : recordField(g, 'param0_');
    return p != null && PARAM_INT.test(p) ? parseInt(p, 10) : null;
  };
  /** A new field monument's number: one past the stage's, in tag order among the new ones. */
  const nextMonumentNumber = (g) => {
    const mons = list().filter((x) => x.season == null && x.type === 'FieldMonument');
    const shipped = mons.filter((x) => !x.isNew).map((x) => setupOf(x)?.Number ?? originalNumber(x) ?? 0);
    const top = shipped.length ? Math.max(...shipped) : 0;
    const fresh = mons.filter((x) => x.isNew && !x.removed).sort(byTagOrder);
    return top + 1 + Math.max(0, fresh.indexOf(g));
  };
  const numberOf = (g) => (g.type !== 'FieldMonument' ? null : setupOf(g)?.Number ?? (g.isNew ? nextMonumentNumber(g) : originalNumber(g)));

  /**
   * The record fields the setup changes (field → JSON literal) for the gimmick table writer, or null for none. New
   * gimmicks always get theirs (their template may come from another stage). GimmickSetupFields.
   */
  const setupFields = (g) => {
    if (!g || g.season != null || g.removed || ctx.tableText() == null) return null;
    const e = setupOf(g), out = {};
    if (RECORD_TEAM_TYPES.has(g.type ?? '')) {
      const team = teamOf(g);
      if (team != null && (g.isNew || (e?.Team != null && team !== recordField(g, 'param0_')))) out.param0_ = `"${team}"`;
    }
    if (g.type === 'BatteringRam') {
      const target = ramTargetOf(g);
      if (target != null && (g.isNew || (e?.RamTarget != null && target !== originalRamTarget(g)))) out.param1_ = `"${target}"`;
    }
    if (g.type === 'FieldMonument') {
      const n = numberOf(g);
      if (n != null && (g.isNew || (e?.Number != null && n !== originalNumber(g)))) out.param0_ = String(n);
    }
    return Object.keys(out).length ? out : null;
  };

  // ---------- changing ----------

  /** The edit after `change`, with values set back to the stage's own dropped (ChangeSetup); null = no edit. */
  const changed = (g, change) => {
    const after = cleanSetup(setupOf(g));
    change(after);
    if (!g.isNew) {
      if (after.Team === originalTeam(g)) after.Team = null;
      if (after.Build === originalBuild(g)) after.Build = null;
      if (after.RamTarget === originalRamTarget(g)) after.RamTarget = null;
      if (after.Number === originalNumber(g)) after.Number = null;
    }
    return isEmptySetup(after) ? null : after;
  };
  const step = (cycle, i, d) => cycle[(i + d + cycle.length * 2) % cycle.length];
  /** {what, edit} for the next team / build / gate / number d steps on, or null when there is nothing to step to. */
  const stepTeam = (g, d) => {
    const i = TEAM_CYCLE.indexOf(teamOf(g)), next = step(TEAM_CYCLE, i < 0 ? -1 : i, d);
    return { what: `Team ${teamName(next)}`, edit: changed(g, (e) => (e.Team = next)) };
  };
  const stepBuild = (g, d) => {
    // Game default only while the script has no line for it.
    const states = originalBuild(g) == null ? [null, ...BUILD_CYCLE] : BUILD_CYCLE;
    const i = states.indexOf(buildOf(g)), next = step(states, i < 0 ? 0 : i, d);
    return { what: `Starts ${buildName(next).toLowerCase()}`, edit: changed(g, (e) => (e.Build = next)) };
  };
  const stepRamTarget = (g, d) => {
    const tags = gates().map((x) => x.tag);
    if (!tags.length) return null;
    const i = tags.indexOf(ramTargetOf(g)), next = step(tags, i < 0 ? (d > 0 ? -1 : 0) : i, d);
    return { what: `Attacks ${next}`, edit: changed(g, (e) => (e.RamTarget = next)) };
  };
  const stepNumber = (g, d) => {
    const next = Math.max(1, (numberOf(g) ?? 0) + d);
    return { what: `Monument number ${next}`, edit: changed(g, (e) => (e.Number = next)) };
  };

  /** The option rows for a gimmick ({label, value, title, step(d) → {what, edit}|null, enabled}), [] for none. */
  const rows = (g) => {
    if (!g || g.season != null || ctx.tableText() == null) return [];
    if (!hasTeam(g) && !hasBuild(g) && g.type !== 'BatteringRam' && g.type !== 'FieldMonument') return [];
    const out = [];
    if (hasTeam(g)) {
      const script = hasScriptTeam(g);
      out.push({
        label: 'Team at start', value: teamName(teamOf(g)) + (setupOf(g)?.Team == null && g.isNew ? ' (nearest)' : ''),
        title: (script ? 'Set in the stage script (SetGimmickColor, every match setting)' : 'Set in its record (param0_)')
          + (script && RECORD_TEAM_TYPES.has(g.type) ? ' and its record (param0_)' : '') + '.'
          + (g.type === 'FieldMonument' ? ' Shipped field monuments start Neutral.' : '')
          + (ctx.nut == null && script ? "\nThis stage's script wasn't found, so only the record can change." : ''),
        step: (d) => stepTeam(g, d), enabled: true,
      });
    }
    if (hasBuild(g))
      out.push({
        label: 'Starts', value: buildName(buildOf(g)), step: (d) => stepBuild(g, d), enabled: true,
        title: "Whether it's ready to use when the match starts (the stage script's SetGimmickBuild). Game default: no line in the script.",
      });
    if (g.type === 'BatteringRam') {
      const gs = gates();
      out.push({
        label: 'Attacks gate', value: ramTargetOf(g) ?? '—', step: (d) => stepRamTarget(g, d), enabled: gs.length > 0,
        title: 'The castle gate it drives at (param1_). Gates here: '
          + (gs.length ? gs.map((x) => `${x.tag} (${teamName(teamOf(x))})`).join(', ') + '.' : 'none.'),
      });
    }
    if (g.type === 'FieldMonument')
      out.push({
        label: 'Monument number', value: numberOf(g)?.toString() ?? '—', step: (d) => stepNumber(g, d), enabled: true,
        title: 'param0_: shipped stages number their field monuments 1, 2, 3 … once each.',
      });
    return out;
  };

  // ---------- export ----------

  /** What the stage script needs: changed / new teams, changed build states, bundles new gimmicks load from. ScriptPlan. */
  const scriptPlan = () => {
    const plan = { teams: {}, builds: {}, files: [] };
    const nut = ctx.nut;
    if (!nut) return plan;
    for (const g of list().filter((x) => x.season == null && !x.removed)) {
      if (hasScriptTeam(g)) {
        const team = teamOf(g);
        if (team != null && (g.isNew || (setupOf(g)?.Team != null && team !== originalTeam(g)))) plan.teams[g.tag] = team;
      }
      const build = setupOf(g)?.Build ?? null;
      if (build != null && build !== originalBuild(g)) plan.builds[g.tag] = build;
      // (A script with no bundle list has nowhere to name them; whether the game needs them named isn't known.)
      if (g.isNew && nut.filesOpen >= 0) {
        const name = ctx.bundle?.(g.model);
        if (name && !plan.files.some((x) => sameName(x, name))) plan.files.push(name);
      }
    }
    // Bundles the script loads already need no line.
    plan.files = plan.files.filter((x) => !nut.files.some((y) => sameName(y, x)));
    return plan;
  };
  const planEmpty = (p) => !Object.keys(p.teams).length && !Object.keys(p.builds).length && !p.files.length;

  /** The tactics records each new field monument copies from the nearest shipped one ([[new key, template key]…]). TacticsCopies. */
  const tacticsCopies = (values) => {
    const copies = [];
    const by = tacticsByTag(ctx.tactics);
    if (!by) return copies;
    const shipped = list().filter((x) => x.season == null && !x.isNew && x.type === 'FieldMonument' && by.has(x.tag));
    for (const g of list().filter((x) => x.season == null && x.isNew && !x.removed && x.type === 'FieldMonument')) {
      const near = nearest(shipped, (x) => x.position0, g.position); // the records describe stock spots
      if (!near) break;
      for (const r of by.get(near.tag)) {
        const at = r.key.indexOf(near.tag);
        if (at < 0) continue;
        const key = r.key.slice(0, at) + g.tag + r.key.slice(at + near.tag.length);
        copies.push([key, r.key]);
        values[key] = { tagName: g.tag };
      }
    }
    return copies;
  };
  /**
   * Shipped targets (field monuments, castles) moved nearer another target's stock spot than their own: each of their
   * records takes that target's stock record of the same colour, keeping its own tag ([[key, template key]…]). TacticsMoves.
   */
  const tacticsMoves = (values) => {
    const moves = new Map();
    const by = tacticsByTag(ctx.tactics);
    if (!by) return [];
    const targets = list().filter((x) => x.season == null && !x.isNew && by.has(x.tag));
    for (const g of targets) {
      if (g.removed || xz2(g.position, g.position0) < 1) continue;
      const near = nearest(targets.filter((x) => x.type === g.type), (x) => x.position0, g.position);
      if (near === g) continue;
      for (const r of by.get(g.tag)) {
        const tmpl = by.get(near.tag).find((x) => x.color === r.color);
        if (!tmpl) continue;
        moves.set(r.key, tmpl.key);
        values[r.key] = { tagName: g.tag };
      }
    }
    return [...moves];
  };

  /**
   * Everything the setup writes ({records, plan, planEmpty, copies, moves, values, tacticsEdit, lines}): the gimmick
   * table records it changes (counted for the summary; the table writer writes them), the stage script plan and the
   * tactics records. lines: the summary lines (GimmickSetupExport); `inBundle` / `loose`: which script copies there are.
   */
  const exportPlan = ({ inBundle = false, loose = false } = {}) => {
    if (ctx.tableText() == null) return null;
    const records = list().filter((g) => !g.isNew && setupFields(g) != null).length;
    const plan = scriptPlan(), values = {};
    const copies = tacticsCopies(values), moves = tacticsMoves(values);
    const tacticsEdit = copies.length > 0 || moves.length > 0;
    const lines = [];
    if (records > 0) lines.push(`Gimmick setup: ${records} record(s) changed (team, gate or monument number) in the gimmick table.`);
    const parts = [];
    if (Object.keys(plan.teams).length) parts.push(`${Object.keys(plan.teams).length} team(s)`);
    if (Object.keys(plan.builds).length) parts.push(`${Object.keys(plan.builds).length} build state(s)`);
    if (plan.files.length) parts.push(`${plan.files.length} gimmick bundle(s) to load`);
    if (parts.length)
      lines.push(`Stage script: ${parts.join(', ')}${inBundle ? ' — in the map' : ''}`
        + (loose ? `${inBundle ? ' and' : ' —'} its _ssn_stage_setting.nut` : ' (no installed ssn copy found)') + '.');
    if (copies.length)
      lines.push(`Bot tactics: ${copies.length} record(s) for the new field monuments, copied from the nearest shipped one — written to its _stage_tactics.json.`);
    if (moves.length)
      lines.push(`Bot tactics: ${moves.length} record(s) of moved monuments / castles now match the shipped one nearest their new spot — written to its _stage_tactics.json.`);
    return { records, plan, planEmpty: planEmpty(plan), copies, moves, values, tacticsEdit, lines };
  };

  return {
    setupOf, hasTeam, hasBuild, teamOf, buildOf, ramTargetOf, numberOf, originalTeam, setupFields, rows, gates,
    scriptPlan, tacticsCopies, tacticsMoves, exportPlan,
  };
}

/** The stage script from its file payload ({bytes, info}), or null when it can't be read or written back. */
export function readStageScript(bytes) {
  if (!bytes) return null;
  const st = scriptText(bytes);
  return st ? { bytes, info: readGimmickScript(st.text) } : null;
}

/** The script's bytes with the plan applied ({bytes, changed, inserted, filesAdded}). */
export const applyStageScript = (bytes, plan) => applyGimmickScriptBytes(bytes, plan);

/** The tactics table's bytes with the copies, moves and tags applied. */
export function applyTactics(bytes, copies, values, moves) {
  return latin1Bytes(applyJsonRecords(latin1(bytes), 'stage_tactics.json', TACTICS_SECTION, copies, values, moves).text);
}
