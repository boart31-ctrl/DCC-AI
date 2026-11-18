// Guided character creation (ruleset `creation`, see normalizeCreation in ruleset.js). Pure + browser-safe.
//
// `creation.apply` (player for their own crawler, or the GM with playerId) takes the wizard's choices,
// checks them against the ruleset and writes them with the ordinary sheet actions:
//   { background: { [stageId]: { option, skills: [skillId…] } },   life stages: one option, `pick` skills
//     weapon: { index } | { name, like: index } | { none: true },   starting combat skill + attack
//     stats: { [statId]: n }, method: 'array' | 'roll',            base stats (array = a permutation)
//     stuff: { [stuffId]: { itemId } | { name, icon? } },          starting things → a request for the GM
//     species?, size?, animal? }   another kind of character (ruleset creation.species): its stages / combat,
//                                  start AI Favor, size, the race text (Animal: Cat)
// Skills a character already has are raised to the stage rank, never duplicated; attacks are not doubled.
//
// Starting things never land in the inventory directly: they wait in sheet.gearRequest until the GM
// approves (`gear.approve`, catalog items via lib.give, custom ones become homebrew items) or denies them.
//
// makeCreation(GM) → { player: { 'creation.apply' }, gm: { 'gear.approve', 'gear.deny' } }
import { bad, notFound } from './errors.js';
import { libraryOf, targetOf, isStarterItem } from './character.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ID_RE = /^[A-Za-z0-9_.-]{1,60}$/;
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const MAX_GEAR_REQUEST = 8;

function checkStats(cr, rs, stats, method, gm) {
  if (!isObj(stats)) throw bad('stats must be { statId: number }');
  const ids = rs.stats.map((s) => s.id);
  const vals = {};
  for (const [k, v] of Object.entries(stats)) {
    if (!ids.includes(k)) throw bad(`unknown stat ${k}`);
    if (!Number.isInteger(v)) throw bad(`${k} must be a whole number`);
    vals[k] = v;
  }
  if (gm) return vals;
  const m = cr.statMethods;
  if (method === 'array' && m.array.length) {
    const want = [...m.array].sort((a, b) => a - b).join(',');
    const got = ids.map((k) => vals[k]).sort((a, b) => a - b).join(',');
    if (Object.keys(vals).length !== ids.length || want !== got) throw bad(`the array is ${m.array.join(', ')}: each number once`);
  } else if (method === 'roll' && m.roll) {
    const sides = Number(m.roll.dice.slice(1));
    for (const [k, v] of Object.entries(vals)) if (v < 1 || v > sides || m.roll.reroll.includes(v)) throw bad(`${k}: a ${m.roll.dice} roll${m.roll.reroll.length ? ` (rerolling ${m.roll.reroll.join(', ')})` : ''} is ${Math.max(1, ...m.roll.reroll.map((x) => x + 1))}..${sides}`);
  } else {
    for (const [k, v] of Object.entries(vals)) if ((m.min != null && v < m.min) || (m.max != null && v > m.max)) throw bad(`${k} must be ${m.min}..${m.max}`);
  }
  return vals;
}

export function makeCreation(GM) {
  const player = {
    'creation.apply'(st, a, ctx, out) {
      const p = targetOf(st, a, ctx, 'sheet');
      const gm = ctx.actor.role === 'gm';
      const rs = ctx.pack.ruleset;
      const base = rs.creation;
      if (!base) throw bad('this ruleset has no guided creation');
      // A species (DCC: animal crawler) brings its own life stages / combat; the rest is shared.
      const sp = a.species ? base.species.find((x) => x.id === a.species) : null;
      if (a.species && !sp) throw bad(`unknown species ${a.species}`);
      const cr = sp ? { ...base, backgrounds: sp.backgrounds ?? base.backgrounds, combat: sp.combat ?? base.combat } : base;
      if (sp?.sizes.length && a.size !== undefined && !sp.sizes.some((z) => z.value === String(a.size))) throw bad('unknown size');
      const lib = libraryOf(st, ctx.pack);
      const who = gm ? { playerId: p.id } : {};
      const sub = () => ({ ...out, result: null });
      const picks = []; // [{ skillId, rank, from }]

      // 1. background stages
      const labels = [];
      if (a.background !== undefined) {
        if (!isObj(a.background)) throw bad('background must be { stageId: { option, skills } }');
        for (const [sid, ch] of Object.entries(a.background)) {
          const g = cr.backgrounds.find((x) => x.id === sid);
          if (!g) throw bad(`unknown background stage ${sid}`);
          if (!isObj(ch)) throw bad(`${g.label}: { option, skills }`);
          const opt = g.options.find((o) => o.name === ch.option);
          if (!opt) throw bad(`${g.label}: unknown option ${ch.option}`);
          const sk = Array.isArray(ch.skills) ? [...new Set(ch.skills)] : [];
          if (sk.length !== g.pick || !sk.every((x) => opt.skills.includes(x))) throw bad(`${g.label} (${opt.name}): pick ${g.pick} of ${opt.skills.join(', ')}`);
          for (const x of sk) picks.push({ skillId: x, rank: g.rank, from: g.label });
          labels.push(opt.name);
        }
      }
      // 2. combat: the fixed attack (Unarmed) + the weapon
      const attacks = [];
      const fixed = cr.combat?.fixed;
      if (fixed) attacks.push({ ...fixed, rank: fixed.rank ?? cr.combat.rank });
      if (a.weapon !== undefined && a.weapon !== null && !a.weapon.none) {
        const list = cr.combat?.weapons ?? [];
        if (!isObj(a.weapon)) throw bad('weapon must be { index } or { name, like }');
        if (a.weapon.index !== undefined) {
          const w = list[a.weapon.index];
          if (!w) throw bad('unknown weapon');
          attacks.push({ ...w, rank: cr.combat.rank });
        } else {
          if (!cr.combat?.custom) throw bad('custom weapons are off');
          const w = list[a.weapon.like];
          const name = text(a.weapon.name, 60);
          if (!w || !name) throw bad('a custom weapon needs a name and which weapon it works like');
          attacks.push({ ...w, name: `${name} (${w.name})`, rank: cr.combat.rank });
        }
      }
      for (const k of attacks) picks.push({ skillId: k.skill, rank: k.rank, from: 'combat' });
      if (cr.noDouble && !gm) {
        const seen = new Map();
        for (const x of picks) {
          if (seen.has(x.skillId) && seen.get(x.skillId) !== x.from) throw bad(`${lib.get('skill', x.skillId)?.name ?? x.skillId} is picked twice (${seen.get(x.skillId)} and ${x.from}): pick another`);
          seen.set(x.skillId, x.from);
        }
      }
      // 3. stats (validated before anything is written)
      const stats = a.stats !== undefined ? checkStats(cr, rs, a.stats, a.method, gm) : null;

      // ---- write ----
      if (stats) {
        const parts = [cr.statPart, ...cr.mirrorParts].filter(Boolean);
        for (const [k, v] of Object.entries(stats)) {
          const def = rs.stats.find((s) => s.id === k);
          const use = parts.filter((x) => def.parts.includes(x));
          GM['sheet.set'](st, { ...who, path: `stats.${k}`, value: use.length ? Object.fromEntries(use.map((x) => [x, v])) : v }, ctx, sub());
        }
      }
      const skillUid = {};
      for (const x of picks) {
        if (!lib.get('skill', x.skillId)) continue; // a pack without that skill entry: the attack still works
        const have = p.sheet.skills.find((s) => s.skillId === x.skillId);
        if (have) { if ((have.rank ?? 0) < x.rank) GM['skill.update'](st, { ...who, uid: have.uid, rank: x.rank }, ctx, sub()); skillUid[x.skillId] = have.uid; continue; }
        const o = sub();
        GM['skill.add'](st, { ...who, skillId: x.skillId, rank: x.rank }, ctx, o);
        skillUid[x.skillId] = o.result?.uid;
      }
      for (const k of attacks) {
        const uid = skillUid[k.skill] ?? null;
        const same = p.sheet.attacks.find((x) => x.name === k.name || (uid && x.skillUid === uid && x.dice === k.dice));
        if (same) continue;
        GM['attack.add'](st, { ...who, name: k.name, dice: k.dice, stat: k.stat, ...(uid ? { skillUid: uid } : {}), ...(k.damageStat !== undefined && k.damageStat !== k.stat ? { dmgStat: k.damageStat || 'none' } : {}), ...(k.damageType ? { dtype: k.damageType, effects: [k.damageType, k.note].filter(Boolean).join(', ') } : {}) }, ctx, sub());
      }
      if (sp?.combat?.fixed) {
        // The ruleset's starter attack (human Unarmed Combat) is not theirs: the species has its own.
        const sa = rs.combat?.starterAttack;
        if (sa && sa.skill !== sp.combat.fixed.skill) {
          const sk = p.sheet.skills.find((x) => x.skillId === sa.skill);
          p.sheet.attacks = p.sheet.attacks.filter((k) => !(k.name === sa.name && (!sk || k.skillUid === sk.uid || !k.skillUid)));
          if (sk && !p.sheet.attacks.some((k) => k.skillUid === sk.uid)) p.sheet.skills = p.sheet.skills.filter((x) => x !== sk);
        }
      }
      if (sp) {
        // Species facts are part of creation, not later edits: written directly (AI Favor is GM-only otherwise).
        p.sheet.fields = { ...(p.sheet.fields ?? {}), ...(sp.aiFavor != null ? { aiFavor: sp.aiFavor } : {}), ...(a.size !== undefined ? { size: sp.sizes.find((z) => z.value === String(a.size))?.label ?? String(a.size) } : {}) };
        const what = text(a.animal, 40);
        p.sheet.identity = { ...(p.sheet.identity ?? {}), race: [sp.race || sp.label, what].filter(Boolean).join(': ').slice(0, 60) };
        p.sheet.species = sp.id;
      }
      // The background here is the life stages the rules ask for, not an origin needing approval: written directly.
      if (labels.length) { p.sheet.identity = { ...(p.sheet.identity ?? {}), background: labels.join(' · ').slice(0, 120) }; }

      // 4. starting things → request for the GM
      if (a.stuff !== undefined) {
        if (!isObj(a.stuff)) throw bad('stuff must be { slotId: { itemId } | { name, icon? } }');
        const req = [];
        for (const [id, v] of Object.entries(a.stuff)) {
          const slot = cr.stuff.find((x) => x.id === id);
          if (!slot || !isObj(v)) continue;
          if (v.itemId) {
            const def = lib.get('item', v.itemId);
            if (!def) throw notFound(`unknown item ${v.itemId}`);
            if (!gm && !isStarterItem(def)) throw bad(`${def.name} is not plain starting gear`);
            req.push({ slot: slot.label, itemId: def.id, name: def.name });
          } else if (text(v.name, 60)) {
            req.push({ slot: slot.label, name: text(v.name, 60), icon: typeof v.icon === 'string' && ID_RE.test(v.icon.replace(/\.(webp|png)$/, '')) ? v.icon : null });
          }
        }
        p.sheet.gearRequest = req.slice(0, MAX_GEAR_REQUEST);
        if (req.length && !gm) out.emit({ kind: 'gearRequest', playerId: p.id, name: p.name, items: req.map((x) => x.name) }, { roles: ['gm'] });
      }
      if (a.background !== undefined && stats) p.sheet.created = true;
      out.result = { skills: picks.length, attacks: attacks.length, gear: p.sheet.gearRequest?.length ?? 0 };
    },
  };

  const gm = {
    /** `{ playerId, index? }` Give the requested starting things (one, or all). */
    'gear.approve'(st, a, ctx, out) {
      const p = targetOf(st, a, ctx, 'gm');
      const req = p.sheet.gearRequest ?? [];
      const idx = a.index === undefined ? req.map((_, i) => i) : [a.index];
      const given = [];
      for (const i of idx.sort((x, y) => y - x)) {
        const r = req[i];
        if (!r) throw notFound(`no request ${i}`);
        let id = r.itemId;
        if (!id) {
          const o = { ...out, result: null };
          GM['lib.upsert'](st, { kind: 'item', entry: { name: r.name, ...(r.icon ? { image: `/pack/images/${/\.(webp|png)$/.test(r.icon) ? r.icon : `${r.icon}.webp`}` } : {}), rarity: 'common', tags: ['starting gear', 'custom'], desc: `${p.name}'s starting ${r.slot.toLowerCase()}.` } }, ctx, o);
          id = o.result.id;
        }
        GM['lib.give'](st, { playerId: p.id, kind: 'item', id }, ctx, { ...out, result: null });
        given.push(r.name);
        req.splice(i, 1);
      }
      p.sheet.gearRequest = req;
      out.result = { given };
    },
    /** `{ playerId, index? }` Drop one requested thing (or all). */
    'gear.deny'(st, a, ctx) {
      const p = targetOf(st, a, ctx, 'gm');
      if (a.index === undefined) { p.sheet.gearRequest = []; return; }
      if (!(p.sheet.gearRequest ?? [])[a.index]) throw notFound(`no request ${a.index}`);
      p.sheet.gearRequest.splice(a.index, 1);
    },
  };
  return { player, gm };
}

