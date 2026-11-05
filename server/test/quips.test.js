import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { pickQuip, quipsLeft, modeAllows, VoiceQueue, STALE_MS, VETO_MS } from '../quips.js';
import { tmpDir, writePack, seq } from './fixtures.js';

const { pack } = loadPack(writePack(tmpDir()));

test('pickQuip never repeats within a round, then recycles without immediate repeat', () => {
  let used = {};
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const r = pickQuip(pack, used, 'nat1', Math.random);
    used = r.used;
    seen.push(r.quip.id);
  }
  assert.equal(new Set(seen).size, 3);
  assert.equal(quipsLeft(pack, used, 'nat1'), 0);
  const r = pickQuip(pack, used, 'nat1', Math.random);
  assert.notEqual(r.quip.id, seen[2]);
  assert.deepEqual(r.used.nat1, [r.quip.id]);
  assert.equal(pickQuip(pack, {}, 'nope'), null);
});

test('modeAllows', () => {
  assert.ok(modeAllows('quiet', 0));
  assert.ok(!modeAllows('quiet', 1));
  assert.ok(!modeAllows('combat', 1));
  assert.ok(modeAllows('combat', 1, true));
  assert.ok(!modeAllows('combat', 2));
  assert.ok(modeAllows('combat', 2, true));
  assert.ok(modeAllows('roleplay', 2));
});

function harness(session = {}) {
  let t = 1000;
  let n = 0;
  const s = { mode: 'roleplay', auto: true, budgetLeft: 2, ...session };
  const played = [];
  let stops = 0;
  const q = new VoiceQueue({
    now: () => t,
    genId: (p) => `${p}_${++n}`,
    getSession: () => s,
    consumeBudget: () => s.budgetLeft--,
    onPlay: (i) => played.push(i),
    onStop: () => stops++,
  });
  return { q, s, played, advance: (ms) => (t += ms), stops: () => stops };
}

test('P0 plays immediately, P1 waits for audio.done, priority before FIFO', () => {
  const { q, played } = harness();
  q.push({ priority: 0, text: 'a' });
  q.push({ priority: 1, text: 'b' });
  assert.deepEqual(played.map((p) => p.text), ['a']);
  q.push({ priority: 0, text: 'c' }); // P0 never waits behind the queue
  assert.deepEqual(played.map((p) => p.text), ['a', 'c']);
  assert.ok(!q.done('q_1'), 'stale done id is ignored');
  q.done(played[1].id);
  assert.deepEqual(played.map((p) => p.text), ['a', 'c', 'b']);
});

test('P1 is dropped when stale', () => {
  const h = harness();
  h.q.push({ priority: 0, text: 'long' });
  h.q.push({ priority: 1, text: 'late' });
  h.advance(STALE_MS + 1);
  h.q.tick();
  assert.equal(h.q.queue.length, 0);
  h.q.done(h.played[0].id);
  assert.equal(h.played.length, 1);
});

test('P2 requires auto, budget and mode; goes to pending; veto cancels', () => {
  assert.equal(harness({ auto: false }).q.propose({ text: 'x' }).reason, 'auto_off');
  assert.equal(harness({ budgetLeft: 0 }).q.propose({ text: 'x' }).reason, 'no_budget');
  assert.equal(harness({ mode: 'combat' }).q.propose({ text: 'x' }).reason, 'mode');
  assert.equal(harness({ mode: 'quiet' }).q.propose({ text: 'x', crit: true }).reason, 'mode');

  const h = harness({ budgetLeft: 1 });
  const { item } = h.q.propose({ text: 'p2' });
  assert.equal(item.playsAt, 1000 + VETO_MS);
  assert.equal(h.q.propose({ text: 'second' }).reason, 'no_budget', 'pending lines reserve budget');
  assert.equal(h.q.snapshot().pendingAuto.length, 1);
  assert.ok(h.q.veto(item.id));
  h.advance(VETO_MS + 1);
  h.q.tick();
  assert.equal(h.played.length, 0);
  assert.equal(h.s.budgetLeft, 1, 'vetoed line costs nothing');
});

test('P2 promotes after veto window, spends budget, plays after P1', () => {
  const h = harness({ budgetLeft: 2 });
  h.q.push({ priority: 0, text: 'p0' });
  h.q.propose({ text: 'p2' });
  h.advance(VETO_MS);
  h.q.push({ priority: 1, text: 'p1' });
  h.q.tick();
  assert.equal(h.s.budgetLeft, 1);
  assert.deepEqual(h.q.snapshot().queue.map((x) => x.text), ['p1', 'p2']);
  h.q.done(h.played[0].id);
  h.q.done(h.played[1].id);
  assert.deepEqual(h.played.map((p) => p.text), ['p0', 'p1', 'p2']);
});

test('P2 is dropped at promotion if auto was turned off or mode changed', () => {
  const h = harness();
  h.q.propose({ text: 'x' });
  h.s.mode = 'quiet';
  h.advance(VETO_MS);
  h.q.tick();
  assert.equal(h.played.length, 0);
  assert.equal(h.s.budgetLeft, 2);
});

test('mode gating for P1: combat drops non-crit, keeps crits', () => {
  const h = harness({ mode: 'combat' });
  assert.equal(h.q.push({ priority: 1, text: 'ach' }), null);
  assert.ok(h.q.push({ priority: 1, text: 'crit', crit: true }));
  assert.equal(h.played[0].text, 'crit');
});

test('clear drops everything and sends stop', () => {
  const h = harness();
  h.q.push({ priority: 0, text: 'a' });
  h.q.push({ priority: 1, text: 'b' });
  h.q.propose({ text: 'c' });
  h.q.clear();
  assert.deepEqual(h.q.snapshot(), { queue: [], pendingAuto: [], playing: null });
  assert.equal(h.stops(), 1);
});

test('deterministic pick with injected rng', () => {
  const r1 = pickQuip(pack, {}, 'nat1', seq(0));
  const r2 = pickQuip(pack, {}, 'nat1', seq(0.99));
  assert.equal(r1.quip.id, 'nat1_01');
  assert.equal(r2.quip.id, 'nat1_03');
});
