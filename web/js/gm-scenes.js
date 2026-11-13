// GM desk → Show: the broadcast switcher. Works like a TV control room:
//   ON AIR bar   what the TV shows right now (tap = jump to its controls)
//   chips        every scene (Lobby, Explore, Fight, Boss, NPC, …) + Sound and Desk; the live one is marked
//   panel        the picked chip. Not on air → PREVIEW: its form + a live preview of that scene (a local
//                stage page fed by the server's scene.preview dry run) + GO LIVE. On air → its live controls.
// Fight = the shared combat tracker (its own state, independent of the scene); GO LIVE puts the boss
// screen on the TV when a boss is in the fight, else the arena (VS). Boss = boss + minions (packs of 4+
// of one monster fight together) + up to 3 attack buttons; GO LIVE always plays the intro.
// Also makes this page the audio device (System voice + stingers).
//
// Mounted from gm.js: createScenes({ client, act, getView }) → { update, mountInto(section, parts) }.
import { h, toast } from './client.js';
import { icon, field, select, labeled } from './ui.js';
import { createGmAudio } from './gm-audio.js';

const SCENES = [
  { kind: 'lobby', label: 'Lobby', key: 'F1', hint: 'Title card + join QR' },
  { kind: 'explore', label: 'Explore', key: 'F2', hint: 'Where the party is' },
  { kind: 'fight', label: 'Fight', key: '', hint: 'Tracker. TV: arena, or the boss screen' },
  { kind: 'boss', label: 'Boss', key: 'F3', hint: 'Boss, minions, attacks' },
  { kind: 'npc', label: 'NPC', key: '', hint: 'Portrait + speak as the NPC' },
  { kind: 'loot', label: 'Loot', key: 'F4', hint: 'A box for one crawler' },
  { kind: 'countdown', label: 'Countdown', key: 'F5', hint: 'Floor collapse timer' },
  { kind: 'roll', label: 'Big roll', key: 'F6', hint: 'Dice on the TV' },
  { kind: 'recap', label: 'Recap', key: 'F7', hint: 'Previously on…' },
  { kind: 'blank', label: 'Stand by', key: 'F8', hint: 'Logo only' },
];
const TOOLS = [
  { id: 'crawlers', label: 'Crawlers', icon: 'skull', hint: 'Crawlers remaining: announce, events elsewhere, floor collapse, deaths' },
  { id: 'sound', label: 'Sound', icon: 'bolt' },
  { id: 'desk', label: 'Desk', icon: 'chat', hint: 'Quips, comms, audience, recap' },
];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const PACK_MIN = 4; // same as scenes/boss.js: 4+ copies of one monster fight (and show) as one pack
const MAX_ATTACKS = 3;

const store = {
  get(k, d) { try { const v = localStorage.getItem(`system.scenes.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`system.scenes.${k}`, JSON.stringify(v)); } catch {} },
};

function fmtClock(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const p = (n) => String(n).padStart(2, '0');
  return t >= 3600 ? `${Math.floor(t / 3600)}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}` : `${p(Math.floor(t / 60))}:${p(t % 60)}`;
}

/** "Name | text | atHp" per line → phases. */
function parsePhases(src) {
  return String(src || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 10).map((l) => {
    const [name, text = '', at = ''] = l.split('|').map((x) => x.trim());
    const atHp = /^\d+$/.test(at) ? Number(at) : null;
    return { name: name.slice(0, 60), text: text.slice(0, 300), ...(atHp != null ? { atHp } : {}) };
  });
}

const sign = (n) => (n > 0 ? `+${n}` : String(n || 0));
const hasDmg = (a) => a.damage && !/^0+$/.test(a.damage.trim());
/** Up to five words for the attack button: the pack's `short`, else the start of its effects text. */
export function shortOf(a) {
  if (a.short) return a.short;
  const words = String(a.effects || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return hasDmg(a) ? `${a.damage} damage` : '';
  const cut = words.slice(0, 5).join(' ').replace(/[.,;:]+$/, '');
  return words.length > 5 ? `${cut}…` : cut;
}

/** Mobs of the fight that are not a boss, grouped: one row per mob, or one per pack (4+ of one monster). */
export function minionRows(combat) {
  const mobs = (combat?.combatants || []).filter((x) => x.type === 'mob' && x.sourceKind !== 'boss');
  const groups = new Map();
  for (const m of mobs) {
    const k = m.sourceId ? `${m.sourceKind}:${m.sourceId}` : m.name.replace(/\s+\d+$/, '');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const out = [];
  for (const [key, list] of groups) {
    if (list.length >= PACK_MIN) out.push({ key, pack: true, name: list[0].name.replace(/\s+\d+$/, ''), members: list });
    else for (const m of list) out.push({ key: m.uid, pack: false, name: m.name, members: [m] });
  }
  return out;
}

export function createScenes({ client, act, getView }) {
  const audio = createGmAudio({ client, getView });
  const view = () => getView() || {};
  // Drafts per scene kind (what F-keys / GO LIVE send). Persisted per device.
  const draft = store.get('draft', {});
  const D = (k) => (draft[k] ||= {});
  const saveDraft = () => store.set('draft', draft);
  let tab = store.get('tab2', 'lobby');
  if (![...SCENES.map((s) => s.kind), ...TOOLS.map((t) => t.id)].includes(tab)) tab = 'lobby';
  let bossPick = D('boss').bossId ?? null;
  const pref = { atkTv: store.get('atkTv', true), pv: store.get('pv2', true) };
  const ui = { openAtk: new Set(), bossTarget: null, editOpen: false };
  const parts = { fight: null, npcs: null, sound: null, desk: null, crawlers: null, goLiveFight: null };

  /* ---------- shell ---------- */
  const onair = h('button.sh-onair', { type: 'button', onclick: () => { const k = liveChip(); if (k) pick(k); } });
  const soundState = h('span.sc-sound');
  const barExtra = h('span.sh-bar-extra'); // gm-crawlers.js badge
  const chips = h('div.sh-chips', { role: 'tablist', 'aria-label': 'Show' });
  const head = h('div.sh-head');
  const body = h('div.sh-body');
  const pvBox = h('div.sc-preview');
  const pvToggle = h('button.btn.btn-sm.btn-quiet.sh-pv-toggle', { type: 'button', onclick: () => { pref.pv = !pref.pv; store.set('pv2', pref.pv); drawPanel(); } });
  const pvCol = h('div.sh-pv', h('div.sh-pv-head', h('span.sh-pv-k', 'Preview'), h('span.dim', 'Not on the TV yet'), h('span.grow'), pvToggle), pvBox);
  const golive = h('div.sh-golive');
  const panel = h('div.sh-panel', head, h('div.sh-grid', body, pvCol), golive);
  const el = h('section.show2', { 'aria-label': 'Show' },
    h('div.sh-bar', h('div.sh-bar-top', onair, barExtra, soundState), chips),
    panel);

  function setDevice(d) {
    act({ t: 'show.audio', device: d }, d === 'gm' ? 'Sound plays on this desk.' : 'Sound plays on the TV.');
  }
  function drawAudio() {
    const dev = view().show?.audioDevice || 'gm';
    if (dev !== 'gm') soundState.replaceChildren();
    else if (!audio.unlocked) soundState.replaceChildren(h('span.sc-warn', icon('warn', { size: 14 }), 'Tap anywhere to enable sound'));
    else soundState.replaceChildren();
    if (audioPanel) drawAudioPanel();
  }
  audio.onChange = drawAudio;

  /** Sound settings (audio device, stingers, test): top of the Sound chip. */
  let audioPanel = null;
  const audioSeg = h('div.seg.seg-sm', { role: 'radiogroup', 'aria-label': 'Audio device' },
    h('button', { type: 'button', role: 'radio', 'data-dev': 'gm', onclick: () => setDevice('gm') }, 'GM desk'),
    h('button', { type: 'button', role: 'radio', 'data-dev': 'stage', onclick: () => setDevice('stage') }, 'TV'));
  const stingBtn = h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => { audio.stingersOn = !audio.stingersOn; drawAudio(); } });
  const testBtn = h('button.btn.btn-sm.btn-quiet', { type: 'button', title: 'Play the boss stinger here', onclick: () => audio.test() }, 'Test sound');
  const audioState = h('span.sc-sound');
  function drawAudioPanel() {
    const dev = view().show?.audioDevice || 'gm';
    for (const b of audioSeg.children) b.setAttribute('aria-checked', String(b.dataset.dev === dev));
    stingBtn.setAttribute('aria-pressed', String(audio.stingersOn));
    stingBtn.replaceChildren(icon('bolt', { size: 14 }), audio.stingersOn ? 'Stingers on' : 'Stingers off');
    if (dev !== 'gm') audioState.replaceChildren(h('span.dim', 'The TV plays voice and stingers'));
    else if (!audio.unlocked) audioState.replaceChildren(h('span.sc-warn', icon('warn', { size: 14 }), 'Click anywhere on this page to enable sound'));
    else audioState.replaceChildren(h('span.sc-ok', 'Sound ready'));
    testBtn.hidden = dev !== 'gm';
  }
  audioPanel = h('div.sc-bar', h('span.sc-bar-t', 'Audio plays on'), audioSeg, stingBtn, testBtn, audioState);

  /* ---------- what is on air ---------- */
  const sceneOf = (kind) => SCENES.find((s) => s.kind === kind);
  /** The chip that is on the TV now (the arena and the fight finale belong to Fight). */
  function liveChip() {
    const k = view().scene?.kind;
    if (!k) return null;
    if (k === 'combat' || k === 'finale') return 'fight';
    return sceneOf(k) ? k : null;
  }
  const isLive = (kind) => liveChip() === kind;
  /** The fight is on the TV: arena / finale, or the boss screen of a boss that is in the fight. */
  const fightOnAir = () => isLive('fight') || (view().scene?.kind === 'boss' && !!fightBoss());

  function drawOnair() {
    const sc = view().scene;
    const k = liveChip();
    let what = sc ? (sceneOf(k)?.label || sc.kind) : 'Nothing';
    if (sc?.kind === 'combat') what = 'Fight: arena';
    else if (sc?.kind === 'finale') what = 'Fight: finale';
    let detail = '';
    if (sc?.kind === 'boss') detail = `${sc.data.boss?.name || ''}, ${sc.data.hp}/${sc.data.boss?.hpSlots} HP`;
    else if (sc?.kind === 'npc') detail = sc.data.npc?.name || '';
    else if (sc?.kind === 'explore') detail = [sc.data.floor, sc.data.location].filter(Boolean).join(', ');
    else if (sc?.kind === 'combat') { const c = view().combat || {}; detail = c.active ? `round ${c.round}` : 'not started'; }
    onair.replaceChildren(...[h('span.sh-onair-k', 'On air'), h('b', what), detail ? h('span.sh-onair-d', detail) : null, k && k !== tab ? h('span.sh-onair-go', 'Controls', icon('chevron', { size: 13 })) : null].filter(Boolean));
    onair.disabled = !k || k === tab;
  }

  /* ---------- chips ---------- */
  function drawChips() {
    const live = liveChip();
    const chip = (id, label, extra = {}) => h('button.sh-chip', {
      type: 'button', role: 'tab', 'aria-selected': String(tab === id), 'data-id': id,
      class: `sh-chip${live === id ? ' is-live' : ''}${extra.tool ? ' tool-chip' : ''}`,
      title: extra.hint || null,
      onclick: () => pick(id),
    }, live === id ? h('i.sh-live-dot', { 'aria-label': 'on air' }) : null, extra.icon ? icon(extra.icon, { size: 14 }) : null, label, extra.key ? h('kbd', extra.key) : null);
    chips.replaceChildren(
      ...SCENES.map((s) => chip(s.kind, s.label, { key: s.key, hint: s.hint })),
      h('span.sh-sep', { 'aria-hidden': 'true' }),
      ...TOOLS.map((t) => chip(t.id, t.label, { tool: true, icon: t.icon, hint: t.hint })));
    // Keep the picked chip in view (horizontal only: never scroll the page).
    const cur = chips.querySelector('[aria-selected="true"]');
    if (cur) requestAnimationFrame(() => {
      const l = cur.offsetLeft - chips.offsetLeft;
      if (l < chips.scrollLeft || l + cur.offsetWidth > chips.scrollLeft + chips.clientWidth) chips.scrollLeft = Math.max(0, l - 24);
    });
  }

  function pick(id) {
    if (tab !== id) ui.editOpen = false;
    tab = id;
    store.set('tab2', tab);
    sig = '';
    drawAll();
  }

  /* ---------- scene data from the drafts ---------- */
  function bossDraftData() {
    const d = D('boss');
    if (d.mode === 'adhoc') {
      return { boss: { name: d.name || 'Unnamed horror', title: d.title || '', hpSlots: Number(d.hpSlots) || 10, image: d.image || null, color: d.color || null, phases: parsePhases(d.phases), intro: d.intro || '' } };
    }
    const id = bossPick || view().library?.boss?.[0]?.id;
    return id ? { bossId: id } : null;
  }
  function dataFor(kind) {
    const d = { ...D(kind) };
    const v = view();
    if (kind === 'boss') return bossDraftData();
    if (kind === 'countdown') return { label: d.label || 'Floor collapse in', seconds: Math.max(1, Math.round((Number(d.minutes) || 0) * 60 + (Number(d.seconds) || 0))) || 300, autostart: !!d.autostart };
    if (kind === 'loot') {
      const pid = d.playerId || v.players?.[0]?.id || null;
      const tier = d.tier || v.pack?.lootTiers?.[0]?.id || null;
      return { ...(pid ? { playerId: pid } : {}), ...(tier ? { tier } : {}) };
    }
    if (kind === 'roll') return d.playerId ? { playerId: d.playerId, label: d.label || '' } : { label: d.label || '' };
    if (kind === 'explore') {
      const out = { location: d.location || '', floor: d.floor || '', image: d.image || null, text: d.text || '', showFeed: d.showFeed !== false };
      if (d.locationId) out.locationId = d.locationId;
      return out;
    }
    if (kind === 'lobby') return { title: d.title || '', subtitle: d.subtitle || '', showQr: d.showQr !== false };
    if (kind === 'recap') return { title: d.title || '', text: d.text ?? (v.recap || '') };
    if (kind === 'blank') return { text: d.text || '' };
    if (kind === 'combat') return { title: D('fight').title || '' };
    if (kind === 'npc') {
      const id = d.npcId || v.library?.npc?.[0]?.id;
      return id ? { npcId: id } : null;
    }
    return {};
  }
  /** The scene kind GO LIVE sends for a chip (Fight → boss screen when a boss is in the fight). */
  function fightBoss() {
    return (view().combat?.combatants || []).find((x) => x.type === 'mob' && x.sourceKind === 'boss' && !x.down) || null;
  }
  function sceneKindFor(chipId) {
    if (chipId === 'fight') return fightBoss() ? 'boss' : 'combat';
    return chipId;
  }
  function sceneDataFor(chipId) {
    if (chipId === 'fight') {
      const b = fightBoss();
      return b ? { bossId: b.sourceId } : dataFor('combat');
    }
    return dataFor(chipId);
  }

  /* ---------- GO LIVE ---------- */
  async function goLive(chipId) {
    if (chipId === 'boss') return goLiveBoss(bossDraftData());
    if (chipId === 'fight') {
      const b = fightBoss();
      if (b) return goLiveBoss({ bossId: b.sourceId });
      return act({ t: 'scene.set', kind: 'combat', data: dataFor('combat') }, 'On air: the arena.');
    }
    const data = dataFor(chipId);
    if (data === null) { toast(chipId === 'npc' ? 'No NPCs in the library yet.' : 'Nothing to show yet.', { error: true }); return false; }
    const label = sceneOf(chipId)?.label || chipId;
    // explore: a picked location fills the fields; typed fields override it.
    if (chipId === 'explore' && data.locationId) {
      const ok = await act({ t: 'scene.set', kind: chipId, data: { locationId: data.locationId, showFeed: data.showFeed } }, null);
      const over = {};
      for (const k of ['location', 'floor', 'text']) if (D('explore')[`${k}Touched`]) over[k] = data[k];
      if (ok && Object.keys(over).length) await act({ t: 'scene.update', data: over }, null);
      if (ok) toast(`On air: ${label}.`);
      return ok;
    }
    return act({ t: 'scene.set', kind: chipId, data }, `On air: ${label}.`);
  }

  /**
   * Boss: scene → the boss joins the fight (library bosses have attacks) → prepared minions are revealed →
   * the fight starts → intro cinematic, always.
   */
  async function goLiveBoss(data) {
    if (!data) { toast('Pick a boss first (or build one ad hoc).', { error: true }); return false; }
    if (!(await act({ t: 'scene.set', kind: 'boss', data }, null))) return false;
    const c = view().combat || {};
    if (data.bossId && !(c.combatants || []).some((x) => x.type === 'mob' && x.sourceKind === 'boss' && x.sourceId === data.bossId)) {
      await act({ t: 'combat.addMob', kind: 'boss', sourceId: data.bossId, hidden: false }, null);
    }
    if ((view().combat?.combatants || []).some((x) => x.type === 'mob' && x.hidden && !x.down)) await act({ t: 'combat.reveal', all: true }, null);
    if (!view().combat?.active) await act({ t: 'combat.start' }, null);
    await act({ t: 'boss.intro' }, null);
    toast('On air: boss intro.');
    pick('boss');
    return true;
  }

  /* ---------- the preview: a local stage page fed by scene.preview ---------- */
  let pvFrame = null;
  let pvReady = false;
  let pvScene = null;
  let pvReq = 0;
  let pvTimer = 0;
  let pvKey = '';
  const pvMsg = h('p.dim.sc-pv-off');
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !pvFrame || e.source !== pvFrame.contentWindow) return;
    if (e.data?.t === 'draft.ready') { pvReady = true; pvPost(); }
  });
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
    const box = pvBox.querySelector('.sc-pv-box');
    if (box && pvFrame) pvFrame.style.transform = `scale(${box.clientWidth / 1920})`;
  }) : null;
  ro?.observe(pvBox);

  /** View for the preview: the GM view with the dry-run scene; hidden (prepared) minions shown as they will be. */
  function draftView() {
    const v = view();
    const c = v.combat || {};
    const shown = (c.combatants || []).map((x) => (x.type === 'mob'
      ? { ...x, hidden: false, boss: x.sourceKind === 'boss', group: x.sourceId ? `${x.sourceKind}:${x.sourceId}` : null, hpPct: x.hpMax ? x.hp / x.hpMax : 1 }
      : x));
    return { ...v, scene: pvScene, combat: { ...c, active: c.active || pvScene?.kind === 'boss', combatants: shown } };
  }
  function pvPost() {
    if (!pvReady || !pvScene || !pvFrame?.contentWindow) return;
    try { pvFrame.contentWindow.postMessage({ t: 'draft.view', view: JSON.parse(JSON.stringify(draftView())) }, location.origin); } catch (err) { console.error(err); }
  }
  function pvEnsureFrame() {
    if (pvFrame) return;
    pvReady = false;
    pvFrame = h('iframe.sc-pv', { title: 'Preview of the scene', src: '/stage?draft=1', tabindex: '-1' });
    pvBox.replaceChildren(h('div.sc-pv-box', pvFrame), pvMsg);
    requestAnimationFrame(() => { const box = pvBox.querySelector('.sc-pv-box'); if (box) pvFrame.style.transform = `scale(${box.clientWidth / 1920})`; });
  }
  function pvDrop() {
    if (!pvFrame) return;
    pvFrame = null;
    pvReady = false;
    pvScene = null;
    pvKey = '';
    pvBox.replaceChildren();
  }
  /** Asks the server for the dry-run scene of the picked chip (debounced; the same draft is asked once). */
  function pvRefresh() {
    const wantPv = pref.pv && !isTool(tab) && !isLive(tab) && el.isConnected && !el.closest('[hidden]');
    pvToggle.replaceChildren(icon('tv', { size: 14 }), pref.pv ? 'Hide' : 'Show preview');
    pvCol.classList.toggle('off', !pref.pv);
    if (!wantPv) { pvDrop(); return; }
    const kind = sceneKindFor(tab);
    const data = sceneDataFor(tab);
    if (!data) { pvEnsureFrame(); pvMsg.textContent = 'Nothing to preview yet.'; return; }
    pvEnsureFrame();
    const key = JSON.stringify([kind, data]);
    if (key === pvKey) { pvPost(); return; }
    clearTimeout(pvTimer);
    pvTimer = setTimeout(async () => {
      const n = ++pvReq;
      try {
        const r = await client.send({ t: 'scene.preview', kind, data });
        if (n !== pvReq) return;
        pvKey = key;
        pvScene = r?.result?.scene || null;
        pvMsg.textContent = '';
        pvPost();
      } catch (err) {
        if (n === pvReq) pvMsg.textContent = `Preview: ${err.message}`;
      }
    }, 150);
  }

  /* ---------- live controls ---------- */
  let cdTimer = null;
  function liveControls(kind) {
    const sc = view().scene;
    clearInterval(cdTimer);
    if (kind === 'boss') return bossLive(sc);
    if (kind === 'countdown') return countdownControls(sc);
    if (kind === 'loot') return lootControls(sc);
    if (kind === 'roll') return h('div.sc-live-row', h('p.sc-line', sc.data.total == null ? `Waiting: ${sc.data.name || 'someone'} is up.` : `${sc.data.name} rolled ${sc.data.total}${sc.data.nat20 ? ' (natural 20)' : sc.data.nat1 ? ' (natural 1)' : ''}.`),
      h('button.btn.btn-primary', { type: 'button', onclick: rollOnTv }, icon('dice', { size: 15 }), 'Roll again'));
    if (kind === 'explore') return h('p.sc-line', [sc.data.floor, sc.data.location].filter(Boolean).join(', ') || 'Exploring');
    if (kind === 'npc') return h('p.sc-line', `${sc.data.npc?.name || 'NPC'}${sc.data.line ? `: “${sc.data.line}”` : ''}`);
    return h('p.sc-line.dim', 'On the TV now. Change it below and press Update.');
  }

  function bossLib(id) { return (view().library?.boss || []).find((b) => b.id === id) || null; }
  const bossFighterFor = (bossId) => (view().combat?.combatants || []).find((x) => x.type === 'mob' && x.sourceKind === 'boss' && (!bossId || x.sourceId === bossId)) || null;

  function bossLive(sc) {
    const d = sc.data;
    const b = d.boss;
    const lib = d.bossId ? bossLib(d.bossId) : null;
    const max = b.hpSlots;
    const next = b.phases[d.phase + 1];
    const cur = b.phases[d.phase];
    const send = (a, msg) => act(a, msg);
    const big = (label, cls, onclick, opts = {}) => h(`button.btn.sc-big${cls}`, { type: 'button', onclick, disabled: !!opts.disabled, title: opts.title || null }, label);
    const hpBar = h('div.sc-hp', { style: { '--n': String(max) } }, Array.from({ length: max }, (_, i) => h('i', { class: i < d.hp ? 'on' : '' })));
    const sug = d.suggestPhase != null && b.phases[d.suggestPhase]
      ? h('div.sc-suggest', icon('warn', { size: 16 }),
        h('span', `HP ${d.hp}: phase "${b.phases[d.suggestPhase].name}" is due.`),
        h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => send({ t: 'boss.phase', index: d.suggestPhase }, `Phase: ${b.phases[d.suggestPhase].name}.`) }, 'Advance'))
      : null;
    const tvLoot = field(d.lootHint, { placeholder: 'e.g. Silver crate incoming', onCommit: (v) => send({ t: 'scene.update', data: { lootHint: v } }, 'Loot line set.') });
    const fighter = d.bossId ? bossFighterFor(d.bossId) : null;
    const attacks = fighter?.attacks || lib?.attacks || [];
    return h('div.sc-boss',
      h('div.sc-boss-top',
        h('div', h('div.sc-boss-name', b.name), b.title ? h('div.dim', b.title) : null),
        h('div.sc-boss-hp', h('b', String(d.hp)), h('span.dim', ` / ${max} HP`))),
      hpBar,
      sug,
      h('div.sc-boss-row',
        big('−1', '.sc-dmg', () => send({ t: 'boss.damage', amount: 1 }), { disabled: d.hp <= 0 }),
        big('−2', '.sc-dmg', () => send({ t: 'boss.damage', amount: 2 }), { disabled: d.hp <= 0 }),
        big('−3', '.sc-dmg', () => send({ t: 'boss.damage', amount: 3 }), { disabled: d.hp <= 0 }),
        big('+1', '.sc-heal', () => send({ t: 'boss.heal', amount: 1 }), { disabled: d.hp >= max, title: 'Heal 1' }),
        big(next ? `Phase: ${next.name}` : 'Last phase', '.sc-phase', () => send({ t: 'boss.phase' }, next ? `Phase: ${next.name}.` : null), { disabled: !next }),
        big(d.defeated ? 'Defeated' : 'Defeat', '.btn-danger.sc-defeat', () => send({ t: 'boss.defeat' }, 'Boss defeated.')),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => send({ t: 'boss.intro' }, 'Boss intro.'), title: 'Cinematic + intro line again' }, 'Replay intro')),
      attacks.length ? attackSection(b.name, attacks, fighter, d.bossId, { boss: true }) : null,
      minionSection(true),
      h('div.sc-boss-info',
        h('div.sc-gm-only',
          h('p.sc-gm-k', icon('lock', { size: 12 }), 'GM only'),
          cur ? h('p', h('b', `Phase ${ROMAN[d.phase] || d.phase + 1}: ${cur.name}. `), cur.text || '') : null,
          lib?.tactics ? h('p', h('b', 'Tactics. '), lib.tactics) : null,
          lib?.lootHint ? h('p', h('b', 'Loot. '), lib.lootHint) : null),
        labeled('Loot line on TV after defeat', tvLoot)),
    );
  }

  /** Rolls go to the TV (cinematic + public dice) or stay with the GM: one switch for every attack button. */
  function tvSwitch() {
    return h('label.sh-tvsw', { title: 'On: the TV plays the attack and everyone sees the dice. Off: only you see the roll; the damage still lands on the sheet.' },
      h('input', { type: 'checkbox', checked: pref.atkTv, onchange: (e) => { pref.atkTv = e.target.checked; store.set('atkTv', pref.atkTv); sig = ''; drawAll(); } }),
      h('span', pref.atkTv ? 'Rolls on TV' : 'Rolls GM only'));
  }

  function targetSeg() {
    const crawlers = (view().combat?.combatants || []).filter((x) => x.type === 'crawler');
    if (!crawlers.length) return null;
    if (ui.bossTarget && !crawlers.some((x) => x.uid === ui.bossTarget)) ui.bossTarget = null;
    return h('div.seg.seg-sm.sc-batk-tgt', { role: 'radiogroup', 'aria-label': 'Target' },
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(!ui.bossTarget), onclick: () => { ui.bossTarget = null; sig = ''; drawAll(); } }, 'Auto'),
      ...crawlers.map((x) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(ui.bossTarget === x.uid), disabled: x.down, title: `${x.name}: ${x.hp}/${x.hpMax} HP, Evade ${x.evade ?? '?'}`, onclick: () => { ui.bossTarget = x.uid; sig = ''; drawAll(); } }, x.name)));
  }

  /** Attack buttons (max 3 + "more"): tap rolls it for real, ⓘ opens the details. */
  function attackButtons(attacks, ownerKey, roll, { disabled = false } = {}) {
    const one = (a, i) => {
      const k = `${ownerKey}:${i}`;
      const open = ui.openAtk.has(k);
      return h('div.sh-atk', { class: open ? 'sh-atk open' : 'sh-atk' },
        h('button.sh-atk-go', { type: 'button', disabled, onclick: () => roll(i), title: `Roll ${a.name}` },
          h('b', a.name), h('span.sh-atk-s', shortOf(a))),
        h('button.icon-btn.sh-atk-i', { type: 'button', 'aria-expanded': String(open), 'aria-label': `Details: ${a.name}`, onclick: () => { open ? ui.openAtk.delete(k) : ui.openAtk.add(k); sig = ''; drawAll(); } }, icon(open ? 'up' : 'info', { size: 14 })),
        open ? h('div.sh-atk-d',
          h('p.sh-atk-k', `${sign(a.toHit)} to hit${hasDmg(a) ? ` · ${a.damage} damage` : ''}${a.buffs?.length ? ` · ${a.buffs.join(', ')}` : ''}`),
          a.effects ? h('p', a.effects) : null) : null);
    };
    const shown = attacks.slice(0, MAX_ATTACKS).map((a, i) => one(a, i));
    const rest = attacks.length > MAX_ATTACKS
      ? h('details.sh-atk-more', h('summary', `${attacks.length - MAX_ATTACKS} more`), h('div.sh-atks', attacks.slice(MAX_ATTACKS).map((a, j) => one(a, j + MAX_ATTACKS))))
      : null;
    return h('div.sh-atks', shown, rest);
  }

  function attackToast(name, r) {
    const st = r?.result?.sequence?.[0] ?? r?.sequence?.[0];
    if (st) toast(`${name} → ${st.target}: ${st.total} vs ${st.evade} ${st.hit ? `HIT${st.damage ? `, −${st.damage} HP` : ''}${st.crit ? ' (crit)' : ''}${st.down ? `, ${st.target} is down` : ''}` : 'miss'}`, { ms: 5000 });
  }

  /** The boss's attacks: not in the fight yet → the first tap puts him in (and starts it), then rolls. */
  function attackSection(name, attacks, fighter, bossId, { boss = false, prep = false } = {}) {
    if (prep) {
      return h('div.sc-batk',
        h('div.sc-batk-head', h('b', 'Attacks'), h('span.dim', 'You roll them here once he is on air')),
        attackButtons(attacks, `prep:${bossId || name}`, () => {}, { disabled: true }));
    }
    const roll = async (i) => {
      let uid = fighter?.uid;
      if (!uid && bossId) {
        const r = await act({ t: 'combat.addMob', kind: 'boss', sourceId: bossId, hidden: false }, null);
        uid = r?.result?.uids?.[0];
      }
      if (!uid) return;
      if (!view().combat?.active && !(await act({ t: 'combat.start' }, null))) return;
      const r = await act({ t: 'combat.mobAct', uid, attackIndex: i, tv: pref.atkTv, ...(ui.bossTarget ? { targetUid: ui.bossTarget } : {}) }, null);
      attackToast(attacks[i].name, r);
    };
    return h('div.sc-batk',
      h('div.sc-batk-head', h('b', boss ? 'Attacks' : `${name}: attacks`), h('span.grow'), tvSwitch()),
      h('div.sc-batk-head', h('span.dim', 'Target'), targetSeg() || h('span.dim', 'everyone (the fight starts on the first attack)')),
      attackButtons(attacks, fighter?.uid || bossId || name, roll, { disabled: fighter ? fighter.hp <= 0 : false }));
  }

  /* minions: single mobs and packs, with HP and their attacks */
  let addPick = '';
  let addCount = 1;
  function minionSection(live) {
    const rows = minionRows(view().combat);
    const mons = view().library?.monster || [];
    const aliveOf = (r) => r.members.filter((m) => !m.down);
    const rollMob = async (r, i) => {
      const alive = aliveOf(r).filter((m) => m.attacks?.[i]);
      if (!alive.length) return;
      const m = alive[Math.floor(Math.random() * alive.length)]; // a pack: whoever is in front
      if (!view().combat?.active && !(await act({ t: 'combat.start' }, null))) return;
      if (m.hidden) await act({ t: 'combat.reveal', uid: m.uid }, null);
      const res = await act({ t: 'combat.mobAct', uid: m.uid, attackIndex: i, tv: pref.atkTv, ...(ui.bossTarget ? { targetUid: ui.bossTarget } : {}) }, null);
      attackToast(`${m.name}: ${m.attacks[i].name}`, res);
    };
    // A pack takes damage at the front: the first living member.
    const hit = (r, amount) => { const m = aliveOf(r)[0]; if (m) act({ t: 'combat.damage', uid: m.uid, amount }); };
    const heal = (r) => { const m = [...r.members].reverse().find((x) => x.hp < x.hpMax); if (m) act({ t: 'combat.heal', uid: m.uid, amount: 1 }); };
    const row = (r) => {
      const alive = aliveOf(r);
      const hidden = r.members.some((m) => m.hidden);
      const first = r.members[0];
      const hpTxt = r.pack ? `${alive.length}/${r.members.length} standing` : `${first.hp}/${first.hpMax} HP`;
      return h('li.sh-min', { class: `sh-min${alive.length ? '' : ' down'}${r.pack ? ' pack' : ''}` },
        h('div.sh-min-top',
          h('b', r.pack ? `${r.name} ×${r.members.length}` : r.name),
          r.pack ? h('span.pill', 'Pack') : null,
          hidden ? h('span.pill', { title: 'Shown on the TV when you go live or reveal it' }, icon('eyeOff', { size: 12 }), 'hidden') : null,
          h('span.grow'),
          h('span.sh-min-hp', hpTxt),
          h('button.icon-btn.xs', { type: 'button', 'aria-label': `1 damage to ${r.name}`, disabled: !alive.length, onclick: () => hit(r, 1) }, icon('minus', { size: 13 })),
          h('button.icon-btn.xs', { type: 'button', 'aria-label': `Heal ${r.name} 1`, onclick: () => heal(r) }, icon('plus', { size: 13 })),
          h('button.icon-btn.xs', { type: 'button', 'aria-label': `Remove ${r.name}`, title: 'Remove from the fight', onclick: async () => { for (const m of r.members) await act({ t: 'combat.remove', uid: m.uid }, null); } }, icon('x', { size: 13 }))),
        r.pack ? h('div.sh-pips', r.members.map((m) => h('i', { class: m.down ? 'gone' : '' }))) : h('div.sh-hpbar', h('i', { style: { width: `${first.hpMax ? (first.hp / first.hpMax) * 100 : 0}%` } })),
        first.attacks?.length && alive.length ? attackButtons(first.attacks, r.key, (i) => rollMob(r, i)) : null);
    };
    if (!addPick || !mons.some((m) => m.id === addPick)) addPick = mons[0]?.id || '';
    const add = mons.length ? h('div.sh-min-add',
      select(mons.map((m) => ({ value: m.id, label: `${m.floor != null && m.floor !== '' ? `F${m.floor} ` : ''}${m.name} (${m.hpSlots ?? '?'} HP)` })), addPick, { onChange: (v) => { addPick = v; } }),
      h('input.inp.inp-sm.sh-cnt', { type: 'number', min: 1, max: 20, value: addCount, 'aria-label': 'How many', onchange: (e) => { addCount = Math.max(1, Math.min(20, Number(e.target.value) || 1)); } }),
      h('button.btn.btn-sm', {
        type: 'button',
        onclick: async () => {
          const e = mons.find((m) => m.id === addPick);
          if (!e) return;
          await act({ t: 'combat.addMob', kind: 'monster', sourceId: e.id, count: addCount, hidden: !live }, `${addCount > 1 ? `${addCount}× ` : ''}${e.name} ${live ? 'joins the fight' : 'ready (hidden until you go live)'}.`);
        },
      }, icon('plus', { size: 13 }), 'Add')) : h('p.dim', 'No monsters in the library.');
    return h('div.sh-mins',
      h('div.sc-batk-head', h('b', 'Minions'), h('span.dim', rows.length ? `${PACK_MIN}+ of one kind fight as a pack` : 'None yet. A boss rarely comes alone.')),
      rows.length ? h('ul.sh-min-list', rows.map(row)) : null,
      add);
  }

  function countdownControls(sc) {
    const d = sc.data;
    const clock = h('div.sc-clock');
    const offset = (sc.now || Date.now()) - Date.now();
    const tick = () => {
      const left = d.running && d.endsAt ? Math.max(0, d.endsAt - (Date.now() + offset)) : d.remainingMs;
      clock.textContent = fmtClock(left);
      clock.classList.toggle('urgent', left <= 60_000);
    };
    tick();
    cdTimer = setInterval(tick, 250);
    const add = (s) => h('button.btn.btn-sm', { type: 'button', onclick: () => act({ t: 'countdown.add', seconds: s }) }, s > 0 ? `+${s >= 60 ? `${s / 60} min` : `${s} s`}` : `−${-s >= 60 ? `${-s / 60} min` : `${-s} s`}`);
    return h('div.sc-cd',
      clock,
      h('div.sc-boss-row',
        d.running
          ? h('button.btn.sc-big', { type: 'button', onclick: () => act({ t: 'countdown.pause' }, 'Paused.') }, 'Pause')
          : h('button.btn.btn-primary.sc-big', { type: 'button', disabled: d.remainingMs <= 0, onclick: () => act({ t: 'countdown.start' }, 'Countdown running.') }, 'Start'),
        add(-30), add(30), add(60), add(300),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => act({ t: 'countdown.reset' }, 'Reset.') }, 'Reset')),
    );
  }

  function lootControls(sc) {
    const p = view().players?.find((x) => x.id === sc.data.playerId);
    const tier = view().pack?.lootTiers?.find((t) => t.id === sc.data.tier);
    return h('div.sc-boss-row',
      h('button.btn.btn-primary.sc-big', { type: 'button', disabled: !p || !tier, onclick: () => act({ t: 'loot.open', playerId: p.id, tier: tier.id }, `${p.name} opens the ${tier.name}.`) }, `Open the box${p ? ` for ${p.name}` : ''}`),
      h('span.dim', tier ? tier.name : 'Pick a tier below'));
  }

  /* ---------- per-scene forms (drafts) ---------- */
  const changed = () => { sig = ''; pvRefresh(); drawGoLive(); };
  function txt(kind, key, label, opts = {}) {
    return labeled(label, field(D(kind)[key] ?? opts.dflt ?? '', {
      placeholder: opts.placeholder || '', multiline: !!opts.rows, rows: opts.rows || 3,
      attrs: { maxlength: opts.max || 200 },
      onCommit: (v) => { D(kind)[key] = v; if (opts.touch) D(kind)[`${key}Touched`] = true; saveDraft(); changed(); },
    }), { cls: opts.cls || '' });
  }
  function chk(kind, key, label, dflt = true) {
    const v = D(kind)[key] ?? dflt;
    return h('label.chk', h('input', { type: 'checkbox', checked: !!v, onchange: (e) => { D(kind)[key] = e.target.checked; saveDraft(); changed(); } }), h('span', label));
  }
  function crawlerSelect(kind, { allowNone = false } = {}) {
    const ps = view().players || [];
    const opts = [...(allowNone ? [{ value: '', label: 'The GM' }] : []), ...ps.map((p) => ({ value: p.id, label: p.name }))];
    return labeled('Crawler', select(opts, D(kind).playerId || (allowNone ? '' : ps[0]?.id || ''), { onChange: (v) => { D(kind).playerId = v || null; saveDraft(); changed(); } }));
  }

  function bossPicker() {
    const list = view().library?.boss || [];
    const mode = D('boss').mode || (list.length ? 'library' : 'adhoc');
    const seg = h('div.seg.seg-sm.span-all', { role: 'radiogroup' },
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(mode === 'library'), onclick: () => { D('boss').mode = 'library'; saveDraft(); sig = ''; drawAll(); } }, `From the library (${list.length})`),
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(mode === 'adhoc'), onclick: () => { D('boss').mode = 'adhoc'; saveDraft(); sig = ''; drawAll(); } }, 'Ad hoc'));
    if (mode === 'adhoc') {
      return [seg,
        txt('boss', 'name', 'Name', { placeholder: 'Gary, Devourer of Snacks', max: 80 }),
        txt('boss', 'title', 'Title / epithet', { placeholder: 'He was told no.', max: 120 }),
        labeled('HP slots', field(D('boss').hpSlots ?? 10, { type: 'number', attrs: { min: 1, max: 100 }, onCommit: (v) => { D('boss').hpSlots = Math.max(1, Math.min(100, Math.round(v) || 10)); saveDraft(); changed(); } })),
        labeled('Threat colour', h('input.swatch', { type: 'color', value: D('boss').color || '#ff2448', onchange: (e) => { D('boss').color = e.target.value; saveDraft(); changed(); } })),
        txt('boss', 'image', 'Image URL (optional)', { placeholder: '/pack/images/gary.webp or https://…', max: 2000, cls: 'span-2' }),
        txt('boss', 'phases', 'Phases, one per line: Name | text | at HP', { rows: 3, max: 3000, cls: 'span-all', placeholder: 'Snack time | He eats the furniture. | 10\nHangry | Everything is on fire. | 4' }),
        txt('boss', 'intro', 'Intro announcement (TV + System voice)', { rows: 2, max: 600, cls: 'span-all' }),
        h('p.hint.span-all', 'An ad-hoc boss has no attacks: run his hits with the HP buttons once he is on air.')];
    }
    if (!bossPick || !list.some((b) => b.id === bossPick)) bossPick = list[0]?.id ?? null;
    const picked = bossLib(bossPick);
    return [seg, h('div.sc-bosses.span-all', list.length ? list.map((b) => h('button.sc-bosscard', {
      type: 'button', 'aria-pressed': String(b.id === bossPick),
      style: { '--th': b.color || 'var(--c-bad)' },
      onclick: () => { bossPick = b.id; D('boss').bossId = b.id; saveDraft(); sig = ''; drawAll(); },
    },
    h('b', b.name),
    h('span.dim', b.title || ''),
    h('span.sc-bc-meta', `${b.hpSlots} HP`, b.phases?.length ? `, ${b.phases.length} phases` : '', b.floor ? `, floor ${b.floor}` : '', b.source === 'homebrew' ? ', homebrew' : ''),
    )) : h('p.dim', 'No bosses in the pack yet. Add bosses.json, create one in the Library, or switch to Ad hoc.')),
    picked?.attacks?.length ? h('div.span-all', attackSection(picked.name, picked.attacks, null, picked.id, { boss: true, prep: !isLive('boss') })) : null,
    picked?.tactics ? h('div.sc-gm-only.span-all', h('p.sc-gm-k', icon('lock', { size: 12 }), 'GM only'), h('p', h('b', 'Tactics. '), picked.tactics)) : null];
  }

  function locationPicker() {
    const list = view().library?.location || [];
    if (!list.length) return null;
    const cur = D('explore').locationId || '';
    const loc = list.find((l) => l.id === cur);
    return [
      labeled('Location from the pack', select([{ value: '', label: 'Type it in below' }, ...list.map((l) => ({ value: l.id, label: `${l.floor !== '' && l.floor != null ? `F${l.floor} ` : ''}${l.name}` }))], cur, {
        onChange: (v) => {
          const l = list.find((x) => x.id === v);
          Object.assign(D('explore'), l
            ? { locationId: l.id, location: l.name, floor: l.floor !== '' && l.floor != null ? `Floor ${l.floor}` : '', image: l.image || '', text: l.readAloud || '', locationTouched: false, floorTouched: false, textTouched: false }
            : { locationId: null });
          saveDraft();
          sig = '';
          drawAll();
        },
      }), { cls: 'span-all' }),
      loc?.features?.length ? h('div.sc-gm-only.span-all', h('p.sc-gm-k', icon('lock', { size: 12 }), 'GM only: features'), h('ul', loc.features.map((f) => h('li', f)))) : null,
      loc && (loc.monsters?.length || loc.npcs?.length || loc.bosses?.length) ? h('div.sc-gm-only.span-all', h('p.sc-gm-k', icon('lock', { size: 12 }), 'GM only: who is here'),
        h('ul',
          loc.npcs?.length ? h('li', h('b', 'NPCs: '), loc.npcs.map((id) => view().library?.npc?.find((n) => n.id === id)?.name || id).join(', ')) : null,
          loc.monsters?.length ? h('li', h('b', 'Monsters: '), loc.monsters.map((id) => view().library?.monster?.find((n) => n.id === id)?.name || id).join(', ')) : null,
          loc.bosses?.length ? h('li', h('b', 'Bosses: '), loc.bosses.map((id) => view().library?.boss?.find((n) => n.id === id)?.name || id).join(', ')) : null)) : null,
    ];
  }

  function formBody(kind) {
    const v = view();
    if (kind === 'lobby') return [txt('lobby', 'title', 'Title', { placeholder: v.pack?.systemName || 'The System', max: 80 }), txt('lobby', 'subtitle', 'Subtitle', { placeholder: 'Grab your phone. The show starts soon.', max: 160, cls: 'span-2' }), chk('lobby', 'showQr', 'Show the join QR')];
    if (kind === 'explore') return [locationPicker(), txt('explore', 'location', 'Location', { placeholder: 'The Food Court', max: 80, touch: true }), txt('explore', 'floor', 'Floor', { placeholder: 'Floor 2', max: 40, touch: true }), txt('explore', 'image', 'Background image URL', { placeholder: '/pack/images/…', max: 2000 }), txt('explore', 'text', 'Text on screen (read-aloud)', { rows: 3, max: 1200, cls: 'span-all', touch: true }), chk('explore', 'showFeed', 'Show the event feed')];
    if (kind === 'boss') return bossPicker();
    if (kind === 'loot') return [crawlerSelect('loot'), labeled('Box', select((v.pack?.lootTiers || []).map((t) => ({ value: t.id, label: t.name })), D('loot').tier || v.pack?.lootTiers?.[0]?.id || '', { onChange: (x) => { D('loot').tier = x; saveDraft(); changed(); } }))];
    if (kind === 'countdown') {
      return [txt('countdown', 'label', 'Label', { placeholder: 'Floor collapse in', max: 80, cls: 'span-2' }),
        labeled('Minutes', field(D('countdown').minutes ?? 5, { type: 'number', attrs: { min: 0, max: 1440 }, onCommit: (x) => { D('countdown').minutes = x; saveDraft(); changed(); } })),
        labeled('Seconds', field(D('countdown').seconds ?? 0, { type: 'number', attrs: { min: 0, max: 59 }, onCommit: (x) => { D('countdown').seconds = x; saveDraft(); changed(); } })),
        chk('countdown', 'autostart', 'Start right away', false)];
    }
    if (kind === 'roll') return [crawlerSelect('roll', { allowNone: true }), txt('roll', 'formula', 'Dice', { placeholder: 'd20', max: 60 }), txt('roll', 'label', 'What for', { placeholder: 'Save vs. the jukebox', max: 80 })];
    if (kind === 'recap') return [txt('recap', 'text', 'Recap text', { rows: 6, max: 4000, cls: 'span-all', dflt: v.recap || '', placeholder: 'Last time, our crawlers…' }), txt('recap', 'title', 'Show title', { placeholder: v.pack?.systemName || 'The System', max: 80 })];
    if (kind === 'blank') return [txt('blank', 'text', 'Line under the logo', { placeholder: 'Stand by', max: 160, cls: 'span-2' })];
    if (kind === 'npc') {
      const list = v.library?.npc || [];
      return list.length
        ? [labeled('NPC', select(list.map((n) => ({ value: n.id, label: `${n.name}${n.role ? `, ${n.role}` : ''}` })), D('npc').npcId || list[0].id, { onChange: (x) => { D('npc').npcId = x; saveDraft(); changed(); } }), { cls: 'span-2' })]
        : [h('p.dim.span-all', 'No NPCs yet. Add npcs.json or create one in the Library.')];
    }
    return [];
  }

  /* ---------- panel ---------- */
  const isTool = (id) => TOOLS.some((t) => t.id === id);

  function goLiveLabel(chipId) {
    if (chipId === 'boss') {
      const d = D('boss');
      const name = d.mode === 'adhoc' ? (d.name || 'the boss') : bossLib(bossPick)?.name;
      return `Go live: ${name || 'boss'} + intro`;
    }
    if (chipId === 'fight') { const b = fightBoss(); return b ? `Go live: boss screen (${b.name})` : 'Go live: arena (VS)'; }
    if (chipId === 'roll') return 'Roll on TV';
    return `Go live: ${sceneOf(chipId)?.label.toLowerCase()}`;
  }
  function drawGoLive() {
    const id = tab;
    if (isTool(id)) { golive.replaceChildren(); golive.hidden = true; return; }
    const live = id === 'fight' ? fightOnAir() : isLive(id);
    golive.hidden = false;
    const meta = sceneOf(id);
    if (live) {
      const canUpdate = ['lobby', 'explore', 'recap', 'blank'].includes(id);
      golive.replaceChildren(...[
        canUpdate ? h('button.btn', { type: 'button', onclick: () => act({ t: 'scene.update', data: (() => { const x = dataFor(id); delete x.locationId; return x; })() }, 'TV updated.') }, 'Update the TV') : null,
        h('span.grow'),
        id === 'fight' || id === 'boss' ? null : h('button.btn.btn-quiet', { type: 'button', onclick: () => goLive(id) }, 'Restart')].filter(Boolean));
      golive.classList.add('is-live');
      return;
    }
    golive.classList.remove('is-live');
    golive.replaceChildren(
      h('span.sh-golive-h.dim', id === 'fight' ? 'The fight runs here whether or not it is on the TV.' : 'Get it ready. The TV changes only when you press the button.'),
      h('span.grow'),
      h('button.btn.btn-primary.sh-golive-btn', { type: 'button', onclick: () => (id === 'roll' ? rollOnTv() : goLive(id)) },
        icon(id === 'roll' ? 'dice' : 'tv', { size: 16 }), goLiveLabel(id), meta?.key ? h('kbd', meta.key) : null));
  }

  function drawHead() {
    const id = tab;
    const tool = TOOLS.find((t) => t.id === id);
    if (tool) { head.replaceChildren(...[h('h2', tool.label), tool.hint ? h('span.dim', tool.hint) : null].filter(Boolean)); return; }
    const meta = sceneOf(id);
    const live = id === 'fight' ? fightOnAir() : isLive(id);
    head.replaceChildren(
      live ? h('span.sh-state.live', 'On air') : h('span.sh-state', 'Preview'),
      h('h2', meta.label), h('span.dim', meta.hint));
    panel.classList.toggle('is-live', live);
  }

  // Fixed slots: the desk, sound, fight and NPC panels stay in the page (gm.js renders into them by id).
  const slots = { scene: h('div.sh-slot'), fight: h('div.sh-slot'), npc: h('div.sh-slot'), sound: h('div.sh-slot'), desk: h('div.sh-slot'), crawlers: h('div.sh-slot') };
  body.append(slots.scene, slots.fight, slots.npc, slots.sound, slots.desk, slots.crawlers);
  function drawBody() {
    const id = tab;
    const live = isLive(id);
    pvCol.hidden = isTool(id) || live || id === 'fight';
    panel.classList.toggle('no-pv', pvCol.hidden || !pref.pv);
    slots.fight.hidden = id !== 'fight';
    slots.npc.hidden = id !== 'npc';
    slots.sound.hidden = id !== 'sound';
    slots.desk.hidden = id !== 'desk';
    slots.crawlers.hidden = id !== 'crawlers';
    slots.scene.hidden = isTool(id);
    if (id === 'sound') { drawAudioPanel(); return; }
    if (id === 'desk' || id === 'crawlers') return;
    if (id === 'fight') {
      const sc = view().scene;
      slots.scene.replaceChildren(sc?.kind === 'boss' ? h('p.sh-note', icon('tv', { size: 14 }), 'The TV shows the boss screen. Boss HP, phases and his attacks are on the Boss chip.', h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => pick('boss') }, 'Boss controls')) : '');
      return;
    }
    const out = [];
    if (live) out.push(h('div.sc-live', liveControls(id)));
    const form = h('div.form-grid', formBody(id).flat().filter(Boolean));
    if (live && id !== 'npc') {
      out.push(h('details.sh-edit', { open: ui.editOpen || null, ontoggle: (e) => { ui.editOpen = e.target.open; } }, h('summary', id === 'boss' ? 'Another boss (restarts the boss screen)' : 'Change it'), h('div.sc-form', form,
        id === 'boss' ? h('div.row-end', h('button.btn', { type: 'button', onclick: () => goLiveBoss(bossDraftData()) }, 'Restart with this boss + intro')) : null)));
    } else out.push(h('div.sc-form', form));
    if (id === 'boss' && !live) out.push(h('div.sc-form', minionSection(false)));
    slots.scene.replaceChildren(...out);
  }

  function drawAll() {
    drawOnair();
    drawChips();
    drawHead();
    const focusIn = slots.scene.contains(document.activeElement) && document.activeElement.matches('input:not([type=checkbox]), textarea, select');
    if (!focusIn) drawBody();
    drawGoLive();
    pvRefresh();
  }

  async function rollOnTv() {
    const d = D('roll');
    const a = { t: 'scene.roll', formula: (d.formula || 'd20').trim() || 'd20' };
    if (d.playerId) a.playerId = d.playerId;
    if (d.label) a.label = d.label;
    await act(a, null);
  }

  /* ---------- keyboard: F1–F8 = go live with that scene's draft ---------- */
  document.addEventListener('keydown', (e) => {
    const m = /^F([1-8])$/.exec(e.key);
    if (!m || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const s = SCENES.find((x) => x.key === e.key);
    if (!s) return;
    e.preventDefault();
    if (s.kind === 'roll') rollOnTv(); else goLive(s.kind);
  });

  /* ---------- render ---------- */
  let sig = '';
  function update(v) {
    audio.update(v);
    drawAudio();
    const c = v.combat || {};
    const s = JSON.stringify([v.scene && { ...v.scene, now: 0, party: null }, tab, v.players, v.library?.boss?.length, v.library?.monster?.length, v.library?.location?.length, v.library?.npc?.length, v.pack?.lootTiers, v.show,
      [c.active, c.round, c.phase, (c.combatants || []).map((x) => [x.uid, x.hp, x.hidden, x.down, x.name, x.type === 'crawler' ? x.hpMax : x.attacks?.length])]]);
    if (s !== sig) { sig = s; drawAll(); } else pvPost();
  }

  /**
   * Builds the Show view: `parts` = { fight: el (combat tracker), npcs: el, sound: el, desk: el }.
   * The old show desk (quips, comms, audience) is whatever is in `section` now: it becomes Desk.
   */
  function mountInto(section, p = {}) {
    const desk = h('div.show-desk');
    desk.append(...section.childNodes);
    if (p.deskExtra) desk.append(p.deskExtra);
    Object.assign(parts, { fight: p.fight || h('div'), npcs: p.npcs || null, sound: p.sound || h('div'), desk });
    slots.fight.append(parts.fight);
    if (parts.npcs) slots.npc.append(parts.npcs);
    if (p.crawlers) { parts.crawlers = p.crawlers; slots.crawlers.append(p.crawlers); }
    if (p.crawlersBadge) barExtra.append(p.crawlersBadge);
    slots.sound.append(audioPanel, parts.sound);
    slots.desk.append(desk);
    section.replaceChildren(el);
    sig = '';
    drawBody();
    // Preview on / off with the Show view.
    new MutationObserver(() => { sig = ''; if (!section.hidden) update(view()); else pvDrop(); }).observe(section, { attributes: true, attributeFilter: ['hidden'] });
  }

  const api = { el, update, audio, mountInto, openSub: (id) => pick(id === 'scenes' ? 'lobby' : id), pick, refresh: () => { sig = ''; update(view()); }, goLive };
  return api;
}
