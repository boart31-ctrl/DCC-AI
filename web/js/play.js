import {
  SystemClient, TransportHub, store, buzz, h, toast, itemArt, fmtNum, timeAgo, rarityOf,
  prefersReducedMotion, registerSW, isHosted, ask, portraitSrc,
} from './client.js';
import { createSheet, localRolls, onLocalRoll } from './sheet.js';
import { createMapView } from './map-view.js';
import { createRxPhone } from './rx-phone.js';
import { openBuilder as openPlainBuilder } from './builder.js';
import { openCreator, hasCreator } from './creator.js';
// Rulesets with guided creation (ruleset.creation) get the step-by-step creator; others the plain builder.
const openBuilder = (o) => (hasCreator(o.model) ? openCreator(o) : openPlainBuilder(o));
import { createDiceLog, showRollCard } from './dicelog.js';
import { icon, applyTheme, toggleTheme, applyAccent, applyPackTheme, openDrawer, closeDrawer, dieFaces, spellCooldownHint } from './ui.js';
import { playerEditLevel } from './rules.js';
import { crawlerClock, fmtFull, fmtCompact, skullSvg } from './crawlers.js';
import { createMsgCenter } from './msgcenter.js';
import { createRollPad } from './rollpad.js';

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
  replayMissed(v);
});

client.on('event', (e) => {
  if (!me) return;
  if (e.kind === 'roll') {
    const r = e.roll || e;
    if (r.playerId === me.id && !r.vs && !r.card) showRollCard(r, { meId: me.id });
    // A friend's near miss (seven degrees): offer to Intervene with +1d6.
    if (!r.partyCheck && r.playerId && r.playerId !== me.id && r.vs?.deg7 === 'near' && r.vs.damage === undefined) intervenePrompt(r);
    return;
  }
  if (e.kind === 'rx.react') {
    const self = view?.combat?.combatants.find((x) => x.type === 'crawler' && x.playerId === me.id);
    if (self && e.targets?.includes(self.uid)) {
      buzz([50, 45, 100]);
      toast('You are targeted. Open Combat to react before the attacks land.', { ms: 6000 });
    }
    return;
  }
  if (e.kind === 'dying' && e.playerId === me.id) { buzz([80, 60, 80, 60, 80]); toast(`You are dying: ${e.rounds} round${e.rounds === 1 ? '' : 's'} left. Someone has to heal you to 10 %.`, { error: true, ms: 7000 }); return; }
  if (e.kind === 'levelup') { buzz([40, 30, 40, 30, 120]); toast(`Level up! The System approves of your continued survival.`, { ms: 5000 }); return; }
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
  if (e.kind === 'combat.hit' && e.type === 'crawler' && e.playerId === me.id) return;
  // The event can land before the view that puts me in the fight: open the pad on the next render instead.
  if (e.kind === 'combat.start' && e.initiative) { if (waitingForMe()) initPrompt(); else initWanted = Date.now(); return; }
  if (e.kind === 'combat.turn') {
    if (e.current?.playerId === me.id) yourTurn(e);
    else if (e.next?.playerId === me.id) { buzz(30); toast("You're next", { ms: 3000 }); }
    return;
  }
  if (e.kind === 'message' && e.fromId && e.fromId !== 'gm') {
    // Crawler chatter: no takeover, a nudge unless the conversation is already open.
    if (e.fromId !== me.id && !msgCenter.el.isConnected) { buzz(12); toast(`${e.from || 'A crawler'} wrote ${e.to === 'all' ? 'to everyone' : 'to you'}`); }
    return;
  }
  if (e.kind === 'secret' || e.kind === 'message') {
    // Group messages may target everyone (no playerId, or a list). The text arrives in the next view.
    const forMe = !e.playerId || e.playerId === me.id || (Array.isArray(e.to) && (e.to.includes(me.id) || e.to.includes('all'))) || e.to === 'all' || e.group;
    // The server sends `message` (new) and, for private ones, the legacy `secret` too: handle each message once.
    const mid = e.kind === 'message' ? e.id : (e.messageId || e.id);
    if (forMe && !seenMsgs.has(mid)) { seenMsgs.add(mid); awaitMessage(e); }
    return;
  }
  if (e.playerId !== me.id) return;
  if (['achievement', 'loot', 'sponsor'].includes(e.kind)) {
    if (e.id && seenLoad()?.has(e.id)) return; // the view got here first and already played it
    markSeen(e.id);
    enqueueTakeover(e);
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
function replayMissed(v) {
  if (!me) return;
  const mine = (v.feed || []).filter((f) => f.playerId === me.id && f.replay && ['achievement', 'loot', 'sponsor'].includes(f.kind));
  if (!seenLoad()) { for (const f of mine) markSeen(f.id); if (!mine.length) markSeen('_init'); return; }
  const now = v.now || Date.now();
  for (const f of mine) {
    if (seenSet.has(f.id)) continue;
    markSeen(f.id);
    if (now - f.at > REPLAY_MS) continue;
    enqueueTakeover({ id: f.id, kind: f.kind, playerId: me.id, ...f.replay, replayed: true });
  }
}

/* ---------- render ---------- */

const rollPad = createRollPad({ send: (a) => client.send(a), getView: () => view, getMe: () => me });
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

const sheet = createSheet({
  mode: 'player',
  send: (a) => client.send(a),
  onRoll: (what, label) => rollPad.open(what, label),
  rollsOn: diceOn,
  extraTabs: () => (me ? [
    { id: 'combat', label: 'Combat', phoneSection: true, render: () => combatPanel },
    { id: 'ach', label: 'Achievements', count: me.achievements?.length || '', sig: achSig(), render: renderAchievements },
    { id: 'msg', label: 'Messages', badge: unreadCount() || '', sig: msgSig(), render: renderMessages },
    ...((view?.maps || []).length ? [{ id: 'maps', label: 'Maps', count: view.maps.length, sig: JSON.stringify(view.maps), render: renderMaps }] : []),
  ] : []),
  onBuilder: (model, p) => openBuilder({ model, player: p, gm: false, act: sheet.act, allowOrigins: !!view?.session?.permissions?.allowOrigins }),
  // Phones: app layout (sticky crawler bar, section tabs); the app bar items move into the menu.
  phone: () => phoneMq.matches,
  top: () => [h('span.ph-live', h('span.live-dot', { 'aria-hidden': 'true' }), `${fmtNum(view?.audience?.viewers ?? 0)} watching`),
    h('span.ph-crawlers.js-crawlers', { 'data-fmt': 'compact', title: 'Crawlers still alive in the dungeon' })],
  moreItems: () => [
    { icon: 'dice', label: 'Dice on this phone', sub: DICE_LABEL[me?.diceMode ?? 'enter'], onClick: () => setDiceMode({ off: 'enter', enter: 'digital', digital: 'off' }[me?.diceMode ?? 'enter']) },
    { icon: 'dice', label: 'Dice log', sub: 'Every roll at the table', onClick: () => setLogOpen(true) },
    { icon: 'book', label: 'Rules', sub: view?.pack?.ruleset?.system?.short || 'How this game is played', onClick: openRules },
    // Printable cheat sheets from the pack (pack.json "cheats", player ones only).
    ...(view?.pack?.cheats || []).map((c) => ({ icon: 'info', label: c.label, sub: 'Cheat sheet: one page, also printable', onClick: () => window.open(c.url, '_blank', 'noopener') })),
    { icon: 'sun', label: 'Theme', sub: 'Dark, light or neon', onClick: () => { toggleTheme(); drawTheme(); } },
    ext.hosted ? null : { icon: 'x', label: 'Switch campaign', sub: 'You can come back with your QR code', onClick: () => $('#leave').click() },
  ].filter(Boolean),
});
// Combat is a sheet tab on small and large screens. Keep the reaction panel mounted while it updates.
const rxPhone = createRxPhone({ send: (a) => client.send(a), toast, onAttack: () => rollPad.openPicker({ attacksOnly: true }) });
const combatBar = h('div.pl-combat-bar');
const combatRoster = h('div.pl-combat-roster');
const combatPanel = h('section.pl-combat', { 'aria-label': 'Combat' }, combatBar, rxPhone.el, combatRoster);
const combatPrompt = h('button.btn.btn-primary.combat-prompt', { type: 'button', hidden: true, onclick: openCombat }, icon('swords', { size: 18 }), 'Under attack · Combat');
document.body.append(combatPrompt);
let combatKey = '';

function openCombat() {
  sheet.setTab('combat');
  if (phoneMq.matches) combatPanel.scrollIntoView({ block: 'start' });
}

function drawCombat() {
  const c = view?.combat;
  const own = c?.combatants?.find((x) => x.type === 'crawler' && x.playerId === me.id);
  const active = !!c?.active;
  const rx = c?.rx;
  const standing = own && !own.down && !own.dead && own.dying == null;
  const targeted = active && standing && rx?.step === 'react' && rx.decls.some((d) => d.targetUid === own.uid && !d.result && !d.caught && (!d.evade || d.canReroll));
  combatPrompt.hidden = !targeted;
  rxPhone.update(view, me);
  const mobs = active ? c.combatants.filter((x) => x.type === 'mob') : [];
  const isMyTurn = c?.init?.turnUid === own?.uid && !!own;
  const canStrike = active && standing && (!rx || (rx.step === 'act' && (rx.acts[own.uid] ?? 2) > 0));
  const hasSpells = !!me.sheet?.spells?.length;
  const rs = view?.pack?.ruleset;
  const canUse = rx && standing && (rx.acts[own.uid] + (rx.nonAttackActions?.[own.uid] ?? 0)) > 0;
  const ready = new Set(me.sheet?.hotlist ?? []);
  const hpTrack = rs?.tracks?.find((t) => t.kind === 'slots')?.id;
  const quickItems = rs?.hotlist?.combat && canUse ? (me.sheet?.inventory ?? []).filter((i) => ready.has(i.uid) && i.use
    && (rx.step === 'act' || (rx.step === 'react' && i.tags?.includes('potion') && i.use.heal?.track === hpTrack))) : [];
  const quickSpells = rs?.hotlist?.combat && canUse ? (me.sheet?.spells ?? []).filter((s) => ready.has(s.uid) && !s.attackCheck
    && (rx.step === 'act' || (rx.step === 'react' && (s.healing || s.tags?.includes('interrupt'))))) : [];
  const mana = me.sheet?.computed?.tracks;
  const costs = me.sheet?.computed?.spells;
  const needsInitiative = waitingForMe();
  const key = JSON.stringify([active, own?.uid, own?.down, c?.round, c?.phase, isMyTurn, canStrike, hasSpells, needsInitiative, mobs, quickItems, quickSpells, mana, costs]);
  if (key === combatKey) return;
  combatKey = key;
  const quick = [
    ...quickSpells.map((s) => {
      const t = costs?.find((row) => row.uid === s.uid);
      const affordable = (t?.cost.value ?? 0) <= (mana?.[t?.costTrack]?.cur ?? 0);
      const cooldown = spellCooldownHint(t?.cooldown);
      return h('button.btn', { type: 'button', disabled: !affordable || !!cooldown, onclick: () => sheet.castReadySpell(s.uid) },
        icon('bolt', { size: 14 }), cooldown ? `${s.name} · ${cooldown}` : s.name);
    }),
    ...quickItems.map((i) => h('div.pl-quick-item',
      h('button.btn', { type: 'button', onclick: () => sheet.useReadyItem(i.uid) }, `${i.name} · ${i.qty}`),
      i.tags?.includes('potion') ? h('button.icon-btn', {
        type: 'button', 'aria-label': `Give ${i.name} to an ally`, onclick: () => sheet.choosePotionRecipient(i.uid),
      }, icon('users', { size: 15 })) : null)),
  ];
  combatBar.replaceChildren(h('div.pl-combat-head', h('h2', 'Combat'),
    !active || rx ? null : h('span.pill', isMyTurn ? 'Your turn' : c.init?.on ? `Round ${c.round} · ${c.phase || 'Initiative'}` : `Round ${c.round}`)),
    !active ? h('p.dim', 'The GM hasn’t started a fight yet.') : !own ? h('p.dim', 'You haven’t joined this fight.') : null,
    active && own ? h('div.pl-combat-actions',
      needsInitiative ? h('button.btn.btn-primary', { type: 'button', onclick: initPrompt }, 'Roll initiative') : null,
      canStrike && !rx ? h('button.btn.btn-primary', { type: 'button', onclick: () => rollPad.openPicker({ attacksOnly: true }) }, icon('swords', { size: 16 }), 'Attack') : null,
      hasSpells ? h('button.btn', { type: 'button', onclick: () => sheet.setTab('spells') }, 'Spells') : null,
      h('button.btn', { type: 'button', onclick: () => sheet.setTab('inventory') }, 'Inventory')) : null,
    quick.length ? h('section.pl-quick', { 'aria-label': 'Hotlist' }, h('h3', 'Hotlist'), h('div.pl-combat-actions', quick)) : null);
  combatRoster.replaceChildren(!active ? '' : h('h3', 'Targets'),
    active && !mobs.length ? h('p.dim', 'No revealed enemies.') : '',
    mobs.length ? h('ul.pl-targets', mobs.map((m) => {
      const label = m.down ? 'Defeated' : m.hpMax != null ? `${m.hp}/${m.hpMax} ${m.slotValue != null ? 'slots' : 'HP'}` : `${Math.round(100 * (m.hpPct ?? 1))}%`;
      const body = [itemArt({ name: m.name, image: m.image }, 'pl-target-art'), h('span', h('b', m.name), h('small.dim', label))];
      return h('li', canStrike && !m.down
        ? h('button.btn.pl-target', { type: 'button', 'aria-label': `Attack ${m.name}`, onclick: () => rollPad.openPicker({ target: m.uid, attacksOnly: true }) }, body, icon('chevron', { size: 15 }))
        : h('div.pl-target', body));
    })) : '');
}
const phoneMq = matchMedia('(max-width: 699px)');
phoneMq.addEventListener?.('change', () => { if (me) sheet.redraw(); });
$('#sheet-root').append(sheet.el);

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
  $('#brand').textContent = sysName();
  $('#viewers').textContent = fmtNum(view.audience?.viewers ?? 0);
  crClock.set(view.crawlers);
  tickCrawlers();
  applyAccent(view.pack);
  applyPackTheme(view.pack?.theme);
  drawTheme();
  renderPrivateChecks();
  drawCombat();
  sheet.update(view, me);
  iniPrompt.hidden = !waitingForMe();
  if (initWanted && waitingForMe()) { initWanted = 0; initPrompt(); } else if (initWanted && Date.now() - initWanted > 10_000) initWanted = 0;
  if (!waitingForMe()) document.querySelector('.ini-pad')?.remove();
  rollPad.update();
  rollFab.hidden = (!diceOn() && !inFight()) || !!view.combat?.rx;
  renderStart();
  renderLog();
  renderTicker();
}

let checkDrawer = null;
let openCheck = null;

function renderPrivateChecks() {
  const prompts = view.checkPrompts ?? [];
  const el = $('#prep-prompts');
  if (checkDrawer?.open && !prompts.some((p) => p.id === openCheck)) closeDrawer();
  el.hidden = !prompts.length;
  el.replaceChildren(...prompts.map((p) => h('div.panel.prep-prompt', h('b', p.label || 'Private check'),
    h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => openPrivateCheck(p) }, icon('dice', { size: 14 }), `Roll ${p.ability}`))));
}

function openPrivateCheck(p) {
  const send = async (entered) => {
    if (!checkDrawer?.open) return;
    const dialog = checkDrawer;
    const buttons = [...dialog.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') !== 'Close');
    if (buttons.some((b) => b.disabled)) return;
    buttons.forEach((b) => { b.disabled = true; });
    try {
      await client.send({ t: 'prep.check.reply', id: p.id, ...(entered === undefined ? {} : { entered }) });
      if (dialog.open) closeDrawer();
      toast('Check sent to the GM.');
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
  const who = (view?.players || []).find((p) => p.id === r.playerId)?.name || 'A friend';
  const go = async (entered) => {
    try {
      const res = await client.send({ t: 'roll.intervene', rollId: r.id, ...(entered ? { entered } : {}) });
      card.remove();
      toast(res?.result?.hit ? `+${res.result.d6}: ${who} makes it!` : `+${res?.result?.d6}: still not enough.`, { ms: 3500 });
    } catch (err) { toast(err.message, { error: true }); card.remove(); }
  };
  const card = h('div.ivn', { role: 'dialog', 'aria-label': 'Intervene' },
    h('p', h('b', `${who}: near miss${r.vs?.name ? ` on ${r.vs.name}` : ''}!`)),
    h('p.dim', 'Intervene: roll a d6 and add it to their roll (one action). Tap what your die shows, or let the phone roll.'),
    h('div.ivn-row', [1, 2, 3, 4, 5, 6].map((n) => h('button.btn.num', { type: 'button', onclick: () => go(n) }, String(n))),
      h('button.btn.btn-primary', { type: 'button', onclick: () => go(null) }, icon('dice', { size: 16 }), 'Roll'),
      h('button.btn.btn-quiet', { type: 'button', onclick: () => card.remove() }, 'No')));
  document.body.append(card);
  buzz([30, 30, 30]);
  setTimeout(() => card.remove(), 25_000);
}

/* ---------- first visit: friendly start instead of an empty sheet ---------- */

const startKey = () => `system.startSeen.${me?.id}`;
function renderStart() {
  const sh = me.sheet || {};
  // Fresh = nothing chosen yet. The starter attack (ruleset combat.starterAttack) does not count as chosen.
  const starter = view?.pack?.ruleset?.combat?.starterAttack?.skill;
  const ownSkills = (sh.skills || []).filter((s) => !starter || s.skillId !== starter);
  const empty = !!me.sheet && !sh.created && !sh.identity?.race && !sh.identity?.class && !ownSkills.length && !(sh.inventory || []).length;
  let seen = false;
  try { seen = sessionStorage.getItem(startKey()) === '1'; } catch {}
  const box = $('#start');
  const show = empty && !seen;
  box.hidden = !show;
  $('#sheet-root').hidden = show;
  // Guided creation not finished yet: a strip above the sheet brings it back (draft kept on the phone).
  let strip = document.getElementById('cr-banner');
  const wantStrip = !show && !!view?.pack?.ruleset?.creation && !sh.created && playerEditLevel(view) === 'sheet';
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
  const look = () => { try { sessionStorage.setItem(startKey(), '1'); } catch {} renderStart(); };
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
        canMoveToken: (t) => row.map.tokensOn && t.kind === 'pc' && t.ref === me?.id,
        onTokenMove: (t, x, y) => client.send({ t: 'map.token.move', id: row.map.id, tokenId: t.id, x, y }).catch((err) => toast(err.message, { error: true })),
      });
      phoneMapViews.set(m.id, row);
    }
    row.map = m;
    row.mv.set(m, { labels: true });
    return h('section.ph-map', h('h3', m.name), row.mv.el,
      m.zones.some((z) => z.text) ? h('ul.ph-map-zones', m.zones.filter((z) => z.text).map((z) => h('li', h('b', z.name), h('p', z.text)))) : null);
  };
  phoneMapsEl.replaceChildren(...(maps.length ? maps.map(renderMap) : [h('p.empty-s', 'No maps shared.')]));
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
const isGroup = (m) => !!(m.group || m.to === 'all' || (Array.isArray(m.to) && m.to.includes('all')));
const unreadCount = () => myMessages().filter((m) => !m.read && m.fromId !== me?.id).length;
const msgSig = () => JSON.stringify(myMessages().map((m) => [m.id, m.read]));
// Message centre: conversations with the GM and the other crawlers (the Messages tab).
const msgCenter = createMsgCenter({ role: 'player', send: (a) => client.send(a), getView: () => view });
msgCenter.setVisible(true);
function renderMessages() {
  msgCenter.update();
  return msgCenter.el;
}

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
function awaitMessage(e) {
  const known = new Set(myMessages().map((m) => m.id));
  const deliver = () => {
    const list = myMessages();
    const mid = e.kind === 'message' ? e.id : (e.messageId || e.id);
    const m = list.find((x) => x.id === mid)
      || [...list].reverse().find((x) => !known.has(x.id))
      || [...list].reverse().find((x) => !x.read)
      || (e.text ? { text: e.text, from: e.from, group: e.group } : null);
    const grp = e.group ?? (m ? isGroup(m) : false);
    enqueueTakeover({ ...e, kind: 'secret', _group: grp, _msg: m });
  };
  let done = false;
  const off = client.on('view', () => { if (!done) { done = true; off(); setTimeout(deliver, 0); } });
  setTimeout(() => { if (!done) { done = true; off(); deliver(); } }, 600);
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
  el.classList.remove('banner');
  const reduced = prefersReducedMotion();
  el.hidden = false;
  el.onclick = null;
  let ready = false;
  const dismissable = (delay) => setTimeout(() => {
    ready = true;
    el.append(h('p.to-hint', { style: { position: 'absolute', bottom: '28px', left: 0, right: 0 } }, 'Tap anywhere to close'));
  }, delay);
  el.onclick = () => { if (ready) nextTakeover(); };

  if (e.kind === 'achievement') {
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
      dismissable(reduced ? 200 : 900);
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
  } else if (e.kind === 'secret' && e._group) {
    buzz([80, 60, 80]);
    el.style.setProperty('--glow', 'var(--magenta)');
    el.classList.add('banner');
    const close = () => { if (el.classList.contains('banner')) { el.classList.remove('banner'); nextTakeover(); } };
    el.replaceChildren(h('div.to-banner',
      h('span.tag', 'TO ALL CRAWLERS'),
      h('p.bn-from', e._msg?.from || sysName()),
      h('p.bn-text', e._msg?.text || 'New message for everyone.'),
      h('p.to-hint', 'Tap to close'),
    ));
    el.onclick = close;
    setTimeout(close, Math.min(14000, 5000 + (e._msg?.text || '').split(/\s+/).length * 250));
  } else if (e.kind === 'secret') {
    buzz([200, 100, 200]);
    el.style.setProperty('--glow', 'var(--magenta)');
    el.replaceChildren(h('div.to-inner',
      h('div.envelope', { 'aria-hidden': 'true' }, '✉'),
      h('div.to-kicker', { style: { background: 'var(--magenta)' } }, 'Private message'),
      h('p', 'Someone wants a word. Only you can read it.'),
      h('button.btn.btn-hot', {
        type: 'button',
        onclick: (ev) => {
          ev.stopPropagation();
          sheet.setTab('msg');
          nextTakeover();
        },
      }, 'Open messages'),
    ));
    dismissable(400);
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
