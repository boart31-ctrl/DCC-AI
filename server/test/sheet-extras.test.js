// Pools (Lay-on-Hands style counters), containers (bag of holding), origin requests (race / class /
// background chosen by the player, approved by the GM) and portraits travelling outside the views.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { createState, reduce, reducePlayerAction, viewFor } from '../state.js';
import { createHost } from '../host.js';
import { tmpDir, writePack } from './fixtures.js';

const ITEMS = [
  { id: 'duck', name: 'Duck', desc: 'Squeak.', rarity: 'common' },
  { id: 'sword', name: 'Sword', desc: 'Pointy.', rarity: 'rare' },
  { id: 'crown', name: 'Crown', desc: 'Shiny.', rarity: 'legendary' },
  { id: 'bag', name: 'Bag of Holding', desc: 'Bigger inside.', rarity: 'rare', tags: ['container'] },
  { id: 'sack', name: 'Sack', desc: 'A sack.', rarity: 'common', tags: ['container'] },
];

function setup() {
  const { pack } = loadPack(writePack(tmpDir(), { 'items.json': ITEMS }));
  let st = createState(pack, 1000);
  let n = 0;
  const ctx = { now: 1000, pack, genId: (p) => `${p}_${++n}`, rng: () => 0.5 };
  const gm = (a) => { const r = reduce(st, { role: 'gm', ...a }, ctx); st = r.state; return r; };
  const pl = (pid, a) => { const r = reducePlayerAction(st, a, { ...ctx, playerId: pid }); st = r.state; return r; };
  const p = (id) => st.players.find((x) => x.id === id);
  const pid = gm({ t: 'player.add', name: 'Bugatti' }).result.playerId;
  return { pack, gm, pl, p, pid, get st() { return st; } };
}
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'ok'; };

test('pools: add, spend/regain clamped, players may spend but not create when locked', () => {
  const t = setup();
  const uid = t.gm({ t: 'pool.add', playerId: t.pid, name: 'Lay on Hands', max: 5, desc: 'Heal by touch.' }).result.uid;
  assert.deepEqual(t.p(t.pid).sheet.pools, [{ uid, name: 'Lay on Hands', cur: 5, max: 5, desc: 'Heal by touch.' }]);
  t.pl(t.pid, { t: 'pool.set', uid, delta: -2 });
  assert.equal(t.p(t.pid).sheet.pools[0].cur, 3);
  t.pl(t.pid, { t: 'pool.set', uid, delta: -10 });
  assert.equal(t.p(t.pid).sheet.pools[0].cur, 0);
  t.pl(t.pid, { t: 'pool.set', uid, cur: 99 });
  assert.equal(t.p(t.pid).sheet.pools[0].cur, 5);
  t.gm({ t: 'pool.update', playerId: t.pid, uid, max: 2 });
  assert.equal(t.p(t.pid).sheet.pools[0].cur, 2);
  t.gm({ t: 'session.permissions', playerEdit: 'none' });
  t.pl(t.pid, { t: 'pool.set', uid, delta: -1 }); // spending is like rolling: always allowed
  assert.equal(t.p(t.pid).sheet.pools[0].cur, 1);
  assert.equal(code(() => t.pl(t.pid, { t: 'pool.add', name: 'X', max: 1 })), 'forbidden');
  t.gm({ t: 'pool.remove', playerId: t.pid, uid });
  assert.equal(t.p(t.pid).sheet.pools.length, 0);
  assert.equal(code(() => t.gm({ t: 'pool.set', playerId: t.pid, uid, delta: 1 })), 'not_found');
});

test('containers: move in and out, no nesting, equip and removal take items out', () => {
  const t = setup();
  for (const id of ['bag', 'sack', 'duck', 'sword']) t.gm({ t: 'lib.give', playerId: t.pid, kind: 'item', id });
  const inv = () => t.p(t.pid).inventory;
  const uidOf = (id) => inv().find((i) => i.itemId === id).uid;
  const [bag, sack, duck, sword] = ['bag', 'sack', 'duck', 'sword'].map(uidOf);
  t.pl(t.pid, { t: 'item.move', uid: duck, into: bag });
  assert.equal(inv().find((i) => i.uid === duck).containerUid, bag);
  assert.equal(code(() => t.pl(t.pid, { t: 'item.move', uid: sword, into: duck })), 'bad_request', 'a duck is not a container');
  assert.equal(code(() => t.pl(t.pid, { t: 'item.move', uid: sack, into: bag })), 'bad_request', 'no containers in containers');
  assert.equal(code(() => t.pl(t.pid, { t: 'item.move', uid: bag, into: bag })), 'bad_request');
  // View: enriched with `container` and `containerUid`.
  const v = viewFor(t.st, t.pack, 'player', { playerId: t.pid, now: 1000 });
  assert.equal(v.me.inventory.find((i) => i.uid === bag).container, true);
  assert.equal(v.me.inventory.find((i) => i.uid === duck).containerUid, bag);
  t.pl(t.pid, { t: 'item.move', uid: duck, into: null });
  assert.equal(inv().find((i) => i.uid === duck).containerUid, null);
  t.pl(t.pid, { t: 'item.move', uid: sword, into: bag });
  t.gm({ t: 'item.qty', playerId: t.pid, uid: bag, qty: 0 }); // the bag is gone: contents fall out
  assert.equal(inv().find((i) => i.uid === sword).containerUid, null);
});

test('origins: locked by default, request with allowOrigins, GM approves → locked; deny clears', () => {
  const t = setup();
  assert.equal(code(() => t.pl(t.pid, { t: 'sheet.set', path: 'identity.race', value: 'Gnome' })), 'forbidden');
  // Re-sending the unchanged value (the builder does) is a no-op, not an error.
  assert.equal(code(() => t.pl(t.pid, { t: 'sheet.set', path: 'identity.race', value: '' })), 'ok');
  t.gm({ t: 'session.permissions', allowOrigins: true });
  assert.equal(t.st.session.permissions.playerEdit, 'sheet', 'playerEdit untouched');
  const r = t.pl(t.pid, { t: 'sheet.set', path: 'identity.race', value: 'Gnome' });
  assert.deepEqual(r.result.pending, { race: 'Gnome' });
  assert.equal(r.events[0].event.kind, 'originsRequest');
  assert.equal(t.p(t.pid).race, '', 'not applied yet');
  t.pl(t.pid, { t: 'sheet.set', path: 'identity.class', value: 'Brawler' });
  t.gm({ t: 'origins.deny', playerId: t.pid });
  assert.deepEqual(t.p(t.pid).sheet.pending, {});
  t.pl(t.pid, { t: 'sheet.set', path: 'identity.race', value: 'Elf' });
  t.pl(t.pid, { t: 'sheet.set', path: 'identity.class', value: 'Brawler' });
  const ok = t.gm({ t: 'origins.approve', playerId: t.pid });
  assert.deepEqual(ok.result, { race: 'Elf', class: 'Brawler', background: '' });
  assert.equal(t.p(t.pid).sheet.originsLocked, true);
  assert.equal(code(() => t.pl(t.pid, { t: 'sheet.set', path: 'identity.race', value: 'Gnome' })), 'forbidden');
  t.gm({ t: 'sheet.set', playerId: t.pid, path: 'identity.race', value: 'Gnome' }); // GM can always change
  assert.equal(t.p(t.pid).race, 'Gnome');
  assert.equal(code(() => t.gm({ t: 'origins.approve', playerId: t.pid })), 'bad_request');
  t.gm({ t: 'origins.lock', playerId: t.pid, locked: false });
  t.pl(t.pid, { t: 'sheet.set', path: 'identity.race', value: 'Elf' });
  assert.deepEqual(t.p(t.pid).sheet.pending, { race: 'Elf' });
  assert.equal(code(() => t.gm({ t: 'session.permissions', allowOrigins: 'yes' })), 'bad_request');
});

test('portraits: views carry refs, the picture goes once per socket, big frame only for portrait', () => {
  const { pack } = loadPack(writePack(tmpDir()));
  const host = createHost({
    pack, state: createState(pack, 1), log: { log() {}, warn() {}, error() {} }, chat: false,
    gmKey: 'k-k-k-k-k-k', legacy: false, base: 'https://x.example',
    timers: { setTimeout: () => 0, clearTimeout() {} },
    send: (c, s) => c.inbox.push(JSON.parse(s)), close: (c, code) => { c.closed = code; },
  });
  const sock = () => { const c = { inbox: [] }; host.connect(c, { ip: '1.1.1.1' }); c.send = (m) => host.message(c, typeof m === 'string' ? m : JSON.stringify(m)); return c; };
  const gm = sock();
  gm.send({ t: 'hello', role: 'gm', key: 'k-k-k-k-k-k' });
  gm.send({ t: 'player.add', name: 'Bugatti', rid: 'a' });
  return new Promise((r) => setImmediate(r)).then(() => {
    const pid = gm.inbox.find((m) => m.rid === 'a').result.playerId;
    const pic = `data:image/webp;base64,${'A'.repeat(150_000)}`;
    gm.send(JSON.stringify({ playerId: pid, t: 'sheet.set', path: 'portrait', value: pic, rid: 'b' }));
    return new Promise((r) => setImmediate(r)).then(() => {
      assert.equal(gm.inbox.find((m) => m.rid === 'b')?.ok, true, 'portrait frame accepted');
      const tv = sock();
      tv.send({ t: 'hello', role: 'stage', key: 'k-k-k-k-k-k' });
      const iP = tv.inbox.findIndex((m) => m.t === 'portraits');
      const iW = tv.inbox.findIndex((m) => m.t === 'welcome');
      assert.ok(iP >= 0 && iP < iW, 'portraits before the view that uses them');
      const ref = tv.inbox[iW].view.players[0].portrait;
      assert.match(ref, /^portrait:/);
      assert.equal(tv.inbox[iP].portraits[ref], pic);
      assert.ok(JSON.stringify(tv.inbox[iW].view).length < 20_000, 'view stays small');
      // A big frame that is not a portrait is refused.
      const other = sock();
      other.send({ t: 'hello', role: 'gm', key: 'k-k-k-k-k-k' });
      other.send(JSON.stringify({ t: 'say', text: 'x'.repeat(20_000) }));
      assert.equal(other.closed, 1009);
    });
  });
});

test('views: me.sheet carries pools, pending origins and the lock', () => {
  const t = setup();
  t.gm({ t: 'pool.add', playerId: t.pid, name: 'Second Wind', max: 3 });
  t.gm({ t: 'session.permissions', allowOrigins: true });
  t.pl(t.pid, { t: 'sheet.set', path: 'identity.class', value: 'Brawler' });
  const v = viewFor(t.st, t.pack, 'player', { playerId: t.pid, now: 1000 });
  assert.equal(v.me.sheet.pools[0].name, 'Second Wind');
  assert.deepEqual(v.me.sheet.pending, { class: 'Brawler' });
  assert.equal(v.me.sheet.originsLocked, false);
  const g = viewFor(t.st, t.pack, 'gm', { now: 1000 });
  assert.deepEqual(g.gm.playersFull[0].sheet.pending, { class: 'Brawler' });
});

test('rest: long refills tracks and every counter; short refills short-reset counters and heals', async () => {
  const { loadPack } = await import('../pack.js');
  const { createState, reduce, reducePlayerAction } = await import('../state.js');
  const { tmpDir, writePack, seq } = await import('./fixtures.js');
  const { pack } = loadPack(writePack(tmpDir()));
  let n = 0;
  const ctx = { now: 1_000_000, rng: seq(0.5), genId: (p) => `${p}_${++n}`, pack };
  let s = createState(pack, 0);
  let r = reduce(s, { role: 'gm', t: 'player.add', name: 'Carl', pin: '1234' }, ctx);
  s = r.state;
  const pid = r.result.playerId;
  const hp = pack.ruleset.tracks[0];
  s = reduce(s, { role: 'gm', t: 'pool.add', playerId: pid, name: 'Second Wind', max: 1, reset: 'short' }, ctx).state;
  s = reduce(s, { role: 'gm', t: 'pool.add', playerId: pid, name: 'Rage', max: 3 }, ctx).state;
  for (const pl of s.players[0].sheet.pools) s = reduce(s, { role: 'gm', t: 'pool.set', playerId: pid, uid: pl.uid, cur: 0 }, ctx).state;
  s = reduce(s, { role: 'gm', t: 'track.set', playerId: pid, track: hp.id, delta: -3 }, ctx).state;
  r = reducePlayerAction(s, { t: 'rest', kind: 'short', heal: 1 }, { ...ctx, playerId: pid });
  const pools = (st) => Object.fromEntries(st.players[0].sheet.pools.map((p) => [p.name, p.cur]));
  assert.deepEqual(pools(r.state), { 'Second Wind': 1, Rage: 0 });
  assert.ok(r.result.restored.includes('Second Wind'));
  r = reduce(r.state, { role: 'gm', t: 'rest', playerId: pid, kind: 'long' }, ctx);
  assert.deepEqual(pools(r.state), { 'Second Wind': 1, Rage: 3 });
  assert.ok(r.result.restored.includes(hp.label));
  assert.throws(() => reduce(s, { role: 'gm', t: 'rest', playerId: pid, kind: 'nap' }, ctx), /short or long/);
});

test('configured party rests restore slots and mana, clear the correct injuries and advance the clock once', async () => {
  const { loadPack, serializePack, deserializePack } = await import('../pack.js');
  const { createState, reduce, reducePlayerAction } = await import('../state.js');
  const { tmpDir, writePack } = await import('./fixtures.js');
  const rests = {
    short: { hours: 2, restore: { hp: 5, mana: { maxFraction: 0.5 } }, removeBuffs: ['minor'] },
    long: { hours: 8, restore: { hp: 'full', mana: 'full' }, removeBuffs: ['fatigued', 'minor'] },
  };
  const dir = writePack(tmpDir(), {
    'ruleset.json': { id: 'resting', rests, tracks: [{ id: 'hp', label: 'Health', kind: 'slots', slots: 10, default: 10 }, { id: 'mana', label: 'Mana', kind: 'pool', default: 15 }] },
    'buffs.json': [{ id: 'minor', name: 'Minor Injury' }, { id: 'fatigued', name: 'Fatigued' }],
  });
  const pack = deserializePack(serializePack(loadPack(dir).pack));
  let n = 0;
  const ctx = { now: 1000, pack, genId: (id) => `${id}_${++n}` };
  const gm = (s, a) => reduce(s, { role: 'gm', ...a }, ctx);
  let s = createState(pack, 0);
  const players = ['Walker', 'Runner', 'Fallen'].map((name) => {
    const r = gm(s, { t: 'player.add', name });
    s = r.state;
    return r.result.playerId;
  });
  for (const [i, playerId] of players.entries()) {
    s = gm(s, { t: 'track.set', playerId, track: 'hp', cur: i === 2 ? 0 : 2 }).state;
    s = gm(s, { t: 'track.set', playerId, track: 'mana', cur: 3 }).state;
    for (const buffId of ['minor', 'fatigued']) s = gm(s, { t: 'buff.add', playerId, buffId }).state;
  }
  assert.throws(() => reducePlayerAction(s, { t: 'rest', kind: 'short' }, { ...ctx, playerId: players[0] }), /GM confirms/);
  s = gm(s, { t: 'crawlers.clock', hours: 11 }).state;
  const short = gm(s, { t: 'rest.party', kind: 'short' });
  assert.equal(short.result.hours, 9);
  assert.equal(short.result.results.length, 2);
  assert.deepEqual(short.state.players.map((p) => [p.sheet.tracks.hp.cur, p.sheet.tracks.mana.cur, p.sheet.buffs.map((b) => b.buffId)]), [
    [7, 10, ['fatigued']], [7, 10, ['fatigued']], [0, 3, ['minor', 'fatigued']],
  ]);
  const long = gm(short.state, { t: 'rest.party', kind: 'long' });
  assert.equal(long.result.hours, 1);
  assert.deepEqual(long.state.players.map((p) => [p.sheet.tracks.hp.cur, p.sheet.tracks.mana.cur, p.sheet.buffs.length]), [[10, 15, 0], [10, 15, 0], [0, 3, 2]]);
  assert.throws(() => gm(long.state, { t: 'rest.party', kind: 'short' }), /not enough time/);
  const active = gm(long.state, { t: 'combat.start' }).state;
  assert.throws(() => gm(active, { t: 'rest.party', kind: 'short' }), /finish combat/);
});
