// Scene system: what the TV (stage) shows, directed from the GM desk. Pure + browser-safe.
//
// state.scene = { id, kind, data, since }   — one scene at a time; `since` = when it was set
// state.show  = { audioDevice: 'gm' | 'stage' } — which page plays the System voice + stingers
//
// GM actions (docs/PROTOCOL.md §3a): scene.set, scene.update, scene.roll, show.audio,
// boss.intro, boss.damage, boss.heal, boss.phase, boss.defeat,
// countdown.start, countdown.pause, countdown.add, countdown.reset.
// Players never get any of these (they are not in the PLAYER table → bad_request).
import { bad, notFound } from './errors.js';
import { SHEET, libraryOf, computeFor } from './character.js';

export const SCENE_KINDS = ['lobby', 'explore', 'boss', 'loot', 'countdown', 'roll', 'recap', 'blank', 'combat', 'npc', 'finale'];
// combat-auto.js OUTCOMES (kept here too: scenes.js must not import combat-auto.js, which imports combat.js → scenes.js).
export const FINALE_OUTCOMES = ['victory', 'defeat', 'runaway', 'truce', 'special', 'sponsor', 'timeout', 'stalemate'];
export const AUDIO_DEVICES = ['gm', 'stage'];
export const MAX_BOSS_HP = 100;
export const MAX_BOSS_PHASES = 10;
export const MAX_COUNTDOWN_S = 24 * 3600;

const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------- field validators (throw bad_request with the field name) ----------

function txt(v, field, max) {
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  const t = v.trim();
  if (t.length > max) throw bad(`${field} too long (max ${max})`);
  return t;
}
function reqTxt(v, field, max) {
  const t = txt(v, field, max);
  if (!t) throw bad(`${field} must not be empty`);
  return t;
}
function flag(v, field) {
  if (typeof v !== 'boolean') throw bad(`${field} must be a boolean`);
  return v;
}
function intIn(v, field, lo, hi) {
  if (!Number.isInteger(v) || v < lo || v > hi) throw bad(`${field} must be an integer ${lo}..${hi}`);
  return v;
}
/** http(s) URL, /pack/ path, small data:image URL, or empty → null. */
export function imageUrl(v, field = 'image') {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  if (/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length <= 200_000) return v;
  if (/^(https?:\/\/|\/pack\/)[^\s"'<>]{1,2000}$/.test(v)) return v;
  throw bad(`${field} must be an http(s) URL, a /pack/ path or a small data:image URL`);
}
function hex(v, field) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !COLOR_RE.test(v)) throw bad(`${field} must be a #rrggbb color`);
  return v;
}

const T = {
  title: (v) => txt(v, 'title', 80),
  subtitle: (v) => txt(v, 'subtitle', 160),
  showQr: (v) => flag(v, 'showQr'),
  location: (v) => txt(v, 'location', 80),
  floor: (v) => txt(v, 'floor', 40),
  image: (v) => imageUrl(v),
  text1200: (v) => txt(v, 'text', 1200),
  text4000: (v) => txt(v, 'text', 4000),
  text160: (v) => txt(v, 'text', 160),
  showFeed: (v) => flag(v, 'showFeed'),
  label: (v) => txt(v, 'label', 80),
  lootHint: (v) => txt(v, 'lootHint', 160),
};

/** Plain per-kind fields: key → validator. Boss / countdown / loot / roll have extra logic below. */
const PLAIN = {
  lobby: { title: T.title, subtitle: T.subtitle, showQr: T.showQr },
  explore: { location: T.location, floor: T.floor, image: T.image, text: T.text1200, showFeed: T.showFeed, locationId: (v) => v },
  recap: { title: T.title, text: T.text4000 },
  blank: { text: T.text160 },
  // The arena board: party vs revealed mobs. Its content is view.combat (already role-filtered).
  combat: { title: T.title, showParty: (v) => flag(v, 'showParty') },
};

const DEFAULTS = {
  lobby: () => ({ title: '', subtitle: '', showQr: true }),
  explore: () => ({ locationId: null, location: '', floor: '', image: null, text: '', showFeed: true }),
  recap: () => ({ title: '', text: '' }),
  blank: () => ({ text: '' }),
  combat: () => ({ title: '', showParty: true }),
  npc: () => ({ npcId: null, npc: null, line: '', lineAt: null }),
  finale: () => ({ outcome: 'victory', title: '', text: '', summary: null, at: null }),
  loot: () => ({ playerId: null, tier: null }),
  roll: () => ({ playerId: null, name: '', color: null, label: '', formula: '', rollId: null, dice: [], total: null, nat1: false, nat20: false, at: null }),
  countdown: () => ({ label: '', totalMs: 300_000, remainingMs: 300_000, startedAt: null }),
  boss: () => ({ bossId: null, boss: null, phase: 0, hp: 0, revealed: false, defeated: false, lootHint: '' }),
};

function plainMerge(kind, prev, patch) {
  const spec = PLAIN[kind];
  const out = { ...prev };
  for (const [k, v] of Object.entries(patch)) {
    if (!Object.hasOwn(spec, k)) throw bad(`unknown field ${k} for scene ${kind}`);
    out[k] = spec[k](v);
  }
  return out;
}

// ---------- bosses ----------

/** Validates a boss definition (library entry or ad-hoc). Returns a clean copy. */
export function normalizeBoss(raw, ctx) {
  if (!isObj(raw)) throw bad('boss must be an object');
  const phasesRaw = raw.phases ?? [];
  if (!Array.isArray(phasesRaw)) throw bad('boss.phases must be an array');
  if (phasesRaw.length > MAX_BOSS_PHASES) throw bad(`boss.phases: max ${MAX_BOSS_PHASES}`);
  const phases = phasesRaw.map((p, i) => {
    if (!isObj(p)) throw bad(`boss.phases[${i}] must be an object`);
    return {
      name: reqTxt(p.name, `boss.phases[${i}].name`, 60),
      text: p.text == null ? '' : txt(p.text, `boss.phases[${i}].text`, 300),
      image: imageUrl(p.image, `boss.phases[${i}].image`),
      atHp: p.atHp == null ? null : intIn(p.atHp, `boss.phases[${i}].atHp`, 0, MAX_BOSS_HP),
    };
  });
  const lootTier = raw.lootTier == null || raw.lootTier === '' ? null : raw.lootTier;
  if (lootTier !== null && (typeof lootTier !== 'string' || !ctx.pack.tiersById.has(lootTier))) throw notFound(`unknown loot tier ${lootTier}`);
  return {
    name: reqTxt(raw.name, 'boss.name', 80),
    title: raw.title == null ? '' : txt(raw.title, 'boss.title', 120),
    image: imageUrl(raw.image, 'boss.image'),
    ...(raw.imageKo ? { imageKo: imageUrl(raw.imageKo, 'boss.imageKo') } : {}),
    // square crop of a 16:9 splash: the TV boss frame and intro figure are portrait-shaped
    ...(raw.imageSquare ? { imageSquare: imageUrl(raw.imageSquare, 'boss.imageSquare') } : {}),
    hpSlots: raw.hpSlots == null ? 10 : intIn(raw.hpSlots, 'boss.hpSlots', 1, MAX_BOSS_HP),
    phases,
    flavor: raw.flavor == null ? '' : txt(raw.flavor, 'boss.flavor', 600),
    color: hex(raw.color, 'boss.color'),
    lootTier,
    floor: raw.floor == null ? '' : txt(String(raw.floor), 'boss.floor', 20),
    intro: raw.intro == null ? '' : txt(raw.intro, 'boss.intro', 600),
    defeatLine: raw.defeatLine == null ? '' : txt(raw.defeatLine, 'boss.defeatLine', 300),
    // tactics + the library lootHint are GM-only: they never enter the scene (every role sees it).
  };
}

function bossFromLibrary(st, ctx, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw bad('bossId must be an id');
  const e = libraryOf(st, ctx.pack).get('boss', id);
  if (!e) throw notFound(`unknown boss ${id}`);
  // Library entries are already normalized; normalizeBoss again keeps one shape for both paths.
  return normalizeBoss({
    name: e.name, title: e.title, image: e.image, imageSquare: e.imageSquare, imageKo: e.imageKo, hpSlots: e.hpSlots,
    // Library phase `text` is GM mechanics (spoilers); only an optional TV-safe `tv` line reaches the scene.
    phases: Array.isArray(e.phases) ? e.phases.map((p) => ({ name: p?.name, atHp: p?.atHp, image: p?.image, text: p?.tv ?? '' })) : e.phases, flavor: e.flavor || e.desc, color: e.color,
    lootTier: e.lootTier && ctx.pack.tiersById.has(e.lootTier) ? e.lootTier : null,
    floor: e.floor, intro: e.intro, defeatLine: e.defeatLine,
  }, ctx);
}

const BOSS_KEYS = new Set(['bossId', 'boss', 'phase', 'hp', 'revealed', 'defeated', 'lootHint']);

function bossMerge(st, ctx, prev, patch, fresh) {
  for (const k of Object.keys(patch)) if (!BOSS_KEYS.has(k)) throw bad(`unknown field ${k} for scene boss`);
  const out = { ...prev };
  let swapped = false;
  if (patch.bossId !== undefined && patch.bossId !== null) {
    out.boss = bossFromLibrary(st, ctx, patch.bossId);
    out.bossId = patch.bossId;
    swapped = true;
  } else if (patch.boss !== undefined) {
    out.boss = normalizeBoss(patch.boss, ctx);
    out.bossId = null;
    swapped = true;
  }
  if (!out.boss) throw bad('boss scene needs bossId (from the library) or an ad-hoc boss {name, ...}');
  const max = out.boss.hpSlots;
  if (swapped && fresh) Object.assign(out, { hp: max, phase: 0, revealed: false, defeated: false });
  if (patch.hp !== undefined) out.hp = intIn(patch.hp, 'hp', 0, max);
  if (patch.phase !== undefined) out.phase = intIn(patch.phase, 'phase', 0, Math.max(0, out.boss.phases.length - 1));
  if (patch.revealed !== undefined) out.revealed = flag(patch.revealed, 'revealed');
  if (patch.defeated !== undefined) out.defeated = flag(patch.defeated, 'defeated');
  if (patch.lootHint !== undefined) out.lootHint = T.lootHint(patch.lootHint);
  out.hp = Math.min(out.hp, max);
  out.phase = Math.min(out.phase, Math.max(0, out.boss.phases.length - 1));
  return out;
}

// ---------- countdown ----------

function remainingOf(d, now) {
  if (d.startedAt == null) return Math.max(0, d.remainingMs);
  return Math.max(0, d.remainingMs - (now - d.startedAt));
}

function countdownMerge(prev, patch, now) {
  const out = { ...prev };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'label') out.label = T.label(v);
    else if (k === 'seconds') {
      const ms = intIn(v, 'seconds', 1, MAX_COUNTDOWN_S) * 1000;
      Object.assign(out, { totalMs: ms, remainingMs: ms, startedAt: null });
    } else if (k === 'running') {
      if (flag(v, 'running')) { if (out.startedAt == null) { if (remainingOf(out, now) <= 0) throw bad('countdown is at zero, add time first'); out.startedAt = now; } }
      else if (out.startedAt != null) Object.assign(out, { remainingMs: remainingOf(out, now), startedAt: null });
    } else throw bad(`unknown field ${k} for scene countdown`);
  }
  return out;
}

// ---------- loot / roll ----------

function lootMerge(st, ctx, prev, patch) {
  const out = { ...prev };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'playerId') {
      if (v === null) out.playerId = null;
      else {
        if (typeof v !== 'string' || !st.players.some((p) => p.id === v)) throw notFound(`no player ${v}`);
        out.playerId = v;
      }
    } else if (k === 'tier') {
      if (v === null) out.tier = null;
      else {
        if (typeof v !== 'string' || !ctx.pack.tiersById.has(v)) throw notFound(`unknown loot tier ${v}`);
        out.tier = v;
      }
    } else throw bad(`unknown field ${k} for scene loot`);
  }
  return out;
}

function rollMerge(st, prev, patch) {
  const out = { ...prev };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'playerId') {
      if (v === null) out.playerId = null;
      else {
        const p = st.players.find((x) => x.id === v);
        if (!p) throw notFound(`no player ${v}`);
        Object.assign(out, { playerId: p.id, name: p.name, color: p.color });
      }
    } else if (k === 'name') out.name = txt(v, 'name', 40);
    else if (k === 'label') out.label = T.label(v);
    else throw bad(`unknown field ${k} for scene roll (use scene.roll to roll)`);
  }
  return out;
}

/** Explore from a library location: name, floor, image and read-aloud text (features stay GM-only). */
function exploreMerge(st, ctx, prev, patch) {
  const { locationId, ...rest } = patch;
  let base = prev;
  if (locationId !== undefined && locationId !== null) {
    if (typeof locationId !== 'string' || !ID_RE.test(locationId)) throw bad('locationId must be an id');
    const loc = libraryOf(st, ctx.pack).get('location', locationId);
    if (!loc) throw notFound(`unknown location ${locationId}`);
    base = {
      ...prev,
      locationId,
      location: txt(loc.name, 'location', 80),
      floor: loc.floor !== '' && loc.floor != null ? `Floor ${loc.floor}` : '',
      image: loc.image ?? null,
      text: loc.readAloud ?? '',
    };
  } else if (locationId === null) base = { ...prev, locationId: null };
  return plainMerge('explore', base, rest);
}

// ---------- npc ----------

/** TV-safe NPC card: name, role, portrait, floor. personality / voice / hooks / secrets stay on the GM desk. */
function npcCard(raw) {
  if (!isObj(raw)) throw bad('npc must be an object');
  return {
    name: reqTxt(raw.name, 'npc.name', 80),
    role: raw.role == null ? '' : txt(raw.role, 'npc.role', 120),
    image: imageUrl(raw.image, 'npc.image'),
    floor: raw.floor == null || raw.floor === '' ? '' : txt(String(raw.floor), 'npc.floor', 20),
  };
}

function npcFromLibrary(st, ctx, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw bad('npcId must be an id');
  const e = libraryOf(st, ctx.pack).get('npc', id);
  if (!e) throw notFound(`unknown npc ${id}`);
  return npcCard({ name: e.name, role: e.role, image: e.image, floor: e.floor });
}

function npcMerge(st, ctx, prev, patch) {
  const out = { ...prev };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'npcId') {
      if (v === null) out.npcId = null;
      else { out.npc = npcFromLibrary(st, ctx, v); out.npcId = v; out.line = ''; out.lineAt = null; }
    } else if (k === 'npc') { out.npc = npcCard(v); out.npcId = null; }
    else if (k === 'line') { out.line = txt(v, 'line', 300); out.lineAt = out.line ? ctx.now : null; }
    else throw bad(`unknown field ${k} for scene npc`);
  }
  if (!out.npc) throw bad('npc scene needs npcId (from the library) or an ad-hoc npc {name, role?, image?}');
  return out;
}

/** Combat finale (normally set by combat.end with a summary; the GM may also replay one by hand). */
function finaleMerge(prev, patch, ctx) {
  const out = { ...prev };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'outcome') {
      if (!FINALE_OUTCOMES.includes(v)) throw bad(`outcome must be one of ${FINALE_OUTCOMES.join(', ')}`);
      out.outcome = v;
    } else if (k === 'title') out.title = txt(v, 'title', 60);
    else if (k === 'text') out.text = txt(v, 'text', 400);
    else throw bad(`unknown field ${k} for scene finale`);
  }
  out.at = ctx.now;
  return out;
}

function mergeData(st, ctx, kind, prev, patch, fresh) {
  if (!isObj(patch)) throw bad('data must be an object');
  if (JSON.stringify(patch).length > 220_000) throw bad('data too large');
  if (kind === 'explore') return exploreMerge(st, ctx, prev, patch);
  if (PLAIN[kind]) return plainMerge(kind, prev, patch);
  if (kind === 'boss') return bossMerge(st, ctx, prev, patch, fresh);
  if (kind === 'countdown') {
    const { autostart, ...rest } = patch;
    const out = countdownMerge(prev, rest, ctx.now);
    if (autostart !== undefined && flag(autostart, 'autostart') && fresh) return countdownMerge(out, { running: true }, ctx.now);
    return out;
  }
  if (kind === 'loot') return lootMerge(st, ctx, prev, patch);
  if (kind === 'roll') return rollMerge(st, prev, patch);
  if (kind === 'npc') return npcMerge(st, ctx, prev, patch);
  if (kind === 'finale') return finaleMerge(prev, patch, ctx);
  throw bad(`unknown scene kind ${kind}`);
}

// ---------- state ----------

export function initScene(now = 0) {
  return { id: 'sc_0', kind: 'lobby', data: DEFAULTS.lobby(), since: now };
}

export function initShow() {
  return { audioDevice: 'gm' };
}

/** Repairs a saved scene (pack or code may have changed). Unknown kinds fall back to the lobby. */
export function normalizeScene(raw, now = 0) {
  if (!isObj(raw) || !SCENE_KINDS.includes(raw.kind) || !isObj(raw.data)) return initScene(now);
  const data = { ...DEFAULTS[raw.kind](), ...raw.data };
  if (raw.kind === 'boss' && !isObj(data.boss)) return initScene(now);
  if (raw.kind === 'npc' && !isObj(data.npc)) return initScene(now);
  return { id: typeof raw.id === 'string' ? raw.id : 'sc_0', kind: raw.kind, data, since: Number.isFinite(raw.since) ? raw.since : now };
}

export function normalizeShow(raw) {
  return { audioDevice: AUDIO_DEVICES.includes(raw?.audioDevice) ? raw.audioDevice : 'gm' };
}

function setScene(st, ctx, kind, data) {
  st.scene = { id: ctx.genId('sc'), kind, data, since: ctx.now };
}

function bossScene(st) {
  if (st.scene?.kind !== 'boss' || !st.scene.data?.boss) throw bad('no boss scene on stage (scene.set kind boss first)');
  return st.scene.data;
}

function countdownScene(st) {
  if (st.scene?.kind !== 'countdown') throw bad('no countdown on stage (scene.set kind countdown first)');
  return st.scene.data;
}

const STAGE_GM = { roles: ['stage', 'gm'] };

/**
 * The phase the boss's HP calls for (pack `phases[].atHp`): the furthest later phase whose atHp
 * the HP has dropped to. null when none. The GM confirms with boss.phase (never automatic).
 */
export function phaseFor(d) {
  let hit = null;
  d.boss.phases.forEach((p, i) => { if (i > d.phase && p.atHp != null && d.hp <= p.atHp) hit = i; });
  return hit;
}

function amountOf(a) {
  return a.amount === undefined ? 1 : intIn(a.amount, 'amount', 1, MAX_BOSS_HP);
}

// ---------- reducers (merged into the GM table by state.js) ----------

/**
 * The boss on the TV is also in the running fight (added from the library as a combatant): its HP follows
 * the boss panel too (combat.js already pushes combatant hits to the scene). Direct write, no events:
 * the scene's boss.hit / boss.heal is the one the TV plays.
 */
function syncBossCombatant(st, d) {
  if (!st.combat?.active || !d.bossId) return;
  for (const m of st.combat.combatants ?? []) {
    if (m.type === 'mob' && m.sourceKind === 'boss' && m.sourceId === d.bossId) m.hp = Math.max(0, Math.min(m.hpMax, d.hp));
  }
}

export const SCENE_GM = {
  'scene.set'(st, a, ctx) {
    if (!SCENE_KINDS.includes(a.kind)) throw bad(`kind must be one of ${SCENE_KINDS.join(', ')}`);
    const data = mergeData(st, ctx, a.kind, DEFAULTS[a.kind](), a.data ?? {}, true);
    if (a.kind === 'recap' && !data.text) data.text = st.session.recap ?? '';
    setScene(st, ctx, a.kind, data);
  },

  /**
   * Dry run of scene.set for the desk's preview: same validation and library lookups, nothing changes.
   * Ack `result: { scene }` = what the TV would get (boss: already revealed, so the preview shows the fight).
   */
  'scene.preview'(st, a, ctx, out) {
    if (!SCENE_KINDS.includes(a.kind)) throw bad(`kind must be one of ${SCENE_KINDS.join(', ')}`);
    const data = mergeData(st, ctx, a.kind, DEFAULTS[a.kind](), a.data ?? {}, true);
    if (a.kind === 'recap' && !data.text) data.text = st.session.recap ?? '';
    if (a.kind === 'boss') data.revealed = true;
    const tmp = { ...st, scene: { id: `preview_${a.kind}`, kind: a.kind, data, since: ctx.now } };
    out.result = { scene: sceneView(tmp, ctx.pack, ctx.now) };
    out.changed = false;
  },

  'scene.update'(st, a, ctx) {
    const sc = st.scene;
    if (a.data === undefined) throw bad('data required');
    sc.data = mergeData(st, ctx, sc.kind, sc.data, a.data, false);
  },

  /**
   * Rolls on the TV: same roll as the sheet `roll` action (dice log, `roll` event, nat1/nat20 lines),
   * then shows it as the `roll` scene. `rollId` instead re-shows an existing dice-log roll.
   */
  'scene.roll'(st, a, ctx, out) {
    let rec;
    if (a.rollId !== undefined) {
      rec = st.rolls.find((r) => r.id === a.rollId && !r.secret);
      if (!rec) throw notFound(`no public roll ${a.rollId}`);
    } else {
      const what = a.what ?? { kind: 'custom', formula: a.formula ?? 'd20', label: a.label };
      if (what.kind === 'custom' && what.label === undefined) delete what.label;
      const action = { t: 'roll', what, secret: false };
      if (a.playerId !== undefined) action.playerId = a.playerId;
      const sub = { ...out, result: undefined };
      SHEET.roll(st, action, ctx, sub);
      rec = st.rolls.find((r) => r.id === sub.result.rollId);
      out.result = sub.result;
    }
    const p = rec.playerId ? st.players.find((x) => x.id === rec.playerId) : null;
    const name = a.name !== undefined ? txt(a.name, 'name', 40) : p?.name ?? '';
    const data = {
      ...DEFAULTS.roll(),
      playerId: p?.id ?? null,
      name: name || 'The GM',
      color: p?.color ?? null,
      label: a.label !== undefined && a.rollId !== undefined ? T.label(a.label) : rec.label ?? '',
      formula: rec.formula ?? '',
      rollId: rec.id,
      dice: rec.dice,
      total: rec.total,
      nat1: !!rec.nat1,
      nat20: !!rec.nat20,
      at: ctx.now,
    };
    setScene(st, ctx, 'roll', data);
    out.result = { ...(out.result ?? {}), rollId: rec.id, total: rec.total, sceneId: st.scene.id };
  },

  'show.audio'(st, a) {
    if (!AUDIO_DEVICES.includes(a.device)) throw bad(`device must be one of ${AUDIO_DEVICES.join(', ')}`);
    st.show = { ...normalizeShow(st.show), audioDevice: a.device };
  },

  'boss.intro'(st, a, ctx, out) {
    const d = bossScene(st);
    if (a.line !== undefined) flag(a.line, 'line');
    d.revealed = true;
    d.defeated = false;
    const ev = out.emit({ kind: 'boss.intro', sceneId: st.scene.id, name: d.boss.name, title: d.boss.title, intro: d.boss.intro }, STAGE_GM);
    ctx.h.feedPush(st, ev, `BOSS: ${d.boss.name}${d.boss.title ? `, ${d.boss.title}` : ''}`);
    if (a.line !== false) {
      // The boss's own announcement (pack `intro`) beats a generic quip from category `boss`.
      const line = d.boss.intro ? { priority: 1, text: d.boss.intro, quipId: null, crit: false, category: 'boss' } : ctx.h.categoryLine(st, ctx, 'boss', 1);
      if (line) out.lines.push(line);
    }
  },

  'boss.damage'(st, a, ctx, out) {
    const d = bossScene(st);
    const amount = amountOf(a);
    const from = d.hp;
    d.hp = Math.max(0, d.hp - amount);
    syncBossCombatant(st, d);
    const suggestPhase = phaseFor(d);
    out.emit({ kind: 'boss.hit', sceneId: st.scene.id, amount: from - d.hp, from, hp: d.hp, max: d.boss.hpSlots, suggestPhase }, STAGE_GM);
    out.result = { hp: d.hp, max: d.boss.hpSlots, suggestPhase };
  },

  'boss.heal'(st, a, ctx, out) {
    const d = bossScene(st);
    const amount = amountOf(a);
    const from = d.hp;
    d.hp = Math.min(d.boss.hpSlots, d.hp + amount);
    if (d.hp > 0) d.defeated = false;
    syncBossCombatant(st, d);
    out.emit({ kind: 'boss.heal', sceneId: st.scene.id, amount: d.hp - from, from, hp: d.hp, max: d.boss.hpSlots }, STAGE_GM);
    out.result = { hp: d.hp, max: d.boss.hpSlots };
  },

  'boss.phase'(st, a, ctx, out) {
    const d = bossScene(st);
    const n = d.boss.phases.length;
    if (n < 2) throw bad('this boss has no further phases');
    const index = a.index === undefined ? d.phase + 1 : intIn(a.index, 'index', 0, n - 1);
    if (index > n - 1) throw bad('already in the last phase');
    d.phase = index;
    const ph = d.boss.phases[index];
    const ev = out.emit({ kind: 'boss.phase', sceneId: st.scene.id, index, name: ph.name, text: ph.text, of: n }, STAGE_GM);
    ctx.h.feedPush(st, ev, `${d.boss.name}: ${ph.name}`);
    out.result = { phase: index };
  },

  'boss.defeat'(st, a, ctx, out) {
    const d = bossScene(st);
    if (a.lootHint !== undefined) d.lootHint = T.lootHint(a.lootHint);
    d.defeated = true;
    d.revealed = true;
    d.hp = 0;
    const tier = d.boss.lootTier ? ctx.pack.tiersById.get(d.boss.lootTier) : null;
    const lootHint = d.lootHint || (tier ? `${tier.name} incoming` : 'Loot incoming');
    const ev = out.emit({ kind: 'boss.defeat', sceneId: st.scene.id, name: d.boss.name, lootHint, lootTier: d.boss.lootTier, defeatLine: d.boss.defeatLine }, STAGE_GM);
    ctx.h.feedPush(st, ev, `${d.boss.name} was defeated`);
    if (d.boss.defeatLine && a.line !== false) out.lines.push({ priority: 1, text: d.boss.defeatLine, quipId: null, crit: false, category: 'boss' });
    if (ctx.h.bumpPct) out.emit(ctx.h.bumpPct(st, ctx, 0.2));
  },

  /**
   * "Speak as NPC": a TV subtitle in the NPC's name (no voice). npcId (library), else the NPC on the
   * TV, else an ad-hoc `name`. On the npc scene of that NPC the line also stays on screen (data.line).
   */
  'npc.say'(st, a, ctx, out) {
    const text = reqTxt(a.text, 'text', 300);
    const onTv = st.scene?.kind === 'npc' ? st.scene.data : null;
    let npc;
    let npcId = null;
    if (a.npcId !== undefined && a.npcId !== null) { npc = npcFromLibrary(st, ctx, a.npcId); npcId = a.npcId; }
    else if (a.name !== undefined) npc = { name: reqTxt(a.name, 'name', 80), role: '', image: null };
    else if (onTv?.npc) { npc = onTv.npc; npcId = onTv.npcId; }
    else throw bad('npcId or name required (no NPC on the TV)');
    if (onTv && (onTv.npcId === npcId || (!npcId && onTv.npc?.name === npc.name))) { onTv.line = text; onTv.lineAt = ctx.now; }
    out.emit({ kind: 'npc.say', npcId, name: npc.name, image: npc.image ?? null, text }, STAGE_GM);
  },

  'countdown.start'(st, a, ctx) {
    const d = countdownScene(st);
    st.scene.data = countdownMerge(d, { running: true }, ctx.now);
  },

  'countdown.pause'(st, a, ctx) {
    const d = countdownScene(st);
    st.scene.data = countdownMerge(d, { running: false }, ctx.now);
  },

  /** Adds (or with a negative value removes) time; keeps running if it was running. */
  'countdown.add'(st, a, ctx) {
    const d = countdownScene(st);
    const s = intIn(a.seconds, 'seconds', -MAX_COUNTDOWN_S, MAX_COUNTDOWN_S);
    if (s === 0) throw bad('seconds must not be 0');
    const left = remainingOf(d, ctx.now);
    const next = Math.max(0, Math.min(MAX_COUNTDOWN_S * 1000, left + s * 1000));
    st.scene.data = { ...d, remainingMs: next, startedAt: d.startedAt == null || next === 0 ? null : ctx.now, totalMs: Math.max(d.totalMs, next) };
  },

  'countdown.reset'(st, a, ctx) {
    const d = countdownScene(st);
    const ms = a.seconds === undefined ? d.totalMs : intIn(a.seconds, 'seconds', 1, MAX_COUNTDOWN_S) * 1000;
    st.scene.data = { ...d, totalMs: ms, remainingMs: ms, startedAt: null };
  },
};

export const SCENE_ACTIONS = Object.keys(SCENE_GM);

// ---------- view ----------

/** Up to two tracks per crawler for the TV party strip (HP first). */
function partyOf(state, pack) {
  const tracks = pack.ruleset.tracks;
  const order = [...tracks].sort((a, b) => (b.id === 'hp') - (a.id === 'hp')).slice(0, 2);
  const library = libraryOf(state, pack);
  return state.players.map((p) => {
    let computed = null;
    try { computed = computeFor(p, pack, library).computed; } catch { computed = null; }
    return {
      id: p.id,
      tracks: order.map((t) => {
        const c = computed?.tracks?.[t.id] ?? p.sheet?.tracks?.[t.id] ?? { cur: 0, max: 0 };
        return { id: t.id, label: t.label, color: t.color, kind: t.kind, cur: c.cur ?? 0, max: c.max ?? 0 };
      }),
    };
  });
}

/** view.scene for every role. `now` lets clients correct their clock (countdown). */
export function sceneView(state, pack, now) {
  const sc = state.scene ?? initScene(0);
  const data = { ...sc.data };
  if (sc.kind === 'countdown') {
    data.remainingMs = remainingOf(sc.data, now);
    data.running = sc.data.startedAt != null && data.remainingMs > 0;
    data.endsAt = data.running ? now + data.remainingMs : null;
    delete data.startedAt;
  }
  if (sc.kind === 'loot' && data.tier) data.tierInfo = pack.tiersById.get(data.tier) ?? null;
  if (sc.kind === 'boss' && data.boss?.lootTier) data.lootTierInfo = pack.tiersById.get(data.boss.lootTier) ?? null;
  if (sc.kind === 'boss' && data.boss) data.suggestPhase = phaseFor(data);
  return { id: sc.id, kind: sc.kind, since: sc.since, now, data, party: partyOf(state, pack) };
}

export function showView(state) {
  return normalizeShow(state.show);
}
