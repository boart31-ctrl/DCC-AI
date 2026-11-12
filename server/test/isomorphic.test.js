import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as engine from '../engine.js';
import { checkIsomorphic } from '../check-isomorphic.js';
import { readPackFiles, loadPack } from '../pack.js';
import { tmpDir, writePack, seq } from './fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('engine.js import graph has no Node-only imports', () => {
  const { files, problems } = checkIsomorphic(path.join(here, '..', 'engine.js'));
  assert.deepEqual(problems, []);
  const names = files.map((f) => path.basename(f)).sort();
  assert.deepEqual(names, ['character.js', 'chat.js', 'combat-auto.js', 'combat.js', 'constants.js', 'engine.js', 'errors.js', 'formula.js', 'loot.js', 'pack-core.js', 'quips.js', 'random.js', 'ruleset.js', 'scenes.js', 'state.js']);
});

test('checker catches forbidden imports', () => {
  const dir = tmpDir();
  const fs = globalThis.process.getBuiltinModule('node:fs');
  fs.writeFileSync(path.join(dir, 'a.js'), "import './b.js';\nexport { x } from \"./c.js\";");
  fs.writeFileSync(path.join(dir, 'b.js'), "// import fs from 'node:fs';\nimport os from 'os';");
  fs.writeFileSync(path.join(dir, 'c.js'), "export const x = await import('ws');");
  const { problems } = checkIsomorphic(path.join(dir, 'a.js'));
  assert.deepEqual(problems.map((p) => p.spec).sort(), ['os', 'ws']);
});

test('engine exports the hosted-edition surface', () => {
  for (const name of [
    'createState', 'normalizeState', 'reduce', 'viewFor', 'viewForUser', 'genId', 'ActionError', 'VoiceQueue',
    'voiceFor', 'quipAudio', 'STANDARD_CATEGORIES', 'normalizePack', 'serializePack', 'deserializePack',
  ]) {
    assert.ok(name in engine, `missing export ${name}`);
  }
});

test('full game round trip through engine.js only (as a browser host would)', () => {
  const { raw } = readPackFiles(writePack(tmpDir()));
  const embedded = JSON.stringify(engine.serializePack(engine.normalizePack(raw).pack));
  const pack = engine.deserializePack(embedded);
  let state = engine.createState(pack);
  const run = (a, extra = {}) => {
    const r = engine.reduce(state, { role: 'gm', ...a }, { pack, ...extra });
    state = r.state;
    return r;
  };
  const id = run({ t: 'player.add', name: 'Carl', userId: 'user_123' }).result.playerId;
  run({ t: 'ach.award', playerId: id, achId: 'first_blood' });
  run({ t: 'loot.open', playerId: id, tier: 'gold' }, { rng: seq(0) });
  const v = engine.viewForUser(state, pack, 'user_123');
  assert.equal(v.me.id, id);
  assert.equal(v.me.inventory[0].itemId, 'crown');
  assert.equal(v.me.achievements[0].reward, 'Bronze Box');
  assert.equal(engine.viewForUser(state, pack, 'someone_else'), null);
  // state is JSON-safe (it goes to db as-is) and survives normalizeState
  const back = engine.normalizeState(JSON.parse(JSON.stringify(state)), pack);
  assert.deepEqual(back.players, state.players);
});
