// Achievement suggestions (layer 1 of ACHIEVEMENTS_DESIGN.md): the System notices moments that match an
// achievement's `trigger` and suggests it to the GM. Nothing is awarded by itself: the GM taps Award / Later / Never.
//
// Trigger (pack content, achievements.json): { on, nat?, deg?, what?, hit?, rarity?, mark?, inRound?, streak?, partyFirst?, count? }
//   on: roll (sheet roll) · evade (reaction-round Evade) · kill (a mob dies, credited to its killer) · down (a crawler
//       goes to 0) · saved (pulled back from Dying) · mark (skull / goldSkull / star) · loot (box opened) · sponsor
//   nat 1|20 · deg = seven-degree result (crit, amazing, success, near, fail, major, critfail) · what = attack | check |
//   untrained · hit true/false · rarity = best item of a box · mark = skull | goldSkull | star
//   inRound N = N kills in the same round · streak N = N matching rolls in a row · partyFirst = first crawler down this
//   fight · count N = the N-th time (default 1). Each achievement is suggested once per crawler.
import { bad, notFound } from './errors.js';

export const TRIGGER_ON = ['roll', 'evade', 'kill', 'down', 'saved', 'mark', 'loot', 'sponsor'];
const DEGS = ['crit', 'amazing', 'success', 'near', 'fail', 'major', 'critfail'];
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/** pack achievement.trigger → clean object or null. Never throws. */
export function normalizeTrigger(raw) {
  if (!raw || typeof raw !== 'object' || !TRIGGER_ON.includes(raw.on)) return null;
  const t = { on: raw.on };
  const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);
  if (raw.nat === 1 || raw.nat === 20) t.nat = raw.nat;
  if (DEGS.includes(raw.deg)) t.deg = raw.deg;
  if (['attack', 'check', 'untrained'].includes(raw.what)) t.what = raw.what;
  if (typeof raw.hit === 'boolean') t.hit = raw.hit;
  if (RARITIES.includes(raw.rarity)) t.rarity = raw.rarity;
  if (['skull', 'goldSkull', 'star'].includes(raw.mark)) t.mark = raw.mark;
  if (raw.partyFirst === true) t.partyFirst = true;
  for (const k of ['inRound', 'streak', 'count']) { const v = int(raw[k], 1, 100); if (v) t[k] = v; }
  if (raw.auto === true) t.auto = true; // quiet: awarded without asking the GM, no System voice line
  return t;
}

/** The moments in one action's events: [{ on, playerId, nat?, deg?, what?, hit?, rarity?, mark?, round? }]. */
export function momentsOf(st, events) {
  const out = [];
  const round = st.combat?.active ? (st.combat.rx?.round ?? st.combat.round ?? 0) : null;
  for (const { event: e } of events) {
    switch (e.kind) {
      case 'roll': {
        if (!e.by || e.by === 'gm' || e.secret) break;
        const what = e.what?.kind === 'untrained' ? 'untrained' : e.what?.kind === 'attack' || e.vs?.uid ? 'attack' : 'check';
        out.push({ on: 'roll', playerId: e.by, nat: e.natural, deg: e.vs?.deg7, what, hit: e.vs ? !!e.vs.hit : undefined, round });
        break;
      }
      case 'rx.evade': if (e.playerId && !e.helped) out.push({ on: 'evade', playerId: e.playerId, deg: e.degree, round }); break;
      case 'combat.hit': {
        if (!e.down) break;
        if (e.type === 'crawler') { out.push({ on: 'down', playerId: e.playerId, round }); break; }
        const m = st.combat?.combatants?.find((x) => x.uid === e.uid);
        if (m?.killedBy) out.push({ on: 'kill', playerId: m.killedBy, round });
        break;
      }
      case 'dying.saved': if (e.playerId) out.push({ on: 'saved', playerId: e.playerId, round }); break;
      case 'marks': if (e.playerId) out.push({ on: 'mark', playerId: e.playerId, mark: e.mark, round }); break;
      case 'loot': if (e.playerId) out.push({ on: 'loot', playerId: e.playerId, rarity: e.item?.rarity, round }); break;
      case 'sponsor': if (e.playerId) out.push({ on: 'sponsor', playerId: e.playerId, round }); break;
      default:
    }
  }
  return out;
}

const fits = (t, m) => t.on === m.on
  && (t.nat === undefined || m.nat === t.nat)
  && (t.deg === undefined || m.deg === t.deg)
  && (t.what === undefined || m.what === t.what)
  && (t.hit === undefined || m.hit === t.hit)
  && (t.rarity === undefined || m.rarity === t.rarity)
  && (t.mark === undefined || m.mark === t.mark);

/**
 * After an action: match moments against every achievement trigger, keep counters, add suggestions
 * (st.achSuggestions, newest last) and a short recent-moments list (st.achRecent) for the picker.
 */
export function suggestAchievements(st, ctx, out, GM = null) {
  if (st.achSettings?.suggest === false) return;
  const moments = momentsOf(st, out.events ?? []);
  if (!moments.length) return;
  st.achRecent = [...(st.achRecent ?? []), ...moments.map((m) => ({ on: m.on, playerId: m.playerId, deg: m.deg ?? null, at: ctx.now }))].slice(-8);
  const list = ctx.pack.achievements.filter((a) => a.trigger);
  if (!list.length) return;
  const counters = (st.achCounters ??= {});
  const never = new Set(st.achNever ?? []);
  const sugg = (st.achSuggestions ??= []);
  for (const m of moments) {
    const p = st.players.find((x) => x.id === m.playerId);
    if (!p) continue;
    const c = (counters[p.id] ??= {});
    // "First crawler down this fight" bookkeeping.
    let partyFirst = false;
    if (m.on === 'down' && st.combat?.active) {
      partyFirst = !st.combat.achFirstDown;
      st.combat.achFirstDown ??= p.id;
    }
    for (const a of ctx.pack.achievements) {
      const t = a.trigger;
      if (!t) continue;
      const key = a.id;
      if (!fits(t, m)) {
        // a roll that doesn't match breaks a streak of matching rolls
        if (t.streak && t.on === m.on && m.on === 'roll') c[`${key}:streak`] = 0;
        continue;
      }
      if (t.partyFirst && !partyFirst) continue;
      let hit;
      if (t.inRound) {
        const rk = `${key}:r${m.round}`;
        c[rk] = (c[rk] ?? 0) + 1;
        hit = c[rk] === t.inRound;
      } else if (t.streak) {
        c[`${key}:streak`] = (c[`${key}:streak`] ?? 0) + 1;
        hit = c[`${key}:streak`] === t.streak;
      } else {
        c[key] = (c[key] ?? 0) + 1;
        hit = c[key] === (t.count ?? 1);
      }
      if (!hit) continue;
      if (never.has(`${a.id}|${p.id}`)) continue;
      if (p.achievements.some((x) => x.achId === a.id)) continue;
      if (sugg.some((s) => s.achId === a.id && s.playerId === p.id)) continue;
      if (t.auto && GM && st.achSettings?.auto !== false) {
        GM['ach.award'](st, { playerId: p.id, achId: a.id, quiet: true }, ctx, out);
        continue;
      }
      sugg.push({ id: ctx.genId('as'), achId: a.id, playerId: p.id, title: a.title, name: p.name, at: ctx.now });
      out.emit({ kind: 'ach.suggest', achId: a.id, playerId: p.id, title: a.title }, { roles: ['gm'] });
    }
  }
  if (sugg.length > 30) st.achSuggestions = sugg.slice(-30);
}

export const ACH_SUGGEST_GM = {
  /** Award a suggestion: a: { id } → the normal ach.award for that crawler. */
  'ach.suggest.award'(st, a, ctx, out, GM) {
    const s = (st.achSuggestions ?? []).find((x) => x.id === a.id);
    if (!s) throw notFound(`no suggestion ${a.id}`);
    st.achSuggestions = st.achSuggestions.filter((x) => x.id !== a.id);
    GM['ach.award'](st, { playerId: s.playerId, achId: s.achId }, ctx, out);
  },
  /** Later = drop it for now (it can come back if it triggers again); never = not for this crawler again. */
  'ach.suggest.dismiss'(st, a) {
    const s = (st.achSuggestions ?? []).find((x) => x.id === a.id);
    if (!s) throw notFound(`no suggestion ${a.id}`);
    st.achSuggestions = st.achSuggestions.filter((x) => x.id !== a.id);
    if (a.never === true) st.achNever = [...new Set([...(st.achNever ?? []), `${s.achId}|${s.playerId}`])].slice(-500);
    else if (st.achCounters?.[s.playerId]) delete st.achCounters[s.playerId][s.achId];
  },
  /** a: { suggest: bool } */
  'ach.settings'(st, a) {
    if (a.auto !== undefined) {
      if (typeof a.auto !== 'boolean') throw bad('auto must be true or false');
      st.achSettings = { ...(st.achSettings ?? { suggest: true }), auto: a.auto };
      if (a.suggest === undefined) return;
    }
    if (typeof a.suggest !== 'boolean') throw bad('suggest must be true/false');
    st.achSettings = { ...(st.achSettings ?? {}), suggest: a.suggest };
  },
};
