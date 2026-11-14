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
    hitRule: fixed ? cr.hitRule ?? '>=' : settings.hitRule,
    crit: cr.crit ?? settings.crit ?? 'double',
    critRange: cr.critRange ?? 20,
    nat1: cr.nat1 ?? 'miss',
    evadeBase: fixed ? 0 : settings.evadeBase ?? 0,
    drMin: fixed ? 0 : settings.drMin ?? 1,
    useDr: fixed ? !!cr.dr : true,
    defenseLabel: cr.defenseLabel || 'Evade',
    advantage: !!cr.advantage,
  };
}

/**
 * Outcome of an attack (or check) total against a target number.
 * Returns { hit, crit, degree (0 crit fail, 1 fail, 2 success, 3 crit success), margin }.
 */
export function attackOutcome(rules, { d20, total, target }) {
  const nat20 = d20 === 20;
  const nat1 = d20 === 1;
  const margin = total - target;
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
