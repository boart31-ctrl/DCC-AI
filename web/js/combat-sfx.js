// Combat sounds on the GM desk (the audio device): combat events play SFX pads automatically, cued to
// the TV's auto-mode cinematic (`combat.auto` carries startAt / stepMs / beats in server time).
//
//   const csfx = createCombatSfx({ board, getView });   // board = the Sound panel's SFX board
//   csfx.on / csfx.on = false;   csfx.panel() → the "Combat sounds" section for Show → Sound
// Settings (this device only, localStorage `system.combatSfx`): { on, map: { event: padId | '' } }.
import { h } from './client.js';
import { icon } from './ui.js';

export const COMBAT_SFX_EVENTS = [
  ['swing', 'Mob attack swing', 'swing'],
  ['hit', 'Hit', 'impact'],
  ['miss', 'Miss', 'whiff'],
  ['crit', 'Critical hit (natural 20)', 'crit_hit'],
  ['fumble', 'Natural 1', 'fail'],
  ['down', 'Crawler down', 'ko'],
  ['killed', 'Mob killed', 'shatter'],
  ['round', 'Combat / round start', 'round_bell'],
  ['victory', 'Ending: victory', 'victory_fanfare'],
  ['defeat', 'Ending: party wiped', 'signal_lost'],
  ['runaway', 'Ending: they ran', 'getaway'],
  ['truce', 'Ending: truce', 'crowd_aww'],
  ['special', 'Ending: special', 'hype_horn'],
  ['sponsor', 'Ending: sponsor', 'sponsor_chime'],
  ['timeout', 'Ending: time ran out', 'alarm_collapse'],
  ['stalemate', 'Ending: stalemate', 'fail'],
];
const KEY = 'system.combatSfx';
const DEFAULT_BEATS = { lunge: 0, swing: 0.12, roll: 0.2, result: 0.52, down: 0.72 };

function load() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch {}
  const map = Object.fromEntries(COMBAT_SFX_EVENTS.map(([id, , pad]) => [id, typeof s.map?.[id] === 'string' ? s.map[id] : pad]));
  return { on: s.on !== false, map };
}

export function createCombatSfx({ board, getView, onChange }) {
  const cfg = load();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch {} onChange?.(); };
  let offset = 0; // server − local ms
  const timers = new Map(); // autoId → [timeouts]
  let lastRound = null;

  const trace = (globalThis.__combatSfxLog = []); // headless checks: what played when
  function play(ev) {
    if (!cfg.on) return;
    const id = cfg.map[ev];
    if (!id) return;
    trace.push({ ev, id, at: Date.now() });
    if (trace.length > 200) trace.shift();
    board.play(id);
  }
  function at(group, ms, ev) {
    const t = setTimeout(() => play(ev), Math.max(0, ms));
    if (!timers.has(group)) timers.set(group, []);
    timers.get(group).push(t);
  }
  function cancel(group) {
    for (const [g, list] of timers) if (group == null || g === group) { for (const t of list) clearTimeout(t); timers.delete(g); }
  }

  function auto(e) {
    cancel(e.autoId);
    const beats = e.beats || DEFAULT_BEATS;
    const stepMs = e.stepMs || 2000;
    const start = (e.startAt ?? Date.now() + offset) - (Date.now() + offset);
    (e.steps || []).forEach((st, k) => {
      if (st.skipped) return;
      const t0 = start + (Number.isInteger(st.slot) ? st.slot : k) * stepMs;
      at(e.autoId, t0 + beats.swing * stepMs, 'swing');
      at(e.autoId, t0 + beats.result * stepMs, st.crit ? 'crit' : st.hit ? 'hit' : st.nat1 ? 'fumble' : 'miss');
      if (st.down) at(e.autoId, t0 + beats.down * stepMs, 'down');
    });
  }

  function event(e) {
    switch (e.kind) {
      case 'combat.auto': auto(e); break;
      case 'combat.autoSkip': case 'combat.autoUndo': cancel(null); break;
      case 'combat.hit':
        if (e.down && e.type === 'mob') play('killed');
        else if (e.down && e.type === 'crawler') play('down');
        break;
      case 'combat.start': lastRound = 1; play('round'); break;
      case 'combat.phase':
        if (e.round !== lastRound && e.phaseIndex === 0) play('round');
        lastRound = e.round;
        break;
      case 'combat.end':
        cancel(null);
        if (e.outcome) setTimeout(() => play(e.outcome), 250);
        break;
      default: break;
    }
  }

  function view(v) {
    if (Number.isFinite(v?.scene?.now)) offset = v.scene.now - Date.now();
    if (v?.combat?.active && lastRound == null) lastRound = v.combat.round;
  }

  /** Show → Sound section: on/off + which pad each combat moment plays. */
  function panel() {
    const wrap = h('section.snd-combat', { id: 'combat-sounds', 'aria-labelledby': 'h-csfx' });
    const draw = () => {
      const pads = board.pads || [];
      const opts = [h('option', { value: '' }, 'Nothing'), ...pads.map((p) => h('option', { value: p.id }, p.label))];
      wrap.replaceChildren(
        h('div.col-head', h('h2', { id: 'h-csfx' }, 'Combat sounds'),
          h('label.chk', h('input', { type: 'checkbox', checked: cfg.on, onchange: (ev) => { cfg.on = ev.target.checked; save(); } }), h('span', 'Play automatically'))),
        h('p.hint', 'Hits, misses, KOs, rounds and endings play here by themselves, in step with the TV. This notebook only.'),
        h('div.csfx-grid', COMBAT_SFX_EVENTS.map(([id, label]) => {
          const sel = h('select.inp.inp-sm', { 'aria-label': `${label} sound`, disabled: !cfg.on }, opts.map((o) => o.cloneNode(true)));
          sel.value = cfg.map[id] || '';
          sel.addEventListener('change', () => { cfg.map[id] = sel.value; save(); });
          return h('div.csfx-row', h('span.csfx-l', label), sel,
            h('button.icon-btn', { type: 'button', title: 'Test', 'aria-label': `Test ${label}`, disabled: !cfg.map[id], onclick: () => { board.unlock(); board.play(cfg.map[id]); } }, icon('play', { size: 14 })));
        })),
      );
    };
    draw();
    const prev = board.onChange;
    let n = board.pads?.length || 0;
    board.onChange = () => { prev?.(); if ((board.pads?.length || 0) !== n) { n = board.pads.length; draw(); } };
    api.redrawPanel = draw;
    return wrap;
  }

  const api = {
    event,
    view,
    panel,
    redrawPanel: null,
    get on() { return cfg.on; },
    set on(v) { cfg.on = !!v; save(); api.redrawPanel?.(); },
    test: play,
  };
  return api;
}
