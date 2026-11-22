// GM loot box with the System's offers (C1, server/loot-advisor.js): pick a box tier (boss box or not), steer the
// crawler's build, see the floor budget, choose one of the offers per item, open the box. Re-roll at will.
import { h } from './client.js';

const BUILDS = { melee: 'Brawler', ranged: 'Sharpshooter', defense: 'Tank', stealth: 'Sneak', magic: 'Caster', social: 'Face', support: 'Medic', crafty: 'Tinkerer', boom: 'Boomer', pet: 'Pet master' };
const LEAN = [['0', 'No wild cards'], ['0.3', 'Wild card sometimes'], ['0.6', 'Wild card often']];

export function openLootAdvisor({ p, tier: preset, boss: presetBoss = false, pendingId = null, tiers, send, act, toast, openSheet, closeSheet, legacy }) {
  const boxTiers = tiers.filter((t) => t.id !== 'sponsor');
  let tier = boxTiers.some((t) => t.id === preset) ? preset : boxTiers[0]?.id;
  let boss = presetBoss;
  let data = null;
  let picks = [];
  let prefs = { builds: [...(p.lootPrefs?.builds ?? [])], lean: p.lootPrefs?.lean ?? 0.3 };
  const root = h('div.lootx');

  async function load() {
    root.classList.add('busy');
    try {
      const ack = await send({ t: 'loot.offers', playerId: p.id, tier, boss });
      data = ack?.result ?? ack;
      picks = data.slots.map((s) => s.offers[0]?.itemId ?? null);
    } catch (e) {
      data = { error: e.message };
    }
    root.classList.remove('busy');
    draw();
  }
  async function steer(next) {
    prefs = { ...prefs, ...next };
    try { await send({ t: 'loot.prefs', playerId: p.id, builds: prefs.builds, lean: prefs.lean }); } catch { /* shown on next load */ }
    load();
  }

  function draw() {
    const tierRow = h('div.lootx-row', h('span.lootx-k', 'Box'),
      ...boxTiers.map((t) => h('button.chip', { type: 'button', class: `chip${t.id === tier ? ' on' : ''}`, style: { '--t': t.color }, 'aria-pressed': String(t.id === tier), onclick: () => { tier = t.id; load(); } }, t.name || t.id)),
      h('label.lootx-boss', h('input', { type: 'checkbox', checked: boss, onchange: (e) => { boss = e.target.checked; load(); } }), 'Boss box (best item one step better)'));
    const buildRow = h('div.lootx-row', h('span.lootx-k', 'Steer'),
      ...Object.entries(BUILDS).map(([id, label]) => {
        const on = prefs.builds.includes(id);
        return h('button.chip', { type: 'button', class: `chip${on ? ' on' : ''}`, 'aria-pressed': String(on), title: on ? 'Stop steering this way' : 'Steer this crawler this way (max 3)',
          onclick: () => steer({ builds: on ? prefs.builds.filter((b) => b !== id) : [...prefs.builds, id].slice(-3) }) }, label);
      }),
      h('select.field.lootx-lean', { 'aria-label': 'Wild cards', onchange: (e) => steer({ lean: Number(e.target.value) }) },
        LEAN.map(([v, l]) => h('option', { value: v, selected: Math.abs(Number(v) - prefs.lean) < 0.05 }, l))));
    if (!data) { root.replaceChildren(tierRow, buildRow, h('p.dim', 'Asking the System…')); return; }
    if (data.error) { root.replaceChildren(tierRow, buildRow, h('p.lootx-err', data.error)); return; }
    const pct = Math.min(100, Math.round((data.budget.used / data.budget.cap) * 100));
    const meter = h('div.lootx-budget', { title: 'Equipped power vs what this floor can take. Consumables don\'t count.' },
      h('span', `Floor ${data.floor} power`), h('div.lootx-bar', h('i', { style: { width: `${pct}%` } })), h('b', `${data.budget.used} / ${data.budget.cap}`),
      data.build.top.length ? h('span.dim', `Build: ${data.build.top.map((b) => BUILDS[b] ?? b).join(', ')}`) : null,
      data.rating ? h('span', { class: `lp-ig g-${data.rating.grade}` }, data.rating.grade) : null,
      data.mode && data.mode !== 'standard' ? h('span.lootx-pity', data.mode === 'catchup' ? 'Catch-up: better items, no wild cards' : 'Ahead: upgrades and better consumables') : null,
      data.pity && data.mode !== 'catchup' ? h('span.lootx-pity', 'Due a good one: no wild cards this time') : null);
    const slots = data.slots.map((s, i) => h('fieldset.lootx-slot',
      h('legend', `Item ${i + 1}`),
      ...s.offers.map((o) => h('label.lootx-offer', { class: `lootx-offer r-${o.rarity}${picks[i] === o.itemId ? ' on' : ''}` },
        h('input', { type: 'radio', name: `slot${i}`, checked: picks[i] === o.itemId, onchange: () => { picks[i] = o.itemId; draw(); } }),
        o.image ? h('img', { src: o.image, alt: '', loading: 'lazy' }) : null,
        h('span.lootx-name', o.name),
        h('span.lootx-meta', `${o.rarity} · power ${o.power}`),
        h('span.lootx-why', o.wild ? h('b', 'Wild card') : o.why.join(' · ')),
        o.desc ? h('span.lootx-desc', o.desc) : null)),
      h('label.lootx-offer.lootx-skip', { class: `lootx-offer lootx-skip${picks[i] === null ? ' on' : ''}` },
        h('input', { type: 'radio', name: `slot${i}`, checked: picks[i] === null, onchange: () => { picks[i] = null; draw(); } }), 'Leave out')));
    const held = data.held.length ? h('details.lootx-held', h('summary', `${data.held.length} held back by the budget`),
      h('ul', data.held.map((x) => h('li', `${x.name}: ${x.reason}`)))) : null;
    const chosen = picks.filter(Boolean);
    root.replaceChildren(...[tierRow, buildRow, meter, h('div.lootx-slots', slots), held,
      h('div.lootx-go',
        h('button.btn', { type: 'button', onclick: load }, 'Re-roll offers'),
        legacy ? h('button.btn.btn-quiet', { type: 'button', onclick: legacy }, 'Old random box') : null,
        h('button.btn.btn-primary', {
          type: 'button', disabled: !chosen.length,
          onclick: async () => {
            const ack = await act({ t: 'loot.box', playerId: p.id, tier, boss, itemIds: chosen, ...(pendingId ? { pendingId } : {}) }, `${p.name} opens the box.`);
            if (ack) { closeSheet(); (ack.result?.warnings ?? []).forEach((w, k) => setTimeout(() => toast(w, { ms: 6000 }), 600 * (k + 1))); }
          },
        }, `Open box (${chosen.length} item${chosen.length === 1 ? '' : 's'})`))].filter(Boolean));
  }

  openSheet(`Loot box for ${p.name}`, [root], 'var(--acid)');
  draw();
  load();
}

// ---------- Loot & Rewards tab pieces (C1b): power card per crawler + campaign loot settings ----------

const MODES = [['auto', 'Auto'], ['catchup', 'Catch-up'], ['standard', 'Standard'], ['ahead', 'Ahead: consumables']];
const MODE_HINT = { catchup: 'Better items, no wild cards, budget +1', standard: 'Normal offers', ahead: 'Strong already: upgrades only, better consumables' };

/** The power card body for one crawler (rating, gear, mode, pending boxes). onOpenBox(pending) opens the advisor. */
export function lootPowerBlock(c, { send, act, onOpenBox, tierName }) {
  if (!c) return null;
  const r = c.rating;
  const pct = Math.min(100, Math.round((r.gear.used / r.gear.cap) * 100));
  return h('div.lp',
    h('div.lp-top',
      h('span.lp-grade', { class: `lp-grade g-${r.grade}`, title: `Power score ${r.score}/100: gear 55, build 25, level 20` }, r.grade),
      h('div.lp-nums',
        h('div.lp-bar', { title: 'Equipped power vs the floor budget (consumables free)' }, h('i', { style: { width: `${pct}%` } })),
        h('span', `Gear ${r.gear.used} / ${r.gear.cap} · build ${Math.round(r.coherence * 100)}% · Lv ${r.level.level} (≈${r.level.expected} expected) · score ${r.score}`)),
      h('select.field.lp-mode', { 'aria-label': 'Reward mode', title: MODE_HINT[c.mode] ?? '',
        onchange: (e) => act({ t: 'loot.prefs', playerId: c.playerId, mode: e.target.value }) },
        MODES.map(([v, l]) => h('option', { value: v, selected: v === c.modeSetting }, v === 'auto' ? `Auto (${MODES.find((m) => m[0] === c.mode)?.[1] ?? c.mode})` : l)))),
    c.pendingBoxes.length ? h('div.lp-pending', ...c.pendingBoxes.map((b) => h('button.btn.btn-sm.btn-primary', { type: 'button', title: `From ${b.from}`, onclick: () => onOpenBox(b) },
      `Open ${tierName(b.tier)}${b.boss ? ' (Boss)' : ''}`))) : null,
    r.items.length ? h('ul.lp-items', r.items.map((it) => h('li', { class: it.onBuild ? 'on' : '' },
      h('span.lp-ig', { class: `lp-ig g-${it.grade}` }, it.grade), h('span', it.name), it.fragile ? h('span.dim', ' (fragile)') : null, h('span.dim', ` · ${it.power}`))))
      : h('p.dim.lp-none', 'Nothing equipped yet.'));
}

/** Campaign loot settings: budget per floor, wild cards, drops on/off. */
export function lootSettingsPanel(loot, { act }) {
  const s = loot.settings ?? {};
  const pol = loot.policy;
  const budget = h('input.field', { type: 'text', value: pol.budget.slice(0, 6).join(', '), 'aria-label': 'Budget per floor', size: 18 });
  const save = () => {
    const list = budget.value.split(/[,\s]+/).map(Number).filter((x) => Number.isFinite(x) && x > 0);
    if (list.length) act({ t: 'loot.settings', settings: { budget: list } }, 'Budget saved.');
  };
  return h('details.panel.lp-settings', h('summary', h('b', 'Loot rules for this campaign'), h('span.dim', ` · Floor ${loot.floor}: budget ${pol.budget[loot.floor - 1] ?? pol.budget.at(-1)} (+${pol.stretch} boss / catch-up) · wild cards ${Math.round(pol.wildcard * 100)}% · mob drops ${s.dropsOff ? 'off' : 'on'}`)),
    h('div.lp-set',
      h('label', 'Power budget per floor (F1, F2, …)', budget, h('button.btn.btn-sm', { type: 'button', onclick: save }, 'Save')),
      h('label', 'Wild cards', h('select.field', { onchange: (e) => act({ t: 'loot.settings', settings: { wildcard: Number(e.target.value) } }) },
        [[0, 'None'], [0.15, 'Rare'], [0.3, 'Sometimes'], [0.5, 'Often']].map(([v, l]) => h('option', { value: v, selected: Math.abs(v - pol.wildcard) < 0.03 }, l)))),
      h('label', 'Mob drops', h('select.field', { onchange: (e) => act({ t: 'loot.settings', settings: { dropsOff: e.target.value === 'off' } }) },
        h('option', { value: 'on', selected: !s.dropsOff }, 'On (pack odds)'), h('option', { value: 'off', selected: !!s.dropsOff }, 'Off'))),
      h('p.dim', `Ordinary mob drop odds: ${Object.entries(pol.drops?.mob ?? {}).map(([k, n]) => `${k} ${n}`).join(' · ')}. Elite: ${Object.entries(pol.drops?.elite ?? {}).map(([k, n]) => `${k} ${n}`).join(' · ')}.`),
      Object.keys(s).length ? h('button.btn.btn-quiet.btn-sm', { type: 'button', onclick: () => act({ t: 'loot.settings', settings: null }, 'Back to the pack defaults.') }, 'Reset to pack defaults') : null));
}
