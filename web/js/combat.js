// GM desk → Combat: the synced tracker (server/combat.js). Everything here is engine state, so the
// TV, phones and a reloaded desk all see the same fight. Encounter builder (library monsters /
// bosses, a location's monsters, ad hoc), round + phase header, combatant rows with HP slots,
// quick damage, condition chips from the buff library, mob attack rolls, reveal toggles and
// "Show on TV" (scene kind `combat`).
import { h, toast } from './client.js';
import { sheetModel, libraryOf } from './rules.js';
import { icon, explain, whyContent, avatar, field, select, unverifiedBadge, signed } from './ui.js';
import { entryArt } from './portrait.js';

const PREF = 'system.combat.ui'; // UI preferences only (builder tab, roll visibility); no game state
const loadPref = () => { try { return JSON.parse(localStorage.getItem(PREF) || '{}') || {}; } catch { return {}; } };
const savePref = (p) => { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch {} };

export function createCombat({ act, send, getView }) {
  let view = null;
  let sig = '';
  const pref = { tab: 'monsters', publicRolls: false, q: '', locationId: '', ...loadPref() };
  const ui = { counts: {}, open: new Set(), editPhases: false, lastRoll: null, adhoc: { name: '', hp: 5, evade: 0, dr: 0, count: 1 } };
  const setPref = (k, v) => { pref[k] = v; savePref(pref); };
  const el = h('div.combat.cbt');

  const C = () => view?.combat || { active: false, round: 1, phaseIndex: 0, phases: ['Crawlers', 'Mobs'], combatants: [] };
  const lib = () => libraryOf(view);
  const libEntry = (m) => (m.sourceKind ? (lib()[m.sourceKind] || []).find((e) => e.id === m.sourceId) : null);
  const onTv = () => view?.scene?.kind === 'combat';
  const redraw = () => { sig = ''; draw(); };

  /* ---------- header: round / phase / TV ---------- */

  function header() {
    const c = C();
    const ph = c.phases || [];
    const last = c.phaseIndex >= ph.length - 1;
    const mobs = c.combatants.filter((x) => x.type === 'mob');
    const hidden = mobs.filter((m) => m.hidden).length;
    return h('header.cbt-head',
      h('div.cbt-title',
        h('h1', 'Combat'),
        c.active ? h('span.cbt-round', h('small', 'Round'), h('b', String(c.round))) : h('span.pill', 'Not started')),
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
      h('button.btn.btn-sm.btn-quiet', { type: 'button', 'aria-pressed': String(ui.editPhases), onclick: () => { ui.editPhases = !ui.editPhases; redraw(); } }, 'Phases'),
      h('span.grow'),
      hidden ? h('button.btn.btn-sm', { type: 'button', onclick: () => act({ t: 'combat.reveal', all: true }, `${hidden} revealed.`), title: 'Show every hidden mob on the TV and phones' }, icon('eye', { size: 14 }), `Reveal all (${hidden})`) : null,
      h('label.chk.cbt-hpt', { title: 'Show exact mob HP numbers on the TV and phones (otherwise bars only)' },
        h('input', { type: 'checkbox', checked: !!c.showMobHp, onchange: (e) => act({ t: 'combat.set', showMobHp: e.target.checked }) }), h('span', 'Mob HP numbers')),
      h('button.btn.btn-sm', {
        type: 'button', class: onTv() ? 'btn btn-sm is-live' : 'btn btn-sm', 'aria-pressed': String(onTv()),
        onclick: () => act({ t: 'scene.set', kind: 'combat', data: {} }, 'On TV: the arena.'),
      }, icon('tv', { size: 14 }), onTv() ? 'On TV' : 'Show on TV'),
      c.active || c.combatants.length ? h('button.btn.btn-sm.btn-quiet.danger', { type: 'button', onclick: end }, 'End combat') : null,
    );
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
      if (!onTv()) toast('Tip: Show on TV puts the arena on screen.', { ms: 3000 });
    }
  }
  async function end() {
    const n = C().combatants.filter((x) => x.type === 'mob').length;
    if (n && !confirm(`End combat and clear ${n} mob${n === 1 ? '' : 's'}?`)) return;
    act({ t: 'combat.end' }, 'Combat over.');
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

  function dmgButtons(x) {
    const dmg = (n) => act({ t: 'combat.damage', uid: x.uid, amount: n });
    const custom = h('input.inp.inp-sm.cbt-amt', { type: 'number', min: 1, max: 999, placeholder: '#', 'aria-label': `Damage amount for ${x.name}`, inputmode: 'numeric' });
    custom.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const n = Math.round(Number(custom.value));
      if (n >= 1) { (e.shiftKey ? act({ t: 'combat.heal', uid: x.uid, amount: n }) : dmg(Math.min(999, n))); custom.value = ''; custom.blur(); }
    });
    return h('div.cbt-dmg',
      [1, 2, 3].map((n) => h('button.btn.btn-sm.cbt-hit', { type: 'button', disabled: x.hp <= 0, onclick: () => dmg(n), title: `${n} damage` }, `−${n}`)),
      h('button.btn.btn-sm.cbt-heal', { type: 'button', disabled: x.hp >= x.hpMax, onclick: () => act({ t: 'combat.heal', uid: x.uid, amount: 1 }), title: 'Heal 1' }, '+1'),
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

  /* ---------- crawler rows ---------- */

  function crawlerRow(x) {
    const p = (view.gm?.playersFull || []).find((y) => y.id === x.playerId);
    let ev = null;
    let dr = null;
    let evDef = null;
    let drDef = null;
    if (p) {
      const M = sheetModel(view, p);
      evDef = M.rs.derived.find((d) => /evade|defen/i.test(d.id + d.label)) || M.rs.derived.find((d) => d.roll) || M.rs.derived[0];
      drDef = M.rs.derived.find((d) => d !== evDef && /(^|[^a-z])dr|resist|armou?r/i.test(`${d.id} ${d.label}`));
      ev = evDef ? M.computed.derived?.[evDef.id] : null;
      dr = drDef ? M.computed.derived?.[drDef.id] : null;
    }
    const numEl = (b, def) => {
      const n = h('b.num', { tabindex: '0' }, String(b?.display ?? b?.value ?? '—'));
      if (b) explain(n, () => whyContent(b, { title: def?.label }));
      return n;
    };
    return h('li.cbt-row.cbt-crawler', { class: `cbt-row cbt-crawler${x.down ? ' down' : ''}`, 'data-uid': x.uid, style: { '--pc': x.color || 'var(--c-accent)' } },
      h('div.cbt-who', avatar(x.name, { color: x.color, size: 34, src: p?.sheet?.portrait || null }),
        h('div.cbt-nm', h('b', x.name), h('span.dim', x.down ? 'Down' : `${x.hp} / ${x.hpMax} HP`))),
      h('div.cbt-hp', hpSlots(x.hp, x.hpMax, (v) => (v < x.hp ? act({ t: 'combat.damage', uid: x.uid, amount: x.hp - v }) : v > x.hp ? act({ t: 'combat.heal', uid: x.uid, amount: v - x.hp }) : null), x.name), dmgButtons(x)),
      h('div.cbt-stat', h('span.mini-l', evDef?.label || 'Evade'), numEl(ev, evDef)),
      h('div.cbt-stat', h('span.mini-l', drDef?.label || 'DR'), numEl(dr, drDef)),
      h('div.cbt-tools', h('span.dim.cbt-src', 'Sheet')),
      h('div.cbt-line', conditions(x)),
    );
  }

  /* ---------- mob rows ---------- */

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

  function mobRow(m) {
    const e = libEntry(m);
    const open = ui.open.has(m.uid);
    const setHp = (v) => act({ t: 'combat.update', uid: m.uid, hp: v });
    const info = open ? h('div.cbt-info',
      e?.desc ? h('p', e.desc) : null,
      e?.tactics ? h('p', h('b', 'Tactics. '), e.tactics) : null,
      e?.notes ? h('p', h('b', 'Notes. '), e.notes) : null,
      e?.lootHint ? h('p', h('b', 'Loot. '), e.lootHint) : null,
      m.attacks.filter((a) => a.effects).map((a) => h('p', h('b', `${a.name}. `), a.effects)),
      field(m.notes, { cls: 'inp-sm', placeholder: 'Notes for this one (GM only)', attrs: { maxlength: 500, 'aria-label': `Notes for ${m.name}` }, onCommit: (v) => act({ t: 'combat.update', uid: m.uid, notes: v }) }),
      h('div.cbt-info-row',
        h('label.cbt-mini', h('span.mini-l', 'Max HP'), field(m.hpMax, { type: 'number', cls: 'inp-sm', attrs: { min: 1, max: 999 }, onCommit: (v) => act({ t: 'combat.update', uid: m.uid, hpMax: Math.max(1, Math.min(999, Math.round(v) || 1)) }) })),
        h('label.cbt-mini', h('span.mini-l', 'Evade'), field(m.evade, { type: 'number', cls: 'inp-sm', attrs: { min: -99, max: 99 }, onCommit: (v) => act({ t: 'combat.update', uid: m.uid, evade: Math.round(v) || 0 }) })),
        h('label.cbt-mini', h('span.mini-l', 'DR'), field(m.dr, { type: 'number', cls: 'inp-sm', attrs: { min: -99, max: 99 }, onCommit: (v) => act({ t: 'combat.update', uid: m.uid, dr: Math.round(v) || 0 }) })),
        h('span.grow'),
        h('button.btn.btn-sm.btn-quiet.danger', { type: 'button', onclick: () => act({ t: 'combat.remove', uid: m.uid }, `${m.name} removed.`) }, icon('trash', { size: 14 }), 'Remove')),
    ) : null;
    return h('li.cbt-row.cbt-mob', { class: `cbt-row cbt-mob${m.down ? ' down' : ''}${m.hidden ? ' is-hidden' : ''}${m.sourceKind === 'boss' ? ' is-boss' : ''}`, 'data-uid': m.uid },
      h('div.cbt-who',
        entryArt({ name: m.name, image: m.image }, { cls: 'cbt-art' }),
        h('div.cbt-nm',
          field(m.name, { cls: 'cbt-name', attrs: { 'aria-label': 'Name', maxlength: 80 }, onCommit: (v) => v.trim() && act({ t: 'combat.update', uid: m.uid, name: v.trim() }) }),
          h('span.dim', m.down ? h('span.cbt-dead', icon('skull', { size: 13 }), 'Down') : `${m.hp} / ${m.hpMax} HP`,
            m.sourceKind === 'boss' ? h('span.pill.pill-on', m.linked ? 'Boss · linked to TV' : 'Boss') : null))),
      h('div.cbt-hp', hpSlots(m.hp, m.hpMax, setHp, m.name), dmgButtons(m)),
      h('div.cbt-stat', h('span.mini-l', 'Evade'), h('b.num', String(m.evade))),
      h('div.cbt-stat', h('span.mini-l', 'DR'), h('b.num', String(m.dr))),
      h('div.cbt-tools',
        h('button.icon-btn.cbt-eye', {
          type: 'button', 'aria-pressed': String(!m.hidden), class: m.hidden ? 'icon-btn cbt-eye' : 'icon-btn cbt-eye on',
          title: m.hidden ? 'Hidden: GM only. Click to reveal on the TV and phones' : 'Revealed. Click to hide again',
          'aria-label': m.hidden ? `Reveal ${m.name}` : `Hide ${m.name}`,
          onclick: () => act({ t: 'combat.reveal', uid: m.uid, on: m.hidden }),
        }, icon(m.hidden ? 'eyeOff' : 'eye', { size: 16 })),
        h('button.icon-btn', { type: 'button', 'aria-expanded': String(open), 'aria-label': `Details for ${m.name}`, title: 'Tactics, notes, stats', onclick: () => { if (open) ui.open.delete(m.uid); else ui.open.add(m.uid); redraw(); } }, icon('down', { size: 16 }))),
      h('div.cbt-line',
        m.attacks.length ? h('div.cbt-atks', m.attacks.map((a, i) => h('button.btn.btn-sm.cbt-atk', {
          type: 'button', disabled: m.down, onclick: () => mobRoll(m, i),
          title: `${a.name}: d20${a.toHit ? signed(a.toHit) : ''}${a.damage && a.damage !== '0' ? `, ${a.damage} damage` : ''}${a.effects ? `. ${a.effects}` : ''}`,
        }, icon('dice', { size: 13 }), h('span', a.name), h('small', `${signed(a.toHit)}${a.damage && a.damage !== '0' ? ` · ${a.damage}` : ''}`)))) : null,
        conditions(m)),
      info,
    );
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
    return h('li.cbt-pick',
      entryArt(e, { cls: 'cbt-pick-art' }),
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
        const ok = await act({ t: 'combat.addAdhoc', name: a.name.trim(), hp: Math.max(1, Math.min(999, Math.round(a.hp) || 1)), evade: Math.round(a.evade) || 0, dr: Math.round(a.dr) || 0, count: Math.max(1, Math.min(20, Math.round(a.count) || 1)) }, `${a.name.trim()} added (hidden).`);
        if (ok) { a.name = ''; redraw(); }
      },
    },
    h('label.lbl', h('span.lbl-t', 'Name'), name),
    h('div.cbt-info-row', num('hp', 'HP', 1, 999), num('evade', 'Evade', -99, 99), num('dr', 'DR', -99, 99), num('count', 'Count', 1, 20)),
    h('div.row-end', h('button.btn.btn-sm.btn-primary', { type: 'submit' }, icon('plus', { size: 13 }), 'Add')));
  }

  /* ---------- last attack ---------- */

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

  /* ---------- draw ---------- */

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
    const s = JSON.stringify([c, view.scene?.kind, view.scene?.data?.bossId, view.gm?.playersFull?.map((p) => [p.id, p.sheet?.computed?.derived, p.sheet?.portrait]), view.library?.monster?.length, view.library?.boss?.length, view.library?.buff?.length, view.library?.location?.length]);
    if (!force && s === sig) return;
    if (!force && el.contains(document.activeElement) && document.activeElement.matches('input:not([type=checkbox]), textarea')) return;
    sig = s;
    const crawlers = c.combatants.filter((x) => x.type === 'crawler');
    const mobs = c.combatants.filter((x) => x.type === 'mob');
    const standing = mobs.filter((m) => !m.down).length;
    const list = h('section.panel.cbt-list-panel',
      h('div.sec-head', h('h2', 'Crawlers'), h('span.dim', c.active ? `Now: ${c.phase || ''}` : 'Join when combat starts')),
      crawlers.length ? h('ul.cbt-list', crawlers.map(crawlerRow)) : h('p.empty-s', c.active ? 'No crawlers in the fight.' : 'Start combat to bring the whole party in.'),
      h('div.sec-head.cbt-mobs-head', h('h2', 'Mobs'), h('span.dim', mobs.length ? `${standing} standing${mobs.some((m) => m.hidden) ? `, ${mobs.filter((m) => m.hidden).length} hidden` : ''}` : '')),
      mobs.length ? h('ul.cbt-list', mobs.map(mobRow)) : h('p.empty-s', 'No mobs yet. Pick them on the right.'),
    );
    el.replaceChildren(
      header(),
      ui.editPhases ? phaseEditor() : null,
      h('div.cbt-cols', list, h('div.cbt-side', builder(), lastRollCard())),
    );
  }
  el.addEventListener('focusout', () => setTimeout(() => { if (!el.contains(document.activeElement)) draw(); }, 0));

  // N = next phase (only while the Combat view is visible and nothing is being typed).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'n' && e.key !== 'N') return;
    if (e.ctrlKey || e.metaKey || e.altKey || !el.isConnected || el.closest('[hidden]')) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
    if (!C().active) return;
    e.preventDefault();
    act({ t: 'combat.next' });
  });

  return { el, update(v) { view = v; draw(); } };
}

export { signed };
