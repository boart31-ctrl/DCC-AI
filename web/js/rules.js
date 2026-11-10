// Ruleset helpers for the sheet UIs (no DOM; also importable from Node).
// - a tiny safe formula language (RULESET.md §2): parse, validate, evaluate with a breakdown
// - dice notation helpers (§7)
// - the sheet model: ruleset + raw character + computed numbers, with a fallback for packs and
//   engines that predate rulesets (flat `stats` numbers and `resources`)
// - effect target lists for the homebrew editor (§3)
// The engine is authoritative: when the view carries `computed`, the UI shows it as is. The local
// computation here only fills in for older engines and drives editor previews.

/* ---------------- formulas ---------------- */

const FUNCS = new Set(['floor', 'ceil', 'round', 'min', 'max', 'abs']);

export class FormulaError extends Error {
  constructor(msg, at) { super(msg); this.at = at; }
}

function tokenize(src) {
  const out = [];
  const s = String(src ?? '');
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    const rest = s.slice(i);
    let m;
    if ((m = /^(\d*)d(\d+)(?![\w.])/i.exec(rest))) {
      out.push({ k: 'dice', n: m[1] === '' ? 1 : Number(m[1]), sides: Number(m[2]), text: m[0], at: i });
      i += m[0].length; continue;
    }
    if ((m = /^\d+(\.\d+)?/.exec(rest))) { out.push({ k: 'num', v: Number(m[0]), text: m[0], at: i }); i += m[0].length; continue; }
    if ((m = /^[A-Za-z_][\w]*(\.[\w]+)*/.exec(rest))) { out.push({ k: 'id', v: m[0], text: m[0], at: i }); i += m[0].length; continue; }
    if ('+-*/(),'.includes(c)) { out.push({ k: c, text: c, at: i }); i++; continue; }
    throw new FormulaError(`Unexpected "${c}"`, i);
  }
  return out;
}

/** Parses to an AST: {k:'num'|'id'|'dice'|'neg'|'bin'|'call', ...}. Throws FormulaError. */
export function parseFormula(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (k) => {
    const t = toks[p];
    if (!t || (k && t.k !== k)) throw new FormulaError(t ? `Expected "${k}" but found "${t.text}"` : `Expected "${k}" at the end`, t?.at ?? String(src).length);
    p++;
    return t;
  };
  function expr() {
    let left = term();
    while (peek() && (peek().k === '+' || peek().k === '-')) {
      const op = eat().k;
      left = { k: 'bin', op, a: left, b: term() };
    }
    return left;
  }
  function term() {
    let left = factor();
    while (peek() && (peek().k === '*' || peek().k === '/')) {
      const op = eat().k;
      left = { k: 'bin', op, a: left, b: factor() };
    }
    return left;
  }
  function factor() {
    const t = peek();
    if (!t) throw new FormulaError('Formula ends too early', String(src).length);
    if (t.k === '-') { eat(); return { k: 'neg', a: factor() }; }
    if (t.k === '+') { eat(); return factor(); }
    if (t.k === 'num') { eat(); return { k: 'num', v: t.v }; }
    if (t.k === 'dice') { eat(); return { k: 'dice', n: t.n, sides: t.sides, text: t.text }; }
    if (t.k === '(') { eat('('); const e = expr(); eat(')'); return e; }
    if (t.k === 'id') {
      eat();
      if (peek()?.k === '(') {
        if (!FUNCS.has(t.v)) throw new FormulaError(`Unknown function "${t.v}"`, t.at);
        eat('(');
        const args = [expr()];
        while (peek()?.k === ',') { eat(','); args.push(expr()); }
        eat(')');
        return { k: 'call', f: t.v, args };
      }
      if (FUNCS.has(t.v)) throw new FormulaError(`"${t.v}" needs parentheses`, t.at);
      return { k: 'id', v: t.v };
    }
    throw new FormulaError(`Unexpected "${t.text}"`, t.at);
  }
  if (!toks.length) throw new FormulaError('Empty formula', 0);
  const ast = expr();
  if (p < toks.length) throw new FormulaError(`Unexpected "${toks[p].text}"`, toks[p].at);
  return ast;
}

function walk(ast, fn) {
  fn(ast);
  if (ast.a) walk(ast.a, fn);
  if (ast.b) walk(ast.b, fn);
  for (const x of ast.args || []) walk(x, fn);
}

/** Fills `{stat}` / `{dice}` / `{value}` template placeholders. */
export function fillTemplate(src, vars = {}) {
  return String(src ?? '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null && vars[k] !== '' ? String(vars[k]) : m));
}

/**
 * Validates a formula against known identifiers.
 * @returns {{ok:boolean, error?:string, at?:number, unknown:string[], dice:boolean, ids:string[]}}
 */
export function validateFormula(src, known = null) {
  if (typeof src === 'number') return { ok: true, unknown: [], dice: false, ids: [] };
  try {
    const ast = parseFormula(src);
    const ids = [];
    let dice = false;
    walk(ast, (n) => { if (n.k === 'id') ids.push(n.v); if (n.k === 'dice') dice = true; });
    const unknown = known ? ids.filter((id) => !isKnownId(id, known)) : [];
    return { ok: true, unknown, dice, ids };
  } catch (e) {
    return { ok: false, error: e.message, at: e.at, unknown: [], dice: false, ids: [] };
  }
}

function isKnownId(id, known) {
  if (known.has(id)) return true;
  // buff.<anything> is always legal (an effect target nobody uses yet sums to 0, not an error).
  if (id.startsWith('buff.')) return true;
  return false;
}

/** Set of identifiers a formula may use under this ruleset (for live validation). */
export function knownIdentifiers(rs, extra = []) {
  const k = new Set(['level', 'x', 'skill.rank', 'rank', ...extra]);
  for (const s of rs.stats) {
    k.add(`stat.${s.id}`); k.add(`mod.${s.id}`);
    for (const part of s.parts || []) k.add(`stat.${s.id}.${part}`);
  }
  for (const f of rs.fields) if (f.type === 'number') k.add(`field.${f.id}`);
  for (const t of rs.tracks) { k.add(`track.${t.id}.max`); k.add(`track.${t.id}.cur`); }
  for (const d of rs.derived) { k.add(`buff.${d.id}`); k.add(d.id); }
  for (const s of rs.skills.catalog || []) k.add(`skill.${s.id}.rank`);
  return k;
}

/**
 * Evaluates `src`. `resolve(id)` returns a number, or undefined for unknown identifiers.
 * `expand(id)` may return parts [{label, value, source}] to show instead of one part for that
 * identifier (e.g. buff.evade -> every effect that feeds it).
 * Dice terms add nothing to the value; they are collected in `dice` (e.g. ["1d6"]).
 * @returns {{value:number, parts:Array, warnings:Array, dice:string[], error?:string}}
 */
export function evaluate(src, { resolve, labelOf, expand } = {}) {
  const warnings = [];
  const dice = [];
  if (typeof src === 'number') return { value: src, parts: [{ label: 'Base', value: src, source: 'base' }], warnings, dice };
  let ast;
  try { ast = parseFormula(src); } catch (e) {
    return { value: 0, parts: [], warnings: [{ kind: 'error', msg: e.message }], dice, error: e.message };
  }
  const val = (n) => {
    switch (n.k) {
      case 'num': return n.v;
      case 'dice': dice.push(n.text); return 0;
      case 'neg': return -val(n.a);
      case 'id': {
        const v = resolve ? resolve(n.v) : undefined;
        if (v === undefined || v === null || Number.isNaN(Number(v))) {
          if (!n.v.startsWith('buff.')) warnings.push({ kind: 'unknown', id: n.v, msg: `Unknown "${n.v}" counted as 0` });
          return 0;
        }
        return Number(v);
      }
      case 'bin': {
        const a = val(n.a); const b = val(n.b);
        if (n.op === '+') return a + b;
        if (n.op === '-') return a - b;
        if (n.op === '*') return a * b;
        return b === 0 ? 0 : a / b;
      }
      case 'call': {
        const xs = n.args.map(val);
        if (n.f === 'floor') return Math.floor(xs[0]);
        if (n.f === 'ceil') return Math.ceil(xs[0]);
        if (n.f === 'round') return Math.round(xs[0]);
        if (n.f === 'abs') return Math.abs(xs[0]);
        if (n.f === 'min') return Math.min(...xs);
        if (n.f === 'max') return Math.max(...xs);
        return 0;
      }
      default: return 0;
    }
  };
  // Top-level sum terms become breakdown parts.
  const terms = [];
  const collect = (n, sign) => {
    if (n.k === 'bin' && (n.op === '+' || n.op === '-')) {
      collect(n.a, sign);
      collect(n.b, n.op === '-' ? -sign : sign);
    } else terms.push({ n, sign });
  };
  collect(ast, 1);
  const parts = [];
  let total = 0;
  for (const { n, sign } of terms) {
    const v = sign * val(n);
    total += v;
    if (n.k === 'dice') continue;
    if (n.k === 'id' && expand) {
      const ex = expand(n.v);
      if (ex) { for (const p of ex) parts.push({ ...p, value: sign * p.value }); continue; }
    }
    const label = n.k === 'id' ? (labelOf?.(n.v) || n.v) : n.k === 'num' ? 'Base' : astText(n, labelOf);
    parts.push({ label, value: v, source: n.k === 'num' ? 'base' : 'formula' });
  }
  return { value: round2(total), parts, warnings, dice };
}

function astText(n, labelOf) {
  switch (n.k) {
    case 'num': return String(n.v);
    case 'dice': return n.text;
    case 'id': return labelOf?.(n.v) || n.v;
    case 'neg': return `−${astText(n.a, labelOf)}`;
    case 'bin': return `${astText(n.a, labelOf)} ${n.op === '*' ? '×' : n.op === '/' ? '÷' : n.op} ${astText(n.b, labelOf)}`;
    case 'call': return `${n.f}(${n.args.map((a) => astText(a, labelOf)).join(', ')})`;
    default: return '';
  }
}

const round2 = (x) => Math.round(x * 100) / 100;

/* ---------------- dice ---------------- */

/** "1d6+3" style text from dice terms and a flat bonus. */
export function diceText(dice, bonus) {
  const d = (dice || []).filter(Boolean).join('+');
  const b = Number(bonus) || 0;
  if (!d) return String(b);
  return b ? `${d}${b > 0 ? '+' : '−'}${Math.abs(b)}` : d;
}

/** Rolls dice notation with an optional numeric resolver (local fallback and the mock only). */
export function rollFormula(src, { resolve, labelOf, expand, rng = Math.random } = {}) {
  const ast = (() => { try { return parseFormula(src); } catch { return null; } })();
  if (!ast) return null;
  const rolls = [];
  const res = evaluate(src, { resolve, labelOf, expand });
  walk(ast, (n) => {
    if (n.k !== 'dice') return;
    for (let i = 0; i < Math.min(n.n, 100); i++) rolls.push({ die: n.sides, value: 1 + Math.floor(rng() * n.sides) });
  });
  const diceSum = rolls.reduce((s, r) => s + r.value, 0);
  const single20 = rolls.length === 1 && rolls[0].die === 20;
  return {
    formula: String(src),
    dice: rolls,
    total: res.value + diceSum,
    breakdown: res,
    nat20: single20 && rolls[0].value === 20,
    nat1: single20 && rolls[0].value === 1,
  };
}

/* ---------------- sheet model ---------------- */

const DEFAULT_SLOTS = [
  { id: 'head', label: 'Head', max: 1 }, { id: 'torso', label: 'Torso', max: 1 },
  { id: 'arms', label: 'Arms', max: 1 }, { id: 'hands', label: 'Hands', max: 1 },
  { id: 'legs', label: 'Legs', max: 1 }, { id: 'feet', label: 'Feet', max: 1 },
  { id: 'accessories', label: 'Accessories', max: 10 },
];

/** A ruleset with every key filled in. Packs without ruleset.json get one built from `stats`/`resources`. */
export function normalizeRuleset(pack) {
  const r = pack?.ruleset || null;
  const legacy = !r;
  const stats = (r?.stats || pack?.stats || []).map((s) => ({
    id: s.id, label: s.label || s.id, abbr: s.abbr || String(s.id).toUpperCase().slice(0, 3),
    parts: s.parts || (legacy ? [] : ['value']), default: s.default,
  }));
  const tracks = r?.tracks || (pack?.resources || []).map((x) => ({ id: x.id, label: x.label || x.id, kind: 'pool', default: x.default ?? 0, color: x.color }));
  const skills = r?.skills || {};
  return {
    id: r?.id || pack?.id || 'pack',
    legacy,
    dice: r?.dice || 'd20',
    stats,
    statMod: r?.statMod || null,
    derived: r?.derived || [],
    fields: r?.fields || [],
    tracks,
    slots: r?.slots || (legacy ? [] : DEFAULT_SLOTS),
    buffSlots: r?.buffSlots || {},
    hotlist: r?.hotlist || { size: 0 },
    skills: {
      columns: skills.columns || ['rank', 'stat', 'checkType'],
      rankMax: skills.rankMax ?? 15,
      checkTypes: skills.checkTypes || ['Standard'],
      usedTracking: skills.usedTracking ?? false,
      rankUp: skills.rankUp || null,
      catalog: skills.catalog || [],
    },
    attack: r?.attack || { toHit: 'skill.rank + mod.{stat}', damage: '{dice} + mod.{stat}' },
    spells: r?.spells || { costTrack: tracks.find((t) => /mana|mp/i.test(t.id))?.id || null },
    identity: r?.identity || ['name', 'race', 'class', 'level'],
    storyFields: r?.storyFields || [],
    races: r?.races || [], classes: r?.classes || [], backgrounds: r?.backgrounds || [],
    combat: r?.combat || null,
  };
}

/** Library lookup over whatever shape the view carries. */
export function libraryOf(view) {
  const src = view?.library || view?.gm?.library || view?.pack?.library || {};
  if (view && view.__libCache?.src === src) return view.__libCache.out;
  const out = {};
  for (const kind of ['item', 'spell', 'skill', 'buff', 'feature', 'race', 'class', 'background']) {
    const v = src[kind] || src[`${kind}s`] || (kind === 'class' ? src.classes : null) || [];
    out[kind] = Array.isArray(v) ? v : Object.values(v);
  }
  // Older engines: the pack item catalog stands in for the item library.
  if (!out.item.length && view?.gm?.itemsCatalog?.length) out.item = view.gm.itemsCatalog.map((x) => ({ source: 'pack', ...x }));
  try { Object.defineProperty(view, '__libCache', { value: { src, out }, enumerable: false, configurable: true }); } catch {}
  return out;
}

export function libGet(lib, kind, id) {
  if (!id) return null;
  return lib[kind]?.find((e) => e.id === id) || null;
}

/** Turns a legacy player (flat stats, resources, inventory with inline item data) into a v2 character. */
export function legacySheet(p, rs) {
  const stats = {};
  for (const s of rs.stats) {
    const v = p.stats?.[s.id];
    stats[s.id] = typeof v === 'object' && v ? v : { value: v ?? s.default ?? 0 };
  }
  const tracks = {};
  for (const t of rs.tracks) tracks[t.id] = p.resources?.[t.id] || p.tracks?.[t.id] || { cur: t.default ?? 0, max: t.default ?? 0 };
  return {
    identity: { race: p.race || '', class: p.klass || '', title: p.title || '' },
    stats, fields: {}, tracks, skills: [], attacks: [], spells: [],
    inventory: (p.inventory || []).map((it) => ({ ...it, qty: it.qty ?? 1, equippedSlot: it.equippedSlot ?? null })),
    hotlist: [], buffs: [], story: { notes: p.notes || '' }, portrait: null,
  };
}

/** Everything a sheet renders, for one player entry of the view. */
export function sheetModel(view, player) {
  const rs = normalizeRuleset(view?.pack);
  const lib = libraryOf(view);
  for (const k of ['races', 'classes', 'backgrounds']) {
    const kind = k === 'races' ? 'race' : k === 'classes' ? 'class' : 'background';
    rs[k] = rs[k].map((x) => (typeof x === 'string' ? (lib[kind].find((e) => e.id === x) || { id: x, name: x }) : x));
    if (!rs[k].length && lib[kind].length) rs[k] = lib[kind];
  }
  if (!rs.skills.catalog.length && lib.skill.length) rs.skills.catalog = lib.skill;
  const legacy = !player?.sheet;
  const sheet = player?.sheet || legacySheet(player || {}, rs);
  const computed = player?.sheet?.computed || player?.computed || computeSheet(rs, sheet, lib, { level: player?.level });
  return { rs, lib, sheet, computed, legacy, local: !(player?.sheet?.computed || player?.computed) };
}

/** Item data for an inventory entry: library entry merged under per-copy fields. */
export function itemOf(lib, inv) {
  const base = libGet(lib, 'item', inv?.itemId) || {};
  return { ...base, ...pick(inv, ['name', 'desc', 'flavor', 'rarity', 'image', 'effects', 'slot', 'attack']), uid: inv?.uid, itemId: inv?.itemId };
}
function pick(o, keys) {
  const out = {};
  for (const k of keys) if (o?.[k] !== undefined && o[k] !== null && o[k] !== '') out[k] = o[k];
  return out;
}

/* ---------------- local computation (fallback + previews + mock) ---------------- */

/** Every active effect on a character, with where it comes from. */
export function activeEffects(rs, sheet, lib) {
  const out = [];
  const push = (effs, source, label, kind) => {
    for (const e of effs || []) if (e && e.target) out.push({ ...e, from: label || e.label || source, source: kind });
  };
  const hot = new Set((sheet.hotlist || []).filter(Boolean));
  for (const inv of sheet.inventory || []) {
    const it = itemOf(lib, inv);
    for (const e of it.effects || []) {
      const when = e.when || 'equipped';
      const on = when === 'always' || (when === 'carried') || (when === 'equipped' && (inv.equippedSlot || (inv.hotEquipped && hot.has(inv.uid))));
      if (on) out.push({ ...e, from: it.name || 'Item', source: 'item' });
    }
  }
  for (const b of sheet.buffs || []) {
    const def = libGet(lib, 'buff', b.buffId) || {};
    push(b.effects?.length ? b.effects : def.effects, 'buff', b.name || def.name, b.external || def.external ? 'external' : 'buff');
  }
  for (const s of sheet.spells || []) {
    if (!s.active) continue;
    const def = libGet(lib, 'spell', s.spellId) || {};
    push((def.effects || []).filter((e) => (e.when || 'active') === 'active'), 'spell', def.name || 'Spell', 'spell');
  }
  for (const kind of ['race', 'class', 'background']) {
    const key = kind === 'class' ? 'class' : kind;
    const name = sheet.identity?.[key];
    const def = lib[kind]?.find((x) => x.id === name || x.name === name);
    if (!def) continue;
    push(def.statBonuses, kind, def.name, 'feature');
    for (const fid of def.features || []) {
      const f = libGet(lib, 'feature', fid);
      if (f) push(f.effects, 'feature', f.name, 'feature');
    }
  }
  push(sheet.modifiers, 'gm', 'GM', 'gm');
  return out;
}

/** computed per RULESET §5, from raw data. */
export function computeSheet(rs, sheet, lib = {}, { level } = {}) {
  const effects = activeEffects(rs, sheet, lib);
  const warnings = [];
  const lvl = Number(sheet.identity?.level ?? level ?? 1) || 1;
  const byTarget = (t) => effects.filter((e) => normTarget(e.target) === t);
  const from = rs.statMod?.from || rs.stats[0]?.parts?.[0] || 'value';
  const ctx = {};
  const effVal = (e) => (typeof e.value === 'number' ? e.value : evaluate(e.value, { resolve: (id) => base(id) }).value);
  const sumParts = (t) => byTarget(t).filter((e) => e.op !== 'set').map((e) => ({ label: e.from, value: effVal(e), source: e.source }));
  const setOf = (t) => [...byTarget(t)].reverse().find((e) => e.op === 'set');

  const statVal = (id, part) => {
    const raw = sheet.stats?.[id];
    if (raw == null) return undefined;
    if (typeof raw === 'number') return raw;
    const p = part || from;
    const v = raw[p] ?? raw.value ?? raw[Object.keys(raw)[0]];
    return (Number(v) || 0) + (part ? 0 : sumParts(`stat.${id}`).reduce((s, x) => s + x.value, 0));
  };
  const modOf = (id) => {
    const x = statVal(id);
    if (x === undefined) return undefined;
    const baseMod = rs.statMod ? evaluate(rs.statMod.formula, { resolve: (n) => (n === 'x' ? x : undefined) }).value : x;
    return baseMod + sumParts(`mod.${id}`).reduce((s, p) => s + p.value, 0);
  };
  function base(id) {
    if (id === 'level') return lvl;
    let m;
    if ((m = /^stat\.(\w+)(?:\.(\w+))?$/.exec(id))) return statVal(m[1], m[2]);
    if ((m = /^mod\.(\w+)$/.exec(id))) return modOf(m[1]);
    if ((m = /^field\.(\w+)$/.exec(id))) {
      const f = rs.fields.find((x) => x.id === m[1]);
      const v = sheet.fields?.[m[1]] ?? f?.default;
      return v === undefined ? (f ? 0 : undefined) : (Number(v) || 0) + sumParts(`field.${m[1]}`).reduce((s, p) => s + p.value, 0);
    }
    if ((m = /^buff\.(.+)$/.exec(id))) return sumParts(m[1]).reduce((s, p) => s + p.value, 0);
    if ((m = /^skill\.(\w+)\.rank$/.exec(id))) {
      const s = (sheet.skills || []).find((x) => x.skillId === m[1] || x.uid === m[1]);
      return s ? Number(s.rank) || 0 : 0;
    }
    if ((m = /^track\.(\w+)\.(max|cur)$/.exec(id))) return Number(sheet.tracks?.[m[1]]?.[m[2]]) || 0;
    if (ctx[id] !== undefined) return ctx[id];
    if (rs.derived.some((d) => d.id === id)) return derivedVal(id);
    return undefined;
  }
  const labelOf = (id) => {
    let m;
    if ((m = /^mod\.(\w+)$/.exec(id))) return `${rs.stats.find((s) => s.id === m[1])?.abbr || m[1]} mod`;
    if ((m = /^stat\.(\w+)/.exec(id))) return rs.stats.find((s) => s.id === m[1])?.abbr || m[1];
    if ((m = /^field\.(\w+)$/.exec(id))) return rs.fields.find((f) => f.id === m[1])?.label || m[1];
    if ((m = /^track\.(\w+)\.(max|cur)$/.exec(id))) return `${rs.tracks.find((t) => t.id === m[1])?.label || m[1]} ${m[2]}`;
    if (id === 'level') return 'Level';
    if (id === 'skill.rank' || id === 'rank') return 'Skill rank';
    return id;
  };
  const expand = (id) => {
    const m = /^buff\.(.+)$/.exec(id);
    if (!m) return null;
    return sumParts(m[1]);
  };
  const derivedCache = {};
  function derivedVal(id) {
    if (derivedCache[id]) return derivedCache[id].value;
    derivedCache[id] = { value: 0 }; // cycle guard
    const d = rs.derived.find((x) => x.id === id);
    const b = evaluate(d.formula, { resolve: base, labelOf, expand });
    const set = setOf(d.id);
    if (set) { b.value = effVal(set); b.parts = [{ label: `${set.from} (sets)`, value: b.value, source: set.source }]; }
    derivedCache[id] = b;
    return b.value;
  }

  const out = { stats: {}, derived: {}, tracks: {}, attacks: [], skills: [], warnings, effects };
  for (const s of rs.stats) {
    const v = statVal(s.id) ?? 0;
    const modParts = [];
    let mod;
    if (rs.statMod) {
      const raw = evaluate(rs.statMod.formula, { resolve: (n) => (n === 'x' ? v : undefined) }).value;
      modParts.push({ label: `${s.abbr} ${v} → ${rs.statMod.formula.replace(/\bx\b/g, v)}`, value: raw, source: 'formula' });
      modParts.push(...sumParts(`mod.${s.id}`));
      mod = modParts.reduce((a, p) => a + p.value, 0);
    } else {
      mod = v;
      modParts.push({ label: s.abbr, value: v, source: 'base' });
    }
    const statParts = [{ label: from === 'value' ? 'Base' : cap(from), value: Number(sheet.stats?.[s.id]?.[from] ?? sheet.stats?.[s.id]?.value ?? v) || 0, source: 'base' }, ...sumParts(`stat.${s.id}`)];
    out.stats[s.id] = { value: v, parts: statParts, mod: { value: mod, parts: modParts, warnings: rs.statMod?.verify ? [{ kind: 'unverified', msg: 'Modifier formula not checked against the rulebook' }] : [] } };
  }
  for (const d of rs.derived) {
    derivedVal(d.id);
    const b = derivedCache[d.id];
    if (d.verify) b.warnings = [...(b.warnings || []), { kind: 'unverified', msg: d.note || 'Not checked against the rulebook' }];
    out.derived[d.id] = b;
  }
  for (const t of rs.tracks) {
    const raw = sheet.tracks?.[t.id] || {};
    let max = raw.max ?? (t.kind === 'slots' ? t.slots : t.default) ?? 0;
    if (t.maxFormula) max = evaluate(t.maxFormula, { resolve: base }).value || max;
    max += sumParts(`track.${t.id}.max`).reduce((s, p) => s + p.value, 0);
    out.tracks[t.id] = { cur: raw.cur ?? max, max };
  }
  for (const sk of sheet.skills || []) {
    const parts = [{ label: 'Rank', value: Number(sk.rank) || 0, source: 'base' }];
    if (sk.stat) parts.push({ label: `${rs.stats.find((s) => s.id === sk.stat)?.abbr || sk.stat} mod`, value: modOf(sk.stat) ?? 0, source: 'stat' });
    parts.push(...sumParts(`skill.${sk.skillId || sk.uid}`));
    out.skills.push({ uid: sk.uid, total: { value: parts.reduce((a, p) => a + p.value, 0), parts, warnings: [] } });
  }
  for (const a of sheet.attacks || []) {
    const sk = (sheet.skills || []).find((s) => s.uid === a.skillUid);
    ctx['skill.rank'] = Number(sk?.rank) || 0;
    ctx.rank = ctx['skill.rank'];
    const toHit = evaluate(fillTemplate(rs.attack.toHit, { stat: a.stat || 'str' }), { resolve: base, labelOf, expand });
    const dmg = evaluate(fillTemplate(rs.attack.damage, { stat: a.stat || 'str', dice: a.dice || '0' }), { resolve: base, labelOf, expand });
    out.attacks.push({ uid: a.uid, toHit, damage: diceText(dmg.dice, dmg.value), damageBreakdown: dmg });
  }
  if (rs.statMod?.verify) warnings.push({ kind: 'unverified', target: 'statMod', msg: 'Stat modifier formula not checked against the rulebook' });
  for (const d of rs.derived) if (d.verify) warnings.push({ kind: 'unverified', target: `derived.${d.id}`, msg: d.note || `${d.label} formula not checked` });
  if (rs.skills.rankUp?.note) warnings.push({ kind: 'unverified', target: 'skills.rankUp', msg: rs.skills.rankUp.note });
  return out;
}

function normTarget(t) { return String(t || '').replace(/^buff\./, ''); }
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

/* ---------------- editor helpers ---------------- */

/** Effect target dropdown groups built from the ruleset (RULESET §3). */
export function effectTargets(rs) {
  const g = [];
  g.push({ label: 'Derived', options: rs.derived.map((d) => ({ value: d.id, label: d.label })) });
  g.push({ label: 'Stats', options: rs.stats.map((s) => ({ value: `stat.${s.id}`, label: `${s.label} (${s.abbr})` })) });
  g.push({ label: 'Stat modifiers', options: rs.stats.map((s) => ({ value: `mod.${s.id}`, label: `${s.abbr} modifier` })) });
  g.push({ label: 'Tracks', options: rs.tracks.map((t) => ({ value: `track.${t.id}.max`, label: `${t.label} max` })) });
  g.push({ label: 'Fields', options: rs.fields.filter((f) => f.type === 'number').map((f) => ({ value: `field.${f.id}`, label: f.label })) });
  g.push({ label: 'Skills', options: (rs.skills.catalog || []).map((s) => ({ value: `skill.${s.id}`, label: s.name })) });
  return g.filter((x) => x.options.length);
}

export function targetLabel(rs, t) {
  for (const grp of effectTargets(rs)) {
    const o = grp.options.find((x) => x.value === t || x.value === normTarget(t));
    if (o) return o.label;
  }
  const s = normTarget(t);
  const f = rs.fields.find((x) => x.id === s);
  if (f) return f.label;
  return s.replace(/^skill\./, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** "+2 Evade (equipped)" */
export function effectText(rs, e) {
  if (e && e.target == null && e.label) return e.label;
  const v = typeof e.value === 'number' ? (e.value >= 0 ? `+${e.value}` : `−${Math.abs(e.value)}`) : `+(${e.value})`;
  const head = e.op === 'set' ? `${targetLabel(rs, e.target)} becomes ${e.value}` : `${v} ${targetLabel(rs, e.target)}`;
  return head;
}

export const WHEN = [
  { value: 'equipped', label: 'While equipped' },
  { value: 'carried', label: 'While carried' },
  { value: 'active', label: 'While active' },
  { value: 'always', label: 'Always' },
];

export const LIB_KINDS = [
  { id: 'item', label: 'Item', plural: 'Items' },
  { id: 'spell', label: 'Spell', plural: 'Spells' },
  { id: 'skill', label: 'Skill', plural: 'Skills' },
  { id: 'buff', label: 'Buff', plural: 'Buffs' },
  { id: 'feature', label: 'Feature', plural: 'Features' },
  { id: 'race', label: 'Race', plural: 'Races' },
  { id: 'class', label: 'Class', plural: 'Classes' },
  { id: 'background', label: 'Background', plural: 'Backgrounds' },
];

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

export function slugId(name, taken = []) {
  const base = String(name || 'entry').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'entry';
  let id = `hb_${base}`;
  let i = 2;
  const set = new Set(taken);
  while (set.has(id)) id = `hb_${base}_${i++}`;
  return id;
}

/** Permission helpers (RULESET §6). */
export function playerEditLevel(view) {
  const v = view?.session?.permissions?.playerEdit;
  return v === 'none' || v === 'notes' || v === 'sheet' ? v : 'sheet';
}
