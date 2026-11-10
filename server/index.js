// Node edition: loads pack + saved state, serves HTTP static + WebSocket (ws), prints join links.
// All session logic lives in host.js (shared with the Cloudflare edition); this file is the adapter:
// files on disk, the ws library, the QR route and static files.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';

import { loadPack, fallbackPack } from './pack.js';
import { createState, normalizeState } from './state.js';
import { createHost, LIMITS } from './host.js';
import { createAI } from './ai.js';
import { pageFor, isSecretPath, securityHeaders } from './routes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAVE_DEBOUNCE_MS = 500;
const PING_MS = 20_000;
const KEEP_SNAPSHOTS = 50;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

/** Minimal .env parser: KEY=VALUE lines, # comments, optional quotes. Never overrides real env. */
export function loadEnvFile(file, env = process.env) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (env[m[1]] === undefined) env[m[1]] = v;
  }
}

export function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) return a.address;
    }
  }
  return 'localhost';
}

/** Resolves `rel` under `base`, or null if it escapes. */
export function safeJoin(base, rel) {
  if (rel.includes('\0')) return null;
  const full = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  return full === base || full.startsWith(base + path.sep) ? full : null;
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

/** Restore points as files: data/snapshots/<id>_<reason>.json, newest KEEP_SNAPSHOTS kept. */
export function fileSnapshots(dir, keep = KEEP_SNAPSHOTS) {
  fs.mkdirSync(dir, { recursive: true });
  let last = 0;
  const entries = () =>
    fs.readdirSync(dir)
      .map((f) => /^(\d+)_([a-z.-]+)\.json$/.exec(f))
      .filter(Boolean)
      .map((m) => ({ id: Number(m[1]), reason: m[2], file: path.join(dir, m[0]) }))
      .sort((a, b) => a.id - b.id);
  return {
    create(reason, state, at) {
      const id = Math.max(at, last + 1, (entries().at(-1)?.id ?? 0) + 1);
      last = id;
      writeJsonAtomic(path.join(dir, `${id}_${reason.replace(/[^a-z.-]/g, '')}.json`), { id, at, reason, state });
      const all = entries();
      for (const e of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(e.file, { force: true });
      return id;
    },
    list() {
      return entries().reverse().map(({ id, reason, file }) => ({ id, at: JSON.parse(fs.readFileSync(file, 'utf8')).at ?? id, reason }));
    },
    load(id) {
      const e = entries().find((x) => x.id === Number(id));
      return e ? JSON.parse(fs.readFileSync(e.file, 'utf8')).state : null;
    },
  };
}

/**
 * Starts the server. All options are optional; tests pass port 0 and temp dirs.
 * Returns { port, state, urls, log, host, close() }.
 */
export async function startServer(opts = {}) {
  const env = opts.env ?? process.env;
  const log = opts.log ?? console;
  const now = opts.now ?? Date.now;
  const rng = opts.rng ?? Math.random;
  const dataDir = path.resolve(opts.dataDir ?? path.join(ROOT, 'data'));
  const webDir = path.resolve(opts.webDir ?? path.join(ROOT, 'web'));
  const packDir = path.resolve(ROOT, opts.packDir ?? env.PACK_DIR ?? 'packs/demo');
  const port = opts.port ?? (Number.parseInt(env.PORT, 10) || 7777);
  const stateFile = path.join(dataDir, 'state.json');
  fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });

  // ---- pack ----
  let pack;
  try {
    const r = loadPack(packDir);
    pack = r.pack;
    // Missing art/audio is normal while a pack is being built; summarise instead of flooding the console.
    const missing = r.warnings.filter((w) => w.endsWith('not found, using fallback'));
    for (const w of r.warnings) if (!missing.includes(w)) log.warn(`[pack] ${w}`);
    if (missing.length) log.warn(`[pack] ${missing.length} image/audio files not found yet (placeholders used)`);
  } catch (e) {
    log.warn(`[pack] WARNING: ${e.message}`);
    log.warn('[pack] Starting with an EMPTY built-in pack. Set PACK_DIR to a valid content pack.');
    pack = fallbackPack();
  }

  // ---- state ----
  let initial;
  try {
    initial = normalizeState(JSON.parse(fs.readFileSync(stateFile, 'utf8')), pack, now());
    log.log(`[state] restored ${initial.players.length} player(s) from ${stateFile}`);
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn(`[state] could not read ${stateFile} (${e.message}), starting fresh`);
    initial = createState(pack, now());
  }

  let latest = initial;
  let saveTimer = null;
  const saveNow = () => {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      writeJsonAtomic(stateFile, latest);
    } catch (e) {
      log.error(`[state] save failed: ${e.message}`);
    }
  };
  const scheduleSave = () => {
    if (!saveTimer) saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  };

  const ai = createAI(env, opts.fetch);
  const ip0 = opts.publicHost ?? lanIp();
  let base = '';

  const host = createHost({
    pack,
    state: initial,
    now,
    rng,
    ai,
    log,
    legacy: true,
    edition: 'node',
    chat: opts.chat !== false,
    gmKey: env.GM_KEY?.trim() || '',
    send: (ws, text) => {
      if (ws.readyState === 1) ws.send(text);
    },
    close: (ws, code, reason) => ws.close(code, reason),
    // Actions are written right away (atomic rename); background ticks are batched.
    persist: (state, entry) => {
      latest = state;
      if (entry.system) scheduleSave();
      else saveNow();
    },
    snapshots: fileSnapshots(path.join(dataDir, 'snapshots')),
    onArchive: (session, eventLog, state) => {
      const file = path.join(dataDir, 'sessions', `${session.id}.json`);
      writeJsonAtomic(file, { session, endedAt: now(), players: state.players.map(({ pin, ...p }) => p), messages: state.messages, log: eventLog });
      log.log(`[session] archived ${file}`);
    },
    urls: (b, st) => ({ join: `${b}/play?room=${st.room}`, stage: `${b}/stage#${st.stageToken}`, gm: `${b}/gm#${st.gmToken}` }),
  });

  // ---- HTTP ----
  const baseHeaders = () => securityHeaders({ wsOrigin: base.replace(/^http/, 'ws') });

  function notFoundRes(res) {
    res.writeHead(404, { ...baseHeaders(), 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }

  function sendFile(req, res, file, extra = {}) {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return notFoundRes(res);
      res.writeHead(200, {
        ...baseHeaders(),
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': st.size,
        'cache-control': 'no-cache',
        ...extra,
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  }

  function sendJson(res, status, data, extra = {}) {
    const body = JSON.stringify(data);
    res.writeHead(status, { ...baseHeaders(), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
    res.end(body);
  }

  async function onRequest(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        return res.end();
      }
      const url = new URL(req.url, 'http://x');
      let p;
      try {
        p = decodeURIComponent(url.pathname);
      } catch {
        res.writeHead(400);
        return res.end('bad path');
      }
      if (p === '/qr') {
        const text = url.searchParams.get('text') ?? '';
        if (!text || text.length > 1000) {
          res.writeHead(400);
          return res.end('text required (max 1000 chars)');
        }
        const svg = await QRCode.toString(text, { type: 'svg', margin: 1 });
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
        return res.end(req.method === 'HEAD' ? undefined : svg);
      }
      if (p === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('ok');
      }
      if (p === '/api/info') return sendJson(res, 200, { edition: 'node', legacy: true, keyLogin: !!env.GM_KEY?.trim() });
      if (p === '/api/export') {
        const ip = req.socket.remoteAddress ?? '?';
        const r = host.checkGm({ key: req.headers['x-gm-key'], token: req.headers['x-gm-token'] }, ip);
        if (r !== 'ok') return sendJson(res, r === 'rate_limited' ? 429 : 401, { error: r });
        const kind = url.searchParams.get('kind') === 'campaign' ? 'campaign' : 'session';
        const st = host.state;
        const data = { format: 'the-system-export/1', kind, edition: 'node', exportedAt: now(), pack: { id: pack.id, version: pack.version }, state: st, log: host.log };
        return sendJson(res, 200, data, { 'content-disposition': `attachment; filename="system-${kind}-${new Date(now()).toISOString().slice(0, 10)}.json"` });
      }
      if (p.startsWith('/api/')) return notFoundRes(res);
      if (p.startsWith('/pack/')) {
        const file = pack.dir && safeJoin(pack.dir, p.slice('/pack/'.length));
        return file ? sendFile(req, res, file) : notFoundRes(res);
      }
      const page = pageFor(p);
      const file = safeJoin(webDir, page ?? p.slice(1));
      if (!file) return notFoundRes(res);
      return sendFile(req, res, file, isSecretPath(p) ? { 'cache-control': 'no-store' } : {});
    } catch (e) {
      log.error('[http]', e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  }

  const server = http.createServer(onRequest);
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessage });

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
    // Browsers always send Origin on WebSocket upgrades; a foreign one means another site is trying.
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try {
        ok = new URL(origin).host === req.headers.host;
      } catch {}
      if (!ok) return socket.destroy();
    }
    if (!host.canAccept()) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    ws.alive = true;
    if (!host.connect(ws, { ip: req.socket.remoteAddress ?? '?' })) return;
    ws.on('pong', () => (ws.alive = true));
    ws.on('message', (data, isBinary) => host.message(ws, isBinary ? null : data.toString('utf8')));
    ws.on('error', () => {}); // e.g. maxPayload exceeded; ws closes the socket itself
    ws.on('close', () => host.disconnect(ws));
  });

  // Transport keepalive: ws ping frames; dead sockets are terminated.
  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, opts.pingMs ?? PING_MS);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, opts.host ?? '0.0.0.0', resolve);
  });
  const actualPort = server.address().port;
  base = `http://${ip0}:${actualPort}`;
  host.setBase(base);
  latest = host.state;
  saveNow();
  const urls = host.urls;

  return {
    port: actualPort,
    urls,
    pack,
    ai,
    host,
    get state() {
      return host.state;
    },
    get log() {
      return host.log;
    },
    async close() {
      clearInterval(pingTimer);
      host.close();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      saveNow();
      await new Promise((r) => server.close(r));
    },
  };
}

async function main() {
  loadEnvFile(path.join(ROOT, '.env'));
  let srv;
  try {
    srv = await startServer();
  } catch (e) {
    console.error(`Failed to start: ${e.message}`);
    process.exit(1);
  }
  const { urls, state, pack, ai } = srv;
  const lines = [
    `The System is live  (pack: ${pack.name} ${pack.version})`,
    '',
    `Room code:   ${state.room}`,
    `Players:     ${urls.join}`,
    `GM link:     ${urls.gm}`,
    `Stage link:  ${urls.stage}`,
    `TV pairing:  ${srv.host.base}/tv`,
    '',
    `GM key:      ${process.env.GM_KEY?.trim() ? 'set (log in at /gm with it)' : 'not set (use the GM link above)'}`,
    `AI: ${ai.aiAvailable ? 'enabled' : 'off (no ANTHROPIC_API_KEY) - fully playable without it'}`,
  ];
  console.log('\n' + lines.join('\n') + '\n');
  try {
    fs.writeFileSync(path.join(ROOT, 'data', 'links.txt'), lines.join('\n') + '\n', { mode: 0o600 });
  } catch (e) {
    console.warn(`could not write data/links.txt: ${e.message}`);
  }
  const shutdown = async () => {
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
