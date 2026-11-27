// GM desk → Fight: reaction rounds (server/reaction.js) for games where the GM never rolls a d20.
// declare (who attacks whom) → react (crawlers spend interrupts on their phones) → resolve (Evade rolls,
// damage) → act (crawlers strike back) → next round.
//
// rxPanel({ act, view }) → Node | null
import { h, ask } from './client.js';
import { icon, openDrawer, select } from './ui.js';

const STEP_LABEL = { declare: '1 Declare', react: '2 React', resolve: '3 Damage', act: '4 Crawlers act', cleanup: '5 Clean up' };
const EMPTY_ACTION = {
  'add-crawlers': ['Add crawler', 'addCrawlers'],
  'add-mobs': ['Add mobs', 'addMobs'],
  'add-attacks': ['Choose a mob with attacks', 'addAttacks'],
  'end-combat': ['End combat', 'endCombat'],
  'review-targets': ['Review targets', 'reviewTargets'],
  'review-conditions': ['Review conditions', 'reviewConditions'],
};
const EMPTY_HINT = {
  'add-crawlers': 'Add a crawler before choosing targets.',
  'add-mobs': 'No mobs are in the fight. Add mobs or choose a saved encounter.',
  'add-attacks': 'No standing mob has a recorded attack. Choose a mob with attacks or let the crawlers act.',
  'end-combat': 'No standing combatants remain on one side.',
};
const RESULT = { evaded: 'Evaded', half: 'Half damage', hit: 'Hit', skipped: 'Skipped' };
const DANGER = { dying: 'Dying', dead: 'Dead', down: 'Down' };
const CONFIRM = { dying: 'Apply and mark Dying', dead: 'Apply fatal hit', down: 'Apply and mark Down' };

function damagePreview({ pending: hit, act, targets, targetChoice }) {
  const apply = async () => {
    if (hit.danger && !(await ask(`${hit.target} will become ${DANGER[hit.danger]} after this hit. Apply it?`, { ok: CONFIRM[hit.danger], danger: true }))) return;
    await act({ t: 'rx.resolveNext', op: 'apply', token: hit.token, ...(hit.danger ? { confirm: true } : {}) });
  };
  const damage = h('input.inp.inp-sm.rx-damage-in', { 'aria-label': 'Physical damage', type: 'number', min: 0, max: 999, value: hit.raw, required: true });
  const others = targets.filter((x) => x.uid !== hit.targetUid).map(targetChoice);
  const redirectBtn = h('button.btn.btn-sm', { type: 'submit', disabled: true }, 'Redirect');
  const redirect = select([{ value: '', label: 'Select a different target' }, ...others], '', { cls: 'inp-sm', label: 'Redirect target', onChange: (v) => { redirectBtn.disabled = !v; } });
  const hasHealth = hit.before != null && hit.after != null;
  const lost = hasHealth ? Math.max(0, hit.before - hit.after) : hit.slots;
  const fallout = [];
  if (hit.danger) fallout.push(h('strong.danger', icon('warn', { size: 14 }), ` ${hit.target} → ${DANGER[hit.danger]}`));
  else if (hit.dyingBefore != null && hit.dyingAfter != null && hit.dyingBefore !== hit.dyingAfter) {
    fallout.push(h('strong.danger', `Dying countdown ${hit.dyingBefore} → ${hit.dyingAfter}`));
  }
  if (hit.injury) fallout.push(h('span', `${hit.injury.severity === 'major' ? 'Major' : 'Minor'} injury · ${hit.injury.desc}`));
  const faces = (hit.die ?? []).filter((d) => d.rolls?.length).map((d) => `${d.term} [${d.rolls.join(', ')}]`).join(' · ');
  const damageMath = [
    `${hit.raw} HP ${faces ? 'rolled' : 'base'}`,
    hit.damage !== hit.raw ? `${hit.damage} HP after Evade` : '',
    hit.afterDr != null && hit.afterDr !== hit.damage ? `${hit.afterDr} HP after protection` : '',
    `${lost} slot${lost === 1 ? '' : 's'} lost`,
  ].filter(Boolean).join(' → ');
  return h('section.rx-preview', { 'aria-label': 'Damage preview', 'data-danger': hit.danger || null },
    h('div.rx-preview-head',
      h('h3', `${hit.mob} · ${hit.attack} → ${hit.target}`),
      h('span.pill', hit.evade ? `Evade · ${hit.evade.label}` : 'No Evade')),
    h('div.rx-preview-numbers',
      h('span', hit.result === 'evaded' ? 'Evaded' : damageMath),
      hasHealth ? h('strong', `Health ${hit.before} → ${hit.after}`) : null,
      hit.formula && faces ? h('small.dim', `${hit.formula} (${faces})`) : null),
    fallout.length ? h('div.rx-preview-fallout', fallout) : null,
    h('div.rx-preview-actions',
      hit.result !== 'evaded' ? h('form.rx-preview-edit', { onsubmit: (e) => {
        e.preventDefault();
        const amount = damage.valueAsNumber;
        damage.blur();
        if (Number.isInteger(amount)) act({ t: 'rx.resolveNext', op: 'change', token: hit.token, amount });
      } }, h('label.rx-physical', h('span.mini-l', 'Physical dice'), damage), h('button.btn.btn-sm', { type: 'submit', title: 'Replace the rolled value before Evade, armour and protection' }, 'Change damage')) : null,
      others.length ? h('details.rx-change-target', h('summary', 'Change target'),
        h('form.rx-preview-edit', { onsubmit: (e) => {
          e.preventDefault();
          if (redirect.value) act({ t: 'rx.resolveNext', op: 'redirect', token: hit.token, targetUid: redirect.value });
        } }, redirect, redirectBtn)) : null,
      h('span.grow'),
      h('button.btn.btn-sm.btn-quiet', { type: 'button', title: 'Recalculate against current health and defences', onclick: () => act({ t: 'rx.resolveNext', op: 'preview' }) }, 'Refresh preview'),
      h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => act({ t: 'rx.resolveNext', op: 'skip', token: hit.token }) }, 'Skip attack'),
      h(`button.btn.rx-primary.${hit.danger ? 'btn-danger' : 'btn-primary'}`, { type: 'button', onclick: apply }, `Apply to ${hit.target}`)));
}

function batchPreview(batch, act) {
  const lines = Object.entries(DANGER).map(([id, label]) => {
    const names = batch.victims.filter((p) => p.danger === id).map((p) => p.name);
    return names.length ? `${label} · ${names.join(', ')}` : '';
  }).filter(Boolean);
  const apply = async () => {
    const yes = await ask(h('div', h('b', `Apply all ${batch.count} attacks?`), lines.length ? h('ul', lines.map((line) => h('li', line))) : h('p', 'No crawler would reach zero health.')),
      { ok: 'Apply all attacks', danger: lines.length > 0 });
    if (yes) await act({ t: 'rx.resolveNext', op: 'apply', all: true, token: batch.token, confirm: true });
  };
  return h('section.rx-preview.rx-batch', { 'aria-label': 'Batch damage preview', 'data-danger': lines.length ? 'batch' : null },
    h('div.rx-preview-head', h('h3', `Resolve ${batch.count} attacks`)),
    lines.length ? h('ul.rx-batch-victims.danger', lines.map((line) => h('li', line))) : h('p.dim', 'No crawler would reach zero health.'),
    h('div.rx-preview-actions',
      h('button.btn.btn-sm', { type: 'button', onclick: () => act({ t: 'rx.resolveNext', op: 'preview' }) }, 'Review one at a time'),
      h('span.grow'),
      h('button.btn.btn-sm.btn-quiet', { type: 'button', title: 'Recalculate against current health and defences', onclick: () => act({ t: 'rx.resolveNext', op: 'preview', all: true }) }, 'Refresh preview'),
      h(`button.btn.rx-primary.${lines.length ? 'btn-danger' : 'btn-primary'}`, { type: 'button', onclick: apply }, 'Apply all')));
}

export function rxPanel({ act, view, draft, guide = {} }) {
  const c = view?.combat;
  if (!c?.active) return null;
  const family = view?.pack?.ruleset?.system?.family || 'crawler';
  const rx = c.rx;
  if (!rx) {
    if (family !== 'crawler' || view?.pack?.ruleset?.combat?.flow !== 'reaction') return null;
    return h('section.panel.rx', h('div.sec-head', h('h2', 'Rounds'), h('span.dim', 'The GM never rolls a d20: mobs declare, crawlers react')),
      h('button.btn.btn-primary.rx-primary', { type: 'button', onclick: () => act({ t: 'rx.start' }, 'Round 1: declare the mob attacks.') }, 'Start round 1'));
  }
  const byUid = new Map(c.combatants.map((x) => [x.uid, x]));
  const players = new Map((view.players || []).map((p) => [p.id, p]));
  const crawlers = c.combatants.filter((x) => x.type === 'crawler');
  const targets = crawlers.filter((x) => !x.dead);
  const nameOf = (uid) => { const x = byUid.get(uid); return x ? (x.type === 'mob' ? x.name : players.get(x.playerId)?.name || x.name || '?') : '?'; };
  const targetChoice = (x) => ({ value: x.uid, label: `${nameOf(x.uid)}${x.dying != null ? ' (dying)' : ''}` });
  const missingEvades = rx.decls.filter((d) => d.canEvade && !d.evade);
  const mobRows = c.combatants.filter((x) => x.type === 'mob');
  const standingMobs = mobRows.filter((x) => !x.down);
  const mobs = standingMobs.filter((x) => x.attacks?.length);
  const hasFavor = view.pack?.ruleset?.fields.some((f) => f.id === 'aiFavor');
  const remaining = rx.decls.filter((d) => !d.result).length;
  const declared = rx.decls.length;
  const hiddenQueued = rx.decls.filter((d) => byUid.get(d.mobUid)?.hidden).length;
  const stillStanding = targets.some((x) => !x.down && x.dying == null);
  const suggestion = rx.suggestion;
  const status = h('p.dim.rx-status', { role: 'status' });

  const steps = h('ol.rx-steps', rx.steps.map((s) => h('li', { class: s === rx.step ? 'on' : '', 'aria-current': s === rx.step ? 'step' : null }, STEP_LABEL[s])));
  const stepTo = (to, fields = {}) => act({ t: 'rx.step', to, ...fields });
  const primary = (label, onclick, title = null) => h('button.btn.btn-primary.rx-primary', { type: 'button', onclick, title }, label);
  const suggest = async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      const r = await act({ t: 'rx.suggest' });
      if (r?.result?.message) status.textContent = r.result.message;
    } finally { button.disabled = false; }
  };
  const preview = async (e, all = false) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      if (rx.step === 'react') {
        if (missingEvades.length) {
          const names = [...new Set(missingEvades.map((d) => nameOf(d.targetUid)))].join(', ');
          const yes = await ask(`Still waiting for ${missingEvades.length} Evade roll${missingEvades.length === 1 ? '' : 's'} (${names}). Continue to damage review without those rolls?`, { ok: 'Resolve without Evade', danger: true });
          if (!yes) return;
        }
        if (!(await stepTo('resolve', missingEvades.length ? { force: true } : {}))) return;
      }
      await act({ t: 'rx.resolveNext', op: 'preview', ...(all ? { all: true } : {}) });
    } finally { button.disabled = false; }
  };
  const previewBatch = () => h('button.btn.btn-sm', { type: 'button', onclick: (e) => preview(e, true) }, 'Resolve all…');
  const secondary = [];
  let nextBtn = null;
  if (rx.step === 'declare') {
    if (declared) {
      status.textContent = hiddenQueued ? `${hiddenQueued} attack${hiddenQueued === 1 ? '' : 's'} from hidden mobs. Announcing reveals those attackers.` : 'Review the targets, then announce to notify the players.';
      if (mobs.length && stillStanding) secondary.push(h('button.btn.btn-sm', { type: 'button', title: 'Add suggestions without replacing attacks you queued', onclick: suggest }, 'Suggest attacks'));
      nextBtn = primary(`Announce attacks (${declared})`, () => stepTo('react'));
    } else {
      const fallback = !crawlers.length ? 'add-crawlers' : !stillStanding || (mobRows.length && !standingMobs.length) ? 'end-combat'
        : !standingMobs.length ? 'add-mobs' : !mobs.length ? 'add-attacks' : 'suggest';
      const next = EMPTY_ACTION[suggestion?.next ?? fallback];
      status.textContent = suggestion?.message || EMPTY_HINT[fallback] || 'Queue an attack and target below, or suggest attacks to review.';
      if (next && guide[next[1]]) nextBtn = primary(next[0], guide[next[1]]);
      else if (mobs.length && stillStanding) nextBtn = primary('Suggest attacks', suggest);
      if (stillStanding) secondary.push(h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => stepTo('act') }, 'Skip mob attacks'));
    }
    if (rx.round === 1 && !declared && !rx.surprised && stillStanding && mobs.length) secondary.unshift(h('button.btn.btn-sm.btn-quiet', {
      type: 'button', title: 'The crawlers surprised the mobs: one free action each before round 1', onclick: () => act({ t: 'rx.surprise' }, 'Surprise round: one free action each.'),
    }, 'Surprise'));
  } else if (rx.step === 'react') {
    const waiting = missingEvades.length;
    status.textContent = waiting ? `Waiting for ${waiting} Evade roll${waiting === 1 ? '' : 's'} from phones or the dice fields below.`
      : remaining ? 'Crawlers can react until you open damage review.' : 'No mob attacks to resolve.';
    if (remaining > 1) secondary.push(previewBatch());
    nextBtn = remaining ? primary('Resolve next hit', preview) : primary('Crawlers act', () => stepTo('act'));
  } else if (rx.step === 'resolve') {
    if (!remaining) nextBtn = primary('Crawlers act', () => stepTo('act'));
    else if (!rx.pending && !rx.batch) {
      if (remaining > 1) secondary.push(previewBatch());
      nextBtn = primary('Resolve next hit', preview);
    }
  } else {
    nextBtn = primary('Clean up', () => act({ t: 'rx.round', round: rx.round }, `Round ${rx.round + 1}.`), 'Apply end-of-round effects and start the next round');
  }
  if (rx.canUndo) secondary.unshift(h('button.btn.btn-sm.btn-quiet', {
    type: 'button', title: 'Restore the target before the last hit (Ctrl+Z)', onclick: () => act({ t: 'rx.resolveNext', op: 'undo' }),
  }, icon('undo', { size: 13 }), 'Undo last hit'));

  const pips = h('div.rx-pips', crawlers.map((x) => {
    const left = rx.acts[x.uid] ?? 2;
    const extra = rx.nonAttackActions?.[x.uid] ?? 0;
    const canBuy = hasFavor && ['react', 'act'].includes(rx.step) && !x.dead && x.dying == null && !rx.favor?.includes(x.uid);
    return h('span.rx-pip', { title: `${nameOf(x.uid)}: ${left} action${left === 1 ? '' : 's'} left` },
      h('b', nameOf(x.uid)), rx.step === 'act' && !left && !extra ? h('strong', 'Turn complete') : null, h('span.rx-dots', Array.from({ length: Math.max(left, 0) }, () => h('i.on')), extra ? h('span.pill', { title: 'One non-attack action from AI Favor' }, '+1 utility') : null, rx.evading.includes(x.uid) ? h('span.pill', 'Evading') : null),
      canBuy ? h('button.icon-btn', { type: 'button', title: 'Spend 1 AI Favor for a non-attack action', onclick: () => act({ t: 'rx.favor', uid: x.uid }) }, icon('sparkle', { size: 12 })) : null,
      h('button.icon-btn', { type: 'button', title: 'Adjust base actions up', onclick: () => act({ t: 'rx.actions', uid: x.uid, delta: 1 }) }, icon('plus', { size: 12 })),
      h('button.icon-btn', { type: 'button', title: 'One action less', onclick: () => act({ t: 'rx.actions', uid: x.uid, delta: -1 }) }, icon('minus', { size: 12 })));
  }));

  const declRow = (d) => {
    const attacks = byUid.get(d.mobUid)?.attacks ?? [];
    const attackChoices = attacks.map((a, i) => ({ value: String(i), label: a.name }));
    const planned = rx.step === 'declare';
    const dieIn = h('input.inp.inp-sm.rx-die', { type: 'number', min: 1, max: 20, placeholder: 'd20', 'aria-label': `Evade die for ${nameOf(d.targetUid)}` });
    dieIn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const die = dieIn.valueAsNumber;
      if (!Number.isInteger(die) || die < 1 || die > 20) return;
      dieIn.blur();
      act({ t: 'rx.evade', declId: d.id, die });
    });
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
      d.result ? h('span.pill', { class: d.result === 'evaded' ? 'pill pill-on' : 'pill', title: d.damageAfterDr != null && d.damageAfterDr !== d.damage ? `${d.damageAfterDr} HP after DR and typed protection` : null }, `${RESULT[d.result] ?? d.result}${d.damage != null && !['evaded', 'skipped'].includes(d.result) ? ` · ${d.damage} HP${d.slots != null ? ` → ${d.slots} slot${d.slots === 1 ? '' : 's'}` : ''}` : ''}`) : null,
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

  return h('section.panel.rx', { 'data-rx-step': rx.step },
    h('div.sec-head', h('h2', `Round ${rx.round}`), steps,
      secondary.length || nextBtn ? h('div.rx-phase-actions', secondary, nextBtn) : null),
    status,
    adder,
    remaining && rx.batch ? batchPreview(rx.batch, act) : null,
    remaining && rx.pending ? damagePreview({ pending: rx.pending, act, targets, targetChoice }) : null,
    pips,
    rx.decls.length ? h('ul.rx-decls', rx.decls.map(declRow)) : null,
    rx.log.length ? h('details.rx-log', h('summary', 'Round log'), h('ul', rx.log.slice().reverse().map((l) => h('li', l)))) : null);
}
