import { test } from 'node:test';
import assert from 'node:assert/strict';
import { danger } from '../../web/js/danger.js';

const crawlers = (n, stats = {}) => Array.from({ length: n }, (_, i) => ({ uid: String(i), hp: 10, hpMax: 10, evade: 2, slotValue: 2, ...stats }));
const mob = (overrides = {}) => ({ hp: 5, hpMax: 5, attacks: [{ damage: '1d4' }], ...overrides });

test('healthy crawler bands retain standard-mob ratios for 2, 4 and 6 crawlers', () => {
  for (const size of [2, 4, 6]) {
    const party = crawlers(size);
    for (const [ratio, level, label] of [[0.5, 0, 'Weak'], [1, 1, 'Moderate'], [1.5, 2, 'Strong'], [2, 3, 'Overwhelming']]) {
      const estimate = danger({ party, mobs: [mob({ count: size * ratio })] });
      assert.deepEqual([estimate.label, estimate.level, estimate.visible], [label, level, size * ratio]);
    }
    const standard = danger({ party, mobs: [mob()] });
    const elite = danger({ party, mobs: [mob({ role: 'elite' })] });
    const peers = danger({ party, mobs: [mob({ count: size })] });
    assert.ok(elite.rounds < standard.rounds);
    assert.equal(elite.rounds, peers.rounds, 'elite uses one action per crawler');
    assert.equal(elite.label, peers.label);
  }
});

test('averages whole-slot loss over the dice rather than dividing the mean roll', () => {
  const rules = { flow: 'phases', crit: 'none', drMin: 0 };
  const mobs = [mob({ attacks: [{ toHit: 25, damage: '1d4' }] })];
  const estimate = (dr) => danger({ family: 'dnd', rules, party: crawlers(1, { hp: 2, hpMax: 2, slotValue: 3, dr }), mobs });
  assert.equal(estimate(0).rounds, 5, '3 or 4 on a d4 costs a slot (95% to hit)');
  assert.equal(estimate(1).rounds, 9, 'only 4 on a d4 costs a slot after armor');
  assert.equal(estimate(2).rounds, null);
  assert.equal(estimate(2).reason, 'no-damage');
});

test('reaction forecast uses floor, fixed stat blocks, Evade, typed resistance and area damage', () => {
  const rules = { flow: 'reaction', mobBase: 10, floorScaled: true, drMin: 0 };
  let party = crawlers(2);
  const attackers = [mob({ count: 2, attacks: [{ toHit: 4, damage: '2d4+floor', dtype: 'fire' }] })];
  const estimate = (floor, mobs = attackers) => danger({ rules, party, floor, mobs });
  assert.ok(estimate(4).rounds < estimate(1).rounds);
  const fixed = attackers.map((m) => ({ ...m, flat: true, attacks: [{ toHit: 4, damage: '2d4' }] }));
  assert.equal(estimate(2, fixed).rounds, estimate(1, fixed).rounds, 'the reference avoids Major Fail floor bonus changes');
  const unprotected = estimate(2).rounds;
  party = crawlers(2, { evade: 10 });
  const evasive = estimate(2).rounds;
  assert.ok(evasive > unprotected);
  const area = attackers.map((m) => ({ ...m, attacks: m.attacks.map((a) => ({ ...a, area: true })) }));
  assert.ok(estimate(2, area).rounds < evasive, 'an area can damage a target on successful Evade');
  party = crawlers(2, { protections: { 'resist.fire': { value: 1 } } });
  assert.ok(estimate(2).rounds > unprotected);
  party = crawlers(2, { protections: { 'immune.fire': { value: 1 } } });
  assert.equal(estimate(2).rounds, null);
});

test('hidden living enemies count, loss of health moves the trend, and a fallen crawler sets zero rounds', () => {
  const party = crawlers(4);
  const mobs = [mob({ count: 3 }), mob({ hidden: true, count: 2 }), mob({ hp: 0, hidden: true, count: 5 })];
  const full = danger({ party, mobs });
  assert.deepEqual([full.visible, full.hidden, full.trend], [3, 2, 'steady']);
  const woundedFoes = danger({ party, mobs: [{ ...mobs[0], hp: 2 }, mobs[1]], previousScore: full.score });
  assert.equal(woundedFoes.trend, 'down');
  party[0] = { ...party[0], hp: 2 };
  const woundedParty = danger({ party, mobs, previousScore: full.score });
  assert.equal(woundedParty.trend, 'up');
  assert.ok(woundedParty.rounds < full.rounds);
  party[0] = { ...party[0], dying: 2, hp: 0 };
  const fallen = danger({ party, mobs });
  assert.equal(fallen.rounds, 0);
  assert.equal(fallen.level, 3);
});

test('D&D and PF2e use their family budgets, and forecasts explain absent inputs', () => {
  const party = crawlers(4, { level: 3, hp: 50, hpMax: 50, evade: 14, slotValue: null });
  const read = (family, count) => danger({ family, party, mobs: [mob({ count, cr: 1, level: 3, attacks: [{ damage: '1' }] })] });
  assert.equal(read('dnd', 2).label, 'Moderate');
  assert.equal(read('dnd', 4).label, 'Strong');
  assert.equal(read('pf2e', 2).label, 'Moderate');
  assert.equal(read('pf2e', 3).label, 'Strong');
  for (const [input, reason] of [
    [{ mobs: [mob()] }, 'no-party'],
    [{ party }, 'no-enemies'],
    [{ party, mobs: [mob({ attacks: [] })] }, 'no-damage'],
  ]) {
    const estimate = danger(input);
    assert.deepEqual([estimate.label, estimate.rounds, estimate.reason], ['Weak', null, reason]);
  }
});
