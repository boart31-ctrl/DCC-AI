// Floor-scaled crawler rules: step() lookup tables, mob Evade / attack difficulty as "base + floor",
// ruleset fields kept through normalization, the world floor (crawlers.js) feeding the numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, validateFormula } from '../formula.js';
import { combatRules, mobDefense, mobAttackDc, floorOfState } from '../outcome.js';
import { normalizeRuleset } from '../ruleset.js';

const TABLE = 'step(x, 1, 3, 6, 10, 20, 50, 100, 150, 200, 300)';

test('step(): the stat-mod lookup table of the crawler book', () => {
  const mod = (x) => evaluate(TABLE, (n) => (n === 'x' ? x : 0)).value;
  assert.deepEqual([1, 2, 3, 5, 6, 9, 10, 19, 20, 49, 50, 99, 100, 149, 150, 199, 200, 299, 300, 1000].map(mod),
    [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10]);
  assert.equal(mod(0), 0);
  assert.match(validateFormula('step(x)'), /step\(\) takes 2/, 'needs at least one threshold');
});

test('mob numbers: base + floor when the ruleset is floor-scaled, unchanged otherwise', () => {
  const pack = (combat) => ({ ruleset: { system: { family: 'crawler' }, combat } });
  const plain = combatRules(pack({}));
  assert.equal(mobDefense(plain, 3, 4), 3, 'legacy packs: Evade is the target');
  assert.equal(mobAttackDc(plain, { toHit: 3 }, 4), 13);
  const book = combatRules(pack({ mobBase: 10, floorScaled: true }));
  assert.equal(mobDefense(book, 3, 1), 14, '10 + Dex + F on floor 1');
  assert.equal(mobDefense(book, 3, 4), 17, 'same mob on floor 4');
  assert.equal(mobAttackDc(book, { toHit: 2 }, 2), 14);
  assert.equal(mobAttackDc(book, { dc: 15 }, 3), 15, 'an absolute dc stays as written');
  assert.equal(mobAttackDc(book, { dc: 12, dcPlusFloor: true }, 3), 15, '"12+F" written as dc 12 + dcPlusFloor');
  assert.equal(floorOfState({ crawlers: { floor: 3 } }), 3);
  assert.equal(floorOfState({}), 1);
});

test('ruleset keeps mobBase, floorScaled and flow', () => {
  const r = normalizeRuleset({ stats: [{ id: 'dex', label: 'Dex' }], derived: [{ id: 'evade', label: 'Evade', formula: 'mod.dex' }], combat: { mobBase: 10, floorScaled: true, flow: 'reaction' } });
  assert.equal(r.combat.mobBase, 10);
  assert.equal(r.combat.floorScaled, true);
  assert.equal(r.combat.flow, 'reaction');
  const d = normalizeRuleset({ stats: [{ id: 'dex', label: 'Dex' }], combat: { mobBase: 99, flow: 'x' } });
  assert.equal(d.combat.mobBase, 0);
  assert.equal(d.combat.flow, 'phases');
});

import { damageToSlots, mobSlotValue } from '../outcome.js';
import { loadPack } from '../pack.js';
import { createState, reduce } from '../state.js';
import { tmpDir, writePack, seq } from './fixtures.js';

test('slot health: rolled damage removes whole slots, less than one slot is lost (book example: 14 vs 3 = 4 slots)', () => {
  assert.equal(damageToSlots(14, 3), 4);
  assert.equal(damageToSlots(2, 3), 0);
  assert.equal(damageToSlots(5, 1), 5);
  assert.equal(mobSlotValue({ ruleset: { combat: { mobSlotValue: 2 } } }, {}), 2);
  assert.equal(mobSlotValue({ ruleset: { combat: { mobSlotValue: 2 } } }, { slotValue: 4 }), 4);
  assert.equal(mobSlotValue({ ruleset: { combat: {} } }, {}), 1);
  const { pack } = loadPack(writePack(tmpDir()));
  let n = 0;
  const ctx = () => ({ now: 1000, rng: seq(0.5), genId: (p) => `${p}_${++n}`, pack });
  let s = createState(pack, 0);
  s = reduce(s, { role: 'gm', t: 'combat.start' }, ctx()).state;
  s = reduce(s, { role: 'gm', t: 'combat.addAdhoc', name: 'Ogre', hp: 6, slotValue: 3, hidden: false }, ctx()).state;
  const uid = s.combat.combatants.find((x) => x.name === 'Ogre').uid;
  let r = reduce(s, { role: 'gm', t: 'combat.damage', uid, amount: 2, dr: true }, ctx());
  assert.equal(r.result.belowSlot, true);
  r = reduce(s, { role: 'gm', t: 'combat.damage', uid, amount: 14, dr: true }, ctx());
  assert.equal(r.state.combat.combatants.find((x) => x.uid === uid).hp, 2, '6 slots − 4');
  r = reduce(s, { role: 'gm', t: 'combat.damage', uid, amount: 2 }, ctx());
  assert.equal(r.state.combat.combatants.find((x) => x.uid === uid).hp, 4, 'the GM\'s −2 button stays in slots');
});
