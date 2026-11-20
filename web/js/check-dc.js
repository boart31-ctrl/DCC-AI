export const CHECK_DC_TYPES = [['stat', 'Stat'], ['unopposed', 'Unopposed'], ['opposed', 'Opposed'], ['fixed', 'Fixed']];
const PF2E_DCS = [13, 14, 15, 16, 18, 19, 20, 22, 23, 24, 26, 27, 28, 30, 31, 32, 34, 35, 36, 38, 39, 40, 42, 44, 46, 48, 50];
const DND_DCS = ['Very easy', 'Easy', 'Medium', 'Hard', 'Very hard', 'Nearly impossible'];

export const checkFamily = (ruleset) => ruleset?.system?.family ?? 'crawler';

export function checkDCPresets(ruleset) {
  const family = checkFamily(ruleset);
  if (family === 'dnd') return DND_DCS.map((label, i) => ({ label, dc: 5 * (i + 1) }));
  if (family === 'pf2e') return PF2E_DCS.map((dc, i) => ({ label: `Level ${i - 1}`, dc }));
  return [];
}

/** Resolve the scene's stored DC rule on the current floor. A positive adjustment raises difficulty. */
export function checkDC(row, ruleset, { floor = 1, adjustment = 0 } = {}) {
  const crawler = checkFamily(ruleset) === 'crawler';
  const type = crawler ? row?.dcType : 'fixed';
  let dc;
  if (type === 'stat') dc = 10 + floor;
  if (type === 'unopposed') dc = 10 + 2 * floor;
  if (type === 'opposed') dc = 10 + (row.mod ?? 0) + floor;
  if (type === 'fixed') dc = row.dc;
  return Number.isInteger(dc) && Number.isInteger(adjustment) ? dc + adjustment : null;
}
