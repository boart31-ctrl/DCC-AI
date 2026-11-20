// The private player journal keeps a short undo buffer. Views expose only five live entries to their owner.
const KEEP = 24;
const DISPLAY = 5;
const KINDS = ['incoming', 'attack', 'evade', 'action', 'heal'];
const ID = /^[A-Za-z0-9_:-]{1,160}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clipped = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';

function cleanEntry(row) {
  if (!isObj(row) || typeof row.id !== 'string' || !ID.test(row.id) || !KINDS.includes(row.kind) || typeof row.label !== 'string' || !row.label) return null;
  const { id, kind } = row;
  const result = { id, kind, label: clipped(row.label, 180), round: Number.isInteger(row.round) ? Math.max(0, row.round) : 0,
    phase: clipped(row.phase, 80), at: Number.isFinite(row.at) ? row.at : 0 };
  if (row.detail) result.detail = clipped(row.detail, 240);
  if (row.result) result.result = clipped(row.result, 60);
  for (const key of ['total', 'die', 'amount']) if (Number.isFinite(row[key])) result[key] = row[key];
  return result;
}

export function normalizeCombatHistory(raw) {
  if (!isObj(raw) || typeof raw.combatId !== 'string' || !ID.test(raw.combatId)) return { combatId: null, players: {} };
  const players = Object.fromEntries(Object.entries(isObj(raw.players) ? raw.players : {}).slice(0, 50)
    .filter(([id, rows]) => ID.test(id) && Array.isArray(rows)).map(([id, rows]) => [id, rows.slice(0, KEEP).flatMap((row) => {
      const clean = cleanEntry(row);
      return clean ? [{ ...clean, ...(row.undone === true ? { undone: true } : {}) }] : [];
    })]));
  return { combatId: raw.combatId, players };
}

export function combatHistoryFor(st, playerId) {
  const players = st.combatHistory?.players;
  if (!players || !Object.hasOwn(players, playerId)) return [];
  return players[playerId].filter((x) => !x.undone).slice(0, DISPLAY).map(cleanEntry).filter(Boolean);
}

const EVADE_LABELS = {
  crit: 'Critical success', amazing: 'Amazing success', success: 'Success', near: 'Near miss',
  fail: 'Failed', major: 'Major fail', critfail: 'Critical fail',
};
const REACTIONS = { catcher: 'Took an attack for an ally', taunt: 'Taunted an attacker', intervene: 'Prepared to help an ally' };
const AUTO = ['combat.auto', 'combat.autoStep', 'combat.autoConfirm', 'combat.mobAct'];
const ACTIONS = new Set([...AUTO, 'combat.autoUndo', 'combat.undo', 'rx.resolveNext', 'rx.spend', 'rx.favor']);
const EVENTS = new Set(['rx.evade', 'rx.hit', 'rx.undo', 'rx.interrupt', 'combat.hit', 'combat.heal', 'spell', 'itemUse', 'roll', 'roll.void', 'roll.restore', 'rollUpdate']);
const rollKey = (r) => `roll:${r.weaponHitId ?? r.spellHitId ?? r.id}`;
const autoKey = (id, step) => `auto:${id}:${step.i}`;

function findReaction(st, id) {
  const d = st.combat?.rx?.decls.find((x) => x.id === id);
  const mob = d && st.combat.combatants.find((x) => x.uid === d.mobUid);
  const seen = mob && !mob.hidden;
  return { d, source: seen ? mob.name : 'Unseen attacker', attack: seen ? d.attack.name : 'Attack' };
}

function healthText(amount, units, verb) {
  return `${amount} ${units}${amount === 1 ? '' : units === 'HP' ? '' : 's'} ${verb}`;
}

/** Fold committed outcomes into the journal once per reducer action, never from previews. */
export function recordCombatHistory(before, st, action, out, ctx) {
  const c = st.combat, old = before.combat;
  if (action.t === 'session.new' || (c.active && (!old?.active || old.id !== c.id))) {
    st.combatHistory = { combatId: c.active ? c.id : null, players: {} };
  }
  const fight = c.active ? c : old?.active ? old : null;
  if (!fight?.id) return;
  const events = out.events.filter(({ event }) => EVENTS.has(event.kind));
  if (!events.length && !ACTIONS.has(action.t)) return;
  const history = st.combatHistory ??= { combatId: fight.id, players: {} };
  if (history.combatId !== fight.id) { history.combatId = fight.id; history.players = {}; }
  const stamp = { at: ctx.now, round: action.t === 'rx.round' ? old.round : fight.round,
    phase: action.t === 'rx.round' ? 'cleanup' : fight.rx?.step ?? fight.phases[fight.phaseIndex] ?? '' };
  const track = ctx.pack.ruleset.tracks.find((t) => t.id === 'hp') ?? ctx.pack.ruleset.tracks[0];
  const units = track?.kind === 'slots' ? 'health slot' : 'HP';
  const member = (uid) => fight.combatants.find((x) => x.uid === uid && x.type === 'crawler')?.playerId;
  const ownRows = (id) => Object.hasOwn(history.players, id) ? history.players[id] : [];
  const put = (pid, id, row, keepPosition = false) => {
    if (!pid || !fight.combatants.some((x) => x.playerId === pid)) return;
    const clean = cleanEntry({ id, ...stamp, ...row });
    if (!clean) return;
    const rows = ownRows(pid);
    const next = keepPosition ? rows.map((item) => item.id === id ? clean : item) : [clean, ...rows.filter((item) => item.id !== id)].slice(0, KEEP);
    Object.defineProperty(history.players, pid, { value: next, enumerable: true, configurable: true, writable: true });
  };
  const erase = (pid, id) => {
    const previous = ownRows(pid).find((x) => x.id === id);
    if (previous) previous.undone = true;
    return previous;
  };
  const recordEvade = (pid, id, row) => {
    const { d, source, attack } = findReaction(st, id);
    if (!d?.evade) return;
    put(pid, `rx:${id}`, { ...row, kind: 'evade', label: `Evade: ${source}`, detail: `${attack} · ${EVADE_LABELS[d.evade.degree] || 'Evade rolled'}`,
      result: d.evade.degree, die: d.evade.die });
  };
  const writeRoll = (rec, update) => {
    const pid = rec?.playerId;
    if (!pid || !['attack', 'spell'].includes(rec.what)) return;
    const id = rollKey(rec);
    const existing = ownRows(pid).find((r) => r.id === id);
    if (update && !existing) return;
    const linked = st.rolls.findLast((r) => !r.void && rollKey(r) === id && r.playerId === pid && (!r.secret || r.by === pid));
    if (!linked) { erase(pid, id); return; }
    const hit = linked.part === 'damage' ? st.rolls.find((r) => r.id === (linked.weaponHitId ?? linked.spellHitId) && (!r.secret || r.by === pid)) : linked;
    const outcome = linked.vs?.damage !== undefined ? 'damage' : hit?.vs?.hit === true ? 'hit' : hit?.vs?.hit === false ? 'miss' : 'rolled';
    const label = hit?.label ?? linked.label;
    const name = linked.vs?.name ?? hit?.vs?.name;
    const damage = linked.vs?.damage;
    const detail = outcome === 'damage' ? (damage === 0 ? 'No damage' : `${damage} damage dealt`) : outcome === 'hit' ? 'Hit' : outcome === 'miss' ? 'Miss' : 'Rolled';
    put(pid, id, { ...(update && existing ? { at: existing.at, round: existing.round, phase: existing.phase } : {}),
      kind: 'attack', label, detail: [name, detail].filter(Boolean).join(' · '), result: outcome, total: linked.total, die: hit?.natural, amount: damage }, update);
  };

  if (AUTO.includes(action.t) && !out.result?.dryRun) {
    const publicRun = out.events.some(({ event, to }) => event.kind === 'combat.auto' && to?.roles?.includes('player'));
    for (const step of out.result?.sequence ?? []) {
      if (step.skipped || !step.playerId) continue;
      const amount = Math.max(0, (step.hpBefore ?? 0) - (step.hpAfter ?? 0));
      if (!publicRun && !amount && step.dyingBefore === step.dyingAfter && step.deadBefore === step.deadAfter) continue;
      const source = step.hidden ? 'Unseen attacker' : step.mob;
      const attack = publicRun && !step.hidden ? step.attack : '';
      const detail = step.hit ? healthText(amount, units, 'lost') : 'Missed';
      put(step.playerId, autoKey(out.result.autoId, step), { kind: 'incoming', label: publicRun ? source : 'Damage taken',
        detail: [attack, detail].filter(Boolean).join(' · '), amount, result: step.hit ? 'hit' : 'miss' });
    }
  }
  if (action.t === 'combat.autoUndo') {
    const entry = old.autoUndo?.at(-1);
    if (entry) erase(entry.step.playerId, autoKey(entry.id, entry.step));
    else for (const rows of Object.values(history.players)) for (const row of rows) if (row.id.startsWith(`auto:${out.result?.autoId}:`)) row.undone = true;
  }
  if (action.t === 'combat.undo') {
    const entry = old.manualUndo?.at(-1);
    if (entry?.snap.crawler) erase(entry.snap.crawler.playerId, `manual:${entry.id}`);
  }
  if (action.t === 'rx.resolveNext' && action.op === 'skip') {
    const id = old.rx?.pending?.declId;
    const { d, source, attack } = findReaction(st, id);
    if (d?.result === 'skipped') put(member(d.targetUid), `rx:${id}`, { kind: 'incoming', label: source, detail: `${attack} · Skipped`, result: 'skipped', amount: 0, die: d.evade?.die });
  }
  if (action.t === 'rx.spend' && action.role === 'player') {
    const amount = action.n === 2 ? 2 : 1;
    put(ctx.actor.playerId, `action:${ctx.genId('ch')}`, { kind: 'action', label: `Spent ${amount} action${amount === 1 ? '' : 's'}`, amount });
  }
  if (action.t === 'rx.favor') {
    const pid = action.role === 'player' ? ctx.actor.playerId : member(action.uid);
    put(pid, `action:${ctx.genId('ch')}`, { kind: 'action', label: 'Spent Favor', detail: 'Gained a non-attack action' });
  }

  const startHp = new Map(before.players.map((p) => [p.id, p.sheet?.tracks?.[track?.id]?.cur]));
  const seenRolls = new Set();
  for (const { event: e } of events) {
    if (e.kind === 'rx.evade') recordEvade(member(e.uid), e.declId);
    else if (e.kind === 'rx.hit') {
      const pid = member(e.targetUid);
      const amount = Math.max(0, e.slots ?? 0);
      const { d, source, attack } = findReaction(st, e.declId);
      const detail = e.result === 'evaded' ? 'Evaded' : healthText(amount, units, 'lost');
      put(pid, `rx:${e.declId}`, { kind: 'incoming', label: source, detail: [attack, detail, e.danger === 'dying' ? 'Dying' : e.danger === 'dead' ? 'Died' : ''].filter(Boolean).join(' · '),
        result: e.result, amount, die: d?.evade?.die });
    } else if (e.kind === 'rx.undo') {
      const pid = member(e.targetUid);
      const row = erase(pid, `rx:${e.declId}`);
      const { d } = findReaction(st, e.declId);
      if (row && d?.targetUid === e.targetUid && d.evade) recordEvade(pid, e.declId, { round: row.round, phase: 'react' });
    } else if (e.kind === 'rx.interrupt' && REACTIONS[e.what]) {
      put(member(e.uid), e.id, { kind: 'action', label: REACTIONS[e.what],
        ...(e.what === 'taunt' ? { detail: out.result?.ok ? 'Attack redirected' : 'The target stayed the same' } : {}) });
    } else if (e.kind === 'combat.hit' || e.kind === 'combat.heal') {
      if (e.type !== 'crawler') continue;
      const beforeHp = startHp.get(e.playerId);
      startHp.set(e.playerId, e.hp);
      if (e.animation === 'reaction') continue;
      const heal = e.kind === 'combat.heal';
      const amount = Number.isFinite(beforeHp) ? Math.abs(e.hp - beforeHp) : e.amount;
      const fromManual = action.t === (heal ? 'combat.heal' : 'combat.damage');
      const key = fromManual ? c.manualUndo?.at(-1)?.id : null;
      put(e.playerId, key ? `manual:${key}` : e.id, { kind: heal ? 'heal' : 'incoming', label: heal ? 'Healed' : 'Damage taken',
        detail: healthText(amount, units, heal ? 'restored' : 'lost'), amount, result: heal ? 'healed' : 'hit' });
    } else if (e.kind === 'spell' || e.kind === 'itemUse') {
      const health = e.healed?.track === track?.id ? e.healed : null;
      const amount = health ? Math.max(0, health.to - health.from) : undefined;
      put(e.playerId, e.id, { kind: health && health.playerId === e.playerId ? 'heal' : 'action', label: `${e.kind === 'spell' ? 'Cast' : 'Used'} ${e.name}`,
        ...(health ? { detail: healthText(amount, units, 'restored'), amount } : {}) });
      if (health && health.playerId !== e.playerId) put(health.playerId, e.id, { kind: 'heal', label: 'Healed', detail: healthText(amount, units, 'restored'), amount });
    } else if (['roll', 'roll.void', 'roll.restore', 'rollUpdate'].includes(e.kind)) {
      const id = e.rollId ?? e.id;
      if (seenRolls.has(id)) continue;
      seenRolls.add(id);
      const rec = st.rolls.find((r) => r.id === id);
      if (rec && (!rec.secret || rec.by === rec.playerId)) writeRoll(rec, e.kind !== 'roll');
    }
  }
}
