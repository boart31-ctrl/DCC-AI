import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPack } from '../pack.js';
import { createState, reduce, viewFor, threadOf } from '../state.js';
import { tmpDir, writePack, seq } from './fixtures.js';

const { pack } = loadPack(writePack(tmpDir()));
const dir2 = writePack(tmpDir(), { 'ui.json': { reactions: { duck: 'duck.webp' }, stickers: { quack: 'duck.webp' } } });
const { pack: packUi } = loadPack(dir2);
let n = 0;
const ctx = (p = pack, now = 1_000_000) => ({ now, rng: seq(0.5), genId: (x) => `${x}_${++n}`, pack: p });
const gm = (s, a, p) => reduce(s, { role: 'gm', ...a }, ctx(p));
const pl = (s, id, a, p, now) => reduce(s, { role: 'player', actorId: id, ...a }, ctx(p, now));

function party(p = pack) {
  let s = createState(p, 0);
  const ids = [];
  for (const name of ['Carl', 'Donut', 'Katia']) { const r = gm(s, { t: 'player.add', name }, p); s = r.state; ids.push(r.result.playerId); }
  return { s, ids };
}

test('crawlers write to the GM, the party or each other; the GM sees every conversation', () => {
  let { s, ids: [c, d, k] } = party();
  let r = pl(s, c, { t: 'msg.post', to: [], text: 'psst GM' });
  s = r.state;
  assert.deepEqual(r.events[0].to, { roles: ['gm'], playerIds: [c] });
  assert.equal(r.events[0].event.fromId, c);
  s = pl(s, c, { t: 'msg.post', to: [d], text: 'Donut, flank left' }).state;
  s = pl(s, k, { t: 'msg.post', to: 'all', text: 'everyone run' }).state;
  s = gm(s, { t: 'msg.send', to: [c], text: 'noted' }).state;
  const g = viewFor(s, pack, 'gm', {}).gm.messages;
  assert.deepEqual(g.map((m) => [m.thread, m.fromId, m.gmRead]), [[c, c, false], [threadOf([c, d]), c, false], ['all', k, false], [c, 'gm', true]]);
  const kv = viewFor(s, pack, 'player', { playerId: k }).me.messages;
  assert.deepEqual(kv.map((m) => m.text), ['everyone run'], 'Katia sees only her conversations');
  const cv = viewFor(s, pack, 'player', { playerId: c }).me.messages;
  assert.equal(cv.length, 4);
  assert.equal(cv[0].read, true, 'own message counts as read');
  assert.equal(cv[3].thread, c, 'GM reply lands in the same DM thread');
  s = gm(s, { t: 'msg.gmRead', thread: c }).state;
  assert.equal(viewFor(s, pack, 'gm', {}).gm.messages.filter((m) => !m.gmRead).length, 2);
  s = pl(s, c, { t: 'msg.read', thread: c }).state;
  assert.ok(viewFor(s, pack, 'player', { playerId: c }).me.messages.filter((m) => m.thread === c).every((m) => m.read));
});

test('reactions toggle, only on messages you can see, and only known ids', () => {
  let { s, ids: [c, d, k] } = party();
  s = pl(s, c, { t: 'msg.post', to: [d], text: 'hi' }).state;
  const id = s.messages[0].id;
  s = pl(s, d, { t: 'msg.react', id, r: 'lol' }).state;
  s = gm(s, { t: 'msg.react', id, r: 'lol' }).state;
  assert.deepEqual(s.messages[0].reactions, { lol: [d, 'gm'] });
  s = pl(s, d, { t: 'msg.react', id, r: 'lol' }).state;
  assert.deepEqual(s.messages[0].reactions, { lol: ['gm'] });
  assert.throws(() => pl(s, k, { t: 'msg.react', id, r: 'lol' }), /no message/);
  assert.throws(() => pl(s, d, { t: 'msg.react', id, r: 'nope' }), /unknown reaction/);
});

test('pack reactions and stickers; sticker-only messages; GM pause; flood limit', () => {
  let { s, ids: [c] } = party(packUi);
  assert.ok(packUi.ui.stickers.quack.src.endsWith('duck.webp'));
  s = pl(s, c, { t: 'msg.post', to: 'all', icon: 'quack' }, packUi).state;
  assert.equal(s.messages[0].icon, 'quack');
  assert.throws(() => pl(s, c, { t: 'msg.post', to: 'all', icon: 'moo' }, packUi), /unknown sticker/);
  assert.throws(() => pl(s, c, { t: 'msg.post', to: 'all', text: '  ' }, packUi), /text or sticker/);
  s = pl(s, c, { t: 'msg.react', id: s.messages[0].id, r: 'duck' }, packUi).state;
  assert.throws(() => pl(s, c, { t: 'msg.react', id: s.messages[0].id, r: 'lol' }, packUi), /unknown reaction/);
  for (let i = 0; i < 7; i++) s = pl(s, c, { t: 'msg.post', to: [], text: `x${i}` }, packUi).state;
  assert.throws(() => pl(s, c, { t: 'msg.post', to: [], text: 'spam' }, packUi), /Slow down/);
  s = gm(s, { t: 'msg.players', on: false }, packUi).state;
  assert.equal(viewFor(s, packUi, 'player', { playerId: c }).session.chatPlayers, false);
  assert.throws(() => pl(s, c, { t: 'msg.post', to: [], text: 'hey' }, packUi, 2_000_000), /paused/);
  s = gm(s, { t: 'msg.delete', id: s.messages[0].id }, packUi).state;
  assert.equal(s.messages.length, 7);
});
