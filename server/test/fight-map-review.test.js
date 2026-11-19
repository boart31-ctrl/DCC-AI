import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startServer } from '../index.js';
import { createState, normalizeState, reduce, viewFor } from '../state.js';
import { loadPack } from '../pack.js';
import { cellOn, decodeFog } from '../maps.js';
import { tmpDir, writePack } from './fixtures.js';
import { samplePng } from './content-fixture.js';

const packDir = writePack(tmpDir(), {
  'ruleset.json': {
    id: 'table', dice: 'd20',
    stats: [{ id: 'con', label: 'Constitution', parts: ['base'], default: { base: 6 } }],
    statMod: { from: 'base', formula: 'x' },
    tracks: [{ id: 'hp', label: 'Health', kind: 'slots', default: 10, slotValue: 'mod.con' }],
    combat: { injuries: { minor: 'minor', major: 'major', minorLong: 'minor_long', majorLong: 'major_long',
      minorDescriptions: ['Bruised thumb', 'Twisted ankle'], majorDescriptions: ['Fractured leg'] } },
  },
  'monsters.json': [{ id: 'beetle', name: 'Beetle', hpSlots: 2, lootItems: ['duck'], image: 'duck.webp', variants: ['alt.webp'] }],
  'buffs.json': ['minor', 'major', 'minor_long', 'major_long'].map((id) => ({ id, name: id, desc: 'Mechanical effect' })),
});
fs.writeFileSync(path.join(packDir, 'images', 'alt.webp'), 'test art');
const { pack } = loadPack(packDir);

function setup() {
  let s = createState(pack, 0);
  let n = 0;
  const act = (a) => {
    const r = reduce(s, { role: 'gm', ...a }, { pack, now: 1000, rollInt: () => 14, rng: () => 0.4, genId: (p) => `${p}_${++n}` });
    s = r.state;
    return r.result;
  };
  return { act, state: () => s, view: (role = 'gm') => viewFor(s, pack, role) };
}

test('raw and automatic damage use all ten Constitution slots and discard the remainder', () => {
  const { act, view } = setup();
  act({ t: 'player.add', name: 'Runner' });
  const { uids: [mob] } = act({ t: 'combat.addAdhoc', name: 'Guard', hp: 4, hidden: false,
    attacks: [{ name: 'Light', toHit: 50, damage: '4' }, { name: 'Heavy', toHit: 50, damage: '7' }] });
  act({ t: 'combat.start' });
  const row = () => view().combat.combatants.find((x) => x.type === 'crawler');
  assert.equal(row().slotValue, 6);
  assert.equal(row().hpMax, 10);
  const targetUid = row().uid;
  const light = act({ t: 'combat.mobAct', uid: mob, targetUid, attackIndex: 0, tv: false }).sequence[0];
  assert.equal(light.damageAfterDr, 4);
  assert.equal(light.damage, 0);
  assert.equal(row().hp, 10);
  assert.equal(act({ t: 'combat.mobAct', uid: mob, targetUid, attackIndex: 1, tv: false }).sequence[0].damage, 1);
  assert.equal(row().hp, 9);
  assert.equal(act({ t: 'combat.damage', uid: targetUid, dr: true, amount: 4 }).belowSlot, true);
  act({ t: 'combat.damage', uid: targetUid, dr: true, amount: 7 });
  assert.equal(row().hp, 8);
});

test('injury narratives vary by severity and persist in the original debuffs', () => {
  const { act, view, state } = setup();
  act({ t: 'player.add', name: 'Runner' });
  act({ t: 'combat.start' });
  const { uid } = view().combat.combatants[0];
  for (const severity of ['minor', 'minor', 'major']) act({ t: 'combat.injury', uid, severity });
  assert.deepEqual(view().combat.combatants[0].pendingInjuries.map((x) => x.desc), ['Bruised thumb', 'Twisted ankle', 'Fractured leg']);
  act({ t: 'combat.end', outcome: 'truce' });
  const restored = normalizeState(state(), pack);
  assert.deepEqual(restored.players[0].sheet.buffs.map((b) => [b.buffId, b.desc]),
    [['minor_long', 'Twisted ankle Mechanical effect'], ['major', 'Fractured leg Mechanical effect']]);
});

test('linked tokens follow the same combatants, reveal, images and saved positions', () => {
  const { act, view, state } = setup();
  act({ t: 'player.add', name: 'Runner' });
  const { id } = act({ t: 'map.add', name: 'Room', image: '/pack/images/duck.webp', aspect: 2 });
  const placed = [0.31, 0.32];
  act({ t: 'map.token.add', id, kind: 'mob', sourceKind: 'monster', sourceId: 'beetle', x: placed[0], y: placed[1] });
  act({ t: 'map.bindCombat', id });
  const { uids: [first, second] } = act({ t: 'combat.addMob', sourceId: 'beetle', count: 2 });
  act({ t: 'scene.set', kind: 'map', data: { mapId: id } });
  let [m] = view().maps;
  const a = m.tokens.find((t) => t.ref === first);
  const b = m.tokens.find((t) => t.ref === second);
  assert.deepEqual([a.x, a.y], placed);
  assert.notEqual(a.image, b.image);
  assert.equal(view('stage').maps[0].tokens.filter((t) => t.kind === 'mob').length, 0);
  act({ t: 'map.token.move', id, tokenId: a.id, x: 0.72, y: 0.68 });
  act({ t: 'combat.reveal', uid: first });
  act({ t: 'combat.damage', uid: first, amount: 2 });
  m = view('stage').maps[0];
  assert.deepEqual(m.tokens.filter((t) => t.kind === 'mob').map((t) => [t.ref, t.x, t.y, t.down, t.image]), [[first, 0.72, 0.68, true, a.image]]);
  assert.equal(normalizeState(state(), pack).combat.mapId, id);
});

test('Zone 0 affects the complement of overlapping rectangles and freehand polygons', () => {
  const { act, view } = setup();
  const { id } = act({ t: 'map.add', name: 'Room', image: '/pack/images/duck.webp', aspect: 2 });
  const { zoneId } = act({ t: 'map.zone.add', id, name: 'Room A', shape: { x: 0.2, y: 0.2, w: 0.35, h: 0.5 } });
  act({ t: 'map.zone.add', id, name: 'Room B', shape: { points: [[0.40, 0.25], [0.8, 0.25], [0.62, 0.85]] } });
  act({ t: 'scene.set', kind: 'map', data: { mapId: id } });
  act({ t: 'map.zone.reveal', id, zoneId: '0', on: true });
  const opened = (c, r) => {
    const [m] = view('stage').maps;
    return cellOn(decodeFog(m.fog, m.cols, m.rows), m.cols, c, r);
  };
  assert.equal(opened(0, 0), true);
  assert.equal(opened(15, 8), false);
  assert.equal(opened(24, 8), false);
  assert.equal(opened(29, 8), false);
  assert.deepEqual(view('stage').maps[0].zones, []);
  act({ t: 'map.zone.reveal', id, zoneId, on: true });
  act({ t: 'map.zone.reveal', id, zoneId: '0', on: false });
  assert.equal(opened(0, 0), false);
  assert.equal(view('stage').maps[0].zones[0].id, zoneId);
});

test('corpse and victory loot wait for confirmation for the credited killer', () => {
  const { act, state, view } = setup();
  const { playerId: first } = act({ t: 'player.add', name: 'One' });
  const { playerId: killer } = act({ t: 'player.add', name: 'Two' });
  act({ t: 'combat.victoryLoot', items: [{ id: 'crown', qty: 1 }] });
  const { uids: [a, b] } = act({ t: 'combat.addMob', sourceId: 'beetle', count: 2, hidden: false });
  act({ t: 'combat.start' });
  act({ t: 'combat.damage', uid: a, by: first, amount: 2 });
  act({ t: 'combat.damage', uid: b, by: killer, amount: 2 });
  act({ t: 'combat.undo' });
  assert.equal(view().combat.lastKill.playerId, first);
  act({ t: 'combat.damage', uid: b, by: killer, amount: 2 });
  act({ t: 'combat.end', outcome: 'victory' });
  const piles = state().drops;
  assert.deepEqual(piles.map((d) => d.suggestedFor), [first, killer, killer]);
  assert.ok(state().players.every((p) => !p.inventory.length));
  assert.equal(state().scene.data.summary.finalBlowPlayerId, killer);
  for (const d of piles) act({ t: 'loot.confirm', dropId: d.id });
  assert.throws(() => act({ t: 'loot.confirm', dropId: piles[0].id }), /already confirmed/);
  assert.deepEqual(state().players.find((p) => p.id === killer).inventory.map((i) => i.itemId), ['duck', 'crown']);
});

test('manual lethal damage without an actor does not reserve loot for a prior attacker', () => {
  const { act, state, view } = setup();
  const { playerId } = act({ t: 'player.add', name: 'Runner' });
  const { uids: [uid] } = act({ t: 'combat.addMob', sourceId: 'beetle', hidden: false });
  act({ t: 'combat.start' });
  state().rolls.push({ id: 'old_hit', playerId, at: 1000, vs: { uid, hit: true } });
  act({ t: 'combat.damage', uid, amount: 2 });
  assert.equal(view().combat.lastKill.playerId, null);
  assert.throws(() => act({ t: 'loot.confirm', uid }), /choose the crawler/);
  assert.equal(state().drops.length, 0);
});
test('GM PNG upload stores the image and map atomically, with a campaign boundary', async (t) => {
  const dir = tmpDir();
  const key = 'map-review-local-gm';
  const s = await startServer({ packDir, dataDir: dir, port: 0, host: '127.0.0.1', env: { GM_KEY: key }, log: { log() {}, warn() {}, error() {} } });
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${s.port}`;
  const url = base + '/api/maps/image?name=Private%20map';
  const png = samplePng(91, 17, 122);
  const headers = { 'Content-Type': 'image/png', 'X-GM-Key': key, 'X-System-Campaign-Id': s.state.campaign.id };
  assert.equal((await fetch(url, { method: 'POST', body: png, headers: { 'Content-Type': 'image/png' } })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', body: png, headers: { ...headers, 'X-System-Campaign-Id': 'different' } })).status, 409);
  assert.equal((await fetch(url, { method: 'POST', body: 'not a bitmap', headers })).status, 400);
  assert.deepEqual(s.state.maps.list, []);
  const res = await fetch(url, { method: 'POST', body: png, headers });
  assert.equal(res.status, 201, await res.clone().text());
  const result = await res.json();
  assert.equal(s.state.maps.list[0].image, result.image);
  assert.equal((await fetch(base + result.image)).headers.get('content-type'), 'image/png');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8')).maps.list[0].image, result.image);
});
