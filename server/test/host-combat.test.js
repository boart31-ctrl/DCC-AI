// host.js + combat auto mode: voice lines and chat bursts timed to the TV cinematic (delayMs), Skip
// flushing them, and portraits sent one per frame with a `portraits.want` re-request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHost, LIMITS } from '../host.js';
import { createState } from '../state.js';
import { loadPack } from '../pack.js';
import { tmpDir, writePack } from './fixtures.js';

const KEY = 'combat-host-key-123456';
const silent = { log() {}, warn() {}, error() {} };

function clock(start = 1_800_000_000_000) {
  let t = start;
  const q = [];
  let seq = 0;
  const timers = {
    setTimeout(fn, ms) { const h = { at: t + ms, fn, id: seq++ }; q.push(h); return h; },
    clearTimeout(h) { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); },
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

function setup() {
  const dir = writePack(tmpDir(), {
    'monsters.json': [{ id: 'brute', name: 'Brute', hpSlots: 3, attacks: [{ name: 'Smash', toHit: 50, damage: '1d4' }] }],
    'quips.json': [
      { id: 'cd_1', category: 'crawler_down', text: 'Crawler down line.' },
      { id: 'mk_1', category: 'mob_killed', text: 'Mob killed line.' },
      { id: 'cv_1', category: 'combat_victory', text: 'Victory line.' },
    ],
    'chat.json': [
      { user: 'a', text: '{player} is down!!', tags: ['crawler_down'] },
      { user: 'b', text: 'F', tags: ['crawler_down'] },
      { user: 'c', text: 'oof', tags: ['crawler_down'] },
      { user: 'd', text: 'gg', tags: ['combat_victory'] },
      { user: 'e', text: 'calm', tags: ['idle'] },
    ],
  });
  const { pack } = loadPack(dir);
  const c = clock();
  const host = createHost({
    pack, state: createState(pack, c.now()), now: c.now, timers: c.timers, log: silent, chat: true, rng: () => 0.42,
    gmKey: KEY, legacy: false, base: 'https://game.example',
    send: (conn, text) => conn.inbox.push(JSON.parse(text)),
    close: (conn, code, reason) => { conn.closed = { code, reason }; },
    persist: () => {}, onMeta: (conn, meta) => { conn.meta = meta; },
  });
  let n = 0;
  const sock = () => {
    const conn = { id: n++, inbox: [], closed: null };
    host.connect(conn, { ip: '10.0.0.9' });
    conn.send = (m) => host.message(conn, JSON.stringify(m));
    conn.all = (t) => conn.inbox.filter((m) => m.t === t);
    conn.ack = (rid) => conn.inbox.find((m) => m.t === 'ack' && m.rid === rid);
    return conn;
  };
  const gm = sock();
  gm.send({ t: 'hello', role: 'gm', key: KEY });
  const tv = sock();
  tv.send({ t: 'hello', role: 'stage', key: KEY });
  const act = async (a) => {
    const rid = `r${Math.random()}`;
    gm.send({ ...a, rid });
    await new Promise((r) => setImmediate(r));
    const ack = gm.ack(rid);
    assert.ok(ack?.ok, `${a.t}: ${ack?.msg}`);
    return ack.result;
  };
  return { host, c, gm, tv, act };
}

async function fight({ act, c }) {
  const pid = (await act({ t: 'player.add', name: 'Carl' })).playerId;
  await act({ t: 'track.set', playerId: pid, track: 'hp', cur: 1 });
  await act({ t: 'combat.addMob', sourceId: 'brute', count: 3, hidden: false });
  await act({ t: 'combat.start' });
  c.advance(LIMITS.viewDebounceMs + 1);
  return pid;
}

test('auto mode: the crawler_down line and its chat burst wait for their TV step', async () => {
  const s = setup();
  await fight(s);
  const playsBefore = s.gm.all('play').length;
  const chatBefore = s.tv.all('event').filter((m) => m.event.kind === 'chat' && m.event.tag === 'crawler_down').length;
  const r = await s.act({ t: 'combat.auto' });
  const down = r.sequence.find((x) => x.down);
  assert.ok(down, 'the 1 HP crawler goes down');
  const tvAuto = s.tv.all('event').find((m) => m.event.kind === 'combat.auto');
  assert.ok(tvAuto && tvAuto.event.steps.length === r.sequence.length);
  assert.equal(s.gm.all('play').filter((m) => /Crawler down line/.test(m.text)).length, 0, 'not yet');
  s.c.advance(400);
  assert.equal(s.tv.all('event').filter((m) => m.event.kind === 'chat' && m.event.tag === 'crawler_down').length, chatBefore, 'chat waits too');
  s.c.advance(4000);
  assert.ok(s.gm.all('play').some((m) => /Crawler down line/.test(m.text)), 'voice line after its step');
  assert.ok(s.tv.all('event').filter((m) => m.event.kind === 'chat' && m.event.tag === 'crawler_down').length > chatBefore, 'chat burst arrived');
  assert.ok(s.gm.all('play').length > playsBefore);
});

test('Skip plays what was waiting right away', async () => {
  const s = setup();
  await fight(s);
  await s.act({ t: 'combat.auto' });
  assert.equal(s.gm.all('play').filter((m) => /Crawler down line/.test(m.text)).length, 0);
  await s.act({ t: 'combat.autoSkip' });
  assert.ok(s.gm.all('play').some((m) => /Crawler down line/.test(m.text)));
  assert.ok(s.tv.all('event').some((m) => m.event.kind === 'combat.autoSkip'));
});

test('combat.end victory: finale scene + victory line + outcome chat burst', async () => {
  const s = setup();
  await fight(s);
  for (const m of s.host.state.combat.combatants.filter((x) => x.type === 'mob')) await s.act({ t: 'combat.damage', uid: m.uid, amount: 9 });
  s.c.advance(LIMITS.viewDebounceMs + 1);
  const v = s.gm.all('view').at(-1).view;
  assert.equal(v.combat.suggestEnd, 'victory');
  await s.act({ t: 'combat.end', outcome: 'victory' });
  // The desk finishes whatever is playing (mob killed lines) so the victory line gets its turn.
  for (let k = 0; k < 8; k++) {
    s.c.advance(1000);
    for (const m of s.gm.all('play')) if (!m.acked) { m.acked = true; s.gm.send({ t: 'audio.done', id: m.id }); }
  }
  const tvView = s.tv.all('view').at(-1).view;
  assert.equal(tvView.scene.kind, 'finale');
  assert.ok(s.gm.all('play').some((m) => m.text === 'Victory line.'));
  assert.ok(s.tv.all('event').some((m) => m.event.kind === 'chat' && m.event.tag === 'combat_victory'));
});

test('portraits: one picture per frame; portraits.want sends a missing one again', async () => {
  const s = setup();
  const a = (await s.act({ t: 'player.add', name: 'A' })).playerId;
  const b = (await s.act({ t: 'player.add', name: 'B' })).playerId;
  const pic = (c) => `data:image/png;base64,${c.repeat(400)}`;
  await s.act({ t: 'sheet.set', playerId: a, path: 'portrait', value: pic('A') });
  await s.act({ t: 'sheet.set', playerId: b, path: 'portrait', value: pic('B') });
  s.c.advance(LIMITS.viewDebounceMs + 1);
  const frames = s.tv.all('portraits');
  assert.ok(frames.length >= 2 && frames.every((f) => Object.keys(f.portraits).length === 1), 'one per frame');
  const ref = s.tv.all('view').at(-1).view.players.find((p) => p.id === b).portrait;
  assert.match(ref, /^portrait:/);
  const before = s.tv.all('portraits').length;
  s.tv.send({ t: 'portraits.want', refs: [ref, 'portrait:nope'], rid: 'w1' });
  const again = s.tv.all('portraits').slice(before);
  assert.equal(again.length, 1);
  assert.equal(again[0].portraits[ref], pic('B'));
  assert.equal(s.tv.ack('w1').result.sent, 1);
});

test('Mute AI: System lines go out silent (text only), no audience chat at all', async () => {
  const s = setup();
  await s.act({ t: 'session.aiMute', on: true });
  await fight(s);
  const chatBefore = s.tv.all('event').filter((m) => m.event.kind === 'chat').length;
  await s.act({ t: 'combat.auto' });
  s.c.advance(8000);
  const lines = s.gm.all('play').filter((m) => /Crawler down line/.test(m.text));
  assert.ok(lines.length, 'the line still goes out (subtitle)');
  assert.ok(lines.every((m) => m.silent === true && !m.audio && !m.tts));
  s.c.advance(60_000);
  assert.equal(s.tv.all('event').filter((m) => m.event.kind === 'chat').length, chatBefore, 'no chat while muted');
});
