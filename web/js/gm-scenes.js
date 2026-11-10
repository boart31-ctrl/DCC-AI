// GM desk → Show → Scenes: direct what the TV shows. Scene buttons (F1–F8), per-scene forms,
// big boss controls, countdown controls, "Roll on TV", recap, the audio device switch and a live
// mini-preview of the stage. Also makes this page the audio device (System voice + stingers).
//
// Mounted from gm.js with one call: createScenes({ client, act, getView }) → { el, update(view) }.
import { h, toast } from './client.js';
import { icon, field, select, labeled } from './ui.js';
import { createGmAudio } from './gm-audio.js';

const SCENES = [
  { kind: 'lobby', label: 'Lobby', key: 'F1', hint: 'Title card + join QR' },
  { kind: 'explore', label: 'Explore', key: 'F2', hint: 'Where the party is' },
  { kind: 'boss', label: 'Boss', key: 'F3', hint: 'Boss battle' },
  { kind: 'loot', label: 'Loot', key: 'F4', hint: 'A box for one crawler' },
  { kind: 'countdown', label: 'Countdown', key: 'F5', hint: 'Floor collapse timer' },
  { kind: 'roll', label: 'Big roll', key: 'F6', hint: 'Dice on the TV' },
  { kind: 'recap', label: 'Recap', key: 'F7', hint: 'Previously on…' },
  { kind: 'blank', label: 'Blank', key: 'F8', hint: 'Logo, stand by' },
];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

const store = {
  get(k, d) { try { const v = localStorage.getItem(`system.scenes.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`system.scenes.${k}`, JSON.stringify(v)); } catch {} },
};

function fmtClock(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const p = (n) => String(n).padStart(2, '0');
  return t >= 3600 ? `${Math.floor(t / 3600)}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}` : `${p(Math.floor(t / 60))}:${p(t % 60)}`;
}

/** "Name | text | atHp" per line → phases. */
function parsePhases(src) {
  return String(src || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 10).map((l) => {
    const [name, text = '', at = ''] = l.split('|').map((x) => x.trim());
    const atHp = /^\d+$/.test(at) ? Number(at) : null;
    return { name: name.slice(0, 60), text: text.slice(0, 300), ...(atHp != null ? { atHp } : {}) };
  });
}

export function createScenes({ client, act, getView }) {
  const audio = createGmAudio({ client, getView });
  const view = () => getView() || {};
  // Drafts per scene kind (what F-keys / "Show on TV" send). Persisted per device.
  const draft = store.get('draft', {});
  const D = (k) => (draft[k] ||= {});
  const saveDraft = () => store.set('draft', draft);
  let tab = store.get('tab', 'lobby');
  let bossPick = D('boss').bossId ?? null;

  /* ---------- shell ---------- */
  const tabs = h('div.sc-tabs', { role: 'tablist', 'aria-label': 'Scenes' });
  const form = h('div.sc-form');
  const live = h('div.sc-live');
  const previewBox = h('div.sc-preview');
  const audioSeg = h('div.seg.seg-sm', { role: 'radiogroup', 'aria-label': 'Audio device' },
    h('button', { type: 'button', role: 'radio', 'data-dev': 'gm', onclick: () => setDevice('gm') }, 'GM desk'),
    h('button', { type: 'button', role: 'radio', 'data-dev': 'stage', onclick: () => setDevice('stage') }, 'TV'));
  const stingBtn = h('button.btn.btn-sm.btn-quiet', { type: 'button', 'aria-pressed': String(audio.stingersOn), onclick: () => { audio.stingersOn = !audio.stingersOn; drawAudio(); } });
  const soundState = h('span.sc-sound');
  const testBtn = h('button.btn.btn-sm.btn-quiet', { type: 'button', title: 'Play the boss stinger here', onclick: () => audio.test() }, 'Test sound');
  const previewToggle = h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => { store.set('preview', !store.get('preview', true)); drawPreview(true); } });

  const el = h('section.scenes-panel', { 'aria-label': 'Scenes' },
    h('div.sc-bar',
      h('span.sc-bar-t', 'Audio plays on'), audioSeg, stingBtn, testBtn, soundState,
      h('span.grow'),
      previewToggle),
    h('div.sc-grid',
      h('div.sc-col-l', tabs),
      h('div.sc-col-c', live, form),
      h('div.sc-col-r', previewBox, h('p.hint', 'What the TV shows right now. F1–F8 put a scene on the TV.'))),
  );

  function setDevice(d) {
    act({ t: 'show.audio', device: d }, d === 'gm' ? 'Sound plays on this desk.' : 'Sound plays on the TV.');
  }

  function drawAudio() {
    const dev = view().show?.audioDevice || 'gm';
    for (const b of audioSeg.children) b.setAttribute('aria-checked', String(b.dataset.dev === dev));
    stingBtn.setAttribute('aria-pressed', String(audio.stingersOn));
    stingBtn.replaceChildren(icon('bolt', { size: 14 }), audio.stingersOn ? 'Stingers on' : 'Stingers off');
    if (dev !== 'gm') soundState.replaceChildren(h('span.dim', 'The TV plays voice and stingers'));
    else if (!audio.unlocked) soundState.replaceChildren(h('span.sc-warn', icon('warn', { size: 14 }), 'Click anywhere on this page to enable sound'));
    else soundState.replaceChildren(h('span.sc-ok', 'Sound ready'));
    testBtn.hidden = dev !== 'gm';
  }
  audio.onChange = drawAudio;

  /* ---------- preview (the real stage page, scaled) ---------- */
  let frame = null;
  let frameSrc = '';
  function drawPreview(force = false) {
    // The preview is a whole second stage client: only while Scenes is actually on screen.
    const on = store.get('preview', true) && el.isConnected && !el.closest('[hidden]');
    previewToggle.replaceChildren(icon('tv', { size: 14 }), on ? 'Hide preview' : 'Show preview');
    const url = view().gm?.stageUrl || '';
    if (!on || !url) {
      if (frame) { frame.remove(); frame = null; frameSrc = ''; }
      previewBox.replaceChildren(h('p.dim.sc-pv-off', !url ? 'Preview appears once the host is connected.' : 'Preview hidden.'));
      return;
    }
    const src = url.replace(/\/stage(\?[^#]*)?#/, '/stage?preview=1#');
    if (frame && frameSrc === src && !force) return;
    frameSrc = src;
    frame = h('iframe.sc-pv', { title: 'TV preview', src, tabindex: '-1', loading: 'lazy' });
    previewBox.replaceChildren(h('div.sc-pv-box', frame));
  }
  // Scale the 1920x1080 stage into the box.
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
    const box = previewBox.querySelector('.sc-pv-box');
    if (box && frame) frame.style.transform = `scale(${box.clientWidth / 1920})`;
  }) : null;
  ro?.observe(previewBox);

  /* ---------- tabs ---------- */
  function drawTabs() {
    const sc = view().scene;
    tabs.replaceChildren(...SCENES.map((s) => h('button.sc-tab', {
      type: 'button', role: 'tab', 'aria-selected': String(tab === s.kind), 'data-kind': s.kind,
      class: `sc-tab${sc?.kind === s.kind ? ' is-live' : ''}`,
      onclick: () => { tab = s.kind; store.set('tab', tab); drawTabs(); drawForm(); },
    },
    h('span.sc-tab-l', s.label),
    sc?.kind === s.kind ? h('span.sc-onair', 'On TV') : h('span.sc-tab-h', s.hint),
    h('kbd', s.key))));
  }

  /* ---------- putting a scene on the TV ---------- */
  function dataFor(kind) {
    const d = { ...D(kind) };
    const v = view();
    if (kind === 'boss') {
      if (d.mode === 'adhoc') {
        return { boss: { name: d.name || 'Unnamed horror', title: d.title || '', hpSlots: Number(d.hpSlots) || 10, image: d.image || null, color: d.color || null, phases: parsePhases(d.phases), intro: d.intro || '' } };
      }
      const id = bossPick || v.library?.boss?.[0]?.id;
      return id ? { bossId: id } : null;
    }
    if (kind === 'countdown') return { label: d.label || 'Floor collapse in', seconds: Math.max(1, Math.round((Number(d.minutes) || 0) * 60 + (Number(d.seconds) || 0))) || 300, autostart: !!d.autostart };
    if (kind === 'loot') {
      const pid = d.playerId || v.players?.[0]?.id || null;
      const tier = d.tier || v.pack?.lootTiers?.[0]?.id || null;
      return { ...(pid ? { playerId: pid } : {}), ...(tier ? { tier } : {}) };
    }
    if (kind === 'roll') return d.playerId ? { playerId: d.playerId, label: d.label || '' } : { label: d.label || '' };
    if (kind === 'explore') {
      const out = { location: d.location || '', floor: d.floor || '', image: d.image || null, text: d.text || '', showFeed: d.showFeed !== false };
      if (d.locationId) out.locationId = d.locationId;
      return out;
    }
    if (kind === 'lobby') return { title: d.title || '', subtitle: d.subtitle || '', showQr: d.showQr !== false };
    if (kind === 'recap') return { title: d.title || '', text: d.text ?? (v.recap || '') };
    if (kind === 'blank') return { text: d.text || '' };
    return {};
  }

  async function showOnTv(kind) {
    const data = dataFor(kind);
    if (data === null) { toast('Pick a boss first (or build one ad hoc).', { error: true }); return false; }
    // explore: a picked location fills the fields; typed fields override it.
    if (kind === 'explore' && data.locationId) {
      const ok = await act({ t: 'scene.set', kind, data: { locationId: data.locationId, showFeed: data.showFeed } }, null);
      const over = {};
      for (const k of ['location', 'floor', 'text']) if (D('explore')[`${k}Touched`]) over[k] = data[k];
      if (ok && Object.keys(over).length) await act({ t: 'scene.update', data: over }, null);
      if (ok) toast(`On TV: ${SCENES.find((s) => s.kind === kind).label}.`);
      return ok;
    }
    return act({ t: 'scene.set', kind, data }, `On TV: ${SCENES.find((s) => s.kind === kind).label}.`);
  }

  /* ---------- live controls (what is on the TV now) ---------- */
  let cdTimer = null;
  function drawLive() {
    const sc = view().scene;
    clearInterval(cdTimer);
    if (!sc) { live.replaceChildren(); return; }
    const meta = SCENES.find((s) => s.kind === sc.kind);
    const head = h('div.sc-live-head', h('span.sc-onair', 'On TV'), h('b', meta?.label || sc.kind));
    if (sc.kind === 'boss') live.replaceChildren(head, bossControls(sc));
    else if (sc.kind === 'countdown') live.replaceChildren(head, countdownControls(sc));
    else if (sc.kind === 'loot') live.replaceChildren(head, lootControls(sc));
    else if (sc.kind === 'roll') live.replaceChildren(head, h('p.sc-line', sc.data.total == null ? `Waiting: ${sc.data.name || 'someone'} is up.` : `${sc.data.name} rolled ${sc.data.total}${sc.data.nat20 ? ' (natural 20)' : sc.data.nat1 ? ' (natural 1)' : ''}.`));
    else if (sc.kind === 'explore') live.replaceChildren(head, h('p.sc-line', [sc.data.floor, sc.data.location].filter(Boolean).join(', ') || 'Exploring'));
    else live.replaceChildren(head);
  }

  function bossLib(id) { return (view().library?.boss || []).find((b) => b.id === id) || null; }

  function bossControls(sc) {
    const d = sc.data;
    const b = d.boss;
    const lib = d.bossId ? bossLib(d.bossId) : null;
    const max = b.hpSlots;
    const next = b.phases[d.phase + 1];
    const cur = b.phases[d.phase];
    const send = (a, msg) => act(a, msg);
    const big = (label, cls, onclick, opts = {}) => h(`button.btn.sc-big${cls}`, { type: 'button', onclick, disabled: !!opts.disabled, title: opts.title || null }, label);
    const hpBar = h('div.sc-hp', { style: { '--n': String(max) } }, Array.from({ length: max }, (_, i) => h('i', { class: i < d.hp ? 'on' : '' })));
    const sug = d.suggestPhase != null && b.phases[d.suggestPhase]
      ? h('div.sc-suggest', icon('warn', { size: 16 }),
        h('span', `HP ${d.hp}: phase "${b.phases[d.suggestPhase].name}" is due.`),
        h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => send({ t: 'boss.phase', index: d.suggestPhase }, `Phase: ${b.phases[d.suggestPhase].name}.`) }, 'Advance'))
      : null;
    const tvLoot = field(d.lootHint, { placeholder: 'e.g. Silver crate incoming', onCommit: (v) => send({ t: 'scene.update', data: { lootHint: v } }, 'Loot line set.') });
    return h('div.sc-boss',
      h('div.sc-boss-top',
        h('div', h('div.sc-boss-name', b.name), b.title ? h('div.dim', b.title) : null),
        h('div.sc-boss-hp', h('b', String(d.hp)), h('span.dim', ` / ${max} HP`))),
      hpBar,
      sug,
      h('div.sc-boss-row',
        big(d.revealed ? 'Replay intro' : 'Intro', '.btn-primary.sc-intro', () => send({ t: 'boss.intro' }, 'Boss intro.'), { title: 'Cinematic + intro line' }),
        big('−1', '.sc-dmg', () => send({ t: 'boss.damage', amount: 1 }), { disabled: d.hp <= 0 }),
        big('−2', '.sc-dmg', () => send({ t: 'boss.damage', amount: 2 }), { disabled: d.hp <= 0 }),
        big('−3', '.sc-dmg', () => send({ t: 'boss.damage', amount: 3 }), { disabled: d.hp <= 0 }),
        big('+1 Heal', '.sc-heal', () => send({ t: 'boss.heal', amount: 1 }), { disabled: d.hp >= max }),
        big(next ? `Next phase: ${next.name}` : 'Last phase', '.sc-phase', () => send({ t: 'boss.phase' }, next ? `Phase: ${next.name}.` : null), { disabled: !next }),
        big(d.defeated ? 'Defeated' : 'Defeat', '.btn-danger.sc-defeat', () => send({ t: 'boss.defeat' }, 'Boss defeated.'), { disabled: d.defeated && false })),
      h('div.sc-boss-info',
        h('div.sc-gm-only',
          h('p.sc-gm-k', icon('lock', { size: 12 }), 'GM only'),
          cur ? h('p', h('b', `Phase ${ROMAN[d.phase] || d.phase + 1}: ${cur.name}. `), cur.text || '') : null,
          lib?.tactics ? h('p', h('b', 'Tactics. '), lib.tactics) : null,
          lib?.lootHint ? h('p', h('b', 'Loot. '), lib.lootHint) : null,
          !d.revealed ? h('p.dim', 'The TV shows a silhouette until you press Intro.') : null),
        labeled('Loot line on TV after defeat', tvLoot)),
    );
  }

  function countdownControls(sc) {
    const d = sc.data;
    const clock = h('div.sc-clock');
    const offset = (sc.now || Date.now()) - Date.now();
    const tick = () => {
      const left = d.running && d.endsAt ? Math.max(0, d.endsAt - (Date.now() + offset)) : d.remainingMs;
      clock.textContent = fmtClock(left);
      clock.classList.toggle('urgent', left <= 60_000);
    };
    tick();
    cdTimer = setInterval(tick, 250);
    const add = (s) => h('button.btn.btn-sm', { type: 'button', onclick: () => act({ t: 'countdown.add', seconds: s }) }, s > 0 ? `+${s >= 60 ? `${s / 60} min` : `${s} s`}` : `−${-s >= 60 ? `${-s / 60} min` : `${-s} s`}`);
    return h('div.sc-cd',
      clock,
      h('div.sc-boss-row',
        d.running
          ? h('button.btn.sc-big', { type: 'button', onclick: () => act({ t: 'countdown.pause' }, 'Paused.') }, 'Pause')
          : h('button.btn.btn-primary.sc-big', { type: 'button', disabled: d.remainingMs <= 0, onclick: () => act({ t: 'countdown.start' }, 'Countdown running.') }, 'Start'),
        add(-30), add(30), add(60), add(300),
        h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => act({ t: 'countdown.reset' }, 'Reset.') }, 'Reset')),
    );
  }

  function lootControls(sc) {
    const p = view().players?.find((x) => x.id === sc.data.playerId);
    const tier = view().pack?.lootTiers?.find((t) => t.id === sc.data.tier);
    return h('div.sc-boss-row',
      h('button.btn.btn-primary.sc-big', { type: 'button', disabled: !p || !tier, onclick: () => act({ t: 'loot.open', playerId: p.id, tier: tier.id }, `${p.name} opens the ${tier.name}.`) }, `Open the box${p ? ` for ${p.name}` : ''}`),
      h('span.dim', tier ? tier.name : 'Pick a tier below'));
  }

  /* ---------- per-scene forms (drafts) ---------- */
  function txt(kind, key, label, opts = {}) {
    return labeled(label, field(D(kind)[key] ?? opts.dflt ?? '', {
      placeholder: opts.placeholder || '', multiline: !!opts.rows, rows: opts.rows || 3,
      attrs: { maxlength: opts.max || 200 },
      onCommit: (v) => { D(kind)[key] = v; if (opts.touch) D(kind)[`${key}Touched`] = true; saveDraft(); },
    }), { cls: opts.cls || '' });
  }
  function chk(kind, key, label, dflt = true) {
    const v = D(kind)[key] ?? dflt;
    return h('label.chk', h('input', { type: 'checkbox', checked: !!v, onchange: (e) => { D(kind)[key] = e.target.checked; saveDraft(); } }), h('span', label));
  }
  function crawlerSelect(kind, { allowNone = false } = {}) {
    const ps = view().players || [];
    const opts = [...(allowNone ? [{ value: '', label: 'The GM' }] : []), ...ps.map((p) => ({ value: p.id, label: p.name }))];
    return labeled('Crawler', select(opts, D(kind).playerId || (allowNone ? '' : ps[0]?.id || ''), { onChange: (v) => { D(kind).playerId = v || null; saveDraft(); } }));
  }

  function bossPicker() {
    const list = view().library?.boss || [];
    const mode = D('boss').mode || (list.length ? 'library' : 'adhoc');
    const seg = h('div.seg.seg-sm', { role: 'radiogroup' },
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(mode === 'library'), onclick: () => { D('boss').mode = 'library'; saveDraft(); drawForm(); } }, `From the library (${list.length})`),
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(mode === 'adhoc'), onclick: () => { D('boss').mode = 'adhoc'; saveDraft(); drawForm(); } }, 'Ad hoc'));
    if (mode === 'adhoc') {
      return [seg, h('div.form-grid',
        txt('boss', 'name', 'Name', { placeholder: 'Gary, Devourer of Snacks', max: 80 }),
        txt('boss', 'title', 'Title / epithet', { placeholder: 'He was told no.', max: 120 }),
        labeled('HP slots', field(D('boss').hpSlots ?? 10, { type: 'number', attrs: { min: 1, max: 100 }, onCommit: (v) => { D('boss').hpSlots = Math.max(1, Math.min(100, Math.round(v) || 10)); saveDraft(); } })),
        labeled('Threat colour', h('input.swatch', { type: 'color', value: D('boss').color || '#ff2448', onchange: (e) => { D('boss').color = e.target.value; saveDraft(); } })),
        txt('boss', 'image', 'Image URL (optional)', { placeholder: '/pack/images/gary.webp or https://…', max: 2000, cls: 'span-2' }),
        txt('boss', 'phases', 'Phases, one per line: Name | text | at HP', { rows: 3, max: 3000, cls: 'span-all', placeholder: 'Snack time | He eats the furniture. | 10\nHangry | Everything is on fire. | 4' }),
        txt('boss', 'intro', 'Intro announcement (TV + System voice)', { rows: 2, max: 600, cls: 'span-all' }),
      )];
    }
    if (!bossPick || !list.some((b) => b.id === bossPick)) bossPick = list[0]?.id ?? null;
    return [seg, h('div.sc-bosses', list.length ? list.map((b) => h('button.sc-bosscard', {
      type: 'button', 'aria-pressed': String(b.id === bossPick),
      style: { '--th': b.color || 'var(--c-bad)' },
      onclick: () => { bossPick = b.id; D('boss').bossId = b.id; saveDraft(); drawForm(); },
    },
    h('b', b.name),
    h('span.dim', b.title || ''),
    h('span.sc-bc-meta', `${b.hpSlots} HP`, b.phases?.length ? `, ${b.phases.length} phases` : '', b.floor ? `, floor ${b.floor}` : '', b.source === 'homebrew' ? ', homebrew' : ''),
    )) : h('p.dim', 'No bosses in the pack yet. Add bosses.json, create one in the Library, or switch to Ad hoc.'))];
  }

  function locationPicker() {
    const list = view().library?.location || [];
    if (!list.length) return null;
    const cur = D('explore').locationId || '';
    const loc = list.find((l) => l.id === cur);
    return [
      labeled('Location from the pack', select([{ value: '', label: 'Type it in below' }, ...list.map((l) => ({ value: l.id, label: `${l.floor !== '' && l.floor != null ? `F${l.floor} ` : ''}${l.name}` }))], cur, {
        onChange: (v) => {
          const l = list.find((x) => x.id === v);
          Object.assign(D('explore'), l
            ? { locationId: l.id, location: l.name, floor: l.floor !== '' && l.floor != null ? `Floor ${l.floor}` : '', image: l.image || '', text: l.readAloud || '', locationTouched: false, floorTouched: false, textTouched: false }
            : { locationId: null });
          saveDraft();
          drawForm();
        },
      }), { cls: 'span-all' }),
      loc?.features?.length ? h('div.sc-gm-only.span-all', h('p.sc-gm-k', icon('lock', { size: 12 }), 'GM only: features'), h('ul', loc.features.map((f) => h('li', f)))) : null,
    ];
  }

  function drawForm() {
    const kind = tab;
    const v = view();
    const meta = SCENES.find((s) => s.kind === kind);
    const isLive = v.scene?.kind === kind;
    let body = [];
    let extra = null;
    if (kind === 'lobby') body = [txt('lobby', 'title', 'Title', { placeholder: v.pack?.systemName || 'The System', max: 80 }), txt('lobby', 'subtitle', 'Subtitle', { placeholder: 'Grab your phone. The show starts soon.', max: 160, cls: 'span-2' }), chk('lobby', 'showQr', 'Show the join QR')];
    else if (kind === 'explore') body = [locationPicker(), txt('explore', 'location', 'Location', { placeholder: 'The Food Court', max: 80, touch: true }), txt('explore', 'floor', 'Floor', { placeholder: 'Floor 2', max: 40, touch: true }), txt('explore', 'image', 'Background image URL', { placeholder: '/pack/images/…', max: 2000 }), txt('explore', 'text', 'Text on screen (read-aloud)', { rows: 3, max: 1200, cls: 'span-all', touch: true }), chk('explore', 'showFeed', 'Show the event feed')];
    else if (kind === 'boss') body = bossPicker();
    else if (kind === 'loot') body = [crawlerSelect('loot'), labeled('Box', select((v.pack?.lootTiers || []).map((t) => ({ value: t.id, label: t.name })), D('loot').tier || v.pack?.lootTiers?.[0]?.id || '', { onChange: (x) => { D('loot').tier = x; saveDraft(); } }))];
    else if (kind === 'countdown') body = [txt('countdown', 'label', 'Label', { placeholder: 'Floor collapse in', max: 80, cls: 'span-2' }),
      labeled('Minutes', field(D('countdown').minutes ?? 5, { type: 'number', attrs: { min: 0, max: 1440 }, onCommit: (x) => { D('countdown').minutes = x; saveDraft(); } })),
      labeled('Seconds', field(D('countdown').seconds ?? 0, { type: 'number', attrs: { min: 0, max: 59 }, onCommit: (x) => { D('countdown').seconds = x; saveDraft(); } })),
      chk('countdown', 'autostart', 'Start right away', false)];
    else if (kind === 'roll') {
      body = [crawlerSelect('roll', { allowNone: true }), txt('roll', 'formula', 'Dice', { placeholder: 'd20', max: 60 }), txt('roll', 'label', 'What for', { placeholder: 'Save vs. the jukebox', max: 80 })];
      extra = h('button.btn.btn-primary', { type: 'button', onclick: rollOnTv }, icon('dice', { size: 15 }), 'Roll on TV');
    } else if (kind === 'recap') body = [txt('recap', 'text', 'Recap text', { rows: 6, max: 4000, cls: 'span-all', dflt: v.recap || '', placeholder: 'Last time, our crawlers…' }), txt('recap', 'title', 'Show title', { placeholder: v.pack?.systemName || 'The System', max: 80 })];
    else if (kind === 'blank') body = [txt('blank', 'text', 'Line under the logo', { placeholder: 'Stand by', max: 160, cls: 'span-2' })];
    const actions = h('div.row-end',
      extra,
      isLive && !['boss', 'roll', 'countdown', 'loot'].includes(kind) ? h('button.btn', { type: 'button', onclick: () => act({ t: 'scene.update', data: (() => { const x = dataFor(kind); delete x.locationId; return x; })() }, 'TV updated.') }, 'Update TV') : null,
      kind === 'roll' ? null : h('button.btn.btn-primary', { type: 'button', onclick: () => showOnTv(kind) }, icon('tv', { size: 15 }), showLabel(kind, isLive, meta), h('kbd', meta.key)));
    form.replaceChildren(h('div.sc-form-head', h('h2', meta.label), h('span.dim', meta.hint)), h('div.form-grid', body.flat().filter(Boolean)), actions);
  }

  function showLabel(kind, isLive, meta) {
    if (kind === 'boss' && (D('boss').mode || 'library') !== 'adhoc') {
      const b = bossLib(bossPick);
      if (b) return isLive && view().scene?.data?.bossId === b.id ? `Restart ${b.name} on TV` : `Show ${b.name} on TV`;
    }
    return isLive ? `Restart ${meta.label.toLowerCase()} on TV` : `Show ${meta.label.toLowerCase()} on TV`;
  }

  async function rollOnTv() {
    const d = D('roll');
    const a = { t: 'scene.roll', formula: (d.formula || 'd20').trim() || 'd20' };
    if (d.playerId) a.playerId = d.playerId;
    if (d.label) a.label = d.label;
    await act(a, null);
  }

  /* ---------- keyboard: F1–F8 ---------- */
  document.addEventListener('keydown', (e) => {
    const m = /^F([1-8])$/.exec(e.key);
    if (!m || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    e.preventDefault();
    const s = SCENES[Number(m[1]) - 1];
    if (s.kind === 'roll') rollOnTv(); else showOnTv(s.kind);
  });

  /* ---------- render ---------- */
  let sig = '';
  function update(v) {
    audio.update(v);
    drawAudio();
    const s = JSON.stringify([v.scene && { ...v.scene, now: 0 }, v.players, v.library?.boss?.length, v.library?.location?.length, v.pack?.lootTiers, v.show]);
    if (s !== sig) {
      const focusIn = form.contains(document.activeElement);
      sig = s;
      drawTabs();
      drawLive();
      if (!focusIn) drawForm();
    }
    drawPreview();
  }

  /** Puts Scenes next to the existing show desk inside the Show view, with a two-way switch. */
  function mountInto(section) {
    const desk = h('div.show-desk');
    desk.append(...section.childNodes);
    const seg = h('div.seg.show-sub', { role: 'tablist', 'aria-label': 'Show' });
    const pick = (which) => {
      store.set('sub', which);
      el.hidden = which !== 'scenes';
      desk.hidden = which !== 'desk';
      for (const b of seg.children) b.setAttribute('aria-selected', String(b.dataset.sub === which));
      if (which === 'scenes') { sig = ''; update(view()); }
    };
    seg.append(
      h('button', { type: 'button', role: 'tab', 'data-sub': 'scenes', onclick: () => pick('scenes') }, icon('tv', { size: 14 }), 'Scenes'),
      h('button', { type: 'button', role: 'tab', 'data-sub': 'desk', onclick: () => pick('desk') }, 'Voice, comms, audience'));
    section.replaceChildren(h('div.show-subbar', seg), el, desk);
    pick(store.get('sub', 'scenes'));
    // Load / drop the preview when the Show view is opened or left.
    new MutationObserver(() => drawPreview()).observe(section, { attributes: true, attributeFilter: ['hidden'] });
  }

  return { el, update, audio, mountInto, refresh: () => { sig = ''; update(view()); } };
}
