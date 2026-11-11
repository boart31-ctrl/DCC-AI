// Arena: the party vs the revealed mobs. Round / phase banner on top, crawlers on the left (portrait
// tiles), living hostiles on the right, defeated ones as crossed-out icons in a "Fallen" row above the
// HOSTILES label. Content comes from view.combat (already role-filtered by the engine: hidden mobs,
// notes and attacks never reach the TV; mob HP is a bar unless the GM turned on exact numbers).
//
// Auto mode (`combat.auto`): the mob phase plays as a cinematic, one mob per step from the server's
// `startAt`: the mob card lunges at its target, a banner names the attack, a d20 tumbles to the roll
// vs Evade, then HIT (damage pop, shake, HP pips break) or MISS (whiff, dodge); crits and natural ones
// get their own treatment; a crawler reaching 0 gets the big DOWN stamp. While it plays, crawler HP
// shows the value *before* each step (the view already carries the result). TV budget: transform +
// opacity animations only.
import { h, hash, threatColor, rgb, replay, bossSvg, portraitTile } from './common.js';
import { portraitSrc } from '../client.js';

const MAX_PIPS = 20;
const FALLEN_MAX = 10;

export default function combat(root, sc, env) {
  const { T, clock } = env;
  const title = h('p.ar-title');
  const round = h('div.ar-round', h('small', 'Round'), h('b', '1'));
  const phases = h('ol.ar-phases');
  const status = h('p.ar-status');
  const party = h('div.ar-party');
  const foes = h('div.ar-foes');
  const fallen = h('div.ar-fallen', { 'aria-label': 'Fallen' });
  const foesEmpty = h('div.ar-empty', h('i.ar-scan'), h('p', 'Scanning for hostiles'));
  const fx = h('div.ar-fx', { 'aria-hidden': 'true' });
  root.append(
    h('div.ar-bg', h('i.ar-grid'), h('i.ar-glow-l'), h('i.ar-glow-r')),
    h('header.ar-head', h('div.ar-banner', title, round, h('div.ar-phasebox', phases, status))),
    h('div.ar-board',
      h('section.ar-side.ar-side-l', h('h2.ar-label', h('span', 'Crawlers')), party),
      h('div.ar-vs', { 'aria-hidden': 'true' }, h('i'), h('b', 'VS'), h('i')),
      h('section.ar-side.ar-side-r', fallen, h('h2.ar-label', h('span', 'Hostiles')), foes, foesEmpty)),
    fx,
  );

  const cards = new Map(); // uid → { el, sig, host, fxAt }
  const shownHp = new Map(); // crawler uid → HP drawn last (pip break animation)
  const dying = new Map(); // mob uid → until (ms): stays on the board for the shatter
  const override = new Map(); // crawler uid → HP to show during the auto cinematic
  let play = null; // { id, timers: [], endAt }
  let lastRound = null;
  let lastPhase = null;
  let view = env.view;

  function pips(cur, max, cls, prev) {
    const n = Math.max(0, Math.min(MAX_PIPS, max));
    if (max > MAX_PIPS || !n) return h('div', { class: `ar-bar ${cls}` }, h('i', { style: { transform: `scaleX(${max ? Math.max(0, cur) / max : 0})` } }));
    return h('div', { class: `ar-pips ${cls}`, style: { '--n': String(n) } }, Array.from({ length: n }, (_, i) => h('i', {
      class: i < cur ? 'on' : prev != null && i < prev && i >= cur ? 'brk' : '',
      style: prev != null && i < prev && i >= cur ? { '--d': `${(prev - 1 - i) * 60}ms` } : null,
    })));
  }

  function conds(list) {
    return list?.length ? h('div.ar-conds', list.slice(0, 4).map((k) => h('span', k.name)), list.length > 4 ? h('span', `+${list.length - 4}`) : null) : null;
  }

  const playerOf = (id) => (view?.players || []).find((y) => y.id === id);

  function crawlerCard(x0) {
    const x = override.has(x0.uid) ? { ...x0, hp: override.get(x0.uid), down: x0.hpMax > 0 && override.get(x0.uid) <= 0 } : x0;
    const p = playerOf(x.playerId);
    const low = x.hpMax > 0 && x.hp / x.hpMax <= 0.3;
    const prev = shownHp.get(x.uid);
    shownHp.set(x.uid, x.hp);
    return h('article.ar-card.ar-crawler', {
      class: `ar-card ar-crawler${x.down ? ' down' : ''}${low && !x.down ? ' low' : ''}`, 'data-uid': x.uid,
      style: { '--pc': x.color || p?.color || '#2ef2ff' },
    },
    portraitTile('ar-face', p, { name: x.name, level: p?.level }),
    h('div.ar-main',
      h('div.ar-name', x.name),
      h('div.ar-hp', pips(x.hp, x.hpMax, 'crawl', prev != null && prev > x.hp ? prev : null), h('b.ar-num', `${Math.max(0, x.hp)}`)),
      conds(x.conditions)),
    x.down ? h('div.ar-down', 'Down') : null,
    h('i.ar-flash'));
  }

  function foeArt(x, cls = 'ar-art') {
    const wrap = h(`div.${cls}`);
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
      class: `ar-card ar-foe${x.down ? ' down' : ''}${x.boss ? ' boss' : ''}${pct > 0 && pct <= 0.3 ? ' low' : ''}`, 'data-uid': x.uid,
      style: { '--th': c, '--th-rgb': rgb(c) },
    },
    foeArt(x),
    h('div.ar-main',
      h('div.ar-name', x.name),
      h('div.ar-hp', bar, exact ? h('b.ar-num', `${x.hp}`) : null),
      conds(x.conditions)),
    h('i.ar-flash'));
  }

  function sync(list, host, make, enter) {
    const want = list.map((x) => x.uid);
    for (const [uid, c] of cards) if (c.host === host && !want.includes(uid)) { c.el.remove(); cards.delete(uid); }
    list.forEach((x, i) => {
      const s = JSON.stringify([x, override.get(x.uid), x.type === 'crawler' ? [...['level', 'portrait', 'name'].map((k) => playerOf(x.playerId)?.[k]), !!portraitSrc(playerOf(x.playerId)?.portrait)] : null]);
      let c = cards.get(x.uid);
      if (!c || c.sig !== s) {
        const el = make(x);
        if (c) {
          // The view lands ~50 ms after combat.hit: keep the running flash + damage pop on the new card.
          for (const k of ['hit', 'crit', 'healed', 'ko', 'dodge', 'shatter', 'lunge', 'fumble', 'aim']) if (c.el.classList.contains(k) && (k === 'aim' || k === 'lunge' || Date.now() - (c.fxAt || 0) < 1400)) el.classList.add(k);
          if (c.el.style.getPropertyValue('--lx')) { el.style.setProperty('--lx', c.el.style.getPropertyValue('--lx')); el.style.setProperty('--ly', c.el.style.getPropertyValue('--ly')); }
          for (const pop of c.el.querySelectorAll('.ar-pop')) el.append(pop);
          c.el.replaceWith(el);
          c = { ...c, el, sig: s };
          cards.set(x.uid, c);
        } else {
          if (enter) el.classList.add('enter');
          c = { el, sig: s, host };
          cards.set(x.uid, c);
        }
      }
      if (host.children[i] !== c.el) host.insertBefore(c.el, host.children[i] || null);
    });
  }

  let fallenSig = '';
  function drawFallen(list) {
    const s = JSON.stringify(list.map((x) => [x.uid, x.name, x.image]));
    if (s === fallenSig) return;
    fallenSig = s;
    const shown = list.slice(-FALLEN_MAX);
    fallen.hidden = !list.length;
    fallen.replaceChildren(...[
      h('span.ar-fallen-k', 'Fallen'),
      list.length > FALLEN_MAX ? h('span.ar-fallen-more', `+${list.length - FALLEN_MAX}`) : null,
      ...shown.map((x) => h('figure.ar-fl', { style: { '--th': threatColor({ name: x.name.replace(/\s+\d+$/, '') }) } },
        foeArt({ ...x, down: false }, 'ar-fl-art'), h('i.ar-fl-x'), h('figcaption', x.name))),
    ].filter(Boolean));
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
    const now = Date.now();
    for (const [uid, until] of dying) if (until < now) dying.delete(uid);
    const living = mobs.filter((m) => !m.down || dying.has(m.uid));
    const dead = mobs.filter((m) => m.down && !dying.has(m.uid));
    sync(crawlers, party, crawlerCard, false);
    sync(living, foes, foeCard, true);
    drawFallen(dead);
    const n = living.length;
    foes.dataset.n = String(n);
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
    foes.style.setProperty('--cols', String(cols));
    foes.dataset.cols = String(cols);
    party.dataset.n = String(crawlers.length);
    foesEmpty.hidden = n > 0 || dead.length > 0;
    root.classList.toggle('cleared', c.active && mobs.length > 0 && !living.length);
  }
  const redraw = () => update(sc, view);

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
    T.after(1400, () => b.remove());
  }

  /* ---------- auto mode cinematic ---------- */

  const cardOf = (uid) => cards.get(uid)?.el || null;
  const center = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  function fxMark(uid, cls) {
    const c = cards.get(uid);
    if (!c) return;
    c.fxAt = Date.now();
    replay(c.el, cls);
  }

  function stopPlay(final = true) {
    if (!play) return;
    for (const id of play.timers) T.stop(id);
    play = null;
    fx.replaceChildren();
    root.classList.remove('auto-on');
    for (const c of cards.values()) { c.el.classList.remove('lunge', 'aim'); c.el.style.removeProperty('--lx'); c.el.style.removeProperty('--ly'); }
    if (final) { override.clear(); redraw(); }
  }

  function playAuto(e) {
    stopPlay(false);
    override.clear();
    const steps = (e.steps || []).filter((x) => !x.skipped);
    if (!steps.length) { redraw(); return; }
    // Crawlers show their HP from before the run until their own step resolves.
    for (const st of steps) if (st.targetUid && !override.has(st.targetUid)) override.set(st.targetUid, st.hpBefore);
    redraw();
    const stepMs = e.stepMs || 2000;
    const beats = e.beats || { lunge: 0, swing: 0.12, roll: 0.2, result: 0.52, down: 0.72 };
    const start = (e.startAt ?? clock.now()) - clock.now(); // ms from now (server clock)
    play = { id: e.autoId, timers: [] };
    root.classList.add('auto-on');
    const at = (ms, fn) => play.timers.push(T.after(Math.max(0, ms), fn));
    const slotOf = (st, k) => (Number.isInteger(st.slot) ? st.slot : k);
    steps.forEach((st, k) => {
      const t0 = start + slotOf(st, k) * stepMs;
      at(t0 + beats.lunge * stepMs, () => stepLunge(st));
      at(t0 + beats.roll * stepMs, () => stepRoll(st, stepMs * (beats.result - beats.roll)));
      at(t0 + beats.result * stepMs, () => stepResult(st));
      if (st.down) at(t0 + beats.down * stepMs, () => stepDown(st));
      at(t0 + 0.9 * stepMs, () => stepEnd(st));
    });
    const last = Math.max(...steps.map((st, k) => slotOf(st, k)));
    at(start + (last + 1) * stepMs + 250, () => stopPlay(true));
  }

  function stepLunge(st) {
    const m = st.mobUid ? cardOf(st.mobUid) : null;
    const tgt = cardOf(st.targetUid);
    fx.replaceChildren(h('div.ar-callout', { class: `ar-callout${st.boss ? ' boss' : ''}` },
      h('b', st.mob), h('span', ' uses '), h('b.ar-atk', st.attack || 'an attack'), h('span', '!')));
    if (tgt) tgt.classList.add('aim');
    if (m && tgt) {
      const a = center(m);
      const b = center(tgt);
      m.style.setProperty('--lx', `${Math.round((b.x - a.x) * 0.42)}px`);
      m.style.setProperty('--ly', `${Math.round((b.y - a.y) * 0.42)}px`);
      fxMark(st.mobUid, 'lunge');
    }
  }

  function stepRoll(st, dur) {
    const m = st.mobUid ? cardOf(st.mobUid) : null;
    const tgt = cardOf(st.targetUid);
    const p = tgt && m ? { x: (center(m).x + center(tgt).x) / 2, y: (center(m).y + center(tgt).y) / 2 } : { x: innerWidth / 2, y: innerHeight / 2 };
    const face = h('b.ar-d20-n', '?');
    const die = h('div.ar-d20', { style: { left: `${p.x}px`, top: `${p.y}px` } },
      h('div.ar-d20-spin', h('i.ar-d20-shape'), face),
      h('p.ar-d20-math'));
    fx.append(die);
    // Numbers flicker while it tumbles (text only), then land on the real face.
    let n = 0;
    const flick = T.every(70, () => { face.textContent = String(1 + ((hash(`${st.i}${n++}`) >> 3) % 20)); });
    play?.timers.push(flick);
    play?.timers.push(T.after(Math.max(200, dur - 120), () => {
      T.stop(flick);
      face.textContent = String(st.d20);
      die.classList.add('land', st.nat20 ? 'n20' : st.nat1 ? 'n1' : st.hit ? 'ok' : 'no');
      die.querySelector('.ar-d20-math').textContent = `${st.d20}${st.toHit ? ` ${st.toHit > 0 ? '+' : '−'} ${Math.abs(st.toHit)}` : ''} = ${st.total}  vs  Evade ${st.evade}`;
    }));
  }

  function stepResult(st) {
    const tgt = cardOf(st.targetUid);
    const m = st.mobUid ? cardOf(st.mobUid) : null;
    if (st.hit) {
      override.set(st.targetUid, st.hpAfter);
      redraw();
      const el = cardOf(st.targetUid);
      if (el) {
        fxMark(st.targetUid, st.crit ? 'crit' : 'hit');
        pop(el, st.damage ? `−${st.damage}` : 'HIT', st.crit ? 'dmg crit' : 'dmg');
        if (st.buffs?.length) T.after(350, () => pop(el, st.buffs[0], 'cond'));
      }
      if (st.crit && !st.down) fx.append(h('div.ar-crit', 'Critical!')); // a KO's stamp is the bigger moment
    } else {
      if (tgt) { fxMark(st.targetUid, 'dodge'); pop(tgt, st.nat1 ? 'FUMBLE' : 'MISS', 'miss'); }
      if (m && st.nat1) fxMark(st.mobUid, 'fumble');
    }
  }

  function stepDown(st) {
    fxMark(st.targetUid, 'ko');
    fx.append(h('div.ar-stamp', h('b', st.target), h('span', 'is down')));
  }

  function stepEnd(st) {
    const tgt = cardOf(st.targetUid);
    if (tgt) tgt.classList.remove('aim');
    const m = st.mobUid ? cards.get(st.mobUid) : null;
    if (m) { m.el.classList.remove('lunge'); m.el.style.removeProperty('--lx'); m.el.style.removeProperty('--ly'); }
    for (const x of fx.querySelectorAll('.ar-d20, .ar-callout, .ar-crit')) x.classList.add('out');
  }

  /* ---------- events ---------- */

  function event(e) {
    if (e.kind === 'combat.auto') { playAuto(e); return; }
    if (e.kind === 'combat.autoSkip' || e.kind === 'combat.autoUndo') { stopPlay(true); return; }
    if (e.kind === 'combat.hit' || e.kind === 'combat.heal') {
      const entry = cards.get(e.uid);
      const card = entry?.el;
      if (!card) return;
      entry.fxAt = Date.now();
      const heal = e.kind === 'combat.heal';
      replay(card, heal ? 'healed' : 'hit');
      const exactMob = e.type !== 'mob' || view?.combat?.showMobHp;
      pop(card, exactMob ? `${heal ? '+' : '−'}${e.amount}` : heal ? 'HEAL' : 'HIT', heal ? 'heal' : 'dmg');
      if (!heal && e.down && e.type === 'mob') {
        // Shatter on the board, then it moves to the Fallen row.
        dying.set(e.uid, Date.now() + 1300);
        T.after(260, () => { const c = cards.get(e.uid); if (c) { c.fxAt = Date.now(); replay(c.el, 'shatter'); shards(c.el); } });
        T.after(1350, redraw);
      } else if (!heal && e.down) {
        T.after(250, () => replay(card, 'ko'));
        fx.append(h('div.ar-stamp', h('b', e.name), h('span', 'is down')));
        T.after(2600, () => fx.querySelector('.ar-stamp')?.remove());
      }
    } else if (e.kind === 'combat.start') bigText('Fight!');
    else if (e.kind === 'combat.reveal') {
      for (const uid of e.uids || []) { const card = cards.get(uid)?.el; if (card) replay(card, 'enter'); }
    }
  }

  /** Glass shards fly out of a card (12 skewed bits, transform + opacity). */
  function shards(card) {
    const r = card.getBoundingClientRect();
    const box = h('div.ar-shards', { style: { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` } });
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + (hash(`${i}${r.left}`) % 100) / 200;
      const d = 120 + (hash(`${i}d`) % 160);
      box.append(h('i', { style: { left: `${10 + (i % 4) * 25}%`, top: `${15 + Math.floor(i / 4) * 30}%`, '--sx': `${Math.round(Math.cos(a) * d)}px`, '--sy': `${Math.round(Math.sin(a) * d)}px`, '--sr': `${(i % 2 ? 1 : -1) * (90 + i * 25)}deg` } }));
    }
    fx.append(box);
    T.after(1300, () => box.remove());
  }

  update(sc, env.view);
  return { update, event, destroy() { stopPlay(false); } };
}
