// Book stat block (GM only): Level, Surprise, Evade, Move, DR, the five stats, attacks as the book prints them.
// `rules` = the ruleset's combat block: mobBase + floorScaled turn engine numbers back into "12+F".
import { h } from './client.js';

const STAT_ORDER = ['str', 'int', 'con', 'dex', 'cha'];

/** "12+F" from an engine bonus (mob base 10 + bonus, plus the floor unless the block is flat). */
export function bookNumber(bonus, rules = {}, flat = false) {
  const n = (rules.mobBase || 0) + (Number(bonus) || 0);
  return rules.floorScaled && !flat ? `${n}+F` : String(n);
}

export function hasStatBlock(e) {
  return !!e && (e.level != null || e.surprise != null || e.stats || e.move || e.size);
}

export function statBlock(e, rules = {}) {
  if (!hasStatBlock(e)) return null;
  const F = rules.floorScaled && !e.flat ? '+F' : '';
  const top = [e.rank, e.size?.label, e.creature].filter(Boolean).join(' · ');
  const nums = [
    ['Level', e.level],
    ['Surprise', e.surprise != null ? `${e.surprise}${F}` : null],
    ['Evade', bookNumber(e.evade, rules, e.flat)],
    ['Move', e.move],
    ['DR', e.dr ?? 0],
  ].filter(([, v]) => v != null && v !== '');
  const stats = e.stats ? STAT_ORDER.filter((k) => e.stats[k]).map((k) => [k, e.stats[k]]) : [];
  const sv = e.slotValue || rules.mobSlotValue;
  const health = e.hpSlots ? `${e.hpSlots} ${sv ? `slots × ${sv} HP` : 'HP'}` : null;
  return h('div.statblock',
    top ? h('p.sb-top', top, health ? h('span.sb-hp', ` · Health ${health}`) : null) : null,
    h('dl.sb-nums', nums.map(([k, v]) => h('div', h('dt', k), h('dd', String(v))))),
    stats.length ? h('dl.sb-nums.sb-stats', stats.map(([k, v]) => h('div', h('dt', k[0].toUpperCase() + k.slice(1)), h('dd', `${v.score} (${v.mod >= 0 ? '+' : ''}${v.mod})`)))) : null,
    (e.attacks || []).length ? h('ul.sb-atks', e.attacks.map((a) => h('li',
      h('b', `${a.name}: `),
      `${bookNumber(a.toHit, rules, e.flat)} to hit`,
      a.damage ? `, ${a.damage}${a.dtype ? ` ${a.dtype}` : ''}` : ', no damage',
      a.range ? `, ${a.range} range` : '',
      a.area ? `, ${a.area}` : '',
      a.effects ? h('i.sb-fx', ` ${a.effects}`) : null))) : null,
    [e.immune?.length ? `Immune: ${e.immune.join(', ')}` : '', e.resist?.length ? `Resists: ${e.resist.join(', ')}` : '', e.vulnerable?.length ? `Vulnerable: ${e.vulnerable.join(', ')}` : ''].filter(Boolean).map((x) => h('p.sb-types', x)),
    e.ref ? h('p.sb-ref.dim', e.ref) : null);
}
