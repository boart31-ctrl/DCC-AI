import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer } from '../index.js';
import { createHost } from '../host.js';
import { createState, viewFor } from '../state.js';
import { loadPack } from '../pack.js';
import { readContentArchive, ARCHIVE_LIMIT } from '../content-archive.js';
import { contentSchema, validateManifest } from '../content-schema.js';
import { libraryOf } from '../character.js';
import { tmpDir, writePack } from './fixtures.js';
import { sampleManifest, sampleZip, zipEntries } from './content-fixture.js';

const KEY = 'local-content-zip-test-key';
const BASE_HEADERS = { 'X-GM-Key': KEY, 'Content-Type': 'application/zip' };

test('published JSON Schema comes from the runtime contract', () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../../docs/the-system-content-v1.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema, contentSchema);
  assert.equal(validateManifest(sampleManifest()).size, 4);
});

test('ZIP safety: paths, media signatures, checksums, duplicate keys and decompression limits', async () => {
  const read = (b) => readContentArchive(b, validateManifest);
  const manifest = JSON.stringify(sampleManifest());
  await assert.rejects(read(sampleZip(undefined, [['../external.png', 'unused']])), /ZIP entries/);
  await assert.rejects(read(sampleZip(undefined, [['images/bad.svg', '<svg/>']])), /ZIP entries/);
  await assert.rejects(read(sampleZip(undefined, [['images/extra.png', 'unused']])), /not referenced/);
  await assert.rejects(read(zipEntries([['manifest.json', manifest], ['images/guard.png', '<html>'] ])), /expected a static/);
  await assert.rejects(read(zipEntries([['manifest.json', manifest], ['manifest.json', manifest]])), /duplicate ZIP path/);
  await assert.rejects(read(zipEntries([['manifest.json', '{"format":"one","format":"two","entities":[]}']])), /duplicate object key/);
  await assert.rejects(read(zipEntries([['manifest.json', 'x'.repeat(260_000), true]])), /size or compression ratio/);
  const wrongLength = zipEntries([['manifest.json', 'x'.repeat(513), true]]);
  const central = wrongLength.readUInt32LE(wrongLength.length - 6);
  wrongLength.writeUInt32LE(64, 22);
  wrongLength.writeUInt32LE(64, central + 24);
  await assert.rejects(read(wrongLength), /invalid compressed data or uncompressed length/);
  const broken = zipEntries([['manifest.json', manifest]]);
  broken[43] ^= 1;
  await assert.rejects(read(broken), /checksum mismatch/);
});

test('GM ZIP endpoint imports atomically, plays attacks and restores both records and art', async (t) => {
  const dataDir = tmpDir();
  const second = tmpDir();
  const packDir = writePack(tmpDir(), {
    'ruleset.json': { id: 'table', combat: { flow: 'reaction' } },
    'buffs.json': [{ id: 'test_mark', name: 'Marked', effects: [] }],
  });
  const start = (dir) => startServer({
    packDir, dataDir: dir, port: 0, host: '127.0.0.1', publicHost: '127.0.0.1',
    env: { GM_KEY: KEY }, rng: () => 0.75, log: { log() {}, warn() {}, error() {} },
  });
  let server = await start(dataDir);
  t.after(async () => { await server.close(); for (const f of [dataDir, second, packDir]) fs.rmSync(f, { recursive: true, force: true }); });
  const base = () => `http://127.0.0.1:${server.port}`;
  const post = (body, headers = BASE_HEADERS, campaign = server.state.campaign.id) => fetch(base() + '/api/content/import', {
    method: 'POST', headers: { 'X-System-Campaign-Id': campaign, ...headers }, body,
  });
  assert.equal((await post(sampleZip(), { 'Content-Type': 'application/zip' })).status, 401);
  assert.equal((await post(sampleZip(), { ...BASE_HEADERS, Origin: 'https://another.test' })).status, 403);
  assert.equal((await post(sampleZip(), BASE_HEADERS, 'different')).status, 409);
  assert.equal((await post(new Uint8Array(ARCHIVE_LIMIT + 1))).status, 413);
  const untouched = server.state;
  const unknown = sampleManifest();
  unknown.entities[1].attacks[0].trigger = 'onEveryHit';
  let r = await post(sampleZip(unknown));
  assert.equal(r.status, 400);
  assert.match((await r.json()).msg, /entities\[1\].*unknown field.*trigger/);
  const wrong = sampleManifest();
  wrong.entities[1].hpSlots = '15';
  r = await post(sampleZip(wrong));
  assert.equal(r.status, 400);
  assert.match((await r.json()).msg, /hpSlots.*integer/);
  const ref = sampleManifest();
  ref.entities[1].attacks[0].buffs = ['unknown_buff'];
  r = await post(sampleZip(ref));
  assert.equal(r.status, 400);
  assert.match((await r.json()).msg, /unknown buff reference/);
  const colliding = sampleManifest();
  colliding.entities[3].id = 'duck';
  r = await post(sampleZip(colliding));
  assert.equal(r.status, 409);
  assert.strictEqual(server.state, untouched);

  const working = sampleManifest();
  working.entities[1].attacks[0].buffs = ['test_mark'];
  working.entities[3].use = { target: 'self', consume: true, heal: { track: 'hp', amount: 2 } };
  r = await post(sampleZip(working));
  assert.equal(r.status, 201, await r.clone().text());
  const result = await r.json();
  assert.deepEqual(result.entries.map((entry) => entry.type), ['monster', 'boss', 'npc', 'item']);
  assert.deepEqual(result.missingImages, ['images/keeper_absent.png']);
  const libraries = () => libraryOf(server.state, server.pack);
  const mob = libraries().get('monster', 'zip_lantern_guard');
  const npc = libraries().get('npc', 'zip_scavenger');
  assert.equal(mob.variants.length, 2);
  assert.equal(npc.image, '/pack/content/placeholder/npc.svg');
  assert.equal(libraries().get('boss', 'zip_clockwork_keeper').image, '/pack/content/placeholder/boss.svg');
  const images = [mob.image, ...mob.variants];
  for (const image of images) {
    const media = await fetch(base() + image);
    assert.equal(media.status, 200);
    assert.equal(media.headers.get('content-type'), 'image/png');
    assert.equal(media.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(Buffer.from(await media.arrayBuffer()).includes(Buffer.from('tEXt')), false);
  }
  const fallback = await fetch(base() + npc.image);
  assert.equal(fallback.headers.get('content-type'), 'image/svg+xml');
  assert.notEqual(await fallback.text(), await (await fetch(base() + '/pack/content/placeholder/item.svg')).text());
  assert.equal(viewFor(server.state, server.pack, 'stage').contentMedia, undefined);
  const inserted = server.state;
  assert.equal((await post(sampleZip())).status, 409);
  assert.strictEqual(server.state, inserted);

  const act = (a) => server.host.apply({ role: 'gm', ...a });
  const { playerId } = act({ t: 'player.add', name: 'Runner' }).result;
  act({ t: 'combat.addMob', sourceId: mob.id, count: 3, hidden: false });
  const bossUid = act({ t: 'combat.addMob', kind: 'boss', sourceId: 'zip_clockwork_keeper', hidden: false }).result.uids[0];
  act({ t: 'combat.start' });
  assert.deepEqual(new Set(server.state.combat.combatants.filter((row) => row.sourceId === mob.id).map((row) => row.image)), new Set(images));
  const crawler = server.state.combat.combatants.find((row) => row.type === 'crawler');
  act({ t: 'rx.declare', mobUid: bossUid, attackIndex: 0, targetUid: crawler.uid });
  act({ t: 'rx.step', to: 'react' });
  act({ t: 'rx.step', to: 'resolve' });
  const { token } = act({ t: 'rx.resolveNext', op: 'preview', all: true }).result;
  assert.ok(token);
  assert.deepEqual(server.state.players[0].sheet.buffs, [], 'preview has not applied the imported attack');
  assert.equal(viewFor(server.state, server.pack, 'player', { playerId }).combat.rx.batch, undefined);
  assert.equal(viewFor(server.state, server.pack, 'stage').combat.rx.batch, undefined);
  await server.close();
  server = await start(dataDir);
  assert.equal(viewFor(server.state, server.pack, 'gm').combat.rx.batch.token, token);
  const commit = { t: 'rx.resolveNext', op: 'apply', all: true, token, confirm: true };
  act(commit);
  const committed = server.state;
  assert.throws(() => act(commit), /no unresolved attacks|preview the damage again/);
  assert.strictEqual(server.state, committed);
  const [step] = server.state.combat.rx.decls;
  assert.equal(step.attack.name, 'Pendulum');
  assert.equal(step.result, 'hit');
  assert.equal(step.damage, 2);
  assert.deepEqual(server.state.players[0].sheet.buffs.map((b) => b.name), ['Marked']);
  act({ t: 'item.give', playerId, itemId: 'zip_salve' });
  const [salve] = server.state.players.find((p) => p.id === playerId).inventory;
  const use = act({ t: 'item.use', playerId, uid: salve.uid }).result;
  assert.equal(use.consumed, true);
  assert.equal(use.healed.to - use.healed.from, 2);
  act({ t: 'scene.set', kind: 'boss', data: { bossId: 'zip_clockwork_keeper', revealed: true } });
  act({ t: 'boss.damage', amount: 8 });
  const bossScene = () => viewFor(server.state, server.pack, 'gm').scene.data;
  assert.equal(bossScene().phase, 0);
  assert.equal(bossScene().suggestPhase, 1);
  act({ t: 'boss.phase' });
  assert.equal(bossScene().phase, 1);

  const data = await (await fetch(base() + '/api/export?kind=campaign', { headers: { 'X-GM-Key': KEY } })).text();
  const campaignId = server.state.campaign.id;
  await server.close();
  server = await start(dataDir);
  assert.equal(server.state.campaign.id, campaignId);
  assert.equal(libraries().get('boss', 'zip_clockwork_keeper').attacks[0].name, 'Pendulum');
  assert.equal((await fetch(base() + images[0])).status, 200);

  await server.close();
  server = await start(second);
  assert.equal(libraries().get('monster', mob.id), null);
  assert.equal((await fetch(base() + images[0])).status, 404);
  r = await fetch(base() + '/api/import', { method: 'POST', headers: { 'X-GM-Key': KEY, 'Content-Type': 'application/json' }, body: data });
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(libraries().get('monster', mob.id), mob);
  assert.equal(libraries().get('npc', npc.id).image, npc.image);
  assert.equal((await fetch(base() + images[0])).status, 200);
});

test('content import rolls back when the write fails and rejects overlapping imports', async () => {
  const folder = tmpDir();
  const pack = loadPack(writePack(folder)).pack;
  const state = createState(pack);
  const host = createHost({
    pack, state, send() {}, close() {}, log: { error() {} },
    persist(_next, entry) { if (entry.action?.t === 'lib.importContent') throw Error('write failed'); },
  });
  const before = host.state;
  let finish;
  const wait = new Promise((resolve) => { finish = resolve; });
  const body = (async function* () { await wait; yield sampleZip(); })();
  const pending = host.importContent(body, state.campaign.id);
  try {
    await assert.rejects(host.importContent([sampleZip()], state.campaign.id), /already running/);
    finish();
    await assert.rejects(pending, /nothing happened/);
    assert.strictEqual(host.state, before);
  } finally {
    finish();
    host.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
