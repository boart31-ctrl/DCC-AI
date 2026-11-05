import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack, fallbackPack } from '../pack.js';
import { createState, normalizeState, reduce, rollLoot, viewFor, hypeOf, ActionError, MIN_VIEWERS } from '../state.js';
import { authenticate, RateLimiter, makeRoomCode, makeToken, makePin, ROOM_ALPHABET } from '../auth.js';
import { tmpDir, writePack, seq } from './fixtures.js';

const { pack } = loadPack(writePack(tmpDir()));
let n = 0;
const ctx = (extra = {}) => ({ now: 1_000_000, rng: seq(0.5), genId: (p) => `${p}_${++n}`, pack, ...extra });
const gm = (state, a, extra) => reduce(state, { role: 'gm', ...a }, ctx(extra));

function withPlayer() {
  const r = gm(createState(pack, 0), { t: 'player.add', name: 'Carl', pin: '1234' });
  return { state: r.state, id: r.result.playerId };
}

test('player.add initialises sheet from pack defaults; rejects duplicate pin', () => {
  const { state, id } = withPlayer();
  const p = state.players[0];
  assert.equal(p.id, id);
  assert.deepEqual(p.stats, { str: 3 });
  assert.deepEqual(p.resources, { hp: { cur: 10, max: 10 } });
  assert.equal(p.gold, 0);
  assert.equal(p.notes, '');
  assert.throws(() => gm(state, { t: 'player.add', name: 'B', pin: '1234' }), /PIN already used/);
  const auto = gm(state, { t: 'player.add', name: 'B' });
  assert.match(auto.result.pin, /^\d{4}$/);
  assert.notEqual(auto.result.pin, '1234');
});

test('packs without stats/resources give empty sheet', () => {
  const fb = fallbackPack();
  const r = reduce(createState(fb, 0), { role: 'gm', t: 'player.add', name: 'X' }, ctx({ pack: fb }));
  assert.deepEqual(r.state.players[0].stats, {});
  assert.deepEqual(r.state.players[0].resources, {});
});

test('reducers do not mutate input state', () => {
  const { state, id } = withPlayer();
  const frozen = JSON.stringify(state);
  gm(state, { t: 'ach.award', playerId: id, achId: 'first_blood' });
  assert.equal(JSON.stringify(state), frozen);
});

test('ach.award from catalog uses the achievement voice line as P1', () => {
  const { state, id } = withPlayer();
  const r = gm(state, { t: 'ach.award', playerId: id, achId: 'first_blood' });
  const p = r.state.players[0];
  assert.equal(p.achievements[0].title, 'First Blood');
  const ev = r.events.find((e) => e.event.kind === 'achievement');
  assert.equal(ev.to, 'all');
  assert.equal(ev.event.playerId, id);
  assert.deepEqual(r.lines, [{ priority: 1, text: 'Blood!', quipId: 'ach_fb', crit: false, category: 'achievement' }]);
  assert.ok(r.state.audience.viewers > 1000, 'viewers bumped');
  assert.equal(r.state.feed.length, 1);
});

test('ach.award custom title, empty desc ok, falls back to achievement category', () => {
  const { state, id } = withPlayer();
  const r = gm(state, { t: 'ach.award', playerId: id, achId: 'plain' });
  assert.equal(r.lines[0].category, 'achievement');
  const c = gm(state, { t: 'ach.award', playerId: id, title: 'Custom' });
  assert.equal(c.state.players[0].achievements[0].desc, '');
  assert.equal(c.state.players[0].achievements[0].achId, null);
  assert.throws(() => gm(state, { t: 'ach.award', playerId: id }), ActionError);
  assert.throws(() => gm(state, { t: 'ach.award', playerId: 'nope', achId: 'plain' }), (e) => e.code === 'not_found');
});

test('loot roll weights are deterministic with injected rng', () => {
  // bronze: duck 3, sword 1 → x in [0,3) duck, [3,4) sword
  assert.equal(rollLoot(pack, 'bronze', seq(0)).id, 'duck');
  assert.equal(rollLoot(pack, 'bronze', seq(0.74)).id, 'duck');
  assert.equal(rollLoot(pack, 'bronze', seq(0.75)).id, 'sword');
  assert.equal(rollLoot(pack, 'bronze', seq(0.999)).id, 'sword');
  const counts = { duck: 0, sword: 0 };
  for (let i = 0; i < 1000; i++) counts[rollLoot(pack, 'bronze', seq(i / 1000)).id]++;
  assert.deepEqual(counts, { duck: 750, sword: 250 });
});

test('loot.open adds item, emits loot, unknown tier rejected', () => {
  const { state, id } = withPlayer();
  const r = gm(state, { t: 'loot.open', playerId: id, tier: 'bronze' }, { rng: seq(0.9) });
  const inv = r.state.players[0].inventory;
  assert.equal(inv[0].itemId, 'sword');
  assert.equal(r.events[0].event.kind, 'loot');
  assert.equal(r.events[0].event.item.name, 'Sword');
  assert.throws(() => gm(state, { t: 'loot.open', playerId: id, tier: 'mythic' }), /unknown loot tier/);
  const rm = gm(r.state, { t: 'item.remove', playerId: id, uid: inv[0].uid });
  assert.equal(rm.state.players[0].inventory.length, 0);
});

test('sponsor.box bumps viewers by 10%', () => {
  const { state, id } = withPlayer();
  const r = gm(state, { t: 'sponsor.box', playerId: id, tier: 'gold', sponsor: 'Acme' });
  assert.equal(r.state.audience.viewers, 1100);
  assert.equal(r.events[0].event.sponsor, 'Acme');
});

test('quip.play is P0 and records usage; unknown category → not_found', () => {
  const r = gm(createState(pack, 0), { t: 'quip.play', category: 'nat1' });
  assert.equal(r.lines[0].priority, 0);
  assert.equal(r.state.usedQuips.nat1.length, 1);
  assert.throws(() => gm(createState(pack, 0), { t: 'quip.play', category: 'zzz' }), (e) => e.code === 'not_found');
});

test('player.stat value/delta, event to player+gm+stage', () => {
  const { state, id } = withPlayer();
  const r = gm(state, { t: 'player.stat', playerId: id, stat: 'str', delta: 2 });
  assert.equal(r.state.players[0].stats.str, 5);
  assert.deepEqual(r.events[0].to, { roles: ['gm', 'stage'], playerId: id });
  assert.deepEqual({ ...r.events[0].event, id: 0, at: 0 }, { id: 0, at: 0, kind: 'stat', playerId: id, stat: 'str', from: 3, to: 5 });
  const v = gm(r.state, { t: 'player.stat', playerId: id, stat: 'str', value: 1 });
  assert.equal(v.state.players[0].stats.str, 1);
  assert.throws(() => gm(state, { t: 'player.stat', playerId: id, stat: 'str', value: 1, delta: 1 }), /exactly one/);
  assert.throws(() => gm(state, { t: 'player.stat', playerId: id, stat: 'wis', value: 1 }), /unknown stat/);
});

test('player.resource clamps 0..max', () => {
  const { state, id } = withPlayer();
  let r = gm(state, { t: 'player.resource', playerId: id, res: 'hp', delta: -25 });
  assert.deepEqual(r.state.players[0].resources.hp, { cur: 0, max: 10 });
  assert.equal(r.events[0].event.kind, 'stat');
  r = gm(r.state, { t: 'player.resource', playerId: id, res: 'hp', cur: 50 });
  assert.deepEqual(r.state.players[0].resources.hp, { cur: 10, max: 10 });
  r = gm(r.state, { t: 'player.resource', playerId: id, res: 'hp', max: 4 });
  assert.deepEqual(r.state.players[0].resources.hp, { cur: 4, max: 4 });
  assert.throws(() => gm(state, { t: 'player.resource', playerId: id, res: 'hp' }), /cur, max or delta/);
});

test('player.update accepts sheet fields and validates', () => {
  const { state, id } = withPlayer();
  const r = gm(state, { t: 'player.update', playerId: id, title: 'Crawler', klass: 'Brawler', race: 'Human', gold: 12, level: 2 });
  const p = r.state.players[0];
  assert.deepEqual([p.title, p.klass, p.race, p.gold, p.level], ['Crawler', 'Brawler', 'Human', 12, 2]);
  assert.throws(() => gm(state, { t: 'player.update', playerId: id, gold: -1 }), ActionError);
  assert.throws(() => gm(state, { t: 'player.update', playerId: id, color: 'red' }), ActionError);
});

test('me.notes by player, max 2000', () => {
  const { state, id } = withPlayer();
  const r = reduce(state, { role: 'player', actorId: id, t: 'me.notes', text: 'hi' }, ctx());
  assert.equal(r.state.players[0].notes, 'hi');
  assert.throws(() => reduce(state, { role: 'player', actorId: id, t: 'me.notes', text: 'x'.repeat(2001) }, ctx()), /too long/);
  assert.throws(() => reduce(state, { role: 'player', actorId: id, t: 'player.add', name: 'x' }, ctx()), /unknown action/);
});

test('secret.send + secret.read', () => {
  const { state, id } = withPlayer();
  const r = gm(state, { t: 'secret.send', playerId: id, text: 'psst', from: 'Sponsor' });
  assert.deepEqual(r.events[0].to, { roles: ['gm'], playerId: id });
  const mid = r.result.id;
  const rd = reduce(r.state, { role: 'player', actorId: id, t: 'secret.read', id: mid }, ctx());
  assert.equal(rd.state.players[0].secrets[0].read, true);
});

test('session.voice, mode, auto, budget, new', () => {
  let s = createState(pack, 0);
  assert.equal(s.session.voice, 'host');
  s = gm(s, { t: 'session.voice', voice: 'gremlin' }).state;
  assert.equal(s.session.voice, 'gremlin');
  assert.throws(() => gm(s, { t: 'session.voice', voice: 'nope' }), (e) => e.code === 'not_found');
  assert.throws(() => gm(s, { t: 'session.mode', mode: 'party' }), ActionError);
  const off = gm(s, { t: 'session.auto', on: false });
  assert.deepEqual(off.effects, [{ type: 'clearPending' }]);
  s = gm(s, { t: 'session.budget', value: 2 }).state;
  s = gm(s, { t: 'quip.play', category: 'nat1' }).state;
  const nw = gm(s, { t: 'session.new' });
  assert.equal(nw.effects[0].type, 'archive');
  assert.notEqual(nw.state.session.id, s.session.id);
  assert.equal(nw.state.session.budgetLeft, 3);
  assert.equal(nw.state.session.voice, 'gremlin', 'voice carries over');
  assert.deepEqual(nw.state.usedQuips, {});
});

test('audience: bump floor, quiet decay, hype and sponsorReady', () => {
  let s = createState(pack, 0);
  s = gm(s, { t: 'audience.bump', delta: -1e6 }).state;
  assert.equal(s.audience.viewers, MIN_VIEWERS);
  s = gm(s, { t: 'audience.bump', delta: 950 }, { now: 0 }).state;
  assert.equal(s.audience.viewers, 1000);
  assert.equal(hypeOf(s.audience, 0), 1);
  const gv = viewFor(s, pack, 'gm', { now: 0 });
  assert.equal(gv.gm.sponsorReady, true);
  assert.equal(viewFor(s, pack, 'gm', { now: 10 * 60_000 }).gm.sponsorReady, false);
  const d = reduce(s, { role: 'system', t: 'audience.tick' }, { now: 3 * 60_000 + 1 });
  assert.equal(d.state.audience.viewers, Math.round(1000 * 0.99 ** 3));
  const none = reduce(s, { role: 'system', t: 'audience.tick' }, { now: 30_000 });
  assert.equal(none.changed, false);
});

test('views are role-filtered', () => {
  const { state, id } = withPlayer();
  const s = gm(state, { t: 'secret.send', playerId: id, text: 'psst' }).state;
  const pv = viewFor(s, pack, 'player', { playerId: id });
  assert.equal(pv.me.secrets[0].text, 'psst');
  assert.equal(pv.gm, undefined);
  assert.equal(pv.me.pin, undefined);
  assert.equal(JSON.stringify(pv).includes(s.gmToken), false);
  const sv = viewFor(s, pack, 'stage', { urls: { join: 'J' } });
  assert.equal(sv.joinUrl, 'J');
  assert.equal(sv.me, undefined);
  assert.equal(JSON.stringify(sv).includes('psst'), false);
  const gv = viewFor(s, pack, 'gm', {});
  assert.equal(gv.gm.pins[id], '1234');
  assert.deepEqual(gv.pack.stats, [{ id: 'str', label: 'Strength', abbr: 'STR' }]);
  assert.equal(gv.pack.voices.length, 2);
  assert.ok(gv.gm.quipCategories.find((c) => c.id === 'nat1').left === 3);
});

test('normalizeState adds new pack stats to old saves', () => {
  const old = { room: 'ABCD', gmToken: 't', stageToken: 'u', players: [{ id: 'p_1', name: 'Old', pin: '0000', stats: { str: 9 } }] };
  const s = normalizeState(old, pack);
  assert.equal(s.room, 'ABCD');
  assert.deepEqual(s.players[0].stats, { str: 9 });
  assert.deepEqual(s.players[0].resources.hp, { cur: 10, max: 10 });
  assert.deepEqual(s.players[0].inventory, []);
});

// ---------- auth ----------

test('tokens, room code, pins', () => {
  const t = makeToken();
  assert.match(t, /^[A-Za-z0-9_-]{24,}$/);
  for (let i = 0; i < 50; i++) {
    const code = makeRoomCode();
    assert.equal(code.length, 4);
    for (const ch of code) assert.ok(ROOM_ALPHABET.includes(ch));
    assert.doesNotMatch(code, /[IOL01]/);
  }
  assert.equal(makePin(['0000'], seq(0, 5).bind(null)), '0005');
});

test('authenticate + rate limit: 5 failed PINs per IP per minute', () => {
  const { state } = withPlayer();
  let t = 0;
  const lim = new RateLimiter({ max: 5, windowMs: 60_000, now: () => t });
  assert.deepEqual(authenticate(state, { role: 'gm', token: state.gmToken }, 'ip', lim), { ok: true, role: 'gm' });
  assert.equal(authenticate(state, { role: 'gm', token: state.stageToken }, 'ip', lim).code, 'bad_auth');
  assert.equal(authenticate(state, { role: 'stage', token: state.stageToken }, 'ip', lim).ok, true);
  assert.equal(authenticate(state, { role: 'root' }, 'ip', lim).code, 'bad_request');
  const ok = authenticate(state, { role: 'player', room: state.room.toLowerCase(), pin: '1234' }, 'ip', lim);
  assert.equal(ok.playerId, state.players[0].id);
  for (let i = 0; i < 5; i++) assert.equal(authenticate(state, { role: 'player', room: state.room, pin: '9999' }, 'ip', lim).code, 'bad_auth');
  assert.equal(authenticate(state, { role: 'player', room: state.room, pin: '1234' }, 'ip', lim).code, 'rate_limited');
  assert.equal(authenticate(state, { role: 'player', room: state.room, pin: '1234' }, 'other', lim).ok, true);
  t = 60_001;
  assert.equal(authenticate(state, { role: 'player', room: state.room, pin: '1234' }, 'ip', lim).ok, true);
  assert.equal(authenticate(state, { role: 'player', room: 'ZZZZ', pin: '1234' }, 'x', lim).code, 'bad_auth');
});
