// GM desk → Show → Crawlers: the worldwide "crawlers remaining" count (server/crawlers.js).
// createCrawlers({ act, getView, open }) → { el (the tool panel), badge (live counter for the Show bar), update(view) }
// Everything mid-session is one tap: announce, a big event somewhere, the floor collapse, a death at the table.
import { h, ask, timeAgo, toast } from './client.js';
import { icon } from './ui.js';
import { crawlerClock, fmtFull, fmtCompact, skullSvg } from './crawlers.js';

const REASON = { collapse: 'Floor collapse', announce: 'Count announced', death: 'Death at the table', drop: 'Casualties' };
const pctText = (e) => {
  const f = (x) => (x * 100 < 1 ? (x * 100).toFixed(1).replace(/\.0$/, '') : Math.round(x * 100));
  return e.min === e.max ? `−${f(e.min)} %` : `−${f(e.min)}–${f(e.max)} %`;
};

export function createCrawlers({ act, getView, open = () => {} }) {
  const view = () => getView() || {};
  const clock = crawlerClock();
  let sig = '';
  let deathPick = '';

  /* ---------- Show bar badge: always visible while the GM runs the show ---------- */
  const badgeNum = h('b.crb-num', '0');
  const badgeShort = h('b.crb-short', '0');
  const badgeFloor = h('span.crb-floor');
  const badge = h('button.cr-badge', { type: 'button', title: 'Crawlers remaining. Click for the controls (announce, events, floor collapse).', onclick: () => open() },
    skullSvg(15), badgeNum, badgeShort, badgeFloor);

  /* ---------- tool panel ---------- */
  const bigNum = h('div.crg-num', '0');
  const state = h('div.crg-state');
  const toggles = h('div.crg-toggles');
  const events = h('div.crg-events');
  const collapseBox = h('div.crg-row');
  const deathBox = h('div.crg-row');
  const history = h('ol.crg-history');
  const customPct = h('input.inp.inp-sm', { type: 'number', min: '0.1', max: '100', step: '0.1', placeholder: '%', 'aria-label': 'Share of the living (%)' });
  const setCount = h('input.inp.inp-sm', { type: 'number', min: '0', step: '1', 'aria-label': 'Crawlers remaining' });
  const setFloor = h('input.inp.inp-sm.crg-floor-inp', { type: 'number', min: '1', max: '99', step: '1', 'aria-label': 'Floor' });

  const el = h('section.crg', { 'aria-label': 'Crawlers remaining' },
    h('div.crg-hero', h('span.crg-ico', skullSvg(34)), h('div', bigNum, state)),
    toggles,
    h('div.crg-sec',
      h('h3', 'The System speaks'),
      h('div.crg-row',
        h('button.btn.btn-primary', { type: 'button', onclick: () => act({ t: 'crawlers.announce' }, 'The count is on the TV.') }, icon('speaker', { size: 16 }), 'Announce the count'),
        h('span.hint', 'Recorded lead-in, then the number. The TV shows it big.'))),
    h('div.crg-sec',
      h('h3', 'Elsewhere in the dungeon'),
      events,
      h('form.crg-row', { onsubmit: (e) => {
        e.preventDefault();
        const p = Number(customPct.value);
        if (!(p > 0 && p <= 100)) { customPct.focus(); return; }
        act({ t: 'crawlers.drop', pct: p / 100, label: 'Casualties' }, `−${p} % of the crawlers.`).then((ok) => { if (ok) customPct.value = ''; });
      } }, customPct, h('button.btn.btn-sm', { type: 'submit' }, 'Kill that share'))),
    h('div.crg-sec', h('h3', 'Floor'), collapseBox),
    h('div.crg-sec', h('h3', 'At the table'), deathBox),
    h('details.crg-sec.crg-fix',
      h('summary', 'Set the count by hand (quiet, no TV moment)'),
      h('form.crg-row', { onsubmit: (e) => {
        e.preventDefault();
        const a = { t: 'crawlers.set' };
        if (setCount.value !== '') a.count = Math.max(0, Math.round(Number(setCount.value)));
        if (setFloor.value !== '') a.floor = Math.max(1, Math.min(99, Math.round(Number(setFloor.value))));
        if (a.count === undefined && a.floor === undefined) return;
        act(a, 'Count updated.').then((ok) => { if (ok) { setCount.value = ''; setFloor.value = ''; } });
      } },
      h('label.crg-lbl', 'Crawlers', setCount), h('label.crg-lbl', 'Floor', setFloor), h('button.btn.btn-sm', { type: 'submit' }, 'Save'))),
    h('div.crg-sec', h('h3', 'Recent'), history),
  );

  const toggle = (on, label, offLabel, title, fn) => h('button.btn.btn-sm.crg-tg', { type: 'button', 'aria-pressed': String(!!on), title, onclick: fn }, on ? label : offLabel);

  function draw() {
    const c = view().crawlers;
    if (!c) return;
    const players = view().players || [];
    const s = JSON.stringify([c.count, c.at, c.floor, c.running, c.shown, c.speak, c.live, c.history?.length, c.history?.at(-1)?.at, c.events, c.nextStart, players.map((p) => [p.id, p.name])]);
    if (s === sig) return;
    sig = s;
    state.replaceChildren(h('span', String(c.label || 'Crawlers remaining').toLowerCase()), h('span.crg-floor', `Floor ${c.floor}`),
      h('span', { class: `crg-live${c.live ? ' on' : ''}` }, c.live ? 'counting down' : !c.running ? 'paused' : 'still (TV off or table idle)'));
    toggles.replaceChildren(
      toggle(c.running, 'Attrition on', 'Attrition paused', 'Slow organic deaths while the show is on air', () => act({ t: 'crawlers.set', running: !c.running }, c.running ? 'Attrition paused.' : 'Attrition on.')),
      toggle(c.shown, 'On the TV', 'Hidden on the TV', 'Counter in the broadcast HUD and on the phones', () => act({ t: 'crawlers.set', shown: !c.shown })),
      toggle(c.speak, 'Read the number', 'Lead-in only', 'After the recorded line, the System reads the number out (TTS)', () => act({ t: 'crawlers.set', speak: !c.speak })));
    events.replaceChildren(...(c.events || []).map((e) => h('button.btn.crg-ev', {
      type: 'button', title: `Kills ${pctText(e)} of the living crawlers, TV moment + System line + chat`,
      onclick: () => act({ t: 'crawlers.drop', event: e.id }).then((ack) => { if (ack?.result) toast(`${e.label}: −${fmtFull(ack.result.lost)} crawlers.`); }),
    }, h('b', e.label), h('span.dim', pctText(e)))));
    collapseBox.replaceChildren(
      c.nextStart != null ? h('button.btn.btn-alarm', { type: 'button', onclick: async () => {
        if (!await ask(`Collapse floor ${c.floor}? Everyone who did not make the stairs dies: about ${fmtFull(c.nextStart)} crawlers reach floor ${c.nextFloor}.`, { ok: `Collapse floor ${c.floor}`, danger: true })) return;
        act({ t: 'crawlers.collapse' }, `Floor ${c.nextFloor}.`);
      } }, icon('down', { size: 16 }), `Collapse floor ${c.floor} → ${c.nextFloor}`) : null,
      h('span.hint', c.nextStart != null ? `≈ ${fmtCompact(c.nextStart)} reach floor ${c.nextFloor}. TV moment, System line, chat.` : 'Last floor.'));
    const sel = h('select.inp.inp-sm', { 'aria-label': 'Who died', onchange: (e) => { deathPick = e.target.value; } },
      h('option', { value: '' }, 'A crawler'), ...players.map((p) => h('option', { value: p.id, selected: p.id === deathPick || null }, p.name)));
    deathBox.replaceChildren(sel, h('button.btn.btn-sm', { type: 'button', onclick: () => {
      const a = { t: 'crawlers.death' };
      if (sel.value) a.playerId = sel.value;
      act(a, '−1. The System noticed.');
    } }, skullSvg(14), 'Died for good (−1)'), h('span.hint', 'The System calls it out, the HUD ticks down by one.'));
    const list = [...(c.history || [])].reverse().slice(0, 8);
    history.replaceChildren(...(list.length ? list.map((x) => h('li',
      h('span.crg-h-what', x.label || REASON[x.reason] || x.reason),
      h('span.crg-h-num', x.from !== x.to ? `${fmtCompact(x.from)} → ${fmtCompact(x.to)}` : fmtCompact(x.to)),
      h('time.dim', timeAgo(x.at)))) : [h('li.dim', 'Nothing yet. The dungeon is patient.')]));
  }

  function tick() {
    const c = clock.data;
    if (!c) return;
    const v = clock.value();
    const full = fmtFull(v);
    if (bigNum.textContent !== full) bigNum.textContent = full;
    if (badgeNum.textContent !== full) { badgeNum.textContent = full; badgeShort.textContent = fmtCompact(v); }
    badgeFloor.textContent = `F${c.floor}`;
    badge.classList.toggle('live', !!c.live);
    badge.hidden = false;
  }
  setInterval(tick, 500);

  function update(v) {
    clock.set(v?.crawlers);
    badge.hidden = !v?.crawlers;
    if (!v?.crawlers) return;
    tick();
    draw();
  }

  return { el, badge, update, refresh: () => { sig = ''; draw(); } };
}
