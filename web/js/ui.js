// Tool-UI primitives shared by the player sheet and the GM desk: icons, signed numbers,
// the "why" breakdown popover, drawers, segmented tabs, steppers and small form helpers.
import { h, portraitSrc } from './client.js';

/* ---------------- icons (24px grid, 1.75 stroke, currentColor) ---------------- */

const PATHS = {
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
  dice: 'M5 5h14v14H5zM9 9h.01M15 9h.01M12 12h.01M9 15h.01M15 15h.01',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  chevron: 'M9 6l6 6-6 6',
  down: 'M6 9l6 6 6-6',
  star: 'M12 4l2.5 5 5.5.8-4 3.9.9 5.5L12 16.6 7.1 19.2 8 13.7 4 9.8 9.5 9z',
  eyeOff: 'M3 3l18 18M10.6 6.1A9.6 9.6 0 0 1 12 6c5 0 9 6 9 6a16 16 0 0 1-3.2 3.7M6.4 6.4C4.2 8 3 12 3 12s4 6 9 6c1.6 0 3-.4 4.3-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2',
  warn: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  copy: 'M8 8h11v11H8zM5 16V5h11',
  gift: 'M4 11h16v9H4zM3 7h18v4H3zM12 7v13M12 7c-2-4-6-3-5 0M12 7c2-4 6-3 5 0',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7.5M22 21v-1a6 6 0 0 0-4-5.6',
  swords: 'M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M9.5 17.5L21 6V3h-3L6.5 14.5M11 19l-6-6M8 16l-4 4M5 21l-2-2',
  book: 'M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z',
  tv: 'M3 6h18v12H3zM8 21h8M12 18v3',
  map: 'M9 4L3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  log: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  bolt: 'M13 3L4 14h7l-1 7 9-11h-7z',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  copyPlus: 'M8 8h11v11H8zM5 16V5h11M13.5 11v5M11 13.5h5',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  skull: 'M12 3a8 8 0 0 0-5 14.2V20h10v-2.8A8 8 0 0 0 12 3zM9 12h.01M15 12h.01M10 20v-2M14 20v-2',
  chat: 'M4 5h16v11H9l-5 4z',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2zM16 16h2v2h-2z',
  phone: 'M7 3h10v18H7zM11 18h2',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  back: 'M15 6l-6 6 6 6',
  check: 'M5 12l5 5 9-10',
  share: 'M12 4v11M8 8l4-4 4 4M5 14v6h14v-6',
};

export function icon(name, { size = 16, label } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('class', 'ic');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); } else svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', PATHS[name] || PATHS.info);
  svg.append(p);
  return svg;
}

/* ---------------- numbers ---------------- */

/** "+3", "−1", "0" with a real minus sign. */
export function signed(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  if (v > 0) return `+${v}`;
  if (v < 0) return `−${Math.abs(v)}`;
  return '0';
}
export const minus = (s) => String(s ?? '').replace(/-/g, '−');

const SOURCE_LABEL = { item: 'Item', buff: 'Buff', external: 'External buff', spell: 'Spell', feature: 'Feature', gm: 'GM', base: 'Base', formula: '', stat: '', dice: 'Dice', race: 'Race', class: 'Class', background: 'Background' };
/** Engine sources look like "item:i_1", "buff:b_2", "mod.dex", "derived.evade". */
function srcLabel(src) {
  if (!src || typeof src !== 'string') return src?.kind ? (SOURCE_LABEL[src.kind] ?? '') : '';
  const k = src.split(/[:.]/)[0];
  if (src.includes(':')) return SOURCE_LABEL[k] ?? '';
  return SOURCE_LABEL[src] ?? '';
}

/* ---------------- why popover ---------------- */

let pop = null;
let popFor = null;
let popTimer = 0;

function ensurePop() {
  if (pop) return pop;
  pop = h('div.why-pop.tool', { role: 'tooltip', id: 'why-pop', hidden: true });
  document.body.append(pop);
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !popFor?.contains(e.target)) hideWhy();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { hideWhy(); e.stopPropagation(); } }, true);
  window.addEventListener('scroll', () => hideWhy(), { passive: true, capture: true });
  return pop;
}

export function hideWhy() {
  if (!pop) return;
  pop.hidden = true;
  popFor?.removeAttribute('aria-describedby');
  popFor = null;
}

/**
 * Breakdown content: "Evade 9 = DEX mod 3 + Ring of Dodging 2 + Hasted 2", one row per part,
 * grouped by source, plus warnings.
 */
export function whyContent(b, { title, prefix, note } = {}) {
  const parts = b?.parts || [];
  const warn = (b?.warnings || []);
  return h('div.why',
    h('div.why-head',
      h('span.why-title', title || 'Breakdown'),
      h('span.why-total', prefix ? `${prefix} ${signed(b?.value)}` : String(b?.value ?? 0)),
    ),
    parts.length
      ? h('ol.why-parts', parts.flatMap((p, i) => [h('li', { class: Number(p.value) < 0 ? 'neg' : null },
        h('span.op', i === 0 ? '' : Number(p.value) < 0 ? '−' : '+'),
        h('span.v', String(i === 0 ? minus(p.value) : Math.abs(Number(p.value) || 0))),
        h('span.l', p.label || p.source || '·', p.rolls?.length > 1 ? h('span.src', ` [${p.rolls.join(', ')}]`) : null),
        srcLabel(p.source) ? h('span.src', srcLabel(p.source)) : null,
      ), ...(p.parts?.length && !(p.parts.length === 1 && p.parts[0].label === p.label) ? p.parts.map((q) => h('li.sub', { class: Number(q.value) < 0 ? 'sub neg' : 'sub' },
        h('span.op', ''), h('span.v', signed(q.value)), h('span.l', q.label || q.source || '·'), srcLabel(q.source) ? h('span.src', srcLabel(q.source)) : null)) : [])]))
      : h('p.why-empty', 'No parts. The number is set directly.'),
    note ? h('p.why-note', note) : null,
    warn.map((w) => h('p.why-warn', { class: w.kind === 'unverified' ? 'why-warn unverified' : 'why-warn' }, icon('warn', { size: 13 }), w.kind === 'unverified' ? `Unverified rule${w.path ? ` (${w.path})` : ''}. ${w.note || w.msg || ''}` : (w.msg || w.note || (w.name ? `Unknown "${w.name}" counted as 0` : w.kind)))),
  );
}

/** Phones: the breakdown is a bottom sheet (readable, thumb-closable) instead of a tiny bubble. */
const sheetMode = () => window.innerWidth <= 600;

function place(el) {
  pop.classList.toggle('as-sheet', sheetMode());
  if (sheetMode()) {
    pop.style.left = '';
    pop.style.top = '';
    pop.hidden = false;
    return;
  }
  const r = el.getBoundingClientRect();
  pop.style.left = '0px';
  pop.style.top = '0px';
  pop.hidden = false;
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  let x = r.left + r.width / 2 - pw / 2;
  x = Math.max(8, Math.min(window.innerWidth - pw - 8, x));
  let y = r.bottom + 6;
  if (y + ph > window.innerHeight - 8) y = Math.max(8, r.top - ph - 6);
  pop.style.left = `${Math.round(x)}px`;
  pop.style.top = `${Math.round(y)}px`;
}

export function showWhy(el, content) {
  ensurePop();
  pop.replaceChildren(typeof content === 'function' ? content() : content);
  if (sheetMode()) pop.append(h('button.btn.why-close', { type: 'button', onclick: () => hideWhy() }, 'Close'));
  popFor = el;
  el.setAttribute('aria-describedby', 'why-pop');
  place(el);
}

/**
 * Makes `el` explain itself. Mouse: hover shows the breakdown. Touch: long-press shows it; a tap
 * runs `onTap` when given (roll), else toggles the breakdown. Keyboard: focus shows it.
 */
export function explain(el, getContent, { onTap } = {}) {
  el.classList.add('has-why');
  let pressTimer = 0;
  let longPressed = false;
  el.addEventListener('pointerenter', (e) => {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(popTimer);
    popTimer = setTimeout(() => showWhy(el, getContent), 260);
  });
  el.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(popTimer);
    if (popFor === el) popTimer = setTimeout(hideWhy, 120);
  });
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    longPressed = false;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => { longPressed = true; showWhy(el, getContent); try { navigator.vibrate?.(8); } catch {} }, 450);
  });
  const cancel = () => clearTimeout(pressTimer);
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', (e) => { if (longPressed) e.preventDefault(); });
  el.addEventListener('focus', () => { if (el.matches(':focus-visible')) showWhy(el, getContent); });
  el.addEventListener('blur', () => { if (popFor === el) hideWhy(); });
  el.addEventListener('click', (e) => {
    if (longPressed) { longPressed = false; e.preventDefault(); return; }
    if (onTap) { hideWhy(); onTap(e); return; }
    if (popFor === el && !pop.hidden) hideWhy(); else showWhy(el, getContent);
  });
  return el;
}

/** The small marker next to numbers whose rule the pack author has not verified. */
export function unverifiedBadge(msg = 'Not checked against the rulebook') {
  return h('span.unverified', { title: `Unverified rule. ${msg}`, 'aria-label': 'Unverified rule' }, '?');
}

export function hasUnverified(b, warnings, key) {
  // Only a rule that belongs to this one number gets a badge here (e.g. derived.move). Shared rules
  // (statMod, skills.check, …) are flagged once on their section so the sheet does not fill with markers.
  if (!key) return false;
  const mine = (w) => w.kind === 'unverified' && [w.path, w.target, w.id].some((t) => t === key || t === `derived.${key}`);
  const own = (b?.warnings || []).find(mine);
  if (own) return own.note || own.msg || true;
  if (b?.warnings) return false;
  const w = (warnings || []).find((x) => x.kind === 'unverified' && key && [x.target, x.id, x.path].some((t) => t && (t === key || String(t).endsWith(`.${key}`) || String(t) === key)));
  return w ? (w.msg || true) : false;
}

/* ---------------- drawer (side panel on wide screens, bottom sheet on phones) ---------------- */

let drawerEl = null;
let drawerClose = null;
export function openDrawer({ title, sub, body, actions, onClose, wide = false }) {
  closeDrawer(true);
  const dlg = h('dialog.drawer', { class: wide ? 'drawer tool wide' : 'drawer tool', 'aria-label': title });
  const close = () => closeDrawer();
  dlg.append(
    h('header.drawer-head',
      h('div.drawer-titles', h('h2.drawer-title', title), sub ? h('p.drawer-sub', sub) : null),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: close }, icon('x', { size: 18 })),
    ),
    h('div.drawer-body', body),
    actions ? h('footer.drawer-foot', actions) : null,
  );
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  document.body.append(dlg);
  dlg.showModal();
  drawerEl = dlg;
  drawerClose = onClose || null;
  return dlg;
}
export function closeDrawer(silent = false) {
  if (!drawerEl) return;
  const d = drawerEl;
  drawerEl = null;
  try { d.close(); } catch {}
  d.remove();
  const fn = drawerClose;
  drawerClose = null;
  if (!silent) fn?.();
}
export const drawerOpen = () => !!drawerEl;

/* ---------------- small widgets ---------------- */

export function stepper(value, { onChange, min = -Infinity, max = Infinity, label = 'value', disabled = false, step = 1 } = {}) {
  const v = Number(value) || 0;
  return h('span.stepper', { class: disabled ? 'stepper is-locked' : 'stepper' },
    h('button', { type: 'button', 'aria-label': `${label} minus ${step}`, disabled: disabled || v - step < min, onclick: () => onChange(v - step) }, icon('minus', { size: 14 })),
    h('span.stepper-v', String(v)),
    h('button', { type: 'button', 'aria-label': `${label} plus ${step}`, disabled: disabled || v + step > max, onclick: () => onChange(v + step) }, icon('plus', { size: 14 })),
  );
}

/** Segmented tab bar. `items` = [{id, label, count?, badge?}] */
export function tabBar(items, active, onPick, { label = 'Sections', cls = '' } = {}) {
  const bar = h('div.tabbar', { role: 'tablist', 'aria-label': label, class: `tabbar ${cls}` },
    items.map((t) => h('button', {
      type: 'button', role: 'tab', 'data-tab': t.id, class: t.cls || null,
      'aria-selected': String(t.id === active), tabindex: t.id === active ? '0' : '-1',
      onclick: () => onPick(t.id),
    }, t.label, t.count != null && t.count !== '' ? h('span.tab-n', String(t.count)) : null, t.badge ? h('span.tab-badge', String(t.badge)) : null)),
  );
  bar.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const btns = [...bar.querySelectorAll('[role="tab"]')].filter((b) => b.offsetParent !== null);
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    const n = btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
    n.focus(); n.click();
  });
  return bar;
}

/** Input that commits on change/blur, never while typing. */
export function field(value, { onCommit, type = 'text', placeholder = '', disabled = false, cls = '', attrs = {}, multiline = false, rows = 3 } = {}) {
  const el = multiline
    ? h('textarea.inp', { rows, placeholder, disabled, class: `inp ${cls}`, ...attrs })
    : h('input.inp', { type, placeholder, disabled, class: `inp ${cls}`, ...attrs });
  el.value = value ?? '';
  let last = el.value;
  const commit = () => {
    if (el.value === last) return;
    last = el.value;
    onCommit?.(type === 'number' ? (el.value === '' ? 0 : Number(el.value)) : el.value);
  };
  el.addEventListener('change', commit);
  if (multiline) el.addEventListener('blur', commit);
  if (!multiline) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
  return el;
}

export function select(options, value, { onChange, disabled = false, cls = '', label } = {}) {
  const el = h('select.inp', { disabled, class: `inp ${cls}`, 'aria-label': label || null },
    options.map((o) => (o.options
      ? h('optgroup', { label: o.label }, o.options.map((x) => h('option', { value: x.value }, x.label)))
      : h('option', { value: o.value }, o.label))));
  el.value = value ?? '';
  el.addEventListener('change', () => onChange?.(el.value));
  return el;
}

export function labeled(label, control, { hint, cls = '' } = {}) {
  return h('label.lbl', { class: `lbl ${cls}` }, h('span.lbl-t', label), control, hint ? h('span.lbl-hint', hint) : null);
}

export function lockHint(text = 'Locked by the GM') {
  return h('span.lock-hint', { title: text }, icon('lock', { size: 12 }), h('span', text));
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase();
}

export function avatar(name, { color, src, size = 56 } = {}) {
  const el = h('span.avatar', { style: { '--av': color || 'var(--c-accent)', width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.38)}px` }, 'aria-hidden': 'true' });
  const url = portraitSrc(src);
  if (url) el.append(h('img', { src: url, alt: '' })); else el.textContent = initials(name);
  return el;
}

/* ---------------- theme ---------------- */

const THEME_KEY = 'system.theme';
export const THEMES = ['dark', 'light', 'neon'];
const storedTheme = () => { try { return localStorage.getItem(THEME_KEY); } catch { return null; } };
let packTheme = null;
/** Applies `t`, else this device's choice, else the pack default (pack.json "theme"), else dark. */
export function applyTheme(t) {
  const pick = [t, storedTheme(), packTheme].find((x) => THEMES.includes(x)) || 'dark';
  document.documentElement.dataset.theme = pick;
  return pick;
}
/** Stores a per-device choice. */
export function setTheme(t) {
  if (!THEMES.includes(t)) return applyTheme();
  try { localStorage.setItem(THEME_KEY, t); } catch {}
  return applyTheme(t);
}
/** Cycles dark → light → neon (the single theme button). */
export function toggleTheme() {
  const cur = document.documentElement.dataset.theme;
  return setTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
}
/** Pack default theme: used only while this device has not picked one. */
export function applyPackTheme(t) {
  if (t === packTheme) return;
  packTheme = THEMES.includes(t) ? t : null;
  applyTheme();
}
/** Pack accent (ruleset/pack may set `ui.accent`). */
export function applyAccent(pack) {
  const a = pack?.ui?.accent || pack?.ruleset?.ui?.accent;
  if (a && /^#[0-9a-f]{3,8}$/i.test(a)) document.documentElement.style.setProperty('--c-accent', a);
}
