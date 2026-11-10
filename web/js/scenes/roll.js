// Big dice roll on the TV: a d20 tumbles with flickering faces, lands, then the total slams in.
// Nat 20: light rays + gold slam. Nat 1: the die cracks and the banner droops.
import { h, replay } from './common.js';

const D20 = `<svg viewBox="0 0 200 200" aria-hidden="true">
  <polygon class="f0" points="100,6 182,53 182,147 100,194 18,147 18,53"/>
  <polygon class="f1" points="100,48 150,136 50,136"/>
  <g class="edges"><polyline points="100,6 100,48 18,53"/><polyline points="100,48 182,53"/><polyline points="18,53 50,136 18,147"/><polyline points="182,53 150,136 182,147"/><polyline points="50,136 100,194 150,136"/></g>
  <g class="cracks"><polyline points="100,48 92,80 106,98 96,124"/><polyline points="150,136 132,120 138,104"/><polyline points="50,136 70,122 62,104"/></g>
</svg>`;

export default function roll(root, sc, env) {
  const who = h('div.rl-who');
  const label = h('p.rl-label');
  const face = h('b.rl-face');
  const die = h('div.rl-die', { html: D20 }, face);
  const dieWrap = h('div.rl-diewrap', h('div.rl-rays', { 'aria-hidden': 'true' }), die);
  const total = h('div.rl-total');
  const parts = h('p.rl-parts');
  const banner = h('div.rl-banner', { hidden: true });
  const chips = h('div.rl-chips');
  root.append(h('div.rl-top', who, label), h('div.rl-mid', dieWrap, h('div.rl-res', total, parts, chips)), banner);
  let shownId = null;

  function sidesOf(d) { const x = d.dice?.[0]?.die; return x ? Number(String(x).replace('d', '')) || 20 : 20; }
  function mainDie(d) { return d.dice?.find((x) => x.die === 'd20') || d.dice?.[0] || null; }

  function finalState(d) {
    const md = mainDie(d);
    face.textContent = md ? String(md.value) : String(d.total ?? '?');
    total.textContent = String(d.total);
    const bonus = (d.total ?? 0) - (d.dice || []).reduce((s, x) => s + (Number(x.value) || 0), 0);
    parts.textContent = d.formula ? `${d.formula}${(d.dice || []).length ? `  →  ${(d.dice || []).map((x) => x.value).join(' + ')}${bonus ? ` ${bonus > 0 ? '+' : '−'} ${Math.abs(bonus)}` : ''}` : ''}` : '';
    chips.replaceChildren(...((d.dice || []).length > 1 ? d.dice.map((x) => h('span', { class: x.die === 'd20' && (x.value === 20 || x.value === 1) ? 'hot' : '' }, h('small', x.die), String(x.value))) : []));
    root.classList.toggle('nat20', !!d.nat20);
    root.classList.toggle('nat1', !!d.nat1);
    banner.hidden = !(d.nat20 || d.nat1);
    banner.textContent = d.nat20 ? 'Natural 20' : d.nat1 ? 'Natural 1' : '';
  }

  function play(d) {
    root.classList.remove('landed', 'nat20', 'nat1');
    root.classList.add('tumbling');
    banner.hidden = true;
    total.textContent = '';
    parts.textContent = '';
    chips.replaceChildren();
    const sides = sidesOf(d);
    const flick = env.T.every(70, () => { face.textContent = String(1 + Math.floor(Math.random() * sides)); });
    env.T.after(1900, () => {
      env.T.stop(flick);
      root.classList.remove('tumbling');
      root.classList.add('landed');
      finalState(d);
      replay(total, 'slam');
      if (d.nat20 || d.nat1) env.T.after(350, () => replay(banner, 'slam'));
    });
  }

  function update(s, view) {
    const d = s.data || {};
    const p = view.players?.find((x) => x.id === d.playerId);
    who.textContent = d.name || p?.name || 'The GM';
    who.style.setProperty('--pc', d.color || p?.color || '#2ef2ff');
    label.textContent = d.label && d.label !== d.formula ? d.label : 'rolls the dice';
    if (d.total == null) {
      root.classList.add('idle');
      face.textContent = '?';
      total.textContent = '';
      parts.textContent = 'Waiting for the roll';
      return;
    }
    root.classList.remove('idle');
    if (d.rollId === shownId) return;
    shownId = d.rollId;
    const age = env.clock.now() - (d.at || 0);
    if (env.reduced || age > 8000) { root.classList.add('landed'); finalState(d); } else play(d);
  }
  update(sc, env.view);
  return { update };
}
