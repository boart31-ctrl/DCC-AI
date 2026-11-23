import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { createState, reduce, viewFor } from '../state.js';

function dcc() {
  const { pack } = loadPack(new URL('../../packs/demo', import.meta.url).pathname);
  // Chases need a seven-degree ruleset (the crawler packs); the mechanics only read this flag.
  pack.ruleset.combat = { ...pack.ruleset.combat, degreeScale: 'seven' };
  return pack;
}

function setup(pack, dice) {
  let n = 0;
  let i = 0;
  let r = 7;
  const ctx = { pack, now: 1, rng: () => 0.5, genId: (p) => `${p}_${++n}`, randInt: (k) => (r = (r * 31 + 11) % 997) % k, dieInt: (k) => (dice[i++ % dice.length] - 1) % k };
  let state = createState(pack, 0);
  const step = (a) => { const r = reduce(state, { role: 'gm', ...a }, ctx); state = r.state; return r; };
  return { step, get state() { return state; }, ctx };
}

test('chase: Ground by degree, caught at 4 or after the last leg, critical fail is out, NPC chaser rolls fixed', (t) => {
  const pack = dcc();
  if (pack.ruleset.combat?.degreeScale !== 'seven') return t.skip('demo pack is not seven-degree');
  const s = setup(pack, [20]);
  const a = s.step({ t: 'player.add', name: 'Carl' }).result.playerId;
  const stat = pack.ruleset.stats[0].id;
  s.step({ t: 'scene.set', kind: 'chase', data: { mode: 'chase', title: 'Catch the dragon', quarry: { name: 'Dragonling', value: 30 }, legs: [{ label: 'Run', statId: stat }, { label: 'Jump', statId: stat }, { label: 'Climb', statId: stat, value: 5 }], npcs: [{ name: 'Helper', value: 31 }] } });
  let d = s.state.scene.data;
  assert.equal(d.legs[0].value, 30);
  assert.equal(d.runners.length, 2);
  const r1 = s.step({ t: 'chase.leg' }).result; // nat 20 → crit → +2; helper 31 vs 30 → success +1
  assert.equal(r1.results.find((x) => x.runnerId === `p_${a}`).delta, 2);
  assert.equal(r1.results.find((x) => x.runnerId === 'n_0').delta, 1);
  s.step({ t: 'chase.leg' }); // +2 → 4 → caught early
  d = s.state.scene.data;
  assert.equal(d.runners[0].caught, true);
  s.step({ t: 'chase.leg', entries: [{ playerId: a, entered: 1 }] }); // only the helper rolls (31 vs 5 → amazing +2)
  d = s.state.scene.data;
  assert.equal(d.done, true);
  assert.equal(d.runners[1].ground, 1 + 1 + 2);
  assert.equal(d.result.caught, true);
  assert.equal(d.result.first, `p_${a}`);
  assert.throws(() => s.step({ t: 'chase.leg' }), /over/);
  assert.equal(viewFor(s.state, pack, 'stage', s.ctx).scene.kind, 'chase');
});

test('chase: critical fail drops out; GM adjust; race placements, lowest total wins', (t) => {
  const pack = dcc();
  const stat = pack.ruleset.stats[0].id;
  const s = setup(pack, [1]);
  const a = s.step({ t: 'player.add', name: 'Carl' }).result.playerId;
  const b = s.step({ t: 'player.add', name: 'Donut' }).result.playerId;
  if (pack.ruleset.combat?.degreeScale === 'seven') {
    s.step({ t: 'scene.set', kind: 'chase', data: { quarry: { name: 'Rat' }, legs: [{ statId: stat }, { statId: stat }] } });
    s.step({ t: 'chase.leg', entries: [{ playerId: b, entered: 15 }] });
    const d = s.state.scene.data;
    assert.equal(d.runners.find((r) => r.playerId === a).out, true);
    s.step({ t: 'chase.adjust', runnerId: `p_${b}`, ground: 3 });
    s.step({ t: 'chase.finish' });
    assert.equal(s.state.scene.data.result.first, `p_${b}`);
  }
  s.step({ t: 'scene.set', kind: 'chase', data: { mode: 'race', title: 'Stairwell dash', legs: [{ statId: stat }, { statId: stat }, { statId: stat }], npcs: [{ name: 'Raul', value: 12 }] } });
  s.step({ t: 'chase.leg', entries: [{ playerId: a, entered: 20 }, { playerId: b, entered: 2 }] });
  s.step({ t: 'chase.leg', entries: [{ playerId: a, entered: 3 }, { playerId: b, entered: 19 }] });
  s.step({ t: 'chase.leg', entries: [{ playerId: a, entered: 18 }, { playerId: b, entered: 4 }] });
  const d = s.state.scene.data;
  assert.equal(d.done, true);
  assert.equal(d.result.winner, `p_${a}`);
  assert.deepEqual(d.runners.find((r) => r.playerId === a).places, [1, 3, 1]);
  assert.throws(() => s.step({ t: 'scene.set', kind: 'chase', data: { legs: [] } }), /legs/);
});

test('prep chase scene: Run puts the chase on the TV once, with the legs from prep', () => {
  const pack = dcc();
  const s = setup(pack, [12]);
  s.step({ t: 'player.add', name: 'Carl' });
  const ev = s.step({ t: 'prep.evening.build', title: 'Test', recipe: ['chase'], suggest: false }).result;
  const doc = s.state.prep.docs.find((d) => d.id === ev.id);
  const sc = doc.evening.scenes[0];
  assert.equal(sc.type, 'chase');
  const stat = pack.ruleset.stats[0].id;
  s.step({ t: 'prep.scene.update', id: doc.id, sceneId: sc.id, patch: { chase: { mode: 'chase', quarry: { name: 'Andárnička', value: 14 }, legs: [{ label: 'Through the shelves', statId: stat, hazard: 'Books fall' }, { label: 'Up the ladder', statId: stat }] } } });
  s.step({ t: 'prep.scene.run', id: doc.id, sceneId: sc.id });
  const d = s.state.scene.data;
  assert.equal(s.state.scene.kind, 'chase');
  assert.equal(d.quarry.name, 'Andárnička');
  assert.deepEqual(d.legs.map((l) => [l.label, l.value, l.hazard ?? null]), [['Through the shelves', 14, 'Books fall'], ['Up the ladder', 14, null]]);
  s.step({ t: 'chase.leg' });
  const id = s.state.scene.id;
  s.step({ t: 'prep.scene.run', id: doc.id, sceneId: sc.id });
  assert.equal(s.state.scene.id, id, 'running the same scene again keeps the chase going');
});
