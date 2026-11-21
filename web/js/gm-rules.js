// GM rules search (B1): a box that searches the rulebook passages the pack ships (rules_index.json) through the
// GM-only action `rules.search`. Opens with the "Rules" button in the top bar or the "?" key. Nothing is cached in
// the browser beyond the open dialog, and nothing goes to the TV or phones.
import { h } from './client.js';

export function createRulesSearch({ send, button }) {
  const input = h('input', { type: 'search', placeholder: 'near miss, evade, dying, encounter size…', 'aria-label': 'Search the rules', autocomplete: 'off' });
  const status = h('p.rules-status', 'Type a rule, a debuff or a question.');
  const list = h('div.rules-hits');
  const dlg = h('dialog.sheet-dlg.tool.rules-dlg', { 'aria-label': 'Rules search' },
    h('div.sheet-inner',
      h('header.sheet-head', h('h3', 'Rules'),
        h('button.icon-btn.sheet-x', { type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
      h('div.sheet-body', h('form.rules-form', { onsubmit: (e) => { e.preventDefault(); run(); } }, input), status, list)));
  document.body.append(dlg);

  let timer = 0;
  let seq = 0;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });

  const words = (q) => q.toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w.length > 2);
  function mark(text, q) {
    const ws = words(q);
    if (!ws.length) return [text];
    const re = new RegExp(`(${ws.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
    return text.split(re).map((part, i) => (i % 2 ? h('mark', part) : part));
  }

  async function run() {
    const q = input.value.trim();
    if (q.length < 2) { list.replaceChildren(); status.textContent = 'Type a rule, a debuff or a question.'; return; }
    const mine = ++seq;
    status.textContent = 'Searching…';
    let res;
    try {
      res = await send({ t: 'rules.search', q, limit: 8 });
    } catch (e) {
      if (mine === seq) status.textContent = e?.message || 'Search failed.';
      return;
    }
    if (mine !== seq) return;
    const { hits = [], total = 0 } = res?.result ?? res ?? {};
    if (!total) { status.textContent = 'This pack has no rulebook index (rules_index.json).'; list.replaceChildren(); return; }
    status.textContent = hits.length ? `${hits.length} best of ${total} passages` : 'Nothing found. Try one or two key words.';
    list.replaceChildren(...hits.map((r) => {
      const long = r.text.length > 420;
      const body = h('p.rules-text', ...mark(long ? `${r.text.slice(0, 420)}…` : r.text, q));
      const more = long ? h('button.btn.btn-quiet.btn-sm', { type: 'button', onclick: () => { body.replaceChildren(...mark(r.text, q)); more.remove(); } }, 'Show all') : null;
      return h('article.rules-hit',
        h('div.rules-src', h('b', r.book), r.page ? ` · p. ${r.page}` : '', r.heading ? h('span.dim', ` · ${r.heading}`) : null),
        body, more);
    }));
  }

  function open() {
    if (!dlg.open) dlg.showModal();
    input.focus();
    input.select();
  }
  button?.addEventListener('click', open);
  document.addEventListener('keydown', (e) => {
    if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    open();
  });
  return { open };
}
