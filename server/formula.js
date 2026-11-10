// Safe formula language + dice roller (browser-safe, no eval / Function). See docs/RULESET.md §2, §7.
//
//   evaluate(src, resolve)          → { value, parts, warnings }       never throws
//   rollDice(src, { resolve, randInt }) → { total, parts, dice, warnings, nat1, nat20 }   throws FormulaError
//   diceText(src, resolve)          → { text: "1d6+3", parts, warnings }                never throws
//   validateFormula(src, { dice })  → null | error message
//
// Grammar:  expr  := term (('+'|'-') term)*
//           term  := unary (('*'|'/') unary)*
//           unary := ('-'|'+') unary | primary
//           primary := number | dice | ident | func '(' expr (',' expr)* ')' | '(' expr ')'
// Identifiers are dotted names (`mod.dex`, `skill.sneak.rank`). They are never used to index into
// JS objects here: the caller's `resolve(name)` decides (use objectResolver() for plain objects).
import { randInt as cryptoRandInt } from './random.js';

export class FormulaError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'FormulaError';
  }
}

export const LIMITS = Object.freeze({
  maxLength: 500,
  maxTokens: 200,
  maxDepth: 32,
  maxLiteral: 1e9,
  maxValue: 1e12,
  maxDicePerTerm: 100,
  maxSides: 1000,
  maxDiceTotal: 200,
  maxIdent: 100,
  maxArgs: 20,
});

const FUNCS = new Map([
  ['floor', [1, 1]],
  ['ceil', [1, 1]],
  ['round', [1, 1]],
  ['abs', [1, 1]],
  ['min', [1, LIMITS.maxArgs]],
  ['max', [1, LIMITS.maxArgs]],
]);

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*/y;
const NUM_RE = /\d+(?:\.\d+)?/y;
const INT_RE = /\d+/y;
const DIE_IDENT_RE = /^d(\d+)$/;

function matchAt(re, src, i) {
  re.lastIndex = i;
  const m = re.exec(src);
  return m ? m[0] : null;
}

function tokenize(src, dice) {
  const out = [];
  let i = 0;
  const push = (tok) => {
    out.push(tok);
    if (out.length > LIMITS.maxTokens) throw new FormulaError(`formula too long (max ${LIMITS.maxTokens} tokens)`);
  };
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      if (c === '.') throw new FormulaError(`number must start with a digit at ${i}`);
      const n = matchAt(NUM_RE, src, i);
      const start = i;
      i += n.length;
      if (dice && (src[i] === 'd' || src[i] === 'D') && src[i + 1] >= '0' && src[i + 1] <= '9') {
        if (n.includes('.')) throw new FormulaError(`dice count must be a whole number at ${start}`);
        const sides = matchAt(INT_RE, src, i + 1);
        i += 1 + sides.length;
        if (/[A-Za-z0-9_.]/.test(src[i] ?? '')) throw new FormulaError(`bad dice term at ${start}`);
        push({ k: 'dice', count: Number(n), sides: Number(sides), start, end: i });
        continue;
      }
      if (/[A-Za-z_]/.test(src[i] ?? '')) throw new FormulaError(`unexpected "${src[i]}" after number at ${i}`);
      const value = Number(n);
      if (!Number.isFinite(value) || value > LIMITS.maxLiteral) throw new FormulaError(`number too large (max ${LIMITS.maxLiteral})`);
      push({ k: 'num', value, start, end: i });
      continue;
    }
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
      const name = matchAt(IDENT_RE, src, i);
      const start = i;
      i += name.length;
      if (src[i] === '.') throw new FormulaError(`bad identifier at ${start}`);
      if (name.length > LIMITS.maxIdent) throw new FormulaError(`identifier too long at ${start}`);
      const die = dice ? DIE_IDENT_RE.exec(name.replace(/^D/, 'd')) : null;
      if (die) push({ k: 'dice', count: 1, sides: Number(die[1]), start, end: i });
      else push({ k: 'id', name, start, end: i });
      continue;
    }
    if ('+-*/(),'.includes(c)) {
      push({ k: c, start: i, end: i + 1 });
      i++;
      continue;
    }
    throw new FormulaError(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  return out;
}

function parse(src, { dice = false } = {}) {
  if (typeof src !== 'string') throw new FormulaError('formula must be a string');
  if (src.length > LIMITS.maxLength) throw new FormulaError(`formula too long (max ${LIMITS.maxLength} characters)`);
  const toks = tokenize(src, dice);
  if (!toks.length) throw new FormulaError('empty formula');
  let pos = 0;
  let depth = 0;
  let diceTotal = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const expect = (k) => {
    const t = next();
    if (!t || t.k !== k) throw new FormulaError(`expected "${k}"${t ? ` at ${t.start}` : ' at end'}`);
    return t;
  };
  const enter = () => {
    if (++depth > LIMITS.maxDepth) throw new FormulaError(`formula too deeply nested (max ${LIMITS.maxDepth})`);
  };

  function expr() {
    enter();
    let l = term();
    while (peek() && (peek().k === '+' || peek().k === '-')) {
      const op = next().k;
      const r = term();
      l = { type: 'bin', op, l, r, start: l.start, end: r.end };
    }
    depth--;
    return l;
  }
  function term() {
    let l = unary();
    while (peek() && (peek().k === '*' || peek().k === '/')) {
      const op = next().k;
      const r = unary();
      l = { type: 'bin', op, l, r, start: l.start, end: r.end };
    }
    return l;
  }
  function unary() {
    const t = peek();
    if (t && (t.k === '-' || t.k === '+')) {
      next();
      enter();
      const arg = unary();
      depth--;
      return t.k === '-' ? { type: 'neg', arg, start: t.start, end: arg.end } : { ...arg, start: t.start };
    }
    return primary();
  }
  function primary() {
    const t = next();
    if (!t) throw new FormulaError('unexpected end of formula');
    if (t.k === 'num') return { type: 'num', value: t.value, start: t.start, end: t.end };
    if (t.k === 'dice') {
      if (t.count < 1 || t.count > LIMITS.maxDicePerTerm) throw new FormulaError(`dice count must be 1..${LIMITS.maxDicePerTerm}`);
      if (t.sides < 1 || t.sides > LIMITS.maxSides) throw new FormulaError(`dice sides must be 1..${LIMITS.maxSides}`);
      diceTotal += t.count;
      if (diceTotal > LIMITS.maxDiceTotal) throw new FormulaError(`too many dice (max ${LIMITS.maxDiceTotal})`);
      return { type: 'dice', count: t.count, sides: t.sides, start: t.start, end: t.end };
    }
    if (t.k === 'id') {
      if (peek()?.k === '(') {
        if (!FUNCS.has(t.name)) throw new FormulaError(`unknown function "${t.name}"`);
        next();
        const args = [expr()];
        while (peek()?.k === ',') {
          next();
          args.push(expr());
        }
        const close = expect(')');
        const [lo, hi] = FUNCS.get(t.name);
        if (args.length < lo || args.length > hi) throw new FormulaError(`${t.name}() takes ${lo === hi ? lo : `${lo}..${hi}`} argument(s)`);
        return { type: 'call', name: t.name, args, start: t.start, end: close.end };
      }
      return { type: 'id', name: t.name, start: t.start, end: t.end };
    }
    if (t.k === '(') {
      const e = expr();
      const close = expect(')');
      return { ...e, start: t.start, end: close.end, paren: true };
    }
    throw new FormulaError(`unexpected "${t.k}" at ${t.start}`);
  }

  const ast = expr();
  if (pos < toks.length) throw new FormulaError(`unexpected "${toks[pos].k === 'id' ? toks[pos].name : toks[pos].k}" at ${toks[pos].start}`);
  return ast;
}

/** Parses and returns the AST; throws FormulaError. */
export function parseFormula(src, opts) {
  return parse(src, opts);
}

/** null if the formula is valid, else the error message. */
export function validateFormula(src, opts) {
  try {
    parse(src, opts);
    return null;
  } catch (e) {
    if (e instanceof FormulaError) return e.message;
    throw e;
  }
}

// ---------- evaluation ----------

const clean = (v) => Math.round(v * 1e6) / 1e6;

function clamp(v, env) {
  if (!Number.isFinite(v)) {
    env.warn({ kind: 'overflow', msg: 'result is not a finite number, using 0' });
    return 0;
  }
  if (Math.abs(v) > LIMITS.maxValue) {
    env.warn({ kind: 'overflow', msg: `result exceeds ${LIMITS.maxValue}, clamped` });
    return Math.sign(v) * LIMITS.maxValue;
  }
  return v;
}

function resolveId(name, env) {
  let r;
  try {
    r = env.resolve ? env.resolve(name) : undefined;
  } catch {
    r = undefined;
  }
  if (typeof r === 'number') return { value: clamp(r, env) };
  if (r && typeof r === 'object' && typeof r.value === 'number') {
    return { value: clamp(r.value, env), label: typeof r.label === 'string' ? r.label : undefined, parts: Array.isArray(r.parts) ? r.parts : undefined };
  }
  env.warn({ kind: 'unknown', name, msg: `unknown identifier "${name}" (counted as 0)` });
  return { value: 0, unknown: true };
}

function ev(node, env) {
  switch (node.type) {
    case 'num':
      return node.value;
    case 'id':
      return resolveId(node.name, env).value;
    case 'dice': {
      if (!env.roll) throw new FormulaError('dice are not allowed here');
      return env.roll(node);
    }
    case 'neg':
      return -ev(node.arg, env);
    case 'bin': {
      const l = ev(node.l, env);
      const r = ev(node.r, env);
      let v;
      if (node.op === '+') v = l + r;
      else if (node.op === '-') v = l - r;
      else if (node.op === '*') v = l * r;
      else if (r === 0) {
        env.warn({ kind: 'div0', msg: 'division by zero (counted as 0)' });
        v = 0;
      } else v = l / r;
      return clamp(v, env);
    }
    case 'call': {
      const a = node.args.map((x) => ev(x, env));
      switch (node.name) {
        case 'floor': return Math.floor(a[0]);
        case 'ceil': return Math.ceil(a[0]);
        case 'round': return Math.round(a[0]);
        case 'abs': return Math.abs(a[0]);
        case 'min': return Math.min(...a);
        case 'max': return Math.max(...a);
        default: throw new FormulaError(`unknown function "${node.name}"`);
      }
    }
    default:
      throw new FormulaError('bad node');
  }
}

// Splits the top-level + / - chain into signed terms (a - (b + c) → a, -b, -c).
function flatten(node, sign, out) {
  if (node.type === 'bin' && (node.op === '+' || node.op === '-')) {
    flatten(node.l, sign, out);
    flatten(node.r, node.op === '-' ? -sign : sign, out);
  } else if (node.type === 'neg') {
    flatten(node.arg, -sign, out);
  } else {
    out.push({ node, sign });
  }
  return out;
}

const hasDice = (n) => n.type === 'dice' || (n.l && hasDice(n.l)) || (n.r && hasDice(n.r)) || (n.arg && hasDice(n.arg)) || (n.args?.some(hasDice) ?? false);
const neg = (parts) => parts.map((p) => ({ ...p, value: -p.value, ...(p.parts ? { parts: neg(p.parts) } : {}) }));

function partOf(src, node, sign, env, first = false) {
  if (node.type === 'id') {
    const r = resolveId(node.name, env);
    const p = { label: r.label ?? node.name, value: clean(sign * r.value), source: node.name };
    if (r.parts?.length) p.parts = sign < 0 ? neg(r.parts) : r.parts;
    if (r.unknown) p.unknown = true;
    return p;
  }
  if (node.type === 'num') return { label: sign < 0 ? 'Penalty' : first ? 'Base' : 'Bonus', value: clean(sign * node.value), source: 'const' };
  if (node.type === 'dice') {
    const before = env.dice.length;
    const v = ev(node, env);
    const d = env.dice[before];
    return { label: `${node.count}d${node.sides}`, value: sign * v, source: 'dice', rolls: d ? d.rolls : [] };
  }
  return { label: src.slice(node.start, node.end).trim(), value: clean(sign * ev(node, env)), source: 'expr' };
}

function makeEnv(resolve, roll) {
  const warnings = [];
  const seen = new Set();
  const env = {
    resolve,
    dice: [],
    warn(w) {
      const k = `${w.kind}:${w.name ?? w.msg}`;
      if (seen.has(k)) return;
      seen.add(k);
      warnings.push(w);
    },
    warnings,
  };
  if (roll) {
    env.roll = (node) => {
      const rolls = [];
      for (let i = 0; i < node.count; i++) rolls.push(roll(node.sides));
      const sum = rolls.reduce((s, x) => s + x, 0);
      env.dice.push({ term: `${node.count}d${node.sides}`, count: node.count, sides: node.sides, rolls, sum });
      return sum;
    };
  }
  return env;
}

function breakdown(src, ast, env) {
  const parts = flatten(ast, 1, []).map(({ node, sign }, i) => partOf(src, node, sign, env, i === 0));
  const value = clean(clamp(parts.reduce((s, p) => s + p.value, 0), env));
  return { value, parts };
}

/**
 * Evaluates a formula (no dice). Unknown identifiers → 0 with a warning; parse errors → value 0 with a
 * `{kind:'formula'}` warning. Numbers are accepted as-is.
 */
export function evaluate(src, resolve) {
  if (typeof src === 'number') {
    if (!Number.isFinite(src)) return { value: 0, parts: [], warnings: [{ kind: 'formula', msg: 'not a finite number' }] };
    return { value: src, parts: [{ label: 'Base', value: src, source: 'const' }], warnings: [] };
  }
  const env = makeEnv(resolve, null);
  try {
    const ast = parse(src);
    const { value, parts } = breakdown(src, ast, env);
    return { value, parts, warnings: env.warnings };
  } catch (e) {
    if (!(e instanceof FormulaError)) throw e;
    return { value: 0, parts: [], warnings: [...env.warnings, { kind: 'formula', msg: e.message, formula: String(src).slice(0, 100) }] };
  }
}

/**
 * Rolls dice notation mixed with formula terms: `2d6+1d4+3`, `d20 + mod.dex`.
 * opts.randInt(n) → integer 0..n-1 (default: Web Crypto). Throws FormulaError on bad input.
 * nat1/nat20 are set only when the whole roll contains exactly one d20.
 */
export function rollDice(src, { resolve, randInt = cryptoRandInt } = {}) {
  const ast = parse(src, { dice: true });
  const env = makeEnv(resolve, (sides) => {
    const r = Math.floor(randInt(sides));
    return Math.min(sides, Math.max(1, r + 1));
  });
  const { value, parts } = breakdown(src, ast, env);
  const single = env.dice.length === 1 && env.dice[0].count === 1 && env.dice[0].sides === 20 ? env.dice[0].rolls[0] : null;
  return { total: value, parts, dice: env.dice, warnings: env.warnings, nat1: single === 1, nat20: single === 20 };
}

/**
 * Static text for a dice formula with the non-dice terms summed: `1d6 + mod.str` → "1d6+3".
 * Dice nested inside functions or products are kept as written.
 */
export function diceText(src, resolve) {
  const env = makeEnv(resolve, null);
  try {
    const ast = parse(src, { dice: true });
    const dice = [];
    const parts = [];
    let k = 0;
    for (const { node, sign } of flatten(ast, 1, [])) {
      if (node.type === 'dice') {
        const t = `${node.count}d${node.sides}`;
        dice.push((sign < 0 ? '-' : dice.length ? '+' : '') + t);
        parts.push({ label: sign < 0 ? `-${t}` : t, value: 0, source: 'dice' });
      } else if (hasDice(node)) {
        const t = src.slice(node.start, node.end).trim();
        dice.push((sign < 0 ? '-' : dice.length ? '+' : '') + (node.paren ? t : `(${t})`));
        parts.push({ label: sign < 0 ? `-${t}` : t, value: 0, source: 'dice' });
      } else {
        const p = partOf(src, node, sign, env);
        k += p.value;
        parts.push(p);
      }
    }
    k = clean(k);
    let text = dice.join('');
    if (!text) text = String(k);
    else if (k > 0) text += `+${k}`;
    else if (k < 0) text += `${k}`;
    return { text, parts, warnings: env.warnings };
  } catch (e) {
    if (!(e instanceof FormulaError)) throw e;
    return { text: '', parts: [], warnings: [...env.warnings, { kind: 'formula', msg: e.message, formula: String(src).slice(0, 100) }] };
  }
}

/**
 * Resolver over a plain (nested) object using own properties only:
 * objectResolver({ mod: { dex: 2 } })('mod.dex') → 2; 'constructor' / '__proto__' → undefined.
 */
export function objectResolver(obj) {
  return (name) => {
    let cur = obj;
    for (const seg of name.split('.')) {
      if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, seg)) return undefined;
      cur = cur[seg];
    }
    return typeof cur === 'number' || (cur && typeof cur === 'object' && typeof cur.value === 'number') ? cur : undefined;
  };
}
