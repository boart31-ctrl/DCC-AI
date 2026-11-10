// HTTP routing shared by the Node server and the Cloudflare Worker (browser-safe, no Node imports).

/** Page routes → file in web/. `/p/<token>` is a player's personal link (same page as /play). */
export function pageFor(pathname) {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/') return 'index.html';
  if (p === '/gm') return 'gm.html';
  if (p === '/play' || p === '/join') return 'play.html';
  if (p === '/stage' || p === '/tv') return 'stage.html';
  if (/^\/p\/[A-Za-z0-9_-]{16,128}$/.test(p)) return 'play.html';
  return null;
}

/** True for routes whose URL carries a secret (never cache, never send a referrer). */
export const isSecretPath = (pathname) => pathname.startsWith('/p/');

/** Content-Security-Policy for the web pages. `wsOrigin` e.g. "wss://example.workers.dev". */
export function csp(wsOrigin = '') {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${wsOrigin ? ` ${wsOrigin}` : ''}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/** Headers added to every response. */
export function securityHeaders({ wsOrigin = '', strict = true } = {}) {
  const h = {
    'x-robots-tag': 'noindex, nofollow',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
  if (strict) {
    h['content-security-policy'] = csp(wsOrigin);
    h['x-frame-options'] = 'SAMEORIGIN'; // the GM desk may preview the stage in a frame
    h['permissions-policy'] = 'camera=(), microphone=(), geolocation=()';
  }
  return h;
}
