// Rest offered by the GM, taken on the phones (27 Nov playtest: "GM starts it, the player confirms").
// `rest.offer { kind }` opens it for every crawler who can rest (not in a fight, not down) and moves the
// floor clock once; each crawler taps Rest on the phone (`rest.accept`) and gets that ruleset rest
// (the same recovery as `rest` / `rest.party`). The GM can rest someone from the desk (`rest.accept`
// with playerId) and closes the offer with `rest.close`. A pack without `ruleset.rests` falls back to
// short / long.
import { bad, notFound } from './errors.js';
import { SHEET, libraryOf, computeFor } from './character.js';
import { CRAWLERS_GM } from './crawlers.js';
import { bumpScene } from './skill-locks.js';
import { SCENE_GM } from './scenes.js';

const LABELS = { calm: 'Calm hour', short: 'Short rest', long: 'Long rest', day: 'Full-day rest' };
const PLACES = ['saferoom', 'camp', 'other'];

const restKinds = (pack) => pack.ruleset.rests ?? { short: { hours: 1 }, long: { hours: 8 } };

export function normalizeRestOffer(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.kind !== 'string') return null;
  return {
    id: raw.id, kind: raw.kind, place: PLACES.includes(raw.place) ? raw.place : 'saferoom', at: Number(raw.at) || 0,
    hours: Number(raw.hours) || 0,
    who: Array.isArray(raw.who) ? raw.who.filter((x) => typeof x === 'string') : [],
    done: raw.done && typeof raw.done === 'object' ? raw.done : {},
  };
}

const downOrAway = (st, p, pack) => {
  const rs = pack.ruleset;
  return computeFor(p, pack, libraryOf(st, pack)).computed.tracks[rs.hpTrack ?? 'hp']?.cur === 0;
};

function restOne(st, offer, p, ctx, out) {
  if (offer.done[p.id]) return offer.done[p.id];
  if (!offer.who.includes(p.id)) throw bad(`${p.name} is not part of this rest`);
  const sub = { ...out, result: null };
  // The ruleset's rest is GM-confirmed by design; the GM confirmed it by offering it.
  SHEET.rest(st, { kind: offer.kind, playerId: p.id }, { ...ctx, actor: { role: 'gm', playerId: null } }, sub);
  const restored = sub.result?.restored ?? [];
  offer.done[p.id] = { at: ctx.now, restored };
  out.emit({ kind: 'rest', playerId: p.id, name: p.name, restored, label: LABELS[offer.kind] ?? offer.kind }, { roles: ['gm', 'stage'], playerId: p.id });
  return offer.done[p.id];
}

export const REST_GM = {
  /** `{ kind, place? }` Offer a rest to everyone who can take it. Moves the floor clock once if it runs. */
  'rest.offer'(st, a, ctx, out) {
    const kinds = restKinds(ctx.pack);
    if (!Object.hasOwn(kinds, a.kind)) throw bad(`kind must be one of ${Object.keys(kinds).join(', ')}`);
    if (st.combat?.active) throw bad('finish combat before resting');
    const who = st.players.filter((p) => !downOrAway(st, p, ctx.pack)).map((p) => p.id);
    if (!who.length) throw bad('nobody can rest (a down crawler must be saved first)');
    const hours = kinds[a.kind].hours ?? 0;
    const k = st.crawlers?.clock;
    if (k?.hours != null && hours) {
      if (k.hours < hours) throw bad('not enough time before the floor collapses');
      CRAWLERS_GM['crawlers.clock'](st, { advance: hours }, ctx, { ...out, result: null });
    }
    bumpScene(st);
    // The TV shows the place (pack location "saferoom" when it has a picture), no text: the phones carry the rest.
    if (a.tv !== false) {
      const locId = a.place === 'camp' ? 'camp' : 'saferoom';
      const loc = libraryOf(st, ctx.pack).get('location', locId);
      SCENE_GM['scene.set'](st, { kind: 'explore', data: loc ? { locationId: locId, showText: false } : { location: a.place === 'camp' ? 'Camp' : 'Saferoom', text: '', showText: false } }, ctx, out);
    }
    st.restOffer = { id: ctx.genId('rest'), kind: a.kind, place: PLACES.includes(a.place) ? a.place : 'saferoom', at: ctx.now, hours, who, done: {} };
    out.emit({ kind: 'rest.offer', label: LABELS[a.kind] ?? a.kind, hours }, 'all');
    out.result = { id: st.restOffer.id, who: who.length };
  },
  /** `{ playerId }` The GM rests a crawler who has no phone at hand. */
  'rest.accept'(st, a, ctx, out) {
    const offer = st.restOffer;
    if (!offer) throw notFound('no rest offered');
    const p = st.players.find((x) => x.id === a.playerId);
    if (!p) throw notFound(`no crawler ${a.playerId}`);
    out.result = restOne(st, offer, p, ctx, out);
  },
  'rest.close'(st, a, ctx, out) {
    if (!st.restOffer) { out.changed = false; return; }
    const rested = Object.keys(st.restOffer.done).length;
    st.restOffer = null;
    out.result = { rested };
  },
};

export const REST_PLAYER = {
  /** `{ id }` Tap Rest on the phone. */
  'rest.accept'(st, a, ctx, out) {
    const offer = st.restOffer;
    if (!offer || (a.id && a.id !== offer.id)) throw bad('This rest is over.');
    if (st.combat?.active) throw bad('finish combat before resting');
    const p = st.players.find((x) => x.id === ctx.actor.playerId);
    if (!p) throw notFound('no crawler');
    out.result = restOne(st, offer, p, ctx, out);
  },
};

/** What each screen needs: the GM sees everyone; a crawler sees whether it may still rest. */
export function restOfferView(st, pack, role, playerId) {
  const o = st.restOffer;
  if (!o) return null;
  const kinds = restKinds(pack);
  const r = kinds[o.kind] ?? {};
  const base = { id: o.id, kind: o.kind, label: LABELS[o.kind] ?? o.kind, place: o.place, hours: o.hours, restore: r.restore ?? null };
  if (role === 'player') {
    if (!o.who.includes(playerId)) return null;
    return { ...base, done: o.done[playerId] ?? null };
  }
  const names = new Map(st.players.map((p) => [p.id, p.name]));
  return { ...base, crawlers: o.who.map((id) => ({ id, name: names.get(id) ?? '?', done: o.done[id] ?? null })) };
}
