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
    combat: { degreeScale: 'seven', injuries: { minor: 'minor', major: 'major', minorLong: 'minor_long', majorLong: 'major_long',
      minorDescriptions: ['Bruised thumb', 'Twisted ankle'], majorDescriptions: ['Fractured leg'] } },
    skills: { check: { roll: 'd20', formula: 'skill.rank + mod.{stat}' }, untrained: { adv: 'dis', formula: 'mod.{stat}' }, usedTracking: true },
  },
  'skills.json': [{ id: 'sneak', name: 'Sneak', stat: 'con', checkType: 'Opposed' }],
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

test('one injury can be canceled without removing other queued or applied injuries', () => {
  const { act, view, state } = setup();
  const { playerId } = act({ t: 'player.add', name: 'Runner' });
  act({ t: 'combat.start' });
  const { uid } = view().combat.combatants[0];
  for (const severity of ['minor', 'minor', 'major']) act({ t: 'combat.injury', uid, severity });
  const [first, second, third] = view().combat.combatants[0].pendingInjuries;
  act({ t: 'combat.injury.remove', uid, injuryId: first.id });
  act({ t: 'combat.injury.remove', uid, injuryId: first.id });
  assert.deepEqual(view().combat.combatants[0].pendingInjuries, [second, third]);
  act({ t: 'combat.end', outcome: 'truce' });
  const [minor, major] = state().players[0].sheet.buffs;
  assert.equal(minor.desc, 'Twisted ankle Mechanical effect');
  act({ t: 'buff.remove', playerId, uid: minor.uid });
  assert.deepEqual(state().players[0].sheet.buffs, [major]);
  assert.equal(major.desc, 'Fractured leg Mechanical effect');
});

test('queued injuries from old saves get stable IDs and stay removable', () => {
  const { act, view, state } = setup();
  act({ t: 'player.add', name: 'Runner' });
  act({ t: 'combat.start' });
  const raw = structuredClone(state());
  raw.combat.combatants[0].injuries = ['minor', { severity: 'major', desc: 'Sore ribs' }];
  const s = normalizeState(raw, pack);
  const { uid, injuries: [minor, major] } = s.combat.combatants[0];
  assert.deepEqual(normalizeState(s, pack).combat.combatants[0].injuries.map((i) => i.id), [minor.id, major.id]);
  const cleared = reduce(s, { role: 'gm', t: 'combat.injury.remove', uid, injuryId: minor.id }, { pack }).state;
  assert.deepEqual(cleared.combat.combatants[0].injuries, [major]);
  assert.equal(viewFor(cleared, pack, 'gm').combat.combatants[0].pendingInjuries[0].desc, 'Sore ribs');
});

test('TV party check uses sheet rolls and adjusts both directions before counting half', () => {
  const { act, view, state } = setup();
  const ids = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'].map((name) => act({ t: 'player.add', name }).playerId);
  act({ t: 'skill.add', playerId: ids[1], skillId: 'sneak', rank: 4 });
  const payload = { t: 'scene.check', mode: 'party', skillId: 'sneak', dc: 17,
    entries: ids.map((playerId, i) => ({ playerId, entered: [20, 7, 10, 1, 8, 5][i] })) };
  const { verdict, results } = act(payload);
  assert.deepEqual(results.map((r) => [r.degree, r.shift]), [
    ['crit', undefined], ['success', 'hindered'], ['near', 'helped'], ['critfail', undefined], ['fail', undefined], ['fail', undefined],
  ]);
  assert.deepEqual(verdict, { passed: 2, required: 3, success: false });
  assert.equal(results[1].modifier, 10);
  assert.equal(results[2].untrained, true);
  assert.equal(state().players[1].sheet.skills[0].used, true);
  assert.equal(state().rolls.length, 6);
  assert.throws(() => act({ t: 'roll.intervene', rollId: results[2].rollId, entered: 3 }), /no Intervene on a party check/);
  assert.deepEqual(view('stage').scene.data.check, { verdict, results });
  assert.throws(() => act({ ...payload, entries: [payload.entries[0], payload.entries[0]] }), /once/);
  assert.throws(() => act({ ...payload, entries: [{ playerId: ids[0], entered: 21 }] }), /higher than d20/);
  assert.equal(state().rolls.length, 6);

  const half = act({ ...payload, entries: [payload.entries[1], payload.entries[4]] });
  assert.deepEqual(half.verdict, { passed: 1, required: 1, success: true });
  const single = act({ t: 'scene.check', mode: 'single', statId: 'con', dc: 16, entries: [{ playerId: ids[0], entered: 10 }] });
  assert.equal(single.verdict, null);
  assert.equal(single.results[0].total, 16);
  assert.equal(single.results[0].degree, 'success');
  const pre = act({ t: 'scene.preview', kind: 'roll', data: { dc: 17, label: 'Sneak' } });
  assert.equal(pre.scene.data.dc, 17);
  assert.equal(pre.scene.data.check, undefined);
  assert.equal(view('stage').scene.data.dc, 16);
  act({ t: 'scene.roll', formula: '2d6' });
  assert.equal(view('stage').scene.data.dc, undefined);
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

test('starting combat from the map recruits revealed mobs once in place and keeps the TV map', () => {
  const { act, view, state } = setup();
  const { playerId } = act({ t: 'player.add', name: 'Runner' });
  const { id } = act({ t: 'map.add', name: 'Room', image: '/pack/images/duck.webp' });
  const { id: other } = act({ t: 'map.add', name: 'Hall', image: '/pack/images/duck.webp' });
  const { tokenId: pc } = act({ t: 'map.token.add', id, kind: 'pc', ref: playerId, x: 0.19, y: 0.67 });
  const mobToken = { t: 'map.token.add', id, kind: 'mob', sourceKind: 'monster', sourceId: 'beetle' };
  const { tokenId: hidden } = act(mobToken);
  const { tokenId: a } = act({ ...mobToken, hidden: false, label: 'Green scout', x: 0.24, y: 0.48 });
  const { tokenId: b } = act({ ...mobToken, hidden: false, label: 'White scout', x: 0.59, y: 0.12 });
  act({ t: 'scene.set', kind: 'map', data: { mapId: id } });
  const priorMap = view().maps.find((m) => m.id === id);

  assert.throws(() => act({ t: 'map.toFight', id, role: 'player', actorId: playerId }), /unknown action/);
  assert.deepEqual(act({ t: 'map.toFight', id }), { mapId: id, started: true, added: 2 });
  const c = view().combat;
  assert.equal(c.active, true);
  assert.equal(c.round, 1);
  assert.equal(c.mapId, id);
  assert.equal(c.combatants.find((x) => x.type === 'crawler').playerId, playerId);
  assert.deepEqual(c.combatants.filter((x) => x.type === 'mob').map((x) => [x.name, x.hp, x.hidden]),
    [['Green scout', 2, false], ['White scout', 2, false]]);
  assert.equal(view('stage').scene.kind, 'map');
  const afterMap = view().maps.find((m) => m.id === id);
  assert.equal(afterMap.tokens.find((t) => t.id === hidden).ref, null);
  assert.deepEqual(view('stage').maps[0].tokens.map((t) => t.id), [pc, a, b]);
  for (const tokenId of [pc, a, b]) {
    const before = priorMap.tokens.find((t) => t.id === tokenId);
    const after = afterMap.tokens.find((t) => t.id === tokenId);
    assert.deepEqual([after.x, after.y, after.image], [before.x, before.y, before.image]);
  }
  const uid = afterMap.tokens.find((t) => t.id === a).ref;
  act({ t: 'combat.damage', uid, amount: 1 });
  const current = state();
  assert.deepEqual(act({ t: 'map.toFight', id }), { mapId: id, started: false, added: 0 });
  assert.equal(state(), current);
  assert.throws(() => act({ t: 'map.toFight', id: other }), /End the current fight/);
  assert.equal(normalizeState(state(), pack).maps.list.find((m) => m.id === id).tokens.find((t) => t.id === a).ref, uid);
});

test('map combat reuses a matching draft mob and protects an unrelated or hidden draft from replacement', () => {
  const { act, view, state } = setup();
  const { id } = act({ t: 'map.add', name: 'Room', image: '/pack/images/duck.webp' });
  const { tokenId } = act({ t: 'map.token.add', id, kind: 'mob', sourceKind: 'monster', sourceId: 'beetle' });
  act({ t: 'map.fog', id, all: true });
  assert.throws(() => act({ t: 'map.toFight', id }), /Reveal at least one/);
  const { uids: [uid] } = act({ t: 'combat.addMob', sourceId: 'beetle' });
  act({ t: 'map.token.update', id, tokenId, hidden: false });
  const pending = state();
  assert.throws(() => act({ t: 'map.toFight', id }), /different lineup/);
  assert.equal(state(), pending);
  act({ t: 'combat.reveal', uid });
  act({ t: 'combat.damage', uid, amount: 1 });
  assert.deepEqual(act({ t: 'map.toFight', id }), { mapId: id, started: true, added: 0 });
  assert.deepEqual(view().combat.combatants.map((m) => [m.uid, m.hp]), [[uid, 1]]);
  assert.equal(view().maps[0].tokens.find((t) => t.id === tokenId).ref, uid);
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
