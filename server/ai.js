// Optional AI provider (Anthropic Messages API). Disabled without ANTHROPIC_API_KEY.
// Every function resolves to null on any failure — callers must always have a non-AI fallback.

const API_URL = 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = 8_000;

const SYSTEM_PROMPT =
  'You are "The System", the sardonic, theatrical announcer of a game-show-style tabletop RPG night. ' +
  'Reply with ONE short line only (max 25 words), no quotes, no emojis, no stage directions. ' +
  'Be witty, never cruel to real people, family friendly unless the context says otherwise.';

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function createAI(env = process.env, fetchImpl = globalThis.fetch) {
  const key = env.ANTHROPIC_API_KEY?.trim() || '';
  const model = env.AI_MODEL?.trim() || 'claude-haiku-5-5';
  const maxCalls = Number.parseInt(env.AI_MAX_CALLS ?? '30', 10);
  const cap = Number.isFinite(maxCalls) && maxCalls >= 0 ? maxCalls : 30;
  let calls = 0;

  const available = () => !!key && calls < cap;

  async function complete(user, maxTokens = 80) {
    if (!key || calls >= cap || typeof fetchImpl !== 'function') return null;
    calls++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(API_URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: user }],
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const text = data?.content?.find?.((c) => c.type === 'text')?.text;
      const line = clip(text, 300).replace(/^["']|["']$/g, '');
      return line || null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get aiAvailable() {
      return !!key;
    },
    get callsLeft() {
      return key ? Math.max(0, cap - calls) : 0;
    },
    available,
    /** New session → fresh call budget. */
    resetSession() {
      calls = 0;
    },
    /** context: { title, playerName?, klass?, race? } → one-sentence achievement description, or null. */
    generateAchievementText(context = {}) {
      const who = [context.playerName, context.race, context.klass].filter(Boolean).map((s) => clip(s, 40)).join(', ');
      return complete(
        `Write the flavour description for a newly unlocked achievement titled "${clip(context.title, 80)}"` +
          (who ? ` awarded to ${who}` : '') +
          '. One sentence, dry humour.',
        60,
      );
    },
    /** context: { situation, recent?: string[] } → one spontaneous comment, or null. Phase-3 hook (P2 director). */
    generateComment(context = {}) {
      const recent = Array.isArray(context.recent) ? context.recent.slice(-5).map((s) => `- ${clip(s, 120)}`).join('\n') : '';
      return complete(`Situation: ${clip(context.situation, 300)}${recent ? `\nRecent events:\n${recent}` : ''}\nComment on it.`, 80);
    },
  };
}
