// reaction.js: reaction rounds (GM never rolls a d20): declare → react → resolve → act → next round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPack } from '../pack.js';
import { createState, reduce, reducePlayerAction, viewFor } from '../state.js';
import { degreeOf, suggestDecls, attackDc, ACTIONS_PER_ROUND } from '../reaction.js';
import { tmpDir, writePack, seq } from './fixtures.js';

const { pack } = loadPack(writePack(tmpDir()));
let n = 0;
const DCC_PACK = process.env.DCC_PACK || path.resolve(import.meta.dirname, '../../../dcc-ai-private/packs/dcc');
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

test('a disadvantaged attack gives its target a free Evade and one paid retry on failure', () => {
  let s = fight();
  const targetUid = crawlerUid(s, 'Carl'), pid = playerId(s, 'Carl');
  const mobUid = s.combat.combatants.find((x) => x.type === 'mob').uid;
  const first = gm(s, { t: 'rx.declare', targetUid, mobUid });
  const declId = first.result.declId;
  const second = gm(first.state, { t: 'rx.declare', targetUid, mobUid });
  const normalId = second.result.declId;
  s = gm(second.state, { t: 'rx.adv', declId, adv: 'dis' }).state;
  s = gm(s, { t: 'rx.step', to: 'react' }).state;
  const gmDecl = viewFor(s, pack, 'gm', { now: 0 }).combat.rx.decls[0];
  assert.equal(gmDecl.dc, 7);
  assert.equal(gmDecl.freeEvade, true);
  assert.throws(() => gm(s, { t: 'rx.step', to: 'resolve' }), /1 Evade roll/);
  assert.throws(() => pl(s, pid, { t: 'rx.evade', declId: normalId, die: 20 }), /spend an action/);
  const missed = pl(s, pid, { t: 'rx.evade', declId, die: 1 });
  assert.equal(missed.result.free, true);
  s = missed.state;
  assert.equal(s.combat.rx.acts[targetUid], 2);
  assert.throws(() => pl(s, pid, { t: 'rx.evade', declId, die: 20 }), /spend an action/);
  s = pl(s, pid, { t: 'rx.interrupt', kind: 'evade' }).state;
  assert.equal(s.combat.rx.acts[targetUid], 1);
  assert.equal(viewFor(s, pack, 'gm', { now: 0 }).combat.rx.decls[0].canReroll, true);
  const retry = pl(s, pid, { t: 'rx.evade', declId, die: 20 });
  assert.equal(retry.result.free, false);
  assert.equal(retry.state.combat.rx.acts[targetUid], 1);
  assert.throws(() => pl(retry.state, pid, { t: 'rx.evade', declId, die: 1 }), /already evaded/);
  s = pl(retry.state, pid, { t: 'rx.evade', declId: normalId, die: 20 }).state;
  assert.equal(s.combat.rx.acts[targetUid], 1);
  s = gm(s, { t: 'rx.step', to: 'resolve' }).state;
  assert.deepEqual(s.combat.rx.decls.map((d) => d.result), ['evaded', 'evaded']);
});

test('elite suggestions count fallen crawlers and target only standing crawlers', () => {
  let s = fight({ boss: true });
  const standingUid = crawlerUid(s, 'Carl'), dyingUid = crawlerUid(s, 'Donut'), deadUid = crawlerUid(s, 'Katia');
  const get = (uid) => s.combat.combatants.find((x) => x.uid === uid);
  get(dyingUid).dying = 2;
  get(deadUid).dead = true;
  const elite = s.combat.combatants.find((x) => x.role === 'elite');
  const suggestions = suggestDecls(s, ctx());
  assert.equal(suggestions.filter((x) => x.mobUid === elite.uid).length, 3);
  assert.ok(suggestions.every((x) => x.targetUid === standingUid));
  assert.throws(() => gm(s, { t: 'rx.declare', targetUid: deadUid, mobUid: elite.uid }), /already dead/);
  const declared = gm(s, { t: 'rx.declare', targetUid: dyingUid, mobUid: elite.uid });
  s = gm(declared.state, { t: 'rx.adv', declId: declared.result.declId, adv: 'dis' }).state;
  s = gm(s, { t: 'rx.step', to: 'react' }).state;
  assert.equal(viewFor(s, pack, 'gm', { now: 0 }).combat.rx.decls[0].freeEvade, false);
  assert.throws(() => pl(s, playerId(s, 'Donut'), { t: 'rx.interrupt', kind: 'evade' }), /cannot act/);
  assert.throws(() => pl(s, playerId(s, 'Katia'), { t: 'rx.spend' }), /cannot act/);
  get(standingUid).dead = true;
  assert.deepEqual(suggestDecls(s, ctx()), []);
});

test('AI Favor buys one non-attack action and leaves attack spending on the base pool', () => {
  const favorPack = { ...pack, ruleset: { ...pack.ruleset, fields: [
    ...pack.ruleset.fields, { id: 'aiFavor', label: 'AI Favor', type: 'number', default: 2 },
  ] } };
  let s = createState(favorPack, 0);
  const doGm = (a) => gm(s, a, { pack: favorPack });
  s = doGm({ t: 'player.add', name: 'Runner' }).state;
  const pid = s.players[0].id;
  const act = (a) => reducePlayerAction(s, a, { ...ctx({ pack: favorPack }), playerId: pid });
  const weapon = doGm({ t: 'attack.add', playerId: pid, name: 'Axe', dice: '1d6' });
  s = weapon.state;
  s = doGm({ t: 'combat.start' }).state;
  s = doGm({ t: 'rx.step', to: 'act' }).state;
  const uid = crawlerUid(s, 'Runner');
  s = doGm({ t: 'rx.actions', uid, delta: -2 }).state;
  const bought = act({ t: 'rx.favor' });
  s = bought.state;
  assert.equal(s.players[0].sheet.fields.aiFavor, 1);
  assert.equal(s.combat.rx.nonAttackActions[uid], 1);
  assert.throws(() => act({ t: 'rx.favor' }), /already used AI Favor/);
  const strike = { t: 'roll', what: { kind: 'attack', uid: weapon.result.uid }, entered: 17, useAction: true };
  assert.throws(() => act(strike), /no actions left/);
  s = doGm({ t: 'rx.actions', uid, delta: 1 }).state;
  s = act(strike).state;
  assert.equal(s.combat.rx.acts[uid], 0);
  assert.equal(s.combat.rx.nonAttackActions[uid], 1);
  s = act({ t: 'rx.spend' }).state;
  assert.equal(s.combat.rx.nonAttackActions[uid], 0);
  assert.throws(() => act({ t: 'rx.spend' }), /no actions left/);
  s = doGm({ t: 'rx.round' }).state;
  s = doGm({ t: 'rx.step', to: 'act' }).state;
  assert.equal(act({ t: 'rx.favor' }).state.players[0].sheet.fields.aiFavor, 0);
});

test('a phone attack spends an action only on submission and undo refunds it within that round', () => {
  let s = fight();
  const pid = playerId(s, 'Carl');
  const crawler = crawlerUid(s, 'Carl');
  const added = gm(s, { t: 'attack.add', playerId: pid, name: 'Axe', dice: '1d6' });
  s = added.state;
  const target = s.combat.combatants.find((x) => x.type === 'mob').uid;
  const payload = { t: 'roll', what: { kind: 'attack', uid: added.result.uid }, target, entered: 17 };
  assert.throws(() => pl(s, pid, payload), /cannot attack in this phase/);
  assert.throws(() => pl(s, pid, { ...payload, useAction: false }), /cannot attack in this phase/);
  s = gm(s, { t: 'rx.step', to: 'act' }).state;
  const initial = s.combat.rx.acts[crawler];
  assert.throws(() => pl(s, pid, { ...payload, entered: 21 }), /higher than d20/);
  assert.equal(s.combat.rx.acts[crawler], initial);
  const rolled = pl(s, pid, payload);
  s = rolled.state;
  assert.equal(s.combat.rx.acts[crawler], initial - 1);
  assert.equal(rolled.result.roll.natural, 17);
  assert.equal(rolled.result.roll.actionReceipt, undefined);
  s = pl(s, pid, { t: 'roll.undo' }).state;
  assert.equal(s.combat.rx.acts[crawler], initial);
  s = gm(s, { t: 'roll.restore', id: rolled.result.rollId }).state;
  assert.equal(s.combat.rx.acts[crawler], initial - 1);
  s = gm(s, { t: 'rx.round' }).state;
  s = pl(s, pid, { t: 'roll.undo' }).state;
  assert.equal(s.combat.rx.acts[crawler], initial, 'undo does not add actions to a later round');
});

test('reaction weapon damage belongs to one live hit against the chosen enemy', () => {
  let s = fight();
  const pid = playerId(s, 'Carl');
  const crawler = crawlerUid(s, 'Carl');
  const added = gm(s, { t: 'attack.add', playerId: pid, name: 'Axe', dice: '1d6' });
  s = gm(added.state, { t: 'rx.step', to: 'act' }).state;
  const [target, another] = s.combat.combatants.filter((x) => x.type === 'mob').map((x) => x.uid);
  const what = { kind: 'attack', uid: added.result.uid };
  const damage = { t: 'roll', target, entered: 1, what: { ...what, part: 'damage' } };
  assert.throws(() => pl(s, pid, damage), /successful attack/);
  const hit = pl(s, pid, { t: 'roll', target, entered: 20, what, useAction: false });
  const linked = { ...damage, after: hit.result.rollId };
  assert.throws(() => pl(hit.state, pid, { ...linked, target: another }), /successful attack/);
  const landed = pl(hit.state, pid, linked);
  assert.ok(landed.result.applied?.delta < 0);
  assert.equal(landed.state.combat.rx.acts[crawler], ACTIONS_PER_ROUND - 1);
  assert.throws(() => pl(landed.state, pid, linked), /already rolled/);
  assert.throws(() => gm(landed.state, { t: 'roll.void', id: hit.result.rollId }), /undo the (?:weapon )?damage/);
  s = pl(landed.state, pid, { t: 'roll.undo' }).state;
  assert.ok(pl(s, pid, linked).result.applied?.delta < 0);
});

test('a physical Taunt result can redirect a declared attack and clears its prior Evade', () => {
  let s = fight();
  const target = crawlerUid(s, 'Carl');
  const taunter = crawlerUid(s, 'Donut');
  const pid = playerId(s, 'Donut');
  const mob = s.combat.combatants.find((x) => x.type === 'mob');
  mob.stats = { int: { mod: 0 } };
  const mobUid = mob.uid;
  s = gm(s, { t: 'lib.upsert', kind: 'skill', entry: { id: 'taunt', name: 'Taunt', stat: 'str', checkType: 'Opposed' } }).state;
  s = gm(s, { t: 'skill.add', playerId: pid, skillId: 'taunt', rank: 3 }).state;
  const declared = gm(s, { t: 'rx.declare', mobUid, targetUid: target });
  const { declId } = declared.result;
  s = gm(declared.state, { t: 'rx.step', to: 'react' }).state;
  s = pl(s, playerId(s, 'Carl'), { t: 'rx.interrupt', kind: 'evade' }).state;
  s = pl(s, playerId(s, 'Carl'), { t: 'rx.evade', declId, die: 20 }).state;
  const action = { t: 'rx.interrupt', kind: 'taunt', declId };
  assert.throws(() => pl(s, pid, { ...action, die: 21 }), /die must be 1..20/);
  assert.equal(s.combat.rx.acts[taunter], ACTIONS_PER_ROUND);
  const { total } = viewFor(s, pack, 'player', { playerId: pid }).me.sheet.computed.skills[0];
  const exactFace = 11 - total.value;
  const taunt = pl(s, pid, { ...action, die: exactFace });
  assert.equal(taunt.result.ok, true);
  assert.equal(taunt.state.combat.rx.acts[taunter], ACTIONS_PER_ROUND - 1);
  assert.equal(taunt.state.combat.rx.decls[0].targetUid, taunter);
  assert.equal(taunt.state.combat.rx.decls[0].evade, null);
  assert.equal(viewFor(taunt.state, pack, 'player', { playerId: pid }).combat.rx.decls[0].freeEvade, false);
  assert.equal(taunt.state.rolls.at(-1).total, 11, 'includes the stored skill modifier and honors Int +0');
});

test('Rank 5 Taunt grants a free Evade against the redirected attack', () => {
  let s = fight();
  const targetUid = crawlerUid(s, 'Carl');
  const taunter = crawlerUid(s, 'Donut');
  const pid = playerId(s, 'Donut');
  const mobUid = s.combat.combatants.find((x) => x.type === 'mob').uid;
  s = gm(s, { t: 'lib.upsert', kind: 'skill', entry: { id: 'taunt', name: 'Taunt', stat: 'str', checkType: 'Opposed' } }).state;
  s = gm(s, { t: 'skill.add', playerId: pid, skillId: 'taunt', rank: 5 }).state;
  const declared = gm(s, { t: 'rx.declare', mobUid, targetUid });
  const { declId } = declared.result;
  s = gm(declared.state, { t: 'rx.step', to: 'react' }).state;
  s = pl(s, pid, { t: 'rx.interrupt', kind: 'taunt', declId, die: 20 }).state;
  assert.equal(viewFor(s, pack, 'player', { playerId: pid }).combat.rx.decls[0].freeEvade, true);
  const failed = pl(s, pid, { t: 'rx.evade', declId, die: 1 });
  assert.equal(failed.result.free, true);
  assert.equal(failed.state.combat.rx.acts[taunter], ACTIONS_PER_ROUND - 1, 'only the Taunt used an action');
  s = pl(failed.state, pid, { t: 'rx.interrupt', kind: 'evade' }).state;
  const retry = pl(s, pid, { t: 'rx.evade', declId, die: 20 });
  assert.equal(retry.result.degree, 'crit');
  assert.equal(retry.result.free, false);
  assert.equal(retry.state.combat.rx.acts[taunter], 0);
});

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

test('announce publishes the selected attack and target before any damage roll', () => {
  let s = fight();
  const uid = crawlerUid(s, 'Carl');
  const { state, result } = gm(s, { t: 'combat.addAdhoc', name: 'Guard', hp: 5,
    attacks: [{ name: 'Stab', toHit: 2, damage: '1d4' }, { name: 'Slam', toHit: 4, damage: '1d6' }] });
  s = state;
  const [mobUid] = result.uids;
  const noDice = { rollInt: () => { assert.fail('no rolls during declaration or announcement'); } };
  assert.throws(() => gm(s, { t: 'rx.declare', mobUid }, noDice), /no crawler/);
  const queued = gm(s, { t: 'rx.declare', mobUid, attackIndex: 0, targetUid: uid }, noDice);
  s = gm(queued.state, { t: 'rx.retarget', declId: queued.result.declId, attackIndex: 1 }, noDice).state;
  assert.equal(viewFor(s, pack, 'stage').combat.rx.decls.length, 0);
  assert.throws(() => gm(s, { t: 'rx.step', to: 'resolve' }), /announce the attacks/);
  const announced = gm(s, { t: 'rx.step', to: 'react' }, noDice);
  assert.deepEqual(announced.events.find((x) => x.event.kind === 'rx.react').event.targets, [uid]);
  const [decl] = viewFor(announced.state, pack, 'stage').combat.rx.decls;
  assert.equal(decl.attack, 'Slam');
  assert.equal(decl.targetUid, uid);
  assert.equal(decl.damage, null);
  assert.equal(decl.dc, undefined);
  assert.throws(() => gm(announced.state, { t: 'rx.retarget', declId: decl.id, attackIndex: 0 }), /declare step/);
  const dice = [];
  const resolved = gm(announced.state, { t: 'rx.step', to: 'resolve' }, { rollInt: (sides) => { dice.push(sides); return 4; } });
  assert.deepEqual(dice, [6]);
  assert.equal(resolved.state.combat.rx.decls[0].damage, 5);
});

test('a full round: suggest, evade (spends an action), rolls, intervene on a near miss, damage, next round', () => {
  let s = fight();
  const carl = crawlerUid(s, 'Carl');
  const donut = crawlerUid(s, 'Donut');
  s = gm(s, { t: 'rx.suggest' }).state;
  // Aim everything at Carl to keep the test simple.
  for (const d of s.combat.rx.decls) s = gm(s, { t: 'rx.retarget', declId: d.id, targetUid: carl }).state;
  assert.ok(s.combat.rx.decls.every((d) => d.targetUid === carl));
  { // Advantage +5 / Disadvantage −5 on the Evade difficulty, and back.
    const d0 = s.combat.rx.decls[0];
    const dc = d0.attack.dc;
    let t = gm(s, { t: 'rx.adv', declId: d0.id, adv: 'adv' }).state;
    assert.equal(t.combat.rx.decls[0].attack.dc, dc + 5);
    t = gm(t, { t: 'rx.adv', declId: d0.id, adv: 'dis' }).state;
    assert.equal(t.combat.rx.decls[0].attack.dc, dc - 5);
    t = gm(t, { t: 'rx.adv', declId: d0.id, adv: null }).state;
    assert.equal(t.combat.rx.decls[0].attack.dc, dc);
  }
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
  { // Area of Effect: evaded full area = half; splash ring = half, evaded splash = a quarter (rounded down).
    let t = gm(s, { t: 'rx.area', declId: d1.id, area: 'splash' }).state;
    t = gm(t, { t: 'rx.area', declId: d2.id, area: 'full' }).state;
    t = gm(t, { t: 'rx.area', declId: d3.id, area: 'splash' }).state;
    assert.throws(() => gm(t, { t: 'rx.area', declId: d3.id, area: 'cone' }), /area must be/);
    t = gm(t, { t: 'rx.step', to: 'resolve', force: true }, { randInt: (k) => k - 1 }).state;
    assert.deepEqual(t.combat.rx.decls.map((d) => [d.result, d.damage]), [['half', 1], ['half', 2], ['half', 2]]);
  }
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

test('book stat blocks (private DCC pack): extras load, area attacks are AoE, flat blocks skip the floor', { skip: !fs.existsSync(path.join(DCC_PACK, 'monsters.json')) && 'private pack not present' }, async () => {
  const { pack: dcc } = loadPack(DCC_PACK);
  const rr = dcc.library.monster.find((x) => x.id === 'riff_roughers');
  assert.ok(rr, 'Riff Roughers from the GM toolkit');
  assert.equal(rr.level, 4);
  assert.equal(rr.surprise, 11);
  assert.equal(rr.slotValue, 3);
  assert.deepEqual(rr.stats.str, { score: 6, mod: 3 });
  const breath = rr.attacks.find((a) => a.name === 'Breath');
  assert.equal(breath.area, '10ft Cone');
  assert.equal(breath.dtype, 'acid');
  const kong = dcc.library.boss.find((x) => x.id === 'general_kong');
  assert.ok(kong?.flat, 'Par for the Course prints flat numbers');
  assert.equal(kong.slotValue, 4);
  let k = 0;
  const c = (x = {}) => ({ now: 1000, rng: () => 0.1, genId: (p) => `${p}_${++k}`, pack: dcc, ...x });
  let s = createState(dcc, 0);
  s = reduce(s, { role: 'gm', t: 'player.add', name: 'Carl' }, c()).state;
  s = reduce(s, { role: 'gm', t: 'crawlers.set', floor: 3 }, c()).state;
  s = reduce(s, { role: 'gm', t: 'combat.start' }, c()).state;
  s = reduce(s, { role: 'gm', t: 'combat.addMob', kind: 'monster', sourceId: 'riff_roughers', hidden: false, intro: false }, c()).state;
  s = reduce(s, { role: 'gm', t: 'combat.addMob', kind: 'boss', sourceId: 'general_kong', hidden: false }, c()).state;
  s = reduce(s, { role: 'gm', t: 'rx.start' }, c()).state;
  s = reduce(s, { role: 'gm', t: 'rx.suggest' }, c()).state;
  const decls = s.combat.rx.decls;
  const byMob = (name) => decls.filter((d) => s.combat.combatants.find((m) => m.uid === d.mobUid)?.name.startsWith(name));
  const kd = byMob('General Kong')[0];
  assert.equal(kd.attack.dc, 16, 'Kong Smash: 16 to hit, no floor');
  const rd = byMob('Riff Roughers')[0];
  assert.equal(rd.attack.dc, 13 + 3, 'Breath 13+F on floor 3');
  assert.equal(rd.attack.area, true, 'a Cone is an area attack');
});
