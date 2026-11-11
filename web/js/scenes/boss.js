// Boss battle — the big one. States: pre-reveal (silhouette, "threat detected"), intro cinematic,
// fight (segmented HP bar, art, phase), phase change, defeat (shatter → BOSS DEFEATED → loot hint).
// Everything animates with transform/opacity; the only per-frame work is CSS.
import { h, bossArt, partyStrip, threatColor, rgb, replay, typeText } from './common.js';
import { floorLayer } from '../ui-art.js';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

export default function boss(root, sc, env) {
  const { T } = env;
  let d = sc.data;
  let b = d.boss || { name: 'Unknown', hpSlots: 10, phases: [] };
  let artUrl = '';
  let hpShown = d.hp;
  let busy = false; // intro / defeat sequence running

  /* ---------- fight layout ---------- */
  const name = h('h1.bs-name');
  const title = h('p.bs-title');
  const phaseNo = h('span.bs-phase-no');
  const phaseName = h('b.bs-phase-name');
  const phase = h('div.bs-phase', phaseNo, phaseName);
  const segs = h('div.bs-segs');
  const hpNum = h('div.bs-hpnum');
  const hp = h('div.bs-hp', segs, hpNum);
  const phaseText = h('p.bs-ptext');
  const flavor = h('p.bs-flavor');
  const info = h('div.bs-info', h('div.bs-sys', h('span.bs-sys-head'), phaseText), flavor);
  const flash = h('div.bs-flash');
  const dmg = h('div.bs-dmg');
  const stamp = h('div.bs-stamp', h('span', 'Defeated'));
  const loot = h('div.bs-loot');
  // The art on screen follows the fight: the current phase's portrait (bosses.json phases[].image), the
  // defeated pose (imageKo) once it is down, else the splash.
  // The frame is portrait-shaped: the square crop beats a centre-cropped 16:9 splash.
  const fit = (x) => ({ ...x, image: x.imageSquare || x.image });
  const shown = () => ({ ...b, image: (d.defeated && b.imageKo) || b.phases?.[d.phase]?.image || b.imageSquare || b.image });
  let artKey = shown().image;
  let art = bossArt(shown(), { onUrl: (u) => { artUrl = u; } });
  const frame = h('div.bs-frame', art, flash, h('i.c1'), h('i.c2'), h('i.c3'), h('i.c4'), stamp);
  const party = partyStrip();
  // Fighting-game layout: name, HP and the System's phase report on the left, a tall portrait
  // on the right, the party under the report.
  const fight = h('div.bs-fight',
    h('div.bs-head', h('div.bs-namebox', name, title), phase),
    hp,
    h('div.bs-mid', info, loot),
    h('div.bs-party', party.el),
    h('div.bs-framewrap', frame, dmg),
  );

  /* ---------- pre-reveal ---------- */
  let preArt = bossArt(fit(b), { lit: false });
  const pre = h('div.bs-pre',
    h('div.hz.hz-top'), h('div.hz.hz-bot'),
    h('p.bs-pre-k', b.floor ? `Threat detected // Floor ${b.floor}` : 'Threat detected'),
    h('div.bs-pre-fig', preArt),
    h('p.bs-pre-name', '? ? ? ? ?'),
  );

  const floorBg = floorLayer('boss');
  root.prepend(floorBg.el);
  floorBg.update(env.view, b.floor);
  root.append(pre, fight);

  function setColors() {
    const c = threatColor(b);
    root.style.setProperty('--th', c);
    root.style.setProperty('--th-rgb', rgb(c));
  }

  function drawSegs(n, cur) {
    const max = b.hpSlots;
    segs.style.setProperty('--n', String(max));
    segs.classList.toggle('dense', max > 24);
    if (segs.children.length !== max) segs.replaceChildren(...Array.from({ length: max }, () => h('i')));
    [...segs.children].forEach((s, i) => {
      const want = i < cur ? 'on' : 'gone';
      // Let a running break / heal animation finish (the view lands ~50 ms after the event).
      if ((s.className === 'break' && want === 'gone') || (s.className === 'heal' && want === 'on')) return;
      s.className = want;
    });
    hpNum.replaceChildren(h('b', String(cur)), h('span', ` / ${max}`));
    root.classList.toggle('low', cur > 0 && cur / max <= 0.25);
  }

  function drawPhase() {
    const n = b.phases.length;
    const ph = b.phases[d.phase] || null;
    phase.hidden = !ph;
    if (ph) {
      phaseNo.textContent = `Phase ${ROMAN[d.phase] || d.phase + 1}${n > 1 ? ` of ${ROMAN[n - 1] || n}` : ''}`;
      phaseName.textContent = ph.name;
    }
    phaseText.textContent = ph?.text || b.title || '';
    // Pack phase texts can be long: size the report down and drop the flavor line before overflowing.
    const n2 = phaseText.textContent.length;
    phaseText.classList.toggle('long', n2 > 110 && n2 <= 200);
    phaseText.classList.toggle('xlong', n2 > 200);
    root.classList.toggle('wordy', n2 > 110);
    info.querySelector('.bs-sys-head').textContent = `${(env.view.pack?.systemName || 'The System').toUpperCase()} // ${ph ? 'Phase report' : 'Threat report'}`;
  }

  function lootText() {
    const tier = d.lootTierInfo;
    return d.lootHint || (tier ? `${tier.name} incoming` : 'Loot incoming');
  }

  function drawStatic() {
    setColors();
    name.textContent = b.name;
    name.classList.toggle('long', b.name.length > 11 && b.name.length <= 20);
    name.classList.toggle('xlong', b.name.length > 20);
    title.textContent = b.title || '';
    title.hidden = !b.title;
    flavor.textContent = b.flavor || '';
    flavor.hidden = !b.flavor;
    drawPhase();
    drawSegs(b.hpSlots, d.hp);
    hpShown = d.hp;
    loot.replaceChildren(h('span.bs-loot-k', 'Loot'), h('span', lootText()));
    root.classList.toggle('pre', !d.revealed);
    root.classList.toggle('dead', !!d.defeated);
  }

  function swapArt() {
    artKey = shown().image;
    const na = bossArt(shown(), { onUrl: (u) => { artUrl = u; } });
    art.replaceWith(na);
    art = na;
    const np = bossArt(fit(b), { lit: false });
    preArt.replaceWith(np);
    preArt = np;
  }

  /* ---------- effects ---------- */

  function popNumber(text, cls) {
    const n = h('b', { class: cls }, text);
    dmg.append(n);
    T.after(1400, () => n.remove());
    while (dmg.children.length > 4) dmg.firstChild.remove();
  }

  function onHit(e) {
    const from = Math.min(e.from, b.hpSlots);
    const to = e.hp;
    d = { ...d, hp: to };
    hpShown = to;
    const kids = [...segs.children];
    for (let i = to; i < from && i < kids.length; i++) {
      const s = kids[i];
      s.className = 'break';
      s.style.setProperty('--k', String(i - to));
      T.after(700, () => { if (s.className === 'break') s.className = 'gone'; });
    }
    hpNum.replaceChildren(h('b', String(to)), h('span', ` / ${b.hpSlots}`));
    root.classList.toggle('low', to > 0 && to / b.hpSlots <= 0.25);
    if (env.reduced) return;
    replay(flash, 'go');
    replay(frame, 'hit');
    replay(hp, 'hit');
    popNumber(`−${e.amount}`, 'dmg');
  }

  function onHeal(e) {
    const kids = [...segs.children];
    for (let i = e.from; i < e.hp && i < kids.length; i++) { kids[i].className = 'heal'; }
    d = { ...d, hp: e.hp };
    hpShown = e.hp;
    hpNum.replaceChildren(h('b', String(e.hp)), h('span', ` / ${b.hpSlots}`));
    root.classList.toggle('low', e.hp > 0 && e.hp / b.hpSlots <= 0.25);
    root.classList.remove('dead');
    if (!env.reduced) popNumber(`+${e.amount}`, 'heal');
  }

  function onPhase(e) {
    d = { ...d, phase: e.index };
    drawPhase();
    if (shown().image !== artKey) swapArt();
    if (env.reduced) return;
    const fx = h('div.bp',
      h('div.bp-flash'),
      h('div.bp-band', h('span', `Phase ${ROMAN[e.index] || e.index + 1}`)),
      h('p.bp-name', e.name || ''),
      e.text ? h('p.bp-text', e.text) : null,
    );
    root.append(fx);
    replay(phase, 'slam');
    replay(fight, 'quake');
    T.after(3800, () => fx.remove());
  }

  function intro() {
    busy = true;
    root.classList.remove('pre');
    root.classList.add('intro');
    document.body.classList.add('cine');
    const sys = (env.view.pack?.systemName || 'The System').toUpperCase();
    const marq = 'Boss encounter ◆ Boss encounter ◆ Boss encounter ◆ Boss encounter ◆ Boss encounter ◆ Boss encounter ◆ ';
    const typed = h('span');
    const fx = h('div.bi',
      h('div.bi-band.top', h('div.bi-marq', h('span', marq), h('span', marq))),
      h('div.bi-band.bot', h('div.bi-marq', h('span', marq), h('span', marq))),
      h('p.bi-warn', 'Warning'),
      h('div.bi-fig', h('div.bi-sil', bossArt(fit(b), { lit: false })), h('div.bi-lit', bossArt(fit(b)))),
      h('div.bi-flash'),
      h('div.bi-card',
        h('p.bi-name', b.name),
        h('p.bi-title', h('span.bi-sys', `${sys} // `), typed)),
    );
    fx.querySelector('.bi-name').classList.toggle('long', b.name.length > 16);
    root.append(fx);
    T.after(3700, () => typeText(typed, b.title || 'Threat level: yes.', 900, T));
    T.after(6400, () => {
      fx.classList.add('out');
      document.body.classList.remove('cine');
      root.classList.remove('intro');
      busy = false;
      drawStatic();
      replay(fight, 'enter');
    });
    T.after(7000, () => fx.remove());
  }

  /** Triangle fan from an impact point: 12 shards that fly out from the frame. */
  function shatter() {
    const n = 12;
    const cx = 46;
    const cy = 42;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.2;
      const x = Math.max(0, Math.min(100, cx + Math.cos(a) * 140));
      const y = Math.max(0, Math.min(100, cy + Math.sin(a) * 140));
      pts.push([x, y]);
    }
    const wrap = h('div.bd-shards');
    const url = artUrl ? `url("${artUrl.replace(/"/g, '%22')}")` : 'none';
    for (let i = 0; i < n; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % n];
      const mx = (cx + x1 + x2) / 3 - cx;
      const my = (cy + y1 + y2) / 3 - cy;
      const len = Math.hypot(mx, my) || 1;
      const s = h('i', {
        style: {
          clipPath: `polygon(${cx}% ${cy}%, ${x1}% ${y1}%, ${x2}% ${y2}%)`,
          webkitClipPath: `polygon(${cx}% ${cy}%, ${x1}% ${y1}%, ${x2}% ${y2}%)`,
          backgroundImage: url,
          '--dx': `${(mx / len) * (60 + (i % 3) * 25)}vmin`,
          '--dy': `${(my / len) * (60 + (i % 4) * 18) + 20}vmin`,
          '--r': `${(i % 2 ? 1 : -1) * (40 + i * 23)}deg`,
          animationDelay: `${(i % 4) * 30}ms`,
        },
      });
      wrap.append(s);
    }
    return wrap;
  }

  function defeat(e) {
    busy = true;
    d = { ...d, defeated: true, hp: 0, lootHint: e?.lootHint || d.lootHint };
    drawSegs(b.hpSlots, 0);
    loot.replaceChildren(h('span.bs-loot-k', 'Loot'), h('span', e?.lootHint || lootText()));
    if (env.reduced) { root.classList.add('dead'); busy = false; return; }
    // Shards sit exactly over the frame, then fly.
    const shards = shatter();
    frame.append(shards);
    root.classList.add('dying', 'defeating');
    replay(fight, 'quake');
    const fx = h('div.bd',
      h('div.bd-flash'),
      h('div.bd-ring'),
      h('div.bd-band', h('span', 'Boss defeated')),
      h('p.bd-name', b.name),
      h('div.bd-loot', h('span.bs-loot-k', 'Loot'), h('span', e?.lootHint || lootText())),
    );
    root.append(fx);
    T.after(1300, () => { root.classList.remove('dying'); root.classList.add('dead'); shards.remove(); if (shown().image !== artKey) swapArt(); });
    T.after(7600, () => fx.classList.add('out'));
    T.after(8200, () => { fx.remove(); busy = false; root.classList.remove('defeating'); drawStatic(); });
  }

  /* ---------- wiring ---------- */

  function update(s) {
    const nd = s.data || {};
    const swapped = JSON.stringify(nd.boss) !== JSON.stringify(b);
    d = nd;
    b = nd.boss || b;
    floorBg.update(env.view, b.floor);
    if (swapped || (!busy && shown().image !== artKey)) swapArt();
    if (busy) {
      // A sequence is running: keep text fresh, let the sequence finish the visual state.
      name.textContent = b.name;
      drawPhase();
      return;
    }
    drawStatic();
  }

  function event(e) {
    if (e.kind === 'boss.intro') { if (!env.reduced) intro(); else { root.classList.remove('pre'); } }
    else if (e.kind === 'boss.hit') onHit(e);
    else if (e.kind === 'boss.heal') onHeal(e);
    else if (e.kind === 'boss.phase') onPhase(e);
    else if (e.kind === 'boss.defeat') defeat(e);
  }

  drawStatic();
  party.update(env.view);
  const baseUpdate = update;
  return {
    update(s, view) { baseUpdate(s, view); party.update(view); },
    event,
    destroy() { document.body.classList.remove('cine'); },
    get hp() { return hpShown; },
  };
}
