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
