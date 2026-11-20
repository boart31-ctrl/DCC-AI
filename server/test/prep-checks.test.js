import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDC, checkDCPresets } from '../../web/js/check-dc.js';
import { loadPack } from '../pack.js';
import { createState, normalizeState, reduce, reducePlayerAction, viewFor } from '../state.js';
import { tmpDir, writePack } from './fixtures.js';

test('scene DC tools use floor-based options and printed tables', () => {
  assert.equal(checkDC({ dcType: 'stat' }, {}, { floor: 3 }), 13);
  assert.equal(checkDC({ dcType: 'unopposed' }, {}, { floor: 3 }), 16);
  assert.equal(checkDC({ dcType: 'opposed', mod: 4 }, {}, { floor: 3, adjustment: -5 }), 12);
  for (const family of ['dnd', 'pf2e']) {
    const ruleset = { system: { family } };
    assert.equal(checkDC({ dcType: 'fixed', dc: 17 }, ruleset, { floor: 3 }), 17);
    assert.equal(checkDCPresets(ruleset).length, family === 'dnd' ? 6 : 27);
  }
  assert.equal(checkDCPresets({ system: { family: 'pf2e' } }).find((p) => p.label === 'Level 20').dc, 40);
});

test('private scene checks reach only selected phones and persist until exactly one reply per recipient', () => {
  const { pack } = loadPack(writePack(tmpDir(), {
    'ruleset.json': { id: 'checks', stats: [{ id: 'dex', label: 'Dexterity', default: 2 }], statMod: { formula: 'x' },
      combat: { degreeScale: 'seven' },
      skills: { usedTracking: true, checkTypes: ['Opposed'], check: { formula: 'skill.rank + mod.{stat} + buff.check' },
        untrained: { adv: 'dis', formula: 'mod.{stat}', learn: true, learnMaxFloor: 2 } } },
    'skills.json': [{ id: 'stealth', name: 'Stealth', checkType: 'Opposed', stat: 'dex' }],
    'buffs.json': [{ id: 'hobbled', name: 'Hobbled', effects: [{ target: 'check', value: -2 }] }],
  }));
  let state = createState(pack, 0);
  let n = 0;
  const ctx = { pack, now: 1000, genId: (prefix) => `${prefix}_${++n}` };
  const commit = (r) => { state = r.state; return r; };
  const gm = (a) => commit(reduce(state, { role: 'gm', ...a }, ctx));
  const reply = (playerId, a, extra) => commit(reducePlayerAction(state, a, { ...ctx, playerId, ...extra }));
  const view = (role, playerId) => viewFor(state, pack, role, { ...ctx, playerId });
  const first = gm({ t: 'player.add', name: 'Runner' }).result.playerId;
  const second = gm({ t: 'player.add', name: 'Scout' }).result.playerId;
  const outsider = gm({ t: 'player.add', name: 'Bystander' }).result.playerId;
  gm({ t: 'skill.add', playerId: first, skillId: 'stealth', rank: 3 });
  gm({ t: 'crawlers.set', floor: 2 });
  const { id: docId } = gm({ t: 'prep.session.add' }).result;
  const { sceneId } = gm({ t: 'prep.scene.add', id: docId, type: 'explore' }).result;
  const check = { id: 'checkpoint', label: 'Slip through', skillId: 'stealth', dcType: 'opposed', mod: 5,
    near: 'A guard heard something.', fail: 'The guard investigates.', success: 'You pass the checkpoint.' };
  gm({ t: 'prep.scene.update', id: docId, sceneId, patch: { checks: [check] } });
  const send = { t: 'prep.check.send', docId, sceneId, checkId: check.id, playerIds: [first, second], requestId: 'first-send' };
  const { id } = gm(send).result;
  const stealth = { id, label: 'Slip through', ability: 'Stealth' };
  assert.deepEqual(view('player', first).checkPrompts, [stealth]);
  assert.deepEqual(view('player', second).checkPrompts, [{ ...stealth, advantage: 'dis' }]);
  assert.deepEqual(view('player', outsider).checkPrompts, []);
  assert.equal(view('stage').checkPrompts, undefined);
  assert.equal(view('player', first).gm, undefined);
  assert.equal(view('gm').gm.prepChecks[0].dc, 17);
  assert.equal(gm(send).result.id, id);
  assert.equal(view('gm').gm.prepChecks.length, 1);

  gm({ t: 'crawlers.set', floor: 4 });
  state = normalizeState(JSON.parse(JSON.stringify(state)), pack, ctx.now);
  assert.deepEqual(view('player', first).checkPrompts, [stealth], 'a reconnect keeps the original prompt');
  const response = { t: 'prep.check.reply', id, entered: 10 };
  assert.throws(() => reply(outsider, response), /not assigned/);
  assert.throws(() => reply(first, { ...response, entered: 0 }), /d20 face/);
  const acknowledged = reply(first, response);
  assert.deepEqual(acknowledged.result, { received: true });
  assert.deepEqual(acknowledged.events, []);
  assert.equal(state.players[0].sheet.skills[0].used, true);
  assert.deepEqual(view('player', first).checkPrompts, []);
  assert.equal(reply(first, { ...response, entered: 20 }).changed, false);

  const faces = [19, 4];
  reply(second, { t: 'prep.check.reply', id }, { rollInt: () => faces.shift() });
  const [returned] = view('gm').gm.prepChecks;
  assert.deepEqual(returned.recipients.map(({ result }) => [result.die, result.total, result.degree]), [[10, 15, 'near'], [5, 7, 'major']]);
  assert.equal(returned.dc, 17);
  assert.equal(view('gm').rolls.length, 0, 'private rolls never reach the dice log');
  assert.deepEqual(view('player', second).checkPrompts, []);
  state = normalizeState(JSON.parse(JSON.stringify(state)), pack, ctx.now);
  assert.deepEqual(view('player', second).me.sheet.untried, ['stealth'], 'tutorial-floor skill practice survives a reconnect');

  const again = gm({ ...send, playerIds: [first], requestId: 'second-send' }).result.id;
  gm({ t: 'prep.check.close', id: again });
  assert.deepEqual(view('player', first).checkPrompts, []);
  assert.throws(() => reply(first, { ...response, id: again }), /GM closed/);

  const statCheck = { id: 'balance', label: 'Keep your footing', statId: 'dex', dcType: 'stat' };
  gm({ t: 'prep.scene.update', id: docId, sceneId, patch: { checks: [check, statCheck] } });
  gm({ t: 'buff.add', playerId: first, buffId: 'hobbled' });
  const stat = gm({ ...send, checkId: statCheck.id, playerIds: [first], requestId: 'balance-send' }).result.id;
  reply(first, { ...response, id: stat, entered: 12 });
  const statResult = view('gm').gm.prepChecks.at(-1).recipients[0].result;
  assert.deepEqual(statResult, { die: 12, total: 12, degree: 'near', at: ctx.now });
  const sheetRoll = gm({ t: 'roll', playerId: first, what: { kind: 'stat', id: 'dex' }, entered: 12, dc: 14 }).result;
  assert.equal(sheetRoll.total, statResult.total, 'normal and private Prep Stat rolls include the same broad injury modifier');
  assert.equal(sheetRoll.roll.vs.deg7, statResult.degree);
  const trained = gm({ t: 'roll', playerId: first, what: { kind: 'skill', uid: state.players[0].sheet.skills[0].uid }, entered: 12 }).result;
  assert.equal(trained.total, 15, 'trained checks still count the broad modifier once');
});
