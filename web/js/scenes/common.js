// Shared bits for the TV scenes: timers bound to a scene's lifetime, the party strip with HP
// slots, boss art with a generated silhouette fallback, and small text helpers.
// TV budget: transforms + opacity only, no animated filters, no canvas.
import { h, portraitSrc } from '../client.js';

export { h };

/** Level badge of a crawler; with a portrait the picture fills the badge and the level sits on it. */
export function levelBadge(cls, p, level) {
  const url = portraitSrc(p?.portrait);
  const el = h(`div.${cls}`, { class: url ? `${cls} has-face` : cls }, h('small', 'Lv'), h('b', String(level ?? 1)));
  if (url) el.prepend(h('img.face', { src: url, alt: '', decoding: 'async' }));
  return el;
}

/** Timers that die with the scene (no stray callbacks after a transition). */
export function timers() {
  const ids = new Set();
  const iv = new Set();
  return {
    after(ms, fn) {
      const id = setTimeout(() => { ids.delete(id); fn(); }, ms);
      ids.add(id);
      return id;
    },
    every(ms, fn) {
      const id = setInterval(fn, ms);
      iv.add(id);
      return id;
    },
    stop(id) { clearTimeout(id); clearInterval(id); ids.delete(id); iv.delete(id); },
    clear() {
      for (const id of ids) clearTimeout(id);
      for (const id of iv) clearInterval(id);
      ids.clear();
      iv.clear();
    },
  };
}

/** Restart a CSS animation class on an element. */
export function replay(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

export function hash(s) {
  let x = 2166136261;
  for (const c of String(s || '')) x = Math.imul(x ^ c.charCodeAt(0), 16777619) >>> 0;
  return x;
}

const THREATS = ['#ff2448', '#ff2fb9', '#b44dff', '#ff8a1c', '#2ef2ff', '#e4ff2e'];
export function threatColor(boss) {
  if (boss?.color && /^#[0-9a-f]{3,8}$/i.test(boss.color)) return boss.color;
  return THREATS[hash(boss?.name) % THREATS.length];
}

/** Hex → "r, g, b" for rgba() (no color-mix on old TV browsers). */
export function rgb(hex) {
  let x = String(hex || '#ffffff').replace('#', '');
  if (x.length === 3) x = x.split('').map((c) => c + c).join('');
  const n = parseInt(x.slice(0, 6), 16) || 0;
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/* ---------- generated boss art (never a broken image) ---------- */

const SHAPES = [
  // horned brute
  { body: 'M60,500 C60,400 80,330 130,300 C110,262 118,222 150,200 C140,160 118,128 84,88 C128,106 158,136 172,166 C188,152 212,152 228,166 C242,136 272,106 316,88 C282,128 260,160 250,200 C282,222 290,262 270,300 C320,330 340,400 340,500 Z', eyes: [[182, 214], [218, 214]] },
  // hooded caster
  { body: 'M64,500 C88,384 118,300 150,252 C146,182 168,122 200,74 C232,122 254,182 250,252 C282,300 312,384 336,500 Z', inner: 'M164,232 C164,180 182,150 200,138 C218,150 236,180 236,232 C224,248 176,248 164,232 Z', eyes: [[186, 206], [214, 206]] },
  // crowned
  { body: 'M80,500 C90,410 112,340 150,312 C138,282 148,242 166,226 L158,148 L182,188 L200,126 L218,188 L242,148 L234,226 C252,242 262,282 250,312 C288,340 310,410 320,500 Z', eyes: [[184, 258], [216, 258]] },
  // many-eyed mass
  { body: 'M40,500 C30,420 60,330 120,290 C128,204 170,160 200,160 C230,160 272,204 280,290 C340,330 370,420 360,500 L330,500 C330,462 310,444 300,472 L292,500 L250,500 C250,462 230,452 220,480 L214,500 L186,500 C180,452 160,462 156,500 L110,500 C110,462 90,452 80,500 Z', eyes: [[172, 232], [204, 214], [236, 240], [192, 262], [222, 270]] },
];

/** SVG markup for a generated boss portrait. `lit: false` = pure silhouette (pre-reveal). */
export function bossSvg(boss, { lit = true } = {}) {
  const c = threatColor(boss);
  const s = SHAPES[hash(boss?.name) % SHAPES.length];
  const id = `g${hash(`${boss?.name}${lit}`) % 1e6}`;
  const eyes = lit ? s.eyes.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="18" fill="${c}" opacity=".35"/><circle cx="${x}" cy="${y}" r="9" fill="${c}"/><circle cx="${x}" cy="${y}" r="4.5" fill="#fff"/>`).join('') : '';
  const initial = String(boss?.name || '?').replace(/^the\s+/i, '').trim().charAt(0).toUpperCase() || '?';
  const rays = lit ? Array.from({ length: 18 }, (_, i) => {
    const a = (i / 18) * Math.PI * 2;
    return `<line x1="200" y1="300" x2="${(200 + Math.cos(a) * 420).toFixed(0)}" y2="${(300 + Math.sin(a) * 420).toFixed(0)}"/>`;
  }).join('') : '';
  return `<svg viewBox="0 0 400 500" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
  <defs>
    <radialGradient id="${id}b" cx="50%" cy="62%" r="65%"><stop offset="0" stop-color="${c}" stop-opacity="${lit ? 0.95 : 0.45}"/><stop offset=".4" stop-color="${c}" stop-opacity="${lit ? 0.3 : 0.12}"/><stop offset="1" stop-color="#05020a" stop-opacity="0"/></radialGradient>
    <linearGradient id="${id}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${lit ? '#fff' : '#000'}" stop-opacity="${lit ? 0.18 : 1}"/><stop offset=".12" stop-color="${lit ? c : '#000'}" stop-opacity="${lit ? 0.75 : 1}"/><stop offset=".55" stop-color="#1a0a2e"/><stop offset="1" stop-color="#05020a"/></linearGradient>
    <pattern id="${id}s" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="#fff" opacity=".06"/></pattern>
  </defs>
  <rect width="400" height="500" fill="#07030f"/>
  <g stroke="${c}" stroke-opacity=".16" stroke-width="10">${rays}</g>
  <rect width="400" height="500" fill="url(#${id}b)"/>
  <g fill="none" stroke="${c}" stroke-opacity="${lit ? 0.35 : 0.18}" stroke-width="2"><circle cx="200" cy="300" r="110"/><circle cx="200" cy="300" r="165"/><circle cx="200" cy="300" r="225"/></g>
  <text x="200" y="230" text-anchor="middle" font-family="Barlow Condensed, sans-serif" font-style="italic" font-weight="900" font-size="300" fill="${c}" fill-opacity="${lit ? 0.16 : 0.05}">${initial.replace(/[<&>"]/g, '')}</text>
  <path d="${s.body}" fill="url(#${id}f)"/>
  <path d="${s.body}" fill="none" stroke="${lit ? '#fff' : c}" stroke-width="${lit ? 2 : 3}" stroke-opacity="${lit ? 0.9 : 0.6}"/>
  ${lit ? `<path d="${s.body}" fill="none" stroke="${c}" stroke-width="10" stroke-opacity=".35"/>` : ''}
  ${s.inner ? `<path d="${s.inner}" fill="#020005"/>` : ''}
  ${eyes}
  <rect width="400" height="500" fill="url(#${id}s)"/>
</svg>`;
}

export function svgDataUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Boss portrait element. Pack/URL art when it loads; otherwise the generated portrait.
 * Calls onUrl(url) with whatever ended up shown (used by the defeat shatter).
 */
export function bossArt(boss, { lit = true, onUrl } = {}) {
  const wrap = h('div.b-art');
  const fallback = () => {
    wrap.classList.add('gen');
    wrap.innerHTML = bossSvg(boss, { lit });
    onUrl?.(svgDataUrl(bossSvg(boss, { lit: true })));
  };
  if (boss?.image) {
    const img = h('img', { alt: '', decoding: 'async' });
    img.onerror = fallback;
    img.onload = () => onUrl?.(img.src);
    img.src = boss.image;
    wrap.append(img);
  } else fallback();
  return wrap;
}

/* ---------- party strip with HP slots ---------- */

function trackEl(t, big) {
  const max = Math.max(0, Number(t.max) || 0);
  const cur = Math.max(0, Math.min(max, Number(t.cur) || 0));
  const low = max > 0 && cur / max <= 0.3;
  const style = { '--tc': t.color || '#ff3355' };
  if ((t.kind === 'slots' || max <= 20) && max > 0 && big) {
    return h('div.ps-track.slots', { style, class: low ? 'ps-track slots low' : 'ps-track slots', title: `${t.label} ${cur}/${max}` },
      h('div.ps-pips', Array.from({ length: max }, (_, i) => h('i', { class: i < cur ? 'on' : '' }))),
      h('b.ps-num', `${cur}`));
  }
  return h('div.ps-track.bar', { style, class: low ? 'ps-track bar low' : 'ps-track bar' },
    h('div.ps-fill', { style: { transform: `scaleX(${max ? cur / max : 0})` } }),
    big ? h('b.ps-num', `${cur}/${max}`) : null);
}

/** Bottom strip: crawlers with level, name and up to two tracks (HP as slots). */
export function partyStrip() {
  const el = h('div.party-strip');
  let sig = '';
  function update(view) {
    const ps = view?.players || [];
    const party = new Map((view?.scene?.party || []).map((p) => [p.id, p]));
    const s = JSON.stringify([ps, view?.scene?.party]);
    if (s === sig) return;
    const prev = new Map([...el.children].map((c) => [c.dataset.id, c.dataset.hp]));
    sig = s;
    if (!ps.length) { el.replaceChildren(h('p.ps-empty', 'No crawlers yet')); return; }
    el.replaceChildren(...ps.map((p) => {
      const tr = party.get(p.id)?.tracks || [];
      const hp = tr[0];
      const card = h('div.ps-card', {
        class: `ps-card${p.connected ? '' : ' off'}${hp && hp.max && hp.cur <= 0 ? ' down' : ''}`,
        'data-id': p.id, 'data-hp': hp ? String(hp.cur) : '',
        style: { '--pc': p.color || '#2ef2ff' },
      },
      levelBadge('ps-lvl', p, p.level),
      h('div.ps-main',
        h('div.ps-name', p.name),
        tr.map((t, i) => trackEl(t, i === 0))),
      );
      const was = prev.get(p.id);
      if (hp && was !== undefined && was !== '' && Number(was) !== hp.cur) {
        card.classList.add(Number(was) > hp.cur ? 'hurt' : 'healed');
      }
      return card;
    }));
  }
  return { el, update };
}

/** Clock offset so a countdown computed from server timestamps survives reloads and skew. */
export function serverClock() {
  let offset = 0;
  return {
    sync(serverNow) { if (Number.isFinite(serverNow)) offset = serverNow - Date.now(); },
    now() { return Date.now() + offset; },
  };
}

export function fmtClock(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = t % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}

/** Word-by-word typewriter; returns a cancel function. */
export function typeText(el, text, ms, T) {
  const words = String(text || '').split(/(\s+)/);
  if (!ms || words.length < 3) { el.textContent = text || ''; return; }
  el.textContent = '';
  let i = 0;
  const step = Math.max(16, ms / words.length) * 2;
  const id = T.every(step, () => {
    i = Math.min(words.length, i + 2);
    el.textContent = words.slice(0, i).join('');
    if (i >= words.length) T.stop(id);
  });
}

export const reducedMotion = () => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};
