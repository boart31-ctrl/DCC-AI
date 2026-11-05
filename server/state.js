// Game state: pure reducers for every action + per-role view projection.
//
// reduce(state, action, ctx) never mutates `state`; it returns
//   { state, events: [{ event, to }], lines: [voiceLine], effects: [{ type, ... }], result }
// or throws ActionError. `to` is 'all' or { roles: [...], playerId? }.
// Voice lines: { priority, text, quipId|null, crit } — the server feeds them to the VoiceQueue.
import { makeToken, makeRoomCode, makePin } from './auth.js';
import { MODES, pickQuip, markQuipUsed, quipsLeft } from './quips.js';
import { STANDARD_CATEGORIES } from './pack.js';

export class ActionError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

const bad = (msg) => new ActionError('bad_request', msg);
const notFound = (msg) => new ActionError('not_found', msg);

export const FEED_SIZE = 30;
export const MAX_PLAYERS = 12;
export const HYPE_WINDOW_MS = 5 * 60_000;
export const HYPE_FULL = 0.5; // sum of recent viewer bumps (as fraction) that equals hype 1.0
export const MIN_VIEWERS = 50;
export const MAX_VIEWERS = 1e9;
const PALETTE = ['#ff7a00', '#33aaff', '#ff3355', '#44dd77', '#cc66ff', '#ffd23f', '#00d1c1', '#ff66aa'];
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const PIN_RE = /^\d{4}$/;

export function genId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------- state construction ----------

function newSession(pack, now, prev) {
  return {
    id: genId('s'),
    startedAt: now,
    mode: 'roleplay',
    auto: false,
    budgetLeft: pack.autoBudget,
    voice: prev?.voice && pack.voicesById.has(prev.voice) ? prev.voice : defaultVoiceId(pack),
  };
}

export function defaultVoiceId(pack) {
  return pack.voices[0]?.id ?? 'host';
}

export function createState(pack, now = Date.now()) {
  return {
    v: 1,
    room: makeRoomCode(),
    gmToken: makeToken(),
    stageToken: makeToken(),
    session: newSession(pack, now),
    players: [],
    audience: { viewers: pack.audience.startViewers, bumps: [], lastActivity: now, lastDecay: now },
    usedQuips: {},
    feed: [],
  };
}

function freshSheet(pack) {
  return {
    stats: Object.fromEntries(pack.stats.map((s) => [s.id, s.default])),
    resources: Object.fromEntries(pack.resources.map((r) => [r.id, { cur: r.default, max: r.default }])),
  };
}

/**
 * Repairs a loaded snapshot against the current pack (pack may have changed between runs):
 * fills missing fields, adds new stats/resources, keeps unknown ones (harmless, hidden by UI).
 */
export function normalizeState(raw, pack, now = Date.now()) {
  const base = createState(pack, now);
  if (!raw || typeof raw !== 'object') return base;
  const s = { ...base, ...raw };
  s.session = { ...base.session, ...(raw.session ?? {}) };
  if (!MODES.includes(s.session.mode)) s.session.mode = 'roleplay';
  if (!pack.voicesById.has(s.session.voice) && s.session.voice !== 'host') s.session.voice = defaultVoiceId(pack);
  s.audience = { ...base.audience, ...(raw.audience ?? {}) };
  if (!Array.isArray(s.audience.bumps)) s.audience.bumps = [];
  s.usedQuips = raw.usedQuips && typeof raw.usedQuips === 'object' ? raw.usedQuips : {};
  s.feed = Array.isArray(raw.feed) ? raw.feed.slice(-FEED_SIZE) : [];
  s.players = (Array.isArray(raw.players) ? raw.players : []).map((p, i) => {
    const sheet = freshSheet(pack);
    return {
      title: '', klass: '', race: '', gold: 0, notes: '', level: 1,
      color: PALETTE[i % PALETTE.length], inventory: [], achievements: [], secrets: [],
      ...p,
      stats: { ...sheet.stats, ...(p.stats ?? {}) },
      resources: { ...sheet.resources, ...(p.resources ?? {}) },
    };
  });
  return s;
}

// ---------- validation helpers ----------

function str(v, field, max, { optional = false, allowEmpty = false } = {}) {
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  const t = v.trim();
  if (!allowEmpty && !t) throw bad(`${field} must not be empty`);
  if (t.length > max) throw bad(`${field} too long (max ${max})`);
  return t;
}

function int(v, field, min, max, { optional = false } = {}) {
  if (v === undefined && optional) return undefined;
  if (!Number.isInteger(v) || v < min || v > max) throw bad(`${field} must be an integer ${min}..${max}`);
  return v;
}

function num(v, field, { optional = false } = {}) {
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e9) throw bad(`${field} must be a number`);
  return v;
}

function color(v, field, { optional = false } = {}) {
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'string' || !COLOR_RE.test(v)) throw bad(`${field} must be a #rrggbb color`);
  return v;
}

function playerOf(state, id) {
  if (typeof id !== 'string') throw bad('playerId required');
  const p = state.players.find((x) => x.id === id);
  if (!p) throw notFound(`no player ${id}`);
  return p;
}

function pinFree(state, pin, exceptId) {
  if (state.players.some((p) => p.pin === pin && p.id !== exceptId)) throw bad('PIN already used by another player');
}

// ---------- audience ----------

/** Hype 0..1 from recent bumps, each fading linearly over HYPE_WINDOW_MS. */
export function hypeOf(audience, now) {
  let sum = 0;
  for (const b of audience.bumps) {
    const age = now - b.at;
    if (age < HYPE_WINDOW_MS && age >= 0) sum += b.pct * (1 - age / HYPE_WINDOW_MS);
  }
  return Math.max(0, Math.min(1, sum / HYPE_FULL));
}

function clampViewers(v) {
  return Math.max(MIN_VIEWERS, Math.min(MAX_VIEWERS, Math.round(v)));
}

/** Bumps viewers by a fraction (0.1 = +10%). Returns the `viewers` event. */
function bumpPct(st, ctx, pct) {
  const a = st.audience;
  const before = a.viewers;
  a.viewers = clampViewers(before * (1 + pct));
  return recordBump(st, ctx, before);
}

function recordBump(st, ctx, before) {
  const a = st.audience;
  const delta = a.viewers - before;
  a.bumps = a.bumps.filter((b) => ctx.now - b.at < HYPE_WINDOW_MS);
  a.bumps.push({ at: ctx.now, pct: before ? delta / before : 0 });
  touch(st, ctx);
  return { kind: 'viewers', viewers: a.viewers, delta, _to: { roles: ['stage', 'gm'] } };
}

const randRange = (rng, lo, hi) => lo + rng() * (hi - lo);

function touch(st, ctx) {
  st.audience.lastActivity = ctx.now;
  st.audience.lastDecay = ctx.now;
}

// ---------- loot ----------

/** Weighted roll on a tier's loot table. Deterministic for a given rng. */
export function rollLoot(pack, tier, rng = Math.random) {
  const rows = pack.loot[tier] ?? [];
  const total = rows.reduce((s, r) => s + r.weight, 0);
  if (!total) return null;
  let x = rng() * total;
  for (const r of rows) {
    x -= r.weight;
    if (x < 0) return pack.itemsById.get(r.item);
  }
  return pack.itemsById.get(rows[rows.length - 1].item);
}

function invItem(item, ctx) {
  return {
    uid: ctx.genId('i'),
    itemId: item.id,
    name: item.name,
    desc: item.desc,
    rarity: item.rarity,
    image: item.image,
    at: ctx.now,
  };
}

function lootRoll(st, ctx, tier) {
  if (typeof tier !== 'string' || !ctx.pack.tiersById.has(tier)) throw notFound(`unknown loot tier ${tier}`);
  const item = rollLoot(ctx.pack, tier, ctx.rng);
  if (!item) throw notFound(`loot tier ${tier} is empty`);
  return item;
}

// ---------- voice lines ----------

function categoryLine(st, ctx, category, priority) {
  const r = pickQuip(ctx.pack, st.usedQuips, category, ctx.rng);
  if (!r) return null;
  st.usedQuips = r.used;
  return { priority, text: r.quip.text, quipId: r.quip.id, crit: false, category };
}

function quipLine(st, quip, priority) {
  st.usedQuips = markQuipUsed(st.usedQuips, quip);
  return { priority, text: quip.text, quipId: quip.id, crit: false, category: quip.category };
}

// ---------- reducers ----------

function feedPush(st, ev, text) {
  st.feed.push({ id: ev.id, at: ev.at, kind: ev.kind, playerId: ev.playerId, text });
  if (st.feed.length > FEED_SIZE) st.feed = st.feed.slice(-FEED_SIZE);
}

const GM = {
  'player.add'(st, a, ctx, out) {
    if (st.players.length >= MAX_PLAYERS) throw bad(`max ${MAX_PLAYERS} players`);
    const name = str(a.name, 'name', 40);
    const c = color(a.color, 'color', { optional: true }) ?? PALETTE[st.players.length % PALETTE.length];
    let pin = a.pin;
    if (pin !== undefined) {
      if (typeof pin !== 'string' || !PIN_RE.test(pin)) throw bad('pin must be 4 digits');
      pinFree(st, pin);
    } else {
      pin = makePin(st.players.map((p) => p.pin), ctx.randInt);
    }
    const p = {
      id: ctx.genId('p'), name, color: c, level: 1, pin,
      title: '', klass: '', race: '', gold: 0, notes: '',
      ...freshSheet(ctx.pack),
      inventory: [], achievements: [], secrets: [],
    };
    st.players.push(p);
    out.result = { playerId: p.id, pin };
  },

  'player.update'(st, a, ctx) {
    const p = playerOf(st, a.playerId);
    const patch = {
      name: str(a.name, 'name', 40, { optional: true }),
      color: color(a.color, 'color', { optional: true }),
      level: int(a.level, 'level', 0, 9999, { optional: true }),
      title: str(a.title, 'title', 60, { optional: true, allowEmpty: true }),
      klass: str(a.klass, 'klass', 40, { optional: true, allowEmpty: true }),
      race: str(a.race, 'race', 40, { optional: true, allowEmpty: true }),
      gold: int(a.gold, 'gold', 0, 1e9, { optional: true }),
      notes: a.notes === undefined ? undefined : notesText(a.notes),
    };
    if (a.pin !== undefined) {
      if (typeof a.pin !== 'string' || !PIN_RE.test(a.pin)) throw bad('pin must be 4 digits');
      pinFree(st, a.pin, p.id);
      patch.pin = a.pin;
    }
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) p[k] = v;
  },

  'player.stat'(st, a, ctx, out) {
    const p = playerOf(st, a.playerId);
    if (typeof a.stat !== 'string' || !ctx.pack.statsById.has(a.stat)) throw notFound(`unknown stat ${a.stat}`);
    const value = num(a.value, 'value', { optional: true });
    const delta = num(a.delta, 'delta', { optional: true });
    if ((value === undefined) === (delta === undefined)) throw bad('give exactly one of value or delta');
    const from = p.stats[a.stat] ?? 0;
    const to = value ?? from + delta;
    p.stats[a.stat] = to;
    if (to !== from) out.emit({ kind: 'stat', playerId: p.id, stat: a.stat, from, to }, { roles: ['gm', 'stage'], playerId: p.id });
  },

  'player.resource'(st, a, ctx, out) {
    const p = playerOf(st, a.playerId);
    if (typeof a.res !== 'string' || !ctx.pack.resourcesById.has(a.res)) throw notFound(`unknown resource ${a.res}`);
    const max = num(a.max, 'max', { optional: true });
    const cur = num(a.cur, 'cur', { optional: true });
    const delta = num(a.delta, 'delta', { optional: true });
    if (max === undefined && cur === undefined && delta === undefined) throw bad('give cur, max or delta');
    if (max !== undefined && max < 0) throw bad('max must be >= 0');
    const r = { ...(p.resources[a.res] ?? { cur: 0, max: 0 }) };
    const from = r.cur;
    if (max !== undefined) r.max = max;
    if (cur !== undefined) r.cur = cur;
    if (delta !== undefined) r.cur += delta;
    r.cur = Math.max(0, Math.min(r.max, r.cur));
    p.resources[a.res] = r;
    if (r.cur !== from) {
      out.emit({ kind: 'stat', playerId: p.id, stat: a.res, resource: true, from, to: r.cur, max: r.max }, { roles: ['gm', 'stage'], playerId: p.id });
    }
  },

  'player.remove'(st, a) {
    const p = playerOf(st, a.playerId);
    st.players = st.players.filter((x) => x !== p);
  },

  'ach.award'(st, a, ctx, out) {
    const p = playerOf(st, a.playerId);
    let ach;
    if (a.achId !== undefined) {
      ach = ctx.pack.achievementsById.get(a.achId);
      if (!ach) throw notFound(`unknown achievement ${a.achId}`);
    } else {
      ach = {
        id: null,
        title: str(a.title, 'title', 80),
        desc: str(a.desc, 'desc', 300, { optional: true, allowEmpty: true }) ?? '',
        voice: null,
      };
    }
    p.achievements.push({ uid: ctx.genId('a'), achId: ach.id, title: ach.title, desc: ach.desc, at: ctx.now });
    const ev = out.emit({ kind: 'achievement', playerId: p.id, title: ach.title, desc: ach.desc }, 'all');
    feedPush(st, ev, `${p.name} earned "${ach.title}"`);
    out.emit(bumpPct(st, ctx, randRange(ctx.rng, 0.05, 0.15)));
    const voiced = ach.voice && ctx.pack.quipsById.get(ach.voice);
    const line = voiced
      ? quipLine(st, voiced, 1)
      : categoryLine(st, ctx, 'achievement', 1) ?? { priority: 1, text: `New achievement. ${ach.title}.`, quipId: null, crit: false };
    out.lines.push(line);
  },

  'loot.open'(st, a, ctx, out) {
    const p = playerOf(st, a.playerId);
    const item = lootRoll(st, ctx, a.tier);
    const inv = invItem(item, ctx);
    p.inventory.push(inv);
    const ev = out.emit({ kind: 'loot', playerId: p.id, tier: a.tier, item: inv }, 'all');
    feedPush(st, ev, `${p.name} opened a ${ctx.pack.tiersById.get(a.tier).name}: ${item.name}`);
    out.emit(bumpPct(st, ctx, randRange(ctx.rng, 0.03, 0.08)));
    const line = categoryLine(st, ctx, 'loot', 1);
    if (line) out.lines.push(line);
    out.result = { uid: inv.uid, itemId: item.id };
  },

  'sponsor.box'(st, a, ctx, out) {
    const p = playerOf(st, a.playerId);
    const tier = a.tier ?? ctx.pack.lootTiers[ctx.pack.lootTiers.length - 1]?.id;
    const sponsor = str(a.sponsor, 'sponsor', 60, { optional: true }) ?? 'A Mysterious Sponsor';
    const item = lootRoll(st, ctx, tier);
    const inv = invItem(item, ctx);
    p.inventory.push(inv);
    const ev = out.emit({ kind: 'sponsor', playerId: p.id, sponsor, tier, item: inv }, 'all');
    feedPush(st, ev, `${sponsor} sent ${p.name}: ${item.name}`);
    out.emit(bumpPct(st, ctx, 0.1));
    const line = categoryLine(st, ctx, 'sponsor', 1);
    if (line) out.lines.push(line);
    out.result = { uid: inv.uid, itemId: item.id };
  },

  'item.give'(st, a, ctx, out) {
    const p = playerOf(st, a.playerId);
    const item = ctx.pack.itemsById.get(a.itemId);
    if (!item) throw notFound(`unknown item ${a.itemId}`);
    const inv = invItem(item, ctx);
    p.inventory.push(inv);
    out.result = { uid: inv.uid };
  },

  'item.remove'(st, a) {
    const p = playerOf(st, a.playerId);
    const before = p.inventory.length;
    p.inventory = p.inventory.filter((i) => i.uid !== a.uid);
    if (p.inventory.length === before) throw notFound(`no item ${a.uid}`);
  },

  'quip.play'(st, a, ctx, out) {
    let line;
    if (a.quipId !== undefined) {
      const q = ctx.pack.quipsById.get(a.quipId);
      if (!q) throw notFound(`unknown quip ${a.quipId}`);
      line = quipLine(st, q, 0);
    } else {
      if (typeof a.category !== 'string') throw bad('category or quipId required');
      line = categoryLine(st, ctx, a.category, 0);
      if (!line) throw notFound(`no quips in category ${a.category}`);
    }
    out.lines.push(line);
    touch(st, ctx);
  },

  say(st, a, ctx, out) {
    out.lines.push({ priority: 0, text: str(a.text, 'text', 500), quipId: null, crit: false });
    touch(st, ctx);
  },

  'secret.send'(st, a, ctx, out) {
    const p = playerOf(st, a.playerId);
    const msg = {
      id: ctx.genId('m'),
      at: ctx.now,
      from: str(a.from, 'from', 60, { optional: true }) ?? ctx.pack.systemName,
      text: str(a.text, 'text', 1000),
      read: false,
    };
    p.secrets.push(msg);
    out.emit({ kind: 'secret', playerId: p.id }, { roles: ['gm'], playerId: p.id });
    out.result = { id: msg.id };
  },

  'audience.bump'(st, a, ctx, out) {
    const delta = int(a.delta, 'delta', -MAX_VIEWERS, MAX_VIEWERS);
    const before = st.audience.viewers;
    st.audience.viewers = clampViewers(before + delta);
    out.emit(recordBump(st, ctx, before));
  },

  'session.mode'(st, a) {
    if (!MODES.includes(a.mode)) throw bad(`mode must be one of ${MODES.join(', ')}`);
    st.session.mode = a.mode;
  },

  'session.auto'(st, a, ctx, out) {
    if (typeof a.on !== 'boolean') throw bad('on must be a boolean');
    st.session.auto = a.on;
    if (!a.on) out.effects.push({ type: 'clearPending' });
  },

  'session.budget'(st, a) {
    st.session.budgetLeft = int(a.value, 'value', 0, 999);
  },

  'session.voice'(st, a, ctx) {
    const ok = ctx.pack.voicesById.has(a.voice) || (a.voice === 'host' && !ctx.pack.voices.length);
    if (typeof a.voice !== 'string' || !ok) throw notFound(`unknown voice ${a.voice}`);
    st.session.voice = a.voice;
  },

  'session.new'(st, a, ctx, out) {
    out.effects.push({ type: 'archive', session: st.session });
    st.session = newSession(ctx.pack, ctx.now, st.session);
    st.usedQuips = {};
    st.feed = [];
    st.audience.bumps = [];
    touch(st, ctx);
    out.effects.push({ type: 'queueClear' });
  },
};

function notesText(v) {
  if (typeof v !== 'string') throw bad('notes must be a string');
  if (v.length > 2000) throw bad('notes too long (max 2000)');
  return v;
}

const PLAYER = {
  'secret.read'(st, a) {
    const p = playerOf(st, a.actorId);
    const m = p.secrets.find((s) => s.id === a.id);
    if (!m) throw notFound(`no secret ${a.id}`);
    m.read = true;
  },
  'me.notes'(st, a) {
    playerOf(st, a.actorId).notes = notesText(a.text);
  },
};

// Internal actions dispatched by the server itself (never accepted from a socket).
const SYSTEM = {
  'budget.consume'(st) {
    st.session.budgetLeft = Math.max(0, st.session.budgetLeft - 1);
  },
  /** Quiet decay: −1% per full minute without activity. */
  'audience.tick'(st, a, ctx, out) {
    const au = st.audience;
    if (ctx.now - au.lastActivity < 60_000) return;
    const minutes = Math.floor((ctx.now - au.lastDecay) / 60_000);
    if (minutes < 1) return;
    au.viewers = clampViewers(au.viewers * 0.99 ** minutes);
    au.lastDecay += minutes * 60_000;
    au.bumps = au.bumps.filter((b) => ctx.now - b.at < HYPE_WINDOW_MS);
    out.changed = true;
  },
};

export const GM_ACTIONS = Object.keys(GM);
export const PLAYER_ACTIONS = Object.keys(PLAYER);

/** Applies one action. `action.role` selects the action table ('gm' | 'player' | 'system'). */
export function reduce(state, action, ctx) {
  const table = action.role === 'gm' ? GM : action.role === 'player' ? PLAYER : action.role === 'system' ? SYSTEM : null;
  const fn = table && Object.hasOwn(table, action.t) ? table[action.t] : null;
  if (!fn) throw bad(`unknown action ${action.t} for role ${action.role}`);
  const full = {
    rng: Math.random,
    randInt: (n) => Math.floor(Math.random() * n),
    genId,
    now: Date.now(),
    ...ctx,
  };
  const st = structuredClone(state);
  const out = {
    events: [],
    lines: [],
    effects: [],
    result: undefined,
    changed: true,
    emit(ev, to) {
      const { _to, ...rest } = ev;
      const event = { id: full.genId('e'), at: full.now, ...rest };
      out.events.push({ event, to: to ?? _to ?? 'all' });
      return event;
    },
  };
  if (action.role === 'system') out.changed = false;
  fn(st, action, full, out);
  return {
    state: out.changed ? st : state,
    changed: out.changed,
    events: out.events,
    lines: out.lines,
    effects: out.effects,
    result: out.result,
  };
}

// ---------- views ----------

const CATEGORY_LABELS = { nat1: 'Nat 1', nat20: 'Nat 20', levelup: 'Level up' };
const categoryLabel = (id) => CATEGORY_LABELS[id] ?? (id.charAt(0).toUpperCase() + id.slice(1)).replace(/_/g, ' ');

function fullPlayer(p) {
  return {
    id: p.id, name: p.name, color: p.color, level: p.level,
    title: p.title, klass: p.klass, race: p.race,
    stats: p.stats, resources: p.resources, gold: p.gold, notes: p.notes,
    inventory: p.inventory, achievements: p.achievements, secrets: p.secrets,
  };
}

function common(state, pack, opts) {
  const { session: s, audience: a } = state;
  return {
    room: state.room,
    session: { id: s.id, startedAt: s.startedAt, mode: s.mode, auto: s.auto, budgetLeft: s.budgetLeft, voice: s.voice },
    pack: {
      id: pack.id,
      name: pack.name,
      version: pack.version,
      systemName: pack.systemName,
      lootTiers: pack.lootTiers,
      stats: pack.stats.map(({ id, label, abbr }) => ({ id, label, abbr })),
      resources: pack.resources.map(({ id, label, color }) => ({ id, label, color })),
      voices: pack.voices,
    },
    audience: { viewers: a.viewers, hype: Math.round(hypeOf(a, opts.now) * 100) / 100 },
    feed: state.feed,
    players: state.players.map((p) => ({
      id: p.id, name: p.name, color: p.color, level: p.level,
      achievementCount: p.achievements.length,
      connected: opts.connected?.has(p.id) ?? false,
    })),
  };
}

/**
 * Role-filtered snapshot. opts: { now, connected:Set<playerId>, playerId, urls:{join,stage,gm},
 * queue:{queue,pendingAuto,playing}, aiAvailable, aiCallsLeft }
 */
export function viewFor(state, pack, role, opts = {}) {
  const now = opts.now ?? Date.now();
  const v = common(state, pack, { ...opts, now });
  const q = opts.queue ?? { queue: [], pendingAuto: [], playing: null };
  if (role === 'player') {
    const p = state.players.find((x) => x.id === opts.playerId);
    v.me = p ? fullPlayer(p) : null;
  } else if (role === 'stage') {
    v.joinUrl = opts.urls?.join ?? '';
    v.queueLength = q.queue.length + (q.playing ? 1 : 0);
  } else if (role === 'gm') {
    const cats = [...new Set([...STANDARD_CATEGORIES, ...pack.quipsByCategory.keys()])];
    v.gm = {
      joinUrl: opts.urls?.join ?? '',
      stageUrl: opts.urls?.stage ?? '',
      gmUrl: opts.urls?.gm ?? '',
      pins: Object.fromEntries(state.players.map((p) => [p.id, p.pin])),
      playersFull: state.players.map(fullPlayer),
      quipCategories: cats.map((id) => ({
        id,
        label: categoryLabel(id),
        left: quipsLeft(pack, state.usedQuips, id),
        total: pack.quipsByCategory.get(id)?.length ?? 0,
      })),
      achievementsCatalog: pack.achievements.map(({ id, title, desc }) => ({ id, title, desc })),
      itemsCatalog: pack.items.map(({ id, name, rarity }) => ({ id, name, rarity })),
      pendingAuto: q.pendingAuto,
      queue: q.queue,
      playing: q.playing,
      aiAvailable: !!opts.aiAvailable,
      aiCallsLeft: opts.aiCallsLeft ?? 0,
      sponsorReady: hypeOf(state.audience, now) >= pack.audience.sponsorHypeThreshold,
    };
  }
  return v;
}
