// Game systems: built-in rulesets + conversion of content between them (browser-safe).
//
// Content (monsters, bosses, items, buffs, spells) is written once, in the number scale of the pack's own
// ruleset (its "native" system). A campaign picks a ruleset when it is created; packForRuleset() builds the
// pack the engine runs with: that ruleset, its skills and conditions, and every piece of content converted
// to its numbers (AC, HP, to-hit, damage, DCs, gear slots, effect targets). Names, art, sounds, text, phases
// and loot stay the same: a goblin is the same goblin in every game, it just hits like a 5e or a PF2e one.
//
//   BUILTIN_RULESETS                 id -> raw ruleset object (files in server/rulesets/)
//   rulesetChoices(pack)             [{ id, label, short, family, native }] the GM can pick for a campaign
//   packForRuleset(pack, id)         effective pack (cached); the pack itself for its own ruleset or an unknown id
//   tierOf(entry, kind, family)      { level, role, hpRel, ... } the converter's neutral description
//   convertMonster / convertItem / convertEffects / convertText   (exported for tests and the GM editor)
//
// Numbers produced here are approximations meant to feel right at the table (see docs/RULESETS.md, "Content
// conversion"). Every converted entry carries `converted: { from, to, level, role }` and the GM can override
// any stat in the combat tracker or by duplicating the entry as homebrew.
import { normalizeRuleset, normalizeLibEntry, LIB_KINDS } from './ruleset.js';
import dnd5e from './rulesets/dnd5e.js';
import dnd2024 from './rulesets/dnd2024.js';
import pf2e from './rulesets/pf2e.js';
import { SRD5_MONSTERS } from './srd5-monsters.js';

export const BUILTIN_RULESETS = Object.freeze({ dnd5e, dnd2024, pf2e });
export const BUILTIN_IDS = Object.keys(BUILTIN_RULESETS);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Family of a normalized ruleset ('crawler' | 'dnd' | 'pf2e' | 'generic'). */
export const familyOf = (ruleset) => ruleset?.system?.family ?? 'crawler';

/** Rulesets a GM may pick for a new campaign: the pack's own first, then the built-ins it allows. */
export function rulesetChoices(pack) {
  const own = pack.ruleset;
  const allowed = Array.isArray(pack.rulesetChoices) ? pack.rulesetChoices.filter((id) => BUILTIN_IDS.includes(id)) : BUILTIN_IDS;
  const out = [{ id: own.id, label: own.system?.label ?? own.id, short: own.system?.short ?? own.id, family: familyOf(own), native: true }];
  for (const id of allowed) {
    if (id === own.id) continue;
    const r = BUILTIN_RULESETS[id];
    out.push({ id, label: r.system.label, short: r.system.short, family: r.system.family, native: false });
  }
  return out;
}

// ---------- the neutral tier ----------

const ROLE_BASE_SLOTS = { minion: 2, standard: 5, elite: 10, boss: 20 };

/** Average of a dice expression like "2d6+3" (0 for "", "0" or anything odd). */
export function diceAvg(src) {
  const s = String(src ?? '').replace(/\s+/g, '');
  if (!s || /^[-+]?0+$/.test(s)) return 0;
  let total = 0;
  let ok = false;
  for (const m of s.matchAll(/([+-]?)(\d*)d(\d+)|([+-]?)(\d+)(?!d|\d)/gi)) {
    if (m[3]) {
      const n = Number(m[2] || 1);
      total += (m[1] === '-' ? -1 : 1) * n * (Number(m[3]) + 1) / 2;
      ok = true;
    } else if (m[5]) {
      total += (m[4] === '-' ? -1 : 1) * Number(m[5]);
      ok = true;
    }
  }
  return ok ? Math.max(0, total) : 0;
}

/** Biggest die in a dice expression ("1d6+1" -> 6), or the default. */
function dieOf(src, dflt = 6) {
  const ds = [...String(src ?? '').matchAll(/d(\d+)/gi)].map((m) => Number(m[1])).filter((n) => [4, 6, 8, 10, 12].includes(n));
  return ds.length ? Math.max(...ds) : dflt;
}

function floorLevel(floor) {
  const n = Number.parseInt(String(floor ?? '').replace(/[^0-9]/g, ''), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return clamp(2 * n - 1, 1, 20);
}

/**
 * Neutral description of a monster/boss stat block:
 *   level   party level it is built for (1..20)
 *   role    minion | standard | elite | boss
 *   hpRel   toughness against the role's usual (1 = typical)
 *   defRel  how much harder to hit than usual (in "steps", ~0)
 *   attacks [{ share (damage vs its best attack, 0..1), off (to-hit vs its best attack) }]
 *   dcOff   save difficulty offset from usual (steps)
 */
export function tierOf(e, kind, family = 'crawler') {
  const level = Number.isInteger(e.level) && e.level >= 1 ? clamp(e.level, 1, 20) : floorLevel(e.floor);
  const atk = Array.isArray(e.attacks) ? e.attacks : [];
  const avgs = atk.map((a) => diceAvg(a.damage));
  const best = Math.max(0, ...avgs);
  const bestHit = Math.max(-99, ...atk.map((a) => a.toHit || 0));
  const attacks = atk.map((a, i) => ({ share: best > 0 ? avgs[i] / best : 0, off: atk.length ? clamp((a.toHit || 0) - bestHit, -4, 0) : 0 }));
  if (family === 'crawler') {
    const slots = Number.isInteger(e.hpSlots) ? e.hpSlots : 5;
    const role = kind === 'boss' ? 'boss' : slots <= 2 ? 'minion' : slots >= 9 ? 'elite' : 'standard';
    return {
      level,
      role,
      hpRel: clamp((slots / ROLE_BASE_SLOTS[role]) * (1 + 0.08 * Math.max(0, e.dr || 0)), 0.3, 4),
      defRel: clamp(((e.evade || 0) - 1) / 2, -2, 3),
      attacks,
      dcOff: 0,
    };
  }
  // Content written for another system: keep it as it is (homebrew lives in its own campaign).
  return { level, role: kind === 'boss' ? 'boss' : 'standard', hpRel: 1, defRel: 0, attacks, dcOff: 0 };
}

// ---------- per-system numbers from a tier ----------

const ROLE = {
  dnd: { hp: { minion: 0.4, standard: 1, elite: 2, boss: 3.5 }, dmg: { minion: 0.7, standard: 1, elite: 1.3, boss: 1.6 }, ac: { minion: -1, standard: 0, elite: 1, boss: 2 }, hit: { minion: 0, standard: 0, elite: 1, boss: 2 } },
  pf2e: { lvl: { minion: -2, standard: -1, elite: 0, boss: 2 }, hp: { minion: 0.6, standard: 1, elite: 1.2, boss: 1.25 }, dmg: { minion: 0.8, standard: 1, elite: 1.1, boss: 1.2 } },
};

/** Stat numbers for a tier in a family. */
export function numbersFor(tier, family) {
  const L = tier.level;
  const role = tier.role;
  if (family === 'dnd') {
    const r = ROLE.dnd;
    return {
      level: L,
      ac: clamp(12 + Math.floor((L + 1) / 3) + r.ac[role] + Math.round(tier.defRel), 8, 25),
      hp: Math.max(1, Math.round(10 * L * r.hp[role] * tier.hpRel)),
      toHit: 3 + Math.ceil(L / 3) + r.hit[role],
      dmg: (4.5 + 2 * (L - 1)) * r.dmg[role],
      dc: 10 + Math.ceil(L / 3) + (role === 'boss' ? 1 : 0) + Math.round(tier.dcOff),
      init: 1 + Math.floor(L / 4) + (role === 'boss' ? 1 : 0),
    };
  }
  if (family === 'pf2e') {
    const r = ROLE.pf2e;
    const CL = clamp(L + r.lvl[role], -1, 24);
    const baseHp = CL <= 0 ? 8 + 7 * (CL + 1) : 15 * CL + 5;
    return {
      level: CL,
      ac: 15 + Math.floor(1.4 * CL) + Math.round(tier.defRel),
      hp: Math.max(1, Math.round(baseHp * r.hp[role] * tier.hpRel)),
      toHit: 8 + Math.floor(1.5 * CL),
      dmg: Math.max(3, (6 + 1.6 * CL) * r.dmg[role]),
      dc: 15 + Math.floor(1.4 * CL) + Math.round(tier.dcOff),
      init: 6 + CL,
    };
  }
  return null;
}

/** Dice expression with average ≈ avg, using the given die ("1d8+3"). */
export function diceFor(avg, die = 6) {
  if (!(avg > 0.5)) return '0';
  const per = (die + 1) / 2;
  let n = Math.max(1, Math.round((avg * 0.6) / per));
  let bonus = Math.round(avg - n * per);
  while (bonus < 0 && n > 1) {
    n -= 1;
    bonus = Math.round(avg - n * per);
  }
  return `${n}d${die}${bonus > 0 ? `+${bonus}` : bonus < 0 ? `${bonus}` : ''}`;
}

// ---------- text ----------

const STAT_TO_PF2E_SAVE = { str: 'Fortitude', con: 'Fortitude', dex: 'Reflex', int: 'Will', wis: 'Will', cha: 'Will' };

/**
 * Rewrites rules text written in the crawler scale: "rolls DEX (difficulty 12)" -> "makes a DEX save (DC 11)"
 * (5e) / "attempts a Reflex save (DC 16)" (PF2e); "6 squares" -> "30 ft"; "Evade" -> "AC".
 */
export function convertText(src, family, nums, defenseLabel = 'AC') {
  if (typeof src !== 'string' || !src || family === 'crawler' || !nums) return src;
  const dc = (n) => {
    const off = Math.round((Number(n) - 12) / 2);
    return nums.dc + off;
  };
  let s = src.replace(/\b(?:rolls?|makes?|attempts?)\s+(?:a\s+)?(STR|DEX|CON|INT|WIS|CHA)\s*\(\s*difficulty\s*(\d+)\s*\)/gi, (m, stat, n) => {
    const id = stat.toLowerCase();
    if (family === 'pf2e') return `attempts a ${STAT_TO_PF2E_SAVE[id] ?? 'Will'} save (DC ${dc(n)})`;
    return `makes a ${stat.toUpperCase()} save (DC ${dc(n)})`;
  });
  s = s.replace(/\(\s*difficulty\s*(\d+)\s*\)/gi, (m, n) => `(DC ${dc(n)})`);
  s = s.replace(/\bdifficulty\s+(\d+)\b/gi, (m, n) => `DC ${dc(n)}`);
  s = s.replace(/\b(\d+)\s+squares?\b/gi, (m, n) => `${Number(n) * 5} ft`);
  s = s.replace(/\bEvade\b/g, defenseLabel);
  return s;
}

// ---------- monsters / bosses ----------

/** Converts a monster or boss entry into `ruleset`'s numbers (entry stays untouched). */
export function convertMonster(e, kind, fromFamily, ruleset) {
  const to = familyOf(ruleset);
  if (to === fromFamily || (to !== 'dnd' && to !== 'pf2e')) return e;
  const tier = tierOf(e, kind, fromFamily);
  const n = numbersFor(tier, to);
  const label = ruleset.combat?.defenseLabel || 'AC';
  const oldHp = Number.isInteger(e.hpSlots) && e.hpSlots > 0 ? e.hpSlots : 5;
  const attacks = (e.attacks ?? []).map((a, i) => {
    const t = tier.attacks[i] ?? { share: 1, off: 0 };
    const avg = diceAvg(a.damage);
    const damage = avg > 0 ? diceFor(n.dmg * Math.max(0.35, t.share), dieOf(a.damage)) : '0';
    return { ...a, toHit: a.toHit === 0 && avg === 0 ? 0 : clamp(n.toHit + t.off, -10, 40), damage, effects: convertText(a.effects, to, n, label) };
  });
  const out = {
    ...e,
    hpSlots: clamp(n.hp, 1, 999),
    evade: n.ac,
    dr: 0,
    attacks,
    initiative: n.init,
    level: n.level,
    flavor: e.flavor,
    tactics: convertText(e.tactics, to, n, label),
    notes: convertText(e.notes, to, n, label),
    converted: { from: fromFamily, to, level: n.level, role: tier.role, dc: n.dc },
  };
  if (kind === 'boss' && Array.isArray(e.phases)) {
    out.phases = e.phases.map((p) => ({
      ...p,
      atHp: Number.isInteger(p.atHp) ? clamp(Math.round((p.atHp / oldHp) * out.hpSlots), 0, out.hpSlots) : p.atHp,
      text: convertText(p.text, to, n, label),
    }));
  }
  return out;
}

// ---------- items, buffs, spells (effects) ----------

const SKILL_ALIAS = {
  dnd: {
    sneak: 'stealth', climb: 'athletics', lockpicking: 'sleight_of_hand', forced_entry: 'athletics', first_aid: 'medicine',
    bartering: 'persuasion', tracking: 'survival', scavenging: 'investigation', trap_handling: 'investigation', crafting: 'investigation',
    jury_rigging: 'investigation', cooking: 'survival', swimming: 'athletics', navigation: 'survival', channeling: 'arcana',
    demolitions: 'investigation', carousing: 'performance', endurance: 'athletics',
  },
  pf2e: {
    sneak: 'stealth', climb: 'athletics', lockpicking: 'thievery', forced_entry: 'athletics', first_aid: 'medicine',
    bartering: 'diplomacy', persuasion: 'diplomacy', tracking: 'survival', scavenging: 'survival', trap_handling: 'thievery',
    jury_rigging: 'crafting', cooking: 'crafting', swimming: 'athletics', navigation: 'survival', animal_handling: 'nature',
    channeling: 'arcana', demolitions: 'crafting', sleight_of_hand: 'thievery', carousing: 'performance', endurance: 'athletics',
  },
};
const SLOT_ALIAS = { torso: 'body', chest: 'body', armor: 'body', arms: 'gloves', legs: 'belt', accessories: 'trinkets', ring: 'rings', neck: 'neck' };

const halfUp = (v) => (typeof v === 'number' ? Math.sign(v) * Math.ceil(Math.abs(v) / 2) : `ceil((${v}) / 2)`);
const times = (v, k) => (typeof v === 'number' ? v * k : `(${v}) * ${k}`);

/** Maps one effect target to `ruleset`; returns null to drop it. */
function convertEffect(fx, fromFamily, ruleset) {
  const to = familyOf(ruleset);
  if (to === fromFamily || (to !== 'dnd' && to !== 'pf2e')) return fx;
  const t = fx.target.startsWith('buff.') ? fx.target.slice(5) : fx.target;
  const statIds = new Set(ruleset.stats.map((s) => s.id));
  const skillIds = new Set(ruleset.skills.catalog.map((s) => s.id));
  const tracks = new Set(ruleset.tracks.map((x) => x.id));
  const set = fx.op === 'set';
  if (t === 'evade' || t === 'armor' || t === 'dr') return set ? null : { ...fx, target: 'ac', value: halfUp(fx.value) };
  if (t === 'move') return { ...fx, target: 'speed', value: set ? times(fx.value, 5) : times(fx.value, 5) };
  if (t === 'step') return null;
  const seg = t.split('.');
  if (seg[0] === 'track') {
    if (!tracks.has(seg[1])) return null;
    if (seg[1] === 'hp' && seg[2] === 'max' && fromFamily === 'crawler') return set ? null : { ...fx, value: typeof fx.value === 'number' ? `${fx.value} * (level + 1)` : `(${fx.value}) * (level + 1)` };
    return fx;
  }
  if (seg[0] === 'stat' || seg[0] === 'mod') {
    if (!statIds.has(seg[1])) return null;
    // PF2e has modifiers only: a +2 to a score is +1 to the modifier.
    if (to === 'pf2e' && seg[0] === 'stat') return set ? null : { ...fx, target: `mod.${seg[1]}`, value: halfUp(fx.value) };
    return fx;
  }
  if (seg[0] === 'skill') {
    let id = seg[1];
    if (!skillIds.has(id)) id = SKILL_ALIAS[to]?.[id] ?? null;
    if (to === 'pf2e' && (seg[1] === 'perception' || id === 'perception')) return { ...fx, target: 'perception' };
    if (!id || !skillIds.has(id)) return null;
    return { ...fx, target: `skill.${id}` };
  }
  return fx;
}

export function convertEffects(list, fromFamily, ruleset) {
  return (Array.isArray(list) ? list : []).map((fx) => convertEffect(fx, fromFamily, ruleset)).filter(Boolean);
}

function convertAttackDef(a, fromFamily, ruleset) {
  if (!a) return a;
  const to = familyOf(ruleset);
  if (to === fromFamily) return a;
  const skillIds = new Set(ruleset.skills.catalog.map((s) => s.id));
  const skill = a.skill ? (skillIds.has(a.skill) ? a.skill : SKILL_ALIAS[to]?.[a.skill] ?? null) : null;
  return { ...a, skill: skill && skillIds.has(skill) ? skill : null };
}

/** Converts an item. Gear slots map to the closest slot; effects map their targets. */
export function convertItem(it, fromFamily, ruleset) {
  const to = familyOf(ruleset);
  if (to === fromFamily || (to !== 'dnd' && to !== 'pf2e')) return it;
  const slots = new Set(ruleset.slots.map((s) => s.id));
  let slot = it.slot ?? null;
  if (slot && !slots.has(slot)) slot = SLOT_ALIAS[slot] && slots.has(SLOT_ALIAS[slot]) ? SLOT_ALIAS[slot] : null;
  let use = it.use ?? null;
  if (use?.heal && fromFamily === 'crawler') {
    const tracks = new Set(ruleset.tracks.map((x) => x.id));
    use = tracks.has(use.heal.track) ? { ...use, heal: { ...use.heal, amount: Math.sign(use.heal.amount) * Math.max(1, Math.round(Math.abs(use.heal.amount) * 2.5)) } } : { ...use, heal: null };
  }
  return { ...it, slot, effects: convertEffects(it.effects, fromFamily, ruleset), attack: convertAttackDef(it.attack, fromFamily, ruleset), use, converted: { from: fromFamily, to } };
}

function convertSpell(sp, fromFamily, ruleset) {
  const to = familyOf(ruleset);
  if (to === fromFamily || (to !== 'dnd' && to !== 'pf2e')) return sp;
  const tracks = new Set(ruleset.tracks.map((x) => x.id));
  const keepCost = sp.costTrack ? tracks.has(sp.costTrack) : !!ruleset.spells.costTrack;
  return { ...sp, cost: keepCost ? sp.cost : 0, costTrack: keepCost ? sp.costTrack : null, effects: convertEffects(sp.effects, fromFamily, ruleset), attack: convertAttackDef(sp.attack, fromFamily, ruleset), converted: { from: fromFamily, to } };
}

function convertBuff(b, fromFamily, ruleset) {
  const to = familyOf(ruleset);
  if (to === fromFamily || (to !== 'dnd' && to !== 'pf2e')) return b;
  return { ...b, effects: convertEffects(b.effects, fromFamily, ruleset), desc: convertText(b.desc, to, { dc: to === 'pf2e' ? 16 : 11 }, ruleset.combat?.defenseLabel), converted: { from: fromFamily, to } };
}

/** Converts any library entry of `kind` (used for homebrew from another system and by the GM editor). */
export function convertEntry(kind, e, fromFamily, ruleset) {
  if (!e || familyOf(ruleset) === fromFamily) return e;
  if (kind === 'monster' || kind === 'boss') return convertMonster(e, kind, fromFamily, ruleset);
  if (kind === 'item') return convertItem(e, fromFamily, ruleset);
  if (kind === 'spell') return convertSpell(e, fromFamily, ruleset);
  if (kind === 'buff') return convertBuff(e, fromFamily, ruleset);
  return e;
}

// ---------- the effective pack ----------

const cache = new WeakMap(); // pack -> Map(rulesetId -> pack)

function legacyFromRuleset(ruleset) {
  return {
    stats: ruleset.stats.map((s) => ({ id: s.id, label: s.label, abbr: s.abbr, default: s.default[ruleset.statMod.from] ?? s.default[s.parts[0]] ?? 0 })),
    resources: ruleset.tracks.map((t) => ({ id: t.id, label: t.label, color: t.color, default: t.kind === 'slots' ? t.slots : t.default })),
  };
}

/** Normalized built-in ruleset (with its inline library: conditions, races...). */
export function builtinRuleset(id) {
  const raw = BUILTIN_RULESETS[id];
  if (!raw) return null;
  const warnings = [];
  const r = normalizeRuleset(raw, {}, warnings);
  return r;
}

/**
 * The pack the engine runs a campaign with. Same object for the pack's own ruleset; otherwise a shallow copy
 * with the ruleset swapped and content converted. Cached per (pack, ruleset id).
 */
// 5e SRD monsters (R17): every D&D-family campaign gets them in its Library, normalized once.
let srdLib = null;
const srdMonsters = () => (srdLib ??= SRD5_MONSTERS.map((m) => normalizeLibEntry('monster', m, { source: 'srd' })).filter(Boolean));
/** Library monsters for a D&D-family campaign: SRD first, without the pack's own crawler conversions of them. */
function withSrdMonsters(list) {
  const own = (list ?? []).filter((e) => e.origin !== 'srd51_dcc');
  // The pack's crawler versions may bring art (same id): the 5e originals borrow it.
  const art = new Map((list ?? []).filter((e) => e.origin === 'srd51_dcc' && e.image).map((e) => [e.id, e]));
  const ids = new Set(own.map((e) => e.id));
  return [...srdMonsters().filter((e) => !ids.has(e.id)).map((e) => (art.has(e.id) ? { ...e, image: art.get(e.id).image, variants: art.get(e.id).variants ?? [] } : e)), ...own];
}
const srdCache = new WeakMap();

export function packForRuleset(pack, rulesetId) {
  if (pack && familyOf(pack.ruleset) === 'dnd' && (!rulesetId || rulesetId === pack.ruleset?.id)) {
    // The pack itself is D&D-family: same pack, plus the SRD monsters.
    let out = srdCache.get(pack);
    if (!out) {
      out = Object.create(Object.getPrototypeOf(pack));
      Object.assign(out, pack, { library: { ...pack.library, monster: withSrdMonsters(pack.library?.monster) } });
      srdCache.set(pack, out);
    }
    return out;
  }
  if (!pack || !rulesetId || rulesetId === pack.ruleset?.id || !Object.hasOwn(BUILTIN_RULESETS, rulesetId)) return pack;
  if (Array.isArray(pack.rulesetChoices) && !pack.rulesetChoices.includes(rulesetId)) return pack;
  let byId = cache.get(pack);
  if (!byId) cache.set(pack, (byId = new Map()));
  if (byId.has(rulesetId)) return byId.get(rulesetId);

  const fresh = builtinRuleset(rulesetId);
  const ruleset = JSON.parse(JSON.stringify(fresh));
  const inline = fresh.inlineLibrary ?? {};
  const from = familyOf(pack.ruleset);
  const lib = {};
  for (const k of LIB_KINDS) {
    if (k === 'item') continue;
    const packList = pack.library?.[k] ?? [];
    if (k === 'skill') lib[k] = [...ruleset.skills.catalog];
    else if (['race', 'class', 'background', 'feature'].includes(k)) lib[k] = [...(inline[k] ?? [])];
    else if (k === 'buff') {
      const own = new Map((inline.buff ?? []).map((b) => [b.id, b]));
      lib[k] = [...own.values(), ...packList.filter((b) => !own.has(b.id)).map((b) => convertEntry('buff', b, from, ruleset))];
    } else lib[k] = packList.map((e) => convertEntry(k, e, from, ruleset));
  }
  if (familyOf(ruleset) === 'dnd') lib.monster = withSrdMonsters(lib.monster);
  const items = (pack.items ?? []).map((it) => convertEntry('item', it, from, ruleset));
  const out = Object.create(Object.getPrototypeOf(pack));
  Object.assign(out, pack, legacyFromRuleset(ruleset), { ruleset, library: lib, items, baseRulesetId: pack.ruleset.id });
  out.itemsById = new Map(items.map((i) => [i.id, i]));
  out.statsById = new Map(out.stats.map((s) => [s.id, s]));
  out.resourcesById = new Map(out.resources.map((r) => [r.id, r]));
  out.tracksById = new Map(ruleset.tracks.map((t) => [t.id, t]));
  // Loot tables reference items by id; the converted items are found through itemsById.
  byId.set(rulesetId, out);
  return out;
}

/** Re-normalizes a raw entry for `kind` (helper for tests). */
export function entry(kind, raw) {
  return normalizeLibEntry(kind, raw, { source: 'pack' });
}

/** Licence / attribution lines for a ruleset (shown in Settings and the rules card). */
export function attributionOf(ruleset) {
  return ruleset?.system?.attribution || '';
}

export const isPlainObject = isObj;
