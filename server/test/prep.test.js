// prep.js: Příprava — templates (built-in + pack, family filter), adventures, sessions with carry-over,
// sections and items, "within reach", GM-only view, pack round-trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../pack.js';
import { serializePack, deserializePack } from '../pack-core.js';
import { createState, normalizeState, reduce, viewFor, GM_ACTIONS } from '../state.js';
import { normalizePrepConfig, templatesFor, withinReach, BUILTIN_TEMPLATES, normalizePrep } from '../prep.js';
import { tmpDir, writePack, seq } from './fixtures.js';

const PREP = {
  templates: [
    {
      id: 'neighborhood', label: 'Neighborhood', scope: 'adventure', default: true,
      sections: [
        { key: 'summary', label: 'Summary', kind: 'text' },
        { key: 'quarters', label: 'Quarters', kind: 'parts' },
        { key: 'mobs', label: 'Mobs', kind: 'refs', refKinds: ['monster', 'boss'] },
        { key: 'achievements', label: 'Achievements', kind: 'list' },
        { key: 'bad', label: 'Bad', kind: 'nope' },
        { key: 'Bad Key', label: 'x' },
      ],
    },
    { id: 'crawl_night', label: 'Crawl night', scope: 'session', default: true, families: ['crawler'], sections: [
      { key: 'strong_start', label: 'Strong start', kind: 'text' },
      { key: 'secrets', label: 'Secrets', kind: 'list', carry: true },
      { key: 'tonight', label: 'Tonight', kind: 'parts', carry: true },
    ] },
    { id: 'dnd_only', label: 'DnD only', scope: 'session', families: ['dnd'], sections: [{ key: 'a', label: 'A', kind: 'text' }] },
    { id: 'lazy_session', label: 'Clash with built-in', scope: 'session', sections: [{ key: 'a', label: 'A' }] },
  ],
};

const dir = writePack(tmpDir(), {
  'pack.json': {
    id: 'pp', name: 'Prep', version: '1.0.0', lootTiers: [{ id: 'bronze', name: 'Bronze', color: '#cd7f32' }],
    stats: [{ id: 'str', label: 'Strength', abbr: 'STR', default: 3 }],
    resources: [{ id: 'hp', label: 'Health', color: '#ff3355', default: 10 }],
    prep: PREP,
  },
});
const { pack, warnings } = loadPack(dir);
let n = 0;
const ctx = () => ({ now: 1000, rng: seq(0.5), genId: (p) => `${p}_${++n}`, pack });
const gm = (state, a) => reduce(state, { role: 'gm', ...a }, ctx());
const run = (state, ...actions) => actions.reduce((s, a) => gm(s, a).state, state);

test('pack templates: normalized with warnings, built-in id clash refused, round-trip', () => {
  assert.ok(warnings.some((w) => w.includes('sections[4]')), 'bad kind warned');
  assert.ok(warnings.some((w) => w.includes('sections[5]')), 'bad key skipped');
  assert.ok(warnings.some((w) => w.includes('templates[3]')), 'clash with built-in skipped');
  assert.equal(pack.prep.templates.length, 3);
  const nb = pack.prep.templates[0];
  assert.equal(nb.sections.length, 5);
  assert.equal(nb.sections.find((s) => s.key === 'bad').kind, 'text');
  const back = deserializePack(JSON.stringify(serializePack(pack)));
  assert.deepEqual(back.prep, pack.prep);
  assert.deepEqual(normalizePrepConfig(null), { templates: [] });
  assert.deepEqual(normalizePrepConfig('x', []), { templates: [] });
});

test('templatesFor: family filter, pack first, built-ins always there', () => {
  const ids = templatesFor(pack).map((t) => t.id);
  assert.deepEqual(ids, ['neighborhood', 'crawl_night', ...BUILTIN_TEMPLATES.map((t) => t.id)]);
  const dnd = { ...pack, ruleset: { system: { family: 'dnd' } } };
  assert.deepEqual(templatesFor(dnd).map((t) => t.id), ['neighborhood', 'dnd_only', 'lazy_session', 'adventure']);
});

test('adventure + session: default templates, carry-over of unfinished items, inherited adventure', () => {
  let s = createState(pack, 0);
  let r = gm(s, { t: 'prep.adventure.add', title: 'Bogbricks' });
  const advId = r.result.id;
  s = r.state;
  assert.equal(s.prep.docs[0].template, 'neighborhood');
  r = gm(s, { t: 'prep.session.add', adventureId: advId });
  const s1 = r.result.id;
  s = r.state;
  assert.equal(s.prep.current, s1);
  const doc1 = s.prep.docs.find((d) => d.id === s1);
  assert.equal(doc1.template, 'crawl_night');
  assert.equal(doc1.title, 'Session 1');
  assert.equal(doc1.adventureId, advId);
  s = run(s,
    { t: 'prep.item.add', id: s1, key: 'secrets', text: 'The mayor is a rat' },
    { t: 'prep.item.add', id: s1, key: 'secrets', text: 'The well is a portal' },
    { t: 'prep.item.add', id: s1, key: 'tonight', title: 'North quarter', text: 'Mushrooms' },
    { t: 'prep.section.update', id: s1, key: 'strong_start', text: 'Goblins on fire' });
  const secrets = s.prep.docs.find((d) => d.id === s1).sections.find((x) => x.key === 'secrets').items;
  s = gm(s, { t: 'prep.item.update', id: s1, key: 'secrets', itemId: secrets[0].id, done: true }).state;
  r = gm(s, { t: 'prep.session.add' });
  assert.equal(r.result.carried, 2, 'one unrevealed secret + one unplayed part');
  s = r.state;
  const doc2 = s.prep.docs.find((d) => d.id === r.result.id);
  assert.equal(doc2.title, 'Session 2');
  assert.equal(doc2.adventureId, advId, 'adventure inherited');
  assert.deepEqual(doc2.sections.find((x) => x.key === 'secrets').items.map((i) => i.text), ['The well is a portal']);
  assert.equal(doc2.sections.find((x) => x.key === 'strong_start').text, '', 'text sections start empty');
  assert.notEqual(doc2.sections.find((x) => x.key === 'tonight').items[0].id, s.prep.docs.find((d) => d.id === s1).sections.find((x) => x.key === 'tonight').items[0].id, 'fresh item ids');
  assert.equal(s.prep.current, doc2.id);
});

test('items: refs respect section kinds, no duplicates, text sections refuse items, move, remove', () => {
  let s = createState(pack, 0);
  const adv = gm(s, { t: 'prep.adventure.add', title: 'A' });
  s = adv.state;
  const id = adv.result.id;
  assert.throws(() => gm(s, { t: 'prep.item.add', id, key: 'mobs', ref: { kind: 'npc', id: 'bob' } }), /takes encounter, monster, boss/);
  assert.throws(() => gm(s, { t: 'prep.item.add', id, key: 'summary', text: 'x' }), /text section/);
  assert.throws(() => gm(s, { t: 'prep.item.add', id, key: 'achievements' }), /title or text/);
  s = run(s, { t: 'prep.item.add', id, key: 'mobs', ref: { kind: 'monster', id: 'rat' }, pin: true });
  assert.throws(() => gm(s, { t: 'prep.item.add', id, key: 'mobs', ref: { kind: 'monster', id: 'rat' } }), /already linked/);
  s = run(s, { t: 'prep.item.add', id, key: 'mobs', ref: { kind: 'boss', id: 'swine' } });
  const items = () => s.prep.docs[0].sections.find((x) => x.key === 'mobs').items;
  s = gm(s, { t: 'prep.item.move', id, key: 'mobs', itemId: items()[1].id, to: 0 }).state;
  assert.equal(items()[0].ref.id, 'swine');
  s = gm(s, { t: 'prep.item.remove', id, key: 'mobs', itemId: items()[0].id }).state;
  assert.deepEqual(items().map((i) => i.ref.id), ['rat']);
});

test('sections: hide, rename, add custom, only custom ones can be removed', () => {
  let s = createState(pack, 0);
  const r = gm(s, { t: 'prep.adventure.add', title: 'A', template: 'adventure' });
  s = r.state;
  const id = r.result.id;
  s = run(s, { t: 'prep.section.update', id, key: 'hooks', hidden: true, label: 'Ways in' });
  const hooks = s.prep.docs[0].sections.find((x) => x.key === 'hooks');
  assert.equal(hooks.hidden, true);
  assert.equal(hooks.label, 'Ways in');
  const add = gm(s, { t: 'prep.section.add', id, label: 'Rival crawlers', kind: 'list' });
  assert.equal(add.result.key, 'rival_crawlers');
  s = add.state;
  assert.throws(() => gm(s, { t: 'prep.section.remove', id, key: 'hooks' }), /hidden, not removed/);
  s = gm(s, { t: 'prep.section.remove', id, key: 'rival_crawlers' }).state;
  assert.ok(!s.prep.docs[0].sections.some((x) => x.key === 'rival_crawlers'));
});

test('remove + copy + current: unlinking, fallback current, wrong scope refused', () => {
  let s = createState(pack, 0);
  let r = gm(s, { t: 'prep.adventure.add', title: 'A' });
  const adv = r.result.id;
  s = r.state;
  s = gm(s, { t: 'prep.session.add', adventureId: adv }).state;
  r = gm(s, { t: 'prep.session.add' });
  const s2 = r.result.id;
  s = r.state;
  assert.throws(() => gm(s, { t: 'prep.session.current', id: adv }), /only a session/);
  assert.throws(() => gm(s, { t: 'prep.adventure.add', title: 'X', template: 'crawl_night' }), /no adventure template/);
  const cp = gm(s, { t: 'prep.doc.copy', id: adv });
  s = cp.state;
  assert.equal(s.prep.docs.find((d) => d.id === cp.result.id).title, 'A (copy)');
  s = gm(s, { t: 'prep.doc.remove', id: adv }).state;
  assert.ok(s.prep.docs.filter((d) => d.type === 'session').every((d) => d.adventureId === null));
  s = gm(s, { t: 'prep.doc.remove', id: s2 }).state;
  assert.equal(s.prep.current, s.prep.docs.find((d) => d.type === 'session').id, 'falls back to the last session');
});

test('withinReach: pinned, unfinished, visible items of the current session and its adventure', () => {
  let s = createState(pack, 0);
  let r = gm(s, { t: 'prep.adventure.add', title: 'A' });
  const adv = r.result.id;
  s = run(r.state,
    { t: 'prep.item.add', id: adv, key: 'mobs', ref: { kind: 'monster', id: 'rat' }, pin: true },
    { t: 'prep.item.add', id: adv, key: 'achievements', text: 'Not pinned' });
  r = gm(s, { t: 'prep.session.add', adventureId: adv });
  const ses = r.result.id;
  s = run(r.state,
    { t: 'prep.item.add', id: ses, key: 'tonight', title: 'Pinned part', pin: true },
    { t: 'prep.item.add', id: ses, key: 'secrets', text: 'Pinned but done', pin: true });
  const done = s.prep.docs.find((d) => d.id === ses).sections.find((x) => x.key === 'secrets').items[0];
  s = gm(s, { t: 'prep.item.update', id: ses, key: 'secrets', itemId: done.id, done: true }).state;
  assert.deepEqual(withinReach(s.prep).map((x) => x.item.title || x.item.ref?.id), ['Pinned part', 'rat']);
  s = gm(s, { t: 'prep.section.update', id: adv, key: 'mobs', hidden: true }).state;
  assert.deepEqual(withinReach(s.prep).map((x) => x.item.title), ['Pinned part']);
  assert.deepEqual(withinReach(null), []);
});

test('view: GM only; normalize repairs junk; actions registered', () => {
  let s = createState(pack, 0);
  s = gm(s, { t: 'prep.adventure.add', title: 'Secret lair' }).state;
  const v = viewFor(s, pack, 'gm', { now: 0 });
  assert.equal(v.gm.prep.docs.length, 1);
  assert.equal(v.gm.prep.defaults.adventure, 'neighborhood');
  assert.equal(v.gm.prep.defaults.session, 'crawl_night');
  for (const role of ['stage', 'player']) assert.ok(!JSON.stringify(viewFor(s, pack, role, { now: 0 })).includes('Secret lair'), `${role} never sees prep`);
  const fixed = normalizeState({ ...s, prep: { docs: [{ id: 'x', type: 'nope' }, { id: 'ok', type: 'session', sections: [{ key: 'a', items: [{ id: 'i', done: 'yes' }, null] }] }], current: 'missing' } }, pack, 0);
  assert.equal(fixed.prep.docs.length, 1);
  assert.equal(fixed.prep.current, null);
  assert.equal(fixed.prep.docs[0].sections[0].items[0].done, false);
  assert.deepEqual(normalizePrep(undefined), { docs: [], current: null });
  for (const t of ['prep.adventure.add', 'prep.session.add', 'prep.item.add', 'prep.section.add']) assert.ok(GM_ACTIONS.includes(t));
});

test('prepared adventure loads linked encounters and rewards once without changing the live fight', () => {
  const seed = { id: 'starter', title: 'Ready adventure', families: ['crawler'], sections: [
    { key: 'scenes', label: 'Scenes', kind: 'parts', items: [{ id: 'opening', title: 'Opening', text: 'GM-only secret', pin: true,
      links: [{ kind: 'encounter', id: 'ambush' }, { kind: 'item', id: 'map' }, { kind: 'loot', id: 'bronze' }] }] },
  ], encounters: [{ id: 'ambush', label: 'Ambush', mobs: [{ sourceId: 'guard' }], items: [{ id: 'map', qty: 2 }] }] };
  const packed = loadPack(writePack(tmpDir(), {
    'adventures.json': [seed, { ...seed, id: 'broken', encounters: [{ ...seed.encounters[0], items: [{ id: 'missing' }] }] }],
    'items.json': [{ id: 'map', name: 'Map' }],
    'monsters.json': [{ id: 'guard', name: 'Guard', hpSlots: 4 }],
  })).pack;
  const p = deserializePack(serializePack(packed));
  const act = (s, a) => reduce(s, { role: 'gm', ...a }, { ...ctx(), pack: p });
  const initial = createState(p, 0);
  const session = act(initial, { t: 'prep.session.add', title: 'Tonight' });
  const s = session.state;
  assert.throws(() => act(s, { t: 'prep.adventure.load', id: 'broken' }), /missing item/);
  assert.equal(s.prepCards.length, 0);
  const loaded = act(s, { t: 'prep.adventure.load', id: 'starter' });
  const [enc] = loaded.state.prepCards;
  const id = loaded.result.id;
  assert.deepEqual(loaded.state.combat, s.combat);
  assert.equal(loaded.state.prep.current, session.result.id);
  assert.deepEqual(loaded.state.prep.docs[1].sections[0].items[0].links[0], { kind: 'encounter', id: enc.id });
  assert.deepEqual(enc.payload.items, [{ id: 'map', qty: 2 }]);
  assert.ok(!JSON.stringify(viewFor(loaded.state, p, 'stage')).includes('GM-only secret'));
  const changed = act(loaded.state, { t: 'prep.doc.update', id, title: 'My adventure' }).state;
  const repeated = act(changed, { t: 'prep.adventure.load', id: 'starter' });
  assert.deepEqual(repeated.result, { id, existing: true });
  assert.equal(repeated.state.prep.docs[1].title, 'My adventure');
  assert.equal(repeated.state.prepCards.length, 1);
  const classic = createState(p, 0, { ruleset: 'dnd5e' });
  assert.deepEqual(viewFor(classic, p, 'gm').gm.prep.adventures, []);
  assert.throws(() => act(classic, { t: 'prep.adventure.load', id: 'starter' }), /no prepared adventure/);
  const legacy = act(classic, { t: 'scene.roll', formula: '2d6' });
  assert.equal(legacy.state.scene.data.dice.length, 2);
  assert.throws(() => act(classic, { t: 'scene.check' }), /unavailable in this campaign/);
});

test('prepared evening remaps old adventure links, resolves a shared map, and runs scene combat idempotently', () => {
  const p = deserializePack(serializePack(loadPack(writePack(tmpDir(), {
    'adventures.json': [
      { id: 'quarter', title: 'Quarter', sections: [{ key: 'parts', label: 'Parts', kind: 'parts',
        items: [{ id: 'gate', title: 'Gate', links: [{ kind: 'encounter', id: 'guarded_gate' }] }] }],
      encounters: [{ id: 'guarded_gate', label: 'Guarded gate', mobs: [{ sourceId: 'guard', count: 2 }],
        items: [{ id: 'prize', qty: 2 }] }], evenings: [{ key: 'walk', title: 'The walk', floor: 1, scenes: [
        { id: 'start', type: 'explore', title: 'Start', goal: 'Look around', encounterId: 'guarded_gate' },
        { id: 'gate', type: 'fight', title: 'Gate', encounterId: 'guarded_gate', mapId: 'map_gate', npcs: ['guide'],
          checks: [{ id: 'listen', label: 'Listen', dcType: 'unopposed' }], secrets: [{ id: 'clue', text: 'GM only tunnel' }] },
      ] }] },
      { id: 'district_maps', title: 'Maps', sections: [{ key: 'locations', label: 'Maps', kind: 'refs', items: [
        { id: 'loc', ref: { kind: 'map', id: 'map_gate' } },
      ] }], maps: [{ id: 'map_gate', name: 'Gate map', image: '/pack/images/gate.svg' }],
      evenings: [{ key: 'another_walk', title: 'Next quarter', floor: 1, scenes: [{ id: 'gate', title: 'Second gate', type: 'explore' }] }] },
    ],
    'monsters.json': [{ id: 'guard', name: 'Guard', hpSlots: 4, attacks: [{ name: 'Stab', damage: '1d4' }] }],
    'items.json': [{ id: 'prize', name: 'Prize' }],
    'npcs.json': [{ id: 'guide', name: 'Guide' }],
  })).pack));
  let state = createState(p, 0);
  const act = (action) => reduce(state, { role: 'gm', ...action }, { ...ctx(), pack: p });
  const step = (action) => { const r = act(action); state = r.state; return r.result; };
  step({ t: 'player.add', name: 'Runner' });
  step({ t: 'prep.adventure.load', id: 'quarter' });
  step({ t: 'prep.adventure.load', id: 'district_maps' });
  for (const d of state.prep.docs) delete d.seedRefs; // legacy imports used the remapped section references only
  const installed = state.prepCards[0].id;
  const oldMap = state.maps.list[0].id;
  step({ t: 'enc.save', id: installed, label: 'My edited encounter', mobs: [{ sourceId: 'guard', count: 2 }] });
  step({ t: 'map.update', id: oldMap, name: 'My edited map' });
  assert.deepEqual(viewFor(state, p, 'gm').gm.prep.evenings, [
    { adventureId: 'quarter', key: 'walk', title: 'The walk', floor: 1 },
    { adventureId: 'district_maps', key: 'another_walk', title: 'Next quarter', floor: 1 },
  ]);
  const { id, sceneId } = step({ t: 'prep.evening.plan', adventureId: 'quarter', key: 'walk' });
  const evening = () => state.prep.docs.find((d) => d.id === id).evening;
  assert.equal(sceneId, 'start');
  assert.equal(state.prep.current, id);
  assert.equal(evening().scenes[1].encounterId, installed);
  assert.equal(evening().scenes[1].mapId, oldMap);
  assert.equal(state.prepCards.length, 1);
  assert.equal(state.maps.list.length, 1);
  step({ t: 'prep.scene.run', id, sceneId: 'start' });
  assert.equal(state.combat.active, false, 'a linked optional encounter does not start on entering an Explore scene');
  assert.equal(viewFor(state, p, 'gm').gm.prep.reach[0].item.links[0].id, installed);
  const explicit = act({ t: 'prep.scene.run', id, sceneId: 'start', fight: true });
  assert.equal(explicit.state.combat.active, true);
  assert.equal(explicit.state.combat.combatants.filter((c) => c.type === 'mob').length, 2);
  const begun = step({ t: 'prep.scene.run', id, sceneId: 'gate' });
  assert.equal(state.combat.active, true);
  assert.equal(state.combat.mapId, oldMap);
  assert.equal(state.combat.combatants.filter((c) => c.type === 'mob').length, 2);
  assert.equal(state.combat.victoryItems[0].qty, 2);
  const reach = viewFor(state, p, 'gm').gm.prep.reach[0];
  assert.deepEqual(reach.item.links.map((x) => x.kind), ['encounter', 'map', 'npc', 'item']);
  assert.equal(reach.checks[0].label, 'Listen');
  assert.ok(!JSON.stringify(viewFor(state, p, 'stage')).includes('GM only tunnel'));
  state = normalizeState(JSON.parse(JSON.stringify(state)), p, 0);
  const repeated = act({ t: 'prep.scene.run', id, sceneId: 'gate' });
  assert.equal(repeated.changed, false);
  assert.equal(repeated.result.combatId, begun.combatId);
  assert.equal(repeated.result.existing, true);
  assert.equal(state.combat.combatants.filter((c) => c.type === 'mob').length, 2);
  step({ t: 'prep.scene.update', id, sceneId: 'gate', patch: { played: false } });
  const next = step({ t: 'prep.evening.plan', adventureId: 'district_maps', key: 'another_walk' });
  const scenes = state.prep.docs.find((d) => d.id === next.id).evening.scenes;
  assert.deepEqual(scenes.map((s) => s.title), ['Second gate', 'Gate']);
  assert.equal(new Set(scenes.map((s) => s.id)).size, 2);
  assert.equal(scenes[1].encounterId, installed);
  assert.equal(scenes[1].mapId, oldMap);
  assert.equal(scenes[1].secrets[0].text, 'GM only tunnel');
  step({ t: 'enc.remove', id: installed });
  const replanned = step({ t: 'prep.evening.plan', adventureId: 'quarter', key: 'walk' });
  const afterRemoval = state.prep.docs.find((d) => d.id === replanned.id).evening.scenes;
  assert.equal(afterRemoval.find((s) => s.id === 'gate').encounterId, null);
  assert.equal(afterRemoval.find((s) => s.id === 'gate').mapId, oldMap);
  assert.equal(state.prepCards.length, 0, 'planning does not recreate the deleted encounter');
});

test('evening editor carries incomplete scenes and clues and atomically links NPCs and encounters', () => {
  const p = loadPack(writePack(tmpDir(), { 'monsters.json': [{ id: 'watcher', name: 'Watcher', hpSlots: 5 }] })).pack;
  let state = createState(p, 0);
  const act = (action) => reduce(state, { role: 'gm', ...action }, { ...ctx(), pack: p });
  const step = (action) => { const r = act(action); state = r.state; return r.result; };
  const { id, sceneId } = step({ t: 'prep.evening.plan' });
  const { sceneId: trap } = step({ t: 'prep.scene.add', id, type: 'trap' });
  step({ t: 'prep.evening.update', id, title: 'Tonight', minutes: 120 });
  step({ t: 'prep.scene.move', id, sceneId: trap, to: 0 });
  step({ t: 'prep.scene.update', id, sceneId, patch: { played: true, secrets: [
    { id: 'visible', text: 'Shared with everyone', revealed: true }, { id: 'left', text: 'Secret clue' },
  ] } });
  const { npcId } = step({ t: 'prep.scene.npc', id, sceneId: trap, name: 'Keeper', motive: 'Looking for a key', voice: 'Quietly' });
  const entry = state.library.npc.find((npc) => npc.id === npcId);
  assert.deepEqual([entry.personality, entry.voice, entry.intro], ['Looking for a key', 'Quietly', 'Quietly']);
  const { encounterId } = step({ t: 'prep.scene.encounter', id, sceneId: trap, add: { kind: 'monster', sourceId: 'watcher' } });
  step({ t: 'prep.scene.encounter', id, sceneId: trap, change: { index: 0, sourceId: 'watcher', kind: 'monster', delta: 1, hidden: false } });
  assert.throws(() => act({ t: 'prep.scene.encounter', id, sceneId: trap, change: { index: 0, sourceId: 'unknown', kind: 'monster', remove: true } }), /row changed/);
  assert.equal(state.prepCards[0].payload.mobs[0].count, 2);
  assert.equal(state.prepCards.length, 1);
  const nextId = step({ t: 'prep.evening.plan' }).id;
  const next = state.prep.docs.find((d) => d.id === nextId);
  assert.deepEqual(next.evening.scenes.map((s) => s.title), ['Trap scene', 'Loose ends']);
  assert.deepEqual(next.evening.scenes.flatMap((s) => s.secrets.map((c) => c.text)), ['Secret clue']);
  assert.equal(next.evening.scenes[0].checks[0].dcType, 'stat');
  assert.deepEqual(next.evening.scenes[0].npcs, [npcId]);
  assert.equal(next.evening.scenes[0].encounterId, encounterId);
  step({ t: 'prep.scene.remove', id: nextId, sceneId: trap });
  assert.equal(next.evening.scenes[0].title, 'Trap scene', 'earlier snapshots remain immutable');
  assert.notEqual(state.prep.docs.find((d) => d.id === nextId).evening.activeSceneId, trap);

  const classic = createState(p, 0, { ruleset: 'dnd5e' });
  const lazy = reduce(classic, { role: 'gm', t: 'prep.evening.plan' }, { ...ctx(), pack: p }).state.prep.docs[0].evening;
  assert.deepEqual(lazy.scenes.map((s) => s.type), ['explore', 'talk', 'fight', 'explore']);
  assert.equal(lazy.scenes[0].checks[0].dcType, 'fixed');
});

test('prepared map imports are hidden, linked to encounters and preserve existing campaign edits', () => {
  const seed = {
    id: 'outpost_maps', title: 'Outpost maps',
    sections: [{ key: 'scenes', label: 'Scenes', kind: 'parts', items: [
      { id: 'gate_scene', title: 'Gate', links: [{ kind: 'map', id: 'gate' }, { kind: 'encounter', id: 'patrol' }] },
    ] }],
    maps: [{ id: 'gate', name: 'Gate', image: '/pack/images/gate.svg', aspect: 1.6, zones: [
      { name: 'Path', shape: { x: 0, y: 0, w: 0.25, h: 0.5 }, text: 'A path', notes: 'Hidden patrol' },
    ] }],
    encounters: [{ id: 'patrol', label: 'Patrol', mapId: 'gate', mobs: [{ kind: 'monster', sourceId: 'guard' }] }],
  };
  const broken = { ...seed, id: 'maps_broken', encounters: [{ ...seed.encounters[0], mapId: 'missing' }] };
  const { pack: loaded } = loadPack(writePack(tmpDir(), {
    'adventures.json': [seed, broken],
    'monsters.json': [{ id: 'guard', name: 'Guard', hpSlots: 4 }],
  }));
  const p = deserializePack(serializePack(loaded));
  const act = (state, action) => reduce(state, { role: 'gm', ...action }, { ...ctx(), pack: p });
  const initial = act(createState(p, 0), { t: 'map.add', name: 'Gate', image: '/pack/images/custom.png' });
  assert.throws(() => act(initial.state, { t: 'prep.adventure.load', id: broken.id }), /no prepared map missing/);
  assert.equal(initial.state.maps.list.length, 1);
  assert.equal(initial.state.prepCards.length, 0);

  const imported = act(initial.state, { t: 'prep.adventure.load', id: seed.id });
  const { state } = imported;
  const [original, map] = state.maps.list;
  const [encounter] = state.prepCards;
  assert.equal(imported.result.maps, 1);
  assert.equal(original.image, '/pack/images/custom.png');
  assert.notEqual(map.id, original.id);
  assert.equal(map.zones[0].revealed, false);
  assert.equal(map.zones[0].notes, 'Hidden patrol');
  assert.equal(encounter.payload.mapId, map.id);
  assert.deepEqual(state.prep.docs[0].sections[0].items[0].links, [
    { kind: 'map', id: map.id }, { kind: 'encounter', id: encounter.id },
  ]);
  assert.deepEqual(state.combat, initial.state.combat);

  const renamed = act(state, { t: 'map.update', id: map.id, name: 'Renamed' });
  const repeated = act(renamed.state, { t: 'prep.adventure.load', id: seed.id });
  assert.deepEqual(repeated.result, { id: imported.result.id, existing: true });
  assert.deepEqual(repeated.state.maps.list.map((m) => m.name), ['Gate', 'Renamed']);
  assert.equal(repeated.state.prepCards.length, 1);

  const run = act(repeated.state, { t: 'enc.run', id: encounter.id });
  assert.equal(run.state.combat.mapId, map.id);
  assert.equal(run.result.bound, 1);
  const token = run.state.maps.list[1].tokens[0];
  assert.equal(token.ref, run.result.uids[0]);
  assert.equal(token.hidden, true);
});
