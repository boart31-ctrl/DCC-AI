// GM library: browse pack + homebrew entries, edit homebrew with live formula validation,
// preview exactly what players see, give entries to crawlers, draft with Claude (hosted edition).
import { h, toast, rarityOf, ask } from './client.js';
import {
  libraryOf, normalizeRuleset, effectTargets, effectText, validateFormula, knownIdentifiers, WHEN, LIB_KINDS, RARITIES, slugId,
} from './rules.js';
import { icon, field, select, labeled, openDrawer, closeDrawer, signed } from './ui.js';
import { entryArt, imageRef } from './portrait.js';

const FIELDS = {
  item: ['rarity', 'slot', 'stackable', 'flavor', 'effects', 'attack'],
  spell: ['cost', 'costTrack', 'range', 'duration', 'dice', 'rankScaling', 'effects', 'attack', 'flavor'],
  skill: ['stat', 'checkType', 'upgrades'],
  buff: ['duration', 'external', 'effects'],
  feature: ['effects'],
  race: ['features', 'statBonuses', 'skills'],
  class: ['features', 'statBonuses', 'skills'],
  background: ['features', 'statBonuses', 'skills'],
  // scenes (TV): tactics + lootHint stay on the GM desk; the rest can reach the TV
  boss: ['title', 'floor', 'hpSlots', 'evade', 'dr', 'image', 'phases', 'intro', 'defeatLine', 'flavor', 'statAttacks', 'tactics', 'lootHint'],
  location: ['floor', 'image', 'readAloud', 'featureNotes', 'cast'],
  // bestiary: notes / tactics / lootHint / voice / hooks / secrets never leave the GM desk
  monster: ['title', 'floor', 'group', 'hpSlots', 'evade', 'dr', 'image', 'flavor', 'defeatLine', 'statAttacks', 'lootItems', 'notes', 'tactics', 'lootHint'],
  npc: ['role', 'floor', 'image', 'personality', 'voice', 'hooks', 'secrets'],
};
const GM_ONLY_HINT = 'GM only: never shown on the TV or phones';

function blank(kind, rs) {
  const e = { id: '', name: '', desc: '', tags: [], source: 'homebrew' };
  if (kind === 'item') Object.assign(e, { rarity: 'common', slot: null, stackable: false, flavor: '', effects: [] });
  if (kind === 'spell') Object.assign(e, { cost: 1, costTrack: rs.spells?.costTrack || rs.tracks[0]?.id || '', range: '', duration: '', dice: '', rankScaling: '', effects: [] });
  if (kind === 'skill') Object.assign(e, { stat: rs.stats[0]?.id || '', checkType: rs.skills.checkTypes[0] || 'Standard', upgrades: [] });
  if (kind === 'buff') Object.assign(e, { duration: '', external: false, effects: [] });
  if (kind === 'feature') Object.assign(e, { effects: [] });
  if (['race', 'class', 'background'].includes(kind)) Object.assign(e, { features: [], statBonuses: [], skills: [] });
  if (kind === 'boss') Object.assign(e, { title: '', floor: '', hpSlots: 10, image: null, phases: [], intro: '', defeatLine: '', flavor: '', tactics: '', lootHint: '' });
  if (kind === 'boss') Object.assign(e, { evade: 0, dr: 0, attacks: [] });
  if (kind === 'location') Object.assign(e, { floor: '', image: null, readAloud: '', features: [], npcs: [], monsters: [], bosses: [] });
  if (kind === 'monster') Object.assign(e, { title: '', floor: '', group: '', hpSlots: 5, evade: 0, dr: 0, image: null, attacks: [{ name: 'Claw', toHit: 2, damage: '1d4', effects: '', buffs: [] }], flavor: '', defeatLine: '', lootItems: [], notes: '', tactics: '', lootHint: '' });
  if (kind === 'npc') Object.assign(e, { role: '', floor: '', image: null, personality: '', voice: '', hooks: [], secrets: [] });
  return e;
}

export function createLibrary({ act, getView, aiDraft, hasAi }) {
  const st = { kind: 'all', source: 'all', tag: '', q: '', sel: null, draft: null, dirty: false };
  let view = null;
  let rs = null;
  let lib = null;
  let listSig = '';

  const search = h('input.inp', { type: 'search', placeholder: 'Search the library  ( / )', 'aria-label': 'Search the library', oninput: (e) => { st.q = e.target.value.trim().toLowerCase(); drawList(true); } });
  const kindSeg = h('div.lib-kinds', { role: 'tablist', 'aria-label': 'Kind' });
  const sourceSel = select([{ value: 'all', label: 'Pack and homebrew' }, { value: 'pack', label: 'Pack only' }, { value: 'homebrew', label: 'Homebrew only' }], 'all', { cls: 'inp-sm', label: 'Source', onChange: (v) => { st.source = v; drawList(true); } });
  const tagSel = h('select.inp.inp-sm', { 'aria-label': 'Tag', onchange: (e) => { st.tag = e.target.value; drawList(true); } });
  const newSel = select([{ value: '', label: 'New entry…' }, ...LIB_KINDS.map((k) => ({ value: k.id, label: `New ${k.label.toLowerCase()}` }))], '', { cls: 'inp-sm lib-new', label: 'Create', onChange: (v) => { if (v) { startNew(v); newSel.value = ''; } } });
  const count = h('span.dim');
  const list = h('ul.lib-list', { role: 'listbox', 'aria-label': 'Library entries' });
  const editor = h('div.lib-editor');
  const el = h('div.library',
    h('div.view-head', h('h1', 'Library'), count, h('span.grow'), newSel),
    kindSeg,
    h('div.lib-cols',
      h('div.lib-side', search, h('div.lib-filters', sourceSel, tagSel), list),
      editor,
    ),
  );

  /* ---------- list ---------- */

  function entries() {
    const out = [];
    for (const k of LIB_KINDS) for (const e of lib[k.id] || []) out.push({ kind: k.id, e });
    return out;
  }

  function drawKinds() {
    const counts = Object.fromEntries(LIB_KINDS.map((k) => [k.id, (lib[k.id] || []).length]));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    kindSeg.replaceChildren(
      ...[{ id: 'all', plural: 'All' }, ...LIB_KINDS].map((k) => h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(st.kind === k.id),
        onclick: () => { st.kind = k.id; drawKinds(); drawList(true); },
      }, k.plural, h('span.tab-n', String(k.id === 'all' ? total : counts[k.id])))),
    );
  }

  function drawList(force = false) {
    const all = entries();
    const tags = [...new Set(all.flatMap(({ e }) => e.tags || []))].sort();
    const sig = JSON.stringify([all.map(({ kind, e }) => [kind, e.id, e.name, e.source, e.tags]), st.kind, st.source, st.tag, st.q, st.sel]);
    if (!force && sig === listSig) return;
    listSig = sig;
    if (tagSel.dataset.sig !== tags.join('|')) {
      tagSel.replaceChildren(h('option', { value: '' }, 'Any tag'), ...tags.map((t) => h('option', { value: t }, t)));
      tagSel.dataset.sig = tags.join('|');
      tagSel.value = st.tag;
    }
    const hits = all.filter(({ kind, e }) => (st.kind === 'all' || st.kind === kind)
      && (st.source === 'all' || (e.source || 'pack') === st.source)
      && (!st.tag || (e.tags || []).includes(st.tag))
      && (!st.q || `${e.name} ${e.desc || ''} ${(e.tags || []).join(' ')}`.toLowerCase().includes(st.q)))
      .sort((a, b) => a.e.name.localeCompare(b.e.name));
    count.textContent = `${hits.length} of ${all.length}`;
    list.replaceChildren(...(hits.length ? hits.map(({ kind, e }) => {
      const on = st.sel && st.sel.kind === kind && st.sel.id === e.id;
      return h('li', h('button.lib-row', {
        type: 'button', role: 'option', 'aria-selected': String(!!on),
        onclick: () => select_(kind, e.id),
      },
      h('span.lr-n', e.name),
      h('span.lr-k', LIB_KINDS.find((k) => k.id === kind).label),
      e.rarity ? h('span.lr-r', { class: `lr-r rar-${rarityOf(e.rarity)}` }, e.rarity) : null,
      (e.source || 'pack') === 'homebrew' ? h('span.lr-hb', 'Homebrew') : null,
      ));
    }) : [h('li.empty-s', st.q ? 'Nothing matches. Try another word or kind.' : 'Nothing here yet. Create the first entry.')]));
  }

  /* ---------- selection ---------- */

  async function select_(kind, id) {
    if (st.dirty && !(await ask('Discard your unsaved changes?', { ok: 'Discard', danger: true }))) return;
    const e = lib[kind]?.find((x) => x.id === id);
    if (!e) return;
    st.sel = { kind, id };
    st.draft = structuredClone(e);
    st.dirty = false;
    drawList(true);
    drawEditor();
  }

  async function startNew(kind, seed = null) {
    if (st.dirty && !(await ask('Discard your unsaved changes?', { ok: 'Discard', danger: true }))) return;
    st.sel = { kind, id: null };
    st.draft = seed || blank(kind, rs);
    st.dirty = !!seed;
    drawList(true);
    drawEditor();
    editor.querySelector('input')?.focus();
  }

  function duplicate() {
    const { kind } = st.sel;
    const copy = structuredClone(st.draft);
    copy.id = '';
    copy.source = 'homebrew';
    copy.name = `${copy.name} (homebrew)`;
    startNew(kind, copy);
  }

  /* ---------- editor ---------- */

  const markDirty = () => { st.dirty = true; saveBtnState(); drawPreview(); };
  let saveBtn = null;
  let previewEl = null;
  const saveBtnState = () => { if (saveBtn) { saveBtn.disabled = !st.dirty || hasErrors(); saveBtn.textContent = st.sel?.id ? 'Save changes' : 'Create'; } };

  function hasErrors() {
    const d = st.draft;
    if (!d?.name?.trim()) return true;
    const known = knownIdentifiers(rs);
    const bad = (v) => typeof v === 'string' && v.trim() && !validateFormula(v, known).ok;
    if (bad(d.cost)) return true;
    for (const e of [...(d.effects || []), ...(d.statBonuses || [])]) if (bad(e.value)) return true;
    for (const dice of [d.dice, d.attack?.dice, ...(d.attacks || []).map((a) => a.damage)]) if (dice && !validateFormula(String(dice)).ok) return true;
    if ((d.attacks || []).some((a) => !String(a.name || '').trim())) return true;
    return false;
  }

  function drawEditor() {
    if (!st.sel || !st.draft) {
      editor.replaceChildren(h('div.lib-empty',
        h('p', h('b', 'Pick an entry to see it, or create one.')),
        h('p.dim', 'Pack entries are read-only. Duplicate one to make a homebrew version you can change.'),
        h('div.row-start', ...['item', 'spell', 'buff'].map((k) => h('button.btn.btn-sm', { type: 'button', onclick: () => startNew(k) }, icon('plus', { size: 14 }), `New ${k}`))),
      ));
      return;
    }
    const { kind } = st.sel;
    const d = st.draft;
    const ro = (d.source || 'pack') === 'pack' && !!st.sel.id;
    const set = (k) => (v) => { d[k] = v; markDirty(); };
    const meta = LIB_KINDS.find((k) => k.id === kind);

    const formRows = [
      labeled('Name', field(d.name, { disabled: ro, onCommit: (v) => { d.name = v; markDirty(); drawPreview(); } , attrs: { maxlength: 80 } }), { cls: 'span-2' }),
      labeled('Tags', field((d.tags || []).join(', '), { disabled: ro, placeholder: 'comma, separated', onCommit: (v) => { d.tags = v.split(',').map((x) => x.trim()).filter(Boolean); markDirty(); } })),
      labeled('Description', field(d.desc, { multiline: true, rows: 3, disabled: ro, onCommit: set('desc') }), { cls: 'span-all' }),
    ];
    const f = FIELDS[kind] || [];
    if (f.includes('rarity')) formRows.push(labeled('Rarity', select(RARITIES.map((r) => ({ value: r, label: r })), d.rarity || 'common', { disabled: ro, onChange: set('rarity') })));
    if (f.includes('slot')) formRows.push(labeled('Gear slot', select([{ value: '', label: 'None (carried)' }, ...rs.slots.map((s) => ({ value: s.id, label: s.label }))], d.slot || '', { disabled: ro, onChange: (v) => set('slot')(v || null) })));
    if (f.includes('stackable')) formRows.push(h('label.chk.lbl-chk', h('input', { type: 'checkbox', checked: !!d.stackable, disabled: ro, onchange: (e) => set('stackable')(e.target.checked) }), h('span', 'Stackable')));
    if (f.includes('cost')) formRows.push(formulaField('Cost', d.cost, ro, (v) => { d.cost = /^\s*-?\d+(\.\d+)?\s*$/.test(String(v)) ? Number(v) : v; markDirty(); }, 'Number or formula, e.g. max(1, 4 - mod.int)'));
    if (f.includes('costTrack')) formRows.push(labeled('Paid from', select(rs.tracks.map((t) => ({ value: t.id, label: t.label })), d.costTrack || '', { disabled: ro, onChange: set('costTrack') })));
    if (f.includes('range')) formRows.push(labeled('Range', field(d.range, { disabled: ro, onCommit: set('range') })));
    if (f.includes('duration')) formRows.push(labeled('Duration', field(d.duration, { disabled: ro, onCommit: set('duration') })));
    if (f.includes('dice')) formRows.push(diceInput('Dice', d.dice, ro, set('dice')));
    if (f.includes('rankScaling')) formRows.push(labeled('Rank scaling', field(d.rankScaling, { disabled: ro, onCommit: set('rankScaling'), placeholder: '+1 die per 3 ranks' }), { cls: 'span-2' }));
    if (f.includes('stat')) formRows.push(labeled('Stat', select(rs.stats.map((s) => ({ value: s.id, label: s.label })), d.stat, { disabled: ro, onChange: set('stat') })));
    if (f.includes('checkType')) formRows.push(labeled('Check type', select(rs.skills.checkTypes.map((x) => ({ value: x, label: x })), d.checkType, { disabled: ro, onChange: set('checkType') })));
    if (f.includes('external')) formRows.push(h('label.chk.lbl-chk', h('input', { type: 'checkbox', checked: !!d.external, disabled: ro, onchange: (e) => set('external')(e.target.checked) }), h('span', `External buff (counts toward the ${rs.buffSlots?.external?.max ?? '?'} cap)`)));
    if (f.includes('flavor')) formRows.push(labeled('Flavor text', field(d.flavor, { multiline: true, rows: 2, disabled: ro, onCommit: set('flavor'), placeholder: 'The line in italics players love to read aloud.' }), { cls: 'span-all' }));

    // Boss / location (TV scenes)
    const textRow = (k, label, o = {}) => formRows.push(labeled(label, field(d[k] ?? '', { disabled: ro, multiline: !!o.rows, rows: o.rows || 3, placeholder: o.ph || '', onCommit: set(k) }), { cls: o.cls || '', hint: o.hint }));
    if (f.includes('title')) textRow('title', 'Title / epithet', { cls: 'span-2' });
    if (f.includes('floor')) textRow('floor', 'Floor');
    if (f.includes('role')) textRow('role', 'Role (shown on the TV)', { cls: 'span-2', ph: 'Floor clerk, bartender, rival crawler' });
    if (f.includes('group')) textRow('group', 'Group', { ph: 'construct, vermin, undead' });
    if (f.includes('hpSlots')) formRows.push(labeled('HP slots', field(d.hpSlots ?? 10, { type: 'number', disabled: ro, attrs: { min: 1, max: 100 }, onCommit: (v) => set('hpSlots')(Math.max(1, Math.min(100, Math.round(v) || 10))) })));
    const numRow = (k, label) => formRows.push(labeled(label, field(d[k] ?? 0, { type: 'number', disabled: ro, attrs: { min: -99, max: 99 }, onCommit: (v) => set(k)(Math.max(-99, Math.min(99, Math.round(v) || 0))) })));
    if (f.includes('evade')) numRow('evade', 'Evade');
    if (f.includes('dr')) numRow('dr', 'DR');
    if (f.includes('image')) formRows.push(imageField(d, ro, kind));
    if (f.includes('phases')) {
      const src = (d.phases || []).map((p) => [p.name, p.text || '', p.atHp ?? ''].join(' | ').replace(/( \| )+$/, '')).join('\n');
      formRows.push(labeled('Phases', field(src, { multiline: true, rows: 3, disabled: ro, placeholder: 'Name | text | at HP, one per line', onCommit: (v) => set('phases')(String(v).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [name, text = '', at = ''] = l.split('|').map((x) => x.trim()); return { name, text, ...( /^\d+$/.test(at) ? { atHp: Number(at) } : {}) }; })) }), { cls: 'span-all', hint: 'At HP: the desk suggests the phase when the boss drops to it.' }));
    }
    if (f.includes('intro')) textRow('intro', 'Intro announcement (TV + System voice)', { rows: 2, cls: 'span-all' });
    if (f.includes('defeatLine')) textRow('defeatLine', 'Defeat line (TV + System voice)', { rows: 2, cls: 'span-all' });
    if (f.includes('tactics')) textRow('tactics', 'Tactics (GM only)', { rows: 3, cls: 'span-all', hint: GM_ONLY_HINT });
    if (f.includes('lootHint')) textRow('lootHint', 'Loot hint (GM only)', { cls: 'span-all', hint: GM_ONLY_HINT });
    if (f.includes('readAloud')) textRow('readAloud', 'Read-aloud (shown on the TV)', { rows: 4, cls: 'span-all' });
    if (f.includes('featureNotes')) formRows.push(labeled('Features (GM only), one per line', field((d.features || []).join('\n'), { multiline: true, rows: 3, disabled: ro, onCommit: (v) => set('features')(String(v).split('\n').map((x) => x.trim()).filter(Boolean)) }), { cls: 'span-all' }));
    const linesRow = (k, label, o = {}) => formRows.push(labeled(label, field((d[k] || []).join('\n'), { multiline: true, rows: o.rows || 3, disabled: ro, placeholder: o.ph || '', onCommit: (v) => set(k)(String(v).split('\n').map((x) => x.trim()).filter(Boolean)) }), { cls: 'span-all', hint: o.hint }));
    if (f.includes('personality')) textRow('personality', 'Personality', { rows: 3, cls: 'span-all', ph: 'What they are like in two sentences.' });
    if (f.includes('voice')) textRow('voice', 'Voice tips (GM only)', { rows: 2, cls: 'span-all', ph: 'Accent, tempo, a catchphrase, a prop', hint: GM_ONLY_HINT });
    if (f.includes('hooks')) linesRow('hooks', 'Hooks (GM only), one per line', { hint: GM_ONLY_HINT });
    if (f.includes('secrets')) linesRow('secrets', 'Secrets (GM only), one per line', { hint: GM_ONLY_HINT });
    if (f.includes('notes')) textRow('notes', 'Notes (GM only)', { rows: 2, cls: 'span-all', hint: GM_ONLY_HINT });
    if (f.includes('lootItems')) {
      const items = lib.item || [];
      const names = (ids) => ids.map((id) => items.find((i) => i.id === id)?.name || `${id} (unknown)`).join(', ');
      const hint = h('span.lbl-hint', (d.lootItems || []).length ? names(d.lootItems) : 'Item ids, comma separated');
      const inp = field((d.lootItems || []).join(', '), { disabled: ro, cls: 'mono-in', attrs: { list: 'lib-item-ids', spellcheck: 'false' }, placeholder: 'ten_coins, wet_wipes', onCommit: (v) => { d.lootItems = String(v).split(',').map((x) => x.trim()).filter(Boolean); hint.textContent = d.lootItems.length ? names(d.lootItems) : 'Item ids, comma separated'; markDirty(); } });
      formRows.push(h('label.lbl.span-all', h('span.lbl-t', 'Drops (item ids)'), inp, hint, h('datalist', { id: 'lib-item-ids' }, items.slice(0, 400).map((i) => h('option', { value: i.id }, i.name)))));
    }

    const sections = [h('div.form-grid', formRows)];
    if (f.includes('effects')) sections.push(effectsEditor('Effects', d.effects || (d.effects = []), ro, kind === 'item' ? 'equipped' : kind === 'spell' || kind === 'buff' ? 'active' : 'always'));
    if (f.includes('statBonuses')) sections.push(effectsEditor('Stat bonuses', d.statBonuses || (d.statBonuses = []), ro, 'always'));
    if (f.includes('attack')) sections.push(attackEditor(d, ro));
    if (f.includes('upgrades')) sections.push(upgradesEditor(d, ro));
    if (f.includes('statAttacks')) sections.push(statAttacksEditor(d, ro));
    if (f.includes('cast')) {
      sections.push(checkList('Monsters here', lib.monster || [], d.monsters || (d.monsters = []), ro));
      sections.push(checkList('Bosses here', lib.boss || [], d.bosses || (d.bosses = []), ro));
      sections.push(checkList('NPCs here', lib.npc || [], d.npcs || (d.npcs = []), ro));
    }
    if (f.includes('features')) sections.push(checkList('Features', lib.feature, d.features || (d.features = []), ro));
    if (f.includes('skills')) sections.push(checkList('Starting skills', lib.skill.length ? lib.skill : rs.skills.catalog, d.skills || (d.skills = []), ro));

    saveBtn = h('button.btn.btn-primary', { type: 'button', onclick: save });
    saveBtnState();
    const actions = [];
    if (ro) actions.push(h('button.btn.btn-primary', { type: 'button', onclick: duplicate }, icon('copyPlus', { size: 15 }), 'Duplicate and edit'));
    else actions.push(saveBtn);
    if (st.sel.id && ['item', 'spell', 'skill', 'buff'].includes(kind)) actions.unshift(h('button.btn', { type: 'button', disabled: st.dirty, title: st.dirty ? 'Save first' : null, onclick: () => giveTo(kind, d) }, icon('gift', { size: 15 }), 'Give to…'));
    if (st.sel.id && !ro) actions.unshift(h('button.btn.btn-quiet.danger', { type: 'button', onclick: remove }, icon('trash', { size: 15 }), 'Delete'));
    if (!ro && st.dirty && st.sel.id) actions.unshift(h('button.btn.btn-quiet', { type: 'button', onclick: () => { st.dirty = false; select_(kind, st.sel.id); } }, 'Revert'));

    previewEl = h('div.lib-preview');
    editor.replaceChildren(...[
      h('header.ed-head',
        h('div.ed-titles', h('h2', d.name || `New ${meta.label.toLowerCase()}`), h('p.dim', `${meta.label}, ${ro ? 'from the pack (read-only)' : st.sel.id ? 'homebrew' : 'not saved yet'}${d.id ? `, id ${d.id}` : ''}`)),
        h('div.ed-act', actions),
      ),
      !ro && hasAi() ? aiBar(kind, d) : null,
      h('div.ed-cols',
        h('div.ed-form', { class: ro ? 'ed-form ro' : 'ed-form' }, sections),
        h('aside.ed-side', h('h3.sub-t', ['monster', 'npc', 'boss', 'location'].includes(kind) ? 'Card' : 'As players see it'), previewEl),
      ),
    ].filter(Boolean));
    drawPreview();
  }

  function formulaField(label, value, ro, onCommit, hint) {
    const known = knownIdentifiers(rs);
    const msg = h('span.lbl-hint', hint || '');
    const inp = field(value ?? '', { disabled: ro, cls: 'mono-in', attrs: { spellcheck: 'false' }, onCommit });
    const check = () => {
      const v = inp.value.trim();
      if (!v) { msg.textContent = hint || ''; msg.className = 'lbl-hint'; inp.classList.remove('bad'); return; }
      const r = validateFormula(v, known);
      inp.classList.toggle('bad', !r.ok);
      msg.className = r.ok && !r.unknown.length ? 'lbl-hint' : 'lbl-hint bad';
      msg.textContent = !r.ok ? r.error : r.unknown.length ? `Unknown: ${r.unknown.join(', ')} (counts as 0)` : (hint || 'Looks good.');
    };
    inp.addEventListener('input', () => { check(); });
    check();
    return h('label.lbl', h('span.lbl-t', label), inp, msg);
  }

  function diceInput(label, value, ro, onCommit) {
    const msg = h('span.lbl-hint', '1d6, 2d4+1');
    const inp = field(value ?? '', { disabled: ro, cls: 'mono-in', attrs: { spellcheck: 'false' }, onCommit });
    inp.addEventListener('input', () => {
      const r = inp.value.trim() ? validateFormula(inp.value) : { ok: true };
      inp.classList.toggle('bad', !r.ok);
      msg.className = r.ok ? 'lbl-hint' : 'lbl-hint bad';
      msg.textContent = r.ok ? '1d6, 2d4+1' : r.error;
    });
    return h('label.lbl', h('span.lbl-t', label), inp, msg);
  }

  function effectsEditor(title, effs, ro, defWhen) {
    const known = knownIdentifiers(rs);
    const targets = effectTargets(rs);
    const rowsEl = h('div.fx-rows');
    const draw = () => {
      rowsEl.replaceChildren(...(effs.length ? effs.map((e, i) => {
        const msg = h('span.fx-msg');
        const val = h('input.inp.mono-in', { value: e.value ?? 0, disabled: ro, 'aria-label': 'Value or formula', spellcheck: 'false' });
        const check = () => {
          const v = val.value.trim();
          const r = /^-?\d+(\.\d+)?$/.test(v) ? { ok: true, unknown: [] } : validateFormula(v, known);
          val.classList.toggle('bad', !r.ok || !v);
          msg.textContent = !v ? 'Needs a value' : !r.ok ? r.error : r.unknown.length ? `Unknown: ${r.unknown.join(', ')}` : '';
          msg.classList.toggle('bad', !r.ok || !v || r.unknown.length > 0);
        };
        val.addEventListener('input', check);
        val.addEventListener('change', () => { const v = val.value.trim(); e.value = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v; markDirty(); });
        check();
        const knownTarget = targets.some((g) => g.options.some((o) => o.value === e.target));
        const tSel = select(knownTarget ? targets : [...targets, { label: 'Other', options: [{ value: e.target, label: e.target }] }], e.target, { disabled: ro, label: 'Target', onChange: (v) => { e.target = v; markDirty(); } });
        return h('div.fx-row',
          tSel,
          select([{ value: 'add', label: 'adds' }, { value: 'set', label: 'sets to' }], e.op || 'add', { disabled: ro, label: 'Operation', onChange: (v) => { e.op = v; markDirty(); } }),
          val,
          select(WHEN, e.when || defWhen, { disabled: ro, label: 'When', onChange: (v) => { e.when = v; markDirty(); } }),
          ro ? h('span') : h('button.icon-btn', { type: 'button', 'aria-label': 'Remove effect', onclick: () => { effs.splice(i, 1); markDirty(); draw(); } }, icon('x', { size: 15 })),
          msg,
        );
      }) : [h('p.empty-s', 'No effects. This changes no numbers on the sheet.')]));
    };
    draw();
    return h('section.ed-sec',
      h('div.sec-head', h('h3.sub-t', title), h('span.dim', 'Target, then how much. Negative values are debuffs.')),
      h('div.fx-head', h('span', 'Target'), h('span', 'Op'), h('span', 'Value or formula'), h('span', 'When'), h('span', '')),
      rowsEl,
      ro ? null : h('button.btn.btn-sm', { type: 'button', onclick: () => { effs.push({ target: rs.derived[0]?.id || `stat.${rs.stats[0]?.id}`, op: 'add', value: 1, when: defWhen }); markDirty(); draw(); } }, icon('plus', { size: 14 }), 'Add effect'),
    );
  }

  function attackEditor(d, ro) {
    const on = !!d.attack;
    const body = h('div.form-grid');
    const draw = () => {
      if (!d.attack) { body.replaceChildren(); return; }
      const a = d.attack;
      const skills = (lib.skill.length ? lib.skill : rs.skills.catalog);
      body.replaceChildren(
        labeled('Skill', select([{ value: '', label: 'None' }, ...skills.map((s) => ({ value: s.id, label: s.name }))], a.skill || '', { disabled: ro, onChange: (v) => { a.skill = v; markDirty(); } })),
        labeled('Stat', select(rs.stats.map((s) => ({ value: s.id, label: s.label })), a.stat || rs.stats[0]?.id, { disabled: ro, onChange: (v) => { a.stat = v; markDirty(); } })),
        diceInput('Damage dice', a.dice, ro, (v) => { a.dice = v; markDirty(); }),
        labeled('On hit', field(a.effects, { disabled: ro, placeholder: 'Knockback 1, sets on fire…', onCommit: (v) => { a.effects = v; markDirty(); } }), { cls: 'span-all' }),
      );
    };
    draw();
    return h('section.ed-sec',
      h('div.sec-head', h('h3.sub-t', 'Attack'), h('label.chk', h('input', { type: 'checkbox', checked: on, disabled: ro, onchange: (e) => { d.attack = e.target.checked ? { skill: '', stat: rs.stats[0]?.id, dice: '1d6', effects: '' } : undefined; if (!e.target.checked) delete d.attack; markDirty(); draw(); } }), h('span', 'Can be used to attack'))),
      body,
    );
  }

  /** Image id ("goblin.webp" in the pack's images/) or URL, with a live preview and the generated fallback. */
  function imageField(d, ro, kind) {
    const box = h('div.img-pv');
    const msg = h('span.lbl-hint');
    const draw = () => {
      box.replaceChildren(entryArt({ name: d.name || '?', image: d.image, color: d.color }, { cls: 'img-pv-art' }));
      const img = box.querySelector('img');
      msg.textContent = !d.image ? 'No art yet: the TV draws a silhouette.' : 'Checking…';
      msg.className = 'lbl-hint';
      if (img) {
        img.addEventListener('load', () => { msg.textContent = 'Found.'; });
        img.addEventListener('error', () => { msg.textContent = 'Not found: the TV draws a silhouette.'; msg.className = 'lbl-hint bad'; });
      }
    };
    const inp = field(d.image || '', {
      disabled: ro, cls: 'mono-in', attrs: { spellcheck: 'false' }, placeholder: `${kind === 'npc' ? 'quill' : 'goblin'}.webp, /pack/images/… or https://…`,
      onCommit: (v) => { d.image = imageRef(v); inp.value = d.image || ''; markDirty(); draw(); },
    });
    draw();
    return h('div.lbl.span-all.img-field', h('span.lbl-t', 'Image'), h('div.img-row', box, h('div.img-in', inp, msg)));
  }

  /** Stat-block attacks (monsters, bosses): name, to hit, damage dice, effects, conditions it applies. */
  function statAttacksEditor(d, ro) {
    d.attacks ||= [];
    const buffs = lib.buff || [];
    const rows = h('div.sa-rows');
    const draw = () => rows.replaceChildren(...(d.attacks.length ? d.attacks.map((a, i) => {
      a.buffs ||= [];
      const dmgMsg = h('span.fx-msg');
      const dmg = field(a.damage ?? '', { disabled: ro, cls: 'mono-in', attrs: { 'aria-label': 'Damage dice', spellcheck: 'false' }, placeholder: '1d6+1', onCommit: (v) => { a.damage = String(v).trim(); markDirty(); } });
      const check = () => {
        const v = dmg.value.trim();
        const r = v ? validateFormula(v) : { ok: true };
        dmg.classList.toggle('bad', !r.ok);
        dmgMsg.textContent = r.ok ? '' : r.error;
        dmgMsg.classList.toggle('bad', !r.ok);
      };
      dmg.addEventListener('input', check);
      check();
      const chips = h('div.sa-buffs', a.buffs.map((id) => h('span.cond', buffs.find((b) => b.id === id)?.name || id,
        ro ? null : h('button.cond-x', { type: 'button', 'aria-label': `Remove ${id}`, onclick: () => { a.buffs = a.buffs.filter((x) => x !== id); markDirty(); draw(); } }, icon('x', { size: 11 })))));
      const addBuff = ro || !buffs.length ? null : select([{ value: '', label: '+ condition' }, ...buffs.filter((b) => !a.buffs.includes(b.id)).map((b) => ({ value: b.id, label: b.name }))], '', { cls: 'inp-sm', label: 'Add condition', onChange: (v) => { if (v) { a.buffs.push(v); markDirty(); draw(); } } });
      return h('div.sa-row',
        h('div.sa-top',
          field(a.name ?? '', { disabled: ro, attrs: { 'aria-label': 'Attack name', maxlength: 60 }, placeholder: 'Bite', onCommit: (v) => { a.name = v; markDirty(); } }),
          h('label.sa-hit', h('span.mini-l', 'To hit'), field(a.toHit ?? 0, { type: 'number', disabled: ro, attrs: { min: -99, max: 99, 'aria-label': 'To hit' }, onCommit: (v) => { a.toHit = Math.max(-99, Math.min(99, Math.round(v) || 0)); markDirty(); } })),
          h('label.sa-dmg', h('span.mini-l', 'Damage'), dmg),
          ro ? h('span') : h('div.sa-ord',
            h('button.icon-btn', { type: 'button', 'aria-label': 'Move up', disabled: i === 0, onclick: () => { d.attacks.splice(i - 1, 0, d.attacks.splice(i, 1)[0]); markDirty(); draw(); } }, icon('chevron', { size: 14 })),
            h('button.icon-btn', { type: 'button', 'aria-label': 'Remove attack', onclick: () => { d.attacks.splice(i, 1); markDirty(); draw(); } }, icon('x', { size: 15 })))),
        field(a.effects ?? '', { disabled: ro, cls: 'inp-sm', attrs: { 'aria-label': 'Effects', maxlength: 400 }, placeholder: 'On hit: knocked Prone (DEX 12 to resist)', onCommit: (v) => { a.effects = v; markDirty(); } }),
        h('div.sa-foot', chips, addBuff, dmgMsg),
      );
    }) : [h('p.empty-s', 'No attacks. The combat tracker can still track its HP.')]));
    draw();
    return h('section.ed-sec',
      h('div.sec-head', h('h3.sub-t', 'Attacks'), h('span.dim', 'The combat desk rolls d20 + to hit, then the damage dice.')),
      rows,
      ro ? null : h('button.btn.btn-sm', { type: 'button', onclick: () => { d.attacks.push({ name: '', toHit: 0, damage: '1d4', effects: '', buffs: [] }); markDirty(); draw(); rows.lastElementChild?.querySelector('input')?.focus(); } }, icon('plus', { size: 14 }), 'Add attack'));
  }

  function upgradesEditor(d, ro) {
    d.upgrades ||= [];
    const rows = h('div.up-rows');
    const draw = () => rows.replaceChildren(...d.upgrades.map((u, i) => h('div.up-row',
      field(u.rank, { type: 'number', disabled: ro, attrs: { min: 1, max: rs.skills.rankMax, 'aria-label': 'Rank' }, onCommit: (v) => { u.rank = v; markDirty(); } }),
      field(u.text, { disabled: ro, attrs: { 'aria-label': 'What it unlocks' }, onCommit: (v) => { u.text = v; markDirty(); } }),
      ro ? h('span') : h('button.icon-btn', { type: 'button', 'aria-label': 'Remove', onclick: () => { d.upgrades.splice(i, 1); markDirty(); draw(); } }, icon('x', { size: 15 })),
    )));
    draw();
    return h('section.ed-sec', h('div.sec-head', h('h3.sub-t', 'Upgrades by rank')), rows,
      ro ? null : h('button.btn.btn-sm', { type: 'button', onclick: () => { d.upgrades.push({ rank: (d.upgrades.at(-1)?.rank || 0) + 5, text: '' }); markDirty(); draw(); } }, icon('plus', { size: 14 }), 'Add upgrade'));
  }

  function checkList(title, options, chosen, ro) {
    return h('section.ed-sec', h('div.sec-head', h('h3.sub-t', title)),
      options.length ? h('div.chk-grid', options.map((o) => h('label.chk', h('input', { type: 'checkbox', checked: chosen.includes(o.id), disabled: ro, onchange: (e) => { const i = chosen.indexOf(o.id); if (e.target.checked && i < 0) chosen.push(o.id); if (!e.target.checked && i >= 0) chosen.splice(i, 1); markDirty(); } }), h('span', o.name))))
        : h('p.empty-s', `No ${title.toLowerCase()} in the library yet.`));
  }

  /* ---------- preview (same pieces as the player's item / spell drawer) ---------- */

  function drawPreview() {
    if (!previewEl || !st.draft) return;
    const d = st.draft;
    const kind = st.sel.kind;
    if (['monster', 'npc', 'boss', 'location'].includes(kind)) { previewEl.replaceChildren(tvCard(kind, d)); return; }
    const r = rarityOf(d.rarity);
    const slot = rs.slots.find((s) => s.id === d.slot);
    const kv = [];
    if (kind === 'spell') kv.push(['Cost', `${d.cost ?? 0}${rs.tracks.find((t) => t.id === d.costTrack) ? ` ${rs.tracks.find((t) => t.id === d.costTrack).label.toLowerCase()}` : ''}`], ['Range', d.range], ['Duration', d.duration], ['Dice', d.dice], ['Scaling', d.rankScaling]);
    if (kind === 'skill') kv.push(['Stat', rs.stats.find((s) => s.id === d.stat)?.label], ['Check', d.checkType]);
    if (kind === 'buff') kv.push(['Lasts', d.duration], ['Type', d.external ? 'External buff' : 'Buff']);
    const effs = [...(d.effects || []), ...(d.statBonuses || [])];
    previewEl.replaceChildren(h('div.preview-card',
      h('div.pv-head', h('b.pv-name', { class: kind === 'item' ? `pv-name r-${r}` : 'pv-name' }, d.name || 'Unnamed'),
        h('span.dim', kind === 'item' ? `${r} item` : LIB_KINDS.find((k) => k.id === kind).label)),
      kind === 'item' ? h('div.item-tags', h('span.pill', { class: `pill rar-${r}` }, r), h('span.pill', slot ? slot.label : 'No slot'), d.stackable ? h('span.pill', 'Stacks') : null, (d.tags || []).map((t) => h('span.pill.pill-tag', t))) : null,
      kv.filter(([, v]) => v != null && v !== '').length ? h('dl.kv', kv.filter(([, v]) => v != null && v !== '').map(([k, v]) => h('div', h('dt', k), h('dd', String(v))))) : null,
      d.desc ? h('p.desc', d.desc) : h('p.desc.dim', 'No description yet.'),
      d.flavor ? h('p.flavor-t', d.flavor) : null,
      effs.length ? h('div', h('h3.sub-t', 'Effects'), h('ul.eff-list', effs.map((e) => h('li', effectText(rs, e), h('span.eff-when', ` ${e.when || ''}`))))) : null,
      d.attack ? h('div', h('h3.sub-t', 'Attack'), h('p.desc', `${(lib.skill.find((s) => s.id === d.attack.skill) || rs.skills.catalog.find((s) => s.id === d.attack.skill))?.name || 'No skill'} + ${rs.stats.find((s) => s.id === d.attack.stat)?.abbr || ''}, ${d.attack.dice || '—'} damage${d.attack.effects ? `. ${d.attack.effects}` : ''}`)) : null,
      d.upgrades?.length ? h('div', h('h3.sub-t', 'Upgrades'), h('ul.upgrades', d.upgrades.map((u) => h('li.got', h('b', `Rank ${u.rank}`), u.text)))) : null,
    ));
  }

  /** What the TV can show of a bestiary entry (GM-only fields are listed separately, locked). */
  function tvCard(kind, d) {
    const gmOnly = [];
    if (d.tactics) gmOnly.push(['Tactics', d.tactics]);
    if (d.notes) gmOnly.push(['Notes', d.notes]);
    if (d.lootHint) gmOnly.push(['Loot', d.lootHint]);
    if (d.voice) gmOnly.push(['Voice', d.voice]);
    for (const x of d.hooks || []) gmOnly.push(['Hook', x]);
    for (const x of d.secrets || []) gmOnly.push(['Secret', x]);
    for (const x of kind === 'location' ? d.features || [] : []) gmOnly.push(['Feature', x]);
    const sub = kind === 'npc' ? d.role : kind === 'location' ? (d.floor !== '' && d.floor != null ? `Floor ${d.floor}` : '') : d.title;
    const stats = kind === 'monster' || kind === 'boss'
      ? h('div.tvc-stats', h('span', h('b', String(d.hpSlots ?? '')), ' HP'), h('span', h('b', String(d.evade ?? 0)), ' Evade'), h('span', h('b', String(d.dr ?? 0)), ' DR'))
      : null;
    return h('div.tv-card', { class: `tv-card k-${kind}` },
      entryArt({ name: d.name || '?', image: d.image, color: d.color }, { cls: 'tvc-art' }),
      h('div.tvc-body',
        h('span.tvc-k', kind === 'npc' ? 'On the TV: NPC card' : kind === 'location' ? 'On the TV: Explore' : 'On the TV: arena'),
        h('b.tvc-name', d.name || 'Unnamed'),
        sub ? h('span.tvc-sub', sub) : null,
        stats,
        kind === 'location' && d.readAloud ? h('p.tvc-text', d.readAloud) : null,
        kind === 'npc' && d.personality ? h('p.tvc-text.dim', h('i', 'Personality (desk only): '), d.personality) : null,
        (kind === 'monster' || kind === 'boss') && (d.attacks || []).length ? h('ul.tvc-atk', d.attacks.map((a) => h('li', h('b', a.name || '—'), ` ${signed(a.toHit ?? 0)} to hit, ${a.damage || 'no'} damage`))) : null,
      ),
      gmOnly.length ? h('div.sc-gm-only.tvc-gm', h('p.sc-gm-k', icon('lock', { size: 12 }), 'GM only'), h('ul', gmOnly.map(([k, v]) => h('li', h('b', `${k}. `), v)))) : null,
    );
  }

  /* ---------- AI draft (hosted) ---------- */

  function aiBar(kind, d) {
    const inp = h('input.inp', { placeholder: `Describe the ${LIB_KINDS.find((k) => k.id === kind).label.toLowerCase()} in one line, e.g. "boots that make you louder but faster"`, maxlength: 300, 'aria-label': 'Describe it for Claude' });
    const status = h('span.lbl-hint');
    const go = h('button.btn', { type: 'button', onclick: async () => {
      const prompt = inp.value.trim() || d.name;
      if (!prompt) { inp.focus(); return; }
      go.disabled = true;
      status.textContent = 'Drafting. Takes a few seconds.';
      try {
        const r = await aiDraft({ kind, prompt, draft: d, ruleset: rs, targets: effectTargets(rs) });
        if (r) {
          for (const k of ['name', 'desc', 'flavor', 'rarity', 'slot', 'cost', 'range', 'duration', 'dice', 'stat', 'checkType', 'tags']) if (r[k] != null && r[k] !== '') d[k] = r[k];
          if (Array.isArray(r.effects)) d.effects = r.effects.filter((e) => e && e.target).map((e) => ({ target: String(e.target), op: e.op === 'set' ? 'set' : 'add', value: e.value ?? 0, when: e.when || 'equipped' }));
          if (r.attack && typeof r.attack === 'object') d.attack = r.attack;
          st.dirty = true;
          drawEditor();
          toast('Draft ready. Check it, then save.');
        }
      } catch (err) {
        status.textContent = err?.userMessage || err?.message || 'Claude could not draft it.';
      } finally { go.disabled = false; }
    } }, icon('sparkle', { size: 15 }), 'Draft with Claude');
    return h('div.ai-bar', inp, go, status);
  }

  /* ---------- save / remove / give ---------- */

  async function save() {
    if (hasErrors()) { toast('Fix the fields marked in red first.', { error: true }); return; }
    const { kind } = st.sel;
    const d = structuredClone(st.draft);
    if (!d.id) d.id = slugId(d.name, (lib[kind] || []).map((x) => x.id));
    d.source = 'homebrew';
    d.kind = kind;
    const r = await act({ t: 'lib.upsert', kind, entry: d }, `${d.name} saved.`);
    if (!r) return;
    st.sel = { kind, id: r?.result?.id || d.id };
    st.draft = d;
    st.dirty = false;
    drawList(true);
    drawEditor();
  }

  async function remove() {
    const { kind, id } = st.sel;
    if (!(await ask(`Delete ${st.draft.name} from the library? Crawlers who carry it keep their copy.`, { ok: 'Delete', danger: true }))) return;
    if (await act({ t: 'lib.remove', kind, id }, 'Deleted.')) { st.sel = null; st.draft = null; st.dirty = false; drawList(true); drawEditor(); }
  }

  function giveTo(kind, d) {
    const players = view.players || [];
    openDrawer({
      title: `Give ${d.name}`,
      sub: 'Pick a crawler. It lands on their sheet right away.',
      body: players.length ? h('ul.pick-list', players.map((p) => h('li', h('button.pick', {
        type: 'button',
        onclick: async () => { if (await act({ t: 'lib.give', playerId: p.id, kind, id: d.id }, `Gave ${d.name} to ${p.name}.`)) closeDrawer(); },
      }, h('span', h('b', p.name)), h('span.dim', p.connected ? 'online' : 'offline'))))) : h('p.empty-s', 'No crawlers yet.'),
    });
  }

  return {
    el,
    update(v) {
      view = v;
      rs = normalizeRuleset(v.pack);
      lib = libraryOf(v);
      drawKinds();
      drawList();
      // Refresh the editor if the saved entry changed under us and nothing is being edited.
      if (st.sel?.id && !st.dirty) {
        const e = lib[st.sel.kind]?.find((x) => x.id === st.sel.id);
        if (e && JSON.stringify(e) !== JSON.stringify(st.draft)) { st.draft = structuredClone(e); drawEditor(); }
        if (!e) { st.sel = null; st.draft = null; drawEditor(); }
      } else if (!st.sel && !editor.firstChild) drawEditor();
    },
    focusSearch() { setTimeout(() => { search.focus(); search.select(); }, 0); },
    open(kind, id) { select_(kind, id); },
  };
}

export { signed };
