// Loot advisor (C1): keeps rewards inside a power budget and offers items that fit each crawler's build.
//
// The problem it solves: one lucky box must never break a campaign (an "Armor +4" on Floor 1 makes most mobs
// harmless), and the GM must not have to vet every item. So:
//   1. Every item gets a POWER score (parsed from its effects / attack, never below its rarity's floor) and BUILD
//      tags (melee, ranged, defense, stealth, magic, social, support, crafty, boom, pet, utility).
//   2. A box tier decides how many items and which rarities can come out (weights); boss boxes lift the best item
//      one rarity step ("better than the same tier"). The floor decides the per-crawler budget (equipped power).
//   3. For each item slot the advisor offers 3 candidates: the best fits for the crawler's build (what the sheet
//      shows + what the GM steers) and sometimes one wild card. Over-budget gear is held back with a reason.
//   4. Bad-luck protection: after `pity` boxes without a fitting item, the next box has no wild card.
// Pure and deterministic for a given rng; numbers live in a policy the pack can override (pack.json "lootPolicy").

export const BUILDS = {
  melee: 'Brawler', ranged: 'Sharpshooter', defense: 'Tank', stealth: 'Sneak', magic: 'Caster', social: 'Face',
  support: 'Medic', crafty: 'Tinkerer', boom: 'Boomer', pet: 'Pet master', utility: 'Utility',
};
export const BUILD_IDS = Object.keys(BUILDS);
export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const RARITY_MIN = { common: 0, uncommon: 1, rare: 2, epic: 3.5, legendary: 5 }; // power floor per rarity
const RARITY_TOP = { common: 1, uncommon: 2, rare: 3.5, epic: 5, legendary: Infinity };

export const DEFAULT_LOOT_POLICY = Object.freeze({
  // Which rarities a box can hold (weights per item).
  weights: {
    bronze: { common: 80, uncommon: 20 },
    silver: { common: 30, uncommon: 55, rare: 15 },
    gold: { uncommon: 40, rare: 50, epic: 10 },
    platinum: { rare: 50, epic: 45, legendary: 5 },
    legendary: { epic: 60, legendary: 40 },
    celestial: { legendary: 100 },
    sponsor: { common: 40, uncommon: 45, rare: 15 },
  },
  items: { bronze: 2, silver: 2, gold: 3, platinum: 3, legendary: 3, celestial: 4, sponsor: 1 },
  gold: { bronze: '1d10', silver: '1d10*100', gold: '2d10*100', platinum: '5d10*100', legendary: '1d10*1000', celestial: '5d10*1000', sponsor: '' },
  // Equipped power a crawler may carry, per floor (index 0 = Floor 1). Consumables don't count.
  // David 22 Nov: generous — 4 on Floor 1, and `stretch` more when a boss box or catch-up mode allows it.
  budget: [4, 7, 11, 16, 22, 29, 37, 46, 56],
  stretch: 1,
  // Highest rarity a normal (non-boss) reward should hold, per floor.
  floorRarity: ['uncommon', 'rare', 'epic', 'epic', 'legendary', 'legendary', 'legendary', 'legendary', 'legendary'],
  // Boss box by boss tier (book: Neighborhood Bronze … Floor Celestial).
  bossBox: { neighborhood: 'bronze', borough: 'silver', city: 'gold', province: 'platinum', country: 'legendary', floor: 'celestial' },
  // Ordinary drops (normal rewards from a gift): highest rarity a mob / an elite usually gives.
  dropRarity: { mob: 'common', elite: 'uncommon' },
  // What a downed mob drops by itself (per body, weights incl. "none" and "junk"). David 22 Nov: an ordinary mob
  // gives something now and then, ~1 in 10 uncommon, ~1 in 50 rare; elites more and better; bosses pay a box.
  // Engine default: off (a pack turns it on; the DCC pack uses mob {none 28, junk 30, common 30, uncommon 10, rare 2},
  // elite {none 5, junk 15, common 40, uncommon 30, rare 9, epic 1}).
  drops: { mob: { none: 1 }, elite: { none: 1 } },
  offers: 3,
  wildcard: 0.3,
  pity: 2,
  // Fragile items (glass sword +4: may break) count this share of their power against the budget.
  fragileFactor: 0.5,
});

export const REWARD_MODES = ['auto', 'catchup', 'standard', 'ahead'];
export const GRADES = ['S', 'A', 'B', 'C', 'D'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const rIndex = (r) => Math.max(0, RARITY_ORDER.indexOf(r));

/** pack.json "lootPolicy" over the defaults (shallow per key, numbers checked). Never throws. */
export function normalizeLootPolicy(raw, warnings = []) {
  const d = DEFAULT_LOOT_POLICY;
  if (raw == null) return d;
  if (!isObj(raw)) { warnings.push('pack.json "lootPolicy": expected an object, using defaults'); return d; }
  const out = { ...d };
  const obj = (k) => (isObj(raw[k]) ? { ...d[k], ...raw[k] } : d[k]);
  out.weights = obj('weights');
  out.items = obj('items');
  out.gold = obj('gold');
  out.bossBox = obj('bossBox');
  out.dropRarity = obj('dropRarity');
  if (Array.isArray(raw.budget) && raw.budget.every((x) => Number.isFinite(x) && x > 0)) out.budget = raw.budget.slice(0, 20);
  if (Array.isArray(raw.floorRarity) && raw.floorRarity.every((x) => RARITY_ORDER.includes(x))) out.floorRarity = raw.floorRarity.slice(0, 20);
  for (const k of ['offers', 'pity', 'stretch']) if (Number.isInteger(raw[k]) && raw[k] >= 0 && raw[k] <= 6) out[k] = raw[k];
  if (Number.isFinite(raw.fragileFactor) && raw.fragileFactor >= 0 && raw.fragileFactor <= 1) out.fragileFactor = raw.fragileFactor;
  if (isObj(raw.drops)) {
    out.drops = { ...d.drops };
    for (const [k, w] of Object.entries(raw.drops)) {
      if (!['mob', 'elite'].includes(k) || !isObj(w)) continue;
      const clean = Object.fromEntries(Object.entries(w).filter(([r, n]) => (r === 'none' || r === 'junk' || RARITY_ORDER.includes(r)) && Number.isFinite(n) && n >= 0 && n <= 1000));
      if (Object.values(clean).some((n) => n > 0)) out.drops[k] = clean;
    }
  }
  if (Number.isFinite(raw.wildcard) && raw.wildcard >= 0 && raw.wildcard <= 1) out.wildcard = raw.wildcard;
  return out;
}

const atFloor = (list, floor) => list[Math.max(0, Math.min(list.length - 1, (floor || 1) - 1))];
export const budgetFor = (policy, floor) => atFloor(policy.budget, floor);
export const floorRarityFor = (policy, floor) => atFloor(policy.floorRarity, floor);

// ---------- items ----------

const diceAvg = (dice) => {
  let sum = 0;
  for (const m of String(dice ?? '').matchAll(/(\d*)d(\d+)/g)) sum += (Number(m[1] || 1) * (Number(m[2]) + 1)) / 2;
  const flat = /[+-]\s*(\d+)\s*$/.exec(String(dice ?? ''));
  return sum + (flat ? Number(flat[1]) * (String(dice).includes('-') ? -1 : 1) : 0) || Number(dice) || 0;
};
export const isConsumable = (it) => !!(it.stackable || (it.tags ?? []).some((t) => ['consumable', 'potion', 'scroll'].includes(t)) || it.use?.consume);
const NOT_LOOT = new Set(['quest', 'map', 'boss', 'reward', 'junk', 'key']);
export const isLootable = (it) => it && it.lootable !== false && !(it.tags ?? []).some((t) => NOT_LOOT.has(t));

/** Power from what the item does. 1 point ≈ +1 to hit; +1 DR is 2 (whole health slots), +1 stat 0.75, +1 rank 0.3. */
export function parsedPower(it) {
  let p = 0;
  for (const e of it.effects ?? []) {
    const v = Number(e.value);
    if (!Number.isFinite(v) || e.op && e.op !== 'add') continue;
    const t = String(e.target ?? '');
    if (t === 'armor' || t === 'dr') p += 2 * v;
    else if (t === 'evade') p += 1.5 * v;
    else if (t.startsWith('stat.')) p += 0.75 * v;
    else if (t.startsWith('skill.')) p += 0.3 * v;
    else if (t === 'move' || t === 'step') p += v / 20;
    else if (t.startsWith('resist.') || t.startsWith('immune.')) p += 1;
    else if (t === 'tohit' || t === 'damage' || t === 'check') p += v;
    else p += 0.5 * Math.abs(v);
  }
  if (it.attack) p += Math.max(0, (diceAvg(it.attack.dice) - 3.5) / 2);
  return Math.round(p * 100) / 100;
}

/** { power, implied, underrated } — power never below the rarity floor (text-only abilities count by rarity). */
export function itemPower(it) {
  const parsed = parsedPower(it);
  const rarity = RARITY_ORDER.includes(it.rarity) ? it.rarity : 'common';
  const full = Math.max(parsed, RARITY_MIN[rarity]);
  const implied = RARITY_ORDER.find((r) => full <= RARITY_TOP[r]) ?? 'legendary';
  // A fragile item (it can break) is cool now and gone later: only part of its power counts against the budget.
  const power = it.fragile ? Math.round(full * (DEFAULT_LOOT_POLICY.fragileFactor) * 100) / 100 : full;
  return { power, full, parsed, implied, fragile: !!it.fragile, underrated: !it.fragile && rIndex(implied) > rIndex(rarity) };
}

const KW = [
  ['stealth', /sneak|stealth|lockpick|acrobat|decept|trap|pickpocket|assassin|shadow/],
  ['magic', /channel|concentrat|arcane|spell|scroll|tome|mana|wand|staff|magic missile|\bint\b/],
  ['social', /persua|perform|intimid|carous|barter|charm|cha\b|charisma/],
  ['support', /first.?aid|heal|medic|bandage|cure|antidote/],
  ['crafty', /craft|jury|scaveng|cook|tinker|repair|tool/],
  ['boom', /dynamite|bomb|explos|grenade|blast/],
  ['pet', /\bpet\b|critter|leash|treat/],
  ['ranged', /\bbow\b|crossbow|sling|throw|gun|rifle|pistol|dart|javelin|ranged/],
];

/** Build tags of an item: explicit `builds` first, else derived from effects, attack, slot, tags and name. */
export function itemBuilds(it) {
  if (Array.isArray(it.builds) && it.builds.length) return it.builds.filter((b) => BUILDS[b]);
  const out = new Set();
  // Only what an item improves counts (armour with -2 Sneak is not a Sneak item).
  const plus = (it.effects ?? []).filter((e) => !(Number(e.value) < 0));
  const text = `${it.name ?? ''} ${(it.tags ?? []).join(' ')} ${plus.map((e) => e.target).join(' ')} ${it.attack?.skill ?? ''}`.toLowerCase();
  for (const [b, re] of KW) if (re.test(text)) out.add(b);
  if (it.attack) out.add(it.attack.stat === 'dex' && (it.attack.range || out.has('ranged')) ? 'ranged' : it.attack.stat === 'int' ? 'magic' : 'melee');
  if (plus.some((e) => ['armor', 'dr', 'evade'].includes(e.target)) || (it.tags ?? []).some((t) => t === 'armor' || t === 'shield')) out.add('defense');
  if (plus.some((e) => e.target === 'stat.str')) out.add('melee');
  if (plus.some((e) => e.target === 'stat.dex')) out.add(out.has('ranged') ? 'ranged' : 'stealth');
  if (plus.some((e) => e.target === 'stat.con')) out.add('defense');
  if (!out.size) out.add('utility');
  return [...out];
}

// ---------- crawlers ----------

const STAT_BUILDS = { str: ['melee', 'defense'], dex: ['ranged', 'stealth'], int: ['magic'], cha: ['social'], con: ['defense'] };

/**
 * What a crawler is built for, from the sheet: stats above the median, skill ranks (+1 when used this session),
 * attack skills and spells. GM steering (p.lootPrefs.builds) weighs 3× and is listed first.
 * Returns { scores: {build: n}, top: [build…], steered: [build…] }.
 */
export function crawlerBuild(sheet, prefs = {}) {
  const scores = Object.fromEntries(BUILD_IDS.map((b) => [b, 0]));
  const stats = sheet?.stats ?? {};
  const values = Object.entries(stats).map(([k, v]) => [k, Number(v?.enhanced ?? v?.value ?? v) || 0]);
  const median = values.map(([, v]) => v).sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
  for (const [k, v] of values) if (v > median) for (const b of STAT_BUILDS[k] ?? []) scores[b] += 1 + (v - median) * 0.5;
  for (const s of sheet?.skills ?? []) {
    const name = `${s.skillId ?? ''} ${s.name ?? ''}`.toLowerCase();
    const w = (Number(s.rank) || 0) * 0.3 + (s.used ? 1 : 0);
    if (!w) continue;
    let hit = false;
    for (const [b, re] of KW) if (re.test(name)) { scores[b] += w; hit = true; }
    if (!hit && /combat|blade|sword|axe|club|brawl|unarmed|weapon|hammer|spear/.test(name)) scores.melee += w;
  }
  for (const sp of sheet?.spells ?? []) if (sp) scores.magic += 0.5;
  const steered = (prefs.builds ?? []).filter((b) => BUILDS[b]);
  for (const b of steered) scores[b] += 3;
  scores.utility = Math.min(scores.utility, 0.5);
  // The GM's steering always leads; the sheet fills the rest.
  const top = [...steered, ...BUILD_IDS.filter((b) => scores[b] > 0 && !steered.includes(b)).sort((a, b) => scores[b] - scores[a])].slice(0, 3);
  return { scores, top, steered };
}

/** Equipped power (consumables and unequipped items don't count) and per-slot best power. */
export function carriedPower(inventory, itemOf) {
  let used = 0;
  const bySlot = {};
  for (const inv of inventory ?? []) {
    if (!inv.equippedSlot) continue;
    const it = itemOf(inv.itemId);
    if (!it || isConsumable(it)) continue;
    const { power } = itemPower({ ...it, rarity: inv.rarity ?? it.rarity });
    used += power;
    bySlot[inv.equippedSlot] = Math.max(bySlot[inv.equippedSlot] ?? 0, power);
  }
  return { used: Math.round(used * 100) / 100, bySlot };
}

// ---------- offers ----------

function pickWeighted(rng, weights) {
  const entries = Object.entries(weights ?? {}).filter(([r, w]) => RARITY_ORDER.includes(r) && w > 0);
  const total = entries.reduce((n, [, w]) => n + w, 0);
  if (!total) return 'common';
  let x = rng() * total;
  for (const [r, w] of entries) { x -= w; if (x < 0) return r; }
  return entries.at(-1)[0];
}

const slotOf = (it) => (it.slot === 'accessory' ? 'accessories' : it.slot) ?? null;

/**
 * Offers for one crawler and one box.
 * input: { tier, boss?, floor, sheet, inventory, prefs, stats: {noFit}, items: [library items], itemOf(id), owned: Set(itemId) party-wide, rng }
 * → { tier, boss, floor, budget: {cap, used}, build, slots: [{ rarity, offers: [{ itemId, name, rarity, power, builds, fit, wild, why }] }],
 *     held: [{ itemId, name, reason }] }
 */
export function offersFor(policy, input) {
  const P = policy ?? DEFAULT_LOOT_POLICY;
  const rng = input.rng ?? Math.random;
  const floor = input.floor || 1;
  const mode = REWARD_MODES.includes(input.mode) && input.mode !== 'auto' ? input.mode : 'standard';
  // Boss boxes and catch-up may stretch the budget a little (David: "4, sometimes 5").
  const cap = budgetFor(P, floor) + (input.boss || mode === 'catchup' ? P.stretch ?? 0 : 0);
  const carried = carriedPower(input.inventory, input.itemOf);
  let { used } = carried;
  const bySlot = { ...carried.bySlot };
  const usedBefore = used;
  const build = crawlerBuild(input.sheet, input.prefs);
  const steer = new Set(build.steered);
  const block = new Set(input.prefs?.block ?? []);
  const weights = P.weights[input.tier] ?? P.weights.bronze;
  const count = Math.max(1, P.items[input.tier] ?? 1);
  const pity = (input.stats?.noFit ?? 0) >= P.pity || mode === 'catchup';
  const lean = Number.isFinite(input.prefs?.lean) ? input.prefs.lean : P.wildcard;
  const maxNormal = rIndex(floorRarityFor(P, floor));
  const pool = (input.items ?? []).filter((it) => isLootable(it) && !block.has(it.id) && !(it.unique && input.owned?.has(it.id)));
  const held = new Map();
  const taken = new Set();
  const slots = [];

  for (let i = 0; i < count; i++) {
    let rarity = pickWeighted(rng, weights);
    // The best item of a boss box is one step better; nothing else may pass the floor's normal ceiling.
    if ((input.boss || mode === 'catchup') && i === 0) rarity = RARITY_ORDER[Math.min(RARITY_ORDER.length - 1, rIndex(rarity) + 1)];
    else if (rIndex(rarity) > maxNormal + (input.boss ? 1 : 0)) rarity = RARITY_ORDER[maxNormal];
    // On-build = the GM's steering if any, else what the sheet shows.
    const wanted = new Set(build.steered.length ? build.steered : build.top);
    const onBuild = (it) => itemBuilds(it).some((b) => wanted.has(b));
    let cands = pool.filter((it) => it.rarity === rarity && !taken.has(it.id));
    // Nothing for this build at this rarity: an on-build item one or two steps lower beats an off-build one.
    if (wanted.size && !cands.some(onBuild)) {
      for (let step = rIndex(rarity) - 1; step >= Math.max(0, rIndex(rarity) - 2); step--) {
        const lower = pool.filter((it) => it.rarity === RARITY_ORDER[step] && !taken.has(it.id) && onBuild(it));
        if (lower.length) { cands = [...lower, ...cands]; break; }
      }
    }
    for (let step = rIndex(rarity) - 1; !cands.length && step >= 0; step--) cands = pool.filter((it) => it.rarity === RARITY_ORDER[step] && !taken.has(it.id));
    const scored = [];
    for (const it of cands) {
      const { power } = itemPower(it);
      const builds = itemBuilds(it);
      const consumable = isConsumable(it);
      const slot = slotOf(it);
      const replaces = slot ? bySlot[slot] ?? 0 : 0;
      if (!consumable && used - replaces + power > cap + 1e-9) {
        held.set(it.id, { itemId: it.id, name: it.name, reason: `over the Floor ${floor} budget (${Math.round((used - replaces + power) * 10) / 10} / ${cap})` });
        continue;
      }
      const why = [];
      let fit = 0;
      for (const b of builds) {
        if (steer.has(b)) { fit += 3; why.push(`${BUILDS[b]} (GM)`); }
        else if (build.top.includes(b)) { fit += 1.5 + (build.scores[b] ?? 0) * 0.2; why.push(BUILDS[b]); }
      }
      if (slot && !bySlot[slot] && !consumable) { fit += 1.5; why.push(`empty ${slot}`); }
      else if (slot && power > replaces && !consumable) { fit += 1; why.push('upgrade'); }
      if (consumable) fit += mode === 'ahead' ? 3 : 0.5;
      if (it.fragile && mode === 'ahead') fit += 2;
      // Already ahead: gear only as a real upgrade, the rest of the box leans to better consumables.
      if (mode === 'ahead' && !consumable && !it.fragile && slot && power <= replaces) continue;
      scored.push({ it, power, builds, fit, why, on: builds.some((b) => wanted.has(b)) });
    }
    scored.sort((a, b) => Number(b.on) - Number(a.on) || b.fit - a.fit || a.it.name.localeCompare(b.it.name));
    const fits = scored.filter((s) => s.on);
    const offers = [];
    const want = Math.max(1, P.offers);
    // Fits first, sampled from the top 6 so two boxes in a row don't look the same.
    const top = (fits.length ? fits : scored).slice(0, 6);
    while (offers.length < want - (pity ? 0 : 1) && top.length) {
      const total = top.reduce((n, s) => n + s.fit + 0.5, 0);
      let x = rng() * total;
      let k = 0;
      for (; k < top.length - 1; k++) { x -= top[k].fit + 0.5; if (x < 0) break; }
      offers.push({ ...top.splice(k, 1)[0], wild: false });
    }
    // One wild card (unless pity): anything else of that rarity, chance = lean.
    const rest = scored.filter((s) => !offers.some((o) => o.it.id === s.it.id));
    if (offers.length < want && rest.length) {
      if (!pity && rng() < lean) offers.push({ ...rest[Math.floor(rng() * rest.length) % rest.length], wild: true });
      else if (top.length) offers.push({ ...top[0], wild: false });
      else offers.push({ ...rest[0], wild: false });
    }
    for (const o of offers) taken.add(o.it.id);
    // The next slot assumes the first offer gets equipped, so one box can't add up past the budget.
    const first = offers[0];
    const fslot = first && !isConsumable(first.it) ? slotOf(first.it) : null;
    if (fslot && first.power > (bySlot[fslot] ?? 0)) { used += first.power - (bySlot[fslot] ?? 0); bySlot[fslot] = first.power; }
    slots.push({ rarity: offers[0]?.it.rarity ?? rarity, offers: offers.map((o) => ({ itemId: o.it.id, name: o.it.name, rarity: o.it.rarity, image: o.it.image ?? null, desc: o.it.desc ?? '',
      power: o.power, builds: o.builds, fit: Math.round(o.fit * 10) / 10, wild: o.wild, why: o.wild ? ['wild card'] : o.why.slice(0, 3) })) });
  }
  return { tier: input.tier, boss: !!input.boss, mode, floor, budget: { cap, used: usedBefore }, build: { top: build.top, steered: build.steered }, pity,
    slots, held: [...held.values()].slice(0, 8) };
}

/** Warnings for handing an item to a crawler outside the policy (non-blocking: the GM decides). */
export function giveWarnings(policy, { item, floor, inventory, itemOf, source = 'gift' }) {
  const P = policy ?? DEFAULT_LOOT_POLICY;
  const out = [];
  const { power, underrated, implied } = itemPower(item);
  if (underrated) out.push(`${item.name} is stronger than its rarity (power ${power} ≈ ${implied}).`);
  const max = source === 'mob' || source === 'elite' ? rIndex(P.dropRarity[source]) : rIndex(floorRarityFor(P, floor));
  if (rIndex(item.rarity) > max) out.push(`${item.rarity} is above the usual ${source === 'gift' ? `Floor ${floor}` : source} ceiling (${RARITY_ORDER[max]}).`);
  if (!isConsumable(item)) {
    const { used } = carriedPower(inventory, itemOf);
    const cap = budgetFor(P, floor);
    if (used + power > cap) out.push(`Equipped it would put the crawler at ${Math.round((used + power) * 10) / 10} / ${cap} power for Floor ${floor}.`);
  }
  return out;
}

// ---------- grades and the crawler's power rating (GM-side; the TV show can use it) ----------

const CONSUMABLE_GRADE = { common: 'C', uncommon: 'B', rare: 'A', epic: 'S', legendary: 'S' };

/** S–D for an item on this floor: its full power against a quarter of the floor budget (≈ one gear slot). */
export function itemGrade(policy, it, floor) {
  if (isConsumable(it)) return CONSUMABLE_GRADE[it.rarity] ?? 'C';
  const ratio = itemPower(it).full / (budgetFor(policy ?? DEFAULT_LOOT_POLICY, floor) / 4);
  return ratio >= 1.5 ? 'S' : ratio >= 1.1 ? 'A' : ratio >= 0.75 ? 'B' : ratio >= 0.4 ? 'C' : 'D';
}

export const expectedLevel = (floor) => Math.max(1, (floor || 1) * 5 - 2);

/**
 * How strong is this crawler for where the party is? 0–100 and S–D from three parts:
 *   gear 55 (equipped power vs the floor budget), build 25 (share of that power on the crawler's build),
 *   level 20 (level vs ~2 levels per session, 5 per floor). Also every equipped item with its grade.
 */
export function crawlerRating(policy, { sheet, inventory, itemOf, floor, level, prefs }) {
  const P = policy ?? DEFAULT_LOOT_POLICY;
  const cap = budgetFor(P, floor);
  const build = crawlerBuild(sheet, prefs);
  const wanted = new Set(build.steered.length ? build.steered : build.top);
  const items = [];
  let used = 0;
  let onBuild = 0;
  for (const inv of inventory ?? []) {
    if (!inv.equippedSlot) continue;
    const it = itemOf(inv.itemId) ?? inv;
    if (!it || isConsumable(it)) continue;
    const full = { ...it, rarity: inv.rarity ?? it.rarity, fragile: inv.fragile ?? it.fragile };
    const { power } = itemPower(full);
    const on = itemBuilds(full).some((b) => wanted.has(b));
    used += power;
    if (on) onBuild += power;
    items.push({ uid: inv.uid ?? null, name: inv.name ?? it.name, rarity: full.rarity, power, grade: itemGrade(P, full, floor), onBuild: on, fragile: !!full.fragile, slot: inv.equippedSlot });
  }
  const gear = used / cap;
  const coherence = used ? onBuild / used : 0.5;
  const exp = expectedLevel(floor);
  const lv = Number(level) || 1;
  const score = Math.round(55 * Math.min(gear, 1.2) / 1.2 + 25 * coherence + 20 * Math.min(lv / exp, 1.2) / 1.2);
  const grade = score >= 85 ? 'S' : score >= 70 ? 'A' : score >= 50 ? 'B' : score >= 30 ? 'C' : 'D';
  return { score, grade, floor, gear: { used: Math.round(used * 100) / 100, cap, ratio: Math.round(gear * 100) / 100 },
    coherence: Math.round(coherence * 100) / 100, level: { level: lv, expected: exp }, build: { top: build.top, steered: build.steered },
    items: items.sort((a, b) => GRADES.indexOf(a.grade) - GRADES.indexOf(b.grade)) };
}

/** auto → catch-up for C/D crawlers, "ahead" for S (they get better consumables instead of more power). */
export function rewardMode(mode, grade) {
  if (mode && mode !== 'auto' && REWARD_MODES.includes(mode)) return mode;
  return grade === 'D' || grade === 'C' ? 'catchup' : grade === 'S' ? 'ahead' : 'standard';
}

/** A downed mob's own drop: 'none' | 'junk' | rarity, from policy.drops[role]. */
export function rollDrop(policy, role, rng = Math.random) {
  const w = (policy ?? DEFAULT_LOOT_POLICY).drops?.[role === 'elite' ? 'elite' : 'mob'] ?? {};
  const entries = Object.entries(w).filter(([, n]) => n > 0);
  const total = entries.reduce((n, [, x]) => n + x, 0);
  if (!total) return 'none';
  let x = rng() * total;
  for (const [k, n] of entries) { x -= n; if (x < 0) return k; }
  return entries.at(-1)[0];
}

// ---------- the campaign's own settings over the pack policy ----------

export const SETTING_KEYS = ['budget', 'stretch', 'wildcard', 'pity', 'offers', 'drops', 'fragileFactor'];
const effCache = new Map();
/** pack.lootPolicy with the campaign's GM settings (st.lootSettings) on top. */
export function effectiveLootPolicy(packPolicy, settings) {
  if (!settings || !Object.keys(settings).length) return packPolicy ?? DEFAULT_LOOT_POLICY;
  const key = JSON.stringify(settings);
  let hit = effCache.get(key);
  if (!hit || hit.base !== packPolicy) {
    hit = { base: packPolicy, value: normalizeLootPolicy({ ...(packPolicy ?? DEFAULT_LOOT_POLICY), ...settings }) };
    if (effCache.size > 50) effCache.clear();
    effCache.set(key, hit);
  }
  return hit.value;
}

/** Boss rank text ("Neighborhood Boss", "City Boss", or a tier id) → box tier id via policy.bossBox. */
export function bossBoxTier(policy, rank) {
  const r = String(rank ?? '').toLowerCase();
  const map = (policy ?? DEFAULT_LOOT_POLICY).bossBox;
  const key = Object.keys(map).find((k) => r.includes(k));
  return map[key ?? 'neighborhood'];
}

/** junk = tagged junk, or plain common gear that does nothing. */
export const isJunk = (it) => (it.tags ?? []).includes('junk') || (it.rarity === 'common' && !it.attack && !(it.effects ?? []).length && !isConsumable(it) && !it.slot);
