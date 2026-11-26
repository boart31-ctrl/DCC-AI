// Display language for the phone and the TV (CZ / EN flag). The pages are written in English; when Czech is
// on, a MutationObserver swaps matching text nodes and a few attributes for the dictionary's wording, and puts
// the English back when the flag goes to EN. Dictionaries live in i18n-<lang>.js: exact strings, plus
// patterns where `{}` stands for any text and the translation picks it up as {1}, {2}… ({1:slot|sloty|slotů}
// = the number with its Czech plural; a form with # puts the number there: {1:zbývá # kolo|zbývají # kola|zbývá # kol}). Only text that matches an entry changes: names, items and pack content
// stay as they are. data-i18n-key="ctx" on an element looks up "ctx|English" first.
// An element with data-i18n="off" (and everything inside it) is left alone.

const KEY = 'system.lang';
const LANGS = { en: { label: 'English', short: 'EN' }, cs: { label: 'Čeština', short: 'CZ' } };
const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'svg', 'path']);

let lang = 'en';
let dict = null; // { exact: Map, patterns: [[RegExp, string]] }
let observer = null;
const originals = new WeakMap(); // Text node → { en, shown }
const attrOriginals = new WeakMap(); // Element → { attr: { en, shown } }
const listeners = new Set();

function readLang() {
  const q = new URLSearchParams(location.search).get('lang');
  if (q && LANGS[q]) return q;
  try { const v = localStorage.getItem(KEY); if (v && LANGS[v]) return v; } catch { /* private mode */ }
  return 'en';
}

const HOLE = '((?:[^.!?\\n]|\\.(?=\\d)){1,48}?)';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Builds the lookup from a dictionary object { 'English': 'Česky', 'Round {}': 'Kolo {1}' }. */
export function compile(table) {
  const exact = new Map();
  const patterns = [];
  for (const [en, out] of Object.entries(table)) {
    if (!en.includes('{}')) { exact.set(en, out); continue; }
    // A hole takes a short phrase, never a sentence: pack descriptions ("Roll once per minute. The GM…")
    // must not half-translate through a generic pattern like "Roll {}".
    const re = new RegExp(`^${en.split('{}').map(escapeRe).join(HOLE)}$`);
    patterns.push([re, out]);
  }
  // Longer (more specific) patterns first.
  patterns.sort((a, b) => b[0].source.length - a[0].source.length);
  return { exact, patterns };
}

const plural = (n, [one, few, many]) => {
  const x = Math.abs(Number(n));
  if (x === 1) return one;
  if (x >= 2 && x <= 4 && Number.isInteger(x)) return few;
  return many;
};

/** Translates one string with a compiled dictionary; null = no entry. */
export function translate(text, d = dict) {
  if (!d || typeof text !== 'string') return null;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const core = m[2];
  if (!core || !/[A-Za-z]/.test(core)) return null;
  let out = d.exact.get(core);
  if (out == null) {
    for (const [re, tpl] of d.patterns) {
      const hit = re.exec(core);
      if (!hit) continue;
      const parts = hit.slice(1).map((p) => d.exact.get(p) ?? p);
      out = tpl.replace(/\{(\d)(?::([^}]*))?\}/g, (_, i, forms) => {
        const v = parts[Number(i) - 1] ?? '';
        if (!forms) return v;
        const form = plural(v, forms.split('|'));
        return form.includes('#') ? form.replaceAll('#', v) : `${v} ${form}`;
      });
      break;
    }
  }
  return out == null ? null : `${m[1]}${out}${m[3]}`;
}

const skipped = (el) => {
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
    if (SKIP.has(e.tagName) || e.isContentEditable || e.dataset?.i18n === 'off') return true;
  }
  return false;
};

function doText(node) {
  const rec = originals.get(node);
  const current = node.data;
  // The page changed the text since we translated it: that new text is the English to translate.
  const en = rec && current === rec.shown ? rec.en : current;
  if (lang === 'en') {
    if (rec && current === rec.shown && rec.shown !== rec.en) node.data = rec.en;
    originals.delete(node);
    return;
  }
  if (!node.parentElement || skipped(node.parentElement)) return;
  // data-i18n-key: the same English word means something else here (e.g. "Race" in a chase).
  const ctxKey = node.parentElement.dataset?.i18nKey;
  const out = (ctxKey && node.parentElement.childNodes.length === 1 && dict?.exact.get(`${ctxKey}|${en.trim()}`)) || translate(en);
  if (out == null || out === current) { if (out == null) originals.delete(node); return; }
  originals.set(node, { en, shown: out });
  node.data = out;
}

function doAttrs(el) {
  if (el.closest?.('[data-i18n="off"]')) return;
  let recs = attrOriginals.get(el);
  for (const a of ATTRS) {
    if (!el.hasAttribute(a)) continue;
    const current = el.getAttribute(a);
    const rec = recs?.[a];
    const en = rec && current === rec.shown ? rec.en : current;
    if (lang === 'en') {
      if (rec && current === rec.shown) el.setAttribute(a, rec.en);
      if (recs) delete recs[a];
      continue;
    }
    const out = translate(en);
    if (out == null || out === current) continue;
    if (!recs) attrOriginals.set(el, (recs = {}));
    recs[a] = { en, shown: out };
    el.setAttribute(a, out);
  }
}

function walk(root) {
  if (!root) return;
  if (root.nodeType === 3) { doText(root); return; }
  if (root.nodeType !== 1 && root.nodeType !== 11) return;
  if (root.nodeType === 1) {
    if (root.dataset?.i18n === 'off') return;
    doAttrs(root); // a textarea's placeholder counts, its text does not
    if (SKIP.has(root.tagName)) return;
  }
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (n.nodeType !== 1) return NodeFilter.FILTER_ACCEPT;
      if (n.dataset?.i18n === 'off') return NodeFilter.FILTER_REJECT;
      if (SKIP.has(n.tagName)) { doAttrs(n); return NodeFilter.FILTER_REJECT; }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (n.nodeType === 3) doText(n);
    else doAttrs(n);
  }
}

function startObserver() {
  if (observer || typeof MutationObserver === 'undefined') return;
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') doText(r.target);
      else if (r.type === 'attributes') doAttrs(r.target);
      else for (const n of r.addedNodes) walk(n);
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

function applyTitle() {
  const t = document.querySelector('title');
  if (t) walk(t);
}

async function load(code) {
  if (code === 'en') return null;
  const mod = await import(`./i18n-${code}.js`);
  return compile(mod.default);
}

/** Switches the page language and remembers it on this device. */
export async function setLang(code) {
  if (!LANGS[code]) return;
  try { localStorage.setItem(KEY, code); } catch { /* private mode */ }
  dict = await load(code).catch(() => null);
  lang = dict || code === 'en' ? code : 'en';
  document.documentElement.lang = lang;
  walk(document.body);
  applyTitle();
  if (lang !== 'en') startObserver();
  else if (observer) { observer.disconnect(); observer = null; }
  for (const fn of listeners) fn(lang);
  for (const b of document.querySelectorAll('.lang-flag')) paintFlag(b);
}

export const getLang = () => lang;
export const onLang = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
/** Translate a string in code (toasts built outside the DOM, vibration labels…). */
export const t = (s) => (lang === 'en' ? s : translate(s) ?? s);

const FLAGS = {
  cs: '<svg viewBox="0 0 30 20" aria-hidden="true"><rect width="30" height="10" fill="#fff"/><rect y="10" width="30" height="10" fill="#d7141a"/><path d="M0 0l15 10L0 20z" fill="#11457e"/></svg>',
  en: '<svg viewBox="0 0 60 40" aria-hidden="true"><rect width="60" height="40" fill="#012169"/><path d="M0 0l60 40M60 0L0 40" stroke="#fff" stroke-width="8"/><path d="M0 0l60 40M60 0L0 40" stroke="#c8102e" stroke-width="3"/><path d="M30 0v40M0 20h60" stroke="#fff" stroke-width="12"/><path d="M30 0v40M0 20h60" stroke="#c8102e" stroke-width="7"/></svg>',
};

function paintFlag(btn) {
  // The flag shows the language the button switches TO.
  const next = lang === 'cs' ? 'en' : 'cs';
  btn.innerHTML = `${FLAGS[next]}<span>${LANGS[next].short}</span>`;
  btn.setAttribute('data-i18n', 'off');
  const label = lang === 'cs' ? 'Přepnout do angličtiny' : 'Switch to Czech';
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

/** A CZ / EN flag button. */
export function langButton(extraClass = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `lang-flag ${extraClass}`.trim();
  b.addEventListener('click', () => setLang(lang === 'cs' ? 'en' : 'cs'));
  paintFlag(b);
  return b;
}

/** Call once per page. Mounts the flag into every element matching `slots`; `key` toggles from a keyboard (TV). */
export function initI18n({ slots = [], key = null } = {}) {
  for (const sel of slots) for (const el of document.querySelectorAll(sel)) el.append(langButton());
  if (key) {
    addEventListener('keydown', (e) => {
      if (e.key?.toLowerCase() !== key || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
      setLang(lang === 'cs' ? 'en' : 'cs');
    });
  }
  const want = readLang();
  if (want !== 'en') setLang(want);
}
