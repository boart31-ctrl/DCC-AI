// Synced combat tracker (PLAN step 3). Pure + browser-safe: runs inside the engine on Node, in the
// Cloudflare Durable Object and in the hosted edition, so it is persisted like every other action.
//
// state.combat = {
//   active, round, phaseIndex, phases: [name], phasesVerified, showMobHp,
//   combatants: [
//     { uid, type: 'crawler', playerId }                         // HP lives on the sheet (track.set)
//     { uid, type: 'mob', sourceKind: 'monster'|'boss'|null, sourceId, name, image, hp, hpMax,
//       evade, dr, attacks: [{name, toHit, damage, effects, buffs}], conditions: [{id, name}], notes, hidden }
//   ] }
//
// GM actions (docs/PROTOCOL.md §3b): combat.start, combat.end, combat.next, combat.set, combat.addMob,
// combat.addAdhoc, combat.addCrawler, combat.update, combat.damage, combat.heal, combat.condition,
// combat.remove, combat.reveal, combat.mobRoll, combat.target. Auto mode (combat.auto / autoStep /
// autoUndo / autoSkip) and combat endings live in combat-auto.js. Players and the stage never get any.
//
// Crawler combatants also carry targeting: { aggro: 1..9 (weight, default 3), noTarget }. Mobs carry
// { targetMode: 'auto'|'focus'|'spread', focus: crawler uid|null, attackMode: 'first'|'random' }.
// state.combat.settings = auto-mode rules (hitRule, drMin, crit, …: unverified until the rulebook says)
// state.combat.stats = per-crawler damage dealt / taken / downs for the end-of-fight summary.
//
// Views: the GM sees everything. Players and the TV see crawlers + revealed mobs only, mob HP as a
// rounded fraction (exact numbers only with `showMobHp`), never notes / attacks / library GM fields.
import { bad, notFound } from './errors.js';
import { combatRules, mobSlotValue, damageToSlots, typedDamage } from './outcome.js';
import { SHEET, SHEET_GM, libraryOf, computeFor, setTrack } from './character.js';
import { SCENE_GM, introLine } from './scenes.js';

export const DEFAULT_PHASES = ['Crawlers', 'Mobs'];
export const MAX_COMBATANTS = 40;
export const MAX_MOB_HP = 999;
export const MAX_CONDITIONS = 12;
const MANUAL_UNDO_MAX = 20; // Ctrl+Z stack of the GM's hand edits
export const MAX_PHASES = 8;
export const TARGET_MODES = ['auto', 'focus', 'spread'];
export const ATTACK_MODES = ['first', 'random'];
export const AGGRO_MIN = 1;
export const AGGRO_MAX = 9;
export const AGGRO_DEFAULT = 3;

/**
 * Auto-mode rules. Every rule marked unverified is a guess until checked against the rulebook:
 *  hitRule  '>=' hit when d20 + toHit ≥ Evade (tie hits), '>' tie misses          (unverified)
 *  drMin    damage after DR is at least this on a hit (1)                          (unverified)
 *  crit     natural 20: 'double' damage (after the roll, before DR) or 'none'      (unverified)
 *  evadeBase  added to the sheet's Evade for the to-hit target (0; e.g. 10 if Evade is a bonus)  (unverified)
 *  public   auto rolls go to everyone's dice log (true) or GM only
 *  includeHidden  hidden mobs act too in auto mode
 *  finishDowned   downed crawlers (HP 0) may be targeted
 *  stepMs   TV pacing of the auto-mode cinematic per mob (1200..4000, default 2800)
 *  autoEnd  offer victory / defeat when every revealed mob / every crawler is down
 */
export const DEFAULT_SETTINGS = Object.freeze({
  hitRule: '>=', drMin: 1, crit: 'double', evadeBase: 0, public: true, includeHidden: false, finishDowned: false, stepMs: 2800, autoEnd: true, paceV: 2,
  initiative: null, // null = the ruleset decides (5e / PF2e: turn order; crawler packs: phases)
  groupInit: true, // identical monsters (same library entry) share one initiative roll and sit together
});
export const UNVERIFIED_RULES = ['hitRule', 'drMin', 'crit', 'evadeBase'];

function normalizeSettings(raw) {
  const d = DEFAULT_SETTINGS;
  const r = isObj(raw) ? raw : {};
  return {
    hitRule: r.hitRule === '>' ? '>' : '>=',
    drMin: Number.isInteger(r.drMin) && r.drMin >= 0 && r.drMin <= 5 ? r.drMin : d.drMin,
    crit: ['double', 'none'].includes(r.crit) ? r.crit : d.crit,
    evadeBase: Number.isInteger(r.evadeBase) && r.evadeBase >= 0 && r.evadeBase <= 30 ? r.evadeBase : d.evadeBase,
    public: typeof r.public === 'boolean' ? r.public : d.public,
    includeHidden: r.includeHidden === true,
    finishDowned: r.finishDowned === true,
    // paceV 2 (11/2026): the old 2.0 s default felt rushed on the TV, rooms still on it move to the new default
    stepMs: Number.isInteger(r.stepMs) && r.stepMs >= 1200 && r.stepMs <= 4000 && !(r.paceV !== 2 && r.stepMs === 2000) ? r.stepMs : d.stepMs,
    autoEnd: typeof r.autoEnd === 'boolean' ? r.autoEnd : d.autoEnd,
    paceV: 2,
    initiative: typeof r.initiative === 'boolean' ? r.initiative : null,
    groupInit: typeof r.groupInit === 'boolean' ? r.groupInit : d.groupInit,
  };
}

export function initStats() {
  return { dealt: {}, taken: {}, downs: {}, kills: {}, mobDamage: 0, unattributed: 0 };
}
function normalizeStats(raw) {
  const b = initStats();
  if (!isObj(raw)) return b;
  for (const k of ['dealt', 'taken', 'downs', 'kills']) {
    if (isObj(raw[k])) for (const [id, n] of Object.entries(raw[k])) if (Number.isFinite(n)) b[k][id] = n;
  }
  b.mobDamage = Number.isFinite(raw.mobDamage) ? raw.mobDamage : 0;
  b.unattributed = Number.isFinite(raw.unattributed) ? raw.unattributed : 0;
  return b;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function txt(v, field, max, { allowEmpty = false } = {}) {
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  const t = v.trim();
  if (!allowEmpty && !t) throw bad(`${field} must not be empty`);
  if (t.length > max) throw bad(`${field} too long (max ${max})`);
  return t;
}
function intIn(v, field, lo, hi) {
  if (!Number.isInteger(v) || v < lo || v > hi) throw bad(`${field} must be an integer ${lo}..${hi}`);
  return v;
}
function flag(v, field) {
  if (typeof v !== 'boolean') throw bad(`${field} must be a boolean`);
  return v;
}

export function initCombat() {
  return {
    active: false, round: 1, phaseIndex: 0, phases: [...DEFAULT_PHASES], phasesVerified: false, showMobHp: false, combatants: [],
    settings: { ...DEFAULT_SETTINGS }, stats: initStats(), startedAt: null, spreadNext: 0, lastAuto: null, autoQueue: null, id: null,
    init: initInit(),
  };
}

/** Turn order: on, order (uids, first acts first), turn (index), totals (uid -> number), manual (GM dragged it). */
export function initInit() {
  return { on: false, order: [], turn: 0, totals: {}, manual: false, started: false };
}

function normalizeInit(raw, uids) {
  const b = initInit();
  if (!isObj(raw)) return b;
  const known = new Set(uids);
  const totals = {};
  if (isObj(raw.totals)) for (const [k, v] of Object.entries(raw.totals)) if (known.has(k) && Number.isFinite(v)) totals[k] = v;
  const order = Array.isArray(raw.order) ? [...new Set(raw.order.filter((u) => known.has(u)))] : [];
  return { on: raw.on === true, order, turn: Number.isInteger(raw.turn) && raw.turn >= 0 && raw.turn < Math.max(1, order.length) ? raw.turn : 0, totals, manual: raw.manual === true, started: raw.started === true };
}

/** Repairs a saved combat block (missing in old saves → idle tracker). */
export function normalizeCombat(raw) {
  const base = initCombat();
  if (!isObj(raw)) return base;
  const phases = Array.isArray(raw.phases) ? raw.phases.filter((p) => typeof p === 'string' && p.trim()).slice(0, MAX_PHASES) : [];
  const c = {
    active: raw.active === true,
    round: Number.isInteger(raw.round) && raw.round >= 1 ? raw.round : 1,
    phaseIndex: Number.isInteger(raw.phaseIndex) && raw.phaseIndex >= 0 ? raw.phaseIndex : 0,
    phases: phases.length ? phases : base.phases,
    phasesVerified: raw.phasesVerified === true,
    showMobHp: raw.showMobHp === true,
    combatants: (Array.isArray(raw.combatants) ? raw.combatants : []).filter((x) => isObj(x) && typeof x.uid === 'string' && (x.type === 'crawler' || x.type === 'mob')).slice(0, MAX_COMBATANTS),
    settings: normalizeSettings(raw.settings),
    stats: normalizeStats(raw.stats),
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null,
    spreadNext: Number.isInteger(raw.spreadNext) && raw.spreadNext >= 0 ? raw.spreadNext : 0,
    lastAuto: isObj(raw.lastAuto) ? raw.lastAuto : null,
    autoQueue: isObj(raw.autoQueue) && Array.isArray(raw.autoQueue.uids) ? raw.autoQueue : null,
    id: typeof raw.id === 'string' ? raw.id : null,
    ...(Array.isArray(raw.manualUndo) && raw.manualUndo.length ? { manualUndo: raw.manualUndo.filter(isObj).slice(-MANUAL_UNDO_MAX) } : {}),
    ...(isObj(raw.rx) && Array.isArray(raw.rx.decls) ? { rx: raw.rx } : {}), // reaction.js round state
  };
  c.init = normalizeInit(raw.init, c.combatants.map((x) => x.uid));
  c.phaseIndex = Math.min(c.phaseIndex, c.phases.length - 1);
  for (const m of c.combatants) {
    if (m.type === 'crawler') {
      m.aggro = Number.isInteger(m.aggro) && m.aggro >= AGGRO_MIN && m.aggro <= AGGRO_MAX ? m.aggro : AGGRO_DEFAULT;
      m.noTarget = m.noTarget === true;
      continue;
    }
    m.conditions = Array.isArray(m.conditions) ? m.conditions.filter(isObj) : [];
    m.attacks = Array.isArray(m.attacks) ? m.attacks.filter(isObj) : [];
    m.hidden = m.hidden !== false;
    m.targetMode = TARGET_MODES.includes(m.targetMode) ? m.targetMode : 'auto';
    m.focus = typeof m.focus === 'string' ? m.focus : null;
    m.attackMode = ATTACK_MODES.includes(m.attackMode) ? m.attackMode : 'first';
  }
  return c;
}

/** The track crawler damage goes to: `hp`, else the first track. */
export function hpTrackOf(pack) {
  const t = pack.ruleset.tracks;
  return t.find((x) => x.id === 'hp') ?? t[0] ?? null;
}

export function C(st) {
  if (!isObj(st.combat)) st.combat = initCombat();
  if (!isObj(st.combat.settings) || !isObj(st.combat.stats)) st.combat = normalizeCombat(st.combat);
  return st.combat;
}

export function combatantOf(st, uid) {
  if (typeof uid !== 'string') throw bad('uid required');
  const x = C(st).combatants.find((c) => c.uid === uid);
  if (!x) throw notFound(`no combatant ${uid}`);
  return x;
}

export function mobOf(st, uid) {
  const x = combatantOf(st, uid);
  if (x.type !== 'mob') throw bad('that combatant is a crawler: change it on the sheet');
  return x;
}

function roomFor(st, n) {
  if (C(st).combatants.length + n > MAX_COMBATANTS) throw bad(`max ${MAX_COMBATANTS} combatants`);
}

function addCrawler(st, ctx, playerId) {
  const c = C(st);
  if (c.combatants.some((x) => x.type === 'crawler' && x.playerId === playerId)) return null;
  roomFor(st, 1);
  const x = { uid: ctx.genId('cb'), type: 'crawler', playerId, aggro: AGGRO_DEFAULT, noTarget: false };
  // Crawlers first, in party order.
  const lastCrawler = c.combatants.map((y) => y.type).lastIndexOf('crawler');
  c.combatants.splice(lastCrawler + 1, 0, x);
  return x;
}

/** "Goblin" → "Goblin 3": continues numbering per source; renames a lone unnumbered first copy to "… 1". */
function numberedNames(st, base, sourceKey, count) {
  const mobs = C(st).combatants.filter((x) => x.type === 'mob' && x.sourceKey === sourceKey);
  if (count === 1 && !mobs.length) return [base];
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc} (\\d+)$`);
  let n = 0;
  for (const m of mobs) {
    const k = re.exec(m.name);
    if (k) n = Math.max(n, Number(k[1]));
  }
  const lone = mobs.filter((m) => m.name === base);
  if (lone.length && n === 0) for (const m of lone) m.name = `${base} ${++n}`;
  return Array.from({ length: count }, () => `${base} ${++n}`.slice(0, 80));
}

const MOB_TARGETING = Object.freeze({ targetMode: 'auto', focus: null, attackMode: 'first' });

function cleanAttacks(list) {
  return (Array.isArray(list) ? list : []).slice(0, 12).map((a) => ({
    name: String(a.name ?? 'Attack').slice(0, 60),
    toHit: Number.isInteger(a.toHit) ? a.toHit : 0,
    damage: typeof a.damage === 'string' ? a.damage.slice(0, 60) : '',
    effects: typeof a.effects === 'string' ? a.effects.slice(0, 400) : '',
    buffs: Array.isArray(a.buffs) ? a.buffs.filter((b) => typeof b === 'string' && ID_RE.test(b)).slice(0, 10) : [],
    ...(typeof a.dtype === 'string' && a.dtype ? { dtype: a.dtype.slice(0, 30) } : {}),
    ...(typeof a.range === 'string' && a.range ? { range: a.range.slice(0, 60) } : {}),
    ...(typeof a.area === 'string' && a.area ? { area: a.area.slice(0, 120) } : {}),
  }));
}

function adhocAttacks(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 12) throw bad('attacks must be an array (max 12)');
  return raw.map((a, i) => {
    if (!isObj(a)) throw bad(`attacks[${i}] must be an object`);
    return {
      name: txt(a.name, `attacks[${i}].name`, 60),
      toHit: a.toHit === undefined ? 0 : intIn(a.toHit, `attacks[${i}].toHit`, -99, 99),
      damage: a.damage === undefined ? '' : txt(a.damage, `attacks[${i}].damage`, 60, { allowEmpty: true }),
      effects: a.effects === undefined ? '' : txt(a.effects, `attacks[${i}].effects`, 400, { allowEmpty: true }),
      buffs: [],
    };
  });
}

/** Hits on hidden mobs only reach the GM; everything else is public. */
export const audience = (x) => (x.type === 'mob' && x.hidden ? { roles: ['gm'] } : 'all');

/** The boss scene on the TV shows this boss combatant: keep its HP in step. */
function linkedBoss(st, m) {
  return m.type === 'mob' && m.sourceKind === 'boss' && st.scene?.kind === 'boss' && st.scene.data?.bossId === m.sourceId && st.scene.data?.boss;
}

function bossArtState(st, m) {
  const scene = linkedBoss(st, m) ? st.scene.data : null;
  return { scene, phase: scene?.phase ?? m.bossPhase ?? 0, defeated: Boolean(scene?.defeated || m.hp <= 0) };
}

function combatArt(st, library, m) {
  if (m.sourceKind !== 'boss') return m.image ?? null;
  const { scene, phase, defeated } = bossArtState(st, m);
  const boss = scene?.boss ?? library.get('boss', m.sourceId);
  const override = m.bossArtOverride;
  if (override?.phase === phase && override.defeated === defeated) return m.image ?? null;
  const base = boss?.imageSquare || boss?.image || null;
  // Older fights can already contain a custom picture before any phase change.
  if (!override && phase === 0 && !defeated && m.image !== undefined && m.image !== base) return m.image;
  return (defeated && boss?.imageKo)
    || boss?.phases?.[phase]?.image || m.image || boss?.imageSquare || boss?.image || null;
}

export function crawlerHp(st, ctx, x) {
  const p = st.players.find((y) => y.id === x.playerId);
  if (!p) throw notFound(`no player ${x.playerId}`);
  const t = hpTrackOf(ctx.pack);
  if (!t) throw bad('this ruleset has no health track');
  return { p, t };
}

/**
 * Who dealt damage to a mob: `by` (playerId) when the desk says so, else the crawler whose roll is the
 * newest in the dice log within the last 90 s of this fight (a heuristic: the one who just attacked).
 */
function attackerOf(st, a, c, now) {
  if (typeof a.by === 'string' && st.players.some((p) => p.id === a.by)) return a.by;
  const since = Math.max(c.startedAt ?? 0, now - 90_000);
  for (let i = st.rolls.length - 1; i >= 0; i--) {
    const r = st.rolls[i];
    if (r.at < since) break;
    if (r.playerId && c.combatants.some((x) => x.type === 'crawler' && x.playerId === r.playerId)) return r.playerId;
  }
  return null;
}

const bump = (map, id, n) => { if (id) map[id] = (map[id] ?? 0) + n; };

/** Voice line from a quip category (P1, `crit` so it also plays in combat mode). */
export function comboLine(st, ctx, category, delayMs = 0) {
  const line = ctx.h.categoryLine?.(st, ctx, category, 1);
  if (!line) return null;
  line.crit = true;
  if (delayMs > 0) line.delayMs = Math.round(delayMs);
  return line;
}

/** Chat reaction cue for the host (chat.js): an event nobody receives, with an optional delay. */
export function chatCue(out, cue, fill = {}, delayMs = 0) {
  out.emit({ kind: 'chat.cue', cue, fill, delayMs: Math.max(0, Math.round(delayMs)) }, { roles: [] });
}

function changeHp(st, a, ctx, out, sign) {
  const c = C(st);
  const x = combatantOf(st, a.uid);
  let amount = a.amount === undefined ? 1 : intIn(a.amount, 'amount', 1, MAX_MOB_HP);
  const kind = sign < 0 ? 'combat.hit' : 'combat.heal';
  // a.dr === true: `amount` is the rolled damage, the target's DR comes off (never below the rules' minimum).
  let drApplied = 0;
  if (sign < 0 && a.dr === true) {
    let dr = 0;
    if (x.type === 'mob') dr = x.dr || 0;
    else {
      const p = st.players.find((y) => y.id === x.playerId);
      try { dr = defenseOf(ctx.pack, computeFor(p, ctx.pack, libraryOf(st, ctx.pack)).computed).dr; } catch { dr = 0; }
    }
    const min = combatRules(ctx.pack, c.settings).drMin ?? 0;
    let after = Math.max(min, amount - Math.max(0, dr));
    // a.dtype: the damage type; a mob's resist / vulnerable / immune lists change it (after DR).
    if (a.dtype && x.type === 'mob') after = typedDamage(after, a.dtype, x).amount;
    drApplied = amount - after;
    amount = after;
    if (amount <= 0) { out.result = { hp: x.hp ?? null, blocked: true, dr }; out.changed = false; return; }
    // Slot health bars: rolled damage removes whole slots (outcome.js damageToSlots); less than one slot = nothing.
    let sv = 1;
    if (x.type === 'mob') sv = mobSlotValue(ctx.pack, x);
    else {
      const p = st.players.find((y) => y.id === x.playerId);
      const t = hpTrackOf(ctx.pack);
      try { sv = computeFor(p, ctx.pack, libraryOf(st, ctx.pack)).computed.tracks[t.id].slotValue || 1; } catch { sv = 1; }
    }
    if (sv > 1) {
      const rolled = amount;
      amount = damageToSlots(amount, sv);
      if (amount <= 0) { out.result = { hp: x.hp ?? null, blocked: true, belowSlot: true, rolled, slotValue: sv, dr }; out.changed = false; return; }
    }
  }
  if (x.type === 'crawler') {
    // Sheets stay the single source of truth: same path as the sheet's own track.set.
    const { p, t } = crawlerHp(st, ctx, x);
    const lib = libraryOf(st, ctx.pack);
    const before = computeFor(p, ctx.pack, lib).computed.tracks[t.id].cur;
    setTrack(st, p, { track: t.id, delta: sign * amount }, ctx, out);
    const cur = computeFor(p, ctx.pack, lib).computed.tracks[t.id];
    const down = cur.cur <= 0;
    if (sign < 0) bump(c.stats.taken, p.id, before - cur.cur);
    out.emit({ kind, uid: x.uid, type: 'crawler', playerId: p.id, name: p.name, amount, hp: cur.cur, max: cur.max, down }, 'all');
    if (sign < 0 && before > 0 && down) {
      bump(c.stats.downs, p.id, 1);
      const line = a.line === false ? null : comboLine(st, ctx, 'crawler_down', 900);
      if (line) out.lines.push(line);
    }
    out.result = { hp: cur.cur, max: cur.max, amount, drApplied };
    return;
  }
  const from = x.hp;
  x.hp = Math.max(0, Math.min(x.hpMax, x.hp + sign * amount));
  const ev = out.emit({ kind, uid: x.uid, type: 'mob', name: x.name, amount: Math.abs(x.hp - from), hp: x.hp, max: x.hpMax, down: x.hp <= 0 }, audience(x));
  if (sign < 0 && from > x.hp) {
    const by = attackerOf(st, a, c, ctx.now);
    c.stats.mobDamage += from - x.hp;
    if (by) bump(c.stats.dealt, by, from - x.hp); else c.stats.unattributed += from - x.hp;
    if (x.hp === 0) {
      if (by) bump(c.stats.kills, by, 1);
      if (!x.hidden) {
        ctx.h.feedPush(st, ev, `${x.name} is down`);
        const line = a.line === false ? null : comboLine(st, ctx, 'mob_killed', 700);
        if (line) out.lines.push(line);
      }
    }
  }
  if (linkedBoss(st, x)) SCENE_GM[sign < 0 ? 'boss.damage' : 'boss.heal'](st, { amount }, ctx, out);
  out.result = { hp: x.hp, max: x.hpMax, amount, drApplied };
}

/** Damage from a player's entered / digital damage roll (character.js resolveAgainst). */
export function applyMobDamage(st, ctx, out, { uid, amount, by }) {
  changeHp(st, { uid, amount: Math.min(MAX_MOB_HP, Math.max(1, Math.round(amount))), by }, ctx, out, -1);
}

function libSource(st, ctx, a) {
  if (typeof a.sourceId !== 'string' || !ID_RE.test(a.sourceId)) throw bad('sourceId must be a library id');
  const lib = libraryOf(st, ctx.pack);
  if (a.kind !== undefined && a.kind !== 'monster' && a.kind !== 'boss') throw bad('kind must be monster or boss');
  const kinds = a.kind ? [a.kind] : ['monster', 'boss'];
  for (const k of kinds) {
    const e = lib.get(k, a.sourceId);
    if (e) return { kind: k, e };
  }
  throw notFound(`no monster or boss ${a.sourceId}`);
}

function conditionOf(st, ctx, a) {
  if (a.buffId !== undefined) {
    const def = libraryOf(st, ctx.pack).get('buff', a.buffId);
    if (!def) throw notFound(`unknown buff ${a.buffId}`);
    return { id: def.id, name: def.name };
  }
  return { id: null, name: txt(a.name, 'name', 40) };
}

/** A new round: timed conditions tick down (mobs: condition.rounds, crawlers in the fight: buff.roundsLeft). */
function tickConditions(st, ctx) {
  const ended = [];
  for (const x of C(st).combatants) {
    if (x.type === 'mob') {
      x.conditions = x.conditions.filter((k) => {
        if (!k.rounds) return true;
        k.rounds -= 1;
        if (k.rounds > 0) return true;
        ended.push(`${k.name} on ${x.name}`);
        return false;
      });
    } else if (x.playerId) {
      const p = st.players.find((y) => y.id === x.playerId);
      if (!p) continue;
      p.sheet.buffs = p.sheet.buffs.filter((b) => {
        if (!b.roundsLeft) return true;
        b.roundsLeft -= 1;
        if (b.roundsLeft > 0) { b.until = `${b.roundsLeft} round${b.roundsLeft === 1 ? '' : 's'}`; return true; }
        ended.push(`${b.name} on ${p.name}`);
        return false;
      });
    }
  }
  if (ended.length && ctx.h?.feedPush) ctx.h.feedPush(st, { id: ctx.genId('ev'), kind: 'combat.condEnd', at: ctx.now }, `Worn off: ${ended.join(', ')}`);
  return ended;
}

const sameCond = (c, k) => (k.id ? c.id === k.id : c.name.toLowerCase() === k.name.toLowerCase());

/** Mob art: a /pack/ image or an http(s) URL (the GM art gallery), or null for the generated silhouette. */
function mobImage(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^(https?:\/\/|\/pack\/)[^\s"'<>]{1,500}$/.test(v)) throw bad('image must be a /pack/ path or an http(s) URL');
  return v;
}

/**
 * Image chooser for copies of one library entry: with family variants each copy on the field gets
 * a picture nobody else of its kind is wearing (the base art first, then the variants at random);
 * once all are taken, the least used one.
 */
function familyPicker(st, ctx, kind, e, sourceKey) {
  const base = (kind === 'boss' && e.imageSquare) || e.image || null;
  const pool = [...new Set([base, ...(kind === 'monster' && Array.isArray(e.variants) ? e.variants : [])].filter(Boolean))];
  if (pool.length < 2) return () => base;
  const uses = new Map(pool.map((p) => [p, 0]));
  for (const x of C(st).combatants) if (x.sourceKey === sourceKey && uses.has(x.image)) uses.set(x.image, uses.get(x.image) + 1);
  const rnd = typeof ctx.rng === 'function' ? ctx.rng : Math.random;
  return () => {
    const min = Math.min(...uses.values());
    let free = pool.filter((p) => uses.get(p) === min);
    if (free.includes(base)) free = [base];
    const img = free[Math.floor(rnd() * free.length) % free.length];
    uses.set(img, uses.get(img) + 1);
    return img;
  };
}

// ---------- initiative (turn order) ----------

/** Is this fight run in turn order? Tracker setting first, then the ruleset (5e / PF2e yes, crawler packs no). */
export function initiativeOn(st, pack) {
  const s = C(st).settings.initiative;
  return typeof s === 'boolean' ? s : !!pack.ruleset.combat?.initiative?.enabled;
}

function initBonusOf(st, ctx, x) {
  if (x.type === 'mob') return Number.isFinite(x.initiative) ? x.initiative : 0;
  const p = st.players.find((y) => y.id === x.playerId);
  if (!p) return 0;
  const id = ctx.pack.ruleset.combat?.initiative?.derived ?? 'initiative';
  try {
    const v = computeFor(p, ctx.pack, libraryOf(st, ctx.pack)).computed.derived[id]?.value;
    if (Number.isFinite(v)) return v;
    return computeFor(p, ctx.pack, libraryOf(st, ctx.pack)).computed.stats.dex?.mod?.value ?? 0;
  } catch {
    return 0;
  }
}

/** Sorts the order by totals (highest first). Ties: monsters first in PF2e, players first otherwise. */
function sortInit(st, ctx) {
  const c = C(st);
  const I = c.init;
  const all = c.combatants.map((x) => x.uid);
  if (I.manual) {
    // Keep the GM's order; newcomers with a total slot in by their total, the rest go last.
    const cur = I.order.filter((u) => all.includes(u));
    for (const u of all) {
      if (cur.includes(u) || !Number.isFinite(I.totals[u])) continue;
      const i = cur.findIndex((v) => !Number.isFinite(I.totals[v]) || I.totals[v] < I.totals[u]);
      if (i < 0) cur.push(u); else cur.splice(i, 0, u);
    }
    I.order = cur;
    return;
  }
  const mobsFirst = ctx.pack.ruleset.system?.family === 'pf2e';
  const typeOf = new Map(c.combatants.map((x) => [x.uid, x.type]));
  const groupOf = new Map(c.combatants.map((x) => [x.uid, initGroup(x) ?? '']));
  const current = I.order[I.turn];
  I.order = all
    .filter((u) => Number.isFinite(I.totals[u]))
    .sort((a, b) => I.totals[b] - I.totals[a] || (typeOf.get(a) === typeOf.get(b) ? groupOf.get(a).localeCompare(groupOf.get(b)) : (typeOf.get(a) === 'mob') === mobsFirst ? -1 : 1));
  // Before the first turn starts the top of the order is up; after that the current turn stays put.
  I.turn = I.started && current ? Math.max(0, I.order.indexOf(current)) : 0;
}

/** Mobs from the same library entry form one initiative group (DMG: identical monsters roll once, act together). */
function initGroup(x) {
  return x.type === 'mob' && x.sourceId ? `${x.sourceKind || 'monster'}:${x.sourceId}` : null;
}

function rollInit(st, ctx, x) {
  const c = C(st);
  const g = c.settings.groupInit !== false ? initGroup(x) : null;
  if (g) {
    const mate = c.combatants.find((y) => y.uid !== x.uid && initGroup(y) === g && Number.isFinite(c.init.totals[y.uid]));
    if (mate) return c.init.totals[mate.uid];
  }
  const d20 = (ctx.rollInt ?? ctx.randInt)(20) + 1;
  return d20 + initBonusOf(st, ctx, x);
}

/** Sets one combatant's initiative total and re-sorts. */
export function setInitiative(st, ctx, out, uid, total) {
  const c = C(st);
  if (!c.init.on) return false;
  c.init.totals[uid] = total;
  sortInit(st, ctx);
  out.emit({ kind: 'combat.order', order: c.init.order }, { roles: ['gm'] });
  return true;
}

/** Called after any sheet roll: an initiative roll during a turn-order fight sets that crawler's place. */
export function onSheetRoll(st, ctx, out, rec) {
  const c = C(st);
  if (!c.active || !c.init?.on || !rec.playerId || rec.void) return;
  const id = ctx.pack.ruleset.combat?.initiative?.derived ?? 'initiative';
  if (rec.what !== 'derived' || rec.whatId !== id) return;
  const x = c.combatants.find((y) => y.type === 'crawler' && y.playerId === rec.playerId);
  if (x) setInitiative(st, ctx, out, x.uid, rec.total);
}

function turnEvent(st, out) {
  const c = C(st);
  const I = c.init;
  const at = (i) => c.combatants.find((x) => x.uid === I.order[i]) ?? null;
  const cur = at(I.turn);
  if (!cur) return;
  // Next living combatant after the current one (downed crawlers still get turns: death saves).
  let next = null;
  for (let k = 1; k <= I.order.length; k++) {
    const y = at((I.turn + k) % I.order.length);
    if (y && y.uid !== cur.uid && !(y.type === 'mob' && y.hp <= 0)) { next = y; break; }
  }
  const pub = (x) => (x ? { uid: x.type === 'mob' && x.hidden ? null : x.uid, name: x.type === 'mob' && x.hidden ? 'Something unseen' : x.name, playerId: x.playerId ?? null, type: x.type } : null);
  out.emit({ kind: 'combat.turn', round: c.round, current: pub(cur), next: pub(next) }, 'all');
}

/** Next in the turn order, skipping downed mobs; wrapping starts a new round. */
function nextTurn(st, ctx, out) {
  const c = C(st);
  const I = c.init;
  if (!I.order.length) throw bad('nobody has rolled initiative yet');
  for (let k = 1; k <= I.order.length; k++) {
    const i = (I.turn + k) % I.order.length;
    if (i <= I.turn) {
      // wrapped
    }
    const x = c.combatants.find((y) => y.uid === I.order[i]);
    if (!x || (x.type === 'mob' && x.hp <= 0)) continue;
    if (!I.started) {
      // First press: the top of the order starts round 1.
      I.started = true;
      I.turn = 0;
      turnEvent(st, out);
      return;
    }
    if (i <= I.turn) { c.round += 1; tickConditions(st, ctx); }
    I.turn = i;
    turnEvent(st, out);
    return;
  }
}

export const INIT_GM = {
  /** Rolls initiative for `uids` (default: everyone without a total). Crawlers use their sheet's initiative. */
  'combat.initRoll'(st, a, ctx, out) {
    const c = C(st);
    if (!c.init.on) throw bad('this fight is not in turn order');
    const want = Array.isArray(a.uids) ? a.uids : c.combatants.filter((x) => !Number.isFinite(c.init.totals[x.uid])).map((x) => x.uid);
    for (const uid of want) {
      const x = combatantOf(st, uid);
      c.init.totals[x.uid] = rollInit(st, ctx, x);
    }
    sortInit(st, ctx);
    out.result = { order: c.init.order };
  },
  /** GM types a total (e.g. a player's physical roll). */
  'combat.initiative'(st, a, ctx, out) {
    const x = combatantOf(st, a.uid);
    if (!C(st).init.on) throw bad('this fight is not in turn order');
    setInitiative(st, ctx, out, x.uid, intIn(a.total, 'total', -20, 99));
  },
  /** GM drags the order: a list of uids (any not listed keep their place at the end). */
  'combat.order'(st, a, ctx, out) {
    const c = C(st);
    if (!Array.isArray(a.uids)) throw bad('uids must be an array');
    const known = new Set(c.combatants.map((x) => x.uid));
    const cur = c.init.order[c.init.turn];
    const seen = [...new Set(a.uids.filter((u) => known.has(u)))];
    c.init.order = [...seen, ...c.init.order.filter((u) => !seen.includes(u))];
    c.init.manual = true;
    if (cur) c.init.turn = Math.max(0, c.init.order.indexOf(cur));
    out.emit({ kind: 'combat.order', order: c.init.order }, 'all');
  },
  /** Jumps the turn to a combatant. */
  'combat.turnSet'(st, a, ctx, out) {
    const c = C(st);
    const i = c.init.order.indexOf(a.uid);
    if (i < 0) throw notFound('that combatant is not in the turn order');
    c.init.turn = i;
    c.init.started = true;
    turnEvent(st, out);
  },
};

/**
 * Crawler side: the face of my real die; the server adds my initiative bonus (sheet initiative, else DEX)
 * and slots me into the turn order. Works without dice entry on the phone and in rulesets with no
 * "initiative" number on the sheet (turn order switched on for a crawler pack).
 */
export const INIT_PLAYER = {
  'init.mine'(st, a, ctx, out) {
    const c = C(st);
    if (!c.active || !c.init?.on) throw bad('no fight in turn order right now');
    const x = c.combatants.find((y) => y.type === 'crawler' && y.playerId === a.actorId);
    if (!x) throw notFound('you are not in this fight');
    const sides = Number(String(ctx.pack.ruleset.dice || 'd20').replace(/^d/, '')) || 20;
    const die = intIn(a.die, 'die', 1, sides);
    const bonus = initBonusOf(st, ctx, x);
    const total = die + bonus;
    setInitiative(st, ctx, out, x.uid, total);
    out.result = { total, die, bonus, place: c.init.order.indexOf(x.uid) + 1, of: c.init.order.length };
  },
};

export const COMBAT_GM = {
  'combat.start'(st, a, ctx, out) {
    const c = C(st);
    if (a.phases !== undefined) COMBAT_GM['combat.set'](st, { phases: a.phases }, ctx, out);
    if (!c.active) {
      c.stats = initStats();
      c.startedAt = ctx.now;
      c.id = ctx.genId('cbt');
      c.spreadNext = 0;
      c.lastAuto = null;
      c.autoQueue = null;
    }
    c.active = true;
    c.round = 1;
    c.phaseIndex = 0;
    for (const p of st.players) addCrawler(st, ctx, p.id);
    const on = initiativeOn(st, ctx.pack);
    if (!c.init?.on && on) c.init = { ...initInit(), on: true };
    else if (!on) c.init = initInit();
    if (on) {
      // Monsters roll right away; crawlers roll on their phones (or the GM rolls / types for them).
      for (const x of c.combatants) if (x.type === 'mob' && !Number.isFinite(c.init.totals[x.uid])) c.init.totals[x.uid] = rollInit(st, ctx, x);
      sortInit(st, ctx);
    }
    const ev = out.emit({ kind: 'combat.start', round: 1, phaseIndex: 0, phase: on ? 'Roll initiative' : c.phases[0], initiative: on }, 'all');
    ctx.h.feedPush(st, ev, on ? 'Combat! Roll initiative.' : `Combat! Round 1: ${c.phases[0]}`);
  },

  'combat.end'(st, a, ctx, out) {
    const c = C(st);
    const keep = { phases: c.phases, phasesVerified: c.phasesVerified, showMobHp: c.showMobHp, settings: c.settings };
    st.combat = { ...initCombat(), ...keep };
    out.emit({ kind: 'combat.end' }, 'all');
  },

  'combat.next'(st, a, ctx, out) {
    const c = C(st);
    if (c.init?.on) {
      nextTurn(st, ctx, out);
      out.result = { round: c.round, turn: c.init.turn };
      return;
    }
    if (c.phaseIndex >= c.phases.length - 1) { c.phaseIndex = 0; c.round += 1; tickConditions(st, ctx); } else c.phaseIndex += 1;
    out.emit({ kind: 'combat.phase', round: c.round, phaseIndex: c.phaseIndex, phase: c.phases[c.phaseIndex] }, 'all');
    out.result = { round: c.round, phaseIndex: c.phaseIndex };
  },

  /** Tracker settings: phases (names in order), round, phaseIndex, showMobHp (exact mob HP on TV/phones). */
  'combat.set'(st, a) {
    const c = C(st);
    if (a.phases !== undefined) {
      if (!Array.isArray(a.phases) || !a.phases.length || a.phases.length > MAX_PHASES) throw bad(`phases must be 1..${MAX_PHASES} names`);
      c.phases = a.phases.map((p, i) => txt(p, `phases[${i}]`, 40));
      c.phaseIndex = Math.min(c.phaseIndex, c.phases.length - 1);
    }
    if (a.phasesVerified !== undefined) c.phasesVerified = flag(a.phasesVerified, 'phasesVerified');
    if (a.round !== undefined) c.round = intIn(a.round, 'round', 1, 9999);
    if (a.phaseIndex !== undefined) c.phaseIndex = intIn(a.phaseIndex, 'phaseIndex', 0, c.phases.length - 1);
    if (a.showMobHp !== undefined) c.showMobHp = flag(a.showMobHp, 'showMobHp');
    if (a.settings !== undefined) {
      if (!isObj(a.settings)) throw bad('settings must be an object');
      const n = { ...c.settings };
      for (const [k, v] of Object.entries(a.settings)) {
        if (k === 'hitRule') { if (v !== '>=' && v !== '>') throw bad('settings.hitRule must be ">=" or ">"'); n.hitRule = v; }
        else if (k === 'drMin') n.drMin = intIn(v, 'settings.drMin', 0, 5);
        else if (k === 'crit') { if (!['double', 'none'].includes(v)) throw bad('settings.crit must be double or none'); n.crit = v; }
        else if (k === 'stepMs') n.stepMs = intIn(v, 'settings.stepMs', 1200, 4000);
        else if (k === 'evadeBase') n.evadeBase = intIn(v, 'settings.evadeBase', 0, 30);
        else if (k === 'initiative') { if (v !== null && typeof v !== 'boolean') throw bad('settings.initiative must be true, false or null'); n.initiative = v; }
        else if (['public', 'includeHidden', 'finishDowned', 'autoEnd', 'groupInit'].includes(k)) n[k] = flag(v, `settings.${k}`);
        else throw bad(`unknown setting ${k}`);
      }
      c.settings = n;
    }
  },

  /**
   * Targeting. Crawler: aggro (1..9 weight, default 3), noTarget (never auto-targeted).
   * Mob: targetMode auto|focus|spread, focus (crawler uid or null), attackMode first|random.
   */
  'combat.target'(st, a) {
    const x = combatantOf(st, a.uid);
    if (x.type === 'crawler') {
      for (const k of ['targetMode', 'focus', 'attackMode']) if (a[k] !== undefined) throw bad(`${k} is for mobs`);
      if (a.aggro !== undefined) x.aggro = intIn(a.aggro, 'aggro', AGGRO_MIN, AGGRO_MAX);
      if (a.noTarget !== undefined) x.noTarget = flag(a.noTarget, 'noTarget');
      return;
    }
    for (const k of ['aggro', 'noTarget']) if (a[k] !== undefined) throw bad(`${k} is for crawlers`);
    if (a.targetMode !== undefined) {
      if (!TARGET_MODES.includes(a.targetMode)) throw bad(`targetMode must be one of ${TARGET_MODES.join(', ')}`);
      x.targetMode = a.targetMode;
    }
    if (a.focus !== undefined) {
      if (a.focus === null) x.focus = null;
      else {
        const t = combatantOf(st, a.focus);
        if (t.type !== 'crawler') throw bad('focus must be a crawler');
        x.focus = t.uid;
        if (a.targetMode === undefined) x.targetMode = 'focus';
      }
    }
    if (a.attackMode !== undefined) {
      if (!ATTACK_MODES.includes(a.attackMode)) throw bad(`attackMode must be one of ${ATTACK_MODES.join(', ')}`);
      x.attackMode = a.attackMode;
    }
  },

  /** Monsters (or a boss) from the library: `count` copies, auto-numbered, hidden until revealed. */
  'combat.addMob'(st, a, ctx, out) {
    const { kind, e } = libSource(st, ctx, a);
    const count = a.count === undefined ? 1 : intIn(a.count, 'count', 1, 20);
    const hidden = a.hidden === undefined ? true : flag(a.hidden, 'hidden');
    roomFor(st, count);
    const sourceKey = `${kind}:${e.id}`;
    const names = numberedNames(st, e.name, sourceKey, count);
    const pickImage = familyPicker(st, ctx, kind, e, sourceKey);
    const uids = names.map((name) => {
      const m = {
        uid: ctx.genId('cb'), type: 'mob', sourceKind: kind, sourceId: e.id, sourceKey, name,
        image: pickImage(), hp: e.hpSlots ?? 5, hpMax: e.hpSlots ?? 5,
        evade: Number.isInteger(e.evade) ? e.evade : 0, dr: Number.isInteger(e.dr) ? e.dr : 0,
        ...(Number.isInteger(e.slotValue) && e.slotValue >= 1 ? { slotValue: e.slotValue } : {}),
        ...(e.role && e.role !== 'standard' ? { role: e.role } : {}),
        ...(e.flat ? { flat: true } : {}),
        ...(Number.isInteger(e.surprise) ? { surprise: e.surprise } : {}),
        ...(Number.isInteger(e.size?.value) ? { size: e.size.value } : {}),
        ...(e.resist?.length ? { resist: [...e.resist] } : {}),
        ...(e.vulnerable?.length ? { vulnerable: [...e.vulnerable] } : {}),
        ...(e.immune?.length ? { immune: [...e.immune] } : {}),
        attacks: cleanAttacks(e.attacks), conditions: [], notes: '', hidden, ...MOB_TARGETING,
      };
      if (Number.isFinite(e.initiative)) m.initiative = e.initiative;
      C(st).combatants.push(m);
      if (C(st).active && C(st).init?.on) C(st).init.totals[m.uid] = rollInit(st, ctx, m);
      return m.uid;
    });
    if (C(st).active && C(st).init?.on) sortInit(st, ctx);
    // Added straight onto the TV (not hidden): the System introduces a monster the first time it appears.
    if (!hidden && kind === 'monster' && a.intro !== false) {
      const line = introLine(st, ctx, 'monster', e.id);
      if (line) out.lines.push(line);
    }
    out.result = { uids };
  },

  'combat.addAdhoc'(st, a, ctx, out) {
    const base = txt(a.name, 'name', 60);
    const hp = intIn(a.hp, 'hp', 1, MAX_MOB_HP);
    const count = a.count === undefined ? 1 : intIn(a.count, 'count', 1, 20);
    const hidden = a.hidden === undefined ? true : flag(a.hidden, 'hidden');
    const attacks = adhocAttacks(a.attacks);
    roomFor(st, count);
    const sourceKey = `adhoc:${base.toLowerCase()}`;
    const uids = numberedNames(st, base, sourceKey, count).map((name) => {
      const m = {
        uid: ctx.genId('cb'), type: 'mob', sourceKind: null, sourceId: null, sourceKey, name, image: mobImage(a.image),
        hp, hpMax: hp,
        evade: a.evade === undefined ? 0 : intIn(a.evade, 'evade', -99, 99),
        dr: a.dr === undefined ? 0 : intIn(a.dr, 'dr', -99, 99),
        ...(a.slotValue !== undefined ? { slotValue: intIn(a.slotValue, 'slotValue', 1, 50) } : {}),
        attacks, conditions: [], notes: a.notes === undefined ? '' : txt(a.notes, 'notes', 500, { allowEmpty: true }), hidden, ...MOB_TARGETING,
      };
      C(st).combatants.push(m);
      return m.uid;
    });
    out.result = { uids };
  },

  'combat.addCrawler'(st, a, ctx, out) {
    if (typeof a.playerId !== 'string' || !st.players.some((p) => p.id === a.playerId)) throw notFound(`no player ${a.playerId}`);
    const x = addCrawler(st, ctx, a.playerId);
    out.result = { uid: x?.uid ?? C(st).combatants.find((y) => y.playerId === a.playerId).uid, added: !!x };
  },

  'combat.update'(st, a) {
    const m = mobOf(st, a.uid);
    if (a.name !== undefined) m.name = txt(a.name, 'name', 80);
    if (a.hpMax !== undefined) { m.hpMax = intIn(a.hpMax, 'hpMax', 1, MAX_MOB_HP); m.hp = Math.min(m.hp, m.hpMax); }
    if (a.hp !== undefined) m.hp = intIn(a.hp, 'hp', 0, m.hpMax);
    if (a.evade !== undefined) m.evade = intIn(a.evade, 'evade', -99, 99);
    if (a.dr !== undefined) m.dr = intIn(a.dr, 'dr', -99, 99);
    if (a.notes !== undefined) m.notes = txt(a.notes, 'notes', 500, { allowEmpty: true });
    if (a.hidden !== undefined) m.hidden = flag(a.hidden, 'hidden');
    if (a.image !== undefined) {
      m.image = mobImage(a.image);
      if (m.sourceKind === 'boss') {
        const { phase, defeated } = bossArtState(st, m);
        m.bossArtOverride = { phase, defeated };
      }
    }
  },

  'combat.damage'(st, a, ctx, out) { changeHp(st, a, ctx, out, -1); },
  'combat.heal'(st, a, ctx, out) { changeHp(st, a, ctx, out, 1); },

  /** Condition chip on a mob, or a buff on a crawler's sheet (buff.add / buff.remove). */
  'combat.condition'(st, a, ctx, out) {
    const x = combatantOf(st, a.uid);
    const on = flag(a.on, 'on');
    const k = conditionOf(st, ctx, a);
    // Optional duration: counts down at every new round, gone at 0 (null / 0 = until removed).
    const rounds = a.rounds == null || a.rounds === 0 ? null : intIn(a.rounds, 'rounds', 1, 99);
    if (x.type === 'crawler') {
      const { p } = crawlerHp(st, ctx, x);
      if (on) {
        SHEET_GM['buff.add'](st, k.id ? { playerId: p.id, buffId: k.id } : { playerId: p.id, name: k.name }, ctx, out);
        const b = p.sheet.buffs.find((y) => y.uid === out.result?.uid);
        if (b && rounds) { b.roundsLeft = rounds; b.until = `${rounds} round${rounds === 1 ? '' : 's'}`; }
      } else {
        const b = p.sheet.buffs.find((y) => (k.id ? y.buffId === k.id : y.name.toLowerCase() === k.name.toLowerCase()));
        if (!b) throw notFound(`${p.name} does not have ${k.name}`);
        SHEET_GM['buff.remove'](st, { playerId: p.id, uid: b.uid }, ctx, out);
      }
      return;
    }
    if (on) {
      const had = x.conditions.find((c) => sameCond(c, k));
      if (had) { if (rounds) had.rounds = rounds; else delete had.rounds; } else {
        if (x.conditions.length >= MAX_CONDITIONS) throw bad(`max ${MAX_CONDITIONS} conditions`);
        x.conditions.push(rounds ? { ...k, rounds } : k);
      }
    } else x.conditions = x.conditions.filter((c) => !sameCond(c, k));
  },

  /**
   * A saved encounter (prep card kind "encounter"): `mobs` [{kind?, sourceId, count?}] from the library,
   * added like combat.addMob (hidden unless `hidden: false`). Unknown ids are skipped, not fatal.
   */
  'combat.addEncounter'(st, a, ctx, out) {
    if (!Array.isArray(a.mobs) || !a.mobs.length || a.mobs.length > 20) throw bad('mobs must be 1..20 entries');
    const hidden = a.hidden === undefined ? true : flag(a.hidden, 'hidden');
    const uids = [];
    const skipped = [];
    for (const m of a.mobs) {
      if (!isObj(m) || typeof m.sourceId !== 'string') throw bad('each mob needs a sourceId');
      const sub = { ...out, result: null };
      try {
        COMBAT_GM['combat.addMob'](st, { kind: m.kind, sourceId: m.sourceId, count: m.count ?? 1, hidden: a.hidden === undefined && typeof m.hidden === 'boolean' ? m.hidden : hidden }, ctx, sub);
        uids.push(...(sub.result?.uids ?? []));
      } catch (err) {
        if (err?.code === 'not_found') skipped.push(m.sourceId); else throw err;
      }
    }
    out.result = { uids, skipped };
  },

  'combat.remove'(st, a) {
    const x = combatantOf(st, a.uid);
    C(st).combatants = C(st).combatants.filter((y) => y !== x);
    const I = C(st).init;
    if (I) {
      const i = I.order.indexOf(x.uid);
      if (i >= 0) { I.order.splice(i, 1); if (I.turn > i) I.turn -= 1; I.turn = Math.min(I.turn, Math.max(0, I.order.length - 1)); }
      delete I.totals[x.uid];
    }
    for (const m of C(st).combatants) if (m.focus === x.uid) { m.focus = null; if (m.targetMode === 'focus') m.targetMode = 'auto'; }
  },

  /** Shows a mob on the TV and phones (`on: false` hides it again; `all: true` = every mob). */
  'combat.reveal'(st, a, ctx, out) {
    const on = a.on === undefined ? true : flag(a.on, 'on');
    const list = a.all === true ? C(st).combatants.filter((x) => x.type === 'mob') : [mobOf(st, a.uid)];
    const shown = [];
    for (const m of list) {
      if (m.hidden === !on) continue;
      m.hidden = !on;
      if (on) shown.push(m);
    }
    if (shown.length) out.emit({ kind: 'combat.reveal', uids: shown.map((m) => m.uid), names: shown.map((m) => m.name) }, 'all');
    // First sighting of a monster kind this campaign: one intro per reveal (the rest wait for their own turn).
    if (a.intro !== false) {
      for (const id of [...new Set(shown.filter((m) => m.sourceKind === 'monster').map((m) => m.sourceId))]) {
        const line = introLine(st, ctx, 'monster', id);
        if (line) { out.lines.push(line); break; }
      }
    }
    out.result = { changed: list.length };
  },

  /**
   * Rolls a mob attack with the existing dice: d20 + toHit, then its damage dice. Both go to the
   * dice log, GM-secret unless `public: true`.
   */
  'combat.mobRoll'(st, a, ctx, out) {
    const m = mobOf(st, a.uid);
    const i = a.attackIndex === undefined ? 0 : intIn(a.attackIndex, 'attackIndex', 0, Math.max(0, m.attacks.length - 1));
    const atk = m.attacks[i];
    if (!atk) throw bad(`${m.name} has no attacks`);
    const pub = a.public === undefined ? false : flag(a.public, 'public');
    const roll = (formula, label) => {
      const sub = { ...out, result: undefined };
      SHEET.roll(st, { t: 'roll', what: { kind: 'custom', formula, label: label.slice(0, 80) }, secret: !pub }, ctx, sub);
      return sub.result;
    };
    const toHit = atk.toHit ? `d20${atk.toHit > 0 ? '+' : ''}${atk.toHit}` : 'd20';
    const hit = roll(toHit, `${m.name}: ${atk.name}`);
    const rec = st.rolls.find((r) => r.id === hit.rollId);
    let dmg = null;
    if (atk.damage && !/^0+$/.test(atk.damage.trim())) dmg = roll(atk.damage, `${m.name}: ${atk.name} damage`);
    out.result = {
      rollId: hit.rollId, total: hit.total, nat1: !!rec?.nat1, nat20: !!rec?.nat20,
      damageRollId: dmg?.rollId ?? null, damage: dmg?.total ?? null, effects: atk.effects, buffs: atk.buffs, public: pub,
    };
  },
};

export const COMBAT_ACTIONS = Object.keys(COMBAT_GM);

// ---------- views ----------

/** The sheet values auto mode attacks against: Evade (or Defense) and damage resistance (DR / armour). */
export function defenseDefs(pack) {
  const d = pack.ruleset.derived;
  const cr = pack.ruleset.combat;
  if (cr && (cr.defense || cr.dr !== undefined)) {
    const evade = cr.defense ? d.find((x) => x.id === cr.defense) ?? null : null;
    const dr = cr.dr ? d.find((x) => x.id === cr.dr) ?? null : null;
    if (evade) return { evade: { ...evade, label: cr.defenseLabel || evade.label }, dr };
  }
  const evade = d.find((x) => /evade|defen/i.test(`${x.id} ${x.label}`)) || d.find((x) => x.roll) || null;
  const dr = d.find((x) => x !== evade && /(^|[^a-z])dr($|[^a-z])|resist|armou?r/i.test(`${x.id} ${x.label}`)) || null;
  return { evade, dr };
}

export { combatRules, attackOutcome, critFormula, critMultiplier } from './outcome.js';
export function defenseOf(pack, computed) {
  const { evade, dr } = defenseDefs(pack);
  const val = (def) => (def ? Number(computed?.derived?.[def.id]?.value) || 0 : 0);
  return { evade: val(evade), dr: val(dr), evadeLabel: evade?.label ?? 'Evade', drLabel: dr?.label ?? 'DR' };
}

function crawlerRow(state, pack, library, x, gm) {
  const p = state.players.find((y) => y.id === x.playerId);
  if (!p) return null;
  const t = hpTrackOf(pack);
  let hp = { cur: 0, max: 0 };
  let computed = null;
  try { computed = computeFor(p, pack, library).computed; if (t) hp = computed.tracks[t.id]; } catch { /* broken sheet: show 0/0 */ }
  const buffs = p.sheet?.buffs ?? [];
  const row = {
    uid: x.uid, type: 'crawler', playerId: p.id, name: p.name, color: p.color,
    hp: hp.cur, hpMax: hp.max, down: hp.max > 0 && hp.cur <= 0,
    conditions: gm ? buffs.map((b) => ({ uid: b.uid, id: b.buffId ?? null, name: b.name, ...(b.roundsLeft ? { rounds: b.roundsLeft } : {}) })) : buffs.map((b) => ({ id: b.buffId ?? null, name: b.name, ...(b.roundsLeft ? { rounds: b.roundsLeft } : {}) })),
  };
  if (gm) {
    const d = defenseOf(pack, computed);
    Object.assign(row, { aggro: x.aggro ?? AGGRO_DEFAULT, noTarget: !!x.noTarget, evade: d.evade, dr: d.dr });
  }
  // Dying countdown (reaction.js dyingTick): rounds left, or dead.
  if (x.dying != null) row.dying = x.dying;
  if (x.dead) row.dead = true;
  return row;
}

/** Victory when every revealed mob is down, defeat when every crawler in the fight is (auto-end offer). */
export function endSuggestion(state, pack) {
  const c = normalizeCombat(state.combat);
  if (!c.active || !c.settings.autoEnd) return null;
  const library = libraryOf(state, pack);
  const t = hpTrackOf(pack);
  const crawlers = c.combatants.filter((x) => x.type === 'crawler').map((x) => state.players.find((p) => p.id === x.playerId)).filter(Boolean);
  if (crawlers.length && t) {
    const hp = (p) => { try { return computeFor(p, pack, library).computed.tracks[t.id]; } catch { return { cur: 1, max: 1 }; } };
    if (crawlers.every((p) => { const h = hp(p); return h.max > 0 && h.cur <= 0; })) return 'defeat';
  }
  const shown = c.combatants.filter((x) => x.type === 'mob' && !x.hidden);
  // Hidden mobs still standing = a prepared second wave: never call it a victory.
  if (c.combatants.some((x) => x.type === 'mob' && x.hidden && x.hp > 0)) return null;
  if (shown.length && shown.every((m) => m.hp <= 0)) return 'victory';
  return null;
}

/** Mob HP for TV/phones without exact numbers: a fraction rounded up to 5 % (never 0 while alive). */
export function hpFraction(hp, max) {
  if (!max || hp <= 0) return 0;
  return Math.min(1, Math.ceil((hp / max) * 20) / 20);
}

/** view.combat for a role. GM: everything. Player / stage: crawlers + revealed mobs, filtered fields. */
export function combatView(state, pack, role) {
  const c = normalizeCombat(state.combat);
  const gm = role === 'gm';
  const library = libraryOf(state, pack);
  const head = {
    active: c.active, round: c.round, phaseIndex: c.phaseIndex, phase: c.phases[c.phaseIndex] ?? '',
    phases: c.phases, phasesVerified: c.phasesVerified, showMobHp: c.showMobHp,
    defenseLabel: pack.ruleset.combat?.defenseLabel || 'Evade',
  };
  const I = c.init;
  if (I?.on) {
    const byUid = new Map(c.combatants.map((x) => [x.uid, x]));
    const visible = (x) => gm || !(x.type === 'mob' && x.hidden);
    const order = I.order.map((u) => byUid.get(u)).filter((x) => x && visible(x)).map((x) => ({ uid: x.uid, type: x.type, playerId: x.playerId ?? null, ...(gm ? { total: I.totals[x.uid] } : {}), down: x.type === 'mob' ? x.hp <= 0 : undefined }));
    const cur = byUid.get(I.order[I.turn]);
    const waiting = c.combatants.filter((x) => !Number.isFinite(I.totals[x.uid]) && visible(x)).map((x) => ({ uid: x.uid, type: x.type, playerId: x.playerId ?? null }));
    head.init = { on: true, order, turnUid: cur && visible(cur) ? cur.uid : null, turnHidden: !!cur && !visible(cur), waiting, manual: I.manual };
    if (cur) head.phase = cur.type === 'mob' && !visible(cur) ? 'Something unseen' : cur.type === 'mob' ? cur.name : state.players.find((p) => p.id === cur.playerId)?.name ?? '';
  } else head.init = { on: false };
  if (gm) {
    const la = c.lastAuto;
    Object.assign(head, {
      id: c.id, startedAt: c.startedAt, settings: c.settings, unverified: UNVERIFIED_RULES, stats: c.stats,
      manualUndo: (state.combat?.manualUndo ?? []).length ? { label: state.combat.manualUndo.at(-1).label, count: state.combat.manualUndo.length } : null,
      lastAuto: la ? { id: la.id, at: la.at, steps: la.steps, canUndo: !!la.undo && !la.undone, undone: !!la.undone, startAt: la.startAt, stepMs: la.stepMs } : null,
      autoQueue: c.autoQueue ? { id: c.autoQueue.id, uids: c.autoQueue.uids, done: c.autoQueue.done ?? 0 } : null,
      suggestEnd: endSuggestion(state, pack),
      defense: (({ evade, dr }) => ({ evade: evade?.label ?? null, dr: dr?.label ?? null }))(defenseDefs(pack)),
      rules: (({ family, degrees, crit, hitRule, advantage }) => ({ family, degrees, crit, hitRule, advantage }))(combatRules(pack, c.settings)),
    });
    if (!c.active) {
      const existing = new Map(c.combatants.filter((x) => x.type === 'crawler').map((x) => [x.playerId, x]));
      head.previewCrawlers = state.players.map((p) => crawlerRow(state, pack, library,
        existing.get(p.id) ?? { uid: `preview:${p.id}`, playerId: p.id }, false));
    }
  }
  const combatants = [];
  for (const x of c.combatants) {
    if (x.type === 'crawler') {
      const row = crawlerRow(state, pack, library, x, gm);
      if (row) combatants.push(row);
      continue;
    }
    if (gm) {
      const { sourceKey, ...m } = x;
      combatants.push({ ...m, image: combatArt(state, library, m), down: m.hp <= 0, linked: !!linkedBoss(state, x) });
      continue;
    }
    if (x.hidden) continue;
    const row = {
      uid: x.uid, type: 'mob', name: x.name, image: combatArt(state, library, x), boss: x.sourceKind === 'boss',
      group: x.sourceKey ?? null, // same library monster → one pack on the TV
      hpPct: hpFraction(x.hp, x.hpMax), down: x.hp <= 0,
      conditions: (x.conditions ?? []).map((k) => ({ id: k.id ?? null, name: k.name, ...(k.rounds ? { rounds: k.rounds } : {}) })),
      // Size class (book stat blocks): the phone suggests Advantage / Disadvantage from the size gap.
      ...(Number.isInteger(x.size) ? { size: x.size } : {}),
    };
    if (c.showMobHp) Object.assign(row, { hp: x.hp, hpMax: x.hpMax });
    combatants.push(row);
  }
  return { ...head, combatants };
}

/* ---------- Ctrl+Z for the GM's own hand edits ---------- */

const UNDO_LABEL = {
  'combat.damage': (a, n) => `Damage to ${n}`, 'combat.heal': (a, n) => `Heal on ${n}`,
  'combat.condition': (a, n) => `${a.on === false ? 'Removed' : 'Added'} condition on ${n}`,
  'combat.reveal': (a, n) => (a.all ? (a.on === false ? 'Hide all' : 'Reveal all') : `${a.on === false ? 'Hide' : 'Reveal'} ${n}`),
  'combat.remove': (a, n) => `Removed ${n}`, 'combat.update': (a, n) => `Edit ${n}`,
};

/** What an undo needs to put back: the touched mobs as they were (+ their place), a crawler's HP and buffs. */
function undoSnapshot(st, ctx, type, a) {
  const c = C(st);
  const list = type === 'combat.reveal' && a.all === true ? c.combatants.filter((x) => x.type === 'mob') : c.combatants.filter((x) => x.uid === a.uid);
  if (!list.length) return null;
  const snap = { mobs: [], crawler: null, init: type === 'combat.remove' ? structuredClone(c.init) : null };
  for (const x of list) {
    if (x.type === 'mob') { snap.mobs.push({ idx: c.combatants.indexOf(x), obj: structuredClone(x) }); continue; }
    const { p, t } = crawlerHp(st, ctx, x);
    const hp = computeFor(p, ctx.pack, libraryOf(st, ctx.pack)).computed.tracks[t.id].cur;
    snap.crawler = { playerId: p.id, track: t.id, hp, buffs: structuredClone(p.sheet.buffs ?? []) };
  }
  return snap;
}

for (const type of Object.keys(UNDO_LABEL)) {
  const run = COMBAT_GM[type];
  COMBAT_GM[type] = function undoable(st, a, ctx, out) {
    let snap = null;
    try { snap = isObj(a) ? undoSnapshot(st, ctx, type, a) : null; } catch { snap = null; }
    const r = run(st, a, ctx, out);
    if (!snap || out.changed === false) return r;
    if (snap.crawler) {
      const p = st.players.find((y) => y.id === snap.crawler.playerId);
      try { snap.crawler.after = computeFor(p, ctx.pack, libraryOf(st, ctx.pack)).computed.tracks[snap.crawler.track].cur; } catch { snap.crawler.after = snap.crawler.hp; }
    }
    const who = snap.mobs[0]?.obj.name ?? st.players.find((y) => y.id === snap.crawler?.playerId)?.name ?? '?';
    const c = C(st);
    c.manualUndo = [...(c.manualUndo ?? []), { id: ctx.genId('mu'), at: ctx.now, type, label: UNDO_LABEL[type](a, who), snap }].slice(-MANUAL_UNDO_MAX);
    return r;
  };
}

/** Takes back the GM's newest hand edit (damage, heal, condition, reveal / hide, remove, edit). */
COMBAT_GM['combat.undo'] = function combatUndo(st, a, ctx, out) {
  const c = C(st);
  const e = (c.manualUndo ?? []).pop();
  if (!e) throw bad('nothing to undo');
  const { mobs, crawler, init } = e.snap;
  for (const { idx, obj } of mobs) {
    const i = c.combatants.findIndex((x) => x.uid === obj.uid);
    const now = i >= 0 ? c.combatants[i] : null;
    if (now) c.combatants[i] = obj; else c.combatants.splice(Math.min(idx, c.combatants.length), 0, obj);
    // A boss linked to the TV follows its combatant's HP.
    const diff = obj.hp - (now ? now.hp : obj.hp);
    if (diff && linkedBoss(st, obj)) SCENE_GM[diff > 0 ? 'boss.heal' : 'boss.damage'](st, { amount: Math.abs(diff) }, ctx, out);
  }
  if (init) c.init = normalizeInit(init, c.combatants.map((x) => x.uid));
  if (crawler) {
    const p = st.players.find((y) => y.id === crawler.playerId);
    if (p) {
      const back = crawler.hp - (crawler.after ?? crawler.hp); // relative: later heals / hits stay
      if (back) setTrack(st, p, { track: crawler.track, delta: back }, ctx, out);
      p.sheet.buffs = crawler.buffs;
    }
  }
  out.emit({ kind: 'combat.undo', label: e.label }, { roles: ['gm'] });
  out.result = { undone: e.label, left: c.manualUndo.length };
};
