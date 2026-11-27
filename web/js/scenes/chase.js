// Race / chase on the TV. Chase: one lane per runner on a track from "lost" (−4) through the start (0) to the
// quarry (+4); tokens slide by Ground after every leg, each with a badge of what just happened. Race: lanes show
// progress by placement points, leader furthest right, standings with per-leg places.
import { h, portraitTile, replay } from './common.js';

const DEG = { crit: 'Critical!', amazing: 'Amazing', success: 'Success', near: 'Near miss', fail: 'Fail', major: 'Major fail', critfail: 'Wipe-out' };
const sign = (n) => (n > 0 ? `+${n}` : String(n));

export default function chase(root, sc, env) {
  const title = h('h1.ch-title.show-type');
  const legInfo = h('p.ch-leg');
  const lanes = h('div.ch-lanes');
  const result = h('p.ch-result');
  root.append(h('header.ch-head', title, legInfo), lanes, result);
  let seen = null;

  function playerOf(r) { return env.view?.players?.find((p) => p.id === r.playerId) ?? null; }

  function update(s, view) {
    if (view) env.view = view;
    const d = s.data || {};
    const chaseMode = d.mode !== 'race';
    root.classList.toggle('ch-race', !chaseMode);
    title.dataset.i18nKey = 'chase';
    title.textContent = d.title || (chaseMode ? 'Chase' : 'Race');
    const total = d.legs?.length ?? 0;
    const next = d.legs?.[d.leg];
    legInfo.replaceChildren(...[
      d.done ? h('span', 'Finished') : h('span', `Leg ${Math.min(d.leg + 1, total)} / ${total}`),
      !d.done && next ? h('b', next.label) : null,
      !d.done && next?.hazard ? h('span.ch-hazard', next.hazard) : null].filter(Boolean));
    const last = d.last;
    const fresh = last && last.at !== seen;
    seen = last?.at ?? seen;
    const byRunner = new Map((last?.results ?? []).map((r) => [r.runnerId, r]));
    const n = d.runners?.length ?? 1;
    const legsDone = d.leg ?? 0;
    lanes.replaceChildren(...(d.runners ?? []).map((r) => {
      const res = byRunner.get(r.id);
      let x;
      if (chaseMode) x = r.caught ? 100 : ((Math.max(-4, Math.min(4, r.ground)) + 4) / 8) * 92;
      else {
        const pts = r.places.reduce((s, p) => s + (n + 1 - p), 0);
        x = total ? (pts / (n * total)) * 92 : 0;
      }
      const tok = h('div.ch-token', { style: `left:${x}%;${r.color ? `--c:${r.color}` : ''}` },
        r.npc ? h('div.ch-face.no-pic', h('span.pt-ini', r.name.slice(0, 2).toUpperCase())) : portraitTile('ch-face', playerOf(r), { name: r.name }),
        res ? h('span.ch-badge', { class: `ch-badge d-${res.degree ?? (res.place === 1 ? 'success' : 'near')}` },
          chaseMode ? (res.out ? DEG.critfail : `${DEG[res.degree] ?? ''} ${res.delta != null ? sign(res.delta) : ''}`) : `#${res.place} · ${res.total}`) : null);
      if (fresh && res && !env.reduced) replay(tok, 'moved');
      const status = r.out ? 'Out' : r.caught ? 'Caught it!' : chaseMode ? `Ground ${sign(r.ground)}` : `Places ${r.places.join(' · ') || '—'}`;
      return h('div.ch-lane', { class: `ch-lane${r.out ? ' out' : ''}${r.caught ? ' caught' : ''}` },
        h('div.ch-name', h('b', r.name), h('span', status)),
        h('div.ch-track', chaseMode ? [h('i.ch-start'), h('span.ch-lost', 'Lost')] : null, tok,
          chaseMode ? h('div.ch-quarry', d.quarry?.image ? h('img', { src: d.quarry.image, alt: '' }) : null, h('span', d.quarry?.name || 'Quarry')) : h('div.ch-finish', 'Finish')));
    }));
    if (d.done && d.result) {
      if (chaseMode) {
        const first = d.runners.find((r) => r.id === d.result.first);
        result.textContent = d.result.caught ? `${first?.name ?? 'Someone'} caught ${d.quarry?.name ?? 'it'}!` : `${d.quarry?.name ?? 'The quarry'} got away.`;
      } else {
        const winners = d.result.winners ?? [d.result.winner];
        const names = winners.map((id) => d.runners.find((r) => r.id === id)?.name).filter(Boolean);
        result.textContent = names.length
          ? `${names.join(' & ')} ${names.length > 1 ? 'tie' : 'wins'} (${d.result.scores?.[winners[0]]} points).`
          : 'No finishers.';
      }
      if (fresh && !env.reduced) replay(result, 'slam');
    } else result.textContent = legsDone === 0 ? 'Get ready…' : '';
  }
  update(sc, env.view);
  return { update };
}
