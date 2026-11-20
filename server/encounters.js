// Prepared encounters: built in Prep from the library, never touching the live fight until the GM runs them.
// Pure + browser-safe.
//
// An encounter is a prepared card of kind "encounter" (state.prepCards), so the Fight tab's encounter chips
// and `prep.card.fire` keep working. Its payload:
//   { mobs: [{ kind: 'monster'|'boss', sourceId, count, hidden }], mapId?, notes?, items?: [{ id, qty, given? }] }
//     hidden   the mob starts hidden (revealed with one tap during the fight)
//     mapId    battle map: mob tokens are placed there in prep (enc.tokens) and bound to the real
//              combatants when the encounter runs, so revealing / killing a mob shows on the map
//     notes    GM notes: where they lurk, what they want, when they flee
//     items    library items the mobs drop: handed out from the Fight tab after the battle (enc.give);
//              `given` = the player id who got it
//
// makeEncounterGM(GM) → { 'enc.save', 'enc.remove', 'enc.tokens', 'enc.run', 'enc.give' } (needs the merged GM table
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

function itemsArg(v, old = []) {
  if (!Array.isArray(v) || v.length > 12) throw bad('items must be 0..12 entries');
  const pool = [...old];
  return v.map((x) => {
    if (!isObj(x) || typeof x.id !== 'string' || !ID_RE.test(x.id)) throw bad('each item needs a library id');
    const qty = x.qty === undefined ? 1 : x.qty;
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw bad('qty must be 1..99');
    // Keep who already got it (the same item, first match).
    const i = pool.findIndex((o) => o?.id === x.id);
    const given = i >= 0 ? pool[i].given : undefined;
    if (i >= 0) pool[i] = null;
    return { id: x.id, qty, ...(typeof given === 'string' ? { given } : {}) };
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
    for (let k = 0; k < n; k++) out.push({ entry: i, name: n > 1 ? `${e?.name ?? m.sourceId} ${k + 1}` : (e?.name ?? m.sourceId), hidden: m.hidden !== false, sourceKind: m.kind ?? 'monster', sourceId: m.sourceId, artIndex: k, color: m.kind === 'boss' ? '#ff9900' : '#ff3355', missing: !e });
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
      const prev = a.id ? cardOf(st, a.id) : null;
      if (a.items !== undefined) { const items = itemsArg(a.items, prev?.payload?.items ?? []); if (items.length) payload.items = items; }
      else if (prev?.payload?.items?.length) payload.items = prev.payload.items;
      if (a.id) {
        const c = prev;
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
     * `{ id, start?, mapId? }` Run it: every mob into the fight (hidden ones stay hidden), map tokens bound to them,
     * and with `start` the fight begins. The card is marked used (it can run again).
     */
    'enc.run'(st, a, ctx, out) {
      const c = cardOf(st, a.id);
      const mobs = c.payload?.mobs ?? [];
      if (!mobs.length) throw bad('this encounter has no mobs');
      const mapId = a.mapId === undefined ? c.payload?.mapId : a.mapId;
      const map = mapId && st.maps?.list.find((m) => m.id === mapId);
      if (a.mapId != null && !map) throw notFound(`no map ${a.mapId}`);
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
      if (a.mapId === null) st.combat.mapId = null;
      if (map) {
        st.combat.mapId = map.id;
        placeEncounterTokens(st, map.id, c.id, expandEncounter(st, ctx, c.payload), ctx);
      }
      const bound = map ? bindEncounterTokens(st, map.id, c.id, uids) : 0;
      if (c.payload.items?.length) GM['combat.victoryLoot'](st, { items: c.payload.items.filter((it) => !it.given) }, ctx);
      c.used = true;
      c.usedAt = ctx.now;
      if (a.start === true && !st.combat?.active) GM['combat.start'](st, {}, ctx, out);
      out.result = { uids: uids.filter(Boolean), skipped, mapId: mapId ?? null, bound };
    },

    /** `{ id, index, playerId }` Hand out one of the encounter's prepared items (the whole qty). */
    'enc.give'(st, a, ctx, out) {
      const c = cardOf(st, a.id);
      const it = (c.payload?.items ?? [])[a.index];
      if (!it) throw notFound(`no item ${a.index} in ${c.label}`);
      if (it.given) throw bad('this item was already given');
      const sub = { ...out, result: null };
      GM['lib.give'](st, { playerId: a.playerId, kind: 'item', id: it.id, qty: it.qty }, ctx, sub);
      it.given = a.playerId;
      out.result = { uid: sub.result?.uid ?? null };
    },
  };
}
