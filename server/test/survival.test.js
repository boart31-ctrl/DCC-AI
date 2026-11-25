import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { createState, reduce, viewFor } from '../state.js';
import { tmpDir, writePack } from './fixtures.js';

const RULESET = {
  id: 'surv', dice: 'd20',
  stats: [{ id: 'str', label: 'Strength', parts: ['base'], default: { base: 3 } }, { id: 'con', label: 'Constitution', parts: ['base'], default: { base: 3 } },
    { id: 'cha', label: 'Charisma', parts: ['base'], default: { base: 3 } }],
  statMod: { from: 'base', formula: 'x' },
  fields: [{ id: 'armor', label: 'Armor', type: 'number', default: 1 }, { id: 'junk', label: 'Misc. Junk', type: 'number', default: 0 },
    { id: 'popularityScore', label: 'Popularity', type: 'number', default: 0 }],
  tracks: [{ id: 'hp', label: 'Health', kind: 'slots', slots: 10, default: 10, slotValue: 'mod.con' }],
  derived: [{ id: 'dr', label: 'DR', formula: 'field.armor' }],
  combat: { degreeScale: 'seven' },
  skills: { check: { roll: 'd20', formula: 'skill.rank + mod.{stat}' }, untrained: { adv: 'dis', formula: 'mod.{stat}' } },
  hazards: { fall: { perFeet: 10, die: 6, maxDice: 20, dtype: 'bludgeoning', prone: 'down' }, starve: { slots: 3, fatigue: 'tired', skill: 'survival' } },
  crafting: { junkField: 'junk', commonCost: 1, skills: ['fabricate'], sizes: [{ label: 'Tiny', junk: 1 }, { label: 'Small', junk: 4 }],
    salvage: [{ min: 1, max: 2, share: 1, label: 'all' }, { min: 3, max: 9, share: 0.5, label: 'half' }, { min: 10, share: 0, label: 'none' }] },
  popularity: { field: 'popularityScore', fromFloor: 2, gains: [{ id: 'odd', label: 'Odd weapon' }, { id: 'cha10', label: 'Cha 10+', auto: { stat: 'cha', min: 10 } }],
    losses: [{ id: 'cha5', label: 'Cha 5 or less', auto: { stat: 'cha', max: 5 } }, { id: 'late', label: 'Ground late', auto: 'grindLate' }, { id: 'boring', label: 'Boring' }],
    grindLate: { hours: 15, window: 30 } },
};

function setup(face = 10) {
  const { pack } = loadPack(writePack(tmpDir(), {
    'ruleset.json': RULESET,
    'skills.json': [{ id: 'survival', name: 'Survival', stat: 'con', checkType: 'Unopposed' }, { id: 'fabricate', name: 'Fabricate', stat: 'str', checkType: 'Unopposed' }],
    'buffs.json': [{ id: 'down', name: 'Take Down', effects: [] }, { id: 'tired', name: 'Fatigued', stackable: true, effects: [{ target: 'check', op: 'add', value: -1, when: 'active', label: 'Fatigued' }] }],
  }));
  let n = 0;
  const ctx = { pack, now: 1000, genId: (p) => `${p}_${++n}`, dieInt: () => face - 1 };
  let state = createState(pack, 0);
  const gm = (a) => { const r = reduce(state, { role: 'gm', ...a }, ctx); state = r.state; return r.result; };
  const hp = (i = 0) => state.players[i].sheet.tracks.hp.cur;
  return { pack, gm, hp, ctx, get state() { return state; }, view: () => viewFor(state, pack, 'gm', { now: 0 }).gm };
}

test('hazards: falling = d6 per 10 ft minus DR in whole slots + prone; thirst; hunger with a Survival check', () => {
  const g = setup(4); // every die shows 4
  const a = g.gm({ t: 'player.add', name: 'Carl' }).playerId;
  const b = g.gm({ t: 'player.add', name: 'Donut' }).playerId;
  const fall = g.gm({ t: 'hazard.apply', kind: 'fall', playerIds: [a], feet: 25 }).results[0];
  assert.equal(fall.dice, '2d6');
  assert.deepEqual([fall.rolled, fall.dr, fall.afterDr, fall.slots], [8, 1, 7, 2], '8 − DR 1 = 7 → 2 slots of 3');
  assert.equal(g.hp(), 8);
  assert.ok(fall.prone && g.state.players[0].sheet.buffs.some((x) => x.buffId === 'down'));
  assert.equal(g.gm({ t: 'hazard.apply', kind: 'fall', playerIds: [a], feet: 400, rolled: { [a]: 20 } }).results[0].dice, '20d6', 'max 20 dice');
  assert.throws(() => g.gm({ t: 'hazard.apply', kind: 'fall', playerIds: [a], feet: 20, rolled: { [a]: 13 } }), /2\.\.12/);
  const thirst = g.gm({ t: 'hazard.apply', kind: 'thirst', playerIds: [b] }).results[0];
  assert.deepEqual([thirst.slots, thirst.hp, thirst.fatigued], [3, 7, true]);
  // Hunger: d20 4 + untrained Con 3 = 7 vs DC 12 → fail; the GM can also say who failed.
  const hunger = g.gm({ t: 'hazard.apply', kind: 'hunger', playerIds: [b] }).results[0];
  assert.equal(hunger.passed, false);
  assert.equal(g.state.players[1].sheet.buffs.find((x) => x.buffId === 'tired').stacks, 2);
  const told = g.gm({ t: 'hazard.apply', kind: 'hunger', playerIds: [a, b], failed: [] }).results;
  assert.ok(told.every((r) => r.passed));
});

test('crafting: common item for 1 junk; craft by size, hours = size², salvage on a fail; clock advances', () => {
  const g = setup(15);
  const a = g.gm({ t: 'player.add', name: 'Carl' }).playerId;
  g.gm({ t: 'skill.add', playerId: a, skillId: 'fabricate', rank: 1 });
  g.gm({ t: 'sheet.set', playerId: a, path: 'fields.junk', value: 6 });
  g.gm({ t: 'crawlers.clock', hours: 100 });
  const c = g.gm({ t: 'craft.run', playerId: a, common: true, name: 'Egg beater' });
  assert.equal(c.junk, 5);
  assert.ok(g.state.players[0].inventory.some((i) => i.name === 'Egg beater' && i.custom));
  assert.equal(g.view().playersFull[0].inventory.find((i) => i.name === 'Egg beater').missing, undefined, 'a crafted item is not a broken library link');
  const ok = g.gm({ t: 'craft.run', playerId: a, size: 1, skill: 'fabricate', name: 'Gas mask' });
  assert.deepEqual([ok.success, ok.hours, ok.cost, ok.junk], [true, 4, 4, 1], '15 + 1 + 3 = 19 vs 12');
  assert.equal(g.state.crawlers.clock.hours, 96);
  assert.throws(() => g.gm({ t: 'craft.run', playerId: a, size: 1, skill: 'fabricate', name: 'Ladder' }), /needs 4 Misc. Junk/);
  g.gm({ t: 'sheet.set', playerId: a, path: 'fields.junk', value: 4 });
  const bad = g.gm({ t: 'craft.run', playerId: a, size: 1, skill: 'fabricate', name: 'Ladder', entered: 4 });
  assert.deepEqual([bad.success, bad.refund, bad.junk, bad.salvage], [false, 2, 2, 'half'], '4 + 4 = 8, missed 12 by 4 → half back');
});

test('popularity: from floor 2, gains once per floor, end-of-floor review with automatic reasons', () => {
  const g = setup(10);
  const a = g.gm({ t: 'player.add', name: 'Carl' }).playerId;
  const b = g.gm({ t: 'player.add', name: 'Donut' }).playerId;
  assert.throws(() => g.gm({ t: 'popularity.award', playerId: a, id: 'odd' }), /starts on floor 2/);
  g.gm({ t: 'crawlers.set', floor: 2 });
  g.gm({ t: 'popularity.award', playerId: a, id: 'odd' });
  assert.throws(() => g.gm({ t: 'popularity.award', playerId: a, id: 'odd' }), /already/);
  g.gm({ t: 'sheet.set', playerId: b, path: 'stats.cha.base', value: 12 });
  const v = g.view().popularity;
  assert.deepEqual(v.crawlers[a].autoLosses, ['cha5']);
  assert.deepEqual(v.crawlers[b].autoGains, ['cha10']);
  const r = g.gm({ t: 'popularity.review', losses: { [a]: ['cha5', 'boring'], [b]: [] } }).results;
  assert.deepEqual(r.map((x) => [x.from, x.to]), [[1, -1], [0, 1]], 'Carl +1 −2, Donut gets the automatic Cha 10 gain');
  g.gm({ t: 'popularity.adjust', playerId: b, delta: 3 });
  assert.equal(g.state.players[1].sheet.fields.popularityScore, 4);
});
