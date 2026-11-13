import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPack } from '../pack.js';
import { createState, reduce } from '../state.js';
import { tmpDir, writePack, seq } from './fixtures.js';

const MONSTERS = [
  { id: 'gob', name: 'Goblin', hpSlots: 3, image: 'gob.webp', variants: ['gob_a.webp', 'gob_b.webp', 'gob_missing.webp', 'gob_a.webp'] },
  { id: 'rat', name: 'Rat', hpSlots: 2, image: 'rat.webp' },
];
const dir = writePack(tmpDir(), { 'monsters.json': MONSTERS });
for (const f of ['gob.webp', 'gob_a.webp', 'gob_b.webp', 'rat.webp']) fs.writeFileSync(path.join(dir, 'images', f), 'webp');
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
