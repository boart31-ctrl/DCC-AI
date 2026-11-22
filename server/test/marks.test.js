import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { createState, reduce, viewFor } from '../state.js';
import { tmpDir, writePack } from './fixtures.js';

test('HUD marks: killing a rival crawler = skull, a leaderboard crawler = golden skull, a boss = star; public on every HUD', () => {
  const { pack } = loadPack(writePack(tmpDir(), {
    'monsters.json': [
      { id: 'rival', name: 'Rival Crawler', hpSlots: 1, evade: 1, tags: ['crawler'], attacks: [] },
      { id: 'champ', name: 'Top Ten Crawler', hpSlots: 1, evade: 1, tags: ['crawler', 'leaderboard'], attacks: [] },
      { id: 'rat', name: 'Rat', hpSlots: 1, evade: 1, attacks: [] },
    ],
    'bosses.json': [{ id: 'chief', name: 'Chief', rank: 'Neighborhood Boss', hpSlots: 1, evade: 1, attacks: [] }],
  }));
  let n = 0;
  const ctx = { pack, now: 1000, rng: () => 0.5, genId: (p) => `${p}_${++n}` };
  let state = createState(pack, 0);
  const add = reduce(state, { role: 'gm', t: 'player.add', name: 'Carl' }, ctx);
  state = add.state;
  const pid = add.result.playerId;
  const step = (a) => { const r = reduce(state, { role: 'gm', ...a }, ctx); state = r.state; return r; };
  for (const sourceId of ['rival', 'champ', 'rat']) step({ t: 'combat.addMob', sourceId, kind: 'monster' });
  step({ t: 'combat.addMob', sourceId: 'chief', kind: 'boss' });
  step({ t: 'combat.start' });
  for (const m of state.combat.combatants.filter((x) => x.type === 'mob')) step({ t: 'combat.damage', uid: m.uid, amount: 99, by: pid });
  const end = step({ t: 'combat.end', outcome: 'victory' });
  const marks = state.players[0].marks;
  assert.equal(marks.skulls, 1);
  assert.equal(marks.goldSkulls, 1);
  assert.equal(marks.stars.length, 1);
  assert.equal(marks.stars[0].rank, 'Neighborhood Boss');
  assert.ok(end.events.some(({ event: e }) => e.kind === 'marks' && e.mark === 'goldSkull'));
  assert.deepEqual(viewFor(state, pack, 'stage', { now: 0 }).players[0].marks, { skulls: 1, goldSkulls: 1, stars: 1 });
  step({ t: 'marks.set', playerId: pid, skulls: 0 });
  assert.equal(state.players[0].marks.skulls, 0, 'the GM can correct it');
});
