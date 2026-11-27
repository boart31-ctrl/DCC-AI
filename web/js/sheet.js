// Character sheet (RULESET.md §5), shared by the player phone and the GM desk.
// Every computed number explains itself (hover / long-press) and rolls when tapped.
// The engine is authoritative: this component only renders `sheet` + `computed` and sends actions.
import { h, toast, ask, buzz, timeAgo, rarityOf, itemArt } from './client.js';
import {
  sheetModel, itemOf, libGet, evaluate, activeEffects, effectText, playerEditLevel, rollFormula, diceText, validateFormula,
} from './rules.js';
import {
  icon, signed, minus, explain, hideWhy, whyContent, unverifiedBadge, hasUnverified, openDrawer, closeDrawer, stepper,
  tabBar, field, select, labeled, lockHint, avatar,
} from './ui.js';
import { showRollCard } from './dicelog.js';
import { infoBtn } from './glossary.js';
import { pickPortrait } from './portrait.js';

/* Rolls made locally (engines without the `roll` action). Pages merge these into the dice log. */
export const localRolls = [];
const localListeners = new Set();
export const onLocalRoll = (fn) => { localListeners.add(fn); return () => localListeners.delete(fn); };

const humanize = (id) => String(id || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * @param {object} o
 * @param {'player'|'gm'} o.mode
 * @param {(action:object)=>Promise<object>} o.send   transport send (ack promise)
 * @param {()=>Array} [o.extraTabs]  Additional player destinations or GM sheet tabs
 * @param {(model)=>void} [o.onBuilder]  opens the character builder
 */
export function createSheet({ mode = 'player', send, extraTabs = () => [], onBuilder, gmTools, phone = () => false, onPlayerPage, moreItems = () => [], top = null, onRoll = null, rollsOn = () => true } = {}) {
  const gm = mode === 'gm';
  const root = h('article.sheet', { class: `sheet sheet-${mode}` });
  const ui = { tab: null, page: 'sheet', editing: false, openSkill: null, invQuery: '', drawer: null, ptab: 'skills', skillQuery: '', openBoxes: {} };
  const playerNav = h('nav.ph-primary', { 'aria-label': 'Player navigation', hidden: true });
  const primary = [['sheet', 'Sheet', 'book'], ['combat', 'Combat', 'swords'], ['msg', 'Messages', 'chat'], ['maps', 'Map', 'map'], ['more', 'More', 'more']];
  const dock = new Map(primary.map(([id, label, glyph]) => {
    const badge = h('span.ph-dock-badge', { 'aria-hidden': 'true', hidden: true });
    const button = h('button.ph-dock-btn', { type: 'button', 'data-page': id, onclick: () => setTab(id) }, icon(glyph, { size: 21 }), h('span', label), badge);
    playerNav.append(button);
    return [id, { button, badge }];
  }));
  let view = null;
  let player = null;
  let M = null; // model
  let sig = '';
  let pending = false;

  /* ---------- permissions ---------- */

  function can(what) {
    if (gm) return true;
    const lvl = playerEditLevel(view);
    if (what === 'roll') return rollsOn(); // dice mode off: numbers explain themselves, dice stay at the table
    if (what === 'play') return true; // casting, using items
    if (what === 'story' || what === 'notes' || what === 'used') return lvl !== 'none';
    if (what === 'sheet' || what === 'tracks') return lvl === 'sheet';
    return false; // gm-only
  }
  const lockText = () => (playerEditLevel(view) === 'none' ? 'The GM locked your sheet' : 'The GM allows notes only');

  /* ---------- actions ---------- */

  async function act(action, okMsg) {
    const a = gm ? { playerId: player.id, ...action } : { ...action };
    buzz(8);
    try {
      const r = M?.legacy ? await legacySend(a) : await send(a);
      if (okMsg) toast(okMsg);
      const roll = r?.result?.roll;
      if (roll) showRollCard(roll, { nameOf, meId: gm ? null : player?.id });
      return r || true;
    } catch (err) {
      toast(err.message || 'Refused', { error: true, ms: 3500 });
      return null;
    }
  }

  /** Engines without rulesets understand only the v1 actions; map what we can, roll locally. */
  async function legacySend(a) {
    const pid = a.playerId;
    if (a.t === 'roll') {
      const f = rollFor(a.what);
      const r = rollFormula(f.formula, {});
      const roll = { id: `lr_${Date.now().toString(36)}`, at: Date.now(), playerId: player.id, label: f.label, formula: f.formula, dice: r?.dice || [], total: r?.total ?? 0, breakdown: f.breakdown, secret: !!a.secret, local: true };
      localRolls.push(roll);
      if (localRolls.length > 100) localRolls.shift();
      for (const fn of localListeners) fn(roll);
      return { result: { roll } };
    }
    if (a.t === 'sheet.set') {
      const [root, key, part] = a.path.split('.');
      if (root === 'stats' && gm) return send({ t: 'player.stat', playerId: pid, stat: key, value: Number(a.value) || 0, ...(part ? {} : {}) });
      if (root === 'identity' && gm) {
        const map = { name: 'name', class: 'klass', race: 'race', level: 'level', title: 'title' };
        if (map[key]) return send({ t: 'player.update', playerId: pid, [map[key]]: key === 'level' ? Number(a.value) || 0 : a.value });
      }
      if (root === 'story' && key === 'notes') return gm ? send({ t: 'player.update', playerId: pid, notes: a.value }) : send({ t: 'me.notes', text: a.value });
    }
    if (a.t === 'track.set' && gm) return send({ t: 'player.resource', playerId: pid, res: a.track, ...(a.cur != null ? { cur: a.cur } : {}), ...(a.max != null ? { max: a.max } : {}), ...(a.delta != null ? { delta: a.delta } : {}) });
    throw new Error('This needs the rules engine (ruleset.json). Update the host.');
  }

  /** Formula + label of a roll, for local rolls and labels. */
  function rollFor(what) {
    const c = M.computed;
    if (what.kind === 'stat') { const s = M.rs.stats.find((x) => x.id === what.id); const b = c.stats?.[what.id]?.mod; return { formula: `${M.rs.dice} + ${b?.value ?? 0}`.replace('+ -', '- '), label: `${s?.label || what.id} check`, breakdown: b }; }
    if (what.kind === 'derived') { const d = M.rs.derived.find((x) => x.id === what.id); const b = c.derived?.[what.id]; return { formula: `${d?.roll || M.rs.dice} + ${b?.value ?? 0}`, label: d?.label || what.id, breakdown: b }; }
    if (what.kind === 'skill') { const s = M.sheet.skills.find((x) => x.uid === what.uid); const b = c.skills?.find((x) => x.uid === what.uid)?.total; return { formula: `${M.rs.dice} + ${b?.value ?? 0}`, label: `${s?.name || 'Skill'} check`, breakdown: b }; }
    if (what.kind === 'attack') { const a = M.sheet.attacks.find((x) => x.uid === what.uid); const b = c.attacks?.find((x) => x.uid === what.uid)?.toHit; return { formula: `${M.rs.dice} + ${b?.value ?? 0}`, label: `${a?.name || 'Attack'} to hit`, breakdown: b }; }
    return { formula: what.formula || M.rs.dice, label: what.label || 'Roll', breakdown: null };
  }

  const roll = (what, label) => {
    if (!can('roll')) return;
    const w = what.kind === 'custom' ? { ...what, label: what.label || label } : what;
    // Player phone: the roll pad (targets, typed real dice, hit / miss). Custom formulas roll straight away.
    if (!gm && onRoll && w.kind !== 'custom') return onRoll(w, label);
    act({ t: 'roll', what: w });
  };

  const nameOf = (id) => view?.players?.find((p) => p.id === id)?.name || 'Someone';

  /* ---------- numbers ---------- */

  /** A rollable/explained number. */
  function num(b, { title, prefix, roll: rollWhat, cls = '', text, warnKey, note, big = false, noBadge = false } = {}) {
    const display = text ?? (prefix ? `${prefix}${signed(b?.value)}` : String(b?.value ?? 0));
    const el = h(rollWhat && can('roll') ? 'button.num' : 'span.num', {
      type: rollWhat ? 'button' : null,
      class: `num${big ? ' num-big' : ''}${rollWhat ? ' rollable' : ''} ${cls}`,
      tabindex: rollWhat ? null : '0',
      'aria-label': `${title}: ${display}${rollWhat ? '. Tap to roll' : ''}`,
    }, minus(display));
    explain(el, () => whyContent(b, { title, prefix: prefix ? prefix.trim() : '', note: note || (rollWhat ? 'Tap to roll. Hold or hover to explain.' : null) }), rollWhat ? { onTap: () => roll(rollWhat, title) } : {});
    // Players never see the rule author's "not checked" markers: that's GM business.
    const uv = gm && !noBadge && hasUnverified(b, M.computed?.warnings, warnKey);
    if (!uv) return el;
    return h('span.num-wrap', el, unverifiedBadge(typeof uv === 'string' ? uv : undefined));
  }

  /** All unverified notes whose path matches, joined for one section badge. */
  function sectionUnverified(re) {
    const all = [...(M.computed?.warnings || []), ...(view.pack?.ruleset?.unverified || [])].filter((w) => w.kind === 'unverified' && re.test(w.path || w.target || ''));
    if (!all.length && re.test('statMod') && M.rs.statMod?.verify) return `Modifier formula ${M.rs.statMod.formula}`;
    const seen = new Set();
    return all.filter((w) => !seen.has(w.path) && seen.add(w.path)).map((w) => w.note || w.msg || w.path).join(' ');
  }

  /** Numeric resolver over computed values (spell costs, item attack previews). */
  function resolver() {
    const c = M.computed || {};
    return (id) => {
      let m;
      if (id === 'level') return Number(M.sheet.identity?.level ?? player?.level ?? 1);
      if ((m = /^mod\.(\w+)$/.exec(id))) return c.stats?.[m[1]]?.mod?.value;
      if ((m = /^stat\.(\w+)/.exec(id))) return c.stats?.[m[1]]?.value;
      if ((m = /^field\.(\w+)$/.exec(id))) return Number(M.sheet.fields?.[m[1]] ?? 0);
      if ((m = /^track\.(\w+)\.(cur|max)$/.exec(id))) return c.tracks?.[m[1]]?.[m[2]];
      if ((m = /^skill\.(\w+)\.rank$/.exec(id))) return Number(M.sheet.skills.find((s) => s.skillId === m[1])?.rank ?? 0);
      if (c.derived?.[id]) return c.derived[id].value;
      return undefined;
    };
  }

  /* ---------- header ---------- */

  function header() {
    const id = M.sheet.identity || {};
    const name = id.name || player.name || 'Unnamed crawler';
    const lvl = id.level ?? player.level ?? 1;
    const line = [id.race, id.class].filter(Boolean).join(' ') || (gm ? 'No race or class yet' : 'Pick a race and class');
    const meta = [];
    const add = (k, v) => { if (v != null && v !== '') meta.push(h('div.idm', h('dt', k), h('dd', String(v)))); };
    add('Floor', id.floor);
    add('Crawler', (id.crawlerNumber ?? M.sheet.fields?.crawlerNumber) ? `#${id.crawlerNumber ?? M.sheet.fields.crawlerNumber}` : '');
    add('Pronouns', id.pronouns);
    add('Background', id.background);
    if (player.gold != null && M.legacy) add('Gold', player.gold);
    const editBtn = (gm || can('story'))
      ? h('button.btn.btn-sm', { type: 'button', class: ui.editing ? 'btn btn-sm btn-primary' : 'btn btn-sm', 'aria-pressed': String(ui.editing), onclick: () => { ui.editing = !ui.editing; draw(true); } }, icon(ui.editing ? 'x' : 'edit', { size: 14 }), ui.editing ? 'Done' : 'Edit')
      : lockHint(lockText());
    return h('header.sh-head',
      portraitButton(name, 56),
      h('div.sh-id',
        h('h1.sh-name', name),
        h('p.sh-line', h('span', line), h('span.lv', `Level ${lvl}`)),
        meta.length ? h('dl.sh-meta', meta) : null,
      ),
      h('div.sh-head-act',
        editBtn,
        (gm || can('sheet')) && onBuilder ? h('button.btn.btn-sm', { type: 'button', title: 'Step-by-step character builder', onclick: () => onBuilder(M, player) }, 'Builder') : null,
      ),
    );
  }

  /* ---------- identity editor (edit mode) ---------- */

  function identityEditor() {
    const id = M.sheet.identity || {};
    const ok = can('sheet');
    const set = (k) => (v) => act({ t: 'sheet.set', path: `identity.${k}`, value: v });
    const opt = (list, cur) => [{ value: '', label: '—' }, ...list.map((x) => ({ value: x.name, label: x.name })), ...(cur && !list.some((x) => x.name === cur) ? [{ value: cur, label: cur }] : [])];
    // Race / class / background: the GM's call. Players may only request them (allowOrigins) until approved.
    const oOk = gm || (ok && !!view.session?.permissions?.allowOrigins && !M.sheet.originsLocked);
    const pend = M.sheet.pending || {};
    const oHint = (k) => (pend[k] ? { hint: `Asked for ${pend[k]}. Waiting for the GM.` } : !gm && !oOk ? { hint: M.sheet.originsLocked ? 'Approved and locked by the GM' : 'Set by the GM' } : {});
    const oSet = (k) => async (v) => { const r = await act({ t: 'sheet.set', path: `identity.${k}`, value: v }); if (r && !gm && r.result?.pending) toast('Sent to the GM for approval.'); };
    const gmo = (k) => !gm && (M.rs.gmOnly || []).includes(k); // set by the GM: shown, not editable
    const worldFloor = M.worldFloor;
    const fields = [
      labeled('Name', field(id.name ?? player.name, { onCommit: set('name'), disabled: !ok })),
      labeled(M.rs.labels?.race || 'Race', M.rs.races.length ? select(opt(M.rs.races, id.race), id.race || '', { onChange: oSet('race'), disabled: !oOk }) : field(id.race, { onCommit: oSet('race'), disabled: !oOk }), oHint('race')),
      labeled('Class', M.rs.classes.length ? select(opt(M.rs.classes, id.class), id.class || '', { onChange: oSet('class'), disabled: !oOk }) : field(id.class, { onCommit: oSet('class'), disabled: !oOk }), oHint('class')),
      labeled('Level', field(id.level ?? player.level ?? 1, { type: 'number', onCommit: set('level'), disabled: !ok || gmo('level'), attrs: { min: 0, max: 99, inputmode: 'numeric' } }), { cls: 'lbl-num', ...(gmo('level') ? { hint: 'Set by the GM' } : {}) }),
      labeled('Floor', field(gmo('floor') && worldFloor ? worldFloor : id.floor ?? '', { type: 'number', onCommit: set('floor'), disabled: !ok || gmo('floor'), attrs: { min: 0, inputmode: 'numeric' } }), { cls: 'lbl-num', ...(gmo('floor') ? { hint: 'The floor the world is on' } : {}) }),
      labeled('Crawler #', field(id.crawlerNumber ?? '', { onCommit: set('crawlerNumber'), disabled: !ok || gmo('crawlerNumber') }), gmo('crawlerNumber') ? { hint: 'Given by the System (GM)' } : {}),
      labeled('Pronouns', field(id.pronouns ?? '', { onCommit: set('pronouns'), disabled: !ok })),
    ];
    if (M.rs.backgrounds.length) fields.push(labeled('Background', select(opt(M.rs.backgrounds, id.background), id.background || '', { onChange: oSet('background'), disabled: !oOk }), oHint('background')));
    return h('section.sh-block.sh-identity', h('h2.blk-t', 'Identity', !ok ? lockHint(lockText()) : null), h('div.form-grid', fields));
  }

  /* ---------- tracks ---------- */

  function tracks() {
    const out = [];
    for (const t of M.rs.tracks) {
      const c = M.computed.tracks?.[t.id] || M.sheet.tracks?.[t.id] || { cur: 0, max: 0 };
      const ok = can('tracks');
      if (t.kind === 'slots') {
        const n = t.slots || c.max || 10;
        const cur = Math.max(0, Math.min(n, Number(c.cur) || 0));
        const cells = [];
        for (let i = 0; i < n; i++) {
          const filled = i < cur;
          const lbl = t.labels?.[i] || `${i + 1}`;
          cells.push(h('button.slot', {
            type: 'button', class: `slot${filled ? ' on' : ''}${cur <= Math.ceil(n * 0.3) && filled ? ' low' : ''}`,
            disabled: !ok, 'aria-label': `${t.label} ${lbl}${filled ? ', filled' : ''}`, title: lbl,
            onclick: () => act({ t: 'track.set', track: t.id, cur: i + 1 === cur ? i : i + 1 }),
          }, c.slotValue > 0 ? String(c.slotValue) : ''));
        }
        out.push(h('div.track.track-slots', { 'data-track': t.id },
          h('div.track-top', h('span.track-l', t.label), h('span.track-v', h('b', String(cur)), ` / ${n}`), !ok ? lockHint(lockText()) : null),
          h('div.slots', { role: 'group', 'aria-label': `${t.label}, ${cur} of ${n}`, style: { '--n': n } }, cells),
        ));
      } else {
        const cur = Number(c.cur) || 0;
        const max = Number(c.max) || 0;
        const pct = max > 0 ? Math.min(100, (cur / max) * 100) : 0;
        out.push(h('div.track.track-pool', { 'data-track': t.id },
          h('div.track-top', h('span.track-l', t.label), h('span.track-v', h('b', String(cur)), ` / ${max}`)),
          h('div.pool',
            h('button.icon-btn', { type: 'button', disabled: !ok || cur <= 0, 'aria-label': `${t.label} minus 1`, onclick: () => act({ t: 'track.set', track: t.id, delta: -1 }) }, icon('minus', { size: 15 })),
            h('div.pool-bar', { role: 'meter', 'aria-valuenow': cur, 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-label': t.label }, h('div.pool-fill', { style: { width: `${pct}%` } })),
            h('button.icon-btn', { type: 'button', disabled: !ok || cur >= max, 'aria-label': `${t.label} plus 1`, onclick: () => act({ t: 'track.set', track: t.id, delta: 1 }) }, icon('plus', { size: 15 })),
          ),
          gm && ui.editing ? h('div.track-max', 'Max', stepper(max, { min: 0, label: `${t.label} max`, onChange: (v) => act({ t: 'track.set', track: t.id, max: v }) })) : null,
        ));
      }
    }
    return out.length ? h('section.sh-block.sh-tracks', out) : null;
  }

  /* ---------- stats ---------- */

  function stats() {
    const defs = M.rs.stats;
    if (!defs.length) return null;
    const parts = defs[0].parts || [];
    const ok = can('sheet');
    const uv = gm ? sectionUnverified(/^(statMod|stats\b)/) : '';
    return h('section.sh-block.sh-stats', { 'aria-label': 'Stats' },
      uv ? h('p.blk-note', unverifiedBadge(uv), h('span', 'Stat rules not verified')) : null,
      h('div.stats', { style: { '--n': defs.length } }, defs.map((s) => {
        const c = M.computed.stats?.[s.id] || { value: 0, mod: { value: 0, parts: [] } };
        const raw = M.sheet.stats?.[s.id] || {};
        const hasMod = !!M.rs.statMod;
        const main = hasMod
          ? num(c.mod, { title: `${s.label} modifier`, prefix: ' ', text: signed(c.mod.value), roll: { kind: 'stat', id: s.id }, big: true, noBadge: true })
          : num({ value: c.value, parts: c.parts }, { title: s.label, roll: { kind: 'stat', id: s.id }, big: true });
        let sub = null;
        if (ui.editing) {
          const ps = parts.length ? parts : ['value'];
          sub = h('div.stat-edit', ps.map((p) => h('label', h('span', p === 'value' ? 'Value' : p === 'enhanced' ? 'Enh' : p === 'unenhanced' ? 'Base' : humanize(p)),
            field(raw[p] ?? raw.value ?? c.value, { type: 'number', disabled: !ok, attrs: { inputmode: 'numeric', 'aria-label': `${s.label} ${p}` }, onCommit: (v) => act({ t: 'sheet.set', path: `stats.${s.id}.${M.legacy ? 'value' : p}`, value: v }) }))));
        } else if (hasMod) {
          const enh = parts.includes('enhanced') ? (raw.enhanced ?? c.value) : c.value;
          const un = parts.includes('unenhanced') ? raw.unenhanced : null;
          sub = h('div.stat-sub',
            num({ value: c.value, parts: c.parts }, { title: `${s.label}${parts.includes('enhanced') ? ' (enhanced)' : ''}`, text: String(enh), cls: 'num-sm' }),
            un != null ? h('span.stat-base', { title: 'Unenhanced' }, String(un)) : null,
          );
        }
        return h('div.stat', { 'data-stat': s.id },
          h('span.stat-abbr', { title: s.label }, s.abbr, gm ? null : infoBtn(view, s.id, s.label)),
          main,
          sub,
        );
      })),
      ui.editing && !ok ? lockHint(lockText()) : null,
      !ui.editing && M.rs.statMod && parts.includes('unenhanced') ? h('p.stat-legend', h('b', '+2'), ' = modifier you add to rolls · ', h('b', '3'), ' / ', h('span.stat-base', '3'), ' = score / base score (without items and buffs)') : null,
    );
  }

  /* ---------- defense ---------- */

  function defense() {
    const cells = [];
    for (const d of M.rs.derived) {
      const b = M.computed.derived?.[d.id] || { value: 0, parts: [] };
      const rollable = !!d.roll;
      const display = d.display ? d.display.replace('{value}', String(b.value)) : null;
      cells.push(h('div.def', { class: `def${rollable ? ' def-roll' : ''}`, 'data-derived': d.id },
        h('span.def-l', { title: d.label }, h('span.long', d.label), h('span.short', d.abbr || d.label)),
        rollable
          ? num(b, { title: d.label, text: minus(display || `${d.roll} + ${b.value}`).replace(/\+ −/, '− '), roll: { kind: 'derived', id: d.id }, warnKey: d.id })
          : num(b, { title: d.label, text: display ?? undefined, warnKey: d.id, note: d.note }),
      ));
    }
    const ok = can('sheet');
    const luck = phone() ? luckField() : null; // phones show it in the sticky bar
    for (const f of M.rs.fields.filter((x) => x.group === 'defense' && x !== luck)) {
      const v = M.sheet.fields?.[f.id] ?? f.default ?? '';
      if (M.rs.derived.some((d) => d.formula.includes(`field.${f.id}`)) && !ui.editing) continue; // already inside a derived number
      cells.push(h('div.def', { 'data-field': f.id },
        h('span.def-l', f.label),
        ui.editing
          ? field(v, { type: f.type === 'number' ? 'number' : 'text', disabled: !ok || (!gm && (M.rs.gmOnly || []).includes(f.id)), attrs: { 'aria-label': f.label, inputmode: f.type === 'number' ? 'numeric' : null }, onCommit: (x) => act({ t: 'sheet.set', path: `fields.${f.id}`, value: x }) })
          : h('span.num.num-plain', String(v)),
      ));
    }
    if (!cells.length) return null;
    return h('section.sh-block.sh-defense', { 'aria-label': 'Defense' }, h('div.defs', cells));
  }

  /* ---------- buffs ---------- */

  function buffNet(b) {
    const fx = (M.computed.effects || []).filter((e) => e.source?.uid === b.uid);
    if (fx.length) return fx.some((e) => e.debuff) ? -1 : 1;
    const def = libGet(M.lib, 'buff', b.buffId) || {};
    if ((def.tags || b.tags || []).includes('debuff')) return -1;
    const effs = b.effects?.length ? b.effects : (def.effects || []);
    return effs.reduce((s, e) => s + (typeof e.value === 'number' ? e.value : 0), 0);
  }
  function buffs() {
    const list = M.sheet.buffs || [];
    const extCap = M.rs.buffSlots?.external;
    const extUsed = M.computed.externalBuffs?.used ?? list.filter((b) => b.external).length;
    const extMax = M.computed.externalBuffs ? M.computed.externalBuffs.max : extCap?.max;
    const pos = list.filter((b) => buffNet(b) >= 0);
    const neg = list.filter((b) => buffNet(b) < 0);
    const chip = (b) => {
      const def = libGet(M.lib, 'buff', b.buffId) || {};
      const effs = b.effects?.length ? b.effects : (def.effects || []);
      const el = h('span.buff', { class: `buff${buffNet(b) < 0 ? ' debuff' : ''}${b.external ? ' ext' : ''}`, tabindex: '0' },
        h('span.buff-n', b.name || def.name || 'Buff'),
        (b.stacks ?? 1) > 1 ? h('span.buff-tag', `×${b.stacks}`) : null,
        b.external ? h('span.buff-tag', 'Ext') : null,
        gm ? h('button.buff-x', { type: 'button', 'aria-label': (b.stacks ?? 1) > 1 ? `Remove one level of ${b.name}` : `Remove ${b.name}`, onclick: (e) => { e.stopPropagation(); act({ t: 'buff.remove', uid: b.uid, ...((b.stacks ?? 1) > 1 ? { one: true } : {}) }, `Removed ${b.name}.`); } }, icon('x', { size: 12 })) : null,
      );
      explain(el, () => h('div.why',
        h('div.why-head', h('span.why-title', b.name || def.name), h('span.why-total', b.external ? 'External' : (buffNet(b) < 0 ? 'Debuff' : 'Buff'))),
        def.desc ? h('p.why-note', def.desc) : null,
        h('ul.eff-list', effs.map((e) => h('li', effectText(M.rs, e)))),
        b.until || def.duration ? h('p.why-note', `Lasts: ${b.until || def.duration}`) : null,
      ));
      return el;
    };
    const rows = [];
    rows.push(h('div.buff-row', h('span.buff-l', 'Buffs'), pos.length ? pos.map(chip) : h('span.none', 'None')));
    rows.push(h('div.buff-row', h('span.buff-l', 'Debuffs'), neg.length ? neg.map(chip) : h('span.none', 'None')));
    if (extCap) rows.push(h('div.buff-row.buff-cap', h('span.buff-l', extCap.label || 'External'), h('span.cap', { class: extMax != null && extUsed >= extMax ? 'cap full' : 'cap' }, extMax == null ? `${extUsed}, no cap` : `${extUsed} / ${extMax}`)));
    return h('section.sh-block.sh-buffs', { 'aria-label': 'Buffs and debuffs' },
      rows,
      gm ? h('div.blk-act', h('button.btn.btn-quiet.btn-sm', { type: 'button', onclick: () => gmTools?.addBuff?.(player, M) }, icon('plus', { size: 14 }), 'Apply buff')) : null,
    );
  }

  /* ---------- skills ---------- */

  function skillsPanel() {
    const all = M.sheet.skills || [];
    const sq = (ui.skillQuery || '').trim().toLowerCase();
    const list = sq ? all.filter((s) => `${s.name} ${s.checkType || ''}`.toLowerCase().includes(sq)) : all;
    const okRank = can('sheet');
    const rs = M.rs;
    const rows = list.map((s) => {
      const c = M.computed.skills?.find((x) => x.uid === s.uid)?.total || { value: s.rank || 0, parts: [] };
      const open = ui.openSkill === s.uid;
      const def = libGet(M.lib, 'skill', s.skillId) || rs.skills.catalog.find((x) => x.id === s.skillId) || {};
      const statAbbr = rs.stats.find((x) => x.id === s.stat)?.abbr || s.stat || '—';
      const locked = (player?.lockedSkills || []).includes(s.skillId ?? s.uid);
      const row = h('li.skill', { class: `skill${open ? ' open' : ''}${s.used ? ' used' : ''}${locked ? ' locked' : ''}` },
        rs.skills.usedTracking ? h('label.used', { title: 'Marked for the next eligible rank-up' },
          h('input', { type: 'checkbox', checked: !!s.used, disabled: !can('used'), 'aria-label': `${s.name} used this session`, onchange: (e) => act({ t: 'skill.update', uid: s.uid, used: e.target.checked }) })) : null,
        h('button.skill-n', { type: 'button', 'aria-expanded': String(open), title: def.desc || '', onclick: () => { ui.openSkill = open ? null : s.uid; draw(true); } },
          h('span.sn', s.name, locked ? h('span.sk-lock', { title: 'Major or Critical Fail in this scene: no retry until the scene changes' }, ' 🔒 not this scene') : null), h('span.sk-meta', [s.checkType, !open ? def.desc : ''].filter(Boolean).join(' · '))),
        h('span.sk-stat', statAbbr),
        h('span.sk-rank', { title: 'Rank' }, String(s.rank ?? 0)),
        num(c, { title: `${s.name} total`, prefix: ' ', text: signed(c.value), roll: { kind: 'skill', uid: s.uid } }),
      );
      if (!open) return row;
      const upgrades = (def.upgrades || []).slice().sort((a, b) => a.rank - b.rank);
      row.append(h('div.skill-more',
        def.desc ? h('p.sk-desc', def.desc) : null,
        upgrades.length ? h('ul.upgrades', upgrades.map((u) => h('li', { class: (s.rank ?? 0) >= u.rank ? 'got' : null }, h('b', `Rank ${u.rank}`), u.text))) : null,
        h('div.form-grid.form-tight',
          labeled('Rank', stepper(s.rank ?? 0, { min: rs.skills.rankMin ?? 0, max: rs.skills.rankMax, label: `${s.name} rank`, disabled: !okRank, onChange: (v) => act({ t: 'skill.update', uid: s.uid, rank: v }) })),
          labeled('Stat', select(rs.stats.map((x) => ({ value: x.id, label: x.abbr })), s.stat, { disabled: !okRank, label: 'Stat', onChange: (v) => act({ t: 'skill.update', uid: s.uid, stat: v }) })),
          labeled('Check', select(rs.skills.checkTypes.map((x) => ({ value: x, label: x })), s.checkType, { disabled: !okRank, label: 'Check type', onChange: (v) => act({ t: 'skill.update', uid: s.uid, checkType: v }) })),
        ),
        labeled('Notes', field(s.notes, { multiline: true, rows: 2, disabled: !can('notes'), placeholder: 'How you use it, upgrades you picked…', onCommit: (v) => act({ t: 'skill.update', uid: s.uid, notes: v }) })),
        okRank ? h('div.row-end', h('button.btn.btn-quiet.btn-sm.danger', { type: 'button', onclick: () => act({ t: 'skill.remove', uid: s.uid }, `Removed ${s.name}.`) }, icon('trash', { size: 14 }), 'Remove skill')) : null,
      ));
      return row;
    });
    const head = h('div.list-head.skill-head', rs.skills.usedTracking ? h('span', { title: 'Used this session' }, 'Used') : null, h('span', 'Skill'), h('span', 'Stat'), h('span', 'Rank'), h('span', 'Total'));
    const rankRule = rs.skills.rankUp;
    const uv = gm ? sectionUnverified(/^skills/) : '';
    const rankHelp = rankRule?.note && !rankRule.verify ? h('button.btn.btn-quiet.btn-sm.rank-up-help', {
      type: 'button',
      onclick: () => openDrawer({ title: 'Rank-up rules', body: h('p', rankRule.note) }),
    }, icon('info', { size: 16 }), 'Rank-up rules') : null;
    return h('section.sh-block.sh-skills', { 'aria-label': 'Skills' },
      h('div.sh-skills-head', h('h2.blk-t', 'Skills', h('span.blk-n', String(all.length)), uv ? unverifiedBadge(uv) : null), rankHelp),
      all.length > 6 || sq ? h('input.inp.inp-search.sk-search', { type: 'search', placeholder: `Search ${all.length} skills`, value: ui.skillQuery || '', 'aria-label': 'Search skills', oninput: (e) => { ui.skillQuery = e.target.value; const sel = e.target.selectionStart; draw(true); const n = root.querySelector('.sk-search'); n?.focus(); n?.setSelectionRange(sel, sel); } }) : null,
      list.length ? h('div.table', head, h('ul.skill-list', rows)) : h('p.empty-s', sq ? 'No skill matches.' : can('sheet') ? 'No skills yet. Add one from the catalog.' : 'No skills yet.'),
      untriedCard(),
      can('sheet') ? addSkillForm() : null,
    );
  }

  /** DCC Tutorial Floors: skills tried untrained this session; at its end the crawler learns one (Rank 1). */
  function untriedCard() {
    const U = view.pack?.ruleset?.skills?.untrained;
    const list = M.sheet.untried || [];
    if (!U?.learn || !list.length) return null;
    const names = list.map((id) => ({ id, name: M.lib.skill.find((x) => x.id === id)?.name || id }));
    const milestone = !!view.pack?.ruleset?.advancement;
    const ok = gm || (!milestone && can('play'));
    return h('div.sk-untried',
      h('p', h('b', 'Tried untrained: '), names.map((x) => x.name).join(', ')),
      h('p.dim', milestone ? 'At the next play milestone, choose one of these skills at Rank 1 in Level up.' : 'At the end of the session, choose one of these skills at Rank 1.'),
      ok ? h('div.row-wrap', names.map((x) => h('button.btn.btn-sm', { type: 'button', onclick: async () => { if (await ask(`Learn ${x.name} at Rank 1? The rest of the list is wiped.`, { ok: 'Learn' })) act({ t: 'untrained.learn', skillId: x.id }, `${x.name} learned.`); } }, `Learn ${x.name}`)),
        gm ? h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => act({ t: 'untrained.clear' }, 'Wiped.') }, 'Wipe') : null) : null);
  }

  function addSkillForm() {
    const rs = M.rs;
    const have = new Set((M.sheet.skills || []).map((s) => s.skillId));
    const hide = new Set(gm ? [] : rs.skills.hideTags || []);
    const cat = [...(M.lib.skill.length ? M.lib.skill : rs.skills.catalog)].filter((s) => !have.has(s.id) && !(s.tags || []).some((t) => hide.has(t))).sort((a, b) => a.name.localeCompare(b.name));
    const sel = select([{ value: '', label: 'Add skill from catalog…' }, ...cat.map((s) => ({ value: s.id, label: `${s.name} (${rs.stats.find((x) => x.id === s.stat)?.abbr || s.stat})` })), { value: '__custom', label: 'Custom skill…' }], '', {
      label: 'Add skill',
      onChange: (v) => {
        if (v === '__custom') { customSkill(); sel.value = ''; return; }
        if (v) act({ t: 'skill.add', skillId: v, rank: 1 }, 'Skill added.');
      },
    });
    return h('div.add-row', sel);
  }

  function customSkill() {
    const rs = M.rs;
    const name = field('', { placeholder: 'Skill name' });
    const stat = select(rs.stats.map((s) => ({ value: s.id, label: s.label })), rs.stats[0]?.id);
    const ct = select(rs.skills.checkTypes.map((x) => ({ value: x, label: x })), rs.skills.checkTypes[0]);
    const rank = field(1, { type: 'number', attrs: { min: 0, max: rs.skills.rankMax } });
    openDrawer({
      title: 'Custom skill', sub: 'Only on this sheet. Make it a library skill to reuse it.',
      body: h('div.form-grid', labeled('Name', name), labeled('Stat', stat), labeled('Check type', ct), labeled('Starting rank', rank)),
      actions: [h('button.btn.btn-primary', { type: 'button', onclick: async () => {
        if (!name.value.trim()) { name.focus(); return; }
        if (await act({ t: 'skill.add', name: name.value.trim(), stat: stat.value, checkType: ct.value, rank: Number(rank.value) || 0 }, 'Skill added.')) closeDrawer();
      } }, 'Add skill')],
    });
    setTimeout(() => name.focus(), 50);
  }

  /* ---------- attacks ---------- */

  function attacksPanel() {
    const list = M.sheet.attacks || [];
    const ok = can('sheet');
    const rows = list.map((a) => {
      const c = M.computed.attacks?.find((x) => x.uid === a.uid) || {};
      const sk = M.sheet.skills.find((s) => s.uid === a.skillUid);
      const statAbbr = M.rs.stats.find((s) => s.id === a.stat)?.abbr || a.stat;
      const dmgText = minus(c.damage || a.dice || '—');
      return h('li.atk',
        h('div.atk-n', h('span.an', a.name), h('span.atk-meta', [sk?.name, statAbbr].filter(Boolean).join(' + '))),
        h('div.atk-hit', h('span.mini-l', 'To hit'), num(c.toHit || { value: 0, parts: [] }, { title: `${a.name} to hit`, prefix: ' ', text: signed(c.toHit?.value), roll: { kind: 'attack', uid: a.uid } })),
        h('div.atk-dmg', h('span.mini-l', 'Damage'), num(dmgBreakdown(c, a), { title: `${a.name} damage`, text: dmgText, roll: M.local ? { kind: 'custom', formula: String(c.damage || a.dice || '0').replace(/−/g, '-'), label: `${a.name} damage` } : { kind: 'attack', uid: a.uid, part: 'damage' }, note: 'Dice plus these modifiers. Tap to roll damage.' })),
        a.effects ? h('p.atk-fx', a.effects) : null,
        ok && ui.editing && !a.item ? h('div.atk-edit',
          field(a.name, { onCommit: (v) => act({ t: 'attack.update', uid: a.uid, name: v }), attrs: { 'aria-label': 'Attack name' } }),
          select([{ value: '', label: 'No skill' }, ...M.sheet.skills.map((s) => ({ value: s.uid, label: s.name }))], a.skillUid || '', { label: 'Skill', onChange: (v) => act({ t: 'attack.update', uid: a.uid, skillUid: v || null }) }),
          select(M.rs.stats.map((s) => ({ value: s.id, label: s.abbr })), a.stat, { label: 'Stat', onChange: (v) => act({ t: 'attack.update', uid: a.uid, stat: v }) }),
          diceField(a.dice, (v) => act({ t: 'attack.update', uid: a.uid, dice: v })),
          field(a.effects, { placeholder: 'Effects', onCommit: (v) => act({ t: 'attack.update', uid: a.uid, effects: v }), attrs: { 'aria-label': 'Effects' } }),
          h('button.icon-btn.danger', { type: 'button', 'aria-label': `Remove ${a.name}`, onclick: () => act({ t: 'attack.remove', uid: a.uid }, 'Attack removed.') }, icon('trash', { size: 15 })),
        ) : null,
      );
    });
    return h('section.panel-attacks',
      list.length ? h('ul.atk-list', rows) : h('p.empty-s', 'No attacks yet.'),
      ok ? h('div.add-row', h('button.btn.btn-quiet.btn-sm', { type: 'button', onclick: addAttack }, icon('plus', { size: 14 }), 'Add attack'), !ui.editing && list.length ? h('span.hint', 'Edit the sheet to change attacks.') : null) : null,
    );
  }

  function dmgBreakdown(c, a) {
    if (c.damageParts) return { value: c.damage || a.dice, parts: c.damageParts };
    return c.damageBreakdown || { value: 0, parts: [] };
  }

  function diceField(v, onCommit) {
    const el = field(v, { placeholder: '1d6', onCommit: (x) => { if (validateFormula(x).ok) onCommit(x); }, attrs: { 'aria-label': 'Damage dice', spellcheck: 'false' }, cls: 'inp-dice' });
    el.addEventListener('input', () => el.classList.toggle('bad', !!el.value && !validateFormula(el.value).ok));
    return el;
  }

  function addAttack() {
    const name = field('', { placeholder: 'Attack name' });
    const sk = select([{ value: '', label: 'No skill' }, ...M.sheet.skills.map((s) => ({ value: s.uid, label: s.name }))], M.sheet.skills[0]?.uid || '');
    const st = select(M.rs.stats.map((s) => ({ value: s.id, label: s.label })), M.rs.stats[0]?.id);
    const dice = field('1d6', { attrs: { spellcheck: 'false' } });
    const fx = field('', { placeholder: 'Effects, e.g. knockback on a nat 20' });
    openDrawer({
      title: 'New attack',
      body: h('div.form-grid', labeled('Name', name), labeled('Skill', sk), labeled('Stat', st), labeled('Damage dice', dice), labeled('Effects', fx, { cls: 'span-2' })),
      actions: [h('button.btn.btn-primary', { type: 'button', onclick: async () => {
        if (!name.value.trim()) { name.focus(); return; }
        if (!validateFormula(dice.value).ok) { dice.focus(); toast('Dice look wrong. Try 1d6 or 2d4+1.', { error: true }); return; }
        if (await act({ t: 'attack.add', name: name.value.trim(), skillUid: sk.value || null, stat: st.value, dice: dice.value.trim(), effects: fx.value.trim() }, 'Attack added.')) closeDrawer();
      } }, 'Add attack')],
    });
    setTimeout(() => name.focus(), 50);
  }

  /* ---------- spells ---------- */

  function spellCost(def, s) {
    const c = s && M.computed.spells?.find((x) => x.uid === s.uid)?.cost;
    if (c) return c;
    if (def.cost == null || def.cost === '') return { value: 0, parts: [] };
    return evaluate(def.cost, { resolve: resolver(), labelOf: (id) => id.replace(/^mod\./, '').toUpperCase() + (id.startsWith('mod.') ? ' mod' : '') });
  }

  const spellCooldown = (s) => M.computed.spells?.find((x) => x.uid === s.uid)?.cooldown;
  function timeText(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    const remainder = seconds % 60;
    return [hours ? `${hours} h` : '', minutes ? `${minutes} min` : '', remainder ? `${remainder} s` : ''].filter(Boolean).join(' ');
  }
  function spellCooldownText(cooldown) {
    if (!cooldown || cooldown.ready) return '';
    return cooldown.kind === 'scene' ? 'Used this scene' : `Ready in ${timeText(cooldown.remainingSeconds)} game time`;
  }

  function spellsPanel() {
    const list = M.sheet.spells || [];
    const trackId = M.rs.spells?.costTrack;
    const track = M.rs.tracks.find((t) => t.id === trackId);
    const have = M.computed.tracks?.[trackId]?.cur ?? 0;
    const rows = list.map((s) => {
      const def = { ...(libGet(M.lib, 'spell', s.spellId) || {}), ...s, name: s.name || libGet(M.lib, 'spell', s.spellId)?.name || s.spellId };
      const cost = spellCost(def, s);
      const short = have < cost.value;
      const cooldown = spellCooldownText(spellCooldown(s));
      const prepared = M.rs.hotlist?.combat && M.sheet.hotlist?.includes(s.uid);
      const meta = [def.attackCheck ? `Rank ${s.rank}` : null, def.range, def.duration, cooldown].filter(Boolean);
      return h('li.spell', { class: s.active ? 'spell active' : 'spell' },
        itemArt({ ...def, rarity: def.rarity || 'common' }, 'inv-ico sp-ico'),
        h('button.spell-n', { type: 'button', onclick: () => spellDrawer(s), title: def.desc || '' }, h('span.sn', def.name), h('span.sp-meta', [meta.join(', '), def.desc].filter(Boolean).join(' · ') || 'Details')),
        s.active ? h('span.pill.pill-on', 'Active') : null,
        prepared ? h('span.hot-mark', { title: 'On the Hotlist', 'aria-label': 'On the Hotlist' }, icon('star', { size: 13 })) : null,
        h('div.sp-cost', h('span.mini-l', 'Cost'), num(cost, { title: `${def.name} cost`, text: `${cost.value}${track ? ` ${track.label.toLowerCase()}` : ''}` })),
        h('button.btn.btn-sm', { type: 'button', class: short || cooldown ? 'btn btn-sm' : 'btn btn-sm btn-primary', disabled: short || !!cooldown || !can('play'), title: cooldown || (short ? `Needs ${cost.value}, you have ${have}` : `Spend ${cost.value} and cast`), onclick: () => cast(s, def, cost) }, icon('bolt', { size: 14 }), 'Cast'),
      );
    });
    return h('section.panel-spells',
      track ? h('p.panel-note', `${track.label}: `, h('b', `${have} / ${M.computed.tracks?.[trackId]?.max ?? 0}`)) : null,
      list.length ? h('ul.spell-list', rows) : h('p.empty-s', 'No spells known.'),
      (gm || can('sheet')) ? learnSpell() : null,
    );
  }

  async function cast(s, def, cost) {
    if (M.rs.spells.attackChecks && def.attackCheck) {
      roll({ kind: 'spell', uid: s.uid }, `${def.name} to hit`);
      return;
    }
    const castTarget = async (target) => {
      const r = await act({ t: 'spell.cast', uid: s.uid, ...(target ? { target } : {}) }, `Cast ${def.name}${cost.value ? ` for ${cost.value}` : ''}.`);
      if (r && !def.healing && (def.dice || def.attack?.dice)) roll({ kind: 'custom', formula: def.dice || def.attack.dice, label: def.name });
      return r;
    };
    if (def.healing?.target !== 'ally') { await castTarget(); return; }
    const allies = (view.players || []).filter((p) => p.id !== player.id);
    openDrawer({ title: def.name, sub: def.range, body: allies.length ? h('div.add-row', allies.map((p) => h('button.btn', { type: 'button', onclick: async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      if (await castTarget(p.id)) closeDrawer();
      else button.disabled = false;
    } }, p.name))) : h('p.empty-s', 'No other crawler to heal.') });
  }

  function learnSpell() {
    const known = new Set((M.sheet.spells || []).map((s) => s.spellId));
    const opts = M.lib.spell.filter((s) => !known.has(s.id));
    if (!opts.length) return null;
    return h('div.add-row', select([{ value: '', label: 'Learn a spell…' }, ...opts.map((s) => ({ value: s.id, label: s.name }))], '', { label: 'Learn spell', onChange: (v) => { if (v) act({ t: 'spell.learn', spellId: v }, 'Spell learned.'); } }));
  }

  function spellDrawer(s) {
    const def = { ...(libGet(M.lib, 'spell', s.spellId) || {}), ...s, name: s.name || libGet(M.lib, 'spell', s.spellId)?.name || s.spellId };
    const cost = spellCost(def, s);
    const readySlot = M.sheet.hotlist?.indexOf(s.uid) ?? -1;
    const openSlot = M.sheet.hotlist?.indexOf(null) ?? -1;
    const cooldown = spellCooldownText(spellCooldown(s));
    const cadence = def.cooldown === 'scene' ? 'Once per scene' : def.cooldown ? timeText(def.cooldown) : '';
    const rows = [['Cost', `${cost.value}${typeof def.cost === 'string' ? ` (${def.cost})` : ''}`], ['Range', def.range], ['Duration', def.duration], ['Cooldown', [cadence, cooldown].filter(Boolean).join(' · ')], ['Rank', s.rank], ['Dice', def.dice || def.attack?.dice], ['Scaling', def.rankScaling]].filter(([, v]) => v != null && v !== '');
    openDrawer({
      title: def.name, sub: s.active ? 'Active now' : 'Spell',
      body: [
        h('dl.kv', rows.map(([k, v]) => h('div', h('dt', k), h('dd', String(v))))),
        def.desc ? h('p.desc', def.desc) : null,
        def.flavor ? h('p.flavor-t', def.flavor) : null,
        def.effects?.length ? h('div', h('h3.sub-t', 'Effects while active'), h('ul.eff-list', def.effects.map((e) => h('li', effectText(M.rs, e))))) : null,
      ],
      actions: [
        M.rs.hotlist?.combat && can('sheet') ? h('button.btn', { type: 'button', disabled: readySlot < 0 && openSlot < 0, onclick: async () => {
          if (await act({ t: 'hotlist.set', index: readySlot >= 0 ? readySlot : openSlot, uid: readySlot >= 0 ? null : s.uid })) closeDrawer();
        } }, readySlot >= 0 ? 'Remove from Hotlist' : 'Add to Hotlist') : null,
        (gm || can('sheet')) && !M.rs.spells.starting?.includes(s.spellId) ? h('button.btn.btn-quiet.danger', { type: 'button', onclick: async () => { if (await act({ t: 'spell.forget', uid: s.uid }, `Forgot ${def.name}.`)) closeDrawer(); } }, 'Forget') : null,
        s.active ? h('button.btn', { type: 'button', onclick: async () => { if (await act({ t: 'spell.update', uid: s.uid, active: false }, `${def.name} ended.`)) closeDrawer(); } }, 'End effect') : null,
        gm && cooldown ? h('button.btn', { type: 'button', onclick: async () => { if (await act({ t: 'spell.ready', uid: s.uid }, `${def.name} is ready.`)) closeDrawer(); } }, 'Reset cooldown') : null,
        h('button.btn.btn-primary', { type: 'button', disabled: !!cooldown, onclick: () => { closeDrawer(); cast(s, def, cost); } }, icon('bolt', { size: 14 }), 'Cast'),
      ],
    });
  }

  /* ---------- gear ---------- */

  function gearPanel() {
    const inv = M.sheet.inventory || [];
    const ok = can('sheet');
    const slots = M.rs.slots;
    if (!slots.length) return h('p.empty-s', 'This pack has no gear slots.');
    const idle = [];
    const cards = slots.map((sl) => {
      const eq = inv.filter((i) => i.equippedSlot === sl.id);
      const cands = inv.filter((i) => !i.equippedSlot && itemOf(M.lib, i).slot === sl.id);
      if (phone() && !eq.length && !(ok && cands.length)) { idle.push(sl.label); return null; } // phones: one line for empty slots
      const full = eq.length >= (sl.max ?? 1);
      return h('div.gslot', { class: `gslot${sl.max > 1 ? ' multi' : ''}${ok ? ' tap' : ''}`, 'data-slot': sl.id },
        h('button.gslot-h', { type: 'button', disabled: !ok, title: ok ? `Choose what to wear: ${sl.label}` : null, onclick: () => slotPicker(sl) },
          h('span', sl.label), h('span.cap', { class: full && sl.max > 1 ? 'cap full' : 'cap' }, sl.max > 1 ? `${eq.length} / ${sl.max}` : ''), ok ? icon('chevron', { size: 13 }) : null),
        eq.length ? h('ul.gslot-items', eq.map((i) => {
          const it = itemOf(M.lib, i);
          return h('li', itemArt(it, 'gs-ico'), h('button.item-link', { type: 'button', class: `item-link r-${rarityOf(it.rarity)}`, onclick: () => itemDrawer(i.uid), title: itemLine(it, i) }, it.name, h('span.gs-line', itemLine(it, i))),
            ok ? h('button.icon-btn', { type: 'button', 'aria-label': `Unequip ${it.name}`, title: 'Unequip', onclick: () => act({ t: 'item.equip', uid: i.uid, slot: null }) }, icon('x', { size: 14 })) : null);
        })) : h('button.gslot-empty', { type: 'button', disabled: !ok || !cands.length, onclick: () => slotPicker(sl) }, cands.length && ok ? `Empty · ${cands.length} to choose from` : 'Empty'),
      );
    });
    const effs = M.computed.effects || activeEffects(M.rs, M.sheet, M.lib);
    return h('section.panel-gear',
      h('div.gslots', cards.filter(Boolean)),
      idle.length ? h('p.gslot-idle', h('span', 'Empty: '), idle.join(', ')) : null,
      h('h3.sub-t', 'Active effects'),
      effs.length ? h('ul.eff-list.eff-table', effs.map((e) => h('li', { class: e.debuff ? 'neg' : null }, h('span.eff-v', effectText(M.rs, e)), h('span.eff-src', e.source?.name || e.from || e.label || '')))) : h('p.empty-s', 'Nothing is changing your numbers right now.'),
    );
  }

  /** Everything the crawler carries that fits this slot: icon, line, Equip / Unequip (a full slot swaps the first item out). */
  function slotPicker(sl) {
    const draw = () => {
      const inv = M.sheet.inventory || []; // M is replaced on every view
      const eq = inv.filter((i) => i.equippedSlot === sl.id);
      const fits = (M.sheet.inventory || []).filter((i) => itemOf(M.lib, i).slot === sl.id);
      const full = eq.length >= (sl.max ?? 1);
      const row = (i) => {
        const it = itemOf(M.lib, i);
        const on = i.equippedSlot === sl.id;
        return h('li.pick-row', { class: on ? 'pick-row on' : 'pick-row' }, itemArt(it, 'inv-ico'),
          h('div.pick-txt', h('b', it.name, (i.qty ?? 1) > 1 ? h('span.dim', ` ×${i.qty}`) : null), h('span.dim.pick-line', itemLine(it, i) || humanize(rarityOf(it.rarity)))),
          it.attack ? h('div.pick-nums', weaponNums(it, i.uid)) : null,
          on ? h('button.btn.btn-sm', { type: 'button', onclick: async () => { await act({ t: 'item.equip', uid: i.uid, slot: null }); refresh(); } }, 'Unequip')
            : h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: async () => {
              if (full && eq[0]) await act({ t: 'item.equip', uid: eq[0].uid, slot: null }, null);
              await act({ t: 'item.equip', uid: i.uid, slot: sl.id }, `Equipped ${it.name}.`);
              if ((sl.max ?? 1) <= 1) closeDrawer(); else refresh();
            } }, full ? 'Swap in' : 'Equip'));
      };
      return fits.length ? h('ul.pick-rows', fits.sort((a, b) => (b.equippedSlot === sl.id) - (a.equippedSlot === sl.id)).map(row))
        : h('p.empty-s', `Nothing in the inventory fits ${sl.label.toLowerCase()}.${gm ? ' Give something from the library.' : ''}`);
    };
    const body = h('div.slot-pick', draw());
    const refresh = () => setTimeout(() => body.replaceChildren(draw()), 250);
    openDrawer({ title: sl.label, sub: (sl.max ?? 1) > 1 ? `Up to ${sl.max} at once` : 'One at a time', body,
      actions: gm ? [h('button.btn.btn-quiet', { type: 'button', onclick: () => { closeDrawer(); gmTools?.give?.(player, M); } }, icon('gift', { size: 14 }), 'Give from library')] : [] });
  }

  /* ---------- inventory ---------- */

  function inventoryPanel() {
    const inv = M.sheet.inventory || [];
    const hot = new Set((M.sheet.hotlist || []).filter(Boolean));
    const q = ui.invQuery.trim().toLowerCase();
    const rows = inv.filter((i) => !q || `${itemOf(M.lib, i).name} ${i.notes || ''}`.toLowerCase().includes(q)).map((i) => {
      const it = itemOf(M.lib, i);
      const r = rarityOf(it.rarity);
      const line = itemLine(it, i);
      return h('li.inv', { class: `inv r-${r}` },
        h('span.rar', { title: r, 'aria-label': r }),
        itemArt(it, 'inv-ico'),
        h('button.inv-n', { type: 'button', onclick: () => { newItemSeen(player?.id, i.uid); itemDrawer(i.uid); }, title: it.desc || '' }, h('span.in', it.name, isNewItem(player?.id, i.uid) ? h('span.inv-new', 'NEW') : null), line ? h('span.inv-note', line) : null),
        i.equippedSlot ? h('span.pill', M.rs.slots.find((s) => s.id === i.equippedSlot)?.label || i.equippedSlot) : null,
        hot.has(i.uid) ? h('span.hot-mark', { title: 'On the hotlist', 'aria-label': 'On the hotlist' }, icon('star', { size: 13 })) : null,
        h('span.inv-q', { title: 'Quantity' }, `×${i.qty ?? 1}`),
      );
    });
    const search = inv.length > 8 ? h('input.inp.inp-search', { type: 'search', placeholder: `Search ${inv.length} items`, value: ui.invQuery, 'aria-label': 'Search inventory', oninput: (e) => { ui.invQuery = e.target.value; const sel = e.target.selectionStart; draw(true); const n = root.querySelector('.inp-search'); n?.focus(); n?.setSelectionRange(sel, sel); } }) : null;
    return h('section.panel-inv', search, inv.length ? h('ul.inv-list', rows) : h('p.empty-s', gm ? 'Empty. Give something from the library.' : 'Empty. The audience has not paid for anything yet.'),
      gm ? h('div.add-row', h('button.btn.btn-quiet.btn-sm', { type: 'button', onclick: () => gmTools?.give?.(player, M) }, icon('gift', { size: 14 }), 'Give from library')) : null);
  }

  /** Weapon numbers for an item with `attack`: to hit (skill rank + stat mod + enhancement) and damage. */
  function weaponMath(it) {
    const atk = it.attack;
    const sk = M.sheet.skills.find((s) => s.skillId === atk.skill);
    const mod = M.computed.stats?.[atk.stat]?.mod?.value ?? 0;
    const plus = Number(atk.bonus) || 0; // +N weapon
    const toHit = { value: (Number(sk?.rank) || 0) + mod + plus, parts: [{ label: sk ? `${sk.name} rank` : 'No skill', value: Number(sk?.rank) || 0, source: 'base' }, { label: `${M.rs.stats.find((s) => s.id === atk.stat)?.abbr || atk.stat} mod`, value: mod, source: 'stat' }, ...(plus ? [{ label: `+${plus} weapon`, value: plus, source: 'item' }] : [])] };
    const dmg = { value: mod + plus, parts: toHit.parts.slice(1) };
    const dmgText = diceText([atk.dice], mod + plus);
    return { toHit, dmg, dmgText };
  }
  /** To hit + damage chips that roll on tap (inline rows and the item drawer). */
  function weaponNums(it, uid) {
    const { toHit, dmg, dmgText } = weaponMath(it);
    return [
      h('div.atk-hit', h('span.mini-l', 'To hit'), num(toHit, { title: `${it.name} to hit`, prefix: ' ', text: signed(toHit.value), roll: it.fragile && !M.local ? { kind: 'attack', uid, part: 'toHit' } : { kind: 'custom', formula: `${M.rs.dice}+${toHit.value}`, label: `${it.name} to hit` } })),
      h('div.atk-dmg', h('span.mini-l', 'Damage'), num(dmg, { title: `${it.name} damage`, text: minus(dmgText), roll: it.fragile && !M.local ? { kind: 'attack', uid, part: 'damage' } : { kind: 'custom', formula: dmgText.replace(/−/g, '-'), label: `${it.name} damage` } })),
    ];
  }
  /** One short line about an item: attack dice, use, slot. */
  function itemLine(it, inv) {
    const bits = [];
    if (it.attack) bits.push(`${it.attack.dice || '?'} ${M.rs.stats.find((s) => s.id === it.attack.stat)?.abbr || ''}`.trim());
    if (it.use) bits.push(useText(it.use).replace(/\.$/, ''));
    const fx = (it.effects || []).map((e) => effectText(M.rs, e)).filter(Boolean);
    if (fx.length) bits.push(fx.slice(0, 2).join(', '));
    if (!bits.length && it.desc) bits.push(it.desc);
    if (inv?.notes) bits.push(inv.notes);
    return bits.join(' · ');
  }

  function itemDrawer(uid) {
    const inv = M.sheet.inventory.find((i) => i.uid === uid);
    if (!inv) { closeDrawer(); return; }
    const it = itemOf(M.lib, inv);
    const r = rarityOf(it.rarity);
    const ok = can('sheet');
    const hotIdx = (M.sheet.hotlist || []).indexOf(uid);
    const slot = M.rs.slots.find((s) => s.id === it.slot);
    const actions = [];
    if (slot && ok) {
      actions.push(inv.equippedSlot
        ? h('button.btn', { type: 'button', onclick: () => act({ t: 'item.equip', uid, slot: null }, `Unequipped ${it.name}.`) }, 'Unequip')
        : h('button.btn.btn-primary', { type: 'button', onclick: () => act({ t: 'item.equip', uid, slot: slot.id }, `Equipped ${it.name}.`) }, `Equip to ${slot.label}`));
    }
    if (M.rs.hotlist?.size && ok) {
      const hl = M.sheet.hotlist || [];
      const free = Array.from({ length: M.rs.hotlist.size }, (_, i) => i).find((i) => !hl[i]);
      actions.push(hotIdx >= 0
        ? h('button.btn', { type: 'button', onclick: () => act({ t: 'hotlist.set', index: hotIdx, uid: null }) }, 'Remove from hotlist')
        : h('button.btn', { type: 'button', disabled: free == null, onclick: () => act({ t: 'hotlist.set', index: free, uid }, 'Added to the hotlist.') }, icon('star', { size: 14 }), 'Add to hotlist'));
    }
    if (it.use && can('play')) {
      actions.unshift(h('button.btn.btn-primary', { type: 'button', onclick: async () => {
        if (await useReadyItem(uid) && (inv.qty ?? 1) <= 1 && (it.use.consume ?? it.stackable)) closeDrawer();
      } }, useLabel(it.use)));
      if (M.rs.hotlist?.combat && it.tags?.includes('potion')) actions.push(h('button.btn', { type: 'button', onclick: () => choosePotionRecipient(uid) }, 'Give to ally'));
    }
    const atk = it.attack;
    const atkLine = atk ? h('div.item-atk', h('h3.sub-t', 'Attack'), h('div.atk-inline2', weaponNums(it, uid)), atk.effects ? h('p.atk-fx', atk.effects) : null) : null;
    const body = [
      h('div.item-head', itemArt(it, 'item-art'), h('div.item-tags', h('span.pill', { class: `pill rar-${r}` }, r), slot ? h('span.pill', slot.label) : h('span.pill', 'No slot'), inv.equippedSlot ? h('span.pill.pill-on', 'Equipped') : null, (it.tags || []).map((t) => h('span.pill.pill-tag', t)))),
      it.desc ? h('p.desc', it.desc) : null,
      it.flavor ? h('p.flavor-t', it.flavor) : null,
      it.missing ? h('p.why-warn.unverified', icon('warn', { size: 13 }), 'This item is no longer in the library. Ask the GM.') : null,
      it.use ? h('div', h('h3.sub-t', 'When used'), h('p.desc', useText(it.use))) : null,
      it.effects?.length ? h('div', h('h3.sub-t', 'Effects'), h('ul.eff-list', it.effects.map((e) => h('li', effectText(M.rs, e), h('span.eff-when', ` ${(e.when || 'equipped')}`))))) : null,
      atkLine,
      (() => {
        // Containers (bag of holding): put this item in one, or take it out.
        const boxes = (M.sheet.inventory || []).filter((x) => x.container && x.uid !== uid && !x.containerUid);
        if (!ok || inv.container || (!boxes.length && !inv.containerUid)) return null;
        return labeled('Carried in', select([{ value: '', label: 'Backpack (loose)' }, ...boxes.map((b) => ({ value: b.uid, label: itemOf(M.lib, b).name }))], inv.containerUid || '', {
          label: 'Carried in', onChange: (v) => act({ t: 'item.move', uid, into: v || null }, v ? `Put in ${itemOf(M.lib, boxes.find((b) => b.uid === v)).name}.` : 'Taken out.'),
        }));
      })(),
      h('div.form-grid',
        labeled('Quantity', stepper(inv.qty ?? 1, { min: 0, label: 'Quantity', disabled: !ok, onChange: (v) => act({ t: 'item.qty', uid, qty: v }) })),
        inv.notes ? labeled('Notes', h('p.desc', inv.notes), { cls: 'span-2' }) : null,
      ),
      // GM: make it +1 / +2 / +3 (D&D style; weapons hit and hurt harder, armour gives more DR)
      gm && (it.attack || (it.effects || []).some((e) => e.target === 'armor')) && !(it.stackable && (inv.qty ?? 1) > 1)
        ? h('div.lbl', h('span.lbl-t', 'Enhancement'), h('div.chips', [0, 1, 2, 3].map((n) => h('button.chip', {
          type: 'button', 'aria-pressed': String((inv.bonus || 0) === n), class: `chip r-${['common', 'uncommon', 'rare', 'epic'][n]}`,
          onclick: () => act({ t: 'item.enhance', uid, bonus: n }, n ? `Now +${n}.` : 'Back to plain.'),
        }, n ? `+${n}` : 'Plain'))), h('span.lbl-hint', '+1 uncommon (green), +2 rare (blue), +3 epic'))
        : null,
      gm ? h('div.row-end', h('button.btn.btn-quiet.btn-sm.danger', { type: 'button', onclick: async () => { if (await act({ t: 'item.remove', uid }, `Removed ${it.name}.`)) closeDrawer(); } }, icon('trash', { size: 14 }), 'Remove from inventory')) : null,
    ];
    ui.drawer = { kind: 'item', uid };
    openDrawer({ title: it.name, sub: `${humanize(r)} item${inv.qty > 1 ? `, ${inv.qty} carried` : ''}`, body, actions, onClose: () => { ui.drawer = null; } });
  }

  function useLabel(u) {
    if (u.heal) return 'Use';
    if (u.applyBuff || u.buff) return 'Use';
    return 'Use';
  }
  function useText(u) {
    const bits = [];
    if (u.heal) { const t = M.rs.tracks.find((x) => x.id === (u.heal.track || u.track)); bits.push(`Restores ${u.heal.amount ?? u.heal.dice ?? u.heal.value ?? u.heal} ${t?.label?.toLowerCase() || ''}`.trim()); }
    if (u.applyBuff || u.buff) bits.push(`Applies ${(libGet(M.lib, 'buff', u.applyBuff || u.buff)?.name) || u.applyBuff || u.buff}${u.target === 'self' ? ' to you' : ''}`);
    if (u.removeBuff) bits.push(`Removes ${libGet(M.lib, 'buff', u.removeBuff)?.name || u.removeBuff}`);
    if (u.consume ?? true) bits.push('Uses one up');
    if (u.note) bits.push(u.note);
    return bits.join('. ') + (bits.length ? '.' : '');
  }

  /* ---------- hotlist ---------- */

  async function useReadyItem(uid, target) {
    const inv = M.sheet.inventory.find((i) => i.uid === uid);
    if (!inv) return null;
    const name = itemOf(M.lib, inv).name;
    const result = await act({ t: 'item.use', uid, ...(target ? { target } : {}) });
    if (result) toast(result.result?.potionSickness ? `${name} used · Potion Sickness` : `Used ${name}.`, { error: !!result.result?.potionSickness });
    return result;
  }

  function choosePotionRecipient(uid) {
    const inv = M.sheet.inventory.find((i) => i.uid === uid);
    if (!inv) return;
    const allies = (view.players || []).filter((p) => p.id !== player.id);
    openDrawer({ title: itemOf(M.lib, inv).name, sub: 'Choose a nearby ally', body: allies.length ? h('div.add-row',
      allies.map((p) => h('button.btn', { type: 'button', onclick: async (e) => {
        const button = e.currentTarget;
        button.disabled = true;
        if (await useReadyItem(uid, p.id)) closeDrawer();
        else button.disabled = false;
      } }, p.name))) : h('p.empty-s', 'No other crawler in the party.') });
  }

  function hotlistPanel() {
    const n = M.rs.hotlist?.size || 0;
    if (!n) return h('p.empty-s', 'This pack has no hotlist.');
    const hl = M.sheet.hotlist || [];
    const ok = can('sheet');
    const tiles = Array.from({ length: n }, (_, i) => {
      const uid = hl[i];
      const inv = uid ? M.sheet.inventory.find((x) => x.uid === uid) : null;
      const spell = M.rs.hotlist?.combat && M.sheet.spells?.find((s) => s.uid === uid);
      if (spell) return h('button.hot', { type: 'button', onclick: () => spellDrawer(spell), 'aria-label': `Hotlist slot ${i + 1}: ${spell.name}` },
        h('span.hot-i', String((i + 1) % 10)), itemArt(spell, 'hot-art'), h('span.hot-n', spell.name), icon('bolt', { size: 12 }));
      if (!inv) {
        return h('button.hot', { type: 'button', class: 'hot empty', disabled: !ok, onclick: () => pickHot(i), 'aria-label': `Hotlist slot ${i + 1}, empty` }, h('span.hot-i', String((i + 1) % 10)), h('span.hot-n', ok ? 'Add' : 'Empty'));
      }
      const it = itemOf(M.lib, inv);
      return h('button.hot', { type: 'button', class: `hot r-${rarityOf(it.rarity)}`, onclick: () => itemDrawer(inv.uid), 'aria-label': `Hotlist slot ${i + 1}: ${it.name}`, title: [it.name, itemLine(it, inv)].filter(Boolean).join('\n') },
        h('span.hot-i', String((i + 1) % 10)), itemArt(it, 'hot-art'), h('span.hot-n', it.name), h('span.hot-q', `×${inv.qty ?? 1}`), it.attack ? h('span.hot-atk', icon('swords', { size: 12 })) : null);
    });
    return h('section.panel-hot', h('div.hots', tiles), h('p.hint', 'Tap a slot to open it.'));
  }

  function pickHot(index) {
    const inHot = new Set((M.sheet.hotlist || []).filter(Boolean));
    const cands = M.sheet.inventory.filter((i) => !inHot.has(i.uid));
    const spells = M.rs.hotlist?.combat ? M.sheet.spells.filter((s) => !inHot.has(s.uid)) : [];
    openDrawer({
      title: `Hotlist slot ${index + 1}`,
      body: cands.length || spells.length ? h('ul.pick-list', cands.map((i) => {
        const it = itemOf(M.lib, i);
        return h('li', h('button.pick.pick-art', { type: 'button', onclick: async () => { if (await act({ t: 'hotlist.set', index, uid: i.uid })) closeDrawer(); } }, itemArt(it, 'inv-ico'), h('span', h('b', it.name), h('span.dim.pick-line', itemLine(it, i))), h('span.dim', `×${i.qty ?? 1}`)));
      }), spells.map((s) => h('li', h('button.pick.pick-art', { type: 'button', onclick: async () => {
        if (await act({ t: 'hotlist.set', index, uid: s.uid })) closeDrawer();
      } }, itemArt(s, 'inv-ico'), h('span', h('b', s.name), h('span.dim.pick-line', `Spell · Rank ${s.rank}`)))))) : h('p.empty-s', 'Your Hotlist has everything ready.'),
    });
  }

  /* ---------- story ---------- */

  function storyPanel() {
    const fieldsDef = M.rs.storyFields.length ? M.rs.storyFields : ['notes'];
    const ok = can('story');
    return h('section.panel-story',
      !ok ? lockHint(lockText()) : null,
      fieldsDef.map((id) => {
        const f = M.rs.fields.find((x) => x.id === id);
        const v = M.sheet.story?.[id] ?? '';
        return labeled(f?.label || humanize(id), field(v, { multiline: true, rows: id === 'notes' ? 5 : 3, disabled: !ok, onCommit: (x) => act({ t: 'sheet.set', path: `story.${id}`, value: x }) }));
      }),
    );
  }

  /* ---------- tabs ---------- */

  function tabs() {
    const s = M.sheet;
    const t = [
      { id: 'attacks', label: 'Actions', count: s.attacks?.length || '' },
      { id: 'skills', label: 'Skills', count: s.skills?.length || '', cls: 'tab-skills' },
      { id: 'spells', label: 'Spells', count: s.spells?.length || '' },
      { id: 'gear', label: 'Gear' },
      { id: 'inventory', label: 'Inventory', count: s.inventory?.length || '' },
      { id: 'hotlist', label: 'Hotlist' },
      { id: 'story', label: 'Story' },
    ].filter((x) => !(x.id === 'hotlist' && !M.rs.hotlist?.size) && !(x.id === 'gear' && !M.rs.slots.length) && !(x.id === 'spells' && !M.lib.spell.length && !s.spells?.length));
    const extra = gm ? extraTabs() || [] : [];
    const all = [...t, ...extra];
    if (!ui.tab || !all.some((x) => x.id === ui.tab)) ui.tab = all[0]?.id;
    const panel = (() => {
      switch (ui.tab) {
        case 'attacks': return actionsPanel();
        case 'skills': return skillsPanel();
        case 'spells': return spellsPanel();
        case 'gear': return gearPanel();
        case 'inventory': return inventoryPanel();
        case 'hotlist': return hotlistPanel();
        case 'story': return storyPanel();
        default: return extra.find((x) => x.id === ui.tab)?.render() || null;
      }
    })();
    return h('section.sh-tabs',
      tabBar(all, ui.tab, (id) => {
        if (gm) { ui.tab = id; try { sessionStorage.setItem(`system.sheetTab.${mode}`, id); } catch { /* storage unavailable */ } }
        else chooseSheetSection(id);
        draw(true);
      }, { label: 'Sheet sections' }),
      h('div.tab-panel', { role: 'tabpanel', class: `tab-panel tp-${ui.tab}` }, panel),
    );
  }

  /* ---------- portrait ---------- */

  function portraitButton(name, size) {
    const av = avatar(name, { color: player.color, src: M.sheet.portrait, size });
    if (!(gm || can('sheet'))) return av;
    return h('button.av-btn', { type: 'button', title: M.sheet.portrait ? 'Change the picture' : 'Add a picture', 'aria-label': M.sheet.portrait ? `Change ${name}'s picture` : `Add a picture of ${name}`, onclick: () => portraitMenu() },
      av, h('span.av-edit', { 'aria-hidden': 'true' }, icon(M.sheet.portrait ? 'edit' : 'plus', { size: 12 })));
  }
  async function uploadPortrait() {
    let url;
    try { url = await pickPortrait(); } catch (err) { toast(err.message, { error: true, ms: 4000 }); return; }
    if (!url) return;
    toast('Uploading the picture…');
    if (await act({ t: 'sheet.set', path: 'portrait', value: url })) toast('Picture saved. It shows on the TV too.');
  }
  function portraitMenu() {
    const packArt = view?.pack?.ui;
    const families = Object.entries(packArt?.avatarFamilies || {});
    const familyImages = new Set(families.flatMap(([, entries]) => Object.values(entries).map((art) => art.src)));
    const general = Object.fromEntries(Object.entries(packArt?.avatars || {}).filter(([, art]) => !familyImages.has(art.src)));
    if (Object.keys(general).length) families.unshift(['general', general]);
    if (!M.sheet.portrait && !families.length) { uploadPortrait(); return; }
    const grid = h('div.sh-avatar-grid');
    const showFamily = (key) => {
      const entries = families.find(([id]) => id === key)?.[1] ?? {};
      grid.replaceChildren(...Object.entries(entries).map(([id, art]) => {
        const label = art.name || `${humanize(key)} ${id}`;
        return h('button.sh-avatar-choice', {
          type: 'button', 'aria-pressed': String(M.sheet.portrait === art.src),
          onclick: async () => {
            if (await act({ t: 'sheet.set', path: 'portrait', value: art.src }, 'Picture saved.')) closeDrawer();
          },
        }, h('img', { src: art.still || art.src, alt: '', loading: 'lazy', decoding: 'async' }), h('span', label));
      }));
    };
    const selectedFamily = families.find(([, entries]) => Object.values(entries).some((art) => art.src === M.sheet.portrait));
    const race = M.sheet.identity?.race?.split(':').at(-1)?.trim().toLowerCase();
    const speciesFamily = M.sheet.species && families.find(([id]) => id === race);
    const initial = (selectedFamily || speciesFamily || families[0])?.[0];
    if (initial) showFamily(initial);
    openDrawer({
      title: 'Character picture',
      body: [
        M.sheet.portrait ? h('div.pt-preview', avatar(player.name, { src: M.sheet.portrait, size: 96 })) : null,
        initial ? h('label.lbl', h('span.lbl-t', 'Avatar family'),
          select(families.map(([value]) => ({ value, label: humanize(value) })), initial, { onChange: showFamily })) : null,
        initial ? grid : null,
      ],
      actions: [
        M.sheet.portrait ? h('button.btn.danger', { type: 'button', onclick: async () => { if (await act({ t: 'sheet.set', path: 'portrait', value: null }, 'Picture removed.')) closeDrawer(); } }, 'Remove') : null,
        h('button.btn.btn-primary', { type: 'button', onclick: () => { closeDrawer(); uploadPortrait(); } }, 'Upload a picture'),
      ],
    });
  }

  /* ---------- actions: attacks, limited-use pools, usable items ---------- */

  function poolsBlock() {
    const pools = M.sheet.pools || [];
    const ok = can('sheet');
    if (!pools.length && !ok) return null;
    const rows = pools.map((pl) => h('li.pool-row',
      h('div.pool-main', h('b.pool-n', pl.name, h('span.dim.pool-reset', pl.reset === 'short' ? ' · short rest' : ' · long rest')), pl.desc ? h('p.pool-d', pl.desc) : null),
      h('div.pool-ctl',
        h('button.icon-btn', { type: 'button', disabled: pl.cur <= 0, 'aria-label': `${pl.name} minus 1`, onclick: () => act({ t: 'pool.set', uid: pl.uid, delta: -1 }) }, icon('minus', { size: 16 })),
        h('span.pool-v', h('b', String(pl.cur)), `/${pl.max}`),
        h('button.icon-btn', { type: 'button', disabled: pl.cur >= pl.max, 'aria-label': `${pl.name} plus 1`, onclick: () => act({ t: 'pool.set', uid: pl.uid, delta: 1 }) }, icon('plus', { size: 16 })),
        ok && ui.editing ? h('button.icon-btn', { type: 'button', 'aria-label': `Remove ${pl.name}`, onclick: () => act({ t: 'pool.remove', uid: pl.uid }, `Removed ${pl.name}.`) }, icon('trash', { size: 14 })) : null,
      )));
    const add = () => {
      const name = field('', { placeholder: 'e.g. Lay on Hands' });
      const max = field(3, { type: 'number', attrs: { min: 0, inputmode: 'numeric' } });
      const desc = field('', { multiline: true, rows: 2, placeholder: 'What it does (optional)' });
      const reset = select([{ value: 'long', label: 'Long rest' }, { value: 'short', label: 'Short rest' }], 'long', { label: 'Refills on' });
      openDrawer({
        title: 'Add a counter',
        sub: 'Uses per day, charges, a pool of healing: anything you tick down and refill.',
        body: h('div.form-grid', labeled('Name', name, { cls: 'span-2' }), labeled('Max', max), labeled('Refills on', reset), labeled('What it does', desc, { cls: 'span-all' })),
        actions: [h('button.btn.btn-primary', { type: 'button', onclick: async () => { if (!name.value.trim()) { name.focus(); return; } if (await act({ t: 'pool.add', name: name.value.trim(), max: Math.max(0, Number(max.value) || 0), desc: desc.value.trim(), ...(reset.value === 'short' ? { reset: 'short' } : {}) }, 'Counter added.')) closeDrawer(); } }, 'Add counter')],
      });
    };
    const rest = async (kind) => {
      let heal;
      if (kind === 'short' && !M.rs.rests?.short) {
        const v = prompt('Short rest: how much health do they get back? (hit dice rolled at the table; empty = none)', '');
        if (v === null) return;
        heal = Math.max(0, Math.round(Number(v) || 0));
      } else if (kind === 'long' && !M.rs.rests?.long && !(await ask(`Long rest for ${player.name}? Health and every resource back to full, every counter refilled.`, { ok: 'Long rest' }))) return;
      const r = await act({ t: 'rest', kind, ...(heal ? { heal } : {}) }, null);
      if (r) toast(r.result?.restored?.length ? `${kind === 'long' ? 'Long' : 'Short'} rest: ${r.result.restored.join(', ')}.` : 'Rested. Nothing needed refilling.');
    };
    return h('section.sh-block.sh-pools',
      can('play') && (gm || !M.rs.rests) ? h('div.rest-row', h('span.mini-l', 'Rest'),
        h('button.btn.btn-sm', { type: 'button', onclick: () => rest('short') }, 'Short rest'),
        h('button.btn.btn-sm', { type: 'button', onclick: () => rest('long') }, 'Long rest')) : null,
      h('h2.blk-t', 'Limited uses'),
      pools.length ? h('ul.pool-list', rows) : h('p.empty-s', 'No counters yet.'),
      ok ? h('div.add-row', h('button.btn.btn-quiet.btn-sm', { type: 'button', onclick: add }, icon('plus', { size: 14 }), 'Add a counter')) : null,
    );
  }
  function usableItems() {
    const inv = M.sheet.inventory || [];
    const weapons = inv.filter((i) => itemOf(M.lib, i).attack).sort((a, b) => (b.equippedSlot ? 1 : 0) - (a.equippedSlot ? 1 : 0));
    const usable = inv.filter((i) => itemOf(M.lib, i).use && !itemOf(M.lib, i).attack);
    if (!weapons.length && !usable.length) return null;
    const play = can('play');
    const wRow = (i) => {
      const it = itemOf(M.lib, i);
      return h('li.wpn', { class: `wpn r-${rarityOf(it.rarity)}${i.equippedSlot ? ' eq' : ''}` },
        itemArt(it, 'inv-ico'),
        h('button.wpn-n', { type: 'button', onclick: () => itemDrawer(i.uid) }, h('span.in', it.name),
          h('span.inv-note', [i.equippedSlot ? 'In hand' : 'Carried', it.attack.effects].filter(Boolean).join(' · '))),
        ...weaponNums(it, i.uid));
    };
    const uRow = (i) => {
      const it = itemOf(M.lib, i);
      return h('li.wpn', { class: `wpn r-${rarityOf(it.rarity)}` },
        itemArt(it, 'inv-ico'),
        h('button.wpn-n', { type: 'button', onclick: () => itemDrawer(i.uid) }, h('span.in', it.name, h('span.dim', ` ×${i.qty ?? 1}`)), h('span.inv-note', useText(it.use))),
        h('button.btn.btn-sm', { type: 'button', disabled: !play, onclick: () => act({ t: 'item.use', uid: i.uid }, `Used ${it.name}.`) }, 'Use'));
    };
    return [
      weapons.length ? h('section.sh-block.sh-usable', h('h2.blk-t', 'Weapons', h('span.blk-n', String(weapons.length))), h('p.hint', 'Tap a number to roll it.'), h('ul.wpn-list', weapons.map(wRow))) : null,
      usable.length ? h('section.sh-block.sh-usable', h('h2.blk-t', 'Items you can use', h('span.blk-n', String(usable.length))), h('ul.wpn-list', usable.map(uRow))) : null,
    ];
  }
  function actionsPanel() {
    const atks = M.sheet.attacks || [];
    return h('div.panel-actions',
      usableItems(),
      M.rs.legacy ? null : h('section.sh-block.sh-attacks', h('h2.blk-t', 'Other attacks'), atks.length || can('sheet') ? attacksPanel() : null),
      poolsBlock(),
      basicActions(),
    );
  }
  /** What anyone can do without items or special skills (ruleset creation.basicActions). */
  function basicActions() {
    const list = M.rs.creation?.basicActions || [];
    if (!list.length) return null;
    return h('details.sh-block.sh-basic', { open: !(M.sheet.attacks || []).length || null },
      h('summary.blk-t', 'What anyone can do'),
      h('ul.sh-basic-list', list.map((x) => h('li', h('b', x.name), h('span', x.text)))));
  }

  /* ---------- backpack with containers ---------- */

  function invRow(i, hot) {
    const it = itemOf(M.lib, i);
    const r = rarityOf(it.rarity);
    return h('li.inv', { class: `inv r-${r}` },
      h('span.rar', { title: r, 'aria-label': r }),
      itemArt(it, 'inv-ico'),
      h('button.inv-n', { type: 'button', onclick: () => { newItemSeen(player?.id, i.uid); itemDrawer(i.uid); } }, h('span.in', it.name, isNewItem(player?.id, i.uid) ? h('span.inv-new', 'NEW') : null), itemLine(it, i) ? h('span.inv-note', itemLine(it, i)) : null),
      hot.has(i.uid) ? h('span.hot-mark', { title: 'On the hotlist', 'aria-label': 'On the hotlist' }, icon('star', { size: 13 })) : null,
      h('span.inv-q', { title: 'Quantity' }, `×${i.qty ?? 1}`),
    );
  }
  function backpack() {
    const inv = (M.sheet.inventory || []).filter((i) => !i.equippedSlot);
    const hot = new Set((M.sheet.hotlist || []).filter(Boolean));
    const q = ui.invQuery.trim().toLowerCase();
    const match = (i) => !q || `${itemOf(M.lib, i).name} ${i.notes || ''}`.toLowerCase().includes(q);
    const boxes = inv.filter((i) => i.container);
    const loose = inv.filter((i) => !i.container && !(i.containerUid && boxes.some((b) => b.uid === i.containerUid)));
    const search = (M.sheet.inventory || []).length > 8 ? h('input.inp.inp-search', { type: 'search', placeholder: 'Search your gear', value: ui.invQuery, 'aria-label': 'Search inventory', oninput: (e) => { ui.invQuery = e.target.value; const sel = e.target.selectionStart; draw(true); const n = root.querySelector('.inp-search'); n?.focus(); n?.setSelectionRange(sel, sel); } }) : null;
    ui.openBoxes ??= {};
    return h('section.sh-block.sh-backpack',
      h('h2.blk-t', 'Backpack', h('span.blk-n', String(inv.length)),
        M.rs.creation?.help?.inventory ? h('button.icon-btn.xs', { type: 'button', 'aria-label': 'How the backpack works', 'aria-expanded': String(!!ui.invHelp), onclick: () => { ui.invHelp = !ui.invHelp; draw(true); } }, icon('info', { size: 14 })) : null),
      ui.invHelp && M.rs.creation?.help?.inventory ? h('p.cr-info', M.rs.creation.help.inventory) : null,
      search,
      boxes.map((b) => {
        const inside = inv.filter((i) => i.containerUid === b.uid && match(i));
        const open = ui.openBoxes[b.uid] ?? true;
        return h('details.bag', { open: open || !!q, ontoggle: (e) => { ui.openBoxes[b.uid] = e.target.open; } },
          h('summary', icon('down', { size: 14 }), h('b', itemOf(M.lib, b).name), h('span.dim', `${inv.filter((i) => i.containerUid === b.uid).length} inside`),
            h('button.icon-btn.bag-i', { type: 'button', 'aria-label': `About ${itemOf(M.lib, b).name}`, onclick: (e) => { e.preventDefault(); itemDrawer(b.uid); } }, icon('info', { size: 14 }))),
          inside.length ? h('ul.inv-list', inside.map((i) => invRow(i, hot))) : h('p.empty-s', q ? 'Nothing matches in here.' : 'Empty. Open an item and choose "Put in…".'));
      }),
      loose.filter(match).length ? h('ul.inv-list', loose.filter(match).map((i) => invRow(i, hot))) : (inv.length ? null : h('p.empty-s', gm ? 'Empty. Give something from the library.' : 'Empty. The audience has not paid for anything yet.')),
      gm ? h('div.add-row', h('button.btn.btn-quiet.btn-sm', { type: 'button', onclick: () => gmTools?.give?.(player, M) }, icon('gift', { size: 14 }), 'Give from library')) : null,
    );
  }

  /* ---------- features, proficiencies, background ---------- */

  function originEntries() {
    const id = M.sheet.identity || {};
    const out = [];
    for (const [kind, val, label] of [['race', id.race, M.rs.labels?.race || 'Race'], ['class', id.class, 'Class'], ['background', id.background, 'Background']]) {
      if (!val) continue;
      const def = (M.lib[kind] || []).find((x) => x.name === val || x.id === val) || (kind === 'race' ? M.rs.races : kind === 'class' ? M.rs.classes : M.rs.backgrounds).find?.((x) => x.name === val || x.id === val) || null;
      out.push({ kind, label, name: val, def });
    }
    return out;
  }
  function featuresPanel() {
    const cards = [];
    for (const o of originEntries()) {
      if (o.def?.desc) cards.push(h('article.trait', h('h3', o.name, h('span.trait-k', o.label)), h('p', o.def.desc)));
      for (const fid of o.def?.features || []) {
        const f = (M.lib.feature || []).find((x) => x.id === fid || x.name === fid);
        cards.push(h('article.trait', h('h3', f?.name || humanize(fid), h('span.trait-k', `${o.label}: ${o.name}`)), f?.desc ? h('p', f.desc) : null));
      }
    }
    for (const b of M.sheet.buffs || []) cards.push(h('article.trait', { class: buffNet(b) < 0 ? 'trait neg' : 'trait' }, h('h3', b.name, h('span.trait-k', buffNet(b) < 0 ? 'Debuff' : 'Buff')), b.desc ? h('p', b.desc) : null, b.until ? h('p.dim', `Lasts: ${b.until}`) : null));
    return h('section.ph-traits', cards.length ? cards : h('p.empty-s', 'No features or traits yet. They come with race, class and buffs.'));
  }
  function proficienciesPanel() {
    const rs = M.rs;
    const skip = new Set(['identity', 'story', 'defense']);
    const fields = rs.fields.filter((f) => !skip.has(f.group) && !rs.storyFields.includes(f.id) && !rs.identity.includes(f.id) && f.type !== 'longtext');
    const ok = can('sheet');
    const groups = [...new Set(fields.map((f) => f.group || 'other'))];
    const skills = (M.sheet.skills || []).slice().sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0) || a.name.localeCompare(b.name));
    return h('section.ph-prof',
      groups.map((g) => h('div.sh-block', h('h2.blk-t', humanize(g)),
        h('dl.kv', fields.filter((f) => (f.group || 'other') === g).map((f) => h('div', h('dt', f.label),
          h('dd', ui.editing && ok && (gm || !(M.rs.gmOnly || []).includes(f.id)) ? field(M.sheet.fields?.[f.id] ?? f.default ?? '', { type: f.type === 'number' ? 'number' : 'text', attrs: { 'aria-label': f.label }, onCommit: (x) => act({ t: 'sheet.set', path: `fields.${f.id}`, value: x }) }) : String(M.sheet.fields?.[f.id] ?? f.default ?? '—'))))))),
      h('div.sh-block', h('h2.blk-t', 'Training'),
        skills.length ? h('ul.prof-chips', skills.map((s) => h('li', h('b', s.name), h('span', `Rank ${s.rank ?? 0}`)))) : h('p.empty-s', 'No trained skills yet.')),
    );
  }
  function backgroundPanel() {
    const id = M.sheet.identity || {};
    const ok = can('story');
    const story = (M.rs.storyFields.length ? M.rs.storyFields : []).filter((x) => x !== 'notes');
    const facts = [['Background', id.background], ['Pronouns', id.pronouns], ['Crawler', id.crawlerNumber ? `#${id.crawlerNumber}` : ''], ['Floor', id.floor]].filter(([, v]) => v != null && v !== '');
    return h('section.ph-bg',
      facts.length ? h('dl.kv', facts.map(([k, v]) => h('div', h('dt', k), h('dd', String(v))))) : null,
      story.length ? story.map((sid) => {
        const f = M.rs.fields.find((x) => x.id === sid);
        return labeled(f?.label || humanize(sid), field(M.sheet.story?.[sid] ?? '', { multiline: true, rows: 3, disabled: !ok, onCommit: (x) => act({ t: 'sheet.set', path: `story.${sid}`, value: x }) }));
      }) : h('p.empty-s', 'This pack has no background fields.'),
      !ok ? lockHint(lockText()) : null,
    );
  }
  function notesPanel() {
    const ok = can('notes');
    return h('section.ph-notes',
      !ok ? lockHint(lockText()) : null,
      field(M.sheet.story?.notes ?? player.notes ?? '', { multiline: true, rows: 12, disabled: !ok, placeholder: 'Names, clues, loot you promised to share, grudges…', attrs: { 'aria-label': 'Notes' }, onCommit: (x) => act({ t: 'sheet.set', path: 'story.notes', value: x }) }),
    );
  }

  /* ---------- phone layout (D&D Beyond-style): sticky crawler bar, stats, section tabs ---------- */

  const PSECTIONS = [
    { id: 'skills', label: 'Skills' },
    { id: 'actions', label: 'Actions' },
    { id: 'inventory', label: 'Inventory' },
    { id: 'spells', label: 'Spells' },
    { id: 'features', label: 'Features & Traits' },
    { id: 'prof', label: 'Proficiencies & Training' },
    { id: 'background', label: 'Background' },
    { id: 'notes', label: 'Notes' },
  ];
  function phoneSections() {
    return PSECTIONS.filter((t) => t.id !== 'spells' || (M.sheet.spells || []).length)
      .map((t) => ({ ...t, count: t.id === 'skills' ? M.sheet.skills?.length || '' : t.id === 'inventory' ? M.sheet.inventory?.length || '' : t.id === 'spells' ? M.sheet.spells?.length : '' }));
  }
  /** The "inspiration" slot: a number field the pack names favor / inspiration / luck / hero. */
  function luckField() {
    return M.rs.fields.find((f) => f.type === 'number' && /favou?r|inspir|luck|hero|fate/i.test(`${f.id} ${f.label}`)) || null;
  }
  function phoneTop() {
    const id = M.sheet.identity || {};
    const name = id.name || player.name || 'Crawler';
    const okT = can('tracks');
    const bars = M.rs.tracks.slice(0, 2).map((t, k) => {
      const c = M.computed.tracks?.[t.id] || M.sheet.tracks?.[t.id] || { cur: 0, max: 0 };
      const max = t.kind === 'slots' ? (t.slots || c.max || 10) : Number(c.max) || 0;
      const cur = Math.max(0, Number(c.cur) || 0);
      const pct = max > 0 ? Math.min(100, (cur / max) * 100) : 0;
      const step = (d) => h('button.ph-step', { type: 'button', disabled: !okT || (d < 0 ? cur <= 0 : cur >= max), 'aria-label': `${t.label} ${d < 0 ? 'minus' : 'plus'} 1`, onclick: () => act({ t: 'track.set', track: t.id, delta: d }) }, icon(d < 0 ? 'minus' : 'plus', { size: 16 }));
      return h('div.ph-track', { 'data-track': t.id, class: `ph-track${pct <= 30 ? ' low' : ''}${k === 0 ? ' main' : ''}` },
        k === 0 ? step(-1) : null,
        // Health slots (27 Nov): one rectangle per slot with the HP it soaks, so a hit's cost is visible.
        t.kind === 'slots' && max > 0 && max <= 20
          ? h('div.ph-bar.ph-slotbar', { role: 'meter', 'aria-valuenow': cur, 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-label': `${t.label} ${cur}/${max}${c.slotValue > 1 ? `, ${c.slotValue} HP per slot` : ''}` },
            h('span.ph-bl', t.label, c.slotValue > 1 ? h('small', ` · ${c.slotValue} HP/slot`) : null), h('b.ph-bv', `${cur}`, h('small', `/${max}`)),
            h('div.ph-cells', Array.from({ length: max }, (_, i) => h('i', { class: i < cur ? 'on' : '' }, c.slotValue > 0 ? String(c.slotValue) : ''))))
          : h('div.ph-bar', { role: 'meter', 'aria-valuenow': cur, 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-label': t.label },
            h('i.ph-fill', { style: { width: `${pct}%` } }), h('span.ph-bl', t.label), h('b.ph-bv', `${cur}`, h('small', `/${max}`))),
        k === 0 ? step(1) : null);
    });
    const lf = luckField();
    const lv = lf ? Number(M.sheet.fields?.[lf.id] ?? lf.default ?? 0) : null;
    return h('header.ph-top',
      h('div.ph-row',
        portraitButton(name, 44),
        h('div.ph-id', h('b.ph-name', name), h('span.ph-lv', `Level ${id.level ?? player.level ?? 1}`, top ? top() : null)),
        lf ? h('div.ph-luck', { title: lf.label },
          h('span.ph-luck-l', lf.label),
          h('div.ph-luck-v',
            can('sheet') ? h('button.ph-mini', { type: 'button', disabled: lv <= 0, 'aria-label': `${lf.label} minus 1`, onclick: () => act({ t: 'sheet.set', path: `fields.${lf.id}`, value: lv - 1 }) }, icon('minus', { size: 12 })) : null,
            h('b', String(lv)),
            can('sheet') && (gm || !(M.rs.gmOnly || []).includes(lf.id)) ? h('button.ph-mini', { type: 'button', 'aria-label': `${lf.label} plus 1`, onclick: () => act({ t: 'sheet.set', path: `fields.${lf.id}`, value: lv + 1 }) }, icon('plus', { size: 12 })) : null)) : null,
      ),
      h('div.ph-tracks', bars),
    );
  }
  function openSecondary(tab) {
    const dlg = openDrawer({ title: tab.label, body: tab.render(), wide: tab.id === 'maps', onClose: () => draw(true) });
    dlg.dataset.playerNavigation = 'true';
  }

  function playerMore() {
    const extra = (extraTabs() || []).filter((t) => !t.primaryPage);
    const row = (ic, label, sub, badge, fn) => h('li', h('button.more-row', { type: 'button', onclick: fn }, icon(ic, { size: 20 }), h('span', h('b', label), sub ? h('small', sub) : null), badge ? h('span.ph-badge.inline', String(badge)) : icon('chevron', { size: 16 })));
    const canEdit = gm || can('story');
    return h('section.ph-view-more', { 'aria-label': 'More' }, h('h2', 'More'), h('ul.more-list',
      extra.map((x) => row(x.id === 'maps' ? 'map' : 'star', x.label, null, x.badge, () => openSecondary(x))),
      canEdit ? row('edit', ui.editing ? 'Stop editing' : 'Edit sheet', 'Identity, stats, counters', null, () => { ui.editing = !ui.editing; setTab('sheet'); }) : null,
      (gm || can('sheet')) && onBuilder ? row('sparkle', 'Character builder', 'Step by step', null, () => onBuilder(M, player)) : null,
      (gm || can('sheet')) ? row('users', 'Character picture', 'Shown on the TV', null, portraitMenu) : null,
      (moreItems() || []).map((x) => row(x.icon || 'chevron', x.label, x.sub, x.badge, () => {
        x.onClick();
        if (x.navigationDrawer) {
          const dlg = document.querySelector('dialog.drawer[open]');
          if (dlg) dlg.dataset.playerNavigation = 'true';
        }
      })),
    ));
  }
  /** Starting things from guided creation, waiting for the GM: the GM gives or drops them, the player sees them. */
  function gearRequestBox() {
    const req = M.sheet.gearRequest || [];
    if (!req.length) return null;
    if (!gm) return h('div.callout.cr-wait', icon('gift', { size: 14 }), h('span', 'Waiting for the GM: ', req.map((r) => r.name).join(', ')));
    return h('div.callout.cr-wait',
      h('p', h('b', 'Starting stuff to approve'), h('span.dim', ' (from character creation)')),
      h('ul.cr-req', req.map((r, i) => h('li', h('span.dim', `${r.slot}: `), h('b', r.name), r.itemId ? null : h('span.pill', 'custom'),
        h('button.btn.btn-sm', { type: 'button', onclick: () => act({ t: 'gear.approve', index: i }, `${r.name} given.`) }, 'Give'),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => act({ t: 'gear.deny', index: i }, `${r.name} dropped.`) }, 'Drop')))),
      req.length > 1 ? h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => act({ t: 'gear.approve' }, 'All given.') }, 'Give all') : null);
  }
  function phoneInfo() {
    const id = M.sheet.identity || {};
    const line = [id.race, id.class].filter(Boolean).join(' ');
    const pend = M.sheet.pending && Object.keys(M.sheet.pending).length ? M.sheet.pending : null;
    const empty = !M.legacy && !id.race && !id.class && !(M.sheet.skills || []).length;
    return h('section.ph-info',
      h('p.ph-line', line || (gm ? `No ${(M.rs.labels?.race || 'race').toLowerCase()} or class yet` : `${M.rs.labels?.race || 'Race'} and class: ask your GM`), id.floor != null && id.floor !== '' ? h('span', `Floor ${id.floor}`) : null,
        pend ? h('span.pill.pill-on', `Asked: ${Object.values(pend).filter(Boolean).join(' ')}`) : null),
      gearRequestBox(),
      empty && onBuilder && (gm || can('sheet')) ? h('div.callout', h('p', h('b', 'This sheet is empty.'), ' The builder takes you through it.'), h('button.btn.btn-primary', { type: 'button', onclick: () => onBuilder(M, player) }, 'Open the builder')) : null,
      ui.editing ? identityEditor() : null,
      stats(),
      defense(),
      M.rs.legacy ? null : buffs(),
    );
  }
  function phoneSection(id) {
    switch (id) {
      case 'actions': return actionsPanel();
      case 'inventory': return h('div.panel-invsplit',
        M.rs.slots.length ? h('section.sh-block.sh-equipped', h('h2.blk-t', 'Equipped'), gearPanel()) : null,
        backpack(),
        M.rs.hotlist?.size ? h('section.sh-block.ph-hot', h('h2.blk-t', 'Hotlist'), hotlistPanel()) : null);
      case 'spells': return spellsPanel();
      case 'features': return featuresPanel();
      case 'prof': return proficienciesPanel();
      case 'background': return backgroundPanel();
      case 'notes': return notesPanel();
      default: return skillsPanel();
    }
  }
  function playerPage(tabs) {
    root.style.removeProperty('--ph-top-h');
    if (ui.page === 'more') return h('div.ph-app-page', playerMore());
    const tab = tabs.find((t) => t.primaryPage && t.id === ui.page);
    const cls = ui.page === 'combat' ? 'ph-view-combat tp-combat' : ui.page === 'maps' ? 'ph-view-maps' : 'ph-view-messages tp-msg';
    return h('div.ph-app-page', { class: `ph-app-page ${cls}` }, tab?.render());
  }

  function phoneBody() {
    const list = phoneSections();
    if (!list.some((t) => t.id === ui.ptab)) ui.ptab = 'skills';
    const nav = h('nav.ph-secs', { 'aria-label': 'Sheet sections' }, list.map((t) => h('button', {
      type: 'button', 'aria-current': ui.ptab === t.id ? 'page' : null, 'data-sec': t.id,
      onclick: () => {
        chooseSheetSection(t.id);
        // Keep the tab bar where it is; when scrolled into a long section, jump to the new section's top.
        const info = root.querySelector('.ph-info');
        const topH = root.querySelector('.ph-top')?.offsetHeight || 0;
        const y = info ? info.getBoundingClientRect().bottom + window.scrollY - topH : 0;
        draw(true);
        if (window.scrollY > y) window.scrollTo({ top: y });
      },
    }, t.label, t.count ? h('span.tab-n', String(t.count)) : null)));
    requestAnimationFrame(() => {
      const top = root.querySelector('.ph-top');
      if (top) root.style.setProperty('--ph-top-h', `${top.offsetHeight}px`); // section tabs stick under it
      const cur = root.querySelector('.ph-secs [aria-current]');
      const bar = cur?.parentElement;
      if (cur && bar) bar.scrollLeft = Math.max(0, cur.offsetLeft - (bar.clientWidth - cur.offsetWidth) / 2);
    });
    return [phoneTop(), phoneInfo(), nav, h('div.ph-panel.tab-panel', { class: `ph-panel tab-panel tp-${ui.ptab}` }, phoneSection(ui.ptab))];
  }

  function updatePlayerNav(tabs) {
    playerNav.hidden = gm;
    if (gm) return;
    for (const [id, { button, badge }] of dock) {
      if (ui.page === id) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
      const count = Number(tabs.find((t) => t.id === id)?.badge) || 0;
      const description = count && id === 'msg' ? `${count} unread message${count === 1 ? '' : 's'}`
        : count && id === 'combat' ? `${count} incoming attack${count === 1 ? '' : 's'}` : '';
      if (description) button.setAttribute('aria-description', description);
      else button.removeAttribute('aria-description');
      badge.hidden = !count;
      badge.textContent = count > 99 ? '99+' : count ? String(count) : '';
    }
  }

  function chooseSheetSection(id) {
    const phoneSection = { attacks: 'actions', gear: 'inventory', hotlist: 'inventory', story: 'background' }[id] || id;
    const desktopSection = { actions: 'attacks', background: 'story', features: 'story', notes: 'story', prof: 'skills' }[id] || id;
    const changed = phone() ? ui.ptab !== phoneSection : ui.tab !== desktopSection;
    ui.ptab = phoneSection;
    ui.tab = desktopSection;
    try {
      sessionStorage.setItem(`system.sheetPhoneTab.${mode}`, phoneSection);
      sessionStorage.setItem(`system.sheetTab.${mode}`, desktopSection);
    } catch { /* storage unavailable */ }
    return changed;
  }

  function setTab(id) {
    if (gm) { ui.tab = id; draw(true); return; }
    hideWhy();
    const extra = (extraTabs() || []).find((t) => t.id === id);
    if (extra && !extra.primaryPage) { openSecondary(extra); return; }
    const isPage = dock.has(id);
    const before = ui.page;
    const page = isPage ? id : 'sheet';
    const ph = phone();
    const changedSection = !isPage && chooseSheetSection(id);
    ui.page = page;
    if (before !== page || changedSection) draw(true);
    if (before !== page) onPlayerPage?.(page);
    if (isPage) window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    else if (ph) {
      const info = root.querySelector('.ph-info');
      const top = root.querySelector('.ph-top')?.offsetHeight || 0;
      if (info) window.scrollTo({ top: Math.max(0, window.scrollY + info.getBoundingClientRect().bottom - top), behavior: 'auto' });
    } else root.querySelector('.sh-tabs')?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }

  /* ---------- assemble ---------- */

  function draw(force = false) {
    if (!view || !player) return;
    M = sheetModel(view, player);
    const ph = !!phone();
    const extras = extraTabs() || [];
    updatePlayerNav(extras);
    const s = JSON.stringify([player, view.library ? 1 : 0, view.session?.permissions, ui, view.pack?.ruleset?.id, M.lib.item.length, M.lib.spell.length, extras.map((x) => [x.id, x.badge, x.sig]), ph, top ? view.audience?.viewers : 0]);
    if (!force && s === sig) return;
    const ae = document.activeElement;
    if (!force && ae?.matches?.('input, textarea, select') && (root.contains(ae) || ae.closest('.drawer'))) { pending = true; return; }
    sig = s;
    pending = false;
    const empty = !M.legacy && !M.sheet.identity?.race && !M.sheet.identity?.class && !(M.sheet.skills || []).length;
    root.classList.toggle('editing', ui.editing);
    root.classList.toggle('legacy', M.rs.legacy);
    root.classList.toggle('phone', ph);
    if ((!gm && ui.page !== 'sheet') || ph) {
      root.replaceChildren(...(!gm && ui.page !== 'sheet' ? [playerPage(extras)] : phoneBody()));
      if (ui.drawer?.kind === 'item') itemDrawer(ui.drawer.uid);
      return;
    }
    root.replaceChildren(...[
      header(),
      gearRequestBox(),
      empty && onBuilder && (gm || can('sheet')) ? h('div.callout', h('p', h('b', 'This sheet is empty.'), gm ? ' Walk through the builder with the player, or fill it in by hand.' : ' The builder takes you through it step by step.'), h('button.btn.btn-primary', { type: 'button', onclick: () => onBuilder(M, player) }, 'Open the builder')) : null,
      ui.editing ? identityEditor() : null,
      h('div.sh-top', tracks(), stats(), defense(), M.rs.legacy ? null : buffs()),
      h('div.sh-body',
        M.rs.legacy ? null : h('div.sh-col-skills', skillsPanel()),
        h('div.sh-col-main', tabs()),
      ),
      M.local && !M.rs.legacy ? h('p.foot-note', 'Numbers computed on this device: the host has not sent its own yet.') : null,
    ].filter(Boolean));
    if (ui.drawer?.kind === 'item') itemDrawer(ui.drawer.uid);
  }

  document.addEventListener('focusout', () => setTimeout(() => {
    const ae = document.activeElement;
    if (pending && !(ae?.matches?.('input, textarea, select') && (root.contains(ae) || ae.closest('.drawer')))) draw();
  }, 0));
  try { ui.tab = sessionStorage.getItem(`system.sheetTab.${mode}`) || null; } catch {}
  try { ui.ptab = sessionStorage.getItem(`system.sheetPhoneTab.${mode}`) || 'skills'; } catch {}

  return {
    el: root,
    playerNav,
    update(v, p) {
      const switched = player && p && player.id !== p.id;
      view = v; player = p;
      if (switched) { ui.openSkill = null; ui.drawer = null; ui.page = 'sheet'; }
      draw(switched);
    },
    redraw: () => draw(true),
    model: () => M,
    setTab,
    currentPage: () => gm ? ui.tab : ui.page,
    setEditing(on) { ui.editing = !!on; draw(true); },
    castReadySpell(uid) {
      const spell = M.sheet.spells.find((s) => s.uid === uid);
      if (spell) cast(spell, spell, spellCost(spell, spell));
    },
    useReadyItem,
    choosePotionRecipient,
    act,
  };
}

/* Items the GM just gave (playtest 26 Nov): the phone marks them NEW until opened. Per device, best effort. */
const NEW_KEY = (pid) => `system.newItems.${pid}`;
function newItemList(pid) { try { const v = JSON.parse(localStorage.getItem(NEW_KEY(pid))); return Array.isArray(v) ? v : []; } catch { return []; } }
export function markNewItem(pid, uid) { if (!pid || !uid) return; try { localStorage.setItem(NEW_KEY(pid), JSON.stringify([...new Set([...newItemList(pid), uid])].slice(-30))); } catch {} }
function isNewItem(pid, uid) { return !!pid && newItemList(pid).includes(uid); }
function newItemSeen(pid, uid) { if (!pid) return; try { localStorage.setItem(NEW_KEY(pid), JSON.stringify(newItemList(pid).filter((x) => x !== uid))); } catch {} }
