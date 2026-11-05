import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAI } from '../ai.js';

test('without key: unavailable and never calls fetch', async () => {
  let called = false;
  const ai = createAI({}, () => (called = true));
  assert.equal(ai.aiAvailable, false);
  assert.equal(await ai.generateComment({ situation: 'x' }), null);
  assert.equal(called, false);
});

test('with key: correct request, parses text, enforces call cap, null on failure', async () => {
  const reqs = [];
  const fetchOk = async (url, init) => {
    reqs.push({ url, init });
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: '"A fine achievement."' }] }) };
  };
  const ai = createAI({ ANTHROPIC_API_KEY: 'k', AI_MAX_CALLS: '2' }, fetchOk);
  assert.equal(ai.aiAvailable, true);
  assert.equal(await ai.generateAchievementText({ title: 'Duck Lord' }), 'A fine achievement.');
  const { url, init } = reqs[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  assert.equal(init.headers['x-api-key'], 'k');
  assert.equal(JSON.parse(init.body).model, 'claude-haiku-5-5');
  await ai.generateComment({ situation: 'x' });
  assert.equal(await ai.generateComment({ situation: 'y' }), null, 'cap reached');
  assert.equal(reqs.length, 2);
  ai.resetSession();
  assert.equal(ai.callsLeft, 2);

  const failing = createAI({ ANTHROPIC_API_KEY: 'k' }, async () => ({ ok: false }));
  assert.equal(await failing.generateComment({}), null);
  const throwing = createAI({ ANTHROPIC_API_KEY: 'k' }, async () => {
    throw new Error('net');
  });
  assert.equal(await throwing.generateComment({}), null);
});
