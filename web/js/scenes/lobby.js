// Lobby: the show's title card while people arrive. Big title, QR to join, the party lining up.
import { h, partyStrip } from './common.js';
import { uiOf, uiAsset, artEl, floorLayer, mascotEl } from '../ui-art.js';

export default function lobby(root, sc, env) {
  const title = h('h1.lb-title');
  const kicker = h('p.lb-kicker', 'Tonight on');
  const sub = h('p.lb-sub');
  const qr = h('img.lb-qr', { alt: '', width: 260, height: 260 });
  const url = h('p.lb-url');
  const room = h('p.lb-room');
  const join = h('div.lb-join', qr, h('div.lb-join-text', h('p.lb-call', 'Scan to join'), url, room));
  const party = partyStrip();
  const floorBg = floorLayer('lobby');
  const logo = h('div.lb-logo', { 'aria-hidden': 'true' });
  const mascot = h('div.lb-mascot');
  root.append(
    floorBg.el,
    h('div.lb-stage',
      h('div.lb-head', logo, kicker, title, sub),
      join),
    h('div.sc-party', party.el),
    mascot,
  );
  let artSig = null;
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
    floorBg.update(view);
    const ui = uiOf(view);
    const sig = JSON.stringify([ui?.logo, ui?.mascot?.idle, ui?.mascot?.neutral, ui?.mascot?.talking]);
    if (sig !== artSig) {
      artSig = sig;
      const lg = artEl(uiAsset(ui, 'logo'), { still: true, onError: () => logo.replaceChildren() });
      logo.replaceChildren(...(lg ? [lg] : []));
      logo.hidden = !lg;
      const m = mascotEl(ui, 'idle', 'ua-mascot lb-mascot-art');
      mascot.replaceChildren(...(m ? [m] : []));
    }
  }
  update(sc, env.view);
  return { update };
}
