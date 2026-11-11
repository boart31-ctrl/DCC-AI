#!/usr/bin/env node
// End-to-end test of the Cloudflare edition on this machine:
//   build (packs/demo) → `wrangler dev` (real Worker + SQLite Durable Object, local) → GM / TV / players
//   over WebSocket → hard-kill wrangler right after an ack → restart → state, log and links survived →
//   restore point restores → HTTP hardening checks.
//
//   node tools/e2e_cloud.mjs            (npm run test:cloud)
// Env: E2E_DIR (work folder, default: OS temp), E2E_KEEP=1 (keep it).
// Exits 0 when wrangler is not installed (prints SKIP), 1 on any failure.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { build } from './build_cloud.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const KEY = 'e2e-gm-key-' + Math.random().toString(36).slice(2);

if (!fs.existsSync(WRANGLER)) {
  console.log('SKIP: wrangler is not installed (npm install)');
  process.exit(0);
}

const work = path.resolve(process.env.E2E_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'system-e2e-')));
const dist = path.join(work, 'dist');
const persist = path.join(work, 'state');
fs.rmSync(persist, { recursive: true, force: true });

const freePort = () => new Promise((r) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => r(port));
  });
});

let proc = null;
let output = '';
// Mock ElevenLabs (local HTTP, no network): the worker reaches it through ELEVENLABS_BASE_URL.
let mockBase = '';
const mockCalls = [];
const BIG = 2_500_000; // > 2 chunks: exercises the 1 MB chunking in Durable Object SQLite
function startMockEleven() {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      mockCalls.push(`${req.method} ${req.url.split('?')[0]}`);
      if (req.headers['xi-api-key'] !== 'sk-e2e') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"detail":{"status":"invalid_api_key","message":"bad key"}}'); }
      if (req.url === '/v1/voices') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ voices: [{ voice_id: 'premadeE2E1', name: 'Brian', category: 'premade' }, { voice_id: 'clonedE2E2', name: 'Clone', category: 'cloned' }] }));
      }
      if (req.url.startsWith('/v1/text-to-speech/premadeE2E1')) {
        const text = JSON.parse(body).text;
        const out = text === 'BIG LINE' ? Buffer.alloc(BIG, 7) : Buffer.from(`MP3:${text}`);
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        return res.end(out);
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => { mockBase = `http://127.0.0.1:${srv.address().port}`; srv.unref(); r(srv); }));
}
async function startWrangler(port) {
  output = '';
  proc = spawn(WRANGLER, ['dev', '--config', path.join(dist, 'wrangler.jsonc'), '--port', String(port), '--ip', '127.0.0.1',
    '--persist-to', persist, '--var', `GM_KEY:${KEY}`,
    '--var', 'ELEVENLABS_API_KEY:sk-e2e', '--var', `ELEVENLABS_BASE_URL:${mockBase}`, '--show-interactive-dev-session=false', '--log-level', 'info'], {
    cwd: work, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
  });
  proc.stdout.on('data', (d) => (output += d));
  proc.stderr.on('data', (d) => (output += d));
  const t0 = Date.now();
  while (!/Ready on/.test(output)) {
    if (proc.exitCode !== null) throw new Error(`wrangler exited:\n${output}`);
    if (Date.now() - t0 > 90_000) throw new Error(`wrangler did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
function killWrangler(signal = 'SIGKILL') {
  if (!proc) return;
  try {
    process.kill(-proc.pid, signal); // whole group: wrangler + workerd
  } catch {}
  proc = null;
}

function client(base, { origin = base } = {}) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { headers: origin ? { origin } : {} });
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  });
  ws.on('error', () => {});
  const next = (pred, ms = 5000, what = 'message') => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), ms).unref();
    });
  };
  const opened = new Promise((r, j) => {
    ws.once('open', r);
    ws.once('unexpected-response', (_q, res) => j(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', j);
  });
  const closed = new Promise((r) => ws.once('close', (code, reason) => r({ code, reason: String(reason) })));
  let n = 0;
  const call = async (a) => {
    const rid = `e${n++}`;
    ws.send(JSON.stringify({ ...a, rid }));
    const ack = await next((m) => m.t === 'ack' && m.rid === rid, 5000, `ack ${a.t}`);
    assert.equal(ack.ok, true, `${a.t}: ${JSON.stringify(ack)}`);
    return ack.result;
  };
  return { ws, inbox, next, call, opened, closed, send: (m) => ws.send(JSON.stringify(m)) };
}

async function hello(base, h) {
  const c = client(base);
  await c.opened;
  c.send({ t: 'hello', ...h });
  return c;
}

const step = (s) => console.log(`  • ${s}`);

async function main() {
  console.log(`e2e (cloud): work dir ${work}`);
  build(path.join(ROOT, 'packs', 'demo'), dist, { name: 'the-system-e2e', log: { log() {}, warn() {} } });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  await startMockEleven();
  await startWrangler(port);
  step(`wrangler dev up on ${base}`);

  // ---- HTTP surface ----
  let r = await fetch(`${base}/ws`);
  assert.equal(r.status, 426, '/ws without Upgrade');
  r = await fetch(`${base}/nope`);
  assert.equal(r.status, 404);
  r = await fetch(`${base}/pack/items.json`);
  assert.equal(r.status, 404, 'raw pack JSON is not served');
  r = await fetch(`${base}/api/export`);
  assert.equal(r.status, 401);
  for (const p of ['/', '/gm', '/tv', '/stage', '/join', '/play']) {
    r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), /text\/html/, p);
    assert.match(r.headers.get('x-robots-tag'), /noindex/, p);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/, p);
  }
  r = await fetch(`${base}/js/client.js`);
  assert.equal(r.status, 200);
  r = await fetch(`${base}/qr?text=hello`);
  assert.match(await r.text(), /^<svg/);
  await assert.rejects(client(base, { origin: 'https://evil.example' }).opened, /403/);
  await assert.rejects(client(base, { origin: null }).opened, /403/);
  step('HTTP routes, headers, 426/403/404 checks');

  // ---- GM, players, TV ----
  const bad = await hello(base, { role: 'gm', key: 'wrong' });
  assert.equal((await bad.next((m) => m.t === 'error')).code, 'bad_auth');
  assert.equal((await bad.closed).code, 4001);
  const gm = await hello(base, { role: 'gm', key: KEY });
  assert.equal((await gm.next((m) => m.t === 'welcome')).role, 'gm');
  const carl = (await gm.call({ t: 'player.add', name: 'Carl' })).playerId;
  const donut = (await gm.call({ t: 'player.add', name: 'Donut' })).playerId;
  const gv = await gm.next((m) => m.t === 'view' && m.view.gm.playersFull.length === 2 && m.view.gm.playersFull.every((p) => p.joinUrl));
  const urlOf = (v, id) => v.gm.playersFull.find((p) => p.id === id).joinUrl;
  const carlUrl = urlOf(gv.view, carl);
  assert.ok(carlUrl.startsWith(`${base}/p/`), carlUrl);
  const carlToken = carlUrl.split('/p/')[1];
  r = await fetch(carlUrl);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  step('GM key login, 2 players with personal links');

  const ph = await hello(base, { role: 'player', token: carlToken });
  assert.equal((await ph.next((m) => m.t === 'welcome')).playerId, carl);
  const tv = await hello(base, { role: 'stage', pair: true });
  const { code } = await tv.next((m) => m.t === 'pairing');
  assert.match(code, /^[A-Z]{4}$/);
  const { tvId } = await gm.call({ t: 'tv.pair', code, label: 'Living room' });
  const { tvToken } = await tv.next((m) => m.t === 'paired');
  assert.equal((await tv.next((m) => m.t === 'welcome')).role, 'stage');
  step(`player joined by link, TV paired with code ${code}`);

  // claim → approve
  const phone2 = await hello(base, { role: 'player', claim: true, name: 'Katia' });
  const claim = await phone2.next((m) => m.t === 'claim');
  assert.equal(claim.characters.length, 2);
  phone2.send({ t: 'claim.pick', playerId: donut, rid: 'pick' });
  await phone2.next((m) => m.rid === 'pick');
  await gm.next((m) => m.t === 'event' && m.event.kind === 'joinRequest');
  await gm.call({ t: 'player.approve', requestId: claim.requestId });
  const donutToken = (await phone2.next((m) => m.t === 'token')).token;
  assert.equal((await phone2.next((m) => m.t === 'welcome')).playerId, donut);
  step('join request approved, phone got its token');

  // gameplay
  const achId = (await gm.next((m) => m.t === 'view')).view.gm.achievementsCatalog[0].id;
  await gm.call({ t: 'ach.award', playerId: carl, achId });
  await ph.next((m) => m.t === 'event' && m.event.kind === 'achievement');
  await tv.next((m) => m.t === 'event' && m.event.kind === 'achievement');
  await tv.next((m) => m.t === 'play');
  await ph.call({ t: 'me.notes', text: 'remember the duck' });
  await gm.call({ t: 'msg.send', to: 'all', text: 'Floor 2 opens', onStage: true });
  await tv.next((m) => m.t === 'event' && m.event.kind === 'announcement');
  const manual = (await gm.call({ t: 'backup.create' })).id;
  await gm.call({ t: 'player.update', playerId: carl, gold: 99 });
  step('achievement → phone + TV + voice line, notes, announcement, restore point, gold 99');

  // ---- System voice (mock ElevenLabs): GM-only, cached in DO SQLite, big audio chunked ----
  const say = await gm.call({ t: 'tts.say', text: 'Hello crawlers.' });
  assert.match(say.url, /^\/api\/tts\/[0-9a-f]{64}\.mp3$/);
  const big = await gm.call({ t: 'tts.say', text: 'BIG LINE' });
  r = await fetch(base + say.url);
  assert.equal(r.status, 401, 'tts audio without the GM key');
  r = await fetch(base + say.url, { headers: { 'X-GM-Key': carlToken } });
  assert.equal(r.status, 401, 'a player link is not a GM key');
  r = await fetch(base + say.url, { headers: { 'X-GM-Key': KEY } });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'MP3:Hello crawlers.');
  r = await fetch(base + big.url, { headers: { 'X-GM-Key': KEY } });
  assert.equal((await r.arrayBuffer()).byteLength, BIG, '2.5 MB audio through 1 MB SQLite chunks');
  ph.send({ t: 'tts.say', text: 'x', rid: 'ptts' });
  assert.equal((await ph.next((m) => m.rid === 'ptts')).ok, false, 'players cannot use tts');
  tv.send({ t: 'tts.line', id: 'q_x', rid: 'ttts' });
  assert.equal((await tv.next((m) => m.rid === 'ttts')).ok, false, 'the TV cannot use tts');
  const bad2 = await gm.call({ t: 'tts.voices' });
  assert.deepEqual(bad2.voices.map((v) => v.id), ['premadeE2E1'], 'cloned voices hidden');
  const ttsCalls = mockCalls.filter((c) => c.startsWith('POST')).length;
  await gm.call({ t: 'tts.say', text: 'Hello crawlers.' });
  assert.equal(mockCalls.filter((c) => c.startsWith('POST')).length, ttsCalls, 'second say served from cache');
  step(`System voice: ${ttsCalls} ElevenLabs renders (mocked), GM-only audio route, 2.5 MB line chunked, cache hit`);

  // ---- crash: kill -9 immediately after the last ack ----
  killWrangler('SIGKILL');
  await Promise.race([gm.closed, new Promise((r) => setTimeout(r, 3000))]);
  await startWrangler(port);
  step('wrangler killed (SIGKILL) and restarted');

  const gm2 = await hello(base, { role: 'gm', key: KEY });
  const w2 = await gm2.next((m) => m.t === 'welcome');
  const p2 = w2.view.gm.playersFull;
  assert.deepEqual(p2.map((p) => p.name), ['Carl', 'Donut']);
  const c2 = p2.find((p) => p.id === carl);
  assert.equal(c2.gold, 99, 'last acked change survived the crash');
  assert.equal(c2.notes, 'remember the duck');
  assert.equal(c2.achievements.length, 1);
  assert.equal(urlOf(w2.view, carl), carlUrl, 'links unchanged');
  assert.deepEqual(w2.view.gm.tvs.map((t) => t.id), [tvId]);
  const ph2 = await hello(base, { role: 'player', token: carlToken });
  assert.equal((await ph2.next((m) => m.t === 'welcome')).view.me.notes, 'remember the duck');
  const dn2 = await hello(base, { role: 'player', token: donutToken });
  assert.equal((await dn2.next((m) => m.t === 'welcome')).playerId, donut);
  const tv2 = await hello(base, { role: 'stage', tvToken });
  assert.equal((await tv2.next((m) => m.t === 'welcome')).role, 'stage', 'TV reconnects without pairing again');
  r = await fetch(base + big.url, { headers: { 'X-GM-Key': KEY } });
  assert.equal((await r.arrayBuffer()).byteLength, BIG, 'voice cache survived the crash');
  assert.ok(w2.view.gm.tts.configured && w2.view.gm.tts.usage.chars >= 'Hello crawlers.BIG LINE'.length);
  assert.equal(JSON.stringify(w2.view).includes('sk-e2e'), false, 'ElevenLabs key never in a view');
  step('state, links, TV token and voice cache survived; everyone reconnected');

  // ---- export + log ----
  r = await fetch(`${base}/api/export?kind=campaign`, { headers: { 'X-GM-Key': KEY } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="system-campaign-/);
  const exp = await r.json();
  const types = exp.log.map((e) => e.action.t);
  for (const t of ['player.add', 'tv.pair', 'player.approve', 'ach.award', 'me.notes', 'msg.send', 'player.update']) assert.ok(types.includes(t), `log has ${t}: ${types.join(',')}`);
  assert.equal(exp.log.at(-1).action.gold, 99, 'last action is in the log');
  assert.ok(exp.log.every((e, i) => i === 0 || e.seq > exp.log[i - 1].seq));
  const logText = JSON.stringify(exp.log);
  for (const secret of [carlToken, donutToken, tvToken, KEY, code]) assert.equal(logText.includes(secret), false, 'no secrets in the log');
  assert.equal(exp.state.host.playerTokens[carl], carlToken, 'GM export carries the state incl. links');
  r = await fetch(`${base}/api/export?kind=session`, { headers: { 'X-GM-Key': KEY } });
  const sess = await r.json();
  assert.ok(sess.log.length > 0 && sess.log.every((e) => e.at >= sess.session.startedAt));
  step(`export: ${exp.log.length} log entries, ${exp.snapshots.length} restore points, no secrets in the log`);

  // ---- restore ----
  const { backups } = await gm2.call({ t: 'backup.list' });
  assert.ok(backups.some((b) => b.id === manual && b.reason === 'manual'));
  await gm2.call({ t: 'backup.restore', id: manual });
  const rv = await gm2.next((m) => m.t === 'view' && m.view.gm.playersFull.find((p) => p.id === carl)?.gold !== 99, 5000, 'restored view');
  assert.equal(rv.view.gm.playersFull.find((p) => p.id === carl).gold, 0);
  const after = (await gm2.call({ t: 'backup.list' })).backups;
  assert.equal(after[0].reason, 'before-restore');
  assert.equal(ph2.inbox.some((m) => m.t === 'error'), false);
  // undo the restore
  await gm2.call({ t: 'backup.restore', id: after[0].id });
  await gm2.next((m) => m.t === 'view' && m.view.gm.playersFull.find((p) => p.id === carl)?.gold === 99, 5000, 'undo view');
  step('restore point restored (gold 99 → 0) and the automatic before-restore point undid it');

  // ---- revoke + relink ----
  await gm2.call({ t: 'tv.unpair', tvId });
  assert.equal((await tv2.closed).code, 4001);
  const { joinUrl } = await gm2.call({ t: 'player.relink', playerId: carl });
  assert.notEqual(joinUrl, carlUrl);
  assert.equal((await ph2.closed).code, 4001);
  const old = await hello(base, { role: 'player', token: carlToken });
  assert.equal((await old.next((m) => m.t === 'error')).code, 'bad_auth');
  step('TV unpaired and player relinked: old credentials closed and refused');

  for (const c of [gm2, dn2]) c.ws.close();
  console.log('e2e (cloud): PASS');
}

main()
  .catch((e) => {
    console.error('e2e (cloud): FAIL\n', e);
    if (output) console.error('--- wrangler output (tail) ---\n' + output.split('\n').slice(-40).join('\n'));
    process.exitCode = 1;
  })
  .finally(() => {
    killWrangler('SIGTERM');
    if (!process.env.E2E_KEEP && !process.env.E2E_DIR) fs.rmSync(work, { recursive: true, force: true });
    setTimeout(() => process.exit(), 300).unref();
  });
