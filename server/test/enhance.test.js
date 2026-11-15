import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { createState, reduce, viewFor } from '../state.js';
import { enrichInventory, libraryOf } from '../character.js';
import { enhanceItem } from '../ruleset.js';
import { tmpDir, writePack, seq } from './fixtures.js';

const { pack } = loadPack(writePack(tmpDir(), {
  'items.json': [
    { id: 'club', name: 'Club', desc: 'Bonk.', rarity: 'common', slot: 'hands', attack: { skill: 'bludgeons', stat: 'str', dice: '1d4' } },
    { id: 'plate', name: 'Plate', desc: 'Clank.', rarity: 'common', slot: 'torso', effects: [{ target: 'armor', op: 'add', value: 3, when: 'equipped' }] },
    { id: 'arrows', name: 'Arrows', desc: 'Pointy.', rarity: 'common', stackable: true },
    { id: 'crown', name: 'Crown', desc: 'Shiny.', rarity: 'legendary', effects: [{ target: 'armor', op: 'add', value: 1 }] },
  ],
  'loot.json': {},
}));
let n = 0;
const ctx = () => ({ now: 1_000_000, rng: seq(0.5), genId: (x) => `${x}_${++n}`, pack });
const gm = (s, a) => reduce(s, { role: 'gm', ...a }, ctx());

test('enhanceItem: +N name, rarity up (never down), weapon bonus, armour effect', () => {
  const club = pack.itemsById.get('club');
  assert.equal(enhanceItem(club, 0), club);
  const c2 = enhanceItem(club, 2);
  assert.deepEqual([c2.name, c2.rarity, c2.attack.bonus], ['Club +2', 'rare', 2]);
  const p1 = enhanceItem(pack.itemsById.get('plate'), 1);
  assert.deepEqual([p1.rarity, p1.effects.length, p1.effects[1].value], ['uncommon', 2, 1]);
  assert.equal(enhanceItem(pack.itemsById.get('crown'), 1).rarity, 'legendary');
});

test('give +1 / +2, enhance later, stacks keep their own bonus', () => {
  let s = createState(pack, 0);
  const r = gm(s, { t: 'player.add', name: 'Carl' }); s = r.state; const pid = r.result.playerId;
  s = gm(s, { t: 'item.give', playerId: pid, itemId: 'club', bonus: 1 }).state;
  s = gm(s, { t: 'lib.give', playerId: pid, kind: 'item', id: 'plate', bonus: 2 }).state;
  s = gm(s, { t: 'item.give', playerId: pid, itemId: 'arrows', qty: 5 }).state;
  s = gm(s, { t: 'item.give', playerId: pid, itemId: 'arrows', qty: 2, bonus: 1 }).state;
  const p = () => s.players.find((x) => x.id === pid);
  const lib = libraryOf(s, pack);
  let inv = enrichInventory(p().inventory, lib);
  assert.deepEqual(inv.map((i) => [i.name, i.rarity, i.qty]), [['Club +1', 'uncommon', 1], ['Plate +2', 'rare', 1], ['Arrows', 'common', 5], ['Arrows +1', 'uncommon', 2]]);
  assert.equal(inv[0].attack.bonus, 1);
  assert.equal(inv[1].effects.length, 2);
  assert.throws(() => gm(s, { t: 'item.enhance', playerId: pid, uid: inv[2].uid, bonus: 1 }), /split the stack/);
  assert.throws(() => gm(s, { t: 'item.enhance', playerId: pid, uid: inv[0].uid, bonus: 4 }), /bonus/);
  s = gm(s, { t: 'item.enhance', playerId: pid, uid: inv[0].uid, bonus: 0 }).state;
  inv = enrichInventory(p().inventory, lib);
  assert.deepEqual([inv[0].name, inv[0].rarity, inv[0].attack.bonus], ['Club', 'common', undefined]);
  const cat = viewFor(s, pack, 'gm', {}).gm.itemsCatalog;
  assert.deepEqual(cat.filter((x) => x.enhanceable).map((x) => x.id).sort(), ['club', 'crown', 'plate']);
});
