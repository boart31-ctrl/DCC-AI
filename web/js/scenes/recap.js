// "Previously on…": a perspective text crawl. One transform animation, length-scaled duration.
import { h } from './common.js';

export default function recap(root, sc, env) {
  const title = h('h1.rc-title');
  const crawl = h('div.rc-crawl');
  const plane = h('div.rc-plane', crawl);
  root.append(h('div.rc-head', h('p.rc-kicker', 'Previously on'), title), h('div.rc-view', plane));
  let text = null;
  function update(s, view) {
    const d = s.data || {};
    title.textContent = d.title || view.pack?.systemName || 'The System';
    const t = (d.text || view.recap || '').trim();
    if (t === text) return;
    text = t;
    crawl.replaceChildren(...(t ? t.split(/\n\s*\n|\n/).filter(Boolean).map((p) => h('p', p)) : [h('p.rc-empty', 'Nothing happened. Suspicious.')]));
    const words = t.split(/\s+/).length;
    // ~2.6 words/s reading speed at 3 m, at least 25 s, at most 4 min.
    const dur = Math.max(25, Math.min(240, words / 2.6 + 10));
    crawl.style.animationDuration = `${dur}s`;
    crawl.classList.remove('go'); void crawl.offsetWidth;
    if (!env.reduced) crawl.classList.add('go');
  }
  update(sc, env.view);
  return { update };
}
