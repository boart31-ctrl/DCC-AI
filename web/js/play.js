import {
  SystemClient, store, buzz, h, toast, itemArt, fmtNum, timeAgo, rarityOf,
  prefersReducedMotion, registerSW,
} from './client.js';

const $ = (s, r = document) => r.querySelector(s);
const KEY = 'system.player';

/* ---------- room + PIN ---------- */

const params = new URLSearchParams(location.search);
let saved = {};
try { saved = JSON.parse(store.get('localStorage', KEY) || '{}') || {}; } catch { saved = {}; }
let room = (params.get('room') || saved.room || '').toUpperCase();
let pin = saved.room === room ? (saved.pin || '') : '';
let entry = '';

const client = new SystemClient({ hello: () => ({ role: 'player', room, pin }) });

let view = null;
let me = null;
let everJoined = false;

function remember() {
  store.set('localStorage', KEY, JSON.stringify({ room, pin }));
}
function forget() {
  store.del('localStorage', KEY);
}

function showJoin(err = '') {
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

$('#leave').addEventListener('click', () => {
  if (!confirm('Leave on this phone? You can rejoin with your PIN.')) return;
  forget();
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
    pin = '';
    forget();
    const msg = s.code === 'removed'
      ? 'The GM removed you from this game. Ask them for a new PIN.'
      : s.code === 'rate_limited'
      ? 'Too many wrong PINs. Wait a minute, then try again.'
      : s.code === 'not_found' ? 'That room does not exist. Check the code on the TV.'
        : 'Wrong PIN. Ask your GM.';
    everJoined = false;
    showJoin(msg);
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
  render(prev);
});

client.on('event', (e) => {
  if (!me) return;
  if (e.kind === 'stat' && e.playerId === me.id) { if (!e.resource) flashStat(e.stat, e.from, e.to); return; }
  if (e.playerId !== me.id) return;
  if (['achievement', 'loot', 'sponsor', 'secret'].includes(e.kind)) enqueueTakeover(e);
});

/* ---------- render ---------- */

function render(prev) {
  document.body.style.setProperty('--me', me.color || 'var(--cyan)');
  document.title = `${me.name} · The System`;
  $('#name').textContent = me.name || 'Crawler';
  const lv = $('#level');
  if (prev && prev.level !== me.level) { const l = lv.parentElement; l.classList.remove('bump'); void l.offsetWidth; l.classList.add('bump'); }
  lv.textContent = me.level ?? 1;

  const sub = [];
  const rc = [me.race, me.klass].filter(Boolean).join(' ');
  const subEl = $('#subtitle');
  subEl.replaceChildren();
  if (me.title) subEl.append(h('b', me.title));
  if (me.title && rc) subEl.append(document.createTextNode('  /  '));
  if (rc) subEl.append(document.createTextNode(rc));
  if (!me.title && !rc) subEl.append(document.createTextNode(`Room ${view.room}`));

  $('#gold').textContent = fmtNum(me.gold ?? 0);
  $('#ach-count').textContent = me.achievements?.length ?? 0;
  $('#viewers').textContent = fmtNum(view.audience?.viewers ?? 0);

  renderResources(prev);
  renderStats();
  renderInventory();
  renderAchievements();
  renderMessages();
  renderNotes();
  renderTicker();
}

function renderResources(prev) {
  const defs = view.pack?.resources || [];
  const wrap = $('#resources');
  wrap.hidden = !defs.length;
  for (const r of defs) {
    const v = me.resources?.[r.id] || { cur: 0, max: r.default ?? 0 };
    let row = wrap.querySelector(`[data-res="${CSS.escape(r.id)}"]`);
    if (!row) {
      row = h('div.res', { 'data-res': r.id },
        h('span.res-label', { title: r.label }, (r.abbr || r.id).toUpperCase()),
        h('div.bar', { style: { '--c': r.color || 'var(--alarm)' }, role: 'meter', 'aria-label': r.label, 'aria-valuemin': 0 },
          h('div.bar-fill'), h('span.bar-text')),
      );
      wrap.append(row);
    }
    const bar = $('.bar', row);
    const pct = v.max > 0 ? Math.max(0, Math.min(100, (v.cur / v.max) * 100)) : 0;
    $('.bar-fill', row).style.width = pct + '%';
    $('.bar-text', row).textContent = `${v.cur} / ${v.max}`;
    bar.setAttribute('aria-valuenow', v.cur);
    bar.setAttribute('aria-valuemax', v.max);
    bar.classList.toggle('low', v.max > 0 && v.cur / v.max <= 0.25);
    const was = prev?.resources?.[r.id]?.cur;
    if (was != null && v.cur < was) { bar.classList.remove('hit'); void bar.offsetWidth; bar.classList.add('hit'); buzz(40); }
  }
  for (const row of [...wrap.children]) if (!defs.some((r) => r.id === row.dataset.res)) row.remove();
}

function renderStats() {
  const defs = view.pack?.stats || [];
  const wrap = $('#stats');
  wrap.hidden = !defs.length;
  for (const s of defs) {
    let el = wrap.querySelector(`[data-stat="${CSS.escape(s.id)}"]`);
    if (!el) {
      el = h('div.stat', { 'data-stat': s.id, title: s.label }, h('b.v'), h('span.a', s.abbr || s.id));
      wrap.append(el);
    }
    $('.v', el).textContent = me.stats?.[s.id] ?? s.default ?? 0;
  }
  for (const el of [...wrap.children]) if (!defs.some((s) => s.id === el.dataset.stat)) el.remove();
}

function flashStat(id, from, to) {
  const el = $(`#stats [data-stat="${CSS.escape(id)}"]`);
  if (!el) return;
  const d = Number(to) - Number(from);
  if (!d) return;
  buzz(d > 0 ? [15, 40, 15] : 60);
  el.classList.remove('up', 'down');
  void el.offsetWidth;
  el.classList.add(d > 0 ? 'up' : 'down');
  el.querySelector('.d')?.remove();
  const tag = h('span.d', { class: d > 0 ? 'd' : 'd neg' }, d > 0 ? `+${d}` : String(d));
  el.append(tag);
  $('.v', el).textContent = to;
  setTimeout(() => tag.remove(), 1700);
}

let invSig = '';
function renderInventory() {
  const inv = me.inventory || [];
  $('#n-inv').textContent = inv.length ? String(inv.length) : '';
  const sig = JSON.stringify(inv);
  if (sig === invSig) return;
  invSig = sig;
  const p = $('#panel-inv');
  if (!inv.length) { p.replaceChildren(h('p.empty', 'Nothing yet. Do something the audience will pay for.')); return; }
  p.replaceChildren(h('div.inv-grid', [...inv].reverse().map((it) => {
    const r = rarityOf(it.rarity);
    return h('button.item', { type: 'button', class: `item r-${r}`, onclick: () => showItem(it) },
      itemArt(it),
      h('div.meta', h('span.nm', it.name), h('span', h('span.rarity-tag', r))),
    );
  })));
}

function showItem(it) {
  const r = rarityOf(it.rarity);
  const dlg = $('#item-dlg');
  dlg.className = `item-dlg r-${r}`;
  dlg.replaceChildren(h('form', { method: 'dialog' },
    itemArt(it),
    h('div.meta',
      h('span', h('span.rarity-tag', r)),
      h('h2.nm', it.name),
      it.desc ? h('p', it.desc) : null,
      h('button.btn.btn-ghost', { value: 'close' }, 'Close'),
    ),
  ));
  dlg.showModal();
}

let achSig = '';
function renderAchievements() {
  const list = me.achievements || [];
  const sig = JSON.stringify(list);
  if (sig === achSig) return;
  achSig = sig;
  const p = $('#panel-ach');
  if (!list.length) { p.replaceChildren(h('p.empty', 'No achievements. The System is watching. It is not impressed yet.')); return; }
  p.replaceChildren(h('ul.ach-list', [...list].reverse().map((a) => h('li.sys', { 'data-head': 'ACHIEVEMENT' },
    h('p.sys-title', a.title),
    a.desc ? h('p.sys-desc', a.desc) : null,
    h('time', timeAgo(a.at)),
  ))));
}

let msgSig = '';
function renderMessages() {
  const list = me.secrets || [];
  const unread = list.filter((m) => !m.read).length;
  const badge = $('#unread');
  badge.hidden = !unread;
  badge.textContent = unread;
  const sig = JSON.stringify(list);
  if (sig === msgSig) return;
  msgSig = sig;
  const p = $('#panel-msg');
  if (!list.length) { p.replaceChildren(h('p.empty', 'No private messages. Sponsors write here when they like you.')); return; }
  p.replaceChildren(h('ul.msg-list', [...list].reverse().map((m) => h('li',
    h('button.msg', {
      type: 'button',
      class: m.read ? 'msg' : 'msg unread',
      'aria-label': m.read ? null : `Unread message from ${m.from || 'The System'}. Tap to open.`,
      onclick: (e) => {
        if (m.read) return;
        e.currentTarget.classList.remove('unread');
        buzz(10);
        client.send({ t: 'secret.read', id: m.id }).catch(() => {});
      },
    },
    h('span.from', h('span', `${m.from || 'The System'} · ${timeAgo(m.at)}`)),
    h('span.body', m.text),
    ),
  ))));
}

/* notes: debounced save, never overwrite while typing */
const notesEl = $('#notes');
let notesTimer = null;
let notesDirty = false;
function renderNotes() {
  if (notesDirty || document.activeElement === notesEl) return;
  if (notesEl.value !== (me.notes || '')) notesEl.value = me.notes || '';
}
notesEl.addEventListener('input', () => {
  notesDirty = true;
  $('#notes-state').textContent = 'Typing';
  clearTimeout(notesTimer);
  notesTimer = setTimeout(saveNotes, 800);
});
notesEl.addEventListener('blur', () => { if (notesDirty) { clearTimeout(notesTimer); saveNotes(); } });
async function saveNotes() {
  const text = notesEl.value.slice(0, 2000);
  try {
    await client.send({ t: 'me.notes', text });
    notesDirty = false;
    $('#notes-state').textContent = 'Saved on the host';
  } catch (err) {
    $('#notes-state').textContent = `Not saved: ${err.message}. Retrying`;
    clearTimeout(notesTimer);
    notesTimer = setTimeout(saveNotes, 3000);
  }
}

let tickSig = '';
function renderTicker() {
  const feed = (view.feed || []).slice(-8);
  const sig = feed.map((e) => e.id).join();
  if (sig === tickSig) return;
  tickSig = sig;
  const t = $('#ticker');
  const items = feed.length ? feed.map((e) => e.text || e.kind) : [`Room ${view.room} is live`];
  t.replaceChildren(...items.map((x) => h('span', x)));
  t.style.setProperty('--dur', `${Math.max(16, items.join(' ').length * 0.22)}s`);
}

/* ---------- tabs ---------- */

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  buzz(6);
  for (const t of document.querySelectorAll('#tabs button')) t.setAttribute('aria-selected', String(t === b));
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== `panel-${b.dataset.tab}`;
  store.set('sessionStorage', 'system.tab', b.dataset.tab);
});
{
  const t = store.get('sessionStorage', 'system.tab');
  if (t) $(`#tabs [data-tab="${t}"]`)?.click();
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
  el.onclick = () => { if (ready) nextTakeover(); };

  if (e.kind === 'achievement') {
    buzz([60, 40, 60, 40, 200]);
    el.style.setProperty('--glow', 'var(--cyan)');
    el.replaceChildren(h('div.to-inner',
      h('div.to-kicker', 'Achievement unlocked'),
      h('div.sys', { 'data-head': 'SYSTEM' }, h('p.sys-title', e.title), e.desc ? h('p.sys-desc', e.desc) : null),
    ));
    dismissable(reduced ? 200 : 900);
  } else if (e.kind === 'loot' || e.kind === 'sponsor') {
    buzz([30, 30, 30, 30, 30, 30, 300]);
    const tier = view.pack?.lootTiers?.find((t) => t.id === e.tier);
    const r = rarityOf(e.item?.rarity);
    el.style.setProperty('--glow', `var(--r-${r})`);
    const box = h('div.box', { style: { '--t': tier?.color || 'var(--acid)' } }, h('div.body'), h('div.lid'));
    const kicker = e.kind === 'sponsor' ? `${e.sponsor || 'A sponsor'} sent you a gift` : (tier?.name || 'Loot box');
    const inner = h('div.to-inner', h('div.to-kicker', kicker), h('div.box-wrap', box));
    el.replaceChildren(inner);
    const reveal = () => {
      inner.replaceChildren(
        h('div.to-kicker', { style: { background: `var(--r-${r})` } }, r),
        h('div.reveal', { class: `reveal r-${r}` },
          itemArt(e.item || {}),
          h('div.meta', h('span.nm', e.item?.name || 'Something'), e.item?.desc ? h('p.ds', e.item.desc) : null),
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
          $('#tabs [data-tab="msg"]').click();
          nextTakeover();
        },
      }, 'Open messages'),
    ));
    dismissable(400);
  } else {
    nextTakeover();
  }
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

if (room && pin) {
  $('#join').hidden = true;
  $('#reconnect').hidden = false;
  $('#reconnect .sys-title').textContent = 'Rejoining.';
  $('#reconnect-msg').textContent = `Room ${room}`;
  everJoined = true; // show reconnect overlay rather than keypad while we try
  client.on('welcome', () => { $('#reconnect .sys-title').textContent = 'Signal lost.'; });
  client.connect();
} else {
  showJoin();
}
registerSW();

// tidy: expose for debugging in console
window.__system = { client, toast };
