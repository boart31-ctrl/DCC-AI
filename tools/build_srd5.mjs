// Builds the 5e SRD monster list from a 5e-bits/5e-database checkout (SRD 5.1, CC-BY-4.0).
//
//   node tools/build_srd5.mjs <5e-database>/src/2014/en/5e-SRD-Monsters.json            → server/srd5-monsters.js
//   node tools/build_srd5.mjs <…>/5e-SRD-Monsters.json --dcc <pack>/monsters_srd_dcc.json → crawler-style (DCC) versions
//
// Only SRD data goes in (no art: the API's pictures are not part of the SRD). Every entry carries
// origin "srd51" (5e) or "srd51_dcc" (converted); the attribution lives in server/origins.js and NOTICE.
import fs from 'node:fs';
import path from 'node:path';

const [src, flag, dccOut] = process.argv.slice(2);
if (!src) { console.error('usage: node tools/build_srd5.mjs <5e-SRD-Monsters.json> [--dcc out.json]'); process.exit(1); }
const ROOT = path.resolve(import.meta.dirname, '..');
const raw = JSON.parse(fs.readFileSync(src, 'utf8'));

const mod5 = (s) => Math.floor((s - 10) / 2);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const crText = (cr) => (cr === 0.125 ? '1/8' : cr === 0.25 ? '1/4' : cr === 0.5 ? '1/2' : String(cr));
const firstSentence = (s, max = 260) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  const cut = t.search(/(?<=[.!?])\s/);
  const one = cut > 40 && cut < max ? t.slice(0, cut) : t;
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
const rangeOf = (desc) => {
  const reach = /reach (\d+) ft/.exec(desc ?? '');
  const range = /range (\d+)(?:\/(\d+))? ft/.exec(desc ?? '');
  return range ? `${range[1]}ft` : reach ? `${reach[1]}ft` : undefined;
};
const areaOf = (desc) => /\b(\d+)-foot (cone|line|cube|sphere|radius)/i.test(desc ?? '');
const dmgOf = (a) => {
  const d = (a.damage ?? []).find((x) => x.damage_dice) ?? null;
  return d ? { dice: d.damage_dice.replace(/\s+/g, ''), type: d.damage_type?.index ?? '' } : null;
};
const typeList = (xs) => (xs ?? []).filter((x) => typeof x === 'string' && /^[a-z]+$/.test(x));

function attacksOf(m) {
  const out = [];
  for (const a of m.actions ?? []) {
    if (a.name === 'Multiattack') continue;
    const d = dmgOf(a);
    const save = a.dc ? `DC ${a.dc.dc_value} ${a.dc.dc_type?.name ?? ''} save` : '';
    const dcNote = save ? ` (${save})` : '';
    if (!Number.isInteger(a.attack_bonus) && !(d && save)) continue;
    out.push({
      name: a.name.slice(0, 60),
      toHit: Number.isInteger(a.attack_bonus) ? a.attack_bonus : 0,
      damage: d?.dice ?? '0',
      ...(d?.type ? { dtype: d.type } : {}),
      ...(rangeOf(a.desc) ? { range: rangeOf(a.desc) } : {}),
      ...(areaOf(a.desc) ? { area: true } : {}),
      effects: `${firstSentence(a.desc.replace(/^(Melee|Ranged)[^.]*\.\s*Hit:[^.]*\.\s*/i, ''), 220)}${dcNote}`.trim(),
    });
    if (out.length >= 5) break;
  }
  return out;
}

function notesOf(m) {
  const multi = (m.actions ?? []).find((a) => a.name === 'Multiattack');
  const parts = [];
  if (multi) parts.push(`Multiattack: ${firstSentence(multi.desc, 200)}`);
  for (const s of (m.special_abilities ?? []).slice(0, 4)) parts.push(`${s.name}: ${firstSentence(s.desc, 200)}`);
  if (m.legendary_actions?.length) parts.push(`Legendary actions: ${m.legendary_actions.map((l) => l.name).join(', ')}.`);
  const cond = (m.condition_immunities ?? []).map((c) => c.name).join(', ');
  if (cond) parts.push(`Condition immunities: ${cond}.`);
  return parts.join('\n').slice(0, 2900);
}

const creature = (m) => `${m.type}${m.subtype ? ` (${m.subtype})` : ''}`.slice(0, 40);
const ac = (m) => (Array.isArray(m.armor_class) ? m.armor_class[0]?.value : m.armor_class) ?? 10;
const walk = (m) => (/(\d+)/.exec(m.speed?.walk ?? m.speed?.swim ?? m.speed?.fly ?? '30') ?? [0, 30])[1];

// ---------- 5e (as printed) ----------
function to5e(m) {
  return {
    id: `srd_${slug(m.index)}`,
    name: m.name,
    title: `CR ${crText(m.challenge_rating)} · ${m.size} ${creature(m)}`,
    origin: 'srd51',
    tags: ['monster', 'srd', m.type, `cr${crText(m.challenge_rating).replace('/', '_')}`].map((t) => String(t).slice(0, 30)),
    cr: m.challenge_rating,
    level: Math.max(0, Math.round(m.challenge_rating)),
    hpSlots: Math.max(1, m.hit_points),
    evade: ac(m),
    dr: 0,
    role: m.legendary_actions?.length ? 'boss' : 'standard',
    initiative: mod5(m.dexterity),
    size: { label: m.size },
    creature: creature(m),
    move: `${walk(m)} ft`,
    stats: Object.fromEntries([['str', 'strength'], ['dex', 'dexterity'], ['con', 'constitution'], ['int', 'intelligence'], ['wis', 'wisdom'], ['cha', 'charisma']]
      .map(([k, f]) => [k, { score: m[f], mod: mod5(m[f]) }])),
    resist: typeList(m.damage_resistances),
    vulnerable: typeList(m.damage_vulnerabilities),
    immune: typeList(m.damage_immunities),
    attacks: attacksOf(m),
    notes: notesOf(m),
  };
}

// ---------- crawler-style (DCC) conversion ----------
// Calibrated on the book bestiary: mob Health slots = level, slot value = Con mod, Evade = Dex mod (+1/+2 for
// heavy armour), attack = 2–4 + F, damage dice kept with the crawler-scale mod, Surprise = 10 + Int mod.
const DCC_MOD = (x) => (x <= 2 ? 1 : x <= 5 ? 2 : x <= 9 ? 3 : x <= 19 ? 4 : x <= 49 ? 5 : x <= 99 ? 6 : 7);
const dccScore = (s) => Math.max(1, s <= 20 ? Math.round((s - 6) / 2) : 7 + (s - 20) * 2);
const dccLevel = (cr) => (cr <= 0.125 ? 1 : cr <= 0.25 ? 2 : cr <= 0.5 ? 3 : cr <= 5 ? Math.round(cr) + 3 : Math.min(60, Math.round(cr * 1.5) + 1));
const DCC_SIZE = { Tiny: ['Tiny', 1], Small: ['Small', 2], Medium: ['Medium', 4], Large: ['Large', 5], Huge: ['Huge', 6], Gargantuan: ['Colossal', 7] };

function toDcc(m) {
  const L = dccLevel(m.challenge_rating);
  const stats = Object.fromEntries([['str', 'strength'], ['int', 'intelligence'], ['con', 'constitution'], ['dex', 'dexterity'], ['cha', 'charisma']]
    .map(([k, f]) => { const score = dccScore(m[f]); return [k, { score, mod: DCC_MOD(score) }]; }));
  const armour = ac(m) >= 19 ? 2 : ac(m) >= 16 ? 1 : 0;
  const elite = !!m.legendary_actions?.length || m.challenge_rating >= 10;
  const attacks = attacksOf(m).map((a) => {
    const melee = !/ranged/i.test(a.name) && (!a.range || Number.parseInt(a.range, 10) <= 15);
    const statMod = (melee ? stats.str : stats.dex).mod;
    const dice = /^\d+d\d+/.exec(a.damage)?.[0] ?? a.damage;
    // Save-based attacks (breath, gaze): the 5e save DC becomes the Evade Difficulty (10 + toHit + F).
    const dc = /DC (\d+)/.exec(a.effects ?? '');
    const toHit = a.toHit ? Math.round(a.toHit / 2) : dc ? Math.round((Number(dc[1]) - 10) / 2) : 1;
    return { ...a, toHit: Math.min(12, Math.max(1, toHit)), damage: dice === '0' ? '0' : `${dice}+${statMod}` };
  });
  const [sizeLabel, sizeValue] = DCC_SIZE[m.size] ?? ['Medium', 4];
  const floor = L <= 4 ? 1 : L <= 8 ? 2 : L <= 12 ? 3 : L <= 20 ? 4 : 5;
  return {
    id: `srd_${slug(m.index)}`,
    name: m.name,
    title: `${elite ? 'Elite' : 'Mob'} · ${sizeLabel} ${creature(m)}`,
    origin: 'srd51_dcc',
    tags: ['monster', 'srd', 'srd_dcc', m.type, `floor${floor}`].map((t) => String(t).slice(0, 30)),
    floor,
    group: m.type,
    image: `srd/${slug(m.index)}.webp`,
    level: L,
    hpSlots: elite ? Math.max(10, L) : L,
    slotValue: stats.con.mod,
    evade: stats.dex.mod + armour,
    dr: armour,
    role: elite ? 'elite' : 'standard',
    surprise: 10 + stats.int.mod,
    move: `${walk(m)}`,
    size: { label: sizeLabel, value: sizeValue },
    creature: creature(m),
    rank: elite ? 'Elite' : 'Mob',
    stats,
    resist: typeList(m.damage_resistances),
    vulnerable: typeList(m.damage_vulnerabilities),
    immune: typeList(m.damage_immunities),
    attacks,
    notes: `Converted from the 5e SRD (CR ${crText(m.challenge_rating)}). Saving throws in the text = an Unopposed check of that stat.\n${notesOf(m)}`.slice(0, 2900),
  };
}

const list = raw.filter((m) => m && m.name && Number.isFinite(m.challenge_rating)).sort((a, b) => a.challenge_rating - b.challenge_rating || a.name.localeCompare(b.name));
if (flag === '--dcc') {
  const out = list.map(toDcc);
  fs.writeFileSync(dccOut, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`${out.length} crawler-style monsters → ${dccOut}`);
} else {
  const out = list.map(to5e);
  const file = path.join(ROOT, 'server', 'srd5-monsters.js');
  fs.writeFileSync(file, `// Generated by tools/build_srd5.mjs from the 5e SRD 5.1 (CC-BY-4.0, attribution in server/origins.js and NOTICE).\n// Do not edit by hand.\nexport const SRD5_MONSTERS = ${JSON.stringify(out)};\n`);
  console.log(`${out.length} 5e SRD monsters → ${path.relative(ROOT, file)} (${Math.round(fs.statSync(file).size / 1024)} KiB)`);
}
