// Phone: the crawler's side of a reaction round (server/reaction.js). Inside the Combat tab:
// actions left, attacks aimed at me, interrupts, Evade rolls (tap the d20 face),
// Intervene on a friend's near miss, and "used an action" in the act step.
//
// createRxPhone({ send, toast }) → { el, update(view, me) }
import { h } from './client.js';
import { dieFaces } from './ui.js';

const STEP_NAME = { declare: 'Mobs choose', react: 'React', resolve: 'Hits land', act: 'Your turn', cleanup: 'Clean up' };
const STEP_HINT = {
  declare: 'The mobs are choosing who to hit. Wait a moment…',
  react: 'Mobs announced their attacks. Before they land you can spend actions: dodge, protect a friend, draw the attack to you. You have 2 actions this round in total.',
  resolve: 'The GM is reviewing the attacks. Watch the TV as each one resolves.',
  act: 'Your turn: attack or do something with the actions you have left.',
  cleanup: 'End of the round.',
};

function resolvedHit(d) {
  if (d.result === 'evaded') return 'Evaded';
  if (d.result === 'skipped') return 'Skipped by the GM';
  const label = d.result === 'half' ? 'Half damage' : 'Hit';
  const damage = d.slots != null ? `${d.slots} slot${d.slots === 1 ? '' : 's'} lost` : `${d.damage ?? 0} HP before DR`;
  return `${label} · ${damage}`;
}

export function createRxPhone({ send, toast, onAttack = null }) {
  const el = h('section.rxp', { hidden: true, 'aria-live': 'polite', 'aria-label': 'Combat round' });
  let sig = '';
  let pad = null;
  let latest = null;
  let pending = false;

  const call = async (a) => {
    try { const r = await send(a); return r ?? true; } catch (err) { toast(err.message, { error: true }); return false; }
  };

  function update(view, me) {
    latest = { view, me };
    const c = view?.combat;
    const rx = c?.rx;
    const mine = rx && me ? c.combatants.find((x) => x.type === 'crawler' && x.playerId === me.id) : null;
    if (!rx || !mine) { el.hidden = true; sig = ''; pad = null; return; }
    const standing = !mine.down && !mine.dead && mine.dying == null;
    const left = rx.acts[mine.uid] ?? 2;
    const bonusLeft = rx.nonAttackActions?.[mine.uid] ?? 0;
    const canUseAction = standing && left + bonusLeft > 0;
    const favorField = view.pack?.ruleset?.fields?.find((f) => f.id === 'aiFavor');
    const favor = Number(me.sheet?.fields?.aiFavor ?? favorField?.default ?? 0);
    // A pending dice pad is only valid in the current reaction step for a still-open declaration.
    // When the GM advances the round while a player is looking at their phone, close the stale pad.
    if (pad) {
      const decl = rx.decls.find((d) => d.id === pad.declId);
      const valid = standing && rx.step === 'react' && decl && !decl.result
        && (pad.kind === 'evade'
          ? decl.targetUid === mine.uid && decl.canEvade
          : decl.targetUid !== mine.uid && (pad.kind === 'taunt'
            ? canUseAction
            : rx.intervene.includes(mine.uid) && !!decl.evade));
      if (!valid) pad = null;
    }
    const s = JSON.stringify([rx, pad, mine.uid, standing, favor]);
    if (s === sig) return;
    sig = s;
    el.hidden = false;
    const evading = rx.evading.includes(mine.uid);
    const canIntervene = standing && rx.intervene.includes(mine.uid);
    const names = new Map((view.players || []).map((p) => [p.id, p.name]));
    const crawlerName = (uid) => names.get(c.combatants.find((x) => x.uid === uid)?.playerId) || '?';
    const atMe = rx.decls.filter((d) => d.targetUid === mine.uid);
    const atOthers = rx.decls.filter((d) => d.targetUid !== mine.uid);
    const react = rx.step === 'react';
    const needsPaidEvade = atMe.some((d) => !d.result && !d.caught && !d.canEvade
      && (!d.evade || (d.evade.free && !['success', 'amazing', 'crit'].includes(d.evade.degree))));
    const openPad = (kind, declId) => {
      pad = { kind, declId };
      update(view, me);
      el.querySelector('.rxp-pad')?.scrollIntoView({ block: 'nearest' });
    };

    const head = h('div.rxp-head',
      h('b', rx.round ? `Round ${rx.round}` : 'Surprise'), h('span.rxp-step', STEP_NAME[rx.step] || rx.step),
      h('span.grow'),
      h('span.rxp-dots', { title: `${left} action${left === 1 ? '' : 's'} left` }, Array.from({ length: left }, () => h('i')), canUseAction ? null : h('span.dim', 'no actions')),
      bonusLeft ? h('span.pill', '1 utility action') : null);

    const incoming = atMe.length ? h('ul.rxp-list', atMe.map((d) => h('li',
      h('span', h('b', d.mob), ` · ${d.attack}`, d.area ? ' (area)' : '', d.adv === 'dis' ? ' · Disadvantaged' : ''),
      d.result ? h('span.rxp-deg', resolvedHit(d))
        : d.evade ? h('span.rxp-deg', { class: `rxp-deg rx-deg-${d.evade.degree}` }, d.evade.label, d.evade.free ? ' · free' : '')
          : d.caught ? h('span.dim', 'You caught it') : null,
      react && d.canEvade ? h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => openPad('evade', d.id) }, d.freeEvade ? 'Free Evade' : d.canReroll ? 'Reroll Evade' : 'Roll Evade') : null))) : null;

    const buttons = [];
    const opt = (label, sub, onclick, primary = false) => h('button.btn.rxp-opt', { type: 'button', class: primary ? 'btn btn-primary rxp-opt' : 'btn rxp-opt', onclick }, h('b', label), h('small', sub));
    if (react && canUseAction) {
      if (needsPaidEvade && !evading) buttons.push(opt(`Evade (${atMe.length} attack${atMe.length === 1 ? '' : 's'} on you)`, 'Spend 1 action to dodge open attacks or retry a failed Free Evade', () => call({ t: 'rx.interrupt', kind: 'evade' }), true));
      const hs = view.pack?.ruleset?.combat?.healSpell;
      if (hs) buttons.push(opt('Heal', `${hs.mana} Mana: ${hs.slots} health slots back before the hits land (1 action)`, () => call({ t: 'rx.interrupt', kind: 'heal' })));
      if (!canIntervene) buttons.push(opt('Intervene', 'Keep a d6 ready to add to a friend’s roll (1 action)', () => call({ t: 'rx.interrupt', kind: 'intervene' })));
    }
    const myAdv = (rx.advantage || []).filter((v) => v.uid === mine.uid);
    if (rx.step === 'act' && myAdv.length) buttons.push(h('p.rxp-alert', `Advantage against ${myAdv.map((v) => v.mob).join(', ')}: roll 2 d20, keep the higher.`));
    if (rx.round === 0 && rx.surprised && rx.step === 'act') buttons.push(h('p.rxp-alert', 'Surprise! One free action before the mobs move.'));
    if (rx.step === 'act' && canUseAction) {
      if (left && onAttack) buttons.push(opt('Attack', 'Pick a mob, roll a d20 (1 action)', onAttack, true));
      buttons.push(opt('Something else', 'Move, use an item, cast… (1 action)', () => call({ t: 'rx.spend' })));
      if (!canIntervene) buttons.push(opt('Intervene', 'Keep a d6 ready for a friend (1 action)', () => call({ t: 'rx.interrupt', kind: 'intervene' })));
    }
    if ((react || rx.step === 'act') && standing && favor > 0 && rx.favor && !rx.favor.includes(mine.uid)) {
      buttons.push(opt(`Spend AI Favor (${favor})`, 'Gain 1 extra action for something other than an attack', () => call({ t: 'rx.favor' })));
    }
    if (rx.step === 'react' && !atMe.length && !atOthers.length) buttons.push(h('p.dim', 'Nobody is attacked this round.'));
    if (react && atMe.some((d) => d.canEvade)) buttons.unshift(h('p.rxp-alert', 'Roll a d20 for each attack you can Evade.'));

    const allies = react && atOthers.length ? h('details.rxp-allies', h('summary', `Attacks on your friends (${atOthers.length})`),
      h('ul.rxp-list', atOthers.map((d) => h('li',
        h('span', h('b', d.mob), ` · ${d.attack} → ${crawlerName(d.targetUid)}`, d.evade ? ` · ${d.evade.label}` : ''),
        canUseAction && !d.result ? h('span.rxp-mini',
          h('button.btn.btn-sm', { type: 'button', title: 'Step in and take the hit for them (you cannot dodge it)', onclick: () => call({ t: 'rx.interrupt', kind: 'catcher', declId: d.id }) }, 'Take the hit'),
          h('button.btn.btn-sm', { type: 'button', title: 'Draw the attack to you (Taunt check)', onclick: () => openPad('taunt', d.id) }, 'Taunt')) : null,
        canIntervene && d.evade && !d.result ? h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => openPad('intervene', d.id) }, d.evade.degree === 'near' ? '+d6 (near miss!)' : '+d6') : null)))) : null;

    const nearAlly = canIntervene ? rx.decls.find((d) => d.targetUid !== mine.uid && d.evade?.degree === 'near' && !d.result) : null;

    let padEl = null;
    if (pad) {
      const { kind, declId } = pad;
      const sides = kind === 'intervene' ? 6 : 20;
      const decl = rx.decls.find((d) => d.id === declId);
      const untrained = kind === 'taunt' && view.pack?.ruleset?.skills?.untrained?.adv === 'dis'
        && (view.library?.skill ?? []).some((s) => s.id === 'taunt')
        && !(me.sheet?.skills ?? []).some((s) => s.skillId === 'taunt');
      padEl = h('div.rxp-pad',
        h('b', `${kind === 'taunt' ? 'Taunt' : kind === 'intervene' ? 'Intervene' : decl.freeEvade ? 'Free Evade' : decl.canReroll ? 'Reroll Evade' : 'Evade'} · ${decl.mob} · ${decl.attack}`),
        h('p', untrained ? 'Untrained Taunt: roll two d20s and tap the lower result' : `Tap what the d${sides} shows`),
        dieFaces(sides, async (die) => {
          if (pending || pad?.declId !== declId || pad.kind !== kind) return;
          pending = true;
          pad = null;
          update(latest.view, latest.me);
          const action = kind === 'taunt' ? { t: 'rx.interrupt', kind, declId, die }
            : kind === 'evade' ? { t: 'rx.evade', declId, die } : { t: 'rx.intervene', declId, d6: die };
          const r = await call(action);
          pending = false;
          if (!r && !pad) pad = { kind, declId };
          if (kind === 'taunt' && r?.result) toast(r.result.ok ? 'Taunted: it comes for you now.' : 'The taunt did not land.');
          else if (r?.result?.label) toast(r.result.near ? `${r.result.label}: a friend can Intervene!` : r.result.label);
          update(latest.view, latest.me);
        }, { disabled: pending }),
        h('button.btn.btn-quiet', { type: 'button', onclick: () => { pad = null; update(view, me); } }, 'Cancel'));
    }

    el.replaceChildren(...[head,
      h('p.rxp-hint', STEP_HINT[rx.step] || ''),
      nearAlly ? h('p.rxp-alert', `${crawlerName(nearAlly.targetUid)} nearly made it: add your d6!`) : null,
      padEl,
      incoming,
      buttons.length ? h('div.rxp-btns', buttons) : null,
      allies].filter(Boolean));
  }
  return { el, update };
}
