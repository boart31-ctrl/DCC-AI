// Synced combat tracker (PLAN step 3). Pure + browser-safe: runs inside the engine on Node, in the
// Cloudflare Durable Object and in the hosted edition, so it is persisted like every other action.
//
// state.combat = {
//   active, round, phaseIndex, phases: [name], phasesVerified, showMobHp,
//   combatants: [
//     { uid, type: 'crawler', playerId }                         // HP lives on the sheet (track.set)
//     { uid, type: 'mob', sourceKind: 'monster'|'boss'|null, sourceId, name, image, hp, hpMax,
//       evade, dr, attacks: [{name, toHit, damage, effects, buffs}], conditions: [{id, name}], notes, hidden }
//   ] }
//
// GM actions (docs/PROTOCOL.md §3b): combat.start, combat.end, combat.next, combat.set, combat.addMob,
// combat.addAdhoc, combat.addCrawler, combat.update, combat.damage, combat.heal, combat.condition,
// combat.remove, combat.reveal, combat.mobRoll. Players and the stage never get any of them.
//
// Views: the GM sees everything. Players and the TV see crawlers + revealed mobs only, mob HP as a
// rounded fraction (exact numbers only with `showMobHp`), never notes / attacks / library GM fields.
import { bad, notFound } from './errors.js';
import { SHEET, SHEET_GM, libraryOf, computeFor, setTrack } from './character.js';
import { SCENE_GM } from './scenes.js';

export const DEFAULT_PHASES = ['Crawlers', 'Mobs'];
export const MAX_COMBATANTS = 40;
export const MAX_MOB_HP = 999;
export const MAX_CONDITIONS = 12;
export const MAX_PHASES = 8;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function txt(v, field, max, { allowEmpty = false } = {}) {
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  const t = v.trim();
  if (!allowEmpty && !t) throw bad(`${field} must not be empty`);
  if (t.length > max) throw bad(`${field} too long (max ${max})`);
  return t;
}
function intIn(v, field, lo, hi) {
  if (!Number.isInteger(v) || v < lo || v > hi) throw bad(`${field} must be an integer ${lo}..${hi}`);
  return v;
}
function flag(v, field) {
  if (typeof v !== 'boolean') throw bad(`${field} must be a boolean`);
  return v;
}

export function initCombat() {
  return { active: false, round: 1, phaseIndex: 0, phases: [...DEFAULT_PHASES], phasesVerified: false, showMobHp: false, combatants: [] };
}

/** Repairs a saved combat block (missing in old saves → idle tracker). */
export function normalizeCombat(raw) {
  const base = initCombat();
  if (!isObj(raw)) return base;
  const phases = Array.isArray(raw.phases) ? raw.phases.filter((p) => typeof p === 'string' && p.trim()).slice(0, MAX_PHASES) : [];
  const c = {
    active: raw.active === true,
    round: Number.isInteger(raw.round) && raw.round >= 1 ? raw.round : 1,
    phaseIndex: Number.isInteger(raw.phaseIndex) && raw.phaseIndex >= 0 ? raw.phaseIndex : 0,
    phases: phases.length ? phases : base.phases,
    phasesVerified: raw.phasesVerified === true,
    showMobHp: raw.showMobHp === true,
    combatants: (Array.isArray(raw.combatants) ? raw.combatants : []).filter((x) => isObj(x) && typeof x.uid === 'string' && (x.type === 'crawler' || x.type === 'mob')).slice(0, MAX_COMBATANTS),
  };
  c.phaseIndex = Math.min(c.phaseIndex, c.phases.length - 1);
  for (const m of c.combatants) {
    if (m.type !== 'mob') continue;
    m.conditions = Array.isArray(m.conditions) ? m.conditions.filter(isObj) : [];
    m.attacks = Array.isArray(m.attacks) ? m.attacks.filter(isObj) : [];
    m.hidden = m.hidden !== false;
  }
  return c;
}

/** The track crawler damage goes to: `hp`, else the first track. */
export function hpTrackOf(pack) {
  const t = pack.ruleset.tracks;
  return t.find((x) => x.id === 'hp') ?? t[0] ?? null;
}

function C(st) {
  if (!isObj(st.combat)) st.combat = initCombat();
  return st.combat;
}

function combatantOf(st, uid) {
  if (typeof uid !== 'string') throw bad('uid required');
  const x = C(st).combatants.find((c) => c.uid === uid);
  if (!x) throw notFound(`no combatant ${uid}`);
  return x;
}

function mobOf(st, uid) {
  const x = combatantOf(st, uid);
  if (x.type !== 'mob') throw bad('that combatant is a crawler: change it on the sheet');
  return x;
}

function roomFor(st, n) {
  if (C(st).combatants.length + n > MAX_COMBATANTS) throw bad(`max ${MAX_COMBATANTS} combatants`);
}

function addCrawler(st, ctx, playerId) {
  const c = C(st);
  if (c.combatants.some((x) => x.type === 'crawler' && x.playerId === playerId)) return null;
  roomFor(st, 1);
  const x = { uid: ctx.genId('cb'), type: 'crawler', playerId };
  // Crawlers first, in party order.
  const lastCrawler = c.combatants.map((y) => y.type).lastIndexOf('crawler');
  c.combatants.splice(lastCrawler + 1, 0, x);
  return x;
}

/** "Goblin" → "Goblin 3": continues numbering per source; renames a lone unnumbered first copy to "… 1". */
function numberedNames(st, base, sourceKey, count) {
  const mobs = C(st).combatants.filter((x) => x.type === 'mob' && x.sourceKey === sourceKey);
  if (count === 1 && !mobs.length) return [base];
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc} (\\d+)$`);
  let n = 0;
  for (const m of mobs) {
    const k = re.exec(m.name);
    if (k) n = Math.max(n, Number(k[1]));
  }
  const lone = mobs.filter((m) => m.name === base);
  if (lone.length && n === 0) for (const m of lone) m.name = `${base} ${++n}`;
  return Array.from({ length: count }, () => `${base} ${++n}`.slice(0, 80));
}

function cleanAttacks(list) {
  return (Array.isArray(list) ? list : []).slice(0, 12).map((a) => ({
    name: String(a.name ?? 'Attack').slice(0, 60),
    toHit: Number.isInteger(a.toHit) ? a.toHit : 0,
    damage: typeof a.damage === 'string' ? a.damage.slice(0, 60) : '',
    effects: typeof a.effects === 'string' ? a.effects.slice(0, 400) : '',
    buffs: Array.isArray(a.buffs) ? a.buffs.filter((b) => typeof b === 'string' && ID_RE.test(b)).slice(0, 10) : [],
  }));
}

function adhocAttacks(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 12) throw bad('attacks must be an array (max 12)');
  return raw.map((a, i) => {
    if (!isObj(a)) throw bad(`attacks[${i}] must be an object`);
    return {
      name: txt(a.name, `attacks[${i}].name`, 60),
      toHit: a.toHit === undefined ? 0 : intIn(a.toHit, `attacks[${i}].toHit`, -99, 99),
      damage: a.damage === undefined ? '' : txt(a.damage, `attacks[${i}].damage`, 60, { allowEmpty: true }),
      effects: a.effects === undefined ? '' : txt(a.effects, `attacks[${i}].effects`, 400, { allowEmpty: true }),
      buffs: [],
    };
  });
}

/** Hits on hidden mobs only reach the GM; everything else is public. */
const audience = (x) => (x.type === 'mob' && x.hidden ? { roles: ['gm'] } : 'all');

/** The boss scene on the TV shows this boss combatant: keep its HP in step. */
function linkedBoss(st, m) {
  return m.type === 'mob' && m.sourceKind === 'boss' && st.scene?.kind === 'boss' && st.scene.data?.bossId === m.sourceId && st.scene.data?.boss;
}

function crawlerHp(st, ctx, x) {
  const p = st.players.find((y) => y.id === x.playerId);
  if (!p) throw notFound(`no player ${x.playerId}`);
  const t = hpTrackOf(ctx.pack);
  if (!t) throw bad('this ruleset has no health track');
  return { p, t };
}

function changeHp(st, a, ctx, out, sign) {
  const x = combatantOf(st, a.uid);
  const amount = a.amount === undefined ? 1 : intIn(a.amount, 'amount', 1, MAX_MOB_HP);
  const kind = sign < 0 ? 'combat.hit' : 'combat.heal';
  if (x.type === 'crawler') {
    // Sheets stay the single source of truth: same path as the sheet's own track.set.
    const { p, t } = crawlerHp(st, ctx, x);
    setTrack(st, p, { track: t.id, delta: sign * amount }, ctx, out);
    const cur = computeFor(p, ctx.pack, libraryOf(st, ctx.pack)).computed.tracks[t.id];
    out.emit({ kind, uid: x.uid, type: 'crawler', playerId: p.id, name: p.name, amount, hp: cur.cur, max: cur.max, down: cur.cur <= 0 }, 'all');
    out.result = { hp: cur.cur, max: cur.max };
    return;
  }
  const from = x.hp;
  x.hp = Math.max(0, Math.min(x.hpMax, x.hp + sign * amount));
  const ev = out.emit({ kind, uid: x.uid, type: 'mob', name: x.name, amount: Math.abs(x.hp - from), hp: x.hp, max: x.hpMax, down: x.hp <= 0 }, audience(x));
  if (sign < 0 && from > 0 && x.hp === 0 && !x.hidden) ctx.h.feedPush(st, ev, `${x.name} is down`);
  if (linkedBoss(st, x)) SCENE_GM[sign < 0 ? 'boss.damage' : 'boss.heal'](st, { amount }, ctx, out);
  out.result = { hp: x.hp, max: x.hpMax };
}

function libSource(st, ctx, a) {
  if (typeof a.sourceId !== 'string' || !ID_RE.test(a.sourceId)) throw bad('sourceId must be a library id');
  const lib = libraryOf(st, ctx.pack);
  if (a.kind !== undefined && a.kind !== 'monster' && a.kind !== 'boss') throw bad('kind must be monster or boss');
  const kinds = a.kind ? [a.kind] : ['monster', 'boss'];
  for (const k of kinds) {
    const e = lib.get(k, a.sourceId);
    if (e) return { kind: k, e };
  }
  throw notFound(`no monster or boss ${a.sourceId}`);
}

function conditionOf(st, ctx, a) {
  if (a.buffId !== undefined) {
    const def = libraryOf(st, ctx.pack).get('buff', a.buffId);
    if (!def) throw notFound(`unknown buff ${a.buffId}`);
    return { id: def.id, name: def.name };
  }
  return { id: null, name: txt(a.name, 'name', 40) };
}

const sameCond = (c, k) => (k.id ? c.id === k.id : c.name.toLowerCase() === k.name.toLowerCase());

export const COMBAT_GM = {
  'combat.start'(st, a, ctx, out) {
    const c = C(st);
    if (a.phases !== undefined) COMBAT_GM['combat.set'](st, { phases: a.phases }, ctx, out);
    c.active = true;
    c.round = 1;
    c.phaseIndex = 0;
    for (const p of st.players) addCrawler(st, ctx, p.id);
    const ev = out.emit({ kind: 'combat.start', round: 1, phaseIndex: 0, phase: c.phases[0] }, 'all');
    ctx.h.feedPush(st, ev, `Combat! Round 1: ${c.phases[0]}`);
  },

  'combat.end'(st, a, ctx, out) {
    const c = C(st);
    const keep = { phases: c.phases, phasesVerified: c.phasesVerified, showMobHp: c.showMobHp };
    st.combat = { ...initCombat(), ...keep };
    out.emit({ kind: 'combat.end' }, 'all');
  },

  'combat.next'(st, a, ctx, out) {
    const c = C(st);
    if (c.phaseIndex >= c.phases.length - 1) { c.phaseIndex = 0; c.round += 1; } else c.phaseIndex += 1;
    out.emit({ kind: 'combat.phase', round: c.round, phaseIndex: c.phaseIndex, phase: c.phases[c.phaseIndex] }, 'all');
    out.result = { round: c.round, phaseIndex: c.phaseIndex };
  },

  /** Tracker settings: phases (names in order), round, phaseIndex, showMobHp (exact mob HP on TV/phones). */
  'combat.set'(st, a) {
    const c = C(st);
    if (a.phases !== undefined) {
      if (!Array.isArray(a.phases) || !a.phases.length || a.phases.length > MAX_PHASES) throw bad(`phases must be 1..${MAX_PHASES} names`);
      c.phases = a.phases.map((p, i) => txt(p, `phases[${i}]`, 40));
      c.phaseIndex = Math.min(c.phaseIndex, c.phases.length - 1);
    }
    if (a.phasesVerified !== undefined) c.phasesVerified = flag(a.phasesVerified, 'phasesVerified');
    if (a.round !== undefined) c.round = intIn(a.round, 'round', 1, 9999);
    if (a.phaseIndex !== undefined) c.phaseIndex = intIn(a.phaseIndex, 'phaseIndex', 0, c.phases.length - 1);
    if (a.showMobHp !== undefined) c.showMobHp = flag(a.showMobHp, 'showMobHp');
  },

  /** Monsters (or a boss) from the library: `count` copies, auto-numbered, hidden until revealed. */
  'combat.addMob'(st, a, ctx, out) {
    const { kind, e } = libSource(st, ctx, a);
    const count = a.count === undefined ? 1 : intIn(a.count, 'count', 1, 20);
    const hidden = a.hidden === undefined ? true : flag(a.hidden, 'hidden');
    roomFor(st, count);
    const sourceKey = `${kind}:${e.id}`;
    const names = numberedNames(st, e.name, sourceKey, count);
    const uids = names.map((name) => {
      const m = {
        uid: ctx.genId('cb'), type: 'mob', sourceKind: kind, sourceId: e.id, sourceKey, name,
        image: e.image ?? null, hp: e.hpSlots ?? 5, hpMax: e.hpSlots ?? 5,
        evade: Number.isInteger(e.evade) ? e.evade : 0, dr: Number.isInteger(e.dr) ? e.dr : 0,
        attacks: cleanAttacks(e.attacks), conditions: [], notes: '', hidden,
      };
      C(st).combatants.push(m);
      return m.uid;
    });
    out.result = { uids };
  },

  'combat.addAdhoc'(st, a, ctx, out) {
    const base = txt(a.name, 'name', 60);
    const hp = intIn(a.hp, 'hp', 1, MAX_MOB_HP);
    const count = a.count === undefined ? 1 : intIn(a.count, 'count', 1, 20);
    const hidden = a.hidden === undefined ? true : flag(a.hidden, 'hidden');
    const attacks = adhocAttacks(a.attacks);
    roomFor(st, count);
    const sourceKey = `adhoc:${base.toLowerCase()}`;
    const uids = numberedNames(st, base, sourceKey, count).map((name) => {
      const m = {
        uid: ctx.genId('cb'), type: 'mob', sourceKind: null, sourceId: null, sourceKey, name, image: null,
        hp, hpMax: hp,
        evade: a.evade === undefined ? 0 : intIn(a.evade, 'evade', -99, 99),
        dr: a.dr === undefined ? 0 : intIn(a.dr, 'dr', -99, 99),
        attacks, conditions: [], notes: a.notes === undefined ? '' : txt(a.notes, 'notes', 500, { allowEmpty: true }), hidden,
      };
      C(st).combatants.push(m);
      return m.uid;
    });
    out.result = { uids };
  },

  'combat.addCrawler'(st, a, ctx, out) {
    if (typeof a.playerId !== 'string' || !st.players.some((p) => p.id === a.playerId)) throw notFound(`no player ${a.playerId}`);
    const x = addCrawler(st, ctx, a.playerId);
    out.result = { uid: x?.uid ?? C(st).combatants.find((y) => y.playerId === a.playerId).uid, added: !!x };
  },

  'combat.update'(st, a) {
    const m = mobOf(st, a.uid);
    if (a.name !== undefined) m.name = txt(a.name, 'name', 80);
    if (a.hpMax !== undefined) { m.hpMax = intIn(a.hpMax, 'hpMax', 1, MAX_MOB_HP); m.hp = Math.min(m.hp, m.hpMax); }
    if (a.hp !== undefined) m.hp = intIn(a.hp, 'hp', 0, m.hpMax);
    if (a.evade !== undefined) m.evade = intIn(a.evade, 'evade', -99, 99);
    if (a.dr !== undefined) m.dr = intIn(a.dr, 'dr', -99, 99);
    if (a.notes !== undefined) m.notes = txt(a.notes, 'notes', 500, { allowEmpty: true });
    if (a.hidden !== undefined) m.hidden = flag(a.hidden, 'hidden');
  },

  'combat.damage'(st, a, ctx, out) { changeHp(st, a, ctx, out, -1); },
  'combat.heal'(st, a, ctx, out) { changeHp(st, a, ctx, out, 1); },

  /** Condition chip on a mob, or a buff on a crawler's sheet (buff.add / buff.remove). */
  'combat.condition'(st, a, ctx, out) {
    const x = combatantOf(st, a.uid);
    const on = flag(a.on, 'on');
    const k = conditionOf(st, ctx, a);
    if (x.type === 'crawler') {
      const { p } = crawlerHp(st, ctx, x);
      if (on) {
        SHEET_GM['buff.add'](st, k.id ? { playerId: p.id, buffId: k.id } : { playerId: p.id, name: k.name }, ctx, out);
      } else {
        const b = p.sheet.buffs.find((y) => (k.id ? y.buffId === k.id : y.name.toLowerCase() === k.name.toLowerCase()));
        if (!b) throw notFound(`${p.name} does not have ${k.name}`);
        SHEET_GM['buff.remove'](st, { playerId: p.id, uid: b.uid }, ctx, out);
      }
      return;
    }
    if (on) {
      if (!x.conditions.some((c) => sameCond(c, k))) {
        if (x.conditions.length >= MAX_CONDITIONS) throw bad(`max ${MAX_CONDITIONS} conditions`);
        x.conditions.push(k);
      }
    } else x.conditions = x.conditions.filter((c) => !sameCond(c, k));
  },

  'combat.remove'(st, a) {
    const x = combatantOf(st, a.uid);
    C(st).combatants = C(st).combatants.filter((y) => y !== x);
  },

  /** Shows a mob on the TV and phones (`on: false` hides it again; `all: true` = every mob). */
  'combat.reveal'(st, a, ctx, out) {
    const on = a.on === undefined ? true : flag(a.on, 'on');
    const list = a.all === true ? C(st).combatants.filter((x) => x.type === 'mob') : [mobOf(st, a.uid)];
    const shown = [];
    for (const m of list) {
      if (m.hidden === !on) continue;
      m.hidden = !on;
      if (on) shown.push(m);
    }
    if (shown.length) out.emit({ kind: 'combat.reveal', uids: shown.map((m) => m.uid), names: shown.map((m) => m.name) }, 'all');
    out.result = { changed: list.length };
  },

  /**
   * Rolls a mob attack with the existing dice: d20 + toHit, then its damage dice. Both go to the
   * dice log, GM-secret unless `public: true`.
   */
  'combat.mobRoll'(st, a, ctx, out) {
    const m = mobOf(st, a.uid);
    const i = a.attackIndex === undefined ? 0 : intIn(a.attackIndex, 'attackIndex', 0, Math.max(0, m.attacks.length - 1));
    const atk = m.attacks[i];
    if (!atk) throw bad(`${m.name} has no attacks`);
    const pub = a.public === undefined ? false : flag(a.public, 'public');
    const roll = (formula, label) => {
      const sub = { ...out, result: undefined };
      SHEET.roll(st, { t: 'roll', what: { kind: 'custom', formula, label: label.slice(0, 80) }, secret: !pub }, ctx, sub);
      return sub.result;
    };
    const toHit = atk.toHit ? `d20${atk.toHit > 0 ? '+' : ''}${atk.toHit}` : 'd20';
    const hit = roll(toHit, `${m.name}: ${atk.name}`);
    const rec = st.rolls.find((r) => r.id === hit.rollId);
    let dmg = null;
    if (atk.damage && !/^0+$/.test(atk.damage.trim())) dmg = roll(atk.damage, `${m.name}: ${atk.name} damage`);
    out.result = {
      rollId: hit.rollId, total: hit.total, nat1: !!rec?.nat1, nat20: !!rec?.nat20,
      damageRollId: dmg?.rollId ?? null, damage: dmg?.total ?? null, effects: atk.effects, buffs: atk.buffs, public: pub,
    };
  },
};

export const COMBAT_ACTIONS = Object.keys(COMBAT_GM);

// ---------- views ----------

function crawlerRow(state, pack, library, x, gm) {
  const p = state.players.find((y) => y.id === x.playerId);
  if (!p) return null;
  const t = hpTrackOf(pack);
  let hp = { cur: 0, max: 0 };
  try { if (t) hp = computeFor(p, pack, library).computed.tracks[t.id]; } catch { /* broken sheet: show 0/0 */ }
  const buffs = p.sheet?.buffs ?? [];
  return {
    uid: x.uid, type: 'crawler', playerId: p.id, name: p.name, color: p.color,
    hp: hp.cur, hpMax: hp.max, down: hp.max > 0 && hp.cur <= 0,
    conditions: gm ? buffs.map((b) => ({ uid: b.uid, id: b.buffId ?? null, name: b.name })) : buffs.map((b) => ({ id: b.buffId ?? null, name: b.name })),
  };
}

/** Mob HP for TV/phones without exact numbers: a fraction rounded up to 5 % (never 0 while alive). */
export function hpFraction(hp, max) {
  if (!max || hp <= 0) return 0;
  return Math.min(1, Math.ceil((hp / max) * 20) / 20);
}

/** view.combat for a role. GM: everything. Player / stage: crawlers + revealed mobs, filtered fields. */
export function combatView(state, pack, role) {
  const c = normalizeCombat(state.combat);
  const gm = role === 'gm';
  const library = libraryOf(state, pack);
  const head = {
    active: c.active, round: c.round, phaseIndex: c.phaseIndex, phase: c.phases[c.phaseIndex] ?? '',
    phases: c.phases, phasesVerified: c.phasesVerified, showMobHp: c.showMobHp,
  };
  const combatants = [];
  for (const x of c.combatants) {
    if (x.type === 'crawler') {
      const row = crawlerRow(state, pack, library, x, gm);
      if (row) combatants.push(row);
      continue;
    }
    if (gm) {
      const { sourceKey, ...m } = x;
      combatants.push({ ...m, down: m.hp <= 0, linked: !!linkedBoss(state, x) });
      continue;
    }
    if (x.hidden) continue;
    const row = {
      uid: x.uid, type: 'mob', name: x.name, image: x.image ?? null, boss: x.sourceKind === 'boss',
      hpPct: hpFraction(x.hp, x.hpMax), down: x.hp <= 0,
      conditions: (x.conditions ?? []).map((k) => ({ id: k.id ?? null, name: k.name })),
    };
    if (c.showMobHp) Object.assign(row, { hp: x.hp, hpMax: x.hpMax });
    combatants.push(row);
  }
  return { ...head, combatants };
}
