// GM combat tracker: rounds, an editable phase list, the party's defensive numbers and a mob list.
// Mobs live on this GM screen only (localStorage); the protocol has no mob state yet.
import { h, toast } from './client.js';
import { sheetModel } from './rules.js';
import { icon, explain, whyContent, avatar, field, unverifiedBadge, stepper, signed } from './ui.js';

const KEY = 'system.combat';
const DEFAULT_PHASES = ['Players', 'Enemies'];
let seq = 0;
const mid = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

function load(defaultPhases) {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && Array.isArray(s.mobs)) return { round: 1, phase: 0, phases: defaultPhases, ...s };
  } catch {}
  return { round: 1, phase: 0, phases: defaultPhases, mobs: [] };
}

export function createCombat({ act, getView }) {
  let view = null;
  let st = null;
  let sig = '';
  const el = h('div.combat');
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch {} draw(true); };

  function phases() { return st.phases?.length ? st.phases : DEFAULT_PHASES; }

  function header(rsPhases) {
    const ph = phases();
    const fromPack = !!rsPhases;
    return h('div.view-head.combat-head',
      h('h1', 'Combat'),
      h('div.round', h('span.dim', 'Round'), stepper(st.round, { min: 1, label: 'Round', onChange: (v) => { st.round = v; save(); } })),
      h('ol.phases', { 'aria-label': 'Phases' }, ph.map((p, i) => h('li', h('button', { type: 'button', 'aria-current': i === st.phase ? 'step' : null, onclick: () => { st.phase = i; save(); } }, p)))),
      h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: nextPhase }, phaseLabel()),
      fromPack ? null : h('span.verify', unverifiedBadge('Phase order not checked against the rulebook'), 'Verify phase order with the rulebook'),
      h('span.grow'),
      h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: editPhases }, 'Edit phases'),
      h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => { st.round = 1; st.phase = 0; st.mobs = []; save(); toast('Combat cleared.'); } }, 'End combat'),
    );
  }
  const phaseLabel = () => (st.phase >= phases().length - 1 ? `Next round (${st.round + 1})` : `Next: ${phases()[st.phase + 1]}`);
  function nextPhase() {
    if (st.phase >= phases().length - 1) { st.phase = 0; st.round += 1; } else st.phase += 1;
    save();
  }
  function editPhases() {
    const inp = h('input.inp', { value: phases().join(', '), 'aria-label': 'Phases, comma separated' });
    const box = el.querySelector('.phase-edit') || h('div.phase-edit');
    box.replaceChildren(h('label.lbl', h('span.lbl-t', 'Phases in order, comma separated'), inp),
      h('div.row-end', h('button.btn.btn-sm', { type: 'button', onclick: () => box.remove() }, 'Cancel'),
        h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => { st.phases = inp.value.split(',').map((x) => x.trim()).filter(Boolean); st.phase = 0; save(); } }, 'Save phases')));
    el.querySelector('.combat-head').after(box);
    inp.focus();
  }

  /* ---------- crawlers ---------- */

  function crawlerRows() {
    const list = view.gm?.playersFull || [];
    if (!list.length) return h('p.empty-s', 'No crawlers in the party.');
    return h('ul.cb-list', list.map((p) => {
      const M = sheetModel(view, p);
      const c = M.computed;
      const hpDef = M.rs.tracks.find((t) => t.id === 'hp') || M.rs.tracks[0];
      const hp = hpDef ? c.tracks?.[hpDef.id] : null;
      const ev = M.rs.derived.find((d) => d.roll) || M.rs.derived[0];
      const dr = M.rs.derived.find((d) => d !== ev && /dr|resist/i.test(d.id + d.label));
      const numEl = (b, title) => { const n = h('span.num', { tabindex: '0' }, String(b?.value ?? '—')); if (b) explain(n, () => whyContent(b, { title })); return n; };
      const setHp = (v) => (p.sheet ? act({ t: 'track.set', playerId: p.id, track: hpDef.id, cur: v }) : act({ t: 'player.resource', playerId: p.id, res: hpDef.id, cur: v }));
      const n = hpDef?.kind === 'slots' ? (hpDef.slots || hp?.max || 10) : (hp?.max || 0);
      return h('li.cb-row',
        h('div.cb-who', avatar(M.sheet.identity?.name || p.name, { color: p.color, size: 28 }), h('b', M.sheet.identity?.name || p.name)),
        hp ? h('div.cb-hp',
          hpDef.kind === 'slots'
            ? h('div.slots.slots-sm', { style: { '--n': n } }, Array.from({ length: n }, (_, i) => h('button.slot', { type: 'button', class: i < hp.cur ? 'slot on' : 'slot', 'aria-label': `Set ${p.name} health to ${i + 1}`, onclick: () => setHp(i + 1 === hp.cur ? i : i + 1) })))
            : h('b', `${hp.cur} / ${hp.max}`),
          h('div.cb-dmg',
            h('button.btn.btn-sm', { type: 'button', onclick: () => setHp(Math.max(0, hp.cur - 1)), title: 'Damage 1' }, '−1'),
            h('button.btn.btn-sm', { type: 'button', onclick: () => setHp(Math.min(n, hp.cur + 1)), title: 'Heal 1' }, '+1'),
          ),
        ) : h('span.dim', '—'),
        h('div.cb-num', h('span.mini-l', ev?.label || 'Evade'), ev ? numEl(c.derived?.[ev.id], ev.label) : '—'),
        h('div.cb-num', h('span.mini-l', 'DR'), dr ? numEl(c.derived?.[dr.id], dr.label) : '—'),
        h('div.cb-buffs', (M.sheet.buffs || []).map((b) => h('span.mini-buff', b.name))),
      );
    }));
  }

  /* ---------- mobs ---------- */

  function addForm() {
    const name = h('input.inp', { placeholder: 'Goblin bruiser', 'aria-label': 'Name', required: true });
    const hp = h('input.inp', { type: 'number', value: 10, min: 1, 'aria-label': 'Health', inputmode: 'numeric' });
    const ev = h('input.inp', { type: 'number', value: 0, 'aria-label': 'Evade', inputmode: 'numeric' });
    const dr = h('input.inp', { type: 'number', value: 0, 'aria-label': 'DR', inputmode: 'numeric' });
    const count = h('input.inp', { type: 'number', value: 1, min: 1, max: 20, 'aria-label': 'How many', inputmode: 'numeric' });
    return h('form.mob-add', {
      onsubmit: (e) => {
        e.preventDefault();
        const nm = name.value.trim();
        if (!nm) { name.focus(); return; }
        const k = Math.max(1, Math.min(20, Number(count.value) || 1));
        for (let i = 0; i < k; i++) st.mobs.push({ id: mid(), name: k > 1 ? `${nm} ${i + 1}` : nm, hp: { cur: Number(hp.value) || 1, max: Number(hp.value) || 1 }, evade: Number(ev.value) || 0, dr: Number(dr.value) || 0, notes: '' });
        save();
        el.querySelector('.mob-add input')?.focus();
      },
    },
    h('label.lbl', h('span.lbl-t', 'Name'), name), h('label.lbl', h('span.lbl-t', 'Health'), hp), h('label.lbl', h('span.lbl-t', 'Evade'), ev), h('label.lbl', h('span.lbl-t', 'DR'), dr), h('label.lbl', h('span.lbl-t', 'Count'), count),
    h('button.btn.btn-primary', { type: 'submit' }, icon('plus', { size: 14 }), 'Add'));
  }

  function mobRows() {
    if (!st.mobs.length) return h('p.empty-s', 'No enemies yet. Add them above; they stay on this screen only.');
    return h('ul.mob-list', st.mobs.map((m, i) => {
      const pct = m.hp.max ? (m.hp.cur / m.hp.max) * 100 : 0;
      const dmg = h('input.inp.inp-sm', { type: 'number', placeholder: 'dmg', 'aria-label': `Damage to ${m.name}`, inputmode: 'numeric' });
      const hitIt = (sign) => { const v = Number(dmg.value) || 1; m.hp.cur = Math.max(0, Math.min(m.hp.max, m.hp.cur - sign * v)); dmg.value = ''; save(); };
      dmg.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); hitIt(1); } });
      return h('li.mob', { class: m.hp.cur <= 0 ? 'mob down' : 'mob' },
        h('div.mob-top',
          field(m.name, { cls: 'mob-name', attrs: { 'aria-label': 'Name' }, onCommit: (v) => { m.name = v; save(); } }),
          h('div.mob-hp', h('div.pool-bar', h('div.pool-fill', { style: { width: `${pct}%` } })), h('b', `${m.hp.cur} / ${m.hp.max}`)),
          h('div.mob-dmg', dmg, h('button.btn.btn-sm', { type: 'button', onclick: () => hitIt(1), title: 'Apply damage' }, 'Hit'), h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => hitIt(-1), title: 'Heal' }, 'Heal')),
          h('div.cb-num', h('span.mini-l', 'Evade'), field(m.evade, { type: 'number', cls: 'inp-sm num-in', attrs: { 'aria-label': 'Evade' }, onCommit: (v) => { m.evade = v; save(); } })),
          h('div.cb-num', h('span.mini-l', 'DR'), field(m.dr, { type: 'number', cls: 'inp-sm num-in', attrs: { 'aria-label': 'DR' }, onCommit: (v) => { m.dr = v; save(); } })),
          h('div.mob-act',
            h('button.icon-btn', { type: 'button', title: `Secret attack roll for ${m.name}`, 'aria-label': `Secret attack roll for ${m.name}`, onclick: () => act({ t: 'roll', what: { kind: 'custom', formula: `d20${m.atk ? `+${m.atk}` : ''}`, label: `${m.name} attack` }, secret: true }) }, icon('dice', { size: 16 })),
            h('button.icon-btn', { type: 'button', title: 'Duplicate', 'aria-label': `Duplicate ${m.name}`, onclick: () => { st.mobs.splice(i + 1, 0, { ...structuredClone(m), id: mid(), name: bump(m.name), hp: { cur: m.hp.max, max: m.hp.max } }); save(); } }, icon('copy', { size: 16 })),
            h('button.icon-btn', { type: 'button', title: 'Remove', 'aria-label': `Remove ${m.name}`, onclick: () => { st.mobs.splice(i, 1); save(); } }, icon('x', { size: 16 })),
          ),
        ),
        field(m.notes, { cls: 'inp-sm mob-notes', placeholder: 'Notes, conditions, what it does on its turn', attrs: { 'aria-label': 'Notes' }, onCommit: (v) => { m.notes = v; save(); } }),
      );
    }));
  }
  const bump = (n) => (/\d+$/.test(n) ? n.replace(/\d+$/, (d) => String(Number(d) + 1)) : `${n} 2`);

  function draw(force = false) {
    if (!view) return;
    const rsPhases = view.pack?.ruleset?.combat?.phases || null;
    if (!st) st = load(rsPhases || DEFAULT_PHASES);
    const s = JSON.stringify([view.gm?.playersFull?.map((p) => [p.id, p.name, p.sheet?.tracks, p.sheet?.buffs, p.sheet?.computed?.derived, p.resources]), st]);
    if (!force && s === sig) return;
    if (el.contains(document.activeElement) && document.activeElement.matches('input, textarea')) return;
    sig = s;
    el.replaceChildren(
      header(rsPhases),
      h('div.combat-cols',
        h('section.panel.cb-party', h('div.sec-head', h('h2', 'Crawlers'), h('span.dim', `Now: ${phases()[st.phase] || ''}`)), crawlerRows()),
        h('section.panel.cb-mobs', h('div.sec-head', h('h2', 'Enemies'), h('span.dim', `${st.mobs.filter((m) => m.hp.cur > 0).length} standing`)), addForm(), mobRows()),
      ),
    );
  }
  el.addEventListener('focusout', () => setTimeout(() => { if (!el.contains(document.activeElement)) draw(); }, 0));

  return { el, update(v) { view = v; draw(); } };
}

export { signed };
