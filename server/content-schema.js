import { bad } from './errors.js';

export const CONTENT_FORMAT = 'THE_SYSTEM_CONTENT_V1';
const ID = '^[a-z0-9][a-z0-9_-]{0,63}$';
const IMAGE = '^images/[a-z0-9][a-z0-9_-]{0,63}\\.png$';
const DICE = '^(?:[0-9]{1,3}|(?:[1-9]|1[0-9]|20)d(?:[2-9]|[1-9][0-9]|100)(?:[+-][0-9]{1,3})?)$';
const text = (maxLength, nonEmpty = false) => ({ type: 'string', maxLength, ...(nonEmpty ? { minLength: 1, pattern: '\\S' } : {}) });
const pattern = (value) => ({ type: 'string', pattern: value });
const int = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const list = (items, maxItems, minItems = 0, uniqueItems = false) => ({ type: 'array', items, minItems, maxItems, ...(uniqueItems ? { uniqueItems } : {}) });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const one = (...choices) => ({ enum: choices });
const ref = (name) => ({ $ref: `#/$defs/${name}` });
const id = ref('id');
const image = ref('image');
const bool = { type: 'boolean' };
const ids = (n) => list(id, n, 0, true);
const damageType = pattern('^[a-z][a-z -]{0,29}$');
const common = { id, name: text(80, true), desc: text(2000), tags: list(text(30, true), 20, 0, true), image };
const creature = {
  title: text(120), floor: text(20), hpSlots: int(1, 999), slotValue: int(0, 50), evade: int(-99, 99), dr: int(-99, 99),
  attacks: list(ref('mobAttack'), 12, 1), notes: text(3000), tactics: text(3000), intro: text(600),
  resist: list(damageType, 12, 0, true), vulnerable: list(damageType, 12, 0, true), immune: list(damageType, 12, 0, true),
};
const entity = (type, fields, required = []) => object({ type: one(type), ...common, ...fields }, ['type', 'id', 'name', ...required]);
const combatRequired = ['hpSlots', 'evade', 'dr', 'attacks'];

export const contentSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: CONTENT_FORMAT,
  ...object({ format: one(CONTENT_FORMAT), entities: list(ref('entity'), 50, 1) }, ['format', 'entities']),
  $defs: {
    id: { ...pattern(ID), not: one('constructor', 'prototype') },
    image: pattern(IMAGE),
    dice: pattern(DICE),
    mobAttack: object({
      name: text(60, true), toHit: int(-99, 99), damage: ref('dice'), buffs: ids(10),
      effects: text(400), area: text(120), range: text(60), dtype: damageType,
    }, ['name', 'toHit', 'damage']),
    phase: object({ name: text(60, true), text: text(300), atHp: int(0, 998), image }, ['name']),
    itemAttack: object({ stat: id, skill: id, dice: ref('dice'), effects: text(300) }, ['dice']),
    itemEffect: object({
      target: pattern('^[A-Za-z][A-Za-z0-9_-]*(?:\\.[A-Za-z0-9_-]+){0,3}$'),
      op: one('add', 'set'), value: int(-999, 999), when: one('equipped', 'carried', 'always'), label: text(80),
    }, ['target', 'op', 'value', 'when']),
    itemUse: object({
      target: one('self'), consume: bool, heal: object({ track: id, amount: int(1, 999) }, ['track', 'amount']),
      applyBuff: id, removeBuff: id, note: text(300),
    }, ['target', 'consume']),
    monster: entity('monster', {
      ...creature, group: text(40), role: one('standard', 'elite', 'minion'), variants: list(image, 16, 0, true),
      lootItems: ids(20), flavor: text(1200), lootHint: text(300),
    }, combatRequired),
    boss: entity('boss', {
      ...creature, phases: list(ref('phase'), 10, 1), imageSquare: image, imageKo: image,
      lootTier: id, lootHint: text(300), defeatLine: text(300), flavor: text(600),
    }, [...combatRequired, 'phases']),
    npc: entity('npc', {
      role: text(120), floor: text(20), personality: text(1200), intro: text(600), voice: text(600),
      hooks: list(text(400, true), 20), secrets: list(text(400, true), 20),
    }),
    item: entity('item', {
      rarity: one('common', 'uncommon', 'rare', 'epic', 'legendary'), slot: id, stackable: bool, flavor: text(2000),
      attack: ref('itemAttack'), effects: list(ref('itemEffect'), 20), use: ref('itemUse'),
    }, ['rarity']),
    entity: { oneOf: ['monster', 'boss', 'npc', 'item'].map(ref) },
  },
};

/** Validate the schema subset above. Report the path in the manifest, never an entire user value. */
function check(rule, value, path) {
  const fail = (reason) => { throw bad(`${path}: ${reason}`); };
  if (rule.$ref) return check(contentSchema.$defs[rule.$ref.slice(8)], value, path);
  if (rule.oneOf) {
    const branch = typeof value?.type === 'string' && rule.oneOf.find((r) => r.$ref === `#/$defs/${value.type}`);
    if (!branch) fail('type must be monster, boss, npc or item');
    return check(branch, value, path);
  }
  if (rule.enum && !rule.enum.includes(value)) fail(`expected one of ${rule.enum.join(', ')}`);
  if (rule.not?.enum.includes(value)) fail('reserved value');
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected an object');
    for (const key of rule.required) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
    for (const [key, field] of Object.entries(value)) {
      if (!Object.hasOwn(rule.properties, key)) fail(`unknown field ${JSON.stringify(key.slice(0, 80))}`);
      check(rule.properties[key], field, `${path}.${key}`);
    }
  } else if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length < rule.minItems || value.length > rule.maxItems) fail(`expected ${rule.minItems}–${rule.maxItems} entries`);
    if (rule.uniqueItems && new Set(value).size !== value.length) fail('duplicate value');
    value.forEach((field, i) => check(rule.items, field, `${path}[${i}]`));
  } else if (rule.type === 'string') {
    if (typeof value !== 'string' || value.length < (rule.minLength ?? 0) || value.length > (rule.maxLength ?? Infinity)) fail('invalid text or length');
    if (rule.pattern && (!new RegExp(rule.pattern).test(value) || (rule.pattern.endsWith('$') && /[\r\n\u2028\u2029]$/.test(value)))) fail('invalid format');
  } else if (rule.type === 'integer') {
    if (!Number.isInteger(value) || value < rule.minimum || value > rule.maximum) fail(`expected an integer ${rule.minimum}–${rule.maximum}`);
  } else if (rule.type === 'boolean' && typeof value !== 'boolean') fail('expected true or false');
}

export function imageRefs(entry) {
  return [entry.image, entry.imageSquare, entry.imageKo, ...(entry.variants ?? []), ...(entry.phases ?? []).map((p) => p.image)].filter(Boolean);
}

export function validateManifest(manifest) {
  check(contentSchema, manifest, 'manifest.json');
  return new Set(manifest.entities.flatMap(imageRefs));
}
