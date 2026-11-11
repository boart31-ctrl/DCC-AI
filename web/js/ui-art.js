// Pack UI art (ui.json → view.pack.ui, see docs/CONTENT_PACKS.md) for the TV and phones.
// Every helper returns null / does nothing when an asset is missing, so callers keep today's CSS or
// procedural look. Animations: a sprite strip moved with transform + steps() (cheap on TV browsers),
// else the animated WebP; prefers-reduced-motion (or { still: true }) gets the still frame.
import { h } from './client.js';

const reducedMq = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)'); } catch { return null; } })();
export const reducedMotion = () => !!reducedMq?.matches;

export const uiOf = (view) => view?.pack?.ui || null;

/** Lowercase id slug for free-text keys (achievement groups, sponsor names): "Death-Adjacent" → "death_adjacent". */
export const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** First asset found: uiAsset(ui, 'mascot', ['smug', 'neutral']) or uiAsset(ui, 'floors', ['2', 'default'], ['boss', 'combat', 'default']). */
export function uiAsset(ui, section, ...keyLists) {
  let nodes = [ui?.[section]];
  if (!nodes[0]) return null;
  if (!keyLists.length) return isAsset(nodes[0]) ? nodes[0] : null;
  for (const keys of keyLists) {
    const next = [];
    for (const n of nodes) for (const k of [].concat(keys)) if (k != null && n?.[k]) next.push(n[k]);
    nodes = next;
    if (!nodes.length) return null;
  }
  return nodes.find(isAsset) || null;
}
const isAsset = (a) => !!a && typeof a.src === 'string';

/** The picture to show for an asset right now (still under reduced motion). */
export function assetSrc(a, { still = false } = {}) {
  if (!a) return null;
  return (still || reducedMotion()) && a.still ? a.still : a.src;
}

/**
 * Element for an asset: sprite-strip window, or <img>. opts: { cls, still, once, onEnd, onError }.
 * A broken file removes the element and calls onError (so the caller can restore its fallback).
 */
export function artEl(a, { cls = '', still = false, once = false, onEnd, onError } = {}) {
  if (!a) return null;
  const st = a.strip;
  if (st && !still && !reducedMotion()) {
    const strip = h('img.ua-strip', { alt: '', decoding: 'async', src: st.src, draggable: 'false' });
    const loop = st.loop && !once;
    strip.style.width = `${st.frames * 100}%`;
    strip.style.animation = `ua-strip ${(st.frames / st.fps).toFixed(3)}s steps(${st.frames}) ${loop ? 'infinite' : '1'}`;
    const win = h('div.ua-sprite', { class: `ua-sprite ${cls}`.trim(), 'aria-hidden': 'true', style: { aspectRatio: `${st.w} / ${st.h}` } }, strip);
    if (!loop && onEnd) strip.addEventListener('animationend', onEnd, { once: true });
    strip.onerror = () => { win.remove(); onError?.(); };
    return win;
  }
  const img = h('img', { class: `ua-img ${cls}`.trim(), alt: '', decoding: 'async', draggable: 'false' });
  img.onerror = () => { img.remove(); onError?.(); };
  img.src = assetSrc(a, { still });
  if (once && onEnd) setTimeout(onEnd, 900);
  return img;
}

/** Four mirrored copies of a top-left corner ornament (rarity frame) to lay over a card. */
export function cornerFrame(a, cls = 'ua-frame') {
  if (!a) return null;
  const src = assetSrc(a, { still: true });
  return h('div', { class: cls, 'aria-hidden': 'true' },
    ['tl', 'tr', 'bl', 'br'].map((c) => h('img', { class: c, src, alt: '', decoding: 'async', onerror: (e) => e.target.parentNode?.remove() })));
}

/* ---------- System mascot ---------- */

// Mood per moment, with fallbacks (the art director's SYS sheets: neutral, smug, delighted, angry, bored,
// suspicious, glitch, shocked, fake_sad, pointing, presenting, facepalm, laughing, ...).
export const MOODS = {
  achievement: ['delighted', 'presenting', 'smug', 'neutral'],
  announcement: ['presenting', 'neutral'],
  recap: ['smug', 'neutral'],
  loot: ['presenting', 'delighted', 'neutral'],
  sponsor: ['delighted', 'presenting', 'neutral'],
  nat1: ['laughing', 'smug', 'neutral'],
  defeat: ['glitch', 'fake_sad', 'neutral'],
  victory: ['delighted', 'neutral'],
  idle: ['idle', 'neutral'],
};

let speaking = false;
const speakers = new Set();
/** The System voice started / stopped (subtitle shown): mascots switch to their talking art. */
export function setSpeaking(on) {
  if (speaking === !!on) return;
  speaking = !!on;
  for (const el of speakers) {
    if (!el.isConnected) { speakers.delete(el); continue; }
    el.classList.toggle('talking', speaking);
  }
}

/**
 * Mascot element for a moment (`moodKey` from MOODS or an explicit mood name / list). Shows the mood
 * art; while the System speaks, the talking animation (when the pack has one). null without art.
 */
export function mascotEl(ui, moodKey, cls = 'ua-mascot') {
  const moods = MOODS[moodKey] || [].concat(moodKey || [], 'neutral');
  const mood = uiAsset(ui, 'mascot', moods);
  const talk = uiAsset(ui, 'mascot', ['talking', 'talk']);
  if (!mood && !talk) return null;
  const el = h('div', { class: cls, 'aria-hidden': 'true' });
  const still = artEl(mood || talk, { cls: 'm-mood' });
  if (still) el.append(still);
  if (talk && talk !== mood) {
    const t = artEl(talk, { cls: 'm-talk' });
    if (t) { el.append(t); el.classList.add('can-talk'); }
  }
  el.classList.toggle('talking', speaking);
  speakers.add(el);
  return el;
}

/* ---------- floors ---------- */

let floor = null;
/** Remember the floor the show is on (boss / explore scenes name it); combat and lobby reuse it. */
export function noteFloor(view) {
  const sc = view?.scene;
  const d = sc?.data || {};
  const raw = sc?.kind === 'boss' ? d.boss?.floor : sc?.kind === 'explore' ? d.floor : null;
  const m = String(raw ?? '').match(/-?\d+/);
  if (m) floor = m[0];
  return floor;
}
export const currentFloor = () => floor;

const SCENE_BG = { boss: ['boss', 'combat', 'default'], combat: ['combat', 'default'], lobby: ['lobby', 'default'], explore: ['explore', 'default'] };
/** Floor background asset for a scene kind, or null. */
export function floorBg(ui, kind, fl = floor) {
  return uiAsset(ui, 'floors', [fl, 'default'].filter((x) => x != null), SCENE_BG[kind] || ['default']);
}

/** Backdrop layer for a scene (dimmed by CSS so the UI stays readable). Updates in place. */
export function floorLayer(kind) {
  const el = h('div.ua-floorbg', { 'aria-hidden': 'true' });
  let cur = '';
  return {
    el,
    update(view, fl) {
      const a = floorBg(uiOf(view), kind, fl ?? floor);
      const src = assetSrc(a) || '';
      if (src === cur) return;
      cur = src;
      el.replaceChildren();
      el.classList.remove('on');
      if (!a) return;
      const img = artEl(a, { onError: () => el.classList.remove('on') });
      if (img.tagName === 'IMG') img.onload = () => el.classList.add('on');
      else el.classList.add('on');
      el.append(img);
    },
  };
}

/* ---------- preloading (TV) ---------- */

const cache = new Map(); // url → Image (kept so the decoded bitmap stays warm)
const CACHE_MAX = 48;
export function preload(urls) {
  for (const u of urls) {
    if (!u || typeof u !== 'string') continue;
    if (cache.has(u)) { const v = cache.get(u); cache.delete(u); cache.set(u, v); continue; }
    const img = new Image();
    img.decoding = 'async';
    img.src = u;
    img.decode?.().catch(() => {});
    cache.set(u, img);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
}
const urlsOf = (a) => (a ? [assetSrc(a), a.strip && !reducedMotion() ? a.strip.src : null] : []);

/**
 * What the TV will likely show next: the current scene's art + the probable next step (boss phases and
 * defeat pose on a boss scene, the fight's mobs and the finale on a combat, the tier crate on loot).
 */
export function preloadFor(view) {
  const ui = uiOf(view);
  const sc = view?.scene;
  const d = sc?.data || {};
  const out = [];
  const add = (...a) => { for (const x of a) out.push(...urlsOf(x)); };
  if (ui) {
    // Small, used by takeovers at any moment.
    for (const m of ['neutral', 'delighted', 'presenting', 'smug', 'talking']) add(ui.mascot?.[m]);
    add(ui.logo);
  }
  const fl = noteFloor(view);
  const combatOn = !!view?.combat?.active || sc?.kind === 'combat';
  if (sc?.kind === 'boss') {
    const b = d.boss || {};
    out.push(b.image, b.imageKo, ...(b.phases || []).map((p) => p?.image));
    add(floorBg(ui, 'boss', fl), uiAsset(ui, 'finale', ['victory']));
  }
  if (combatOn) {
    for (const x of view?.combat?.combatants || []) if (x.type === 'mob') out.push(x.image);
    add(floorBg(ui, 'combat', fl), uiAsset(ui, 'finale', ['victory']), uiAsset(ui, 'finale', ['defeat']), uiAsset(ui, 'fx', ['impact']), uiAsset(ui, 'dice', ['d20'], ['body']));
  }
  if (sc?.kind === 'lobby') add(floorBg(ui, 'lobby', fl));
  if (sc?.kind === 'explore') add(floorBg(ui, 'combat', fl)); // a fight is the usual next step
  if (sc?.kind === 'loot') {
    const tier = d.tier || d.tierInfo?.id;
    for (const s of ['closed', 'idle', 'opening', 'open']) add(uiAsset(ui, 'lootBoxes', [tier, 'default'], [s]));
  }
  preload(out.filter(Boolean));
}
