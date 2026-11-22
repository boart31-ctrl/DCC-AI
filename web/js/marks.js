// HUD marks next to a crawler's name (server/marks.js): ☠ skulls (crawlers killed), gold ☠ (leaderboard crawlers),
// ★ stars (bosses). Public, like the HUD in the books.
import { h } from './client.js';

export function marksEl(m, { cls = '' } = {}) {
  if (!m || !(m.skulls || m.goldSkulls || m.stars)) return null;
  const n = (k, sym, title, extra) => (m[k] ? h('span', { class: `mk mk-${extra}`, title: `${m[k]} ${title}` }, m[k] > 3 ? `${sym}×${m[k]}` : sym.repeat(m[k])) : null);
  return h('span.marks', { class: `marks ${cls}`.trim(), 'aria-label': marksText(m) },
    n('goldSkulls', '☠', `leaderboard crawler${m.goldSkulls === 1 ? '' : 's'} killed (gold skull)`, 'gold'),
    n('skulls', '☠', `crawler${m.skulls === 1 ? '' : 's'} killed (Player Killer)`, 'skull'),
    n('stars', '★', `boss${m.stars === 1 ? '' : 'es'} killed`, 'star'));
}

export function marksText(m) {
  if (!m) return '';
  return [m.goldSkulls ? `${m.goldSkulls} gold skull${m.goldSkulls === 1 ? '' : 's'}` : '', m.skulls ? `${m.skulls} skull${m.skulls === 1 ? '' : 's'}` : '',
    m.stars ? `${m.stars} star${m.stars === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
}
