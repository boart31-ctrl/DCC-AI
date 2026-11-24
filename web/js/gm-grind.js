// GM desk → Show → Crawlers → Grinding: one form for the grinding montage (server/grinding.js, `grind.run`)
// plus the level suggestions made at the end of a fight (boss rank, crawler kill) with Give / Drop.
// createGrind({ act }) → { el, update(view) }. Hidden when the ruleset has no grinding and no level hints.
import { h } from './client.js';

const BONUS_LABEL = { neighborhood: 'Neighborhood map', borough: 'Borough field guide' };

export function createGrind({ act }) {
  let sig = '';
  let v = null;
  const picks = new Map(); // playerId → { on, skills: [uid…], fails: '' }
  const hours = h('input.inp.inp-sm', { type: 'number', min: 1, step: 1, value: 5, 'aria-label': 'Grinding hours' });
  const map = h('select.inp.inp-sm', { 'aria-label': 'Map bonus' });
  const comp = h('input', { type: 'checkbox', checked: true });
  const table = h('select.inp.inp-sm', { 'aria-label': 'Complication table' });
  const rows = h('div.grd-rows');
  const last = h('div.grd-last');
  const hints = h('div.grd-hints');
  const form = h('form.crg-sec.grd', { onsubmit: (e) => { e.preventDefault(); run(); } },
    h('h3', 'Grinding montage'),
    h('p.hint', 'Hours of easy fights, no loot. Pick who grinds and which skills take the hours (in order). Past the safe hours per day, each hour is an Endurance check: leave "fails" empty and the app rolls, or type how many failed at the table.'),
    h('div.crg-row', h('label.crg-lbl', 'Hours', hours), h('label.crg-lbl', 'Map', map),
      h('label.crg-lbl.grd-cb', comp, 'Roll a complication'), h('label.crg-lbl', 'Table', table), h('button.btn.btn-primary.btn-sm', { type: 'submit' }, 'Grind')),
    rows, last);
  const el = h('div.grd-wrap', hints, form);

  function pick(id) {
    if (!picks.has(id)) picks.set(id, { on: true, skills: [], fails: '' });
    return picks.get(id);
  }

  async function run() {
    const g = v?.gm?.grinding;
    const n = Number(hours.value);
    if (!g || !Number.isInteger(n) || n < 1 || n > g.maxHours) { hours.focus(); return; }
    const crawlers = (v.gm.playersFull ?? []).filter((p) => pick(p.id).on).map((p) => {
      const s = pick(p.id);
      const row = { playerId: p.id, skills: s.skills };
      if (s.fails !== '') row.fails = Number(s.fails);
      return row;
    });
    if (!crawlers.length) return;
    const a = { t: 'grind.run', hours: n, crawlers, complication: comp.checked };
    if (map.value) a.map = map.value;
    if (table.value) a.tableId = table.value;
    const ack = await act(a, `${n} h of grinding.`);
    if (ack) { for (const s of picks.values()) { s.fails = ''; s.skills = []; } sig = ''; draw(); }
  }

  function skillChips(p, s) {
    const g = v.gm.grinding.crawlers[p.id] ?? {};
    const today = g.day === v.gm.grinding.day;
    return (p.sheet?.skills ?? []).filter((k) => (k.rank ?? 0) >= 1).map((k) => {
      const i = s.skills.indexOf(k.uid);
      const banked = g.skills?.[k.uid] ?? 0;
      const done = today && g.days?.[k.uid] === g.day;
      return h('button.chip.grd-skill', { type: 'button', 'aria-pressed': String(i >= 0), disabled: done || null,
        title: done ? 'Already ground today' : `Needs ${k.rank} h to roll advancement${banked ? ` (${banked} h banked)` : ''}`,
        onclick: () => { if (i >= 0) s.skills.splice(i, 1); else s.skills.push(k.uid); sig = ''; draw(); } },
      i >= 0 ? h('b', `${i + 1}`) : null, `${k.name ?? k.skillId} R${k.rank}${banked ? ` · ${banked}/${k.rank} h` : ''}`);
    });
  }

  function lastLine(c) {
    const sk = c.skills.map((x) => x.skipped ? `${x.name}: ${x.skipped}`
      : x.success !== undefined ? `${x.name} ${x.success ? `R${x.from}→R${x.to}` : `stays R${x.from}`} (d20 ${x.roll})`
        : `${x.name} ${x.banked}/${x.need} h`).join(' · ');
    const lv = c.levelTo > c.levelFrom ? ` · LEVEL ${c.levelFrom}→${c.levelTo}${c.bonusRoll ? ' (lowest: 1d2)' : ''}` : ` · ${c.total}/${c.levelTo} h to level`;
    const ot = c.overtime ? ` · ${c.overtime} h overtime, ${c.fails} failed${c.fatigued ? ' → Fatigued' : ''}` : '';
    return h('li', h('b', c.name), ` ${c.earned} h${c.bonus ? ` (+${c.bonus} map)` : ''}${ot}${lv}`, sk ? h('div.dim', sk) : null,
      c.leftover ? h('div.dim', `${c.leftover} h unused — pick more skills next time`) : null);
  }

  function draw() {
    const g = v?.gm?.grinding;
    const lh = v?.gm?.levelHints ?? [];
    const players = v?.gm?.playersFull ?? [];
    const key = JSON.stringify([g, lh, players.map((p) => [p.id, p.name, p.level, (p.sheet?.skills ?? []).map((k) => [k.uid, k.rank])]), [...picks]]);
    if (key === sig) return;
    sig = key;
    el.hidden = !g && !lh.length;
    const names = new Map(players.map((p) => [p.id, p.name]));
    hints.replaceChildren(...(lh.length ? [h('div.crg-sec', h('h3', 'Level suggestions'),
      ...lh.map((x) => h('div.crg-row',
        h('span', x.kind === 'boss' ? `${x.victim} (${x.rank}) down: +${x.delta} level${x.delta > 1 ? 's' : ''} for ${x.playerIds.map((i) => names.get(i)).filter(Boolean).join(', ')}`
          : `${names.get(x.playerIds[0]) ?? '?'} killed ${x.victim}: d6 ${x.roll}${x.gap ? ` ${x.gap > 0 ? '+' : '−'} ${Math.abs(x.gap)} level gap` : ''} = +${x.delta} levels`),
        h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => act({ t: 'level.hint.apply', id: x.id }, 'Levels given.') }, 'Give'),
        h('button.btn.btn-sm', { type: 'button', onclick: () => act({ t: 'level.hint.dismiss', id: x.id }) }, 'Drop'))))] : []));
    form.hidden = !g;
    if (!g) return;
    const opts = [['', 'No map'], ...Object.entries(g.mapBonus).map(([id, n]) => [id, `${BONUS_LABEL[id] ?? id} (+${n} h from ${g.bonusMinHours} h)`])];
    if (map.options.length !== opts.length) map.replaceChildren(...opts.map(([id, label]) => h('option', { value: id }, label)));
    const tabs = (v.gm.tables?.catalog ?? []).filter((t) => /grind/i.test(`${t.group ?? ''} ${t.id}`));
    const tsig = tabs.map((t) => t.id).join();
    if (table.dataset.sig !== tsig) {
      table.dataset.sig = tsig;
      table.replaceChildren(...tabs.map((t) => h('option', { value: t.id, selected: t.id === g.complicationTable || null }, t.name)));
    }
    hours.max = g.maxHours;
    rows.replaceChildren(...players.map((p) => {
      const s = pick(p.id);
      const gc = g.crawlers[p.id] ?? {};
      const today = gc.day === g.day ? gc.dayHours : 0;
      const fails = h('input.inp.inp-sm.grd-fails', { type: 'number', min: 0, step: 1, value: s.fails, placeholder: 'app rolls', 'aria-label': `${p.name}: failed Endurance hours`,
        oninput: (e) => { s.fails = e.target.value; } });
      return h('div.grd-row',
        h('label.grd-cb', h('input', { type: 'checkbox', checked: s.on, onchange: (e) => { s.on = e.target.checked; sig = ''; draw(); } }), h('b', p.name)),
        h('span.dim', `Lv ${p.level ?? 1} · ${gc.total ?? 0}/${p.level ?? 1} h to level · ${today}/${g.safeHours} safe h today`),
        s.on ? h('div.crg-row', ...skillChips(p, s)) : null,
        s.on ? h('label.crg-lbl', 'Endurance fails', fails) : null);
    }));
    last.replaceChildren(...(g.last ? [h('h3', `Last grind · ${g.last.hours} h`), g.last.complication ? h('p', h('b', 'Complication: '), g.last.complication.text) : null,
      h('ul.grd-list', ...g.last.crawlers.map(lastLine))] : []));
  }

  return { el, update(view) { v = view; draw(); } };
}
