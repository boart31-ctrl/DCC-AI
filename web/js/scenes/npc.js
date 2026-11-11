// NPC card: portrait, name, role, and the latest "Speak as NPC" line in a dialogue box.
// Only TV-safe fields reach this scene (server/scenes.js npcCard): never voice tips, hooks or secrets.
import { h, rgb, threatColor, typeText, replay, bossSvg } from './common.js';

export default function npc(root, sc, env) {
  const { T } = env;
  const art = h('div.np-art');
  const kicker = h('p.np-k');
  const name = h('h1.np-name');
  const role = h('p.np-role');
  const who = h('span.np-who');
  const line = h('p.np-line');
  const box = h('div.np-box', who, line);
  root.append(
    h('div.np-bg', h('i.np-ray')),
    h('div.np-stage',
      h('div.np-frame', art, h('i.c1'), h('i.c2'), h('i.c3'), h('i.c4')),
      h('div.np-text', kicker, name, role, box)),
  );
  let img = null;
  let lineAt = null;

  function drawArt(n) {
    const key = `${n.name}|${n.image || ''}`;
    if (img === key) return;
    img = key;
    art.replaceChildren();
    art.classList.remove('gen');
    const gen = () => { art.classList.add('gen'); art.innerHTML = bossSvg({ name: n.name }, { lit: true }); };
    if (n.image) {
      const i = h('img', { alt: '', decoding: 'async' });
      i.onerror = () => { i.remove(); gen(); };
      i.src = n.image;
      art.append(i);
    } else gen();
  }

  function update(s) {
    const d = s.data || {};
    const n = d.npc || { name: 'Someone', role: '' };
    const c = threatColor({ name: n.name });
    root.style.setProperty('--th', c);
    root.style.setProperty('--th-rgb', rgb(c));
    drawArt(n);
    kicker.textContent = ['NPC', n.floor !== '' && n.floor != null ? `Floor ${n.floor}` : ''].filter(Boolean).join(' // ');
    name.textContent = n.name;
    name.classList.toggle('long', n.name.length > 16);
    role.textContent = n.role || '';
    role.hidden = !n.role;
    who.textContent = n.name;
    box.hidden = !d.line;
    if (d.line && d.lineAt !== lineAt) {
      lineAt = d.lineAt;
      replay(box, 'go');
      typeText(line, `“${d.line}”`, env.reduced ? 0 : Math.min(2600, 40 * d.line.length), T);
    } else if (!d.line) { line.textContent = ''; lineAt = null; }
  }

  update(sc);
  return { update, event() {} };
}
