import { danger } from './danger.js';
import { libraryOf, libGet } from './rules.js';

export function mobsOf(view, payload) {
  const lib = libraryOf(view);
  return (payload?.mobs ?? []).map((m) => {
    const kind = m.kind ?? 'monster';
    return { ...m, kind, e: libGet(lib, kind, m.sourceId) };
  });
}

/** Estimate a fresh encounter against the party's current state on this floor. */
export function prepDanger(view, payload) {
  const { dangerParty: party, dangerRules: rules, dangerFloor: floor } = view?.combat ?? {};
  if (!rules || !Array.isArray(party)) return null;
  const mobs = mobsOf(view, payload).filter(({ e }) => e).map(({ e, kind, count, hidden }) => ({
    role: kind === 'boss' ? 'boss' : e.role ?? 'standard',
    count: count ?? 1,
    hidden: hidden !== false,
    hp: e.hpSlots ?? 5,
    hpMax: e.hpSlots ?? 5,
    slotValue: e.slotValue,
    level: e.level,
    cr: e.cr,
    flat: e.flat,
    attacks: e.attacks,
  }));
  return danger({ family: rules.family, rules, floor, party, mobs });
}
