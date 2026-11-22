// Character sheets (RULESET v2): storage shape, migration, sheet/roll/library actions, sheet views.
// Browser-safe. See docs/RULESET.md and docs/PROTOCOL.md.
import { ActionError, bad, notFound, forbidden } from './errors.js';
import { computeSheet, enhanceItem, MAX_ENHANCE, makeLibrary, normalizeLibEntry, normalizeEffects, sheetResolver, tmpl, RulesetError, LIB_KINDS, ID_RE } from './ruleset.js';
import { rollDice, validateFormula, evaluate, FormulaError } from './formula.js';
import { statCheckBonus } from '../web/js/rules.js';
import { combatRules, attackOutcome, critFormula, critMultiplier, nearness, mobDefense, floorOfState, mobSlotValue, damageToSlots, typedDamage, recordKillCredit } from './outcome.js';

export const DICE_MODES = ['off', 'enter', 'digital'];
export const MAX_UNDO = 30;

export const MAX_ROLLS = 200;
export const VIEW_ROLLS = 50;
export const PLAYER_EDIT = ['none', 'notes', 'sheet'];
export const MAX_SKILLS = 100;
export const MAX_UNTRIED = 20;
export const MAX_ATTACKS = 50;
export const MAX_SPELLS = 200;
export const MAX_BUFFS = 50;
export const MAX_INVENTORY = 500;
export const MAX_POOLS = 20;
export const ORIGIN_KEYS = ['race', 'class', 'background'];
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

function cleanSpellCast(raw) {
  if (!isObj(raw) || typeof raw.id !== 'string' || raw.id.length > 80) return null;
  if (Number.isSafeInteger(raw.readyAt) && raw.readyAt > 0) return { id: raw.id, readyAt: raw.readyAt };
  if (typeof raw.scene === 'string' && raw.scene.length <= 80) return { id: raw.id, scene: raw.scene };
  return null;
}

function cleanSpellCasts(raw) {
  const casts = {};
  if (!isObj(raw)) return casts;
  for (const [id, v] of Object.entries(raw)) {
    const cast = cleanSpellCast(v);
    if (safeKey(id) && cast) casts[id] = cast;
  }
  return casts;
}

/** A new character sheet for `ruleset` (stored as player.sheet). */
export function freshSheet(ruleset) {
  const sheet = migrateSheet({}, {}, ruleset);
  // Printed-sheet rulesets (5e, PF2e): every skill is on a new sheet, untrained.
  if (ruleset.skills?.autoAdd) {
    sheet.skills = ruleset.skills.catalog.map((k) => ({ uid: `s_${k.id}`, skillId: k.id, name: k.name, rank: ruleset.skills.rankMin ?? 0, stat: k.stat, checkType: k.checkType || ruleset.skills.checkTypes[0] || '', notes: '', used: false }));
  }
  return sheet;
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
  const spells = [
    ...arr(s.spells).map((k) => ({ uid: k.uid, spellId: k.spellId, rank: finite(k.rank, 1), active: !!k.active, ...(k.used ? { used: true } : {}) })),
    ...(ruleset.spells?.starting ?? []).filter((id) => !arr(s.spells).some((k) => k.spellId === id))
      .map((id) => ({ uid: `sp_starter_${id}`, spellId: id, rank: 1, active: false })),
  ];
  if (ruleset.hotlist.combat && !s.preparedSpellHotlist) {
    for (const spell of spells) {
      const free = hot.indexOf(null);
      if (free >= 0 && !hot.includes(spell.uid)) hot[free] = spell.uid;
    }
  }
  return {
    identity: cleanMap(s.identity, 200),
    stats,
    fields: cleanMap(s.fields),
    tracks,
    skills: arr(s.skills).map((k) => ({ uid: k.uid, skillId: k.skillId ?? null, name: k.name ?? '', rank: finite(k.rank, 0), stat: k.stat ?? '', checkType: k.checkType ?? '', notes: k.notes ?? '', used: !!k.used })),
    attacks: arr(s.attacks).map((k) => ({ uid: k.uid, name: k.name ?? '', skillUid: k.skillUid ?? null, stat: k.stat ?? '', dice: k.dice ?? '', effects: k.effects ?? '', ...(typeof k.dmgStat === 'string' && k.dmgStat ? { dmgStat: k.dmgStat } : {}), ...(typeof k.dtype === 'string' && k.dtype ? { dtype: k.dtype } : {}) })),
    spells,
    spellCasts: cleanSpellCasts(s.spellCasts),
    hotlist: hot,
    ...(ruleset.hotlist.combat ? { preparedSpellHotlist: true } : {}),
    buffs: arr(s.buffs).map((b) => ({ uid: b.uid, buffId: b.buffId ?? null, name: b.name ?? 'Buff', desc: b.desc ?? '', external: !!b.external, effects: Array.isArray(b.effects) ? b.effects : [], until: b.until ?? '', at: finite(b.at, 0), ...(Number.isInteger(b.roundsLeft) && b.roundsLeft >= 0 ? { roundsLeft: b.roundsLeft } : {}) })),
    story: cleanMap(s.story),
    portrait: typeof s.portrait === 'string' ? s.portrait : null,
    // Counters like "Lay on Hands": { uid, name, cur, max, desc } (player-trackable, GM/sheet-editable).
    pools: arr(s.pools).slice(0, MAX_POOLS).map((k) => ({ uid: String(k.uid ?? ''), name: String(k.name ?? 'Pool').slice(0, 60), cur: Math.max(0, finite(k.cur, 0)), max: Math.max(0, finite(k.max, 0)), desc: String(k.desc ?? '').slice(0, 1000), ...(k.reset === 'short' ? { reset: 'short' } : {}) })).filter((k) => k.uid),
    // Race / class / background the player asked for (allowOrigins), waiting for the GM; locked once approved.
    pending: isObj(s.pending) ? Object.fromEntries(ORIGIN_KEYS.filter((k) => typeof s.pending[k] === 'string').map((k) => [k, s.pending[k].slice(0, 40)])) : {},
    originsLocked: !!s.originsLocked,
    // Guided creation finished (server/creation.js): the phone stops offering the creator.
    ...(s.created ? { created: true } : {}),
    ...(typeof s.starterSpell === 'string' && safeKey(s.starterSpell) ? { starterSpell: s.starterSpell } : {}),
    // Library skills tried untrained this session (ruleset skills.untrained.learn: one becomes Rank 1).
    untried: (Array.isArray(s.untried) ? s.untried : []).filter((x) => typeof x === 'string' && x.length <= 80).slice(-MAX_UNTRIED),
    ...(typeof s.species === 'string' && /^[a-z0-9_-]{1,30}$/.test(s.species) ? { species: s.species } : {}),
    // Starting things from guided creation, waiting for the GM (server/creation.js gear.approve / deny).
    gearRequest: arr(s.gearRequest).slice(0, 8).map((r) => ({ slot: String(r.slot ?? '').slice(0, 80), name: String(r.name ?? '').slice(0, 60), ...(typeof r.itemId === 'string' ? { itemId: r.itemId } : {}), ...(typeof r.icon === 'string' ? { icon: r.icon } : {}) })).filter((r) => r.name),
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
    containerUid: typeof i.containerUid === 'string' ? i.containerUid : null,
    bonus: Number.isInteger(i.bonus) && i.bonus > 0 ? Math.min(MAX_ENHANCE, i.bonus) : 0,
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
    containerUid: null,
  };
}

/** Adds an item to a player's inventory; stackable items merge into an existing stack. */
export function giveItem(p, item, ctx, qty = 1, bonus = 0) {
  if (item.stackable) {
    const stack = p.inventory.find((i) => i.itemId === item.id && (i.bonus || 0) === bonus);
    if (stack) {
      stack.qty += qty;
      return stack;
    }
  }
  if (p.inventory.length >= MAX_INVENTORY) throw bad(`max ${MAX_INVENTORY} inventory entries`);
  const inv = invItem(enhanceItem(item, bonus), ctx);
  inv.qty = qty;
  inv.bonus = bonus;
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
  return makeLibrary(pack, state.library, state.libArt);
}

/** GM art picks for read-only pack entries without art: { monster: { id: url }, boss, npc, location }. */
export const ART_KINDS = ['monster', 'boss', 'npc', 'location'];
const ART_URL = /^(https?:\/\/|\/pack\/)[^\s"'<>]{1,500}$/;
const MAX_ART_PER_KIND = 500;
export function normalizeLibArt(raw) {
  const out = {};
  for (const k of ART_KINDS) {
    out[k] = {};
    const src = isObj(raw) && isObj(raw[k]) ? raw[k] : {};
    for (const [id, url] of Object.entries(src).slice(0, MAX_ART_PER_KIND)) {
      if (ID_RE.test(id) && typeof url === 'string' && ART_URL.test(url)) out[k][id] = url;
    }
  }
  return out;
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
    pools: sh.pools ?? [],
    pending: sh.pending ?? {},
    originsLocked: !!sh.originsLocked,
    gearRequest: sh.gearRequest ?? [],
    created: !!sh.created,
    ...(sh.starterSpell ? { starterSpell: sh.starterSpell } : {}),
    species: sh.species ?? null,
    untried: sh.untried ?? [],
  };
}

export function computeFor(p, pack, library) {
  const ch = characterOf(p, pack.ruleset);
  return { ch, computed: computeSheet(ch, pack.ruleset, library) };
}

export function markUntrainedSkill(p, untrained, floor, skillId) {
  if (!untrained?.learn || (untrained.learnMaxFloor && floor > untrained.learnMaxFloor)) return;
  p.sheet.untried = [...new Set([...(p.sheet.untried ?? []), skillId])].slice(-MAX_UNTRIED);
}

export function learnPracticedSkill(st, p, skillId, ctx, out, { allowKnown = false } = {}) {
  const def = libraryOf(st, ctx.pack).get('skill', skillId);
  if (!def) throw notFound(`unknown skill ${skillId}`);
  const known = p.sheet.skills.some((x) => x.skillId === def.id);
  if (known && !allowKnown) throw bad(`${p.name} already has ${def.name}`);
  if (p.sheet.skills.length >= MAX_SKILLS) throw bad(`max ${MAX_SKILLS} skills`);
  const rs = ctx.pack.ruleset;
  if (!known) p.sheet.skills.push({ uid: ctx.genId('s'), skillId: def.id, name: def.name, stat: rs.stats.some((x) => x.id === def.stat) ? def.stat : '', checkType: def.checkType || rs.skills.checkTypes[0], rank: 1, notes: '', used: false });
  out.emit({ kind: 'untrained.learn', playerId: p.id, skill: def.name }, 'all');
  return def.name;
}

export function rankUpEntries(p, rs, library) {
  const skills = p.sheet.skills.map((s) => ({ s, name: s.name, max: rs.skills.rankMax, key: 'skillUid' }));
  if (rs.spells.attackChecks) for (const s of p.sheet.spells) {
    const def = library.get('spell', s.spellId);
    if (def?.attackCheck) skills.push({ s, name: def.name, max: Math.min(rs.skills.rankMax, def.rankMax ?? Infinity), key: 'spellUid' });
  }
  return skills;
}

export function rollSkillRankUp(st, p, entry, ctx, out, { entered, clearUsed = true } = {}) {
  const rs = ctx.pack.ruleset;
  const rule = rs.skills.rankUp;
  const library = libraryOf(st, ctx.pack);
  const { s, name, max, key } = entry;
  const { ch, computed } = computeFor(p, ctx.pack, library);
  const resolve = sheetResolver(computed, ch, rs, { rank: { value: s.rank, label: `${name} rank` } });
  const target = typeof rule.target === 'number' ? rule.target : evaluate(rule.target, resolve).value;
  const r = doRoll(rule.roll, resolve, entered == null ? ctx : { ...ctx, dieInt: () => entered - 1 });
  const ok = rule.rule === 'gt' ? r.total > target : rule.rule === 'gte' ? r.total >= target : rule.rule === 'lt' ? r.total < target : r.total <= target;
  const from = s.rank;
  const to = ok && from < max ? Math.min(max, from + (rule.amount ?? 1)) : from;
  s.rank = to;
  if (clearUsed) s.used = false;
  const rec = rollRecord(r, { ctx, p, by: ctx.actor.role === 'player' ? p.id : 'gm', label: `Rank-up: ${name}`, formula: rule.roll, secret: false, what: 'rankUp' });
  rec.rankUp = { [key]: s.uid, name, rule: rule.rule, target, success: ok, from, to };
  if (rule.verify) rec.breakdown.warnings.push({ kind: 'unverified', path: 'skills.rankUp', note: rule.note ?? 'not verified against the rulebook' });
  pushRoll(st, rec, out, ctx);
  return { playerId: p.id, uid: s.uid, name, roll: r.total, target, success: ok, from, to, rollId: rec.id };
}

/** Library items tagged "container" (bag of holding, backpack…) can hold other inventory entries. */
export const isContainer = (def) => !!def && (def.container === true || (def.tags ?? []).includes('container'));

export function enrichInventory(inv, library) {
  return inv.map((i) => {
    const def = enhanceItem(library.get('item', i.itemId), i.bonus);
    if (!def) return { ...i, slot: null, stackable: false, effects: [], attack: null, use: null, source: null, missing: true };
    return {
      ...i,
      name: def.name, desc: def.desc, flavor: def.flavor ?? '', rarity: def.rarity, image: def.image ?? i.image ?? null,
      container: isContainer(def), slot: def.slot ?? null, stackable: !!def.stackable, effects: def.effects ?? [], attack: def.attack ?? null, use: def.use ?? null, tags: def.tags ?? [], source: def.source,
    };
  });
}

/** View shape: raw character (enriched with library data) + `computed`. */
export function sheetView(p, pack, library, st) {
  const { ch, computed } = computeFor(p, pack, library);
  const spells = ch.spells.map((s) => {
    const def = library.get('spell', s.spellId);
    if (!def) return { ...s, name: s.spellId, missing: true };
    const { id, ...rest } = def;
    const cooldown = spellCooldown(st, def.cooldown, p.sheet.spellCasts?.[s.spellId]);
    if (cooldown) computed.spells.find((v) => v.uid === s.uid).cooldown = cooldown;
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
  for (const kind of ['skill', 'race', 'class', 'background']) out[kind] = [...library.list(kind)];
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
    if (p.sheet.starterSpell) add('spell', p.sheet.starterSpell);
    for (const b of p.sheet.buffs) if (b.buffId) add('buff', b.buffId);
    // Guided creation not finished: the plain starting things to pick from (no treasure, no weapons).
    if (pack.ruleset.creation && !p.sheet.created) for (const e of library.list('item')) if (out.item.length < 250 && isStarterItem(e)) add('item', e.id);
    if (pack.ruleset.creation?.spellChoice && !p.sheet.created) {
      const { choices, item } = pack.ruleset.creation.spellChoice;
      for (const id of choices) add('spell', id);
      add('item', item);
    }
  }
  for (const entries of Object.values(out)) {
    for (const [i, entry] of entries.entries()) {
      if (!entry.origin) continue;
      const { origin, ...publicEntry } = entry;
      entries[i] = publicEntry;
    }
  }
  return out;
}

/** A plain thing anyone could have had on them when the world ended (guided creation's catalog). */
export function isStarterItem(e) {
  return (e.rarity || 'common') === 'common' && !e.attack && !(e.tags ?? []).some((t) => /quest|legendary|unique|boss|sponsor|weapon|armor|shield|custom/i.test(t));
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

export function nextInjuryDescription(p, rules, severity, requested) {
  if (!p.injuryTally || typeof p.injuryTally !== 'object' || Array.isArray(p.injuryTally)) p.injuryTally = {};
  const index = Number.isSafeInteger(p.injuryTally[severity]) && p.injuryTally[severity] >= 0 ? p.injuryTally[severity] : 0;
  p.injuryTally[severity] = index + 1;
  const choices = rules[`${severity}Descriptions`] ?? [];
  return requested?.trim() || choices[index % choices.length] || '';
}

function buffFromDef(def, ctx) {
  return { uid: ctx.genId('b'), buffId: def.id, name: def.name, desc: def.desc ?? '', external: !!def.external, effects: def.effects ?? [], until: def.duration ?? '', at: ctx.now, ...(def.rounds ? { roundsLeft: def.rounds } : {}) };
}

/** Resolve status restrictions from library ids, including statuses already active in older saves. */
export function statusBlocker(target, library, kind) {
  const conditions = target?.sheet?.buffs ?? target?.conditions ?? [];
  for (const b of conditions) {
    const id = b.buffId ?? b.id;
    const def = id && library.get('buff', id);
    if (def?.blocks?.includes(kind) || (kind !== 'heal' && def?.blocks?.includes('action'))) return def.name;
  }
  return null;
}

export function requireStatusAllowed(st, ctx, target, kind) {
  if (!(target?.sheet?.buffs?.length || target?.conditions?.length)) return;
  const name = statusBlocker(target, libraryOf(st, ctx.pack), kind);
  if (name) throw bad(`Blocked by ${name}.`);
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
  for (const i of p.inventory) if (i.containerUid === uid) i.containerUid = null;
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

const gameSeconds = (st) => st?.crawlers?.clock?.elapsedSeconds ?? 0;
const storyScene = (st) => st?.crawlers?.clock?.scene ?? st?.combat?.id ?? 'initial';

function spellCooldown(st, cooldown, cast) {
  if (!cooldown) return null;
  if (cooldown === 'scene') return { kind: 'scene', ready: cast?.scene !== storyScene(st) };
  const remainingSeconds = Math.max(0, (cast?.readyAt ?? 0) - gameSeconds(st));
  return { kind: 'time', ready: remainingSeconds === 0, remainingSeconds };
}

function payForSpell(st, p, library, computed, spell, ctx, out) {
  const pack = ctx.pack;
  const def = library.get('spell', spell.spellId);
  const { cost: { value: cost }, costTrack: track } = computed.spells.find((x) => x.uid === spell.uid);
  const before = p.sheet.spellCasts?.[def.id] ?? null;
  const cooldown = spellCooldown(st, def.cooldown, before);
  if (cooldown && !cooldown.ready) throw bad(`${def.name} ${cooldown.kind === 'scene' ? 'can only be cast once per scene' : 'is still cooling down'}`);
  let cur = null;
  if (cost) {
    const resource = computed.tracks[track];
    if (!resource) throw bad(`spell cost track "${track}" does not exist in the ruleset`);
    if (resource.cur < cost) throw bad(`not enough ${pack.ruleset.tracks.find((t) => t.id === track).label}: ${resource.cur}/${cost}`);
    cur = trackDelta(p, pack, library, track, -cost, out).to;
  }
  if (!cooldown) return { cost, track, cur };
  const when = cooldown.kind === 'scene' ? { scene: storyScene(st) } : { readyAt: gameSeconds(st) + def.cooldown };
  const cast = { id: ctx.genId('sc'), ...when };
  (p.sheet.spellCasts ??= {})[def.id] = cast;
  return { cost, track, cur, cooldown: { spellId: def.id, before, cast } };
}

// ---------- rolls ----------

/** What players and the TV may see of a roll: never the target's defence or the margin. */
export function publicRoll(rec) {
  const { actionReceipt, spellPayment, evadeAdvantage, weaponHitId, ...visible } = rec;
  if (!rec.vs) return visible;
  const { defense, margin, ...vs } = rec.vs;
  return { ...visible, vs };
}

function pushRoll(st, rec, out, ctx) {
  st.rolls.push(rec);
  if (st.rolls.length > MAX_ROLLS) st.rolls = st.rolls.slice(-MAX_ROLLS);
  if (rec.secret) out.emit({ kind: 'roll', ...rec }, { roles: ['gm'], ...(rec.by !== 'gm' ? { playerId: rec.by } : {}) });
  else if (rec.vs) {
    out.emit({ kind: 'roll', ...rec }, { roles: ['gm'] });
    out.emit({ kind: 'roll', ...publicRoll(rec) }, { roles: ['player', 'stage'] });
  } else out.emit({ kind: 'roll', ...publicRoll(rec) }, 'all');
  ctx.h?.onSheetRoll?.(st, ctx, out, rec);
  const near = rec.vs && !rec.secret ? nearness(rec.vs, rec.natural) : null;
  if (near && ctx.h?.categoryLine) {
    const line = ctx.h.categoryLine(st, ctx, near, 1);
    if (line) out.lines.push(line);
  }
  if (!rec.secret && (rec.nat1 || rec.nat20) && ctx.h?.categoryLine) {
    const line = ctx.h.categoryLine(st, ctx, rec.nat20 ? 'nat20' : 'nat1', 1);
    if (line) out.lines.push(line);
  }
}

function rollRecord(r, { ctx, p, by, label, formula, secret, what, whatId = null }) {
  return {
    id: ctx.genId('r'),
    at: ctx.now,
    playerId: p?.id ?? null,
    by,
    what,
    whatId,
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
    return rollDice(src, { resolve, randInt: ctx.dieInt ?? ctx.rollInt ?? ctx.randInt });
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

// ---------- rolls against a target (dice entry) ----------

const SIZE_CLASSES = ['tiny', 'small', 'petite', 'medium', 'large', 'huge', 'colossal', 'gargantuan'];

function attackSizeRelation(rules, crawlerSize, mobSize) {
  if (!rules.sizeGap || !Number.isInteger(mobSize)) return null;
  const size = SIZE_CLASSES.indexOf(String(crawlerSize ?? '').toLowerCase()) + 1 || rules.crawlerSize;
  const gap = mobSize - size;
  if (gap >= rules.sizeGap) return { adv: 'adv' };
  if (gap <= -rules.sizeGap) return { adv: 'dis', damage: size };
  return null;
}

/**
 * a.target = a combatant uid (attack / check against it) or a.dc = a number (check vs a difficulty).
 * To-hit rolls resolve against the target's defence (rec.vs: hit / crit / degree; defence + margin GM-only).
 * Damage rolls with a target are applied to that mob (minus its DR where the game has DR) and can be undone.
 */
function resolveAgainst(st, ctx, a, rec, p, out, earned, attackProfile) {
  const rules = combatRules(ctx.pack, st.combat?.settings);
  let defense = null;
  let target = null;
  if (typeof a.target === 'string') {
    target = (st.combat?.combatants ?? []).find((x) => x.uid === a.target && x.type === 'mob');
    if (!target) throw notFound('that monster is not in the fight');
  }
  if (rec.part === 'damage') {
    if (!target) return;
    const prev = typeof a.after === 'string' ? st.rolls.find((x) => x.id === a.after && x.playerId === p.id) : null;
    let dmg = rec.total;
    if (prev?.vs?.crit && rules.crit !== 'dice') dmg *= critMultiplier(rules);
    // Seven degrees: an Amazing hit adds the floor to the damage.
    const amazing = rules.seven && prev?.vs?.deg7 === 'amazing' ? floorOfState(st) : 0;
    const sizeDamage = !prev?.void && prev?.part === 'hit' && prev.what === 'attack' && rec.what === 'attack'
      && prev.whatId === rec.whatId && prev.vs?.hit && prev.vs.uid === target.uid ? prev.sizeDamage ?? 0 : 0;
    dmg += amazing + sizeDamage;
    dmg = Math.max(0, dmg - (rules.useDr && !attackProfile?.ignoreDr ? Math.max(0, target.dr ?? 0) : 0));
    // Damage type vs the mob's resistances (after DR): the attack's dtype.
    const atk = a.what?.kind === 'attack' ? (p.sheet.attacks ?? []).find((k) => k.uid === a.what.uid)
      : a.what?.kind === 'spell' ? libraryOf(st, ctx.pack).get('spell', p.sheet.spells.find((s) => s.uid === a.what.uid)?.spellId)?.attack : null;
    const typed = typedDamage(dmg, atk?.dtype, target);
    dmg = typed.amount;
    // Slot health bars: whole slots only (damage below one slot's worth is lost).
    const sv = mobSlotValue(ctx.pack, target);
    const rolled = dmg;
    if (sv > 1) dmg = damageToSlots(dmg, sv);
    rec.vs = { uid: target.uid, name: target.hidden ? 'Something unseen' : target.name, damage: dmg,
      ...(sv > 1 ? { rolled, slotValue: sv } : {}), ...(amazing ? { amazing } : {}), ...(sizeDamage ? { sizeDamage } : {}),
      ...(attackProfile?.ignoreDr && rules.useDr ? { ignoredDr: true } : {}), ...(typed.why ? { typed: typed.why, dtype: atk.dtype } : {}) };
    if (dmg > 0 && ctx.h?.applyDamage) {
      const before = target.hp;
      const previousKill = st.combat.lastKill ?? null;
      ctx.h.applyDamage(st, ctx, out, { uid: target.uid, amount: dmg, by: p.id });
      const after = (st.combat.combatants.find((x) => x.uid === target.uid) ?? target).hp;
      rec.applied = { uid: target.uid, before, after, delta: after - before,
        ...(before > 0 && after <= 0 ? { previousKill } : {}) };
      rec.vs.down = after <= 0;
      undoPush(st, rec);
    }
    return;
  }
  if (target) defense = mobDefense(rules, target.evade, target.flat ? 0 : floorOfState(st));
  else if (a.dc !== undefined) defense = int(a.dc, 'dc', -10, 99);
  else return;
  const res = attackOutcome(rules, { d20: rec.natural, total: rec.total, target: defense });
  if (earned) {
    const rx = st.combat.rx;
    rx.advantage = rx.advantage.filter((v) => v !== earned);
    rec.evadeAdvantage = { ...earned, combatId: rx.combatId, round: rx.round };
  }
  rec.vs = { ...(earned ? { advantage: true } : {}), ...(target ? { uid: target.uid, name: target.hidden ? 'Something unseen' : target.name } : { dc: true }), hit: res.hit, crit: res.crit, degree: res.degree, degrees: rules.degrees, defense, margin: res.margin, ...(res.deg7 ? { deg7: res.deg7 } : {}) };
  if (target && rec.part === 'hit') undoPush(st, rec);
}

function rollOf(st, id) {
  const rec = typeof id === 'string' ? (st.rolls ?? []).find((x) => x.id === id) : null;
  if (!rec) throw notFound('no such roll');
  return rec;
}
const hasResolvedDamage = (st, id) => st.rolls.some((r) => !r.void && (r.spellHitId === id || r.weaponHitId === id));
/** Works out a changed roll (AI Favor, Intervene) against its target again. */
function rescore(st, ctx, rec) {
  if (!rec.vs || rec.vs.defense == null || rec.vs.damage !== undefined) return;
  const res = attackOutcome(combatRules(ctx.pack, st.combat?.settings), { d20: rec.natural, total: rec.total, target: rec.vs.defense });
  Object.assign(rec.vs, { hit: res.hit, crit: res.crit, degree: res.degree, margin: res.margin });
  if (res.deg7) rec.vs.deg7 = res.deg7; else delete rec.vs.deg7;
}

function undoPush(st, rec) {
  st.rollUndo = [...(st.rollUndo ?? []), rec.id].slice(-MAX_UNDO);
  st.rollRedo = [];
}

/** A void or restore changes actions only while the roll's original action phase is open. */
function adjustActionReceipt(st, rec, delta) {
  const r = rec.actionReceipt;
  const rx = st.combat?.rx;
  if (!r || rx?.step !== 'act' || rx.combatId !== r.combatId || rx.round !== r.round || !Object.hasOwn(rx.acts, r.uid)) return;
  const left = rx.acts[r.uid] + delta;
  if (left < 0) throw bad('no action left to restore this attack');
  rx.acts[r.uid] = left;
  return true;
}

function adjustEvadeAdvantage(st, rec, restore) {
  const saved = rec.evadeAdvantage;
  const rx = st.combat?.active ? st.combat.rx : null;
  if (!saved || rx?.combatId !== saved.combatId || rx.round !== saved.round) return;
  const { uid, mobUid } = saved;
  const current = rx.advantage ?? [];
  if (restore) {
    if (!current.some((a) => a.uid === uid && a.mobUid === mobUid)) rx.advantage = [...current, { uid, mobUid }].slice(-20);
  } else rx.advantage = current.filter((a) => a.uid !== uid || a.mobUid !== mobUid);
}

function adjustSpellPayment(st, ctx, out, rec, refund) {
  const payment = rec.spellPayment;
  const p = payment && st.players.find((v) => v.id === rec.playerId);
  if (!p) return;
  const library = libraryOf(st, ctx.pack);
  if (payment.cooldown) {
    const { spellId, before, cast } = payment.cooldown;
    const current = p.sheet.spellCasts?.[spellId];
    if (refund && current?.id === cast.id) {
      if (before) p.sheet.spellCasts[spellId] = before;
      else delete p.sheet.spellCasts[spellId];
    } else if (!refund) {
      const def = library.get('spell', spellId);
      const restored = spellCooldown(st, def?.cooldown, cast);
      if (restored && !restored.ready) {
        if (!spellCooldown(st, def.cooldown, current).ready) throw bad('this spell is already cooling down');
        (p.sheet.spellCasts ??= {})[spellId] = cast;
      }
    }
  }
  if (!payment.cost) return;
  const resource = computeFor(p, ctx.pack, library).computed.tracks[payment.track];
  if (!resource) return;
  if (!refund && resource.cur < payment.cost) throw bad('not enough resources to restore this spell');
  trackDelta(p, ctx.pack, library, payment.track, refund ? payment.cost : -payment.cost, out);
}

/** Cancels a roll: struck through everywhere, its damage put back, its initiative removed. */
export function voidRoll(st, ctx, out, rec, by) {
  if (rec.void) return;
  if (rec.part === 'hit' && hasResolvedDamage(st, rec.id)) throw bad(rec.what === 'spell' ? 'undo the spell damage before undoing the cast' : 'undo the damage before undoing the attack');
  if (rec.what === 'attack' && rec.part === 'hit' && st.rolls.some((v) => v.weaponHitId === rec.id && !v.void)) {
    throw bad('undo the weapon damage before undoing the attack');
  }
  const refunded = adjustActionReceipt(st, rec, 1);
  adjustEvadeAdvantage(st, rec, true);
  adjustSpellPayment(st, ctx, out, rec, true);
  rec.void = { by, at: ctx.now };
  if (rec.applied) {
    const m = (st.combat?.combatants ?? []).find((x) => x.uid === rec.applied.uid);
    if (m) {
      const before = m.hp;
      const latest = st.combat.lastKill?.uid === m.uid;
      m.hp = Math.max(0, Math.min(m.hpMax, m.hp - rec.applied.delta));
      recordKillCredit(st.combat, m, before);
      ctx.h?.syncBossHealth?.(st, m, out);
      if (latest && before <= 0 && m.hp > 0 && Object.hasOwn(rec.applied, 'previousKill')) st.combat.lastKill = rec.applied.previousKill;
    }
  }
  const I = st.combat?.init;
  if (I?.on && rec.what === 'derived' && rec.whatId === (ctx.pack.ruleset.combat?.initiative?.derived ?? 'initiative')) {
    const x = (st.combat.combatants ?? []).find((y) => y.type === 'crawler' && y.playerId === rec.playerId);
    if (x && I.totals[x.uid] === rec.total) {
      delete I.totals[x.uid];
      I.order = I.order.filter((u) => u !== x.uid);
      I.turn = Math.min(I.turn, Math.max(0, I.order.length - 1));
    }
  }
  st.rollRedo = [...(st.rollRedo ?? []).filter((id) => id !== rec.id), rec.id].slice(-MAX_UNDO);
  st.rollUndo = (st.rollUndo ?? []).filter((id) => id !== rec.id);
  out.emit({ kind: 'roll.void', id: rec.id, playerId: rec.playerId, label: rec.label }, 'all');
  return refunded;
}

function unvoidRoll(st, ctx, out, rec) {
  if (!rec.void) return;
  const hitId = rec.spellHitId ?? rec.weaponHitId;
  if (hitId && !st.rolls.some((v) => v.id === hitId && !v.void)) throw bad('restore the hit before restoring its damage');
  if (hitId && hasResolvedDamage(st, hitId)) throw bad('damage for this hit was already applied');
  if (rec.weaponHitId && !st.rolls.some((v) => v.id === rec.weaponHitId && !v.void)) throw bad('restore the attack before restoring its damage');
  if (rec.weaponHitId && st.rolls.some((v) => v.weaponHitId === rec.weaponHitId && !v.void)) throw bad('damage for that attack was already rolled');
  adjustActionReceipt(st, rec, -1);
  adjustEvadeAdvantage(st, rec, false);
  adjustSpellPayment(st, ctx, out, rec, false);
  rec.void = null;
  if (rec.applied) {
    const m = (st.combat?.combatants ?? []).find((x) => x.uid === rec.applied.uid);
    if (m) {
      const before = m.hp;
      m.hp = Math.max(0, Math.min(m.hpMax, m.hp + rec.applied.delta));
      recordKillCredit(st.combat, m, before, rec.playerId);
      ctx.h?.syncBossHealth?.(st, m, out);
    }
  }
  if (rec.what === 'derived') ctx.h?.onSheetRoll?.(st, ctx, out, rec);
  st.rollRedo = (st.rollRedo ?? []).filter((id) => id !== rec.id);
  st.rollUndo = [...(st.rollUndo ?? []), rec.id].slice(-MAX_UNDO);
  out.emit({ kind: 'roll.restore', id: rec.id, playerId: rec.playerId, label: rec.label }, 'all');
}

// ---------- actions ----------

function setPath(p, path, value, pack, out) {
  const ruleset = pack.ruleset;
  if (typeof path !== 'string' || path.length > 200) throw bad('path must be a string');
  const seg = path.split('.');
  if (!seg.every(safeKey)) throw bad(`bad path ${JSON.stringify(path)}`);
  const [root, key, part] = seg;
  const idKeys = new Set([...ruleset.identity, 'name', 'level', 'race', 'class', 'background', 'floor', 'pronouns']);
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
    if (ctx.actor.role !== 'gm' && (root === 'identity' || root === 'fields') && (ctx.pack.ruleset.gmOnly ?? []).includes(key)) {
      // GM-only values (level, floor, AI Favor…). A player may still spend one point of a number field (AI Favor −1).
      const cur = root === 'fields' ? Number(p.sheet.fields?.[key] ?? ctx.pack.ruleset.fields.find((f) => f.id === key)?.default ?? 0) : NaN;
      if (!(root === 'fields' && Number(a.value) === cur - 1 && cur >= 1)) throw forbidden(`${key} is set by the GM`);
    }
    if (ctx.actor.role !== 'gm' && root === 'identity' && ORIGIN_KEYS.includes(key) && a.path.split('.').length === 2) {
      // Players never set race / class / background directly: with allowOrigins it becomes a request.
      const v = str(a.value, key, 40, { allowEmpty: true });
      const cur = key === 'race' ? p.race : key === 'class' ? p.klass : p.sheet.identity.background;
      if (v === (cur ?? '') && !(key in p.sheet.pending)) { out.changed = false; return; } // unchanged (builder re-sends it)
      if (!st.session.permissions?.allowOrigins) throw forbidden('race, class and background are set by the GM');
      if (p.sheet.originsLocked) throw forbidden('the GM approved your origins; ask the GM to change them');
      if (v === (cur ?? '')) delete p.sheet.pending[key];
      else p.sheet.pending[key] = v;
      out.result = { pending: { ...p.sheet.pending } };
      if (Object.keys(p.sheet.pending).length) out.emit({ kind: 'originsRequest', playerId: p.id, name: p.name, pending: { ...p.sheet.pending } }, { roles: ['gm'] });
      return;
    }
    setPath(p, a.path, a.value, ctx.pack, out);
  },

  'pool.add'(st, a, ctx, out) {
    const p = targetOf(st, a, ctx, 'sheet');
    if (p.sheet.pools.length >= MAX_POOLS) throw bad(`max ${MAX_POOLS} pools`);
    const max = int(a.max, 'max', 0, 9999);
    const pool = { uid: ctx.genId('pl'), name: str(a.name, 'name', 60), cur: int(a.cur, 'cur', 0, 9999, { optional: true }) ?? max, max, desc: str(a.desc, 'desc', 1000, { optional: true, allowEmpty: true }) ?? '' };
    if (a.reset === 'short') pool.reset = 'short';
    pool.cur = Math.min(pool.cur, pool.max);
    p.sheet.pools.push(pool);
    out.result = { uid: pool.uid };
  },

  'pool.update'(st, a, ctx) {
    const p = targetOf(st, a, ctx, 'sheet');
    const pool = findUid(p.sheet.pools, a.uid, 'pool');
    const name = str(a.name, 'name', 60, { optional: true });
    const desc = str(a.desc, 'desc', 1000, { optional: true, allowEmpty: true });
    const max = int(a.max, 'max', 0, 9999, { optional: true });
    if (name !== undefined) pool.name = name;
    if (desc !== undefined) pool.desc = desc;
    if (max !== undefined) { pool.max = max; pool.cur = Math.min(pool.cur, max); }
    if (a.reset !== undefined) { if (a.reset === 'short') pool.reset = 'short'; else delete pool.reset; }
  },

  /**
   * Rest. long: every track (health, mana…) back to max, every counter refilled.
   * short: counters marked reset "short" refilled, plus `heal` health if given (5e hit dice rolled at the table).
   */
  'rest'(st, a, ctx, out) {
    const p = targetOf(st, a, ctx, 'play');
    const rs = ctx.pack.ruleset;
    const rest = rs.rests && Object.hasOwn(rs.rests, a.kind) ? rs.rests[a.kind] : null;
    if (!rest && a.kind !== 'short' && a.kind !== 'long') throw bad('kind must be short or long');
    const heal = rest || a.heal === undefined ? 0 : int(a.heal, 'heal', 0, 9999);
    const done = [];
    if (rest) {
      if (ctx.actor.role !== 'gm') throw forbidden('the GM confirms rests in this campaign');
      if (st.combat?.active) throw bad('finish combat before resting');
      const library = libraryOf(st, ctx.pack);
      if (computeFor(p, ctx.pack, library).computed.tracks[rs.hpTrack ?? 'hp']?.cur === 0) throw bad('a down character must be saved before resting');
      for (const b of p.sheet.buffs) if (rest.removeBuffs.includes(b.buffId)) done.push(b.name);
      p.sheet.buffs = p.sheet.buffs.filter((b) => !rest.removeBuffs.includes(b.buffId));
      const tracks = computeFor(p, ctx.pack, library).computed.tracks;
      for (const [id, gain] of Object.entries(rest.restore)) {
        const { max } = tracks[id];
        const amount = gain === 'full' ? max : typeof gain === 'number' ? gain : Math.floor(max * gain.maxFraction);
        const { to, from } = trackDelta(p, ctx.pack, library, id, amount, out);
        if (to > from) done.push(`${rs.tracks.find((t) => t.id === id).label} +${to - from}`);
      }
    } else if (a.kind === 'long') {
      const c = computeFor(p, ctx.pack, libraryOf(st, ctx.pack)).computed;
      for (const t of rs.tracks) {
        const tr = c.tracks[t.id];
        if (tr && tr.cur < tr.max) { setTrack(st, p, { track: t.id, cur: tr.max }, ctx, out); done.push(t.label); }
      }
    } else if (heal) {
      const hp = rs.tracks.find((t) => t.id === (rs.hpTrack ?? 'hp')) ?? rs.tracks[0];
      if (hp) { setTrack(st, p, { track: hp.id, delta: heal }, ctx, out); done.push(`${hp.label} +${heal}`); }
    }
    for (const pl of p.sheet.pools) {
      if ((a.kind === 'long' || a.kind === 'day' || (a.kind === 'short' && pl.reset === 'short')) && pl.cur < pl.max) { pl.cur = pl.max; done.push(pl.name); }
    }
    out.result = { restored: done };
  },

  /** Spend / regain from a pool: always allowed for the own character (like rolling), clamped 0..max. */
  'pool.set'(st, a, ctx) {
    const p = targetOf(st, a, ctx, 'play');
    const pool = findUid(p.sheet.pools, a.uid, 'pool');
    if (a.delta !== undefined) pool.cur = Math.max(0, Math.min(pool.max, pool.cur + int(a.delta, 'delta', -9999, 9999)));
    else pool.cur = Math.max(0, Math.min(pool.max, int(a.cur, 'cur', 0, 9999)));
  },

  'pool.remove'(st, a, ctx) {
    const p = targetOf(st, a, ctx, 'sheet');
    findUid(p.sheet.pools, a.uid, 'pool');
    p.sheet.pools = p.sheet.pools.filter((x) => x.uid !== a.uid);
  },

  /** Puts an inventory entry into a container item (bag of holding), or back out (into: null). */
  'item.move'(st, a, ctx) {
    const p = targetOf(st, a, ctx, 'sheet');
    const inv = findUid(p.inventory, a.uid, 'item');
    if (a.into === null) { inv.containerUid = null; return; }
    const box = findUid(p.inventory, a.into, 'container');
    const library = libraryOf(st, ctx.pack);
    if (!isContainer(library.get('item', box.itemId))) throw bad(`${box.name} is not a container`);
    if (box.uid === inv.uid) throw bad('an item cannot go inside itself');
    if (isContainer(library.get('item', inv.itemId))) throw bad('containers cannot go inside other containers');
    if (box.containerUid) throw bad(`${box.name} is inside another container`);
    inv.containerUid = box.uid;
    inv.equippedSlot = null;
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

  /**
   * `{ skillId }` End of a Tutorial Floor session: learn one skill tried untrained (Rank 1); the rest of
   * the list is wiped (it cannot be saved for later sessions).
   */
  'untrained.learn'(st, a, ctx, out) {
    const p = targetOf(st, a, ctx, 'play');
    const unt = ctx.pack.ruleset.skills?.untrained;
    if (!unt?.learn) throw bad('this game does not teach untrained skills');
    if (ctx.pack.ruleset.advancement && ctx.actor.role === 'player') throw bad('the GM must award a play milestone before you can learn a practiced skill in Level up');
    if (unt.learnMaxFloor && floorOfState(st) > unt.learnMaxFloor) throw bad(`untrained skills are learned only up to floor ${unt.learnMaxFloor}`);
    if (!(p.sheet.untried ?? []).includes(a.skillId)) throw bad('not tried untrained this session');
    const name = learnPracticedSkill(st, p, a.skillId, ctx, out, { allowKnown: true });
    p.sheet.untried = [];
    out.result = { name };
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
    const s = findUid(p.sheet.spells, a.uid, 'spell');
    if (ctx.pack.ruleset.spells.starting?.includes(s.spellId)) throw bad('this spell is always known');
    p.sheet.spells = p.sheet.spells.filter((s) => s.uid !== a.uid);
    p.sheet.hotlist = p.sheet.hotlist.map((uid) => uid === s.uid ? null : uid);
  },

  /** Extension: change a known spell's rank (sheet) or switch it off/on (play). */
  'spell.update'(st, a, ctx) {
    const p = targetOf(st, a, ctx, a.rank !== undefined ? 'sheet' : 'play');
    const s = findUid(p.sheet.spells, a.uid, 'spell');
    const def = libraryOf(st, ctx.pack).get('spell', s.spellId);
    const rank = int(a.rank, 'rank', def?.rankMax ? 1 : 0, def?.rankMax ?? 1000, { optional: true });
    const active = bool(a.active, 'active', { optional: true });
    if (rank !== undefined) s.rank = rank;
    if (active !== undefined) s.active = active;
  },

  'spell.cast'(st, a, ctx, out) {
    const p = targetOf(st, a, ctx, 'play');
    requireStatusAllowed(st, ctx, p, 'spell');
    const rs = ctx.pack.ruleset;
    const library = libraryOf(st, ctx.pack);
    const s = findUid(p.sheet.spells, a.uid, 'spell');
    const def = library.get('spell', s.spellId);
    if (!def) throw notFound(`spell ${s.spellId} is not in the library`);
    const { computed } = computeFor(p, ctx.pack, library);
    if (rs.spells.attackChecks && def.attackCheck) throw bad('roll the spell attack against its target');
    let healTarget = null;
    if (def.healing) {
      if (def.healing.target === 'ally') {
        healTarget = playerOf(st, a.target);
        if (healTarget.id === p.id) throw bad('choose another character to heal');
      } else {
        if (a.target != null && a.target !== p.id) throw bad('this spell can only heal its caster');
        healTarget = p;
      }
      if (!rs.tracks.some((t) => t.id === def.healing.track)) throw bad('this spell has no health track');
      if (st.combat?.combatants.some((c) => c.playerId === healTarget.id && c.dead)) throw bad('that crawler is already dead');
      requireStatusAllowed(st, ctx, healTarget, 'heal');
      if (st.combat?.active && rs.combat.flow === 'reaction') {
        const health = (healTarget.id === p.id ? computed : computeFor(healTarget, ctx.pack, library).computed).tracks[def.healing.track];
        if (health.cur >= health.max) throw bad('that crawler’s health is already full');
      }
    }
    const { cost, track, cur } = payForSpell(st, p, library, computed, s, ctx, out);
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
    let healed = null;
    if (healTarget) {
      const heal = def.healing;
      const amount = (s.rank >= 5 && heal.rank5Amount) || heal.amount;
      const slots = typeof amount === 'number' ? amount : doRoll(amount, undefined, ctx).total;
      healed = { playerId: healTarget.id, ...trackDelta(healTarget, ctx.pack, library, heal.track, slots, out) };
    }
    const activate = a.activate ?? (def.effects ?? []).some((e) => e.when === 'active');
    if (activate) s.active = true;
    const ev = out.emit({ kind: 'spell', playerId: p.id, spellId: def.id, name: def.name, cost, track, applied, ...(healed ? { healed } : {}) }, 'all');
    ctx.h.feedPush(st, ev, `${p.name} cast ${def.name}`);
    out.result = { cost, track, cur, active: s.active, applied, ...(healed ? { healed } : {}) };
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
    inv.containerUid = null;
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
    if (st.combat?.active) requireStatusAllowed(st, ctx, p, 'action');
    const library = libraryOf(st, ctx.pack);
    const inv = findUid(p.inventory, a.uid, 'item');
    const def = library.get('item', inv.itemId);
    if (!def?.use) throw bad(`${inv.name} has no use`);
    const use = def.use;
    let who = null;
    if (a.target !== undefined && a.target !== null) {
      const shareable = ctx.pack.ruleset.hotlist.combat && def.tags?.includes('potion');
      if (ctx.actor.role !== 'gm' && a.target !== p.id && !shareable) throw forbidden('only the GM can use this item on another character');
      who = playerOf(st, a.target);
      if (st.combat?.active && st.combat.combatants.some((c) => c.playerId === who.id && c.dead)) throw bad('that crawler is already dead');
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
      const tracks = ctx.pack.ruleset.tracks;
      if (use.heal.track === (tracks.find((t) => t.id === 'hp') ?? tracks[0])?.id) requireStatusAllowed(st, ctx, healTarget, 'heal');
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

  /**
   * `{ rollId, entered? }` Spend 1 AI Favor to reroll the d20 of your own roll (never a natural 1), once.
   * entered = what the real die showed. The result against the target is worked out again.
   */
  'roll.favor'(st, a, ctx, out) {
    const p = targetOf(st, a, ctx, 'play');
    const rec = rollOf(st, a.rollId);
    if (rec.playerId !== p.id) throw forbidden('only your own roll');
    if (rec.void || rec.part === 'damage' || hasResolvedDamage(st, rec.id)) throw bad('this roll can no longer be rerolled');
    if (rec.natural == null) throw bad('that roll has no d20');
    if (rec.natural === 1) throw bad('a natural 1 cannot be rerolled');
    if (rec.favored) throw bad('already rerolled');
    if (ctx.now - rec.at > 10 * 60_000) throw bad('too late to reroll that one');
    const fdef = ctx.pack.ruleset.fields.find((f) => f.id === 'aiFavor');
    if (!fdef) throw bad('this game has no AI Favor');
    const fav = Number(p.sheet.fields?.aiFavor ?? fdef.default ?? 0);
    if (!(fav > 0)) throw bad('no AI Favor left');
    const die = a.entered === undefined ? (ctx.dieInt ?? ctx.rollInt ?? ctx.randInt)(20) + 1 : int(a.entered, 'entered', 1, 20);
    p.sheet.fields = { ...(p.sheet.fields ?? {}), aiFavor: fav - 1 };
    const old = rec.natural;
    rec.total += die - old;
    const d = rec.dice.find((x) => x.die === 'd20');
    if (d) d.value = die;
    rec.natural = die;
    rec.nat20 = die === 20;
    rec.nat1 = die === 1;
    rec.favored = { from: old };
    rec.breakdown = { ...rec.breakdown, value: rec.total };
    rescore(st, ctx, rec);
    out.emit({ kind: 'rollUpdate', rollId: rec.id, playerId: p.id, name: p.name, why: 'favor', from: old, to: die }, 'all');
    const shown = publicRoll(rec);
    out.result = { natural: die, total: rec.total, vs: shown.vs ?? null, roll: shown };
  },

  /**
   * `{ rollId, entered? }` Intervene: add 1d6 to another crawler's check before it is acted on.
   * In reaction combat it uses one action, including a prepared Intervene action.
   */
  'roll.intervene'(st, a, ctx, out) {
    const rec = rollOf(st, a.rollId);
    if (rec.partyCheck) throw bad('no Intervene on a party check');
    if (rec.void || hasResolvedDamage(st, rec.id)) throw bad('this roll can no longer be helped');
    const me = ctx.actor.role === 'gm' ? (a.playerId ? playerOf(st, a.playerId) : null) : playerOf(st, ctx.actor.playerId);
    if (me && rec.playerId === me.id) throw bad('you cannot intervene on your own roll');
    if (!rec.vs || rec.vs.damage !== undefined || rec.vs.defense == null) throw bad('only a check or attack against a target');
    if (rec.vs.hit && (rec.vs.deg7 !== 'success' || rec.natural === 20)) throw bad('it already worked');
    if (rec.intervened) throw bad('someone already intervened');
    if (rec.what === 'stat') throw bad('no help on stat checks');
    if (ctx.now - rec.at > 10 * 60_000) throw bad('too late');
    const d6 = a.entered === undefined ? (ctx.dieInt ?? ctx.rollInt ?? ctx.randInt)(6) + 1 : int(a.entered, 'entered', 1, 6);
    const rx = st.combat?.active ? st.combat.rx : null;
    let receipt;
    if (rx && me) {
      const cb = (st.combat.combatants ?? []).find((x) => x.type === 'crawler' && (x.playerId === me.id || x.uid === me.id));
      if (!cb || cb.hp <= 0 || cb.dead || cb.dying != null) throw bad('that crawler cannot act');
      if (rx.step !== 'react' && rx.step !== 'act') throw bad('you cannot intervene in this phase');
      requireStatusAllowed(st, ctx, me, 'interrupt');
      const reserved = rx.intervene?.indexOf(cb.uid) ?? -1;
      if (reserved >= 0) rx.intervene.splice(reserved, 1);
      else ctx.h.spendReactionAction(rx, cb.uid);
      receipt = { spent: reserved < 0 ? 1 : 0, actionsLeft: rx.acts[cb.uid], utilityLeft: rx.nonAttackActions?.[cb.uid] ?? 0 };
    }
    rec.total += d6;
    rec.intervened = { by: me?.id ?? 'gm', name: me?.name ?? 'GM', d6 };
    rec.breakdown = { ...rec.breakdown, value: rec.total, parts: [...(rec.breakdown?.parts ?? []), { label: `Intervene (${me?.name ?? 'GM'})`, value: d6, source: 'intervene' }] };
    rescore(st, ctx, rec);
    out.emit({ kind: 'rollUpdate', rollId: rec.id, playerId: rec.playerId, why: 'intervene', by: me?.name ?? 'GM', d6, hit: !!rec.vs.hit }, 'all');
    out.result = { d6, total: rec.total, hit: !!rec.vs.hit, ...(receipt ? { receipt } : {}) };
  },

  'hotlist.set'(st, a, ctx) {
    const p = targetOf(st, a, ctx, 'sheet');
    const size = ctx.pack.ruleset.hotlist.size;
    const i = int(a.index, 'index', 0, Math.max(0, size - 1));
    if (!size) throw bad('this ruleset has no hotlist');
    if (a.uid === null) p.sheet.hotlist[i] = null;
    else {
      if (!ctx.pack.ruleset.hotlist.combat || !p.sheet.spells.some((s) => s.uid === a.uid)) findUid(p.inventory, a.uid, 'item');
      p.sheet.hotlist = p.sheet.hotlist.map((x) => (x === a.uid ? null : x));
      p.sheet.hotlist[i] = a.uid;
    }
  },

  roll(st, a, ctx0, out) {
    const w = a.what;
    if (!isObj(w)) throw bad('what must be an object');
    const secret = bool(a.secret, 'secret', { optional: true }) ?? false;
    const rs = ctx0.pack.ruleset;
    const by = ctx0.actor.role === 'gm' ? 'gm' : ctx0.actor.playerId;
    // Dice entry: the player rolled a real die and types it (entered), or rolls with advantage (adv / dis).
    const entered = a.entered === undefined ? null : int(a.entered, 'entered', 1, 1000);
    // Untrained check (ruleset skills.untrained): always with the ruleset's Disadvantage, no Ranks.
    const unt = w.kind === 'untrained' ? rs.skills?.untrained : null;
    if (w.kind === 'untrained' && !unt) throw bad('this game has no untrained checks');
    const requestedAdv = a.adv == null || ['adv', 'dis'].includes(a.adv) ? a.adv : (() => { throw bad('adv must be adv or dis'); })();
    const spellPlayer = w.kind === 'spell' ? targetOf(st, a, ctx0, 'play') : null;
    const ownedSpell = spellPlayer ? findUid(spellPlayer.sheet.spells, w.uid, 'spell') : null;
    const spellDef = ownedSpell ? libraryOf(st, ctx0.pack).get('spell', ownedSpell.spellId) : null;
    if (ownedSpell && (!rs.spells.attackChecks || !spellDef?.attackCheck)) throw bad('that spell does not use an attack check');
    const isStrike = (w.kind === 'attack' || w.kind === 'spell') && w.part !== 'damage';
    const attackPlayer = isStrike ? spellPlayer ?? targetOf(st, a, ctx0, 'play') : null;
    const combat = st.combat;
    const actor = attackPlayer && combat?.active && combat.combatants.find((v) => v.type === 'crawler' && v.playerId === attackPlayer.id);
    const earned = actor && combat.rx?.advantage?.find((v) => v.uid === actor.uid && v.mobUid === a.target);
    const inherent = unt?.adv ?? (isStrike && spellDef ? spellDef.attack.adv : null);
    const sizeRelation = attackPlayer && attackSizeRelation(combatRules(ctx0.pack, combat?.settings), attackPlayer.sheet.fields.size,
      combat?.combatants.find((v) => v.uid === a.target && v.type === 'mob')?.size);
    const sources = [requestedAdv, inherent, sizeRelation?.adv, earned ? 'adv' : null];
    const advCount = sources.reduce((n, source) => n + (source === 'adv' ? 1 : source === 'dis' ? -1 : 0), 0);
    const adv = advCount > 0 ? 'adv' : advCount < 0 ? 'dis' : null;
    const bonus = a.bonus === undefined ? 0 : int(a.bonus, 'bonus', -50, 50);
    const natural = { first: null, kept: null, other: null };
    const base = ctx0.dieInt ?? ctx0.rollInt ?? ctx0.randInt;
    const ctx = entered == null && !adv ? ctx0 : {
      ...ctx0,
      dieInt: (n) => {
        if (natural.first == null) {
          natural.first = n;
          if (entered != null) {
            if (entered > n) throw bad(`entered roll ${entered} is higher than d${n}`);
            natural.kept = entered;
            return entered - 1;
          }
          const x = base(n) + 1;
          const y = base(n) + 1;
          natural.kept = adv === 'adv' ? Math.max(x, y) : Math.min(x, y);
          natural.other = natural.kept === x ? y : x;
          return natural.kept - 1;
        }
        return base(n);
      },
    };
    const finish = (rec) => {
      if (entered != null) rec.entered = true;
      if (adv) { rec.adv = adv; rec.otherDie = natural.other; }
      if (bonus) {
        rec.total += bonus;
        rec.formula = `${rec.formula}${bonus > 0 ? '+' : ''}${bonus}`;
        rec.breakdown = { ...rec.breakdown, value: rec.total, parts: [...(rec.breakdown.parts ?? []), { label: 'Situational', value: bonus, source: 'bonus' }] };
      }
      rec.natural = rec.dice.find((d) => d.die === 'd20')?.value ?? null;
      if (ctx0.actionReceipt) rec.actionReceipt = ctx0.actionReceipt;
      if (ctx0.weaponHitId) rec.weaponHitId = ctx0.weaponHitId;
      if (ctx0.partyCheck) rec.partyCheck = true;
      if (rec.natural !== 20) rec.nat20 = false;
      if (rec.natural !== 1) rec.nat1 = false;
      if (ctx0.actor.role === 'player' && a.card !== false) rec.card = true;
      return rec;
    };
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
      const rec = finish(rollRecord(r, { ctx, p, by, label, formula, secret, what: 'custom' }));
      pushRoll(st, rec, out, ctx0);
      out.result = { rollId: rec.id, total: rec.total, roll: rec };
      return;
    }
    const p = spellPlayer ?? attackPlayer ?? targetOf(st, a, ctx, 'play');
    const library = libraryOf(st, ctx.pack);
    const { ch, computed } = computeFor(p, ctx.pack, library);
    const attackProfile = w.kind === 'attack' ? computed.attacks.find((x) => x.uid === w.uid) : null;
    let r;
    let formula;
    let label;
    let spellHitId;
    let spellPayment;
    if (ownedSpell) {
      if (w.part === 'damage') {
        const hit = st.rolls.find((v) => v.id === a.after && v.playerId === p.id && v.what === 'spell' && v.whatId === w.uid && v.part === 'hit' && !v.void);
        if (!hit || (hit.vs && (!hit.vs.hit || hit.vs.uid !== a.target))) throw bad('roll a successful attack with this spell first');
        if (st.rolls.some((v) => v.spellHitId === hit.id && !v.void)) throw bad('damage for that spell attack was already rolled');
        spellHitId = hit.id;
        const atk = spellDef.attack;
        const dice = ownedSpell.rank >= 5 && atk.rank5Dice ? atk.rank5Dice : atk.dice;
        formula = tmpl(rs.attack.damage, atk.stat ?? '', entered != null ? String(entered) : hit.vs?.crit ? critFormula(dice, combatRules(ctx.pack, st.combat?.settings)) : dice);
        r = doRoll(formula, sheetResolver(computed, ch, rs, { 'skill.rank': { value: ownedSpell.rank, label: 'Spell rank' } }), ctx);
        label = `${spellDef.name} damage`;
      } else {
        requireStatusAllowed(st, ctx, p, 'spell');
        const row = computed.spells.find((v) => v.uid === w.uid);
        label = `${spellDef.name} to hit`;
        ({ r, formula } = rollWith(rs.attack.roll || rs.dice, row.toHit, spellDef.name, ctx, `spell:${w.uid}`));
        spellPayment = payForSpell(st, p, library, computed, ownedSpell, ctx, out);
        if (rs.skills.usedTracking) ownedSpell.used = true;
      }
    } else if (w.kind === 'stat') {
      const def = rs.stats.find((s) => s.id === w.id);
      if (!def) throw notFound(`unknown stat ${w.id}`);
      label = `${def.abbr} check`;
      ({ r, formula } = rollWith(rs.dice, statCheckBonus(computed, def.id), `${def.abbr} mod`, ctx, `mod.${def.id}`));
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
        const stat0 = k.stat && rs.stats.some((s) => s.id === k.stat) ? k.stat : '';
        const stat = k.dmgStat === 'none' ? '' : k.dmgStat && rs.stats.some((s) => s.id === k.dmgStat) ? k.dmgStat : stat0;
        formula = tmpl(rs.attack.damage, stat, attackProfile.damageDice);
        // After a critical hit (a.after = the to-hit roll): the game's crit rule (5e: double dice).
        const prev = typeof a.after === 'string' ? st.rolls.find((x) => x.id === a.after && x.playerId === p.id) : null;
        // Entered damage = what the real damage dice showed (already doubled by the player on a 5e crit).
        if (entered != null) formula = tmpl(rs.attack.damage, stat, String(entered));
        else if (prev?.vs?.crit) formula = critFormula(formula, combatRules(ctx.pack, st.combat?.settings));
        label = `${k.name} damage${prev?.vs?.crit ? ' (critical)' : ''}`;
        r = doRoll(formula, sheetResolver(computed, ch, rs, { 'skill.rank': { value: sk?.rank ?? 0, label: 'Skill rank' } }), ctx);
        r.parts = r.parts.filter((x) => !(x.source?.startsWith('buff.') && x.value === 0 && !x.parts?.length));
      } else {
        label = `${k.name} to hit`;
        ({ r, formula } = rollWith(rs.attack.roll || rs.dice, attackProfile.toHit, `${k.name} to hit`, ctx, `attack:${k.uid}`));
        const skill = rs.skills.usedTracking && w.markUsed !== false && p.sheet.skills.find((s) => s.uid === k.skillUid);
        if (skill) skill.used = true;
      }
    } else if (w.kind === 'untrained') {
      const def = libraryOf(st, ctx.pack).get('skill', str(w.skillId, 'skillId', 80));
      if (!def) throw notFound(`unknown skill ${w.skillId}`);
      if ((unt.noCheckTypes ?? ['Passive']).includes(def.checkType)) throw bad(`${def.name} cannot be attempted untrained`);
      if (p.sheet.skills.some((x) => x.skillId === def.id)) throw bad(`${p.sheet.identity?.name || 'you'} already has ${def.name}: roll it from the sheet`);
      const stat = rs.stats.some((x) => x.id === w.stat) ? w.stat : def.stat;
      label = `${def.name} (untrained)`;
      formula = `${rs.skills.check.roll || rs.dice} + ${String(unt.formula || 'mod.{stat}').replaceAll('{stat}', stat)}`;
      r = doRoll(formula, sheetResolver(computed, ch, rs), ctx);
      // Tried this session: the Tutorial Floors teach one of them (Rank 1) at the end of the session.
      markUntrainedSkill(p, unt, floorOfState(st), def.id);
    } else throw bad('what.kind must be stat, derived, skill, attack, spell, untrained or custom');
    const rec = finish(rollRecord(r, { ctx, p, by, label, formula, secret, what: w.kind, whatId: w.kind === 'stat' || w.kind === 'derived' ? w.id : w.kind === 'untrained' ? w.skillId : w.uid ?? null }));
    if (w.kind === 'attack' || w.kind === 'spell') rec.part = w.part === 'damage' ? 'damage' : 'hit';
    if (isStrike && attackProfile?.melee && adv === 'dis' && sizeRelation?.damage) rec.sizeDamage = sizeRelation.damage;
    if (spellHitId) rec.spellHitId = spellHitId;
    if (spellPayment?.cost || spellPayment?.cooldown) {
      const { cur, ...payment } = spellPayment;
      rec.spellPayment = payment;
    }
    resolveAgainst(st, ctx0, a, rec, p, out, earned, attackProfile);
    pushRoll(st, rec, out, ctx0);
    const shown = ctx0.actor.role === 'gm' ? rec : publicRoll(rec);
    out.result = { rollId: rec.id, total: rec.total, roll: shown, ...(rec.vs ? { hit: rec.vs.hit, crit: rec.vs.crit, degree: rec.vs.degree, deg7: rec.vs.deg7 ?? null, typed: rec.vs.typed ?? null, advantage: !!rec.vs.advantage, applied: rec.applied ?? null } : {}) };
  },

  /** Dice mode for this crawler: off (everything at the table), enter (type the real die), digital (phone rolls). */
  'dice.mode'(st, a, ctx) {
    const p = targetOf(st, a, ctx, 'play');
    if (!DICE_MODES.includes(a.mode)) throw bad(`mode must be ${DICE_MODES.join(', ')}`);
    p.diceMode = a.mode;
  },

  /** A player takes back their own last roll (misclick), within two minutes. */
  'roll.undo'(st, a, ctx, out) {
    const p = targetOf(st, a, ctx, 'play');
    const rec = [...(st.rolls ?? [])].reverse().find((r) => r.playerId === p.id && !r.void && !r.auto);
    if (!rec) throw notFound('no roll to take back');
    if (ctx.actor.role === 'player' && ctx.now - rec.at > 120_000) throw bad('too late to take it back, ask the GM');
    const refunded = voidRoll(st, ctx, out, rec, ctx.actor.role === 'gm' ? 'gm' : p.id);
    out.result = { voided: rec.id };
    if (refunded) {
      const { rx } = st.combat;
      const { uid } = rec.actionReceipt;
      out.result.receipt = { spent: 0, refunded: 1, actionsLeft: rx.acts[uid], utilityLeft: rx.nonAttackActions?.[uid] ?? 0 };
    }
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
  // Damage type (fire, piercing…): mobs may resist / be vulnerable / immune. '' = untyped.
  if (a.dtype !== undefined) f.dtype = typeof a.dtype === 'string' && /^[a-z][a-z -]{0,29}$/i.test(a.dtype.trim()) ? a.dtype.trim().toLowerCase() : '';
  // Damage stat when it differs from the to-hit stat ('none' = the damage adds no stat). Omitted = same.
  if (a.dmgStat !== undefined) {
    if (a.dmgStat === '' || a.dmgStat === null) f.dmgStat = '';
    else if (a.dmgStat === 'none') f.dmgStat = 'none';
    else f.dmgStat = statOpt(a.dmgStat, rs) ?? '';
  }
  return f;
}

function learnSpell(st, p, spellId, rank, ctx) {
  const def = libraryOf(st, ctx.pack).get('spell', spellId);
  if (!def) throw notFound(`unknown spell ${spellId}`);
  if (p.sheet.spells.some((s) => s.spellId === def.id)) throw bad(`${p.name} already knows ${def.name}`);
  if (p.sheet.spells.length >= MAX_SPELLS) throw bad(`max ${MAX_SPELLS} spells`);
  const s = { uid: ctx.genId('sp'), spellId: def.id, rank: int(rank, 'rank', def.rankMax ? 1 : 0, def.rankMax ?? 1000, { optional: true }) ?? 1, active: false };
  p.sheet.spells.push(s);
  if (ctx.pack.ruleset.hotlist.combat && !st.combat?.active) {
    const free = p.sheet.hotlist.indexOf(null);
    if (free >= 0) p.sheet.hotlist[free] = s.uid;
  }
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
  /** Table correction: allow a known spell to be cast again. */
  'spell.ready'(st, a, ctx) {
    const p = targetOf(st, a, ctx, 'sheet');
    const s = findUid(p.sheet.spells, a.uid, 'spell');
    if (p.sheet.spellCasts) delete p.sheet.spellCasts[s.spellId];
  },
  /** `{ playerId? }` Wipe the untrained list (one crawler, or everyone): the session ended without learning. */
  'untrained.clear'(st, a) {
    for (const p of st.players) if (a.playerId === undefined || p.id === a.playerId) p.sheet.untried = [];
  },
  /** GM cancels any roll (wrong number typed, rolled the wrong thing). */
  'roll.void'(st, a, ctx, out) {
    const rec = (st.rolls ?? []).find((r) => r.id === a.id);
    if (!rec) throw notFound(`no roll ${a.id}`);
    voidRoll(st, ctx, out, rec, 'gm');
  },
  /** Brings a cancelled roll back (and its damage). */
  'roll.restore'(st, a, ctx, out) {
    const rec = (st.rolls ?? []).find((r) => r.id === a.id);
    if (!rec) throw notFound(`no roll ${a.id}`);
    unvoidRoll(st, ctx, out, rec);
  },
  /** Undo / redo chips: the last roll that hit or damaged something. */
  'roll.undoLast'(st, a, ctx, out) {
    const id = (st.rollUndo ?? []).at(-1);
    const rec = id ? (st.rolls ?? []).find((r) => r.id === id) : null;
    if (!rec) throw notFound('nothing to undo');
    voidRoll(st, ctx, out, rec, 'gm');
    out.result = { voided: rec.id, label: rec.label };
  },
  'roll.redoLast'(st, a, ctx, out) {
    const id = (st.rollRedo ?? []).at(-1);
    const rec = id ? (st.rolls ?? []).find((r) => r.id === id) : null;
    if (!rec) throw notFound('nothing to redo');
    unvoidRoll(st, ctx, out, rec);
    out.result = { restored: rec.id, label: rec.label };
  },
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
    const inj = ctx.pack.ruleset.combat?.injuries;
    const severity = r.added && inj && buff.buffId && ['minor', 'major'].find((k) => [inj[k], inj[`${k}Long`]].includes(buff.buffId));
    if (severity) {
      const flavor = typeof a.injuryDescription === 'string' ? a.injuryDescription.slice(0, 180) : nextInjuryDescription(p, inj, severity);
      if (flavor) buff.desc = [flavor, buff.desc].filter(Boolean).join(' ');
    }

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
    const when = a.when ?? 'session';
    if (when !== 'session' && when !== 'floor') throw bad('when must be session or floor');
    if (when === 'floor' && rule.sessionMaxRank == null) throw bad('this ruleset has no separate floor rank-up');
    const players = a.playerId === undefined ? st.players : [playerOf(st, a.playerId)];
    const library = libraryOf(st, ctx.pack);
    const results = [];
    for (const p of players) {
      for (const entry of rankUpEntries(p, rs, library)) {
        const s = entry.s;
        if (!s.used || (rule.sessionMaxRank != null && (s.rank > rule.sessionMaxRank) !== (when === 'floor'))) continue;
        results.push(rollSkillRankUp(st, p, entry, ctx, out));
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

  /** Art for a pack entry (read-only otherwise): a /pack/ image or URL, or null to go back to the pack's own. */
  'lib.art'(st, a, ctx) {
    if (!ART_KINDS.includes(a.kind)) throw bad(`kind must be one of ${ART_KINDS.join(', ')}`);
    if (typeof a.id !== 'string' || !ID_RE.test(a.id)) throw bad('id must be an id');
    if (!(ctx.pack.library?.[a.kind] ?? []).some((e) => e.id === a.id)) {
      throw notFound(`no pack ${a.kind} ${a.id} (for homebrew entries set the image in the editor)`);
    }
    st.libArt = isObj(st.libArt) ? st.libArt : normalizeLibArt(null);
    st.libArt[a.kind] ||= {};
    const packEntry = ctx.pack.library[a.kind].find((e) => e.id === a.id);
    const packArt = (a.kind === 'boss' && packEntry.imageSquare) || packEntry.image || null;
    const before = st.libArt[a.kind][a.id] ?? packArt;
    if (a.image == null || a.image === '') delete st.libArt[a.kind][a.id];
    else {
      // An uploaded picture comes as a small data:image URL (the desk shrinks it to ≤ 320 px, ≤ 80 KB).
      const upload = typeof a.image === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(a.image) && a.image.length <= 80_000;
      if (typeof a.image !== 'string' || (!upload && !ART_URL.test(a.image))) throw bad('image must be a /pack/ path, an http(s) URL or a small uploaded picture');
      if (!(a.id in st.libArt[a.kind]) && Object.keys(st.libArt[a.kind]).length >= MAX_ART_PER_KIND) throw bad('too many art picks');
      st.libArt[a.kind][a.id] = a.image;
    }
    // combatants already in the fight from this entry follow, unless the GM gave one its own picture
    const after = st.libArt[a.kind][a.id] ?? packArt;
    for (const m of st.combat?.combatants ?? []) {
      if (m.type === 'mob' && m.sourceKind === a.kind && m.sourceId === a.id && (m.image ?? null) === before) m.image = after;
    }
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
      out.result = { uid: giveItem(p, def, ctx, int(a.qty, 'qty', 1, 9999, { optional: true }) ?? 1, int(a.bonus, 'bonus', 0, MAX_ENHANCE, { optional: true }) ?? 0).uid };
    } else if (a.kind === 'spell') {
      out.result = { uid: learnSpell(st, p, a.id, a.rank, ctx).uid };
    } else if (a.kind === 'skill') {
      SHEET['skill.add'](st, { playerId: p.id, skillId: a.id, rank: a.rank }, ctx, out);
    } else if (a.kind === 'buff') {
      SHEET_GM['buff.add'](st, { playerId: p.id, buffId: a.id }, ctx, out);
    } else throw bad('kind must be item, spell, skill or buff');
  },

  'session.permissions'(st, a) {
    if (a.playerEdit === undefined && a.allowOrigins === undefined) throw bad('playerEdit or allowOrigins required');
    if (a.playerEdit !== undefined && !PLAYER_EDIT.includes(a.playerEdit)) throw bad(`playerEdit must be one of ${PLAYER_EDIT.join(', ')}`);
    if (a.allowOrigins !== undefined && typeof a.allowOrigins !== 'boolean') throw bad('allowOrigins must be a boolean');
    st.session.permissions = { ...(st.session.permissions ?? {}), ...(a.playerEdit !== undefined ? { playerEdit: a.playerEdit } : {}), ...(a.allowOrigins !== undefined ? { allowOrigins: a.allowOrigins } : {}) };
  },

  /** Applies the player's requested race / class / background and locks them for the player. */
  'origins.approve'(st, a, ctx, out) {
    const p = playerOf(st, a.playerId);
    const pend = p.sheet.pending ?? {};
    if (!Object.keys(pend).length) throw bad(`${p.name} has no origin request`);
    for (const [k, v] of Object.entries(pend)) setPath(p, `identity.${k}`, v, ctx.pack, out);
    p.sheet.pending = {};
    p.sheet.originsLocked = true;
    out.result = { race: p.race, class: p.klass, background: p.sheet.identity.background ?? '' };
  },

  'origins.deny'(st, a) {
    const p = playerOf(st, a.playerId);
    p.sheet.pending = {};
  },

  /** GM: let the player choose again (clears the lock) or lock without a request. */
  'origins.lock'(st, a) {
    const p = playerOf(st, a.playerId);
    if (typeof a.locked !== 'boolean') throw bad('locked must be a boolean');
    p.sheet.originsLocked = a.locked;
  },
};

/** Rolls visible to a role: GM all; player non-secret + own secret; stage non-secret. Last VIEW_ROLLS. */
export function rollsFor(state, role, playerId) {
  const rolls = Array.isArray(state.rolls) ? state.rolls : [];
  const vis = role === 'gm' ? rolls : rolls.filter((r) => !r.secret || (role === 'player' && r.by === playerId)).map(publicRoll);
  return vis.slice(-VIEW_ROLLS);
}

export { ActionError };
