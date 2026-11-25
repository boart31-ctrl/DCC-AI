// HUD marks over a crawler's head (DCC Atlas): a skull per crawler killed, a golden skull per leaderboard crawler,
// a star per boss killed (by boss rank). Public: everyone's HUD shows them (TV, phones, map tokens).
//
//   player.marks = { skulls, goldSkulls, stars: [{ rank, name, at }] }
//
// Credited when a fight ends (so a Ctrl+Z inside the fight never leaves a stale skull), for every dead mob whose
// library entry says what it was: tags "crawler" (a rival crawler / GMC) → skull, + "leaderboard" → golden skull;
// a boss (sourceKind boss or role boss) → star with its rank. The GM can also adjust by hand (marks.set).
import { bad } from './errors.js';
import { libraryOf } from './character.js';

export const emptyMarks = () => ({ skulls: 0, goldSkulls: 0, stars: [] });

export function normalizeMarks(raw) {
  if (!raw || typeof raw !== 'object') return emptyMarks();
  const n = (v) => (Number.isInteger(v) && v >= 0 && v <= 999 ? v : 0);
  return {
    skulls: n(raw.skulls),
    goldSkulls: n(raw.goldSkulls),
    stars: (Array.isArray(raw.stars) ? raw.stars : []).filter((s) => s && typeof s === 'object').slice(0, 200)
      .map((s) => ({ rank: String(s.rank ?? 'boss').slice(0, 40), name: String(s.name ?? '').slice(0, 80), at: Number(s.at) || 0 })),
  };
}

export function publicMarks(raw) {
  const m = normalizeMarks(raw);
  return { skulls: m.skulls, goldSkulls: m.goldSkulls, stars: m.stars.length };
}

/** Called from combat.end: credit every newly dead marked mob to its killer. Returns [{playerId, kind, victim}]. */
export function creditMarks(st, ctx, out) {
  const lib = libraryOf(st, ctx.pack);
  const got = [];
  for (const m of st.combat?.combatants ?? []) {
    if (m.type !== 'mob' || m.hp > 0 || !m.killedBy || m.marked) continue;
    const p = st.players.find((x) => x.id === m.killedBy);
    if (!p) continue;
    const src = m.sourceKind && m.sourceId ? lib.get(m.sourceKind, m.sourceId) : null;
    const tags = new Set([...(src?.tags ?? []), ...(m.tags ?? [])]);
    const marks = (p.marks = normalizeMarks(p.marks));
    let kind = null;
    if (tags.has('crawler') || tags.has('leaderboard')) {
      if (tags.has('leaderboard')) { marks.goldSkulls += 1; kind = 'goldSkull'; } else { marks.skulls += 1; kind = 'skull'; }
    }
    if (m.sourceKind === 'boss' || m.role === 'boss') {
      marks.stars.push({ rank: String(src?.rank ?? 'Boss').slice(0, 40), name: m.name, at: ctx.now });
      kind = kind ?? 'star';
      if (kind !== 'star') got.push({ playerId: p.id, kind: 'star', victim: m.name });
    }
    if (!kind) continue;
    m.marked = true;
    got.push({ playerId: p.id, kind, victim: m.name });
  }
  for (const g of got) {
    const p = st.players.find((x) => x.id === g.playerId);
    const ev = out.emit({ kind: 'marks', playerId: g.playerId, mark: g.kind, victim: g.victim, marks: p.marks }, 'all');
    if (g.kind !== 'star') {
      const line = ctx.h?.categoryLine?.(st, ctx, 'player_killer', 1);
      if (line) out.lines.push(line);
    }
    ctx.h?.feedPush?.(st, ev, g.kind === 'star' ? `${p.name} earned a star for ${g.victim}` : `${p.name} now wears a ${g.kind === 'goldSkull' ? 'golden ' : ''}Player Killer skull (${g.victim})`);
  }
  return got;
}

export const MARKS_GM = {
  /** Set by hand: a: { playerId, skulls?, goldSkulls?, stars?: [{rank, name}] } */
  'marks.set'(st, a, ctx) {
    const p = st.players.find((x) => x.id === a.playerId);
    if (!p) throw bad(`no player ${a.playerId}`);
    const cur = normalizeMarks(p.marks);
    for (const k of ['skulls', 'goldSkulls']) {
      if (a[k] === undefined) continue;
      if (!Number.isInteger(a[k]) || a[k] < 0 || a[k] > 999) throw bad(`${k} must be 0–999`);
      cur[k] = a[k];
    }
    if (a.stars !== undefined) {
      if (!Array.isArray(a.stars)) throw bad('stars must be a list');
      cur.stars = normalizeMarks({ stars: a.stars.map((s) => ({ ...s, at: s.at ?? ctx.now })) }).stars;
    }
    p.marks = cur;
  },
};
