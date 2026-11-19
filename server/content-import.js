import { normalizeLibEntry, RulesetError } from './ruleset.js';
import { libraryOf, MAX_LIB_PER_KIND } from './character.js';
import { ActionError, bad } from './errors.js';
import { CONTENT_MEDIA_LIMIT, mediaBytes } from './content-media.js';
import { imageRefs } from './content-schema.js';

export const placeholderPath = (kind) => `/pack/content/placeholder/${kind}.svg`;
const scopedKey = (kind, id) => `${kind}:${id}`;

function checkReferences(e, library, imported, pack, at) {
  const requireRef = (kind, id) => {
    if (id && !imported.has(scopedKey(kind, id)) && !library.get(kind, id)) {
      throw bad(`${at}: unknown ${kind} reference "${id}"`);
    }
  };
  for (const a of e.attacks ?? []) for (const id of a.buffs ?? []) requireRef('buff', id);
  for (const id of e.lootItems ?? []) requireRef('item', id);
  if (e.type === 'boss') {
    if (e.lootTier && !pack.tiersById.has(e.lootTier)) throw bad(`${at}.lootTier: unknown loot tier "${e.lootTier}"`);
    let last = e.hpSlots;
    for (const [i, p] of e.phases.entries()) {
      if (p.atHp === undefined) continue;
      if (!i || p.atHp >= last) throw bad(`${at}.phases[${i}].atHp: thresholds must decrease after the opening phase and stay below hpSlots`);
      last = p.atHp;
    }
  }
  for (const type of e.resist ?? []) if (e.vulnerable?.includes(type) || e.immune?.includes(type)) throw bad(`${at}: conflicting damage responses for "${type}"`);
  for (const type of e.vulnerable ?? []) if (e.immune?.includes(type)) throw bad(`${at}: conflicting damage responses for "${type}"`);

  if (e.type !== 'item') return;
  const rs = pack.ruleset;
  if (e.slot && !rs.slots.some((s) => s.id === e.slot)) throw bad(`${at}.slot: unknown campaign slot "${e.slot}"`);
  requireRef('skill', e.attack?.skill);
  if (e.attack?.stat && !rs.stats.some((s) => s.id === e.attack.stat)) throw bad(`${at}.attack.stat: unknown campaign stat "${e.attack.stat}"`);
  if (e.use) {
    requireRef('buff', e.use.applyBuff);
    requireRef('buff', e.use.removeBuff);
    const track = e.use.heal?.track;
    if (track && !rs.tracks.some((t) => t.id === track)) throw bad(`${at}.use.heal.track: unknown campaign track "${track}"`);
    if (!track && !e.use.applyBuff && !e.use.removeBuff && !e.use.consume) throw bad(`${at}.use: specify an implemented effect or consumption`);
  }
  const targets = new Set([
    ...rs.derived.map((x) => x.id),
    ...rs.stats.flatMap((x) => [`stat.${x.id}`, `mod.${x.id}`]),
    ...rs.tracks.map((x) => `track.${x.id}.max`),
    ...rs.fields.filter((x) => x.type === 'number').map((x) => `field.${x.id}`),
    ...library.list('skill').map((x) => `skill.${x.id}`),
  ]);
  for (const [i, fx] of (e.effects ?? []).entries()) {
    if (!targets.has(fx.target)) throw bad(`${at}.effects[${i}].target: unknown campaign effect target "${fx.target}"`);
  }
}

export function prepareContentImport(state, pack, { manifest, assets }) {
  const library = libraryOf(state, pack);
  const ids = new Set();
  const counts = new Map();
  for (const e of manifest.entities) {
    const key = scopedKey(e.type, e.id);
    if (ids.has(key) || library.get(e.type, e.id)) throw new ActionError('conflict', `${key}: ID already exists in the ZIP or campaign library`);
    ids.add(key);
    const count = (counts.get(e.type) ?? state.library[e.type].length) + 1;
    if (count > MAX_LIB_PER_KIND) throw bad(`${e.type}: campaign can store at most ${MAX_LIB_PER_KIND} homebrew entries`);
    counts.set(e.type, count);
  }

  const nextLibrary = { ...state.library };
  for (const kind of counts.keys()) nextLibrary[kind] = [...state.library[kind]];
  const contentMedia = { ...state.contentMedia };
  let total = Object.values(contentMedia).reduce((size, data) => size + mediaBytes(data), 0);
  for (const { id, data } of assets.values()) {
    if (Object.hasOwn(contentMedia, id)) continue;
    total += mediaBytes(data);
    if (total > CONTENT_MEDIA_LIMIT) throw new ActionError('too_big', 'campaign has reached the 4 MiB content image limit');
    contentMedia[id] = data;
  }

  const missing = new Set();
  const result = { entries: [], missingImages: [], campaignId: state.campaign.id };
  const image = (ref) => {
    const asset = assets.get(ref);
    return asset ? `/pack/content/${state.campaign.id}/${asset.id}.png` : null;
  };
  for (const [i, e] of manifest.entities.entries()) {
    const at = `entities[${i}] (${scopedKey(e.type, e.id)})`;
    checkReferences(e, library, ids, pack, at);
    for (const ref of imageRefs(e)) if (!assets.has(ref)) missing.add(ref);
    try {
      const normalized = normalizeLibEntry(e.type, e, { strict: true, source: 'homebrew', where: at, image });
      normalized.image ??= placeholderPath(e.type);
      nextLibrary[e.type].push(normalized);
      result.entries.push({ type: e.type, id: e.id, name: normalized.name });
    } catch (err) {
      if (err instanceof RulesetError) throw bad(err.message);
      throw err;
    }
  }
  result.missingImages = [...missing];
  return { next: { ...state, library: nextLibrary, contentMedia }, result };
}
