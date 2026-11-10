// Character sheets (RULESET v2): storage shape, migration, sheet/roll/library actions, sheet views.
// Browser-safe. See docs/RULESET.md and docs/PROTOCOL.md.
import { ActionError, bad, notFound, forbidden } from './errors.js';
import { computeSheet, makeLibrary, normalizeLibEntry, normalizeEffects, sheetResolver, tmpl, RulesetError, LIB_KINDS, ID_RE } from './ruleset.js';
import { rollDice, validateFormula, evaluate, FormulaError } from './formula.js';

export const MAX_ROLLS = 200;
export const VIEW_ROLLS = 50;
export const PLAYER_EDIT = ['none', 'notes', 'sheet'];
export const MAX_SKILLS = 100;
export const MAX_ATTACKS = 50;
export const MAX_SPELLS = 200;
export const MAX_BUFFS = 50;
export const MAX_INVENTORY = 500;
export const MAX_LIB_PER_KIND = 500;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const safeKey = (k) => typeof k === 'string' && ID_RE.test(k) && !FORBIDDEN_KEYS.has(k);
const own = (o, k) => isObj(o) && Object.hasOwn(o, k);

// ---------- storage shape ----------

function statValue(raw, def) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Object.fromEntries(def.parts.map((p) => [p, raw]));
  const o = {};
  for (const p of def.parts) o[p] = isObj(raw) ? finite(raw[p], def.default[p] ?? 0) : def.default[p] ?? 0;
  return o;
}

function trackValue(raw, t) {
  const dflt = t.kind === 'slots' ? { cur: Math.min(t.default || t.slots, t.slots), max: t.slots } : { cur: t.default, max: t.default };
  if (!isObj(raw)) return dflt;
  return { cur: finite(raw.cur, dflt.cur), max: finite(raw.max, dflt.max) };
}

function cleanMap(raw, maxLen = 4000) {
  const o = {};
  if (!isObj(raw)) return o;
  for (const [k, v] of Object.entries(raw)) {
    if (!safeKey(k)) continue;
    if (typeof v === 'string') o[k] = v.slice(0, maxLen);
    else if (typeof v === 'number' && Number.isFinite(v)) o[k] = v;
  }
  return o;
}

/** A new character sheet for `ruleset` (stored as player.sheet). */
export function freshSheet(ruleset) {
  return migrateSheet({}, {}, ruleset);
}

/**
 * Builds/repairs player.sheet. `legacy` = { stats, resources } from pre-v2 saves: flat stat numbers
 * become {part: n} for every part, resources become tracks. Unknown stat/track ids are kept.
 */
export function migrateSheet(sheet, legacy, ruleset) {
  const s = isObj(sheet) ? sheet : {};
  const stats = {};
  const oldStats = { ...(isObj(legacy.stats) ? legacy.stats : {}), ...(isObj(s.stats) ? s.stats : {}) };
  for (const [k, v] of Object.entries(oldStats)) if (safeKey(k) && (typeof v === 'number' || isObj(v))) stats[k] = v;
  for (const def of ruleset.stats) stats[def.id] = statValue(stats[def.id], def);
  const tracks = {};
  const oldTracks = { ...(isObj(legacy.resources) ? legacy.resources : {}), ...(isObj(s.tracks) ? s.tracks : {}) };
  for (const [k, v] of Object.entries(oldTracks)) if (safeKey(k) && isObj(v)) tracks[k] = { cur: finite(v.cur, 0), max: finite(v.max, 0) };
  for (const t of ruleset.tracks) tracks[t.id] = trackValue(tracks[t.id], t);
  const size = ruleset.hotlist.size;
  const hot = Array.isArray(s.hotlist) ? s.hotlist.slice(0, size).map((x) => (typeof x === 'string' ? x : null)) : [];
  while (hot.length < size) hot.push(null);
  const arr = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
  return {
    identity: cleanMap(s.identity, 200),
    stats,
    fields: cleanMap(s.fields),
    tracks,
    skills: arr(s.skills).map((k) => ({ uid: k.uid, skillId: k.skillId ?? null, name: k.name ?? '', rank: finite(k.rank, 0), stat: k.stat ?? '', checkType: k.checkType ?? '', notes: k.notes ?? '', used: !!k.used })),
    attacks: arr(s.attacks).map((k) => ({ uid: k.uid, name: k.name ?? '', skillUid: k.skillUid ?? null, stat: k.stat ?? '', dice: k.dice ?? '', effects: k.effects ?? '' })),
    spells: arr(s.spells).map((k) => ({ uid: k.uid, spellId: k.spellId, rank: finite(k.rank, 1), active: !!k.active })),
    hotlist: hot,
    buffs: arr(s.buffs).map((b) => ({ uid: b.uid, buffId: b.buffId ?? null, name: b.name ?? 'Buff', desc: b.desc ?? '', external: !!b.external, effects: Array.isArray(b.effects) ? b.effects : [], until: b.until ?? '', at: finite(b.at, 0) })),
    story: cleanMap(s.story),
    portrait: typeof s.portrait === 'string' ? s.portrait : null,
  };
}

/** Repairs inventory entries (v2 adds qty / notes / equippedSlot). */
export function migrateInventory(inv, ruleset) {
  const slots = new Set(ruleset.slots.map((x) => x.id));
  return (Array.isArray(inv) ? inv.filter(isObj) : []).map((i) => ({
    ...i,
    qty: Number.isInteger(i.qty) && i.qty >= 0 ? i.qty : 1,
    notes: typeof i.notes === 'string' ? i.notes : '',
    equippedSlot: typeof i.equippedSlot === 'string' && slots.has(i.equippedSlot) ? i.equippedSlot : null,
  }));
}

/** Inventory entry from a library item. */
export function invItem(item, ctx) {
  return {
    uid: ctx.genId('i'),
    itemId: item.id,
    name: item.name,
    desc: item.desc,
    flavor: item.flavor ?? '',
    rarity: item.rarity,
    image: item.image ?? null,
    at: ctx.now,
    qty: 1,
    notes: '',
    equippedSlot: null,
  };
}

/** Adds an item to a player's inventory; stackable items merge into an existing stack. */
export function giveItem(p, item, ctx, qty = 1) {
  if (item.stackable) {
    const stack = p.inventory.find((i) => i.itemId === item.id);
    if (stack) {
      stack.qty += qty;
      return stack;
    }
  }
  if (p.inventory.length >= MAX_INVENTORY) throw bad(`max ${MAX_INVENTORY} inventory entries`);
  const inv = invItem(item, ctx);
  inv.qty = qty;
  p.inventory.push(inv);
  return inv;
}

export function emptyHomebrew() {
  return Object.fromEntries(LIB_KINDS.map((k) => [k, []]));
}

export function normalizeHomebrew(raw) {
  const out = emptyHomebrew();
  if (!isObj(raw)) return out;
  for (const k of LIB_KINDS) {
    if (!Array.isArray(raw[k])) continue;
    out[k] = raw[k].map((e) => normalizeLibEntry(k, e, { source: 'homebrew' })).filter(Boolean).slice(0, MAX_LIB_PER_KIND);
  }
  return out;
}

export function libraryOf(state, pack) {
  return makeLibrary(pack, state.library);
}

// ---------- composed character (single source of truth: name/level/race/klass/notes live on the player) ----------

/** Raw character as the views and computeSheet see it. */
export function characterOf(p, ruleset) {
  const sh = p.sheet;
  const identity = { ...sh.identity, name: p.name, level: p.level, race: p.race ?? '', class: p.klass ?? '' };
  const story = { ...sh.story, notes: p.notes ?? '' };
  for (const k of ruleset.storyFields) if (!own(story, k)) story[k] = '';
  const idKeys = new Set(ruleset.identity);
  const storyKeys = new Set(ruleset.storyFields);
  const fields = {};
  for (const f of ruleset.fields) {
    if (idKeys.has(f.id) && own(identity, f.id)) fields[f.id] = identity[f.id];
    else if (storyKeys.has(f.id) || f.id === 'notes') fields[f.id] = story[f.id] ?? f.default;
    else fields[f.id] = own(sh.fields, f.id) ? sh.fields[f.id] : f.default;
  }
  for (const f of ruleset.fields) if (idKeys.has(f.id) && !own(identity, f.id)) identity[f.id] = fields[f.id];
  return {
    name: p.name,
    level: p.level,
    identity,
    stats: sh.stats,
    fields,
    tracks: sh.tracks,
    skills: sh.skills,
    attacks: sh.attacks,
    spells: sh.spells,
    inventory: p.inventory,
    hotlist: sh.hotlist,
    buffs: sh.buffs,
    story,
    portrait: sh.portrait,
  };
}

export function computeFor(p, pack, library) {
  const ch = characterOf(p, pack.ruleset);
  return { ch, computed: computeSheet(ch, pack.ruleset, library) };
}

export function enrichInventory(inv, library) {
  return inv.map((i) => {
    const def = library.get('item', i.itemId);
    if (!def) return { ...i, slot: null, stackable: false, effects: [], attack: null, use: null, source: null, missing: true };
    return {
      ...i,
      name: def.name, desc: def.desc, flavor: def.flavor ?? '', rarity: def.rarity, image: def.image ?? i.image ?? null,
      slot: def.slot ?? null, stackable: !!def.stackable, effects: def.effects ?? [], attack: def.attack ?? null, use: def.use ?? null, tags: def.tags ?? [], source: def.source,
    };
  });
}

/** View shape: raw character (enriched with library data) + `computed`. */
export function sheetView(p, pack, library) {
  const { ch, computed } = computeFor(p, pack, library);
  const spells = ch.spells.map((s) => {
    const def = library.get('spell', s.spellId);
    if (!def) return { ...s, name: s.spellId, missing: true };
    const { id, ...rest } = def;
    return { ...rest, ...s };
  });
  return { ...ch, inventory: enrichInventory(ch.inventory, library), spells, computed };
}

/** Legacy v1 view fields derived from the sheet. */
export function legacyStats(p, pack, computed) {
  const from = pack.ruleset.statMod.from;
  const stats = {};
  for (const def of pack.ruleset.stats) {
    const v = p.sheet.stats[def.id];
    stats[def.id] = isObj(v) ? finite(v[from] ?? v[def.parts[0]], 0) : finite(v, 0);
  }
  const resources = {};
  for (const t of pack.ruleset.tracks) resources[t.id] = { cur: computed.tracks[t.id].cur, max: computed.tracks[t.id].max };
  return { stats, resources };
}

/** Library entries a player may see: everything their sheet references + builder lists. */
export function playerLibrary(state, pack, library, p) {
  const out = emptyHomebrew();
  const add = (kind, id) => {
    const e = library.get(kind, id);
    if (e && !out[kind].some((x) => x.id === e.id)) out[kind].push(e);
  };
  for (const kind of ['skill', 'race', 'class', 'background']) out[kind] = library.list(kind);
  for (const kind of ['race', 'class', 'background']) for (const e of out[kind]) for (const f of e.features ?? []) add('feature', f);
  if (p) {
    for (const i of p.inventory) {
      add('item', i.itemId);
      const def = library.get('item', i.itemId);
      if (def?.use?.applyBuff) add('buff', def.use.applyBuff);
      if (def?.use?.removeBuff) add('buff', def.use.removeBuff);
      if (def?.use?.buffOnFail) add('buff', def.use.buffOnFail);
    }
    for (const s of p.sheet.spells) {
      add('spell', s.spellId);
      const def = library.get('spell', s.spellId);
      if (def?.applies) add('buff', def.applies);
    }
    for (const b of p.sheet.buffs) if (b.buffId) add('buff', b.buffId);
  }
  return out;
}

export function gmLibrary(library) {
  return Object.fromEntries(LIB_KINDS.map((k) => [k, library.list(k)]));
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

function num(v, field, { optional = false, max = 1e6 } = {}) {
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > max) throw bad(`${field} must be a number`);
  return v;
}

function bool(v, field, { optional = false } = {}) {
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'boolean') throw bad(`${field} must be a boolean`);
  return v;
}

function playerOf(st, id) {
  if (typeof id !== 'string') throw bad('playerId required');
  const p = st.players.find((x) => x.id === id);
  if (!p) throw notFound(`no player ${id}`);
  return p;
}

function statOpt(v, ruleset, field = 'stat') {
  if (v === undefined) return undefined;
  if (v === '' || v === null) return '';
  if (typeof v !== 'string' || !ruleset.stats.some((s) => s.id === v)) throw bad(`${field} must be a stat id (${ruleset.stats.map((s) => s.id).join(', ')}) or ""`);
  return v;
}

function diceOpt(v, field) {
  if (v === undefined) return undefined;
  if (v === '' || v === null) return '';
  const d = str(v, field, 60);
  const err = validateFormula(d, { dice: true });
  if (err) throw bad(`${field}: ${err}`);
  return d;
}

const LEVELS = { none: 0, notes: 1, sheet: 2 };

/**
 * Resolves the character an action applies to and enforces permissions.
 * need: 'gm' | 'sheet' | 'notes' | 'play' (play = rolls, casting, using items: always allowed for own character).
 * Players can never target another character: a payload playerId must equal the authenticated actor.
 */
export function targetOf(st, a, ctx, need) {
  if (ctx.actor.role === 'gm') return playerOf(st, a.playerId);
  if (need === 'gm') throw forbidden('GM only');
  if (a.playerId !== undefined && a.playerId !== ctx.actor.playerId) throw forbidden('players may only act on their own character');
  const p = playerOf(st, ctx.actor.playerId);
  const level = LEVELS[st.session.permissions?.playerEdit ?? 'sheet'] ?? 2;
  if (need === 'sheet' && level < 2) throw forbidden('the GM has locked sheet editing');
  if (need === 'notes' && level < 1) throw forbidden('the GM has locked sheet editing');
  return p;
}

export function requireNotes(st, ctx) {
  if (ctx.actor.role === 'gm') return;
  const level = LEVELS[st.session.permissions?.playerEdit ?? 'sheet'] ?? 2;
  if (level < 1) throw forbidden('the GM has locked sheet editing');
}

function findUid(list, uid, what) {
  if (typeof uid !== 'string') throw bad('uid required');
  const x = list.find((e) => e.uid === uid);
  if (!x) throw notFound(`no ${what} ${uid}`);
  return x;
}

function portraitValue(v) {
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw bad('portrait must be a URL string or null');
  if (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v)) {
    if (v.length > 200_000) throw bad('portrait image too large (max ~150 KB)');
    return v;
  }
  if (/^(https?:\/\/|\/pack\/)[^\s"'<>]{1,2000}$/.test(v)) return v;
  throw bad('portrait must be an http(s) URL, a /pack/ path or a data:image URL');
}

// ---------- buffs ----------

function buffFromDef(def, ctx) {
  return { uid: ctx.genId('b'), buffId: def.id, name: def.name, desc: def.desc ?? '', external: !!def.external, effects: def.effects ?? [], until: def.duration ?? '', at: ctx.now };
}

/** Adds a buff (enforcing the external cap). Library buffs never stack: same buffId → existing entry. */
function addBuff(p, buff, ruleset) {
  if (buff.buffId) {
    const have = p.sheet.buffs.find((b) => b.buffId === buff.buffId);
    if (have) return { buff: have, added: false };
  }
  if (p.sheet.buffs.length >= MAX_BUFFS) throw bad(`max ${MAX_BUFFS} buffs`);
  const cap = ruleset.buffSlots.external.max;
  if (buff.external && cap !== null && p.sheet.buffs.filter((b) => b.external).length >= cap) {
    throw bad(`${p.name} already has ${cap} external buffs (cap ${cap})`);
  }
  p.sheet.buffs.push(buff);
  return { buff, added: true };
}

function removeInv(p, uid) {
  p.inventory = p.inventory.filter((i) => i.uid !== uid);
  p.sheet.hotlist = p.sheet.hotlist.map((x) => (x === uid ? null : x));
}

function trackDelta(p, pack, library, track, delta, out) {
  const { computed } = computeFor(p, pack, library);
  const c = computed.tracks[track];
  const from = c.cur;
  const to = Math.max(0, Math.min(c.max, from + delta));
  p.sheet.tracks[track] = { ...(p.sheet.tracks[track] ?? { max: c.max }), cur: to };
  if (to !== from) out.emit({ kind: 'stat', playerId: p.id, stat: track, resource: true, from, to, max: c.max }, { roles: ['gm', 'stage'], playerId: p.id });
  return { track, from, to, max: c.max };
}

// ---------- rolls ----------

function pushRoll(st, rec, out, ctx) {
  st.rolls.push(rec);
  if (st.rolls.length > MAX_ROLLS) st.rolls = st.rolls.slice(-MAX_ROLLS);
  const to = rec.secret ? { roles: ['gm'], ...(rec.by !== 'gm' ? { playerId: rec.by } : {}) } : 'all';
  out.emit({ kind: 'roll', ...rec }, to);
  if (!rec.secret && (rec.nat1 || rec.nat20) && ctx.h?.categoryLine) {
    const line = ctx.h.categoryLine(st, ctx, rec.nat20 ? 'nat20' : 'nat1', 1);
    if (line) out.lines.push(line);
  }
}

function rollRecord(r, { ctx, p, by, label, formula, secret, what }) {
  return {
    id: ctx.genId('r'),
    at: ctx.now,
    playerId: p?.id ?? null,
    by,
    what,
    label,
    formula,
    dice: r.dice.flatMap((d) => d.rolls.map((value) => ({ die: `d${d.sides}`, value }))),
    total: r.total,
    breakdown: { value: r.total, parts: r.parts, warnings: r.warnings },
    secret: !!secret,
    nat1: r.nat1,
    nat20: r.nat20,
  };
}

function doRoll(src, resolve, ctx) {
  try {
    return rollDice(src, { resolve, randInt: ctx.rollInt ?? ctx.randInt });
  } catch (e) {
    if (e instanceof FormulaError) throw bad(`bad roll formula: ${e.message}`);
    throw e;
  }
}

/** Rolls `dice` + a precomputed breakdown (shown as one labelled part with its sub-parts). */
function rollWith(dice, bd, label, ctx, source) {
  const r = doRoll(`${dice} + __bonus`, (n) => (n === '__bonus' ? { value: bd.value, label, parts: bd.parts } : undefined), ctx);
  r.parts = r.parts.map((x) => (x.source === '__bonus' ? { ...x, source } : x));
  r.warnings = [...r.warnings, ...(bd.warnings ?? [])];
  const sign = bd.value < 0 ? '-' : '+';
  return { r, formula: bd.value ? `${dice}${sign}${Math.abs(bd.value)}` : dice };
}

// ---------- actions ----------

function setPath(p, path, value, pack, out) {
  const ruleset = pack.ruleset;
  if (typeof path !== 'string' || path.length > 200) throw bad('path must be a string');
  const seg = path.split('.');
  if (!seg.every(safeKey)) throw bad(`bad path ${JSON.stringify(path)}`);
  const [root, key, part] = seg;
  const idKeys = new Set([...ruleset.identity, 'name', 'level', 'race', 'class', 'floor', 'pronouns']);
  const storyKeys = new Set([...ruleset.storyFields, 'notes']);
  const fieldDef = (id) => ruleset.fields.find((f) => f.id === id);
  const textFor = (id, v, max) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return str(v, id, max, { allowEmpty: true });
  };
  const setIdentity = (k, v) => {
    if (k === 'name') p.name = str(v, 'name', 40);
    else if (k === 'level') p.level = int(v, 'level', 0, 9999);
    else if (k === 'race') p.race = str(v, 'race', 40, { allowEmpty: true });
    else if (k === 'class') p.klass = str(v, 'class', 40, { allowEmpty: true });
    else if (k === 'portrait') p.sheet.portrait = portraitValue(v);
    else {
      const f = fieldDef(k);
      p.sheet.identity[k] = f?.type === 'number' ? num(v, k) : textFor(k, v, 200);
    }
  };
  const setStory = (k, v) => {
    if (k === 'notes') {
      if (typeof v !== 'string') throw bad('notes must be a string');
      if (v.length > 2000) throw bad('notes too long (max 2000)');
      p.notes = v;
    } else {
      if (typeof v !== 'string') throw bad(`${k} must be a string`);
      if (v.length > 4000) throw bad(`${k} too long (max 4000)`);
      p.sheet.story[k] = v;
    }
  };
  if (root === 'portrait' && seg.length === 1) return void (p.sheet.portrait = portraitValue(value));
  if (seg.length < 2) throw bad(`bad path ${JSON.stringify(path)}`);
  if (root === 'identity' && seg.length === 2) {
    if (!idKeys.has(key)) throw bad(`identity.${key} is not in the ruleset identity list`);
    return setIdentity(key, value);
  }
  if (root === 'story' && seg.length === 2) {
    if (!storyKeys.has(key)) throw bad(`story.${key} is not a story field`);
    return setStory(key, value);
  }
  if (root === 'fields' && seg.length === 2) {
    const f = fieldDef(key);
    if (!f) throw bad(`unknown field ${key}`);
    if (ruleset.identity.includes(key)) return setIdentity(key, value);
    if (storyKeys.has(key)) return setStory(key, value);
    p.sheet.fields[key] = f.type === 'number' ? num(value, key) : str(value, key, f.type === 'longtext' ? 4000 : 200, { allowEmpty: true });
    return undefined;
  }
  if (root === 'stats' && (seg.length === 2 || seg.length === 3)) {
    const def = ruleset.stats.find((s) => s.id === key);
    if (!def) throw bad(`unknown stat ${key}`);
    const cur = { ...p.sheet.stats[key] };
    const before = cur[ruleset.statMod.from] ?? cur[def.parts[0]];
    if (seg.length === 3) {
      if (!def.parts.includes(part)) throw bad(`stat ${key} has no part ${part} (${def.parts.join(', ')})`);
      cur[part] = num(value, path);
    } else if (typeof value === 'number') {
      cur[def.parts.includes(ruleset.statMod.from) ? ruleset.statMod.from : def.parts[0]] = num(value, path);
    } else if (isObj(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (!def.parts.includes(k)) throw bad(`stat ${key} has no part ${k}`);
        cur[k] = num(v, `${path}.${k}`);
      }
    } else throw bad(`${path} must be a number or {part: number}`);
    p.sheet.stats[key] = cur;
    const after = cur[ruleset.statMod.from] ?? cur[def.parts[0]];
    if (after !== before) out.emit({ kind: 'stat', playerId: p.id, stat: key, from: before, to: after }, { roles: ['gm', 'stage'], playerId: p.id });
    return undefined;
  }
  throw bad(`path must start with identity, stats, fields, story or portrait (got ${JSON.stringify(path)})`);
}

/** Actions open to the GM and (with permission checks) to players. */
export const SHEET = {
  'sheet.set'(st, a, ctx, out) {
    const root = typeof a.path === 'string' ? a.path.split('.')[0] : '';
    const key = typeof a.path === 'string' ? a.path.split('.')[1] : '';
    const notesOnly = root === 'story' || (root === 'fields' && ctx.pack.ruleset.storyFields.includes(key));
    const p = targetOf(st, a, ctx, notesOnly ? 'notes' : 'sheet');
    if (a.value === undefined) throw bad('value required');
    setPath(p, a.path, a.value, ctx.pack, out);
  },

  'track.set'(st, a, ctx, out) {
    const p = targetOf(st, a, ctx, 'sheet');
    return setTrack(st, p, a, ctx, out);
  },

  'skill.add'(st, a, ctx, out) {
    const p = targetOf(st, a, ctx, 'sheet');
    const rs = ctx.pack.ruleset;
    if (p.sheet.skills.length >= MAX_SKILLS) throw bad(`max ${MAX_SKILLS} skills`);
    const rank = int(a.rank, 'rank', 0, rs.skills.rankMax, { optional: true }) ?? Math.max(rs.skills.rankMin, 1);
    let sk;
    if (a.skillId !== undefined) {
      const def = libraryOf(st, ctx.pack).get('skill', a.skillId);
      if (!def) throw notFound(`unknown skill ${a.skillId}`);
      if (p.sheet.skills.some((s) => s.skillId === def.id)) throw bad(`${p.name} already has ${def.name}`);
      sk = { skillId: def.id, name: def.name, stat: rs.stats.some((s) => s.id === def.stat) ? def.stat : '', checkType: def.checkType || rs.skills.checkTypes[0] };
    } else {
      sk = { skillId: null, name: str(a.name, 'name', 60), stat: statOpt(a.stat, rs) ?? '', checkType: str(a.checkType, 'checkType', 40, { optional: true, allowEmpty: true }) || rs.skills.checkTypes[0] };
    }
    const entry = { uid: ctx.genId('s'), ...sk, rank, notes: str(a.notes, 'notes', 1000, { optional: true, allowEmpty: true }) ?? '', used: false };
    p.sheet.skills.push(entry);
    out.result = { uid: entry.uid };
  },

  'skill.update'(st, a, ctx) {
    const sheetFields = ['rank', 'stat', 'checkType', 'name'].filter((k) => a[k] !== undefined);
    const p = targetOf(st, a, ctx, sheetFields.length ? 'sheet' : 'notes');
    const rs = ctx.pack.ruleset;
    const s = findUid(p.sheet.skills, a.uid, 'skill');
    const patch = {
      rank: int(a.rank, 'rank', 0, rs.skills.rankMax, { optional: true }),
      stat: statOpt(a.stat, rs),
      checkType: str(a.checkType, 'checkType', 40, { optional: true, allowEmpty: true }),
      name: str(a.name, 'name', 60, { optional: true }),
      notes: str(a.notes, 'notes', 1000, { optional: true, allowEmpty: true }),
      used: bool(a.used, 'used', { optional: true }),
    };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) s[k] = v;
  },

  'skill.remove'(st, a, ctx) {
    const p = targetOf(st, a, ctx, 'sheet');
    findUid(p.sheet.skills, a.uid, 'skill');
    p.sheet.skills = p.sheet.skills.filter((s) => s.uid !== a.uid);
    for (const k of p.sheet.attacks) if (k.skillUid === a.uid) k.skillUid = null;
  },

  'attack.add'(st, a, ctx, out) {
    const p = targetOf(st, a, ctx, 'sheet');
    if (p.sheet.attacks.length >= MAX_ATTACKS) throw bad(`max ${MAX_ATTACKS} attacks`);
    const k = { uid: ctx.genId('k'), ...attackFields(p, a, ctx, true) };
    p.sheet.attacks.push(k);
    out.result = { uid: k.uid };
  },

  'attack.update'(st, a, ctx) {
    const p = targetOf(st, a, ctx, 'sheet');
    const k = findUid(p.sheet.attacks, a.uid, 'attack');
    for (const [key, v] of Object.entries(attackFields(p, a, ctx, false))) if (v !== undefined) k[key] = v;
  },

  'attack.remove'(st, a, ctx) {
    const p = targetOf(st, a, ctx, 'sheet');
    findUid(p.sheet.attacks, a.uid, 'attack');
    p.sheet.attacks = p.sheet.attacks.filter((k) => k.uid !== a.uid);
  },

  'spell.learn'(st, a, ctx, out) {
    const p = targetOf(st, a, ctx, 'sheet');
    out.result = { uid: learnSpell(st, p, a.spellId, a.rank, ctx).uid };
  },

  'spell.forget'(st, a, ctx) {
    const p = targetOf(st, a, ctx, 'sheet');
    findUid(p.sheet.spells, a.uid, 'spell');
    p.sheet.spells = p.sheet.spells.filter((s) => s.uid !== a.uid);
  },

  /** Extension: change a known spell's rank (sheet) or switch it off/on (play). */
  'spell.update'(st, a, ctx) {
    const p = targetOf(st, a, ctx, a.rank !== undefined ? 'sheet' : 'play');
    const s = findUid(p.sheet.spells, a.uid, 'spell');
    const rank = int(a.rank, 'rank', 0, 1000, { optional: true });
    const active = bool(a.active, 'active', { optional: true });
    if (rank !== undefined) s.rank = rank;
    if (active !== undefined) s.active = active;
  },

  'spell.cast'(st, a, ctx, out) {
    const p = targetOf(st, a, ctx, 'play');
    const rs = ctx.pack.ruleset;
    const library = libraryOf(st, ctx.pack);
    const s = findUid(p.sheet.spells, a.uid, 'spell');
    const def = library.get('spell', s.spellId);
    if (!def) throw notFound(`spell ${s.spellId} is not in the library`);
    const { computed } = computeFor(p, ctx.pack, library);
    const c = computed.spells.find((x) => x.uid === s.uid);
    const cost = c.cost.value;
    const track = c.costTrack;
    let paid = null;
    if (cost > 0) {
      if (!track || !computed.tracks[track]) throw bad(`spell cost track "${track}" does not exist in the ruleset`);
      const have = computed.tracks[track].cur;
      const label = rs.tracks.find((t) => t.id === track).label;
      if (have < cost) throw bad(`not enough ${label}: ${have}/${cost}`);
    }
    // Buff application is validated before anything is spent.
    let applied = null;
    if (def.applies) {
      const buffDef = library.get('buff', def.applies);
      if (!buffDef) throw notFound(`spell applies unknown buff ${def.applies}`);
      let who = null;
      if (a.target !== undefined && a.target !== null) {
        if (ctx.actor.role !== 'gm' && a.target !== p.id) throw forbidden('only the GM can apply spell effects to another character');
        who = playerOf(st, a.target);
      } else if (!(buffDef.tags ?? []).includes('debuff')) who = p;
      if (who) {
        const r = addBuff(who, buffFromDef(buffDef, ctx), rs);
        applied = { playerId: who.id, buffId: buffDef.id, uid: r.buff.uid, added: r.added };
      }
    }
    if (cost > 0) paid = trackDelta(p, ctx.pack, library, track, -cost, out);
    const activate = a.activate ?? (def.effects ?? []).some((e) => e.when === 'active');
    if (activate) s.active = true;
    const ev = out.emit({ kind: 'spell', playerId: p.id, spellId: def.id, name: def.name, cost, track, applied }, 'all');
    ctx.h.feedPush(st, ev, `${p.name} cast ${def.name}`);
    out.result = { cost, track, cur: paid?.to ?? null, active: s.active, applied };
  },

  'item.equip'(st, a, ctx) {
    const p = targetOf(st, a, ctx, 'sheet');
    const rs = ctx.pack.ruleset;
    const inv = findUid(p.inventory, a.uid, 'item');
    if (a.slot === null) {
      inv.equippedSlot = null;
      return;
    }
    const slot = rs.slots.find((x) => x.id === a.slot);
    if (!slot) throw bad(`slot must be one of ${rs.slots.map((x) => x.id).join(', ') || '(none defined)'} or null`);
    const def = libraryOf(st, ctx.pack).get('item', inv.itemId);
    if (def?.slot && def.slot !== slot.id) throw bad(`${def.name} goes in ${def.slot}, not ${slot.id}`);
    const used = p.inventory.filter((i) => i.equippedSlot === slot.id && i.uid !== inv.uid).length;
    if (used >= slot.max) throw bad(`${slot.label} is full (max ${slot.max})`);
    inv.equippedSlot = slot.id;
  },

  'item.qty'(st, a, ctx) {
    const p = targetOf(st, a, ctx, 'sheet');
    const inv = findUid(p.inventory, a.uid, 'item');
    const qty = int(a.qty, 'qty', 0, 9999);
    if (qty === 0) removeInv(p, inv.uid);
    else inv.qty = qty;
  },

  'item.use'(st, a, ctx, out) {
    const p = targetOf(st, a, ctx, 'play');
    const library = libraryOf(st, ctx.pack);
    const inv = findUid(p.inventory, a.uid, 'item');
    const def = library.get('item', inv.itemId);
    if (!def?.use) throw bad(`${inv.name} has no use`);
    const use = def.use;
    let who = null;
    if (a.target !== undefined && a.target !== null) {
      if (ctx.actor.role !== 'gm' && a.target !== p.id) throw forbidden('only the GM can use items on another character');
      who = playerOf(st, a.target);
    } else if (use.target === 'self') who = p;
    let applied = null;
    if (use.applyBuff && who) {
      const b = library.get('buff', use.applyBuff);
      if (!b) throw notFound(`item applies unknown buff ${use.applyBuff}`);
      const r = addBuff(who, buffFromDef(b, ctx), ctx.pack.ruleset);
      applied = { playerId: who.id, buffId: b.id, uid: r.buff.uid, added: r.added };
    }
    const healTarget = who ?? p;
    let healed = null;
    if (use.heal) {
      if (!ctx.pack.ruleset.tracks.some((t) => t.id === use.heal.track)) throw bad(`item heals unknown track ${use.heal.track}`);
      healed = { playerId: healTarget.id, ...trackDelta(healTarget, ctx.pack, library, use.heal.track, use.heal.amount, out) };
    }
    let removed = 0;
    if (use.removeBuff) {
      const before = healTarget.sheet.buffs.length;
      healTarget.sheet.buffs = healTarget.sheet.buffs.filter((b) => b.buffId !== use.removeBuff);
      removed = before - healTarget.sheet.buffs.length;
    }
    const consume = use.consume ?? !!def.stackable;
    if (consume) {
      if (inv.qty <= 1) removeInv(p, inv.uid);
      else inv.qty -= 1;
    }
    const ev = out.emit({
      kind: 'itemUse', playerId: p.id, itemId: def.id, name: def.name, healed, applied,
      removedBuff: removed ? use.removeBuff : null, consumed: consume, pendingBuff: use.applyBuff && !who ? use.applyBuff : null,
      buffOnFail: use.buffOnFail, note: use.note,
    }, 'all');
    ctx.h.feedPush(st, ev, `${p.name} used ${def.name}`);
    out.result = { healed, applied, consumed: consume, pendingBuff: use.applyBuff && !who ? use.applyBuff : null };
  },

  'hotlist.set'(st, a, ctx) {
    const p = targetOf(st, a, ctx, 'sheet');
    const size = ctx.pack.ruleset.hotlist.size;
    const i = int(a.index, 'index', 0, Math.max(0, size - 1));
    if (!size) throw bad('this ruleset has no hotlist');
    if (a.uid === null) p.sheet.hotlist[i] = null;
    else {
      findUid(p.inventory, a.uid, 'item');
      p.sheet.hotlist = p.sheet.hotlist.map((x) => (x === a.uid ? null : x));
      p.sheet.hotlist[i] = a.uid;
    }
  },

  roll(st, a, ctx, out) {
    const w = a.what;
    if (!isObj(w)) throw bad('what must be an object');
    const secret = bool(a.secret, 'secret', { optional: true }) ?? false;
    const rs = ctx.pack.ruleset;
    const by = ctx.actor.role === 'gm' ? 'gm' : ctx.actor.playerId;
    if (w.kind === 'custom') {
      const formula = str(w.formula, 'formula', 200);
      const label = str(w.label, 'label', 80, { optional: true }) ?? formula;
      let p = null;
      let resolve;
      if (ctx.actor.role === 'gm' && a.playerId === undefined) resolve = () => undefined;
      else {
        p = targetOf(st, a, ctx, 'play');
        const { ch, computed } = computeFor(p, ctx.pack, libraryOf(st, ctx.pack));
        resolve = sheetResolver(computed, ch, rs);
      }
      const r = doRoll(formula, resolve, ctx);
      const rec = rollRecord(r, { ctx, p, by, label, formula, secret, what: 'custom' });
      pushRoll(st, rec, out, ctx);
      out.result = { rollId: rec.id, total: rec.total };
      return;
    }
    const p = targetOf(st, a, ctx, 'play');
    const { ch, computed } = computeFor(p, ctx.pack, libraryOf(st, ctx.pack));
    let r;
    let formula;
    let label;
    if (w.kind === 'stat') {
      const def = rs.stats.find((s) => s.id === w.id);
      if (!def) throw notFound(`unknown stat ${w.id}`);
      label = `${def.abbr} check`;
      ({ r, formula } = rollWith(rs.dice, computed.stats[def.id].mod, `${def.abbr} mod`, ctx, `mod.${def.id}`));
    } else if (w.kind === 'derived') {
      const def = rs.derived.find((d) => d.id === w.id);
      if (!def) throw notFound(`unknown derived value ${w.id}`);
      label = def.label;
      ({ r, formula } = rollWith(def.roll || rs.dice, computed.derived[def.id], def.label, ctx, `derived.${def.id}`));
    } else if (w.kind === 'skill') {
      const s = findUid(p.sheet.skills, w.uid, 'skill');
      label = s.name;
      ({ r, formula } = rollWith(rs.skills.check.roll || rs.dice, computed.skills.find((x) => x.uid === s.uid).total, s.name, ctx, `skill:${s.uid}`));
      if (rs.skills.usedTracking && w.markUsed !== false) s.used = true;
    } else if (w.kind === 'attack') {
      const k = findUid(p.sheet.attacks, w.uid, 'attack');
      if (w.part === 'damage') {
        if (!k.dice) throw bad(`${k.name} has no damage dice`);
        const sk = k.skillUid ? p.sheet.skills.find((s) => s.uid === k.skillUid) : null;
        const stat = k.stat && rs.stats.some((s) => s.id === k.stat) ? k.stat : '';
        formula = tmpl(rs.attack.damage, stat, k.dice);
        label = `${k.name} damage`;
        r = doRoll(formula, sheetResolver(computed, ch, rs, { 'skill.rank': { value: sk?.rank ?? 0, label: 'Skill rank' } }), ctx);
        r.parts = r.parts.filter((x) => !(x.source?.startsWith('buff.') && x.value === 0 && !x.parts?.length));
      } else {
        label = `${k.name} to hit`;
        ({ r, formula } = rollWith(rs.attack.roll || rs.dice, computed.attacks.find((x) => x.uid === k.uid).toHit, `${k.name} to hit`, ctx, `attack:${k.uid}`));
      }
    } else throw bad('what.kind must be stat, derived, skill, attack or custom');
    const rec = rollRecord(r, { ctx, p, by, label, formula, secret, what: w.kind });
    pushRoll(st, rec, out, ctx);
    out.result = { rollId: rec.id, total: rec.total };
  },
};

function attackFields(p, a, ctx, creating) {
  const rs = ctx.pack.ruleset;
  let skillUid;
  if (a.skillUid !== undefined) {
    if (a.skillUid === null || a.skillUid === '') skillUid = null;
    else skillUid = findUid(p.sheet.skills, a.skillUid, 'skill').uid;
  }
  const f = {
    name: str(a.name, 'name', 60, { optional: !creating }),
    skillUid: skillUid ?? (creating ? null : undefined),
    stat: statOpt(a.stat, rs) ?? (creating ? '' : undefined),
    dice: diceOpt(a.dice, 'dice') ?? (creating ? '' : undefined),
    effects: str(a.effects, 'effects', 300, { optional: true, allowEmpty: true }) ?? (creating ? '' : undefined),
  };
  return f;
}

function learnSpell(st, p, spellId, rank, ctx) {
  const def = libraryOf(st, ctx.pack).get('spell', spellId);
  if (!def) throw notFound(`unknown spell ${spellId}`);
  if (p.sheet.spells.some((s) => s.spellId === def.id)) throw bad(`${p.name} already knows ${def.name}`);
  if (p.sheet.spells.length >= MAX_SPELLS) throw bad(`max ${MAX_SPELLS} spells`);
  const s = { uid: ctx.genId('sp'), spellId: def.id, rank: int(rank, 'rank', 0, 1000, { optional: true }) ?? 1, active: false };
  p.sheet.spells.push(s);
  return s;
}

export function setTrack(st, p, a, ctx, out) {
  const rs = ctx.pack.ruleset;
  const id = a.track ?? a.res;
  const t = rs.tracks.find((x) => x.id === id);
  if (!t) throw notFound(`unknown track ${id}`);
  const max = num(a.max, 'max', { optional: true, max: 1e9 });
  const cur = num(a.cur, 'cur', { optional: true, max: 1e9 });
  const delta = num(a.delta, 'delta', { optional: true, max: 1e9 });
  if (max === undefined && cur === undefined && delta === undefined) throw bad('give cur, max or delta');
  if (max !== undefined && max < 0) throw bad('max must be >= 0');
  const library = libraryOf(st, ctx.pack);
  const stored = { ...p.sheet.tracks[t.id] };
  const from = computeFor(p, ctx.pack, library).computed.tracks[t.id].cur;
  if (max !== undefined) stored.max = max;
  p.sheet.tracks[t.id] = stored;
  const effMax = computeFor(p, ctx.pack, library).computed.tracks[t.id].max;
  let c = Math.min(from, effMax);
  if (cur !== undefined) c = cur;
  if (delta !== undefined) c += delta;
  stored.cur = Math.max(0, Math.min(effMax, c));
  if (stored.cur !== from) {
    out.emit({ kind: 'stat', playerId: p.id, stat: t.id, resource: true, from, to: stored.cur, max: effMax }, { roles: ['gm', 'stage'], playerId: p.id });
  }
}

/** GM-only character / library actions. */
export const SHEET_GM = {
  'buff.add'(st, a, ctx, out) {
    const p = targetOf(st, a, ctx, 'gm');
    let buff;
    if (a.buffId !== undefined) {
      const def = libraryOf(st, ctx.pack).get('buff', a.buffId);
      if (!def) throw notFound(`unknown buff ${a.buffId}`);
      buff = buffFromDef(def, ctx);
      if (a.external !== undefined) buff.external = bool(a.external, 'external');
    } else {
      const warnings = [];
      let effects;
      try {
        effects = normalizeEffects(a.effects ?? [], { strict: true, warnings, where: 'buff', kind: 'buff' });
      } catch (e) {
        if (e instanceof RulesetError) throw bad(e.message);
        throw e;
      }
      buff = {
        uid: ctx.genId('b'), buffId: null, name: str(a.name, 'name', 60), desc: str(a.desc, 'desc', 500, { optional: true, allowEmpty: true }) ?? '',
        external: bool(a.external, 'external', { optional: true }) ?? false, effects, until: str(a.duration ?? a.until, 'duration', 80, { optional: true, allowEmpty: true }) ?? '', at: ctx.now,
      };
    }
    const r = addBuff(p, buff, ctx.pack.ruleset);
    out.result = { uid: r.buff.uid, added: r.added };
  },

  'buff.remove'(st, a, ctx) {
    const p = targetOf(st, a, ctx, 'gm');
    findUid(p.sheet.buffs, a.uid, 'buff');
    p.sheet.buffs = p.sheet.buffs.filter((b) => b.uid !== a.uid);
  },

  'skills.rankUp'(st, a, ctx, out) {
    const rs = ctx.pack.ruleset;
    const rule = rs.skills.rankUp;
    if (!rule) throw bad('this ruleset has no skills.rankUp rule');
    const players = a.playerId === undefined ? st.players : [playerOf(st, a.playerId)];
    const library = libraryOf(st, ctx.pack);
    const results = [];
    for (const p of players) {
      for (const s of p.sheet.skills) {
        if (!s.used) continue;
        const { ch, computed } = computeFor(p, ctx.pack, library);
        const resolve = sheetResolver(computed, ch, rs, { rank: { value: s.rank, label: `${s.name} rank` } });
        const target = typeof rule.target === 'number' ? rule.target : evaluate(rule.target, resolve).value;
        const r = doRoll(rule.roll, resolve, ctx);
        const ok = rule.rule === 'gt' ? r.total > target : rule.rule === 'gte' ? r.total >= target : rule.rule === 'lt' ? r.total < target : r.total <= target;
        const from = s.rank;
        const to = ok ? Math.min(rs.skills.rankMax, from + (rule.amount ?? 1)) : from;
        s.rank = to;
        s.used = false;
        const rec = rollRecord(r, { ctx, p, by: 'gm', label: `Rank-up: ${s.name}`, formula: rule.roll, secret: false, what: 'rankUp' });
        rec.rankUp = { skillUid: s.uid, name: s.name, rule: rule.rule, target, success: ok, from, to };
        if (rule.verify) rec.breakdown.warnings.push({ kind: 'unverified', path: 'skills.rankUp', note: rule.note ?? 'not verified against the rulebook' });
        pushRoll(st, rec, out, ctx);
        results.push({ playerId: p.id, uid: s.uid, name: s.name, roll: r.total, target, success: ok, from, to, rollId: rec.id });
      }
    }
    out.result = { results };
  },

  'lib.upsert'(st, a, ctx, out) {
    if (!LIB_KINDS.includes(a.kind)) throw bad(`kind must be one of ${LIB_KINDS.join(', ')}`);
    if (!isObj(a.entry)) throw bad('entry must be an object');
    if (JSON.stringify(a.entry).length > 210_000) throw bad('entry too large');
    const raw = { ...a.entry };
    if (raw.id === undefined) raw.id = ctx.genId('hb');
    const packList = a.kind === 'item' ? ctx.pack.items : ctx.pack.library?.[a.kind] ?? [];
    if (packList.some((e) => e.id === raw.id)) throw bad(`id "${raw.id}" belongs to the pack (read-only): duplicate it under a new id`);
    let e;
    try {
      e = normalizeLibEntry(a.kind, raw, { strict: true, source: 'homebrew', where: a.kind });
    } catch (err) {
      if (err instanceof RulesetError) throw bad(err.message);
      throw err;
    }
    const list = st.library[a.kind];
    const i = list.findIndex((x) => x.id === e.id);
    if (i >= 0) list[i] = e;
    else {
      if (list.length >= MAX_LIB_PER_KIND) throw bad(`max ${MAX_LIB_PER_KIND} homebrew ${a.kind} entries`);
      list.push(e);
    }
    out.result = { id: e.id, created: i < 0 };
  },

  'lib.remove'(st, a) {
    if (!LIB_KINDS.includes(a.kind)) throw bad(`kind must be one of ${LIB_KINDS.join(', ')}`);
    const list = st.library[a.kind];
    if (!list.some((x) => x.id === a.id)) {
      throw notFound(`no homebrew ${a.kind} ${a.id} (pack entries are read-only)`);
    }
    st.library[a.kind] = list.filter((x) => x.id !== a.id);
  },

  'lib.give'(st, a, ctx, out) {
    const p = targetOf(st, a, ctx, 'gm');
    const library = libraryOf(st, ctx.pack);
    if (a.kind === 'item') {
      const def = library.get('item', a.id);
      if (!def) throw notFound(`unknown item ${a.id}`);
      out.result = { uid: giveItem(p, def, ctx, int(a.qty, 'qty', 1, 9999, { optional: true }) ?? 1).uid };
    } else if (a.kind === 'spell') {
      out.result = { uid: learnSpell(st, p, a.id, a.rank, ctx).uid };
    } else if (a.kind === 'skill') {
      SHEET['skill.add'](st, { playerId: p.id, skillId: a.id, rank: a.rank }, ctx, out);
    } else if (a.kind === 'buff') {
      SHEET_GM['buff.add'](st, { playerId: p.id, buffId: a.id }, ctx, out);
    } else throw bad('kind must be item, spell, skill or buff');
  },

  'session.permissions'(st, a) {
    if (!PLAYER_EDIT.includes(a.playerEdit)) throw bad(`playerEdit must be one of ${PLAYER_EDIT.join(', ')}`);
    st.session.permissions = { ...(st.session.permissions ?? {}), playerEdit: a.playerEdit };
  },
};

/** Rolls visible to a role: GM all; player non-secret + own secret; stage non-secret. Last VIEW_ROLLS. */
export function rollsFor(state, role, playerId) {
  const rolls = Array.isArray(state.rolls) ? state.rolls : [];
  const vis = role === 'gm' ? rolls : rolls.filter((r) => !r.secret || (role === 'player' && r.by === playerId));
  return vis.slice(-VIEW_ROLLS);
}

export { ActionError };
