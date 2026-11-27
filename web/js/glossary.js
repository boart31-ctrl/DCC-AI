// Plain-language rules terms for new players (playtest 26 Nov, T15). Data: pack ruleset.json "glossary"
// [{ term, en, cs?, stat? }]. The phone shows Czech when its flag is CZ. "i" buttons open one term; the
// roll pad's "?" opens the whole list.
import { h } from './client.js';
import { icon, openDrawer } from './ui.js';
import { getLang } from './i18n.js';

export const glossaryOf = (view) => view?.pack?.ruleset?.glossary || [];
const textOf = (g) => (getLang() === 'cs' && g.cs ? g.cs : g.en);
const find = (view, key) => glossaryOf(view).find((g) => g.stat === key || g.term.toLowerCase() === String(key).toLowerCase());

export function openGlossary(view, focus = null) {
  const list = glossaryOf(view);
  if (!list.length) return;
  const one = focus ? find(view, focus) : null;
  const rows = (one ? [one] : list).map((g) => h('div.gl-row', h('b.gl-term', g.term), h('p.gl-text', textOf(g))));
  openDrawer({
    title: one ? one.term : (getLang() === 'cs' ? 'Pojmy' : 'Terms'),
    body: h('div.gl-list', { 'data-i18n': 'off' }, rows,
      one && list.length > 1 ? h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => openGlossary(view) }, getLang() === 'cs' ? 'Všechny pojmy' : 'All terms') : null),
  });
}

/** Small "i" next to a term; null when the pack has no entry for it. */
export function infoBtn(view, key, label = key) {
  if (!find(view, key)) return null;
  return h('button.gl-i', { type: 'button', 'aria-label': `What is ${label}?`, onclick: (e) => { e.stopPropagation(); openGlossary(view, key); } }, icon('info', { size: 13 }));
}
