// Roll pad (player phone): dice entry against a target.
//   Pick what you do (attack, skill, save, ability...) -> in a fight pick the monster -> type the number on your real
//   die (or let the phone roll) -> the app adds your modifiers and says HIT / MISS. After a hit: damage the same way,
//   it lands on the monster. No player undo (the GM can take a roll back). The GM sees the defence and the margin, players never do.
// Dice modes (per crawler, `dice.mode`): off = the phone only explains numbers; enter = keypad first; digital = Roll first.
import { h, toast, buzz } from './client.js';
import { dieFaces, icon, signed, spellCooldownHint } from './ui.js';
import { statCheckBonus } from './rules.js';

const KEEP_TARGET_MS = 5 * 60 * 1000;

/**
 * opts: { send(action) -> Promise<{result}>, getView() -> view, getMe() -> me }
 * returns { open(what, label), openPicker(), el, update() }
 */
export function createRollPad({ send, getView, getMe }) {
  const el = h('div.rp', { hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Roll' });
  const panel = h('div.rp-sheet');
  el.append(h('div.rp-scrim', { onclick: close }), panel);
  const st = { what: null, label: '', target: null, adv: null, bonus: 0, digits: '', step: 'pick', result: null, after: null, busy: false, lastTarget: null, lastTargetAt: 0 };
  let renderedStep = null;
  let viewKey = '';

  const V = () => getView() || {};
  const me = () => getMe();
  const rs = () => V().pack?.ruleset || {};
  const rules = () => rs().combat || {};
  const mode = () => me()?.diceMode || 'enter';
  const sides = () => Number(String(rs().dice || 'd20').replace(/^d/, '')) || 20;
  const combat = () => V().combat || {};
  const mobs = () => (combat().active ? (combat().combatants || []).filter((x) => x.type === 'mob' && !x.down) : []);
  const isStrike = (what) => what?.kind === 'attack' || what?.kind === 'spell';
  const isAttack = () => isStrike(st.what) && st.what.part !== 'damage';
  const isDamage = () => isStrike(st.what) && st.what.part === 'damage';
  const self = () => combat().combatants?.find((x) => x.type === 'crawler' && x.playerId === me()?.id);
  const myRound = () => self() ? combat().rx : null;
  const defLabel = () => rules().defenseLabel || combat().defenseLabel || 'Defence';
  const inherentAdv = (what) => {
    if (what?.kind === 'untrained') return rs().skills?.untrained?.adv;
    if (what?.kind === 'spell' && what.part !== 'damage') return me()?.sheet?.spells?.find((s) => s.uid === what.uid)?.attack?.adv;
    return null;
  };

  function bonusOf(what) {
    const c = me()?.sheet?.computed;
    if (!c || !what) return null;
    if (what.kind === 'stat') return c.stats?.[what.id]?.mod?.value ?? null;
    if (what.kind === 'derived') return c.derived?.[what.id]?.value ?? null;
    if (what.kind === 'untrained') { const d = (V().library?.skill || []).find((x) => x.id === what.skillId); return d ? c.stats?.[d.stat]?.mod?.value ?? null : null; }
    if (what.kind === 'skill') return c.skills?.find((x) => x.uid === what.uid)?.total?.value ?? null;
    if (what.kind === 'attack' && what.part !== 'damage') return c.attacks?.find((x) => x.uid === what.uid)?.toHit?.value ?? null;
    if (what.kind === 'spell' && what.part !== 'damage') return c.spells?.find((x) => x.uid === what.uid)?.toHit?.value ?? null;
    return null;
  }
  const damageText = (what) => {
    const rows = me()?.sheet?.computed?.[what?.kind === 'spell' ? 'spells' : 'attacks'];
    const profile = rows?.find((x) => x.uid === what?.uid);
    return profile?.damageDice || profile?.damage || '';
  };

  function close() {
    el.hidden = true;
    document.body.classList.remove('rp-open');
    st.step = 'pick';
    st.result = null;
    st.favorOpen = false;
  }

  /** Opens the pad for one roll (from a tap on the sheet). */
  function open(what, label, target) {
    if (!me() || st.busy) return;
    const rx = myRound();
    const usesAction = rx && isStrike(what) && what.part !== 'damage';
    if (usesAction && (rx.step !== 'act' || (rx.acts[self().uid] ?? 2) < 1 || self().down || self().dead || self().dying != null)) {
      toast('Check Combat for your current phase and actions.', { error: true });
      return;
    }
    if (usesAction && what.kind === 'spell' && rs().hotlist?.combat && !me().sheet?.hotlist?.includes(what.uid)) {
      toast('Add this spell to the Hotlist before casting.', { error: true });
      return;
    }
    st.what = what;
    st.actionRound = usesAction ? rx.round : null;
    st.label = label || 'Roll';
    st.digits = '';
    st.bonus = 0;
    st.adv = null;
    st.result = null;
    st.favorOpen = false;
    st.after = null;
    st.step = 'roll';
    // Keep aiming at the monster you just attacked (5 minutes), else the only one standing.
    const alive = mobs();
    const keep = st.lastTarget && Date.now() - st.lastTargetAt < KEEP_TARGET_MS && alive.some((m) => m.uid === st.lastTarget);
    // undefined = not chosen yet (attacks in a fight must pick a monster or say "no target"), null = no target
    const chosen = target && alive.some((m) => m.uid === target);
    st.target = isAttack() || (isDamage() && !rx) ? (chosen ? target : keep ? st.lastTarget : alive.length === 1 ? alive[0].uid : alive.length ? undefined : null) : null;
    draw();
    el.hidden = false;
    document.body.classList.add('rp-open');
    buzz(6);
  }

  /** Action list (Roll button): attacks, skills, saves and other rollable numbers, abilities. */
  function openPicker({ target, attacksOnly = false } = {}) {
    if (!me() || st.busy) return;
    st.pickerTarget = target;
    st.attacksOnly = attacksOnly;
    st.query = '';
    st.step = 'pick';
    st.result = null;
    st.favorOpen = false;
    draw();
    el.hidden = false;
    document.body.classList.add('rp-open');
  }

  async function submit({ digital = false, face = null } = {}) {
    if (st.busy) return;
    const n = face ?? Number(st.digits);
    if (!digital && (!Number.isInteger(n) || n < 1 || n > (isDamage() ? 999 : sides()))) {
      toast(isDamage() ? 'Type what your damage dice show' : `Type 1 to ${sides()}`, { error: true });
      return;
    }
    const a = { t: 'roll', what: st.what };
    if (st.actionRound != null && isAttack()) {
      const rx = myRound();
      if (rx?.step !== 'act' || rx.round !== st.actionRound) {
        toast('The combat phase changed. Open a fresh attack from Combat.', { error: true });
        close();
        return;
      }
      a.useAction = true;
    }
    if (!digital) a.entered = n;
    if (st.target) a.target = st.target;
    if (st.target === undefined) { toast('Pick who you attack, or No target', { error: true }); return; }
    if (st.adv) a.adv = st.adv;
    if (st.bonus) a.bonus = st.bonus;
    if (st.after) a.after = st.after;
    st.busy = true;
    try {
      const r = await send(a);
      const roll = r?.result?.roll || (V().rolls || []).find((x) => x.id === r?.result?.rollId) || null;
      st.result = { ...(r?.result || {}), roll, total: r?.result?.total, natural: digital ? null : n };
      if (st.target) { st.lastTarget = st.target; st.lastTargetAt = Date.now(); }
      st.step = 'result';
      buzz(st.result.hit ? [20, 40, 20] : 15);
      draw();
    } catch (err) {
      toast(err.message || 'Refused', { error: true, ms: 3500 });
    } finally {
      st.busy = false;
    }
  }

  function damageNext() {
    const rollId = st.result?.rollId;
    st.what = { kind: st.what.kind, uid: st.what.uid, part: 'damage' };
    st.label = `${st.label.replace(/ to hit$/i, '')} damage`;
    st.after = rollId || null;
    st.critPending = !!st.result?.crit;
    st.digits = '';
    st.bonus = 0;
    st.result = null;
    st.favorOpen = false;
    st.step = 'roll';
    draw();
  }

  /* ---------- drawing ---------- */

  function head(title, sub) {
    return h('div.rp-head',
      h('div.rp-title', h('b', title), sub ? h('span.rp-sub', sub) : null),
      h('button.btn.btn-quiet.rp-x', { type: 'button', 'aria-label': 'Close', onclick: close }, icon('x', { size: 20 })));
  }

  function pickList() {
    const c = me()?.sheet?.computed || {};
    const sh = me()?.sheet || {};
    const R = rs();
    const statAbbr = (id) => (R.stats || []).find((x) => x.id === id)?.abbr || '';
    const q = (st.query || '').trim().toLowerCase();
    const hit = (label) => !q || label.toLowerCase().includes(q);
    const btn = (what, label, val, unavailable, meta) => h('button.rp-act', { type: 'button', disabled: !!unavailable, onclick: () => open(what, label, st.pickerTarget) },
      h('span', label, meta ? h('small.dim.rp-meta', meta) : null, unavailable ? h('small.dim', unavailable) : null), val == null ? null : h('b', signed(val)));
    const dmgOf = (a) => { const d = c.attacks?.find((x) => x.uid === a.uid)?.damage || a.dice; return d ? String(d).replace(/\+\s*-/g, '− ') : null; };
    const avgOf = (d) => { const m = /^(\d*)d(\d+)\s*(?:([+−-])\s*(\d+))?$/.exec(String(d || '').replace(/\s+/g, ' ').trim().replace(/ /g, '')); if (!m) return null; const n = +(m[1] || 1); const v = n * (+m[2] + 1) / 2 + (m[3] ? (m[3] === '+' ? 1 : -1) * +m[4] : 0); return Math.round(v * 10) / 10; };
    const attacks = (sh.attacks || []).filter((a) => hit(a.name)).map((a) => { const d = dmgOf(a); const avg = avgOf(d); return btn({ kind: 'attack', uid: a.uid }, `${a.name} to hit`, c.attacks?.find((x) => x.uid === a.uid)?.toHit?.value, null, d ? `damage ${d}${avg != null ? ` · avg ${avg}` : ''}` : null); });
    const spells = R.spells?.attackChecks ? (sh.spells || []).filter((d) => d.attackCheck && (!myRound() || !R.hotlist?.combat || sh.hotlist?.includes(d.uid)) && hit(d.name))
      .map((d) => {
        const row = c.spells?.find((x) => x.uid === d.uid);
        return btn({ kind: 'spell', uid: d.uid }, `${d.name} to hit`, row?.toHit?.value, spellCooldownHint(row?.cooldown));
      }) : [];
    const derived = (R.derived || []).filter((d) => d.roll && hit(d.label)).map((d) => btn({ kind: 'derived', id: d.id }, d.label, c.derived?.[d.id]?.value));
    // Skills: one entry per name (Jump/Jumping style duplicates collapse), stat + rank shown so the bonus is never a mystery.
    const norm = (n) => String(n || '').toLowerCase().replace(/[^a-z]/g, '').replace(/(ing|s)$/, '');
    const seen = new Set();
    const mine = (sh.skills || []).slice().sort((a, b) => a.name.localeCompare(b.name)).filter((s) => { const k = norm(s.name); if (seen.has(k)) return false; seen.add(k); return true; });
    const skills = mine.filter((s) => hit(s.name)).map((s) => btn({ kind: 'skill', uid: s.uid }, s.name, c.skills?.find((x) => x.uid === s.uid)?.total?.value ?? (s.rank ?? 0), null,
      [statAbbr(s.stat), `Rank ${s.rank ?? 0}`].filter(Boolean).join(' · ')));
    const stats = (R.stats || []).filter((s) => hit(`${s.abbr} ${s.label}`)).map((s) => btn({ kind: 'stat', id: s.id }, `${s.label || s.abbr}`, statCheckBonus(c, s.id).value, null, `${s.abbr} · raw stat check`));
    const group = (t, list, note) => (list.length ? h('section.rp-group', h('h3', t), note ? h('p.hint', note) : null, h('div.rp-acts', list)) : null);
    if (st.attacksOnly) return h('div.rp-body', head('Choose an attack', null), h('div.rp-scroll',
      group('Attacks', attacks, attacks.length > 1 ? 'Big number = chance to hit. “damage 1d10” = how hard it hurts: a bigger die often beats +2 to hit.' : null), group('Attack spells', spells),
      h('details.rp-dice-help', h('summary', 'What do d20 and 1d8+3 mean?'), h('p.hint', 'd20 = a 20-sided die (the main die). 1d8 + 3 = roll one 8-sided die and add 3. 2d6 = roll two 6-sided dice and add them up. “avg” = what it does on an average roll.')),
      !attacks.length && !spells.length ? h('p.hint', 'Your sheet has no attacks yet.') : null));
    // Untrained (DCC): any library skill not on the sheet, with Disadvantage and only the Stat Mod.
    const U = R.skills?.untrained;
    const have = new Set((sh.skills || []).map((x) => x.skillId));
    const hide = new Set([...(R.skills?.hideTags || []), ...(U?.hideTags || [])]);
    const untrained = U ? (V().library?.skill || []).filter((d) => !have.has(d.id) && !(U.noCheckTypes || []).includes(d.checkType) && !(d.tags || []).some((t) => hide.has(t)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .filter((d) => { const k = norm(d.name); if (seen.has(k)) return false; seen.add(k); return hit(d.name); })
      .map((d) => btn({ kind: 'untrained', skillId: d.id }, d.name, c.stats?.[d.stat]?.mod?.value ?? 0, null, `${statAbbr(d.stat) || 'no stat'} · untrained`)) : [];
    const search = h('input.inp.inp-search.rp-search', { type: 'search', placeholder: 'Find a skill, e.g. Perception', value: st.query || '', 'aria-label': 'Find what to roll',
      oninput: (e) => { st.query = e.target.value; const pos = e.target.selectionStart; draw(); const n = el.querySelector('.rp-search'); n?.focus(); n?.setSelectionRange(pos, pos); } });
    const untrainedNote = `Roll ${U?.adv === 'dis' ? 'with Disadvantage (2 dice, keep the lower)' : ''}, Stat Mod only.${U?.learn ? ' On the Tutorial Floors you may learn one of these at the end of the session.' : ''}`;
    const untrainedGroup = untrained.length ? (q ? group('Try untrained', untrained, untrainedNote)
      : h('details.rp-group.rp-untrained', h('summary', h('h3', `Try a skill you don't have (${untrained.length})`)), h('p.hint', untrainedNote), h('div.rp-acts', untrained))) : null;
    const inFight = !!myRound();
    const empty = q && !attacks.length && !spells.length && !derived.length && !skills.length && !stats.length && !untrained.length;
    return h('div.rp-body', head('What do you roll?', null), h('div.rp-scroll',
      search,
      inFight ? [group('Attacks', attacks), group('Attack spells', spells)] : null,
      group('Your skills', skills, !q && skills.length ? 'Your bonus = Rank + stat modifier (+ items). It is added for you.' : null),
      !inFight ? [group('Attacks', attacks), group('Attack spells', spells)] : null,
      group('Saves & more', derived), group('Stats (only when the GM asks for a stat, not a skill)', stats),
      untrainedGroup,
      empty ? h('p.hint', `Nothing matches “${st.query}”.`) : null,
      !attacks.length && !skills.length && !q ? h('p.hint', 'Your sheet has nothing to roll yet. Ask the GM to set it up.') : null));
  }

  const SIZES = { tiny: 1, small: 2, petite: 3, medium: 4, large: 5, huge: 6, colossal: 7, gargantuan: 8 };
  /** Book size rule: a target sizeGap+ classes bigger → Advantage, smaller → Disadvantage. */
  function sizeHint() {
    const R = rules();
    if (!R.sizeGap || !isAttack() || !st.target) return null;
    const m = mobs().find((x) => x.uid === st.target);
    if (!Number.isInteger(m?.size)) return null;
    const mine = SIZES[String(me()?.sheet?.fields?.size || '').toLowerCase()] || R.crawlerSize || 4;
    const gap = m.size - mine;
    if (gap >= R.sizeGap) return { adv: 'adv', text: `${m.name} is much bigger: Advantage.` };
    if (-gap >= R.sizeGap) return { adv: 'dis', text: `${m.name} is much smaller: Disadvantage.` };
    return null;
  }

  function targetRow() {
    const list = mobs();
    if (!(isAttack() || isDamage()) || !list.length) return null;
    if (isDamage() && myRound()) {
      const target = list.find((m) => m.uid === st.target);
      return target ? h('p.rp-hint', `Damage to ${target.name}`) : h('p.rp-hint', 'To apply damage to an enemy, land an attack from Combat first.');
    }
    return h('div.rp-targets', h('span.rp-l', isDamage() ? 'Damage to' : 'Attack'),
      // Stable order (by name, numbers in order) so a chip never moves under the finger when the view updates.
      h('div.rp-chips', [...list].sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true })).map((m) => h('button.chip', { type: 'button', 'aria-pressed': String(st.target === m.uid), onclick: () => { if (st.target === m.uid) return; st.target = m.uid; draw(); } }, m.name)),
        h('button.chip', { type: 'button', 'aria-pressed': String(st.target === null), onclick: () => { st.target = null; draw(); } }, 'No target')),
      // Always takes its line, so the dice below don't jump up when a target is picked.
      h('span.rp-need', { style: st.target === undefined ? null : 'visibility:hidden' }, 'Pick a target or No target to roll.'));
  }

  function modsRow() {
    const b = bonusOf(st.what);
    const inherent = inherentAdv(st.what);
    const advOn = !!rules().advantage && !isDamage();
    const sz = sizeHint();
    const earned = evadeAdvantage();
    const advLabel = (a) => a === 'adv' ? 'Advantage' : 'Disadvantage';
    return h('div.rp-mods',
      b == null ? null : h('span.rp-mod', `Your modifier ${signed(b)}`),
      advOn ? h('div.rp-adv', ['adv', 'dis'].map((k) => h('button.chip', { type: 'button', 'aria-pressed': String(st.adv === k), onclick: () => { st.adv = st.adv === k ? null : k; draw(); } }, advLabel(k)))) : null,
      inherent ? h('span.rp-hint', `${st.label} starts with ${advLabel(inherent)}.`) : null,
      sz ? h('span.rp-hint', sz.text) : null,
      earned ? h('span.rp-hint', 'Your Evade earned Advantage against this target.') : null);
  }

  function evadeAdvantage() {
    return isAttack() && myRound()?.advantage?.some((a) => a.uid === self()?.uid && a.mobUid === st.target);
  }

  function physicalDieHint() {
    const count = [st.adv, inherentAdv(st.what), sizeHint()?.adv, evadeAdvantage() ? 'adv' : null]
      .reduce((n, a) => n + (a === 'adv' ? 1 : a === 'dis' ? -1 : 0), 0);
    const keep = count ? ` twice and keep the ${count > 0 ? 'higher' : 'lower'} number` : '';
    return `Roll your d${sides()}${keep}, then ${sides() === 20 ? 'tap' : 'enter'} the result`;
  }

  function keypad() {
    const max = isDamage() ? 999 : sides();
    if (!isDamage() && max === 20) return dieFaces(max, (face) => submit({ face }), { disabled: st.busy || st.target === undefined });
    const press = (k) => {
      if (k === 'del') st.digits = st.digits.slice(0, -1);
      else if (st.digits.length < (max >= 100 ? 3 : 2)) st.digits = `${st.digits}${k}`.replace(/^0+/, '');
      buzz(4);
      draw();
    };
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];
    return h('div.rp-pad',
      h('div.rp-shown', { 'aria-live': 'polite' }, st.digits || (isDamage() ? 'Damage' : `1–${max}`)),
      h('div.keypad.rp-keys', keys.map((k) => (k === 'ok'
        ? h('button.rp-ok', { type: 'button', disabled: !st.digits || st.busy || st.target === undefined, onclick: () => submit() }, 'OK')
        : k === 'del' ? h('button.k-soft', { type: 'button', 'aria-label': 'Delete', onclick: () => press('del') }, '⌫')
          : h('button', { type: 'button', onclick: () => press(k) }, k)))));
  }

  function rollStep() {
    const dmg = isDamage();
    const enterFirst = mode() !== 'digital';
    const critNote = st.after && st.critPending ? (rules().crit === 'dice' ? ' — critical: roll the dice twice' : ' — critical: the app doubles it') : '';
    const physical = dmg ? `Roll ${damageText(st.what) || 'your damage dice'}${critNote} and enter the total shown on the dice` : physicalDieHint();
    const sub = enterFirst || dmg ? physical : 'Roll here or enter a physical die';
    const digitalBtn = h('button.btn.btn-primary.rp-digital', { type: 'button', disabled: st.busy || st.target === undefined, onclick: () => submit({ digital: true }) }, icon('dice', { size: 18 }), dmg ? 'Roll damage for me' : 'Roll for me');
    return h(enterFirst ? 'div.rp-body.rp-entry' : 'div.rp-body', head(st.label, sub), h('div.rp-scroll',
      targetRow(), modsRow(),
      enterFirst ? keypad() : [digitalBtn, h('details.rp-alt', h('summary', 'I rolled a real die'), dmg ? null : h('p.rp-hint', physical), keypad())]),
    enterFirst ? h('footer.rp-roll-footer', digitalBtn) : null);
  }

  function resultStep() {
    const r = st.result || {};
    const roll = r.roll || {};
    const total = r.total ?? roll.total;
    const hasVs = r.hit !== undefined;
    const natural = roll.natural ?? r.natural ?? roll.dice?.find((d) => d.die === `d${sides()}`)?.value;
    const values = isDamage() ? (roll.dice || []).map((d) => d.value) : [natural];
    const hasDice = values.length && values.every(Number.isFinite);
    const modifier = hasDice ? total - values.reduce((sum, n) => sum + n, 0) : 0;
    const equation = hasDice && Number.isFinite(total)
      ? `${isDamage() ? '' : `d${sides()} `}${values.join(' + ')}${modifier < 0 ? ` − ${-modifier}` : ` + ${modifier}`} = ${total}`
      : '';
    const advantage = roll.adv && Number.isFinite(roll.otherDie) && Number.isFinite(natural)
      ? `Kept ${natural} of ${natural} and ${roll.otherDie} (${roll.adv === 'adv' ? 'Advantage' : 'Disadvantage'})`
      : '';
    const unit = rules().flow === 'reaction' || roll.vs?.slotValue != null ? 'slots' : 'HP';
    const dmgLabel = isDamage() ? (r.applied ? (r.applied.after <= 0 ? 'DOWN!' : `−${-r.applied.delta} ${unit}`) : roll.vs?.uid ? 'No health lost' : 'Tell the GM') : null;
    const typedNote = isDamage() && r.typed ? { immune: 'Immune to that: no damage.', resistant: 'Resistant: half damage.', vulnerable: 'Vulnerable: double damage!' }[r.typed] : null;
    const DEG7 = { crit: 'CRITICAL HIT', amazing: 'AMAZING', success: isAttack() ? 'HIT' : 'SUCCESS', near: 'NEAR MISS', fail: isAttack() ? 'MISS' : 'FAIL', major: 'MAJOR FAIL', critfail: 'CRITICAL FAIL' };
    const label = dmgLabel ?? (r.deg7 ? DEG7[r.deg7] : !hasVs ? null : r.degree === 3 ? (rules().degrees ? 'CRITICAL SUCCESS' : 'CRITICAL HIT') : r.hit ? (isAttack() ? 'HIT' : 'SUCCESS') : r.degree === 0 && rules().degrees ? 'CRITICAL FAILURE' : isAttack() ? 'MISS' : 'FAIL');
    const actions = r.receipt?.actionsLeft;
    return h('div.rp-body', head(st.label, null), h('div.rp-scroll',
      h('div.rp-result', { class: `rp-result${hasVs ? (r.hit ? ' is-hit' : ' is-miss') : r.applied ? ' is-hit' : ''}${r.crit ? ' is-crit' : ''}` },
        h('span.rp-total', String(total ?? '?')),
        equation ? h('span.rp-math', equation) : null,
        advantage ? h('span.rp-math', advantage) : null,
        roll.vs?.name ? h('span.rp-math', roll.vs.name) : null,
        label ? h('span.rp-verdict', label) : h('span.rp-verdict.dim', 'Tell the GM')),
      typedNote ? h('p.rp-note', typedNote) : null,
      r.receipt?.spent ? h('p.rp-note', `1 action spent · ${actions} action${actions === 1 ? '' : 's'} left after this roll`) : null,
      r.deg7 === 'near' ? h('p.rp-note', 'So close. A friend can Intervene: their phone offers +1d6 now.') : null,
      r.deg7 === 'amazing' ? h('p.rp-note', 'Amazing: the floor number is added to your damage.') : null,
      r.deg7 === 'crit' ? h('p.rp-note', rules().crit === 'dice' ? 'Critical: roll your damage dice twice.' : 'Critical: the app applies the extra damage.') : null,
      roll.vs?.sizeDamage ? h('p.rp-note', `+${roll.vs.sizeDamage} damage from your size.`) : null,
      roll.vs?.ignoredDr ? h('p.rp-note', 'Armor-piercing: ignores DR.') : null,
      // Players never undo their own rolls (the GM can); after a hit the only way on is damage.
      h('div.rp-next', isAttack() && r.hit
        ? h('button.btn.btn-primary.rp-damage-next', { type: 'button', onclick: damageNext }, icon('dice', { size: 18 }), 'Roll damage')
        : [favorBtn(r), h('button.btn.btn-quiet', { type: 'button', onclick: close }, 'Done')])));
  }

  /** AI Favor: reroll the d20 once (never a natural 1), costs 1 Favor (rules with an aiFavor field). */
  function favorBtn(r) {
    const m = me();
    const fdef = (V()?.pack?.ruleset?.fields || []).find((f) => f.id === 'aiFavor');
    if (!fdef || isDamage() || !r.rollId || r.hit || r.favored) return null;
    const nat = r.roll?.natural ?? r.natural;
    const left = Number(m?.sheet?.fields?.aiFavor ?? fdef.default ?? 0);
    if (nat === 1 || !(left > 0)) return null;
    const go = async (entered) => {
      const a = { t: 'roll.favor', rollId: r.rollId, ...(entered ? { entered } : {}) };
      try {
        const res = await send(a);
        const vs = res?.result?.vs || {};
        st.favorOpen = false;
        st.result = { ...st.result, total: res?.result?.total, hit: vs.hit, crit: vs.crit, degree: vs.degree, deg7: vs.deg7, natural: res?.result?.natural, favored: true, roll: res?.result?.roll ?? null };
        buzz(vs.hit ? [20, 40, 20] : 15);
        draw();
      } catch (err) { toast(err.message, { error: true }); }
    };
    if (st.favorOpen) {
      return h('div.rp-favor',
        h('p', h('b', `AI Favor (${left} left)`), ' Roll your d20 again and tap what it shows, or let the phone roll.'),
        dieFaces(20, go),
        h('div.row-start', h('button.btn.btn-primary', { type: 'button', onclick: () => go(null) }, icon('dice', { size: 16 }), 'Phone rolls'), h('button.btn.btn-quiet', { type: 'button', onclick: () => { st.favorOpen = false; draw(); } }, 'Cancel')));
    }
    return h('button.btn', { type: 'button', title: 'Spend 1 AI Favor: roll the d20 again', onclick: () => { st.favorOpen = true; draw(); } }, icon('sparkle', { size: 16 }), `AI Favor reroll (${left})`);
  }

  function currentViewKey() {
    if (st.step === 'pick') {
      const sh = me()?.sheet;
      return JSON.stringify([rs().id, sh?.attacks, sh?.spells, sh?.skills, sh?.computed, V().library?.skill]);
    }
    return JSON.stringify([mode(), sides(), rules().advantage, bonusOf(st.what), damageText(st.what),
      mobs().map((m) => [m.uid, m.name, m.size]), sizeHint()?.adv, evadeAdvantage()]);
  }

  function draw() {
    const scrollTop = st.step === renderedStep ? el.querySelector('.rp-scroll')?.scrollTop ?? 0 : 0;
    panel.replaceChildren(st.step === 'pick' ? pickList() : st.step === 'result' ? resultStep() : rollStep());
    if (scrollTop) el.querySelector('.rp-scroll').scrollTop = scrollTop;
    renderedStep = st.step;
    viewKey = currentViewKey();
  }

  function update() {
    if (el.hidden) return;
    if (st.step === 'result') {
      if (st.result.roll) return;
      const roll = V().rolls?.find((r) => r.id === st.result.rollId);
      if (roll) { st.result.roll = roll; draw(); }
      return;
    }
    if (st.step === 'roll' && st.target && !mobs().some((m) => m.uid === st.target)) {
      st.target = mobs().length ? undefined : null;
    }
    if (viewKey !== currentViewKey()) draw();
  }

  document.addEventListener('keydown', (e) => { if (!el.hidden && e.key === 'Escape') close(); });

  return { el, open, openPicker, close, get mode() { return mode(); }, update, defLabel };
}
