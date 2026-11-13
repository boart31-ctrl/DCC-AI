// GM engine host for the hosted edition. Runs in the owner's GM window: the browser is the game server.
//
//   GM action -> reduce() -> state
//     -> engine/state            (owner only: the authoritative save)
//     -> public/view             (everyone: lobby / waiting screen)
//     -> pv/<userId>             (each assigned player: their private view + recent events)
//     -> stage/feed              (owner's TV window: stage view + current line + recent events)
// Stage -> GM: audio acks arrive two ways (room topic `stage.ack` = fast, `stage/acks` doc = durable);
// VoiceQueue.done() ignores duplicates and unknown ids, and its own 15 s timeout unsticks a lost ack.
// Player -> GM: read receipts come from player presence (`readIds`), trusted only when the peer's
// platform-stamped `by` matches the player's assigned userId.
import {
  createState, normalizeState, reduce, reducePlayerAction, viewFor, viewForUser, VoiceQueue, voiceFor, genId, ActionError,
} from '../../engine/engine.js';
import { BaseTransport, DocWriter, ring, bytes, sleep, tabId, sentenceChunks } from './util.js';

const LOG_MAX = 600;
const PLAYER_EVENTS = 20;
const STAGE_EVENTS = 30;
const LEASE_MS = 30_000;
const ACT_MAX_AGE_MS = 60_000; // relayed player actions older than this are ignored (stale presence)
const ACT_RATE = 10; // per sender per second

export class EngineHost extends BaseTransport {
  /**
   * @param {object} o
   * @param {object} o.pack     normalized pack (deserializePack output)
   * @param {object} o.db       claude db namespace
   * @param {object|null} o.room claude room namespace
   * @param {object} o.user     claude user namespace
   */
  constructor({ pack, db, room, user }) {
    super();
    this.pack = pack;
    this.db = db;
    this.room = room;
    this.user = user;
    this.state = null;
    this.log = [];
    this.connected = new Set();
    this.peers = [];
    this.pvWriters = new Map(); // userId -> DocWriter
    this.pvEvents = new Map(); // userId -> [event]
    this.stageEvents = [];
    this.stagePlay = null;
    this.stopEpoch = 0;
    this.lastAckIds = new Set();
    this.narration = null;
    this.timers = [];
    this.holder = tabId();
    this.leaseOk = false;
    this.writeError = null;
    this.listeners = new Set();
    this.actSeen = new Map(); // userId -> last relayed action number applied
    this.actTimes = new Map(); // userId -> recent action timestamps (rate limit)
    this.pvAcks = new Map(); // userId -> recent acks, mirrored into pv/<userId>

    const after = (fn) => (...a) => { try { fn(...a); } catch (e) { console.error(e); } };
    this.voice = new VoiceQueue({
      now: Date.now,
      genId,
      getSession: () => this.state.session,
      consumeBudget: after(() => this.apply({ role: 'system', t: 'budget.consume' })),
      onPlay: after((item) => this.onPlay(item)),
      onStop: after(() => this.onStop()),
      onChange: after(() => this.changed({ views: true })),
    });

    const err = (e) => {
      this.writeError = e;
      this.emit('error', { code: e?.code || 'unavailable', msg: e?.message || 'write failed' });
    };
    this.wState = new DocWriter(db.doc('engine/state'), () => this.persistBody(), { delay: 800, onError: err });
    this.wPublic = new DocWriter(db.doc('public/view'), () => this.publicBody(), { delay: 300, onError: err });
    this.wStage = new DocWriter(db.doc('stage/feed'), () => this.stageBody(), { delay: 120, onError: err });
  }

  /* ---------- lifecycle ---------- */

  async start() {
    this.setStatus('connecting');
    const lease = await this.takeLease(false);
    if (!lease) {
      this.setStatus('rejected', { code: 'busy', msg: 'The GM desk is open in another window.' });
      return false;
    }
    const snap = await this.db.doc('engine/state').get().catch(() => null);
    const saved = snap?.exists ? snap.data() : null;
    if (saved?.state) {
      try {
        this.state = normalizeState(structuredClone(saved.state), this.pack, Date.now());
        this.log = Array.isArray(saved.log) ? saved.log.slice(-LOG_MAX) : [];
        for (const [k, v] of Object.entries(saved.actSeen || {})) if (Number.isFinite(v)) this.actSeen.set(k, v);
      } catch (e) {
        console.error('[host] saved state unreadable, starting fresh', e);
      }
    }
    if (!this.state) this.state = createState(this.pack, Date.now());

    // Durable stage acks.
    const unAck = this.db.doc('stage/acks').onSnapshot((s) => {
      const ids = s.exists ? s.data()?.ids : null;
      if (Array.isArray(ids)) for (const id of ids) this.ack(id);
    }, () => {});
    this.listeners.add(unAck);

    if (this.room) {
      this.listeners.add(this.room.on('stage.ack', (m) => { if (m.isMe) this.ack(m.data?.id); }, () => {}));
      this.listeners.add(this.room.onPeers((c) => this.onPeers(c.peers), () => {}));
      this.room.presence({ role: 'gm' }).catch(() => {});
    }

    this.timers.push(setInterval(() => this.voice.tick(), 250));
    this.timers.push(setInterval(() => {
      const r = reduce(this.state, { role: 'system', t: 'audience.tick' }, { now: Date.now(), pack: this.pack });
      if (r.changed) { this.state = r.state; this.changed({ views: true, save: true }); }
      // Crawlers remaining (crawlers.js): organic attrition is baked in about once a minute.
      const c = reduce(this.state, { role: 'system', t: 'crawlers.tick' }, { now: Date.now(), pack: this.pack });
      if (c.changed) { this.state = c.state; this.changed({ views: true, save: true }); }
    }, 5000));
    this.timers.push(setInterval(() => this.takeLease(true), LEASE_MS / 3));
    this.scheduleChat();

    this.setStatus('open');
    this.emit('welcome', { role: 'gm', view: this.gmView() });
    this.emit('view', this.gmView());
    this.changed({ views: true, save: false, all: true });
    return true;
  }

  async takeLease(renew) {
    try {
      const r = await this.db.doc('engine/lock').acquire({ holder: this.holder, ttlMs: LEASE_MS });
      if (!r.acquired && renew && this.leaseOk) {
        // Someone else took the desk: stop writing.
        this.leaseOk = false;
        this.stop();
        this.setStatus('rejected', { code: 'busy', msg: 'The GM desk was opened in another window.' });
      }
      this.leaseOk = !!r.acquired;
      return this.leaseOk;
    } catch {
      // A store without leases (or a hiccup) must not lock the GM out of their own game.
      this.leaseOk = true;
      return true;
    }
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    clearTimeout(this.chatTimer);
    for (const un of this.listeners) { try { un(); } catch {} }
    this.listeners.clear();
  }

  /** Release the lease immediately and take over from another window. */
  async forceTakeover() {
    await this.db.doc('engine/lock').set({ holder: this.holder, forced: Date.now() }).catch(() => {});
    return this.start();
  }

  /* ---------- transport surface for the GM desk ---------- */

  async send(action) {
    if (!this.state || this.status !== 'open') throw new Error('The desk is not running');
    const { rid, ...a } = action;
    try {
      if (a.t === 'auto.veto') {
        if (!this.voice.veto(a.id)) throw new ActionError('not_found', `no pending line ${a.id}`);
        return { t: 'ack', ok: true };
      }
      if (a.t === 'queue.clear') {
        this.narration = null;
        this.voice.clear();
        return { t: 'ack', ok: true };
      }
      const r = this.apply({ ...a, role: 'gm' });
      return { t: 'ack', ok: true, ...(r.result ? { result: r.result } : {}) };
    } catch (e) {
      const err = new Error(e?.message || 'Refused');
      err.code = e?.code || 'bad_request';
      throw err;
    }
  }

  raw() { return true; }

  /* ---------- engine ---------- */

  apply(action, reducer = reduce, ctxExtra = {}) {
    const now = Date.now();
    const r = reducer(this.state, action, { now, pack: this.pack, ...ctxExtra });
    if (!r.changed) return r;
    this.state = r.state;
    if (action.role !== 'system') {
      const { pin, ...safe } = action;
      this.logPush({ at: now, kind: 'action', action: safe });
    }
    for (const { event, to } of r.events) {
      this.logPush({ ...event, log: 'event' });
      this.route(event, to);
    }
    for (const fx of r.effects) {
      if (fx.type === 'archive') this.archive(fx.session);
      else if (fx.type === 'clearPending') this.voice.clearPending();
      else if (fx.type === 'queueClear') { this.narration = null; this.voice.clear(); }
    }
    for (const line of r.lines) this.voice.push(line);
    this.changed({ views: true, save: true, all: action.t?.startsWith('player.') });
    return r;
  }

  logPush(entry) {
    ring(this.log, entry, LOG_MAX);
  }

  route(event, to) {
    const all = to === 'all';
    if (all || to.roles?.includes('gm')) this.emit('event', event);
    if (all || to.roles?.includes('stage')) ring(this.stageEvents, event, STAGE_EVENTS);
    for (const p of this.state.players) {
      if (!p.userId) continue;
      const ok = all || to.roles?.includes('player') || to.playerId === p.id || to.playerIds?.includes(p.id);
      if (!ok) continue;
      const list = this.pvEvents.get(p.userId) || [];
      ring(list, event, PLAYER_EVENTS);
      this.pvEvents.set(p.userId, list);
    }
    if (this.room && (all || to.roles?.includes('stage'))) {
      // Fast path; the stage dedupes by id against stage/feed.
      this.room.emit('stage.event', slimEvent(event)).catch(() => {});
    }
  }

  async archive(session) {
    const players = this.state.players.map(({ pin, ...p }) => p);
    const body = { session, endedAt: Date.now(), players, messages: this.state.messages.slice(-80), log: this.log.slice(-LOG_MAX) };
    let trimmed = body;
    // Keep the archive under the 256 KiB document limit.
    while (bytes(trimmed) > 240_000 && trimmed.log.length > 20) trimmed = { ...trimmed, log: trimmed.log.slice(Math.floor(trimmed.log.length / 3)) };
    this.lastArchive = { id: session.id, log: this.log.slice() };
    this.log = [];
    try { await this.db.doc(`sessions/${session.id}`).set(trimmed); } catch (e) { this.emit('error', { code: e?.code, msg: `Archive failed: ${e?.message}` }); }
  }

  /** Reads the current log (for summaries before archiving). */
  currentLog() { return this.log.slice(); }

  /* ---------- voice ---------- */

  onPlay(item) {
    this.stagePlay = {
      t: 'play', id: item.id, priority: item.priority, text: item.text,
      audio: null, // hosted edition: browser speech only (pack audio files are not shipped)
      voice: voiceFor(this.pack, this.state.session.voice),
      at: Date.now(),
    };
    this.logPush({ at: Date.now(), kind: 'play', id: item.id, priority: item.priority, text: item.text, quipId: item.quipId });
    if (this.room) this.room.emit('stage.play', this.stagePlay).catch(() => {});
    this.wStage.schedule();
  }

  onStop() {
    this.stagePlay = null;
    this.stopEpoch += 1;
    if (this.room) this.room.emit('stage.stop', { epoch: this.stopEpoch }).catch(() => {});
    this.wStage.schedule();
  }

  ack(id) {
    if (typeof id !== 'string' || this.lastAckIds.has(id)) return;
    this.lastAckIds.add(id);
    if (this.lastAckIds.size > 50) this.lastAckIds = new Set([...this.lastAckIds].slice(-25));
    const was = this.stagePlay?.id === id;
    if (this.voice.done(id) || was) {
      if (was) this.stagePlay = null;
      this.wStage.schedule();
      this.continueNarration(id);
    }
  }

  /** Reads long text aloud on the TV as a chain of P0 lines (a recap is too long for one line). */
  narrate(text) {
    const chunks = sentenceChunks(text, 170);
    if (!chunks.length) return;
    this.narration = { chunks, current: null };
    this.continueNarration(null);
  }

  continueNarration(doneId) {
    const n = this.narration;
    if (!n) return;
    if (n.current && doneId !== n.current) return;
    const next = n.chunks.shift();
    if (!next) { this.narration = null; return; }
    const item = this.voice.push({ priority: 0, text: next, quipId: null, crit: false });
    n.current = item?.id || null;
    if (!item) this.narration = null;
  }

  /* ---------- chat ticker ---------- */

  scheduleChat() {
    if (!this.pack.chat?.length) return;
    this.chatTimer = setTimeout(() => {
      const c = this.pack.chat[Math.floor(Math.random() * this.pack.chat.length)];
      if (c) this.route({ id: genId('e'), at: Date.now(), kind: 'chat', user: c.user, text: c.text }, { roles: ['stage'] });
      this.wStage.schedule();
      this.scheduleChat();
    }, 8000 + Math.random() * 12000);
  }

  /* ---------- presence ---------- */

  onPeers(peers) {
    this.peers = peers;
    const byUser = new Map();
    for (const p of peers) if (p.kind === 'viewer' && p.by) byUser.set(p.by, p);
    const connected = new Set();
    let reads = false;
    for (const pl of this.state.players) {
      const peer = pl.userId ? byUser.get(pl.userId) : null;
      if (!peer) continue;
      connected.add(pl.id);
      const ids = Array.isArray(peer.presence?.readIds) ? peer.presence.readIds.slice(0, 40) : [];
      for (const id of ids) {
        if (typeof id !== 'string') continue;
        const m = this.state.messages.find((x) => x.id === id);
        if (!m || m.readBy?.includes(pl.id)) continue;
        try {
          const r = reduce(this.state, { role: 'player', t: 'secret.read', id, actorId: pl.id }, { now: Date.now(), pack: this.pack });
          if (r.changed) { this.state = r.state; reads = true; }
        } catch { /* not addressed to them: ignore */ }
      }
    }
    for (const pl of this.state.players) {
      const peerList = pl.userId ? peers.filter((p) => p.kind === 'viewer' && p.by === pl.userId) : [];
      for (const peer of peerList) this.relayActions(pl, peer);
    }
    const same = connected.size === this.connected.size && [...connected].every((x) => this.connected.has(x));
    this.connected = connected;
    this.emit('peers', peers);
    if (!same || reads) this.changed({ views: true, save: reads });
  }

  /**
   * Player phone -> GM: the phone lists pending actions in its presence (`acts: [{n, a}]`), which any
   * viewer may set. Trust comes only from the platform-stamped `by` matching the assigned userId;
   * any playerId inside the payload is ignored by reducePlayerAction. Rate-limited per sender.
   */
  relayActions(pl, peer) {
    const acts = Array.isArray(peer.presence?.acts) ? peer.presence.acts : [];
    if (!acts.length) return;
    const uid = pl.userId;
    let last = this.actSeen.get(uid) ?? 0;
    const now = Date.now();
    for (const item of [...acts].sort((x, y) => (x?.n ?? 0) - (y?.n ?? 0))) {
      const n = Number(item?.n);
      if (!Number.isFinite(n) || n <= last) continue;
      last = n;
      this.actSeen.set(uid, n);
      if (now - Math.floor(n / 1000) > ACT_MAX_AGE_MS) continue;
      const a = item.a;
      if (!a || typeof a !== 'object' || typeof a.t !== 'string') { this.ackPlayer(uid, n, false, 'bad_request', 'Malformed action'); continue; }
      const times = (this.actTimes.get(uid) || []).filter((t) => now - t < 1000);
      if (times.length >= ACT_RATE) { this.actTimes.set(uid, times); this.ackPlayer(uid, n, false, 'rate_limited', 'Too many actions at once. Try again.'); continue; }
      times.push(now);
      this.actTimes.set(uid, times);
      if (a.t === 'ping') { this.ackPlayer(uid, n, true); continue; }
      try {
        const { rid, role, actorId, playerId, ...clean } = a;
        const r = this.apply({ ...clean, role: 'player', actorId: pl.id }, (st, act, ctx) => reducePlayerAction(st, act, { ...ctx, playerId: pl.id }));
        this.ackPlayer(uid, n, true, null, null, r.result);
      } catch (e) {
        this.ackPlayer(uid, n, false, e?.code || 'bad_request', e?.message || 'Refused');
      }
    }
  }

  ackPlayer(uid, n, ok, error = null, msg = null, result = null) {
    const ack = { to: uid, n, ok, ...(error ? { error, msg } : {}), ...(result ? { result } : {}) };
    if (this.room) this.room.emit('player.ack', ack).catch(() => {});
    const list = this.pvAcks.get(uid) || [];
    ring(list, ack, 12);
    this.pvAcks.set(uid, list);
    this.pvWriters.get(uid)?.schedule();
  }

  /* ---------- projections ---------- */

  viewOpts() {
    return { now: Date.now(), connected: this.connected, urls: { join: '', stage: '', gm: '' }, queue: this.voice.snapshot(), aiAvailable: false, aiCallsLeft: 0 };
  }

  gmView() { return viewFor(this.state, this.pack, 'gm', this.viewOpts()); }

  persistBody() {
    if (!this.state || !this.leaseOk) return null;
    let body = { v: 1, savedAt: Date.now(), state: this.state, log: this.log, actSeen: Object.fromEntries(this.actSeen) };
    while (bytes(body) > 240_000 && body.log.length > 10) body = { ...body, log: body.log.slice(Math.floor(body.log.length / 2)) };
    return body;
  }

  publicBody() {
    if (!this.state || !this.leaseOk) return null;
    const v = viewFor(this.state, this.pack, 'stage', this.viewOpts());
    delete v.joinUrl;
    delete v.queueLength;
    v.room = '';
    v.assigned = this.state.players.filter((p) => p.userId).map((p) => p.userId);
    return { v: 1, view: v };
  }

  stageBody() {
    if (!this.state || !this.leaseOk) return null;
    const v = viewFor(this.state, this.pack, 'stage', this.viewOpts());
    return { v: 1, view: v, play: this.stagePlay, stopEpoch: this.stopEpoch, events: this.stageEvents.map(slimEvent) };
  }

  pvBody(userId) {
    const v = viewForUser(this.state, this.pack, userId, this.viewOpts());
    if (!v) return { v: 1, view: null, events: [] };
    v.room = '';
    let body = { v: 1, view: v, events: (this.pvEvents.get(userId) || []).map(slimEvent), acks: this.pvAcks.get(userId) || [] };
    if (bytes(body) > 240_000) body = { ...body, view: { ...v, feed: v.feed.slice(-5), me: { ...v.me, messages: v.me.messages.slice(-40), secrets: v.me.secrets.slice(-20) } } };
    return body;
  }

  /** Everything that depends on state changed: re-render the desk and schedule writes. */
  changed({ views = true, save = false } = {}) {
    if (!this.state) return;
    if (views) {
      clearTimeout(this.viewTimer);
      this.viewTimer = setTimeout(() => this.emit('view', this.gmView()), 40);
      this.wPublic.schedule();
      this.wStage.schedule();
      const assigned = new Set();
      for (const p of this.state.players) {
        if (!p.userId) continue;
        assigned.add(p.userId);
        let w = this.pvWriters.get(p.userId);
        if (!w) {
          const uid = p.userId;
          w = new DocWriter(this.db.doc(`pv/${uid}`), () => (this.leaseOk ? this.pvBody(uid) : null), { delay: 250, onError: (e) => this.emit('error', { code: e?.code, msg: e?.message }) });
          this.pvWriters.set(uid, w);
        }
        w.schedule();
      }
      // Unassigned people: blank their private doc once so a stale sheet never lingers.
      for (const [uid, w] of this.pvWriters) {
        if (assigned.has(uid)) continue;
        this.pvWriters.delete(uid);
        this.pvEvents.delete(uid);
        w.get = () => ({ v: 1, view: null, events: [] });
        w.schedule();
      }
    }
    if (save) this.wState.schedule();
  }

  async flushAll() {
    await Promise.all([this.wState.flush(), this.wPublic.flush(), this.wStage.flush(), ...[...this.pvWriters.values()].map((w) => w.flush())]);
  }
}

/** Events carry only what clients render; keeps docs small. */
function slimEvent(e) {
  const { log, ...rest } = e;
  return rest;
}

export { sleep };
