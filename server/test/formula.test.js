import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, rollDice, diceText, validateFormula, parseFormula, objectResolver, FormulaError, LIMITS } from '../formula.js';

const R = objectResolver({ mod: { dex: 3, str: -1 }, field: { armor: 2 }, level: 4, x: 14, buff: { evade: { value: 4, label: 'Buffs', parts: [{ label: 'Ring', value: 2 }, { label: 'Haste', value: 2 }] } } });
const val = (src, r = R) => evaluate(src, r).value;

test('arithmetic, precedence, parens, unary minus', () => {
  assert.equal(val('1 + 2 * 3'), 7);
  assert.equal(val('(1 + 2) * 3'), 9);
  assert.equal(val('10 - 4 - 3'), 3);
  assert.equal(val('20 / 4 / 5'), 1);
  assert.equal(val('-3 + 5'), 2);
  assert.equal(val('--3'), 3);
  assert.equal(val('-(2 + 3) * 2'), -10);
  assert.equal(val('+4'), 4);
  assert.equal(val('2.5 * 2'), 5);
  assert.equal(val('0.1 + 0.2'), 0.3);
  assert.equal(val('  7\t\n'), 7);
});

test('functions', () => {
  assert.equal(val('floor((x - 10) / 2)'), 2);
  assert.equal(val('floor((9 - 10) / 2)'), -1);
  assert.equal(val('ceil(1.2)'), 2);
  assert.equal(val('round(2.5)'), 3);
  assert.equal(val('abs(-4)'), 4);
  assert.equal(val('min(3, 1, 2)'), 1);
  assert.equal(val('max(level, 10, mod.dex)'), 10);
  assert.equal(val('max(1)'), 1);
  assert.match(validateFormula('floor(1, 2)'), /takes 1/);
  assert.match(validateFormula('min()'), /unexpected/);
  assert.match(validateFormula('sqrt(4)'), /unknown function/);
  assert.match(validateFormula(`max(${Array(25).fill(1).join(',')})`), /takes 1\.\.20/);
});

test('identifiers via resolver, unknown → 0 with warning', () => {
  assert.equal(val('mod.dex + field.armor + level'), 9);
  const r = evaluate('mod.dex + mod.nope + 1', R);
  assert.equal(r.value, 4);
  assert.deepEqual(r.warnings.map((w) => [w.kind, w.name]), [['unknown', 'mod.nope']]);
  assert.equal(evaluate('nope + nope', R).warnings.length, 1, 'warnings are de-duplicated');
});

test('breakdown parts with labels, nested buff parts, signs', () => {
  const r = evaluate('mod.dex + buff.evade - field.armor + 1', (n) => {
    if (n === 'mod.dex') return { value: 3, label: 'DEX mod' };
    if (n === 'field.armor') return { value: 2, label: 'Armor' };
    return R(n);
  });
  assert.equal(r.value, 6);
  assert.deepEqual(r.parts, [
    { label: 'DEX mod', value: 3, source: 'mod.dex' },
    { label: 'Buffs', value: 4, source: 'buff.evade', parts: [{ label: 'Ring', value: 2 }, { label: 'Haste', value: 2 }] },
    { label: 'Armor', value: -2, source: 'field.armor' },
    { label: 'Bonus', value: 1, source: 'const' },
  ]);
  const c = evaluate('floor(level / 3) * 2 + 1', R);
  assert.deepEqual(c.parts.map((p) => p.label), ['floor(level / 3) * 2', 'Bonus']);
  assert.equal(c.value, 3);
});

test('division by zero → 0 with warning; numbers accepted directly', () => {
  const r = evaluate('5 / (2 - 2)', R);
  assert.equal(r.value, 0);
  assert.equal(r.warnings[0].kind, 'div0');
  assert.equal(evaluate(7, R).value, 7);
  assert.equal(evaluate(Infinity, R).value, 0);
});

test('syntax errors never throw from evaluate', () => {
  for (const bad of ['', '1 +', '(1', '1)', '1 2', 'a..b', 'a.', '.5', '1e5', '2x', '#', 'mod.dex;', '"str"', '1 ** 2', 'a[0]', '`x`', '=> 1', ',']) {
    const r = evaluate(bad, R);
    assert.equal(r.value, 0, bad);
    assert.equal(r.warnings.at(-1).kind, 'formula', bad);
    assert.ok(validateFormula(bad), bad);
  }
  assert.throws(() => parseFormula('1 +'), FormulaError);
  assert.equal(evaluate(null, R).warnings[0].kind, 'formula');
  assert.equal(evaluate({ toString: () => '1' }, R).value, 0);
});

test('malicious input: prototype names, huge numbers, nesting, length', () => {
  for (const src of ['constructor', '__proto__', 'toString', 'constructor.constructor', '__proto__.polluted', 'hasOwnProperty', 'valueOf']) {
    const r = evaluate(src, objectResolver({}));
    assert.equal(r.value, 0, src);
    assert.equal(r.warnings[0].kind, 'unknown', src);
  }
  assert.equal(evaluate('constructor', objectResolver({ a: 1 })).value, 0);
  assert.equal({}.polluted, undefined);
  assert.match(validateFormula('constructor(1)'), /unknown function/);
  assert.match(validateFormula('__proto__(1)'), /unknown function/);
  assert.match(validateFormula('99999999999'), /too large/);
  assert.match(validateFormula('1'.repeat(400)), /too large/);
  // Results are clamped, never Infinity/NaN.
  const big = evaluate('999999999 * 999999999 * 999999999', R);
  assert.equal(big.value, LIMITS.maxValue);
  assert.ok(big.warnings.some((w) => w.kind === 'overflow'));
  assert.ok(Number.isFinite(evaluate('-999999999 * 999999999 * 999999999 * 999999999', R).value));
  const deep = '('.repeat(40) + '1' + ')'.repeat(40);
  assert.match(validateFormula(deep), /deeply nested/);
  assert.equal(validateFormula('('.repeat(20) + '1' + ')'.repeat(20)), null);
  assert.match(validateFormula('-'.repeat(60) + '1'), /deeply nested/);
  assert.match(validateFormula('1+'.repeat(300) + '1'), /too long/);
  assert.match(validateFormula('a'.repeat(101)), /identifier too long/);
  // A throwing or weird resolver cannot break evaluation.
  assert.equal(evaluate('a + 1', () => { throw new Error('boom'); }).value, 1);
  assert.equal(evaluate('a + 1', () => 'string').value, 1);
  assert.equal(evaluate('a + 1', () => ({ value: NaN })).value, 1);
});

test('formula mode rejects dice terms', () => {
  const r = evaluate('2d6 + 1', R);
  assert.equal(r.value, 0);
  assert.equal(r.warnings[0].kind, 'formula');
  assert.equal(val('d20'), 0, 'd20 as a plain identifier is unknown');
});

const fixed = (...vals) => {
  let i = 0;
  return (n) => {
    const v = vals[i++ % vals.length];
    assert.ok(v >= 0 && v < n, `rng value ${v} out of range for d${n}`);
    return v;
  };
};

test('dice: NdM terms, mixing with formula terms, injected RNG', () => {
  const r = rollDice('2d6 + 1d4 + 3', { randInt: fixed(0, 5, 3) });
  assert.equal(r.total, 1 + 6 + 4 + 3);
  assert.deepEqual(r.dice.map((d) => [d.term, d.rolls]), [['2d6', [1, 6]], ['1d4', [4]]]);
  assert.deepEqual(r.parts.map((p) => [p.label, p.value]), [['2d6', 7], ['1d4', 4], ['Bonus', 3]]);
  const m = rollDice('d20 + mod.dex', { resolve: R, randInt: fixed(9) });
  assert.equal(m.total, 13);
  assert.equal(m.nat1 || m.nat20, false);
  const neg = rollDice('1d6 - 1d4 - 1', { randInt: fixed(5, 3) });
  assert.equal(neg.total, 6 - 4 - 1);
  assert.equal(rollDice('D8', { randInt: fixed(7) }).total, 8);
  assert.equal(rollDice('max(1d6, 4)', { randInt: fixed(0) }).total, 4);
  assert.equal(rollDice('(1d6) * 2', { randInt: fixed(2) }).total, 6);
});

test('dice: nat1 / nat20 only for exactly one d20', () => {
  assert.equal(rollDice('d20', { randInt: fixed(19) }).nat20, true);
  assert.equal(rollDice('1d20 + 5', { randInt: fixed(0) }).nat1, true);
  assert.equal(rollDice('2d20', { randInt: fixed(19) }).nat20, false);
  assert.equal(rollDice('d20 + d4', { randInt: fixed(19, 0) }).nat20, false);
  assert.equal(rollDice('d12', { randInt: fixed(0) }).nat1, false);
});

test('dice: default RNG is crypto and stays in range', () => {
  for (let i = 0; i < 300; i++) {
    const r = rollDice('1d6');
    assert.ok(r.total >= 1 && r.total <= 6);
  }
  const seen = new Set();
  for (let i = 0; i < 400; i++) seen.add(rollDice('d4').total);
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4]);
});

test('dice: limits and bad input throw FormulaError', () => {
  for (const src of ['0d6', '101d6', '1d0', '1d1001', '1d6x', '1.5d6', '2d', '60d6 + 60d6 + 60d6 + 60d6', '', 'roll(1d6)']) {
    assert.throws(() => rollDice(src, { randInt: fixed(0) }), FormulaError, src);
  }
  assert.throws(() => rollDice(42), FormulaError);
  const bare = rollDice('d', { randInt: fixed(0) });
  assert.equal(bare.total, 0, 'a bare "d" is just an unknown identifier');
  assert.equal(bare.warnings[0].kind, 'unknown');
  // A broken RNG cannot produce out-of-range dice.
  assert.equal(rollDice('1d6', { randInt: () => 99 }).total, 6);
  assert.equal(rollDice('1d6', { randInt: () => -5 }).total, 1);
});

test('diceText: static damage text', () => {
  const r = (n) => ({ 'mod.str': 3, 'mod.dex': -1, 'buff.damage': 0 })[n];
  assert.equal(diceText('1d6 + mod.str', r).text, '1d6+3');
  assert.equal(diceText('(1d8) + mod.dex', r).text, '1d8-1');
  assert.equal(diceText('2d6 + 1d4 + buff.damage', r).text, '2d6+1d4');
  assert.equal(diceText('mod.str + 2', r).text, '5');
  assert.equal(diceText('max(1d6, 2) + 1', r).text, '(max(1d6, 2))+1');
  assert.equal(diceText('1d6 - 1d4', r).text, '1d6-1d4');
  assert.equal(diceText('1d6 +', r).text, '');
  assert.equal(diceText('1d6 +', r).warnings[0].kind, 'formula');
});

test('objectResolver uses own properties only', () => {
  const res = objectResolver({ a: { b: 2 }, n: 'x' });
  assert.equal(res('a.b'), 2);
  assert.equal(res('a'), undefined);
  assert.equal(res('n'), undefined);
  assert.equal(res('a.constructor'), undefined);
  assert.equal(res('__proto__'), undefined);
});
