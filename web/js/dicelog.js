// Shared dice log (RULESET §6: state.rolls / event `roll`) and the roll result card.
import { h, timeAgo } from './client.js';
import { icon, minus, whyContent } from './ui.js';

export function diceFaces(roll) {
  return (roll?.dice || []).map((d) => (typeof d === 'number' ? { die: null, value: d } : { ...d, die: typeof d.die === 'string' ? Number(d.die.replace(/^d/i, '')) || null : d.die }));
}

function isNat(roll) {
  const f = diceFaces(roll);
  const one20 = f.length === 1 && (f[0].die === 20 || f[0].die == null);
  return {
    nat20: roll?.nat20 ?? (one20 && f[0].value === 20 && f[0].die === 20),
    nat1: roll?.nat1 ?? (one20 && f[0].value === 1 && f[0].die === 20),
  };
}

function rollRow(r, nameOf, meId) {
  const { nat1, nat20 } = isNat(r);
  const who = r.playerId ? (r.playerId === meId ? 'You' : nameOf(r.playerId)) : 'GM';
  return h('li.roll', { class: `roll${nat20 ? ' nat20' : ''}${nat1 ? ' nat1' : ''}${r.secret ? ' secret' : ''}`, 'data-id': r.id },
    h('div.roll-main',
      h('span.roll-who', who),
      h('span.roll-label', r.label || r.formula),
      r.secret ? h('span.roll-secret', { title: 'Secret roll: only the GM sees it' }, icon('eyeOff', { size: 12 }), 'Secret') : null,
      h('time.roll-at', { datetime: new Date(r.at || 0).toISOString() }, timeAgo(r.at)),
    ),
    h('div.roll-math',
      h('span.roll-dice', diceFaces(r).map((d) => h('span.face', { class: `face${d.die === 20 && d.value === 20 ? ' crit' : ''}${d.die === 20 && d.value === 1 ? ' fumble' : ''}`, title: d.die ? `d${d.die}` : '' }, String(d.value)))),
      h('span.roll-formula', minus(r.formula || '')),
      h('b.roll-total', String(r.total ?? '')),
      nat20 ? h('span.nat-tag', 'Nat 20') : nat1 ? h('span.nat-tag', 'Nat 1') : null,
      r.rankUp ? h('span.pill', { class: r.rankUp.success ? 'pill pill-on' : 'pill' }, r.rankUp.success ? `Rank ${r.rankUp.from} → ${r.rankUp.to}` : 'No rank-up') : null,
    ),
  );
}

/**
 * @param {object} o
 * @param {boolean} o.gm         GM sees secret rolls and gets the secret toggle
 * @param {(f:string, secret:boolean)=>Promise} o.onCustomRoll
 */
export function createDiceLog({ gm = false, onCustomRoll } = {}) {
  let view = null;
  let meId = null;
  let sig = '';
  let filter = 'all';
  const list = h('ol.roll-list', { 'aria-live': 'polite' });
  const formula = h('input.inp', { placeholder: 'd20+3, 2d6…', 'aria-label': 'Dice to roll', autocomplete: 'off', spellcheck: 'false' });
  const secret = gm ? h('input', { type: 'checkbox', 'aria-label': 'Secret roll' }) : null;
  const submit = async (e) => {
    e?.preventDefault();
    const f = formula.value.trim();
    if (!f) { formula.focus(); return; }
    try { await onCustomRoll?.(f, !!secret?.checked); formula.value = ''; } catch { /* toast shown by caller */ }
  };
  const filterBar = h('div.seg.seg-sm', { role: 'group', 'aria-label': 'Show rolls' },
    ['all', 'mine', ...(gm ? ['secret'] : [])].map((f) => h('button', {
      type: 'button', 'data-f': f, 'aria-pressed': String(f === filter),
      onclick: () => { filter = f; sig = ''; for (const b of filterBar.children) b.setAttribute('aria-pressed', String(b.dataset.f === f)); draw(); },
    }, f === 'all' ? 'Everyone' : f === 'mine' ? (gm ? 'GM' : 'Mine') : 'Secret')),
  );
  const el = h('section.dicelog', { 'aria-label': 'Dice log' },
    h('header.dicelog-head', h('h2', 'Dice log'), filterBar),
    list,
    h('form.dicelog-roll', { onsubmit: submit, autocomplete: 'off' },
      formula,
      secret ? h('label.chk', { title: 'Only you see the result' }, secret, h('span', 'Secret')) : null,
      h('button.btn.btn-primary', { type: 'submit' }, icon('dice', { size: 15 }), 'Roll'),
    ),
  );
  const nameOf = (id) => view?.players?.find((p) => p.id === id)?.name || 'Someone';
  function draw() {
    let rolls = [...(view?.rolls || [])];
    if (!gm) rolls = rolls.filter((r) => !r.secret || r.playerId === meId);
    if (filter === 'mine') rolls = rolls.filter((r) => (gm ? !r.playerId : r.playerId === meId));
    if (filter === 'secret') rolls = rolls.filter((r) => r.secret);
    rolls = rolls.slice(-80).reverse();
    const s = JSON.stringify([rolls.map((r) => r.id), filter]);
    if (s === sig) {
      for (const t of list.querySelectorAll('time.roll-at')) { const r = rolls.find((x) => x.id === t.closest('li').dataset.id); if (r) t.textContent = timeAgo(r.at); }
      return;
    }
    sig = s;
    list.replaceChildren(...(rolls.length ? rolls.map((r) => rollRow(r, nameOf, meId)) : [h('li.roll-empty', gm ? 'No rolls yet. Rolls from every sheet land here, secret ones too.' : 'No rolls yet. Tap any number on your sheet to roll it.')]));
  }
  return {
    el,
    update(v, me) { view = v; meId = me || null; draw(); },
    count() { return (view?.rolls || []).length; },
  };
}

/* ---------------- roll result card ---------------- */

let cardWrap = null;
const shownCards = new Set();
export function showRollCard(roll, { nameOf = () => '', meId = null } = {}) {
  if (!roll) return;
  const key = roll.id || `${roll.label}|${roll.total}|${roll.at}`;
  if (shownCards.has(key)) return;
  shownCards.add(key);
  if (shownCards.size > 200) shownCards.delete(shownCards.values().next().value);
  if (!cardWrap) { cardWrap = h('div.rollcards.tool', { 'aria-live': 'polite' }); document.body.append(cardWrap); }
  const { nat1, nat20 } = isNat(roll);
  const who = roll.playerId && roll.playerId !== meId ? nameOf(roll.playerId) : '';
  const card = h('div.rollcard', { class: `rollcard${nat20 ? ' nat20' : ''}${nat1 ? ' nat1' : ''}`, role: 'status' },
    h('div.rc-top',
      h('span.rc-label', who ? `${who}: ${roll.label || 'Roll'}` : (roll.label || 'Roll')),
      roll.secret ? h('span.roll-secret', icon('eyeOff', { size: 12 }), 'Secret') : null,
      h('button.icon-btn.rc-x', { type: 'button', 'aria-label': 'Dismiss', onclick: () => card.remove() }, icon('x', { size: 14 })),
    ),
    h('div.rc-body',
      h('b.rc-total', String(roll.total ?? '')),
      h('div.rc-math',
        h('span.roll-dice', diceFaces(roll).map((d) => h('span.face', { class: `face${d.die === 20 && d.value === 20 ? ' crit' : ''}${d.die === 20 && d.value === 1 ? ' fumble' : ''}` }, String(d.value)))),
        h('span.rc-formula', minus(roll.formula || '')),
      ),
      nat20 ? h('span.nat-tag', 'Natural 20') : nat1 ? h('span.nat-tag', 'Natural 1') : null,
    ),
    roll.breakdown?.parts?.length ? h('details.rc-why', h('summary', 'Why this number'), whyContent(roll.breakdown, { title: 'Modifier' })) : null,
  );
  cardWrap.prepend(card);
  while (cardWrap.children.length > 3) cardWrap.lastChild.remove();
  let t = setTimeout(() => card.remove(), nat20 || nat1 ? 9000 : 6000);
  card.addEventListener('pointerenter', () => clearTimeout(t));
  card.addEventListener('pointerleave', () => { t = setTimeout(() => card.remove(), 3000); });
}
