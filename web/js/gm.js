import {
  SystemClient, TransportHub, takeHashToken, buzz, h, toast, itemArt, fmtNum, timeAgo,
  rarityOf, statusText, registerSW, isHosted, ask,
} from './client.js';
import { createSheet, localRolls, onLocalRoll } from './sheet.js';
import { openBuilder as openPlainBuilder } from './builder.js';
import { openCreator, hasCreator } from './creator.js';
// Rulesets with guided creation (ruleset.creation) get the step-by-step creator; others the plain builder.
const openBuilder = (o) => (hasCreator(o.model) ? openCreator(o) : openPlainBuilder(o));
import { createDiceLog, showRollCard } from './dicelog.js';
import { sheetModel, effectTargets, effectText, LIB_KINDS, playerEditLevel } from './rules.js';
import {
  icon, explain, whyContent, avatar, openDrawer, closeDrawer, drawerOpen, field, select, labeled,
  applyTheme, toggleTheme, applyAccent, setTheme, applyPackTheme,
} from './ui.js';
import { createLibrary } from './library.js';
import { createCombat } from './combat.js';
import { createScenes } from './gm-scenes.js';
import { createSound } from './gm-sound.js';
import { createCombatSfx } from './combat-sfx.js';
import { createCues } from './cues.js';
import { createNpcs } from './gm-npcs.js';
import { createPrep } from './gm-prep.js';
import { createMaps } from './gm-maps.js';
import { createCrawlers } from './gm-crawlers.js';
import { createMsgCenter } from './msgcenter.js';

const $ = (s, r = document) => r.querySelector(s);
// `client` is a hub: the Node boot attaches a WebSocket client, the hosted edition attaches its own transport.
const client = new TransportHub();
/** Hooks the hosted edition sets (lobby, prep cards, AI writer, library AI draft); all optional. */
export const ext = { afterRender: [], customAchievementWriter: null, libraryDraft: null, hosted: false };
// Players & devices panel (devices.js) + GM key login (gmlogin.js) hook in here.
ext.client = client;
ext.credential = null; // { key } or { token }

let view = null;
const shownPins = new Set();

/* ---------- action helper: haptic + toast from ack ---------- */

async function act(action, okMsg) {
  buzz(10);
  try {
    let ack = await client.send(action);
    while (action.t === 'combat.damage' && ack?.result?.confirmHit) {
      const hit = ack.result;
      if (!await ask(`Apply this hit to ${hit.name}? They will be ${hit.outcome}.`, { ok: 'Apply hit', danger: true })) return false;
      ack = await client.send({ ...action, confirmHit: hit.confirmHit });
    }
    if (okMsg) toast(okMsg);
    return ack && typeof ack === 'object' ? ack : true; // truthy; the ack carries `result`
  } catch (err) {
    toast(`${okMsg ? okMsg.replace(/\.$/, '') + ' failed: ' : ''}${err.message}`, { error: true, ms: 3500 });
    return false;
  }
}

/* ---------- connection status ---------- */

client.on('status', (s) => {
  const el = $('#conn');
  el.classList.toggle('ok', s.status === 'open');
  el.classList.toggle('bad', s.status === 'closed' || s.status === 'rejected' || (s.status === 'connecting' && s.attempt > 1));
  // Offline: dim the desk so nothing looks clickable that can't reach the table.
  document.body.classList.toggle('desk-offline', s.status === 'closed' || (s.status === 'connecting' && s.attempt > 1));
  $('.conn-text', el).textContent = statusText(s);
  if (s.status === 'rejected') {
    $('#gate').hidden = false;
    if (ext.credential?.key) { ext.onKeyRejected?.(s); return; }
    $('#gate .gate-title').textContent = 'GM link refused.';
    $('#gate .gate-desc').textContent = 'The token in this link is not valid for the running host. Copy the GM link from the host terminal again.';
  }
});

client.on('view', (v) => { view = v; render(); });

client.on('event', (e) => {
  if (String(e.kind).startsWith('combat.')) combatSfx?.event(e);
  cues?.event(e);
  if (e.kind === 'roll') {
    const r = e.roll || e;
    if (r.auto) return; // auto-mode mob rolls: the Combat log shows them
    if (!r.playerId || r.nat20 || r.nat1) showRollCard(r, { nameOf: (id) => fullPlayer(id)?.name || 'Someone' });
    return;
  }
  if (e.kind === 'itemUse' && e.pendingBuff) {
    const who = fullPlayer(e.playerId)?.name || 'A crawler';
    toast(`${who} used ${e.name}. Apply ${e.pendingBuff.name || e.pendingBuff.id || e.pendingBuff} to its target from the sheet (Apply buff).`, { ms: 8000 });
    return;
  }
  if (e.kind === 'secret') return;
  if (e.kind === 'viewers') return;
  if (e.kind === 'stat') return;
  const p = view?.players?.find((x) => x.id === e.playerId);
  if (e.kind === 'achievement') toast(`Achievement → ${p?.name || 'player'}: ${e.title}`);
  if (e.kind === 'loot') toast(`${p?.name || 'Player'} got ${e.item?.name || 'an item'} (${e.item?.rarity || '?'})`);
  if (e.kind === 'sponsor') toast(`${e.sponsor || 'Sponsor'} box → ${p?.name || 'player'}: ${e.item?.name || ''}`);
});

/* ---------- render ---------- */

function render() {
  if (!view) return;
  const s = view.session || {};
  const gm = view.gm || {};

  $('#room').textContent = view.room || '····';
  document.title = `GM ${view.room || ''} · The System`;

  const auto = $('#auto');
  auto.setAttribute('aria-checked', String(!!s.auto));
  $('.auto-state', auto).textContent = s.auto ? 'On' : 'Off';
  auto.disabled = !!s.aiMute;
  auto.title = s.aiMute ? 'AI is muted: unmute it to use AUTO' : 'Toggle AUTO (A)';
  const hold = $('#hold');
  hold.setAttribute('aria-pressed', String(!!s.hold));
  hold.textContent = s.hold ? 'Resume' : 'Hold';
  document.body.classList.toggle('on-hold', !!s.hold);
  const mute = $('#ai-mute');
  if (mute.dataset.on !== String(!!s.aiMute)) {
    mute.dataset.on = String(!!s.aiMute);
    mute.setAttribute('aria-pressed', String(!!s.aiMute));
    $('.ai-mute-i', mute).replaceChildren(icon(s.aiMute ? 'mute' : 'speaker', { size: 14 }));
    $('.ai-mute-s', mute).textContent = s.aiMute ? 'Muted' : 'On';
  }

  for (const b of document.querySelectorAll('#mode button')) {
    b.setAttribute('aria-checked', String(b.dataset.mode === s.mode));
  }
  $('#budget').textContent = s.budgetLeft ?? '–';

  renderVoices();
  renderQuips(gm.quipCategories || []);
  renderPending(gm.pendingAuto || []);
  renderPlayers();
  renderAudience();
  renderFeed();
  renderLinks();
  renderComms();
  renderPrep();
  renderLevelReminder();
  renderLog();
  renderSettings();
  renderCampaign();
  applyAccent(view.pack);
  applyPackTheme(view.pack?.theme);
  drawTheme();
  library.update(view);
  combatSfx?.view(view);
  combat.update(view);
  npcs.update(view);
  prep?.update(view);
  maps?.update(view);
  crawlers.update(view);
  scenes.update(view);
  { const cb = $('#hud-crawlers'); if (cb) { cb.disabled = !view.crawlers; cb.checked = view.crawlers?.shown !== false && !!view.crawlers; } }
  sound.update(view);
  rewards.update(view);
  msgCenter.update();
  const q = gm.queue || [];
  const bits = [];
  if (gm.playing) bits.push('speaking now');
  if (q.length) bits.push(`${q.length} queued`);
  if (!bits.length) bits.push(gm.aiAvailable ? `AI on, ${gm.aiCallsLeft ?? 0} calls left` : 'pack lines only');
  $('#queue-info').textContent = bits.join(', ');
  const sys = view.pack?.systemName;
  if (sys) $('.brand-name').textContent = sys;
  for (const fn of ext.afterRender) { try { fn(view); } catch (err) { console.error(err); } }
}

/**
 * Ruleset play timer. Once the GM starts it, notify at the exact milestone and offer a party level.
 * The compatibility reminder still reads estimated play time for older rulesets.
 */
const LEVEL_EVERY_MIN = 120;
let levelEl = null;
let levelClockView = null;
let levelClockReceived = 0;
const rankUpRule = () => view.pack?.ruleset?.skills?.rankUp;
const dueRankUp = (skill, when) => skill.used && (rankUpRule()?.sessionMaxRank == null || (skill.rank > rankUpRule().sessionMaxRank) === (when === 'floor'));
const rankUpEntries = (p) => [...(p.sheet?.skills ?? []), ...(p.sheet?.spells ?? []).filter((s) => s.attackCheck)];
function exactLevelClock(raw) {
  if (!raw) return null;
  if (levelClockView !== raw) { levelClockView = raw; levelClockReceived = performance.now(); }
  const extra = raw.running ? Math.max(0, performance.now() - levelClockReceived) : 0;
  return { ...raw, elapsed: raw.elapsed + extra, sinceLevel: raw.sinceLevel + extra, due: raw.elapsed + extra >= raw.dueAt };
}

function renderLevelClock(clock) {
  const toggle = $('#level-clock-toggle');
  const settings = $('#level-clock-settings');
  if (!toggle || !settings) return;
  toggle.hidden = settings.hidden = !clock;
  if (!clock) return;
  const minutes = Math.floor(clock.elapsed / 60_000);
  const elapsed = `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
  const action = clock.running ? 'Pause play' : clock.elapsed > 0 ? 'Resume play' : 'Start play';
  toggle.textContent = clock.running ? `${action} · ${elapsed}` : action;
  toggle.setAttribute('aria-label', action);
  toggle.title = `Play clock · ${elapsed} played. Pause it for breaks.`;
  toggle.onclick = () => act({ t: 'level.clock', op: clock.running ? 'pause' : 'start' });
  $('#level-clock-detail').textContent = `${elapsed} of play recorded. Start when the table begins, and pause for breaks. The next level is due after ${clock.interval} minutes of play.`;
  $('#level-clock-reset').onclick = async () => {
    if (await ask('Reset recorded play time for this session?', { ok: 'Reset play clock' })) await act({ t: 'level.clock', op: 'reset' });
  };
}

function renderLevelReminder() {
  if (!view) return;
  const pc = view.gm?.playClock;
  const clock = exactLevelClock(view.gm?.advancementClock);
  renderLevelClock(clock);
  const crawler = (view.pack?.ruleset?.system?.family || 'crawler') === 'crawler';
  const due = view.players?.length && (clock ? clock.due
    : pc && crawler && pc.sinceLevelMin >= LEVEL_EVERY_MIN && (pc.snoozeMin == null || pc.playMin >= pc.snoozeMin));
  if (!due) { levelEl?.remove(); levelEl = null; return; }
  const minutes = clock ? Math.floor(clock.sinceLevel / 60_000) : pc.sinceLevelMin;
  const interval = clock?.interval ?? LEVEL_EVERY_MIN;
  const late = minutes >= interval + 60;
  const marked = (view.gm?.playersFull || []).reduce((n, p) => n + rankUpEntries(p).filter((s) => dueRankUp(s, 'session')).length, 0);
  const hasRankUp = !!rankUpRule();
  const sig = `${late}|${Math.floor(minutes / 10)}|${marked}|${hasRankUp}|${clock?.next ?? ''}`;
  if (levelEl?.dataset.sig === sig) return;
  levelEl?.remove();
  const hrs = (minutes / 60).toFixed(1).replace('.0', '');
  levelEl = h('div.lvl-remind', { class: late ? 'lvl-remind late' : 'lvl-remind', role: 'status', 'data-sig': sig },
    h('p', h('b', late ? 'Level up is overdue.' : 'Time for a level up?'), ` ${hrs} h of play since the last milestone.`),
    h('div.row-start',
      h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        const a = clock ? { t: 'level.party', timed: true, checkpoint: clock.next } : { t: 'level.party', rankUp: hasRankUp };
        try { await act(a, clock ? 'Everyone gained a level. Players can open Level up.' : 'Everyone gained a level.'); }
        finally { button.disabled = false; }
      } }, 'Level up everyone'),
      h('button.btn.btn-sm', { type: 'button', onclick: () => act({ t: 'level.snooze', minutes: 30 }) }, 'Not yet (30 min)')));
  document.body.append(levelEl);
}
setInterval(() => { if (view?.gm?.advancementClock?.running) renderLevelReminder(); }, 1000);

function renderVoices() {
  const sel = $('#voice');
  const voices = view.pack?.voices || [];
  sel.parentElement.hidden = voices.length === 0;
  const sig = voices.map((v) => v.id + v.label).join('|');
  if (sel.dataset.sig !== sig) {
    sel.replaceChildren(...voices.map((v) => h('option', { value: v.id }, v.label || v.id)));
    sel.dataset.sig = sig;
  }
  if (view.session?.voice && document.activeElement !== sel) sel.value = view.session.voice;
}

let quipSig = '';
function renderQuips(cats) {
  const sig = JSON.stringify(cats);
  if (sig === quipSig) return;
  quipSig = sig;
  const grid = $('#quips');
  if (!cats.length) {
    grid.replaceChildren(h('p.empty', 'The pack has no quip lines.'));
    return;
  }
  grid.replaceChildren(...cats.map((c, i) => h('button.quip', {
    type: 'button',
    'data-cat': c.id,
    class: c.left === 0 ? 'quip spent' : 'quip',
    disabled: c.total === 0,
    title: c.total === 0 ? `The pack has no ${c.label} lines` : `Play a ${c.label} line now${i < 9 ? ` (${i + 1})` : ''}`,
    onclick: (ev) => playQuip(c, ev.currentTarget),
  },
  i < 9 ? h('kbd', String(i + 1)) : null,
  h('span.ql', c.label || c.id),
  h('span.qm', h('span', c.total === 0 ? 'none in pack' : (c.total != null ? `of ${c.total} left` : 'left')), h('b', c.total === 0 ? '' : String(c.left ?? '∞'))),
  )));
}

function playQuip(c, el) {
  if (el) { el.classList.add('hit'); setTimeout(() => el.classList.remove('hit'), 150); }
  act({ t: 'quip.play', category: c.id }, `Playing ${c.label}.`);
}

/* pending auto lines with live countdown */
let pendingTimer = null;
function renderPending(list) {
  const wrap = $('#pending');
  const sig = list.map((p) => p.id).join(',');
  if (wrap.dataset.sig !== sig) {
    wrap.dataset.sig = sig;
    wrap.replaceChildren(...list.map((p) => h('div.sys.pend', { 'data-head': 'AUTO LINE INCOMING', 'data-id': p.id, 'data-at': p.playsAt || 0 },
      h('div',
        h('p.sys-desc', p.text),
        h('p.count.mono', ''),
      ),
      h('button.btn.btn-alarm.veto', { type: 'button', onclick: () => act({ t: 'auto.veto', id: p.id }, 'Vetoed.') }, 'Veto'),
      h('div.pend-bar'),
    )));
  }
  clearInterval(pendingTimer);
  if (list.length) {
    const tick = () => {
      for (const el of wrap.querySelectorAll('.pend')) {
        const at = Number(el.dataset.at) || 0;
        const left = Math.max(0, (at - Date.now()) / 1000);
        $('.count', el).textContent = left > 0 ? `plays in ${left.toFixed(1)} s` : 'playing at next pause';
        $('.pend-bar', el).style.width = `${Math.min(100, (left / 5) * 100)}%`;
      }
    };
    tick();
    pendingTimer = setInterval(tick, 100);
  }
}

/* ---------- party ---------- */

const fullPlayer = (id) => view?.gm?.playersFull?.find((p) => p.id === id) || view?.players?.find((p) => p.id === id) || { id };
let selectedId = null;
try { selectedId = sessionStorage.getItem('system.gm.sel') || null; } catch {}

const gmTools = {
  addBuff: (p, M) => buffPicker(p, M),
  give: (p, M) => givePicker(p, M),
};
const sheetCmp = createSheet({
  mode: 'gm',
  send: (a) => client.send(a),
  gmTools,
  onBuilder: (model, p) => openBuilder({ model, player: p, gm: true, act: sheetCmp.act }),
});

function selectPlayer(id) {
  selectedId = selectedId === id ? null : id;
  try { selectedId ? sessionStorage.setItem('system.gm.sel', selectedId) : sessionStorage.removeItem('system.gm.sel'); } catch {}
  renderPlayers(true);
}

let partySig = '';
function renderPlayers(force = false) {
  const wrap = $('#players');
  const list = view.players || [];
  const rankRule = rankUpRule();
  $('#rank-up').hidden = !list.length || !rankRule;
  $('#rank-up-floor').hidden = !list.length || rankRule?.sessionMaxRank == null;
  $('#rank-up').title = rankRule?.sessionMaxRank != null ? `Marked skills at Rank ${rankRule.sessionMaxRank} or lower` : 'Roll for all marked skills';
  $('#rank-up-floor').title = rankRule?.sessionMaxRank != null ? `Marked skills above Rank ${rankRule.sessionMaxRank}` : '';
  $('#player-count').textContent = list.length ? `${list.filter((p) => p.connected).length} of ${list.length} online` : '';
  if (selectedId && !list.some((p) => p.id === selectedId)) selectedId = null;
  $('#party').classList.toggle('has-sheet', !!selectedId);
  const sheetHost = $('#party-sheet');
  sheetHost.hidden = !selectedId;
  if (selectedId) {
    if (!sheetHost.contains(sheetCmp.el)) sheetHost.replaceChildren(h('button.btn.btn-quiet.sheet-back', { type: 'button', onclick: () => selectPlayer(selectedId) }, icon('back', { size: 16 }), 'All crawlers'), sheetCmp.el, crawlerAdmin());
    sheetCmp.update(view, fullPlayer(selectedId));
    const adm = sheetHost.querySelector('.crawler-admin');
    if (adm && adm.dataset.for !== selectedId + JSON.stringify(view.gm?.pins?.[selectedId]) && !adm.contains(document.activeElement)) adm.replaceWith(crawlerAdmin());
  }
  const sig = JSON.stringify([list, view.gm?.playersFull, view.gm?.pins, [...shownPins], selectedId, view.session?.permissions, view.library ? Object.keys(view.library).length : 0]);
  if (!force && sig === partySig) return;
  if (wrap.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) return;
  partySig = sig;
  if (!list.length) {
    // With the access model the setup checklist (onboard.js) is the empty state.
    wrap.replaceChildren(...(view.gm?.access ? [] : [h('div.empty-state', h('p', h('b', 'No crawlers yet.')), h('p.dim', 'Add the first one, then give them the join link and their PIN.'), h('button.btn.btn-primary', { type: 'button', onclick: showAddPlayer }, 'Add crawler'))]));
    return;
  }
  const head = h('div.prow.prow-head', h('span', 'Crawler'), h('span', 'Health'), h('span', 'Mana'), h('span.c', 'Evade'), h('span.c', 'DR'), h('span', 'Buffs and conditions'), h('span.c', 'Used'), h('span', ''));
  wrap.replaceChildren(head, ...list.map((s) => partyRow(fullPlayer(s.id), s)));
}

function partyRow(p, summary) {
  const M = sheetModel(view, p);
  const c = M.computed;
  const hpDef = M.rs.tracks.find((t) => t.id === 'hp') || M.rs.tracks[0];
  const manaDef = M.rs.tracks.find((t) => t.id !== hpDef?.id);
  const hp = hpDef ? (c.tracks?.[hpDef.id] || { cur: 0, max: 0 }) : null;
  const mana = manaDef ? (c.tracks?.[manaDef.id] || { cur: 0, max: 0 }) : null;
  const evadeDef = M.rs.derived.find((d) => d.roll) || M.rs.derived[0];
  const drDef = M.rs.derived.find((d) => /^dr$|resist/i.test(d.id + d.label) && d !== evadeDef);
  const id = M.sheet.identity || {};
  const sel = selectedId === p.id;
  const track = (def, v) => {
    if (!def || !v) return h('span.dim', '—');
    const step = (d) => h('button.icon-btn.xs', { type: 'button', 'aria-label': `${def.label} ${d > 0 ? 'plus' : 'minus'} 1 for ${p.name}`, onclick: (e) => { e.stopPropagation(); quickTrack(p, def, d); } }, icon(d > 0 ? 'plus' : 'minus', { size: 13 }));
    if (def.kind === 'slots') {
      const n = def.slots || v.max || 10;
      return h('div.mini-track', step(-1), h('span.mini-slots', { title: `${v.cur} of ${n}`, style: { '--n': n } }, Array.from({ length: n }, (_, i) => h('i', { class: i < v.cur ? 'on' : null }))), h('b.mini-v', String(v.cur)), step(1));
    }
    return h('div.mini-track', step(-1), h('b.mini-v', `${v.cur}/${v.max}`), step(1));
  };
  const why = (b, title) => {
    const el = h('span.num', { tabindex: '0' }, String(b?.value ?? '—'));
    if (b) explain(el, () => whyContent(b, { title }));
    return el;
  };
  const buffs = (M.sheet.buffs || []).map((b) => {
    const def = M.lib.buff.find((x) => x.id === b.buffId) || {};
    const effs = b.effects?.length ? b.effects : (def.effects || []);
    const neg = effs.reduce((s, e) => s + (typeof e.value === 'number' ? e.value : 0), 0) < 0;
    return h('span.mini-buff', { class: neg ? 'mini-buff neg' : 'mini-buff', title: b.until ? `${b.name}: ${b.until}` : b.name }, b.name || def.name);
  });
  const used = (M.sheet.skills || []).filter((s) => s.used).length;
  const pin = view.gm?.pins?.[p.id];
  return h('div.prow', { class: `prow${sel ? ' sel' : ''}${summary.connected ? '' : ' off'}`, 'data-id': p.id },
    h('button.prow-who', { type: 'button', 'aria-pressed': String(sel), onclick: () => selectPlayer(p.id), title: sel ? 'Close the sheet' : 'Open the sheet' },
      avatar(id.name || p.name, { color: p.color, src: M.sheet.portrait, size: 32 }),
      h('span.pw',
        h('span.pn', h('span.cdot', { class: summary.connected ? 'cdot on' : 'cdot', 'aria-hidden': 'true' }), id.name || p.name || 'Unnamed'),
        h('span.pl', h('span.pphone', { class: summary.connected ? 'pphone on' : 'pphone' }, summary.connected ? 'Phone on' : 'No phone'), [[id.race, id.class].filter(Boolean).join(' '), `Lv ${id.level ?? p.level ?? 1}`].filter(Boolean).join(', ')),
      ),
    ),
    h('div.pc-hp', track(hpDef, hp)),
    h('div.pc-mana', track(manaDef, mana)),
    h('div.c', evadeDef ? why(c.derived?.[evadeDef.id], evadeDef.label) : h('span.dim', '—')),
    h('div.c', drDef ? why(c.derived?.[drDef.id], drDef.label) : h('span.dim', '—')),
    h('div.pc-buffs', buffs.length ? buffs : h('span.dim', 'None')),
    h('div.c', used ? h('span.pill.pill-on', { title: 'Skills used this session' }, String(used)) : h('span.dim', '0')),
    h('div.pc-act',
      p.joinUrl || view.gm?.access ? h('button.btn.btn-sm.invite-btn', {
        type: 'button', class: summary.connected ? 'btn btn-sm invite-btn' : 'btn btn-sm invite-btn need',
        title: summary.connected ? `${p.name}'s phone is connected. Show the QR again` : `Show ${p.name}'s QR code`,
        onclick: (e) => { e.stopPropagation(); ext.openInvite?.(p.id); },
      }, icon('qr', { size: 14 }), h('span', 'Invite')) : null,
      pin != null && !ext.hosted ? h('button.pin-btn', { type: 'button', title: 'Show or hide the PIN', onclick: () => { shownPins.has(p.id) ? shownPins.delete(p.id) : shownPins.add(p.id); renderPlayers(true); } }, shownPins.has(p.id) ? pin : 'PIN') : null,
      iconBtn('sparkle', 'Award achievement', () => achievementSheet(p)),
      iconBtn('gift', 'Loot box', () => lootSheet(p, false)),
      iconBtn('star', 'Sponsor box', () => lootSheet(p, true)),
      iconBtn('log', 'Message', () => { showView('messages'); msgCenter.open(p.id); }),
    ),
  );
}

function iconBtn(name, label, fn) {
  return h('button.icon-btn', { type: 'button', title: label, 'aria-label': label, onclick: (e) => { e.stopPropagation(); buzz(10); fn(); } }, icon(name, { size: 16 }));
}

function quickTrack(p, def, d) {
  if (p.sheet) act({ t: 'track.set', playerId: p.id, track: def.id, delta: d });
  else act({ t: 'player.resource', playerId: p.id, res: def.id, delta: d });
}

/** Name, color, PIN and removal: the parts of a crawler that are not on the sheet. */
function crawlerAdmin() {
  const p = fullPlayer(selectedId);
  const upd = (field, value) => act({ t: 'player.update', playerId: p.id, [field]: value }, 'Saved.');
  const pin = view.gm?.pins?.[p.id] || '';
  return h('details.crawler-admin', { 'data-for': selectedId + JSON.stringify(view.gm?.pins?.[selectedId]) },
    h('summary', 'Crawler settings'),
    h('div.form-grid',
      labeled('Display name', field(p.name, { onCommit: (v) => upd('name', v) })),
      labeled('Color', h('input.swatch', { type: 'color', value: p.color || '#e3a33b', onchange: (e) => upd('color', e.target.value) })),
      ext.hosted ? null : labeled('PIN', field(pin, { attrs: { inputmode: 'numeric', pattern: '\\d{4}', maxlength: 4 }, onCommit: (v) => upd('pin', v) })),
      labeled('Gold', field(p.gold ?? 0, { type: 'number', onCommit: (v) => upd('gold', Math.max(0, v)) })),
    ),
    h('div.row-end', h('button.btn.btn-sm.danger', {
      type: 'button',
      onclick: async () => { if (await ask(`Remove ${p.name} from the game? Their sheet and inventory go too.`, { ok: 'Remove crawler', danger: true })) { await act({ t: 'player.remove', playerId: p.id }, 'Crawler removed.'); selectedId = null; renderPlayers(true); } },
    }, icon('trash', { size: 14 }), 'Remove crawler')),
  );
}

function showAddPlayer() {
  ext.openAddCrawler?.(); // onboard.js: name → Invite card (QR) → build now or on the phone
}

/** Opens a crawler's sheet on the Party view (and optionally the character builder). */
ext.openBuilderFor = (id) => {
  showView('party');
  selectedId = id;
  try { sessionStorage.setItem('system.gm.sel', id); } catch {}
  renderPlayers(true);
  const p = fullPlayer(id);
  const M = sheetCmp.model();
  if (p && M) openBuilder({ model: M, player: p, gm: true, act: sheetCmp.act });
};

/* GM sheet tools: apply buff, give from library */

function buffPicker(p, M) {
  const extCap = M.rs.buffSlots?.external;
  const extUsed = M.computed.externalBuffs?.used ?? (M.sheet.buffs || []).filter((b) => b.external).length;
  const list = h('ul.pick-list', M.lib.buff.map((b) => h('li', h('button.pick', {
    type: 'button',
    disabled: b.external && extCap?.max != null && extUsed >= extCap.max,
    onclick: async () => { if (await act({ t: 'buff.add', playerId: p.id, buffId: b.id }, `${b.name} applied.`)) closeDrawer(); },
  }, h('span', h('b', b.name), b.external ? h('span.dim', ' external') : null), h('span.dim', (b.effects || []).map((e) => effectText(M.rs, e)).join(', '))))));
  const name = field('', { placeholder: 'e.g. Inspired' });
  const target = select(effectTargets(M.rs), M.rs.derived[0]?.id || '', { label: 'Affects' });
  const val = field(1, { type: 'number' });
  const ext = h('input', { type: 'checkbox' });
  const until = field('', { placeholder: 'Until end of fight' });
  openDrawer({
    title: `Apply buff to ${p.name}`,
    sub: extCap ? `${extCap.label}: ${extUsed}${extCap.max != null ? ` of ${extCap.max}` : ''} used` : null,
    body: [
      M.lib.buff.length ? list : h('p.empty-s', 'No buffs in the library yet.'),
      h('h3.sub-t', 'Or a one-off modifier'),
      h('div.form-grid', labeled('Name', name), labeled('Affects', target), labeled('Value', val, { hint: 'Negative makes it a debuff' }), labeled('Lasts', until), h('label.chk.span-all', ext, h('span', 'Counts as an external buff'))),
    ],
    actions: [h('button.btn.btn-primary', { type: 'button', onclick: async () => {
      if (!name.value.trim()) { name.focus(); return; }
      const a = { t: 'buff.add', playerId: p.id, name: name.value.trim(), external: ext.checked, duration: until.value.trim(), effects: [{ target: target.value, op: 'add', value: Number(val.value) || 0, when: 'active', label: name.value.trim() }] };
      if (await act(a, `${a.name} applied.`)) closeDrawer();
    } }, 'Apply modifier')],
  });
}

function givePicker(p, M, kind = 'item') {
  const kinds = ['item', 'spell', 'skill', 'buff'];
  let q = '';
  const listEl = h('ul.pick-list.give-list');
  const draw = () => {
    const hits = M.lib[kind].filter((e) => !q || `${e.name} ${(e.tags || []).join(' ')}`.toLowerCase().includes(q)).slice(0, 150);
    listEl.replaceChildren(...(hits.length ? hits.map((e) => h('li', h('button.pick', {
      type: 'button',
      onclick: async () => { if (await act({ t: 'lib.give', playerId: p.id, kind, id: e.id }, `Gave ${e.name} to ${p.name}.`)) closeDrawer(); },
    }, kind === 'item' || kind === 'spell' ? itemArt({ ...e, rarity: e.rarity || 'common' }, 'inv-ico') : null,
    h('span.pick-txt', h('b', e.name, e.source === 'homebrew' ? h('span.dim', ' homebrew') : null), e.desc || e.effects ? h('span.dim.pick-line', typeof e.effects === 'string' ? e.effects : e.desc || '') : null),
    h('span.dim', e.rarity || e.checkType || ''))))
      : [h('li.empty-s', 'Nothing matches.')]));
  };
  const search = h('input.inp', { type: 'search', placeholder: 'Search the library', oninput: (e) => { q = e.target.value.trim().toLowerCase(); draw(); } });
  const seg = h('div.seg', kinds.map((k) => h('button', { type: 'button', 'aria-pressed': String(k === kind), onclick: () => { kind = k; for (const b of seg.children) b.setAttribute('aria-pressed', String(b.textContent === LIB_KINDS.find((x) => x.id === k).plural)); draw(); } }, LIB_KINDS.find((x) => x.id === k).plural)));
  draw();
  openDrawer({ title: `Give to ${p.name}`, body: [seg, search, listEl] });
  setTimeout(() => search.focus(), 50);
}

/* ---------- rank-up ---------- */

async function rankUp(when) {
  const before = new Map();
  for (const p of view.gm?.playersFull || []) for (const s of rankUpEntries(p)) if (dueRankUp(s, when)) before.set(s.uid, s);
  const usedCount = before.size;
  if (!usedCount) { toast('No marked skills or spells are due for this rank-up.'); return; }
  if (!(await ask(`Roll ${usedCount} ${when === 'floor' ? 'end-of-floor' : 'session'} rank-up check${usedCount === 1 ? '' : 's'} for the party? Each roll clears its mark.`, { ok: 'Roll rank-ups' }))) return;
  let res;
  try { res = await client.send({ t: 'skills.rankUp', when }); } catch (err) { toast(err.message, { error: true }); return; }
  const show = (rows) => openDrawer({
    title: 'Rank-up results',
    sub: `${rows.filter((r) => r.up).length} of ${rows.length} ranks increased`,
    body: h('table.res-table', h('thead', h('tr', h('th', 'Crawler'), h('th', 'Skill or spell'), h('th.c', 'Roll'), h('th.c', 'Rank'))),
      h('tbody', rows.map((r) => h('tr', { class: r.up ? 'up' : null }, h('td', r.who), h('td', r.name), h('td.c', r.roll ?? '—'), h('td.c', r.up ? `${r.from} → ${r.to}` : String(r.from)))))),
  });
  const fromAck = res?.result?.results;
  if (Array.isArray(fromAck)) {
    show(fromAck.map((r) => ({ ...r, roll: typeof r.roll === 'object' ? r.roll?.total : r.roll, who: fullPlayer(r.playerId)?.name || '', up: r.to > r.from })));
    return;
  }
  // Engine did not return results: diff the next view.
  const off = client.on('view', (v) => {
    off();
    const rows = [];
    for (const p of v.gm?.playersFull || []) for (const s of rankUpEntries(p)) {
      const b = before.get(s.uid);
      if (b) rows.push({ who: p.name, name: s.name, from: b.rank, to: s.rank, up: s.rank > b.rank });
    }
    show(rows);
  });
}

/* ---------- sheets ---------- */

const sheet = $('#sheet');
function openSheet(title, body, accent) {
  $('#sheet-title').textContent = title;
  $('#sheet-body').replaceChildren(...[body].flat().filter(Boolean));
  if (!sheet.open) sheet.showModal();
}
const closeSheet = () => sheet.open && sheet.close();

function achievementSheet(p) {
  const cat = view.gm?.achievementsCatalog || [];
  const list = h('div.cat-list');
  const search = h('input.field', { type: 'search', placeholder: `Search ${cat.length} achievements`, autocomplete: 'off' });
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const hits = cat
      .filter((a) => !q || `${a.title} ${a.desc || ''} ${a.group || ''}`.toLowerCase().includes(q))
      .sort((x, y) => (x.group || '').localeCompare(y.group || ''));
    const out = [];
    let lastGroup = null;
    for (const a of hits.slice(0, 80)) {
      if ((a.group || '') !== lastGroup) {
        lastGroup = a.group || '';
        if (lastGroup) out.push(h('div.divider', lastGroup));
      }
      out.push(a);
    }
    list.replaceChildren(...(hits.length ? out.map((a) => a instanceof Node ? a : h('button.cat-item', {
      type: 'button',
      onclick: async () => { if (await act({ t: 'ach.award', playerId: p.id, achId: a.id }, `Awarded ${a.title}.`)) closeSheet(); },
    }, h('b', a.title), h('span', a.desc), a.reward ? h('span.rw', `Reward: ${a.reward}`) : null)) : [h('p.empty', 'Nothing matches. Write a custom one below.')]));
  };
  search.addEventListener('input', draw);
  draw();

  const title = h('input.field', { placeholder: 'Custom title', maxlength: 80 });
  const desc = h('textarea.field', { placeholder: 'Description, in the System voice. A few sentences is fine.', maxlength: 1200, rows: 4 });
  const reward = h('input.field.reward-in', { placeholder: 'Reward (optional), e.g. a Bronze Box', maxlength: 160 });
  const award = h('button.btn.btn-cyan', {
    type: 'button',
    onclick: async () => {
      if (!title.value.trim()) { title.focus(); return; }
      const a = { t: 'ach.award', playerId: p.id, title: title.value.trim(), desc: desc.value.trim() };
      if (reward.value.trim()) a.reward = reward.value.trim();
      if (await act(a, 'Custom achievement awarded.')) closeSheet();
    },
  }, 'Award custom');

  let writer = null;
  if (ext.customAchievementWriter) {
    const brief = h('input.field', { placeholder: 'What happened, in a few words', maxlength: 300 });
    const status = h('p.ai-status.mono', { 'aria-live': 'polite' });
    const go = h('button.btn.btn-hot', {
      type: 'button',
      onclick: async () => {
        const what = brief.value.trim() || title.value.trim();
        if (!what) { brief.focus(); return; }
        go.disabled = true;
        status.textContent = 'Writing. This can take a few seconds.';
        try {
          const r = await ext.customAchievementWriter({ player: fullPlayer(p.id), brief: what, view });
          if (r) {
            title.value = r.title || title.value;
            desc.value = r.desc || '';
            reward.value = r.reward || '';
            status.textContent = 'Draft ready. Edit it, then award.';
          }
        } catch (err) {
          status.textContent = err?.userMessage || 'Could not write it. Type it yourself.';
          if (err?.hide) writer.hidden = true;
        } finally {
          go.disabled = false;
        }
      },
    }, 'Write it for me');
    writer = h('div.ai-writer', h('div.say-row', brief, go), status);
  }
  openSheet(`Achievement for ${p.name}`, [search, list, h('div.divider', 'or write one'), h('div.stack', writer, title, desc, reward, award)], 'var(--cyan)');
  setTimeout(() => search.focus(), 30);
}

function lootSheet(p, sponsor) {
  const tiers = view.pack?.lootTiers || [];
  const sponsorName = sponsor ? h('input.field', { placeholder: 'Sponsor name (optional)', maxlength: 40 }) : null;
  const grid = h('div.tier-grid', tiers.map((t) => h('button.tier', {
    type: 'button',
    style: { '--t': t.color || 'var(--acid)' },
    onclick: async () => {
      const a = sponsor
        ? { t: 'sponsor.box', playerId: p.id, tier: t.id, ...(sponsorName.value.trim() ? { sponsor: sponsorName.value.trim() } : {}) }
        : { t: 'loot.open', playerId: p.id, tier: t.id };
      if (await act(a, sponsor ? 'Sponsor box sent.' : `${t.name} opened.`)) closeSheet();
    },
  }, t.name || t.id)));
  const body = tiers.length ? [sponsorName, grid].filter(Boolean) : [h('p.empty', 'The pack defines no loot tiers.')];
  const catalog = view.gm?.itemsCatalog || [];
  if (!sponsor && catalog.length) {
    const sel = h('select.field', catalog.map((it) => h('option', { value: it.id }, `${it.name} (${rarityOf(it.rarity)})`)));
    const plus = h('select.field.give-plus', { 'aria-label': 'Enhancement' }, ['Plain', '+1', '+2', '+3'].map((l, n) => h('option', { value: n }, l)));
    const syncPlus = () => { const it = catalog.find((x) => x.id === sel.value); plus.disabled = !it?.enhanceable; if (plus.disabled) plus.value = '0'; };
    sel.addEventListener('change', syncPlus); syncPlus();
    body.push(
      h('div.divider', 'or give a specific item, no animation'),
      h('div.say-row', sel, plus, h('button.btn.btn-ghost', {
        type: 'button',
        onclick: async () => {
          const it = catalog.find((x) => x.id === sel.value);
          const bonus = Number(plus.value) || 0;
          if (await act({ t: 'item.give', playerId: p.id, itemId: sel.value, ...(bonus ? { bonus } : {}) }, `Gave ${it?.name || 'item'}${bonus ? ` +${bonus}` : ''}.`)) closeSheet();
        },
      }, 'Give')),
    );
  }
  openSheet(sponsor ? `Sponsor box for ${p.name}` : `Loot box for ${p.name}`, body, sponsor ? 'var(--magenta)' : 'var(--acid)');
}

/* ---------- rewards: one card per crawler (achievement, loot box, sponsor box, gift) ---------- */

function createRewards() {
  const el = h('div.rewards');
  let sig = '';
  function update(v) {
    const list = v.players || [];
    const recent = [...(v.feed || [])].filter((e) => ['achievement', 'loot', 'sponsor'].includes(e.kind)).reverse().slice(0, 12);
    const s = JSON.stringify([list.map((p) => [p.id, p.name, p.color, p.connected, fullPlayer(p.id)?.gold, fullPlayer(p.id)?.sheet?.portrait ? 1 : 0]), recent.map((e) => e.id || e.at)]);
    if (s === sig) return;
    sig = s;
    const card = (sum) => {
      const p = fullPlayer(sum.id);
      const M = sheetModel(v, p);
      const id = M.sheet.identity || {};
      const btn = (ic, label, fn, cls = '') => h(`button.btn.rw-btn${cls}`, { type: 'button', onclick: () => { buzz(10); fn(); } }, icon(ic, { size: 16 }), label);
      return h('article.rw-card', { style: { '--pc': p.color || 'var(--c-accent)' } },
        h('header.rw-who',
          avatar(id.name || p.name, { color: p.color, src: M.sheet.portrait, size: 40 }),
          h('div', h('b', id.name || p.name), h('span.dim', [[id.race, id.class].filter(Boolean).join(' '), `Lv ${id.level ?? p.level ?? 1}`, `${p.gold ?? 0} gold`].filter(Boolean).join(' · ')))),
        h('div.rw-acts',
          btn('gift', 'Loot box', () => lootSheet(p, false), '.btn-primary'),
          btn('star', 'Sponsor box', () => lootSheet(p, true)),
          btn('sparkle', 'Achievement', () => achievementSheet(p)),
          btn('plus', 'Give from library', () => givePicker(p, sheetModel(view, fullPlayer(p.id))))));
    };
    const kindText = { achievement: 'Achievement', loot: 'Loot', sponsor: 'Sponsor' };
    el.replaceChildren(
      h('div.view-head', h('h1', 'Rewards'), h('span.dim', 'Loot boxes, sponsor boxes, gifts and achievements')),
      list.length ? h('div.rw-grid', list.map(card)) : h('div.empty-state', h('p', h('b', 'No crawlers yet.')), h('p.dim', 'Add them on Party first.')),
      h('section.panel.rw-recent',
        h('h2', 'Handed out lately'),
        recent.length ? h('ol.feed', recent.map((e) => h('li', h('span.k', { class: `k k-${e.kind}`, 'aria-hidden': 'true' }, KIND_GLYPH[e.kind] || '•'), h('div', h('b', `${kindText[e.kind] || e.kind}. `), e.text || '', h('time', timeAgo(e.at))))))
          : h('p.dim', 'Nothing yet this session.')),
    );
  }
  return { el, update };
}

/* ---------- prepared cards (prep.card.*) ---------- */

const PREP_GLYPH = { achievement: '✦', loot: '▣', message: '✉', line: '❝', encounter: '⚔' };
function cardNeedsPlayer(c) {
  return (c.kind === 'achievement' || c.kind === 'loot') && !c.payload?.playerId;
}
function cardDetail(c) {
  const p = c.payload || {};
  const who = p.playerId ? (view.players?.find((x) => x.id === p.playerId)?.name || 'someone') : null;
  if (c.kind === 'achievement') return [p.title || p.achId, who && `for ${who}`].filter(Boolean).join(' ');
  if (c.kind === 'loot') return [(view.pack?.lootTiers?.find((t) => t.id === p.tier)?.name || p.tier), who && `for ${who}`].filter(Boolean).join(' ');
  if (c.kind === 'message') return p.to === 'all' ? `To all: ${p.text}` : `${p.text}`;
  if (c.kind === 'encounter') return (p.mobs || []).map((m) => `${m.count || 1}× ${(view.library?.[m.kind || 'monster'] || []).find((e) => e.id === m.sourceId)?.name || m.sourceId}`).join(', ');
  return p.text || '';
}
let prepSig = '';
function renderPrep() {
  const cards = view.gm?.prepCards || [];
  const wrap = $('#prep');
  wrap.hidden = false;
  const sig = JSON.stringify([cards, view.players?.map((p) => [p.id, p.name])]);
  if (sig === prepSig) return;
  prepSig = sig;
  const open = cards.filter((c) => !c.used).length;
  $('#prep-count').textContent = cards.length ? `${open} ready${cards.length > open ? `, ${cards.length - open} used` : ''}` : 'Get rewards and lines ready before the session';
  $('#prep-cards').replaceChildren(...[...cards].sort((a, b) => Number(a.used) - Number(b.used)).map((c) => h('div.pcardx', { class: `pcardx k-${c.kind}${c.used ? ' used' : ''}` },
    h('button.pc-fire', {
      type: 'button',
      title: c.used ? 'Already used. Tap to fire again.' : 'Fire this card',
      onclick: () => fireCard(c),
    },
    h('span.g', { 'aria-hidden': 'true' }, PREP_GLYPH[c.kind] || '•'),
    h('span.pl', c.label || c.kind),
    h('span.pd', cardDetail(c)),
    ),
    h('button.pc-x', {
      type: 'button',
      'aria-label': `Delete card ${c.label}`,
      onclick: async () => { if (await ask(`Delete the card "${c.label}"?`, { ok: 'Delete', danger: true })) act({ t: 'prep.card.remove', id: c.id }, 'Card deleted.'); },
    }, '✕'),
  )));
}
/** New prepared card: achievement, loot box, message, a System line (encounters are saved from Fight). */
function newPrepCard() {
  const kinds = [['achievement', 'Achievement'], ['loot', 'Loot box'], ['message', 'Message'], ['line', 'System line']];
  let kind = 'achievement';
  const ps = view.players || [];
  const tiers = view.pack?.lootTiers || [];
  const label = field('', { placeholder: 'Short name on the card' });
  const title = field('', { placeholder: 'Achievement title' });
  const desc = field('', { multiline: true, rows: 2, placeholder: 'What they did (read aloud)' });
  const text = field('', { multiline: true, rows: 3, placeholder: 'The text' });
  const who = select([{ value: '', label: 'Pick when firing' }, ...ps.map((p) => ({ value: p.id, label: p.name }))], '');
  const toAll = select([{ value: 'all', label: 'Everyone' }, ...ps.map((p) => ({ value: p.id, label: p.name }))], 'all');
  const tier = select(tiers.map((t) => ({ value: t.id, label: t.name })), tiers[0]?.id || '');
  const body = h('div.form-grid');
  const seg = h('div.seg.span-all', kinds.map(([id, l]) => h('button', { type: 'button', 'aria-pressed': String(id === kind), onclick: () => { kind = id; for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.k === kind)); draw(); }, 'data-k': id }, l)));
  const draw = () => body.replaceChildren(seg, labeled('Card name', label, { cls: 'span-all' }),
    ...(kind === 'achievement' ? [labeled('Title', title), labeled('For', who), labeled('Description', desc, { cls: 'span-all' })]
      : kind === 'loot' ? [labeled('Box', tier), labeled('For', who)]
        : kind === 'message' ? [labeled('To', toAll), labeled('Text', text, { cls: 'span-all' })]
          : [labeled('The System says', text, { cls: 'span-all' })]));
  draw();
  openDrawer({ title: 'New prepared card', sub: 'One tap fires it during the session.', body,
    actions: [h('button.btn.btn-primary', { type: 'button', onclick: async () => {
      const pid = who.value || undefined;
      const payload = kind === 'achievement' ? { title: title.value.trim(), desc: desc.value.trim(), ...(pid ? { playerId: pid } : {}) }
        : kind === 'loot' ? { tier: tier.value, ...(pid ? { playerId: pid } : {}) }
          : kind === 'message' ? { to: toAll.value === 'all' ? 'all' : [toAll.value], text: text.value.trim() }
            : { text: text.value.trim() };
      if ((kind === 'achievement' && !payload.title) || ((kind === 'message' || kind === 'line') && !payload.text)) { toast('Fill in the text first.', { error: true }); return; }
      const name = label.value.trim() || payload.title || (kind === 'loot' ? tiers.find((t) => t.id === payload.tier)?.name : payload.text?.slice(0, 40)) || kind;
      if (await act({ t: 'prep.card.add', kind, label: name.slice(0, 80), payload }, 'Card ready.')) closeDrawer();
    } }, 'Save card')] });
}
$('#prep-new')?.addEventListener('click', newPrepCard);

function fireCard(c) {
  if (!cardNeedsPlayer(c)) { act({ t: 'prep.card.fire', id: c.id }, `Fired: ${c.label}.`); return; }
  const players = view.players || [];
  openSheet(`Who gets "${c.label}"?`, h('div.tier-grid', players.map((p) => h('button.tier', {
    type: 'button',
    style: { '--t': p.color || 'var(--cyan)' },
    onclick: async () => { if (await act({ t: 'prep.card.fire', id: c.id, playerId: p.id }, `Fired: ${c.label} for ${p.name}.`)) closeSheet(); },
  }, p.name))), 'var(--acid)');
}

/* ---------- comms ---------- */

const selected = new Set(['all']);
const commsText = $('#comms-text');
const commsFrom = $('#comms-from');
const commsTv = $('#comms-tv');

function systemName() { return view?.pack?.systemName || 'The System'; }

function openComms(ids) {
  if (ids) {
    selected.clear();
    ids.forEach((id) => selected.add(id));
    renderChips();
  }
  const c = $('#comms');
  const col = c.closest('.col');
  if (col && getComputedStyle(col).overflowY === 'auto') {
    col.scrollTo({ top: c.offsetTop - col.offsetTop - 12, behavior: 'smooth' });
  } else {
    c.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash');
  setTimeout(() => commsText.focus({ preventScroll: true }), 250);
}

let chipSig = '';
function renderChips() {
  const ps = view?.players || [];
  for (const id of [...selected]) if (id !== 'all' && !ps.some((p) => p.id === id)) selected.delete(id);
  if (!selected.size) selected.add('all');
  const sig = JSON.stringify([ps.map((p) => [p.id, p.name, p.color]), [...selected]]);
  if (sig === chipSig) return;
  chipSig = sig;
  const chip = (id, label, color, cls = '') => h('button.chip', {
    type: 'button',
    class: `chip${cls}`,
    'aria-pressed': String(selected.has(id)),
    style: color ? { '--cc': color } : null,
    onclick: () => {
      buzz(8);
      if (id === 'all') { selected.clear(); selected.add('all'); }
      else {
        selected.delete('all');
        selected.has(id) ? selected.delete(id) : selected.add(id);
        if (!selected.size) selected.add('all');
      }
      renderChips();
    },
  }, label);
  $('#chips').replaceChildren(
    chip('all', 'All crawlers', null, ' all'),
    ...ps.map((p) => chip(p.id, p.name, p.color)),
  );
  // Server: a message to all, or to more than one player, is a group message; only those can go on the TV.
  const group = selected.has('all') || selected.size > 1;
  commsTv.disabled = !group;
  if (!group) commsTv.checked = false;
  $('#tv-wrap').classList.toggle('off', !group);
  $('#comms-send').textContent = selected.has('all') ? 'Send to all' : selected.size === 1 ? 'Send private' : `Send to ${selected.size}`;
}

function renderComms() {
  renderChips();
  if (!commsFrom.value && document.activeElement !== commsFrom) commsFrom.placeholder = `From: ${systemName()}`;
  const list = [...(view.gm?.messages || [])].reverse().slice(0, 40);
  const hist = $('#msg-history');
  const sig = JSON.stringify(list);
  if (hist.dataset.sig === sig) return;
  hist.dataset.sig = sig;
  const nameOf = (id) => view.players?.find((p) => p.id === id)?.name || 'someone';
  hist.replaceChildren(...(list.length ? list.map((m) => {
    const to = m.to;
    const group = m.group ?? (to === 'all' || (Array.isArray(to) && to.length > 1));
    const ids = Array.isArray(to) ? to : (typeof to === 'string' && to !== 'all' ? [to] : (m.playerId ? [m.playerId] : []));
    const readBy = Array.isArray(m.readBy) ? m.readBy.length : null;
    return h('li', { class: group ? 'grp' : 'prv' },
      h('div.mh',
        h('span.to', to === 'all' ? 'To all crawlers' : `To ${ids.map(nameOf).join(', ')}`),
        h('span', `from ${m.from || systemName()}`),
        m.onStage ? h('span.tvflag', 'on TV') : null,
        h('span', timeAgo(m.at)),
        readBy != null ? h('span.rd', `read ${readBy}/${to === 'all' ? (view.players?.length ?? 0) : ids.length}`) : null,
      ),
      h('div.tx', m.text),
    );
  }) : [h('li', h('div.tx.dim', 'No messages yet. Pick who gets it above.'))]));
}

$('#comms-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = commsText.value.trim();
  if (!text) { commsText.focus(); return; }
  const all = selected.has('all');
  const a = { t: 'msg.send', to: all ? 'all' : [...selected], text };
  if (commsFrom.value.trim()) a.from = commsFrom.value.trim();
  if (!commsTv.disabled && commsTv.checked) a.onStage = true;
  const who = all ? 'everyone' : [...selected].map((id) => view.players?.find((p) => p.id === id)?.name).join(', ');
  if (await act(a, `Sent to ${who}.`)) {
    commsText.value = '';
    commsTv.checked = false;
  }
});
commsText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#comms-form').requestSubmit(); }
});

/* ---------- audience / feed / links ---------- */

let shownViewers = 0;
let viewersRaf = 0;
function renderAudience() {
  const a = view.audience || {};
  const target = Number(a.viewers) || 0;
  cancelAnimationFrame(viewersRaf);
  const from = shownViewers;
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 700);
    shownViewers = Math.round(from + (target - from) * (1 - (1 - k) ** 3));
    $('#viewers').textContent = fmtNum(shownViewers);
    if (k < 1) viewersRaf = requestAnimationFrame(step);
  };
  viewersRaf = requestAnimationFrame(step);
  const hype = Math.max(0, Math.min(1, Number(a.hype) || 0));
  $('#hype').style.width = `${hype * 100}%`;
  $('#hype-label').textContent = `hype ${Math.round(hype * 100)}%`;
  $('#sponsor-ready').hidden = !(view.gm?.sponsorReady || a.sponsorReady);
}

const KIND_GLYPH = { achievement: '✦', loot: '▣', sponsor: '$', secret: '✉', stat: '±', level: '▲', crawlers: '☠' };
function renderFeed() {
  const feed = [...(view.feed || [])].reverse().slice(0, 30);
  $('#feed').replaceChildren(...(feed.length ? feed.map((e) => h('li',
    h('span.k', { class: `k k-${e.kind}`, 'aria-hidden': 'true' }, KIND_GLYPH[e.kind] || '•'),
    h('div', e.text || e.kind, h('time', timeAgo(e.at))),
  )) : [h('li', h('span.k', '·'), h('div.dim', 'Nothing has happened yet. Award something.'))]));
}

function renderLinks() {
  const gm = view.gm || {};
  if (gm.joinUrl) {
    const a = $('#join-url');
    if (a.href !== gm.joinUrl) {
      a.href = gm.joinUrl;
      a.textContent = gm.joinUrl;
      $('#qr').src = `/qr?text=${encodeURIComponent(gm.joinUrl)}`;
    }
  }
  if (gm.stageUrl) $('#stage-url').href = gm.stageUrl;
}

/* ---------- top bar + forms ---------- */

function toggleAuto() {
  if (view?.session?.aiMute) { toast('AI is muted: unmute it first.'); return; }
  const on = !view?.session?.auto;
  act({ t: 'session.auto', on }, on ? 'AUTO is on.' : 'AUTO is off.');
}
/** One panic button: the System's voice queue and every sound pad. */
function stopAll() {
  buzz([20, 30, 20]);
  try { sound?.board?.stopAll(); } catch {}
  try { cues?.stopAmbience(); } catch {} // stays off until Play in Show → Explore
  act({ t: 'queue.clear' }, 'Stopped: voice queue cleared, pads silenced.');
}

$('#auto').addEventListener('click', toggleAuto);
$('#ai-mute').addEventListener('click', () => {
  const on = !view?.session?.aiMute;
  act({ t: 'session.aiMute', on }, on ? 'AI muted: text only, no chat, AUTO off.' : 'AI is back on.');
});
$('#stop').addEventListener('click', stopAll);
/** Panic: TV on stand-by, all sound off, countdown paused, AUTO off. Same key / button again resumes. */
function toggleHold() {
  const on = !view?.session?.hold;
  if (on) stopAll();
  act({ t: 'session.hold', on }, on ? 'HOLD: TV on stand-by, sound off, countdown paused, AUTO off.' : 'Back on air.');
}
$('#hold').addEventListener('click', toggleHold);
$('#mode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (b) act({ t: 'session.mode', mode: b.dataset.mode }, `Mode: ${b.textContent}.`);
});
$('#voice').addEventListener('change', (e) => {
  act({ t: 'session.voice', voice: e.target.value }, `Voice: ${e.target.selectedOptions[0]?.textContent}.`);
});
document.querySelectorAll('[data-budget]').forEach((b) => b.addEventListener('click', () => {
  const v = Math.max(0, (view?.session?.budgetLeft ?? 0) + Number(b.dataset.budget));
  act({ t: 'session.budget', value: v }, `Auto budget: ${v}.`);
}));
document.querySelectorAll('[data-bump]').forEach((b) => b.addEventListener('click', () => {
  act({ t: 'audience.bump', delta: Number(b.dataset.bump) });
}));


const sayText = $('#say-text');
$('#say').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = sayText.value.trim();
  if (!text) return;
  if (await act({ t: 'say', text }, 'Saying it now.')) sayText.value = '';
});
sayText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#say').requestSubmit(); }
});

$('#copy-stage').addEventListener('click', async () => {
  const url = view?.gm?.stageUrl;
  if (!url) return;
  try { await navigator.clipboard.writeText(url); toast('Stage link copied.'); } catch { toast(url, { ms: 8000 }); }
});

$('#new-session').addEventListener('click', async () => {
  if (await ask('Start a new session? The current one is archived. Players and inventories stay.', { ok: 'Start new session' })) {
    act({ t: 'session.new' }, 'New session started.');
  }
});

/* ---------- views, settings, dice log ---------- */

const VIEWS = ['party', 'prep', 'show', 'library', 'rewards', 'messages', 'settings'];
// Old section names (links, saved tabs): they live inside Show now.
const INTO_SHOW = { combat: 'fight', npcs: 'npc', campaign: 'desk' };
let currentView = 'party';
const deskTrail = [];
let deskIndex = -1;
const backButton = $('#desk-back');
const forwardButton = $('#desk-forward');
const mapNavToggle = $('#map-nav-toggle');
const deskSections = $('#gm-nav');
mapNavToggle.prepend(icon('log'));
backButton.append(icon('back'));
forwardButton.append(icon('chevron'));
$('#desk-home').append(icon('home'));

function toggleMapNavigation(open) {
  document.body.classList.toggle('map-nav-open', open);
  mapNavToggle.setAttribute('aria-expanded', String(open));
}
mapNavToggle.onclick = () => {
  const open = mapNavToggle.getAttribute('aria-expanded') !== 'true';
  toggleMapNavigation(open);
  if (open) (deskSections.querySelector('[aria-current="page"]') || deskSections.querySelector('button'))?.focus();
};
document.addEventListener('pointerdown', (e) => {
  if (mapNavToggle.getAttribute('aria-expanded') === 'true' && !deskSections.contains(e.target) && !mapNavToggle.contains(e.target)) toggleMapNavigation(false);
});
deskSections.addEventListener('focusout', (e) => {
  if (!deskSections.contains(e.relatedTarget) && !mapNavToggle.contains(e.relatedTarget)) toggleMapNavigation(false);
});

function recordDesk() {
  const tab = currentView === 'show' ? scenes.currentTab() : null;
  const onMap = tab === 'map';
  document.body.classList.toggle('desk-map', onMap);
  mapNavToggle.hidden = !onMap;
  if (!onMap) toggleMapNavigation(false);
  const last = deskTrail[deskIndex];
  if (last?.view !== currentView || last.tab !== tab) {
    deskTrail.splice(++deskIndex, Infinity, { view: currentView, tab });
  }
  backButton.disabled = deskIndex <= 0;
  forwardButton.disabled = deskIndex >= deskTrail.length - 1;
}

function revisit(index) {
  const route = deskTrail[index];
  if (!route) return;
  deskIndex = index;
  showView(route.view);
  if (route.tab) scenes.pick(route.tab);
  $('.gm-main').scrollTop = 0;
  recordDesk();
}
backButton.onclick = () => revisit(deskIndex - 1);
forwardButton.onclick = () => revisit(deskIndex + 1);
$('#desk-home').onclick = () => {
  showView('show');
  scenes.pick('lobby');
  $('.gm-main').scrollTop = 0;
};
function showView(v) {
  if (INTO_SHOW[v]) { const sub = INTO_SHOW[v]; showView('show'); scenes.pick(sub); return; }
  if (!VIEWS.includes(v)) v = 'party';
  currentView = v;
  queueMicrotask(recordDesk);
  for (const b of document.querySelectorAll('#gm-nav [data-view], #gm-bnav [data-view]')) {
    if (b.dataset.view === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  for (const id of VIEWS) $(`#view-${id}`).hidden = id !== v;
  document.body.dataset.desk = v; // not data-view: [data-view] means a nav button
  msgCenter?.setVisible(v === 'messages');
  try { sessionStorage.setItem('system.gmView', v); } catch {}
}
// Both navs: the button carries data-view (closest() on the button only, never the page).
for (const nav of [$('#gm-nav'), $('#gm-bnav')]) {
  nav.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b || !nav.contains(b)) return;
    showView(b.dataset.view);
    if (mapNavToggle.getAttribute('aria-expanded') === 'true') {
      if (b.dataset.view === 'show') mapNavToggle.focus();
      toggleMapNavigation(false);
    }
    $('.gm-main').scrollTop = 0;
  });
}
export { showView };

const diceLog = createDiceLog({
  gm: true,
  onCustomRoll: async (formula, secret) => {
    try {
      const r = await client.send({ t: 'roll', what: { kind: 'custom', formula, label: formula }, secret });
      if (r?.result?.roll) showRollCard(r.result.roll);
    } catch (err) { toast(err.message, { error: true }); throw err; }
  },
});
$('#gm-log').append(h('button.btn.btn-quiet.log-close', { type: 'button', onclick: () => setLog(false) }, icon('x', { size: 16 }), 'Close dice log'), diceLog.el);
onLocalRoll(() => renderLog());
function renderLog() {
  if (!view) return;
  drawLogBadge();
  const rolls = [...(view.rolls || []), ...localRolls].sort((a, b) => (a.at || 0) - (b.at || 0));
  diceLog.update({ ...view, rolls }, null);
}
// Closed by default (11/2026, "log2" resets older saved choices): rolls still pop as cards, and the button
// counts the rolls that came in while it was closed.
const logPref = () => { try { return localStorage.getItem('system.gm.log2'); } catch { return null; } };
let logSeen = null; // set on the first view, so old rolls do not count as new
const rollCount = () => (view?.rolls?.length || 0) + localRolls.length;
function setLog(open, remember = window.innerWidth >= 760) {
  document.body.classList.toggle('log-closed', !open);
  $('#log-toggle').setAttribute('aria-expanded', String(open));
  if (open) logSeen = rollCount();
  drawLogBadge();
  if (remember) try { localStorage.setItem('system.gm.log2', open ? '1' : '0'); } catch {}
}
function drawLogBadge() {
  const btn = $('#log-toggle');
  const open = !document.body.classList.contains('log-closed');
  if (open || (logSeen === null && view)) logSeen = rollCount();
  const n = open || logSeen === null ? 0 : Math.max(0, rollCount() - logSeen);
  btn.replaceChildren(icon('dice', { size: 15 }), h('span.log-l', 'Dice log'), n ? h('span.log-badge', { 'aria-label': `${n} new` }, String(n > 99 ? '99+' : n)) : '');
}
$('#log-toggle').addEventListener('click', () => setLog(document.body.classList.contains('log-closed')));
setLog(window.innerWidth >= 760 && logPref() === '1', false);

const themeBtn = $('#theme-btn');
const drawTheme = () => {
  const t = document.documentElement.dataset.theme || 'dark';
  themeBtn.replaceChildren(icon(t === 'light' ? 'sparkle' : t === 'neon' ? 'moon' : 'sun', { size: 16 }) /* icon = the next theme */);
  for (const b of document.querySelectorAll('#theme-seg [data-theme-pick]')) b.setAttribute('aria-checked', String(b.dataset.themePick === t));
};
themeBtn.addEventListener('click', () => { toggleTheme(); drawTheme(); });
$('#theme-seg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme-pick]');
  if (b) { setTheme(b.dataset.themePick); drawTheme(); }
});
applyTheme();
drawTheme();

const PERM_HINT = {
  none: 'Players can only roll and read. Their sheet shows a lock.',
  notes: 'Players can write their story, notes and mark skills used, and track their own health and mana.',
  sheet: 'Players can edit their whole sheet: stats, skills, attacks, gear. Buffs and gifts stay with you.',
};
function renderSettings() {
  const lvl = playerEditLevel(view);
  for (const b of document.querySelectorAll('#perm-seg [data-perm]')) b.setAttribute('aria-checked', String(b.dataset.perm === lvl));
  $('#perm-hint').textContent = PERM_HINT[lvl];
  $('#perm-origins').checked = !!view.session?.permissions?.allowOrigins;
}
$('#perm-origins').addEventListener('change', (e) => {
  act({ t: 'session.permissions', allowOrigins: e.target.checked }, e.target.checked ? 'Players may now ask for race and class.' : 'Race and class are yours to set.');
});
$('#perm-seg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-perm]');
  if (b) act({ t: 'session.permissions', playerEdit: b.dataset.perm }, `Player editing: ${b.textContent}.`);
});

function renderCampaign() {
  const r = $('#node-recap');
  if (r && document.activeElement !== r && !r.dataset.dirty) r.value = view.recap || '';
}
$('#node-recap').addEventListener('input', (e) => { e.target.dataset.dirty = '1'; });
$('#node-recap-show').addEventListener('click', async () => {
  const r = $('#node-recap');
  if (await act({ t: 'session.recap', text: r.value.trim() }, 'Recap shown.')) delete r.dataset.dirty;
});
$('#node-recap-clear').addEventListener('click', async () => {
  const r = $('#node-recap');
  r.value = '';
  if (await act({ t: 'session.recap', text: '' }, 'Recap cleared.')) delete r.dataset.dirty;
});

$('#add-player-btn').addEventListener('click', showAddPlayer);
$('#rank-up').addEventListener('click', () => rankUp('session'));
$('#rank-up-floor').addEventListener('click', () => rankUp('floor'));

const library = createLibrary({
  send: (a) => client.send(a),
  act,
  getView: () => view,
  getCredential: () => ext.credential,
  aiDraft: (...args) => ext.libraryDraft?.(...args),
  hasAi: () => !!ext.libraryDraft,
});
$('#view-library').append(library.el);
// Show = the broadcast switcher (gm-scenes.js): scenes, the fight tracker, NPCs, sound and the old desk.
// Hoisted use in render() is safe: views arrive after boot.
const scenes = createScenes({ client, act, onPick: () => queueMicrotask(() => { recordDesk(); if (view) combat.update(view); }), getView: () => view, getCues: () => cues, chooseAttack: (uid, index) => combat.chooseAttack(uid, index) });
scenes.audio.credential = () => ext.credential; // the audio fetches use the desk's login
const sound = createSound({ client, act, getView: () => view, audio: scenes.audio });
// Combat sounds: combat events play pads on this desk by themselves (in step with the TV cinematic).
// Sound cues (cues.js): voice lines, boss moments, location ambience; mobs use their own Library sounds.
const cues = createCues({ board: sound.board, getView: () => view, act: (a) => client.send(a).catch(() => {}), onChange: () => scenes.refresh?.() });
const combatSfx = createCombatSfx({ board: sound.board, getView: () => view, onChange: () => combat?.update(view), mobSound: (slot, uid) => cues.mob(slot, uid) });
sound.el.append(combatSfx.panel(), cues.panel());
client.on('play', (m) => { if (scenes.audio.isDevice) cues.line(m); });
client.on('view', (v) => cues.scene(v));
window.__cues = cues;
const openSound = () => {
  showView('show');
  scenes.pick('sound');
  requestAnimationFrame(() => document.getElementById('combat-sounds')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
};
const combat = createCombat({ act, addPlayer: showAddPlayer, getView: () => view, send: (a) => client.send(a), sfx: combatSfx, openSound, goLive: () => scenes.goLive('fight'), currentMap: () => scenes.currentMap() });
$('#view-settings .settings-grid').append(sound.settingsEl);
const npcs = createNpcs({ act, getView: () => view, openInLibrary: (kind, id) => { showView('library'); library.open(kind, id); } });
// The campaign panel ("Previously on…", plus the hosted edition's extras) lives in Show → Desk.
const campaignBox = $('#view-campaign');
campaignBox.hidden = false;
campaignBox.classList.remove('gm-view');
campaignBox.prepend(h('h2.desk-sec', 'Campaign'));
// Crawlers remaining (gm-crawlers.js): a live badge in the Show bar + the Crawlers tool.
const crawlers = createCrawlers({ act, getView: () => view, open: () => { showView('show'); scenes.pick('crawlers'); } });
// Příprava (gm-prep.js): adventures + session plans; pinned items wait "within reach" in the Show bar.
const prep = createPrep({ act, getView: () => view, getCredential: () => ext.credential, scenes, showView: (v) => showView(v), openInLibrary: (kind, id) => { showView('library'); library.open(kind, id); } });
$('#view-prep').append(prep.el);
// Maps with fog (gm-maps.js): Show → Map chip.
const maps = createMaps({ act, getView: () => view, getCredential: () => ext.credential, scenes, showView: (v) => showView(v) });
scenes.mountInto($('#view-show'), { maps: maps.el, mapEditor: maps, fight: combat.el, npcs: npcs.el, sound: sound.el, deskExtra: campaignBox, crawlers: crawlers.el, crawlersBadge: crawlers.badge, reach: prep.reach });
const rewards = createRewards();
$('#view-rewards').append(rewards.el);
// Message centre: every conversation with the crawlers (private lines, groups, everyone); unread badge in the nav.
var msgCenter = createMsgCenter({
  role: 'gm',
  send: (a) => client.send(a),
  getView: () => view,
  onUnread: (n) => { for (const id of ['#msg-badge', '#msg-badge-b']) { const b = $(id); if (b) { b.hidden = !n; b.textContent = n > 99 ? '99+' : String(n); } } },
});
$('#view-messages').append(h('div.view-head', h('h1', 'Messages')), msgCenter.el);

$('#hud-crawlers')?.addEventListener('change', (e) => act({ t: 'crawlers.set', shown: e.target.checked }, e.target.checked ? 'Counter on the TV.' : 'Counter hidden.'));

/* ---------- keyboard ---------- */

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && e.shiftKey) { e.preventDefault(); toggleHold(); return; }
  if (e.key === 'Escape') {
    if (sheet.open || drawerOpen() || document.querySelector('dialog[open]')) return; // dialogs close first
    e.preventDefault();
    if (mapNavToggle.getAttribute('aria-expanded') === 'true') {
      mapNavToggle.focus();
      toggleMapNavigation(false);
      return;
    }
    stopAll();
    return;
  }
  // Ctrl+Z / Cmd+Z: undo the latest recoverable fight edit or hit.
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyZ' && !e.target.closest?.('input, textarea, select, [contenteditable]')) {
    if (sheet.open || drawerOpen() || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    const c = view?.combat;
    const newest = [
      c?.rx?.canUndo && { at: c.rx.undoAt ?? 0, action: { t: 'rx.resolveNext', op: 'undo' }, notice: 'Last hit undone.' },
      c?.lastAutoUndo && { at: c.lastAutoUndo.at ?? 0, action: { t: 'combat.autoUndo' }, notice: 'Last hit undone.' },
      c?.manualUndo && { at: c.manualUndo.at ?? 0, action: { t: 'combat.undo' }, notice: `Undone: ${c.manualUndo.label}` },
    ].filter(Boolean).sort((a, b) => b.at - a.at)[0];
    if (newest) act(newest.action, newest.notice);
    else toast('Nothing to undo in the fight.');
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t.closest?.('input, textarea, select, [contenteditable]') || sheet.open || drawerOpen()) return;
  if (e.key === '/') { e.preventDefault(); showView('library'); library.focusSearch(); return; }
  // Quip number keys work on every view (the show's signature should never be a tab away); A / M stay on Show.
  if (currentView === 'show' && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); toggleAuto(); return; }
  if (currentView === 'show' && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); openComms(); return; }
  // Physical keys (e.code) so the number row works on Czech/other layouts; Shift+digits belong to the SFX pads.
  const qDigit = !e.shiftKey && /^(Digit|Numpad)[1-9]$/.test(e.code) ? Number(e.code.slice(-1)) : 0;
  if (qDigit) {
    const cats = view?.gm?.quipCategories || [];
    const c = cats[qDigit - 1];
    if (c && c.total !== 0) {
      e.preventDefault();
      playQuip(c, document.querySelectorAll('#quips .quip')[Number(e.key) - 1]);
    }
  }
});

/* ---------- boot ---------- */

/** Attach a transport and start. Used by both editions. */
export function mountGm(transport, opts = {}) {
  ext.hosted = !!opts.hosted;
  document.body.classList.toggle('hosted', ext.hosted);
  let v = 'party';
  try { v = sessionStorage.getItem('system.gmView') || 'party'; } catch {}
  showView(v);
  client.attach(transport);
  transport.connect?.();
  return { client, render: () => render(), view: () => view, showView };
}

if (!isHosted()) {
  const token = takeHashToken('system.gmToken');
  if (token) {
    ext.credential = { token };
    mountGm(new SystemClient({ hello: () => ({ role: 'gm', token }) }));
  } else {
    // No #token: log in with the GM key (Cloudflare edition, or Node with GM_KEY set).
    import('./gmlogin.js').then(({ bootKeyLogin }) => bootKeyLogin({ ext, mountGm, SystemClient }));
  }
  registerSW();
}
