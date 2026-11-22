// The "What now?" bar under the GM top bar (B2): one line with the next step at the table and one button,
// plus up to 3 small chips for things waiting on the GM. Data from whatnow.js; hides itself when unwanted.
import { h } from './client.js';
import { whatNow } from './whatnow.js';

const KEY = 'gm.whatnow.off';

export function createWhatNow({ mount, send, showView, unread }) {
  if (!mount) return { update() {} };
  let off = false;
  try { off = localStorage.getItem(KEY) === '1'; } catch { /* private mode */ }
  let last = '';
  let view = null;

  async function run(step) {
    if (step.act) {
      try { await send(step.act); } catch (e) { mount.dataset.err = e?.message ?? 'failed'; draw(true); return; }
    }
    if (step.go) showView(step.go);
  }

  function draw(force = false) {
    if (!view) return;
    const { main, more } = whatNow(view, { unread: unread?.() ?? 0 });
    const key = JSON.stringify([off, main, more, mount.dataset.err ?? '']);
    if (!force && key === last) return;
    last = key;
    mount.hidden = false;
    if (off) {
      mount.className = 'whatnow is-off';
      mount.replaceChildren(h('button.btn.btn-quiet.btn-sm', { type: 'button', onclick: () => { off = false; save(); draw(true); } }, 'What now?'));
      return;
    }
    const err = mount.dataset.err;
    delete mount.dataset.err;
    mount.className = 'whatnow';
    mount.replaceChildren(
      h('span.whatnow-k', 'Now'),
      h('div.whatnow-main', h('b', main.text), main.hint ? h('span.whatnow-hint', main.hint) : null, err ? h('span.whatnow-err', err) : null),
      main.act || main.go ? h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => run(main) }, main.label ?? 'Open') : null,
      ...more.map((m) => h('button.chip.whatnow-chip', { type: 'button', onclick: () => run(m) }, m.text)),
      h('button.icon-btn.whatnow-x', { type: 'button', 'aria-label': 'Hide the What now bar', title: 'Hide', onclick: () => { off = true; save(); draw(true); } }, '✕'));
  }
  function save() { try { localStorage.setItem(KEY, off ? '1' : '0'); } catch { /* ignore */ } }

  return { update(v) { view = v; draw(); } };
}
