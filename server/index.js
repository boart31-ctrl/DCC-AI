// Entry: loads pack + saved state, serves HTTP static + WebSocket, prints join links.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';

import { loadPack, fallbackPack, voiceFor, quipAudio } from './pack.js';
import { createState, normalizeState, reduce, viewFor, genId, ActionError } from './state.js';
import { VoiceQueue } from './quips.js';
import { authenticate, RateLimiter } from './auth.js';
import { createAI } from './ai.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_MSG = 16 * 1024;
const VIEW_DEBOUNCE_MS = 50;
const SAVE_DEBOUNCE_MS = 500;
const PING_MS = 20_000;
const HELLO_TIMEOUT_MS = 10_000;
const LOG_MAX = 5000;

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

const PAGES = { '/': 'index.html', '/gm': 'gm.html', '/play': 'play.html', '/stage': 'stage.html' };

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

function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFoundRes(res);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

function notFoundRes(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

/**
 * Starts the server. All options are optional; tests pass port 0 and temp dirs.
 * Returns { port, state(), urls, close() }.
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
  let state;
  try {
    state = normalizeState(JSON.parse(fs.readFileSync(stateFile, 'utf8')), pack, now());
    log.log(`[state] restored ${state.players.length} player(s) from ${stateFile}`);
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn(`[state] could not read ${stateFile} (${e.message}), starting fresh`);
    state = createState(pack, now());
  }
  let eventLog = [];

  let saveTimer = null;
  const saveNow = () => {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      writeJsonAtomic(stateFile, state);
    } catch (e) {
      log.error(`[state] save failed: ${e.message}`);
    }
  };
  const scheduleSave = () => {
    if (!saveTimer) saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  };

  const ai = createAI(env, opts.fetch);
  const limiter = new RateLimiter({ max: 5, windowMs: 60_000, now });
  const clients = new Set(); // ws with ws.meta = { role, playerId, alive }

  // ---- outbound ----
  const send = (ws, msg) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  };

  const connectedPlayers = () => {
    const s = new Set();
    for (const c of clients) if (c.meta.role === 'player') s.add(c.meta.playerId);
    return s;
  };

  let urls = { join: '', stage: '', gm: '' };
  const viewOpts = () => ({
    now: now(),
    connected: connectedPlayers(),
    urls,
    queue: voice.snapshot(),
    aiAvailable: ai.aiAvailable,
    aiCallsLeft: ai.callsLeft,
  });
  const viewOf = (meta, o = viewOpts()) => viewFor(state, pack, meta.role, { ...o, playerId: meta.playerId });

  let viewTimer = null;
  const broadcastViews = () => {
    viewTimer = null;
    const o = viewOpts();
    for (const c of clients) send(c, { t: 'view', view: viewOf(c.meta, o) });
  };
  const scheduleViews = () => {
    if (!viewTimer) viewTimer = setTimeout(broadcastViews, VIEW_DEBOUNCE_MS);
  };

  const deliver = (event, to) => {
    for (const c of clients) {
      const { role, playerId } = c.meta;
      const ok =
        to === 'all' ||
        to.roles?.includes(role) ||
        (role === 'player' && to.playerId && to.playerId === playerId);
      if (ok) send(c, { t: 'event', event });
    }
  };

  const toStage = (msg) => {
    for (const c of clients) if (c.meta.role === 'stage') send(c, msg);
  };

  const logEvent = (entry) => {
    eventLog.push(entry);
    if (eventLog.length > LOG_MAX) eventLog = eventLog.slice(-LOG_MAX);
  };

  // ---- voice queue ----
  const voice = new VoiceQueue({
    now,
    genId,
    getSession: () => state.session,
    consumeBudget: () => apply({ role: 'system', t: 'budget.consume' }),
    onPlay: (item) => {
      const quip = item.quipId ? pack.quipsById.get(item.quipId) : null;
      const msg = {
        t: 'play',
        id: item.id,
        priority: item.priority,
        text: item.text,
        audio: quip ? quipAudio(quip, state.session.voice) : null,
        voice: voiceFor(pack, state.session.voice),
      };
      logEvent({ at: now(), kind: 'play', id: item.id, priority: item.priority, text: item.text, quipId: item.quipId });
      toStage(msg);
    },
    onStop: () => toStage({ t: 'stop' }),
    onChange: scheduleViews,
  });

  function archiveSession(session) {
    const file = path.join(dataDir, 'sessions', `${session.id}.json`);
    try {
      writeJsonAtomic(file, { session, endedAt: now(), players: state.players.map(({ pin, ...p }) => p), log: eventLog });
      log.log(`[session] archived ${file}`);
    } catch (e) {
      log.error(`[session] archive failed: ${e.message}`);
    }
    eventLog = [];
    ai.resetSession();
  }

  /** Runs one action through the reducer and performs all side effects. Throws ActionError. */
  function apply(action) {
    const r = reduce(state, action, { now: now(), rng, pack });
    if (!r.changed) return r;
    state = r.state;
    if (action.role !== 'system') {
      const { token, pin, ...safe } = action; // keep secrets out of the log
      logEvent({ at: now(), kind: 'action', action: safe });
    }
    for (const { event, to } of r.events) {
      logEvent({ ...event, log: 'event' });
      deliver(event, to);
    }
    for (const fx of r.effects) {
      if (fx.type === 'archive') archiveSession(fx.session);
      else if (fx.type === 'clearPending') voice.clearPending();
      else if (fx.type === 'queueClear') voice.clear();
    }
    for (const line of r.lines) voice.push(line);
    if (action.t === 'player.remove') {
      for (const c of clients) if (c.meta.role === 'player' && c.meta.playerId === action.playerId) c.close(4004, 'removed');
    }
    scheduleSave();
    scheduleViews();
    return r;
  }

  // ---- incoming messages ----
  async function handleAction(ws, msg) {
    const { role, playerId } = ws.meta;
    const rid = typeof msg.rid === 'string' || typeof msg.rid === 'number' ? msg.rid : undefined;
    try {
      if (msg.t === 'ping') return send(ws, { t: 'pong', rid });
      if (role === 'stage') {
        if (msg.t === 'audio.done') {
          if (typeof msg.id !== 'string') throw new ActionError('bad_request', 'id required');
          voice.done(msg.id);
        } else if (msg.t === 'audio.pause') {
          if (typeof msg.silent !== 'boolean') throw new ActionError('bad_request', 'silent must be a boolean');
          // Phase 1 treats the table as always silent; phase-3 hook: voice.setSilent(msg.silent)
        } else {
          throw new ActionError('bad_request', `unknown action ${msg.t} for role stage`);
        }
      } else if (role === 'gm') {
        if (msg.t === 'auto.veto') {
          if (!voice.veto(msg.id)) throw new ActionError('not_found', `no pending line ${msg.id}`);
        } else if (msg.t === 'queue.clear') {
          voice.clear();
        } else {
          let action = { ...msg, role: 'gm' };
          // Custom achievement without desc: let AI write one if available.
          if (msg.t === 'ach.award' && msg.achId === undefined && typeof msg.title === 'string' && !msg.desc && ai.available()) {
            const p = state.players.find((x) => x.id === msg.playerId);
            const desc = await ai.generateAchievementText({ title: msg.title, playerName: p?.name, klass: p?.klass, race: p?.race });
            if (desc) action = { ...action, desc: desc.slice(0, 300) };
          }
          const r = apply(action);
          if (rid !== undefined) return send(ws, { t: 'ack', rid, ok: true, ...(r.result ? { result: r.result } : {}) });
        }
      } else {
        apply({ ...msg, role: 'player', actorId: playerId });
      }
      if (rid !== undefined) send(ws, { t: 'ack', rid, ok: true });
    } catch (e) {
      const code = e instanceof ActionError ? e.code : 'bad_request';
      if (!(e instanceof ActionError)) log.error('[ws] action failed:', e);
      if (rid !== undefined) send(ws, { t: 'ack', rid, ok: false, error: code, msg: e.message });
      else send(ws, { t: 'error', code, msg: e.message });
    }
  }

  function onMessage(ws, data, isBinary, ip) {
    let msg;
    try {
      if (isBinary) throw new Error('binary');
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return send(ws, { t: 'error', code: 'bad_request', msg: 'invalid JSON' });
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') {
      return send(ws, { t: 'error', code: 'bad_request', msg: 'message must be an object with string t' });
    }
    if (!ws.meta.role) {
      if (msg.t !== 'hello') return send(ws, { t: 'error', code: 'bad_request', msg: 'send hello first' });
      const a = authenticate(state, msg, ip, limiter);
      if (!a.ok) {
        send(ws, { t: 'error', code: a.code, msg: a.code === 'rate_limited' ? 'too many wrong PINs, wait a minute' : 'authentication failed' });
        if (a.code !== 'bad_request') ws.close(4001, a.code);
        return;
      }
      clearTimeout(ws.helloTimer);
      ws.meta.role = a.role;
      ws.meta.playerId = a.playerId;
      clients.add(ws);
      const welcome = { t: 'welcome', role: a.role, view: viewOf(ws.meta) };
      if (a.playerId) welcome.playerId = a.playerId;
      send(ws, welcome);
      if (a.role === 'player') scheduleViews();
      return;
    }
    if (msg.t === 'hello') return send(ws, { t: 'error', code: 'bad_request', msg: 'already authenticated' });
    handleAction(ws, msg);
  }

  // ---- HTTP ----
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
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : svg);
      }
      if (p === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('ok');
      }
      if (p.startsWith('/pack/')) {
        const file = pack.dir && safeJoin(pack.dir, p.slice('/pack/'.length));
        return file ? sendFile(req, res, file) : notFoundRes(res);
      }
      const rel = PAGES[p.replace(/\/+$/, '') || '/'] ?? p.slice(1);
      const file = safeJoin(webDir, rel);
      return file ? sendFile(req, res, file) : notFoundRes(res);
    } catch (e) {
      log.error('[http]', e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  }

  const server = http.createServer(onRequest);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG });

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress ?? '?';
    ws.meta = { role: null, playerId: null, alive: true };
    ws.helloTimer = setTimeout(() => ws.close(4000, 'hello timeout'), HELLO_TIMEOUT_MS);
    ws.on('pong', () => (ws.meta.alive = true));
    ws.on('message', (data, isBinary) => onMessage(ws, data, isBinary, ip));
    ws.on('error', () => {}); // e.g. maxPayload exceeded; ws closes the socket itself
    ws.on('close', () => {
      clearTimeout(ws.helloTimer);
      const wasPlayer = clients.has(ws) && ws.meta.role === 'player';
      clients.delete(ws);
      if (wasPlayer) scheduleViews();
    });
  });

  // ---- timers ----
  const timers = [];
  timers.push(
    setInterval(() => {
      for (const ws of wss.clients) {
        if (!ws.meta.alive) {
          ws.terminate();
          continue;
        }
        ws.meta.alive = false;
        ws.ping();
      }
    }, opts.pingMs ?? PING_MS),
  );
  timers.push(setInterval(() => voice.tick(), 250));
  timers.push(
    setInterval(() => {
      const r = reduce(state, { role: 'system', t: 'audience.tick' }, { now: now(), pack });
      if (r.changed) {
        state = r.state;
        scheduleViews();
        scheduleSave();
      }
    }, 5_000),
  );

  let chatTimer = null;
  const scheduleChat = () => {
    chatTimer = setTimeout(() => {
      const c = pack.chat[Math.floor(rng() * pack.chat.length)];
      if (c) deliver({ id: genId('e'), at: now(), kind: 'chat', user: c.user, text: c.text }, { roles: ['stage'] });
      scheduleChat();
    }, 8_000 + rng() * 12_000);
  };
  if (pack.chat.length && opts.chat !== false) scheduleChat();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, opts.host ?? '0.0.0.0', resolve);
  });
  const actualPort = server.address().port;
  const ip = opts.publicHost ?? lanIp();
  const base = `http://${ip}:${actualPort}`;
  urls = {
    join: `${base}/play?room=${state.room}`,
    stage: `${base}/stage#${state.stageToken}`,
    gm: `${base}/gm#${state.gmToken}`,
  };
  saveNow();

  return {
    port: actualPort,
    urls,
    pack,
    ai,
    get state() {
      return state;
    },
    get log() {
      return eventLog;
    },
    async close() {
      timers.forEach(clearInterval);
      clearTimeout(chatTimer);
      clearTimeout(viewTimer);
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
    '',
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
