// Access helpers shared by every host (Node server, Cloudflare Durable Object). Browser-safe: no Node imports.
//   safeEqual        constant-time string compare (no early exit on the first differing char)
//   RateLimiter      sliding-window failure counter per key (e.g. 5 failed logins per IP per minute)
//   TokenBucket      per-socket message rate limit
//   authenticate     legacy hello check (gm/stage token, room + PIN) — Node edition backwards compat
//   makePairCode     4-letter TV pairing code without look-alike letters
import { ROOM_ALPHABET } from './constants.js';
import { randInt } from './random.js';

/** Constant-time compare of two strings (time depends only on the longer length). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

/** Sliding-window limiter: `max` failures per key per `windowMs`. */
export class RateLimiter {
  constructor({ max = 5, windowMs = 60_000, now = Date.now } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.fails = new Map();
  }

  _recent(key) {
    const cutoff = this.now() - this.windowMs;
    const list = (this.fails.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.fails.set(key, list);
    else this.fails.delete(key);
    return list;
  }

  blocked(key) {
    return this._recent(key).length >= this.max;
  }

  fail(key) {
    const list = this._recent(key);
    list.push(this.now());
    this.fails.set(key, list);
    if (this.fails.size > 5000) this.fails.delete(this.fails.keys().next().value); // bounded memory
  }
}

/** Token bucket: `rate` messages per second, bursts up to `burst`. take() → false when empty. */
export class TokenBucket {
  constructor({ rate, burst, now = Date.now }) {
    this.rate = rate;
    this.burst = burst;
    this.now = now;
    this.tokens = burst;
    this.at = now();
  }
  take() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.at) / 1000) * this.rate);
    this.at = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// Pairing codes: letters only, no I/L/O (look like 1/0).
export const PAIR_ALPHABET = ROOM_ALPHABET;

export function makePairCode(taken = new Set(), rand = randInt) {
  for (;;) {
    let s = '';
    for (let i = 0; i < 4; i++) s += PAIR_ALPHABET[rand(PAIR_ALPHABET.length)];
    if (!taken.has(s)) return s;
  }
}

/**
 * Legacy (Node edition) hello check against state. Returns
 * { ok: true, role, playerId? } or { ok: false, code: 'bad_auth' | 'rate_limited' | 'bad_request' }.
 */
export function authenticate(state, hello, ip, limiter) {
  const { role } = hello ?? {};
  if (role === 'gm' || role === 'stage') {
    const expected = role === 'gm' ? state.gmToken : state.stageToken;
    return safeEqual(hello.token, expected) ? { ok: true, role } : { ok: false, code: 'bad_auth' };
  }
  if (role !== 'player') return { ok: false, code: 'bad_request' };
  if (limiter.blocked(ip)) return { ok: false, code: 'rate_limited' };
  const room = typeof hello.room === 'string' ? hello.room.trim().toUpperCase() : '';
  const pin = typeof hello.pin === 'string' || typeof hello.pin === 'number' ? String(hello.pin).trim() : '';
  const player = room === state.room ? state.players.find((p) => safeEqual(p.pin, pin)) : null;
  if (!player) {
    limiter.fail(ip);
    return { ok: false, code: 'bad_auth' };
  }
  return { ok: true, role, playerId: player.id };
}
