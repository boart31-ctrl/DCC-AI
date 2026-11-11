// GM desk onboarding: getting crawlers onto their phones and the TV on air without a manual.
//
//  - Party → "Add crawler": name + colour → the Invite card (big QR of the personal link, copy/share,
//    phone status live), then "Build character now" or "Let the player build it on the phone".
//  - Party, while setup is not finished: a three-step checklist (add crawlers, phones scanned,
//    TV paired) that ticks itself off from the live view. Empty party = the big version.
//  - Join requests (a phone opened /join): banner with Approve on the Party view + badge on the nav.
//  - Top bar "TV" button with on-air status: pairing code input, paired screens, unpair.
// QR codes are drawn here (qr.js): the secret player links never go to an image service.
import { ext, showView } from './gm.js';
import { h, toast, ask, timeAgo, buzz } from './client.js';
import { qrSvg } from './qr.js';
import { icon } from './ui.js';

const $ = (s, r = document) => r.querySelector(s);
const send = (a) => ext.client.send(a);
const NEONS = ['#e3a33b', '#70a9e4', '#5db67f', '#c77dd8', '#e0594f', '#4fc1b5', '#d6c14a', '#9aa7ff'];
let view = null;

async function act(a, okMsg) {
  buzz(10);
  try {
    const r = await send(a);
    if (okMsg) toast(okMsg);
    return r || true;
  } catch (err) {
    toast(err.message || 'Refused', { error: true, ms: 4000 });
    return null;
  }
}

/* ---------- derived state ---------- */

const gmv = () => view?.gm || {};
const players = () => view?.players || [];
const full = (id) => (gmv().playersFull || []).find((p) => p.id === id) || players().find((p) => p.id === id) || null;
const isOn = (id) => !!players().find((p) => p.id === id)?.connected;
const access = () => gmv().access || null;
const cloud = () => access()?.edition === 'cloud';
function tvState() {
  const g = gmv();
  const tvs = g.tvs || [];
  const on = (g.stagesOn ?? tvs.reduce((n, t) => n + (t.connected || 0), 0)) > 0;
  return { tvs, on, waiting: g.tvWaiting || 0, max: g.access?.maxTvs ?? 3 };
}
function tvAddress() {
  const g = gmv();
  const url = cloud() && g.stageUrl ? g.stageUrl : `${location.origin}/tv`;
  return url.replace(/^https?:\/\//, '');
}
function steps() {
  const ps = players();
  const on = ps.filter((p) => p.connected).length;
  return [
    { id: 'add', done: ps.length > 0 },
    { id: 'scan', done: ps.length > 0 && on === ps.length, on, total: ps.length },
    { id: 'tv', done: tvState().on },
  ];
}

function copy(text, what) {
  navigator.clipboard?.writeText(text).then(() => toast(`${what} copied.`), () => toast(text, { ms: 10000 }));
}

/* ---------- modal shell (full screen on phones) ---------- */

function modal({ label, cls = '' }) {
  const dlg = h('dialog.ob-dlg.tool', { class: `ob-dlg tool ${cls}`, 'aria-label': label });
  const close = () => { try { dlg.close(); } catch {} dlg.remove(); dlg.onClosed?.(); };
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  document.body.append(dlg);
  return { dlg, close, open: () => dlg.showModal() };
}
const closeBtn = (fn) => h('button.icon-btn.ob-x', { type: 'button', 'aria-label': 'Close', onclick: fn }, icon('x', { size: 18 }));

/* ---------- Add crawler → Invite card ---------- */

let inviteLive = null; // { playerId, refresh() } while an invite card is open

export function openAddCrawler() {
  const m = modal({ label: 'Add a crawler', cls: 'ob-add' });
  let color = NEONS[players().length % NEONS.length];
  const name = h('input.inp.ob-name', { name: 'name', placeholder: 'Bugatti', maxlength: 40, required: true, autocomplete: 'off', 'aria-label': 'Crawler name' });
  const swatches = h('div.ob-swatches', { role: 'radiogroup', 'aria-label': 'Colour' }, NEONS.map((c) => h('button.ob-sw', {
    type: 'button', role: 'radio', 'aria-checked': String(c === color), 'aria-label': `Colour ${c}`, style: { '--sw': c },
    onclick: (e) => { color = c; for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-checked', String(b.style.getPropertyValue('--sw') === c)); },
  })));
  const pin = !cloud() && !ext.hosted ? h('input.inp.ob-pin', { name: 'pin', placeholder: 'Random', inputmode: 'numeric', pattern: '\\d{4}', maxlength: 4, 'aria-label': 'PIN (optional)' }) : null;
  const submit = h('button.btn.btn-primary.ob-go', { type: 'submit' }, 'Add crawler');
  const form = h('form.ob-form', { autocomplete: 'off' },
    h('label.ob-field', h('span.ob-l', 'Name'), name),
    h('div.ob-field', h('span.ob-l', 'Colour on the TV'), swatches),
    pin ? h('label.ob-field', h('span.ob-l', 'PIN for the room-code login (optional)'), pin) : null,
    h('div.ob-row', submit),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = name.value.trim();
    if (!n) { name.focus(); return; }
    submit.disabled = true;
    const a = { t: 'player.add', name: n, color };
    if (pin?.value.trim()) a.pin = pin.value.trim();
    const r = await act(a);
    submit.disabled = false;
    const pid = r?.result?.playerId;
    if (!pid) return;
    m.close();
    openInvite(pid, { fresh: true, pin: cloud() ? null : r.result?.pin });
  });
  m.dlg.append(
    h('header.ob-head', h('div', h('h2', 'Add a crawler'), h('p.dim', 'Next you get a QR code for their phone.')), closeBtn(m.close)),
    h('div.ob-body', form),
  );
  m.open();
  setTimeout(() => name.focus(), 30);
}

/** The Invite card: QR of the crawler's personal link + what to do with it. */
export function openInvite(playerId, { fresh = false, pin } = {}) {
  const m = modal({ label: 'Invite', cls: 'ob-invite' });
  const body = h('div.ob-body');
  const head = h('header.ob-head');
  m.dlg.append(head, body);
  let lastSig = '';
  let seen = false;
  const draw = () => {
    const p = full(playerId);
    if (!p) {
      // Just added: the ack can arrive before the view that contains the crawler.
      if (seen) { m.close(); return; }
      if (!body.childElementCount) body.append(h('p.dim', 'Setting up the crawler…'));
      return;
    }
    seen = true;
    const url = p.joinUrl || '';
    const on = isOn(playerId);
    const sig = JSON.stringify([p.name, p.color, url, on, view?.session?.permissions]);
    if (sig === lastSig) return;
    lastSig = sig;
    head.replaceChildren(
      h('div.ob-who', h('span.ob-chip', { style: { '--cc': p.color || 'var(--c-accent)' } }),
        h('div', h('h2', fresh ? `${p.name} is in the game` : `Invite ${p.name}`), h('p.dim', 'Show this to their phone.'))),
      closeBtn(m.close),
    );
    const qr = h('div.ob-qr', { role: 'img', 'aria-label': `QR code of ${p.name}'s personal link` });
    if (url) qr.innerHTML = qrSvg(url, { ecl: 'M', margin: 2 }); // our own SVG markup
    else qr.append(h('p.ob-noqr', 'This edition has no personal links. Players join with the room code and their PIN.'));
    const status = h('p.ob-status', { class: on ? 'ob-status on' : 'ob-status', 'aria-live': 'polite' },
      h('span.cdot', { class: on ? 'cdot on' : 'cdot' }), on ? `${p.name}'s phone is connected.` : `Waiting for ${p.name}'s phone…`);
    const canBuild = (view?.session?.permissions?.playerEdit ?? 'sheet') === 'sheet';
    body.replaceChildren(
      h('div.ob-invite-grid',
        h('div.ob-qr-col', qr, url ? h('div.ob-link', h('code', url.replace(/^https?:\/\//, '')),
          h('div.ob-row',
            h('button.btn.btn-sm', { type: 'button', onclick: () => copy(url, 'Link') }, icon('copy', { size: 14 }), 'Copy link'),
            navigator.share ? h('button.btn.btn-sm', { type: 'button', onclick: () => navigator.share({ title: `${p.name} · The System`, url }).catch(() => {}) }, icon('share', { size: 14 }), 'Share') : null,
          )) : null),
        h('div.ob-steps-col',
          h('ol.ob-how',
            h('li', h('b', 'Scan with the phone camera.'), ' Tap the link that pops up.'),
            h('li', h('b', 'Add to Home Screen.'), ' Share menu (iPhone) or ⋮ menu (Android). The icon opens this crawler next time.'),
            h('li', h('b', 'Keep the phone on the table.'), ' Loot, achievements and messages land there.'),
          ),
          pin ? h('p.dim.ob-pin-note', `Room-code login: PIN ${pin}.`) : null,
          status,
          h('div.ob-next',
            h('button.btn.btn-primary', { type: 'button', onclick: () => { m.close(); ext.openBuilderFor?.(playerId); } }, 'Build character now'),
            h('button.btn', {
              type: 'button',
              onclick: async () => {
                if (!canBuild && !(await act({ t: 'session.permissions', playerEdit: 'sheet' }, 'Players may now edit their whole sheet.'))) return;
                m.close();
                toast(`${p.name} can build the character on the phone.`);
              },
            }, canBuild ? 'Let the player build it on the phone' : 'Let the player build it (unlocks sheets)'),
          ),
          h('div.ob-row.ob-foot',
            h('button.btn.btn-quiet.btn-sm', { type: 'button', onclick: () => { m.close(); openAddCrawler(); } }, icon('plus', { size: 14 }), 'Add another crawler'),
            url ? h('button.btn.btn-quiet.btn-sm', {
              type: 'button',
              title: 'Lost phone or leaked link',
              onclick: async () => {
                if (!(await ask(`Make a new link for ${p.name}? The old link stops working and that phone is logged out.`, { ok: 'New link', danger: true }))) return;
                await act({ t: 'player.relink', playerId }, `New link for ${p.name}.`);
              },
            }, 'New link') : null,
          ),
        ),
      ),
    );
  };
  inviteLive = { playerId, refresh: draw };
  m.dlg.onClosed = () => { if (inviteLive?.playerId === playerId) inviteLive = null; };
  draw();
  m.open();
}

/* ---------- TV ---------- */

function pairForm({ big = false } = {}) {
  const inp = h('input.inp.ob-code', { maxlength: 4, autocapitalize: 'characters', spellcheck: 'false', autocomplete: 'off', placeholder: 'ABCD', 'aria-label': 'Code on the TV' });
  inp.addEventListener('input', () => { inp.value = inp.value.toUpperCase().replace(/[^A-Z]/g, ''); });
  const f = h('form.ob-pair', { class: big ? 'ob-pair big' : 'ob-pair', autocomplete: 'off' }, inp, h('button.btn.btn-primary', { type: 'submit' }, 'Pair TV'));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = inp.value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) { toast('The code is 4 letters.', { error: true }); inp.focus(); return; }
    if (await act({ t: 'tv.pair', code }, 'TV paired. It is on air now.')) inp.value = '';
  });
  return f;
}

let tvDlg = null;
function openTv() {
  const m = modal({ label: 'TV screen', cls: 'ob-tv' });
  const body = h('div.ob-body');
  m.dlg.append(h('header.ob-head', h('div', h('h2', 'TV screen'), h('p.dim', 'The show runs in the TV\'s own browser.')), closeBtn(m.close)), body);
  const form = pairForm({ big: true });
  const list = h('ul.dev-list');
  const status = h('p.ob-status');
  const draw = () => {
    const t = tvState();
    status.className = t.on ? 'ob-status on' : 'ob-status';
    status.replaceChildren(h('span.cdot', { class: t.on ? 'cdot on' : 'cdot' }), t.on ? 'On air.' : t.waiting ? `${t.waiting} screen${t.waiting > 1 ? 's are' : ' is'} showing a code. Type it below.` : 'No TV on air.');
    list.replaceChildren(...t.tvs.map((tv) => h('li.dev-row',
      h('span.cdot', { class: tv.connected ? 'cdot on' : 'cdot', 'aria-hidden': 'true' }),
      h('div.grow', h('div.dev-name', tv.label), h('div.dev-sub', `${tv.connected ? 'On air' : 'Not connected'}, paired ${timeAgo(tv.at)}`)),
      h('button.btn.btn-sm.btn-quiet', {
        type: 'button',
        onclick: async () => { if (await ask(`Unpair ${tv.label}? It will show a new pairing code.`, { ok: 'Unpair', danger: true })) act({ t: 'tv.unpair', tvId: tv.id }, `${tv.label} unpaired.`); },
      }, 'Unpair'),
    )));
  };
  body.append(
    status,
    h('ol.ob-how',
      h('li', 'On the TV, open ', h('b.mono', tvAddress()), '.'),
      h('li', 'It shows a 4-letter code. Type it here.'),
    ),
    form,
    list,
    h('p.dim.ob-small', 'No TV at hand? ', h('a', { href: '/tv', target: '_blank', rel: 'noopener' }, 'Open the stage in a new tab'), ' on this computer.'),
  );
  tvDlg = { draw };
  m.dlg.onClosed = () => { tvDlg = null; };
  draw();
  m.open();
  setTimeout(() => form.querySelector('input')?.focus(), 30);
}

function drawTvButton() {
  const b = $('#tv-btn');
  if (!b) return;
  const t = tvState();
  b.hidden = !access();
  b.classList.toggle('on', t.on);
  b.classList.toggle('waiting', !t.on && t.waiting > 0);
  b.title = t.on ? 'TV on air' : t.waiting ? 'A TV is showing a pairing code' : 'No TV on air: pair one';
  $('.tv-state', b).textContent = t.on ? 'On air' : t.waiting ? 'Code waiting' : 'Pair';
}

/* ---------- join requests ---------- */

function requestRow(r) {
  const ps = gmv().playersFull || [];
  const sel = h('select.inp', { 'aria-label': `Crawler for ${r.name}` },
    h('option', { value: '' }, 'Which crawler?'),
    ps.map((p) => h('option', { value: p.id, selected: p.id === r.wants }, `${p.name}${isOn(p.id) ? ' (on a phone)' : ''}`)),
  );
  return h('li.ob-req',
    h('div.ob-req-who', h('b', r.name), h('span.dim', ` asked ${timeAgo(r.at)}${r.wants ? '' : ', no crawler picked yet'}`)),
    h('div.ob-req-act',
      sel,
      h('button.btn.btn-primary.btn-sm', {
        type: 'button',
        onclick: () => {
          if (!sel.value) { toast('Pick the crawler first.', { error: true }); sel.focus(); return; }
          act({ t: 'player.approve', requestId: r.id, playerId: sel.value }, `${r.name} is in.`);
        },
      }, 'Approve'),
      h('button.btn.btn-quiet.btn-sm', { type: 'button', onclick: () => act({ t: 'player.deny', requestId: r.id }, 'Declined.') }, 'Decline'),
    ),
  );
}

function originRow(p) {
  const pend = p.sheet?.pending || {};
  const what = ['race', 'class', 'background'].filter((k) => pend[k] !== undefined).map((k) => `${k === 'class' ? 'Class' : k === 'race' ? 'Race' : 'Background'}: ${pend[k] || '(none)'}`).join(', ');
  return h('li.ob-req',
    h('div.ob-req-who', h('b', p.name), h('span.dim', ` asks for ${what}`)),
    h('div.ob-req-act',
      h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => act({ t: 'origins.approve', playerId: p.id }, `${p.name}: approved and locked.`) }, 'Approve'),
      h('button.btn.btn-quiet.btn-sm', { type: 'button', onclick: () => act({ t: 'origins.deny', playerId: p.id }, 'Declined.') }, 'Decline'),
    ),
  );
}

let reqSig = '';
function drawRequests() {
  const joins = gmv().requests || [];
  const origins = (gmv().playersFull || []).filter((p) => p.sheet?.pending && Object.keys(p.sheet.pending).length);
  const reqs = [...joins, ...origins];
  for (const b of document.querySelectorAll('[data-view="party"]')) {
    let badge = b.querySelector('.nav-badge');
    if (reqs.length && !badge) b.append(badge = h('span.nav-badge'));
    if (badge) { badge.textContent = String(reqs.length); badge.hidden = !reqs.length; }
  }
  const box = $('#join-reqs');
  if (!box) return;
  const sig = JSON.stringify([joins, origins.map((p) => [p.id, p.sheet.pending]), (gmv().playersFull || []).map((p) => [p.id, p.name]), players().map((p) => p.connected)]);
  if (sig === reqSig || box.contains(document.activeElement)) return;
  reqSig = sig;
  box.hidden = !reqs.length;
  box.replaceChildren(
    ...(joins.length ? [
      h('div.ob-req-head', icon('phone', { size: 16 }), h('b', joins.length === 1 ? 'A phone wants to join' : `${joins.length} phones want to join`), h('span.dim', 'Pick their crawler, then approve.')),
      h('ul.ob-reqs', joins.map(requestRow)),
    ] : []),
    ...(origins.length ? [
      h('div.ob-req-head', icon('users', { size: 16 }), h('b', 'Race and class requests'), h('span.dim', 'Approving locks the choice for the player.')),
      h('ul.ob-reqs', origins.map(originRow)),
    ] : []),
  );
}

/* ---------- setup checklist ---------- */

const HIDE_KEY = 'system.gm.setupHidden';
let setupSig = '';
function drawSetup() {
  const box = $('#setup');
  if (!box) return;
  const ps = players();
  const st = steps();
  const allDone = st.every((s) => s.done);
  let hidden = false;
  try { hidden = localStorage.getItem(HIDE_KEY) === '1'; } catch {}
  const empty = ps.length === 0;
  const show = !!access() && (empty || (!allDone && !hidden));
  const t = tvState();
  const sig = JSON.stringify([show, empty, st, ps.map((p) => [p.id, p.name, p.color, p.connected]), t.waiting, t.on]);
  if (sig === setupSig) return;
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  setupSig = sig;
  box.hidden = !show;
  box.classList.toggle('big', empty);
  if (!show) { box.replaceChildren(); return; }
  const [sAdd, sScan, sTv] = st;
  const mark = (s, n) => h('span.ob-mark', { class: s.done ? 'ob-mark done' : 'ob-mark', 'aria-label': s.done ? 'Done' : `Step ${n}` }, s.done ? icon('check', { size: 16 }) : String(n));
  const step = (s, n, title, desc, extra) => h('li.ob-step', { class: s.done ? 'ob-step done' : 'ob-step' },
    mark(s, n), h('div.ob-step-b', h('h3', title), desc ? h('p.dim', desc) : null, extra || null));
  const inviteChips = ps.length ? h('div.ob-chips', ps.map((p) => h('button.ob-pchip', {
    type: 'button', style: { '--cc': p.color || 'var(--c-accent)' }, onclick: () => openInvite(p.id), title: p.connected ? 'Phone connected' : `Show ${p.name}'s QR code`,
  }, h('span.cdot', { class: p.connected ? 'cdot on' : 'cdot' }), p.name, p.connected ? null : icon('qr', { size: 14 })))) : null;
  box.replaceChildren(
    h('div.ob-setup-head',
      h('h2', empty ? 'Get the show on air' : 'Setup'),
      empty ? h('p.dim', 'Three steps. They tick themselves off.') : h('button.btn.btn-quiet.btn-sm', { type: 'button', onclick: () => { try { localStorage.setItem(HIDE_KEY, '1'); } catch {} setupSig = ''; drawSetup(); } }, 'Hide'),
    ),
    h('ol.ob-steps',
      step(sAdd, 1, 'Add crawlers', sAdd.done ? `${ps.length} in the game.` : 'One per player. You can build sheets later.',
        h('button.btn.btn-primary', { type: 'button', onclick: openAddCrawler }, icon('plus', { size: 14 }), sAdd.done ? 'Add another' : 'Add crawler')),
      step(sScan, 2, 'Players scan their QR', !ps.length ? 'Each crawler gets a personal QR code.' : `${sScan.on} of ${sScan.total} phones connected. Tap a name to show its code.`, inviteChips),
      step(sTv, 3, 'Pair the TV', sTv.done ? 'On air.' : `On the TV, open ${tvAddress()} and type the code it shows.`, sTv.done ? null : pairForm()),
    ),
  );
}

/* ---------- wiring ---------- */

function render(v) {
  view = v;
  drawTvButton();
  drawRequests();
  drawSetup();
  inviteLive?.refresh();
  tvDlg?.draw();
}

ext.openAddCrawler = openAddCrawler;
ext.openInvite = openInvite;
ext.openTv = openTv;
ext.afterRender.push(render);
$('#tv-btn')?.addEventListener('click', openTv);
ext.client.on('event', (e) => {
  if (e.kind === 'originsRequest') toast(`${e.name} asks for ${Object.values(e.pending || {}).filter(Boolean).join(' ') || 'a change'}. Approve on the Party tab.`, { ms: 7000 });
  if (e.kind === 'joinRequest') {
    toast(`${e.name} wants to join. Approve on the Party tab.`, { ms: 8000 });
    if (!document.querySelector('#view-party:not([hidden])')) for (const b of document.querySelectorAll('[data-view="party"]')) b.classList.add('ping');
  }
});
document.addEventListener('click', (e) => { if (e.target.closest?.('[data-view="party"]')) for (const b of document.querySelectorAll('[data-view="party"]')) b.classList.remove('ping'); });
export { showView };
