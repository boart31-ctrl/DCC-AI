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
// state.combat.rx = { combatId, round, step, decls: [Decl], acts: { uid: left }, nonAttackActions: { uid: left }, evading: [uid], favor: [uid],
//                     intervene: [uid], log: [text] }
//   Decl = { id, mobUid, attack: { name, damage, dc }, targetUid, caught, taunted, evade: null | { die, total,
//            degree }, result: null | 'evaded' | 'half' | 'hit', damage: null | number }
//
// Difficulty of an Evade check = outcome.js mobAttackDc: the attack's `dc` when the content has one, else
// mob base (10 by default) + to-hit bonus, + the world's floor when the ruleset is floor-scaled.
import { bad, notFound } from './errors.js';
import { rollDice } from './formula.js';
import { computeFor, libraryOf, nextInjuryDescription, SHEET, requireStatusAllowed, statusBlocker } from './character.js';
import { sheetResolver } from './ruleset.js';
import { evaluate } from './formula.js';
import { COMBAT_GM, defenseOf, hpTrackOf } from './combat.js';
import { combatRules, mobAttackDc, floorOfState, typedDamage } from './outcome.js';
import { advanceGameTime } from './crawlers.js';

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
const standing = (x) => !!x && !x.dead && x.dying == null;

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
const playerOfCrawler = (st, x) => st.players.find((p) => p.id === x?.playerId);
function resetActs(st) {
  const rx = C(st).rx;
  rx.acts = Object.fromEntries(crawlers(st).map((x) => [x.uid, ACTIONS_PER_ROUND]));
  rx.evading = [];
  rx.favor = [];
  rx.nonAttackActions = {};
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
function evadeOptions(rx, d, target, interruptBlocked = false) {
  const eligible = !d.caught && !d.result && standing(target);
  const freeEvade = eligible && (d.adv === 'dis' || d.tauntEvade === true) && !d.evade;
  const paid = eligible && !interruptBlocked && rx.evading.includes(d.targetUid);
  const canReroll = paid && d.evade?.free === true && !isSuccess(d.evade.degree);
  return { freeEvade, canEvade: freeEvade || (paid && !d.evade) || canReroll, canReroll };
}
const nameOf = (st, x) => (x.type === 'mob' ? x.name : st.players.find((p) => p.id === x.playerId)?.name ?? '?');

/** Difficulty of evading this attack (see header; floor-scaled rulesets add the current floor). */
export function attackDc(attack, rules = { mobBase: 0, floorScaled: false }, floor = 1) {
  return mobAttackDc(rules, attack, floor);
}

export function spendReactionAction(rx, uid, n = 1, { attack = false } = {}) {
  const left = rx.acts[uid] ?? ACTIONS_PER_ROUND;
  const extra = attack ? 0 : Math.min(n, rx.nonAttackActions?.[uid] ?? 0);
  if (left + extra < n) throw bad('no actions left this round');
  if (extra) rx.nonAttackActions[uid] -= extra;
  rx.acts[uid] = left + extra - n;
}

function buyFavorAction(st, ctx, out, x) {
  const rx = rxOf(st);
  if (!standing(x)) throw bad('that crawler cannot act');
  if (!['react', 'act'].includes(rx.step)) throw bad('not now');
  if (rx.favor?.includes(x.uid)) throw bad('already used AI Favor for an action this round');
  const fdef = ctx.pack.ruleset.fields.find((f) => f.id === 'aiFavor');
  if (!fdef) throw bad('this game has no AI Favor');
  const p = st.players.find((y) => y.id === x.playerId);
  if (!p) throw notFound('that crawler is no longer in the party');
  requireStatusAllowed(st, ctx, p, 'action');
  const favor = Number(p.sheet.fields?.aiFavor ?? fdef.default ?? 0);
  if (!(favor >= 1)) throw bad('no AI Favor left');
  p.sheet.fields = { ...(p.sheet.fields ?? {}), aiFavor: favor - 1 };
  (rx.favor ??= []).push(x.uid);
  (rx.nonAttackActions ??= {})[x.uid] = 1;
  out.result = { favor: favor - 1, nonAttackActions: 1 };
}

function crawlerEvade(st, ctx, x) {
  const p = st.players.find((y) => y.id === x.playerId);
  try {
    const d = defenseOf(ctx.pack, computeFor(p, ctx.pack, libraryOf(st, ctx.pack)).computed);
    return d.evade + (combatRules(ctx.pack, C(st).settings).evadeBase || 0);
  } catch { return 0; }
}

function declaredAttack(st, ctx, mob, index) {
  const atk = Number.isInteger(index) && mob.attacks?.[index];
  if (!atk) throw bad(`${mob.name} has no attack ${index}`);
  return {
    name: atk.name || 'Attack', damage: atk.damage || '0', dc: attackDc(atk, combatRules(ctx.pack, C(st).settings), mob.flat ? 0 : floorOfState(st)),
    area: !!atk.area, dtype: atk.dtype, effects: atk.effects, buffs: atk.buffs ?? [], majorFailBuffs: atk.majorFailBuffs ?? [],
  };
}

function addDecl(st, ctx, rx, mob, attackIndex = 0, targetUid) {
  if (rx.decls.length >= MAX_DECLS) throw bad(`max ${MAX_DECLS} declared attacks`);
  if (mob.hp <= 0) throw bad(`${mob.name} is down`);
  requireStatusAllowed(st, ctx, mob, 'action');
  const t = crawlerOf(st, targetUid);
  if (t.dead) throw bad('that crawler is already dead');
  const d = { id: ctx.genId('dc'), mobUid: mob.uid, attackIndex, attack: declaredAttack(st, ctx, mob, attackIndex), targetUid: t.uid, caught: false, taunted: false, evade: null, result: null, damage: null };
  rx.decls.push(d);
  return d;
}

/** The book's rule of thumb: elites and bosses act once per crawler, other mobs once, spread evenly. */
export function suggestDecls(st, ctx) {
  const c = C(st);
  const targets = crawlers(st).filter(standing);
  if (!targets.length) return [];
  const load = new Map(targets.map((t) => [t.uid, 0]));
  const out = [];
  const library = libraryOf(st, ctx.pack);
  const mobs = c.combatants.filter((x) => x.type === 'mob' && x.hp > 0 && !x.hidden && (x.attacks ?? []).length && !statusBlocker(x, library, 'action'));
  const pickAttack = (m) => (m.attackMode === 'random' ? Math.floor(ctx.rng() * m.attacks.length) : 0);
  for (const m of mobs) {
    const big = m.sourceKind === 'boss' || m.role === 'elite' || m.role === 'boss';
    // One action per crawler in the fight, even the fallen ones (the book): extra attacks go round the standing.
    if (big) { const n = crawlers(st).length; for (let i = 0; i < n; i++) { const t = targets[i % targets.length]; out.push({ mobUid: m.uid, attackIndex: pickAttack(m), targetUid: t.uid }); load.set(t.uid, load.get(t.uid) + 1); } continue; }
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
  if (!mob || !target || target.dead) { d.result = 'evaded'; return; }
  if (mob.conditions?.length) {
    const blocked = statusBlocker(mob, libraryOf(st, ctx.pack), 'action');
    if (blocked) {
      d.result = 'evaded';
      d.damage = 0;
      log(rx, `${mob.name} cannot attack due to ${blocked}.`);
      return;
    }
  }
  const deg = d.evade?.degree ?? null;
  const graveFail = deg === 'major' || deg === 'critfail';
  const F = floorOfState(st);
  // Splash ring of an area attack: half damage, a successful Evade there leaves a quarter.
  let mult = d.splash ? 0.5 : 1;
  let bonus = 0;
  if (deg && isSuccess(deg)) {
    if (!d.attack.area) { d.result = 'evaded'; d.damage = 0; log(rx, `${nameOf(st, target)} evades ${mob.name}'s ${d.attack.name}.`); return; }
    mult *= 0.5;
  }
  if (deg === 'major') bonus = F;
  if (deg === 'critfail') mult *= 2;
  let rolled = 0;
  try {
    rolled = rollDice(d.attack.damage, { resolve: (name) => name === 'floor' ? F : undefined, randInt: ctx.dieInt ?? ctx.rollInt ?? ctx.randInt }).total;
  } catch { /* Bad legacy damage formula. */ }
  const amount = Math.max(0, Math.floor(rolled * mult) + bonus);
  d.result = mult < 1 ? 'half' : 'hit';
  d.damage = amount;
  let immune = typedDamage(0, d.attack.dtype, target).why === 'immune';
  if (amount > 0) {
    const sub = { ...out, result: undefined };
    const wasDying = target.type === 'crawler' && target.dying != null;
    COMBAT_GM['combat.damage'](st, { uid: target.uid, amount, dr: true, dtype: d.attack.dtype }, ctx, sub);
    if (sub.result?.slotValue) d.slots = sub.result.actualAmount ?? 0;
    d.damageAfterDr = sub.result?.rolled;
    immune = sub.result?.typed === 'immune';
    if (!sub.result?.blocked) onCrawlerDamage(st, ctx, out, target, wasDying);
  }
  log(rx, `${mob.name} hits ${nameOf(st, target)} with ${d.attack.name}: ${amount} HP${d.slots == null ? '' : ` → ${d.slots} slots`}.`);
  if (immune) return;
  // Injuries after the fight (ruleset combat.injuries): Evade Major Fail → minor, natural 1 → major.
  if (target.type === 'crawler' && graveFail && ctx.pack.ruleset.combat?.injuries) {
    markInjury(st, ctx, target, deg === 'critfail' ? 'major' : 'minor');
  }
  const buffs = new Set([...(d.attack.buffs ?? []), ...(graveFail ? d.attack.majorFailBuffs ?? [] : [])]);
  if (!buffs.size) return;
  const library = libraryOf(st, ctx.pack);
  for (const buffId of buffs) {
    if (library.get('buff', buffId)) COMBAT_GM['combat.condition'](st, { uid: target.uid, buffId, on: true }, ctx, { ...out, result: undefined });
  }
}

function markInjury(st, ctx, target, severity, description) {
  const rules = ctx.pack.ruleset.combat?.injuries;
  if (!rules) throw bad('injuries are unavailable in this campaign');
  if (!['minor', 'major'].includes(severity)) throw bad('severity must be minor or major');
  if (description !== undefined && (typeof description !== 'string' || description.trim().length > 180)) throw bad('description must be at most 180 characters');
  const injuries = target.injuries ??= [];
  if (injuries.length >= 10) return;
  const p = st.players.find((x) => x.id === target.playerId);
  if (!p) return;
  injuries.push({ id: ctx.genId('inj'), severity, desc: nextInjuryDescription(p, rules, severity, description) });
}

export const REACTION_GM = {
  'combat.injury'(st, a, ctx) {
    if (!C(st).active) throw bad('start combat to record an injury');
    markInjury(st, ctx, crawlerOf(st, a.uid), a.severity, a.description);
  },

  'combat.injury.remove'(st, a) {
    if (typeof a.injuryId !== 'string') throw bad('injuryId required');
    const target = crawlerOf(st, a.uid);
    target.injuries = (target.injuries ?? []).filter((injury) => injury.id !== a.injuryId);
  },

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

  /** Edit a declaration while the GM is still planning. */
  'rx.retarget'(st, a, ctx) {
    const rx = rxOf(st);
    if (rx.step !== 'declare') throw bad('targets change in the declare step');
    const d = declOf(rx, a.declId);
    if (a.targetUid !== undefined) {
      const target = crawlerOf(st, a.targetUid);
      if (target.dead) throw bad('that crawler is already dead');
      d.targetUid = target.uid;
    }
    if (a.attackIndex !== undefined) {
      d.attack = declaredAttack(st, ctx, mobOf(st, d.mobUid), a.attackIndex);
      d.attackIndex = a.attackIndex;
      d.attack.baseDc = d.attack.dc;
      d.attack.dc += d.adv === 'adv' ? 5 : d.adv === 'dis' ? -5 : 0;
      d.splash = false;
    }
  },

  /**
   * `{ declId, adv: 'adv' | 'dis' | null }` A mob attacks with Advantage (+5 to the Evade difficulty) or
   * Disadvantage (−5 and a free Evade): high ground, cover, darkness, size. Only before the Evade rolls.
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

  /**
   * `{ declId, area: null | 'full' | 'splash' }` Area of Effect for this hit: 'full' (evade halves it) or
   * 'splash' (the target stands in the splash ring: half damage, a successful Evade leaves a quarter).
   */
  'rx.area'(st, a) {
    const rx = rxOf(st);
    if (!['declare', 'react'].includes(rx.step)) throw bad('change it before the hits land');
    const d = declOf(rx, a.declId);
    if (d.result) throw bad('already resolved');
    if (![null, 'full', 'splash'].includes(a.area ?? null)) throw bad('area must be full, splash or null');
    d.attack.area = !!a.area;
    d.splash = a.area === 'splash';
  },

  'rx.undeclare'(st, a) {
    const rx = rxOf(st);
    if (rx.step !== 'declare') throw bad('attacks change in the declare step');
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
      if (rx.step !== 'react') throw bad('announce the attacks before resolving damage');
      const byUid = new Map(crawlers(st).map((x) => [x.uid, x]));
      const library = libraryOf(st, ctx.pack);
      const missing = rx.decls.filter((d) => {
        const target = byUid.get(d.targetUid);
        return !d.evade && evadeOptions(rx, d, target, !!statusBlocker(playerOfCrawler(st, target), library, 'interrupt')).canEvade;
      });
      if (missing.length && a.force !== true) {
        out.result = { waiting: missing.map((d) => d.id) };
        throw bad(`${missing.length} Evade roll${missing.length === 1 ? '' : 's'} missing`);
      }
      rx.step = 'resolve';
      for (const d of rx.decls) if (!d.result) resolveDecl(st, ctx, out, rx, d);
      out.emit({ kind: 'rx.resolved', round: rx.round }, 'all');
      return;
    }
    if (a.to === 'react' && rx.step === 'declare') {
      for (const uid of new Set(rx.decls.map((d) => d.mobUid))) {
        const m = C(st).combatants.find((x) => x.uid === uid);
        if (m?.hidden) COMBAT_GM['combat.reveal'](st, { uid }, ctx, { ...out, result: undefined });
      }
      out.emit({ kind: 'rx.react', round: rx.round, targets: [...new Set(rx.decls.map((d) => d.targetUid))] }, 'all');
    }
    rx.step = a.to;
  },

  /**
   * The crawlers surprised the mobs (Stealth / Ambush beat their Surprise): before round 1 every crawler gets
   * one free action, the mobs do nothing. Then rx.round starts round 1 as usual.
   */
  'rx.surprise'(st, a, ctx, out) {
    const rx = rxOf(st);
    if (rx.round !== 1 || rx.step !== 'declare' || rx.decls.length || rx.surprised) throw bad('only before the first round');
    rx.surprised = true;
    rx.round = 0;
    C(st).round = 0;
    rx.step = 'act';
    for (const x of crawlers(st)) rx.acts[x.uid] = 1;
    log(rx, 'Surprise! The crawlers get one free action each.');
    out.emit({ kind: 'rx.surprise' }, 'all');
  },

  /** Clean up and start the next round at declare. */
  'rx.round'(st, a, ctx, out) {
    const rx = rxOf(st);
    debuffTicks(st, ctx, out, rx);
    dyingTick(st, ctx, out, 'cleanup');
    if (rx.round > 0) advanceGameTime(st, ctx.pack.ruleset.combat.roundSeconds, out);
    rx.round += 1;
    C(st).round = rx.round;
    rx.step = 'declare';
    rx.decls = [];
    resetActs(st);
    // Timed mob conditions count down (crawler buffs count down through the sheet's own round tick).
    const library = libraryOf(st, ctx.pack);
    for (const m of C(st).combatants) if (m.type === 'mob') m.conditions = (m.conditions ?? []).flatMap((k) => {
      const rounds = k.rounds ?? library.get('buff', k.id)?.rounds;
      return rounds === 1 ? [] : rounds > 1 ? [{ ...k, rounds: rounds - 1 }] : [k];
    });
    out.emit({ kind: 'rx.round', round: rx.round }, 'all');
  },

  /** GM enters an Evade roll for a crawler (physical dice at the table): `{ declId, die }`. */
  'rx.evade'(st, a, ctx, out) { evadeRoll(st, ctx, out, a, null); },

  /** `{ uid, delta }` actions (a debuff or a house rule). */
  'rx.actions'(st, a) {
    const rx = rxOf(st);
    crawlerOf(st, a.uid);
    if (!Number.isInteger(a.delta) || Math.abs(a.delta) > 3) throw bad('delta must be an integer -3..3');
    rx.acts[a.uid] = Math.max(0, Math.min(5, (rx.acts[a.uid] ?? ACTIONS_PER_ROUND) + a.delta));
  },
  'rx.favor'(st, a, ctx, out) { buyFavorAction(st, ctx, out, crawlerOf(st, a.uid)); },
};

/**
 * Clean up: every buff / condition with a `tick` (Blood Trail, Burned, Poisoned…) deals its damage — crawlers
 * from their sheet buffs, mobs from conditions that name a library buff (buffId).
 */
function debuffTicks(st, ctx, out, rx) {
  const lib = libraryOf(st, ctx.pack);
  const F = floorOfState(st);
  const hit = (x, def, who) => {
    let n = 0;
    try { n = rollDice(def.tick.damage, { randInt: ctx.dieInt ?? ctx.rollInt ?? ctx.randInt }).total; } catch { n = 1; }
    n += def.tick.plusFloor ? F : 0;
    if (n <= 0) return;
    const wasDying = x.type === 'crawler' && x.dying != null;
    const sub = { ...out, result: undefined };
    COMBAT_GM['combat.damage'](st, { uid: x.uid, amount: n, rolled: true, dtype: def.tick.type }, ctx, sub);
    if (x.type === 'crawler' && !sub.result?.blocked) onCrawlerDamage(st, ctx, out, x, wasDying);
    log(rx, `${who}: ${def.name} ${n} HP${sub.result?.slotValue ? ` → ${sub.result.actualAmount ?? sub.result.amount ?? 0} slots` : ''}.`);
  };
  for (const x of [...C(st).combatants]) {
    if (x.type === 'crawler') {
      const p = st.players.find((y) => y.id === x.playerId);
      if (!p) continue;
      p.sheet.buffs = p.sheet.buffs.filter((b) => {
        const def = b.buffId ? lib.get('buff', b.buffId) : null;
        if (def?.tick && !x.dead) hit(x, def, p.name);
        const rounds = b.roundsLeft ?? def?.rounds;
        if (rounds) {
          b.roundsLeft = rounds - 1;
          if (b.roundsLeft > 0) b.until = `${b.roundsLeft} round${b.roundsLeft === 1 ? '' : 's'}`;
          return b.roundsLeft > 0;
        }
        return true;
      });
    } else if (x.type === 'mob' && x.hp > 0) {
      for (const k of x.conditions ?? []) { const bid = k.id ?? k.buffId; const def = bid ? lib.get('buff', bid) : null; if (def?.tick) hit(x, def, x.name); }
    }
  }
}

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
  if (rx.step !== 'react') throw bad('it is not the reaction step');
  const d = declOf(rx, a.declId);
  const x = crawlerOf(st, d.targetUid);
  if (playerId && x.playerId !== playerId) throw bad('that attack is not aimed at you');
  if (!standing(x)) throw bad('that crawler cannot act');
  if (d.caught) throw bad('a caught attack cannot be evaded');
  if (d.result) throw bad('already resolved');
  const { freeEvade, canEvade } = evadeOptions(rx, d, x);
  if (!freeEvade) requireStatusAllowed(st, ctx, playerOfCrawler(st, x), 'interrupt');
  if (!canEvade) {
    if (d.evade && (!d.evade.free || isSuccess(d.evade.degree))) throw bad('already evaded');
    throw bad('spend an action on Evade first');
  }
  if (!Number.isInteger(a.die) || a.die < 1 || a.die > 20) throw bad('die must be 1..20');
  const total = a.die + crawlerEvade(st, ctx, x);
  const degree = degreeOf(a.die, total, d.attack.dc);
  d.evade = { die: a.die, total, degree, ...(freeEvade ? { free: true } : {}) };
  // Evade natural 20 / Amazing: Advantage on the next attack against that mob (shown on the phone + TV log).
  if (degree === 'crit' || degree === 'amazing') {
    rx.advantage = [...(rx.advantage ?? []).filter((v) => !(v.uid === x.uid && v.mobUid === d.mobUid)), { uid: x.uid, mobUid: d.mobUid }].slice(-20);
    log(rx, `${nameOf(st, x)} has Advantage on the next attack against ${mobOf(st, d.mobUid).name}.`);
  }
  out.result = { degree, label: DEGREE_LABEL[degree], near: degree === 'near', free: freeEvade };
  out.emit({ kind: 'rx.evade', declId: d.id, uid: x.uid, degree, near: degree === 'near' }, 'all');
}

export const REACTION_PLAYER = {
  /** `{ kind, declId?, die? }` — spends one action. Catcher / Taunt name the attack they take over. */
  'rx.interrupt'(st, a, ctx, out) {
    const rx = rxOf(st);
    const me = crawlers(st).find((x) => x.playerId === ctx.actor.playerId);
    if (!me) throw bad('you are not in this fight');
    if (!standing(me)) throw bad('that crawler cannot act');
    requireStatusAllowed(st, ctx, playerOfCrawler(st, me), 'interrupt');
    if (!INTERRUPTS.includes(a.kind)) throw bad(`kind must be one of ${INTERRUPTS.join(', ')}`);
    const inReact = rx.step === 'react';
    if (!inReact && !(rx.step === 'act' && (a.kind === 'heal' || a.kind === 'intervene'))) throw bad('interrupts are for the reaction step');
    if (a.kind === 'evade') {
      if (rx.evading.includes(me.uid)) throw bad('already evading this round');
      spendReactionAction(rx, me.uid);
      rx.evading.push(me.uid);
    } else if (a.kind === 'catcher') {
      const d = declOf(rx, a.declId);
      if (d.targetUid === me.uid) throw bad('that attack is already aimed at you');
      spendReactionAction(rx, me.uid);
      Object.assign(d, { targetUid: me.uid, caught: true, taunted: false, tauntEvade: false, evade: null });
    } else if (a.kind === 'taunt') {
      const d = declOf(rx, a.declId);
      if (d.targetUid === me.uid) throw bad('that attack is already aimed at you');
      const mob = mobOf(st, d.mobUid);
      const library = libraryOf(st, ctx.pack);
      const intMod = mob.stats?.int?.mod ?? library.get(mob.sourceKind || 'monster', mob.sourceId)?.stats?.int?.mod ?? 2;
      const dc = 10 + intMod + floorOfState(st);
      const p = st.players.find((x) => x.id === me.playerId);
      const skill = p?.sheet?.skills?.find((s) => s.skillId === 'taunt');
      spendReactionAction(rx, me.uid);
      let ok;
      if (a.die === undefined) {
        if (!Number.isInteger(a.total)) throw bad('enter the Taunt die or check total');
        ok = a.total >= dc;
      } else {
        if (!Number.isInteger(a.die) || a.die < 1 || a.die > 20) throw bad('die must be 1..20');
        const rs = ctx.pack.ruleset;
        const what = skill ? { kind: 'skill', uid: skill.uid }
          : rs.skills?.untrained && library.get('skill', 'taunt') ? { kind: 'untrained', skillId: 'taunt' }
          : rs.stats.some((s) => s.id === 'cha') ? { kind: 'stat', id: 'cha' } : null;
        if (what) {
          const sub = { ...out, result: undefined };
          SHEET.roll(st, { what, entered: a.die, dc, secret: true, card: false }, ctx, sub);
          ok = sub.result.hit;
        } else ok = a.die === 20 || (a.die > 1 && a.die >= dc);
      }
      if (ok) Object.assign(d, { targetUid: me.uid, taunted: true, tauntEvade: (skill?.rank ?? 0) >= 5, caught: false, evade: null });
      out.result = { ok };
    } else if (a.kind === 'heal' && ctx.pack.ruleset.combat?.healSpell) {
      // The heal every crawler has (DCC: 2 Mana → 2 Health slots), before the hits land.
      const hs = ctx.pack.ruleset.combat.healSpell;
      const p = st.players.find((y) => y.id === me.playerId);
      requireStatusAllowed(st, ctx, p, 'spell');
      const mana = p?.sheet?.tracks?.[hs.track];
      const have = Number(mana?.cur ?? mana?.value ?? 0);
      if (!mana || have < hs.mana) throw bad(`not enough Mana (needs ${hs.mana})`);
      if (me.dead) throw bad('too late');
      spendReactionAction(rx, me.uid);
      p.sheet.tracks[hs.track] = { ...mana, cur: have - hs.mana };
      const wasDying = me.dying != null;
      COMBAT_GM['combat.heal'](st, { uid: me.uid, amount: hs.slots }, ctx, { ...out, result: null });
      if (wasDying) dyingTick(st, ctx, out, 'heal', me.uid);
      out.result = { healed: hs.slots, mana: have - hs.mana };
    } else {
      spendReactionAction(rx, me.uid);
      if (a.kind === 'intervene') rx.intervene.push(me.uid);
    }
    log(rx, `${nameOf(st, me)}: ${a.kind}.`);
    out.emit({ kind: 'rx.interrupt', uid: me.uid, what: a.kind }, 'all');
  },

  /** `{ declId, die }` — my Evade roll against one attack. */
  'rx.evade'(st, a, ctx, out) { evadeRoll(st, ctx, out, a, ctx.actor.playerId); },

  /** Spend one AI Favor to buy a single non-attack action this round. */
  'rx.favor'(st, a, ctx, out) {
    const me = crawlers(st).find((x) => x.playerId === ctx.actor.playerId);
    if (!me) throw bad('you are not in this fight');
    buyFavorAction(st, ctx, out, me);
  },

  /** Intervene: `{ declId, d6 }` adds 1d6 to an ally's Evade roll (most useful on a Near miss). */
  'rx.intervene'(st, a, ctx, out) {
    const rx = rxOf(st);
    const me = crawlers(st).find((x) => x.playerId === ctx.actor.playerId);
    if (!me || !rx.intervene.includes(me.uid)) throw bad('spend an action on Intervene first');
    if (!standing(me)) throw bad('that crawler cannot act');
    requireStatusAllowed(st, ctx, playerOfCrawler(st, me), 'interrupt');
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

  /** Spend a non-attack action for a move or item: `{ n? }`. */
  'rx.spend'(st, a, ctx) {
    const rx = rxOf(st);
    const me = crawlers(st).find((x) => x.playerId === ctx.actor.playerId);
    if (!me) throw bad('you are not in this fight');
    if (!standing(me)) throw bad('that crawler cannot act');
    if (rx.step !== 'act' && rx.step !== 'react') throw bad('not now');
    requireStatusAllowed(st, ctx, playerOfCrawler(st, me), rx.step === 'react' ? 'interrupt' : 'action');
    spendReactionAction(rx, me.uid, a.n === 2 ? 2 : 1);
  },
};

/** Role-filtered view of the round: players never see difficulties or hidden mobs' plans. */
export function reactionView(state, role, pack) {
  const c = state.combat;
  if (!c?.active || !isObj(c.rx) || c.rx.combatId !== c.id) return null;
  const rx = c.rx;
  const gm = role === 'gm';
  const mobs = new Map(c.combatants.filter((x) => x.type === 'mob').map((x) => [x.uid, x]));
  const byUid = new Map(crawlers(state).map((x) => [x.uid, x]));
  const library = pack && libraryOf(state, pack);
  const decls = rx.decls.filter((d) => gm || (rx.step !== 'declare' && !mobs.get(d.mobUid)?.hidden)).map((d) => {
    const m = mobs.get(d.mobUid);
    const target = byUid.get(d.targetUid);
    const blocked = library && !!statusBlocker(playerOfCrawler(state, target), library, 'interrupt');
    const base = { id: d.id, mobUid: d.mobUid, mob: m?.name ?? '?', attack: d.attack.name, area: d.attack.area, splash: !!d.splash, adv: d.adv ?? null, targetUid: d.targetUid, caught: d.caught, taunted: d.taunted, result: d.result, damage: d.damage, ...evadeOptions(rx, d, target, blocked), ...(d.slots != null ? { slots: d.slots } : {}), evade: d.evade ? { degree: d.evade.degree, label: DEGREE_LABEL[d.evade.degree], die: d.evade.die, helped: d.evade.helped ?? 0, free: !!d.evade.free } : null };
    return gm ? { ...base, attackIndex: d.attackIndex, dc: d.attack.dc, damageDice: d.attack.damage, dtype: d.attack.dtype, effects: d.attack.effects, damageAfterDr: d.damageAfterDr, evadeTotal: d.evade?.total ?? null } : base;
  });
  const advantage = (rx.advantage ?? []).filter((v) => gm || !mobs.get(v.mobUid)?.hidden).map((v) => ({ uid: v.uid, mobUid: v.mobUid, mob: mobs.get(v.mobUid)?.name ?? '?' }));
  return { round: rx.round, step: rx.step, steps: STEPS, decls, acts: rx.acts, nonAttackActions: rx.nonAttackActions ?? {}, favor: rx.favor ?? [], evading: rx.evading, intervene: rx.intervene, advantage, surprised: !!rx.surprised, log: gm ? rx.log.slice(-12) : rx.log.slice(-5) };
}
