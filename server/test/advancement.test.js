import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { createState, normalizeState, reduce, reducePlayerAction, viewFor } from '../state.js';
import { tmpDir, writePack } from './fixtures.js';

const MINUTE = 60_000;
const MILESTONE = 120 * MINUTE;
const { pack } = loadPack(writePack(tmpDir(), {
  'ruleset.json': {
    id: 'test-advancement',
    advancement: { intervalMinutes: 120 },
    skills: { usedTracking: true, rankUp: { roll: 'd20', rule: 'gte', target: 'rank', sessionMaxRank: 4 },
      untrained: { adv: 'dis', learn: true, learnMaxFloor: 2 } },
    spells: { costTrack: 'mana', attackChecks: true },
  },
  'skills.json': [
    { id: 'study', name: 'Study', stat: 'str', checkType: 'Standard' },
    { id: 'climb', name: 'Climb', stat: 'str', checkType: 'Standard' },
  ],
  'spells.json': [{ id: 'spark', name: 'Spark', cost: 0, attackCheck: true,
    attack: { stat: 'str', dice: '1d6', skill: 'magic' } }],
}));

function setup(now = 1000) {
  let seq = 0;
  let state = createState(pack, now);
  const ctx = () => ({ pack, now, genId: (prefix) => `${prefix}_${++seq}`, dieInt: () => 4, rng: () => 0.5 });
  return {
    get state() { return state; },
    at(time) { now = time; },
    gm(action) {
      const r = reduce(state, { role: 'gm', ...action }, ctx());
      state = r.state;
      return r;
    },
    player(playerId, action) {
      const r = reducePlayerAction(state, action, { ...ctx(), playerId });
      state = r.state;
      return r;
    },
    gmView: () => viewFor(state, pack, 'gm', { now }).gm,
    phone: (playerId) => viewFor(state, pack, 'player', { now, playerId }),
    reload() { state = normalizeState(JSON.parse(JSON.stringify(state)), pack, now); },
  };
}

test('explicit play clock preserves pause and restart, ignores old estimates, and consumes only exact milestones', () => {
  const h = setup();
  h.gm({ t: 'player.add', name: 'Crawler' });
  h.state.session.playMs = 200 * MINUTE;
  delete h.state.session.advancementClock;
  h.reload();
  const clock = () => h.gmView().advancementClock;
  assert.deepEqual([clock().running, clock().elapsed, clock().due], [false, 0, false]);
  h.gm({ t: 'level.clock', op: 'start' });
  h.at(1000 + MINUTE * 2);
  h.gm({ t: 'level.clock', op: 'pause' });
  h.at(1000 + MINUTE * 400);
  h.reload();
  assert.deepEqual([clock().running, clock().elapsed, clock().due], [false, 2 * MINUTE, false]);
  h.gm({ t: 'level.clock', op: 'start' });
  h.at(1000 + MINUTE * 518 - 1);
  h.reload();
  assert.equal(clock().elapsed, MILESTONE - 1);
  assert.equal(clock().due, false);
  const award = { t: 'level.party', timed: true, checkpoint: MILESTONE };
  assert.throws(() => h.gm(award), /has not been reached/);
  h.at(1000 + MINUTE * 518);
  assert.equal(clock().due, true);
  h.gm({ t: 'level.snooze', minutes: 30 });
  assert.equal(clock().dueAt, MILESTONE + 30 * MINUTE);
  assert.equal(clock().due, false);
  h.at(1000 + MINUTE * 548);
  assert.equal(clock().due, true);
  h.gm(award);
  assert.equal(h.state.players[0].level, 2);
  assert.equal(clock().sinceLevel, 30 * MINUTE);
  assert.equal(clock().next, 2 * MILESTONE);
  assert.throws(() => h.gm(award), /milestone changed/);
  h.gm({ t: 'session.new' });
  assert.deepEqual([clock().running, clock().elapsed, clock().due], [false, 0, false]);
  assert.equal(h.state.players[0].levelGrants.length, 1);
});

test('a play milestone queues private physical and digital rolls plus one practiced skill, saving each outcome once', () => {
  const h = setup();
  const { playerId } = h.gm({ t: 'player.add', name: 'Hero' }).result;
  const { playerId: other } = h.gm({ t: 'player.add', name: 'Ally' }).result;
  const { uid: current } = h.gm({ t: 'skill.add', playerId, rank: 4, name: 'Current milestone' }).result;
  const { uid: floor } = h.gm({ t: 'skill.add', playerId, rank: 5, name: 'Floor advancement' }).result;
  const { uid: spell } = h.gm({ t: 'spell.learn', playerId, rank: 4, spellId: 'spark' }).result;
  for (const uid of [current, floor]) h.gm({ t: 'skill.update', playerId, uid, used: true });
  h.gm({ t: 'roll', playerId, dc: 99, what: { kind: 'spell', uid: spell, part: 'hit' } });
  for (const skillId of ['study', 'climb']) h.player(playerId, { t: 'roll', entered: 12, what: { kind: 'untrained', skillId } });
  h.gm({ t: 'level.clock', op: 'start' });
  h.at(1000 + MILESTONE);
  h.gm({ t: 'level.party', timed: true, checkpoint: MILESTONE });
  assert.deepEqual(h.state.players.map((p) => p.level), [2, 2]);
  const grant = h.phone(playerId).me.levelGrants[0];
  assert.deepEqual(grant.ranks.map((r) => r.uid), [current, spell]);
  assert.deepEqual(grant.practice.map((s) => s.id), ['study', 'climb']);
  assert.deepEqual(h.state.players[0].sheet.untried, []);
  assert.equal(h.state.players[0].sheet.skills.find((s) => s.uid === floor).used, true);
  assert.ok(!JSON.stringify(h.phone(other)).includes(grant.id), 'the other player cannot see this grant');
  const check = { t: 'level.advance', id: grant.id, uid: current, entered: 4 };
  assert.throws(() => h.player(other, check), /not on your sheet/);
  assert.throws(() => h.player(playerId, { ...check, entered: 21 }), /d20 face/);
  const roll = h.player(playerId, check);
  assert.deepEqual([roll.result.roll, roll.result.from, roll.result.to], [4, 4, 5]);
  h.reload();
  const priorRolls = h.state.rolls.length;
  const retry = h.player(playerId, { ...check, entered: 1 });
  assert.deepEqual(retry.result, roll.result);
  assert.equal(retry.changed, false);
  assert.equal(h.state.rolls.length, priorRolls);
  const magic = h.player(playerId, { t: 'level.advance', id: grant.id, uid: spell });
  assert.deepEqual([magic.result.roll, magic.result.from, magic.result.to], [5, 4, 5]);
  const learn = { t: 'level.learn', id: grant.id, skillId: 'study' };
  assert.throws(() => h.player(playerId, { ...learn, skillId: 'other' }), /practiced/);
  assert.equal(h.player(playerId, learn).result.name, 'Study');
  h.gm({ t: 'session.new' });
  h.reload();
  const repeat = h.player(playerId, { ...learn, skillId: 'climb' });
  assert.deepEqual(repeat.result, { id: 'study', name: 'Study' });
  assert.equal(repeat.changed, false);
  const me = h.phone(playerId).me;
  assert.deepEqual(me.sheet.skills.filter((s) => ['study', 'climb'].includes(s.skillId)).map((s) => [s.skillId, s.rank]), [['study', 1]]);
  assert.equal(me.levelGrants[0].ranks[0].result.to, 5);
});
