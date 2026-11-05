import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../index.js';
import { tmpDir, writePack } from './fixtures.js';

const silent = { log() {}, warn() {}, error() {} };
let srv, base, wsUrl, root;

before(async () => {
  root = tmpDir();
  const webDir = path.join(root, 'web');
  fs.mkdirSync(webDir);
  fs.writeFileSync(path.join(webDir, 'gm.html'), '<h1>gm</h1>');
  fs.writeFileSync(path.join(webDir, 'manifest.webmanifest'), '{}');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'nope');
  srv = await startServer({
    port: 0,
    host: '127.0.0.1',
    publicHost: '127.0.0.1',
    packDir: writePack(path.join(root, 'pack')),
    dataDir: path.join(root, 'data'),
    webDir,
    env: {},
    log: silent,
    chat: false,
  });
  base = `http://127.0.0.1:${srv.port}`;
  wsUrl = `ws://127.0.0.1:${srv.port}/ws`;
});

after(() => srv?.close());

/** Connects, collects every message, and offers next(predicate) to await a specific one. */
function client() {
  const ws = new WebSocket(wsUrl);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  });
  const next = (pred, ms = 2000) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error('timeout waiting for message')), ms).unref();
    });
  };
  const send = (m) => ws.send(JSON.stringify(m));
  const opened = new Promise((r) => ws.once('open', r));
  const closed = new Promise((r) => ws.once('close', (code) => r(code)));
  return { ws, next, send, opened, closed, inbox };
}

async function hello(m) {
  const c = client();
  await c.opened;
  c.send({ t: 'hello', ...m });
  return c;
}

test('static routes, content types, traversal protection, qr', async () => {
  let r = await fetch(`${base}/gm`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  r = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(r.headers.get('content-type'), 'application/manifest+json');
  r = await fetch(`${base}/pack/images/duck.webp`);
  assert.equal(r.headers.get('content-type'), 'image/webp');
  r = await fetch(`${base}/pack/audio/nat1_01.mp3`);
  assert.equal(r.headers.get('content-type'), 'audio/mpeg');
  for (const bad of ['/pack/..%2f..%2fsecret.txt', '/..%2fsecret.txt', '/pack/%2e%2e/%2e%2e/secret.txt', '/pack/pack.json%00']) {
    r = await fetch(base + bad);
    assert.notEqual(r.status, 200, bad);
    assert.notEqual(await r.text(), 'nope');
  }
  r = await fetch(`${base}/qr?text=hello`);
  assert.equal(r.headers.get('content-type'), 'image/svg+xml');
  assert.match(await r.text(), /<svg/);
});

test('full flow: handshake, award, loot, quip → play, audio.done releases next', async () => {
  const gm = await hello({ role: 'gm', token: srv.state.gmToken });
  const w = await gm.next((m) => m.t === 'welcome');
  assert.equal(w.role, 'gm');
  assert.ok(w.view.gm.joinUrl.includes(srv.state.room));

  // bad auth closes the socket
  const bad = await hello({ role: 'gm', token: 'x' });
  assert.equal((await bad.next((m) => m.t === 'error')).code, 'bad_auth');
  await bad.closed;

  gm.send({ t: 'player.add', name: 'Carl', pin: '4321', rid: 'r1' });
  const ack = await gm.next((m) => m.t === 'ack' && m.rid === 'r1');
  assert.equal(ack.ok, true, JSON.stringify(ack));
  const playerId = ack.result.playerId;

  const stage = await hello({ role: 'stage', token: srv.state.stageToken });
  const sw = await stage.next((m) => m.t === 'welcome');
  assert.equal(sw.view.joinUrl, srv.urls.join);

  const pl = await hello({ role: 'player', room: srv.state.room, pin: '4321' });
  const pw = await pl.next((m) => m.t === 'welcome');
  assert.equal(pw.playerId, playerId);
  assert.deepEqual(pw.view.me.resources, { hp: { cur: 10, max: 10 } });
  const gv = await gm.next((m) => m.t === 'view' && m.view.players[0]?.connected);
  assert.equal(gv.view.players[0].name, 'Carl');

  // malformed input never crashes
  gm.ws.send('not json');
  assert.equal((await gm.next((m) => m.t === 'error')).code, 'bad_request');
  gm.send({ t: 'nope', rid: 'x' });
  assert.equal((await gm.next((m) => m.rid === 'x')).error, 'bad_request');
  pl.send({ t: 'player.add', name: 'hack', rid: 'h' });
  assert.equal((await pl.next((m) => m.rid === 'h')).ok, false);

  // achievement → event to all + P1 line on stage
  gm.send({ t: 'ach.award', playerId, achId: 'first_blood', rid: 'a' });
  assert.equal((await gm.next((m) => m.rid === 'a')).ok, true);
  const pev = await pl.next((m) => m.t === 'event' && m.event.kind === 'achievement');
  assert.equal(pev.event.title, 'First Blood');
  const p1 = await stage.next((m) => m.t === 'play');
  assert.equal(p1.priority, 1);
  assert.equal(p1.text, 'Blood!');
  assert.equal(p1.voice.id, 'host');
  assert.equal(p1.voice.rate, 1.1);

  // loot while P1 plays → loot line queued behind it
  gm.send({ t: 'loot.open', playerId, tier: 'gold', rid: 'l' });
  const lack = await gm.next((m) => m.rid === 'l');
  assert.equal(lack.result.itemId, 'crown');
  const lev = await stage.next((m) => m.t === 'event' && m.event.kind === 'loot');
  assert.equal(lev.event.item.name, 'Crown');

  // GM button (P0) plays immediately even while P1 is playing; per-voice audio wins
  gm.send({ t: 'session.voice', voice: 'gremlin' });
  gm.send({ t: 'quip.play', quipId: 'nat1_01', rid: 'q' });
  await gm.next((m) => m.rid === 'q');
  const p0 = await stage.next((m) => m.t === 'play');
  assert.equal(p0.priority, 0);
  assert.equal(p0.audio, '/pack/audio/gremlin/nat1_01.mp3');
  assert.equal(p0.voice.id, 'gremlin');

  // finishing P0 releases the queued loot line
  assert.equal(stage.inbox.some((m) => m.t === 'play'), false);
  stage.send({ t: 'audio.done', id: p0.id });
  const next = await stage.next((m) => m.t === 'play');
  assert.equal(next.priority, 1);
  assert.equal(next.text, 'Loot!');

  // stat event reaches player + stage
  gm.send({ t: 'player.resource', playerId, res: 'hp', delta: -3 });
  const se = await stage.next((m) => m.t === 'event' && m.event.kind === 'stat');
  assert.deepEqual([se.event.from, se.event.to], [10, 7]);
  await pl.next((m) => m.t === 'event' && m.event.kind === 'stat');

  // player notes
  pl.send({ t: 'me.notes', text: 'remember the duck', rid: 'n' });
  assert.equal((await pl.next((m) => m.rid === 'n')).ok, true);
  const pv = await pl.next((m) => m.t === 'view' && m.view.me.notes === 'remember the duck');
  assert.equal(pv.view.me.inventory[0].itemId, 'crown');

  // group message with onStage → player event + view, stage announcement
  gm.send({ t: 'msg.send', to: 'all', text: 'Floor 2 opens', onStage: true, rid: 'm' });
  const mid = (await gm.next((m) => m.rid === 'm')).result.id;
  const pm = await pl.next((m) => m.t === 'event' && m.event.kind === 'message');
  assert.deepEqual([pm.event.id, pm.event.group, pm.event.to], [mid, true, 'all']);
  const an = await stage.next((m) => m.t === 'event' && m.event.kind === 'announcement');
  assert.equal(an.event.text, 'Floor 2 opens');
  const mv = await pl.next((m) => m.t === 'view' && m.view.me.messages.length === 1);
  assert.equal(mv.view.me.messages[0].group, true);

  // queue.clear sends stop
  gm.send({ t: 'queue.clear' });
  await stage.next((m) => m.t === 'stop');

  // oversize message closes the socket instead of crashing the server
  pl.ws.send(JSON.stringify({ t: 'me.notes', text: 'x'.repeat(20_000) }));
  await pl.closed;
  const gv2 = await gm.next((m) => m.t === 'view' && m.view.players[0].connected === false);
  assert.equal(gv2.view.players[0].connected, false);

  // session.new archives the log
  gm.send({ t: 'session.new', rid: 's' });
  await gm.next((m) => m.rid === 's');
  const archived = fs.readdirSync(path.join(root, 'data', 'sessions'));
  assert.equal(archived.length, 1);
  const arch = JSON.parse(fs.readFileSync(path.join(root, 'data', 'sessions', archived[0])));
  assert.ok(arch.log.some((e) => e.kind === 'achievement'));
  assert.equal(JSON.stringify(arch).includes('4321'), false, 'PINs not in archive');

  gm.ws.close();
  stage.ws.close();
});

test('player PIN rate limit over the wire', async () => {
  for (let i = 0; i < 5; i++) {
    const c = await hello({ role: 'player', room: srv.state.room, pin: '0000' });
    assert.equal((await c.next((m) => m.t === 'error')).code, 'bad_auth');
  }
  const c = await hello({ role: 'player', room: srv.state.room, pin: '4321' });
  assert.equal((await c.next((m) => m.t === 'error')).code, 'rate_limited');
});

test('state persists across restart', async () => {
  await srv.close();
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'data', 'state.json')));
  const srv2 = await startServer({
    port: 0, host: '127.0.0.1', publicHost: '127.0.0.1',
    packDir: path.join(root, 'pack'), dataDir: path.join(root, 'data'),
    webDir: path.join(root, 'web'), env: {}, log: silent, chat: false,
  });
  try {
    assert.equal(srv2.state.room, saved.room);
    assert.equal(srv2.state.gmToken, saved.gmToken);
    assert.equal(srv2.state.players[0].name, 'Carl');
    assert.equal(srv2.state.players[0].resources.hp.cur, 7);
  } finally {
    await srv2.close();
    srv = null;
  }
});
