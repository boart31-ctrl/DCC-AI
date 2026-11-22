import { test } from 'node:test';
import assert from 'node:assert/strict';

test('R13: every seven-degree result that matters has a System line category (plain success / fail stay quiet)', async () => {
  const { degreeCategory } = await import('../outcome.js');
  assert.equal(degreeCategory('crit'), 'nat20');
  assert.equal(degreeCategory('amazing'), 'crit');
  assert.equal(degreeCategory('near'), 'near_fail');
  assert.equal(degreeCategory('major'), 'fail');
  assert.equal(degreeCategory('critfail'), 'nat1');
  assert.equal(degreeCategory('success'), null);
  assert.equal(degreeCategory('fail'), null);
});
