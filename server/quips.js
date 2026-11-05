// Quip picker (no repeats per session per category) + voice queue (SPEC "Voice timing rules").

export const MODES = ['roleplay', 'combat', 'quiet'];
export const CRIT_CATEGORIES = new Set(['nat1', 'nat20']);

export const STALE_MS = 20_000; // P1/P2 lines older than this are dropped instead of played
export const VETO_MS = 5_000; // P2 lines wait this long in pendingAuto before queueing
export const PLAYING_TIMEOUT_MS = 15_000; // stage's own safety timeout is 12 s; this unsticks a vanished stage

/** roleplay: everything; combat: P0 + crits; quiet: P0 only. */
export function modeAllows(mode, priority, crit = false) {
  if (priority === 0) return true;
  if (mode === 'quiet') return false;
  if (mode === 'combat') return !!crit;
  return true;
}

/** How many unused quips are left in a category this session. */
export function quipsLeft(pack, used, category) {
  const all = pack.quipsByCategory.get(category) ?? [];
  const u = new Set(used?.[category] ?? []);
  return all.filter((q) => !u.has(q.id)).length;
}

/**
 * Picks a random unused quip from a category. When the category is exhausted it recycles
 * (starts a fresh round) but avoids repeating the line that played last.
 * Returns { quip, used } with a new `used` object, or null if the category has no quips.
 */
export function pickQuip(pack, used, category, rng = Math.random) {
  const all = pack.quipsByCategory.get(category) ?? [];
  if (!all.length) return null;
  const prev = used?.[category] ?? [];
  const usedSet = new Set(prev);
  let pool = all.filter((q) => !usedSet.has(q.id));
  let round = prev;
  if (!pool.length) {
    const last = prev[prev.length - 1];
    pool = all.length > 1 ? all.filter((q) => q.id !== last) : all;
    round = [];
  }
  const quip = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
  return { quip, used: { ...used, [category]: [...round, quip.id] } };
}

/** Marks a specific quip as used (GM picked it by id). */
export function markQuipUsed(used, quip) {
  const prev = used?.[quip.category] ?? [];
  if (prev.includes(quip.id)) return used;
  return { ...used, [quip.category]: [...prev, quip.id] };
}

/**
 * Voice queue. Owns only transient audio state; session settings (mode/auto/budget) are read
 * through getSession() and the budget is spent through consumeBudget().
 *
 * - P0 plays immediately, replacing whatever line is currently playing (the stage treats a new
 *   `play` as "stop current, play this"). It never waits behind queued P1/P2 lines.
 * - P1/P2 wait until nothing is playing and the table is silent, ordered by priority then FIFO.
 *   They are dropped if older than STALE_MS or if the current mode no longer allows them.
 * - P2 first sits in pendingAuto for VETO_MS; on promotion gates are re-checked and budget spent.
 */
export class VoiceQueue {
  constructor({ now = Date.now, genId, getSession, consumeBudget, onPlay, onStop, onChange } = {}) {
    this.now = now;
    this.genId = genId;
    this.getSession = getSession;
    this.consumeBudget = consumeBudget ?? (() => {});
    this.onPlay = onPlay ?? (() => {});
    this.onStop = onStop ?? (() => {});
    this.onChange = onChange ?? (() => {});
    this.queue = [];
    this.pending = [];
    this.playing = null;
    this.silent = true; // phase 1: table is always treated as silent
    this.seq = 0;
  }

  _item({ priority, text, quipId = null, crit = false }) {
    const at = this.now();
    return { id: this.genId('q'), priority, text, quipId, crit: !!crit, createdAt: at, seq: this.seq++ };
  }

  _allowed(item) {
    return modeAllows(this.getSession().mode, item.priority, item.crit);
  }

  _stale(item) {
    return item.priority > 0 && this.now() - item.createdAt > STALE_MS;
  }

  _start(item) {
    this.playing = { ...item, startedAt: this.now() };
    this.onPlay(item);
  }

  /** P0/P1 entry point. Returns the queued item, or null if the mode filtered it. */
  push(line) {
    if (line.priority === 2) return this.propose(line);
    const item = this._item(line);
    if (!this._allowed(item)) return null;
    if (item.priority === 0) {
      this._start(item);
    } else {
      this.queue.push(item);
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this._release();
    }
    this.onChange();
    return item;
  }

  /** P2 entry point. Returns { item } or { reason } when gated. */
  propose(line) {
    const s = this.getSession();
    if (!s.auto) return { reason: 'auto_off' };
    if (s.budgetLeft - this.pending.length <= 0) return { reason: 'no_budget' };
    const item = this._item({ ...line, priority: 2 });
    if (!this._allowed(item)) return { reason: 'mode' };
    item.playsAt = item.createdAt + VETO_MS;
    this.pending.push(item);
    this.onChange();
    return { item };
  }

  veto(id) {
    const i = this.pending.findIndex((p) => p.id === id);
    if (i < 0) return false;
    this.pending.splice(i, 1);
    this.onChange();
    return true;
  }

  clearPending() {
    if (!this.pending.length) return;
    this.pending = [];
    this.onChange();
  }

  /** Drops queue + pending and tells the stage to stop. */
  clear() {
    this.queue = [];
    this.pending = [];
    this.playing = null;
    this.onStop();
    this.onChange();
  }

  /** Stage finished a line. Unknown/old ids are ignored (returns false). */
  done(id) {
    if (!this.playing || this.playing.id !== id) return false;
    this.playing = null;
    this._release();
    this.onChange();
    return true;
  }

  /** Phase-3 hook: table-silence detector. Phase 1 never calls this with false. */
  setSilent(silent) {
    this.silent = !!silent;
    if (this.silent) this._release();
  }

  /** Call periodically (~250 ms): promotes pending P2, drops stale lines, unsticks playback. */
  tick() {
    const now = this.now();
    let changed = false;
    if (this.playing && now - this.playing.startedAt > PLAYING_TIMEOUT_MS) {
      this.playing = null;
      changed = true;
    }
    const due = this.pending.filter((p) => p.playsAt <= now);
    if (due.length) {
      this.pending = this.pending.filter((p) => p.playsAt > now);
      changed = true;
      for (const item of due) {
        const s = this.getSession();
        if (!s.auto || s.budgetLeft <= 0 || !this._allowed(item)) continue;
        this.consumeBudget();
        // Staleness counts from promotion: the veto window must not eat into it.
        this.queue.push({ ...item, createdAt: now });
      }
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    }
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => !this._stale(q));
    if (this.queue.length !== before) changed = true;
    if (this._release()) changed = true;
    if (changed) this.onChange();
  }

  _release() {
    if (this.playing || !this.silent) return false;
    while (this.queue.length) {
      const next = this.queue.shift();
      if (this._stale(next) || !this._allowed(next)) continue;
      this._start(next);
      return true;
    }
    return false;
  }

  snapshot() {
    return {
      queue: this.queue.map((q) => ({ id: q.id, priority: q.priority, text: q.text })),
      pendingAuto: this.pending.map((p) => ({ id: p.id, text: p.text, playsAt: p.playsAt })),
      playing: this.playing ? { id: this.playing.id, priority: this.playing.priority, text: this.playing.text } : null,
    };
  }
}
