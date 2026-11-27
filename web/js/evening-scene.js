import { h, itemArt } from './client.js';
import { field, icon, select } from './ui.js';
import { libGet, libraryOf } from './rules.js';
import { dangerBar } from './danger-bar.js';
import { mobsOf, prepDanger } from './prep-danger.js';
import { privateChecks } from './prep-checks.js';
import { giveGuard } from './give-once.js';

export const EVENING_MOB_TYPE = 'application/x-evening-mob';
const TYPES = ['Fight', 'Explore', 'Talk', 'Trap', 'Boss', 'Chase'];
const HELP = {
  goal: 'What can the party accomplish here?',
  readAloud: 'Read this at the table or send it to the TV.',
  checks: 'Set a difficulty and decide what each result means.',
  encounter: 'Prepare opponents and a battle map for this scene.',
  people: 'Keep NPCs, loot and clues within reach.',
  notes: 'Private reminders for running this scene.',
  chase: 'Legs, the check for each and what the quarry rolls. Run puts it on the TV.',
};
const LABELS = { chase: 'Chase / race', goal: 'Goal', readAloud: 'Read aloud', checks: 'Checks', encounter: 'Encounter', people: 'People and things', notes: 'My notes' };

const updateScene = (act, doc, scene, patch) => act({ t: 'prep.scene.update', id: doc.id, sceneId: scene.id, patch }, null);
const cards = (view) => (view?.gm?.prepCards ?? []).filter((c) => c.kind === 'encounter');
const maps = (view) => Array.isArray(view?.maps) ? view.maps : view?.maps?.list ?? [];
const option = (e) => ({ value: e.id, label: e.name ?? e.label ?? e.id });
const detail = (state, key) => state.open.has(key);

/** Call from the Tools palette or a drag operation on the scene card. */
export async function addEveningMob({ act, doc, scene, kind, id }) {
  if (!scene || !['monster', 'boss'].includes(kind) || typeof id !== 'string') return null;
  return act({ t: 'prep.scene.encounter', id: doc.id, sceneId: scene.id, add: { kind, sourceId: id } }, null);
}

function section(state, key, summary, body) {
  const heading = h('summary', icon('chevron', { size: 14 }), h('strong', LABELS[key]),
    summary ? h('span.evening-block-summary', summary) : null,
    h('span.evening-block-help', { title: HELP[key], 'aria-label': HELP[key] }, '?'));
  const box = h('details.evening-block', { 'data-block': key, open: detail(state, key) }, heading, h('div.evening-block-body', body));
  box.addEventListener('toggle', () => {
    if (!box.isConnected) return;
    if (box.open) state.open.add(key);
    else state.open.delete(key);
  });
  return box;
}

function prose(value, label, onCommit, { placeholder, rows = 2, maxLength = 1200 } = {}) {
  return field(value, { onCommit, multiline: true, rows, placeholder, attrs: { 'aria-label': label, maxlength: maxLength } });
}

function notesField(doc, scene, patch, state) {
  const notes = state.notesDrafts ??= new Map();
  const key = JSON.stringify([doc.id, scene.id]);
  const stored = scene.notes ?? '';
  if (!notes.has(key)) notes.set(key, { value: stored, status: 'Autosaves', timer: null, editing: false });
  const draft = notes.get(key);
  if (draft.awaiting === stored) delete draft.awaiting;
  if (!draft.editing && draft.awaiting === undefined && draft.value !== stored) {
    draft.value = stored;
    draft.status = 'Saved';
  }
  const status = h('span.evening-save-status', { role: 'status' }, draft.status);
  draft.statusNode = status;
  const setStatus = (text) => { draft.status = text; draft.statusNode.textContent = text; };
  const input = h('textarea.inp', {
    rows: 3, maxlength: 6000, placeholder: 'Reminders, rulings, names you need at hand…', 'aria-label': 'My notes',
    oninput: () => {
      clearTimeout(draft.timer);
      draft.editing = true;
      draft.value = input.value;
      setStatus('Saving…');
      draft.timer = setTimeout(async () => {
        const text = draft.value;
        try {
          const response = await patch({ notes: text });
          if (draft.value !== text) return;
          setStatus(response ? 'Saved' : 'Save failed');
          if (response) {
            draft.editing = false;
            draft.awaiting = text;
          }
        } catch { if (draft.value === text) setStatus('Save failed'); }
      }, 450);
    },
  });
  input.value = draft.value;
  return h('div.evening-note', input, status);
}

function showMenu(scene, mapId, npcs, publish) {
  const menu = h('details.evening-show');
  const choose = (kind, id) => { menu.open = false; return publish({ kind, id }); };
  menu.append(h('summary.btn.btn-sm', icon('tv', { size: 15 }), 'Show on TV', icon('down', { size: 12 })),
    h('div.panel.evening-show-options',
      h('button.btn.btn-quiet', { type: 'button', disabled: !scene.readAloud?.trim(), onclick: () => choose('readAloud') }, 'Read aloud'),
      h('button.btn.btn-quiet', { type: 'button', disabled: !mapId, onclick: () => choose('map', mapId) }, 'Battle map'),
      ...npcs.map((npc) => h('button.btn.btn-quiet', { type: 'button', onclick: () => choose('npc', npc.id) }, npc.name))));
  return menu;
}

function links(label, entries, selected, onSelect) {
  const available = entries.filter((e) => !selected.includes(e.id));
  return select([{ value: '', label }, ...available.map(option)], '', { onChange: (id) => id && onSelect(id), label, cls: 'inp-sm', disabled: !available.length });
}

function removeBtn(label, onClick) {
  return h('button.btn.btn-sm.btn-quiet.evening-icon-btn', { type: 'button', 'aria-label': label, title: label, onclick: onClick }, icon('x', { size: 14 }));
}

function encounterBody({ view, act, doc, scene, patch, encounter, mapId, run }) {
  const payload = encounter?.payload ?? {};
  const rows = mobsOf(view, payload);
  const save = (change) => act({ t: 'prep.scene.encounter', id: doc.id, sceneId: scene.id, ...change }, null);
  const changeMob = (index, change) => {
    const { kind = 'monster', sourceId } = payload.mobs[index];
    return save({ change: { index, kind, sourceId, ...change } });
  };
  const mapOptions = [{ value: '', label: 'No battle map' }, ...maps(view).map(option)];
  const encOptions = [{ value: '', label: 'Choose an encounter' }, ...cards(view).map(option)];
  const countButton = (label, glyph, disabled, onclick) => h('button.btn.btn-sm.btn-quiet.evening-icon-btn', { type: 'button', disabled, 'aria-label': label, title: label, onclick }, icon(glyph, { size: 13 }));
  const tile = ({ e, kind, sourceId, count = 1, hidden }, i) => {
    const name = e?.name ?? sourceId;
    const role = kind === 'boss' ? 'Boss' : e?.role === 'elite' ? 'Elite' : e?.role === 'minion' ? 'Minion' : '';
    return h('li.evening-roster-row',
      h('span.evening-thumb', itemArt(e || { name }, 'evening-entry-art')),
      h('div.evening-roster-name', h('strong', name), role ? h('span.pill', role) : null),
      h('div.evening-stepper', { 'aria-label': `${name} count` },
        countButton(`Fewer ${name}`, 'minus', count <= 1, () => changeMob(i, { delta: -1 })),
        h('span', `×${count}`), countButton(`More ${name}`, 'plus', count >= 20, () => changeMob(i, { delta: 1 }))),
      h('label.evening-toggle', h('input', { type: 'checkbox', checked: hidden !== false, onchange: (event) => changeMob(i, { hidden: event.target.checked }) }), h('span', 'Hidden')),
      removeBtn(`Remove ${name}`, () => changeMob(i, { remove: true })));
  };
  return h('div.evening-encounter',
    h('div.evening-links',
      select(encOptions, encounter?.id ?? '', { label: 'Encounter', cls: 'inp-sm', onChange: (encounterId) => patch({ encounterId: encounterId || null }) }),
      select(mapOptions, mapId ?? '', { label: 'Battle map', cls: 'inp-sm', onChange: (id) => encounter ? save({ mapId: id || null }) : patch({ mapId: id || null }) })),
    rows.length ? h('ul.evening-roster', rows.map(tile)) : h('p.hint.evening-drop-help', 'Add or drag opponents from Tools.'),
    rows.length ? dangerBar(prepDanger(view, payload), { label: 'Encounter danger' }) : null,
    rows.length ? h('button.btn.btn-sm', { type: 'button', onclick: () => run({ fight: true }) }, icon('play', { size: 14 }), 'Run encounter') : null);
}

/** Chase / race set-up: what runs, each leg (label, skill, the quarry's number, a hazard line for the TV). */
function chaseBody({ view, scene, patch }) {
  const c = structuredClone(scene.chase ?? { mode: 'chase', quarry: { name: '' }, legs: [], npcs: [] });
  const save = () => patch({ chase: c });
  const skills = (view.library?.skill ?? []).filter((x) => !['passive', 'evade'].includes(x.checkType?.toLowerCase()) && !x.tags?.includes('legacy')).sort((a, b) => a.name.localeCompare(b.name));
  const opts = [...skills.map((x) => ({ value: `skill:${x.id}`, label: x.name })), ...(view.pack?.ruleset?.stats ?? []).map((x) => ({ value: `stat:${x.id}`, label: `${x.label} (stat)` }))];
  const floor = view.crawlers?.floor || 1;
  return h('div.ev-chase',
    h('div.ev-chase-top',
      select([{ value: 'chase', label: 'Chase: catch the quarry' }, { value: 'race', label: 'Race: first to the finish' }], c.mode, { cls: 'inp-sm', label: 'Contest', onChange: (mode) => { c.mode = mode; save(); } }),
      c.mode === 'chase' ? field(c.quarry?.name ?? '', { cls: 'inp-sm', placeholder: 'What runs away', attrs: { maxlength: 60, 'aria-label': 'Quarry' }, onCommit: (name) => { c.quarry = { ...c.quarry, name }; save(); } }) : null,
      c.mode === 'chase' ? field(c.quarry?.value ?? '', { type: 'number', cls: 'inp-sm', placeholder: `rolls ${12 + floor}`, attrs: { min: 1, max: 60, 'aria-label': 'Quarry number every leg' }, onCommit: (v) => { c.quarry = { ...c.quarry }; if (Number(v)) c.quarry.value = Math.round(Number(v)); else delete c.quarry.value; save(); } }) : null),
    h('ol.ev-chase-legs', c.legs.map((l, i) => h('li',
      field(l.label, { cls: 'inp-sm', attrs: { maxlength: 60, 'aria-label': `Leg ${i + 1}` }, onCommit: (label) => { l.label = label; save(); } }),
      select(opts, l.skillId ? `skill:${l.skillId}` : `stat:${l.statId}`, { cls: 'inp-sm', label: `Leg ${i + 1} check`, onChange: (v) => { const [k, id] = v.split(':'); delete l.skillId; delete l.statId; l[k === 'stat' ? 'statId' : 'skillId'] = id; save(); } }),
      field(l.value ?? '', { type: 'number', cls: 'inp-sm', placeholder: 'quarry', attrs: { min: 1, max: 60, 'aria-label': `Leg ${i + 1} quarry number` }, onCommit: (v) => { if (Number(v)) l.value = Math.round(Number(v)); else delete l.value; save(); } }),
      field(l.hazard ?? '', { cls: 'inp-sm', placeholder: 'Hazard on the TV (optional)', attrs: { maxlength: 300, 'aria-label': `Leg ${i + 1} hazard` }, onCommit: (hazard) => { if (hazard.trim()) l.hazard = hazard; else delete l.hazard; save(); } }),
      h('button.icon-btn', { type: 'button', 'aria-label': `Remove leg ${i + 1}`, disabled: c.legs.length <= 1, onclick: () => { c.legs.splice(i, 1); save(); } }, '✕')))),
    c.legs.length < 8 ? h('button.btn.btn-sm', { type: 'button', onclick: () => { c.legs.push({ label: `Leg ${c.legs.length + 1}`, skillId: 'running' }); save(); } }, '+ Leg') : null,
    h('p.dim', c.mode === 'race' ? 'Run puts the race on the TV. Each leg: crawlers roll + Move/10, places add up, lowest wins.'
      : 'Run puts the chase on the TV. Each leg: roll + Move/10 vs the quarry. Amazing +2, Success +1, Near 0, Fail −1, Major −2, Critical fail = out. 4 Ground catches it; after the last leg 1+ does.'));
}

function peopleBody({ scene, view, npcEntries, itemEntries, act, patch }) {
  const lib = libraryOf(view);
  const party = view.players ?? [];
  const npcs = scene.npcs ?? [];
  const items = scene.items ?? [];
  const secrets = scene.secrets ?? [];
  const updateLinks = (key, entries, id, include) => patch({ [key]: include ? [...entries, id] : entries.filter((x) => x !== id) });
  const updateSecret = (index, change) => patch({ secrets: change
    ? secrets.map((s, i) => i === index ? { ...s, ...change } : s) : secrets.filter((_, i) => i !== index) });
  const npcNode = (id) => {
    const e = libGet(lib, 'npc', id);
    const name = e?.name ?? id;
    const motive = e?.personality || e?.role;
    return h('li.evening-person', h('span.evening-thumb', itemArt(e || { name }, 'evening-entry-art')),
      h('div.evening-person-copy', h('strong', name), motive ? h('span', { title: motive }, motive) : null,
        e?.voice ? h('span.evening-person-voice', { title: e.voice }, e.voice) : null),
      removeBtn(`Remove ${name}`, () => updateLinks('npcs', npcs, id, false)));
  };
  const itemNode = (id) => {
    const e = libGet(lib, 'item', id);
    const name = e?.name ?? id;
    const direct = (playerId) => (giveGuard(playerId, id, name, party.find((x) => x.id === playerId)?.name) ? act({ t: 'item.give', playerId, itemId: id }, `${name} given.`) : null);
    const give = h('details.evening-give');
    give.append(h('summary.btn.btn-sm.btn-quiet', icon('gift', { size: 14 }), 'Give'),
      h('div.evening-give-targets', party.length ? party.map((p) => h('button.btn.btn-sm', { type: 'button', onclick: () => { give.open = false; direct(p.id); } }, p.name)) : h('p.hint', 'Add a player to give loot.')));
    return h('li.evening-person', h('span.evening-thumb', itemArt(e || { name }, 'evening-entry-art')), h('strong', name), e ? give : null,
      removeBtn(`Remove ${name}`, () => updateLinks('items', items, id, false)));
  };
  const newSecret = field('', { placeholder: 'Add a secret or clue', attrs: { maxlength: 600, 'aria-label': 'New secret' } });
  const addSecret = async () => {
    const text = newSecret.value.trim();
    if (!text) return;
    const suffix = globalThis.crypto?.randomUUID?.().replaceAll('-', '') ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    const id = `s_${suffix}`;
    if (await patch({ secrets: [...secrets, { id, text, revealed: false }] })) newSecret.value = '';
  };
  return h('div.evening-people',
    h('div.evening-attachments',
      links('Attach NPC', npcEntries, npcs, (id) => updateLinks('npcs', npcs, id, true)),
      links('Attach item', itemEntries, items, (id) => updateLinks('items', items, id, true))),
    npcs.length || items.length ? h('ul.evening-people-list', [...npcs.map(npcNode), ...items.map(itemNode)]) : null,
    secrets.length ? h('ul.evening-secrets', secrets.map((s, i) => h('li.evening-secret',
      h('input', { type: 'checkbox', checked: s.revealed, 'aria-label': `Mark ${s.text} revealed`, onchange: (event) => updateSecret(i, { revealed: event.target.checked }) }),
      field(s.text, { cls: 'inp-sm', attrs: { maxlength: 600, 'aria-label': 'Secret or clue' }, onCommit: (text) => text.trim() && updateSecret(i, { text }) }),
      removeBtn('Remove secret', () => updateSecret(i, null))))) : null,
    h('div.evening-new-secret', newSecret, h('button.btn.btn-sm', { type: 'button', onclick: addSecret }, icon('plus', { size: 14 }), 'Add clue')));
}

/** Scene card. Keep blockState attached to this scene across GM view updates. */
export function eveningScene({ view, act, doc, scene, selectBlock, addMob, showOnTv, run, redraw, blockState = {} }) {
  blockState.open ??= new Set(['goal']);
  const patch = (changes) => updateScene(act, doc, scene, changes);
  const encounter = cards(view).find((e) => e.id === scene.encounterId);
  const mapId = scene.mapId ?? encounter?.payload?.mapId ?? null;
  const lib = libraryOf(view);
  const npcEntries = lib.npc ?? [];
  const itemEntries = lib.item ?? [];
  const npcs = (scene.npcs ?? []).map((id) => libGet(lib, 'npc', id)).filter(Boolean);
  const runScene = (options = {}) => run ? run(options) : act({ t: 'prep.scene.run', id: doc.id, sceneId: scene.id, ...options }, null);
  const publish = ({ kind, id }) => {
    if (showOnTv) return showOnTv({ kind, id });
    if (kind === 'readAloud') return act({ t: 'scene.set', kind: 'explore', data: { location: scene.title, text: scene.readAloud.slice(0, 1200), showText: true } }, null);
    return act({ t: 'scene.set', kind, data: kind === 'map' ? { mapId: id } : { npcId: id } }, null);
  };
  const count = (encounter?.payload?.mobs ?? []).reduce((n, m) => n + (m.count ?? 1), 0);
  const words = String(scene.readAloud ?? '').trim();
  const sentences = words ? (words.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.length ?? 1) : 0;
  const card = h('section.panel.evening-scene', { 'aria-label': 'Scene card', 'data-scene-id': scene.id,
    ondragover: (event) => { if (event.dataTransfer.types.includes(EVENING_MOB_TYPE)) event.preventDefault(); },
    ondrop: (event) => {
      const data = event.dataTransfer.getData(EVENING_MOB_TYPE);
      if (!data) return;
      event.preventDefault();
      let mob;
      try { mob = JSON.parse(data); } catch { return; }
      if (!['monster', 'boss'].includes(mob.kind) || typeof mob.id !== 'string') return;
      blockState.open.add('encounter');
      selectBlock?.('encounter');
      return addMob ? addMob(mob) : addEveningMob({ act, doc, scene, ...mob });
    },
  }, h('header.evening-scene-head',
      h('div.evening-scene-title', field(scene.title, { attrs: { maxlength: 80, 'aria-label': 'Scene title' }, onCommit: (title) => title.trim() && patch({ title }) }),
        h('div.evening-scene-meta', select(TYPES.map((label) => ({ value: label.toLowerCase(), label })), scene.type, { cls: 'inp-sm', label: 'Scene type', onChange: (type) => patch({ type }) }),
          h('label.evening-minutes', field(scene.minutes, { type: 'number', cls: 'inp-sm', attrs: { min: 0, max: 1440, 'aria-label': 'Scene minutes' }, onCommit: (minutes) => patch({ minutes: Math.max(0, Math.min(1440, Math.round(minutes) || 0)) }) }), 'min'))),
      h('div.evening-scene-actions', showMenu(scene, mapId, npcs, publish),
        h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => runScene() }, icon('play', { size: 15 }), 'Run'))),
    h('div.evening-blocks',
      section(blockState, 'goal', scene.goal || 'Add a goal', prose(scene.goal, 'Goal', (goal) => patch({ goal }), { placeholder: 'What can the party achieve?', maxLength: 600 })),
      section(blockState, 'readAloud', sentences ? `${sentences} sentence${sentences === 1 ? '' : 's'}` : 'No read-aloud text',
        prose(scene.readAloud, 'Read aloud', (readAloud) => patch({ readAloud }), { placeholder: 'What should the players hear or see?', rows: 4, maxLength: 4000 })),
      scene.type === 'chase' ? section(blockState, 'chase', `${scene.chase?.mode === 'race' ? 'Race' : 'Chase'} · ${scene.chase?.legs?.length ?? 0} legs`, chaseBody({ view, scene, patch })) : null,
      section(blockState, 'checks', scene.checks?.length ? `${scene.checks.length} prepared` : 'No checks', privateChecks({ view, act, doc, scene, patch, redraw, blockState })),
      section(blockState, 'encounter', count ? `${count} opponent${count === 1 ? '' : 's'}` : 'No opponents', encounterBody({ view, act, doc, scene, patch, encounter, mapId, run: runScene })),
      section(blockState, 'people', [scene.npcs?.length ? `${scene.npcs.length} NPCs` : '', scene.items?.length ? `${scene.items.length} items` : '', scene.secrets?.length ? `${scene.secrets.length} clues` : ''].filter(Boolean).join(' · '),
        peopleBody({ scene, view, act, patch, npcEntries, itemEntries })),
      section(blockState, 'notes', null, notesField(doc, scene, patch, blockState))));
  if (blockState.focus) {
    const key = blockState.focus;
    delete blockState.focus;
    queueMicrotask(() => card.querySelector(`details[data-block="${key}"] > summary`)?.focus());
  }
  return card;
}
