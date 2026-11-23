// Races and chases (scene kind `chase`). Generic mechanics, numbers come from the action / prep scene:
//  - a contest is a few legs; every leg each crawler rolls a skill or stat check + Move modifier (Move / 10, rounded
//    down, from the sheet's `move` derived value when the ruleset has one); NPC racers / chasers never roll, they have
//    a fixed result per leg;
//  - race: legs are placed highest → lowest (tie: higher Move), placements add up, lowest total wins (tie: better
//    final leg);
//  - chase (seven-degree rulesets): every leg is an opposed check against the quarry's fixed number for that leg;
//    Amazing or better +2 Ground, Success +1, Near miss 0, Fail −1, Major fail −2, Critical fail = out. Ground 4+ =
//    caught early, −4 or worse = out. After the last leg 1+ = caught, 0 or less = got away.
import { bad, notFound } from './errors.js';
import { SHEET, libraryOf, computeFor } from './character.js';
import { degree7, floorOfState } from './outcome.js';

export const CHASE_MODES = ['chase', 'race'];
const MAX_LEGS = 8;
const MAX_NPCS = 6;
const CATCH = 4;
const DELTA = { crit: 2, amazing: 2, success: 1, near: 0, fail: -1, major: -2, critfail: null };
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const intIn = (v, name, lo, hi) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw bad(`${name} must be a whole number ${lo}–${hi}`);
  return v;
};

export const chaseDefaults = () => ({ mode: 'chase', title: '', quarry: null, legs: [], leg: 0, runners: [], done: false, result: null, last: null });

function moveOf(st, ctx, p) {
  if (!ctx.pack.ruleset.derived?.some((d) => d.id === 'move')) return 0;
  const v = computeFor(p, ctx.pack, libraryOf(st, ctx.pack)).computed.derived.move?.value;
  return Number.isFinite(v) ? v : 0;
}

function normLeg(st, ctx, raw, i, fallback) {
  if (!isObj(raw)) throw bad(`leg ${i + 1} must be an object`);
  const leg = { label: str(raw.label, 60) || `Leg ${i + 1}` };
  if (raw.skillId != null) {
    if (!libraryOf(st, ctx.pack).get('skill', raw.skillId)) throw notFound(`leg ${i + 1}: unknown skill ${raw.skillId}`);
    leg.skillId = raw.skillId;
  } else if (raw.statId != null) {
    if (!ctx.pack.ruleset.stats.some((s) => s.id === raw.statId)) throw bad(`leg ${i + 1}: unknown stat ${raw.statId}`);
    leg.statId = raw.statId;
  } else throw bad(`leg ${i + 1}: choose a skill or a stat`);
  leg.value = raw.value == null ? fallback : intIn(raw.value, `leg ${i + 1} value`, 1, 60);
  const hazard = str(raw.hazard, 300);
  if (hazard) leg.hazard = hazard;
  return leg;
}

/** scene.set kind chase: `{ mode, title, quarry?: { name, image?, value? }, legs: [...], playerIds?, npcs?: [{ name, value, image? }] }`. */
export function startChase(st, ctx, patch) {
  const mode = patch.mode ?? 'chase';
  if (!CHASE_MODES.includes(mode)) throw bad(`mode must be ${CHASE_MODES.join(' or ')}`);
  if (mode === 'chase' && ctx.pack.ruleset.combat?.degreeScale !== 'seven') throw bad('chases need a seven-degree ruleset; use a race');
  if (mode === 'chase' && isObj(patch.quarry) && !str(patch.quarry.name, 60)) patch = { ...patch, quarry: { ...patch.quarry, name: 'The quarry' } };
  const floor = floorOfState(st);
  const quarry = mode === 'chase' ? (isObj(patch.quarry) ? patch.quarry : {}) : null;
  const base = quarry?.value != null ? intIn(quarry.value, 'quarry value', 1, 60) : 12 + floor;
  if (!Array.isArray(patch.legs) || !patch.legs.length || patch.legs.length > MAX_LEGS) throw bad(`legs must be 1–${MAX_LEGS}`);
  const legs = patch.legs.map((l, i) => normLeg(st, ctx, l, i, base));
  const ids = patch.playerIds ?? st.players.map((p) => p.id);
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw bad('playerIds must be distinct crawler ids');
  const runners = ids.map((pid) => {
    const p = st.players.find((x) => x.id === pid);
    if (!p) throw notFound(`no player ${pid}`);
    const move = moveOf(st, ctx, p);
    return { id: `p_${p.id}`, playerId: p.id, name: p.name, color: p.color ?? null, image: null, npc: false, move, mod: Math.floor(move / 10), ground: 0, places: [], out: false, caught: false };
  });
  const npcs = patch.npcs ?? [];
  if (!Array.isArray(npcs) || npcs.length > MAX_NPCS) throw bad(`npcs must be at most ${MAX_NPCS}`);
  npcs.forEach((n, i) => {
    if (!isObj(n) || !str(n.name, 60)) throw bad('each NPC runner needs a name');
    runners.push({ id: `n_${i}`, playerId: null, name: str(n.name, 60), color: null, image: str(n.image, 300) || null, npc: true,
      value: intIn(n.value ?? 10 + floor, 'NPC value', 1, 60), move: Number.isInteger(n.move) ? n.move : 20, mod: 0, ground: 0, places: [], out: false, caught: false });
  });
  if (!runners.length) throw bad('add at least one runner');
  return {
    mode, title: str(patch.title, 80) || (mode === 'race' ? 'Race' : 'Chase'),
    quarry: quarry ? { name: str(quarry.name, 60) || 'The quarry', image: str(quarry.image, 300) || null } : null,
    legs, leg: 0, runners, done: false, result: null, last: null,
    ...(typeof patch.source === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(patch.source) ? { source: patch.source } : {}),
  };
}

function chaseScene(st) {
  if (st.scene?.kind !== 'chase') throw bad('no chase on stage (scene.set kind chase first)');
  return st.scene.data;
}

function finish(d) {
  d.done = true;
  if (d.mode === 'race') {
    const score = (r) => r.places.reduce((s, x) => s + x, 0);
    const ranked = [...d.runners].sort((a, b) => score(a) - score(b) || a.places.at(-1) - b.places.at(-1));
    d.result = { order: ranked.map((r) => r.id), winner: ranked[0]?.id ?? null, scores: Object.fromEntries(ranked.map((r) => [r.id, score(r)])) };
  } else {
    for (const r of d.runners) if (!r.out && !r.caught && r.ground >= 1) { r.caught = true; r.caughtLeg = d.legs.length; }
    // First to the quarry: caught earliest, then most Ground, then Move.
    const caught = d.runners.filter((r) => r.caught).sort((a, b) => (a.caughtLeg ?? 99) - (b.caughtLeg ?? 99) || b.ground - a.ground || b.move - a.move);
    d.result = { caught: caught.length > 0, first: caught[0]?.id ?? null };
  }
}

export const CHASE_GM = {
  /** Rolls the current leg for every crawler still in it (digital, or `entries[].entered` = the kept d20). */
  'chase.leg'(st, a, ctx, out) {
    const d = chaseScene(st);
    if (d.done) throw bad('this contest is over');
    const leg = d.legs[d.leg];
    const entered = new Map((Array.isArray(a.entries) ? a.entries : []).map((e) => [e?.playerId, e?.entered]));
    const results = [];
    for (const r of d.runners) {
      if (r.out || (d.mode === 'chase' && r.caught)) continue;
      let total;
      let natural = null;
      let rollId = null;
      if (r.npc) total = r.value;
      else {
        const p = st.players.find((x) => x.id === r.playerId);
        if (!p) { r.out = true; continue; }
        const skill = leg.skillId ? libraryOf(st, ctx.pack).get('skill', leg.skillId) : null;
        const trained = skill && p.sheet.skills.find((s) => s.skillId === skill.id);
        const what = leg.statId ? { kind: 'stat', id: leg.statId } : trained ? { kind: 'skill', uid: trained.uid } : { kind: 'untrained', skillId: skill.id };
        const sub = { ...out, result: undefined };
        SHEET.roll(st, { t: 'roll', what, playerId: p.id, dc: leg.value, ...(r.mod ? { bonus: r.mod } : {}), ...(entered.get(p.id) != null ? { entered: entered.get(p.id) } : {}) }, ctx, sub);
        ({ total, natural } = sub.result.roll);
        rollId = sub.result.roll.id;
      }
      const res = { runnerId: r.id, total, natural, rollId };
      if (d.mode === 'chase') {
        const deg = natural == null ? degree7(10, total, leg.value) : degree7(natural, total, leg.value);
        const delta = DELTA[deg];
        res.degree = deg;
        if (delta === null) { r.out = true; res.out = true; } else {
          r.ground += delta; res.delta = delta;
          if (r.ground >= CATCH) { r.caught = true; r.caughtLeg = d.leg; res.caught = true; }
          if (r.ground <= -CATCH) { r.out = true; res.out = true; }
        }
      }
      results.push(res);
    }
    if (d.mode === 'race') {
      const by = new Map(d.runners.map((r) => [r.id, r]));
      [...results].sort((x, y) => y.total - x.total || by.get(y.runnerId).move - by.get(x.runnerId).move)
        .forEach((res, i) => { res.place = i + 1; by.get(res.runnerId).places.push(i + 1); });
    }
    d.last = { leg: d.leg, label: leg.label, value: leg.value, results, at: ctx.now };
    d.leg += 1;
    const anyLeft = d.runners.some((r) => !r.out && !(d.mode === 'chase' && r.caught));
    if (d.leg >= d.legs.length || !anyLeft) finish(d);
    out.result = { leg: d.last.leg, results, done: d.done, result: d.result };
    out.emit({ kind: 'chase.leg', sceneId: st.scene.id, leg: d.last.leg }, 'all');
  },

  /** GM override: shift a runner's Ground (clever idea, hazard, intervene). */
  'chase.adjust'(st, a) {
    const d = chaseScene(st);
    const r = d.runners.find((x) => x.id === a.runnerId);
    if (!r) throw notFound('no such runner');
    const delta = intIn(a.ground, 'ground', -4, 4);
    if (d.mode !== 'chase') throw bad('Ground only exists in a chase');
    r.ground += delta;
    r.caught = r.ground >= CATCH;
    if (r.caught) r.caughtLeg ??= d.leg; else delete r.caughtLeg;
    if (r.ground <= -CATCH) r.out = true;
  },

  /** Ends the contest now (the GM calls it): same result rules as after the last leg. */
  'chase.finish'(st) {
    const d = chaseScene(st);
    if (!d.done) finish(d);
  },
};
