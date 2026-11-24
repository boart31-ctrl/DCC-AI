// Big dice roll on the TV: a d20 tumbles with flickering faces, lands, then the total slams in.
// Nat 20: light rays + gold slam. Nat 1: the die cracks and the banner droops.
import { h, portraitTile, replay } from './common.js';
import { uiOf, uiAsset, artEl } from '../ui-art.js';

const D20 = `<svg viewBox="0 0 200 200" aria-hidden="true">
  <polygon class="f0" points="100,6 182,53 182,147 100,194 18,147 18,53"/>
  <polygon class="f1" points="100,48 150,136 50,136"/>
  <g class="edges"><polyline points="100,6 100,48 18,53"/><polyline points="100,48 182,53"/><polyline points="18,53 50,136 18,147"/><polyline points="182,53 150,136 182,147"/><polyline points="50,136 100,194 150,136"/></g>
  <g class="cracks"><polyline points="100,48 92,80 106,98 96,124"/><polyline points="150,136 132,120 138,104"/><polyline points="50,136 70,122 62,104"/></g>
</svg>`;

const CHECK_DEGREES = {
  crit: 'Critical success', amazing: 'Amazing success', success: 'Success', near: 'Near miss',
  fail: 'Failure', major: 'Major failure', critfail: 'Critical failure',
};

function scoredRoll(root, sc, env) {
  const heading = h('h1.rq-title.show-type');
  const dc = h('b');
  const target = h('div.rq-target', h('span', 'DC'), dc);
  const verdict = h('div.rq-verdict');
  const cards = h('div.rq-cards');
  root.classList.add('sc-check');
  root.append(h('header.rq-head', heading, target), cards, verdict);
  let shown = null;

  function update(scene, view) {
    const d = scene.data;
    heading.textContent = d.label || 'Skill check';
    // DCC: the Difficulty stays with the GM (hideDc); the TV shows who is rolling, then the degrees.
    target.hidden = d.dc == null;
    dc.textContent = d.dc ?? '';
    const check = d.check;
    if (!check) {
      root.classList.add('rq-waiting');
      shown = null;
      verdict.hidden = false;
      delete verdict.dataset.result;
      root.classList.toggle('rq-party', (d.people?.length ?? 0) > 1);
      if (d.cancelled) { cards.replaceChildren(); verdict.textContent = 'Called off'; return; }
      cards.replaceChildren(...(d.people ?? []).map((person, i) => {
        const p = view.players?.find((x) => x.id === person.playerId);
        return h('article.rq-card.rq-pending', { 'data-ready': String(!!person.ready), style: { '--pc': person.color || '#2ef2ff', '--delay': `${i * 55}ms` } },
          h('div.rq-player', portraitTile('rq-portrait', p, { name: person.name }), h('div', h('b.rq-name', person.name))),
          h('div.rq-number', h('b', person.ready ? '✓' : '…')),
          h('div.rq-result', h('b', person.ready ? 'Rolled' : person.phone ? 'Rolling on the phone' : 'Rolling')));
      }));
      verdict.textContent = d.people?.length ? (d.people.every((x) => x.ready) ? 'The System is judging…' : 'Roll your d20') : d.dc != null ? 'Roll to meet or beat the DC' : 'Roll your d20';
      return;
    }
    root.classList.remove('rq-waiting');
    if (shown === check.results[0]?.rollId) return;
    shown = check.results[0]?.rollId;
    root.classList.toggle('rq-party', !!check.verdict);
    root.classList.toggle('rq-many', check.results.length > 6);
    const animate = !env.reduced && env.clock.now() - (d.at || 0) < 8000;
    root.classList.toggle('rq-reveal', animate);
    cards.replaceChildren(...check.results.map((r, i) => {
      const p = view.players?.find((x) => x.id === r.playerId);
      const naturalNeeded = d.dc == null ? null : Math.max(2, d.dc - r.modifier);
      const needs = naturalNeeded == null ? '' : naturalNeeded >= 20 ? 'Needs natural 20' : `Needs ${naturalNeeded}+ on d20`;
      const netSuccess = r.shift ? r.shift === 'helped' : r.success;
      const arithmetic = `${r.natural} ${r.modifier < 0 ? '−' : '+'} ${Math.abs(r.modifier)}`;
      return h('article.rq-card', { 'data-result': netSuccess ? 'pass' : 'fail', 'data-degree': r.degree, style: { '--pc': r.color || '#2ef2ff', '--delay': `${520 + i * 55}ms` } },
        h('div.rq-player', portraitTile('rq-portrait', p, { name: r.name }), h('div', h('b.rq-name', r.name), needs ? h('small', needs) : null)),
        h('div.rq-number', h('b', String(r.total)), h('div', h('span', arithmetic), r.untrained ? h('small', r.otherDie == null ? 'Untrained' : `Untrained · other d20 ${r.otherDie}`) : null)),
        h('div.rq-result', h('b', CHECK_DEGREES[r.degree]), r.shift ? h('small', r.shift === 'helped' ? 'Team help → Success' : 'Team setback → Failure') : null));
    }));
    const v = check.verdict;
    verdict.hidden = !v;
    if (v) {
      verdict.dataset.result = v.success ? 'pass' : 'fail';
      verdict.style.setProperty('--delay', `${800 + check.results.length * 55}ms`);
      verdict.replaceChildren(h('b.show-type', v.success ? 'Party succeeds' : 'Party fails'), h('span', `${v.passed}/${check.results.length} passed · needed ${v.required}`));
    }
  }
  update(sc, env.view);
  return { update };
}

export default function roll(root, sc, env) {
  if (sc.data?.dc != null || sc.data?.scored) return scoredRoll(root, sc, env);
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

  // Die body art (ui.json dice.<dN>.body, nat20 / nat1 skins on landing) replaces the SVG; numbers stay text.
  let dieSig = null;
  function dieArt(d, skin) {
    const n = `d${sidesOf(d)}`;
    const ui = uiOf(env.view);
    const a = (skin && uiAsset(ui, 'dice', [n], [skin])) || uiAsset(ui, 'dice', [n], ['body']);
    const sig = a?.src || '';
    if (sig === dieSig) return;
    dieSig = sig;
    const svg = die.querySelector('svg');
    die.querySelector('.rl-die-art')?.remove();
    die.classList.toggle('has-art', !!a);
    if (svg) svg.style.display = a ? 'none' : '';
    if (a) die.prepend(artEl(a, { cls: 'rl-die-art', still: true, onError: () => { die.classList.remove('has-art'); if (svg) svg.style.display = ''; } }));
  }

  function finalState(d) {
    dieArt(d, d.nat20 ? 'nat20' : d.nat1 ? 'nat1' : null);
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
    dieArt(d, null);
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
