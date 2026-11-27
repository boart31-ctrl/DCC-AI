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
const resolveAll = (s, { force = false } = {}, extra) => {
  const entered = gm(s, { t: 'rx.step', to: 'resolve', force }).state;
  const quoted = gm(entered, { t: 'rx.resolveNext', all: true }, extra);
  return gm(quoted.state, { t: 'rx.resolveNext', op: 'apply', all: true, token: quoted.result.token, confirm: true }, extra);
};

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

function resolutionFight() {
  const { pack } = loadPack(writePack(tmpDir(), {
    'ruleset.json': {
      id: 'resolution', tracks: [{ id: 'hp', label: 'Health', kind: 'slots', default: 4, slotValue: 1 }],
      combat: { flow: 'reaction', dyingRounds: '1', injuries: { minor: 'minor', major: 'major', minorDescriptions: ['Sore wrist.'], majorDescriptions: ['Broken arm.'] } },
    },
    'buffs.json': [{ id: 'marked', name: 'Marked' }],
  }));
  const act = (s, action, extra) => gm(s, action, { pack, ...extra });
  let s = createState(pack, 0);
  for (const name of ['Hero', 'Ally']) s = act(s, { t: 'player.add', name }).state;
  s = act(s, { t: 'combat.start' }).state;
  const hero = crawlerUid(s, 'Hero'), ally = crawlerUid(s, 'Ally');
  const mob = act(s, { t: 'combat.addAdhoc', name: 'Foe', hp: 10, hidden: false, attacks: [{ name: 'Strike', damage: '1d2', buffs: ['marked'] }] });
  const [mobUid] = mob.result.uids;
  s = mob.state;
  for (let i = 0; i < 4; i++) s = act(s, { t: 'rx.declare', targetUid: hero, mobUid }).state;
  s = act(s, { t: 'rx.step', to: 'react' }).state;
  const pid = playerId(s, 'Hero');
  s = reducePlayerAction(s, { t: 'rx.interrupt', kind: 'evade' }, { ...ctx({ pack }), playerId: pid }).state;
  for (const [i, d] of s.combat.rx.decls.entries()) s = act(s, { t: 'rx.evade', declId: d.id, die: i === 2 ? 1 : 3 }).state;
  return { s, pack, act, hero, ally, pid, mobUid };
}

test('four attacks preview one at a time and require confirmation before Dying and death', () => {
  const { s, pack, act, hero, pid } = resolutionFight();
  const rollInt = (sides) => { assert.equal(sides, 2); return 0; };
  const noDice = () => assert.fail('damage already rolled during preview');
  const acting = act(s, { t: 'rx.step', to: 'resolve' }, { rollInt: noDice });
  let state = acting.state;
  const hp = () => state.players.find((p) => p.id === pid).sheet.tracks.hp.cur;
  const crawler = () => state.combat.combatants.find((x) => x.uid === hero);
  assert.equal(hp(), 4);
  assert.equal(state.combat.rx.decls.filter((d) => d.result).length, 0);
  assert.throws(() => act(state, { t: 'rx.step', to: 'act' }), /remaining attacks/);
  assert.throws(() => act(state, { t: 'rx.start' }), /already in progress/);
  assert.throws(() => act(state, { t: 'rx.round' }), /remaining attacks/);
  const undoBaseline = state.combat.manualUndo?.length ?? 0;
  for (const [i, danger] of [null, null, 'dying', 'dead'].entries()) {
    const before = hp();
    const quote = act(state, { t: 'rx.resolveNext' }, { rollInt });
    state = quote.state;
    assert.equal(hp(), before);
    assert.equal(quote.result.raw, 1);
    assert.equal(quote.result.danger, danger);
    assert.equal(quote.result.declId, state.combat.rx.decls[i].id);
    assert.equal(viewFor(state, pack, 'gm').combat.rx.pending.token, quote.result.token);
    assert.equal(viewFor(state, pack, 'stage').combat.rx.pending, undefined);
    assert.equal(quote.events.length, 0);
    const apply = { t: 'rx.resolveNext', op: 'apply', token: quote.result.token };
    if (danger) assert.throws(() => act(state, apply), /confirm the preview/);
    if (danger === 'dying') assert.deepEqual(quote.result.injury, { severity: 'major', desc: 'Broken arm.' });
    const committed = act(state, { ...apply, confirm: !!danger }, { rollInt: noDice });
    state = committed.state;
    const publicHit = committed.events.filter((x) => x.event.kind === 'rx.hit');
    assert.equal(publicHit.length, 1);
    assert.equal(publicHit[0].event.danger, danger);
    assert.equal(committed.events.find((x) => x.event.kind === 'combat.hit').event.animation, 'reaction');
    assert.equal(state.combat.rx.decls.filter((d) => d.result).length, i + 1);
  }
  assert.equal(crawler().dead, true);
  assert.equal(crawler().injuries[0].desc, 'Broken arm.');
  assert.equal(state.combat.stats.downs[pid], 1);
  assert.equal(state.combat.manualUndo?.length ?? 0, undoBaseline, 'only the dedicated undo records hits');
  state = act(state, { t: 'rx.step', to: 'act' }).state;
  assert.equal(viewFor(state, pack, 'gm').combat.rx.canUndo, true);
  state = act(state, { t: 'rx.resolveNext', op: 'undo' }).state;
  assert.equal(state.combat.rx.step, 'resolve');
  assert.equal(crawler().dead, undefined);
  assert.equal(crawler().dying, 1);
  state = act(state, { t: 'rx.resolveNext', op: 'undo' }).state;
  assert.equal(crawler().dying, undefined);
  assert.equal(crawler().injuries, undefined);
  assert.equal(hp(), 2);
  assert.equal(state.combat.stats.downs[pid], undefined);
  assert.equal(state.combat.stats.taken[pid], 2);
});

test('damage preview rolls each die once, then retains the sampled faces on refresh, redirect and Apply', () => {
  let s = fight();
  const carl = crawlerUid(s, 'Carl'), donut = crawlerUid(s, 'Donut');
  const armed = gm(s, { t: 'combat.addAdhoc', name: 'Guard', hp: 9, hidden: false, attacks: [
    { name: 'Slash', damage: '2d6+1d4+floor' },
  ] });
  const [mobUid] = armed.result.uids;
  s = gm(armed.state, { t: 'rx.declare', mobUid, targetUid: carl }).state;
  s = gm(s, { t: 'rx.step', to: 'react' }).state;
  s = gm(s, { t: 'rx.step', to: 'resolve' }).state;
  const bounds = [], values = [0, 3, 1];
  const ctx = { rollInt(sides) { bounds.push(sides); return values[bounds.length - 1] ?? 0; } };
  const first = gm(s, { t: 'rx.resolveNext' }, ctx);
  s = first.state;
  assert.deepEqual(bounds, [6, 6, 4]);
  assert.equal(first.result.raw, 8);
  assert.deepEqual(first.result.die.map(({ term, rolls }) => [term, rolls]), [['2d6', [1, 4]], ['1d4', [2]]]);
  const refreshed = gm(s, { t: 'rx.resolveNext' }, ctx);
  s = refreshed.state;
  const redirected = gm(s, { t: 'rx.resolveNext', op: 'redirect', token: refreshed.result.token, targetUid: donut }, ctx);
  assert.deepEqual([redirected.result.targetUid, redirected.result.raw, redirected.result.die], [donut, 8, first.result.die]);
  s = gm(redirected.state, { t: 'rx.resolveNext', op: 'apply', token: redirected.result.token }, ctx).state;
  assert.deepEqual(bounds, [6, 6, 4], 'refresh, redirect and apply reuse the existing roll');
  assert.equal(s.combat.rx.decls[0].targetUid, donut);
  assert.equal(s.combat.rx.decls[0].damage, 8);
});

test('pending injuries show to the GM and injured player with specific text, and either can be removed by GM', () => {
  const { s, pack, act, pid, hero, ally } = resolutionFight();
  let state = act(s, { t: 'combat.injury', uid: hero, severity: 'minor' }).state;
  state = act(state, { t: 'combat.injury', uid: hero, severity: 'major' }).state;
  const prow = (role, playerId) => viewFor(state, pack, role, { playerId }).combat.combatants.find((x) => x.uid === hero);
  const [minor, major] = prow('gm').pendingInjuries;
  assert.deepEqual([minor.desc, major.desc], ['Sore wrist.', 'Broken arm.']);
  assert.deepEqual(prow('player', pid).pendingInjuries, [minor, major]);
  const allyId = state.combat.combatants.find((x) => x.uid === ally).playerId;
  assert.equal(prow('player', allyId).pendingInjuries, undefined);
  assert.equal(prow('stage').pendingInjuries, undefined);
  assert.throws(() => reducePlayerAction(state, { t: 'combat.injury.remove', uid: hero, injuryId: minor.id }, { pack, playerId: pid }), /unknown action/);
  state = act(state, { t: 'combat.injury.remove', uid: hero, injuryId: minor.id }).state;
  assert.deepEqual(prow('player', pid).pendingInjuries, [major]);
  state = act(state, { t: 'combat.injury.remove', uid: hero, injuryId: major.id }).state;
  assert.deepEqual(prow('player', pid).pendingInjuries, []);
});

test('batch quote names the exact victim, invalidates on health changes and applies only the reviewed queue', () => {
  const { s, act, hero, ally, pid, mobUid } = resolutionFight();
  let state = act(s, { t: 'rx.step', to: 'resolve' }).state;
  const quote = (all = true) => {
    const r = act(state, { t: 'rx.resolveNext', all }, { rollInt: () => 0 });
    state = r.state;
    return r.result;
  };
  const batch = quote();
  assert.deepEqual(batch.hits.map((h) => h.danger), [null, null, 'dying', 'dead']);
  assert.deepEqual(batch.victims, [{ uid: hero, name: 'Hero', danger: 'dead' }]);
  const apply = { t: 'rx.resolveNext', op: 'apply', all: true, token: batch.token };
  assert.throws(() => act(state, apply), /confirm the preview/);
  state = act(state, { t: 'track.set', playerId: pid, track: 'hp', cur: 3 }).state;
  assert.throws(() => act(state, { ...apply, confirm: true }), /fight changed/);
  const first = quote(false);
  assert.throws(() => act(state, { ...apply, confirm: true }), /preview/);
  const redirected = act(state, { t: 'rx.resolveNext', op: 'redirect', targetUid: ally, token: first.token });
  state = redirected.state;
  assert.deepEqual([redirected.result.targetUid, redirected.result.evade], [ally, null]);
  assert.equal(state.combat.rx.decls[0].targetUid, hero, 'redirect stays in the quote until committed');
  const changed = act(state, { t: 'rx.resolveNext', op: 'change', amount: 2, token: redirected.result.token });
  state = changed.state;
  assert.equal(changed.result.slots, 2);
  state = act(state, { t: 'rx.resolveNext', op: 'skip', token: changed.result.token }).state;
  assert.equal(state.combat.rx.decls[0].result, 'skipped');
  const next = quote();
  state = act(state, { t: 'combat.reveal', uid: mobUid, on: false }).state;
  const committed = act(state, { ...apply, token: next.token, confirm: true });
  state = committed.state;
  const impacts = committed.events.filter((x) => x.event.kind === 'rx.hit').map((x) => x.event);
  assert.deepEqual(impacts.map((x) => x.declId), state.combat.rx.decls.slice(1).map((x) => x.id));
  assert.ok(impacts.every((x) => x.mobUid === null && x.mob === 'Unseen attacker' && x.attack === 'Attack'));
  state = act(state, { t: 'track.set', playerId: pid, track: 'hp', cur: 2 }).state;
  assert.throws(() => act(state, { t: 'rx.resolveNext', op: 'undo' }), /target changed/);
});

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
  s = resolveAll(s).state;
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
  assert.deepEqual(rolled.result.receipt, { spent: 1, actionsLeft: initial - 1, utilityLeft: 0 });
  const undone = pl(s, pid, { t: 'roll.undo' });
  assert.deepEqual(undone.result.receipt, { spent: 0, refunded: 1, actionsLeft: initial, utilityLeft: 0 });
  s = undone.state;
  assert.equal(s.combat.rx.acts[crawler], initial);
  s = gm(s, { t: 'roll.restore', id: rolled.result.rollId }).state;
  assert.equal(s.combat.rx.acts[crawler], initial - 1);
  s = gm(s, { t: 'rx.round' }).state;
  const later = pl(s, pid, { t: 'roll.undo' });
  assert.equal(later.result.receipt, undefined);
  s = later.state;
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

test('suggest queues hidden attackers and effect-only traps while retaining manual declarations', () => {
  let s = fight();
  const targetUid = crawlerUid(s, 'Donut');
  const vip = gm(s, { t: 'combat.addAdhoc', name: 'Faceless watcher', hp: 5, attacks: [
    { name: 'Jab', damage: '2' }, { name: 'Shove', damage: '1d4' },
  ] });
  const [mobUid] = vip.result.uids;
  const trap = gm(vip.state, { t: 'combat.addAdhoc', name: 'Pressure plate', hp: 2, attacks: [{ name: 'Release mist', damage: '0', effects: 'Area now obscured.' }] });
  const [trapUid] = trap.result.uids;
  const obscured = gm(trap.state, { t: 'combat.addAdhoc', name: 'Hidden bystander', hp: 2 });
  const [bystander] = obscured.result.uids;
  const before = gm(obscured.state, { t: 'rx.declare', mobUid, targetUid, attackIndex: 1 });
  const declId = before.result.declId;
  s = gm(before.state, { t: 'rx.area', declId, area: 'splash' }).state;
  const manual = structuredClone(s.combat.rx.decls[0]);

  const suggestion = gm(s, { t: 'rx.suggest' });
  s = suggestion.state;
  assert.deepEqual(suggestion.result, { count: 5, added: 4, preserved: 1, hidden: 2, limited: false, reason: null, next: 'announce', message: null });
  assert.deepEqual(s.combat.rx.decls[0], manual);
  assert.ok(s.combat.rx.decls.some((d) => d.mobUid === trapUid && d.attack.damage === '0'));
  assert.ok(!s.combat.rx.decls.some((d) => d.mobUid === bystander));
  assert.ok(s.combat.combatants.find((x) => x.uid === mobUid).hidden);
  assert.equal(suggestion.events.length, 0);
  for (const role of ['stage', 'player']) {
    const v = viewFor(s, pack, role, { playerId: playerId(s, 'Donut') });
    assert.deepEqual(v.combat.rx.decls, []);
    assert.equal(v.combat.rx.suggestion, undefined);
    assert.ok(!JSON.stringify(v.combat).includes('Faceless watcher'));
  }
  const retry = gm(s, { t: 'rx.suggest' });
  assert.equal(retry.changed, false);
  assert.equal(retry.result.reason, 'already-queued');
  assert.equal(retry.result.next, 'announce');
  assert.deepEqual(retry.state.combat.rx.decls, s.combat.rx.decls);
  assert.throws(() => gm(s, { t: 'rx.step', to: 'act' }), /remaining attacks/);
  assert.throws(() => gm(s, { t: 'rx.round', round: 1 }), /remaining attacks/);
  const announced = gm(s, { t: 'rx.step', to: 'react' });
  const reveals = announced.events.filter((e) => e.event.kind === 'combat.reveal').flatMap((e) => e.event.uids);
  assert.deepEqual(reveals, [mobUid, trapUid]);
  const stage = viewFor(announced.state, pack, 'stage').combat.rx.decls;
  assert.ok(stage.some((d) => d.id === declId && d.targetUid === targetUid && d.attack === 'Shove'));
  assert.ok(!announced.state.combat.rx.decls.some((d) => d.mobUid === bystander));
  assert.ok(announced.state.combat.combatants.find((x) => x.uid === bystander).hidden);
  const duplicate = gm(announced.state, { t: 'rx.step', to: 'react' });
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.events.length, 0);
});

test('suggest reports specific empty reasons plus next actions and cleanup can safely retry', () => {
  const { pack: special } = loadPack(writePack(tmpDir(), { 'buffs.json': [{ id: 'disabled', name: 'Disabled', blocks: ['action'] }] }));
  const act = (s, a) => gm(s, a, { pack: special });
  let s = act(createState(special, 0), { t: 'combat.start' }).state;
  s = act(s, { t: 'rx.start' }).state;
  const reason = (expected, next, extra = {}) => {
    const r = act(s, { t: 'rx.suggest', ...extra });
    assert.equal(r.changed, false);
    assert.deepEqual([r.result.count, r.result.reason, r.result.next], [0, expected, next]);
    assert.ok(r.result.message.length > 4);
    if (extra.includeHidden !== false) assert.equal(viewFor(s, special, 'gm').combat.rx.suggestion.reason, expected);
  };
  reason('no-crawlers', 'add-crawlers');
  const player = act(s, { t: 'player.add', name: 'Runner' });
  s = act(player.state, { t: 'combat.addCrawler', playerId: player.result.playerId }).state;
  reason('no-mobs', 'add-mobs');
  s = act(s, { t: 'combat.addAdhoc', name: 'Passive creature', hp: 5 }).state;
  reason('no-attacks', 'add-attacks');
  const armed = act(s, { t: 'combat.addAdhoc', name: 'Hunter', hp: 5, attacks: [{ name: 'Claw', damage: '2' }] });
  s = armed.state;
  const [uid] = armed.result.uids;
  assert.equal(viewFor(s, special, 'gm').combat.rx.suggestion.next, 'suggest');
  reason('hidden-excluded', 'include-hidden', { includeHidden: false });
  s = act(s, { t: 'combat.condition', uid, buffId: 'disabled', on: true }).state;
  reason('blocked', 'review-conditions');
  const crawler = s.combat.combatants.find((x) => x.type === 'crawler');
  crawler.noTarget = true;
  reason('no-targets', 'review-targets');
  crawler.dying = 1;
  reason('no-standing-crawlers', 'end-combat');
  crawler.dying = null;
  crawler.noTarget = false;
  const hp = s.players[0].sheet.tracks.hp;
  const savedHp = hp.cur;
  hp.cur = 0;
  reason('no-standing-crawlers', 'end-combat');
  hp.cur = savedHp;
  for (const mob of s.combat.combatants.filter((x) => x.type === 'mob')) mob.hp = 0;
  reason('all-mobs-down', 'end-combat');
  s = act(s, { t: 'rx.step', to: 'act' }).state;
  const next = act(s, { t: 'rx.round', round: 1 });
  assert.deepEqual(next.result, { round: 2 });
  assert.equal(next.events.filter((e) => e.event.kind === 'rx.round').length, 1);
  const retry = act(next.state, { t: 'rx.round', round: 1 });
  assert.equal(retry.changed, false);
  assert.deepEqual(retry.result, { round: 2, existing: true });
  assert.equal(retry.events.length, 0);
});

test('announce validates targets and attackers before revealing any hidden mob', () => {
  let s = fight();
  const queued = gm(s, { t: 'combat.addAdhoc', name: 'Lurker', hp: 3, count: 2, attacks: [{ name: 'Claw', damage: '1' }] });
  const [a, b] = queued.result.uids;
  const carl = crawlerUid(s, 'Carl');
  s = gm(queued.state, { t: 'rx.declare', mobUid: a, targetUid: carl }).state;
  s = gm(s, { t: 'rx.declare', mobUid: b, targetUid: carl }).state;
  s = gm(s, { t: 'combat.update', uid: b, hp: 0 }).state;
  assert.throws(() => gm(s, { t: 'rx.step', to: 'react' }), /attacker can no longer act/);
  assert.ok(s.combat.combatants.find((x) => x.uid === a).hidden);
  s = gm(s, { t: 'rx.undeclare', declId: s.combat.rx.decls[1].id }).state;
  s.combat.combatants.find((x) => x.uid === carl).dead = true;
  assert.throws(() => gm(s, { t: 'rx.step', to: 'react' }), /Choose an available crawler/);
  assert.ok(s.combat.combatants.find((x) => x.uid === a).hidden);
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
  const resolved = resolveAll(announced.state, {}, { rollInt: (sides) => { dice.push(sides); return 4; } });
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
    t = resolveAll(t, { force: true }, { randInt: (k) => k - 1 }).state;
    assert.deepEqual(t.combat.rx.decls.map((d) => [d.result, d.damage]), [['half', 1], ['half', 2], ['half', 2]]);
  }
  s = resolveAll(s, { force: true }, { randInt: (k) => k - 1 }).state;
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

test('manual and digital Evades share one action, and phone assistance spends its own action once', () => {
  let s = fight();
  const carl = crawlerUid(s, 'Carl');
  const carlPid = playerId(s, 'Carl');
  const donutPid = playerId(s, 'Donut');
  const mobUid = s.combat.combatants.find((row) => row.type === 'mob').uid;
  for (let i = 0; i < 3; i++) s = gm(s, { t: 'rx.declare', targetUid: carl, mobUid }).state;
  s = gm(s, { t: 'rx.step', to: 'react' }).state;
  const [first, second, third] = s.combat.rx.decls.map((d) => d.id);
  const prepare = pl(s, carlPid, { t: 'rx.interrupt', kind: 'evade' });
  s = prepare.state;
  assert.deepEqual(prepare.result.receipt, { spent: 1, actionsLeft: 1, utilityLeft: 0 });
  assert.throws(() => pl(s, carlPid, { t: 'rx.evade', declId: first, die: 10, digital: true }), /choose a phone roll/);
  const phoneEvade = reducePlayerAction(s, { t: 'rx.evade', declId: first, digital: true }, {
    ...ctx(), playerId: carlPid, dieInt: (sides) => { assert.equal(sides, 20); return 19; },
  });
  s = phoneEvade.state;
  assert.equal(phoneEvade.result.die, 20);
  assert.deepEqual(phoneEvade.result.receipt, { spent: 0, actionsLeft: 1, utilityLeft: 0 });
  s = pl(s, carlPid, { t: 'rx.evade', declId: second, die: 11 }).state;
  assert.throws(() => pl(s, carlPid, { t: 'rx.intervene', declId: second, d6: 2 }), /someone else/);
  assert.throws(() => pl(s, donutPid, { t: 'rx.intervene', declId: second, d6: 7 }), /d6 must be 1\.\.6/);
  const phoneHelp = reducePlayerAction(s, { t: 'rx.intervene', declId: second, digital: true }, {
    ...ctx(), playerId: donutPid, dieInt: (sides) => { assert.equal(sides, 6); return 2; },
  });
  s = phoneHelp.state;
  assert.equal(phoneHelp.result.d6, 3);
  assert.equal(phoneHelp.result.degree, 'success');
  assert.deepEqual(phoneHelp.result.receipt, { spent: 1, actionsLeft: 1, utilityLeft: 0 });
  assert.equal(viewFor(s, pack, 'player', { playerId: donutPid }).combat.history[0].label, 'Helped an ally');
  assert.ok(viewFor(s, pack, 'player', { playerId: carlPid }).combat.history.every((row) => row.label !== 'Helped an ally'));
  s = pl(s, carlPid, { t: 'rx.evade', declId: third, die: 11 }).state;
  s = pl(s, donutPid, { t: 'rx.interrupt', kind: 'intervene' }).state;
  assert.throws(() => pl(s, donutPid, { t: 'rx.interrupt', kind: 'intervene' }), /already prepared/);
  const preparedHelp = pl(s, donutPid, { t: 'rx.intervene', declId: third, d6: 2 });
  assert.deepEqual(preparedHelp.result.receipt, { spent: 0, actionsLeft: 0, utilityLeft: 0 });
  assert.throws(() => pl(preparedHelp.state, donutPid, { t: 'rx.intervene', declId: third, d6: 2 }), /no actions left/);
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
  s = resolveAll(s, {}, { randInt: (k) => k - 1 }).state;
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

test('Call a Play: 1 action, 2d6 keep high; turns the ally miss into a hit, or adds to damage when the ally hits anyway', () => {
  let s = fight();
  const carl = playerId(s, 'Carl');
  const donut = playerId(s, 'Donut');
  const donutUid = crawlerUid(s, 'Donut');
  const carlUid = crawlerUid(s, 'Carl');
  const axe = gm(s, { t: 'attack.add', playerId: donut, name: 'Axe', dice: '1d6' });
  s = axe.state;
  const goblin = s.combat.combatants.find((x) => x.type === 'mob');
  assert.throws(() => pl(s, carl, { t: 'rx.callPlay', allyUid: donutUid }), /action phase/);
  s = gm(s, { t: 'rx.step', to: 'act' }).state;
  assert.throws(() => pl(s, carl, { t: 'rx.callPlay', allyUid: carlUid }), /someone else/);
  const before = s.combat.rx.acts[carlUid];
  const called = pl(s, carl, { t: 'rx.callPlay', allyUid: donutUid, die: 5 });
  s = called.state;
  assert.equal(called.result.bonus, 5);
  assert.equal(s.combat.rx.acts[carlUid], before - 1);
  assert.throws(() => pl(s, carl, { t: 'rx.callPlay', allyUid: donutUid }), /already called/);
  assert.deepEqual(viewFor(s, pack, 'player', { playerId: donut }).combat.rx.plays.map((x) => x.bonus), [5]);
  // Donut misses by a little: the play makes it a hit.
  const evade = goblin.evade ?? 0;
  const need = 10 + evade; // fight() ad-hoc goblins: Evade = mobBase + bonus
  const miss = pl(s, donut, { t: 'roll', what: { kind: 'attack', uid: axe.result.uid }, target: goblin.uid, entered: 2 });
  s = miss.state;
  const rec = s.rolls.at(-1);
  assert.equal(rec.calledPlay?.bonus, 5, `called play used (need ${need})`);
  if (rec.calledPlay.to === 'check') assert.ok(rec.breakdown.parts.some((x) => x.source === 'play'));
  else {
    // Hit without it: the bonus rides on the damage roll.
    const dmg = pl(s, donut, { t: 'roll', what: { kind: 'attack', uid: axe.result.uid, part: 'damage' }, after: rec.id, entered: 3 });
    assert.match(dmg.state.rolls.at(-1).formula, /\+5/);
  }
  assert.equal(viewFor(s, pack, 'player', { playerId: donut }).combat.rx.plays.length, 0, 'used once');
  // Next round: Donut rolls a natural 20, the play goes to damage.
  s = gm(s, { t: 'rx.round' }).state;
  s = gm(s, { t: 'rx.step', to: 'act' }).state;
  s = pl(s, carl, { t: 'rx.callPlay', allyUid: donutUid, die: 4 }).state;
  s = pl(s, donut, { t: 'roll', what: { kind: 'attack', uid: axe.result.uid }, target: goblin.uid, entered: 20 }).state;
  const hit = s.rolls.at(-1);
  assert.equal(hit.calledPlay.to, 'damage');
  const dmg = pl(s, donut, { t: 'roll', what: { kind: 'attack', uid: axe.result.uid, part: 'damage' }, after: hit.id, entered: 3 });
  assert.match(dmg.state.rolls.at(-1).formula, /\+4/);
});

test('named turn activities and combat checks consume one action only when accepted', () => {
  let s = fight();
  const id = playerId(s, 'Carl');
  const uid = crawlerUid(s, 'Carl');
  const move = { t: 'rx.spend', activity: 'move' };
  const check = { t: 'roll', what: { kind: 'stat', id: 'str' }, useAction: 'check' };
  assert.throws(() => pl(s, id, move), /action phase|not now/);
  assert.throws(() => pl(s, id, check), /crawler actions/);
  s = gm(s, { t: 'rx.step', to: 'act' }).state;
  assert.throws(() => pl(s, id, { ...move, activity: 'clues' }), /visible boss/);
  assert.throws(() => pl(s, id, { ...move, n: 2 }), /one action/);
  s = pl(s, id, move).state;
  s.combat.rx.nonAttackActions = { [uid]: 1 };
  const rolled = pl(s, id, check);
  assert.deepEqual(rolled.result.receipt, { spent: 1, actionsLeft: 1, utilityLeft: 0 });
  const undo = pl(rolled.state, id, { t: 'roll.undo' });
  assert.equal(undo.result.receipt.utilityLeft, 1);
  assert.equal(undo.result.receipt.actionsLeft, 1);
});
