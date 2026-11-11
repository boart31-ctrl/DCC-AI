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
  const src = imageRef(entry?.imageSquare || entry?.image); // bosses: the square crop fits the card
  if (src) {
    const img = h('img', { alt: '', decoding: 'async', loading: 'lazy' });
    img.onerror = () => { img.remove(); fallback(); };
    img.src = src;
    wrap.append(img);
  } else fallback();
  return wrap;
}

/**
 * Lets the user pick a picture (phone camera roll / file), crops the centre square, scales it to at
 * most 512 px and encodes WebP (JPEG where WebP encoding is missing) under ~150 KB, so it fits the
 * engine's portrait cap (data URL ≤ 200 000 chars). Resolves a data: URL, or null when cancelled.
 */
export function pickPortrait({ maxSide = 512, maxChars = 195_000 } = {}) {
  return new Promise((resolve, reject) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
    input.style.display = 'none';
    document.body.append(input);
    const done = (v, err) => { input.remove(); err ? reject(err) : resolve(v); };
    input.addEventListener('cancel', () => done(null));
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return done(null);
      try {
        const bmp = await loadImage(file);
        const side = Math.min(bmp.width, bmp.height);
        let size = Math.min(maxSide, side);
        for (let attempt = 0; attempt < 6; attempt++) {
          const c = document.createElement('canvas');
          c.width = c.height = size;
          const g = c.getContext('2d');
          g.imageSmoothingQuality = 'high';
          g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
          for (const q of [0.82, 0.7, 0.58]) {
            let url = c.toDataURL('image/webp', q);
            if (!url.startsWith('data:image/webp')) url = c.toDataURL('image/jpeg', q);
            if (url.length <= maxChars) return done(url);
          }
          size = Math.round(size * 0.75);
        }
        done(null, new Error('That picture is too detailed to shrink enough. Try another one.'));
      } catch (e) {
        done(null, new Error('Could not read that picture.'));
      }
    });
    input.click();
  });
}

function loadImage(file) {
  if (window.createImageBitmap) return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => viaImg(file));
  return viaImg(file);
}
function viaImg(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(img.src); res(img); };
    img.onerror = () => rej(new Error('bad image'));
    img.src = URL.createObjectURL(file);
  });
}
