// Prep → an encounter (server/encounters.js). Built from the library in a few clicks, never touches the live
// fight: mobs with counts and "starts hidden", strength for the party, GM notes, and a battle map where the
// mobs and the crawlers' start are placed. At the table it waits in "Within reach" and runs with one tap.
//
// encounterEditor({ view, act, card, mapEd, onDone, inTonight, addToTonight }) → element
//   card        the prep card (kind 'encounter')
//   mapEd       the shared prep map editor (gm-maps.js, mode 'prep'): mounted under the encounter when it
//               has a map
import { h, toast, ask } from './client.js';
import { icon, field, select, stepper } from './ui.js';
import { libraryOf } from './rules.js';
import { entryArt } from './portrait.js';
import { benchmark } from './prep-bench.js';
import { pickFromLibrary } from './lib-picker.js';

export function mobsOf(view, payload) {
  const lib = libraryOf(view);
  return (payload?.mobs || []).map((m) => {
    const kind = m.kind || 'monster';
    const e = (lib[kind] || []).find((x) => x.id === m.sourceId) || null;
    return { ...m, kind, e };
  });
}

export function strengthBadge(view, payload) {
  const family = view?.pack?.ruleset?.system?.family || 'crawler';
  const party = (view?.players || []).map((p) => ({ level: p.level || 1 }));
  const mobs = mobsOf(view, payload).map(({ e, kind, count }) => ({ count: count || 1, level: e?.level, cr: e?.cr, role: kind === 'boss' ? 'boss' : (e?.role || 'standard') }));
  if (!mobs.length) return null;
  const b = benchmark(family, party, mobs);
  if (b.level < 0) return null;
  return h('span.pp-bench', { class: `pp-bench pp-b${b.level}`, title: `${b.detail}${party.length ? '' : ' (no characters yet: counted as one)'}` }, b.label);
}

/**
 * Crawler family: counts that bring the encounter to a strength for this party (the Starter Set's mobs-per-
 * crawler rule). Bosses / elites stay one each; standard mobs and minions scale. Returns new mobs or null.
 */
export function fitToParty(view, payload, ratio) {
  const size = Math.max(1, (view?.players || []).length);
  const list = mobsOf(view, payload);
  const role = (m) => (m.kind === 'boss' ? 'boss' : m.e?.role || 'standard');
  const fixed = list.filter((m) => ['boss', 'elite'].includes(role(m))).length * size;
  const scal = list.filter((m) => !['boss', 'elite'].includes(role(m)));
  if (!scal.length) return null;
  const per = (m) => (role(m) === 'minion' ? 0.5 : 1);
  const now = scal.reduce((a, m) => a + per(m) * (m.count || 1), 0);
  const want = Math.max(scal.reduce((a, m) => a + per(m), 0), size * ratio - fixed);
  const f = want / Math.max(0.5, now);
  // Floors first, then one more of whichever is furthest below its exact share, never above the target.
  const exact = scal.map((m) => (m.count || 1) * f);
  const cnt = exact.map((x) => Math.max(1, Math.min(20, Math.floor(x))));
  let units = scal.reduce((a, m, i) => a + per(m) * cnt[i], 0);
  for (;;) {
    let best = -1;
    for (let i = 0; i < scal.length; i++) if (cnt[i] < 20 && units + per(scal[i]) <= want + 1e-9 && (best < 0 || exact[i] - cnt[i] > exact[best] - cnt[best])) best = i;
    if (best < 0) break;
    cnt[best]++;
    units += per(scal[best]);
  }
  return list.map(({ e, ...m }) => {
    const i = scal.findIndex((x) => x.sourceId === m.sourceId && x.kind === m.kind);
    return i < 0 ? { ...m, count: 1 } : { ...m, count: cnt[i] };
  });
}

export function encounterEditor({ view, act, card, mapEd, onDone, inTonight, addToTonight }) {
  const p = card.payload || {};
  const mobs = mobsOf(view, p);
  const save = (patch, msg) => act({ t: 'enc.save', id: card.id, label: card.label, mobs: (p.mobs || []).map(({ kind, sourceId, count, hidden }) => ({ kind, sourceId, count, hidden })), ...(p.mapId ? { mapId: p.mapId } : {}), notes: p.notes || '', ...patch }, msg);
  const lib = libraryOf(view);
  const family = view?.pack?.ruleset?.system?.family || 'crawler';
  const items = (p.items || []).map((x) => ({ ...x, e: (lib.item || []).find((i) => i.id === x.id) || null }));
  const rawItems = () => (p.items || []).map(({ id, qty }) => ({ id, qty }));
  const playerName = (id) => (view?.players || []).find((x) => x.id === id)?.name || 'someone';
  const setMobs = (list, msg) => save({ mobs: list }, msg);
  const raw = () => (p.mobs || []).map((m) => ({ ...m }));
  const maps = view?.maps || [];
  const map = p.mapId ? maps.find((m) => m.id === p.mapId) : null;
  const placed = map ? map.tokens.filter((t) => t.enc === card.id).length : 0;
  const total = mobs.reduce((a, m) => a + (m.count || 1), 0);

  function fromLocation() {
    pickFromLibrary({
      view, kinds: ['location'], title: 'Mobs that live in a location',
      onPick: ([x]) => {
        const loc = (lib.location || []).find((l) => l.id === x.id);
        const add = [...(loc?.monsters || []).map((id) => ({ kind: 'monster', id })), ...(loc?.bosses || []).map((id) => ({ kind: 'boss', id }))];
        if (!add.length) { toast(`${loc?.name || 'That location'} lists no monsters. Add them in the Library, or pick them directly.`, { error: true }); return; }
        const next = raw();
        for (const a of add) if (!next.some((m) => (m.kind || 'monster') === a.kind && m.sourceId === a.id)) next.push({ kind: a.kind, sourceId: a.id, count: 1, hidden: true });
        setMobs(next.slice(0, 20), `${loc.name}: ${add.length} kind${add.length === 1 ? '' : 's'} of mobs added. Fit them to the party next.`);
      },
    });
  }
  function fit(ratio, label) {
    const next = fitToParty(view, p, ratio);
    if (!next) { toast('Only bosses / elites here: nothing to scale.'); return; }
    setMobs(next.map(({ kind, sourceId, count, hidden }) => ({ kind, sourceId, count, hidden })), `Fitted: ${label} for ${(view?.players || []).length || 1} crawler${(view?.players || []).length === 1 ? '' : 's'}.`);
  }
  function addItems() {
    pickFromLibrary({
      view, kinds: ['item'], title: `What ${card.label} drops`, multi: true, counts: true,
      onPick: (list) => {
        const next = rawItems();
        for (const x of list) { const had = next.find((i) => i.id === x.id); if (had) had.qty = Math.min(99, had.qty + x.count); else next.push({ id: x.id, qty: x.count }); }
        save({ items: next.slice(0, 12) }, 'Loot added.');
      },
    });
  }

  function addMobs() {
    pickFromLibrary({
      view, kinds: ['monster', 'boss'], title: `Mobs for ${card.label}`, multi: true, counts: true,
      onPick: (list) => {
        const next = raw();
        for (const x of list) {
          const had = next.find((m) => (m.kind || 'monster') === x.kind && m.sourceId === x.id);
          if (had) had.count = Math.min(20, (had.count || 1) + x.count);
          else next.push({ kind: x.kind, sourceId: x.id, count: x.count, hidden: true });
        }
        setMobs(next.slice(0, 20), 'Added.');
      },
    });
  }

  const mobRow = (m, i) => h('li.enc-mob', { class: m.e ? 'enc-mob' : 'enc-mob missing' },
    entryArt(m.e || { name: m.sourceId }, { cls: 'enc-art', lit: false }),
    h('div.enc-mob-t',
      h('b', m.e?.name || `${m.sourceId} (not in the library)`),
      h('span.dim', [m.kind === 'boss' ? 'Boss' : m.e?.role && m.e.role !== 'standard' ? m.e.role : null, m.e?.floor !== '' && m.e?.floor != null ? `F${m.e.floor}` : null, m.e?.hpSlots != null ? `${m.e.hpSlots} HP` : null, (m.e?.attacks || []).map((a) => a.name).slice(0, 2).join(', ') || null].filter(Boolean).join(' · '))),
    stepper(m.count || 1, { min: 1, max: 20, label: `How many ${m.e?.name || ''}`, onChange: (v) => { const next = raw(); next[i].count = v; setMobs(next); } }),
    h('button.btn.btn-sm.enc-hid', { type: 'button', 'aria-pressed': String(m.hidden !== false), title: m.hidden !== false ? 'Starts hidden: you reveal it during the fight. Click: starts visible.' : 'Starts visible on the TV. Click: starts hidden.', onclick: () => { const next = raw(); next[i].hidden = !(m.hidden !== false); setMobs(next); } }, icon(m.hidden !== false ? 'lock' : 'eye', { size: 14 }), m.hidden !== false ? 'Hidden' : 'Visible'),
    h('button.icon-btn', { type: 'button', title: 'Remove', onclick: () => { const next = raw(); next.splice(i, 1); setMobs(next); } }, icon('trash', { size: 14 })));

  const mapRow = h('div.enc-maprow',
    select([{ value: '', label: 'No battle map' }, ...maps.map((m) => ({ value: m.id, label: m.name }))], p.mapId || '', {
      cls: 'inp-sm', label: 'Battle map',
      onChange: async (v) => {
        if (!v && p.mapId && placed && !(await ask('Take the map off this encounter? Its mob tokens are removed from the map.', { ok: 'Remove', danger: true }))) { onDone(); return; }
        await save({ mapId: v || null });
        if (v) offerTokens(v);
      },
    }),
    h('button.btn.btn-sm', { type: 'button', onclick: () => mapEd.newMap(async (id) => { await save({ mapId: id }); offerTokens(id); }) }, icon('plus', { size: 14 }), 'New map'));

  async function offerTokens(mapId) {
    if (!total) return;
    const m = (view?.maps || []).find((x) => x.id === mapId);
    const hasParty = m?.tokens?.some((t) => t.kind === 'pc');
    if (await ask(`Put the ${total} mob${total === 1 ? '' : 's'} on the map${hasParty ? '' : ' and a token for every crawler'}? You drag them into place afterwards.`, { ok: 'Place them' })) {
      await act({ t: 'enc.tokens', id: card.id, party: !hasParty }, 'Placed: drag them where they start. Hidden mobs show dashed.');
    }
  }

  const tonight = inTonight(card.id);
  return h('div.enc',
    h('header.pp-head',
      h('div.pp-head-row',
        icon('swords', { size: 18 }),
        field(card.label, { cls: 'pp-title', attrs: { 'aria-label': 'Encounter name' }, onCommit: (v) => v.trim() && save({ label: v.trim() }) }),
        strengthBadge(view, p),
        card.used ? h('span.pill', { title: 'It ran already; it can run again.' }, 'Used') : null),
      h('div.pp-head-row',
        tonight ? h('span.pill.pill-on', icon('star', { size: 12 }), 'In tonight’s plan, within reach') : h('button.btn.btn-sm.btn-primary', { type: 'button', title: 'Link it in tonight’s session plan and pin it: it waits on the Show tab, one tap to run', onclick: () => addToTonight(card.id) }, icon('star', { size: 14 }), 'Within reach tonight'),
        h('span.grow'),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: async () => { const r = await act({ t: 'enc.save', label: `${card.label} (copy)`, mobs: raw(), notes: p.notes || '' }, 'Copied (without the map).'); if (r?.result?.id) onDone(r.result.id); } }, icon('copy', { size: 14 }), 'Copy'),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: async () => { if (await ask(`Delete the encounter "${card.label}"?`, { ok: 'Delete', danger: true })) { await act({ t: 'enc.remove', id: card.id }, 'Deleted.'); onDone(null); } } }, icon('trash', { size: 14 }), 'Delete'))),
    h('section.panel.pp-sec',
      h('header.pp-sec-head', h('h3', `Mobs (${total})`), h('span.grow'),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', title: 'Add the monsters a library location lists', onclick: fromLocation }, icon('map', { size: 14 }), 'From a location'),
        h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: addMobs }, icon('plus', { size: 14 }), 'Add from the library')),
      mobs.length ? h('ul.enc-mobs', mobs.map(mobRow)) : h('p.empty-s', 'No mobs yet. Add them from the library: filter by floor, tap, set how many.'),
      mobs.length && family === 'crawler' ? h('div.pp-head-row', h('span.dim', `Fit to ${(view?.players || []).length || 1} crawler${(view?.players || []).length === 1 ? '' : 's'}:`),
        [[0.5, 'Weak'], [1, 'Moderate'], [1.5, 'Strong'], [2, 'Overwhelming']].map(([r, l]) => h('button.btn.btn-sm.btn-quiet', { type: 'button', title: `Set the counts so the fight is ${l.toLowerCase()} (bosses and elites stay one each)`, onclick: () => fit(r, l) }, l))) : null,
      h('p.dim.pp-hint', 'Nothing here touches the live fight. At the table: Run (Show → Within reach, or the map’s Tokens tab) puts these into the fight; hidden ones stay hidden until you reveal them.')),
    h('section.panel.pp-sec',
      h('header.pp-sec-head', h('h3', `Loot (${items.length})`), h('span.grow'), h('button.btn.btn-sm', { type: 'button', onclick: addItems }, icon('gift', { size: 14 }), 'Add items')),
      items.length ? h('ul.enc-mobs', items.map((x, i) => h('li.enc-mob.enc-item', { class: x.e ? 'enc-mob enc-item' : 'enc-mob enc-item missing' },
        entryArt(x.e || { name: x.id }, { cls: 'enc-art', lit: false }),
        h('div.enc-mob-t', h('b', x.e?.name || `${x.id} (not in the library)`), h('span.dim', x.given ? `Given to ${playerName(x.given)}` : [x.e?.rarity, x.e?.slot].filter(Boolean).join(' · ') || 'Item')),
        stepper(x.qty || 1, { min: 1, max: 99, label: `How many ${x.e?.name || ''}`, onChange: (v) => { const next = rawItems(); next[i].qty = v; save({ items: next }); } }),
        h('button.icon-btn', { type: 'button', title: 'Remove', onclick: () => { const next = rawItems(); next.splice(i, 1); save({ items: next }); } }, icon('trash', { size: 14 }))))) : h('p.dim.pp-hint', 'What the mobs drop. After the fight it waits in the Fight tab: one tap gives it to a crawler.')),
    h('section.panel.pp-sec',
      h('header.pp-sec-head', h('h3', 'GM notes')),
      field(p.notes || '', { multiline: true, rows: 2, placeholder: 'Where they lurk, what they want, when they flee, what triggers the fight', onCommit: (v) => save({ notes: v }) })),
    h('section.panel.pp-sec',
      h('header.pp-sec-head', h('h3', 'Battle map'), h('span.grow'),
        map && total ? h('button.btn.btn-sm', { type: 'button', onclick: () => act({ t: 'enc.tokens', id: card.id }, placed ? 'Tokens synced.' : 'Mobs placed: drag them into place.') }, icon('skull', { size: 14 }), placed ? `Sync tokens (${placed}/${total})` : 'Put the mobs on the map') : null),
      mapRow,
      map ? null : h('p.dim.pp-hint', 'Optional. With a map you place the mobs and the crawlers’ start now; at the table you reveal the map and move the tokens, and they follow the fight (revealed, down).'),
      map ? mapEd.el : null));
}
