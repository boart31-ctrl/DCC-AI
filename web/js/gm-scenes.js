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
import { h, toast, itemArt, onPortraits, portraitSrc } from './client.js';
import { icon, field, select, labeled } from './ui.js';
import { checkDC } from './check-dc.js';
import { createGmAudio } from './gm-audio.js';
import { uiOf, uiAsset } from './ui-art.js';

const SCENES = [
  { kind: 'lobby', label: 'Lobby', key: 'F1', hint: 'Title card + join QR' },
  { kind: 'explore', label: 'Explore', key: 'F2', hint: 'Where the party is' },
  { kind: 'fight', label: 'Fight', key: '', hint: 'Tracker. TV: arena, or the boss screen' },
  { kind: 'boss', label: 'Boss', key: 'F3', hint: 'Boss, minions, attacks' },
  { kind: 'npc', label: 'NPC', key: '', hint: 'Portrait + speak as the NPC' },
  { kind: 'map', label: 'Map', key: '', hint: 'Fog of war: reveal zones with one tap' },
  { kind: 'loot', label: 'Loot', key: 'F4', hint: 'A box for one crawler' },
  { kind: 'countdown', label: 'Countdown', key: 'F5', hint: 'Floor collapse timer' },
  { kind: 'roll', label: 'Big roll', key: 'F6', hint: 'Dice on the TV' },
  { kind: 'chase', label: 'Chase / race', key: '', hint: 'Legs, Ground, the quarry runs' },
  { kind: 'recap', label: 'Recap', key: 'F7', hint: 'Previously on…' },
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

export function createScenes({ client, act, getView, getCues = () => null, onPick = () => {}, chooseAttack = () => {} }) {
  const audio = createGmAudio({ client, getView });
  const view = () => getView() || {};
  // Drafts per scene kind (what F-keys / GO LIVE send). Persisted per device.
  const draft = store.get('draft', {});
  const D = (k) => (draft[k] ||= {});
  const saveDraft = () => store.set('draft', draft);
  let tab = store.get('tab2', 'lobby');
  if (![...SCENES.map((s) => s.kind), ...TOOLS.map((t) => t.id)].includes(tab)) tab = 'lobby';
  let bossPick = D('boss').bossId ?? null;
  const pref = { pv: store.get('pv2', true), focusFight: store.get('focusFight', false) };
  // One switch for every mob roll (Boss screen, Fight attack buttons, Mobs act): the fight's `public` setting.
  const atkTv = () => view().combat?.settings?.public !== false;
  const reaction = () => view().pack?.ruleset?.combat?.flow === 'reaction';
  const ui = { openAtk: new Set(), bossTarget: null, editOpen: false };
  const parts = { fight: null, npcs: null, sound: null, desk: null, crawlers: null, goLiveFight: null };

  /* ---------- shell ---------- */
  const onair = h('button.sh-onair', { type: 'button', onclick: () => { const k = liveChip(); if (k) pick(k); } });
  const soundState = h('span.sc-sound');
  const barExtra = h('span.sh-bar-extra'); // gm-crawlers.js badge
  const reachSlot = h('div.sh-reach-slot'); // gm-prep.js: "Within reach" strip (tonight's pinned prep)
  const sceneTabs = h('div.sh-chips', { role: 'tablist', 'aria-label': 'Show scenes' });
  const showShortcuts = h('div.sh-shortcuts');
  const chips = h('div.sh-controls', sceneTabs, showShortcuts);
  let fightBossOnMap = null;
  const currentMap = () => {
    const maps = view().maps ?? [];
    return [view().combat?.mapId, D('map').mapId, view().scene?.data?.mapId, maps[0]?.id]
      .find((id) => maps.some((m) => m.id === id)) ?? null;
  };
  async function switchMapFight() {
    if (tab === 'map') {
      const boss = fightBossOnMap && view().combat?.combatants?.some((m) => m.sourceKind === 'boss' && m.sourceId === fightBossOnMap && !m.down && !m.hidden);
      const kind = boss ? 'boss' : 'combat';
      if (await act({ t: 'scene.set', kind, data: boss ? { bossId: fightBossOnMap } : {} }, null)) pick('fight');
      return;
    }
    const mapId = currentMap();
    if (!mapId) { pick('map'); return; }
    fightBossOnMap = view().scene?.kind === 'boss' ? view().scene.data?.bossId : null;
    if (view().combat?.mapId !== mapId && !(await act({ t: 'map.bindCombat', id: mapId }, null))) return;
    parts.mapEditor?.select(mapId);
    await act({ t: 'scene.set', kind: 'map', data: { mapId } }, null);
  }
  const head = h('div.sh-head');
  const body = h('div.sh-body');
  const pvBox = h('div.sc-preview');
  const pvToggle = h('button.btn.btn-sm.btn-quiet.sh-pv-toggle', { type: 'button', onclick: () => { pref.pv = !pref.pv; store.set('pv2', pref.pv); drawAll(); } });
  const pvK = h('span.sh-pv-k', 'Preview');
  const pvSub = h('span.dim', 'Not on the TV yet');
  const pvCol = h('div.sh-pv', h('div.sh-pv-head', pvK, pvSub, h('span.grow'), pvToggle), pvBox);
  const golive = h('div.sh-golive');
  const panel = h('div.sh-panel', head, h('div.sh-grid', body, pvCol), golive);
  const el = h('section.show2', { 'aria-label': 'Show' },
    h('div.sh-bar', h('div.sh-bar-top', onair, barExtra, soundState), chips, reachSlot),
    panel);

  let defeatArmed = null;
  let armTimer = 0;
  /** Typed damage is rolled HP. Healing uses the health track's units. */
  function bossAmount(d, max, fighter) {
    const limit = fighter ? 999 : 9999;
    const inp = h('input.inp.inp-sm.sc-amt', { type: 'number', min: 1, max: limit, placeholder: 'HP', 'aria-label': 'Amount', inputmode: 'numeric' });
    const go = async (kind) => {
      const v = Math.round(Number(inp.value));
      if (!(v >= 1)) { inp.focus(); return; }
      const damage = kind === 'damage';
      const ack = await act({ t: `${fighter ? 'combat' : 'boss'}.${kind}`, amount: Math.min(limit, v), ...(fighter ? { uid: fighter.uid } : {}), ...(damage ? { dr: true } : {}) });
      if (ack?.result?.belowSlot) toast(`${ack.result.rolled} HP after defenses. One slot needs ${ack.result.slotValue} HP.`);
      inp.value = '';
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? 'heal' : 'damage'); } });
    return h('span.sc-amt-wrap', inp,
      h('button.btn.btn-sm.sc-dmg', { type: 'button', disabled: d.hp <= 0, onclick: () => go('damage'), title: 'Apply rolled HP before DR (Enter)' }, 'Hit'),
      h('button.btn.btn-sm.sc-heal', { type: 'button', disabled: d.hp >= max, onclick: () => go('heal'), title: d.boss.slotValue ? 'Restore whole slots (Shift+Enter)' : 'Heal this much (Shift+Enter)' }, d.boss.slotValue ? 'Heal slots' : 'Heal'));
  }

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
    onair.hidden = ['fight', 'map'].includes(tab) || ['combat', 'finale'].includes(sc?.kind);
    el.classList.toggle('sh-compact', ['fight', 'map'].includes(tab));
    const k = liveChip();
    let what = sc ? (sceneOf(k)?.label || sc.kind) : 'Nothing';
    if (sc?.kind === 'combat') what = 'Fight: arena';
    else if (sc?.kind === 'finale') what = 'Fight: finale';
    let detail = '';
    if (sc?.kind === 'boss') detail = `${sc.data.boss?.name || ''}, ${sc.data.hp}/${sc.data.boss?.hpSlots} ${sc.data.boss?.slotValue ? 'slots' : 'HP'}`;
    else if (sc?.kind === 'npc') detail = sc.data.npc?.name || '';
    else if (sc?.kind === 'explore') detail = [sc.data.floor, sc.data.location].filter(Boolean).join(', ');
    else if (sc?.kind === 'combat') { const c = view().combat || {}; detail = c.active ? `round ${c.round}` : 'not started'; }
    onair.replaceChildren(...[h('span.sh-onair-k', 'On air'), h('b', what), detail ? h('span.sh-onair-d', detail) : null, k && k !== tab ? h('span.sh-onair-go', 'Controls', icon('chevron', { size: 13 })) : null].filter(Boolean));
    onair.disabled = !k || k === tab;
  }

  /* ---------- chips ---------- */
  function drawChips() {
    const live = liveChip();
    const chip = (id, label, opts) => h('button.sh-chip', {
      type: 'button', role: 'tab', 'aria-selected': String(tab === id),
      class: `sh-chip${live === id ? ' is-live' : ''}${opts.icon ? ' tool-chip' : ''}`,
      title: opts.key ? `${opts.hint} (${opts.key})` : opts.hint,
      onclick: () => pick(id),
    }, live === id ? h('i.sh-live-dot', { 'aria-label': 'On air' }) : null, opts.icon ? icon(opts.icon, { size: 13 }) : null, label);
    sceneTabs.replaceChildren(
      ...SCENES.map((s) => chip(s.kind, s.label, s)),
      h('span.sh-sep', { 'aria-hidden': 'true' }),
      ...TOOLS.map((t) => chip(t.id, t.label, t)));
    const selected = sceneTabs.querySelector('[aria-selected="true"]');
    if (selected) {
      const { left, right } = selected.getBoundingClientRect();
      const bounds = sceneTabs.getBoundingClientRect();
      if (left < bounds.left) sceneTabs.scrollLeft += left - bounds.left;
      if (right > bounds.right) sceneTabs.scrollLeft += right - bounds.right;
    }
    document.body.classList.toggle('fight-focus', tab === 'fight' && pref.focusFight);
    showShortcuts.replaceChildren(...[
      tab === 'fight' ? h('button.btn.btn-sm', { type: 'button', 'aria-pressed': String(pref.focusFight),
        title: 'Collapse desk navigation and the dice log for more room',
        onclick: () => { pref.focusFight = !pref.focusFight; store.set('focusFight', pref.focusFight); drawAll(); },
      }, pref.focusFight ? 'Exit focus' : 'Focus fight') : null,
      tab === 'map' && D('map').mapId && !isLive('map') ? h('button.btn.btn-sm', { type: 'button', onclick: () => goLive('map') }, icon('tv', { size: 14 }), 'Map on TV') : null,
      ['fight', 'map'].includes(tab) && !(tab === 'fight' && pref.focusFight) ? h('button.btn.btn-sm.btn-quiet', { type: 'button', 'aria-pressed': String(pref.pv), onclick: () => { pref.pv = !pref.pv; store.set('pv2', pref.pv); drawAll(); } }, pref.pv ? 'Hide preview' : 'Show preview') : null,
      ['fight', 'map'].includes(tab) ? h('button.btn.btn-sm.sh-map-switch', { type: 'button', onclick: switchMapFight },
        icon(tab === 'map' ? 'swords' : 'map', { size: 14 }), tab === 'map' ? 'Switch to fight' : 'Switch to map') : null,
    ].filter(Boolean));
  }

  function pick(id) {
    if (tab !== id) ui.editOpen = false;
    tab = id;
    store.set('tab2', tab);
    onPick();
    sig = '';
    drawAll();
  }

  /* ---------- scene data from the drafts ---------- */
  function bossDraftData() {
    const d = D('boss');
    if (d.mode === 'adhoc') {
      return { boss: { name: d.name || 'Unnamed horror', title: d.title || '', hpSlots: Number(d.hpSlots) || 10, image: d.image || null, color: d.color || null, phases: parsePhases(d.phases), intro: d.intro || '' }, ...(d.lootHint ? { lootHint: d.lootHint } : {}) };
    }
    const id = bossPick || view().library?.boss?.[0]?.id;
    return id ? { bossId: id, ...(d.lootHint ? { lootHint: d.lootHint } : {}) } : null;
  }
  function dataFor(kind) {
    const d = { ...D(kind) };
    const v = view();
    if (kind === 'boss') return bossDraftData();
    if (kind === 'countdown') return { label: d.label || 'Floor collapse in', seconds: Math.max(1, Math.round((Number(d.minutes) || 0) * 60 + (Number(d.seconds) || 0))) || 300, autostart: !!d.autostart };
    if (kind === 'loot') {
      const pid = (d.playerId && d.playerId !== '*' ? d.playerId : null) || v.players?.[0]?.id || null;
      const tier = d.tier || v.pack?.lootTiers?.[0]?.id || null;
      return { ...(pid ? { playerId: pid } : {}), ...(tier ? { tier } : {}) };
    }
    if (kind === 'roll') {
      const check = rollCheck();
      if (check) return { scored: true, label: check.label, ...(check.showDc && check.dc != null ? { dc: check.dc } : {}) };
      return d.playerId ? { playerId: d.playerId, label: d.label || '' } : { label: d.label || '' };
    }
    if (kind === 'explore') {
      const out = { location: d.location || '', floor: d.floor || '', image: d.image || null, text: d.text || '', showFeed: d.showFeed !== false };
      if (d.locationId) out.locationId = d.locationId;
      return out;
    }
    if (kind === 'lobby') return { title: d.title || '', subtitle: d.subtitle || '', showQr: d.showQr !== false };
    if (kind === 'chase') return chaseData(d);
    if (kind === 'recap') return { title: d.title || '', text: d.text ?? (v.recap || '') };
    if (kind === 'combat') return { title: D('fight').title || '' };
    if (kind === 'npc') {
      const id = d.npcId || v.library?.npc?.[0]?.id;
      return id ? { npcId: id } : null;
    }
    if (kind === 'map') {
      const maps = v.maps || [];
      const id = maps.some((m) => m.id === d.mapId) ? d.mapId : maps[0]?.id;
      return id ? { mapId: id } : null;
    }
    return {};
  }
  /** The scene kind GO LIVE sends for a chip (Fight → boss screen when a boss is in the fight). */
  function fightBoss() {
    return (view().combat?.combatants || []).find((x) => x.type === 'mob' && x.sourceKind === 'boss' && !x.down && !x.hidden) || null;
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
    if (data === null) { toast(chipId === 'npc' ? 'No NPCs in the library yet.' : chipId === 'map' ? 'Create a map first.' : 'Nothing to show yet.', { error: true }); return false; }
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
    const ok = await act({ t: 'scene.set', kind: chipId, data }, `On air: ${label}.`);
    if (ok && chipId === 'loot' && tab !== 'loot') pick('loot');
    return ok;
  }

  /**
   * Showing a boss introduces that boss. Other prepared opponents retain their visibility.
   */
  async function goLiveBoss(data) {
    if (!data) { toast('Pick a boss first (or build one ad hoc).', { error: true }); return false; }
    if (!(await act({ t: 'scene.set', kind: 'boss', data }, null))) return false;
    const c = view().combat || {};
    if (data.bossId) {
      const boss = (c.combatants || []).find((x) => x.type === 'mob' && x.sourceKind === 'boss' && x.sourceId === data.bossId);
      if (!boss) await act({ t: 'combat.addMob', kind: 'boss', sourceId: data.bossId, hidden: false }, null);
      else if (boss.hidden) await act({ t: 'combat.reveal', uid: boss.uid }, null);
    }
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
  client.on('event', (e) => {
    if (!pvLive || !pvReady || !pvFrame?.contentWindow) return;
    try { pvFrame.contentWindow.postMessage({ t: 'draft.event', event: JSON.parse(JSON.stringify(e)) }, location.origin); } catch {}
  });
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !pvFrame || e.source !== pvFrame.contentWindow) return;
    if (e.data?.t === 'draft.ready') { pvReady = true; pvPost(); }
  });
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
    const box = pvBox.querySelector('.sc-pv-box');
    if (box && pvFrame) pvFrame.style.transform = `scale(${box.clientWidth / 1920})`;
  }) : null;
  ro?.observe(pvBox);

  /**
   * View for the preview. Draft: the GM view with the dry-run scene; hidden (prepared) minions shown as they
   * will be. Live (the picked chip is on the TV, or a tool tab): a mirror of the TV, hidden mobs left out.
   */
  let pvLive = false;
  function draftView() {
    const v = view();
    const c = v.combat || {};
    const mob = (x) => ({ ...x, hidden: false, boss: x.sourceKind === 'boss', group: x.sourceId ? `${x.sourceKind}:${x.sourceId}` : null, hpPct: x.hpMax ? x.hp / x.hpMax : 1 });
    const shown = (c.combatants || []).filter((x) => !(pvLive && x.type === 'mob' && x.hidden)).map((x) => (x.type === 'mob' ? mob(x) : x));
    const scene = pvLive ? v.scene : pvScene;
    const players = (v.players || []).map((p) => ({ ...p, portrait: portraitSrc(p.portrait) }));
    const lineup = !pvLive && !c.active && ['combat', 'boss'].includes(scene?.kind)
      ? [...(c.previewCrawlers || []), ...shown.filter((x) => x.type === 'mob')]
      : shown;
    const maps = (v.maps || []).map((m) => ({ ...m,
      tokens: m.tokens.filter((t) => !pvLive || !t.hidden).map((t) => ({ ...t, image: portraitSrc(t.image) })) }));
    return { ...v, players, maps, scene, combat: { ...c, active: c.active || scene?.kind === 'boss', combatants: lineup } };
  }
  function pvPost() {
    if (!pvReady || !(pvLive ? view().scene : pvScene) || !pvFrame?.contentWindow) return;
    try { pvFrame.contentWindow.postMessage({ t: 'draft.view', view: JSON.parse(JSON.stringify(draftView())) }, location.origin); } catch (err) { console.error(err); }
  }
  onPortraits(pvPost);
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
    const wantPv = pref.pv && !(tab === 'fight' && pref.focusFight) && el.isConnected && !el.closest('[hidden]');
    const live = isTool(tab) || (tab === 'fight' ? !!view().combat?.active && fightOnAir() : isLive(tab));
    if (live !== pvLive) { pvLive = live; pvKey = ''; }
    pvK.textContent = live ? 'On the TV' : 'Preview';
    pvSub.textContent = live ? 'Live mirror' : 'Not on the TV yet';
    pvCol.classList.toggle('is-live', live);
    pvToggle.replaceChildren(icon('tv', { size: 14 }), pref.pv ? 'Hide' : 'Show preview');
    pvCol.classList.toggle('off', !pref.pv);
    panel.classList.toggle('no-pv', !pref.pv && ['fight', 'map'].includes(tab));
    if (!wantPv) { pvDrop(); return; }
    if (live) {
      pvEnsureFrame();
      pvMsg.textContent = view().scene ? '' : 'Nothing on the TV right now.';
      pvPost();
      return;
    }
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
  /** Explore on air: ambience Play / Stop (Stop at the top keeps it off), and the read-aloud text by voice. */
  let readSig = '';
  function exploreLive(sc) {
    const cues = getCues();
    const st = cues?.ambienceState?.() || {};
    const text = String(sc.data.text || '').trim();
    const unread = text && readSig !== text;
    return h('div.sc-ex-live',
      h('p.sc-line', [sc.data.floor, sc.data.location].filter(Boolean).join(', ') || 'Exploring'),
      h('div.sc-boss-row',
        h('span.sc-ex-k', icon('bolt', { size: 14 }), st.has ? (st.playing ? `Ambience playing: ${st.name}` : st.stopped ? 'Ambience stopped' : st.enabled === false ? 'Ambience off in Sound cues' : 'Ambience idle') : 'No ambience for this place'),
        st.has ? (st.playing
          ? h('button.btn.btn-sm', { type: 'button', onclick: () => cues.stopAmbience() }, icon('x', { size: 13 }), 'Stop')
          : h('button.btn.btn-sm.btn-primary', { type: 'button', disabled: st.enabled === false, onclick: () => cues.playAmbience() }, icon('play', { size: 13 }), 'Play')) : null),
      text ? h('div.sc-boss-row',
        h('span.sc-ex-k', icon('chat', { size: 14 }), unread ? h('b.sc-warn-t', 'Text on the TV not read aloud yet') : 'Read aloud'),
        h('button.btn.btn-sm', { class: unread ? 'btn btn-sm btn-primary' : 'btn btn-sm', type: 'button', onclick: async () => { if (await act({ t: 'say', text: text.slice(0, 1000) }, 'The System reads it.')) { readSig = text; sig = ''; drawAll(); } } }, icon('speaker', { size: 13 }), unread ? 'Read it now' : 'Read again')) : null);
  }

  /** NPC on air: what the TV shows (intro + last line), how to play them (GM only) and notes on this device. */
  function npcLive(sc) {
    const n = sc.data.npc || {};
    const lib = (view().library?.npc || []).find((x) => x.id === sc.data.npcId) || {};
    const key = `npcNote.${sc.data.npcId || n.name}`;
    const note = h('textarea.inp', { rows: 3, placeholder: 'Your notes for this NPC (kept on this device)…', value: store.get(key, ''), oninput: (e) => store.set(key, e.target.value) });
    return h('div.sc-ex-live',
      h('p.sc-line', h('b', n.name || 'NPC'), n.role ? ` · ${n.role}` : ''),
      sc.data.line ? h('p.sc-npc-said', h('span.dim', 'Said on the TV: '), `“${sc.data.line}”`) : h('p.dim', 'No line yet. Speak as the NPC below.'),
      n.intro ? h('p.sc-npc-said', h('span.dim', 'Intro on the TV: '), n.intro) : null,
      (lib.personality || lib.voice) ? h('div.sc-gm-only', h('p.sc-gm-k', icon('lock', { size: 12 }), 'GM only: how to play them'),
        lib.personality ? h('p', lib.personality) : null, lib.voice ? h('p', h('b', 'Voice. '), typeof lib.voice === 'string' ? lib.voice : JSON.stringify(lib.voice)) : null) : null,
      labeled('Notes', note));
  }

  function liveControls(kind) {
    const sc = view().scene;
    clearInterval(cdTimer);
    if (kind === 'boss') return bossLive(sc);
    if (kind === 'countdown') return countdownControls(sc);
    if (kind === 'chase') return chaseControls(sc);
    if (kind === 'loot') return lootControls(sc);
    if (kind === 'roll' && scoredRolls()) {
      const { check, label, total, name } = sc.data;
      const q = view().gm?.showCheck;
      const dc = sc.data.dc ?? (q?.sceneId === sc.id ? q.dc : null);
      if (sc.data.pending) return h('p.sc-line', h('b', label), ' · waiting for dice. Reveal from the form below.');
      if (dc == null) return total != null ? h('p.sc-line', `${name} rolled ${total}.`) : null;
      const verdict = check?.verdict;
      return h('p.sc-line', h('b', `${label} · DC ${dc}`), verdict ? ` · Party ${verdict.success ? 'succeeds' : 'fails'} (${verdict.passed}/${check.results.length})`
        : check?.results?.[0] ? ` · ${check.results[0].name} rolled ${check.results[0].total}` : ' · Waiting for dice');
    }
    if (kind === 'roll') return h('div.sc-live-row', h('p.sc-line', sc.data.total == null ? `Waiting: ${sc.data.name || 'someone'} is up.` : `${sc.data.name} rolled ${sc.data.total}${sc.data.nat20 ? ' (natural 20)' : sc.data.nat1 ? ' (natural 1)' : ''}.`),
      h('button.btn.btn-primary', { type: 'button', onclick: rollOnTv }, icon('dice', { size: 15 }), 'Roll again'));
    if (kind === 'explore') return exploreLive(sc);
    if (kind === 'npc') return npcLive(sc);
    return h('p.sc-line.dim', 'On the TV now. Change it below and press Update.');
  }

  function bossLib(id) { return (view().library?.boss || []).find((b) => b.id === id) || null; }
  const bossFighterFor = (bossId) => (view().combat?.combatants || []).find((x) => x.type === 'mob' && x.sourceKind === 'boss' && (!bossId || x.sourceId === bossId)) || null;

  function bossLive(sc) {
    const d = sc.data;
    const b = d.boss;
    const lib = d.bossId ? bossLib(d.bossId) : null;
    const max = b.hpSlots;
    const unit = b.slotValue ? 'slots' : 'HP';
    const next = b.phases[d.phase + 1];
    const cur = b.phases[d.phase];
    const send = (a, msg) => act(a, msg);
    const big = (label, cls, onclick, opts = {}) => h(`button.btn.sc-big${cls}`, { type: 'button', onclick, disabled: !!opts.disabled, title: opts.title || null }, label);
    const hpBar = h('div.sc-hp', { style: { '--n': String(max) } }, Array.from({ length: max }, (_, i) => h('i', { class: i < d.hp ? 'on' : '' })));
    const sug = d.suggestPhase != null && b.phases[d.suggestPhase]
      ? h('div.sc-suggest', icon('warn', { size: 16 }),
        h('span', `${d.hp} ${unit} left: phase "${b.phases[d.suggestPhase].name}" is due.`),
        h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => send({ t: 'boss.phase', index: d.suggestPhase }, `Phase: ${b.phases[d.suggestPhase].name}.`) }, 'Advance'))
      : null;
    const tvLoot = field(d.lootHint, { placeholder: 'e.g. Silver crate incoming', onCommit: (v) => send({ t: 'scene.update', data: { lootHint: v } }, 'Loot line set.') });
    const fighter = d.bossId ? bossFighterFor(d.bossId) : null;
    const attacks = fighter?.attacks || lib?.attacks || [];
    const standing = minionRows(view().combat).flatMap((r) => r.members).filter((m) => !m.down);
    const zero = d.hp <= 0 && !d.defeated
      ? h('div.sc-suggest.sc-zero', icon('skull', { size: 18 }), h('span', h('b', `${b.name} is at 0 ${unit}.`), ' Finish him: the defeat cinematic and the loot line play on the TV.'),
        h('button.btn.btn-danger', { type: 'button', onclick: () => send({ t: 'boss.defeat' }, 'Boss defeated.') }, 'Defeat now'))
      : null;
    const after = d.defeated && standing.length
      ? h('div.sc-suggest', icon('warn', { size: 16 }), h('span', h('b', `${standing.length} minion${standing.length === 1 ? '' : 's'} still standing.`)),
        h('button.btn.btn-sm', { type: 'button', onclick: () => pick('fight') }, 'Fight on'),
        h('button.btn.btn-sm', { type: 'button', onclick: async () => { for (const m of standing) await act({ t: 'combat.remove', uid: m.uid }, null); toast('The minions ran for it.'); } }, 'They flee'),
        h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => act({ t: 'combat.end', outcome: 'victory' }, 'Victory.') }, 'End: victory'))
      : null;
    return h('div.sc-boss',
      h('div.sc-boss-top',
        h('div', h('div.sc-boss-name', b.name), b.title ? h('div.dim', b.title) : null),
        h('div.sc-boss-hp', h('b', String(d.hp)), h('span.dim', ` / ${max} ${unit}${b.slotValue ? ` · ${b.slotValue} HP/slot` : ''}`))),
      hpBar,
      zero || sug,
      after,
      h('div.sc-boss-row',
        big('−1', '.sc-dmg', () => send({ t: 'boss.damage', amount: 1 }), { disabled: d.hp <= 0 }),
        big('−2', '.sc-dmg', () => send({ t: 'boss.damage', amount: 2 }), { disabled: d.hp <= 0 }),
        big('−3', '.sc-dmg', () => send({ t: 'boss.damage', amount: 3 }), { disabled: d.hp <= 0 }),
        big('+1', '.sc-heal', () => send({ t: 'boss.heal', amount: 1 }), { disabled: d.hp >= max, title: 'Heal 1' }),
        bossAmount(d, max, fighter),
        d.phase > 0 ? big('◀', '.sc-phase', () => send({ t: 'boss.phase', back: true }, 'Back one phase.'), { title: 'Back one phase' }) : null,
        big(next ? `Phase: ${next.name}` : 'Last phase', '.sc-phase', () => send({ t: 'boss.phase' }, next ? `Phase: ${next.name}.` : null), { disabled: !next }),
        big(d.defeated ? 'Defeated' : defeatArmed === 'defeat' ? 'Sure? Tap again' : 'Defeat', '.btn-danger.sc-defeat', () => {
          if (d.defeated) return;
          // Two taps: the defeat cinematic can't be taken back.
          if (defeatArmed !== 'defeat') { defeatArmed = 'defeat'; clearTimeout(armTimer); armTimer = setTimeout(() => { defeatArmed = null; drawBody(); }, 3000); drawBody(); return; }
          defeatArmed = null;
          send({ t: 'boss.defeat' }, 'Boss defeated.');
        }),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => send({ t: 'boss.intro' }, 'Boss intro.'), title: 'Cinematic + intro line again' }, 'Replay intro')),
      attacks.length ? attackSection(b.name, attacks, fighter, d.bossId, { boss: true }) : null,
      minionSection(true),
      h('div.sc-boss-info',
        h('div.sc-gm-only',
          h('p.sc-gm-k', icon('lock', { size: 12 }), 'GM only'),
          cur ? h('p', h('b', `Phase ${ROMAN[d.phase] || d.phase + 1}: ${cur.name}. `), cur.text || '') : null,
          lib?.tactics ? h('p', h('b', 'Tactics. '), lib.tactics) : null,
          (b.intro || lib?.intro) ? h('p', h('b', 'Intro (the System reads it). '), b.intro || lib.intro) : null,
          lib?.lootHint ? h('p', h('b', 'Loot. '), lib.lootHint) : null),
        labeled('Loot line on TV after defeat', tvLoot)),
    );
  }

  /** Rolls go to the TV (cinematic + public dice) or stay with the GM: one switch for every attack button. */
  function tvSwitch() {
    return h('label.sh-tvsw', { title: 'On: the TV plays the attack and everyone sees the dice. Off: only you see the roll; the damage still lands on the sheet.' },
      h('input', { type: 'checkbox', checked: atkTv(), onchange: (e) => { act({ t: 'combat.set', settings: { public: e.target.checked } }, null).then(() => { sig = ''; drawAll(); }); } }),
      h('span', atkTv() ? 'Rolls on TV' : 'Rolls GM only'));
  }

  function targetSeg() {
    const crawlers = (view().combat?.combatants || []).filter((x) => x.type === 'crawler');
    if (!crawlers.length) return null;
    if (ui.bossTarget && !crawlers.some((x) => x.uid === ui.bossTarget)) ui.bossTarget = null;
    return h('div.seg.seg-sm.sc-batk-tgt', { role: 'radiogroup', 'aria-label': 'Target' },
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(!ui.bossTarget), onclick: () => { ui.bossTarget = null; sig = ''; drawAll(); } }, 'Auto'),
      ...crawlers.map((x) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(ui.bossTarget === x.uid), disabled: x.down, title: `${x.name}: ${x.slotValue ? `${Math.round(100 * x.hp / (x.hpMax || 1))}% · ${x.slotValue} HP/slot` : `${x.hp}/${x.hpMax} HP`}, Evade ${x.evade ?? '?'}`, onclick: () => { ui.bossTarget = x.uid; sig = ''; drawAll(); } }, x.name)));
  }

  /** Attack buttons (max 3 + "more"): tap rolls it for real, ⓘ opens the details. */
  function attackButtons(attacks, ownerKey, roll, { disabled = false } = {}) {
    // Everything at a glance (review 15 Nov): name, numbers and what it does; the whole card rolls it.
    const one = (a) => h('button.sh-atk.sh-atk-full', { type: 'button', disabled, onclick: () => roll(attacks.indexOf(a)), title: disabled ? a.effects || a.name : `${reaction() ? 'Choose' : 'Roll'} ${a.name}` },
      h('span.sh-atk-top', h('b', a.name), h('span.sh-atk-k', reaction() ? `${a.damage || '0'} dmg` : `${sign(a.toHit)} to hit${hasDmg(a) ? ` · ${a.damage}` : ''}`)),
      a.effects ? h('span.sh-atk-fx', a.effects) : null,
      a.buffs?.length ? h('span.sh-atk-k', a.buffs.join(', ')) : null);
    const shown = attacks.slice(0, MAX_ATTACKS).map(one);
    const rest = attacks.length > MAX_ATTACKS
      ? h('details.sh-atk-more', h('summary', `${attacks.length - MAX_ATTACKS} more`), h('div.sh-atks', attacks.slice(MAX_ATTACKS).map(one)))
      : null;
    return h('div.sh-atks', shown, rest);
  }

  function attackToast(name, r) {
    if (r?.result?.preview) {
      pick('fight');
      return;
    }
    const st = r?.result?.sequence?.[0] ?? r?.sequence?.[0];
    if (st) toast(`${name} → ${st.target}: ${st.total} vs ${st.evade} ${st.hit ? `HIT${st.damage ? `, −${st.damage} HP` : ''}${st.crit ? ' (crit)' : ''}${st.down ? `, ${st.target} is down` : ''}` : 'miss'}`, { ms: 5000 });
  }

  /** The boss's attacks: not in the fight yet → the first tap puts him in (and starts it), then rolls. */
  function attackSection(name, attacks, fighter, bossId, { boss = false, prep = false } = {}) {
    if (prep) {
      return h('div.sc-batk',
        h('div.sc-batk-head', h('b', 'Attacks'), h('span.dim', reaction() ? 'Choose attacks and targets in Fight' : 'You roll them here once he is on air')),
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
      if (reaction()) { pick('fight'); chooseAttack(uid, i); return; }
      const r = await act({ t: 'combat.mobAct', uid, attackIndex: i, tv: atkTv(), ...(ui.bossTarget ? { targetUid: ui.bossTarget } : {}) }, null);
      attackToast(attacks[i].name, r);
    };
    return h('div.sc-batk',
      h('div.sc-batk-head', h('b', boss ? 'Attacks' : `${name}: attacks`), h('span.grow'), reaction() ? h('span.dim', 'Choose the target in Fight') : tvSwitch()),
      reaction() ? null : h('div.sc-batk-head', h('span.dim', 'Target'), targetSeg() || h('span.dim', 'everyone (the fight starts on the first attack)')),
      attackButtons(attacks, fighter?.uid || bossId || name, roll, { disabled: !!(fighter && fighter.hp <= 0) || !!(reaction() && view().combat?.rx && view().combat.rx.step !== 'declare') }));
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
      if (reaction()) { pick('fight'); chooseAttack(m.uid, i); return; }
      if (m.hidden) await act({ t: 'combat.reveal', uid: m.uid }, null);
      const res = await act({ t: 'combat.mobAct', uid: m.uid, attackIndex: i, tv: atkTv(), ...(ui.bossTarget ? { targetUid: ui.bossTarget } : {}) }, null);
      attackToast(`${m.name}: ${m.attacks[i].name}`, res);
    };
    // A pack takes damage at the front: the first living member.
    const hit = (r, amount) => { const m = aliveOf(r)[0]; if (m) act({ t: 'combat.damage', uid: m.uid, amount }); };
    const heal = (r) => { const m = [...r.members].reverse().find((x) => x.hp < x.hpMax); if (m) act({ t: 'combat.heal', uid: m.uid, amount: 1 }); };
    const row = (r) => {
      const alive = aliveOf(r);
      const hidden = r.members.some((m) => m.hidden);
      const first = r.members[0];
      const hpTxt = r.pack ? `${alive.length}/${r.members.length} standing` : `${first.hp}/${first.hpMax} ${first.slotValue ? `slots · ${first.slotValue} HP/slot` : 'HP'}`;
      return h('li.sh-min', { class: `sh-min${alive.length ? '' : ' down'}${r.pack ? ' pack' : ''}` },
        h('div.sh-min-top',
          itemArt({ name: r.name, image: first.image || null, rarity: 'common' }, 'sh-min-art'),
          h('b', r.pack ? `${r.name} ×${r.members.length}` : r.name),
          r.pack ? h('span.pill', 'Pack') : null,
          hidden ? h('span.pill', { title: 'Shown on the TV when you go live or reveal it' }, icon('eyeOff', { size: 12 }), 'hidden') : null,
          h('span.grow'),
          h('span.sh-min-hp', hpTxt),
          h('button.icon-btn.xs', { type: 'button', 'aria-label': `1 damage to ${r.name}`, disabled: !alive.length, onclick: () => hit(r, 1) }, icon('minus', { size: 13 })),
          r.pack ? h('button.btn.btn-sm.sh-aoe', { type: 'button', disabled: !alive.length, title: 'Area hit: 1 damage to every member still standing', onclick: async () => { for (const m of aliveOf(r)) await act({ t: 'combat.damage', uid: m.uid, amount: 1 }, null); } }, '−1 all') : null,
          h('button.icon-btn.xs', { type: 'button', 'aria-label': `Heal ${r.name} 1`, onclick: () => heal(r) }, icon('plus', { size: 13 })),
          h('button.icon-btn.xs', { type: 'button', 'aria-label': `Remove ${r.name}`, title: 'Remove from the fight', onclick: async () => { for (const m of r.members) await act({ t: 'combat.remove', uid: m.uid }, null); } }, icon('x', { size: 13 }))),
        r.pack ? h('div.sh-pips', r.members.map((m) => h('i', { class: m.down ? 'gone' : '' }))) : h('div.sh-hpbar', h('i', { style: { width: `${first.hpMax ? (first.hp / first.hpMax) * 100 : 0}%` } })),
        first.attacks?.length && alive.length ? attackButtons(first.attacks, r.key, (i) => rollMob(r, i), { disabled: reaction() && view().combat?.rx?.step !== 'declare' }) : null);
    };
    if (!addPick || !mons.some((m) => m.id === addPick)) addPick = mons[0]?.id || '';
    const add = mons.length ? h('div.sh-min-add',
      select(mons.map((m) => ({ value: m.id, label: `${m.floor != null && m.floor !== '' ? `F${m.floor} ` : ''}${m.name} (${m.hpSlots ?? '?'} ${m.slotValue ? `slots × ${m.slotValue} HP` : 'HP'})` })), addPick, { onChange: (v) => { addPick = v; } }),
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
    const ps = view().players || [];
    const p = ps.find((x) => x.id === sc.data.playerId);
    const tier = view().pack?.lootTiers?.find((t) => t.id === sc.data.tier);
    if (sc.data.opened) {
      const item = sc.data.opened;
      return h('div.sc-ex-live', h('p.sc-line', p?.name, ' opened ', tier?.name || 'a loot box'),
        h('div.sc-line', itemArt(item, 'sc-peek-art'), h('b', item.name)), item.desc ? h('p', item.desc) : null);
    }
    const all = D('loot').playerId === '*';
    // GM peek: roll the table privately, re-roll until it fits the story, then open with that item.
    const pk = ui.peek && ui.peek.tier === tier?.id ? ui.peek : null;
    const peek = async () => {
      try { const r = await client.send({ t: 'loot.peek', tier: tier.id }); ui.peek = { tier: tier.id, item: r?.result?.item }; sig = ''; drawAll(); } catch (err) { toast(err.message, { error: true }); }
    };
    const open = async () => {
      if (await act({ t: 'loot.open', playerId: p.id, tier: tier.id, ...(pk?.item ? { itemId: pk.item.id } : {}) }, `${p.name} opens the ${tier.name}.`)) { ui.peek = null; sig = ''; drawAll(); }
    };
    return h('div.sc-ex-live',
      h('p.sc-line', tier ? h('b', tier.name) : 'No box', p ? ` for ${all ? 'everyone, starting with ' : ''}${p.name}` : ''),
      tier ? h('div.sc-peek', icon('lock', { size: 13 }), pk?.item
        ? [itemArt(pk.item, 'sc-peek-art'), h('span', 'Inside: ', h('b', pk.item.name), h('span.dim', ` (${pk.item.rarity})`)), h('button.btn.btn-sm', { type: 'button', onclick: peek }, 'Re-roll'), h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => { ui.peek = null; sig = ''; drawAll(); } }, 'Forget')]
        : [h('span.dim', 'Only you: see what is inside before the reveal.'), h('button.btn.btn-sm', { type: 'button', onclick: peek }, 'Peek')]) : null,
      h('div.sc-boss-row',
        p ? h('button.btn.btn-primary.sc-big', { type: 'button', disabled: !tier, onclick: open }, `Open it for ${p.name}${pk?.item ? ` (${pk.item.name})` : ''}`)
          : ps.map((x) => h('button.btn.btn-primary', { type: 'button', disabled: !tier, onclick: async () => { if (await act({ t: 'loot.open', playerId: x.id, tier: tier.id, ...(pk?.item ? { itemId: pk.item.id } : {}) }, `${x.name} opens the ${tier.name}.`)) { ui.peek = null; sig = ''; drawAll(); } } }, `Open for ${x.name}`)),
        all && ps.length > 1 ? h('button.btn.sc-big', { type: 'button', disabled: !tier, onclick: () => openForAll(tier) }, `Open for all ${ps.length}`) : null));
  }
  /** One box each, one after another (each opening gets its moment on the TV). */
  async function openForAll(tier) {
    const ps = view().players || [];
    for (let i = 0; i < ps.length; i++) {
      if (i) await new Promise((r) => setTimeout(r, 7000));
      await act({ t: 'scene.set', kind: 'loot', data: { playerId: ps[i].id, tier: tier.id } }, null);
      await act({ t: 'loot.open', playerId: ps[i].id, tier: tier.id }, `${ps[i].name} opens the ${tier.name}.`);
    }
  }
  /** Loot form: crawlers and boxes as tiles (boxes cheapest first, with their crate art). */
  function lootForm() {
    const v = view();
    const ps = v.players || [];
    const tiers = v.pack?.lootTiers || [];
    const d = D('loot');
    if (!d.playerId || (d.playerId !== '*' && !ps.some((p) => p.id === d.playerId))) d.playerId = ps[0]?.id || '';
    if (!tiers.some((t) => t.id === d.tier)) d.tier = tiers[0]?.id || '';
    const set = (k, val) => { d[k] = val; saveDraft(); sig = ''; drawAll(); };
    const crate = (t) => {
      const a = uiAsset(uiOf(v), 'lootBoxes', [t.id], ['closed', 'idle']);
      return a ? h('img', { src: a.still || a.src, alt: '', loading: 'lazy' }) : h('i.lt-sw', { style: { background: t.color || 'var(--c-accent)' } });
    };
    const who = ps.find((p) => p.id === d.playerId);
    const tier = tiers.find((t) => t.id === d.tier);
    return [
      h('div.span-all', h('p.lbl-t', 'Who gets it'), h('div.lt-who', [
        ...ps.map((p) => h('button.lt-p', { type: 'button', 'aria-pressed': String(d.playerId === p.id), style: { '--pc': p.color || 'var(--c-accent)' }, onclick: () => set('playerId', p.id) }, p.name)),
        ps.length > 1 ? h('button.lt-p', { type: 'button', 'aria-pressed': String(d.playerId === '*'), onclick: () => set('playerId', '*') }, 'Everyone (one each)') : null].filter(Boolean))),
      h('div.span-all', h('p.lbl-t', 'Box'), h('div.lt-boxes', tiers.map((t) => h('button.lt-box', { type: 'button', 'aria-pressed': String(d.tier === t.id), style: { '--tc': t.color || 'var(--c-accent)' }, onclick: () => set('tier', t.id) }, crate(t), h('span', t.name))))),
      h('p.lt-confirm.span-all', icon('gift', { size: 14 }), tier ? h('b', tier.name) : 'No box', ' → ', h('b', d.playerId === '*' ? 'everyone, one at a time' : who?.name || 'nobody')),
    ];
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
    h('span.sc-bc-meta', `${b.hpSlots} ${b.slotValue ? `slots × ${b.slotValue} HP` : 'HP'}`, b.phases?.length ? `, ${b.phases.length} phases` : '', b.floor ? `, floor ${b.floor}` : '', b.source === 'homebrew' ? ', homebrew' : ''),
    )) : h('p.dim', 'No bosses in the pack yet. Add bosses.json, create one in the Library, or switch to Ad hoc.')),
    h('div.span-all', minionSection(false)),
    picked?.attacks?.length ? h('div.span-all', attackSection(picked.name, picked.attacks, null, picked.id, { boss: true, prep: !isLive('boss') })) : null,
    picked?.tactics ? h('div.sc-gm-only.span-all', h('p.sc-gm-k', icon('lock', { size: 12 }), 'GM only'), h('p', h('b', 'Tactics. '), picked.tactics)) : null,
    txt('boss', 'lootHint', 'Loot line on the TV after the defeat', { placeholder: picked?.lootHint ? 'From the library' : 'e.g. Silver crate incoming', max: 160, cls: 'span-all' })];
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

  const enteredDice = new Map();
  let rolling = false;
  function scoredRolls() {
    const rs = view().pack?.ruleset;
    return rs?.system?.family === 'crawler' && rs.combat?.degreeScale === 'seven';
  }

  function rollMode() { return scoredRolls() ? D('roll').mode || 'single' : 'free'; }

  /* ---------- chase / race ---------- */
  const CHASE_DEG = { crit: 'Critical', amazing: 'Amazing', success: 'Success', near: 'Near miss', fail: 'Fail', major: 'Major fail', critfail: 'Wipe-out' };
  function chaseLegs(d) {
    d.legs ||= [{ label: 'Running', ability: 'skill:running' }, { label: 'Jumping', ability: 'skill:jumping' }, { label: 'Climbing', ability: 'skill:climbing' }];
    return d.legs;
  }
  function chaseData(d) {
    const legs = chaseLegs(d).map((l) => {
      const [k, id] = String(l.ability || '').split(':');
      return { label: l.label || '', ...(k === 'stat' ? { statId: id } : { skillId: id }), ...(Number(l.value) ? { value: Number(l.value) } : {}) };
    });
    const mode = d.mode === 'race' ? 'race' : 'chase';
    return { mode, title: d.title || '', legs, ...(mode === 'chase' ? { quarry: { name: d.quarry || '', ...(Number(d.value) ? { value: Number(d.value) } : {}) } } : {}),
      ...(d.npcName ? { npcs: [{ name: d.npcName, value: Number(d.npcValue) || 12 }] } : {}) };
  }
  function chaseForm() {
    const d = D('chase');
    const legs = chaseLegs(d);
    const opts = [...rollSkills().map((x) => ({ value: `skill:${x.id}`, label: x.name })), ...(view().pack?.ruleset?.stats ?? []).map((x) => ({ value: `stat:${x.id}`, label: `${x.label} (stat)` }))];
    const redraw = () => { saveDraft(); drawBody(); changed(); };
    const floor = view().crawlers?.floor || 1;
    return [
      h('div.seg.seg-sm.span-all', { 'aria-label': 'Contest' }, [['chase', 'Chase (catch the quarry)'], ['race', 'Race (first to the finish)']].map(([id, label]) =>
        h('button', { type: 'button', 'aria-pressed': String((d.mode || 'chase') === id), onclick: () => { d.mode = id; redraw(); } }, label))),
      txt('chase', 'title', 'Title on TV', { placeholder: (d.mode || 'chase') === 'race' ? 'Stairwell dash' : 'Catch the dragonling!', max: 80 }),
      (d.mode || 'chase') === 'chase' ? txt('chase', 'quarry', 'Quarry', { placeholder: 'What runs away', max: 60 }) : null,
      (d.mode || 'chase') === 'chase' ? txt('chase', 'value', 'Quarry rolls (every leg)', { placeholder: `${12 + floor} (10 + stat + floor + Move)`, max: 3 }) : null,
      h('div.span-all.sc-chase-legs', legs.map((l, i) => h('div.sc-chase-leg',
        h('span.dim', `Leg ${i + 1}`),
        field(l.label ?? '', { placeholder: 'Over the market stalls', attrs: { maxlength: 60 }, onCommit: (v) => { l.label = v; saveDraft(); changed(); } }),
        select(opts, l.ability || opts[0]?.value, { label: `Leg ${i + 1} check`, onChange: (v) => { l.ability = v; saveDraft(); changed(); } }),
        field(l.value ?? '', { type: 'number', placeholder: 'Quarry', attrs: { min: 1, max: 60, 'aria-label': `Leg ${i + 1} quarry number` }, onCommit: (v) => { l.value = v; saveDraft(); changed(); } }),
        h('button.icon-btn', { type: 'button', 'aria-label': `Remove leg ${i + 1}`, disabled: legs.length <= 1, onclick: () => { legs.splice(i, 1); redraw(); } }, '✕'))),
        legs.length < 8 ? h('button.btn.btn-sm', { type: 'button', onclick: () => { legs.push({ label: '', ability: legs.at(-1)?.ability }); redraw(); } }, '+ Leg') : null),
      txt('chase', 'npcName', (d.mode || 'chase') === 'race' ? 'NPC racer (optional)' : 'NPC chaser (optional)', { placeholder: 'Raul the Crab', max: 60 }),
      d.npcName ? txt('chase', 'npcValue', 'NPC result every leg', { placeholder: '12', max: 3 }) : null,
      h('p.dim.span-all', (d.mode || 'chase') === 'race'
        ? 'Every leg each crawler rolls + Move/10. Places 1st, 2nd… add up; lowest total wins.'
        : 'Every leg each crawler rolls + Move/10 against the quarry. Amazing +2 Ground, Success +1, Near 0, Fail −1, Major −2, Critical fail = out. 4 Ground = caught; after the last leg 1+ catches it.')];
  }
  function chaseControls(sc) {
    const d = sc.data;
    const leg = d.legs?.[d.leg];
    const physical = D('chase').dice === 'physical';
    const entered = (D('chase').entered ||= {});
    const runners = d.runners ?? [];
    const rollers = runners.filter((r) => !r.npc && !r.out && !(d.mode === 'chase' && r.caught));
    const last = new Map((d.last?.results ?? []).map((r) => [r.runnerId, r]));
    const rows = runners.map((r) => {
      const res = last.get(r.id);
      return h('li.sc-chase-runner', { class: `sc-chase-runner${r.out ? ' out' : ''}${r.caught ? ' caught' : ''}` },
        h('b', r.name), r.npc ? h('span.dim', ` NPC ${r.value}`) : r.mod ? h('span.dim', ` Move +${r.mod}`) : null,
        h('span.sc-chase-g', d.mode === 'race' ? `Places ${r.places.join('·') || '—'}` : r.out ? 'Out' : r.caught ? 'Caught' : `Ground ${r.ground > 0 ? '+' : ''}${r.ground}`),
        res ? h('span.dim', ` last: ${res.total}${res.degree ? ` ${CHASE_DEG[res.degree]}` : ''}${res.place ? ` #${res.place}` : ''}`) : null,
        d.mode === 'chase' && !d.done ? h('span.sc-chase-adj',
          h('button.btn.btn-sm', { type: 'button', title: 'Ground −1', onclick: () => act({ t: 'chase.adjust', runnerId: r.id, ground: -1 }) }, '−'),
          h('button.btn.btn-sm', { type: 'button', title: 'Ground +1 (clever idea)', onclick: () => act({ t: 'chase.adjust', runnerId: r.id, ground: 1 }) }, '+')) : null,
        physical && !d.done && rollers.includes(r) ? h('input.inp.sc-chase-die', { type: 'number', min: 1, max: 20, inputmode: 'numeric', 'aria-label': `${r.name} d20`, value: entered[r.playerId] ?? '',
          oninput: (e) => { entered[r.playerId] = e.target.value; } }) : null);
    });
    const go = async () => {
      const entries = physical ? rollers.map((r) => ({ playerId: r.playerId, entered: Number(entered[r.playerId]) })).filter((e) => e.entered >= 1 && e.entered <= 20) : [];
      if (physical && entries.length !== rollers.length) { toast('Enter every d20 first.'); return; }
      if (await act({ t: 'chase.leg', ...(entries.length ? { entries } : {}) }, null)) D('chase').entered = {};
    };
    return h('div.sc-chase-live',
      h('p.sc-line', d.done ? h('b', 'Finished') : h('b', `Leg ${d.leg + 1}/${d.legs.length}: ${leg?.label}`), !d.done && d.mode === 'chase' ? ` · quarry ${leg?.value}` : ''),
      h('ul.sc-chase-runners', rows),
      d.done ? null : h('div.sc-chase-go',
        h('label.chk', h('input', { type: 'checkbox', checked: physical, onchange: (e) => { D('chase').dice = e.target.checked ? 'physical' : 'digital'; saveDraft(); drawBody(); } }), h('span', 'Physical d20s')),
        h('button.btn.btn-primary.sc-big', { type: 'button', onclick: go }, `Roll leg ${d.leg + 1}`),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => act({ t: 'chase.finish' }, 'Called it.') }, 'End now')));
  }

  function rollSkills() {
    return (view().library?.skill || []).filter((s) => !['passive', 'evade'].includes(s.checkType?.toLowerCase()) && !s.tags?.includes('legacy'))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  const DC_TYPES = [
    ['stat', 'Stat', 'Raw stat, no skill: force a stuck door, shrug off booze or poison, see through an illusion.', (f) => `10 + floor ${f}`],
    ['unopposed', 'Unopposed', 'Skill vs the world: climb, pick a lock, scavenge, navigate. Nothing alive is pushing back.', (f) => `10 + 2 × floor ${f}`],
    ['opposed', 'Opposed', 'Skill vs someone with a stat block: lie to a guard (his Int/Cha), sneak past a patrol (Int), hold a door a goblin pushes (Str).', (f, m) => `10 + ${m ?? 'their mod'} + floor ${f}`],
    ['fixed', 'Fixed', 'Your own number (a printed Difficulty, or a judgement call).', () => 'your number'],
  ];
  const DEG_NAME = { crit: 'Critical hit', amazing: 'Amazing', success: 'Success', near: 'Near miss', fail: 'Fail', major: 'Major fail', critfail: 'Critical fail' };
  const DEG_HINT = { crit: 'perfect, extra effect', amazing: 'faster, quieter, impresses', success: 'it works', near: 'announce "Near miss"', fail: 'fail, or fail forward', major: 'fail + a cost (tool, time, face)', critfail: 'disaster, viewers will talk' };

  /** Library monsters/bosses with a stat block, plus mobs in the fight: opponents for an Opposed check. */
  function opponents(floor) {
    const lib = view().library ?? {};
    const mobs = (view().combat?.combatants ?? []).filter((c) => c.type === 'mob' && !c.dead && c.sourceId);
    const entryOf = (kind, id) => (lib[kind] ?? []).find((x) => x.id === id);
    const inFight = mobs.map((m) => ({ value: `mob:${m.uid}`, label: m.name, stats: entryOf(m.sourceKind === 'boss' ? 'boss' : 'monster', m.sourceId)?.stats }))
      .filter((o) => o.stats);
    const byFloor = (kind) => (lib[kind] ?? []).filter((x) => x.stats && (!x.floor || Math.abs(x.floor - floor) <= 1)).sort((a, b) => a.name.localeCompare(b.name))
      .map((x) => ({ value: `${kind}:${x.id}`, label: x.name, stats: x.stats }));
    return { inFight, bosses: byFloor('boss'), monsters: byFloor('monster') };
  }

  function rollCheck() {
    const mode = rollMode();
    if (mode === 'free') return null;
    const d = D('roll');
    const skills = rollSkills();
    const rs = view().pack?.ruleset;
    const stats = rs?.stats ?? [];
    const selection = mode === 'party' ? d.partyCheck : d.check;
    const stat = mode === 'single' && stats.find((s) => `stat:${s.id}` === selection);
    const skill = !stat && (skills.find((s) => `skill:${s.id}` === selection) ?? skills.find((s) => s.id === 'stealth') ?? skills[0]);
    const ability = stat || skill;
    const players = view().players || [];
    const participants = mode === 'party' ? players.filter((p) => !d.excluded?.includes(p.id))
      : [players.find((p) => p.id === d.checkPlayerId) ?? players[0]].filter(Boolean);
    const floor = view().crawlers?.floor || 1;
    // The book's check type is the default; the GM may switch it (an Unopposed climb becomes Opposed when someone shakes the rope).
    const bookType = stat ? 'stat' : skill?.checkType?.toLowerCase() === 'opposed' ? 'opposed' : 'unopposed';
    const key = ability ? `${stat ? 'stat' : 'skill'}:${ability.id}` : '';
    const dcType = d.dcTypeFor === key && d.dcType ? d.dcType : bookType;
    const opp = opponents(floor);
    const oppStat = d.oppStat || skill?.stat || stat?.id || stats[0]?.id;
    const picked = d.against ? [...opp.inFight, ...opp.bosses, ...opp.monsters].find((o) => o.value === d.against) : null;
    const mod = picked ? picked.stats?.[oppStat]?.mod ?? null : Number.isInteger(d.mod) ? d.mod : 0;
    const fixed = Number.isInteger(d.fixedDc) ? d.fixedDc : 10 + 2 * floor;
    const dc = checkDC({ dcType, mod: mod ?? 0, dc: fixed }, rs, { floor });
    const label = ability ? skill ? skill.name : `${stat.label} check` : 'Skill check';
    return { mode, stats, skills, ability, skill, stat, participants, floor, dcType, bookType, key, opp, oppStat, picked, mod, fixed, dc, label,
      dice: d.dice || 'phone', adv: d.adv || '', showDc: d.showDc === true };
  }

  const heldCheck = () => { const q = view().gm?.showCheck; return q && !q.revealed ? q : null; };

  function heldPanel(q) {
    const enter = (playerId, value) => act({ t: 'scene.check.enter', playerId, ...(value === undefined ? {} : { entered: value }) }, null);
    return h('div.span-all.sc-held',
      h('p.sc-line', h('b', `${q.label} · DC ${q.dc}`), h('span.dim', ` (${DC_TYPES.find((t) => t[0] === q.dcType)?.[1] ?? q.dcType}, floor ${q.floor}${q.against ? `, vs ${q.against.name} ${q.against.stat} ${q.mod >= 0 ? '+' : ''}${q.mod}` : ''}) · only you see this`)),
      h('ul.sc-held-rows', q.entries.map((e) => h('li.sc-held-row', { 'data-degree': e.degree || '' },
        h('b', e.name),
        e.die == null
          ? h('span.sc-held-wait', q.dice === 'phone' ? 'waiting for the phone… ' : 'no die yet ',
            h('input.inp.sc-held-fix', { type: 'number', min: 1, max: 20, inputmode: 'numeric', 'aria-label': `${e.name} d20`, placeholder: 'd20',
              onchange: (ev) => { const n = ev.target.valueAsNumber; if (n >= 1 && n <= 20) enter(e.playerId, n); } }),
            h('button.btn.btn-sm', { type: 'button', onclick: () => enter(e.playerId) }, 'App rolls'))
          : h('span', `${e.die}${e.otherDie != null ? ` (other ${e.otherDie})` : ''} ${e.modifier < 0 ? '−' : '+'} ${Math.abs(e.modifier)} = `, h('b', String(e.total)), ' → ',
            h('b.sc-held-deg', DEG_NAME[e.degree]), h('span.dim', ` · ${DEG_HINT[e.degree]}`), e.favored ? h('span.dim', ` · rerolled with AI Favor (was ${e.favored.from})`) : null),
        e.advantage ? h('span.dim', e.advantage === 'dis' ? ' · Disadvantage' : ' · Advantage') : null,
        e.die != null && !e.favored && e.die !== 1 && e.aiFavor > 0
          ? h('button.btn.btn-sm.btn-quiet', { type: 'button', title: 'Before you reveal: the crawler spends 1 AI Favor to reroll the d20', onclick: () => act({ t: 'scene.check.favor', playerId: e.playerId }, 'Rerolled with AI Favor.') }, `AI Favor reroll (${e.aiFavor})`)
          : null,
        e.die != null ? h('input.inp.sc-held-fix', { type: 'number', min: 1, max: 20, inputmode: 'numeric', 'aria-label': `Fix ${e.name}'s d20`, title: 'Wrong die? Type the right one', placeholder: 'fix',
          onchange: (ev) => { const n = ev.target.valueAsNumber; if (n >= 1 && n <= 20) enter(e.playerId, n); } }) : null))),
      h('p.dim', q.mode === 'party' ? `Party: ${Math.ceil(q.entries.length / 2)} of ${q.entries.length} must succeed; Amazing+ flips a failure, Major fail− flips a success. ` : '',
        'Players may spend AI Favor until you reveal. Crawlers without a die are left out of the reveal.'),
      h('div.sc-held-go',
        h('button.btn.btn-quiet', { type: 'button', onclick: () => act({ t: 'scene.check.cancel' }, 'Check called off.') }, 'Call it off')));
  }

  function rollForm() {
    const d = D('roll');
    const check = rollCheck();
    const mode = rollMode();
    const update = (key, value) => { d[key] = value; saveDraft(); drawBody(); changed(); };
    const held = scoredRolls() ? heldCheck() : null;
    if (held) return [heldPanel(held)];
    const modes = scoredRolls() ? h('div.seg.seg-sm.span-all.sc-roll-modes', { 'aria-label': 'Roll type' },
      [['single', 'Single check'], ['party', 'Party check'], ['free', 'Free roll']].map(([id, label]) => h('button', {
        type: 'button', 'aria-pressed': String(mode === id), onclick: () => { enteredDice.clear(); update('mode', id); },
      }, label))) : null;
    if (!check) return [modes, crawlerSelect('roll', { allowNone: true }), txt('roll', 'formula', 'Dice', { placeholder: 'd20', max: 60 }), txt('roll', 'label', 'What for', { placeholder: 'Save vs. the jukebox', max: 80 })];
    const players = view().players || [];
    const isParty = mode === 'party';
    const opts = [{ label: 'Skills', options: check.skills.map((s) => ({ value: `skill:${s.id}`, label: `${s.name} · ${s.checkType || ''}` })) }];
    if (!isParty) opts.unshift({ label: 'Stats', options: check.stats.map((s) => ({ value: `stat:${s.id}`, label: s.label })) });
    const required = Math.ceil(check.participants.length / 2);
    const type = DC_TYPES.find((t) => t[0] === check.dcType);
    const statOpts = check.stats.map((s) => ({ value: s.id, label: s.label }));
    const floorSel = select(Array.from({ length: 18 }, (_, i) => ({ value: String(i + 1), label: `Floor ${i + 1}` })), String(check.floor), {
      label: 'Floor', onChange: (v) => act({ t: 'crawlers.set', floor: Number(v) }, `The world is on floor ${v} now.`) });
    const oppGroups = [{ value: '', label: 'Type the modifier' },
      ...(check.opp.inFight.length ? [{ label: 'In the fight', options: check.opp.inFight }] : []),
      ...(check.opp.bosses.length ? [{ label: `Bosses (floor ${check.floor} ±1)`, options: check.opp.bosses }] : []),
      ...(check.opp.monsters.length ? [{ label: `Monsters (floor ${check.floor} ±1)`, options: check.opp.monsters }] : [])];
    const formula = type[3](check.floor, check.dcType === 'opposed' && check.mod != null ? `${check.mod}` : null);
    return [modes,
      labeled('Check', select(opts, check.key, { label: 'Check', onChange: (value) => update(isParty ? 'partyCheck' : 'check', value) })),
      isParty ? h('div.span-all.sc-check-party',
        h('div.sc-check-people', players.map((p) => h('label.chk', h('input', { type: 'checkbox', checked: !d.excluded?.includes(p.id), onchange: (e) => {
          const excluded = new Set(d.excluded);
          if (e.target.checked) excluded.delete(p.id); else excluded.add(p.id);
          update('excluded', [...excluded]);
        } }), h('span', p.name)))),
        players.length ? h('p.dim', required ? `${required} of ${check.participants.length} need to succeed. Exceptional rolls can swing a teammate’s result.` : 'Select crawlers for this check.') : null)
        : labeled('Crawler', select(players.map((p) => ({ value: p.id, label: p.name })), check.participants[0]?.id, { label: 'Crawler', onChange: (id) => update('checkPlayerId', id) })),
      h('div.span-all.seg.seg-sm.sc-dc-types', { 'aria-label': 'Difficulty' }, DC_TYPES.map(([id, label]) => h('button', {
        type: 'button', 'aria-pressed': String(check.dcType === id), title: DC_TYPES.find((t) => t[0] === id)[2],
        onclick: () => { d.dcTypeFor = check.key; update('dcType', id); },
      }, label, id === check.bookType ? h('small.dim', ' book') : null))),
      h('p.dim.span-all.sc-dc-hint', type[2], check.dcType !== check.bookType ? h('b', ` The book lists this as ${check.bookType}.`) : null),
      labeled('Floor', floorSel, { hint: 'The world floor (also the collapse clock).' }),
      check.dcType === 'opposed' ? labeled('Against', select(oppGroups, d.against || '', { label: 'Against', onChange: (v) => update('against', v) }), { hint: 'Their stat block gives the modifier.' }) : null,
      check.dcType === 'opposed' ? labeled('They resist with', select(statOpts, check.oppStat, { label: 'Resisting stat', onChange: (v) => update('oppStat', v) }),
        { hint: check.picked && check.mod == null ? 'No such stat in its block: type the modifier.' : 'Usually the stat that notices or resists.' }) : null,
      check.dcType === 'opposed' && (!check.picked || check.mod == null) ? labeled('Their modifier', h('input.inp', { type: 'number', min: -20, max: 20, value: Number.isInteger(d.mod) ? d.mod : 0,
        onchange: (e) => { const n = e.target.valueAsNumber; if (Number.isInteger(n)) update('mod', n); } })) : null,
      check.dcType === 'fixed' ? labeled('DC', h('input.inp', { type: 'number', min: -10, max: 99, value: check.fixed,
        onchange: (e) => { const n = e.target.valueAsNumber; if (Number.isInteger(n) && n >= -10 && n <= 99) update('fixedDc', n); } })) : null,
      h('div.span-all.sc-dc-result', h('span.dim', 'Difficulty '), h('b', `DC ${check.dc ?? '?'}`), h('span.dim', ` = ${formula}`),
        h('label.chk', h('input', { type: 'checkbox', checked: check.showDc, onchange: (e) => update('showDc', e.target.checked) }), h('span', 'Show the DC on the TV')),
        h('span.dim', check.showDc ? '' : ' (book: players hear the degree, never the DC)')),
      labeled('Situation', select([{ value: '', label: 'Normal' }, { value: 'adv', label: 'Advantage (2d20, higher)' }, { value: 'dis', label: 'Disadvantage (2d20, lower)' }], check.adv, { label: 'Situation', onChange: (v) => update('adv', v) }),
        { hint: 'Untrained skills get Disadvantage by themselves; one of each cancels.' }),
      players.length ? labeled('Dice', select([{ value: 'phone', label: 'Each phone (roll or type the die)' }, { value: 'physical', label: 'I type the physical d20' }, { value: 'digital', label: 'App rolls for everyone' }], check.dice, { label: 'Dice', onChange: (value) => update('dice', value) })) : null,
      !players.length ? h('p.dim.span-all', 'Add a crawler to roll a check.') : null,
      check.dice === 'physical' && check.participants.length ? h('div.span-all.sc-check-dice',
        check.participants.map((p) => labeled(`${p.name} · d20`, h('input.inp', {
          type: 'number', min: 1, max: 20, inputmode: 'numeric', value: enteredDice.get(p.id) || '',
          oninput: (e) => { enteredDice.set(p.id, e.target.value); drawGoLive(); },
        }))), h('p.dim', 'The kept die, before modifiers (Disadvantage: the lower one). Leave one empty to fill it in later.')) : null,
      h('details.span-all.sc-dc-help', h('summary', 'How results work'),
        h('ul', Object.entries(DEG_NAME).map(([k, name]) => h('li', h('b', name), ` · ${{ crit: 'natural 20', amazing: 'beat by 10+', success: 'beat by 0–9 (a tie succeeds)', near: 'missed by 1–2', fail: 'missed by 3–9', major: 'missed by 10+', critfail: 'natural 1' }[k]}: ${DEG_HINT[k]}`))),
        h('p.dim', 'Help outside combat: a helper adds +1d2 (untrained) or +1d6 (has Ranks) before the roll; no help on stat checks. You see every result first and reveal it on the TV.'))];
  }

  function readyCheck(check) {
    return check.ability && check.participants.length && check.dc != null && !(check.dcType === 'opposed' && check.picked && check.mod == null);
  }

  function formBody(kind) {
    const v = view();
    if (kind === 'lobby') return [txt('lobby', 'title', 'Title', { placeholder: v.pack?.systemName || 'The System', max: 80 }), txt('lobby', 'subtitle', 'Subtitle', { placeholder: 'Grab your phone. The show starts soon.', max: 160, cls: 'span-2' }), chk('lobby', 'showQr', 'Show the join QR')];
    if (kind === 'explore') return [locationPicker(), txt('explore', 'location', 'Location', { placeholder: 'The Food Court', max: 80, touch: true }), txt('explore', 'floor', 'Floor', { placeholder: 'Floor 2', max: 40, touch: true }), txt('explore', 'image', 'Background image URL', { placeholder: '/pack/images/…', max: 2000 }), txt('explore', 'text', 'Text on screen (read-aloud)', { rows: 3, max: 1200, cls: 'span-all', touch: true }), chk('explore', 'showFeed', 'Show the event feed')];
    if (kind === 'boss') return bossPicker();
    if (kind === 'chase') return chaseForm();
    if (kind === 'loot') return lootForm();
    if (kind === 'countdown') {
      return [txt('countdown', 'label', 'Label', { placeholder: 'Floor collapse in', max: 80, cls: 'span-2' }),
        labeled('Minutes', field(D('countdown').minutes ?? 5, { type: 'number', attrs: { min: 0, max: 1440 }, onCommit: (x) => { D('countdown').minutes = x; saveDraft(); changed(); } })),
        labeled('Seconds', field(D('countdown').seconds ?? 0, { type: 'number', attrs: { min: 0, max: 59 }, onCommit: (x) => { D('countdown').seconds = x; saveDraft(); changed(); } })),
        chk('countdown', 'autostart', 'Start right away', false)];
    }
    if (kind === 'roll') return rollForm();
    if (kind === 'recap') return [txt('recap', 'text', 'Recap text', { rows: 6, max: 4000, cls: 'span-all', dflt: v.recap || '', placeholder: 'Last time, our crawlers…' }), txt('recap', 'title', 'Show title', { placeholder: v.pack?.systemName || 'The System', max: 80 })];
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
    if (isTool(id) || id === 'fight' || id === 'map') { golive.replaceChildren(); golive.hidden = true; return; }
    const live = id === 'fight' ? fightOnAir() : isLive(id);
    golive.hidden = false;
    if (id === 'roll' && scoredRolls()) {
      const check = rollCheck();
      const held = heldCheck();
      golive.classList.toggle('is-live', live);
      if (held) {
        const ready = held.entries.filter((e) => e.die != null).length;
        golive.replaceChildren(h('span.sh-golive-h.dim', `${ready}/${held.entries.length} dice in`), h('span.grow'),
          h('button.btn.btn-primary.sh-golive-btn', { type: 'button', disabled: rolling || !ready, onclick: revealCheck },
            icon('tv', { size: 16 }), ready < held.entries.length ? `Reveal ${ready} on TV` : 'Reveal on TV', h('kbd', 'F6')));
        return;
      }
      golive.replaceChildren(h('span.sh-golive-h.dim', check?.dice === 'phone' ? 'Phones get the roll; you reveal it.' : 'You see the result first, then reveal it.'), h('span.grow'),
        h('button.btn.btn-primary.sh-golive-btn', { type: 'button', disabled: rolling || !!(check && !readyCheck(check)), onclick: rollOnTv },
          icon('dice', { size: 16 }), check?.dice === 'phone' ? 'Send to phones' : check?.mode === 'party' ? 'Roll party check' : 'Roll', h('kbd', 'F6')));
      return;
    }
    const meta = sceneOf(id);
    if (live) {
      const canUpdate = ['lobby', 'explore', 'recap'].includes(id);
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
    head.hidden = id === 'fight' || id === 'map';
    if (head.hidden) return;
    if (tool) { head.replaceChildren(...[h('h2', tool.label), tool.hint ? h('span.dim', tool.hint) : null].filter(Boolean)); return; }
    const meta = sceneOf(id);
    const live = id === 'fight' ? fightOnAir() : isLive(id);
    head.replaceChildren(
      live ? h('span.sh-state.live', 'On air') : h('span.sh-state', 'Preview'),
      h('h2', meta.label), h('span.dim', meta.hint));
    panel.classList.toggle('is-live', live);
  }

  // Fixed slots: the desk, sound, fight and NPC panels stay in the page (gm.js renders into them by id).
  const slots = { scene: h('div.sh-slot'), fight: h('div.sh-slot'), npc: h('div.sh-slot'), map: h('div.sh-slot'), sound: h('div.sh-slot'), desk: h('div.sh-slot'), crawlers: h('div.sh-slot') };
  body.append(slots.scene, slots.fight, slots.npc, slots.map, slots.sound, slots.desk, slots.crawlers);
  function drawBody() {
    const id = tab;
    const live = isLive(id);
    pvCol.hidden = false; // always there: a draft preview, or a mirror of the TV once it is on air
    panel.classList.toggle('no-pv', pvCol.hidden || !pref.pv);
    slots.fight.hidden = id !== 'fight';
    slots.npc.hidden = id !== 'npc';
    slots.map.hidden = id !== 'map';
    slots.sound.hidden = id !== 'sound';
    slots.desk.hidden = id !== 'desk';
    slots.crawlers.hidden = id !== 'crawlers';
    slots.scene.hidden = isTool(id);
    if (id === 'sound') { drawAudioPanel(); return; }
    if (id === 'desk' || id === 'crawlers') return;
    if (id === 'map') { slots.scene.replaceChildren(); return; }
    if (id === 'fight') {
      slots.scene.replaceChildren();
      return;
    }
    const out = [];
    if (live) out.push(h('div.sc-live', liveControls(id)));
    const form = h('div.form-grid', formBody(id).flat().filter(Boolean));
    if (live && id !== 'npc' && !(id === 'roll' && scoredRolls())) {
      out.push(h('details.sh-edit', { open: ui.editOpen || null, ontoggle: (e) => { ui.editOpen = e.target.open; } }, h('summary', id === 'boss' ? 'Another boss (restarts the boss screen)' : 'Change it'), h('div.sc-form', form,
        id === 'boss' ? h('div.row-end', h('button.btn', { type: 'button', onclick: () => goLiveBoss(bossDraftData()) }, 'Restart with this boss + intro')) : null)));
    } else out.push(h('div.sc-form', form));

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

  async function revealCheck() {
    if (rolling || !heldCheck()) return;
    rolling = true;
    drawGoLive();
    try { await act({ t: 'scene.check.reveal' }, null); } finally { rolling = false; if (tab === 'roll') { drawBody(); drawGoLive(); } }
  }

  async function rollOnTv() {
    const d = D('roll');
    if (scoredRolls() && heldCheck()) return revealCheck();
    const check = rollCheck();
    if (check) {
      if (rolling || !readyCheck(check)) return;
      rolling = true;
      drawGoLive();
      const entered = {};
      if (check.dice === 'physical') for (const p of check.participants) { const n = Number(enteredDice.get(p.id)); if (n >= 1 && n <= 20) entered[p.id] = n; }
      const rule = check.dcType === 'opposed'
        ? (check.picked && check.mod != null
          ? { against: check.picked.value.startsWith('mob:') ? { kind: 'mob', uid: check.picked.value.slice(4), stat: check.oppStat } : { kind: check.picked.value.split(':')[0], id: check.picked.value.split(':')[1], stat: check.oppStat } }
          : { mod: check.mod ?? 0 })
        : check.dcType === 'fixed' ? { dc: check.fixed } : {};
      try {
        if (await act({ t: 'scene.check.start', mode: check.mode, dcType: check.dcType, ...rule, playerIds: check.participants.map((p) => p.id), dice: check.dice,
          ...(check.dice === 'physical' ? { entered } : {}), ...(check.adv ? { adv: check.adv } : {}), showDc: check.showDc,
          ...(check.skill ? { skillId: check.skill.id } : { statId: check.stat.id }) }, null)) enteredDice.clear();
      } finally {
        rolling = false;
        if (tab === 'roll') { drawBody(); drawGoLive(); }
      }
      return;
    }
    const a = { t: 'scene.roll', formula: (d.formula || 'd20').trim() || 'd20' };
    if (d.playerId) a.playerId = d.playerId;
    if (d.label) a.label = d.label;
    await act(a, null);
  }

  /* ---------- keyboard: F1–F7 (pressed twice) = go live with that scene's draft ---------- */
  const armed = { key: null, at: 0 };
  document.addEventListener('keydown', (e) => {
    const m = /^F([1-7])$/.exec(e.key);
    if (!m || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const s = SCENES.find((x) => x.key === e.key);
    if (!s) return;
    e.preventDefault();
    // The TV is public: F-keys work only with the Show view open, and need a second press to fire.
    if (!el.isConnected || el.closest('[hidden]')) { toast('F-keys work on the Show view.'); return; }
    const now = Date.now();
    if (armed.key !== e.key || now - armed.at > 1500) {
      armed.key = e.key; armed.at = now;
      toast(`Press ${e.key} again to put ${s.label} on the TV`);
      return;
    }
    armed.key = null;
    if (s.kind === 'roll') rollOnTv(); else goLive(s.kind);
  });

  /* ---------- render ---------- */
  let sig = '';
  function update(v) {
    audio.update(v);
    drawAudio();
    const c = v.combat || {};
    const s = JSON.stringify([v.scene && { ...v.scene, now: 0, party: null }, tab, v.players, v.campaign?.ruleset, v.crawlers?.floor, v.library?.skill?.length, v.library?.boss?.length, v.library?.monster?.length, v.library?.location?.length, v.library?.npc?.length, v.pack?.lootTiers, v.show, v.gm?.showCheck, v.maps?.map((m) => m.id), c.mapId,
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
    if (p.maps) { slots.map.append(p.maps); parts.mapEditor = p.mapEditor; }
    if (p.crawlers) { parts.crawlers = p.crawlers; slots.crawlers.append(p.crawlers); }
    if (p.crawlersBadge) barExtra.append(p.crawlersBadge);
    if (p.reach) reachSlot.append(p.reach);
    slots.sound.append(audioPanel, parts.sound);
    slots.desk.append(desk);
    section.replaceChildren(el);
    sig = '';
    drawBody();
    // Preview on / off with the Show view.
    new MutationObserver(() => { sig = ''; if (!section.hidden) update(view()); else pvDrop(); }).observe(section, { attributes: true, attributeFilter: ['hidden'] });
  }

  /**
   * Loads library content into a scene draft and opens its chip (preview only, never live):
   * `explore` {locationId} · `npc` {npcId} · `boss` {bossId}. Used by Příprava's "Within reach".
   */
  function loadDraft(kind, data = {}) {
    const lib = view().library || {};
    if (kind === 'explore') {
      const l = (lib.location || []).find((x) => x.id === data.locationId);
      if (!l) return false;
      Object.assign(D('explore'), { locationId: l.id, location: l.name, floor: l.floor !== '' && l.floor != null ? `Floor ${l.floor}` : '', image: l.image || '', text: l.readAloud || '', locationTouched: false, floorTouched: false, textTouched: false });
    } else if (kind === 'npc') {
      if (!(lib.npc || []).some((x) => x.id === data.npcId)) return false;
      D('npc').npcId = data.npcId;
    } else if (kind === 'map') {
      if (!(view().maps || []).some((x) => x.id === data.mapId)) return false;
      D('map').mapId = data.mapId;
    } else if (kind === 'boss') {
      if (!(lib.boss || []).some((x) => x.id === data.bossId)) return false;
      bossPick = data.bossId;
      Object.assign(D('boss'), { bossId: data.bossId, mode: 'library' });
    } else if (kind === 'loot') {
      if (!(view().pack?.lootTiers || []).some((t) => t.id === data.tier)) return false;
      Object.assign(D('loot'), { tier: data.tier, playerId: null });
    } else return false;
    saveDraft();
    pick(kind);
    return true;
  }

  const api = { currentTab: () => tab, currentMap, el, update, audio, mountInto, loadDraft, openSub: (id) => pick(id === 'scenes' ? 'lobby' : id), pick, refresh: () => { sig = ''; update(view()); }, goLive };
  return api;
}
