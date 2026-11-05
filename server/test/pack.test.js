import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPack, fallbackPack, PackError, voiceFor, quipAudio, DEFAULT_VOICE } from '../pack.js';
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
