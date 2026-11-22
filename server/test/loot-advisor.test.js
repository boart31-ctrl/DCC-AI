// Loot advisor (C1): power scores, build fit, floor budgets, boss boxes, pity, and a two-floor campaign simulation
// that must never push a crawler over budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOOT_POLICY as P, itemPower, itemBuilds, crawlerBuild, offersFor, giveWarnings, budgetFor, RARITY_ORDER, itemGrade, crawlerRating, rewardMode, rollDrop, normalizeLootPolicy, bossBoxTier } from '../loot-advisor.js';
import { loadPack } from '../pack.js';
import { createState, reduce, viewFor } from '../state.js';
const viewForGm = (state, pack, ctx) => viewFor(state, pack, 'gm', ctx).gm.loot;
import { tmpDir, writePack } from './fixtures.js';

const seeded = (seed = 7) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

test('power: what an item does, never below its rarity; D&D-scale armour is flagged', () => {
  const plate = itemPower({ name: 'Old plate', rarity: 'common', effects: [{ target: 'armor', op: 'add', value: 4 }] });
  assert.equal(plate.power, 8);
  assert.equal(plate.underrated, true);
  assert.equal(plate.implied, 'legendary');
  assert.equal(itemPower({ rarity: 'uncommon', effects: [{ target: 'stat.str', op: 'add', value: 2 }] }).power, 1.5);
  assert.equal(itemPower({ rarity: 'rare', desc: 'Once per session: something wild' }).power, 2, 'text-only items count by rarity');
  assert.equal(itemPower({ rarity: 'common', attack: { dice: '2d6', stat: 'str' } }).power, 1.75);
  assert.deepEqual(itemBuilds({ name: 'Longbow', attack: { dice: '1d8', stat: 'dex', range: '80ft' } }), ['ranged']);
  assert.ok(itemBuilds({ name: 'Lockpick set', effects: [{ target: 'skill.lockpicking', value: 2 }] }).includes('stealth'));
  assert.deepEqual(itemBuilds({ name: 'Mug', builds: ['social'] }), ['social'], 'explicit builds win');
});

test('crawler build: sheet + GM steering', () => {
  const sheet = { stats: { str: { enhanced: 2 }, dex: { enhanced: 6 }, int: { enhanced: 3 }, cha: { enhanced: 3 }, con: { enhanced: 3 } },
    skills: [{ skillId: 'sneak', rank: 4, used: true }, { skillId: 'archery', name: 'Bow', rank: 2 }] };
  const b = crawlerBuild(sheet);
  assert.ok(['stealth', 'ranged'].includes(b.top[0]));
  assert.equal(crawlerBuild(sheet, { builds: ['magic'] }).top[0], 'magic', 'the GM can steer a crawler somewhere new');
});

// ---------- a synthetic library: 6 builds × 5 rarities × 3 + consumables ----------
const SLOTS = ['hands', 'torso', 'head', 'feet', 'accessories'];
const BUILD_FX = {
  melee: (v) => ({ attack: { dice: v ? `${v + 1}d6` : '1d6', stat: 'str' }, slot: 'hands' }),
  ranged: (v) => ({ attack: { dice: v ? `${v + 1}d6` : '1d6', stat: 'dex', range: '60ft' }, slot: 'hands', name: 'Bow' }),
  defense: (v) => ({ effects: [{ target: 'armor', op: 'add', value: Math.max(1, Math.round(v * 0.8)) }], slot: 'torso' }),
  stealth: (v) => ({ effects: [{ target: 'skill.sneak', op: 'add', value: 2 + v * 2 }], slot: 'feet' }),
  magic: (v) => ({ effects: [{ target: 'stat.int', op: 'add', value: 1 + v }], slot: 'head', name: 'Spell focus' }),
  social: (v) => ({ effects: [{ target: 'stat.cha', op: 'add', value: 1 + v }], slot: 'accessories' }),
};
const library = [];
for (const [b, fx] of Object.entries(BUILD_FX)) {
  RARITY_ORDER.forEach((rarity, v) => {
    for (let k = 0; k < 3; k++) {
      const f = fx(v);
      library.push({ id: `${b}_${rarity}_${k}`, name: `${f.name ?? b} ${rarity} ${k}`, rarity, slot: f.slot, effects: f.effects ?? [], ...(f.attack ? { attack: f.attack } : {}), builds: [b] });
    }
  });
}
for (const rarity of RARITY_ORDER) for (let k = 0; k < 4; k++) library.push({ id: `potion_${rarity}_${k}`, name: `Potion ${rarity} ${k}`, rarity, stackable: true, tags: ['consumable'] });
library.push({ id: 'map_x', name: 'Neighbourhood map', rarity: 'rare', tags: ['map'] });
const byId = new Map(library.map((it) => [it.id, it]));
const itemOf = (id) => byId.get(id);

const crawler = (build) => ({
  sheet: { stats: { str: { enhanced: build === 'melee' ? 6 : 3 }, dex: { enhanced: build === 'ranged' || build === 'stealth' ? 6 : 3 }, int: { enhanced: build === 'magic' ? 6 : 3 }, cha: { enhanced: build === 'social' ? 6 : 3 }, con: { enhanced: 3 } },
    skills: [] },
  prefs: { builds: [build] }, inventory: [], stats: { noFit: 0 }, build,
});

test('offers respect the floor budget, lift the boss box and hold back what does not fit', () => {
  const c = crawler('defense');
  c.inventory.push({ itemId: 'defense_uncommon_0', rarity: 'uncommon', equippedSlot: 'torso' }); // power 2 (armour +1 → 2)
  const r = offersFor(P, { tier: 'silver', floor: 1, sheet: c.sheet, prefs: c.prefs, inventory: c.inventory, items: library, itemOf, rng: seeded(3) });
  assert.equal(r.budget.cap, 4);
  for (const s of r.slots) for (const o of s.offers) {
    assert.ok(o.power <= 3 + 1e-9 || byId.get(o.itemId).stackable, `${o.name} fits the Floor 1 budget`);
    assert.notEqual(o.itemId, 'map_x', 'maps / quest items are never box loot');
  }
  assert.ok(r.held.some((h) => /over the Floor 1 budget/.test(h.reason)) || r.slots.every((s) => s.rarity !== 'rare'));
  const boss = offersFor(P, { tier: 'bronze', boss: true, floor: 1, sheet: c.sheet, prefs: c.prefs, inventory: [], items: library, itemOf, rng: seeded(5) });
  assert.ok(['uncommon', 'rare'].includes(boss.slots[0].rarity), 'a boss box lifts its best item one step');
  assert.equal(offersFor(P, { tier: 'bronze', floor: 1, sheet: c.sheet, prefs: c.prefs, stats: { noFit: 2 }, inventory: [], items: library, itemOf, rng: seeded(9) })
    .slots.flatMap((s) => s.offers).filter((o) => o.wild).length, 0, 'pity: after 2 misses, no wild cards');
});

test('simulated Floors 1–2: four crawlers never exceed the budget, most boxes fit, nothing absurd drops', () => {
  const rng = seeded(42);
  const party = ['melee', 'ranged', 'magic', 'stealth'].map(crawler);
  let boxes = 0;
  let fitting = 0;
  const seen = new Set();
  const equip = (c, it) => {
    if (it.stackable || !it.slot) return;
    const cur = c.inventory.find((i) => i.equippedSlot === it.slot);
    if (cur && itemPower(itemOf(cur.itemId)).power >= itemPower(it).power) { c.inventory.push({ itemId: it.id, rarity: it.rarity, equippedSlot: null }); return; }
    if (cur) cur.equippedSlot = null;
    c.inventory.push({ itemId: it.id, rarity: it.rarity, equippedSlot: it.slot });
  };
  const run = (floor, plan) => {
    for (const [tier, boss, times] of plan) for (let n = 0; n < times; n++) for (const c of party) {
      const r = offersFor(P, { tier, boss, floor, sheet: c.sheet, prefs: c.prefs, stats: c.stats, inventory: c.inventory, items: library, itemOf, rng });
      boxes++;
      // The GM takes the first offer of each slot (the advisor's best pick) — the lazy-GM case.
      const picks = r.slots.map((s) => itemOf(s.offers[0].itemId));
      const fit = picks.some((it) => itemBuilds(it).includes(c.build));
      if (fit) fitting++;
      c.stats.noFit = fit ? 0 : c.stats.noFit + 1;
      for (const it of picks) { seen.add(it.rarity); equip(c, it); }
      const used = c.inventory.filter((i) => i.equippedSlot).reduce((s, i) => s + itemPower(itemOf(i.itemId)).power, 0);
      assert.ok(used <= budgetFor(P, floor) + P.stretch + 1e-9, `${c.build} on Floor ${floor}: ${used} ≤ ${budgetFor(P, floor)} (+${P.stretch} stretch)`);
      for (const it of picks) assert.ok(RARITY_ORDER.indexOf(it.rarity) <= RARITY_ORDER.indexOf(P.floorRarity[floor - 1]) + (boss ? 1 : 0), `${it.rarity} on Floor ${floor}`);
    }
  };
  // Book pacing: per floor ~3 neighbourhood bosses (Bronze Boss Box), achievements (Bronze), a quest (Silver), a sponsor.
  run(1, [['bronze', true, 3], ['bronze', false, 6], ['silver', false, 1], ['sponsor', false, 1]]);
  run(2, [['bronze', true, 3], ['silver', true, 1], ['bronze', false, 6], ['silver', false, 2], ['sponsor', false, 1]]);
  assert.ok(fitting / boxes >= 0.85, `fit rate ${Math.round((fitting / boxes) * 100)}%`);
  assert.equal(seen.has('legendary'), false);
});

test('loot.offers / loot.prefs / loot.box / item.give warnings through the reducer', () => {
  const { pack } = loadPack(writePack(tmpDir(), {
    'pack.json': { id: 't', name: 'T', lootTiers: [{ id: 'bronze', name: 'Bronze Box' }, { id: 'silver', name: 'Silver Box' }] },
    'items.json': library.filter((it) => it.id.startsWith('melee_') || it.id.startsWith('defense_') || it.id.startsWith('potion_')),
    'loot.json': { bronze: [{ item: 'potion_common_0', weight: 1 }], silver: [{ item: 'potion_uncommon_0', weight: 1 }] },
  }));
  let n = 0;
  const ctx = { pack, now: 1000, rng: seeded(11), genId: (p) => `${p}_${++n}` };
  let state = createState(pack, 0);
  const add = reduce(state, { role: 'gm', t: 'player.add', name: 'Carl' }, ctx);
  state = add.state;
  const playerId = add.result.playerId;
  state = reduce(state, { role: 'gm', t: 'loot.prefs', playerId, builds: ['melee'] }, ctx).state;
  assert.deepEqual(state.players[0].lootPrefs.builds, ['melee']);
  assert.throws(() => reduce(state, { role: 'gm', t: 'loot.prefs', playerId, builds: ['wizardry'] }, ctx), /builds/);
  const offers = reduce(state, { role: 'gm', t: 'loot.offers', playerId, tier: 'bronze' }, ctx);
  assert.equal(offers.changed, false);
  assert.equal(offers.result.slots.length, 2);
  const picks = offers.result.slots.map((s) => s.offers[0].itemId);
  assert.ok(offers.result.slots.flatMap((s) => s.offers).some((o) => o.builds.includes('melee')));
  assert.throws(() => reduce(state, { role: 'gm', t: 'loot.box', playerId, tier: 'bronze', itemIds: ['melee_epic_0'] }, ctx), /above what a bronze box holds/);
  const box = reduce(state, { role: 'gm', t: 'loot.box', playerId, tier: 'bronze', itemIds: picks }, ctx);
  state = box.state;
  assert.equal(state.players[0].inventory.length, picks.length);
  assert.ok(box.result.gold >= 1 && box.result.gold <= 10, 'a bronze box holds 1d10 gold');
  assert.equal(state.players[0].gold, box.result.gold);
  assert.equal(state.scene.kind, 'loot');
  assert.equal(state.players[0].lootStats.boxes, 1);
  const gift = reduce(state, { role: 'gm', t: 'item.give', playerId, itemId: 'defense_legendary_0' }, ctx);
  assert.ok(gift.result.warnings.some((w) => /above the usual Floor 1/.test(w)));
});

test('C1b: grades, the crawler rating, reward modes, fragile items, mob drops, boss ranks', () => {
  assert.equal(itemGrade(P, { rarity: 'rare', effects: [{ target: 'armor', op: 'add', value: 1 }] }, 1), 'S', 'DR 1 is a lot on Floor 1');
  assert.equal(itemGrade(P, { rarity: 'common', attack: { dice: '1d8', stat: 'str' } }, 1), 'C');
  assert.equal(itemGrade(P, { rarity: 'rare', stackable: true }, 1), 'A', 'consumables grade by rarity');
  const glass = { id: 'glass', name: 'Glass sword', rarity: 'epic', fragile: true, attack: { dice: '3d6', stat: 'str' } };
  assert.equal(itemPower(glass).power, itemPower({ ...glass, fragile: false }).power / 2, 'fragile counts half');
  const empty = crawlerRating(P, { sheet: {}, inventory: [], itemOf, floor: 1, level: 1 });
  assert.ok(['C', 'D'].includes(empty.grade));
  assert.equal(rewardMode('auto', empty.grade), 'catchup');
  assert.equal(rewardMode('auto', 'S'), 'ahead');
  assert.equal(rewardMode('standard', 'D'), 'standard', 'the GM can override');
  const geared = crawlerRating(P, { sheet: {}, inventory: [{ itemId: 'melee_rare_0', equippedSlot: 'hands' }, { itemId: 'defense_uncommon_0', equippedSlot: 'torso' }], itemOf, floor: 1, level: 3, prefs: { builds: ['melee'] } });
  assert.ok(geared.score > empty.score);
  assert.equal(geared.items.length, 2);
  // Catch-up: no wild cards, best item lifted, budget stretched.
  const cu = offersFor(P, { tier: 'bronze', mode: 'catchup', floor: 1, sheet: {}, prefs: { builds: ['melee'] }, inventory: [], items: library, itemOf, rng: seeded(4) });
  assert.equal(cu.budget.cap, budgetFor(P, 1) + P.stretch);
  assert.equal(cu.slots.flatMap((x) => x.offers).filter((o) => o.wild).length, 0);
  // Ahead: the box leans to consumables.
  const ah = offersFor(P, { tier: 'bronze', mode: 'ahead', floor: 1, sheet: {}, prefs: { builds: ['melee'] }, inventory: [{ itemId: 'melee_uncommon_0', equippedSlot: 'hands' }], items: library, itemOf, rng: seeded(4) });
  assert.ok(ah.slots.flatMap((x) => x.offers).some((o) => byId.get(o.itemId).stackable));
  // Drops: off by default, the pack's weights decide; ~1 in 10 uncommon, ~1 in 50 rare for an ordinary mob.
  assert.equal(rollDrop(P, 'mob', seeded(1)), 'none');
  const dcc = normalizeLootPolicy({ drops: { mob: { none: 28, junk: 30, common: 30, uncommon: 10, rare: 2 } } });
  const rng = seeded(99);
  const n = {};
  for (let i = 0; i < 5000; i++) { const r = rollDrop(dcc, 'mob', rng); n[r] = (n[r] ?? 0) + 1; }
  assert.ok(n.uncommon / 5000 > 0.08 && n.uncommon / 5000 < 0.12, `uncommon ${n.uncommon}`);
  assert.ok(n.rare / 5000 > 0.01 && n.rare / 5000 < 0.03, `rare ${n.rare}`);
  assert.equal(bossBoxTier(P, 'City Boss'), 'gold');
  assert.equal(bossBoxTier(P, 'Neighborhood Boss'), 'bronze');
});

test('C1b reducer: boss drop → pending box → opened from it; achievement box waits too; campaign settings', () => {
  const { pack } = loadPack(writePack(tmpDir(), {
    'pack.json': { id: 't', name: 'T', lootTiers: [{ id: 'bronze', name: 'Bronze Box' }, { id: 'silver', name: 'Silver Box' }],
      lootPolicy: { drops: { mob: { uncommon: 1 } } } },
    'items.json': library.filter((it) => !it.id.startsWith('map')),
    'loot.json': { bronze: [{ item: 'potion_common_0', weight: 1 }], silver: [{ item: 'potion_uncommon_0', weight: 1 }] },
    'achievements.json': [{ id: 'first_blood', title: 'First Blood', reward: 'A Bronze Box', box: 'bronze' }],
  }));
  let n = 0;
  const ctx = { pack, now: 1000, rng: seeded(21), genId: (p) => `${p}_${++n}` };
  let state = createState(pack, 0);
  const add = reduce(state, { role: 'gm', t: 'player.add', name: 'Carl' }, ctx);
  state = add.state;
  const playerId = add.result.playerId;
  state = reduce(state, { role: 'gm', t: 'ach.award', playerId, achId: 'first_blood' }, ctx).state;
  assert.equal(state.players[0].pendingBoxes[0].tier, 'bronze');
  const pend = state.players[0].pendingBoxes[0].id;
  const o = reduce(state, { role: 'gm', t: 'loot.offers', playerId, tier: 'bronze' }, ctx).result;
  assert.ok(['catchup', 'standard'].includes(o.mode));
  assert.ok(o.rating.grade);
  state = reduce(state, { role: 'gm', t: 'loot.box', playerId, tier: 'bronze', pendingId: pend, itemIds: [o.slots[0].offers[0].itemId] }, ctx).state;
  assert.equal(state.players[0].pendingBoxes.length, 0);
  state = reduce(state, { role: 'gm', t: 'loot.settings', settings: { budget: [5, 8], wildcard: 0.1 } }, ctx).state;
  assert.deepEqual(state.lootSettings, { budget: [5, 8], wildcard: 0.1 });
  assert.throws(() => reduce(state, { role: 'gm', t: 'loot.settings', settings: { budget: 'lots' } }, ctx), /budget/);
  assert.throws(() => reduce(state, { role: 'gm', t: 'loot.settings', settings: { teleport: 1 } }, ctx), /unknown/);
  const ov = viewForGm(state, pack, ctx);
  assert.equal(ov.policy.budget[0], 5);
  assert.equal(ov.crawlers[0].name, 'Carl');
  state = reduce(state, { role: 'gm', t: 'loot.prefs', playerId, mode: 'ahead' }, ctx).state;
  assert.equal(reduce(state, { role: 'gm', t: 'loot.offers', playerId, tier: 'bronze' }, ctx).result.mode, 'ahead');
});

test('fragile inventory weapons break once and an undone strike restores its own copy', () => {
  const { pack } = loadPack(writePack(tmpDir(), { 'items.json': [
    { id: 'glass', name: 'Glass foil', builds: ['melee'], attack: { dice: '1d6' }, fragile: { breakOn: 'nat1', chance: 1 } },
  ] }));
  const ctx = { pack, now: 10, rng: seeded(52) };
  const gm = (s, a) => reduce(s, { role: 'gm', ...a }, ctx);
  let s = gm(createState(pack, 0), { t: 'player.add', name: 'Jo' }).state;
  const playerId = s.players[0].id;
  s = gm(s, { t: 'item.give', playerId, itemId: 'glass' }).state;
  const uid = s.players[0].inventory[0].uid;
  const strike = { t: 'roll', playerId, what: { kind: 'attack', uid } };
  s = gm(s, { ...strike, entered: 12 }).state;
  assert.equal(s.players[0].inventory.length, 1);
  const broken = gm(s, { ...strike, entered: 1 });
  assert.equal(broken.state.players[0].inventory.length, 0);
  assert.equal(broken.state.feed.at(-1).replay.name, 'Glass foil');
  assert.ok(broken.lines.some((line) => line.text.includes('shattered')));
  assert.throws(() => gm(broken.state, strike), /attack/);
  const restored = gm(broken.state, { t: 'roll.undo', playerId }).state;
  assert.equal(restored.players[0].inventory[0].uid, uid);
});

test('stage gets the party build grades only during the chosen scene, phones receive no grades', () => {
  const { pack } = loadPack(writePack(tmpDir()));
  const ctx = { pack };
  let s = reduce(createState(pack, 0), { role: 'gm', t: 'player.add', name: 'Jo' }, ctx).state;
  assert.equal(viewFor(s, pack, 'stage').scene.data.crawlers, undefined);
  s = reduce(s, { role: 'gm', t: 'scene.set', kind: 'builds' }, ctx).state;
  const [row] = viewFor(s, pack, 'stage').scene.data.crawlers;
  assert.equal(row.name, 'Jo');
  assert.ok('SABCD'.includes(row.grade));
  assert.equal(viewFor(s, pack, 'player', { playerId: s.players[0].id }).scene.data.crawlers, undefined);
});

test('5e budgets follow the recipient level and rarity changes at levels 5, 11 and 17', () => {
  const { pack } = loadPack(writePack(tmpDir()));
  let s = createState(pack, 0);
  s.campaign.ruleset = 'dnd5e';
  const ctx = { pack };
  s = reduce(s, { role: 'gm', t: 'player.add', name: 'Jo' }, ctx).state;
  for (const [lv, rarity] of [[1,'uncommon'],[5,'rare'],[11,'epic'],[17,'legendary']]) {
    s.players[0].level = lv;
    const loot = viewForGm(s, pack, ctx);
    assert.equal(loot.policy.floorRarity[lv-1], rarity);
    assert.equal(loot.crawlers[0].rating.gear.cap, loot.policy.budget[lv-1]);
  }
});

test('a fragile weapon that breaks on a hit still deals linked damage exactly once', () => {
  const { pack } = loadPack(writePack(tmpDir(), { 'items.json': [
    { id: 'glass', name: 'Glass spear', attack: { dice: '1d6' }, fragile: { breakOn: 'hit', chance: 1 } },
  ] }));
  const ctx = { pack, now: 10, rng: seeded(52) };
  const gm = (s, a) => reduce(s, { role: 'gm', ...a }, ctx);
  let s = gm(createState(pack, 0), { t: 'player.add', name: 'Jo' }).state;
  const playerId = s.players[0].id;
  const mob = gm(s, { t: 'combat.addAdhoc', name: 'Dummy', hp: 10, evade: 0, hidden: false });
  const target = mob.result.uids[0];
  s = gm(mob.state, { t: 'item.give', playerId, itemId: 'glass' }).state;
  const uid = s.players[0].inventory[0].uid;
  const strike = { t: 'roll', playerId, target, what: { kind: 'attack', uid } };
  const hit = gm(s, { ...strike, entered: 20 });
  assert.equal(hit.result.hit, true);
  assert.equal(hit.state.players[0].inventory.length, 0);
  const damage = { ...strike, after: hit.result.rollId, what: { ...strike.what, part: 'damage' }, entered: 3 };
  const landed = gm(hit.state, damage);
  assert.ok(landed.state.combat.combatants.find((c) => c.uid === target).hp < 10);
  assert.throws(() => gm(landed.state, damage), /already rolled/);
});
