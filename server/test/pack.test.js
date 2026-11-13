import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPack, fallbackPack, PackError, voiceFor, quipAudio, recordedAudio, voiceKey, DEFAULT_VOICE, serializePack, deserializePack } from '../pack.js';
import { voiceLines } from '../tts.js';
import { tmpDir, writePack } from './fixtures.js';

test('loads a valid pack with assets, stats, resources, voices', () => {
  const { pack, warnings } = loadPack(writePack(tmpDir()));
  assert.equal(pack.id, 'test');
  assert.equal(pack.itemsById.get('duck').image, '/pack/images/duck.webp');
  assert.equal(pack.itemsById.get('sword').image, null);
  assert.equal(pack.quipsByCategory.get('nat1').length, 3);
  assert.deepEqual(pack.stats.map((s) => s.id), ['str']);
  assert.equal(pack.resources[0].default, 10);
  assert.equal(pack.voices.length, 2);
  assert.deepEqual(warnings, []);
});

test('per-voice audio is preferred over generic audio', () => {
  const { pack } = loadPack(writePack(tmpDir()));
  const q = pack.quipsById.get('nat1_01');
  assert.equal(quipAudio(q, 'gremlin'), '/pack/audio/gremlin/nat1_01.mp3');
  assert.equal(quipAudio(q, 'host'), '/pack/audio/nat1_01.mp3');
  assert.equal(quipAudio(pack.quipsById.get('nat1_02'), 'host'), null);
});

test('recorded audio is found by quip id, then by matching text (boss intros, announcements)', () => {
  const { pack } = loadPack(writePack(tmpDir()));
  assert.equal(recordedAudio(pack, { quipId: 'nat1_01', text: 'whatever' }, 'host'), '/pack/audio/nat1_01.mp3');
  // no quip id (boss intro / typed announcement): text match ignores case, spacing and end punctuation
  assert.equal(recordedAudio(pack, { text: '  one!' }, 'gremlin'), '/pack/audio/gremlin/nat1_01.mp3');
  assert.equal(recordedAudio(pack, { quipId: 'nat1_02', text: 'Another one.' }, 'host'), null);
  assert.equal(recordedAudio(pack, { text: 'Something new' }, 'host'), null);
  assert.equal(voiceKey('It\u2019s  Fine…'), "it's fine");
  // survives the cloud build (serialize → deserialize)
  const again = deserializePack(serializePack(pack));
  assert.equal(recordedAudio(again, { text: 'One' }, 'host'), '/pack/audio/nat1_01.mp3');
  // pre-render skips lines that already have a recording, including boss lines matched by text
  pack.library.boss = [{ id: 'b1', intro: 'One.', defeatLine: 'Gone.' }];
  const refs = voiceLines(pack, {}, undefined, { voiceId: 'host' }).map((l) => l.ref);
  assert.ok(!refs.includes('nat1_01') && !refs.includes('b1:intro') && refs.includes('b1:defeat'));
});

test('a quip with "also" is drawn from its extra categories too, and survives the cloud build', () => {
  const dir = writePack(tmpDir());
  const qf = path.join(dir, 'quips.json');
  const qs = JSON.parse(fs.readFileSync(qf, 'utf8'));
  qs[0].also = ['combat_victory', 'BAD!', qs[0].category];
  fs.writeFileSync(qf, JSON.stringify(qs));
  const { pack, warnings } = loadPack(dir);
  assert.deepEqual(pack.quipsById.get(qs[0].id).also, ['combat_victory']);
  assert.ok(warnings.some((w) => /also/.test(w)));
  assert.ok(pack.quipsByCategory.get('combat_victory').some((q) => q.id === qs[0].id));
  const again = deserializePack(serializePack(pack));
  assert.ok(again.quipsByCategory.get('combat_victory').some((q) => q.id === qs[0].id));
});

test('voiceFor falls back to first voice, then built-in host', () => {
  const { pack } = loadPack(writePack(tmpDir()));
  assert.equal(voiceFor(pack, 'gremlin').id, 'gremlin');
  assert.equal(voiceFor(pack, 'nope').id, 'host');
  assert.deepEqual(voiceFor(fallbackPack(), 'x'), DEFAULT_VOICE);
});

test('tolerates missing optional files and missing assets', () => {
  const dir = writePack(tmpDir(), { 'achievements.json': null, 'chat.json': null });
  fs.rmSync(path.join(dir, 'images'), { recursive: true });
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json')));
  delete raw.stats;
  delete raw.resources;
  delete raw.voices;
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(raw));
  const { pack, warnings } = loadPack(dir);
  assert.deepEqual(pack.achievements, []);
  assert.deepEqual(pack.stats, []);
  assert.deepEqual(pack.voices, []);
  assert.equal(pack.itemsById.get('duck').image, null);
  assert.ok(warnings.some((w) => w.includes('duck.webp')));
});

test('clear errors for broken packs', () => {
  assert.throws(() => loadPack(path.join(tmpDir(), 'missing')), /pack folder not found/);
  const dir = writePack(tmpDir());
  fs.writeFileSync(path.join(dir, 'items.json'), '{nope');
  assert.throws(() => loadPack(dir), (e) => e instanceof PackError && /items\.json: invalid JSON/.test(e.message));
  const dir2 = writePack(tmpDir(), { 'quips.json': [{ id: 'a', category: 'nat1' }] });
  assert.throws(() => loadPack(dir2), /quips\.json \[0\]\.text: required string/);
});

test('rejects unsafe asset paths', () => {
  const dir = writePack(tmpDir(), {
    'items.json': [{ id: 'x', name: 'X', image: '../../etc/passwd' }],
  });
  const { pack, warnings } = loadPack(dir);
  assert.equal(pack.itemsById.get('x').image, null);
  assert.ok(warnings.some((w) => w.includes('unsafe')));
});

test('passes through reward, group, flavor, notifyPrefix without warnings', () => {
  const { pack, warnings } = loadPack(writePack(tmpDir()));
  assert.equal(pack.notifyPrefix, 'New achievement!');
  const a = pack.achievementsById.get('first_blood');
  assert.deepEqual([a.reward, a.group], ['Bronze Box', 'Combat']);
  assert.deepEqual([pack.achievementsById.get('plain').reward, pack.achievementsById.get('plain').group], ['', '']);
  assert.equal(pack.itemsById.get('sword').flavor, 'Forged by someone who really hated bread.');
  assert.equal(pack.itemsById.get('duck').flavor, '');
  assert.deepEqual(warnings, []);
  assert.equal(fallbackPack().notifyPrefix, '');
});

test('normalizePack works on raw objects with an assetExists callback', async () => {
  const { normalizePack } = await import('../pack-core.js');
  const { readPackFiles } = await import('../pack.js');
  const { raw } = readPackFiles(writePack(tmpDir()));
  const asked = [];
  const { pack, warnings } = normalizePack(raw, {
    assetExists: (sub, rel) => {
      asked.push(`${sub}/${rel}`);
      return rel === 'duck.webp';
    },
    baseUrl: './pack/',
  });
  assert.ok(asked.includes('images/duck.webp'));
  assert.equal(pack.itemsById.get('duck').image, './pack/images/duck.webp');
  assert.equal(pack.quipsById.get('nat1_01').audio, null);
  assert.ok(warnings.some((w) => w.includes('audio/nat1_01.mp3')));
  // default: assume every asset exists
  assert.equal(normalizePack(raw).pack.quipsById.get('nat1_01').audio, '/pack/audio/nat1_01.mp3');
  assert.throws(() => normalizePack({}), /pack\.json is missing/);
  assert.throws(() => normalizePack({ ...raw, items: [{ id: 'x' }] }), /items\.json \[0\]\.name/);
});

test('serializePack/deserializePack round trip is JSON-safe and complete', async () => {
  const { serializePack, deserializePack } = await import('../pack-core.js');
  const { pack } = loadPack(writePack(tmpDir()));
  const json = JSON.stringify(serializePack(pack));
  assert.ok(!json.includes(pack.dir), 'host path not embedded');
  const back = deserializePack(json);
  assert.equal(back.dir, null);
  for (const k of ['achievementsById', 'itemsById', 'quipsById', 'quipsByCategory', 'tiersById', 'statsById', 'resourcesById', 'voicesById']) {
    assert.ok(back[k] instanceof Map, k);
    assert.deepEqual([...back[k].keys()], [...pack[k].keys()], k);
  }
  assert.deepEqual(back.loot, pack.loot);
  assert.equal(quipAudio(back.quipsById.get('nat1_01'), 'gremlin'), '/pack/audio/gremlin/nat1_01.mp3');
  assert.deepEqual(serializePack(back), serializePack(pack));
  assert.throws(() => deserializePack({ id: 'x' }), /format/);
  const fb = deserializePack(serializePack(fallbackPack()));
  assert.equal(fb.id, 'fallback');
});

test('ui.json: assets, animations, auto stills, shorthand, bad entries skipped', async () => {
  const { normalizePack, serializePack, deserializePack } = await import('../pack-core.js');
  const files = new Set(['ui/system_smug.webp', 'anim/system_talk.webp', 'anim/system_talk_0.webp', 'anim/system_talk_strip.webp',
    'ui/loot_gold_closed.webp', 'ui/cond_bleeding.webp', 'bg_arena_f1.webp', 'bg_studio.webp', 'ui/logo.webp', 'ui/fin_victory.webp']);
  const raw = {
    pack: { id: 'x', name: 'X', lootTiers: [{ id: 'gold', name: 'Gold' }] },
    ui: {
      logo: 'ui/logo.webp',
      mascot: {
        smug: 'ui/system_smug.webp',
        talking: { src: 'anim/system_talk.webp', strip: 'anim/system_talk_strip.webp', frames: 8, fps: 10, w: 384, h: 384, loop: true },
        angry: 'ui/missing.webp',
      },
      lootBoxes: { gold: { closed: 'ui/loot_gold_closed.webp' } },
      conditions: { bleeding: 'ui/cond_bleeding.webp', 'bad key!': 'x.webp' },
      floors: { 1: { combat: 'bg_arena_f1.webp' }, default: 'bg_studio.webp' },
      finale: { victory: 'ui/fin_victory.webp', defeat: '../escape.webp' },
      bogus: {},
    },
  };
  const { pack, warnings } = normalizePack(raw, { assetExists: (sub, rel) => sub === 'images' && files.has(rel) });
  const ui = pack.ui;
  assert.deepEqual(ui.logo, { src: '/pack/images/ui/logo.webp', still: null });
  assert.equal(ui.mascot.smug.src, '/pack/images/ui/system_smug.webp');
  assert.equal(ui.mascot.talking.still, '/pack/images/anim/system_talk_0.webp', 'auto still from <name>_0.webp');
  assert.deepEqual(ui.mascot.talking.strip, { src: '/pack/images/anim/system_talk_strip.webp', frames: 8, w: 384, h: 384, fps: 10, loop: true });
  assert.equal(ui.mascot.angry, undefined, 'missing file → no entry (CSS fallback)');
  assert.equal(ui.lootBoxes.gold.closed.src, '/pack/images/ui/loot_gold_closed.webp');
  assert.equal(ui.floors['1'].combat.src, '/pack/images/bg_arena_f1.webp');
  assert.equal(ui.floors.default.default.src, '/pack/images/bg_studio.webp', 'string shorthand → { default }');
  assert.equal(ui.finale.defeat, undefined);
  assert.equal(ui.conditions['bad key!'], undefined);
  assert.ok(warnings.some((w) => w.includes('unknown section "bogus"')));
  assert.ok(warnings.some((w) => w.includes('ui/missing.webp')));
  assert.ok(warnings.some((w) => w.includes('unsafe')));
  const back = deserializePack(JSON.parse(JSON.stringify(serializePack(pack))));
  assert.deepEqual(back.ui, ui);
  assert.equal(normalizePack({ pack: raw.pack }).pack.ui, null, 'no ui.json → null');
});

test('items fall back to icon library art (icon, then category base, then fallback)', async () => {
  const { normalizePack } = await import('../pack-core.js');
  const files = new Set(['own.webp', 'icon_boots_winged.webp', 'icon_food.webp', 'icon_trinket.webp']);
  const raw = {
    pack: { id: 'x', name: 'X' },
    icons: { fallback: 'icon_trinket', categories: [{ id: 'boots', base: 'icon_boots' }, { id: 'food', base: 'icon_food' }] },
    items: [
      { id: 'a', name: 'A', image: 'own.webp', icon: 'icon_boots_winged' },
      { id: 'b', name: 'B', image: 'b.webp', icon: 'icon_boots_winged', iconCategory: 'boots' },
      { id: 'c', name: 'C', image: 'c.webp', icon: 'icon_food_can', iconCategory: 'food' },
      { id: 'd', name: 'D', icon: 'icon_nope', iconCategory: 'boots' },
      { id: 'e', name: 'E' },
    ],
  };
  const { pack, warnings } = normalizePack(raw, { assetExists: (sub, rel) => files.has(rel) });
  const img = (id) => pack.itemsById.get(id).image;
  assert.equal(img('a'), '/pack/images/own.webp');
  assert.equal(img('b'), '/pack/images/icon_boots_winged.webp');
  assert.equal(img('c'), '/pack/images/icon_food.webp');
  assert.equal(img('d'), '/pack/images/icon_trinket.webp');
  assert.equal(img('e'), '/pack/images/icon_trinket.webp');
  assert.deepEqual(warnings.filter((w) => w.startsWith('item ')), [], 'a fallback that exists is not a warning');
  const none = normalizePack({ ...raw, icons: undefined }, { assetExists: () => false });
  assert.equal(none.pack.itemsById.get('e').image, null);
  assert.ok(none.warnings.some((w) => w.includes('item b: images/b.webp')));
});

test('boss imageSquare / imageKo: library keeps them, combat uses the square crop', async () => {
  const { normalizePack } = await import('../pack-core.js');
  const raw = { pack: { id: 'x', name: 'X' }, bosses: [{ id: 'grim', name: 'Grim', image: 'grim.webp', imageSquare: 'grim_sq.webp', imageKo: 'grim_ko.webp' }, { id: 'plain', name: 'Plain', image: 'p.webp' }] };
  const { pack } = normalizePack(raw);
  const grim = pack.library.boss.find((b) => b.id === 'grim');
  assert.equal(grim.imageSquare, '/pack/images/grim_sq.webp');
  assert.equal(grim.imageKo, '/pack/images/grim_ko.webp');
  const plain = pack.library.boss.find((b) => b.id === 'plain');
  assert.ok(!('imageSquare' in plain) && !('imageKo' in plain), 'shape unchanged without the new fields');
});
