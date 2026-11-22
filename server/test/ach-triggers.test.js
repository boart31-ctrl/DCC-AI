import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTrigger, suggestAchievements } from '../ach-triggers.js';
import { loadPack } from '../pack.js';
import { createState, reduce, viewFor } from '../state.js';
import { tmpDir, writePack } from './fixtures.js';

const ev = (e) => ({ event: e, to: 'all' });

test('triggers: normalize, match moments, count, streaks, kills in a round, first down — suggested once, never awarded by itself', () => {
  assert.equal(normalizeTrigger({ on: 'teleport' }), null);
  assert.deepEqual(normalizeTrigger({ on: 'roll', nat: 1, streak: 2, junk: 1 }), { on: 'roll', nat: 1, streak: 2 });
  const achievements = [
    { id: 'rock_bottom', title: 'Rock Bottom', trigger: { on: 'roll', nat: 1, streak: 2 } },
    { id: 'bulk', title: 'Bulk Discount', trigger: { on: 'kill', inRound: 3 } },
    { id: 'matrix', title: 'Matrix', trigger: { on: 'evade', deg: 'crit' } },
    { id: 'first_out', title: 'First One Out', trigger: { on: 'down', partyFirst: true } },
    { id: 'tenth', title: 'Ten Hits', trigger: { on: 'roll', what: 'attack', hit: true, count: 10 } },
  ];
  const st = { players: [{ id: 'p1', name: 'Carl', achievements: [] }, { id: 'p2', name: 'Donut', achievements: [] }],
    combat: { active: true, round: 1, combatants: [{ uid: 'm1', killedBy: 'p1' }, { uid: 'm2', killedBy: 'p1' }, { uid: 'm3', killedBy: 'p1' }] } };
  let n = 0;
  const ctx = { pack: { achievements }, now: 5, genId: (p) => `${p}${++n}` };
  const run = (...events) => { const out = { events: events.map(ev), emit: () => {} }; suggestAchievements(st, ctx, out); };
  run({ kind: 'roll', by: 'p1', natural: 1, what: { kind: 'check' } });
  run({ kind: 'roll', by: 'p1', natural: 7, what: { kind: 'check' } });
  run({ kind: 'roll', by: 'p1', natural: 1, what: { kind: 'check' } });
  assert.equal((st.achSuggestions ?? []).length, 0, 'a roll between breaks the streak');
  run({ kind: 'roll', by: 'p1', natural: 1, what: { kind: 'check' } });
  assert.deepEqual(st.achSuggestions.map((s) => s.achId), ['rock_bottom']);
  run({ kind: 'combat.hit', type: 'mob', uid: 'm1', down: true }, { kind: 'combat.hit', type: 'mob', uid: 'm2', down: true });
  assert.ok(!st.achSuggestions.some((s) => s.achId === 'bulk'));
  run({ kind: 'combat.hit', type: 'mob', uid: 'm3', down: true });
  assert.ok(st.achSuggestions.some((s) => s.achId === 'bulk' && s.playerId === 'p1'));
  run({ kind: 'rx.evade', playerId: 'p2', degree: 'crit' });
  run({ kind: 'rx.evade', playerId: 'p2', degree: 'crit' });
  assert.equal(st.achSuggestions.filter((s) => s.achId === 'matrix').length, 1, 'suggested once');
  run({ kind: 'combat.hit', type: 'crawler', playerId: 'p2', down: true });
  run({ kind: 'combat.hit', type: 'crawler', playerId: 'p1', down: true });
  assert.deepEqual(st.achSuggestions.filter((s) => s.achId === 'first_out').map((s) => s.playerId), ['p2']);
  assert.equal(st.players[0].achievements.length, 0, 'nothing awarded by itself');
  assert.ok(st.achRecent.length > 0);
});

test('reducer: a box opened → "first box" suggested → Award gives it; Never stops it for that crawler; switch off', () => {
  const { pack } = loadPack(writePack(tmpDir(), {
    'pack.json': { id: 't', name: 'T', lootTiers: [{ id: 'bronze', name: 'Bronze Box' }] },
    'items.json': [{ id: 'spoon', name: 'Spoon', rarity: 'common' }],
    'loot.json': { bronze: [{ item: 'spoon', weight: 1 }] },
    'achievements.json': [{ id: 'first_box', title: 'Unboxing Video', trigger: { on: 'loot' } }, { id: 'jackpot', title: 'Jackpot', trigger: { on: 'loot', rarity: 'legendary' } }],
  }));
  let n = 0;
  const ctx = { pack, now: 1, rng: () => 0.3, genId: (p) => `${p}_${++n}` };
  let state = createState(pack, 0);
  const add = reduce(state, { role: 'gm', t: 'player.add', name: 'Carl' }, ctx);
  state = add.state;
  const pid = add.result.playerId;
  const step = (a) => { const r = reduce(state, { role: 'gm', ...a }, ctx); state = r.state; return r; };
  step({ t: 'loot.box', playerId: pid, tier: 'bronze', itemIds: ['spoon'] });
  const gmv = viewFor(state, pack, 'gm', ctx).gm;
  assert.deepEqual(gmv.achSuggestions.map((s) => s.achId), ['first_box']);
  assert.equal(gmv.achievementsCatalog.find((a) => a.id === 'first_box').on, 'loot');
  step({ t: 'ach.suggest.award', id: gmv.achSuggestions[0].id });
  assert.equal(state.players[0].achievements[0].achId, 'first_box');
  assert.equal(state.achSuggestions.length, 0);
  step({ t: 'ach.settings', suggest: false });
  step({ t: 'loot.box', playerId: pid, tier: 'bronze', itemIds: ['spoon'] });
  assert.equal(state.achSuggestions.length, 0, 'switched off');
});
