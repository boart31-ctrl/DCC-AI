// Arena: the party vs the revealed mobs. Round / phase banner on top, crawlers on the left, hostiles
// on the right, a neon VS slash between them. Content comes from view.combat (already filtered per
// role by the engine: hidden mobs, notes and attacks never reach the TV; mob HP is a bar unless the
// GM turned on exact numbers). Hits flash the card and pop the damage.
import { h, hash, threatColor, rgb, replay, bossSvg } from './common.js';

const MAX_PIPS = 20;

export default function combat(root, sc, env) {
  const { T } = env;
  const title = h('p.ar-title');
  const round = h('div.ar-round', h('small', 'Round'), h('b', '1'));
  const phases = h('ol.ar-phases');
  const status = h('p.ar-status');
  const party = h('div.ar-party');
  const foes = h('div.ar-foes');
  const foesEmpty = h('div.ar-empty', h('i.ar-scan'), h('p', 'Scanning for hostiles'));
  root.append(
    h('div.ar-bg', h('i.ar-grid'), h('i.ar-glow-l'), h('i.ar-glow-r')),
    h('header.ar-head', h('div.ar-banner', title, round, h('div.ar-phasebox', phases, status))),
    h('div.ar-board',
      h('section.ar-side.ar-side-l', h('h2.ar-label', h('span', 'Crawlers')), party),
      h('div.ar-vs', { 'aria-hidden': 'true' }, h('i'), h('b', 'VS'), h('i')),
      h('section.ar-side.ar-side-r', h('h2.ar-label', h('span', 'Hostiles')), foes, foesEmpty)),
  );

  const cards = new Map(); // uid → { el, sig }
  let lastRound = null;
  let lastPhase = null;
  let view = env.view;

  function pips(cur, max, cls) {
    const n = Math.max(0, Math.min(MAX_PIPS, max));
    if (max > MAX_PIPS || !n) return h('div', { class: `ar-bar ${cls}` }, h('i', { style: { transform: `scaleX(${max ? Math.max(0, cur) / max : 0})` } }));
    return h('div', { class: `ar-pips ${cls}`, style: { '--n': String(n) } }, Array.from({ length: n }, (_, i) => h('i', { class: i < cur ? 'on' : '' })));
  }

  function conds(list) {
    return list?.length ? h('div.ar-conds', list.slice(0, 5).map((k) => h('span', k.name)), list.length > 5 ? h('span', `+${list.length - 5}`) : null) : null;
  }

  function crawlerCard(x) {
    const p = (view?.players || []).find((y) => y.id === x.playerId);
    const low = x.hpMax > 0 && x.hp / x.hpMax <= 0.3;
    return h('article.ar-card.ar-crawler', { class: `ar-card ar-crawler${x.down ? ' down' : ''}${low && !x.down ? ' low' : ''}`, style: { '--pc': x.color || p?.color || '#2ef2ff' } },
      h('div.ar-lvl', h('small', 'Lv'), h('b', String(p?.level ?? 1))),
      h('div.ar-main',
        h('div.ar-name', x.name),
        h('div.ar-hp', pips(x.hp, x.hpMax, 'crawl'), h('b.ar-num', `${x.hp}`)),
        conds(x.conditions)),
      x.down ? h('div.ar-down', 'Down') : null,
      h('i.ar-flash'));
  }

  function foeArt(x) {
    const wrap = h('div.ar-art');
    const gen = () => { wrap.classList.add('gen'); wrap.innerHTML = bossSvg({ name: x.name.replace(/\s+\d+$/, '') }, { lit: !x.down }); };
    if (x.image) {
      const img = h('img', { alt: '', decoding: 'async' });
      img.onerror = () => { img.remove(); gen(); };
      img.src = x.image;
      wrap.append(img);
    } else gen();
    return wrap;
  }

  function foeCard(x) {
    const c = threatColor({ name: x.name.replace(/\s+\d+$/, '') });
    const pct = Math.max(0, Math.min(1, x.hpPct ?? (x.hpMax ? x.hp / x.hpMax : 0)));
    const exact = Number.isFinite(x.hp) && Number.isFinite(x.hpMax);
    const bar = exact && x.hpMax <= MAX_PIPS ? pips(x.hp, x.hpMax, 'foe') : h('div.ar-bar.foe', h('i', { style: { transform: `scaleX(${pct})` } }));
    return h('article.ar-card.ar-foe', {
      class: `ar-card ar-foe${x.down ? ' down' : ''}${x.boss ? ' boss' : ''}${pct > 0 && pct <= 0.3 ? ' low' : ''}`,
      style: { '--th': c, '--th-rgb': rgb(c) },
    },
    foeArt(x),
    h('div.ar-main',
      h('div.ar-name', x.name),
      h('div.ar-hp', bar, exact ? h('b.ar-num', `${x.hp}`) : null),
      conds(x.conditions)),
    x.down ? h('div.ar-down', 'Down') : null,
    h('i.ar-flash'));
  }

  function sync(list, host, make, enter) {
    const want = list.map((x) => x.uid);
    for (const [uid, c] of cards) if (c.host === host && !want.includes(uid)) { c.el.remove(); cards.delete(uid); }
    list.forEach((x, i) => {
      const s = JSON.stringify([x, x.type === 'crawler' ? (view?.players || []).find((y) => y.id === x.playerId)?.level : null]);
      let c = cards.get(x.uid);
      if (!c || c.sig !== s) {
        const el = make(x);
        if (c) {
          // The view lands ~50 ms after combat.hit: keep the running flash + damage pop on the new card.
          for (const k of ['hit', 'healed', 'ko']) if (c.el.classList.contains(k) && Date.now() - (c.fxAt || 0) < 700) el.classList.add(k);
          for (const pop of c.el.querySelectorAll('.ar-pop')) el.append(pop);
          c.el.replaceWith(el);
          c = { ...c, el, sig: s };
          cards.set(x.uid, c);
        }
        else {
          if (enter) el.classList.add('enter');
          c = { el, sig: s, host };
          cards.set(x.uid, c);
        }
      }
      if (host.children[i] !== c.el) host.insertBefore(c.el, host.children[i] || null);
    });
  }

  function update(s, v) {
    view = v;
    const c = v?.combat || { active: false, round: 1, phases: [], combatants: [] };
    title.textContent = s.data?.title || '';
    title.hidden = !s.data?.title;
    round.querySelector('b').textContent = String(c.round || 1);
    round.hidden = !c.active;
    const ph = c.phases || [];
    phases.replaceChildren(...ph.map((p, i) => h('li', { class: c.active && i === c.phaseIndex ? 'on' : i < c.phaseIndex ? 'done' : '' }, p)));
    status.textContent = c.active ? `${c.phase || ''} phase` : 'Combat incoming';
    root.classList.toggle('idle', !c.active);
    if (c.active && (lastRound !== c.round || lastPhase !== c.phaseIndex)) {
      if (lastRound !== null) {
        replay(round, 'pulse');
        replay(status, 'pulse');
        if (lastRound !== c.round) bigText(`Round ${c.round}`);
      }
      lastRound = c.round;
      lastPhase = c.phaseIndex;
    }
    const crawlers = (c.combatants || []).filter((x) => x.type === 'crawler');
    const mobs = (c.combatants || []).filter((x) => x.type === 'mob');
    sync(crawlers, party, crawlerCard, false);
    sync(mobs, foes, foeCard, true);
    const n = mobs.length;
    foes.dataset.n = String(n);
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
    foes.style.setProperty('--cols', String(cols));
    foes.dataset.cols = String(cols);
    party.dataset.n = String(crawlers.length);
    foesEmpty.hidden = n > 0;
    const standing = mobs.filter((m) => !m.down).length;
    root.classList.toggle('cleared', c.active && n > 0 && standing === 0);
  }

  const big = h('div.ar-big', { 'aria-hidden': 'true' });
  root.append(big);
  function bigText(t) {
    big.textContent = t;
    replay(big, 'go');
  }

  function pop(card, text, cls) {
    const b = h('b', { class: `ar-pop ${cls}` }, text);
    b.style.left = `${30 + (hash(Date.now()) % 40)}%`;
    card.append(b);
    T.after(1300, () => b.remove());
  }

  function event(e) {
    if (e.kind === 'combat.hit' || e.kind === 'combat.heal') {
      const entry = cards.get(e.uid);
      const card = entry?.el;
      if (!card) return;
      entry.fxAt = Date.now();
      const heal = e.kind === 'combat.heal';
      replay(card, heal ? 'healed' : 'hit');
      const exactMob = e.type !== 'mob' || view?.combat?.showMobHp;
      pop(card, exactMob ? `${heal ? '+' : '−'}${e.amount}` : heal ? 'HEAL' : 'HIT', heal ? 'heal' : 'dmg');
      if (!heal && e.down) T.after(250, () => replay(card, 'ko'));
    } else if (e.kind === 'combat.start') bigText('Fight!');
    else if (e.kind === 'combat.reveal') {
      for (const uid of e.uids || []) { const card = cards.get(uid)?.el; if (card) replay(card, 'enter'); }
    }
  }

  update(sc, env.view);
  return { update, event };
}
