import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { serializePack, deserializePack } from '../pack-core.js';
import { createState, normalizeState, reduce, reducePlayerAction, viewFor } from '../state.js';
import { hpFraction } from '../combat.js';
import { tmpDir, writePack, seq } from './fixtures.js';

const MONSTERS = [
  {
    id: 'goblin', name: 'Goblin', title: 'Small, Loud', floor: 1, group: 'humanoid', image: 'goblin.webp',
    hpSlots: 4, evade: 2, dr: 1, art: 'prompt text (ignored)',
    attacks: [{ name: 'Stab', toHit: 3, damage: '1d4', effects: 'Bleeds on 18+', buffs: ['bleeding'] }, { name: 'Taunt', toHit: 0, damage: '0' }],
    desc: 'Pointy.', flavor: 'It has a tiny hat.', notes: 'SECRET NOTES', tactics: 'SECRET TACTICS', lootHint: 'SECRET LOOT', lootItems: ['duck'],
  },
  { id: 'rat', name: 'Rat', hpSlots: 2, attacks: [{ name: 'Bite', toHit: 'x' }] }, // bad toHit → warning, 0
  { id: 'nameless', hpSlots: 3 }, // skipped
];
const NPCS = [{
  id: 'quill', name: 'Fennimore Quill', role: 'Floor clerk', floor: 0, image: 'quill.webp',
  personality: 'Polite.', voice: 'SECRET VOICE', hooks: ['SECRET HOOK'], secrets: ['SECRET SECRET'],
}];
const LOCS = [{ id: 'lobby', name: 'Lobby', floor: 1, readAloud: 'Marble.', features: ['SECRET FEATURE'], monsters: ['goblin', 'rat'], npcs: ['quill'], bosses: ['porter'] }];
const BOSSES = [{ id: 'porter', name: 'Porter Grim', hpSlots: 20, evade: 2, dr: 2, attacks: [{ name: 'Hurl', toHit: 4, damage: '1d6' }], tactics: 'SECRET BOSS TACTICS' }];
const BUFFS = [{ id: 'bleeding', name: 'Bleeding', tags: ['debuff'], effects: [] }, { id: 'prone', name: 'Prone' }];

const dir = writePack(tmpDir(), { 'monsters.json': MONSTERS, 'npcs.json': NPCS, 'locations.json': LOCS, 'bosses.json': BOSSES, 'buffs.json': BUFFS });
const { pack, warnings } = loadPack(dir);

let n = 0;
const ctx = (extra = {}) => ({ now: 1_000_000, rng: seq(0.5), genId: (p) => `${p}_${++n}`, pack, ...extra });
const gm = (state, a, extra) => reduce(state, { role: 'gm', ...a }, ctx(extra));
const SECRETS = /SECRET/;

function base() {
  let s = createState(pack, 0);
  const r = gm(s, { t: 'player.add', name: 'Carl', pin: '1234' });
  s = r.state;
  const r2 = gm(s, { t: 'player.add', name: 'Donut', pin: '2345' });
  return { s: r2.state, pid: r.result.playerId, pid2: r2.result.playerId };
}
const mobs = (s) => s.combat.combatants.filter((x) => x.type === 'mob');
const views = (s, pid) => ({ player: viewFor(s, pack, 'player', { playerId: pid }), stage: viewFor(s, pack, 'stage') });

test('monsters.json / npcs.json / locations.json: library kinds, unknown keys ignored, bad entries skipped, round-trip', () => {
  const g = pack.library.monster.find((x) => x.id === 'goblin');
  assert.equal(g.hpSlots, 4);
  assert.equal(g.evade, 2);
  assert.equal(g.dr, 1);
  assert.equal(g.floor, '1');
  assert.equal(g.group, 'humanoid');
  assert.equal(g.image, null); // missing file → placeholder
  assert.equal(g.art, undefined);
  assert.deepEqual(g.attacks[0], { name: 'Stab', toHit: 3, damage: '1d4', effects: 'Bleeds on 18+', buffs: ['bleeding'] });
  assert.deepEqual(g.lootItems, ['duck']);
  assert.equal(g.tactics, 'SECRET TACTICS');
  const rat = pack.library.monster.find((x) => x.id === 'rat');
  assert.equal(rat.attacks[0].toHit, 0);
  assert.ok(warnings.some((w) => /rat attacks\[0\]: toHit/.test(w)));
  assert.ok(warnings.some((w) => /monsters.json \[2\]/.test(w)));
  assert.equal(pack.library.monster.length, 2);
  const q = pack.library.npc[0];
  assert.deepEqual([q.role, q.floor, q.voice, q.hooks, q.secrets], ['Floor clerk', '0', 'SECRET VOICE', ['SECRET HOOK'], ['SECRET SECRET']]);
  const l = pack.library.location[0];
  assert.deepEqual([l.monsters, l.npcs, l.bosses], [['goblin', 'rat'], ['quill'], ['porter']]);
  const again = deserializePack(serializePack(pack));
  assert.deepEqual(again.library.monster, pack.library.monster);
  assert.deepEqual(again.library.npc, pack.library.npc);
});

test('bestiary never reaches phones or the TV: player / stage library has no monsters, npcs, bosses, locations', () => {
  const { s, pid } = base();
  const gv = viewFor(s, pack, 'gm');
  assert.equal(gv.library.monster.length, 2);
  assert.equal(gv.library.npc.length, 1);
  for (const v of Object.values(views(s, pid))) {
    for (const k of ['monster', 'npc', 'boss', 'location']) assert.deepEqual(v.library[k], [], k);
    assert.doesNotMatch(JSON.stringify(v), SECRETS);
  }
});

test('homebrew monster / npc via lib.upsert: strict validation, pack ids read-only', () => {
  const { s } = base();
  const r = gm(s, { t: 'lib.upsert', kind: 'monster', entry: { name: 'Mop Wraith', hpSlots: 5, attacks: [{ name: 'Swab', toHit: 2, damage: '1d6' }], tactics: 'x' } });
  assert.equal(r.result.created, true);
  const e = r.state.library.monster[0];
  assert.equal(e.attacks[0].damage, '1d6');
  assert.equal(e.source, 'homebrew');
  assert.throws(() => gm(s, { t: 'lib.upsert', kind: 'monster', entry: { name: 'Bad', attacks: [{ name: 'X', damage: '1d' }] } }), /damage/);
  assert.throws(() => gm(s, { t: 'lib.upsert', kind: 'monster', entry: { name: 'Bad', hpSlots: 0 } }), /hpSlots/);
  assert.throws(() => gm(s, { t: 'lib.upsert', kind: 'monster', entry: { id: 'goblin', name: 'Goblin' } }), /read-only/);
  const r2 = gm(r.state, { t: 'lib.upsert', kind: 'npc', entry: { name: 'Mordecai', role: 'Guide', secrets: ['hidden'], hooks: ['quest'] } });
  assert.deepEqual(r2.state.library.npc[0].secrets, ['hidden']);
  const s3 = gm(r2.state, { t: 'lib.remove', kind: 'monster', id: e.id }).state;
  assert.equal(s3.library.monster.length, 0);
});

test('combat.start adds every crawler; addMob numbers copies and starts hidden; views filter hidden + GM fields', () => {
  let { s, pid, pid2 } = base();
  assert.equal(viewFor(s, pack, 'gm').combat.active, false);
  s = gm(s, { t: 'combat.addMob', sourceId: 'goblin' }).state;
  assert.deepEqual(mobs(s).map((m) => m.name), ['Goblin']);
  s = gm(s, { t: 'combat.addMob', sourceId: 'goblin', count: 2 }).state;
  assert.deepEqual(mobs(s).map((m) => m.name), ['Goblin 1', 'Goblin 2', 'Goblin 3'], 'the lone first copy is renumbered');
  s = gm(s, { t: 'combat.start' }).state;
  const c = s.combat;
  assert.equal(c.active, true);
  assert.deepEqual(c.combatants.slice(0, 2).map((x) => x.playerId), [pid, pid2], 'crawlers first');
  assert.deepEqual(c.phases, ['Crawlers', 'Mobs']);
  assert.equal(c.phasesVerified, false);
  const m = mobs(s)[0];
  assert.deepEqual([m.hp, m.hpMax, m.evade, m.dr, m.hidden], [4, 4, 2, 1, true]);

  const gv = viewFor(s, pack, 'gm').combat;
  assert.equal(gv.combatants.length, 5);
  assert.equal(gv.combatants[0].hp, 10);
  assert.equal(gv.combatants[2].attacks[0].name, 'Stab');
  for (const v of Object.values(views(s, pid))) {
    assert.equal(v.combat.combatants.length, 2, 'hidden mobs are GM-only');
    assert.equal(v.combat.round, 1);
    assert.equal(v.combat.phase, 'Crawlers');
  }

  s = gm(s, { t: 'combat.update', uid: m.uid, notes: 'SECRET mob note' }).state;
  const rev = gm(s, { t: 'combat.reveal', uid: m.uid });
  assert.ok(rev.events.some((e) => e.event.kind === 'combat.reveal' && e.to === 'all'));
  s = rev.state;
  for (const v of Object.values(views(s, pid))) {
    const mob = v.combat.combatants.find((x) => x.type === 'mob');
    assert.deepEqual(Object.keys(mob).sort(), ['boss', 'conditions', 'down', 'group', 'hpPct', 'image', 'name', 'type', 'uid']);
    assert.equal(mob.name, 'Goblin 1');
    assert.equal(mob.hpPct, 1);
    assert.doesNotMatch(JSON.stringify(v), SECRETS);
    assert.equal(JSON.stringify(v.combat).includes('Stab'), false, 'no attacks');
  }
  s = gm(s, { t: 'combat.set', showMobHp: true }).state;
  const mob = viewFor(s, pack, 'stage').combat.combatants.find((x) => x.type === 'mob');
  assert.deepEqual([mob.hp, mob.hpMax], [4, 4]);
  s = gm(s, { t: 'combat.reveal', all: true }).state;
  assert.equal(viewFor(s, pack, 'stage').combat.combatants.length, 5);
  s = gm(s, { t: 'combat.reveal', uid: m.uid, on: false }).state;
  assert.equal(viewFor(s, pack, 'stage').combat.combatants.length, 4);
});

test('hpFraction rounds up to 5 % and is 0 only when down', () => {
  assert.equal(hpFraction(4, 4), 1);
  assert.equal(hpFraction(1, 30), 0.05);
  assert.equal(hpFraction(0, 4), 0);
  assert.equal(hpFraction(2, 3), 0.7);
});

test('combat.next: phase → next phase → next round; combat.set phases; combat.end keeps settings', () => {
  let { s } = base();
  s = gm(s, { t: 'combat.start' }).state;
  let r = gm(s, { t: 'combat.next' });
  assert.deepEqual([r.state.combat.round, r.state.combat.phaseIndex], [1, 1]);
  assert.ok(r.events.some((e) => e.event.kind === 'combat.phase' && e.event.phase === 'Mobs'));
  r = gm(r.state, { t: 'combat.next' });
  assert.deepEqual([r.state.combat.round, r.state.combat.phaseIndex], [2, 0]);
  s = gm(r.state, { t: 'combat.set', phases: ['Fast', 'Slow', 'Mobs'], phaseIndex: 2 }).state;
  assert.equal(viewFor(s, pack, 'stage').combat.phase, 'Mobs');
  assert.throws(() => gm(s, { t: 'combat.set', phases: [] }), /phases/);
  assert.throws(() => gm(s, { t: 'combat.set', phaseIndex: 3 }), /phaseIndex/);
  s = gm(s, { t: 'combat.addMob', sourceId: 'rat' }).state;
  s = gm(s, { t: 'combat.end' }).state;
  assert.deepEqual([s.combat.active, s.combat.combatants.length, s.combat.round], [false, 0, 1]);
  assert.deepEqual(s.combat.phases, ['Fast', 'Slow', 'Mobs']);
});

test('combat.damage / heal: crawlers go through the sheet (track.set), mobs clamp, hidden hits are GM-only', () => {
  let { s, pid } = base();
  s = gm(s, { t: 'combat.start' }).state;
  s = gm(s, { t: 'combat.addMob', sourceId: 'goblin' }).state;
  const crawler = s.combat.combatants[0];
  const m = mobs(s)[0];
  let r = gm(s, { t: 'combat.damage', uid: crawler.uid, amount: 3 });
  assert.equal(r.state.players[0].sheet.tracks.hp.cur, 7, 'the sheet is the source of truth');
  assert.ok(r.events.some((e) => e.event.kind === 'stat' && e.event.playerId === pid && e.event.to === 7));
  assert.ok(r.events.some((e) => e.event.kind === 'combat.hit' && e.event.type === 'crawler' && e.to === 'all'));
  assert.equal(viewFor(r.state, pack, 'player', { playerId: pid }).combat.combatants[0].hp, 7);
  r = gm(r.state, { t: 'combat.heal', uid: crawler.uid, amount: 99 });
  assert.equal(r.state.players[0].sheet.tracks.hp.cur, 10);

  r = gm(r.state, { t: 'combat.damage', uid: m.uid, amount: 2 });
  const hit = r.events.find((e) => e.event.kind === 'combat.hit');
  assert.deepEqual(hit.to, { roles: ['gm'] }, 'hidden mob: GM only');
  assert.equal(mobs(r.state)[0].hp, 2);
  r = gm(gm(r.state, { t: 'combat.reveal', uid: m.uid }).state, { t: 'combat.damage', uid: m.uid, amount: 9 });
  assert.equal(mobs(r.state)[0].hp, 0);
  assert.equal(r.events.find((e) => e.event.kind === 'combat.hit').to, 'all');
  assert.ok(r.state.feed.some((f) => f.text === 'Goblin is down'));
  assert.equal(viewFor(r.state, pack, 'stage').combat.combatants.find((x) => x.type === 'mob').down, true);
  r = gm(r.state, { t: 'combat.heal', uid: m.uid });
  assert.equal(mobs(r.state)[0].hp, 1);
  assert.throws(() => gm(r.state, { t: 'combat.damage', uid: m.uid, amount: 0 }), /amount/);
  assert.throws(() => gm(r.state, { t: 'combat.damage', uid: 'nope' }), /no combatant/);
  assert.throws(() => gm(r.state, { t: 'combat.update', uid: crawler.uid, hp: 1 }), /crawler/);
});

test('combat.condition: chips on mobs (buff library or free text), buffs on crawler sheets', () => {
  let { s, pid } = base();
  s = gm(s, { t: 'combat.start' }).state;
  s = gm(s, { t: 'combat.addMob', sourceId: 'goblin', hidden: false }).state;
  const m = mobs(s)[0];
  const crawler = s.combat.combatants[0];
  s = gm(s, { t: 'combat.condition', uid: m.uid, buffId: 'prone', on: true }).state;
  s = gm(s, { t: 'combat.condition', uid: m.uid, buffId: 'prone', on: true }).state;
  s = gm(s, { t: 'combat.condition', uid: m.uid, name: 'On fire', on: true }).state;
  assert.deepEqual(mobs(s)[0].conditions, [{ id: 'prone', name: 'Prone' }, { id: null, name: 'On fire' }]);
  assert.deepEqual(viewFor(s, pack, 'stage').combat.combatants.find((x) => x.type === 'mob').conditions.map((c) => c.name), ['Prone', 'On fire']);
  s = gm(s, { t: 'combat.condition', uid: m.uid, name: 'on FIRE', on: false }).state;
  assert.deepEqual(mobs(s)[0].conditions.map((c) => c.name), ['Prone']);
  assert.throws(() => gm(s, { t: 'combat.condition', uid: m.uid, buffId: 'nope', on: true }), /unknown buff/);

  s = gm(s, { t: 'combat.condition', uid: crawler.uid, buffId: 'bleeding', on: true }).state;
  assert.deepEqual(s.players[0].sheet.buffs.map((b) => b.buffId), ['bleeding']);
  assert.deepEqual(viewFor(s, pack, 'player', { playerId: pid }).me.sheet.buffs.map((b) => b.name), ['Bleeding']);
  assert.deepEqual(viewFor(s, pack, 'stage').combat.combatants[0].conditions.map((c) => c.name), ['Bleeding']);
  s = gm(s, { t: 'combat.condition', uid: crawler.uid, buffId: 'bleeding', on: false }).state;
  assert.deepEqual(s.players[0].sheet.buffs, []);
});

test('combat.mobRoll: d20 + toHit and damage via the dice log, GM-secret by default, public on request', () => {
  let { s, pid } = base();
  s = gm(s, { t: 'combat.addMob', sourceId: 'goblin' }).state;
  const m = mobs(s)[0];
  const rollInt = () => 9; // d20 → 10, d4 → 10 % 4 … whatever the dice code does: deterministic
  let r = gm(s, { t: 'combat.mobRoll', uid: m.uid, attackIndex: 0 }, { rollInt });
  const rolls = r.state.rolls;
  assert.equal(rolls.length, 2);
  assert.equal(rolls[0].label, 'Goblin: Stab');
  assert.equal(rolls[0].formula, 'd20+3');
  assert.equal(rolls[1].label, 'Goblin: Stab damage');
  assert.ok(rolls.every((x) => x.secret && x.by === 'gm'));
  assert.equal(r.result.total, rolls[0].total);
  assert.deepEqual(r.result.buffs, ['bleeding']);
  assert.ok(r.events.filter((e) => e.event.kind === 'roll').every((e) => JSON.stringify(e.to) === JSON.stringify({ roles: ['gm'] })));
  assert.deepEqual(viewFor(r.state, pack, 'player', { playerId: pid }).rolls, []);
  assert.deepEqual(viewFor(r.state, pack, 'stage').rolls, []);
  r = gm(r.state, { t: 'combat.mobRoll', uid: m.uid, attackIndex: 1, public: true }, { rollInt });
  assert.equal(r.state.rolls.length, 3, 'damage "0" is not rolled');
  assert.equal(r.result.damageRollId, null);
  assert.equal(viewFor(r.state, pack, 'stage').rolls.length, 1);
  assert.throws(() => gm(r.state, { t: 'combat.mobRoll', uid: m.uid, attackIndex: 5 }), /attackIndex/);
  const ad = gm(r.state, { t: 'combat.addAdhoc', name: 'Blob', hp: 3 });
  assert.throws(() => gm(ad.state, { t: 'combat.mobRoll', uid: ad.result.uids[0] }), /no attacks/);
});

test('combat.addAdhoc: validated, numbered, attacks optional', () => {
  let { s } = base();
  const r = gm(s, { t: 'combat.addAdhoc', name: 'Cultist', hp: 5, evade: 1, count: 2, hidden: false, attacks: [{ name: 'Knife', toHit: 2, damage: '1d4' }] });
  s = r.state;
  assert.deepEqual(mobs(s).map((m) => [m.name, m.hp, m.evade, m.hidden, m.attacks.length]), [['Cultist 1', 5, 1, false, 1], ['Cultist 2', 5, 1, false, 1]]);
  assert.throws(() => gm(s, { t: 'combat.addAdhoc', name: 'X', hp: 0 }), /hp/);
  assert.throws(() => gm(s, { t: 'combat.addAdhoc', hp: 3 }), /name/);
  assert.throws(() => gm(s, { t: 'combat.addMob', sourceId: 'nope' }), /no monster/);
  s = gm(s, { t: 'combat.remove', uid: r.result.uids[0] }).state;
  assert.deepEqual(mobs(s).map((m) => m.name), ['Cultist 2']);
});

test('boss combatant: damage also moves the boss scene HP when that boss is on the TV', () => {
  let { s } = base();
  s = gm(s, { t: 'scene.set', kind: 'boss', data: { bossId: 'porter' } }).state;
  const r0 = gm(s, { t: 'combat.addMob', sourceId: 'porter', hidden: false });
  s = r0.state;
  const uid = r0.result.uids[0];
  const m = mobs(s)[0];
  assert.deepEqual([m.sourceKind, m.hp, m.evade, m.attacks[0].name], ['boss', 20, 2, 'Hurl']);
  assert.equal(viewFor(s, pack, 'gm').combat.combatants[0].linked, true);
  assert.equal(viewFor(s, pack, 'stage').combat.combatants[0].boss, true, 'TV knows it is a boss (crawlers join on start)');
  let r = gm(s, { t: 'combat.damage', uid, amount: 3 });
  assert.equal(mobs(r.state)[0].hp, 17);
  assert.equal(r.state.scene.data.hp, 17);
  assert.ok(r.events.some((e) => e.event.kind === 'boss.hit'));
  r = gm(r.state, { t: 'combat.heal', uid, amount: 1 });
  assert.equal(r.state.scene.data.hp, 18);
  s = gm(r.state, { t: 'scene.set', kind: 'lobby' }).state;
  r = gm(s, { t: 'combat.damage', uid, amount: 1 });
  assert.equal(mobs(r.state)[0].hp, 17);
  assert.ok(!r.events.some((e) => e.event.kind === 'boss.hit'), 'not linked when the scene is something else');
  assert.doesNotMatch(JSON.stringify(viewFor(r.state, pack, 'stage')), SECRETS);
});

test('permissions: players and the stage cannot run combat or npc actions', () => {
  const { s, pid } = base();
  for (const t of ['combat.start', 'combat.addMob', 'combat.damage', 'combat.reveal', 'combat.mobRoll', 'combat.set', 'npc.say']) {
    assert.throws(() => reducePlayerAction(s, { t, sourceId: 'goblin', uid: 'x', text: 'hi' }, { ...ctx(), playerId: pid }), /unknown action/);
    assert.throws(() => reduce(s, { role: 'stage', t }, ctx()), /unknown action/);
  }
});

test('combat scene + npc scene: TV-safe data only; npc.say subtitles in the NPC name', () => {
  let { s, pid } = base();
  s = gm(s, { t: 'scene.set', kind: 'combat', data: { title: 'Lobby brawl' } }).state;
  assert.deepEqual(s.scene.data, { title: 'Lobby brawl', showParty: true });
  assert.throws(() => gm(s, { t: 'scene.set', kind: 'combat', data: { mobs: [] } }), /unknown field/);
  s = gm(s, { t: 'scene.set', kind: 'npc', data: { npcId: 'quill' } }).state;
  assert.deepEqual(s.scene.data.npc, { name: 'Fennimore Quill', role: 'Floor clerk', image: null, floor: '0' });
  for (const v of [viewFor(s, pack, 'stage'), viewFor(s, pack, 'player', { playerId: pid })]) assert.doesNotMatch(JSON.stringify(v), SECRETS);
  const r = gm(s, { t: 'npc.say', text: 'Per policy, welcome.' });
  assert.equal(r.state.scene.data.line, 'Per policy, welcome.');
  const ev = r.events.find((e) => e.event.kind === 'npc.say');
  assert.deepEqual([ev.event.name, ev.event.text, ev.event.npcId], ['Fennimore Quill', 'Per policy, welcome.', 'quill']);
  assert.deepEqual(ev.to, { roles: ['stage', 'gm'] });
  s = gm(r.state, { t: 'scene.set', kind: 'lobby' }).state;
  const r2 = gm(s, { t: 'npc.say', npcId: 'quill', text: 'Hello from off-screen.' });
  assert.equal(r2.events[0].event.name, 'Fennimore Quill');
  assert.throws(() => gm(s, { t: 'npc.say', text: 'hi' }), /npcId or name/);
  assert.equal(gm(s, { t: 'npc.say', name: 'A voice', text: 'hi' }).events[0].event.name, 'A voice');
  assert.throws(() => gm(s, { t: 'scene.set', kind: 'npc', data: {} }), /npc scene needs/);
  assert.equal(gm(s, { t: 'scene.set', kind: 'npc', data: { npc: { name: 'Mordecai', role: 'Guide' } } }).state.scene.data.npc.name, 'Mordecai');
});

test('persistence: old saves get an idle tracker; a running fight survives normalizeState', () => {
  let { s } = base();
  const { combat, ...old } = s;
  assert.equal(normalizeState(old, pack).combat.active, false);
  s = gm(s, { t: 'combat.start' }).state;
  s = gm(s, { t: 'combat.addMob', sourceId: 'goblin', count: 2 }).state;
  s = gm(s, { t: 'combat.next' }).state;
  const back = normalizeState(JSON.parse(JSON.stringify(s)), pack);
  assert.deepEqual(back.combat, s.combat);
  const junk = normalizeState({ ...s, combat: { combatants: [{ uid: 1 }, null, { uid: 'x', type: 'mob' }], phases: 'x', round: -2 } }, pack).combat;
  assert.equal(junk.combatants.length, 1);
  assert.deepEqual(junk.phases, ['Crawlers', 'Mobs']);
  assert.equal(junk.round, 1);
});

test('a boss added to the fight uses its square crop (imageSquare); the boss scene keeps imageKo', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const d2 = writePack(tmpDir(), { 'bosses.json': [{ id: 'grim', name: 'Grim', image: 'grim.webp', imageSquare: 'grim_sq.webp', imageKo: 'grim_ko.webp', hpSlots: 8 }] });
  fs.mkdirSync(path.join(d2, 'images'), { recursive: true });
  for (const f of ['grim.webp', 'grim_sq.webp', 'grim_ko.webp']) fs.writeFileSync(path.join(d2, 'images', f), 'x');
  const p2 = loadPack(d2).pack;
  const c2 = { now: 1_000_000, rng: seq(0.5), genId: (p) => `${p}_${++n}`, pack: p2 };
  let s = createState(p2, 0);
  s = reduce(s, { role: 'gm', t: 'combat.addMob', sourceId: 'grim', hidden: false }, c2).state;
  assert.equal(s.combat.combatants.find((x) => x.type === 'mob').image, '/pack/images/grim_sq.webp');
  s = reduce(s, { role: 'gm', t: 'scene.set', kind: 'boss', data: { bossId: 'grim' } }, c2).state;
  const boss = viewFor(s, p2, 'stage').scene.data.boss;
  assert.equal(boss.image, '/pack/images/grim.webp');
  assert.equal(boss.imageKo, '/pack/images/grim_ko.webp');
});

test('lib.art: GM art pick for a read-only pack monster flows into the library and new combatants; null resets', () => {
  let { s } = base();
  s = gm(s, { t: 'lib.art', kind: 'monster', id: 'goblin', image: '/pack/images/ui/fx_crit.webp' }).state;
  const v = viewFor(s, pack, 'gm');
  const g = v.library.monster.find((x) => x.id === 'goblin');
  assert.equal(g.image, '/pack/images/ui/fx_crit.webp');
  assert.equal(g.artPick, true);
  s = gm(s, { t: 'combat.addMob', sourceId: 'goblin', hidden: false }).state;
  assert.equal(mobs(s)[0].image, '/pack/images/ui/fx_crit.webp');
  // a goblin already fighting follows a new pick
  s = gm(s, { t: 'lib.art', kind: 'monster', id: 'goblin', image: '/pack/images/b.webp' }).state;
  assert.equal(mobs(s)[0].image, '/pack/images/b.webp');
  s = gm(s, { t: 'lib.art', kind: 'monster', id: 'goblin', image: '/pack/images/ui/fx_crit.webp' }).state;
  assert.throws(() => gm(s, { t: 'lib.art', kind: 'monster', id: 'goblin', image: 'javascript:alert(1)' }), /image must be/);
  assert.throws(() => gm(s, { t: 'lib.art', kind: 'monster', id: 'nope', image: '/pack/images/x.webp' }), /no pack monster/);
  assert.throws(() => gm(s, { t: 'lib.art', kind: 'item', id: 'goblin', image: '/pack/images/x.webp' }), /kind must be/);
  s = gm(s, { t: 'lib.art', kind: 'monster', id: 'goblin', image: null }).state;
  assert.equal(viewFor(s, pack, 'gm').library.monster.find((x) => x.id === 'goblin').image, null);
  // survives a save/load round trip, junk dropped
  const raw = JSON.parse(JSON.stringify({ ...s, libArt: { monster: { goblin: '/pack/images/a.webp', 'bad id!': '/pack/x.webp', rat: 'ftp://x' } } }));
  const back = normalizeState(raw, pack, 0);
  assert.deepEqual(back.libArt.monster, { goblin: '/pack/images/a.webp' });
});

test('ad-hoc mobs and combat.update take an image from the art gallery', () => {
  let { s } = base();
  let r = gm(s, { t: 'combat.addAdhoc', name: 'Pet Rock', hp: 3, image: '/pack/images/icon_thrown_pet_rock.webp' });
  s = r.state;
  const uid = r.result.uids[0];
  assert.equal(mobs(s)[0].image, '/pack/images/icon_thrown_pet_rock.webp');
  s = gm(s, { t: 'combat.update', uid, image: null }).state;
  assert.equal(mobs(s)[0].image, null);
  assert.throws(() => gm(s, { t: 'combat.update', uid, image: 'data:text/html,x' }), /image must be/);
});

test('session.aiMute: AUTO goes off and cannot come back while muted; survives session.new; visible to the TV', () => {
  let { s } = base();
  s = gm(s, { t: 'session.auto', on: true }).state;
  s = gm(s, { t: 'session.aiMute', on: true }).state;
  assert.equal(s.session.aiMute, true);
  assert.equal(s.session.auto, false);
  assert.throws(() => gm(s, { t: 'session.auto', on: true }), /muted/);
  assert.equal(viewFor(s, pack, 'stage').session.aiMute, true);
  s = gm(s, { t: 'session.new' }).state;
  assert.equal(s.session.aiMute, true);
  s = gm(s, { t: 'session.aiMute', on: false }).state;
  s = gm(s, { t: 'session.auto', on: true }).state;
  assert.equal(s.session.auto, true);
  assert.equal(normalizeState(JSON.parse(JSON.stringify({ ...s, session: { ...s.session, aiMute: 'yes' } })), pack, 0).session.aiMute, false);
});

test('TV pace: rooms on the old 2.0 s default move to 2.8 s once; an explicit pick sticks', () => {
  let { s } = base();
  const old = normalizeState(JSON.parse(JSON.stringify({ ...s, combat: { ...s.combat, settings: { ...s.combat.settings, stepMs: 2000, paceV: undefined } } })), pack, 0);
  assert.equal(old.combat.settings.stepMs, 2800);
  s = gm(s, { t: 'combat.set', settings: { stepMs: 2000 } }).state;
  assert.equal(s.combat.settings.stepMs, 2000);
  assert.equal(normalizeState(JSON.parse(JSON.stringify(s)), pack, 0).combat.settings.stepMs, 2000);
});

test('boss panel damage / heal moves the boss combatant in the running fight too', () => {
  let { s } = base();
  s = gm(s, { t: 'scene.set', kind: 'boss', data: { bossId: 'porter' } }).state;
  s = gm(s, { t: 'combat.addMob', sourceId: 'porter', hidden: false }).state;
  s = gm(s, { t: 'player.add', name: 'Carl' }).state;
  s = gm(s, { t: 'combat.start' }).state;
  s = gm(s, { t: 'boss.damage', amount: 4 }).state;
  assert.equal(mobs(s)[0].hp, 16);
  assert.equal(s.scene.data.hp, 16);
  s = gm(s, { t: 'boss.heal', amount: 2 }).state;
  assert.equal(mobs(s)[0].hp, 18);
});

test('loot from the dead: a downed mob drops its lootItems, the GM hands them out; a dead crawler drops their inventory', () => {
  let { s, pid, pid2 } = base();
  let r = gm(s, { t: 'combat.addMob', sourceId: 'goblin', hidden: false });
  s = r.state;
  const uid = r.result.uids[0];
  s = gm(s, { t: 'combat.start' }).state;
  assert.throws(() => gm(s, { t: 'loot.corpse', uid }), /still standing/);
  s = gm(s, { t: 'combat.damage', uid, amount: 9 }).state;
  r = gm(s, { t: 'loot.corpse', uid });
  s = r.state;
  const drop = s.drops[0];
  assert.deepEqual(drop.items.map((x) => x.itemId), ['duck']);
  const tv = r.events.find((e) => e.event.kind === 'loot.drop');
  assert.equal(tv.to, 'all');
  assert.deepEqual(tv.event.items.map((x) => x.name), ['Duck']);
  assert.throws(() => gm(s, { t: 'loot.corpse', uid }), /already looted/);
  r = gm(s, { t: 'loot.take', dropId: drop.id, key: drop.items[0].key, playerId: pid });
  s = r.state;
  assert.ok(s.players[0].inventory.some((i) => i.itemId === 'duck'));
  assert.ok(r.events.some((e) => e.event.kind === 'loot.take' && e.event.name === 'Carl'));
  assert.throws(() => gm(s, { t: 'loot.take', dropId: drop.id, key: drop.items[0].key, playerId: pid2 }), /already taken/);
  assert.equal(viewFor(s, pack, 'gm').gm.drops.length, 1);
  assert.equal(viewFor(s, pack, 'stage').gm, undefined, 'piles are GM-only (the TV gets events)');
  // GM's own pick for a mob with no list
  // a dead crawler: Carl (has the duck) goes down, Donut takes the duck from the body
  const carl = s.combat.combatants.find((x) => x.type === 'crawler' && x.playerId === pid);
  s = gm(s, { t: 'combat.damage', uid: carl.uid, amount: 99 }).state;
  r = gm(s, { t: 'loot.corpse', uid: carl.uid });
  s = r.state;
  const body = s.drops[1];
  assert.equal(body.from.type, 'crawler');
  s = gm(s, { t: 'loot.take', dropId: body.id, key: body.items[0].key, playerId: pid2 }).state;
  assert.ok(!s.players[0].inventory.some((i) => i.itemId === 'duck'), 'moved, not copied');
  assert.ok(s.players[1].inventory.some((i) => i.itemId === 'duck'));
  // survives save / load; session.new clears
  assert.equal(normalizeState(JSON.parse(JSON.stringify(s)), pack, 0).drops.length, 2);
  s = gm(s, { t: 'loot.clear', dropId: body.id }).state;
  assert.equal(s.drops.length, 1);
  s = gm(s, { t: 'session.new' }).state;
  assert.equal(s.drops.length, 0);
});
