// GM desk → Prep (Příprava): adventures and session plans built from templates (server/prep.js).
//
// Left: adventures (a neighbourhood, a quest, a dungeon) and session plans; one session is "tonight".
// Right: the selected doc, one panel per template section:
//   text   free text (commits on blur)
//   list   tick list: secrets & clues, hooks, achievements to read out (unticked ones carry over)
//   parts  titled chunks: quarters, quest stages, scenes (tick when played)
//   refs   links to the library (monsters, bosses, NPCs, locations, items) and prepared cards
// Every item can be pinned: pinned items of tonight's session and its adventure show up in the
// "Within reach" strip on the Show tab, one tap away (load into the preview, never live).
//
// Left also lists Encounters (gm-encounter.js: mobs from the library, strength, a battle map with tokens)
// and Maps (gm-maps.js in prep mode). Nothing in Prep touches the TV or the live fight: library entries open
// in the Library, encounters and maps open here; running things happens on the Show tab ("Within reach").
// A scene (part) lists what it needs at the table (its encounter, map, NPCs, location): pin the scene and
// all of it waits within reach.
//
// createPrep({ act, getView, scenes, showView, openInLibrary, getCredential }) → { el, reach, update(view) }
import { h, toast, ask } from './client.js';
import { icon, field, select, openDrawer, closeDrawer } from './ui.js';
import { libraryOf } from './rules.js';
import { pickFromLibrary, KIND_LABEL } from './lib-picker.js';
import { encounterEditor, ratingBadge, strengthBadge } from './gm-encounter.js';
import { createMaps } from './gm-maps.js';

const REF_LABEL = { ...KIND_LABEL, loot: 'Loot box' };
const LIB_REF = ['monster', 'boss', 'npc', 'location', 'item', 'spell', 'buff'];
const SCENE_LINKS = ['encounter', 'map', 'npc', 'location', 'boss', 'monster', 'item', 'card'];
const store = {
  get(k, d) { try { const v = localStorage.getItem(`system.prep.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`system.prep.${k}`, JSON.stringify(v)); } catch {} },
};

export function createPrep({ act, getView, scenes, showView, openInLibrary, getCredential }) {
  let view = null;
  let sig = '';
  let reachSig = '';
  let pending = false;
  const st = { sel: store.get('sel', null), closed: new Set(store.get('closed', [])), q: '' };
  const el = h('div.prep2');
  const reach = h('div.sh-reach', { hidden: true });
  // One map editor for Prep (Maps + an encounter's battle map); never touches the TV.
  const mapEd = createMaps({ act, getView, scenes, showView, getCredential, mode: 'prep', openInLibrary });
  const selKind = () => (typeof st.sel === 'string' && /^(enc|map):/.test(st.sel) ? st.sel.split(':')[0] : 'doc');
  const selId = () => (selKind() === 'doc' ? st.sel : st.sel.slice(4));

  const P = () => view?.gm?.prep || { docs: [], current: null, templates: [], defaults: {} };
  const docs = () => P().docs || [];
  const docById = (id) => docs().find((d) => d.id === id) || null;
  const lib = () => libraryOf(view);
  const cards = () => view?.gm?.prepCards || [];
  const family = () => view?.pack?.ruleset?.system?.family || 'crawler';
  const party = () => (view?.players || []).map((p) => ({ level: p.level || 1 }));
  const tplLabel = (id) => (P().templates || []).find((t) => t.id === id)?.label || P().adventures?.find((a) => a.id === id)?.title || id;

  function entryOf(ref) {
    if (!ref) return null;
    if (ref.kind === 'card' || ref.kind === 'encounter') return cards().find((c) => c.id === ref.id) || null;
    if (ref.kind === 'map') return (view?.maps || []).find((m) => m.id === ref.id) || null;
    if (ref.kind === 'loot') return (view?.pack?.lootTiers || []).find((t) => t.id === ref.id) || null;
    return (lib()[ref.kind] || []).find((e) => e.id === ref.id) || null;
  }
  function refName(ref) {
    const e = entryOf(ref);
    if (!e) return `${ref.id} (missing)`;
    return ref.kind === 'card' || ref.kind === 'encounter' ? (e.label || e.kind) : e.name;
  }
  /** Readiness: red = missing from the library, amber = no art, green = has art. */
  function ready(ref) {
    const e = entryOf(ref);
    if (!e) return { cls: 'rd-red', why: 'Not in the library any more.' };
    if (ref.kind === 'encounter') {
      const n = (e.payload?.mobs || []).length;
      return n ? { cls: e.used ? 'rd-amber' : 'rd-green', why: e.used ? 'Ran already (can run again).' : 'Ready.' } : { cls: 'rd-red', why: 'No mobs yet.' };
    }
    if (ref.kind === 'card') return { cls: e.used ? 'rd-amber' : 'rd-green', why: e.used ? 'Already used tonight.' : 'Ready.' };
    if (['monster', 'boss', 'npc', 'location'].includes(ref.kind) && !(e.image || e.imageSquare || e.portrait)) return { cls: 'rd-amber', why: 'No picture yet: the TV shows a generated placeholder.' };
    return { cls: 'rd-green', why: 'Has a picture.' };
  }
  /* ---------- actions ---------- */
  const select_ = (id) => { st.sel = id; store.set('sel', id); sig = ''; draw(); };
  async function newAdventure(template) {
    const r = await act({ t: 'prep.adventure.add', title: 'New adventure', ...(template ? { template } : {}) }, 'Adventure created.');
    if (r?.result?.id) select_(r.result.id);
  }
  async function loadAdventure(seed) {
    const r = await act({ t: 'prep.adventure.load', id: seed.id });
    if (r?.result?.id) select_(r.result.id);
  }
  async function newSession(fromAdventure) {
    const r = await act({ t: 'prep.session.add', ...(fromAdventure ? { adventureId: fromAdventure } : {}) });
    if (r?.result?.id) {
      toast(r.result.carried ? `Session created. ${r.result.carried} unfinished item${r.result.carried === 1 ? '' : 's'} carried over.` : 'Session created.');
      select_(r.result.id);
    }
  }
  /** At the table (Within reach on the Show tab): runs / previews / fires. */
  async function useRef(ref) {
    const e = entryOf(ref);
    if (!e) { toast('Not in the library any more.', { error: true }); return; }
    if (ref.kind === 'encounter') {
      if (e.used && !(await ask(`"${e.label}" ran already. Run it again (new mobs)?`, { ok: 'Run again' }))) return;
      const r = await act({ t: 'enc.run', id: e.id }, `${e.label}: mobs in the fight${(e.payload?.mobs || []).some((m) => m.hidden !== false) ? ' (hidden ones wait for you)' : ''}.`);
      if (r) { showView('show'); scenes.pick('fight'); }
      return;
    }
    if (ref.kind === 'map') {
      showView('show');
      if (scenes.loadDraft('map', { mapId: ref.id })) toast(`${e.name} is in the preview. Go live when ready.`);
      return;
    }
    if (ref.kind === 'location' || ref.kind === 'npc' || ref.kind === 'boss') {
      showView('show');
      const ok = scenes.loadDraft(ref.kind === 'location' ? 'explore' : ref.kind, ref.kind === 'location' ? { locationId: ref.id } : ref.kind === 'npc' ? { npcId: ref.id } : { bossId: ref.id });
      if (ok) toast(`${e.name} is in the preview. Go live when ready.`);
      return;
    }
    if (ref.kind === 'monster') {
      if (await act({ t: 'combat.addMob', kind: 'monster', sourceId: ref.id, count: 1, hidden: true }, `${e.name} added to the fight (hidden).`)) { showView('show'); scenes.pick('fight'); }
      return;
    }
    if (ref.kind === 'card') {
      if (await act({ t: 'prep.card.fire', id: ref.id }, `${e.label || 'Card'} fired.`) && e.kind === 'encounter') { showView('show'); scenes.pick('fight'); }
      return;
    }
    if (ref.kind === 'loot') {
      showView('show');
      scenes.loadDraft('loot', { tier: ref.id });
      return;
    }
    if (ref.kind === 'item' && view.players?.length) {
      openDrawer({ title: `Give ${e.name}`, body: h('div.pp-head-row', view.players.map((p) => h('button.btn.btn-sm', { type: 'button', onclick: async () => {
        if (await act({ t: 'item.give', playerId: p.id, itemId: e.id }, `Gave ${e.name} to ${p.name}.`)) closeDrawer();
      } }, p.name))) });
      return;
    }
    openInLibrary(ref.kind, ref.id);
  }
  const useLabel = (ref) => ({ encounter: 'Run', map: 'Preview', location: 'Preview', npc: 'Preview', boss: 'Preview', monster: 'Add to fight', card: 'Fire', loot: 'Preview', item: view.players?.length ? 'Give' : 'Open' }[ref.kind] || 'Open');
  /** In Prep: open it for editing (encounters and maps here, the rest in the Library). Never live. */
  function openRef(ref) {
    if (ref.kind === 'encounter') { select_(`enc:${ref.id}`); return; }
    if (ref.kind === 'map') { select_(`map:${ref.id}`); return; }
    if (ref.kind === 'card') { showView('show'); scenes.pick('desk'); return; }
    openInLibrary(ref.kind, ref.id);
  }
  const openLabel = (ref) => (ref.kind === 'encounter' || ref.kind === 'map' ? 'Edit' : 'Open');
  async function newEncounter(then) {
    const r = await act({ t: 'enc.save', label: 'New encounter', mobs: [] });
    if (r?.result?.id) { then?.(r.result.id); select_(`enc:${r.result.id}`); }
    return r?.result?.id;
  }
  /** Tonight's plan (or a new one) gets the encounter linked and pinned. */
  const monsterSection = (d) => d?.sections.find((s) => s.kind === 'refs' && !s.hidden && s.refKinds.includes('encounter'));
  function inTonight(encId) {
    const d = docById(P().current);
    return !!d?.sections.some((s) => s.items.some((it) => it.pin && ((it.ref?.kind === 'encounter' && it.ref.id === encId) || it.links?.some((l) => l.kind === 'encounter' && l.id === encId))));
  }
  /** The view arrives a moment after the action's answer: wait for it (max ~2 s). */
  async function waitView(fn) {
    for (let i = 0; i < 25; i++) {
      const v = getView();
      const r = v && fn(v);
      if (r) { view = v; return r; }
      await new Promise((res) => setTimeout(res, 80));
    }
    return null;
  }
  async function addToTonight(encId) {
    let d = docById(P().current);
    if (!d) {
      const r = await act({ t: 'prep.session.add' });
      if (!r?.result?.id) return;
      await act({ t: 'prep.session.current', id: r.result.id });
      d = await waitView((v) => (v.gm?.prep?.docs || []).find((x) => x.id === r.result.id));
      if (!d) return;
    }
    const sec = monsterSection(d);
    if (!sec) { toast('Tonight’s plan has no section for encounters: add one in the plan.', { error: true }); return; }
    const had = sec.items.find((it) => it.ref?.kind === 'encounter' && it.ref.id === encId);
    if (had) await act({ t: 'prep.item.update', id: d.id, key: sec.key, itemId: had.id, pin: true }, 'Pinned: within reach on the Show tab.');
    else await act({ t: 'prep.item.add', id: d.id, key: sec.key, ref: { kind: 'encounter', id: encId }, pin: true }, 'In tonight’s plan and within reach on the Show tab.');
  }

  /* ---------- left: doc list ---------- */
  function docRow(d) {
    const cur = P().current === d.id;
    const adv = d.adventureId ? docById(d.adventureId) : null;
    return h('li', h('button.pp-doc', { type: 'button', 'aria-current': st.sel === d.id ? 'true' : null, onclick: () => select_(d.id) },
      h('span.pp-doc-t', d.title),
      h('span.dim', d.type === 'session' ? (adv ? adv.title : 'No adventure') : tplLabel(d.template)),
      cur ? h('span.pill.pill-on', 'Tonight') : null));
  }
  function encRow(c) {
    const n = (c.payload?.mobs || []).reduce((a, m) => a + (m.count || 1), 0);
    const map = c.payload?.mapId ? (view?.maps || []).find((m) => m.id === c.payload.mapId) : null;
    return h('li', h('button.pp-doc', { type: 'button', 'aria-current': st.sel === `enc:${c.id}` ? 'true' : null, onclick: () => select_(`enc:${c.id}`) },
      h('span.pp-doc-t', c.label),
      h('span.dim', `${n} mob${n === 1 ? '' : 's'}${map ? ` · ${map.name}` : ''}`),
      inTonight(c.id) ? h('span.pill.pill-on', 'Tonight') : c.used ? h('span.pill', 'Used') : null));
  }
  function mapRow(m) {
    return h('li', h('button.pp-doc', { type: 'button', 'aria-current': st.sel === `map:${m.id}` ? 'true' : null, onclick: () => select_(`map:${m.id}`) },
      h('span.pp-doc-t', m.name),
      h('span.dim', `${m.zones.length} zone${m.zones.length === 1 ? '' : 's'} · ${m.tokens.length} token${m.tokens.length === 1 ? '' : 's'}`)));
  }
  function side() {
    const adv = docs().filter((d) => d.type === 'adventure');
    const ses = docs().filter((d) => d.type === 'session').slice().reverse();
    const advTpls = (P().templates || []).filter((t) => t.scope === 'adventure');
    const encs = cards().filter((c) => c.kind === 'encounter').slice().reverse();
    const maps = (view?.maps || []).slice().reverse();
    return h('aside.pp-side',
      h('div.pp-side-head', h('h2', 'Sessions'),
        h('button.btn.btn-sm', { type: 'button', onclick: () => newSession(null), title: 'New session plan: unfinished secrets and scenes from tonight carry over' }, icon('plus', { size: 14 }), 'New')),
      ses.length ? h('ul.pp-docs', ses.map(docRow)) : h('p.empty-s', 'No session plan yet.'),
      h('div.pp-side-head', h('h2', 'Encounters'),
        h('button.btn.btn-sm', { type: 'button', onclick: () => newEncounter(), title: 'Mobs from the library, strength for your party, a battle map' }, icon('plus', { size: 14 }), 'New')),
      encs.length ? h('ul.pp-docs', encs.map(encRow)) : h('p.empty-s', 'Fights you prepare: mobs from the library, a map, one tap to run.'),
      h('div.pp-side-head', h('h2', 'Maps'),
        h('button.btn.btn-sm', { type: 'button', onclick: () => { mapEd.newMap((id) => select_(`map:${id}`)); } }, icon('plus', { size: 14 }), 'New')),
      maps.length ? h('ul.pp-docs', maps.map(mapRow)) : h('p.empty-s', 'Maps with fog, zones and tokens.'),
      h('div.pp-side-head', h('h2', 'Adventures'),
        advTpls.length > 1
          ? select([{ value: '', label: '+ New…' }, ...advTpls.map((t) => ({ value: t.id, label: t.label }))], '', { cls: 'inp-sm', label: 'New adventure from template', onChange: (v) => v && newAdventure(v) })
          : h('button.btn.btn-sm', { type: 'button', onclick: () => newAdventure(null) }, icon('plus', { size: 14 }), 'New')),
      P().adventures?.length ? h('ul.pp-docs', P().adventures.map((a) => h('li', h('button.pp-doc', { type: 'button', onclick: () => loadAdventure(a) }, h('span.pp-doc-t', a.title), h('span.dim', 'Load prepared adventure'))))) : null,
      adv.length ? h('ul.pp-docs', adv.map(docRow)) : P().adventures?.length ? null : h('p.empty-s', 'An adventure holds what lasts several evenings: a neighbourhood, a quest, a dungeon.'),
      (view?.pack?.cheats || []).length ? [h('div.pp-side-head', h('h2', 'Cheat sheets')),
        h('ul.pp-docs', view.pack.cheats.map((c) => h('li', h('a.pp-doc', { href: c.url, target: '_blank', rel: 'noopener' }, h('span.pp-doc-t', c.label), h('span.dim', c.audience === 'gm' ? 'GM · print A4' : 'Players · on their phones too')))))] : null);
  }

  /* ---------- right: one doc ---------- */
  function itemTools(d, s, it, i) {
    return h('span.pp-tools',
      h('button.icon-btn', { type: 'button', 'aria-pressed': String(!!it.pin), class: it.pin ? 'icon-btn pp-pin on' : 'icon-btn pp-pin', title: it.pin ? 'Pinned: within reach on the Show tab' : 'Pin: put it within reach on the Show tab', onclick: () => act({ t: 'prep.item.update', id: d.id, key: s.key, itemId: it.id, pin: !it.pin }) }, icon('star', { size: 14 })),
      i > 0 ? h('button.icon-btn', { type: 'button', title: 'Move up', onclick: () => act({ t: 'prep.item.move', id: d.id, key: s.key, itemId: it.id, to: i - 1 }) }, icon('up', { size: 14 })) : null,
      h('button.icon-btn', { type: 'button', title: 'Remove', onclick: () => act({ t: 'prep.item.remove', id: d.id, key: s.key, itemId: it.id }) }, icon('trash', { size: 14 })));
  }
  function doneBox(d, s, it, label) {
    return h('input', { type: 'checkbox', checked: !!it.done, 'aria-label': label, onchange: (e) => act({ t: 'prep.item.update', id: d.id, key: s.key, itemId: it.id, done: e.target.checked }) });
  }
  function listBody(d, s) {
    const add = field('', { placeholder: s.key === 'secrets' ? 'A secret or clue in one line, Enter adds it' : 'Add a line, Enter adds it', onCommit: async (v) => { if (v.trim() && await act({ t: 'prep.item.add', id: d.id, key: s.key, text: v.trim() })) { pendingFocus = `${d.id}:${s.key}`; } } });
    add.dataset.addFor = `${d.id}:${s.key}`;
    return [
      h('ul.pp-items', s.items.map((it, i) => h('li.pp-item', { class: it.done ? 'pp-item done' : 'pp-item' },
        doneBox(d, s, it, s.carry ? 'Revealed / done' : 'Done'),
        field(it.text, { cls: 'inp-sm', onCommit: (v) => act({ t: 'prep.item.update', id: d.id, key: s.key, itemId: it.id, text: v }) }),
        itemTools(d, s, it, i)))),
      add,
    ];
  }
  function partsBody(d, s) {
    return [
      h('ol.pp-parts', s.items.map((it, i) => h('li.pp-part', { class: it.done ? 'pp-part done' : 'pp-part' },
        h('div.pp-part-head', doneBox(d, s, it, 'Played'),
          field(it.title, { cls: 'inp-sm pp-part-title', placeholder: 'Title', onCommit: (v) => act({ t: 'prep.item.update', id: d.id, key: s.key, itemId: it.id, title: v }) }),
          itemTools(d, s, it, i)),
        field(it.text, { multiline: true, rows: 3, placeholder: 'What is here, what happens, what the players can find', onCommit: (v) => act({ t: 'prep.item.update', id: d.id, key: s.key, itemId: it.id, text: v }) }),
        linksRow(d, s, it)))),
      h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => act({ t: 'prep.item.add', id: d.id, key: s.key, title: `${s.label.replace(/s$/, '')} ${s.items.length + 1}` }) }, icon('plus', { size: 14 }), 'Add'),
    ];
  }
  /** What a scene needs at the table: its encounter, map, NPCs, location… (pin the scene: all within reach). */
  function linksRow(d, s, it) {
    const links = it.links || [];
    const setLinks = (next) => act({ t: 'prep.item.update', id: d.id, key: s.key, itemId: it.id, links: next });
    return h('div.pp-links',
      h('span.dim', 'Needs:'),
      links.map((l) => h('span.pp-link', { class: entryOf(l) ? 'pp-link' : 'pp-link missing' },
        h('button', { type: 'button', disabled: !entryOf(l), title: `${useLabel(l)}: ${refName(l)}`, onclick: () => useRef(l) }, h('span.pp-kind', useLabel(l), ' · '), refName(l)),
        l.kind !== 'loot' ? h('button.icon-btn.xs', { type: 'button', title: `${openLabel(l)} ${refName(l)}`, 'aria-label': `${openLabel(l)} ${refName(l)}`, onclick: () => openRef(l) }, icon('edit', { size: 12 })) : null,
        h('button.icon-btn.xs', { type: 'button', 'aria-label': 'Unlink', onclick: () => setLinks(links.filter((x) => x !== l)) }, icon('x', { size: 12 })))),
      h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => pickFromLibrary({ view, kinds: SCENE_LINKS, title: `What ${it.title || 'this scene'} needs`, multi: true, exclude: new Set(links.map((l) => `${l.kind}:${l.id}`)), onPick: (list) => setLinks([...links, ...list.map(({ kind, id }) => ({ kind, id }))].slice(0, 12)) }) }, icon('plus', { size: 12 }), links.length ? 'Add' : 'Encounter, map, NPC…'),
      !links.some((l) => l.kind === 'encounter') ? h('button.btn.btn-sm.btn-quiet', { type: 'button', title: 'A new encounter for this scene, linked here', onclick: () => newEncounter((id) => setLinks([...links, { kind: 'encounter', id }])) }, icon('swords', { size: 12 }), 'New encounter') : null);
  }
  function refPicker(d, s) {
    const kinds = s.refKinds?.length ? s.refKinds : [...LIB_REF, 'encounter', 'card', 'map'];
    const have = new Set(s.items.map((it) => `${it.ref?.kind}:${it.ref?.id}`));
    return h('div.pp-head-row',
      h('button.btn.btn-sm', { type: 'button', onclick: () => pickFromLibrary({ view, kinds, title: `${s.label}: add`, multi: true, exclude: have, onPick: async (list) => { for (const x of list) await act({ t: 'prep.item.add', id: d.id, key: s.key, ref: { kind: x.kind, id: x.id } }); } }) }, icon('plus', { size: 14 }), `Add ${kinds.filter((k) => k !== 'card').map((k) => (REF_LABEL[k] || k).toLowerCase()).slice(0, 3).join(' / ')}…`),
      kinds.includes('encounter') ? h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => newEncounter((id) => act({ t: 'prep.item.add', id: d.id, key: s.key, ref: { kind: 'encounter', id } })) }, icon('swords', { size: 14 }), 'New encounter') : null,
      kinds.includes('map') ? h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => mapEd.newMap((id) => act({ t: 'prep.item.add', id: d.id, key: s.key, ref: { kind: 'map', id } })) }, icon('map', { size: 14 }), 'New map') : null);
  }
  function refsBody(d, s) {
    const mobs = [];
    for (const it of s.items) {
      if (it.ref?.kind === 'monster') mobs.push({ count: 1, level: entryOf(it.ref)?.level, cr: entryOf(it.ref)?.cr, role: entryOf(it.ref)?.role || 'standard' });
      if (it.ref?.kind === 'boss') mobs.push({ role: 'boss', level: entryOf(it.ref)?.level });
    }
    if (s.items.some((it) => it.ref?.kind === 'encounter')) mobs.length = 0; // encounters carry their own strength
    return [
      h('ul.pp-refs', s.items.map((it, i) => {
        const e = entryOf(it.ref);
        const r = ready(it.ref);
        const isEnc = (it.ref?.kind === 'card' || it.ref?.kind === 'encounter') && e?.kind === 'encounter';
        const encSub = isEnc ? (e.payload?.mobs || []).map((m) => `${m.count || 1}× ${(lib()[m.kind || 'monster'] || []).find((x) => x.id === m.sourceId)?.name || m.sourceId}`).join(', ') : '';
        return h('li.pp-ref',
          h('span.rd', { class: `rd ${r.cls}`, title: r.why, 'aria-label': r.why }),
          h('span.pp-kind', REF_LABEL[it.ref?.kind] || '?'),
          h('b.pp-ref-name', refName(it.ref)),
          isEnc ? strengthBadge(view, e.payload) : null,
          encSub ? h('span.dim.pp-enc-sub', encSub) : null,
          field(it.text, { cls: 'inp-sm pp-note', placeholder: 'Note for tonight', onCommit: (v) => act({ t: 'prep.item.update', id: d.id, key: s.key, itemId: it.id, text: v }) }),
          e ? h('button.btn.btn-sm', { type: 'button', onclick: () => openRef(it.ref) }, openLabel(it.ref)) : null,
          itemTools(d, s, it, i));
      })),
      mobs.length > 1 ? h('p.pp-hint', 'All of these at once: ', ratingBadge(family(), party(), mobs), h('span.dim', party().length ? ` for ${party().length} character${party().length === 1 ? '' : 's'}` : ' (no characters yet: counted as one)')) : null,
      refPicker(d, s),
    ];
  }
  function section(d, s) {
    const id = `${d.id}:${s.key}`;
    const closed = st.closed.has(id);
    const toggle = () => { if (closed) st.closed.delete(id); else st.closed.add(id); store.set('closed', [...st.closed]); sig = ''; draw(); };
    const open = s.items.filter((x) => !x.done).length;
    const body = s.kind === 'text'
      ? [field(s.text, { multiline: true, rows: s.key === 'notes' ? 4 : 3, placeholder: s.hint || '', onCommit: (v) => act({ t: 'prep.section.update', id: d.id, key: s.key, text: v }) })]
      : s.kind === 'list' ? listBody(d, s) : s.kind === 'parts' ? partsBody(d, s) : refsBody(d, s);
    return h('section.panel.pp-sec', { class: `panel pp-sec pp-k-${s.kind}`, 'data-prep-section': s.key },
      h('header.pp-sec-head',
        h('button.pp-sec-t', { type: 'button', 'aria-expanded': String(!closed), onclick: toggle }, icon(closed ? 'chevron' : 'down', { size: 14 }), h('h3', s.label),
          s.kind !== 'text' && s.items.length ? h('span.tab-n', s.kind === 'refs' ? String(s.items.length) : `${open}/${s.items.length}`) : null,
          s.carry ? h('span.pill', { title: 'Unfinished items move to the next session plan' }, 'carries over') : null),
        h('button.icon-btn', { type: 'button', title: 'Hide this section', onclick: () => act({ t: 'prep.section.update', id: d.id, key: s.key, hidden: true }) }, icon('eye', { size: 14 }))),
      closed ? null : h('div.pp-sec-body', s.hint && s.kind !== 'text' ? h('p.pp-hint.dim', s.hint) : null, body));
  }
  function docHead(d) {
    const isSes = d.type === 'session';
    const advs = docs().filter((x) => x.type === 'adventure');
    const adv = d.adventureId ? docById(d.adventureId) : null;
    const tonight = P().current === d.id;
    return h('header.pp-head',
      h('div.pp-head-row',
        field(d.title, { cls: 'pp-title', attrs: { 'aria-label': 'Title' }, onCommit: (v) => v.trim() && act({ t: 'prep.doc.update', id: d.id, title: v.trim() }) }),
        h('span.pill', tplLabel(d.template))),
      h('div.pp-head-row',
        isSes ? select([{ value: '', label: 'No adventure' }, ...advs.map((a) => ({ value: a.id, label: a.title }))], d.adventureId || '', { cls: 'inp-sm', label: 'Adventure', onChange: (v) => act({ t: 'prep.doc.update', id: d.id, adventureId: v || null }) }) : null,
        isSes && adv ? h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => select_(adv.id) }, 'Open adventure') : null,
        isSes ? (tonight ? h('span.pill.pill-on', icon('star', { size: 12 }), 'Tonight') : h('button.btn.btn-sm', { type: 'button', onclick: () => act({ t: 'prep.session.current', id: d.id }, 'This is tonight\'s plan.') }, 'Play this tonight')) : h('button.btn.btn-sm', { type: 'button', onclick: () => newSession(d.id) }, icon('plus', { size: 14 }), 'Session from this'),
        h('span.grow'),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: async () => { const r = await act({ t: 'prep.doc.copy', id: d.id }, 'Copied.'); if (r?.result?.id) select_(r.result.id); } }, icon('copy', { size: 14 }), 'Copy'),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: async () => { if (await ask(`Delete "${d.title}"? This cannot be undone.`, { ok: 'Delete', danger: true })) act({ t: 'prep.doc.remove', id: d.id }, 'Deleted.'); } }, icon('trash', { size: 14 }), 'Delete')));
  }
  function hiddenRow(d) {
    const hid = d.sections.filter((s) => s.hidden);
    const add = select([{ value: '', label: '+ Add a section…' }, { value: 'text', label: 'Text' }, { value: 'list', label: 'Tick list' }, { value: 'parts', label: 'Parts / scenes' }, { value: 'refs', label: 'Links to the library' }], '', {
      cls: 'inp-sm', label: 'Add a section',
      onChange: (kind) => {
        if (!kind) return;
        openDrawer({
          title: 'New section',
          body: h('form.pp-new', { onsubmit: (e) => { e.preventDefault(); const label = e.target.label.value.trim(); if (label) { act({ t: 'prep.section.add', id: d.id, label, kind, carry: e.target.carry?.checked === true }); closeDrawer(); } } },
            h('label.lbl', h('span.lbl-t', 'Name'), h('input.inp', { name: 'label', required: true, maxlength: 60, placeholder: 'Rival crawlers' })),
            kind === 'list' || kind === 'parts' ? h('label.chk', h('input', { type: 'checkbox', name: 'carry' }), 'Unfinished items carry over to the next session') : null,
            h('button.btn.btn-primary', { type: 'submit' }, 'Add')),
        });
        requestAnimationFrame(() => document.querySelector('.pp-new input[name=label]')?.focus());
      },
    });
    return h('footer.pp-foot',
      hid.length ? [h('span.dim', 'Hidden:'), hid.map((s) => h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => act({ t: 'prep.section.update', id: d.id, key: s.key, hidden: false }) }, icon('eye', { size: 12 }), s.label))] : null,
      h('span.grow'), add);
  }
  function main() {
    if (selKind() === 'enc') {
      const c = cards().find((x) => x.id === selId() && x.kind === 'encounter');
      if (c) {
        if (c.payload?.mapId && mapEd.current() !== c.payload.mapId) mapEd.select(c.payload.mapId);
        mapEd.embed(true);
        return h('div.pp-main', encounterEditor({ view, act, card: c, mapEd, inTonight, addToTonight, onDone: (id) => { if (id !== undefined) select_(id ? `enc:${id}` : null); else { sig = ''; draw(); } } }));
      }
    }
    if (selKind() === 'map' && (view?.maps || []).some((m) => m.id === selId())) {
      if (mapEd.current() !== selId()) mapEd.select(selId());
      mapEd.embed(false);
      return h('div.pp-main', mapEd.el);
    }
    const d = docById(st.sel) || docById(P().current) || docs()[docs().length - 1] || null;
    if (!d) {
      return h('div.pp-main.pp-empty', h('section.panel',
        h('h2', 'Prep for the next session'),
        h('p', 'Start with a session plan: a strong start, scenes that might happen, secrets the players can find, and links to the monsters, NPCs and places you need. Anything you do not play moves to the next plan.'),
        h('p.dim', 'Adventures hold what lasts several evenings (a neighbourhood, a quest, a dungeon). Pin anything with the star and it waits on the Show tab, one tap away.'),
        h('div.pp-head-row', h('button.btn.btn-primary', { type: 'button', onclick: () => newSession(null) }, icon('plus', { size: 14 }), 'New session plan'),
          h('button.btn', { type: 'button', onclick: () => newAdventure(null) }, icon('plus', { size: 14 }), 'New adventure'))));
    }
    const visible = d.sections.filter((s) => !s.hidden);
    const prepared = P().adventures?.some((a) => a.id === d.template);
    return h('div.pp-main', docHead(d), prepared ? h('nav.pp-head-row', { 'aria-label': 'Adventure sections' }, visible.map((s) => h('button.btn.btn-sm', {
      type: 'button', onclick: () => el.querySelector(`[data-prep-section="${s.key}"]`)?.scrollIntoView({ block: 'start' }),
    }, s.label))) : null, visible.map((s) => section(d, s)), hiddenRow(d));
  }

  /* ---------- within reach (Show tab) ---------- */
  function reachItems() {
    const p = P();
    const cur = docById(p.current);
    if (!cur) return [];
    const adv = cur.adventureId ? docById(cur.adventureId) : null;
    const out = [];
    for (const d of [cur, adv].filter(Boolean)) for (const s of d.sections) if (!s.hidden) for (const it of s.items) if (it.pin && !it.done) out.push({ d, s, it });
    return out.slice(0, 10);
  }
  function peek(d, s, it) {
    openDrawer({
      title: it.title || s.label, sub: `${d.title} · ${s.label}`,
      body: h('div.pp-peek', h('p', it.text || ''),
        it.links?.length ? h('div.pp-links', it.links.map((l) => h('button.btn.btn-sm', { type: 'button', disabled: !entryOf(l), onclick: () => { closeDrawer(); useRef(l); } }, h('span.pp-kind', REF_LABEL[l.kind]), `${useLabel(l)}: ${refName(l)}`))) : null,
        h('label.chk', h('input', { type: 'checkbox', checked: !!it.done, onchange: (e) => act({ t: 'prep.item.update', id: d.id, key: s.key, itemId: it.id, done: e.target.checked }) }), s.kind === 'list' ? 'Revealed' : 'Played')),
    });
  }
  function drawReach() {
    const items = reachItems();
    const cur = docById(P().current);
    const sgn = JSON.stringify([cur?.title, items.map((x) => [x.it.id, x.it.title, x.it.text, x.it.ref, x.it.links]), cards().map((c) => [c.id, c.label, c.used]), (view?.maps || []).map((m) => m.name)]);
    if (sgn === reachSig) return;
    reachSig = sgn;
    reach.hidden = !cur;
    if (!cur) { reach.replaceChildren(); return; }
    reach.replaceChildren(...[
      h('button.sh-reach-k', { type: 'button', title: `Tonight: ${cur.title}. Open the plan.`, onclick: () => { select_(cur.id); showView('prep'); } }, icon('star', { size: 12 }), 'Within reach'),
      items.length ? items.map(({ d, s, it }) => {
        if (it.ref) {
          const e = entryOf(it.ref);
          return h('button.sh-reach-i', { type: 'button', class: it.ref.kind === 'encounter' ? 'sh-reach-i sh-reach-enc' : 'sh-reach-i', title: `${REF_LABEL[it.ref.kind]}: ${useLabel(it.ref)}${it.text ? ` · ${it.text}` : ''}`, disabled: !e, onclick: () => useRef(it.ref) }, h('span.pp-kind', it.ref.kind === 'encounter' ? (e?.used ? 'Ran' : 'Run') : REF_LABEL[it.ref.kind]), refName(it.ref));
        }
        if (it.links?.length) {
          return h('span.sh-reach-scene',
            h('button.sh-reach-i', { type: 'button', title: it.text || it.title, onclick: () => peek(d, s, it) }, h('span.pp-kind', 'Scene'), it.title || it.text.slice(0, 30)),
            it.links.map((l) => h('button.sh-reach-i.sh-reach-sub', { type: 'button', class: l.kind === 'encounter' ? 'sh-reach-i sh-reach-sub sh-reach-enc' : 'sh-reach-i sh-reach-sub', disabled: !entryOf(l), title: `${REF_LABEL[l.kind]}: ${useLabel(l)}`, onclick: () => useRef(l) }, h('span.pp-kind', l.kind === 'encounter' ? (entryOf(l)?.used ? 'Ran' : 'Run') : REF_LABEL[l.kind]), refName(l))));
        }
        return h('button.sh-reach-i', { type: 'button', title: it.text || it.title, onclick: () => peek(d, s, it) }, h('span.pp-kind', s.label), it.title || (it.text.length > 40 ? `${it.text.slice(0, 40)}…` : it.text));
      }) : h('span.dim', 'Pin items in Prep with the star to keep them here.')].flat());
  }

  /* ---------- render ---------- */
  let pendingFocus = null;
  function draw() {
    const active = document.activeElement;
    if (active && el.contains(active) && /^(INPUT|TEXTAREA)$/.test(active.tagName) && active.type !== 'checkbox' && !pendingFocus) { pending = true; return; }
    const scroll = el.closest('.gm-main')?.scrollTop;
    el.replaceChildren(h('div.pp-grid', side(), main()));
    if (pendingFocus) { el.querySelector(`[data-add-for="${pendingFocus}"]`)?.focus(); pendingFocus = null; }
    if (scroll != null) el.closest('.gm-main').scrollTop = scroll;
  }
  el.addEventListener('focusout', () => setTimeout(() => { if (pending && !el.contains(document.activeElement)) { pending = false; sig = ''; draw(); } }, 0));

  function update(v) {
    view = v;
    drawReach();
    mapEd.update(v);
    const s = JSON.stringify([P(), (v.maps || []).map((m) => [m.id, m.name, m.zones.length, m.tokens.filter((t) => t.enc).map((t) => t.enc)]), cards().map((c) => [c.id, c.label, c.used, c.payload]), Object.values(lib()).map((x) => x.length), (v.players || []).map((p) => p.level)]);
    if (s === sig) return;
    sig = s;
    draw();
  }

  return { el, reach, update };
}
