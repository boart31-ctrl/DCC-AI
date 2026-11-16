// reaction.js: reaction rounds (GM never rolls a d20): declare → react → resolve → act → next round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { createState, reduce, reducePlayerAction, viewFor } from '../state.js';
import { degreeOf, suggestDecls, attackDc, ACTIONS_PER_ROUND } from '../reaction.js';
import { tmpDir, writePack, seq } from './fixtures.js';

const { pack } = loadPack(writePack(tmpDir()));
let n = 0;
const ctx = (extra = {}) => ({ now: 1000, rng: seq(0.1, 0.6, 0.3), genId: (p) => `${p}_${++n}`, pack, ...extra });
const gm = (s, a, extra) => reduce(s, { role: 'gm', ...a }, ctx(extra));
const pl = (s, pid, a) => reducePlayerAction(s, a, { ...ctx(), playerId: pid });

function fight({ boss = false } = {}) {
  let s = createState(pack, 0);
  for (const name of ['Carl', 'Donut', 'Katia']) s = gm(s, { t: 'player.add', name }).state;
  s = gm(s, { t: 'combat.start' }).state;
  s = gm(s, { t: 'combat.addAdhoc', name: 'Goblin', hp: 5, count: 3, hidden: false, attacks: [{ name: 'Stab', toHit: 2, damage: '1d4' }] }).state;
  if (boss) {
    s = gm(s, { t: 'combat.addAdhoc', name: 'Swine', hp: 30, hidden: false, attacks: [{ name: 'Roll over', toHit: 4, damage: '2d6' }] }).state;
    const b = s.combat.combatants.find((x) => x.name === 'Swine');
    b.role = 'elite';
  }
  s = gm(s, { t: 'rx.start' }).state;
  return s;
}
const crawlerUid = (s, name) => s.combat.combatants.find((x) => x.type === 'crawler' && s.players.find((p) => p.id === x.playerId)?.name === name).uid;
const playerId = (s, name) => s.players.find((p) => p.name === name).id;

test('degreeOf: seven degrees, nat 20 / nat 1 win over the margin', () => {
  assert.equal(degreeOf(20, 5, 30), 'crit');
  assert.equal(degreeOf(1, 40, 10), 'critfail');
  assert.equal(degreeOf(10, 22, 12), 'amazing');
  assert.equal(degreeOf(10, 12, 12), 'success', 'tie succeeds');
  assert.equal(degreeOf(10, 10, 12), 'near');
  assert.equal(degreeOf(10, 9, 12), 'fail');
  assert.equal(degreeOf(5, 2, 12), 'major');
  assert.equal(attackDc({ toHit: 3 }), 13);
  assert.equal(attackDc({ dc: 12, toHit: 3 }), 12);
});

test('suggest: mobs spread evenly, an elite attacks every crawler once', () => {
  const s = fight({ boss: true });
  const plan = suggestDecls(s, ctx());
  const goblins = plan.filter((p) => s.combat.combatants.find((x) => x.uid === p.mobUid).name.startsWith('Goblin'));
  assert.equal(goblins.length, 3);
  assert.equal(new Set(goblins.map((p) => p.targetUid)).size, 3, 'three goblins, three different crawlers');
  const swine = plan.filter((p) => s.combat.combatants.find((x) => x.uid === p.mobUid).name === 'Swine');
  assert.equal(swine.length, 3, 'one action per crawler');
});

test('a full round: suggest, evade (spends an action), rolls, intervene on a near miss, damage, next round', () => {
  let s = fight();
  const carl = crawlerUid(s, 'Carl');
  const donut = crawlerUid(s, 'Donut');
  s = gm(s, { t: 'rx.suggest' }).state;
  // Aim everything at Carl to keep the test simple.
  for (const d of s.combat.rx.decls) d.targetUid = carl;
  assert.throws(() => pl(s, playerId(s, 'Carl'), { t: 'rx.interrupt', kind: 'evade' }), /reaction step/);
  s = gm(s, { t: 'rx.step', to: 'react' }).state;
  s = pl(s, playerId(s, 'Carl'), { t: 'rx.interrupt', kind: 'evade' }).state;
  assert.equal(s.combat.rx.acts[carl], ACTIONS_PER_ROUND - 1);
  assert.throws(() => pl(s, playerId(s, 'Carl'), { t: 'rx.interrupt', kind: 'evade' }), /already evading/);
  s = pl(s, playerId(s, 'Donut'), { t: 'rx.interrupt', kind: 'intervene' }).state;
  const [d1, d2, d3] = s.combat.rx.decls; // dc 12 each (10 + toHit 2); Carl's Evade bonus is 0 in the test pack
  assert.throws(() => pl(s, playerId(s, 'Donut'), { t: 'rx.evade', declId: d1.id, die: 15 }), /not aimed at you/);
  let r = pl(s, playerId(s, 'Carl'), { t: 'rx.evade', declId: d1.id, die: 15 });
  s = r.state;
  assert.equal(r.result.degree, 'success');
  r = pl(s, playerId(s, 'Carl'), { t: 'rx.evade', declId: d2.id, die: 11 });
  s = r.state;
  assert.equal(r.result.degree, 'near');
  r = pl(s, playerId(s, 'Donut'), { t: 'rx.intervene', declId: d2.id, d6: 4 });
  s = r.state;
  assert.equal(r.result.degree, 'success', 'Intervene turns the near miss into a success');
  assert.throws(() => gm(s, { t: 'rx.step', to: 'resolve' }), /1 Evade roll missing/);
  s = gm(s, { t: 'rx.step', to: 'resolve', force: true }, { randInt: (k) => k - 1 }).state;
  const res = s.combat.rx.decls.map((d) => d.result);
  assert.deepEqual(res, ['evaded', 'evaded', 'hit']);
  assert.equal(s.combat.rx.decls[2].damage, 4, 'max roll on 1d4 with the test randInt');
  assert.equal(d3.targetUid, carl);
  s = gm(s, { t: 'rx.step', to: 'act' }).state;
  s = pl(s, playerId(s, 'Carl'), { t: 'rx.spend' }).state;
  assert.equal(s.combat.rx.acts[carl], 0);
  assert.throws(() => pl(s, playerId(s, 'Carl'), { t: 'rx.spend' }), /no actions left/);
  s = gm(s, { t: 'rx.round' }).state;
  assert.equal(s.combat.rx.round, 2);
  assert.equal(s.combat.rx.step, 'declare');
  assert.deepEqual(s.combat.rx.decls, []);
  assert.equal(s.combat.rx.acts[carl], 2);
  assert.equal(s.combat.rx.acts[donut], 2);
});

test('catcher takes the hit (no evade), major / critical fails hurt more, views hide difficulties from players', () => {
  let s = fight();
  const carl = crawlerUid(s, 'Carl');
  const katia = crawlerUid(s, 'Katia');
  const gob = s.combat.combatants.find((x) => x.type === 'mob');
  s = gm(s, { t: 'rx.declare', mobUid: gob.uid, targetUid: carl }).state;
  s = gm(s, { t: 'rx.declare', mobUid: gob.uid, targetUid: katia }).state;
  s = gm(s, { t: 'rx.step', to: 'react' }).state;
  const [toCarl, toKatia] = s.combat.rx.decls;
  s = pl(s, playerId(s, 'Katia'), { t: 'rx.interrupt', kind: 'catcher', declId: toCarl.id }).state;
  assert.equal(s.combat.rx.decls[0].targetUid, katia);
  s = pl(s, playerId(s, 'Katia'), { t: 'rx.interrupt', kind: 'evade' }).state;
  assert.throws(() => pl(s, playerId(s, 'Katia'), { t: 'rx.evade', declId: toCarl.id, die: 18 }), /caught attack/);
  s = pl(s, playerId(s, 'Katia'), { t: 'rx.evade', declId: toKatia.id, die: 1 }).state;
  const pv = viewFor(s, pack, 'player', { now: 0, playerId: playerId(s, 'Carl') }).combat.rx;
  assert.equal(pv.decls[0].dc, undefined, 'players never see the difficulty');
  assert.equal(viewFor(s, pack, 'gm', { now: 0 }).combat.rx.decls[0].dc, 12);
  s = gm(s, { t: 'rx.step', to: 'resolve' }, { randInt: (k) => k - 1 }).state;
  const [a, b] = s.combat.rx.decls;
  assert.equal(a.result, 'hit');
  assert.equal(a.damage, 4);
  assert.equal(b.damage, 8, 'critical fail on Evade: double damage');
});
