// Floor-scaled crawler rules: step() lookup tables, mob Evade / attack difficulty as "base + floor",
// ruleset fields kept through normalization, the world floor (crawlers.js) feeding the numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, validateFormula } from '../formula.js';
import { combatRules, mobDefense, mobAttackDc, floorOfState } from '../outcome.js';
import { normalizeRuleset } from '../ruleset.js';

const TABLE = 'step(x, 1, 3, 6, 10, 20, 50, 100, 150, 200, 300)';

test('step(): the stat-mod lookup table of the crawler book', () => {
  const mod = (x) => evaluate(TABLE, (n) => (n === 'x' ? x : 0)).value;
  assert.deepEqual([1, 2, 3, 5, 6, 9, 10, 19, 20, 49, 50, 99, 100, 149, 150, 199, 200, 299, 300, 1000].map(mod),
    [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10]);
  assert.equal(mod(0), 0);
  assert.match(validateFormula('step(x)'), /step\(\) takes 2/, 'needs at least one threshold');
});

test('mob numbers: base + floor when the ruleset is floor-scaled, unchanged otherwise', () => {
  const pack = (combat) => ({ ruleset: { system: { family: 'crawler' }, combat } });
  const plain = combatRules(pack({}));
  assert.equal(mobDefense(plain, 3, 4), 3, 'legacy packs: Evade is the target');
  assert.equal(mobAttackDc(plain, { toHit: 3 }, 4), 13);
  const book = combatRules(pack({ mobBase: 10, floorScaled: true }));
  assert.equal(mobDefense(book, 3, 1), 14, '10 + Dex + F on floor 1');
  assert.equal(mobDefense(book, 3, 4), 17, 'same mob on floor 4');
  assert.equal(mobAttackDc(book, { toHit: 2 }, 2), 14);
  assert.equal(mobAttackDc(book, { dc: 15 }, 3), 15, 'an absolute dc stays as written');
  assert.equal(mobAttackDc(book, { dc: 12, dcPlusFloor: true }, 3), 15, '"12+F" written as dc 12 + dcPlusFloor');
  assert.equal(floorOfState({ crawlers: { floor: 3 } }), 3);
  assert.equal(floorOfState({}), 1);
});

test('ruleset keeps mobBase, floorScaled and flow', () => {
  const r = normalizeRuleset({ stats: [{ id: 'dex', label: 'Dex' }], derived: [{ id: 'evade', label: 'Evade', formula: 'mod.dex' }], combat: { mobBase: 10, floorScaled: true, flow: 'reaction' } });
  assert.equal(r.combat.mobBase, 10);
  assert.equal(r.combat.floorScaled, true);
  assert.equal(r.combat.flow, 'reaction');
  const d = normalizeRuleset({ stats: [{ id: 'dex', label: 'Dex' }], combat: { mobBase: 99, flow: 'x' } });
  assert.equal(d.combat.mobBase, 0);
  assert.equal(d.combat.flow, 'phases');
});

import { damageToSlots, mobSlotValue } from '../outcome.js';
import { loadPack } from '../pack.js';
import { createState, normalizeState, reduce, viewFor } from '../state.js';
import { tmpDir, writePack, seq } from './fixtures.js';

test('slot health: rolled damage removes whole slots, less than one slot is lost (book example: 14 vs 3 = 4 slots)', () => {
  assert.equal(damageToSlots(14, 3), 4);
  assert.equal(damageToSlots(2, 3), 0);
  assert.equal(damageToSlots(5, 1), 5);
  assert.equal(mobSlotValue({ ruleset: { combat: { mobSlotValue: 2 } } }, {}), 2);
  assert.equal(mobSlotValue({ ruleset: { combat: { mobSlotValue: 2 } } }, { slotValue: 4 }), 4);
  assert.equal(mobSlotValue({ ruleset: { combat: {} } }, {}), 1);
  const { pack } = loadPack(writePack(tmpDir()));
  let n = 0;
  const ctx = () => ({ now: 1000, rng: seq(0.5), genId: (p) => `${p}_${++n}`, pack });
  let s = createState(pack, 0);
  s = reduce(s, { role: 'gm', t: 'combat.start' }, ctx()).state;
  s = reduce(s, { role: 'gm', t: 'combat.addAdhoc', name: 'Ogre', hp: 6, slotValue: 3, hidden: false }, ctx()).state;
  const uid = s.combat.combatants.find((x) => x.name === 'Ogre').uid;
  let r = reduce(s, { role: 'gm', t: 'combat.damage', uid, amount: 2, dr: true }, ctx());
  assert.equal(r.result.belowSlot, true);
  r = reduce(s, { role: 'gm', t: 'combat.damage', uid, amount: 14, dr: true }, ctx());
  assert.equal(r.state.combat.combatants.find((x) => x.uid === uid).hp, 2, '6 slots − 4');
  r = reduce(s, { role: 'gm', t: 'combat.damage', uid, amount: 2 }, ctx());
  assert.equal(r.state.combat.combatants.find((x) => x.uid === uid).hp, 4, 'the GM\'s −2 button stays in slots');
});

test('declared floor damage and cleanup ticks use rolled HP even when armor is skipped', () => {
  const { pack } = loadPack(writePack(tmpDir(), {
    'ruleset.json': {
      id: 'slots', stats: [{ id: 'con', label: 'Constitution', parts: ['base'], default: { base: 3 } }],
      statMod: { from: 'base', formula: 'x' }, derived: [{ id: 'dr', label: 'DR', formula: '4' }],
      tracks: [{ id: 'hp', label: 'Health', kind: 'slots', default: 10, slotValue: 'mod.con' }],
      combat: { flow: 'reaction', dr: 'dr', drMin: 0, mobSlotValue: 2 },
    },
    'monsters.json': [{ id: 'sentry', name: 'Sentry', hpSlots: 4, slotValue: 2, resist: ['fire'],
      attacks: [{ name: 'Burst', toHit: 10, damage: '1d6+floor', dtype: 'fire', effects: 'Check cover.', majorFailBuffs: ['scorch'] }] }],
    'buffs.json': [
      { id: 'scorch', name: 'Scorch', tick: { damage: '1d6', plusFloor: true, type: 'fire' } },
      { id: 'resist', name: 'Fire resistance', effects: [{ target: 'resist.fire', value: 1 }] },
      { id: 'vulnerable', name: 'Fire vulnerability', effects: [{ target: 'vulnerable.fire', value: 1 }] },
      { id: 'ward', name: 'Fire immunity', effects: [{ target: 'immune.fire', value: 1 }] },
    ],
  }));
  let state = createState(pack, 0);
  let n = 0;
  const act = (action) => {
    const r = reduce(state, { role: 'gm', ...action }, { pack, now: 1000, rollInt: () => 5, genId: (p) => `${p}_${++n}` });
    state = r.state;
    return r.result;
  };
  const resolve = () => {
    act({ t: 'rx.step', to: 'resolve' });
    const { token } = act({ t: 'rx.resolveNext', op: 'preview', all: true });
    act({ t: 'rx.resolveNext', op: 'apply', all: true, token, confirm: true });
  };
  act({ t: 'player.add', name: 'Runner' });
  act({ t: 'crawlers.set', floor: 2 });
  const { uids: [mobUid] } = act({ t: 'combat.addMob', sourceId: 'sentry', hidden: false });
  act({ t: 'combat.start' });
  const runner = () => viewFor(state, pack, 'gm').combat.combatants.find((x) => x.type === 'crawler');
  const targetUid = runner().uid;
  act({ t: 'combat.set', settings: { drMin: 5 } });
  assert.equal(act({ t: 'combat.damage', uid: targetUid, amount: 4, dr: true }).rolled, 0, 'pack overrides old tracker minimum');
  assert.equal(runner().hp, 10);
  act({ t: 'rx.declare', mobUid, targetUid });
  assert.equal(viewFor(state, pack, 'gm').combat.rx.decls[0].effects, 'Check cover.');
  act({ t: 'rx.step', to: 'react' });
  assert.equal(viewFor(state, pack, 'stage').combat.rx.decls[0].effects, undefined);
  resolve();
  assert.deepEqual([state.combat.rx.decls[0].damage, state.combat.rx.decls[0].slots], [8, 1]);
  assert.equal(runner().hp, 9);
  assert.deepEqual(runner().conditions, [], 'an unopposed hit does not cause a Major Fail effect');
  act({ t: 'combat.condition', uid: targetUid, buffId: 'scorch', on: true });
  act({ t: 'combat.condition', uid: mobUid, buffId: 'scorch', on: true });
  act({ t: 'rx.round' });
  assert.equal(runner().hp, 7, '8 tick HP ignores armor and costs two three-HP slots');
  assert.equal(state.combat.combatants.find((x) => x.uid === mobUid).hp, 2, 'fire resistance applies even when armor does not');
  const { declId } = act({ t: 'rx.declare', mobUid, targetUid });
  act({ t: 'combat.condition', uid: targetUid, buffId: 'scorch', on: false });
  act({ t: 'rx.step', to: 'react' });
  const pid = state.players[0].id;
  state = reduce(state, { role: 'player', actorId: pid, t: 'rx.interrupt', kind: 'evade' }, { pack }).state;
  act({ t: 'rx.evade', declId, die: 2 });
  resolve();
  assert.equal(runner().conditions[0].id, 'scorch', 'the declared Major Fail effect is applied on the qualifying Evade');
  act({ t: 'combat.condition', uid: targetUid, buffId: 'scorch', on: false });
  const rawFire = () => act({ t: 'combat.damage', uid: targetUid, amount: 8, dr: true, dtype: 'fire' });
  act({ t: 'combat.condition', uid: targetUid, buffId: 'resist', on: true });
  assert.equal(rawFire().belowSlot, true, 'resistance halves the 4 HP that passed DR');
  act({ t: 'combat.condition', uid: targetUid, buffId: 'resist', on: false });
  act({ t: 'combat.condition', uid: targetUid, buffId: 'vulnerable', on: true });
  assert.equal(rawFire().actualAmount, 2, 'vulnerability doubles the 4 HP before slot conversion');
  act({ t: 'combat.condition', uid: targetUid, buffId: 'ward', on: true });
  assert.equal(rawFire().typed, 'immune', 'immunity overrides vulnerability');
  act({ t: 'rx.round' });
  act({ t: 'combat.heal', uid: mobUid, amount: 2 });
  const followup = act({ t: 'rx.declare', mobUid, targetUid });
  act({ t: 'rx.step', to: 'react' });
  state = reduce(state, { role: 'player', actorId: pid, t: 'rx.interrupt', kind: 'evade' }, { pack }).state;
  act({ t: 'rx.evade', declId: followup.declId, die: 1 });
  resolve();
  assert.equal(state.combat.rx.decls[0].slots, 0);
  assert.ok(!runner().conditions.some((c) => c.id === 'scorch'), 'typed immunity also blocks the attack condition');
});

test('standalone and linked bosses use rolled HP while the saved combatant keeps its slot count', () => {
  const makePack = (hpSlots, slotValue) => loadPack(writePack(tmpDir(), {
    'ruleset.json': { id: 'slots', combat: { hpModel: 'slots', drMin: 0, mobSlotValue: 2 } },
    'bosses.json': [{ id: 'behemoth', name: 'Behemoth', hpSlots, slotValue, dr: 1, phases: [{ name: 'Guard' }, { name: 'Charge', atHp: 4 }] }],
  })).pack;
  const pack = makePack(8, 3);
  let state = createState(pack, 0);
  let i = 0;
  const act = (action, currentPack = pack) => {
    const r = reduce(state, { role: 'gm', ...action }, { pack: currentPack, now: 1000, genId: (p) => `${p}_${++i}` });
    state = r.state;
    return r.result;
  };
  act({ t: 'scene.set', kind: 'boss', data: { bossId: 'behemoth' } });
  assert.equal(act({ t: 'boss.damage', amount: 3, dr: true }).belowSlot, true);
  assert.equal(act({ t: 'boss.damage', amount: 7, dr: true }).hp, 6);
  const { uids: [uid] } = act({ t: 'combat.addMob', kind: 'boss', sourceId: 'behemoth', hidden: false });
  act({ t: 'combat.start' });
  act({ t: 'scene.set', kind: 'boss', data: { bossId: 'behemoth' } });
  assert.equal(act({ t: 'combat.damage', uid, amount: 7, dr: true }).hp, 6);
  assert.equal(state.scene.data.hp, 6);
  act({ t: 'combat.update', uid, hpMax: 9, hp: 7 });
  assert.deepEqual([state.scene.data.hp, state.scene.data.boss.hpSlots], [7, 9]);
  assert.equal(viewFor(state, pack, 'stage').combat.combatants[0].slotValue, undefined);
  act({ t: 'combat.set', showMobHp: true });
  assert.equal(viewFor(state, pack, 'stage').combat.combatants[0].slotValue, 3);
  const replacement = makePack(5, 4);
  state = normalizeState(state, replacement);
  act({ t: 'scene.set', kind: 'boss', data: { bossId: 'behemoth' } }, replacement);
  assert.deepEqual([state.scene.data.hp, state.scene.data.boss.hpSlots, state.scene.data.boss.slotValue], [7, 9, 3]);
  assert.equal(act({ t: 'boss.damage', amount: 7, dr: true }, replacement).hp, 5);
  assert.equal(state.combat.combatants[0].hp, 5);
});

test('structured conditions block the appropriate actions and expire on cleanup or combat end', () => {
  const { pack } = loadPack(writePack(tmpDir(), {
    'ruleset.json': {
      id: 'status', combat: { flow: 'reaction' },
      tracks: [{ id: 'hp', label: 'Health', kind: 'slots', default: 10, slotValue: '1' }],
    },
    'spells.json': [{ id: 'lamp', name: 'Lamp', cost: 0 }],
    'buffs.json': [
      { id: 'still', name: 'Still', blocks: ['action'], rounds: 2 },
      { id: 'silenced', name: 'Silenced', blocks: ['spell'], endCombat: true },
      { id: 'stuck', name: 'Stuck', blocks: ['interrupt'], endCombat: true },
      { id: 'blight', name: 'Blight', blocks: ['heal'], endCombat: true },
      { id: 'ongoing', name: 'Ongoing' },
    ],
  }));
  let state = createState(pack, 0), n = 0, pid;
  const call = (a, role = 'gm') => reduce(state, { role, ...(role === 'player' ? { actorId: pid } : {}), ...a }, { pack, genId: (p) => `${p}_${++n}` });
  const act = (a, role) => { const r = call(a, role); state = r.state; return r.result; };
  pid = act({ t: 'player.add', name: 'Runner' }).playerId;
  const { uid: spellUid } = act({ t: 'spell.learn', playerId: pid, spellId: 'lamp' });
  act({ t: 'combat.start' });
  const uid = state.combat.combatants.find((m) => m.playerId === pid).uid;
  const { uids: [mobUid] } = act({ t: 'combat.addAdhoc', name: 'Sentinel', hp: 12, hidden: false, attacks: [{ name: 'Swing', damage: '1' }] });
  const condition = (buffId, target = uid) => act({ t: 'combat.condition', uid: target, buffId, on: true });
  condition('still');
  condition('still', mobUid);
  assert.throws(() => call({ t: 'rx.declare', mobUid, targetUid: uid }), /Blocked by Still/);
  assert.equal(act({ t: 'rx.suggest' }).count, 0);
  act({ t: 'rx.step', to: 'act' });
  assert.throws(() => call({ t: 'rx.spend' }, 'player'), /Blocked by Still/);
  act({ t: 'rx.round' });
  assert.equal(state.players[0].sheet.buffs[0].roundsLeft, 1);
  act({ t: 'rx.round' });
  assert.deepEqual(state.players[0].sheet.buffs, []);
  assert.equal(act({ t: 'rx.suggest' }).count, 1);
  condition('stuck');
  act({ t: 'rx.step', to: 'react' });
  assert.throws(() => call({ t: 'rx.interrupt', kind: 'evade' }, 'player'), /Blocked by Stuck/);
  act({ t: 'rx.step', to: 'resolve' });
  const preview = act({ t: 'rx.resolveNext', op: 'preview' });
  act({ t: 'rx.resolveNext', op: 'apply', token: preview.token });
  act({ t: 'rx.step', to: 'act' });
  act({ t: 'rx.spend' }, 'player');
  condition('silenced');
  assert.throws(() => call({ t: 'spell.cast', uid: spellUid }, 'player'), /Blocked by Silenced/);
  condition('blight');
  assert.throws(() => call({ t: 'combat.heal', uid, amount: 1 }), /Blocked by Blight/);
  condition('ongoing');
  act({ t: 'combat.end', outcome: 'truce' });
  assert.deepEqual(state.players[0].sheet.buffs.map((b) => b.buffId), ['ongoing']);
});
