import { h } from './client.js';

const TREND = {
  up: ['↗', 'Danger rising'],
  down: ['↘', 'Danger falling'],
  steady: ['→', 'Danger steady'],
};
const NO_ESTIMATE = {
  'no-party': 'Add crawlers for an estimate',
  'no-enemies': 'No standing enemies',
  'no-damage': 'No incoming damage estimated',
};

/** Compact danger indicator shared by the Fight header and Prep encounters. */
export function dangerBar(danger, { label = 'Fight danger' } = {}) {
  if (!danger) return null;
  const { level, rounds, visible = 0, hidden = 0 } = danger;
  const [arrow, direction] = TREND[danger.trend] ?? TREND.steady;
  const estimate = rounds === 0 ? 'A crawler is already down' : Number.isFinite(rounds)
    ? `≈ ${rounds} round${rounds === 1 ? '' : 's'} until the first crawler drops`
    : NO_ESTIMATE[danger.reason] ?? (visible + hidden ? 'No drop estimate' : 'No standing enemies');
  return h('section.cbt-danger', { 'aria-label': label, 'data-level': level },
    h('span.cbt-danger-meter', { 'aria-hidden': 'true' }, Array.from({ length: 4 }, (_, i) => h('i', { class: i <= level ? 'on' : null }))),
    h('strong.cbt-danger-band', danger.label),
    h('span.cbt-danger-trend', { role: 'img', 'aria-label': direction, title: direction }, arrow),
    h('span.cbt-danger-detail', estimate),
    h('span.cbt-danger-visible', `${visible} revealed`),
    hidden > 0 ? h('span.cbt-danger-hidden', `+${hidden} hidden`) : null);
}
