// Random tables, names and crowds (B3). The GM never stalls when the players go off-script: one tap = a usable
// result, one more tap makes it real (System card on the TV, private message, NPC saved to the campaign).
//
// Pack file tables.json (all optional):
//   { tables: [{ id, name, group?, die?, rows, scope?: { scenes?: [...], floors?: [...] }, origin? }],
//     names:  [{ id, name, patterns?: ['{first} {last}'], first: [...], last?: [...] }],
//     crowd:  { species?: tableId, look?: tableId, want?: tableId, hook?: tableId,
//               places: [{ id, name, species?, look?, want?, hook? }] } }
// rows: plain strings (equal chance, die = d<rows>) or { text, range?: [lo, hi], weight?, make?, names? }.
// Row text: {2d6} is rolled in place, [[table_id]] rolls a nested table (depth ≤ 3), {name} {species} {place} are
// filled for crowd people. A species row may say which name list fits it: { text: 'goblin', names: 'goblin' }.
// No repeats: a row rolled in the last NO_REPEAT rolls of the same table is skipped while others are left.
import { bad, notFound } from './errors.js';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_TABLES = 400;
const MAX_ROWS = 200;
const NO_REPEAT = 3;
const MAX_RECENT = 10;
const MAX_KEPT = 60;
export const MAX_CROWD = 6;
const DICE_RE = /\{(\d{1,2})?d(\d{1,3})([+-]\d{1,3})?\}/g;
const NEST_RE = /\[\[([a-z0-9][a-z0-9_-]{0,63})\]\]/g;
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const strs = (v, n, max) => (Array.isArray(v) ? v.map((x) => str(x, n)).filter(Boolean).slice(0, max) : []);

function normRow(r) {
  if (typeof r === 'string') return r.trim() ? { text: r.trim().slice(0, 600) } : null;
  if (!r || typeof r !== 'object') return null;
  const text = str(r.text, 600);
  if (!text) return null;
  const row = { text };
  if (Array.isArray(r.range) && r.range.length === 2 && r.range.every(Number.isInteger) && r.range[0] <= r.range[1]) row.range = [r.range[0], r.range[1]];
  if (Number.isFinite(r.weight) && r.weight > 0) row.weight = Math.min(1000, r.weight);
  const make = str(r.make, 80);
  if (make) row.make = make;
  const names = str(r.names, 64);
  if (names) row.names = names;
  return row;
}

/** One table (pack or campaign). Returns null (with a warning) when unusable. */
export function normalizeTable(raw, warnings = [], where = 'tables.json') {
  if (!raw || typeof raw !== 'object' || !ID_RE.test(raw.id ?? '')) { warnings.push(`${where}: table without a valid id skipped`); return null; }
  const rows = (Array.isArray(raw.rows) ? raw.rows : []).map(normRow).filter(Boolean).slice(0, MAX_ROWS);
  if (!rows.length) { warnings.push(`${where} ${raw.id}: no rows, skipped`); return null; }
  let die;
  if (rows.every((r) => r.range)) {
    const hi = Math.max(...rows.map((r) => r.range[1]));
    die = `d${hi}`;
    const covered = new Set();
    for (const r of rows) for (let i = r.range[0]; i <= r.range[1]; i++) covered.add(i);
    if (covered.size !== hi || Math.min(...rows.map((r) => r.range[0])) !== 1) warnings.push(`${where} ${raw.id}: ranges do not cover 1–${hi} without gaps`);
  } else if (rows.some((r) => r.weight)) die = 'weights';
  else die = `d${rows.length}`;
  const scope = {};
  if (raw.scope && typeof raw.scope === 'object') {
    const scenes = strs(raw.scope.scenes, 20, 10);
    if (scenes.length) scope.scenes = scenes;
    const floors = (Array.isArray(raw.scope.floors) ? raw.scope.floors : []).filter(Number.isInteger).slice(0, 30);
    if (floors.length) scope.floors = floors;
  }
  const t = { id: raw.id, name: str(raw.name, 80) || raw.id, group: str(raw.group, 40) || 'Other', die, rows, scope };
  const desc = str(raw.desc, 300);
  if (desc) t.desc = desc;
  if (/^[a-z0-9_-]{1,40}$/.test(raw.origin ?? '')) t.origin = raw.origin;
  if (raw.hidden === true) t.hidden = true; // building block for crowds / nesting, not listed in the drawer
  return t;
}

function normNames(raw, warnings) {
  if (!raw || typeof raw !== 'object' || !ID_RE.test(raw.id ?? '')) return null;
  const first = strs(raw.first, 40, 400);
  if (!first.length) { warnings.push(`tables.json names ${raw.id}: no first names, skipped`); return null; }
  const last = strs(raw.last, 40, 400);
  const patterns = strs(raw.patterns, 80, 10);
  return { id: raw.id, name: str(raw.name, 60) || raw.id, first, last, patterns: patterns.length ? patterns : [last.length ? '{first} {last}' : '{first}'] };
}

/** Whole tables.json → { tables, names, crowd }. */
export function normalizeTables(raw, warnings = []) {
  const out = { tables: [], names: [], crowd: { places: [], portraits: [] } };
  if (raw == null) return out;
  if (typeof raw !== 'object') { warnings.push('tables.json must be an object'); return out; }
  const seen = new Set();
  for (const t of (Array.isArray(raw.tables) ? raw.tables : []).slice(0, MAX_TABLES)) {
    const n = normalizeTable(t, warnings);
    if (!n) continue;
    if (seen.has(n.id)) { warnings.push(`tables.json: duplicate table ${n.id}`); continue; }
    seen.add(n.id); out.tables.push(n);
  }
  out.names = (Array.isArray(raw.names) ? raw.names : []).map((n) => normNames(n, warnings)).filter(Boolean);
  const c = raw.crowd && typeof raw.crowd === 'object' ? raw.crowd : {};
  for (const k of ['species', 'look', 'want', 'hook']) if (ID_RE.test(c[k] ?? '')) out.crowd[k] = c[k];
  // Portrait pool for crowd people: [{ image: 'crowd/goblin_01.webp', species: 'goblin' }] (images/ in the pack).
  out.crowd.portraits = (Array.isArray(c.portraits) ? c.portraits : []).filter((x) => x && /^[a-z0-9][a-z0-9_/-]{0,80}\.(webp|png|jpg)$/.test(x.image ?? '')).slice(0, 300)
    .map((x) => ({ image: x.image, species: str(x.species, 40).toLowerCase() }));
  out.crowd.places = (Array.isArray(c.places) ? c.places : []).filter((p) => p && ID_RE.test(p.id ?? '')).slice(0, 40).map((p) => {
    const place = { id: p.id, name: str(p.name, 60) || p.id };
    for (const k of ['species', 'look', 'want', 'hook']) if (ID_RE.test(p[k] ?? '')) place[k] = p[k];
    return place;
  });
  const ids = new Set(out.tables.map((t) => t.id));
  for (const t of out.tables) for (const r of t.rows) for (const [, ref] of r.text.matchAll(NEST_RE)) if (!ids.has(ref)) warnings.push(`tables.json ${t.id}: nested [[${ref}]] is not a table`);
  return out;
}

// ---------- rolling ----------

const tablesOf = (st, ctx) => {
  const own = st.tables ?? [];
  const ownIds = new Set(own.map((t) => t.id));
  return [...own, ...(ctx.pack.tables?.tables ?? []).filter((t) => !ownIds.has(t.id))];
};
const findTable = (st, ctx, id) => tablesOf(st, ctx).find((t) => t.id === id) ?? null;

function pickRow(st, ctx, t) {
  const hist = (st.tableHistory ??= {});
  const recent = hist[t.id] ?? [];
  const window = Math.min(NO_REPEAT, t.rows.length - 1);
  const banned = new Set(recent.slice(-window));
  let idx;
  let roll;
  if (t.die === 'weights') {
    const pool = t.rows.map((r, i) => ({ i, w: r.weight ?? 1 })).filter((x) => !banned.has(x.i));
    const total = pool.reduce((s, x) => s + x.w, 0);
    let n = ctx.randInt(Math.max(1, Math.round(total * 100))) / 100;
    for (const x of pool) { if (n < x.w) { idx = x.i; break; } n -= x.w; }
    idx ??= pool.at(-1).i;
    roll = null;
  } else {
    const sides = Number(t.die.slice(1));
    for (let tries = 0; tries < 12; tries++) {
      roll = ctx.randInt(sides) + 1;
      idx = t.rows.findIndex((r, i) => (r.range ? roll >= r.range[0] && roll <= r.range[1] : i === roll - 1));
      if (idx >= 0 && !banned.has(idx)) break;
    }
    if (idx < 0) idx = 0;
  }
  hist[t.id] = [...recent, idx].slice(-NO_REPEAT);
  return { idx, roll };
}

/** Text with {XdY+Z} rolled, [[nested]] tables rolled, {name}/{species}/{place} filled. */
function expand(st, ctx, text, vars, depth) {
  let s = text.replace(DICE_RE, (_, n, d, mod) => {
    let sum = Number(mod ?? 0);
    for (let i = 0; i < Number(n || 1); i++) sum += ctx.randInt(Number(d)) + 1;
    return String(Math.max(0, sum));
  });
  s = s.replace(NEST_RE, (m, id) => {
    const t = depth < 3 ? findTable(st, ctx, id) : null;
    if (!t) return '…';
    const { idx } = pickRow(st, ctx, t);
    return expand(st, ctx, t.rows[idx].text, vars, depth + 1);
  });
  if (vars?.species) s = s.replace(/\b([Aa]) \{species\}/g, (m, a) => `${a}${/^[aeiou]/i.test(vars.species) ? 'n' : ''} {species}`);
  return s.replace(/\{(name|species|place|they)\}/g, (m, k) => vars?.[k] ?? m);
}

/** A random visible table whose scope fits a scene type (pack homebrew first), or null. */
export function tableForScene(st, ctx, sceneType) {
  const fits = tablesOf(st, ctx).filter((t) => !t.hidden && t.scope?.scenes?.includes(sceneType));
  if (!fits.length) return null;
  return fits[ctx.randInt(fits.length)];
}

export function rollTable(st, ctx, id, vars = {}) {
  const t = findTable(st, ctx, id);
  if (!t) throw notFound(`unknown table ${id}`);
  const { idx, roll } = pickRow(st, ctx, t);
  const row = t.rows[idx];
  return { tableId: t.id, table: t.name, die: t.die, roll, row: idx, text: cap(expand(st, ctx, row.text, vars, 0)), make: row.make ?? null, names: row.names ?? null };
}

function nameFrom(st, ctx, listId) {
  const lists = ctx.pack.tables?.names ?? [];
  const L = lists.find((n) => n.id === listId) ?? lists[0];
  if (!L) return 'Someone';
  const any = (arr) => arr[ctx.randInt(arr.length)];
  const pat = any(L.patterns);
  return pat.replace(/\{first\}/g, () => any(L.first)).replace(/\{last\}/g, () => (L.last.length ? any(L.last) : '')).replace(/\s+/g, ' ').trim();
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function sentence(s) {
  const t = s.trim();
  if (!t) return '';
  const c = t[0].toUpperCase() + t.slice(1);
  return /[.!?…"”)]$/.test(c) ? c : `${c}.`;
}

/** One crowd person: name + exactly 3 sentences (look · want right now · hook / line for the GM). */
export function makePerson(st, ctx, place, taken = new Set()) {
  const C = ctx.pack.tables?.crowd ?? {};
  const tab = (k) => place?.[k] ?? C[k] ?? null;
  let species = '';
  let namesId = null;
  if (tab('species') && findTable(st, ctx, tab('species'))) {
    const r = rollTable(st, ctx, tab('species'));
    species = r.text; namesId = r.names;
  }
  let name = nameFrom(st, ctx, namesId);
  const first = (n) => n.split(/[\s-]/)[0];
  for (let i = 0; i < 8 && [...taken].some((t) => first(t) === first(name)); i++) name = nameFrom(st, ctx, namesId);
  const vars = { name, species: species || 'stranger', place: place?.name ?? 'here', they: name };
  const line = (k, fallback) => (tab(k) && findTable(st, ctx, tab(k)) ? sentence(rollTable(st, ctx, tab(k), vars).text) : fallback);
  const pool = C.portraits ?? [];
  const sp = ' ' + species.toLowerCase().replace(/[^a-z0-9-]+/g, ' ') + ' ';
  const fit = pool.filter((x) => x.species && sp.includes(' ' + x.species + ' '));
  const pick = (fit.length ? fit : pool.filter((x) => !x.species));
  const image = pick.length ? `/pack/images/${pick[ctx.randInt(pick.length)].image}` : null;
  return {
    id: ctx.genId('cp'), name, species, ...(image ? { image } : {}),
    lines: [line('look', `${name} is hard to describe.`), line('want', 'They want to be left alone.'), line('hook', 'They know something, but not for free.')],
    npcId: null,
  };
}

function viewTable(t) {
  return { id: t.id, name: t.name, group: t.group, die: t.die, rows: t.rows.length, scope: t.scope, desc: t.desc ?? '', origin: t.origin ?? null, own: !!t.own };
}

/** GM view slice (catalog without rows, current crowd, recent results, kept). */
export function tablesView(st, pack) {
  const own = st.tables ?? [];
  const ownIds = new Set(own.map((t) => t.id));
  const all = [...own.map((t) => ({ ...t, own: true })), ...(pack.tables?.tables ?? []).filter((t) => !ownIds.has(t.id))];
  return {
    catalog: all.filter((t) => !t.hidden).map(viewTable),
    names: (pack.tables?.names ?? []).map((n) => ({ id: n.id, name: n.name })),
    places: (pack.tables?.crowd?.places ?? []).map((p) => ({ id: p.id, name: p.name })),
    crowd: st.crowd ?? null,
    recent: st.tableRecent ?? [],
    kept: st.tableKept ?? [],
  };
}

function pushRecent(st, r) {
  st.tableRecent = [...(st.tableRecent ?? []), r].slice(-MAX_RECENT);
}

/** Save one crowd person as a campaign NPC (library npc, homebrew). Same name = update that NPC (no dupes). */
export function savePerson(st, ctx, out, GM, person, placeName) {
  const existing = (st.library?.npc ?? []).find((n) => n.name.toLowerCase() === person.name.toLowerCase());
  const entry = {
    ...(existing ?? {}),
    ...(existing ? { id: existing.id } : {}),
    name: person.name,
    ...(person.image && !existing?.image ? { image: person.image } : {}),
    role: [person.species, placeName].filter(Boolean).join(' · ').slice(0, 120),
    desc: person.lines.join(' ').slice(0, 2000),
    intro: person.lines[0].slice(0, 600),
    personality: person.lines[1].slice(0, 1200),
    hooks: [person.lines[2].slice(0, 400)],
    tags: [...new Set([...(existing?.tags ?? []), 'campaign', 'met'].concat(placeName ? [placeName.toLowerCase().slice(0, 30)] : []))].slice(0, 20),
  };
  delete entry.source;
  const sub = { ...out, result: undefined };
  GM['lib.upsert'](st, { kind: 'npc', entry }, ctx, sub);
  person.npcId = sub.result.id;
  return sub.result;
}

export const TABLES_GM = {
  /** Roll a table → result card (also in recent). */
  'table.roll'(st, a, ctx, out) {
    if (typeof a.id !== 'string') throw bad('id must be a table id');
    const r = { id: ctx.genId('tr'), at: ctx.now, ...rollTable(st, ctx, a.id) };
    pushRecent(st, r);
    out.result = r;
  },
  /** Five names from a name list (or the first list). */
  'names.roll'(st, a, ctx, out) {
    const n = Number.isInteger(a.n) ? Math.min(10, Math.max(1, a.n)) : 5;
    const lists = ctx.pack.tables?.names ?? [];
    if (!lists.length) throw bad('this pack has no name lists');
    if (a.list != null && !lists.some((l) => l.id === a.list)) throw notFound(`unknown name list ${a.list}`);
    const names = new Set();
    for (let i = 0; i < n * 4 && names.size < n; i++) names.add(nameFrom(st, ctx, a.list ?? lists[0].id));
    out.result = { list: a.list ?? lists[0].id, names: [...names] };
  },
  /** "You're at a party and meet N people": N quick NPCs, 3 sentences each. Replaces the current crowd. */
  'crowd.gen'(st, a, ctx, out) {
    const n = a.n ?? 3;
    if (!Number.isInteger(n) || n < 1 || n > MAX_CROWD) throw bad(`n must be 1–${MAX_CROWD}`);
    const places = ctx.pack.tables?.crowd?.places ?? [];
    const place = a.place == null ? null : places.find((p) => p.id === a.place);
    if (a.place != null && !place) throw notFound(`unknown place ${a.place}`);
    const people = [];
    for (let i = 0; i < n; i++) people.push(makePerson(st, ctx, place, new Set(people.map((p) => p.name))));
    st.crowd = { place: place?.id ?? null, placeName: place?.name ?? '', at: ctx.now, people };
    out.result = { people: people.map((p) => p.id) };
  },
  /** Re-roll one person, keep the rest. */
  'crowd.reroll'(st, a, ctx) {
    const c = st.crowd;
    const i = c?.people.findIndex((p) => p.id === a.id) ?? -1;
    if (i < 0) throw notFound('no such crowd person');
    const place = (ctx.pack.tables?.crowd?.places ?? []).find((p) => p.id === c.place) ?? null;
    c.people[i] = makePerson(st, ctx, place, new Set(c.people.map((p) => p.name)));
  },
  /** Save one person (id) or everyone (all: true) to the campaign NPCs. */
  'crowd.save'(st, a, ctx, out, GM) {
    const c = st.crowd;
    if (!c) throw bad('no crowd to save');
    const who = a.all === true ? c.people : c.people.filter((p) => p.id === a.id);
    if (!who.length) throw notFound('no such crowd person');
    out.result = { npcIds: who.map((p) => savePerson(st, ctx, out, GM, p, c.placeName).id) };
  },
  'crowd.clear'(st) { st.crowd = null; },
  /** Keep a result for tonight (shown in the drawer and the session recap). */
  'table.keep'(st, a, ctx) {
    const text = str(a.text, 800);
    if (!text) throw bad('text required');
    st.tableKept = [...(st.tableKept ?? []), { id: ctx.genId('tk'), at: ctx.now, table: str(a.table, 80), text }].slice(-MAX_KEPT);
  },
};
