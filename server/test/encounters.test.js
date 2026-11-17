// encounters.js: prepared encounters (built in Prep, never touching the live fight), map tokens placed in
// prep and bound to the combatants when the encounter runs; map strokes; prep links / encounter refs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { createState, reduce, viewFor } from '../state.js';
import { tmpDir, writePack, seq } from './fixtures.js';

const MONSTERS = [
  { id: 'goblin', name: 'Goblin', floor: 1, hpSlots: 3, attacks: [{ name: 'Stab', toHit: 2, damage: '1d4' }] },
  { id: 'rat', name: 'Rat', floor: 1, hpSlots: 1 },
];
const BOSSES = [{ id: 'porter', name: 'Porter Grim', hpSlots: 20 }];
const { pack } = loadPack(writePack(tmpDir(), { 'monsters.json': MONSTERS, 'bosses.json': BOSSES }));
let n = 0;
const ctx = () => ({ now: 5000, rng: seq(0.5), genId: (p) => `${p}_${++n}`, pack });
const gm = (s, a) => reduce(s, { role: 'gm', ...a }, ctx());

function setup() {
  let s = createState(pack, 0);
  s = gm(s, { t: 'player.add', name: 'Carl' }).state;
  s = gm(s, { t: 'player.add', name: 'Donut' }).state;
  const r = gm(s, { t: 'map.add', name: 'Alley', image: '/pack/maps/alley.webp', aspect: 1.5 });
  return { s: r.state, mapId: r.result.id };
}

test('enc.save builds an encounter without touching the fight; validation; update moves tokens with the map', () => {
  let { s, mapId } = setup();
  assert.throws(() => gm(s, { t: 'enc.save', label: '', mobs: [] }), /label/);
  assert.throws(() => gm(s, { t: 'enc.save', label: 'X', mobs: [{ sourceId: 'goblin', count: 0 }] }), /count/);
  assert.throws(() => gm(s, { t: 'enc.save', label: 'X', mobs: [], mapId: 'nope' }), /no map/);
  let r = gm(s, { t: 'enc.save', label: 'Alley ambush', mobs: [{ sourceId: 'goblin', count: 3 }, { kind: 'boss', sourceId: 'porter', hidden: false }], mapId, notes: 'They flee at half.' });
  const id = r.result.id;
  s = r.state;
  assert.equal(s.combat.combatants.filter((x) => x.type === 'mob').length, 0, 'prep never adds to the live fight');
  const card = s.prepCards.find((c) => c.id === id);
  assert.equal(card.kind, 'encounter');
  assert.deepEqual(card.payload.mobs[0], { kind: 'monster', sourceId: 'goblin', count: 3, hidden: true });
  assert.equal(card.payload.mobs[1].hidden, false);
  s = gm(s, { t: 'enc.tokens', id, party: true }).state;
  let m = s.maps.list[0];
  assert.deepEqual(m.tokens.filter((t) => t.enc === id).map((t) => [t.label, t.hidden, t.slot]), [['Goblin 1', true, 0], ['Goblin 2', true, 1], ['Goblin 3', true, 2], ['Porter Grim', false, 3]]);
  assert.equal(m.tokens.filter((t) => t.kind === 'pc').length, 2, 'party start tokens');
  // Move one, then shrink the encounter: positions kept, surplus token gone.
  const g1 = m.tokens.find((t) => t.slot === 0);
  s = gm(s, { t: 'map.token.move', id: mapId, tokenId: g1.id, x: 0.1, y: 0.2 }).state;
  s = gm(s, { t: 'enc.save', id, label: 'Alley ambush', mobs: [{ sourceId: 'goblin', count: 2 }], mapId }).state;
  s = gm(s, { t: 'enc.tokens', id }).state;
  m = s.maps.list[0];
  assert.deepEqual(m.tokens.filter((t) => t.enc === id).map((t) => [t.label, t.x, t.y].slice(0, 1)), [['Goblin 1'], ['Goblin 2']]);
  assert.equal(m.tokens.find((t) => t.slot === 0).x, 0.1);
  // Map removed from the encounter: its tokens go.
  s = gm(s, { t: 'enc.save', id, label: 'Alley ambush', mobs: [{ sourceId: 'goblin', count: 2 }] }).state;
  assert.equal(s.maps.list[0].tokens.filter((t) => t.enc === id).length, 0);
  assert.throws(() => gm(s, { t: 'enc.tokens', id }), /no map/);
});

test('enc.run: mobs into the fight (hidden as prepared), tokens bound, reveal / death show on the map, start', () => {
  let { s, mapId } = setup();
  let r = gm(s, { t: 'enc.save', label: 'Rats', mobs: [{ sourceId: 'rat', count: 2 }, { sourceId: 'ghost', count: 1 }, { sourceId: 'goblin', hidden: false }], mapId });
  const id = r.result.id;
  s = gm(r.state, { t: 'enc.tokens', id }).state;
  r = gm(s, { t: 'enc.run', id, start: true });
  s = r.state;
  assert.deepEqual(r.result.skipped, ['ghost']);
  assert.equal(r.result.uids.length, 3);
  assert.equal(s.combat.active, true);
  const mobs = s.combat.combatants.filter((x) => x.type === 'mob');
  assert.deepEqual(mobs.map((x) => [x.name, x.hidden]), [['Rat 1', true], ['Rat 2', true], ['Goblin', false]]);
  const toks = s.maps.list[0].tokens;
  assert.equal(toks.find((t) => t.slot === 0).ref, mobs[0].uid);
  assert.equal(toks.find((t) => t.slot === 2).ref, null, 'the missing ghost has no combatant');
  assert.equal(toks.find((t) => t.slot === 3).ref, mobs[2].uid);
  assert.equal(s.prepCards.find((c) => c.id === id).used, true);
  // TV shows the map: hidden rats invisible, goblin visible; reveal rat 1, kill it.
  s = gm(s, { t: 'scene.set', kind: 'map', data: { mapId } }).state;
  const tvToks = () => viewFor(s, pack, 'stage', { now: 0 }).maps[0].tokens.filter((t) => t.kind === 'mob');
  assert.deepEqual(tvToks().map((t) => t.label), ['Goblin']);
  s = gm(s, { t: 'combat.reveal', uid: mobs[0].uid }).state;
  assert.deepEqual(tvToks().map((t) => t.label).sort(), ['Goblin', 'Rat 1']);
  s = gm(s, { t: 'combat.remove', uid: mobs[0].uid }).state;
  assert.equal(viewFor(s, pack, 'gm', { now: 0 }).maps[0].tokens.find((t) => t.slot === 0).down, true);
});

test('map strokes: pen drawings, GM-only ones stay off the TV; erase', () => {
  let { s, mapId } = setup();
  assert.throws(() => gm(s, { t: 'map.stroke.add', id: mapId, pts: [[0, 0]] }), /2 points/);
  let r = gm(s, { t: 'map.stroke.add', id: mapId, pts: [[0, 0], [0.5, 0.5], [2, 0.5]], color: '#ff0000' });
  s = r.state;
  s = gm(s, { t: 'map.stroke.add', id: mapId, pts: [[0.1, 0.1], [0.2, 0.2]], gm: true }).state;
  assert.deepEqual(s.maps.list[0].strokes[0].pts[2], [1, 0.5], 'clamped');
  s = gm(s, { t: 'scene.set', kind: 'map', data: { mapId } }).state;
  assert.equal(viewFor(s, pack, 'stage', { now: 0 }).maps[0].strokes.length, 1);
  s = gm(s, { t: 'map.stroke.remove', id: mapId, strokeId: r.result.strokeId }).state;
  assert.equal(s.maps.list[0].strokes.length, 1);
  s = gm(s, { t: 'map.stroke.remove', id: mapId, all: true }).state;
  assert.equal(s.maps.list[0].strokes.length, 0);
});

test('prep: encounter refs in monster sections, links on scenes', () => {
  let { s } = setup();
  let r = gm(s, { t: 'enc.save', label: 'Rats', mobs: [{ sourceId: 'rat' }] });
  const encId = r.result.id;
  r = gm(r.state, { t: 'prep.session.add' });
  const doc = r.result.id;
  s = r.state;
  const d = s.prep.docs.find((x) => x.id === doc);
  const mons = d.sections.find((x) => x.refKinds.includes('monster'));
  assert.ok(mons.refKinds.includes('encounter'));
  s = gm(s, { t: 'prep.item.add', id: doc, key: mons.key, ref: { kind: 'encounter', id: encId } }).state;
  r = gm(s, { t: 'prep.item.add', id: doc, key: 'scenes', title: 'Alley', links: [{ kind: 'encounter', id: encId }, { kind: 'encounter', id: encId }, { kind: 'npc', id: 'quill' }] });
  s = r.state;
  const it = s.prep.docs.find((x) => x.id === doc).sections.find((x) => x.key === 'scenes').items[0];
  assert.deepEqual(it.links, [{ kind: 'encounter', id: encId }, { kind: 'npc', id: 'quill' }]);
  assert.throws(() => gm(s, { t: 'prep.item.update', id: doc, key: 'scenes', itemId: it.id, links: [{ kind: 'nope', id: 'x' }] }), /links/);
  s = gm(s, { t: 'enc.remove', id: encId }).state;
  assert.equal(s.prepCards.length, 0);
});

test('encounter items: saved with the encounter, handed out from the fight, "given" survives edits', () => {
  const ITEMS = [{ id: 'duck', name: 'Rubber Duck' }, { id: 'key', name: 'Rusty Key' }];
  const { pack: p2 } = loadPack(writePack(tmpDir(), { 'monsters.json': MONSTERS, 'items.json': ITEMS }));
  const c2 = () => ({ now: 5000, rng: seq(0.5), genId: (p) => `${p}_${++n}`, pack: p2 });
  const g = (s, a) => reduce(s, { role: 'gm', ...a }, c2());
  let s = createState(p2, 0);
  let r = g(s, { t: 'player.add', name: 'Carl' });
  const carl = r.result.id ?? r.state.players[0].id;
  s = r.state;
  assert.throws(() => g(s, { t: 'enc.save', label: 'X', mobs: [], items: [{ id: 'duck', qty: 0 }] }), /qty/);
  r = g(s, { t: 'enc.save', label: 'Rats', mobs: [{ sourceId: 'rat' }], items: [{ id: 'duck', qty: 2 }, { id: 'key' }] });
  const id = r.result.id;
  s = g(r.state, { t: 'enc.give', id, index: 0, playerId: carl }).state;
  const pl = s.players.find((x) => x.id === carl);
  assert.ok(pl.inventory.some((x) => x.itemId === 'duck' && x.qty === 2), 'Carl got 2 ducks');
  assert.equal(s.prepCards[0].payload.items[0].given, carl);
  s = g(s, { t: 'enc.save', id, label: 'Rats', mobs: [{ sourceId: 'rat' }], items: [{ id: 'key' }, { id: 'duck', qty: 2 }] }).state;
  assert.deepEqual(s.prepCards[0].payload.items.map((x) => [x.id, x.given ?? null]), [['key', null], ['duck', carl]]);
  s = g(s, { t: 'enc.save', id, label: 'Renamed', mobs: [{ sourceId: 'rat' }] }).state;
  assert.equal(s.prepCards[0].payload.items.length, 2, 'items kept when not sent');
});

test('play clock: gaps under 15 min count, breaks do not; level.party levels everyone and resets the reminder; snooze', () => {
  let { s } = setup();
  const at = (t, a) => reduce(s, { role: 'gm', ...a }, { now: t, rng: seq(0.5), genId: (p) => `${p}_${++n}`, pack }).state;
  s = at(1_000_000, { t: 'map.update', id: s.maps.list[0].id, name: 'A' });
  s = at(1_000_000 + 10 * 60_000, { t: 'map.update', id: s.maps.list[0].id, name: 'B' });
  s = at(1_000_000 + 10 * 60_000 + 60 * 60_000, { t: 'map.update', id: s.maps.list[0].id, name: 'C' }); // an hour's break
  assert.equal(Math.round(s.session.playMs / 60_000), 10);
  const v = viewFor(s, pack, 'gm', { now: 0 });
  assert.deepEqual(v.gm.playClock, { playMin: 10, sinceLevelMin: 10, snoozeMin: null });
  s = at(2_000_000_0, { t: 'level.snooze', minutes: 30 });
  assert.equal(Math.round(s.session.levelSnoozeMs / 60_000), 40);
  const before = s.players.map((p) => p.sheet.identity?.level ?? p.level ?? 1);
  s = at(2_000_000_1, { t: 'level.party' });
  assert.deepEqual(s.players.map((p) => p.sheet.identity.level), before.map((x) => x + 1));
  assert.equal(viewFor(s, pack, 'gm', { now: 0 }).gm.playClock.sinceLevelMin, 0);
});

test('floor clock: set, advance in game hours, hide from the TV, refill on collapse', () => {
  let { s } = setup();
  const g = (a) => (s = gm(s, a).state);
  g({ t: 'crawlers.clock', hours: 150, shown: true });
  g({ t: 'crawlers.clock', advance: 8 });
  assert.equal(s.crawlers.clock.hours, 142);
  assert.throws(() => gm(s, { t: 'crawlers.clock', advance: -1 }), /advance/);
  assert.equal(viewFor(s, pack, 'stage', { now: 0 }).crawlers.clock.hours, 142);
  g({ t: 'crawlers.clock', shown: false });
  assert.equal(viewFor(s, pack, 'stage', { now: 0 }).crawlers.clock, null, 'hidden from the TV');
  assert.equal(viewFor(s, pack, 'gm', { now: 0 }).crawlers.clock.hours, 142, 'the GM still sees it');
  const r = gm(s, { t: 'crawlers.clock', advance: 500 });
  assert.equal(r.state.crawlers.clock.hours, 0);
  assert.ok(r.events.some((e) => e.event.kind === 'floor.timeup'));
});
