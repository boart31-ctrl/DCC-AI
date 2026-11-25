// Popularity (crawler rulesets, ruleset `popularity`; Atlas: from the Second Floor). A number on the sheet
// (`field`). During a floor each gain reason pays +1 once per crawler (`gains`); at the end of the floor the GM
// reviews the loss reasons (`losses`), −1 each. Some reasons the app can tell by itself:
//   auto { stat, min } / { stat, max } — enhanced stat score at the review,
//   auto "grindLate" — more than `grindLate.hours` grinding hours in the last `grindLate.window` hours of the clock,
//   auto "earlyStairs" — more than `earlyStairs` hours left on the floor clock when the GM reviews (= descends).
// The GM can always untick an automatic one or tick any other.
import { bad, notFound } from './errors.js';
import { computeFor, libraryOf } from './character.js';
import { floorOfState } from './outcome.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function normalizeMine(raw, floor) {
  const r = isObj(raw) && raw.floor === floor ? raw : { floor, gains: [] };
  return { floor, gains: Array.isArray(r.gains) ? r.gains.filter((x) => typeof x === 'string').slice(0, 40) : [] };
}

const score = (p, cfg) => Number(p.sheet.fields?.[cfg.field] ?? 0) || 0;
function setScore(p, cfg, n) { p.sheet.fields = { ...(p.sheet.fields ?? {}), [cfg.field]: n }; }

function statScore(st, ctx, p, id) {
  return computeFor(p, ctx.pack, libraryOf(st, ctx.pack)).computed.stats?.[id]?.value ?? 0;
}

function grindLateHours(st, p, cfg) {
  const now = st.crawlers?.clock?.elapsedSeconds ?? 0;
  const from = now - cfg.grindLate.window * 3600;
  return (p.grind?.log ?? []).filter((x) => Number.isFinite(x?.at) && x.at > from).reduce((n, x) => n + (Number(x.hours) || 0), 0);
}

/** Which gain / loss reasons the app can already tell for this crawler. */
function autoReasons(st, ctx, p, cfg, list) {
  const out = [];
  for (const r of list) {
    const a = r.auto;
    if (!a) continue;
    if (isObj(a) && typeof a.stat === 'string') {
      const v = statScore(st, ctx, p, a.stat);
      if ((a.min != null && v >= a.min) || (a.max != null && v <= a.max)) out.push(r.id);
    } else if (a === 'grindLate' && cfg.grindLate && grindLateHours(st, p, cfg) > cfg.grindLate.hours) out.push(r.id);
    else if (a === 'earlyStairs' && cfg.earlyStairs != null && (st.crawlers?.clock?.hours ?? 0) > cfg.earlyStairs) out.push(r.id);
  }
  return out;
}

function ready(st, ctx) {
  const cfg = ctx.pack.ruleset.popularity;
  if (!cfg) throw bad('this game has no Popularity');
  if (floorOfState(st) < cfg.fromFloor) throw bad(`Popularity starts on floor ${cfg.fromFloor}`);
  return cfg;
}

export const POPULARITY_GM = {
  /** `{ playerId, id }` +1 for a gain reason, once per crawler per floor. */
  'popularity.award'(st, a, ctx, out) {
    const cfg = ready(st, ctx);
    const p = st.players.find((x) => x.id === a.playerId);
    if (!p) throw notFound('no such crawler');
    const reason = cfg.gains.find((g) => g.id === a.id);
    if (!reason) throw notFound('unknown Popularity reason');
    const mine = normalizeMine(p.popularity, floorOfState(st));
    if (mine.gains.includes(reason.id)) throw bad(`${p.name} already got Popularity for that on this floor`);
    mine.gains.push(reason.id);
    p.popularity = mine;
    setScore(p, cfg, score(p, cfg) + 1);
    out.emit({ kind: 'popularity', playerId: p.id, name: p.name, delta: 1, reason: reason.label }, 'all');
    out.result = { score: score(p, cfg) };
  },

  /** `{ playerId, delta }` interview shows and other GM calls (−10..10). */
  'popularity.adjust'(st, a, ctx, out) {
    const cfg = ready(st, ctx);
    const p = st.players.find((x) => x.id === a.playerId);
    if (!p) throw notFound('no such crawler');
    if (!Number.isInteger(a.delta) || a.delta === 0 || Math.abs(a.delta) > 10) throw bad('delta must be −10..10, not 0');
    setScore(p, cfg, score(p, cfg) + a.delta);
    out.emit({ kind: 'popularity', playerId: p.id, name: p.name, delta: a.delta }, 'all');
    out.result = { score: score(p, cfg) };
  },

  /**
   * `{ losses: { playerId: [lossId…] } }` end of the floor: −1 per listed reason. Without `losses` the app uses
   * the reasons it can tell by itself (see the GM view) — the GM normally sends the reviewed list.
   */
  'popularity.review'(st, a, ctx, out) {
    const cfg = ready(st, ctx);
    if (a.losses !== undefined && !isObj(a.losses)) throw bad('losses must be an object');
    const results = st.players.map((p) => {
      const ids = a.losses ? (Array.isArray(a.losses[p.id]) ? a.losses[p.id] : []) : autoReasons(st, ctx, p, cfg, cfg.losses);
      const valid = [...new Set(ids)].filter((id) => cfg.losses.some((l) => l.id === id));
      // Gains the app can see (Cha 10+…) that nobody awarded yet are paid now, once.
      const mine = normalizeMine(p.popularity, floorOfState(st));
      const gains = autoReasons(st, ctx, p, cfg, cfg.gains).filter((id) => !mine.gains.includes(id));
      mine.gains.push(...gains);
      p.popularity = mine;
      const from = score(p, cfg);
      setScore(p, cfg, from + gains.length - valid.length);
      return { playerId: p.id, name: p.name, from, to: score(p, cfg), gains, losses: valid };
    });
    out.result = { results };
  },
};

/** GM view: reasons, each crawler's score, gains already paid this floor and the reasons the app can tell. */
export function popularityView(st, pack, ctx) {
  const cfg = pack.ruleset.popularity;
  if (!cfg) return null;
  const floor = floorOfState(st);
  const c = { ...ctx, pack };
  return {
    fromFloor: cfg.fromFloor, active: floor >= cfg.fromFloor, gains: cfg.gains.map(({ id, label }) => ({ id, label })),
    losses: cfg.losses.map(({ id, label, auto }) => ({ id, label, auto: !!auto })),
    crawlers: Object.fromEntries(st.players.map((p) => [p.id, {
      score: score(p, cfg), gains: normalizeMine(p.popularity, floor).gains,
      ...(floor >= cfg.fromFloor ? { autoLosses: autoReasons(st, c, p, cfg, cfg.losses), autoGains: autoReasons(st, c, p, cfg, cfg.gains),
        ...(cfg.grindLate ? { grindLate: grindLateHours(st, p, cfg) } : {}) } : {}),
    }])),
  };
}
