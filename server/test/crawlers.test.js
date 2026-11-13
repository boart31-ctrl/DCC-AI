// crawlers.js: the worldwide "crawlers remaining" count — state, reducers, organic tick, views, voice chain,
// chat reaction and the host timer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { serializePack, deserializePack, fallbackPack } from '../pack-core.js';
import { createState, normalizeState, reduce, viewFor, GM_ACTIONS } from '../state.js';
import {
  normalizeCrawlersConfig, floorRule, decay, crawlersAt, crawlersLive, fmtCount,
  TICK_MS, MAX_GAP_MS, IDLE_MS, DEFAULT_EVENTS,
} from '../crawlers.js';
import { VoiceQueue } from '../quips.js';
import { createChat, reactionFor } from '../chat.js';
import { createHost, LIMITS } from '../host.js';
import { tmpDir, writePack, seq } from './fixtures.js';

const CRAWLERS = {
  label: 'Crawlers remaining',
  floors: [
    { floor: 1, start: 1_000_000_000, perHour: 0.1 },
    { floor: 2, start: 400_000_000, perHour: 0.08, min: 300_000_000 },
    { floor: 3, start: 100_000_000 },
  ],
  events: [
    { id: 'boss', label: 'Bosses elsewhere', min: 0.01, max: 0.01 },
    { id: 'massacre', label: 'Massacre', min: 0.2, max: 0.2, line: 'crawlers_massacre' },
  ],
  numberLine: '{count} crawlers remain. Probably.',
};
const quips = [
  { id: 'cr_count', category: 'crawlers_remaining', text: 'Attention crawlers. A count has been taken.' },
  { id: 'cr_drop', category: 'crawlers_drop', text: 'Oof. That was a lot of you.' },
  { id: 'cr_collapse', category: 'crawlers_collapse', text: 'The floor has collapsed.' },
  { id: 'death_1', category: 'death', text: 'Somebody died.' },
];
const dir = writePack(tmpDir(), {
  'pack.json': {
    id: 'cr', name: 'Crawl', version: '1.0.0', lootTiers: [{ id: 'bronze', name: 'Bronze', color: '#cd7f32' }],
    stats: [{ id: 'str', label: 'Strength', abbr: 'STR', default: 3 }],
    resources: [{ id: 'hp', label: 'Health', color: '#ff3355', default: 10 }],
    crawlers: CRAWLERS,
  },
  'quips.json': quips,
});
const { pack, warnings } = loadPack(dir);
const T0 = 1_800_000_000_000;

let n = 0;
const ctx = (extra = {}) => ({ now: T0, rng: seq(0.5), genId: (p) => `${p}_${++n}`, pack, ...extra });
const gm = (state, a, extra) => reduce(state, { role: 'gm', ...a }, ctx(extra));
const sys = (state, a, extra) => reduce(state, { role: 'system', ...a }, ctx(extra));
/** A state where the table was just active (host.lastActionAt), so the count is live. */
const active = (s, at = T0) => ({ ...s, host: { ...(s.host ?? {}), lastActionAt: at } });

test('pack config: normalized, derived floors, serialize round-trip, defaults without config', () => {
  assert.deepEqual(warnings.filter((w) => w.includes('crawlers')), []);
  assert.equal(pack.crawlers.floors.length, 3);
  assert.equal(pack.crawlers.events[1].line, 'crawlers_massacre');
  assert.equal(pack.crawlers.events[0].line, 'crawlers_drop');
  const back = deserializePack(JSON.stringify(serializePack(pack)));
  assert.deepEqual(back.crawlers, pack.crawlers);
  // floor 1: min derived from the next floor's start (×1.15) or half its own start, whichever is higher
  assert.deepEqual(floorRule(pack.crawlers, 1), { start: 1e9, perHour: 0.1, min: 5e8, nextStart: 4e8 });
  assert.equal(floorRule(pack.crawlers, 2).min, 3e8);
  // floor 4 is not listed: floor 3's start × collapseKeep (0.4)
  assert.equal(floorRule(pack.crawlers, 4).start, 40_000_000);
  assert.equal(floorRule(pack.crawlers, 3).perHour, 0.04); // pack-wide default
  const d = fallbackPack().crawlers;
  assert.equal(d.start, 1_000_000);
  assert.deepEqual(d.events.map((e) => e.id), DEFAULT_EVENTS.map((e) => e.id));
  const w = [];
  const bad = normalizeCrawlersConfig({ floors: [{ floor: 0 }, { floor: 2, start: -5 }], events: [{ id: 'X Y' }], numberLine: 'no count here' }, w);
  assert.equal(bad.floors.length, 1);
  assert.equal(bad.floors[0].start, null);
  assert.equal(bad.events.length, 0);
  assert.equal(bad.numberLine, '{count} crawlers remain.');
  assert.ok(w.length >= 2);
});

test('state: default on floor 1, kept by normalizeState and session.new, repaired when broken', () => {
  const s = createState(pack, T0);
  assert.equal(s.crawlers.count, 1e9);
  assert.equal(s.crawlers.floor, 1);
  assert.equal(s.crawlers.running, true);
  assert.equal(s.crawlers.shown, true);
  const edited = gm(s, { t: 'crawlers.set', count: 123_456, floor: 4, running: false }).state;
  const back = normalizeState(JSON.parse(JSON.stringify(edited)), pack, T0 + 5);
  assert.equal(back.crawlers.count, 123_456);
  assert.equal(back.crawlers.floor, 4);
  assert.equal(back.crawlers.running, false);
  const fresh = gm(edited, { t: 'session.new' }).state;
  assert.equal(fresh.crawlers.count, 123_456);
  const old = normalizeState({ players: [] }, pack, T0); // a save from before the counter existed
  assert.equal(old.crawlers.count, 1e9);
  const broken = normalizeState({ crawlers: { count: 'many', floor: 500, history: 'x' } }, pack, T0);
  assert.equal(broken.crawlers.count, 1e9);
  assert.equal(broken.crawlers.floor, 1);
  assert.deepEqual(broken.crawlers.history, []);
});

test('decay: slows toward the minimum, never below it, one step capped at MAX_GAP_MS', () => {
  assert.equal(decay(100, 100, 0.5, 3_600_000), 100);
  assert.equal(decay(1000, 0, 0, 3_600_000), 1000);
  const step = decay(1e9, 5e8, 0.1, MAX_GAP_MS);
  assert.ok(step < 1e9 && step > 5e8);
  assert.equal(decay(1e9, 5e8, 0.1, 7 * 24 * 3_600_000), step); // a week asleep = one capped step
  let x = 1e9;
  for (let i = 0; i < 2000; i++) x = decay(x, 5e8, 0.1, MAX_GAP_MS);
  assert.ok(x >= 5e8);
});

test('crawlers.tick: only when live (running + active table), not more than once per TICK_MS', () => {
  let s = active(createState(pack, T0));
  assert.equal(sys(s, { t: 'crawlers.tick' }, { now: T0 + TICK_MS - 1 }).changed, false);
  const r = sys(s, { t: 'crawlers.tick' }, { now: T0 + TICK_MS });
  assert.equal(r.changed, true);
  assert.ok(r.state.crawlers.count < 1e9);
  assert.equal(r.state.crawlers.at, T0 + TICK_MS);
  assert.equal(r.state.crawlers.count, crawlersAt(s, pack, T0 + TICK_MS));
  // idle table: nothing moves (and nothing is written)
  const idle = sys(s, { t: 'crawlers.tick' }, { now: T0 + IDLE_MS + 1 });
  assert.equal(idle.changed, false);
  assert.equal(crawlersLive(s, T0 + IDLE_MS + 1), false);
  // paused
  s = active(gm(s, { t: 'crawlers.set', running: false }).state);
  assert.equal(sys(s, { t: 'crawlers.tick' }, { now: T0 + 5 * TICK_MS }).changed, false);
  // never below the party: a tiny world with 2 crawlers at the table
  let tiny = gm(createState(pack, T0), { t: 'player.add', name: 'Carl' }).state;
  tiny = gm(tiny, { t: 'player.add', name: 'Donut' }).state;
  tiny = active(gm(tiny, { t: 'crawlers.set', count: 3, floor: 9 }).state);
  for (let i = 1; i < 50; i++) tiny = active(sys(tiny, { t: 'crawlers.tick' }, { now: T0 + i * MAX_GAP_MS }).state, T0 + i * MAX_GAP_MS);
  assert.ok(tiny.crawlers.count >= 2);
});

test('crawlers.set / adjust: validation, settles live attrition first', () => {
  const s = active(createState(pack, T0));
  for (const a of [{}, { count: -1 }, { count: 1.5 }, { floor: 0 }, { floor: 100 }, { running: 'yes' }]) {
    assert.throws(() => gm(s, { t: 'crawlers.set', ...a }), /bad_request|must|give/);
  }
  assert.throws(() => gm(s, { t: 'crawlers.adjust', delta: 0 }));
  const later = T0 + 60_000;
  const r = gm(s, { t: 'crawlers.adjust', delta: -10 }, { now: later });
  assert.equal(r.state.crawlers.count, crawlersAt(s, pack, later) - 10);
  assert.equal(r.state.crawlers.at, later);
  // a TV that is off: the count stood still on every screen, so nothing is baked in
  const off = gm(s, { t: 'crawlers.adjust', delta: -10 }, { now: later, stageOn: false });
  assert.equal(off.state.crawlers.count, 1e9 - 10);
  assert.ok(GM_ACTIONS.includes('crawlers.drop'));
});

test('crawlers.drop: pack event → share of the living, TV event, feed, lead-in + chained number', () => {
  const s = createState(pack, T0);
  const r = gm(s, { t: 'crawlers.drop', event: 'boss' }, { stageOn: false });
  assert.equal(r.result.lost, 10_000_000);
  assert.equal(r.state.crawlers.count, 990_000_000);
  const ev = r.events.find((x) => x.event.kind === 'crawlers').event;
  assert.equal(ev.reason, 'boss');
  assert.equal(ev.from, 1e9);
  assert.equal(ev.to, 990_000_000);
  assert.equal(ev.moment, true);
  assert.equal(ev.voiceCue, true); // GM desk is the audio device by default
  assert.match(r.state.feed.at(-1).text, /Bosses elsewhere: −10,000,000\. 990,000,000 remain/);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].text, 'Oof. That was a lot of you.');
  assert.equal(r.lines[0].priority, 0);
  assert.equal(r.lines[0].cue, ev.id);
  assert.equal(r.lines[0].chain.text, '990,000,000 crawlers remain. Probably.');
  assert.equal(r.state.crawlers.last.reason, 'boss');
  assert.equal(r.state.crawlers.history.length, 1);
  // event with its own line category that has no quips → falls back to the count lead-in
  const m = gm(s, { t: 'crawlers.drop', event: 'massacre' }, { stageOn: false });
  assert.equal(m.lines[0].text, 'Attention crawlers. A count has been taken.');
  // speak off: lead-in only; announce false: no line at all
  const quiet = gm(gm(s, { t: 'crawlers.set', speak: false }).state, { t: 'crawlers.drop', pct: 0.5 }, { stageOn: false });
  assert.equal(quiet.lines[0].chain, undefined);
  assert.equal(quiet.state.crawlers.count, 5e8);
  assert.equal(gm(s, { t: 'crawlers.drop', amount: 5, announce: false }).lines.length, 0);
  assert.throws(() => gm(s, { t: 'crawlers.drop', event: 'nope' }), /unknown crawler event/);
  assert.throws(() => gm(s, { t: 'crawlers.drop' }), /give event/);
  assert.throws(() => gm(s, { t: 'crawlers.drop', pct: 2 }));
});

test('crawlers.collapse: next floor, count to its start (never up), System line', () => {
  const s = createState(pack, T0);
  const r = gm(s, { t: 'crawlers.collapse' }, { stageOn: false }); // rng 0.5 → exactly the start
  assert.equal(r.state.crawlers.floor, 2);
  assert.equal(r.state.crawlers.count, 400_000_000);
  assert.equal(r.state.crawlers.start, 400_000_000);
  assert.equal(r.result.floor, 2);
  const ev = r.events.find((x) => x.event.kind === 'crawlers').event;
  assert.equal(ev.reason, 'collapse');
  assert.equal(ev.label, 'Floor 1 collapsed');
  assert.equal(r.lines[0].text, 'The floor has collapsed.');
  // already below the next start: the count stays
  const low = gm(gm(s, { t: 'crawlers.set', count: 5 }).state, { t: 'crawlers.collapse' }, { stageOn: false });
  assert.equal(low.state.crawlers.count, 5);
  assert.throws(() => gm(s, { t: 'crawlers.collapse', floor: 1 }), /already on floor 1/);
  assert.equal(gm(s, { t: 'crawlers.collapse', floor: 3 }, { stageOn: false }).state.crawlers.floor, 3);
});

test('crawlers.death / announce: −1 called out with a death line; announce reads the count', () => {
  let s = createState(pack, T0);
  const add = gm(s, { t: 'player.add', name: 'Carl' });
  s = add.state;
  const d = gm(s, { t: 'crawlers.death', playerId: add.result.playerId }, { stageOn: false });
  assert.equal(d.state.crawlers.count, 1e9 - 1);
  const ev = d.events[0].event;
  assert.equal(ev.moment, false);
  assert.equal(ev.label, 'Carl died');
  assert.equal(d.lines[0].text, 'Somebody died.');
  assert.match(d.state.feed.at(-1).text, /^Carl died\. 999,999,999 crawlers remain/);
  assert.throws(() => gm(s, { t: 'crawlers.death', playerId: 'p_nope' }), /no player/);
  const a = gm(s, { t: 'crawlers.announce' }, { stageOn: false });
  assert.equal(a.result.count, 1e9);
  assert.equal(a.lines[0].text, 'Attention crawlers. A count has been taken.');
  assert.equal(a.lines[0].chain.text, '1,000,000,000 crawlers remain. Probably.');
});

test('views: every role gets the HUD data, only the GM the controls; live needs a TV', () => {
  const s = active(createState(pack, T0));
  const stage = viewFor(s, pack, 'stage', { now: T0 + 1000 });
  assert.equal(stage.crawlers.count, 1e9);
  assert.equal(stage.crawlers.live, true);
  assert.equal(stage.crawlers.perHour, 0.1);
  assert.equal(stage.crawlers.min, 5e8);
  assert.equal(stage.crawlers.label, 'Crawlers remaining');
  assert.equal(stage.crawlers.history, undefined);
  assert.equal(stage.crawlers.events, undefined);
  const g = viewFor(s, pack, 'gm', { now: T0 + 1000, stageOn: false });
  assert.equal(g.crawlers.live, false);
  assert.deepEqual(g.crawlers.events.map((e) => e.id), ['boss', 'massacre']);
  assert.equal(g.crawlers.nextFloor, 2);
  assert.equal(g.crawlers.nextStart, 4e8);
  assert.equal(fmtCount(1234567), '1,234,567');
});

test('VoiceQueue: a chained line starts right after its lead-in is done', () => {
  let id = 0;
  const played = [];
  const q = new VoiceQueue({
    now: () => 0, genId: () => `q${++id}`, getSession: () => ({ mode: 'quiet', auto: false, budgetLeft: 0 }),
    onPlay: (item) => played.push(item.text),
  });
  q.push({ priority: 0, text: 'Attention crawlers.', chain: { priority: 0, text: '12 crawlers remain.' } });
  assert.deepEqual(played, ['Attention crawlers.']);
  q.done(q.playing.id);
  assert.deepEqual(played, ['Attention crawlers.', '12 crawlers remain.']);
  q.done(q.playing.id);
  assert.equal(q.playing, null);
  // a P0 in between drops the chain
  q.push({ priority: 0, text: 'Lead.', chain: { text: 'Number.' } });
  q.push({ priority: 0, text: 'Interrupt.' });
  q.done(q.playing.id);
  assert.deepEqual(played.slice(-2), ['Lead.', 'Interrupt.']);
});

test('chat: crawler events burst with {count} / {lost}', () => {
  const lines = [
    { user: 'goblin', text: '{lost} gone, {count} left lol', tags: ['crawlers_drop'] },
    { user: 'ref', text: 'FLOOR DOWN', tags: ['floor_collapse'] },
  ];
  const chat = createChat({ lines, rng: seq(0) });
  const r = chat.react({ kind: 'crawlers', reason: 'boss', from: 1000, to: 900 }, { players: [] });
  assert.equal(r.key, 'crawlers_drop');
  assert.equal(r.lines[0].text, '100 gone, 900 left lol');
  assert.equal(reactionFor({ kind: 'crawlers', reason: 'collapse', from: 2, to: 1 }).key, 'floor_collapse');
  assert.equal(reactionFor({ kind: 'crawlers', reason: 'death', from: 2, to: 1 }).key, 'death');
  assert.equal(reactionFor({ kind: 'crawlers', reason: 'announce', from: 2, to: 2 }).key, 'crawlers_count');
});

test('host: the count ticks only while a TV is on air; announce plays lead-in then the number', async () => {
  let t = T0;
  const q = [];
  const timers = {
    setTimeout(fn, ms) { const h = { at: t + ms, fn }; q.push(h); return h; },
    clearTimeout(h) { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); },
  };
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      q.sort((a, b) => a.at - b.at);
      if (!q.length || q[0].at > end) break;
      const h = q.shift();
      t = Math.max(t, h.at);
      h.fn();
    }
    t = end;
  };
  const KEY = 'k-e-y-k-e-y-k-e-y';
  const writes = [];
  const host = createHost({
    pack, state: createState(pack, T0), now: () => t, timers, chat: false, gmKey: KEY, legacy: false,
    log: { log() {}, warn() {}, error() {} },
    send: (conn, text) => conn.inbox.push(JSON.parse(text)),
    close: () => {},
    persist: (st, e) => writes.push(e),
  });
  const sock = (hello) => {
    const c = { inbox: [] };
    host.connect(c, { ip: '1.2.3.4' });
    host.message(c, JSON.stringify(hello));
    return c;
  };
  const g = sock({ t: 'hello', role: 'gm', key: KEY });
  const send = async (a) => { host.message(g, JSON.stringify({ ...a, rid: 'x' })); await new Promise((r) => setImmediate(r)); };
  await send({ t: 'crawlers.set', running: true }); // table activity
  const start = host.state.crawlers.count;
  advance(5 * TICK_MS);
  assert.equal(host.state.crawlers.count, start); // no TV: nothing moves
  const tv = sock({ t: 'hello', role: 'stage', key: KEY });
  advance(2 * TICK_MS + LIMITS.audienceTickMs);
  assert.ok(host.state.crawlers.count < start, 'TV on air: attrition');
  const tvView = [...tv.inbox].reverse().find((m) => m.t === 'view').view;
  assert.equal(tvView.crawlers.live, true);
  await send({ t: 'crawlers.announce' });
  const plays = () => g.inbox.filter((m) => m.t === 'play');
  assert.equal(plays().length, 1);
  assert.equal(plays()[0].text, 'Attention crawlers. A count has been taken.');
  assert.ok(plays()[0].cue);
  await send({ t: 'audio.done', id: plays()[0].id });
  assert.equal(plays().length, 2);
  assert.match(plays()[1].text, /^[\d,]+ crawlers remain\. Probably\.$/);
  assert.ok(tv.inbox.some((m) => m.t === 'event' && m.event.kind === 'crawlers' && m.event.reason === 'announce'));
  host.close?.();
});
