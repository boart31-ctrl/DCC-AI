// Hosted edition entry. Decides the role (GM desk / TV / player) from the Artifact runtime, mounts
// the matching page body from its <template>, then hands the existing page module a transport.
import { deserializePack } from '../../engine/engine.js';
import { h, toast, buzz } from '../client.js';

globalThis.__SYSTEM_HOSTED__ = true;
const $ = (s, r = document) => r.querySelector(s);

const bootTitle = (t) => { $('#boot-title').firstChild.textContent = t; };
const bootMsg = (t) => { $('#boot-msg').textContent = t; };

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
  if (owner) return startGm({ db, user, room, pack });
  return startPlayer({ db, user, room, pack });
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
  mountTemplate('tpl-gm', 'gm');
  // Hosted extras: tabs, lobby on the left column, campaign view.
  const extras = document.getElementById('tpl-hosted-gm').content.cloneNode(true);
  const topbar = $('.topbar');
  topbar.after(extras.querySelector('#htabs'));
  $('.col-players').prepend(extras.querySelector('#lobby-wrap'));
  $('.desk').after(extras.querySelector('#campaign'));
  document.body.append(extras.querySelector('#tv-dlg'));

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
  };
  setWriter(ai.available);
  gmMod.mountGm(host, { hosted: true });
  $('#boot').remove();

  const { mountLobby, mountCampaign } = await import('./campaign.js');
  mountLobby({ host, user, act });
  mountCampaign({ host, db, ai, act, onAiChange: setWriter });

  // Desk / Campaign tabs.
  const showView = (v) => {
    for (const b of document.querySelectorAll('#htabs [data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === v));
    $('.desk').hidden = v !== 'desk';
    $('#campaign').hidden = v !== 'campaign';
    try { sessionStorage.setItem('system.gmView', v); } catch {}
  };
  $('#htabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) showView(b.dataset.view);
  });
  let saved = 'desk';
  try { saved = sessionStorage.getItem('system.gmView') || 'desk'; } catch {}
  showView(saved);
  $('#tv-btn').addEventListener('click', () => $('#tv-dlg').showModal());
  $('#tv-here').addEventListener('click', () => { location.hash = 'stage'; location.reload(); });

  host.on('error', (e) => { if (e?.msg) toast(`Not saved: ${e.msg}`, { error: true, ms: 4000 }); });
  window.addEventListener('pagehide', () => { host.flushAll(); });
  window.__systemHost = host; // console debugging
}

/* ---------------- TV ---------------- */

async function startStage({ db, room }) {
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
  playMod.mountPlay(t, { hosted: true, saveNotes: (text) => t.saveNotes(text) });
  if (room) room.presence({ role: 'player' }).catch(() => {});
}

main().catch((e) => {
  console.error(e);
  bootTitle('Something broke');
  bootMsg(String(e?.message || e));
});
