// Turn order (initiative) strip: TV, GM desk (drag to reorder, edit totals, step turns) and phones.
// Data: view.combat.init = { on, order: [{uid, type, playerId, total?}], turnUid, waiting: [...], manual }.
import { h } from './client.js';

/** Name + colour + picture of a combatant from the view. */
function who(view, x) {
  const c = (view.combat?.combatants || []).find((y) => y.uid === x.uid) || {};
  const p = x.playerId ? (view.players || []).find((y) => y.id === x.playerId) : null;
  return { name: p?.name || c.name || '?', color: p?.color || null, image: c.image || null, down: !!c.down, mob: x.type === 'mob', hidden: !!c.hidden };
}

/**
 * Builds the strip. opts: { gm, meId, onOrder(uids), onTotal(uid, total), onTurn(uid), compact }
 * Returns null when the fight is not in turn order.
 */
export function initStrip(view, opts = {}) {
  const I = view?.combat?.init;
  if (!view?.combat?.active || !I?.on) return null;
  const items = I.order.map((x, i) => {
    const w = who(view, x);
    const cur = x.uid === I.turnUid;
    const next = !cur && I.turnUid && I.order[(I.order.findIndex((y) => y.uid === I.turnUid) + 1) % I.order.length]?.uid === x.uid;
    const li = h('li.ini', {
      class: `ini${cur ? ' is-cur' : ''}${next ? ' is-next' : ''}${w.mob ? ' is-mob' : ' is-pc'}${w.down ? ' is-down' : ''}${x.playerId && x.playerId === opts.meId ? ' is-me' : ''}${w.hidden ? ' is-hidden' : ''}`,
      style: w.color ? { '--ini': w.color } : null,
      'data-uid': x.uid,
      draggable: opts.gm ? 'true' : null,
    },
    h('span.ini-n', String(i + 1)),
    h('span.ini-name', w.name),
    opts.gm ? h('input.ini-total', {
      type: 'number', value: x.total ?? '', 'aria-label': `${w.name} initiative`, inputmode: 'numeric',
      onchange: (e) => { const v = Math.round(Number(e.target.value)); if (Number.isFinite(v)) opts.onTotal?.(x.uid, v); },
    }) : null,
    opts.gm ? h('button.ini-go', { type: 'button', title: 'Make it their turn', 'aria-label': `${w.name}'s turn`, onclick: () => opts.onTurn?.(x.uid) }, '▶') : null);
    return li;
  });
  const waiting = (I.waiting || []).map((x) => {
    const w = who(view, x);
    return h('li.ini.is-wait', { style: w.color ? { '--ini': w.color } : null }, h('span.ini-n', '…'), h('span.ini-name', w.name), opts.gm ? h('input.ini-total', {
      type: 'number', placeholder: 'roll', 'aria-label': `${w.name} initiative`, inputmode: 'numeric',
      onchange: (e) => { const v = Math.round(Number(e.target.value)); if (Number.isFinite(v)) opts.onTotal?.(x.uid, v); },
    }) : null);
  });
  const list = h('ol.ini-list', [...items, ...waiting]);
  if (opts.gm) dragSort(list, (uids) => opts.onOrder?.(uids));
  return h('div.ini-strip', { class: `ini-strip${opts.compact ? ' compact' : ''}`, 'aria-label': 'Turn order' }, list);
}

function dragSort(list, done) {
  let dragging = null;
  list.addEventListener('dragstart', (e) => {
    dragging = e.target.closest('li.ini[data-uid]');
    if (!dragging) return;
    dragging.classList.add('is-drag');
    e.dataTransfer.effectAllowed = 'move';
  });
  list.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const over = e.target.closest('li.ini[data-uid]');
    if (!over || over === dragging) return;
    const r = over.getBoundingClientRect();
    const horizontal = r.width > r.height;
    const after = horizontal ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
    over[after ? 'after' : 'before'](dragging);
  });
  list.addEventListener('dragend', () => {
    if (!dragging) return;
    dragging.classList.remove('is-drag');
    dragging = null;
    done([...list.querySelectorAll('li.ini[data-uid]')].map((li) => li.dataset.uid));
  });
}
