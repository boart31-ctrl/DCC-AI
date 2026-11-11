// GM art gallery: every picture the pack already ships (monster / boss / NPC portraits, item icons, VFX,
// finale spots, loot crates, locations) in one searchable grid, so a monster without art (pack or homebrew,
// or an ad-hoc mob) can borrow one. Built from what the GM view already has (library + ui.json): no server
// listing needed, and a new art sheet shows up here as soon as the pack is redeployed.
import { h } from './client.js';
import { libraryOf } from './rules.js';
import { icon, openDrawer, closeDrawer } from './ui.js';

const IMG_RE = /\.(webp|png|jpe?g|gif|svg)(\?.*)?$/i;
const GROUPS = [
  ['all', 'All'], ['monster', 'Monsters'], ['boss', 'Bosses'], ['npc', 'NPCs'], ['icon', 'Item icons'], ['fx', 'Effects & UI'], ['location', 'Places'],
];

const toUrl = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^(https?:\/\/|\/pack\/)/.test(s)) return s;
  if (s.startsWith('/')) return s;
  return `/pack/images/${s.split('/').map(encodeURIComponent).join('/')}`;
};
const prettyFile = (url) => decodeURIComponent(String(url).split('/').pop() || '')
  .replace(IMG_RE, '').replace(/^(icon|fx|fin|loot|system)_/, '').replace(/_/g, ' ');

/** [{ url, name, group }] — unique by URL; the first (most specific) name wins. */
export function collectArt(view) {
  const lib = libraryOf(view);
  const seen = new Map();
  const add = (url, name, group) => {
    const u = toUrl(url);
    if (!u || !IMG_RE.test(u) || seen.has(u)) return;
    seen.set(u, { url: u, name: name || prettyFile(u), group });
  };
  // GM art picks are listed by their own source, so list the pack's own picture of each entry
  for (const k of ['monster', 'boss', 'npc']) {
    for (const e of lib[k] || []) {
      const own = e.artPick ? e.packImage : e.image;
      if (k === 'boss' && e.imageSquare && !e.artPick) add(e.imageSquare, e.name, k);
      add(own, e.name, k);
    }
  }
  for (const it of lib.item || []) add(it.image, prettyFile(toUrl(it.image) || ''), 'icon');
  const walk = (v, depth) => {
    if (depth > 4 || v == null) return;
    if (typeof v === 'string') { if (IMG_RE.test(v) && !/_strip\./.test(v)) add(v, null, 'fx'); return; }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v === 'object') {
      if (typeof v.still === 'string') { add(v.still, null, 'fx'); return; } // animations: the still frame
      Object.values(v).forEach((x) => walk(x, depth + 1));
    }
  };
  walk(view?.pack?.ui, 0);
  for (const e of lib.location || []) add(e.image, e.name, 'location');
  return [...seen.values()];
}

/**
 * Opens the gallery. opts: { title, current, onPick(url|null), allowClear, clearLabel, extra } — onPick(null)
 * means "no art" (or "back to the pack's own" when clearLabel says so).
 */
export function openArtGallery(view, { title = 'Choose art', sub, current = null, onPick, allowClear = true, clearLabel = 'No art (silhouette)' } = {}) {
  const all = collectArt(view);
  const st = { group: all.some((a) => a.group === 'monster') ? 'monster' : 'all', q: '' };
  const grid = h('div.ag-grid', { role: 'listbox', 'aria-label': 'Pictures' });
  const count = h('span.dim.ag-count');
  const chips = h('div.chips.ag-chips');
  const pick = (url) => { closeDrawer(true); onPick?.(url); };
  const draw = () => {
    const q = st.q.trim().toLowerCase();
    const list = all.filter((a) => (st.group === 'all' || a.group === st.group) && (!q || `${a.name} ${a.url}`.toLowerCase().includes(q)));
    chips.replaceChildren(...GROUPS.filter(([id]) => id === 'all' || all.some((a) => a.group === id)).map(([id, label]) => h('button.chip', {
      type: 'button', 'aria-pressed': String(st.group === id), onclick: () => { st.group = id; draw(); },
    }, `${label} ${id === 'all' ? all.length : all.filter((a) => a.group === id).length}`)));
    count.textContent = `${list.length} shown`;
    grid.replaceChildren(...(list.length ? list.map((a) => h('button.ag-tile', {
      type: 'button', role: 'option', 'aria-selected': String(a.url === current), title: a.name, class: a.url === current ? 'ag-tile on' : 'ag-tile',
      onclick: () => pick(a.url),
    }, h('span.ag-img', h('img', { src: a.url, alt: '', loading: 'lazy', decoding: 'async', onerror: (e) => e.target.closest('.ag-tile')?.remove() })), h('span.ag-name', a.name))) : [h('p.empty-s', 'Nothing matches.')]));
  };
  const search = h('input.inp.inp-sm', { type: 'search', placeholder: 'Search pictures', 'aria-label': 'Search pictures', oninput: (e) => { st.q = e.target.value; draw(); } });
  const url = h('input.inp.inp-sm.mono-in', { placeholder: '/pack/images/… or https://…', 'aria-label': 'Picture URL', spellcheck: 'false' });
  const useUrl = () => { const u = toUrl(url.value); if (u) pick(u); };
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); useUrl(); } });
  draw();
  openDrawer({
    title, sub, wide: true,
    body: h('div.ag', h('div.ag-bar', search, count), chips, grid,
      h('div.ag-url', url, h('button.btn.btn-sm', { type: 'button', onclick: useUrl }, 'Use URL'))),
    actions: allowClear ? h('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => pick(null) }, icon('x', { size: 13 }), clearLabel) : null,
  });
  setTimeout(() => search.focus(), 0);
}
