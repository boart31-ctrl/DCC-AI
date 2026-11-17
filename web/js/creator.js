// Guided character creation for rulesets with a `creation` block (server/creation.js, ruleset.js
// normalizeCreation). One question per screen, an "i" explanation on every step, nothing typed that the
// rules work out. Steps: name → each life stage (pick a description, then its skills) → weapon → stats →
// starting stuff → story (saved as you type) → review with the basic actions anyone can do.
// The choices are sent once, as `creation.apply`; starting stuff waits for the GM's approval.
// A draft is kept on this device until it is sent, so closing the phone loses nothing.
//
// openCreator({ model, player, gm, act }) → { close }
import { h, toast, ask, itemArt } from './client.js';
import { evaluate } from './rules.js';
import { icon, signed, field } from './ui.js';

const STORE = 'system.creator.';
const load = (id) => { try { return JSON.parse(localStorage.getItem(STORE + id) || 'null'); } catch { return null; } };
const keep = (id, d) => { try { localStorage.setItem(STORE + id, JSON.stringify(d)); } catch {} };
const drop = (id) => { try { localStorage.removeItem(STORE + id); } catch {} };

export function hasCreator(model) { return !!model?.rs?.creation; }

export function openCreator({ model: M, player, gm, act }) {
  const rs = M.rs;
  const cr = rs.creation;
  const skillName = (id) => (M.lib.skill.find((s) => s.id === id) || rs.skills.catalog.find((s) => s.id === id))?.name || id;
  const skillOf = (id) => M.lib.skill.find((s) => s.id === id) || rs.skills.catalog.find((s) => s.id === id) || null;
  const statAbbr = (id) => rs.stats.find((s) => s.id === id)?.abbr || (id ? id.toUpperCase() : '');
  const draft = load(player.id) || {
    name: M.sheet.identity?.name || player.name || '', pronouns: M.sheet.identity?.pronouns || M.sheet.fields?.pronouns || '',
    bg: {}, weapon: null, method: cr.statMethods.array.length ? 'array' : 'roll', stats: {}, stuff: {},
  };
  const save = () => keep(player.id, draft);
  const steps = [
    { id: 'name', label: 'Name' },
    ...cr.backgrounds.map((g) => ({ id: `bg:${g.id}`, label: g.label, g })),
    ...(cr.combat ? [{ id: 'weapon', label: 'Weapon' }] : []),
    { id: 'stats', label: 'Stats' },
    ...(cr.stuff.length ? [{ id: 'stuff', label: 'Your stuff' }] : []),
    { id: 'story', label: 'Story' },
    { id: 'review', label: 'Ready' },
  ];
  let step = Math.min(draft.step || 0, steps.length - 1);
  const dlg = h('dialog.builder.tool.creator', { 'aria-label': 'Create your crawler' });
  const bar = h('div.cr-progress');
  const body = h('div.bld-body.cr-body');
  const back = h('button.btn', { type: 'button', onclick: () => go(step - 1) }, icon('back', { size: 14 }), 'Back');
  const next = h('button.btn.btn-primary', { type: 'button', onclick: () => onNext() });
  dlg.append(
    h('header.bld-head', h('div', h('h2', 'Create your crawler'), bar),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Close (your choices stay on this phone)', onclick: () => { save(); close(); toast('Saved on this phone. Open it again from your sheet.'); } }, icon('x', { size: 18 }))),
    body,
    h('footer.bld-foot', back, h('span.grow'), next));
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); save(); close(); });
  document.body.append(dlg);
  dlg.showModal();
  function close() { try { dlg.close(); } catch {} dlg.remove(); }

  /* ---------- helpers ---------- */
  const info = (key, extra) => {
    const t = cr.help[key] || extra;
    if (!t) return null;
    const box = h('p.cr-info', { hidden: true }, t);
    return [h('button.cr-i', { type: 'button', 'aria-label': 'What is this?', onclick: () => { box.hidden = !box.hidden; } }, icon('info', { size: 16 })), box];
  };
  const head = (title, key, sub) => {
    const i = info(key);
    return h('div.cr-head', h('div.cr-head-row', h('h3', title), i ? i[0] : null), sub ? h('p.dim', sub) : null, i ? i[1] : null);
  };
  /** Skills already taken by other stages (and the weapon): no double-dipping. */
  function takenBy(exceptStage) {
    const m = new Map();
    for (const [sid, v] of Object.entries(draft.bg)) if (sid !== exceptStage) for (const x of v.skills || []) m.set(x, cr.backgrounds.find((g) => g.id === sid)?.label || sid);
    if (exceptStage !== 'weapon' && draft.weapon && !draft.weapon.none) { const w = cr.combat.weapons[draft.weapon.index ?? draft.weapon.like]; if (w) m.set(w.skill, 'Weapon'); }
    if (cr.combat?.fixed) m.set(cr.combat.fixed.skill, 'everyone');
    return m;
  }
  const modOf = (v) => (rs.statMod ? evaluate(rs.statMod.formula, { resolve: (n) => (n === 'x' ? Number(v) : undefined) }).value : Number(v));

  /* ---------- steps ---------- */
  const render = {
    name() {
      return h('div.bld-step',
        head('Who are you?', null, 'The name the System will shout when you do something stupid.'),
        h('label.lbl', h('span.lbl-t', 'Name'), field(draft.name, { onCommit: (v) => { draft.name = v.trim(); save(); paint(); }, attrs: { autocomplete: 'off' } })),
        h('label.lbl', h('span.lbl-t', 'Pronouns (optional)'), field(draft.pronouns, { placeholder: 'she/her, he/him, they/them…', onCommit: (v) => { draft.pronouns = v.trim(); save(); } })),
        h('p.dim.cr-note', icon('lock', { size: 12 }), ' Level, floor, crawler number and AI Favor come from the System (your GM).'));
    },
    stage(g) {
      const cur = draft.bg[g.id] || null;
      const taken = takenBy(g.id);
      const opt = cur ? g.options.find((o) => o.name === cur.option) : null;
      const setOpt = (o) => { draft.bg[g.id] = { option: o.name, skills: (cur?.option === o.name ? cur.skills : []).filter((x) => o.skills.includes(x)) }; save(); paint(); requestAnimationFrame(() => body.querySelector('#cr-pick')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })); };
      const roll = () => { const o = g.options[Math.floor(Math.random() * g.options.length)]; toast(`${g.roll || 'Roll'}: ${o.name}`); setOpt(o); };
      return h('div.bld-step',
        head(g.label, 'background', `Pick one, then ${g.pick} of its skills. They start at Rank ${g.rank}.`),
        h('div.cr-row', h('button.btn.btn-sm', { type: 'button', onclick: roll }, icon('dice', { size: 14 }), `Let the dice pick (${g.roll || 'random'})`)),
        h('div.cr-cards', g.options.map((o) => h('button.cr-card', { type: 'button', 'aria-pressed': String(cur?.option === o.name), onclick: () => setOpt(o) },
          h('b', o.name),
          h('span', o.skills.map((x) => `${skillName(x)}${skillOf(x)?.stat ? ` (${statAbbr(skillOf(x).stat)})` : ''}`).join(', '))))),
        opt ? h('div.cr-pick', { id: 'cr-pick' },
          h('h4', `${opt.name}: pick ${g.pick}`, h('span.dim', ` (${(cur.skills || []).length}/${g.pick})`)),
          h('div.cr-skills', opt.skills.map((x) => {
            const on = (cur.skills || []).includes(x);
            const clash = taken.get(x);
            const s = skillOf(x);
            return h('button.cr-skill', {
              type: 'button', 'aria-pressed': String(on), disabled: !!clash && !on,
              onclick: () => {
                const list = new Set(cur.skills || []);
                if (on) list.delete(x); else { if (list.size >= g.pick) list.delete([...list][0]); list.add(x); }
                draft.bg[g.id].skills = [...list]; save(); paint();
              },
            }, h('b', skillName(x)), h('span.dim', [s?.stat ? statAbbr(s.stat) : 'no stat', s?.checkType].filter(Boolean).join(' · ')), s?.desc ? h('span.cr-desc', s.desc) : null, clash && !on ? h('span.cr-clash', `already from ${clash}`) : null);
          }))) : null);
    },
    weapon() {
      const list = cr.combat.weapons;
      const taken = takenBy('weapon');
      const w = draft.weapon;
      const groups = [...new Set(list.map((x) => x.group))];
      const pickIdx = (i) => { draft.weapon = { index: i }; save(); paint(); };
      const dmg = (x) => `${x.dice}${x.damageStat ? ` + ${statAbbr(x.damageStat)}` : ''}`;
      return h('div.bld-step',
        head('Your weapon', 'weapon', cr.combat.fixed ? `Everyone has ${cr.combat.fixed.name} (${cr.combat.fixed.dice} + ${statAbbr(cr.combat.fixed.damageStat || cr.combat.fixed.stat)}). Pick what you carried: it starts at Rank ${cr.combat.rank}.` : ''),
        groups.map((gr) => h('div.cr-group', h('h4', gr),
          h('div.cr-cards.cr-cards-sm', list.map((x, i) => (x.group !== gr ? null : h('button.cr-card', { type: 'button', 'aria-pressed': String(w?.index === i || w?.like === i), disabled: taken.has(x.skill), title: taken.has(x.skill) ? `Already a skill from ${taken.get(x.skill)}` : '', onclick: () => pickIdx(i) },
            h('b', x.name), h('span', `${dmg(x)} ${x.damageType || ''} · to hit ${statAbbr(x.stat)}`), x.note ? h('span.dim', x.note) : null)))))),
        cr.combat.custom ? h('details.cr-custom', { open: w?.like !== undefined || null },
          h('summary', 'My own weapon (a tire iron, a frying pan…)'),
          h('div.cr-row',
            field(w?.name || '', { placeholder: 'Tire iron', onCommit: (v) => { if (!v.trim()) return; draft.weapon = { name: v.trim(), like: w?.like ?? w?.index ?? 0 }; save(); paint(); } }),
            h('span.dim', 'works like'),
            h('select.inp.inp-sm', { onchange: (e) => { draft.weapon = { name: w?.name || 'My weapon', like: Number(e.target.value) }; save(); paint(); } }, list.map((x, i) => h('option', { value: i, selected: (w?.like ?? -1) === i || null }, x.name))))) : null);
    },
    stats() {
      const ids = rs.stats.map((s) => s.id);
      const m = cr.statMethods;
      const arr = m.array;
      const setMethod = (x) => { draft.method = x; draft.stats = {}; save(); paint(); };
      const rows = rs.stats.map((s) => {
        const v = draft.stats[s.id];
        let control;
        if (draft.method === 'array') {
          control = h('div.cr-vals', arr.map((n) => {
            const holder = ids.find((k) => draft.stats[k] === n);
            return h('button.cr-val', { type: 'button', 'aria-pressed': String(v === n), class: holder && holder !== s.id ? 'cr-val used' : 'cr-val', title: holder && holder !== s.id ? `Used by ${statAbbr(holder)}: tap to swap` : '', onclick: () => {
              if (holder && holder !== s.id) draft.stats[holder] = v; // swap
              draft.stats[s.id] = n;
              if (draft.stats[holder] === undefined) delete draft.stats[holder];
              save(); paint();
            } }, String(n));
          }));
        } else {
          const sides = Number(m.roll?.dice?.slice(1) || 6);
          const rr = m.roll?.reroll || [];
          const rollOne = () => { let n; do { n = 1 + Math.floor(Math.random() * sides); } while (rr.includes(n)); draft.stats[s.id] = n; save(); paint(); };
          control = h('div.cr-vals', Array.from({ length: sides }, (_, i) => i + 1).filter((n) => !rr.includes(n)).map((n) => h('button.cr-val', { type: 'button', 'aria-pressed': String(v === n), onclick: () => { draft.stats[s.id] = n; save(); paint(); } }, String(n))),
            h('button.btn.btn-sm.btn-quiet', { type: 'button', title: 'Roll it here instead of a real die', onclick: rollOne }, icon('dice', { size: 14 })));
        }
        return h('div.cr-stat', h('div.cr-stat-n', h('b', s.abbr), h('span.dim', s.label)), control,
          h('div.cr-mod', { title: 'Modifier: worked out from the score, added to rolls' }, v === undefined ? '–' : signed(modOf(v))));
      });
      const done = ids.every((k) => draft.stats[k] !== undefined);
      const con = draft.stats.con; const dex = draft.stats.dex; const int = draft.stats.int;
      return h('div.bld-step',
        head('Stats', 'stats'),
        m.array.length && m.roll ? h('div.cr-seg', { role: 'radiogroup' },
          h('button', { type: 'button', role: 'radio', 'aria-checked': String(draft.method === 'array'), onclick: () => setMethod('array') }, `Assign ${arr.join(', ')}`),
          h('button', { type: 'button', role: 'radio', 'aria-checked': String(draft.method === 'roll'), onclick: () => setMethod('roll') }, `Roll ${m.roll.dice}${m.roll.reroll.length ? ` (reroll ${m.roll.reroll.join(', ')})` : ''}`)) : null,
        h('p.dim', draft.method === 'array' ? 'Tap a number for each stat. Each number once; tapping a used one swaps them.' : 'Roll a real die for each stat in order and tap what it showed (or let the phone roll). No swapping.'),
        h('div.cr-stats', rows),
        h('div.cr-derived', cr.derived.map((d) => h('div', h('b', d.label), ' ', d.label === 'Evade' && dex !== undefined ? h('span.pill', `d20 ${signed(modOf(dex))}`) : d.label === 'Health' && con !== undefined ? h('span.pill', `10 × ${modOf(con)}`) : d.label === 'Mana' && int !== undefined ? h('span.pill', String(int)) : null, h('p.dim', d.text)))),
        done ? null : h('p.cr-warn', `${ids.filter((k) => draft.stats[k] === undefined).length} stat(s) still empty.`));
    },
    stuff() {
      const starter = (it) => (it.rarity || 'common') === 'common' && !(it.tags || []).some((t) => /quest|legendary|unique|boss|sponsor|weapon/i.test(t)) && !it.attack;
      const items = M.lib.item.filter(starter).sort((a, b) => a.name.localeCompare(b.name));
      const w = draft.weapon;
      const wName = !w ? 'Nothing yet (pick a weapon)' : w.none ? 'No weapon' : w.name ? `${w.name} (${cr.combat.weapons[w.like]?.name})` : cr.combat.weapons[w.index]?.name;
      const slot = (s) => {
        if (s.auto === 'weapon') return h('div.cr-slot', h('h4', s.label), h('p', h('b', wName)), h('p.dim', s.hint));
        const cur = draft.stuff[s.id] || {};
        const q = h('input.inp.inp-search', { type: 'search', placeholder: `Search ${items.length} plain items`, 'aria-label': 'Search items' });
        const list = h('div.cr-items');
        const drawList = () => {
          const t = q.value.trim().toLowerCase();
          list.replaceChildren(...items.filter((it) => !t || it.name.toLowerCase().includes(t)).slice(0, t ? 60 : 24).map((it) => h('button.cr-item', { type: 'button', 'aria-pressed': String(cur.itemId === it.id), onclick: () => { draft.stuff[s.id] = { itemId: it.id }; save(); paint(); } }, itemArt(it, 'cr-ico'), h('span', it.name))));
        };
        q.addEventListener('input', drawList);
        drawList();
        return h('div.cr-slot', h('h4', s.label), h('p.dim', s.hint),
          cur.itemId ? h('p', icon('check', { size: 14 }), ' ', h('b', M.lib.item.find((x) => x.id === cur.itemId)?.name || cur.itemId)) : null,
          s.custom || !s.catalog ? null : [q, list],
          h('label.lbl', h('span.lbl-t', s.catalog ? 'Or something of your own' : 'What is it?'), field(cur.name || '', { placeholder: s.catalog ? 'A broken phone with 3 % battery' : 'A rubber chicken', onCommit: (v) => { draft.stuff[s.id] = v.trim() ? { name: v.trim() } : {}; save(); paint(); } })));
      };
      return h('div.bld-step', head('What you had on you', 'stuff', 'Your GM approves it before it lands in your inventory.'), cr.stuff.map(slot));
    },
    story() {
      const ids = (rs.storyFields || []).filter((x) => x !== 'notes' && x !== 'popularity');
      const fieldDef = (id) => rs.fields.find((f) => f.id === id);
      return h('div.bld-step', head('A bit of story', 'story', 'Optional. Each box saves the moment you leave it.'),
        ids.map((id) => {
          const mark = h('span.cr-saved', { hidden: true }, icon('check', { size: 12 }), 'Saved');
          return h('label.lbl', h('span.lbl-t', fieldDef(id)?.label || id, ' ', mark),
            field(M.sheet.story?.[id] ?? '', { multiline: true, rows: 3, placeholder: fieldDef(id)?.note || '', onCommit: async (v) => { if (await act({ t: 'sheet.set', path: `story.${id}`, value: v })) { mark.hidden = false; setTimeout(() => { mark.hidden = true; }, 2500); } } }));
        }));
    },
    review() {
      const rows = [
        ['Name', draft.name || '—'],
        ...cr.backgrounds.map((g) => [g.label, draft.bg[g.id] ? `${draft.bg[g.id].option}: ${(draft.bg[g.id].skills || []).map(skillName).join(', ') || '(no skills picked)'} — Rank ${g.rank}` : '—']),
        ...(cr.combat ? [['Combat', [cr.combat.fixed?.name, draft.weapon && !draft.weapon.none ? (draft.weapon.name || cr.combat.weapons[draft.weapon.index]?.name) : null].filter(Boolean).join(' + ') + ` — Rank ${cr.combat.rank}`]] : []),
        ['Stats', rs.stats.map((s) => `${s.abbr} ${draft.stats[s.id] ?? '–'}`).join(' · ')],
        ...cr.stuff.filter((s) => !s.auto).map((s) => [s.label, draft.stuff[s.id]?.itemId ? M.lib.item.find((x) => x.id === draft.stuff[s.id].itemId)?.name : draft.stuff[s.id]?.name || '—']),
      ];
      const missing = problems();
      return h('div.bld-step',
        head('Ready?', null, missing.length ? null : 'Check it, then send it to the System. Skills, attacks and stats go on your sheet; your stuff waits for the GM.'),
        missing.length ? h('ul.cr-missing', missing.map((x) => h('li', h('button.linklike', { type: 'button', onclick: () => go(x.step) }, x.text)))) : null,
        h('dl.kv.kv-wide', rows.map(([k, v]) => h('div', h('dt', k), h('dd', String(v))))),
        cr.basicActions.length ? h('details.cr-actions', { open: true }, h('summary', 'What anyone can do (also on your sheet)'), h('ul', cr.basicActions.map((x) => h('li', h('b', x.name), ' ', h('span', x.text))))) : null);
    },
  };

  function problems() {
    const out = [];
    if (!draft.name) out.push({ step: 0, text: 'Give your crawler a name.' });
    steps.forEach((s, i) => {
      if (s.g && (draft.bg[s.g.id]?.skills || []).length !== s.g.pick) out.push({ step: i, text: `${s.g.label}: pick a description and ${s.g.pick} skills.` });
      if (s.id === 'weapon' && !draft.weapon) out.push({ step: i, text: 'Pick a weapon.' });
      if (s.id === 'stats' && rs.stats.some((x) => draft.stats[x.id] === undefined)) out.push({ step: i, text: 'Set every stat.' });
    });
    return out;
  }

  async function send() {
    const bad = problems();
    if (bad.length) { go(bad[0].step); toast(bad[0].text, { error: true }); return; }
    next.disabled = true;
    const ops = [{ t: 'sheet.set', path: 'identity.name', value: draft.name }];
    if (draft.pronouns) ops.push(rs.identity.includes('pronouns') ? { t: 'sheet.set', path: 'identity.pronouns', value: draft.pronouns } : { t: 'sheet.set', path: 'fields.pronouns', value: draft.pronouns });
    const stuff = Object.fromEntries(Object.entries(draft.stuff).filter(([, v]) => v && (v.itemId || v.name)));
    ops.push({ t: 'creation.apply', background: draft.bg, ...(cr.combat ? { weapon: draft.weapon } : {}), stats: draft.stats, method: draft.method, stuff });
    for (const op of ops) {
      if (!(await act(op))) { next.disabled = false; return; }
    }
    drop(player.id);
    toast(Object.keys(stuff).length ? 'Welcome to the dungeon. Your stuff went to the GM for approval.' : 'Welcome to the dungeon.', { ms: 4000 });
    close();
  }

  function onNext() { if (step === steps.length - 1) send(); else go(step + 1); }
  function paint() {
    const s = steps[step];
    bar.replaceChildren(h('div.cr-dots', steps.map((x, i) => h('button', { type: 'button', class: i === step ? 'on' : i < step ? 'done' : '', 'aria-label': x.label, title: x.label, onclick: () => go(i) }))), h('span.dim', `${step + 1}/${steps.length} · ${s.label}`));
    back.disabled = step === 0;
    next.textContent = step === steps.length - 1 ? 'Enter the dungeon' : `Next: ${steps[step + 1].label}`;
    const scroll = body.scrollTop;
    const focusSel = document.activeElement && body.contains(document.activeElement);
    body.replaceChildren(s.g ? render.stage(s.g) : render[s.id]());
    body.scrollTop = scroll;
    if (!focusSel) return;
  }
  function go(i) {
    step = Math.max(0, Math.min(steps.length - 1, i));
    draft.step = step;
    save();
    paint();
    body.scrollTop = 0;
  }
  paint();
  return { close };
}
