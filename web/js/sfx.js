// SFX pads engine for the GM desk (the notebook is the audio device, wired to the soundbar).
// Core pads: /sfx/manifest.json (original sounds made by tools/gen_sfx.mjs). Packs add or override pads
// by id with sfx.json (view.gm.sfx: [{ id, label, url, hotkey?, volume? }]).
//
//   const board = createSfxBoard();   board.setPads(list); board.unlock(); board.play(id); board.stopAll();
//   board.setVolume(id, v) / board.setMaster(v) / board.duck(on) / board.onChange = () => {...}
// Graph: source → pad gain → routing sends → channel merger → master gain → duck gain → compressor → speakers.
//
// Surround: pads carry `route` (front | rear | center | all) and `sub` (0..1, low-pass send to the LFE).
// With a 5.1 output (Windows speaker setup 5.1/7.1, browser reports ≥ 6 channels) channels are
// L R C LFE SL SR; on stereo everything folds into L/R and `sub` becomes a bass boost (the soundbar's
// bass management still sends it to the subwoofer). board.setLayout('auto' | 'stereo' | '51').

const store = {
  get(k, d) { try { const v = localStorage.getItem(`system.sfx.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`system.sfx.${k}`, JSON.stringify(v)); } catch {} },
};

export const DUCK_LEVEL = 0.35;
export const ROUTES = ['front', 'rear', 'center', 'all'];
const SUB_HZ = 110;

/** Core manifest (generated) + pack pads; a pack pad with a core id replaces it in place. */
export function mergePads(core = [], packPads = []) {
  const out = core.map((p) => ({ ...p, source: 'core' }));
  for (const p of packPads) {
    if (!p?.id || !p.url) continue;
    const i = out.findIndex((x) => x.id === p.id);
    const pad = { ...(i >= 0 ? out[i] : {}), ...p, hotkey: p.hotkey || (i >= 0 ? out[i].hotkey : null), source: 'pack' };
    if (i >= 0) out[i] = pad; else out.push(pad);
  }
  // A hotkey belongs to the first pad that claims it.
  const taken = new Set();
  for (const p of out) {
    if (p.hotkey && taken.has(p.hotkey)) p.hotkey = null;
    if (p.hotkey) taken.add(p.hotkey);
  }
  return out;
}

export async function loadCoreManifest(url = '/sfx/manifest.json') {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return [];
    const j = await res.json();
    return (j.pads || []).map((p) => ({ id: p.id, label: p.label, url: `/sfx/${p.file}`, hotkey: p.hotkey || null, volume: p.volume ?? 1, duration: p.duration ?? null, route: p.route || 'front', sub: p.sub ?? 0, group: p.group || '' }));
  } catch {
    return [];
  }
}

export function createSfxBoard() {
  let ctx = null;
  let master = null;
  let duckGain = null;
  let pads = [];
  const buffers = new Map(); // url -> Promise<AudioBuffer>
  const playing = new Map(); // id -> { src, gain, startedAt, duration }
  const vols = store.get('vol', {});
  let masterVol = store.get('master', 0.8);
  let ducked = false;
  let layout = store.get('layout', 'auto'); // auto | stereo | 51
  let channels = 2;
  let maxChannels = 0;
  let merger = null;

  const discrete = (node, n) => { try { node.channelCount = n; node.channelCountMode = 'explicit'; node.channelInterpretation = 'discrete'; } catch {} return node; };

  function ensure() {
    if (ctx) return ctx;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    maxChannels = ctx.destination.maxChannelCount || 2;
    channels = layout !== 'stereo' && maxChannels >= 6 ? 6 : 2;
    if (channels === 6) {
      try { discrete(ctx.destination, 6); } catch { channels = 2; }
    }
    const comp = discrete(ctx.createDynamicsCompressor(), channels);
    comp.threshold.value = -10;
    comp.ratio.value = 4;
    duckGain = discrete(ctx.createGain(), channels);
    master = discrete(ctx.createGain(), channels);
    master.gain.value = masterVol;
    merger = ctx.createChannelMerger(channels);
    merger.connect(master);
    master.connect(duckGain).connect(comp).connect(ctx.destination);
    return ctx;
  }

  /** Wires a pad's gain node into the merger by its route / sub (5.1 or folded to stereo). */
  function route(pad, buf, gain) {
    const c = ctx;
    const split = c.createChannelSplitter(2);
    gain.connect(split);
    const L = 0, R = buf.numberOfChannels > 1 ? 1 : 0; // mono buffers feed both sides from channel 0
    const send = (from, to, g) => { const n = c.createGain(); n.gain.value = g; split.connect(n, from); n.connect(merger, 0, to); };
    const r = ROUTES.includes(pad.route) ? pad.route : 'front';
    if (channels === 6) {
      if (r === 'front' || r === 'all') { send(L, 0, 1); send(R, 1, 1); }
      if (r === 'rear' || r === 'all') { send(L, 4, r === 'all' ? 0.8 : 1); send(R, 5, r === 'all' ? 0.8 : 1); }
      if (r === 'center') { send(L, 2, 0.75); send(R, 2, 0.75); }
      if (r === 'all') { send(L, 2, 0.4); send(R, 2, 0.4); }
    } else {
      const g = r === 'rear' ? 0.85 : 1;
      if (r === 'center') { send(L, 0, 0.75); send(R, 0, 0.75); send(L, 1, 0.75); send(R, 1, 0.75); }
      else { send(L, 0, g); send(R, 1, g); }
    }
    const sub = Math.max(0, Math.min(1, Number(pad.sub) || 0));
    if (sub > 0) {
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = SUB_HZ; lp.Q.value = 0.7;
      const mix = c.createGain(); mix.gain.value = 0.5;
      split.connect(mix, L); if (R !== L) split.connect(mix, R);
      mix.connect(lp);
      const out = c.createGain();
      lp.connect(out);
      if (channels === 6) { out.gain.value = sub * 1.4; out.connect(merger, 0, 3); }
      else { out.gain.value = sub * 0.6; out.connect(merger, 0, 0); out.connect(merger, 0, 1); }
    }
  }

  function load(pad) {
    if (!buffers.has(pad.url)) {
      const p = fetch(pad.url)
        .then((r) => { if (!r.ok) throw new Error(`${pad.url}: ${r.status}`); return r.arrayBuffer(); })
        .then((b) => new Promise((res, rej) => ensure().decodeAudioData(b, res, rej)));
      p.catch(() => buffers.delete(pad.url));
      buffers.set(pad.url, p);
    }
    return buffers.get(pad.url);
  }

  const padVol = (id) => {
    const pad = pads.find((p) => p.id === id);
    return vols[id] ?? pad?.volume ?? 1;
  };
  const changed = () => { try { api.onChange?.(); } catch {} };

  function stop(id, fade = 0.06) {
    const cur = playing.get(id);
    if (!cur) return;
    playing.delete(id);
    try {
      const t = ctx.currentTime;
      cur.gain.gain.cancelScheduledValues(t);
      cur.gain.gain.setValueAtTime(cur.gain.gain.value, t);
      cur.gain.gain.linearRampToValueAtTime(0, t + fade);
      cur.src.stop(t + fade + 0.01);
    } catch {}
    changed();
  }

  const api = {
    onChange: null,
    get pads() { return pads; },
    get ready() { return !!ctx && ctx.state === 'running'; },
    get master() { return masterVol; },
    get ducked() { return ducked; },
    /** Output: { layout: 'auto'|'stereo'|'51', channels: 2|6 in use, max: what the browser reports (0 = not started yet) }. */
    get output() { return { layout, channels, max: maxChannels }; },
    /** Switch output layout; rebuilds the audio graph on the next play/unlock. */
    setLayout(v) {
      if (!['auto', 'stereo', '51'].includes(v)) return;
      layout = v; store.set('layout', v);
      for (const id of [...playing.keys()]) stop(id, 0.02);
      if (ctx) { const old = ctx; ctx = null; merger = null; old.close?.().catch(() => {}); }
      ensure(); ctx?.resume?.().catch(() => {});
      changed();
    },
    setPads(list) {
      pads = list;
      if (ctx) for (const p of pads) load(p).catch(() => {});
      changed();
    },
    /** Inside a user gesture. Also preloads every pad. */
    unlock() {
      const c = ensure();
      if (!c) return false;
      if (c.state === 'suspended') c.resume().catch(() => {});
      for (const p of pads) load(p).catch(() => {});
      return true;
    },
    async play(id) {
      const pad = pads.find((p) => p.id === id);
      if (!pad) return false;
      const c = ensure();
      if (!c) return false;
      if (c.state === 'suspended') await c.resume().catch(() => {});
      let buf;
      try { buf = await load(pad); } catch (e) { console.warn('[sfx]', e.message); pad.error = true; changed(); return false; }
      stop(id, 0.03); // retrigger restarts the pad
      const src = c.createBufferSource();
      src.buffer = buf;
      const gain = c.createGain();
      gain.gain.value = padVol(id);
      src.connect(gain);
      route(pad, buf, gain);
      const entry = { src, gain, startedAt: c.currentTime, duration: buf.duration };
      playing.set(id, entry);
      src.onended = () => { if (playing.get(id) === entry) { playing.delete(id); changed(); } };
      src.start();
      changed();
      return true;
    },
    stop,
    stopAll() { for (const id of [...playing.keys()]) stop(id, 0.12); },
    isPlaying: (id) => playing.has(id),
    /** 0..1 progress of a playing pad, or null. */
    progress(id) {
      const p = playing.get(id);
      if (!p || !ctx) return null;
      return Math.min(1, (ctx.currentTime - p.startedAt) / p.duration);
    },
    get anyPlaying() { return playing.size > 0; },
    volume: padVol,
    setVolume(id, v) {
      vols[id] = Math.max(0, Math.min(1.5, v));
      store.set('vol', vols);
      const p = playing.get(id);
      if (p) p.gain.gain.value = vols[id];
    },
    setMaster(v) {
      masterVol = Math.max(0, Math.min(1, v));
      store.set('master', masterVol);
      if (master) master.gain.setTargetAtTime(masterVol, ctx.currentTime, 0.02);
    },
    /** Lower the pads while the System speaks (Spotify cannot be ducked from a web page). */
    duck(on) {
      ducked = !!on;
      if (duckGain) duckGain.gain.setTargetAtTime(on ? DUCK_LEVEL : 1, ctx.currentTime, on ? 0.05 : 0.25);
      changed();
    },
  };
  return api;
}

/** "Shift+Digit1" → "⇧1", "Shift+KeyQ" → "⇧Q" (layoutMap from navigator.keyboard when available). */
export function hotkeyLabel(hk, layoutMap = null) {
  const m = /^Shift\+(Digit([0-9])|Key([A-Z]))$/.exec(hk || '');
  if (!m) return '';
  const code = m[1];
  const ch = m[2] ?? (layoutMap?.get?.(code)?.toUpperCase() || m[3]);
  return `⇧${ch}`;
}
