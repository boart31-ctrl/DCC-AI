import { h } from './common.js';

// Cycle through every crawler so a large party remains legible from the table.
export default function builds(root, scene) {
  const title = h('h1', 'Build analysis');
  const card = h('article');
  root.append(h('section.build-analysis', title, card));
  let rows = [];
  let index = 0;
  function draw() {
    if (!rows.length) { card.replaceChildren(h('p', 'No crawlers yet.')); return; }
    const row = rows[index % rows.length];
    card.replaceChildren(h('p', `${index % rows.length + 1} / ${rows.length}`), h('h2', row.name),
      h('strong', `${row.grade} · ${row.score}/100`), h('p', row.builds.join(' · ') || 'Build undecided'),
      ...row.items.map((it) => h('div', `${it.grade} · ${it.name}`)));
  }
  function update(s) { rows = s.data.crawlers ?? []; draw(); }
  update(scene);
  const timer = setInterval(() => { index++; draw(); }, 8500);
  return { update, destroy() { clearInterval(timer); } };
}
