// prep.js director steps: normalisation, position, trail and the voice plan (railroad, 27 Nov).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, reduce, viewFor, normalizeState } from '../state.js';
import { normalizeEvening } from '../prep.js';
import { voiceLines } from '../tts.js';
import { fallbackPack } from '../pack-core.js';

const pack = fallbackPack();
const steps = [
  { id: 'a1', title: 'Corridor', say: '[sighs] Another corridor.', tasks: ['Look around', 7], goal: 'Find the door', gm: 'Trap at the end', do: [{ kind: 'tv' }, { kind: 'ach', ref: 'rt_x' }, { kind: 'nuke' }], next: [{ label: 'Open the door', to: 'a2' }, { label: 'Go back' }] },
  { id: 'a2', title: 'Door', say: 'A door.', end: true },
];

test('director: steps are normalised (bad actions dropped, texts capped)', () => {
  const e = normalizeEvening({ scenes: [{ id: 's1', title: 'One', steps }, { id: 's2', title: 'Two' }] });
  const [st] = e.scenes[0].steps;
  assert.deepEqual(st.tasks, ['Look around']);
  assert.deepEqual(st.do.map((x) => x.kind), ['tv', 'ach']);
  assert.deepEqual(st.next, [{ label: 'Open the door', to: 'a2' }, { label: 'Go back' }]);
  assert.equal(e.scenes[0].steps[1].end, true);
  assert.equal(e.scenes[1].steps, undefined);
});

test('director: go / back / stop keep a trail, and the evening reads its pages through the voice plan', () => {
  let n = 0;
  const ctx = { now: 1, pack, genId: (p) => `${p}_${++n}` };
  const gm = (s, a) => reduce(s, { role: 'gm', ...a }, ctx);
  let s = createState(pack, 0);
  const created = gm(s, { t: 'prep.session.add', title: 'Night' });
  s = created.state;
  const id = created.result.id;
  const doc = s.prep.docs.find((d) => d.id === id);
  doc.evening = normalizeEvening({ scenes: [{ id: 's1', title: 'One', steps }, { id: 's2', title: 'Two', steps: [{ id: 'b1', say: 'Second scene.' }] }] });
  s = normalizeState(JSON.parse(JSON.stringify(s)), pack);
  s = gm(s, { t: 'prep.session.current', id }).state;
  assert.throws(() => gm(s, { t: 'prep.director.go', id, sceneId: 's1', stepId: 'nope' }), /no step/);
  s = gm(s, { t: 'prep.director.go', id, sceneId: 's1', stepId: 'a1' }).state;
  s = gm(s, { t: 'prep.director.go', id, sceneId: 's1', stepId: 'a2' }).state;
  s = gm(s, { t: 'prep.director.go', id, sceneId: 's2', stepId: 'b1' }).state;
  let e = s.prep.docs.find((d) => d.id === id).evening;
  assert.deepEqual([e.director.sceneId, e.director.stepId, e.director.trail.length, e.activeSceneId], ['s2', 'b1', 2, 's2']);
  s = gm(s, { t: 'prep.director.go', id, back: true }).state;
  e = s.prep.docs.find((d) => d.id === id).evening;
  assert.deepEqual([e.director.stepId, e.director.trail.length, e.activeSceneId], ['a2', 1, 's1']);
  assert.equal(normalizeState(JSON.parse(JSON.stringify(s)), pack).prep.docs.find((d) => d.id === id).evening.director.stepId, 'a2');
  const lines = voiceLines(pack, s).filter((l) => l.kind === 'director').map((l) => l.text);
  assert.deepEqual(lines, ['[sighs] Another corridor.', 'A door.', 'Second scene.']);
  s = gm(s, { t: 'prep.director.go', id, stop: true }).state;
  assert.equal(s.prep.docs.find((d) => d.id === id).evening.director, undefined);
  for (const role of ['player', 'stage']) assert.ok(!JSON.stringify(viewFor(s, pack, role, { playerId: null })).includes('Trap at the end'));
});

test('loot.pending.add: a box waits on the crawler', () => {
  let n = 0;
  const lootPack = { ...pack, tiersById: new Map([['bronze', { id: 'bronze', name: 'Bronze' }]]), lootTiers: [{ id: 'bronze', name: 'Bronze' }] };
  const ctx = { now: 1, pack: lootPack, genId: (p) => `${p}_${++n}` };
  const gm = (s, a) => reduce(s, { role: 'gm', ...a }, ctx);
  let s = createState(lootPack, 0);
  const r = gm(s, { t: 'player.add', name: 'Hana' });
  s = r.state;
  const tier = 'bronze';
  s = gm(s, { t: 'loot.pending.add', playerId: r.result.playerId, tier, from: 'Chytil draka za ocas' }).state;
  assert.deepEqual(s.players[0].pendingBoxes.map((b) => [b.tier, b.from]), [[tier, 'Chytil draka za ocas']]);
  assert.throws(() => gm(s, { t: 'loot.pending.add', playerId: r.result.playerId, tier: 'nope' }), /unknown loot tier/);
});
