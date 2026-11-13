// Auto mode ("Mobs act") and combat endings. Pure + browser-safe, merged into the GM table by state.js
// after COMBAT_GM (so `combat.end` here replaces the plain one).
//
// combat.auto {includeHidden?, dryRun?}   every living mob that may act (revealed; hidden too with
//   includeHidden / settings.includeHidden) picks a target (targetMode + crawler aggro weights), picks an
//   attack (first / random), rolls d20 + toHit against the target's computed Evade (settings.hitRule),
//   on a hit rolls damage, subtracts the target's DR (at least settings.drMin), applies it with track.set
//   on the sheet (single source of truth) and the attack's `buffs` as conditions. Returns `sequence`.
// combat.autoStep   the same, one mob at a time (a queue for this mob phase; combat.auto finishes it).
// combat.autoUndo   puts back the HP, conditions and spread pointer the last auto run changed.
// combat.autoSkip   tells the TV / GM desk to jump to the end of the cinematic (no state change).
// combat.end {outcome?, title?, text?, line?, scene?}   ends the fight with a televised finale.
//
// The TV plays `combat.auto` as a cinematic: one step every settings.stepMs from `startAt` (server ms).
// Voice lines and chat bursts carry `delayMs` so they land on their step; the GM desk cues SFX from
// the same timeline. Unverified rules (hitRule, drMin, crit) are flagged in the GM view.
import { bad, notFound } from './errors.js';
import { FINALE_OUTCOMES } from './scenes.js';
import { SHEET, SHEET_GM, libraryOf, computeFor, setTrack } from './character.js';
import {
  C, combatantOf, crawlerHp, hpTrackOf, defenseOf, comboLine, chatCue, initCombat, initStats, endSuggestion,
} from './combat.js';

export const OUTCOMES = FINALE_OUTCOMES;
export const OUTCOME_LABELS = {
  victory: 'Victory', defeat: 'Party wiped', runaway: 'They ran', truce: 'Truce', special: 'Special ending',
  sponsor: 'Sponsor intervention', timeout: 'Time ran out', stalemate: 'Stalemate',
};
export const AUTO_LEAD_MS = 600; // TV + desk get the event before the first step starts
// Beats inside one step, as a fraction of stepMs (TV animation + GM desk SFX use the same numbers).
export const BEATS = Object.freeze({ lunge: 0, swing: 0.12, roll: 0.2, result: 0.52, down: 0.72 });
export const MAX_COMBAT_LOG = 30;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const flag = (v, f) => { if (typeof v !== 'boolean') throw bad(`${f} must be a boolean`); return v; };
function txt(v, field, max) {
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  const t = v.trim();
  if (t.length > max) throw bad(`${field} too long (max ${max})`);
  return t;
}

/** Living mobs that act in auto mode, in board order. */
function actors(st, c, includeHidden) {
  return c.combatants.filter((x) => x.type === 'mob' && x.hp > 0 && (includeHidden || !x.hidden) && x.attacks?.length);
}

function crawlerState(st, ctx, x) {
  const p = st.players.find((y) => y.id === x.playerId);
  if (!p) return null;
  const t = hpTrackOf(ctx.pack);
  const { computed } = computeFor(p, ctx.pack, libraryOf(st, ctx.pack));
  const hp = t ? computed.tracks[t.id] : { cur: 0, max: 0 };
  const d = defenseOf(ctx.pack, computed);
  return { x, p, hp: hp.cur, max: hp.max, ...d, evade: d.evade + (C(st).settings.evadeBase ?? 0) };
}

/** Valid targets: in the fight, not "Don't target", standing (or finishDowned), aggro weight > 0. */
export function validTargets(st, ctx, c) {
  return c.combatants
    .filter((x) => x.type === 'crawler' && !x.noTarget)
    .map((x) => crawlerState(st, ctx, x))
    .filter((s) => s && s.max > 0 && (s.hp > 0 || c.settings.finishDowned));
}

/** Weighted random pick (aggro weights) with the engine rng. */
export function weightedPick(list, rng) {
  const total = list.reduce((n, s) => n + Math.max(0, s.x.aggro ?? 3), 0);
  if (!(total > 0)) return null;
  let r = rng() * total;
  for (const s of list) {
    r -= Math.max(0, s.x.aggro ?? 3);
    if (r < 0) return s;
  }
  return list[list.length - 1];
}

function pickTarget(st, ctx, c, m) {
  const valid = validTargets(st, ctx, c);
  if (!valid.length) return { target: null, reason: 'no valid target' };
  if (m.targetMode === 'focus' && m.focus) {
    const f = valid.find((s) => s.x.uid === m.focus);
    if (f) return { target: f, mode: 'focus' };
  }
  if (m.targetMode === 'spread') {
    const s = valid[c.spreadNext % valid.length];
    c.spreadNext = (c.spreadNext + 1) % 1000;
    return { target: s, mode: 'spread' };
  }
  return { target: weightedPick(valid, ctx.rng), mode: m.targetMode === 'focus' ? 'auto (focus unavailable)' : 'auto' };
}

function pickAttack(ctx, m) {
  if (!m.attacks.length) return null;
  const i = m.attackMode === 'random' ? Math.floor(ctx.rng() * m.attacks.length) % m.attacks.length : 0;
  return { atk: m.attacks[i], index: i };
}

/** A dice-log roll without the generic nat 1 / nat 20 voice lines (mobs get their own categories). */
function quietRoll(st, ctx, out, formula, label, secret) {
  const sub = { ...out, result: undefined };
  SHEET.roll(st, { t: 'roll', what: { kind: 'custom', formula, label: label.slice(0, 80) }, secret }, { ...ctx, h: { ...ctx.h, categoryLine: null } }, sub);
  const rec = st.rolls.find((r) => r.id === sub.result.rollId);
  // Marked so desks / phones can keep auto-mode rolls out of their "big roll" popups.
  rec.auto = true;
  for (const { event } of out.events) if (event.kind === 'roll' && event.id && event.label === rec.label && event.at === rec.at) event.auto = true;
  return rec;
}

/** Records what an auto run may change, once per crawler / per run (for combat.autoUndo). */
function remember(undo, st, ctx, s) {
  if (undo.crawlers[s.p.id]) return;
  const t = hpTrackOf(ctx.pack);
  undo.crawlers[s.p.id] = { cur: s.hp, track: t?.id ?? null, buffs: [] };
}

/** One mob's turn. Mutates the state; returns the step record. */
function resolveMob(st, ctx, out, c, m, run, force = {}) {
  const step = { i: run.steps.length, mobUid: m.uid, mob: m.name, image: m.image ?? null, hidden: !!m.hidden, boss: m.sourceKind === 'boss' };
  // force.attackIndex / force.targetUid: the GM picked the attack and / or the target (combat.mobAct)
  const pick = force.attackIndex !== undefined ? (m.attacks[force.attackIndex] ? { atk: m.attacks[force.attackIndex], index: force.attackIndex } : null) : pickAttack(ctx, m);
  if (!pick) return { ...step, skipped: 'no attacks' };
  let picked;
  if (force.targetUid) {
    const x = c.combatants.find((y) => y.uid === force.targetUid && y.type === 'crawler');
    const s0 = x ? crawlerState(st, ctx, x) : null;
    picked = s0 && s0.max > 0 ? { target: s0, mode: 'gm' } : { target: null, reason: 'that crawler is not in the fight' };
  } else picked = pickTarget(st, ctx, c, m);
  const { target, reason, mode } = picked;
  step.attack = pick.atk.name;
  step.attackIndex = pick.index;
  if (!target) return { ...step, skipped: reason };
  remember(run.undo, st, ctx, target);
  const s = c.settings;
  Object.assign(step, { targetUid: target.x.uid, playerId: target.p.id, target: target.p.name, color: target.p.color, mode, evade: target.evade, drValue: target.dr, hpBefore: target.hp, max: target.max });
  const toHit = pick.atk.toHit || 0;
  const rec = quietRoll(st, ctx, out, toHit ? `d20${toHit > 0 ? '+' : ''}${toHit}` : 'd20', `${m.name}: ${pick.atk.name} → ${target.p.name}`, !run.public);
  const d20 = rec.dice.find((d) => d.die === 'd20')?.value ?? rec.total - toHit;
  const hit = rec.nat20 ? true : rec.nat1 ? false : s.hitRule === '>' ? rec.total > target.evade : rec.total >= target.evade;
  Object.assign(step, { d20, toHit, total: rec.total, rule: s.hitRule, hit, nat20: !!rec.nat20, nat1: !!rec.nat1, crit: !!rec.nat20 && hit, rollId: rec.id });
  step.margin = rec.total - target.evade;
  step.damage = 0;
  step.hpAfter = target.hp;
  step.buffs = [];
  if (!hit) return step;
  const dmgFormula = (pick.atk.damage || '').trim();
  if (dmgFormula && !/^0+$/.test(dmgFormula)) {
    const dr = quietRoll(st, ctx, out, dmgFormula, `${m.name}: ${pick.atk.name} damage`, !run.public);
    let raw = dr.total;
    if (step.crit && s.crit === 'double') raw *= 2;
    const dmg = Math.max(s.drMin, raw - Math.max(0, target.dr));
    Object.assign(step, { damageRoll: dr.total, damageRaw: raw, damage: dmg, damageRollId: dr.id });
    const t = hpTrackOf(ctx.pack);
    if (t && dmg > 0) {
      setTrack(st, target.p, { track: t.id, delta: -dmg }, ctx, out);
      const after = crawlerState(st, ctx, target.x);
      step.hpAfter = after.hp;
      const taken = target.hp - after.hp;
      if (taken > 0) c.stats.taken[target.p.id] = (c.stats.taken[target.p.id] ?? 0) + taken;
      if (target.hp > 0 && after.hp <= 0) {
        step.down = true;
        c.stats.downs[target.p.id] = (c.stats.downs[target.p.id] ?? 0) + 1;
      }
    }
  }
  for (const id of pick.atk.buffs ?? []) {
    try {
      const sub = { ...out, result: undefined };
      SHEET_GM['buff.add'](st, { playerId: target.p.id, buffId: id }, ctx, sub);
      if (sub.result?.added) {
        const b = target.p.sheet.buffs.find((y) => y.uid === sub.result.uid);
        step.buffs.push(b?.name ?? id);
        run.undo.crawlers[target.p.id].buffs.push(sub.result.uid);
      }
    } catch (e) {
      step.buffErrors = [...(step.buffErrors ?? []), `${id}: ${e.message}`];
    }
  }
  return step;
}

/** TV / phone copy of a step: a hidden attacker is shown as an unseen one, never by name or art. */
function publicStep(st) {
  const { rollId, damageRollId, buffErrors, mode, ...rest } = st;
  return st.hidden ? { ...rest, mob: 'Something unseen', image: null, mobUid: null } : rest;
}

/** Voice + chat cues for a finished run, timed to the TV steps. */
function cues(st, ctx, out, run) {
  const lead = run.startAt - ctx.now;
  const at = (slot, beat) => lead + slot * run.stepMs + BEATS[beat] * run.stepMs;
  let voice = 0;
  for (const step of run.steps) {
    if (step.skipped) continue;
    const fill = { playerId: step.playerId, mob: step.hidden ? 'something unseen' : step.mob };
    if (step.down) {
      chatCue(out, 'crawler_down', fill, at(step.slot, 'down'));
      if (voice < 2) { const l = comboLine(st, ctx, 'crawler_down', at(step.slot, 'down') + 500); if (l) { out.lines.push(l); voice++; } }
    } else if (step.crit) {
      chatCue(out, 'mob_crit', fill, at(step.slot, 'result'));
      if (voice < 1) { const l = comboLine(st, ctx, 'mob_crit', at(step.slot, 'result') + 300); if (l) { out.lines.push(l); voice++; } }
    } else if (!step.hit && (step.nat1 || step.margin <= -5)) {
      chatCue(out, 'mob_miss', fill, at(step.slot, 'result'));
      if (voice < 1 && step.nat1) { const l = comboLine(st, ctx, 'mob_miss', at(step.slot, 'result') + 300); if (l) { out.lines.push(l); voice++; } }
    } else if (step.hit && step.damage > 0 && ctx.rng() < 0.6) chatCue(out, 'mob_hit', fill, at(step.slot, 'result'));
  }
}

function newRun(st, ctx, c, a) {
  const includeHidden = a.includeHidden === undefined ? c.settings.includeHidden : flag(a.includeHidden, 'includeHidden');
  const pub = a.public === undefined ? c.settings.public : flag(a.public, 'public');
  return { id: ctx.genId('au'), at: ctx.now, includeHidden, public: pub, steps: [], undo: { crawlers: {}, spreadNext: c.spreadNext, stats: structuredClone(c.stats) } };
}

/** Emits the cinematic for `steps` (GM: everything; TV + phones: public copies). */
function emitRun(st, ctx, out, c, run, steps, kind = 'combat.auto', tv = true) {
  const startAt = ctx.now + AUTO_LEAD_MS;
  const stepMs = c.settings.stepMs;
  steps.forEach((x, k) => { x.slot = k; }); // position in this cinematic (timing), `i` = position in the run
  const local = { ...run, steps, startAt, stepMs };
  cues(st, ctx, out, local);
  const base = { kind, autoId: run.id, startAt, stepMs, beats: BEATS, round: c.round };
  out.emit({ ...base, steps }, { roles: ['gm'] });
  // tv false (combat.mobAct): a GM-only roll, the TV and phones see the result on the sheets only.
  if (tv) out.emit({ ...base, steps: steps.map(publicStep) }, { roles: ['stage', 'player'] });
  const downs = steps.filter((x) => x.down).length;
  const hits = steps.filter((x) => x.hit).length;
  if (steps.length) {
    const ev = { id: ctx.genId('e'), at: ctx.now, kind: 'combat.auto' };
    ctx.h.feedPush(st, ev, `Mobs act: ${hits} hit${hits === 1 ? '' : 's'}, ${steps.length - hits} miss${steps.length - hits === 1 ? '' : 'es'}${downs ? `, ${downs} down` : ''}`);
  }
  return { startAt, stepMs };
}

function storeRun(c, run, timing, append) {
  if (append && c.lastAuto?.id === run.id) {
    c.lastAuto.steps.push(...run.steps.slice(c.lastAuto.steps.length));
    c.lastAuto.undo = run.undo;
    Object.assign(c.lastAuto, timing);
  } else c.lastAuto = { id: run.id, at: run.at, steps: run.steps, undo: run.undo, undone: false, ...timing };
}

function needActive(c) {
  if (!c.active) throw bad('combat is not running (combat.start first)');
}

export const AUTO_GM = {
  /** The whole mob phase in one go (or the rest of a stepped queue). */
  'combat.auto'(st, a, ctx, out) {
    const c = C(st);
    needActive(c);
    const dry = a.dryRun === undefined ? false : flag(a.dryRun, 'dryRun');
    let run;
    let uids;
    const q = c.autoQueue;
    if (q && c.lastAuto?.id === q.id && c.lastAuto.undo) {
      run = { ...c.lastAuto, steps: [...c.lastAuto.steps], undo: c.lastAuto.undo, public: q.public, includeHidden: q.includeHidden };
      uids = q.uids.slice(q.done ?? 0);
    } else {
      run = newRun(st, ctx, c, a);
      uids = actors(st, c, run.includeHidden).map((m) => m.uid);
    }
    const from = run.steps.length;
    for (const uid of uids) {
      const m = c.combatants.find((x) => x.uid === uid);
      if (!m || m.hp <= 0) continue;
      run.steps.push(resolveMob(st, ctx, out, c, m, run));
    }
    c.autoQueue = null;
    const fresh = run.steps.slice(from);
    if (dry) {
      out.changed = false;
      out.result = { dryRun: true, sequence: fresh };
      return;
    }
    if (!fresh.length) throw bad(actors(st, c, true).length ? 'no revealed mob can act (reveal them or include hidden ones)' : 'no living mob with an attack');
    const timing = emitRun(st, ctx, out, c, run, fresh);
    storeRun(c, run, timing, from > 0);
    out.result = { autoId: run.id, sequence: fresh, ...timing, suggestEnd: endSuggestion(st, ctx.pack) };
  },

  /**
   * One chosen mob (a boss too) attacks now: optional attackIndex (default: its attack mode) and targetUid
   * (default: its targeting). Same resolution, cinematic, dice log and undo as auto mode.
   */
  'combat.mobAct'(st, a, ctx, out) {
    const c = C(st);
    needActive(c);
    const m = c.combatants.find((x) => x.uid === a.uid && x.type === 'mob');
    if (!m) throw notFound(`no mob ${a.uid}`);
    if (m.hp <= 0) throw bad(`${m.name} is down`);
    if (!m.attacks?.length) throw bad(`${m.name} has no attacks`);
    const force = {};
    if (a.attackIndex !== undefined) {
      if (!Number.isInteger(a.attackIndex) || a.attackIndex < 0 || a.attackIndex >= m.attacks.length) throw bad(`attackIndex must be 0..${m.attacks.length - 1}`);
      force.attackIndex = a.attackIndex;
    }
    if (a.targetUid !== undefined && a.targetUid !== null) {
      if (typeof a.targetUid !== 'string') throw bad('targetUid must be a string');
      force.targetUid = a.targetUid;
    }
    const tv = a.tv === undefined ? true : flag(a.tv, 'tv');
    c.autoQueue = null;
    const run = newRun(st, ctx, c, tv ? a : { ...a, public: false });
    const step = resolveMob(st, ctx, out, c, m, run, force);
    if (step.skipped) throw bad(`${m.name}: ${step.skipped}`);
    run.steps.push(step);
    const timing = emitRun(st, ctx, out, c, run, [step], 'combat.auto', tv);
    storeRun(c, run, timing, false);
    out.result = { autoId: run.id, sequence: [step], ...timing, suggestEnd: endSuggestion(st, ctx.pack) };
  },

  /** One mob at a time: builds the queue on the first call, resolves the next mob on each call. */
  'combat.autoStep'(st, a, ctx, out) {
    const c = C(st);
    needActive(c);
    let q = c.autoQueue;
    let run;
    if (!q || c.lastAuto?.id !== q.id || !c.lastAuto.undo) {
      run = newRun(st, ctx, c, a);
      q = { id: run.id, uids: actors(st, c, run.includeHidden).map((m) => m.uid), done: 0, public: run.public, includeHidden: run.includeHidden };
      if (!q.uids.length) throw bad('no mob can act');
      c.autoQueue = q;
    } else run = { ...c.lastAuto, steps: [...c.lastAuto.steps], undo: c.lastAuto.undo, public: q.public, includeHidden: q.includeHidden };
    let step = null;
    while (q.done < q.uids.length && !step) {
      const m = c.combatants.find((x) => x.uid === q.uids[q.done]);
      q.done++;
      if (m && m.hp > 0) step = resolveMob(st, ctx, out, c, m, run);
    }
    if (!step) { c.autoQueue = null; throw bad('every mob has acted'); }
    run.steps.push(step);
    const timing = emitRun(st, ctx, out, c, run, [step]);
    storeRun(c, run, timing, run.steps.length > 1);
    const left = q.uids.slice(q.done).filter((uid) => c.combatants.find((x) => x.uid === uid)?.hp > 0).length;
    if (!left) c.autoQueue = null;
    out.result = { autoId: run.id, sequence: [step], left, ...timing, suggestEnd: endSuggestion(st, ctx.pack) };
  },

  /** Undo the last auto run: HP back to the stored values, the conditions it added removed. */
  'combat.autoUndo'(st, a, ctx, out) {
    const c = C(st);
    const la = c.lastAuto;
    if (!la?.undo || la.undone) throw bad('nothing to undo');
    const t = hpTrackOf(ctx.pack);
    const restored = [];
    for (const [pid, u] of Object.entries(la.undo.crawlers)) {
      const p = st.players.find((x) => x.id === pid);
      if (!p) continue;
      if (t && u.track === t.id) setTrack(st, p, { track: t.id, cur: u.cur }, ctx, out);
      const drop = new Set(u.buffs);
      p.sheet.buffs = p.sheet.buffs.filter((b) => !drop.has(b.uid));
      restored.push(p.name);
    }
    c.spreadNext = la.undo.spreadNext ?? c.spreadNext;
    if (la.undo.stats) c.stats = la.undo.stats;
    la.undone = true;
    if (c.autoQueue?.id === la.id) c.autoQueue = null;
    out.emit({ kind: 'combat.autoUndo', autoId: la.id }, 'all');
    out.result = { autoId: la.id, restored };
  },

  /** Skip the cinematic on the TV (and the desk's queued SFX). No state change. */
  'combat.autoSkip'(st, a, ctx, out) {
    const la = C(st).lastAuto;
    if (la) la.skipped = true;
    out.emit({ kind: 'combat.autoSkip', autoId: la?.id ?? null }, 'all');
    out.result = { autoId: la?.id ?? null };
  },

  /**
   * Ends the fight. Without `outcome` it just clears the board (old behaviour). With one it shows the
   * televised finale (scene `finale`), queues a System line from quip category `combat_<outcome>`, a chat
   * burst, and archives a summary (state.combatLog, feed).
   */
  'combat.end'(st, a, ctx, out) {
    const c = C(st);
    let outcome = null;
    if (a.outcome !== undefined && a.outcome !== null) {
      if (!OUTCOMES.includes(a.outcome)) throw bad(`outcome must be one of ${OUTCOMES.join(', ')}`);
      outcome = a.outcome;
    }
    const title = a.title === undefined ? '' : txt(a.title, 'title', 60);
    const text = a.text === undefined ? '' : txt(a.text, 'text', 400);
    if (outcome === 'special' && !title && !text) throw bad('a special ending needs a title or text');
    const summary = summaryOf(st, ctx, c);
    const entry = { id: c.id ?? ctx.genId('cbt'), at: ctx.now, startedAt: c.startedAt, outcome, title, text, summary };
    if (summary.rounds > 0 && (c.combatants.length || c.active)) {
      st.combatLog = [...(Array.isArray(st.combatLog) ? st.combatLog : []), entry].slice(-MAX_COMBAT_LOG);
    }
    const keep = { phases: c.phases, phasesVerified: c.phasesVerified, showMobHp: c.showMobHp, settings: c.settings };
    // Prepared hidden mobs that never came out stay for the next fight.
    const waiting = c.combatants.filter((x) => x.type === 'mob' && x.hidden && x.hp > 0);
    st.combat = { ...initCombat(), ...keep, stats: initStats(), combatants: waiting };
    const showScene = a.scene === undefined ? true : flag(a.scene, 'scene');
    let sceneId = null;
    if (outcome && showScene) {
      st.scene = { id: ctx.genId('sc'), kind: 'finale', data: { outcome, title, text, summary, at: ctx.now }, since: ctx.now };
      sceneId = st.scene.id;
    }
    const ev = out.emit({ kind: 'combat.end', outcome, title, text, summary, sceneId }, 'all');
    if (outcome) {
      ctx.h.feedPush(st, ev, `Combat over: ${title || OUTCOME_LABELS[outcome]} (${summary.rounds} round${summary.rounds === 1 ? '' : 's'})`);
      if (a.line !== false) {
        const l = comboLine(st, ctx, `combat_${outcome}`, showScene ? 1600 : 0);
        if (l) out.lines.push(l);
      }
      chatCue(out, `combat_${outcome}`, { playerId: summary.mvp?.playerId }, showScene ? 1100 : 0);
      if (outcome === 'victory' && ctx.h.bumpPct) out.emit(ctx.h.bumpPct(st, ctx, 0.12));
    }
    out.result = { outcome, summary, sceneId };
  },
};

/** Rounds, damage dealt / taken, KOs and the MVP (most damage dealt, then kills) of the running fight. */
export function summaryOf(st, ctx, c) {
  const stats = c.stats ?? initStats();
  const crawlers = c.combatants.filter((x) => x.type === 'crawler').map((x) => st.players.find((p) => p.id === x.playerId)).filter(Boolean);
  const per = crawlers.map((p) => {
    let down = false;
    try {
      const t = hpTrackOf(ctx.pack);
      const tr = t ? computeFor(p, ctx.pack, libraryOf(st, ctx.pack)).computed.tracks[t.id] : null;
      down = !!tr && tr.max > 0 && tr.cur <= 0;
    } catch { /* broken sheet */ }
    return { playerId: p.id, name: p.name, color: p.color, dealt: stats.dealt[p.id] ?? 0, taken: stats.taken[p.id] ?? 0, downs: stats.downs[p.id] ?? 0, kills: stats.kills[p.id] ?? 0, down };
  });
  const mobs = c.combatants.filter((x) => x.type === 'mob' && !x.hidden);
  const best = [...per].sort((x, y) => y.dealt - x.dealt || y.kills - x.kills)[0];
  const mvp = best && (best.dealt > 0 || best.kills > 0) ? { playerId: best.playerId, name: best.name, color: best.color, dealt: best.dealt, kills: best.kills } : null;
  return {
    rounds: c.active || c.combatants.length ? c.round : 0,
    dealt: per.reduce((n, x) => n + x.dealt, 0) + (stats.unattributed ?? 0),
    taken: per.reduce((n, x) => n + x.taken, 0),
    mobsDefeated: mobs.filter((m) => m.hp <= 0).length,
    mobsTotal: mobs.length,
    downs: per.reduce((n, x) => n + x.downs, 0),
    standing: per.filter((x) => !x.down).length,
    crawlers: per,
    mvp,
    tracked: per.some((x) => x.dealt > 0),
  };
}

export const AUTO_ACTIONS = Object.keys(AUTO_GM);
