// Attack / check outcomes per game system (browser-safe, no imports beyond constants).
// combatRules(pack, settings) reads the campaign ruleset's `combat` block; crawler packs use the tracker settings.
const DEFAULT_SETTINGS = Object.freeze({ hitRule: '>=', crit: 'double', evadeBase: 0, drMin: 1 });

/** Rules of the campaign's game for one attack roll (crawler packs: the tracker settings decide). */
export function combatRules(pack, settings = DEFAULT_SETTINGS) {
  settings = settings ?? DEFAULT_SETTINGS;
  const cr = pack.ruleset.combat ?? {};
  const family = pack.ruleset.system?.family ?? 'crawler';
  const fixed = family !== 'crawler';
  return {
    family,
    degrees: !!cr.degrees,
    // 'seven' (crawler books): nat 20 crit · beat by 10 amazing · success · miss by 1–2 near · fail · miss by
    // 10 major · nat 1 critical fail. Amazing adds the floor to damage; near misses can be Intervened.
    seven: cr.degreeScale === 'seven',
    hitRule: fixed ? cr.hitRule ?? '>=' : settings.hitRule,
    crit: cr.crit ?? settings.crit ?? 'double',
    critRange: cr.critRange ?? 20,
    nat1: cr.nat1 ?? 'miss',
    evadeBase: fixed ? 0 : settings.evadeBase ?? 0,
    drMin: cr.drMin ?? (fixed ? 0 : settings.drMin ?? 1),
    useDr: fixed ? !!cr.dr : true,
    defenseLabel: cr.defenseLabel || 'Evade',
    advantage: !!cr.advantage,
    ...(cr.sizeGap ? { sizeGap: cr.sizeGap, crawlerSize: cr.crawlerSize } : {}),
    // Mob numbers as "base + floor" (crawler books: Evade 10 + Dex + F, to hit 10 + mod + F).
    // mobBase is added to a mob's Evade and to-hit bonus; floorScaled adds the world's current floor.
    mobBase: Number.isInteger(cr.mobBase) ? cr.mobBase : 0,
    floorScaled: cr.floorScaled === true,
  };
}

/** The world's floor (crawlers.js), 1 when unknown. */
export const floorOfState = (st) => (Number.isInteger(st?.crawlers?.floor) && st.crawlers.floor > 0 ? st.crawlers.floor : 1);

/** Target number to hit a mob: its Evade plus the ruleset's mob base and (optionally) the floor. */
export function mobDefense(rules, evade, floor = 1) {
  return (Number.isFinite(evade) ? evade : 0) + (rules.mobBase || 0) + (rules.floorScaled ? floor : 0);
}

/** Difficulty of evading a mob attack: its `dc` when given, else 10 + to-hit (+ mob base, + floor when scaled). */
export function mobAttackDc(rules, attack, floor = 1) {
  if (Number.isFinite(attack?.dc)) return attack.dc + (rules.floorScaled && attack.dcPlusFloor ? floor : 0);
  return (rules.mobBase || 10) + (Number(attack?.toHit) || 0) + (rules.floorScaled ? floor : 0);
}

/**
 * Outcome of an attack (or check) total against a target number.
 * Returns { hit, crit, degree (0 crit fail, 1 fail, 2 success, 3 crit success), margin }.
 */
/** The seven degrees of the crawler books (see combatRules.seven). */
export function degree7(d20, total, target) {
  if (d20 === 20) return 'crit';
  if (d20 === 1) return 'critfail';
  const m = total - target;
  if (m >= 10) return 'amazing';
  if (m >= 0) return 'success';
  if (m >= -2) return 'near';
  if (m > -10) return 'fail';
  return 'major';
}
export const DEGREE7_LABEL = { crit: 'Critical hit', amazing: 'Amazing', success: 'Success', near: 'Near miss', fail: 'Fail', major: 'Major fail', critfail: 'Critical fail' };

export function attackOutcome(rules, { d20, total, target }) {
  const nat20 = d20 === 20;
  const nat1 = d20 === 1;
  const margin = total - target;
  if (rules.seven) {
    const deg7 = degree7(d20, total, target);
    const hit = deg7 === 'crit' || deg7 === 'amazing' || deg7 === 'success';
    return { hit, crit: deg7 === 'crit', degree: deg7 === 'crit' ? 3 : hit ? 2 : deg7 === 'critfail' ? 0 : 1, deg7, margin };
  }
  if (rules.degrees) {
    let deg = margin >= 10 ? 3 : margin >= 0 ? 2 : margin <= -10 ? 0 : 1;
    if (nat20) deg = Math.min(3, deg + 1);
    if (nat1) deg = Math.max(0, deg - 1);
    return { hit: deg >= 2, crit: deg === 3, degree: deg, margin };
  }
  const meets = rules.hitRule === '>' ? total > target : total >= target;
  const hit = nat20 ? true : nat1 && rules.nat1 !== 'none' ? false : meets;
  const crit = hit && d20 >= (rules.critRange ?? 20) && rules.crit !== 'none';
  return { hit, crit, degree: crit ? 3 : hit ? 2 : nat1 ? 0 : 1, margin };
}

/** Damage formula on a critical: 'dice' doubles the dice ("1d8+3" -> "2d8+3"); others keep it (x2 after). */
export function critFormula(formula, rules) {
  if (rules.crit !== 'dice') return formula;
  return String(formula).replace(/(\d*)d(\d+)/gi, (m, n, sides) => `${(Number(n) || 1) * 2}d${sides}`);
}
export const critMultiplier = (rules) => (rules.crit === 'double' || rules.crit === 'degrees' ? 2 : 1);

/** Near-miss classification for the show: 'near_success' (made it by 0-1) / 'near_fail' (missed by 1-2) / null. */
export function nearness(res, d20) {
  if (!res || d20 === 1 || d20 === 20) return null;
  if (res.hit && res.margin >= 0 && res.margin <= 1 && !res.crit) return 'near_success';
  if (!res.hit && res.margin >= -2 && res.margin <= -1) return 'near_fail';
  return null;
}

/** Damage one health slot of this mob is worth: its own `slotValue`, else the ruleset's `mobSlotValue`, else 1. */
export function mobSlotValue(pack, mob) {
  const own = Number(mob?.slotValue);
  if (Number.isInteger(own) && own >= 1) return own;
  const r = Number(pack?.ruleset?.combat?.mobSlotValue);
  return Number.isInteger(r) && r >= 1 ? r : 1;
}

/** Slot denomination for views. A plain HP pool has no slot denomination. */
export function mobHealthSlot(pack, mob) {
  return mob?.slotValue > 0 || pack.ruleset.combat?.mobSlotValue > 0 || pack.ruleset.combat?.hpModel === 'slots'
    ? mobSlotValue(pack, mob) : null;
}

/** Rolled damage (after DR) → whole health slots; damage below one slot's worth is lost. */
export function damageToSlots(amount, slotValue) {
  return slotValue > 1 ? Math.floor(Math.max(0, amount) / slotValue) : Math.max(0, amount);
}

/** Typed protection from mob stat blocks or active crawler gear, spells and buffs. */
export function typedDamage(amount, type, target, protections) {
  const t = String(type || '').trim().toLowerCase();
  if (!t || !target) return { amount, why: null };
  const has = (kind) => (target[kind] ?? []).includes(t) || protections?.[`${kind}.${t}`]?.value > 0;
  if (has('immune')) return { amount: 0, why: 'immune' };
  let out = amount;
  let why = null;
  if (has('resist')) { out = Math.floor(out / 2); why = 'resistant'; }
  if (has('vulnerable')) { out *= 2; why = why ? null : 'vulnerable'; }
  return { amount: out, why };
}

/** Rolled HP damage: apply DR, typed protection and finally convert to whole slots. */
export function rolledDamage(amount, { dr = 0, drMin = 0, dtype, target, protections, slotValue = 1 } = {}) {
  const afterDr = Math.max(drMin, amount - Math.max(0, dr));
  const { amount: rolled, why } = typedDamage(afterDr, dtype, target, protections);
  return {
    amount: damageToSlots(rolled, slotValue), rolled, slotValue, dr, drApplied: amount - afterDr,
    ...(why ? { typed: why } : {}),
  };
}

/** Update loot credit when a mob is defeated or gets back up. */
export function recordKillCredit(combat, mob, before, playerId = null) {
  if (before > 0 && mob.hp === 0) {
    mob.killedBy = playerId;
    if (!mob.hidden) combat.lastKill = { uid: mob.uid, playerId };
  } else if (before <= 0 && mob.hp > 0) {
    mob.killedBy = null;
    if (combat.lastKill?.uid === mob.uid) combat.lastKill = null;
  }
}
