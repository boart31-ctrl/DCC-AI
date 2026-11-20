import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attackPlayback, attackResultText } from '../../web/js/scenes/common.js';

test('TV plays a reaction batch and consecutive AUTO commits in order with intermediate crawler health', () => {
  let now = 0;
  const timers = new Set();
  const T = {
    after(ms, fn) {
      const entry = { at: now + ms, fn };
      timers.add(entry);
      return entry;
    },
    stop(entry) { timers.delete(entry); },
  };
  function advance(until) {
    for (;;) {
      const next = [...timers].filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      timers.delete(next);
      next.fn();
    }
    now = until;
  }
  const frames = [];
  const tv = attackPlayback({ T, clock: { now: () => now }, reduced: true }, {
    start(st) { frames.push(['attack', st.mob, st.target]); },
    result(st) { frames.push(['result', st.attack, attackResultText(st), tv.health.get(st.targetUid)]); },
    finish(st) { frames.push(['finish', st.attack]); },
    refresh() {},
  });
  const target = { target: 'Hero', targetUid: 'hero', mob: 'Foe', mobUid: 'foe' };
  tv.enqueue({ kind: 'rx.hit', ...target, attack: 'Strike', result: 'hit', slots: 2, hpBefore: 3, hpAfter: 1 });
  tv.enqueue({ kind: 'rx.hit', ...target, attack: 'Follow up', result: 'hit', slots: 1, hpBefore: 1, hpAfter: 0, dyingAfter: 3, down: true, danger: 'dying' });
  assert.equal(tv.health.get('hero').hp, 3, 'event batch does not jump to the committed final health');
  advance(650);
  assert.deepEqual(frames.map(([kind]) => kind), ['attack', 'result']);
  assert.equal(frames[1][3].hp, 1);
  advance(2200);
  assert.deepEqual(frames.map(([kind]) => kind), ['attack', 'result', 'finish', 'attack', 'result']);
  assert.equal(frames[4][2], 'Dying · −1 slot');
  assert.deepEqual(frames[4][3], { hp: 0, down: true, dying: 3, dead: false });
  advance(3000);
  assert.equal(tv.active, false);
  assert.equal(tv.health.size, 0);

  const auto = { kind: 'combat.auto', startAt: 3010, stepMs: 100 };
  const swing = { ...target, hpBefore: 5, hpAfter: 5, hit: false, total: 10, evade: 12 };
  tv.enqueue({ ...auto, steps: [{ ...swing, attack: 'First' }, { ...swing, attack: 'Second' }] });
  tv.enqueue({ ...auto, steps: [{ ...swing, attack: 'Third' }] });
  advance(3309);
  assert.deepEqual(frames.filter(([kind]) => kind === 'result').slice(-3).map(([, attack]) => attack), ['First', 'Second', 'Third']);
  tv.stop();
  assert.equal(timers.size, 0);
  assert.equal(tv.active, false);
});
