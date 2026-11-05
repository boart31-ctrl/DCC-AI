// Cryptographic random helpers via Web Crypto (globalThis.crypto) — works in Node 22 and browsers.
import { ROOM_ALPHABET } from './constants.js';

export { ROOM_ALPHABET };

function webCrypto() {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) throw new Error('globalThis.crypto.getRandomValues is not available');
  return c;
}

/** Uniform integer in [0, n), rejection-sampled (no modulo bias). n ≤ 2^32. */
export function randInt(n) {
  if (!Number.isInteger(n) || n <= 0 || n > 2 ** 32) throw new RangeError('randInt: n must be an integer 1..2^32');
  const limit = 2 ** 32 - (2 ** 32 % n);
  const buf = new Uint32Array(1);
  for (;;) {
    webCrypto().getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

/** URL-safe random token (base64url of `bytes` random bytes; 24 bytes → 32 chars). */
export function makeToken(bytes = 24) {
  const b = new Uint8Array(bytes);
  webCrypto().getRandomValues(b);
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function makeRoomCode(rand = randInt) {
  let s = '';
  for (let i = 0; i < 4; i++) s += ROOM_ALPHABET[rand(ROOM_ALPHABET.length)];
  return s;
}

/** Random 4-digit PIN not in `taken`. */
export function makePin(taken = [], rand = randInt) {
  const used = new Set(taken);
  if (used.size >= 10000) throw new Error('no free PINs');
  for (;;) {
    const pin = String(rand(10000)).padStart(4, '0');
    if (!used.has(pin)) return pin;
  }
}

/** Short random id like "p_k3x9a1b2" (not secret; 8 base36 chars from Web Crypto). */
export function genId(prefix) {
  const b = new Uint8Array(8);
  webCrypto().getRandomValues(b);
  let s = '';
  for (const x of b) s += (x % 36).toString(36);
  return `${prefix}_${s}`;
}
