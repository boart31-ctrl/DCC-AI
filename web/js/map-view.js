// One map on screen (server/maps.js): image, fog of war, zones, tokens. Used by the TV scene, the phones
// and the GM editor.
//
// createMapView({ gm = false, onDrag, onTokenMove, canMoveToken }) → { el, set(map, opts), toLocal(evt) }
//   gm            translucent fog, every zone outlined with its name (revealed ones solid), hidden tokens dim
//   onDrag(rect, evt)        GM: a finished drag on the map, rect in 0..1 image coordinates
//   onTokenMove(token, x, y) a token was dropped (x, y 0..1)
//   canMoveToken(token)      who may drag which token (default: nobody)
// A zone counts as revealed when `revealed` is true or missing (public maps only carry revealed zones).
import { h } from './client.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const isRevealed = (z) => z.revealed !== false;

function decode(b64, cols, rows) {
  const out = new Uint8Array(Math.ceil((cols * rows) / 8));
  try {
    const s = atob(b64 || '');
    for (let i = 0; i < Math.min(s.length, out.length); i++) out[i] = s.charCodeAt(i);
  } catch {}
  return out;
}
const cellOn = (bits, cols, c, r) => !!(bits[(r * cols + c) >> 3] & (1 << ((r * cols + c) & 7)));

function tracePath(ctx, shape, W, H) {
  ctx.beginPath();
  if (shape.points) {
    shape.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
    ctx.closePath();
  } else ctx.rect(shape.x * W, shape.y * H, shape.w * W, shape.h * H);
}

export function createMapView({ gm = false, onDrag = null, onTokenMove = null, canMoveToken = () => false, fit = false } = {}) {
  const img = h('img.mv-img', { alt: '', draggable: false });
  const fog = h('canvas.mv-fog', { 'aria-hidden': 'true' });
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'mv-zones');
  svg.setAttribute('viewBox', '0 0 1000 1000');
  svg.setAttribute('preserveAspectRatio', 'none');
  const tokens = h('div.mv-tokens');
  const sel = h('div.mv-sel', { hidden: true });
  const stage = h('div.mv-stage', img, fog, svg, tokens, sel);
  const el = h('div.mv', { class: gm ? 'mv mv-gm' : 'mv' }, stage);
  let map = null;
  let opts = {};
  let lastSig = '';
  // fit: scale the map to fit inside the element (TV), "contain" style, instead of full width.
  function fitNow() {
    if (!fit || !map) return;
    const W = el.clientWidth;
    const H = el.clientHeight;
    if (!W || !H) return;
    const a = map.aspect || 1.5;
    const w = Math.min(W, H * a);
    stage.style.width = `${Math.floor(w)}px`;
    stage.style.height = `${Math.floor(w / a)}px`;
  }
  if (fit && typeof ResizeObserver !== 'undefined') new ResizeObserver(fitNow).observe(el);

  function toLocal(e) {
    const r = stage.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  }

  function drawFog() {
    if (!map) return;
    const W = map.cols * 16;
    const H = map.rows * 16;
    fog.width = W;
    fog.height = H;
    const ctx = fog.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = gm ? 'rgba(10, 6, 20, 0.55)' : '#07040d';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'destination-out';
    const bits = decode(map.fog, map.cols, map.rows);
    ctx.fillStyle = '#000';
    for (let r = 0; r < map.rows; r++) for (let c = 0; c < map.cols; c++) if (cellOn(bits, map.cols, c, r)) ctx.fillRect(c * 16, r * 16, 16, 16);
    for (const z of map.zones || []) {
      if (!isRevealed(z)) continue;
      tracePath(ctx, z.shape, W, H);
      ctx.fill();
    }
  }

  function drawZones() {
    svg.replaceChildren();
    if (!map) return;
    const list = (map.zones || []).filter((z) => gm || opts.labels);
    for (const z of list) {
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', `mv-zone${isRevealed(z) ? ' on' : ''}${opts.selected === z.id ? ' sel' : ''}`);
      const s = z.shape;
      let shapeEl;
      if (s.points) {
        shapeEl = document.createElementNS(SVGNS, 'polygon');
        shapeEl.setAttribute('points', s.points.map(([x, y]) => `${x * 1000},${y * 1000}`).join(' '));
      } else {
        shapeEl = document.createElementNS(SVGNS, 'rect');
        shapeEl.setAttribute('x', s.x * 1000); shapeEl.setAttribute('y', s.y * 1000);
        shapeEl.setAttribute('width', s.w * 1000); shapeEl.setAttribute('height', s.h * 1000);
      }
      shapeEl.setAttribute('vector-effect', 'non-scaling-stroke');
      g.append(shapeEl);
      if (opts.onZone) g.addEventListener('click', (e) => { e.stopPropagation(); opts.onZone(z); });
      svg.append(g);
    }
  }

  function drawLabels() {
    for (const n of stage.querySelectorAll('.mv-label')) n.remove();
    if (!map || !(gm || opts.labels)) return;
    for (const z of map.zones || []) {
      const s = z.shape;
      const x = s.points ? s.points.reduce((a, p) => a + p[0], 0) / s.points.length : s.x + s.w / 2;
      const y = s.points ? s.points.reduce((a, p) => a + p[1], 0) / s.points.length : s.y + s.h / 2;
      stage.append(h('span.mv-label', { class: `mv-label${isRevealed(z) ? ' on' : ''}`, style: { left: `${x * 100}%`, top: `${y * 100}%` } }, z.name));
    }
  }

  function drawTokens() {
    tokens.replaceChildren();
    if (!map || !map.tokensOn) return;
    for (const t of map.tokens || []) {
      const mine = canMoveToken(t);
      const tk = h('div.mv-tok', {
        class: `mv-tok mv-${t.kind}${t.hidden ? ' hid' : ''}${mine ? ' mine' : ''}`,
        style: { left: `${t.x * 100}%`, top: `${t.y * 100}%`, '--tk': t.color },
        title: t.label,
      }, h('span', t.label.slice(0, 2).toUpperCase()));
      if (mine && onTokenMove) {
        tk.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          tk.setPointerCapture(e.pointerId);
          tk.classList.add('drag');
          const move = (ev) => { const p = toLocal(ev); tk.style.left = `${p.x * 100}%`; tk.style.top = `${p.y * 100}%`; };
          const up = (ev) => {
            tk.removeEventListener('pointermove', move);
            tk.removeEventListener('pointerup', up);
            tk.classList.remove('drag');
            const p = toLocal(ev);
            onTokenMove(t, p.x, p.y);
          };
          tk.addEventListener('pointermove', move);
          tk.addEventListener('pointerup', up);
        });
      }
      tokens.append(tk);
    }
  }

  // GM drag: a rectangle for a zone, a reveal or a cover.
  if (onDrag) {
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.mv-tok')) return;
      const a = toLocal(e);
      let b = a;
      stage.setPointerCapture(e.pointerId);
      const show = () => {
        sel.hidden = false;
        Object.assign(sel.style, { left: `${Math.min(a.x, b.x) * 100}%`, top: `${Math.min(a.y, b.y) * 100}%`, width: `${Math.abs(b.x - a.x) * 100}%`, height: `${Math.abs(b.y - a.y) * 100}%` });
      };
      const move = (ev) => { b = toLocal(ev); show(); };
      const up = (ev) => {
        stage.removeEventListener('pointermove', move);
        stage.removeEventListener('pointerup', up);
        sel.hidden = true;
        b = toLocal(ev);
        const rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
        if (rect.w > 0.01 && rect.h > 0.01) onDrag(rect, ev);
      };
      stage.addEventListener('pointermove', move);
      stage.addEventListener('pointerup', up);
    });
  }

  function set(m, o = {}) {
    map = m;
    opts = o;
    if (!m) { el.hidden = true; return; }
    el.hidden = false;
    stage.style.aspectRatio = String(m.aspect || 1.5);
    fitNow();
    if (img.getAttribute('src') !== m.image) img.src = m.image;
    const sig = JSON.stringify([m.fog, m.zones, m.tokens, m.tokensOn, o.selected, o.labels]);
    if (sig === lastSig) return;
    lastSig = sig;
    drawFog();
    drawZones();
    drawLabels();
    drawTokens();
  }

  return { el, set, toLocal };
}
