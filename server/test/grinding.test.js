import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { createState, reduce, viewFor } from '../state.js';
import { tmpDir, writePack } from './fixtures.js';

const RULESET = {
  id: 'grind', stats: [{ id: 'con', label: 'Constitution', parts: ['base'], default: { base: 3 } }],
  statMod: { from: 'base', formula: 'x' },
  skills: { rankMax: 15, check: { roll: 'd20', formula: 'skill.rank + mod.{stat} + buff.check' }, rankUp: { roll: 'd20', rule: 'gte', target: 'rank', amount: 1 } },
  grinding: { safeHours: 5, dayHours: 30, maxHours: 12, dc: { base: 10, perFloor: 2 }, fatigue: 'tired', bonusMinHours: 5,
    mapBonus: { neighborhood: 1, borough: 2 }, complicationTable: 'grind_t', lowestBonusDie: 2 },
  levels: { boss: { 'Neighborhood Boss': 1, 'Floor Boss': 6 }, crawlerKill: { die: 6, min: 1, max: 15 } },
};

function setup(rollInt = () => 19) {
  const { pack } = loadPack(writePack(tmpDir(), {
    'ruleset.json': RULESET,
    'buffs.json': [{ id: 'tired', name: 'Tired', stackable: true, effects: [{ target: 'check', op: 'add', value: -1, when: 'active', label: 'Tired' }] }],
    'tables.json': { tables: [{ id: 'grind_t', name: 'Grind trouble', rows: ['A rival party shows up.', 'Nothing happens.'] }] },
    'monsters.json': [{ id: 'rival', name: 'Rival', hpSlots: 1, evade: 1, level: 9, tags: ['crawler'], attacks: [] }],
    'bosses.json': [{ id: 'chief', name: 'Chief', rank: 'Neighborhood Boss', hpSlots: 1, evade: 1, attacks: [] }],
  }));
  let n = 0;
  const ctx = { pack, now: 1000, rollInt, genId: (p) => `${p}_${++n}` };
  // Fixed dice only after the players exist (PIN generation needs varied numbers).
  const fix = () => { ctx.randInt = (k) => Math.min(k - 1, rollInt()); };
  let state = createState(pack, 0);
  const act = (a) => { const r = reduce(state, { role: 'gm', ...a }, ctx); state = r.state; return r; };
  return { pack, act, fix, get state() { return state; } };
}

test('grind.run: hours to skills by rank, advancement roll, level from the running total, clock advances', () => {
  const g = setup(() => 19); // every d20 = 20
  const a = g.act({ t: 'player.add', name: 'Carl' }).result.playerId;
  const b = g.act({ t: 'player.add', name: 'Donut' }).result.playerId;
  const s1 = g.act({ t: 'skill.add', playerId: a, name: 'Punch', rank: 2 }).result.uid;
  const s2 = g.act({ t: 'skill.add', playerId: a, name: 'Run', rank: 3 }).result.uid;
  g.act({ t: 'crawlers.clock', hours: 150 });
  g.fix();
  const r = g.act({ t: 'grind.run', hours: 4, crawlers: [{ playerId: a, skills: [s1, s2] }, { playerId: b }] }).result;
  const carl = r.crawlers.find((c) => c.playerId === a);
  assert.equal(carl.earned, 4);
  assert.equal(carl.overtime, 0);
  assert.deepEqual(carl.skills.map((x) => [x.name, x.hours, x.success ?? null, x.to ?? null, x.banked ?? null]),
    [['Punch', 2, true, 3, null], ['Run', 2, null, null, 2]], 'Punch needs 2 h and rolls, Run banks the rest');
  assert.equal(carl.levelFrom, 1);
  assert.equal(carl.levelTo, 2, 'level 1 needs 1 grinding hour');
  assert.equal(g.state.players[0].level, 2);
  assert.ok(r.complication?.text, 'one complication roll');
  assert.equal(g.state.crawlers.clock.hours, 146);
  // Same in-game day: both skills were ground today.
  const again = g.act({ t: 'grind.run', hours: 3, crawlers: [{ playerId: a, skills: [s2, s1], fails: 2 }] }).result.crawlers[0];
  assert.equal(again.overtime, 2, '4 + 3 h on one day = 2 h past the safe 5');
  assert.equal(again.earned, 1);
  assert.deepEqual(again.skills.map((x) => x.skipped), ['already ground today', 'already ground today']);
  assert.ok(again.fatigued);
  assert.equal(g.state.players[0].sheet.buffs.find((x) => x.buffId === 'tired').stacks, 2, 'one fatigue level per failed hour');
  const sk = viewFor(g.state, g.pack, 'gm', { now: 0 }).gm.playersFull[0].sheet.computed.skills.find((x) => x.uid === s1);
  assert.ok(sk.total.parts.flatMap((x) => [x, ...(x.parts ?? [])]).some((x) => x.value === -2 && /×2/.test(x.label)), 'stacked penalty counts twice');
  g.act({ t: 'buff.remove', playerId: a, uid: g.state.players[0].sheet.buffs.find((x) => x.buffId === 'tired').uid, one: true });
  assert.equal(g.state.players[0].sheet.buffs.find((x) => x.buffId === 'tired').stacks, 1);
  const auto = g.act({ t: 'grind.run', hours: 1, complication: false, crawlers: [{ playerId: b }] }).result.crawlers[0];
  assert.equal(auto.overtime, 0, 'Donut ground 4 h today');
  const late = g.act({ t: 'grind.run', hours: 2, complication: false, crawlers: [{ playerId: b }] }).result.crawlers[0];
  assert.deepEqual([late.overtime, late.fails], [2, 0], 'digital Endurance checks, nat 20s pass');
  const view = viewFor(g.state, g.pack, 'gm', { now: 0 }).gm.grinding;
  assert.equal(view.crawlers[a].skills[s2], 2, 'Run keeps its banked hours');
});

test('grind.run: map bonus from 5 h, lowest-level crawler alone rolls the bonus die, guards', () => {
  const g = setup(() => 1); // d2 → 2
  const a = g.act({ t: 'player.add', name: 'Carl' }).result.playerId;
  const b = g.act({ t: 'player.add', name: 'Donut' }).result.playerId;
  g.act({ t: 'player.update', playerId: a, level: 3 });
  g.fix();
  const r = g.act({ t: 'grind.run', hours: 5, map: 'borough', complication: false, crawlers: [{ playerId: a }, { playerId: b }] }).result;
  assert.equal(r.crawlers[0].earned, 7);
  assert.equal(r.crawlers[0].levelTo, 4);
  assert.equal(r.crawlers[1].levelTo, 3, 'Donut is the only lowest: 1 + 1d2');
  assert.equal(r.complication, null);
  assert.throws(() => g.act({ t: 'grind.run', hours: 13, crawlers: [{ playerId: a }] }), /hours must be/);
  assert.throws(() => g.act({ t: 'grind.run', hours: 1, map: 'atlas', crawlers: [{ playerId: a }] }), /map bonus/);
  assert.throws(() => g.act({ t: 'grind.run', hours: 1, crawlers: [{ playerId: a }, { playerId: a }] }), /twice/);
  assert.throws(() => g.act({ t: 'grind.run', hours: 6, crawlers: [{ playerId: a, fails: 7 }] }), /fails/);
});

test('level hints: boss rank and crawler kill suggest levels, the GM applies or dismisses', () => {
  const g = setup(() => 2); // d6 → 3
  const a = g.act({ t: 'player.add', name: 'Carl' }).result.playerId;
  g.act({ t: 'player.add', name: 'Donut' });
  g.act({ t: 'player.update', playerId: a, level: 4 });
  g.fix();
  g.act({ t: 'combat.addMob', sourceId: 'rival', kind: 'monster' });
  g.act({ t: 'combat.addMob', sourceId: 'chief', kind: 'boss' });
  g.act({ t: 'combat.start' });
  for (const m of g.state.combat.combatants.filter((x) => x.type === 'mob')) g.act({ t: 'combat.damage', uid: m.uid, amount: 99, by: a });
  g.act({ t: 'combat.end', outcome: 'victory' });
  const hints = viewFor(g.state, g.pack, 'gm', { now: 0 }).gm.levelHints;
  const pk = hints.find((h) => h.kind === 'crawlerKill');
  assert.equal(pk.delta, 8, 'd6 3 + level gap 5');
  assert.deepEqual(pk.playerIds, [a]);
  const boss = hints.find((h) => h.kind === 'boss');
  assert.equal(boss.delta, 1);
  assert.equal(g.state.players[0].level, 4, 'nothing applied by itself');
  const ap = g.act({ t: 'level.hint.apply', id: pk.id });
  assert.equal(g.state.players[0].level, 12);
  assert.ok(ap.events.some(({ event: e }) => e.kind === 'levelup'));
  g.act({ t: 'level.hint.dismiss', id: boss.id });
  assert.equal(viewFor(g.state, g.pack, 'gm', { now: 0 }).gm.levelHints.length, 0);
  assert.throws(() => g.act({ t: 'level.hint.apply', id: boss.id }), /gone/);
});
