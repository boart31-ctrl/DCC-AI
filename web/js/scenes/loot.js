// Loot: a box on a pedestal waiting for its crawler. Opening it (loot.open) plays the existing
// full-screen reveal on top; this scene then shows the last thing that came out of it.
import { h, itemArt, rarityOf } from '../client.js';
import { uiOf, uiAsset, artEl, cornerFrame } from '../ui-art.js';

export default function loot(root, sc, env) {
  const name = h('div.lt-name');
  const tier = h('p.lt-tier');
  const cssBox = h('div.lt-box', h('div.body'), h('div.lid'));
  let box = cssBox;
  let crateSig = null;
  const ped = h('div.lt-ped', box, h('div.lt-glow'));
  const last = h('div.lt-last');
  const wait = h('p.lt-wait', 'Box ready. Waiting for the GM.');
  root.append(h('div.lt-wrap', h('div.lt-top', name, tier), ped, wait, last));
  let opened = null;
  let lastS = sc;
  let lastV = env.view;
  function update(s, view) {
    lastS = s;
    lastV = view;
    const d = s.data || {};
    const p = view.players?.find((x) => x.id === d.playerId);
    const t = d.tierInfo || view.pack?.lootTiers?.find((x) => x.id === d.tier) || view.pack?.lootTiers?.[0];
    root.style.setProperty('--t', t?.color || '#e4ff2e');
    name.textContent = p?.name || 'A lucky crawler';
    name.style.setProperty('--pc', p?.color || '#2ef2ff');
    tier.textContent = t ? `has earned a ${t.name}` : 'has earned a loot box';
    root.classList.toggle('opened', !!opened);
    // Tier crate art (ui.json lootBoxes): the idle rattle / closed crate, the open one after loot.open.
    const keys = [t?.id, 'default'].filter(Boolean);
    const a = uiAsset(uiOf(view), 'lootBoxes', keys, opened ? ['open', 'closed'] : ['idle', 'closed']);
    const sig = a ? a.src : '';
    if (sig !== crateSig) {
      crateSig = sig;
      const next = a ? h('div.lt-box.lt-box-art', artEl(a, { cls: 'box-img', onError: () => { next.replaceWith(cssBox); box = cssBox; } })) : cssBox;
      if (next !== box) { box.replaceWith(next); box = next; }
    }
  }
  function event(e) {
    if ((e.kind === 'loot' || e.kind === 'sponsor') && e.item) {
      opened = e.item;
      const r = rarityOf(e.item.rarity);
      const fr = cornerFrame(uiAsset(uiOf(lastV), 'rarityFrames', [r]), 'ua-frame lt-frame');
      last.replaceChildren(h('span.lt-last-k', 'Inside'), h('div.lt-art', itemArt(e.item), fr), h('b', { class: `r-${r}` }, e.item.name || 'Something'));
      root.classList.add('opened');
      wait.textContent = 'Opened.';
      update(lastS, lastV);
    }
  }
  update(sc, env.view);
  return { update, event };
}
