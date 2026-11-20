import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { createState, normalizeState, reduce, reducePlayerAction, viewFor } from '../state.js';
import { tmpDir, writePack } from './fixtures.js';

function table(reaction = true) {
  const { pack } = loadPack(writePack(tmpDir(), { 'ruleset.json': {
    id: 'journal', combat: { flow: reaction ? 'reaction' : 'phases', drMin: 0 },
    tracks: [{ id: 'hp', label: 'Health', kind: reaction ? 'slots' : 'pool', default: 10, ...(reaction ? { slotValue: 1 } : {}) }],
  } }));
  let state = createState(pack, 0);
  let n = 0;
  const current = () => ({ pack, now: 1000 + n, genId: (p) => `${p}_${++n}`, rollInt: () => 14 });
  const gm = (action, extra = {}) => {
    const r = reduce(state, { role: 'gm', ...action }, { ...current(), ...extra });
    state = r.state;
    return r.result;
  };
  const player = (playerId, action) => {
    const r = reducePlayerAction(state, action, { ...current(), playerId });
    state = r.state;
    return r.result;
  };
  const history = (pid) => viewFor(state, pack, 'player', { playerId: pid }).combat.history;
  const uid = (pid) => state.combat.combatants.find((x) => x.playerId === pid)?.uid;
  const { playerId: hero } = gm({ t: 'player.add', name: 'Hero' });
  const { playerId: ally } = gm({ t: 'player.add', name: 'Ally' });
  gm({ t: 'combat.start' });
  return { gm, player, history, uid, hero, ally, state: () => state,
    restore: () => { state = normalizeState(JSON.parse(JSON.stringify(state)), pack, 0); },
    view: (role) => viewFor(state, pack, role) };
}

const enemy = (gm) => gm({ t: 'combat.addAdhoc', name: 'Veiled foe', hp: 20, hidden: false,
  attacks: [{ name: 'Private claw', toHit: 9, damage: '2' }] }).uids[0];

test('only the target sees incoming outcomes, with Evade and damage de-duplicated across a restore and undo', () => {
  const { gm, player, history, uid, hero, ally, restore, view } = table();
  const mob = enemy(gm);
  const ids = [hero, ally, hero].map((pid) => gm({ t: 'rx.declare', mobUid: mob, targetUid: uid(pid) }).declId);
  assert.deepEqual(history(hero), []);
  gm({ t: 'rx.step', to: 'react' });
  player(hero, { t: 'rx.interrupt', kind: 'evade' });
  player(hero, { t: 'rx.evade', declId: ids[0], die: 20 });
  assert.deepEqual(history(hero).map((r) => [r.kind, r.die]), [['evade', 20]]);
  assert.deepEqual(history(ally), []);
  gm({ t: 'rx.step', to: 'resolve', force: true });
  const next = (op) => {
    const { token } = gm({ t: 'rx.resolveNext' });
    gm({ t: 'rx.resolveNext', op, token });
  };
  next('apply');
  assert.deepEqual(history(hero).map((r) => [r.kind, r.result, r.die]), [['incoming', 'evaded', 20]]);
  gm({ t: 'combat.reveal', uid: mob, on: false });
  next('apply');
  next('skip');
  assert.deepEqual(history(hero).map((r) => [r.result, r.amount]), [['skipped', 0], ['evaded', 0]]);
  assert.deepEqual(history(ally).map((r) => [r.result, r.amount, r.label]), [['hit', 2, 'Unseen attacker']]);
  assert.ok(!JSON.stringify(history(ally)).includes('Private claw'));
  assert.equal(view('gm').combat.history, undefined);
  assert.equal(view('stage').combat.history, undefined);
  const snapshot = [history(hero), history(ally)];
  restore();
  assert.deepEqual([history(hero), history(ally)], snapshot);
  gm({ t: 'rx.resolveNext', op: 'undo' });
  assert.deepEqual(history(ally), []);
  assert.equal(history(hero).length, 2);
  gm({ t: 'rx.resolveNext', op: 'undo' });
  assert.deepEqual(history(hero).map((r) => r.kind).sort(), ['evade', 'incoming']);
});

test('linked attack damage shares one row, roll void restores the hit, and the owner sees at most five results', () => {
  const { gm, player, history, uid, hero, ally, restore } = table();
  const mob = enemy(gm);
  const { uid: weapon } = gm({ t: 'attack.add', playerId: hero, name: 'Axe', dice: '1d6' });
  gm({ t: 'rx.step', to: 'act' });
  const attack = { t: 'roll', target: mob, what: { kind: 'attack', uid: weapon } };
  const hit = player(hero, { ...attack, entered: 20, useAction: true });
  const hitRow = history(hero)[0];
  assert.equal(hitRow.result, 'hit');
  const damage = player(hero, { ...attack, what: { ...attack.what, part: 'damage' }, after: hit.rollId, entered: 4 });
  assert.deepEqual(history(hero).map((r) => r.id), [hitRow.id]);
  assert.equal(history(hero)[0].result, 'damage');
  assert.deepEqual(history(ally), []);
  gm({ t: 'roll.void', id: damage.rollId });
  assert.equal(history(hero)[0].result, 'hit');
  gm({ t: 'roll.restore', id: damage.rollId });
  assert.equal(history(hero)[0].result, 'damage');
  const id = history(hero)[0].id;
  for (let i = 0; i < 6; i++) {
    gm({ t: 'rx.actions', uid: uid(hero), delta: 1 });
    player(hero, { t: 'rx.spend' });
  }
  assert.equal(history(hero).length, 5);
  assert.ok(history(hero).every((r) => r.kind === 'action' && r.id !== id));
  restore();
  assert.equal(history(hero).length, 5);
  gm({ t: 'combat.end', outcome: 'truce' });
  assert.equal(history(hero).length, 5, 'remains visible in the break');
  gm({ t: 'combat.start' });
  assert.deepEqual(history(hero), []);
});

test('classic manual and AUTO results are private, undoable and hide GM-only attacker details', () => {
  const { gm, player, history, uid, hero, ally } = table(false);
  const mob = enemy(gm);
  const targetUid = uid(hero);
  gm({ t: 'combat.damage', uid: targetUid, amount: 3 });
  assert.deepEqual(history(hero).map((r) => [r.label, r.amount]), [['Damage taken', 3]]);
  gm({ t: 'combat.undo' });
  assert.deepEqual(history(hero), []);

  gm({ t: 'combat.mobAct', uid: mob, targetUid, tv: false });
  assert.deepEqual(history(hero).map((r) => [r.label, r.amount]), [['Damage taken', 2]]);
  assert.ok(!JSON.stringify(history(hero)).includes('Private claw'));
  gm({ t: 'combat.autoUndo' });
  assert.deepEqual(history(hero), []);
  gm({ t: 'combat.mobAct', uid: mob, targetUid });
  assert.equal(history(hero)[0].label, 'Veiled foe');
  assert.equal(history(hero)[0].amount, 2);
  assert.deepEqual(history(ally), []);
  gm({ t: 'combat.autoUndo' });
  assert.deepEqual(history(hero), []);

  const { uid: weapon } = gm({ t: 'attack.add', playerId: hero, name: 'Club', dice: '1d4' });
  const action = { t: 'roll', what: { kind: 'attack', uid: weapon }, target: mob, entered: 20 };
  gm({ ...action, playerId: hero, secret: true });
  assert.deepEqual(history(hero), []);
  const own = player(hero, action);
  assert.equal(history(hero)[0].result, 'hit');
  gm({ t: 'roll.void', id: own.rollId });
  assert.deepEqual(history(hero), []);
});
