// Rules search for the GM (B1): full-text search over passages a pack ships in `rules_index.json`
// ([{ b: book, p: page, h: heading, t: text }]). No AI, no network, no state change.
//
// The index may hold licensed book text, so it only ever leaves the server as the result of the GM action
// `rules.search` (authenticated GM socket). It is never part of a view, never a static asset.

import { bad } from './errors.js';

const MAX_PASSAGES = 20000;
const STOP = new Set('a an and are as at be by can do does for from has have how i if in into is it its may no not of on or so than that the their then there these they this to was what when where which who will with you your'.split(' '));

const fold = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const tokens = (s) => fold(s).split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
// Light stemming so "evades" finds "evade", "rolled" finds "roll".
const stem = (w) => (w.length > 4 ? w.replace(/(ings|ing|ies|ied|es|ed|s)$/, '') : w);

/** Keeps well-formed passages only. Never throws (a broken index = no search, not a broken pack). */
export function normalizeRulesIndex(raw, warnings = []) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) { warnings.push('rules_index.json: expected an array, ignored'); return []; }
  const out = [];
  for (const r of raw.slice(0, MAX_PASSAGES)) {
    if (!r || typeof r.t !== 'string' || !r.t.trim()) continue;
    out.push({ b: String(r.b ?? '').slice(0, 80), p: Number.isFinite(r.p) ? r.p : null, h: String(r.h ?? '').slice(0, 80), t: r.t.slice(0, 2000) });
  }
  return out;
}

const cache = new WeakMap();
function prepared(index) {
  let c = cache.get(index);
  if (c) return c;
  const docs = index.map((r) => {
    const words = tokens(`${r.h} ${r.t}`).map(stem);
    const tf = new Map();
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
    return { tf, len: words.length, head: new Set(tokens(r.h).map(stem)), text: fold(r.t) };
  });
  const df = new Map();
  for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const avg = docs.reduce((n, d) => n + d.len, 0) / Math.max(1, docs.length);
  c = { docs, df, avg };
  cache.set(index, c);
  return c;
}

/** BM25 over passages, + bonus for the exact phrase and for heading matches. Returns [{book, page, heading, text, score}]. */
export function searchRules(index, query, limit = 8) {
  if (!Array.isArray(index) || !index.length) return [];
  const terms = [...new Set(tokens(query).map(stem))];
  if (!terms.length) return [];
  const { docs, df, avg } = prepared(index);
  const N = docs.length;
  const phrase = fold(query).trim().replace(/\s+/g, ' ');
  const scored = [];
  for (let i = 0; i < N; i++) {
    const d = docs[i];
    let s = 0;
    let hits = 0;
    for (const w of terms) {
      const f = d.tf.get(w);
      if (!f) continue;
      hits++;
      const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5));
      s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.len / avg));
      if (d.head.has(w)) s += idf * 0.6;
    }
    if (!s) continue;
    s *= hits / terms.length; // passages with every word first
    if (phrase.length > 3 && d.text.includes(phrase)) s *= 1.8;
    scored.push([s, i]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, Math.max(1, Math.min(20, limit))).map(([score, i]) => {
    const r = index[i];
    return { book: r.b, page: r.p, heading: r.h, text: r.t, score: Math.round(score * 100) / 100 };
  });
}

export const RULES_GM = {
  /** a: { q, limit? } → result { hits, total }. Reads the pack index; changes nothing. */
  'rules.search'(st, a, ctx, out) {
    const q = typeof a.q === 'string' ? a.q.trim() : '';
    if (!q) throw bad('q: type what to look for');
    if (q.length > 200) throw bad('q: 200 characters at most');
    const index = ctx.pack?.rulesIndex ?? [];
    out.result = { hits: searchRules(index, q, Number.isInteger(a.limit) ? a.limit : 8), total: index.length };
    out.changed = false;
  },
};
