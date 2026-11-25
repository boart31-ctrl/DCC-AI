// Survival bookkeeping outside combat (crawler rulesets; every number comes from the pack):
//
// Hazards (ruleset `hazards`):
//   fall   — `dice` per `perFeet` fallen (max `maxDice`), of type `dtype`; DR and damage types apply; then the
//            `prone` debuff. Each crawler rolls their own dice (or the GM types totals).
//   thirst — a day without water: lose `slots` health slots + one level of the `fatigue` debuff.
//   hunger — a day without food: an Unopposed `skill` check first; a fail costs the same as thirst.
// Crafting (ruleset `crafting`): spend Misc. Junk (number field `junkField`) to recover a common item (1 point,
// no check) or to craft an uncommon one: size → junk cost, hours = size index², Unopposed check with one of
// `skills`; a fail salvages junk by how much it missed (`salvage` rows). Hours advance the floor clock.
import { bad, notFound } from './errors.js';
import { computeFor, libraryOf, SHEET, SHEET_GM, trackDelta } from './character.js';
import { floorOfState, typedDamage, damageToSlots } from './outcome.js';
import { CRAWLERS_GM } from './crawlers.js';

const MAX_TARGETS = 20;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function players(st, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_TARGETS || new Set(ids).size !== ids.length) throw bad('choose the crawlers');
  return ids.map((id) => {
    const p = st.players.find((x) => x.id === id);
    if (!p) throw notFound(`no player ${id}`);
    return p;
  });
}

const rand = (ctx) => ctx.dieInt ?? ctx.rollInt ?? ctx.randInt;
const unopposed = (st) => 10 + 2 * floorOfState(st);

/** Damage to a crawler's slot health bar outside a fight: DR, damage type, whole slots only. */
function hurt(st, ctx, out, p, amount, dtype) {
  const lib = libraryOf(st, ctx.pack);
  const { computed } = computeFor(p, ctx.pack, lib);
  const dr = computed.derived?.dr?.value ?? 0;
  const afterDr = Math.max(0, amount - dr);
  const typed = typedDamage(afterDr, dtype, {}, computed.buffs);
  const sv = computed.tracks?.hp?.slotValue ?? 1;
  const slots = sv > 1 ? damageToSlots(typed.amount, sv) : typed.amount;
  const t = slots > 0 ? trackDelta(p, ctx.pack, lib, 'hp', -slots, out) : null;
  return { rolled: amount, dr, afterDr, slots, typed: typed.why ?? null, hp: t ? t.to : computed.tracks?.hp?.cur ?? null };
}

function addBuff(st, ctx, out, p, buffId) {
  if (!buffId || !libraryOf(st, ctx.pack).get('buff', buffId)) return false;
  SHEET_GM['buff.add'](st, { playerId: p.id, buffId }, ctx, { ...out, result: null });
  return true;
}

/** Digital check; returns { total, natural, hit }. */
function check(st, ctx, out, p, skillId, dc, entered) {
  const rs = ctx.pack.ruleset;
  const lib = libraryOf(st, ctx.pack);
  const own = p.sheet.skills.find((s) => s.skillId === skillId && s.rank > 0);
  const what = own ? { kind: 'skill', uid: own.uid } : rs.skills?.untrained && lib.get('skill', skillId) ? { kind: 'untrained', skillId } : null;
  if (!what) throw bad(`${p.name} cannot attempt ${skillId}`);
  const sub = { ...out, result: undefined };
  SHEET.roll(st, { what, playerId: p.id, dc, ...(entered !== undefined ? { entered } : {}) }, ctx, sub);
  return { total: sub.result.total, natural: sub.result.roll?.natural ?? null, hit: !!sub.result.hit, deg7: sub.result.deg7 ?? null };
}

export const SURVIVAL_GM = {
  /**
   * `{ kind: fall|thirst|hunger, playerIds, feet?, rolled?: {playerId: total}, failed?: [playerId] }`
   * fall: everyone listed rolls the falling dice; thirst: everyone loses; hunger: digital Survival check unless
   * the GM lists who `failed` at the table.
   */
  'hazard.apply'(st, a, ctx, out) {
    const cfg = ctx.pack.ruleset.hazards;
    if (!cfg) throw bad('this game has no hazard rules');
    if (st.combat?.active && a.kind !== 'fall') throw bad('finish combat first');
    const list = players(st, a.playerIds);
    const results = [];
    if (a.kind === 'fall') {
      const f = cfg.fall;
      if (!f) throw bad('no falling rule');
      if (!Number.isInteger(a.feet) || a.feet < f.perFeet || a.feet > 10000) throw bad(`feet must be at least ${f.perFeet}`);
      const n = Math.min(f.maxDice, Math.floor(a.feet / f.perFeet));
      for (const p of list) {
        const typed = isObj(a.rolled) ? a.rolled[p.id] : undefined;
        let amount;
        if (typed !== undefined) {
          if (!Number.isInteger(typed) || typed < n || typed > n * f.die) throw bad(`${p.name}: a ${n}d${f.die} total is ${n}..${n * f.die}`);
          amount = typed;
        } else { amount = 0; for (let i = 0; i < n; i++) amount += rand(ctx)(f.die) + 1; }
        const r = hurt(st, ctx, out, p, amount, f.dtype);
        const prone = addBuff(st, ctx, out, p, f.prone);
        results.push({ playerId: p.id, name: p.name, dice: `${n}d${f.die}`, ...r, prone });
      }
    } else if (a.kind === 'thirst' || a.kind === 'hunger') {
      const s = cfg.starve;
      if (!s) throw bad('no thirst / hunger rule');
      const failedSet = Array.isArray(a.failed) ? new Set(a.failed) : null;
      for (const p of list) {
        let passed = false;
        let roll = null;
        if (a.kind === 'hunger') {
          if (failedSet) passed = !failedSet.has(p.id);
          else { roll = check(st, ctx, out, p, s.skill, unopposed(st)); passed = roll.hit; }
        }
        if (passed) { results.push({ playerId: p.id, name: p.name, passed: true, ...(roll ? { roll } : {}) }); continue; }
        const lib = libraryOf(st, ctx.pack);
        const t = trackDelta(p, ctx.pack, lib, 'hp', -s.slots, out);
        const fatigued = addBuff(st, ctx, out, p, s.fatigue);
        results.push({ playerId: p.id, name: p.name, passed: false, slots: s.slots, hp: t.to, fatigued, ...(roll ? { roll } : {}) });
      }
    } else throw bad('kind must be fall, thirst or hunger');
    out.emit({ kind: 'hazard', hazard: a.kind, names: results.filter((r) => !r.passed).map((r) => r.name) }, { roles: ['gm'] });
    out.result = { kind: a.kind, results };
  },

  /**
   * `{ playerId, common?: true, name, size?, skill?, entered? }`
   * common: 1 Misc. Junk → a household item in the inventory, no check, no time.
   * Otherwise craft: junk by size, hours = size index², Unopposed check (digital or the typed d20), salvage on a fail.
   */
  'craft.run'(st, a, ctx, out) {
    const cfg = ctx.pack.ruleset.crafting;
    if (!cfg) throw bad('this game has no crafting rules');
    if (st.combat?.active) throw bad('finish combat before crafting');
    const [p] = players(st, [a.playerId]);
    const name = typeof a.name === 'string' ? a.name.trim().slice(0, 60) : '';
    if (!name) throw bad('name the item');
    const junk = Number(p.sheet.fields?.[cfg.junkField] ?? 0) || 0;
    const setJunk = (n) => { p.sheet.fields = { ...(p.sheet.fields ?? {}), [cfg.junkField]: n }; };
    const giveCustom = (desc) => {
      p.inventory.push({ uid: ctx.genId('i'), itemId: null, custom: true, name, desc, flavor: '', rarity: 'common', image: null, at: ctx.now, qty: 1, notes: '', equippedSlot: null, containerUid: null, bonus: 0 });
    };
    if (a.common === true) {
      if (junk < cfg.commonCost) throw bad(`${p.name} has no Misc. Junk left`);
      setJunk(junk - cfg.commonCost);
      giveCustom('Common item pulled out of the Misc. Junk.');
      out.result = { common: true, name, junk: junk - cfg.commonCost };
      return;
    }
    const size = cfg.sizes[a.size];
    if (!Number.isInteger(a.size) || !size) throw bad(`size must be 0..${cfg.sizes.length - 1}`);
    if (!cfg.skills.includes(a.skill)) throw bad(`craft with ${cfg.skills.join(' or ')}`);
    if (junk < size.junk) throw bad(`${p.name} needs ${size.junk} Misc. Junk for a ${size.label} item (has ${junk})`);
    const hours = (a.size + 1) ** 2;
    const clock = st.crawlers?.clock;
    if (clock?.hours != null && clock.hours < hours) throw bad('not enough time before the floor collapses');
    const dc = unopposed(st);
    if (a.entered !== undefined && (!Number.isInteger(a.entered) || a.entered < 1 || a.entered > 20)) throw bad('entered must be a d20 face');
    const roll = check(st, ctx, out, p, a.skill, dc, a.entered);
    let refund = 0;
    let row = null;
    if (roll.hit) giveCustom(`Crafted (${size.label}) with ${a.skill}.`);
    else {
      const missed = dc - roll.total;
      row = cfg.salvage.find((r) => missed >= r.min && (r.max == null || missed <= r.max)) ?? null;
      refund = row ? Math.floor(size.junk * row.share) : 0;
    }
    setJunk(junk - size.junk + refund);
    if (clock?.hours != null) CRAWLERS_GM['crawlers.clock'](st, { advance: hours }, ctx, { ...out, result: null });
    out.result = { name, size: size.label, hours, dc, roll, success: roll.hit, cost: size.junk, refund, junk: junk - size.junk + refund, ...(row ? { salvage: row.label } : {}) };
  },
};
