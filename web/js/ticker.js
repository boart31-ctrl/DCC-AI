// TV chat ticker: one continuous strip of messages, scrolled by a single translate3d on the track.
//
// Why it is built this way (the old ticker stuttered and sometimes popped a line in mid-screen):
//  - Items are absolutely positioned at a fixed strip coordinate chosen once, when they arrive:
//    never left of the right edge of the window, never overlapping the previous item. (The old
//    flex row put a new item right after the previous one, which could already be mid-screen.)
//  - The only per-frame work is one style write (the track transform). Widths are measured once per
//    item and again only after web fonts load or the screen resizes, never inside the frame loop.
//  - Motion = speed × elapsed time, with the frame time clamped, so a slow TV frame or a background
//    tab does not jump the strip. The loop sleeps when the strip is empty.
//  - A backlog (burst of lines after a big moment) speeds the strip up smoothly instead of
//    queueing far off-screen for a minute.

/**
 * @param {HTMLElement} win    clipping window (overflow hidden, position relative)
 * @param {HTMLElement} track  absolutely positioned child of `win`; items are appended here
 * @param {object} [o]
 * @param {number} [o.speed=90]   px/s at a 1080 px tall screen (scaled with the screen height)
 * @param {boolean} [o.reduced]   prefers-reduced-motion: half speed
 * @param {number} [o.max=40]     most items kept in the strip
 * @param {() => number} [o.now]
 * @param {(fn) => number} [o.raf]
 */
export function createTicker(win, track, o = {}) {
  const base = o.speed ?? 90;
  const max = o.max ?? 40;
  const now = o.now ?? (() => performance.now());
  const raf = o.raf ?? ((fn) => requestAnimationFrame(fn));
  const items = []; // { el, x, w }
  let offset = 0; // strip px scrolled so far
  let v = 0; // current speed px/s
  let viewW = 0;
  let scale = 1;
  let gap = 48;
  let lead = 24; // new items start this far right of the window edge
  let running = false;
  let last = 0;

  const place = (it) => { it.el.style.transform = `translate3d(${Math.round(it.x)}px,-50%,0)`; };
  const tailEnd = () => (items.length ? items[items.length - 1].x + items[items.length - 1].w : -Infinity);

  function measureBox() {
    viewW = win.clientWidth || viewW;
    scale = (window.innerHeight || 1080) / 1080;
    const g = parseFloat(getComputedStyle(track).columnGap);
    gap = Number.isFinite(g) && g > 0 ? g : 48 * scale;
    lead = Math.round(24 * scale);
  }

  /** Widths changed (fonts, resize): re-measure every item and push later ones right so none overlap. */
  function remeasure() {
    measureBox();
    let prevEnd = -Infinity;
    for (const it of items) it.w = it.el.offsetWidth; // one batch of reads
    for (const it of items) {
      if (it.x < prevEnd + gap) it.x = prevEnd + gap;
      prevEnd = it.x + it.w;
      place(it);
    }
  }

  function add(el) {
    if (!viewW) measureBox();
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = '50%';
    el.style.transform = 'translate3d(-99999px,-50%,0)'; // parked until placed
    track.append(el);
    const it = { el, x: 0, w: el.offsetWidth }; // the one layout read per new message
    it.x = Math.max(tailEnd() + gap, offset + viewW + lead);
    place(it);
    items.push(it);
    while (items.length > max) items.shift().el.remove();
    if (!running) {
      running = true;
      last = now();
      raf(frame);
    }
  }

  function frame(t) {
    const tNow = typeof t === 'number' ? t : now();
    const dt = Math.min(0.1, Math.max(0, (tNow - last) / 1000)); // clamp: slow frames / hidden tab
    last = tNow;
    // Backlog = strip waiting beyond the right edge. More than half a screen → go faster (up to 2.5×).
    const backlog = tailEnd() - (offset + viewW);
    const boost = backlog > viewW * 0.5 ? 1 + Math.min(1.5, (backlog / Math.max(1, viewW)) * 0.6) : 1;
    const target = base * scale * (o.reduced ? 0.5 : 1) * boost;
    v = v ? v + (target - v) * Math.min(1, dt * 1.5) : target;
    offset += v * dt;
    while (items.length && items[0].x + items[0].w < offset - 4) items.shift().el.remove();
    if (offset > 5e6) { // keep numbers small on very long nights
      for (const it of items) { it.x -= offset; place(it); }
      offset = 0;
    }
    track.style.transform = `translate3d(${-Math.round(offset * 10) / 10}px,0,0)`;
    if (items.length) raf(frame);
    else running = false;
  }

  measureBox();
  window.addEventListener('resize', remeasure);
  document.fonts?.ready?.then(remeasure).catch(() => {});
  document.fonts?.addEventListener?.('loadingdone', remeasure);

  return {
    add,
    remeasure,
    /** Debug / tests: where each item is on screen right now (x relative to the window). */
    debug: () => ({ offset, viewW, speed: v, items: items.map((it) => ({ x: it.x - offset, w: it.w, text: it.el.textContent })) }),
  };
}
