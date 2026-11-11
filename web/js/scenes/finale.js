// Combat finale (scene kind `finale`, set by combat.end with an outcome). One look per outcome:
//   victory   gold, confetti, VICTORY slam            defeat    red static, SIGNAL LOST
//   runaway   comic speed lines, "left the chat"       truce     warm pastel, "…aww"
//   special   the GM's title + text in a System box     sponsor   money rain, sponsor ribbon
//   timeout   hazard tape, 00:00                        stalemate grey split, "to be continued?"
// After the headline a summary strip: rounds, damage dealt / taken, mobs defeated, downs, MVP.
// TV budget: transform + opacity animations only; the confetti / rain is a fixed set of DOM bits.
import { h, hash, typeText, portraitTile } from './common.js';
import { uiOf, uiAsset, artEl } from '../ui-art.js';

const LOOKS = {
  victory: { kicker: 'Encounter cleared', head: 'Victory', sub: 'The crowd goes wild' },
  defeat: { kicker: 'Party wiped', head: 'Signal lost', sub: 'Please stand by' },
  runaway: { kicker: 'Breaking news', head: 'The crawlers have left the chat', sub: 'Strategic retreat confirmed' },
  truce: { kicker: 'A truce', head: '…aww', sub: 'Nobody had to die today' },
  special: { kicker: 'Special ending', head: '', sub: '' },
  sponsor: { kicker: 'This fight was ended by', head: 'A sponsor', sub: 'Please thank your benefactor' },
  timeout: { kicker: 'Time ran out', head: "Time's up", sub: 'The floor waits for no one' },
  stalemate: { kicker: 'No winner', head: 'Stalemate', sub: 'To be continued?' },
};

export default function finale(root, sc, env) {
  const { T } = env;
  let sig = '';

  function bits(n, cls, make) {
    return h(`div.${cls}`, { 'aria-hidden': 'true' }, Array.from({ length: n }, (_, i) => make(i)));
  }

  function backdrop(o) {
    if (o === 'victory') {
      return [h('div.fn-rays'), bits(42, 'fn-confetti', (i) => h('i', { style: {
        left: `${(hash(`c${i}`) % 1000) / 10}%`, '--d': `${(hash(`d${i}`) % 2200)}ms`, '--t': `${2600 + (hash(`t${i}`) % 2400)}ms`,
        '--r': `${(hash(`r${i}`) % 720) - 360}deg`, '--x': `${(hash(`x${i}`) % 160) - 80}px`, background: ['#ffd23f', '#ff2fb9', '#2ef2ff', '#e4ff2e', '#ffffff'][i % 5],
      } }))];
    }
    if (o === 'defeat') return [h('div.fn-static'), h('div.fn-bars', ...['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'].map((c) => h('i', { style: { background: c } })))];
    if (o === 'runaway') return [bits(16, 'fn-speed', (i) => h('i', { style: { top: `${(i * 6.2 + (hash(`s${i}`) % 4)).toFixed(1)}%`, '--d': `${(hash(`sd${i}`) % 600)}ms`, '--w': `${20 + (hash(`sw${i}`) % 40)}%` } })), h('div.fn-dust', h('i'), h('i'), h('i'))];
    if (o === 'truce') return [h('div.fn-bloom'), bits(14, 'fn-hearts', (i) => h('i', { style: { left: `${5 + (hash(`h${i}`) % 90)}%`, '--d': `${(hash(`hd${i}`) % 3000)}ms`, '--s': `${0.6 + (hash(`hs${i}`) % 8) / 10}` } }, '♥'))];
    if (o === 'sponsor') return [h('div.fn-rays.green'), bits(28, 'fn-money', (i) => h('i', { style: { left: `${(hash(`m${i}`) % 1000) / 10}%`, '--d': `${(hash(`md${i}`) % 2400)}ms`, '--t': `${2800 + (hash(`mt${i}`) % 2000)}ms` } }, i % 3 ? '$' : '¤'))];
    if (o === 'timeout') return [h('div.fn-tape.t1'), h('div.fn-tape.t2'), bits(10, 'fn-chunks', (i) => h('i', { style: { left: `${(hash(`k${i}`) % 1000) / 10}%`, '--d': `${600 + (hash(`kd${i}`) % 2400)}ms` } }))];
    if (o === 'stalemate') return [h('div.fn-split', h('i.l'), h('i.r'))];
    return [h('div.fn-sysglow')];
  }

  function headline(o, d) {
    const L = LOOKS[o] || LOOKS.victory;
    if (o === 'special') {
      const text = h('p.sys-desc.fn-sys-text');
      const box = h('div.sys.fn-sys', { 'data-head': `${(env.view?.pack?.systemName || 'The System').toUpperCase()} // SPECIAL ENDING` },
        h('p.sys-title', d.title || 'An unprecedented ending'), text);
      T.after(900, () => typeText(text, d.text || '', 1800, T));
      return [h('p.fn-kicker', L.kicker), box];
    }
    const head = d.title || L.head;
    return [
      h('p.fn-kicker', L.kicker),
      h('h1.fn-head', { class: `fn-head${head.length > 18 ? ' long' : ''}` }, o === 'timeout' ? [h('span.fn-clock', '00:00'), h('br'), head] : head),
      h('p.fn-sub', d.text || L.sub),
    ];
  }

  function summary(d, v) {
    const s = d.summary;
    if (!s) return null;
    const stat = (n, label, cls = '') => h('div.fn-stat', { class: `fn-stat ${cls}` }, h('b', String(n)), h('span', label));
    const mvpP = s.mvp ? v?.players?.find((p) => p.id === s.mvp.playerId) : null;
    return h('div.fn-sum',
      stat(s.rounds, s.rounds === 1 ? 'round' : 'rounds'),
      s.tracked || s.dealt ? stat(s.dealt, 'damage dealt') : null,
      stat(s.taken, 'damage taken'),
      s.mobsTotal ? stat(`${s.mobsDefeated}/${s.mobsTotal}`, 'mobs defeated') : null,
      stat(s.downs, s.downs === 1 ? 'crawler down' : 'crawlers down', s.downs ? 'bad' : ''),
      s.mvp ? h('div.fn-mvp', { style: { '--pc': s.mvp.color || mvpP?.color || '#ffd23f' } },
        artEl(uiAsset(uiOf(v), 'finale', ['mvp']), { cls: 'fn-mvp-badge', still: true }),
        portraitTile('fn-mvp-face', mvpP || { name: s.mvp.name }, { name: s.mvp.name }),
        h('div', h('span.fn-mvp-k', 'MVP'), h('b', s.mvp.name), h('span.fn-mvp-n', `${s.mvp.dealt} damage${s.mvp.kills ? ` · ${s.mvp.kills} KO` : ''}`))) : null);
  }

  function draw(s, v) {
    const d = s.data || {};
    const o = LOOKS[d.outcome] ? d.outcome : 'victory';
    const k = JSON.stringify([s.id, d.outcome, d.title, d.text, d.summary]);
    if (k === sig) return;
    sig = k;
    for (const c of [...root.classList]) if (c.startsWith('fn-')) root.classList.remove(c);
    root.classList.add(`fn-${o}`);
    document.body.dataset.finale = o; // light backgrounds: the bug on top gets a backdrop
    const sum = summary(d, v);
    // Outcome illustration (ui.json finale.<outcome>) above the headline; none → the CSS backdrop alone.
    const spot = artEl(uiAsset(uiOf(v), 'finale', [o]), { cls: 'fn-spot' });
    root.classList.toggle('has-spot', !!spot);
    root.replaceChildren(
      h('div.fn-bg', backdrop(o)),
      h('div.fn-center', spot, headline(o, d)),
      sum ? h('div.fn-sum-wrap', sum) : null,
    );
  }

  draw(sc, env.view);
  return { update: draw, destroy() { delete document.body.dataset.finale; } };
}
