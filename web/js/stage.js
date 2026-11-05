import {
  SystemClient, takeHashToken, h, itemArt, fmtNum, rarityOf, prefersReducedMotion, statusText,
} from './client.js';

const $ = (s, r = document) => r.querySelector(s);
const token = takeHashToken('system.stageToken');
const client = new SystemClient({ hello: () => ({ role: 'stage', token }) });
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

client.on('view', (v) => { view = v; render(); });
client.on('event', onEvent);
client.on('play', (m) => enqueueLine(m));
client.on('stop', () => stopAll());

/* ---------- render ---------- */

function render() {
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
  const hype = Math.max(0, Math.min(1, Number(view.audience?.hype) || 0));
  $('#hype').style.width = `${hype * 100}%`;
  $('.hype').classList.toggle('hot', hype >= 0.8 || !!view.audience?.sponsorReady);
  renderStrip();
  renderFeed();
}

let shown = null;
let raf = 0;
function setViewers(target, delta) {
  target = Number(target) || 0;
  if (shown === null) { shown = target; $('#viewers').textContent = fmtNum(target); return; }
  if (target === shown) return;
  const d = delta ?? target - shown;
  if (d) {
    const el = $('#viewers-delta');
    el.textContent = d > 0 ? `+${fmtNum(d)}` : `−${fmtNum(-d)}`;
    el.classList.toggle('neg', d < 0);
    el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
  }
  cancelAnimationFrame(raf);
  const from = shown;
  const t0 = performance.now();
  const dur = reduced ? 1 : 1400;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    shown = Math.round(from + (target - from) * (1 - (1 - k) ** 4));
    $('#viewers').textContent = fmtNum(shown);
    if (k < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}

let stripSig = '';
function renderStrip() {
  const ps = view.players || [];
  const sig = JSON.stringify(ps);
  if (sig === stripSig) return;
  stripSig = sig;
  const strip = $('#strip');
  if (!ps.length) { strip.replaceChildren(h('p.strip-empty', 'Waiting for crawlers. Scan the code to join.')); return; }
  strip.replaceChildren(...ps.map((p) => h('div.pl', { class: p.connected ? 'pl' : 'pl off', 'data-id': p.id, style: { '--pc': p.color || 'var(--cyan)' } },
    h('div.pl-lvl', h('small', 'Lv'), h('b', String(p.level ?? 1))),
    h('div.pl-name', p.name),
    h('div.pl-ach', h('b', String(p.achievementCount ?? 0)), h('span', 'ach')),
    h('div.pl-sub', [p.title, p.klass].filter(Boolean).join(' / ') || (p.connected ? 'On air' : 'Off air')),
    h('span.dot', { class: p.connected ? 'dot on' : 'dot off' }),
  )));
}

const GLYPH = { achievement: '✦', loot: '▣', sponsor: '$', stat: '±' };
let feedSig = '';
function renderFeed() {
  const feed = (view.feed || []).slice(-7);
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

const chatTrack = $('#chat');
let chatX = 0;
let chatLast = performance.now();
const CHAT_SPEED = 90; // px/s at 1080p
const USER_COLORS = ['#2ef2ff', '#e4ff2e', '#ff8a1c', '#3ddc5f', '#b44dff', '#ff2fb9', '#3b8cff'];
function userColor(u) {
  let x = 0;
  for (const c of String(u)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return USER_COLORS[x % USER_COLORS.length];
}
function addChat(user, text) {
  const m = h('span.m', { style: { '--u': userColor(user) } }, h('b', user), text);
  if (!chatTrack.children.length) chatX = chatTrack.parentElement.clientWidth;
  chatTrack.append(m);
  while (chatTrack.children.length > 40) {
    const first = chatTrack.firstChild;
    chatX += first.offsetWidth + gap();
    first.remove();
  }
}
const gap = () => parseFloat(getComputedStyle(chatTrack).columnGap) || 0;
function chatLoop(t) {
  const dt = Math.min(0.1, (t - chatLast) / 1000);
  chatLast = t;
  if (chatTrack.children.length) {
    const scale = innerHeight / 1080;
    chatX -= CHAT_SPEED * scale * dt * (reduced ? 0.5 : 1);
    // drop items fully off screen to the left
    const first = chatTrack.firstElementChild;
    if (first && chatX + first.offsetWidth + gap() < 0) {
      chatX += first.offsetWidth + gap();
      first.remove();
    }
    chatTrack.style.transform = `translateX(${chatX}px)`;
  }
  requestAnimationFrame(chatLoop);
}
requestAnimationFrame(chatLoop);

/* ---------- events → moments ---------- */

const momentQ = [];
let momentBusy = false;

function onEvent(e) {
  switch (e.kind) {
    case 'chat': addChat(e.user || 'anon', e.text || ''); break;
    case 'viewers': setViewers(e.viewers, e.delta); break;
    case 'achievement':
    case 'loot':
    case 'sponsor':
      momentQ.push(e);
      if (!momentBusy) nextMoment();
      break;
    case 'stat': flashPlayer(e.playerId); break;
    default: break;
  }
}

function flashPlayer(id) {
  const el = document.querySelector(`.pl[data-id="${CSS.escape(id || '')}"]`);
  if (!el) return;
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

function playerOf(id) { return view?.players?.find((p) => p.id === id) || null; }

function nextMoment() {
  const e = momentQ.shift();
  const el = $('#moment');
  if (!e) { momentBusy = false; el.hidden = true; el.replaceChildren(); return; }
  momentBusy = true;
  el.classList.remove('out', 'shake');
  el.hidden = false;
  const p = playerOf(e.playerId);
  const pc = p?.color || 'var(--cyan)';
  const nameTag = h('div.m-player', { style: { '--pc': pc } }, p?.name || 'Crawler');
  let hold = 6500;

  if (e.kind === 'achievement') {
    el.style.setProperty('--glow', 'var(--cyan)');
    el.replaceChildren(h('div.m-inner',
      nameTag,
      h('div.sys.m-ach', { 'data-head': 'SYSTEM // ACHIEVEMENT UNLOCKED' },
        h('p.sys-title', e.title),
        e.desc ? h('p.sys-desc', e.desc) : null,
      ),
      reduced ? null : h('div.m-shock'),
    ));
    if (!reduced) el.classList.add('shake');
    hold = reduced ? 5000 : 6500;
  } else {
    const r = rarityOf(e.item?.rarity);
    const tier = view?.pack?.lootTiers?.find((t) => t.id === e.tier);
    el.style.setProperty('--glow', `var(--r-${r})`);
    const box = h('div.box', { style: { '--t': tier?.color || 'var(--acid)' } }, h('div.body'), h('div.lid'));
    const top = e.kind === 'sponsor'
      ? [h('div.sponsor-banner', `${e.sponsor || 'A sponsor'} presents`), h('p.sponsor-sub', `a gift for ${p?.name || 'a crawler'}`)]
      : [nameTag, h('p.sponsor-sub', { style: { color: tier?.color || 'var(--acid)' } }, `opens a ${tier?.name || 'loot box'}`)];
    const inner = h('div.m-inner', ...top, box);
    el.replaceChildren(inner);
    const reveal = () => {
      const card = h('div.card', { class: `card r-${r}` },
        itemArt(e.item || {}),
        h('div.card-meta',
          h('span.rarity-tag', r),
          h('h2.card-name', e.item?.name || 'Something'),
          e.item?.desc ? h('p.card-desc', e.item.desc) : null,
        ),
      );
      inner.replaceChildren(...top.slice(0, 1), card);
    };
    if (reduced) { reveal(); hold = 6000; } else {
      requestAnimationFrame(() => box.classList.add('shake'));
      setTimeout(() => { box.classList.remove('shake'); box.classList.add('open'); }, 1500);
      setTimeout(reveal, 1950);
      hold = 8500;
    }
  }
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(nextMoment, 500);
  }, hold);
}

/* ---------- audio: strictly sequential lines ---------- */

const lineQ = [];
let current = null; // { id, cancel() }
const music = $('#music');
const subtitle = $('#subtitle');
let voicesCache = [];

function loadVoices() {
  try { voicesCache = speechSynthesis.getVoices() || []; } catch { voicesCache = []; }
}
if ('speechSynthesis' in window) {
  loadVoices();
  try { speechSynthesis.addEventListener('voiceschanged', loadVoices); } catch {}
}

// Server releases lines one at a time; a new `play` preempts whatever is playing (P0 interrupts).
function enqueueLine(m) {
  if (current) {
    const c = current;
    current = null;
    c.cancel();
  }
  lineQ.length = 0;
  lineQ.push(m);
  nextLine();
}

function showSub(text) {
  $('#sub-text').textContent = text || '';
  subtitle.hidden = !text;
}

function nextLine() {
  const m = lineQ.shift();
  if (!m) { current = null; showSub(''); duck(false); return; }
  let finished = false;
  let audio = null;
  let safety = null;
  const done = () => {
    if (finished) return;
    finished = true;
    clearTimeout(safety);
    client.raw({ t: 'audio.done', id: m.id });
    if (current?.id === m.id) current = null;
    setTimeout(() => { if (!current) nextLine(); }, 250);
  };
  const cancel = () => {
    finished = true;
    clearTimeout(safety);
    if (audio) { try { audio.pause(); audio.src = ''; } catch {} }
    try { speechSynthesis.cancel(); } catch {}
  };
  current = { id: m.id, cancel };
  safety = setTimeout(() => { cancel(); finished = false; done(); }, 12000);

  showSub(m.text);
  duck(true);

  // Before the curtain is clicked audio is locked: show the subtitle for reading time, then release.
  if (!started) { setTimeout(done, Math.min(8000, 1500 + (m.text || '').length * 50)); return; }

  if (m.audio) {
    audio = new Audio(m.audio);
    audio.onended = done;
    audio.onerror = () => speak(m, done, () => finished); // fall back to TTS if the file is missing
    audio.play().catch(() => speak(m, done, () => finished));
  } else {
    speak(m, done, () => finished);
  }
}

function pickVoice(v) {
  const list = voicesCache.length ? voicesCache : (() => { loadVoices(); return voicesCache; })();
  if (!list.length) return null;
  const prefer = Array.isArray(v?.prefer) ? v.prefer : [];
  for (const name of prefer) {
    const hit = list.find((x) => x.name.toLowerCase().includes(String(name).toLowerCase()));
    if (hit) return hit;
  }
  const lang = (v?.lang || 'en-US').toLowerCase();
  return list.find((x) => x.lang?.toLowerCase() === lang)
    || list.find((x) => x.lang?.toLowerCase().startsWith(lang.slice(0, 2)))
    || null;
}

function speak(m, done, isFinished) {
  if (isFinished()) return;
  if (!('speechSynthesis' in window) || !m.text) { setTimeout(done, Math.min(8000, 1500 + (m.text || '').length * 55)); return; }
  try {
    const v = typeof m.voice === 'object' && m.voice ? m.voice : {};
    const u = new SpeechSynthesisUtterance(m.text);
    const voice = pickVoice(v);
    if (voice) u.voice = voice;
    u.lang = voice?.lang || v.lang || 'en-US';
    u.rate = Number.isFinite(v.rate) ? v.rate : 1.0;
    u.pitch = Number.isFinite(v.pitch) ? v.pitch : 0.8;
    const t0 = performance.now();
    const readMs = Math.min(8000, 1200 + m.text.length * 50);
    // If speech fails or ends implausibly fast (no voices installed), keep the subtitle up for reading time.
    const finish = () => {
      const left = readMs - (performance.now() - t0);
      if (left > 300 && performance.now() - t0 < 400) setTimeout(() => { if (!isFinished()) done(); }, left);
      else done();
    };
    u.onend = finish;
    u.onerror = finish;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {
    setTimeout(done, 3000);
  }
}

function stopAll() {
  lineQ.length = 0;
  if (current) {
    const c = current;
    current = null;
    c.cancel();
    // Server already dropped its queue on queue.clear; acknowledge so it never waits on us.
    client.raw({ t: 'audio.done', id: c.id });
  }
  try { speechSynthesis.cancel(); } catch {}
  showSub('');
  duck(false);
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
  try {
    const r = await fetch('/pack/audio/music.mp3', { method: 'HEAD' });
    if (!r.ok) return;
    music.src = '/pack/audio/music.mp3';
    music.volume = current ? 0.2 : 1;
    await music.play();
    musicOk = true;
  } catch { musicOk = false; }
}

/* ---------- curtain (autoplay unlock) ---------- */

$('#curtain').addEventListener('click', () => {
  started = true;
  // unlock speech + audio inside the user gesture
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  } catch {}
  try {
    const a = new Audio();
    a.muted = true;
    a.play().catch(() => {});
  } catch {}
  loadVoices();
  startMusic();
  $('#curtain').classList.add('gone');
  setTimeout(() => { $('#curtain').hidden = true; }, 800);
  try { document.documentElement.requestFullscreen?.().catch(() => {}); } catch {}
});

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

if (!token) {
  $('#offair').hidden = false;
  $('#offair-title').textContent = 'No stage token.';
  $('#offair-msg').textContent = 'Open the stage link from the GM panel';
} else {
  client.connect();
}
