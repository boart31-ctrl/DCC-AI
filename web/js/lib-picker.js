import { originBadge, originOptions } from './gm-origins.js';
// Library picker: pull entries from the library in a few clicks (Prep, encounters, scene links).
// A wide drawer: search, kind chips, floor chips, a grid of tiles with their pictures.
//
// pickFromLibrary({ view, kinds, title, multi, counts, exclude, onPick })
//   kinds    which kinds to offer: library kinds (monster, boss, npc, location, item, spell, buff) and
//            'encounter' (prepared encounters), 'map', 'card' (other prepared cards)
//   multi    tap tiles to collect several, then "Add"; otherwise one tap picks and closes
//   counts   (multi) monsters / bosses / items get a count stepper (how many of them)
//   exclude  Set of "kind:id" already linked (shown ticked, not offered again)
//   onPick([{ kind, id, count }])
import { h } from './client.js';
import { icon, openDrawer, closeDrawer, stepper } from './ui.js';
import { libraryOf } from './rules.js';
import { entryArt } from './portrait.js';

export const KIND_LABEL = { encounter: 'Encounter', monster: 'Monster', boss: 'Boss', npc: 'NPC', location: 'Location', item: 'Item', spell: 'Spell', buff: 'Buff', card: 'Card', map: 'Map' };
const KIND_PLURAL = { encounter: 'Encounters', monster: 'Monsters', boss: 'Bosses', npc: 'NPCs', location: 'Locations', item: 'Items', spell: 'Spells', buff: 'Buffs', card: 'Cards', map: 'Maps' };
let lastKind = null;
let lastFloor = '';

/** Every entry of one kind as { id, name, sub, floor, art } for tiles and lookups. */
export function entriesOf(view, kind) {
  const lib = libraryOf(view);
  const cards = view?.gm?.prepCards || [];
  if (kind === 'encounter') {
    return cards.filter((c) => c.kind === 'encounter').map((c) => ({
      id: c.id, name: c.label, floor: '',
      sub: (c.payload?.mobs || []).map((m) => `${m.count || 1}× ${(lib[m.kind || 'monster'] || []).find((e) => e.id === m.sourceId)?.name || m.sourceId}`).join(', ') || 'No mobs yet',
      art: null, glyph: 'swords',
    }));
  }
  if (kind === 'card') return cards.filter((c) => c.kind !== 'encounter').map((c) => ({ id: c.id, name: c.label, sub: c.kind, floor: '', art: null, glyph: 'star' }));
  if (kind === 'map') return (view?.maps || []).map((m) => ({ id: m.id, name: m.name, sub: `${m.zones?.length || 0} zones`, floor: '', art: { name: m.name, image: m.image } }));
  return (lib[kind] || []).map((e) => ({
    id: e.id, name: e.name, origin: e.origin, floor: e.floor ?? '',
    sub: [
      e.floor !== '' && e.floor != null ? `F${e.floor}` : null,
      e.title || e.role || e.group || null,
      e.hpSlots != null ? `${e.hpSlots} HP` : null,
      e.level != null ? `L${e.level}` : e.cr != null ? `CR ${e.cr}` : null,
      e.rarity || null,
    ].filter(Boolean).join(' · '),
    art: ['monster', 'boss', 'npc', 'location', 'item'].includes(kind) ? e : null,
  }));
}

export function entryName(view, ref) {
  return entriesOf(view, ref.kind).find((e) => e.id === ref.id)?.name || null;
}

export function pickFromLibrary({ view, kinds, title = 'Add from the library', multi = false, counts = false, exclude = new Set(), onPick }) {
  const avail = kinds.filter((k) => entriesOf(view, k).length);
  let kind = avail.includes(lastKind) ? lastKind : avail[0] || kinds[0];
  let q = '';
  let floor = lastFloor;
  const chosen = new Map(); // "kind:id" → count
  const grid = h('div.lp-grid');
  const originSel = h('select.inp', { 'aria-label': 'Origin', onchange: () => drawGrid() }, originOptions(view.gm?.origins));
  const floorsEl = h('div.lp-chips');
  const foot = h('div.lp-foot');
  const search = h('input.inp.lp-q', { type: 'search', placeholder: 'Search by name…', 'aria-label': 'Search', oninput: (e) => { q = e.target.value.trim().toLowerCase(); drawGrid(); } });

  const kindChips = h('div.lp-chips', { role: 'tablist' });
  function drawKinds() {
    kindChips.replaceChildren(...kinds.map((k) => {
      const n = entriesOf(view, k).length;
      return h('button.lp-chip', { type: 'button', role: 'tab', 'aria-selected': String(k === kind), disabled: !n, onclick: () => { kind = k; lastKind = k; floor = ''; drawKinds(); drawGrid(); } }, KIND_PLURAL[k] || k, h('span.dim', ` ${n}`));
    }));
  }
  function done(list) {
    closeDrawer(true);
    if (list.length) onPick(list);
  }
  function drawFoot() {
    if (!multi) { foot.replaceChildren(); return; }
    const n = [...chosen.values()].reduce((a, b) => a + b, 0);
    foot.replaceChildren(
      h('span.dim', n ? `${chosen.size} picked${counts ? ` (${n} in total)` : ''}` : 'Tap tiles to pick them.'),
      h('span.grow'),
      h('button.btn.btn-primary', { type: 'button', disabled: !n, onclick: () => done([...chosen].map(([k, c]) => { const [kk, ...id] = k.split(':'); return { kind: kk, id: id.join(':'), count: c }; })) }, icon('plus', { size: 14 }), n ? `Add ${n}` : 'Add'));
  }
  function drawGrid() {
    const all = entriesOf(view, kind);
    const floors = [...new Set(all.map((e) => e.floor).filter((f) => f !== '' && f != null))].sort((a, b) => Number(a) - Number(b));
    if (floor !== '' && !floors.map(String).includes(String(floor))) floor = '';
    floorsEl.hidden = floors.length < 2;
    floorsEl.replaceChildren(...[['', 'All floors'], ...floors.map((f) => [String(f), `Floor ${f}`])].map(([v, label]) =>
      h('button.lp-chip.sm', { type: 'button', 'aria-pressed': String(String(floor) === v), onclick: () => { floor = v; lastFloor = v; drawGrid(); } }, label)));
    const list = all.filter((e) => (!originSel.value || e.origin === originSel.value) && (!q || e.name.toLowerCase().includes(q) || e.sub.toLowerCase().includes(q)) && (floor === '' || String(e.floor) === String(floor)))
      .sort((a, b) => a.name.localeCompare(b.name));
    grid.replaceChildren(...(list.length ? list.map((e) => {
      const key = `${kind}:${e.id}`;
      const had = exclude.has(key);
      const n = chosen.get(key) || 0;
      const withCount = counts && (kind === 'monster' || kind === 'boss' || kind === 'item');
      return h('div.lp-tile', { class: `lp-tile${n ? ' on' : ''}${had ? ' had' : ''}` },
        h('button.lp-tile-b', {
          type: 'button', disabled: had && !multi, title: had ? 'Already linked' : e.name,
          onclick: () => {
            if (!multi) { done([{ kind, id: e.id, count: 1 }]); return; }
            if (n) chosen.delete(key); else chosen.set(key, 1);
            drawGrid(); drawFoot();
          },
        },
        e.art ? entryArt(e.art, { cls: 'lp-art', lit: false }) : h('span.lp-art.lp-glyph', icon(e.glyph || 'star', { size: 22 })),
        h('span.lp-name', e.name), h('span.lp-sub', e.sub || KIND_LABEL[kind]),
        had ? h('span.lp-had', icon('check', { size: 12 }), 'linked') : null),
        originBadge(e, view.gm?.origins),
        withCount && n ? stepper(n, { min: 1, max: 20, label: `How many ${e.name}`, onChange: (v) => { chosen.set(key, v); drawGrid(); drawFoot(); } }) : null);
    }) : [h('p.empty-s', q ? `Nothing called "${q}".` : `No ${(KIND_PLURAL[kind] || kind).toLowerCase()} yet. Add them in the Library.`)]));
  }

  if (kinds.length > 1) drawKinds();
  openDrawer({
    title, wide: true,
    sub: multi ? 'Tap to pick, then Add. Filter by floor or type a name.' : 'Tap one to add it.',
    body: h('div.lp', search, kinds.length > 1 ? kindChips : null, originSel, floorsEl, grid, foot),
  });
  drawGrid();
  drawFoot();
  requestAnimationFrame(() => search.focus());
}
