// Loot: a box on a pedestal waiting for its crawler. Opening it (loot.open) plays the existing
// full-screen reveal on top; this scene then shows the last thing that came out of it.
import { h, itemArt, rarityOf } from '../client.js';

export default function loot(root, sc, env) {
  const name = h('div.lt-name');
  const tier = h('p.lt-tier');
  const box = h('div.lt-box', h('div.body'), h('div.lid'));
  const ped = h('div.lt-ped', box, h('div.lt-glow'));
  const last = h('div.lt-last');
  const wait = h('p.lt-wait', 'Box ready. Waiting for the GM.');
  root.append(h('div.lt-wrap', h('div.lt-top', name, tier), ped, wait, last));
  let opened = null;
  function update(s, view) {
    const d = s.data || {};
    const p = view.players?.find((x) => x.id === d.playerId);
    const t = d.tierInfo || view.pack?.lootTiers?.find((x) => x.id === d.tier) || view.pack?.lootTiers?.[0];
    root.style.setProperty('--t', t?.color || '#e4ff2e');
    name.textContent = p?.name || 'A lucky crawler';
    name.style.setProperty('--pc', p?.color || '#2ef2ff');
    tier.textContent = t ? `has earned a ${t.name}` : 'has earned a loot box';
    root.classList.toggle('opened', !!opened);
  }
  function event(e) {
    if ((e.kind === 'loot' || e.kind === 'sponsor') && e.item) {
      opened = e.item;
      const r = rarityOf(e.item.rarity);
      last.replaceChildren(h('span.lt-last-k', 'Inside'), itemArt(e.item), h('b', { class: `r-${r}` }, e.item.name || 'Something'));
      root.classList.add('opened');
      wait.textContent = 'Opened.';
    }
  }
  update(sc, env.view);
  return { update, event };
}
