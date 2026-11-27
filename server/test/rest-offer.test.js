// rest-offer.js: the GM offers a rest, each crawler takes it on the phone (27 Nov playtest).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack, serializePack, deserializePack } from '../pack.js';
import { createState, normalizeState, reduce, reducePlayerAction, viewFor } from '../state.js';
import { tmpDir, writePack } from './fixtures.js';

const rests = {
  short: { hours: 2, restore: { hp: 5, mana: { maxFraction: 0.5 } }, removeBuffs: ['minor'] },
  long: { hours: 8, restore: { hp: 'full', mana: 'full' }, removeBuffs: ['minor'] },
};
const dir = writePack(tmpDir(), {
  'ruleset.json': { id: 'resting', rests, tracks: [{ id: 'hp', label: 'Health', kind: 'slots', slots: 10, default: 10 }, { id: 'mana', label: 'Mana', kind: 'pool', default: 15 }] },
  'buffs.json': [{ id: 'minor', name: 'Minor Injury' }],
});
const pack = deserializePack(serializePack(loadPack(dir).pack));

function setup() {
  let n = 0;
  const ctx = { now: 1000, pack, genId: (id) => `${id}_${++n}` };
  const gm = (s, a) => reduce(s, { role: 'gm', ...a }, ctx);
  let s = createState(pack, 0);
  const ids = ['Walker', 'Runner', 'Fallen'].map((name) => { const r = gm(s, { t: 'player.add', name }); s = r.state; return r.result.playerId; });
  for (const [i, playerId] of ids.entries()) {
    s = gm(s, { t: 'track.set', playerId, track: 'hp', cur: i === 2 ? 0 : 2 }).state;
    s = gm(s, { t: 'track.set', playerId, track: 'mana', cur: 3 }).state;
    s = gm(s, { t: 'buff.add', playerId, buffId: 'minor' }).state;
  }
  s = gm(s, { t: 'crawlers.clock', hours: 20 }).state;
  return { ctx, gm, s, ids };
}

test('rest.offer: the clock moves once, only able crawlers are asked, the TV shows the saferoom', () => {
  const { gm, s, ids } = setup();
  const r = gm(s, { t: 'rest.offer', kind: 'long' });
  assert.equal(r.result.who, 2, 'the downed crawler is not offered a rest');
  assert.equal(r.state.crawlers.clock.hours, 12);
  assert.equal(r.state.scene.kind, 'explore');
  assert.equal(r.state.scene.data.location, 'Saferoom');
  assert.equal(r.state.players[0].sheet.tracks.hp.cur, 2, 'nothing is restored before the crawler confirms');
  const mine = viewFor(r.state, pack, 'player', { playerId: ids[0] }).rest;
  assert.equal(mine.kind, 'long');
  assert.equal(mine.done, null);
  assert.equal(viewFor(r.state, pack, 'player', { playerId: ids[2] }).rest, null);
  assert.deepEqual(viewFor(r.state, pack, 'gm').rest.crawlers.map((c) => c.name), ['Walker', 'Runner']);
  assert.equal(viewFor(r.state, pack, 'stage').rest, null);
});

test('rest.accept on the phone restores that crawler once; the GM can rest someone and close it', () => {
  const { ctx, gm, s, ids } = setup();
  let st = gm(s, { t: 'rest.offer', kind: 'short' }).state;
  const id = st.restOffer.id;
  const took = reducePlayerAction(st, { t: 'rest.accept', id }, { ...ctx, playerId: ids[0] });
  st = took.state;
  assert.deepEqual([st.players[0].sheet.tracks.hp.cur, st.players[0].sheet.tracks.mana.cur, st.players[0].sheet.buffs.length], [7, 10, 0]);
  assert.equal(st.players[1].sheet.tracks.hp.cur, 2, 'the other crawler has not confirmed yet');
  assert.ok(took.events.some((e) => e.event.kind === 'rest' && e.event.playerId === ids[0]));
  const again = reducePlayerAction(st, { t: 'rest.accept', id }, { ...ctx, playerId: ids[0] });
  assert.equal(again.state.players[0].sheet.tracks.hp.cur, 7, 'a second tap does not rest twice');
  assert.throws(() => reducePlayerAction(st, { t: 'rest.accept', id }, { ...ctx, playerId: ids[2] }), /not part of this rest/);
  st = gm(st, { t: 'rest.accept', playerId: ids[1] }).state;
  assert.equal(st.players[1].sheet.tracks.hp.cur, 7);
  assert.ok(viewFor(st, pack, 'player', { playerId: ids[0] }).rest.done);
  st = gm(st, { t: 'rest.close' }).state;
  assert.equal(st.restOffer, null);
  assert.throws(() => reducePlayerAction(st, { t: 'rest.accept', id }, { ...ctx, playerId: ids[1] }), /rest is over/);
  assert.equal(normalizeState(JSON.parse(JSON.stringify(st)), pack).restOffer, null);
});

test('rest.offer refuses in a fight and without time', () => {
  const { gm, s } = setup();
  assert.throws(() => gm(gm(s, { t: 'combat.start' }).state, { t: 'rest.offer', kind: 'short' }), /finish combat/);
  assert.throws(() => gm(gm(s, { t: 'crawlers.clock', hours: 1 }).state, { t: 'rest.offer', kind: 'long' }), /not enough time/);
  assert.throws(() => gm(s, { t: 'rest.offer', kind: 'nap' }), /kind must be/);
});
