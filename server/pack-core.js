// Pure pack normalization + validation (browser-safe, no Node imports). See docs/CONTENT_PACKS.md.
// pack.js does the file reading; the hosted edition calls normalizePack/deserializePack directly.
import { normalizeChatLines } from './chat.js';
import { STANDARD_CATEGORIES } from './constants.js';
import { normalizeRuleset, normalizeLibEntry, LIB_KINDS } from './ruleset.js';

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

/** sfx.json: [{ id, label, file, hotkey?, volume? }] — files under audio/sfx/. Adds/overrides GM desk pads. */
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
    return { id: q.id, category: q.category, text: q.text.trim(), audio: generic, audioByVoice };
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

function loadItems(io, raw, warnings) {
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
      image: assetUrl(io, 'images', it.image, warnings, `item ${it.id}`),
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

function loadChat(raw, warnings) {
  return normalizeChatLines(raw, warnings);
}

// Adds lookup maps (derived data, never serialized).
function finish(pack) {
  pack.achievementsById = new Map(pack.achievements.map((a) => [a.id, a]));
  pack.itemsById = new Map(pack.items.map((i) => [i.id, i]));
  pack.quipsById = new Map(pack.quips.map((q) => [q.id, q]));
  pack.quipsByCategory = new Map();
  for (const q of pack.quips) {
    if (!pack.quipsByCategory.has(q.category)) pack.quipsByCategory.set(q.category, []);
    pack.quipsByCategory.get(q.category).push(q);
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

/**
 * Validates and normalizes already-parsed pack JSON.
 * raw = { pack, achievements?, items?, loot?, quips?, chat? } (undefined = file missing; `pack` required).
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
  const items = loadItems(io, raw.items, warnings);
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const loot = loadLoot(raw.loot, meta.lootTiers, itemsById, warnings);
  const chat = loadChat(raw.chat, warnings);
  const rawRuleset = raw.ruleset !== undefined ? raw.ruleset : raw.pack.ruleset;
  const ruleset = normalizeRuleset(rawRuleset, { stats: meta.stats, resources: meta.resources }, warnings);
  const library = loadLibrary(raw, ruleset, warnings, io);
  const sfx = loadSfx(io, raw.sfx, warnings);
  const pack = finish({ ...meta, sfx, ...legacyFromRuleset(ruleset), dir: opts.dir ?? null, achievements, items, loot, quips, chat, ruleset: JSON.parse(JSON.stringify(ruleset)), library });
  return { pack, warnings };
}

export const PACK_FORMAT = 'the-system-pack/1';
const DATA_KEYS = [
  'id', 'name', 'version', 'language', 'systemName', 'notifyPrefix', 'lootTiers', 'audience', 'autoBudget',
  'stats', 'resources', 'voices', 'achievements', 'items', 'loot', 'quips', 'chat',
];
// v2 keys: optional on deserialize (packs serialized before v2 still load).
const OPTIONAL_KEYS = ['ruleset', 'library', 'theme', 'sfx'];

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
  pack.sfx = Array.isArray(d.sfx) ? d.sfx.filter((x) => isObj(x) && isStr(x.id) && isStr(x.url)) : [];
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
