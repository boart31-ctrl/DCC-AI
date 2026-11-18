// Phone: the crawler's side of a reaction round (server/reaction.js). A bar at the bottom while a round
// runs: my actions left, attacks aimed at me, the interrupts I can spend, my Evade rolls (tap the d20 face),
// Intervene on a friend's near miss, and "used an action" in the act step.
//
// createRxPhone({ send, toast }) → { el, update(view, me) }
import { h } from './client.js';

const STEP_NAME = { declare: 'Mobs choose', react: 'React', resolve: 'Hits land', act: 'Your turn', cleanup: 'Clean up' };
const STEP_HINT = {
  declare: 'The mobs are choosing who to hit. Wait a moment…',
  react: 'Mobs announced their attacks. Before they land you can spend actions: dodge, protect a friend, draw the attack to you. You have 2 actions this round in total.',
  resolve: 'The attacks land now. Watch the TV.',
  act: 'Your turn: attack or do something with the actions you have left.',
  cleanup: 'End of the round.',
};

export function createRxPhone({ send, toast, onAttack = null }) {
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
    if (!rx || !mine) { el.hidden = true; sig = ''; pad = null; return; }
    // A pending dice pad is only valid in the current reaction step for a still-open declaration.
    // When the GM advances the round while a player is looking at their phone, close the stale pad.
    if (pad) {
      const decl = rx.decls.find((d) => d.id === pad.declId);
      const valid = rx.step === 'react' && decl && !decl.result
        && (pad.kind === 'evade'
          ? rx.evading.includes(mine.uid) && decl.targetUid === mine.uid && !decl.evade && !decl.caught
          : rx.intervene.includes(mine.uid) && decl.targetUid !== mine.uid && !!decl.evade);
      if (!valid) pad = null;
    }
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
      h('b', `Round ${rx.round}`), h('span.rxp-step', STEP_NAME[rx.step] || rx.step),
      h('span.grow'),
      h('span.rxp-dots', { title: `${left} action${left === 1 ? '' : 's'} left` }, Array.from({ length: left }, () => h('i')), left ? null : h('span.dim', 'no actions')));

    const incoming = atMe.length ? h('ul.rxp-list', atMe.map((d) => h('li',
      h('span', h('b', d.mob), ` · ${d.attack}`, d.area ? ' (area)' : ''),
      d.evade ? h('span.rxp-deg', { class: `rxp-deg rx-deg-${d.evade.degree}` }, d.evade.label)
        : react && evading && !d.caught ? h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => { pad = { declId: d.id, kind: 'evade', sides: 20 }; sig = ''; update(view, me); } }, 'Roll Evade')
          : d.result ? h('span.rxp-deg', d.result === 'evaded' ? 'Missed you' : `Hit · ${d.damage ?? ''}`) : d.caught ? h('span.dim', 'You caught it') : null))) : null;

    const buttons = [];
    const opt = (label, sub, onclick, primary = false) => h('button.btn.rxp-opt', { type: 'button', class: primary ? 'btn btn-primary rxp-opt' : 'btn rxp-opt', onclick }, h('b', label), h('small', sub));
    if (react && left > 0) {
      if (atMe.length && !evading) buttons.push(opt(`Evade (${atMe.length} attack${atMe.length === 1 ? '' : 's'} on you)`, 'Dodge: 1 action, then roll a d20 for each attack', () => call({ t: 'rx.interrupt', kind: 'evade' }), true));
      const hs = view.pack?.ruleset?.combat?.healSpell;
      buttons.push(opt('Heal', hs ? `${hs.mana} Mana: ${hs.slots} Health slots back now, before the hits land (1 action)` : 'Cast Heal now, before the hits land (1 action)', () => call({ t: 'rx.interrupt', kind: 'heal' })));
      if (!canIntervene) buttons.push(opt('Intervene', 'Keep a d6 ready to add to a friend’s roll (1 action)', () => call({ t: 'rx.interrupt', kind: 'intervene' })));
    }
    const myAdv = (rx.advantage || []).filter((v) => v.uid === mine.uid);
    if (rx.step === 'act' && myAdv.length) buttons.push(h('p.rxp-alert', `Advantage against ${myAdv.map((v) => v.mob).join(', ')}: roll 2 d20, keep the higher.`));
    if (rx.round === 0 && rx.surprised && rx.step === 'act') buttons.push(h('p.rxp-alert', 'Surprise! One free action before the mobs move.'));
    if (rx.step === 'act' && left > 0) {
      if (onAttack) buttons.push(opt('Attack', 'Pick a mob, roll a d20 (1 action)', async () => { if (await call({ t: 'rx.spend' })) onAttack(); }, true));
      buttons.push(opt('Something else', 'Move, use an item, cast… (1 action)', () => call({ t: 'rx.spend' })));
      if (!canIntervene) buttons.push(opt('Intervene', 'Keep a d6 ready for a friend (1 action)', () => call({ t: 'rx.interrupt', kind: 'intervene' })));
    }
    if (rx.step === 'react' && !atMe.length && !atOthers.length) buttons.push(h('p.dim', 'Nobody is attacked this round.'));
    if (react && evading && atMe.some((d) => !d.evade && !d.caught)) buttons.unshift(h('p.rxp-alert', 'Roll a d20 for each attack below.'));

    const allies = react && atOthers.length ? h('details.rxp-allies', h('summary', `Attacks on your friends (${atOthers.length})`),
      h('ul.rxp-list', atOthers.map((d) => h('li',
        h('span', h('b', d.mob), ` attacks ${crawlerName(d.targetUid)}`, d.evade ? ` · ${d.evade.label}` : ''),
        left > 0 && !d.result ? h('span.rxp-mini',
          h('button.btn.btn-sm', { type: 'button', title: 'Step in and take the hit for them (you cannot dodge it)', onclick: () => call({ t: 'rx.interrupt', kind: 'catcher', declId: d.id }) }, 'Take the hit'),
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
