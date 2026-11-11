// GM desk → NPCs: the cast at a glance. Filter the library NPCs, open a card (personality, voice
// tips, hooks, secrets), put the NPC on the TV (scene kind `npc`: portrait, name, role; never the
// secrets) and "Speak as NPC" (a TV subtitle in their name via `npc.say`; no voice yet).
//
// createNpcs({ act, getView, openInLibrary }) → { el, update(view) }
import { h, toast } from './client.js';
import { libraryOf } from './rules.js';
import { icon, select } from './ui.js';
import { entryArt } from './portrait.js';

export function createNpcs({ act, getView, openInLibrary }) {
  let view = null;
  let sig = '';
  const st = { q: '', floor: '', sel: null, said: [] };
  const el = h('div.npcs');
  const npcs = () => libraryOf(view).npc || [];
  const here = () => {
    const sc = view?.scene;
    if (sc?.kind !== 'explore' || !sc.data?.locationId) return new Set();
    const loc = (libraryOf(view).location || []).find((l) => l.id === sc.data.locationId);
    return new Set(loc?.npcs || []);
  };
  const onTvId = () => (view?.scene?.kind === 'npc' ? view.scene.data?.npcId ?? null : undefined);

  function list() {
    const q = st.q.toLowerCase();
    const atLoc = here();
    const floors = [...new Set(npcs().map((n) => n.floor).filter((f) => f !== '' && f != null))].sort((a, b) => Number(a) - Number(b));
    const hits = npcs()
      .filter((n) => (!st.floor || String(n.floor) === st.floor) && (!q || `${n.name} ${n.role} ${(n.tags || []).join(' ')}`.toLowerCase().includes(q)))
      .sort((a, b) => (atLoc.has(b.id) - atLoc.has(a.id)) || a.name.localeCompare(b.name));
    const search = h('input.inp', { type: 'search', value: st.q, placeholder: 'Search NPCs', 'aria-label': 'Search NPCs', oninput: (e) => { st.q = e.target.value; const pos = e.target.selectionStart; draw(true); const s = el.querySelector('.npc-side input[type=search]'); s?.focus(); try { s?.setSelectionRange(pos, pos); } catch {} } });
    return h('aside.npc-side',
      h('div.npc-filters', search, floors.length > 1 ? select([{ value: '', label: 'All floors' }, ...floors.map((f) => ({ value: String(f), label: `Floor ${f}` }))], st.floor, { cls: 'inp-sm', label: 'Floor', onChange: (v) => { st.floor = v; draw(true); } }) : null),
      h('ul.npc-list', { role: 'listbox', 'aria-label': 'NPCs' }, hits.length ? hits.map((n) => h('li', h('button.npc-row', {
        type: 'button', role: 'option', 'aria-selected': String(st.sel === n.id),
        onclick: () => { st.sel = n.id; draw(true); el.querySelector('.npc-say textarea')?.focus(); },
      },
      entryArt(n, { cls: 'npc-thumb' }),
      h('span.npc-row-t', h('b', n.name), h('span.dim', n.role || '')),
      atLoc.has(n.id) ? h('span.pill.pill-on', 'Here') : null,
      onTvId() === n.id ? h('span.sc-onair', 'On TV') : null))) : h('li.empty-s', npcs().length ? 'Nothing matches.' : 'No NPCs yet. Add npcs.json to the pack or create one in the Library.')));
  }

  function card(n) {
    if (!n) return h('section.panel.npc-card.npc-empty', h('p', h('b', 'Pick an NPC.')), h('p.dim', 'Their card opens here: how to play them, what they want, what they hide.'));
    const live = onTvId() === n.id;
    const text = h('textarea.inp', { rows: 2, maxlength: 300, placeholder: `Type a line as ${n.name}. Enter sends it to the TV, Shift+Enter for a new line.`, 'aria-label': `Line for ${n.name}` });
    const sayIt = async () => {
      const t = text.value.trim();
      if (!t) { text.focus(); return; }
      if (await act({ t: 'npc.say', npcId: n.id, text: t })) {
        st.said.unshift({ id: n.id, name: n.name, text: t, at: Date.now() });
        st.said = st.said.slice(0, 8);
        text.value = '';
        draw(true);
        el.querySelector('.npc-say textarea')?.focus();
      }
    };
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sayIt(); } });
    const block = (title, items, cls = '') => (items?.length ? h('section', { class: `npc-sec ${cls}` }, h('h3.sub-t', title), h('ul', items.map((x) => h('li', x)))) : null);
    const lines = st.said.filter((x) => x.id === n.id);
    return h('section.panel.npc-card',
      h('div.npc-top',
        entryArt(n, { cls: 'npc-portrait' }),
        h('div.npc-id',
          h('h2', n.name),
          n.role ? h('p.npc-role', n.role) : null,
          h('p.dim', [n.floor !== '' && n.floor != null ? `Floor ${n.floor}` : '', n.source === 'homebrew' ? 'Homebrew' : 'Pack'].filter(Boolean).join(' · ')),
          h('div.row-start',
            h('button.btn.btn-primary', { type: 'button', onclick: () => act({ t: 'scene.set', kind: 'npc', data: { npcId: n.id } }, `On TV: ${n.name}.`) }, icon('tv', { size: 15 }), live ? 'Show again' : 'Show on TV'),
            live && view.scene.data?.line ? h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => act({ t: 'scene.update', data: { line: '' } }) }, 'Clear line') : null,
            openInLibrary ? h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => openInLibrary('npc', n.id) }, icon('edit', { size: 14 }), 'Edit') : null))),
      h('div.npc-say',
        h('label.lbl', h('span.lbl-t', icon('chat', { size: 13 }), ` Speak as ${n.name}`), text),
        h('div.row-end', h('span.dim.grow', live ? 'Shows under their portrait on the TV.' : 'Shows as a subtitle over whatever is on the TV.'), h('button.btn.btn-sm', { type: 'button', onclick: sayIt }, 'Send to TV')),
        lines.length ? h('ol.npc-said', lines.map((x) => h('li', h('button.btn-link', { type: 'button', title: 'Send again', onclick: () => { text.value = x.text; sayIt(); } }, `“${x.text}”`)))) : null),
      n.personality ? h('section.npc-sec', h('h3.sub-t', 'Personality'), h('p', n.personality)) : null,
      n.voice ? h('section.npc-sec', h('h3.sub-t', 'How to play them'), h('p', n.voice)) : null,
      block('Hooks', n.hooks),
      n.secrets?.length ? h('section.npc-sec.sc-gm-only', h('p.sc-gm-k', icon('lock', { size: 12 }), 'Secrets: GM only, never on the TV'), h('ul', n.secrets.map((x) => h('li', x)))) : null,
      n.desc ? h('section.npc-sec', h('h3.sub-t', 'Notes'), h('p', n.desc)) : null,
    );
  }

  function draw(force = false) {
    if (!view) return;
    const s = JSON.stringify([npcs().map((n) => [n.id, n.name, n.role, n.image, n.floor]), view.scene?.kind, view.scene?.data?.npcId, view.scene?.data?.line, view.scene?.data?.locationId, st.sel]);
    if (!force && s === sig) return;
    if (!force && el.contains(document.activeElement) && document.activeElement.matches('input, textarea')) return;
    sig = s;
    if (st.sel && !npcs().some((n) => n.id === st.sel)) st.sel = null;
    if (!st.sel) st.sel = onTvId() || npcs()[0]?.id || null;
    el.replaceChildren(
      h('div.view-head', h('h1', 'NPCs'), h('span.dim', `${npcs().length} in the library`)),
      h('div.npc-cols', list(), card(npcs().find((n) => n.id === st.sel))));
  }
  el.addEventListener('focusout', () => setTimeout(() => { if (!el.contains(document.activeElement)) draw(); }, 0));

  return { el, update(v) { view = v; draw(); } };
}
