import { initI18n, langButton, setLang, getLang, addTranslations } from './i18n.js';
import { marksEl } from './marks.js';
import {
  SystemClient, TransportHub, store, buzz, h, toast, itemArt, fmtNum, timeAgo, rarityOf,
  prefersReducedMotion, registerSW, isHosted, ask, portraitSrc,
} from './client.js';
import { createSheet, localRolls, onLocalRoll, markNewItem } from './sheet.js';
import { createMapView } from './map-view.js';
import { combatBlocked, createRxPhone, reactionControls } from './rx-phone.js';
import { openBuilder as openPlainBuilder } from './builder.js';
import { openCreator, hasCreator } from './creator.js';
// Rulesets with guided creation (ruleset.creation) get the step-by-step creator; others the plain builder.
const openBuilder = (o) => (hasCreator(o.model) ? openCreator(o) : openPlainBuilder(o));
import { createDiceLog, showRollCard } from './dicelog.js';
import { icon, applyTheme, toggleTheme, applyAccent, applyPackTheme, openDrawer, closeDrawer, dieFaces, spellCooldownHint } from './ui.js';
import { playerEditLevel } from './rules.js';
import { crawlerClock, fmtFull, fmtCompact, skullSvg } from './crawlers.js';
import { createMsgCenter, threadKey } from './msgcenter.js';
import { createRollPad } from './rollpad.js';
import { openLevelUp, pendingLevelActions } from './level-up.js';

initI18n({ slots: ['.lang-slot'] });

const $ = (s, r = document) => r.querySelector(s);
const KEY = 'system.player';
const phoneMapViews = new Map();
let phoneMapsEl;
let phoneMapsSig = '';

/* ---------- room + PIN ---------- */

const params = new URLSearchParams(location.search);
const invitedCampaign = params.get('campaign');
let saved = {};
try { saved = JSON.parse(store.get('localStorage', KEY) || '{}') || {}; } catch { saved = {}; }
let room = (params.get('room') || saved.room || '').toUpperCase();
let pin = saved.room === room ? (saved.pin || '') : '';
let entry = '';
// Personal link: /p/<token> (QR from the GM). Stored so "Add to Home Screen" (start_url /play) still works.
const TOKEN_KEY = 'system.playerToken';
const pathToken = (/^\/p\/([A-Za-z0-9_-]{16,128})\/?$/.exec(location.pathname) || [])[1] || '';
let token = pathToken;
let campaign = null;
let claimCampaignId;
let claimName = ''; // set while asking the GM to let us in
let cloud = false; // server has no room/PIN login (Cloudflare edition)

const client = new TransportHub();
/** Hosted edition hooks: notes storage and read-state live outside the engine there. */
export const ext = { hosted: false, saveNotes: null };

let view = null;
let me = null;
let everJoined = false;
let resumeFight = false;
let routedFight = null;
let routedTargets = new Set();

function remember(campaignName) {
  store.set('localStorage', KEY, JSON.stringify({ room, pin, campaignName }));
  if (token) store.set('localStorage', TOKEN_KEY, token);
}
function forget() {
  store.del('localStorage', KEY);
  store.del('localStorage', TOKEN_KEY);
  token = '';
}

function showClaim(err = '', waiting = false) {
  const wrongInvite = invitedCampaign && campaign && invitedCampaign !== campaign.id;
  $('#join-returning').hidden = true;
  $('#claim').hidden = false;
  $('#join').hidden = true;
  $('#app').hidden = true;
  $('#reconnect').hidden = true;
  $('#claim-title').textContent = campaign?.name ? `Join ${campaign.name}` : 'Join the game';
  $('#claim-form').hidden = waiting || !!wrongInvite;
  $('#claim-wait').hidden = !waiting;
  $('#claim-pin').hidden = cloud || !!wrongInvite;
  $('#claim-current').hidden = !wrongInvite;
  $('#claim-err').textContent = wrongInvite ? 'This invitation is for a different campaign.' : err;
  if (!waiting && !wrongInvite) setTimeout(() => $('#claim-name').focus(), 50);
}

function claimChars(list, targetCampaign) {
  if (targetCampaign) {
    campaign = targetCampaign;
    claimCampaignId = targetCampaign.id;
    showClaim('', true);
  }
  let picked = null;
  const draw = () => $('#claim-chars').replaceChildren(...list.map((c) => h('button.claim-char', {
    type: 'button', style: { '--cc': c.color }, 'aria-pressed': String(picked === c.id),
    onclick: () => { picked = c.id; client.raw({ t: 'claim.pick', playerId: c.id }); draw(); buzz(8); },
  }, h('span.cdot', { 'aria-hidden': 'true' }), c.name, c.connected ? h('small', 'already playing') : null)));
  draw();
  $('#claim-existing').hidden = !list.length;
  $('#claim-status').textContent = 'Waiting for the GM to let you in.';
}

function showJoin(err = '') {
  if (cloud) return showClaim(err);
  $('#join-returning').hidden = true;
  $('#claim').hidden = true;
  $('#join').hidden = false;
  $('#app').hidden = true;
  $('#reconnect').hidden = true;
  $('#pin-title').textContent = campaign?.name ? `Join ${campaign.name}` : 'Join the game';
  $('#room-input').value = room;
  $('#join-err').textContent = err;
  entry = '';
  drawDots();
  if (err) {
    const d = $('#pin-dots');
    d.classList.remove('bad');
    void d.offsetWidth;
    d.classList.add('bad');
  }
  if (!room) setTimeout(() => $('#room-input').focus(), 50);
}

function drawDots() {
  [...$('#pin-dots').children].forEach((s, i) => s.classList.toggle('on', i < entry.length));
  $('#pin-dots').setAttribute('aria-label', `${entry.length} of 4 digits entered`);
}

function pressKey(k) {
  buzz(8);
  $('#join-err').textContent = '';
  $('#pin-dots').classList.remove('bad');
  if (k === 'back') entry = entry.slice(0, -1);
  else if (k === 'clear') entry = '';
  else if (entry.length < 4) entry += k;
  drawDots();
  if (entry.length === 4) submitPin();
}

function submitPin() {
  room = $('#room-input').value.trim().toUpperCase();
  if (!room) {
    $('#join-err').textContent = 'Type the room code from the TV first.';
    entry = '';
    drawDots();
    $('#room-input').focus();
    return;
  }
  pin = entry;
  $('#pin-dots').classList.add('busy');
  client.retry();
}

$('#keypad').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-k]');
  if (b) pressKey(b.dataset.k);
});
document.addEventListener('keydown', (e) => {
  if ($('#join').hidden || e.target === $('#room-input')) return;
  if (/^\d$/.test(e.key)) pressKey(e.key);
  else if (e.key === 'Backspace') pressKey('back');
});
$('#room-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
});

$('#claim-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#claim-name').value.trim();
  if (!name) return;
  claimName = name;
  claimCampaignId = invitedCampaign || campaign?.id;
  showClaim('', true);
  $('#claim-chars').replaceChildren();
  $('#claim-existing').hidden = true;
  $('#claim-status').textContent = 'Asking the GM.';
  client.retry();
});
$('#claim-cancel').addEventListener('click', () => {
  claimName = '';
  client.close();
  showClaim();
});
$('#claim-pin').addEventListener('click', () => { claimName = ''; client.close(); $('#claim').hidden = true; showJoin(); });
$('#join-claim').addEventListener('click', () => { client.close(); showClaim(); });

client.on('message', (m) => {
  if (m.t === 'claim') claimChars(m.characters || [], m.campaign);
  else if (m.t === 'token' && typeof m.token === 'string') {
    // The GM let us in: from now on this phone uses the personal link.
    token = m.token;
    claimName = '';
  }
});

function openAnotherCampaign() {
  forget();
  room = '';
  pin = '';
  claimName = '';
  everJoined = false;
  client.close();
  location.assign('/join');
}

$('#leave').addEventListener('click', async () => {
  if (await ask('Switch campaign on this phone? You can return with your QR code or PIN.', { ok: 'Switch campaign' })) openAnotherCampaign();
});

/* ---------- connection ---------- */

client.on('status', (s) => {
  $('#pin-dots').classList.toggle('busy', s.status === 'connecting' && !everJoined);
  if (s.status === 'open') {
    $('#reconnect').hidden = true;
    return;
  }
  if (s.status === 'rejected') {
    const hadToken = !!token;
    const asked = !!claimName;
    const storedToken = store.get('localStorage', TOKEN_KEY);
    if ((hadToken && token === storedToken) || (!hadToken && !asked && room === saved.room && pin === saved.pin)) forget();
    else token = '';
    pin = '';
    claimName = '';
    if (location.pathname.startsWith('/p/')) history.replaceState(null, '', '/join');
    if (s.code === 'campaign_changed') {
      everJoined = false;
      loadJoinInfo().then(() => showClaim('The GM switched campaigns. Check the campaign name and ask again.'));
      return;
    }
    const msg = s.code === 'removed'
      ? 'The GM removed you from this game. Ask them for a new QR code.'
      : s.code === 'relinked'
      ? 'The GM made a new link for your crawler. Scan the new QR code.'
      : s.code === 'denied'
      ? 'The GM said no. Check your name and ask again.'
      : hadToken && s.code === 'bad_auth'
      ? 'This link does not work any more. Ask your GM for your QR code.'
      : s.code === 'rate_limited' && (hadToken || cloud)
      ? 'Too many tries from this network. Wait a minute.'
      : s.code === 'rate_limited'
      ? 'Too many wrong PINs. Wait a minute, then try again.'
      : s.code === 'not_found' ? 'That room does not exist. Check the code on the TV.'
        : 'Wrong PIN. Ask your GM.';
    everJoined = false;
    if (hadToken || asked || cloud) showClaim(msg);
    else showJoin(msg);
    return;
  }
  if (everJoined && (s.status === 'closed' || s.status === 'connecting')) {
    $('#reconnect').hidden = false;
    $('#reconnect-msg').textContent = s.attempt > 1 ? `Reconnecting, try ${s.attempt}` : 'Reconnecting to the host';
  } else if (!everJoined && s.status === 'closed' && s.attempt > 2) {
    $('#join-err').textContent = 'Cannot reach the host. Are you on the same Wi-Fi?';
  }
});

client.on('welcome', (m) => {
  everJoined = true;
  resumeFight = true;
  if (!ext.hosted) remember(m.view?.campaign?.name);
  // Keep the personal link in the address bar so "Add to Home Screen" saves it.
  if (token && !location.pathname.startsWith('/p/')) {
    try { history.replaceState(null, '', `/p/${token}`); } catch {}
  }
  $('#claim').hidden = true;
  $('#join').hidden = true;
  $('#join-returning').hidden = true;
  $('#app').hidden = false;
  $('#reconnect').hidden = true;
  requestWakeLock();
});

client.on('view', (v) => {
  for (const [code, map] of Object.entries(v?.pack?.ruleset?.i18n || {})) addTranslations(code, map);
  const currentMapIds = new Set((v.maps ?? []).map((m) => m.id));
  for (const [id, row] of phoneMapViews) if (v.campaign?.id !== view?.campaign?.id || !currentMapIds.has(id)) {
    row.mv.destroy();
    phoneMapViews.delete(id);
  }
  view = v;
  const prev = me;
  me = v.me || null;
  if (!me) return;
  render();
  if (phoneMapsEl?.isConnected) renderMaps();
  msgCenter.update();
  maybeRecap(v.recap);
  if (prev?.id !== me.id) {
    for (const item of pendingLoot()) enqueueTakeover(item);
  }
  replayMissed(v);
});

client.on('event', (e) => {
  if (!me) return;
  if (e.kind === 'roll') {
    const r = e.roll || e;
    if (r.playerId === me.id && !r.vs && !r.card && !(r.what === 'rankUp' && r.by === me.id)) showRollCard(r, { meId: me.id });
    if (r.playerId === me.id && r.vs?.deg7 && r.part !== 'damage') showLastRoll({
      title: r.label, degree: r.vs.deg7, die: r.natural, modifier: r.total - r.natural, total: r.total, adv: r.adv,
    });
    // A friend's near miss (seven degrees): offer to Intervene with +1d6.
    if (!r.partyCheck && r.playerId && r.playerId !== me.id && r.vs?.deg7 === 'near' && r.vs.damage === undefined) intervenePrompt(r);
    return;
  }
  if (e.kind === 'rx.react') {
    const self = view?.combat?.combatants.find((x) => x.type === 'crawler' && x.playerId === me.id);
    if (self && e.targets?.includes(self.uid)) {
      buzz([50, 45, 100]);
    }
    return;
  }
  if (e.kind === 'dying' && e.playerId === me.id) { buzz([80, 60, 80, 60, 80]); toast(`You are dying: ${e.rounds} round${e.rounds === 1 ? '' : 's'} left. Someone has to heal you to 10 %.`, { error: true, ms: 7000 }); return; }
  if (e.kind === 'levelup') { buzz([40, 30, 40, 30, 120]); toast(view?.pack?.ruleset?.advancement ? 'Level up! Your choices are under More → Level up.' : 'Level up!', { ms: 5000 }); return; }
  if (e.kind === 'injury' && e.playerId === me.id) { buzz([60, 40, 60]); toast(`${e.injury} after the fight. ${e.desc || 'See Buffs on your sheet.'}`, { error: true, ms: 6000 }); return; }
  if (e.kind === 'dying.saved' && e.playerId === me.id) { buzz(30); toast('Saved. You are back on your feet.', { ms: 4000 }); return; }
  if (e.kind === 'dying.dead' && e.playerId === me.id) { buzz([200, 100, 400]); toast('You died. The GM decides what happens next.', { error: true, ms: 9000 }); return; }
  if (e.kind === 'rollUpdate') { if (e.why === 'intervene') { document.querySelector('.ivn')?.remove(); if (e.playerId === me.id) toast(`${e.by} intervened: +${e.d6}${e.hit ? '. It worked!' : '. Still not enough.'}`, { ms: 4000 }); } return; }
  if (e.kind === 'stat') {
    // Something hurt me: feel it, and see how much.
    if (e.playerId === me.id && e.resource && e.to < e.from) {
      buzz([60, 40, 60]); hitFlash();
      toast(`−${e.from - e.to} ${labelOfTrack(e.stat)} (${e.to}/${e.max})`, { ms: 3500 });
      if (e.to <= 0 && e.from > 0 && isHpTrack(e.stat)) downTakeover();
    }
    return;
  }
  if (e.kind === 'rest.offer') { buzz([40, 60, 40]); toast(`${e.label}: tap Rest when you are ready.`, { ms: 5000 }); return; }
  if (e.kind === 'combat.hit' && e.type === 'crawler' && e.playerId === me.id) return;
  // The event can land before the view that puts me in the fight: open the pad on the next render instead.
  if (e.kind === 'combat.start' && e.initiative) { if (waitingForMe()) initPrompt(); else initWanted = Date.now(); return; }
  if (e.kind === 'combat.turn') {
    if (e.current?.playerId === me.id) yourTurn(e);
    else if (e.next?.playerId === me.id) { buzz(30); toast("You're next", { ms: 3000 }); }
    return;
  }
  if (e.kind === 'secret' || e.kind === 'message') {
    notifyMessage(e);
    return;
  }
  if (e.playerId !== me.id) return;
  if (['achievement', 'loot', 'sponsor', 'item.broken', 'gift'].includes(e.kind)) {
    if (e.kind === 'gift' && e.playerId !== me?.id) return;
    if (e.id && seenLoad()?.has(e.id)) return; // the view got here first and already played it
    receiveTakeover(e);
  }
});

/* Missed takeovers: the feed carries recent loot / achievement / sponsor moments (with `replay`). Any of mine
   this phone has not shown yet (it was reloading or asleep) plays now. A phone's first visit only remembers. */
const SEEN_KEY = () => `system.seenTakeovers.${me?.id}`;
const REPLAY_MS = 2 * 3600_000;
let seenSet = null;
function seenLoad() {
  if (seenSet) return seenSet;
  try { const raw = localStorage.getItem(SEEN_KEY()); seenSet = raw ? new Set(JSON.parse(raw)) : null; } catch { seenSet = null; }
  return seenSet;
}
function markSeen(id) {
  if (!id || !me) return;
  const set = seenLoad() || (seenSet = new Set());
  set.add(id);
  try { localStorage.setItem(SEEN_KEY(), JSON.stringify([...set].slice(-60))); } catch {}
}
// Keep awarded cards across a phone reload, even after the event has left the recent feed.
const lootKey = () => `system.pendingLoot.${me.id}`;
function pendingLoot() {
  try {
    const cards = JSON.parse(localStorage.getItem(lootKey()));
    return Array.isArray(cards) ? cards : [];
  } catch { return []; }
}
function savePendingLoot(cards) {
  try {
    if (cards.length) localStorage.setItem(lootKey(), JSON.stringify(cards));
    else localStorage.removeItem(lootKey());
  } catch {}
}
function receiveTakeover(e) {
  const cards = e.kind === 'loot' && e.items?.length ? e.items.map((item, i) => ({
    kind: 'loot', id: `${e.id}/${i}`, playerId: e.playerId, item, tier: e.tier, number: i + 1, count: e.items.length, gold: e.gold,
  })) : [e];
  if (e.kind === 'loot') savePendingLoot([...pendingLoot(), ...cards]);
  markSeen(e.id);
  cards.forEach(enqueueTakeover);
}
function replayMissed(v) {
  if (!me) return;
  const mine = (v.feed || []).filter((f) => f.playerId === me.id && f.replay && ['achievement', 'loot', 'sponsor', 'item.broken', 'gift'].includes(f.kind));
  if (!seenLoad()) { for (const f of mine) markSeen(f.id); if (!mine.length) markSeen('_init'); return; }
  const now = v.now || Date.now();
  for (const f of mine) {
    if (seenSet.has(f.id)) continue;
    if (now - f.at > REPLAY_MS) { markSeen(f.id); continue; }
    receiveTakeover({ id: f.id, kind: f.kind, playerId: me.id, ...f.replay, replayed: true });
  }
}

/* ---------- render ---------- */

const rollPad = createRollPad({ send: sendWithActionReceipt, getView: () => view, getMe: () => me });
document.body.append(rollPad.el);
const diceOn = () => (me?.diceMode ?? 'enter') !== 'off';
const DICE_LABEL = { off: 'Off: dice stay at the table', enter: 'Enter my real die', digital: 'The phone rolls' };
const labelOfTrack = (id) => view?.pack?.ruleset?.tracks?.find((t) => t.id === id)?.label || 'HP';
const inFight = () => !!view?.combat?.active && (view.combat.combatants || []).some((x) => x.type === 'crawler' && x.playerId === me?.id);
async function setDiceMode(mode) {
  try { await client.send({ t: 'dice.mode', mode }); toast(`Dice: ${DICE_LABEL[mode]}`); } catch (err) { toast(err.message, { error: true }); }
}
function initPrompt() {
  const id = view?.pack?.ruleset?.combat?.initiative?.derived || 'initiative';
  buzz([40, 30, 40]);
  if (diceOn()) rollPad.open({ kind: 'derived', id }, 'Initiative');
  else initPad(id);
}
/**
 * Physical dice, no dice entry on this phone: a one-tap pad for initiative only. The crawler rolls the real d20
 * and taps the face; the server adds the sheet bonus, logs the roll and slots them into the turn order.
 */
function initPad(id) {
  if (document.querySelector('.ini-pad')) return;
  const sides = Number(String(view?.pack?.ruleset?.dice || 'd20').replace(/^d/, '')) || 20;
  const cmp = me?.sheet?.computed;
  const bonus = cmp?.derived?.[id]?.value ?? cmp?.stats?.dex?.mod?.value ?? 0;
  const sign = (n) => (n < 0 ? `- ${-n}` : `+ ${n}`);
  const dlg = h('dialog.ask-dlg.ini-pad');
  const close = () => { try { dlg.close(); } catch {} dlg.remove(); };
  const pick = async (face) => {
    close();
    try {
      const r = (await client.send({ t: 'init.mine', die: face }))?.result || {};
      const tot = r.total ?? face + bonus;
      const b = r.bonus ?? bonus;
      toast(`Initiative ${tot}${b ? ` (${face} ${sign(b)})` : ''}${r.place ? ` · you are ${r.place}. of ${r.of}` : ''}`, { ms: 4500 });
    } catch (err) { toast(err.message || 'Refused', { error: true }); }
  };
  dlg.append(h('div.ask-inner',
    h('h2.ini-pad-h', 'Roll initiative'),
    h('p.ini-pad-sub', `Roll your d${sides} and tap what it shows.${bonus ? ` Your ${sign(bonus)} is added for you.` : ''}`),
    dieFaces(sides, pick),
    h('div.ask-row', h('button.btn.btn-ghost', { type: 'button', onclick: close }, 'Later'))));
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.append(dlg);
  dlg.showModal();
}
/** A hit: the whole screen flashes red for a moment. */
function hitFlash() {
  const f = h('div.hit-flash', { 'aria-hidden': 'true' });
  document.body.append(f);
  setTimeout(() => f.remove(), 700);
}
const isHpTrack = (id) => id === 'hp' || /^(hp|health|hit ?points)$/i.test(String(labelOfTrack(id) || ''));
/** 0 HP: a full-screen DOWN with one line of what it means in this campaign's rules. Tap to close. */
function downTakeover() {
  document.querySelector('.down-takeover')?.remove();
  const rs = view?.pack?.ruleset || {};
  const sys = rs.system?.id || '';
  const line = rs.combat?.downRule
    || (sys.startsWith('dnd') ? 'You are unconscious. On your turn roll a death save: d20, 10+ is a success, 3 successes and you stabilise, 3 failures and you die. A natural 20 brings you back with 1 HP.'
      : sys === 'pf2e' ? 'You are dying 1 (more on a critical hit) and unconscious. Each turn roll a recovery check, flat DC 10 + your dying value. Dying 4 and you die.'
        : 'You are down. You can\'t act until someone heals you. Tell the GM what you do with your last breath.');
  buzz([300, 100, 300, 100, 600]);
  const box = h('div.down-takeover', { role: 'alert', onclick: () => box.remove() },
    h('b', 'DOWN'), h('p', line), h('span.hint', 'Tap to close'));
  document.body.append(box);
}
function yourTurn(e) {
  buzz([120, 60, 120]);
  const box = h('div.your-turn', { role: 'alert', onclick: () => box.remove() }, h('b', 'Your turn'), h('span', `Round ${e.round}`), diceOn() ? h('button.btn.btn-primary', { type: 'button', onclick: (ev) => { ev.stopPropagation(); box.remove(); rollPad.openPicker(); } }, 'Roll') : null);
  document.body.append(box);
  setTimeout(() => box.remove(), 6000);
}
let initWanted = 0;
const iniPrompt = h('button.ini-prompt', { type: 'button', hidden: true, onclick: () => initPrompt() }, 'Roll initiative');
document.body.append(iniPrompt);
const waitingForMe = () => !!view?.combat?.active && !!view.combat.init?.on && (view.combat.init.waiting || []).some((x) => x.playerId === me?.id);
/** Rules card: how this game is played (from the campaign's ruleset), plus the licence notice. */
function openRules() {
  const rs = view?.pack?.ruleset || {};
  const cr = rs.combat || {};
  const def = cr.defenseLabel || 'Defence';
  const basics = [
    `Roll a d20 and add the number shown next to what you do. The GM tells you if it worked.`,
    `Attacks hit when the total reaches the target's ${def}.${cr.degrees ? ' Beat it by 10 for a critical; miss by 10 for a critical failure. A natural 20 or 1 moves the result one step.' : ' A natural 20 is a critical hit; a natural 1 always misses.'}`,
    cr.advantage ? 'Advantage: roll two d20 and keep the higher. Disadvantage: keep the lower.' : null,
    cr.initiative?.enabled ? 'Fights go in turn order. Roll initiative when the fight starts; your phone buzzes on your turn.' : 'Fights go in phases the GM calls out.',
    'Tap a number on your sheet to see how it is made. With dice on this phone, roll digitally or tap the face your real d20 showed.',
  ].filter(Boolean);
  const body = h('div.rules-card',
    h('h3', 'Basics'), h('ul', basics.map((t) => h('li', t))),
    (rs.notes || []).length ? h('details', h('summary', 'More rules'), h('ul', rs.notes.map((t) => h('li', t)))) : null,
    rs.system?.attribution ? h('details', h('summary', 'Licence'), h('p.hint', rs.system.attribution)) : null);
  openDrawer({ title: 'Rules', sub: rs.system?.label || '', body });
}

const rollFab = h('button.roll-fab', { type: 'button', hidden: true, 'aria-label': 'Roll', onclick: () => rollPad.openPicker() }, icon('dice', { size: 26 }), h('span', 'Roll'));
document.body.append(rollFab);
const levelActions = () => pendingLevelActions(me?.levelGrants);
let refreshLevelUp;
const showLevelUp = () => {
  refreshLevelUp = openLevelUp({ getGrants: () => me?.levelGrants ?? [], send: (a) => client.send(a), roll: view?.pack?.ruleset?.skills?.rankUp?.roll });
};
const levelPrompt = h('div.panel.prep-prompts.level-prompt', { hidden: true }, h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: showLevelUp }, 'Level up'));
$('#prep-prompts').after(levelPrompt);

const sheet = createSheet({
  mode: 'player',
  send: sendWithActionReceipt,
  onRoll: (what, label) => rollPad.open(what, label),
  rollsOn: diceOn,
  extraTabs: () => (me ? [
    { id: 'combat', label: 'Combat', primaryPage: true, badge: combatAttention(), render: () => combatPanel },
    { id: 'ach', label: 'Achievements', count: me.achievements?.length || '', sig: achSig(), render: renderAchievements },
    { id: 'msg', label: 'Messages', primaryPage: true, badge: unreadCount() || '', sig: msgSig(), render: renderMessages },
    // Always a dock page (27 Nov): an empty state until the GM shares a map, then the map with the own token.
    { id: 'maps', label: 'Map', primaryPage: true, badge: (view?.maps || []).length ? '' : '', sig: JSON.stringify(view?.maps ?? []), render: renderMaps },
  ] : []),
  onBuilder: (model, p) => openBuilder({ model, player: p, gm: false, act: sheet.act, allowOrigins: !!view?.session?.permissions?.allowOrigins }),
  // Phones: app layout (sticky crawler bar, section tabs); the app bar items move into the menu.
  phone: () => phoneMq.matches,
  onPlayerPage: () => { if (me) renderStart(); },
  top: () => [h('span.ph-live', h('span.live-dot', { 'aria-hidden': 'true' }), `${fmtNum(view?.audience?.viewers ?? 0)} watching`),
    h('span.ph-crawlers.js-crawlers', { 'data-fmt': 'compact', title: 'Crawlers still alive in the dungeon' }), langButton('ph-lang')],
  moreItems: () => [
    view?.pack?.ruleset?.advancement || me?.levelGrants?.length ? { icon: 'sparkle', label: 'Level up', badge: levelActions(), navigationDrawer: true, onClick: showLevelUp } : null,
    { icon: 'dice', label: 'Dice on this phone', sub: DICE_LABEL[me?.diceMode ?? 'enter'], onClick: () => setDiceMode({ off: 'enter', enter: 'digital', digital: 'off' }[me?.diceMode ?? 'enter']) },
    { icon: 'dice', label: 'Dice log', sub: 'Every roll at the table', onClick: () => setLogOpen(true) },
    { icon: 'book', label: 'Rules', sub: view?.pack?.ruleset?.system?.short || 'How this game is played', navigationDrawer: true, onClick: openRules },
    // Printable cheat sheets from the pack (pack.json "cheats", player ones only).
    ...(view?.pack?.cheats || []).map((c) => ({ icon: 'info', label: c.label, sub: 'Cheat sheet: one page, also printable', onClick: () => window.open(c.url, '_blank', 'noopener') })),
    { icon: 'sun', label: 'Theme', sub: 'Dark, light or neon', onClick: () => { toggleTheme(); drawTheme(); } },
    { icon: 'flag', label: 'Jazyk · Language', sub: getLang() === 'cs' ? 'Čeština → English' : 'English → Čeština', onClick: () => setLang(getLang() === 'cs' ? 'en' : 'cs') },
    ext.hosted ? null : { icon: 'x', label: 'Switch campaign', sub: 'You can come back with your QR code', onClick: () => $('#leave').click() },
  ].filter(Boolean),
});
// The Combat page shares this panel across viewport sizes.
const rxPhone = createRxPhone({ send: (a) => client.send(a), toast, onReceipt: showCombatReceipt });
const combatBar = h('div.pl-combat-bar');
const combatActions = h('div.pl-combat-actions');
const combatReceipt = h('p.pl-action-receipt', { role: 'status', hidden: true });
const combatInjuries = h('section.pl-combat-injuries', { 'aria-label': 'Injuries', hidden: true });
const combatHistory = h('section.pl-combat-recent');
const combatRoster = h('div.pl-combat-roster');
const combatPanel = h('section.pl-combat', { 'aria-label': 'Combat' }, combatBar, rxPhone.el, combatActions, combatReceipt, combatInjuries, combatHistory, combatRoster);
let combatKey = '';
let combatReceiptRound;
let lastCombatReceipt;

const ACTION_LABELS = { roll: 'Attack rolled', 'roll.undo': 'Attack undone', 'spell.cast': 'Spell cast', 'item.use': 'Item used', 'hotlist.set': 'Hotlist updated' };

async function sendWithActionReceipt(action) {
  const label = ACTION_LABELS[action.t];
  const round = combatReceiptRound;
  const response = await client.send(action);
  const result = response?.result;
  if (label && result?.receipt && round != null && round === combatReceiptRound) {
    const amount = result.healed ? result.healed.to - result.healed.from : 0;
    const message = result.receipt.refunded ? `${label} · 1 action refunded`
      : amount > 0 ? `${label} · ${amount} health slot${amount === 1 ? '' : 's'} restored` : label;
    showCombatReceipt(message, result.receipt);
  }
  return response;
}

function showCombatReceipt(label, receipt, detail) {
  lastCombatReceipt = { label, spent: receipt?.spent };
  drawCombatReceipt(receipt);
  if (!detail) return;
  if (detail.kind === 'intervene') showLastRoll({ title: `Intervene · ${detail.label ?? ''}`, verdict: `+${detail.d6}`, note: label });
  else if (detail.kind === 'taunt') showLastRoll({ title: 'Taunt', verdict: detail.ok ? 'TAUNTED' : 'NO EFFECT', degree: detail.degree, die: detail.die, modifier: Number.isFinite(detail.die) ? detail.total - detail.die : undefined, total: detail.total });
  else if (Number.isFinite(detail.die)) showLastRoll({ title: detail.free ? 'Free Evade' : 'Evade', die: detail.die, modifier: detail.total - detail.die, total: detail.total, degree: detail.degree,
    note: ['crit', 'amazing', 'success'].includes(detail.degree) ? 'You dodge this attack.' : detail.near ? null : 'The attack can hit you.' });
}

function drawCombatReceipt(receipt) {
  if (!lastCombatReceipt) return;
  const { label, spent } = lastCombatReceipt;
  const parts = [label];
  if (spent) parts.push(`${spent} action${spent === 1 ? '' : 's'} spent`);
  if (receipt?.actionsLeft != null) parts.push(`${receipt.actionsLeft} action${receipt.actionsLeft === 1 ? '' : 's'} left${receipt.utilityLeft ? ` + ${receipt.utilityLeft} utility` : ''}`);
  const line = parts.join(' · ');
  if (combatReceipt.textContent !== line) combatReceipt.textContent = line;
  combatReceipt.hidden = false;
}

function closePlayerNavigationOverlays() {
  if (document.querySelector('dialog[data-player-navigation][open]')) closeDrawer();
  if (document.body.classList.contains('log-open')) setLogOpen(false);
}

function combatMember() {
  return view?.combat?.active ? view.combat.combatants.find((x) => x.type === 'crawler' && x.playerId === me?.id) : null;
}

function incomingAttacks(member = combatMember()) {
  const rx = view?.combat?.rx;
  return member && rx?.step === 'react' ? rx.decls.filter((d) => d.targetUid === member.uid && !d.caught && !d.result) : [];
}

function combatAttention() {
  const member = combatMember();
  if (!member || member.down || member.dead || member.dying != null) return 0;
  return incomingAttacks(member).filter((d) => !d.evade || d.canReroll).length;
}

function syncCombatPage() {
  const member = combatMember();
  const key = member ? JSON.stringify([view.campaign?.id, me.id, member.uid]) : null;
  const incoming = incomingAttacks(member);
  const begin = !!key && key !== routedFight;
  const retargeted = incoming.some((d) => !routedTargets.has(d.id));
  const ended = !!routedFight && !key;
  const resume = resumeFight;
  resumeFight = false;
  routedFight = key;
  routedTargets = new Set(incoming.map((d) => d.id));
  if (key && (begin || resume || retargeted)) {
    closePlayerNavigationOverlays();
    markStartSeen();
    sheet.setTab('combat');
  } else if (ended) {
    closePlayerNavigationOverlays();
    sheet.setTab('sheet');
  }
}

const COMBAT_PHASES = { declare: 'Mobs choose', react: 'React', resolve: 'Hits land', act: 'Crawlers act', cleanup: 'Clean up' };

function combatChoices(title, rows) {
  return openDrawer({ title, body: h('div.pl-combat-choices', rows) });
}

function drawCombat() {
  const c = view?.combat;
  const own = c?.combatants?.find((x) => x.type === 'crawler' && x.playerId === me.id);
  const active = !!c?.active;
  const rx = c?.rx;
  const reaction = reactionControls(view, me);
  const rs = view?.pack?.ruleset;
  const reactionRules = rs?.combat?.flow === 'reaction';
  const standing = own && !own.down && !own.dead && own.dying == null;
  const receiptRound = active ? `${own?.uid ?? ''}:${c.round}` : null;
  if (receiptRound !== combatReceiptRound) {
    combatReceiptRound = receiptRound;
    lastCombatReceipt = null;
    combatReceipt.replaceChildren();
    combatReceipt.hidden = true;
  }
  drawCombatReceipt(reaction ? { actionsLeft: reaction.left, utilityLeft: reaction.extra } : null);
  rxPhone.update(view, me);
  const step = rx?.step ?? (active ? 'active' : 'idle');
  combatPanel.dataset.combatStep = step;
  const isMyTurn = c?.init?.turnUid === own?.uid && !!own;
  const classicAct = active && !reactionRules && !rx && (!c.init?.on || isMyTurn);
  const mayAct = active && standing && (reaction ? reaction.act && reaction.canAct : classicAct && !combatBlocked(view, me, 'action'));
  const canStrike = mayAct && (!reaction || reaction.left > 0);
  const interrupt = reaction?.react && reaction.canInterrupt;
  const available = mayAct && (!reaction || reaction.left + reaction.extra > 0);
  const mayCast = !combatBlocked(view, me, 'spell') && (available || !!interrupt);
  const mayUse = !combatBlocked(view, me, 'action') && (available || !!interrupt);
  const hotlist = !!rs?.hotlist?.combat;
  const ready = new Set(me.sheet?.hotlist ?? []);
  const hpTrack = rs?.tracks?.find((t) => t.id === 'hp') ?? rs?.tracks?.[0];
  const potionTrack = rs?.tracks?.find((t) => t.kind === 'slots')?.id;
  const health = own ? { cur: own.hp, max: own.hpMax, slotValue: own.slotValue } : me.sheet?.computed?.tracks?.[hpTrack?.id];
  const quickItems = mayUse && hotlist ? (me.sheet?.inventory ?? []).filter((i) => ready.has(i.uid) && i.use
    && (!reaction?.react || (i.tags?.includes('potion') && i.use.heal?.track === potionTrack))) : [];
  const basicHeal = reaction && mayCast && reaction.canInterrupt ? rs?.combat?.healSpell : null;
  const quickSpells = mayCast ? (me.sheet?.spells ?? []).filter((s) => s.spellId !== basicHeal?.spellId && (!hotlist || ready.has(s.uid))
    && (s.attackCheck ? canStrike : !reaction?.react || s.healing || s.tags?.includes('interrupt'))) : [];
  const mana = me.sheet?.computed?.tracks;
  const costs = me.sheet?.computed?.spells;
  const healingBlocked = combatBlocked(view, me, 'heal');
  const healDisabled = basicHeal && (healingBlocked ? 'Healing is blocked'
    : health && health.cur >= health.max ? 'Health is full' : (mana?.[basicHeal.track]?.cur ?? 0) < basicHeal.mana ? 'Not enough Mana' : '');
  const needsInitiative = waitingForMe();
  const mobs = active ? (c.combatants ?? []).filter((m) => m.type === 'mob' && !m.down) : [];
  const advantages = (rx?.advantage ?? []).filter((a) => a.uid === own?.uid);
  const history = (c?.history ?? []).slice(0, 5);
  const injuries = active ? own?.pendingInjuries ?? [] : [];
  const myPhase = standing && (rx?.step === 'act' || isMyTurn);
  const phaseLabel = myPhase ? 'Your turn' : COMBAT_PHASES[step] ?? (active ? c.phase || 'Fight in progress' : 'No active fight');
  const key = JSON.stringify([step, active, own?.uid, own?.dying, own?.dead, health, c?.round, phaseLabel, needsInitiative, canStrike,
    reaction?.left, reaction?.extra, reaction?.canHelp, reaction?.canDoSomething, rx?.decls, rx?.intervene, reaction?.canInterrupt, standing, mayCast, mayUse, quickSpells, quickItems, basicHeal, healDisabled, healingBlocked, mana, costs, advantages, injuries, mobs, history]);
  if (key === combatKey) return;
  combatKey = key;

  const current = health?.cur ?? 0;
  const max = health?.max ?? 0;
  const percent = max ? Math.round(100 * current / max) : 0;
  const hpLabel = health?.slotValue != null ? `${percent}% · ${current}/${max} slots · 1 slot = ${health.slotValue} HP` : `${current}/${max} HP`;
  const danger = own?.dead ? 'Dead' : own?.dying != null ? `Dying · ${own.dying} round${own.dying === 1 ? '' : 's'} left` : own?.down ? 'Down' : null;
  const pips = reaction ? Math.max(rx.surprised && rx.round === 0 ? 1 : 2, reaction.left) : 0;
  combatBar.replaceChildren(...[h('div.pl-combat-health', { 'data-danger': danger ? 'true' : null },
    h('div.pl-health-meta', h('h2', 'Health'), h('b', hpLabel), danger ? h('span.pl-health-danger', danger) : null),
    h('div.pl-health-fill', { role: 'meter', 'aria-label': 'Health', 'aria-valuemin': 0, 'aria-valuenow': current, 'aria-valuemax': max },
      h('i', { style: { width: `${percent}%` } })),
    h('div.pl-phase-row', h('span', { class: myPhase ? 'pl-current-turn' : null }, active ? `${rx?.round === 0 ? 'Surprise' : `Round ${c.round}`} · ${phaseLabel}` : phaseLabel),
      reaction ? h('div.pl-remaining', { 'aria-label': 'Actions remaining' },
        h('span.pl-pips', { 'aria-hidden': 'true' }, Array.from({ length: pips }, (_, i) => h('i', { class: i < reaction.left ? 'ready' : null }))),
        h('span', `${reaction.left} action${reaction.left === 1 ? '' : 's'} left${reaction.extra ? ` + ${reaction.extra} utility` : ''}`)) : null)),
    active && !own ? h('p.dim', 'The GM can add you to this fight.') : null,
    active && own && !rx && reactionRules ? h('p.dim', 'Waiting for the GM to start the round.') : null].filter(Boolean));

  const why = !standing ? 'Cannot act' : !reaction ? 'Wait for your turn'
    : !reaction.act && !reaction.react ? 'Wait for your phase' : reaction.left + reaction.extra === 0 ? 'No actions left' : 'Unavailable in this phase';
  const allyTarget = rx?.decls?.some(d => d.targetUid !== own?.uid && !d.result);
  const bossTarget = mobs.some(m => m.boss);
  const action = (label, glyph, enabled, onclick, primary = false, reason = why) => h('button.btn.pl-fight-action', {
    type: 'button', class: primary && enabled ? 'btn btn-primary pl-fight-action' : null, disabled: !enabled, 'aria-label': label, title: enabled ? null : reason, onclick,
  }, icon(glyph, { size: 19 }), h('span', label, enabled ? null : h('small', reason)));
  function pickSpell() {
    const rows = quickSpells.map((s) => {
      const t = costs?.find((x) => x.uid === s.uid);
      const affordable = (t?.cost?.value ?? 0) <= (mana?.[t?.costTrack]?.cur ?? 0);
      const cooldown = spellCooldownHint(t?.cooldown);
      const selfHealing = reactionRules && s.healing && s.healing.target !== 'ally';
      const fullHealth = selfHealing && health?.cur >= health?.max;
      const blocked = selfHealing && healingBlocked;
      const reason = cooldown || (blocked ? 'Healing is blocked' : fullHealth ? 'Health is full' : !affordable ? 'Not enough Mana' : '');
      return h('button.btn', { type: 'button', disabled: !!reason, onclick: () => {
        closeDrawer();
        if (s.attackCheck) rollPad.open({ kind: 'spell', uid: s.uid }, `${s.name} to hit`);
        else sheet.castReadySpell(s.uid);
      } }, s.name, reason ? h('small', reason) : null);
    });
    if (basicHeal) rows.unshift(h('button.btn', { type: 'button', disabled: !!healDisabled,
      onclick: async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const response = await client.send({ t: 'rx.interrupt', kind: 'heal' });
          const result = response?.result;
          if (result) showCombatReceipt(`Heal restored ${result.healed} slot${result.healed === 1 ? '' : 's'}`, result.receipt);
          if (button.isConnected) closeDrawer();
        } catch (err) {
          toast(err.message, { error: true });
          if (button.isConnected) closeDrawer();
        }
      } }, 'Heal', h('small', healDisabled || `Self · 1 action · ${basicHeal.mana} Mana · ${basicHeal.slots} slots`)));
    combatChoices('Spells', rows);
  }
  function pickItem() {
    if (!hotlist) { sheet.setTab('inventory'); return; }
    combatChoices('Hotlist', quickItems.map((i) => h('div.pl-quick-item',
      h('button.btn', { type: 'button', onclick: () => { closeDrawer(); sheet.useReadyItem(i.uid); } }, `${i.name} · ${i.qty}`),
      i.tags?.includes('potion') ? h('button.icon-btn', { type: 'button', 'aria-label': `Give ${i.name} to an ally`,
        onclick: () => { closeDrawer(); sheet.choosePotionRecipient(i.uid); } }, icon('users', { size: 17 })) : null)));
  }

  combatActions.replaceChildren(...[needsInitiative ? h('button.btn.btn-primary', { type: 'button', onclick: initPrompt }, 'Roll initiative') : null,
    active && own ? h('div.pl-action-grid',
      action('Attack', 'swords', canStrike, () => rollPad.openPicker({ attacksOnly: true }), true),
      action('Spell', 'bolt', quickSpells.length || basicHeal, pickSpell, false, mayCast ? 'No ready spell' : why),
      action(hotlist ? 'Item (Hotlist)' : 'Item', 'gift', hotlist ? quickItems.length : mayUse, pickItem, false, mayUse ? 'No ready item' : why),
      reaction ? [
        action('Make a check', 'dice', available, () => rollPad.openPicker({ checksOnly: true })),
        action('Move', 'chevron', available, () => rxPhone.activity('move')),
        action('Retrieve', 'gift', available && hotlist, () => sheet.setTab('hotlist')),
        action('Look for clues', 'search', available && bossTarget, () => rxPhone.activity('clues'), false, bossTarget ? why : 'Needs a visible boss'),
        action('Taunt', 'users', interrupt && allyTarget, rxPhone.showTaunt, false, reaction.react && !allyTarget ? 'No attack aimed at an ally' : why),
      ] : null,
      action('Help a friend', 'users', reaction?.canHelp, rxPhone.showHelp),
      action('Something else', 'more', reaction ? reaction.canDoSomething : mayAct, reaction ? rxPhone.showUtility : () => rollPad.openPicker())) : null,
    rx?.step === 'act' && advantages.length ? h('p.pl-combat-adv', `Advantage against ${advantages.map((a) => a.mob).join(', ')}. Roll 2d20 and keep the higher.`) : null].filter(Boolean));
  combatHistory.replaceChildren(h('h3', 'Recent combat'), history.length ? h('ol.pl-combat-history', { 'aria-label': 'Recent combat' }, history.map((row) => h('li', { 'data-result-kind': row.kind },
    h('strong', row.label), row.detail || row.result ? h('span.dim', row.detail || row.result) : null))) : h('p.dim', 'Your results appear here.'));
  combatInjuries.hidden = !injuries.length;
  combatInjuries.replaceChildren(...(injuries.length ? [h('h3', 'Injuries'), h('ul', injuries.map((injury) => h('li',
    h('strong', injury.severity === 'major' ? 'Major injury' : 'Minor injury'), h('span', injury.desc)))), h('p.dim', 'Effects start after combat.')] : []));
  const existingTargets = combatRoster.querySelector('details')?.open;
  combatRoster.replaceChildren(...(mobs.length ? [h('details.pl-target-book', { open: existingTargets || null }, h('summary', `Targets (${mobs.length})`),
    h('ul.pl-targets', mobs.map((m) => {
      const label = m.hpMax != null ? `${m.hp}/${m.hpMax} ${m.slotValue != null ? 'slots' : 'HP'}` : `${Math.round(100 * (m.hpPct ?? 1))}%`;
      const body = [itemArt({ name: m.name, image: m.image }, 'pl-target-art'), h('span', h('b', m.name), h('small.dim', label))];
      return h('li', canStrike ? h('button.btn.pl-target', { type: 'button', 'aria-label': `Attack ${m.name}`,
        onclick: () => rollPad.openPicker({ target: m.uid, attacksOnly: true }) }, body, icon('chevron', { size: 15 })) : h('div.pl-target', body));
    })))] : []));
}

const phoneMq = matchMedia('(max-width: 699px)');
phoneMq.addEventListener?.('change', () => { if (me) { sheet.redraw(); renderStart(); } });
$('#sheet-root').append(sheet.el);
$('#app .appbar').after(sheet.playerNav);

const diceLog = createDiceLog({
  gm: false,
  onCustomRoll: async (formula) => {
    try {
      const r = await client.send({ t: 'roll', what: { kind: 'custom', formula, label: formula } });
      if (r?.result?.roll) showRollCard(r.result.roll, { meId: me?.id });
    } catch (err) { toast(err.message, { error: true }); throw err; }
  },
});
$('#log-rail').append(diceLog.el);
onLocalRoll(() => renderLog());

function renderLog() {
  if (!view) return;
  const rolls = [...(view.rolls || []), ...localRolls].sort((a, b) => (a.at || 0) - (b.at || 0));
  diceLog.update({ ...view, rolls }, me?.id);
  const n = rolls.filter((r) => !r.secret || r.playerId === me?.id).length;
  $('#log-n').textContent = n ? String(n) : '';
}

function setLogOpen(open) {
  document.body.classList.toggle('log-open', open);
  $('#log-btn').setAttribute('aria-expanded', String(open));
}
$('#log-btn').addEventListener('click', () => setLogOpen(!document.body.classList.contains('log-open')));
$('#log-rail').prepend(h('button.btn.btn-quiet.log-close', { type: 'button', onclick: () => setLogOpen(false) }, icon('x', { size: 16 }), 'Close dice log'));
const themeBtn = $('#theme-btn');
const drawTheme = () => { const t = document.documentElement.dataset.theme; themeBtn.replaceChildren(icon(t === 'light' ? 'sparkle' : t === 'neon' ? 'moon' : 'sun', { size: 16 })); };
themeBtn.addEventListener('click', () => { toggleTheme(); drawTheme(); });
applyTheme();
drawTheme();

function render() {
  document.body.style.setProperty('--me', me.color || 'var(--c-accent)');
  document.title = `${me.sheet?.identity?.name || me.name} · ${sysName()}`;
  { const mm = (view.players || []).find((x) => x.id === me.id)?.marks; const el = document.getElementById('my-marks'); const sig = JSON.stringify(mm ?? null); if (el && el.dataset.sig !== sig) { el.dataset.sig = sig; el.replaceChildren(...[marksEl(mm)].filter(Boolean)); } }
  $('#brand').textContent = sysName();
  $('#viewers').textContent = fmtNum(view.audience?.viewers ?? 0);
  crClock.set(view.crawlers);
  tickCrawlers();
  applyAccent(view.pack);
  applyPackTheme(view.pack?.theme);
  drawTheme();
  renderPrivateChecks();
  levelPrompt.hidden = !levelActions() || !!view.combat?.active;
  refreshLevelUp?.();
  drawCombat();
  sheet.update(view, me);
  syncCombatPage();
  iniPrompt.hidden = !waitingForMe();
  if (initWanted && waitingForMe()) { initWanted = 0; initPrompt(); } else if (initWanted && Date.now() - initWanted > 10_000) initWanted = 0;
  if (!waitingForMe()) document.querySelector('.ini-pad')?.remove();
  rollPad.update();
  rollFab.hidden = (!diceOn() && !inFight()) || !!view.combat?.rx;
  renderStart();
  renderLog();
  renderTicker();
}

/* ---------- the last roll, big and kept until the player closes it (checks, Evade, Intervene, Taunt) ---------- */
const ROLL_DEGREES = { crit: 'CRITICAL HIT', amazing: 'AMAZING', success: 'SUCCESS', near: 'NEAR MISS', fail: 'FAIL', major: 'MAJOR FAIL', critfail: 'CRITICAL FAIL' };
const ROLL_MEANING = { crit: 'Natural 20. The best possible result.', amazing: 'Beat it by 10 or more.', near: 'Missed by 1 or 2. A friend can Intervene with +1d6.',
  major: 'Missed by 10 or more. Expect consequences.', critfail: 'Natural 1. The System noticed.' };
const ROLL_BUZZ = { crit: [40, 60, 40, 60, 120], amazing: [30, 50, 30], success: [20, 40, 20], near: [60, 40, 60], fail: 15, major: [80], critfail: [200] };
function showLastRoll({ title, die, modifier, total, degree, verdict, note, adv }) {
  const el = $('#roll-card');
  if (!el) return;
  const mod = Number(modifier) || 0;
  const math = Number.isFinite(die) ? `d20 ${die} ${mod < 0 ? '−' : '+'} ${Math.abs(mod)} = ${total ?? die + mod}` : '';
  const word = verdict || ROLL_DEGREES[degree] || (degree ? String(degree).toUpperCase() : '');
  const good = ['crit', 'amazing', 'success'].includes(degree) || /hit|evaded|success/i.test(verdict || '');
  el.className = `roll-card panel${degree ? ` deg-${degree}` : ''}${good ? ' is-good' : word ? ' is-bad' : ''}`;
  el.replaceChildren(
    h('div.roll-card-main',
      h('span.roll-card-title', title || 'Your roll'),
      word ? h('b.roll-card-verdict', word) : null,
      math ? h('span.roll-card-math', math) : null,
      adv ? h('span.roll-card-note', adv === 'adv' ? 'Advantage: higher of two d20' : 'Disadvantage: lower of two d20') : null,
      ROLL_MEANING[degree] ? h('span.roll-card-note', ROLL_MEANING[degree]) : null,
      note ? h('span.roll-card-note', note) : null),
    h('button.icon-btn.roll-card-x', { type: 'button', 'aria-label': 'Close', onclick: () => { el.hidden = true; } }, icon('x', { size: 18 })));
  el.hidden = false;
  buzz(ROLL_BUZZ[degree] ?? 15);
  el.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
}

let checkDrawer = null;
let openCheck = null;

function renderPrivateChecks() {
  const prompts = view.checkPrompts ?? [];
  const el = $('#prep-prompts');
  if (checkDrawer?.open && !prompts.some((p) => p.id === openCheck)) closeDrawer();
  const rest = restCard();
  el.hidden = !prompts.length && !rest;
  el.replaceChildren(rest ?? '', ...prompts.map((p) => {
    if (p.kind === 'show' && p.rolled) {
      const r = p.rolled;
      return h('div.panel.prep-prompt', h('span.prep-prompt-k', 'Rolled · the GM reveals it on the TV'), h('b', p.label),
        h('span', `${r.die} ${r.modifier < 0 ? '−' : '+'} ${Math.abs(r.modifier)} = `, h('b', String(r.total)), r.favored ? ' (rerolled)' : ''),
        p.canFavor ? h('button.btn', { type: 'button', onclick: () => favorShowCheck(p) }, icon('dice', { size: 16 }), 'Reroll for 1 AI Favor') : null);
    }
    return h('div.panel.prep-prompt', h('span.prep-prompt-k', p.kind === 'show' ? 'The GM asks for a roll · on the TV' : 'The GM asks for a roll'), h('b', p.label || 'Private check'),
      h('button.btn.btn-primary', { type: 'button', onclick: () => openPrivateCheck(p) }, icon('dice', { size: 18 }), `Roll ${p.ability}`));
  }));
}

// Rest offered by the GM (server/rest-offer.js): nothing heals until the crawler taps Rest.
function restCard() {
  const r = view.rest;
  if (!r) return null;
  const restore = r.restore ? Object.entries(r.restore).map(([k, v]) => `${k === 'hp' ? 'Health' : k === 'mana' ? 'Mana' : k} ${v === 'full' ? 'full' : typeof v === 'number' ? `+${v}` : 'half'}`).join(' · ') : '';
  if (r.done) {
    return h('div.panel.prep-prompt.rest-prompt.done', h('span.prep-prompt-k', r.label), h('b', 'You rested.'),
      h('span', (r.done.restored ?? []).join(' · ') || 'Nothing needed restoring.'));
  }
  return h('div.panel.prep-prompt.rest-prompt', h('span.prep-prompt-k', `${r.place === 'camp' ? 'Camp' : 'Saferoom'} · ${r.hours} h`), h('b', r.label),
    restore ? h('span', restore) : null,
    h('button.btn.btn-primary', { type: 'button', onclick: async (e) => {
      e.currentTarget.disabled = true;
      try {
        const res = await client.send({ t: 'rest.accept', id: r.id });
        buzz(30);
        toast(`Rested. ${(res?.result?.restored ?? []).join(' · ') || 'Nothing needed restoring.'}`);
      } catch (error) { e.currentTarget.disabled = false; toast(error.message || 'Could not rest.', { error: true }); }
    } }, icon('moon', { size: 18 }), 'Rest'));
}

async function favorShowCheck(p) {
  try {
    const r = (await client.send({ t: 'scene.check.favor', id: p.id }))?.result ?? {};
    showLastRoll({ title: `${p.ability} · ${p.label} (AI Favor)`, die: r.die, modifier: r.modifier, total: r.total, note: 'Rerolled. The GM reveals the result on the TV.' });
  } catch (error) {
    toast(error.message || 'Reroll failed.', { error: true });
  }
}

function openPrivateCheck(p) {
  const send = async (entered) => {
    if (!checkDrawer?.open) return;
    const dialog = checkDrawer;
    const buttons = [...dialog.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') !== 'Close');
    if (buttons.some((b) => b.disabled)) return;
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const res = await client.send({ t: p.kind === 'show' ? 'scene.check.reply' : 'prep.check.reply', id: p.id, ...(entered === undefined ? {} : { entered }) });
      if (dialog.open) closeDrawer();
      const r = res?.result ?? {};
      showLastRoll({ title: `${r.ability || p.ability} · ${r.label || p.label || 'Check'}`, die: r.die, modifier: r.modifier, total: r.total, degree: r.degree, adv: r.advantage,
        note: p.kind === 'show' ? 'Sent. The GM reveals the result on the TV.' : 'The GM sees your result.' });
    } catch (error) {
      buttons.forEach((b) => { b.disabled = false; });
      toast(error.message || 'The check could not be sent.', { error: true });
    }
  };
  const face = p.advantage === 'dis' ? 'Take the lower of two d20 rolls.' : p.advantage === 'adv' ? 'Take the higher of two d20 rolls.' : 'Tap the face on your d20.';
  checkDrawer = openDrawer({ title: `Roll ${p.ability}`, sub: p.label,
    body: [h('p', face), dieFaces(20, send)],
    actions: h('button.btn.btn-primary', { type: 'button', onclick: () => send() }, icon('dice', { size: 16 }), 'Roll digitally'),
    onClose: () => { checkDrawer = null; openCheck = null; },
  });
  openCheck = p.id;
}

/* ---------- crawlers remaining (server/crawlers.js): small, live, in the app bar ---------- */

const crClock = crawlerClock();
function tickCrawlers() {
  const c = crClock.data;
  const on = !!c && c.shown !== false;
  const v = on ? crClock.value() : 0;
  for (const el of document.querySelectorAll('.js-crawlers')) {
    el.hidden = !on;
    if (!on) continue;
    const text = el.dataset.fmt === 'compact' ? `${fmtCompact(v)} left` : `${fmtFull(v)} crawlers left`;
    if (el.dataset.text === text) continue;
    el.dataset.text = text;
    el.replaceChildren(skullSvg(12), text);
  }
}
setInterval(tickCrawlers, 1000);

/* ---------- Intervene: a friend's near miss, +1d6 from this phone ---------- */
function intervenePrompt(r) {
  document.querySelector('.ivn')?.remove();
  const inReactionFight = view?.combat?.active && view?.pack?.ruleset?.combat?.flow === 'reaction';
  const reaction = reactionControls(view, me);
  if (inReactionFight && !reaction?.canHelp) return;
  const who = (view?.players || []).find((p) => p.id === r.playerId)?.name || 'A friend';
  let sending = false;
  const go = async (entered) => {
    if (sending) return;
    if (inReactionFight && !reactionControls(view, me)?.canHelp) { card.remove(); return; }
    sending = true;
    for (const button of card.querySelectorAll('button')) button.disabled = true;
    try {
      const res = await client.send({ t: 'roll.intervene', rollId: r.id, ...(entered ? { entered } : {}) });
      card.remove();
      const result = res?.result;
      if (!result) return;
      const label = `Intervene +${result.d6} · ${result.hit ? `${who} succeeds` : `${who} still misses`}`;
      if (result.receipt) showCombatReceipt(label, result.receipt);
      else toast(label, { ms: 3500 });
    } catch (err) { toast(err.message, { error: true }); card.remove(); }
  };
  const card = h('div.ivn', { role: 'dialog', 'aria-label': 'Intervene' },
    h('p', h('b', `${who}: near miss${r.vs?.name ? ` on ${r.vs.name}` : ''}!`)),
    h('p.dim', reaction ? `Add a d6 to their roll. ${reaction.canIntervene ? 'Use your prepared action.' : 'This spends 1 action.'}` : 'Add a d6 to their roll.'),
    h('div.ivn-row', [1, 2, 3, 4, 5, 6].map((n) => h('button.btn.num', { type: 'button', onclick: () => go(n) }, String(n))),
      diceOn() ? h('button.btn.btn-primary', { type: 'button', onclick: () => go(null) }, icon('dice', { size: 16 }), 'Roll d6') : null,
      h('button.btn.btn-quiet', { type: 'button', onclick: () => card.remove() }, 'No')));
  document.body.append(card);
  buzz([30, 30, 30]);
  setTimeout(() => card.remove(), 25_000);
}

/* ---------- first visit: friendly start instead of an empty sheet ---------- */

const startKey = () => `system.startSeen.${me?.id}`;
const startSeen = new Set();
function markStartSeen() {
  if (!me) return;
  startSeen.add(me.id);
  try { sessionStorage.setItem(startKey(), '1'); } catch { /* storage unavailable */ }
}
function renderStart() {
  const sh = me.sheet || {};
  // Fresh = nothing chosen yet. The starter attack (ruleset combat.starterAttack) does not count as chosen.
  const starter = view?.pack?.ruleset?.combat?.starterAttack?.skill;
  const ownSkills = (sh.skills || []).filter((s) => !starter || s.skillId !== starter);
  const empty = !!me.sheet && !sh.created && !sh.identity?.race && !sh.identity?.class && !ownSkills.length && !(sh.inventory || []).length;
  let seen = startSeen.has(me.id);
  try { seen ||= sessionStorage.getItem(startKey()) === '1'; } catch { /* storage unavailable */ }
  const box = $('#start');
  const show = empty && !seen;
  box.hidden = !show;
  $('#sheet-root').hidden = show;
  // Guided creation not finished yet: a strip above the sheet brings it back (draft kept on the phone).
  let strip = document.getElementById('cr-banner');
  const wantStrip = !show && sheet.currentPage() === 'sheet'
    && !!view?.pack?.ruleset?.creation && !sh.created && playerEditLevel(view) === 'sheet';
  if (wantStrip && !strip) {
    strip = h('div.cr-banner#cr-banner', icon('info', { size: 16 }), h('span', 'Your crawler is not finished: background, weapon, stats, stuff.'),
      h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => { const M = sheet.model(); if (M) openBuilder({ model: M, player: me, gm: false, act: sheet.act }); } }, 'Continue'));
    $('#sheet-root').before(strip);
  }
  if (strip) strip.hidden = !wantStrip;
  if (!show) return;
  const lvl = playerEditLevel(view);
  const name = sh.identity?.name || me.name;
  const sig = JSON.stringify([name, lvl, me.color]);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const look = () => { markStartSeen(); renderStart(); };
  box.replaceChildren(h('div.start-inner', { style: { '--me': me.color || 'var(--c-accent)' } },
    h('p.start-k', sysName()),
    h('h1.start-t', `Welcome, ${name}.`),
    lvl === 'sheet'
      ? [h('p.start-d', 'Build your crawler: who you are, your stats, your skills. It takes a few minutes and you can stop any time.'),
        h('button.btn.btn-primary.start-go', { type: 'button', onclick: () => { look(); const M = sheet.model(); if (M) openBuilder({ model: M, player: me, gm: false, act: sheet.act, allowOrigins: !!view?.session?.permissions?.allowOrigins }); } }, 'Build your crawler'),
        h('button.btn.btn-quiet.start-skip', { type: 'button', onclick: look }, 'Look at my sheet first')]
      : [h('p.start-d', 'Your GM will set you up. Keep this page open: your sheet appears here, and loot, achievements and messages pop up on this phone.'),
        h('button.btn.start-go', { type: 'button', onclick: look }, 'Look at my sheet')],
    h('p.start-tip', 'Tip: add this page to your home screen, so one tap brings you back.'),
  ));
}

const achSig = () => JSON.stringify(me?.achievements || []);
/** Maps the GM shared (server/maps.js): revealed part only; with the token layer on, drag your own token. */
function renderMaps() {
  phoneMapsEl ??= h('div.ph-maps');
  const maps = view.maps ?? [];
  const sig = JSON.stringify([view.campaign?.id, me?.id, maps]);
  if (phoneMapsSig === sig) return phoneMapsEl;
  phoneMapsSig = sig;
  const renderMap = (m) => {
    let row = phoneMapViews.get(m.id);
    if (!row) {
      row = { map: m };
      row.mv = createMapView({
        canMoveToken: (t) => t.kind === 'pc' && t.ref === me?.id,
        onTokenMove: (t, x, y) => client.send({ t: 'map.token.move', id: row.map.id, tokenId: t.id, x, y }).catch((err) => toast(err.message, { error: true })),
      });
      phoneMapViews.set(m.id, row);
    }
    row.map = m;
    row.mv.set(m, { labels: true });
    const mine = (m.tokens ?? []).some((t) => t.kind === 'pc' && t.ref === me?.id);
    return h('section.ph-map', h('h3', m.name),
      mine ? h('p.hint.ph-map-tip', 'Drag your figure to move it.') : h('button.btn.btn-primary.ph-map-place', { type: 'button',
        onclick: () => client.send({ t: 'map.token.move', id: m.id, x: 0.5, y: 0.5 }).catch((err) => toast(err.message, { error: true })) }, 'Put my figure on the map'),
      row.mv.el,
      m.zones.some((z) => z.text) ? h('ul.ph-map-zones', m.zones.filter((z) => z.text).map((z) => h('li', h('b', z.name), h('p', z.text)))) : null);
  };
  phoneMapsEl.replaceChildren(...(maps.length ? maps.map(renderMap) : [h('div.ph-map-empty', icon('map', { size: 40 }), h('b', 'Map not available'), h('p', 'It appears here when the GM shares one. Then you can move your own figure.'))]));
  return phoneMapsEl;
}

function renderAchievements() {
  const list = me.achievements || [];
  if (!list.length) return h('p.empty-s', 'No achievements yet. The System is watching.');
  return h('ul.ach-list', [...list].reverse().map((a) => h('li.ach',
    h('div.ach-top', h('b.ach-t', a.title), h('time', timeAgo(a.at))),
    a.desc ? h('p.ach-d', a.desc) : null,
    a.reward ? h('p.ach-r', h('span', 'Reward'), a.reward) : null,
  )));
}

const sysName = () => view?.pack?.systemName || 'The System';
const myMessages = () => me?.messages || me?.secrets || [];
const unreadCount = () => myMessages().filter((m) => !m.read && m.fromId !== me?.id).length;
const msgSig = () => JSON.stringify(myMessages().map((m) => [m.id, m.read]));
// Message centre: conversations with the GM and the other crawlers (the Messages tab).
const msgCenter = createMsgCenter({ role: 'player', send: (a) => client.send(a), getView: () => view });
msgCenter.setVisible(true);
function renderMessages() {
  queueMicrotask(msgCenter.update);
  return msgCenter.el;
}
document.addEventListener('visibilitychange', () => msgCenter.update());

let tickSig = '';
function renderTicker() {
  const feed = (view.feed || []).slice(-6);
  const sig = feed.map((e) => e.id).join();
  if (sig === tickSig) return;
  tickSig = sig;
  const t = $('#ticker');
  const items = feed.length ? feed.map((e) => e.text || e.kind) : [`${sysName()} is live`];
  t.replaceChildren(...items.map((x) => h('span', x)));
  t.style.setProperty('--dur', `${Math.max(20, items.join(' ').length * 0.25)}s`);
}

const seenMsgs = new Set();
function notifyMessage(e) {
  const legacy = e.kind === 'secret';
  const id = legacy ? (e.messageId || e.id) : e.id;
  const addressed = legacy ? e.playerId === me.id : e.to === 'all' || (Array.isArray(e.to) && e.to.includes(me.id));
  if (!addressed || !id || e.fromId === me.id || seenMsgs.has(id)) return;
  seenMsgs.add(id);
  if (seenMsgs.size > 400) seenMsgs.delete(seenMsgs.values().next().value);
  const thread = legacy ? me.id : threadKey(e.to);
  const privateLine = thread === me.id;
  if (privateLine) buzz([200, 100, 200]);
  if (msgCenter.isReading(thread)) return;
  if (privateLine) toast('Private message from the GM.');
  else toast(thread === 'all' ? 'New message to everyone.' : 'New group message.');
}

let lastRecap = null;
function maybeRecap(text) {
  const t = String(text || '').trim();
  if (lastRecap === null) {
    let seen = null;
    try { seen = localStorage.getItem('system.recapSeen'); } catch {}
    lastRecap = t;
    if (!t || seen === t) return;
  } else if (!t || t === lastRecap) { lastRecap = t; return; }
  lastRecap = t;
  try { localStorage.setItem('system.recapSeen', t); } catch {}
  enqueueTakeover({ kind: 'recap', text: t });
}

/* ---------- takeovers ---------- */

const toQueue = [];
let toBusy = false;

function enqueueTakeover(e) {
  toQueue.push(e);
  if (!toBusy) nextTakeover();
}

function nextTakeover() {
  const e = toQueue.shift();
  const el = $('#takeover');
  if (!e) { toBusy = false; el.hidden = true; el.replaceChildren(); return; }
  toBusy = true;
  const reduced = prefersReducedMotion();
  el.hidden = false;
  el.onclick = null;
  let ready = false;
  const dismissable = (delay) => setTimeout(() => {
    ready = true;
    el.append(h('p.to-hint', { style: { position: 'absolute', bottom: '28px', left: 0, right: 0 } }, 'Tap anywhere to close'));
  }, delay);
  el.onclick = () => {
    if (!ready) return;
    if (e.kind === 'loot') savePendingLoot(pendingLoot().filter((card) => card.id !== e.id));
    nextTakeover();
  };

  if (e.kind === 'gift') {
    // Playtest 26 Nov: a GM gift landed silently in the inventory. Same card style as loot, no box to open.
    buzz([30, 30, 120]);
    const r = rarityOf(e.item?.rarity);
    el.style.setProperty('--glow', `var(--r-${r})`);
    markNewItem(me?.id, e.item?.uid);
    sheet.redraw();
    el.replaceChildren(h('div.to-inner',
      myFace(),
      h('div.to-kicker', 'You received'),
      h('div.reveal', { class: `reveal r-${r}` },
        itemArt(e.item || {}),
        h('div.meta', h('span.nm', `${e.item?.name || 'Something'}${(e.qty ?? 1) > 1 ? ` × ${e.qty}` : ''}`), e.item?.desc ? h('p.ds', e.item.desc) : null, e.item?.flavor ? h('p.flavor', e.item.flavor) : null)),
      h('p.to-hint', 'It is in your Inventory now, marked NEW.')));
    dismissable(reduced ? 200 : 900);
  } else if (e.kind === 'item.broken') {
    buzz([80, 40, 100]);
    el.replaceChildren(h('div.to-inner', h('h2', `Your ${e.name} shattered`)));
    dismissable(200);
  } else if (e.kind === 'achievement') {
    buzz([60, 40, 60, 40, 200]);
    el.style.setProperty('--glow', 'var(--cyan)');
    el.replaceChildren(h('div.to-inner.to-ach',
      myFace(),
      h('div.to-kicker', view.pack?.notifyPrefix || 'New achievement!'),
      h('div.sys.ach-box', { 'data-head': sysName().toUpperCase() },
        h('p.sys-title', e.title),
        e.desc ? h('div.sys-scroll', h('p.sys-desc', e.desc)) : null,
        e.reward ? h('p.reward', h('b', 'Reward: '), e.reward) : null,
      ),
    ));
    // Long text scrolls inside the box; tapping outside the box dismisses.
    el.querySelector('.sys-scroll')?.addEventListener('click', (ev) => ev.stopPropagation());
    dismissable(reduced ? 200 : 1500);
  } else if (e.kind === 'loot' || e.kind === 'sponsor') {
    buzz([30, 30, 30, 30, 30, 30, 300]);
    const tier = view.pack?.lootTiers?.find((t) => t.id === e.tier);
    const r = rarityOf(e.item?.rarity);
    el.style.setProperty('--glow', `var(--r-${r})`);
    const box = h('div.box', { style: { '--t': tier?.color || 'var(--acid)' } }, h('div.body'), h('div.lid'));
    const kicker = e.kind === 'sponsor' ? `${e.sponsor || 'A sponsor'} sent you a gift` : (tier?.name || 'Loot box');
    const inner = h('div.to-inner', myFace(), h('div.to-kicker', kicker), h('div.box-wrap', box));
    el.replaceChildren(inner);
    const reveal = () => {
      inner.replaceChildren(
        h('div.to-kicker', { style: { background: `var(--r-${r})` } }, r),
        h('div.reveal', { class: `reveal r-${r}` },
          itemArt(e.item || {}),
          h('div.meta', h('span.nm', e.item?.name || 'Something'), e.item?.desc ? h('p.ds', e.item.desc) : null, e.item?.flavor ? h('p.flavor', e.item.flavor) : null),
        ),
      );
      buzz(r === 'legendary' || r === 'epic' ? [100, 50, 100, 50, 400] : 120);
      ready = true;
      if (e.count) inner.append(h('p', `Item ${e.number} of ${e.count}${e.gold ? ` · +${e.gold} gold in this box` : ''}`));
      inner.append(h('button.btn', { type: 'button' }, e.number < e.count ? 'Next item' : 'Close item details'));
    };
    if (reduced) { reveal(); } else {
      requestAnimationFrame(() => box.classList.add('shake'));
      setTimeout(() => { box.classList.remove('shake'); box.classList.add('open'); }, 1300);
      setTimeout(reveal, 1750);
    }
  } else if (e.kind === 'recap') {
    buzz([60, 40, 60]);
    el.style.setProperty('--glow', 'var(--acid)');
    el.replaceChildren(h('div.to-inner.to-ach',
      h('div.to-kicker', { style: { background: 'var(--acid)' } }, 'Previously on'),
      h('div.sys.ach-box', { 'data-head': sysName().toUpperCase() },
        h('div.sys-scroll', h('p.sys-desc', e.text)),
      ),
    ));
    el.querySelector('.sys-scroll')?.addEventListener('click', (ev) => ev.stopPropagation());
    dismissable(reduced ? 200 : 1500);
  } else {
    nextTakeover();
  }
}

/** The crawler's own picture on takeovers (if they uploaded one). */
function myFace() {
  const url = portraitSrc(me?.sheet?.portrait);
  return url ? h('img.to-face', { src: url, alt: '' }) : null;
}

/* ---------- wake lock ---------- */

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => { if (everJoined) requestWakeLock(); });

/* ---------- boot ---------- */

/** Attach a transport and start. The hosted edition skips the PIN keypad entirely. */
export function mountPlay(transport, opts = {}) {
  ext.hosted = !!opts.hosted;
  ext.saveNotes = opts.saveNotes || null;
  document.body.classList.toggle('hosted', ext.hosted);
  if (ext.hosted) {
    everJoined = true;
    $('#join').hidden = true;
    $('#leave').hidden = true;
  }
  client.attach(transport);
  transport.connect?.();
  return { client };
}

async function loadJoinInfo() {
  try {
    const response = await fetch('/api/info', { cache: 'no-store' });
    if (!response.ok) return;
    const info = await response.json();
    cloud = info.legacy === false;
    campaign = info.campaign || null;
  } catch {}
}

function bootNode() {
  const transport = new SystemClient({
    hello: () => token ? { role: 'player', token }
      : claimName ? { role: 'player', claim: true, name: claimName, campaignId: claimCampaignId }
        : { role: 'player', room, pin },
  });
  client.attach(transport);
  const rejoin = (label) => {
    $('#join-returning').hidden = true;
    $('#reconnect').hidden = false;
    $('#reconnect .sys-title').textContent = 'Rejoining.';
    $('#reconnect-msg').textContent = label;
    everJoined = true;
    client.connect();
  };
  client.on('welcome', () => { $('#reconnect .sys-title').textContent = 'Signal lost.'; });
  if (token) rejoin('Opening your crawler');
  loadJoinInfo().then(() => {
    if (pathToken) {
      if (!token && !everJoined && !$('#claim').hidden) showClaim($('#claim-err').textContent);
      return;
    }
    const savedToken = store.get('localStorage', TOKEN_KEY) || '';
    const hasRoom = !!params.get('room');
    if (!invitedCampaign && !hasRoom && (savedToken || (room && pin))) {
      $('#return-title').textContent = saved.campaignName ? `Return to ${saved.campaignName}` : 'Welcome back';
      $('#join-returning').hidden = false;
      $('#return-continue').onclick = () => {
        token = savedToken;
        rejoin(token ? 'Opening your crawler' : `Room ${room}`);
      };
      $('#return-switch').onclick = openAnotherCampaign;
    } else if (cloud || location.pathname === '/join') {
      showClaim();
    } else {
      showJoin();
    }
  });
  registerSW();
}

if (!isHosted()) bootNode();
