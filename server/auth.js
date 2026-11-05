// Tokens, room code, PINs and the player PIN rate limiter.
import crypto from 'node:crypto';

// No I, L, O (look like 1 and 0).
export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';

/** URL-safe random token, 32 chars. */
export function makeToken() {
  return crypto.randomBytes(24).toString('base64url');
}

export function makeRoomCode(randInt = crypto.randomInt) {
  let s = '';
  for (let i = 0; i < 4; i++) s += ROOM_ALPHABET[randInt(ROOM_ALPHABET.length)];
  return s;
}

/** Random 4-digit PIN not in `taken`. */
export function makePin(taken = [], randInt = crypto.randomInt) {
  const used = new Set(taken);
  if (used.size >= 10000) throw new Error('no free PINs');
  for (;;) {
    const pin = String(randInt(10000)).padStart(4, '0');
    if (!used.has(pin)) return pin;
  }
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
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
  }
}

/**
 * Checks a `hello` message against state. Returns
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
