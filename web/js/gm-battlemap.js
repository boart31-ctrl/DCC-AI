// Fight → battle map: the map of the running encounter next to the tracker. Move the tokens, reveal zones
// with one tap, flip the TV between the arena and the map. Mob tokens follow the fight (hidden ones dashed,
// fallen ones crossed out) because the encounter bound them to the combatants when it ran.
//
// createBattleMap({ act, goLiveFight }) → { el, update(view) }
import { h } from './client.js';
import { icon, select } from './ui.js';
import { createMapView } from './map-view.js';
import { libraryOf } from './rules.js';

export function createBattleMap({ act, goLiveFight }) {
  let view = null;
  let pick = null;
  let open = true;
  let sig = '';
  const el = h('section.panel.bm', { hidden: true });
  const mv = createMapView({
    gm: true,
    tool: () => 'move',
    canMoveToken: () => true,
    onTokenMove: (t, x, y) => cur() && act({ t: 'map.token.move', id: cur().id, tokenId: t.id, x, y }),
  });

  const uids = () => new Set((view?.combat?.combatants || []).map((c) => c.uid));
  /** Maps that belong to this fight: tokens bound to its combatants, or the one on the TV. */
  function candidates() {
    const live = uids();
    const onTv = view?.scene?.kind === 'map' ? view.scene.data?.mapId : null;
    return (view?.maps || []).map((m) => ({ m, n: m.tokens.filter((t) => t.ref && live.has(t.ref)).length + (m.id === onTv ? 0.5 : 0) })).filter((x) => x.n > 0 || x.m.id === view?.combat?.mapId).sort((a, b) => b.n - a.n).map((x) => x.m);
  }
  function cur() {
    const list = candidates();
    return list.find((m) => m.id === pick) || list[0] || null;
  }

  let dragging = null;
  mv.el.addEventListener('dragover', (e) => { if (dragging) e.preventDefault(); });
  mv.el.addEventListener('drop', (e) => {
    if (!dragging || !cur()) return;
    e.preventDefault();
    const c = dragging;
    dragging = null;
    act({ t: 'map.token.add', id: cur().id, kind: c.type === 'crawler' ? 'pc' : 'mob',
      ref: c.playerId || c.uid, label: c.name, hidden: !!c.hidden, ...mv.toLocal(e) });
  });

  function draw() {
    const m = cur();
    el.hidden = !m || !view?.combat?.combatants?.length;
    if (el.hidden) { mv.set(null); return; }
    const list = candidates();
    const onTv = view?.scene?.kind === 'map' && view.scene.data?.mapId === m.id;
    mv.set(m, {});
    el.replaceChildren(
      h('div.sec-head',
        h('button.bm-t', { type: 'button', 'aria-expanded': String(open), onclick: () => { open = !open; sig = ''; draw(); } }, icon(open ? 'down' : 'chevron', { size: 14 }), h('h2', 'Battle map')),
        list.length > 1 ? select(list.map((x) => ({ value: x.id, label: x.name })), m.id, { cls: 'inp-sm', label: 'Map', onChange: (v) => { pick = v; sig = ''; draw(); } }) : h('span.dim', m.name),
        h('span.grow'),
        onTv
          ? h('button.btn.btn-sm.btn-primary', { type: 'button', title: 'Put the arena back on the TV', onclick: () => goLiveFight() }, icon('tv', { size: 14 }), 'TV: fight')
          : h('button.btn.btn-sm', { type: 'button', title: 'Show this map on the TV (the fight goes on here)', onclick: () => act({ t: 'scene.set', kind: 'map', data: { mapId: m.id } }, 'Map on the TV.') }, icon('tv', { size: 14 }), 'TV: map')),
      ...(open ? [
        ...view.combat.combatants.filter((c) => !c.dead && !m.tokens.some((t) => t.ref === (c.playerId || c.uid))).map((c) =>
          h('button.btn.btn-sm', { type: 'button', draggable: true, ondragstart: (e) => {
            dragging = c; e.dataTransfer.setData('text/plain', c.uid);
          }, ondragend: () => { dragging = null; }, onclick: () => act({ t: 'map.token.add', id: m.id,
            kind: c.type === 'crawler' ? 'pc' : 'mob', ref: c.playerId || c.uid, label: c.name, hidden: !!c.hidden }) }, `Place ${c.name}`)),
        mv.el,
        m.zones.length ? h('div.bm-zones', h('span.dim', 'Zones:'), m.zones.map((z) => h('button.btn.btn-sm', { type: 'button', class: z.revealed ? 'btn btn-sm' : 'btn btn-sm btn-quiet', 'aria-pressed': String(z.revealed), title: z.revealed ? 'Revealed: click to hide' : 'Hidden: click to reveal', onclick: () => act({ t: 'map.zone.reveal', id: m.id, zoneId: z.id, on: !z.revealed }) }, icon(z.revealed ? 'eye' : 'lock', { size: 12 }), z.name))) : null,
        h('p.dim.pp-hint', 'Drag tokens to move them. Hidden mobs show dashed until you reveal them in the tracker.'),
      ] : []));
  }

  function update(v) {
    view = v;
    const s = JSON.stringify([v.maps, v.scene?.kind, v.scene?.data?.mapId, (v.combat?.combatants || []).map((c) => [c.uid, c.hidden, c.down]), pick, open]);
    if (s === sig) return;
    sig = s;
    draw();
  }
  return { el, update };
}

/**
 * Fight → loot of the encounter that ran last (its prepared items, enc.give): one tap gives an item to a
 * crawler. Stays until everything is handed out.
 */
export function createEncounterLoot({ act }) {
  const el = h('section.panel.bm-loot', { hidden: true });
  let sig = '';
  function update(view) {
    const enc = (view?.gm?.prepCards || []).filter((c) => c.kind === 'encounter' && c.used && (c.payload?.items || []).length).sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0))[0];
    const items = enc?.payload?.items || [];
    const s = JSON.stringify([enc?.id, items, (view?.players || []).map((p) => [p.id, p.name])]);
    if (s === sig) return;
    sig = s;
    el.hidden = !enc || items.every((x) => x.given);
    if (el.hidden) { el.replaceChildren(); return; }
    const lib = libraryOf(view).item || [];
    const players = view.players || [];
    el.replaceChildren(
      h('div.sec-head', icon('gift', { size: 14 }), h('h2', `Loot: ${enc.label}`)),
      h('ul.bm-items', items.map((x, i) => {
        const e = lib.find((it) => it.id === x.id);
        return h('li.bm-item',
          h('b', `${x.qty > 1 ? `${x.qty}× ` : ''}${e?.name || x.id}`),
          x.given
            ? h('span.dim', icon('check', { size: 12 }), players.find((p) => p.id === x.given)?.name || 'given')
            : h('span.bm-give', players.map((p) => h('button.btn.btn-sm', { type: 'button', title: `Give it to ${p.name}`, onclick: () => act({ t: 'enc.give', id: enc.id, index: i, playerId: p.id }, `${e?.name || 'Item'} → ${p.name}.`) }, p.name))));
      })));
  }
  return { el, update };
}
