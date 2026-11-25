// "Checking again" (crawler rulesets): after a Major or Critical Fail a crawler can't test that skill again in the
// same scene. A scene here = everything between two scene marks; the mark moves on `scene.new` (GM), when a
// prepared scene runs, when a fight ends, on a rest and after a grind. Locks are advice: the GM sees them on the
// Big roll form and the phone shows them on the skill; the Big roll refuses a locked crawler unless the GM allows it.
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const sceneMark = (st) => (Number.isInteger(st.session?.sceneMark) ? st.session.sceneMark : 0);

/** Next scene: every lock from the last one is gone. */
export function bumpScene(st) {
  st.session.sceneMark = sceneMark(st) + 1;
  for (const p of st.players ?? []) delete p.skillLocks;
}

export function lockSkill(st, p, skillId) {
  if (!p || typeof skillId !== 'string') return;
  const locks = isObj(p.skillLocks) && p.skillLocks.mark === sceneMark(st) ? p.skillLocks : { mark: sceneMark(st), ids: [] };
  if (!locks.ids.includes(skillId)) locks.ids = [...locks.ids, skillId].slice(-40);
  p.skillLocks = locks;
}

/** Skill ids this crawler can't test again in the current scene. */
export function lockedSkills(st, p) {
  const l = p?.skillLocks;
  return isObj(l) && l.mark === sceneMark(st) && Array.isArray(l.ids) ? l.ids.filter((x) => typeof x === 'string') : [];
}

export const SKILL_LOCK_GM = {
  /** New scene: skills locked by a Major / Critical Fail may be tried again. */
  'scene.new'(st) {
    bumpScene(st);
  },
};
