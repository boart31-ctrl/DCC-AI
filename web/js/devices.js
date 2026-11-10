// GM desk → Settings: "Players & devices" (personal player links + QR, join requests, TV pairing)
// and "Backups" (restore points, export). QR codes are drawn here in the browser (qr.js), so the
// secret player links never travel in a URL to an image service — not even our own /qr route.
import { ext } from './gm.js';
import { h, toast, ask, timeAgo, isHosted } from './client.js';
import { qrSvg } from './qr.js';

const $ = (s) => document.querySelector(s);
const send = (a) => ext.client.send(a);
const openQr = new Set();
let view = null;
let lastSig = '';

async function act(a, okMsg) {
  try {
    const r = await send(a);
    if (okMsg) toast(okMsg);
    return r;
  } catch (err) {
    toast(err.message || 'Refused', { error: true, ms: 4000 });
    return null;
  }
}

function copy(text, what) {
  navigator.clipboard?.writeText(text).then(() => toast(`${what} copied.`), () => toast(text, { ms: 10000 }));
}

function qrBox(url) {
  const box = h('div.dev-qr');
  const art = h('div', { role: 'img', 'aria-label': 'QR code of the personal link' });
  art.innerHTML = qrSvg(url, { ecl: 'M', margin: 2 }); // our own SVG markup, no user HTML
  box.append(art, h('div', h('p.dim', 'Scan with the phone camera, then "Add to Home Screen".'), h('a.url', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url)));
  return box;
}

function playerRow(p, connected) {
  const open = openQr.has(p.id);
  const row = h('li.dev-row', { style: { '--cc': p.color } },
    h('span.cdot' + (connected ? '.on' : ''), { 'aria-hidden': 'true' }),
    h('div.grow', h('div.dev-name', p.name), h('div.dev-sub', connected ? 'Phone connected' : 'Not connected')),
    h('button.btn.btn-sm', { type: 'button', 'aria-expanded': String(open), disabled: !p.joinUrl, onclick: () => { open ? openQr.delete(p.id) : openQr.add(p.id); draw(true); } }, open ? 'Hide QR' : 'Show QR'),
    h('button.btn.btn-sm', { type: 'button', disabled: !p.joinUrl, onclick: () => copy(p.joinUrl, 'Link') }, 'Copy link'),
    h('button.btn.btn-sm.btn-quiet', {
      type: 'button',
      title: 'Lost phone or leaked link: make a new one',
      onclick: async () => {
        if (!(await ask(`Make a new link for ${p.name}? The old link stops working and that phone is logged out.`, { ok: 'New link', danger: true }))) return;
        if (await act({ t: 'player.relink', playerId: p.id }, `New link for ${p.name}.`)) { openQr.add(p.id); }
      },
    }, 'New link'),
  );
  if (open && p.joinUrl) row.append(qrBox(p.joinUrl));
  return row;
}

function requestRow(r, players) {
  const sel = h('select.inp', { 'aria-label': `Character for ${r.name}` },
    h('option', { value: '' }, 'Pick a crawler'),
    players.map((p) => h('option', { value: p.id, selected: p.id === r.wants }, p.name)),
  );
  return h('li.dev-row.req',
    h('div.grow', h('div.dev-name', r.name), h('div.dev-sub', `asked ${timeAgo(r.at)}${r.wants ? '' : ', no crawler picked yet'}`)),
    sel,
    h('button.btn.btn-sm.btn-primary', {
      type: 'button',
      onclick: () => {
        if (!sel.value) { toast('Pick the crawler first.', { error: true }); sel.focus(); return; }
        act({ t: 'player.approve', requestId: r.id, playerId: sel.value }, `${r.name} is in.`);
      },
    }, 'Let in'),
    h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => act({ t: 'player.deny', requestId: r.id }, 'Declined.') }, 'Decline'),
  );
}

function tvRow(tv) {
  return h('li.dev-row',
    h('span.cdot' + (tv.connected ? '.on' : ''), { 'aria-hidden': 'true' }),
    h('div.grow', h('div.dev-name', tv.label), h('div.dev-sub', `${tv.connected ? 'On air' : 'Not connected'} · paired ${timeAgo(tv.at)}`)),
    h('button.btn.btn-sm.btn-quiet', {
      type: 'button',
      onclick: async () => {
        if (await ask(`Unpair ${tv.label}? It will show a new pairing code.`, { ok: 'Unpair', danger: true })) act({ t: 'tv.unpair', tvId: tv.id }, `${tv.label} unpaired.`);
      },
    }, 'Unpair'),
  );
}

function draw(force = false) {
  const g = view?.gm;
  if (!g?.access) return; // older host without the access model
  $('#devices').hidden = false;
  $('#backups').hidden = !g.access.backups;
  const players = g.playersFull || [];
  const on = new Set((view.players || []).filter((p) => p.connected).map((p) => p.id));
  const sig = JSON.stringify([players.map((p) => [p.id, p.name, p.color, p.joinUrl]), [...on], g.requests, g.tvs, g.tvWaiting, [...openQr]]);
  if (!force && sig === lastSig) return;
  if (!force && $('#devices').contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
  lastSig = sig;

  const reqs = g.requests || [];
  $('#dev-requests').hidden = !reqs.length;
  $('#dev-req-list').replaceChildren(...reqs.map((r) => requestRow(r, players)));
  $('#dev-players').replaceChildren(...(players.length ? players.map((p) => playerRow(p, on.has(p.id))) : [h('li.dev-empty', 'No crawlers yet. Add them on the Party tab.')]));
  const tvs = g.tvs || [];
  $('#dev-tvs').replaceChildren(...tvs.map(tvRow));
  const tvUrl = g.access.edition === 'cloud' ? g.stageUrl : `${location.origin}/tv`;
  $('#dev-tv-hint').textContent = g.tvWaiting
    ? `${g.tvWaiting} screen${g.tvWaiting > 1 ? 's are' : ' is'} showing a code.`
    : tvs.length >= g.access.maxTvs ? `All ${g.access.maxTvs} TV slots used.` : `Open ${tvUrl.replace(/^https?:\/\//, '')} on the TV.`;
}

$('#dev-pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const inp = $('#dev-pair-code');
  const code = inp.value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) { toast('The code is 4 letters.', { error: true }); return; }
  if (await act({ t: 'tv.pair', code }, 'TV paired. It is on air now.')) inp.value = '';
});

/* ---------- backups ---------- */

const REASON = {
  'session.new': 'before a new session', idle: 'after a break', periodic: 'during play',
  manual: 'saved by hand', 'before-restore': 'before a restore',
};

async function listBackups() {
  const r = await act({ t: 'backup.list' });
  if (!r) return;
  const list = r.result?.backups || [];
  $('#bk-list').replaceChildren(...(list.length ? list.map((b) => h('li.dev-row',
    h('div.grow', h('div.dev-name', new Date(b.at).toLocaleString()), h('div.dev-sub', `#${b.id} · ${REASON[b.reason] || b.reason}`)),
    h('button.btn.btn-sm', {
      type: 'button',
      onclick: async () => {
        if (!(await ask(`Go back to ${new Date(b.at).toLocaleString()}? Everything after it is replaced (the current state is saved first, so you can undo this). Phones and TVs stay connected.`, { ok: 'Restore', danger: true }))) return;
        if (await act({ t: 'backup.restore', id: b.id }, 'Restored.')) listBackups();
      },
    }, 'Restore'),
  )) : [h('li.dev-empty', 'No restore points yet. The first one is made with the first change.')]));
}

async function exportData(kind) {
  const c = ext.credential || {};
  const headers = c.key ? { 'X-GM-Key': c.key } : c.token ? { 'X-GM-Token': c.token } : {};
  try {
    const res = await fetch(`/api/export?kind=${kind}`, { headers, cache: 'no-store' });
    if (!res.ok) throw new Error(res.status === 401 ? 'Not allowed (GM key?)' : res.status === 429 ? 'Too many tries, wait a minute' : `Export failed (${res.status})`);
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || `system-${kind}.json`;
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast(`Saved ${name}.`);
  } catch (err) {
    toast(err.message, { error: true, ms: 4000 });
  }
}

$('#bk-refresh').addEventListener('click', listBackups);
$('#bk-create').addEventListener('click', async () => { if (await act({ t: 'backup.create' }, 'Restore point saved.')) listBackups(); });
$('#bk-export-session').addEventListener('click', () => exportData('session'));
$('#bk-export-campaign').addEventListener('click', () => exportData('campaign'));

if (!isHosted()) {
  ext.afterRender.push((v) => { view = v; draw(); });
  ext.client.on('event', (e) => {
    if (e.kind === 'joinRequest') toast(`${e.name} wants to join. Settings → Players & devices.`, { ms: 8000 });
  });
}
