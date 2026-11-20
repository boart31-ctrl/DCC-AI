// Message centre: conversations between the GM and the crawlers (a small Discord inside the app).
// Shared by the GM desk (role 'gm': sees every conversation) and the player phone (role 'player').
// Conversations ("threads"): 'all' = everyone, otherwise the sorted crawler ids in it; the GM is in all
// of them. Reactions and stickers come from the pack's ui.json (reactions / stickers), else emoji.

import { h, timeAgo, buzz, toast } from './client.js';
import { icon, avatar } from './ui.js';

export const EMOJI = { like: '👍', lol: '😂', love: '❤️', wow: '😮', sad: '😢', fire: '🔥', skull: '💀', party: '🎉' };
const GROUP_GAP_MS = 4 * 60 * 1000;

export const threadKey = (ids) => (ids === 'all' ? 'all' : [...new Set(ids)].sort().join(','));

/**
 * opts: { role: 'gm'|'player', send(action) → Promise, getView() → view, onUnread?(n) }
 * → { el, update(), setVisible(bool), unread(), open(threadKey) }
 */
export function createMsgCenter({ role, send, getView, onUnread }) {
  const gm = role === 'gm';
  let visible = false;
  let cur = null; // open conversation; nothing by default, so nothing goes to everyone by accident
  let draftIds = null; // a new group being picked (ids)
  let paletteFor = null; // message id whose reaction palette is open
  let stickersOpen = false;
  let sending = false;
  const requestedReads = new Set();
  const drafts = new Map();
  const groupDraft = Symbol('group draft');

  const v = () => getView() || {};
  const meId = () => (gm ? 'gm' : v().me?.id);
  const players = () => v().players || [];
  const pOf = (id) => players().find((p) => p.id === id);
  const msgs = () => (gm ? v().gm?.messages : v().me?.messages) || [];
  const sysName = () => v().pack?.systemName || 'The System';
  const reactions = () => {
    const r = v().pack?.ui?.reactions;
    return r && Object.keys(r).length ? Object.entries(r).map(([id, a]) => ({ id, src: a.still || a.src, name: a.name || id })) : Object.keys(EMOJI).map((id) => ({ id, emoji: EMOJI[id], name: id }));
  };
  const stickers = () => Object.entries(v().pack?.ui?.stickers || {}).map(([id, a]) => ({ id, src: a.still || a.src, name: a.name || id }));
  const isUnread = (m) => (gm ? !m.gmRead : !m.read && m.fromId !== meId());
  const threadIds = (k) => (k === 'all' ? 'all' : k.split(',').filter(Boolean));
  const mThread = (m) => m.thread || threadKey(m.to === 'all' ? 'all' : m.to || []);

  /** Who is in a conversation, as the viewer would name it. */
  function title(k) {
    if (k === 'all') return 'Everyone';
    const ids = threadIds(k);
    if (gm) return ids.map((id) => pOf(id)?.name || 'Gone crawler').join(', ');
    const others = ids.filter((id) => id !== meId());
    if (!others.length) return 'Game Master';
    return others.map((id) => pOf(id)?.name || 'Gone crawler').join(', ');
  }
  function threadAvatar(k, size = 36) {
    if (k === 'all') return h('span.mc-av.all', { style: { width: `${size}px`, height: `${size}px` } }, icon('users', { size: Math.round(size * 0.5) }));
    const ids = threadIds(k).filter((id) => gm || id !== meId());
    if (!ids.length) return h('span.mc-av.gm', { style: { width: `${size}px`, height: `${size}px` } }, icon('eye', { size: Math.round(size * 0.5) }));
    const p = pOf(ids[0]);
    const a = avatar(p?.name || '?', { color: p?.color, src: p?.portrait, size });
    return ids.length > 1 ? h('span.mc-av-stack', a, h('span.mc-av-n', `+${ids.length - 1}`)) : a;
  }

  /** Fixed common threads, then the remaining conversations by most recent activity. */
  function threads() {
    const by = new Map();
    const add = (k) => { if (!by.has(k)) by.set(k, { key: k, last: null, unread: 0 }); return by.get(k); };
    add('all');
    if (gm) for (const p of players()) add(p.id);
    else if (meId()) add(meId());
    for (const m of msgs()) {
      const t = add(mThread(m));
      t.last = m;
      if (isUnread(m)) t.unread++;
    }
    const pinned = gm || !meId() ? ['all'] : [meId(), 'all'];
    const rest = [...by.values()].filter((t) => !pinned.includes(t.key));
    rest.sort((a, b) => (b.last?.at || 0) - (a.last?.at || 0) || title(a.key).localeCompare(title(b.key)));
    return [...pinned.map((k) => by.get(k)), ...rest];
  }

  /* ---------- shell ---------- */
  const listEl = h('ul.mc-threads', { 'aria-label': 'Conversations' });
  const headEl = h('div.mc-head');
  const feedEl = h('div.mc-feed', { 'aria-live': 'polite' });
  const text = h('textarea.mc-text', { rows: 1, maxlength: 1000, placeholder: 'Write a message', 'aria-label': 'Message' });
  const fromIn = gm ? h('input.mc-from', { type: 'text', maxlength: 60, placeholder: 'From: The System', 'aria-label': 'Send as' }) : null;
  const tvBox = gm ? h('input', { type: 'checkbox' }) : null;
  const tvWrap = gm ? h('label.mc-tv', tvBox, 'Also on the TV') : null;
  const stickerBtn = h('button.btn.btn-quiet.mc-stk-btn', { type: 'button', title: 'Stickers', 'aria-label': 'Stickers', onclick: () => { stickersOpen = !stickersOpen; drawComposer(); } }, icon('sparkle', { size: 18 }));
  const sendBtn = h('button.btn.btn-primary.mc-send', { type: 'submit', 'aria-label': 'Send' }, icon('chat', { size: 16 }), h('span.mc-send-l', 'Send'));
  const stickerGrid = h('div.mc-stickers', { hidden: true });
  const pausedNote = h('p.mc-paused', { hidden: true });
  const form = h('form.mc-compose', { onsubmit: (e) => { e.preventDefault(); post({ text: text.value }); } },
    stickerGrid, pausedNote,
    gm ? h('div.mc-gmopts', fromIn, tvWrap) : null,
    h('div.mc-row', stickerBtn, text, sendBtn));
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  text.addEventListener('input', () => { text.style.height = 'auto'; text.style.height = `${Math.min(140, text.scrollHeight)}px`; });

  const pauseBtn = gm ? h('button.btn.btn-sm.btn-quiet.mc-pause', { type: 'button', onclick: () => send({ t: 'msg.players', on: !(v().session?.chatPlayers !== false) }).catch((e) => toast(e.message, { error: true })) }) : null;
  const newBtn = h('button.btn.btn-sm.mc-new', { type: 'button', onclick: () => select(null, []) }, icon('plus', { size: 14 }), 'New group');
  const side = h('aside.mc-side', h('div.mc-side-head', h('h2', 'Messages'), h('span.grow'), newBtn), listEl, gm ? h('div.mc-side-foot', pauseBtn) : h('p.mc-note', 'The GM can read every conversation.'));
  const main = h('section.mc-main', headEl, feedEl, form);
  const el = h('div.mc', { class: `mc mc-${role}` }, side, main);

  /* ---------- actions ---------- */
  const draftKey = () => draftIds ? groupDraft : cur;
  function select(k, group = null) {
    const was = draftKey();
    if (was && text.value) drafts.set(was, text.value);
    else drafts.delete(was);
    cur = k;
    draftIds = group;
    paletteFor = null;
    stickersOpen = false;
    if (tvBox) tvBox.checked = false;
    text.value = drafts.get(draftKey()) || '';
    text.style.height = 'auto';
    draw();
  }

  async function post({ text: t = '', icon: stk = null }) {
    if (sending) return;
    const body = t.trim();
    if (!body && !stk) { text.focus(); return; }
    const k = draftIds ? threadKey(gm ? draftIds : [meId(), ...draftIds]) : cur;
    if (!k || (draftIds && !draftIds.length)) { toast('Pick who gets it first', { error: true }); return; }
    const ids = threadIds(k);
    let a;
    if (gm) {
      a = { t: 'msg.send', to: k === 'all' ? 'all' : ids, text: body };
      if (fromIn.value.trim()) a.from = fromIn.value.trim();
      if (tvBox.checked && !tvWrap.hidden) a.onStage = true;
    } else a = { t: 'msg.post', to: k === 'all' ? 'all' : ids.filter((id) => id !== meId()), text: body };
    if (stk) a.icon = stk;
    const fromDraft = draftKey();
    try {
      sending = true;
      drawComposer();
      await send(a);
      buzz(8);
      if (!stk) drafts.delete(fromDraft);
      if (draftKey() === fromDraft) {
        if (!stk) text.value = '';
        select(k);
      }
    } catch (err) {
      toast(err.message || 'Could not send', { error: true });
    } finally {
      sending = false;
      drawComposer();
    }
  }
  const react = (m, r) => { paletteFor = null; send({ t: 'msg.react', id: m.id, r }).catch((e) => toast(e.message, { error: true })); buzz(6); };

  function isReading(key) {
    return visible && key && key === cur && !draftIds && el.isConnected && !el.closest('[hidden]') && document.visibilityState !== 'hidden';
  }
  function markRead() {
    if (!isReading(cur)) return;
    const pending = msgs().filter((m) => mThread(m) === cur && isUnread(m) && !requestedReads.has(m.id));
    if (!pending.length) return;
    for (const m of pending) requestedReads.add(m.id);
    send({ t: gm ? 'msg.gmRead' : 'msg.read', thread: cur }).catch(() => {
      for (const m of pending) requestedReads.delete(m.id);
    });
  }

  /* ---------- drawing ---------- */
  function drawList(ts) {
    listEl.replaceChildren(...ts.map((t) => {
      const last = t.last;
      const prev = last ? `${last.fromId === meId() ? 'You' : (last.from || sysName())}: ${last.text || (last.icon ? 'sticker' : '')}` : (t.key === 'all' ? 'The whole party' : 'No messages yet');
      const active = t.key === cur && !draftIds;
      const name = title(t.key);
      return h('li', h('button.mc-thread', {
        type: 'button', 'data-thread': t.key, 'aria-current': active ? 'true' : null,
        'aria-label': t.unread ? `${name}, ${t.unread} unread message${t.unread === 1 ? '' : 's'}` : name,
        class: `mc-thread${active ? ' on' : ''}${t.unread ? ' unread' : ''}`,
        onclick: () => select(t.key),
      }, threadAvatar(t.key), h('span.mc-tmeta', h('b', title(t.key)), h('span.mc-prev', prev)),
      h('span.mc-tside', last ? h('time', timeAgo(last.at)) : null, t.unread ? h('span.mc-badge', String(t.unread)) : null)));
    }));
  }

  function drawHead() {
    if (draftIds) {
      const chip = (p) => h('button.chip', { type: 'button', 'aria-pressed': String(draftIds.includes(p.id)), style: { '--cc': p.color }, onclick: () => { draftIds = draftIds.includes(p.id) ? draftIds.filter((x) => x !== p.id) : [...draftIds, p.id]; drawHead(); } }, p.name);
      const pick = players().filter((p) => gm || p.id !== meId());
      headEl.replaceChildren(
        h('button.btn.btn-quiet.mc-back', { type: 'button', 'aria-label': 'Back', onclick: () => select(null) }, icon('back', { size: 18 })),
        h('div.mc-pick', h('b', 'New group: who is in it?'), h('div.chips', pick.length ? pick.map(chip) : h('span.dim', 'No other crawlers yet.')), h('span.dim', gm ? 'Pick two or more for a group, one for a private line.' : 'You and the GM are always in it.')));
      return;
    }
    if (!cur) { headEl.replaceChildren(); return; }
    const n = cur === 'all' ? players().length : threadIds(cur).length;
    headEl.replaceChildren(
      h('button.btn.btn-quiet.mc-back', { type: 'button', 'aria-label': 'All conversations', onclick: () => select(null) }, icon('back', { size: 18 })),
      threadAvatar(cur, 32),
      h('div.mc-htitle', h('b', title(cur)), h('span.dim', cur === 'all' ? `Everyone at the table (${n})` : gm ? (n > 1 ? `Group of ${n}` : 'Private line') : (threadIds(cur).length > 1 ? 'The GM sees this too' : 'Private line to the GM'))));
  }

  function reactRow(m) {
    const mine = meId();
    const list = reactions();
    const chips = Object.entries(m.reactions || {}).filter(([, who]) => who.length).map(([id, who]) => {
      const r = list.find((x) => x.id === id) || { id, emoji: EMOJI[id] || '•' };
      const names = who.map((w) => (w === 'gm' ? 'GM' : pOf(w)?.name || '?')).join(', ');
      return h('button.mc-rx', { type: 'button', class: `mc-rx${who.includes(mine) ? ' mine' : ''}`, title: names, 'aria-label': `${r.name || id}: ${names}`, onclick: () => react(m, id) },
        r.src ? h('img', { src: r.src, alt: '' }) : h('span.mc-emo', r.emoji), h('span', String(who.length)));
    });
    const add = h('button.mc-rx.mc-rx-add', { type: 'button', 'aria-label': 'Add a reaction', onclick: () => { paletteFor = paletteFor === m.id ? null : m.id; drawFeed(); } }, icon('plus', { size: 12 }));
    const pal = paletteFor === m.id ? h('div.mc-pal', { role: 'menu' }, list.map((r) => h('button', { type: 'button', role: 'menuitem', title: r.name, 'aria-label': r.name, onclick: () => react(m, r.id) }, r.src ? h('img', { src: r.src, alt: '' }) : h('span.mc-emo', r.emoji)))) : null;
    return h('div.mc-rxs', chips, add, pal);
  }

  function drawFeed() {
    if (draftIds) { feedEl.replaceChildren(h('p.mc-empty', 'Pick the crawlers above, then write the first message.')); return; }
    if (!cur) { feedEl.replaceChildren(gm ? h('p.mc-empty', 'Pick a conversation on the left, or a crawler for a private line.') : ''); return; }
    const list = msgs().filter((m) => mThread(m) === cur);
    const atBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 60;
    const stk = new Map(stickers().map((s) => [s.id, s]));
    let prev = null;
    const nodes = list.map((m) => {
      const own = m.fromId === meId();
      const cont = prev && prev.fromId === m.fromId && prev.from === m.from && m.at - prev.at < GROUP_GAP_MS;
      prev = m;
      const p = m.fromId && m.fromId !== 'gm' ? pOf(m.fromId) : null;
      const who = m.from || (p ? p.name : sysName());
      const s = m.icon ? stk.get(m.icon) : null;
      return h('div.mc-msg', { class: `mc-msg${own ? ' own' : ''}${cont ? ' cont' : ''}${m.fromId === 'gm' ? ' gm' : ''}`, 'data-id': m.id, style: p?.color ? { '--mc': p.color } : null },
        cont ? h('span.mc-gut') : (p ? avatar(p.name, { color: p.color, src: p.portrait, size: 32 }) : h('span.mc-av.gm', icon('eye', { size: 16 }))),
        h('div.mc-bub',
          cont ? null : h('div.mc-meta', h('b', own ? 'You' : who), h('time', timeAgo(m.at)), m.onStage ? h('span.mc-tvflag', 'on TV') : null,
            gm ? h('button.mc-del', { type: 'button', title: 'Delete for everyone', 'aria-label': 'Delete message', onclick: () => send({ t: 'msg.delete', id: m.id }).catch((e) => toast(e.message, { error: true })) }, icon('trash', { size: 13 })) : null),
          s ? h('img.mc-sticker', { src: s.src, alt: s.name }) : (m.icon ? h('span.mc-emo.big', '✨') : null),
          m.text ? h('div.mc-txt', m.text) : null,
          reactRow(m)));
    });
    feedEl.replaceChildren(...(nodes.length ? nodes : [h('p.mc-empty', cur === 'all' ? 'Nothing yet. Say something to the whole table.' : 'No messages yet. Start the conversation.')]));
    if (atBottom || feedEl.dataset.k !== cur) feedEl.scrollTop = feedEl.scrollHeight;
    feedEl.dataset.k = cur;
  }

  function drawComposer() {
    const paused = !gm && v().session?.chatPlayers === false;
    const on = !!(cur || draftIds);
    form.hidden = !on;
    pausedNote.hidden = !paused;
    pausedNote.textContent = 'The GM has paused messages for now.';
    newBtn.disabled = sending;
    text.disabled = paused || sending; sendBtn.disabled = paused || sending; stickerBtn.disabled = paused || sending;
    const st = stickers();
    stickerBtn.hidden = !st.length;
    stickerGrid.hidden = !stickersOpen || !st.length;
    if (stickersOpen && st.length && !stickerGrid.childElementCount) {
      stickerGrid.replaceChildren(...st.map((s) => h('button', { type: 'button', title: s.name, 'aria-label': `Send sticker ${s.name}`, onclick: () => post({ icon: s.id }) }, h('img', { src: s.src, alt: '' }))));
    }
    const toAll = !draftIds && cur === 'all';
    sendBtn.classList.toggle('mc-send-all', toAll);
    const sendLabel = toAll ? 'Send to everyone' : 'Send';
    sendBtn.querySelector('.mc-send-l').textContent = sendLabel;
    sendBtn.setAttribute('aria-label', sendLabel);
    if (gm) {
      const group = draftIds ? draftIds.length > 1 : cur === 'all' || (cur && threadIds(cur).length > 1);
      tvWrap.hidden = !group;
      fromIn.placeholder = `From: ${sysName()}`;
      const open = v().session?.chatPlayers !== false;
      pauseBtn.replaceChildren(icon(open ? 'chat' : 'lock', { size: 14 }), open ? 'Crawlers can write: on' : 'Crawlers can write: off');
      pauseBtn.classList.toggle('off', !open);
    }
  }

  let sig = '';
  function draw() {
    const ts = threads();
    el.classList.toggle('show-thread', !!(cur || draftIds));
    drawList(ts);
    drawHead();
    drawFeed();
    drawComposer();
    markRead();
    onUnread?.(unread());
  }
  function unread() { return msgs().filter(isUnread).length; }

  function update() {
    const s = JSON.stringify([msgs().map((m) => [m.id, m.read, m.gmRead, m.reactions]), players().map((p) => [p.id, p.name, p.color, !!p.portrait]), v().session?.chatPlayers, cur, !!draftIds]);
    if (s === sig) { markRead(); return; }
    const unreadIds = new Set(msgs().filter(isUnread).map((m) => m.id));
    for (const id of requestedReads) if (!unreadIds.has(id)) requestedReads.delete(id);
    if (document.activeElement && el.contains(document.activeElement) && document.activeElement.closest('.mc-pick')) { onUnread?.(unread()); return; }
    sig = s;
    draw();
  }

  return {
    el,
    update,
    unread,
    isReading,
    setVisible(on) { visible = on; if (on) { sig = ''; update(); markRead(); } },
    open(k) { select(k); },
  };
}
