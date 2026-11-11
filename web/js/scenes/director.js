// Scene director for the stage: mounts the current scene, runs the transition wipe when the GM
// changes scenes, and routes transient events (boss.hit, ...) to the scene they belong to.
// Events can arrive before the view that carries their scene (views are debounced), so events
// with a sceneId we have not mounted yet wait up to 4 s.
import { h, timers, serverClock, reducedMotion } from './common.js';
import lobby from './lobby.js';
import explore from './explore.js';
import boss from './boss.js';
import loot from './loot.js';
import countdown from './countdown.js';
import roll from './roll.js';
import recap from './recap.js';
import blank from './blank.js';
import combat from './combat.js';
import npc from './npc.js';

const KINDS = { lobby, explore, boss, loot, countdown, roll, recap, blank, combat, npc };
const WIPE_MS = 760;

export function createDirector(layer, opts = {}) {
  const reduced = opts.reduced ?? reducedMotion();
  const clock = serverClock();
  let cur = null; // { id, kind, el, inst, T }
  let view = null;
  const early = []; // events for scenes not mounted yet

  function mount(sc) {
    const el = h('section', { class: `scene sc-${sc.kind}`, 'data-kind': sc.kind, 'aria-label': `${sc.kind} scene` });
    const T = timers();
    let inst = null;
    try {
      inst = KINDS[sc.kind](el, sc, { view, reduced, T, clock });
    } catch (err) {
      console.error('[scene] mount failed', err);
      el.replaceChildren(h('p.sc-error', 'Scene failed to load'));
      inst = { update() {} };
    }
    return { id: sc.id, kind: sc.kind, el, inst, T };
  }

  function unmount(c) {
    c.T.clear();
    try { c.inst.destroy?.(); } catch {}
    c.el.remove();
  }

  function wipe() {
    if (reduced) return;
    const w = h('div.wipe', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
    document.body.append(w);
    setTimeout(() => w.remove(), WIPE_MS + 100);
  }

  function render(v) {
    view = v;
    const sc = v?.scene;
    if (!sc || !KINDS[sc.kind]) {
      if (cur) { unmount(cur); cur = null; }
      delete document.body.dataset.scene;
      return;
    }
    clock.sync(sc.now);
    if (cur && cur.id === sc.id) {
      try { cur.inst.update(sc, v); } catch (err) { console.error('[scene] update failed', err); }
      return;
    }
    const first = !cur;
    const old = cur;
    const next = mount(sc);
    cur = next;
    document.body.dataset.scene = sc.kind;
    if (first || reduced) {
      if (old) unmount(old);
      layer.append(next.el);
    } else {
      // Wipe: bars sweep across; the new scene appears under them at the midpoint.
      wipe();
      next.el.classList.add('pending');
      layer.append(next.el);
      old.el.classList.add('leaving');
      setTimeout(() => { next.el.classList.remove('pending'); unmount(old); }, WIPE_MS * 0.45);
    }
    // Replay events that arrived before this scene's view.
    const now = Date.now();
    for (let i = early.length - 1; i >= 0; i--) {
      const x = early[i];
      if (now - x.t > 4000) early.splice(i, 1);
    }
    for (const x of early.filter((x) => x.e.sceneId === sc.id)) {
      early.splice(early.indexOf(x), 1);
      deliver(x.e);
    }
  }

  function deliver(e) {
    try { cur?.inst.event?.(e); } catch (err) { console.error('[scene] event failed', err); }
  }

  function event(e) {
    if (e.sceneId && (!cur || cur.id !== e.sceneId)) {
      early.push({ e, t: Date.now() });
      if (early.length > 20) early.shift();
      return;
    }
    deliver(e);
  }

  return { render, event, get kind() { return cur?.kind ?? null; } };
}
