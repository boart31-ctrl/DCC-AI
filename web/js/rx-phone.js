// Incoming attacks and reaction controls on the player's Combat page.
import { h } from './client.js';
import { dieFaces, openDrawer, closeDrawer } from './ui.js';

const SUCCESS = ['success', 'amazing', 'crit'];

export function combatBlocked(view, me, kind) {
  const buffs = view?.library?.buff ?? [];
  return (me?.sheet?.buffs ?? []).some((b) => buffs.find((def) => def.id === b.buffId)?.blocks?.includes(kind));
}

function resolvedHit(d) {
  if (d.result === 'evaded') return 'Evaded';
  if (d.result === 'skipped') return 'Skipped';
  const label = d.result === 'half' ? 'Half damage' : 'Hit';
  const damage = d.slots != null ? `${d.slots} slot${d.slots === 1 ? '' : 's'} lost` : `${d.damage ?? 0} HP rolled`;
  return `${label} · ${damage}`;
}

/** Details available through Help a friend and Something else, separate from the incoming attack list. */
export function reactionControls(view, me) {
  const c = view?.combat;
  const rx = c?.active ? c.rx : null;
  const mine = rx && me ? c.combatants.find((x) => x.type === 'crawler' && x.playerId === me.id) : null;
  if (!rx || !mine) return null;
  const standing = !mine.down && !mine.dead && mine.dying == null;
  const left = rx.acts[mine.uid] ?? 0;
  const extra = rx.nonAttackActions?.[mine.uid] ?? 0;
  const react = rx.step === 'react';
  const act = rx.step === 'act';
  const allowInterrupt = standing && !combatBlocked(view, me, 'interrupt');
  const canInterrupt = allowInterrupt && left + extra > 0;
  const canAct = standing && !combatBlocked(view, me, 'action');
  const canIntervene = allowInterrupt && rx.intervene.includes(mine.uid);
  const favorField = view.pack?.ruleset?.fields?.find((f) => f.id === 'aiFavor');
  const favor = Number(me.sheet?.fields?.aiFavor ?? favorField?.default ?? 0);
  const canFavor = (react || act) && canAct && favor > 0 && !rx.favor?.includes(mine.uid);
  return { c, rx, mine, standing, left, extra, react, act, canInterrupt, canIntervene, canAct, favor, canFavor,
    canHelp: (react || act) && (canInterrupt || canIntervene),
    canDoSomething: (act && canAct && left + extra > 0) || canFavor };
}

export function createRxPhone({ send, toast, onReceipt }) {
  const el = h('section.rxp', { hidden: true, 'aria-label': 'Combat round' });
  let latest = {};
  let sig = '';
  let pad = null;
  let pending = false;
  let tools = null;

  function crawlerName(uid) {
    const pid = latest.view?.combat?.combatants?.find((x) => x.uid === uid)?.playerId;
    return latest.view?.players?.find((p) => p.id === pid)?.name ?? 'An ally';
  }

  const call = async (action, label) => {
    try {
      const result = await send(action);
      if (label && result?.result?.receipt) onReceipt?.(label, result.result.receipt);
      return result ?? true;
    }
    catch (err) { toast(err.message, { error: true }); return false; }
  };

  async function useAction(action, label, close = false) {
    if (pending) return;
    pending = true;
    const dialog = tools?.dialog;
    update(latest.view, latest.me);
    const result = await call(action, label);
    pending = false;
    if (close && result && dialog?.isConnected) closeDrawer();
    update(latest.view, latest.me);
  }

  function openPad(kind, id) {
    if (pending) return;
    if (tools?.dialog?.isConnected) closeDrawer();
    pad = { kind, id };
    update(latest.view, latest.me);
    el.querySelector('.rxp-pad')?.scrollIntoView({ block: 'nearest' });
  }

  function padNode(d, view, me) {
    const { kind, id } = pad;
    const sides = kind === 'intervene' ? 6 : 20;
    const label = kind === 'taunt' ? 'Taunt' : kind === 'intervene' ? 'Intervene' : d.freeEvade ? 'Free Evade' : d.canReroll ? 'Reroll Evade' : 'Evade';
    const untrained = kind === 'taunt' && view.pack?.ruleset?.skills?.untrained?.adv === 'dis'
      && (view.library?.skill ?? []).some((s) => s.id === 'taunt')
      && !(me.sheet?.skills ?? []).some((s) => s.skillId === 'taunt');
    const digital = kind !== 'taunt' && me.diceMode !== 'off';
    async function submit(die) {
      if (pending || pad?.id !== id || pad.kind !== kind) return;
      pending = true;
      pad = null;
      update(latest.view, latest.me);
      const roll = die == null ? { digital: true } : kind === 'intervene' ? { d6: die } : { die };
      const action = kind === 'taunt' ? { t: 'rx.interrupt', kind, declId: id, die }
        : { t: kind === 'evade' ? 'rx.evade' : 'rx.intervene', declId: id, ...roll };
      const r = await call(action);
      pending = false;
      if (!r && !pad) pad = { kind, id };
      const result = r?.result;
      if (result) {
        const title = kind === 'taunt' ? result.ok ? 'Taunted. The attack comes for you.' : 'The taunt did not land.'
          : kind === 'intervene' ? `Intervene +${result.d6} · ${crawlerName(d.targetUid)} · ${result.label}`
            : `${label} d20 ${result.die} · ${result.label}${result.near ? ' · A friend can Intervene' : ''}`;
        onReceipt?.(title, result.receipt);
      }
      update(latest.view, latest.me);
    }
    return h('div.rxp-pad', { 'aria-label': `${label} roll` },
      h('strong', `${label}${kind === 'intervene' ? ` for ${crawlerName(d.targetUid)}` : ''} · ${d.mob} · ${d.attack}`),
      digital ? h('button.btn.btn-primary.rxp-digital', { type: 'button', disabled: pending, onclick: () => submit(null) }, `Roll d${sides}`) : null,
      h('p', untrained ? 'Roll two d20s and tap the lower result.' : `Tap the result on your d${sides}.`),
      dieFaces(sides, submit, { disabled: pending }),
      h('button.btn.btn-quiet', { type: 'button', onclick: () => { pad = null; update(latest.view, latest.me); } }, 'Cancel'));
  }

  function drawTools() {
    if (!tools) return;
    if (tools.dialog && !tools.dialog.isConnected) { tools = null; return; }
    const { view, me } = latest;
    const state = reactionControls(view, me);
    const options = [];
    const option = (label, note, run) => h('button.btn.rxp-opt', { type: 'button', disabled: pending, onclick: run }, h('strong', label), note ? h('small', note) : null);
    if (tools.kind === 'help' && state?.canHelp) {
      const { rx, mine, react, canInterrupt, canIntervene } = state;
      if (canInterrupt && !canIntervene) options.push(option('Prepare Intervene', 'Spend 1 action now to help with a later roll.',
        () => useAction({ t: 'rx.interrupt', kind: 'intervene' }, 'Intervene prepared')));
      if (canIntervene) options.push(h('p.dim', 'Intervene is ready. Adding the d6 uses your prepared action.'));
      if (react) for (const d of rx.decls.filter((x) => x.targetUid !== mine.uid && !x.result)) {
        const buttons = [];
        if (canInterrupt) buttons.push(
          h('button.btn.btn-sm', { type: 'button', disabled: pending, onclick: () => useAction({ t: 'rx.interrupt', kind: 'catcher', declId: d.id }, 'Taking the hit', true) }, 'Take the hit'),
          h('button.btn.btn-sm', { type: 'button', disabled: pending, onclick: () => openPad('taunt', d.id) }, 'Taunt'));
        if ((canIntervene || canInterrupt) && d.evade) buttons.push(h('button.btn.btn-sm.btn-primary', { type: 'button', disabled: pending, 'aria-label': 'Assist with d6',
          onclick: () => openPad('intervene', d.id) }, 'Assist with d6', h('small', canIntervene ? 'Prepared' : '1 action')));
        if (buttons.length) options.push(h('div.rxp-ally', h('strong', crawlerName(d.targetUid)), h('small', `${d.mob} · ${d.attack}`), h('div.rxp-mini', buttons)));
      }
    }
    if (tools.kind === 'utility' && state?.canDoSomething) {
      if (state.act && state.canAct && state.left + state.extra > 0) options.push(option('Record an action', 'Spend 1 action for something you did at the table.',
        () => useAction({ t: 'rx.spend' }, 'Action recorded', true)));
      if (state.canFavor) options.push(option(`Spend AI Favor (${state.favor})`, 'Gain one extra action for something other than an attack.',
        () => useAction({ t: 'rx.favor' }, 'Utility action gained', true)));
    }
    tools.body.replaceChildren(...(options.length ? options : [h('p.empty-s', 'There are no available actions here right now.')]));
  }

  function showTools(kind, title) {
    const body = h('div.rxp-tools');
    const dialog = openDrawer({ title, body, onClose: () => { tools = null; } });
    tools = { kind, body, dialog };
    drawTools();
  }

  function update(view, me) {
    latest = { view, me };
    const state = reactionControls(view, me);
    const { rx, mine, standing, react, canInterrupt, canIntervene } = state ?? {};
    if (!state) {
      el.hidden = true;
      sig = '';
      pad = null;
      drawTools();
      return;
    }
    const atMe = rx.decls.filter((d) => d.targetUid === mine.uid);
    const meEvading = rx.evading.includes(mine.uid);
    const canPrepareEvade = react && canInterrupt && !meEvading && atMe.some((d) => !d.result && !d.caught && !d.canEvade
      && (!d.evade || (d.evade.free && !SUCCESS.includes(d.evade.degree))));
    const picked = pad && rx.decls.find((d) => d.id === pad.id);
    if (pad && (!standing || !react || !picked || picked.result || (pad.kind === 'evade' ? picked.targetUid !== mine.uid || !picked.canEvade
      : picked.targetUid === mine.uid || (pad.kind === 'taunt' ? !canInterrupt : !(canIntervene || canInterrupt) || !picked.evade)))) pad = null;
    const next = JSON.stringify([rx.step, atMe, pad, picked, me.diceMode, pending, canPrepareEvade]);
    if (next !== sig) {
      sig = next;
      el.hidden = false;
      const rows = atMe.map((d) => h('li', h('div.rxp-incoming-copy', h('strong', d.attack), h('small', `${d.mob}${d.area ? ' · Area' : ''}`)),
        d.result ? h('span.rxp-deg', resolvedHit(d)) : d.evade ? h('span.rxp-deg', { class: `rxp-deg rx-deg-${d.evade.degree}` }, d.evade.label) : d.caught ? h('span.dim', 'Caught') : null,
        react && d.canEvade ? h('button.btn.btn-primary.rx-evade', { type: 'button', disabled: pending, onclick: () => openPad('evade', d.id) }, d.freeEvade ? 'Free Evade' : d.canReroll ? 'Reroll Evade' : 'Roll Evade') : null));
      el.replaceChildren(h('div.rxp-incoming-head', h('h3', 'Incoming attacks'),
        canPrepareEvade ? h('button.btn.btn-primary.rx-evade', { type: 'button', 'aria-label': 'Evade', disabled: pending,
          onclick: () => useAction({ t: 'rx.interrupt', kind: 'evade' }, 'Evade prepared') }, 'Evade', h('small', '1 action')) : null),
      pad ? padNode(picked, view, me) : '',
      rows.length ? h('ul.rxp-list', rows) : h('p.dim', rx.step === 'declare' ? 'Waiting for the mobs to announce.' : 'Nothing aimed at you.'));
    }
    drawTools();
  }

  return { el, update, showHelp: () => showTools('help', 'Help a friend'), showUtility: () => showTools('utility', 'Something else') };
}
