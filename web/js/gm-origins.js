import { h } from './client.js';

function details(origin) {
  return h('section', h('h3', origin.label), h('p', origin.note),
    origin.attribution && h('p', origin.attribution), origin.license && h('small', origin.license));
}

function show(title, content) {
  const dialog = h('dialog.sheet-dlg.tool', { 'aria-label': title },
    h('div.sheet-inner', h('header.sheet-head', h('h2', title),
      h('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Close')),
    h('div.sheet-body', content)));
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
}

export function originBadge(entry, origins) {
  const origin = origins?.[entry?.origin];
  if (!origin) return null;
  return h('button.btn.btn-sm.origin-badge', { type: 'button', onclick: () => show('Content origin', details(origin)) }, origin.label);
}

export function showCredits(origins) {
  show('Credits', [h('p', 'An unofficial fan tool. It is not affiliated with Wizards of the Coast, Renegade Game Studios or Matt Dinniman.'),
    ...Object.values(origins || {}).map(details)]);
}

export function originOptions(origins) {
  return [h('option', { value: '' }, 'All origins'), ...Object.entries(origins || {}).map(([value, origin]) =>
    h('option', { value }, origin.label))];
}
