// GM desk → Settings → Campaigns & backup.
//   Campaigns: several per server, each with its own ruleset (picked when it is created, then locked), players,
//   library, history. Switch, rename, delete parked ones.
//   Backup: the GM's own copy of the campaign. Every few minutes (and when the desk is closed) the desk downloads the
//   campaign export and keeps dated versions (a) in this browser (IndexedDB) and (b) optionally in a folder on this
//   computer (put it inside OneDrive / Dropbox / Google Drive for a cloud copy). "Restore" sends one back.
import { ext } from './gm.js';
import { h, toast, ask, timeAgo, isHosted } from './client.js';

const $ = (s) => document.querySelector(s);
const DB = 'system-backups';
const KEEP = 12; // versions per campaign, per place
const EVERY_MS = 5 * 60 * 1000;
let view = null;
let sig = '';
let list = null; // campaign.list result
let busy = false;

/* ---------- IndexedDB (browser copy + the folder handle) ---------- */

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('backups')) d.createObjectStore('backups', { keyPath: 'key' }).createIndex('campaign', 'campaignId');
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function tx(store, mode, fn) {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && typeof req === 'object' && 'readyState' in req ? req.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
const metaGet = (k) => tx('meta', 'readonly', (s) => s.get(k)).catch(() => null);
const metaSet = (k, v) => tx('meta', 'readwrite', (s) => s.put(v, k)).catch(() => null);
async function localList(campaignId) {
  try {
    const all = await tx('backups', 'readonly', (s) => (campaignId ? s.index('campaign').getAll(campaignId) : s.getAll()));
    return (all || []).sort((a, b) => b.at - a.at);
  } catch { return []; }
}

/* ---------- export / import over HTTP (GM credential) ---------- */

function headers() {
  const c = ext.credential || {};
  return c.key ? { 'X-GM-Key': c.key } : c.token ? { 'X-GM-Token': c.token } : {};
}
async function fetchExport() {
  const res = await fetch('/api/export?kind=campaign', { headers: headers(), cache: 'no-store' });
  if (!res.ok) throw new Error(res.status === 401 ? 'Not allowed (GM key?)' : `Export failed (${res.status})`);
  return res.text();
}
async function sendImport(text) {
  const res = await fetch('/api/import', { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: text });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.msg || (res.status === 401 ? 'Not allowed (GM key?)' : `Restore failed (${res.status})`));
  return body;
}

const slug = (s) => String(s || 'campaign').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'campaign';
const stamp = (t) => new Date(t).toISOString().replace(/[:]/g, '-').replace(/\..+$/, '');

/* ---------- the backup itself ---------- */

let folder = null; // FileSystemDirectoryHandle
let folderState = 'none'; // none | ok | prompt | unsupported
let lastBackup = 0;
let lastError = '';

async function loadFolder() {
  if (!('showDirectoryPicker' in window)) { folderState = 'unsupported'; return; }
  folder = await metaGet('folder');
  if (!folder) { folderState = 'none'; return; }
  try {
    const p = await folder.queryPermission({ mode: 'readwrite' });
    folderState = p === 'granted' ? 'ok' : 'prompt';
  } catch { folderState = 'prompt'; }
}

async function pickFolder() {
  try {
    folder = await window.showDirectoryPicker({ id: 'system-backups', mode: 'readwrite' });
    await metaSet('folder', folder);
    folderState = 'ok';
    await backupNow('folder picked');
  } catch (err) {
    if (err?.name !== 'AbortError') toast(err.message || 'Could not use that folder', { error: true });
  }
  draw(true);
}
async function reconnectFolder() {
  try {
    const p = await folder.requestPermission({ mode: 'readwrite' });
    folderState = p === 'granted' ? 'ok' : 'prompt';
    if (folderState === 'ok') await backupNow('folder reconnected');
  } catch { folderState = 'prompt'; }
  draw(true);
}

async function writeFolder(camp, text, at) {
  if (folderState !== 'ok' || !folder) return false;
  const dir = await folder.getDirectoryHandle(`${slug(camp.name)}-${camp.id.slice(-6)}`, { create: true });
  const file = await dir.getFileHandle(`${stamp(at)}.json`, { create: true });
  const w = await file.createWritable();
  await w.write(text);
  await w.close();
  const names = [];
  for await (const [name, hd] of dir.entries()) if (hd.kind === 'file' && name.endsWith('.json')) names.push(name);
  names.sort();
  for (const n of names.slice(0, Math.max(0, names.length - KEEP))) await dir.removeEntry(n).catch(() => {});
  return true;
}

async function backupNow(reason = 'auto', { quiet = true } = {}) {
  if (busy || !view?.campaign || isHosted()) return;
  busy = true;
  try {
    const text = await fetchExport();
    const camp = view.campaign;
    const at = Date.now();
    const rec = { key: `${camp.id}:${at}`, campaignId: camp.id, name: camp.name, ruleset: camp.ruleset, at, reason, size: text.length, data: text };
    await tx('backups', 'readwrite', (s) => s.put(rec));
    const mine = await localList(camp.id);
    if (mine.length > KEEP) await tx('backups', 'readwrite', (s) => { for (const old of mine.slice(KEEP)) s.delete(old.key); });
    const inFolder = await writeFolder(camp, text, at).catch((e) => { lastError = e.message; return false; });
    lastBackup = at;
    lastError = '';
    if (!quiet) toast(inFolder ? 'Backed up in this browser and your folder.' : 'Backed up in this browser.');
  } catch (err) {
    lastError = err.message;
    if (!quiet) toast(err.message, { error: true });
  } finally {
    busy = false;
    draw(true);
  }
}

async function restoreText(text, label) {
  if (!(await ask(`Restore ${label}? The running campaign is saved first, so you can switch back. Players get their links for the restored campaign.`, { ok: 'Restore', danger: true }))) return;
  try {
    const r = await sendImport(text);
    toast(`Restored: ${r.campaign?.name || 'campaign'}.`);
    await refresh();
  } catch (err) { toast(err.message, { error: true, ms: 5000 }); }
}

function pickFile() {
  const inp = h('input', { type: 'file', accept: '.json,application/json' });
  inp.addEventListener('change', async () => {
    const f = inp.files?.[0];
    if (!f) return;
    await restoreText(await f.text(), f.name);
  });
  inp.click();
}

/* ---------- campaigns ---------- */

const send = (a) => ext.client.send(a);
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
async function refresh() {
  const r = await act({ t: 'campaign.list' });
  list = r?.result ?? null;
  draw(true);
}

function rulesetLabel(id) {
  return (view?.gm?.rulesetChoices || list?.choices || []).find((c) => c.id === id)?.label || id;
}

async function newCampaign() {
  const choices = view?.gm?.rulesetChoices || list?.choices || [];
  const name = h('input.inp', { type: 'text', maxlength: 60, placeholder: 'Campaign name', value: '' });
  const rs = h('select.inp', choices.map((c) => h('option', { value: c.id }, `${c.label}${c.native ? ' (this pack)' : ''}`)));
  const box = h('div.camp-new', h('label', h('span.dim', 'Name'), name), h('label', h('span.dim', 'Rules'), rs),
    h('p.hint', 'The rules are fixed for this campaign. Monsters, bosses and items from the library are converted to them (AC, HP, to-hit, damage, DCs). For other rules, start another campaign.'));
  if (!(await ask(box, { ok: 'Start campaign', title: 'New campaign' }))) return;
  await backupNow('before new campaign');
  const r = await act({ t: 'campaign.new', name: name.value.trim() || 'New campaign', ruleset: rs.value }, 'New campaign started.');
  if (r) refresh();
}

async function switchTo(c) {
  if (!(await ask(`Switch to "${c.name}" (${rulesetLabel(c.ruleset)})? The running campaign is kept and backed up. Players need the links of the other campaign.`, { ok: 'Switch' }))) return;
  await backupNow('before switch');
  if (await act({ t: 'campaign.switch', id: c.id }, `Now running: ${c.name}.`)) refresh();
}
async function remove(c) {
  if (!(await ask(`Delete "${c.name}" from this server for good? Backups in your browser and folder stay.`, { ok: 'Delete', danger: true }))) return;
  if (await act({ t: 'campaign.delete', id: c.id }, 'Deleted.')) refresh();
}
async function rename() {
  const inp = h('input.inp', { type: 'text', maxlength: 60, value: view.campaign?.name || '' });
  if (!(await ask(h('label', h('span.dim', 'Campaign name'), inp), { ok: 'Rename', title: 'Rename campaign' }))) return;
  if (inp.value.trim()) act({ t: 'campaign.rename', name: inp.value.trim() }, 'Renamed.');
}

/* ---------- drawing ---------- */

async function draw(force = false) {
  const root = $('#campaigns');
  if (!root || !view?.campaign) return;
  const c = view.campaign;
  const s = JSON.stringify([c, list, folderState, lastBackup, lastError, view.gm?.access?.campaigns]);
  if (!force && s === sig) return;
  sig = s;
  const local = await localList(c.id);
  const multi = !!view.gm?.access?.campaigns;
  const others = list?.campaigns || [];
  const att = view.pack?.ruleset?.system?.attribution;
  root.replaceChildren(...[
    h('h2', 'Campaign & backup'),
    h('div.camp-cur',
      h('div', h('b', c.name), h('span.dim', ` · ${view.pack?.ruleset?.system?.label || rulesetLabel(c.ruleset)}`)),
      h('div.row-start',
        h('button.btn.btn-sm', { type: 'button', onclick: rename }, 'Rename'),
        multi ? h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: newCampaign }, 'New campaign…') : null)),
    att ? h('details.camp-att', h('summary', 'Rules licence'), h('p.hint', att)) : null,
    multi && others.length ? h('div.dev-sec', h('h3', 'Other campaigns'), h('ul.dev-list', others.map((o) => h('li.dev-row',
      h('div.grow', h('div.dev-name', o.name), h('div.dev-sub', `${rulesetLabel(o.ruleset)} · ${o.players ?? 0} players · saved ${timeAgo(o.savedAt)}`)),
      h('button.btn.btn-sm', { type: 'button', onclick: () => switchTo(o) }, 'Switch'),
      h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => remove(o) }, 'Delete'))))) : null,
    !multi ? h('p.hint', 'This server keeps one campaign. Your backups below still let you take it anywhere.') : null,
    h('div.dev-sec',
      h('h3', 'Your backup'),
      h('p.dim', 'The desk saves a copy every 5 minutes and when you close it: in this browser, and in a folder if you pick one. A folder inside OneDrive, Dropbox or Google Drive gives you a cloud copy.'),
      h('p.camp-state', lastError ? h('span.bad', `Last try failed: ${lastError}`) : lastBackup ? `Last backup ${timeAgo(lastBackup)}` : 'No backup yet in this session.'),
      h('div.row-start',
        h('button.btn.btn-sm.btn-primary', { type: 'button', disabled: busy, onclick: () => backupNow('manual', { quiet: false }) }, 'Back up now'),
        folderState === 'unsupported' ? h('span.hint', 'Folder backup needs Chrome or Edge on a computer. Use "Export campaign" instead.')
          : folderState === 'ok' ? h('span.pill.ok', `Folder: ${folder?.name}`)
            : folderState === 'prompt' ? h('button.btn.btn-sm', { type: 'button', onclick: reconnectFolder }, `Reconnect folder ${folder?.name || ''}`)
              : h('button.btn.btn-sm', { type: 'button', onclick: pickFolder }, 'Choose backup folder…'),
        folderState === 'ok' || folderState === 'prompt' ? h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: pickFolder }, 'Change folder') : null,
        h('button.btn.btn-sm', { type: 'button', onclick: pickFile }, 'Restore from a file…')),
      local.length ? h('ul.dev-list', local.slice(0, 6).map((b) => h('li.dev-row',
        h('div.grow', h('div.dev-name', new Date(b.at).toLocaleString()), h('div.dev-sub', `In this browser · ${Math.round(b.size / 1024)} kB`)),
        h('button.btn.btn-sm', { type: 'button', onclick: () => restoreText(b.data, `the backup from ${new Date(b.at).toLocaleString()}`) }, 'Restore')))) : null),
  ].filter(Boolean));
}

if (!isHosted()) {
  loadFolder().then(() => draw(true));
  ext.afterRender.push((v) => {
    view = v;
    if (!list && v?.gm?.access?.campaigns) refresh();
    draw();
  });
  // Campaign changed (switch / new / import): refresh the list.
  let lastId = null;
  ext.afterRender.push((v) => { if (v?.campaign?.id && v.campaign.id !== lastId) { if (lastId) refresh(); lastId = v.campaign.id; } });
  setInterval(() => { if (view?.campaign && Date.now() - lastBackup > EVERY_MS) backupNow('auto'); }, 30_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') backupNow('closing'); });
}
