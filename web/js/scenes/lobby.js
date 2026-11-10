// Lobby: the show's title card while people arrive. Big title, QR to join, the party lining up.
import { h, partyStrip } from './common.js';

export default function lobby(root, sc, env) {
  const title = h('h1.lb-title');
  const kicker = h('p.lb-kicker', 'Tonight on');
  const sub = h('p.lb-sub');
  const qr = h('img.lb-qr', { alt: '', width: 260, height: 260 });
  const url = h('p.lb-url');
  const room = h('p.lb-room');
  const join = h('div.lb-join', qr, h('div.lb-join-text', h('p.lb-call', 'Scan to join'), url, room));
  const party = partyStrip();
  root.append(
    h('div.lb-stage',
      h('div.lb-head', kicker, title, sub),
      join),
    h('div.sc-party', party.el),
  );
  let qrUrl = '';
  function update(s, view) {
    const d = s.data || {};
    const sys = view.pack?.systemName || 'The System';
    title.textContent = d.title || sys;
    title.dataset.text = title.textContent;
    title.classList.toggle('long', title.textContent.length > 14);
    sub.textContent = d.subtitle || (view.players?.length ? `${view.players.length} crawler${view.players.length === 1 ? '' : 's'} in the building` : 'Grab your phone. The show starts soon.');
    const u = view.joinUrl || '';
    join.hidden = d.showQr === false || !u || document.body.classList.contains('hosted');
    if (u && u !== qrUrl) {
      qrUrl = u;
      qr.src = `/qr?text=${encodeURIComponent(u)}`;
      qr.alt = `QR code: ${u}`;
      url.textContent = u.replace(/^https?:\/\//, '');
    }
    room.replaceChildren('Room ', h('b', view.room || '····'));
    party.update(view);
  }
  update(sc, env.view);
  return { update };
}
