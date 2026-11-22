// GM loot box with the System's offers (C1, server/loot-advisor.js): pick a box tier (boss box or not), steer the
// crawler's build, see the floor budget, choose one of the offers per item, open the box. Re-roll at will.
import { h } from './client.js';

const BUILDS = { melee: 'Brawler', ranged: 'Sharpshooter', defense: 'Tank', stealth: 'Sneak', magic: 'Caster', social: 'Face', support: 'Medic', crafty: 'Tinkerer', boom: 'Boomer', pet: 'Pet master' };
const LEAN = [['0', 'No wild cards'], ['0.3', 'Wild card sometimes'], ['0.6', 'Wild card often']];

export function openLootAdvisor({ p, tier: preset, tiers, send, act, toast, openSheet, closeSheet, legacy }) {
  const boxTiers = tiers.filter((t) => t.id !== 'sponsor');
  let tier = boxTiers.some((t) => t.id === preset) ? preset : boxTiers[0]?.id;
  let boss = false;
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
      data.pity ? h('span.lootx-pity', 'Due a good one: no wild cards this time') : null);
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
            const ack = await act({ t: 'loot.box', playerId: p.id, tier, boss, itemIds: chosen }, `${p.name} opens the box.`);
            if (ack) { closeSheet(); (ack.result?.warnings ?? []).forEach((w, k) => setTimeout(() => toast(w, { ms: 6000 }), 600 * (k + 1))); }
          },
        }, `Open box (${chosen.length} item${chosen.length === 1 ? '' : 's'})`))].filter(Boolean));
  }

  openSheet(`Loot box for ${p.name}`, [root], 'var(--acid)');
  draw();
  load();
}
