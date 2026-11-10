// Node edition speaks the new access model too (GM key, player links, TV pairing) next to the legacy flow.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../index.js';
import { tmpDir, writePack } from './fixtures.js';

const silent = { log() {}, warn() {}, error() {} };
let srv, base, root;

before(async () => {
  root = tmpDir();
  const webDir = path.join(root, 'web');
  fs.mkdirSync(webDir);
  for (const f of ['play.html', 'stage.html', 'gm.html']) fs.writeFileSync(path.join(webDir, f), `<h1>${f}</h1>`);
  srv = await startServer({
    port: 0, host: '127.0.0.1', publicHost: '127.0.0.1', packDir: writePack(path.join(root, 'pack')),
    dataDir: path.join(root, 'data'), webDir, env: { GM_KEY: 'node-gm-key-123456' }, log: silent, chat: false,
  });
  base = `http://127.0.0.1:${srv.port}`;
});
after(() => srv?.close());

function client(headers = {}) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers });
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  });
  ws.on('error', () => {});
  const next = (pred, ms = 2000) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout')), ms).unref();
    });
  };
  const opened = new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const closed = new Promise((r) => ws.once('close', (code, reason) => r({ code, reason: String(reason) })));
  return { ws, next, send: (m) => ws.send(JSON.stringify(m)), opened, closed };
}

test('routes: /p/<token>, /tv, /join pages, /api/info, security headers', async () => {
  let r = await fetch(`${base}/p/abcdefghijklmnopqrstuvwxyz012345`);
  assert.equal(await r.text(), '<h1>play.html</h1>');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(await (await fetch(`${base}/tv`)).text(), '<h1>stage.html</h1>');
  assert.equal(await (await fetch(`${base}/join`)).text(), '<h1>play.html</h1>');
  assert.equal((await fetch(`${base}/p/short`)).status, 404);
  assert.deepEqual(await (await fetch(`${base}/api/info`)).json(), { edition: 'node', legacy: true, keyLogin: true });
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
});

test('GM key + player link + TV pairing over the wire; export needs the key; foreign Origin refused', async () => {
  const evil = client({ origin: 'http://evil.example' });
  await assert.rejects(evil.opened);

  const gm = client({ origin: base });
  await gm.opened;
  gm.send({ t: 'hello', role: 'gm', key: 'node-gm-key-123456' });
  const w = await gm.next((m) => m.t === 'welcome');
  assert.equal(w.view.gm.access.edition, 'node');
  gm.send({ t: 'player.add', name: 'Carl', rid: 'a' });
  const pid = (await gm.next((m) => m.rid === 'a')).result.playerId;
  const v = await gm.next((m) => m.t === 'view' && m.view.gm.playersFull.length === 1);
  const url = v.view.gm.playersFull[0].joinUrl;
  assert.ok(url.startsWith(`${base}/p/`));
  assert.ok(Object.keys(v.view.gm.pins).length === 1, 'legacy PINs still shown in the Node edition');

  const ph = client();
  await ph.opened;
  ph.send({ t: 'hello', role: 'player', token: url.split('/p/')[1] });
  assert.equal((await ph.next((m) => m.t === 'welcome')).playerId, pid);

  const tv = client();
  await tv.opened;
  tv.send({ t: 'hello', role: 'stage', pair: true });
  const { code } = await tv.next((m) => m.t === 'pairing');
  gm.send({ t: 'tv.pair', code, rid: 'p' });
  assert.equal((await gm.next((m) => m.rid === 'p')).ok, true);
  const paired = await tv.next((m) => m.t === 'paired');
  assert.equal((await tv.next((m) => m.t === 'welcome')).role, 'stage');

  // restore points are files under data/snapshots
  gm.send({ t: 'backup.list', rid: 'b' });
  const list = (await gm.next((m) => m.rid === 'b')).result.backups;
  assert.ok(list.length >= 1);

  let r = await fetch(`${base}/api/export?kind=session`);
  assert.equal(r.status, 401);
  r = await fetch(`${base}/api/export?kind=session`, { headers: { 'x-gm-key': 'node-gm-key-123456' } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment/);
  const data = await r.json();
  assert.equal(data.state.players[0].name, 'Carl');
  assert.ok(data.log.some((e) => e.kind === 'action' && e.action.t === 'tv.pair'));
  assert.equal(JSON.stringify(data.log).includes(paired.tvToken), false, 'tokens are not in the log');
  r = await fetch(`${base}/api/export`, { headers: { 'x-gm-token': srv.state.gmToken } });
  assert.equal(r.status, 200, 'legacy GM token works for export in Node');

  for (const c of [gm, ph, tv]) c.ws.close();
});
