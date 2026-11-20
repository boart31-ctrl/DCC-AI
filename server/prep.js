// Příprava (session prep): adventures and session plans built from templates. Pure + browser-safe.
//
// Two levels, one data shape (a "doc"):
//   adventure  content that lasts several evenings (a neighbourhood, a quest, a dungeon)
//   session    tonight's plan; created from the previous session (unfinished items of `carry` sections
//              move over) and optionally linked to an adventure
//
// state.prep = { docs: [Doc], current: sessionDocId|null }
//   Doc     = { id, type: 'adventure'|'session', template, title, adventureId|null, createdAt, sections: [Section] }
//   Section = { key, label, kind, hint, carry, refKinds, hidden, text, items: [Item] }
//   Item    = { id, title, text, done, pin, ref: {kind, id}|null, links: [{kind, id}] }
//             links = what a part / scene needs at the table (its encounter, map, NPCs, location…);
//             ref kind `encounter` = a prepared encounter (prep card id, server/encounters.js)
//
// Section kinds: text (one free text) · list (tick list) · refs (links to library entries / prepared cards)
// · parts (titled chunks: quarters of a neighbourhood, quest stages, scenes; tickable).
// `pin` marks an item for the "Na dosah" (within reach) strip on the Show tab.
//
// Templates: built-in Lazy DM templates for every ruleset; a content pack adds its own in pack.json "prep"
// ({ templates: [{ id, label, scope, families?, sections: [{ key, label, kind, hint?, carry?, refKinds? }] }] }).
// A template with `families` only shows up in campaigns whose ruleset family matches.
import { bad, notFound } from './errors.js';
import { libraryOf } from './character.js';
import { MAPS_GM, MAX_MAPS } from './maps.js';

export const DOC_TYPES = ['adventure', 'session'];
export const SECTION_KINDS = ['text', 'list', 'refs', 'parts'];
export const REF_KINDS = ['encounter', 'monster', 'boss', 'npc', 'location', 'item', 'spell', 'buff', 'card', 'map', 'loot'];
export const MAX_LINKS = 12;
export const MAX_DOCS = 80;
export const MAX_SECTIONS = 30;
export const MAX_ITEMS = 200;
export const MAX_TEXT = 6000;
export const MAX_TITLE = 120;
export const SCENE_TYPES = ['fight', 'explore', 'talk', 'trap', 'boss'];
const SCENE_MINUTES = { fight: 30, explore: 25, talk: 15, trap: 15, boss: 45 };
const SCENE_GOALS = {
  fight: 'Secure the objective, drive off the opposition, or make a safe retreat.',
  explore: 'Find a route forward or uncover something that changes the plan.',
  talk: 'Learn what the other side wants and decide what to offer.',
  trap: 'Spot the danger and decide how to cross, disable, or avoid it.',
  boss: 'Settle what is at stake and decide how the fight changes when the foe is pressed.',
};
const SCENE_CHECKS = {
  explore: { label: 'Spot a useful detail', stat: ['wis', 'int'], dcType: 'unopposed', dc: 10 },
  talk: { label: 'Read the other side', stat: ['cha', 'wis'], dcType: 'opposed', dc: 13 },
  trap: { label: 'Disable or bypass the hazard', stat: ['dex', 'int'], dcType: 'stat', dc: 15 },
};
const DC_TYPES = ['stat', 'unopposed', 'opposed', 'fixed'];
const MAX_SCENES = 40;
const MAX_SCENE_ROWS = 24;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const KEY_RE = /^[a-z0-9_]{1,40}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,60}$/;

const sec = (key, label, kind, extra = {}) => ({ key, label, kind, ...extra });

/** Built-in templates (any ruleset). Lazy DM's eight steps for a session; a plain adventure outline. */
export const BUILTIN_TEMPLATES = Object.freeze([
  {
    id: 'lazy_session',
    label: 'Session (Lazy DM)',
    scope: 'session',
    builtin: true,
    sections: [
      sec('characters', 'Review the characters', 'text', { hint: 'What do the characters want right now? Whose story gets a spotlight tonight?' }),
      sec('strong_start', 'Strong start', 'text', { hint: 'Open in the middle of something happening. One or two sentences.' }),
      sec('scenes', 'Potential scenes', 'parts', { hint: 'Things that might happen. Not a script: drop what the players skip.', carry: true }),
      sec('secrets', 'Secrets and clues', 'list', { hint: 'About ten one-line facts the players can discover in any scene. Unrevealed ones carry over.', carry: true }),
      sec('locations', 'Fantastic locations', 'refs', { refKinds: ['location', 'map'] }),
      sec('npcs', 'Important NPCs', 'refs', { refKinds: ['npc'] }),
      sec('monsters', 'Encounters and monsters', 'refs', { refKinds: ['encounter', 'monster', 'boss', 'card'] }),
      sec('treasure', 'Rewards', 'refs', { refKinds: ['item', 'card'] }),
      sec('notes', 'Notes', 'text'),
    ],
  },
  {
    id: 'adventure',
    label: 'Adventure',
    scope: 'adventure',
    builtin: true,
    sections: [
      sec('summary', 'Summary', 'text', { hint: 'What is this place or story about, in a few sentences?' }),
      sec('hooks', 'Hooks', 'list', { hint: 'Ways to pull the characters in.' }),
      sec('parts', 'Parts', 'parts', { hint: 'Areas, chapters or stages. Tick them off as they are played.' }),
      sec('locations', 'Locations', 'refs', { refKinds: ['location', 'map'] }),
      sec('npcs', 'NPCs', 'refs', { refKinds: ['npc'] }),
      sec('monsters', 'Encounters and monsters', 'refs', { refKinds: ['encounter', 'monster', 'boss', 'card'] }),
      sec('treasure', 'Rewards', 'refs', { refKinds: ['item', 'card'] }),
      sec('secrets', 'Secrets', 'list'),
      sec('notes', 'Notes', 'text'),
    ],
  },
]);

function normalizeSectionDef(s, where, warnings) {
  if (!isObj(s) || !isStr(s.key) || !KEY_RE.test(s.key) || !isStr(s.label)) {
    warnings.push(`${where}: needs a key (a-z, 0-9, _) and a label, skipping`);
    return null;
  }
  const kind = SECTION_KINDS.includes(s.kind) ? s.kind : 'text';
  if (s.kind != null && kind !== s.kind) warnings.push(`${where}: kind must be one of ${SECTION_KINDS.join(', ')}, using text`);
  const out = { key: s.key, label: s.label.trim().slice(0, 60), kind };
  if (isStr(s.hint)) out.hint = s.hint.trim().slice(0, 300);
  if (s.carry === true) out.carry = true;
  if (Array.isArray(s.refKinds)) {
    const rk = s.refKinds.filter((k) => REF_KINDS.includes(k));
    if (rk.length) out.refKinds = rk;
  }
  return out;
}

/** Normalizes pack.json "prep" (idempotent). Never throws. */
export function normalizePrepConfig(raw, warnings = []) {
  if (raw == null) return { templates: [] };
  if (!isObj(raw)) { warnings.push('pack.json "prep" must be an object, ignoring'); return { templates: [] }; }
  const templates = [];
  const ids = new Set(BUILTIN_TEMPLATES.map((t) => t.id));
  for (const [i, t] of (Array.isArray(raw.templates) ? raw.templates : []).entries()) {
    const w = `pack.json prep.templates[${i}]`;
    if (!isObj(t) || !isStr(t.id) || !KEY_RE.test(t.id) || ids.has(t.id) || !isStr(t.label)) {
      warnings.push(`${w}: needs a unique id (a-z, 0-9, _) and a label, skipping`);
      continue;
    }
    const keys = new Set();
    const sections = [];
    for (const [j, s] of (Array.isArray(t.sections) ? t.sections : []).entries()) {
      const d = normalizeSectionDef(s, `${w}.sections[${j}]`, warnings);
      if (!d || keys.has(d.key)) continue;
      keys.add(d.key);
      sections.push(d);
    }
    if (!sections.length) { warnings.push(`${w}: no valid sections, skipping`); continue; }
    ids.add(t.id);
    const tpl = { id: t.id, label: t.label.trim().slice(0, 60), scope: t.scope === 'session' ? 'session' : 'adventure', sections };
    if (Array.isArray(t.families)) tpl.families = t.families.filter(isStr).slice(0, 8);
    if (isStr(t.desc)) tpl.desc = t.desc.trim().slice(0, 300);
    if (t.default === true) tpl.default = true;
    templates.push(tpl);
  }
  const adventures = (Array.isArray(raw.adventures) ? raw.adventures : []).slice(0, 12).map((d) => {
    if (!isObj(d) || !KEY_RE.test(d.id ?? '') || !isStr(d.title)) {
      warnings.push('prepared adventure needs an id and title');
      return null;
    }
    const doc = normalizeDoc({ ...d, type: 'adventure' });
    const evenings = uniqueRows(d.evenings, (e) => {
      if (!isObj(e) || !ID_RE.test(e.key ?? '') || !isStr(e.title)) return null;
      const scenes = uniqueRows(e.scenes, normalizeEveningScene, MAX_SCENES);
      return scenes.length ? { key: e.key, title: cleanText(e.title, MAX_TITLE), floor: numeric(e.floor, 1, 999, 1), scenes } : null;
    }, MAX_SCENES, 'key');
    if (!doc?.sections.length && !evenings.length) return null;
    const maps = (Array.isArray(d.maps) ? d.maps : []).filter((m) => isObj(m) && ID_RE.test(m.id ?? '')).slice(0, MAX_MAPS);
    return {
      id: doc.id, title: doc.title, families: Array.isArray(d.families) ? d.families.filter(isStr).slice(0, 8) : null,
      sections: doc.sections, encounters: (Array.isArray(d.encounters) ? d.encounters : []).filter((e) => isObj(e) && ID_RE.test(e.id ?? '')).slice(0, 80),
      ...(maps.length ? { maps } : {}),
      ...(evenings.length ? { evenings } : {}),
    };
  }).filter(Boolean);
  return { templates, ...(adventures.length ? { adventures } : {}) };
}

/** Templates a campaign can use: the pack's (matching its ruleset family) first, then the built-ins. */
export function templatesFor(pack) {
  const family = pack?.ruleset?.system?.family ?? 'crawler';
  const own = (pack?.prep?.templates ?? []).filter((t) => !t.families || t.families.includes(family));
  return [...own, ...BUILTIN_TEMPLATES];
}

/** Default template id for a scope: the pack's flagged one, else its first, else the built-in. */
export function defaultTemplate(pack, scope) {
  const list = templatesFor(pack).filter((t) => t.scope === scope);
  return (list.find((t) => t.default) ?? list[0])?.id ?? null;
}

export function initPrep() {
  return { docs: [], current: null };
}

function cleanText(v, max = MAX_TEXT) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

const validId = (v) => typeof v === 'string' && ID_RE.test(v) ? v : null;
const numeric = (value, min, max, fallback) => Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
const refIds = (list) => Array.isArray(list) ? [...new Set(list.map(validId).filter(Boolean))].slice(0, MAX_SCENE_ROWS) : [];
const optionalText = (v, limit) => cleanText(v, limit).trim();

function uniqueRows(list, normalizer, max, key = 'id') {
  const rows = Array.isArray(list) ? list.slice(0, max).map(normalizer).filter(Boolean) : [];
  return [...new Map(rows.map((row) => [row[key], row])).values()];
}

function normalizeEveningScene(s, index = 0) {
  if (!isObj(s)) return null;
  const type = SCENE_TYPES.includes(s.type) ? s.type : 'explore';
  const checks = uniqueRows(s.checks, (c, i) => {
    if (!isObj(c)) return null;
    const statId = validId(c.statId), skillId = validId(c.skillId);
    return { id: validId(c.id) ?? `check_${i + 1}`, label: optionalText(c.label, 120), ...(statId ? { statId } : {}), ...(skillId ? { skillId } : {}),
      dcType: DC_TYPES.includes(c.dcType) ? c.dcType : 'stat', dc: numeric(c.dc, 0, 999, 10), mod: numeric(c.mod, -99, 99, 0),
      near: cleanText(c.near, 600), fail: cleanText(c.fail, 600), success: cleanText(c.success, 600) };
  }, MAX_SCENE_ROWS);
  const secrets = uniqueRows(s.secrets, (entry, i) => {
    if (!isObj(entry)) return null;
    return { id: validId(entry.id) ?? `secret_${i + 1}`, text: cleanText(entry.text, 600), revealed: entry.revealed === true };
  }, MAX_SCENE_ROWS);
  return {
    id: validId(s.id) ?? `scene_${index + 1}`, title: optionalText(s.title, MAX_TITLE) || `Scene ${index + 1}`, type,
    minutes: numeric(s.minutes, 0, 1440, SCENE_MINUTES[type]), goal: cleanText(s.goal, 600),
    readAloud: cleanText(s.readAloud, 4000), notes: cleanText(s.notes), checks,
    encounterId: validId(s.encounterId), mapId: validId(s.mapId), npcs: refIds(s.npcs), items: refIds(s.items), secrets,
    played: s.played === true, ...(validId(s.lastCombatId) ? { lastCombatId: s.lastCombatId } : {}),
    ...(validId(s.lastEncounterId) ? { lastEncounterId: s.lastEncounterId } : {}),
  };
}

function normalizeEvening(e) {
  if (!isObj(e)) return null;
  const scenes = uniqueRows(e.scenes, normalizeEveningScene, MAX_SCENES);
  const activeSceneId = scenes.some((s) => s.id === e.activeSceneId) ? e.activeSceneId : scenes[0]?.id ?? null;
  return {
    minutes: numeric(e.minutes, 1, 1440, 240), activeSceneId, scenes,
    ...(validId(e.sourceKey) ? { sourceKey: e.sourceKey } : {}),
  };
}

function legacyEvening(doc) {
  const parts = doc.sections.filter((s) => s.kind === 'parts' && !s.hidden).flatMap((s) => s.items);
  const scenes = parts.map((part) => {
    const refs = [part.ref, ...part.links].filter(Boolean);
    const encounterId = refs.find((r) => r.kind === 'encounter')?.id;
    const type = refs.some((r) => r.kind === 'boss') ? 'boss' : encounterId ? 'fight' : 'explore';
    return { id: part.id, title: part.title, type, notes: part.text, played: part.done, encounterId,
      mapId: refs.find((r) => r.kind === 'map')?.id, npcs: refs.filter((r) => r.kind === 'npc').map((r) => r.id),
      items: refs.filter((r) => r.kind === 'item').map((r) => r.id) };
  });
  const readAloud = doc.sections.find((s) => s.key === 'strong_start')?.text ?? '';
  const notes = doc.sections.find((s) => s.key === 'notes')?.text ?? '';
  const secrets = (doc.sections.find((s) => s.key === 'secrets')?.items ?? []).map((s) => ({ id: s.id, text: s.text || s.title, revealed: s.done }));
  if (!scenes.length && (readAloud || notes || secrets.length)) scenes.push({ id: 'opening', title: 'Opening scene', type: 'explore' });
  if (scenes.length) Object.assign(scenes[0], { readAloud, secrets, notes: [scenes[0].notes, notes].filter(Boolean).join('\n\n') });
  return scenes.length ? normalizeEvening({ scenes, activeSceneId: scenes.find((s) => !s.played)?.id }) : null;
}

function normalizeSeedRefs(raw) {
  if (!isObj(raw)) return null;
  const clean = (records) => Object.fromEntries(Object.entries(isObj(records) ? records : {}).filter(([key, id]) => validId(key) && validId(id)).slice(0, 100));
  return { encounters: clean(raw.encounters), maps: clean(raw.maps) };
}

function normalizeRef(r) {
  if (!isObj(r) || !REF_KINDS.includes(r.kind) || typeof r.id !== 'string' || !ID_RE.test(r.id)) return null;
  return { kind: r.kind, id: r.id };
}

function normalizeItem(it) {
  if (!isObj(it) || typeof it.id !== 'string' || !ID_RE.test(it.id)) return null;
  return {
    id: it.id,
    title: cleanText(it.title, MAX_TITLE),
    text: cleanText(it.text),
    done: it.done === true,
    pin: it.pin === true,
    ref: normalizeRef(it.ref),
    links: (Array.isArray(it.links) ? it.links : []).map(normalizeRef).filter(Boolean).slice(0, MAX_LINKS),
  };
}
function linksArg(v) {
  if (!Array.isArray(v)) throw bad('links must be an array of { kind, id }');
  const out = [];
  for (const l of v.slice(0, MAX_LINKS)) {
    const r = normalizeRef(l);
    if (!r) throw bad(`links: { kind: ${REF_KINDS.join('|')}, id }`);
    if (!out.some((x) => x.kind === r.kind && x.id === r.id)) out.push(r);
  }
  return out;
}

/** Sections that take monsters also take prepared encounters (older saves and pack templates). */
function withEncounters(kinds) {
  return kinds.includes('monster') && !kinds.includes('encounter') ? ['encounter', ...kinds] : kinds;
}

function normalizeSection(s) {
  if (!isObj(s) || typeof s.key !== 'string' || !KEY_RE.test(s.key)) return null;
  return {
    key: s.key,
    label: cleanText(s.label, 60) || s.key,
    kind: SECTION_KINDS.includes(s.kind) ? s.kind : 'text',
    hint: cleanText(s.hint, 300),
    carry: s.carry === true,
    refKinds: withEncounters(Array.isArray(s.refKinds) ? s.refKinds.filter((k) => REF_KINDS.includes(k)) : []),
    hidden: s.hidden === true,
    text: cleanText(s.text),
    items: (Array.isArray(s.items) ? s.items : []).map(normalizeItem).filter(Boolean).slice(0, MAX_ITEMS),
  };
}

function normalizeDoc(d) {
  if (!isObj(d) || typeof d.id !== 'string' || !ID_RE.test(d.id) || !DOC_TYPES.includes(d.type)) return null;
  const keys = new Set();
  const sections = [];
  for (const s of Array.isArray(d.sections) ? d.sections : []) {
    const n = normalizeSection(s);
    if (!n || keys.has(n.key)) continue;
    keys.add(n.key);
    sections.push(n);
  }
  const doc = {
    id: d.id,
    type: d.type,
    template: typeof d.template === 'string' ? d.template.slice(0, 40) : '',
    title: cleanText(d.title, MAX_TITLE) || (d.type === 'session' ? 'Session' : 'Adventure'),
    adventureId: typeof d.adventureId === 'string' && ID_RE.test(d.adventureId) ? d.adventureId : null,
    createdAt: Number.isFinite(d.createdAt) ? d.createdAt : 0,
    sections: sections.slice(0, MAX_SECTIONS),
  };
  if (doc.type === 'session') {
    const evening = normalizeEvening(d.evening) ?? legacyEvening(doc);
    if (evening) doc.evening = evening;
  } else {
    const seedRefs = normalizeSeedRefs(d.seedRefs);
    if (seedRefs) doc.seedRefs = seedRefs;
  }
  return doc;
}

export function normalizePrep(raw) {
  if (!isObj(raw)) return initPrep();
  const docs = (Array.isArray(raw.docs) ? raw.docs : []).map(normalizeDoc).filter(Boolean).slice(0, MAX_DOCS);
  const ids = new Set(docs.map((d) => d.id));
  for (const d of docs) if (d.adventureId && !ids.has(d.adventureId)) d.adventureId = null;
  const current = typeof raw.current === 'string' && docs.some((d) => d.id === raw.current && d.type === 'session') ? raw.current : null;
  return { docs, current };
}

/** GM-only projection (prep holds secrets: never sent to players or the TV). */
export function prepView(state, pack) {
  const p = state.prep ?? initPrep();
  const adventures = compatibleAdventures(pack);
  return {
    docs: p.docs.map((d) => d.type === 'session' && !d.evening ? { ...d, evening: legacyEvening(d) } : d),
    current: p.current,
    adventures: adventures.map(({ id, title }) => ({ id, title })),
    evenings: adventures.flatMap((a) => (a.evenings ?? []).map(({ key, title, floor }) => ({ adventureId: a.id, key, title, floor }))),
    reach: withinReach(p, 8, state.prepCards),
    templates: templatesFor(pack).map(({ id, label, scope, desc, sections }) => ({ id, label, scope, desc: desc ?? '', sections })),
    defaults: { adventure: defaultTemplate(pack, 'adventure'), session: defaultTemplate(pack, 'session') },
  };
}

function compatibleAdventures(pack) {
  return (pack.prep?.adventures ?? []).filter((d) => !d.families || d.families.includes(pack.ruleset.system.family));
}

/** Copies the pack's prepared scenes, maps and encounter cards without touching the live fight. */
export function loadPreparedAdventure(st, a, ctx, out, saveEncounter) {
  const seed = compatibleAdventures(ctx.pack).find((d) => d.id === a.id);
  if (!seed) throw notFound(`no prepared adventure ${a.id}`);
  const prep = ensurePrep(st);
  const existing = prep.docs.find((d) => d.type === 'adventure' && d.template === seed.id);
  if (existing) { out.result = { id: existing.id, existing: true }; out.changed = false; return; }
  checkRoom(prep);
  const library = libraryOf(st, ctx.pack);
  const maps = new Map();
  const encounters = new Map();
  const requireEntry = (kind, id) => {
    if (!library.get(kind, id)) throw notFound(`prepared adventure ${seed.id} references missing ${kind} ${id}`);
  };
  const requireMap = (id) => {
    if (!maps.has(id)) throw notFound(`no prepared map ${id}`);
    return maps.get(id);
  };
  for (const map of seed.maps ?? []) {
    if (maps.has(map.id)) throw bad(`duplicate prepared map ${map.id}`);
    if (map.zones != null && !Array.isArray(map.zones)) throw bad(`prepared map ${map.id} zones must be an array`);
    const sub = {};
    MAPS_GM['map.add'](st, map, ctx, sub);
    const id = sub.result.id;
    for (const zone of map.zones ?? []) MAPS_GM['map.zone.add'](st, { ...zone, id }, ctx, sub);
    maps.set(map.id, id);
  }
  for (const enc of seed.encounters) {
    if (encounters.has(enc.id)) throw bad(`duplicate prepared encounter ${enc.id}`);
    for (const m of enc.mobs ?? []) requireEntry(m.kind ?? 'monster', m.sourceId);
    for (const it of enc.items ?? []) requireEntry('item', it.id);
    const sub = { ...out, result: undefined };
    const mapId = enc.mapId == null ? undefined : requireMap(enc.mapId);
    saveEncounter(st, { label: enc.label, mobs: enc.mobs, items: enc.items, notes: enc.notes, mapId }, ctx, sub);
    encounters.set(enc.id, sub.result.id);
  }
  const link = (ref) => {
    if (ref.kind === 'map') return { kind: 'map', id: requireMap(ref.id) };
    if (ref.kind === 'encounter') {
      if (!encounters.has(ref.id)) throw notFound(`no prepared encounter ${ref.id}`);
      return { kind: 'encounter', id: encounters.get(ref.id) };
    }
    if (ref.kind === 'loot') {
      if (!ctx.pack.tiersById.has(ref.id)) throw notFound(`no loot tier ${ref.id}`);
    } else requireEntry(ref.kind, ref.id);
    return { ...ref };
  };
  const sections = seed.sections.map((s) => ({ ...s, items: s.items.map((it) => ({ ...it, ref: it.ref ? link(it.ref) : null, links: it.links.map(link) })) }));
  const id = ctx.genId('pa');
  const seedRefs = { encounters: Object.fromEntries(encounters), maps: Object.fromEntries(maps) };
  prep.docs.push({ id, title: seed.title, type: 'adventure', template: seed.id, adventureId: null, createdAt: ctx.now, sections, seedRefs });
  out.result = { id, encounters: encounters.size, ...(maps.size ? { maps: maps.size } : {}) };
}

// ---------- helpers ----------

function title(v, field = 'title') {
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  const t = v.trim();
  if (!t) throw bad(`${field} must not be empty`);
  if (t.length > MAX_TITLE) throw bad(`${field} too long (max ${MAX_TITLE})`);
  return t;
}

function textArg(v, field) {
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  if (v.length > MAX_TEXT) throw bad(`${field} too long (max ${MAX_TEXT})`);
  return v;
}

function docOf(st, id) {
  const d = (st.prep?.docs ?? []).find((x) => x.id === id);
  if (!d) throw notFound(`no prep doc ${id}`);
  return d;
}

function sectionOf(doc, key) {
  const s = doc.sections.find((x) => x.key === key);
  if (!s) throw notFound(`no section ${key} in ${doc.id}`);
  return s;
}

function itemOf(section, id) {
  const it = section.items.find((x) => x.id === id);
  if (!it) throw notFound(`no item ${id} in ${section.key}`);
  return it;
}

function templateOf(pack, id, scope) {
  const t = templatesFor(pack).find((x) => x.id === id && x.scope === scope);
  if (!t) throw notFound(`no ${scope} template ${id}`);
  return t;
}

function sectionFromDef(def) {
  return {
    key: def.key, label: def.label, kind: def.kind, hint: def.hint ?? '', carry: !!def.carry,
    refKinds: withEncounters(def.refKinds ? [...def.refKinds] : []), hidden: false, text: '', items: [],
  };
}

function ensurePrep(st) {
  if (!st.prep) st.prep = initPrep();
  return st.prep;
}

function checkRoom(p) {
  if (p.docs.length >= MAX_DOCS) throw bad(`max ${MAX_DOCS} prep docs`);
}

function refArg(r, section) {
  const ref = normalizeRef(r);
  if (!ref) throw bad(`ref must be { kind: ${REF_KINDS.join('|')}, id }`);
  if (section.refKinds.length && !section.refKinds.includes(ref.kind)) throw bad(`${section.label} takes ${section.refKinds.join(', ')}`);
  return ref;
}

function ensureEvening(d) {
  if (d.type !== 'session') throw bad('an evening needs a session');
  return d.evening ??= legacyEvening(d) ?? normalizeEvening({});
}

export function getPrepScene(st, id, sceneId) {
  const d = docOf(st, id);
  const scenes = d.evening?.scenes ?? legacyEvening(d)?.scenes ?? [];
  const scene = scenes.find((s) => s.id === sceneId);
  if (!scene) throw notFound(`no prep scene ${sceneId}`);
  return scene;
}

function eveningMinutes(v) {
  if (!Number.isInteger(v) || v < 1 || v > 1440) throw bad('evening minutes must be 1..1440');
  return v;
}

function carryScenes(prev, ctx) {
  const ready = [], loose = [];
  for (const s of (prev?.evening ?? (prev && legacyEvening(prev)))?.scenes ?? []) {
    const secrets = s.secrets.filter((c) => !c.revealed);
    if (s.played) loose.push(...secrets.map((c) => ({ ...c, id: ctx.genId('psec') })));
    else {
      const { lastCombatId, lastEncounterId, ...remaining } = structuredClone(s);
      ready.push({ ...remaining, secrets: structuredClone(secrets) });
    }
  }
  for (let i = 0; i < loose.length; i += MAX_SCENE_ROWS) ready.push({
    id: ctx.genId('psn'), title: 'Loose ends', type: 'explore', minutes: 0, secrets: loose.slice(i, i + MAX_SCENE_ROWS),
  });
  return ready;
}

function legacySeedRef(st, doc, seed, kind, key) {
  const bucket = kind === 'encounter' ? 'encounters' : 'maps';
  const rows = kind === 'encounter' ? (st.prepCards ?? []).filter((c) => c.kind === 'encounter') : st.maps?.list ?? [];
  const recorded = doc.seedRefs?.[bucket];
  if (recorded && Object.hasOwn(recorded, key) && rows.some((r) => r.id === recorded[key])) return recorded[key];
  for (const seedSection of seed.sections) {
    const installed = doc.sections.find((s) => s.key === seedSection.key);
    for (const seedItem of seedSection.items) {
      const item = installed?.items.find((i) => i.id === seedItem.id);
      if (!item) continue;
      const refs = [seedItem.ref, ...seedItem.links];
      const index = refs.findIndex((r) => r?.kind === kind && r.id === key);
      if (index < 0) continue;
      const candidate = [item.ref, ...item.links][index];
      if (candidate?.kind === kind && rows.some((r) => r.id === candidate.id)) return candidate.id;
    }
  }
  const entry = seed[bucket]?.find((r) => r.id === key);
  const exact = rows.filter((r) => kind === 'encounter' ? r.label === entry?.label : r.name === entry?.name);
  return exact.length === 1 ? exact[0].id : null;
}

function installedAdventure(st, seed, ctx, out, GM) {
  const existing = st.prep.docs.find((d) => d.type === 'adventure' && d.template === seed.id);
  if (existing) return existing;
  const sub = { ...out, result: undefined };
  loadPreparedAdventure(st, { id: seed.id }, ctx, sub, GM['enc.save']);
  return docOf(st, sub.result.id);
}

function scenePreset(type, ctx, title, extra = {}) {
  const check = SCENE_CHECKS[type];
  const family = ctx.pack.ruleset.system.family;
  const checks = check ? [{
    id: ctx.genId('pchk'), label: check.label,
    statId: check.stat.find((id) => ctx.pack.ruleset.stats.some((s) => s.id === id)),
    dcType: family === 'crawler' ? check.dcType : 'fixed',
    dc: family === 'pf2e' ? Math.max(15, check.dc) : check.dc,
  }] : [];
  return { id: ctx.genId('psn'), type, title, goal: SCENE_GOALS[type], checks, ...extra };
}

function startingScenes(ctx) {
  if (ctx.pack.ruleset.system.family === 'crawler') return [{ id: ctx.genId('psn'), title: 'Opening scene', type: 'explore' }];
  return [
    scenePreset('explore', ctx, 'Strong start', { goal: 'Open with an immediate problem and give the party one clear choice.' }),
    scenePreset('talk', ctx, 'A person with leverage'),
    scenePreset('fight', ctx, 'The confrontation'),
    scenePreset('explore', ctx, 'Clues and consequences', { secrets: [{ id: ctx.genId('psec'), text: 'A clue explains who benefits from what happened tonight.' }] }),
  ];
}

function seedLink(st, ctx, out, GM, original, kind, key) {
  if (!key) return null;
  const bucket = kind === 'encounter' ? 'encounters' : 'maps';
  const refers = (seed) => seed[bucket]?.some((e) => e.id === key);
  const owners = refers(original) ? [original] : compatibleAdventures(ctx.pack).filter(refers);
  if (owners.length !== 1) throw bad(`${original.id}: ${kind} reference ${key} needs a unique prepared entry`);
  const seed = owners[0];
  const doc = installedAdventure(st, seed, ctx, out, GM);
  const id = legacySeedRef(st, doc, seed, kind, key);
  // A GM may delete an installed encounter while retaining the original book template.
  if (!id && kind === 'encounter') return null;
  if (!id) throw notFound(`no installed ${kind} ${key}`);
  doc.seedRefs ??= { encounters: {}, maps: {} };
  doc.seedRefs[bucket] = { ...doc.seedRefs[bucket], [key]: id };
  return id;
}

export function planEvening(st, a, ctx, out, GM) {
  const prep = ensurePrep(st);
  checkRoom(prep);
  const prev = prep.docs.find((d) => d.id === prep.current);
  const seed = a.adventureId == null ? null : compatibleAdventures(ctx.pack).find((d) => d.id === a.adventureId);
  if (a.adventureId != null && !seed) throw notFound(`no prepared adventure ${a.adventureId}`);
  if (!seed && a.key != null) throw bad('choose an adventure for that evening');
  const template = seed && (seed.evenings ?? []).find((e) => e.key === a.key);
  if (seed && !template) throw notFound(`no prepared evening ${a.key}`);
  const adventure = seed && installedAdventure(st, seed, ctx, out, GM);
  const minutes = a.minutes === undefined ? 240 : eveningMinutes(a.minutes);
  const copy = !seed || (prev?.adventureId === adventure.id && prev.evening?.sourceKey === template.key);
  const leftovers = carryScenes(prev, ctx);
  let scenes = leftovers;
  if (template && !copy) {
    scenes = template.scenes.map((s) => ({ ...structuredClone(s), played: false,
      encounterId: seedLink(st, ctx, out, GM, seed, 'encounter', s.encounterId),
      mapId: seedLink(st, ctx, out, GM, seed, 'map', s.mapId),
    }));
    const ids = new Set(scenes.map((s) => s.id));
    for (const scene of leftovers) {
      let id = scene.id;
      while (ids.has(id)) id = ctx.genId('psn');
      ids.add(id);
      scenes.push({ ...scene, id });
    }
  }
  if (scenes.length > MAX_SCENES) throw bad(`the template and carryover exceed ${MAX_SCENES} scenes`);
  if (!scenes.length) scenes = startingScenes(ctx);
  const sub = { ...out, result: undefined };
  PREP_GM['prep.session.add'](st, { title: a.title ?? template?.title, ...(adventure ? { adventureId: adventure.id } : {}) }, ctx, sub);
  const doc = docOf(st, sub.result.id);
  doc.evening = normalizeEvening({ minutes, scenes, sourceKey: template?.key ?? prev?.evening?.sourceKey });
  out.result = { id: doc.id, sceneId: doc.evening.activeSceneId };
}

function encounterOf(st, id) {
  return (st.prepCards ?? []).find((c) => c.id === id && c.kind === 'encounter');
}

export function runPrepScene(st, a, ctx, out, GM) {
  const d = docOf(st, a.id);
  const evening = ensureEvening(d);
  const scene = getPrepScene(st, a.id, a.sceneId);
  const encounter = scene.encounterId && encounterOf(st, scene.encounterId);
  if (scene.encounterId && !encounter) throw notFound(`no encounter ${scene.encounterId}`);
  const mapId = scene.mapId ?? encounter?.payload?.mapId ?? null;
  if (mapId && !st.maps?.list.some((m) => m.id === mapId)) throw notFound(`no map ${mapId}`);
  const result = { id: d.id, sceneId: scene.id, encounterId: encounter?.id ?? null, mapId };
  if (a.fight === true && !encounter) throw bad('link an encounter before running combat');
  if (encounter && (a.fight === true || ['fight', 'boss'].includes(scene.type))) {
    if (st.combat?.active && scene.lastCombatId === st.combat.id) {
      if (scene.lastEncounterId && scene.lastEncounterId !== encounter.id) throw bad('end the current combat before starting the changed encounter');
      Object.assign(result, { combatId: st.combat.id, mapId: st.combat.mapId ?? null, existing: true });
    }
    else {
      if (st.combat?.active) throw bad('end the current combat before starting this scene');
      if (st.combat?.combatants.some((m) => m.type === 'mob')) throw bad('clear the queued mobs before starting this scene');
      const lib = libraryOf(st, ctx.pack);
      for (const m of encounter.payload?.mobs ?? []) {
        const kind = m.kind ?? 'monster';
        if (!lib.get(kind, m.sourceId)) throw notFound(`no ${kind} ${m.sourceId}`);
      }
      const sub = { ...out, result: undefined };
      GM['enc.run'](st, { id: encounter.id, mapId, start: true }, ctx, sub);
      scene.lastCombatId = st.combat.id;
      scene.lastEncounterId = encounter.id;
      result.combatId = st.combat.id;
    }
  }
  if (result.existing && evening.activeSceneId === scene.id && st.prep.current === d.id && scene.played) out.changed = false;
  evening.activeSceneId = scene.id;
  st.prep.current = d.id;
  scene.played = true;
  out.result = result;
}

export function editPrepEncounter(st, a, ctx, out, GM) {
  ensureEvening(docOf(st, a.id));
  const scene = getPrepScene(st, a.id, a.sceneId);
  const before = scene.encounterId ? encounterOf(st, scene.encounterId) : null;
  const prior = before?.payload;
  if ([a.add, a.mobs, a.change].filter((v) => v !== undefined).length > 1) throw bad('send add, mobs or change');
  const mobs = a.mobs ?? structuredClone(prior?.mobs ?? []);
  if (a.add !== undefined) {
    const { kind = 'monster', sourceId } = a.add ?? {};
    if (!['monster', 'boss'].includes(kind) || !validId(sourceId)) throw bad('select a monster or boss');
    if (!libraryOf(st, ctx.pack).get(kind, sourceId)) throw notFound(`no ${kind} ${sourceId}`);
    const existing = mobs.find((m) => (m.kind ?? 'monster') === kind && m.sourceId === sourceId && m.hidden !== false);
    if (existing) existing.count = (existing.count ?? 1) + 1;
    else mobs.push({ kind, sourceId, count: 1, hidden: true });
  }
  if (a.change !== undefined) {
    const { index, kind, sourceId, delta, hidden, remove } = a.change ?? {};
    const row = Number.isInteger(index) && mobs[index];
    if (!row || (row.kind ?? 'monster') !== kind || row.sourceId !== sourceId) throw bad('that encounter row changed');
    if (remove === true) mobs.splice(index, 1);
    else {
      if (delta !== undefined) {
        if (![-1, 1].includes(delta)) throw bad('count change must be −1 or +1');
        row.count = Math.max(1, (row.count ?? 1) + delta);
      }
      if (hidden !== undefined) {
        if (typeof hidden !== 'boolean') throw bad('hidden must be true or false');
        row.hidden = hidden;
      }
    }
  }
  const mapId = a.mapId === undefined ? scene.mapId ?? prior?.mapId : a.mapId;
  const sub = { ...out, result: undefined };
  GM['enc.save'](st, { id: before?.id, label: before?.label ?? scene.title, mobs, mapId, notes: prior?.notes }, ctx, sub);
  scene.encounterId = sub.result.id;
  if (a.mapId !== undefined) scene.mapId = validId(a.mapId);
  out.result = { id: a.id, sceneId: scene.id, encounterId: scene.encounterId, mapId: mapId ?? null };
}

export function addSceneNpc(st, a, ctx, out, GM) {
  ensureEvening(docOf(st, a.id));
  const scene = getPrepScene(st, a.id, a.sceneId);
  if (scene.npcs.length >= MAX_SCENE_ROWS) throw bad(`max ${MAX_SCENE_ROWS} NPCs per scene`);
  const name = title(a.name, 'NPC name');
  const sub = { ...out, result: undefined };
  const voice = optionalText(a.voice, 600);
  GM['lib.upsert'](st, { kind: 'npc', entry: { name, personality: optionalText(a.motive, 1200), voice, intro: voice } }, ctx, sub);
  scene.npcs.push(sub.result.id);
  out.result = { id: a.id, sceneId: scene.id, npcId: sub.result.id };
}

// ---------- GM actions ----------

export const PREP_GM = {
  'prep.evening.update'(st, a) {
    const d = docOf(st, a.id);
    const evening = ensureEvening(d);
    if (a.title !== undefined) d.title = title(a.title);
    if (a.minutes !== undefined) evening.minutes = eveningMinutes(a.minutes);
  },

  'prep.scene.add'(st, a, ctx, out) {
    const evening = ensureEvening(docOf(st, a.id));
    if (!SCENE_TYPES.includes(a.type)) throw bad(`type must be one of ${SCENE_TYPES.join(', ')}`);
    if (evening.scenes.length >= MAX_SCENES) throw bad(`max ${MAX_SCENES} scenes per evening`);
    const scene = normalizeEveningScene(scenePreset(a.type, ctx, `${a.type[0].toUpperCase()}${a.type.slice(1)} scene`), evening.scenes.length);
    evening.scenes.push(scene);
    evening.activeSceneId ??= scene.id;
    out.result = { sceneId: scene.id };
  },

  'prep.scene.update'(st, a, ctx) {
    const evening = ensureEvening(docOf(st, a.id));
    const scene = getPrepScene(st, a.id, a.sceneId);
    if (!isObj(a.patch)) throw bad('scene patch must be an object');
    const p = a.patch;
    const next = { ...scene };
    if (p.title !== undefined) next.title = title(p.title);
    if (p.type !== undefined) {
      if (!SCENE_TYPES.includes(p.type)) throw bad(`type must be one of ${SCENE_TYPES.join(', ')}`);
      next.type = p.type;
    }
    if (p.minutes !== undefined) {
      if (!Number.isInteger(p.minutes) || p.minutes < 0 || p.minutes > 1440) throw bad('scene minutes must be 0..1440');
      next.minutes = p.minutes;
    }
    for (const field of ['goal', 'readAloud', 'notes']) if (p[field] !== undefined) next[field] = textArg(p[field], field);
    for (const [field, exists] of [
      ['encounterId', (id) => encounterOf(st, id)], ['mapId', (id) => st.maps?.list.some((m) => m.id === id)],
    ]) if (p[field] !== undefined) {
      if (p[field] == null || p[field] === '') next[field] = null;
      else if (!validId(p[field]) || !exists(p[field])) throw notFound(`no valid ${field} ${p[field]}`);
      else next[field] = p[field];
    }
    const lib = libraryOf(st, ctx.pack);
    for (const [field, kind] of [['npcs', 'npc'], ['items', 'item'], ['checks', null], ['secrets', null]]) if (p[field] !== undefined) {
      if (!Array.isArray(p[field]) || p[field].length > MAX_SCENE_ROWS) throw bad(`${field} must have 0..${MAX_SCENE_ROWS} entries`);
      if (kind && p[field].some((id) => !validId(id) || !lib.get(kind, id))) throw bad(`${field} must reference library entries`);
      next[field] = p[field];
    }
    if (p.played !== undefined) {
      if (typeof p.played !== 'boolean') throw bad('played must be true or false');
      next.played = p.played;
    }
    evening.scenes[evening.scenes.indexOf(scene)] = normalizeEveningScene(next);
  },

  'prep.scene.move'(st, a) {
    const evening = ensureEvening(docOf(st, a.id));
    const scene = getPrepScene(st, a.id, a.sceneId);
    if (!Number.isInteger(a.to)) throw bad('scene order must be an integer');
    const to = Math.max(0, Math.min(evening.scenes.length - 1, a.to));
    evening.scenes.splice(evening.scenes.indexOf(scene), 1);
    evening.scenes.splice(to, 0, scene);
  },

  'prep.scene.remove'(st, a) {
    const evening = ensureEvening(docOf(st, a.id));
    const scene = getPrepScene(st, a.id, a.sceneId);
    evening.scenes = evening.scenes.filter((s) => s !== scene);
    if (evening.activeSceneId === scene.id) evening.activeSceneId = evening.scenes.find((s) => !s.played)?.id ?? evening.scenes[0]?.id ?? null;
  },

  /** New adventure from a template: `{ title, template? }` → result `{ id }`. */
  'prep.adventure.add'(st, a, ctx, out) {
    const p = ensurePrep(st);
    checkRoom(p);
    const tpl = templateOf(ctx.pack, a.template ?? defaultTemplate(ctx.pack, 'adventure'), 'adventure');
    const doc = { id: ctx.genId('pa'), type: 'adventure', template: tpl.id, title: title(a.title), adventureId: null, createdAt: ctx.now, sections: tpl.sections.map(sectionFromDef) };
    p.docs.push(doc);
    out.result = { id: doc.id };
  },

  /**
   * New session plan: `{ title?, template?, adventureId?, carryFrom? }`. Unfinished items of `carry`
   * sections are copied from `carryFrom` (default: the current session; the old plan stays as it was).
   * Inherits the previous session's adventure unless `adventureId` is given. Becomes the current session.
   */
  'prep.session.add'(st, a, ctx, out) {
    const p = ensurePrep(st);
    checkRoom(p);
    const tpl = templateOf(ctx.pack, a.template ?? defaultTemplate(ctx.pack, 'session'), 'session');
    let adventureId = null;
    if (a.adventureId != null) adventureId = docOf(st, a.adventureId).type === 'adventure' ? a.adventureId : null;
    const prev = a.carryFrom ? docOf(st, a.carryFrom) : (p.current ? docOf(st, p.current) : null);
    if (!adventureId && prev?.adventureId && a.adventureId === undefined) adventureId = prev.adventureId;
    const n = p.docs.filter((d) => d.type === 'session').length + 1;
    const doc = {
      id: ctx.genId('ps'), type: 'session', template: tpl.id,
      title: a.title != null ? title(a.title) : `Session ${n}`,
      adventureId, createdAt: ctx.now, sections: tpl.sections.map(sectionFromDef),
    };
    let carried = 0;
    if (prev) {
      for (const s of doc.sections) {
        if (!s.carry) continue;
        const old = prev.sections.find((x) => x.key === s.key && x.kind === s.kind);
        for (const it of old?.items ?? []) {
          if (it.done || s.items.length >= MAX_ITEMS) continue;
          s.items.push({ ...structuredClone(it), id: ctx.genId('pi') });
          carried++;
        }
      }
      if (prev.evening) {
        const scenes = carryScenes(prev, ctx);
        doc.evening = normalizeEvening({ minutes: prev.evening.minutes, scenes, sourceKey: prev.evening.sourceKey });
      }
    }
    p.docs.push(doc);
    p.current = doc.id;
    out.result = { id: doc.id, carried };
  },

  'prep.session.current'(st, a) {
    const p = ensurePrep(st);
    if (a.id === null) { p.current = null; return; }
    const d = docOf(st, a.id);
    if (d.type !== 'session') throw bad('only a session can be current');
    p.current = d.id;
  },

  /** `{ id, title?, adventureId? }` */
  'prep.doc.update'(st, a) {
    const d = docOf(st, a.id);
    if (a.title !== undefined) d.title = title(a.title);
    if (a.adventureId !== undefined) {
      if (d.type !== 'session') throw bad('only a session links to an adventure');
      if (a.adventureId === null) d.adventureId = null;
      else if (docOf(st, a.adventureId).type !== 'adventure') throw bad('adventureId must be an adventure');
      else d.adventureId = a.adventureId;
    }
  },

  'prep.doc.remove'(st, a) {
    const p = ensurePrep(st);
    const d = docOf(st, a.id);
    p.docs = p.docs.filter((x) => x.id !== d.id);
    for (const x of p.docs) if (x.adventureId === d.id) x.adventureId = null;
    if (p.current === d.id) p.current = [...p.docs].reverse().find((x) => x.type === 'session')?.id ?? null;
  },

  /** Duplicate a doc (a neighbourhood used twice, a session plan as a starting point). */
  'prep.doc.copy'(st, a, ctx, out) {
    const p = ensurePrep(st);
    checkRoom(p);
    const d = docOf(st, a.id);
    const copy = structuredClone(d);
    copy.id = ctx.genId(d.type === 'session' ? 'ps' : 'pa');
    copy.title = `${d.title} (copy)`.slice(0, MAX_TITLE);
    copy.createdAt = ctx.now;
    for (const s of copy.sections) for (const it of s.items) it.id = ctx.genId('pi');
    p.docs.push(copy);
    out.result = { id: copy.id };
  },

  /** `{ id, key, text?, label?, hidden? }` */
  'prep.section.update'(st, a) {
    const s = sectionOf(docOf(st, a.id), a.key);
    if (a.text !== undefined) s.text = textArg(a.text, 'text');
    if (a.label !== undefined) s.label = title(a.label, 'label').slice(0, 60);
    if (a.hidden !== undefined) s.hidden = a.hidden === true;
  },

  /** Extra section on one doc: `{ id, label, kind }` → result `{ key }`. */
  'prep.section.add'(st, a, ctx, out) {
    const d = docOf(st, a.id);
    if (d.sections.length >= MAX_SECTIONS) throw bad(`max ${MAX_SECTIONS} sections`);
    if (!SECTION_KINDS.includes(a.kind)) throw bad(`kind must be one of ${SECTION_KINDS.join(', ')}`);
    const label = title(a.label, 'label').slice(0, 60);
    let key = label.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'section';
    const base = key;
    for (let i = 2; d.sections.some((x) => x.key === key); i++) key = `${base}_${i}`;
    d.sections.push({ key, label, kind: a.kind, hint: '', carry: a.carry === true, refKinds: [], hidden: false, text: '', items: [] });
    out.result = { key };
  },

  /** Removes a section the GM added (template sections can only be hidden). */
  'prep.section.remove'(st, a, ctx) {
    const d = docOf(st, a.id);
    const s = sectionOf(d, a.key);
    const tpl = templatesFor(ctx.pack).find((t) => t.id === d.template);
    if (tpl?.sections.some((x) => x.key === s.key)) throw bad('template sections can be hidden, not removed');
    d.sections = d.sections.filter((x) => x !== s);
  },

  /** `{ id, key, title?, text?, ref?, pin? }` → result `{ itemId }` */
  'prep.item.add'(st, a, ctx, out) {
    const s = sectionOf(docOf(st, a.id), a.key);
    if (s.kind === 'text') throw bad('a text section has no items');
    if (s.items.length >= MAX_ITEMS) throw bad(`max ${MAX_ITEMS} items`);
    const it = { id: ctx.genId('pi'), title: '', text: '', done: false, pin: a.pin === true, ref: null, links: [] };
    if (a.links !== undefined) it.links = linksArg(a.links);
    if (s.kind === 'refs') {
      it.ref = refArg(a.ref, s);
      if (s.items.some((x) => x.ref?.kind === it.ref.kind && x.ref?.id === it.ref.id)) throw bad('already linked');
      if (a.text !== undefined) it.text = textArg(a.text, 'text');
    } else {
      if (a.title !== undefined) it.title = cleanText(a.title, MAX_TITLE).trim();
      if (a.text !== undefined) it.text = textArg(a.text, 'text');
      if (!it.title && !it.text.trim()) throw bad('title or text required');
      if (a.ref !== undefined && a.ref !== null) it.ref = refArg(a.ref, { refKinds: [], label: s.label });
    }
    s.items.push(it);
    out.result = { itemId: it.id };
  },

  /** `{ id, key, itemId, title?, text?, done?, pin?, ref? }` */
  'prep.item.update'(st, a) {
    const s = sectionOf(docOf(st, a.id), a.key);
    const it = itemOf(s, a.itemId);
    if (a.title !== undefined) it.title = cleanText(a.title, MAX_TITLE);
    if (a.text !== undefined) it.text = textArg(a.text, 'text');
    if (a.done !== undefined) it.done = a.done === true;
    if (a.pin !== undefined) it.pin = a.pin === true;
    if (a.ref !== undefined) it.ref = a.ref === null ? null : refArg(a.ref, s.kind === 'refs' ? s : { refKinds: [], label: s.label });
    if (a.links !== undefined) it.links = linksArg(a.links);
  },

  'prep.item.remove'(st, a) {
    const s = sectionOf(docOf(st, a.id), a.key);
    itemOf(s, a.itemId);
    s.items = s.items.filter((x) => x.id !== a.itemId);
  },

  /** `{ id, key, itemId, to }` — new index inside the section. */
  'prep.item.move'(st, a) {
    const s = sectionOf(docOf(st, a.id), a.key);
    const i = s.items.findIndex((x) => x.id === a.itemId);
    if (i < 0) throw notFound(`no item ${a.itemId}`);
    if (!Number.isInteger(a.to)) throw bad('to must be an integer');
    const to = Math.max(0, Math.min(s.items.length - 1, a.to));
    const [it] = s.items.splice(i, 1);
    s.items.splice(to, 0, it);
  },
};

/** Pinned items of the current session and its adventure: what the Show tab offers "within reach". */
export function withinReach(prep, max = 8, cards = []) {
  const p = prep ?? initPrep();
  const cur = p.docs.find((d) => d.id === p.current);
  if (!cur) return [];
  const adv = cur.adventureId ? p.docs.find((d) => d.id === cur.adventureId) : null;
  const out = [];
  const active = cur.evening?.scenes.find((s) => s.id === cur.evening.activeSceneId);
  if (active) {
    const encounter = cards.find((c) => c.kind === 'encounter' && c.id === active.encounterId);
    const mapId = active.mapId ?? encounter?.payload?.mapId;
    const items = [...new Set([...active.items, ...(encounter?.payload?.items ?? []).filter((it) => !it.given).map((it) => it.id)])];
    const links = [
      active.encounterId && { kind: 'encounter', id: active.encounterId }, mapId && { kind: 'map', id: mapId },
      ...active.npcs.map((id) => ({ kind: 'npc', id })), ...items.map((id) => ({ kind: 'item', id })),
    ].filter(Boolean);
    out.push({ docId: cur.id, key: 'evening', section: 'Active scene', sceneId: active.id, checks: active.checks,
      item: { id: active.id, title: active.title, text: active.readAloud || active.goal || active.notes, ref: null, links } });
  }
  for (const d of [cur, adv].filter(Boolean)) {
    for (const s of d.sections) {
      if (s.hidden) continue;
      for (const it of s.items) if (it.pin && !it.done) out.push({ docId: d.id, key: s.key, section: s.label, item: it });
    }
  }
  return out.slice(0, max);
}
