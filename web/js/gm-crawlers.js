// GM desk → Show → Crawlers: the worldwide "crawlers remaining" count (server/crawlers.js).
// createCrawlers({ act, getView, open }) → { el (the tool panel), badge (live counter for the Show bar), update(view) }
// Everything mid-session is one tap: announce, a big event somewhere, the floor collapse, a death at the table.
import { h, ask, timeAgo, toast } from './client.js';
import { icon } from './ui.js';
import { crawlerClock, fmtFull, fmtCompact, skullSvg } from './crawlers.js';
import { createGrind } from './gm-grind.js';
import { createSurvival } from './gm-survival.js';

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
  const grind = createGrind({ act });
  const survival = createSurvival({ act });

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
  const clockBox = h('div.crg-clock');
  const restBox = h('div.crg-rest');
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
    h('div.crg-sec', h('h3', 'Floor'), clockBox, collapseBox),
    grind.el,
    survival.el,
    h('div.crg-sec', h('h3', 'Rest'), restBox),
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

  // Rest offered to the phones (rest-offer.js): GM picks the kind, each crawler taps Rest; status per crawler.
  function drawRest(players, rests, fighting, k, fmt) {
    const offer = view().rest;
    const kinds = rests ?? { short: { hours: 1 }, long: { hours: 8 } };
    const names = { calm: 'Calm hour', short: 'Short rest', long: 'Long rest', day: 'Full-day rest' };
    if (offer) {
      restBox.replaceChildren(
        h('div.crg-row', h('b', `${offer.label} · ${offer.hours} h`), h('span.hint', 'Phones show Rest; nothing heals until the crawler taps it.')),
        h('div.crg-row', ...offer.crawlers.map((c) => c.done
          ? h('span.chip.on', { title: (c.done.restored || []).join(', ') || 'Nothing to restore' }, `✓ ${c.name}`)
          : h('button.btn.btn-sm', { type: 'button', title: 'Rest this crawler from the desk', onclick: () => act({ t: 'rest.accept', playerId: c.id }, `${c.name} rested.`) }, `Rest ${c.name}`))),
        h('div.crg-row', h('button.btn.btn-sm', { type: 'button', onclick: () => act({ t: 'rest.close' }, 'Rest closed.') }, 'Close the rest')));
      return;
    }
    restBox.replaceChildren(
      players.length ? h('div.crg-row', h('span.hint', 'Offer to the phones'),
        Object.entries(kinds).map(([kind, r]) => h('button.btn.btn-sm.btn-primary', { type: 'button', disabled: fighting || (k?.hours != null && k.hours < (r.hours ?? 0)),
          title: 'TV shows the saferoom, each crawler confirms on the phone; the floor clock moves once',
          onclick: () => act({ t: 'rest.offer', kind }, `${names[kind] ?? kind} offered to the phones.`) }, `${names[kind] ?? kind} · ${r.hours ?? 0} h`))) : h('span.hint', 'No crawlers yet.'),
      fighting ? h('span.hint', 'Finish the fight first.') : null);
  }

  function draw() {
    const c = view().crawlers;
    if (!c) return;
    const players = view().players || [];
    const rests = view().pack?.ruleset?.rests;
    const preciseClock = !!view().pack?.ruleset?.combat?.roundSeconds;
    const fighting = view().combat?.active;
    const s = JSON.stringify([c.clock, c.count, c.at, c.floor, c.running, c.shown, c.speak, c.live, c.history?.length, c.history?.at(-1)?.at, c.events, c.nextStart, players.map((p) => [p.id, p.name]), rests, fighting, preciseClock, view().rest]);
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
    // Floor clock (game time): the GM moves it on; shown on the TV next to the floor.
    const k = c.clock;
    const dh = k?.dayHours || 24;
    const fmt = (hrs) => {
      const minutes = Math.floor(Math.round(hrs * 3600) / 60);
      const days = Math.floor(minutes / (dh * 60));
      const hours = Math.floor(minutes / 60) % dh;
      const min = minutes % 60;
      if (preciseClock) return [days ? `${days} d` : '', hours ? `${hours} h` : '', min ? `${min} min` : ''].filter(Boolean).join(' ') || (hrs > 0 ? '< 1 min' : '0 min');
      return `${hrs >= dh ? `${days} d ` : ''}${Math.round(hrs % dh)} h`;
    };
    const advances = [[1, '+1 h'], [2, rests ? '+2 h' : 'Short rest 2 h'], [8, rests ? '+8 h' : 'Long rest 8 h'], [dh, `+${dh} h`]];
    if (preciseClock) advances.unshift([5 / 60, '+5 min'], [15 / 60, '+15 min']);
    const hoursIn = h('input.inp.inp-sm', { type: 'number', min: 0, step: 'any', value: k?.hours ?? '', 'aria-label': 'Hours until the floor collapses', placeholder: 'hours' });
    clockBox.replaceChildren(
      h('div.crg-row',
        h('b.crg-clock-n', k?.hours != null ? (k.hours <= 0 ? 'Time is up' : `Collapse in ${fmt(k.hours)}`) : 'No floor clock'),
        k ? toggle(k.shown, 'On the TV', 'Hidden on the TV', 'Floor clock next to the floor in the TV HUD', () => act({ t: 'crawlers.clock', shown: !k.shown })) : null),
      (k?.hours != null || preciseClock) ? h('div.crg-row', h('span.hint', 'Game time passes'),
        advances.map(([n, label]) => h('button.btn.btn-sm', { type: 'button', onclick: () => act({ t: 'crawlers.clock', advance: n }, k ? `${fmt(Math.max(0, k.hours - n))} left.` : `${label} game time.`) }, label)),
        preciseClock ? h('button.btn.btn-sm', { type: 'button', title: 'Refresh once-per-scene abilities across the party', onclick: () => act({ t: 'crawlers.clock', scene: true }, 'New scene started.') }, 'New scene') : null) : null,
      k?.hours != null && rests && players.length ? h('div.crg-row', h('span.hint', 'Rest the party'),
        Object.entries(rests).map(([kind, r]) => {
          const label = `${{ calm: 'Calm hour', short: 'Short rest', long: 'Long rest', day: 'Full-day rest' }[kind]} · ${r.hours} h`;
          return h('button.btn.btn-sm', { type: 'button', disabled: fighting || k.hours < r.hours,
            title: 'Recover eligible characters and advance the floor clock', onclick: () => act({ t: 'rest.party', kind }, `${label}. ${fmt(k.hours - r.hours)} left.`) }, label);
        })) : null,
      h('form.crg-row', { onsubmit: (e) => { e.preventDefault(); const v = hoursIn.value === '' ? null : Number(hoursIn.value); act({ t: 'crawlers.clock', hours: v, ...(v != null && !k ? { shown: true } : {}) }, v == null ? 'Floor clock off.' : 'Floor clock set.'); } },
        h('label.crg-lbl', `Hours left (a day = ${dh} h)`, hoursIn), h('button.btn.btn-sm', { type: 'submit' }, 'Set')));
    drawRest(players, rests, fighting, k, fmt);
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
    grind.update(v);
    survival.update(v);
    clock.set(v?.crawlers);
    badge.hidden = !v?.crawlers;
    if (!v?.crawlers) return;
    tick();
    draw();
  }

  return { el, badge, update, refresh: () => { sig = ''; draw(); } };
}
