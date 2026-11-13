// Sound cues on the GM desk (the audio device): which sound plays when, on top of the System voice.
//
//   const cues = createCues({ board, getView, onChange });
//   cues.line(m)        a voice line started (`play` from the host: category + source { kind, id })
//   cues.event(e)       a host event (boss.phase, loot.drop, …)
//   cues.mob(slot, uid) combat (combat-sfx.js): a mob's own sound for attack / hit / death, or null
//   cues.scene(view)    ambience + random sounds follow the explore scene's location
//   cues.moment(entry, m) a boss / monster moment button
//   cues.panel()        Show → Sound → "Sound cues" editor (this device, localStorage `system.cues`)
//
// Resolution for anything about a library entry: the entry's own `sounds[slot]` → its group's
// `cues.groups[group][slot]` (pack cues.json) → the event's default. A ref is a sound / pad id or `tag:x`
// (a random sound with that tag); several refs = one picked at random.
import { h } from './client.js';
import { icon } from './ui.js';

const KEY = 'system.cues';
const LIB_KINDS = { boss: 'boss', monster: 'monster', npc: 'npc', location: 'location' };

/** Voice-line category → cue event (same name unless listed) and the content slot it uses. */
const LINE_SLOT = { monster_intro: 'intro', npc_intro: 'intro', boss_intro: 'intro', boss_defeat: 'death' };

/** Events offered in the editor (label, hint). Pack cues.json may add more. */
export const CUE_EVENTS = [
  ['nat20', 'Natural 20'], ['nat1', 'Natural 1'], ['crit', 'Critical hit (GM)'],
  ['success', 'Success'], ['fail', 'Fail'], ['near_success', 'Near success'], ['near_fail', 'Near fail'],
  ['achievement', 'Achievement'], ['levelup', 'Level up'], ['loot', 'Loot box line'], ['loot_drop', 'Loot dropped on the TV'],
  ['sponsor', 'Sponsor'], ['crawler_down', 'Crawler down'], ['death', 'Crawler death'], ['mob_killed', 'Mob killed'],
  ['monster_intro', 'Monster intro'], ['npc_intro', 'NPC intro'], ['boss_intro', 'Boss intro'], ['boss_phase', 'Boss phase'], ['boss_defeat', 'Boss defeated'],
  ['combat_victory', 'Fight won'], ['combat_defeat', 'Party wiped'], ['combat_runaway', 'They ran'],
  ['crawlers_remaining', 'Crawler count'], ['crawlers_drop', 'Crawlers: big drop'], ['crawlers_collapse', 'Floor collapse'],
  ['welcome', 'Session start'], ['goodbye', 'Session end'], ['idle', 'Idle'], ['nerd', 'Nerd line'],
];

function loadCfg() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch {}
  return {
    on: s.on !== false,
    ambience: s.ambience !== false,
    randoms: s.randoms !== false,
    ambienceGain: typeof s.ambienceGain === 'number' ? s.ambienceGain : 0.8,
    events: s.events && typeof s.events === 'object' ? s.events : {}, // { ev: { sounds?: [refs], chance?: n, off?: true } }
  };
}

export function createCues({ board, getView, onChange }) {
  const cfg = loadCfg();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch {} onChange?.(); };
  const view = () => getView() || {};
  const packCues = () => view().gm?.cues || { events: {}, groups: {} };
  const trace = (globalThis.__cueLog = []); // headless checks
  let randomTimer = null;
  let ambienceFor = null; // location id the ambience belongs to

  const lib = (kind, id) => {
    const k = LIB_KINDS[kind];
    if (!k || !id) return null;
    const list = view().library?.[k] || view().gm?.library?.[k] || [];
    return (Array.isArray(list) ? list : []).find((e) => e.id === id) || null;
  };

  /** One playable pad id for a list of refs (id or tag:x), or null. */
  function pick(refs) {
    const pads = board.pads;
    const ids = [];
    for (const r of refs || []) {
      if (r.startsWith('tag:')) { const t = r.slice(4); for (const p of pads) if (p.tags?.includes(t)) ids.push(p.id); }
      else if (pads.some((p) => p.id === r)) ids.push(r);
    }
    return ids.length ? ids[Math.floor(Math.random() * ids.length)] : null;
  }
  function playRefs(refs, why, opts) {
    const id = pick(refs);
    if (!id) return null;
    trace.push({ why, id, at: Date.now() });
    if (trace.length > 200) trace.shift();
    board.play(id, opts);
    return id;
  }

  /** Effective event config: device override → pack default. */
  function eventCfg(ev) {
    const d = packCues().events?.[ev] || null;
    const o = cfg.events[ev] || {};
    if (o.off) return null;
    const sounds = Array.isArray(o.sounds) ? o.sounds : d?.sounds || [];
    const chance = typeof o.chance === 'number' ? o.chance : d?.chance ?? 1;
    return sounds.length ? { sounds, chance, delayMs: d?.delayMs || 0 } : null;
  }
  /** Sounds for a content slot: entry → its group → null. */
  function contentRefs(entry, slot) {
    if (!entry || !slot) return null;
    if (entry.sounds?.[slot]?.length) return entry.sounds[slot];
    const g = String(entry.group || '').toLowerCase();
    const gr = packCues().groups?.[g]?.[slot];
    return gr?.length ? gr : null;
  }

  function fire(ev, { entry = null, slot = null } = {}) {
    if (!cfg.on) return null;
    const own = contentRefs(entry, slot);
    if (own) return playRefs(own, `${ev}:${entry.id}:${slot}`);
    const c = eventCfg(ev);
    if (!c || Math.random() > c.chance) return null;
    if (c.delayMs) { setTimeout(() => playRefs(c.sounds, ev), c.delayMs); return 'later'; }
    return playRefs(c.sounds, ev);
  }
  /** Moments of an entry that fire on their own for this trigger (chance > 0). */
  function autoMoments(entry, on) {
    for (const m of entry?.moments || []) {
      if (m.on === on && m.chance > 0 && Math.random() <= m.chance && m.sounds?.length) playRefs(m.sounds, `moment:${entry.id}:${m.label}`);
    }
  }

  const api = {
    get config() { return cfg; },
    line(m) {
      const cat = m?.category;
      if (!cat) return;
      const src = m.source ? lib(m.source.kind, m.source.id) : null;
      if (src && m.source.kind === 'boss') {
        if (cat === 'boss_intro') { autoMoments(src, 'intro'); if (src.sounds?.music?.length) playRefs(src.sounds.music, `music:${src.id}`); }
        if (cat === 'boss_defeat') autoMoments(src, 'defeat');
      }
      fire(cat, { entry: src, slot: LINE_SLOT[cat] || null });
    },
    event(e) {
      if (!e?.kind) return;
      if (e.kind === 'boss.phase') {
        const b = lib('boss', view().scene?.data?.bossId);
        autoMoments(b, 'phase');
        fire('boss_phase', { entry: b, slot: 'phase' });
      } else if (e.kind === 'loot.drop') fire('loot_drop');
    },
    /** combat-sfx: a mob's own sound for a combat beat (attack / hit / death / crit), or null to use the default. */
    mob(slot, uid) {
      if (!cfg.on || !uid) return null;
      const x = view().combat?.combatants?.find((c) => c.uid === uid);
      if (!x || x.type !== 'mob') return null;
      const entry = lib(x.sourceKind, x.sourceId);
      if (slot === 'death') autoMoments(entry, 'kill');
      if (slot === 'attack') autoMoments(entry, 'attack');
      const refs = contentRefs(entry, slot);
      return refs ? pick(refs) : null;
    },
    moment(entry, m) {
      if (m.sounds?.length) playRefs(m.sounds, `moment:${entry?.id}:${m.label}`);
    },
    /** Ambience + random sounds follow the location on the TV (explore / fight / NPC scenes keep it). */
    scene(v) {
      const sig = JSON.stringify([v?.gm?.cues, board.pads.length]);
      if (sig !== panelSig) { panelSig = sig; draw(); }
      const sc = v?.scene;
      const keep = sc && ['explore', 'combat', 'npc', 'countdown', 'roll', 'loot'].includes(sc.kind);
      const locId = sc?.kind === 'explore' ? sc.data?.locationId || null : keep ? ambienceFor : null;
      if (locId === ambienceFor) return;
      ambienceFor = locId;
      clearTimeout(randomTimer);
      const loc = lib('location', locId);
      const amb = cfg.ambience && loc ? pick(loc.sounds?.ambience) : null;
      if (amb) board.play(amb, { gain: cfg.ambienceGain }); else board.stopKind('ambience', 2.5);
      if (loc?.sounds?.randoms?.length) scheduleRandom(loc);
    },
    stopAmbience() { ambienceFor = null; clearTimeout(randomTimer); board.stopKind('ambience', 2); },
    panel,
  };

  function scheduleRandom(loc) {
    const [a, b] = loc.sounds.randomEvery || [40, 100];
    randomTimer = setTimeout(() => {
      if (ambienceFor !== loc.id) return;
      if (cfg.randoms && cfg.on && !board.ducked) playRefs(loc.sounds.randoms, `random:${loc.id}`);
      scheduleRandom(loc);
    }, (a + Math.random() * (b - a)) * 1000);
  }

  /* ---------- Show → Sound → Sound cues ---------- */
  let panelEl = null;
  let panelSig = '';
  function panel() {
    panelEl = h('section.snd-cues', { id: 'sound-cues', 'aria-label': 'Sound cues' });
    draw();
    return panelEl;
  }
  function draw() {
    if (!panelEl) return;
    const ids = board.pads.map((p) => p.id);
    const tags = [...new Set(board.pads.flatMap((p) => p.tags || []))].map((t) => `tag:${t}`);
    const dl = h('datalist', { id: 'cue-refs' }, ...[...ids, ...tags].map((v) => h('option', { value: v })));
    const known = new Map(CUE_EVENTS);
    for (const ev of Object.keys(packCues().events || {})) if (!known.has(ev)) known.set(ev, ev);
    const toggle = (key, label, hint) => h('label.chk', { title: hint }, h('input', { type: 'checkbox', checked: cfg[key], onchange: (e) => { cfg[key] = e.target.checked; save(); if (key === 'ambience' && !cfg.ambience) api.stopAmbience(); } }), ` ${label}`);
    const rows = [...known].map(([ev, label]) => {
      const d = packCues().events?.[ev];
      const o = cfg.events[ev] || {};
      const refs = Array.isArray(o.sounds) ? o.sounds : d?.sounds || [];
      const inp = h('input.inp.inp-sm', { value: refs.join(', '), list: 'cue-refs', placeholder: d ? '' : 'none', 'aria-label': `${label} sounds`,
        onchange: (e) => { const v = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); cfg.events[ev] = { ...(cfg.events[ev] || {}), sounds: v }; save(); } });
      const ch = h('input.inp.inp-sm.cue-ch', { type: 'number', min: 0, max: 100, step: 5, value: Math.round(((typeof o.chance === 'number' ? o.chance : d?.chance ?? 1)) * 100), 'aria-label': `${label} chance %`,
        onchange: (e) => { cfg.events[ev] = { ...(cfg.events[ev] || {}), chance: Math.max(0, Math.min(100, Number(e.target.value) || 0)) / 100 }; save(); } });
      const on = h('input', { type: 'checkbox', checked: !o.off, 'aria-label': `${label} on`, onchange: (e) => { cfg.events[ev] = { ...(cfg.events[ev] || {}), off: !e.target.checked }; save(); } });
      const test = h('button.icon-btn', { type: 'button', title: 'Play one now', onclick: () => { board.unlock(); playRefs(refs, `test:${ev}`); } }, icon('play', { size: 14 }));
      const reset = cfg.events[ev] ? h('button.btn-link', { type: 'button', title: 'Back to the pack default', onclick: () => { delete cfg.events[ev]; save(); draw(); } }, 'reset') : null;
      return h('tr', h('td', on), h('td', label), h('td', inp), h('td.cue-chc', ch, h('span.dim', ' %')), h('td', test, reset));
    });
    panelEl.replaceChildren(
      h('div.col-head', h('h2', 'Sound cues'), h('span.dim', 'What plays with each moment. Bosses / monsters / locations can override in Library → Sounds.')),
      h('div.row-start', toggle('on', 'Cues on', 'Play cue sounds automatically'), toggle('ambience', 'Location ambience', 'Loop the location ambience while it is on the TV'), toggle('randoms', 'Random sounds', 'Now and then a random sound of the location (from the rear on 5.1)'),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => api.stopAmbience() }, icon('x', { size: 13 }), 'Stop ambience')),
      dl,
      h('table.cue-table', h('thead', h('tr', h('th', 'On'), h('th', 'Moment'), h('th', 'Sounds (id or tag:…)'), h('th', 'Chance'), h('th', ''))), h('tbody', rows)),
    );
  }
  api.redraw = draw;
  return api;
}
