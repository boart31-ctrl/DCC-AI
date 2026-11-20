import { bad, notFound } from './errors.js';
import { learnPracticedSkill, libraryOf, rankUpEntries, rollSkillRankUp } from './character.js';
import { floorOfState } from './outcome.js';

const MINUTE = 60_000;
const HISTORY = 10;
const millis = (n) => Number.isSafeInteger(n) && n >= 0 ? n : 0;

export function normalizeAdvancementClock(raw) {
  return { elapsed: millis(raw?.elapsed), started: Number.isSafeInteger(raw?.started) && raw.started >= 0 ? raw.started : null,
    milestone: millis(raw?.milestone), snoozed: millis(raw?.snoozed) };
}

export function advancementClockView(session, ruleset, now) {
  const interval = ruleset.advancement?.intervalMinutes;
  if (!interval) return null;
  const c = normalizeAdvancementClock(session.advancementClock);
  const elapsed = c.elapsed + (c.started == null ? 0 : Math.max(0, now - c.started));
  const next = c.milestone + interval * MINUTE;
  const dueAt = Math.max(next, c.snoozed);
  return { elapsed, sinceLevel: Math.max(0, elapsed - c.milestone), interval, next, dueAt, asOf: now,
    running: c.started != null, due: elapsed >= dueAt };
}

export function changeAdvancementClock(st, a, ctx) {
  const view = advancementClockView(st.session, ctx.pack.ruleset, ctx.now);
  if (!view) throw bad('this game has no play timer');
  const c = st.session.advancementClock ??= normalizeAdvancementClock();
  if (a.op === 'start') c.started ??= ctx.now;
  else if (a.op === 'pause') { c.elapsed = view.elapsed; c.started = null; }
  else if (a.op === 'reset') st.session.advancementClock = normalizeAdvancementClock();
  else throw bad('choose start, pause or reset');
}

export function snoozeAdvancementClock(session, rs, now, minutes) {
  const clock = advancementClockView(session, rs, now);
  if (!clock) return false;
  const c = session.advancementClock ??= normalizeAdvancementClock();
  c.snoozed = clock.elapsed + minutes * MINUTE;
  return true;
}

export function consumeAdvancementMilestone(session, rs, now, checkpoint) {
  const view = advancementClockView(session, rs, now);
  if (!view || checkpoint !== view.next) throw bad('the play milestone changed; review the clock');
  if (!view.due) throw bad('the next play milestone has not been reached');
  const c = session.advancementClock ??= normalizeAdvancementClock();
  c.milestone += view.interval * MINUTE;
  c.snoozed = 0;
}

const validGrant = (g) => g && typeof g.id === 'string' && typeof g.from === 'number' && typeof g.to === 'number'
  && Array.isArray(g.ranks) && g.ranks.every((r) => r && typeof r.uid === 'string')
  && Array.isArray(g.practice) && g.practice.every((s) => s && typeof s.id === 'string');
const active = (g) => g.ranks.some((r) => !r.result) || (!g.learned && g.practice.length > 0);

export function normalizeLevelGrants(raw) {
  const grants = Array.isArray(raw) ? raw.filter(validGrant) : [];
  const history = new Set(grants.filter((g) => !active(g)).slice(-HISTORY));
  return grants.filter((g) => active(g) || history.has(g));
}

export function recordLevelGrant(st, p, from, ctx, prepare) {
  const rs = ctx.pack.ruleset;
  if (!rs.advancement) return;
  const lib = libraryOf(st, ctx.pack);
  const floor = floorOfState(st);
  const rule = rs.skills.rankUp;
  const ranks = prepare && rule ? rankUpEntries(p, rs, lib)
    .filter(({ s, max }) => s.used && s.rank < max && (rule.sessionMaxRank == null || s.rank <= rule.sessionMaxRank)) : [];
  const practiceAllowed = prepare && rs.skills.untrained?.learn && (!rs.skills.untrained.learnMaxFloor || floor <= rs.skills.untrained.learnMaxFloor);
  const practice = practiceAllowed ? (p.sheet.untried ?? []).filter((id) => !p.sheet.skills.some((s) => s.skillId === id))
    .flatMap((id) => { const s = lib.get('skill', id); return s ? [{ id, name: s.name }] : []; }) : [];
  if (practiceAllowed) p.sheet.untried = [];
  for (const { s } of ranks) s.used = false;
  p.levelGrants = normalizeLevelGrants([...(p.levelGrants ?? []), { id: ctx.genId('lvl'), at: ctx.now, floor, from, to: p.level,
    ranks: ranks.map(({ s, name }) => ({ uid: s.uid, name, rank: s.rank })), practice }]);
}

function findGrant(st, a, ctx) {
  const p = st.players.find((x) => x.id === ctx.actor.playerId);
  const grant = p?.levelGrants?.find((g) => g.id === a.id);
  if (!grant) throw notFound('that level-up is not on your sheet');
  return { p, grant };
}

export const ADVANCEMENT_PLAYER = {
  'level.advance'(st, a, ctx, out) {
    const { p, grant } = findGrant(st, a, ctx);
    const row = grant.ranks.find((r) => r.uid === a.uid);
    if (!row) throw notFound('that skill is not marked for this level-up');
    if (row.result) { out.result = row.result; out.changed = false; return; }
    const rs = ctx.pack.ruleset;
    const rule = rs.skills.rankUp;
    if (!rule) throw bad('this game has no skill advancement roll');
    if (a.entered !== undefined && (rule.roll.toLowerCase() !== 'd20' && rule.roll.toLowerCase() !== '1d20'
      || !Number.isInteger(a.entered) || a.entered < 1 || a.entered > 20)) throw bad('choose a d20 face from 1 to 20');
    const entry = rankUpEntries(p, rs, libraryOf(st, ctx.pack)).find(({ s }) => s.uid === row.uid);
    if (entry && rule.sessionMaxRank != null && entry.s.rank > rule.sessionMaxRank) {
      entry.s.used = true;
      row.result = { skipped: 'This rank advances at the end of the floor.' };
    } else if (!entry || entry.s.rank >= entry.max) row.result = { skipped: 'This skill is no longer eligible.' };
    else row.result = rollSkillRankUp(st, p, entry, ctx, out, { entered: a.entered, clearUsed: false });
    out.result = row.result;
  },
  'level.learn'(st, a, ctx, out) {
    const { p, grant } = findGrant(st, a, ctx);
    if (grant.learned) { out.result = grant.learned; out.changed = false; return; }
    if (!grant.practice.some((s) => s.id === a.skillId)) throw notFound('choose one skill practiced before this level-up');
    const name = learnPracticedSkill(st, p, a.skillId, ctx, out);
    p.sheet.untried = (p.sheet.untried ?? []).filter((id) => id !== a.skillId);
    grant.learned = { id: a.skillId, name };
    out.result = grant.learned;
  },
};
