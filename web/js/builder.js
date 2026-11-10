// Step-by-step character builder: Identity → Origins → Stats → Skills → Starting gear → Review.
// Nothing is sent until Review; then the builder sends the same actions a hand edit would.
import { h, toast } from './client.js';
import { evaluate } from './rules.js';
import { icon, signed, field, select, labeled } from './ui.js';

const STEPS = [
  { id: 'identity', label: 'Identity' },
  { id: 'origins', label: 'Race and class' },
  { id: 'stats', label: 'Stats' },
  { id: 'skills', label: 'Skills' },
  { id: 'gear', label: 'Starting gear' },
  { id: 'review', label: 'Review' },
];

/**
 * @param {object} o
 * @param {object} o.model   sheet model (rules.sheetModel)
 * @param {object} o.player
 * @param {boolean} o.gm
 * @param {(a:object)=>Promise} o.act  sheet act() (adds playerId for the GM)
 */
export function openBuilder({ model: M, player, gm, act }) {
  const rs = M.rs;
  const id = M.sheet.identity || {};
  const d = {
    identity: { name: id.name || player.name || '', pronouns: id.pronouns || '', crawlerNumber: id.crawlerNumber || '', floor: id.floor ?? 1, level: id.level ?? player.level ?? 1 },
    race: id.race || '', class: id.class || '', background: id.background || '',
    stats: Object.fromEntries(rs.stats.map((s) => {
      const raw = M.sheet.stats?.[s.id] || {};
      const def = typeof s.default === 'object' ? s.default : { value: s.default ?? 10 };
      const parts = s.parts?.length ? s.parts : ['value'];
      return [s.id, Object.fromEntries(parts.map((p) => [p, raw[p] ?? def[p] ?? def.value ?? 10]))];
    })),
    skills: new Map((M.sheet.skills || []).filter((s) => s.skillId).map((s) => [s.skillId, s.rank ?? 1])),
    gear: new Set(),
  };
  let step = 0;
  const dlg = h('dialog.builder.tool', { 'aria-label': 'Character builder' });
  const nav = h('ol.bld-steps');
  const body = h('div.bld-body');
  const back = h('button.btn', { type: 'button', onclick: () => go(step - 1) }, 'Back');
  const next = h('button.btn.btn-primary', { type: 'button', onclick: () => (step === STEPS.length - 1 ? save() : go(step + 1)) });
  dlg.append(
    h('header.bld-head',
      h('div', h('h2', 'Character builder'), h('p.dim', `${d.identity.name || 'New crawler'}. Nothing is saved until the last step.`)),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Close builder', onclick: () => close() }, icon('x', { size: 18 })),
    ),
    nav, body,
    h('footer.bld-foot', back, h('span.grow'), next),
  );
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.append(dlg);
  dlg.showModal();

  function close() { try { dlg.close(); } catch {} dlg.remove(); }

  function go(i) {
    step = Math.max(0, Math.min(STEPS.length - 1, i));
    nav.replaceChildren(...STEPS.map((s, j) => h('li', { class: j === step ? 'on' : j < step ? 'done' : null, 'aria-current': j === step ? 'step' : null },
      h('button', { type: 'button', onclick: () => go(j) }, h('span.n', String(j + 1)), h('span.l', s.label)))));
    back.disabled = step === 0;
    next.textContent = step === STEPS.length - 1 ? 'Save character' : `Next: ${STEPS[step + 1].label}`;
    body.replaceChildren(render[STEPS[step].id]());
    body.scrollTop = 0;
    body.querySelector('input, select, button.pick-card')?.focus({ preventScroll: true });
  }

  const render = {
    identity() {
      const set = (k) => (v) => { d.identity[k] = v; };
      return h('div.bld-step',
        h('p.bld-lede', 'Who is this? Only the name is required.'),
        h('div.form-grid',
          labeled('Name', field(d.identity.name, { onCommit: set('name'), attrs: { required: true } }), { cls: 'span-2' }),
          labeled('Pronouns', field(d.identity.pronouns, { onCommit: set('pronouns'), placeholder: 'she/her, they/them…' })),
          rs.identity.includes('crawlerNumber') || rs.fields.some((f) => f.id === 'crawlerNumber') ? labeled('Crawler #', field(d.identity.crawlerNumber, { onCommit: set('crawlerNumber') })) : null,
          rs.identity.includes('floor') ? labeled('Floor', field(d.identity.floor, { type: 'number', onCommit: set('floor'), attrs: { min: 0, inputmode: 'numeric' } })) : null,
          labeled('Level', field(d.identity.level, { type: 'number', onCommit: set('level'), attrs: { min: 0, inputmode: 'numeric' } })),
        ),
      );
    },
    origins() {
      const group = (label, key, list) => {
        const custom = d[key] && !list.some((x) => x.name === d[key]);
        const other = field(custom ? d[key] : '', { placeholder: 'Or type one', onCommit: (v) => { d[key] = v.trim(); redraw(); } });
        const redraw = () => body.replaceChildren(render.origins());
        return h('fieldset.bld-group',
          h('legend', label),
          list.length ? h('div.pick-cards', list.map((x) => h('button.pick-card', {
            type: 'button', 'aria-pressed': String(d[key] === x.name),
            onclick: () => { d[key] = d[key] === x.name ? '' : x.name; redraw(); },
          }, h('b', x.name), x.desc ? h('span', x.desc) : null))) : h('p.dim', `The pack lists no ${label.toLowerCase()} options yet. Type one.`),
          labeled('Other', other),
        );
      };
      return h('div.bld-step',
        h('p.bld-lede', 'Pick from the pack, or type your own. Placeholders are fine; the GM can change them later.'),
        group('Race', 'race', libOr('race', rs.races)),
        group('Class', 'class', libOr('class', rs.classes)),
        rs.backgrounds.length || M.lib.background.length ? group('Background', 'background', libOr('background', rs.backgrounds)) : null,
      );
    },
    stats() {
      const parts = rs.stats[0]?.parts?.length ? rs.stats[0].parts : ['value'];
      const modOf = (sid) => {
        const v = d.stats[sid][rs.statMod?.from || parts[0]] ?? 0;
        return rs.statMod ? evaluate(rs.statMod.formula, { resolve: (n) => (n === 'x' ? Number(v) : undefined) }).value : Number(v);
      };
      const table = h('table.bld-stats',
        h('thead', h('tr', h('th', 'Stat'), parts.map((p) => h('th', p === 'value' ? 'Value' : p === 'enhanced' ? 'Enhanced' : p === 'unenhanced' ? 'Unenhanced' : p)), rs.statMod ? h('th', 'Mod') : null)),
        h('tbody', rs.stats.map((s) => {
          const modCell = h('td.num-cell', signed(modOf(s.id)));
          return h('tr',
            h('th', { scope: 'row' }, h('b', s.abbr), h('span.dim', ` ${s.label}`)),
            parts.map((p) => h('td', field(d.stats[s.id][p], { type: 'number', attrs: { inputmode: 'numeric', 'aria-label': `${s.label} ${p}` }, onCommit: (v) => { d.stats[s.id][p] = v; modCell.textContent = signed(modOf(s.id)); } }))),
            rs.statMod ? modCell : null,
          );
        })),
      );
      return h('div.bld-step',
        h('p.bld-lede', rs.statMod ? `Modifier = ${rs.statMod.formula.replace(/\bx\b/g, rs.statMod.from || 'value')}.${rs.statMod.verify ? ' Not checked against the rulebook yet.' : ''}` : 'Enter each stat.'),
        table,
      );
    },
    skills() {
      const cat = (M.lib.skill.length ? M.lib.skill : rs.skills.catalog).slice().sort((a, b) => a.name.localeCompare(b.name));
      const count = h('p.bld-count');
      const upd = () => { count.textContent = `${d.skills.size} picked`; };
      upd();
      return h('div.bld-step',
        h('p.bld-lede', 'Tick the skills this character starts with and set their rank.'),
        count,
        h('ul.bld-skills', cat.map((s) => {
          const on = d.skills.has(s.id);
          const rank = field(d.skills.get(s.id) ?? 1, { type: 'number', attrs: { min: 0, max: rs.skills.rankMax, inputmode: 'numeric', 'aria-label': `${s.name} rank` }, onCommit: (v) => { if (d.skills.has(s.id)) d.skills.set(s.id, v); } });
          rank.disabled = !on;
          const box = h('input', { type: 'checkbox', checked: on, onchange: (e) => { if (e.target.checked) d.skills.set(s.id, Number(rank.value) || 1); else d.skills.delete(s.id); rank.disabled = !e.target.checked; upd(); } });
          return h('li', h('label.chk', box, h('span', h('b', s.name), h('span.dim', ` ${rs.stats.find((x) => x.id === s.stat)?.abbr || s.stat}, ${s.checkType || 'Standard'}`))), rank);
        })),
      );
    },
    gear() {
      const items = M.lib.item.slice().sort((a, b) => a.name.localeCompare(b.name));
      const q = h('input.inp.inp-search', { type: 'search', placeholder: `Search ${items.length} items`, 'aria-label': 'Search items' });
      const list = h('ul.bld-gear');
      const drawList = () => {
        const t = q.value.trim().toLowerCase();
        list.replaceChildren(...items.filter((it) => !t || `${it.name} ${(it.tags || []).join(' ')}`.toLowerCase().includes(t)).slice(0, 120).map((it) => h('li',
          h('label.chk', h('input', { type: 'checkbox', checked: d.gear.has(it.id), onchange: (e) => { e.target.checked ? d.gear.add(it.id) : d.gear.delete(it.id); } }),
            h('span', h('b', it.name), h('span.dim', ` ${it.rarity || 'common'}${it.slot ? `, ${it.slot}` : ''}`))))));
      };
      q.addEventListener('input', drawList);
      drawList();
      return h('div.bld-step',
        h('p.bld-lede', gm ? 'Pick what they start with. Items go straight into their inventory.' : 'Pick what you would like to start with. The list goes to your GM in your notes; the GM hands the items out.'),
        items.length ? [q, list] : h('p.dim', 'The library has no items yet.'),
      );
    },
    review() {
      const rows = [
        ['Name', d.identity.name || '—'], ['Race', d.race || '—'], ['Class', d.class || '—'],
        ...(rs.backgrounds.length ? [['Background', d.background || '—']] : []),
        ['Level', d.identity.level], ['Stats', rs.stats.map((s) => `${s.abbr} ${Object.values(d.stats[s.id]).join('/')}`).join(', ')],
        ['Skills', [...d.skills].map(([sid, r]) => `${(M.lib.skill.find((x) => x.id === sid) || rs.skills.catalog.find((x) => x.id === sid))?.name || sid} ${r}`).join(', ') || 'None'],
        ['Starting gear', [...d.gear].map((gid) => M.lib.item.find((x) => x.id === gid)?.name || gid).join(', ') || 'None'],
      ];
      return h('div.bld-step', h('p.bld-lede', 'Check it, then save. You can change anything later from the sheet.'), h('dl.kv.kv-wide', rows.map(([k, v]) => h('div', h('dt', k), h('dd', String(v))))));
    },
  };

  function libOr(kind, list) {
    const l = M.lib[kind];
    return l.length ? l : list;
  }

  async function save() {
    if (!d.identity.name.trim()) { go(0); toast('Give the character a name first.', { error: true }); return; }
    next.disabled = true;
    next.textContent = 'Saving…';
    const ops = [];
    for (const [k, v] of Object.entries(d.identity)) ops.push({ t: 'sheet.set', path: `identity.${k}`, value: v });
    for (const k of ['race', 'class', 'background']) if (d[k] || M.sheet.identity?.[k]) ops.push({ t: 'sheet.set', path: `identity.${k}`, value: d[k] });
    for (const [sid, parts] of Object.entries(d.stats)) for (const [p, v] of Object.entries(parts)) ops.push({ t: 'sheet.set', path: `stats.${sid}.${p}`, value: Number(v) || 0 });
    const have = new Map((M.sheet.skills || []).map((s) => [s.skillId, s]));
    for (const [sid, rank] of d.skills) {
      const cur = have.get(sid);
      if (!cur) ops.push({ t: 'skill.add', skillId: sid, rank: Number(rank) || 1 });
      else if (cur.rank !== rank) ops.push({ t: 'skill.update', uid: cur.uid, rank: Number(rank) || 0 });
    }
    if (d.gear.size) {
      if (gm) for (const gid of d.gear) ops.push({ t: 'lib.give', kind: 'item', id: gid });
      else {
        const names = [...d.gear].map((gid) => M.lib.item.find((x) => x.id === gid)?.name || gid).join(', ');
        const notes = M.sheet.story?.notes || '';
        ops.push({ t: 'sheet.set', path: 'story.notes', value: `${notes ? `${notes}\n` : ''}Starting gear requested: ${names}` });
      }
    }
    let failed = 0;
    for (const op of ops) { if (!(await act(op))) failed++; }
    if (failed) { toast(`${failed} of ${ops.length} changes did not save. Check the sheet.`, { error: true, ms: 5000 }); next.disabled = false; next.textContent = 'Save character'; return; }
    toast('Character saved.');
    close();
  }

  go(0);
  return { close };
}
