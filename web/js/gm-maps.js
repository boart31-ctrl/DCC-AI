// GM desk → Show → Map: maps with fog of war (server/maps.js). Draw zones on the image, reveal them with
// one tap at the table, brush-reveal by dragging a rectangle, link zones to encounters / NPCs / cards, and
// (online play) a token layer the players can drag on their phones.
//
// createMaps({ act, getView, scenes, showView }) → { el, update(view) }
import { h, toast, ask } from './client.js';
import { icon, field, select, openDrawer, closeDrawer } from './ui.js';
import { libraryOf } from './rules.js';
import { createMapView } from './map-view.js';

const store = {
  get(k, d) { try { const v = localStorage.getItem(`system.maps.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`system.maps.${k}`, JSON.stringify(v)); } catch {} },
};
const LINK_LABEL = { monster: 'Monster', boss: 'Boss', npc: 'NPC', location: 'Location', item: 'Item', card: 'Card' };

/** Loads an image to learn its aspect ratio (width / height). */
function measure(url) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im.naturalWidth && im.naturalHeight ? Math.max(0.2, Math.min(5, im.naturalWidth / im.naturalHeight)) : null);
    im.onerror = () => resolve(null);
    im.src = url;
  });
}

export function createMaps({ act, getView, scenes, showView }) {
  let view = null;
  let sig = '';
  let pending = false;
  const st = { sel: store.get('sel', null), tool: 'zone', zone: null };
  const el = h('div.gmap');
  const mv = createMapView({
    gm: true,
    onDrag: (rect) => onDrag(rect),
    onTokenMove: (t, x, y) => cur() && act({ t: 'map.token.move', id: cur().id, tokenId: t.id, x, y }),
    canMoveToken: () => st.tool === 'tokens',
  });

  const maps = () => view?.maps || [];
  const cur = () => maps().find((m) => m.id === st.sel) || maps()[0] || null;
  const lib = () => libraryOf(view);
  const cards = () => view?.gm?.prepCards || [];
  const pick = (id) => { st.sel = id; st.zone = null; store.set('sel', id); scenes.loadDraft('map', { mapId: id }); sig = ''; draw(); };

  async function onDrag(rect) {
    const m = cur();
    if (!m) return;
    if (st.tool === 'reveal' || st.tool === 'cover') { act({ t: 'map.fog', id: m.id, rect, reveal: st.tool === 'reveal' }); return; }
    if (st.tool !== 'zone') return;
    const name = await promptName('New zone', `Zone ${m.zones.length + 1}`);
    if (!name) return;
    const r = await act({ t: 'map.zone.add', id: m.id, name, shape: rect });
    if (r?.result?.zoneId) { st.zone = r.result.zoneId; sig = ''; draw(); }
  }

  function promptName(title, value = '') {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      openDrawer({
        title,
        onClose: () => finish(null),
        body: h('form.gmap-new', { onsubmit: (e) => { e.preventDefault(); const v = e.target.n.value.trim(); finish(v || null); closeDrawer(true); } },
          h('label.lbl', h('span.lbl-t', 'Name'), h('input.inp', { name: 'n', value, maxlength: 80, required: true })),
          h('button.btn.btn-primary', { type: 'submit' }, 'OK')),
      });
      requestAnimationFrame(() => { const i = document.querySelector('.gmap-new input[name=n]'); i?.focus(); i?.select(); });
    });
  }

  function newMap() {
    const locs = (lib().location || []).filter((l) => l.image);
    const form = h('form.gmap-new', {
      onsubmit: async (e) => {
        e.preventDefault();
        const f = e.target;
        const image = (f.url.value.trim() || f.loc?.value || '').trim();
        const name = f.n.value.trim() || 'Map';
        if (!image) { toast('Pick a picture or paste an image URL.', { error: true }); return; }
        const aspect = await measure(image);
        if (!aspect) { toast('That image does not load. Check the URL.', { error: true }); return; }
        const r = await act({ t: 'map.add', name, image, aspect }, 'Map created. Draw zones by dragging on it.');
        if (r?.result?.id) { closeDrawer(true); pick(r.result.id); }
      },
    },
    h('label.lbl', h('span.lbl-t', 'Name'), h('input.inp', { name: 'n', maxlength: 80, placeholder: 'Bogbricks, north quarter' })),
    locs.length ? h('label.lbl', h('span.lbl-t', 'Picture of a library location'), select([{ value: '', label: 'None' }, ...locs.map((l) => ({ value: l.image, label: l.name }))], '', { label: 'Location picture' })) : null,
    h('label.lbl', h('span.lbl-t', 'Or an image URL'), h('input.inp', { name: 'url', placeholder: 'https://… or /pack/maps/…' }), h('span.lbl-hint', 'Any picture works: a bought map, an AI picture, a screenshot. Files in the content pack go under /pack/.')),
    h('button.btn.btn-primary', { type: 'submit' }, 'Create map'));
    const sel = form.querySelector('select');
    if (sel) sel.name = 'loc';
    openDrawer({ title: 'New map', body: form });
  }

  function useLink(l) {
    const all = l.kind === 'card' ? cards() : lib()[l.kind] || [];
    const e = all.find((x) => x.id === l.id);
    if (!e) { toast('Not in the library any more.', { error: true }); return; }
    if (l.kind === 'npc' || l.kind === 'boss' || l.kind === 'location') {
      scenes.loadDraft(l.kind === 'location' ? 'explore' : l.kind, l.kind === 'npc' ? { npcId: l.id } : l.kind === 'boss' ? { bossId: l.id } : { locationId: l.id });
      toast(`${e.name} is in the preview.`);
    } else if (l.kind === 'monster') act({ t: 'combat.addMob', kind: 'monster', sourceId: l.id, count: 1, hidden: true }, `${e.name} added to the fight (hidden).`);
    else if (l.kind === 'card') act({ t: 'prep.card.fire', id: l.id }, `${e.label} fired.`);
  }
  const linkName = (l) => (l.kind === 'card' ? cards().find((c) => c.id === l.id)?.label : (lib()[l.kind] || []).find((x) => x.id === l.id)?.name) || `${l.id} (missing)`;

  function zoneCard(m, z) {
    const open = st.zone === z.id;
    const setLinks = (links) => act({ t: 'map.zone.update', id: m.id, zoneId: z.id, links });
    const linkOpts = [];
    for (const k of ['monster', 'boss', 'npc', 'item']) {
      const opts = (lib()[k] || []).filter((e) => !z.links.some((l) => l.kind === k && l.id === e.id)).map((e) => ({ value: `${k}:${e.id}`, label: e.name }));
      if (opts.length) linkOpts.push({ label: LINK_LABEL[k], options: opts });
    }
    const cardOpts = cards().filter((c) => !z.links.some((l) => l.kind === 'card' && l.id === c.id)).map((c) => ({ value: `card:${c.id}`, label: `${c.label} (${c.kind})` }));
    if (cardOpts.length) linkOpts.push({ label: 'Prepared cards', options: cardOpts });
    return h('li.gmap-zone', { class: open ? 'gmap-zone sel' : 'gmap-zone' },
      h('div.gmap-zone-head',
        h('b', { onclick: () => { st.zone = open ? null : z.id; sig = ''; draw(); }, title: 'Details' }, z.name),
        h('button.btn.btn-sm', { type: 'button', class: z.revealed ? 'btn btn-sm' : 'btn btn-sm btn-primary', onclick: () => act({ t: 'map.zone.reveal', id: m.id, zoneId: z.id, on: !z.revealed }, z.revealed ? `${z.name} hidden again.` : `${z.name} revealed.`) }, z.revealed ? 'Hide' : 'Reveal')),
      open ? [
        field(z.name, { cls: 'inp-sm', onCommit: (v) => v.trim() && act({ t: 'map.zone.update', id: m.id, zoneId: z.id, name: v.trim() }) }),
        field(z.text, { multiline: true, rows: 3, placeholder: 'Read-aloud: what the crawlers see (phones show it once revealed)', onCommit: (v) => act({ t: 'map.zone.update', id: m.id, zoneId: z.id, text: v }) }),
        field(z.notes, { multiline: true, rows: 3, placeholder: 'GM notes: secrets, traps, what happens here', onCommit: (v) => act({ t: 'map.zone.update', id: m.id, zoneId: z.id, notes: v }) }),
        z.links.length ? h('ul.pp-refs', z.links.map((l) => h('li.pp-ref', h('span.pp-kind', LINK_LABEL[l.kind]), h('b.pp-ref-name', linkName(l)),
          h('button.btn.btn-sm', { type: 'button', onclick: () => useLink(l) }, l.kind === 'monster' ? 'Add to fight' : l.kind === 'card' ? 'Fire' : 'Preview'),
          h('button.icon-btn', { type: 'button', title: 'Unlink', onclick: () => setLinks(z.links.filter((x) => x !== l)) }, icon('x', { size: 14 }))))) : null,
        linkOpts.length ? select([{ value: '', label: '+ Link who or what is here…' }, ...linkOpts], '', { cls: 'inp-sm', label: 'Link', onChange: (v) => { if (!v) return; const [kind, ...rest] = v.split(':'); setLinks([...z.links, { kind, id: rest.join(':') }]); } }) : null,
        h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: async () => { if (await ask(`Delete zone "${z.name}"?`, { ok: 'Delete', danger: true })) act({ t: 'map.zone.remove', id: m.id, zoneId: z.id }); } }, icon('trash', { size: 14 }), 'Delete zone'),
      ] : null);
  }

  function tokenPanel(m) {
    if (!m.tokensOn) return null;
    return h('section.panel.gmap-zones',
      h('h3', 'Tokens'),
      h('div.gmap-top',
        h('button.btn.btn-sm', { type: 'button', onclick: () => act({ t: 'map.token.party', id: m.id }, 'Party tokens added.') }, icon('users', { size: 14 }), 'Party'),
        h('button.btn.btn-sm', { type: 'button', onclick: async () => { const n = await promptName('Mob token', 'Goblin'); if (n) act({ t: 'map.token.add', id: m.id, kind: 'mob', label: n, x: 0.5, y: 0.5 }); } }, icon('skull', { size: 14 }), 'Mob'),
        h('button.btn.btn-sm', { type: 'button', onclick: async () => { const n = await promptName('Marker', 'Stairs'); if (n) act({ t: 'map.token.add', id: m.id, kind: 'mark', label: n, x: 0.5, y: 0.5 }); } }, icon('flag', { size: 14 }), 'Marker')),
      h('ul.pp-refs', m.tokens.map((t) => h('li.pp-ref', h('span.pp-kind', t.kind), h('b.pp-ref-name', t.label),
        t.kind !== 'pc' ? h('button.icon-btn', { type: 'button', title: t.hidden ? 'Hidden from the players: show' : 'Visible: hide', onclick: () => act({ t: 'map.token.update', id: m.id, tokenId: t.id, hidden: !t.hidden }) }, icon(t.hidden ? 'lock' : 'eye', { size: 14 })) : null,
        h('button.icon-btn', { type: 'button', title: 'Remove', onclick: () => act({ t: 'map.token.remove', id: m.id, tokenId: t.id }) }, icon('trash', { size: 14 }))))),
      h('p.dim.pp-hint', 'Pick the Tokens tool to drag them. Crawlers drag their own token on their phones.'));
  }

  function draw() {
    const active = document.activeElement;
    if (active && el.contains(active) && /^(INPUT|TEXTAREA)$/.test(active.tagName)) { pending = true; return; }
    const m = cur();
    if (!m) {
      mv.set(null);
      el.replaceChildren(h('section.panel.pp-empty',
        h('h3', 'Maps with fog of war'),
        h('p', 'Upload nothing, draw nothing complicated: pick a picture, drag rectangles over the rooms or streets, name them. At the table you reveal a zone with one tap and the TV uncovers it.'),
        h('button.btn.btn-primary', { type: 'button', onclick: newMap }, icon('plus', { size: 14 }), 'New map')));
      return;
    }
    if (st.sel !== m.id) { st.sel = m.id; store.set('sel', m.id); }
    const tools = [['zone', 'Draw zone'], ['reveal', 'Reveal'], ['cover', 'Cover'], ...(m.tokensOn ? [['tokens', 'Tokens']] : [])];
    if (!tools.some(([id]) => id === st.tool)) st.tool = 'zone';
    mv.set(m, { selected: st.zone, onZone: (z) => { st.zone = z.id; sig = ''; draw(); } });
    el.replaceChildren(
      h('div.gmap-top',
        select(maps().map((x) => ({ value: x.id, label: x.name })), m.id, { cls: 'inp-sm', label: 'Map', onChange: pick }),
        h('button.btn.btn-sm', { type: 'button', onclick: newMap }, icon('plus', { size: 14 }), 'New'),
        h('div.gmap-tools', { role: 'radiogroup', 'aria-label': 'Tool' }, tools.map(([id, label]) => h('button', { type: 'button', role: 'radio', 'aria-pressed': String(st.tool === id), onclick: () => { st.tool = id; sig = ''; draw(); } }, label))),
        h('span.grow'),
        h('label.chk', { title: 'Players see the revealed part on their phones' }, h('input', { type: 'checkbox', checked: m.phones, onchange: (e) => act({ t: 'map.update', id: m.id, phones: e.target.checked }) }), 'Phones'),
        h('label.chk', { title: 'Token layer for online play: crawlers drag their own token' }, h('input', { type: 'checkbox', checked: m.tokensOn, onchange: (e) => act({ t: 'map.update', id: m.id, tokensOn: e.target.checked }) }), 'Tokens'),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => act({ t: 'map.fog', id: m.id, all: true }, 'Everything revealed.') }, 'Reveal all'),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: async () => { if (await ask('Cover the whole map again (all zones hidden)?', { ok: 'Cover all' })) act({ t: 'map.fog', id: m.id, all: false }, 'Map covered.'); } }, 'Cover all'),
        h('button.icon-btn', { type: 'button', title: 'Rename', onclick: async () => { const n = await promptName('Rename map', m.name); if (n) act({ t: 'map.update', id: m.id, name: n }); } }, icon('edit', { size: 14 })),
        h('button.icon-btn', { type: 'button', title: 'Delete map', onclick: async () => { if (await ask(`Delete map "${m.name}"?`, { ok: 'Delete', danger: true })) { await act({ t: 'map.remove', id: m.id }, 'Map deleted.'); st.sel = null; sig = ''; draw(); } } }, icon('trash', { size: 14 }))),
      h('p.dim.pp-hint', st.tool === 'zone' ? 'Drag on the map to draw a zone. Click a zone to open it.' : st.tool === 'tokens' ? 'Drag tokens to move them.' : `Drag a rectangle to ${st.tool} that part.`),
      h('div.gmap-grid', mv.el,
        h('div.gmap-zones',
          h('section.panel.gmap-zones', h('h3', `Zones (${m.zones.filter((z) => z.revealed).length}/${m.zones.length} revealed)`),
            m.zones.length ? h('ul.pp-items', m.zones.map((z) => zoneCard(m, z))) : h('p.dim', 'No zones yet: drag on the map.')),
          tokenPanel(m))));
  }
  el.addEventListener('focusout', () => setTimeout(() => { if (pending && !el.contains(document.activeElement)) { pending = false; sig = ''; draw(); } }, 0));

  function update(v) {
    view = v;
    const s = JSON.stringify([v.maps, cards().length, Object.values(lib()).map((x) => x.length)]);
    if (s === sig) return;
    sig = s;
    draw();
  }
  return { el, update, newMap, select: pick };
}
