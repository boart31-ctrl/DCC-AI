// Reaction rounds: combat for games where the GM never rolls a d20 (the crawler family). Pure + browser-safe.
//
// One round in five steps:
//   declare   the GM announces every mob's attack and target (or "Suggest": the book's rule of thumb)
//   react     crawlers spend actions on interrupts: Evade · Intervene · Catcher · Heal · Taunt
//   resolve   every crawler who evades rolls once per attack aimed at them; attacks that land deal damage
//             (rolled by the GM side, DR applied), with the degree of the Evade roll deciding extras
//   act       crawlers spend what is left (attacks go through the normal sheet rolls)
//   cleanup   end of round; then a new round starts at declare
// Each crawler has 2 actions a round (interrupts come out of the same 2). AI Favor can buy one more
// non-attack action once per round (the GM grants it).
//
// state.combat.rx = { combatId, round, step, decls: [Decl], acts: { uid: left }, evading: [uid], favor: [uid],
//                     intervene: [uid], log: [text] }
//   Decl = { id, mobUid, attack: { name, damage, dc }, targetUid, caught, taunted, evade: null | { die, total,
//            degree }, result: null | 'evaded' | 'half' | 'hit', damage: null | number }
//
// Difficulty of an Evade check = outcome.js mobAttackDc: the attack's `dc` when the content has one, else
// mob base (10 by default) + to-hit bonus, + the world's floor when the ruleset is floor-scaled.
import { bad, notFound } from './errors.js';
import { rollDice } from './formula.js';
import { computeFor, libraryOf } from './character.js';
import { sheetResolver } from './ruleset.js';
import { evaluate } from './formula.js';
import { COMBAT_GM, defenseOf, hpTrackOf } from './combat.js';
import { combatRules, mobAttackDc, floorOfState } from './outcome.js';

export const STEPS = ['declare', 'react', 'resolve', 'act', 'cleanup'];
export const ACTIONS_PER_ROUND = 2;
export const INTERRUPTS = ['evade', 'intervene', 'catcher', 'heal', 'taunt'];
export const MAX_DECLS = 80;
const MAX_LOG = 40;

/** Seven degrees: crit / amazing / success / near (miss by 1–2) / fail / major (miss by 10+) / critfail. */
export function degreeOf(die, total, difficulty) {
  if (die === 20) return 'crit';
  if (die === 1) return 'critfail';
  const m = total - difficulty;
  if (m >= 10) return 'amazing';
  if (m >= 0) return 'success';
  if (m >= -2) return 'near';
  if (m > -10) return 'fail';
  return 'major';
}
export const DEGREE_LABEL = { crit: 'Critical!', amazing: 'Amazing success', success: 'Success', near: 'Near miss', fail: 'Fail', major: 'Major fail', critfail: 'Critical fail' };
export const isSuccess = (d) => d === 'crit' || d === 'amazing' || d === 'success';

const C = (st) => st.combat;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function rxOf(st) {
  const c = C(st);
  if (!c?.active) throw bad('no fight running');
  if (!isObj(c.rx) || c.rx.combatId !== c.id) {
    c.rx = { combatId: c.id, round: c.round || 1, step: 'declare', decls: [], acts: {}, evading: [], favor: [], intervene: [], log: [] };
    resetActs(st);
  }
  return c.rx;
}
function crawlers(st) {
  return C(st).combatants.filter((x) => x.type === 'crawler');
}
function resetActs(st) {
  const rx = C(st).rx;
  rx.acts = Object.fromEntries(crawlers(st).map((x) => [x.uid, ACTIONS_PER_ROUND]));
  rx.evading = [];
  rx.favor = [];
  rx.intervene = [];
}
function log(rx, text) {
  rx.log.push(text);
  if (rx.log.length > MAX_LOG) rx.log.splice(0, rx.log.length - MAX_LOG);
}
function mobOf(st, uid) {
  const m = C(st).combatants.find((x) => x.uid === uid && x.type === 'mob');
  if (!m) throw notFound(`no mob ${uid}`);
  return m;
}
function crawlerOf(st, uid) {
  const x = C(st).combatants.find((y) => y.uid === uid && y.type === 'crawler');
  if (!x) throw notFound(`no crawler ${uid}`);
  return x;
}
function declOf(rx, id) {
  const d = rx.decls.find((x) => x.id === id);
  if (!d) throw notFound(`no declared attack ${id}`);
  return d;
}
const nameOf = (st, x) => (x.type === 'mob' ? x.name : st.players.find((p) => p.id === x.playerId)?.name ?? '?');

/** Difficulty of evading this attack (see header; floor-scaled rulesets add the current floor). */
export function attackDc(attack, rules = { mobBase: 0, floorScaled: false }, floor = 1) {
  return mobAttackDc(rules, attack, floor);
}

function spend(rx, uid, n = 1) {
  const left = rx.acts[uid] ?? ACTIONS_PER_ROUND;
  if (left < n) throw bad('no actions left this round');
  rx.acts[uid] = left - n;
}

function crawlerEvade(st, ctx, x) {
  const p = st.players.find((y) => y.id === x.playerId);
  try {
    const d = defenseOf(ctx.pack, computeFor(p, ctx.pack, libraryOf(st, ctx.pack)).computed);
    return d.evade + (combatRules(ctx.pack, C(st).settings).evadeBase || 0);
  } catch { return 0; }
}

function addDecl(st, ctx, rx, mob, attackIndex, targetUid) {
  if (rx.decls.length >= MAX_DECLS) throw bad(`max ${MAX_DECLS} declared attacks`);
  const atk = (mob.attacks ?? [])[attackIndex ?? 0];
  if (!atk) throw bad(`${mob.name} has no attack ${attackIndex ?? 0}`);
  const t = crawlerOf(st, targetUid);
  const d = { id: ctx.genId('dc'), mobUid: mob.uid, attack: { name: atk.name || 'Attack', damage: atk.damage || '1d4', dc: attackDc(atk, combatRules(ctx.pack, C(st).settings), floorOfState(st)), area: !!atk.area }, targetUid: t.uid, caught: false, taunted: false, evade: null, result: null, damage: null };
  rx.decls.push(d);
  return d;
}

/** The book's rule of thumb: elites and bosses act once per crawler, other mobs once, spread evenly. */
export function suggestDecls(st, ctx) {
  const c = C(st);
  const targets = crawlers(st).filter((x) => !x.dead && x.dying == null); // mobs go for crawlers still standing
  if (!targets.length) return [];
  const load = new Map(targets.map((t) => [t.uid, 0]));
  const out = [];
  const mobs = c.combatants.filter((x) => x.type === 'mob' && x.hp > 0 && !x.hidden && (x.attacks ?? []).length);
  const pickAttack = (m) => (m.attackMode === 'random' ? Math.floor(ctx.rng() * m.attacks.length) : 0);
  for (const m of mobs) {
    const big = m.sourceKind === 'boss' || m.role === 'elite' || m.role === 'boss';
    if (big) { for (const t of targets) { out.push({ mobUid: m.uid, attackIndex: pickAttack(m), targetUid: t.uid }); load.set(t.uid, load.get(t.uid) + 1); } continue; }
    let target;
    if (m.targetMode === 'focus' && load.has(m.focus)) target = m.focus;
    else {
      const min = Math.min(...load.values());
      const pool = targets.filter((t) => load.get(t.uid) === min);
      target = pool[Math.floor(ctx.rng() * pool.length)].uid;
    }
    load.set(target, load.get(target) + 1);
    out.push({ mobUid: m.uid, attackIndex: pickAttack(m), targetUid: target });
  }
  return out;
}

function resolveDecl(st, ctx, out, rx, d) {
  const mob = C(st).combatants.find((x) => x.uid === d.mobUid);
  const target = C(st).combatants.find((x) => x.uid === d.targetUid);
  if (!mob || !target) { d.result = 'evaded'; return; }
  const deg = d.evade?.degree ?? null;
  let mult = 1;
  let bonus = 0;
  if (deg && isSuccess(deg)) {
    if (!d.attack.area) { d.result = 'evaded'; d.damage = 0; log(rx, `${nameOf(st, target)} evades ${mob.name}'s ${d.attack.name}.`); return; }
    mult = 0.5;
  }
  if (deg === 'major') bonus = floorOfState(st);
  if (deg === 'critfail') mult *= 2;
  let rolled = 0;
  try { rolled = rollDice(d.attack.damage, { randInt: ctx.randInt }).total; } catch { rolled = 1; }
  const amount = Math.max(0, Math.floor(rolled * mult) + bonus);
  d.result = mult === 0.5 ? 'half' : 'hit';
  d.damage = amount;
  log(rx, `${mob.name} hits ${nameOf(st, target)} with ${d.attack.name}: ${amount}${deg === 'major' ? ' (major fail: +floor)' : deg === 'critfail' ? ' (critical fail: double)' : ''}.`);
  if (amount > 0) {
    const sub = { ...out, result: undefined };
    const wasDying = target.type === 'crawler' && target.dying != null;
    COMBAT_GM['combat.damage'](st, { uid: target.uid, amount, dr: true }, ctx, sub);
    onCrawlerDamage(st, ctx, out, target, wasDying);
  }
}

export const REACTION_GM = {
  /** Start (or re-sync) reaction rounds for the running fight. */
  'rx.start'(st) {
    const rx = rxOf(st);
    rx.step = 'declare';
  },

  /** `{ mobUid, attackIndex?, targetUid }` → result `{ declId }` */
  'rx.declare'(st, a, ctx, out) {
    const rx = rxOf(st);
    if (rx.step !== 'declare') throw bad('attacks are declared in the declare step');
    const d = addDecl(st, ctx, rx, mobOf(st, a.mobUid), a.attackIndex, a.targetUid);
    out.result = { declId: d.id };
  },

  /** Change who a declared attack goes for: `{ declId, targetUid }` (declare step). */
  'rx.retarget'(st, a) {
    const rx = rxOf(st);
    if (rx.step !== 'declare') throw bad('targets change in the declare step');
    declOf(rx, a.declId).targetUid = crawlerOf(st, a.targetUid).uid;
  },

  /**
   * `{ declId, adv: 'adv' | 'dis' | null }` A mob attacks with Advantage (+5 to the Evade difficulty) or
   * Disadvantage (−5): high ground, cover, darkness, size. Only before the Evade rolls.
   */
  'rx.adv'(st, a) {
    const rx = rxOf(st);
    if (!['declare', 'react'].includes(rx.step)) throw bad('change it before the hits land');
    const d = declOf(rx, a.declId);
    if (d.evade) throw bad('already evaded');
    if (![null, 'adv', 'dis'].includes(a.adv ?? null)) throw bad('adv must be adv, dis or null');
    d.attack.baseDc ??= d.attack.dc;
    d.adv = a.adv ?? null;
    d.attack.dc = d.attack.baseDc + (d.adv === 'adv' ? 5 : d.adv === 'dis' ? -5 : 0);
  },

  'rx.undeclare'(st, a) {
    const rx = rxOf(st);
    declOf(rx, a.declId);
    rx.decls = rx.decls.filter((x) => x.id !== a.declId);
  },

  /** Replace the declarations with the rule-of-thumb split. */
  'rx.suggest'(st, a, ctx, out) {
    const rx = rxOf(st);
    if (rx.step !== 'declare') throw bad('attacks are declared in the declare step');
    rx.decls = [];
    for (const s of suggestDecls(st, ctx)) addDecl(st, ctx, rx, mobOf(st, s.mobUid), s.attackIndex, s.targetUid);
    out.result = { count: rx.decls.length };
  },

  /** `{ to }` one of STEPS. Moving to resolve resolves every declared attack (missing Evade rolls: `force`). */
  'rx.step'(st, a, ctx, out) {
    const rx = rxOf(st);
    if (!STEPS.includes(a.to)) throw bad(`to must be one of ${STEPS.join(', ')}`);
    if (a.to === 'resolve' && rx.step !== 'resolve') {
      const missing = rx.decls.filter((d) => rx.evading.includes(d.targetUid) && !d.caught && !d.evade);
      if (missing.length && a.force !== true) {
        out.result = { waiting: missing.map((d) => d.id) };
        throw bad(`${missing.length} Evade roll${missing.length === 1 ? '' : 's'} missing`);
      }
      rx.step = 'resolve';
      for (const d of rx.decls) if (!d.result) resolveDecl(st, ctx, out, rx, d);
      out.emit({ kind: 'rx.resolved', round: rx.round }, 'all');
      return;
    }
    rx.step = a.to;
    if (a.to === 'react') out.emit({ kind: 'rx.react', round: rx.round, targets: [...new Set(rx.decls.map((d) => d.targetUid))] }, 'all');
  },

  /** Clean up and start the next round at declare. */
  'rx.round'(st, a, ctx, out) {
    const rx = rxOf(st);
    dyingTick(st, ctx, out, 'cleanup');
    rx.round += 1;
    C(st).round = rx.round;
    rx.step = 'declare';
    rx.decls = [];
    resetActs(st);
    // Timed mob conditions count down (crawler buffs count down through the sheet's own round tick).
    for (const m of C(st).combatants) if (m.type === 'mob') m.conditions = (m.conditions ?? []).map((k) => (k.rounds ? { ...k, rounds: k.rounds - 1 } : k)).filter((k) => k.rounds !== 0);
    out.emit({ kind: 'rx.round', round: rx.round }, 'all');
  },

  /** GM enters an Evade roll for a crawler (physical dice at the table): `{ declId, die }`. */
  'rx.evade'(st, a, ctx, out) { evadeRoll(st, ctx, out, a, null); },

  /** `{ uid, delta }` actions (AI Favor, a debuff, a house rule). */
  'rx.actions'(st, a) {
    const rx = rxOf(st);
    crawlerOf(st, a.uid);
    if (!Number.isInteger(a.delta) || Math.abs(a.delta) > 3) throw bad('delta must be an integer -3..3');
    rx.acts[a.uid] = Math.max(0, Math.min(5, (rx.acts[a.uid] ?? ACTIONS_PER_ROUND) + a.delta));
  },
};

/** Health of a crawler combatant (the sheet's hp track): { cur, max } or null. */
function crawlerHealth(st, ctx, x) {
  const p = st.players.find((y) => y.id === x.playerId);
  const t = hpTrackOf(ctx.pack);
  if (!p || !t) return null;
  const v = p.sheet?.tracks?.[t.id];
  return v ? { p, cur: Number(v.cur ?? v.value ?? 0), max: Number(v.max ?? 0) } : null;
}
/**
 * Dying (ruleset combat.dyingRounds): a crawler at 0 health starts with that many rounds; every clean up (and
 * every hit while dying, `why: 'hit'`) takes one; at 0 the crawler dies. Back above 0 = not dying.
 */
export function dyingTick(st, ctx, out, why, onlyUid = null) {
  const f = ctx.pack.ruleset.combat?.dyingRounds;
  if (!f || !C(st)?.active) return;
  for (const x of C(st).combatants) {
    if (x.type !== 'crawler' || x.dead || (onlyUid && x.uid !== onlyUid)) continue;
    const hp = crawlerHealth(st, ctx, x);
    if (!hp) continue;
    if (hp.cur > 0) { if (x.dying != null) { delete x.dying; out.emit({ kind: 'dying.saved', playerId: x.playerId, name: hp.p.name }, 'all'); } continue; }
    if (x.dying == null) {
      let n = 1;
      try { const { ch, computed } = computeFor(hp.p, ctx.pack, libraryOf(st, ctx.pack)); n = Math.max(1, Math.round(evaluate(f, sheetResolver(computed, ch, ctx.pack.ruleset)).value)); } catch {}
      x.dying = n;
      out.emit({ kind: 'dying', playerId: x.playerId, name: hp.p.name, rounds: n }, 'all');
      continue; // the countdown starts at the next clean up / hit
    }
    x.dying -= 1;
    if (x.dying <= 0) {
      x.dying = 0;
      x.dead = true;
      out.emit({ kind: 'dying.dead', playerId: x.playerId, name: hp.p.name }, 'all');
      log(rxOf(st), `${hp.p.name} died.`);
    } else out.emit({ kind: 'dying', playerId: x.playerId, name: hp.p.name, rounds: x.dying }, 'all');
  }
}

/** After damage to a crawler: a dying one loses a round (dies at 0); one that just hit 0 starts dying. */
export function onCrawlerDamage(st, ctx, out, x, wasDying) {
  if (!ctx.pack.ruleset.combat?.dyingRounds || x?.type !== 'crawler' || x.dead) return;
  if (wasDying && x.dying != null) {
    x.dying -= 1;
    const name = st.players.find((p) => p.id === x.playerId)?.name;
    if (x.dying <= 0) { x.dying = 0; x.dead = true; out.emit({ kind: 'dying.dead', playerId: x.playerId, name }, 'all'); } else out.emit({ kind: 'dying', playerId: x.playerId, name, rounds: x.dying }, 'all');
  } else dyingTick(st, ctx, out, 'hit', x.uid);
}

function evadeRoll(st, ctx, out, a, playerId) {
  const rx = rxOf(st);
  const d = declOf(rx, a.declId);
  const x = crawlerOf(st, d.targetUid);
  if (playerId && x.playerId !== playerId) throw bad('that attack is not aimed at you');
  if (d.caught) throw bad('a caught attack cannot be evaded');
  if (!rx.evading.includes(x.uid)) throw bad('spend an action on Evade first');
  if (d.result) throw bad('already resolved');
  if (!Number.isInteger(a.die) || a.die < 1 || a.die > 20) throw bad('die must be 1..20');
  const total = a.die + crawlerEvade(st, ctx, x);
  const degree = degreeOf(a.die, total, d.attack.dc);
  d.evade = { die: a.die, total, degree };
  out.result = { degree, label: DEGREE_LABEL[degree], near: degree === 'near' };
  out.emit({ kind: 'rx.evade', declId: d.id, uid: x.uid, degree, near: degree === 'near' }, 'all');
}

export const REACTION_PLAYER = {
  /** `{ kind, declId?, die? }` — spends one action. Catcher / Taunt name the attack they take over. */
  'rx.interrupt'(st, a, ctx, out) {
    const rx = rxOf(st);
    const me = crawlers(st).find((x) => x.playerId === ctx.actor.playerId);
    if (!me) throw bad('you are not in this fight');
    if (!INTERRUPTS.includes(a.kind)) throw bad(`kind must be one of ${INTERRUPTS.join(', ')}`);
    const inReact = rx.step === 'react';
    if (!inReact && !(rx.step === 'act' && (a.kind === 'heal' || a.kind === 'intervene'))) throw bad('interrupts are for the reaction step');
    if (a.kind === 'evade') {
      if (rx.evading.includes(me.uid)) throw bad('already evading this round');
      spend(rx, me.uid);
      rx.evading.push(me.uid);
    } else if (a.kind === 'catcher') {
      const d = declOf(rx, a.declId);
      if (d.targetUid === me.uid) throw bad('that attack is already aimed at you');
      spend(rx, me.uid);
      d.targetUid = me.uid;
      d.caught = true;
    } else if (a.kind === 'taunt') {
      const d = declOf(rx, a.declId);
      if (!Number.isInteger(a.total)) throw bad('total (your Taunt check) required');
      const mob = mobOf(st, d.mobUid);
      const dc = 10 + (Number(mob.stats?.int?.mod) || 2) + (floorOfState(st));
      spend(rx, me.uid);
      const ok = a.total >= dc;
      if (ok) { d.targetUid = me.uid; d.taunted = true; }
      out.result = { ok };
    } else {
      spend(rx, me.uid);
      if (a.kind === 'intervene') rx.intervene.push(me.uid);
    }
    log(rx, `${nameOf(st, me)}: ${a.kind}.`);
    out.emit({ kind: 'rx.interrupt', uid: me.uid, what: a.kind }, 'all');
  },

  /** `{ declId, die }` — my Evade roll against one attack. */
  'rx.evade'(st, a, ctx, out) { evadeRoll(st, ctx, out, a, ctx.actor.playerId); },

  /** Intervene: `{ declId, d6 }` adds 1d6 to an ally's Evade roll (most useful on a Near miss). */
  'rx.intervene'(st, a, ctx, out) {
    const rx = rxOf(st);
    const me = crawlers(st).find((x) => x.playerId === ctx.actor.playerId);
    if (!me || !rx.intervene.includes(me.uid)) throw bad('spend an action on Intervene first');
    const d = declOf(rx, a.declId);
    if (!d.evade || d.result) throw bad('no open Evade roll there');
    if (d.targetUid === me.uid) throw bad('Intervene helps someone else');
    if (!Number.isInteger(a.d6) || a.d6 < 1 || a.d6 > 6) throw bad('d6 must be 1..6');
    rx.intervene.splice(rx.intervene.indexOf(me.uid), 1);
    d.evade.total += a.d6;
    d.evade.degree = degreeOf(d.evade.die, d.evade.total, d.attack.dc);
    d.evade.helped = (d.evade.helped ?? 0) + a.d6;
    out.result = { degree: d.evade.degree, label: DEGREE_LABEL[d.evade.degree] };
    out.emit({ kind: 'rx.evade', declId: d.id, uid: d.targetUid, degree: d.evade.degree, helped: true }, 'all');
  },

  /** Spend an action in the act step (an attack through the sheet, a move, an item): `{ n? }`. */
  'rx.spend'(st, a, ctx) {
    const rx = rxOf(st);
    const me = crawlers(st).find((x) => x.playerId === ctx.actor.playerId);
    if (!me) throw bad('you are not in this fight');
    if (rx.step !== 'act' && rx.step !== 'react') throw bad('not now');
    spend(rx, me.uid, a.n === 2 ? 2 : 1);
  },
};

/** Role-filtered view of the round: players never see difficulties or hidden mobs' plans. */
export function reactionView(state, role) {
  const c = state.combat;
  if (!c?.active || !isObj(c.rx) || c.rx.combatId !== c.id) return null;
  const rx = c.rx;
  const gm = role === 'gm';
  const mobs = new Map(c.combatants.filter((x) => x.type === 'mob').map((x) => [x.uid, x]));
  const decls = rx.decls.filter((d) => gm || !mobs.get(d.mobUid)?.hidden).map((d) => {
    const m = mobs.get(d.mobUid);
    const base = { id: d.id, mobUid: d.mobUid, mob: m?.name ?? '?', attack: d.attack.name, area: d.attack.area, adv: d.adv ?? null, targetUid: d.targetUid, caught: d.caught, taunted: d.taunted, result: d.result, damage: d.damage, evade: d.evade ? { degree: d.evade.degree, label: DEGREE_LABEL[d.evade.degree], die: d.evade.die, helped: d.evade.helped ?? 0 } : null };
    return gm ? { ...base, dc: d.attack.dc, damageDice: d.attack.damage, evadeTotal: d.evade?.total ?? null } : base;
  });
  return { round: rx.round, step: rx.step, steps: STEPS, decls, acts: rx.acts, evading: rx.evading, intervene: rx.intervene, log: gm ? rx.log.slice(-12) : rx.log.slice(-5) };
}
