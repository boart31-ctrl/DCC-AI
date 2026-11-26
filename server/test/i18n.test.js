import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, translate } from '../../web/js/i18n.js';
import cs from '../../web/js/i18n-cs.js';

const d = compile(cs);

test('i18n: exact strings keep their surrounding spaces', () => {
  assert.equal(translate('Join the game', d), 'Připojit se ke hře');
  assert.equal(translate('  Dice log ', d), '  Záznam hodů ');
  assert.equal(translate('Carl', d), null, 'names stay as they are');
  assert.equal(translate('42', d), null);
});

test('i18n: patterns fill {1} and Czech plurals', () => {
  assert.equal(translate('Round 3', d), 'Kolo 3');
  assert.equal(translate('1 slot lost', d), '1 slot ztracen');
  assert.equal(translate('3 slots lost', d), '3 sloty ztraceny');
  assert.equal(translate('7 slots lost', d), '7 slotů ztraceno');
  assert.equal(translate('2 crawlers left', d), 'zbývají 2 crawleři');
  assert.equal(translate('Threat detected // Floor 1', d), 'Zjištěna hrozba // Patro 1');
});

test('i18n: a captured part that is itself a known word is translated too', () => {
  assert.equal(translate('Remove Hotlist', d), 'Odebrat Hotlist');
  assert.equal(translate('Dying · 2 rounds left', d), 'Umírá · zbývají 2 kola');
});

test('i18n: every Czech pattern compiles and no entry is empty', () => {
  for (const [en, out] of Object.entries(cs)) {
    assert.ok(out && typeof out === 'string', `empty translation for ${en}`);
    const holes = en.split('{}').length - 1;
    for (const m of out.matchAll(/\{(\d)/g)) assert.ok(Number(m[1]) <= holes, `${en}: {${m[1]}} has no match`);
  }
});
