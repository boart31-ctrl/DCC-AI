// Exploration: where the party is. Location card, optional backdrop, the running feed, party HP.
import { h, partyStrip } from './common.js';
import { uiOf, floorBg, assetSrc } from '../ui-art.js';

const GLYPH = { achievement: '✦', loot: '▣', sponsor: '$', stat: '±', 'boss.intro': '☠', 'boss.defeat': '✸', 'boss.phase': '▲', crawlers: '☠' };

export default function explore(root, sc, env) {
  const bg = h('div.ex-bg');
  let lastSlides = '';
  let cur = 0;
  let auto = 0;
  let flip = 0;
  /** Crossfade to a picture; each one drifts slowly (Ken Burns, off under reduced motion). */
  function show(want) {
    if (want === img) return;
    img = want;
    const old = [...bg.children];
    if (!img) { bg.classList.remove('on'); old.forEach((x) => x.remove()); return; }
    const i = h('img', { alt: '', decoding: 'async', class: `ex-slide kb-${flip++ % 4}` });
    i.onload = () => { bg.classList.add('on'); i.classList.add('in'); setTimeout(() => old.forEach((x) => x.remove()), 1600); };
    i.onerror = () => { i.remove(); if (!bg.children.length) bg.classList.remove('on'); };
    i.src = img;
    bg.append(i);
  }
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
    text.textContent = d.text || '';
    // The GM reads the text aloud; the TV shows it only when asked (showText). Without it the picture leads.
    const showText = !!d.text && d.showText === true;
    textBox.hidden = !showText;
    root.classList.toggle('ex-picture', !showText);
    textBox.classList.toggle('long', (d.text || '').length > 220 && (d.text || '').length <= 420);
    textBox.classList.toggle('xlong', (d.text || '').length > 420);
    loc.classList.toggle('long', loc.textContent.length > 18 || (showText && (d.text || '').length > 220));
    // Slides (location pictures): GM steps with `slide`, or the TV advances itself every `autoSlide` s.
    const slides = Array.isArray(d.slides) && d.slides.length ? d.slides : null;
    const slidesSig = slides ? `${slides.join('|')}#${d.slide || 0}#${d.autoSlide || 0}` : '';
    if (slidesSig !== lastSlides) {
      lastSlides = slidesSig;
      cur = Math.min(d.slide || 0, slides ? slides.length - 1 : 0);
      clearInterval(auto);
      auto = 0;
      if (slides && slides.length > 1 && d.autoSlide > 0) auto = setInterval(() => { cur = (cur + 1) % slides.length; show(slides[cur]); }, d.autoSlide * 1000);
    }
    show(slides ? slides[cur] || slides[0] : d.image || assetSrc(floorBg(uiOf(view), 'explore', String(d.floor || '').match(/-?\d+/)?.[0])) || '');
    feed.hidden = d.showFeed === false;
    const items = (view.feed || []).filter((e) => e.kind !== 'gift').slice(-5);
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
  return { update, destroy() { clearInterval(auto); } };
}
