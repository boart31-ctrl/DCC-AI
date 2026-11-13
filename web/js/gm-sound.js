// GM desk → Show → Sound: SFX pads (click or Shift+hotkey), master/per-pad volume, stop all,
// the free-text announcement box (System voice + TV takeover), "Pre-render voice lines", and the
// Settings → Voice panel (ElevenLabs status, voice + model, sliders, cache, character usage).
// Music stays in the Spotify app on the notebook; we only remind the GM that its volume is theirs.
//
//   const sound = createSound({ client, act, getView, audio });   // audio = createGmAudio(...)
//   sound.el (Sound tab body), sound.settingsEl (Settings panel), sound.update(view)
import { h, toast, ask } from './client.js';
import { icon } from './ui.js';
import { createSfxBoard, loadCoreManifest, mergePads, hotkeyLabel } from './sfx.js';

const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round((n || 0) / 1024)} KB`);
const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');
const pct = (v) => `${Math.round((v ?? 0) * 100)}%`;
const plural = (n, w) => `${fmtNum(n)} ${w}${Number(n) === 1 ? '' : 's'}`;

export function createSound({ client, act, getView, audio }) {
  const board = createSfxBoard();
  let core = [];
  let packSig = '';
  let layoutMap = null;
  navigator.keyboard?.getLayoutMap?.().then((m) => { layoutMap = m; drawPads(); }).catch(() => {});
  loadCoreManifest().then((list) => { core = list; refreshPads(true); });
  audio.onUnlock(() => board.unlock());
  audio.onDuck((on) => { board.duck(on); drawVoiceState(); });
  const view = () => getView() || {};
  const tts = () => view().gm?.tts || { configured: false };

  /* ---------- top bar ---------- */
  const masterIn = h('input.snd-range', { type: 'range', min: 0, max: 1, step: 0.01, 'aria-label': 'Pads master volume' });
  masterIn.value = String(board.master);
  const masterVal = h('span.snd-val', pct(board.master));
  masterIn.addEventListener('input', () => { board.setMaster(Number(masterIn.value)); masterVal.textContent = pct(board.master); });
  const outSeg = h('div.seg.seg-sm', { role: 'radiogroup', 'aria-label': 'Speaker layout' },
    ...[['auto', 'Auto'], ['stereo', 'Stereo'], ['51', '5.1']].map(([v, l]) => h('button', { type: 'button', role: 'radio', 'data-out': v, onclick: () => { board.setLayout(v); drawOut(); } }, l)));
  const outInfo = h('span.snd-val.snd-out-info');
  function drawOut() {
    const o = board.output;
    for (const b of outSeg.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.out === o.layout));
    outInfo.textContent = !o.max ? 'click a pad to start' : o.channels === 6 ? '5.1 active' : o.layout === '51' ? `only ${o.max} ch from Windows, using stereo` : `stereo (${o.max} ch available)`;
    outInfo.title = 'Rear / sub routing needs Windows set to 5.1 or 7.1 speakers (Win+R → mmsys.cpl → Configure). Test: /speaker-test.html';
  }
  const stopBtn = h('button.btn.btn-danger.btn-sm', { type: 'button', onclick: () => board.stopAll(), title: 'Stop every pad (the System voice keeps going; Esc stops that)' }, icon('x', { size: 14 }), 'Stop all pads');
  const voiceState = h('span.snd-state', { 'aria-live': 'polite' });
  const spotify = h('span.snd-chip', { title: 'Music plays in the Spotify app on this notebook. A web page cannot lower it, so turn it down yourself when the System talks.' }, icon('info', { size: 13 }), 'Spotify volume is up to you');

  /* ---------- announcement ---------- */
  const annText = h('textarea.inp.snd-ann-in', { rows: 2, maxlength: 1000, placeholder: 'Type an announcement. Enter: the System says it and the TV shows it. Shift+Enter: new line.' });
  const annBtn = h('button.btn.btn-primary', { type: 'button', onclick: () => announce() }, icon('bolt', { size: 15 }), 'Announce');
  const annState = h('p.hint.snd-ann-state', { 'aria-live': 'polite' });
  async function announce() {
    const text = annText.value.trim();
    if (!text) { annText.focus(); return; }
    annBtn.disabled = true;
    try {
      await client.send({ t: 'announce', text });
      annText.value = '';
      annState.textContent = tts().configured ? 'Sent. The TV shows it as soon as the voice starts (rendering takes 1–2 s for new text).' : 'Sent. Spoken with the browser voice (no ElevenLabs key).';
    } catch (err) {
      toast(`Announcement failed: ${err.message}`, { error: true, ms: 4000 });
    } finally {
      annBtn.disabled = false;
    }
  }
  annText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); announce(); }
  });

  /* ---------- pads ---------- */
  const grid = h('div.snd-pads', { role: 'group', 'aria-label': 'Sound effects' });
  const padEls = new Map();
  function refreshPads(force = false) {
    // Pack sound library (sounds.json) joins the pads: variants, kind (pad / music / ambience / random), tags.
    const lib = (view().gm?.sounds || []).map((x) => ({ id: x.id, label: x.label, url: x.urls?.[0], urls: x.urls, kind: x.kind, group: x.group, route: x.route, sub: x.sub, volume: x.volume, tags: x.tags }));
    const packPads = [...(view().gm?.sfx || []), ...lib];
    const sig = JSON.stringify(packPads.map((p) => [p.id, p.url, p.urls?.length]));
    if (!force && sig === packSig) return;
    packSig = sig;
    board.setPads(mergePads(core, packPads));
    drawPads();
  }
  const search = h('input.inp.inp-sm.snd-search', { type: 'search', placeholder: 'Find a sound (name, tag, group)…', 'aria-label': 'Find a sound' });
  search.addEventListener('input', () => drawPads());
  const ROUTE_LABEL = { front: 'Front', rear: 'Rear', center: 'Center', all: 'All around' };
  const GROUP_ORDER = ['Show', 'Crowd', 'Combat', 'Dungeon', 'System', 'Comedy'];
  function drawPads() {
    padEls.clear();
    if (!board.pads.length) { grid.replaceChildren(h('p.dim', 'Loading pads…')); return; }
    const groups = new Map();
    for (const p of board.pads) { const g = p.group || 'Other'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(p); }
    const names = [...groups.keys()].sort((a, b) => ((GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99)) || a.localeCompare(b));
    const q = search.value.trim().toLowerCase();
    const hit = (p) => !q || `${p.id} ${p.label} ${(p.tags || []).join(' ')} ${p.group || ''}`.toLowerCase().includes(q);
    grid.replaceChildren(...names.flatMap((g) => {
      const list = groups.get(g).filter(hit);
      return list.length ? [h('h3.snd-group', `${g} · ${list.length}`), ...list.map((p) => padCell(p))] : [];
    }));
    drawPlaying();
  }
  function padCell(p) {
    {
      const vol = h('input.snd-range.snd-pad-vol', { type: 'range', min: 0, max: 1.5, step: 0.05, 'aria-label': `${p.label} volume`, title: 'Pad volume' });
      vol.value = String(board.volume(p.id));
      vol.addEventListener('input', () => board.setVolume(p.id, Number(vol.value)));
      vol.addEventListener('pointerdown', (e) => e.stopPropagation());
      const bar = h('i.snd-pad-bar');
      const btn = h('button.snd-pad', {
        type: 'button', 'data-id': p.id, 'aria-pressed': 'false',
        title: `${p.label}${p.hotkey ? ` (${hotkeyLabel(p.hotkey, layoutMap)})` : ''}${p.source === 'pack' ? ' · from the pack' : ''}`,
        onclick: () => { board.unlock(); if (p.kind === 'ambience' && board.isPlaying(p.id)) board.stop(p.id, 2); else board.play(p.id); },
      },
      h('span.snd-pad-l', p.label),
      h('span.snd-pad-m', p.hotkey ? h('kbd', hotkeyLabel(p.hotkey, layoutMap)) : null, p.source === 'pack' ? h('span.snd-pack', 'pack') : null,
        p.route && p.route !== 'front' ? h('span.snd-route', { title: 'Where it plays on 5.1' }, ROUTE_LABEL[p.route] || p.route) : null,
        p.sub > 0 ? h('span.snd-route', { title: 'Subwoofer send' }, 'Sub') : null,
        p.urls?.length > 1 ? h('span.snd-route', { title: 'Variants, one at random' }, `×${p.urls.length}`) : null,
        p.kind === 'ambience' ? h('span.snd-route', { title: 'Loops until clicked again' }, 'Loop') : p.kind === 'music' ? h('span.snd-route', 'Music') : null),
      bar);
      const cell = h('div.snd-cell', btn, vol);
      padEls.set(p.id, { btn, bar });
      return cell;
    }
  }
  let raf = 0;
  function drawPlaying() {
    cancelAnimationFrame(raf);
    let any = false;
    for (const [id, { btn, bar }] of padEls) {
      const pr = board.progress(id);
      const on = pr != null;
      any ||= on;
      btn.classList.toggle('is-playing', on);
      btn.setAttribute('aria-pressed', String(on));
      bar.style.transform = `scaleX(${on ? 1 - pr : 0})`;
    }
    stopBtn.disabled = !any;
    if (any) raf = requestAnimationFrame(drawPlaying);
  }
  board.onChange = () => { drawPlaying(); drawOut(); };

  // Hotkeys: Shift + physical key (e.code), any view, not while typing. Capture phase so the
  // desk's own 1–9 quip keys never fire for the same press (Czech layout: Shift+digit types a digit).
  document.addEventListener('keydown', (e) => {
    if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (document.querySelector('dialog[open]')) return;
    const pad = board.pads.find((p) => p.hotkey === `Shift+${e.code}`);
    if (!pad) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    board.unlock();
    board.play(pad.id);
    const el = padEls.get(pad.id)?.btn;
    if (el) { el.classList.remove('hit'); void el.offsetWidth; el.classList.add('hit'); }
  }, { capture: true });

  /* ---------- pre-render ---------- */
  const preBtn = h('button.btn.btn-sm', { type: 'button', onclick: () => prerender() }, icon('sparkle', { size: 14 }), 'Pre-render voice lines');
  const preStop = h('button.btn.btn-sm.btn-quiet', { type: 'button', hidden: true, onclick: () => { stopRun = true; } }, 'Stop');
  const preBar = h('div.snd-prog', { hidden: true }, h('i'));
  const preInfo = h('p.hint.snd-pre-info', { 'aria-live': 'polite' });
  let running = false;
  let stopRun = false;
  async function prerender() {
    if (running) return;
    let est;
    try {
      est = (await client.send({ t: 'tts.estimate' })).result;
    } catch (err) {
      toast(err.message, { error: true, ms: 5000 });
      return;
    }
    if (!est.remaining) { preInfo.textContent = `All ${est.total} known lines are already rendered and cached.`; return; }
    const kinds = Object.entries(est.byKind || {}).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ');
    const ok = await ask(`Render ${est.remaining} voice lines (${kinds}) with ElevenLabs? That is about ${fmtNum(est.chars)} characters. ElevenLabs bills by characters; each line is paid once and then played from the cache. ${est.cached} lines are already cached.`, { ok: `Render ${fmtNum(est.chars)} characters` });
    if (!ok) return;
    running = true;
    stopRun = false;
    preBtn.disabled = true;
    preStop.hidden = false;
    preBar.hidden = false;
    const exclude = [];
    let rendered = 0;
    let failed = 0;
    let spent = 0;
    const startLeft = est.remaining;
    try {
      for (;;) {
        if (stopRun) { preInfo.textContent = `Stopped. ${rendered} rendered, ${fmtNum(spent)} characters. Press again to resume (cached lines are skipped).`; break; }
        let r;
        try {
          r = (await client.send({ t: 'tts.prerender.step', confirm: true, exclude })).result;
        } catch (err) {
          preInfo.textContent = `Paused: ${err.message}. Press again to resume.`;
          break;
        }
        rendered += r.done.filter((d) => d.chars > 0).length;
        spent += r.done.reduce((s, d) => s + d.chars, 0);
        for (const f of r.failed) { exclude.push(f.hash); failed++; }
        const doneShare = startLeft ? 1 - r.remaining / startLeft : 1;
        preBar.firstChild.style.width = `${Math.round(doneShare * 100)}%`;
        preInfo.textContent = `${rendered} rendered, ${r.remaining} to go${failed ? `, ${failed} failed` : ''} · ${fmtNum(spent)} characters used`;
        if (r.fatal) { preInfo.textContent = `Stopped: ${r.fatal.msg}`; break; }
        if (!r.remaining) { preInfo.textContent = `Done. ${rendered} lines rendered (${fmtNum(spent)} characters)${failed ? `, ${failed} failed (they fall back to the browser voice)` : ''}.`; break; }
        if (!r.done.length && !r.failed.length) { preInfo.textContent = 'No progress, stopping.'; break; }
      }
    } finally {
      running = false;
      preBtn.disabled = false;
      preStop.hidden = true;
      setTimeout(() => { if (!running) preBar.hidden = true; }, 1500);
    }
  }

  function drawVoiceState() {
    const t = tts();
    const bits = [];
    if (!audio.isDevice) bits.push(h('span.dim', 'The TV is the audio device (Show → Scenes). Pads still play here.'));
    else if (!audio.unlocked) bits.push(h('span.sc-warn', icon('warn', { size: 14 }), 'Click anywhere to enable sound'));
    if (audio.rendering) bits.push(h('span.snd-chip.snd-render', h('i.snd-spin'), 'Rendering voice…'));
    else if (audio.speaking) bits.push(h('span.snd-chip.snd-speak', icon('chat', { size: 13 }), 'System speaking · pads ducked'));
    bits.push(h('span.snd-chip', { class: `snd-chip ${t.configured ? 'snd-ok' : ''}` }, t.configured ? `ElevenLabs · ${t.voiceName || t.voiceId || 'default voice'}` : 'Browser voice (no ElevenLabs key)'));
    voiceState.replaceChildren(...bits);
    spotify.classList.toggle('snd-chip-hot', audio.speaking);
    preBtn.hidden = !t.configured;
  }
  const prevChange = audio.onChange;
  audio.onChange = () => { prevChange?.(); drawVoiceState(); };

  const el = h('section.sound-panel', { 'aria-label': 'Sound' },
    h('div.snd-bar',
      h('label.snd-master', h('span', 'Pads'), masterIn, masterVal),
      h('label.snd-master', h('span', 'Speakers'), outSeg, outInfo),
      stopBtn,
      h('span.grow'),
      voiceState,
      spotify),
    h('div.snd-cols',
      h('div.snd-col-pads',
        h('div.col-head', h('h2', 'Sound pads'), h('span.dim', 'Click, or Shift + the key shown')),
        search,
        grid),
      h('div.snd-col-voice',
        h('div.col-head', h('h2', 'Announcement')),
        h('div.snd-ann', annText, annBtn),
        annState,
        h('div.col-head', h('h2', 'Voice lines')),
        h('p.hint', 'Render every pack quip, achievement announcement and boss line once, so they play instantly. Lines already cached are skipped; you can stop and resume.'),
        h('div.row-start', preBtn, preStop),
        preBar,
        preInfo)),
  );

  /* ---------- Settings → Voice ---------- */
  const sStatus = h('div.vs-status');
  const voiceSel = h('select.inp', { 'aria-label': 'Voice' });
  const modelSel = h('select.inp', { 'aria-label': 'Model' });
  const previewBtn = h('button.btn.btn-sm', { type: 'button', onclick: () => preview() }, icon('eye', { size: 14 }), 'Preview');
  const loadBtn = h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => loadLists(true) }, 'Reload list');
  const slider = (key, label, hint) => {
    const inp = h('input.snd-range', { type: 'range', min: 0, max: 1, step: 0.05, 'aria-label': label });
    const val = h('span.snd-val');
    inp.addEventListener('input', () => { val.textContent = pct(Number(inp.value)); });
    inp.addEventListener('change', () => act({ t: 'tts.config', [key]: Number(inp.value) }, `${label}: ${pct(Number(inp.value))}.`));
    return { inp, val, row: h('label.vs-slider', h('span.lbl-t', label), inp, val, h('span.lbl-hint', hint)) };
  };
  const stab = slider('stability', 'Stability', 'Lower = more expressive, higher = steadier');
  const sim = slider('similarity', 'Similarity', 'How closely it sticks to the voice');
  const achSeg = h('div.seg.seg-sm', { role: 'radiogroup', 'aria-label': 'Achievement line' },
    ...[['auto', 'Auto'], ['announce', 'Full announcement'], ['quip', 'Pack quip']].map(([v, l]) => h('button', { type: 'button', role: 'radio', 'data-ach': v, onclick: () => act({ t: 'tts.config', achievementLine: v }, `Achievement line: ${l}.`) }, l)));
  const chkDesc = h('input', { type: 'checkbox', onchange: (e) => act({ t: 'tts.config', achievementDesc: e.target.checked }) });
  const chkRew = h('input', { type: 'checkbox', onchange: (e) => act({ t: 'tts.config', achievementReward: e.target.checked }) });
  const cacheInfo = h('p.vs-cache');
  const usageInfo = h('p.vs-usage');
  const accountInfo = h('p.hint.vs-account');
  const clearBtn = h('button.btn.btn-sm.danger', { type: 'button', onclick: async () => {
    const c = tts().cache || {};
    if (!(await ask(`Delete ${c.count || 0} cached voice lines (${fmtBytes(c.bytes)})? Playing them again costs ElevenLabs characters again.`, { ok: 'Clear voice cache', danger: true }))) return;
    act({ t: 'tts.cache.clear' }, 'Voice cache cleared.');
  } }, icon('trash', { size: 14 }), 'Clear cache');
  const acctBtn = h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => account() }, 'Check account quota');
  const body = h('div.vs-body',
    h('div.vs-row', h('label.lbl', h('span.lbl-t', 'Voice'), voiceSel), previewBtn, loadBtn),
    h('p.hint', 'Only your account\'s premade voices and voices designed from a text prompt are listed. Voice clones are never used.'),
    h('label.lbl', h('span.lbl-t', 'Model'), modelSel, h('span.lbl-hint', 'Flash models are faster and cheaper per character; Multilingual v2 sounds richer.')),
    stab.row, sim.row,
    h('p.hint', 'Slider changes apply to lines rendered from now on. Clear the cache to re-render old ones.'),
    h('div.vs-sub', h('span.lbl-t', 'When an achievement is awarded the System says'), achSeg,
      h('label.chk', chkDesc, h('span', 'Include the description')), h('label.chk', chkRew, h('span', 'Include the reward'))),
    h('div.vs-sub', h('span.lbl-t', 'Cache'), cacheInfo, h('div.row-start', clearBtn)),
    h('div.vs-sub', h('span.lbl-t', 'Characters used by this campaign'), usageInfo, h('div.row-start', acctBtn), accountInfo),
  );
  const settingsEl = h('section.panel.voice-settings', { id: 'voice-settings', 'aria-labelledby': 'h-voice' },
    h('h2', { id: 'h-voice' }, 'Voice'),
    h('p.dim', 'The System voice plays on this notebook. ElevenLabs bills by characters: every new line costs its length once, then it plays from the cache for free.'),
    sStatus, body);

  let lists = { voices: null, models: null, err: null };
  let listsLoading = false;
  async function loadLists(force = false) {
    if (!tts().configured || listsLoading || (lists.voices && !force)) return;
    listsLoading = true;
    try {
      const [v, m] = await Promise.all([client.send({ t: 'tts.voices', refresh: force }), client.send({ t: 'tts.models' }).catch(() => null)]);
      lists = { voices: v.result.voices, hidden: v.result.hidden, models: m?.result?.models || null, err: null };
    } catch (err) {
      lists = { voices: null, models: null, err: err.message };
    } finally {
      listsLoading = false;
      drawSettings(true);
    }
  }
  async function preview() {
    const id = voiceSel.value || tts().voiceId;
    if (!id) return;
    previewBtn.disabled = true;
    try {
      const r = (await client.send({ t: 'tts.preview', voiceId: id })).result;
      audio.voice.unlock?.();
      const a = new Audio(await audio.ttsUrl(r.hash));
      a.play().catch(() => toast('Click the page once to enable sound, then try again.'));
    } catch (err) {
      toast(`Preview failed: ${err.message}`, { error: true, ms: 4000 });
    } finally {
      previewBtn.disabled = false;
    }
  }
  async function account() {
    try {
      const r = (await client.send({ t: 'tts.account' })).result;
      accountInfo.textContent = r.limit != null ? `ElevenLabs account (${r.tier || 'plan'}): ${fmtNum(r.used)} of ${fmtNum(r.limit)} characters used this period${r.resetsAt ? `, resets ${new Date(r.resetsAt).toLocaleDateString()}` : ''}.` : 'No quota information.';
    } catch (err) {
      accountInfo.textContent = `Could not read the account quota (${err.message}). The API key may not be allowed to read user info.`;
    }
  }
  voiceSel.addEventListener('change', () => act({ t: 'tts.config', voiceId: voiceSel.value || null }, `Voice: ${voiceSel.selectedOptions[0]?.textContent}.`));
  modelSel.addEventListener('change', () => act({ t: 'tts.config', modelId: modelSel.value || null }, `Model: ${modelSel.selectedOptions[0]?.textContent}.`));

  let setSig = '';
  function drawSettings(force = false) {
    const t = tts();
    const sig = JSON.stringify([t, lists]);
    if (!force && sig === setSig) return;
    setSig = sig;
    sStatus.replaceChildren(
      h('p', { class: t.configured ? 'vs-ok' : 'vs-off' }, icon(t.configured ? 'shield' : 'info', { size: 14 }),
        t.configured ? 'ElevenLabs key configured on the server.' : 'No ElevenLabs key on the server: the System speaks with the browser voice. Add ELEVENLABS_API_KEY as a secret (see DEPLOY.md).'),
      ...(t.lastError ? [h('p.hint.vs-err', `Last error: ${t.lastError.msg}`)] : []),
    );
    body.hidden = !t.configured;
    if (!t.configured) return;
    if (!lists.voices && !lists.err) loadLists();
    if (document.activeElement !== voiceSel) {
      const opts = lists.voices
        ? lists.voices.map((v) => h('option', { value: v.id }, `${v.name}${v.category === 'generated' ? ' (designed)' : ''}${v.labels?.accent ? ` · ${v.labels.accent}` : ''}`))
        : [h('option', { value: t.voiceId || '' }, lists.err ? `Voice list unavailable (${lists.err})` : (t.voiceName || t.voiceId || 'Loading voices…'))];
      if (t.voiceId && lists.voices && !lists.voices.some((v) => v.id === t.voiceId)) opts.unshift(h('option', { value: t.voiceId }, `${t.voiceId} (not in list)`));
      voiceSel.replaceChildren(...opts);
      voiceSel.value = t.voiceId || '';
    }
    if (document.activeElement !== modelSel) {
      const ms = lists.models || [{ id: t.modelId, name: t.modelId }];
      const opts = ms.map((m) => h('option', { value: m.id }, `${m.name}${m.costFactor != null && m.costFactor !== 1 ? ` · ×${m.costFactor} cost` : ''}`));
      if (!ms.some((m) => m.id === t.modelId)) opts.unshift(h('option', { value: t.modelId }, t.modelId));
      modelSel.replaceChildren(...opts);
      modelSel.value = t.modelId;
    }
    for (const [s, v] of [[stab, t.stability], [sim, t.similarity]]) {
      if (document.activeElement !== s.inp) s.inp.value = String(v ?? 0.5);
      s.val.textContent = pct(Number(s.inp.value));
    }
    for (const b of achSeg.children) b.setAttribute('aria-checked', String(b.dataset.ach === t.achievementLine));
    chkDesc.checked = !!t.achievementDesc;
    chkRew.checked = !!t.achievementReward;
    const c = t.cache || {};
    cacheInfo.textContent = `${plural(c.count, 'line')}, ${fmtBytes(c.bytes)} of ${fmtBytes(c.cap)}. When full, the least recently played lines are dropped.`;
    const u = t.usage || {};
    usageInfo.textContent = `${plural(u.chars, 'character')} (${plural(u.lines, 'line')} rendered). Cached replays are free.`;
  }

  function update() {
    refreshPads();
    drawVoiceState();
    drawSettings();
  }

  return { el, settingsEl, update, board };
}
