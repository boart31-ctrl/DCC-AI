import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack, fallbackPack } from '../pack.js';
import { createState, normalizeState, reduce, rollLoot, viewFor, viewForUser, hypeOf, ActionError, MIN_VIEWERS } from '../state.js';
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
  assert.deepEqual(p.sheet.stats, { str: { enhanced: 3, unenhanced: 3 } });
  assert.deepEqual(p.sheet.tracks, { hp: { cur: 10, max: 10 } });
  const me = viewFor(state, pack, 'player', { playerId: id }).me;
  assert.deepEqual(me.stats, { str: 3 });
  assert.deepEqual(me.resources, { hp: { cur: 10, max: 10 } });
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
  assert.deepEqual(r.state.players[0].sheet.stats, {});
  assert.deepEqual(r.state.players[0].sheet.tracks, {});
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
  assert.equal(r.state.players[0].sheet.stats.str.enhanced, 5);
  assert.deepEqual(r.events[0].to, { roles: ['gm', 'stage'], playerId: id });
  assert.deepEqual({ ...r.events[0].event, id: 0, at: 0 }, { id: 0, at: 0, kind: 'stat', playerId: id, stat: 'str', from: 3, to: 5 });
  const v = gm(r.state, { t: 'player.stat', playerId: id, stat: 'str', value: 1 });
  assert.equal(v.state.players[0].sheet.stats.str.enhanced, 1);
  assert.throws(() => gm(state, { t: 'player.stat', playerId: id, stat: 'str', value: 1, delta: 1 }), /exactly one/);
  assert.throws(() => gm(state, { t: 'player.stat', playerId: id, stat: 'wis', value: 1 }), /unknown stat/);
});

test('player.resource clamps 0..max', () => {
  const { state, id } = withPlayer();
  let r = gm(state, { t: 'player.resource', playerId: id, res: 'hp', delta: -25 });
  assert.deepEqual(r.state.players[0].sheet.tracks.hp, { cur: 0, max: 10 });
  assert.equal(r.events[0].event.kind, 'stat');
  r = gm(r.state, { t: 'player.resource', playerId: id, res: 'hp', cur: 50 });
  assert.deepEqual(r.state.players[0].sheet.tracks.hp, { cur: 10, max: 10 });
  r = gm(r.state, { t: 'player.resource', playerId: id, res: 'hp', max: 4 });
  assert.deepEqual(r.state.players[0].sheet.tracks.hp, { cur: 4, max: 4 });
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
  assert.deepEqual(r.events.find((e) => e.event.kind === 'secret').to, { roles: ['gm'], playerId: id });
  const mid = r.result.id;
  const rd = reduce(r.state, { role: 'player', actorId: id, t: 'secret.read', id: mid }, ctx());
  assert.equal(viewFor(rd.state, pack, 'player', { playerId: id }).me.secrets[0].read, true);
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
  assert.ok(gv.gm.quipCategories.find((c) => c.id === 'nat1').left === 1); // nat1_01 is recorded, so the category only draws from it
});

test('normalizeState adds new pack stats to old saves', () => {
  const old = { room: 'ABCD', gmToken: 't', stageToken: 'u', players: [{ id: 'p_1', name: 'Old', pin: '0000', stats: { str: 9 } }] };
  const s = normalizeState(old, pack);
  assert.equal(s.room, 'ABCD');
  assert.deepEqual(s.players[0].sheet.stats, { str: { enhanced: 9, unenhanced: 9 } });
  assert.deepEqual(s.players[0].sheet.tracks.hp, { cur: 10, max: 10 });
  assert.equal(s.players[0].stats, undefined);
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

// ---------- messaging + pass-through fields ----------

function twoPlayers() {
  let s = createState(pack, 0);
  const a = gm(s, { t: 'player.add', name: 'A', pin: '1111' });
  const b = gm(a.state, { t: 'player.add', name: 'B', pin: '2222' });
  return { state: b.state, a: a.result.playerId, b: b.result.playerId };
}

test('msg.send to all: group message, event to gm+players, announcement only with onStage', () => {
  const { state, a, b } = twoPlayers();
  const r = gm(state, { t: 'msg.send', to: 'all', text: 'Floor 2 opens', onStage: true });
  const m = r.state.messages[0];
  assert.equal(m.from, pack.systemName);
  assert.equal(m.to, 'all');
  const kinds = r.events.map((e) => e.event.kind);
  assert.deepEqual(kinds, ['message', 'announcement']);
  assert.deepEqual(r.events[0].to, { roles: ['gm', 'player'] });
  assert.deepEqual(
    (({ at, ...rest }) => rest)(r.events[0].event),
    { kind: 'message', id: m.id, group: true, from: 'The System', to: 'all' },
  );
  assert.deepEqual(r.events[1].to, { roles: ['stage'] });
  assert.equal(r.events[1].event.text, 'Floor 2 opens');
  assert.equal(r.events[1].event.messageId, m.id);
  assert.equal(r.lines.length, 0, 'announcement has no audio');
  for (const id of [a, b]) {
    const me = viewFor(r.state, pack, 'player', { playerId: id }).me;
    assert.deepEqual(me.messages.map((x) => [x.text, x.group, x.read]), [['Floor 2 opens', true, false]]);
    assert.deepEqual(me.secrets, [], 'group messages are not secrets');
  }
  const noStage = gm(state, { t: 'msg.send', to: 'all', text: 'x' });
  assert.deepEqual(noStage.events.map((e) => e.event.kind), ['message']);
});

test('msg.send to a subset: only those players; onStage ignored for private', () => {
  const { state, a, b } = twoPlayers();
  const r = gm(state, { t: 'msg.send', to: [a], text: 'psst', from: 'Sponsor', onStage: true });
  assert.deepEqual(r.events.map((e) => e.event.kind), ['message', 'secret']);
  assert.deepEqual(r.events[0].to, { roles: ['gm'], playerIds: [a] });
  assert.equal(r.events[0].event.group, false);
  const meA = viewFor(r.state, pack, 'player', { playerId: a }).me;
  const meB = viewFor(r.state, pack, 'player', { playerId: b }).me;
  assert.equal(meA.secrets[0].text, 'psst');
  assert.equal(meA.secrets[0].from, 'Sponsor');
  assert.equal(meA.messages[0].group, false);
  assert.deepEqual(meB.messages, []);
  const g = gm(state, { t: 'msg.send', to: [a, b], text: 'duo' });
  assert.equal(g.events[0].event.group, true);
  assert.equal(viewFor(g.state, pack, 'player', { playerId: b }).me.messages[0].group, true);
});

test('msg.send validation', () => {
  const { state, a } = twoPlayers();
  assert.throws(() => gm(state, { t: 'msg.send', to: [], text: 'x' }), ActionError);
  assert.throws(() => gm(state, { t: 'msg.send', to: 'everyone', text: 'x' }), ActionError);
  assert.throws(() => gm(state, { t: 'msg.send', to: ['p_nope'], text: 'x' }), (e) => e.code === 'not_found');
  assert.throws(() => gm(state, { t: 'msg.send', to: [a], text: 'x'.repeat(1001) }), /too long/);
  assert.throws(() => gm(state, { t: 'msg.send', to: [a], text: 'x', onStage: 'yes' }), ActionError);
});

test('secret.read marks private and group messages read per player', () => {
  const { state, a, b } = twoPlayers();
  let s = gm(state, { t: 'msg.send', to: 'all', text: 'hi all' }).state;
  s = gm(s, { t: 'secret.send', playerId: a, text: 'hi a' }).state;
  const [gid, pid] = s.messages.map((m) => m.id);
  s = reduce(s, { role: 'player', actorId: a, t: 'secret.read', id: gid }, ctx()).state;
  s = reduce(s, { role: 'player', actorId: a, t: 'secret.read', id: pid }, ctx()).state;
  const meA = viewFor(s, pack, 'player', { playerId: a }).me;
  assert.ok(meA.messages.every((m) => m.read));
  assert.equal(meA.secrets[0].read, true);
  assert.equal(viewFor(s, pack, 'player', { playerId: b }).me.messages[0].read, false);
  assert.throws(() => reduce(s, { role: 'player', actorId: b, t: 'secret.read', id: pid }, ctx()), (e) => e.code === 'not_found');
});

test('messages capped at 200 in state, gm view shows last 50', () => {
  const { state, a } = twoPlayers();
  let s = state;
  for (let i = 0; i < 205; i++) s = gm(s, { t: 'msg.send', to: [a], text: `m${i}` }).state;
  assert.equal(s.messages.length, 200);
  assert.equal(s.messages[0].text, 'm5');
  const gv = viewFor(s, pack, 'gm', {});
  assert.equal(gv.gm.messages.length, 50);
  assert.equal(gv.gm.messages[49].text, 'm204');
  assert.deepEqual(gv.gm.messages[0].to, [a]);
});

test('normalizeState migrates legacy players[].secrets into messages', () => {
  const old = { room: 'ABCD', players: [{ id: 'p_1', name: 'Old', pin: '0000', secrets: [{ id: 'm_1', at: 5, from: 'S', text: 'old', read: true }] }] };
  const s = normalizeState(old, pack);
  assert.equal(s.players[0].secrets, undefined);
  const me = viewFor(s, pack, 'player', { playerId: 'p_1' }).me;
  assert.deepEqual(me.secrets, [{ id: 'm_1', at: 5, from: 'S', text: 'old', read: true }]);
});

test('achievement reward/group and item flavor flow into state, events and views', () => {
  const { state, id } = withPlayer();
  let r = gm(state, { t: 'ach.award', playerId: id, achId: 'first_blood' });
  assert.equal(r.events[0].event.reward, 'Bronze Box');
  assert.equal(r.events[0].event.group, 'Combat');
  assert.equal(r.state.players[0].achievements[0].reward, 'Bronze Box');
  r = gm(r.state, { t: 'ach.award', playerId: id, title: 'Custom', reward: 'A hug' });
  assert.equal(r.state.players[0].achievements[1].reward, 'A hug');
  assert.equal(r.events[0].event.reward, 'A hug');
  r = gm(r.state, { t: 'loot.open', playerId: id, tier: 'bronze' }, { rng: seq(0.9) });
  assert.equal(r.events[0].event.item.flavor, 'Forged by someone who really hated bread.');
  const gv = viewFor(r.state, pack, 'gm', {});
  assert.equal(gv.pack.notifyPrefix, 'New achievement!');
  assert.equal(gv.gm.achievementsCatalog[0].reward, 'Bronze Box');
  assert.equal(gv.gm.itemsCatalog.find((i) => i.id === 'sword').flavor, 'Forged by someone who really hated bread.');
});

// ---------- hosted edition: userId, prep cards, recap ----------

test('userId on player.add/update: unique, ≤64, null unassigns; viewForUser', () => {
  let s = createState(pack, 0);
  const a = gm(s, { t: 'player.add', name: 'A', userId: 'u1' });
  s = a.state;
  const pa = a.result.playerId;
  assert.equal(s.players[0].userId, 'u1');
  assert.throws(() => gm(s, { t: 'player.add', name: 'B', userId: 'u1' }), /already assigned/);
  assert.throws(() => gm(s, { t: 'player.add', name: 'B', userId: 'x'.repeat(65) }), /too long/);
  assert.throws(() => gm(s, { t: 'player.add', name: 'B', userId: 5 }), ActionError);
  const b = gm(s, { t: 'player.add', name: 'B' });
  s = b.state;
  assert.equal(s.players[1].userId, null);
  assert.throws(() => gm(s, { t: 'player.update', playerId: b.result.playerId, userId: 'u1' }), /already assigned/);
  s = gm(s, { t: 'player.update', playerId: pa, userId: 'u1' }).state; // same player, same id: fine
  assert.equal(viewForUser(s, pack, 'u1').me.id, pa);
  assert.deepEqual(viewForUser(s, pack, 'u1', { now: 5 }), viewFor(s, pack, 'player', { playerId: pa, now: 5 })); // fixed clock: no ms-boundary flake
  s = gm(s, { t: 'player.update', playerId: pa, userId: null }).state;
  assert.equal(viewForUser(s, pack, 'u1'), null);
  assert.equal(viewForUser(s, pack, null), null);
  s = gm(s, { t: 'player.update', playerId: b.result.playerId, userId: 'u1' }).state;
  assert.equal(viewForUser(s, pack, 'u1').me.name, 'B');
  assert.equal(viewFor(s, pack, 'gm', {}).gm.playersFull[1].userId, 'u1');
  assert.equal(viewFor(s, pack, 'player', { playerId: pa }).me.userId, undefined, 'player view shape unchanged');
});

test('prep cards: add, list in gm view, fire runs the action, remove', () => {
  const { state, a, b } = twoPlayers();
  let s = state;
  const add = (card) => {
    const r = gm(s, { t: 'prep.card.add', ...card });
    s = r.state;
    return r.result.id;
  };
  const ach = add({ kind: 'achievement', label: 'Duck hunter', payload: { title: 'Duck Hunter', desc: 'Quack.', reward: 'A duck' } });
  const loot = add({ kind: 'loot', payload: { playerId: a, tier: 'gold' } });
  const msg = add({ kind: 'message', label: 'Sponsor ping', payload: { to: 'all', text: 'Sponsors are watching', onStage: true } });
  const line = add({ kind: 'line', payload: { text: 'Welcome back, crawlers.', t: 'player.remove', role: 'player' } });
  const gv = viewFor(s, pack, 'gm', {});
  assert.equal(gv.gm.prepCards.length, 4);
  assert.deepEqual(gv.gm.prepCards[3].payload, { text: 'Welcome back, crawlers.' }, 't/role stripped');
  assert.equal(gv.gm.prepCards[1].label, 'loot', 'label defaults to kind');
  assert.equal(viewFor(s, pack, 'player', { playerId: a }).gm, undefined);
  assert.equal(JSON.stringify(viewFor(s, pack, 'stage', {})).includes('Duck Hunter'), false);

  // achievement card without playerId needs one at fire time
  assert.throws(() => gm(s, { t: 'prep.card.fire', id: ach }), /playerId required/);
  let r = gm(s, { t: 'prep.card.fire', id: ach, playerId: b });
  assert.equal(r.state.players[1].achievements[0].reward, 'A duck');
  assert.equal(r.events[0].event.kind, 'achievement');
  assert.equal(r.lines[0].priority, 1);
  assert.deepEqual(r.result, { cardId: ach, action: 'ach.award' });
  const fired = r.state.prepCards.find((c) => c.id === ach);
  assert.equal(fired.used, true);
  assert.equal(fired.usedAt, 1_000_000);
  s = r.state;

  r = gm(s, { t: 'prep.card.fire', id: loot }, { rng: seq(0) });
  assert.equal(r.state.players[0].inventory[0].itemId, 'crown');
  assert.equal(r.result.itemId, 'crown');
  r = gm(s, { t: 'prep.card.fire', id: msg });
  assert.deepEqual(r.events.map((e) => e.event.kind), ['message', 'announcement']);
  r = gm(s, { t: 'prep.card.fire', id: line });
  assert.deepEqual(r.lines.map((l) => [l.priority, l.text]), [[0, 'Welcome back, crawlers.']]);
  assert.equal(r.state.players.length, 2, 'smuggled t ignored');

  // failure leaves the card unused (reduce is atomic)
  const bad = add({ kind: 'loot', payload: { tier: 'mythic' } });
  assert.throws(() => gm(s, { t: 'prep.card.fire', id: bad, playerId: a }), /unknown loot tier/);
  assert.equal(s.prepCards.find((c) => c.id === bad).used, false);

  s = gm(s, { t: 'prep.card.remove', id: bad }).state;
  assert.equal(s.prepCards.some((c) => c.id === bad), false);
  assert.throws(() => gm(s, { t: 'prep.card.remove', id: bad }), (e) => e.code === 'not_found');
  assert.throws(() => gm(s, { t: 'prep.card.fire', id: 'c_nope' }), (e) => e.code === 'not_found');
  assert.throws(() => gm(s, { t: 'prep.card.add', kind: 'nuke', payload: {} }), /kind must be/);
  assert.throws(() => gm(s, { t: 'prep.card.add', kind: 'line', payload: 'x' }), /payload must be an object/);
});

test('session.recap is public and resets with session.new', () => {
  let s = createState(pack, 0);
  assert.equal(viewFor(s, pack, 'stage', {}).recap, '');
  s = gm(s, { t: 'session.recap', text: '  Previously on The System…  ' }).state;
  for (const role of ['gm', 'stage', 'player']) assert.equal(viewFor(s, pack, role, {}).recap, 'Previously on The System…');
  assert.throws(() => gm(s, { t: 'session.recap', text: 'x'.repeat(4001) }), /too long/);
  assert.throws(() => gm(s, { t: 'session.recap' }), ActionError);
  assert.equal(gm(s, { t: 'session.new' }).state.session.recap, '');
});

test('normalizeState fills hosted-edition fields on old saves', () => {
  const s = normalizeState({ room: 'ABCD', session: { id: 's_1' }, players: [{ id: 'p_1', name: 'X', pin: '0000' }] }, pack);
  assert.equal(s.players[0].userId, null);
  assert.deepEqual(s.prepCards, []);
  assert.equal(s.session.recap, '');
});
