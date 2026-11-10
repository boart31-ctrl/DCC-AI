// Art for bestiary entries (monsters, bosses, NPCs, locations) on the GM desk: the pack / URL image
// when it loads, else a generated silhouette in the entry's colour (never a broken image).
import { h } from './client.js';
import { bossSvg } from './scenes/common.js';

/** "goblin.webp" → "/pack/images/goblin.webp"; URLs, /pack/ paths and data: URLs pass through. */
export function imageRef(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^(https?:\/\/|\/pack\/|data:image\/)/.test(s)) return s;
  return `/pack/images/${s.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`;
}

/** Portrait element: <img> with a generated fallback. opts: { cls, lit } */
export function entryArt(entry, { cls = 'art', lit = true } = {}) {
  const wrap = h('div', { class: `${cls} art-wrap` });
  const fallback = () => {
    wrap.classList.add('gen');
    wrap.innerHTML = bossSvg({ name: entry?.name || '?', color: entry?.color || null }, { lit });
  };
  const src = imageRef(entry?.image);
  if (src) {
    const img = h('img', { alt: '', decoding: 'async', loading: 'lazy' });
    img.onerror = () => { img.remove(); fallback(); };
    img.src = src;
    wrap.append(img);
  } else fallback();
  return wrap;
}
