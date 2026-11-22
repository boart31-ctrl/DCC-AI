import { h } from './client.js';
import { closeDrawer, field, icon, openDrawer, select } from './ui.js';
import { addEveningMob, eveningScene } from './evening-scene.js';
import { eveningTools } from './evening-tools.js';

const TYPES = { fight: ['Fight', 'swords'], explore: ['Explore', 'map'], talk: ['Talk', 'user'], trap: ['Trap', 'warn'], boss: ['Boss', 'skull'] };
const MOVE_TYPE = 'application/x-evening-scene';
const COACH_KEY = 'system.prep.eveningCoach';
const COACH = [
  ['agenda', 'Put this evening’s scenes in order and check their combined time.'],
  ['blocks', 'Select a scene to edit its goal, checks, encounter and notes.'],
  ['tools', 'Use GM tools for DCs, encounter building and scene readiness.'],
];

function readCoach() {
  try { return Math.min(COACH.length, Math.max(0, Number(localStorage.getItem(COACH_KEY)) || 0)); } catch { return 0; }
}

function formatTime(total) {
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

function readiness(scene, view) {
  if (scene.played) return ['played', 'Played'];
  if (!scene.goal?.trim()) return ['needs', 'Needs a goal'];
  if (scene.type === 'fight' || scene.type === 'boss') {
    const encounter = view.gm?.prepCards?.find((c) => c.kind === 'encounter' && c.id === scene.encounterId);
    if (!encounter?.payload?.mobs?.length) return ['needs', 'Needs an encounter'];
  }
  if (scene.type === 'trap' && !scene.checks.length) return ['needs', 'Needs a check'];
  if (scene.type === 'talk' && !scene.npcs.length) return ['needs', 'Needs an NPC'];
  return ['ready', 'Ready'];
}

/** Evening selection and layout. Scene content and GM tools are rendered by their own components. */
export function createEvening({ act, redraw, onPlan, onSelect, onRun, onShow, openInLibrary }) {
  const selection = new Map();
  const blockState = { open: new Set(['goal']), focus: null };
  let coach = readCoach();
  let floor = null;
  let template = null;
  let planning = false;
  let toolDrawer = null;
  let editor = null;

  function selectScene(docId, sceneId, focus = false) {
    if (selection.get(docId) !== sceneId) {
      selection.set(docId, sceneId);
      blockState.open = new Set(['goal']);
      blockState.focus = null;
    }
    if (focus) redraw();
  }

  function selectBlock(key) {
    if (toolDrawer?.isConnected) closeDrawer();
    blockState.open.add(key);
    blockState.focus = key;
    redraw(true);
  }

  function coachStep(value) {
    coach = value;
    try { localStorage.setItem(COACH_KEY, String(value)); } catch { /* storage unavailable */ }
    redraw();
  }

  const STEPS = { hook: ['Hook', 'flag', 15], explore: ['Explore', 'map', 25], check: ['Check', 'dice', 15], fight: ['Fight', 'swords', 30], talk: ['Talk', 'chat', 15], trap: ['Trap', 'warn', 15], boss: ['Boss', 'skull', 45] };
  const RECIPES = [
    ['Classic', ['hook', 'explore', 'check', 'fight', 'talk', 'fight']],
    ['Big fight night', ['hook', 'fight', 'trap', 'fight', 'boss']],
    ['Talk & mystery', ['hook', 'talk', 'check', 'explore', 'talk', 'fight']],
  ];
  const plan = { mode: 'build', name: '', recipe: [...RECIPES[0][1]], suggest: true, minutes: 240 };

  function resetPicker() { floor = null; template = null; plan.mode = 'build'; plan.name = ''; plan.recipe = [...RECIPES[0][1]]; plan.suggest = true; }

  function picker(view, { first = true, onBuild } = {}) {
    const source = view?.gm?.prep?.evenings ?? [];
    const floors = [...new Set(source.map((t) => t.floor))].sort((a, b) => a - b);
    const count = (view?.gm?.prep?.docs ?? []).filter((d) => d.evening).length;
    const defaultName = `Evening ${count + 1}`;
    const name = () => plan.name.trim() || defaultName;
    const choose = (t) => h('button.btn.ev-template', {
      type: 'button', 'aria-pressed': String(template?.key === t.key && template?.adventureId === t.adventureId && !!template),
      onclick: () => { template = t; redraw(); },
    }, t.label || t.title);
    const go = async (fn) => {
      if (planning) return;
      planning = true; redraw();
      try { await fn(); } finally { planning = false; redraw(); }
    };
    const create = () => go(async () => {
      if (plan.mode === 'build') return onBuild?.({ title: name(), recipe: plan.recipe, suggest: plan.suggest, minutes: plan.minutes });
      if (plan.mode === 'book' && template) return onPlan({ key: template.key, adventureId: template.adventureId, title: plan.name.trim() || template.title });
      return onPlan({ title: name() });
    });
    const modes = [['build', 'Build it with suggestions'], ['book', 'From the book'], ['empty', 'Empty evening']];
    const total = plan.recipe.reduce((n, k) => n + STEPS[k][2], 0);
    const body = plan.mode === 'build'
      ? h('div.ev-build',
        h('p.ev-q', 'What do you want tonight? Tap to add, tap a scene to remove it.'),
        h('div.ev-palette', Object.entries(STEPS).map(([k, [label, glyph]]) => h('button.btn.btn-sm', { type: 'button', disabled: plan.recipe.length >= 12, onclick: () => { plan.recipe.push(k); redraw(); } }, icon('plus', { size: 12 }), icon(glyph, { size: 13 }), label))),
        h('ol.ev-recipe', { 'aria-label': 'Scenes in order' }, plan.recipe.map((k, i) => h('li', h('button.ev-step', { type: 'button', title: 'Remove', onclick: () => { plan.recipe.splice(i, 1); redraw(); } },
          h('span.ev-step-n', String(i + 1)), icon(STEPS[k][1], { size: 14 }), STEPS[k][0], h('span.ev-step-x', '✕'))))),
        h('div.ev-recipes', h('span.dim', 'Quick start:'), RECIPES.map(([label, r]) => h('button.chip', { type: 'button', onclick: () => { plan.recipe = [...r]; redraw(); } }, label))),
        h('label.chk', h('input', { type: 'checkbox', checked: plan.suggest, onchange: (e) => { plan.suggest = e.target.checked; } }),
          ' Fill the scenes for me: monsters for your floor and party, new NPCs with a hook, checks with DCs, a complication'),
        h('p.dim', `${plan.recipe.length} scenes · about ${formatTime(total)}. Everything stays editable.`))
      : plan.mode === 'book'
        ? h('div.ev-template-floors', floors.length ? floors.map((n) => h('section.ev-floor',
          h('button.btn.ev-floor-button', { type: 'button', 'aria-expanded': String(floor === n), onclick: () => { floor = floor === n ? null : n; redraw(); } }, icon(floor === n ? 'down' : 'chevron', { size: 14 }), `Floor ${n}`),
          floor === n ? h('div.ev-template-list', source.filter((x) => x.floor === n).map(choose)) : null)) : h('p.dim', 'This pack has no prepared evenings.'))
        : h('p.dim', view?.pack?.ruleset?.system?.family === 'crawler' ? 'One empty scene. You add the rest.' : 'A Lazy DM skeleton: strong start, a person, a confrontation, clues.');
    const can = !planning && (plan.mode !== 'build' || plan.recipe.length) && (plan.mode !== 'book' || template);
    return h('section.panel.ev-first', { 'aria-labelledby': 'ev-first-title' },
      h('h1#ev-first-title', first ? 'Plan your first evening' : 'New evening'),
      h('label.ev-name', h('span', 'Name'), h('input.field', { type: 'text', maxlength: 100, value: plan.name, placeholder: defaultName, 'aria-label': 'Evening name',
        oninput: (e) => { plan.name = e.target.value; } })),
      h('div.ev-modes', { role: 'tablist' }, modes.map(([id, label]) => h('button.chip', { type: 'button', role: 'tab', class: `chip${plan.mode === id ? ' on' : ''}`, 'aria-selected': String(plan.mode === id), onclick: () => { plan.mode = id; redraw(); } }, label))),
      body,
      h('footer.ev-first-actions', h('button.btn.btn-primary', { type: 'button', disabled: !can, onclick: create }, planning ? 'Creating…' : 'Create evening')));
  }

  function agenda(view, doc, scene) {
    const ordered = doc.evening.scenes;
    const total = ordered.reduce((n, row) => n + row.minutes, 0);
    const current = ordered.findIndex((row) => row.id === scene?.id);
    const move = (sceneId, to) => act({ t: 'prep.scene.move', id: doc.id, sceneId, to });
    const update = (patch) => act({ t: 'prep.evening.update', id: doc.id, ...patch });
    const add = async (type) => {
      const r = await act({ t: 'prep.scene.add', id: doc.id, type });
      if (r?.result?.sceneId) selectScene(doc.id, r.result.sceneId, true);
    };
    return h('aside.panel.ev-agenda', { 'aria-label': 'Evening agenda' },
      h('h2', 'Evening'),
      field(doc.title, { cls: 'ev-title', attrs: { 'aria-label': 'Evening title', maxlength: 100 }, onCommit: (title) => title.trim() && update({ title: title.trim() }) }),
      h('label.ev-budget', h('span', 'Planned length'), field(doc.evening.minutes, { type: 'number', cls: 'inp-sm',
        attrs: { min: 1, max: 1440, 'aria-label': 'Planned minutes' }, onCommit: (minutes) => Number.isInteger(minutes) && minutes > 0 && minutes <= 1440 && update({ minutes }) }), h('span.dim', 'min')),
      h('div.ev-time', { class: total > doc.evening.minutes ? 'ev-time over' : 'ev-time' },
        h('progress', { max: doc.evening.minutes, value: Math.min(total, doc.evening.minutes), 'aria-label': 'Scene time used' }),
        h('span', `${formatTime(total)} planned of ${formatTime(doc.evening.minutes)}`)),
      h('ol.ev-scenes', ordered.map((row, index) => {
        const [label, glyph] = TYPES[row.type] ?? TYPES.explore;
        const [state, status] = readiness(row, view);
        return h('li.ev-scene-link', {
          draggable: true,
          ondragstart: (e) => { e.dataTransfer.setData(MOVE_TYPE, row.id); e.dataTransfer.effectAllowed = 'move'; },
          ondragover: (e) => {
            if (!e.dataTransfer.types.includes(MOVE_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            e.currentTarget.classList.add('ev-drop');
          },
          ondragleave: (e) => e.currentTarget.classList.remove('ev-drop'),
          ondrop: (e) => {
            e.preventDefault();
            e.currentTarget.classList.remove('ev-drop');
            const from = e.dataTransfer.getData(MOVE_TYPE);
            if (from && from !== row.id && ordered.some((entry) => entry.id === from)) move(from, index);
          },
        }, h('button.ev-scene-button', { type: 'button', 'aria-current': row.id === scene?.id ? 'true' : null,
          title: `${label} · ${status} · ${formatTime(row.minutes)}`, onclick: () => selectScene(doc.id, row.id, true) },
        h('span.ev-scene-index', { 'aria-hidden': 'true' }, String(index + 1)), h('span.ev-scene-title', row.title),
        h('span.ev-ready', { 'data-status': state, 'aria-hidden': 'true' }), h('span.ev-type', { 'aria-hidden': 'true' }, icon(glyph, { size: 14 }))));
      })),
      h('div.ev-agenda-actions', h('details.ev-add', h('summary.btn.btn-sm', icon('plus', { size: 14 }), 'Scene'),
        h('div.ev-presets', Object.entries(TYPES).map(([type, [label, glyph]]) => h('button.btn.btn-sm', { type: 'button', onclick: () => add(type) }, icon(glyph, { size: 13 }), label)))),
      h('span.grow'),
      scene ? [h('button.icon-btn', { type: 'button', disabled: current <= 0, title: 'Move scene earlier', 'aria-label': 'Move scene earlier', onclick: () => move(scene.id, current - 1) }, icon('up', { size: 14 })),
        h('button.icon-btn', { type: 'button', disabled: current >= ordered.length - 1, title: 'Move scene later', 'aria-label': 'Move scene later', onclick: () => move(scene.id, current + 1) }, icon('down', { size: 14 }))] : null));
  }

  function addMob({ kind, id }) {
    if (!editor?.scene) return;
    return addEveningMob({ ...editor, act, kind, id });
  }

  function tools() {
    return eveningTools({ ...editor, act, selectBlock, addMob: async (entry) => {
      if (await addMob(entry)) selectBlock('encounter');
    }, redraw, openInLibrary: openInLibrary ? (kind, id) => {
      if (toolDrawer?.isConnected) closeDrawer();
      openInLibrary(kind, id);
    } : null });
  }

  function showTools() {
    if (!editor?.scene) return;
    toolDrawer = h('div.ev-tools-drawer', tools());
    openDrawer({ title: 'GM tools', body: toolDrawer, onClose: () => { toolDrawer = null; } });
  }

  function render(view, doc) {
    const rows = doc.evening.scenes;
    const scene = rows.find((x) => x.id === selection.get(doc.id))
      ?? rows.find((x) => x.id === doc.evening.activeSceneId) ?? rows[0] ?? null;
    editor = { view, doc, scene };
    const guide = COACH[coach];
    const active = document.activeElement;
    const typingInTools = toolDrawer?.contains(active) && active?.matches('input:not([type="checkbox"]), textarea, select');
    if (toolDrawer?.isConnected && !typingInTools) toolDrawer.replaceChildren(tools());
    return h('div.ev-workspace', { 'data-coach': guide?.[0] },
      guide ? h('aside.ev-coach', { 'aria-label': 'Prep tour' }, h('span', guide[1]), h('span.grow'),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => coachStep(COACH.length) }, 'Dismiss'),
        h('button.btn.btn-sm', { type: 'button', onclick: () => coachStep(coach + 1) }, coach === COACH.length - 1 ? 'Done' : 'Next')) : null,
      h('div.ev-layout', agenda(view, doc, scene),
        h('div.ev-center', scene ? eveningScene({ ...editor, act, selectBlock, addMob, redraw, blockState,
          run: (options) => onRun(doc, scene, options), showOnTv: (show) => onShow(doc, scene, show) }) : h('section.panel.ev-no-scene', h('h2', 'No scenes'), h('p.dim', 'Add a scene to start the evening.'))),
        scene ? h('aside.ev-tools-desktop', { 'aria-label': 'GM tools' }, tools()) : null,
        scene ? h('button.btn.btn-primary.ev-tools-toggle', { type: 'button', onclick: showTools }, icon('gear', { size: 16 }), 'GM tools') : null));
  }

  return { picker, render, resetPicker, selectScene, selectBlock };
}
