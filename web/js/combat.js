// GM desk → Combat: the synced tracker (server/combat.js + combat-auto.js). Everything here is engine
// state, so the TV, phones and a reloaded desk all see the same fight.
//
// Phone first (360–430 px): one compact card per combatant (name, HP slots, quick −/+), secondary
// stats and tools in a line that opens. Desktop: the same cards spread into one row each.
// Auto mode: "Mobs act" resolves the mob phase (targets, d20 vs Evade, damage − DR on the sheets),
// "Step" does one mob, "Undo" puts it back; the TV plays it as a cinematic and this desk plays the
// sounds in step. Endings: "End ▾" picks the outcome (TV finale); victory / defeat are offered by
// themselves (3 s toast with Cancel) when every revealed mob / every crawler is down.
import { h, toast, portraitSrc, onPortraits, itemArt } from './client.js';
import { sheetModel, libraryOf } from './rules.js';
import { icon, explain, whyContent, avatar, field, select, unverifiedBadge, signed } from './ui.js';
import { entryArt } from './portrait.js';
import { openArtGallery } from './art-gallery.js';

const PREF = 'system.combat.ui'; // UI preferences only (builder tab, roll visibility); no game state
const loadPref = () => { try { return JSON.parse(localStorage.getItem(PREF) || '{}') || {}; } catch { return {}; } };
const savePref = (p) => { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch {} };

export const OUTCOMES = [
  { id: 'victory', label: 'Victory', hint: 'Gold, confetti, the crowd goes wild' },
  { id: 'defeat', label: 'Party wiped', hint: 'Red static: SIGNAL LOST' },
  { id: 'runaway', label: 'They ran', hint: 'The crawlers have left the chat' },
  { id: 'truce', label: 'Truce', hint: 'They made peace. Aww' },
  { id: 'sponsor', label: 'Sponsor steps in', hint: 'A sponsor ends the fight' },
  { id: 'timeout', label: 'Time ran out', hint: 'Floor collapsing, 00:00' },
  { id: 'stalemate', label: 'Stalemate', hint: 'Nobody wins. To be continued?' },
  { id: 'special', label: 'Special…', hint: 'Your own title and text' },
];
const MODES = [['auto', 'Auto'], ['focus', 'Focus'], ['spread', 'Spread']];
const END_DELAY_S = 3;

export function createCombat({ act, send, getView, sfx = null, openSound = null, goLive = null }) {
  let view = null;
  let sig = '';
  const pref = { tab: 'monsters', publicRolls: false, q: '', locationId: '', ...loadPref() };
  const ui = {
    counts: {}, open: new Set(), editPhases: false, lastRoll: null, adhoc: { name: '', hp: 5, evade: 0, dr: 0, count: 1 },
    endMenu: false, special: null, rules: false, soundPop: false, loot: null, log: true,
    offered: null, // outcome the auto-end toast already offered (until the suggestion clears)
  };
  const setPref = (k, v) => { pref[k] = v; savePref(pref); };
  const el = h('div.combat.cbt');
  const toastEl = h('div.cbt-endtoast', { role: 'status', 'aria-live': 'assertive', hidden: true });
  document.body.append(toastEl);

  const C = () => view?.combat || { active: false, round: 1, phaseIndex: 0, phases: ['Crawlers', 'Mobs'], combatants: [] };
  const lib = () => libraryOf(view);
  const libEntry = (m) => (m.sourceKind ? (lib()[m.sourceKind] || []).find((e) => e.id === m.sourceId) : null);
  const onTv = () => ['combat', 'finale'].includes(view?.scene?.kind) || (view?.scene?.kind === 'boss' && C().combatants.some((x) => x.type === 'mob' && x.sourceKind === 'boss' && x.sourceId === view?.scene?.data?.bossId));
  /** Art button: the picture opens the gallery. */
  const artBtn = (art, label, onclick) => h('button.cbt-artbtn', { type: 'button', title: label, 'aria-label': label, onclick }, art, h('span.cbt-artbtn-k', { 'aria-hidden': 'true' }, icon('edit', { size: 11 })));
  /** Library monster / boss: a pack entry gets a GM art pick (lib.art), a homebrew one is saved with the picture. */
  function pickLibArt(kind, e) {
    const isPack = (e.source || 'pack') === 'pack';
    openArtGallery(view, {
      title: `Art for ${e.name}`,
      sub: isPack ? 'Replaces its picture on the GM desk, the TV and every new combatant until you reset it.' : 'Saved with this homebrew entry.',
      current: e.image,
      allowClear: isPack ? !!e.artPick : true,
      clearLabel: isPack ? 'Back to the pack art' : 'No art (silhouette)',
      onPick: (u) => {
        if (isPack) return act({ t: 'lib.art', kind, id: e.id, image: u }, u ? `${e.name}: art set.` : `${e.name}: pack art restored.`);
        const entry = structuredClone(e);
        delete entry.artPick; delete entry.packImage;
        entry.image = u;
        return act({ t: 'lib.upsert', kind, entry }, `${e.name}: art saved.`);
      },
    });
  }
  /** A combatant already in the fight: this one only (combat.update). */
  function pickMobArt(m) {
    openArtGallery(view, {
      title: `Art for ${m.name}`,
      sub: 'This combatant only, for this fight. To change the monster for good, use its art button under Add to the fight.',
      current: m.image,
      onPick: (u) => act({ t: 'combat.update', uid: m.uid, image: u }, `${m.name}: art changed.`),
    });
  }
  const redraw = () => { sig = ''; draw(); };
  const serverNow = () => Date.now() + (Number.isFinite(view?.scene?.now) ? view.scene.now - (view._at || Date.now()) : 0);

  /** The TV cinematic of the last auto run is still playing (ms left, 0 when done). */
  function playingLeft() {
    const la = C().lastAuto;
    if (!la?.startAt || la.undone) return 0;
    const n = (la.steps || []).filter((x) => !x.skipped).length;
    const slots = Math.max(0, ...(la.steps || []).map((x) => (Number.isInteger(x.slot) ? x.slot + 1 : 0)), n ? 1 : 0);
    const end = la.startAt + slots * (la.stepMs || 2800) + 300;
    return Math.max(0, end - serverNow());
  }

  /* ---------- header ---------- */

  function header() {
    const c = C();
    const ph = c.phases || [];
    const last = c.phaseIndex >= ph.length - 1;
    const mobs = c.combatants.filter((x) => x.type === 'mob');
    const hidden = mobs.filter((m) => m.hidden && !m.down).length;
    const canAct = c.active && mobs.some((m) => !m.down && m.attacks?.length);
    const q = c.autoQueue;
    const left = playingLeft();
    return h('header.cbt-head',
      h('div.cbt-title',
        h('h1', 'Combat'),
        c.active ? h('span.cbt-round', h('small', 'Round'), h('b', String(c.round))) : h('span.pill', 'Not started'),
        h('span.grow'),
        soundButton(),
        h('button.icon-btn.cbt-tvbtn', {
          type: 'button', class: onTv() ? 'icon-btn cbt-tvbtn is-live' : 'icon-btn cbt-tvbtn', 'aria-pressed': String(onTv()),
          title: onTv() ? 'The fight is on the TV' : 'Go live: arena, or the boss screen when a boss is in the fight', 'aria-label': onTv() ? 'The fight is on the TV' : 'Put the fight on the TV',
          onclick: () => (goLive ? goLive() : act({ t: 'scene.set', kind: 'combat', data: {} }, 'On TV: the arena.')),
        }, icon('tv', { size: 18 }))),
      h('div.cbt-turn',
        h('ol.cbt-phases', { 'aria-label': 'Phases' }, ph.map((p, i) => h('li', h('button', {
          type: 'button', 'aria-current': c.active && i === c.phaseIndex ? 'step' : null, disabled: !c.active,
          title: c.active ? `Jump to ${p}` : null,
          onclick: () => act({ t: 'combat.set', phaseIndex: i }),
        }, p)))),
        c.active
          ? h('button.btn.btn-primary.cbt-next', { type: 'button', onclick: () => act({ t: 'combat.next' }), title: 'Next phase (N)' },
            last ? `Round ${c.round + 1}` : `Next: ${ph[c.phaseIndex + 1]}`, icon('chevron', { size: 15 }), h('kbd', 'N'))
          : h('button.btn.btn-primary.cbt-next', { type: 'button', onclick: start }, icon('swords', { size: 15 }), 'Start combat'),
        c.phasesVerified ? null : h('span.verify', unverifiedBadge('Phase names and order are not checked against the rulebook')),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', 'aria-pressed': String(ui.editPhases), onclick: () => { ui.editPhases = !ui.editPhases; redraw(); } }, 'Phases')),
      c.active ? h('div.cbt-auto-bar',
        h('button.btn.cbt-act', { type: 'button', disabled: !canAct, onclick: () => runAuto(), title: q ? 'Resolve the remaining mobs' : 'Every living revealed mob attacks: targets, d20 vs Evade, damage − DR onto the sheets' },
          icon('bolt', { size: 16 }), q ? `Mobs act (${q.uids.length - q.done} left)` : 'Mobs act'),
        h('button.btn.cbt-step', { type: 'button', disabled: !canAct, onclick: () => runStep(), title: 'One mob at a time' }, icon('play', { size: 14 }), 'Step'),
        left > 0 ? h('button.btn.cbt-skip', { type: 'button', onclick: () => act({ t: 'combat.autoSkip' }), title: 'Jump the TV to the end of the cinematic' }, icon('skip', { size: 14 }), 'Skip') : null,
        c.lastAuto?.canUndo ? h('button.btn.btn-quiet.cbt-undo', { type: 'button', onclick: undo, title: 'Put back the HP and conditions the last auto run changed' }, icon('undo', { size: 14 }), 'Undo') : null,
        h('span.grow'),
        hidden ? h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => act({ t: 'combat.reveal', all: true }, `${hidden} revealed.`), title: 'Show every hidden mob on the TV and phones' }, icon('eye', { size: 14 }), `Reveal all (${hidden})`) : null,
        endButton()) : (c.combatants.length ? h('div.cbt-auto-bar', h('span.grow'), endButton()) : null),
      ui.endMenu ? endMenu() : null,
    );
  }

  function soundButton() {
    const on = sfx ? sfx.on : false;
    const btn = h('button.icon-btn.cbt-sound', {
      type: 'button', 'aria-expanded': String(ui.soundPop), 'aria-label': `Combat sounds ${on ? 'on' : 'off'}`, title: 'Combat sounds',
      class: on ? 'icon-btn cbt-sound on' : 'icon-btn cbt-sound',
      onclick: () => { ui.soundPop = !ui.soundPop; redraw(); },
    }, icon(on ? 'speaker' : 'mute', { size: 18 }));
    if (!ui.soundPop) return btn;
    return h('span.cbt-pop-anchor', btn, h('div.cbt-pop', { role: 'dialog', 'aria-label': 'Combat sounds' },
      h('label.chk', h('input', { type: 'checkbox', checked: on, disabled: !sfx, onchange: (e) => { if (sfx) sfx.on = e.target.checked; redraw(); } }), h('span', 'Play combat sounds here automatically')),
      h('p.hint', 'Swing, hit, miss, KO, mob killed, round start and endings, in step with the TV.'),
      openSound ? h('button.btn.btn-sm', { type: 'button', onclick: () => { ui.soundPop = false; openSound(); } }, icon('speaker', { size: 14 }), 'Sound panel') : null));
  }

  function endButton() {
    return h('button.btn.btn-sm.cbt-endbtn', { type: 'button', 'aria-expanded': String(ui.endMenu), onclick: () => { ui.endMenu = !ui.endMenu; ui.special = null; redraw(); } },
      icon('flag', { size: 14 }), 'End', icon('down', { size: 13 }));
  }

  function endMenu() {
    if (ui.special) {
      const t = h('input.inp', { value: ui.special.title, maxlength: 60, placeholder: 'Title, e.g. Dance-off', 'aria-label': 'Ending title', oninput: (e) => { ui.special.title = e.target.value; } });
      const x = h('textarea.inp', { rows: 3, maxlength: 400, placeholder: 'What happened (the TV types it out)', 'aria-label': 'Ending text', oninput: (e) => { ui.special.text = e.target.value; } });
      x.value = ui.special.text;
      setTimeout(() => t.focus(), 0);
      return h('div.panel.cbt-endmenu',
        h('h2', 'Special ending'), t, x,
        h('div.row-end', h('button.btn.btn-sm', { type: 'button', onclick: () => { ui.special = null; redraw(); } }, 'Back'),
          h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => endWith('special', ui.special) }, 'End with this')));
    }
    return h('div.panel.cbt-endmenu', { role: 'menu' },
      h('div.cbt-endgrid', OUTCOMES.map((o) => h('button.cbt-endopt', {
        type: 'button', role: 'menuitem', 'data-outcome': o.id,
        onclick: () => (o.id === 'special' ? (ui.special = { title: '', text: '' }, redraw()) : endWith(o.id)),
      }, h('b', o.label), h('span', o.hint)))),
      h('div.row-end', h('button.btn.btn-sm.btn-quiet.danger', { type: 'button', onclick: end }, 'Clear without a finale')));
  }

  async function endWith(outcome, extra = {}) {
    hideToast();
    const a = { t: 'combat.end', outcome };
    if (extra.title?.trim()) a.title = extra.title.trim();
    if (extra.text?.trim()) a.text = extra.text.trim();
    const label = OUTCOMES.find((o) => o.id === outcome)?.label || outcome;
    if (await act(a, `${label}. The finale is on the TV.`)) { ui.endMenu = false; ui.special = null; redraw(); }
  }

  function phaseEditor() {
    const c = C();
    const inp = h('input.inp', { value: (c.phases || []).join(', '), 'aria-label': 'Phases in order, comma separated' });
    const ok = h('input', { type: 'checkbox', checked: !!c.phasesVerified });
    const save = async () => {
      const phases = inp.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 8);
      if (!phases.length) { inp.focus(); return; }
      if (await act({ t: 'combat.set', phases, phasesVerified: ok.checked }, 'Phases saved.')) { ui.editPhases = false; redraw(); }
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    return h('div.panel.cbt-phase-edit',
      h('label.lbl', h('span.lbl-t', 'Phases in order, comma separated'), inp,
        h('span.lbl-hint', 'No initiative: each round runs these phases in order. The default is a guess until the rulebook says otherwise.')),
      h('label.chk', ok, h('span', 'Checked against the rulebook')),
      h('div.row-end', h('button.btn.btn-sm', { type: 'button', onclick: () => { ui.editPhases = false; redraw(); } }, 'Cancel'), h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: save }, 'Save phases')));
  }

  async function start() {
    if (await act({ t: 'combat.start' }, 'Combat! Round 1.')) {
      if (!onTv()) toast('Tip: the TV button puts the arena on screen.', { ms: 3000 });
    }
  }
  async function end() {
    const n = C().combatants.filter((x) => x.type === 'mob').length;
    if (n && !confirm(`End combat and clear ${n} mob${n === 1 ? '' : 's'} without a finale?`)) return;
    ui.endMenu = false;
    act({ t: 'combat.end' }, 'Combat over.');
  }

  /* ---------- auto mode ---------- */

  function sumUp(seq) {
    const hits = seq.filter((x) => x.hit).length;
    const downs = seq.filter((x) => x.down).map((x) => x.target);
    return `${hits} hit${hits === 1 ? '' : 's'}, ${seq.length - hits} miss${seq.length - hits === 1 ? '' : 'es'}${downs.length ? `. Down: ${downs.join(', ')}` : ''}`;
  }
  async function runAuto() {
    try {
      const r = await send({ t: 'combat.auto' });
      toast(`Mobs act: ${sumUp(r.result.sequence.filter((x) => !x.skipped))}`, { ms: 4000 });
    } catch (err) { toast(err.message, { error: true }); }
  }
  async function runStep() {
    try {
      const r = await send({ t: 'combat.autoStep' });
      const st = r.result.sequence[0];
      toast(st.skipped ? `${st.mob}: ${st.skipped}` : `${st.mob} → ${st.target}: ${st.hit ? `hit, ${st.damage} damage` : 'miss'}${r.result.left ? ` · ${r.result.left} left` : ''}`, { ms: 3500 });
    } catch (err) { toast(err.message, { error: true }); }
  }
  async function undo() {
    try {
      const r = await send({ t: 'combat.autoUndo' });
      toast(`Undone: ${r.result.restored.join(', ') || 'nothing changed'}.`);
    } catch (err) { toast(err.message, { error: true }); }
  }

  function stepLine(st) {
    if (st.skipped) return h('li.cbt-log-row.skip', h('b', st.mob), h('span.dim', ` ${st.skipped}`));
    const res = st.hit
      ? h('span.cbt-log-res.hit', st.crit ? 'CRIT ' : 'HIT ', st.damage ? `−${st.damage}` : '', st.down ? h('b.cbt-log-down', ' DOWN') : null)
      : h('span.cbt-log-res.miss', st.nat1 ? 'NAT 1' : 'MISS');
    return h('li.cbt-log-row', { class: `cbt-log-row${st.hit ? ' is-hit' : ''}${st.down ? ' is-down' : ''}` },
      h('span.cbt-log-who', h('b', st.mob), h('span.dim', ' → '), h('b', st.target)),
      h('span.cbt-log-math', { title: `${st.attack}: d20 ${st.d20}${st.toHit ? ` ${signed(st.toHit)}` : ''} = ${st.total} vs Evade ${st.evade} (${st.rule})${st.hit && st.damageRoll != null ? `; damage ${st.damageRoll}${st.crit && st.damageRaw !== st.damageRoll ? ` ×2 = ${st.damageRaw}` : ''} − DR ${st.drValue}` : ''}` },
        `${st.d20}${st.toHit ? signed(st.toHit) : ''}=${st.total} vs ${st.evade}`),
      res,
      st.buffs?.length ? h('span.cbt-log-cond', st.buffs.join(', ')) : null);
  }

  function autoPanel() {
    const c = C();
    const la = c.lastAuto;
    const s = c.settings || {};
    const un = new Set(c.unverified || []);
    const rule = (k, label, ctl) => h('label.cbt-rule', h('span.cbt-rule-l', label, un.has(k) ? unverifiedBadge('Not checked against the rulebook yet') : null), ctl);
    const set = (patch, msg) => act({ t: 'combat.set', settings: patch }, msg);
    const chk = (k, label, hint) => h('label.chk.cbt-rule-chk', { title: hint || null }, h('input', { type: 'checkbox', checked: !!s[k], onchange: (e) => set({ [k]: e.target.checked }) }), h('span', label));
    const rules = ui.rules ? h('div.cbt-rules',
      rule('hitRule', 'Hit when d20 + to hit', select([{ value: '>=', label: '≥ Evade (tie hits)' }, { value: '>', label: '> Evade (tie misses)' }], s.hitRule, { cls: 'inp-sm', label: 'Hit rule', onChange: (v) => set({ hitRule: v }) })),
      rule('evadeBase', 'Evade base', field(s.evadeBase ?? 0, { type: 'number', cls: 'inp-sm cbt-num', attrs: { min: 0, max: 30, 'aria-label': 'Added to every Evade' }, onCommit: (v) => set({ evadeBase: Math.max(0, Math.min(30, Math.round(v) || 0)) }) })),
      rule('drMin', 'Damage after DR at least', field(s.drMin ?? 1, { type: 'number', cls: 'inp-sm cbt-num', attrs: { min: 0, max: 5, 'aria-label': 'Minimum damage' }, onCommit: (v) => set({ drMin: Math.max(0, Math.min(5, Math.round(v) || 0)) }) })),
      rule('crit', 'Natural 20', select([{ value: 'double', label: 'Double damage' }, { value: 'none', label: 'Just a hit' }], s.crit, { cls: 'inp-sm', label: 'Natural 20 rule', onChange: (v) => set({ crit: v }) })),
      rule('stepMs', 'TV pace per mob', select([2000, 2800, 3400, 4000].map((ms) => ({ value: String(ms), label: `${(ms / 1000).toFixed(1)} s${ms === 2800 ? ' (default)' : ''}` })), String(s.stepMs ?? 2800), { cls: 'inp-sm', label: 'TV pace', onChange: (v) => set({ stepMs: Number(v) }) })),
      h('div.cbt-rule-chks',
        chk('public', 'Rolls in the public dice log'),
        chk('includeHidden', 'Hidden mobs act too', 'The TV shows them as "something unseen"'),
        chk('finishDowned', 'Finish them: downed crawlers can be targeted'),
        chk('autoEnd', 'Offer victory / defeat by itself'))) : null;
    return h('section.panel.cbt-autopanel',
      h('div.sec-head', h('h2', 'Mob phase'),
        h('span.grow'),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', 'aria-expanded': String(ui.rules), onclick: () => { ui.rules = !ui.rules; redraw(); } }, icon('gear', { size: 14 }), 'Rules')),
      rules,
      la ? h('div.cbt-log',
        h('p.cbt-log-head', la.undone ? h('span.pill', 'Undone') : null, `Last run: ${la.steps.length} mob${la.steps.length === 1 ? '' : 's'}`),
        h('ol.cbt-log-list', la.steps.map(stepLine)))
        : h('p.hint', 'Mobs act: every living revealed mob picks a target (its mode and the crawlers\' aggro), rolls d20 + to hit against Evade and hits the sheet. Step does one mob at a time.'));
  }

  /* ---------- shared bits ---------- */

  function hpSlots(cur, max, onSet, label) {
    if (max > 30) {
      return h('div.cbt-bar', { title: `${label}: ${cur} / ${max}` }, h('div.cbt-bar-fill', { style: { width: `${max ? (cur / max) * 100 : 0}%` } }));
    }
    const low = max > 0 && cur / max <= 0.3;
    return h('div.slots.cbt-slots', { style: { '--n': String(Math.max(1, max)) } },
      Array.from({ length: max }, (_, i) => h('button.slot', {
        type: 'button', class: i < cur ? `slot on${low ? ' low' : ''}` : 'slot',
        'aria-label': `Set ${label} to ${i + 1}`, title: `${i + 1}`,
        onclick: () => onSet(i + 1 === cur ? i : i + 1),
      })));
  }

  /** Quick −1 / +1 always; −2 −3 and a typed amount on wide screens or in the open line. */
  function quick(x, wide) {
    const dmg = (n) => act({ t: 'combat.damage', uid: x.uid, amount: n });
    const custom = h('input.inp.inp-sm.cbt-amt', { type: 'number', min: 1, max: 999, placeholder: '#', 'aria-label': `Damage amount for ${x.name} (Shift+Enter heals)`, inputmode: 'numeric' });
    custom.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const n = Math.round(Number(custom.value));
      if (n >= 1) { (e.shiftKey ? act({ t: 'combat.heal', uid: x.uid, amount: n }) : dmg(Math.min(999, n))); custom.value = ''; custom.blur(); }
    });
    return h('div.cbt-dmg', { class: wide ? 'cbt-dmg wide' : 'cbt-dmg' },
      h('button.btn.btn-sm.cbt-hit', { type: 'button', disabled: x.hp <= 0, onclick: () => dmg(1), 'aria-label': `1 damage to ${x.name}` }, '−1'),
      [2, 3].map((n) => h('button.btn.btn-sm.cbt-hit.cbt-more-dmg', { type: 'button', disabled: x.hp <= 0, onclick: () => dmg(n), 'aria-label': `${n} damage to ${x.name}` }, `−${n}`)),
      h('button.btn.btn-sm.cbt-heal', { type: 'button', disabled: x.hp >= x.hpMax, onclick: () => act({ t: 'combat.heal', uid: x.uid, amount: 1 }), 'aria-label': `Heal ${x.name} 1` }, '+1'),
      custom);
  }

  function conditions(x) {
    const buffs = lib().buff || [];
    const have = new Set(x.conditions.map((k) => k.id || k.name.toLowerCase()));
    const chips = x.conditions.map((k) => {
      const def = k.id ? buffs.find((b) => b.id === k.id) : null;
      const neg = (def?.tags || []).includes('debuff');
      return h('span.cond', { class: neg ? 'cond neg' : 'cond', title: def?.desc || k.name },
        k.name,
        h('button.cond-x', { type: 'button', 'aria-label': `Remove ${k.name} from ${x.name}`, onclick: () => act({ t: 'combat.condition', uid: x.uid, ...(k.id ? { buffId: k.id } : { name: k.name }), on: false }) }, icon('x', { size: 11 })));
    });
    const opts = buffs.filter((b) => !have.has(b.id)).sort((a, b) => a.name.localeCompare(b.name));
    const add = select([{ value: '', label: '+ Condition' }, ...opts.map((b) => ({ value: b.id, label: b.name })), { value: '__custom', label: 'Other…' }], '', {
      cls: 'inp-sm cbt-addcond', label: `Add a condition to ${x.name}`,
      onChange: (v) => {
        if (!v) return;
        if (v === '__custom') {
          const name = prompt('Condition name')?.trim();
          if (name) act({ t: 'combat.condition', uid: x.uid, name: name.slice(0, 40), on: true });
          else redraw();
          return;
        }
        act({ t: 'combat.condition', uid: x.uid, buffId: v, on: true });
      },
    });
    return h('div.cbt-conds', chips, add);
  }

  /* ---------- cards ---------- */

  const chev = (open) => h('span.cbt-chev', { class: open ? 'cbt-chev open' : 'cbt-chev', 'aria-hidden': 'true' }, icon('down', { size: 14 }));
  function toggle(uid) { if (ui.open.has(uid)) ui.open.delete(uid); else ui.open.add(uid); redraw(); }

  function aggroDots(x) {
    return h('span.cbt-aggro', { title: `Aggro ${x.aggro}: how often mobs on Auto pick ${x.name}` },
      Array.from({ length: 5 }, (_, i) => h('i', { class: i < Math.ceil((x.aggro ?? 3) / 9 * 5) ? 'on' : '' })));
  }

  function crawlerCard(x) {
    const p = (view.gm?.playersFull || []).find((y) => y.id === x.playerId);
    const open = ui.open.has(x.uid);
    let ev = null; let dr = null; let evDef = null; let drDef = null;
    if (p) {
      const M = sheetModel(view, p);
      evDef = M.rs.derived.find((d) => /evade|defen/i.test(d.id + d.label)) || M.rs.derived.find((d) => d.roll) || M.rs.derived[0];
      drDef = M.rs.derived.find((d) => d !== evDef && /(^|[^a-z])dr($|[^a-z])|resist|armou?r/i.test(`${d.id} ${d.label}`));
      ev = evDef ? M.computed.derived?.[evDef.id] : null;
      dr = drDef ? M.computed.derived?.[drDef.id] : null;
    }
    const numEl = (b, def, short) => {
      const n = h('b.num', { tabindex: '0' }, `${short} ${b?.value ?? '—'}`);
      if (b) explain(n, () => whyContent(b, { title: def?.label }));
      return n;
    };
    const setHp = (v) => (v < x.hp ? act({ t: 'combat.damage', uid: x.uid, amount: x.hp - v }) : v > x.hp ? act({ t: 'combat.heal', uid: x.uid, amount: v - x.hp }) : null);
    const status = x.down ? h('span.cbt-dead', icon('skull', { size: 12 }), 'Down') : `${x.hp} / ${x.hpMax} HP`;
    return h('li.cc.cc-crawler', { class: `cc cc-crawler${x.down ? ' down' : ''}${x.noTarget ? ' notarget' : ''}`, 'data-uid': x.uid, style: { '--pc': x.color || 'var(--c-accent)' } },
      h('div.cc-who', avatar(x.name, { color: x.color, size: 36, src: p?.sheet?.portrait || null }),
        h('div.cc-nm', h('b', x.name), h('span.dim', status))),
      h('div.cc-hp', hpSlots(x.hp, x.hpMax, setHp, x.name)),
      quick(x, true),
      h('button.cc-sub', { type: 'button', 'aria-expanded': String(open), onclick: () => toggle(x.uid) },
        h('span.cc-stat', `Ev ${ev?.value ?? '—'}`),
        h('span.cc-stat', `DR ${dr?.value ?? '—'}`),
        x.noTarget ? h('span.cc-flag', 'Not targeted') : aggroDots(x),
        x.conditions.length ? h('span.cc-conds', x.conditions.map((k) => k.name).join(', ')) : null,
        chev(open)),
      open ? h('div.cc-more',
        h('div.cc-more-dmg', h('span.mini-l', 'Damage / heal'), quick(x, true)),
        h('div.cc-more-row',
          numEl(ev, evDef, evDef?.label || 'Evade'), numEl(dr, drDef, drDef ? 'DR' : 'DR'),
          h('span.grow'),
          h('span.cc-ctl', h('span.mini-l', 'Aggro'),
            h('button.icon-btn', { type: 'button', 'aria-label': `Lower ${x.name}'s aggro`, disabled: x.aggro <= 1, onclick: () => act({ t: 'combat.target', uid: x.uid, aggro: x.aggro - 1 }) }, icon('down', { size: 14 })),
            h('b.cc-aggro-n', String(x.aggro ?? 3)),
            h('button.icon-btn', { type: 'button', 'aria-label': `Raise ${x.name}'s aggro`, disabled: x.aggro >= 9, onclick: () => act({ t: 'combat.target', uid: x.uid, aggro: x.aggro + 1 }) }, icon('up', { size: 14 }))),
          h('label.chk', { title: 'Hidden, playing dead, out of reach: mobs never pick this crawler by themselves' }, h('input', { type: 'checkbox', checked: !!x.noTarget, onchange: (e) => act({ t: 'combat.target', uid: x.uid, noTarget: e.target.checked }) }), h('span', "Don't target"))),
        conditions(x)) : null,
    );
  }

  async function mobRollAndShow(m, i) { await mobRoll(m, i); }

  async function mobRoll(m, i) {
    const atk = m.attacks[i];
    try {
      const r = await send({ t: 'combat.mobRoll', uid: m.uid, attackIndex: i, public: !!pref.publicRolls });
      const res = r?.result || {};
      ui.lastRoll = { at: Date.now(), name: m.name, uid: m.uid, attack: atk, ...res };
      const nat = res.nat20 ? ' (natural 20!)' : res.nat1 ? ' (natural 1)' : '';
      toast(`${m.name}, ${atk.name}: ${res.total} to hit${nat}${res.damage != null ? `, ${res.damage} damage` : ''}${pref.publicRolls ? '' : ' (secret)'}`, { ms: 5000 });
      redraw();
    } catch (err) { toast(err.message, { error: true }); }
  }

  function mobCard(m) {
    const e = libEntry(m);
    const open = ui.open.has(m.uid);
    const crawlers = C().combatants.filter((x) => x.type === 'crawler');
    const setHp = (v) => act({ t: 'combat.update', uid: m.uid, hp: v });
    const focusName = m.focus ? crawlers.find((x) => x.uid === m.focus)?.name : null;
    const modeLabel = m.targetMode === 'focus' && focusName ? `→ ${focusName}` : m.targetMode === 'spread' ? 'Spread' : 'Auto';
    const more = open ? h('div.cc-more',
      h('div.cc-more-dmg', h('span.mini-l', 'Damage / heal'), quick(m, true)),
      h('div.cc-block',
        h('span.mini-l', 'Attacks'),
        m.attacks.length ? h('div.cbt-atks', m.attacks.map((a, i) => h('button.btn.btn-sm.cbt-atk', {
          type: 'button', disabled: m.down, onclick: () => mobRollAndShow(m, i),
          title: `Roll ${a.name}: d20${a.toHit ? signed(a.toHit) : ''}${a.damage && a.damage !== '0' ? `, ${a.damage} damage` : ''}${a.effects ? `. ${a.effects}` : ''}`,
        }, icon('dice', { size: 13 }), h('span', a.name), h('small', `${signed(a.toHit)}${a.damage && a.damage !== '0' ? ` · ${a.damage}` : ''}`), a.buffs?.length ? h('small.cbt-atk-buff', a.buffs.join(', ')) : null))) : h('span.dim', 'No attacks: it never acts in auto mode.'),
        m.attacks.length > 1 ? h('div.seg.seg-sm.cbt-amode', { role: 'radiogroup', 'aria-label': 'Which attack in auto mode' },
          [['first', 'First'], ['random', 'Random']].map(([v, l]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(m.attackMode === v), 'aria-pressed': String(m.attackMode === v), onclick: () => act({ t: 'combat.target', uid: m.uid, attackMode: v }) }, l))) : null),
      h('div.cc-block',
        h('span.mini-l', 'Targets'),
        h('div.cbt-tmode',
          h('div.seg.seg-sm', { role: 'radiogroup', 'aria-label': `${m.name} target mode` },
            MODES.map(([v, l]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(m.targetMode === v), 'aria-pressed': String(m.targetMode === v),
              onclick: () => (v === 'focus' && !m.focus && crawlers[0] ? act({ t: 'combat.target', uid: m.uid, focus: crawlers.find((x) => !x.down)?.uid || crawlers[0].uid }) : act({ t: 'combat.target', uid: m.uid, targetMode: v })) }, l))),
          m.targetMode === 'focus' ? select(crawlers.map((x) => ({ value: x.uid, label: x.name })), m.focus || '', { cls: 'inp-sm', label: 'Focus target', onChange: (v) => act({ t: 'combat.target', uid: m.uid, focus: v }) }) : null)),
      h('div.cc-block', h('span.mini-l', 'Conditions'), conditions(m)),
      e?.tactics || e?.notes || e?.lootHint || m.attacks.some((a) => a.effects) ? h('div.cbt-info',
        e?.tactics ? h('p', h('b', 'Tactics. '), e.tactics) : null,
        e?.notes ? h('p', h('b', 'Notes. '), e.notes) : null,
        e?.lootHint ? h('p', h('b', 'Loot. '), e.lootHint) : null,
        m.attacks.filter((a) => a.effects).map((a) => h('p', h('b', `${a.name}. `), a.effects))) : null,
      h('div.cbt-info-row',
        h('label.cbt-mini', h('span.mini-l', 'Name'), field(m.name, { cls: 'inp-sm', attrs: { 'aria-label': 'Name', maxlength: 80 }, onCommit: (v) => v.trim() && act({ t: 'combat.update', uid: m.uid, name: v.trim() }) })),
        h('label.cbt-mini', h('span.mini-l', 'Max HP'), field(m.hpMax, { type: 'number', cls: 'inp-sm cbt-num', attrs: { min: 1, max: 999 }, onCommit: (v) => act({ t: 'combat.update', uid: m.uid, hpMax: Math.max(1, Math.min(999, Math.round(v) || 1)) }) })),
        h('label.cbt-mini', h('span.mini-l', 'Evade'), field(m.evade, { type: 'number', cls: 'inp-sm cbt-num', attrs: { min: -99, max: 99 }, onCommit: (v) => act({ t: 'combat.update', uid: m.uid, evade: Math.round(v) || 0 }) })),
        h('label.cbt-mini', h('span.mini-l', 'DR'), field(m.dr, { type: 'number', cls: 'inp-sm cbt-num', attrs: { min: -99, max: 99 }, onCommit: (v) => act({ t: 'combat.update', uid: m.uid, dr: Math.round(v) || 0 }) }))),
      field(m.notes, { cls: 'inp-sm', placeholder: 'Notes for this one (GM only)', attrs: { maxlength: 500, 'aria-label': `Notes for ${m.name}` }, onCommit: (v) => act({ t: 'combat.update', uid: m.uid, notes: v }) }),
      h('div.row-end', h('button.btn.btn-sm.btn-quiet.danger', { type: 'button', onclick: () => act({ t: 'combat.remove', uid: m.uid }, `${m.name} removed.`) }, icon('trash', { size: 14 }), 'Remove'))) : null;
    return h('li.cc.cc-mob', { class: `cc cc-mob${m.down ? ' down' : ''}${m.hidden ? ' is-hidden' : ''}${m.sourceKind === 'boss' ? ' is-boss' : ''}`, 'data-uid': m.uid },
      h('div.cc-who',
        artBtn(entryArt({ name: m.name, image: m.image }, { cls: 'cbt-art' }), `Change the art of ${m.name}`, () => pickMobArt(m)),
        h('div.cc-nm', h('b', m.name),
          h('span.dim', `${m.hp} / ${m.hpMax} HP`, m.sourceKind === 'boss' ? h('span.pill.pill-on', m.linked ? 'Boss · on TV' : 'Boss') : null, m.hidden ? h('span.pill', 'Hidden') : null)),
        h('button.icon-btn.cbt-eye', {
          type: 'button', 'aria-pressed': String(!m.hidden), class: m.hidden ? 'icon-btn cbt-eye' : 'icon-btn cbt-eye on',
          title: m.hidden ? 'Hidden: GM only. Tap to reveal on the TV and phones' : 'Revealed. Tap to hide again',
          'aria-label': m.hidden ? `Reveal ${m.name}` : `Hide ${m.name}`,
          onclick: () => act({ t: 'combat.reveal', uid: m.uid, on: m.hidden }),
        }, icon(m.hidden ? 'eyeOff' : 'eye', { size: 16 }))),
      h('div.cc-hp', hpSlots(m.hp, m.hpMax, setHp, m.name)),
      quick(m, true),
      h('button.cc-sub', { type: 'button', 'aria-expanded': String(open), onclick: () => toggle(m.uid) },
        h('span.cc-stat', `Ev ${m.evade}`), h('span.cc-stat', `DR ${m.dr}`),
        m.attacks[0] ? h('span.cc-atk', icon('swords', { size: 12 }), m.attacks.length > 1 ? `${m.attacks.length} attacks` : m.attacks[0].name) : null,
        h('span.cc-mode', { class: `cc-mode m-${m.targetMode}` }, icon('target', { size: 12 }), modeLabel),
        m.conditions.length ? h('span.cc-conds', m.conditions.map((k) => k.name).join(', ')) : null,
        chev(open)),
      more,
    );
  }

  function fallenRow(m) {
    return h('li.cbt-fallen-row',
      entryArt({ name: m.name, image: m.image }, { cls: 'cbt-art sm', lit: false }),
      h('s', m.name),
      h('span.grow'),
      looted(m.uid) ? h('span.dim.cbt-looted', 'Looted') : h('button.btn.btn-sm', { type: 'button', title: 'Drop its loot (library list) on the TV', onclick: () => act({ t: 'loot.corpse', uid: m.uid }, `${m.name} dropped its loot.`) }, icon('gift', { size: 13 }), 'Loot'),
      h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => act({ t: 'combat.heal', uid: m.uid, amount: 1 }, `${m.name} is back up.`), title: 'Back to 1 HP' }, '+1'),
      h('button.icon-btn', { type: 'button', 'aria-label': `Remove ${m.name}`, onclick: () => act({ t: 'combat.remove', uid: m.uid }) }, icon('trash', { size: 14 })));
  }

  /* ---------- loot from the dead (loot.js) ---------- */

  const drops = () => view?.gm?.drops || [];
  const looted = (uid) => drops().some((d) => d.from.uid === uid);
  /** Bodies to loot (downed mobs + crawlers) and the piles to hand out, item by item, to a crawler. */
  function lootPanel() {
    const ds = drops();
    const bodies = (C().combatants || []).filter((x) => x.down && !looted(x.uid));
    if (!ds.length && !bodies.length) return null;
    const ps = view?.players || [];
    const name = (id) => ps.find((p) => p.id === id)?.name || '?';
    return h('section.panel.cbt-lootp',
      h('div.sec-head', h('h2', 'Loot'), h('span.dim', 'from the dead: pick who takes what')),
      bodies.length ? h('div.cbt-bodies', bodies.map((x) => h('button.btn.btn-sm', {
        type: 'button',
        title: x.type === 'mob' ? 'Its library loot falls on the TV' : 'Everything they carried falls on the TV',
        onclick: () => act({ t: 'loot.corpse', uid: x.uid }, `${x.name} dropped ${x.type === 'mob' ? 'its loot' : 'everything'}.`),
      }, icon('gift', { size: 13 }), `Loot ${x.name}`))) : null,
      [...ds].reverse().map((d) => {
        const left = d.items.filter((it) => !it.takenBy).length;
        return h('div.cbt-drop',
          h('div.cbt-drop-head', h('b', d.from.name), h('span.dim', left ? `${left} left` : 'all taken'), h('span.grow'),
            h('button.icon-btn', { type: 'button', title: 'Forget this pile', 'aria-label': `Forget the pile of ${d.from.name}`, onclick: () => act({ t: 'loot.clear', dropId: d.id }) }, icon('x', { size: 14 }))),
          h('ul.cbt-drop-items', d.items.map((it) => h('li', { class: it.takenBy ? 'taken' : '' },
            itemArt(it, 'cbt-drop-art'),
            h('span.cbt-drop-nm', it.name, it.qty > 1 ? h('span.dim', ` ×${it.qty}`) : null),
            it.takenBy ? h('span.dim', `→ ${name(it.takenBy)}`)
              : h('span.cbt-drop-to', ps.filter((p) => p.id !== d.from.playerId).map((p) => h('button.btn.btn-sm.btn-quiet', {
                type: 'button', title: `Give ${it.name} to ${p.name}`,
                onclick: () => act({ t: 'loot.take', dropId: d.id, key: it.key, playerId: p.id }, `${p.name} takes ${it.name}.`),
              }, p.name)))))));
      }));
  }

  /* ---------- finale follow-up (after combat.end) ---------- */

  function finaleBanner() {
    if (view?.scene?.kind !== 'finale') return null;
    const d = view.scene.data || {};
    const o = OUTCOMES.find((x) => x.id === d.outcome);
    const ps = view.players || [];
    const tiers = view.pack?.lootTiers || [];
    if (!ui.loot) ui.loot = { playerId: d.summary?.mvp?.playerId || ps[0]?.id || '', tier: tiers[0]?.id || '', placed: false };
    const L = ui.loot;
    const sum = d.summary;
    return h('section.panel.cbt-finale',
      h('div.sec-head', h('h2', `On TV: ${d.title || o?.label || 'Finale'}`), h('span.grow'),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => act({ t: 'scene.set', kind: 'combat', data: {} }, 'Arena on the TV.') }, 'Back to arena')),
      sum ? h('p.dim', `${sum.rounds} round${sum.rounds === 1 ? '' : 's'} · ${sum.dealt} dealt · ${sum.taken} taken · ${sum.mobsDefeated}/${sum.mobsTotal} mobs · ${sum.downs} down${sum.mvp ? ` · MVP ${sum.mvp.name}` : ''}`) : null,
      ps.length && tiers.length ? h('div.cbt-loot',
        h('span.mini-l', 'Loot!'),
        select(ps.map((p) => ({ value: p.id, label: p.name })), L.playerId, { cls: 'inp-sm', label: 'Who gets the box', onChange: (v) => { L.playerId = v; } }),
        select(tiers.map((t) => ({ value: t.id, label: t.name })), L.tier, { cls: 'inp-sm', label: 'Box', onChange: (v) => { L.tier = v; } }),
        h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: async () => { if (await act({ t: 'scene.set', kind: 'loot', data: { playerId: L.playerId, tier: L.tier } }, 'Loot box on the TV.')) { L.placed = true; } } }, icon('gift', { size: 14 }), 'Box on TV'),
        h('button.btn.btn-sm', { type: 'button', onclick: () => act({ t: 'loot.open', playerId: L.playerId, tier: L.tier }, 'Box opened.') }, 'Open it')) : null);
  }

  /* ---------- auto-end offer (3 s toast with Cancel) ---------- */

  let endTimer = 0;
  let endTick = 0;
  function hideToast() { clearTimeout(endTimer); clearInterval(endTick); endTimer = 0; toastEl.hidden = true; }
  function maybeOffer() {
    const s = C().suggestEnd || null;
    if (!s) { if (ui.offered && !endTimer) ui.offered = null; if (endTimer) hideToast(); return; }
    if (ui.offered === s || endTimer) return;
    const wait = playingLeft();
    if (wait > 0) { clearTimeout(endTimer); endTimer = setTimeout(() => { endTimer = 0; maybeOffer(); }, wait + 50); return; }
    ui.offered = s;
    let n = END_DELAY_S;
    const label = s === 'victory' ? 'Every revealed mob is down. Victory' : 'Every crawler is down. Party wiped';
    const msg = h('span');
    const paint = () => { msg.textContent = `${label} in ${n}…`; };
    paint();
    toastEl.replaceChildren(icon(s === 'victory' ? 'star' : 'skull', { size: 16 }), msg,
      h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => { hideToast(); endWith(s); } }, 'Now'),
      h('button.btn.btn-sm', { type: 'button', onclick: () => { hideToast(); toast('Fight goes on. End it from End ▾.'); } }, 'Cancel'));
    toastEl.dataset.outcome = s;
    toastEl.hidden = false;
    endTick = setInterval(() => { n -= 1; if (n > 0) paint(); }, 1000);
    endTimer = setTimeout(() => { hideToast(); if (C().suggestEnd === s) endWith(s); }, END_DELAY_S * 1000);
  }

  /* ---------- builder ---------- */

  function builder() {
    const tabs = [['monsters', 'Monsters'], ['location', 'Location'], ['adhoc', 'Ad hoc']];
    const seg = h('div.seg.seg-sm', { role: 'tablist' }, tabs.map(([id, label]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(pref.tab === id), 'aria-pressed': String(pref.tab === id), onclick: () => { setPref('tab', id); redraw(); } }, label)));
    let body;
    if (pref.tab === 'location') body = locationTab();
    else if (pref.tab === 'adhoc') body = adhocTab();
    else body = monstersTab();
    return h('section.panel.cbt-builder', h('div.sec-head', h('h2', 'Add to the fight'), h('span.grow'), seg), body,
      h('p.hint', 'New mobs start hidden (GM only). Reveal them when they show up.'));
  }

  const countOf = (key) => ui.counts[key] ?? 1;
  function countStepper(key) {
    const n = countOf(key);
    return h('span.stepper.cbt-count',
      h('button', { type: 'button', 'aria-label': 'One fewer', disabled: n <= 1, onclick: () => { ui.counts[key] = n - 1; redraw(); } }, icon('minus', { size: 12 })),
      h('span.stepper-v', String(n)),
      h('button', { type: 'button', 'aria-label': 'One more', disabled: n >= 20, onclick: () => { ui.counts[key] = n + 1; redraw(); } }, icon('plus', { size: 12 })));
  }
  async function addMob(kind, e, count) {
    if (await act({ t: 'combat.addMob', kind, sourceId: e.id, count }, `${count > 1 ? `${count}× ` : ''}${e.name} added (hidden).`)) { ui.counts[`${kind}:${e.id}`] = 1; redraw(); }
  }
  function monsterItem(kind, e) {
    const key = `${kind}:${e.id}`;
    const linkedHint = kind === 'boss' && view.scene?.kind === 'boss' && view.scene.data?.bossId === e.id ? ' · on TV' : '';
    return h('li.cbt-pick', { class: e.image ? 'cbt-pick' : 'cbt-pick no-art' },
      artBtn(entryArt(e, { cls: 'cbt-pick-art' }), e.image ? `Change the art of ${e.name}` : `${e.name} has no art yet: pick a picture`, () => pickLibArt(kind, e)),
      h('div.cbt-pick-t', h('b', e.name), h('span.dim', [kind === 'boss' ? 'Boss' : e.group, e.floor !== '' && e.floor != null ? `F${e.floor}` : '', `${e.hpSlots} HP`, `Ev ${e.evade ?? 0}`, `DR ${e.dr ?? 0}`].filter(Boolean).join(' · ') + linkedHint)),
      kind === 'boss' ? h('span') : countStepper(key),
      h('button.btn.btn-sm', { type: 'button', onclick: () => addMob(kind, e, kind === 'boss' ? 1 : countOf(key)), 'aria-label': `Add ${e.name}` }, icon('plus', { size: 13 }), 'Add'));
  }
  function monstersTab() {
    const q = (pref.q || '').toLowerCase();
    const match = (e) => !q || `${e.name} ${e.group || ''} ${(e.tags || []).join(' ')} ${e.floor}`.toLowerCase().includes(q);
    const mons = (lib().monster || []).filter(match).sort((a, b) => (Number(a.floor) || 0) - (Number(b.floor) || 0) || a.name.localeCompare(b.name));
    const bosses = (lib().boss || []).filter(match);
    const search = h('input.inp.inp-sm', { type: 'search', value: pref.q || '', placeholder: 'Search monsters', 'aria-label': 'Search monsters', oninput: (ev) => { pref.q = ev.target.value; savePref(pref); redrawKeepFocus(ev.target); } });
    return h('div.cbt-tab', search,
      h('ul.cbt-picks', mons.length ? mons.map((e) => monsterItem('monster', e)) : h('li.empty-s', (lib().monster || []).length ? 'Nothing matches.' : 'No monsters yet. Add monsters.json to the pack or create one in the Library.')),
      bosses.length ? [h('h3.sub-t', 'Bosses as combatants'), h('ul.cbt-picks', bosses.map((e) => monsterItem('boss', e)))] : null);
  }
  function locationTab() {
    const locs = lib().location || [];
    if (!locs.length) return h('p.empty-s', 'No locations in the library.');
    const cur = locs.find((l) => l.id === pref.locationId) || (view.scene?.kind === 'explore' ? locs.find((l) => l.id === view.scene.data?.locationId) : null) || locs[0];
    const mons = (cur.monsters || []).map((id) => (lib().monster || []).find((e) => e.id === id)).filter(Boolean);
    const bosses = (cur.bosses || []).map((id) => (lib().boss || []).find((e) => e.id === id)).filter(Boolean);
    const addAll = async () => {
      for (const e of mons) await act({ t: 'combat.addMob', kind: 'monster', sourceId: e.id, count: countOf(`monster:${e.id}`) });
      toast(`${cur.name}: ${mons.length} kinds of monster added (hidden).`);
    };
    return h('div.cbt-tab',
      select(locs.map((l) => ({ value: l.id, label: `${l.floor !== '' && l.floor != null ? `F${l.floor} ` : ''}${l.name}` })), cur.id, { cls: 'inp-sm', label: 'Location', onChange: (v) => { setPref('locationId', v); redraw(); } }),
      h('ul.cbt-picks', mons.length ? mons.map((e) => monsterItem('monster', e)) : h('li.empty-s', 'This location lists no monsters.')),
      bosses.length ? h('ul.cbt-picks', bosses.map((e) => monsterItem('boss', e))) : null,
      mons.length > 1 ? h('div.row-end', h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: addAll }, icon('plus', { size: 13 }), 'Add all')) : null);
  }
  function adhocTab() {
    const a = ui.adhoc;
    const name = h('input.inp.inp-sm', { value: a.name, placeholder: 'Cultist', maxlength: 60, 'aria-label': 'Name', oninput: (e) => { a.name = e.target.value; } });
    const num = (k, label, lo, hi) => h('label.cbt-mini', h('span.mini-l', label), h('input.inp.inp-sm', { type: 'number', value: a[k], min: lo, max: hi, 'aria-label': label, oninput: (e) => { a[k] = Number(e.target.value); } }));
    return h('form.cbt-tab.cbt-adhoc', {
      onsubmit: async (e) => {
        e.preventDefault();
        if (!a.name.trim()) { name.focus(); return; }
        const ok = await act({ t: 'combat.addAdhoc', name: a.name.trim(), hp: Math.max(1, Math.min(999, Math.round(a.hp) || 1)), evade: Math.round(a.evade) || 0, dr: Math.round(a.dr) || 0, count: Math.max(1, Math.min(20, Math.round(a.count) || 1)), ...(a.image ? { image: a.image } : {}) }, `${a.name.trim()} added (hidden).`);
        if (ok) { a.name = ''; a.image = null; redraw(); }
      },
    },
    h('div.cbt-adhoc-top',
      artBtn(entryArt({ name: a.name || '?', image: a.image || null }, { cls: 'cbt-pick-art' }), 'Pick a picture for this mob', () => openArtGallery(view, {
        title: 'Art for the ad-hoc mob', current: a.image || null, onPick: (u) => { a.image = u; redraw(); },
      })),
      h('label.lbl', h('span.lbl-t', 'Name'), name)),
    h('div.cbt-info-row', num('hp', 'HP', 1, 999), num('evade', 'Evade', -99, 99), num('dr', 'DR', -99, 99), num('count', 'Count', 1, 20)),
    h('div.row-end', h('button.btn.btn-sm.btn-primary', { type: 'submit' }, icon('plus', { size: 13 }), 'Add')));
  }

  function lastRollCard() {
    const r = ui.lastRoll;
    const vis = h('label.chk.cbt-pub', { title: 'Public rolls show in everyone\'s dice log and can trigger the nat 20 / nat 1 lines' },
      h('input', { type: 'checkbox', checked: !!pref.publicRolls, onchange: (e) => { setPref('publicRolls', e.target.checked); redraw(); } }), h('span', 'Mob rolls are public'));
    if (!r) return h('section.panel.cbt-last', h('div.sec-head', h('h2', 'Mob attacks'), h('span.grow'), vis), h('p.dim', 'Press an attack on a mob row: d20 + to hit, then damage, straight into the dice log (secret unless public).'));
    const crawlers = C().combatants.filter((x) => x.type === 'crawler');
    const bufs = (r.buffs || []).map((id) => (lib().buff || []).find((b) => b.id === id)).filter(Boolean);
    return h('section.panel.cbt-last', { class: `panel cbt-last${r.nat20 ? ' nat20' : r.nat1 ? ' nat1' : ''}` },
      h('div.sec-head', h('h2', 'Last mob attack'), h('span.grow'), vis),
      h('p.cbt-last-who', h('b', r.name), ` · ${r.attack?.name}`, r.public ? null : h('span.pill', icon('lock', { size: 11 }), 'secret')),
      h('div.cbt-last-nums',
        h('div', h('small', 'To hit'), h('b', String(r.total)), r.nat20 ? h('span.nat-tag', 'NAT 20') : r.nat1 ? h('span.nat-tag', 'NAT 1') : null),
        r.damage != null ? h('div', h('small', 'Damage'), h('b', String(r.damage))) : null),
      r.attack?.effects ? h('p.cbt-last-fx', r.attack.effects) : null,
      r.damage != null && crawlers.length ? h('div.cbt-apply', h('span.mini-l', `Apply ${r.damage} to`), crawlers.map((x) => h('button.btn.btn-sm', { type: 'button', onclick: () => act({ t: 'combat.damage', uid: x.uid, amount: r.damage }, `${x.name} takes ${r.damage}.`) }, x.name))) : null,
      bufs.length && crawlers.length ? bufs.map((b) => h('div.cbt-apply', h('span.mini-l', `${b.name} on`), crawlers.map((x) => h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => act({ t: 'combat.condition', uid: x.uid, buffId: b.id, on: true }, `${x.name}: ${b.name}.`) }, x.name)))) : null,
    );
  }

  function redrawKeepFocus(input) {
    const pos = input.selectionStart;
    sig = '';
    draw(true);
    const again = el.querySelector('.cbt-builder input[type="search"]');
    if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch {} }
  }

  function draw(force = false) {
    if (!view) return;
    const c = C();
    const s = JSON.stringify([c, view.scene?.kind, view.scene?.id, view.scene?.data?.bossId, view.gm?.playersFull?.map((p) => [p.id, p.sheet?.computed?.derived, p.sheet?.portrait, !!portraitSrc(p.sheet?.portrait)]), view.library?.monster?.length, view.library?.boss?.length, view.library?.buff?.length, view.library?.location?.length, ui.endMenu, ui.special != null, sfx?.on, playingLeft() > 0]);
    if (!force && s === sig) return;
    if (!force && el.contains(document.activeElement) && document.activeElement.matches('input:not([type=checkbox]), textarea')) return;
    sig = s;
    const crawlers = c.combatants.filter((x) => x.type === 'crawler');
    const mobs = c.combatants.filter((x) => x.type === 'mob');
    const living = mobs.filter((m) => !m.down);
    const dead = mobs.filter((m) => m.down);
    const hiddenN = living.filter((m) => m.hidden).length;
    const list = h('section.panel.cbt-list-panel',
      h('div.sec-head', h('h2', 'Crawlers'), h('span.dim', c.active ? `Now: ${c.phase || ''}` : 'Join when combat starts')),
      crawlers.length ? h('ul.cbt-list', crawlers.map(crawlerCard)) : h('p.empty-s', c.active ? 'No crawlers in the fight.' : 'Start combat to bring the whole party in.'),
      h('div.sec-head.cbt-mobs-head', h('h2', 'Mobs'), h('span.dim', mobs.length ? `${living.length} standing${hiddenN ? `, ${hiddenN} hidden` : ''}` : '')),
      living.length ? h('ul.cbt-list', living.map(mobCard)) : h('p.empty-s', mobs.length ? 'Every mob is down.' : 'No mobs yet. Add them below.'),
      dead.length ? h('details.cbt-fallen', { open: ui.fallenOpen || null, ontoggle: (e) => { ui.fallenOpen = e.target.open; } },
        h('summary', `Defeated (${dead.length})`), h('ul.cbt-list', dead.map(fallenRow))) : null,
    );
    const side = h('div.cbt-side', lootPanel(), c.active ? autoPanel() : null, builder(), lastRollCard());
    el.replaceChildren(...[
      header(),
      ui.editPhases ? phaseEditor() : null,
      finaleBanner(),
      h('div.cbt-cols', list, side),
    ].filter(Boolean));
    maybeOffer();
  }
  el.addEventListener('focusout', () => setTimeout(() => { if (!el.contains(document.activeElement)) draw(); }, 0));
  onPortraits(() => redraw());
  // Skip / Undo buttons depend on time: refresh once the cinematic is over.
  setInterval(() => { if (view && el.isConnected && C().lastAuto && !el.contains(document.activeElement)) draw(); }, 1000);
  document.addEventListener('pointerdown', (e) => {
    if ((ui.endMenu || ui.soundPop) && !e.target.closest?.('.cbt-endmenu, .cbt-endbtn, .cbt-pop-anchor')) { ui.endMenu = false; ui.soundPop = false; ui.special = null; redraw(); }
  });

  // N = next phase (only while the Combat view is visible and nothing is being typed).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'n' && e.key !== 'N') return;
    if (e.ctrlKey || e.metaKey || e.altKey || !el.isConnected || el.closest('[hidden]')) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
    if (!C().active) return;
    e.preventDefault();
    act({ t: 'combat.next' });
  });

  return { el, update(v) { if (v) v._at = Date.now(); view = v; if (v?.scene?.kind !== 'finale') ui.loot = null; draw(); } };
}

export { signed };
