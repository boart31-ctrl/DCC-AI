// maps.js: maps with fog of war — zones, brush reveal, role-filtered views, tokens (GM + own token for players),
// TV scene kind `map`, normalize.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { createState, normalizeState, reduce, reducePlayerAction, viewFor } from '../state.js';
import { decodeFog, cellOn, FOG_COLS, fogRows, normalizeMaps } from '../maps.js';
import { tmpDir, writePack, seq } from './fixtures.js';

const { pack } = loadPack(writePack(tmpDir()));
let n = 0;
const ctx = () => ({ now: 1000, rng: seq(0.5), genId: (p) => `${p}_${++n}`, pack });
const gm = (s, a) => reduce(s, { role: 'gm', ...a }, ctx());
const run = (s, ...as) => as.reduce((x, a) => gm(x, a).state, s);

function withPlayers() {
  let s = createState(pack, 0);
  s = gm(s, { t: 'player.add', name: 'Carl' }).state;
  s = gm(s, { t: 'player.add', name: 'Donut' }).state;
  return s;
}

test('map + zones: add, reveal, fog brush, cover all', () => {
  let s = createState(pack, 0);
  assert.throws(() => gm(s, { t: 'map.add', name: 'X', image: 'javascript:alert(1)' }), /https/);
  let r = gm(s, { t: 'map.add', name: 'Bogbricks', image: '/pack/maps/bog.webp', aspect: 2 });
  const id = r.result.id;
  s = r.state;
  const m0 = s.maps.list[0];
  assert.equal(m0.cols, FOG_COLS);
  assert.equal(m0.rows, fogRows(2));
  r = gm(s, { t: 'map.zone.add', id, name: 'Market', shape: { x: 0.6, y: 0.5, w: -0.2, h: 0.2 }, notes: 'Trap under the stall' });
  s = r.state;
  const z = s.maps.list[0].zones[0];
  assert.deepEqual(z.shape, { x: 0.4, y: 0.5, w: 0.2, h: 0.2 }, 'negative drag normalized');
  assert.throws(() => gm(s, { t: 'map.zone.add', id, name: 'Tiny', shape: { x: 0, y: 0, w: 0.001, h: 0.5 } }), /too small/);
  s = run(s, { t: 'map.zone.add', id, name: 'Well', shape: { points: [[0.1, 0.1], [0.2, 0.1], [0.15, 0.2]] } });
  s = gm(s, { t: 'map.zone.reveal', id, zoneId: z.id }).state;
  assert.equal(s.maps.list[0].zones[0].revealed, true);
  s = gm(s, { t: 'map.fog', id, rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, reveal: true }).state;
  const m = s.maps.list[0];
  const bits = decodeFog(m.fog, m.cols, m.rows);
  assert.equal(cellOn(bits, m.cols, 0, 0), true);
  assert.equal(cellOn(bits, m.cols, m.cols - 1, m.rows - 1), false);
  s = gm(s, { t: 'map.fog', id, all: false }).state;
  assert.ok(s.maps.list[0].zones.every((x) => !x.revealed), 'cover all hides zones too');
  assert.equal(cellOn(decodeFog(s.maps.list[0].fog, m.cols, m.rows), m.cols, 0, 0), false);
});

test('views: GM full; TV only the map on air; phones only shared maps; no notes, no unrevealed zones', () => {
  let s = createState(pack, 0);
  let r = gm(s, { t: 'map.add', name: 'A', image: 'https://x.test/a.png' });
  const a = r.result.id;
  r = gm(r.state, { t: 'map.add', name: 'B', image: 'https://x.test/b.png' });
  const b = r.result.id;
  s = r.state;
  r = gm(s, { t: 'map.zone.add', id: a, name: 'Seen', shape: { x: 0, y: 0, w: 0.5, h: 0.5 }, text: 'A fountain', notes: 'SECRET-NOTE' });
  s = run(r.state,
    { t: 'map.zone.add', id: a, name: 'HiddenRoom', shape: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } },
    { t: 'map.zone.reveal', id: a, zoneId: r.result.zoneId });
  assert.equal(viewFor(s, pack, 'gm', { now: 0 }).maps.length, 2);
  assert.deepEqual(viewFor(s, pack, 'stage', { now: 0 }).maps, [], 'nothing on air');
  assert.deepEqual(viewFor(s, pack, 'player', { now: 0 }).maps, [], 'nothing shared');
  s = gm(s, { t: 'scene.set', kind: 'map', data: { mapId: a } }).state;
  s = gm(s, { t: 'map.update', id: b, phones: true }).state;
  const tv = viewFor(s, pack, 'stage', { now: 0 }).maps;
  assert.deepEqual(tv.map((m) => m.id), [a]);
  assert.deepEqual(tv[0].zones.map((z) => z.name), ['Seen']);
  const json = JSON.stringify(tv);
  assert.ok(!json.includes('SECRET-NOTE') && !json.includes('HiddenRoom'));
  assert.deepEqual(viewFor(s, pack, 'player', { now: 0 }).maps.map((m) => m.id).sort(), [a, b].sort(), 'shared + on air');
  assert.throws(() => gm(s, { t: 'scene.set', kind: 'map', data: { mapId: '../x' } }), /map id/);
});

test('GM camera clamps to the map, persists on reload and mirrors the TV only', () => {
  let { state, result: { id } } = gm(withPlayers(), { t: 'map.add', name: 'Gallery', image: '/pack/maps/gallery.webp' });
  assert.equal(state.maps.list[0].camera, undefined);
  assert.throws(() => gm(state, { t: 'map.camera', id, zoom: 5 }), /zoom/);
  assert.throws(() => gm(state, { t: 'map.camera', id, zoom: 2, x: '0.5' }), /x must be a number/);
  const playerId = state.players[0].id;
  assert.throws(() => reducePlayerAction(state, { t: 'map.camera', id, zoom: 2 }, { ...ctx(), playerId }), /unknown|not allowed|forbidden/i);
  state = run(state, { t: 'map.update', id, phones: true }, { t: 'map.camera', id, zoom: 2, x: 0, y: 1 });
  const camera = { zoom: 2, x: 0.25, y: 0.75 };
  assert.deepEqual(state.maps.list[0].camera, camera);
  assert.deepEqual(viewFor(state, pack, 'stage', { now: 0 }).maps, []);

  state = normalizeState(state, pack, 0);
  state = run(state, { t: 'scene.set', kind: 'map', data: { mapId: id } });
  assert.deepEqual(viewFor(state, pack, 'gm', { now: 0 }).maps[0].camera, camera);
  assert.deepEqual(viewFor(state, pack, 'stage', { now: 0 }).maps[0].camera, camera);
  assert.equal(viewFor(state, pack, 'player', { now: 0, playerId }).maps[0].camera, undefined);
  state = run(state, { t: 'map.camera', id, zoom: 1 });
  assert.equal(viewFor(state, pack, 'stage', { now: 0 }).maps[0].camera, undefined);
});

test('tokens: GM adds party and mobs; players move only their own, only on a map they can see; hidden mobs stay hidden', () => {
  let s = withPlayers();
  const [carl, donut] = s.players;
  let r = gm(s, { t: 'map.add', name: 'A', image: 'https://x.test/a.png' });
  const id = r.result.id;
  s = gm(r.state, { t: 'map.token.party', id }).state;
  assert.equal(s.maps.list[0].tokens.length, 2);
  assert.throws(() => gm(s, { t: 'map.token.add', id, kind: 'pc', ref: carl.id }), /already has a token/);
  r = gm(s, { t: 'map.token.add', id, kind: 'mob', label: 'Goblin' });
  s = r.state;
  const goblin = r.result.tokenId;
  assert.equal(s.maps.list[0].tokens.find((t) => t.id === goblin).hidden, true, 'mobs start hidden');
  const carlTok = s.maps.list[0].tokens.find((t) => t.ref === carl.id);
  const donutTok = s.maps.list[0].tokens.find((t) => t.ref === donut.id);
  const player = (st, pid, a) => reducePlayerAction(st, a, { ...ctx(), playerId: pid });
  assert.throws(() => player(s, carl.id, { t: 'map.token.move', id, tokenId: carlTok.id, x: 0.3, y: 0.3 }), /not shared with you/);
  s = run(s, { t: 'map.update', id, phones: true });
  s = player(s, carl.id, { t: 'map.token.move', id, tokenId: carlTok.id, x: 0.3, y: 1.7 }).state;
  assert.deepEqual([s.maps.list[0].tokens.find((t) => t.id === carlTok.id).x, s.maps.list[0].tokens.find((t) => t.id === carlTok.id).y], [0.3, 1]);
  assert.throws(() => player(s, carl.id, { t: 'map.token.move', id, tokenId: donutTok.id, x: 0.1, y: 0.1 }), /your own token/);
  assert.throws(() => player(s, carl.id, { t: 'map.token.move', id, tokenId: goblin, x: 0.1, y: 0.1 }), /your own token/);
  const pv = viewFor(s, pack, 'player', { now: 0, playerId: carl.id }).maps[0];
  assert.deepEqual(pv.tokens.map((t) => t.label).sort(), ['Carl', 'Donut']);
  s = gm(s, { t: 'map.token.update', id, tokenId: goblin, hidden: false }).state;
  assert.equal(viewFor(s, pack, 'player', { now: 0, playerId: carl.id }).maps[0].tokens.length, 3);
});

test('tokens: a crawler with no figure on a shared map puts one there by moving it; fights allow it in the action phase only', () => {
  let s = withPlayers();
  const [carl] = s.players;
  const added = gm(s, { t: 'map.add', name: 'B', image: 'https://x.test/b.png' });
  const id = added.result.id;
  s = gm(added.state, { t: 'scene.set', kind: 'map', data: { mapId: id } }).state;
  const player = (st, pid, a) => reducePlayerAction(st, a, { ...ctx(), playerId: pid });
  s = player(s, carl.id, { t: 'map.token.move', id, x: 0.2, y: 0.4 }).state;
  const mine = s.maps.list.find((m) => m.id === id).tokens.filter((t) => t.ref === carl.id);
  assert.equal(mine.length, 1);
  assert.deepEqual([mine[0].x, mine[0].y], [0.2, 0.4]);
  s = player(s, carl.id, { t: 'map.token.move', id, x: 0.6, y: 0.6 }).state;
  assert.equal(s.maps.list.find((m) => m.id === id).tokens.filter((t) => t.ref === carl.id).length, 1, 'no second figure');
  const fight = structuredClone(s);
  fight.combat = { ...fight.combat, active: true, id: 'cb1', rx: { combatId: 'cb1', step: 'declare' } };
  assert.throws(() => player(fight, carl.id, { t: 'map.token.move', id, x: 0.1, y: 0.1 }), /action phase/);
  fight.combat.rx.step = 'act';
  assert.equal(player(fight, carl.id, { t: 'map.token.move', id, x: 0.1, y: 0.1 }).state.maps.list.find((m) => m.id === id).tokens.find((t) => t.ref === carl.id).x, 0.1);
});

test('normalize: junk dropped, invalid fog dimensions reset and missing image kept empty', () => {
  const raw = { list: [{ id: 'm1', name: 'A', image: 'javascript:x', aspect: 9, rows: 3, cols: 48, fog: '!!', zones: [{ id: 'z', shape: { x: 0, y: 0, w: 0.5, h: 0.5 }, revealed: true }, { id: 'bad' }], tokens: [{ id: 't', kind: 'nope' }] }, { nope: true }] };
  const out = normalizeMaps(raw);
  assert.equal(out.list.length, 1);
  assert.equal(out.list[0].image, '');
  assert.equal(out.list[0].aspect, 1.5);
  assert.equal(out.list[0].zones.length, 1);
  assert.equal(out.list[0].tokens.length, 0);
  const st = normalizeState({ ...createState(pack, 0), maps: raw }, pack, 0);
  assert.equal(st.maps.list.length, 1);
});

test('replacing a map picture keeps brush fog, normalized geometry and tokens while dropping stale art', () => {
  const added = gm(withPlayers(), {
    t: 'map.add', name: 'Raster', image: '/pack/maps/new.webp', fallbackImage: '/pack/maps/old.svg', aspect: 16 / 9,
    mobStarts: [[0.22, 0.33]],
  });
  const { id } = added.result;
  let s = run(added.state,
    { t: 'map.zone.add', id, name: 'Room', shape: { points: [[0.1, 0.1], [0.5, 0.1], [0.3, 0.6]] } },
    { t: 'map.token.party', id },
    { t: 'map.stroke.add', id, pts: [[0.16, 0.19], [0.22, 0.27]], gm: true },
    { t: 'map.fog', id, rect: { x: 0.15, y: 0.2, w: 0.2, h: 0.2 } },
    { t: 'map.zone.reveal', id, zoneId: '0', on: false },
    { t: 'scene.set', kind: 'map', data: { mapId: id } });
  const before = s.maps.list[0];
  for (const role of ['player', 'stage']) {
    const m = viewFor(s, pack, role).maps[0];
    assert.equal(m.fallbackImage, '/pack/maps/old.svg');
    assert.equal(m.mobStarts, undefined);
  }
  s = gm(s, { t: 'map.update', id, image: '/art/upload.webp', aspect: 0.8 }).state;
  const after = s.maps.list[0];
  assert.equal(after.fallbackImage, undefined);
  assert.equal(after.aspect, 0.8);
  assert.equal(after.rows, fogRows(0.8));
  assert.equal(after.zoneZero, false);
  assert.deepEqual(after.tokens, before.tokens);
  assert.deepEqual(after.zones, before.zones);
  assert.deepEqual(after.strokes, before.strokes);
  const bits = decodeFog(after.fog, after.cols, after.rows);
  assert.equal(cellOn(bits, after.cols, Math.floor(0.25 * after.cols), Math.floor(0.3 * after.rows)), true);
  assert.equal(cellOn(bits, after.cols, 0, after.rows - 1), false);
  assert.equal(viewFor(s, pack, 'stage').maps[0].fallbackImage, undefined);
  assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(s)), pack, 0).maps, s.maps);
});
