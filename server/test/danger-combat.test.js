import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { createState, normalizeState, reduce, viewFor } from '../state.js';
import { danger } from '../../web/js/danger.js';
import { tmpDir, writePack } from './fixtures.js';

const dir = writePack(tmpDir(), {
  'ruleset.json': {
    id: 'danger-test',
    stats: [{ id: 'con', label: 'Con', parts: ['base'], default: { base: 2 } }],
    statMod: { from: 'base', formula: 'x' },
    tracks: [{ id: 'hp', label: 'Health', kind: 'slots', slots: 10, default: 10, slotValue: 'mod.con' }],
    derived: [{ id: 'evade', label: 'Evade', formula: '11' }, { id: 'dr', label: 'DR', formula: '2' }],
    combat: { flow: 'reaction', drMin: 0, mobBase: 10, floorScaled: true, mobSlotValue: 2 },
  },
  'monsters.json': [
    { id: 'sentinel', name: 'Sentinel', role: 'elite', hpSlots: 10, slotValue: 4, level: 3, cr: '1/2', flat: true,
      attacks: [{ name: 'Claw', dc: 16, dcPlusFloor: true, damage: '1d6+4', dtype: 'fire' }] },
    { id: 'ambush', name: 'Hidden Raider', hpSlots: 8, level: 7, attacks: [{ name: 'Strike', toHit: 10, damage: '16' }] },
  ],
});
const { pack } = loadPack(dir);
let sequence = 0;
const play = (state, a) => reduce(state, { role: 'gm', ...a }, { pack, now: 1_000_000, rng: () => 0.4, genId: (prefix) => `${prefix}_${++sequence}` });
const view = (state, role = 'gm', opts) => viewFor(state, pack, role, opts).combat;

function setup(count) {
  let state = createState(pack, 0);
  const party = [];
  for (let i = 1; i <= count; i++) {
    const update = play(state, { t: 'player.add', name: `Hero ${i}` });
    state = update.state;
    party.push(update.result.playerId);
  }
  return { state, party };
}

function withoutTrend(estimate) {
  const { trend, ...stable } = estimate;
  return stable;
}

test('Prep and Fight draft use the same normalized party and monster data', () => {
  let { state, party } = setup(4);
  state = play(state, { t: 'player.update', playerId: party[0], level: 5 }).state;
  state = play(state, { t: 'crawlers.set', floor: 3 }).state;
  const before = view(state);
  assert.equal(before.active, false);
  assert.equal(before.dangerFloor, 3);
  assert.deepEqual([before.dangerParty[0].level, before.dangerParty[0].hp, before.dangerParty[0].slotValue,
    before.dangerParty[0].evade, before.dangerParty[0].dr], [5, 10, 2, 11, 2]);
  const source = pack.library.monster.find((e) => e.id === 'sentinel');
  assert.equal(source.cr, 0.5);
  const planned = danger({ family: before.dangerRules.family, rules: before.dangerRules, floor: before.dangerFloor,
    party: before.dangerParty, mobs: [{ ...source, count: 2, hp: source.hpSlots, hpMax: source.hpSlots, hidden: true }] });
  const placed = play(state, { t: 'combat.addMob', sourceId: 'sentinel', count: 2 });
  const draft = view(placed.state);
  assert.deepEqual(withoutTrend(draft.danger), withoutTrend(planned));
  assert.deepEqual([draft.combatants[0].level, draft.combatants[0].cr, draft.combatants[0].attacks[0].dc], [3, 0.5, 16]);
  const live = play(placed.state, { t: 'combat.start' }).state;
  assert.deepEqual(withoutTrend(view(live).danger), withoutTrend(planned));
});

test('danger trends survive reconnect; hidden waves do not affect the stage meter', () => {
  let { state, party } = setup(2);
  state = play(state, { t: 'combat.addMob', sourceId: 'sentinel', hidden: false }).state;
  state = play(state, { t: 'combat.start' }).state;
  assert.equal(view(state).showThreat, false);
  assert.equal(view(state, 'stage').threatMeter, undefined);
  assert.throws(() => play(state, { t: 'combat.set', settings: { showThreat: 'true' } }), /must be a boolean/);
  state = play(state, { t: 'combat.set', settings: { showThreat: true } }).state;
  const before = view(state, 'stage').threatMeter;
  assert.deepEqual(Object.keys(before).sort(), ['label', 'level', 'trend']);
  assert.equal(view(state, 'player', { playerId: party[0] }).threatMeter, undefined);
  assert.equal(view(state, 'player', { playerId: party[0] }).danger, undefined);
  assert.equal(view(state, 'stage').dangerParty, undefined);

  state = play(state, { t: 'combat.addMob', sourceId: 'ambush', count: 2 }).state;
  const active = view(state).danger;
  assert.equal(active.hidden, 2);
  assert.equal(active.visible, 1);
  assert.equal(active.trend, 'up');
  assert.deepEqual(view(state, 'stage').threatMeter, before);

  const unchanged = play(state, { t: 'msg.send', to: 'all', text: 'Stand by' }).state;
  assert.deepEqual(unchanged.combat.dangerState, state.combat.dangerState);
  const restored = normalizeState(JSON.parse(JSON.stringify(unchanged)), pack);
  assert.deepEqual(view(restored).danger, active);
  assert.equal(view(restored).showThreat, true);
  assert.deepEqual(view(restored, 'stage').threatMeter, before);

  const next = play(restored, { t: 'rx.round' }).state;
  assert.equal(view(next).danger.trend, 'steady');
  const revealing = play(next, { t: 'combat.reveal', all: true }).state;
  assert.equal(view(revealing, 'stage').threatMeter.trend, 'up');
  const disabled = play(revealing, { t: 'combat.set', showThreat: false }).state;
  assert.equal(view(disabled, 'stage').threatMeter, undefined);
});

test('Fight uses the active roster and sheet damage while Prep keeps the campaign party', () => {
  let { state, party } = setup(2);
  state = play(state, { t: 'combat.addMob', sourceId: 'ambush', hidden: false }).state;
  state = play(state, { t: 'combat.start' }).state;
  const bench = view(state);
  const removed = bench.combatants.find((x) => x.playerId === party[1]);
  state = play(state, { t: 'combat.remove', uid: removed.uid }).state;
  assert.equal(view(state).dangerParty.length, 2);
  assert.equal(view(state).danger.trend, 'up');
  state = play(state, { t: 'track.set', playerId: party[0], track: 'hp', cur: 0 }).state;
  assert.equal(view(state).danger.rounds, 0);
  state = play(state, { t: 'crawlers.collapse', floor: 2, announce: false }).state;
  assert.equal(view(state).dangerFloor, 2);
});
