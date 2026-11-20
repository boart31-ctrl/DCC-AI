// Map with fog of war (server/maps.js): the revealed part of the map, revealed zone names, tokens when the
// token layer is on. Content comes from view.maps (the TV only ever receives the map on air, without notes).
import { h } from './common.js';
import { createMapView } from '../map-view.js';

export default function map(root, sc, env) {
  const mv = createMapView({ fit: true });
  const title = h('h1.mp-title');
  const empty = h('p.mp-empty', 'The map is being drawn.');
  root.append(h('div.mp-wrap', title, mv.el, empty));
  function update(s, view) {
    const m = (view.maps || []).find((x) => x.id === s.data?.mapId) || null;
    title.textContent = m?.name || '';
    empty.hidden = !!m;
    mv.set(m, { labels: true });
  }
  update(sc, env.view);
  return { update, destroy: mv.destroy };
}
