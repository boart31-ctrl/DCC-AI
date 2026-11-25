// GM desk → Show → Crawlers: Hazards (fall / thirst / hunger), Crafting (Misc. Junk) and Popularity (floor 2+).
// Server: server/survival.js (`hazard.apply`, `craft.run`) and server/popularity.js (`popularity.*`).
// createSurvival({ act }) → { el, update(view) }; each block hides when the ruleset has no such rules.
import { h } from './client.js';

export function createSurvival({ act }) {
  let v = null;
  let sig = '';
  const st = { who: new Set(), feet: 20, craftWho: '', size: 0, skill: '', name: '', review: {} };
  const result = h('div.srv-result');
  const hazards = h('div.crg-sec.srv');
  const crafting = h('div.crg-sec.srv');
  const popularity = h('div.crg-sec.srv');
  const el = h('div.srv-wrap', hazards, crafting, popularity, result);

  const players = () => v?.gm?.playersFull ?? [];
  const chosen = () => players().filter((p) => st.who.has(p.id)).map((p) => p.id);
  const show = (title, lines) => result.replaceChildren(h('div.crg-sec', h('h3', title), h('ul.grd-list', ...lines.map((x) => h('li', x)))));

  async function hazard(kind, extra = {}) {
    const ids = chosen();
    if (!ids.length) return;
    const r = (await act({ t: 'hazard.apply', kind, playerIds: ids, ...extra }, null))?.result;
    if (!r) return;
    show(kind === 'fall' ? `Fall ${st.feet} ft` : kind === 'thirst' ? 'A day without water' : 'A day without food', r.results.map((x) => (kind === 'fall'
      ? `${x.name}: ${x.dice} = ${x.rolled} − DR ${x.dr} = ${x.afterDr} → −${x.slots} slot${x.slots === 1 ? '' : 's'}${x.prone ? ', prone' : ''}`
      : x.passed ? `${x.name}: fine${x.roll ? ` (Survival ${x.roll.total})` : ''}` : `${x.name}: −${x.slots} slots, +1 Fatigued${x.roll ? ` (Survival ${x.roll.total})` : ''}`)));
  }

  function drawHazards(cfg) {
    hazards.hidden = !cfg;
    if (!cfg) return;
    const who = h('div.crg-row', ...players().map((p) => h('label.grd-cb', h('input', { type: 'checkbox', checked: st.who.has(p.id),
      onchange: (e) => { if (e.target.checked) st.who.add(p.id); else st.who.delete(p.id); } }), p.name)));
    const feet = h('input.inp.inp-sm', { type: 'number', min: cfg.fall?.perFeet ?? 10, step: 5, value: st.feet, 'aria-label': 'Feet fallen', oninput: (e) => { st.feet = Number(e.target.value); } });
    hazards.replaceChildren(h('h3', 'Hazards'), h('p.hint', 'Pick who it hits. The app rolls, applies DR and takes whole slots. Drowning is the Drowning debuff on the sheet.'), who,
      h('div.crg-row',
        cfg.fall ? [h('label.crg-lbl', 'Fell (ft)', feet), h('button.btn.btn-sm', { type: 'button', onclick: () => hazard('fall', { feet: st.feet }) }, `Fall: ${cfg.fall.die === 6 ? 'd6' : `d${cfg.fall.die}`} per ${cfg.fall.perFeet} ft`)] : null,
        cfg.starve ? [h('button.btn.btn-sm', { type: 'button', onclick: () => hazard('thirst') }, 'A day without water'),
          h('button.btn.btn-sm', { type: 'button', onclick: () => hazard('hunger') }, 'A day without food (Survival)')] : null));
  }

  function drawCrafting(cfg) {
    crafting.hidden = !cfg;
    if (!cfg) return;
    const ps = players();
    if (!st.craftWho || !ps.some((p) => p.id === st.craftWho)) st.craftWho = ps[0]?.id ?? '';
    if (!cfg.skills.includes(st.skill)) st.skill = cfg.skills[0] ?? '';
    const me = ps.find((p) => p.id === st.craftWho);
    const junk = Number(me?.sheet?.fields?.[cfg.junkField] ?? 0) || 0;
    const name = h('input.inp.inp-sm', { value: st.name, placeholder: 'Gas mask', 'aria-label': 'Item name', maxlength: 60, oninput: (e) => { st.name = e.target.value; } });
    const run = async (common) => {
      if (!st.name.trim()) { name.focus(); return; }
      const r = (await act({ t: 'craft.run', playerId: st.craftWho, name: st.name.trim(), ...(common ? { common: true } : { size: st.size, skill: st.skill }) }, null))?.result;
      if (!r) return;
      show(`Crafting: ${r.name}`, [r.common ? `Pulled out of the junk drawer. Misc. Junk left: ${r.junk}.`
        : r.success ? `Made it (${r.size}, ${r.hours} h, ${r.cost} junk). ${r.roll.total} vs DC ${r.dc}. Junk left: ${r.junk}.`
          : `Failed: ${r.roll.total} vs DC ${r.dc}. ${r.salvage ?? ''} Junk left: ${r.junk}. ${r.hours} h spent.`]);
      st.name = '';
      sig = '';
    };
    crafting.replaceChildren(h('h3', 'Crafting · Misc. Junk'),
      h('p.hint', 'Common household item: 1 junk, no roll. Uncommon item: junk by size, hours = size × size, Unopposed check (Fabricate, or Engineering with moving parts). Magic items need a workbench (Core Rulebook).'),
      h('div.crg-row',
        h('label.crg-lbl', 'Crawler', h('select.inp.inp-sm', { onchange: (e) => { st.craftWho = e.target.value; sig = ''; draw(); } }, ...ps.map((p) => h('option', { value: p.id, selected: p.id === st.craftWho || null }, p.name)))),
        h('span.dim', `Misc. Junk: ${junk}`), name),
      h('div.crg-row',
        h('button.btn.btn-sm', { type: 'button', disabled: junk < cfg.commonCost || null, onclick: () => run(true) }, `Common item (−${cfg.commonCost})`),
        h('label.crg-lbl', 'Size', h('select.inp.inp-sm', { onchange: (e) => { st.size = Number(e.target.value); } },
          ...cfg.sizes.map((s, i) => h('option', { value: i, selected: i === st.size || null }, `${s.label} · ${s.junk} junk · ${(i + 1) ** 2} h`)))),
        h('label.crg-lbl', 'Skill', h('select.inp.inp-sm', { onchange: (e) => { st.skill = e.target.value; } },
          ...cfg.skills.map((s) => h('option', { value: s, selected: s === st.skill || null }, s)))),
        h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => run(false) }, 'Craft')));
  }

  function drawPopularity(pv) {
    popularity.hidden = !pv;
    if (!pv) return;
    if (!pv.active) { popularity.replaceChildren(h('h3', 'Popularity'), h('p.dim', `Starts on floor ${pv.fromFloor}.`)); return; }
    const rows = players().map((p) => {
      const c = pv.crawlers[p.id] ?? { score: 0, gains: [] };
      const picked = st.review[p.id] ?? new Set(c.autoLosses ?? []);
      st.review[p.id] = picked;
      return h('div.grd-row',
        h('div.crg-row', h('b', p.name), h('span', `Popularity ${c.score}`),
          h('button.btn.btn-sm', { type: 'button', onclick: () => act({ t: 'popularity.adjust', playerId: p.id, delta: 1 }, null) }, '+1'),
          h('button.btn.btn-sm', { type: 'button', onclick: () => act({ t: 'popularity.adjust', playerId: p.id, delta: -1 }, null) }, '−1'),
          c.grindLate != null ? h('span.dim', `ground ${c.grindLate} h in the last 30 h`) : null),
        h('div.crg-row', ...pv.gains.map((g) => h('button.chip', { type: 'button', disabled: c.gains.includes(g.id) || null, title: c.gains.includes(g.id) ? 'Already this floor' : 'Once per floor',
          onclick: () => act({ t: 'popularity.award', playerId: p.id, id: g.id }, `+1 Popularity for ${p.name}.`) }, `+ ${g.label}${(c.autoGains ?? []).includes(g.id) && !c.gains.includes(g.id) ? ' ✓' : ''}`))),
        h('details', h('summary', 'End-of-floor losses'), ...pv.losses.map((l) => h('label.grd-cb', h('input', { type: 'checkbox', checked: picked.has(l.id),
          onchange: (e) => { if (e.target.checked) picked.add(l.id); else picked.delete(l.id); } }), `${l.label}${l.auto ? ' (app checks)' : ''}`))));
    });
    popularity.replaceChildren(h('h3', 'Popularity'), h('p.hint', 'Gains: +1 once per reason on this floor. At the end of the floor tick the losses (the app pre-ticks what it can tell) and run the review.'),
      ...rows,
      h('button.btn.btn-sm', { type: 'button', onclick: async () => {
        const losses = Object.fromEntries(players().map((p) => [p.id, [...(st.review[p.id] ?? [])]]));
        const r = (await act({ t: 'popularity.review', losses }, null))?.result;
        if (r) { st.review = {}; show('Popularity review', r.results.map((x) => `${x.name}: ${x.from} → ${x.to}${x.gains.length ? ` (+${x.gains.length} auto)` : ''}${x.losses.length ? ` (−${x.losses.length})` : ''}`)); }
      } }, 'End of floor: run the review'));
  }

  function draw() {
    const s = v?.gm?.survival;
    const key = JSON.stringify([s, v?.gm?.popularity, players().map((p) => [p.id, p.name, p.sheet?.fields])]);
    if (key === sig) return;
    sig = key;
    el.hidden = !s && !v?.gm?.popularity;
    drawHazards(s?.hazards);
    drawCrafting(s?.crafting);
    drawPopularity(v?.gm?.popularity);
  }

  return { el, update(view) { v = view; draw(); } };
}
