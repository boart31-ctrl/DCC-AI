import {
  SystemClient, TransportHub, store, buzz, h, toast, itemArt, fmtNum, timeAgo, rarityOf,
  prefersReducedMotion, registerSW, isHosted, ask, portraitSrc,
} from './client.js';
import { createSheet, localRolls, onLocalRoll } from './sheet.js';
import { openBuilder } from './builder.js';
import { createDiceLog, showRollCard } from './dicelog.js';
import { icon, applyTheme, toggleTheme, applyAccent, applyPackTheme } from './ui.js';
import { playerEditLevel } from './rules.js';
import { crawlerClock, fmtFull, fmtCompact, skullSvg } from './crawlers.js';
import { createMsgCenter } from './msgcenter.js';

const $ = (s, r = document) => r.querySelector(s);
const KEY = 'system.player';

/* ---------- room + PIN ---------- */

const params = new URLSearchParams(location.search);
let saved = {};
try { saved = JSON.parse(store.get('localStorage', KEY) || '{}') || {}; } catch { saved = {}; }
let room = (params.get('room') || saved.room || '').toUpperCase();
let pin = saved.room === room ? (saved.pin || '') : '';
let entry = '';
// Personal link: /p/<token> (QR from the GM). Stored so "Add to Home Screen" (start_url /play) still works.
const TOKEN_KEY = 'system.playerToken';
const pathToken = (/^\/p\/([A-Za-z0-9_-]{16,128})\/?$/.exec(location.pathname) || [])[1] || '';
if (pathToken) store.set('localStorage', TOKEN_KEY, pathToken);
let token = pathToken || store.get('localStorage', TOKEN_KEY) || '';
let claimName = ''; // set while asking the GM to let us in
let cloud = false; // server has no room/PIN login (Cloudflare edition)

const client = new TransportHub();
/** Hosted edition hooks: notes storage and read-state live outside the engine there. */
export const ext = { hosted: false, saveNotes: null };

let view = null;
let me = null;
let everJoined = false;

function remember() {
  store.set('localStorage', KEY, JSON.stringify({ room, pin }));
}
function forget() {
  store.del('localStorage', KEY);
  store.del('localStorage', TOKEN_KEY);
  token = '';
}

function showClaim(err = '', waiting = false) {
  $('#claim').hidden = false;
  $('#join').hidden = true;
  $('#app').hidden = true;
  $('#reconnect').hidden = true;
  $('#claim-form').hidden = waiting;
  $('#claim-wait').hidden = !waiting;
  $('#claim-pin').hidden = cloud;
  $('#claim-err').textContent = err;
  if (!waiting) setTimeout(() => $('#claim-name').focus(), 50);
}

function claimChars(list, requestId) {
  let picked = null;
  const draw = () => $('#claim-chars').replaceChildren(...list.map((c) => h('button.claim-char', {
    type: 'button', style: { '--cc': c.color }, 'aria-pressed': String(picked === c.id),
    onclick: () => { picked = c.id; client.raw({ t: 'claim.pick', playerId: c.id }); draw(); buzz(8); },
  }, h('span.cdot', { 'aria-hidden': 'true' }), c.name, c.connected ? h('small', 'already playing') : null)));
  draw();
  $('#claim-status').textContent = list.length ? 'Waiting for the GM to let you in. Pick your crawler meanwhile.' : 'Waiting for the GM to let you in.';
  $('#claim-wait').dataset.request = requestId;
}

function showJoin(err = '') {
  if (cloud) return showClaim(err);
  $('#claim').hidden = true;
  $('#join').hidden = false;
  $('#app').hidden = true;
  $('#reconnect').hidden = true;
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
  showClaim('', true);
  $('#claim-chars').replaceChildren();
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
  if (m.t === 'claim') claimChars(m.characters || [], m.requestId);
  else if (m.t === 'token' && typeof m.token === 'string') {
    // The GM let us in: from now on this phone uses the personal link.
    token = m.token;
    claimName = '';
    store.set('localStorage', TOKEN_KEY, token);
  }
});

$('#leave').addEventListener('click', async () => {
  if (!(await ask('Leave on this phone? You can rejoin with your QR code (or PIN).', { ok: 'Leave' }))) return;
  forget();
  claimName = '';
  pin = '';
  everJoined = false;
  client.close();
  showJoin();
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
    pin = '';
    claimName = '';
    forget();
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

client.on('welcome', () => {
  everJoined = true;
  remember();
  // Keep the personal link in the address bar so "Add to Home Screen" saves it.
  if (token && !location.pathname.startsWith('/p/')) {
    try { history.replaceState(null, '', `/p/${token}`); } catch {}
  }
  $('#claim').hidden = true;
  $('#join').hidden = true;
  $('#app').hidden = false;
  $('#reconnect').hidden = true;
  requestWakeLock();
});

client.on('view', (v) => {
  view = v;
  const prev = me;
  me = v.me || null;
  if (!me) return;
  render();
  msgCenter.update();
  maybeRecap(v.recap);
});

client.on('event', (e) => {
  if (!me) return;
  if (e.kind === 'roll') { const r = e.roll || e; if (r.playerId === me.id) showRollCard(r, { meId: me.id }); return; }
  if (e.kind === 'stat') return;
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
  if (['achievement', 'loot', 'sponsor'].includes(e.kind)) enqueueTakeover(e);
});

/* ---------- render ---------- */

const sheet = createSheet({
  mode: 'player',
  send: (a) => client.send(a),
  extraTabs: () => (me ? [
    { id: 'ach', label: 'Achievements', count: me.achievements?.length || '', sig: achSig(), render: renderAchievements },
    { id: 'msg', label: 'Messages', badge: unreadCount() || '', sig: msgSig(), render: renderMessages },
  ] : []),
  onBuilder: (model, p) => openBuilder({ model, player: p, gm: false, act: sheet.act, allowOrigins: !!view?.session?.permissions?.allowOrigins }),
  // Phones: app layout (sticky crawler bar, section tabs); the app bar items move into the menu.
  phone: () => phoneMq.matches,
  top: () => [h('span.ph-live', h('span.live-dot', { 'aria-hidden': 'true' }), `${fmtNum(view?.audience?.viewers ?? 0)} watching`),
    h('span.ph-crawlers.js-crawlers', { 'data-fmt': 'compact', title: 'Crawlers still alive in the dungeon' })],
  moreItems: () => [
    { icon: 'dice', label: 'Dice log', sub: 'Every roll at the table', onClick: () => setLogOpen(true) },
    { icon: 'sun', label: 'Theme', sub: 'Dark, light or neon', onClick: () => { toggleTheme(); drawTheme(); } },
    ext.hosted ? null : { icon: 'x', label: 'Leave on this phone', sub: 'You can come back with your QR code', onClick: () => $('#leave').click() },
  ].filter(Boolean),
});
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
  sheet.update(view, me);
  renderStart();
  renderLog();
  renderTicker();
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

/* ---------- first visit: friendly start instead of an empty sheet ---------- */

const startKey = () => `system.startSeen.${me?.id}`;
function renderStart() {
  const sh = me.sheet || {};
  const empty = !!me.sheet && !sh.identity?.race && !sh.identity?.class && !(sh.skills || []).length && !(sh.inventory || []).length;
  let seen = false;
  try { seen = sessionStorage.getItem(startKey()) === '1'; } catch {}
  const box = $('#start');
  const show = empty && !seen;
  box.hidden = !show;
  $('#sheet-root').hidden = show;
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

function bootNode() {
const transport = new SystemClient({
  hello: () => token ? { role: 'player', token }
    : claimName ? { role: 'player', claim: true, name: claimName }
      : { role: 'player', room, pin },
});
client.attach(transport);
const rejoin = (label) => {
  $('#join').hidden = true;
  $('#reconnect').hidden = false;
  $('#reconnect .sys-title').textContent = 'Rejoining.';
  $('#reconnect-msg').textContent = label;
  everJoined = true; // show reconnect overlay rather than keypad while we try
  client.on('welcome', () => { $('#reconnect .sys-title').textContent = 'Signal lost.'; });
  client.connect();
};
if (token) {
  rejoin('Opening your crawler');
} else if (room && pin) {
  rejoin(`Room ${room}`);
}
// Which login does this server offer? (Cloudflare: personal links + join requests only.)
fetch('/api/info', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((info) => {
  cloud = info?.legacy === false;
  $('#join-claim').hidden = false;
  if (!token && !(room && pin) && !everJoined) showJoin();
});
registerSW();
}

if (!isHosted()) bootNode();
