// System voice (ElevenLabs): cache keys, LRU, chunking, stores, REST client with a mocked fetch, host
// integration (GM-only actions, play hints, achievement announcements, TV sync) and the Node audio route.
// No real network calls: every fetch here is a mock.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  sha256Hex, ttsKey, chunkBytes, joinChunks, memoryTtsStore, sqlTtsStore, createTtsCache, createElevenLabs, createLimiter,
  voiceLines, achievementText, achievementMode, TtsError, DEFAULT_MODEL, DEFAULT_FORMAT,
} from '../tts.js';
import { fileTtsStore } from '../tts-node.js';
import { createHost, LIMITS } from '../host.js';
import { createState } from '../state.js';
import { loadPack } from '../pack.js';
import { startServer } from '../index.js';
import { checkIsomorphic } from '../check-isomorphic.js';
import { tmpDir, writePack } from './fixtures.js';

const silent = { log() {}, warn() {}, error() {} };
const KEY = 'tts-test-gm-key-0123456789';
const here = path.dirname(new URL(import.meta.url).pathname);

/* ---------- mocked ElevenLabs ---------- */

function mockEleven({ fail = null } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: String(url), path: u.pathname, init, body: init.body ? JSON.parse(init.body) : null });
    if (u.hostname === 'cdn.example') return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
    if (init.headers?.['xi-api-key'] !== 'sk-test') return new Response(JSON.stringify({ detail: { status: 'invalid_api_key', message: 'bad key' } }), { status: 401 });
    if (fail) return fail(u);
    if (u.pathname === '/v1/voices') {
      return Response.json({ voices: [
        { voice_id: 'premadeAAAA', name: 'Brian', category: 'premade', preview_url: 'https://cdn.example/brian.mp3', labels: { accent: 'american' } },
        { voice_id: 'clonedBBBB', name: 'Somebody Real', category: 'cloned' },
        { voice_id: 'designCCCC', name: 'Gremlin', category: 'generated' },
        { voice_id: 'proDDDD', name: 'Pro clone', category: 'professional' },
      ] });
    }
    if (u.pathname === '/v1/models') return Response.json([{ model_id: 'eleven_multilingual_v2', name: 'Multilingual v2', can_do_text_to_speech: true, maximum_text_length_per_request: 10000, model_rates: { character_cost_multiplier: 1 } }, { model_id: 'sts', can_do_text_to_speech: false }]);
    if (u.pathname === '/v1/user/subscription') return Response.json({ tier: 'free', character_count: 120, character_limit: 10000 });
    const m = /^\/v1\/text-to-speech\/([^/]+)$/.exec(u.pathname);
    if (m && init.method === 'POST') return new Response(new TextEncoder().encode(`MP3:${m[1]}:${JSON.parse(init.body).text}`), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    return new Response('nope', { status: 404 });
  };
  return { fetch, calls, tts: () => calls.filter((c) => c.path.startsWith('/v1/text-to-speech/')) };
}

/* ---------- pure pieces ---------- */

test('tts modules are browser/Workers-safe', () => {
  for (const f of ['tts.js', 'tts-host.js']) assert.deepEqual(checkIsomorphic(path.join(here, '..', f)).problems, [], f);
});

test('sha256Hex matches node:crypto (ascii, unicode, block boundaries)', () => {
  for (const s of ['', 'abc', 'Příliš žluťoučký kůň 🎲', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'w'.repeat(1000)]) {
    assert.equal(sha256Hex(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'));
  }
});

test('ttsKey: stable, whitespace-normalised, differs by voice / model / format / text', () => {
  const base = { voiceId: 'v1', modelId: 'm1', text: 'Hello crawler.' };
  const k = ttsKey(base);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(ttsKey({ ...base, text: '  Hello   crawler. ' }), k);
  assert.notEqual(ttsKey({ ...base, voiceId: 'v2' }), k);
  assert.notEqual(ttsKey({ ...base, modelId: 'm2' }), k);
  assert.notEqual(ttsKey({ ...base, format: 'mp3_44100_128' }), k);
  assert.notEqual(ttsKey({ ...base, text: 'Hello crawler!' }), k);
});

test('chunkBytes / joinChunks round-trip, sizes', () => {
  const b = new Uint8Array(2_500_001).map((_, i) => i % 251);
  const parts = chunkBytes(b, 1_000_000);
  assert.deepEqual(parts.map((p) => p.length), [1_000_000, 1_000_000, 500_001]);
  assert.deepEqual(joinChunks(parts), b);
  assert.equal(chunkBytes(new Uint8Array(0)).length, 1);
  assert.equal(chunkBytes(new Uint8Array(1_000_000), 1_000_000).length, 1);
  assert.throws(() => chunkBytes(b, 0));
});

test('LRU cache evicts least recently used, keeps the new entry, a get counts as a use', () => {
  let t = 0;
  const cache = createTtsCache(memoryTtsStore(), { capBytes: 300, now: () => ++t });
  const blob = (n) => new Uint8Array(n);
  cache.put('a'.repeat(64), blob(100));
  cache.put('b'.repeat(64), blob(100));
  cache.put('c'.repeat(64), blob(100));
  assert.ok(cache.get('a'.repeat(64))); // a is now newest
  const gone = cache.put('d'.repeat(64), blob(100));
  assert.deepEqual(gone, ['b'.repeat(64)]);
  assert.equal(cache.has('a'.repeat(64)), true);
  assert.equal(cache.stats().bytes, 300);
  assert.deepEqual(cache.put('e'.repeat(64), blob(250)).sort(), ['a'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)].sort());
  assert.equal(cache.stats().count, 1);
  assert.throws(() => cache.put('f'.repeat(64), blob(301)), (e) => e instanceof TtsError && e.code === 'too_big');
});

function sqliteAdapter() {
  const db = new DatabaseSync(':memory:');
  const conv = (v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);
  return {
    db,
    exec(q, ...args) {
      const st = db.prepare(q);
      const rows = /^\s*(SELECT|PRAGMA)/i.test(q) ? st.all(...args.map(conv)) : (st.run(...args.map(conv)), []);
      return { toArray: () => rows, one: () => rows[0] };
    },
  };
}

test('sqlTtsStore (Durable Object SQLite shape): chunks ≤ 1 MB per row, round-trips, LRU over it', () => {
  const sql = sqliteAdapter();
  const store = sqlTtsStore(sql, (fn) => { sql.db.exec('BEGIN'); try { fn(); sql.db.exec('COMMIT'); } catch (e) { sql.db.exec('ROLLBACK'); throw e; } });
  const big = new Uint8Array(2_300_000).map((_, i) => (i * 7) % 256);
  const h = 'f'.repeat(64);
  store.put(h, big, { chars: 12, at: 5, text: 'hello' });
  const rows = sql.db.prepare('SELECT part, length(data) AS n FROM tts_chunk WHERE hash = ? ORDER BY part').all(h);
  assert.deepEqual(rows.map((r) => r.n), [1_000_000, 1_000_000, 300_000]);
  assert.ok(rows.every((r) => r.n <= 2 * 1024 * 1024));
  assert.deepEqual(store.get(h), big);
  assert.deepEqual(store.stats(), { bytes: 2_300_000, count: 1 });
  store.put(h, new Uint8Array([1, 2, 3])); // overwrite drops old chunks
  assert.equal(sql.db.prepare('SELECT COUNT(*) AS n FROM tts_chunk').get().n, 1);
  assert.deepEqual(store.get(h), new Uint8Array([1, 2, 3]));
  // torn write (a chunk missing) reads as a miss
  store.put('e'.repeat(64), new Uint8Array(1_500_000));
  sql.db.prepare('DELETE FROM tts_chunk WHERE hash = ? AND part = 1').run('e'.repeat(64));
  assert.equal(store.get('e'.repeat(64)), null);
  let t = 0;
  const cache = createTtsCache(store, { capBytes: 1_600_000, now: () => ++t });
  cache.put('d'.repeat(64), new Uint8Array(200_000));
  assert.equal(store.has('e'.repeat(64)), false, 'oldest evicted');
  store.clear();
  assert.deepEqual(store.stats(), { bytes: 0, count: 0 });
  assert.equal(sql.db.prepare('SELECT COUNT(*) AS n FROM tts_chunk').get().n, 0);
});

test('fileTtsStore (Node): files + index survive a reopen, clear removes files', () => {
  const dir = path.join(tmpDir(), 'tts');
  const s1 = fileTtsStore(dir);
  const h = 'a'.repeat(64);
  s1.put(h, new Uint8Array([1, 2, 3]), { chars: 3, at: 7 });
  assert.ok(fs.existsSync(path.join(dir, `${h}.mp3`)));
  s1.flush();
  const s2 = fileTtsStore(dir);
  assert.deepEqual(s2.get(h), new Uint8Array([1, 2, 3]));
  assert.deepEqual(s2.entries(), [{ hash: h, size: 3, at: 7 }]);
  assert.throws(() => s2.put('../etc', new Uint8Array(1)));
  s2.clear();
  assert.equal(fs.existsSync(path.join(dir, `${h}.mp3`)), false);
});

test('ElevenLabs client: endpoint, header, body, output_format; errors mapped', async () => {
  const m = mockEleven();
  const el = createElevenLabs({ apiKey: 'sk-test', fetch: m.fetch });
  const bytes = await el.tts({ voiceId: 'premadeAAAA', text: ' Hi  there ', voiceSettings: { stability: 0.4, similarity_boost: 0.8 } });
  assert.equal(new TextDecoder().decode(bytes), 'MP3:premadeAAAA:Hi there');
  const c = m.calls[0];
  assert.equal(c.url, `https://api.elevenlabs.io/v1/text-to-speech/premadeAAAA?output_format=${DEFAULT_FORMAT}`);
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers['xi-api-key'], 'sk-test');
  assert.deepEqual(c.body, { text: 'Hi there', model_id: DEFAULT_MODEL, voice_settings: { stability: 0.4, similarity_boost: 0.8 } });
  assert.equal((await el.voices()).length, 4);
  assert.equal((await el.models()).length, 2);
  await assert.rejects(createElevenLabs({ apiKey: 'wrong', fetch: m.fetch }).voices(), (e) => e.code === 'bad_key' && e.status === 401);
  const busy = createElevenLabs({ apiKey: 'sk-test', fetch: mockEleven({ fail: () => new Response(JSON.stringify({ detail: { status: 'too_many_concurrent_requests', message: 'slow down' } }), { status: 429 }) }).fetch });
  await assert.rejects(busy.tts({ voiceId: 'x', text: 'a' }), (e) => e.code === 'busy');
  const quota = createElevenLabs({ apiKey: 'sk-test', fetch: mockEleven({ fail: () => new Response(JSON.stringify({ detail: { status: 'quota_exceeded', message: 'quota' } }), { status: 429 }) }).fetch });
  await assert.rejects(quota.tts({ voiceId: 'x', text: 'a' }), (e) => e.code === 'quota');
  const off = createElevenLabs({ apiKey: 'sk-test', fetch: async () => { throw new Error('ENOTFOUND'); } });
  await assert.rejects(off.tts({ voiceId: 'x', text: 'a' }), (e) => e.code === 'offline');
  assert.throws(() => createElevenLabs({ apiKey: '' }), (e) => e.code === 'no_key');
});

test('limiter: max 2 in flight, live lines (priority 0) before pre-renders (1)', async () => {
  const lim = createLimiter(2);
  let active = 0, peak = 0;
  const order = [];
  const job = (name) => async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); order.push(name); active--; };
  await Promise.all([lim.run(job('p1'), 1), lim.run(job('p2'), 1), lim.run(job('p3'), 1), lim.run(job('live'), 0)]);
  assert.equal(peak, 2);
  assert.ok(order.indexOf('live') < order.indexOf('p3'));
});

test('achievement announcement text and the list of known lines', () => {
  const { pack } = loadPack(writePack(tmpDir()));
  const a = pack.achievementsById.get('first_blood');
  assert.equal(achievementText(pack, a), 'New achievement! First Blood. You hit something. Reward: Bronze Box.');
  assert.equal(achievementText(pack, a, { achievementReward: false, achievementDesc: false }), 'New achievement! First Blood.');
  assert.equal(achievementMode({ achievementLine: 'auto' }, true), 'announce');
  assert.equal(achievementMode({ achievementLine: 'auto' }, false), 'quip');
  const st = { library: { boss: [{ id: 'hb', intro: 'Behold.', defeatLine: 'Ow.' }] } };
  const lines = voiceLines(pack, st, { achievementLine: 'announce' });
  assert.ok(lines.some((l) => l.kind === 'achievement' && l.text.startsWith('New achievement! First Blood.')));
  assert.ok(lines.some((l) => l.kind === 'boss' && l.text === 'Behold.'));
  assert.ok(lines.some((l) => l.kind === 'quip'));
  assert.equal(new Set(lines.map((l) => l.text)).size, lines.length, 'deduplicated');
  assert.equal(voiceLines(pack, st, { achievementLine: 'quip' }).some((l) => l.kind === 'achievement'), false);
});

/* ---------- host integration ---------- */

const hosts = [];
after(() => { for (const h of hosts) h.close(); });

function setup({ tts = {}, fetch } = {}) {
  const { pack } = loadPack(writePack(tmpDir()));
  const m = mockEleven();
  const host = createHost({
    pack, state: createState(pack, Date.now()), log: silent, chat: false, gmKey: KEY, legacy: false, base: 'https://game.example',
    send: (conn, text) => conn.inbox.push(JSON.parse(text)),
    close: (conn, code, reason) => { conn.closed = { code, reason }; },
    tts: { apiKey: 'sk-test', store: memoryTtsStore(), fetch: fetch ?? m.fetch, ...tts },
  });
  hosts.push(host);
  let n = 0;
  const sock = () => {
    const conn = { id: n++, inbox: [] };
    host.connect(conn, { ip: '10.0.0.1' });
    conn.send = (x) => host.message(conn, JSON.stringify(x));
    conn.all = (t) => conn.inbox.filter((x) => x.t === t);
    conn.last = (t) => conn.all(t).at(-1);
    return conn;
  };
  const gm = () => { const s = sock(); s.send({ t: 'hello', role: 'gm', key: KEY }); return s; };
  return { host, pack, m, sock, gm };
}

async function act(c, a) {
  const rid = `r${Math.random()}`;
  c.send({ ...a, rid });
  for (let i = 0; i < 200; i++) {
    const ack = c.inbox.find((x) => x.t === 'ack' && x.rid === rid);
    if (ack) return ack;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`no ack for ${a.t}`);
}

test('tts.say: synthesizes once, caches, pushes a P0 play whose tts hint says cached; usage counted', async () => {
  const { host, m, gm } = setup();
  const g = gm();
  const r = await act(g, { t: 'tts.say', text: 'Welcome, crawlers.' });
  assert.equal(r.ok, true, r.msg);
  assert.match(r.result.url, /^\/api\/tts\/[0-9a-f]{64}\.mp3$/);
  assert.equal(r.result.cached, false);
  const play = g.last('play');
  assert.equal(play.text, 'Welcome, crawlers.');
  assert.deepEqual(play.tts, { hash: r.result.hash, cached: true, url: r.result.url });
  assert.equal(play.sync, true);
  assert.equal(new TextDecoder().decode(host.tts.audio(r.result.hash)), 'MP3:premadeAAAA:Welcome, crawlers.');
  const again = await act(g, { t: 'tts.say', text: 'Welcome,   crawlers.' });
  assert.equal(again.result.cached, true);
  assert.equal(m.tts().length, 1, 'second say hits the cache');
  assert.equal(host.state.host.tts.usage.chars, 'Welcome, crawlers.'.length);
  assert.equal(host.tts.gmView().cache.count, 1);
  // GM view carries status but never the key
  const v = JSON.stringify(host.tts.gmView());
  assert.ok(!v.includes('sk-test'));
});

test('players and the TV cannot use tts.* / announce; GM can', async () => {
  const { host, sock, gm } = setup();
  const g = gm();
  await act(g, { t: 'player.add', name: 'Carl' });
  const pid = host.state.players[0].id;
  const token = host.state.host.playerTokens[pid];
  const p = sock();
  p.send({ t: 'hello', role: 'player', token });
  assert.equal(p.last('welcome').role, 'player');
  const tv = sock();
  tv.send({ t: 'hello', role: 'stage', key: KEY });
  for (const a of [{ t: 'tts.say', text: 'hi' }, { t: 'tts.line', id: 'q_1' }, { t: 'tts.prerender.step', confirm: true }, { t: 'tts.cache.clear' }, { t: 'tts.config', stability: 0.1 }, { t: 'announce', text: 'x' }, { t: 'tts.voices' }]) {
    const rp = await act(p, a);
    assert.equal(rp.ok, false, `player ${a.t}`);
    const rt = await act(tv, a);
    assert.equal(rt.ok, false, `stage ${a.t}`);
  }
  assert.equal(host.tts.gmView().usage.chars, 0);
  // Player view never carries tts status
  assert.equal(p.last('welcome').view.gm, undefined);
});

test('voices: only premade/generated listed; cloned/professional voices refused in config and say', async () => {
  const { gm } = setup();
  const g = gm();
  const v = await act(g, { t: 'tts.voices' });
  assert.deepEqual(v.result.voices.map((x) => x.id).sort(), ['designCCCC', 'premadeAAAA']);
  assert.equal(v.result.hidden, 2);
  const bad = await act(g, { t: 'tts.config', voiceId: 'clonedBBBB' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'tts.no_voice');
  assert.equal((await act(g, { t: 'tts.say', text: 'x', voiceId: 'proDDDD' })).error, 'tts.no_voice');
  const ok = await act(g, { t: 'tts.config', voiceId: 'designCCCC', stability: 0.3, similarity: 0.9 });
  assert.equal(ok.ok, true, ok.msg);
  assert.equal(ok.result.settings.voiceId, 'designCCCC');
  assert.equal((await act(g, { t: 'tts.config', stability: 3 })).ok, false);
  const models = await act(g, { t: 'tts.models' });
  assert.deepEqual(models.result.models.map((x) => x.id), ['eleven_multilingual_v2']);
  const prev = await act(g, { t: 'tts.preview', voiceId: 'premadeAAAA' });
  assert.equal(prev.ok, true, prev.msg);
  assert.equal(prev.result.chars, 0);
});

test('achievement award: announce text, TV event cued, GM renders via tts.line, audio.started relayed to the TV', async () => {
  const { host, gm, sock, m } = setup();
  const g = gm();
  const tv = sock();
  tv.send({ t: 'hello', role: 'stage', key: KEY });
  await act(g, { t: 'player.add', name: 'Carl' });
  const pid = host.state.players[0].id;
  await act(g, { t: 'ach.award', playerId: pid, title: 'Edited Title', desc: 'Freshly written.', reward: 'A sock' });
  const ev = tv.all('event').map((x) => x.event).find((e) => e.kind === 'achievement');
  assert.equal(ev.voiceCue, true);
  const play = tv.last('play');
  assert.equal(play.text, 'New achievement! Edited Title. Freshly written. Reward: A sock.');
  assert.equal(play.cue, ev.id);
  assert.equal(play.sync, true);
  assert.equal(play.tts.cached, false);
  assert.equal(play.tts.url, null);
  const line = await act(g, { t: 'tts.line', id: play.id });
  assert.equal(line.ok, true, line.msg);
  // No voice picked and the voice list not loaded yet: the hint has no hash, tts.line resolves the voice.
  assert.equal(play.tts.hash, null);
  assert.match(line.result.hash, /^[0-9a-f]{64}$/);
  assert.equal(m.tts().length, 1);
  // From now on the default voice is known: a repeat of the same line is announced as cached.
  await act(g, { t: 'say', text: play.text });
  assert.deepEqual(g.last('play').tts, { hash: line.result.hash, cached: true, url: line.result.url });
  g.send({ t: 'audio.started', id: play.id });
  assert.deepEqual(tv.last('audio.started'), { t: 'audio.started', id: play.id, cue: ev.id });
  // With "quip" mode the pack's own line plays instead
  await act(g, { t: 'tts.config', achievementLine: 'quip' });
  await act(g, { t: 'ach.award', playerId: pid, achId: 'plain' });
  assert.ok(!g.last('play').text.startsWith('New achievement! Plain'));
});

test('announce: TV takeover event + P0 line, cued together', async () => {
  const { gm, sock } = setup();
  const g = gm();
  const tv = sock();
  tv.send({ t: 'hello', role: 'stage', key: KEY });
  const r = await act(g, { t: 'announce', text: 'The floor collapses in five minutes.' });
  assert.equal(r.ok, true);
  const ev = tv.last('event').event;
  assert.equal(ev.kind, 'announcement');
  assert.equal(ev.voiceCue, true);
  assert.equal(tv.last('play').cue, r.result.eventId);
  assert.equal((await act(g, { t: 'announce', text: '' })).ok, false);
});

test('pre-render: estimate counts characters, steps render 2 at a time, resumable, skip cached', async () => {
  const { gm, m } = setup();
  const g = gm();
  const est = await act(g, { t: 'tts.estimate' });
  assert.equal(est.ok, true, est.msg);
  assert.ok(est.result.total > 2);
  assert.equal(est.result.cached, 0);
  assert.ok(est.result.chars > 0);
  assert.equal((await act(g, { t: 'tts.prerender.step' })).ok, false, 'confirm required');
  const s1 = await act(g, { t: 'tts.prerender.step', confirm: true });
  assert.equal(s1.result.done.length, 2);
  assert.equal(s1.result.remaining, est.result.total - 2);
  let left = s1.result.remaining;
  for (let i = 0; i < 100 && left > 0; i++) left = (await act(g, { t: 'tts.prerender.step', confirm: true })).result.remaining;
  assert.equal(left, 0);
  assert.equal(m.tts().length, est.result.total);
  const est2 = await act(g, { t: 'tts.estimate' });
  assert.equal(est2.result.remaining, 0);
  assert.equal(est2.result.chars, 0);
  const clr = await act(g, { t: 'tts.cache.clear' });
  assert.equal(clr.result.cleared, est.result.total);
});

test('pre-render stops on a fatal error (bad key) instead of failing every line', async () => {
  const { gm } = setup({ tts: { apiKey: 'wrong-key', voiceId: 'premadeAAAA' } });
  const g = gm();
  const s = await act(g, { t: 'tts.prerender.step', confirm: true });
  assert.equal(s.ok, true, s.msg);
  assert.equal(s.result.fatal?.error, 'tts.bad_key');
});

test('without ELEVENLABS_API_KEY: plays carry no tts hint, tts.* answer tts.no_key, announce still works', async () => {
  const { gm } = setup({ tts: { apiKey: '' } });
  const g = gm();
  assert.equal(g.last('welcome').view.gm.tts.configured, false);
  assert.equal((await act(g, { t: 'tts.say', text: 'hi' })).error, 'tts.no_key');
  await act(g, { t: 'say', text: 'browser voice' });
  assert.equal(g.last('play').tts, null);
  assert.equal((await act(g, { t: 'announce', text: 'Hello' })).ok, true);
});

/* ---------- Node HTTP: /api/tts/<hash>.mp3 is GM-only ---------- */

test('Node: /api/tts/<hash>.mp3 needs the GM key; players cannot fetch it', async () => {
  const root = tmpDir();
  const webDir = path.join(root, 'web');
  fs.mkdirSync(webDir);
  const m = mockEleven();
  const srv = await startServer({
    port: 0, host: '127.0.0.1', publicHost: '127.0.0.1', packDir: writePack(path.join(root, 'pack')), dataDir: path.join(root, 'data'), webDir,
    env: { GM_KEY: KEY, ELEVENLABS_API_KEY: 'sk-test' }, log: silent, chat: false, ttsFetch: m.fetch,
  });
  try {
    const r = await srv.host.tts.synth('Hello from the System.');
    const url = `http://127.0.0.1:${srv.port}/api/tts/${r.hash}.mp3`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { 'x-gm-key': 'nope' } })).status, 401);
    const pid = (await srv.host.apply({ t: 'player.add', name: 'P', role: 'gm' })).result?.playerId ?? srv.host.state.players[0].id;
    const ptoken = srv.host.state.host.playerTokens[pid];
    assert.equal((await fetch(url, { headers: { 'x-gm-key': ptoken } })).status, 401, 'player link is not a GM key');
    const ok = await fetch(url, { headers: { 'x-gm-key': KEY } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'audio/mpeg');
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.equal(await ok.text(), 'MP3:premadeAAAA:Hello from the System.');
    assert.equal((await fetch(url.replace(r.hash, 'a'.repeat(64)), { headers: { 'x-gm-key': KEY } })).status, 404);
    assert.ok(fs.existsSync(path.join(root, 'data', 'tts', `${r.hash}.mp3`)));
  } finally {
    await srv.close();
  }
});

test('pack sfx.json: pads loaded from audio/sfx, invalid entries skipped, exposed to the GM only', () => {
  const dir = writePack(tmpDir());
  fs.mkdirSync(path.join(dir, 'audio', 'sfx'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'audio', 'sfx', 'horn.mp3'), 'x');
  fs.writeFileSync(path.join(dir, 'sfx.json'), JSON.stringify([
    { id: 'hype_horn', label: 'Our horn', file: 'horn.mp3', hotkey: 'Shift+KeyH', volume: 0.8 },
    { id: 'missing', file: 'nope.mp3' },
    { id: 'bad id!', file: 'horn.mp3' },
    { id: 'evil', file: '../../secret.mp3' },
  ]));
  const { pack, warnings } = loadPack(dir);
  assert.deepEqual(pack.sfx, [{ id: 'hype_horn', label: 'Our horn', url: '/pack/audio/sfx/horn.mp3', hotkey: 'Shift+KeyH', volume: 0.8 }]);
  assert.ok(warnings.length >= 3);
  const host = createHost({ pack, state: createState(pack, Date.now()), log: silent, chat: false, gmKey: KEY, send: (c, t) => c.inbox.push(JSON.parse(t)), close() {} });
  const g = { inbox: [] };
  host.connect(g, {});
  host.message(g, JSON.stringify({ t: 'hello', role: 'gm', key: KEY }));
  assert.equal(g.inbox.at(-1).view.gm.sfx[0].id, 'hype_horn');
  host.close();
});

test('LIMITS unchanged by the voice work', () => assert.equal(LIMITS.maxMessage, 16 * 1024));
