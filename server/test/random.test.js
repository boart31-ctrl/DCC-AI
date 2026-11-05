import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randInt, makeToken, makeRoomCode, makePin, genId, ROOM_ALPHABET } from '../random.js';
import * as auth from '../auth.js';

test('randInt stays in range and covers it', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const x = randInt(7);
    assert.ok(Number.isInteger(x) && x >= 0 && x < 7);
    seen.add(x);
  }
  assert.equal(seen.size, 7);
  assert.throws(() => randInt(0), RangeError);
  assert.throws(() => randInt(1.5), RangeError);
});

test('tokens are url-safe, ≥24 chars, unique', () => {
  const a = makeToken();
  assert.match(a, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(a, makeToken());
  assert.match(makeToken(30), /^[A-Za-z0-9_-]{40}$/);
});

test('room code, pin, genId', () => {
  const code = makeRoomCode();
  assert.equal(code.length, 4);
  for (const ch of code) assert.ok(ROOM_ALPHABET.includes(ch));
  assert.match(makePin(), /^\d{4}$/);
  assert.match(genId('p'), /^p_[0-9a-z]{8}$/);
});

test('auth.js re-exports the same helpers (backwards compatible)', () => {
  assert.equal(auth.makeToken, makeToken);
  assert.equal(auth.makeRoomCode, makeRoomCode);
  assert.equal(auth.makePin, makePin);
  assert.equal(auth.ROOM_ALPHABET, ROOM_ALPHABET);
});
