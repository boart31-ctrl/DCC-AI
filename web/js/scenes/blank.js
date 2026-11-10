// Blank / attract loop: the logo breathing on an empty studio. One slow glint, nothing else.
import { h } from './common.js';

export default function blank(root, sc, env) {
  const logo = h('div.bl-logo', { 'data-text': '' });
  const text = h('p.bl-text');
  root.append(h('div.bl-wrap', h('span.bl-mark', { 'aria-hidden': 'true' }, '◢'), logo, text), h('div.bl-scan', { 'aria-hidden': 'true' }));
  function update(s, view) {
    logo.textContent = view.pack?.systemName || 'The System';
    logo.dataset.text = logo.textContent;
    text.textContent = s.data?.text || 'Stand by';
  }
  update(sc, env.view);
  return { update };
}
