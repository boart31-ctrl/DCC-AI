// Crawlers remaining: the worldwide head count the System keeps announcing (campaign-level, survives
// sessions and restarts). Pure + browser-safe (no Node imports).
//
// state.crawlers = { count, at, floor, start, running, shown, speak, last, history }
//   count/at   the anchor: `count` crawlers were alive at server time `at`
//   floor      the floor the world is on (1..99); `start` = the count when that floor began
//   running    slow organic attrition while the show is on (a TV connected and the table active)
//   shown      counter in the TV broadcast HUD and on the phones
//   speak      after the System's recorded lead-in line, read the number out (TTS / browser voice)
//
// Organic attrition only eats the part above the floor's minimum:
//   value(t) = min + (count − min) · (1 − perHour) ^ hours,  hours = min(t − at, MAX_GAP_MS) / 1 h
// so it slows down near the minimum and never crosses it. The host re-anchors (`crawlers.tick`) about
// once a minute; clients interpolate between anchors with the same formula, so the TV digits roll live.
// MAX_GAP_MS caps one step: a TV left on overnight or a campaign asleep for a week never loses millions.
//
// Pack config (pack.json "crawlers", every field optional; see docs/CONTENT_PACKS.md):
//   { label, start, floors: [{ floor, start, perHour, min }], events: [{ id, label, min, max, line? }],
//     numberLine: "{count} crawlers remain.", collapseKeep }

import { bad, notFound } from './errors.js';

export const TICK_MS = 60_000; // host re-anchors at most this often (one state write per minute)
export const MAX_GAP_MS = 150_000; // one step never covers more than this (server and clients)
export const IDLE_MS = 45 * 60_000; // no table action for this long: the dungeon holds its breath
export const MAX_COUNT = 1e10;
export const MAX_FLOOR = 99;
export const HISTORY_SIZE = 20;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const ID_RE = /^[a-z0-9_-]{1,40}$/;
const fraction = (v, dflt, max = 1) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : dflt);
const whole = (v, dflt, min = 0) => (Number.isFinite(v) && v >= min && v <= MAX_COUNT ? Math.round(v) : dflt);

// Generic engine defaults: a small world. A content pack (the DCC pack) sets book-sized numbers.
export const DEFAULT_EVENTS = [
  { id: 'skirmish', label: 'Fights elsewhere', min: 0.002, max: 0.008, line: 'crawlers_drop' },
  { id: 'event', label: 'Big event', min: 0.03, max: 0.07, line: 'crawlers_drop' },
  { id: 'massacre', label: 'Massacre', min: 0.12, max: 0.25, line: 'crawlers_drop' },
];
export const DEFAULT_LEADS = {
  crawlers_remaining: 'Attention, crawlers. A count has been taken.',
  crawlers_drop: 'Attention, crawlers. That was a lot of you.',
  crawlers_collapse: 'This floor has collapsed.',
  death: 'A crawler has died.',
};

/** Normalizes pack.json "crawlers" (idempotent: deserializePack runs it again). Never throws. */
export function normalizeCrawlersConfig(raw, warnings = []) {
  const r = isObj(raw) ? raw : {};
  if (raw != null && !isObj(raw)) warnings.push('pack.json "crawlers" must be an object, using defaults');
  const start = whole(r.start, 1_000_000, 1);
  const floors = [];
  const seen = new Set();
  for (const [i, f] of (Array.isArray(r.floors) ? r.floors : []).entries()) {
    const floor = Number.isInteger(f?.floor) && f.floor >= 1 && f.floor <= MAX_FLOOR ? f.floor : null;
    if (!floor || seen.has(floor)) { warnings.push(`pack.json crawlers.floors[${i}]: needs a unique "floor" 1..${MAX_FLOOR}, skipping`); continue; }
    seen.add(floor);
    floors.push({
      floor,
      start: whole(f.start, null, 1),
      perHour: fraction(f.perHour, null, 0.9),
      min: whole(f.min, null, 0),
    });
  }
  floors.sort((a, b) => a.floor - b.floor);
  let events = DEFAULT_EVENTS;
  if (Array.isArray(r.events)) {
    const ids = new Set();
    events = [];
    for (const [i, e] of r.events.entries()) {
      if (!isObj(e) || !isStr(e.id) || !ID_RE.test(e.id) || ids.has(e.id) || !isStr(e.label)) {
        warnings.push(`pack.json crawlers.events[${i}]: needs a unique id and a label, skipping`);
        continue;
      }
      ids.add(e.id);
      const lo = fraction(e.min, 0.01);
      const hi = Math.max(lo, fraction(e.max, lo));
      events.push({ id: e.id, label: e.label.trim().slice(0, 40), min: lo, max: hi, line: isStr(e.line) && /^[a-z0-9_]+$/.test(e.line) ? e.line : 'crawlers_drop' });
    }
    if (events.length > 8) events = events.slice(0, 8);
  }
  const numberLine = isStr(r.numberLine) && r.numberLine.includes('{count}') ? r.numberLine.trim().slice(0, 200) : '{count} crawlers remain.';
  return {
    label: isStr(r.label) ? r.label.trim().slice(0, 40) : 'Crawlers remaining',
    start,
    perHour: fraction(r.perHour, 0.04, 0.9),
    collapseKeep: fraction(r.collapseKeep, 0.4),
    floors,
    events,
    numberLine,
  };
}

/** The attrition rule for a floor: { start, perHour, min, nextStart }. Unlisted fields are derived. */
export function floorRule(cfg, floor) {
  const c = cfg ?? normalizeCrawlersConfig(null);
  const f = c.floors.find((x) => x.floor === floor);
  const next = c.floors.find((x) => x.floor === floor + 1);
  // A floor that is not listed starts from the last listed one, shrunk by collapseKeep per floor.
  const startOf = (n) => {
    const own = c.floors.find((x) => x.floor === n)?.start;
    if (own) return own;
    const below = [...c.floors].reverse().find((x) => x.floor < n && x.start);
    const [from, at] = below ? [below.start, below.floor] : [c.start, 1];
    return Math.max(1, Math.round(from * c.collapseKeep ** (n - at)));
  };
  const start = startOf(floor);
  const nextStart = next?.start ?? startOf(floor + 1);
  // Never organically below what the collapse would leave anyway (a little above it), or half the floor.
  const min = f?.min ?? Math.max(Math.round(nextStart * 1.15), Math.round(start * 0.5));
  return { start, perHour: f?.perHour ?? c.perHour, min: Math.min(min, start), nextStart };
}

export function initCrawlers(pack, now) {
  const cfg = pack?.crawlers ?? normalizeCrawlersConfig(null);
  const start = floorRule(cfg, 1).start;
  return { count: start, at: now, floor: 1, start, running: true, shown: true, speak: true, last: null, history: [] };
}

export function normalizeCrawlers(raw, pack, now) {
  const base = initCrawlers(pack, now);
  if (!isObj(raw)) return base;
  const floor = Number.isInteger(raw.floor) && raw.floor >= 1 && raw.floor <= MAX_FLOOR ? raw.floor : base.floor;
  const count = whole(raw.count, base.count);
  return {
    count,
    at: Number.isFinite(raw.at) ? raw.at : now,
    floor,
    start: whole(raw.start, Math.max(count, 1), 1),
    running: raw.running !== false,
    shown: raw.shown !== false,
    speak: raw.speak !== false,
    last: isObj(raw.last) ? raw.last : null,
    history: Array.isArray(raw.history) ? raw.history.filter(isObj).slice(-HISTORY_SIZE) : [],
  };
}

/** Never fewer crawlers in the world than at this table. */
const partyMin = (state) => Math.max(1, state.players?.length ?? 0);

/** Is the count moving right now? Running, a TV on air, and someone touched the game recently. */
export function crawlersLive(state, now, stageOn = true) {
  const c = state.crawlers;
  if (!c?.running || !stageOn) return false;
  const last = state.host?.lastActionAt || c.at;
  return now - last < IDLE_MS;
}

/** The attrition curve (shared formula with web/js/crawlers.js). */
export function decay(count, min, perHour, ms) {
  if (count <= min || !(perHour > 0) || !(ms > 0)) return count;
  const h = Math.min(ms, MAX_GAP_MS) / 3_600_000;
  return Math.floor(min + (count - min) * (1 - perHour) ** h);
}

/** Current count at `now` (organic attrition applied when live). */
export function crawlersAt(state, pack, now, stageOn = true) {
  const c = state.crawlers;
  if (!crawlersLive(state, now, stageOn)) return c.count;
  const rule = floorRule(pack.crawlers, c.floor);
  return decay(c.count, Math.max(rule.min, partyMin(state)), rule.perHour, now - c.at);
}

export const fmtCount = (n) => Math.max(0, Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// ---------- reducers ----------


/** Bakes organic attrition into the anchor before any change (so a change lands on what the TV shows). */
function settle(st, ctx) {
  const c = st.crawlers;
  c.count = crawlersAt(st, ctx.pack, ctx.now, ctx.stageOn !== false);
  c.at = ctx.now;
  return c;
}

function remember(c, entry) {
  c.last = entry;
  c.history = [...(c.history ?? []), entry].slice(-HISTORY_SIZE);
}

/** The System's voice: a recorded lead-in from `category`, then (optionally) the number, chained. */
function voiceLines(st, ctx, out, category, count, cue) {
  const lead = ctx.h.categoryLine(st, ctx, category, 0)
    ?? (category !== 'death' && category !== 'crawlers_remaining' ? ctx.h.categoryLine(st, ctx, 'crawlers_remaining', 0) : null)
    ?? { priority: 0, text: DEFAULT_LEADS[category] ?? DEFAULT_LEADS.crawlers_remaining, quipId: null, crit: false, category };
  const tmpl = ctx.pack.crawlers?.numberLine ?? '{count} crawlers remain.';
  const number = st.crawlers.speak ? { priority: 0, text: tmpl.replace('{count}', fmtCount(count)), quipId: null, crit: false, category: 'crawlers_count' } : null;
  out.lines.push({ ...lead, ...(cue ? { cue } : {}), ...(number ? { chain: number } : {}) });
}

/** One big moment: state + feed + event (+ voice). `moment` = TV takeover. */
function dropMoment(st, ctx, out, { from, to, reason, label, category, announce, moment = true, playerId = null }) {
  const c = st.crawlers;
  const entry = { at: ctx.now, floor: c.floor, from, to, reason, label };
  remember(c, entry);
  const gmAudio = (st.show?.audioDevice ?? 'gm') === 'gm';
  const ev = out.emit({
    kind: 'crawlers', reason, label, from, to, floor: c.floor, moment, playerId,
    voiceCue: !!announce && gmAudio, labelText: ctx.pack.crawlers?.label ?? 'Crawlers remaining',
  }, 'all');
  const lost = from - to;
  const feedText = reason === 'announce'
    ? `${fmtCount(to)} crawlers remain`
    : reason === 'death' ? `${label}. ${fmtCount(to)} crawlers remain`
      : `${label}: ${lost > 0 ? `−${fmtCount(lost)}` : 'nobody'}. ${fmtCount(to)} remain`;
  ctx.h.feedPush(st, ev, feedText);
  if (announce) voiceLines(st, ctx, out, category, to, gmAudio ? ev.id : null);
  return ev;
}

const floorOf = (v) => {
  if (!Number.isInteger(v) || v < 1 || v > MAX_FLOOR) throw bad(`floor must be an integer 1..${MAX_FLOOR}`);
  return v;
};
const countOf = (v, field = 'count') => {
  if (!Number.isInteger(v) || v < 0 || v > MAX_COUNT) throw bad(`${field} must be an integer 0..${MAX_COUNT}`);
  return v;
};
const boolOf = (v, field) => {
  if (v !== undefined && typeof v !== 'boolean') throw bad(`${field} must be a boolean`);
  return v;
};
const jitter = (rng, lo, hi) => lo + rng() * (hi - lo);

export const CRAWLERS_GM = {
  /** Quiet edits (no TV moment): count, floor, running (pause / resume), shown (HUD), speak (read the number). */
  'crawlers.set'(st, a, ctx) {
    const c = settle(st, ctx);
    const keys = ['count', 'floor', 'running', 'shown', 'speak', 'start'];
    if (!keys.some((k) => a[k] !== undefined)) throw bad(`give one of ${keys.join(', ')}`);
    for (const k of ['running', 'shown', 'speak']) if (boolOf(a[k], k) !== undefined) c[k] = a[k];
    if (a.floor !== undefined) {
      c.floor = floorOf(a.floor);
      if (a.start === undefined && a.count === undefined) c.start = Math.max(c.count, 1);
    }
    if (a.count !== undefined) {
      c.count = countOf(a.count);
      if (a.start === undefined) c.start = Math.max(c.start, c.count, 1);
    }
    if (a.start !== undefined) c.start = Math.max(1, countOf(a.start, 'start'));
  },

  /** Small manual correction (± crawlers), no fanfare. */
  'crawlers.adjust'(st, a, ctx) {
    if (!Number.isInteger(a.delta) || a.delta === 0 || Math.abs(a.delta) > MAX_COUNT) throw bad('delta must be a non-zero integer');
    const c = settle(st, ctx);
    c.count = Math.max(0, Math.min(MAX_COUNT, c.count + a.delta));
  },

  /**
   * A big event somewhere in the dungeon: `event` (pack event id → random share of the living),
   * or `pct` (0..1), or `amount`. TV moment + System line + chat burst unless announce: false.
   */
  'crawlers.drop'(st, a, ctx, out) {
    const cfg = ctx.pack.crawlers;
    const c = settle(st, ctx);
    const from = c.count;
    let lost;
    let label = typeof a.label === 'string' && a.label.trim() ? a.label.trim().slice(0, 60) : null;
    let category = 'crawlers_drop';
    if (a.event !== undefined) {
      const e = (cfg?.events ?? DEFAULT_EVENTS).find((x) => x.id === a.event);
      if (!e) throw notFound(`unknown crawler event ${a.event}`);
      lost = Math.round(from * jitter(ctx.rng, e.min, e.max));
      label ??= e.label;
      category = e.line;
    } else if (a.pct !== undefined) {
      if (typeof a.pct !== 'number' || !(a.pct > 0) || a.pct > 1) throw bad('pct must be a number in (0, 1]');
      lost = Math.round(from * a.pct);
    } else if (a.amount !== undefined) {
      lost = countOf(a.amount, 'amount');
    } else throw bad('give event, pct or amount');
    boolOf(a.announce, 'announce');
    const to = Math.max(partyMin(st), from - Math.max(0, lost));
    c.count = Math.min(from, to);
    dropMoment(st, ctx, out, { from, to: c.count, reason: a.event ?? 'drop', label: label ?? 'Casualties', category, announce: a.announce !== false });
    out.result = { from, to: c.count, lost: from - c.count };
  },

  /**
   * The floor collapses: whoever did not make the stairs is gone. The count drops to the next floor's
   * start (± a little, never up), the floor advances. `floor` jumps to a specific floor.
   */
  'crawlers.collapse'(st, a, ctx, out) {
    const c = settle(st, ctx);
    const next = a.floor !== undefined ? floorOf(a.floor) : Math.min(MAX_FLOOR, c.floor + 1);
    if (next <= c.floor) throw bad(`the world is already on floor ${c.floor}`);
    boolOf(a.announce, 'announce');
    const from = c.count;
    const target = floorRule(ctx.pack.crawlers, next).start;
    const to = Math.max(partyMin(st), Math.min(from, Math.round(target * jitter(ctx.rng, 0.97, 1.03))));
    const prevFloor = c.floor;
    c.count = to;
    c.floor = next;
    c.start = Math.max(1, to);
    c.running = true;
    dropMoment(st, ctx, out, {
      from, to, reason: 'collapse', label: `Floor ${prevFloor} collapsed`, category: 'crawlers_collapse', announce: a.announce !== false,
    });
    out.result = { from, to, floor: next };
  },

  /** The System reads out the current count (TV moment + lead-in line + number). */
  'crawlers.announce'(st, a, ctx, out) {
    const c = settle(st, ctx);
    dropMoment(st, ctx, out, { from: c.count, to: c.count, reason: 'announce', label: 'Crawler count', category: 'crawlers_remaining', announce: true });
    out.result = { count: c.count };
  },

  /** A crawler at this table died for good: −1, called out (System line from `death`), no takeover. */
  'crawlers.death'(st, a, ctx, out) {
    let name = 'A crawler';
    if (a.playerId !== undefined) {
      const p = st.players.find((x) => x.id === a.playerId);
      if (!p) throw notFound(`no player ${a.playerId}`);
      name = p.name;
    }
    boolOf(a.announce, 'announce');
    const c = settle(st, ctx);
    const from = c.count;
    c.count = Math.max(0, from - 1);
    dropMoment(st, ctx, out, {
      from, to: c.count, reason: 'death', label: `${name} died`, category: 'death', announce: a.announce !== false,
      moment: false, playerId: a.playerId ?? null,
    });
    out.result = { from, to: c.count };
  },
};

export const CRAWLERS_SYSTEM = {
  /** Host timer (about once a minute while a TV is on): bake organic attrition into the anchor. */
  'crawlers.tick'(st, a, ctx, out) {
    const c = st.crawlers;
    if (!c || ctx.now - c.at < TICK_MS || !crawlersLive(st, ctx.now, true)) return;
    settle(st, ctx);
    out.changed = true;
  },
};

// ---------- view ----------

/** Every role: what the HUD needs to draw and interpolate. GM also gets the controls' data. */
export function crawlersView(state, pack, role, now, stageOn = true) {
  const c = state.crawlers;
  if (!c) return null;
  const rule = floorRule(pack.crawlers, c.floor);
  const live = crawlersLive(state, now, stageOn);
  const v = {
    count: c.count, at: c.at, now, floor: c.floor, start: c.start,
    live, running: c.running, shown: c.shown,
    perHour: rule.perHour, min: Math.max(rule.min, partyMin(state)), maxGapMs: MAX_GAP_MS,
    label: pack.crawlers?.label ?? 'Crawlers remaining',
    last: c.last ? { at: c.last.at, from: c.last.from, to: c.last.to, reason: c.last.reason, label: c.last.label } : null,
  };
  if (role === 'gm') {
    v.speak = c.speak;
    v.history = c.history ?? [];
    v.events = (pack.crawlers?.events ?? DEFAULT_EVENTS).map(({ id, label, min, max }) => ({ id, label, min, max }));
    v.nextFloor = Math.min(MAX_FLOOR, c.floor + 1);
    v.nextStart = c.floor < MAX_FLOOR ? floorRule(pack.crawlers, c.floor + 1).start : null;
    v.floorStart = rule.start;
  }
  return v;
}
