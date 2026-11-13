// Pure pack normalization + validation (browser-safe, no Node imports). See docs/CONTENT_PACKS.md.
// pack.js does the file reading; the hosted edition calls normalizePack/deserializePack directly.
import { normalizeChatLines } from './chat.js';
import { STANDARD_CATEGORIES } from './constants.js';
import { normalizeRuleset, normalizeLibEntry, LIB_KINDS } from './ruleset.js';
import { normalizeCrawlersConfig } from './crawlers.js';

export { STANDARD_CATEGORIES };

export class PackError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'PackError';
  }
}

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CATEGORY_RE = /^[a-z0-9_]{1,32}$/;
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

function need(cond, file, where, msg) {
  if (!cond) throw new PackError(`${file}${where ? ` ${where}` : ''}: ${msg}`);
}

const UNSAFE_PATH = /(^|[\\/])\.\.([\\/]|$)|^[\\/]|^[A-Za-z]:|\\|\0/;

export const MISSING_ASSET_SUFFIX = 'not found, using fallback';

// Pack-relative asset path → public URL, or null if missing/unsafe.
// io = { assetExists(sub, rel) → bool, baseUrl }
function assetUrl(io, sub, rel, warnings, label) {
  if (rel == null || rel === '') return null;
  if (typeof rel !== 'string' || UNSAFE_PATH.test(rel)) {
    warnings.push(`${label}: ignoring unsafe ${sub} path ${JSON.stringify(rel)}`);
    return null;
  }
  if (!io.assetExists(sub, rel)) {
    warnings.push(`${label}: ${sub}/${rel} ${MISSING_ASSET_SUFFIX}`);
    return null;
  }
  return `${io.baseUrl}${sub}/` + rel.split('/').map(encodeURIComponent).join('/');
}

const HOTKEY_RE = /^Shift\+(Digit[0-9]|Key[A-Z])$/;

/** sfx.json: [{ id, label, file, hotkey?, volume?, route?, sub?, group? }] — files under audio/sfx/. Adds/overrides GM desk pads. */
export function loadSfx(io, raw, warnings) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push('sfx.json must be an array, ignoring');
    return [];
  }
  const out = [];
  const seen = new Set();
  raw.slice(0, 64).forEach((e, i) => {
    if (!isObj(e) || !isStr(e.id) || !ID_RE.test(e.id) || seen.has(e.id)) {
      warnings.push(`sfx.json [${i}]: missing, invalid or duplicate id, skipping`);
      return;
    }
    const url = assetUrl(io, 'audio', isStr(e.file) ? `sfx/${e.file}` : null, warnings, `sfx ${e.id}`);
    if (!url) {
      if (!isStr(e.file)) warnings.push(`sfx.json ${e.id}: file required, skipping`);
      return;
    }
    seen.add(e.id);
    out.push({
      id: e.id,
      label: (isStr(e.label) ? e.label : e.id).slice(0, 40),
      url,
      hotkey: isStr(e.hotkey) && HOTKEY_RE.test(e.hotkey) ? e.hotkey : null,
      volume: typeof e.volume === 'number' && e.volume >= 0 && e.volume <= 2 ? e.volume : 1,
      // Surround: where it plays (front | rear | center | all) and how much goes to the subwoofer (0..1).
      route: ['front', 'rear', 'center', 'all'].includes(e.route) ? e.route : 'front',
      sub: typeof e.sub === 'number' && e.sub >= 0 && e.sub <= 1 ? e.sub : 0,
      group: (isStr(e.group) ? e.group : '').slice(0, 30),
    });
  });
  return out;
}

function loadMeta(raw, warnings) {
  const F = 'pack.json';
  need(isObj(raw), F, '', 'must be an object');
  need(isStr(raw.id) && ID_RE.test(raw.id), F, '"id"', 'required, letters/digits/_/- only');
  need(isStr(raw.name), F, '"name"', 'required string');
  const tiersRaw = raw.lootTiers ?? [];
  need(Array.isArray(tiersRaw), F, '"lootTiers"', 'must be an array');
  const seen = new Set();
  const lootTiers = tiersRaw.map((t, i) => {
    const w = `lootTiers[${i}]`;
    need(isObj(t), F, w, 'must be an object');
    need(isStr(t.id) && ID_RE.test(t.id), F, `${w}.id`, 'required, letters/digits/_/- only');
    need(!seen.has(t.id), F, `${w}.id`, `duplicate tier "${t.id}"`);
    seen.add(t.id);
    need(isStr(t.name), F, `${w}.name`, 'required string');
    const color = COLOR_RE.test(t.color ?? '') ? t.color : '#888888';
    if (t.color != null && color !== t.color) warnings.push(`pack.json ${w}.color invalid, using #888888`);
    return { id: t.id, name: t.name, color };
  });
  if (!lootTiers.length) warnings.push('pack.json: no lootTiers defined, loot boxes disabled');

  const aud = isObj(raw.audience) ? raw.audience : {};
  const startViewers = Number.isInteger(aud.startViewers) && aud.startViewers >= 50 ? aud.startViewers : 1000;
  const thr = aud.sponsorHypeThreshold;
  const sponsorHypeThreshold = typeof thr === 'number' && thr > 0 && thr <= 1 ? thr : 0.8;
  const autoBudget = Number.isInteger(raw.autoBudget) && raw.autoBudget >= 0 ? raw.autoBudget : 6;

  return {
    stats: loadStats(raw.stats, warnings),
    resources: loadResources(raw.resources, warnings),
    voices: loadVoices(raw.voices, warnings),
    id: raw.id,
    name: raw.name,
    version: isStr(raw.version) ? raw.version : '0.0.0',
    language: isStr(raw.language) ? raw.language : 'en',
    systemName: isStr(raw.systemName) ? raw.systemName : 'The System',
    notifyPrefix: isStr(raw.notifyPrefix) ? raw.notifyPrefix.trim().slice(0, 60) : '',
    theme: loadTheme(raw.theme, warnings),
    crawlers: normalizeCrawlersConfig(raw.crawlers, warnings), // crawlers.js: worldwide head count
    lootTiers,
    audience: { startViewers, sponsorHypeThreshold },
    autoBudget,
  };
}

/** Default look for the GM desk + player sheets ("dark" | "light" | "neon"); each device may override it. */
export const THEMES = ['dark', 'light', 'neon'];
function loadTheme(v, warnings) {
  if (v == null) return null;
  if (THEMES.includes(v)) return v;
  warnings.push(`pack.json "theme" must be one of ${THEMES.join(', ')}, ignoring`);
  return null;
}

export const DEFAULT_VOICE = Object.freeze({ id: 'host', label: 'Host', lang: 'en-US', rate: 1, pitch: 1, prefer: [] });

const num = (v, lo, hi, dflt) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : dflt);

// Optional arrays in pack.json: invalid entries are skipped with a warning, never fatal.
function optList(raw, key, warnings, mapper) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    warnings.push(`pack.json "${key}" must be an array, ignoring`);
    return [];
  }
  const seen = new Set();
  const out = [];
  raw.forEach((e, i) => {
    if (!isObj(e) || !isStr(e.id) || !ID_RE.test(e.id) || seen.has(e.id)) {
      warnings.push(`pack.json ${key}[${i}]: missing, invalid or duplicate id, skipping`);
      return;
    }
    seen.add(e.id);
    out.push(mapper(e));
  });
  return out;
}

function loadStats(raw, warnings) {
  return optList(raw, 'stats', warnings, (s) => ({
    id: s.id,
    label: isStr(s.label) ? s.label : s.id,
    abbr: isStr(s.abbr) ? s.abbr : s.id.slice(0, 3).toUpperCase(),
    default: Number.isFinite(s.default) ? s.default : 0,
  }));
}

function loadResources(raw, warnings) {
  return optList(raw, 'resources', warnings, (r) => ({
    id: r.id,
    label: isStr(r.label) ? r.label : r.id,
    color: COLOR_RE.test(r.color ?? '') ? r.color : '#888888',
    default: Number.isFinite(r.default) && r.default >= 0 ? r.default : 0,
  }));
}

function loadVoices(raw, warnings) {
  return optList(raw, 'voices', warnings, (v) => ({
    id: v.id,
    label: isStr(v.label) ? v.label : v.id,
    lang: isStr(v.lang) ? v.lang : 'en-US',
    rate: num(v.rate, 0.1, 10, 1),
    pitch: num(v.pitch, 0, 2, 1),
    prefer: Array.isArray(v.prefer) ? v.prefer.filter(isStr).slice(0, 10) : [],
  }));
}

function loadQuips(io, raw, warnings, voices) {
  const F = 'quips.json';
  if (raw === undefined) {
    warnings.push('quips.json missing, no voice lines');
    return [];
  }
  need(Array.isArray(raw), F, '', 'must be an array');
  const seen = new Set();
  return raw.map((q, i) => {
    const w = `[${i}]`;
    need(isObj(q), F, w, 'must be an object');
    need(isStr(q.id) && ID_RE.test(q.id), F, `${w}.id`, 'required, letters/digits/_/- only');
    need(!seen.has(q.id), F, `${w}.id`, `duplicate quip id "${q.id}"`);
    seen.add(q.id);
    need(isStr(q.category) && CATEGORY_RE.test(q.category), F, `${w}.category`, 'required, lowercase a-z 0-9 _');
    need(isStr(q.text), F, `${w}.text`, 'required string');
    // Per-voice audio lives in audio/<voiceId>/<file>; missing variants are silent (not warned).
    const audioByVoice = {};
    if (isStr(q.audio)) {
      for (const v of voices) {
        const url = assetUrl(io, 'audio', `${v.id}/${q.audio}`, [], '');
        if (url) audioByVoice[v.id] = url;
      }
    }
    const generic = assetUrl(io, 'audio', q.audio, Object.keys(audioByVoice).length ? [] : warnings, `quip ${q.id}`);
    // "also": extra categories the same line fits (e.g. the cleanup-crew line after a floor AND after a won fight).
    const also = Array.isArray(q.also) ? [...new Set(q.also.filter((c) => isStr(c) && CATEGORY_RE.test(c) && c !== q.category))] : [];
    if (Array.isArray(q.also) && also.length !== q.also.length) warnings.push(`quips.json ${q.id}: also has invalid or duplicate categories, kept ${also.length}`);
    return { id: q.id, category: q.category, text: q.text.trim(), audio: generic, audioByVoice, ...(also.length ? { also } : {}) };
  });
}

function loadAchievements(raw, quipsById, warnings) {
  const F = 'achievements.json';
  if (raw === undefined) {
    warnings.push('achievements.json missing, catalog empty (custom achievements still work)');
    return [];
  }
  need(Array.isArray(raw), F, '', 'must be an array');
  const seen = new Set();
  return raw.map((a, i) => {
    const w = `[${i}]`;
    need(isObj(a), F, w, 'must be an object');
    need(isStr(a.id) && ID_RE.test(a.id), F, `${w}.id`, 'required, letters/digits/_/- only');
    need(!seen.has(a.id), F, `${w}.id`, `duplicate achievement id "${a.id}"`);
    seen.add(a.id);
    need(isStr(a.title), F, `${w}.title`, 'required string');
    let voice = isStr(a.voice) ? a.voice : null;
    if (voice && !quipsById.has(voice)) {
      warnings.push(`achievements.json ${a.id}: voice "${voice}" is not a quip id, ignoring`);
      voice = null;
    }
    return {
      id: a.id,
      title: a.title,
      desc: typeof a.desc === 'string' ? a.desc : '',
      reward: isStr(a.reward) ? a.reward.trim() : '',
      group: isStr(a.group) ? a.group.trim() : '',
      voice,
    };
  });
}

/** icons.json: { fallback, categories: [{ id, base, variants: [{ id }] }] } → lookups for item art. */
function loadIcons(raw, warnings) {
  const out = { base: new Map(), fallback: null };
  if (raw === undefined) return out;
  if (!isObj(raw)) {
    warnings.push('icons.json must be an object, ignoring');
    return out;
  }
  if (isStr(raw.fallback) && ID_RE.test(raw.fallback)) out.fallback = raw.fallback;
  for (const c of Array.isArray(raw.categories) ? raw.categories : []) {
    if (isObj(c) && isStr(c.id) && isStr(c.base) && ID_RE.test(c.base)) out.base.set(c.id, c.base);
  }
  return out;
}

/**
 * Item art: the item's own `image` when that file exists, else images/<icon>.webp, else the icon
 * category's base icon, else the icon library fallback (see icons.json). Only a missing own `image`
 * with nothing to fall back to is warned about.
 */
function itemImage(io, it, icons, warnings) {
  const cands = [];
  if (isStr(it.image)) cands.push(it.image);
  if (isStr(it.icon) && ID_RE.test(it.icon)) cands.push(`${it.icon}.webp`);
  if (isStr(it.iconCategory) && icons.base.has(it.iconCategory)) cands.push(`${icons.base.get(it.iconCategory)}.webp`);
  if (icons.fallback && (cands.length || icons.base.size)) cands.push(`${icons.fallback}.webp`);
  for (const rel of cands) {
    if (typeof rel === 'string' && !UNSAFE_PATH.test(rel) && io.assetExists('images', rel)) return assetUrl(io, 'images', rel, warnings, `item ${it.id}`);
  }
  return assetUrl(io, 'images', it.image, warnings, `item ${it.id}`);
}

function loadItems(io, raw, warnings, icons = loadIcons(undefined, [])) {
  const F = 'items.json';
  if (raw === undefined) {
    warnings.push('items.json missing, no items');
    return [];
  }
  need(Array.isArray(raw), F, '', 'must be an array');
  const seen = new Set();
  return raw.map((it, i) => {
    const w = `[${i}]`;
    need(isObj(it), F, w, 'must be an object');
    need(isStr(it.id) && ID_RE.test(it.id), F, `${w}.id`, 'required, letters/digits/_/- only');
    need(!seen.has(it.id), F, `${w}.id`, `duplicate item id "${it.id}"`);
    seen.add(it.id);
    need(isStr(it.name), F, `${w}.name`, 'required string');
    let rarity = it.rarity ?? 'common';
    if (!RARITIES.includes(rarity)) {
      warnings.push(`items.json ${it.id}: unknown rarity "${rarity}", using common`);
      rarity = 'common';
    }
    // v2 fields (slot, stackable, effects, attack, use, tags) — invalid parts are skipped with a warning.
    const extra = normalizeLibEntry('item', { ...it, rarity }, { warnings, where: 'items.json', source: 'pack', image: () => null }) ?? {};
    return {
      id: it.id,
      name: it.name,
      desc: typeof it.desc === 'string' ? it.desc : '',
      flavor: isStr(it.flavor) ? it.flavor.trim() : '',
      rarity,
      image: itemImage(io, it, icons, warnings),
      tags: extra.tags ?? [],
      slot: extra.slot ?? null,
      stackable: !!extra.stackable,
      effects: extra.effects ?? [],
      attack: extra.attack ?? null,
      use: extra.use ?? null,
      source: 'pack',
      ...(extra.unverified ? { unverified: extra.unverified } : {}),
    };
  });
}

// Optional library files (spells.json, skills.json, ...): arrays; bad entries are skipped with a warning.
const LIB_FILES = { spell: 'spells', skill: 'skills', buff: 'buffs', feature: 'features', race: 'races', class: 'classes', background: 'backgrounds', boss: 'bosses', location: 'locations', monster: 'monsters', npc: 'npcs' };
export const LIBRARY_FILES = Object.values(LIB_FILES);

function loadLibrary(raw, ruleset, warnings, io) {
  const lib = {};
  for (const [kind, key] of Object.entries(LIB_FILES)) {
    const F = `${key}.json`;
    const list = [];
    const seen = new Set();
    const pushEntry = (e) => {
      if (!e) return;
      if (seen.has(e.id)) {
        warnings.push(`${F}: duplicate ${kind} id "${e.id}", skipping`);
        return;
      }
      seen.add(e.id);
      list.push(e);
    };
    const data = raw[key];
    if (data !== undefined) {
      if (!Array.isArray(data)) warnings.push(`${F} must be an array, ignoring`);
      else {
        data.forEach((x, i) => {
          const where = `${F} [${i}]`;
          // Boss art (and per-phase art) are pack-relative image paths, like item images.
          const image = ['boss', 'location', 'monster', 'npc'].includes(kind) ? (rel) => assetUrl(io, 'images', rel, warnings, `${kind} ${x?.id ?? i}`) : undefined;
          pushEntry(normalizeLibEntry(kind, x, { warnings, where, source: 'pack', image }));
        });
      }
    }
    if (kind === 'skill') for (const e of ruleset.skills.catalog) if (!seen.has(e.id)) pushEntry(e);
    if (ruleset.inlineLibrary?.[kind]) for (const e of ruleset.inlineLibrary[kind]) if (!seen.has(e.id)) pushEntry(e);
    lib[kind] = list;
  }
  for (const [kind, key] of [['race', 'races'], ['class', 'classes'], ['background', 'backgrounds']]) {
    for (const id of ruleset[key]) {
      if (!lib[kind].some((e) => e.id === id)) warnings.push(`ruleset.json ${key}: "${id}" is not defined in ${key}.json`);
    }
  }
  const featureIds = new Set(lib.feature.map((f) => f.id));
  for (const kind of ['race', 'class', 'background']) {
    for (const e of lib[kind]) for (const f of e.features) if (!featureIds.has(f)) warnings.push(`${LIB_FILES[kind]}.json ${e.id}: unknown feature "${f}"`);
  }
  return lib;
}

/** Legacy pack.stats / pack.resources (v1 view + player.stat/player.resource) derived from the ruleset. */
function legacyFromRuleset(ruleset) {
  return {
    stats: ruleset.stats.map((s) => ({ id: s.id, label: s.label, abbr: s.abbr, default: s.default[ruleset.statMod.from] ?? s.default[s.parts[0]] ?? 0 })),
    resources: ruleset.tracks.map((t) => ({ id: t.id, label: t.label, color: t.color, default: t.kind === 'slots' ? t.slots : t.default })),
  };
}

function loadLoot(raw, tiers, itemsById, warnings) {
  const F = 'loot.json';
  const loot = {};
  if (raw === undefined) {
    if (tiers.length) warnings.push('loot.json missing, loot boxes will be empty');
    return loot;
  }
  need(isObj(raw), F, '', 'must be an object { tierId: [ { item, weight } ] }');
  const tierIds = new Set(tiers.map((t) => t.id));
  for (const [tier, rows] of Object.entries(raw)) {
    if (!tierIds.has(tier)) {
      warnings.push(`loot.json: tier "${tier}" is not in pack.json lootTiers, ignoring`);
      continue;
    }
    need(Array.isArray(rows), F, `"${tier}"`, 'must be an array');
    loot[tier] = [];
    rows.forEach((r, i) => {
      const w = `"${tier}"[${i}]`;
      need(isObj(r), F, w, 'must be an object');
      need(typeof r.weight === 'number' && r.weight > 0 && Number.isFinite(r.weight), F, `${w}.weight`, 'must be a positive number');
      if (!itemsById.has(r.item)) {
        warnings.push(`loot.json ${w}: unknown item "${r.item}", skipping`);
        return;
      }
      loot[tier].push({ item: r.item, weight: r.weight });
    });
  }
  for (const t of tiers) {
    if (!loot[t.id]?.length) warnings.push(`loot.json: tier "${t.id}" has no entries`);
  }
  return loot;
}

/*
 * ui.json (optional): art for the show's chrome. Every asset is a path under images/ — a string, or
 * { src, still?, strip?, frames?, fps?, w?, h?, loop? } for animations (still = reduced-motion / phone
 * fallback; strip = horizontal sprite strip the TV animates with steps()). A string whose
 * "<name>_0.webp" sibling exists gets that as its still automatically. Missing files are skipped with a
 * warning; the UI then keeps its CSS / procedural look. Schema: docs/CONTENT_PACKS.md "ui.json".
 */
const UI_SECTIONS = {
  logo: 0, // the show emblem
  logoOptions: 1, // alternatives the GM can pick from (not shown)
  mascot: 1, // System mascot by mood: neutral, smug, angry, glitch, delighted, talking, idle, ...
  lootBoxes: 2, // tier id (or "default") → closed | open | opening | idle
  dice: 2, // d20 | d6 | ... → body | nat20 | nat1 | sponsor
  conditions: 1, // buff id (or "default") → icon
  sponsors: 1, // sponsor id → logo (or { name, image })
  finale: 1, // combat outcome (victory, defeat, ..., mvp) → illustration
  floors: 2, // floor ("1", "2", "default") → default | lobby | explore | combat | boss
  rarityFrames: 1, // rarity (+ "sponsor") → top-left corner ornament, mirrored to four corners
  medals: 1, // achievement group (slug, or "default") → medal
  fx: 1, // impact | crit | slash | heal | fire | ... → decal / animation
  stingers: 1, // boss | loot | break → full-screen panel
  empty: 1, // empty-state spots
  avatars: 1, // picker for crawlers without a photo
  anim: 1, // other animations (ambience props, ...)
};
export const UI_SECTION_NAMES = Object.keys(UI_SECTIONS);
const UI_MAX = 200;

function uiAsset(io, v, warnings, label) {
  if (typeof v === 'string') v = { src: v };
  if (!isObj(v)) {
    warnings.push(`ui.json ${label}: expected a path or { src }, ignoring`);
    return null;
  }
  const rel = isStr(v.src) ? v.src : isStr(v.image) ? v.image : null;
  if (!rel) {
    warnings.push(`ui.json ${label}: src missing, ignoring`);
    return null;
  }
  const src = assetUrl(io, 'images', rel, warnings, `ui ${label}`);
  if (!src) return null;
  let still = isStr(v.still) ? assetUrl(io, 'images', v.still, warnings, `ui ${label}.still`) : null;
  if (!still && v.still == null) {
    const auto = rel.replace(/\.(webp|png|gif)$/i, '_0.webp');
    if (auto !== rel && !UNSAFE_PATH.test(auto) && io.assetExists('images', auto)) still = assetUrl(io, 'images', auto, [], '');
  }
  const out = { src, still };
  if (isStr(v.strip)) {
    const strip = assetUrl(io, 'images', v.strip, warnings, `ui ${label}.strip`);
    const int = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
    if (strip && int(v.frames, 2, 128) && int(v.w, 1, 4096) && int(v.h, 1, 4096)) {
      out.strip = { src: strip, frames: v.frames, w: v.w, h: v.h, fps: num(v.fps, 0.5, 60, 10), loop: v.loop !== false };
    } else if (strip) warnings.push(`ui.json ${label}: strip needs integer frames (2-128), w and h, ignoring the strip`);
  }
  if (isStr(v.name)) out.name = v.name.trim().slice(0, 60);
  return out;
}

function uiMap(io, raw, depth, warnings, label) {
  const out = {};
  if (!isObj(raw)) {
    warnings.push(`ui.json ${label} must be an object, ignoring`);
    return out;
  }
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (!ID_RE.test(k)) {
      warnings.push(`ui.json ${label}: bad key ${JSON.stringify(k)}, skipping`);
      continue;
    }
    if (++n > UI_MAX) {
      warnings.push(`ui.json ${label}: more than ${UI_MAX} entries, ignoring the rest`);
      break;
    }
    if (depth === 2) {
      // floors / lootBoxes / dice: a bare asset is shorthand for { default: asset }.
      const inner = uiMap(io, typeof v === 'string' || (isObj(v) && (v.src || v.image)) ? { default: v } : v, 1, warnings, `${label}.${k}`);
      if (Object.keys(inner).length) out[k] = inner;
    } else {
      const a = uiAsset(io, v, warnings, `${label}.${k}`);
      if (a) out[k] = a;
    }
  }
  return out;
}

export function loadUi(io, raw, warnings) {
  if (raw === undefined) return null;
  if (!isObj(raw)) {
    warnings.push('ui.json must be an object, ignoring');
    return null;
  }
  const ui = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in UI_SECTIONS)) {
      warnings.push(`ui.json: unknown section "${k}", ignoring`);
      continue;
    }
    if (UI_SECTIONS[k] === 0) {
      const a = uiAsset(io, v, warnings, k);
      if (a) ui[k] = a;
    } else {
      const m = uiMap(io, v, UI_SECTIONS[k], warnings, k);
      if (Object.keys(m).length) ui[k] = m;
    }
  }
  return ui;
}

function loadChat(raw, warnings) {
  return normalizeChatLines(raw, warnings);
}

// Adds lookup maps (derived data, never serialized).
function finish(pack) {
  pack.achievementsById = new Map(pack.achievements.map((a) => [a.id, a]));
  pack.itemsById = new Map(pack.items.map((i) => [i.id, i]));
  pack.quipsById = new Map(pack.quips.map((q) => [q.id, q]));
  pack.quipsByCategory = new Map();
  // Recorded lines by text: a boss intro, a defeat line or a typed announcement whose text matches a
  // recorded quip plays that file (edit the text and it falls back to TTS until it is recorded again).
  pack.quipsByText = new Map();
  for (const q of pack.quips) {
    if (q.audio || Object.keys(q.audioByVoice ?? {}).length) pack.quipsByText.set(voiceKey(q.text), q);
  }
  for (const q of pack.quips) {
    for (const c of [q.category, ...(q.also ?? [])]) {
      if (!pack.quipsByCategory.has(c)) pack.quipsByCategory.set(c, []);
      pack.quipsByCategory.get(c).push(q);
    }
  }
  pack.tiersById = new Map(pack.lootTiers.map((t) => [t.id, t]));
  pack.statsById = new Map(pack.stats.map((s) => [s.id, s]));
  pack.resourcesById = new Map(pack.resources.map((r) => [r.id, r]));
  pack.voicesById = new Map(pack.voices.map((v) => [v.id, v]));
  pack.tracksById = new Map(pack.ruleset.tracks.map((t) => [t.id, t]));
  return pack;
}

/** Full voice object for an id, falling back to the first pack voice, then the built-in host. */
export function voiceFor(pack, id) {
  return pack.voicesById.get(id) ?? pack.voices[0] ?? DEFAULT_VOICE;
}

/** Audio URL for a quip in a given voice: audio/<voiceId>/<file> beats audio/<file>. */
export function quipAudio(quip, voiceId) {
  return quip.audioByVoice?.[voiceId] ?? quip.audio ?? null;
}

/** Text key for recorded lines: whitespace, case, curly quotes and trailing punctuation do not matter. */
export function voiceKey(text) {
  return String(text ?? '').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.!?…]+$/, '');
}

/** Recorded audio for any line: its own quip first, then a recorded quip with the same text. */
export function recordedAudio(pack, { quipId = null, text = '' } = {}, voiceId = null) {
  const own = quipId ? pack?.quipsById?.get(quipId) : null;
  const ownUrl = own ? quipAudio(own, voiceId) : null;
  if (ownUrl) return ownUrl;
  const byText = text ? pack?.quipsByText?.get(voiceKey(text)) : null;
  return byText ? quipAudio(byText, voiceId) : null;
}

/**
 * Validates and normalizes already-parsed pack JSON.
 * raw = { pack, achievements?, items?, loot?, quips?, chat?, ui?, icons?, ... } (undefined = file missing; `pack` required).
 * opts.assetExists(sub, rel) tells whether images/<rel> or audio/<rel> exists (default: assume yes).
 * opts.baseUrl is the URL prefix for assets (default '/pack/'). opts.dir is stored as pack.dir.
 * Returns { pack, warnings }. Throws PackError on structural problems.
 */
export function normalizePack(raw, opts = {}) {
  if (!isObj(raw)) throw new PackError('normalizePack: expected { pack, achievements, items, loot, quips, chat }');
  if (raw.pack === undefined) throw new PackError('pack.json is missing');
  const io = { assetExists: opts.assetExists ?? (() => true), baseUrl: opts.baseUrl ?? '/pack/' };
  const warnings = [];
  const meta = loadMeta(raw.pack, warnings);
  const quips = loadQuips(io, raw.quips, warnings, meta.voices);
  const quipsById = new Map(quips.map((q) => [q.id, q]));
  const achievements = loadAchievements(raw.achievements, quipsById, warnings);
  const items = loadItems(io, raw.items, warnings, loadIcons(raw.icons, warnings));
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const loot = loadLoot(raw.loot, meta.lootTiers, itemsById, warnings);
  const chat = loadChat(raw.chat, warnings);
  const rawRuleset = raw.ruleset !== undefined ? raw.ruleset : raw.pack.ruleset;
  const ruleset = normalizeRuleset(rawRuleset, { stats: meta.stats, resources: meta.resources }, warnings);
  const library = loadLibrary(raw, ruleset, warnings, io);
  const sfx = loadSfx(io, raw.sfx, warnings);
  const ui = loadUi(io, raw.ui, warnings);
  const pack = finish({ ...meta, sfx, ui, ...legacyFromRuleset(ruleset), dir: opts.dir ?? null, achievements, items, loot, quips, chat, ruleset: JSON.parse(JSON.stringify(ruleset)), library });
  return { pack, warnings };
}

export const PACK_FORMAT = 'the-system-pack/1';
const DATA_KEYS = [
  'id', 'name', 'version', 'language', 'systemName', 'notifyPrefix', 'lootTiers', 'audience', 'autoBudget',
  'stats', 'resources', 'voices', 'achievements', 'items', 'loot', 'quips', 'chat',
];
// v2 keys: optional on deserialize (packs serialized before v2 still load).
const OPTIONAL_KEYS = ['ruleset', 'library', 'theme', 'sfx', 'ui', 'crawlers'];

function emptyLibrary() {
  return Object.fromEntries(LIB_KINDS.filter((k) => k !== 'item').map((k) => [k, []]));
}

/** JSON-safe plain object of a normalized pack (no Maps, no host paths). */
export function serializePack(pack) {
  const out = { format: PACK_FORMAT };
  for (const k of [...DATA_KEYS, ...OPTIONAL_KEYS]) out[k] = pack[k];
  return JSON.parse(JSON.stringify(out));
}

/** Rehydrates serializePack output (object or JSON string) into a usable pack. */
export function deserializePack(data) {
  const d = typeof data === 'string' ? JSON.parse(data) : data;
  if (!isObj(d) || d.format !== PACK_FORMAT) throw new PackError(`deserializePack: expected format "${PACK_FORMAT}"`);
  for (const k of DATA_KEYS) {
    if (d[k] === undefined) throw new PackError(`deserializePack: missing "${k}"`);
  }
  const pack = {};
  for (const k of DATA_KEYS) pack[k] = structuredClone(d[k]);
  // Re-normalize the ruleset (idempotent) so hand-edited / old embeds are safe.
  pack.ruleset = JSON.parse(JSON.stringify(normalizeRuleset(d.ruleset ?? null, { stats: pack.stats, resources: pack.resources })));
  const lib = emptyLibrary();
  if (isObj(d.library)) {
    for (const k of Object.keys(lib)) {
      if (!Array.isArray(d.library[k])) continue;
      lib[k] = d.library[k].map((e) => normalizeLibEntry(k, e, { source: 'pack' })).filter(Boolean);
    }
  }
  pack.library = lib;
  pack.theme = THEMES.includes(d.theme) ? d.theme : null;
  pack.crawlers = normalizeCrawlersConfig(d.crawlers ?? null);
  pack.sfx = Array.isArray(d.sfx) ? d.sfx.filter((x) => isObj(x) && isStr(x.id) && isStr(x.url)) : [];
  pack.ui = isObj(d.ui) ? structuredClone(d.ui) : null; // already normalized URLs (built by normalizePack)
  pack.items = pack.items.map((it) => ({ tags: [], slot: null, stackable: false, effects: [], attack: null, use: null, source: 'pack', ...it }));
  pack.dir = null;
  return finish(pack);
}

/** Empty but valid pack used when the configured pack cannot be loaded. */
export function fallbackPack() {
  return finish({
    id: 'fallback',
    name: 'No pack loaded',
    version: '0.0.0',
    language: 'en',
    systemName: 'The System',
    notifyPrefix: '',
    theme: null,
    ui: null,
    crawlers: normalizeCrawlersConfig(null),
    lootTiers: [],
    audience: { startViewers: 1000, sponsorHypeThreshold: 0.8 },
    autoBudget: 6,
    stats: [],
    resources: [],
    voices: [],
    dir: null,
    achievements: [],
    items: [],
    loot: {},
    quips: [],
    chat: [],
    ruleset: JSON.parse(JSON.stringify(normalizeRuleset(null, { stats: [], resources: [] }))),
    library: emptyLibrary(),
  });
}
