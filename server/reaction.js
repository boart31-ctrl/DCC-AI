// Reaction rounds: combat for games where the GM never rolls a d20 (the crawler family). Pure + browser-safe.
//
// One round in five steps:
//   declare   the GM announces every mob's attack and target (or "Suggest": the book's rule of thumb)
//   react     crawlers spend actions on interrupts: Evade · Intervene · Catcher · Heal · Taunt
//   resolve   every crawler who evades rolls once per attack aimed at them; attacks that land deal damage
//             (rolled by the GM side, DR applied), with the degree of the Evade roll deciding extras
//   act       crawlers spend what is left (attacks go through the normal sheet rolls)
//   cleanup   end of round; then a new round starts at declare
// Each crawler has 2 actions a round (interrupts come out of the same 2). AI Favor can buy one more
// non-attack action once per round (the GM grants it).
//
// state.combat.rx = { combatId, round, step, decls: [Decl], acts: { uid: left }, nonAttackActions: { uid: left }, evading: [uid], favor: [uid],
//                     intervene: [uid], log: [text] }
//   Decl = { id, mobUid, attack: { name, damage, dc }, targetUid, caught, taunted, evade: null | { die, total,
//            degree }, result: null | 'evaded' | 'half' | 'hit', damage: null | number }
//
// Difficulty of an Evade check = outcome.js mobAttackDc: the attack's `dc` when the content has one, else
// mob base (10 by default) + to-hit bonus, + the world's floor when the ruleset is floor-scaled.
import { bad, notFound } from './errors.js';
import { rollDice } from './formula.js';
import { computeFor, libraryOf, nextInjuryDescription, SHEET, requireStatusAllowed, setTrack, statusBlocker } from './character.js';
import { sheetResolver } from './ruleset.js';
import { evaluate } from './formula.js';
import { COMBAT_GM, defenseOf, hpTrackOf, MAX_MOB_HP } from './combat.js';
import { combatRules, mobAttackDc, floorOfState, typedDamage } from './outcome.js';
import { advanceGameTime } from './crawlers.js';

export const STEPS = ['declare', 'react', 'resolve', 'act', 'cleanup'];
export const ACTIONS_PER_ROUND = 2;
export const INTERRUPTS = ['evade', 'intervene', 'catcher', 'heal', 'taunt'];
export const MAX_DECLS = 80;
const MAX_LOG = 40;

/** Seven degrees: crit / amazing / success / near (miss by 1–2) / fail / major (miss by 10+) / critfail. */
export function degreeOf(die, total, difficulty) {
  if (die === 20) return 'crit';
  if (die === 1) return 'critfail';
  const m = total - difficulty;
  if (m >= 10) return 'amazing';
  if (m >= 0) return 'success';
  if (m >= -2) return 'near';
  if (m > -10) return 'fail';
  return 'major';
}
export const DEGREE_LABEL = { crit: 'Critical!', amazing: 'Amazing success', success: 'Success', near: 'Near miss', fail: 'Fail', major: 'Major fail', critfail: 'Critical fail' };
export const isSuccess = (d) => d === 'crit' || d === 'amazing' || d === 'success';

const C = (st) => st.combat;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const standing = (x) => !!x && !x.dead && x.dying == null;

function rxOf(st) {
  const c = C(st);
  if (!c?.active) throw bad('no fight running');
  if (!isObj(c.rx) || c.rx.combatId !== c.id) {
    c.rx = { combatId: c.id, round: c.round || 1, step: 'declare', decls: [], acts: {}, evading: [], favor: [], intervene: [], log: [] };
    resetActs(st);
  }
  return c.rx;
}
function crawlers(st) {
  return C(st).combatants.filter((x) => x.type === 'crawler');
}
const playerOfCrawler = (st, x) => st.players.find((p) => p.id === x?.playerId);
function resetActs(st) {
  const rx = C(st).rx;
  rx.acts = Object.fromEntries(crawlers(st).map((x) => [x.uid, ACTIONS_PER_ROUND]));
  rx.evading = [];
  rx.favor = [];
  rx.nonAttackActions = {};
  rx.intervene = [];
}
function log(rx, text) {
  rx.log.push(text);
  if (rx.log.length > MAX_LOG) rx.log.splice(0, rx.log.length - MAX_LOG);
}
function mobOf(st, uid) {
  const m = C(st).combatants.find((x) => x.uid === uid && x.type === 'mob');
  if (!m) throw notFound(`no mob ${uid}`);
  return m;
}
function crawlerOf(st, uid) {
  const x = C(st).combatants.find((y) => y.uid === uid && y.type === 'crawler');
  if (!x) throw notFound(`no crawler ${uid}`);
  return x;
}
function declOf(rx, id) {
  const d = rx.decls.find((x) => x.id === id);
  if (!d) throw notFound(`no declared attack ${id}`);
  return d;
}
function evadeOptions(rx, d, target, interruptBlocked = false) {
  const eligible = !d.caught && !d.result && standing(target);
  const freeEvade = eligible && (d.adv === 'dis' || d.tauntEvade === true) && !d.evade;
  const paid = eligible && !interruptBlocked && rx.evading.includes(d.targetUid);
  const canReroll = paid && d.evade?.free === true && !isSuccess(d.evade.degree);
  return { freeEvade, canEvade: freeEvade || (paid && !d.evade) || canReroll, canReroll };
}
const nameOf = (st, x) => (x.type === 'mob' ? x.name : st.players.find((p) => p.id === x.playerId)?.name ?? '?');

/** Difficulty of evading this attack (see header; floor-scaled rulesets add the current floor). */
export function attackDc(attack, rules = { mobBase: 0, floorScaled: false }, floor = 1) {
  return mobAttackDc(rules, attack, floor);
}

export function spendReactionAction(rx, uid, n = 1, { attack = false } = {}) {
  const left = rx.acts[uid] ?? ACTIONS_PER_ROUND;
  const extra = attack ? 0 : Math.min(n, rx.nonAttackActions?.[uid] ?? 0);
  if (left + extra < n) throw bad('no actions left this round');
  if (extra) rx.nonAttackActions[uid] -= extra;
  rx.acts[uid] = left + extra - n;
}

export function actionReceipt(rx, uid, spent) {
  return { spent, actionsLeft: rx.acts[uid] ?? ACTIONS_PER_ROUND, utilityLeft: rx.nonAttackActions?.[uid] ?? 0 };
}

function reactionDie(a, key, sides, ctx) {
  if (a.digital !== undefined && typeof a.digital !== 'boolean') throw bad('digital must be a boolean');
  if (a.digital && a[key] !== undefined) throw bad('choose a phone roll or enter a die face');
  const face = a.digital ? (ctx.dieInt ?? ctx.rollInt ?? ctx.randInt)(sides) + 1 : a[key];
  if (!Number.isInteger(face) || face < 1 || face > sides) throw bad(`${key} must be 1..${sides}`);
  return face;
}

function buyFavorAction(st, ctx, out, x) {
  const rx = rxOf(st);
  if (!standing(x)) throw bad('that crawler cannot act');
  if (!['react', 'act'].includes(rx.step)) throw bad('not now');
  if (rx.favor?.includes(x.uid)) throw bad('already used AI Favor for an action this round');
  const fdef = ctx.pack.ruleset.fields.find((f) => f.id === 'aiFavor');
  if (!fdef) throw bad('this game has no AI Favor');
  const p = st.players.find((y) => y.id === x.playerId);
  if (!p) throw notFound('that crawler is no longer in the party');
  requireStatusAllowed(st, ctx, p, 'action');
  const favor = Number(p.sheet.fields?.aiFavor ?? fdef.default ?? 0);
  if (!(favor >= 1)) throw bad('no AI Favor left');
  p.sheet.fields = { ...(p.sheet.fields ?? {}), aiFavor: favor - 1 };
  (rx.favor ??= []).push(x.uid);
  (rx.nonAttackActions ??= {})[x.uid] = 1;
  out.result = { favor: favor - 1, nonAttackActions: 1, receipt: actionReceipt(rx, x.uid, 0) };
}

function crawlerEvade(st, ctx, x) {
  const p = st.players.find((y) => y.id === x.playerId);
  try {
    const d = defenseOf(ctx.pack, computeFor(p, ctx.pack, libraryOf(st, ctx.pack)).computed);
    return d.evade + (combatRules(ctx.pack, C(st).settings).evadeBase || 0);
  } catch { return 0; }
}

function declaredAttack(st, ctx, mob, index) {
  const atk = Number.isInteger(index) && mob.attacks?.[index];
  if (!atk) throw bad(`${mob.name} has no attack ${index}`);
  return {
    name: atk.name || 'Attack', damage: atk.damage || '0', dc: attackDc(atk, combatRules(ctx.pack, C(st).settings), mob.flat ? 0 : floorOfState(st)),
    area: !!atk.area, dtype: atk.dtype, effects: atk.effects, buffs: atk.buffs ?? [], majorFailBuffs: atk.majorFailBuffs ?? [],
  };
}

function addDecl(st, ctx, rx, mob, attackIndex = 0, targetUid) {
  if (rx.decls.length >= MAX_DECLS) throw bad(`max ${MAX_DECLS} declared attacks`);
  if (mob.hp <= 0) throw bad(`${mob.name} is down`);
  requireStatusAllowed(st, ctx, mob, 'action');
  const t = crawlerOf(st, targetUid);
  if (t.dead) throw bad('that crawler is already dead');
  const d = { id: ctx.genId('dc'), mobUid: mob.uid, attackIndex, attack: declaredAttack(st, ctx, mob, attackIndex), targetUid: t.uid, caught: false, taunted: false, evade: null, result: null, damage: null };
  rx.decls.push(d);
  return d;
}

const SUGGESTION_HELP = {
  'no-crawlers': ['add-crawlers', 'Add a crawler to the fight before queuing an attack.'],
  'no-standing-crawlers': ['end-combat', 'No crawler is standing. End combat or let the party recover.'],
  'no-targets': ['review-targets', 'All standing crawlers are marked Don’t target. Update targeting or choose a target manually.'],
  'no-mobs': ['add-mobs', 'No mobs are in the fight. Add mobs or choose a saved encounter.'],
  'all-mobs-down': ['end-combat', 'All mobs are down. End combat or add reinforcements.'],
  'no-attacks': ['add-attacks', 'No standing mob has a recorded attack. Choose a mob with attacks or let the crawlers act.'],
  blocked: ['review-conditions', 'Conditions prevent every armed mob from acting. Review conditions or let the crawlers act.'],
  'hidden-excluded': ['include-hidden', 'Only hidden mobs can attack. Include hidden mobs or let the crawlers act.'],
  'already-queued': ['announce', 'Eligible attacks are already queued. Announce them when ready.'],
  'queue-full': ['announce', 'The attack queue is full. Announce it or remove rows to fit more attacks.'],
};

function suggestionHint(reason, next = 'suggest') {
  const [action, message] = SUGGESTION_HELP[reason] ?? [next, null];
  return { reason, next: action, message };
}

function suggestionRoster(st, pack, library, includeHidden = true) {
  const members = new Map(st.players.map((p) => [p.id, p]));
  const party = crawlers(st).filter((x) => members.has(x.playerId));
  const hp = hpTrackOf(pack)?.id;
  const up = party.filter((x) => {
    const track = hp && members.get(x.playerId).sheet?.tracks?.[hp];
    const current = typeof track === 'number' ? track : track?.cur ?? track?.value;
    return standing(x) && (current == null || current > 0);
  });
  const targets = up.filter((x) => !x.noTarget);
  const allMobs = C(st).combatants.filter((x) => x.type === 'mob');
  const alive = allMobs.filter((x) => x.hp > 0);
  const armed = alive.filter((x) => x.attacks?.length);
  const eligible = armed.filter((x) => !statusBlocker(x, library, 'action'));
  const mobs = includeHidden ? eligible : eligible.filter((x) => !x.hidden);
  const missing = [
    [party, 'no-crawlers'], [up, 'no-standing-crawlers'], [targets, 'no-targets'],
    [allMobs, 'no-mobs'], [alive, 'all-mobs-down'], [armed, 'no-attacks'],
    [eligible, 'blocked'], [mobs, 'hidden-excluded'],
  ].find(([rows]) => !rows.length);
  const reason = missing?.[1] ?? null;
  return { party, targets, mobs, reason };
}

/** Elites and bosses act once per crawler, other mobs once. Existing rows count toward each quota. */
function fillSuggestions(ctx, roster, declared) {
  const { party, targets, mobs } = roster;
  if (roster.reason) return { plans: [], limited: false };
  const load = new Map(targets.map((t) => [t.uid, 0]));
  const byMob = new Map();
  for (const row of declared) {
    if (load.has(row.targetUid)) load.set(row.targetUid, load.get(row.targetUid) + 1);
    if (!byMob.has(row.mobUid)) byMob.set(row.mobUid, []);
    byMob.get(row.mobUid).push(row);
  }
  const plans = [];
  const pickAttack = (m) => (m.attackMode === 'random' ? Math.floor(ctx.rng() * m.attacks.length) : 0);
  for (const m of mobs) {
    const big = m.sourceKind === 'boss' || m.role === 'elite' || m.role === 'boss';
    const rows = byMob.get(m.uid) ?? [];
    const own = big ? new Map(targets.map((t) => [t.uid, rows.filter((d) => d.targetUid === t.uid).length])) : null;
    const quota = big ? party.length : 1;
    // Extra boss attacks for fallen crawlers still go around the standing targets.
    for (let i = rows.length; i < quota; i++) {
      if (declared.length + plans.length >= MAX_DECLS) return { plans, limited: true };
      let targetUid;
      if (!big && m.targetMode === 'focus' && load.has(m.focus)) targetUid = m.focus;
      else {
        let peers = targets;
        if (own) {
          const fewestOwn = Math.min(...own.values());
          peers = targets.filter((t) => own.get(t.uid) === fewestOwn);
        }
        const minLoad = Math.min(...peers.map((t) => load.get(t.uid)));
        const pool = peers.filter((t) => load.get(t.uid) === minLoad);
        targetUid = pool[Math.floor(ctx.rng() * pool.length)].uid;
      }
      load.set(targetUid, load.get(targetUid) + 1);
      if (own) own.set(targetUid, own.get(targetUid) + 1);
      plans.push({ mobUid: m.uid, attackIndex: pickAttack(m), targetUid });
    }
  }
  return { plans, limited: false };
}

export function suggestDecls(st, ctx, { includeHidden = true, declared = [] } = {}) {
  const roster = suggestionRoster(st, ctx.pack, libraryOf(st, ctx.pack), includeHidden);
  return fillSuggestions(ctx, roster, declared).plans;
}

function validateAnnouncement(st, ctx, declarations) {
  const actors = new Map(C(st).combatants.map((x) => [x.uid, x]));
  const library = libraryOf(st, ctx.pack);
  for (const d of declarations) {
    const mob = actors.get(d.mobUid);
    const target = actors.get(d.targetUid);
    if (mob?.type !== 'mob' || mob.hp <= 0 || statusBlocker(mob, library, 'action')) {
      throw bad(`Remove the queued ${d.attack.name} attack. Its attacker can no longer act.`);
    }
    if (target?.type !== 'crawler' || target.dead || !playerOfCrawler(st, target)) {
      throw bad(`Choose an available crawler for ${mob.name}'s ${d.attack.name}.`);
    }
  }
}

function attackResult(st, ctx, d) {
  const mob = C(st).combatants.find((x) => x.uid === d.mobUid);
  const target = C(st).combatants.find((x) => x.uid === d.targetUid);
  if (!mob || mob.hp <= 0 || !target || target.dead) return { mob, target, result: 'evaded' };
  if (mob.conditions?.length) {
    const blocked = statusBlocker(mob, libraryOf(st, ctx.pack), 'action');
    if (blocked) return { mob, target, result: 'evaded', message: `${mob.name} cannot attack due to ${blocked}.` };
  }
  const deg = d.evade?.degree ?? null;
  // Splash ring of an area attack: half damage, a successful Evade there leaves a quarter.
  let mult = d.splash ? 0.5 : 1;
  if (deg && isSuccess(deg)) {
    if (!d.attack.area) return { mob, target, result: 'evaded', message: `${nameOf(st, target)} evades ${mob.name}'s ${d.attack.name}.` };
    mult *= 0.5;
  }
  if (deg === 'critfail') mult *= 2;
  return {
    mob, target, result: mult < 1 ? 'half' : 'hit', mult,
    bonus: deg === 'major' ? floorOfState(st) : 0,
    injury: deg === 'critfail' ? 'major' : deg === 'major' ? 'minor' : null,
  };
}

function rollAttack(st, ctx, d) {
  try {
    const roll = rollDice(d.attack.damage, {
      resolve: (name) => name === 'floor' ? floorOfState(st) : undefined, randInt: ctx.dieInt ?? ctx.rollInt ?? ctx.randInt,
    });
    return { raw: roll.total, die: roll.dice };
  } catch { /* Bad legacy damage formula. */ }
  return { raw: 0, die: [] };
}

function resolveDecl(st, ctx, out, rx, d, roll, project = false) {
  ctx = { ...ctx, reactionHit: true };
  const plan = attackResult(st, ctx, d);
  const { mob, target, result, mult, bonus, injury, message } = plan;
  d.result = result;
  if (result === 'evaded') {
    d.damage = 0;
    if (message && !mob?.hidden) log(rx, message);
    return;
  }
  const amount = Math.max(0, Math.min(MAX_MOB_HP, Math.floor((roll.raw ?? 0) * mult) + bonus));
  d.damage = amount;
  let immune = false;
  if (amount > 0) {
    const sub = { ...out, result: undefined, emit: (event, audience) => out.emit(event.kind === 'combat.hit' ? { ...event, animation: 'reaction' } : event, audience) };
    const wasDying = target.type === 'crawler' && target.dying != null;
    COMBAT_GM['combat.damage'](st, { uid: target.uid, amount, dr: true, dtype: d.attack.dtype, ...(project ? { line: false } : {}) }, ctx, sub);
    if (sub.result?.slotValue) d.slots = sub.result.actualAmount ?? 0;
    d.damageAfterDr = sub.result?.rolled;
    immune = sub.result?.typed === 'immune';
    if (!sub.result?.blocked) onCrawlerDamage(st, ctx, out, target, wasDying);
  } else if (d.attack.dtype) {
    const p = playerOfCrawler(st, target);
    const protections = p && computeFor(p, ctx.pack, libraryOf(st, ctx.pack)).computed.buffs;
    immune = typedDamage(0, d.attack.dtype, target, protections).why === 'immune';
  }
  const source = mob.hidden ? 'An unseen attacker' : mob.name;
  const attack = mob.hidden ? '' : ` with ${d.attack.name}`;
  log(rx, `${source} hits ${nameOf(st, target)}${attack}: ${amount} HP${d.slots == null ? '' : ` → ${d.slots} slots`}.`);
  if (immune) return;
  // Injuries after the fight (ruleset combat.injuries): Evade Major Fail → minor, natural 1 → major.
  if (target.type === 'crawler' && injury && ctx.pack.ruleset.combat?.injuries) {
    markInjury(st, ctx, target, injury);
  }
  const buffs = new Set([...(d.attack.buffs ?? []), ...(injury ? d.attack.majorFailBuffs ?? [] : [])]);
  if (!buffs.size) return;
  const library = libraryOf(st, ctx.pack);
  for (const buffId of buffs) {
    if (library.get('buff', buffId)) COMBAT_GM['combat.condition'](st, { uid: target.uid, buffId, on: true }, ctx, { ...out, result: undefined });
  }
}

function markInjury(st, ctx, target, severity, description) {
  const rules = ctx.pack.ruleset.combat?.injuries;
  if (!rules) throw bad('injuries are unavailable in this campaign');
  if (!['minor', 'major'].includes(severity)) throw bad('severity must be minor or major');
  if (description !== undefined && (typeof description !== 'string' || description.trim().length > 180)) throw bad('description must be at most 180 characters');
  const injuries = target.injuries ??= [];
  if (injuries.length >= 10) return;
  const p = st.players.find((x) => x.id === target.playerId);
  if (!p) return;
  injuries.push({ id: ctx.genId('inj'), severity, desc: nextInjuryDescription(p, rules, severity, description) });
}

const unresolved = (rx) => rx.decls.filter((d) => !d.result);
const sameResolution = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function resolvedTarget(st, ctx, d, library = libraryOf(st, ctx.pack)) {
  const x = st.combat.combatants.find((y) => y.uid === d.targetUid);
  const p = playerOfCrawler(st, x);
  const track = hpTrackOf(ctx.pack)?.id;
  if (!p || !track) return null;
  return {
    playerId: p.id, track, hp: computeFor(p, ctx.pack, library).computed.tracks[track].cur,
    stored: structuredClone(p.sheet.tracks[track] ?? null), buffs: structuredClone(p.sheet.buffs),
    dying: x.dying ?? null, dead: x.dead ?? null, injuries: structuredClone(x.injuries ?? null),
    injuryTally: structuredClone(p.injuryTally ?? null), taken: st.combat.stats.taken[p.id] ?? null, downs: st.combat.stats.downs[p.id] ?? null,
  };
}

function resolutionImpact(st, ctx, out, rx, d, roll, project, library) {
  const mob = st.combat.combatants.find((x) => x.uid === d.mobUid);
  const target = st.combat.combatants.find((x) => x.uid === d.targetUid);
  const before = resolvedTarget(st, ctx, d, library);
  resolveDecl(st, ctx, out, rx, d, roll, project);
  const after = resolvedTarget(st, ctx, d, library);
  const injury = after?.injuries?.length > (before?.injuries?.length ?? 0) ? after.injuries.at(-1) : null;
  const down = before?.hp > 0 && after?.hp === 0;
  const danger = after?.dead && !before?.dead ? 'dead' : after?.dying != null && before?.dying == null ? 'dying' : down ? 'down' : null;
  const hit = {
    declId: d.id, mobUid: d.mobUid, mob: mob?.name ?? '?', targetUid: d.targetUid, target: target ? nameOf(st, target) : '?',
    attack: d.attack.name, evade: d.evade ? { degree: d.evade.degree, label: DEGREE_LABEL[d.evade.degree], die: d.evade.die } : null,
    die: roll.die, formula: d.attack.damage, raw: roll.raw, damage: d.damage, afterDr: d.damageAfterDr ?? null,
    slots: Math.max(0, (before?.hp ?? 0) - (after?.hp ?? 0)), before: before?.hp ?? null, after: after?.hp ?? null,
    dyingBefore: before?.dying ?? null, dyingAfter: after?.dying ?? null, deadBefore: !!before?.dead, deadAfter: !!after?.dead,
    down: after?.hp === 0, danger, injury: injury ? { severity: injury.severity, desc: injury.desc } : null, result: d.result,
  };
  return { hit, before, after };
}

function redirectResolution(rx, d) {
  const targetUid = rx.resolutionTargets?.[d.id];
  if (targetUid && targetUid !== d.targetUid) Object.assign(d, { targetUid, evade: null, caught: false, taunted: false });
}

/** Run the real resolution logic against copies of the party and combat state for an exact, side-effect-free quote. */
function projectResolution(st, ctx, rx, ready, allowRoll) {
  const combat = st.combat;
  const simulated = { ...rx, decls: structuredClone(rx.decls), log: [...rx.log] };
  const sim = { ...st, combat: { ...combat, combatants: structuredClone(combat.combatants), stats: structuredClone(combat.stats), rx: simulated }, players: st.players.map((p) => ({
    ...p, sheet: structuredClone(p.sheet), injuryTally: structuredClone(p.injuryTally),
  })) };
  let counter = 0;
  const shadow = { ...ctx, genId: () => `preview-${++counter}` };
  const out = { emit() {}, lines: [] };
  const library = libraryOf(st, ctx.pack);
  return ready.map((original) => {
    const d = declOf(simulated, original.id);
    redirectResolution(rx, d);
    let roll = rx.resolutionRolls?.[d.id];
    if (!roll && attackResult(sim, ctx, d).result !== 'evaded') {
      if (!allowRoll) throw bad('the fight changed, preview the damage again');
      roll = (rx.resolutionRolls ??= {})[d.id] = rollAttack(sim, ctx, d);
    }
    return resolutionImpact(sim, shadow, out, simulated, d, roll ?? { raw: null, die: [] }, true, library).hit;
  });
}

function quoteResolution(st, ctx, rx, ready, all) {
  const hits = projectResolution(st, ctx, rx, ready, true);
  const token = ctx.genId('rxp');
  if (all) {
    const victims = [...new Map(hits.filter((hit) => hit.danger).map((hit) => [hit.targetUid, { uid: hit.targetUid, name: hit.target, danger: hit.danger }])).values()];
    delete rx.pending;
    rx.batch = { token, hits, count: hits.length, victims };
    return rx.batch;
  }
  delete rx.batch;
  if (!hits.length) { delete rx.pending; return null; }
  rx.pending = { token, ...hits[0] };
  return rx.pending;
}

function quoteWithToken(a, quote) {
  if (!quote || typeof a.token !== 'string' || a.token !== quote.token) throw bad('preview the damage again');
}

function restoreImpact(st, d, before) {
  if (!before) return;
  const x = st.combat.combatants.find((y) => y.uid === d.targetUid);
  const p = st.players.find((y) => y.id === before.playerId);
  const set = (obj, key, value) => { if (value === null) delete obj[key]; else obj[key] = value; };
  set(p.sheet.tracks, before.track, before.stored);
  p.sheet.buffs = before.buffs;
  for (const key of ['dying', 'dead', 'injuries']) set(x, key, before[key]);
  set(p, 'injuryTally', before.injuryTally);
  for (const key of ['taken', 'downs']) set(st.combat.stats[key], p.id, before[key]);
}

function resolveNext(st, a, ctx, out) {
  const rx = rxOf(st);
  const op = a.op ?? 'preview';
  if (rx.step !== 'resolve' && !(op === 'undo' && rx.step === 'act')) throw bad('enter the Resolve step first');
  const all = a.all === true;
  if (all && !['preview', 'apply'].includes(op)) throw bad('batch resolution supports preview and apply');
  if (op === 'undo') {
    const entry = rx.resolutionUndo?.at(-1);
    if (!entry) throw bad('no applied hit to undo');
    const d = declOf(rx, entry.decl.id);
    if (!sameResolution(resolvedTarget(st, ctx, d), entry.after)) throw bad('the target changed after that hit');
    restoreImpact(st, d, entry.before);
    rx.decls[rx.decls.indexOf(d)] = entry.decl;
    rx.resolutionUndo.pop();
    rx.step = 'resolve';
    log(rx, 'Undid a resolved attack.');
    out.emit({ kind: 'rx.undo', combatId: rx.combatId, declId: d.id, targetUid: d.targetUid, round: rx.round }, 'all');
    out.result = quoteResolution(st, ctx, rx, unresolved(rx).slice(0, 1), false);
    return;
  }
  const ready = all ? unresolved(rx) : unresolved(rx).slice(0, 1);
  if (!ready.length) throw bad('no unresolved attacks');
  if (op === 'preview') { out.result = quoteResolution(st, ctx, rx, ready, all); return; }
  const quote = all ? rx.batch : rx.pending;
  quoteWithToken(a, quote);
  if (op === 'change' || op === 'redirect') {
    const d = ready[0];
    if (op === 'change') {
      if (!Number.isInteger(a.amount) || a.amount < 0 || a.amount > MAX_MOB_HP) throw bad(`damage must be 0..${MAX_MOB_HP}`);
      (rx.resolutionRolls ??= {})[d.id] = { raw: a.amount, die: [] };
    } else {
      const target = crawlerOf(st, a.targetUid);
      if (target.dead) throw bad('that crawler is already dead');
      (rx.resolutionTargets ??= {})[d.id] = target.uid;
    }
    out.result = quoteResolution(st, ctx, rx, ready, false);
    return;
  }
  if (op === 'skip') {
    Object.assign(ready[0], { result: 'skipped', damage: 0 });
    log(rx, 'Skipped a declared attack.');
  } else if (op === 'apply') {
    const { token, ...single } = quote;
    const hits = all ? quote.hits : [single];
    if (!sameResolution(projectResolution(st, ctx, rx, ready, false), hits)) throw bad('the fight changed, preview the damage again');
    if ((all || hits[0].danger) && a.confirm !== true) throw bad('confirm the preview before applying damage');
    const library = libraryOf(st, ctx.pack);
    for (const d of ready) {
      const decl = structuredClone(d);
      redirectResolution(rx, d);
      const roll = rx.resolutionRolls?.[d.id] ?? { raw: null, die: [] };
      const { hit, before, after } = resolutionImpact(st, ctx, out, rx, d, roll, false, library);
      (rx.resolutionUndo ??= []).push({ decl, before, after, at: ctx.now });
      const { declId, mobUid, mob, targetUid, target, attack, result, damage, slots, danger, down, dyingBefore, dyingAfter, deadBefore, deadAfter } = hit;
      const hidden = st.combat.combatants.find((x) => x.uid === mobUid)?.hidden;
      const attacker = hidden ? { mobUid: null, mob: 'Unseen attacker', attack: 'Attack' } : { mobUid, mob, attack };
      out.emit({ kind: 'rx.hit', combatId: rx.combatId, round: rx.round, declId, ...attacker, targetUid, target, result, damage, slots, danger, down,
        hpBefore: hit.before, hpAfter: hit.after, dyingBefore, dyingAfter, deadBefore, deadAfter }, 'all');
    }
  } else throw bad('unknown resolution operation');
  delete rx.pending;
  delete rx.batch;
  const remaining = unresolved(rx).length;
  if (!remaining) out.emit({ kind: 'rx.resolved', round: rx.round }, 'all');
  out.result = { remaining };
}

export const REACTION_GM = {
  'combat.injury'(st, a, ctx) {
    if (!C(st).active) throw bad('start combat to record an injury');
    markInjury(st, ctx, crawlerOf(st, a.uid), a.severity, a.description);
  },

  'combat.injury.remove'(st, a) {
    if (typeof a.injuryId !== 'string') throw bad('injuryId required');
    const target = crawlerOf(st, a.uid);
    target.injuries = (target.injuries ?? []).filter((injury) => injury.id !== a.injuryId);
  },

  /** Start (or re-sync) reaction rounds for the running fight. */
  'rx.start'(st) {
    const rx = rxOf(st);
    if (rx.step !== 'declare') throw bad('reaction rounds are already in progress');
    rx.step = 'declare';
  },

  /** `{ mobUid, attackIndex?, targetUid }` → result `{ declId }` */
  'rx.declare'(st, a, ctx, out) {
    const rx = rxOf(st);
    if (rx.step !== 'declare') throw bad('attacks are declared in the declare step');
    const d = addDecl(st, ctx, rx, mobOf(st, a.mobUid), a.attackIndex, a.targetUid);
    out.result = { declId: d.id };
  },

  /** Edit a declaration while the GM is still planning. */
  'rx.retarget'(st, a, ctx) {
    const rx = rxOf(st);
    if (rx.step !== 'declare') throw bad('targets change in the declare step');
    const d = declOf(rx, a.declId);
    if (a.targetUid !== undefined) {
      const target = crawlerOf(st, a.targetUid);
      if (target.dead) throw bad('that crawler is already dead');
      d.targetUid = target.uid;
    }
    if (a.attackIndex !== undefined) {
      d.attack = declaredAttack(st, ctx, mobOf(st, d.mobUid), a.attackIndex);
      d.attackIndex = a.attackIndex;
      d.attack.baseDc = d.attack.dc;
      d.attack.dc += d.adv === 'adv' ? 5 : d.adv === 'dis' ? -5 : 0;
      d.splash = false;
    }
  },

  /**
   * `{ declId, adv: 'adv' | 'dis' | null }` A mob attacks with Advantage (+5 to the Evade difficulty) or
   * Disadvantage (−5 and a free Evade): high ground, cover, darkness, size. Only before the Evade rolls.
   */
  'rx.adv'(st, a) {
    const rx = rxOf(st);
    if (!['declare', 'react'].includes(rx.step)) throw bad('change it before the hits land');
    const d = declOf(rx, a.declId);
    if (d.evade) throw bad('already evaded');
    if (![null, 'adv', 'dis'].includes(a.adv ?? null)) throw bad('adv must be adv, dis or null');
    d.attack.baseDc ??= d.attack.dc;
    d.adv = a.adv ?? null;
    d.attack.dc = d.attack.baseDc + (d.adv === 'adv' ? 5 : d.adv === 'dis' ? -5 : 0);
  },

  /**
   * `{ declId, area: null | 'full' | 'splash' }` Area of Effect for this hit: 'full' (evade halves it) or
   * 'splash' (the target stands in the splash ring: half damage, a successful Evade leaves a quarter).
   */
  'rx.area'(st, a) {
    const rx = rxOf(st);
    if (!['declare', 'react'].includes(rx.step)) throw bad('change it before the hits land');
    const d = declOf(rx, a.declId);
    if (d.result) throw bad('already resolved');
    if (![null, 'full', 'splash'].includes(a.area ?? null)) throw bad('area must be full, splash or null');
    d.attack.area = !!a.area;
    d.splash = a.area === 'splash';
  },

  'rx.undeclare'(st, a) {
    const rx = rxOf(st);
    if (rx.step !== 'declare') throw bad('attacks change in the declare step');
    declOf(rx, a.declId);
    rx.decls = rx.decls.filter((x) => x.id !== a.declId);
  },

  /** Fill the remaining action slots, including eligible hidden mobs by default. */
  'rx.suggest'(st, a, ctx, out) {
    const rx = rxOf(st);
    if (rx.step !== 'declare') throw bad('attacks are declared in the declare step');
    const preserved = rx.decls.length;
    const roster = suggestionRoster(st, ctx.pack, libraryOf(st, ctx.pack), a.includeHidden !== false);
    const { plans, limited } = fillSuggestions(ctx, roster, rx.decls);
    for (const s of plans) addDecl(st, ctx, rx, mobOf(st, s.mobUid), s.attackIndex, s.targetUid);
    const hidden = new Set(C(st).combatants.filter((m) => m.type === 'mob' && m.hidden).map((m) => m.uid));
    const count = rx.decls.length;
    const reason = limited ? 'queue-full' : plans.length ? null : roster.reason ?? 'already-queued';
    out.result = { count, added: plans.length, preserved, hidden: rx.decls.filter((d) => hidden.has(d.mobUid)).length, limited,
      ...suggestionHint(reason, 'announce') };
    if (!plans.length) out.changed = false;
  },

  /** `{ to }` one of STEPS. Resolve opens the queue without inflicting damage (missing Evades: `force`). */
  'rx.step'(st, a, ctx, out) {
    const rx = rxOf(st);
    if (!STEPS.includes(a.to)) throw bad(`to must be one of ${STEPS.join(', ')}`);
    if (a.to === rx.step && !(a.to === 'resolve' && a.all === true)) { out.changed = false; return; }
    if (a.to === 'declare') throw bad('clean up the round before declaring attacks again');
    if (a.to === 'react' && rx.step !== 'declare') throw bad('announce attacks from the Declare step');
    if (a.to === 'resolve' && rx.step !== 'resolve') {
      if (rx.step !== 'react') throw bad('announce the attacks before resolving damage');
      const byUid = new Map(crawlers(st).map((x) => [x.uid, x]));
      const library = libraryOf(st, ctx.pack);
      const missing = rx.decls.filter((d) => {
        const target = byUid.get(d.targetUid);
        return !d.evade && evadeOptions(rx, d, target, !!statusBlocker(playerOfCrawler(st, target), library, 'interrupt')).canEvade;
      });
      if (missing.length && a.force !== true) {
        out.result = { waiting: missing.map((d) => d.id) };
        throw bad(`${missing.length} Evade roll${missing.length === 1 ? '' : 's'} missing`);
      }
      rx.step = 'resolve';
      if (a.all === true && unresolved(rx).length) resolveNext(st, { ...a, op: a.token ? 'apply' : 'preview' }, ctx, out);
      else if (!unresolved(rx).length) out.emit({ kind: 'rx.resolved', round: rx.round }, 'all');
      return;
    }
    if (a.to === 'resolve' && a.all === true) {
      resolveNext(st, { ...a, op: a.token ? 'apply' : 'preview' }, ctx, out);
      return;
    }
    if (unresolved(rx).length && ['act', 'cleanup'].includes(a.to)) {
      throw bad('resolve or skip the remaining attacks first');
    }
    if (a.to === 'react' && rx.step === 'declare') {
      validateAnnouncement(st, ctx, rx.decls);
      for (const uid of new Set(rx.decls.map((d) => d.mobUid))) {
        const m = C(st).combatants.find((x) => x.uid === uid);
        if (m?.hidden) COMBAT_GM['combat.reveal'](st, { uid }, ctx, { ...out, result: undefined });
      }
      out.emit({ kind: 'rx.react', round: rx.round, targets: [...new Set(rx.decls.map((d) => d.targetUid))] }, 'all');
    }
    rx.step = a.to;
  },

  'rx.resolveNext': resolveNext,

  /**
   * The crawlers surprised the mobs (Stealth / Ambush beat their Surprise): before round 1 every crawler gets
   * one free action, the mobs do nothing. Then rx.round starts round 1 as usual.
   */
  'rx.surprise'(st, a, ctx, out) {
    const rx = rxOf(st);
    if (rx.round !== 1 || rx.step !== 'declare' || rx.decls.length || rx.surprised) throw bad('only before the first round');
    rx.surprised = true;
    rx.round = 0;
    C(st).round = 0;
    rx.step = 'act';
    for (const x of crawlers(st)) rx.acts[x.uid] = 1;
    log(rx, 'Surprise! The crawlers get one free action each.');
    out.emit({ kind: 'rx.surprise' }, 'all');
  },

  /** Clean up and start the next round at declare. */
  'rx.round'(st, a, ctx, out) {
    const rx = rxOf(st);
    if (a.round !== undefined) {
      if (!Number.isInteger(a.round) || a.round < 0) throw bad('round must be a nonnegative integer');
      if (a.round > rx.round) throw bad('that round has not started');
      if (a.round < rx.round) { out.result = { round: rx.round, existing: true }; out.changed = false; return; }
    }
    if (unresolved(rx).length) throw bad('resolve or skip the remaining attacks first');
    debuffTicks(st, ctx, out, rx);
    dyingTick(st, ctx, out, 'cleanup');
    if (rx.round > 0) advanceGameTime(st, ctx.pack.ruleset.combat.roundSeconds, out);
    rx.round += 1;
    C(st).round = rx.round;
    rx.step = 'declare';
    rx.decls = [];
    for (const key of ['pending', 'batch', 'resolutionRolls', 'resolutionTargets', 'resolutionUndo']) delete rx[key];
    resetActs(st);
    // Timed mob conditions count down (crawler buffs count down through the sheet's own round tick).
    const library = libraryOf(st, ctx.pack);
    for (const m of C(st).combatants) if (m.type === 'mob') m.conditions = (m.conditions ?? []).flatMap((k) => {
      const rounds = k.rounds ?? library.get('buff', k.id)?.rounds;
      return rounds === 1 ? [] : rounds > 1 ? [{ ...k, rounds: rounds - 1 }] : [k];
    });
    out.emit({ kind: 'rx.round', round: rx.round }, 'all');
    out.result = { round: rx.round };
  },

  /** GM enters an Evade roll for a crawler (physical dice at the table): `{ declId, die }`. */
  'rx.evade'(st, a, ctx, out) { evadeRoll(st, ctx, out, a, null); },

  /** `{ uid, delta }` actions (a debuff or a house rule). */
  'rx.actions'(st, a) {
    const rx = rxOf(st);
    crawlerOf(st, a.uid);
    if (!Number.isInteger(a.delta) || Math.abs(a.delta) > 3) throw bad('delta must be an integer -3..3');
    rx.acts[a.uid] = Math.max(0, Math.min(5, (rx.acts[a.uid] ?? ACTIONS_PER_ROUND) + a.delta));
  },
  'rx.favor'(st, a, ctx, out) { buyFavorAction(st, ctx, out, crawlerOf(st, a.uid)); },
};

/**
 * Clean up: every buff / condition with a `tick` (Blood Trail, Burned, Poisoned…) deals its damage — crawlers
 * from their sheet buffs, mobs from conditions that name a library buff (buffId).
 */
function debuffTicks(st, ctx, out, rx) {
  const lib = libraryOf(st, ctx.pack);
  const F = floorOfState(st);
  const hit = (x, def, who) => {
    let n = 0;
    try { n = rollDice(def.tick.damage, { randInt: ctx.dieInt ?? ctx.rollInt ?? ctx.randInt }).total; } catch { n = 1; }
    n += def.tick.plusFloor ? F : 0;
    if (n <= 0) return;
    const wasDying = x.type === 'crawler' && x.dying != null;
    const sub = { ...out, result: undefined };
    COMBAT_GM['combat.damage'](st, { uid: x.uid, amount: n, rolled: true, dtype: def.tick.type }, ctx, sub);
    if (x.type === 'crawler' && !sub.result?.blocked) onCrawlerDamage(st, ctx, out, x, wasDying);
    log(rx, `${who}: ${def.name} ${n} HP${sub.result?.slotValue ? ` → ${sub.result.actualAmount ?? sub.result.amount ?? 0} slots` : ''}.`);
  };
  for (const x of [...C(st).combatants]) {
    if (x.type === 'crawler') {
      const p = st.players.find((y) => y.id === x.playerId);
      if (!p) continue;
      p.sheet.buffs = p.sheet.buffs.filter((b) => {
        const def = b.buffId ? lib.get('buff', b.buffId) : null;
        if (def?.tick && !x.dead) hit(x, def, p.name);
        const rounds = b.roundsLeft ?? def?.rounds;
        if (rounds) {
          b.roundsLeft = rounds - 1;
          if (b.roundsLeft > 0) b.until = `${b.roundsLeft} round${b.roundsLeft === 1 ? '' : 's'}`;
          return b.roundsLeft > 0;
        }
        return true;
      });
    } else if (x.type === 'mob' && x.hp > 0) {
      for (const k of x.conditions ?? []) { const bid = k.id ?? k.buffId; const def = bid ? lib.get('buff', bid) : null; if (def?.tick) hit(x, def, x.name); }
    }
  }
}

/** Health of a crawler combatant (the sheet's hp track): { cur, max } or null. */
function crawlerHealth(st, ctx, x) {
  const p = st.players.find((y) => y.id === x.playerId);
  const t = hpTrackOf(ctx.pack);
  if (!p || !t) return null;
  const v = p.sheet?.tracks?.[t.id];
  return v ? { p, cur: Number(v.cur ?? v.value ?? 0), max: Number(v.max ?? 0) } : null;
}
/**
 * Dying (ruleset combat.dyingRounds): a crawler at 0 health starts with that many rounds; every clean up (and
 * every hit while dying, `why: 'hit'`) takes one; at 0 the crawler dies. Back above 0 = not dying.
 */
export function dyingTick(st, ctx, out, why, onlyUid = null) {
  const f = ctx.pack.ruleset.combat?.dyingRounds;
  if (!f || !C(st)?.active) return;
  for (const x of C(st).combatants) {
    if (x.type !== 'crawler' || x.dead || (onlyUid && x.uid !== onlyUid)) continue;
    const hp = crawlerHealth(st, ctx, x);
    if (!hp) continue;
    if (hp.cur > 0) { if (x.dying != null) { delete x.dying; out.emit({ kind: 'dying.saved', playerId: x.playerId, name: hp.p.name }, 'all'); } continue; }
    if (x.dying == null) {
      let n = 1;
      try { const { ch, computed } = computeFor(hp.p, ctx.pack, libraryOf(st, ctx.pack)); n = Math.max(1, Math.round(evaluate(f, sheetResolver(computed, ch, ctx.pack.ruleset)).value)); } catch {}
      x.dying = n;
      out.emit({ kind: 'dying', playerId: x.playerId, name: hp.p.name, rounds: n }, 'all');
      continue; // the countdown starts at the next clean up / hit
    }
    x.dying -= 1;
    if (x.dying <= 0) {
      x.dying = 0;
      x.dead = true;
      out.emit({ kind: 'dying.dead', playerId: x.playerId, name: hp.p.name }, 'all');
      log(rxOf(st), `${hp.p.name} died.`);
    } else out.emit({ kind: 'dying', playerId: x.playerId, name: hp.p.name, rounds: x.dying }, 'all');
  }
}

/** After damage to a crawler: a dying one loses a round (dies at 0); one that just hit 0 starts dying. */
export function onCrawlerDamage(st, ctx, out, x, wasDying) {
  if (!ctx.pack.ruleset.combat?.dyingRounds || x?.type !== 'crawler' || x.dead) return;
  if (wasDying && x.dying != null) {
    x.dying -= 1;
    const name = st.players.find((p) => p.id === x.playerId)?.name;
    if (x.dying <= 0) { x.dying = 0; x.dead = true; out.emit({ kind: 'dying.dead', playerId: x.playerId, name }, 'all'); } else out.emit({ kind: 'dying', playerId: x.playerId, name, rounds: x.dying }, 'all');
  } else dyingTick(st, ctx, out, 'hit', x.uid);
}

function evadeRoll(st, ctx, out, a, playerId) {
  const rx = rxOf(st);
  if (rx.step !== 'react') throw bad('it is not the reaction step');
  const d = declOf(rx, a.declId);
  const x = crawlerOf(st, d.targetUid);
  if (playerId && x.playerId !== playerId) throw bad('that attack is not aimed at you');
  if (!standing(x)) throw bad('that crawler cannot act');
  if (d.caught) throw bad('a caught attack cannot be evaded');
  if (d.result) throw bad('already resolved');
  const { freeEvade, canEvade } = evadeOptions(rx, d, x);
  if (!freeEvade) requireStatusAllowed(st, ctx, playerOfCrawler(st, x), 'interrupt');
  if (!canEvade) {
    if (d.evade && (!d.evade.free || isSuccess(d.evade.degree))) throw bad('already evaded');
    throw bad('spend an action on Evade first');
  }
  const die = reactionDie(a, 'die', 20, ctx);
  const total = die + crawlerEvade(st, ctx, x);
  const degree = degreeOf(die, total, d.attack.dc);
  d.evade = { die, total, degree, ...(freeEvade ? { free: true } : {}) };
  // Evade natural 20 / Amazing: Advantage on the next attack against that mob (shown on the phone + TV log).
  if (degree === 'crit' || degree === 'amazing') {
    rx.advantage = [...(rx.advantage ?? []).filter((v) => !(v.uid === x.uid && v.mobUid === d.mobUid)), { uid: x.uid, mobUid: d.mobUid }].slice(-20);
    log(rx, `${nameOf(st, x)} has Advantage on the next attack against ${mobOf(st, d.mobUid).name}.`);
  }
  out.result = { die, total, degree, label: DEGREE_LABEL[degree], near: degree === 'near', free: freeEvade, receipt: actionReceipt(rx, x.uid, 0) };
  out.emit({ kind: 'rx.evade', declId: d.id, uid: x.uid, playerId: x.playerId ?? null, degree, near: degree === 'near' }, 'all');
  // R13: the System comments on a spectacular dodge, a hair-thin miss or a fumble (crawler's side of the roll).
  const evCat = { crit: 'nat20', amazing: 'crit', near: 'near_fail', critfail: 'nat1' }[degree];
  if (evCat && ctx.h?.categoryLine) { const line = ctx.h.categoryLine(st, ctx, evCat, 1); if (line) out.lines.push(line); }
}

export const REACTION_PLAYER = {
  /** `{ kind, declId?, die? }` — spends one action. Catcher / Taunt name the attack they take over. */
  'rx.interrupt'(st, a, ctx, out) {
    const rx = rxOf(st);
    const me = crawlers(st).find((x) => x.playerId === ctx.actor.playerId);
    if (!me) throw bad('you are not in this fight');
    if (!standing(me)) throw bad('that crawler cannot act');
    requireStatusAllowed(st, ctx, playerOfCrawler(st, me), 'interrupt');
    if (!INTERRUPTS.includes(a.kind)) throw bad(`kind must be one of ${INTERRUPTS.join(', ')}`);
    const inReact = rx.step === 'react';
    if (!inReact && !(rx.step === 'act' && (a.kind === 'heal' || a.kind === 'intervene'))) throw bad('interrupts are for the reaction step');
    if (a.kind === 'evade') {
      if (rx.evading.includes(me.uid)) throw bad('already evading this round');
      spendReactionAction(rx, me.uid);
      rx.evading.push(me.uid);
    } else if (a.kind === 'catcher') {
      const d = declOf(rx, a.declId);
      if (d.targetUid === me.uid) throw bad('that attack is already aimed at you');
      spendReactionAction(rx, me.uid);
      Object.assign(d, { targetUid: me.uid, caught: true, taunted: false, tauntEvade: false, evade: null });
    } else if (a.kind === 'taunt') {
      const d = declOf(rx, a.declId);
      if (d.targetUid === me.uid) throw bad('that attack is already aimed at you');
      const mob = mobOf(st, d.mobUid);
      const library = libraryOf(st, ctx.pack);
      const intMod = mob.stats?.int?.mod ?? library.get(mob.sourceKind || 'monster', mob.sourceId)?.stats?.int?.mod ?? 2;
      const dc = 10 + intMod + floorOfState(st);
      const p = st.players.find((x) => x.id === me.playerId);
      const skill = p?.sheet?.skills?.find((s) => s.skillId === 'taunt');
      spendReactionAction(rx, me.uid);
      let ok;
      if (a.die === undefined) {
        if (!Number.isInteger(a.total)) throw bad('enter the Taunt die or check total');
        ok = a.total >= dc;
      } else {
        if (!Number.isInteger(a.die) || a.die < 1 || a.die > 20) throw bad('die must be 1..20');
        const rs = ctx.pack.ruleset;
        const what = skill ? { kind: 'skill', uid: skill.uid }
          : rs.skills?.untrained && library.get('skill', 'taunt') ? { kind: 'untrained', skillId: 'taunt' }
          : rs.stats.some((s) => s.id === 'cha') ? { kind: 'stat', id: 'cha' } : null;
        if (what) {
          const sub = { ...out, result: undefined };
          SHEET.roll(st, { what, entered: a.die, dc, secret: true, card: false }, ctx, sub);
          ok = sub.result.hit;
        } else ok = a.die === 20 || (a.die > 1 && a.die >= dc);
      }
      if (ok) Object.assign(d, { targetUid: me.uid, taunted: true, tauntEvade: (skill?.rank ?? 0) >= 5, caught: false, evade: null });
      out.result = { ok };
    } else if (a.kind === 'heal') {
      const hs = ctx.pack.ruleset.combat.healSpell;
      if (!hs) throw bad('no innate Heal in this campaign');
      if (a.target != null || a.targetUid != null) throw bad('innate Heal targets only yourself');
      const p = playerOfCrawler(st, me);
      requireStatusAllowed(st, ctx, p, 'spell');
      requireStatusAllowed(st, ctx, p, 'heal');
      const { computed } = computeFor(p, ctx.pack, libraryOf(st, ctx.pack));
      const hp = computed.tracks[hpTrackOf(ctx.pack)?.id];
      if (!hp || hp.cur <= 0) throw bad('that crawler cannot act');
      if (hp.cur >= hp.max) throw bad('your health is already full');
      const mana = computed.tracks[hs.track];
      if (!mana || mana.cur < hs.mana) throw bad(`not enough Mana (needs ${hs.mana})`);
      spendReactionAction(rx, me.uid);
      setTrack(st, p, { track: hs.track, delta: -hs.mana }, ctx, out);
      const heal = { ...out, result: null };
      COMBAT_GM['combat.heal'](st, { uid: me.uid, amount: hs.slots }, ctx, heal);
      out.result = { healed: heal.result.actualAmount, mana: mana.cur - hs.mana };
    } else {
      if (rx.intervene.includes(me.uid)) throw bad('you already prepared Intervene');
      spendReactionAction(rx, me.uid);
      rx.intervene.push(me.uid);
    }
    out.result = { ...out.result, receipt: actionReceipt(rx, me.uid, 1) };
    log(rx, `${nameOf(st, me)}: ${a.kind}.`);
    out.emit({ kind: 'rx.interrupt', uid: me.uid, what: a.kind }, 'all');
  },

  /** `{ declId, die }` or `{ declId, digital: true }` — my Evade roll against one attack. */
  'rx.evade'(st, a, ctx, out) { evadeRoll(st, ctx, out, a, ctx.actor.playerId); },

  /** Spend one AI Favor to buy a single non-attack action this round. */
  'rx.favor'(st, a, ctx, out) {
    const me = crawlers(st).find((x) => x.playerId === ctx.actor.playerId);
    if (!me) throw bad('you are not in this fight');
    buyFavorAction(st, ctx, out, me);
  },

  /** Intervene on an ally's Evade. A prepared Intervene already paid for the action. */
  'rx.intervene'(st, a, ctx, out) {
    const rx = rxOf(st);
    const me = crawlers(st).find((x) => x.playerId === ctx.actor.playerId);
    if (!me || !standing(me)) throw bad('that crawler cannot act');
    if (rx.step !== 'react') throw bad('you cannot help an Evade after reactions');
    requireStatusAllowed(st, ctx, playerOfCrawler(st, me), 'interrupt');
    const d = declOf(rx, a.declId);
    if (!d.evade || d.result) throw bad('no open Evade roll there');
    if (d.targetUid === me.uid) throw bad('Intervene helps someone else');
    const d6 = reactionDie(a, 'd6', 6, ctx);
    const reserved = rx.intervene.indexOf(me.uid);
    if (reserved >= 0) rx.intervene.splice(reserved, 1);
    else spendReactionAction(rx, me.uid);
    d.evade.total += d6;
    d.evade.degree = degreeOf(d.evade.die, d.evade.total, d.attack.dc);
    d.evade.helped = (d.evade.helped ?? 0) + d6;
    if (d.evade.degree === 'amazing' || d.evade.degree === 'crit') {
      const target = crawlerOf(st, d.targetUid);
      rx.advantage = [...(rx.advantage ?? []).filter((v) => !(v.uid === target.uid && v.mobUid === d.mobUid)), { uid: target.uid, mobUid: d.mobUid }].slice(-20);
    }
    out.result = { d6, degree: d.evade.degree, label: DEGREE_LABEL[d.evade.degree], receipt: actionReceipt(rx, me.uid, reserved < 0 ? 1 : 0) };
    out.emit({ kind: 'rx.evade', declId: d.id, uid: d.targetUid, playerId: st.combat.combatants.find((c) => c.uid === d.targetUid)?.playerId ?? null, degree: d.evade.degree, helped: true }, 'all');
  },

  /** Spend a non-attack action for a move or item: `{ n? }`. */
  'rx.spend'(st, a, ctx, out) {
    const rx = rxOf(st);
    const me = crawlers(st).find((x) => x.playerId === ctx.actor.playerId);
    if (!me) throw bad('you are not in this fight');
    if (!standing(me)) throw bad('that crawler cannot act');
    if (rx.step !== 'act' && rx.step !== 'react') throw bad('not now');
    requireStatusAllowed(st, ctx, playerOfCrawler(st, me), rx.step === 'react' ? 'interrupt' : 'action');
    const count = a.n === 2 ? 2 : 1;
    spendReactionAction(rx, me.uid, count);
    if (out) out.result = { receipt: actionReceipt(rx, me.uid, count) };
  },
};

/** Role-filtered view of the round: players never see difficulties or hidden mobs' plans. */
export function reactionView(state, role, pack) {
  const c = state.combat;
  if (!c?.active || !isObj(c.rx) || c.rx.combatId !== c.id) return null;
  const rx = c.rx;
  const gm = role === 'gm';
  const mobs = new Map(c.combatants.filter((x) => x.type === 'mob').map((x) => [x.uid, x]));
  const byUid = new Map(crawlers(state).map((x) => [x.uid, x]));
  const library = pack && libraryOf(state, pack);
  const decls = rx.decls.filter((d) => gm || (rx.step !== 'declare' && mobs.has(d.mobUid) && !mobs.get(d.mobUid).hidden)).map((d) => {
    const m = mobs.get(d.mobUid);
    const target = byUid.get(d.targetUid);
    const blocked = library && !!statusBlocker(playerOfCrawler(state, target), library, 'interrupt');
    const base = { id: d.id, mobUid: d.mobUid, mob: m?.name ?? '?', attack: d.attack.name, area: d.attack.area, splash: !!d.splash, adv: d.adv ?? null, targetUid: d.targetUid, caught: d.caught, taunted: d.taunted, result: d.result, damage: d.damage, ...evadeOptions(rx, d, target, blocked), ...(d.slots != null ? { slots: d.slots } : {}), evade: d.evade ? { degree: d.evade.degree, label: DEGREE_LABEL[d.evade.degree], die: d.evade.die, helped: d.evade.helped ?? 0, free: !!d.evade.free } : null };
    return gm ? { ...base, attackIndex: d.attackIndex, dc: d.attack.dc, damageDice: d.attack.damage, dtype: d.attack.dtype, effects: d.attack.effects, damageAfterDr: d.damageAfterDr, evadeTotal: d.evade?.total ?? null } : base;
  });
  const advantage = (rx.advantage ?? []).filter((v) => gm || !mobs.get(v.mobUid)?.hidden).map((v) => ({ uid: v.uid, mobUid: v.mobUid, mob: mobs.get(v.mobUid)?.name ?? '?' }));
  const lastUndo = ['resolve', 'act'].includes(rx.step) ? rx.resolutionUndo?.at(-1) : null;
  const roster = gm && library && rx.step === 'declare' && !rx.decls.length ? suggestionRoster(state, pack, library) : null;
  const suggestion = roster ? { ...suggestionHint(roster.reason), mobs: roster.mobs.length, targets: roster.targets.length } : null;
  return { round: rx.round, step: rx.step, steps: STEPS, decls, acts: rx.acts, nonAttackActions: rx.nonAttackActions ?? {}, favor: rx.favor ?? [], evading: rx.evading, intervene: rx.intervene, advantage, surprised: !!rx.surprised, log: gm ? rx.log.slice(-12) : rx.log.slice(-5),
    ...(gm ? { pending: rx.pending ?? null, batch: rx.batch ?? null, canUndo: !!lastUndo, undoAt: lastUndo?.at ?? null, suggestion } : {}) };
}
