// Content pack loader + validation. See docs/CONTENT_PACKS.md.
import fs from 'node:fs';
import path from 'node:path';

export class PackError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'PackError';
  }
}

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

export const STANDARD_CATEGORIES = [
  'nat1', 'nat20', 'death', 'levelup', 'boss', 'fail', 'success', 'idle',
  'achievement', 'loot', 'sponsor', 'welcome', 'goodbye',
];

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CATEGORY_RE = /^[a-z0-9_]{1,32}$/;
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function readJson(dir, file, optional) {
  const p = path.join(dir, file);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      if (optional) return undefined;
      throw new PackError(`${file} is missing (looked in ${dir})`);
    }
    throw new PackError(`cannot read ${p}: ${e.message}`);
  }
  try {
    return JSON.parse(raw.replace(/^﻿/, ''));
  } catch (e) {
    throw new PackError(`${file}: invalid JSON (${e.message})`);
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

function need(cond, file, where, msg) {
  if (!cond) throw new PackError(`${file}${where ? ` ${where}` : ''}: ${msg}`);
}

// Pack-relative asset path → public URL, or null if missing/unsafe.
function assetUrl(dir, sub, rel, warnings, label) {
  if (rel == null || rel === '') return null;
  if (typeof rel !== 'string' || rel.includes('..') || path.isAbsolute(rel) || rel.includes('\0')) {
    warnings.push(`${label}: ignoring unsafe ${sub} path ${JSON.stringify(rel)}`);
    return null;
  }
  if (!fs.existsSync(path.join(dir, sub, rel))) {
    warnings.push(`${label}: ${sub}/${rel} not found, using fallback`);
    return null;
  }
  return `/pack/${sub}/` + rel.split('/').map(encodeURIComponent).join('/');
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
    lootTiers,
    audience: { startViewers, sponsorHypeThreshold },
    autoBudget,
  };
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

function loadQuips(dir, raw, warnings, voices) {
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
        const url = assetUrl(dir, 'audio', `${v.id}/${q.audio}`, [], '');
        if (url) audioByVoice[v.id] = url;
      }
    }
    const generic = assetUrl(dir, 'audio', q.audio, Object.keys(audioByVoice).length ? [] : warnings, `quip ${q.id}`);
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

function loadItems(dir, raw, warnings) {
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
    return {
      id: it.id,
      name: it.name,
      desc: typeof it.desc === 'string' ? it.desc : '',
      flavor: isStr(it.flavor) ? it.flavor.trim() : '',
      rarity,
      image: assetUrl(dir, 'images', it.image, warnings, `item ${it.id}`),
    };
  });
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
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push('chat.json must be an array, ignoring');
    return [];
  }
  return raw
    .filter((c) => isObj(c) && isStr(c.user) && isStr(c.text))
    .map((c) => ({ user: c.user.slice(0, 40), text: c.text.slice(0, 200) }));
}

// Adds lookup maps. Shared by loadPack and fallbackPack.
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

/** Loads and validates a pack folder. Throws PackError on structural problems. */
export function loadPack(dir) {
  const warnings = [];
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new PackError(`pack folder not found: ${abs}`);
  }
  const meta = loadMeta(readJson(abs, 'pack.json', false), warnings);
  const quips = loadQuips(abs, readJson(abs, 'quips.json', true), warnings, meta.voices);
  const quipsById = new Map(quips.map((q) => [q.id, q]));
  const achievements = loadAchievements(readJson(abs, 'achievements.json', true), quipsById, warnings);
  const items = loadItems(abs, readJson(abs, 'items.json', true), warnings);
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const loot = loadLoot(readJson(abs, 'loot.json', true), meta.lootTiers, itemsById, warnings);
  const chat = loadChat(readJson(abs, 'chat.json', true), warnings);
  const pack = finish({ ...meta, dir: abs, achievements, items, loot, quips, chat });
  return { pack, warnings };
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
  });
}
