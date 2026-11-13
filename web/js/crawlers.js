// Crawlers remaining on the client: the same attrition curve as server/crawlers.js, so the TV, the GM
// desk and the phones roll the count down live between the server's minute anchors.
//
// view.crawlers = { count, at, now, live, perHour, min, maxGapMs, floor, start, label, shown, ... }
//   value(t) = min + (count − min) · (1 − perHour) ^ hours, hours = min(t − at, maxGapMs) / 1 h

/** One `view.crawlers` plus the local time it arrived: call `.value()` any time for the live count. */
export function crawlerClock() {
  let c = null;
  let receivedAt = 0;
  return {
    set(next) {
      c = next || null;
      receivedAt = Date.now();
    },
    get data() { return c; },
    value(nowMs = Date.now()) {
      if (!c) return 0;
      if (!c.live || !(c.perHour > 0) || c.count <= c.min) return c.count;
      const serverNow = (c.now ?? receivedAt) + (nowMs - receivedAt);
      const ms = Math.min(Math.max(0, serverNow - c.at), c.maxGapMs ?? 150_000);
      return Math.floor(c.min + (c.count - c.min) * (1 - c.perHour) ** (ms / 3_600_000));
    },
  };
}

export const fmtFull = (n) => Math.max(0, Math.round(Number(n) || 0)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 1.70B · 412.3M · 87.2K · 913 */
export function fmtCompact(n) {
  n = Math.max(0, Math.round(Number(n) || 0));
  const u = n >= 1e9 ? [1e9, 'B'] : n >= 1e6 ? [1e6, 'M'] : n >= 1e4 ? [1e3, 'K'] : null;
  if (!u) return fmtFull(n);
  const x = n / u[0];
  return `${x >= 100 ? x.toFixed(1).replace(/\.0$/, '') : x.toFixed(x >= 10 ? 1 : 2)}${u[1]}`;
}

/** Ease a number from → to over `ms` (rAF); onStep(value) each frame, onDone at the end. */
export function countDown(from, to, ms, onStep, onDone) {
  if (!(ms > 0) || from === to) { onStep(to); onDone?.(); return () => {}; }
  const t0 = performance.now();
  let raf = 0;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    onStep(Math.round(from + (to - from) * (1 - (1 - k) ** 3)));
    if (k < 1) raf = requestAnimationFrame(step);
    else onDone?.();
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

/** Small skull icon (inline SVG, no font glyph needed on old TV browsers). */
export function skullSvg(size = 24) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'skull');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('fill', 'currentColor');
  p.setAttribute('fill-rule', 'evenodd');
  p.setAttribute('d', 'M12 2C6.9 2 3 5.6 3 10.4c0 2.7 1.3 4.8 3.2 6.1V19c0 .8.6 1.4 1.4 1.4h1.1v-1.9h1.6v1.9h3.4v-1.9h1.6v1.9h1.1c.8 0 1.4-.6 1.4-1.4v-2.5c1.9-1.3 3.2-3.4 3.2-6.1C21 5.6 17.1 2 12 2zM8.6 9.3a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2zm6.8 0a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2zM12 13.6l1.3 2.3h-2.6z');
  svg.append(p);
  return svg;
}
