// Exploration: where the party is. Location card, optional backdrop, the running feed, party HP.
import { h, partyStrip } from './common.js';

const GLYPH = { achievement: '✦', loot: '▣', sponsor: '$', stat: '±', 'boss.intro': '☠', 'boss.defeat': '✸', 'boss.phase': '▲' };

export default function explore(root, sc, env) {
  const bg = h('div.ex-bg');
  const floor = h('p.ex-floor');
  const loc = h('h1.ex-loc');
  const text = h('p.ex-text');
  const textBox = h('div.ex-box', h('span.ex-box-head', 'Location data'), text);
  const feed = h('ol.ex-feed');
  const party = partyStrip();
  root.append(bg,
    h('div.ex-body',
      h('div.ex-card', floor, loc, textBox),
      feed),
    h('div.sc-party', party.el));
  let img = '';
  let feedSig = '';
  function update(s, view) {
    const d = s.data || {};
    floor.textContent = d.floor || '';
    floor.hidden = !d.floor;
    loc.textContent = d.location || 'Somewhere below';
    loc.classList.toggle('long', loc.textContent.length > 18);
    text.textContent = d.text || '';
    textBox.hidden = !d.text;
    if ((d.image || '') !== img) {
      img = d.image || '';
      bg.replaceChildren();
      bg.classList.remove('on');
      if (img) {
        const i = h('img', { alt: '', decoding: 'async' });
        i.onload = () => bg.classList.add('on');
        i.onerror = () => { i.remove(); bg.classList.remove('on'); };
        i.src = img;
        bg.append(i);
      }
    }
    feed.hidden = d.showFeed === false;
    const items = (view.feed || []).slice(-5);
    const sig = items.map((e) => e.id).join();
    if (sig !== feedSig) {
      const known = new Set(feedSig.split(','));
      feedSig = sig;
      feed.replaceChildren(...items.map((e) => h('li', { class: `k-${String(e.kind).replace('.', '-')}${known.has(e.id) ? ' old' : ''}` },
        h('span.g', { 'aria-hidden': 'true' }, GLYPH[e.kind] || '◆'), h('span', e.text || e.kind))));
    }
    party.update(view);
  }
  update(sc, env.view);
  return { update };
}
