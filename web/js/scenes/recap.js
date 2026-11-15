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
    // ~2.6 words/s reading speed at 3 m, at least 25 s, at most 4 min. The crawl travels from the
    // bottom of the view until its last line has left the top (distance measured, not guessed).
    const dur = Math.max(25, Math.min(240, words / 2.6 + 8));
    crawl.classList.remove('go');
    if (env.reduced) return;
    requestAnimationFrame(() => {
      // Starts below the bottom edge (the first line comes up first) and runs until the last line has
      // left the top. Speed = the old crawl's minus 25 % (it was too quick to read on the TV).
      const oldDist = plane.clientHeight * 0.62 + crawl.offsetHeight;
      const dist = plane.clientHeight + crawl.offsetHeight;
      crawl.style.setProperty('--dist', `${-dist}px`);
      crawl.style.animationDuration = `${(dur * (dist / oldDist)) / 0.75}s`;
      void crawl.offsetWidth;
      crawl.classList.add('go');
    });
  }
  update(sc, env.view);
  return { update };
}
