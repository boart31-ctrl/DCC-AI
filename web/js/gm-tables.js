// Random tables, names and crowds for the GM (B3). Key T or the 🎲 button opens a drawer with three tabs:
//  - Tables: "Fits this scene" first (table scope vs the scene on the TV), then all by group; a result card with
//    Reroll · Keep · Show on TV · Tell a player.
//  - Crowd: "you're at a party and meet…" — place + how many (1–6) → people, each name + exactly 3 sentences;
//    Save (to the campaign NPCs) · Reroll one · Save all. Generate → Save → back to the scene in ≤ 3 taps.
//  - Names: five names from a list, tap one to copy it.
import { h, toast } from './client.js';

const SCENE_TAG = { combat: 'combat', boss: 'boss', explore: 'explore', npc: 'npc', trap: 'trap' };

export function createTables({ getView, act, button }) {
  const st = { tab: 'crowd', q: '', result: null, n: 3, place: null, names: null, list: null, tell: false };
  const body = h('div.tb-body');
  const tabs = h('div.tb-tabs', { role: 'tablist' });
  const dlg = h('dialog.sheet-dlg.tool.tb-dlg', { 'aria-label': 'Random tables' },
    h('div.sheet-inner',
      h('header.sheet-head', h('h3', 'Dice of fate'), tabs, h('button.icon-btn.sheet-x', { type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
      h('div.sheet-body', body)));
  document.body.append(dlg);

  const T = () => getView()?.gm?.tables ?? { catalog: [], names: [], places: [], crowd: null, recent: [], kept: [] };
  const players = () => getView()?.players ?? [];

  const tv = (text) => act({ t: 'msg.send', to: 'all', onStage: true, text: text.slice(0, 500) }, 'On TV.');
  const keep = (table, text) => act({ t: 'table.keep', table, text }, 'Kept for tonight.');
  function tellRow(text) {
    const ps = players();
    if (!ps.length) return null;
    return h('div.tb-tell', h('span.dim', 'Tell:'), ...ps.map((p) => h('button.chip', { type: 'button', onclick: () => act({ t: 'msg.send', to: [p.id], text: text.slice(0, 500) }, `Sent to ${p.name}.`) }, p.name)));
  }

  function drawTabs() {
    tabs.replaceChildren(...[['crowd', 'Crowd'], ['tables', 'Tables'], ['names', 'Names']].map(([id, label]) =>
      h('button.chip', { type: 'button', role: 'tab', class: `chip${st.tab === id ? ' on' : ''}`, 'aria-selected': String(st.tab === id), onclick: () => { st.tab = id; draw(); } }, label)));
  }

  // ---------- tables ----------
  async function roll(id) {
    const ack = await act({ t: 'table.roll', id });
    if (ack?.result) { st.result = ack.result; draw(); }
  }
  function resultCard(r) {
    if (!r) return null;
    return h('section.panel.tb-result', { 'aria-live': 'polite' },
      h('p.tb-die', r.roll ? `${r.table} · ${r.die} = ${r.roll}` : r.table),
      h('p.tb-text', r.text),
      h('div.tb-acts',
        h('button.btn.btn-primary', { type: 'button', onclick: () => roll(r.tableId) }, 'Reroll'),
        h('button.btn', { type: 'button', onclick: () => keep(r.table, r.text) }, 'Keep'),
        h('button.btn', { type: 'button', onclick: () => tv(r.text) }, 'Show on TV')),
      tellRow(r.text));
  }
  function tablesTab() {
    const t = T();
    const search = h('input.field', { type: 'search', value: st.q, placeholder: 'Search tables', 'aria-label': 'Search tables', autocomplete: 'off',
      oninput: (e) => { st.q = e.target.value; draw(); const s = body.querySelector('input[type=search]'); s?.focus(); s?.setSelectionRange(st.q.length, st.q.length); } });
    const q = st.q.trim().toLowerCase();
    const kind = SCENE_TAG[getView()?.scene?.kind] ?? null;
    const btn = (x) => h('button.tb-pick', { type: 'button', onclick: () => roll(x.id), title: x.desc || x.name }, h('b', x.name), h('span.dim', x.die));
    const parts = [search, resultCard(st.result)];
    if (q) parts.push(h('div.tb-grid', t.catalog.filter((x) => `${x.name} ${x.group} ${x.desc}`.toLowerCase().includes(q)).map(btn)));
    else {
      const fits = kind ? t.catalog.filter((x) => x.scope?.scenes?.includes(kind)) : [];
      if (fits.length) parts.push(h('h4.tb-h', 'Fits this scene'), h('div.tb-grid', fits.map(btn)));
      const groups = [...new Set(t.catalog.map((x) => x.group))];
      for (const g of groups) parts.push(h('h4.tb-h', g), h('div.tb-grid', t.catalog.filter((x) => x.group === g).map(btn)));
      if (!t.catalog.length) parts.push(h('p.dim', 'This pack has no tables yet (tables.json).'));
    }
    if (t.kept.length) parts.push(h('h4.tb-h', 'Kept tonight'), h('ul.tb-kept', [...t.kept].reverse().slice(0, 8).map((k) => h('li', h('span.dim', `${k.table}: `), k.text))));
    return parts;
  }

  // ---------- crowd ----------
  function crowdTab() {
    const t = T();
    const c = t.crowd;
    st.place ??= t.places[0]?.id ?? null;
    const placeChips = h('div.tb-chips', ...t.places.map((p) => h('button.chip', { type: 'button', class: `chip${st.place === p.id ? ' on' : ''}`, 'aria-pressed': String(st.place === p.id), onclick: () => { st.place = p.id; draw(); } }, p.name)));
    const count = h('div.tb-count', h('span.dim', 'People'),
      ...[1, 2, 3, 4, 5, 6].map((n) => h('button.chip', { type: 'button', class: `chip${st.n === n ? ' on' : ''}`, 'aria-pressed': String(st.n === n), onclick: () => { st.n = n; draw(); } }, String(n))));
    const gen = h('button.btn.btn-primary.tb-gen', { type: 'button', onclick: () => act({ t: 'crowd.gen', place: st.place, n: st.n }) }, c ? 'New crowd' : 'Meet them');
    const people = c?.people ?? [];
    const cards = people.map((p) => h('article.panel.tb-person', { class: `panel tb-person${p.npcId ? ' saved' : ''}` },
      h('header', h('b', p.name), p.species ? h('span.dim', ` · ${p.species}`) : null),
      h('ol.tb-lines', p.lines.map((l) => h('li', l))),
      h('div.tb-acts',
        p.npcId ? h('span.pill.pill-on', 'Saved') : h('button.btn.btn-primary', { type: 'button', onclick: () => act({ t: 'crowd.save', id: p.id }, `${p.name} saved to the campaign.`) }, 'Save'),
        h('button.btn', { type: 'button', onclick: () => act({ t: 'crowd.reroll', id: p.id }) }, 'Reroll'),
        h('button.btn.btn-quiet', { type: 'button', onclick: () => tv(`${p.name}. ${p.lines[0]}`) }, 'TV'))));
    const unsaved = people.filter((p) => !p.npcId).length;
    return [
      h('p.dim.tb-lead', 'You walk into… and meet:'), placeChips, h('div.tb-row', count, gen),
      people.length ? h('div.tb-people', cards) : h('p.dim', 'Pick a place and how many, then Meet them. Each person is three lines: look · want · hook.'),
      people.length > 1 && unsaved ? h('button.btn.tb-saveall', { type: 'button', onclick: () => act({ t: 'crowd.save', all: true }, `${unsaved} saved to the campaign.`) }, `Save all ${unsaved}`) : null,
    ];
  }

  // ---------- names ----------
  async function names(list) {
    st.list = list;
    const ack = await act({ t: 'names.roll', list, n: 5 });
    if (ack?.result) { st.names = ack.result.names; draw(); }
  }
  function namesTab() {
    const t = T();
    if (!t.names.length) return [h('p.dim', 'This pack has no name lists yet.')];
    st.list ??= t.names[0].id;
    return [
      h('div.tb-chips', ...t.names.map((n) => h('button.chip', { type: 'button', class: `chip${st.list === n.id ? ' on' : ''}`, onclick: () => names(n.id) }, n.name))),
      h('button.btn.btn-primary.tb-gen', { type: 'button', onclick: () => names(st.list) }, '5 names'),
      st.names ? h('div.tb-names', st.names.map((n) => h('button.tb-name', { type: 'button', title: 'Copy', onclick: async () => { try { await navigator.clipboard.writeText(n); toast(`Copied ${n}.`); } catch { toast(n); } } }, n))) : null,
    ];
  }

  function draw() {
    if (!dlg.open) return;
    drawTabs();
    body.replaceChildren(...(st.tab === 'tables' ? tablesTab() : st.tab === 'names' ? namesTab() : crowdTab()).filter(Boolean));
  }

  function open(tab) {
    if (tab) st.tab = tab;
    if (!dlg.open) dlg.showModal();
    draw();
    if (st.tab === 'tables') body.querySelector('input[type=search]')?.focus();
  }
  button?.addEventListener('click', () => open());
  document.addEventListener('keydown', (e) => {
    if ((e.key !== 't' && e.key !== 'T') || e.ctrlKey || e.metaKey || e.altKey) return;
    const tg = e.target;
    if (tg instanceof HTMLElement && (tg.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName))) return;
    if (document.querySelector('dialog[open]')) return;
    e.preventDefault();
    open();
  });
  return { open, update: () => draw() };
}
