// Czech System lines and audience chat (27 Nov): `cs` on a quip / chat line, picked when the TV is in Czech.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChatLines, createChat } from '../chat.js';
import { lineForLang, looksCzech, fallbackPack } from '../pack-core.js';
import { voiceLines } from '../tts.js';

test('lineForLang: Czech TV speaks the cs line and asks for a Czech voice; English TV keeps the original', () => {
  const pack = { quipsById: new Map([['q1', { id: 'q1', text: 'A one. Ouch.', cs: 'Jednička. Au.' }]]) };
  assert.deepEqual(lineForLang(pack, { quipId: 'q1', text: 'A one. Ouch.' }, 'cs'), { text: 'Jednička. Au.', lang: 'cs-CZ', swapped: true });
  assert.deepEqual(lineForLang(pack, { quipId: 'q1', text: 'A one. Ouch.' }, 'en'), { text: 'A one. Ouch.', lang: null, swapped: false });
  assert.equal(lineForLang(pack, { quipId: null, text: 'Ořízková mluví pomalu.' }, 'en').lang, 'cs-CZ', 'Czech director text gets a Czech voice even on an English TV');
  assert.equal(looksCzech('Hello'), false);
});

test('chat: cs lines when the TV is in Czech, placeholders filled in both', () => {
  const lines = normalizeChatLines([{ user: 'fan_1', text: 'GO {player}', cs: 'JEĎ {player}', tags: ['idle'] }]);
  assert.equal(lines[0].cs, 'JEĎ {player}');
  const chat = createChat({ lines, rng: () => 0.1, recent: 0 });
  const state = (lang) => ({ session: { tvLang: lang }, scene: { kind: 'lobby', data: {} }, players: [{ id: 'p', name: 'Hana' }] });
  assert.equal(chat.pick('idle', state('cs')).text, 'JEĎ Hana');
  assert.equal(chat.pick('idle', state('en')).text, 'GO Hana');
});

test('voice plan: with the TV in Czech the Czech quip is pre-rendered, recorded or not', () => {
  const pack = { ...fallbackPack(), quips: [{ id: 'q1', category: 'nat1', text: 'A one.', cs: 'Jednička.', audio: '/pack/audio/q1.mp3', audioByVoice: {} }] };
  assert.deepEqual(voiceLines(pack, { session: { tvLang: 'cs' } }).filter((l) => l.kind === 'quip').map((l) => l.text), ['Jednička.']);
  assert.deepEqual(voiceLines(pack, { session: { tvLang: 'en' } }).filter((l) => l.kind === 'quip').map((l) => l.text), []);
});
