// Rulesets per campaign: built-in 5e / 5e 2024 / PF2e rules, content conversion, initiative, dice entry, undo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { createState, normalizeState, reduce, viewFor } from '../state.js';
import { packForRuleset, rulesetChoices, convertMonster, convertText, diceAvg, diceFor, tierOf, numbersFor, BUILTIN_IDS } from '../systems.js';
import { attackOutcome, combatRules } from '../outcome.js';
import { tmpDir, writePack, seq } from './fixtures.js';

const monsters = [
  { id: 'gob', name: 'Goblin', floor: 1, hpSlots: 4, evade: 1, dr: 1, attacks: [{ name: 'Stab', toHit: 3, damage: '1d6' }], desc: 'Small.' },
  { id: 'brute', name: 'Brute', floor: 2, hpSlots: 10, evade: 2, dr: 2, attacks: [{ name: 'Smash', toHit: 4, damage: '2d6+1', effects: 'Target rolls STR (difficulty 13) or is knocked 2 squares back.' }] },
];
const bosses = [
  { id: 'king', name: 'King', floor: 1, hpSlots: 20, evade: 2, dr: 2, phases: [{ name: 'One', atHp: 20, text: 'Hi.' }, { name: 'Two', atHp: 10, text: '+1 to hit, -1 Evade.' }], attacks: [{ name: 'Crown toss', toHit: 4, damage: '1d6', effects: 'Target rolls DEX (difficulty 12) or falls prone.' }] },
];
const ruleset = {
  id: 'crawl', stats: [{ id: 'dex', label: 'Dexterity', abbr: 'DEX', default: { enhanced: 10, unenhanced: 10 } }, { id: 'str', label: 'Strength', abbr: 'STR', default: { enhanced: 10, unenhanced: 10 } }],
  statMod: { from: 'enhanced', formula: 'floor((x - 10) / 2)' },
  derived: [{ id: 'evade', label: 'Evade', formula: 'mod.dex + buff.evade', roll: 'd20' }, { id: 'dr', label: 'DR', formula: 'buff.dr' }],
  tracks: [{ id: 'hp', label: 'Health', kind: 'slots', slots: 10, default: 10 }],
  slots: [{ id: 'torso', label: 'Torso', max: 1 }, { id: 'hands', label: 'Hands', max: 2 }],
  skills: { catalog: [{ id: 'sneak', name: 'Sneak', stat: 'dex', checkType: 'Standard' }] },
};
const items = [
  { id: 'vest', name: 'Vest', rarity: 'common', slot: 'torso', effects: [{ target: 'evade', value: 2 }, { target: 'dr', value: 1 }, { target: 'skill.sneak', value: 1 }, { target: 'move', value: 1 }] },
  { id: 'potion', name: 'Potion', rarity: 'common', use: { track: 'hp', delta: 3 } },
];
const { pack } = loadPack(writePack(tmpDir(), { 'monsters.json': monsters, 'bosses.json': bosses, 'ruleset.json': ruleset, 'items.json': items }));
let n = 0;
const ctx = (now = 1_000_000) => ({ now, rng: seq(0.5), genId: (x) => `${x}_${++n}`, pack, rollInt: () => 9 });
const gm = (s, a) => reduce(s, { role: 'gm', ...a }, ctx());
const pl = (s, id, a) => reduce(s, { role: 'player', actorId: id, ...a }, ctx());

test('every pack offers its own ruleset plus the three built-ins; campaigns keep their ruleset', () => {
  assert.deepEqual(rulesetChoices(pack).map((c) => c.id), ['crawl', ...BUILTIN_IDS]);
  assert.deepEqual(BUILTIN_IDS, ['dnd5e', 'dnd2024', 'pf2e']);
  const st = createState(pack, 0, { ruleset: 'pf2e', name: 'Abomination Vaults' });
  assert.equal(st.campaign.ruleset, 'pf2e');
  assert.equal(st.campaign.name, 'Abomination Vaults');
  const back = normalizeState(JSON.parse(JSON.stringify(st)), pack, 1);
  assert.equal(back.campaign.ruleset, 'pf2e');
  assert.equal(normalizeState({ campaign: { ruleset: 'nope' } }, pack, 1).campaign.ruleset, 'crawl', 'unknown ruleset falls back to the pack');
  assert.equal(createState(pack, 0).campaign.ruleset, 'crawl', 'default = the pack ruleset, unchanged');
  assert.equal(packForRuleset(pack, 'crawl'), pack);
  assert.equal(packForRuleset(pack, 'dnd5e'), packForRuleset(pack, 'dnd5e'), 'cached');
});

test('5e sheet: six abilities, 18 skills, proficiency, saves, AC, fixed HP', () => {
  let s = createState(pack, 0, { ruleset: 'dnd5e' });
  const r = gm(s, { t: 'player.add', name: 'Vex' });
  s = r.state;
  const id = r.result.playerId;
  s = gm(s, { t: 'sheet.set', playerId: id, path: 'stats.dex.score', value: 16 }).state;
  s = gm(s, { t: 'sheet.set', playerId: id, path: 'stats.con.score', value: 14 }).state;
  s = gm(s, { t: 'sheet.set', playerId: id, path: 'fields.save_dex', value: 1 }).state;
  const me = viewFor(s, pack, 'player', { playerId: id }).me;
  const c = me.sheet.computed;
  assert.equal(me.sheet.skills?.length ?? s.players[0].sheet.skills.length, 18);
  assert.equal(c.derived.prof.value, 2);
  assert.equal(c.derived.ac.value, 13, '10 + DEX 3');
  assert.equal(c.derived.save_dex.value, 5, 'DEX 3 + proficiency 2');
  assert.equal(c.derived.save_str.value, 0);
  assert.equal(c.tracks.hp.max, 10, 'd8 + CON 2 at level 1');
  assert.equal(c.tracks.tempHp.cur, 0, 'temporary HP starts empty');
  const stealth = s.players[0].sheet.skills.find((k) => k.skillId === 'stealth');
  s = gm(s, { t: 'skill.update', playerId: id, uid: stealth.uid, rank: 2 }).state;
  const st2 = viewFor(s, pack, 'gm', {}).gm.playersFull[0].sheet.computed.skills.find((k) => k.uid === stealth.uid);
  assert.equal(st2.total.value, 7, 'expertise: DEX 3 + 2 x 2');
});

test('PF2e sheet: modifiers, proficiency = level + 2 x rank, Perception initiative, ancestry + class HP', () => {
  let s = createState(pack, 0, { ruleset: 'pf2e' });
  const r = gm(s, { t: 'player.add', name: 'Ezren' });
  s = r.state;
  const id = r.result.playerId;
  s = gm(s, { t: 'sheet.set', playerId: id, path: 'stats.dex.mod', value: 3 }).state;
  s = gm(s, { t: 'sheet.set', playerId: id, path: 'stats.wis.mod', value: 1 }).state;
  s = gm(s, { t: 'sheet.set', playerId: id, path: 'stats.con.mod', value: 2 }).state;
  s = gm(s, { t: 'player.update', playerId: id, level: 3 }).state;
  const c = viewFor(s, pack, 'gm', {}).gm.playersFull[0].sheet.computed;
  assert.equal(c.derived.ac.value, 18, '10 + 3 + trained (3 + 2)');
  assert.equal(c.derived.perception.value, 6, 'WIS 1 + 3 + 2');
  assert.equal(c.derived.initiative.value, 6);
  assert.equal(c.tracks.hp.max, 8 + (8 + 2) * 3);
  assert.equal(s.players[0].sheet.skills.length, 17);
});

test('monsters, bosses and items convert to the campaign game; names and art stay', () => {
  const D = packForRuleset(pack, 'dnd5e');
  const gob = D.library.monster.find((m) => m.id === 'gob');
  assert.equal(gob.name, 'Goblin');
  assert.equal(gob.converted.to, 'dnd');
  assert.ok(gob.evade >= 11 && gob.evade <= 14, `AC ${gob.evade}`);
  assert.ok(gob.hpSlots >= 5 && gob.hpSlots <= 15, `HP ${gob.hpSlots}`);
  assert.ok(gob.attacks[0].toHit >= 3 && gob.attacks[0].toHit <= 5);
  assert.match(gob.attacks[0].damage, /^\dd6(\+\d)?$/);
  const brute = D.library.monster.find((m) => m.id === 'brute');
  assert.match(brute.attacks[0].effects, /makes a STR save \(DC \d+\) or is knocked 10 ft back/);
  const king = D.library.boss.find((b) => b.id === 'king');
  assert.equal(king.phases[0].atHp, king.hpSlots, 'phase thresholds scale with the new HP');
  assert.equal(king.phases[1].atHp, Math.round(king.hpSlots / 2));
  assert.match(king.phases[1].text, /-1 AC/);
  const P = packForRuleset(pack, 'pf2e');
  const pk = P.library.boss.find((b) => b.id === 'king');
  assert.ok(pk.evade > king.evade, 'PF2e numbers run higher');
  assert.match(pk.attacks[0].effects, /attempts a Reflex save \(DC \d+\)/);
  const vest = D.itemsById.get('vest');
  assert.equal(vest.slot, 'body', 'torso maps to the armour slot');
  assert.deepEqual(D.ruleset.slots.some((x) => x.id === 'body'), true);
  assert.deepEqual(vest.effects.map((e) => [e.target, e.value]), [['ac', 1], ['ac', 1], ['skill.stealth', 1], ['speed', 5]]);
  assert.equal(D.itemsById.get('potion').use.heal.amount, 8, '3 crawler HP slots heal like a healing potion');
  // the base pack is untouched
  assert.equal(pack.library.monster.find((m) => m.id === 'gob').hpSlots, 4);
});

test('converter helpers', () => {
  assert.equal(diceAvg('2d6+3'), 10);
  assert.equal(diceAvg('0'), 0);
  assert.equal(diceAvg(diceFor(11, 8)) > 9, true);
  assert.equal(diceFor(0), '0');
  assert.equal(convertText('Target rolls CON (difficulty 12), 3 squares.', 'pf2e', { dc: 18 }), 'Target attempts a Fortitude save (DC 18), 15 ft.');
  const t = tierOf({ floor: 3, hpSlots: 2, evade: 1, attacks: [] }, 'monster', 'crawler');
  assert.equal(t.role, 'minion');
  assert.equal(t.level, 5);
  assert.ok(numbersFor(t, 'dnd').hp < numbersFor({ ...t, role: 'standard' }, 'dnd').hp);
  assert.equal(convertMonster(monsters[0], 'monster', 'dnd', packForRuleset(pack, 'dnd5e').ruleset), monsters[0], 'same family: untouched');
});

test('attack outcomes: 5e nat 20 crit / nat 1 miss, PF2e degrees of success', () => {
  const d = combatRules(packForRuleset(pack, 'dnd5e'));
  assert.deepEqual(attackOutcome(d, { d20: 20, total: 5, target: 15 }), { hit: true, crit: true, degree: 3, margin: -10 });
  assert.equal(attackOutcome(d, { d20: 1, total: 30, target: 15 }).hit, false);
  assert.equal(attackOutcome(d, { d20: 10, total: 15, target: 15 }).hit, true, 'meets it, beats it');
  const p = combatRules(packForRuleset(pack, 'pf2e'));
  assert.equal(attackOutcome(p, { d20: 12, total: 25, target: 15 }).crit, true, 'beat by 10');
  assert.equal(attackOutcome(p, { d20: 20, total: 14, target: 15 }).degree, 2, 'nat 20 bumps a failure to a success');
  assert.equal(attackOutcome(p, { d20: 1, total: 16, target: 15 }).degree, 1, 'nat 1 drops a success to a failure');
  const c = combatRules(pack, { hitRule: '>', crit: 'none', evadeBase: 0 });
  assert.equal(attackOutcome(c, { d20: 10, total: 12, target: 12 }).hit, false, 'crawler packs keep the tracker hit rule');
});

function fight(rs) {
  let s = createState(pack, 0, { ruleset: rs });
  const a = gm(s, { t: 'player.add', name: 'A' });
  s = a.state;
  const b = gm(s, { t: 'player.add', name: 'B' });
  s = b.state;
  s = gm(s, { t: 'combat.addMob', sourceId: 'gob', count: 2, hidden: false }).state;
  s = gm(s, { t: 'combat.start' }).state;
  return { s, a: a.result.playerId, b: b.result.playerId };
}

test('initiative: 5e / PF2e fights run in turn order, players roll on the phone, GM can reorder and step turns', () => {
  let { s, a, b } = fight('dnd5e');
  let v = viewFor(s, pack, 'gm', {}).combat;
  assert.equal(v.init.on, true);
  assert.equal(v.init.order.length, 2, 'monsters rolled automatically');
  assert.equal(v.init.waiting.length, 2, 'crawlers wait for their roll');
  s = pl(s, a, { t: 'roll', what: { kind: 'derived', id: 'initiative' }, entered: 18 }).state;
  s = pl(s, b, { t: 'roll', what: { kind: 'derived', id: 'initiative' }, entered: 2 }).state;
  v = viewFor(s, pack, 'gm', {}).combat;
  assert.equal(v.init.order.length, 4);
  const crawlerA = v.combatants.find((x) => x.playerId === a).uid;
  assert.equal(v.init.order[0].uid, crawlerA, 'an entered 18 goes first (mobs rolled 10 + bonus)');
  assert.equal(v.init.turnUid, crawlerA);
  let r = gm(s, { t: 'combat.next' });
  s = r.state;
  assert.equal(r.events.find((e) => e.event.kind === 'combat.turn').event.current.uid, crawlerA, 'first press starts round 1 at the top');
  r = gm(s, { t: 'combat.next' });
  s = r.state;
  const turn = r.events.find((e) => e.event.kind === 'combat.turn').event;
  assert.equal(turn.current.uid, v.init.order[1].uid);
  assert.equal(turn.next.uid, v.init.order[2].uid);
  // GM drags B to the top
  const crawlerB = v.combatants.find((x) => x.playerId === b).uid;
  s = gm(s, { t: 'combat.order', uids: [crawlerB] }).state;
  assert.equal(viewFor(s, pack, 'gm', {}).combat.init.order[0].uid, crawlerB);
  // players do not see initiative totals
  const pv = viewFor(s, pack, 'player', { playerId: a }).combat.init;
  assert.equal(pv.order[0].total, undefined);
  // crawler packs stay phase-based
  assert.equal(viewFor(fight('crawl').s, pack, 'gm', {}).combat.init.on, false);
});

test('dice entry: entered d20 + modifiers vs the monster AC; players see hit/miss, never the AC', () => {
  let { s, a } = fight('dnd5e');
  s = gm(s, { t: 'sheet.set', playerId: a, path: 'stats.str.score', value: 16 }).state;
  s = gm(s, { t: 'attack.add', playerId: a, name: 'Longsword', stat: 'str', dice: '1d8' }).state;
  const atk = s.players[0].sheet.attacks[0];
  const mob = s.combat.combatants.find((x) => x.type === 'mob');
  const ac = mob.evade;
  // natural 9 + STR 3 + prof 2 = 14 vs AC
  const r = pl(s, a, { t: 'roll', what: { kind: 'attack', uid: atk.uid }, entered: 9, target: mob.uid });
  s = r.state;
  const rec = s.rolls.at(-1);
  assert.equal(rec.total, 14);
  assert.equal(rec.entered, true);
  assert.equal(rec.vs.hit, 14 >= ac);
  assert.equal(rec.vs.defense, ac, 'GM sees the AC');
  const playerEv = r.events.find((e) => e.event.kind === 'roll' && e.to?.roles?.includes('player'));
  assert.equal(playerEv.event.vs.defense, undefined, 'players / TV never get the AC');
  assert.equal(playerEv.event.vs.margin, undefined);
  assert.equal(viewFor(s, pack, 'player', { playerId: a }).rolls.at(-1).vs.defense, undefined);
  // too-high entry is refused
  assert.throws(() => pl(s, a, { t: 'roll', what: { kind: 'attack', uid: atk.uid }, entered: 21, target: mob.uid }), /higher than d20/);
  // a natural 20 is a crit; the damage roll after it doubles the dice and lands on the mob
  s = pl(s, a, { t: 'roll', what: { kind: 'attack', uid: atk.uid }, entered: 20, target: mob.uid }).state;
  const critId = s.rolls.at(-1).id;
  assert.equal(s.rolls.at(-1).vs.crit, true);
  const hpBefore = s.combat.combatants.find((x) => x.uid === mob.uid).hp;
  s = pl(s, a, { t: 'roll', what: { kind: 'attack', uid: atk.uid, part: 'damage' }, after: critId, target: mob.uid }).state;
  const dmg = s.rolls.at(-1);
  assert.match(dmg.formula, /2d8/);
  const hpAfter = s.combat.combatants.find((x) => x.uid === mob.uid).hp;
  assert.equal(hpAfter, Math.max(0, hpBefore - dmg.total));
  // undo chip puts the HP back, redo applies it again
  s = gm(s, { t: 'roll.undoLast' }).state;
  assert.equal(s.combat.combatants.find((x) => x.uid === mob.uid).hp, hpBefore);
  assert.ok(s.rolls.at(-1).void);
  s = gm(s, { t: 'roll.redoLast' }).state;
  assert.equal(s.combat.combatants.find((x) => x.uid === mob.uid).hp, hpAfter);
  // the player can take back a misclick
  s = pl(s, a, { t: 'roll.undo' }).state;
  assert.ok(s.rolls.at(-1).void);
});

test('near misses cue the near_fail / near_success lines; advantage keeps the higher die; situational bonus', () => {
  let { s, a } = fight('dnd5e');
  const mob = s.combat.combatants.find((x) => x.type === 'mob');
  s = gm(s, { t: 'combat.update', uid: mob.uid, evade: 15 }).state;
  // d20 13 + DEX 0 + prof 2 = 15 -> exactly; 12 -> 14, missed by 1
  s = gm(s, { t: 'attack.add', playerId: a, name: 'Dagger', stat: 'dex', dice: '1d4' }).state;
  const atk = s.players[0].sheet.attacks[0];
  const miss = pl(s, a, { t: 'roll', what: { kind: 'attack', uid: atk.uid }, entered: 12, target: mob.uid });
  assert.equal(miss.state.rolls.at(-1).vs.hit, false);
  const adv = pl(s, a, { t: 'roll', what: { kind: 'attack', uid: atk.uid }, adv: 'adv', target: mob.uid, bonus: -5 });
  const rec = adv.state.rolls.at(-1);
  assert.equal(rec.adv, 'adv');
  assert.equal(rec.otherDie, 10, 'test rng rolls 10 twice');
  assert.equal(rec.total, 10 + 2 - 5);
  // dc checks
  const chk = pl(s, a, { t: 'roll', what: { kind: 'stat', id: 'dex' }, entered: 14, dc: 15 });
  assert.equal(chk.state.rolls.at(-1).vs.hit, false);
  assert.equal(chk.state.rolls.at(-1).vs.dc, true);
});

test('dice mode per crawler', () => {
  let { s, a } = fight('dnd5e');
  s = pl(s, a, { t: 'dice.mode', mode: 'enter' }).state;
  assert.equal(viewFor(s, pack, 'player', { playerId: a }).me.diceMode, 'enter');
  assert.throws(() => pl(s, a, { t: 'dice.mode', mode: 'telepathy' }), /mode must be/);
});

test('auto mode against a 5e sheet uses AC and no DR', () => {
  let { s } = fight('dnd5e');
  s = gm(s, { t: 'combat.reveal', all: true }).state;
  const r = gm(s, { t: 'combat.auto' });
  const steps = r.state.combat.lastAuto.steps.filter((x) => !x.skipped);
  assert.ok(steps.length >= 1);
  for (const st of steps) {
    assert.equal(st.drValue, 0);
    assert.equal(st.defenseLabel, 'AC');
    assert.equal(st.evade, 10, 'unarmoured AC 10');
  }
});

test('initiative: identical monsters share one roll and sit together; groupInit off rolls each', () => {
  const run = (groupInit) => {
    let k = 0;
    const faces = [2, 17, 11, 5, 14];
    const cx = () => ({ now: 1, rng: seq(0.5), genId: (x) => `${x}_${++n}`, pack, rollInt: () => faces[k++ % faces.length] });
    const g = (s, a) => reduce(s, { role: 'gm', ...a }, cx());
    let s = createState(pack, 0, { ruleset: 'dnd5e' });
    s = g(s, { t: 'combat.addMob', sourceId: 'gob', count: 3, hidden: false }).state;
    s = g(s, { t: 'combat.addMob', sourceId: 'brute', count: 1, hidden: false }).state;
    if (!groupInit) s = g(s, { t: 'combat.set', settings: { groupInit: false } }).state;
    s = g(s, { t: 'combat.start' }).state;
    const v = viewFor(s, pack, 'gm', {}).combat;
    const src = new Map(v.combatants.map((x) => [x.uid, x.name]));
    return v.init.order.map((x) => [src.get(x.uid), x.total]);
  };
  const grouped = run(true);
  const gobs = grouped.filter(([nm]) => /Goblin/.test(nm));
  assert.equal(gobs.length, 3);
  assert.equal(new Set(gobs.map((x) => x[1])).size, 1, 'one total for all goblins');
  const idx = grouped.map(([nm], i) => (/Goblin/.test(nm) ? i : -1)).filter((i) => i >= 0);
  assert.equal(idx[2] - idx[0], 2, 'goblins sit together');
  const solo = run(false).filter(([nm]) => /Goblin/.test(nm));
  assert.ok(new Set(solo.map((x) => x[1])).size > 1, 'each goblin rolls');
});

test('initiative: init.mine — a crawler taps the die face, the server adds the bonus; only for yourself', () => {
  let { s, a, b } = fight('dnd5e');
  const r = pl(s, a, { t: 'init.mine', die: 15 });
  s = r.state;
  assert.equal(r.result.die, 15);
  assert.equal(r.result.total, 15 + r.result.bonus);
  const v = viewFor(s, pack, 'gm', {}).combat;
  const mine = v.combatants.find((x) => x.playerId === a).uid;
  assert.equal(v.init.order.find((x) => x.uid === mine).total, r.result.total);
  assert.equal(r.result.place, v.init.order.findIndex((x) => x.uid === mine) + 1);
  assert.throws(() => pl(s, b, { t: 'init.mine', die: 21 }), /die/);
  // crawler pack with turn order switched on: no "initiative" on the sheet, DEX (or 0) is used
  let c = fight('crawl').s;
  const pid = c.players[0].id;
  assert.throws(() => pl(c, pid, { t: 'init.mine', die: 5 }), /turn order/);
  c = gm(c, { t: 'combat.end' }).state;
  c = gm(c, { t: 'combat.set', settings: { initiative: true } }).state;
  c = gm(c, { t: 'combat.start' }).state;
  assert.equal(Number.isFinite(pl(c, pid, { t: 'init.mine', die: 5 }).result.total), true);
});
