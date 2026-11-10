// Isomorphic engine entry: everything a host needs to run the game, with zero Node imports.
// Used by the Node server (via its own modules) and by the hosted edition in the GM's browser.
// Keep this file's import graph browser-safe — server/test/isomorphic.test.js enforces it.

export {
  createState,
  normalizeState,
  reduce,
  reducePlayerAction,
  viewFor,
  viewForUser,
  rollLoot,
  hypeOf,
  defaultVoiceId,
  ActionError,
  GM_ACTIONS,
  PLAYER_ACTIONS,
  PREP_KINDS,
} from './state.js';
export { VoiceQueue, MODES, modeAllows, pickQuip, quipsLeft, STALE_MS, VETO_MS } from './quips.js';
export {
  normalizePack,
  serializePack,
  deserializePack,
  fallbackPack,
  voiceFor,
  quipAudio,
  PackError,
  DEFAULT_VOICE,
  RARITIES,
  PACK_FORMAT,
} from './pack-core.js';
export { STANDARD_CATEGORIES, ROOM_ALPHABET } from './constants.js';
export { evaluate, rollDice, diceText, validateFormula, parseFormula, objectResolver, FormulaError } from './formula.js';
export { normalizeRuleset, computeSheet, makeLibrary, normalizeLibEntry, normalizeEffects, sheetResolver, LIB_KINDS, EFFECT_WHENS } from './ruleset.js';
export { PLAYER_EDIT, MAX_ROLLS, VIEW_ROLLS, rollsFor } from './character.js';
export { genId, makeToken, makeRoomCode, makePin, randInt } from './random.js';
