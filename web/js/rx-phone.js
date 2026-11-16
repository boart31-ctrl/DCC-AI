// Phone: the crawler's side of a reaction round (server/reaction.js). A bar at the bottom while a round
// runs: my actions left, attacks aimed at me, the interrupts I can spend, my Evade rolls (tap the d20 face),
// Intervene on a friend's near miss, and "used an action" in the act step.
//
// createRxPhone({ send, toast }) → { el, update(view, me) }
import { h } from './client.js';

const STEP_HINT = {
  declare: 'The mobs are choosing targets…',
  react: 'React now: Evade, Catcher, Taunt, Heal or Intervene. Each costs one action.',
  resolve: 'Attacks land.',
  act: 'Your turn: spend what is left. Attacks go through your sheet.',
  cleanup: 'End of the round.',
};

export function createRxPhone({ send, toast }) {
  const el = h('section.rxp', { hidden: true, 'aria-live': 'polite', 'aria-label': 'Combat round' });
  let sig = '';
  let pad = null; // { declId, kind: 'evade'|'intervene', sides }

  const call = async (a) => {
    try { const r = await send(a); return r ?? true; } catch (err) { toast(err.message, { error: true }); return false; }
  };

  function update(view, me) {
    const c = view?.combat;
    const rx = c?.rx;
    const mine = rx && me ? c.combatants.find((x) => x.type === 'crawler' && x.playerId === me.id) : null;
    if (!rx || !mine) { el.hidden = true; sig = ''; return; }
    const s = JSON.stringify([rx, pad, mine.uid]);
    if (s === sig) return;
    sig = s;
    el.hidden = false;
    const left = rx.acts[mine.uid] ?? 2;
    const evading = rx.evading.includes(mine.uid);
    const canIntervene = rx.intervene.includes(mine.uid);
    const names = new Map((view.players || []).map((p) => [p.id, p.name]));
    const crawlerName = (uid) => names.get(c.combatants.find((x) => x.uid === uid)?.playerId) || '?';
    const atMe = rx.decls.filter((d) => d.targetUid === mine.uid);
    const atOthers = rx.decls.filter((d) => d.targetUid !== mine.uid);
    const react = rx.step === 'react';

    const head = h('div.rxp-head',
      h('b', `Round ${rx.round}`), h('span.rxp-step', rx.step),
      h('span.grow'),
      h('span.rxp-dots', { title: `${left} action${left === 1 ? '' : 's'} left` }, Array.from({ length: left }, () => h('i')), left ? null : h('span.dim', 'no actions')));

    const incoming = atMe.length ? h('ul.rxp-list', atMe.map((d) => h('li',
      h('span', h('b', d.mob), ` · ${d.attack}`, d.area ? ' (area)' : ''),
      d.evade ? h('span.rxp-deg', { class: `rxp-deg rx-deg-${d.evade.degree}` }, d.evade.label)
        : react && evading && !d.caught ? h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => { pad = { declId: d.id, kind: 'evade', sides: 20 }; sig = ''; update(view, me); } }, 'Roll Evade')
          : d.result ? h('span.rxp-deg', d.result === 'evaded' ? 'Missed you' : `Hit · ${d.damage ?? ''}`) : d.caught ? h('span.dim', 'You caught it') : null))) : null;

    const buttons = [];
    if (react && left > 0) {
      if (atMe.length && !evading) buttons.push(h('button.btn.btn-primary', { type: 'button', onclick: () => call({ t: 'rx.interrupt', kind: 'evade' }) }, `Evade (${atMe.length} attack${atMe.length === 1 ? '' : 's'})`));
      buttons.push(h('button.btn', { type: 'button', onclick: () => call({ t: 'rx.interrupt', kind: 'heal' }) }, 'Heal'));
      if (!canIntervene) buttons.push(h('button.btn', { type: 'button', title: 'Hold a d6 for a friend’s roll (best on a near miss)', onclick: () => call({ t: 'rx.interrupt', kind: 'intervene' }) }, 'Intervene'));
    }
    if (rx.step === 'act' && left > 0) {
      buttons.push(h('button.btn.btn-primary', { type: 'button', onclick: () => call({ t: 'rx.spend' }) }, 'Used an action'));
      if (!canIntervene) buttons.push(h('button.btn', { type: 'button', onclick: () => call({ t: 'rx.interrupt', kind: 'intervene' }) }, 'Intervene'));
    }

    const allies = react && atOthers.length ? h('details.rxp-allies', h('summary', `Attacks on your friends (${atOthers.length})`),
      h('ul.rxp-list', atOthers.map((d) => h('li',
        h('span', h('b', d.mob), ` → ${crawlerName(d.targetUid)}`, d.evade ? ` · ${d.evade.label}` : ''),
        left > 0 && !d.result ? h('span.rxp-mini',
          h('button.btn.btn-sm', { type: 'button', title: 'Take the hit for them', onclick: () => call({ t: 'rx.interrupt', kind: 'catcher', declId: d.id }) }, 'Catch'),
          h('button.btn.btn-sm', { type: 'button', title: 'Draw the attack to you (Taunt check)', onclick: async () => {
            const v = prompt('Your Taunt check total (d20 + rank + Int)?');
            const n = Number(v);
            if (!v || !Number.isInteger(n)) return;
            const r = await call({ t: 'rx.interrupt', kind: 'taunt', declId: d.id, total: n });
            if (r?.result) toast(r.result.ok ? 'Taunted: it comes for you now.' : 'The taunt did not land.');
          } }, 'Taunt')) : null,
        canIntervene && d.evade && !d.result ? h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => { pad = { declId: d.id, kind: 'intervene', sides: 6 }; sig = ''; update(view, me); } }, d.evade.degree === 'near' ? '+d6 (near miss!)' : '+d6') : null)))) : null;

    const nearAlly = canIntervene ? rx.decls.find((d) => d.targetUid !== mine.uid && d.evade?.degree === 'near' && !d.result) : null;

    let padEl = null;
    if (pad) {
      padEl = h('div.rxp-pad',
        h('p', pad.kind === 'evade' ? 'Tap what the d20 shows' : 'Tap what the d6 shows'),
        h('div.rxp-grid', { class: `rxp-grid rxp-g${pad.sides}` }, Array.from({ length: pad.sides }, (_, i) => h('button.btn', {
          type: 'button',
          onclick: async () => {
            const p = pad;
            pad = null;
            sig = '';
            const r = await call(p.kind === 'evade' ? { t: 'rx.evade', declId: p.declId, die: i + 1 } : { t: 'rx.intervene', declId: p.declId, d6: i + 1 });
            if (r?.result?.label) toast(r.result.near ? `${r.result.label}: a friend can Intervene!` : r.result.label);
            update(view, me);
          },
        }, String(i + 1)))),
        h('button.btn.btn-quiet', { type: 'button', onclick: () => { pad = null; sig = ''; update(view, me); } }, 'Cancel'));
    }

    el.replaceChildren(...[head,
      h('p.rxp-hint', STEP_HINT[rx.step] || ''),
      nearAlly ? h('p.rxp-alert', `${crawlerName(nearAlly.targetUid)} nearly made it: add your d6!`) : null,
      incoming,
      buttons.length ? h('div.rxp-btns', buttons) : null,
      allies,
      padEl].filter(Boolean));
  }
  return { el, update };
}
