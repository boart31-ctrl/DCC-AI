// web/js/prep-bench.js: encounter strength per family, always from the live party size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchmark, crawlerTable } from '../../web/js/prep-bench.js';
import { fitToParty } from '../../web/js/gm-encounter.js';

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
  const table = [[1, 2, 3, 4], [2, 3, 5, 6], [2, 4, 6, 8], [3, 5, 8, 10], [3, 6, 9, 12], [4, 7, 11, 14]];
  table.forEach((row, i) => assert.deepEqual(crawlerTable(i + 2).map((r) => r.mobs), row));
  const almost = benchmark('crawler', party(7), [{ count: 13 }]);
  assert.equal(almost.label, 'Strong');
  assert.match(almost.detail, /13 mobs vs 7 crawlers.*Weak 4 · Moderate 7 · Strong 11 · Overwhelming 14\+/);
  assert.equal(benchmark('crawler', party(7), [{ count: 14 }]).label, 'Overwhelming');
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


test('fitToParty preserves boss/elite counts and includes all of them in the strength budget', () => {
  const view = {
    players: party(4),
    library: { monster: [{ id: 'grunt', role: 'standard' }], boss: [{ id: 'boss', role: 'boss' }] },
  };
  const payload = { mobs: [{ kind: 'boss', sourceId: 'boss', count: 2 }, { kind: 'monster', sourceId: 'grunt', count: 3 }] };
  const fitted = fitToParty(view, payload, 2);
  assert.equal(fitted.find((m) => m.sourceId === 'boss').count, 2, 'must not silently delete a boss');
  assert.equal(fitted.find((m) => m.sourceId === 'grunt').count, 1, 'two bosses already exhaust the overwhelming budget');
  const b = benchmark('crawler', view.players, fitted.map((m) => ({ role: m.kind === 'boss' ? 'boss' : 'standard', count: m.count })));
  assert.equal(b.level, 3);
  const standardOnly = { mobs: [{ kind: 'monster', sourceId: 'grunt', count: 3 }] };
  assert.equal(fitToParty({ ...view, players: party(3) }, standardOnly, 1.5)[0].count, 5, 'Strong rounds up for three players');
  assert.equal(fitToParty({ ...view, players: party(5) }, standardOnly, 0.5)[0].count, 3, 'Weak rounds up for five players');
});
