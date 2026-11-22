// Achievements for the GM (ACHIEVEMENTS_DESIGN.md layers 1+2):
//  - suggestionsPanel(): what the System noticed (Award / Later / Never), shown in Loot & Rewards;
//  - createAchPicker(): key H, "hall of fame" (A is AUTO in Show), or the 🏆 button — pick crawler(s), "Suggested now", "Fits this moment" (achievements
//    whose trigger matches the last moments), search, or type a title and award a custom one on the spot.
import { h } from './client.js';

export function suggestionsPanel(gm, { act }) {
  const list = gm?.achSuggestions ?? [];
  const head = h('div.ach-sg-head', h('b', 'The System noticed'),
    h('span.ach-sg-opts',
      h('label.dim', h('input', { type: 'checkbox', checked: gm?.achSettings?.suggest !== false, onchange: (e) => act({ t: 'ach.settings', suggest: e.target.checked }) }), ' suggest achievements'),
      h('label.dim', { title: 'Small ones (first box, first hit…) are given without asking and without a System line' }, h('input', { type: 'checkbox', checked: gm?.achSettings?.auto !== false, onchange: (e) => act({ t: 'ach.settings', auto: e.target.checked }) }), ' give quiet ones by itself')));
  if (!list.length) return h('div.panel.ach-sg', head, h('p.dim', 'Nothing yet. Crits, fumbles, kills and rescues show up here; press H to award anything by hand.'));
  return h('div.panel.ach-sg', head, h('ul', [...list].reverse().map((s) => h('li',
    h('span', h('b', s.title), ` → ${s.name}`),
    h('span.ach-sg-btns',
      h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => act({ t: 'ach.suggest.award', id: s.id }, `Awarded ${s.title}.`) }, 'Award'),
      h('button.btn.btn-sm', { type: 'button', onclick: () => act({ t: 'ach.suggest.dismiss', id: s.id }) }, 'Later'),
      h('button.btn.btn-sm.btn-quiet', { type: 'button', title: 'Never suggest this one for this crawler again', onclick: () => act({ t: 'ach.suggest.dismiss', id: s.id, never: true }) }, 'Never'))))));
}

export function createAchPicker({ getView, act, button }) {
  let picked = new Set();
  const search = h('input.field', { type: 'search', placeholder: 'Search, or type a new title to award it as custom', 'aria-label': 'Search achievements', autocomplete: 'off' });
  const crawlers = h('div.ach-pk-who');
  const body = h('div.ach-pk-body');
  const dlg = h('dialog.sheet-dlg.tool.ach-pk', { 'aria-label': 'Award an achievement' },
    h('div.sheet-inner',
      h('header.sheet-head', h('h3', 'Award an achievement'), h('button.icon-btn.sheet-x', { type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
      h('div.sheet-body', crawlers, search, body)));
  document.body.append(dlg);
  search.addEventListener('input', draw);

  async function award(a) {
    const who = [...picked];
    if (!who.length) { search.setCustomValidity('Pick a crawler first'); search.reportValidity(); return; }
    for (const playerId of who) await act(a.id ? { t: 'ach.award', playerId, achId: a.id } : { t: 'ach.award', playerId, title: a.title }, `Awarded ${a.title}.`);
    dlg.close();
  }

  function row(a, why) {
    return h('button.ach-pk-row', { type: 'button', onclick: () => award(a) },
      h('b', a.title), why ? h('span.ach-pk-why', why) : null, a.desc ? h('span.dim', a.desc.length > 110 ? `${a.desc.slice(0, 110)}…` : a.desc) : null);
  }

  function draw() {
    search.setCustomValidity('');
    const v = getView();
    const gm = v?.gm ?? {};
    const players = v?.players ?? [];
    crawlers.replaceChildren(...players.map((p) => h('button.chip', { type: 'button', class: `chip${picked.has(p.id) ? ' on' : ''}`, 'aria-pressed': String(picked.has(p.id)),
      onclick: () => { picked.has(p.id) ? picked.delete(p.id) : picked.add(p.id); draw(); } }, p.name)));
    const cat = gm.achievementsCatalog ?? [];
    const q = search.value.trim().toLowerCase();
    const sections = [];
    if (!q) {
      const sg = gm.achSuggestions ?? [];
      if (sg.length) sections.push(h('h4', 'Suggested now'), ...[...sg].reverse().map((s) => h('button.ach-pk-row', { type: 'button', onclick: async () => { await act({ t: 'ach.suggest.award', id: s.id }, `Awarded ${s.title}.`); dlg.close(); } },
        h('b', s.title), h('span.ach-pk-why', `→ ${s.name}`))));
      const recent = gm.achRecent ?? [];
      const kinds = new Set(recent.map((m) => m.on));
      const fits = cat.filter((a) => a.on && kinds.has(a.on)).slice(0, 8);
      if (fits.length) sections.push(h('h4', 'Fits this moment'), ...fits.map((a) => row(a, a.on)));
      sections.push(h('h4', 'All'), ...cat.slice(0, 40).map((a) => row(a)));
    } else {
      const hits = cat.filter((a) => `${a.title} ${a.desc} ${a.group}`.toLowerCase().includes(q)).slice(0, 30);
      sections.push(...hits.map((a) => row(a)));
      sections.push(h('button.btn.btn-primary.ach-pk-custom', { type: 'button', onclick: () => award({ title: search.value.trim().slice(0, 80) }) }, `Award custom “${search.value.trim().slice(0, 80)}”`));
    }
    body.replaceChildren(...sections);
  }

  function open() {
    const v = getView();
    // Preselect the crawler from the newest moment, so "A, Enter" works for the obvious case.
    const last = (v?.gm?.achRecent ?? []).at(-1);
    picked = new Set(last?.playerId ? [last.playerId] : []);
    search.value = '';
    draw();
    if (!dlg.open) dlg.showModal();
    search.focus();
  }
  button?.addEventListener('click', open);
  document.addEventListener('keydown', (e) => {
    if ((e.key !== 'h' && e.key !== 'H') || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.querySelector('dialog[open]')) return;
    e.preventDefault();
    open();
  });
  return { open };
}
