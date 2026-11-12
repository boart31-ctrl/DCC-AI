// Loot from the dead: a downed mob drops its library `lootItems`, a dead crawler drops their inventory.
// Drops are piles the GM hands out item by item (no loot box, no dice). They outlive the fight (looting
// happens after it) and go with session.new.
//
//   st.drops = [{ id, at, from: { type: 'mob'|'crawler', uid, name, image, playerId? },
//                 items: [{ key, itemId, name, rarity, image, qty, invUid?, takenBy: playerId|null }] }]
//
// Events: `loot.drop` (all: the TV shows what fell), `loot.take` (all: who picked up what).
import { bad, notFound } from './errors.js';
import { libraryOf, giveItem } from './character.js';
import { combatantOf } from './combat.js';

export const MAX_DROPS = 24;
export const MAX_DROP_ITEMS = 40;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function normalizeDrops(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((d) => isObj(d) && typeof d.id === 'string' && isObj(d.from) && Array.isArray(d.items)).slice(-MAX_DROPS).map((d) => ({
    id: d.id,
    at: Number(d.at) || 0,
    from: {
      type: d.from.type === 'crawler' ? 'crawler' : 'mob',
      uid: typeof d.from.uid === 'string' ? d.from.uid : null,
      name: String(d.from.name ?? '').slice(0, 80),
      image: typeof d.from.image === 'string' ? d.from.image : null,
      ...(typeof d.from.playerId === 'string' ? { playerId: d.from.playerId } : {}),
    },
    items: d.items.filter(isObj).slice(0, MAX_DROP_ITEMS).map((x, k) => ({
      key: typeof x.key === 'string' ? x.key : `k${k}`,
      itemId: typeof x.itemId === 'string' ? x.itemId : null,
      name: String(x.name ?? '').slice(0, 120),
      rarity: typeof x.rarity === 'string' ? x.rarity : null,
      image: typeof x.image === 'string' ? x.image : null,
      qty: Number.isInteger(x.qty) && x.qty > 0 ? x.qty : 1,
      ...(typeof x.invUid === 'string' ? { invUid: x.invUid } : {}),
      takenBy: typeof x.takenBy === 'string' ? x.takenBy : null,
    })),
  }));
}

const pub = (x) => ({ key: x.key, name: x.name, rarity: x.rarity, image: x.image, qty: x.qty });
const playerOf = (st, id) => {
  const p = st.players.find((x) => x.id === id);
  if (!p) throw notFound(`no player ${id}`);
  return p;
};

export const LOOT_GM = {
  /**
   * Loot a body: `uid` = a downed combatant (mob → its library lootItems, crawler → their inventory),
   * optional `itemIds` replaces a mob's list (GM's own pick). One drop per body.
   */
  'loot.corpse'(st, a, ctx, out) {
    st.drops = Array.isArray(st.drops) ? st.drops : [];
    const x = combatantOf(st, a.uid);
    if (st.drops.some((d) => d.from.uid === x.uid)) throw bad('already looted (see the loot piles)');
    const lib = libraryOf(st, ctx.pack);
    let from;
    let items = [];
    if (x.type === 'mob') {
      if (x.hp > 0) throw bad(`${x.name} is still standing`);
      let ids;
      if (a.itemIds !== undefined) {
        if (!Array.isArray(a.itemIds) || a.itemIds.length > MAX_DROP_ITEMS || !a.itemIds.every((id) => typeof id === 'string' && ID_RE.test(id))) throw bad('itemIds must be a list of item ids');
        ids = a.itemIds;
      } else {
        const src = x.sourceKind && x.sourceId ? lib.get(x.sourceKind, x.sourceId) : null;
        ids = src?.lootItems ?? [];
      }
      for (const id of ids) {
        const def = lib.get('item', id);
        if (def) items.push({ key: ctx.genId('lk'), itemId: def.id, name: def.name, rarity: def.rarity ?? null, image: def.image ?? null, qty: 1, takenBy: null });
      }
      from = { type: 'mob', uid: x.uid, name: x.name, image: x.image ?? null };
    } else {
      const p = playerOf(st, x.playerId);
      items = p.inventory.slice(0, MAX_DROP_ITEMS).map((i) => ({ key: ctx.genId('lk'), itemId: i.itemId ?? null, name: i.name, rarity: i.rarity ?? null, image: i.image ?? null, qty: i.qty ?? 1, invUid: i.uid, takenBy: null }));
      from = { type: 'crawler', uid: x.uid, name: p.name, image: null, playerId: p.id };
    }
    if (!items.length) throw bad(x.type === 'mob' ? `${x.name} has nothing to drop (set its loot in the library, or pick items)` : `${from.name} carries nothing`);
    const drop = { id: ctx.genId('dr'), at: ctx.now, from, items };
    st.drops.push(drop);
    while (st.drops.length > MAX_DROPS) st.drops.shift();
    const ev = out.emit({ kind: 'loot.drop', dropId: drop.id, from: { type: from.type, name: from.name, image: from.image }, items: items.map(pub) }, 'all');
    ctx.h.feedPush?.(st, ev, `${from.name} dropped ${items.length === 1 ? items[0].name : `${items.length} items`}`);
    out.result = { dropId: drop.id, items: items.length };
  },

  /** Hand one item of a drop to a crawler (a dead crawler's own item moves, a mob's is created). */
  'loot.take'(st, a, ctx, out) {
    const d = (st.drops ?? []).find((x) => x.id === a.dropId);
    if (!d) throw notFound(`no drop ${a.dropId}`);
    const it = d.items.find((x) => x.key === a.key);
    if (!it) throw notFound(`no item ${a.key} in that drop`);
    if (it.takenBy) throw bad(`${it.name} is already taken`);
    const p = playerOf(st, a.playerId);
    let inv;
    if (it.invUid) {
      const owner = st.players.find((x) => x.id === d.from.playerId);
      const idx = owner ? owner.inventory.findIndex((i) => i.uid === it.invUid) : -1;
      if (idx < 0) throw bad(`${it.name} is no longer on ${d.from.name}`);
      if (owner.id === p.id) throw bad(`${p.name} already has it`);
      const [moved] = owner.inventory.splice(idx, 1);
      for (const c of owner.inventory) if (c.containerUid === moved.uid) c.containerUid = null; // its contents stay behind
      owner.sheet.hotlist = (owner.sheet.hotlist ?? []).map((u) => (u === moved.uid ? null : u));
      moved.containerUid = null;
      moved.equippedSlot = null;
      p.inventory.push(moved);
      inv = moved;
    } else {
      const def = libraryOf(st, ctx.pack).get('item', it.itemId);
      if (!def) throw notFound(`unknown item ${it.itemId}`);
      inv = giveItem(p, def, ctx, it.qty);
    }
    it.takenBy = p.id;
    const ev = out.emit({ kind: 'loot.take', dropId: d.id, playerId: p.id, name: p.name, item: pub(it), from: d.from.name }, 'all');
    ctx.h.feedPush?.(st, ev, `${p.name} took ${it.name} from ${d.from.name}`);
    out.result = { uid: inv.uid };
  },

  /** Forget a pile (what is left stays where it was: a dead crawler keeps their untaken items). */
  'loot.clear'(st, a) {
    const before = (st.drops ?? []).length;
    st.drops = (st.drops ?? []).filter((d) => d.id !== a.dropId);
    if (st.drops.length === before) throw notFound(`no drop ${a.dropId}`);
  },
};
