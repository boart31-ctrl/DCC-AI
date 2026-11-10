// Hosted edition entry. Decides the role (GM desk / TV / player) from the Artifact runtime, mounts
// the matching page body from its <template>, then hands the existing page module a transport.
import { deserializePack } from '../../engine/engine.js';
import { h, toast, buzz } from '../client.js';

globalThis.__SYSTEM_HOSTED__ = true;
const $ = (s, r = document) => r.querySelector(s);

const bootTitle = (t) => { $('#boot-title').firstChild.textContent = t; };
const bootMsg = (t) => { $('#boot-msg').textContent = t; };

/** Page stylesheet per role; loaded only for that role because the three pages' rules overlap. */
function loadCss(name) {
  return new Promise((resolve) => {
    if (document.querySelector(`link[data-page="${name}"]`)) return resolve();
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = `css/${name}.css`;
    l.dataset.page = name;
    l.onload = l.onerror = () => resolve();
    // Before hosted.css so hosted overrides win.
    document.querySelector('link[href="css/hosted.css"]').before(l);
  });
}

function mountTemplate(id, cls) {
  const tpl = document.getElementById(id);
  document.body.classList.add(cls);
  document.body.append(tpl.content.cloneNode(true));
}

async function use(name) {
  try { return (await window.claude?.use?.(name)) ?? null; } catch { return null; }
}

async function main() {
  if (!window.claude?.use) {
    bootTitle('Open this inside claude.ai');
    bootMsg('The show runs on claude.ai: storage, presence and sign-in come from there. Open the artifact link while signed in.');
    return;
  }
  let pack;
  try {
    const res = await fetch('pack.json');
    pack = deserializePack(await res.json());
  } catch (e) {
    bootTitle('Content pack missing');
    bootMsg('pack.json could not be loaded. Rebuild the artifact with tools/build_artifact.mjs.');
    console.error(e);
    return;
  }
  const [db, user, room] = await Promise.all([use('db'), use('user'), use('room')]);
  if (!db || !user) {
    bootTitle('Sign in to join');
    bootMsg('Sign in to claude.ai and open this link again. The show needs to know who you are to give you a character.');
    return;
  }
  document.title = pack.systemName || 'The System';
  const owner = await user.isOwner();
  const wantsStage = location.hash === '#stage';
  if (owner && wantsStage) return startStage({ db, room });
  if (owner) {
    // The owner may be on the laptop (GM desk) or on the TV's browser (Xbox, smart TV): ask, remember per device.
    let pick = null;
    try { pick = localStorage.getItem(ROLE_KEY); } catch {}
    if (location.hash === '#desk') pick = 'gm';
    if (pick === 'stage') return startStage({ db, room });
    if (pick === 'gm') return startGm({ db, user, room, pack });
    return chooseOwnerScreen({ db, user, room, pack });
  }
  return startPlayer({ db, user, room, pack });
}

const ROLE_KEY = 'system.ownerScreen';

/** Owner without a remembered choice: GM desk on this screen, or this screen is the TV. */
function chooseOwnerScreen(ctx) {
  bootTitle('Which screen is this?');
  bootMsg('You own this show. Run the GM desk here, or make this screen the TV everyone watches. A TV or console browser signed in as you works.');
  const remember = h('input', { type: 'checkbox', checked: true });
  const go = (role) => {
    if (remember.checked) { try { localStorage.setItem(ROLE_KEY, role); } catch {} }
    $('#boot-actions').replaceChildren();
    if (role === 'stage') { location.hash = 'stage'; startStage(ctx); } else startGm(ctx);
  };
  $('#boot-actions').replaceChildren(
    h('button.btn.btn-cyan', { type: 'button', onclick: () => go('gm') }, 'Open the GM desk'),
    h('button.btn.btn-ghost', { type: 'button', onclick: () => go('stage') }, 'This screen is the TV'),
    h('label.boot-remember', remember, h('span', 'Remember on this device')),
  );
}

/* ---------------- GM desk ---------------- */

async function startGm({ db, user, room, pack }) {
  bootMsg('Loading your game.');
  const { EngineHost } = await import('./host.js');
  const host = new EngineHost({ pack, db, room, user });
  const ok = await host.start();
  if (!ok) {
    bootTitle('The desk is open elsewhere');
    bootMsg('Another window is running the GM desk. Close it, or take over here. Only one window can run the game.');
    const go = h('button.btn.btn-cyan', { type: 'button', onclick: async () => { go.disabled = true; if (await host.forceTakeover()) location.reload(); } }, 'Take over here');
    const tv = h('button.btn.btn-ghost', { type: 'button', onclick: () => { location.hash = 'stage'; location.reload(); } }, 'Use this window as the TV');
    $('#boot-actions').replaceChildren(go, tv);
    return;
  }
  await loadCss('gm');
  document.body.classList.add('tool');
  mountTemplate('tpl-gm', 'gm');
  // Hosted extras: lobby above the party, campaign tools in the Campaign view, a TV button in the nav.
  const extras = document.getElementById('tpl-hosted-gm').content.cloneNode(true);
  $('#party').before(extras.querySelector('#lobby-wrap'));
  $('#view-campaign').append(extras.querySelector('#campaign'));
  document.body.append(extras.querySelector('#tv-dlg'));
  $('#gm-nav').append(h('button.nav-tv', { type: 'button', id: 'tv-btn' }, 'TV view'));

  const gmMod = await import('../gm.js');
  const sample = await use('sample');
  const { SystemAI } = await import('./ai.js');
  const ai = new SystemAI(sample, pack);
  const act = async (a, okMsg) => {
    buzz(10);
    try { const r = await host.send(a); if (okMsg) toast(okMsg); return r || true; } catch (e) { toast(e.message, { error: true, ms: 3500 }); return false; }
  };
  const setWriter = (on) => {
    gmMod.ext.customAchievementWriter = on ? ({ brief, player }) => ai.writeAchievement({ brief, player }) : null;
    gmMod.ext.libraryDraft = on ? (o) => ai.draftLibraryEntry(o) : null;
  };
  setWriter(ai.available);
  gmMod.mountGm(host, { hosted: true });
  host.setStatus('open'); // re-announce for the desk, which attached after start()
  host.emit('view', host.gmView());
  $('#boot').remove();

  const { mountLobby, mountCampaign } = await import('./campaign.js');
  mountLobby({ host, user, act });
  mountCampaign({ host, db, ai, act, onAiChange: setWriter });

  $('#campaign').hidden = false;
  $('#tv-btn').addEventListener('click', () => $('#tv-dlg').showModal());
  $('#tv-here').addEventListener('click', () => { try { localStorage.setItem(ROLE_KEY, 'stage'); } catch {} location.hash = 'stage'; location.reload(); });

  host.on('error', (e) => { if (e?.msg) toast(`Not saved: ${e.msg}`, { error: true, ms: 4000 }); });
  window.addEventListener('pagehide', () => { host.flushAll(); });
  window.__systemHost = host; // console debugging
}

/* ---------------- TV ---------------- */

async function startStage({ db, room }) {
  await loadCss('stage');
  mountTemplate('tpl-stage', 'stage');
  const { StageTransport } = await import('./remote.js');
  const stageMod = await import('../stage.js');
  stageMod.mountStage(new StageTransport({ db, room }), { hosted: true });
  $('#boot').remove();
}

/* ---------------- Player ---------------- */

async function startPlayer({ db, user, room, pack }) {
  const me = await user.me();
  if (!me.id) {
    bootTitle('Sign in to join');
    bootMsg('Your claude.ai account gives you your character. Sign in and open this link again.');
    return;
  }
  await loadCss('play');
  document.body.classList.add('tool-page');
  mountTemplate('tpl-waiting', 'waiting-on');
  mountTemplate('tpl-play', 'play');
  $('#app').hidden = true;
  $('#join').hidden = true;
  $('#wait-name').textContent = me.name || 'crawler';
  $('#wait-av').src = me.avatarUrl;
  $('#wait-show-name').textContent = pack.systemName || 'The System';
  $('#boot').remove();

  const { PlayerTransport } = await import('./remote.js');
  const t = new PlayerTransport({ db, room, userId: me.id });
  const waiting = $('#waiting');
  t.on('assigned', (on) => {
    waiting.hidden = on;
    $('#app').hidden = !on;
    document.body.classList.toggle('waiting-on', !on);
    if (on) buzz([40, 30, 40]);
  });
  t.on('public', (v) => {
    if (!v) return;
    const n = v.players?.length || 0;
    $('#wait-show-meta').textContent = `${n ? `${n} crawler${n === 1 ? '' : 's'} in the show` : 'No crawlers yet'}. ${Number(v.audience?.viewers || 0).toLocaleString('en-US')} watching.`;
  });
  t.on('slow', () => {
    $('#wait-show-meta').textContent = 'The game is not running right now. It starts when the GM opens their desk.';
  });
  const playMod = await import('../play.js');
  playMod.mountPlay(t, { hosted: true });
  if (room) room.presence({ role: 'player' }).catch(() => {});
}

main().catch((e) => {
  console.error(e);
  bootTitle('Something broke');
  bootMsg(String(e?.message || e));
});
