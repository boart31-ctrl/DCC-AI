// Shared builder for the two fifth-edition fantasy rulesets (2014 and 2024).
// Everything here is written in our own words; only game mechanics (numbers, rule names) follow the SRD.
// Shape: docs/RULESET.md. Content conversion (monsters, items): server/systems.js.

const STATS = [
  ['str', 'Strength', 'STR'],
  ['dex', 'Dexterity', 'DEX'],
  ['con', 'Constitution', 'CON'],
  ['int', 'Intelligence', 'INT'],
  ['wis', 'Wisdom', 'WIS'],
  ['cha', 'Charisma', 'CHA'],
];

const SKILLS = [
  ['acrobatics', 'Acrobatics', 'dex', 'Keeping your balance, tumbling, staying on your feet.'],
  ['animal_handling', 'Animal Handling', 'wis', 'Calming, reading and steering animals.'],
  ['arcana', 'Arcana', 'int', 'Knowing spells, magic items and planes.'],
  ['athletics', 'Athletics', 'str', 'Climbing, jumping, swimming, shoving and grappling.'],
  ['deception', 'Deception', 'cha', 'Lying convincingly.'],
  ['history', 'History', 'int', 'Remembering events, people and old wars.'],
  ['insight', 'Insight', 'wis', 'Reading intentions and spotting lies.'],
  ['intimidation', 'Intimidation', 'cha', 'Getting your way with threats.'],
  ['investigation', 'Investigation', 'int', 'Finding clues and working out how things fit.'],
  ['medicine', 'Medicine', 'wis', 'Stabilising the dying, diagnosing illness.'],
  ['nature', 'Nature', 'int', 'Knowing terrain, plants, animals and weather.'],
  ['perception', 'Perception', 'wis', 'Noticing things with your senses.'],
  ['performance', 'Performance', 'cha', 'Music, acting, storytelling: holding a crowd.'],
  ['persuasion', 'Persuasion', 'cha', 'Influencing people honestly and with tact.'],
  ['religion', 'Religion', 'int', 'Gods, rites, holy symbols and cults.'],
  ['sleight_of_hand', 'Sleight of Hand', 'dex', 'Pickpocketing, palming, quick hands.'],
  ['stealth', 'Stealth', 'dex', 'Moving unseen and unheard.'],
  ['survival', 'Survival', 'wis', 'Tracking, foraging, finding your way.'],
];

const save = (id, abbr) => ({
  id: `save_${id}`,
  label: `${abbr} save`,
  formula: `mod.${id} + field.save_${id} * derived.prof + buff.save + buff.save_${id}`,
  display: 'd20 + {value}',
  roll: 'd20',
});

function conditions(exhaustion) {
  const c = (id, name, desc, effects = []) => ({ id, name, desc, effects, duration: '', tags: ['condition'] });
  const list = [
    c('blinded', 'Blinded', "Can't see. Automatically fails checks that need sight. Attacks against it have advantage; its own attacks have disadvantage."),
    c('charmed', 'Charmed', "Can't attack the charmer or target them with harmful effects. The charmer has advantage on social checks against it."),
    c('deafened', 'Deafened', "Can't hear. Automatically fails checks that need hearing."),
    c('frightened', 'Frightened', "Disadvantage on checks and attacks while the source of fear is in sight. Can't willingly move closer to it."),
    c('grappled', 'Grappled', 'Speed becomes 0. Ends if the grappler is incapacitated or the creature is moved out of reach.', [{ target: 'speed', op: 'set', value: 0, label: 'Grappled' }]),
    c('incapacitated', 'Incapacitated', "Can't take actions or reactions."),
    c('invisible', 'Invisible', "Can't be seen without special senses. Its attacks have advantage; attacks against it have disadvantage."),
    c('paralyzed', 'Paralyzed', "Incapacitated, can't move or speak. Fails STR and DEX saves. Attacks against it have advantage; hits from within 5 ft are critical."),
    c('petrified', 'Petrified', 'Turned to stone: incapacitated, unaware, resistant to all damage. Fails STR and DEX saves.'),
    c('poisoned', 'Poisoned', 'Disadvantage on attack rolls and ability checks.'),
    c('prone', 'Prone', 'Can only crawl unless it stands up (half its speed). Its attacks have disadvantage. Attacks within 5 ft have advantage, attacks from farther away have disadvantage.'),
    c('restrained', 'Restrained', 'Speed 0. Its attacks and DEX saves have disadvantage; attacks against it have advantage.', [{ target: 'speed', op: 'set', value: 0, label: 'Restrained' }]),
    c('stunned', 'Stunned', "Incapacitated, can't move, speaks only falteringly. Fails STR and DEX saves. Attacks against it have advantage."),
    c('unconscious', 'Unconscious', 'Incapacitated, drops what it holds and falls prone. Fails STR and DEX saves. Attacks against it have advantage; hits from within 5 ft are critical.'),
  ];
  if (exhaustion === '2024') {
    list.push(c('exhaustion', 'Exhaustion (1 level)', 'Each level: -2 to every d20 test and -5 ft speed. Add the condition again for each level. Six levels kill. A long rest removes one level.', [
      { target: 'check', value: -2, label: 'Exhaustion' },
      { target: 'save', value: -2, label: 'Exhaustion' },
      { target: 'toHit', value: -2, label: 'Exhaustion' },
      { target: 'initiative', value: -2, label: 'Exhaustion' },
      { target: 'speed', value: -5, label: 'Exhaustion' },
    ]));
  } else {
    list.push(c('exhaustion', 'Exhaustion', 'Levels stack: 1 disadvantage on ability checks, 2 speed halved, 3 disadvantage on attacks and saves, 4 HP maximum halved, 5 speed 0, 6 death. A long rest removes one level.'));
  }
  return list;
}

export function dndShared({ id, name, system, labels, exhaustion }) {
  return {
    id,
    name,
    dice: 'd20',
    system: { ...system, licence: 'CC-BY-4.0' },
    labels,
    identity: ['name', 'race', 'class', 'level', 'pronouns'],
    stats: STATS.map(([sid, label, abbr]) => ({ id: sid, label, abbr, parts: ['score'], default: { score: 10 } })),
    statMod: { from: 'score', formula: 'floor((x - 10) / 2)' },
    fields: [
      { id: 'hitDie', label: 'Hit die (6, 8, 10 or 12)', type: 'number', default: 8, group: 'health' },
      { id: 'armorBase', label: 'Armour base AC', type: 'number', default: 10, group: 'defense', note: 'Unarmoured 10. Leather 11, chain shirt 13, chain mail 16, plate 18.' },
      { id: 'dexCap', label: 'Max DEX bonus to AC', type: 'number', default: 99, group: 'defense', note: 'Light armour: no cap (99). Medium: 2. Heavy: 0.' },
      { id: 'shield', label: 'Shield bonus', type: 'number', default: 0, group: 'defense' },
      { id: 'speed', label: 'Speed (ft)', type: 'number', default: 30, group: 'movement' },
      ...STATS.map(([sid, , abbr]) => ({ id: `save_${sid}`, label: `${abbr} save proficient (0/1)`, type: 'number', default: 0, group: 'saves' })),
      { id: 'inspiration', label: exhaustion === '2024' ? 'Heroic Inspiration (0/1)' : 'Inspiration (0/1)', type: 'number', default: 0, group: 'identity' },
      { id: 'backstory', label: 'Backstory', type: 'longtext', default: '', group: 'story' },
      { id: 'notes', label: 'Notes', type: 'longtext', default: '', group: 'story' },
    ],
    derived: [
      { id: 'prof', label: 'Proficiency bonus', formula: 'floor((level - 1) / 4) + 2' },
      { id: 'ac', label: 'Armour Class', formula: 'field.armorBase + min(mod.dex, field.dexCap) + field.shield + buff.ac', note: 'Attackers must roll this or higher.' },
      { id: 'initiative', label: 'Initiative', formula: 'mod.dex + buff.initiative', display: 'd20 + {value}', roll: 'd20' },
      { id: 'speed', label: 'Speed', formula: 'field.speed + buff.speed', display: '{value} ft' },
      { id: 'passivePerception', label: 'Passive Perception', formula: '10 + mod.wis + buff.perception', note: 'Add your proficiency bonus by hand if you are proficient in Perception.' },
      ...STATS.map(([sid, , abbr]) => save(sid, abbr)),
      { id: 'spellAttack', label: 'Spell attack', formula: 'derived.prof + max(mod.int, mod.wis, mod.cha) + buff.spellAttack', display: 'd20 + {value}', roll: 'd20', note: 'Uses your best mental ability. Change it with an effect if your class casts with another one.' },
      { id: 'spellDC', label: 'Spell save DC', formula: '8 + derived.prof + max(mod.int, mod.wis, mod.cha) + buff.spellDC' },
    ],
    tracks: [
      { id: 'hp', label: 'Hit points', kind: 'pool', color: '#ff3355', default: 8, maxFormula: 'field.hitDie + (level - 1) * (floor(field.hitDie / 2) + 1) + mod.con * level', note: 'Fixed hit points per level (average roll). Edit the max with an effect if you rolled.' },
      { id: 'tempHp', label: 'Temporary HP', kind: 'pool', color: '#7fd4ff', default: 0, maxFormula: '99', start: 'empty' },
      { id: 'hitDice', label: 'Hit dice', kind: 'pool', color: '#ffb000', default: 1, maxFormula: 'level' },
      { id: 'deathSuccess', label: 'Death save successes', kind: 'slots', slots: 3, default: 0, color: '#38d39f' },
      { id: 'deathFail', label: 'Death save failures', kind: 'slots', slots: 3, default: 0, color: '#ff3355' },
    ],
    slots: [
      { id: 'head', label: 'Head', max: 1 },
      { id: 'neck', label: 'Neck', max: 1 },
      { id: 'body', label: 'Armour', max: 1 },
      { id: 'cloak', label: 'Cloak', max: 1 },
      { id: 'hands', label: 'Held (main / off hand)', max: 2 },
      { id: 'gloves', label: 'Gloves / bracers', max: 1 },
      { id: 'belt', label: 'Belt', max: 1 },
      { id: 'feet', label: 'Boots', max: 1 },
      { id: 'rings', label: 'Rings', max: 2 },
      { id: 'trinkets', label: 'Other worn items', max: 6 },
    ],
    buffSlots: { external: { label: 'Buffs from others', max: null } },
    hotlist: { size: 6 },
    skills: {
      columns: ['rank', 'stat', 'notes'],
      columnLabels: { rank: 'Proficiency (0 none, 1 proficient, 2 expertise)', stat: 'Ability' },
      rankMin: 0,
      rankMax: 2,
      rankLabels: ['—', 'Proficient', 'Expertise'],
      checkTypes: ['Check'],
      usedTracking: false,
      autoAdd: true,
      check: { roll: 'd20', formula: 'mod.{stat} + skill.rank * derived.prof + buff.check' },
      catalog: SKILLS.map(([sid, sname, stat, desc]) => ({ id: sid, name: sname, stat, checkType: 'Check', desc })),
    },
    attack: { roll: 'd20', toHit: 'mod.{stat} + derived.prof + buff.toHit', damage: '{dice} + mod.{stat} + buff.damage', note: 'Assumes you are proficient with the weapon.' },
    spells: { costTrack: null },
    storyFields: ['backstory', 'notes'],
    combat: {
      defense: 'ac',
      defenseLabel: 'AC',
      dr: null,
      hitRule: '>=',
      crit: 'dice',
      critRange: 20,
      nat1: 'miss',
      degrees: false,
      advantage: true,
      initiative: { enabled: true, derived: 'initiative', ties: 'dex' },
      saveLabel: 'save',
      hpModel: 'pool',
    },
    conditions: conditions(exhaustion),
    races: [],
    classes: [],
    backgrounds: [],
    notes: [
      'Mechanics follow the fifth-edition System Reference Document. Text is our own summary, not the book.',
      'Skills: rank 0 = not proficient, 1 = proficient (add proficiency bonus), 2 = expertise (add it twice).',
      'Saving throws: set the save proficiency fields (0 or 1) from your class.',
      'Armour Class = armour base + DEX modifier (capped by armour) + shield + buffs.',
      'Hit points use the fixed value per level (half the hit die + 1, plus CON modifier).',
      'Advantage / disadvantage: roll two d20 and keep the higher / lower. When you enter a physical roll, enter the die you kept.',
      'Critical hit on a natural 20: roll the damage dice twice. A natural 1 always misses.',
      'Spell slots: add a counter per slot level under Pools (e.g. "1st-level slots 2/2").',
    ],
  };
}
