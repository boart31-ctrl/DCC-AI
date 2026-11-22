// Game state: pure reducers for every action + per-role view projection.
//
// reduce(state, action, ctx) never mutates `state`; it returns
//   { state, events: [{ event, to }], lines: [voiceLine], effects: [{ type, ... }], result }
// or throws ActionError. `to` is 'all' or { roles: [...], playerId? }.
// Voice lines: { priority, text, quipId|null, crit } — the server feeds them to the VoiceQueue.
import { makeToken, makeRoomCode, makePin, randInt, genId } from './random.js';
import { MODES, pickQuip, markQuipUsed, quipsLeft, categoryPool } from './quips.js';
import { STANDARD_CATEGORIES } from './constants.js';
import { packForRuleset, rulesetChoices } from './systems.js';
import { normalizeContentMedia } from './content-media.js';
import { ActionError, bad, notFound } from './errors.js';
import { SCENE_GM, setScene, initScene, initShow, normalizeScene, normalizeShow, fillMissingBossArt, sceneView, showView, syncBossHealth } from './scenes.js';
import { COMBAT_GM, INIT_GM, INIT_PLAYER, initCombat, normalizeCombat, fillMissingMobArt, combatView, onSheetRoll, applyMobDamage,
  combatDangerAffected, refreshCombatDanger } from './combat.js';
import { AUTO_GM, MAX_COMBAT_LOG } from './combat-auto.js';
import { LOOT_GM, normalizeDrops, prepareEndLoot } from './loot.js';
import { CRAWLERS_GM, CRAWLERS_SYSTEM, initCrawlers, normalizeCrawlers, crawlersView } from './crawlers.js';
import {
  SHEET, SHEET_GM, normalizeLibArt, freshSheet, migrateSheet, migrateInventory, giveItem, emptyHomebrew, normalizeHomebrew, libraryOf,
  sheetView, legacyStats, computeFor, enrichInventory, playerLibrary, gmLibrary, rollsFor, requireNotes, requireStatusAllowed, setTrack, PLAYER_EDIT, MAX_ROLLS, DICE_MODES,
} from './character.js';
import { enhanceItem, MAX_ENHANCE } from './ruleset.js';
import { PREP_GM, addSceneNpc, editPrepEncounter, initPrep, loadPreparedAdventure, normalizePrep, planEvening, prepView, runPrepScene, upgradePreparedMaps } from './prep.js';
import { PREP_CHECKS_GM, PREP_CHECKS_PLAYER, normalizePrepChecks, prepChecksFor } from './prep-checks.js';
import { RULES_GM } from './rules-search.js';
import { originsFor } from './origins.js';
import { BUILD_IDS, offersFor, giveWarnings, itemBuilds, crawlerBuild, crawlerRating, rewardMode, effectiveLootPolicy, normalizeLootPolicy, REWARD_MODES, SETTING_KEYS } from './loot-advisor.js';
import { floorOfState } from './outcome.js';
import { ADVANCEMENT_PLAYER, advancementClockView, changeAdvancementClock, consumeAdvancementMilestone, normalizeAdvancementClock,
  normalizeLevelGrants, recordLevelGrant, snoozeAdvancementClock } from './advancement.js';
import { MAPS_GM, MAPS_PLAYER, initMaps, normalizeMaps, mapsView, syncCombatTokens, startCombatOnMap } from './maps.js';
import { REACTION_GM, REACTION_PLAYER, reactionView, dyingTick, onCrawlerDamage, spendReactionAction, actionReceipt } from './reaction.js';
import { combatHistoryFor, normalizeCombatHistory, recordCombatHistory } from './combat-history.js';
import { makeEncounterGM } from './encounters.js';
import { makeCreation } from './creation.js';

export { genId, ActionError };

export const FEED_SIZE = 30;
export const MAX_PREP_CARDS = 100;
export const MAX_RECAP = 4000;
export const PREP_KINDS = { achievement: 'ach.award', loot: 'loot.open', message: 'msg.send', line: 'say', encounter: 'combat.addEncounter' };
export const MAX_MESSAGES = 400;
export const GM_MESSAGES = 200;
export const PLAY_GAP_MS = 15 * 60_000;
export const PLAYER_MESSAGES = 120;
// Reactions when the pack's ui.json has none: rendered as emoji by the clients.
export const DEFAULT_REACTIONS = ['like', 'lol', 'love', 'wow', 'sad', 'fire', 'skull', 'party'];
const MAX_REACTORS = 40;
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

/** Campaign identity: name + the ruleset it was created with (locked: one ruleset per campaign). */
export function newCampaign(pack, now, { name, ruleset } = {}) {
  const choices = rulesetChoices(pack).map((c) => c.id);
  return {
    id: `c_${makeToken(9)}`,
    name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 60) : 'Campaign',
    ruleset: choices.includes(ruleset) ? ruleset : pack.ruleset.id,
    createdAt: now,
  };
}

function normalizeCampaign(raw, pack, now) {
  const base = newCampaign(pack, now);
  if (!raw || typeof raw !== 'object') return base;
  const choices = rulesetChoices(pack).map((c) => c.id);
  return {
    id: typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id) ? raw.id : base.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : base.name,
    ruleset: choices.includes(raw.ruleset) ? raw.ruleset : pack.ruleset.id,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
  };
}

/** The pack a state runs with: the campaign's ruleset applied to the base pack (server/systems.js). */
export function packOf(state, pack) {
  return packForRuleset(pack, state?.campaign?.ruleset);
}

export function createState(basePack, now = Date.now(), campaign = {}) {
  const camp = newCampaign(basePack, now, campaign);
  const pack = packForRuleset(basePack, camp.ruleset);
  return {
    v: 1,
    campaign: camp,
    room: makeRoomCode(),
    gmToken: makeToken(),
    stageToken: makeToken(),
    session: newSession(pack, now),
    players: [],
    audience: { viewers: pack.audience.startViewers, bumps: [], lastActivity: now, lastDecay: now },
    usedQuips: {},
    introduced: {}, // `${kind}:${id}` → true: monster / NPC intros already announced this campaign
    feed: [],
    messages: [],
    prepCards: [],
    prepChecks: [],
    prep: initPrep(), // prep.js: adventures + session plans (GM only)
    maps: initMaps(), // maps.js: images + zones + fog (+ tokens for online play)
    library: emptyHomebrew(),
    contentMedia: {},
    libArt: normalizeLibArt(null),
    rolls: [],
    rollUndo: [], // roll ids the GM undo chip takes back, newest last (character.js)
    rollRedo: [],
    scene: initScene(now), // scenes.js
    combat: initCombat(), // combat.js
    combatHistory: normalizeCombatHistory(null),
    combatLog: [], // combat-auto.js: one summary per finished fight (this session), for the recap
    drops: [], // loot.js: piles from looted bodies, handed out by the GM
    show: initShow(),
    crawlers: initCrawlers(pack, now), // crawlers.js: worldwide head count (campaign-level, kept by session.new)
  };
}

/**
 * Repairs a loaded snapshot against the current pack (pack may have changed between runs):
 * fills missing fields, adds new stats/resources, keeps unknown ones (harmless, hidden by UI).
 */
export function normalizeState(raw, basePack, now = Date.now()) {
  const campaign = normalizeCampaign(raw?.campaign, basePack, now);
  const pack = packForRuleset(basePack, campaign.ruleset);
  const base = createState(basePack, now, campaign);
  if (!raw || typeof raw !== 'object') return base;
  const s = { ...base, ...raw, campaign };
  s.session = { ...base.session, ...(raw.session ?? {}) };
  if (pack.ruleset.advancement) s.session.advancementClock = normalizeAdvancementClock(raw.session?.advancementClock);
  if (!MODES.includes(s.session.mode)) s.session.mode = 'roleplay';
  if (!pack.voicesById.has(s.session.voice) && s.session.voice !== 'host') s.session.voice = defaultVoiceId(pack);
  s.audience = { ...base.audience, ...(raw.audience ?? {}) };
  if (!Array.isArray(s.audience.bumps)) s.audience.bumps = [];
  s.usedQuips = raw.usedQuips && typeof raw.usedQuips === 'object' ? raw.usedQuips : {};
  s.introduced = raw.introduced && typeof raw.introduced === 'object' && !Array.isArray(raw.introduced) ? raw.introduced : {};
  s.feed = Array.isArray(raw.feed) ? raw.feed.slice(-FEED_SIZE) : [];
  s.messages = Array.isArray(raw.messages) ? raw.messages : [];
  s.prepCards = Array.isArray(raw.prepCards) ? raw.prepCards : [];
  s.prep = normalizePrep(raw.prep);
  s.prepChecks = normalizePrepChecks(raw.prepChecks);
  s.maps = normalizeMaps(raw.maps);
  upgradePreparedMaps(s, pack);
  if (typeof s.session.recap !== 'string') s.session.recap = '';
  s.session.aiMute = s.session.aiMute === true;
  s.session.hold = s.session.hold === true;
  if (!PLAYER_EDIT.includes(s.session.permissions?.playerEdit)) s.session.permissions = { playerEdit: 'sheet' };
  s.library = normalizeHomebrew(raw.library);
  s.contentMedia = normalizeContentMedia(raw.contentMedia);
  s.libArt = normalizeLibArt(raw.libArt);
  s.rolls = Array.isArray(raw.rolls) ? raw.rolls.filter((r) => r && typeof r === 'object').slice(-MAX_ROLLS) : [];
  const rollIds = new Set(s.rolls.map((r) => r.id));
  s.rollUndo = Array.isArray(raw.rollUndo) ? raw.rollUndo.filter((id) => rollIds.has(id)).slice(-30) : [];
  s.rollRedo = Array.isArray(raw.rollRedo) ? raw.rollRedo.filter((id) => rollIds.has(id)).slice(-30) : [];
  s.scene = normalizeScene(raw.scene, now);
  fillMissingBossArt(s, pack);
  s.show = normalizeShow(raw.show);
  s.combat = normalizeCombat(raw.combat);
  s.combatHistory = normalizeCombatHistory(raw.combatHistory);
  fillMissingMobArt(s, pack);
  s.drops = normalizeDrops(raw.drops);
  s.crawlers = normalizeCrawlers(raw.crawlers, pack, now);
  s.combatLog = Array.isArray(raw.combatLog) ? raw.combatLog.filter((x) => x && typeof x === 'object').slice(-MAX_COMBAT_LOG) : [];
  s.players = (Array.isArray(raw.players) ? raw.players : []).map((p, i) => {
    // Pre-messaging saves stored private messages on the player; move them into state.messages.
    // Pre-v2 saves keep flat `stats` numbers and `resources`; they move into `sheet` (RULESET §5).
    const { secrets, stats, resources, ...rest } = p;
    for (const m of Array.isArray(secrets) ? secrets : []) {
      if (s.messages.some((x) => x.id === m.id)) continue;
      s.messages.push({ id: m.id, at: m.at ?? 0, from: m.from ?? pack.systemName, text: m.text ?? '', to: [p.id], onStage: false, readBy: m.read ? [p.id] : [] });
    }
    const sheet = migrateSheet(p.sheet, { stats, resources }, pack.ruleset);
    // Older species creation stored race inside the sheet while public views use player.race.
    const legacyRace = sheet.species && typeof sheet.identity.race === 'string' ? sheet.identity.race : '';
    if (sheet.species) delete sheet.identity.race;
    return {
      title: '', klass: '', gold: 0, notes: '', level: 1, userId: null,
      color: PALETTE[i % PALETTE.length], achievements: [],
      ...rest,
      race: p.race || legacyRace,
      inventory: migrateInventory(p.inventory, pack.ruleset),
      sheet,
      ...(p.levelGrants ? { levelGrants: normalizeLevelGrants(p.levelGrants) } : {}),
    };
  });
  s.messages = s.messages.filter((m) => m && typeof m === 'object' && typeof m.id === 'string').map(normalizeMessage);
  s.messages.sort((a, b) => a.at - b.at);
  s.messages = s.messages.slice(-MAX_MESSAGES);
  s.session.chatPlayers = s.session.chatPlayers !== false;
  refreshCombatDanger(s, pack);
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

const RARITY_IDX = (r) => Math.max(0, ['common', 'uncommon', 'rare', 'epic', 'legendary'].indexOf(r));

/** "1d10*100" → rolled number (0 for empty). */
function rollGold(expr, rng) {
  const m = /^(\d*)d(\d+)(?:\*(\d+))?$/.exec(String(expr ?? '').replace(/\s+/g, ''));
  if (!m) return 0;
  let sum = 0;
  for (let i = 0; i < Number(m[1] || 1); i++) sum += 1 + Math.floor(rng() * Number(m[2]));
  return sum * Number(m[3] || 1);
}

function lootOverview(st, pack) {
  const P = effectiveLootPolicy(pack.lootPolicy, st.lootSettings);
  const lib = libraryOf(st, pack);
  const itemOf = (id) => lib.get('item', id);
  const floor = floorOfState(st);
  return {
    floor,
    settings: st.lootSettings ?? {},
    policy: { budget: P.budget, stretch: P.stretch, wildcard: P.wildcard, pity: P.pity, offers: P.offers, drops: P.drops, floorRarity: P.floorRarity, fragileFactor: P.fragileFactor },
    crawlers: st.players.map((p) => {
      const rating = crawlerRating(P, { sheet: p.sheet, inventory: p.inventory, itemOf, floor, level: p.sheet?.level, prefs: p.lootPrefs });
      return { playerId: p.id, name: p.name, rating, modeSetting: p.lootPrefs?.mode ?? 'auto', mode: rewardMode(p.lootPrefs?.mode, rating.grade),
        prefs: p.lootPrefs ?? {}, pendingBoxes: p.pendingBoxes ?? [], boxes: p.lootStats?.boxes ?? 0 };
    }),
  };
}

function lootOffers(st, ctx, a) {
  const p = playerOf(st, a.playerId);
  if (typeof a.tier !== 'string' || !ctx.pack.tiersById.has(a.tier)) throw notFound(`unknown loot tier ${a.tier}`);
  const lib = libraryOf(st, ctx.pack);
  const items = lib.list ? lib.list('item') : [...(ctx.pack.itemsById?.values?.() ?? [])];
  const owned = new Set(st.players.flatMap((x) => x.inventory.map((i) => i.itemId)));
  const P = effectiveLootPolicy(ctx.pack.lootPolicy, st.lootSettings);
  const itemOf = (id) => lib.get('item', id);
  const floor = floorOfState(st);
  const rating = crawlerRating(P, { sheet: p.sheet, inventory: p.inventory, itemOf, floor, level: p.sheet?.level, prefs: p.lootPrefs });
  const mode = rewardMode(p.lootPrefs?.mode, rating.grade);
  return { ...offersFor(P, { tier: a.tier, boss: a.boss === true, mode, floor, sheet: p.sheet, inventory: p.inventory,
    prefs: p.lootPrefs, stats: p.lootStats, items, itemOf, owned, rng: ctx.rng }), rating: { score: rating.score, grade: rating.grade }, modeSetting: p.lootPrefs?.mode ?? 'auto' };
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

// Phone takeovers a crawler may miss (reload, phone asleep): the feed keeps what the phone needs to replay them.
const REPLAY_KINDS = { achievement: ['achId', 'title', 'desc', 'reward', 'group'], loot: ['tier', 'item'], sponsor: ['sponsor', 'tier', 'item'] };
function feedPush(st, ev, text) {
  const keep = REPLAY_KINDS[ev.kind];
  const replay = keep && ev.playerId ? Object.fromEntries(keep.filter((k) => ev[k] !== undefined).map((k) => [k, ev[k]])) : null;
  st.feed.push({ id: ev.id, at: ev.at, kind: ev.kind, playerId: ev.playerId, text, ...(replay ? { replay } : {}) });
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
      id: ctx.genId('p'), name, color: c, level: 1, pin, userId, joinedAt: ctx.now,
      title: '', klass: '', race: '', gold: 0, notes: '',
      sheet: freshSheet(ctx.pack.ruleset),
      inventory: [], achievements: [],
    };
    // Formula-based track maxima (e.g. "10 + mod.con") start full.
    const { computed } = computeFor(p, ctx.pack, libraryOf(st, ctx.pack));
    for (const t of ctx.pack.ruleset.tracks) if (t.maxFormula) p.sheet.tracks[t.id] = { cur: t.start === 'empty' ? 0 : computed.tracks[t.id].max, max: computed.tracks[t.id].max };
    st.players.push(p);
    giveStarterAttack(st, p, ctx);
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
    // Its box waits on the crawler until the GM opens it with the System's offers (C1b).
    if (ach.box && ctx.pack.tiersById.has(ach.box)) p.pendingBoxes = [...(p.pendingBoxes ?? []), { id: ctx.genId('pb'), tier: ach.box, boss: false, from: ach.title, at: ctx.now }].slice(-20);
    out.emit(bumpPct(st, ctx, randRange(ctx.rng, 0.05, 0.15)));
    const voiced = ach.voice && ctx.pack.quipsById.get(ach.voice);
    const line = voiced
      ? quipLine(st, voiced, 1)
      : categoryLine(st, ctx, 'achievement', 1) ?? { priority: 1, text: `New achievement. ${ach.title}.`, quipId: null, crit: false };
    out.lines.push(line);
  },

  /** GM peek: rolls the tier's table without giving anything. Ack `result.item` {id, name, rarity, image}. Re-roll = call again. */
  'loot.peek'(st, a, ctx, out) {
    const item = libraryOf(st, ctx.pack).get('item', lootRoll(st, ctx, a.tier).id);
    out.result = { item: { id: item.id, name: item.name, rarity: item.rarity ?? 'common', image: item.image ?? null, desc: item.desc ?? '' } };
    out.changed = false;
  },

  'loot.open'(st, a, ctx, out) {
    const p = playerOf(st, a.playerId);
    // itemId: the GM peeked and keeps this roll (must be on the tier's table).
    let picked = null;
    if (a.itemId !== undefined) {
      if (typeof a.tier !== 'string' || !ctx.pack.tiersById.has(a.tier)) throw notFound(`unknown loot tier ${a.tier}`);
      if (!(ctx.pack.loot[a.tier] ?? []).some((r) => r.item === a.itemId)) throw bad(`${a.itemId} is not in the ${a.tier} table`);
      picked = a.itemId;
    }
    const item = libraryOf(st, ctx.pack).get('item', picked ?? lootRoll(st, ctx, a.tier).id);
    const inv = giveItem(p, item, ctx);
    const { name, desc, flavor, rarity, image } = inv;
    setScene(st, ctx, 'loot', { playerId: p.id, tier: a.tier, opened: { name, desc, flavor, rarity, image } });
    const ev = out.emit({ kind: 'loot', sceneId: st.scene.id, playerId: p.id, tier: a.tier, item: inv }, 'all');
    feedPush(st, ev, `${p.name} opened a ${ctx.pack.tiersById.get(a.tier).name}: ${item.name}`);
    out.emit(bumpPct(st, ctx, randRange(ctx.rng, 0.03, 0.08)));
    const line = categoryLine(st, ctx, 'loot', 1);
    if (line) out.lines.push(line);
    out.result = { uid: inv.uid, itemId: item.id };
  },

  // ---------- loot advisor (C1, loot-advisor.js): box offers per crawler inside the floor's power budget ----------

  /** a: { playerId, tier, boss? } → result = offersFor(…). Read-only; call again to re-roll. */
  'loot.offers'(st, a, ctx, out) {
    out.result = lootOffers(st, ctx, a);
    out.changed = false;
  },

  /** Campaign loot settings over the pack policy: a: { settings: { budget?, stretch?, wildcard?, pity?, offers?, drops?, fragileFactor?, dropsOff? } | null }. */
  'loot.settings'(st, a) {
    if (a.settings === null) { delete st.lootSettings; return; }
    if (!a.settings || typeof a.settings !== 'object' || Array.isArray(a.settings)) throw bad('settings must be an object');
    const next = { ...(st.lootSettings ?? {}) };
    for (const [k, v] of Object.entries(a.settings)) {
      if (k === 'dropsOff') { if (typeof v !== 'boolean') throw bad('dropsOff must be true/false'); next.dropsOff = v; continue; }
      if (!SETTING_KEYS.includes(k)) throw bad(`unknown loot setting ${k}`);
      if (v === null) { delete next[k]; continue; }
      const probe = normalizeLootPolicy({ [k]: v });
      if (JSON.stringify(probe[k]) === JSON.stringify(normalizeLootPolicy(null)[k]) && JSON.stringify(v) !== JSON.stringify(normalizeLootPolicy(null)[k])) throw bad(`${k}: not a valid value`);
      next[k] = v;
    }
    st.lootSettings = next;
  },

  /** GM steering for one crawler: a: { playerId, builds?: [build], lean?: 0..1 (wild-card chance), block?: [itemId] }. */
  'loot.prefs'(st, a, ctx, out) {
    const p = playerOf(st, a.playerId);
    const cur = p.lootPrefs ?? {};
    const next = { ...cur };
    if (a.builds !== undefined) {
      if (!Array.isArray(a.builds) || a.builds.some((b) => !BUILD_IDS.includes(b))) throw bad(`builds: any of ${BUILD_IDS.join(', ')}`);
      next.builds = [...new Set(a.builds)].slice(0, 3);
    }
    if (a.lean !== undefined) {
      if (typeof a.lean !== 'number' || !(a.lean >= 0 && a.lean <= 1)) throw bad('lean must be 0..1');
      next.lean = Math.round(a.lean * 100) / 100;
    }
    if (a.mode !== undefined) {
      if (!REWARD_MODES.includes(a.mode)) throw bad(`mode: ${REWARD_MODES.join(', ')}`);
      next.mode = a.mode;
    }
    if (a.block !== undefined) {
      if (!Array.isArray(a.block) || a.block.some((x) => typeof x !== 'string')) throw bad('block must be item ids');
      next.block = [...new Set(a.block)].slice(0, 100);
    }
    p.lootPrefs = next;
    out.result = { lootPrefs: next };
  },

  /**
   * Opens a box with the items the GM picked from the offers: a: { playerId, tier, boss?, itemIds: [id…], gold?, force? }.
   * Items above the tier's rarity reach need force:true. Gives everything, shows the best item on the TV, System line.
   * Ack { uids, gold, warnings }.
   */
  'loot.box'(st, a, ctx, out) {
    const p = playerOf(st, a.playerId);
    const P = effectiveLootPolicy(ctx.pack.lootPolicy, st.lootSettings);
    if (typeof a.tier !== 'string' || !ctx.pack.tiersById.has(a.tier)) throw notFound(`unknown loot tier ${a.tier}`);
    if (!Array.isArray(a.itemIds) || !a.itemIds.length || a.itemIds.length > 8) throw bad('itemIds: 1–8 items');
    const lib = libraryOf(st, ctx.pack);
    const items = a.itemIds.map((id) => { const it = lib.get('item', id); if (!it) throw notFound(`unknown item ${id}`); return it; });
    const libR = libraryOf(st, ctx.pack);
    const ratingR = crawlerRating(P, { sheet: p.sheet, inventory: p.inventory, itemOf: (id) => libR.get('item', id), floor: floorOfState(st), level: p.sheet?.level, prefs: p.lootPrefs });
    const lifted = a.boss === true || rewardMode(p.lootPrefs?.mode, ratingR.grade) === 'catchup';
    const reach = Object.keys(P.weights[a.tier] ?? {}).reduce((m, r) => Math.max(m, RARITY_IDX(r)), 0) + (lifted ? 1 : 0);
    const tooRare = items.filter((it) => RARITY_IDX(it.rarity) > reach);
    if (tooRare.length && a.force !== true) throw bad(`${tooRare.map((it) => it.name).join(', ')}: above what a ${a.tier} box holds (force to give anyway)`);
    const floor = floorOfState(st);
    const itemOf = (id) => lib.get('item', id);
    const warnings = items.flatMap((it) => giveWarnings(P, { item: it, floor, inventory: p.inventory, itemOf, source: 'box' }));
    const gold = a.gold === undefined ? rollGold(P.gold[a.tier], ctx.rng) : int(a.gold, 'gold', 0, 1e7);
    const given = items.map((it) => giveItem(p, it, ctx));
    if (gold) p.gold = (p.gold ?? 0) + gold;
    // Bad-luck protection bookkeeping: did this box hold something for the crawler's build?
    const build = crawlerBuild(p.sheet, p.lootPrefs);
    const wanted = new Set(build.steered.length ? build.steered : build.top);
    const fit = items.some((it) => itemBuilds(it).some((b) => wanted.has(b)));
    p.lootStats = { boxes: (p.lootStats?.boxes ?? 0) + 1, noFit: fit ? 0 : (p.lootStats?.noFit ?? 0) + 1 };
    if (typeof a.pendingId === 'string') p.pendingBoxes = (p.pendingBoxes ?? []).filter((b) => b.id !== a.pendingId);
    const best = given.reduce((b, x) => (RARITY_IDX(x.rarity) > RARITY_IDX(b.rarity) ? x : b), given[0]);
    const { name, desc, flavor, rarity, image } = best;
    setScene(st, ctx, 'loot', { playerId: p.id, tier: a.tier, opened: { name, desc, flavor, rarity, image } });
    const ev = out.emit({ kind: 'loot', sceneId: st.scene.id, playerId: p.id, tier: a.tier, boss: !!a.boss, item: best, items: given, gold }, 'all');
    const tierName = ctx.pack.tiersById.get(a.tier).name;
    feedPush(st, ev, `${p.name} opened a ${a.boss ? 'Boss ' : ''}${tierName}: ${given.map((x) => x.name).join(', ')}${gold ? ` + ${gold} gold` : ''}`);
    out.emit(bumpPct(st, ctx, randRange(ctx.rng, 0.03, 0.08) * (1 + RARITY_IDX(best.rarity) * 0.5)));
    const line = categoryLine(st, ctx, 'loot', 1);
    if (line) out.lines.push(line);
    out.result = { uids: given.map((x) => x.uid), gold, warnings, fit };
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
    const warnings = giveWarnings(effectiveLootPolicy(ctx.pack.lootPolicy, st.lootSettings), { item, floor: floorOfState(st), inventory: p.inventory, itemOf: (id) => libraryOf(st, ctx.pack).get('item', id) });
    const inv = giveItem(p, item, ctx, qty, int(a.bonus, 'bonus', 0, MAX_ENHANCE, { optional: true }) ?? 0);
    out.result = { uid: inv.uid, ...(warnings.length ? { warnings } : {}) };
  },

  /** Make a copy +N (0 = plain again): name, rarity, to hit / damage or armour follow (ruleset enhanceItem). */
  'item.enhance'(st, a, ctx) {
    const p = playerOf(st, a.playerId);
    const inv = p.inventory.find((i) => i.uid === a.uid);
    if (!inv) throw notFound(`no item ${a.uid}`);
    const bonus = int(a.bonus, 'bonus', 0, MAX_ENHANCE);
    const def = libraryOf(st, ctx.pack).get('item', inv.itemId);
    if (!def) throw notFound(`item ${inv.itemId} is not in the library`);
    if (def.stackable && (inv.qty ?? 1) > 1) throw bad('split the stack first: only single items can be enhanced');
    const e = enhanceItem(def, bonus);
    Object.assign(inv, { bonus, name: e.name, rarity: e.rarity });
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
      ...msgBody(a, ctx.pack),
      to,
      onStage: !!a.onStage && isGroup(to),
      readBy: [],
      fromId: 'gm',
      reactions: {},
      gmRead: true,
    };
    pushMessage(st, msg, out);
    const group = isGroup(to);
    // The message id doubles as the event envelope id (it is unique per send).
    // Legacy event kept for clients written against the original `secret.send` protocol.
    if (!group) out.emit({ kind: 'secret', playerId: to[0], messageId: msg.id }, { roles: ['gm'], playerId: to[0] });
    if (msg.onStage) out.emit({ kind: 'announcement', messageId: msg.id, from: msg.from, text: msg.text }, { roles: ['stage'] });
    out.result = { id: msg.id };
  },

  /** Message centre: react (toggle) as the GM. */
  'msg.react'(st, a, ctx) {
    toggleReaction(st, ctx, a, 'gm', () => true);
  },
  /** The GM has seen a conversation (unread badges on the desk). */
  'msg.gmRead'(st, a) {
    if (typeof a.thread !== 'string') throw bad('thread required');
    for (const m of st.messages) if (!m.gmRead && threadOf(m.to) === a.thread) m.gmRead = true;
  },
  'msg.delete'(st, a) {
    const i = st.messages.findIndex((x) => x.id === a.id);
    if (i < 0) throw notFound(`no message ${a.id}`);
    st.messages.splice(i, 1);
  },
  /** Can crawlers write (to the GM, the party, each other)? */
  'msg.players'(st, a) {
    if (typeof a.on !== 'boolean') throw bad('on must be a boolean');
    st.session.chatPlayers = a.on;
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

  /** Panic: the TV holds on a stand-by card (scene stays underneath), a running countdown pauses. Off = back as it was. */
  'session.hold'(st, a, ctx, out) { // AUTO goes off too: nothing plays by itself while held
    if (typeof a.on !== 'boolean') throw bad('on must be a boolean');
    st.session.hold = a.on;
    if (a.on && st.scene?.kind === 'countdown' && st.scene.data?.startedAt != null) SCENE_GM['countdown.pause'](st, {}, ctx, out);
    if (a.on) { st.session.auto = false; out.effects.push({ type: 'clearPending' }); }
  },

  'session.budget'(st, a) {
    st.session.budgetLeft = int(a.value, 'value', 0, 999);
  },

  'session.voice'(st, a, ctx) {
    const ok = ctx.pack.voicesById.has(a.voice) || (a.voice === 'host' && !ctx.pack.voices.length);
    if (typeof a.voice !== 'string' || !ok) throw notFound(`unknown voice ${a.voice}`);
    st.session.voice = a.voice;
  },

  /** `{ delta? }` Everyone up a level (+1 default); resets the level-up reminder's play clock. */
  'level.party'(st, a, ctx, out) {
    const delta = a.delta === undefined ? 1 : a.delta;
    if (!Number.isInteger(delta) || delta < -5 || delta > 5 || delta === 0) throw bad('delta must be -5..5, not 0');
    if (a.timed === true) {
      if (delta !== 1 || !st.players.length) throw bad('a play milestone grants one level to the party');
      consumeAdvancementMilestone(st.session, ctx.pack.ruleset, ctx.now, a.checkpoint);
    }
    for (const p of st.players) {
      const cur = Number(p.sheet?.identity?.level ?? p.level ?? 1) || 1;
      const next = Math.max(0, cur + delta);
      if (p.sheet) p.sheet.identity = { ...(p.sheet.identity ?? {}), level: next };
      p.level = next;
      if (next > cur) recordLevelGrant(st, p, cur, ctx, (a.timed === true || a.phone === true) && a.rankUp !== true);
    }
    st.session.levelAtMs = st.session.playMs ?? 0;
    if (delta > 0) out.emit({ kind: 'levelup', delta, names: st.players.map((p) => p.name) }, 'all');
    // With rankUp: roll the skills eligible at the play-time milestone. Floor ranks stay marked.
    let rankUps = [];
    if (a.rankUp === true && ctx.pack.ruleset.skills?.rankUp) {
      const sub = { ...out, result: null };
      GM['skills.rankUp'](st, { when: 'session' }, ctx, sub);
      rankUps = sub.result?.results ?? [];
    }
    out.result = { players: st.players.length, rankUps };
  },
  /** `{ minutes }` Not yet: the reminder comes back after this much more play. */
  'level.snooze'(st, a, ctx) {
    const m = Number.isInteger(a.minutes) && a.minutes >= 5 && a.minutes <= 240 ? a.minutes : 30;
    if (snoozeAdvancementClock(st.session, ctx.pack.ruleset, ctx.now, m)) return;
    st.session.levelSnoozeMs = (st.session.playMs ?? 0) + m * 60_000;
  },
  'level.clock': changeAdvancementClock,

  'rest.party'(st, a, ctx, out) {
    const rs = ctx.pack.ruleset;
    if (!rs.rests || !Object.hasOwn(rs.rests, a.kind)) throw bad('unknown party rest');
    if (st.combat?.active) throw bad('finish combat before resting');
    const rest = rs.rests[a.kind];
    if (st.crawlers?.clock?.hours == null) throw bad('set the floor clock first');
    if (st.crawlers.clock.hours < rest.hours) throw bad('not enough time before the floor collapses');
    const library = libraryOf(st, ctx.pack);
    const able = st.players.filter((p) => computeFor(p, ctx.pack, library).computed.tracks[rs.hpTrack ?? 'hp']?.cur !== 0);
    if (!able.length) throw bad('nobody can rest');
    const results = [];
    const sub = { ...out, result: null };
    for (const p of able) {
      SHEET.rest(st, { kind: a.kind, playerId: p.id }, ctx, sub);
      results.push({ playerId: p.id, restored: sub.result.restored });
    }
    CRAWLERS_GM['crawlers.clock'](st, { advance: rest.hours }, ctx, sub);
    out.result = { results, hours: sub.result.hours };
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
    st.prepChecks = [];
    st.combatLog = [];
    st.drops = [];
    st.audience.bumps = [];
    touch(st, ctx);
    out.effects.push({ type: 'queueClear' });
  },
};

/** Older saves: no author id (the GM wrote them all), no reactions, no sticker. */
function normalizeMessage(m) {
  const reactions = {};
  if (m.reactions && typeof m.reactions === 'object' && !Array.isArray(m.reactions)) {
    for (const [k, v] of Object.entries(m.reactions)) if (/^[a-z0-9_]{1,40}$/.test(k) && Array.isArray(v) && v.length) reactions[k] = v.filter((x) => typeof x === 'string').slice(0, MAX_REACTORS);
  }
  return {
    ...m,
    at: Number.isFinite(m.at) ? m.at : 0,
    text: typeof m.text === 'string' ? m.text : '',
    to: m.to === 'all' || Array.isArray(m.to) ? m.to : [],
    readBy: Array.isArray(m.readBy) ? m.readBy : [],
    fromId: typeof m.fromId === 'string' ? m.fromId : 'gm',
    icon: typeof m.icon === 'string' ? m.icon : null,
    reactions,
    gmRead: m.gmRead !== false,
  };
}

/** Conversation key: 'all', or the sorted crawler ids in it (the GM is in every conversation). */
export function threadOf(to) {
  return to === 'all' ? 'all' : [...to].sort().join(',');
}
function reactionIds(pack) {
  const r = pack.ui?.reactions;
  return r && Object.keys(r).length ? Object.keys(r) : DEFAULT_REACTIONS;
}
function stickerOk(pack, id) {
  return id == null || (typeof id === 'string' && !!pack.ui?.stickers && Object.hasOwn(pack.ui.stickers, id));
}
function msgBody(a, pack) {
  const icon = a.icon == null || a.icon === '' ? null : a.icon;
  if (!stickerOk(pack, icon)) throw bad('unknown sticker');
  const text = a.text == null ? '' : str(a.text, 'text', 1000, { allowEmpty: true });
  if (!text.trim() && !icon) throw bad('text or sticker required');
  return { text, icon };
}
function toggleReaction(st, ctx, a, who, canSee) {
  const m = st.messages.find((x) => x.id === a.id);
  if (!m || !canSee(m)) throw notFound(`no message ${a.id}`);
  if (typeof a.r !== 'string' || !reactionIds(ctx.pack).includes(a.r)) throw bad('unknown reaction');
  const list = m.reactions[a.r] ?? [];
  m.reactions[a.r] = list.includes(who) ? list.filter((x) => x !== who) : [...list, who].slice(-MAX_REACTORS);
  if (!m.reactions[a.r].length) delete m.reactions[a.r];
}
function pushMessage(st, msg, out) {
  st.messages.push(msg);
  if (st.messages.length > MAX_MESSAGES) st.messages = st.messages.slice(-MAX_MESSAGES);
  const group = isGroup(msg.to);
  const recipients = msg.to === 'all' ? { roles: ['gm', 'player'] } : { roles: ['gm'], playerIds: msg.to };
  out.emit({ kind: 'message', id: msg.id, group, from: msg.from, fromId: msg.fromId, to: msg.to, thread: threadOf(msg.to) }, recipients);
}

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
  /**
   * Message centre, crawler side. to: 'all' (the whole party) or crawler ids; the writer is always in the
   * conversation and the GM sees every one ([] = just me and the GM).
   */
  'msg.post'(st, a, ctx, out) {
    const p = playerOf(st, a.actorId);
    if (st.session.chatPlayers === false) throw bad('The GM has paused crawler messages');
    let to;
    if (a.to === 'all') to = 'all';
    else if (Array.isArray(a.to) && a.to.length <= MAX_PLAYERS) to = [...new Set([p.id, ...a.to.map((id) => playerOf(st, id).id)])];
    else throw bad("to must be 'all' or an array of playerIds");
    const recent = st.messages.filter((m) => m.fromId === p.id && ctx.now - m.at < 10_000).length;
    if (recent >= 8) throw bad('Slow down a little');
    pushMessage(st, { id: ctx.genId('m'), at: ctx.now, from: p.name, ...msgBody(a, ctx.pack), to, onStage: false, readBy: [p.id], fromId: p.id, reactions: {}, gmRead: false }, out);
    out.result = { id: st.messages[st.messages.length - 1]?.id };
  },
  'msg.react'(st, a, ctx) {
    const p = playerOf(st, a.actorId);
    toggleReaction(st, ctx, a, p.id, (m) => addressedTo(m, p.id));
  },
  /** Marks a whole conversation read. */
  'msg.read'(st, a) {
    const p = playerOf(st, a.actorId);
    if (typeof a.thread !== 'string') throw bad('thread required');
    for (const m of st.messages) if (addressedTo(m, p.id) && threadOf(m.to) === a.thread && !m.readBy.includes(p.id)) m.readBy.push(p.id);
  },
  'me.notes'(st, a, ctx) {
    requireNotes(st, ctx);
    playerOf(st, a.actorId).notes = notesText(a.text);
  },
};

// v2 sheet actions: GM gets all; players get the SHEET table (permission-checked per action).
Object.assign(GM, SHEET, SHEET_GM, SCENE_GM, COMBAT_GM, INIT_GM, AUTO_GM, LOOT_GM, CRAWLERS_GM, PREP_GM, MAPS_GM, REACTION_GM);
Object.assign(GM, makeEncounterGM(GM));
Object.assign(GM, PREP_CHECKS_GM);
Object.assign(GM, RULES_GM);
GM['map.toFight'] = (st, a, ctx, out) => startCombatOnMap(st, a, ctx, out, GM);
GM['prep.adventure.load'] = (st, a, ctx, out) => loadPreparedAdventure(st, a, ctx, out, GM['enc.save']);
GM['prep.evening.plan'] = (st, a, ctx, out) => planEvening(st, a, ctx, out, GM);
GM['prep.scene.run'] = (st, a, ctx, out) => runPrepScene(st, a, ctx, out, GM);
GM['prep.scene.encounter'] = (st, a, ctx, out) => editPrepEncounter(st, a, ctx, out, GM);
GM['prep.scene.npc'] = (st, a, ctx, out) => addSceneNpc(st, a, ctx, out, GM);
const CREATION = makeCreation(GM);
Object.assign(GM, CREATION.player, CREATION.gm);
for (const [k, fn] of Object.entries(SHEET)) PLAYER[k] = fn;
Object.assign(PLAYER, CREATION.player);
Object.assign(PLAYER, INIT_PLAYER, MAPS_PLAYER, REACTION_PLAYER);
Object.assign(PLAYER, PREP_CHECKS_PLAYER);
Object.assign(PLAYER, ADVANCEMENT_PLAYER);

function requireCombatHotlist(st, ctx, uid) {
  const p = st.players.find((x) => x.id === ctx.actor.playerId);
  if (!p?.sheet.hotlist?.includes(uid)) throw bad('prepare it in your Hotlist first');
}

PLAYER.roll = (st, a, ctx, out) => {
  const weapon = a.what?.kind === 'attack';
  const strike = (weapon || a.what?.kind === 'spell') && a.what.part !== 'damage';
  if (a.useAction !== undefined && a.useAction !== false && (a.useAction !== true || !strike)) throw bad('useAction needs an attack roll');
  const rx = st.combat?.active ? st.combat.rx : null;
  const targeted = typeof a.target === 'string' && (strike || weapon);
  if (!a.useAction && !(rx && targeted)) return SHEET.roll(st, a, ctx, out);
  const me = st.combat?.combatants.find((c) => c.type === 'crawler' && c.playerId === ctx.actor.playerId);
  if (rx?.step !== 'act' || !me || me.dead || me.dying != null) throw bad('you cannot attack in this phase');
  if (strike && a.what.kind === 'spell' && ctx.pack.ruleset.hotlist.combat) requireCombatHotlist(st, ctx, a.what.uid);
  if (!strike) {
    const hit = st.rolls.find((r) => r.id === a.after && r.playerId === ctx.actor.playerId && r.what === 'attack'
      && r.whatId === a.what.uid && r.part === 'hit' && r.vs?.uid === a.target && r.vs.hit && !r.void && r.actionReceipt?.combatId === rx.combatId);
    if (!hit) throw bad('roll a successful attack with this weapon first');
    if (st.rolls.some((r) => r.weaponHitId === hit.id && !r.void)) throw bad('damage for that attack was already rolled');
    return SHEET.roll(st, a, { ...ctx, weaponHitId: hit.id }, out);
  }
  // The reducer commits both changes together. Invalid rolls never cost an action.
  requireStatusAllowed(st, ctx, st.players.find((p) => p.id === me.playerId), 'action');
  spendReactionAction(rx, me.uid, 1, { attack: true });
  SHEET.roll(st, a, { ...ctx, actionReceipt: { combatId: rx.combatId, round: rx.round, uid: me.uid } }, out);
  out.result.receipt = actionReceipt(rx, me.uid, 1);
};

function castSpell(st, a, ctx, out) {
  const rx = st.combat?.active && st.combat.rx;
  const action = { result: null };
  if (rx && ctx.actor.role === 'player' && ctx.pack.ruleset.spells.attackChecks) {
    const p = st.players.find((x) => x.id === ctx.actor.playerId);
    const spell = p?.sheet?.spells?.find((s) => s.uid === a.uid);
    const def = spell && libraryOf(st, ctx.pack).get('spell', spell.spellId);
    if (rx.step !== 'act' && (rx.step !== 'react' || (!def?.healing && !def?.tags?.includes('interrupt')))) throw bad('that spell cannot be cast in this phase');
    if (ctx.pack.ruleset.hotlist.combat) requireCombatHotlist(st, ctx, a.uid);
    REACTION_PLAYER['rx.spend'](st, {}, ctx, action);
  }
  SHEET['spell.cast'](st, a, ctx, out);
  if (action.result) out.result.receipt = action.result.receipt;
  const healed = out.result?.healed;
  const target = healed && st.combat?.combatants.find((x) => x.playerId === healed.playerId);
  if (target && healed.to > 0) dyingTick(st, ctx, out, 'heal', target.uid);
}
PLAYER['spell.cast'] = GM['spell.cast'] = castSpell;

PLAYER['hotlist.set'] = (st, a, ctx, out) => {
  const rx = st.combat?.active && st.combat.rx;
  const action = { result: null };
  if (rx && ctx.pack.ruleset.hotlist.combat && a.uid != null) {
    if (rx.step !== 'act') throw bad('you can prepare your Hotlist during crawler actions');
    REACTION_PLAYER['rx.spend'](st, {}, ctx, action);
  }
  SHEET['hotlist.set'](st, a, ctx, out);
  if (action.result) out.result = { ...out.result, receipt: action.result.receipt };
};

function useItem(st, a, ctx, out) {
  const rx = st.combat?.active && st.combat.rx;
  const action = { result: null };
  const hotlist = ctx.pack.ruleset.hotlist;
  const playerId = ctx.actor.role === 'player' ? ctx.actor.playerId : a.playerId;
  const p = st.players.find((x) => x.id === playerId);
  const inv = p?.inventory.find((i) => i.uid === a.uid);
  const def = rx && hotlist.combat && inv && libraryOf(st, ctx.pack).get('item', inv.itemId);
  const hp = ctx.pack.ruleset.tracks.find((t) => t.kind === 'slots')?.id;
  const potion = def?.tags?.includes('potion');
  if (def && ctx.actor.role === 'player') {
    if (rx.step !== 'act' && (rx.step !== 'react' || !potion || def.use?.heal?.track !== hp)) throw bad('you cannot use this item in this phase');
    requireCombatHotlist(st, ctx, a.uid);
    REACTION_PLAYER['rx.spend'](st, {}, ctx, action);
  }
  SHEET['item.use'](st, a, ctx, out);
  if (action.result) out.result.receipt = action.result.receipt;
  const healed = out.result?.healed;
  const target = healed?.track === hp && st.combat?.combatants.find((x) => x.playerId === healed.playerId);
  if (target && healed.to > 0) dyingTick(st, ctx, out, 'heal', target.uid);
  if (potion && hotlist.potionSickness) {
    const drinker = a.target ?? p.id;
    const last = rx.potionRounds?.[drinker];
    rx.potionRounds = { ...rx.potionRounds, [drinker]: rx.round };
    if (Number.isInteger(last) && rx.round - last < 2) {
      const sub = { ...out, result: undefined };
      SHEET_GM['buff.add'](st, { playerId: drinker, buffId: hotlist.potionSickness }, { ...ctx, actor: { role: 'gm' } }, sub);
      const buff = st.players.find((x) => x.id === drinker).sheet.buffs.find((b) => b.uid === sub.result.uid);
      buff.roundsLeft = 2;
      out.result.potionSickness = true;
    }
  }
}
PLAYER['item.use'] = GM['item.use'] = useItem;

/**
 * Ruleset `combat.starterAttack` (e.g. Unarmed Combat rank 3, 1d4 + Str): a crawler with no attack gets it, so
 * nobody stands in a fight with nothing to do. Runs on player.add and on combat.start (older characters).
 */
function giveStarterAttack(st, p, ctx) {
  const sa = ctx.pack?.ruleset?.combat?.starterAttack;
  if (!sa || (p.sheet?.attacks ?? []).length) return;
  const sub = { result: undefined, events: [], emit() {}, changed: true };
  let skillUid = null;
  if (sa.skill) {
    const have = (p.sheet.skills ?? []).find((s) => (s.skillId ?? s.id) === sa.skill);
    if (have) skillUid = have.uid;
    else {
      try { GM['lib.give'](st, { playerId: p.id, kind: 'skill', id: sa.skill, rank: sa.rank }, ctx, sub); skillUid = sub.result?.uid ?? null; } catch {}
    }
  }
  try { GM['attack.add'](st, { playerId: p.id, name: sa.name, dice: sa.dice, ...(sa.stat ? { stat: sa.stat } : {}), ...(skillUid ? { skillUid } : {}) }, ctx, sub); } catch {}
}
{
  // Dying (ruleset combat.dyingRounds): reaching 0 starts the countdown; a hit while dying takes a round off.
  const dmg = GM['combat.damage'];
  GM['combat.damage'] = (st, a, ctx, out) => {
    const x = st.combat?.combatants?.find((c) => c.uid === a.uid);
    const wasDying = x?.type === 'crawler' && x.dying != null;
    const beforeDying = x?.dying ?? null;
    const beforeDead = !!x?.dead;
    const downs = st.combat?.stats?.downs?.[x?.playerId] ?? 0;
    dmg(st, a, ctx, out);
    if (!out.result?.blocked) onCrawlerDamage(st, ctx, out, x, wasDying);
    if (x?.type !== 'crawler') return;
    const hit = out.result;
    const outcome = !beforeDead && x.dead ? 'Dead'
      : hit?.hp === 0 && hit.actualAmount > 0 ? (x.dying != null ? 'Dying' : 'Down') : null;
    if (outcome) {
      const token = JSON.stringify([st.combat.id, x.uid, hit.actualAmount, hit.amount, beforeDying, x.dying, outcome]);
      if (a.confirmHit !== token) {
        // reduce() works on a draft. Discard the trial hit and all its broadcasts together.
        out.changed = false;
        out.events.length = out.lines.length = out.effects.length = 0;
        out.result = { confirmHit: token, outcome, name: st.players.find((p) => p.id === x.playerId)?.name, amount: hit.actualAmount };
        return;
      }
    } else if (a.confirmHit != null) {
      throw bad('the target changed; review the hit again');
    }
    const entry = st.combat.manualUndo?.at(-1);
    if (out.changed && entry?.snap.crawler) {
      entry.snap.crawler.life = {
        beforeDying, beforeDead, afterDying: x.dying ?? null, afterDead: !!x.dead,
        taken: hit.actualAmount, downs: (st.combat.stats.downs[x.playerId] ?? 0) - downs,
      };
    }
  };
  const heal = GM['combat.heal'];
  if (heal) GM['combat.heal'] = (st, a, ctx, out) => { heal(st, a, ctx, out); const x = st.combat?.combatants?.find((c) => c.uid === a.uid); if (x?.type === 'crawler') dyingTick(st, ctx, out, 'heal', x.uid); };
}
{
  // Injuries marked during the fight become debuffs on the sheets when it ends.
  const end = GM['combat.end'];
  GM['combat.end'] = (st, a, ctx, out) => {
    const inj = ctx.pack.ruleset.combat?.injuries;
    const party = new Set((st.combat?.combatants ?? []).filter((x) => x.type === 'crawler').map((x) => x.playerId));
    const marks = inj ? (st.combat?.combatants ?? []).filter((x) => x.type === 'crawler' && x.injuries?.length).map((x) => [x.playerId, x.injuries]) : [];
    prepareEndLoot(st, ctx, a.outcome);
    end(st, a, ctx, out);
    const sickness = ctx.pack.ruleset.hotlist.potionSickness;
    if (sickness) for (const p of st.players) p.sheet.buffs = p.sheet.buffs.filter((b) => b.buffId !== sickness);
    const remaining = new Set(st.combat.combatants.map((m) => m.uid));
    for (const map of st.maps?.list ?? []) {
      map.tokens = map.tokens.filter((t) => !t.combatToken || remaining.has(t.ref));
      for (const t of map.tokens) if (t.kind === 'mob' && t.ref && !remaining.has(t.ref)) { t.ref = null; t.hidden = true; }
    }
    const lib = libraryOf(st, ctx.pack);
    for (const p of st.players) if (party.has(p.id)) p.sheet.buffs = p.sheet.buffs.filter((b) => !lib.get('buff', b.buffId)?.endCombat);
    for (const m of st.combat.combatants) if (m.type === 'mob') m.conditions = (m.conditions ?? []).filter((c) => !lib.get('buff', c.id)?.endCombat);
    for (const [pid, list] of marks) {
      const p = st.players.find((y) => y.id === pid);
      if (!p) continue;
      for (const mark of list) {
        const kind = typeof mark === 'string' ? mark : mark?.severity;
        if (!['minor', 'major'].includes(kind)) continue;
        const has = (id) => id && p.sheet.buffs.some((b) => b.buffId === id);
        const long = kind === 'major' ? inj.majorLong : inj.minorLong;
        const base = kind === 'major' ? inj.major : inj.minor;
        let give = base;
        if (has(base) && long) { p.sheet.buffs = p.sheet.buffs.filter((b) => b.buffId !== base); give = long; }
        if (!lib.get('buff', give) || has(give)) continue;
        const desc = typeof mark?.desc === 'string' ? mark.desc.slice(0, 180) : '';
        GM['buff.add'](st, { playerId: pid, buffId: give, injuryDescription: desc }, ctx, { ...out, result: null });
        out.emit({ kind: 'injury', playerId: pid, name: p.name, injury: lib.get('buff', give).name, ...(desc ? { desc } : {}) }, 'all');
      }
    }
  };
}
{
  const start = GM['combat.start'];
  GM['combat.start'] = (st, a, ctx, out) => {
    for (const p of st.players) giveStarterAttack(st, p, ctx);
    // Remember what the TV showed before the fight, so the GM can go back in one tap afterwards.
    if (st.scene && !['combat', 'finale', 'blank', 'lobby'].includes(st.scene.kind)) st.sceneBeforeFight = { kind: st.scene.kind, data: structuredClone(st.scene.data ?? {}) };
    start(st, a, ctx, out);
    // Reaction-round rulesets start round 1 at once (no initiative, the GM never rolls a d20).
    if (ctx.pack?.ruleset?.combat?.flow === 'reaction' && st.combat?.active) REACTION_GM['rx.start'](st, {}, ctx, out);
  };
}

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

Object.assign(SYSTEM, CRAWLERS_SYSTEM);

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
    // The campaign's ruleset applied to the pack (idempotent when the host already passes it).
    pack: ctx?.pack ? packOf(state, ctx.pack) : ctx?.pack,
    // Who is acting: never taken from the payload for players (actorId is set by the host).
    actor: { role: action.role, playerId: action.role === 'player' ? action.actorId : null },
    h: { feedPush, categoryLine, bumpPct, onSheetRoll, applyDamage: applyMobDamage, syncBossHealth, spendReactionAction },
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
  if (out.changed && st.combat?.mapId && ['map.bindCombat', 'map.toFight', 'enc.run', 'prep.scene.run', 'combat.addMob', 'combat.addAdhoc', 'combat.start', 'combat.addCrawler', 'combat.remove', 'combat.undo', 'player.add', 'player.remove'].includes(action.t)) {
    syncCombatTokens(st, full);
  }
  if (out.changed && full.pack && (combatDangerAffected(action) || action.t === 'prep.scene.run')) refreshCombatDanger(st, full.pack);
  if (out.changed && full.pack) recordCombatHistory(state, st, action, out, full);
  // Play clock: time between actions counts as play when the gap is under 15 minutes (breaks don't count).
  // Drives the level-up reminder (DCC: a level every 2 hours of play; nothing happens automatically).
  if (out.changed && action.role !== 'system' && st.session) {
    const last = st.session.lastActAt ?? 0;
    const gap = full.now - last;
    if (last && gap > 0 && gap < PLAY_GAP_MS) st.session.playMs = (st.session.playMs ?? 0) + gap;
    st.session.lastActAt = full.now;
  }
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
  // A crawler created later does not get the group messages sent before they existed.
  const joined = state.players.find((p) => p.id === playerId)?.joinedAt ?? 0;
  return state.messages
    .filter((m) => addressedTo(m, playerId) && !(isGroup(m.to) && m.at < joined))
    .slice(-PLAYER_MESSAGES)
    .map((m) => ({
      id: m.id, at: m.at, from: m.from, fromId: m.fromId, text: m.text, icon: m.icon, to: m.to, thread: threadOf(m.to),
      reactions: m.reactions, group: isGroup(m.to), read: m.readBy.includes(playerId),
    }));
}

function fullPlayer(state, p, pack, library) {
  const messages = messagesFor(state, p.id);
  const sheet = sheetView(p, pack, library, state);
  const { stats, resources } = legacyStats(p, pack, sheet.computed);
  return {
    id: p.id, name: p.name, color: p.color, level: p.level,
    title: p.title, klass: p.klass, race: p.race, diceMode: DICE_MODES.includes(p.diceMode) ? p.diceMode : 'enter', // default: type the physical die (the table rolls real dice)
    stats, resources, gold: p.gold, notes: p.notes,
    inventory: enrichInventory(p.inventory, library), achievements: p.achievements,
    sheet,
    ...(p.levelGrants?.length ? { levelGrants: p.levelGrants } : {}),
    secrets: messages.filter((m) => !m.group).map(({ id, at, from, text, read }) => ({ id, at, from, text, read })), // legacy shape
    messages,
  };
}

function common(state, pack, opts) {
  const { session: s, audience: a } = state;
  return {
    room: state.room,
    campaign: state.campaign ? { id: state.campaign.id, name: state.campaign.name, ruleset: state.campaign.ruleset } : null,
    session: {
      id: s.id, startedAt: s.startedAt, mode: s.mode, auto: s.auto, aiMute: !!s.aiMute, hold: !!s.hold, budgetLeft: s.budgetLeft, voice: s.voice, chatPlayers: s.chatPlayers !== false,
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
      cheats: (pack.cheats ?? []).filter((c) => opts.role === 'gm' || c.audience === 'player'),
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
 * queue:{queue,pendingAuto,playing}, aiAvailable, aiCallsLeft, stageOn (crawler count interpolation; default true) }
 */
export function viewFor(state, basePack, role, opts = {}) {
  const pack = packOf(state, basePack);
  const now = opts.now ?? Date.now();
  const v = common(state, pack, { ...opts, now, role });
  const q = opts.queue ?? { queue: [], pendingAuto: [], playing: null };
  const library = libraryOf(state, pack);
  v.rolls = rollsFor(state, role, opts.playerId);
  v.combat = combatView(state, pack, role, opts.playerId);
  if (v.combat) v.combat.rx = reactionView(state, role, pack);
  v.crawlers = crawlersView(state, pack, role, now, opts.stageOn !== false);
  v.maps = mapsView(state, role, library, v.combat);
  if (role === 'player') {
    const p = state.players.find((x) => x.id === opts.playerId);
    v.me = p ? fullPlayer(state, p, pack, library) : null;
    v.combat.history = p ? combatHistoryFor(state, p.id) : [];
    v.checkPrompts = p ? prepChecksFor(state, p.id) : [];
    v.library = playerLibrary(state, pack, library, p ?? null);
  } else if (role === 'stage') {
    v.library = playerLibrary(state, pack, library, null);
    v.joinUrl = opts.urls?.join ?? '';
    v.queueLength = q.queue.length + (q.playing ? 1 : 0);
  } else if (role === 'gm') {
    const cats = [...new Set([...STANDARD_CATEGORIES, ...pack.quipsByCategory.keys()])];
    v.gm = {
      loot: lootOverview(state, pack), // C1b: Loot tab (ratings, modes, pending boxes, policy, campaign settings)
      origins: originsFor(pack), // content source badges (Library, Prep picker, mob cards)
      // Level-up reminder (gm.js): minutes of play, since the last party level-up, snoozed until.
      playClock: { playMin: Math.floor((state.session.playMs ?? 0) / 60_000), sinceLevelMin: Math.floor(((state.session.playMs ?? 0) - (state.session.levelAtMs ?? 0)) / 60_000), snoozeMin: state.session.levelSnoozeMs != null ? Math.ceil(state.session.levelSnoozeMs / 60_000) : null },
      advancementClock: advancementClockView(state.session, pack.ruleset, now),
      joinUrl: opts.urls?.join ?? '',
      stageUrl: opts.urls?.stage ?? '',
      gmUrl: opts.urls?.gm ?? '',
      pins: Object.fromEntries(state.players.map((p) => [p.id, p.pin])),
      playersFull: state.players.map((p) => ({ ...fullPlayer(state, p, pack, library), userId: p.userId ?? null })),
      prepCards: state.prepCards,
      prepChecks: (state.prepChecks ?? []).filter((q) => q.sessionId === state.session.id),
      prep: prepView(state, pack),
      sceneBeforeFight: state.sceneBeforeFight ?? null,
      messages: state.messages.slice(-GM_MESSAGES).map((m) => ({
        id: m.id, at: m.at, from: m.from, fromId: m.fromId, text: m.text, icon: m.icon, to: m.to, thread: threadOf(m.to),
        group: isGroup(m.to), onStage: m.onStage, readBy: m.readBy, reactions: m.reactions, gmRead: m.gmRead,
      })),
      quipCategories: cats.map((id) => ({
        id,
        label: categoryLabel(id),
        left: quipsLeft(pack, state.usedQuips, id),
        total: categoryPool(pack, id).length,
      })),
      achievementsCatalog: pack.achievements.map(({ id, title, desc, reward, group, box }) => ({ id, title, desc, reward, group, ...(box ? { box } : {}) })),
      iconLib: pack.iconLib ?? [], // icon library for the custom-item picker
      itemsCatalog: library.list('item').map(({ id, name, rarity, desc, flavor, slot, stackable, source, attack, effects }) => ({ id, name, rarity, desc, flavor, slot, stackable, source, enhanceable: !!attack || (effects ?? []).some((e) => e.target === 'armor') })),
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
