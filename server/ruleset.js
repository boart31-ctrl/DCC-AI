// Rulesets, library entries, effects and the computed character sheet (browser-safe).
// Contract: docs/RULESET.md (v2).
import { evaluate, diceText, validateFormula } from './formula.js';

export const LIB_KINDS = ['item', 'spell', 'skill', 'buff', 'feature', 'race', 'class', 'background', 'boss', 'location', 'monster', 'npc'];
export const EFFECT_WHENS = ['equipped', 'carried', 'active', 'always'];
export const RANKUP_RULES = ['gt', 'gte', 'lt', 'lte'];
export const FIELD_TYPES = ['number', 'text', 'longtext'];
export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const DEFAULT_WHEN = { item: 'equipped', spell: 'active', buff: 'active', feature: 'always', race: 'always', class: 'always', background: 'always' };

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TARGET_RE = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+){0,3}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const noteOf = (o) => ({ ...(o?.verify === true ? { verify: true } : {}), ...(isStr(o?.note) ? { note: o.note.trim().slice(0, 300) } : {}) });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const safeId = (v) => typeof v === 'string' && ID_RE.test(v) && !FORBIDDEN_KEYS.has(v);
const text = (v, max, dflt = '') => (typeof v === 'string' ? v.trim().slice(0, max) : dflt);
const finite = (v, dflt) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);

export class RulesetError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'RulesetError';
  }
}

// Collects problems: strict → throws on the first one, otherwise pushes a warning and skips.
function problem(ctx, msg) {
  if (ctx.strict) throw new RulesetError(msg);
  ctx.warnings.push(msg);
}

function formulaOk(src, ctx, where, { dice = false } = {}) {
  const err = validateFormula(src, { dice });
  if (err) {
    problem(ctx, `${where}: invalid formula ${JSON.stringify(String(src).slice(0, 60))} (${err})`);
    return false;
  }
  return true;
}

// Only `verify: true` marks an unverified rule; a bare `note` is documentation (shown, not flagged).
function unverified(raw, path, out) {
  if (!isObj(raw)) return;
  if (raw.verify === true) out.push({ kind: 'unverified', path, note: text(raw.note, 200) || 'not verified against the rulebook' });
}

// ---------- effects ----------

/** Validated effects list. ctx = { strict, warnings, where, kind } */
export function normalizeEffects(raw, ctx) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    problem(ctx, `${ctx.where}: effects must be an array`);
    return [];
  }
  if (raw.length > 20) problem(ctx, `${ctx.where}: max 20 effects`);
  const out = [];
  raw.slice(0, 20).forEach((e, i) => {
    const w = `${ctx.where} effects[${i}]`;
    if (!isObj(e)) return problem(ctx, `${w}: must be an object`);
    if (typeof e.target !== 'string' || e.target.length > 64 || !TARGET_RE.test(e.target) || e.target.split('.').some((s) => FORBIDDEN_KEYS.has(s))) {
      return problem(ctx, `${w}: bad target ${JSON.stringify(e.target)}`);
    }
    const op = e.op ?? 'add';
    if (op !== 'add' && op !== 'set') return problem(ctx, `${w}: op must be add or set`);
    let value = e.value ?? 0;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Math.abs(value) > 1e6) return problem(ctx, `${w}: value out of range`);
    } else if (typeof value === 'string') {
      value = value.trim();
      if (value.length > 200 || !formulaOk(value, ctx, w)) return undefined;
    } else return problem(ctx, `${w}: value must be a number or formula`);
    const when = e.when ?? DEFAULT_WHEN[ctx.kind] ?? 'always';
    if (!EFFECT_WHENS.includes(when)) return problem(ctx, `${w}: when must be one of ${EFFECT_WHENS.join(', ')}`);
    const eff = { target: e.target, op, value, when, label: text(e.label, 80) };
    unverified(e, w, ctx.unverified ?? []);
    out.push(eff);
  });
  return out;
}

function normalizeAttackDef(raw, ctx, where) {
  if (raw == null) return null;
  if (!isObj(raw)) {
    problem(ctx, `${where}: attack must be an object`);
    return null;
  }
  const dice = text(raw.dice, 60);
  if (dice && !formulaOk(dice, ctx, `${where} attack.dice`, { dice: true })) return null;
  return { skill: safeId(raw.skill) ? raw.skill : null, stat: safeId(raw.stat) ? raw.stat : null, dice, effects: text(raw.effects, 300) };
}

function idList(raw, max = 50) {
  return Array.isArray(raw) ? [...new Set(raw.filter(safeId))].slice(0, max) : [];
}

/**
 * Validates one library entry of `kind`. opts = { strict, warnings, where, source, image(rel) }.
 * Returns the normalized entry or null (non-strict) / throws RulesetError (strict).
 */
export function normalizeLibEntry(kind, raw, opts = {}) {
  const ctx = { strict: !!opts.strict, warnings: opts.warnings ?? [], kind, unverified: [] };
  const where = (ctx.where = opts.where ?? `${kind}`);
  if (!LIB_KINDS.includes(kind)) {
    problem(ctx, `unknown library kind ${JSON.stringify(kind)}`);
    return null;
  }
  if (!isObj(raw)) {
    problem(ctx, `${where}: must be an object`);
    return null;
  }
  if (!safeId(raw.id)) {
    problem(ctx, `${where}: id required (letters/digits/_/- , max 64)`);
    return null;
  }
  ctx.where = `${where} ${raw.id}`;
  if (!isStr(raw.name)) {
    problem(ctx, `${ctx.where}: name required`);
    return null;
  }
  if (typeof raw.name === 'string' && raw.name.trim().length > 80) {
    problem(ctx, `${ctx.where}: name too long (max 80)`);
    if (ctx.strict) return null;
  }
  const e = {
    id: raw.id,
    name: text(raw.name, 80),
    desc: text(raw.desc, 2000),
    tags: Array.isArray(raw.tags) ? raw.tags.filter(isStr).map((t) => t.trim().slice(0, 30)).slice(0, 20) : [],
    source: opts.source ?? 'homebrew',
  };
  if (kind === 'item') {
    let rarity = raw.rarity ?? 'common';
    if (!RARITIES.includes(rarity)) {
      problem(ctx, `${ctx.where}: unknown rarity "${rarity}", using common`);
      rarity = 'common';
    }
    Object.assign(e, {
      rarity,
      slot: safeId(raw.slot) ? raw.slot : null,
      stackable: raw.stackable === true,
      effects: normalizeEffects(raw.effects, ctx),
      attack: normalizeAttackDef(raw.attack, ctx, ctx.where),
      flavor: text(raw.flavor, 2000),
      image: opts.image ? opts.image(raw.image) : homebrewImage(raw.image, ctx),
      use: normalizeUse(raw.use, ctx),
    });
  } else if (kind === 'spell') {
    let cost = raw.cost ?? 0;
    if (typeof cost === 'string') {
      cost = cost.trim();
      if (!cost) cost = 0;
      else if (cost.length > 200 || !formulaOk(cost, ctx, `${ctx.where} cost`)) cost = 0;
    } else if (!Number.isFinite(cost) || cost < 0 || cost > 1e6) {
      problem(ctx, `${ctx.where}: cost must be a number >= 0 or a formula`);
      cost = 0;
    }
    const dice = text(raw.dice, 60);
    Object.assign(e, {
      cost,
      costTrack: safeId(raw.costTrack) ? raw.costTrack : null,
      range: text(raw.range, 80),
      duration: text(raw.duration, 80),
      effects: normalizeEffects(raw.effects, ctx),
      attack: normalizeAttackDef(raw.attack, ctx, ctx.where),
      dice: dice && formulaOk(dice, ctx, `${ctx.where} dice`, { dice: true }) ? dice : '',
      rankScaling: text(raw.rankScaling, 500),
      applies: safeId(raw.applies) ? raw.applies : null,
      flavor: text(raw.flavor, 2000),
    });
  } else if (kind === 'skill') {
    Object.assign(e, {
      stat: safeId(raw.stat) ? raw.stat : '',
      checkType: text(raw.checkType, 40),
      upgrades: Array.isArray(raw.upgrades)
        ? raw.upgrades.filter((u) => isObj(u) && Number.isInteger(u.rank) && isStr(u.text)).slice(0, 50).map((u) => ({ rank: u.rank, text: text(u.text, 500) }))
        : [],
    });
  } else if (kind === 'buff') {
    Object.assign(e, { effects: normalizeEffects(raw.effects, ctx), duration: text(raw.duration, 80), external: raw.external === true });
  } else if (kind === 'feature') {
    Object.assign(e, { effects: normalizeEffects(raw.effects, ctx) });
  } else if (kind === 'boss') {
    Object.assign(e, normalizeBossEntry(raw, ctx, opts));
  } else if (kind === 'location') {
    Object.assign(e, {
      floor: floorText(raw.floor),
      image: opts.image ? opts.image(raw.image) : homebrewImage(raw.image, ctx),
      readAloud: text(raw.readAloud, 1200),
      features: textList(raw.features, 30, 300), // GM only
      npcs: idList(raw.npcs, 30),
      monsters: idList(raw.monsters, 30),
      bosses: idList(raw.bosses, 10),
    });
  } else if (kind === 'monster') {
    Object.assign(e, normalizeMonsterEntry(raw, ctx, opts));
  } else if (kind === 'npc') {
    Object.assign(e, {
      role: text(raw.role, 120),
      floor: floorText(raw.floor),
      image: opts.image ? opts.image(raw.image) : homebrewImage(raw.image, ctx),
      personality: text(raw.personality, 1200),
      intro: text(raw.intro, 600), // the System introduces them the first time they are on the TV
      voice: text(raw.voice, 600), // GM only: how to play them
      hooks: textList(raw.hooks, 20, 400), // GM only
      secrets: textList(raw.secrets, 20, 400), // GM only
    });
  } else {
    Object.assign(e, { features: idList(raw.features), statBonuses: normalizeEffects(raw.statBonuses, ctx), skills: idList(raw.skills) });
  }
  if (['boss', 'monster', 'npc', 'location'].includes(kind)) {
    const snd = soundMap(raw.sounds);
    if (snd) e.sounds = snd;
    const mom = moments(raw.moments);
    if (mom.length) e.moments = mom;
  }
  if (ctx.unverified.length) e.unverified = ctx.unverified;
  return e;
}

/** Boss library entry (bosses.json / homebrew): art, HP slots, phases. See docs/CONTENT_PACKS.md. */
function normalizeBossEntry(raw, ctx, opts) {
  const img = (v) => (opts.image ? opts.image(v) : homebrewImage(v, ctx));
  let hpSlots = 10;
  if (raw.hpSlots !== undefined) {
    if (Number.isInteger(raw.hpSlots) && raw.hpSlots >= 1 && raw.hpSlots <= 100) hpSlots = raw.hpSlots;
    else problem(ctx, `${ctx.where}: hpSlots must be an integer 1..100, using 10`);
  }
  const phases = [];
  if (raw.phases != null && !Array.isArray(raw.phases)) problem(ctx, `${ctx.where}: phases must be an array`);
  for (const [i, p] of (Array.isArray(raw.phases) ? raw.phases : []).entries()) {
    if (phases.length >= 10) { problem(ctx, `${ctx.where}: max 10 phases`); break; }
    if (!isObj(p) || !isStr(p.name)) { problem(ctx, `${ctx.where}: phases[${i}] needs a name`); continue; }
    const atHp = Number.isInteger(p.atHp) && p.atHp >= 0 && p.atHp <= 100 ? p.atHp : null;
    if (p.atHp != null && atHp === null) problem(ctx, `${ctx.where}: phases[${i}].atHp must be an integer 0..100`);
    phases.push({ name: text(p.name, 60), text: text(p.text, 300), image: img(p.image), atHp });
  }
  let color = null;
  if (raw.color != null && raw.color !== '') {
    if (typeof raw.color === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw.color)) color = raw.color;
    else problem(ctx, `${ctx.where}: color must be #rrggbb`);
  }
  // Optional extra art (bosses.json): a square crop for cards / the combat tracker, and a defeated pose.
  const imageSquare = raw.imageSquare != null && raw.imageSquare !== '' ? img(raw.imageSquare) : null;
  const imageKo = raw.imageKo != null && raw.imageKo !== '' ? img(raw.imageKo) : null;
  return {
    title: text(raw.title, 120),
    image: img(raw.image),
    ...(imageSquare ? { imageSquare } : {}),
    ...(imageKo ? { imageKo } : {}),
    hpSlots,
    phases,
    flavor: text(raw.flavor, 600),
    color,
    lootTier: safeId(raw.lootTier) ? raw.lootTier : null,
    floor: floorText(raw.floor),
    intro: text(raw.intro, 600), // the System's announcement: TV + voice
    defeatLine: text(raw.defeatLine, 300), // TV + voice on defeat
    lootHint: text(raw.lootHint, 300), // GM desk only (never copied into the scene)
    tactics: text(raw.tactics, 3000), // GM desk only
    // Stat block for running the boss as a combatant (optional; the boss scene ignores these).
    evade: intOr(raw, 'evade', -99, 99, 0, ctx),
    dr: intOr(raw, 'dr', -99, 99, 0, ctx),
    attacks: normalizeStatAttacks(raw.attacks, ctx),
  };
}

// ---------- sounds on library entries (web/js/cues.js) ----------
const SREF = /^(tag:)?[A-Za-z0-9_-]{1,60}$/;
const sRefs = (v) => [...new Set((Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => SREF.test(x)))].slice(0, 20);
/** `sounds: { intro, attack, hit, death, ambience, randoms, music, … }` → { slot: [refs] }; plus `randomEvery: [min, max]` s. */
function soundMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'randomEvery' && Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(n) && n >= 5 && n <= 3600)) { out.randomEvery = [Math.min(v[0], v[1]), Math.max(v[0], v[1])]; continue; }
    if (!/^[a-z0-9_]{1,30}$/.test(k)) continue;
    const refs = sRefs(v);
    if (refs.length) out[k] = refs;
  }
  return Object.keys(out).length ? out : null;
}
/** Situational moments: [{ label, sounds, text?, chance (0..1, 0 = button only), on? (intro|phase|defeat|nat1|nat20|hit|kill) }]. */
const MOMENT_ON = ['intro', 'phase', 'defeat', 'nat1', 'nat20', 'hit', 'kill', 'attack'];
function moments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 12).filter((m) => m && typeof m === 'object').map((m) => ({
    label: text(m.label, 40) || 'Moment',
    sounds: sRefs(m.sounds),
    text: text(m.text, 300),
    chance: typeof m.chance === 'number' && m.chance >= 0 && m.chance <= 1 ? m.chance : 0,
    on: MOMENT_ON.includes(m.on) ? m.on : null,
  })).filter((m) => m.sounds.length || m.text);
}

function textList(raw, max, len) {
  return Array.isArray(raw) ? raw.filter(isStr).slice(0, max).map((f) => text(f, len)) : [];
}

function intOr(raw, key, lo, hi, dflt, ctx) {
  const v = raw[key];
  if (v === undefined || v === null || v === '') return dflt;
  if (Number.isInteger(v) && v >= lo && v <= hi) return v;
  problem(ctx, `${ctx.where}: ${key} must be an integer ${lo}..${hi}, using ${dflt}`);
  return dflt;
}

/** Stat-block attacks (monsters, bosses): [{name, toHit, damage, effects, buffs[]}]. */
function normalizeStatAttacks(raw, ctx) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    problem(ctx, `${ctx.where}: attacks must be an array`);
    return [];
  }
  const out = [];
  raw.slice(0, 12).forEach((a, i) => {
    const w = `${ctx.where} attacks[${i}]`;
    if (!isObj(a) || !isStr(a.name)) return problem(ctx, `${w}: needs a name`);
    let toHit = 0;
    if (a.toHit != null && a.toHit !== '') {
      if (Number.isInteger(a.toHit) && Math.abs(a.toHit) <= 99) toHit = a.toHit;
      else problem(ctx, `${w}: toHit must be an integer -99..99`);
    }
    let damage = typeof a.damage === 'number' && Number.isInteger(a.damage) ? String(a.damage) : text(a.damage, 60);
    if (damage && !formulaOk(damage, ctx, `${w} damage`, { dice: true })) damage = '';
    out.push({ name: text(a.name, 60), toHit, damage, effects: text(a.effects, 400), buffs: idList(a.buffs, 10) });
  });
  return out;
}

/** Monster library entry (monsters.json / homebrew): a mob stat block. See docs/CONTENT_PACKS.md. */
function normalizeMonsterEntry(raw, ctx, opts) {
  return {
    title: text(raw.title, 120),
    floor: floorText(raw.floor),
    group: text(raw.group, 40),
    image: opts.image ? opts.image(raw.image) : homebrewImage(raw.image, ctx),
    // Family look-alikes: when several of this monster fight at once, each copy gets a different picture.
    // Pack: file names under images/ (missing files are skipped quietly, art may still be on its way).
    variants: monsterVariants(raw.variants, ctx, opts),
    hpSlots: intOr(raw, 'hpSlots', 1, 100, 5, ctx),
    evade: intOr(raw, 'evade', -99, 99, 0, ctx),
    dr: intOr(raw, 'dr', -99, 99, 0, ctx),
    attacks: normalizeStatAttacks(raw.attacks, ctx),
    flavor: text(raw.flavor, 1200),
    intro: text(raw.intro, 600), // the System's announcement the first time it shows up: TV voice
    defeatLine: text(raw.defeatLine, 300),
    lootItems: idList(raw.lootItems, 20),
    notes: text(raw.notes, 3000), // GM only
    tactics: text(raw.tactics, 3000), // GM only
    lootHint: text(raw.lootHint, 300), // GM only
  };
}

function monsterVariants(v, ctx, opts) {
  if (v == null) return [];
  if (!Array.isArray(v)) {
    problem(ctx, `${ctx.where}: variants must be an array of images`);
    return [];
  }
  const pick = opts.imageOptional ?? opts.image ?? ((x) => homebrewImage(x, ctx));
  return [...new Set(v.filter(isStr).slice(0, 16).map((x) => pick(x)).filter(Boolean))];
}

/** Floor as display text: 1 → "1", "B2" → "B2". */
function floorText(v) {
  if (Number.isInteger(v) && v >= -99 && v <= 999) return String(v);
  return text(v, 20);
}

/**
 * Item `use`: { heal: {track, amount} | null, applyBuff, removeBuff, target, consume, buffOnFail, note }.
 * Also accepts the short form { track, delta, buff }.
 */
function normalizeUse(raw, ctx) {
  if (raw == null) return null;
  if (!isObj(raw)) {
    problem(ctx, `${ctx.where}: use must be an object`);
    return null;
  }
  let heal = null;
  const h = isObj(raw.heal) ? { track: raw.heal.track, amount: raw.heal.amount } : raw.track !== undefined ? { track: raw.track, amount: raw.delta } : null;
  if (h) {
    if (safeId(h.track) && Number.isFinite(h.amount) && Math.abs(h.amount) <= 1e6) heal = { track: h.track, amount: h.amount };
    else problem(ctx, `${ctx.where}: use.heal needs a track id and a numeric amount`);
  }
  const buff = raw.applyBuff ?? raw.buff;
  return {
    heal,
    applyBuff: safeId(buff) ? buff : null,
    removeBuff: safeId(raw.removeBuff) ? raw.removeBuff : null,
    target: text(raw.target, 60) || 'self',
    consume: typeof raw.consume === 'boolean' ? raw.consume : null,
    buffOnFail: safeId(raw.buffOnFail) ? raw.buffOnFail : null,
    note: text(raw.note, 300),
  };
}

function homebrewImage(v, ctx) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') return null;
  if (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length <= 200_000) return v;
  if (/^(https?:\/\/|\/pack\/)[^\s"'<>]{1,2000}$/.test(v)) return v;
  problem(ctx, `${ctx.where}: image must be an http(s) URL, /pack/ path or small data:image URL`);
  return null;
}

// ---------- ruleset ----------

function listOf(raw, key, ctx, mapper) {
  if (raw == null) return null;
  if (!Array.isArray(raw)) {
    ctx.warnings.push(`ruleset.json "${key}" must be an array, ignoring`);
    return null;
  }
  const seen = new Set();
  const out = [];
  raw.forEach((e, i) => {
    if (!isObj(e) || !safeId(e.id) || seen.has(e.id)) {
      ctx.warnings.push(`ruleset.json ${key}[${i}]: missing, invalid or duplicate id, skipping`);
      return;
    }
    seen.add(e.id);
    const m = mapper(e, `${key}[${i}]`);
    if (m) out.push(m);
  });
  return out;
}

function statDefault(d, parts) {
  if (typeof d === 'number' && Number.isFinite(d)) return Object.fromEntries(parts.map((p) => [p, d]));
  const o = {};
  for (const p of parts) o[p] = isObj(d) ? finite(d[p], 0) : 0;
  return o;
}

/**
 * Normalizes ruleset.json (any key may be missing). legacy = { stats, resources } from pack.json, used
 * when the ruleset does not define stats / tracks. Returns a JSON-safe object; idempotent.
 * Inline race/class/background objects are moved to `ruleset.inlineLibrary` (consumed by pack-core).
 */
export function normalizeRuleset(raw, legacy = {}, warnings = []) {
  const ctx = { strict: false, warnings };
  if (raw != null && !isObj(raw)) {
    warnings.push('ruleset.json must be an object, ignoring');
    raw = null;
  }
  const r = raw ?? {};
  const unv = [];

  const stats =
    listOf(r.stats, 'stats', ctx, (s) => {
      const parts = Array.isArray(s.parts) && s.parts.length ? [...new Set(s.parts.filter(safeId))].slice(0, 6) : ['enhanced', 'unenhanced'];
      unverified(s, `stats.${s.id}`, unv);
      return { id: s.id, label: text(s.label, 40) || s.id, abbr: text(s.abbr, 8) || s.id.slice(0, 3).toUpperCase(), parts, default: statDefault(s.default, parts), ...noteOf(s) };
    }) ??
    (legacy.stats ?? []).map((s) => ({ id: s.id, label: s.label, abbr: s.abbr, parts: ['enhanced', 'unenhanced'], default: statDefault(s.default, ['enhanced', 'unenhanced']) }));

  const sm = isObj(r.statMod) ? r.statMod : {};
  let modFormula = isStr(sm.formula) ? sm.formula.trim() : 'x';
  if (!formulaOk(modFormula, ctx, 'ruleset.json statMod.formula')) modFormula = 'x';
  const statMod = { from: safeId(sm.from) ? sm.from : stats[0]?.parts[0] ?? 'enhanced', formula: modFormula };
  if (sm.verify === true) statMod.verify = true;
  if (isStr(sm.note)) statMod.note = text(sm.note, 200);
  unverified(sm, 'statMod', unv);

  const derived =
    listOf(r.derived, 'derived', ctx, (d, w) => {
      if (!isStr(d.formula) || !formulaOk(d.formula, ctx, `ruleset.json ${w}.formula`)) return null;
      const roll = text(d.roll, 60);
      const out = { id: d.id, label: text(d.label, 40) || d.id, formula: d.formula.trim(), display: text(d.display, 60) || '{value}', roll: roll && !validateFormula(roll, { dice: true }) ? roll : '', ...noteOf(d) };
      unverified(d, `derived.${d.id}`, unv);
      return out;
    }) ?? [];

  const fields =
    listOf(r.fields, 'fields', ctx, (f) => {
      const type = FIELD_TYPES.includes(f.type) ? f.type : 'number';
      const dflt = type === 'number' ? finite(f.default, 0) : text(f.default, 4000);
      unverified(f, `fields.${f.id}`, unv);
      return { id: f.id, label: text(f.label, 40) || f.id, type, default: dflt, group: text(f.group, 40) || 'general', ...noteOf(f) };
    }) ?? [];

  const tracks =
    listOf(r.tracks, 'tracks', ctx, (t, w) => {
      const kind = t.kind === 'slots' ? 'slots' : 'pool';
      const out = { id: t.id, label: text(t.label, 40) || t.id, kind, color: /^#[0-9a-fA-F]{3,6}$/.test(t.color ?? '') ? t.color : '#888888', default: Math.max(0, finite(t.default, 0)) };
      if (kind === 'slots') {
        out.slots = Number.isInteger(t.slots) && t.slots > 0 && t.slots <= 100 ? t.slots : 10;
        out.labels = Array.isArray(t.labels) ? t.labels.filter((x) => typeof x === 'string').map((x) => x.slice(0, 20)).slice(0, out.slots) : [];
      }
      if (isStr(t.maxFormula) && formulaOk(t.maxFormula, ctx, `ruleset.json ${w}.maxFormula`)) out.maxFormula = t.maxFormula.trim();
      unverified(t, `tracks.${t.id}`, unv);
      return { ...out, ...noteOf(t) };
    }) ?? (legacy.resources ?? []).map((x) => ({ id: x.id, label: x.label, kind: 'pool', color: x.color, default: x.default }));

  const slots =
    listOf(r.slots, 'slots', ctx, (s) => {
      unverified(s, `slots.${s.id}`, unv);
      return { id: s.id, label: text(s.label, 40) || s.id, max: Number.isInteger(s.max) && s.max >= 1 && s.max <= 100 ? s.max : 1, ...noteOf(s) };
    }) ?? [];

  const ext = isObj(r.buffSlots) && isObj(r.buffSlots.external) ? r.buffSlots.external : {};
  const buffSlots = { external: { label: text(ext.label, 40) || 'External buffs', max: Number.isInteger(ext.max) && ext.max >= 0 ? ext.max : null } };
  const hotlist = { size: Number.isInteger(r.hotlist?.size) && r.hotlist.size >= 0 && r.hotlist.size <= 50 ? r.hotlist.size : 10 };

  const sk = isObj(r.skills) ? r.skills : {};
  let rankUp = null;
  if (isObj(sk.rankUp)) {
    const roll = isStr(sk.rankUp.roll) && !validateFormula(sk.rankUp.roll, { dice: true }) ? sk.rankUp.roll.trim() : 'd20';
    const rule = RANKUP_RULES.includes(sk.rankUp.rule) ? sk.rankUp.rule : 'gt';
    let target = typeof sk.rankUp.target === 'number' ? sk.rankUp.target : isStr(sk.rankUp.target) ? sk.rankUp.target.trim() : 'rank';
    if (typeof target === 'string' && !formulaOk(target, ctx, 'ruleset.json skills.rankUp.target')) target = 'rank';
    const amount = Number.isInteger(sk.rankUp.amount) && sk.rankUp.amount >= 1 && sk.rankUp.amount <= 100 ? sk.rankUp.amount : 1;
    rankUp = { roll, rule, target, amount, ...noteOf(sk.rankUp) };
    unverified(sk.rankUp, 'skills.rankUp', unv);
  }
  const checkTypes = Array.isArray(sk.checkTypes) && sk.checkTypes.some(isStr) ? sk.checkTypes.filter(isStr).map((x) => x.trim().slice(0, 40)).slice(0, 20) : ['Standard'];
  const catalog = [];
  if (Array.isArray(sk.catalog)) {
    sk.catalog.forEach((c, i) => {
      const e = normalizeLibEntry('skill', c, { warnings, where: `ruleset.json skills.catalog[${i}]`, source: 'pack' });
      if (e && !catalog.some((x) => x.id === e.id)) catalog.push(e);
    });
  }
  unverified(sk, 'skills', unv);
  let check = { roll: '', formula: 'skill.rank + mod.{stat}' };
  if (isObj(sk.check)) {
    const roll = isStr(sk.check.roll) && !validateFormula(sk.check.roll, { dice: true }) ? sk.check.roll.trim() : '';
    const f = isStr(sk.check.formula) && !validateFormula(tmpl(sk.check.formula, 'str', ''), {}) ? sk.check.formula.trim() : null;
    if (isStr(sk.check.formula) && !f) warnings.push('ruleset.json skills.check.formula invalid, using rank + mod');
    check = { roll, formula: f ?? check.formula, ...noteOf(sk.check) };
    unverified(sk.check, 'skills.check', unv);
  }
  const rankMax = Number.isInteger(sk.rankMax) && sk.rankMax >= 1 && sk.rankMax <= 1000 ? sk.rankMax : 20;
  const skills = {
    columns: Array.isArray(sk.columns) ? sk.columns.filter(isStr).slice(0, 10) : ['rank', 'stat', 'checkType'],
    rankMin: Number.isInteger(sk.rankMin) && sk.rankMin >= 0 && sk.rankMin <= rankMax ? sk.rankMin : 0,
    rankMax,
    check,
    checkTypes,
    usedTracking: sk.usedTracking !== false,
    rankUp,
    catalog,
  };

  const at = isObj(r.attack) ? r.attack : {};
  unverified(at, 'attack', unv);
  const attack = {
    roll: isStr(at.roll) && !validateFormula(at.roll, { dice: true }) ? at.roll.trim() : '',
    toHit: isStr(at.toHit) && !validateFormula(tmpl(at.toHit, 'str', '0'), {}) ? at.toHit.trim() : 'skill.rank + mod.{stat}',
    damage: isStr(at.damage) && !validateFormula(tmpl(at.damage, 'str', '1d6'), { dice: true }) ? at.damage.trim() : '{dice} + mod.{stat}',
  };
  if (isStr(at.toHit) && attack.toHit !== at.toHit.trim()) warnings.push('ruleset.json attack.toHit invalid, using default');
  if (isStr(at.damage) && attack.damage !== at.damage.trim()) warnings.push('ruleset.json attack.damage invalid, using default');
  if (isStr(at.note)) attack.note = text(at.note, 200);

  const trackIds = tracks.map((t) => t.id);
  const costTrack = safeId(r.spells?.costTrack) ? r.spells.costTrack : ['mana', 'mp'].find((x) => trackIds.includes(x)) ?? null;

  const strList = (v, dflt, max = 30) => (Array.isArray(v) ? [...new Set(v.filter(safeId))].slice(0, max) : dflt);
  const inlineLibrary = { race: [], class: [], background: [] };
  const lib = (key) => {
    if (!Array.isArray(r[key])) return [];
    const kind = key === 'races' ? 'race' : key === 'classes' ? 'class' : 'background';
    const ids = [];
    r[key].forEach((x, i) => {
      if (typeof x === 'string' && safeId(x)) ids.push(x);
      else if (isObj(x)) {
        const e = normalizeLibEntry(kind, x, { warnings, where: `ruleset.json ${key}[${i}]`, source: 'pack' });
        if (e) {
          ids.push(e.id);
          inlineLibrary[kind].push(e);
        }
      }
    });
    return [...new Set(ids)];
  };

  const out = {
    id: safeId(r.id) ? r.id : 'default',
    dice: isStr(r.dice) && !validateFormula(r.dice, { dice: true }) ? r.dice.trim() : 'd20',
    stats,
    statMod,
    derived,
    fields,
    tracks,
    slots,
    buffSlots,
    hotlist,
    skills,
    attack,
    spells: { costTrack },
    identity: strList(r.identity, ['name', 'race', 'class', 'level', 'floor', 'pronouns']),
    storyFields: strList(r.storyFields, ['notes']),
    races: lib('races'),
    classes: lib('classes'),
    backgrounds: lib('backgrounds'),
    unverified: unv,
  };
  Object.defineProperty(out, 'inlineLibrary', { value: inlineLibrary, enumerable: false });
  return out;
}

/** Replaces `{stat}` / `{dice}` placeholders; `mod.{stat}` with no stat becomes 0. */
export function tmpl(src, stat, dice) {
  let s = String(src);
  if (!stat) s = s.replace(/[A-Za-z_][A-Za-z0-9_]*\.\{stat\}/g, '0');
  return s.replace(/\{stat\}/g, stat || '0').replace(/\{dice\}/g, dice ? `(${dice})` : '0');
}

// ---------- library ----------

/**
 * Merged library view over pack entries (`pack.library` + `pack.items`) and homebrew (`state.library`).
 * Homebrew shadows pack entries with the same id.
 */
export function makeLibrary(pack, homebrew = {}, art = {}) {
  const maps = {};
  for (const k of LIB_KINDS) {
    const m = new Map();
    const packList = k === 'item' ? pack?.items ?? [] : pack?.library?.[k] ?? [];
    const picks = art && typeof art === 'object' && art[k] && typeof art[k] === 'object' ? art[k] : null;
    for (const e of packList) {
      let x = e.source ? e : { ...e, source: 'pack' };
      const pick = picks && Object.hasOwn(picks, e.id) ? picks[e.id] : null;
      // GM art pick for a pack entry: replaces its image everywhere (a boss's square crop too)
      if (pick) x = { ...x, image: pick, ...(k === 'boss' ? { imageSquare: pick } : {}), artPick: true, packImage: e.image ?? null };
      m.set(e.id, x);
    }
    for (const e of Array.isArray(homebrew?.[k]) ? homebrew[k] : []) m.set(e.id, e);
    maps[k] = m;
  }
  return {
    get: (kind, id) => (Object.hasOwn(maps, kind) && typeof id === 'string' ? maps[kind].get(id) ?? null : null),
    list: (kind) => (Object.hasOwn(maps, kind) ? [...maps[kind].values()] : []),
    kinds: LIB_KINDS,
  };
}

/** Finds a race/class/background by id or (case-insensitive) name. */
function findByIdOrName(library, kind, v) {
  if (!isStr(v)) return null;
  const byId = library.get(kind, v.trim());
  if (byId) return byId;
  const n = v.trim().toLowerCase();
  return library.list(kind).find((e) => e.name.toLowerCase() === n) ?? null;
}

// ---------- computed sheet ----------

const BUFF_PREFIX = 'buff.';

function targetKey(t) {
  return t.startsWith(BUFF_PREFIX) ? t.slice(BUFF_PREFIX.length) : t;
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

/**
 * Collects every effect that currently applies to the character.
 * Returns [{ target, op, value(raw), label, source: {kind, uid?, id?, name} }].
 */
export function collectEffects(ch, library, warnings) {
  const out = [];
  const hot = new Set((ch.hotlist ?? []).filter(Boolean));
  const add = (effects, src, applies) => {
    for (const e of effects ?? []) if (applies(e)) out.push({ ...e, label: e.label || src.name, source: src });
  };
  for (const inv of ch.inventory ?? []) {
    const def = library.get('item', inv.itemId);
    if (!def) {
      if (inv.itemId) warnings.push({ kind: 'missing', ref: `item:${inv.itemId}`, msg: `item "${inv.name ?? inv.itemId}" is not in the library` });
      continue;
    }
    const equipped = !!inv.equippedSlot || hot.has(inv.uid);
    add(def.effects, { kind: 'item', uid: inv.uid, id: def.id, name: def.name }, (e) => (e.when === 'equipped' || e.when === 'active' ? equipped : true));
  }
  for (const b of ch.buffs ?? []) {
    add(b.effects, { kind: 'buff', uid: b.uid, id: b.buffId ?? null, name: b.name || 'Buff', external: !!b.external }, () => true);
  }
  for (const sp of ch.spells ?? []) {
    const def = library.get('spell', sp.spellId);
    if (!def) {
      warnings.push({ kind: 'missing', ref: `spell:${sp.spellId}`, msg: `spell "${sp.spellId}" is not in the library` });
      continue;
    }
    add(def.effects, { kind: 'spell', uid: sp.uid, id: def.id, name: def.name }, (e) => (e.when === 'always' ? true : !!sp.active));
  }
  const id = ch.identity ?? {};
  for (const kind of ['race', 'class', 'background']) {
    const def = findByIdOrName(library, kind, id[kind]);
    if (!def) continue;
    add(def.statBonuses, { kind, id: def.id, name: def.name }, (e) => e.when !== 'active');
    for (const fid of def.features ?? []) {
      const f = library.get('feature', fid);
      if (!f) {
        warnings.push({ kind: 'missing', ref: `feature:${fid}`, msg: `feature "${fid}" (${def.name}) is not in the library` });
        continue;
      }
      add(f.effects, { kind: 'feature', id: f.id, name: f.name, via: def.name }, (e) => e.when !== 'active');
    }
  }
  return out;
}

/**
 * computeSheet(character, ruleset, library) → computed (docs/RULESET.md §5).
 * character = raw sheet incl. { level, identity, stats, fields, tracks, skills, attacks, spells, inventory, hotlist, buffs }.
 * Every number is a breakdown { value, parts: [{label, value, source, parts?}], warnings }.
 */
export function computeSheet(ch, ruleset, library) {
  const warnings = [];
  const stats = {};
  const statById = new Map(ruleset.stats.map((s) => [s.id, s]));
  const fieldById = new Map(ruleset.fields.map((f) => [f.id, f]));
  const trackById = new Map(ruleset.tracks.map((t) => [t.id, t]));
  const skillsRaw = Array.isArray(ch.skills) ? ch.skills : [];
  const skillKey = new Map();
  for (const s of skillsRaw) {
    skillKey.set(s.uid, s);
    if (s.skillId && !skillKey.has(s.skillId)) skillKey.set(s.skillId, s);
  }
  const level = finite(ch.level, 1);
  const statBase = (id, part) => {
    const def = statById.get(id);
    if (!def) return undefined;
    const raw = isObj(ch.stats) && Object.hasOwn(ch.stats, id) ? ch.stats[id] : def.default;
    const p = part ?? (def.parts.includes(ruleset.statMod.from) ? ruleset.statMod.from : def.parts[0]);
    if (!def.parts.includes(p)) return undefined;
    if (typeof raw === 'number') return raw;
    return finite(isObj(raw) && Object.hasOwn(raw, p) ? raw[p] : def.default[p], 0);
  };
  const fieldBase = (id) => {
    const f = fieldById.get(id);
    if (!f || f.type !== 'number') return undefined;
    const v = isObj(ch.fields) && Object.hasOwn(ch.fields, id) ? ch.fields[id] : f.default;
    return finite(typeof v === 'string' ? Number(v) : v, 0);
  };

  // Base resolver for effect value formulas (no effects → no cycles).
  const baseResolve = (name) => {
    if (name === 'level') return level;
    const seg = name.split('.');
    if (seg[0] === 'stat' && (seg.length === 2 || seg.length === 3)) return statBase(seg[1], seg[2]);
    if (seg[0] === 'field' && seg.length === 2) return fieldBase(seg[1]);
    if (seg[0] === 'skill' && seg.length === 3 && seg[2] === 'rank') return skillKey.get(seg[1])?.rank;
    return undefined;
  };

  // 1. effects
  const effects = collectEffects(ch, library, warnings).map((e) => {
    const r = evaluate(e.value, baseResolve);
    for (const w of r.warnings) warnings.push({ ...w, effect: e.label });
    return { ...e, formula: typeof e.value === 'string' ? e.value : undefined, value: r.value, key: targetKey(e.target) };
  });
  const byKey = new Map();
  for (const e of effects) {
    if (!byKey.has(e.key)) byKey.set(e.key, []);
    byKey.get(e.key).push(e);
  }
  const effPart = (e) => ({ label: e.label, value: e.value, source: `${e.source.kind}:${e.source.uid ?? e.source.id}`, ...(e.op === 'set' ? { op: 'set' } : {}) });

  /** Applies effects of `key` on top of a base breakdown. */
  const apply = (key, base) => {
    const list = byKey.get(key) ?? [];
    let parts = [...base.parts];
    let value = base.value;
    for (const e of list.filter((x) => x.op === 'add')) {
      parts.push(effPart(e));
      value += e.value;
    }
    const sets = list.filter((x) => x.op === 'set');
    if (sets.length) {
      const last = sets[sets.length - 1];
      parts = [{ ...effPart(last), label: `${last.label} (set)` }];
      value = last.value;
    }
    return { value: round6(value), parts, warnings: [...(base.warnings ?? [])] };
  };

  const statModUnv = ruleset.unverified.filter((u) => u.path === 'statMod');
  // 2. stats + modifiers
  for (const def of ruleset.stats) {
    const base = statBase(def.id);
    const val = apply(`stat.${def.id}`, { value: base, parts: [{ label: def.abbr, value: base, source: `stat.${def.id}` }] });
    const m = evaluate(ruleset.statMod.formula, (n) => (n === 'x' ? val.value : baseResolve(n)));
    const mod = apply(`mod.${def.id}`, { value: m.value, parts: [{ label: `${def.abbr} mod`, value: m.value, source: 'statMod' }], warnings: [...m.warnings, ...statModUnv] });
    const raw = isObj(ch.stats?.[def.id]) ? ch.stats[def.id] : statDefault(typeof ch.stats?.[def.id] === 'number' ? ch.stats[def.id] : def.default, def.parts);
    stats[def.id] = { value: val.value, parts: val.parts, raw, mod };
  }

  // 3. numeric fields
  const fields = {};
  for (const f of ruleset.fields) {
    if (f.type !== 'number') continue;
    const b = fieldBase(f.id);
    fields[f.id] = apply(`field.${f.id}`, { value: b, parts: [{ label: f.label, value: b, source: `field.${f.id}` }] });
  }

  // 4. buff pools (any key that is not a qualified target)
  const QUALIFIED = /^(stat|mod|skill|track|field|derived)\./;
  const buffs = {};
  for (const [key, list] of byKey) {
    if (QUALIFIED.test(key)) continue;
    buffs[key] = apply(key, { value: 0, parts: [] });
    if (!list.length) delete buffs[key];
  }
  const buffOf = (key) => buffs[key] ?? { value: 0, parts: [] };

  // 5. full resolver (stats/mods/fields/buffs/skills/tracks/derived so far)
  const derived = {};
  const tracks = {};
  const resolveFull = (name, extra) => {
    if (extra && Object.hasOwn(extra, name)) return extra[name];
    if (name === 'level') return { value: level, label: 'Level' };
    const seg = name.split('.');
    const [head, a, b] = seg;
    if (head === 'stat' && (seg.length === 2 || seg.length === 3)) {
      const def = statById.get(a);
      if (!def) return undefined;
      if (seg.length === 3) {
        const v = statBase(a, b);
        return v === undefined ? undefined : { value: v, label: `${def.abbr} (${b})` };
      }
      return { value: stats[a].value, label: def.abbr };
    }
    if (head === 'mod' && seg.length === 2 && stats[a]) return { value: stats[a].mod.value, label: `${statById.get(a).abbr} mod`, parts: stats[a].mod.parts.length > 1 ? stats[a].mod.parts : undefined };
    if (head === 'field' && seg.length === 2 && fields[a]) return { value: fields[a].value, label: fieldById.get(a).label, parts: fields[a].parts.length > 1 ? fields[a].parts : undefined };
    if (head === 'buff' && seg.length >= 2) {
      const bb = buffOf(seg.slice(1).join('.'));
      return { value: bb.value, label: 'Buffs', parts: bb.parts };
    }
    if (head === 'skill' && seg.length === 3 && b === 'rank') {
      const s = skillKey.get(a);
      return s ? { value: finite(s.rank, 0), label: `${s.name} rank` } : undefined;
    }
    if (head === 'track' && seg.length === 3 && tracks[a] && (b === 'max' || b === 'cur')) {
      return { value: tracks[a][b], label: `${trackById.get(a).label} ${b}` };
    }
    if (head === 'derived' && seg.length === 2 && derived[a]) return { value: derived[a].value, label: ruleset.derived.find((d) => d.id === a).label };
    return undefined;
  };

  // 6. tracks
  for (const t of ruleset.tracks) {
    const raw = isObj(ch.tracks?.[t.id]) ? ch.tracks[t.id] : { cur: t.default, max: t.default };
    let base;
    if (t.maxFormula) {
      const r = evaluate(t.maxFormula, (n) => resolveFull(n));
      base = { value: r.value, parts: r.parts, warnings: r.warnings };
    } else {
      const m = t.kind === 'slots' ? t.slots : finite(raw.max, t.default);
      base = { value: m, parts: [{ label: 'Max', value: m, source: `track.${t.id}` }] };
    }
    const max = apply(`track.${t.id}.max`, base);
    max.value = Math.max(0, max.value);
    const cur = Math.max(0, Math.min(max.value, finite(raw.cur, 0)));
    tracks[t.id] = { cur, max: max.value, maxBreakdown: max };
  }

  // 7. derived (in order; may reference earlier derived.<id>)
  for (const d of ruleset.derived) {
    const r = evaluate(d.formula, (n) => resolveFull(n));
    const unv = ruleset.unverified.filter((u) => u.path === `derived.${d.id}`);
    let bd = apply(`derived.${d.id}`, { value: r.value, parts: r.parts.filter((p) => !(p.source?.startsWith('buff.') && p.value === 0 && !p.parts?.length)), warnings: [...r.warnings, ...unv] });
    // A `set` on the bare id (e.g. {target:"dr", op:"set"}) overrides the derived value.
    const sets = (byKey.get(d.id) ?? []).filter((e) => e.op === 'set');
    if (sets.length) {
      const last = sets[sets.length - 1];
      bd = { value: last.value, parts: [{ ...effPart(last), label: `${last.label} (set)` }], warnings: bd.warnings };
    }
    bd.display = d.display.replace(/\{value\}/g, String(bd.value));
    derived[d.id] = bd;
  }

  // 8. skills
  const checkUnv = ruleset.unverified.filter((u) => u.path === 'skills.check');
  const skills = skillsRaw.map((s) => {
    const rank = finite(s.rank, 0);
    const stat = s.stat && statById.has(s.stat) ? s.stat : '';
    const extra = { 'skill.rank': { value: rank, label: 'Rank' } };
    const r = evaluate(tmpl(ruleset.skills.check.formula, stat, ''), (n) => resolveFull(n, extra));
    const keys = [`skill.${s.uid}`, ...(s.skillId ? [`skill.${s.skillId}`] : [])];
    let total = { value: r.value, parts: r.parts.filter((p) => !(p.source?.startsWith('buff.') && p.value === 0 && !p.parts?.length)) };
    for (const k of keys) total = apply(k, total);
    return { uid: s.uid, total: { value: round6(total.value), parts: total.parts, warnings: [...r.warnings, ...checkUnv] } };
  });

  // 9. attacks
  const attacks = (Array.isArray(ch.attacks) ? ch.attacks : []).map((k) => {
    const sk = k.skillUid ? skillKey.get(k.skillUid) : null;
    const extra = { 'skill.rank': { value: sk ? finite(sk.rank, 0) : 0, label: sk ? `${sk.name} rank` : 'Skill rank' } };
    const stat = k.stat && statById.has(k.stat) ? k.stat : '';
    const zeroBuff = (p) => !(p.source?.startsWith('buff.') && p.value === 0 && !p.parts?.length);
    const th = evaluate(tmpl(ruleset.attack.toHit, stat, ''), (n) => resolveFull(n, extra));
    const dmg = diceText(tmpl(ruleset.attack.damage, stat, k.dice || ''), (n) => resolveFull(n, extra));
    return { uid: k.uid, toHit: { value: th.value, parts: th.parts.filter(zeroBuff), warnings: th.warnings }, damage: dmg.text, damageParts: dmg.parts.filter(zeroBuff) };
  });

  // 10. spells: current cost
  const spells = (Array.isArray(ch.spells) ? ch.spells : []).map((sp) => {
    const def = library.get('spell', sp.spellId);
    const extra = { rank: { value: finite(sp.rank, 1), label: 'Spell rank' } };
    const cost = def ? evaluate(def.cost, (n) => resolveFull(n, extra)) : { value: 0, parts: [], warnings: [] };
    return { uid: sp.uid, cost: { value: Math.max(0, cost.value), parts: cost.parts, warnings: cost.warnings }, costTrack: def?.costTrack ?? ruleset.spells.costTrack, active: !!sp.active };
  });

  const external = (ch.buffs ?? []).filter((b) => b.external).length;
  const all = [...warnings, ...ruleset.unverified];
  for (const bd of [...Object.values(derived), ...Object.values(stats).map((s) => s.mod), ...attacks.map((a) => a.toHit), ...spells.map((s) => s.cost)]) {
    for (const w of bd.warnings ?? []) if (w.kind !== 'unverified') all.push(w);
  }
  const seen = new Set();
  const uniq = all.filter((w) => {
    const k = JSON.stringify(w);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    stats,
    derived,
    fields,
    buffs,
    tracks,
    skills,
    attacks,
    spells,
    effects: effects.map((e) => ({
      target: e.target, op: e.op, value: e.value, ...(e.formula ? { formula: e.formula } : {}), label: e.label, source: e.source,
      debuff: e.op === 'add' && e.value < 0,
    })),
    externalBuffs: { used: external, max: ruleset.buffSlots.external.max },
    warnings: uniq,
  };
}

/**
 * Formula resolver over a computed sheet (for rolls / spell costs / rank-up targets).
 * extra = { name: number | {value,label} } (e.g. { rank: 3 }).
 */
export function sheetResolver(computed, ch, ruleset, extra = {}) {
  const statById = new Map(ruleset.stats.map((s) => [s.id, s]));
  const skillKey = new Map();
  for (const s of ch.skills ?? []) {
    skillKey.set(s.uid, s);
    if (s.skillId && !skillKey.has(s.skillId)) skillKey.set(s.skillId, s);
  }
  return (name) => {
    if (Object.hasOwn(extra, name)) return extra[name];
    if (!computed) return undefined;
    if (name === 'level') return { value: finite(ch.level, 1), label: 'Level' };
    const seg = name.split('.');
    const [head, a, b] = seg;
    if (head === 'stat' && seg.length === 2 && Object.hasOwn(computed.stats, a)) return { value: computed.stats[a].value, label: statById.get(a).abbr };
    if (head === 'stat' && seg.length === 3 && Object.hasOwn(computed.stats, a) && isObj(computed.stats[a].raw) && Object.hasOwn(computed.stats[a].raw, b)) {
      return { value: finite(computed.stats[a].raw[b], 0), label: `${statById.get(a).abbr} (${b})` };
    }
    if (head === 'mod' && seg.length === 2 && Object.hasOwn(computed.stats, a)) return { value: computed.stats[a].mod.value, label: `${statById.get(a).abbr} mod` };
    if (head === 'field' && seg.length === 2 && Object.hasOwn(computed.fields, a)) return { value: computed.fields[a].value, label: ruleset.fields.find((f) => f.id === a).label };
    if (head === 'buff' && seg.length >= 2) {
      const k = seg.slice(1).join('.');
      return { value: Object.hasOwn(computed.buffs, k) ? computed.buffs[k].value : 0, label: 'Buffs', parts: Object.hasOwn(computed.buffs, k) ? computed.buffs[k].parts : undefined };
    }
    if (head === 'skill' && seg.length === 3 && b === 'rank' && skillKey.has(a)) return { value: finite(skillKey.get(a).rank, 0), label: `${skillKey.get(a).name} rank` };
    if (head === 'track' && seg.length === 3 && Object.hasOwn(computed.tracks, a) && (b === 'cur' || b === 'max')) return { value: computed.tracks[a][b], label: `${ruleset.tracks.find((t) => t.id === a).label} ${b}` };
    if (head === 'derived' && seg.length === 2 && Object.hasOwn(computed.derived, a)) return { value: computed.derived[a].value, label: ruleset.derived.find((d) => d.id === a).label, parts: computed.derived[a].parts };
    return undefined;
  };
}
