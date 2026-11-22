import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whatNow } from '../../web/js/whatnow.js';

const crawler = (uid, name) => ({ uid, type: 'crawler', name });
const fight = (rx) => ({ players: [{ id: 'p1', name: 'Barbie' }], session: {}, gm: {}, combat: { active: true, round: rx.round, combatants: [crawler('c1', 'Barbie'), crawler('c2', 'Carl'), { uid: 'm1', type: 'mob', name: 'Wolf 1' }], rx } });

test('What now walks the reaction round step by step with the right button', () => {
  let n = whatNow(fight({ round: 2, step: 'declare', decls: [] })).main;
  assert.match(n.text, /Round 2 · announce/);
  assert.deepEqual(n.act, { t: 'rx.suggest' });
  n = whatNow(fight({ round: 2, step: 'react', decls: [{ id: 'd1', mob: 'Wolf 1', targetUid: 'c1', canEvade: true }, { id: 'd2', mob: 'Wolf 1', targetUid: 'c2', canEvade: false }] })).main;
  assert.match(n.text, /waiting for Evade: Barbie$/);
  assert.equal(n.act, undefined, 'never skips missing Evades by itself');
  n = whatNow(fight({ round: 2, step: 'resolve', decls: [{ id: 'd1', mob: 'Wolf 1', targetUid: 'c1', result: 'hit' }, { id: 'd2', mob: 'Wolf 1', targetUid: 'c2' }] })).main;
  assert.match(n.text, /resolve next hit \(1 left\): Wolf 1 → Carl/);
  assert.equal(n.go, 'combat');
  n = whatNow(fight({ round: 2, step: 'act', decls: [], acts: { c1: 0, c2: 1 } })).main;
  assert.match(n.text, /crawlers act: Carl$/);
  assert.deepEqual(whatNow(fight({ round: 2, step: 'cleanup', decls: [] })).main.act, { t: 'rx.round' });
});

test('Panic Hold wins; outside a fight it points at the next prepared scene; waiting items become chips', () => {
  assert.deepEqual(whatNow({ ...fight({ round: 1, step: 'declare', decls: [] }), session: { hold: true } }).main.act, { t: 'session.hold', on: false });
  const v = {
    players: [{ id: 'p1', name: 'Barbie' }], session: {}, combat: { active: false },
    gm: {
      prep: { current: 'd1', docs: [{ id: 'd1', title: 'Prickly Pack Alleys', evening: { activeSceneId: 's1', scenes: [{ id: 's1', title: 'Arrival', played: true }, { id: 's2', title: 'First pack' }] } }] },
      prepChecks: [{ ability: 'Perception', recipients: [{ playerId: 'p1' }] }],
      playersFull: [{ name: 'Barbie', sheet: { gearRequest: [{ name: 'Rope' }] } }],
      advancementClock: { due: true },
    },
  };
  const r = whatNow(v, { unread: 2 });
  assert.equal(r.main.text, 'Next scene · First pack');
  assert.deepEqual(r.main.act, { t: 'prep.scene.run', id: 'd1', sceneId: 's2' });
  assert.deepEqual(r.more.map((m) => m.text), ['Barbie asks for 1 item', 'Waiting for Perception check: Barbie', '2 h of play: level-up?']);
  assert.equal(whatNow({ players: [], session: {}, gm: {}, combat: {} }).main.text, 'Add your players');
});
