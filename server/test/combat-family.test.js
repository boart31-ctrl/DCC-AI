import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPack } from '../pack.js';
import { createState, reduce, viewFor } from '../state.js';
import { tmpDir, writePack, seq } from './fixtures.js';

const MONSTERS = [
  { id: 'gob', name: 'Goblin', hpSlots: 3, image: 'gob.webp', variants: ['gob_a.webp', 'gob_b.webp', 'gob_missing.webp', 'gob_a.webp'] },
  { id: 'rat', name: 'Rat', hpSlots: 2, image: 'rat.webp' },
];
const BOSS = { id: 'chief', name: 'Chief', hpSlots: 10, image: 'chief.webp', imageKo: 'chief_ko.webp',
  phases: [{ name: 'Ready', image: 'chief_p1.webp' }, { name: 'Rally', image: 'chief_p2.webp' }] };
const dir = writePack(tmpDir(), { 'monsters.json': MONSTERS, 'bosses.json': [BOSS],
  'ui.json': { avatarFamilies: { fox: { amber: { src: 'fox.webp', name: 'Amber fox' } } } } });
for (const f of ['gob.webp', 'gob_a.webp', 'gob_b.webp', 'rat.webp', 'chief.webp', 'chief_ko.webp', 'chief_p1.webp', 'chief_p2.webp', 'fox.webp']) {
  fs.writeFileSync(path.join(dir, 'images', f), 'webp');
}
const { pack, warnings } = loadPack(dir);
let n = 0;
const ctx = () => ({ now: 1_000_000, rng: seq(0.1, 0.9, 0.5), genId: (p) => `${p}_${++n}`, pack });
const gm = (s, a) => reduce(s, { role: 'gm', ...a }, ctx()).state;
const imgs = (s, id) => s.combat.combatants.filter((x) => x.sourceId === id).map((x) => x.image.split('/').pop());

test('monster variants: existing files only, deduped, missing ones skipped without a warning', () => {
  const g = pack.library.monster.find((x) => x.id === 'gob');
  assert.deepEqual(g.variants.map((v) => v.split('/').pop()), ['gob_a.webp', 'gob_b.webp']);
  assert.ok(!warnings.some((w) => /gob_missing/.test(w)));
  assert.deepEqual(pack.library.monster.find((x) => x.id === 'rat').variants, []);
});

test('several copies of one monster each get a different picture, base art first', () => {
  let s = createState(pack, 0);
  s = gm(s, { t: 'combat.addMob', sourceId: 'gob', count: 3 });
  const a = imgs(s, 'gob');
  assert.equal(a[0], 'gob.webp');
  assert.equal(new Set(a).size, 3);
  s = gm(s, { t: 'combat.addMob', sourceId: 'gob', count: 2 }); // pool exhausted → reuse least used
  const b = imgs(s, 'gob');
  assert.equal(b.length, 5);
  for (const f of ['gob.webp', 'gob_a.webp', 'gob_b.webp']) assert.ok(b.filter((x) => x === f).length <= 2);
  s = gm(s, { t: 'combat.addMob', sourceId: 'rat', count: 2 });
  assert.deepEqual(imgs(s, 'rat'), ['rat.webp', 'rat.webp']);
});

test('avatar families reach player views and a character can save a pack portrait', () => {
  let s = gm(createState(pack, 0), { t: 'player.add', name: 'Scout' });
  const playerId = s.players[0].id;
  const art = viewFor(s, pack, 'player', { playerId }).pack.ui.avatarFamilies.fox.amber;
  assert.equal(art.name, 'Amber fox');
  assert.equal(art.src, '/pack/images/fox.webp');
  s = gm(s, { t: 'sheet.set', playerId, path: 'portrait', value: art.src });
  assert.equal(viewFor(s, pack, 'stage').players[0].portrait, art.src);
});

test('idle fight preview includes every crawler without adding combatants to the real fight', () => {
  let s = gm(createState(pack, 0), { t: 'player.add', name: 'Scout' });
  s = gm(s, { t: 'player.add', name: 'Guide' });
  const g = viewFor(s, pack, 'gm').combat;
  assert.deepEqual(g.previewCrawlers.map((c) => c.name), ['Scout', 'Guide']);
  assert.deepEqual(g.combatants, []);
  assert.equal(viewFor(s, pack, 'stage').combat.previewCrawlers, undefined);
  s = gm(s, { t: 'combat.start' });
  assert.equal(viewFor(s, pack, 'gm').combat.previewCrawlers, undefined);
  assert.equal(viewFor(s, pack, 'stage').combat.combatants.length, 2);
});

test('the boss combatant icon follows phase, scene changes and defeat', () => {
  let s = gm(createState(pack, 0), { t: 'combat.addMob', kind: 'boss', sourceId: 'chief', hidden: false });
  s = gm(s, { t: 'combat.start' });
  const icon = (role) => viewFor(s, pack, role).combat.combatants[0].image;
  assert.equal(icon('gm'), '/pack/images/chief_p1.webp');
  s = gm(s, { t: 'combat.update', uid: s.combat.combatants[0].uid, image: '/pack/images/rat.webp' });
  assert.equal(icon('gm'), '/pack/images/rat.webp');
  s = gm(s, { t: 'scene.set', kind: 'boss', data: { bossId: 'chief', revealed: true } });
  s = gm(s, { t: 'boss.phase' });
  assert.equal(icon('stage'), '/pack/images/chief_p2.webp');
  s = gm(s, { t: 'scene.set', kind: 'combat', data: {} });
  assert.equal(icon('gm'), '/pack/images/chief_p2.webp');
  s = gm(s, { t: 'scene.set', kind: 'boss', data: { bossId: 'chief' } });
  s = gm(s, { t: 'boss.defeat' });
  assert.equal(icon('stage'), '/pack/images/chief_ko.webp');
});
