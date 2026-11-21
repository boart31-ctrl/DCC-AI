import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { serializePack, deserializePack } from '../pack-core.js';
import { searchRules } from '../rules-search.js';
import { createState, reduce, reducePlayerAction, viewFor } from '../state.js';
import { tmpDir, writePack } from './fixtures.js';

const INDEX = [
  { b: 'Rules', p: 12, h: 'Degrees Of Success', t: 'Fail by 1–2: Near Miss. The GM announces it and friends may Intervene with 1d6.' },
  { b: 'Rules', p: 31, h: 'Interrupts', t: 'Evade: one Action covers the whole round; roll against every attack aimed at you.' },
  { b: 'Rules', p: 44, h: 'Debuffs', t: 'Stunned: you lose your next Action. Fatigued: Disadvantage on Endurance checks until a long rest.' },
  { b: 'Toolkit', p: 13, h: 'Encounters', t: 'Encounter size compares the mob count with the party: Weak, Moderate, Strong, Overwhelming.' },
];

test('rules search ranks the passage that has every word, folds case/plurals and the exact phrase', () => {
  assert.equal(searchRules(INDEX, 'near miss')[0].page, 12);
  assert.equal(searchRules(INDEX, 'EVADES round')[0].page, 31, 'plural and case do not matter');
  assert.equal(searchRules(INDEX, 'stunned')[0].heading, 'Debuffs');
  assert.equal(searchRules(INDEX, 'how big is an encounter')[0].book, 'Toolkit', 'stop words are ignored');
  assert.deepEqual(searchRules(INDEX, 'the of and'), []);
  assert.deepEqual(searchRules([], 'evade'), []);
});

test('rules.search is GM-only, changes nothing and the book text never reaches a view or the TV', () => {
  const { pack } = loadPack(writePack(tmpDir(), { 'rules_index.json': INDEX }));
  assert.equal(pack.rulesIndex.length, 4);
  assert.equal(deserializePack(serializePack(pack)).rulesIndex.length, 4, 'the hosted worker gets it too');
  let n = 0;
  const ctx = { pack, now: 1000, genId: (p) => `${p}_${++n}` };
  let state = createState(pack, 0);
  const add = reduce(state, { role: 'gm', t: 'player.add', name: 'Carl' }, ctx);
  state = add.state;
  const r = reduce(state, { role: 'gm', t: 'rules.search', q: 'near miss' }, ctx);
  assert.equal(r.result.hits[0].page, 12);
  assert.equal(r.result.total, 4);
  assert.equal(r.changed, false);
  assert.throws(() => reduce(state, { role: 'gm', t: 'rules.search', q: '  ' }, ctx), /q/);
  assert.throws(() => reducePlayerAction(state, { t: 'rules.search', q: 'evade' }, { ...ctx, playerId: add.result.playerId }), /unknown|not allowed|forbidden/i);
  for (const role of ['gm', 'stage', 'player']) {
    const v = JSON.stringify(viewFor(state, pack, role, { ...ctx, playerId: add.result.playerId }));
    assert.doesNotMatch(v, /Intervene with 1d6|one Action covers the whole round/, `${role} view carries no book text`);
  }
});
