// GM map editor (server/maps.js). Two places use it:
//   mode 'prep'  Prep → Maps / an encounter's battle map: build it calmly, nothing reaches the TV
//   mode 'live'  Show → Map: the same editor at the table; picking a map loads it into the TV preview
//
// Tools (top bar): Move (drag tokens) · Zone (drag a rectangle) · Shape (click corners, click the first
// corner or double-click to close) · Pen (freehand lines; GM-only or for everyone) · Reveal / Cover (drag
// a rectangle of fog). Right panel: Tokens (crawler start, encounter mobs, monsters from the library,
// markers) and Zones (read-aloud, GM notes, links).
//
// createMaps({ act, getView, scenes, showView, mode, openInLibrary }) → { el, update(view), newMap, select(id) }
import { h, toast, ask, portraitSrc } from './client.js';
import { entryArt } from './portrait.js';
import { statBlock, hasStatBlock } from './statblock.js';
import { icon, field, select, openDrawer, closeDrawer } from './ui.js';
import { libraryOf } from './rules.js';
import { createMapView } from './map-view.js';
import { pickFromLibrary, entryName, KIND_LABEL } from './lib-picker.js';

const store = {
  get(k, d) { try { const v = localStorage.getItem(`system.maps.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`system.maps.${k}`, JSON.stringify(v)); } catch {} },
};
const TOOLS = [
  { id: 'move', label: 'Move', icon: 'target', hint: 'Drag tokens. Click a token to find it in the list.' },
  { id: 'zone', label: 'Zone', icon: 'map', hint: 'Drag a rectangle over a room or street to make a zone you can reveal with one tap.' },
  { id: 'poly', label: 'Shape', icon: 'edit', hint: 'Click the corners of an odd-shaped zone. Click the first corner again, double-click or press Enter to finish. Esc cancels.' },
  { id: 'freezone', label: 'Freehand zone', icon: 'edit', hint: 'Trace the boundary of a zone and release to close it.' },
  { id: 'pen', label: 'Pen', icon: 'edit', hint: 'Draw freehand: walls, arrows, a trap, a note. "GM only" lines never reach the TV.' },
  { id: 'reveal', label: 'Reveal', icon: 'eye', hint: 'Drag a rectangle to uncover that part of the fog.' },
  { id: 'cover', label: 'Cover', icon: 'lock', hint: 'Drag a rectangle to cover that part again.' },
];
const PEN_COLORS = ['#ffcc00', '#ff3355', '#2ef2ff', '#ffffff', '#3ddc5f'];

/** Loads an image to learn its aspect ratio (width / height). */
function measure(url) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im.naturalWidth && im.naturalHeight ? Math.max(0.2, Math.min(5, im.naturalWidth / im.naturalHeight)) : null);
    im.onerror = () => resolve(null);
    im.src = url;
  });
}

async function mapPng(file) {
  if (!file || file.size > 20 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('Choose a PNG, JPEG or WebP picture up to 20 MiB.');
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const { naturalWidth: width, naturalHeight: height } = image;
    if (!width || !height || width * height > 64_000_000 || width / height < 0.2 || width / height > 5) {
      throw new Error('Choose a picture with an aspect ratio between 1:5 and 5:1 and at most 64 megapixels.');
    }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    for (let size = 2048; size >= 320; size = Math.floor(size * 0.8)) {
      const scale = Math.min(1, size / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (blob && blob.size <= 1536 * 1024) return blob;
    }
    throw new Error('The picture is too large after resizing.');
  } finally { URL.revokeObjectURL(url); }
}

export function createMaps({ act, getView, scenes, showView, getCredential, mode = 'live', openInLibrary = null }) {
  const live = mode === 'live';
  let view = null;
  let sig = '';
  let pending = false;
  let awaitingMap = null;
  const st = { sel: store.get(`sel.${mode}`, null), tool: store.get('tool', 'move'), zone: null, token: null, side: store.get('side', 'tokens'), pen: store.get('pen', PEN_COLORS[0]), penGm: store.get('penGm', false) };
  const el = h('div.gmap', { class: `gmap gmap-${mode}` });
  const mv = createMapView({
    gm: true,
    fit: true,
    tool: () => st.tool,
    onDrag: (rect) => onDrag(rect),
    onPen: (pts) => cur() && act({ t: 'map.stroke.add', id: cur().id, pts, color: st.pen, gm: st.penGm }),
    onPoly: (points) => newZone({ points }),
    onTokenMove: (t, x, y) => cur() && act({ t: 'map.token.move', id: cur().id, tokenId: t.id, x, y }),
    canMoveToken: () => st.tool === 'move',
    onToken: (t) => { st.token = t.id; st.side = 'tokens'; sig = ''; draw(); },
  });

  const maps = () => view?.maps || [];
  const cur = () => maps().find((m) => m.id === st.sel) || null;
  const lib = () => libraryOf(view);
  const cards = () => view?.gm?.prepCards || [];
  const combatants = () => view?.combat?.combatants || [];
  function pick(id) {
    st.sel = id; st.zone = null; st.token = null; store.set(`sel.${mode}`, id);
    if (live && id) scenes?.loadDraft('map', { mapId: id });
    sig = ''; draw();
  }
  const setTool = (id) => { st.tool = id; store.set('tool', id); mv.cancelPoly(); sig = ''; draw(); };

  async function newZone(shape) {
    const m = cur();
    if (!m) return;
    const name = await promptName('New zone', `Zone ${m.zones.length + 1}`);
    if (!name) return;
    const r = await act({ t: 'map.zone.add', id: m.id, name, shape });
    if (r?.result?.zoneId) { st.zone = r.result.zoneId; st.side = 'zones'; sig = ''; draw(); }
  }
  function onDrag(rect) {
    const m = cur();
    if (!m) return;
    if (st.tool === 'reveal' || st.tool === 'cover') { act({ t: 'map.fog', id: m.id, rect, reveal: st.tool === 'reveal' }); return; }
    if (st.tool === 'zone') newZone(rect);
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

  /** New map; then(id) runs after it exists so a prep card can attach it. */
  function newMap(then = null, existing = null) {
    const locs = (lib().location || []).filter((l) => l.image);
    let dropped = null;
    const file = h('input.inp', { type: 'file', name: 'picture', accept: 'image/png,image/jpeg,image/webp' });
    const status = h('p.dim', { role: 'status' });
    file.addEventListener('change', () => { dropped = null; status.textContent = file.files[0]?.name || ''; });
    const submit = h('button.btn.btn-primary', { type: 'submit' }, existing ? 'Replace picture' : 'Create map');
    const form = h('form.gmap-new', {
      ondragover: (e) => e.preventDefault(),
      ondrop: (e) => {
        e.preventDefault();
        dropped = e.dataTransfer.files[0] ?? null;
        if (dropped) status.textContent = dropped.name;
      },
      onsubmit: async (e) => {
        e.preventDefault();
        if (submit.disabled) return;
        submit.disabled = true;
        try {
          const f = form.elements;
          const local = dropped || file.files[0];
          const locationName = f.loc?.value ? f.loc.selectedOptions[0]?.textContent : '';
          const name = existing?.name || f.n?.value.trim() || locationName || local?.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Map';
          let id;
          if (local) {
            const campaignId = getView()?.campaign?.id;
            const cred = getCredential?.();
            if (!campaignId || (!cred?.key && !cred?.token)) throw new Error('Sign in as GM before uploading a map.');
            status.textContent = 'Preparing picture…';
            const body = await mapPng(local);
            const query = new URLSearchParams(existing ? { mapId: existing.id } : { name });
            const res = await fetch(`/api/maps/image?${query}`, { method: 'POST', body, headers: {
              'Content-Type': 'image/png', 'X-System-Campaign-Id': campaignId,
              ...(cred.key ? { 'X-GM-Key': cred.key } : { 'X-GM-Token': cred.token }),
            } });
            const result = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(result.msg || `Upload failed (${res.status}).`);
            id = result.id;
          } else {
            const image = (f.url.value.trim() || f.loc?.value || '').trim();
            if (!image) throw new Error('Choose a file, library picture or image URL.');
            const aspect = await measure(image);
            if (!aspect) throw new Error('That image does not load. Check the URL.');
            const r = await act(existing ? { t: 'map.update', id: existing.id, image, aspect } : { t: 'map.add', name, image, aspect });
            id = existing ? r && existing.id : r?.result?.id;
          }
          if (id) {
            closeDrawer(true);
            if (maps().some((m) => m.id === id)) pick(id); else awaitingMap = id;
            then?.(id);
          }
        } catch (err) { status.textContent = err.message; }
        finally { submit.disabled = false; }
      },
    },
    existing ? null : h('label.lbl', h('span.lbl-t', 'Name'), h('input.inp', { name: 'n', maxlength: 80, placeholder: 'Map name' })),
    h('label.lbl.gmap-upload', h('span.lbl-t', 'Choose or drop a map picture'), file),
    locs.length ? h('label.lbl', h('span.lbl-t', 'Library location'), select([{ value: '', label: 'None' }, ...locs.map((l) => ({ value: l.image, label: l.name }))], '', { label: 'Location picture' })) : null,
    h('label.lbl', h('span.lbl-t', 'Image URL'), h('input.inp', { name: 'url', placeholder: 'https://…' })),
    status, submit);
    const sel = form.querySelector('select');
    if (sel) sel.name = 'loc';
    openDrawer({ title: existing ? 'Map picture' : 'New map', body: form });
  }

  /* ---------- zones ---------- */
  function useLink(l) {
    const name = entryName(view, l);
    if (!name) { toast('Not in the library any more.', { error: true }); return; }
    if (!live) { openInLibrary?.(l.kind, l.id); return; }
    if (l.kind === 'npc' || l.kind === 'boss' || l.kind === 'location') {
      scenes.loadDraft(l.kind === 'location' ? 'explore' : l.kind, l.kind === 'npc' ? { npcId: l.id } : l.kind === 'boss' ? { bossId: l.id } : { locationId: l.id });
      toast(`${name} is in the preview.`);
    } else if (l.kind === 'monster') act({ t: 'combat.addMob', kind: 'monster', sourceId: l.id, count: 1, hidden: true }, `${name} added to the fight (hidden).`);
    else if (l.kind === 'card') act({ t: 'prep.card.fire', id: l.id }, `${name} fired.`);
  }
  const linkVerb = (l) => (!live ? 'Open' : l.kind === 'monster' ? 'Add to fight' : l.kind === 'card' ? 'Fire' : l.kind === 'item' ? null : 'Preview');

  function zoneCard(m, z) {
    const open = st.zone === z.id;
    const setLinks = (links) => act({ t: 'map.zone.update', id: m.id, zoneId: z.id, links });
    return h('li.gmap-zone', { class: open ? 'gmap-zone sel' : 'gmap-zone' },
      h('div.gmap-zone-head',
        h('button.gmap-zone-n', { type: 'button', onclick: () => { st.zone = open ? null : z.id; sig = ''; draw(); }, title: 'Details' }, icon(open ? 'down' : 'chevron', { size: 12 }), z.name),
        h('button.btn.btn-sm', { type: 'button', class: z.revealed ? 'btn btn-sm' : 'btn btn-sm btn-primary', onclick: () => act({ t: 'map.zone.reveal', id: m.id, zoneId: z.id, on: !z.revealed }, z.revealed ? `${z.name} hidden again.` : `${z.name} revealed.`) }, z.revealed ? 'Hide' : 'Reveal')),
      open ? [
        field(z.name, { cls: 'inp-sm', onCommit: (v) => v.trim() && act({ t: 'map.zone.update', id: m.id, zoneId: z.id, name: v.trim() }) }),
        field(z.text, { multiline: true, rows: 3, placeholder: 'Read-aloud: what the crawlers see (phones show it once revealed)', onCommit: (v) => act({ t: 'map.zone.update', id: m.id, zoneId: z.id, text: v }) }),
        field(z.notes, { multiline: true, rows: 3, placeholder: 'GM notes: secrets, traps, what happens here', onCommit: (v) => act({ t: 'map.zone.update', id: m.id, zoneId: z.id, notes: v }) }),
        z.links.length ? h('ul.pp-refs', z.links.map((l) => h('li.pp-ref', h('span.pp-kind', KIND_LABEL[l.kind] || l.kind), h('b.pp-ref-name', entryName(view, l) || `${l.id} (missing)`),
          linkVerb(l) ? h('button.btn.btn-sm', { type: 'button', onclick: () => useLink(l) }, linkVerb(l)) : null,
          h('button.icon-btn', { type: 'button', title: 'Unlink', onclick: () => setLinks(z.links.filter((x) => x !== l)) }, icon('x', { size: 14 }))))) : null,
        h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => pickFromLibrary({ view, kinds: ['monster', 'boss', 'npc', 'location', 'item', 'card'], title: `Who or what is in ${z.name}`, multi: true, exclude: new Set(z.links.map((l) => `${l.kind}:${l.id}`)), onPick: (list) => setLinks([...z.links, ...list.map(({ kind, id }) => ({ kind, id }))]) }) }, icon('plus', { size: 14 }), 'Link who or what is here'),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: async () => { if (await ask(`Delete zone "${z.name}"?`, { ok: 'Delete', danger: true })) act({ t: 'map.zone.remove', id: m.id, zoneId: z.id }); } }, icon('trash', { size: 14 }), 'Delete zone'),
      ] : null);
  }
  function zonesPanel(m) {
    return [
      h('div.gmap-zone.gmap-zone-zero', h('b', 'Zone 0'), h('span.dim', 'Outside the drawn zones'),
        h('div.gmap-actions',
          h('button.btn.btn-sm', { type: 'button', 'aria-pressed': String(m.zoneZero === true), onclick: () => act({ t: 'map.zone.reveal', id: m.id, zoneId: '0', on: true }) }, 'Reveal Zone 0'),
          h('button.btn.btn-sm', { type: 'button', 'aria-pressed': String(m.zoneZero === false), onclick: () => act({ t: 'map.zone.reveal', id: m.id, zoneId: '0', on: false }) }, 'Cover Zone 0'))),
      m.zones.length ? h('ul.gmap-list', m.zones.map((z) => zoneCard(m, z))) : h('p.empty-s', 'No zones yet.'),
    ];
  }

  /* ---------- tokens ---------- */
  const combatantOf = (t) => (t.kind === 'mob' && t.ref ? combatants().find((c) => c.uid === t.ref) : null);
  function toggleToken(m, t) {
    const c = combatantOf(t);
    if (c) return act({ t: 'combat.reveal', uid: c.uid, on: !!c.hidden }, c.hidden ? `${c.name} revealed.` : `${c.name} hidden.`);
    return act({ t: 'map.token.update', id: m.id, tokenId: t.id, hidden: !t.hidden });
  }
  function addMobTokens(m) {
    pickFromLibrary({
      view, kinds: ['monster', 'boss'], title: 'Monster tokens', multi: true, counts: true,
      onPick: async (list) => {
        let i = 0;
        for (const p of list) {
          for (let k = 0; k < p.count; k++) {
            await act({ t: 'map.token.add', id: m.id, kind: 'mob', sourceKind: p.kind, sourceId: p.id, x: Math.min(0.95, 0.5 + (i % 5) * 0.05), y: Math.min(0.95, 0.5 + Math.floor(i / 5) * 0.07), hidden: true, ...(p.kind === 'boss' ? { color: '#ff9900' } : {}) });
            i++;
          }
        }
        toast(`${i} token${i === 1 ? '' : 's'} placed in the middle, hidden. Drag them where they lurk.`);
      },
    });
  }
  function tokenRow(m, t) {
    const c = combatantOf(t);
    const state = t.down ? 'down' : t.hidden ? 'hidden' : 'visible';
    return h('li.gmap-tok', { class: `gmap-tok${st.token === t.id ? ' sel' : ''}${t.down ? ' down' : ''}`, onclick: () => { st.token = st.token === t.id ? null : t.id; sig = ''; draw(); } },
      entryArt({ ...t, name: t.label, image: portraitSrc(t.image) }, { cls: 'gmap-tok-art' }),
      h('b', t.label),
      h('span.dim', t.kind === 'pc' ? 'crawler' : t.kind === 'mark' ? 'marker' : c ? `in the fight · ${state}` : t.ref ? 'left the fight' : state),
      h('span.grow'),
      t.kind !== 'pc' ? h('button.icon-btn', { type: 'button', title: t.hidden ? 'Hidden from the players: show' : 'Visible: hide', onclick: (e) => { e.stopPropagation(); toggleToken(m, t); } }, icon(t.hidden ? 'lock' : 'eye', { size: 14 })) : null,
      h('button.icon-btn', { type: 'button', title: 'Remove the token', onclick: (e) => { e.stopPropagation(); act({ t: 'map.token.remove', id: m.id, tokenId: t.id }); } }, icon('trash', { size: 14 })));
  }
  function tokensPanel(m) {
    const encs = cards().filter((c) => c.kind === 'encounter' && c.payload?.mapId === m.id);
    const groups = [
      ['Crawlers', m.tokens.filter((t) => t.kind === 'pc')],
      ...encs.map((e) => [e.label, m.tokens.filter((t) => t.enc === e.id)]),
      ['Other mobs', m.tokens.filter((t) => t.kind === 'mob' && !encs.some((e) => e.id === t.enc))],
      ['Markers', m.tokens.filter((t) => t.kind === 'mark')],
    ].filter(([, list]) => list.length);
    const players = view?.players || [];
    const missingPc = players.filter((p) => !m.tokens.some((t) => t.kind === 'pc' && t.ref === p.id)).length;
    const token = m.tokens.find((t) => t.id === st.token);
    const details = token && (() => {
      const src = (lib()[token.sourceKind] || []).find((e) => e.id === token.sourceId);
      const c = combatantOf(token);
      const def = c ? { ...src, ...c } : src;
      const health = c?.slotValue ? `${c.hp}/${c.hpMax} slots · ${c.slotValue} HP/slot` : `${c?.hp}/${c?.hpMax} HP`;
      return h('section.gmap-details',
        h('h4', token.label),
        def?.desc ? h('p', def.desc) : null,
        c && Number.isFinite(c.hp) && Number.isFinite(c.hpMax)
          ? h('p.dim', `${health} · ${c.hidden ? 'Hidden' : c.down ? 'Defeated' : 'In the fight'}`) : null,
        def && hasStatBlock(def) ? statBlock(def, view?.pack?.ruleset?.combat || {}) : null,
        def?.tactics ? h('p', def.tactics) : null,
        def?.notes ? h('p', def.notes) : null,
        field(token.label, { cls: 'inp-sm', attrs: { 'aria-label': 'Token label', maxlength: 40 }, onCommit: (label) => label.trim() && act({ t: 'map.token.update', id: m.id, tokenId: token.id, label }) }),
        field(token.notes || '', { multiline: true, rows: 3, placeholder: 'GM notes for this token', attrs: { 'aria-label': 'Token notes', maxlength: 2000 }, onCommit: (notes) => act({ t: 'map.token.update', id: m.id, tokenId: token.id, notes }) }));
    })();
    return [
      h('div.gmap-actions',
        players.length ? h('button.btn.btn-sm', { type: 'button', disabled: !missingPc, title: 'One token per crawler, top left: drag them where the party starts', onclick: () => act({ t: 'map.token.party', id: m.id }, 'Crawler tokens placed top left: drag them to the start.') }, icon('users', { size: 14 }), missingPc ? 'Crawlers’ start' : 'Crawlers placed') : null,
        h('button.btn.btn-sm', { type: 'button', onclick: () => addMobTokens(m) }, icon('skull', { size: 14 }), 'Monsters'),
        h('button.btn.btn-sm', { type: 'button', onclick: async () => { const n = await promptName('Marker', 'Stairs'); if (n) act({ t: 'map.token.add', id: m.id, kind: 'mark', label: n, x: 0.5, y: 0.5 }); } }, icon('flag', { size: 14 }), 'Marker')),
      details,
      encs.length ? h('ul.gmap-encs', encs.map((e) => {
        const n = (e.payload?.mobs || []).reduce((a, x) => a + (x.count || 1), 0);
        const placed = m.tokens.filter((t) => t.enc === e.id).length;
        return h('li.gmap-enc', icon('swords', { size: 14 }), h('b', e.label), h('span.dim', `${placed}/${n} on the map`),
          h('span.grow'),
          placed < n || !placed ? h('button.btn.btn-sm', { type: 'button', onclick: () => act({ t: 'enc.tokens', id: e.id }, 'Mobs placed (hidden): drag them where they lurk.') }, 'Place mobs') : null,
          live ? h('button.btn.btn-sm.btn-primary', { type: 'button', title: 'Add its mobs to the fight (hidden ones stay hidden); their tokens follow the fight', onclick: async () => { if (await act({ t: 'enc.run', id: e.id }, `${e.label}: mobs in the fight.`)) { showView('show'); scenes.pick('fight'); } } }, e.used ? 'Run again' : 'Run') : null);
      })) : null,
      groups.length ? groups.map(([label, list]) => h('div.gmap-tgroup', h('h4', label), h('ul.gmap-list', list.map((t) => tokenRow(m, t))))) : h('p.empty-s', 'No tokens yet.'),
      h('label.chk', { title: 'Online play: each crawler drags their own token on the phone' }, h('input', { type: 'checkbox', checked: m.tokensOn, onchange: (e) => act({ t: 'map.update', id: m.id, tokensOn: e.target.checked }) }), 'Players move their own token on the phone'),
    ];
  }

  /* ---------- draw ---------- */
  function toolbar(m) {
    const t = TOOLS.find((x) => x.id === st.tool) || TOOLS[0];
    const strokes = m.strokes || [];
    return [
      h('div.gmap-tools', { role: 'radiogroup', 'aria-label': 'Tool' }, TOOLS.map((x) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(st.tool === x.id), 'aria-pressed': String(st.tool === x.id), title: x.hint, onclick: () => setTool(x.id) }, icon(x.icon, { size: 14 }), x.label))),
      st.tool === 'pen' ? h('div.gmap-pen',
        PEN_COLORS.map((c) => h('button.gmap-swatch', { type: 'button', 'aria-label': `Colour ${c}`, 'aria-pressed': String(st.pen === c), style: { '--sw': c }, onclick: () => { st.pen = c; store.set('pen', c); mv.set(m, viewOpts()); sig = ''; draw(); } })),
        h('label.chk', h('input', { type: 'checkbox', checked: st.penGm, onchange: (e) => { st.penGm = e.target.checked; store.set('penGm', st.penGm); } }), 'GM only'),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', disabled: !strokes.length, onclick: () => act({ t: 'map.stroke.remove', id: m.id, strokeId: strokes[strokes.length - 1].id }) }, icon('undo', { size: 14 }), 'Undo line'),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', disabled: !strokes.length, onclick: async () => { if (await ask('Erase every drawing on this map?', { ok: 'Erase', danger: true })) act({ t: 'map.stroke.remove', id: m.id, all: true }); } }, 'Erase all')) : null,
      st.tool === 'reveal' || st.tool === 'cover' ? h('div.gmap-pen',
        h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => act({ t: 'map.fog', id: m.id, all: true }, 'Everything revealed.') }, 'Reveal all'),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: async () => { if (await ask('Cover the whole map again (all zones hidden)?', { ok: 'Cover all' })) act({ t: 'map.fog', id: m.id, all: false }, 'Map covered.'); } }, 'Cover all')) : null,
      h('p.dim.gmap-hint', t.hint),
    ];
  }
  const viewOpts = () => ({ selected: st.zone, selectedToken: st.token, penColor: st.pen, onZone: (z) => { if (st.tool === 'move' || st.tool === 'zone') { st.zone = z.id; st.side = 'zones'; sig = ''; draw(); } } });

  function draw() {
    const active = document.activeElement;
    if (active && el.contains(active) && /^(INPUT|TEXTAREA)$/.test(active.tagName) && active.type !== 'checkbox') { pending = true; return; }
    if (!cur() && maps().length && st.sel !== null) st.sel = maps()[0].id;
    const m = cur() || (maps().length ? maps()[0] : null);
    if (!m) {
      mv.set(null);
      el.replaceChildren(h('section.panel.pp-empty',
        h('h3', 'Maps with fog of war'),
        h('p', 'Pick a picture (a battle map, a location picture, anything), drag rectangles over the rooms or streets, put the monsters and the crawlers’ start on it. At the table you reveal a zone with one tap, the TV uncovers it, and you move the tokens.'),
        h('button.btn.btn-primary', { type: 'button', onclick: () => newMap() }, icon('plus', { size: 14 }), 'New map')));
      return;
    }
    if (st.sel !== m.id) { st.sel = m.id; store.set(`sel.${mode}`, m.id); }
    mv.set(m, viewOpts());
    const tabs = [['tokens', `Tokens (${m.tokens.length})`], ['zones', `Zones (${m.zones.filter((z) => z.revealed).length}/${m.zones.length})`]];
    el.replaceChildren(
      h('div.gmap-top',
        h('span.gmap-pick', select(maps().map((x) => ({ value: x.id, label: x.name })), m.id, { cls: 'inp-sm', label: 'Map', onChange: pick }),
          h('button.btn.btn-sm', { type: 'button', onclick: () => newMap() }, icon('plus', { size: 14 }), 'New map')),
        h('button.btn.btn-sm', { type: 'button', onclick: () => newMap(null, m) }, 'Change picture'),
        live ? h('button.btn.btn-sm', { type: 'button', 'aria-pressed': String(view?.combat?.mapId === m.id),
          onclick: () => act({ t: 'map.bindCombat', id: view?.combat?.mapId === m.id ? null : m.id }) }, view?.combat?.mapId === m.id ? 'Linked to fight' : 'Link to fight') : null,
        h('button.icon-btn', { type: 'button', title: 'Rename', onclick: async () => { const n = await promptName('Rename map', m.name); if (n) act({ t: 'map.update', id: m.id, name: n }); } }, icon('edit', { size: 14 })),
        h('button.icon-btn', { type: 'button', title: 'Delete map', onclick: async () => { if (await ask(`Delete map "${m.name}"?`, { ok: 'Delete', danger: true })) { await act({ t: 'map.remove', id: m.id }, 'Map deleted.'); st.sel = null; sig = ''; draw(); } } }, icon('trash', { size: 14 })),
        h('span.grow'),
        h('label.chk', { title: 'The revealed part is also on the players’ phones' }, h('input', { type: 'checkbox', checked: m.phones, onchange: (e) => act({ t: 'map.update', id: m.id, phones: e.target.checked }) }), 'On the phones too'),
        !live ? h('span.pill', { title: 'Nothing here reaches the TV. Show it from Show → Map, or run its encounter.' }, icon('lock', { size: 12 }), 'Prep: not on the TV') : null),
      h('div.gmap-bar', toolbar(m)),
      h('div.gmap-grid', mv.el,
        h('aside.gmap-side',
          h('div.gmap-tabs', { role: 'tablist' }, tabs.map(([id, label]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(st.side === id), onclick: () => { st.side = id; store.set('side', id); sig = ''; draw(); } }, label))),
          h('div.gmap-side-body', st.side === 'zones' ? zonesPanel(m) : tokensPanel(m)))));
  }
  el.addEventListener('focusout', () => setTimeout(() => { if (pending && !el.contains(document.activeElement)) { pending = false; sig = ''; draw(); } }, 0));

  function update(v) {
    view = v;
    if (awaitingMap && maps().some((m) => m.id === awaitingMap)) {
      const id = awaitingMap;
      awaitingMap = null;
      pick(id);
    }
    const s = JSON.stringify([v.maps, cards().filter((c) => c.kind === 'encounter').map((c) => [c.id, c.label, c.used, c.payload]), Object.values(lib()).map((x) => x.length), (v.players || []).length, combatants().map((c) => [c.uid, c.hidden, c.hp]), v.combat?.mapId]);
    if (s === sig) return;
    sig = s;
    draw();
  }
  /** Inside an encounter: the encounter picks the map, so the editor's own map picker hides. */
  const embed = (on) => el.classList.toggle('embedded', !!on);
  return { el, update, newMap, select: pick, embed, current: () => cur()?.id ?? null };
}
