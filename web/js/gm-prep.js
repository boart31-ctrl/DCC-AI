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
// createPrep({ act, getView, scenes, showView, openInLibrary }) → { el, reach, update(view) }
import { h, toast, ask } from './client.js';
import { icon, field, select, openDrawer, closeDrawer } from './ui.js';
import { libraryOf } from './rules.js';
import { benchmark } from './prep-bench.js';

const REF_LABEL = { monster: 'Monster', boss: 'Boss', npc: 'NPC', location: 'Location', item: 'Item', spell: 'Spell', buff: 'Buff', card: 'Card', map: 'Map' };
const LIB_REF = ['monster', 'boss', 'npc', 'location', 'item', 'spell', 'buff'];
const store = {
  get(k, d) { try { const v = localStorage.getItem(`system.prep.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`system.prep.${k}`, JSON.stringify(v)); } catch {} },
};

export function createPrep({ act, getView, scenes, showView, openInLibrary }) {
  let view = null;
  let sig = '';
  let reachSig = '';
  let pending = false;
  const st = { sel: store.get('sel', null), closed: new Set(store.get('closed', [])), q: '' };
  const el = h('div.prep2');
  const reach = h('div.sh-reach', { hidden: true });

  const P = () => view?.gm?.prep || { docs: [], current: null, templates: [], defaults: {} };
  const docs = () => P().docs || [];
  const docById = (id) => docs().find((d) => d.id === id) || null;
  const lib = () => libraryOf(view);
  const cards = () => view?.gm?.prepCards || [];
  const family = () => view?.pack?.ruleset?.system?.family || 'crawler';
  const party = () => (view?.players || []).map((p) => ({ level: p.level || 1 }));
  const tplLabel = (id) => (P().templates || []).find((t) => t.id === id)?.label || id;

  function entryOf(ref) {
    if (!ref) return null;
    if (ref.kind === 'card') return cards().find((c) => c.id === ref.id) || null;
    if (ref.kind === 'map') return (view?.maps || []).find((m) => m.id === ref.id) || null;
    return (lib()[ref.kind] || []).find((e) => e.id === ref.id) || null;
  }
  function refName(ref) {
    const e = entryOf(ref);
    if (!e) return `${ref.id} (missing)`;
    return ref.kind === 'card' ? (e.label || e.kind) : e.name;
  }
  /** Readiness: red = missing from the library, amber = no art, green = has art. */
  function ready(ref) {
    const e = entryOf(ref);
    if (!e) return { cls: 'rd-red', why: 'Not in the library any more.' };
    if (ref.kind === 'card') return { cls: e.used ? 'rd-amber' : 'rd-green', why: e.used ? 'Already used tonight.' : 'Ready.' };
    if (['monster', 'boss', 'npc', 'location'].includes(ref.kind) && !(e.image || e.imageSquare || e.portrait)) return { cls: 'rd-amber', why: 'No picture yet: the TV shows a generated placeholder.' };
    return { cls: 'rd-green', why: 'Has a picture.' };
  }
  function encounterMobs(card) {
    return (card?.payload?.mobs || []).map((m) => {
      const kind = m.kind || 'monster';
      const e = (lib()[kind] || []).find((x) => x.id === m.sourceId);
      return { count: m.count || 1, level: e?.level, cr: e?.cr, role: kind === 'boss' ? 'boss' : (e?.role || 'standard') };
    });
  }
  function benchBadge(mobs) {
    const b = benchmark(family(), party(), mobs);
    if (b.level < 0) return null;
    return h('span.pp-bench', { class: `pp-bench pp-b${b.level}`, title: b.detail }, b.label);
  }

  /* ---------- actions ---------- */
  const select_ = (id) => { st.sel = id; store.set('sel', id); sig = ''; draw(); };
  async function newAdventure(template) {
    const r = await act({ t: 'prep.adventure.add', title: 'New adventure', ...(template ? { template } : {}) }, 'Adventure created.');
    if (r?.result?.id) select_(r.result.id);
  }
  async function newSession(fromAdventure) {
    const r = await act({ t: 'prep.session.add', ...(fromAdventure ? { adventureId: fromAdventure } : {}) });
    if (r?.result?.id) {
      toast(r.result.carried ? `Session created. ${r.result.carried} unfinished item${r.result.carried === 1 ? '' : 's'} carried over.` : 'Session created.');
      select_(r.result.id);
    }
  }
  async function useRef(ref) {
    const e = entryOf(ref);
    if (!e) { toast('Not in the library any more.', { error: true }); return; }
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
    openInLibrary(ref.kind, ref.id);
  }
  const useLabel = (ref) => ({ map: 'Preview', location: 'Preview', npc: 'Preview', boss: 'Preview', monster: 'Add to fight', card: 'Fire' }[ref.kind] || 'Open');

  /* ---------- left: doc list ---------- */
  function docRow(d) {
    const cur = P().current === d.id;
    const adv = d.adventureId ? docById(d.adventureId) : null;
    return h('li', h('button.pp-doc', { type: 'button', 'aria-current': st.sel === d.id ? 'true' : null, onclick: () => select_(d.id) },
      h('span.pp-doc-t', d.title),
      h('span.dim', d.type === 'session' ? (adv ? adv.title : 'No adventure') : tplLabel(d.template)),
      cur ? h('span.pill.pill-on', 'Tonight') : null));
  }
  function side() {
    const adv = docs().filter((d) => d.type === 'adventure');
    const ses = docs().filter((d) => d.type === 'session').slice().reverse();
    const advTpls = (P().templates || []).filter((t) => t.scope === 'adventure');
    return h('aside.pp-side',
      h('div.pp-side-head', h('h2', 'Sessions'),
        h('button.btn.btn-sm', { type: 'button', onclick: () => newSession(null), title: 'New session plan: unfinished secrets and scenes from tonight carry over' }, icon('plus', { size: 14 }), 'New session')),
      ses.length ? h('ul.pp-docs', ses.map(docRow)) : h('p.empty-s', 'No session plan yet.'),
      h('div.pp-side-head', h('h2', 'Adventures'),
        advTpls.length > 1
          ? select([{ value: '', label: '+ New…' }, ...advTpls.map((t) => ({ value: t.id, label: t.label }))], '', { cls: 'inp-sm', label: 'New adventure from template', onChange: (v) => v && newAdventure(v) })
          : h('button.btn.btn-sm', { type: 'button', onclick: () => newAdventure(null) }, icon('plus', { size: 14 }), 'New')),
      adv.length ? h('ul.pp-docs', adv.map(docRow)) : h('p.empty-s', 'An adventure holds what lasts several evenings: a neighbourhood, a quest, a dungeon.'));
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
        field(it.text, { multiline: true, rows: 3, placeholder: 'What is here, what happens, what the players can find', onCommit: (v) => act({ t: 'prep.item.update', id: d.id, key: s.key, itemId: it.id, text: v }) })))),
      h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => act({ t: 'prep.item.add', id: d.id, key: s.key, title: `${s.label.replace(/s$/, '')} ${s.items.length + 1}` }) }, icon('plus', { size: 14 }), 'Add'),
    ];
  }
  function refPicker(d, s) {
    const kinds = s.refKinds?.length ? s.refKinds : [...LIB_REF, 'card', 'map'];
    const have = new Set(s.items.map((it) => `${it.ref?.kind}:${it.ref?.id}`));
    const groups = [];
    for (const k of kinds) {
      const opts = k === 'card'
        ? cards().map((c) => ({ value: `card:${c.id}`, label: `${c.label} (${c.kind})` }))
        : k === 'map' ? (view?.maps || []).map((m) => ({ value: `map:${m.id}`, label: m.name }))
        : (lib()[k] || []).map((e) => ({ value: `${k}:${e.id}`, label: `${e.floor != null && e.floor !== '' ? `F${e.floor} ` : ''}${e.name}` }));
      const free = opts.filter((o) => !have.has(o.value)).sort((a, b) => a.label.localeCompare(b.label));
      if (free.length) groups.push({ label: REF_LABEL[k] || k, options: free });
    }
    if (!groups.length) return h('p.dim.pp-hint', kinds.includes('card') ? 'Nothing to link: add entries in the Library or prepared cards on the Show tab.' : 'Nothing to link: add entries in the Library first.');
    return select([{ value: '', label: `+ Link ${kinds.map((k) => REF_LABEL[k].toLowerCase()).join(' / ')}…` }, ...groups], '', {
      cls: 'inp-sm', label: `Link to ${s.label}`,
      onChange: (v) => { if (!v) return; const [kind, ...rest] = v.split(':'); act({ t: 'prep.item.add', id: d.id, key: s.key, ref: { kind, id: rest.join(':') } }); },
    });
  }
  function refsBody(d, s) {
    const mobs = [];
    for (const it of s.items) {
      if (it.ref?.kind === 'monster') mobs.push({ count: 1, level: entryOf(it.ref)?.level, cr: entryOf(it.ref)?.cr, role: entryOf(it.ref)?.role || 'standard' });
      if (it.ref?.kind === 'boss') mobs.push({ role: 'boss', level: entryOf(it.ref)?.level });
    }
    return [
      h('ul.pp-refs', s.items.map((it, i) => {
        const e = entryOf(it.ref);
        const r = ready(it.ref);
        const isEnc = it.ref?.kind === 'card' && e?.kind === 'encounter';
        return h('li.pp-ref',
          h('span.rd', { class: `rd ${r.cls}`, title: r.why, 'aria-label': r.why }),
          h('span.pp-kind', REF_LABEL[it.ref?.kind] || '?'),
          h('b.pp-ref-name', refName(it.ref)),
          isEnc ? benchBadge(encounterMobs(e)) : null,
          field(it.text, { cls: 'inp-sm pp-note', placeholder: 'Note for tonight', onCommit: (v) => act({ t: 'prep.item.update', id: d.id, key: s.key, itemId: it.id, text: v }) }),
          e ? h('button.btn.btn-sm', { type: 'button', onclick: () => useRef(it.ref) }, useLabel(it.ref)) : null,
          itemTools(d, s, it, i));
      })),
      mobs.length > 1 ? h('p.pp-hint', 'All of these at once: ', benchBadge(mobs), h('span.dim', party().length ? ` for ${party().length} character${party().length === 1 ? '' : 's'}` : ' (no characters yet: counted as one)')) : null,
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
    return h('section.panel.pp-sec', { class: `panel pp-sec pp-k-${s.kind}` },
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
    const d = docById(st.sel) || docById(P().current) || docs()[docs().length - 1] || null;
    if (!d) {
      return h('div.pp-main.pp-empty', h('section.panel',
        h('h2', 'Prep for the next session'),
        h('p', 'Start with a session plan: a strong start, scenes that might happen, secrets the players can find, and links to the monsters, NPCs and places you need. Anything you do not play moves to the next plan.'),
        h('p.dim', 'Adventures hold what lasts several evenings (a neighbourhood, a quest, a dungeon). Pin anything with the star and it waits on the Show tab, one tap away.'),
        h('div.pp-head-row', h('button.btn.btn-primary', { type: 'button', onclick: () => newSession(null) }, icon('plus', { size: 14 }), 'New session plan'),
          h('button.btn', { type: 'button', onclick: () => newAdventure(null) }, icon('plus', { size: 14 }), 'New adventure'))));
    }
    return h('div.pp-main', docHead(d), d.sections.filter((s) => !s.hidden).map((s) => section(d, s)), hiddenRow(d));
  }

  /* ---------- within reach (Show tab) ---------- */
  function reachItems() {
    const p = P();
    const cur = docById(p.current);
    if (!cur) return [];
    const adv = cur.adventureId ? docById(cur.adventureId) : null;
    const out = [];
    for (const d of [cur, adv].filter(Boolean)) for (const s of d.sections) if (!s.hidden) for (const it of s.items) if (it.pin && !it.done) out.push({ d, s, it });
    return out.slice(0, 8);
  }
  function drawReach() {
    const items = reachItems();
    const cur = docById(P().current);
    const sgn = JSON.stringify([cur?.title, items.map((x) => [x.it.id, x.it.title, x.it.text, x.it.ref]), cards().map((c) => c.used)]);
    if (sgn === reachSig) return;
    reachSig = sgn;
    reach.hidden = !cur;
    if (!cur) { reach.replaceChildren(); return; }
    reach.replaceChildren(...[
      h('button.sh-reach-k', { type: 'button', title: `Tonight: ${cur.title}. Open the plan.`, onclick: () => { select_(cur.id); showView('prep'); } }, icon('star', { size: 12 }), 'Within reach'),
      items.length ? items.map(({ d, s, it }) => {
        if (it.ref) {
          const e = entryOf(it.ref);
          return h('button.sh-reach-i', { type: 'button', title: `${REF_LABEL[it.ref.kind]}: ${useLabel(it.ref)}${it.text ? ` · ${it.text}` : ''}`, disabled: !e, onclick: () => useRef(it.ref) }, h('span.pp-kind', REF_LABEL[it.ref.kind]), refName(it.ref));
        }
        return h('button.sh-reach-i', { type: 'button', title: it.text || it.title, onclick: () => openDrawer({
          title: it.title || s.label, sub: `${d.title} · ${s.label}`,
          body: h('div.pp-peek', h('p', it.text || ''), h('label.chk', h('input', { type: 'checkbox', checked: !!it.done, onchange: (e) => act({ t: 'prep.item.update', id: d.id, key: s.key, itemId: it.id, done: e.target.checked }) }), s.kind === 'list' ? 'Revealed' : 'Played')),
        }) }, h('span.pp-kind', s.label), it.title || (it.text.length > 40 ? `${it.text.slice(0, 40)}…` : it.text));
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
    const s = JSON.stringify([P(), (v.maps || []).map((m) => [m.id, m.name]), cards().map((c) => [c.id, c.label, c.used]), Object.values(lib()).map((x) => x.length), (v.players || []).map((p) => p.level)]);
    if (s === sig) return;
    sig = s;
    draw();
  }

  return { el, reach, update };
}
