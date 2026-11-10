// Read-side transports for the hosted edition: the TV window and the player phone.
// Both turn db snapshots (plus fast room hints) into the same welcome/view/event/play/stop stream
// the Node edition's WebSocket delivers, so the stage and play UIs run unchanged.
import { BaseTransport, ring } from './util.js';

const LOAD_TIMEOUT_MS = 10_000;

/* ---------- TV / stage (owner window with #stage) ---------- */

export class StageTransport extends BaseTransport {
  constructor({ db, room }) {
    super();
    this.db = db;
    this.room = room;
    this.seenEvents = new Set();
    this.seenPlays = new Set();
    this.stopEpoch = null;
    this.welcomed = false;
    this.acks = [];
    this.ackWrite = Promise.resolve();
    this.unsubs = [];
  }

  connect() {
    this.setStatus('connecting');
    const timer = setTimeout(() => {
      if (!this.welcomed) this.setStatus('closed', { msg: 'Open the GM desk in another window to start the show.' });
    }, LOAD_TIMEOUT_MS);
    this.unsubs.push(this.db.doc('stage/feed').onSnapshot((snap) => {
      const body = snap.exists ? snap.data() : null;
      if (!body?.view) {
        if (!snap.metadata?.fromCache) this.setStatus('closed', { msg: 'Waiting for the GM desk' });
        return;
      }
      clearTimeout(timer);
      this.ingest(body);
    }, () => this.setStatus('closed', { msg: 'Lost the connection to the game' })));
    if (this.room) {
      this.unsubs.push(this.room.on('stage.play', (m) => { if (m.isMe && m.data) this.onPlay(m.data); }, () => {}));
      this.unsubs.push(this.room.on('stage.stop', (m) => { if (m.isMe) this.onStop(m.data?.epoch); }, () => {}));
      this.unsubs.push(this.room.on('stage.event', (m) => { if (m.isMe && m.data) this.onEvent(m.data); }, () => {}));
      this.room.presence({ role: 'stage' }).catch(() => {});
    }
  }

  ingest(body) {
    const first = !this.welcomed;
    if (first) {
      // Don't replay history on (re)load: everything already in the feed counts as seen.
      for (const e of body.events || []) this.seenEvents.add(e.id);
      this.stopEpoch = body.stopEpoch ?? 0;
      this.welcomed = true;
      this.setStatus('open');
      this.emit('welcome', { role: 'stage', view: body.view });
    }
    this.emit('view', body.view);
    if (!first) for (const e of body.events || []) this.onEvent(e);
    if (typeof body.stopEpoch === 'number' && this.stopEpoch !== null && body.stopEpoch > this.stopEpoch) this.onStop(body.stopEpoch);
    // A line still marked playing when we (re)load is played if it is fresh, else acknowledged.
    if (body.play?.id && !this.seenPlays.has(body.play.id)) {
      if (Date.now() - (body.play.at || 0) < 10_000) this.onPlay(body.play);
      else { this.seenPlays.add(body.play.id); this.raw({ t: 'audio.done', id: body.play.id }); }
    }
  }

  onEvent(e) {
    if (!e?.id || this.seenEvents.has(e.id)) return;
    this.seenEvents.add(e.id);
    if (this.seenEvents.size > 300) this.seenEvents = new Set([...this.seenEvents].slice(-150));
    if (this.welcomed) this.emit('event', e);
  }

  onPlay(p) {
    if (!p?.id || this.seenPlays.has(p.id)) return;
    this.seenPlays.add(p.id);
    if (this.welcomed) this.emit('play', p);
  }

  onStop(epoch) {
    if (typeof epoch !== 'number' || (this.stopEpoch !== null && epoch <= this.stopEpoch)) return;
    this.stopEpoch = epoch;
    this.emit('stop', { t: 'stop' });
  }

  /** The stage UI calls raw() for audio.done / audio.pause. Acks go out on both channels. */
  raw(msg) {
    if (msg?.t !== 'audio.done' || typeof msg.id !== 'string') return true;
    this.room?.emit('stage.ack', { id: msg.id }).catch(() => {});
    ring(this.acks, msg.id, 10);
    const ids = this.acks.slice();
    this.ackWrite = this.ackWrite.then(() => this.db.doc('stage/acks').set({ ids, at: Date.now() })).catch(() => {});
    return true;
  }
}

/* ---------- player phone ---------- */

export class PlayerTransport extends BaseTransport {
  /**
   * Emits 'assigned' (bool) whenever the GM assigns or unassigns this person, 'public' with the
   * public view (for the waiting screen).
   */
  constructor({ db, room, userId }) {
    super();
    this.db = db;
    this.room = room;
    this.userId = userId;
    this.seen = new Set();
    this.welcomed = false;
    this.assigned = null;
    this.readIds = loadReadIds(userId);
    this.notes = null;
    this.lastBody = null;
    this.unsubs = [];
    this.outbox = []; // [{n, a}] relayed to the GM through presence until acked
    this.waiting = new Map(); // n -> {resolve, reject, timer}
    this.seq = 0;
  }

  connect() {
    // No 'connecting' status here: the play UI would cover the lobby with its reconnect overlay.
    const timer = setTimeout(() => { if (this.assigned === null) this.emit('slow', true); }, LOAD_TIMEOUT_MS);
    this.unsubs.push(this.db.doc('public/view').onSnapshot((s) => {
      if (s.exists) this.emit('public', s.data()?.view || null);
    }, () => {}));
    this.unsubs.push(this.db.doc(`pv/${this.userId}`).onSnapshot((s) => {
      clearTimeout(timer);
      const body = s.exists ? s.data() : null;
      if (!s.exists && s.metadata?.fromCache) return;
      this.lastBody = body;
      this.ingest(body);
    }, () => { clearTimeout(timer); this.emit('slow', true); }));
    // Private notes (needs Contributor); falls back to this browser.
    this.unsubs.push(this.db.doc(`data/users/${this.userId}/notes`).onSnapshot((s) => {
      if (!s.exists) return;
      const text = s.data()?.text;
      if (typeof text === 'string' && text !== this.notes) {
        this.notes = text;
        if (this.lastBody?.view) this.ingest(this.lastBody, true);
      }
    }, () => {}));
    if (this.notes === null) this.notes = localNotes(this.userId);
    if (this.room) this.unsubs.push(this.room.on('player.ack', (m) => { if (m.data?.to === this.userId) this.onAck(m.data); }, () => {}));
    this.presence();
  }

  presence() {
    this.room?.presence({ role: 'player', readIds: [...this.readIds].slice(-40), acts: this.outbox.slice(-8) }).catch(() => {});
  }

  onAck(ack) {
    const n = Number(ack?.n);
    const w = this.waiting.get(n);
    const had = this.outbox.length;
    this.outbox = this.outbox.filter((x) => x.n !== n);
    if (this.outbox.length !== had) this.presence();
    if (!w) return;
    this.waiting.delete(n);
    clearTimeout(w.timer);
    if (ack.ok) w.resolve({ t: 'ack', ok: true, ...(ack.result ? { result: ack.result } : {}) });
    else w.reject(Object.assign(new Error(ack.msg || ack.error || 'Refused'), { code: ack.error }));
  }

  /** Sends a sheet action to the GM's page (the game server) and waits for its ack. */
  relay(action) {
    if (!this.room) return Promise.reject(new Error('Live connection unavailable on this page'));
    const { rid, ...a } = action;
    if (new TextEncoder().encode(JSON.stringify(a)).length > 2600) return Promise.reject(new Error('Too long to send. Shorten it.'));
    const n = Date.now() * 1000 + (this.seq++ % 1000);
    this.outbox.push({ n, a });
    if (this.outbox.length > 8) this.outbox.shift();
    this.presence();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(n);
        this.outbox = this.outbox.filter((x) => x.n !== n);
        this.presence();
        reject(new Error('The GM desk did not answer. Is it open?'));
      }, 12_000);
      this.waiting.set(n, { resolve, reject, timer });
    });
  }

  ingest(body, quiet = false) {
    const v = body?.view;
    const isAssigned = !!v?.me;
    if (isAssigned !== this.assigned) {
      this.assigned = isAssigned;
      this.emit('assigned', isAssigned);
    }
    for (const ack of body?.acks || []) if (this.waiting.has(Number(ack?.n))) this.onAck(ack);
    if (!isAssigned) return;
    // Overlay what lives on this device: read receipts not yet echoed back, and private notes.
    const view = structuredClone(v);
    for (const m of view.me.messages || []) if (this.readIds.has(m.id)) m.read = true;
    for (const m of view.me.secrets || []) if (this.readIds.has(m.id)) m.read = true;
    if (typeof this.notes === 'string' && !view.me.sheet) view.me.notes = this.notes; // v1 engines only
    if (!this.welcomed) {
      this.welcomed = true;
      for (const e of body.events || []) this.seen.add(e.id);
      this.setStatus('open');
      this.emit('welcome', { role: 'player', playerId: view.me.id, view });
    }
    this.emit('view', view);
    if (quiet) return;
    for (const e of body.events || []) {
      if (this.seen.has(e.id)) continue;
      this.seen.add(e.id);
      this.emit('event', e);
    }
  }

  async send(action) {
    if (action.t === 'secret.read' && typeof action.id === 'string') {
      this.readIds.add(action.id);
      saveReadIds(this.userId, this.readIds);
      this.presence();
      return { t: 'ack', ok: true };
    }
    if (action.t === 'ping') return { t: 'ack', ok: true };
    if (action.t === 'me.notes' || (action.t === 'sheet.set' && action.path === 'story.notes')) {
      // Keep the private copy too (works without the GM page), then relay to the engine.
      const text = action.t === 'me.notes' ? action.text : action.value;
      this.saveNotes(text).catch(() => {});
    }
    return this.relay(action);
  }

  /** Notes go to data/users/<id>/notes; without write access they stay in this browser. */
  async saveNotes(text) {
    const t = String(text ?? '').slice(0, 2000);
    this.notes = t;
    try { localStorage.setItem(`system.notes.${this.userId}`, t); } catch {}
    try {
      await this.db.doc(`data/users/${this.userId}/notes`).set({ text: t, at: Date.now() });
      return { t: 'ack', ok: true };
    } catch {
      const e = new Error('saved on this device only');
      e.local = true;
      throw e;
    }
  }

  raw() { return true; }
}

function loadReadIds(uid) {
  try { return new Set(JSON.parse(localStorage.getItem(`system.read.${uid}`) || '[]')); } catch { return new Set(); }
}
function saveReadIds(uid, set) {
  try { localStorage.setItem(`system.read.${uid}`, JSON.stringify([...set].slice(-200))); } catch {}
}
function localNotes(uid) {
  try { return localStorage.getItem(`system.notes.${uid}`); } catch { return null; }
}
