import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { serializePack, deserializePack, normalizePack } from '../pack-core.js';
import { createState, normalizeState, reduce, reducePlayerAction, viewFor } from '../state.js';
import { tmpDir, writePack, seq } from './fixtures.js';

const BOSSES = [
  {
    id: 'jukebox', name: 'The Hungry Jukebox', title: 'Plays Requests', hpSlots: 8, color: '#ff2fb9', lootTier: 'gold',
    image: 'bosses/jukebox.webp',
    phases: [{ name: 'Easy Listening', text: 'Smooth.' }, { name: 'The Drop', text: 'Bass.' }, { name: 'Encore' }],
  },
  { id: 'bad', hpSlots: 3 }, // no name → skipped with a warning
];
const quips = [
  { id: 'boss_01', category: 'boss', text: 'A boss appears.' },
  { id: 'n20', category: 'nat20', text: 'Twenty!' },
];
const dir = writePack(tmpDir(), { 'bosses.json': BOSSES, 'quips.json': quips });
const { pack, warnings } = loadPack(dir);

let n = 0;
const ctx = (extra = {}) => ({ now: 1_000_000, rng: seq(0.5), genId: (p) => `${p}_${++n}`, pack, ...extra });
const gm = (state, a, extra) => reduce(state, { role: 'gm', ...a }, ctx(extra));

function base() {
  let s = createState(pack, 0);
  const r = gm(s, { t: 'player.add', name: 'Carl', pin: '1234' });
  s = r.state;
  return { s, pid: r.result.playerId };
}

test('bosses.json: library kind boss, image resolved/missing, bad entries skipped, serialize round-trip', () => {
  const b = pack.library.boss.find((x) => x.id === 'jukebox');
  assert.equal(b.name, 'The Hungry Jukebox');
  assert.equal(b.hpSlots, 8);
  assert.equal(b.phases.length, 3);
  assert.equal(b.phases[2].text, '');
  assert.equal(b.image, null); // file missing → fallback (placeholder on the TV)
  assert.ok(warnings.some((w) => /boss jukebox: images\/bosses\/jukebox.webp not found/.test(w)));
  assert.ok(warnings.some((w) => /bosses.json \[1\]/.test(w)));
  assert.equal(pack.library.boss.length, 1);
  const again = deserializePack(serializePack(pack));
  assert.deepEqual(again.library.boss, pack.library.boss);
  // GM library view lists bosses; players do not see them.
  const { s, pid } = base();
  assert.equal(viewFor(s, pack, 'gm').library.boss.length, 1);
  assert.deepEqual(viewFor(s, pack, 'player', { playerId: pid }).library.boss, []);
});

test('pack theme: valid value kept, invalid ignored with warning, in every view', () => {
  const ok = normalizePack({ pack: { id: 'x', name: 'X', theme: 'neon' } }).pack;
  assert.equal(ok.theme, 'neon');
  const badTheme = normalizePack({ pack: { id: 'x', name: 'X', theme: 'disco' } });
  assert.equal(badTheme.pack.theme, null);
  assert.ok(badTheme.warnings.some((w) => /theme/.test(w)));
  assert.equal(deserializePack(serializePack(ok)).theme, 'neon');
  assert.equal(viewFor(createState(ok, 0), ok, 'stage').pack.theme, 'neon');
});

test('initial scene is the lobby; view.scene + view.show for every role; old saves get defaults', () => {
  const { s, pid } = base();
  for (const [role, o] of [['gm', {}], ['stage', {}], ['player', { playerId: pid }]]) {
    const v = viewFor(s, pack, role, { ...o, now: 5000 });
    assert.equal(v.scene.kind, 'lobby');
    assert.equal(v.scene.now, 5000);
    assert.equal(v.scene.party.length, 1);
    assert.deepEqual(v.scene.party[0].tracks.map((t) => t.id), ['hp']);
    assert.deepEqual(v.show, { audioDevice: 'gm' });
  }
  const { scene, show, ...old } = s;
  const fixed = normalizeState(old, pack, 7);
  assert.equal(fixed.scene.kind, 'lobby');
  assert.deepEqual(fixed.show, { audioDevice: 'gm' });
  assert.equal(normalizeState({ ...s, scene: { kind: 'disco', data: {} } }, pack).scene.kind, 'lobby');
  assert.equal(normalizeState({ ...s, scene: { kind: 'boss', data: {} } }, pack).scene.kind, 'lobby');
});

test('scene.set / scene.update: plain kinds validate fields, update is a shallow merge', () => {
  const { s } = base();
  let r = gm(s, { t: 'scene.set', kind: 'explore', data: { location: 'The Food Court', floor: 'Floor 2', text: 'It smells of fryer oil.' } });
  const sc = r.state.scene;
  assert.equal(sc.kind, 'explore');
  assert.equal(sc.since, 1_000_000);
  assert.deepEqual(sc.data, { locationId: null, location: 'The Food Court', floor: 'Floor 2', image: null, text: 'It smells of fryer oil.', showFeed: true });
  r = gm(r.state, { t: 'scene.update', data: { floor: 'Floor 3', image: '/pack/images/food.webp' } });
  assert.equal(r.state.scene.id, sc.id); // same scene, no transition
  assert.equal(r.state.scene.data.location, 'The Food Court');
  assert.equal(r.state.scene.data.floor, 'Floor 3');
  assert.equal(r.state.scene.data.image, '/pack/images/food.webp');
  assert.throws(() => gm(s, { t: 'scene.set', kind: 'disco' }), /kind must be one of/);
  assert.throws(() => gm(s, { t: 'scene.set', kind: 'explore', data: { nope: 1 } }), /unknown field nope/);
  assert.throws(() => gm(s, { t: 'scene.set', kind: 'explore', data: { location: 5 } }), /location must be a string/);
  assert.throws(() => gm(s, { t: 'scene.set', kind: 'explore', data: { image: 'javascript:alert(1)' } }), /image must be/);
  assert.throws(() => gm(s, { t: 'scene.set', kind: 'lobby', data: { title: 'x'.repeat(81) } }), /title too long/);
  assert.throws(() => gm(s, { t: 'scene.set', kind: 'lobby', data: 'hi' }), /data must be an object/);
  assert.throws(() => gm(s, { t: 'scene.update' }), /data required/);
  // recap defaults to the session recap
  const withRecap = gm(s, { t: 'session.recap', text: 'Last time, the duck.' }).state;
  assert.equal(gm(withRecap, { t: 'scene.set', kind: 'recap' }).state.scene.data.text, 'Last time, the duck.');
  assert.equal(gm(withRecap, { t: 'scene.set', kind: 'blank' }).state.scene.kind, 'blank');
});

test('players and the stage cannot direct scenes', () => {
  const { s, pid } = base();
  for (const t of ['scene.set', 'scene.update', 'scene.roll', 'show.audio', 'boss.intro', 'boss.damage', 'boss.heal', 'boss.phase', 'boss.defeat', 'countdown.start', 'countdown.pause', 'countdown.add', 'countdown.reset']) {
    assert.throws(() => reducePlayerAction(s, { t, kind: 'blank' }, { playerId: pid, pack, now: 1 }), /unknown action/, t);
    assert.throws(() => reduce(s, { role: 'stage', t, kind: 'blank' }, ctx()), /unknown action/, t);
  }
});

test('show.audio switches the audio device', () => {
  const { s } = base();
  const r = gm(s, { t: 'show.audio', device: 'stage' });
  assert.deepEqual(viewFor(r.state, pack, 'stage').show, { audioDevice: 'stage' });
  assert.throws(() => gm(s, { t: 'show.audio', device: 'toaster' }), /device must be one of/);
});

test('boss scene from the library: intro, damage, heal, phase, defeat with events', () => {
  const { s } = base();
  assert.throws(() => gm(s, { t: 'boss.damage' }), /no boss scene/);
  let r = gm(s, { t: 'scene.set', kind: 'boss', data: { bossId: 'jukebox' } });
  let d = r.state.scene.data;
  assert.equal(d.boss.name, 'The Hungry Jukebox');
  assert.equal(d.hp, 8);
  assert.equal(d.phase, 0);
  assert.equal(d.revealed, false);
  assert.equal(viewFor(r.state, pack, 'stage').scene.data.lootTierInfo.id, 'gold');

  r = gm(r.state, { t: 'boss.intro' });
  assert.equal(r.state.scene.data.revealed, true);
  assert.deepEqual(r.events.map((e) => e.event.kind), ['boss.intro']);
  assert.deepEqual(r.events[0].to, { roles: ['stage', 'gm'] });
  assert.equal(r.lines[0].text, 'A boss appears.');
  assert.match(r.state.feed.at(-1).text, /BOSS: The Hungry Jukebox/);
  assert.equal(gm(r.state, { t: 'boss.intro', line: false }).lines.length, 0);

  r = gm(r.state, { t: 'boss.damage', amount: 3 });
  assert.equal(r.state.scene.data.hp, 5);
  assert.deepEqual({ ...r.events[0].event, id: 0, at: 0 }, { id: 0, at: 0, kind: 'boss.hit', sceneId: r.state.scene.id, amount: 3, from: 8, hp: 5, max: 8, suggestPhase: null });
  r = gm(r.state, { t: 'boss.damage' });
  assert.equal(r.state.scene.data.hp, 4);
  assert.equal(gm(r.state, { t: 'boss.damage', amount: 99 }).state.scene.data.hp, 0); // clamped at 0
  assert.throws(() => gm(r.state, { t: 'boss.damage', amount: 0 }), /amount must be an integer/);
  assert.throws(() => gm(r.state, { t: 'boss.damage', amount: 1.5 }), /amount/);

  r = gm(r.state, { t: 'boss.heal', amount: 10 });
  assert.equal(r.state.scene.data.hp, 8); // clamped at max
  assert.equal(r.events[0].event.kind, 'boss.heal');
  assert.equal(r.events[0].event.amount, 4);

  r = gm(r.state, { t: 'boss.phase' });
  assert.equal(r.state.scene.data.phase, 1);
  assert.equal(r.events[0].event.name, 'The Drop');
  r = gm(r.state, { t: 'boss.phase', index: 2 });
  assert.equal(r.events[0].event.name, 'Encore');
  assert.throws(() => gm(r.state, { t: 'boss.phase' }), /last phase/);
  assert.throws(() => gm(r.state, { t: 'boss.phase', index: 3 }), /index must be an integer 0..2/);

  const before = r.state.audience.viewers;
  r = gm(r.state, { t: 'boss.defeat' });
  d = r.state.scene.data;
  assert.equal(d.defeated, true);
  assert.equal(d.hp, 0);
  const ev = r.events.find((e) => e.event.kind === 'boss.defeat').event;
  assert.equal(ev.lootHint, 'Gold Box incoming');
  assert.ok(r.state.audience.viewers > before);
  assert.match(r.state.feed.at(-1).text, /was defeated/);
  // heal revives
  assert.equal(gm(r.state, { t: 'boss.heal' }).state.scene.data.defeated, false);
  assert.equal(gm(r.state, { t: 'boss.defeat', lootHint: 'Check under the couch' }).events.find((e) => e.event.kind === 'boss.defeat').event.lootHint, 'Check under the couch');
});

test('ad-hoc boss validation and boss scene.update', () => {
  const { s } = base();
  let r = gm(s, { t: 'scene.set', kind: 'boss', data: { boss: { name: 'Gary', hpSlots: 3 } } });
  assert.equal(r.state.scene.data.bossId, null);
  assert.equal(r.state.scene.data.hp, 3);
  assert.deepEqual(r.state.scene.data.boss.phases, []);
  assert.throws(() => gm(r.state, { t: 'boss.phase' }), /no further phases/);
  r = gm(r.state, { t: 'scene.update', data: { hp: 1, lootHint: 'A sock' } });
  assert.equal(r.state.scene.data.hp, 1);
  assert.throws(() => gm(r.state, { t: 'scene.update', data: { hp: 4 } }), /hp must be an integer 0..3/);
  assert.throws(() => gm(r.state, { t: 'scene.update', data: { mood: 'sad' } }), /unknown field mood/);
  // swapping the boss keeps the fight state but clamps it
  r = gm(r.state, { t: 'scene.update', data: { bossId: 'jukebox' } });
  assert.equal(r.state.scene.data.boss.name, 'The Hungry Jukebox');
  assert.equal(r.state.scene.data.hp, 1);

  assert.throws(() => gm(s, { t: 'scene.set', kind: 'boss' }), /needs bossId/);
  assert.throws(() => gm(s, { t: 'scene.set', kind: 'boss', data: { bossId: 'nope' } }), /unknown boss nope/);
  assert.throws(() => gm(s, { t: 'scene.set', kind: 'boss', data: { boss: { name: '' } } }), /boss.name must not be empty/);
  assert.throws(() => gm(s, { t: 'scene.set', kind: 'boss', data: { boss: { name: 'X', hpSlots: 101 } } }), /hpSlots must be an integer 1..100/);
  assert.throws(() => gm(s, { t: 'scene.set', kind: 'boss', data: { boss: { name: 'X', phases: [{}] } } }), /phases\[0\].name/);
  assert.throws(() => gm(s, { t: 'scene.set', kind: 'boss', data: { boss: { name: 'X', phases: Array(11).fill({ name: 'p' }) } } }), /max 10/);
  assert.throws(() => gm(s, { t: 'scene.set', kind: 'boss', data: { boss: { name: 'X', color: 'red' } } }), /color/);
  assert.throws(() => gm(s, { t: 'scene.set', kind: 'boss', data: { boss: { name: 'X', lootTier: 'diamond' } } }), /unknown loot tier/);
  assert.throws(() => gm(s, { t: 'scene.set', kind: 'boss', data: { boss: { name: 'X', image: 'file:///etc/passwd' } } }), /image must be/);
  // homebrew bosses via lib.upsert show up as bossId
  const hb = gm(s, { t: 'lib.upsert', kind: 'boss', entry: { id: 'hb_gary', name: 'Gary', hpSlots: 5, phases: [{ name: 'Mad' }, { name: 'Madder' }] } });
  r = gm(hb.state, { t: 'scene.set', kind: 'boss', data: { bossId: 'hb_gary' } });
  assert.equal(r.state.scene.data.hp, 5);
  assert.equal(gm(r.state, { t: 'boss.phase' }).state.scene.data.phase, 1);
});

test('countdown: start/pause/add/reset computed from server time, view has endsAt', () => {
  const { s } = base();
  assert.throws(() => gm(s, { t: 'countdown.start' }), /no countdown/);
  let r = gm(s, { t: 'scene.set', kind: 'countdown', data: { label: 'Floor collapse', seconds: 600 } }, { now: 0 });
  let v = viewFor(r.state, pack, 'stage', { now: 10_000 }).scene.data;
  assert.deepEqual([v.remainingMs, v.running, v.endsAt, v.totalMs], [600_000, false, null, 600_000]);
  r = gm(r.state, { t: 'countdown.start' }, { now: 1000 });
  v = viewFor(r.state, pack, 'stage', { now: 61_000 }).scene.data;
  assert.deepEqual([v.remainingMs, v.running, v.endsAt], [540_000, true, 601_000]);
  assert.equal(v.startedAt, undefined);
  r = gm(r.state, { t: 'countdown.pause' }, { now: 121_000 });
  v = viewFor(r.state, pack, 'stage', { now: 999_000 }).scene.data;
  assert.deepEqual([v.remainingMs, v.running], [480_000, false]); // paused: no drift
  r = gm(r.state, { t: 'countdown.add', seconds: 60 }, { now: 130_000 });
  assert.equal(viewFor(r.state, pack, 'stage', { now: 140_000 }).scene.data.remainingMs, 540_000);
  r = gm(r.state, { t: 'countdown.start' }, { now: 200_000 });
  r = gm(r.state, { t: 'countdown.add', seconds: -30 }, { now: 210_000 }); // while running
  v = viewFor(r.state, pack, 'stage', { now: 220_000 }).scene.data;
  assert.deepEqual([v.remainingMs, v.running], [490_000, true]); // 540k − 10k elapsed − 30k − 10k elapsed
  // runs out → 0, not running
  v = viewFor(r.state, pack, 'stage', { now: 2_000_000 }).scene.data;
  assert.deepEqual([v.remainingMs, v.running, v.endsAt], [0, false, null]);
  r = gm(r.state, { t: 'countdown.reset' }, { now: 2_000_000 });
  v = viewFor(r.state, pack, 'stage', { now: 2_000_000 }).scene.data;
  assert.deepEqual([v.remainingMs, v.running], [600_000, false]);
  r = gm(r.state, { t: 'countdown.reset', seconds: 5 }, { now: 0 });
  r = gm(r.state, { t: 'countdown.add', seconds: -10 }, { now: 0 });
  assert.throws(() => gm(r.state, { t: 'countdown.start' }), /at zero/);
  assert.throws(() => gm(r.state, { t: 'countdown.add', seconds: 0 }), /must not be 0/);
  assert.throws(() => gm(r.state, { t: 'countdown.add', seconds: 'lots' }), /seconds must be an integer/);
  assert.throws(() => gm(s, { t: 'scene.set', kind: 'countdown', data: { seconds: 0 } }), /seconds must be an integer 1/);
  const auto = gm(s, { t: 'scene.set', kind: 'countdown', data: { seconds: 30, autostart: true } }, { now: 0 });
  assert.equal(viewFor(auto.state, pack, 'stage', { now: 10_000 }).scene.data.remainingMs, 20_000);
});

test('scene.roll: server roll lands in the dice log + roll event, nat20 line; rollId re-shows', () => {
  const { s, pid } = base();
  let r = gm(s, { t: 'scene.roll', playerId: pid, formula: 'd20', label: 'Initiative' }, { rollInt: () => 19 });
  const d = r.state.scene.data;
  assert.equal(r.state.scene.kind, 'roll');
  assert.equal(d.name, 'Carl');
  assert.equal(d.total, 20);
  assert.equal(d.nat20, true);
  assert.equal(d.label, 'Initiative');
  assert.deepEqual(d.dice, [{ die: 'd20', value: 20 }]);
  assert.equal(r.state.rolls.at(-1).id, d.rollId);
  assert.ok(r.events.some((e) => e.event.kind === 'roll' && e.to === 'all'));
  assert.equal(r.lines[0].text, 'Twenty!');
  assert.equal(r.result.total, 20);
  // GM roll without player, custom name
  r = gm(r.state, { t: 'scene.roll', formula: '2d6+1', name: 'The Dungeon' }, { rollInt: () => 0 });
  assert.equal(r.state.scene.data.name, 'The Dungeon');
  assert.equal(r.state.scene.data.total, 3);
  assert.equal(r.state.scene.data.nat1, false);
  // re-show an earlier roll
  const first = r.state.rolls[0].id;
  const again = gm(r.state, { t: 'scene.roll', rollId: first });
  assert.equal(again.state.scene.data.total, 20);
  assert.equal(again.state.rolls.length, 2);
  assert.throws(() => gm(r.state, { t: 'scene.roll', rollId: 'r_nope' }), /no public roll/);
  assert.throws(() => gm(s, { t: 'scene.roll', formula: 'drop table' }), /bad roll formula/);
  assert.throws(() => gm(s, { t: 'scene.roll', playerId: 'p_nope' }), /no player/);
  // an idle roll scene for a named roller
  const idle = gm(s, { t: 'scene.set', kind: 'roll', data: { playerId: pid, label: 'Save vs. jukebox' } });
  assert.equal(idle.state.scene.data.name, 'Carl');
  assert.equal(idle.state.scene.data.total, null);
  assert.throws(() => gm(s, { t: 'scene.set', kind: 'roll', data: { total: 20 } }), /use scene.roll/);
});

test('loot scene validates player + tier', () => {
  const { s, pid } = base();
  const r = gm(s, { t: 'scene.set', kind: 'loot', data: { playerId: pid, tier: 'gold' } });
  assert.equal(viewFor(r.state, pack, 'stage').scene.data.tierInfo.name, 'Gold Box');
  assert.throws(() => gm(s, { t: 'scene.set', kind: 'loot', data: { playerId: 'x' } }), /no player/);
  assert.throws(() => gm(s, { t: 'scene.set', kind: 'loot', data: { tier: 'diamond' } }), /unknown loot tier/);
});

test('scene survives a save/load round-trip', () => {
  const { s } = base();
  const r = gm(s, { t: 'scene.set', kind: 'boss', data: { bossId: 'jukebox' } });
  const loaded = normalizeState(JSON.parse(JSON.stringify(r.state)), pack);
  assert.deepEqual(loaded.scene, r.state.scene);
});

test('private-pack boss shape: intro/defeatLine voiced, atHp suggests phases, tactics + lootHint never leave the GM library', () => {
  const big = {
    id: 'porter', name: 'Porter Grim', title: 'Employee of the Month', floor: 1, image: 'porter.webp', hpSlots: 20,
    evade: 2, dr: 2, attacks: [{ name: 'Luggage Hurl' }], cues: { tv: 'boss' }, verify: true, lootItems: ['x'],
    intro: 'Please welcome Porter Grim.', defeatLine: 'Porter Grim has checked out.',
    lootHint: 'SECRET LOOT HINT', tactics: 'SECRET TACTICS',
    phases: [{ name: 'Check-In', atHp: 20, text: 'a' }, { name: 'Overbooked', atHp: 12, spawns: ['snapper'] }, { name: 'Final Checkout', atHp: 5 }],
  };
  const locs = [{ id: 'lobby', name: 'The Grand Lobby', floor: 1, image: 'lobby.webp', readAloud: 'Marble. Blood. Mints.', features: ['SECRET FEATURE'], monsters: ['x'] }];
  const p2 = loadPack(writePack(tmpDir(), { 'bosses.json': [big], 'locations.json': locs, 'quips.json': quips })).pack;
  const c2 = (extra = {}) => ({ ...ctx(extra), pack: p2 });
  const g2 = (state, a, extra) => reduce(state, { role: 'gm', ...a }, c2(extra));
  const lib = p2.library.boss[0];
  assert.equal(lib.tactics, 'SECRET TACTICS');
  assert.equal(lib.lootHint, 'SECRET LOOT HINT');
  assert.equal(lib.floor, '1');
  assert.deepEqual(lib.phases.map((p) => p.atHp), [20, 12, 5]);
  assert.equal(lib.attacks, undefined); // unknown keys ignored
  assert.equal(p2.library.location[0].readAloud, 'Marble. Blood. Mints.');

  let s = createState(p2, 0);
  s = g2(s, { t: 'player.add', name: 'Carl', pin: '1234' }).state;
  const pid = s.players[0].id;
  let r = g2(s, { t: 'scene.set', kind: 'boss', data: { bossId: 'porter' } });
  for (const [role, o] of [['stage', {}], ['player', { playerId: pid }]]) {
    const txt = JSON.stringify(viewFor(r.state, p2, role, o));
    assert.ok(!txt.includes('SECRET'), `${role} view leaks GM-only text`);
  }
  assert.ok(JSON.stringify(viewFor(r.state, p2, 'gm').library.boss).includes('SECRET TACTICS'));

  r = g2(r.state, { t: 'boss.intro' });
  assert.equal(r.lines[0].text, 'Please welcome Porter Grim.');
  assert.equal(r.events[0].event.intro, 'Please welcome Porter Grim.');
  r = g2(r.state, { t: 'boss.damage', amount: 7 }); // 13 HP: nothing yet
  assert.equal(r.result.suggestPhase, null);
  r = g2(r.state, { t: 'boss.damage', amount: 1 }); // 12 HP → Overbooked
  assert.equal(r.result.suggestPhase, 1);
  assert.equal(r.events[0].event.suggestPhase, 1);
  assert.equal(r.state.scene.data.phase, 0); // never automatic
  assert.equal(viewFor(r.state, p2, 'gm').scene.data.suggestPhase, 1);
  r = g2(r.state, { t: 'boss.damage', amount: 8 }); // 4 HP → skips to Final Checkout
  assert.equal(r.result.suggestPhase, 2);
  r = g2(r.state, { t: 'boss.phase', index: 2 });
  assert.equal(viewFor(r.state, p2, 'gm').scene.data.suggestPhase, null);
  r = g2(r.state, { t: 'boss.defeat' });
  assert.equal(r.lines[0].text, 'Porter Grim has checked out.');
  const ev = r.events.find((e) => e.event.kind === 'boss.defeat').event;
  assert.equal(ev.defeatLine, 'Porter Grim has checked out.');
  assert.equal(ev.lootHint, 'Loot incoming'); // the library lootHint stays on the GM desk
  assert.equal(g2(r.state, { t: 'boss.defeat', line: false }).lines.length, 0);

  // explore from a location
  r = g2(s, { t: 'scene.set', kind: 'explore', data: { locationId: 'lobby' } });
  assert.deepEqual(
    { ...r.state.scene.data },
    { locationId: 'lobby', location: 'The Grand Lobby', floor: 'Floor 1', image: null, text: 'Marble. Blood. Mints.', showFeed: true },
  );
  assert.ok(!JSON.stringify(viewFor(r.state, p2, 'stage')).includes('SECRET'));
  r = g2(r.state, { t: 'scene.update', data: { text: 'Shorter.' } });
  assert.equal(r.state.scene.data.location, 'The Grand Lobby');
  assert.throws(() => g2(s, { t: 'scene.set', kind: 'explore', data: { locationId: 'nope' } }), /unknown location/);
});
