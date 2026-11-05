// Campaign tab (GM only): story so far, end/start session with "Previously on…", prep chat with
// Claude that creates prepared cards. Also the Lobby panel on the desk (assign people to characters).
import { h, toast, buzz, ask, timeAgo } from '../client.js';

const $ = (s, r = document) => r.querySelector(s);

/* ======================= Lobby ======================= */

/**
 * Renders the lobby into #lobby: everyone with the artifact open (room presence) minus the GM's own
 * windows, with their assignment. Tap → choose an existing character or create a new one.
 */
export function mountLobby({ host, user, act }) {
  const wrap = $('#lobby');
  let names = {};
  let sig = '';
  const draw = async () => {
    const view = host.gmView?.();
    if (!view) return;
    const players = view.gm?.playersFull || [];
    const people = new Map();
    for (const p of host.peers || []) {
      if (p.kind !== 'viewer' || !p.by || p.isMe) continue;
      const cur = people.get(p.by);
      if (!cur || p.presence?.role === 'player') people.set(p.by, { id: p.by, guest: p.guest, role: p.presence?.role || 'viewer' });
    }
    // Assigned players who are offline still show, so the GM can unassign.
    for (const pl of players) if (pl.userId && !people.has(pl.userId)) people.set(pl.userId, { id: pl.userId, offline: true });
    const ids = [...people.keys()];
    try { names = ids.length ? await user.profiles(ids) : {}; } catch { names = {}; }
    const rows = ids.map((id) => {
      const per = people.get(id);
      const pl = players.find((x) => x.userId === id);
      return { ...per, name: names[id]?.name || 'Someone', avatar: names[id]?.avatarUrl, color: names[id]?.color, player: pl };
    }).sort((a, b) => Number(!!a.player) - Number(!!b.player) || a.name.localeCompare(b.name));
    const s = JSON.stringify(rows.map((r) => [r.id, r.name, r.player?.id, r.player?.name, r.offline]));
    if (s === sig) return;
    sig = s;
    $('#lobby-count').textContent = rows.length ? `${rows.filter((r) => !r.offline).length} here` : '';
    if (!rows.length) {
      wrap.replaceChildren(h('p.empty', 'Nobody else has the page open yet. Share this artifact\'s link with your players. Anyone who opens it while signed in to claude.ai appears here.'));
      return;
    }
    wrap.replaceChildren(...rows.map((r) => h('button.lob', {
      type: 'button',
      class: `lob${r.player ? ' on' : ''}${r.offline ? ' off' : ''}`,
      style: r.player ? { '--pc': r.player.color } : null,
      onclick: () => assignSheet(r),
    },
    h('img.lob-av', { src: r.avatar || '', alt: '', width: 36, height: 36 }),
    h('span.lob-who', h('b', r.name), h('small', r.offline ? 'offline' : r.player ? 'playing' : r.guest ? 'guest, waiting' : 'waiting')),
    h('span.lob-as', r.player ? r.player.name : 'Assign'),
    )));
  };

  function assignSheet(r) {
    const view = host.gmView();
    const players = view.gm?.playersFull || [];
    const free = players.filter((p) => !p.userId || p.userId === r.id);
    const nameIn = h('input.field', { placeholder: 'New character name', maxlength: 40, value: '' });
    const body = h('div.stack',
      h('p.dim', r.player ? `${r.name} plays ${r.player.name}.` : `Pick a character for ${r.name}.`),
      free.length ? h('div.tier-grid', free.map((p) => h('button.tier', {
        type: 'button',
        style: { '--t': p.color },
        'aria-pressed': String(p.userId === r.id),
        onclick: async () => {
          if (p.userId === r.id) return;
          if (r.player) await act({ t: 'player.update', playerId: r.player.id, userId: null });
          if (await act({ t: 'player.update', playerId: p.id, userId: r.id }, `${r.name} now plays ${p.name}.`)) close();
        },
      }, p.name))) : null,
      h('div.divider', 'or create one'),
      h('div.say-row', nameIn, h('button.btn.btn-cyan', {
        type: 'button',
        onclick: async () => {
          const name = nameIn.value.trim() || r.name;
          if (r.player) await act({ t: 'player.update', playerId: r.player.id, userId: null });
          if (await act({ t: 'player.add', name, userId: r.id }, `${r.name} joined as ${name}.`)) close();
        },
      }, 'Create')),
      r.player ? h('button.btn.btn-ghost', {
        type: 'button',
        onclick: async () => {
          if (await act({ t: 'player.update', playerId: r.player.id, userId: null }, `${r.player.name} is unassigned.`)) close();
        },
      }, `Unassign from ${r.player.name}`) : null,
    );
    const dlg = $('#sheet');
    $('#sheet-title').textContent = r.name;
    $('#sheet-body').replaceChildren(body);
    if (!dlg.open) dlg.showModal();
    setTimeout(() => nameIn.focus(), 30);
    function close() { if (dlg.open) dlg.close(); }
  }

  host.on('peers', draw);
  host.on('view', draw);
  draw();
}

/* ======================= Campaign tab ======================= */

export function mountCampaign({ host, db, ai, act, onAiChange }) {
  const root = $('#campaign');
  const state = { story: '', storyAt: 0, prep: { turns: [], notes: [] }, sessions: [] };
  let storyDirty = false;
  let prepWrite = Promise.resolve();

  /* ---- story so far ---- */
  const storyEl = $('#story', root);
  const storyState = $('#story-state', root);
  db.doc('campaign/story').onSnapshot((s) => {
    const d = s.exists ? s.data() : null;
    state.story = typeof d?.text === 'string' ? d.text : '';
    if (!storyDirty && document.activeElement !== storyEl) storyEl.value = state.story;
    storyState.textContent = d?.at ? `Saved ${timeAgo(d.at)}` : 'Nothing written yet';
  }, () => {});
  let storyTimer = null;
  storyEl.addEventListener('input', () => {
    storyDirty = true;
    storyState.textContent = 'Typing';
    clearTimeout(storyTimer);
    storyTimer = setTimeout(saveStory, 900);
  });
  storyEl.addEventListener('blur', () => { if (storyDirty) { clearTimeout(storyTimer); saveStory(); } });
  async function saveStory(text = storyEl.value) {
    try {
      await db.doc('campaign/story').set({ text: text.slice(0, 60000), at: Date.now() });
      storyDirty = false;
      storyState.textContent = 'Saved';
    } catch (e) {
      storyState.textContent = `Not saved: ${e?.message || 'store unavailable'}`;
    }
  }

  /* ---- sessions list ---- */
  db.collection('sessions').orderBy('endedAt', 'desc').limit(10).onSnapshot((snap) => {
    state.sessions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const list = $('#sessions', root);
    list.replaceChildren(...(state.sessions.length ? state.sessions.map((s) => h('li',
      h('b', new Date(s.endedAt || 0).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })),
      h('span', s.summary ? s.summary.slice(0, 220) + (s.summary.length > 220 ? '…' : '') : `${(s.log || []).length} logged events, no summary`),
    )) : [h('li.dim', 'No archived sessions yet. End a session to archive it here.')]));
  }, () => {});

  /* ---- end session ---- */
  const endBox = $('#end-box', root);
  $('#end-session', root).addEventListener('click', async () => {
    buzz(10);
    endBox.hidden = false;
    $('#sum-text', root).value = '';
    $('#prev-text', root).value = '';
    $('#end-status', root).textContent = '';
    if (ai.available) await draftSummary();
    else $('#end-status', root).textContent = 'Write the summary and the "Previously on" yourself, then save.';
  });
  $('#redo-summary', root).addEventListener('click', draftSummary);
  async function draftSummary() {
    const st = $('#end-status', root);
    st.textContent = 'Claude is reading the session log…';
    $('#redo-summary', root).disabled = true;
    try {
      const view = host.gmView();
      const r = await ai.summarizeSession({ story: state.story, log: compactLog(host.currentLog(), view), players: partyText(view) });
      $('#sum-text', root).value = r.summary;
      $('#prev-text', root).value = r.previously;
      st.textContent = 'Draft ready. Edit both, then save.';
    } catch (e) {
      st.textContent = e.userMessage || 'Claude could not write it. Write it yourself.';
    } finally {
      $('#redo-summary', root).disabled = !ai.available;
    }
  }
  $('#end-cancel', root).addEventListener('click', () => { endBox.hidden = true; });
  $('#end-save', root).addEventListener('click', async () => {
    const summary = $('#sum-text', root).value.trim();
    const previously = $('#prev-text', root).value.trim();
    if (!(await ask('Archive this session and start a fresh one? Players, sheets and inventories stay.', { ok: 'End session' }))) return;
    const sessionId = host.state.session.id;
    const startedAt = host.state.session.startedAt;
    if (!(await act({ t: 'session.new' }, 'Session archived.'))) return;
    // The archive was written by the host; add the texts to it.
    try {
      await host.flushAll();
      const ref = db.doc(`sessions/${sessionId}`);
      const snap = await ref.get();
      const base = snap.exists ? snap.data() : { session: { id: sessionId, startedAt }, endedAt: Date.now() };
      await ref.set({ ...base, summary, previously, endedAt: base.endedAt || Date.now() });
    } catch { /* archive text is a nicety */ }
    if (summary) {
      const stamp = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
      const next = `${state.story.trim()}\n\n## Session, ${stamp}\n${summary}`.trim();
      storyEl.value = next;
      await saveStory(next);
    }
    if (previously) {
      $('#recap-text', root).value = previously;
      await saveRecapDraft(previously);
    }
    endBox.hidden = true;
    toast('Saved. The "Previously on" waits for the next session start.');
  });

  /* ---- start session: recap ---- */
  const recapEl = $('#recap-text', root);
  db.doc('prep/next').onSnapshot((s) => {
    const d = s.exists ? s.data() : {};
    if (typeof d.recap === 'string' && document.activeElement !== recapEl && !recapEl.dataset.dirty) recapEl.value = d.recap;
    state.prep.notes = Array.isArray(d.notes) ? d.notes : [];
    if (!prepBusy && Array.isArray(d.turns)) { state.prep.turns = d.turns; drawChat(); }
    drawNotes();
  }, () => {});
  recapEl.addEventListener('input', () => { recapEl.dataset.dirty = '1'; });
  recapEl.addEventListener('blur', () => { if (recapEl.dataset.dirty) saveRecapDraft(recapEl.value); });
  async function saveRecapDraft(text) {
    delete recapEl.dataset.dirty;
    await savePrep({ recap: text.slice(0, 4000) });
  }
  $('#recap-start', root).addEventListener('click', async () => {
    const text = recapEl.value.trim();
    if (!text) { recapEl.focus(); return; }
    await saveRecapDraft(text);
    if (!(await act({ t: 'session.recap', text }, 'Recap is on the TV and phones.'))) return;
    if ($('#recap-voice', root).checked) host.narrate(text);
  });
  $('#recap-clear', root).addEventListener('click', () => act({ t: 'session.recap', text: '' }, 'Recap cleared.'));

  async function savePrep(patch) {
    prepWrite = prepWrite.then(async () => {
      const ref = db.doc('prep/next');
      const snap = await ref.get().catch(() => null);
      const cur = snap?.exists ? snap.data() : {};
      await ref.set({ ...cur, ...patch, at: Date.now() });
    }).catch(() => {});
    return prepWrite;
  }

  /* ---- prep chat ---- */
  const chatEl = $('#prep-chat', root);
  const input = $('#prep-input', root);
  const sendBtn = $('#prep-send', root);
  const stopBtn = $('#prep-stop', root);
  let prepBusy = false;
  let ctl = null;

  function drawChat(live) {
    const turns = state.prep.turns.slice(-30);
    chatEl.replaceChildren(...(turns.length || live ? [
      ...turns.map((t) => h('div.bub', { class: `bub ${t.role === 'user' ? 'me' : 'ai'}` }, t.content)),
      live || null,
    ] : [h('p.empty', 'Plan the next session with Claude. It sees the story so far, the party\'s sheets and the pack. Ask it to prepare achievements, loot, messages or lines; they appear on the desk as one-tap cards.')]));
    chatEl.scrollTop = chatEl.scrollHeight;
  }
  function drawNotes() {
    const list = $('#prep-notes', root);
    list.replaceChildren(...state.prep.notes.map((n, i) => h('li', h('span', n.text), h('button.linkish', {
      type: 'button',
      onclick: () => savePrep({ notes: state.prep.notes.filter((_, j) => j !== i) }),
    }, 'Remove'))));
    $('#prep-notes-wrap', root).hidden = !state.prep.notes.length;
  }

  const tools = () => {
    const view = host.gmView();
    const tierIds = (view.pack.lootTiers || []).map((t) => t.id);
    const playerIds = (view.players || []).map((p) => p.id);
    const made = [];
    const add = async (kind, label, payload) => {
      const r = await host.send({ t: 'prep.card.add', kind, label: String(label || kind).slice(0, 80), payload });
      made.push(label);
      return { ok: true, cardId: r.result?.id, label };
    };
    const pid = (v) => (v == null || v === '' ? undefined : (playerIds.includes(String(v)) ? String(v) : (() => { throw new Error(`unknown playerId ${v}; use one of ${playerIds.join(', ') || '(no players yet)'}`); })()));
    return [
      {
        name: 'prepare_achievement',
        description: 'Create a one-tap achievement card for the GM desk. Either achId (from the catalog) or a custom title+desc(+reward). playerId optional: leave it out if the GM will decide at the table.',
        inputSchema: { type: 'object', properties: { label: { type: 'string' }, achId: { type: 'string' }, title: { type: 'string' }, desc: { type: 'string' }, reward: { type: 'string' }, playerId: { type: 'string' } } },
        execute: (i) => {
          const payload = {};
          if (i.achId) {
            if (!view.gm.achievementsCatalog.some((a) => a.id === i.achId)) throw new Error(`unknown achId ${i.achId}`);
            payload.achId = String(i.achId);
          } else {
            if (!i.title) throw new Error('title or achId required');
            payload.title = String(i.title).slice(0, 80);
            payload.desc = String(i.desc || '').slice(0, 1200);
            if (i.reward) payload.reward = String(i.reward).slice(0, 160);
          }
          const p = pid(i.playerId); if (p) payload.playerId = p;
          return add('achievement', i.label || i.title || i.achId, payload);
        },
      },
      {
        name: 'prepare_loot',
        description: `Create a one-tap loot box card. tier must be one of: ${tierIds.join(', ') || '(none)'}. playerId optional.`,
        inputSchema: { type: 'object', properties: { label: { type: 'string' }, tier: { type: 'string' }, playerId: { type: 'string' } }, required: ['tier'] },
        execute: (i) => {
          if (!tierIds.includes(String(i.tier))) throw new Error(`tier must be one of ${tierIds.join(', ')}`);
          const payload = { tier: String(i.tier) };
          const p = pid(i.playerId); if (p) payload.playerId = p;
          return add('loot', i.label || `${i.tier} box`, payload);
        },
      },
      {
        name: 'prepare_message',
        description: 'Create a one-tap message card. to is "all" or an array of playerIds. onStage true shows a group message on the TV too.',
        inputSchema: { type: 'object', properties: { label: { type: 'string' }, to: {}, text: { type: 'string' }, from: { type: 'string' }, onStage: { type: 'boolean' } }, required: ['text'] },
        execute: (i) => {
          const to = i.to === 'all' || i.to == null ? 'all' : (Array.isArray(i.to) ? i.to.map((x) => pid(x)) : [pid(i.to)]);
          const payload = { to, text: String(i.text).slice(0, 1000) };
          if (i.from) payload.from = String(i.from).slice(0, 60);
          if (i.onStage) payload.onStage = true;
          return add('message', i.label || 'Message', payload);
        },
      },
      {
        name: 'prepare_line',
        description: 'Create a one-tap line the System speaks aloud on the TV (max ~25 words).',
        inputSchema: { type: 'object', properties: { label: { type: 'string' }, text: { type: 'string' } }, required: ['text'] },
        execute: (i) => add('line', i.label || 'Line', { text: String(i.text).slice(0, 500) }),
      },
      {
        name: 'add_note',
        description: 'Add a short plan note for the GM (not shown to players).',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        execute: async (i) => {
          const notes = [...state.prep.notes, { text: String(i.text).slice(0, 500), at: Date.now() }].slice(-50);
          state.prep.notes = notes;
          drawNotes();
          await savePrep({ notes });
          return { ok: true };
        },
      },
    ];
  };

  async function sendPrep() {
    const text = input.value.trim();
    if (!text || prepBusy) return;
    if (!ai.available) { toast('Claude is not available on this page.', { error: true }); return; }
    prepBusy = true;
    input.value = '';
    state.prep.turns = [...state.prep.turns, { role: 'user', content: text }].slice(-30);
    const live = h('div.bub.ai.thinking', 'Thinking…');
    drawChat(live);
    sendBtn.disabled = true;
    stopBtn.hidden = false;
    ctl = new AbortController();
    try {
      const reply = await ai.prepTurn({
        turns: trimTurns(state.prep.turns),
        context: campaignContext(host.gmView(), state),
        tools: tools(),
        signal: ctl.signal,
        onText: ({ text: t }) => { live.textContent = t; live.classList.remove('thinking'); chatEl.scrollTop = chatEl.scrollHeight; },
      });
      state.prep.turns = [...state.prep.turns, { role: 'assistant', content: reply }].slice(-30);
    } catch (e) {
      if (e.partial) state.prep.turns = [...state.prep.turns, { role: 'assistant', content: e.partial }].slice(-30);
      toast(e.userMessage || 'Claude could not answer.', { error: e.code !== 'cancelled' });
    } finally {
      prepBusy = false;
      sendBtn.disabled = !ai.available;
      stopBtn.hidden = true;
      drawChat();
      savePrep({ turns: state.prep.turns });
    }
  }
  sendBtn.addEventListener('click', sendPrep);
  stopBtn.addEventListener('click', () => ctl?.abort());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrep(); } });
  $('#prep-clear', root).addEventListener('click', async () => {
    if (!(await ask('Clear the prep conversation? Prepared cards and notes stay.', { ok: 'Clear chat' }))) return;
    state.prep.turns = [];
    drawChat();
    savePrep({ turns: [] });
  });

  const syncAi = () => {
    root.classList.toggle('no-ai', !ai.available);
    sendBtn.disabled = !ai.available || prepBusy;
    $('#redo-summary', root).disabled = !ai.available;
    onAiChange?.(ai.available);
  };
  ai.onChange(syncAi);
  syncAi();
  drawChat();
}

/* ---------- context builders ---------- */

function trimTurns(turns) {
  // Keep it well under the input cap: the last 16 turns, each capped.
  return turns.slice(-16).map((t) => ({ role: t.role, content: String(t.content).slice(0, 4000) }));
}

export function partyText(view) {
  const stats = view.pack.stats || [];
  return (view.gm?.playersFull || []).map((p) => {
    const st = stats.map((s) => `${s.abbr || s.id} ${p.stats?.[s.id] ?? '?'}`).join(', ');
    const res = Object.entries(p.resources || {}).map(([k, v]) => `${k} ${v.cur}/${v.max}`).join(', ');
    const inv = (p.inventory || []).map((i) => `${i.name} (${i.rarity})`).join('; ') || 'nothing';
    const ach = (p.achievements || []).map((a) => a.title).join('; ') || 'none';
    return `- ${p.name} [id ${p.id}]: ${[p.title, p.race, p.klass].filter(Boolean).join(' ')} level ${p.level}, gold ${p.gold}. ${st}. ${res}. Inventory: ${inv}. Achievements: ${ach}.`;
  }).join('\n') || '(no characters yet)';
}

function campaignContext(view, state) {
  const cat = (view.gm?.achievementsCatalog || []).slice(0, 60).map((a) => `${a.id}: ${a.title}`).join('; ');
  const tiers = (view.pack.lootTiers || []).map((t) => `${t.id} (${t.name})`).join(', ');
  const cards = (view.gm?.prepCards || []).filter((c) => !c.used).map((c) => `${c.kind}: ${c.label}`).join('; ') || 'none';
  const last = state.sessions.slice(0, 3).map((s) => `- ${s.summary || '(no summary)'}`).join('\n') || '(none)';
  const notes = state.prep.notes.map((n) => `- ${n.text}`).join('\n') || '(none)';
  return `Story so far:\n${(state.story || '(nothing written yet)').slice(-8000)}\n\nLast sessions:\n${last}\n\nParty:\n${partyText(view)}\n\nLoot tiers: ${tiers || 'none'}\nAchievement catalog (id: title): ${cat || 'empty'}\nAlready prepared cards: ${cards}\nGM plan notes:\n${notes}`;
}

function compactLog(log, view) {
  const name = (id) => view.players?.find((p) => p.id === id)?.name || id;
  const lines = [];
  for (const e of log) {
    if (e.log === 'event') {
      if (e.kind === 'achievement') lines.push(`${name(e.playerId)} earned "${e.title}"`);
      else if (e.kind === 'loot') lines.push(`${name(e.playerId)} got ${e.item?.name} (${e.item?.rarity}) from a ${e.tier} box`);
      else if (e.kind === 'sponsor') lines.push(`${e.sponsor} sent ${name(e.playerId)} ${e.item?.name}`);
      else if (e.kind === 'stat') lines.push(`${name(e.playerId)} ${e.stat} ${e.from}→${e.to}`);
      else if (e.kind === 'message') lines.push(`Message from ${e.from}`);
    } else if (e.kind === 'play') {
      lines.push(`System said: "${e.text}"`);
    } else if (e.kind === 'action' && e.action?.t === 'msg.send') {
      lines.push(`GM message to ${Array.isArray(e.action.to) ? e.action.to.map(name).join(', ') : 'all'}: "${String(e.action.text).slice(0, 200)}"`);
    } else if (e.kind === 'action' && e.action?.t === 'player.update' && e.action.level) {
      lines.push(`${name(e.action.playerId)} reached level ${e.action.level}`);
    }
  }
  return lines.slice(-300).join('\n') || '(nothing logged this session)';
}
