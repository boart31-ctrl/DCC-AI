// GM desk → Fight: reaction rounds (server/reaction.js) for games where the GM never rolls a d20.
// declare (who attacks whom) → react (crawlers spend interrupts on their phones) → resolve (Evade rolls,
// damage) → act (crawlers strike back) → next round.
//
// rxPanel({ act, view }) → Node | null
import { h, ask } from './client.js';
import { icon, openDrawer, select } from './ui.js';

const STEP_LABEL = { declare: '1 Declare', react: '2 React', resolve: '3 Damage', act: '4 Crawlers act', cleanup: '5 Clean up' };
const NEXT = {
  declare: { to: 'react', label: 'Announce attacks', hint: 'Phones and TV show who is attacked; crawlers choose Evade, Take the hit, Taunt…' },
  react: { to: 'resolve', label: 'Resolve damage', hint: 'Roll damage for hits, then apply resistance and whole health slots' },
  resolve: { to: 'act', label: 'Crawlers act', hint: 'Remaining actions: attacks go through the sheet rolls' },
  act: { round: true, label: 'Next round', hint: 'Actions reset, mobs declare again' },
  cleanup: { round: true, label: 'Next round', hint: '' },
};
const RESULT = { evaded: 'Evaded', half: 'Half damage', hit: 'Hit' };

export function rxPanel({ act, view, draft }) {
  const c = view?.combat;
  if (!c?.active) return null;
  const family = view?.pack?.ruleset?.system?.family || 'crawler';
  const rx = c.rx;
  if (!rx) {
    if (family !== 'crawler') return null;
    return h('section.panel.rx', h('div.sec-head', h('h2', 'Rounds'), h('span.dim', 'The GM never rolls a d20: mobs declare, crawlers react')),
      h('button.btn.btn-primary', { type: 'button', onclick: () => act({ t: 'rx.start' }, 'Round 1: declare the mob attacks.') }, 'Start round 1'));
  }
  const byUid = new Map(c.combatants.map((x) => [x.uid, x]));
  const players = new Map((view.players || []).map((p) => [p.id, p]));
  const crawlers = c.combatants.filter((x) => x.type === 'crawler');
  const targets = crawlers.filter((x) => !x.dead);
  const nameOf = (uid) => { const x = byUid.get(uid); return x ? (x.type === 'mob' ? x.name : players.get(x.playerId)?.name || x.name || '?') : '?'; };
  const targetChoice = (x) => ({ value: x.uid, label: `${nameOf(x.uid)}${x.dying != null ? ' (dying)' : ''}` });
  const missingEvades = rx.decls.filter((d) => d.canEvade && !d.evade);
  const mobs = c.combatants.filter((x) => x.type === 'mob' && !x.down && (x.attacks || []).length);
  const next = NEXT[rx.step];
  const hasFavor = view.pack?.ruleset?.fields.some((f) => f.id === 'aiFavor');

  const steps = h('ol.rx-steps', rx.steps.map((s) => h('li', { class: s === rx.step ? 'on' : '' }, STEP_LABEL[s])));
  const announceLabel = rx.decls.length ? `Announce attacks (${rx.decls.length})` : 'No mob attacks';
  const nextBtn = h('button.btn.btn-primary', {
    type: 'button', title: next.hint,
    onclick: async () => {
      if (next.round) return act({ t: 'rx.round' }, `Round ${rx.round + 1}.`);
      const ok = await act({ t: 'rx.step', to: next.to });
      if (!ok && next.to === 'resolve') {
        // Only offer force after a known missing Evade roll. Other failures must remain errors.
        const missing = missingEvades;
        if (!missing.length) return;
        const names = [...new Set(missing.map((d) => nameOf(d.targetUid)))].join(', ');
        const yes = await ask(`Still waiting for ${missing.length} Evade roll${missing.length === 1 ? '' : 's'} (${names}). Unresolved rolls will count as no Evade. Continue?`, { ok: 'Resolve without Evade', danger: true });
        if (yes) await act({ t: 'rx.step', to: 'resolve', force: true }, 'Unresolved Evade rolls skipped by GM.');
      }
    },
  }, rx.step === 'declare' ? announceLabel : next.label);

  const pips = h('div.rx-pips', crawlers.map((x) => {
    const left = rx.acts[x.uid] ?? 2;
    const extra = rx.nonAttackActions?.[x.uid] ?? 0;
    const canBuy = hasFavor && ['react', 'act'].includes(rx.step) && !x.dead && x.dying == null && !rx.favor?.includes(x.uid);
    return h('span.rx-pip', { title: `${nameOf(x.uid)}: ${left} action${left === 1 ? '' : 's'} left` },
      h('b', nameOf(x.uid)), h('span.rx-dots', Array.from({ length: Math.max(left, 0) }, () => h('i.on')), extra ? h('span.pill', { title: 'One non-attack action from AI Favor' }, '+1 utility') : null, rx.evading.includes(x.uid) ? h('span.pill', 'Evading') : null),
      canBuy ? h('button.icon-btn', { type: 'button', title: 'Spend 1 AI Favor for a non-attack action', onclick: () => act({ t: 'rx.favor', uid: x.uid }) }, icon('sparkle', { size: 12 })) : null,
      h('button.icon-btn', { type: 'button', title: 'Adjust base actions up', onclick: () => act({ t: 'rx.actions', uid: x.uid, delta: 1 }) }, icon('plus', { size: 12 })),
      h('button.icon-btn', { type: 'button', title: 'One action less', onclick: () => act({ t: 'rx.actions', uid: x.uid, delta: -1 }) }, icon('minus', { size: 12 })));
  }));

  const declRow = (d) => {
    const attacks = byUid.get(d.mobUid)?.attacks ?? [];
    const attackChoices = attacks.map((a, i) => ({ value: String(i), label: a.name }));
    const planned = rx.step === 'declare';
    const dieIn = h('input.inp.inp-sm.rx-die', { type: 'number', min: 1, max: 20, placeholder: 'd20', 'aria-label': `Evade die for ${nameOf(d.targetUid)}` });
    dieIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const v = Number(dieIn.value); if (v >= 1 && v <= 20) act({ t: 'rx.evade', declId: d.id, die: v }); } });
    return h('li.rx-decl', { class: d.result ? `rx-decl rx-${d.result}` : 'rx-decl' },
      h('b', d.mob),
      planned && attacks.length > 1 ? select(attackChoices, String(d.attackIndex ?? attacks.findIndex((a) => a.name === d.attack)), { cls: 'inp-sm', label: `Queued attack for ${d.mob}`, onChange: (v) => act({ t: 'rx.retarget', declId: d.id, attackIndex: Number(v) }) }) : h('span', d.attack),
      icon('target', { size: 13 }),
      planned ? select(targets.map(targetChoice), d.targetUid, { cls: 'inp-sm', label: `Queued target for ${d.mob}`, onChange: (v) => act({ t: 'rx.retarget', declId: d.id, targetUid: v }) }) : h('b', nameOf(d.targetUid)),
      (rx.step === 'declare' || rx.step === 'react') && !d.result ? h('button.btn.btn-sm.btn-quiet.rx-adv', { type: 'button', 'aria-pressed': String(!!d.area), title: 'Area of Effect: full (Evade halves) / splash ring (half; Evade leaves a quarter) / single target', onclick: () => act({ t: 'rx.area', declId: d.id, area: !d.area ? 'full' : !d.splash ? 'splash' : null }) }, !d.area ? 'AoE' : d.splash ? 'Splash ½' : 'AoE full') : null,
      (rx.step === 'declare' || rx.step === 'react') && !d.evade ? h('button.btn.btn-sm.btn-quiet.rx-adv', { type: 'button', 'aria-pressed': String(!!d.adv), title: 'Advantage raises Evade DC by 5. Disadvantage lowers it by 5 and gives a free Evade.', onclick: () => act({ t: 'rx.adv', declId: d.id, adv: d.adv === 'adv' ? 'dis' : d.adv === 'dis' ? null : 'adv' }) }, d.adv === 'adv' ? 'Adv +5' : d.adv === 'dis' ? 'Dis −5' : '±') : null,
      d.caught ? h('span.pill', 'Caught') : null, d.taunted ? h('span.pill', 'Taunted') : null,
      h('span.dim.rx-dc', `Evade DC ${d.dc} · ${d.damageDice}${d.dtype ? ` ${d.dtype}` : ' dmg'}`),
      d.effects ? h('button.btn.btn-sm.btn-quiet', { type: 'button', title: d.effects, onclick: () => openDrawer({ title: d.attack, body: h('p', d.effects) }) }, 'Effect') : null,
      h('span.grow'),
      d.evade ? h('span.pill', { class: `pill rx-deg-${d.evade.degree}` }, `${d.evade.free ? 'Free Evade · ' : ''}${d.evade.label} (${d.evadeTotal}${d.evade.helped ? `, +${d.evade.helped} help` : ''})`) : null,
      rx.step === 'react' && d.canEvade ? [h('span.dim', d.freeEvade ? 'Free Evade' : d.canReroll ? 'Evade retry' : 'Evade roll'), dieIn] : null,
      d.result ? h('span.pill', { class: d.result === 'evaded' ? 'pill pill-on' : 'pill', title: d.damageAfterDr != null && d.damageAfterDr !== d.damage ? `${d.damageAfterDr} HP after DR and typed protection` : null }, `${RESULT[d.result]}${d.damage != null && d.result !== 'evaded' ? ` · ${d.damage} HP${d.slots != null ? ` → ${d.slots} slot${d.slots === 1 ? '' : 's'}` : ''}` : ''}`) : null,
      rx.step === 'declare' ? h('button.icon-btn', { type: 'button', title: 'Remove', onclick: () => act({ t: 'rx.undeclare', declId: d.id }) }, icon('x', { size: 13 })) : null);
  };

  let adder = null;
  if (rx.step === 'declare' && mobs.length && targets.length) {
    const st = draft;
    if (!mobs.some((m) => m.uid === st.mob)) { st.mob = mobs[0].uid; st.atk = null; }
    if (!targets.some((x) => x.uid === st.target) || st.round !== rx.round) st.target = '';
    st.round = rx.round;
    const setEnabled = () => { queue.disabled = st.atk == null || !st.target; };
    const atkSel = () => {
      const attacks = byUid.get(st.mob).attacks;
      if (attacks.length === 1) st.atk = 0;
      if (!attacks[st.atk]) st.atk = null;
      return select([{ value: '', label: 'Choose attack' }, ...attacks.map((a, i) => ({ value: String(i), label: a.name || `Attack ${i + 1}` }))],
        st.atk == null ? '' : String(st.atk), { cls: 'inp-sm', label: 'Attack', onChange: (v) => { st.atk = v === '' ? null : Number(v); setEnabled(); } });
    };
    const queue = h('button.btn.btn-sm', { type: 'button', onclick: () => act({ t: 'rx.declare', mobUid: st.mob, attackIndex: st.atk, targetUid: st.target }) }, icon('plus', { size: 13 }), 'Queue attack');
    let atkEl = atkSel();
    setEnabled();
    adder = h('div.rx-add',
      select(mobs.map((m) => ({ value: m.uid, label: `${m.name}${m.hidden ? ' (hidden)' : ''}` })), st.mob, { cls: 'inp-sm', label: 'Mob', onChange: (v) => { st.mob = v; st.atk = null; const n = atkSel(); atkEl.replaceWith(n); atkEl = n; setEnabled(); } }),
      atkEl,
      select([{ value: '', label: 'Choose target' }, ...targets.map(targetChoice)], st.target, { cls: 'inp-sm', label: 'Target', onChange: (v) => { st.target = v; setEnabled(); } }),
      queue);
  }

  const waiting = rx.step === 'react' ? missingEvades.length : 0;
  return h('section.panel.rx',
    h('div.sec-head', h('h2', `Round ${rx.round}`), steps, h('span.grow'),
      rx.step === 'declare' ? h('button.btn.btn-sm', { type: 'button', title: 'Mobs attack once each, spread evenly; elites and bosses attack every crawler', onclick: () => act({ t: 'rx.suggest' }, 'Attacks suggested. Change any you like.') }, icon('sparkle', { size: 13 }), 'Suggest') : null,
      rx.step === 'declare' && rx.round === 1 && !rx.decls.length && !rx.surprised ? h('button.btn.btn-sm', { type: 'button', title: 'The crawlers surprised the mobs (Stealth / Ambush beat their Surprise): one free action each before round 1', onclick: () => act({ t: 'rx.surprise' }, 'Surprise round: one free action each.') }, 'Surprise') : null,
      nextBtn),
    rx.step === 'declare' ? h('p.dim.rx-hint', 'Choose each mob’s attack and target, then announce the queue. The target rolls Evade in the next phase.') : null,
    adder,
    pips,
    rx.decls.length ? h('ul.rx-decls', rx.decls.map(declRow)) : null,
    waiting ? h('p.dim', `${waiting} Evade roll${waiting === 1 ? '' : 's'} still missing (phones, or type the die above).`) : null,
    rx.log.length ? h('details.rx-log', h('summary', 'Round log'), h('ul', rx.log.slice().reverse().map((l) => h('li', l)))) : null);
}
