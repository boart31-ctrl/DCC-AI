// Prepared encounters: built in Prep from the library, never touching the live fight until the GM runs them.
// Pure + browser-safe.
//
// An encounter is a prepared card of kind "encounter" (state.prepCards), so the Fight tab's encounter chips
// and `prep.card.fire` keep working. Its payload:
//   { mobs: [{ kind: 'monster'|'boss', sourceId, count, hidden }], mapId?, notes?, tactics?, loot?: [cardId] }
//     hidden   the mob starts hidden (revealed with one tap during the fight)
//     mapId    battle map: mob tokens are placed there in prep (enc.tokens) and bound to the real
//              combatants when the encounter runs, so revealing / killing a mob shows on the map
//     notes    GM notes: where they lurk, what they want, when they flee
//     loot     prepared loot cards to hand out after the fight
//
// makeEncounterGM(GM) → { 'enc.save', 'enc.remove', 'enc.tokens', 'enc.run' } (needs the merged GM table
// for combat.addMob / combat.start).
import { bad, notFound } from './errors.js';
import { libraryOf } from './character.js';
import { placeEncounterTokens, bindEncounterTokens } from './maps.js';

export const MAX_ENCOUNTER_MOBS = 20;
const ID_RE = /^[A-Za-z0-9_-]{1,60}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function mobsArg(v) {
  if (!Array.isArray(v) || v.length > MAX_ENCOUNTER_MOBS) throw bad(`mobs must be 0..${MAX_ENCOUNTER_MOBS} entries`);
  return v.map((m) => {
    if (!isObj(m) || typeof m.sourceId !== 'string' || !ID_RE.test(m.sourceId)) throw bad('each mob needs a library sourceId');
    if (m.kind !== undefined && m.kind !== 'monster' && m.kind !== 'boss') throw bad('mob kind must be monster or boss');
    const count = m.count === undefined ? 1 : m.count;
    if (!Number.isInteger(count) || count < 1 || count > 20) throw bad('count must be 1..20');
    return { kind: m.kind ?? 'monster', sourceId: m.sourceId, count, hidden: m.hidden !== false };
  });
}

function cardOf(st, id) {
  const c = (st.prepCards ?? []).find((x) => x.id === id && x.kind === 'encounter');
  if (!c) throw notFound(`no encounter ${id}`);
  return c;
}

/** One entry per mob (count expanded), with the names the fight will give them. */
export function expandEncounter(st, ctx, payload) {
  const lib = libraryOf(st, ctx.pack);
  const out = [];
  for (const [i, m] of (payload?.mobs ?? []).entries()) {
    const e = lib.get(m.kind ?? 'monster', m.sourceId);
    const n = m.count ?? 1;
    for (let k = 0; k < n; k++) out.push({ entry: i, name: n > 1 ? `${e?.name ?? m.sourceId} ${k + 1}` : (e?.name ?? m.sourceId), hidden: m.hidden !== false, color: m.kind === 'boss' ? '#ff9900' : '#ff3355', missing: !e });
  }
  return out;
}

export function makeEncounterGM(GM) {
  return {
    /** `{ id?, label, mobs, mapId?, notes?, tactics?, loot? }` → result `{ id }`. Create or replace. */
    'enc.save'(st, a, ctx, out) {
      const label = str(a.label, 80).trim();
      if (!label) throw bad('label required');
      const payload = { mobs: mobsArg(a.mobs ?? []) };
      if (a.mapId != null && a.mapId !== '') {
        if (typeof a.mapId !== 'string' || !(st.maps?.list ?? []).some((m) => m.id === a.mapId)) throw notFound(`no map ${a.mapId}`);
        payload.mapId = a.mapId;
      }
      if (a.notes) payload.notes = str(a.notes, 2000);
      if (Array.isArray(a.loot)) payload.loot = a.loot.filter((x) => typeof x === 'string' && ID_RE.test(x)).slice(0, 10);
      if (a.id) {
        const c = cardOf(st, a.id);
        const oldMap = c.payload?.mapId;
        c.label = label;
        c.payload = payload;
        // Map changed or gone: its old tokens of this encounter go with it.
        if (oldMap && oldMap !== payload.mapId) {
          const m = (st.maps?.list ?? []).find((x) => x.id === oldMap);
          if (m) m.tokens = m.tokens.filter((t) => t.enc !== c.id);
        }
        out.result = { id: c.id };
        return;
      }
      GM['prep.card.add'](st, { kind: 'encounter', label, payload }, ctx, out);
    },

    'enc.remove'(st, a) {
      const c = cardOf(st, a.id);
      for (const m of st.maps?.list ?? []) m.tokens = m.tokens.filter((t) => t.enc !== c.id);
      st.prepCards = st.prepCards.filter((x) => x !== c);
    },

    /**
     * `{ id, party?: true }` Put the encounter's mobs on its map as tokens (hidden like the mobs), and with
     * `party` a token for every crawler (their start). Re-running syncs names / counts, keeps positions.
     */
    'enc.tokens'(st, a, ctx, out) {
      const c = cardOf(st, a.id);
      const mapId = c.payload?.mapId;
      if (!mapId) throw bad('this encounter has no map');
      const added = placeEncounterTokens(st, mapId, c.id, expandEncounter(st, ctx, c.payload), ctx);
      let party = 0;
      if (a.party) {
        const sub = { ...out, result: null };
        GM['map.token.party'](st, { id: mapId }, ctx, sub);
        party = sub.result?.added ?? 0;
      }
      out.result = { added, party };
    },

    /**
     * `{ id, start? }` Run it: every mob into the fight (hidden ones stay hidden), map tokens bound to them,
     * and with `start` the fight begins. The card is marked used (it can run again).
     */
    'enc.run'(st, a, ctx, out) {
      const c = cardOf(st, a.id);
      const mobs = c.payload?.mobs ?? [];
      if (!mobs.length) throw bad('this encounter has no mobs');
      const uids = [];
      const skipped = [];
      for (const m of mobs) {
        const sub = { ...out, result: null };
        try {
          GM['combat.addMob'](st, { kind: m.kind, sourceId: m.sourceId, count: m.count ?? 1, hidden: m.hidden !== false }, ctx, sub);
          uids.push(...(sub.result?.uids ?? []));
        } catch (err) {
          if (err?.code !== 'not_found') throw err;
          skipped.push(m.sourceId);
          for (let k = 0; k < (m.count ?? 1); k++) uids.push(null);
        }
      }
      const bound = c.payload?.mapId ? bindEncounterTokens(st, c.payload.mapId, c.id, uids) : 0;
      c.used = true;
      c.usedAt = ctx.now;
      if (a.start === true && !st.combat?.active) GM['combat.start'](st, {}, ctx, out);
      out.result = { uids: uids.filter(Boolean), skipped, mapId: c.payload?.mapId ?? null, bound };
    },
  };
}
