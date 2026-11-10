import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPack, readPackFiles, serializePack, deserializePack, normalizePack } from '../pack.js';
import { createState, normalizeState, reduce, reducePlayerAction, viewFor, ActionError } from '../state.js';
import { normalizeRuleset, computeSheet, makeLibrary } from '../ruleset.js';
import { tmpDir, writePack, seq } from './fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const RULESET = {
  id: 'test-rules',
  dice: 'd20',
  stats: [
    { id: 'str', label: 'Strength', abbr: 'STR', parts: ['enhanced', 'unenhanced'], default: { enhanced: 10, unenhanced: 10 } },
    { id: 'dex', label: 'Dexterity', abbr: 'DEX', parts: ['enhanced', 'unenhanced'], default: { enhanced: 16, unenhanced: 14 } },
    { id: 'int', label: 'Intelligence', abbr: 'INT', default: 10 },
  ],
  statMod: { from: 'enhanced', formula: 'floor((x - 10) / 2)', verify: true, note: 'guess' },
  derived: [
    { id: 'evade', label: 'Evade', formula: 'mod.dex + buff.evade', display: 'd20 + {value}', roll: 'd20' },
    { id: 'dr', label: 'Damage Resistance', formula: 'field.armor + buff.dr', verify: true, note: 'check' },
    { id: 'double', label: 'Double evade', formula: 'derived.evade * 2' },
  ],
  fields: [
    { id: 'armor', label: 'Armor', type: 'number', default: 1, group: 'defense' },
    { id: 'maxMana', label: 'Max Mana', type: 'number', default: 6 },
    { id: 'size', label: 'Size', type: 'text', default: 'Medium' },
    { id: 'crawlerNumber', label: 'Crawler #', type: 'text' },
    { id: 'popularity', label: 'Popularity', type: 'longtext' },
  ],
  tracks: [
    { id: 'hp', label: 'Health', kind: 'slots', slots: 10, default: 10 },
    { id: 'mana', label: 'Mana', kind: 'pool', maxFormula: 'field.maxMana', default: 6 },
  ],
  slots: [
    { id: 'head', label: 'Head', max: 1 },
    { id: 'hands', label: 'Hands', max: 2 },
    { id: 'accessories', label: 'Accessories', max: 10 },
  ],
  buffSlots: { external: { label: 'External buffs', max: 2 } },
  hotlist: { size: 3 },
  skills: {
    rankMax: 15,
    rankMin: 1,
    checkTypes: ['Standard', 'Opposed'],
    usedTracking: true,
    rankUp: { roll: 'd20', rule: 'gt', target: 'rank', note: 'verify with rulebook' },
    catalog: [{ id: 'sneak', name: 'Sneak', stat: 'dex', checkType: 'Opposed' }],
  },
  attack: { toHit: 'skill.rank + mod.{stat} + buff.toHit', damage: '{dice} + mod.{stat} + buff.damage' },
  spells: { costTrack: 'mana' },
  identity: ['name', 'race', 'class', 'level', 'floor', 'pronouns', 'crawlerNumber'],
  storyFields: ['popularity', 'notes'],
  races: [{ id: 'elf', name: 'Elf', features: ['keen'], statBonuses: [{ target: 'stat.dex', value: 2 }] }],
  classes: ['brawler'],
  combat: { ignored: true },
};

const ITEMS = [
  { id: 'duck', name: 'Duck', desc: 'Squeak.', rarity: 'common', image: 'duck.webp' },
  { id: 'sword', name: 'Sword', desc: 'Pointy.', rarity: 'rare', slot: 'hands', attack: { skill: 'blades', stat: 'str', dice: '1d8' } },
  { id: 'crown', name: 'Crown', desc: 'Shiny.', rarity: 'legendary' },
  { id: 'ring', name: 'Ring of Dodging', desc: '+2 Evade.', slot: 'accessories', effects: [{ target: 'evade', value: 2, when: 'equipped' }] },
  { id: 'lucky_coin', name: 'Lucky Coin', desc: '+1 DEX mod while carried.', effects: [{ target: 'mod.dex', value: 1, when: 'carried' }] },
  { id: 'helm', name: 'Helm', desc: 'DR becomes 10.', slot: 'head', effects: [{ target: 'dr', op: 'set', value: 10, label: 'Helm of Ten' }] },
  { id: 'big_bag', name: 'Big Bag', desc: 'More mana.', effects: [{ target: 'track.mana.max', value: 'floor(level / 2) + 1', when: 'carried' }] },
  { id: 'potion', name: 'Potion', desc: 'Heal 3, cures bleeding.', stackable: true, use: { track: 'hp', delta: 3, removeBuff: 'bleeding' } },
  { id: 'smoke', name: 'Smoke', desc: 'Hide.', stackable: true, use: { buff: 'hidden', target: 'self' } },
  { id: 'sand', name: 'Sand', desc: 'Blind an enemy.', use: { buff: 'blinded', target: 'enemy', consume: true } },
  { id: 'bad_fx', name: 'Bad', desc: 'Broken effects are skipped.', effects: [{ target: '__proto__', value: 1 }, { target: 'evade', value: 'mod.dex +' }, { target: 'evade', value: 1 }] },
];

const files = (extra = {}) => ({
  'ruleset.json': RULESET,
  'items.json': ITEMS,
  'spells.json': [
    { id: 'fireball', name: 'Fireball', cost: 2, dice: '3d6', attack: { skill: 'magic', stat: 'int', dice: '3d6' } },
    { id: 'haste', name: 'Haste', cost: '1 + rank', effects: [{ target: 'evade', value: 2, when: 'active', label: 'Haste' }] },
    { id: 'ward', name: 'Ward', cost: 1, applies: 'warded' },
    { id: 'hex', name: 'Hex', cost: 1, applies: 'blinded' },
    { id: 'free', name: 'Free Spell', cost: 0, costTrack: 'nope' },
  ],
  'buffs.json': [
    { id: 'haste_buff', name: 'Haste', external: true, effects: [{ target: 'evade', value: 2 }] },
    { id: 'blessed', name: 'Blessed', external: true, effects: [{ target: 'dr', value: 1 }] },
    { id: 'cheered', name: 'Cheered', external: true, effects: [] },
    { id: 'bleeding', name: 'Bleeding', tags: ['debuff'], effects: [{ target: 'evade', value: -1 }] },
    { id: 'warded', name: 'Warded', effects: [{ target: 'dr', value: 2 }] },
    { id: 'hidden', name: 'Hidden', effects: [] },
    { id: 'blinded', name: 'Blinded', tags: ['debuff'], effects: [{ target: 'toHit', value: -2 }] },
  ],
  'features.json': [{ id: 'keen', name: 'Keen Senses', effects: [{ target: 'skill.sneak', value: 1 }] }],
  'classes.json': [{ id: 'brawler', name: 'Brawler', features: [], statBonuses: [{ target: 'toHit', value: 1 }] }],
  'skills.json': [{ id: 'blades', name: 'Blades', stat: 'str', checkType: 'Standard', upgrades: [{ rank: 5, text: 'Parry' }] }],
  ...extra,
});

const { pack, warnings: packWarnings } = loadPack(writePack(tmpDir(), files()));
let n = 0;
const ctx = (extra = {}) => ({ now: 1_000_000, rng: seq(0.5), genId: (p) => `${p}_${++n}`, pack, rollInt: () => 9, ...extra });
const gm = (state, a, extra) => reduce(state, { role: 'gm', ...a }, ctx(extra));
const pl = (state, playerId, a, extra) => reducePlayerAction(state, a, { ...ctx(extra), playerId });
const code = (c) => (e) => e instanceof ActionError && e.code === c;

function setup(n = 1) {
  let state = createState(pack, 0);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const r = gm(state, { t: 'player.add', name: `P${i}` });
    state = r.state;
    ids.push(r.result.playerId);
  }
  return { state, ids, id: ids[0] };
}

/** Runs a list of GM actions; returns the last result's state + results. */
function run(state, ...actions) {
  const results = [];
  for (const a of actions) {
    const r = gm(state, a);
    state = r.state;
    results.push(r);
  }
  return { state, results };
}

const sheetOf = (state, id, p = pack) => viewFor(state, p, 'player', { playerId: id }).me.sheet;
const pmap = (parts) => parts.map((p) => [p.label, p.value]);

// ---------- pack / ruleset ----------

test('pack loads ruleset + library files; bad effects skipped with warnings', () => {
  assert.equal(pack.ruleset.id, 'test-rules');
  assert.deepEqual(pack.library.spell.map((s) => s.id), ['fireball', 'haste', 'ward', 'hex', 'free']);
  assert.deepEqual(pack.library.skill.map((s) => s.id), ['blades', 'sneak'], 'skills.json + ruleset catalog');
  assert.deepEqual(pack.library.race.map((s) => s.id), ['elf'], 'inline race moved to the library');
  assert.deepEqual(pack.ruleset.races, ['elf']);
  assert.equal(pack.itemsById.get('sword').slot, 'hands');
  assert.equal(pack.itemsById.get('duck').slot, null);
  assert.deepEqual(pack.itemsById.get('bad_fx').effects.map((e) => e.value), [1]);
  assert.ok(packWarnings.some((w) => /__proto__/.test(w)));
  assert.ok(packWarnings.some((w) => /invalid formula/.test(w)));
  assert.deepEqual(pack.itemsById.get('potion').use, { heal: { track: 'hp', amount: 3 }, applyBuff: null, removeBuff: 'bleeding', target: 'self', consume: null, buffOnFail: null, note: '' });
  // legacy pack.stats / resources follow the ruleset
  assert.deepEqual(pack.stats.map((s) => [s.id, s.default]), [['str', 10], ['dex', 16], ['int', 10]]);
  assert.deepEqual(pack.resources.map((r) => [r.id, r.default]), [['hp', 10], ['mana', 6]]);
  assert.equal(pack.ruleset.combat, undefined, 'unknown keys ignored');
});

test('normalizeRuleset: defaults, legacy fallback, idempotent, unverified markers', () => {
  const legacy = { stats: [{ id: 'str', label: 'Strength', abbr: 'STR', default: 3 }], resources: [{ id: 'hp', label: 'Health', color: '#ff3355', default: 10 }] };
  const r = normalizeRuleset(undefined, legacy);
  assert.deepEqual(r.stats, [{ id: 'str', label: 'Strength', abbr: 'STR', parts: ['enhanced', 'unenhanced'], default: { enhanced: 3, unenhanced: 3 } }]);
  assert.equal(r.statMod.formula, 'x', 'no statMod → the stat value is the modifier');
  assert.deepEqual(r.tracks, [{ id: 'hp', label: 'Health', kind: 'pool', color: '#ff3355', default: 10 }]);
  assert.equal(r.hotlist.size, 10);
  assert.equal(r.buffSlots.external.max, null);
  assert.equal(r.skills.rankUp, null);
  assert.deepEqual(r.unverified, []);
  const full = JSON.parse(JSON.stringify(normalizeRuleset(RULESET, legacy)));
  assert.deepEqual(JSON.parse(JSON.stringify(normalizeRuleset(full, legacy))), full, 'idempotent');
  assert.deepEqual(full.unverified.map((u) => u.path).sort(), ['derived.dr', 'statMod']);
  const w = [];
  const bad = normalizeRuleset({ stats: [{ id: 'a b' }, { id: 'ok' }, { id: 'ok' }], statMod: { formula: 'x +' }, derived: [{ id: 'z', formula: '1 +' }], tracks: 'nope' }, legacy, w);
  assert.deepEqual(bad.stats.map((s) => s.id), ['ok']);
  assert.equal(bad.statMod.formula, 'x');
  assert.deepEqual(bad.derived, []);
  assert.ok(w.length >= 4);
  assert.deepEqual(normalizeRuleset('junk', legacy, []).stats.map((s) => s.id), ['str']);
});

// ---------- computed sheet ----------

test('computeSheet: Evade = DEX mod + Buffs (Ring of Dodging, Haste) with breakdown', () => {
  let { state, id } = setup();
  const ring = gm(state, { t: 'item.give', playerId: id, itemId: 'ring' });
  ({ state } = run(ring.state,
    { t: 'item.equip', playerId: id, uid: ring.result.uid, slot: 'accessories' },
    { t: 'buff.add', playerId: id, buffId: 'haste_buff' },
  ));
  const c = sheetOf(state, id).computed;
  assert.equal(c.stats.dex.value, 16);
  assert.deepEqual(pmap(c.stats.dex.mod.parts), [['DEX mod', 3]]);
  assert.equal(c.derived.evade.value, 7);
  assert.equal(c.derived.evade.display, 'd20 + 7');
  assert.deepEqual(c.derived.evade.parts, [
    { label: 'DEX mod', value: 3, source: 'mod.dex' },
    { label: 'Buffs', value: 4, source: 'buff.evade', parts: [
      { label: 'Ring of Dodging', value: 2, source: `item:${ring.result.uid}` },
      { label: 'Haste', value: 2, source: `buff:${state.players[0].sheet.buffs[0].uid}` },
    ] },
  ]);
  assert.equal(c.derived.double.value, 14, 'derived may reference earlier derived');
  // statMod verify marker surfaces as warning on the mod and globally
  assert.deepEqual(c.stats.dex.mod.warnings, [{ kind: 'unverified', path: 'statMod', note: 'guess' }]);
  assert.ok(c.warnings.some((w) => w.kind === 'unverified' && w.path === 'derived.dr'));
  assert.ok(c.derived.dr.warnings.some((w) => w.kind === 'unverified'));
  // zero buff parts are omitted
  assert.deepEqual(pmap(c.derived.dr.parts), [['Armor', 1]]);
});

test('computeSheet: when equipped / carried / hotlist, set op, track max formula effect, debuffs, race features', () => {
  let { state, id } = setup();
  const give = (itemId) => {
    const r = gm(state, { t: 'item.give', playerId: id, itemId });
    state = r.state;
    return r.result.uid;
  };
  const ring = give('ring');
  give('lucky_coin');
  const helm = give('helm');
  give('big_bag');
  let c = sheetOf(state, id).computed;
  assert.equal(c.derived.evade.value, 4, 'ring not equipped; coin carried gives mod +1');
  assert.deepEqual(pmap(c.stats.dex.mod.parts), [['DEX mod', 3], ['Lucky Coin', 1]]);
  assert.equal(c.derived.dr.value, 1, 'helm carried but not equipped');
  assert.equal(c.tracks.mana.max, 7, 'big bag: floor(1/2)+1');
  ({ state } = run(state, { t: 'hotlist.set', playerId: id, index: 0, uid: ring }, { t: 'item.equip', playerId: id, uid: helm, slot: 'head' }));
  c = sheetOf(state, id).computed;
  assert.equal(c.derived.evade.value, 6, 'hotlisted counts as equipped');
  assert.deepEqual(c.derived.dr.parts, [{ label: 'Helm of Ten (set)', value: 10, source: `item:${helm}`, op: 'set' }]);
  assert.equal(c.derived.dr.value, 10);
  ({ state } = run(state, { t: 'buff.add', playerId: id, buffId: 'bleeding' }, { t: 'sheet.set', playerId: id, path: 'identity.race', value: 'elf' }, { t: 'sheet.set', playerId: id, path: 'identity.class', value: 'Brawler' }, { t: 'skill.add', playerId: id, skillId: 'sneak', rank: 2 }));
  c = sheetOf(state, id).computed;
  assert.equal(c.effects.find((e) => e.label === 'Bleeding').debuff, true);
  assert.equal(c.stats.dex.value, 18, 'race stat bonus');
  assert.equal(c.stats.dex.mod.value, 5);
  assert.deepEqual(pmap(c.skills[0].total.parts), [['Rank', 2], ['DEX mod', 5], ['Keen Senses', 1]]);
  assert.equal(c.skills[0].total.value, 8);
  assert.equal(c.buffs.toHit.value, 1, 'class bonus by name');
});

test('computeSheet: attacks show to-hit breakdown and damage text; unknown identifiers warn', () => {
  let { state, id } = setup();
  ({ state } = run(state,
    { t: 'sheet.set', playerId: id, path: 'stats.str.enhanced', value: 16 },
    { t: 'skill.add', playerId: id, skillId: 'blades', rank: 4 },
  ));
  const skillUid = state.players[0].sheet.skills[0].uid;
  ({ state } = run(state,
    { t: 'attack.add', playerId: id, name: 'Sword', skillUid, stat: 'str', dice: '1d8' },
    { t: 'attack.add', playerId: id, name: 'Shove', stat: '' },
    { t: 'buff.add', playerId: id, name: 'Blinded', effects: [{ target: 'toHit', value: -2 }] },
  ));
  const c = sheetOf(state, id).computed;
  assert.deepEqual(pmap(c.attacks[0].toHit.parts), [['Blades rank', 4], ['STR mod', 3], ['Buffs', -2]]);
  assert.equal(c.attacks[0].toHit.value, 5);
  assert.equal(c.attacks[0].damage, '1d8+3');
  assert.equal(c.attacks[1].damage, '0', 'no dice, no stat');
  assert.equal(c.attacks[1].toHit.value, -2);
  // computeSheet directly with a formula referencing nonsense
  const rs = normalizeRuleset({ ...RULESET, derived: [{ id: 'x', label: 'X', formula: 'mod.wis + constructor + 1' }] });
  const out = computeSheet({ level: 1, stats: {}, inventory: [], skills: [], buffs: [], spells: [] }, rs, makeLibrary(pack, {}));
  assert.equal(out.derived.x.value, 1);
  assert.deepEqual(out.derived.x.warnings.filter((w) => w.kind === 'unknown').map((w) => w.name), ['mod.wis', 'constructor']);
});

// ---------- actions ----------

test('sheet.set: whitelisted roots, mapped identity/story, fields redirect, bad paths', () => {
  let { state, id } = setup();
  ({ state } = run(state,
    { t: 'sheet.set', playerId: id, path: 'identity.name', value: 'Carl' },
    { t: 'sheet.set', playerId: id, path: 'identity.level', value: 3 },
    { t: 'sheet.set', playerId: id, path: 'identity.floor', value: 2 },
    { t: 'sheet.set', playerId: id, path: 'fields.crawlerNumber', value: '4122' },
    { t: 'sheet.set', playerId: id, path: 'fields.popularity', value: 'Huge' },
    { t: 'sheet.set', playerId: id, path: 'story.notes', value: 'note' },
    { t: 'sheet.set', playerId: id, path: 'fields.armor', value: 3 },
    { t: 'sheet.set', playerId: id, path: 'fields.size', value: 'Small' },
    { t: 'sheet.set', playerId: id, path: 'stats.dex', value: 12 },
    { t: 'sheet.set', playerId: id, path: 'stats.str', value: { unenhanced: 8 } },
    { t: 'sheet.set', playerId: id, path: 'portrait', value: 'https://example.com/a.png' },
  ));
  const p = state.players[0];
  assert.equal(p.name, 'Carl');
  assert.equal(p.level, 3);
  assert.equal(p.notes, 'note');
  assert.equal(p.sheet.identity.crawlerNumber, '4122');
  assert.equal(p.sheet.story.popularity, 'Huge');
  assert.deepEqual(p.sheet.stats.dex, { enhanced: 12, unenhanced: 14 });
  assert.deepEqual(p.sheet.stats.str, { enhanced: 10, unenhanced: 8 });
  const sh = sheetOf(state, id);
  assert.equal(sh.identity.name, 'Carl');
  assert.equal(sh.fields.crawlerNumber, '4122');
  assert.equal(sh.fields.popularity, 'Huge');
  assert.equal(sh.story.notes, 'note');
  assert.equal(sh.computed.derived.dr.value, 3);
  assert.equal(sh.portrait, 'https://example.com/a.png');
  for (const path of ['__proto__.x', 'constructor', 'identity.__proto__', 'stats.wis', 'stats.str.base', 'fields.nope', 'identity.secret', 'pin', 'inventory', 'story.nope', 'identity', 'a.b.c.d']) {
    assert.throws(() => gm(state, { t: 'sheet.set', playerId: id, path, value: 1 }), ActionError, path);
  }
  assert.throws(() => gm(state, { t: 'sheet.set', playerId: id, path: 'stats.str', value: 'x' }), /number/);
  assert.throws(() => gm(state, { t: 'sheet.set', playerId: id, path: 'portrait', value: 'javascript:alert(1)' }), /portrait/);
  assert.throws(() => gm(state, { t: 'sheet.set', playerId: id, path: 'identity.name' }), /value required/);
  assert.equal({}.x, undefined);
});

test('track.set clamps to computed max; legacy player.resource still works', () => {
  let { state, id } = setup();
  let r = gm(state, { t: 'track.set', playerId: id, track: 'mana', delta: -4 });
  assert.deepEqual(r.state.players[0].sheet.tracks.mana, { cur: 2, max: 6 });
  assert.deepEqual(r.events[0].event, { ...r.events[0].event, kind: 'stat', stat: 'mana', resource: true, from: 6, to: 2, max: 6 });
  r = gm(r.state, { t: 'track.set', playerId: id, track: 'mana', cur: 99 });
  assert.equal(sheetOf(r.state, id).computed.tracks.mana.cur, 6, 'maxFormula field.maxMana caps it');
  r = gm(r.state, { t: 'track.set', playerId: id, track: 'hp', max: 50, cur: 50 });
  assert.equal(sheetOf(r.state, id).computed.tracks.hp.max, 10, 'slots track max is the slot count');
  r = gm(r.state, { t: 'player.resource', playerId: id, res: 'hp', delta: -3 });
  assert.deepEqual(viewFor(r.state, pack, 'player', { playerId: id }).me.resources.hp, { cur: 7, max: 10 });
  assert.throws(() => gm(state, { t: 'track.set', playerId: id, track: 'nope', cur: 1 }), code('not_found'));
  assert.throws(() => gm(state, { t: 'track.set', playerId: id, track: 'hp' }), /cur, max or delta/);
});

test('skills: add from library / ad-hoc, update, remove clears attack links', () => {
  let { state, id } = setup();
  let r = gm(state, { t: 'skill.add', playerId: id, skillId: 'sneak' });
  assert.deepEqual({ ...r.state.players[0].sheet.skills[0], uid: 0 }, { uid: 0, skillId: 'sneak', name: 'Sneak', stat: 'dex', checkType: 'Opposed', rank: 1, notes: '', used: false });
  assert.throws(() => gm(r.state, { t: 'skill.add', playerId: id, skillId: 'sneak' }), /already has/);
  assert.throws(() => gm(r.state, { t: 'skill.add', playerId: id, skillId: 'nope' }), code('not_found'));
  r = gm(r.state, { t: 'skill.add', playerId: id, name: 'Juggling', stat: 'dex', rank: 3 });
  const uid = r.result.uid;
  assert.equal(r.state.players[0].sheet.skills[1].checkType, 'Standard');
  assert.throws(() => gm(r.state, { t: 'skill.add', playerId: id, name: 'X', stat: 'wis' }), /stat id/);
  assert.throws(() => gm(r.state, { t: 'skill.add', playerId: id, name: 'X', rank: 16 }), /0\.\.15/);
  r = gm(r.state, { t: 'attack.add', playerId: id, name: 'Juggle-punch', skillUid: uid, dice: '1d4' });
  r = gm(r.state, { t: 'skill.update', playerId: id, uid, rank: 5, notes: 'n', used: true, stat: 'str' });
  assert.deepEqual([r.state.players[0].sheet.skills[1].rank, r.state.players[0].sheet.skills[1].used, r.state.players[0].sheet.skills[1].stat], [5, true, 'str']);
  r = gm(r.state, { t: 'skill.remove', playerId: id, uid });
  assert.equal(r.state.players[0].sheet.skills.length, 1);
  assert.equal(r.state.players[0].sheet.attacks[0].skillUid, null);
  assert.throws(() => gm(r.state, { t: 'skill.remove', playerId: id, uid }), code('not_found'));
});

test('attacks: add / update / remove with dice validation', () => {
  let { state, id } = setup();
  let r = gm(state, { t: 'attack.add', playerId: id, name: 'Kick', stat: 'str', dice: '1d6', effects: 'prone' });
  const uid = r.result.uid;
  assert.throws(() => gm(r.state, { t: 'attack.add', playerId: id, name: 'X', dice: '1d6 + constructor(' }), /dice/);
  assert.throws(() => gm(r.state, { t: 'attack.add', playerId: id, name: 'X', dice: '999d6' }), /dice/);
  assert.throws(() => gm(r.state, { t: 'attack.add', playerId: id, name: 'X', skillUid: 'nope' }), code('not_found'));
  assert.throws(() => gm(r.state, { t: 'attack.add', playerId: id }), /name/);
  r = gm(r.state, { t: 'attack.update', playerId: id, uid, dice: '2d6' });
  assert.equal(r.state.players[0].sheet.attacks[0].dice, '2d6');
  assert.equal(r.state.players[0].sheet.attacks[0].name, 'Kick');
  r = gm(r.state, { t: 'attack.remove', playerId: id, uid });
  assert.deepEqual(r.state.players[0].sheet.attacks, []);
});

test('spells: learn, cast deducts cost (formula cost by rank), not enough mana, activation, forget', () => {
  let { state, id } = setup();
  let r = gm(state, { t: 'spell.learn', playerId: id, spellId: 'haste', rank: 2 });
  const haste = r.result.uid;
  assert.throws(() => gm(r.state, { t: 'spell.learn', playerId: id, spellId: 'haste' }), /already knows/);
  assert.throws(() => gm(r.state, { t: 'spell.learn', playerId: id, spellId: 'nope' }), code('not_found'));
  assert.equal(sheetOf(r.state, id).computed.spells[0].cost.value, 3);
  assert.equal(sheetOf(r.state, id).spells[0].name, 'Haste', 'view enriches spells with library data');
  r = gm(r.state, { t: 'spell.cast', playerId: id, uid: haste });
  assert.deepEqual(r.result, { cost: 3, track: 'mana', cur: 3, active: true, applied: null });
  assert.equal(r.events.find((e) => e.event.kind === 'spell').event.name, 'Haste');
  assert.equal(r.state.feed.at(-1).text, 'P0 cast Haste');
  let c = sheetOf(r.state, id).computed;
  assert.equal(c.tracks.mana.cur, 3);
  assert.equal(c.derived.evade.value, 5, 'active spell effect applies');
  r = gm(r.state, { t: 'spell.cast', playerId: id, uid: haste });
  assert.throws(() => gm(r.state, { t: 'spell.cast', playerId: id, uid: haste }), /not enough Mana: 0\/3/);
  r = gm(r.state, { t: 'spell.update', playerId: id, uid: haste, active: false });
  assert.equal(sheetOf(r.state, id).computed.derived.evade.value, 3);
  const free = gm(r.state, { t: 'spell.learn', playerId: id, spellId: 'free' });
  assert.equal(gm(free.state, { t: 'spell.cast', playerId: id, uid: free.result.uid }).result.cost, 0, 'zero cost needs no track');
  r = gm(r.state, { t: 'spell.forget', playerId: id, uid: haste });
  assert.deepEqual(r.state.players[0].sheet.spells, []);
});

test('spells: applies a buff to the caster (not debuffs) or to a GM-chosen target', () => {
  let { state, ids } = setup(2);
  const [a, b] = ids;
  let r = gm(state, { t: 'spell.learn', playerId: a, spellId: 'ward' });
  const ward = r.result.uid;
  r = gm(r.state, { t: 'spell.learn', playerId: a, spellId: 'hex' });
  const hex = r.result.uid;
  const self = gm(r.state, { t: 'spell.cast', playerId: a, uid: ward });
  assert.deepEqual(self.state.players[0].sheet.buffs.map((x) => x.buffId), ['warded']);
  assert.equal(sheetOf(self.state, a).computed.derived.dr.value, 3);
  const onB = gm(r.state, { t: 'spell.cast', playerId: a, uid: hex, target: b });
  assert.deepEqual(onB.state.players[1].sheet.buffs.map((x) => x.buffId), ['blinded']);
  const noTarget = gm(r.state, { t: 'spell.cast', playerId: a, uid: hex });
  assert.deepEqual(noTarget.state.players[0].sheet.buffs, [], 'debuff not applied to the caster');
  assert.throws(() => pl(r.state, a, { t: 'spell.cast', uid: hex, target: b }), code('forbidden'));
});

test('item.equip enforces slot max and item slot; item.qty; hotlist; give merges stackables', () => {
  let { state, id } = setup();
  const uids = [];
  for (let i = 0; i < 3; i++) {
    const r = gm(state, { t: 'item.give', playerId: id, itemId: 'sword' });
    state = r.state;
    uids.push(r.result.uid);
  }
  assert.equal(state.players[0].inventory[0].qty, 1);
  assert.equal(state.players[0].inventory[0].equippedSlot, null);
  ({ state } = run(state, { t: 'item.equip', playerId: id, uid: uids[0], slot: 'hands' }, { t: 'item.equip', playerId: id, uid: uids[1], slot: 'hands' }));
  assert.throws(() => gm(state, { t: 'item.equip', playerId: id, uid: uids[2], slot: 'hands' }), /Hands is full \(max 2\)/);
  assert.throws(() => gm(state, { t: 'item.equip', playerId: id, uid: uids[2], slot: 'head' }), /goes in hands/);
  assert.throws(() => gm(state, { t: 'item.equip', playerId: id, uid: uids[2], slot: 'nope' }), /slot must be one of/);
  ({ state } = run(state, { t: 'item.equip', playerId: id, uid: uids[0], slot: 'hands' }), 're-equip in same slot is fine');
  ({ state } = run(state, { t: 'item.equip', playerId: id, uid: uids[0], slot: null }, { t: 'item.equip', playerId: id, uid: uids[2], slot: 'hands' }));
  // stackables merge
  let r = gm(state, { t: 'item.give', playerId: id, itemId: 'potion' });
  r = gm(r.state, { t: 'item.give', playerId: id, itemId: 'potion', qty: 2 });
  const pot = r.state.players[0].inventory.find((i) => i.itemId === 'potion');
  assert.equal(pot.qty, 3);
  r = gm(r.state, { t: 'hotlist.set', playerId: id, index: 2, uid: pot.uid });
  assert.deepEqual(r.state.players[0].sheet.hotlist, [null, null, pot.uid]);
  r = gm(r.state, { t: 'hotlist.set', playerId: id, index: 0, uid: pot.uid });
  assert.deepEqual(r.state.players[0].sheet.hotlist, [pot.uid, null, null], 'moving clears the old index');
  assert.throws(() => gm(r.state, { t: 'hotlist.set', playerId: id, index: 3, uid: null }), /index/);
  r = gm(r.state, { t: 'item.qty', playerId: id, uid: pot.uid, qty: 0 });
  assert.equal(r.state.players[0].inventory.some((i) => i.uid === pot.uid), false);
  assert.deepEqual(r.state.players[0].sheet.hotlist, [null, null, null]);
  assert.throws(() => gm(r.state, { t: 'item.qty', playerId: id, uid: uids[0], qty: -1 }), /qty/);
});

test('item.use: heal, remove buff, consume stack, self buff, enemy buff left pending', () => {
  let { state, id } = setup();
  ({ state } = run(state, { t: 'track.set', playerId: id, track: 'hp', cur: 4 }, { t: 'buff.add', playerId: id, buffId: 'bleeding' }, { t: 'item.give', playerId: id, itemId: 'potion', qty: 2 }, { t: 'item.give', playerId: id, itemId: 'smoke' }, { t: 'item.give', playerId: id, itemId: 'sand' }, { t: 'item.give', playerId: id, itemId: 'duck' }));
  const inv = (itemId) => state.players[0].inventory.find((i) => i.itemId === itemId);
  let r = gm(state, { t: 'item.use', playerId: id, uid: inv('potion').uid });
  assert.deepEqual(r.result.healed, { playerId: id, track: 'hp', from: 4, to: 7, max: 10 });
  assert.equal(r.state.players[0].sheet.buffs.length, 0, 'bleeding removed');
  assert.equal(r.state.players[0].inventory.find((i) => i.itemId === 'potion').qty, 1);
  const ev = r.events.find((e) => e.event.kind === 'itemUse');
  assert.equal(ev.to, 'all');
  assert.equal(ev.event.removedBuff, 'bleeding');
  r = gm(r.state, { t: 'item.use', playerId: id, uid: inv('smoke').uid });
  assert.deepEqual(r.state.players[0].sheet.buffs.map((b) => b.buffId), ['hidden']);
  assert.equal(r.state.players[0].inventory.some((i) => i.itemId === 'smoke'), false, 'last of a stack is removed');
  r = gm(r.state, { t: 'item.use', playerId: id, uid: inv('sand').uid });
  assert.equal(r.result.pendingBuff, 'blinded');
  assert.deepEqual(r.state.players[0].sheet.buffs.map((b) => b.buffId), ['hidden']);
  assert.throws(() => gm(state, { t: 'item.use', playerId: id, uid: inv('duck').uid }), /has no use/);
});

test('buff.add / remove: library, ad-hoc with validated effects, external cap, no duplicate library buffs', () => {
  let { state, id } = setup();
  ({ state } = run(state, { t: 'buff.add', playerId: id, buffId: 'haste_buff' }, { t: 'buff.add', playerId: id, buffId: 'blessed' }));
  assert.throws(() => gm(state, { t: 'buff.add', playerId: id, buffId: 'cheered' }), /cap 2/);
  assert.throws(() => gm(state, { t: 'buff.add', playerId: id, name: 'Sponsor', external: true, effects: [] }), /cap 2/);
  const dup = gm(state, { t: 'buff.add', playerId: id, buffId: 'haste_buff' });
  assert.equal(dup.result.added, false);
  assert.equal(dup.state.players[0].sheet.buffs.length, 2);
  let r = gm(state, { t: 'buff.add', playerId: id, name: 'Wet', effects: [{ target: 'evade', value: -1 }] });
  assert.equal(sheetOf(r.state, id).computed.externalBuffs.used, 2);
  assert.throws(() => gm(state, { t: 'buff.add', playerId: id, name: 'Bad', effects: [{ target: 'constructor', value: 1 }] }), /bad target/);
  assert.throws(() => gm(state, { t: 'buff.add', playerId: id, name: 'Bad', effects: [{ target: 'evade', value: '1 +' }] }), /invalid formula/);
  assert.throws(() => gm(state, { t: 'buff.add', playerId: id, buffId: 'nope' }), code('not_found'));
  r = gm(r.state, { t: 'buff.remove', playerId: id, uid: r.result.uid });
  assert.equal(r.state.players[0].sheet.buffs.length, 2);
});

test('roll: stat / derived / skill / attack / custom with breakdowns, events, nat20 line, secret visibility', () => {
  let { state, ids } = setup(2);
  const [a, b] = ids;
  ({ state } = run(state, { t: 'skill.add', playerId: a, skillId: 'blades', rank: 2 }));
  const sk = state.players[0].sheet.skills[0].uid;
  ({ state } = run(state, { t: 'attack.add', playerId: a, name: 'Cut', skillUid: sk, stat: 'str', dice: '1d8' }));
  const atk = state.players[0].sheet.attacks[0].uid;
  let r = gm(state, { t: 'roll', playerId: a, what: { kind: 'derived', id: 'evade' } }, { rollInt: () => 19 });
  const rec = r.state.rolls[0];
  assert.deepEqual(
    { ...rec, id: 0 },
    {
      id: 0, at: 1_000_000, playerId: a, by: 'gm', what: 'derived', label: 'Evade', formula: 'd20+3', dice: [{ die: 'd20', value: 20 }], total: 23,
      breakdown: { value: 23, warnings: [], parts: [
        { label: '1d20', value: 20, source: 'dice', rolls: [20] },
        { label: 'Evade', value: 3, source: 'derived.evade', parts: [{ label: 'DEX mod', value: 3, source: 'mod.dex' }] },
      ] },
      secret: false, nat1: false, nat20: true,
    },
  );
  assert.equal(r.events[0].to, 'all');
  assert.deepEqual({ ...r.events[0].event, id: 0 }, { ...rec, id: 0, kind: 'roll' }, 'event carries the roll object');
  assert.equal(r.result.total, 23);
  r = gm(r.state, { t: 'roll', playerId: a, what: { kind: 'stat', id: 'dex' } });
  assert.equal(r.result.total, 10 + 3);
  r = gm(r.state, { t: 'roll', playerId: a, what: { kind: 'skill', uid: sk } });
  assert.equal(r.result.total, 10 + 2);
  assert.equal(r.state.players[0].sheet.skills[0].used, true, 'rolling a skill marks it used');
  r = gm(r.state, { t: 'roll', playerId: a, what: { kind: 'attack', uid: atk } });
  assert.equal(r.state.rolls.at(-1).label, 'Cut to hit');
  r = gm(r.state, { t: 'roll', playerId: a, what: { kind: 'attack', uid: atk, part: 'damage' } });
  assert.equal(r.state.rolls.at(-1).total, 8, 'out-of-range RNG values are clamped to the die');
  assert.equal(r.state.rolls.at(-1).formula, '{dice} + mod.{stat} + buff.damage'.replace('{dice}', '(1d8)').replace('{stat}', 'str'));
  r = gm(r.state, { t: 'roll', what: { kind: 'custom', formula: '2d6 + 3', label: 'Trap' } });
  assert.equal(r.state.rolls.at(-1).playerId, null);
  assert.equal(r.state.rolls.at(-1).total, 15);
  r = gm(r.state, { t: 'roll', playerId: a, what: { kind: 'custom', formula: 'd20 + mod.dex + level' } });
  assert.equal(r.state.rolls.at(-1).total, 10 + 3 + 1);
  assert.throws(() => gm(r.state, { t: 'roll', playerId: a, what: { kind: 'custom', formula: '1d6 +' } }), /bad roll formula/);
  assert.throws(() => gm(r.state, { t: 'roll', playerId: a, what: { kind: 'magic' } }), /what.kind/);
  assert.throws(() => gm(r.state, { t: 'roll', playerId: a, what: { kind: 'stat', id: 'wis' } }), code('not_found'));
  // nat20 voice line only when not secret; nat1 too
  const n20 = gm(state, { t: 'roll', playerId: a, what: { kind: 'stat', id: 'str' } }, { rollInt: () => 19 });
  assert.equal(n20.lines.length, 0, 'fixture pack has no nat20 quips');
  const n1 = gm(state, { t: 'roll', playerId: a, what: { kind: 'stat', id: 'str' } }, { rollInt: () => 0 });
  assert.equal(n1.lines[0].category, 'nat1');
  const n1s = gm(state, { t: 'roll', playerId: a, secret: true, what: { kind: 'stat', id: 'str' } }, { rollInt: () => 0 });
  assert.equal(n1s.lines.length, 0);
  // secret: player rolls secretly → only that player + gm
  const ps = pl(state, a, { t: 'roll', secret: true, what: { kind: 'stat', id: 'dex' } });
  assert.deepEqual(ps.events[0].to, { roles: ['gm'], playerId: a });
  assert.equal(ps.state.rolls[0].by, a);
  assert.equal(viewFor(ps.state, pack, 'player', { playerId: a }).rolls.length, 1);
  assert.equal(viewFor(ps.state, pack, 'player', { playerId: b }).rolls.length, 0);
  assert.equal(viewFor(ps.state, pack, 'stage', {}).rolls.length, 0);
  assert.equal(viewFor(ps.state, pack, 'gm', {}).rolls.length, 1);
  // GM secret roll for a player: hidden from that player
  const gs = gm(state, { t: 'roll', playerId: a, secret: true, what: { kind: 'stat', id: 'dex' } });
  assert.deepEqual(gs.events[0].to, { roles: ['gm'] });
  assert.equal(viewFor(gs.state, pack, 'player', { playerId: a }).rolls.length, 0);
});

test('rolls are capped at 200 in state, 50 in views, cleared by session.new', () => {
  let { state, id } = setup();
  for (let i = 0; i < 205; i++) state = gm(state, { t: 'roll', playerId: id, what: { kind: 'custom', formula: '1d4' } }).state;
  assert.equal(state.rolls.length, 200);
  assert.equal(viewFor(state, pack, 'gm', {}).rolls.length, 50);
  assert.equal(gm(state, { t: 'session.new' }).state.rolls.length, 0);
});

test('skills.rankUp with injected RNG: gt rank, rankMax cap, used cleared, every roll logged', () => {
  let { state, ids } = setup(2);
  const [a, b] = ids;
  ({ state } = run(state,
    { t: 'skill.add', playerId: a, skillId: 'sneak', rank: 5 },
    { t: 'skill.add', playerId: a, skillId: 'blades', rank: 15 },
    { t: 'skill.add', playerId: a, name: 'Unused', rank: 1 },
    { t: 'skill.add', playerId: b, skillId: 'sneak', rank: 9 },
  ));
  for (const p of state.players) for (const s of p.sheet.skills) if (s.name !== 'Unused') s.used = true;
  // rolls in order: a.sneak=6 (>5 ok), a.blades=20 (>15 ok but capped), b.sneak=9 (not > 9)
  const rolls = [5, 19, 8];
  let i = 0;
  const r = gm(state, { t: 'skills.rankUp' }, { rollInt: () => rolls[i++] });
  assert.deepEqual(r.result.results.map((x) => [x.name, x.roll, x.target, x.success, x.from, x.to]), [
    ['Sneak', 6, 5, true, 5, 6],
    ['Blades', 20, 15, true, 15, 15],
    ['Sneak', 9, 9, false, 9, 9],
  ]);
  for (const p of r.state.players) for (const s of p.sheet.skills) assert.equal(s.used, false);
  assert.equal(r.state.rolls.length, 3);
  assert.deepEqual(r.state.rolls[0].rankUp, { skillUid: r.state.players[0].sheet.skills[0].uid, name: 'Sneak', rule: 'gt', target: 5, success: true, from: 5, to: 6 });
  assert.equal(r.events.filter((e) => e.event.kind === 'roll').length, 3);
  // single player only
  const one = gm(state, { t: 'skills.rankUp', playerId: b }, { rollInt: () => 19 });
  assert.deepEqual(one.result.results.map((x) => x.playerId), [b]);
  assert.throws(() => pl(state, a, { t: 'skills.rankUp' }), code('bad_request'), 'not a player action');
  // other rules + amount + formula target
  const p2 = loadPack(writePack(tmpDir(), files({ 'ruleset.json': { ...RULESET, skills: { ...RULESET.skills, rankUp: { roll: 'd20', rule: 'lte', target: 'rank * 2', amount: 2 } } } }))).pack;
  let s2 = reduce(createState(p2, 0), { role: 'gm', t: 'player.add', name: 'X' }, ctx({ pack: p2 })).state;
  const pid = s2.players[0].id;
  s2 = reduce(s2, { role: 'gm', t: 'skill.add', playerId: pid, skillId: 'sneak', rank: 3 }, ctx({ pack: p2 })).state;
  s2.players[0].sheet.skills[0].used = true;
  const r2 = reduce(s2, { role: 'gm', t: 'skills.rankUp' }, ctx({ pack: p2, rollInt: () => 5 }));
  assert.deepEqual(r2.result.results.map((x) => [x.roll, x.target, x.success, x.to]), [[6, 6, true, 5]]);
  // no rule → error
  const p3 = loadPack(writePack(tmpDir())).pack;
  assert.throws(() => reduce(createState(p3, 0), { role: 'gm', t: 'skills.rankUp' }, ctx({ pack: p3 })), /no skills.rankUp/);
});

test('library: upsert / remove homebrew, pack read-only, give each kind, views carry source', () => {
  let { state, id } = setup();
  let r = gm(state, { t: 'lib.upsert', kind: 'item', entry: { id: 'hb_blade', name: 'Homebrew Blade', slot: 'hands', effects: [{ target: 'toHit', value: 1 }], image: 'https://x.test/a.png' } });
  assert.deepEqual(r.result, { id: 'hb_blade', created: true });
  r = gm(r.state, { t: 'lib.upsert', kind: 'item', entry: { id: 'hb_blade', name: 'Homebrew Blade II', slot: 'hands' } });
  assert.equal(r.result.created, false);
  assert.equal(r.state.library.item[0].name, 'Homebrew Blade II');
  const gen = gm(r.state, { t: 'lib.upsert', kind: 'spell', entry: { name: 'Zap', cost: 'rank' } });
  assert.match(gen.result.id, /^hb_/);
  r = gen;
  assert.throws(() => gm(r.state, { t: 'lib.upsert', kind: 'item', entry: { id: 'sword', name: 'Mine now' } }), /belongs to the pack/);
  assert.throws(() => gm(r.state, { t: 'lib.upsert', kind: 'item', entry: { id: 'x', name: 'X', effects: [{ target: 'evade', value: 'eval(1)' }] } }), /invalid formula/);
  assert.throws(() => gm(r.state, { t: 'lib.upsert', kind: 'potion', entry: { id: 'x', name: 'X' } }), /kind must be/);
  assert.throws(() => gm(r.state, { t: 'lib.upsert', kind: 'item', entry: { id: '__proto__', name: 'X' } }), /id required/);
  assert.throws(() => gm(r.state, { t: 'lib.upsert', kind: 'item', entry: { id: 'x' } }), /name required/);
  assert.throws(() => gm(r.state, { t: 'lib.remove', kind: 'item', id: 'sword' }), /read-only/);
  // give each kind
  r = gm(r.state, { t: 'lib.give', playerId: id, kind: 'item', id: 'hb_blade' });
  r = gm(r.state, { t: 'lib.give', playerId: id, kind: 'spell', id: gen.result.id });
  r = gm(r.state, { t: 'lib.give', playerId: id, kind: 'skill', id: 'blades' });
  r = gm(r.state, { t: 'lib.give', playerId: id, kind: 'buff', id: 'warded' });
  assert.throws(() => gm(r.state, { t: 'lib.give', playerId: id, kind: 'race', id: 'elf' }), /kind must be/);
  const p = r.state.players[0];
  assert.deepEqual([p.inventory[0].itemId, p.sheet.spells[0].spellId, p.sheet.skills[0].skillId, p.sheet.buffs[0].buffId], ['hb_blade', gen.result.id, 'blades', 'warded']);
  // item.give also finds homebrew
  assert.equal(gm(r.state, { t: 'item.give', playerId: id, itemId: 'hb_blade' }).state.players[0].inventory.length, 2);
  // views
  const gv = viewFor(r.state, pack, 'gm', {});
  assert.deepEqual(Object.keys(gv.library).sort(), ['background', 'boss', 'buff', 'class', 'feature', 'item', 'location', 'monster', 'npc', 'race', 'skill', 'spell']);
  assert.equal(gv.library.item.find((x) => x.id === 'hb_blade').source, 'homebrew');
  assert.equal(gv.library.item.find((x) => x.id === 'sword').source, 'pack');
  assert.equal(gv.gm.itemsCatalog.find((x) => x.id === 'hb_blade').source, 'homebrew');
  const pv = viewFor(r.state, pack, 'player', { playerId: id });
  assert.deepEqual(pv.library.item.map((x) => x.id), ['hb_blade']);
  assert.deepEqual(pv.library.spell.map((x) => x.id), [gen.result.id]);
  assert.deepEqual(pv.library.buff.map((x) => x.id), ['warded']);
  assert.deepEqual(pv.library.skill.map((x) => x.id), ['blades', 'sneak'], 'full skills catalog for the builder');
  assert.deepEqual(pv.library.race.map((x) => x.id), ['elf']);
  assert.deepEqual(pv.library.feature.map((x) => x.id), ['keen'], 'features of races/classes');
  assert.equal(pv.me.sheet.inventory[0].source, 'homebrew');
  assert.equal(pv.me.sheet.inventory[0].slot, 'hands');
  // remove homebrew → sheet keeps entry, warns
  r = gm(r.state, { t: 'lib.remove', kind: 'item', id: 'hb_blade' });
  const sh = sheetOf(r.state, id);
  assert.equal(sh.inventory[0].missing, true);
  assert.ok(sh.computed.warnings.some((w) => w.kind === 'missing'));
  // homebrew survives normalizeState
  assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(r.state)), pack).library, r.state.library);
});

// ---------- permissions ----------

test('players act only on themselves; payload playerId / role / actorId cannot be spoofed', () => {
  let { state, ids } = setup(2);
  const [a, b] = ids;
  const ok = pl(state, a, { t: 'sheet.set', path: 'stats.dex', value: 12 });
  assert.deepEqual(ok.state.players[0].sheet.stats.dex.enhanced, 12);
  assert.equal(pl(state, a, { t: 'sheet.set', playerId: a, path: 'stats.dex', value: 12 }).state.players[0].sheet.stats.dex.enhanced, 12);
  assert.throws(() => pl(state, a, { t: 'sheet.set', playerId: b, path: 'stats.dex', value: 1 }), code('forbidden'));
  assert.throws(() => pl(state, a, { t: 'sheet.set', role: 'gm', actorId: b, playerId: b, path: 'stats.dex', value: 1 }), code('forbidden'));
  const spoof = pl(state, a, { t: 'sheet.set', role: 'gm', actorId: b, path: 'stats.dex', value: 3 });
  assert.equal(spoof.state.players[0].sheet.stats.dex.enhanced, 3, 'actorId in payload is ignored');
  assert.equal(spoof.state.players[1].sheet.stats.dex.enhanced, 16);
  for (const t of ['buff.add', 'buff.remove', 'skills.rankUp', 'lib.upsert', 'lib.remove', 'lib.give', 'session.permissions', 'player.add', 'item.give', 'loot.open']) {
    assert.throws(() => pl(state, a, { t, playerId: a }), /unknown action/, t);
  }
  assert.throws(() => reducePlayerAction(state, { t: 'roll' }, ctx()), /playerId required/);
  assert.throws(() => pl(state, 'p_ghost', { t: 'roll', what: { kind: 'stat', id: 'dex' } }), code('not_found'));
  // raw reduce with role player: actor comes from actorId only
  assert.throws(() => reduce(state, { role: 'player', actorId: a, t: 'track.set', playerId: b, track: 'hp', cur: 1 }, ctx()), code('forbidden'));
  // all player-capable actions work on self
  let s = state;
  const step = (act) => {
    const r = pl(s, a, act);
    s = r.state;
    return r;
  };
  step({ t: 'track.set', track: 'hp', delta: -1 });
  const sk = step({ t: 'skill.add', skillId: 'blades' }).result.uid;
  step({ t: 'skill.update', uid: sk, rank: 3 });
  const at = step({ t: 'attack.add', name: 'Punch', dice: '1d4' }).result.uid;
  step({ t: 'attack.update', uid: at, name: 'Big punch' });
  step({ t: 'attack.remove', uid: at });
  const sp = step({ t: 'spell.learn', spellId: 'fireball' }).result.uid;
  step({ t: 'spell.cast', uid: sp });
  step({ t: 'spell.update', uid: sp, active: false });
  step({ t: 'spell.forget', uid: sp });
  step({ t: 'roll', what: { kind: 'skill', uid: sk } });
  step({ t: 'skill.remove', uid: sk });
  step({ t: 'me.notes', text: 'mine' });
  s = gm(s, { t: 'item.give', playerId: a, itemId: 'potion' }).state;
  const pot = s.players[0].inventory[0].uid;
  step({ t: 'hotlist.set', index: 1, uid: pot });
  step({ t: 'item.qty', uid: pot, qty: 2 });
  step({ t: 'item.use', uid: pot });
  s = gm(s, { t: 'item.give', playerId: a, itemId: 'ring' }).state;
  step({ t: 'item.equip', uid: s.players[0].inventory.at(-1).uid, slot: 'accessories' });
  assert.equal(s.players[0].notes, 'mine');
  assert.equal(s.players[1].sheet.tracks.hp.cur, 10, 'other player untouched');
  // a player may not use items / spells on someone else
  assert.throws(() => pl(s, a, { t: 'item.use', uid: pot, target: b }), code('forbidden'));
});

test('session.permissions.playerEdit: none / notes / sheet; GM unaffected; survives session.new', () => {
  let { state, id } = setup();
  assert.throws(() => gm(state, { t: 'session.permissions', playerEdit: 'all' }), /playerEdit/);
  const sk = gm(state, { t: 'skill.add', playerId: id, skillId: 'sneak' });
  state = sk.state;
  const uid = sk.result.uid;
  const notes = gm(state, { t: 'session.permissions', playerEdit: 'notes' }).state;
  assert.equal(viewFor(notes, pack, 'player', { playerId: id }).session.permissions.playerEdit, 'notes');
  assert.throws(() => pl(notes, id, { t: 'sheet.set', path: 'stats.dex', value: 1 }), /locked/);
  assert.throws(() => pl(notes, id, { t: 'skill.update', uid, rank: 4 }), code('forbidden'), 'rank needs sheet');
  assert.throws(() => pl(notes, id, { t: 'spell.learn', spellId: 'haste' }), code('forbidden'));
  assert.throws(() => pl(notes, id, { t: 'item.equip', uid: 'x', slot: null }), code('forbidden'));
  pl(notes, id, { t: 'sheet.set', path: 'story.popularity', value: 'ok' });
  pl(notes, id, { t: 'sheet.set', path: 'fields.popularity', value: 'ok' });
  pl(notes, id, { t: 'skill.update', uid, notes: 'n', used: true });
  pl(notes, id, { t: 'me.notes', text: 'x' });
  pl(notes, id, { t: 'roll', what: { kind: 'stat', id: 'dex' } });
  const none = gm(state, { t: 'session.permissions', playerEdit: 'none' }).state;
  assert.throws(() => pl(none, id, { t: 'sheet.set', path: 'story.notes', value: 'x' }), code('forbidden'));
  assert.throws(() => pl(none, id, { t: 'me.notes', text: 'x' }), code('forbidden'));
  assert.throws(() => pl(none, id, { t: 'skill.update', uid, used: true }), code('forbidden'));
  pl(none, id, { t: 'roll', what: { kind: 'stat', id: 'dex' } });
  gm(none, { t: 'sheet.set', playerId: id, path: 'stats.dex', value: 1 });
  assert.equal(gm(none, { t: 'session.new' }).state.session.permissions.playerEdit, 'none');
});

// ---------- migration / persistence ----------

test('normalizeState migrates v1 players: flat stats, resources, inventory; idempotent', () => {
  const old = {
    room: 'ABCD', gmToken: 't', stageToken: 'u',
    players: [{
      id: 'p_1', name: 'Old', pin: '0000', klass: 'Brawler', race: 'elf', level: 2, notes: 'n',
      stats: { str: 9, dex: { enhanced: 13 }, wis: 4 },
      resources: { hp: { cur: 3, max: 10 }, mp: { cur: 1, max: 5 } },
      inventory: [{ uid: 'i_1', itemId: 'ring', name: 'Ring', desc: '', rarity: 'common', image: null, at: 0 }, { uid: 'i_2', itemId: 'gone', name: 'Gone', at: 0, equippedSlot: 'nope', qty: 4 }],
    }],
  };
  const s = normalizeState(old, pack);
  const p = s.players[0];
  assert.equal(p.stats, undefined);
  assert.equal(p.resources, undefined);
  assert.deepEqual(p.sheet.stats.str, { enhanced: 9, unenhanced: 9 });
  assert.deepEqual(p.sheet.stats.dex, { enhanced: 13, unenhanced: 14 });
  assert.deepEqual(p.sheet.stats.int, { enhanced: 10, unenhanced: 10 });
  assert.equal(p.sheet.stats.wis, 4, 'unknown stats kept');
  assert.deepEqual(p.sheet.tracks.hp, { cur: 3, max: 10 });
  assert.deepEqual(p.sheet.tracks.mana, { cur: 6, max: 6 });
  assert.deepEqual(p.sheet.tracks.mp, { cur: 1, max: 5 });
  assert.deepEqual(p.inventory.map((i) => [i.qty, i.notes, i.equippedSlot]), [[1, '', null], [4, '', null]]);
  assert.deepEqual(p.sheet.hotlist, [null, null, null]);
  assert.deepEqual(s.library.item, []);
  assert.deepEqual(s.rolls, []);
  assert.equal(s.session.permissions.playerEdit, 'sheet');
  const again = normalizeState(JSON.parse(JSON.stringify(s)), pack);
  assert.deepEqual(again.players, s.players);
  const v = viewFor(s, pack, 'player', { playerId: 'p_1' });
  assert.deepEqual(v.me.stats, { str: 9, dex: 13, int: 10 });
  assert.equal(v.me.sheet.identity.class, 'Brawler');
  assert.equal(v.me.sheet.computed.stats.dex.value, 15, 'race elf (by id) +2');
  assert.ok(v.me.sheet.computed.warnings.some((w) => w.ref === 'item:gone'));
});

test('views: me.sheet and gm.playersFull[].sheet = raw + computed; pack.ruleset; legacy fields kept', () => {
  const { state, id } = setup();
  const pv = viewFor(state, pack, 'player', { playerId: id });
  const gv = viewFor(state, pack, 'gm', {});
  assert.deepEqual(gv.gm.playersFull[0].sheet, pv.me.sheet);
  assert.deepEqual(Object.keys(pv.me.sheet).sort(), ['attacks', 'buffs', 'computed', 'fields', 'hotlist', 'identity', 'inventory', 'level', 'name', 'portrait', 'skills', 'spells', 'stats', 'story', 'tracks']);
  assert.deepEqual(Object.keys(pv.me.sheet.computed).sort(), ['attacks', 'buffs', 'derived', 'effects', 'externalBuffs', 'fields', 'skills', 'spells', 'stats', 'tracks', 'warnings']);
  assert.equal(pv.pack.ruleset.id, 'test-rules');
  assert.deepEqual(pv.me.resources, { hp: { cur: 10, max: 10 }, mana: { cur: 6, max: 6 } });
  assert.deepEqual(pv.session.permissions, { playerEdit: 'sheet' });
  assert.deepEqual(pv.rolls, []);
  const sv = viewFor(state, pack, 'stage', {});
  assert.equal(sv.me, undefined);
  assert.deepEqual(sv.library.item, []);
  assert.equal(JSON.stringify(pv).includes(state.gmToken), false);
});

test('serialize / deserialize round-trips ruleset, library and item v2 fields; old embeds still load', () => {
  const { raw } = readPackFiles(writePack(tmpDir(), files()));
  const ser = serializePack(normalizePack(raw).pack);
  const back = deserializePack(JSON.stringify(ser));
  assert.deepEqual(serializePack(back), ser);
  assert.deepEqual(back.ruleset, pack.ruleset);
  assert.deepEqual(back.library, pack.library);
  assert.deepEqual(back.itemsById.get('ring').effects, pack.itemsById.get('ring').effects);
  // the same game works on the deserialized pack
  let st = createState(back, 0);
  st = reduce(st, { role: 'gm', t: 'player.add', name: 'X' }, ctx({ pack: back })).state;
  const pid = st.players[0].id;
  st = reduce(st, { role: 'gm', t: 'spell.learn', playerId: pid, spellId: 'haste' }, ctx({ pack: back })).state;
  assert.equal(viewFor(st, back, 'player', { playerId: pid }).me.sheet.computed.spells[0].cost.value, 2);
  // pre-v2 serialized pack (no ruleset / library keys, v1 items)
  const old = { ...ser };
  delete old.ruleset;
  delete old.library;
  old.items = old.items.map(({ id, name, desc, flavor, rarity, image }) => ({ id, name, desc, flavor, rarity, image }));
  const legacy = deserializePack(old);
  assert.deepEqual(legacy.ruleset.stats.map((s) => s.id), ser.stats.map((s) => s.id));
  assert.deepEqual(legacy.library.spell, []);
  assert.equal(legacy.itemsById.get('ring').slot, null);
});

test('demo pack: ruleset, spells, buffs and item effects load cleanly', () => {
  const { pack: demo, warnings } = loadPack(path.join(here, '..', '..', 'packs', 'demo'));
  assert.deepEqual(warnings.filter((w) => !w.includes('not found')), []);
  assert.equal(demo.ruleset.id, 'demo-generic');
  assert.equal(demo.library.spell.length, 3);
  assert.ok(demo.items.filter((i) => i.effects.length).length >= 3);
  let st = createState(demo, 0);
  const c = (x) => ctx({ pack: demo, ...x });
  st = reduce(st, { role: 'gm', t: 'player.add', name: 'Demo' }, c()).state;
  const pid = st.players[0].id;
  const give = reduce(st, { role: 'gm', t: 'item.give', playerId: pid, itemId: 'mostly_invisible_cloak' }, c());
  st = reduce(give.state, { role: 'gm', t: 'item.equip', playerId: pid, uid: give.result.uid, slot: 'body' }, c()).state;
  const sh = viewFor(st, demo, 'player', { playerId: pid }).me.sheet;
  assert.equal(sh.computed.derived.defense.value, 11);
  assert.deepEqual(sh.computed.warnings.filter((w) => w.kind !== 'unverified'), []);
});

const DCC = '/home/claude/dcc-ai-private/packs/dcc';
test('private DCC pack (skipped when absent): sheet model works end to end', { skip: !fs.existsSync(path.join(DCC, 'ruleset.json')) && 'private pack not present' }, () => {
  const { pack: dcc, warnings } = loadPack(DCC);
  assert.deepEqual(warnings.filter((w) => !w.includes('not found')), []);
  const c = (x) => ctx({ pack: dcc, ...x });
  const g = (st, a, x) => reduce(st, { role: 'gm', ...a }, c(x));
  let st = g(createState(dcc, 0), { t: 'player.add', name: 'Carl' }).state;
  const pid = st.players[0].id;
  st = g(st, { t: 'sheet.set', playerId: pid, path: 'identity.race', value: 'baseline_human' }).state;
  st = g(st, { t: 'lib.give', playerId: pid, kind: 'skill', id: 'improvised_weapons', rank: 3 }).state;
  const skUid = st.players[0].sheet.skills[0].uid;
  st = g(st, { t: 'attack.add', playerId: pid, name: 'Crowbar', skillUid: skUid, stat: 'str', dice: '1d6' }).state;
  const items = [];
  for (let i = 0; i < 3; i++) {
    const r = g(st, { t: 'item.give', playerId: pid, itemId: 'bent_crowbar' });
    st = r.state;
    items.push(r.result.uid);
  }
  st = g(st, { t: 'item.equip', playerId: pid, uid: items[0], slot: 'hands' }).state;
  st = g(st, { t: 'item.equip', playerId: pid, uid: items[1], slot: 'hands' }).state;
  assert.throws(() => g(st, { t: 'item.equip', playerId: pid, uid: items[2], slot: 'hands' }), /max 2/);
  const sh = viewFor(st, dcc, 'player', { playerId: pid }).me.sheet;
  const cs = sh.computed;
  assert.equal(cs.stats.str.mod.value, 0);
  assert.ok(cs.stats.str.mod.warnings.some((w) => w.kind === 'unverified'));
  assert.equal(cs.attacks[0].damage, '1d6');
  assert.equal(cs.attacks[0].toHit.value, 3);
  assert.equal(cs.tracks.hp.max, 10);
  assert.equal(cs.tracks.mana.max, 5);
  assert.ok(cs.effects.some((e) => e.source.kind === 'feature'), 'race features apply');
  // spell with applies + item.use with heal
  const spell = dcc.library.spell.find((s) => s.applies && dcc.library.buff.find((b) => b.id === s.applies && !(b.tags ?? []).includes('debuff')));
  if (spell) {
    st = g(st, { t: 'spell.learn', playerId: pid, spellId: spell.id }).state;
    const cast = g(st, { t: 'spell.cast', playerId: pid, uid: st.players[0].sheet.spells[0].uid });
    assert.equal(cast.result.applied.buffId, spell.applies);
  }
  st = g(st, { t: 'track.set', playerId: pid, track: 'hp', cur: 5 }).state;
  const bandage = g(st, { t: 'item.give', playerId: pid, itemId: 'bandage_roll' });
  const used = g(bandage.state, { t: 'item.use', playerId: pid, uid: bandage.result.uid });
  assert.equal(used.result.healed.to, 7);
  // rank-up uses amount and the pack rule
  st = used.state;
  st.players[0].sheet.skills[0].used = true;
  const ru = g(st, { t: 'skills.rankUp' }, { rollInt: () => 10 });
  assert.deepEqual(ru.result.results.map((x) => [x.roll, x.target, x.success, x.to]), [[11, 3, true, 4]]);
});
