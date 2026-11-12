// chat.js (fake audience chat): pack shape, context filtering, bursts, placeholders, no repeats,
// and the host wiring (ambient timer per scene, bursts after big moments, viewer bumps). Seeded RNG.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChatLines, createChat, chatContext, reactionFor, fillText, CHAT_TAGS } from '../chat.js';
import { createHost } from '../host.js';
import { createState } from '../state.js';
import { loadPack } from '../pack.js';
import { tmpDir, writePack } from './fixtures.js';

/** Small deterministic PRNG (mulberry32). */
function seeded(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const L = (user, text, tags, weight) => ({ user, text, ...(tags ? { tags } : {}), ...(weight ? { weight } : {}) });
const STATE = {
  players: [{ id: 'p1', name: 'Bugatti', inventory: [{ name: 'Rubber Duck' }] }, { id: 'p2', name: 'Mona', inventory: [] }],
  scene: { kind: 'explore', data: {} },
  combat: { active: false, combatants: [] },
};

test('normalizeChatLines: old untagged lines still load; tags/weight validated', () => {
  const w = [];
  const out = normalizeChatLines([
    { user: 'a', text: 'old line' },
    { user: 'b', text: 'tagged', tags: ['combat', 'boss', 'nope', 'combat'], weight: 3 },
    { user: 'c', text: 'string tag', tags: 'nat20' },
    { user: 'd', text: 'bad weight', weight: -2 },
    { user: '', text: 'no user' },
    'junk',
  ], w);
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], { user: 'a', text: 'old line', tags: [], weight: 1 });
  assert.deepEqual(out[1].tags, ['combat', 'boss']);
  assert.equal(out[1].weight, 3);
  assert.deepEqual(out[2].tags, ['nat20']);
  assert.equal(out[3].weight, 1);
  assert.ok(w.some((x) => x.includes('unknown tags ignored: nope')));
  assert.ok(w.some((x) => x.includes('weight must be a positive number')));
  assert.equal(normalizeChatLines(undefined).length, 0);
  const w2 = [];
  assert.deepEqual(normalizeChatLines({}, w2), []);
  assert.match(w2[0], /must be an array/);
  assert.equal(CHAT_TAGS.length, 29);
  for (const t of ['mob_hit', 'mob_miss', 'mob_crit', 'crawler_down', 'mob_killed', 'combat_victory', 'combat_defeat', 'combat_runaway', 'combat_truce', 'combat_special', 'combat_sponsor', 'combat_timeout', 'combat_stalemate']) assert.ok(CHAT_TAGS.includes(t), t);
});

test('chatContext follows the TV scene; combat wins over explore', () => {
  assert.equal(chatContext({ scene: { kind: 'explore' } }), 'explore');
  assert.equal(chatContext({ scene: { kind: 'explore' }, combat: { active: true } }), 'combat');
  assert.equal(chatContext({ scene: { kind: 'boss', data: {} } }), 'boss');
  assert.equal(chatContext({ scene: { kind: 'boss', data: { defeated: true } } }), 'boss_defeat');
  assert.equal(chatContext({ scene: { kind: 'blank' } }), 'idle');
  assert.equal(chatContext({ scene: { kind: 'lobby' } }), 'lobby');
  assert.equal(chatContext({}), 'idle');
});

test('ambient: only lines of the current context or generic lines, generic weighted down', () => {
  const lines = normalizeChatLines([
    L('g', 'generic'), L('i', 'idle talk', ['idle']),
    L('c1', 'combat 1', ['combat']), L('c2', 'combat 2', ['combat']), L('c3', 'combat 3', ['combat']),
    L('b', 'boss only', ['boss']), L('e', 'explore only', ['explore']),
  ]);
  const chat = createChat({ lines, rng: seeded(7), recent: 1 });
  const st = { ...STATE, combat: { active: true, combatants: [] } };
  const seen = new Map();
  for (let i = 0; i < 400; i++) {
    const { line, delayMs } = chat.ambient(st);
    assert.ok(delayMs >= 5000 && delayMs <= 9000, `combat gap ${delayMs}`); // busier than any calm scene
    seen.set(line.text, (seen.get(line.text) ?? 0) + 1);
  }
  assert.ok(!seen.has('boss only') && !seen.has('explore only'), 'no other contexts');
  const combat = (seen.get('combat 1') ?? 0) + (seen.get('combat 2') ?? 0) + (seen.get('combat 3') ?? 0);
  const generic = (seen.get('generic') ?? 0) + (seen.get('idle talk') ?? 0);
  assert.ok(combat > generic * 1.5, `combat ${combat} vs generic ${generic}`);
  assert.ok(generic > 0, 'generic lines still show up');
  // Explore is calmer than combat.
  const calm = createChat({ lines, rng: seeded(3) }).ambient({ ...STATE });
  assert.ok(calm.delayMs >= 15000 && calm.delayMs <= 28000);
});

test('weights: a weight-5 line is picked about five times as often', () => {
  const lines = normalizeChatLines([L('a', 'heavy', ['nat20'], 5), L('b', 'light', ['nat20'], 1)]);
  const chat = createChat({ lines, rng: seeded(11), recent: 1 });
  let heavy = 0;
  let light = 0;
  // recent:1 blocks only the very last line, so alternate draws stay possible; count first picks of fresh directors instead.
  for (let s = 1; s <= 600; s++) {
    const c = createChat({ lines, rng: seeded(s) });
    const l = c.pick('nat20', STATE, { strict: true });
    if (l.text === 'heavy') heavy++; else light++;
  }
  assert.ok(chat.size === 2);
  assert.ok(heavy / light > 3.5 && heavy / light < 7, `ratio ${heavy / light}`);
});

test('no immediate repeats: the recent window blocks lines until the pool is used up', () => {
  const lines = normalizeChatLines(Array.from({ length: 10 }, (_, i) => L(`u${i}`, `line ${i}`, ['explore'])));
  const chat = createChat({ lines, rng: seeded(5) }); // window = 6
  const got = [];
  for (let i = 0; i < 200; i++) got.push(chat.pick('explore', STATE, { strict: true }).text);
  for (let i = 0; i < got.length; i++) {
    const win = got.slice(Math.max(0, i - 6), i);
    assert.ok(!win.includes(got[i]), `repeat of "${got[i]}" at ${i}`);
  }
  // A pool of two never repeats back to back either.
  const two = createChat({ lines: normalizeChatLines([L('a', 'A', ['nat1']), L('b', 'B', ['nat1'])]), rng: seeded(9) });
  let prev = null;
  for (let i = 0; i < 30; i++) {
    const t = two.pick('nat1', STATE, { strict: true }).text;
    assert.notEqual(t, prev);
    prev = t;
  }
});

test('placeholders: filled from the event, then the state; unfillable lines are skipped', () => {
  const lines = normalizeChatLines([
    L('{player}_stan', 'GO {player} GO', ['nat20']),
    L('loot_goblin', '{player} got {item}?? rigged', ['loot']),
    L('bossfan', '{boss} is my dad', ['boss']),
    L('mobfan', 'the {mob} did nothing wrong', ['combat']),
  ]);
  const chat = createChat({ lines, rng: seeded(2) });
  const n20 = chat.react({ kind: 'roll', playerId: 'p2', nat20: true, secret: false }, STATE);
  assert.equal(n20.key, 'nat20');
  assert.equal(n20.lines[0].text, 'GO Mona GO');
  assert.equal(n20.lines[0].user, 'Mona_stan');
  const loot = chat.react({ kind: 'loot', playerId: 'p1', item: { name: 'Gold Crown' } }, STATE);
  assert.equal(loot.lines[0].text, 'Bugatti got Gold Crown?? rigged');
  // No boss on the TV and none in the event: the line cannot be used → no burst lines.
  assert.equal(chat.pick('boss', STATE, { strict: true }), null);
  const bossState = { ...STATE, scene: { kind: 'boss', data: { boss: { name: 'Grimble' } } } };
  assert.equal(chat.pick('boss', bossState, { strict: true }).text, 'Grimble is my dad');
  // Mobs: only revealed, living ones.
  assert.equal(chat.pick('combat', { ...STATE, combat: { active: true, combatants: [{ type: 'mob', name: 'Rat', hp: 3, hidden: true }] } }, { strict: true }), null);
  assert.equal(chat.pick('combat', { ...STATE, combat: { active: true, combatants: [{ type: 'mob', name: 'Rat', hp: 3 }] } }, { strict: true }).text, 'the Rat did nothing wrong');
  assert.equal(fillText('{player} and {player}', () => 'X'), 'X and X');
  assert.equal(fillText('{item}', () => ''), null);
});

test('reactionFor: big moments map to bursts; secret rolls and quiet events do not', () => {
  assert.equal(reactionFor({ kind: 'roll', nat20: true, secret: true }), null);
  assert.equal(reactionFor({ kind: 'roll', nat1: true, playerId: 'p1' }).key, 'nat1');
  assert.equal(reactionFor({ kind: 'roll', roll: { nat20: true, playerId: 'p1' } }).fill.playerId, 'p1');
  assert.equal(reactionFor({ kind: 'roll' }), null);
  assert.equal(reactionFor({ kind: 'boss.defeat', name: 'Grimble' }).fill.boss, 'Grimble');
  assert.equal(reactionFor({ kind: 'combat.hit', type: 'crawler', playerId: 'p1', down: true }).key, 'crawler_down');
  assert.equal(reactionFor({ kind: 'combat.hit', type: 'mob', name: 'Rat', down: true }).key, 'mob_killed');
  assert.equal(reactionFor({ kind: 'roll', nat20: true, by: 'gm', playerId: null }), null, 'mob / GM rolls: no crawler nat 20 burst');
  const cue = reactionFor({ kind: 'chat.cue', cue: 'mob_crit', fill: { playerId: 'p1', mob: 'Rat' }, delayMs: 1500 });
  assert.deepEqual([cue.key, cue.fill.mob, cue.delayMs], ['mob_crit', 'Rat', 1500]);
  assert.equal(reactionFor({ kind: 'chat.cue', cue: 'nonsense' }), null);
  assert.equal(reactionFor({ kind: 'combat.hit', type: 'mob', name: 'Rat' }).fill.mob, 'Rat');
  assert.equal(reactionFor({ kind: 'scene', scene: 'countdown' }).key, 'countdown');
  assert.equal(reactionFor({ kind: 'scene', scene: 'explore' }), null);
  assert.equal(reactionFor({ kind: 'viewers' }), null);
});

test('bursts: 3 calm nat20 lines (first within a second), afterglow flavours calm chat', () => {
  const lines = normalizeChatLines([
    ...Array.from({ length: 12 }, (_, i) => L(`n${i}`, `nat20 hype ${i}`, ['nat20'])),
    ...Array.from({ length: 6 }, (_, i) => L(`e${i}`, `explore ${i}`, ['explore'])),
  ]);
  let t = 1_000_000;
  const chat = createChat({ lines, rng: seeded(4), now: () => t });
  for (let s = 0; s < 20; s++) {
    const r = chat.react({ kind: 'roll', nat20: true, playerId: 'p1' }, STATE);
    assert.ok(r.lines.length === 3, `burst ${r.lines.length}`); // capped at BURST_MAX
    assert.ok(r.gapsMs[0] < 1300 && r.gapsMs.slice(1).every((g) => g >= 1500 && g <= 2800));
    assert.ok(r.viewers >= 0.02 && r.viewers <= 0.05);
    assert.ok(r.lines.every((l) => l.tag === 'nat20'));
  }
  // Right after the moment some calm lines still talk about it; a minute later none do.
  let glow = 0;
  for (let i = 0; i < 60; i++) if (/nat20/.test(chat.ambient(STATE).line.text)) glow++;
  assert.ok(glow > 0, 'afterglow');
  t += 60_000;
  for (let i = 0; i < 60; i++) assert.match(chat.ambient(STATE).line.text, /explore/);
});

test('a pack without tagged lines: no bursts, calm chat as before', () => {
  const chat = createChat({ lines: normalizeChatLines([L('a', 'one'), L('b', 'two'), L('c', 'three')]), rng: seeded(1) });
  const r = chat.react({ kind: 'roll', nat20: true }, STATE);
  assert.equal(r.lines.length, 0);
  for (let i = 0; i < 10; i++) assert.ok(chat.ambient({ scene: { kind: 'boss', data: {} } }).line);
});

// ---------- host wiring ----------

function hostSetup(chatLines) {
  const dir = writePack(tmpDir(), { 'chat.json': chatLines });
  const { pack } = loadPack(dir);
  let t = 1_800_000_000_000;
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
  const host = createHost({
    pack, state: createState(pack, t), now: () => t, timers, rng: seeded(21), log: { log() {}, warn() {}, error() {} },
    gmKey: 'k-k-k-k-k-k', legacy: false, base: 'https://x.example',
    send: (c, s) => c.inbox.push(JSON.parse(s)), close: (c, code) => { c.closed = code; },
  });
  const sock = () => {
    const c = { inbox: [] };
    host.connect(c, { ip: '1.1.1.1' });
    c.send = (m) => host.message(c, JSON.stringify(m));
    return c;
  };
  const gm = sock();
  gm.send({ t: 'hello', role: 'gm', key: 'k-k-k-k-k-k' });
  return { host, gm, sock, advance, now: () => t };
}
const chats = (c) => c.inbox.filter((m) => m.t === 'event' && m.event.kind === 'chat').map((m) => m.event);
const tick = () => new Promise((r) => setImmediate(r));

test('host: calm chat only while a TV is on, lines match the scene', async () => {
  const { gm, sock, advance } = hostSetup([
    L('lob', 'lobby line', ['lobby']), L('lob2', 'lobby two', ['lobby']), L('cd', 'countdown line', ['countdown']),
    L('cd2', 'countdown two', ['countdown']), L('cd3', 'countdown three', ['countdown']),
  ]);
  advance(60_000);
  assert.equal(chats(gm).length, 0, 'GM never gets chat');
  const tv = sock();
  tv.send({ t: 'hello', role: 'stage', key: 'k-k-k-k-k-k' });
  advance(60_000);
  const lobby = chats(tv);
  assert.ok(lobby.length >= 3, `lobby lines ${lobby.length}`);
  assert.ok(lobby.every((e) => e.tag === 'lobby' && /lobby/.test(e.text)));
  // Switch to a countdown: a small burst, then countdown chatter.
  gm.send({ t: 'scene.set', kind: 'countdown', data: { label: 'Floor collapses', seconds: 600 }, rid: 'c1' });
  await tick();
  tv.inbox.length = 0;
  advance(30_000);
  const cd = chats(tv);
  assert.ok(cd.length >= 3, `countdown lines ${cd.length}`);
  assert.ok(cd.every((e) => /countdown/.test(e.text)), cd.map((e) => e.text).join(' | '));
});

test('host: an achievement triggers a fast burst with the player name', async () => {
  const { gm, sock, advance } = hostSetup([
    L('calm', 'calm line', ['lobby']),
    ...Array.from({ length: 8 }, (_, i) => L(`fan${i}`, `${i}: {player} deserved that`, ['achievement'])),
  ]);
  const tv = sock();
  tv.send({ t: 'hello', role: 'stage', key: 'k-k-k-k-k-k' });
  gm.send({ t: 'player.add', name: 'Bugatti', rid: 'a1' });
  await tick();
  const pid = gm.inbox.find((m) => m.rid === 'a1')?.result?.playerId;
  assert.ok(pid);
  advance(100);
  tv.inbox.length = 0;
  gm.send({ t: 'ach.award', playerId: pid, title: 'Showed up', desc: 'Well done.', rid: 'a2' });
  await tick();
  advance(1_000);
  const first = chats(tv);
  assert.ok(first.length >= 1, 'first reaction within a second');
  advance(6_000);
  const burst = chats(tv).filter((e) => e.tag === 'achievement');
  assert.ok(burst.length >= 2 && burst.length <= 4, `burst ${burst.length}`);
  assert.ok(burst.every((e) => e.text.includes('Bugatti deserved that')));
  assert.equal(new Set(burst.map((e) => e.text)).size, burst.length, 'no repeats inside a burst');
});

test('host: boss intro bumps viewers (audience reacts), nat1 from a secret roll does not chat', async () => {
  const { gm, sock, advance } = hostSetup([L('b', 'boss line', ['boss']), L('b2', 'boss line 2', ['boss']), L('b3', 'boss line 3', ['boss']), L('n', 'nat1 line', ['nat1'])]);
  const tv = sock();
  tv.send({ t: 'hello', role: 'stage', key: 'k-k-k-k-k-k' });
  advance(100);
  const viewersBefore = tv.inbox.filter((m) => m.t === 'view' || m.t === 'welcome').pop().view.audience.viewers;
  gm.send({ t: 'scene.set', kind: 'boss', data: { boss: { name: 'Grimble', hpSlots: 10 } }, rid: 'b1' });
  await tick();
  gm.send({ t: 'boss.intro', rid: 'b2' });
  await tick();
  advance(200);
  const bump = tv.inbox.filter((m) => m.t === 'event' && m.event.kind === 'viewers');
  assert.ok(bump.length >= 1, 'viewers event');
  assert.ok(bump.at(-1).event.viewers > viewersBefore * 1.07, `${viewersBefore} → ${bump.at(-1).event.viewers}`);
  advance(8_000);
  assert.ok(chats(tv).filter((e) => e.tag === 'boss').length >= 3);
  // A secret roll never reaches the TV, so it never makes the audience talk.
  tv.inbox.length = 0;
  for (let i = 0; i < 30; i++) {
    gm.send({ t: 'roll', what: { kind: 'custom', formula: 'd20', label: 'x' }, secret: true, rid: `s${i}` });
    await tick();
  }
  advance(2_000);
  assert.equal(chats(tv).filter((e) => e.tag === 'nat1').length, 0);
});
