// Game state: pure reducers for every action + per-role view projection.
//
// reduce(state, action, ctx) never mutates `state`; it returns
//   { state, events: [{ event, to }], lines: [voiceLine], effects: [{ type, ... }], result }
// or throws ActionError. `to` is 'all' or { roles: [...], playerId? }.
// Voice lines: { priority, text, quipId|null, crit } — the server feeds them to the VoiceQueue.
import { makeToken, makeRoomCode, makePin, randInt, genId } from './random.js';
import { MODES, pickQuip, markQuipUsed, quipsLeft } from './quips.js';
import { STANDARD_CATEGORIES } from './constants.js';
import { ActionError, bad, notFound } from './errors.js';
import { SCENE_GM, initScene, initShow, normalizeScene, normalizeShow, sceneView, showView } from './scenes.js';
import { COMBAT_GM, initCombat, normalizeCombat, combatView } from './combat.js';
import { AUTO_GM, MAX_COMBAT_LOG } from './combat-auto.js';
import { LOOT_GM, normalizeDrops } from './loot.js';
import {
  SHEET, SHEET_GM, normalizeLibArt, freshSheet, migrateSheet, migrateInventory, giveItem, emptyHomebrew, normalizeHomebrew, libraryOf,
  sheetView, legacyStats, computeFor, enrichInventory, playerLibrary, gmLibrary, rollsFor, requireNotes, setTrack, PLAYER_EDIT, MAX_ROLLS,
} from './character.js';

export { genId, ActionError };

export const FEED_SIZE = 30;
export const MAX_PREP_CARDS = 100;
export const MAX_RECAP = 4000;
export const PREP_KINDS = { achievement: 'ach.award', loot: 'loot.open', message: 'msg.send', line: 'say' };
export const MAX_MESSAGES = 200;
export const GM_MESSAGES = 50;
export const MAX_PLAYERS = 12;
export const HYPE_WINDOW_MS = 5 * 60_000;
export const HYPE_FULL = 0.5; // sum of recent viewer bumps (as fraction) that equals hype 1.0
export const MIN_VIEWERS = 50;
export const MAX_VIEWERS = 1e9;
const PALETTE = ['#ff7a00', '#33aaff', '#ff3355', '#44dd77', '#cc66ff', '#ffd23f', '#00d1c1', '#ff66aa'];
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const PIN_RE = /^\d{4}$/;


// ---------- state construction ----------

function newSession(pack, now, prev) {
  return {
    id: genId('s'),
    startedAt: now,
    mode: 'roleplay',
    auto: false,
    aiMute: !!prev?.aiMute, // Mute AI: no System voice audio, no audience chat, no AUTO (survives a new session)
    budgetLeft: pack.autoBudget,
    voice: prev?.voice && pack.voicesById.has(prev.voice) ? prev.voice : defaultVoiceId(pack),
    recap: '',
    permissions: { playerEdit: PLAYER_EDIT.includes(prev?.permissions?.playerEdit) ? prev.permissions.playerEdit : 'sheet' },
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
    messages: [],
    prepCards: [],
    library: emptyHomebrew(),
    libArt: normalizeLibArt(null),
    rolls: [],
    scene: initScene(now), // scenes.js
    combat: initCombat(), // combat.js
    combatLog: [], // combat-auto.js: one summary per finished fight (this session), for the recap
    drops: [], // loot.js: piles from looted bodies, handed out by the GM
    show: initShow(),
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
  s.messages = Array.isArray(raw.messages) ? raw.messages : [];
  s.prepCards = Array.isArray(raw.prepCards) ? raw.prepCards : [];
  if (typeof s.session.recap !== 'string') s.session.recap = '';
  s.session.aiMute = s.session.aiMute === true;
  if (!PLAYER_EDIT.includes(s.session.permissions?.playerEdit)) s.session.permissions = { playerEdit: 'sheet' };
  s.library = normalizeHomebrew(raw.library);
  s.libArt = normalizeLibArt(raw.libArt);
  s.rolls = Array.isArray(raw.rolls) ? raw.rolls.filter((r) => r && typeof r === 'object').slice(-MAX_ROLLS) : [];
  s.scene = normalizeScene(raw.scene, now);
  s.show = normalizeShow(raw.show);
  s.combat = normalizeCombat(raw.combat);
  s.drops = normalizeDrops(raw.drops);
  s.combatLog = Array.isArray(raw.combatLog) ? raw.combatLog.filter((x) => x && typeof x === 'object').slice(-MAX_COMBAT_LOG) : [];
  s.players = (Array.isArray(raw.players) ? raw.players : []).map((p, i) => {
    // Pre-messaging saves stored private messages on the player; move them into state.messages.
    // Pre-v2 saves keep flat `stats` numbers and `resources`; they move into `sheet` (RULESET §5).
    const { secrets, stats, resources, ...rest } = p;
    for (const m of Array.isArray(secrets) ? secrets : []) {
      if (s.messages.some((x) => x.id === m.id)) continue;
      s.messages.push({ id: m.id, at: m.at ?? 0, from: m.from ?? pack.systemName, text: m.text ?? '', to: [p.id], onStage: false, readBy: m.read ? [p.id] : [] });
    }
    return {
      title: '', klass: '', race: '', gold: 0, notes: '', level: 1, userId: null,
      color: PALETTE[i % PALETTE.length], inventory: [], achievements: [],
      ...rest,
      inventory: migrateInventory(p.inventory, pack.ruleset),
      sheet: migrateSheet(p.sheet, { stats, resources }, pack.ruleset),
    };
  });
  s.messages.sort((a, b) => a.at - b.at);
  s.messages = s.messages.slice(-MAX_MESSAGES);
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

/** Validates a hosted-edition user id: string ≤ 64 (unique) or null to unassign. */
function userIdOf(state, v, exceptId) {
  if (v === null) return null;
  const id = str(v, 'userId', 64);
  if (state.players.some((p) => p.userId === id && p.id !== exceptId)) throw bad('userId already assigned to another player');
  return id;
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
    const userId = a.userId === undefined ? null : userIdOf(st, a.userId);
    const p = {
      id: ctx.genId('p'), name, color: c, level: 1, pin, userId,
      title: '', klass: '', race: '', gold: 0, notes: '',
      sheet: freshSheet(ctx.pack.ruleset),
      inventory: [], achievements: [],
    };
    // Formula-based track maxima (e.g. "10 + mod.con") start full.
    const { computed } = computeFor(p, ctx.pack, libraryOf(st, ctx.pack));
    for (const t of ctx.pack.ruleset.tracks) if (t.maxFormula) p.sheet.tracks[t.id] = { cur: computed.tracks[t.id].max, max: computed.tracks[t.id].max };
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
    if (a.userId !== undefined) p.userId = userIdOf(st, a.userId, p.id);
  },

  'player.stat'(st, a, ctx, out) {
    const p = playerOf(st, a.playerId);
    if (typeof a.stat !== 'string' || !ctx.pack.statsById.has(a.stat)) throw notFound(`unknown stat ${a.stat}`);
    const value = num(a.value, 'value', { optional: true });
    const delta = num(a.delta, 'delta', { optional: true });
    if ((value === undefined) === (delta === undefined)) throw bad('give exactly one of value or delta');
    const rs = ctx.pack.ruleset;
    const def = rs.stats.find((x) => x.id === a.stat);
    const part = def.parts.includes(rs.statMod.from) ? rs.statMod.from : def.parts[0];
    const from = p.sheet.stats[a.stat]?.[part] ?? 0;
    const to = value ?? from + delta;
    p.sheet.stats[a.stat] = { ...p.sheet.stats[a.stat], [part]: to };
    if (to !== from) out.emit({ kind: 'stat', playerId: p.id, stat: a.stat, from, to }, { roles: ['gm', 'stage'], playerId: p.id });
  },

  'player.resource'(st, a, ctx, out) {
    const p = playerOf(st, a.playerId);
    if (typeof a.res !== 'string' || !ctx.pack.resourcesById.has(a.res)) throw notFound(`unknown resource ${a.res}`);
    // Legacy alias of track.set (clamps 0..max, max includes effects).
    setTrack(st, p, { track: a.res, cur: a.cur, max: a.max, delta: a.delta }, ctx, out);
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
        reward: str(a.reward, 'reward', 200, { optional: true, allowEmpty: true }) ?? '',
        group: '',
        voice: null,
      };
    }
    const rec = { uid: ctx.genId('a'), achId: ach.id, title: ach.title, desc: ach.desc, reward: ach.reward, group: ach.group, at: ctx.now };
    p.achievements.push(rec);
    const ev = out.emit(
      { kind: 'achievement', playerId: p.id, achId: ach.id, title: ach.title, desc: ach.desc, reward: ach.reward, group: ach.group },
      'all',
    );
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
    const item = libraryOf(st, ctx.pack).get('item', lootRoll(st, ctx, a.tier).id);
    const inv = giveItem(p, item, ctx);
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
    const item = libraryOf(st, ctx.pack).get('item', lootRoll(st, ctx, tier).id);
    const inv = giveItem(p, item, ctx);
    const ev = out.emit({ kind: 'sponsor', playerId: p.id, sponsor, tier, item: inv }, 'all');
    feedPush(st, ev, `${sponsor} sent ${p.name}: ${item.name}`);
    out.emit(bumpPct(st, ctx, 0.1));
    const line = categoryLine(st, ctx, 'sponsor', 1);
    if (line) out.lines.push(line);
    out.result = { uid: inv.uid, itemId: item.id };
  },

  'item.give'(st, a, ctx, out) {
    const p = playerOf(st, a.playerId);
    const item = libraryOf(st, ctx.pack).get('item', a.itemId);
    if (!item) throw notFound(`unknown item ${a.itemId}`);
    const qty = int(a.qty, 'qty', 1, 9999, { optional: true }) ?? 1;
    const inv = giveItem(p, item, ctx, qty);
    out.result = { uid: inv.uid };
  },

  'item.remove'(st, a) {
    const p = playerOf(st, a.playerId);
    const before = p.inventory.length;
    p.inventory = p.inventory.filter((i) => i.uid !== a.uid);
    if (p.inventory.length === before) throw notFound(`no item ${a.uid}`);
    p.sheet.hotlist = p.sheet.hotlist.map((x) => (x === a.uid ? null : x));
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

  'msg.send'(st, a, ctx, out) {
    let to;
    if (a.to === 'all') to = 'all';
    else if (Array.isArray(a.to) && a.to.length && a.to.length <= MAX_PLAYERS) {
      to = [...new Set(a.to)].map((id) => playerOf(st, id).id);
    } else throw bad("to must be 'all' or a non-empty array of playerIds");
    if (a.onStage !== undefined && typeof a.onStage !== 'boolean') throw bad('onStage must be a boolean');
    const msg = {
      id: ctx.genId('m'),
      at: ctx.now,
      from: str(a.from, 'from', 60, { optional: true }) ?? ctx.pack.systemName,
      text: str(a.text, 'text', 1000),
      to,
      onStage: !!a.onStage && isGroup(to),
      readBy: [],
    };
    st.messages.push(msg);
    if (st.messages.length > MAX_MESSAGES) st.messages = st.messages.slice(-MAX_MESSAGES);
    const group = isGroup(to);
    const recipients = to === 'all' ? { roles: ['gm', 'player'] } : { roles: ['gm'], playerIds: to };
    out.emit({ kind: 'message', id: msg.id, group, from: msg.from, to }, recipients);
    // The message id doubles as the event envelope id (it is unique per send).
    // Legacy event kept for clients written against the original `secret.send` protocol.
    if (!group) out.emit({ kind: 'secret', playerId: to[0], messageId: msg.id }, { roles: ['gm'], playerId: to[0] });
    if (msg.onStage) out.emit({ kind: 'announcement', messageId: msg.id, from: msg.from, text: msg.text }, { roles: ['stage'] });
    out.result = { id: msg.id };
  },

  'secret.send'(st, a, ctx, out) {
    if (typeof a.playerId !== 'string') throw bad('playerId required');
    GM['msg.send'](st, { to: [a.playerId], text: a.text, from: a.from }, ctx, out);
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
    if (a.on && st.session.aiMute) throw bad('AI is muted: unmute it first');
    st.session.auto = a.on;
    if (!a.on) out.effects.push({ type: 'clearPending' });
  },

  /** Mute AI: the System's lines stay as on-screen text only, the audience chat stops, AUTO goes off. */
  'session.aiMute'(st, a, ctx, out) {
    if (typeof a.on !== 'boolean') throw bad('on must be a boolean');
    st.session.aiMute = a.on;
    if (a.on && st.session.auto) {
      st.session.auto = false;
      out.effects.push({ type: 'clearPending' });
    }
  },

  'session.budget'(st, a) {
    st.session.budgetLeft = int(a.value, 'value', 0, 999);
  },

  'session.voice'(st, a, ctx) {
    const ok = ctx.pack.voicesById.has(a.voice) || (a.voice === 'host' && !ctx.pack.voices.length);
    if (typeof a.voice !== 'string' || !ok) throw notFound(`unknown voice ${a.voice}`);
    st.session.voice = a.voice;
  },

  'session.recap'(st, a) {
    if (typeof a.text !== 'string') throw bad('text must be a string');
    if (a.text.length > MAX_RECAP) throw bad(`text too long (max ${MAX_RECAP})`);
    st.session.recap = a.text.trim();
  },

  'prep.card.add'(st, a, ctx, out) {
    if (!Object.hasOwn(PREP_KINDS, a.kind)) throw bad(`kind must be one of ${Object.keys(PREP_KINDS).join(', ')}`);
    if (!a.payload || typeof a.payload !== 'object' || Array.isArray(a.payload)) throw bad('payload must be an object');
    const { t, role, rid, ...payload } = a.payload; // payload can never smuggle in another action
    if (JSON.stringify(payload).length > 4000) throw bad('payload too large');
    if (st.prepCards.length >= MAX_PREP_CARDS) throw bad(`max ${MAX_PREP_CARDS} prepared cards`);
    const card = {
      id: ctx.genId('c'),
      kind: a.kind,
      label: str(a.label, 'label', 80, { optional: true }) ?? a.kind,
      payload,
      createdAt: ctx.now,
      used: false,
      usedAt: null,
    };
    st.prepCards.push(card);
    out.result = { id: card.id };
  },

  'prep.card.remove'(st, a) {
    const before = st.prepCards.length;
    st.prepCards = st.prepCards.filter((c) => c.id !== a.id);
    if (st.prepCards.length === before) throw notFound(`no prepared card ${a.id}`);
  },

  /**
   * Runs the card's action with its stored payload. `playerId` / `to` on the fire action override
   * the payload (cards are often prepared before the GM knows who earns them). Re-firing is allowed.
   */
  'prep.card.fire'(st, a, ctx, out) {
    const card = st.prepCards.find((c) => c.id === a.id);
    if (!card) throw notFound(`no prepared card ${a.id}`);
    const t = PREP_KINDS[card.kind];
    const action = { ...card.payload, t, role: 'gm' };
    if (a.playerId !== undefined) action.playerId = a.playerId;
    if (a.to !== undefined) action.to = a.to;
    GM[t](st, action, ctx, out);
    card.used = true;
    card.usedAt = ctx.now;
    out.result = { ...(out.result ?? {}), cardId: card.id, action: t };
  },

  'session.new'(st, a, ctx, out) {
    out.effects.push({ type: 'archive', session: st.session });
    st.session = newSession(ctx.pack, ctx.now, st.session);
    st.usedQuips = {};
    st.feed = [];
    st.rolls = [];
    st.combatLog = [];
    st.drops = [];
    st.audience.bumps = [];
    touch(st, ctx);
    out.effects.push({ type: 'queueClear' });
  },
};

// Group = everyone, or more than one named recipient.
function isGroup(to) {
  return to === 'all' || to.length > 1;
}

function addressedTo(m, playerId) {
  return m.to === 'all' || m.to.includes(playerId);
}

function notesText(v) {
  if (typeof v !== 'string') throw bad('notes must be a string');
  if (v.length > 2000) throw bad('notes too long (max 2000)');
  return v;
}

const PLAYER = {
  'secret.read'(st, a) {
    const p = playerOf(st, a.actorId);
    const m = st.messages.find((x) => x.id === a.id && addressedTo(x, p.id));
    if (!m) throw notFound(`no message ${a.id}`);
    if (!m.readBy.includes(p.id)) m.readBy.push(p.id);
  },
  'me.notes'(st, a, ctx) {
    requireNotes(st, ctx);
    playerOf(st, a.actorId).notes = notesText(a.text);
  },
};

// v2 sheet actions: GM gets all; players get the SHEET table (permission-checked per action).
Object.assign(GM, SHEET, SHEET_GM, SCENE_GM, COMBAT_GM, AUTO_GM, LOOT_GM);
for (const [k, fn] of Object.entries(SHEET)) PLAYER[k] = fn;

// Internal actions dispatched by the server itself (never accepted from a socket).
const SYSTEM = {
  'budget.consume'(st) {
    st.session.budgetLeft = Math.max(0, st.session.budgetLeft - 1);
  },
  /** The audience reacts to a big moment on the TV (host.js, chat.js REACTIONS): +pct viewers. */
  'audience.react'(st, a, ctx, out) {
    const pct = Number(a.pct);
    if (!Number.isFinite(pct) || pct === 0) return;
    out.emit(bumpPct(st, ctx, Math.max(-0.2, Math.min(0.3, pct))));
    out.changed = true;
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

/**
 * Host entry point for actions sent by a player (Node server socket or hosted-edition room relay).
 * `playerId` is the authenticated player; any role/actorId in the payload is discarded, and a payload
 * `playerId` that differs from it is rejected ('forbidden').
 *   reducePlayerAction(state, action, { playerId, pack, now?, randInt?, rng?, genId? }) → same as reduce()
 */
export function reducePlayerAction(state, action, ctx) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw bad('action must be an object');
  if (typeof ctx?.playerId !== 'string') throw bad('reducePlayerAction: ctx.playerId required');
  const { role, actorId, rid, ...a } = action;
  const { playerId, ...rest } = ctx;
  return reduce(state, { ...a, role: 'player', actorId: playerId }, rest);
}

/** Applies one action. `action.role` selects the action table ('gm' | 'player' | 'system'). */
export function reduce(state, action, ctx) {
  const table = action.role === 'gm' ? GM : action.role === 'player' ? PLAYER : action.role === 'system' ? SYSTEM : null;
  const fn = table && Object.hasOwn(table, action.t) ? table[action.t] : null;
  if (!fn) throw bad(`unknown action ${action.t} for role ${action.role}`);
  const full = {
    rng: Math.random,
    randInt,
    genId,
    now: Date.now(),
    ...ctx,
    // Who is acting: never taken from the payload for players (actorId is set by the host).
    actor: { role: action.role, playerId: action.role === 'player' ? action.actorId : null },
    h: { feedPush, categoryLine, bumpPct },
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

function messagesFor(state, playerId) {
  return state.messages
    .filter((m) => addressedTo(m, playerId))
    .map((m) => ({ id: m.id, at: m.at, from: m.from, text: m.text, group: isGroup(m.to), read: m.readBy.includes(playerId) }));
}

function fullPlayer(state, p, pack, library) {
  const messages = messagesFor(state, p.id);
  const sheet = sheetView(p, pack, library);
  const { stats, resources } = legacyStats(p, pack, sheet.computed);
  return {
    id: p.id, name: p.name, color: p.color, level: p.level,
    title: p.title, klass: p.klass, race: p.race,
    stats, resources, gold: p.gold, notes: p.notes,
    inventory: enrichInventory(p.inventory, library), achievements: p.achievements,
    sheet,
    secrets: messages.filter((m) => !m.group).map(({ group, ...m }) => m),
    messages,
  };
}

function common(state, pack, opts) {
  const { session: s, audience: a } = state;
  return {
    room: state.room,
    session: {
      id: s.id, startedAt: s.startedAt, mode: s.mode, auto: s.auto, aiMute: !!s.aiMute, budgetLeft: s.budgetLeft, voice: s.voice,
      permissions: { playerEdit: s.permissions?.playerEdit ?? 'sheet' },
    },
    pack: {
      id: pack.id,
      name: pack.name,
      version: pack.version,
      systemName: pack.systemName,
      notifyPrefix: pack.notifyPrefix ?? '',
      lootTiers: pack.lootTiers,
      stats: pack.stats.map(({ id, label, abbr }) => ({ id, label, abbr })),
      resources: pack.resources.map(({ id, label, color }) => ({ id, label, color })),
      voices: pack.voices,
      ruleset: pack.ruleset,
      theme: pack.theme ?? null,
      ui: pack.ui ?? null, // ui.json art (URLs only); the UI falls back to its CSS look per missing asset
    },
    audience: { viewers: a.viewers, hype: Math.round(hypeOf(a, opts.now) * 100) / 100 },
    feed: state.feed,
    recap: s.recap ?? '',
    scene: sceneView(state, pack, opts.now),
    show: showView(state),
    players: state.players.map((p) => ({
      id: p.id, name: p.name, color: p.color, level: p.level,
      achievementCount: p.achievements.length,
      connected: opts.connected?.has(p.id) ?? false,
      portrait: p.sheet?.portrait ?? null, // host.js swaps data: URLs for "portrait:<hash>" refs (see `portraits`)
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
  const library = libraryOf(state, pack);
  v.rolls = rollsFor(state, role, opts.playerId);
  v.combat = combatView(state, pack, role);
  if (role === 'player') {
    const p = state.players.find((x) => x.id === opts.playerId);
    v.me = p ? fullPlayer(state, p, pack, library) : null;
    v.library = playerLibrary(state, pack, library, p ?? null);
  } else if (role === 'stage') {
    v.library = playerLibrary(state, pack, library, null);
    v.joinUrl = opts.urls?.join ?? '';
    v.queueLength = q.queue.length + (q.playing ? 1 : 0);
  } else if (role === 'gm') {
    const cats = [...new Set([...STANDARD_CATEGORIES, ...pack.quipsByCategory.keys()])];
    v.gm = {
      joinUrl: opts.urls?.join ?? '',
      stageUrl: opts.urls?.stage ?? '',
      gmUrl: opts.urls?.gm ?? '',
      pins: Object.fromEntries(state.players.map((p) => [p.id, p.pin])),
      playersFull: state.players.map((p) => ({ ...fullPlayer(state, p, pack, library), userId: p.userId ?? null })),
      prepCards: state.prepCards,
      messages: state.messages.slice(-GM_MESSAGES).map((m) => ({
        id: m.id, at: m.at, from: m.from, text: m.text, to: m.to,
        group: isGroup(m.to), onStage: m.onStage, readBy: m.readBy,
      })),
      quipCategories: cats.map((id) => ({
        id,
        label: categoryLabel(id),
        left: quipsLeft(pack, state.usedQuips, id),
        total: pack.quipsByCategory.get(id)?.length ?? 0,
      })),
      achievementsCatalog: pack.achievements.map(({ id, title, desc, reward, group }) => ({ id, title, desc, reward, group })),
      itemsCatalog: library.list('item').map(({ id, name, rarity, desc, flavor, slot, stackable, source }) => ({ id, name, rarity, desc, flavor, slot, stackable, source })),
      pendingAuto: q.pendingAuto,
      queue: q.queue,
      playing: q.playing,
      aiAvailable: !!opts.aiAvailable,
      aiCallsLeft: opts.aiCallsLeft ?? 0,
      sponsorReady: hypeOf(state.audience, now) >= pack.audience.sponsorHypeThreshold,
      combatLog: (state.combatLog ?? []).slice(-10),
      drops: state.drops ?? [],
    };
    v.library = gmLibrary(library);
  }
  return v;
}

/**
 * Hosted edition: the player view for whoever is assigned to `userId`, or null if nobody is.
 * Same shape as viewFor(..., 'player', ...).
 */
export function viewForUser(state, pack, userId, opts = {}) {
  if (typeof userId !== 'string' || !userId) return null;
  const p = state.players.find((x) => x.userId === userId);
  return p ? viewFor(state, pack, 'player', { ...opts, playerId: p.id }) : null;
}
