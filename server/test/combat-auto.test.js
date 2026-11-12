// Auto mode ("Mobs act"), targeting, undo and combat endings (server/combat-auto.js).
// Dice are injected with ctx.rollInt (0-based face), targeting with ctx.rng.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { createState, reduce, viewFor } from '../state.js';
import { weightedPick } from '../combat-auto.js';
import { tmpDir, writePack, seq } from './fixtures.js';

const RULESET = {
  id: 'auto-test',
  dice: 'd20',
  stats: [{ id: 'dex', label: 'Dexterity', abbr: 'DEX', parts: ['base'], default: { base: 10 } }],
  statMod: { from: 'base', formula: 'floor((x - 10) / 2)' },
  fields: [
    { id: 'ev', label: 'Evade base', type: 'number', default: 12, group: 'defense' },
    { id: 'armor', label: 'Armor', type: 'number', default: 0, group: 'defense' },
  ],
  derived: [
    { id: 'evade', label: 'Evade', formula: 'field.ev' },
    { id: 'dr', label: 'Damage Resistance', formula: 'field.armor' },
  ],
  tracks: [{ id: 'hp', label: 'Health', kind: 'slots', default: 10 }],
};
const MONSTERS = [
  { id: 'rat', name: 'Rat', hpSlots: 2, evade: 1, attacks: [{ name: 'Bite', toHit: 2, damage: '1d4', buffs: ['bleeding'] }] },
  { id: 'imp', name: 'Imp', hpSlots: 3, attacks: [{ name: 'Poke', toHit: 0, damage: '1d6' }, { name: 'Jeer', toHit: 5, damage: '0' }] },
];
const BUFFS = [{ id: 'bleeding', name: 'Bleeding', tags: ['debuff'] }];
const QUIPS = [
  ...['crawler_down', 'mob_killed', 'mob_crit', 'mob_miss', 'combat_victory', 'combat_defeat', 'combat_special'].map((c) => ({ id: `${c}_1`, category: c, text: `${c} line.` })),
];
const dir = writePack(tmpDir(), { 'ruleset.json': RULESET, 'monsters.json': MONSTERS, 'buffs.json': BUFFS, 'quips.json': QUIPS });
const { pack } = loadPack(dir);

let n = 0;
/** rolls: faces (1-based) in order; rng: targeting / attack picks. */
const ctx = ({ rolls = [10], rng = [0.1] } = {}) => {
  let i = 0;
  return { now: 5_000_000, rng: seq(...rng), rollInt: (sides) => (rolls[i++ % rolls.length] - 1) % sides, genId: (p) => `${p}_${++n}`, pack };
};
const gm = (s, a, o) => reduce(s, { role: 'gm', ...a }, ctx(o));

/** Three crawlers (Carl, Donut, Katia) with 10 HP, Evade 12, DR 0; combat running. */
function setup(mobs = [['rat', 1]]) {
  let s = createState(pack, 0);
  const ids = [];
  for (const name of ['Carl', 'Donut', 'Katia']) { const r = gm(s, { t: 'player.add', name }); s = r.state; ids.push(r.result.playerId); }
  for (const [id, count] of mobs) s = gm(s, { t: 'combat.addMob', sourceId: id, count, hidden: false }).state;
  s = gm(s, { t: 'combat.start' }).state;
  return { s, ids };
}
const crawlers = (s) => s.combat.combatants.filter((x) => x.type === 'crawler');
const mobsOf = (s) => s.combat.combatants.filter((x) => x.type === 'mob');
const hpOf = (s, pid) => viewFor(s, pack, 'gm').combat.combatants.find((x) => x.playerId === pid).hp;

test('weightedPick follows aggro weights', () => {
  const list = [{ x: { aggro: 1 }, n: 'a' }, { x: { aggro: 3 }, n: 'b' }, { x: { aggro: 6 }, n: 'c' }];
  assert.equal(weightedPick(list, () => 0.05).n, 'a'); // 0.5 of 10 → first bucket (0..1)
  assert.equal(weightedPick(list, () => 0.2).n, 'b'); // 2 → (1..4)
  assert.equal(weightedPick(list, () => 0.5).n, 'c'); // 5 → (4..10)
  assert.equal(weightedPick([{ x: { aggro: 0 } }], () => 0.5), null);
});

test('auto: weighted target, d20 + toHit vs Evade, damage − DR applied to the sheet, buffs on hit, dice log public', () => {
  let { s, ids } = setup();
  const [carl, donut] = crawlers(s);
  s = gm(s, { t: 'combat.target', uid: carl.uid, aggro: 1 }).state;
  s = gm(s, { t: 'combat.target', uid: donut.uid, aggro: 9 }).state;
  // weights 1 / 9 / 3 → rng 0.5 * 13 = 6.5 → Donut. d20 = 10 + 2 = 12 vs Evade 12 → hit (>=). 1d4 = 3.
  const r = gm(s, { t: 'combat.auto' }, { rng: [0.5], rolls: [10, 3] });
  const [step] = r.result.sequence;
  assert.equal(step.target, 'Donut');
  assert.deepEqual([step.d20, step.total, step.evade, step.hit, step.damage, step.hpAfter], [10, 12, 12, true, 3, 7]);
  assert.deepEqual(step.buffs, ['Bleeding']);
  s = r.state;
  assert.equal(hpOf(s, ids[1]), 7);
  assert.ok(s.players[1].sheet.buffs.some((b) => b.buffId === 'bleeding'));
  const rolls = s.rolls.slice(-2);
  assert.ok(rolls.every((x) => !x.secret), 'public by default in auto mode');
  assert.match(rolls[0].label, /Rat: Bite → Donut/);
  // stage + GM get the cinematic; TV steps carry no roll ids
  const gmEv = r.events.find((e) => e.event.kind === 'combat.auto' && e.to.roles?.includes('gm'));
  const tvEv = r.events.find((e) => e.event.kind === 'combat.auto' && e.to.roles?.includes('stage'));
  assert.ok(gmEv.event.startAt > 5_000_000 && gmEv.event.stepMs === 2800);
  assert.equal(tvEv.event.steps[0].rollId, undefined);
  assert.equal(s.combat.stats.taken[ids[1]], 3);
});

test('hitRule ">" makes a tie miss; nat 1 always misses, nat 20 always hits and doubles damage (crit)', () => {
  let { s } = setup();
  s = gm(s, { t: 'combat.set', settings: { hitRule: '>' } }).state;
  let step = gm(s, { t: 'combat.auto' }, { rolls: [10] }).result.sequence[0];
  assert.equal(step.total, 12);
  assert.equal(step.hit, false);
  s = gm(s, { t: 'combat.set', settings: { hitRule: '>=' } }).state;
  const based = gm(s, { t: 'combat.set', settings: { evadeBase: 10 } }).state;
  step = gm(based, { t: 'combat.auto' }, { rolls: [19] }).result.sequence[0];
  assert.deepEqual([step.evade, step.total, step.hit], [22, 21, false], 'evadeBase raises the target');
  const big = gm(s, { t: 'combat.set', settings: {} }).state;
  // toHit +2 with nat 1 = 3 → miss regardless
  step = gm(big, { t: 'combat.auto' }, { rolls: [1] }).result.sequence[0];
  assert.deepEqual([step.nat1, step.hit], [true, false]);
  // nat 20 → crit: 1d4 = 2, doubled = 4
  step = gm(big, { t: 'combat.auto' }, { rolls: [20, 2] }).result.sequence[0];
  assert.deepEqual([step.nat20, step.crit, step.damageRoll, step.damageRaw, step.damage], [true, true, 2, 4, 4]);
  const noCrit = gm(big, { t: 'combat.set', settings: { crit: 'none' } }).state;
  assert.equal(gm(noCrit, { t: 'combat.auto' }, { rolls: [20, 2] }).result.sequence[0].damage, 2);
});

test('DR is subtracted, at least drMin on a hit (configurable)', () => {
  let { s, ids } = setup();
  for (const pid of ids) s = gm(s, { t: 'sheet.set', playerId: pid, path: 'fields.armor', value: 5 }).state;
  let step = gm(s, { t: 'combat.auto' }, { rolls: [15, 3] }).result.sequence[0];
  assert.deepEqual([step.drValue, step.damageRoll, step.damage], [5, 3, 1]);
  s = gm(s, { t: 'combat.set', settings: { drMin: 0 } }).state;
  step = gm(s, { t: 'combat.auto' }, { rolls: [15, 3] }).result.sequence[0];
  assert.equal(step.damage, 0);
  assert.equal(hpOf(gm(s, { t: 'combat.auto' }, { rolls: [15, 3] }).state, step.playerId), 10);
});

test("Don't target and downed crawlers are never picked; finishDowned allows the downed", () => {
  let { s, ids } = setup();
  const [carl, donut, katia] = crawlers(s);
  s = gm(s, { t: 'combat.target', uid: carl.uid, noTarget: true }).state;
  s = gm(s, { t: 'combat.damage', uid: donut.uid, amount: 10 }).state; // Donut down
  for (const r of [0.01, 0.5, 0.99]) assert.equal(gm(s, { t: 'combat.auto' }, { rng: [r], rolls: [1] }).result.sequence[0].target, 'Katia');
  s = gm(s, { t: 'combat.target', uid: katia.uid, noTarget: true }).state;
  const none = gm(s, { t: 'combat.auto' }, { rolls: [1] }).result.sequence[0];
  assert.equal(none.skipped, 'no valid target');
  s = gm(s, { t: 'combat.set', settings: { finishDowned: true } }).state;
  assert.equal(gm(s, { t: 'combat.auto' }, { rolls: [1] }).result.sequence[0].target, 'Donut');
  assert.equal(hpOf(s, ids[1]), 0);
});

test('focus and spread target modes; random attack pick', () => {
  let { s } = setup([['rat', 2]]);
  const [carl, donut, katia] = crawlers(s);
  const [r1, r2] = mobsOf(s);
  s = gm(s, { t: 'combat.target', uid: r1.uid, focus: katia.uid }).state;
  assert.equal(mobsOf(s)[0].targetMode, 'focus');
  s = gm(s, { t: 'combat.target', uid: r2.uid, targetMode: 'spread' }).state;
  let seqs = gm(s, { t: 'combat.auto' }, { rolls: [1] }).result.sequence;
  assert.deepEqual(seqs.map((x) => x.target), ['Katia', 'Carl']);
  s = gm(s, { t: 'combat.auto' }, { rolls: [1] }).state;
  seqs = gm(s, { t: 'combat.auto' }, { rolls: [1] }).result.sequence;
  assert.equal(seqs[1].target, 'Donut', 'round robin moves on');
  assert.throws(() => gm(s, { t: 'combat.target', uid: carl.uid, targetMode: 'focus' }), /for mobs/);
  assert.throws(() => gm(s, { t: 'combat.target', uid: r1.uid, focus: r2.uid }), /must be a crawler/);
  // focus target gone → auto
  s = gm(s, { t: 'combat.target', uid: katia.uid, noTarget: true }).state;
  assert.notEqual(gm(s, { t: 'combat.auto' }, { rolls: [1] }).result.sequence[0].target, 'Katia');
  let im = setup([['imp', 1]]).s;
  im = gm(im, { t: 'combat.target', uid: mobsOf(im)[0].uid, attackMode: 'random' }).state;
  assert.equal(gm(im, { t: 'combat.auto' }, { rng: [0.9], rolls: [1] }).result.sequence[0].attack, 'Jeer');
  assert.equal(gm(im, { t: 'combat.auto' }, { rng: [0.1], rolls: [1] }).result.sequence[0].attack, 'Poke');
  void donut;
});

test('hidden mobs: skipped unless includeHidden; the TV copy hides who attacked', () => {
  let { s } = setup();
  s = gm(s, { t: 'combat.addMob', sourceId: 'imp', hidden: true }).state;
  let r = gm(s, { t: 'combat.auto' }, { rolls: [1] });
  assert.deepEqual(r.result.sequence.map((x) => x.mob), ['Rat']);
  r = gm(s, { t: 'combat.auto', includeHidden: true }, { rolls: [1] });
  assert.deepEqual(r.result.sequence.map((x) => x.mob), ['Rat', 'Imp']);
  const tv = r.events.find((e) => e.event.kind === 'combat.auto' && e.to.roles?.includes('stage')).event;
  assert.equal(tv.steps[1].mob, 'Something unseen');
  assert.equal(tv.steps[1].mobUid, null);
  assert.ok(!JSON.stringify(tv).includes('Imp'));
});

test('undo puts HP and conditions back; autoStep goes one mob at a time and combat.auto finishes the queue', () => {
  let { s, ids } = setup([['rat', 3]]);
  const before = ids.map((id) => hpOf(s, id));
  const r = gm(s, { t: 'combat.auto' }, { rolls: [18, 4], rng: [0.4] });
  assert.ok(r.result.sequence.every((x) => x.hit));
  s = r.state;
  assert.notDeepEqual(ids.map((id) => hpOf(s, id)), before);
  assert.equal(viewFor(s, pack, 'gm').combat.lastAuto.canUndo, true);
  const u = gm(s, { t: 'combat.autoUndo' });
  s = u.state;
  assert.deepEqual(ids.map((id) => hpOf(s, id)), before);
  assert.ok(s.players.every((p) => !p.sheet.buffs.length), 'conditions removed');
  assert.ok(u.events.some((e) => e.event.kind === 'combat.autoUndo'));
  assert.throws(() => gm(s, { t: 'combat.autoUndo' }), /nothing to undo/);
  // stepping
  let st = gm(s, { t: 'combat.autoStep' }, { rolls: [1] });
  assert.equal(st.result.left, 2);
  s = st.state;
  st = gm(s, { t: 'combat.autoStep' }, { rolls: [1] });
  assert.equal(st.result.sequence[0].i, 1);
  s = st.state;
  const rest = gm(s, { t: 'combat.auto' }, { rolls: [18, 2] });
  assert.equal(rest.result.sequence.length, 1, 'only the third rat is left');
  s = rest.state;
  assert.equal(s.combat.lastAuto.steps.length, 3);
  assert.equal(s.combat.autoQueue, null);
  // undo covers the whole stepped run
  s = gm(s, { t: 'combat.autoUndo' }).state;
  assert.deepEqual(ids.map((id) => hpOf(s, id)), before);
});

test('dryRun returns the sequence and changes nothing', () => {
  const { s } = setup();
  const r = gm(s, { t: 'combat.auto', dryRun: true }, { rolls: [18, 4] });
  assert.equal(r.changed, false);
  assert.equal(r.state, s);
  assert.equal(r.result.sequence[0].hit, true);
});

test('a crawler going down: voice line crawler_down timed to its step, chat cue, downs counted', () => {
  let { s, ids } = setup();
  for (const pid of ids) s = gm(s, { t: 'track.set', playerId: pid, track: 'hp', cur: 2 }).state;
  const r = gm(s, { t: 'combat.auto' }, { rolls: [15, 4] });
  const step = r.result.sequence[0];
  assert.equal(step.down, true);
  const line = r.lines.find((l) => l.category === 'crawler_down');
  assert.ok(line && line.crit && line.delayMs > 600, 'delayed so it lands on the TV step');
  assert.ok(r.events.some((e) => e.event.kind === 'chat.cue' && e.event.cue === 'crawler_down' && e.event.delayMs > 0 && e.to.roles.length === 0));
  assert.equal(r.state.combat.stats.downs[step.playerId], 1);
  assert.equal(viewFor(r.state, pack, 'gm').combat.suggestEnd, null, 'two crawlers still stand');
});

test('mob killed: line + chat, damage attributed to `by` (else the last roller); victory offered', () => {
  let { s, ids } = setup();
  const rat = mobsOf(s)[0];
  s = gm(s, { t: 'roll', playerId: ids[2], what: { kind: 'custom', formula: 'd20' } }).state;
  const r = gm(s, { t: 'combat.damage', uid: rat.uid, amount: 1 });
  assert.equal(r.state.combat.stats.dealt[ids[2]], 1, 'last roller');
  const k = gm(r.state, { t: 'combat.damage', uid: rat.uid, amount: 5, by: ids[0] });
  assert.equal(k.state.combat.stats.dealt[ids[0]], 1);
  assert.equal(k.state.combat.stats.kills[ids[0]], 1);
  assert.ok(k.lines.some((l) => l.category === 'mob_killed'));
  assert.equal(viewFor(k.state, pack, 'gm').combat.suggestEnd, 'victory');
  const off = gm(k.state, { t: 'combat.set', settings: { autoEnd: false } }).state;
  assert.equal(viewFor(off, pack, 'gm').combat.suggestEnd, null);
});

test('defeat is offered when every crawler is down', () => {
  let { s, ids } = setup();
  for (const pid of ids) s = gm(s, { t: 'track.set', playerId: pid, track: 'hp', cur: 0 }).state;
  assert.equal(viewFor(s, pack, 'gm').combat.suggestEnd, 'defeat');
});

test('combat.end with an outcome: finale scene, summary + MVP, archived, voice line, chat cue, board cleared', () => {
  let { s, ids } = setup([['rat', 2]]);
  const [a, b] = mobsOf(s);
  s = gm(s, { t: 'combat.next' }).state;
  s = gm(s, { t: 'combat.next' }).state; // round 2
  s = gm(s, { t: 'combat.damage', uid: a.uid, amount: 2, by: ids[1] }).state;
  s = gm(s, { t: 'combat.damage', uid: b.uid, amount: 1, by: ids[0] }).state;
  s = gm(s, { t: 'combat.damage', uid: crawlers(s)[2].uid, amount: 3 }).state;
  const r = gm(s, { t: 'combat.end', outcome: 'victory' });
  const sum = r.result.summary;
  assert.deepEqual([sum.rounds, sum.dealt, sum.taken, sum.mobsDefeated, sum.mobsTotal], [2, 3, 3, 1, 2]);
  assert.equal(sum.mvp.name, 'Donut');
  assert.equal(r.state.scene.kind, 'finale');
  assert.equal(r.state.scene.data.outcome, 'victory');
  assert.equal(r.state.combat.active, false);
  assert.equal(r.state.combat.combatants.length, 0);
  assert.equal(r.state.combatLog.length, 1);
  assert.equal(r.state.combatLog[0].outcome, 'victory');
  assert.ok(r.lines.some((l) => l.category === 'combat_victory' && l.delayMs > 0));
  assert.ok(r.events.some((e) => e.event.kind === 'chat.cue' && e.event.cue === 'combat_victory'));
  assert.ok(r.state.feed.some((f) => /Combat over: Victory \(2 rounds\)/.test(f.text)));
  const stage = viewFor(r.state, pack, 'stage');
  assert.equal(stage.scene.data.summary.mvp.name, 'Donut');
  assert.equal(viewFor(r.state, pack, 'gm').gm.combatLog.length, 1);
  // special needs a title or text; unknown outcomes refused; plain end still works
  assert.throws(() => gm(s, { t: 'combat.end', outcome: 'special' }), /title or text/);
  assert.throws(() => gm(s, { t: 'combat.end', outcome: 'nap' }), /outcome must be/);
  const sp = gm(s, { t: 'combat.end', outcome: 'special', title: 'Dance-off', text: 'Settled by interpretive dance.' });
  assert.deepEqual([sp.state.scene.data.title, sp.state.scene.data.text], ['Dance-off', 'Settled by interpretive dance.']);
  const plain = gm(s, { t: 'combat.end' });
  assert.equal(plain.state.scene.kind, s.scene.kind);
  assert.equal(plain.state.combat.combatants.length, 0);
  // the finale can be replayed by hand
  const again = gm(r.state, { t: 'scene.set', kind: 'finale', data: { outcome: 'truce', title: 'Hugs' } });
  assert.equal(again.state.scene.data.outcome, 'truce');
  assert.throws(() => gm(r.state, { t: 'scene.set', kind: 'finale', data: { outcome: 'x' } }), /outcome/);
});

test('settings validation and GM-only view fields', () => {
  const { s, ids } = setup();
  assert.throws(() => gm(s, { t: 'combat.set', settings: { hitRule: '=' } }), /hitRule/);
  assert.throws(() => gm(s, { t: 'combat.set', settings: { stepMs: 50 } }), /stepMs/);
  assert.throws(() => gm(s, { t: 'combat.set', settings: { nope: 1 } }), /unknown setting/);
  assert.throws(() => gm(s, { t: 'combat.target', uid: crawlers(s)[0].uid, aggro: 12 }), /aggro/);
  const g = viewFor(s, pack, 'gm').combat;
  assert.deepEqual(g.unverified, ['hitRule', 'drMin', 'crit', 'evadeBase']);
  assert.equal(g.combatants.find((x) => x.type === 'crawler').evade, 12);
  const p = viewFor(s, pack, 'player', { playerId: ids[0] }).combat;
  assert.equal(p.settings, undefined);
  assert.equal(p.combatants.find((x) => x.type === 'crawler').aggro, undefined);
  assert.throws(() => reduce(s, { role: 'player', actorId: ids[0], t: 'combat.auto' }, ctx()), /unknown action/);
});

test('combat.mobAct: the GM picks the mob, the attack and the target; same resolution, cinematic and undo', () => {
  let { s, ids } = setup([['imp', 1]]);
  const imp = mobsOf(s)[0];
  const katia = crawlers(s)[2];
  // attack 1 (Jeer, +5, no damage) at Katia: d20 7 + 5 = 12 vs 12 → hit, 0 damage
  let r = gm(s, { t: 'combat.mobAct', uid: imp.uid, attackIndex: 1, targetUid: katia.uid }, { rolls: [7] });
  let [step] = r.result.sequence;
  assert.deepEqual([step.attack, step.target, step.total, step.hit, step.damage, step.mode], ['Jeer', 'Katia', 12, true, 0, 'gm']);
  assert.ok(r.events.some((e) => e.event.kind === 'combat.auto' && e.to.roles?.includes('stage')));
  // attack 0 (Poke 1d6) at Carl: 15 → hit, 4 damage; undo restores
  r = gm(r.state, { t: 'combat.mobAct', uid: imp.uid, attackIndex: 0, targetUid: crawlers(s)[0].uid }, { rolls: [15, 4] });
  s = r.state;
  assert.equal(hpOf(s, ids[0]), 6);
  s = gm(s, { t: 'combat.autoUndo' }).state;
  assert.equal(hpOf(s, ids[0]), 10);
  assert.throws(() => gm(s, { t: 'combat.mobAct', uid: imp.uid, attackIndex: 5 }), /attackIndex/);
  assert.throws(() => gm(s, { t: 'combat.mobAct', uid: 'nope' }), /no mob/);
  assert.throws(() => gm(s, { t: 'combat.mobAct', uid: imp.uid, targetUid: 'cb_x' }), /not in the fight/);
});
