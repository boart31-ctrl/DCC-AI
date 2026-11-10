// host.js: access model (GM key, player links, relink, claim/approve, TV pairing), hardening and
// persistence/restore-point policy — driven directly with fake sockets and a fake clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost, LIMITS, sanitizeAction } from '../host.js';
import { createState } from '../state.js';
import { loadPack } from '../pack.js';
import { checkIsomorphic } from '../check-isomorphic.js';
import { safeEqual } from '../access.js';
import { tmpDir, writePack } from './fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const KEY = 'correct-horse-battery-staple';
const silent = { log() {}, warn() {}, error() {} };

function clock(start = 1_800_000_000_000) {
  let t = start;
  const q = [];
  let seq = 0;
  const timers = {
    setTimeout(fn, ms) {
      const h = { at: t + ms, fn, id: seq++ };
      q.push(h);
      return h;
    },
    clearTimeout(h) {
      const i = q.indexOf(h);
      if (i >= 0) q.splice(i, 1);
    },
  };
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      q.sort((a, b) => a.at - b.at || a.id - b.id);
      if (!q.length || q[0].at > end) break;
      const h = q.shift();
      t = Math.max(t, h.at);
      h.fn();
    }
    t = end;
  };
  return { now: () => t, timers, advance };
}

function setup(over = {}) {
  const { pack } = loadPack(writePack(tmpDir()));
  const c = clock();
  const trace = [];
  const persisted = [];
  const snaps = [];
  const snapshots = over.snapshots === null ? null : {
    create(reason, state, at) {
      snaps.push({ id: snaps.length + 1, reason, at, state: JSON.parse(JSON.stringify(state)) });
      return snaps.length;
    },
    list: () => snaps.map(({ id, at, reason }) => ({ id, at, reason })).reverse(),
    load: (id) => snaps.find((s) => s.id === id)?.state ?? null,
  };
  const host = createHost({
    pack,
    state: over.state ?? createState(pack, c.now()),
    now: c.now,
    timers: c.timers,
    log: silent,
    chat: false,
    gmKey: KEY,
    legacy: false,
    base: 'https://game.example',
    send: (conn, text) => {
      const m = JSON.parse(text);
      conn.inbox.push(m);
      trace.push(`send:${m.t}`);
    },
    close: (conn, code, reason) => {
      conn.closed = { code, reason };
    },
    persist: over.persist ?? ((state, entry) => {
      trace.push('persist');
      persisted.push(JSON.parse(JSON.stringify({ ...entry, prev: undefined })));
    }),
    onMeta: (conn, meta) => {
      conn.meta = meta;
    },
    snapshots,
    ...(over.host ?? {}),
  });
  let n = 0;
  const sock = (ip = '10.0.0.1') => {
    const conn = { id: n++, inbox: [], closed: null, meta: null };
    conn.ok = host.connect(conn, { ip });
    conn.send = (m) => host.message(conn, typeof m === 'string' ? m : JSON.stringify(m));
    conn.last = (t) => [...conn.inbox].reverse().find((m) => m.t === t);
    conn.ack = (rid) => conn.inbox.find((m) => m.t === 'ack' && m.rid === rid);
    return conn;
  };
  const gm = () => {
    const s = sock();
    s.send({ t: 'hello', role: 'gm', key: KEY });
    assert.equal(s.last('welcome')?.role, 'gm');
    return s;
  };
  const flush = () => c.advance(LIMITS.viewDebounceMs + 1);
  const gmView = (g) => {
    flush();
    return g.last('view')?.view ?? g.last('welcome').view;
  };
  return { host, pack, clock: c, trace, persisted, snaps, sock, gm, flush, gmView };
}

async function act(g, a, rid = `r${Math.random()}`) {
  g.send({ ...a, rid });
  await new Promise((r) => setImmediate(r)); // handleAction is async
  return g.ack(rid);
}

test('host.js and access.js import graph is browser/Workers-safe', () => {
  for (const f of ['host.js', 'access.js', 'routes.js']) {
    const { problems } = checkIsomorphic(path.join(here, '..', f));
    assert.deepEqual(problems, [], f);
  }
  const { problems } = checkIsomorphic(path.join(here, '..', '..', 'web', 'js', 'qr.js'));
  assert.deepEqual(problems, []);
});

test('safeEqual: equal/unequal/length/type', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual(undefined, ''), false);
});

test('GM key: right key → welcome, wrong key → bad_auth + close, 5 failures/min/IP → rate_limited', () => {
  const { sock, clock: c } = setup();
  const ok = sock();
  ok.send({ t: 'hello', role: 'gm', key: KEY });
  assert.equal(ok.last('welcome').role, 'gm');
  assert.equal(ok.last('welcome').view.gm.access.edition, 'cloud');

  const legacy = sock('10.0.0.9');
  legacy.send({ t: 'hello', role: 'gm', token: 'whatever' });
  assert.equal(legacy.last('error').code, 'bad_auth', 'legacy token not accepted when legacy is off');
  for (let i = 0; i < 4; i++) {
    const s = sock('10.0.0.9');
    s.send({ t: 'hello', role: 'gm', key: 'nope' });
    assert.equal(s.last('error').code, 'bad_auth');
    assert.equal(s.closed.code, 4001);
  }
  const blocked = sock('10.0.0.9');
  blocked.send({ t: 'hello', role: 'gm', key: KEY });
  assert.equal(blocked.last('error').code, 'rate_limited', 'even the right key waits');
  const other = sock('10.0.0.10');
  other.send({ t: 'hello', role: 'gm', key: KEY });
  assert.equal(other.last('welcome').role, 'gm', 'other IPs unaffected');
  c.advance(61_000);
  const later = sock('10.0.0.9');
  later.send({ t: 'hello', role: 'gm', key: KEY });
  assert.equal(later.last('welcome').role, 'gm');
});

test('GM key missing on the server: nobody gets in', () => {
  const { sock } = setup({ host: { gmKey: '' } });
  const s = sock();
  s.send({ t: 'hello', role: 'gm', key: '' });
  assert.equal(s.last('error').code, 'bad_auth');
  assert.match(s.last('error').msg, /GM_KEY/);
});

test('player links: token per player, join URL for the GM only, relink revokes the old link', async () => {
  const { sock, gm, gmView, host, flush } = setup();
  const g = gm();
  const pid = (await act(g, { t: 'player.add', name: 'Carl' })).result.playerId;
  const v = gmView(g);
  const url = v.gm.playersFull.find((p) => p.id === pid).joinUrl;
  const token = url.split('/p/')[1];
  assert.match(url, /^https:\/\/game\.example\/p\//);
  assert.ok(token.length >= 24);
  assert.deepEqual(v.gm.pins, {}, 'no PINs in the cloud edition');

  const ph = sock();
  ph.send({ t: 'hello', role: 'player', token });
  assert.equal(ph.last('welcome').playerId, pid);
  const stage = sock();
  stage.send({ t: 'hello', role: 'stage', pair: true });
  flush();
  for (const m of [...ph.inbox, ...stage.inbox]) assert.equal(JSON.stringify(m).includes(token), false, `token leaked in ${m.t}`);

  const r = await act(g, { t: 'player.relink', playerId: pid });
  assert.equal(r.ok, true);
  assert.deepEqual(ph.closed, { code: 4001, reason: 'relinked' });
  const fresh = r.result.joinUrl.split('/p/')[1];
  assert.notEqual(fresh, token);
  const old = sock();
  old.send({ t: 'hello', role: 'player', token });
  assert.equal(old.last('error').code, 'bad_auth');
  const neu = sock();
  neu.send({ t: 'hello', role: 'player', token: fresh });
  assert.equal(neu.last('welcome').playerId, pid);
  assert.equal(host.state.host.playerTokens[pid], fresh);

  // removing the player drops the token and kicks the phone
  assert.equal((await act(g, { t: 'player.remove', playerId: pid })).ok, true);
  assert.equal(neu.closed.code, 4004);
  assert.deepEqual(host.state.host.playerTokens, {});
  const gone = sock();
  gone.send({ t: 'hello', role: 'player', token: fresh });
  assert.equal(gone.last('error').code, 'bad_auth');
});

test('player PIN login is off in the cloud edition', async () => {
  const { sock, gm, host } = setup();
  const g = gm();
  await act(g, { t: 'player.add', name: 'Carl', pin: '1234' });
  const s = sock();
  s.send({ t: 'hello', role: 'player', room: host.state.room, pin: '1234' });
  assert.equal(s.last('error').code, 'bad_auth');
});

test('claim → pick → GM approves: the phone gets its token and becomes that player; deny closes', async () => {
  const { sock, gm, gmView } = setup();
  const g = gm();
  const a = (await act(g, { t: 'player.add', name: 'Carl' })).result.playerId;
  const b = (await act(g, { t: 'player.add', name: 'Donut' })).result.playerId;
  const ph = sock();
  ph.send({ t: 'hello', role: 'player', claim: true, name: '  Lucie  ' });
  const claim = ph.last('claim');
  assert.deepEqual(claim.characters.map((c) => c.name), ['Carl', 'Donut']);
  assert.equal(JSON.stringify(claim).includes('/p/'), false);
  ph.send({ t: 'claim.pick', playerId: b, rid: 'k' });
  assert.equal(ph.ack('k').ok, true);
  ph.send({ t: 'me.notes', text: 'x', rid: 'n' });
  assert.equal(ph.last('error').code, 'bad_request', 'no game actions while waiting');
  assert.equal(g.inbox.find((m) => m.t === 'event' && m.event.kind === 'joinRequest')?.event.name, 'Lucie');
  const req = gmView(g).gm.requests;
  assert.deepEqual(req.map(({ name, wants }) => ({ name, wants })), [{ name: 'Lucie', wants: b }]);

  assert.equal((await act(g, { t: 'player.approve', requestId: 'rq_nope' })).error, 'not_found');
  const ok = await act(g, { t: 'player.approve', requestId: claim.requestId });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.result.playerId, b);
  const tok = ph.last('token');
  assert.equal(tok.playerId, b);
  assert.ok(tok.token.length >= 24);
  assert.equal(ph.last('welcome').playerId, b);
  assert.equal(gmView(g).gm.requests.length, 0);
  // the token works on another device too
  const ph2 = sock();
  ph2.send({ t: 'hello', role: 'player', token: tok.token });
  assert.equal(ph2.last('welcome').playerId, b);

  const nope = sock();
  nope.send({ t: 'hello', role: 'player', claim: true, name: 'Mallory' });
  const rq = nope.last('claim').requestId;
  assert.equal((await act(g, { t: 'player.deny', requestId: rq })).ok, true);
  assert.equal(nope.last('error').code, 'denied');
  assert.deepEqual(nope.closed, { code: 4001, reason: 'denied' });

  const empty = sock();
  empty.send({ t: 'hello', role: 'player', claim: true, name: '' });
  assert.equal(empty.last('error').code, 'bad_request');
  assert.equal(empty.closed, null);
  void a;
});

test('TV pairing: code → tv.pair → tvToken, reconnect with tvToken, max 3, unpair revokes, codes expire', async () => {
  const { sock, gm, gmView, host, clock: c } = setup();
  const g = gm();
  const tv = sock();
  tv.send({ t: 'hello', role: 'stage', pair: true });
  const { code, expiresAt } = tv.last('pairing');
  assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
  assert.equal(expiresAt, c.now() + 10 * 60_000);
  assert.equal(gmView(g).gm.tvWaiting, 1);
  tv.send({ t: 'audio.done', id: 'x' });
  assert.equal(tv.last('error').code, 'bad_request', 'pairing socket cannot act');

  assert.equal((await act(g, { t: 'tv.pair', code: 'ZZZZ' === code ? 'YYYY' : 'ZZZZ' })).error, 'not_found');
  assert.equal((await act(g, { t: 'tv.pair', code: '12' })).error, 'bad_request');
  const r = await act(g, { t: 'tv.pair', code: code.toLowerCase(), label: 'Living room' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const paired = tv.last('paired');
  assert.ok(paired.tvToken.length >= 24);
  assert.equal(tv.last('welcome').role, 'stage');
  const v = gmView(g);
  assert.deepEqual(v.gm.tvs.map(({ label, connected }) => ({ label, connected })), [{ label: 'Living room', connected: 1 }]);
  assert.equal(JSON.stringify(v).includes(paired.tvToken), false, 'TV token is not shown even to the GM');

  const again = sock();
  again.send({ t: 'hello', role: 'stage', tvToken: paired.tvToken });
  assert.equal(again.last('welcome').role, 'stage');

  for (let i = 0; i < 2; i++) {
    const t = sock();
    t.send({ t: 'hello', role: 'stage', pair: true });
    assert.equal((await act(g, { t: 'tv.pair', code: t.last('pairing').code })).ok, true);
  }
  const fourth = sock();
  fourth.send({ t: 'hello', role: 'stage', pair: true });
  const full = await act(g, { t: 'tv.pair', code: fourth.last('pairing').code });
  assert.equal(full.error, 'bad_request');
  assert.match(full.msg, /max 3/);

  assert.equal((await act(g, { t: 'tv.unpair', tvId: r.result.tvId })).ok, true);
  assert.deepEqual(tv.closed, { code: 4001, reason: 'revoked' });
  assert.deepEqual(again.closed, { code: 4001, reason: 'revoked' });
  const revoked = sock('10.0.0.50');
  revoked.send({ t: 'hello', role: 'stage', tvToken: paired.tvToken });
  assert.equal(revoked.last('error').code, 'bad_auth');
  assert.equal(host.state.host.tvs.length, 2);

  c.advance(10 * 60_000 + 1);
  assert.deepEqual(fourth.closed, { code: 4002, reason: 'pair_expired' });
});

test('hardening: hello timeout, per-socket rate limit, max message size, max sockets', () => {
  const { sock, gm, clock: c, host } = setup();
  const idle = sock();
  c.advance(9_999);
  assert.equal(idle.closed, null);
  c.advance(2);
  assert.deepEqual(idle.closed, { code: 4000, reason: 'hello timeout' });

  const g = gm();
  for (let i = 0; i < 45; i++) g.send({ t: 'ping' });
  assert.equal(g.inbox.filter((m) => m.t === 'pong').length, 40, 'GM burst 40 (fresh bucket after auth)');
  assert.equal(g.inbox.filter((m) => m.t === 'error' && m.code === 'rate_limited').length, 1, 'one warning, not a flood');
  c.advance(1000);
  g.send({ t: 'ping' });
  assert.equal(g.inbox.filter((m) => m.t === 'pong').length, 41, 'refills over time');

  const anon = sock();
  for (let i = 0; i < 25; i++) anon.send({ t: 'ping' });
  assert.equal(anon.inbox.filter((m) => m.t === 'pong').length, 20, 'unauthenticated / players: burst 20');

  const big = sock();
  big.send('x'.repeat(16 * 1024 + 1));
  assert.deepEqual(big.closed, { code: 1009, reason: 'message too big' });

  const many = [];
  while (host.canAccept()) many.push(sock());
  const extra = sock();
  assert.equal(extra.ok, false);
  assert.equal(extra.closed.code, 1013);
  assert.equal(host.conns.size, LIMITS.maxSockets);
});

test('every accepted action is persisted before its ack; secrets never reach the action log', async () => {
  const { gm, trace, persisted, host } = setup();
  const g = gm();
  trace.length = 0;
  const r = await act(g, { t: 'player.add', name: 'Carl', pin: '4321' }, 'p1');
  assert.equal(r.ok, true);
  assert.ok(trace.indexOf('persist') >= 0 && trace.indexOf('persist') < trace.indexOf('send:ack'), trace.join());
  const entry = persisted.at(-1);
  assert.equal(entry.action.t, 'player.add');
  assert.equal(entry.by, 'gm');
  assert.equal('pin' in entry.action, false);
  assert.equal('rid' in entry.action, false);
  const pid = r.result.playerId;
  await act(g, { t: 'player.relink', playerId: pid });
  const token = host.state.host.playerTokens[pid];
  assert.equal(JSON.stringify(persisted.map((p) => p.action)).includes(token), false);
  assert.deepEqual(sanitizeAction({ t: 'x', token: 1, key: 2, tvToken: 3, code: 4, pin: 5, rid: 6, keep: 7 }), { t: 'x', keep: 7 });
  // a failed action is not persisted
  const n = persisted.length;
  assert.equal((await act(g, { t: 'player.update', playerId: 'nope', name: 'x' })).ok, false);
  assert.equal(persisted.length, n);
});

test('persist failure: action rejected, state unchanged', async () => {
  let fail = false;
  const { gm, host } = setup({
    persist: () => {
      if (fail) throw new Error('disk full');
    },
  });
  const g = gm();
  await act(g, { t: 'player.add', name: 'Carl' });
  fail = true;
  const before = host.state;
  const r = await act(g, { t: 'player.add', name: 'Donut' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'internal');
  assert.equal(host.state, before);
  assert.equal(host.state.players.length, 1);
});

test('restore points: first action, every 10 min, after 30 min idle, session.new; backup.restore keeps access', async () => {
  const { gm, snaps, clock: c, host, sock } = setup();
  const g = gm();
  const pid = (await act(g, { t: 'player.add', name: 'Carl' })).result.playerId;
  assert.deepEqual(snaps.map((s) => s.reason), ['periodic']);
  c.advance(5 * 60_000);
  await act(g, { t: 'player.update', playerId: pid, gold: 5 });
  assert.equal(snaps.length, 1, 'no restore point within 10 min');
  c.advance(5 * 60_000);
  await act(g, { t: 'player.update', playerId: pid, gold: 10 });
  assert.deepEqual(snaps.map((s) => s.reason), ['periodic', 'periodic']);
  assert.equal(snaps[1].state.players[0].gold, 5, 'restore point = state before the action');
  c.advance(31 * 60_000);
  await act(g, { t: 'player.update', playerId: pid, gold: 20 });
  assert.equal(snaps.at(-1).reason, 'idle');
  await act(g, { t: 'session.new' });
  assert.equal(snaps.at(-1).reason, 'session.new');

  const list = (await act(g, { t: 'backup.list' })).result.backups;
  assert.equal(list[0].reason, 'session.new');
  const manual = (await act(g, { t: 'backup.create' })).result.id;
  assert.equal(snaps.at(-1).reason, 'manual');

  // relink after the restore point, then restore an older one: the new link must survive
  const fresh = (await act(g, { t: 'player.relink', playerId: pid })).result.joinUrl.split('/p/')[1];
  const ph = sock();
  ph.send({ t: 'hello', role: 'player', token: fresh });
  const r = await act(g, { t: 'backup.restore', id: 2 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(snaps.at(-1).reason, 'before-restore');
  assert.equal(host.state.players[0].gold, 5);
  assert.equal(host.state.host.playerTokens[pid], fresh);
  assert.equal(ph.closed, null, 'phone stays connected');
  assert.equal((await act(g, { t: 'backup.restore', id: 999 })).error, 'not_found');
  // the before-restore point brings it back
  assert.equal((await act(g, { t: 'backup.restore', id: snaps.at(-1).id })).ok, true);
  assert.equal(host.state.players[0].gold, 20);
  void manual;
});

test('backups unavailable without a snapshot store', async () => {
  const { gm } = setup({ snapshots: null });
  const g = gm();
  assert.equal((await act(g, { t: 'backup.list' })).error, 'bad_request');
});

test('restore(conn, meta) after a rebuild (hibernation): authenticated sockets keep working without hello', async () => {
  const one = setup();
  const g = one.gm();
  const pid = (await act(g, { t: 'player.add', name: 'Carl' })).result.playerId;
  const token = one.host.state.host.playerTokens[pid];
  const ph = one.sock();
  ph.send({ t: 'hello', role: 'player', token });
  const tv = one.sock();
  tv.send({ t: 'hello', role: 'stage', pair: true });
  const savedState = JSON.parse(JSON.stringify(one.host.state));

  const two = setup({ state: savedState });
  for (const conn of [g, ph, tv]) {
    conn.inbox.length = 0;
    two.host.restore(conn, conn.meta);
    conn.send = (m) => two.host.message(conn, JSON.stringify(m));
  }
  ph.send({ t: 'me.notes', text: 'still here', rid: 'n' });
  assert.equal(ph.ack('n').ok, true);
  assert.equal(two.host.state.players[0].notes, 'still here');
  const code = tv.meta.code;
  const r = await act(g, { t: 'tv.pair', code });
  assert.equal(r.ok, true, 'pairing code survives the rebuild');
  two.clock.advance(10 * 60_000);
  const stale = { inbox: [], closed: null };
  two.host.restore(stale, { role: 'pairing', code: 'ABCD', codeExpires: two.clock.now() - 1 });
  assert.equal(stale.closed.code, 4002);
});
