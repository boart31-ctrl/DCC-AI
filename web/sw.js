// The System — service worker. Caches the app shell only.
// Never touches /ws, /pack/* (images, audio), /qr or anything else dynamic.

const CACHE = 'system-shell-v3';
const SHELL = [
  '/',
  '/gm',
  '/play',
  '/stage',
  '/css/base.css',
  '/css/gm.css',
  '/css/play.css',
  '/css/stage.css',
  '/css/tool.css',
  '/css/sheet.css',
  '/js/client.js',
  '/js/gm.js',
  '/js/play.js',
  '/js/stage.js',
  '/js/rules.js',
  '/js/ui.js',
  '/js/sheet.js',
  '/js/builder.js',
  '/js/dicelog.js',
  '/js/library.js',
  '/js/combat.js',
  '/js/gm-scenes.js',
  '/js/gm-audio.js',
  '/js/voice.js',
  '/js/stingers.js',
  '/js/show-audio.js',
  '/js/scenes/director.js',
  '/js/scenes/common.js',
  '/js/scenes/lobby.js',
  '/js/scenes/explore.js',
  '/js/scenes/boss.js',
  '/js/scenes/loot.js',
  '/js/scenes/countdown.js',
  '/js/scenes/roll.js',
  '/js/scenes/recap.js',
  '/js/scenes/blank.js',
  '/css/scenes.css',
  '/css/neon.css',
  '/css/gm-scenes.css',
  '/fonts/barlow-condensed-latin-800-italic.woff2',
  '/fonts/barlow-condensed-latin-900-italic.woff2',
  '/fonts/barlow-condensed-latin-800-normal.woff2',
  '/fonts/barlow-semi-condensed-latin-500-normal.woff2',
  '/fonts/barlow-semi-condensed-latin-600-normal.woff2',
  '/fonts/barlow-semi-condensed-latin-700-normal.woff2',
  '/fonts/barlow-latin-400-normal.woff2',
  '/fonts/barlow-latin-500-normal.woff2',
  '/manifest.webmanifest',
  '/icons/icon.svg',
];
const SHELL_SET = new Set(SHELL);

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const path = url.pathname;
  if (path === '/ws' || path.startsWith('/pack/') || path.startsWith('/qr')) return;

  // Pages are matched without their query/hash (/play?room=ABCD -> /play).
  const key = path.endsWith('.html') ? path.replace(/\.html$/, '').replace(/\/index$/, '/') : path;
  if (!SHELL_SET.has(key)) return;

  // Network first (the host is on the LAN and code changes during development),
  // fall back to cache when the host is briefly unreachable.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(key).then((hit) => hit || Response.error())),
  );
});
