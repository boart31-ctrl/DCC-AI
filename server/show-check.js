// Show → Big roll, held for the GM (seven-degree crawler rulesets, DCC).
// The GM picks the check and the Difficulty rule (stat / unopposed / opposed / fixed, from the world floor),
// the dice come in (app rolls, GM types physical faces, or each phone rolls or types its own d20), the GM sees
// every result first and reveals it on the TV with one press. Nothing public (dice log, lines, degrees on the
// TV) happens before the reveal; then it resolves through scene.check like any scored show roll.
// AI Favor: a crawler may reroll their d20 before the reveal (never a natural 1), which is when the rule allows it.
import { bad, forbidden, notFound } from './errors.js';
import { libraryOf } from './character.js';
import { checkDC } from '../web/js/check-dc.js';
import { degree7, floorOfState } from './outcome.js';
import { checkModifier } from './prep-checks.js';
import { SCENE_GM, setScene } from './scenes.js';
import { lockedSkills } from './skill-locks.js';

export const SHOW_CHECK_DC_TYPES = ['stat', 'unopposed', 'opposed', 'fixed'];
export const SHOW_CHECK_DICE = ['digital', 'physical', 'phone'];
const ADV = ['adv', 'dis'];
export const SHOW_CHECK_LIGHT = ['bright', 'dim', 'dark'];
const MAX_TIERS = 6;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const face = (v) => Number.isInteger(v) && v >= 1 && v <= 20;
const int = (v, field, lo, hi) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw bad(`${field} must be an integer ${lo}..${hi}`);
  return v;
};

export function normalizeShowCheck(raw) {
  if (!isObj(raw) || typeof raw.id !== 'string' || !Number.isInteger(raw.dc) || !Array.isArray(raw.entries)) return null;
  if (!raw.entries.every((e) => isObj(e) && typeof e.playerId === 'string' && (e.die == null || face(e.die)))) return null;
  return raw;
}

function seven(rs) {
  if (rs.system?.family !== 'crawler' || rs.combat?.degreeScale !== 'seven') throw bad('held show checks are unavailable in this campaign');
}

function activeCheck(st, { open = true } = {}) {
  const q = st.showCheck;
  if (!q || q.sessionId !== st.session.id) throw notFound('no show check is waiting');
  if (open && q.revealed) throw bad('this check is already on the TV');
  return q;
}

/** Combine the check's own advantage (untrained = Disadvantage) with the GM's situational one: one of each cancels. */
function netAdvantage(...sources) {
  const n = sources.reduce((k, s) => k + (s === 'adv' ? 1 : s === 'dis' ? -1 : 0), 0);
  return n > 0 ? 'adv' : n < 0 ? 'dis' : null;
}

function rollD20(ctx, adv) {
  const rand = ctx.dieInt ?? ctx.rollInt ?? ctx.randInt;
  const x = rand(20) + 1;
  if (!adv) return { die: x };
  const y = rand(20) + 1;
  const die = adv === 'adv' ? Math.max(x, y) : Math.min(x, y);
  return { die, otherDie: die === x ? y : x };
}

/** Opposed: the antagonist's relevant Stat Mod, from a mob in the fight or a library monster / boss. */
function opposedMod(st, ctx, a, fallbackStat) {
  const rs = ctx.pack.ruleset;
  const against = a.against;
  if (against == null) return { mod: int(a.mod ?? 0, 'mod', -20, 20), against: null };
  if (!isObj(against)) throw bad('against must be an object');
  const stat = against.stat ?? fallbackStat;
  if (!rs.stats.some((s) => s.id === stat)) throw bad('choose the stat the opponent resists with');
  const lib = libraryOf(st, ctx.pack);
  let entry = null;
  let name = '';
  if (against.kind === 'mob') {
    const m = (st.combat?.combatants ?? []).find((c) => c.uid === against.uid && c.type === 'mob');
    if (!m) throw notFound('that mob is not in the fight');
    entry = m.sourceId ? lib.get(m.sourceKind === 'boss' ? 'boss' : 'monster', m.sourceId) : null;
    name = m.name;
  } else if (against.kind === 'monster' || against.kind === 'boss') {
    entry = lib.get(against.kind, against.id);
    if (!entry) throw notFound(`unknown ${against.kind} ${against.id}`);
    name = entry.name;
  } else throw bad('against.kind must be mob, monster or boss');
  const mod = entry?.stats?.[stat]?.mod;
  if (!Number.isInteger(mod)) throw bad(`${name || 'that creature'} has no ${stat} in its stat block: type the modifier instead`);
  return { mod, against: { kind: against.kind, ...(against.uid ? { uid: against.uid } : { id: against.id }), name, stat } };
}

/** Escalating check: the best step reached (index into tiers, −1 = none). A natural 20 reaches the top, a natural 1 none. */
export function tierFor(tiers, total, natural) {
  if (natural === 1) return -1;
  if (natural === 20) return tiers.length - 1;
  let best = -1;
  tiers.forEach((t, i) => { if (total >= t.dc) best = i; });
  return best;
}

function favorLeft(p, pack) {
  const fdef = pack?.ruleset?.fields?.find((f) => f.id === 'aiFavor');
  return fdef ? Number(p?.sheet.fields?.aiFavor ?? fdef.default ?? 0) : 0;
}

function publicData(st, q) {
  return {
    scored: true, pending: true, label: q.label, ability: q.ability, at: q.at,
    ...(q.showDc ? { dc: q.dc } : { hideDc: true }),
    people: q.entries.map((e) => {
      const p = st.players.find((x) => x.id === e.playerId);
      return { playerId: e.playerId, name: p?.name ?? '', color: p?.color ?? null, ready: e.die != null, phone: q.dice === 'phone' };
    }),
  };
}

function refreshScene(st, q) {
  if (st.scene?.kind === 'roll' && st.scene.id === q.sceneId) st.scene.data = publicData(st, q);
}

function setDie(q, e, die, otherDie) {
  e.die = die;
  if (otherDie == null) delete e.otherDie; else e.otherDie = otherDie;
}

function favor(st, ctx, q, e, entered) {
  if (e.die == null) throw bad('roll first');
  if (e.die === 1) throw bad('a natural 1 cannot be rerolled');
  if (e.favored) throw bad('already rerolled');
  const fdef = ctx.pack.ruleset.fields.find((f) => f.id === 'aiFavor');
  if (!fdef) throw bad('this game has no AI Favor');
  const p = st.players.find((x) => x.id === e.playerId);
  const fav = Number(p.sheet.fields?.aiFavor ?? fdef.default ?? 0);
  if (!(fav > 0)) throw bad('no AI Favor left');
  p.sheet.fields = { ...(p.sheet.fields ?? {}), aiFavor: fav - 1 };
  const old = e.die;
  if (entered === undefined) { const r = rollD20(ctx, e.advantage); setDie(q, e, r.die, r.otherDie); } else setDie(q, e, int(entered, 'entered', 1, 20));
  e.favored = { from: old };
}

export const SHOW_CHECK_GM = {
  /**
   * `{ mode, skillId|statId, dcType, mod?, against?, dc?, adv?, playerIds[], dice, entered?: {playerId: face}, showDc?, label?,
   *    stat?, unenhanced?, light?, help?: {playerId: helperId}, helpEntered?: {playerId: face}, tiers?: [{dc, text}], allowLocked? }`
   * stat = off-stat check (the skill's Rank with another Stat Mod), unenhanced = unenhanced scores (shows),
   * light dim/dark = Disadvantage on the pack's vision skills (dark: on every check), help = a helper's die before
   * the roll (1d2 untrained / 1d6 with Ranks; not on stat or party checks), tiers = escalating Difficulties.
   * Holds the check: the TV shows who is rolling, the GM sees results in gm.showCheck, `scene.check.reveal` resolves it.
   */
  'scene.check.start'(st, a, ctx, out) {
    const rs = ctx.pack.ruleset;
    seven(rs);
    const party = a.mode === 'party';
    if (!party && a.mode !== 'single') throw bad('check mode must be single or party');
    if (!SHOW_CHECK_DICE.includes(a.dice)) throw bad(`dice must be ${SHOW_CHECK_DICE.join(', ')}`);
    if (!SHOW_CHECK_DC_TYPES.includes(a.dcType)) throw bad(`dcType must be ${SHOW_CHECK_DC_TYPES.join(', ')}`);
    if (a.adv != null && !ADV.includes(a.adv)) throw bad('adv must be adv or dis');
    if (a.showDc !== undefined && typeof a.showDc !== 'boolean') throw bad('showDc must be a boolean');
    const lib = libraryOf(st, ctx.pack);
    const skill = a.skillId !== undefined ? lib.get('skill', a.skillId) : null;
    if (a.skillId !== undefined && !skill) throw notFound(`unknown skill ${a.skillId}`);
    if (skill && ['passive', 'evade'].includes(skill.checkType?.toLowerCase())) throw bad('choose one active skill for the check');
    const stat = !skill && !party ? rs.stats.find((s) => s.id === a.statId) : null;
    if (!skill && !stat) throw bad(party ? 'choose a skill for the party check' : 'choose a skill or stat');
    if (a.stat !== undefined && (!skill || !rs.stats.some((x) => x.id === a.stat))) throw bad('an off-stat check needs a skill and a stat');
    if (a.unenhanced !== undefined && typeof a.unenhanced !== 'boolean') throw bad('unenhanced must be a boolean');
    if (a.light !== undefined && !SHOW_CHECK_LIGHT.includes(a.light)) throw bad(`light must be ${SHOW_CHECK_LIGHT.join(', ')}`);
    const vision = new Set(ctx.pack.ruleset.checks?.visionSkills ?? []);
    const lightAdv = a.light === 'dark' || (a.light === 'dim' && skill && vision.has(skill.id)) ? 'dis' : null;
    let tiers = null;
    if (a.tiers !== undefined) {
      if (!Array.isArray(a.tiers) || a.tiers.length < 2 || a.tiers.length > MAX_TIERS) throw bad(`escalating checks need 2..${MAX_TIERS} steps`);
      tiers = a.tiers.map((t) => ({ dc: int(t?.dc, 'tier dc', -10, 99), text: typeof t?.text === 'string' ? t.text.trim().slice(0, 300) : '' }))
        .sort((x, y) => x.dc - y.dc);
      if (new Set(tiers.map((t) => t.dc)).size !== tiers.length) throw bad('each step needs its own DC');
    }
    if (a.help !== undefined && (!isObj(a.help) || party || !skill)) throw bad('help is for a single skill check');
    const ids = Array.isArray(a.playerIds) ? a.playerIds : [];
    if (!ids.length || ids.length > st.players.length || new Set(ids).size !== ids.length || (!party && ids.length !== 1)) throw bad('select the crawlers making this check');
    const floor = floorOfState(st);
    const rule = { dcType: a.dcType };
    let against = null;
    if (a.dcType === 'opposed') ({ mod: rule.mod, against } = opposedMod(st, ctx, a, skill?.stat ?? stat?.id));
    if (a.dcType === 'fixed') rule.dc = int(a.dc, 'dc', -10, 99);
    const dc = tiers ? tiers[0].dc : checkDC(rule, rs, { floor });
    if (!Number.isInteger(dc) || dc < -10 || dc > 99) throw bad('that Difficulty is out of range');
    const check = skill ? { skillId: skill.id } : { statId: stat.id };
    const entries = ids.map((playerId) => {
      const p = st.players.find((x) => x.id === playerId);
      if (!p) throw notFound(`no player ${playerId}`);
      if (skill && a.allowLocked !== true && lockedSkills(st, p).includes(skill.id)) throw bad(`${p.name} had a Major or Critical Fail with ${skill.name} in this scene: try another way, or start a new scene`);
      const m = checkModifier(p, st, ctx.pack, check, { stat: a.stat, unenhanced: a.unenhanced === true });
      const e = { playerId, modifier: m.modifier, die: null, ...(m.untrained ? { untrained: true } : {}) };
      // Extra over the sheet's own bonus: carried into the reveal as a situational bonus.
      const extra = [];
      if (m.statShift) extra.push({ label: a.unenhanced ? 'Unenhanced stats' : `Off-stat (${a.stat.toUpperCase()})`, value: m.statShift });
      const helperId = isObj(a.help) ? a.help[playerId] : undefined;
      if (helperId !== undefined) {
        const helper = st.players.find((x) => x.id === helperId);
        if (!helper || helper.id === playerId) throw bad('choose another crawler to help');
        const sides = helper.sheet.skills.some((x) => x.skillId === skill.id && x.rank > 0) ? 6 : 2;
        const typed = isObj(a.helpEntered) ? a.helpEntered[playerId] : undefined;
        const die = typed !== undefined ? int(typed, 'help die', 1, sides) : (ctx.dieInt ?? ctx.rollInt ?? ctx.randInt)(sides) + 1;
        e.help = { helperId, name: helper.name, sides, die };
        e.modifier += die;
        extra.push({ label: `Help from ${helper.name} (d${sides})`, value: die });
      }
      if (extra.length) e.extra = extra;
      const adv = netAdvantage(m.advantage, a.adv, lightAdv);
      if (adv) e.advantage = adv;
      if (a.dice === 'digital') { const r = rollD20(ctx, adv); setDie(null, e, r.die, r.otherDie); }
      const typed = isObj(a.entered) ? a.entered[playerId] : undefined;
      if (a.dice === 'physical' && typed !== undefined) setDie(null, e, int(typed, 'entered', 1, 20));
      return e;
    });
    const label = typeof a.label === 'string' && a.label.trim() ? a.label.trim().slice(0, 80) : skill?.name ?? `${stat.label} check`;
    const q = {
      id: ctx.genId('scq'), sessionId: st.session.id, mode: party ? 'party' : 'single', ...check, label, ability: skill?.name ?? stat.label,
      dcType: tiers ? 'tiers' : a.dcType, floor, dc, ...(rule.mod !== undefined && !tiers ? { mod: rule.mod } : {}), ...(against && !tiers ? { against } : {}),
      ...(tiers ? { tiers } : {}), ...(a.stat ? { stat: a.stat } : {}), ...(a.unenhanced ? { unenhanced: true } : {}), ...(a.light && a.light !== 'bright' ? { light: a.light } : {}),
      ...(a.adv ? { adv: a.adv } : {}), showDc: a.showDc === true, dice: a.dice, entries, revealed: false, at: ctx.now,
    };
    setScene(st, ctx, 'roll', publicData(st, q));
    q.sceneId = st.scene.id;
    st.showCheck = q;
    out.result = { id: q.id, dc, sceneId: q.sceneId };
  },

  /** `{ playerId, entered? }` GM types a physical face (or omits it: the app rolls) for a crawler still waiting. */
  'scene.check.enter'(st, a, ctx) {
    const q = activeCheck(st);
    const e = q.entries.find((x) => x.playerId === a.playerId);
    if (!e) throw notFound('that crawler is not in this check');
    if (a.entered === undefined) { const r = rollD20(ctx, e.advantage); setDie(q, e, r.die, r.otherDie); } else setDie(q, e, int(a.entered, 'entered', 1, 20));
    delete e.favored;
    refreshScene(st, q);
  },

  /** `{ playerId, entered? }` the crawler spends 1 AI Favor to reroll before the reveal. */
  'scene.check.favor'(st, a, ctx) {
    const q = activeCheck(st);
    const e = q.entries.find((x) => x.playerId === a.playerId);
    if (!e) throw notFound('that crawler is not in this check');
    favor(st, ctx, q, e, a.entered);
  },

  /** Resolves the rolled entries through scene.check (dice log, degree lines, phone verdicts, party verdict). */
  'scene.check.reveal'(st, a, ctx, out) {
    const q = activeCheck(st);
    const ready = q.entries.filter((e) => e.die != null);
    if (!ready.length) throw bad('nobody has rolled yet');
    SCENE_GM['scene.check'](st, {
      t: 'scene.check', mode: q.mode, dc: q.dc, label: q.label, hideDc: !q.showDc, ...(q.adv ? { adv: q.adv } : {}),
      ...(q.skillId ? { skillId: q.skillId } : { statId: q.statId }),
      entries: ready.map((e) => ({ playerId: e.playerId, entered: e.die, ...(e.extra?.length ? { bonus: e.extra.reduce((n, x) => n + x.value, 0) } : {}) })),
    }, ctx, out);
    q.revealed = true;
    q.sceneId = st.scene.id;
    q.results = out.result?.results?.map((r) => ({ playerId: r.playerId, total: r.total, degree: r.degree, shift: r.shift ?? null,
      ...(q.tiers ? { tier: tierFor(q.tiers, r.total, r.natural) } : {}) })) ?? [];
    if (q.tiers) out.result = { ...out.result, tiers: q.results.map((r) => ({ playerId: r.playerId, tier: r.tier })) };
    q.verdict = out.result?.verdict ?? null;
    q.skipped = q.entries.filter((e) => e.die == null).map((e) => e.playerId);
  },

  'scene.check.cancel'(st) {
    const q = activeCheck(st, { open: false });
    if (!q.revealed && st.scene?.kind === 'roll' && st.scene.id === q.sceneId) st.scene.data = { ...st.scene.data, pending: false, cancelled: true };
    st.showCheck = null;
  },
};

export const SHOW_CHECK_PLAYER = {
  /** `{ id, entered? }` my own d20 for the held check: a typed face, or omitted = the phone rolls. */
  'scene.check.reply'(st, a, ctx, out) {
    const q = activeCheck(st);
    if (a.id !== q.id) throw notFound('this check is no longer waiting');
    const e = q.entries.find((x) => x.playerId === ctx.actor.playerId);
    if (!e) throw forbidden('this check is not assigned to you');
    if (e.die != null) throw bad('already rolled: tell the GM if the die was wrong');
    if (a.entered === undefined) { const r = rollD20(ctx, e.advantage); setDie(q, e, r.die, r.otherDie); } else setDie(q, e, int(a.entered, 'entered', 1, 20));
    refreshScene(st, q);
    out.result = { received: true, label: q.label, ability: q.ability, die: e.die, modifier: e.modifier, total: e.die + e.modifier, ...(e.advantage ? { advantage: e.advantage } : {}) };
  },

  /** `{ id, entered? }` spend my AI Favor to reroll my d20 before the GM reveals. */
  'scene.check.favor'(st, a, ctx, out) {
    const q = activeCheck(st);
    if (a.id !== q.id) throw notFound('this check is no longer waiting');
    const e = q.entries.find((x) => x.playerId === ctx.actor.playerId);
    if (!e) throw forbidden('this check is not assigned to you');
    favor(st, ctx, q, e, a.entered);
    out.result = { die: e.die, modifier: e.modifier, total: e.die + e.modifier };
  },
};

/** GM view: everything, with the result each die would give (the GM decides when the table hears it). */
export function showCheckGmView(st, pack) {
  const q = st.showCheck;
  if (!q || q.sessionId !== st.session.id) return null;
  return {
    ...q,
    entries: q.entries.map((e) => {
      const p = st.players.find((x) => x.id === e.playerId);
      const total = e.die == null ? null : e.die + e.modifier;
      return { ...e, name: p?.name ?? '', aiFavor: favorLeft(p, pack), total, degree: e.die == null ? null : degree7(e.die, total, q.dc),
        ...(q.tiers && e.die != null ? { tier: tierFor(q.tiers, total, e.die) } : {}) };
    }),
  };
}

/** Phone prompt for the held check (phone dice only): roll, then optionally reroll with AI Favor until the reveal. */
export function showCheckPrompts(st, playerId, pack) {
  const q = st.showCheck;
  if (!q || q.sessionId !== st.session.id || q.revealed || q.dice !== 'phone') return [];
  const e = q.entries.find((x) => x.playerId === playerId);
  if (!e) return [];
  const p = st.players.find((x) => x.id === playerId);
  return [{
    id: q.id, kind: 'show', label: q.label, ability: q.ability, ...(e.advantage ? { advantage: e.advantage } : {}),
    ...(e.die != null ? { rolled: { die: e.die, modifier: e.modifier, total: e.die + e.modifier, favored: !!e.favored },
      canFavor: !e.favored && e.die !== 1 && favorLeft(p, pack) > 0 } : {}),
  }];
}
