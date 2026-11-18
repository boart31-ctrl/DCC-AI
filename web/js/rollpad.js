// Roll pad (player phone): dice entry against a target.
//   Pick what you do (attack, skill, save, ability...) -> in a fight pick the monster -> type the number on your real
//   die (or let the phone roll) -> the app adds your modifiers and says HIT / MISS. After a hit: damage the same way,
//   it lands on the monster. Undo takes back a misclick. The GM sees the defence and the margin, players never do.
// Dice modes (per crawler, `dice.mode`): off = the phone only explains numbers; enter = keypad first; digital = Roll first.
import { h, toast, buzz } from './client.js';
import { icon, signed } from './ui.js';

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
  const isAttack = () => st.what?.kind === 'attack' && st.what.part !== 'damage';
  const isDamage = () => st.what?.kind === 'attack' && st.what.part === 'damage';
  const defLabel = () => rules().defenseLabel || combat().defenseLabel || 'Defence';

  function bonusOf(what) {
    const c = me()?.sheet?.computed;
    if (!c || !what) return null;
    if (what.kind === 'stat') return c.stats?.[what.id]?.mod?.value ?? null;
    if (what.kind === 'derived') return c.derived?.[what.id]?.value ?? null;
    if (what.kind === 'untrained') { const d = (V().library?.skill || []).find((x) => x.id === what.skillId); return d ? c.stats?.[d.stat]?.mod?.value ?? null : null; }
    if (what.kind === 'skill') return c.skills?.find((x) => x.uid === what.uid)?.total?.value ?? null;
    if (what.kind === 'attack' && what.part !== 'damage') return c.attacks?.find((x) => x.uid === what.uid)?.toHit?.value ?? null;
    return null;
  }
  const damageText = (what) => me()?.sheet?.computed?.attacks?.find((x) => x.uid === what.uid)?.damage || '';

  function close() {
    el.hidden = true;
    document.body.classList.remove('rp-open');
    st.step = 'pick';
    st.result = null;
    st.favorOpen = false;
  }

  /** Opens the pad for one roll (from a tap on the sheet). */
  function open(what, label) {
    if (!me()) return;
    st.what = what;
    st.label = label || 'Roll';
    st.digits = '';
    st.bonus = 0;
    st.adv = null;
    st.result = null;
    st.favorOpen = false;
    st.after = null;
    st.step = 'roll';
    st.cancel = false;
    st.advTouched = false;
    if (what.kind === 'untrained' && rs().skills?.untrained?.adv) st.adv = rs().skills.untrained.adv;
    // Keep aiming at the monster you just attacked (5 minutes), else the only one standing.
    const alive = mobs();
    const keep = st.lastTarget && Date.now() - st.lastTargetAt < KEEP_TARGET_MS && alive.some((m) => m.uid === st.lastTarget);
    // undefined = not chosen yet (attacks in a fight must pick a monster or say "no target"), null = no target
    st.target = isAttack() || isDamage() ? (keep ? st.lastTarget : alive.length === 1 ? alive[0].uid : alive.length ? undefined : null) : null;
    draw();
    el.hidden = false;
    document.body.classList.add('rp-open');
    buzz(6);
  }

  /** Action list (Roll button): attacks, skills, saves and other rollable numbers, abilities. */
  function openPicker() {
    if (!me()) return;
    st.step = 'pick';
    st.result = null;
    st.favorOpen = false;
    draw();
    el.hidden = false;
    document.body.classList.add('rp-open');
  }

  async function submit({ digital = false } = {}) {
    if (st.busy) return;
    const n = Number(st.digits);
    if (!digital && (!Number.isInteger(n) || n < 1 || n > (isDamage() ? 999 : sides()))) {
      toast(isDamage() ? 'Type what your damage dice show' : `Type 1 to ${sides()}`, { error: true });
      return;
    }
    const a = { t: 'roll', what: st.what };
    if (!digital) a.entered = n;
    if (st.target) a.target = st.target;
    if (st.target === undefined) { toast('Pick who you attack, or No target', { error: true }); return; }
    if (st.adv && digital) a.adv = st.adv;
    if (st.what?.kind === 'untrained' && st.cancel) a.adv = 'adv';
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

  async function undo() {
    try {
      await send({ t: 'roll.undo' });
      toast('Taken back');
      close();
    } catch (err) { toast(err.message, { error: true }); }
  }

  function damageNext() {
    const rollId = st.result?.rollId;
    st.what = { kind: 'attack', uid: st.what.uid, part: 'damage' };
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
    const btn = (what, label, val) => h('button.rp-act', { type: 'button', onclick: () => open(what, label) }, h('span', label), val == null ? null : h('b', signed(val)));
    const attacks = (sh.attacks || []).map((a) => btn({ kind: 'attack', uid: a.uid }, `${a.name} to hit`, c.attacks?.find((x) => x.uid === a.uid)?.toHit?.value));
    const derived = (R.derived || []).filter((d) => d.roll).map((d) => btn({ kind: 'derived', id: d.id }, d.label, c.derived?.[d.id]?.value));
    const skills = (sh.skills || []).slice().sort((a, b) => a.name.localeCompare(b.name)).map((s) => btn({ kind: 'skill', uid: s.uid }, s.name, c.skills?.find((x) => x.uid === s.uid)?.total?.value));
    const stats = (R.stats || []).map((s) => btn({ kind: 'stat', id: s.id }, `${s.abbr} check`, c.stats?.[s.id]?.mod?.value));
    const group = (t, list, note) => (list.length ? h('section.rp-group', h('h3', t), note ? h('p.hint', note) : null, h('div.rp-acts', list)) : null);
    // Untrained (DCC): any library skill not on the sheet, with Disadvantage and only the Stat Mod.
    const U = R.skills?.untrained;
    const have = new Set((sh.skills || []).map((x) => x.skillId));
    const hide = new Set([...(R.skills?.hideTags || []), ...(U?.hideTags || [])]);
    const untrained = U ? (V().library?.skill || []).filter((d) => !have.has(d.id) && !(U.noCheckTypes || []).includes(d.checkType) && !(d.tags || []).some((t) => hide.has(t)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => btn({ kind: 'untrained', skillId: d.id }, d.name, c.stats?.[d.stat]?.mod?.value)) : [];
    return h('div.rp-body', head('What do you roll?', null), h('div.rp-scroll',
      group('Attacks', attacks), group('Saves & more', derived), group('Skills', skills), group('Abilities', stats),
      group('Try untrained', untrained, `Roll ${U?.adv === 'dis' ? 'with Disadvantage (2 dice, keep the lower)' : ''}, Stat Mod only.${U?.learn ? ' On the Tutorial Floors you may learn one of these at the end of the session.' : ''}`),
      !attacks.length && !skills.length ? h('p.hint', 'Your sheet has nothing to roll yet. Ask the GM to set it up.') : null));
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
    return h('div.rp-targets', h('span.rp-l', isDamage() ? 'Damage to' : 'Attack'),
      h('div.rp-chips', list.map((m) => h('button.chip', { type: 'button', 'aria-pressed': String(st.target === m.uid), onclick: () => { if (st.target === m.uid) return; st.target = m.uid; if (!st.advTouched) st.adv = sizeHint()?.adv ?? null; draw(); } }, m.name)),
        h('button.chip', { type: 'button', 'aria-pressed': String(st.target === null), onclick: () => { st.target = null; draw(); } }, 'No target')),
      st.target === undefined ? h('span.rp-need', 'Pick a target or No target to roll.') : null);
  }

  function modsRow() {
    const b = bonusOf(st.what);
    const unt = st.what?.kind === 'untrained' ? rs().skills?.untrained : null;
    const advOn = !!rules().advantage && !isDamage() && !unt;
    const sz = sizeHint();
    return h('div.rp-mods',
      b == null ? null : h('span.rp-mod', `Your modifier ${signed(b)}`),
      advOn ? h('div.rp-adv', ['adv', 'dis'].map((k) => h('button.chip', { type: 'button', 'aria-pressed': String(st.adv === k), onclick: () => { st.adv = st.adv === k ? null : k; st.advTouched = true; draw(); } }, k === 'adv' ? 'Advantage' : 'Disadvantage'))) : null,
      // Untrained: Disadvantage, cancelled by any reason for Advantage (cover, high ground, size…).
      unt?.adv ? h('div.rp-adv', h('button.chip', { type: 'button', 'aria-pressed': String(st.cancel === true), onclick: () => { st.cancel = !st.cancel; st.adv = st.cancel ? null : unt.adv; draw(); } }, 'I have Advantage (cancels it)')) : null,
      advOn && sz ? h('span.rp-hint', sz.text) : null,
      isDamage() ? null : h('div.rp-bonus', h('span.rp-l', 'Extra'),
        h('button.btn.btn-sm', { type: 'button', 'aria-label': 'Minus one', onclick: () => { st.bonus -= 1; draw(); } }, '−'),
        h('b', signed(st.bonus)),
        h('button.btn.btn-sm', { type: 'button', 'aria-label': 'Plus one', onclick: () => { st.bonus += 1; draw(); } }, '+')));
  }

  function keypad() {
    const max = isDamage() ? 999 : sides();
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
    const sub = dmg ? `Roll the dice of ${damageText(st.what) || 'your damage'}${critNote}, type what they show (the app adds the rest)` : enterFirst ? `Roll your d${sides()}${st.adv ? ' twice, keep the ' + (st.adv === 'adv' ? 'higher' : 'lower') : ''}, type what it shows` : 'Tap Roll, or type a real die';
    const digitalBtn = h('button.btn.btn-primary.rp-digital', { type: 'button', disabled: st.busy || st.target === undefined, onclick: () => submit({ digital: true }) }, icon('dice', { size: 18 }), dmg ? 'Roll damage for me' : 'Roll for me');
    return h(enterFirst ? 'div.rp-body.rp-entry' : 'div.rp-body', head(st.label, sub), h('div.rp-scroll',
      targetRow(), modsRow(),
      enterFirst ? keypad() : [digitalBtn, h('details.rp-alt', h('summary', 'I rolled a real die'), keypad())]),
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
    const dmgLabel = isDamage() ? (r.applied ? (r.applied.after <= 0 ? 'DOWN!' : `−${-r.applied.delta} HP`) : 'Tell the GM') : null;
    const typedNote = isDamage() && r.typed ? { immune: 'Immune to that: no damage.', resistant: 'Resistant: half damage.', vulnerable: 'Vulnerable: double damage!' }[r.typed] : null;
    const DEG7 = { crit: 'CRITICAL HIT', amazing: 'AMAZING', success: st.what.kind === 'attack' ? 'HIT' : 'SUCCESS', near: 'NEAR MISS', fail: st.what.kind === 'attack' ? 'MISS' : 'FAIL', major: 'MAJOR FAIL', critfail: 'CRITICAL FAIL' };
    const label = dmgLabel ?? (r.deg7 ? DEG7[r.deg7] : !hasVs ? null : r.degree === 3 ? (rules().degrees ? 'CRITICAL SUCCESS' : 'CRITICAL HIT') : r.hit ? (st.what.kind === 'attack' ? 'HIT' : 'SUCCESS') : r.degree === 0 && rules().degrees ? 'CRITICAL FAILURE' : st.what.kind === 'attack' ? 'MISS' : 'FAIL');
    return h('div.rp-body', head(st.label, null), h('div.rp-scroll',
      h('div.rp-result', { class: `rp-result${hasVs ? (r.hit ? ' is-hit' : ' is-miss') : r.applied ? ' is-hit' : ''}${r.crit ? ' is-crit' : ''}` },
        h('span.rp-total', String(total ?? '?')),
        equation ? h('span.rp-math', equation) : null,
        advantage ? h('span.rp-math', advantage) : null,
        roll.vs?.name ? h('span.rp-math', roll.vs.name) : null,
        label ? h('span.rp-verdict', label) : h('span.rp-verdict.dim', 'Tell the GM')),
      typedNote ? h('p.rp-note', typedNote) : null,
      r.deg7 === 'near' ? h('p.rp-note', 'So close. A friend can Intervene: their phone offers +1d6 now.') : null,
      r.deg7 === 'amazing' ? h('p.rp-note', 'Amazing: the floor number is added to your damage.') : null,
      r.deg7 === 'crit' ? h('p.rp-note', 'Critical: roll your damage dice twice.') : null,
      h('div.rp-next',
        isAttack() && r.hit ? h('button.btn.btn-primary', { type: 'button', onclick: damageNext }, 'Roll damage') : null,
        favorBtn(r),
        h('button.btn', { type: 'button', onclick: undo }, icon('undo', { size: 16 }), 'Undo'),
        h('button.btn.btn-quiet', { type: 'button', onclick: close }, 'Done'))));
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
        h('div.rp-favor-keys', Array.from({ length: 20 }, (_, i) => h('button.btn', { type: 'button', onclick: () => go(i + 1) }, String(i + 1)))),
        h('div.row-start', h('button.btn.btn-primary', { type: 'button', onclick: () => go(null) }, icon('dice', { size: 16 }), 'Phone rolls'), h('button.btn.btn-quiet', { type: 'button', onclick: () => { st.favorOpen = false; draw(); } }, 'Cancel')));
    }
    return h('button.btn', { type: 'button', title: 'Spend 1 AI Favor: roll the d20 again', onclick: () => { st.favorOpen = true; draw(); } }, icon('sparkle', { size: 16 }), `AI Favor reroll (${left})`);
  }

  function currentViewKey() {
    if (st.step === 'pick') {
      const sh = me()?.sheet;
      return JSON.stringify([rs().id, sh?.attacks, sh?.skills, sh?.computed, V().library?.skill]);
    }
    return JSON.stringify([mode(), sides(), rules().advantage, bonusOf(st.what), damageText(st.what),
      mobs().map((m) => [m.uid, m.name, m.size]), sizeHint()?.adv]);
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
      if (!st.advTouched) st.adv = null;
    }
    if (viewKey !== currentViewKey()) draw();
  }

  document.addEventListener('keydown', (e) => { if (!el.hidden && e.key === 'Escape') close(); });

  return { el, open, openPicker, close, get mode() { return mode(); }, update, defLabel };
}
