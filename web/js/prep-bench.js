// Encounter strength per game family, from the live party (pure: no DOM, imported by the Node tests too).
//
// benchmark(family, party, mobs) → { level: 0..3, label, detail, units }
//   party  [{ level }]          the characters in the campaign (any count: never assumes 4)
//   mobs   [{ level?, cr?, role?, count? }]  role 'boss' | 'elite' | 'minion' | 'standard'
//
// crawler: Table 3 in the GM Campaign Toolkit gives the reference counts for standard mobs.
//          The app estimates equivalent strength including extra boss/elite actions and weaker minions.
// dnd:     Lazy Encounter Benchmark — may be deadly when Σ CR > Σ levels / 4 (/ 2 when the average level > 4).
// pf2e:    XP budget by creature level relative to the party level, budget scaled for party size.
export const LEVELS = ['Weak', 'Moderate', 'Strong', 'Overwhelming'];
const PF2E_XP = { '-4': 10, '-3': 15, '-2': 20, '-1': 30, 0: 40, 1: 60, 2: 80, 3: 120, 4: 160 };
const PF2E_BUDGET = [[40, 10], [60, 15], [80, 20], [120, 30], [160, 40]]; // trivial, low, moderate, severe, extreme: [base for 4, per extra PC]

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const countOf = (m) => Math.max(1, Math.round(num(m.count, 1)));

function crawlerUnits(mobs, size) {
  let units = 0;
  for (const m of mobs) {
    const per = m.role === 'boss' || m.role === 'elite' ? size : m.role === 'minion' ? 0.5 : 1;
    units += per * countOf(m);
  }
  return units;
}

export function benchmark(family, party, mobs) {
  const size = Math.max(1, (party || []).length);
  const list = (mobs || []).filter(Boolean);
  if (!list.length) return { level: -1, label: 'Empty', detail: 'No monsters yet.', units: 0 };
  if (family === 'dnd') {
    const sumCr = list.reduce((a, m) => a + num(m.cr ?? m.level, 0) * countOf(m), 0);
    const levels = (party || []).reduce((a, p) => a + Math.max(1, num(p.level, 1)), 0) || size;
    const avg = levels / size;
    const limit = levels / (avg > 4 ? 2 : 4);
    const r = limit ? sumCr / limit : 0;
    const level = r < 0.5 ? 0 : r < 1 ? 1 : r < 1.5 ? 2 : 3;
    return { level, label: ['Easy', 'Fair', 'May be deadly', 'Deadly'][level], detail: `CR ${round(sumCr)} vs benchmark ${round(limit)} (${size} characters, avg level ${round(avg)})`, units: sumCr };
  }
  if (family === 'pf2e') {
    const partyLevel = Math.round((party || []).reduce((a, p) => a + Math.max(1, num(p.level, 1)), 0) / size) || 1;
    let xp = 0;
    for (const m of list) {
      const d = Math.max(-4, Math.min(4, Math.round(num(m.level, partyLevel) - partyLevel)));
      xp += (num(m.level, partyLevel) - partyLevel < -4 ? 0 : PF2E_XP[d]) * countOf(m);
    }
    const budgets = PF2E_BUDGET.map(([b, per]) => b + per * (size - 4));
    const names = ['Trivial', 'Low', 'Moderate', 'Severe', 'Extreme'];
    let i = 0;
    while (i < budgets.length - 1 && xp > budgets[i]) i++;
    const level = [0, 0, 1, 2, 3][i];
    return { level, label: names[i], detail: `${xp} XP vs ${names[i].toLowerCase()} budget ${budgets[i]} (${size} characters, party level ${partyLevel})`, units: xp };
  }
  const units = crawlerUnits(list, size);
  const pct = units / size;
  const level = pct < 0.75 ? 0 : pct < 1.25 ? 1 : pct < 2 ? 2 : 3;
  const count = list.reduce((n, m) => n + countOf(m), 0);
  const reference = crawlerTable(size).map(({ label, mobs }, i) => `${label} ${mobs}${i === 3 ? '+' : ''}`).join(' · ');
  const weighted = units === count ? '' : ` (${round(units)} standard mob equivalents)`;
  const detail = `${count} mob${count === 1 ? '' : 's'}${weighted} vs ${size} crawler${size === 1 ? '' : 's'}. Toolkit counts for standard mobs: ${reference}.`;
  return { level, label: LEVELS[level], detail, units };
}

/** How many mobs make each strength step for this party (crawler family): for the GM cheat sheet. */
export function crawlerTable(size) {
  const n = Math.max(1, size);
  return [0.5, 1, 1.5, 2].map((ratio, i) => ({ label: LEVELS[i], mobs: Math.max(1, Math.round(n * ratio)), ratio }));
}

function round(v) {
  return Math.round(v * 10) / 10;
}
