// Forecast first knockout assuming standing characters share attacks and the current enemies keep fighting.
// Shared by the engine (Fight and TV) and the browser (Prep). The estimate is deterministic.
import { benchmark, LEVELS } from './prep-bench.js';
import { evaluate, parseFormula } from './rules.js';

const finite = (value, fallback = 0) => value == null || !Number.isFinite(Number(value)) ? fallback : Number(value);
const weight = (mob) => Math.max(0, Math.round(finite(mob.count, 1)));
const big = (mob) => mob.role === 'elite' || mob.role === 'boss';
const fraction = (hp, max) => Math.max(0, Math.min(1, hp / max));
const MAX_DISTRIBUTION = 513;

function additive(node, sign, dice, critical) {
  if (node.k === 'num') return sign * node.v;
  if (node.k === 'id') return 0;
  if (node.k === 'dice') {
    dice.push({ count: node.n * (critical ? 2 : 1), sides: node.sides, sign });
    return 0;
  }
  if (node.k === 'neg') return additive(node.a, -sign, dice, critical);
  if (node.k === 'bin' && (node.op === '+' || node.op === '-')) {
    return additive(node.a, sign, dice, critical) + additive(node.b, node.op === '-' ? -sign : sign, dice, critical);
  }
  return NaN;
}

/** Each entry at index i is the probability for damage first+i. Large/nonlinear homebrew uses its mean. */
function damageDistribution(formula, floor, critical) {
  if (typeof formula === 'number') return { first: finite(formula), probabilities: [1] };
  if (typeof formula !== 'string' || formula.length > 500 || !formula.trim()) return { first: 0, probabilities: [1] };
  // Resolve the floor variable before parsing so the shared grammar can distinguish it from floor(...).
  const source = formula.replace(/(^|[^.\w])(?:floor|F)(?![.\w]|\s*\()/g, (_, prefix) => `${prefix}${floor}`);
  let ast;
  try { ast = parseFormula(source); } catch { return { first: 0, probabilities: [1] }; }
  const dice = [];
  let first = additive(ast, 1, dice, critical);
  const width = 1 + dice.reduce((n, d) => n + d.count * (d.sides - 1), 0);
  if (!Number.isFinite(first) || width > MAX_DISTRIBUTION || dice.some((d) => d.count < 1 || d.count > 200 || d.sides < 1)) {
    const mean = source.replace(/\b(\d*)d(\d+)\b/gi, (_, count, sides) => String((Number(count) || 1) * (Number(sides) + 1) * (critical ? 1 : 0.5)));
    return { first: finite(evaluate(mean).value), probabilities: [1] };
  }
  let probabilities = [1];
  for (const { count, sides, sign } of dice) {
    first += count * (sign > 0 ? 1 : -sides);
    if (sides === 1) continue;
    for (let i = 0; i < count; i++) {
      const next = new Float64Array(probabilities.length + sides - 1);
      let window = 0;
      for (let j = 0; j < next.length; j++) {
        window += (probabilities[j] ?? 0) - (probabilities[j - sides] ?? 0);
        next[j] = Math.max(0, window) / sides;
      }
      probabilities = next;
    }
  }
  return { first, probabilities };
}

function profiles(attack, target, rules, floor, attackFloor) {
  const outcomes = new Map();
  const evade = finite(target.evade) + finite(rules.evadeBase);
  const toHit = finite(attack.toHit);
  const dc = Number.isFinite(attack.dc)
    ? attack.dc + (rules.floorScaled && attack.dcPlusFloor ? attackFloor : 0)
    : (finite(rules.mobBase) || 10) + toHit + (rules.floorScaled ? attackFloor : 0);
  for (let die = 1; die <= 20; die++) {
    let multiplier = 1, bonus = 0, critical = false;
    if (rules.flow === 'reaction') {
      const margin = die + evade - dc;
      if (die === 1) multiplier = 2;
      else if (die === 20 || margin >= 0) multiplier = attack.area ? 0.5 : 0;
      else if (margin <= -10) bonus = floor;
    } else {
      const margin = die + toHit - evade;
      if (rules.degrees && !rules.seven && rules.degreeScale !== 'seven') {
        const grade = margin >= 10 ? 3 : margin >= 0 ? 2 : margin <= -10 ? 0 : 1;
        const result = grade + (die === 20 ? 1 : die === 1 ? -1 : 0);
        if (result < 2) continue;
        critical = result >= 3;
      } else {
        const seven = rules.seven || rules.degreeScale === 'seven';
        const meets = !seven && rules.hitRule === '>' ? margin > 0 : margin >= 0;
        if (die !== 20 && (!meets || (die === 1 && (seven || rules.nat1 !== 'none')))) continue;
        critical = die >= finite(rules.critRange, 20) && rules.crit !== 'none';
      }
      if (critical && (rules.crit === 'double' || rules.crit === 'degrees' || rules.crit == null)) multiplier = 2;
    }
    if (!multiplier) continue;
    const criticalDice = critical && rules.crit === 'dice';
    const key = `${multiplier}:${bonus}:${criticalDice}`;
    if (!outcomes.has(key)) outcomes.set(key, { multiplier, bonus, criticalDice, count: 0 });
    outcomes.get(key).count++;
  }
  return outcomes.values();
}

function averageAttack(attack, target, rules, floor, attackFloor, distributions) {
  const formula = attack.damage ?? '0';
  if (!String(formula).trim() || /^0+$/.test(String(formula).trim())) return 0;
  const dr = rules.useDr === false ? 0 : Math.max(0, finite(target.dr));
  const minimum = finite(rules.drMin, rules.flow === 'reaction' ? 0 : 1);
  const slot = finite(target.slotValue);
  const dtype = String(attack.dtype ?? '').trim().toLowerCase();
  const has = (kind) => dtype && (target[kind]?.includes(dtype) || target.protections?.[`${kind}.${dtype}`]?.value > 0);
  if (has('immune')) return 0;
  const resist = has('resist'), vulnerable = has('vulnerable');
  let total = 0;
  for (const { multiplier, bonus, criticalDice, count } of profiles(attack, target, rules, floor, attackFloor)) {
    const key = `${formula}:${criticalDice}`;
    if (!distributions.has(key)) distributions.set(key, damageDistribution(formula, floor, criticalDice));
    const { first, probabilities } = distributions.get(key);
    for (let i = 0; i < probabilities.length; i++) {
      const raw = (first + i) * multiplier;
      const amount = rules.flow === 'reaction' ? Math.floor(raw) + bonus : raw;
      if (amount <= 0) continue;
      let applied = Math.max(minimum, amount - dr);
      if (resist) applied = Math.floor(applied / 2);
      if (vulnerable) applied *= 2;
      if (slot > 0) applied = Math.floor(applied / slot);
      total += applied * probabilities[i] * (count / 20);
    }
  }
  return total;
}

function band(family, score) {
  if (family === 'dnd') return score < 0.5 ? 0 : score < 1 ? 1 : score < 1.5 ? 2 : 3;
  if (family === 'pf2e') return score <= 0.75 ? 0 : score <= 1 ? 1 : score <= 1.5 ? 2 : 3;
  return score < 0.75 ? 0 : score < 1.25 ? 1 : score < 2 ? 2 : 3;
}

export function danger({ family = 'crawler', rules = {}, floor = 1, party = [], mobs = [], previousScore } = {}) {
  const living = mobs.filter((m) => m && !m.dead && finite(m.hp, 1) > 0 && weight(m) > 0);
  const hidden = living.filter((m) => m.hidden).reduce((n, m) => n + weight(m), 0);
  const visible = living.reduce((n, m) => n + weight(m), 0) - hidden;
  const heroes = party.filter(Boolean).map((p) => {
    const hpMax = Math.max(1, finite(p.hpMax, finite(p.hp, 1)));
    return { ...p, hp: Math.max(0, Math.min(hpMax, finite(p.hp, hpMax))), hpMax };
  });
  const result = (rawScore, rounds, reason, bandScore = rawScore) => {
    const score = Math.round(Math.max(0, Math.min(99, rawScore)) * 1e4) / 1e4;
    const level = band(family, bandScore);
    const prior = finite(previousScore, score);
    const trend = score - prior > 0.005 ? 'up' : prior - score > 0.005 ? 'down' : 'steady';
    return { label: LEVELS[level], level, rounds, score, trend, hidden, visible, ...(reason ? { reason } : {}) };
  };
  if (!heroes.length) return result(0, null, 'no-party');
  if (!living.length) return result(0, null, 'no-enemies');
  const standing = heroes.filter((p) => !p.dead && p.dying !== true && !Number.isFinite(p.dying) && p.hp > 0);
  if (!standing.length) return result(3, 0);
  rules = { flow: family === 'crawler' ? 'reaction' : 'phases', ...rules };
  floor = Math.max(0, Math.min(999, finite(floor, 1)));
  const distributions = new Map();
  const incoming = standing.map(() => 0);
  let durability = 0, equivalents = 0;
  for (const mob of living) {
    const rowUnits = benchmark(family, heroes, [mob]).units;
    const rowHealth = fraction(finite(mob.hp, 1), Math.max(1, finite(mob.hpMax, finite(mob.hp, 1))));
    durability += rowUnits * (0.4 + 0.6 * rowHealth);
    equivalents += rowUnits;
    if (!mob.attacks?.length) continue;
    const attacks = mob.attackMode === 'random' ? mob.attacks : mob.attacks.slice(0, 1);
    const actions = weight(mob) * (rules.flow === 'reaction' && big(mob) ? heroes.length : 1);
    for (const [i, target] of standing.entries()) {
      const attackLoss = attacks.reduce((sum, a) => sum + averageAttack(a, target, rules, floor, mob.flat ? 0 : floor, distributions), 0);
      incoming[i] += actions * attackLoss / attacks.length / standing.length;
    }
  }
  const alreadyDown = standing.length < heroes.length;
  if (!incoming.some((n) => n > 1e-10)) return alreadyDown ? result(2, 0) : result(0, null, 'no-damage');
  const firstDrop = Math.min(...standing.map((target, i) => incoming[i] > 1e-10 ? target.hp / incoming[i] : Infinity));
  const strength = benchmark(family, heroes, living).ratio * (equivalents ? durability / equivalents : 1);
  const remaining = standing.reduce((n, p) => n + fraction(p.hp, p.hpMax), 0) / heroes.length;
  // Benchmark gives the healthy reference. Faster expected drops can raise the band even with few enemies.
  const pace = 1 / Math.max(0.1, firstDrop);
  const calibrated = Math.max(strength / remaining, 3 * pace, alreadyDown ? 2 : 0);
  const score = calibrated + Math.min(0.125, pace * 0.25);
  return result(score, alreadyDown ? 0 : Math.max(1, Math.ceil(firstDrop - 1e-9)), undefined, calibrated);
}
