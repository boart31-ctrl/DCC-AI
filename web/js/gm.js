import {
  SystemClient, TransportHub, takeHashToken, buzz, h, toast, itemArt, fmtNum, timeAgo,
  rarityOf, statusText, registerSW, isHosted, ask,
} from './client.js';
import { createSheet, localRolls, onLocalRoll } from './sheet.js';
import { openBuilder } from './builder.js';
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
import { createNpcs } from './gm-npcs.js';

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
    await client.send(action);
    if (okMsg) toast(okMsg);
    return true;
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
  scenes.update(view);
  sound.update(view);
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
  $('#rank-up').hidden = !list.length;
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
      iconBtn('log', 'Message', () => { showView('show'); openComms([p.id]); }),
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
  const listEl = h('ul.pick-list');
  const draw = () => {
    const hits = M.lib[kind].filter((e) => !q || `${e.name} ${(e.tags || []).join(' ')}`.toLowerCase().includes(q)).slice(0, 150);
    listEl.replaceChildren(...(hits.length ? hits.map((e) => h('li', h('button.pick', {
      type: 'button',
      onclick: async () => { if (await act({ t: 'lib.give', playerId: p.id, kind, id: e.id }, `Gave ${e.name} to ${p.name}.`)) closeDrawer(); },
    }, h('span', h('b', e.name), e.source === 'homebrew' ? h('span.dim', ' homebrew') : null), h('span.dim', e.rarity || e.checkType || ''))))
      : [h('li.empty-s', 'Nothing matches.')]));
  };
  const search = h('input.inp', { type: 'search', placeholder: 'Search the library', oninput: (e) => { q = e.target.value.trim().toLowerCase(); draw(); } });
  const seg = h('div.seg', kinds.map((k) => h('button', { type: 'button', 'aria-pressed': String(k === kind), onclick: () => { kind = k; for (const b of seg.children) b.setAttribute('aria-pressed', String(b.textContent === LIB_KINDS.find((x) => x.id === k).plural)); draw(); } }, LIB_KINDS.find((x) => x.id === k).plural)));
  draw();
  openDrawer({ title: `Give to ${p.name}`, body: [seg, search, listEl] });
  setTimeout(() => search.focus(), 50);
}

/* ---------- rank-up ---------- */

async function rankUp() {
  const before = new Map();
  for (const p of view.gm?.playersFull || []) for (const s of p.sheet?.skills || []) before.set(s.uid, { p, s });
  const usedCount = [...before.values()].filter((x) => x.s.used).length;
  if (!usedCount) { toast('No skills are marked used this session.'); return; }
  if (!(await ask(`Roll rank-up checks for ${usedCount} used skill${usedCount === 1 ? '' : 's'} across the party? This clears every "used" mark.`, { ok: 'Roll rank-ups' }))) return;
  let res;
  try { res = await client.send({ t: 'skills.rankUp' }); } catch (err) { toast(err.message, { error: true }); return; }
  const show = (rows) => openDrawer({
    title: 'Rank-up results',
    sub: `${rows.filter((r) => r.up).length} of ${rows.length} skills went up`,
    body: h('table.res-table', h('thead', h('tr', h('th', 'Crawler'), h('th', 'Skill'), h('th.c', 'Roll'), h('th.c', 'Rank'))),
      h('tbody', rows.map((r) => h('tr', { class: r.up ? 'up' : null }, h('td', r.who), h('td', r.name), h('td.c', r.roll ?? '—'), h('td.c', r.up ? `${r.from} → ${r.to}` : String(r.from)))))),
  });
  const fromAck = res?.result?.results;
  if (Array.isArray(fromAck)) {
    show(fromAck.map((r) => ({ ...r, roll: typeof r.roll === 'object' ? r.roll?.total : r.roll, who: fullPlayer(r.playerId)?.name || '', up: r.success ?? r.up ?? r.to > r.from })));
    return;
  }
  // Engine did not return results: diff the next view.
  const off = client.on('view', (v) => {
    off();
    const rows = [];
    for (const p of v.gm?.playersFull || []) for (const s of p.sheet?.skills || []) {
      const b = before.get(s.uid);
      if (b?.s.used) rows.push({ who: p.name, name: s.name, from: b.s.rank, to: s.rank, up: s.rank > b.s.rank });
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
    body.push(
      h('div.divider', 'or give a specific item, no animation'),
      h('div.say-row', sel, h('button.btn.btn-ghost', {
        type: 'button',
        onclick: async () => {
          const it = catalog.find((x) => x.id === sel.value);
          if (await act({ t: 'item.give', playerId: p.id, itemId: sel.value }, `Gave ${it?.name || 'item'}.`)) closeSheet();
        },
      }, 'Give')),
    );
  }
  openSheet(sponsor ? `Sponsor box for ${p.name}` : `Loot box for ${p.name}`, body, sponsor ? 'var(--magenta)' : 'var(--acid)');
}

/* ---------- prepared cards (prep.card.*) ---------- */

const PREP_GLYPH = { achievement: '✦', loot: '▣', message: '✉', line: '❝' };
function cardNeedsPlayer(c) {
  return (c.kind === 'achievement' || c.kind === 'loot') && !c.payload?.playerId;
}
function cardDetail(c) {
  const p = c.payload || {};
  const who = p.playerId ? (view.players?.find((x) => x.id === p.playerId)?.name || 'someone') : null;
  if (c.kind === 'achievement') return [p.title || p.achId, who && `for ${who}`].filter(Boolean).join(' ');
  if (c.kind === 'loot') return [(view.pack?.lootTiers?.find((t) => t.id === p.tier)?.name || p.tier), who && `for ${who}`].filter(Boolean).join(' ');
  if (c.kind === 'message') return p.to === 'all' ? `To all: ${p.text}` : `${p.text}`;
  return p.text || '';
}
let prepSig = '';
function renderPrep() {
  const cards = view.gm?.prepCards || [];
  const wrap = $('#prep');
  wrap.hidden = !cards.length;
  const sig = JSON.stringify([cards, view.players?.map((p) => [p.id, p.name])]);
  if (sig === prepSig) return;
  prepSig = sig;
  const open = cards.filter((c) => !c.used).length;
  $('#prep-count').textContent = `${open} ready${cards.length > open ? `, ${cards.length - open} used` : ''}`;
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

const KIND_GLYPH = { achievement: '✦', loot: '▣', sponsor: '$', secret: '✉', stat: '±', level: '▲' };
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
function stopAll() {
  buzz([20, 30, 20]);
  act({ t: 'queue.clear' }, 'Stopped. Queue cleared.');
}

$('#auto').addEventListener('click', toggleAuto);
$('#ai-mute').addEventListener('click', () => {
  const on = !view?.session?.aiMute;
  act({ t: 'session.aiMute', on }, on ? 'AI muted: text only, no chat, AUTO off.' : 'AI is back on.');
});
$('#stop').addEventListener('click', stopAll);
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

const VIEWS = ['party', 'combat', 'npcs', 'library', 'show', 'campaign', 'settings'];
let currentView = 'party';
function showView(v) {
  if (!VIEWS.includes(v)) v = 'party';
  currentView = v;
  for (const b of document.querySelectorAll('#gm-nav [data-view], #gm-bnav [data-view]')) {
    if (b.dataset.view === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  const more = $('#gm-bnav [data-more]');
  if (more) { if (['npcs', 'library', 'campaign', 'settings'].includes(v)) more.setAttribute('aria-current', 'page'); else more.removeAttribute('aria-current'); }
  for (const id of VIEWS) $(`#view-${id}`).hidden = id !== v;
  document.body.dataset.view = v;
  try { sessionStorage.setItem('system.gmView', v); } catch {}
}
$('#gm-nav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) showView(b.dataset.view);
});
// Phones: bottom nav. "More" holds the rest of the desk plus the dice log and theme.
$('#gm-bnav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) { showView(b.dataset.view); $('.gm-main').scrollTop = 0; return; }
  if (e.target.closest('[data-more]')) openMore();
});
function openMore() {
  const go = (v) => () => { closeDrawer(); showView(v); $('.gm-main').scrollTop = 0; };
  const row = (ic, label, sub, fn) => h('li', h('button.more-row', { type: 'button', onclick: fn }, icon(ic, { size: 20 }), h('span', h('b', label), sub ? h('small', sub) : null), icon('chevron', { size: 16 })));
  openDrawer({
    title: 'More',
    body: h('ul.more-list',
      row('users', 'NPCs', 'Speak as an NPC on the TV', go('npcs')),
      row('book', 'Library', 'Items, spells, monsters, bosses', go('library')),
      row('map', 'Campaign', '"Previously on…" recap', go('campaign')),
      row('gear', 'Settings', 'Player editing, voice, backups', go('settings')),
      row('tv', 'TV screen', 'Pair or check the TV', () => { closeDrawer(); ext.openTv?.(); }),
      row('dice', 'Dice log', 'Every roll this session', () => { closeDrawer(); setLog(true); }),
      row('sun', 'Theme', 'Dark, light or neon', () => { toggleTheme(); drawTheme(); }),
    ),
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
  const rolls = [...(view.rolls || []), ...localRolls].sort((a, b) => (a.at || 0) - (b.at || 0));
  diceLog.update({ ...view, rolls }, null);
}
const logPref = () => { try { return localStorage.getItem('system.gm.log'); } catch { return null; } };
function setLog(open, remember = window.innerWidth >= 760) {
  document.body.classList.toggle('log-closed', !open);
  $('#log-toggle').setAttribute('aria-expanded', String(open));
  if (remember) try { localStorage.setItem('system.gm.log', open ? '1' : '0'); } catch {}
}
$('#log-toggle').addEventListener('click', () => setLog(document.body.classList.contains('log-closed')));
setLog(window.innerWidth < 760 ? false : logPref() ? logPref() === '1' : window.innerWidth >= 1500, false);

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
$('#rank-up').addEventListener('click', rankUp);

const library = createLibrary({
  send: (a) => client.send(a),
  act,
  getView: () => view,
  aiDraft: (...args) => ext.libraryDraft?.(...args),
  hasAi: () => !!ext.libraryDraft,
});
$('#view-library').append(library.el);
// Show → Scenes (TV director + this desk as the audio device). Hoisted use in render() is safe: views arrive after boot.
const scenes = createScenes({ client, act, getView: () => view });
// Show → Sound (SFX pads, announcements, voice pre-render) + Settings → Voice. The audio fetches use the desk's login.
scenes.audio.credential = () => ext.credential;
const sound = createSound({ client, act, getView: () => view, audio: scenes.audio });
scenes.mountInto($('#view-show'), [{ id: 'sound', label: 'Sound', icon: 'bolt', el: sound.el }]);
// Combat sounds: combat events play pads on this desk by themselves (in step with the TV cinematic).
const combatSfx = createCombatSfx({ board: sound.board, getView: () => view, onChange: () => combat?.update(view) });
sound.el.append(combatSfx.panel());
const openSound = () => {
  showView('show');
  scenes.openSub?.('sound');
  requestAnimationFrame(() => document.getElementById('combat-sounds')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
};
const combat = createCombat({ act, getView: () => view, send: (a) => client.send(a), sfx: combatSfx, openSound });
$('#view-settings .settings-grid').append(sound.settingsEl);
$('#view-combat').append(combat.el);
const npcs = createNpcs({ act, getView: () => view, openInLibrary: (kind, id) => { showView('library'); library.open(kind, id); } });
$('#view-npcs').append(npcs.el);

/* ---------- keyboard ---------- */

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (sheet.open || drawerOpen() || document.querySelector('dialog[open]')) return; // dialogs close first
    e.preventDefault();
    stopAll();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t.closest?.('input, textarea, select, [contenteditable]') || sheet.open || drawerOpen()) return;
  if (e.key === '/') { e.preventDefault(); showView('library'); library.focusSearch(); return; }
  if (currentView !== 'show') return;
  if (e.key === 'a' || e.key === 'A') { e.preventDefault(); toggleAuto(); return; }
  if (e.key === 'm' || e.key === 'M') { e.preventDefault(); openComms(); return; }
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
