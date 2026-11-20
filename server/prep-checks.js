// Private scene checks never enter the shared roll log, feed or events.
import { bad, forbidden, notFound } from './errors.js';
import { computeFor, libraryOf, markUntrainedSkill } from './character.js';
import { checkDC, checkFamily } from '../web/js/check-dc.js';
import { statCheckBonus } from '../web/js/rules.js';
import { attackOutcome, degree7, floorOfState } from './outcome.js';
import { evaluate } from './formula.js';
import { sheetResolver } from './ruleset.js';
import { getPrepScene } from './prep.js';

const MAX_CHECKS = 40;
const id = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function normalizePrepChecks(raw) {
  return Array.isArray(raw) ? raw.filter((q) => obj(q) && id(q.id) && id(q.docId) && id(q.sceneId) && id(q.checkId)
    && obj(q.check) && typeof q.label === 'string' && typeof q.ability === 'string' && Number.isInteger(q.dc)
    && Array.isArray(q.recipients) && q.recipients.every((r) => obj(r) && id(r.playerId))).slice(-MAX_CHECKS) : [];
}

function checkAbility(rs, lib, check) {
  if (check.skillId) {
    const skill = lib.get('skill', check.skillId);
    if (!skill) throw notFound('that skill is no longer in the library');
    if (skill.checkType.toLowerCase() === 'passive') throw bad('this skill does not use a check');
    return skill;
  }
  const stat = rs.stats.find((s) => s.id === check.statId);
  if (!stat) throw bad('choose a skill or stat first');
  return stat;
}

function checkModifier(p, st, pack, check) {
  const rs = pack.ruleset;
  const lib = libraryOf(st, pack);
  const ability = checkAbility(rs, lib, check);
  const { ch, computed } = computeFor(p, pack, lib);
  const statModifier = (id) => statCheckBonus(computed, id).value;
  if (!check.skillId) return { modifier: statModifier(ability.id) };
  const skill = ch.skills.find((s) => s.skillId === ability.id);
  if (skill) return { modifier: computed.skills.find((s) => s.uid === skill.uid).total.value, skillUid: skill.uid };
  const untrained = rs.skills.untrained;
  const stat = ability.stat;
  if (!untrained) return { modifier: statModifier(stat) };
  if (untrained.noCheckTypes.includes(ability.checkType)) throw bad(`${p.name} cannot attempt this skill untrained`);
  const expression = String(untrained.formula || 'mod.{stat}').replaceAll('{stat}', stat);
  return { modifier: evaluate(expression, sheetResolver(computed, ch, rs)).value, advantage: untrained.adv, untrained: true };
}

function resultDegree({ family, degreeScale }, die, total, dc) {
  if (degreeScale === 'seven') return degree7(die, total, dc);
  if (family === 'pf2e') {
    const { degree } = attackOutcome({ degrees: true }, { d20: die, total, target: dc });
    return ['critfail', 'fail', 'success', 'crit'][degree];
  }
  return total >= dc ? 'success' : 'fail';
}

export function prepChecksFor(st, playerId) {
  return (st.prepChecks ?? []).filter((q) => q.sessionId === st.session.id).flatMap((q) => {
    const recipient = q.recipients.find((r) => r.playerId === playerId);
    if (!recipient || recipient.result || q.closed) return [];
    return [{ id: q.id, label: q.label, ability: q.ability, ...(recipient.advantage ? { advantage: recipient.advantage } : {}) }];
  });
}

export const PREP_CHECKS_GM = {
  'prep.check.send'(st, a, ctx, out) {
    if (!id(a.docId) || !id(a.sceneId) || !id(a.checkId)) throw bad('choose a scene check');
    if (a.requestId !== undefined && !id(a.requestId)) throw bad('invalid request id');
    const checks = st.prepChecks ??= [];
    const replay = a.requestId && checks.find((q) => q.sessionId === st.session.id && q.requestId === a.requestId);
    if (replay) { out.changed = false; out.result = { id: replay.id }; return; }
    const scene = getPrepScene(st, a.docId, a.sceneId);
    const check = scene?.checks?.find((c) => c.id === a.checkId);
    if (!check) throw notFound('scene check no longer exists');
    if (!Array.isArray(a.playerIds) || !a.playerIds.length || a.playerIds.length > st.players.length
      || new Set(a.playerIds).size !== a.playerIds.length) throw bad('choose one or more crawlers');
    const rs = ctx.pack.ruleset;
    const floor = floorOfState(st);
    const dc = checkDC(check, rs, { floor });
    if (!Number.isInteger(dc) || dc < -1000 || dc > 1000) throw bad('set a valid DC first');
    const definition = checkAbility(rs, libraryOf(st, ctx.pack), check);
    const recipients = a.playerIds.map((playerId) => {
      const p = st.players.find((p) => p.id === playerId);
      if (!p) throw notFound('that crawler left the room');
      return { playerId, ...checkModifier(p, st, ctx.pack, check) };
    });
    const q = { id: ctx.genId('pcq'), sessionId: st.session.id, docId: a.docId, sceneId: a.sceneId, checkId: a.checkId,
      requestId: a.requestId, label: check.label, ability: definition.name ?? definition.label, check: { ...check }, dc,
      family: checkFamily(rs), degreeScale: rs.combat.degreeScale, floor, at: ctx.now, recipients };
    checks.push(q);
    st.prepChecks = checks.slice(-MAX_CHECKS);
    out.result = { id: q.id };
  },

  'prep.check.close'(st, a) {
    const q = (st.prepChecks ?? []).find((q) => q.id === a.id && q.sessionId === st.session.id);
    if (!q) throw notFound('scene check request no longer exists');
    q.closed = true;
  },
};

export const PREP_CHECKS_PLAYER = {
  'prep.check.reply'(st, a, ctx, out) {
    const q = (st.prepChecks ?? []).find((q) => q.id === a.id && q.sessionId === st.session.id);
    const recipient = q?.recipients.find((r) => r.playerId === ctx.actor.playerId);
    if (!recipient) throw forbidden('this check is not assigned to you');
    out.result = { received: true };
    if (recipient.result) { out.changed = false; return; }
    if (q.closed) throw bad('the GM closed this check');
    const rand = ctx.dieInt ?? ctx.rollInt ?? ctx.randInt;
    let die = a.entered;
    if (die === undefined) {
      die = rand(20) + 1;
      if (recipient.advantage === 'adv') die = Math.max(die, rand(20) + 1);
      if (recipient.advantage === 'dis') die = Math.min(die, rand(20) + 1);
    } else if (!Number.isInteger(die) || die < 1 || die > 20) throw bad('choose a d20 face from 1 to 20');
    const total = die + recipient.modifier;
    recipient.result = { die, total, degree: resultDegree(q, die, total, q.dc), at: ctx.now };
    if (q.check.skillId) {
      const player = st.players.find((p) => p.id === recipient.playerId);
      const skills = ctx.pack.ruleset.skills;
      const skill = player?.sheet.skills.find((s) => s.uid === recipient.skillUid);
      if (skill && skills.usedTracking) skill.used = true;
      if (player && recipient.untrained) markUntrainedSkill(player, skills.untrained, q.floor ?? floorOfState(st), q.check.skillId);
    }
  },
};
