import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { createState, normalizeState, reduce, reducePlayerAction, viewFor } from '../state.js';
import { tmpDir, writePack } from './fixtures.js';

const { pack } = loadPack(writePack(tmpDir(), {
  'ruleset.json': {
    id: 'held', dice: 'd20',
    stats: [{ id: 'dex', label: 'Dexterity', parts: ['base'], default: { base: 2 } }, { id: 'int', label: 'Intelligence', parts: ['base'], default: { base: 3 } }],
    statMod: { from: 'base', formula: 'x' },
    fields: [{ id: 'aiFavor', label: 'AI Favor', type: 'number', default: 1 }],
    combat: { degreeScale: 'seven' },
    skills: { check: { roll: 'd20', formula: 'skill.rank + mod.{stat}' }, untrained: { adv: 'dis', formula: 'mod.{stat}' }, usedTracking: true },
  },
  'skills.json': [{ id: 'sneak', name: 'Sneak', stat: 'dex', checkType: 'Opposed' }, { id: 'climb', name: 'Climb', stat: 'dex', checkType: 'Unopposed' }],
  'monsters.json': [{ id: 'guard', name: 'Guard', hpSlots: 2, stats: { int: { score: 4, mod: 3 }, dex: { score: 2, mod: 1 } } }, { id: 'blob', name: 'Blob', hpSlots: 2 }],
}));

function setup() {
  let state = createState(pack, 0);
  let n = 0;
  const dice = [];
  const ctx = { pack, now: 1000, genId: (p) => `${p}_${++n}`, dieInt: (sides) => (dice.length ? dice.shift() - 1 : sides - 1) };
  const commit = (r) => { state = r.state; return r; };
  const gm = (a) => commit(reduce(state, { role: 'gm', ...a }, ctx)).result;
  const player = (playerId, a) => commit(reducePlayerAction(state, a, { ...ctx, playerId })).result;
  const view = (role, playerId) => viewFor(state, pack, role, { ...ctx, playerId });
  return { gm, player, view, dice, state: () => state, set: (s) => { state = s; } };
}

test('held show check: DC from the floor rule, nothing public until the GM reveals', () => {
  const { gm, view, dice, state } = setup();
  const a = gm({ t: 'player.add', name: 'Ann' }).playerId;
  const b = gm({ t: 'player.add', name: 'Bo' }).playerId;
  gm({ t: 'skill.add', playerId: a, skillId: 'climb', rank: 2 });
  gm({ t: 'crawlers.set', floor: 2 });
  const start = gm({ t: 'scene.check.start', mode: 'party', skillId: 'climb', dcType: 'unopposed', playerIds: [a, b], dice: 'physical', entered: { [a]: 11 } });
  assert.equal(start.dc, 14, 'unopposed = 10 + 2 × floor');
  const tv = view('stage').scene.data;
  assert.equal(tv.pending, true);
  assert.equal(tv.dc, undefined, 'the TV never gets the hidden DC');
  assert.deepEqual(tv.people.map((p) => p.ready), [true, false]);
  assert.equal(state().rolls.length, 0, 'no dice-log entry before the reveal');
  const g = view('gm').gm.showCheck;
  assert.equal(g.entries[0].total, 15);
  assert.equal(g.entries[0].degree, 'success');
  assert.equal(g.entries[1].advantage, 'dis', 'untrained = Disadvantage');
  dice.push(9, 4);
  gm({ t: 'scene.check.enter', playerId: b });
  assert.equal(view('gm').gm.showCheck.entries[1].die, 4, 'app rolls the kept lower die');
  gm({ t: 'scene.check.reveal' });
  const shown = view('stage').scene.data;
  assert.equal(shown.pending, undefined);
  assert.equal(shown.hideDc, true);
  assert.equal(shown.dc, undefined);
  assert.deepEqual(shown.check.results.map((r) => [r.total, r.degree]), [[15, 'success'], [6, 'fail']]);
  assert.equal(state().rolls.length, 2);
  assert.equal(view('gm').gm.showCheck.revealed, true);
  assert.throws(() => gm({ t: 'scene.check.reveal' }), /already on the TV/);
});

test('opposed DC reads the antagonist stat block; fixed and stat rules; showDc', () => {
  const { gm, view } = setup();
  const a = gm({ t: 'player.add', name: 'Ann' }).playerId;
  gm({ t: 'crawlers.set', floor: 3 });
  assert.equal(gm({ t: 'scene.check.start', mode: 'single', skillId: 'sneak', dcType: 'opposed', against: { kind: 'monster', id: 'guard', stat: 'int' }, playerIds: [a], dice: 'phone' }).dc, 16);
  assert.equal(view('gm').gm.showCheck.against.name, 'Guard');
  assert.throws(() => gm({ t: 'scene.check.start', mode: 'single', skillId: 'sneak', dcType: 'opposed', against: { kind: 'monster', id: 'blob', stat: 'int' }, playerIds: [a], dice: 'phone' }), /type the modifier/);
  assert.equal(gm({ t: 'scene.check.start', mode: 'single', skillId: 'sneak', dcType: 'opposed', mod: 4, playerIds: [a], dice: 'phone' }).dc, 17);
  assert.equal(gm({ t: 'scene.check.start', mode: 'single', statId: 'dex', dcType: 'stat', playerIds: [a], dice: 'phone', showDc: true }).dc, 13);
  assert.equal(view('stage').scene.data.dc, 13);
  assert.equal(gm({ t: 'scene.check.start', mode: 'single', statId: 'dex', dcType: 'fixed', dc: 9, playerIds: [a], dice: 'phone' }).dc, 9);
});

test('phones roll or type their own die, may spend AI Favor before the reveal, survive a reload', () => {
  const { gm, player, view, dice, state, set } = setup();
  const a = gm({ t: 'player.add', name: 'Ann' }).playerId;
  const b = gm({ t: 'player.add', name: 'Bo' }).playerId;
  gm({ t: 'skill.add', playerId: a, skillId: 'sneak', rank: 1 });
  const { id } = gm({ t: 'scene.check.start', mode: 'party', skillId: 'sneak', dcType: 'fixed', dc: 12, playerIds: [a, b], dice: 'phone' });
  assert.deepEqual(view('player', a).checkPrompts, [{ id, kind: 'show', label: 'Sneak', ability: 'Sneak' }]);
  assert.equal(view('player', a).checkPrompts[0].rolled, undefined);
  const r = player(a, { t: 'scene.check.reply', id, entered: 5 });
  assert.deepEqual([r.die, r.modifier, r.total, r.degree], [5, 3, 8, undefined], 'the phone gets the sum, never the degree');
  assert.throws(() => player(a, { t: 'scene.check.reply', id, entered: 18 }), /already rolled/);
  assert.equal(view('player', a).checkPrompts[0].canFavor, true);
  dice.push(17);
  assert.equal(player(a, { t: 'scene.check.favor', id }).die, 17);
  assert.equal(state().players[0].sheet.fields.aiFavor, 0);
  assert.equal(view('player', a).checkPrompts[0].canFavor, false);
  assert.throws(() => player(a, { t: 'scene.check.favor', id }), /already rerolled/);
  assert.throws(() => player(b, { t: 'scene.check.favor', id }), /roll first/);
  set(normalizeState(JSON.parse(JSON.stringify(state())), pack, 1000));
  assert.equal(view('gm').gm.showCheck.entries[0].die, 17, 'held dice survive a reload');
  player(b, { t: 'scene.check.reply', id, entered: 1 });
  assert.throws(() => player(b, { t: 'scene.check.favor', id }), /natural 1/);
  gm({ t: 'scene.check.reveal' });
  assert.deepEqual(view('player', a).checkPrompts, []);
  assert.deepEqual(view('stage').scene.data.check.results.map((x) => x.degree), ['success', 'critfail']);
});

test('reveal with someone missing, cancel, guard rails', () => {
  const { gm, player, view } = setup();
  const a = gm({ t: 'player.add', name: 'Ann' }).playerId;
  const b = gm({ t: 'player.add', name: 'Bo' }).playerId;
  assert.throws(() => gm({ t: 'scene.check.reveal' }), /no show check/);
  const { id } = gm({ t: 'scene.check.start', mode: 'party', skillId: 'sneak', dcType: 'stat', playerIds: [a, b], dice: 'phone' });
  assert.throws(() => player(b, { t: 'scene.check.reply', id: 'other', entered: 3 }), /no longer waiting/);
  assert.throws(() => gm({ t: 'scene.check.reveal' }), /nobody has rolled/);
  player(a, { t: 'scene.check.reply', id, entered: 12 });
  gm({ t: 'scene.check.reveal' });
  assert.deepEqual(view('gm').gm.showCheck.skipped, [b]);
  assert.equal(view('stage').scene.data.check.results.length, 1);
  gm({ t: 'scene.check.start', mode: 'single', statId: 'dex', dcType: 'stat', playerIds: [a], dice: 'phone' });
  gm({ t: 'scene.check.cancel' });
  assert.equal(view('stage').scene.data.cancelled, true);
  assert.equal(view('gm').gm.showCheck, null);
  assert.deepEqual(view('player', a).checkPrompts, []);
  assert.throws(() => gm({ t: 'scene.check.start', mode: 'single', statId: 'dex', dcType: 'nope', playerIds: [a], dice: 'phone' }), /dcType/);
  assert.throws(() => gm({ t: 'scene.check.start', mode: 'single', statId: 'dex', dcType: 'stat', playerIds: [a, b], dice: 'phone' }), /select the crawlers/);
});
