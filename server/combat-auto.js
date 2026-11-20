// Auto mode ("Mobs act") and combat endings. Pure + browser-safe, merged into the GM table by state.js
// after COMBAT_GM (so `combat.end` here replaces the plain one).
//
// combat.autoStep resolves one mob attack. combat.auto is also single-step unless confirmAll is true.
// A hit that would drop a crawler to 0 or damage a Dying crawler pauses at the exact dice preview.
// combat.autoConfirm / combat.autoCancel apply / dismiss that pending attack by its preview ID.
// combat.autoUndo restores one committed attack, including HP, conditions and the queue position.
// combat.autoSkip   tells the TV / GM desk to jump to the end of the cinematic (no state change).
// combat.end {outcome?, title?, text?, line?, scene?}   ends the fight with a televised finale.
//
// The TV plays `combat.auto` as a cinematic: one step every settings.stepMs from `startAt` (server ms).
// Voice lines and chat bursts carry `delayMs` so they land on their step; the GM desk cues SFX from
// the same timeline. Unverified rules (hitRule, drMin, crit) are flagged in the GM view.
import { bad, notFound } from './errors.js';
import { damageToSlots } from './outcome.js';
import { FormulaError, rollDice } from './formula.js';
import { onCrawlerDamage } from './reaction.js';
import { FINALE_OUTCOMES } from './scenes.js';
import { SHEET, SHEET_GM, libraryOf, computeFor, setTrack } from './character.js';
import {
  C, combatantOf, crawlerHp, hpTrackOf, defenseOf, combatRules, attackOutcome, critFormula, critMultiplier, comboLine, chatCue, initCombat, initStats, endSuggestion, autoScope,
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
const MAX_AUTO_UNDO = 40;

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
  const rules = combatRules(ctx.pack, C(st).settings);
  return { x, p, hp: hp.cur, max: hp.max, slotValue: hp.slotValue ?? 1, ...d, dr: rules.useDr ? d.dr : 0, evade: d.evade + rules.evadeBase };
}

/** Valid targets: in the fight, not "Don't target", standing (or finishDowned), aggro weight > 0. */
export function validTargets(st, ctx, c) {
  return c.combatants
    .filter((x) => x.type === 'crawler' && !x.noTarget)
    .map((x) => crawlerState(st, ctx, x))
    .filter((s) => s && s.max > 0 && (!s.x.dead && (s.hp > 0 || c.settings.finishDowned)));
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

function autoRoll(formula, ctx) {
  try {
    const rolled = rollDice(formula, { randInt: ctx.dieInt ?? ctx.rollInt ?? ctx.randInt });
    return { formula, ...rolled };
  } catch (error) {
    if (error instanceof FormulaError) throw bad(`bad roll formula: ${error.message}`);
    throw error;
  }
}

/** Rolls once, without publishing dice, changing health or moving the spread pointer. */
function planMob(st, ctx, c, m, force = {}) {
  const step = { mobUid: m.uid, mob: m.name, image: m.image ?? null, hidden: !!m.hidden, boss: m.sourceKind === 'boss' };
  const pick = force.attackIndex !== undefined ? { atk: m.attacks[force.attackIndex], index: force.attackIndex } : pickAttack(ctx, m);
  if (!pick?.atk) return { step: { ...step, skipped: 'no attacks' } };
  let picked;
  if (force.targetUid) {
    const x = c.combatants.find((y) => y.uid === force.targetUid && y.type === 'crawler' && !y.dead);
    const target = x ? crawlerState(st, ctx, x) : null;
    picked = target?.max > 0 ? { target, mode: 'gm' } : { target: null, reason: 'that crawler is not in the fight or is already dead' };
  } else picked = pickTarget(st, ctx, c, m);
  const { target, reason, mode } = picked;
  step.attack = pick.atk.name;
  step.attackIndex = pick.index;
  if (!target) return { step: { ...step, skipped: reason ?? 'no valid target' } };
  Object.assign(step, { targetUid: target.x.uid, playerId: target.p.id, target: target.p.name, color: target.p.color,
    mode, evade: target.evade, drValue: target.dr, hpBefore: target.hp, max: target.max });
  const toHit = pick.atk.toHit || 0;
  const strike = autoRoll(toHit ? `d20${toHit > 0 ? '+' : ''}${toHit}` : 'd20', ctx);
  const d20 = strike.dice[0].rolls[0];
  const rules = combatRules(ctx.pack, c.settings);
  const res = attackOutcome(rules, { d20, total: strike.total, target: target.evade });
  Object.assign(step, { d20, toHit, total: strike.total, rule: rules.degrees ? 'degrees' : rules.hitRule,
    hit: res.hit, nat20: d20 === 20, nat1: d20 === 1, crit: res.crit, degree: res.degree,
    defenseLabel: rules.defenseLabel, margin: strike.total - target.evade, damage: 0, hpAfter: target.hp, buffs: [] });
  const plan = { step, strike };
  if (!res.hit) return plan;
  const formula = (pick.atk.damage || '').trim();
  if (formula && !/^0+$/.test(formula)) {
    const roll = autoRoll(res.crit ? critFormula(formula, rules) : formula, ctx);
    const raw = res.crit ? roll.total * critMultiplier(rules) : roll.total;
    const damageAfterDr = Math.max(rules.drMin, raw - Math.max(0, target.dr));
    const damage = damageToSlots(damageAfterDr, target.slotValue);
    const hpAfter = Math.max(0, target.hp - damage);
    Object.assign(step, { damageRoll: roll.total, damageRaw: raw, damageAfterDr, damage, hpAfter,
      ...(target.slotValue > 1 ? { slotValue: target.slotValue } : {}) });
    plan.damage = roll;
    if (damage > 0 && target.x.dying != null) plan.danger = target.x.dying <= 1 ? 'death' : 'dying';
    else if (damage > 0 && hpAfter <= 0) plan.danger = 'down';
  }
  return plan;
}

function publishRoll(st, ctx, out, roll, label, secret) {
  const faces = roll.dice.flatMap((d) => d.rolls);
  let index = 0;
  return quietRoll(st, { ...ctx, dieInt: () => faces[index++] - 1 }, out, roll.formula, label, secret);
}

/** Commits the exact rolled result and remembers only this hit's changes. */
function applyMob(st, ctx, out, c, plan, run, i) {
  const step = { ...plan.step, i };
  if (step.skipped) return { step };
  const target = combatantOf(st, step.targetUid);
  const p = st.players.find((y) => y.id === target.playerId);
  const t = hpTrackOf(ctx.pack);
  const undo = { track: t?.id ?? null, taken: 0, downs: 0, buffs: [], dying: target.dying, dead: !!target.dead };
  if (step.mode === 'spread') c.spreadNext = (c.spreadNext + 1) % 1000;
  step.rollId = publishRoll(st, ctx, out, plan.strike, `${step.mob}: ${step.attack} → ${p.name}`, !run.public).id;
  if (plan.damage) {
    step.damageRollId = publishRoll(st, ctx, out, plan.damage, `${step.mob}: ${step.attack} damage${step.crit ? ' (critical)' : ''}`, !run.public).id;
    if (t && step.damage > 0) {
      setTrack(st, p, { track: t.id, delta: -step.damage }, ctx, out);
      const after = crawlerState(st, ctx, target);
      step.hpAfter = after.hp;
      undo.taken = step.hpBefore - after.hp;
      if (undo.taken > 0) c.stats.taken[p.id] = (c.stats.taken[p.id] ?? 0) + undo.taken;
      if (step.hpBefore > 0 && after.hp <= 0) {
        step.down = true;
        undo.downs = 1;
        c.stats.downs[p.id] = (c.stats.downs[p.id] ?? 0) + 1;
      }
      onCrawlerDamage(st, ctx, out, target, target.dying != null);
      if (undo.dying != null || target.dying != null) {
        step.dyingBefore = undo.dying ?? null;
        step.dyingAfter = target.dying ?? null;
        step.deadBefore = undo.dead;
        step.deadAfter = !!target.dead;
      }
    }
  }
  if (step.hit) {
    const attack = combatantOf(st, step.mobUid).attacks[step.attackIndex];
    for (const id of attack.buffs ?? []) {
      try {
        const sub = { ...out, result: undefined };
        SHEET_GM['buff.add'](st, { playerId: p.id, buffId: id }, ctx, sub);
        if (sub.result?.added) {
          const b = p.sheet.buffs.find((y) => y.uid === sub.result.uid);
          step.buffs.push(b?.name ?? id);
          undo.buffs.push(sub.result.uid);
        }
      } catch (e) {
        step.buffErrors = [...(step.buffErrors ?? []), `${id}: ${e.message}`];
      }
    }
  }
  undo.afterDying = target.dying;
  undo.afterDead = !!target.dead;
  return { step, undo };
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

function autoOptions(c, a) {
  const includeHidden = a.includeHidden === undefined ? c.settings.includeHidden : flag(a.includeHidden, 'includeHidden');
  const pub = a.public === undefined ? c.settings.public : flag(a.public, 'public');
  return { includeHidden, public: pub };
}

function newRun(ctx, options) {
  return { ...options, id: ctx.genId('au'), at: ctx.now, steps: [] };
}

function queueOf(st, ctx, c, a) {
  const scope = autoScope(c);
  const saved = c.autoQueue;
  if (saved && (saved.scope == null || saved.scope === scope)) return { ...saved, scope };
  const options = autoOptions(c, a);
  return { id: ctx.genId('aq'), scope, done: 0, uids: actors(st, c, options.includeHidden).map((m) => m.uid), ...options };
}

function autoFingerprint(st, ctx, c, step) {
  const mob = c.combatants.find((x) => x.uid === step.mobUid && x.type === 'mob' && x.hp > 0);
  const crawler = c.combatants.find((x) => x.uid === step.targetUid && x.type === 'crawler' && !x.dead);
  const target = crawler ? crawlerState(st, ctx, crawler) : null;
  if (!mob?.attacks[step.attackIndex] || !target) return null;
  const { hp, max, slotValue, dr, evade, p } = target;
  return JSON.stringify([autoScope(c), c.spreadNext, c.settings, mob, crawler, p.name, p.color, hp, max,
    slotValue, dr, evade, p.sheet.buffs, c.autoQueue?.id, c.autoQueue?.done, ctx.pack.ruleset.combat]);
}

function previewOf(pending) {
  return { id: pending.id, danger: pending.plan.danger, step: pending.plan.step };
}

function holdPreview(st, ctx, c, plan, options) {
  const pending = { id: ctx.genId('ap'), plan, ...options, scope: autoScope(c),
    fingerprint: autoFingerprint(st, ctx, c, plan.step) };
  c.autoPending = pending;
  return previewOf(pending);
}

function needActive(c, ctx) {
  if (!c.active) throw bad('combat is not running (combat.start first)');
  if (ctx.pack.ruleset.combat?.flow === 'reaction') throw bad('declare the mob attack and its target in Fight');
}

function reportPending(c, out) {
  if (!c.autoPending || c.autoPending.scope !== autoScope(c)) return false;
  out.changed = false;
  out.result = { sequence: [], preview: previewOf(c.autoPending) };
  return true;
}

function queueRemaining(c, q) {
  return q.uids.slice(q.done).filter((uid) => c.combatants.some((x) => x.uid === uid && x.hp > 0 && (q.includeHidden || !x.hidden))).length;
}

function applyStep(st, ctx, out, c, plan, run, q, i) {
  const queueBefore = q ? { ...q } : c.autoQueue;
  const spreadBefore = c.spreadNext;
  const { step, undo } = applyMob(st, ctx, out, c, plan, run, i);
  if (q) q.done++;
  c.autoQueue = q && queueRemaining(c, q) ? q : null;
  run.steps.push(step);
  if (undo) {
    const entry = { id: run.id, at: ctx.now, step, undo, queueBefore, scope: autoScope(c),
      queueAfterId: c.autoQueue?.id ?? null, queueAfterDone: c.autoQueue?.done ?? null, spreadBefore, spreadAfter: c.spreadNext };
    c.autoUndo = [...(c.autoUndo ?? []), entry].slice(-MAX_AUTO_UNDO);
  }
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

function publishRun(st, ctx, out, c, run, options = {}) {
  const { tv = true, preview, left } = options;
  if (!run.steps.length) {
    out.result = { sequence: [], ...(preview ? { preview } : {}) };
    return;
  }
  const timing = emitRun(st, ctx, out, c, run, run.steps, 'combat.auto', tv);
  c.lastAuto = { id: run.id, at: run.at, steps: run.steps, undone: false, ...timing };
  out.result = { autoId: run.id, sequence: run.steps, ...timing, suggestEnd: endSuggestion(st, ctx.pack),
    ...(left !== undefined ? { left } : {}), ...(preview ? { preview } : {}) };
}

function autoQueueRun(st, a, ctx, out, { all = false, dry = false } = {}) {
  const c = C(st);
  needActive(c, ctx);
  if (!dry && reportPending(c, out)) return;
  delete c.autoPending;
  const q = queueOf(st, ctx, c, a);
  const run = newRun(ctx, q);
  // A dry run may simulate sequential changes on the reducer's private clone. Never publish those events.
  const output = dry ? { events: [], emit: (event) => ({ ...event, at: ctx.now }) } : out;
  let preview;
  while (q.done < q.uids.length) {
    const m = c.combatants.find((x) => x.uid === q.uids[q.done] && x.hp > 0 && (q.includeHidden || !x.hidden));
    if (!m) { q.done++; continue; }
    const plan = planMob(st, ctx, c, m);
    if (!dry && plan.danger) {
      c.autoQueue = q;
      preview = holdPreview(st, ctx, c, plan, { queued: true, tv: true, public: run.public, i: q.done });
      break;
    }
    applyStep(st, ctx, output, c, plan, run, q, q.done);
    if (!all) break;
  }
  if (dry) {
    out.changed = false;
    out.result = { dryRun: true, sequence: run.steps };
    return;
  }
  if (!run.steps.length && !preview) throw bad('no living mob can act');
  publishRun(st, ctx, out, c, run, { preview, left: queueRemaining(c, q) });
}

function restoreAuto(st, c, ctx, out) {
  const entry = c.autoUndo?.pop();
  if (!entry) return null;
  const { id, step, undo } = entry;
  const p = st.players.find((x) => x.id === step.playerId);
  const x = c.combatants.find((y) => y.uid === step.targetUid);
  if (p) {
    const t = hpTrackOf(ctx.pack);
    const before = x ? crawlerState(st, ctx, x) : null;
    if (t && undo.track === t.id && undo.taken > 0) setTrack(st, p, { track: t.id, delta: undo.taken }, ctx, out);
    if (x && before?.hp === step.hpAfter && x.dying === undo.afterDying && !!x.dead === undo.afterDead) {
      if (undo.dying == null) delete x.dying; else x.dying = undo.dying;
      if (!undo.dead) delete x.dead; else x.dead = true;
    }
    const added = new Set(undo.buffs);
    p.sheet.buffs = p.sheet.buffs.filter((b) => !added.has(b.uid));
    if (undo.taken) c.stats.taken[p.id] = Math.max(0, (c.stats.taken[p.id] ?? 0) - undo.taken);
    if (undo.downs) c.stats.downs[p.id] = Math.max(0, (c.stats.downs[p.id] ?? 0) - undo.downs);
  }
  for (const roll of st.rolls) if (roll.id === step.rollId || roll.id === step.damageRollId) roll.void = true;
  if (autoScope(c) === entry.scope) {
    if (c.spreadNext === entry.spreadAfter) c.spreadNext = entry.spreadBefore;
    if ((c.autoQueue?.id ?? null) === entry.queueAfterId && (c.autoQueue?.done ?? null) === entry.queueAfterDone) {
      c.autoQueue = entry.queueBefore;
    }
  }
  delete c.autoPending;
  if (c.lastAuto?.id === id) {
    const displayed = c.lastAuto.steps.find((x) => x.i === step.i);
    if (displayed) displayed.undone = true;
    c.lastAuto.undone = c.lastAuto.steps.every((x) => x.undone || x.skipped);
  }
  return { id, restored: p ? [p.name] : [] };
}

export const AUTO_GM = {
  /** Bulk resolution requires an explicit choice. A dangerous hit always pauses the queue. */
  'combat.auto'(st, a, ctx, out) {
    const dry = a.dryRun === undefined ? false : flag(a.dryRun, 'dryRun');
    const bulk = a.confirmAll === undefined ? false : flag(a.confirmAll, 'confirmAll');
    autoQueueRun(st, a, ctx, out, { all: dry || bulk, dry });
  },

  'combat.autoStep'(st, a, ctx, out) {
    autoQueueRun(st, a, ctx, out);
  },

  'combat.mobAct'(st, a, ctx, out) {
    const c = C(st);
    needActive(c, ctx);
    if (reportPending(c, out)) return;
    delete c.autoPending;
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
    const run = newRun(ctx, autoOptions(c, tv ? a : { ...a, public: false }));
    const plan = planMob(st, ctx, c, m, force);
    if (plan.step.skipped) throw bad(`${m.name}: ${plan.step.skipped}`);
    if (plan.danger) {
      out.result = { sequence: [], preview: holdPreview(st, ctx, c, plan, { tv, public: run.public, i: 0 }) };
      return;
    }
    applyStep(st, ctx, out, c, plan, run, null, 0);
    publishRun(st, ctx, out, c, run, { tv });
  },

  'combat.autoConfirm'(st, a, ctx, out) {
    const c = C(st);
    needActive(c, ctx);
    const pending = c.autoPending;
    if (!pending || pending.id !== a.previewId) throw bad('no matching attack preview');
    if (pending.fingerprint !== autoFingerprint(st, ctx, c, pending.plan.step)) throw bad('the attack preview is stale; dismiss it and roll again');
    const run = newRun(ctx, { public: pending.public });
    const q = pending.queued ? c.autoQueue : null;
    delete c.autoPending;
    applyStep(st, ctx, out, c, pending.plan, run, q, pending.i);
    publishRun(st, ctx, out, c, run, { tv: pending.tv, ...(q ? { left: queueRemaining(c, q) } : {}) });
  },

  'combat.autoCancel'(st, a, ctx, out) {
    const c = C(st);
    needActive(c, ctx);
    const pending = c.autoPending;
    if (!pending || pending.id !== a.previewId) throw bad('no matching attack preview');
    if (pending.queued && c.autoQueue && pending.fingerprint === autoFingerprint(st, ctx, c, pending.plan.step)) {
      c.autoQueue.done++;
      if (!queueRemaining(c, c.autoQueue)) c.autoQueue = null;
    }
    delete c.autoPending;
    out.result = { previewId: pending.id };
  },

  /** Undo one attack, with a compatibility path for historical saves. */
  'combat.autoUndo'(st, a, ctx, out) {
    const c = C(st);
    const entry = restoreAuto(st, c, ctx, out);
    if (entry) {
      out.emit({ kind: 'combat.autoUndo', autoId: entry.id }, 'all');
      out.result = { autoId: entry.id, restored: entry.restored };
      return;
    }
    const la = c.lastAuto;
    if (!la?.undo || la.undone) throw bad('nothing to undo');
    const t = hpTrackOf(ctx.pack);
    const restored = [];
    for (const [pid, u] of Object.entries(la.undo.crawlers)) {
      const p = st.players.find((x) => x.id === pid);
      if (!p) continue;
      if (t && u.track === t.id) setTrack(st, p, u.taken !== undefined ? { track: t.id, delta: u.taken } : { track: t.id, cur: u.cur }, ctx, out);
      const drop = new Set(u.buffs);
      p.sheet.buffs = p.sheet.buffs.filter((b) => !drop.has(b.uid));
      restored.push(p.name);
    }
    c.spreadNext = la.undo.spreadNext ?? c.spreadNext;
    if (la.undo.stats) c.stats = la.undo.stats;
    la.undone = true;
    if (c.autoQueue?.id === la.id) c.autoQueue = null;
    delete c.autoPending;
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
    ...(c.lastKill?.playerId ? { finalBlowPlayerId: c.lastKill.playerId } : {}),
    tracked: per.some((x) => x.dealt > 0),
  };
}

export const AUTO_ACTIONS = Object.keys(AUTO_GM);
