// Cloudflare edition: Worker entry + one SQLite-backed Durable Object (`Campaign`) per campaign.
// Speaks the same WebSocket protocol as the Node server (docs/PROTOCOL.md); all session logic is
// server/host.js. Built into a deployable folder by tools/build_cloud.mjs (which writes ./pack.json).
//
// Storage (Durable Object SQLite, synchronous, same turn as the action → durable before the ack leaves):
//   state(part, json, at)                  the whole game state as JSON (one row; split into parts only if huge)
//   log(seq, at, by, action)               every accepted mutating action (secrets stripped)
//   snapshots(id, part, at, reason, json)  restore points (session.new, after >30 min idle, every 10 min, manual,
//                                          before a restore); newest 50 kept
import { DurableObject } from 'cloudflare:workers';
import { createHost } from '../server/host.js';
import { createState, normalizeState } from '../server/state.js';
import { deserializePack } from '../server/pack-core.js';
import { createAI } from '../server/ai.js';
import { sqlTtsStore, HASH_RE } from '../server/tts.js';
import { pageFor, isSecretPath, securityHeaders } from '../server/routes.js';
import { qrSvg } from '../web/js/qr.js';
import packData from './pack.json';

const KEEP_SNAPSHOTS = 50;
const CHUNK = 400_000; // chars per row part (≤ ~1.2 MB UTF-8, under the 2 MB row limit)

let PACK = null;
const getPack = () => (PACK ??= deserializePack(packData));

const ipOf = (request) => request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0].trim() || '?';

function withHeaders(res, url, extra = {}) {
  const out = new Response(res.body, res);
  const ws = url.origin.replace(/^http/, 'ws');
  for (const [k, v] of Object.entries({ ...securityHeaders({ wsOrigin: ws }), ...extra })) out.headers.set(k, v);
  return out;
}
const text = (status, body, url, extra) => withHeaders(new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } }), url, extra);
const json = (status, data, url, extra) => withHeaders(new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }), url, extra);

function campaignStub(env) {
  const name = (env.CAMPAIGN || 'main').toString().slice(0, 64);
  return env.CAMPAIGNS.get(env.CAMPAIGNS.idFromName(name));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === '/ws') {
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return text(426, 'expected a WebSocket upgrade', url);
      if (request.method !== 'GET') return text(405, 'method not allowed', url);
      // Same origin only: a browser on another site cannot open a socket to this game.
      if (request.headers.get('Origin') !== url.origin) return text(403, 'forbidden origin', url);
      return campaignStub(env).fetch(request);
    }

    if (p.startsWith('/api/')) {
      if (request.method !== 'GET') return json(405, { error: 'method not allowed' }, url);
      if (p === '/api/info') return json(200, { edition: 'cloud', legacy: false, keyLogin: true }, url);
      if (p === '/api/health') return json(200, { ok: true }, url);
      if (p.startsWith('/api/tts/')) return withHeaders(await campaignStub(env).fetch(request), url, { 'cache-control': 'no-store' });
      if (p === '/api/export') return withHeaders(await campaignStub(env).fetch(request), url, { 'cache-control': 'no-store' });
      return json(404, { error: 'not found' }, url);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'method not allowed', url);

    if (p === '/qr') {
      const t = url.searchParams.get('text') ?? '';
      if (!t || t.length > 1000) return text(400, 'text required (max 1000 chars)', url);
      return withHeaders(new Response(qrSvg(t, { margin: 1 }), { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' } }), url);
    }

    // Raw pack data is compiled into the worker, never served as a file.
    if (p.startsWith('/pack/') && /\.json$/i.test(p)) return text(404, 'not found', url);

    const page = pageFor(p);
    const assetUrl = new URL(page ? `/${page}` : p, url);
    const res = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: request.headers }));
    if (res.status === 404) return text(404, 'not found', url);
    const extra = {};
    if (page) extra['cache-control'] = isSecretPath(p) ? 'no-store' : 'no-cache';
    return withHeaders(res, url, extra);
  },
};

export class Campaign extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sql = ctx.storage.sql;
    this.migrate();
    const pack = getPack();
    const raw = this.readParts('SELECT json FROM state ORDER BY part');
    const state = raw ? normalizeState(raw, pack, Date.now()) : createState(pack, Date.now());
    let wrote = false;
    this.host = createHost({
      pack,
      state,
      legacy: false,
      edition: 'cloud',
      gmKey: env.GM_KEY || '',
      // System voice: ELEVENLABS_API_KEY is a Worker secret; audio cached in this object's SQLite
      // (tts_meta + tts_chunk, 1 MB chunks, LRU, TTS_CACHE_MB, default 50).
      tts: {
        apiKey: env.ELEVENLABS_API_KEY || '',
        voiceId: env.ELEVENLABS_VOICE_ID || null,
        modelId: env.ELEVENLABS_MODEL_ID || null,
        baseUrl: env.ELEVENLABS_BASE_URL || undefined,
        fetch: (...a) => fetch(...a),
        store: sqlTtsStore(this.sql, (fn) => ctx.storage.transactionSync(fn)),
        capBytes: (Number(env.TTS_CACHE_MB) || 50) * 1024 * 1024,
      },
      ai: createAI({ ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, AI_MODEL: env.AI_MODEL, AI_MAX_CALLS: env.AI_MAX_CALLS }, (...a) => fetch(...a)),
      log: console,
      send: (ws, msg) => ws.send(msg),
      close: (ws, code, reason) => {
        try {
          ws.close(code, reason);
        } catch {}
      },
      onMeta: (ws, meta) => ws.serializeAttachment(meta),
      persist: (st, entry) => {
        wrote = true;
        this.persist(st, entry);
      },
      snapshots: {
        create: (reason, st, at) => this.snapshotCreate(reason, st, at),
        list: () => this.snapshotList(),
        load: (id) => this.readParts('SELECT json FROM snapshots WHERE id = ? ORDER BY part', Number(id)),
      },
    });
    if (!raw && !wrote) this.persist(this.host.state, { at: Date.now(), by: 'system', action: null, system: true });
    for (const ws of ctx.getWebSockets()) this.host.restore(ws, ws.deserializeAttachment());
    // Keepalive pings are answered without waking the object from hibernation.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  migrate() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS state (part INTEGER PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, by TEXT NOT NULL, action TEXT NOT NULL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS log_at ON log (at)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS snapshots (id INTEGER NOT NULL, part INTEGER NOT NULL, at INTEGER NOT NULL, reason TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (id, part))`);
  }

  readParts(query, ...args) {
    const rows = this.sql.exec(query, ...args).toArray();
    if (!rows.length) return null;
    return JSON.parse(rows.map((r) => r.json).join(''));
  }

  /** State row + log row in one transaction, synchronously (the ack waits on the output gate). */
  persist(st, entry) {
    const body = JSON.stringify(st);
    const parts = [];
    for (let i = 0; i < body.length || i === 0; i += CHUNK) parts.push(body.slice(i, i + CHUNK));
    this.ctx.storage.transactionSync(() => {
      parts.forEach((part, i) => this.sql.exec('INSERT OR REPLACE INTO state (part, json, at) VALUES (?, ?, ?)', i, part, entry.at));
      this.sql.exec('DELETE FROM state WHERE part >= ?', parts.length);
      if (entry.action) this.sql.exec('INSERT INTO log (at, by, action) VALUES (?, ?, ?)', entry.at, String(entry.by ?? '?'), JSON.stringify(entry.action));
    });
  }

  snapshotCreate(reason, st, at) {
    const body = JSON.stringify(st);
    let id;
    this.ctx.storage.transactionSync(() => {
      id = (this.sql.exec('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM snapshots').one().id);
      for (let i = 0, n = 0; i < body.length || i === 0; i += CHUNK, n++) {
        this.sql.exec('INSERT INTO snapshots (id, part, at, reason, json) VALUES (?, ?, ?, ?, ?)', id, n, at, reason, body.slice(i, i + CHUNK));
      }
      this.sql.exec(`DELETE FROM snapshots WHERE id NOT IN (SELECT DISTINCT id FROM snapshots ORDER BY id DESC LIMIT ${KEEP_SNAPSHOTS})`);
    });
    return id;
  }

  snapshotList() {
    return this.sql
      .exec('SELECT id, MIN(at) AS at, MIN(reason) AS reason, SUM(length(json)) AS size FROM snapshots GROUP BY id ORDER BY id DESC')
      .toArray()
      .map((r) => ({ id: r.id, at: r.at, reason: r.reason, size: r.size }));
  }

  async fetch(request) {
    const url = new URL(request.url);
    this.host.setBase(url.origin);
    if (url.pathname === '/ws') {
      if (!this.host.canAccept()) return new Response('too many connections', { status: 503 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.host.connect(server, { ip: ipOf(request), base: url.origin });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/api/export') return this.exportResponse(request, url);
    if (url.pathname.startsWith('/api/tts/')) return this.ttsResponse(request, url);
    return new Response('not found', { status: 404 });
  }

  /** GET /api/tts/<hash>.mp3 — cached System voice audio, GM only (X-GM-Key). */
  ttsResponse(request, url) {
    const r = this.host.checkGm({ key: request.headers.get('X-GM-Key') ?? '' }, ipOf(request));
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    if (r !== 'ok') return new Response(JSON.stringify({ error: r }), { status: r === 'rate_limited' ? 429 : 401, headers });
    const m = /^\/api\/tts\/([0-9a-f]{64})\.mp3$/.exec(url.pathname);
    const bytes = m && HASH_RE.test(m[1]) ? this.host.tts.audio(m[1]) : null;
    if (!bytes) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers });
    return new Response(bytes, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' } });
  }

  exportResponse(request, url) {
    const r = this.host.checkGm({ key: request.headers.get('X-GM-Key') ?? '' }, ipOf(request));
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    if (r !== 'ok') return new Response(JSON.stringify({ error: r }), { status: r === 'rate_limited' ? 429 : 401, headers });
    const kind = url.searchParams.get('kind') === 'campaign' ? 'campaign' : 'session';
    const st = this.host.state;
    const since = kind === 'session' ? st.session.startedAt : 0;
    const log = this.sql
      .exec('SELECT seq, at, by, action FROM log WHERE at >= ? ORDER BY seq', since)
      .toArray()
      .map((row) => ({ seq: row.seq, at: row.at, by: row.by, action: JSON.parse(row.action) }));
    const pack = this.host.pack;
    const at = Date.now();
    const data = {
      format: 'the-system-export/1', kind, edition: 'cloud', exportedAt: at,
      pack: { id: pack.id, name: pack.name, version: pack.version },
      session: st.session, state: st, log, snapshots: this.snapshotList(),
    };
    headers['content-disposition'] = `attachment; filename="system-${kind}-${new Date(at).toISOString().slice(0, 10)}.json"`;
    return new Response(JSON.stringify(data), { headers });
  }

  webSocketMessage(ws, message) {
    if (!this.host.has(ws)) this.host.restore(ws, ws.deserializeAttachment());
    this.host.message(ws, typeof message === 'string' ? message : null);
  }

  webSocketClose(ws) {
    this.host.disconnect(ws);
    try {
      ws.close(1000, 'bye');
    } catch {}
  }

  webSocketError(ws) {
    this.host.disconnect(ws);
  }
}
