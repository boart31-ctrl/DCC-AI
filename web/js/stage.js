import { initI18n, setLang, getLang, addTranslations } from './i18n.js';
import { marksEl } from './marks.js';
import {
  SystemClient, TransportHub, takeHashToken, h, itemArt, fmtNum, rarityOf, prefersReducedMotion, statusText, isHosted, portraitSrc, onPortraits,
} from './client.js';
import { createDirector } from './scenes/director.js';
import { levelBadge } from './scenes/common.js';
import { INTRO_HOLD_MS } from './scenes/boss.js';
import { createVoicePlayer, createSubtitleOnly, createCueGate } from './voice.js';
import { createShowAudio } from './show-audio.js';
import { createTicker } from './ticker.js';
import { uiOf, uiAsset, artEl, assetSrc, cornerFrame, mascotEl, setSpeaking, slug, preloadFor } from './ui-art.js';
import { crawlerClock, fmtFull, countDown, skullSvg } from './crawlers.js';
import { initStrip } from './initiative.js';

initI18n({ slots: ['.lang-slot'], key: 'l' });

const $ = (s, r = document) => r.querySelector(s);
const client = new TransportHub();
const reduced = prefersReducedMotion();

let view = null;
let started = false;

/* ---------- connection ---------- */

let pausedSent = false;
client.on('welcome', () => {
  // Phase 1: tell the server the table counts as silent, so P1/P2 lines get released.
  if (!pausedSent) { client.raw({ t: 'audio.pause', silent: true }); pausedSent = true; }
});
client.on('status', (s) => {
  if (s.status === 'open') { $('#offair').hidden = true; return; }
  if (s.status === 'idle') return;
  $('#offair').hidden = false;
  if (s.status === 'rejected') {
    $('#offair-title').textContent = 'Stage link refused.';
    $('#offair-msg').textContent = 'Open the stage link from the GM panel again';
  } else {
    $('#offair-title').textContent = s.attempt > 0 ? 'Signal lost.' : 'Tuning in.';
    $('#offair-msg').textContent = statusText(s);
  }
  // A dropped socket means any line in flight is orphaned on our side.
  if (s.status === 'closed') pausedSent = false;
});

const director = createDirector($('#scenes'), { reduced });
// The GM desk sets the TV language (session.tvLang). Applied when it changes; a first 'en' leaves a local L choice alone.
let tvLangSeen = null;
function applyTvLang(v) {
  const want = v?.session?.tvLang;
  if (!want || want === tvLangSeen) return;
  const first = tvLangSeen === null;
  tvLangSeen = want;
  if ((!first || want === 'cs') && want !== getLang()) setLang(want);
}
client.on('view', (v) => { for (const [code, map] of Object.entries(v?.pack?.ruleset?.i18n || {})) addTranslations(code, map); view = v; applyTvLang(v); render(); });
// A picture that arrived late (or was asked for again): redraw everything that shows faces.
onPortraits(() => { if (!view) return; stripSig = ''; director.render({ ...view }); renderStrip(); });
client.on('event', onEvent);
client.on('play', (m) => enqueueLine(m));
// GM desk = audio device: achievement / announcement takeovers and subtitles wait for its audio to start.
const cueGate = createCueGate();
client.on('message', (m) => {
  if (m?.t !== 'audio.started') return;
  cueGate.release(m.cue);
  subOnly.started(m.id);
});
client.on('stop', () => stopAll());

/* ---------- panic hold + wake lock ---------- */

/** Panic (GM): a stand-by card over everything, audio stopped. The scene underneath stays as it was. */
const holdCard = h('div.hold-card', { hidden: true, 'aria-live': 'assertive' },
  h('div.hold-in', h('b', 'Please stand by'), h('span', 'The show will continue shortly')));
document.body.append(holdCard);
let held = false;
function syncHold(on) {
  if (on === held) return;
  held = on;
  holdCard.hidden = !on;
  document.body.classList.toggle('held', on);
  if (on) { degreeBanner.hidden = true; try { stopAll(); } catch {} }
}

/** The TV must not fall asleep mid-show: keep the screen on while this page is visible. */
let wake = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wake) {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    }
  } catch { wake = null; }
}
document.addEventListener('visibilitychange', keepAwake);
['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, keepAwake, { passive: true }));
keepAwake();

/* ---------- render ---------- */

function render() {
  document.body.classList.toggle('ai-muted', !!view.session?.aiMute); // Mute AI: no audience chat strip
  syncHold(!!view.session?.hold);
  director.render(view);
  syncLootMoment(view.scene);
  showAudio.view(view);
  syncCurtain();
  $('#room').textContent = view.room || '····';
  const sys = view.pack?.systemName;
  if (sys) { $('.logo-text').textContent = sys; $('.sub-who').textContent = sys.toUpperCase(); }
  const url = view.joinUrl || view.gm?.joinUrl;
  if (url && $('#join-url').dataset.url !== url) {
    $('#join-url').dataset.url = url;
    $('#join-url').textContent = url.replace(/^https?:\/\//, '');
    $('#qr').src = `/qr?text=${encodeURIComponent(url)}`;
    $('#qr').alt = `QR code: ${url}`;
  }
  setViewers(view.audience?.viewers ?? 0);
  renderCrawlers();
  maybeRecap(view.recap);
  const hype = Math.max(0, Math.min(1, Number(view.audience?.hype) || 0));
  $('#hype').style.width = `${hype * 100}%`;
  $('.hype').classList.toggle('hot', hype >= 0.8 || !!view.audience?.sponsorReady);
  renderStrip();
  renderFeed();
  renderLogo();
  renderInit();
  preloadFor(view);
}

/* ---------- turn order (5e / PF2e fights): a strip over every scene ---------- */
let initSig = '';
function renderInit() {
  const I = view.combat?.init;
  const sig = JSON.stringify([view.combat?.active, I, (view.combat?.combatants || []).map((x) => [x.uid, x.down, x.name]), (view.players || []).map((p) => [p.id, p.name, p.color])]);
  if (sig === initSig) return;
  initSig = sig;
  let box = $('#ini-tv');
  const strip = initStrip(view);
  if (!strip) { box?.remove(); return; }
  if (!box) { box = h('div#ini-tv.ini-tv', { 'aria-live': 'polite' }); document.body.append(box); }
  box.replaceChildren(h('span.ini-tv-k', `Round ${view.combat.round}`), strip);
}

/* ---------- player roll cards: who did what, and did it work ---------- */
const cards = new Map();
const degreeBanner = h('aside.degree-banner', { hidden: true, role: 'status' });
document.body.append(degreeBanner);
const degreeNames = { crit: 'Critical success', amazing: 'Amazing success', success: 'Success',
  near: 'Near miss', fail: 'Failure', major: 'Major failure', critfail: 'Critical failure' };
let degreeTimer;
function showDegree(e, degree, label) {
  if (held || e.secret || !degreeNames[degree]) return;
  const who = view?.players?.find((p) => p.id === e.playerId)?.name;
  if (!who) return;
  degreeBanner.dataset.roll = e.rollId || e.id;
  degreeBanner.replaceChildren(h('span', [who, label].filter(Boolean).join(' · ')), h('strong', degreeNames[degree]));
  degreeBanner.hidden = false;
  clearTimeout(degreeTimer);
  degreeTimer = setTimeout(() => { degreeBanner.hidden = true; }, 4200);
}
function rollCard(e) {
  if (e.secret || !e.card || e.auto) return;
  const p = (view?.players || []).find((x) => x.id === e.playerId);
  const vs = e.vs || null;
  const rules = view?.pack?.ruleset?.combat || {};
  const DEG7 = { crit: 'Critical hit!', amazing: 'Amazing!', success: e.what === 'attack' ? 'Hit' : 'Success', near: 'Near miss', fail: e.what === 'attack' ? 'Miss' : 'Fail', major: 'Major fail', critfail: 'Critical fail' };
  const verdict = !vs || vs.damage !== undefined ? null
    : vs.deg7 ? DEG7[vs.deg7]
    : vs.degree === 3 ? (rules.degrees ? 'Critical success' : 'Critical hit')
      : vs.hit ? (e.what === 'attack' ? 'Hit' : 'Success')
        : vs.degree === 0 && rules.degrees ? 'Critical failure' : e.what === 'attack' ? 'Miss' : 'Fail';
  let tray = $('#roll-cards');
  if (!tray) { tray = h('div#roll-cards.roll-cards', { 'aria-live': 'polite' }); document.body.append(tray); }
  const card = h('div.roll-card', { class: `roll-card${vs?.hit ? ' is-hit' : vs && vs.hit === false ? ' is-miss' : ''}${vs?.crit ? ' is-crit' : ''}`, style: p?.color ? { '--rc': p.color } : null },
    h('span.rc-who', p?.name || 'Someone'),
    h('span.rc-what', `${e.label}${vs?.name ? ` → ${vs.name}` : ''}`),
    h('span.rc-num', e.natural != null && e.what !== 'custom' ? h('small', `d20 ${e.natural}${e.entered ? ' (real die)' : ''}`) : null, h('b', String(e.total))),
    verdict ? h('span.rc-verdict', verdict) : vs?.damage !== undefined ? h('span.rc-verdict', vs.down ? `${vs.damage} damage — down!` : `${vs.damage} damage`) : null);
  tray.prepend(card);
  cards.set(e.id, card);
  while (tray.children.length > 3) tray.lastChild.remove();
  setTimeout(() => { card.classList.add('out'); setTimeout(() => { card.remove(); cards.delete(e.id); }, 600); }, 7000);
}
function rollVoided(e) {
  const c = cards.get(e.id);
  if (c) { c.classList.add('is-void'); c.querySelector('.rc-verdict')?.replaceChildren('Cancelled'); }
}

/** Pack emblem (ui.json logo) in the bug's corner; the ◢ glyph stays when there is none. */
let logoSrc = null;
function renderLogo() {
  const a = uiAsset(uiOf(view), 'logo');
  const src = assetSrc(a, { still: true }) || '';
  if (src === logoSrc) return;
  logoSrc = src;
  const mark = $('.logo-mark');
  mark.replaceChildren(src ? h('img', { src, alt: '', decoding: 'async', onerror: () => { mark.textContent = '◢'; mark.classList.remove('has-art'); } }) : '◢');
  mark.classList.toggle('has-art', !!src);
}

let shown = null;
let raf = 0;
let serverViewers = null;
/** Server count changed: count up/down to it and flash the delta. */
function setViewers(target, delta) {
  target = Number(target) || 0;
  if (serverViewers === null) { serverViewers = target; shown = target; $('#viewers').textContent = fmtNum(target); return; }
  if (target === serverViewers) return;
  const d = delta ?? target - serverViewers;
  serverViewers = target;
  if (d) {
    const el = $('#viewers-delta');
    el.textContent = d > 0 ? `+${fmtNum(d)}` : `−${fmtNum(-d)}`;
    el.classList.toggle('neg', d < 0);
    el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
  }
  countTo(target, reduced ? 1 : 1400);
}
function countTo(target, dur) {
  cancelAnimationFrame(raf);
  const from = shown ?? target;
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    shown = Math.round(from + (target - from) * (1 - (1 - k) ** 4));
    $('#viewers').textContent = fmtNum(shown);
    if (k < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}
// Live wobble around the server count: people drop in and out. Busier scenes swing harder.
const WOBBLE = { lobby: 0.002, blank: 0.001, recap: 0.002, explore: 0.004, npc: 0.004, loot: 0.008, countdown: 0.01, roll: 0.006, combat: 0.012, boss: 0.02 };
function wobble() {
  const kind = view?.combat?.active ? 'combat' : view?.scene?.kind;
  const amp = WOBBLE[kind] ?? 0.003;
  if (serverViewers && !reduced) {
    const j = (Math.random() * 2 - 1) * amp + amp * 0.25; // a slight upward lean
    countTo(Math.max(1, Math.round(serverViewers * (1 + j))), 900);
  }
  setTimeout(wobble, (kind === 'boss' || kind === 'combat' ? 1400 : 2600) + Math.random() * 1600);
}
setTimeout(wobble, 3000);

/* ---------- crawlers remaining (server/crawlers.js): HUD counter that rolls down live ---------- */

const crClock = crawlerClock();
let crShown = null;
let crHold = null; // a takeover is about to count a drop down: the HUD waits for it
$('#cr-ico').append(skullSvg(30));
function renderCrawlers() {
  const c = view.crawlers;
  crClock.set(c);
  const box = $('#crawlers');
  box.hidden = !c || c.shown === false;
  document.body.classList.toggle('has-crawlers', !box.hidden);
  if (!c) return;
  $('#cr-label').textContent = String(c.label || 'Crawlers remaining').toLowerCase();
  // Floor clock (game time, GM-advanced): "Floor 1 · collapse in 4 d 12 h".
  const k = c.clock;
  const left = k && k.hours != null ? (k.hours <= 0 ? 'collapsing!' : `collapse ${k.hours >= (k.dayHours || 24) ? `${Math.floor(k.hours / (k.dayHours || 24))}d ` : ''}${Math.round(k.hours % (k.dayHours || 24))}h`) : '';
  $('#cr-floor').textContent = [c.floor ? `Floor ${c.floor}` : '', left].filter(Boolean).join(' · ');
  box.classList.toggle('live', !!c.live);
  tickCrawlers();
}
// The TV does not roll the number every second (it pulled the eye off the show): it steps down once
// every CR_STEP_MS with a short count-down, and at once when the GM changes it or a drop moment lands.
const CR_STEP_MS = 5 * 60_000;
let crStepAt = 0;
let crLastSig = '';
let crAnim = null;
function tickCrawlers(force = false) {
  if (!view?.crawlers) return;
  const c = view.crawlers;
  const sig = JSON.stringify([c.count, c.floor, c.last?.at, c.running]);
  if (sig !== crLastSig) { if (crLastSig && c.count !== crShown) force = true; crLastSig = sig; }
  if (crHold != null) { if (crHold !== crShown) { crAnim?.(); crShown = crHold; $('#cr-num').textContent = fmtFull(crShown); } return; }
  const due = crShown == null || force || Date.now() - crStepAt >= CR_STEP_MS;
  if (!due) return;
  crStepAt = Date.now();
  const v = crClock.value();
  if (v === crShown) return;
  const from = crShown;
  crShown = v;
  crAnim?.();
  if (from == null || reduced) { $('#cr-num').textContent = fmtFull(v); return; }
  crAnim = countDown(from, v, 2400, (x) => { $('#cr-num').textContent = fmtFull(x); });
  if (from > v) crawlersHit(from - v);
}
setInterval(tickCrawlers, 1000);
/** The HUD takes a hit: red flash, shake, "−N" floating off. */
function crawlersHit(lost) {
  const box = $('#crawlers');
  if (lost > 0) {
    const el = $('#cr-delta');
    el.textContent = `−${fmtFull(lost)}`;
    el.classList.add('neg');
    el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
  }
  if (reduced) return;
  box.classList.remove('hit'); void box.offsetWidth; box.classList.add('hit');
}
function onCrawlers(e) {
  if (!e.moment) { crawlersHit(e.from - e.to); if (e.playerId) flashPlayer(e.playerId); return; }
  if (e.from !== e.to) crHold = e.from;
  cueGate.hold(e, () => { momentQ.push(e); if (!momentBusy) nextMoment(); }, !audioHere());
  // Safety: never keep the HUD frozen if the moment never shows (e.g. a long queue).
  setTimeout(() => { if (crHold === e.from) { crHold = null; tickCrawlers(true); } }, 30_000);
}

let stripSig = '';
function renderStrip() {
  const ps = view.players || [];
  const sig = JSON.stringify([ps, ps.map((p) => !!portraitSrc(p.portrait))]);
  if (sig === stripSig) return;
  stripSig = sig;
  const strip = $('#strip');
  if (!ps.length) { strip.replaceChildren(h('p.strip-empty', 'Waiting for crawlers. Scan the code to join.')); return; }
  strip.replaceChildren(...ps.map((p) => h('div.pl', { class: p.connected ? 'pl' : 'pl off', 'data-id': p.id, style: { '--pc': p.color || 'var(--cyan)' } },
    levelBadge('pl-lvl', p, p.level),
    h('div.pl-name', p.name, marksEl(p.marks)),
    h('div.pl-ach', h('b', String(p.achievementCount ?? 0)), h('span', 'ach')),
    h('div.pl-sub', [p.title, p.klass].filter(Boolean).join(' / ') || (p.connected ? 'On air' : 'Off air')),
    h('span.dot', { class: p.connected ? 'dot on' : 'dot off' }),
  )));
}

const GLYPH = { achievement: '✦', loot: '▣', sponsor: '$', stat: '±', crawlers: '☠' };
let feedSig = '';
function renderFeed() {
  const feed = (view.feed || []).filter((e) => e.kind !== 'gift').slice(-7);
  const sig = feed.map((e) => e.id).join();
  if (sig === feedSig) return;
  const known = new Set(feedSig.split(','));
  feedSig = sig;
  $('#feed').replaceChildren(...feed.map((e) => {
    const li = h('li', { class: `k-${e.kind}` }, h('span.g', { 'aria-hidden': 'true' }, GLYPH[e.kind] || '◆'), h('span', e.text || e.kind));
    if (known.has(e.id)) li.style.animation = 'none';
    return li;
  }));
}

/* ---------- chat ticker ---------- */

const USER_COLORS = ['#2ef2ff', '#e4ff2e', '#ff8a1c', '#3ddc5f', '#b44dff', '#ff2fb9', '#3b8cff'];
function userColor(u) {
  let x = 0;
  for (const c of String(u)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return USER_COLORS[x % USER_COLORS.length];
}
// One strip, one transform, positions decided once per message (ticker.js explains the old glitch).
const ticker = createTicker($('#chat').parentElement, $('#chat'), { speed: 62, reduced }); // calm, readable crawl
function addChat(user, text) {
  ticker.add(h('span.m', { style: { '--u': userColor(user) } }, h('b', user), text));
}
window.__ticker = { ...ticker, chat: addChat }; // headless checks (ticker recording)

/* ---------- events → moments ---------- */

const momentQ = [];
let momentBusy = false;

function onEvent(e) {
  if (String(e.kind).startsWith('boss.')) {
    director.event(e);
    showAudio.event(e);
    // The System's line (boss intro / defeat) starts once the stinger has hit.
    const hold = { 'boss.intro': reduced ? 0 : INTRO_HOLD_MS, 'boss.defeat': reduced ? 0 : 2600 }[e.kind];
    if (hold) { voicePlayer.holdFor(hold); subOnly.holdFor(hold); }
    return;
  }
  if (e.kind === 'loot' && e.sceneId) return; // The confirmed scene drives the reveal, including after reconnect.
  if (e.kind === 'loot' || e.kind === 'sponsor') director.event(e);
  if (String(e.kind).startsWith('combat.') || e.kind === 'rx.hit' || e.kind === 'rx.undo') {
    director.event(e);
    if (e.kind === 'combat.hit' && e.playerId && e.animation !== 'reaction') flashPlayer(e.playerId);
    if (e.kind === 'combat.turn') turnBanner(e);
    return;
  }
  if (e.kind === 'npc.say') { if (director.kind === 'npc') director.event(e); else npcSub(e); return; }
  const roundPanel = view?.combat?.active && view.combat.rx &&
    (view.scene?.kind === 'combat' || (view.scene?.kind === 'boss' && view.scene.data.revealed && !view.scene.data.defeated));
  switch (e.kind) {
    case 'chat': addChat(e.user || 'anon', e.text || ''); break;
    case 'viewers': setViewers(e.viewers, e.delta); break;
    case 'achievement':
      cueGate.hold(e, () => { momentQ.push(e); if (!momentBusy) nextMoment(); }, !audioHere());
      break;
    case 'loot':
    case 'sponsor':
      momentQ.push(e);
      if (!momentBusy) nextMoment();
      break;
    case 'stat': flashPlayer(e.playerId); break;
    case 'roll':
      if (roundPanel && e.vs?.uid) break;
      rollCard(e);
      if (e.part !== 'damage') showDegree(e, e.vs?.deg7, e.label);
      break;
    case 'rx.evade': if (!roundPanel) showDegree(e, e.degree, 'Evade'); break;
    case 'rollUpdate': if (!(roundPanel && view.rolls?.some(r => r.id === e.rollId && r.vs?.uid))) showDegree(e, e.degree, e.why === 'favor' ? 'AI Favor' : 'Intervene'); break;
    case 'roll.void':
      rollVoided(e);
      if (degreeBanner.dataset.roll === e.id) degreeBanner.hidden = true;
      break;
    case 'loot.drop': lootTray(e); break;
    case 'crawlers': onCrawlers(e); break;
    case 'loot.take': lootTaken(e); break;
    case 'announcement':
      cueGate.hold(e, () => { momentQ.push({ ...e, kind: 'announcement' }); if (!momentBusy) nextMoment(); }, !audioHere());
      break;
    default: break;
  }
}

function turnBanner(e) {
  if (!e.current) return;
  const p = e.current.playerId ? (view?.players || []).find((x) => x.id === e.current.playerId) : null;
  const b = h('div.turn-banner', { style: p?.color ? { '--rc': p.color } : null }, h('small', `Round ${e.round}`), h('b', `${e.current.name}'s turn`), e.next ? h('span', `Next: ${e.next.name}`) : null);
  document.body.append(b);
  setTimeout(() => { b.classList.add('out'); setTimeout(() => b.remove(), 600); }, 2600);
}

// "Speak as NPC" over any scene other than the NPC card: a subtitle bar in the NPC's name.
let npcSubEl = null;
let npcSubTimer = 0;
function npcSub(e) {
  if (!npcSubEl) { npcSubEl = h('div.npc-sub', { 'aria-live': 'polite' }, h('span.npc-sub-who'), h('p.npc-sub-text')); document.body.append(npcSubEl); }
  npcSubEl.querySelector('.npc-sub-who').textContent = e.name || '';
  npcSubEl.querySelector('.npc-sub-text').textContent = e.text || '';
  npcSubEl.classList.remove('on'); void npcSubEl.offsetWidth; npcSubEl.classList.add('on');
  clearTimeout(npcSubTimer);
  npcSubTimer = setTimeout(() => npcSubEl.classList.remove('on'), Math.max(4500, Math.min(14000, 70 * (e.text || '').length)));
}

// Loot from the dead (loot.js): a tray of what fell, bottom centre, over any scene; items get the
// taker's name as the GM hands them out. No takeover: the fight keeps running behind it.
let trayEl = null;
let trayTimer = 0;
const trayItemSrc = (img) => (!img ? null : img.startsWith('/') || /^https?:/.test(img) ? img : `/pack/images/${img}`);
function lootTray(e) {
  if (!trayEl) { trayEl = h('div.loot-tray', { 'aria-live': 'polite' }); document.body.append(trayEl); }
  trayEl.dataset.drop = e.dropId || '';
  const items = (e.items || []).slice(0, 8);
  trayEl.replaceChildren(...[
    h('p.lt-head', h('b', e.from?.name || 'Something'), e.from?.type === 'crawler' ? ' dropped everything' : ' dropped'),
    h('ul.lt-items', items.map((it) => h('li', { 'data-key': it.key, class: `r-${it.rarity || 'common'}` },
      h('span.lt-ico', trayItemSrc(it.image) ? h('img', { src: trayItemSrc(it.image), alt: '', decoding: 'async' }) : h('span', '◆')),
      h('span.lt-nm', it.name, it.qty > 1 ? ` ×${it.qty}` : ''),
      h('span.lt-who')))),
    (e.items || []).length > items.length ? h('p.lt-more', `+${e.items.length - items.length} more`) : null].filter(Boolean));
  trayEl.classList.remove('on'); void trayEl.offsetWidth; trayEl.classList.add('on');
  clearTimeout(trayTimer);
  trayTimer = setTimeout(() => trayEl.classList.remove('on'), 14000);
}
function lootTaken(e) {
  const p = playerOf(e.playerId);
  if (trayEl && trayEl.dataset.drop === e.dropId) {
    const li = trayEl.querySelector(`li[data-key="${CSS.escape(e.item?.key || '')}"]`);
    if (li) {
      li.classList.add('taken');
      li.style.setProperty('--pc', p?.color || 'var(--cyan)');
      li.querySelector('.lt-who').textContent = `→ ${e.name || p?.name || ''}`;
    }
    trayEl.classList.add('on');
    clearTimeout(trayTimer);
    const left = trayEl.querySelectorAll('li:not(.taken)').length;
    trayTimer = setTimeout(() => trayEl.classList.remove('on'), left ? 12000 : 3500);
  }
  flashPlayer(e.playerId);
}

function flashPlayer(id) {
  const el = document.querySelector(`.pl[data-id="${CSS.escape(id || '')}"]`);
  if (!el) return;
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

function playerOf(id) { return view?.players?.find((p) => p.id === id) || null; }

// Timed announcements may cover the opening. The loot card is the resting view of its scene.
let lootMoment = null;
let lastOpening = null;
function syncLootMoment(scene) {
  const id = scene?.kind === 'loot' && scene.data.opened ? scene.id : null;
  if (id === (lootMoment?.sceneId ?? null)) return;
  lootMoment = id ? { kind: 'loot', sceneId: id, playerId: scene.data.playerId, tier: scene.data.tier, item: scene.data.opened, items: scene.data.items, bestIndex: scene.data.bestIndex, gold: scene.data.gold } : null;
  if (!momentBusy) nextMoment();
}

function nextMoment() {
  const e = momentQ.shift() ?? lootMoment;
  const el = $('#moment');
  if (!e) { momentBusy = false; document.body.classList.remove('moment-on', 'recap-on'); el.hidden = true; el.replaceChildren(); return; }
  momentBusy = e !== lootMoment;
  document.body.classList.add('moment-on');
  document.body.classList.toggle('recap-on', e.kind === 'recap');
  el.classList.remove('out', 'shake');
  el.hidden = false;
  const p = playerOf(e.playerId);
  const pc = p?.color || 'var(--cyan)';
  const face = portraitSrc(p?.portrait);
  const nameTag = h('div.m-player', { style: { '--pc': pc }, class: face ? 'm-player has-face' : 'm-player' }, face ? h('img.face', { src: face, alt: '' }) : null, p?.name || 'Crawler');
  let hold = 6500;

  const sys = (view?.pack?.systemName || 'The System').toUpperCase();
  if (e.kind === 'recap') {
    el.style.setProperty('--glow', 'var(--acid)');
    const desc = h('p.sys-desc');
    const scroll = h('div.m-scroll', desc);
    el.replaceChildren(h('div.m-inner',
      h('p.m-prefix', 'Previously on'),
      h('div.sys.m-ann.m-recap', { 'data-head': `${sys} // PREVIOUSLY ON` },
        h('p.ann-from', view?.pack?.systemName || 'The System'),
        scroll,
      ),
    ), mascotEl(uiOf(view), 'recap', 'ua-mascot m-mascot'));
    const typeMs = reduced ? 0 : Math.min(8000, e.text.split(/\s+/).length * 40);
    hold = Math.min(45000, 900 + typeMs + readTime(e.text, 8000, 40000));
    typewrite(desc, e.text, reduced ? 0 : 700, typeMs, null, () => {
      scroll.scrollTop = 0;
      autoScroll(scroll, hold - 700 - typeMs, 1500);
    });
  } else if (e.kind === 'crawlers') {
    hold = crawlersMoment(el, e);
  } else if (e.kind === 'announcement') {
    el.style.setProperty('--glow', 'var(--magenta)');
    const text = e.text || '';
    el.replaceChildren(h('div.m-inner',
      h('div.sys.m-ann', { 'data-head': `${sys} // ANNOUNCEMENT` },
        h('p.ann-from', e.from || view?.pack?.systemName || 'The System'),
        h('div.m-scroll', h('p.sys-desc', text)),
      ),
    ), mascotEl(uiOf(view), e.mood || 'announcement', 'ua-mascot m-mascot'));
    hold = readTime(text, 8000);
    autoScroll(el.querySelector('.m-scroll'), hold);
  } else if (e.kind === 'achievement') {
    el.style.setProperty('--glow', 'var(--cyan)');
    const desc = h('p.sys-desc');
    const reward = e.reward ? h('p.m-reward', h('b', 'Reward: '), e.reward) : null;
    if (reward) reward.style.visibility = 'hidden';
    const scroll = h('div.m-scroll', desc);
    const medal = artEl(uiAsset(uiOf(view), 'medals', [slug(e.group), 'default']), { cls: 'm-medal', still: true });
    el.replaceChildren(h('div.m-inner',
      h('p.m-prefix', view?.pack?.notifyPrefix || 'New achievement!'),
      nameTag,
      h('div.sys.m-ach', { 'data-head': `${sys} // ACHIEVEMENT UNLOCKED`, class: medal ? 'sys m-ach has-medal' : 'sys m-ach' },
        medal,
        h('p.sys-title', e.title),
        e.desc ? scroll : null,
        reward,
      ),
      reduced ? null : h('div.m-shock'),
    ), mascotEl(uiOf(view), 'achievement', 'ua-mascot m-mascot'));
    if (!reduced) el.classList.add('shake');
    // Reading time (4 s + 60 ms/word) starts once the text is fully typed; total capped at 20 s.
    const words = `${e.title} ${e.desc || ''} ${e.reward || ''}`.trim().split(/\s+/).length;
    const typeMs = reduced ? 0 : Math.min(5000, (e.desc || '').split(/\s+/).length * 45);
    hold = Math.min(20000, Math.max(6500, 900 + typeMs + 4000 + words * 60));
    typewrite(desc, e.desc || '', reduced ? 0 : 900, typeMs, null, () => {
      if (reward) reward.style.visibility = '';
      // If the text overflows, show the top first, then glide down during the reading time.
      scroll.scrollTop = 0;
      autoScroll(scroll, hold - 900 - typeMs, 1500);
    });
  } else {
    const r = rarityOf(e.item?.rarity);
    const tier = view?.pack?.lootTiers?.find((t) => t.id === e.tier);
    const ui = uiOf(view);
    el.style.setProperty('--glow', `var(--r-${r})`);
    // Crate art per tier (ui.json lootBoxes): closed (or its idle rattle) → opening → open. Without art
    // the CSS box below plays as before.
    const tierKeys = [e.tier, e.kind === 'sponsor' ? 'sponsor' : null, 'default'].filter(Boolean);
    const crate = (st) => uiAsset(ui, 'lootBoxes', tierKeys, st);
    const closedArt = crate(['idle', 'closed']);
    let box = h('div.box', { style: { '--t': tier?.color || 'var(--acid)' } }, h('div.body'), h('div.lid'));
    let openCrate = null;
    if (closedArt) {
      const cssBox = box;
      const art = artEl(closedArt, { cls: 'box-img', onError: () => artBox.replaceWith(cssBox) });
      const artBox = h('div.box.box-art', { style: { '--t': tier?.color || 'var(--acid)' } }, art);
      box = artBox;
      openCrate = () => {
        const next = crate(['opening']) || crate(['open']);
        if (!next) return;
        const img = artEl(next, { cls: 'box-img', once: true, onEnd: () => {
          const fin = crate(['open']);
          if (fin && fin !== next) img.replaceWith(artEl(fin, { cls: 'box-img', still: true }) || img);
        } });
        artBox.replaceChildren(img);
      };
    }
    const sponsorLogo = e.kind === 'sponsor' ? sponsorArt(ui, e.sponsor) : null;
    const top = e.kind === 'sponsor'
      ? [h('div.sponsor-banner', { class: sponsorLogo ? 'sponsor-banner has-logo' : 'sponsor-banner' }, sponsorLogo, `${e.sponsor || 'A sponsor'} presents`), h('p.sponsor-sub', `a gift for ${p?.name || 'a crawler'}`)]
      : [nameTag, h('p.sponsor-sub', { style: { color: tier?.color || 'var(--acid)' } }, `opens a ${tier?.name || 'loot box'}`)];
    const inner = h('div.m-inner', ...top, box);
    el.replaceChildren(inner);
    const reveal = () => {
      const len = `${e.item?.desc || ''}${e.item?.flavor || ''}`.length;
      const frame = cornerFrame(uiAsset(ui, 'rarityFrames', e.kind === 'sponsor' ? ['sponsor', r] : [r]), 'ua-frame card-frame');
      const card = h('div.card', { class: `card r-${r}${len > 380 ? ' xlong' : len > 200 ? ' long' : ''}${frame ? ' has-frame' : ''}` },
        itemArt(e.item || {}),
        h('div.card-meta',
          h('span.rarity-tag', r),
          h('h2.card-name', e.item?.name || 'Something'),
          e.item?.desc ? h('p.card-desc', e.item.desc) : null,
          e.item?.flavor ? h('p.card-flavor', e.item.flavor) : null,
        ),
        frame,
      );
      const rest = (e.items || []).filter((_, i) => i !== e.bestIndex);
      inner.replaceChildren(...top.slice(0, 1), card);
      if (rest.length || e.gold) inner.append(h('div.loot-strip', rest.map(it =>
        h('span', itemArt(it), it.name)), e.gold ? h('b', `+${e.gold} gold`) : null));
    };
    const resume = e === lootMoment && (lastOpening === e.sceneId || view.scene.now - view.scene.since >= 1950);
    if (e === lootMoment) lastOpening = e.sceneId;
    if (reduced || resume) { reveal(); hold = 6000; } else {
      requestAnimationFrame(() => box.classList.add('shake'));
      setTimeout(() => { box.classList.remove('shake'); box.classList.add('open'); openCrate?.(); }, 1500);
      setTimeout(reveal, 1950);
      hold = 2000 + readTime(`${e.item?.name || ''} ${e.item?.desc || ''} ${e.item?.flavor || ''}`, 6500);
    }
    if (reduced) hold = readTime(`${e.item?.name || ''} ${e.item?.desc || ''} ${e.item?.flavor || ''}`, 6000);
  }
  if (e === lootMoment) return;
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(nextMoment, 500);
  }, hold);
}

/** Crawlers remaining takeover: the number counts down from → to, then the losses. Returns the hold (ms). */
const CR_HEAD = { collapse: 'FLOOR COLLAPSE', announce: 'CRAWLER COUNT', death: 'CASUALTY' };
function crawlersMoment(el, e) {
  const sys = (view?.pack?.systemName || 'The System').toUpperCase();
  const lost = Math.max(0, e.from - e.to);
  const big = e.from > 0 && lost / e.from >= 0.05;
  el.style.setProperty('--glow', e.reason === 'announce' ? 'var(--cyan)' : 'var(--alarm)');
  const num = h('p.crm-num', fmtFull(e.from));
  const loss = h('p.crm-loss', lost
    ? `−${fmtFull(lost)} crawlers${e.from ? ` (−${(lost / e.from * 100).toFixed(lost / e.from < 0.01 ? 2 : 1)} %)` : ''}`
    : e.reason === 'announce' ? `Floor ${e.floor}` : '');
  loss.style.visibility = 'hidden';
  el.replaceChildren(h('div.m-inner',
    h('p.m-prefix', e.reason === 'collapse' ? e.label : e.reason === 'announce' ? 'Attention, crawlers' : e.label || 'Casualties'),
    h('div.sys.m-ann.m-crawlers', { 'data-head': `${sys} // ${CR_HEAD[e.reason] || 'CASUALTY REPORT'}` },
      h('p.crm-label', e.labelText || 'Crawlers remaining'),
      num,
      loss,
      e.reason === 'collapse' ? h('p.crm-floor', `Welcome to floor ${e.floor}`) : null,
    ),
    reduced || !big ? null : h('div.m-shock'),
  ), mascotEl(uiOf(view), 'announcement', 'ua-mascot m-mascot'));
  if (!reduced && big) el.classList.add('shake');
  const startAt = reduced ? 0 : 900;
  const dur = reduced || !lost ? 0 : Math.min(3200, 1400 + Math.log10(lost + 1) * 200);
  setTimeout(() => countDown(e.from, e.to, dur, (v) => { num.textContent = fmtFull(v); }, () => {
    loss.style.visibility = '';
    num.classList.add('done');
    crHold = null;
    crShown = null; // jump to the new count, no second count-down
    tickCrawlers();
    crawlersHit(lost);
  }), startAt);
  return startAt + dur + (e.reason === 'collapse' ? 6500 : 5000);
}

/** Sponsor emblem from ui.json sponsors: key = slug of the sponsor name, or an entry whose name matches. */
function sponsorArt(ui, name) {
  const map = ui?.sponsors;
  if (!map || !name) return null;
  const k = slug(name);
  const a = map[k] || map[k.replace(/^sponsor_/, '')] || Object.values(map).find((x) => x.name && slug(x.name) === k);
  return artEl(a, { cls: 'sponsor-logo', still: true });
}

/* "Previously on…" recap: shown when the view's recap text changes to something new. */
let lastRecap = null;
function maybeRecap(text) {
  const t = String(text || '').trim();
  if (view?.scene?.kind === 'recap') { lastRecap = t; return; } // the recap scene is already showing it
  if (lastRecap === null) {
    // First view: show it once per stage window if it is new to this window.
    let seen = null;
    try { seen = sessionStorage.getItem('system.recapSeen'); } catch {}
    lastRecap = t;
    if (!t || seen === t) return;
  } else if (!t || t === lastRecap) { lastRecap = t; return; }
  lastRecap = t;
  try { sessionStorage.setItem('system.recapSeen', t); } catch {}
  momentQ.push({ kind: 'recap', text: t });
  if (!momentBusy) nextMoment();
}

/** Reading time for a TV at 3 m: ~4 s + 60 ms per word, max 20 s. */
function readTime(text, min = 6500, max = 20000) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(min, Math.min(max, 4000 + words * 60));
}

/** Reveal text word by word over `dur` ms (instant when dur is 0); the scroller follows the newest words. */
function typewrite(el, text, delay, dur, scroller, onDone) {
  const words = String(text).split(/(\s+)/);
  const follow = () => { if (scroller) scroller.scrollTop = scroller.scrollHeight; };
  if (!dur || words.length < 3) {
    setTimeout(() => { el.textContent = text; follow(); onDone?.(); }, delay);
    return;
  }
  el.textContent = '';
  let i = 0;
  const step = dur / words.length;
  setTimeout(function tick() {
    if (!document.body.contains(el)) return;
    i = Math.min(words.length, i + 2); // a word and its trailing space
    el.textContent = words.slice(0, i).join('');
    follow();
    if (i < words.length) setTimeout(tick, step * 2);
    else { el.textContent = text; onDone?.(); }
  }, delay);
}

/** Slowly scroll an overflowing box to the bottom across the hold time. */
function autoScroll(box, hold, startAfter = 1200) {
  if (!box) return;
  setTimeout(() => {
    const max = box.scrollHeight - box.clientHeight;
    if (max <= 4) return;
    const t0 = performance.now();
    const dur = Math.max(1500, hold - startAfter - 2000);
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      box.scrollTop = max * (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
      if (k < 1 && document.body.contains(box)) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, startAfter);
}

/* ---------- audio: the System voice (only when the TV is the audio device) ---------- */

// The GM desk is the audio device by default (view.show.audioDevice). The TV then shows the
// subtitle only and never acks; with "audio device: TV" it plays and acks as before.
// ?preview=1 (the GM desk's mini-preview) never plays anything.
const PREVIEW = new URLSearchParams(location.search).has('preview') || new URLSearchParams(location.search).has('draft');
// ?draft=1: the GM desk's preview of a scene that is NOT on the TV yet. No connection: the desk posts
// the view (with the dry-run scene from scene.preview) and test events into this frame.
const DRAFT = new URLSearchParams(location.search).has('draft');
const music = $('#music');
const subtitle = $('#subtitle');
function showSub(text) {
  $('#sub-text').textContent = text || '';
  subtitle.hidden = !text;
  setSpeaking(!!text); // mascots on screen switch to their talking art while the System speaks
}
const voicePlayer = createVoicePlayer({ ack: (id) => client.raw({ t: 'audio.done', id }), onSub: showSub, onDuck: (on) => duck(on) });
const subOnly = createSubtitleOnly(showSub);
// The hosted edition (claude.ai artifact) keeps its own routing: its stage always plays.
const audioHere = () => !PREVIEW && (isHosted() || (view?.show?.audioDevice ?? 'stage') === 'stage');
const showAudio = createShowAudio({ isDevice: () => audioHere() && started });

function enqueueLine(m) {
  if (audioHere()) voicePlayer.play(m);
  else subOnly.play(m);
}

function stopAll() {
  voicePlayer.stop();
  subOnly.stop();
}

/* background music with ducking */
let musicOk = false;
let fadeRaf = 0;
function duck(on) {
  if (!musicOk) return;
  const target = on ? 0.2 : 1;
  cancelAnimationFrame(fadeRaf);
  const from = music.volume;
  const t0 = performance.now();
  const dur = on ? 300 : 900;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    music.volume = from + (target - from) * k;
    if (k < 1) fadeRaf = requestAnimationFrame(step);
  };
  fadeRaf = requestAnimationFrame(step);
}

async function startMusic() {
  if (isHosted()) return; // the hosted edition ships no audio files
  try {
    const r = await fetch('/pack/audio/music.mp3', { method: 'HEAD' });
    if (!r.ok) return;
    music.src = '/pack/audio/music.mp3';
    music.volume = voicePlayer.playing ? 0.2 : 1;
    await music.play();
    musicOk = true;
  } catch { musicOk = false; }
}

/* ---------- curtain (autoplay unlock) ---------- */

$('#curtain').addEventListener('click', () => {
  started = true;
  // unlock speech + audio + stingers inside the user gesture
  voicePlayer.unlock();
  showAudio.stingers.unlock();
  startMusic();
  $('#curtain').classList.add('gone');
  setTimeout(() => { $('#curtain').hidden = true; }, 800);
  try { document.documentElement.requestFullscreen?.().catch(() => {}); } catch {}
});

/** The curtain only exists to unlock sound: without audio on the TV it is skipped. */
function syncCurtain() {
  const c = $('#curtain');
  if (started || c.classList.contains('gone')) return;
  c.hidden = !audioHere();
}

/* ---------- keys ---------- */

document.addEventListener('keydown', (e) => {
  if (e.key === 'q' || e.key === 'Q') $('#join').classList.toggle('off');
  if (e.key === 'f' || e.key === 'F') {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    } catch {}
  }
});

let cursorT = 0;
document.addEventListener('mousemove', () => {
  document.body.classList.add('cursor-on');
  clearTimeout(cursorT);
  cursorT = setTimeout(() => document.body.classList.remove('cursor-on'), 2000);
});

/* ---------- boot ---------- */

/** Attach a transport and start. */
export function mountStage(transport, opts = {}) {
  document.body.classList.toggle('hosted', !!opts.hosted);
  client.attach(transport);
  transport.connect?.();
  return { client };
}

if (PREVIEW) { document.body.classList.add('preview'); $('#curtain').hidden = true; }

if (DRAFT) {
  document.body.classList.add('draft');
  $('#offair').hidden = true;
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.t === 'draft.view') { view = e.data.view; render(); }
    else if (e.data.t === 'draft.event') onEvent(e.data.event);
  });
  window.parent?.postMessage({ t: 'draft.ready' }, location.origin);
} else if (!isHosted()) {
  // Login: stage link token (Node), paired-TV token, GM key on the GM's own machine, or a pairing code (tvpair.js).
  import('./tvpair.js').then(({ bootStage }) => bootStage({ mountStage, SystemClient, takeHashToken })).catch((err) => {
    console.error(err);
    $('#offair').hidden = false;
    $('#offair-title').textContent = 'Could not start.';
    $('#offair-msg').textContent = 'Reload the page';
  });
}
