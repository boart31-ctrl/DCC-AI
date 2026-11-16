// web/js/prep-bench.js: encounter strength per family, always from the live party size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchmark, crawlerTable } from '../../web/js/prep-bench.js';

const party = (n, level = 1) => Array.from({ length: n }, () => ({ level }));

test('crawler: mobs vs party size, bosses count once per crawler, minions half', () => {
  assert.equal(benchmark('crawler', party(4), [{ count: 2 }]).label, 'Weak');
  assert.equal(benchmark('crawler', party(4), [{ count: 4 }]).label, 'Moderate');
  assert.equal(benchmark('crawler', party(4), [{ count: 6 }]).label, 'Strong');
  assert.equal(benchmark('crawler', party(4), [{ count: 8 }]).label, 'Overwhelming');
  assert.equal(benchmark('crawler', party(3), [{ count: 3 }]).label, 'Moderate', 'scales with 3 players');
  assert.equal(benchmark('crawler', party(6), [{ count: 6 }]).label, 'Moderate', 'scales with 6 players');
  assert.equal(benchmark('crawler', party(4), [{ role: 'boss' }]).label, 'Moderate');
  assert.equal(benchmark('crawler', party(4), [{ role: 'boss' }, { count: 2 }]).label, 'Strong');
  assert.equal(benchmark('crawler', party(4), [{ role: 'minion', count: 4 }]).label, 'Weak');
  assert.equal(benchmark('crawler', [], [{ count: 1 }]).label, 'Moderate', 'empty party counts as one');
  assert.equal(benchmark('crawler', party(4), []).level, -1);
  assert.deepEqual(crawlerTable(4).map((r) => r.mobs), [2, 4, 6, 8]);
  assert.deepEqual(crawlerTable(5).map((r) => r.mobs), [3, 5, 8, 10]);
});

test('dnd: Lazy benchmark (quarter of levels, half above level 4)', () => {
  assert.equal(benchmark('dnd', party(4, 3), [{ cr: 1, count: 2 }]).label, 'Fair'); // 2 vs 3
  assert.equal(benchmark('dnd', party(4, 3), [{ cr: 1, count: 4 }]).label, 'May be deadly'); // 4 vs 3
  assert.equal(benchmark('dnd', party(4, 8), [{ cr: 5, count: 4 }]).label, 'May be deadly'); // 20 vs 16
  assert.equal(benchmark('dnd', party(4, 8), [{ cr: 2 }]).label, 'Easy');
});

test('pf2e: XP budget scaled for party size', () => {
  assert.equal(benchmark('pf2e', party(4, 3), [{ level: 3, count: 2 }]).label, 'Moderate'); // 80
  assert.equal(benchmark('pf2e', party(4, 3), [{ level: 5 }, { level: 3 }]).label, 'Severe'); // 120
  assert.equal(benchmark('pf2e', party(5, 3), [{ level: 3, count: 2 }]).label, 'Moderate', '80 ≤ 100 for five'); // budget 100
  assert.equal(benchmark('pf2e', party(4, 3), [{ level: -5 }]).label, 'Trivial');
});
