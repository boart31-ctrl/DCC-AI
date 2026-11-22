// "What now?" (B2): from the GM view, the one next step at the table + up to 3 smaller waiting items.
// Pure (no DOM), so it is unit-tested in server/test/whatnow.test.js.
//   whatNow(view, { unread }) → { main: { text, hint?, go?, act? }, more: [{ text, go?, act? }] }
//   go = a desk view to open ('combat', 'prep', 'party', 'messages'); act = a safe GM action to send.

const names = (xs) => {
  const list = [...new Set(xs.filter(Boolean))];
  return list.length > 3 ? `${list.slice(0, 3).join(', ')} +${list.length - 3}` : list.join(', ');
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function fightStep(v) {
  const c = v.combat;
  const rx = c.rx;
  const who = new Map((c.combatants ?? []).map((x) => [x.uid, x.name]));
  if (!rx) return { text: `Fight · round ${c.round || 1}`, hint: 'Run the turn in Fight.', go: 'combat' };
  const r = `Round ${rx.round}`;
  const decls = rx.decls ?? [];
  const open = decls.filter((d) => !d.result);
  switch (rx.step) {
    case 'declare':
      if (!decls.length) return { text: `${r} · announce the mob attacks`, hint: 'Suggest splits them over the crawlers in reach.', go: 'combat', act: { t: 'rx.suggest' }, label: 'Suggest' };
      return { text: `${r} · ${plural(decls.length, 'attack')} ready to announce`, hint: 'Announcing shows them on the TV and phones; then crawlers react.', go: 'combat', act: { t: 'rx.step', to: 'react' }, label: 'Announce attacks' };
    case 'react': {
      const waiting = decls.filter((d) => !d.evade && d.canEvade).map((d) => who.get(d.targetUid));
      if (waiting.length) return { text: `${r} · waiting for Evade: ${names(waiting)}`, hint: 'Their phones show the attacks. Resolve anyway in Fight.', go: 'combat' };
      return { text: `${r} · reactions are in`, hint: 'Next: resolve the hits one by one.', go: 'combat', act: { t: 'rx.step', to: 'resolve' }, label: 'Resolve hits' };
    }
    case 'resolve':
      if (open.length) {
        const d = open[0];
        return { text: `${r} · resolve next hit (${open.length} left): ${d.mob} → ${who.get(d.targetUid) ?? '?'}`, hint: 'Preview, then Apply / Change / Redirect / Skip.', go: 'combat' };
      }
      return { text: `${r} · all hits resolved`, hint: 'Next: crawlers act.', go: 'combat', act: { t: 'rx.step', to: 'act' }, label: 'Crawlers act' };
    case 'act': {
      const acts = rx.acts ?? {};
      const crawlers = (c.combatants ?? []).filter((x) => x.type !== 'mob' && !x.down && !x.dead);
      const left = crawlers.filter((x) => (acts[x.uid]?.left ?? acts[x.uid] ?? 2) > 0).map((x) => x.name);
      return { text: left.length ? `${r} · crawlers act: ${names(left)}` : `${r} · crawlers are done`, hint: 'Then clean up the round.', go: 'combat', act: { t: 'rx.step', to: 'cleanup' }, label: 'Clean up' };
    }
    case 'cleanup':
      return { text: `${r} · clean up`, hint: 'Debuffs, Dying countdown, actions reset → next round.', go: 'combat', act: { t: 'rx.round' }, label: `Round ${rx.round + 1}` };
    default:
      return { text: `${r} · ${rx.step}`, go: 'combat' };
  }
}

function prepNext(v) {
  const prep = v.gm?.prep;
  const doc = prep?.docs?.find((d) => d.id === prep.current);
  const scenes = doc?.evening?.scenes ?? [];
  if (!doc || !scenes.length) return null;
  const active = scenes.find((s) => s.id === doc.evening.activeSceneId);
  const next = scenes.find((s) => !s.played && s.id !== active?.id);
  if (active && !active.played) return { text: `Scene · ${active.title}`, hint: next ? `Then: ${next.title}` : 'Last scene tonight.', go: 'prep' };
  if (next) return { text: `Next scene · ${next.title}`, hint: `${doc.title ?? 'Tonight'}: ${scenes.filter((s) => s.played).length}/${scenes.length} played.`, go: 'prep', act: { t: 'prep.scene.run', id: doc.id, sceneId: next.id }, label: 'Run scene' };
  return { text: `${doc.title ?? 'Tonight'} · all scenes played`, hint: 'Wrap up: loot, level-up, recap.', go: 'prep' };
}

export function whatNow(v, { unread = 0 } = {}) {
  const more = [];
  const gm = v?.gm ?? {};
  // The System noticed an achievement moment: one tap awards it (Loot & Rewards has Later / Never).
  for (const sg of (gm.achSuggestions ?? []).slice(-2).reverse()) more.push({ text: `🏆 ${sg.title} → ${sg.name}?`, act: { t: 'ach.suggest.award', id: sg.id } });
  for (const p of gm.playersFull ?? []) {
    const req = p.sheet?.gearRequest ?? [];
    if (req.length) more.push({ text: `${p.name} asks for ${plural(req.length, 'item')}`, go: 'party' });
  }
  const playerName = new Map((v?.players ?? []).map((p) => [p.id, p.name]));
  const checks = (gm.prepChecks ?? []).filter((q) => !q.closed).flatMap((q) => (q.recipients ?? []).filter((r) => !r.result).map((r) => ({ q, r })));
  if (checks.length) more.push({ text: `Waiting for ${checks[0].q.ability ?? 'a'} check: ${names(checks.map((x) => x.r.name ?? playerName.get(x.r.playerId)))}`, go: 'prep' });
  if (gm.advancementClock?.due) more.push({ text: '2 h of play: level-up?', go: 'party' });
  if (unread) more.push({ text: plural(unread, 'unread message'), go: 'messages' });
  if (gm.pendingAuto?.length) more.push({ text: `${plural(gm.pendingAuto.length, 'System line')} waiting for your OK`, go: 'combat' });

  let main;
  if (v?.session?.hold) main = { text: 'Paused (Panic Hold)', hint: 'Nothing moves on the TV until you resume.', act: { t: 'session.hold', on: false }, label: 'Resume' };
  else if (v?.combat?.active) main = fightStep(v);
  else main = prepNext(v)
    ?? (!(v?.players ?? []).length ? { text: 'Add your players', hint: 'They join with the QR code on the TV.', go: 'party', label: 'Party' }
      : { text: 'Plan tonight', hint: 'Prep → pick a neighbourhood → Plan evening.', go: 'prep', label: 'Go to Prep' });
  return { main, more: more.slice(0, 3) };
}
