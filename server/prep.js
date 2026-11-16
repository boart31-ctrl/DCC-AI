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
//   Item    = { id, title, text, done, pin, ref: {kind, id}|null }
//
// Section kinds: text (one free text) · list (tick list) · refs (links to library entries / prepared cards)
// · parts (titled chunks: quarters of a neighbourhood, quest stages, scenes; tickable).
// `pin` marks an item for the "Na dosah" (within reach) strip on the Show tab.
//
// Templates: built-in Lazy DM templates for every ruleset; a content pack adds its own in pack.json "prep"
// ({ templates: [{ id, label, scope, families?, sections: [{ key, label, kind, hint?, carry?, refKinds? }] }] }).
// A template with `families` only shows up in campaigns whose ruleset family matches.
import { bad, notFound } from './errors.js';

export const DOC_TYPES = ['adventure', 'session'];
export const SECTION_KINDS = ['text', 'list', 'refs', 'parts'];
export const REF_KINDS = ['monster', 'boss', 'npc', 'location', 'item', 'spell', 'buff', 'card', 'map'];
export const MAX_DOCS = 80;
export const MAX_SECTIONS = 30;
export const MAX_ITEMS = 200;
export const MAX_TEXT = 6000;
export const MAX_TITLE = 120;

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
      sec('monsters', 'Relevant monsters', 'refs', { refKinds: ['monster', 'boss', 'card'] }),
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
      sec('monsters', 'Monsters', 'refs', { refKinds: ['monster', 'boss', 'card'] }),
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
  return { templates };
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
  };
}

function normalizeSection(s) {
  if (!isObj(s) || typeof s.key !== 'string' || !KEY_RE.test(s.key)) return null;
  return {
    key: s.key,
    label: cleanText(s.label, 60) || s.key,
    kind: SECTION_KINDS.includes(s.kind) ? s.kind : 'text',
    hint: cleanText(s.hint, 300),
    carry: s.carry === true,
    refKinds: Array.isArray(s.refKinds) ? s.refKinds.filter((k) => REF_KINDS.includes(k)) : [],
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
  return {
    id: d.id,
    type: d.type,
    template: typeof d.template === 'string' ? d.template.slice(0, 40) : '',
    title: cleanText(d.title, MAX_TITLE) || (d.type === 'session' ? 'Session' : 'Adventure'),
    adventureId: typeof d.adventureId === 'string' && ID_RE.test(d.adventureId) ? d.adventureId : null,
    createdAt: Number.isFinite(d.createdAt) ? d.createdAt : 0,
    sections: sections.slice(0, MAX_SECTIONS),
  };
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
  return {
    docs: p.docs,
    current: p.current,
    templates: templatesFor(pack).map(({ id, label, scope, desc, sections }) => ({ id, label, scope, desc: desc ?? '', sections })),
    defaults: { adventure: defaultTemplate(pack, 'adventure'), session: defaultTemplate(pack, 'session') },
  };
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
    refKinds: def.refKinds ? [...def.refKinds] : [], hidden: false, text: '', items: [],
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

// ---------- GM actions ----------

export const PREP_GM = {
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
    const it = { id: ctx.genId('pi'), title: '', text: '', done: false, pin: a.pin === true, ref: null };
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
export function withinReach(prep, max = 8) {
  const p = prep ?? initPrep();
  const cur = p.docs.find((d) => d.id === p.current);
  if (!cur) return [];
  const adv = cur.adventureId ? p.docs.find((d) => d.id === cur.adventureId) : null;
  const out = [];
  for (const d of [cur, adv].filter(Boolean)) {
    for (const s of d.sections) {
      if (s.hidden) continue;
      for (const it of s.items) if (it.pin && !it.done) out.push({ docId: d.id, key: s.key, section: s.label, item: it });
    }
  }
  return out.slice(0, max);
}
