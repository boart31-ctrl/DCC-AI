// Fake audience chat for the TV ticker. Pure + browser-safe (no Node imports, rng injected).
//
// chat.json lines: { user, text, tags?: [context], weight?: number }   (old { user, text } still works)
//
// The host asks this module two things:
//   ambient(state)            → the next calm line for what is on the TV right now (+ the delay after it)
//   react(event, state)       → a burst of quick reactions to something big that just happened
// Lines may use {player} {boss} {mob} {item} {count} {lost}; a line whose placeholder cannot be filled from the
// current state / event is skipped. A recent-history window keeps lines from repeating.

export const CHAT_TAGS = [
  'idle', 'lobby', 'explore', 'combat', 'boss', 'boss_phase', 'boss_defeat',
  'loot', 'achievement', 'death', 'nat1', 'nat20', 'countdown', 'npc', 'recap',
  // combat auto mode (combat-auto.js) and the mob-killed moment
  'mob_hit', 'mob_miss', 'mob_crit', 'crawler_down', 'mob_killed',
  // combat endings (combat.end outcome)
  'combat_victory', 'combat_defeat', 'combat_runaway', 'combat_truce', 'combat_special',
  'combat_sponsor', 'combat_timeout', 'combat_stalemate', 'finale',
  // crawlers remaining (crawlers.js): the System's count, a big drop somewhere, a floor collapse
  'crawlers_count', 'crawlers_drop', 'floor_collapse',
];
const TAG_SET = new Set(CHAT_TAGS);
const PLACEHOLDER_RE = /\{(player|boss|mob|item|count|lost)\}/g;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

/** Validates chat.json. Untagged lines are "generic": they can show up in any calm context. */
export function normalizeChatLines(raw, warnings = []) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push('chat.json must be an array, ignoring');
    return [];
  }
  const out = [];
  const unknown = new Set();
  raw.forEach((c, i) => {
    if (!isObj(c) || !isStr(c.user) || !isStr(c.text)) {
      warnings.push(`chat.json [${i}]: needs "user" and "text", skipping`);
      return;
    }
    let tags = [];
    if (c.tags !== undefined) {
      const list = Array.isArray(c.tags) ? c.tags : typeof c.tags === 'string' ? [c.tags] : [];
      for (const t of list) {
        if (typeof t === 'string' && TAG_SET.has(t)) { if (!tags.includes(t)) tags.push(t); }
        else unknown.add(String(t));
      }
    }
    let weight = 1;
    if (c.weight !== undefined) {
      if (typeof c.weight === 'number' && Number.isFinite(c.weight) && c.weight > 0) weight = Math.min(100, c.weight);
      else warnings.push(`chat.json [${i}]: weight must be a positive number, using 1`);
    }
    out.push({ user: c.user.trim().slice(0, 40), text: c.text.trim().slice(0, 200), tags, weight });
  });
  if (unknown.size) warnings.push(`chat.json: unknown tags ignored: ${[...unknown].slice(0, 8).join(', ')}`);
  return out;
}

// ---------- context ----------

/** Seconds between calm lines, per context: [min, max]. Combat and bosses chatter faster. */
// Calmer since 11/2026 (the TV strip felt busy): roughly half the old rate in fights.
export const AMBIENT_GAP_S = {
  lobby: [10, 20], idle: [13, 25], explore: [15, 28], recap: [18, 32], countdown: [7, 13],
  npc: [14, 24], loot: [8, 15], combat: [5, 9], boss: [5, 9.5], finale: [5, 9],
};
/** A burst never has more lines than this, and its lines arrive this far apart (ms) after the first. */
export const BURST_MAX = 3;
const BURST_GAP_MS = [1500, 2800];

/** What the TV is showing right now, as a chat context. */
export function chatContext(state) {
  const kind = state?.scene?.kind;
  if (kind === 'boss') return state.scene.data?.defeated ? 'boss_defeat' : 'boss';
  if (kind === 'finale') return 'finale';
  if (state?.combat?.active || kind === 'combat') return 'combat';
  if (kind === 'explore' || kind === 'lobby' || kind === 'countdown' || kind === 'npc' || kind === 'recap' || kind === 'loot') return kind;
  return 'idle';
}

/** Burst size [min, max] and how hard the audience reacts (+viewers fraction [min, max]). */
export const REACTIONS = {
  nat20: { tag: 'nat20', burst: [3, 5], viewers: [0.02, 0.05] },
  nat1: { tag: 'nat1', burst: [3, 4], viewers: [0.01, 0.03] },
  boss_intro: { tag: 'boss', burst: [3, 5], viewers: [0.08, 0.14] },
  boss_phase: { tag: 'boss_phase', burst: [2, 4], viewers: [0.04, 0.08] },
  boss_defeat: { tag: 'boss_defeat', burst: [4, 6], viewers: null }, // boss.defeat already bumps +20%
  boss_hit: { tag: 'boss', burst: [0, 1], viewers: [0.004, 0.015] },
  combat_start: { tag: 'combat', burst: [2, 3], viewers: [0.04, 0.08] },
  combat_hit: { tag: 'combat', burst: [0, 1], viewers: [0.002, 0.01] },
  death: { tag: 'death', burst: [3, 5], viewers: [0.05, 0.1] },
  loot: { tag: 'loot', burst: [2, 3], viewers: null }, // loot / sponsor / achievement bump in the reducer
  achievement: { tag: 'achievement', burst: [2, 4], viewers: null },
  countdown: { tag: 'countdown', burst: [1, 2], viewers: [0.01, 0.03] },
  npc: { tag: 'npc', burst: [1, 2], viewers: null },
  recap: { tag: 'recap', burst: [1, 2], viewers: null },
  // auto mode beats (host-made `chat.cue` events, timed to the TV cinematic)
  mob_hit: { tag: 'mob_hit', alt: 'combat', burst: [1, 2], viewers: [0.002, 0.008] },
  mob_miss: { tag: 'mob_miss', alt: 'combat', burst: [1, 3], viewers: [0.004, 0.012] },
  mob_crit: { tag: 'mob_crit', alt: 'combat', burst: [2, 4], viewers: [0.01, 0.03] },
  crawler_down: { tag: 'crawler_down', alt: 'death', burst: [3, 5], viewers: [0.05, 0.1] },
  mob_killed: { tag: 'mob_killed', alt: 'combat', burst: [1, 3], viewers: [0.006, 0.02] },
  ...Object.fromEntries(['victory', 'defeat', 'runaway', 'truce', 'special', 'sponsor', 'timeout', 'stalemate'].map((o) => [
    `combat_${o}`, { tag: `combat_${o}`, alt: o === 'victory' ? 'boss_defeat' : 'combat', burst: [4, 6], viewers: o === 'victory' ? null : [0.03, 0.08] },
  ])),
  // crawlers.js: the audience loves a body count
  crawlers_count: { tag: 'crawlers_count', alt: 'crawlers_drop', burst: [1, 2], viewers: [0.01, 0.03] },
  crawlers_drop: { tag: 'crawlers_drop', alt: 'death', burst: [3, 5], viewers: [0.04, 0.09] },
  floor_collapse: { tag: 'floor_collapse', alt: 'crawlers_drop', burst: [4, 6], viewers: [0.08, 0.15] },
};

/**
 * Which reaction an event deserves (null = none) and what it can fill placeholders with.
 * Only events the TV is allowed to see should be passed in (the host checks the audience).
 */
export function reactionFor(e) {
  if (!isObj(e)) return null;
  const fill = {};
  if (e.playerId) fill.playerId = e.playerId;
  if (e.item?.name) fill.item = e.item.name;
  switch (e.kind) {
    case 'roll': {
      const r = isObj(e.roll) ? e.roll : e;
      if (r.secret) return null;
      if (!r.playerId && r.by === 'gm') return null; // GM / mob rolls: auto mode cues its own reactions
      if (r.playerId) fill.playerId = r.playerId;
      if (r.nat20) return { key: 'nat20', fill };
      if (r.nat1) return { key: 'nat1', fill };
      return null;
    }
    case 'boss.intro': return { key: 'boss_intro', fill: { ...fill, boss: e.name } };
    case 'boss.phase': return { key: 'boss_phase', fill }; // e.name is the phase, the boss comes from the scene
    case 'boss.defeat': return { key: 'boss_defeat', fill: { ...fill, boss: e.name } };
    case 'boss.hit': return { key: 'boss_hit', fill };
    case 'combat.start': return { key: 'combat_start', fill };
    case 'combat.hit':
      if (e.type === 'crawler' && e.down) return { key: 'crawler_down', fill: { ...fill, playerId: e.playerId } };
      if (e.type === 'mob' && e.down) return { key: 'mob_killed', fill: { ...fill, mob: e.name } };
      if (e.type === 'mob') return { key: 'combat_hit', fill: { ...fill, mob: e.name } };
      return { key: 'combat_hit', fill };
    case 'loot':
    case 'sponsor': return { key: 'loot', fill };
    case 'achievement': return { key: 'achievement', fill };
    case 'npc.say': return { key: 'npc', fill };
    case 'crawlers': {
      const n = (x) => Math.max(0, Math.round(Number(x) || 0)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      const f = { ...fill, count: n(e.to), lost: e.from > e.to ? n(e.from - e.to) : '' };
      if (e.reason === 'collapse') return { key: 'floor_collapse', fill: f };
      if (e.reason === 'announce') return { key: 'crawlers_count', fill: f };
      if (e.reason === 'death') return { key: 'death', fill: f };
      return { key: 'crawlers_drop', fill: f };
    }
    // Host-made cue (combat-auto.js): never delivered to a client, carries its own delay.
    case 'chat.cue': return REACTIONS[e.cue] ? { key: e.cue, fill: { ...fill, ...(isObj(e.fill) ? e.fill : {}) }, delayMs: Number(e.delayMs) || 0 } : null;
    // Host-made pseudo event: the TV switched to another scene.
    case 'scene':
      if (e.scene === 'countdown') return { key: 'countdown', fill };
      if (e.scene === 'recap') return { key: 'recap', fill };
      return null;
    default: return null;
  }
}

// ---------- placeholders ----------

const pickOne = (rng, list) => (list.length ? list[Math.floor(rng() * list.length) % list.length] : undefined);

/** Values for {player} {boss} {mob} {item}, from the event first, then from the state. Lazily picked. */
export function fillerFor(state, rng, fill = {}) {
  const players = Array.isArray(state?.players) ? state.players : [];
  const nameOf = (p) => (p?.name ? String(p.name) : '');
  const cache = {};
  const get = {
    player() {
      const p = fill.playerId && players.find((x) => x.id === fill.playerId);
      if (p) return nameOf(p);
      const on = players.filter((x) => x.name);
      return nameOf(pickOne(rng, on));
    },
    boss() {
      if (fill.boss) return fill.boss;
      const s = state?.scene;
      return s?.kind === 'boss' ? (s.data?.boss?.name || '') : '';
    },
    mob() {
      if (fill.mob) return fill.mob;
      const mobs = (state?.combat?.combatants || []).filter((x) => x.type === 'mob' && !x.hidden && x.name && x.hp > 0);
      return pickOne(rng, mobs)?.name || '';
    },
    count() {
      if (fill.count) return fill.count;
      const c = state?.crawlers?.count;
      return Number.isFinite(c) ? Math.round(c).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '';
    },
    lost() {
      return fill.lost || '';
    },
    item() {
      if (fill.item) return fill.item;
      const p = fill.playerId && players.find((x) => x.id === fill.playerId);
      const inv = (p ? [p] : players).flatMap((x) => (Array.isArray(x.inventory) ? x.inventory : []));
      return pickOne(rng, inv.filter((i) => i?.name))?.name || '';
    },
  };
  return (key) => {
    if (!(key in cache)) cache[key] = String(get[key]?.() || '').slice(0, 40);
    return cache[key];
  };
}

/** Replaces placeholders; returns null when one of them has no value. */
export function fillText(text, value) {
  let ok = true;
  const out = text.replace(PLACEHOLDER_RE, (_, k) => {
    const v = value(k);
    if (!v) ok = false;
    return v;
  });
  return ok ? out : null;
}

const needs = (line) => /\{(player|boss|mob|item|count|lost)\}/.test(line.user + line.text);

// ---------- director ----------

/**
 * @param {object} o
 * @param {Array} o.lines   normalized chat lines (pack.chat)
 * @param {() => number} [o.rng]
 * @param {() => number} [o.now]
 * @param {number} [o.recent]  how many recent lines are blocked from repeating (default: 60% of the pool, max 80)
 */
export function createChat({ lines = [], rng = Math.random, now = Date.now, recent } = {}) {
  const pool = lines.map((l, i) => ({ ...l, i, tags: l.tags || [], weight: l.weight ?? 1 }));
  const generic = pool.filter((l) => !l.tags.length || l.tags.includes('idle'));
  const byTag = new Map(CHAT_TAGS.map((t) => [t, pool.filter((l) => l.tags.includes(t))]));
  const windowSize = Math.max(1, Math.min(80, recent ?? Math.floor(pool.length * 0.6)));
  const history = []; // line indexes, newest last
  let afterglow = null; // { tag, at, fill } — the last big moment keeps flavouring calm chat for a while
  const AFTERGLOW_MS = 45_000;

  const remember = (i) => {
    history.push(i);
    while (history.length > windowSize) history.shift();
  };

  function weighted(cands) {
    const total = cands.reduce((s, c) => s + c.w, 0);
    if (!(total > 0)) return null;
    let r = rng() * total;
    for (const c of cands) {
      r -= c.w;
      if (r < 0) return c.line;
    }
    return cands[cands.length - 1].line;
  }

  /**
   * One line for `tag`. strict = only lines with that tag; otherwise generic lines join in at a lower
   * weight. Returns { user, text, tag } or null.
   */
  function pick(tag, state, { fill = {}, strict = false } = {}) {
    const tagged = byTag.get(tag) || [];
    let cands = tagged.map((line) => ({ line, w: line.weight }));
    if (!strict) {
      const genericW = tag === 'idle' ? 1 : tagged.length ? 0.35 : 1;
      for (const line of generic) if (!line.tags.includes(tag)) cands.push({ line, w: line.weight * genericW });
    }
    if (!cands.length) return null;
    const value = fillerFor(state, rng, fill);
    const usable = (c) => !needs(c.line) || (fillText(c.line.text, value) !== null && fillText(c.line.user, value) !== null);
    const blocked = new Set(history);
    let ok = cands.filter((c) => !blocked.has(c.line.i) && usable(c));
    if (!ok.length) {
      // Small pools: allow older lines again, but never the last few of this pool.
      const mine = new Set(cands.filter(usable).map((c) => c.line.i));
      const keep = Math.min(3, mine.size - 1);
      const last = new Set();
      for (let k = history.length - 1; k >= 0 && last.size < keep; k--) if (mine.has(history[k])) last.add(history[k]);
      ok = cands.filter((c) => !last.has(c.line.i) && usable(c));
    }
    const line = weighted(ok);
    if (!line) return null;
    remember(line.i);
    return { user: fillText(line.user, value), text: fillText(line.text, value), tag };
  }

  return {
    size: pool.length,
    pick,
    /** Calm line for the current scene. Returns { line, delayMs } (line may be null). */
    ambient(state) {
      const ctx = chatContext(state);
      let tag = ctx;
      let fill = {};
      if (afterglow && now() - afterglow.at < AFTERGLOW_MS && rng() < 0.35 * (1 - (now() - afterglow.at) / AFTERGLOW_MS)) {
        tag = afterglow.tag;
        fill = afterglow.fill;
      } else if (ctx !== 'idle' && rng() < 0.25) tag = 'idle'; // the audience also just talks
      const line = pick(tag, state, { fill }) || (tag !== ctx ? pick(ctx, state) : null);
      const [lo, hi] = AMBIENT_GAP_S[ctx] || AMBIENT_GAP_S.idle;
      return { line, delayMs: Math.round((lo + rng() * (hi - lo)) * 1000) };
    },
    /**
     * Reaction to one event: { key, lines: [{user,text,tag}], gapsMs: [..], viewers: pct|null }, or null.
     * gapsMs[i] = wait before line i (the first one comes quickly).
     */
    react(event, state) {
      const r = reactionFor(event);
      if (!r) return null;
      const spec = REACTIONS[r.key];
      const [lo, hi] = spec.burst;
      const n = Math.min(BURST_MAX, lo + Math.floor(rng() * (hi - lo + 1)));
      const out = [];
      for (let k = 0; k < n; k++) {
        const line = pick(spec.tag, state, { fill: r.fill, strict: true }) || (spec.alt ? pick(spec.alt, state, { fill: r.fill, strict: true }) : null);
        if (!line) break;
        out.push(line);
      }
      if (spec.burst[1] >= 2) afterglow = { tag: spec.tag, at: now(), fill: r.fill };
      const gapsMs = out.map((_, k) => Math.round(k === 0 ? 500 + rng() * 800 : BURST_GAP_MS[0] + rng() * (BURST_GAP_MS[1] - BURST_GAP_MS[0])));
      const viewers = spec.viewers ? spec.viewers[0] + rng() * (spec.viewers[1] - spec.viewers[0]) : null;
      return { key: r.key, lines: out, gapsMs, viewers, delayMs: r.delayMs ?? 0 };
    },
    history: () => [...history],
  };
}
