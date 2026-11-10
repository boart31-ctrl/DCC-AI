// Node-edition auth: kept for compatibility. The logic lives in access.js (browser-safe, shared with
// the Cloudflare edition); random generators live in random.js.
export { makeToken, makeRoomCode, makePin, randInt, ROOM_ALPHABET } from './random.js';
export { safeEqual, RateLimiter, authenticate } from './access.js';
