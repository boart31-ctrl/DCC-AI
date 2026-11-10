// Floor collapse countdown: a huge digital clock computed from server timestamps (reload-safe).
// Text updates 4x a second; the only motion is a pulse in the last minute and a tick in the last 10 s.
import { h, fmtClock, replay } from './common.js';

export default function countdown(root, sc, env) {
  const label = h('p.cd-label');
  const digits = h('div.cd-digits');
  const state = h('p.cd-state');
  const bar = h('div.cd-bar', h('div.cd-fill'));
  const doom = h('div.cd-doom', { hidden: true }, h('div.cd-doom-band', h('span', 'Floor collapse ◆ Floor collapse ◆ Floor collapse ◆ Floor collapse ◆ Floor collapse ◆ Floor collapse ◆ ')), h('p.cd-doom-text', 'Time is up'));
  root.append(h('div.cd-wrap', label, digits, bar, state), doom);
  let d = sc.data;
  let lastSec = null;
  const fill = bar.firstChild;

  function left() {
    if (!d.running || !d.endsAt) return d.remainingMs;
    return Math.max(0, d.endsAt - env.clock.now());
  }
  function tick() {
    const ms = left();
    const sec = Math.ceil(ms / 1000);
    if (sec !== lastSec) {
      digits.textContent = fmtClock(ms);
      const urgent = sec <= 60 && sec > 0;
      root.classList.toggle('urgent', urgent);
      root.classList.toggle('final', sec <= 10 && sec > 0);
      root.classList.toggle('zero', sec <= 0);
      doom.hidden = sec > 0;
      if (sec <= 10 && sec > 0 && d.running && !env.reduced && lastSec !== null) replay(digits, 'bump');
      lastSec = sec;
    }
    fill.style.transform = `scaleX(${d.totalMs ? Math.max(0, Math.min(1, ms / d.totalMs)) : 0})`;
  }
  function update(s) {
    d = s.data || {};
    label.textContent = d.label || 'Floor collapse in';
    state.textContent = d.running ? '' : left() > 0 ? 'Paused' : '';
    root.classList.toggle('paused', !d.running && left() > 0);
    lastSec = null;
    tick();
  }
  update(sc);
  env.T.every(250, tick);
  return { update };
}
