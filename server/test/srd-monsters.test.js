import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { packForRuleset } from '../systems.js';
import { SRD5_MONSTERS } from '../srd5-monsters.js';
import { originsFor, SRD51_ATTRIBUTION } from '../origins.js';
import { createState, viewFor } from '../state.js';
import { tmpDir, writePack } from './fixtures.js';

const converted = { id: 'srd_goblin', name: 'Goblin', origin: 'srd51_dcc', hpSlots: 2, slotValue: 1, evade: 2, level: 2, attacks: [{ name: 'Scimitar', toHit: 2, damage: '1d6+1' }] };
const crawlerPack = () => loadPack(writePack(tmpDir(), {
  'pack.json': { id: 't', name: 'T', origins: { dcc_official: { label: 'DCC official', note: 'Private.' } } },
  'monsters.json': [converted, { id: 'rat', name: 'Rat', origin: 'dcc_official', hpSlots: 1, evade: 1, attacks: [] }],
})).pack;

test('the 5e SRD list is complete, sourced and carries no art', () => {
  assert.ok(SRD5_MONSTERS.length >= 300);
  assert.ok(SRD5_MONSTERS.every((m) => m.origin === 'srd51' && m.id.startsWith('srd_') && !m.image));
  const goblin = SRD5_MONSTERS.find((m) => m.id === 'srd_goblin');
  assert.equal(goblin.evade, 15, 'AC as printed');
  assert.equal(goblin.hpSlots, 7);
  assert.match(SRD51_ATTRIBUTION, /System Reference Document 5\.1.*Creative Commons Attribution 4\.0/s);
});

test('5e campaigns get the SRD monsters (not the crawler conversions); crawler campaigns keep their own', () => {
  const pack = crawlerPack();
  const own = pack.library.monster.find((m) => m.id === 'srd_goblin');
  assert.equal(own.origin, 'srd51_dcc');
  assert.equal(pack.library.monster.length, 2, 'a crawler campaign has no 5e SRD list');
  for (const id of ['dnd5e', 'dnd2024']) {
    const dnd = packForRuleset(pack, id);
    const goblins = dnd.library.monster.filter((m) => m.id === 'srd_goblin');
    assert.equal(goblins.length, 1);
    assert.equal(goblins[0].origin, 'srd51');
    assert.equal(goblins[0].evade, 15);
    assert.ok(dnd.library.monster.some((m) => m.id === 'rat'), 'the pack’s own monsters stay (converted)');
  }
  assert.equal(packForRuleset(pack, 'pf2e').library.monster.filter((m) => m.origin === 'srd51').length, 0);
});

test('the GM view carries the origin labels (built-in + pack); TV and phones do not', () => {
  const pack = crawlerPack();
  const o = originsFor(pack);
  assert.equal(o.dcc_official.label, 'DCC official');
  assert.equal(o.srd51.label, '5e SRD');
  const state = createState(pack, 0);
  assert.equal(viewFor(state, pack, 'gm', { now: 0 }).gm.origins.srd51_dcc.label, '5e SRD → crawler');
  assert.equal(viewFor(state, pack, 'stage', { now: 0 }).gm, undefined);
});
