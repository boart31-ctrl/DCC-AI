// Grinding montage + level hints.
//
// Grinding (ruleset `grinding`, all numbers from the pack): the party spends N hours killing easy mobs. Per crawler:
//   earned = hours − unproductive overtime hours (+ map bonus when hours ≥ bonusMinHours)
//   overtime = hours past `safeHours` on the same in-game day (day = floor clock elapsed / dayHours); each overtime
//   hour is an Endurance check (DC base + perFloor × floor) — digital, or the GM enters the number of fails.
//   Every fail adds the fatigue debuff once (the engine keeps one instance; stacks are noted in the result).
//   Hours go to the skills the GM picked, in order: a skill needs hours = its rank, then rolls advancement at once.
//   A skill can take grinding hours once per in-game day; hours left over move to the next skill, never bank twice.
//   Level: running total of grinding hours; total ≥ current level → +1 level (lowest-level crawler alone: +1d`lowestBonusDie`),
//   total erased.
// The floor clock advances by `hours` once. Optional complication: one roll on the pack table.
//
// Level hints (ruleset `levels`): at combat end, a dead boss suggests `levels.boss[rank]` levels for every crawler in
// the fight, a dead rival crawler (library tag `crawler`) suggests d`die` ± level gap for its killer. Nothing is
// applied until the GM taps it (`level.hint.apply`) — David wants level-ups as reminders, not automatic.
import { bad, notFound } from './errors.js';
import { libraryOf, rankUpEntries, rollSkillRankUp, SHEET, SHEET_GM } from './character.js';
import { floorOfState } from './outcome.js';
import { rollTable } from './tables.js';
import { CRAWLERS_GM } from './crawlers.js';

const MAX_HINTS = 12;
const MAX_SKILLS = 10;

export function normalizeGrind(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const nat = (v) => (Number.isInteger(v) && v >= 0 && v <= 100_000 ? v : 0);
  const map = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {})
    .filter(([k, v]) => typeof k === 'string' && k.length <= 40 && Number.isInteger(v) && v >= 0).slice(0, 200));
  return {
    total: nat(r.total),
    skills: map(r.skills), // skill uid → banked hours
    days: map(r.days), // skill uid → last in-game day it was ground
    day: Number.isInteger(r.day) ? r.day : -1, // in-game day of `dayHours`
    dayHours: nat(r.dayHours), // hours ground on `day`
  };
}

const levelOf = (p) => Number(p.sheet?.identity?.level ?? p.level ?? 1) || 1;
function setLevel(p, n) {
  if (p.sheet) p.sheet.identity = { ...(p.sheet.identity ?? {}), level: n };
  p.level = n;
}

function dayIndex(st, cfg) {
  const s = st.crawlers?.clock?.elapsedSeconds ?? 0;
  return Math.floor(s / (cfg.dayHours * 3600));
}

/** One Endurance-type check, digital. Returns true on success. */
function enduranceRoll(st, p, cfg, ctx, out) {
  const rs = ctx.pack.ruleset;
  const lib = libraryOf(st, ctx.pack);
  const dc = cfg.dc.base + cfg.dc.perFloor * floorOfState(st);
  const own = cfg.skill ? p.sheet.skills.find((s) => s.skillId === cfg.skill && s.rank > 0) : null;
  const what = own ? { kind: 'skill', uid: own.uid }
    : cfg.skill && rs.skills?.untrained && lib.get('skill', cfg.skill) ? { kind: 'untrained', skillId: cfg.skill }
      : rs.stats.some((s) => s.id === 'con') ? { kind: 'stat', id: 'con' } : null;
  if (!what) return ctx.randInt(20) + 1 >= dc;
  const sub = { ...out, result: undefined };
  SHEET.roll(st, { what, playerId: p.id, dc, secret: true, card: false }, ctx, sub);
  return !!sub.result?.hit;
}

function grindCrawler(st, p, row, a, cfg, ctx, out, { day, lowest }) {
  const g = (p.grind = normalizeGrind(p.grind));
  if (g.day !== day) { g.day = day; g.dayHours = 0; }
  const hours = a.hours;
  const overtime = Math.min(hours, Math.max(0, g.dayHours + hours - cfg.safeHours));
  let fails;
  if (row.fails !== undefined) {
    if (!Number.isInteger(row.fails) || row.fails < 0 || row.fails > overtime) throw bad(`fails for ${p.name} must be 0..${overtime}`);
    fails = row.fails;
  } else {
    fails = 0;
    for (let i = 0; i < overtime; i++) if (!enduranceRoll(st, p, cfg, ctx, out)) fails++;
  }
  g.dayHours += hours;
  const bonus = hours >= cfg.bonusMinHours ? (cfg.mapBonus[a.map] ?? 0) : 0;
  const earned = Math.max(0, hours - fails) + bonus;
  let fatigued = false;
  if (fails > 0 && cfg.fatigue && libraryOf(st, ctx.pack).get('buff', cfg.fatigue)) {
    const sub = { ...out, result: null };
    SHEET_GM['buff.add'](st, { playerId: p.id, buffId: cfg.fatigue }, ctx, sub);
    fatigued = true;
  }
  // Skills, in the GM's order.
  const entries = rankUpEntries(p, ctx.pack.ruleset, libraryOf(st, ctx.pack));
  const skills = [];
  let pool = earned;
  for (const uid of row.skills ?? []) {
    const entry = entries.find((e) => e.s.uid === uid);
    if (!entry) throw notFound(`${p.name} has no skill ${uid}`);
    const rank = entry.s.rank ?? 0;
    const line = { uid, name: entry.name, rank };
    if (pool <= 0) { skills.push({ ...line, skipped: 'no hours left' }); continue; }
    if (rank < 1) { skills.push({ ...line, skipped: 'untrained' }); continue; }
    if (rank >= entry.max) { skills.push({ ...line, skipped: 'max rank' }); continue; }
    if (g.days[uid] === day) { skills.push({ ...line, skipped: 'already ground today' }); continue; }
    const have = g.skills[uid] ?? 0;
    const give = Math.min(pool, rank - have);
    pool -= give;
    g.days[uid] = day;
    if (have + give < rank) { g.skills[uid] = have + give; skills.push({ ...line, hours: give, banked: have + give, need: rank }); continue; }
    delete g.skills[uid];
    const r = ctx.pack.ruleset.skills?.rankUp ? rollSkillRankUp(st, p, entry, ctx, out, { clearUsed: false }) : null;
    skills.push({ ...line, hours: give, need: rank, ...(r ? { roll: r.roll, target: r.target, success: r.success, from: r.from, to: r.to } : {}) });
  }
  // Level.
  const from = levelOf(p);
  g.total += earned;
  let to = from;
  let bonusRoll = null;
  if (earned > 0 && g.total >= from) {
    const gain = lowest && cfg.lowestBonusDie > 1 ? (bonusRoll = ctx.randInt(cfg.lowestBonusDie) + 1) : 1;
    to = from + gain;
    setLevel(p, to);
    g.total = 0;
  }
  return { playerId: p.id, name: p.name, hours, overtime, fails, bonus, earned, fatigued, skills, leftover: pool,
    total: g.total, levelFrom: from, levelTo: to, ...(bonusRoll != null ? { bonusRoll } : {}) };
}

function pushHint(st, ctx, hint) {
  const list = (st.session.levelHints = Array.isArray(st.session.levelHints) ? st.session.levelHints : []);
  list.push({ id: ctx.genId('lh'), at: ctx.now, ...hint });
  if (list.length > MAX_HINTS) list.splice(0, list.length - MAX_HINTS);
}

export function normalizeLevelHints(raw) {
  return (Array.isArray(raw) ? raw : []).filter((h) => h && typeof h.id === 'string' && Number.isInteger(h.delta)
    && Array.isArray(h.playerIds)).slice(-MAX_HINTS);
}

/** Called from combat.end, before the fight state is reset. */
export function suggestKillLevels(st, ctx) {
  const rules = ctx.pack.ruleset.levels;
  if (!rules || !st.combat) return;
  const lib = libraryOf(st, ctx.pack);
  const party = [...new Set(st.combat.combatants.filter((x) => x.type === 'crawler' && x.playerId).map((x) => x.playerId))]
    .filter((id) => st.players.some((p) => p.id === id));
  for (const m of st.combat.combatants) {
    if (m.type !== 'mob' || m.hp > 0 || m.levelHinted) continue;
    const src = m.sourceKind && m.sourceId ? lib.get(m.sourceKind, m.sourceId) : null;
    const isBoss = m.sourceKind === 'boss' || m.role === 'boss';
    if (isBoss && party.length) {
      const rank = src?.rank ?? null;
      const delta = rank && Object.hasOwn(rules.boss, rank) ? rules.boss[rank] : null;
      if (delta) { pushHint(st, ctx, { kind: 'boss', delta, playerIds: party, victim: m.name, rank }); m.levelHinted = true; }
    }
    const tags = new Set([...(src?.tags ?? []), ...(m.tags ?? [])]);
    const killer = m.killedBy && st.players.find((p) => p.id === m.killedBy);
    if (rules.crawlerKill && killer && (tags.has('crawler') || tags.has('leaderboard'))) {
      const ck = rules.crawlerKill;
      const roll = ctx.randInt(ck.die) + 1;
      const victimLevel = Number.isInteger(m.level) ? m.level : Number.isInteger(src?.level) ? src.level : null;
      const gap = victimLevel == null ? 0 : victimLevel - levelOf(killer);
      const delta = gap > 0 ? Math.min(ck.max, roll + gap) : Math.max(ck.min, roll + gap);
      if (delta > 0) pushHint(st, ctx, { kind: 'crawlerKill', delta, playerIds: [killer.id], victim: m.name, roll, gap, victimLevel });
      m.levelHinted = true;
    }
  }
}

export const GRIND_GM = {
  /**
   * `{ hours, map?, complication?, tableId?, crawlers: [{ playerId, skills?: [uid…], fails? }] }`
   * Montage for the listed crawlers; see the file header.
   */
  'grind.run'(st, a, ctx, out) {
    const cfg = ctx.pack.ruleset.grinding;
    if (!cfg) throw bad('this game has no grinding rules');
    if (st.combat?.active) throw bad('finish combat before grinding');
    if (!Number.isInteger(a.hours) || a.hours < 1 || a.hours > cfg.maxHours) throw bad(`hours must be 1..${cfg.maxHours}`);
    if (a.map !== undefined && a.map !== null && a.map !== 'none' && !Object.hasOwn(cfg.mapBonus, a.map)) throw bad('unknown map bonus');
    if (!Array.isArray(a.crawlers) || !a.crawlers.length) throw bad('choose who grinds');
    const rows = a.crawlers.map((r) => {
      const p = st.players.find((x) => x.id === r?.playerId);
      if (!p) throw notFound(`no player ${r?.playerId}`);
      if (r.skills !== undefined && (!Array.isArray(r.skills) || r.skills.length > MAX_SKILLS || !r.skills.every((u) => typeof u === 'string'))) throw bad('skills must be a list of skill uids');
      return { p, r };
    });
    if (new Set(rows.map((x) => x.p.id)).size !== rows.length) throw bad('a crawler is listed twice');
    const clock = st.crawlers?.clock;
    if (clock?.hours != null && clock.hours < a.hours) throw bad('not enough time before the floor collapses');
    const day = dayIndex(st, cfg);
    // Lowest level among the whole party, before anyone levels; a tie means nobody is "the lowest".
    const levels = st.players.map(levelOf);
    const min = Math.min(...levels);
    const lowestId = levels.filter((l) => l === min).length === 1 ? st.players[levels.indexOf(min)].id : null;
    const crawlers = rows.map(({ p, r }) => grindCrawler(st, p, r, a, cfg, ctx, out, { day, lowest: p.id === lowestId }));
    let complication = null;
    const tableId = typeof a.tableId === 'string' ? a.tableId : cfg.complicationTable;
    if (a.complication !== false && tableId) {
      try { complication = rollTable(st, ctx, tableId); } catch { complication = null; }
    }
    const sub = { ...out, result: null };
    if (clock?.hours != null) CRAWLERS_GM['crawlers.clock'](st, { advance: a.hours }, ctx, sub);
    const ups = crawlers.filter((c) => c.levelTo > c.levelFrom);
    if (ups.length) out.emit({ kind: 'levelup', delta: Math.max(...ups.map((c) => c.levelTo - c.levelFrom)), names: ups.map((c) => c.name), reason: 'grind' }, 'all');
    const result = { id: ctx.genId('gr'), at: ctx.now, day, hours: a.hours, map: a.map ?? null, complication, crawlers };
    st.session.lastGrind = result;
    out.result = result;
  },

  /** `{ id }` Give the suggested levels. */
  'level.hint.apply'(st, a, ctx, out) {
    const list = normalizeLevelHints(st.session.levelHints);
    const h = list.find((x) => x.id === a.id);
    if (!h) throw notFound('that level hint is gone');
    const names = [];
    for (const id of h.playerIds) {
      const p = st.players.find((x) => x.id === id);
      if (!p) continue;
      setLevel(p, levelOf(p) + h.delta);
      names.push(p.name);
    }
    st.session.levelHints = list.filter((x) => x.id !== a.id);
    if (names.length) out.emit({ kind: 'levelup', delta: h.delta, names, reason: h.kind }, 'all');
    out.result = { names, delta: h.delta };
  },

  /** `{ id }` Drop a suggestion without giving it. */
  'level.hint.dismiss'(st, a) {
    st.session.levelHints = normalizeLevelHints(st.session.levelHints).filter((x) => x.id !== a.id);
  },
};

/** GM view part: what the grind form needs + pending level hints. */
export function grindView(st, pack) {
  const cfg = pack.ruleset.grinding;
  return {
    ...(cfg ? { grinding: { safeHours: cfg.safeHours, maxHours: cfg.maxHours, bonusMinHours: cfg.bonusMinHours, mapBonus: cfg.mapBonus,
      day: dayIndex(st, cfg), complicationTable: cfg.complicationTable, last: st.session.lastGrind ?? null,
      crawlers: Object.fromEntries(st.players.map((p) => { const g = normalizeGrind(p.grind); return [p.id, { total: g.total, skills: g.skills, days: g.days, day: g.day, dayHours: g.dayHours }]; })) } } : {}),
    levelHints: normalizeLevelHints(st.session.levelHints),
  };
}
