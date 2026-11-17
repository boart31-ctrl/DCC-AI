// GM desk → Fight: reaction rounds (server/reaction.js) for games where the GM never rolls a d20.
// declare (who attacks whom) → react (crawlers spend interrupts on their phones) → resolve (Evade rolls,
// damage) → act (crawlers strike back) → next round.
//
// rxPanel({ act, view }) → Node | null
import { h } from './client.js';
import { icon, select } from './ui.js';

const STEP_LABEL = { declare: '1 Mobs choose', react: '2 Crawlers react', resolve: '3 Hits land', act: '4 Crawlers act', cleanup: '5 Clean up' };
const NEXT = {
  declare: { to: 'react', label: 'Announce attacks', hint: 'Phones and TV show who is attacked; crawlers choose Evade, Take the hit, Taunt…' },
  react: { to: 'resolve', label: 'Let the hits land', hint: 'Every attack lands unless its target evaded it; damage is rolled for you' },
  resolve: { to: 'act', label: 'Crawlers act', hint: 'Remaining actions: attacks go through the sheet rolls' },
  act: { round: true, label: 'Next round', hint: 'Actions reset, mobs declare again' },
  cleanup: { round: true, label: 'Next round', hint: '' },
};
const RESULT = { evaded: 'Evaded', half: 'Half damage', hit: 'Hit' };

export function rxPanel({ act, view }) {
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
  const nameOf = (uid) => { const x = byUid.get(uid); return x ? (x.type === 'mob' ? x.name : players.get(x.playerId)?.name || x.name || '?') : '?'; };
  const mobs = c.combatants.filter((x) => x.type === 'mob' && !x.down && (x.attacks || []).length);
  const next = NEXT[rx.step];

  const steps = h('ol.rx-steps', rx.steps.map((s) => h('li', { class: s === rx.step ? 'on' : '' }, STEP_LABEL[s])));
  const nextBtn = h('button.btn.btn-primary', {
    type: 'button', title: next.hint,
    onclick: async () => {
      if (next.round) return act({ t: 'rx.round' }, `Round ${rx.round + 1}.`);
      const ok = await act({ t: 'rx.step', to: next.to });
      if (!ok && next.to === 'resolve') act({ t: 'rx.step', to: 'resolve', force: true }, 'Resolved (missing Evade rolls counted as no roll).');
    },
  }, next.label);

  const pips = h('div.rx-pips', crawlers.map((x) => {
    const left = rx.acts[x.uid] ?? 2;
    return h('span.rx-pip', { title: `${nameOf(x.uid)}: ${left} action${left === 1 ? '' : 's'} left` },
      h('b', nameOf(x.uid)), h('span.rx-dots', Array.from({ length: Math.max(left, 0) }, () => h('i.on')), rx.evading.includes(x.uid) ? h('span.pill', 'Evading') : null),
      h('button.icon-btn', { type: 'button', title: 'One more action (AI Favor)', onclick: () => act({ t: 'rx.actions', uid: x.uid, delta: 1 }) }, icon('plus', { size: 12 })),
      h('button.icon-btn', { type: 'button', title: 'One action less', onclick: () => act({ t: 'rx.actions', uid: x.uid, delta: -1 }) }, icon('minus', { size: 12 })));
  }));

  const declRow = (d) => {
    const evading = rx.evading.includes(d.targetUid) && !d.caught;
    const dieIn = h('input.inp.inp-sm.rx-die', { type: 'number', min: 1, max: 20, placeholder: 'd20', 'aria-label': `Evade die for ${nameOf(d.targetUid)}` });
    dieIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const v = Number(dieIn.value); if (v >= 1 && v <= 20) act({ t: 'rx.evade', declId: d.id, die: v }); } });
    return h('li.rx-decl', { class: d.result ? `rx-decl rx-${d.result}` : 'rx-decl' },
      h('b', d.mob), h('span.dim', d.attack), icon('target', { size: 13 }),
      rx.step === 'declare' ? select(crawlers.map((x) => ({ value: x.uid, label: nameOf(x.uid) })), d.targetUid, { cls: 'inp-sm', label: `${d.mob} attacks`, onChange: (v) => act({ t: 'rx.retarget', declId: d.id, targetUid: v }) }) : h('b', nameOf(d.targetUid)),
      (rx.step === 'declare' || rx.step === 'react') && !d.evade ? h('button.btn.btn-sm.btn-quiet.rx-adv', { type: 'button', 'aria-pressed': String(!!d.adv), title: 'Advantage (+5 to evade: high ground, size) / Disadvantage (−5: cover, darkness) / normal', onclick: () => act({ t: 'rx.adv', declId: d.id, adv: d.adv === 'adv' ? 'dis' : d.adv === 'dis' ? null : 'adv' }) }, d.adv === 'adv' ? 'Adv +5' : d.adv === 'dis' ? 'Dis −5' : '±') : null,
      d.caught ? h('span.pill', 'Caught') : null, d.taunted ? h('span.pill', 'Taunted') : null,
      h('span.dim.rx-dc', `DC ${d.dc} · ${d.damageDice}`),
      h('span.grow'),
      d.evade ? h('span.pill', { class: `pill rx-deg-${d.evade.degree}` }, `${d.evade.label} (${d.evadeTotal}${d.evade.helped ? `, +${d.evade.helped} help` : ''})`)
        : rx.step === 'react' && evading ? [h('span.dim', 'Evade roll:'), dieIn] : null,
      d.result ? h('span.pill', { class: d.result === 'evaded' ? 'pill pill-on' : 'pill' }, `${RESULT[d.result]}${d.damage ? ` · ${d.damage}` : ''}`) : null,
      rx.step === 'declare' ? h('button.icon-btn', { type: 'button', title: 'Remove', onclick: () => act({ t: 'rx.undeclare', declId: d.id }) }, icon('x', { size: 13 })) : null);
  };

  let adder = null;
  if (rx.step === 'declare' && mobs.length && crawlers.length) {
    const st = { mob: mobs[0].uid, atk: 0, target: crawlers[0].uid };
    const atkSel = () => select((byUid.get(st.mob)?.attacks || []).map((a, i) => ({ value: String(i), label: a.name || `Attack ${i + 1}` })), String(st.atk), { cls: 'inp-sm', label: 'Attack', onChange: (v) => { st.atk = Number(v); } });
    let atkEl = atkSel();
    const row = h('div.rx-add',
      select(mobs.map((m) => ({ value: m.uid, label: `${m.name}${m.hidden ? ' (hidden)' : ''}` })), st.mob, { cls: 'inp-sm', label: 'Mob', onChange: (v) => { st.mob = v; st.atk = 0; const n = atkSel(); atkEl.replaceWith(n); atkEl = n; } }),
      atkEl,
      select(crawlers.map((x) => ({ value: x.uid, label: nameOf(x.uid) })), st.target, { cls: 'inp-sm', label: 'Target', onChange: (v) => { st.target = v; } }),
      h('button.btn.btn-sm', { type: 'button', onclick: () => act({ t: 'rx.declare', mobUid: st.mob, attackIndex: st.atk, targetUid: st.target }) }, icon('plus', { size: 13 }), 'Declare'));
    adder = row;
  }

  const waiting = rx.step === 'react' ? rx.decls.filter((d) => rx.evading.includes(d.targetUid) && !d.caught && !d.evade).length : 0;
  return h('section.panel.rx',
    h('div.sec-head', h('h2', `Round ${rx.round}`), steps, h('span.grow'),
      rx.step === 'declare' ? h('button.btn.btn-sm', { type: 'button', title: 'Mobs attack once each, spread evenly; elites and bosses attack every crawler', onclick: () => act({ t: 'rx.suggest' }, 'Attacks suggested. Change any you like.') }, icon('sparkle', { size: 13 }), 'Suggest') : null,
      nextBtn),
    pips,
    rx.step === 'declare' ? h('p.dim', 'Pick who each mob attacks: Suggest does it by the book (elites and bosses hit everyone), then change any line. Nothing rolls for the mobs.') : null,
    rx.decls.length ? h('ul.rx-decls', rx.decls.map(declRow)) : h('p.empty-s', rx.step === 'declare' ? 'No attacks yet.' : 'No attacks this round.'),
    adder,
    waiting ? h('p.dim', `${waiting} Evade roll${waiting === 1 ? '' : 's'} still missing (phones, or type the die above).`) : null,
    rx.log.length ? h('details.rx-log', h('summary', 'Round log'), h('ul', rx.log.slice().reverse().map((l) => h('li', l)))) : null);
}
