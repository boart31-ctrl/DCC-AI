// The same tools panel mounts in the desktop column and the narrower Prep drawer.
import { h } from './client.js';
import { icon } from './ui.js';
import { libraryOf } from './rules.js';
import { checkDC, checkDCPresets } from './check-dc.js';

const input = (label, attrs = {}) => h('input.inp.inp-sm', { 'aria-label': label, ...attrs });
const toolSection = (name, ...nodes) => h('section.et-section', h('h3', name), ...nodes);

function calculator(view) {
  const ruleset = view.pack.ruleset;
  const floor = view.combat?.dangerFloor ?? 1;
  const family = ruleset.system?.family ?? 'crawler';
  const table = checkDCPresets(ruleset);
  const modes = family === 'crawler'
    ? [['stat', 'Stat'], ['unopposed', 'Unopposed'], ['opposed', 'Vs mob'], ['fixed', 'Fixed']]
    : [...table.map((preset) => [String(preset.dc), preset.label]), ['fixed', 'Fixed']];
  const mode = h('select.inp.inp-sm', { 'aria-label': 'DC type' }, modes.map(([value, label]) => h('option', { value }, label)));
  if (family === 'dnd') mode.value = '15';
  if (family === 'pf2e') {
    const party = view.combat?.dangerParty ?? [];
    const level = Math.round(party.reduce((sum, p) => sum + p.level, 0) / (party.length || 1));
    mode.value = String((table.find((p) => p.label === 'Level ' + level) || table[1]).dc);
  }
  const mod = input('Mob modifier', { type: 'number', min: -99, max: 99, value: 0 });
  const fixed = input('Fixed DC', { type: 'number', min: 0, max: 99, value: 15 });
  const adjustment = h('select.inp.inp-sm', { 'aria-label': 'Difficulty adjustment' },
    h('option', { value: 0 }, 'Normal'), h('option', { value: -5 }, 'Easier (−5)'), h('option', { value: 5 }, 'Harder (+5)'));
  const result = h('output.et-dc', { 'aria-label': 'Calculated DC' });
  const recalc = () => {
    mod.hidden = mode.value !== 'opposed';
    fixed.hidden = mode.value !== 'fixed';
    const dc = checkDC({
      dcType: mode.value, mod: mod.valueAsNumber,
      dc: family !== 'crawler' && mode.value !== 'fixed' ? Number(mode.value) : fixed.valueAsNumber,
    }, ruleset, { floor, adjustment: Number(adjustment.value) });
    result.textContent = dc == null ? 'DC —' : 'DC ' + dc;
  };
  for (const node of [mode, mod, fixed, adjustment]) node.addEventListener('input', recalc);
  recalc();
  return toolSection('DC calculator', h('div.et-row', mode, result), h('div.et-row', mod, fixed, adjustment),
    family === 'crawler' ? h('small.dim', 'Floor ' + floor) : null);
}

function mobSearch(lib, addMob) {
  const rows = ['monster', 'boss'].flatMap((kind) => (lib[kind] ?? []).map((entry) => ({ kind, entry })));
  const search = input('Search mobs to add', { type: 'search', placeholder: 'Find a mob…' });
  const list = h('div.et-results');
  const render = () => {
    const query = search.value.trim().toLocaleLowerCase();
    const matches = rows.filter(({ entry }) => entry.name.toLocaleLowerCase().includes(query));
    list.replaceChildren(...matches.slice(0, 20).map(({ kind, entry }) => {
      const ref = { kind, id: entry.id };
      return h('button.et-mob', { type: 'button', draggable: true, title: 'Add ' + entry.name + ' to this encounter',
        onclick: () => addMob(ref), ondragstart: (e) => {
          e.dataTransfer.setData('application/x-evening-mob', JSON.stringify(ref));
          e.dataTransfer.effectAllowed = 'copy';
        } }, h('span', entry.name), h('small.dim', kind === 'boss' ? 'Boss' : entry.role || 'Mob'), icon('plus', { size: 13 }));
    }));
    if (!matches.length) list.append(h('small.dim', 'No matching mobs.'));
  };
  search.addEventListener('input', render);
  render();
  return toolSection('Encounter search', search, list);
}

function readiness(view, lib, scene, selectBlock, openInLibrary) {
  const items = [];
  const fix = (label, action) => items.push(h('button.et-fix', { type: 'button', onclick: action }, label, icon('chevron', { size: 12 })));
  if (!scene.goal?.trim()) fix('Write the scene goal', () => selectBlock('goal'));
  if (!scene.checks?.length) fix('Add a check', () => selectBlock('checks'));
  const payload = view.gm?.prepCards?.find((c) => c.id === scene.encounterId)?.payload;
  if (['fight', 'boss'].includes(scene.type) && !payload?.mobs?.length) fix('Choose encounter mobs', () => selectBlock('encounter'));
  const refs = [...(scene.npcs ?? []).map((id) => ({ kind: 'npc', id })),
    ...(payload?.mobs ?? []).map((m) => ({ kind: m.kind ?? 'monster', id: m.sourceId }))];
  const missing = (what, predicate) => {
    const ref = refs.find(({kind, id}) => {
      const e = lib[kind]?.find((row) => row.id === id);
      return e && !predicate(e);
    });
    if (ref) {
      const name = lib[ref.kind].find((row) => row.id === ref.id).name;
      fix(what + ' · ' + name, () => openInLibrary ? openInLibrary(ref.kind, ref.id) : selectBlock(ref.kind === 'npc' ? 'people' : 'encounter'));
    }
  };
  missing('Add art', (e) => e.image || e.imageSquare || e.portrait);
  missing('Add sound', (e) => Object.entries(e.sounds ?? {}).some(([key, cues]) => key !== 'randomEvery' && cues?.length) || e.moments?.some((m) => m.sounds?.length));
  return toolSection('Readiness', ...(items.length ? items : [h('small.dim', 'Ready to run.')]));
}

function quickNpc(doc, scene, act) {
  const name = input('Quick NPC name', { maxlength: 60, placeholder: 'Name' });
  const motive = input('Quick NPC motive', { maxlength: 120, placeholder: 'Motive' });
  const voice = input('Quick NPC voice line', { maxlength: 160, placeholder: 'Voice line' });
  const save = h('button.btn.btn-sm', { type: 'submit', disabled: true }, 'Add NPC');
  name.addEventListener('input', () => { save.disabled = !name.value.trim(); });
  const form = h('form.et-npc', { onsubmit: async (e) => {
    e.preventDefault();
    if (save.disabled || !name.value.trim()) return;
    save.disabled = true;
    try {
      if (await act({ t: 'prep.scene.npc', id: doc.id, sceneId: scene.id, name: name.value.trim(), motive: motive.value.trim(), voice: voice.value.trim() }, 'NPC added to this scene.')) form.reset();
    } finally { save.disabled = !name.value.trim(); }
  } }, h('div.et-row', name, motive), h('div.et-row', voice, save));
  return toolSection('Quick NPC', form);
}

let lastRoll = null;
function diceRoller(act, doc) {
  const formula = input('Private dice formula', { placeholder: '1d20', value: lastRoll?.doc === doc.id ? lastRoll.formula : '1d20', maxlength: 60, required: true });
  const result = h('output.et-dice-result', { 'aria-live': 'polite' }, lastRoll?.doc === doc.id ? String(lastRoll.total) : '');
  const roll = h('button.btn.btn-sm', { type: 'submit' }, 'Roll');
  return toolSection('GM dice', h('form.et-row', { onsubmit: async (e) => {
    e.preventDefault();
    if (roll.disabled || !formula.value.trim()) return;
    roll.disabled = true;
    try {
      const r = await act({ t: 'roll', what: { kind: 'custom', formula: formula.value.trim(), label: 'GM dice' }, secret: true });
      if (Number.isFinite(r?.result?.total)) {
        lastRoll = { doc: doc.id, formula: formula.value, total: r.result.total };
        result.textContent = String(lastRoll.total);
      }
    } finally { roll.disabled = false; }
  } }, formula, roll, result));
}

export function eveningTools({ view, act, doc, scene, selectBlock, addMob, openInLibrary }) {
  const lib = libraryOf(view);
  return h('aside.et-tools', { 'aria-label': 'GM tools' }, h('h2', 'GM tools'), calculator(view),
    scene ? mobSearch(lib, addMob) : null, scene ? readiness(view, lib, scene, selectBlock, openInLibrary) : null,
    scene ? quickNpc(doc, scene, act) : null, diceRoller(act, doc));
}
