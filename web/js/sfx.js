// SFX pads engine for the GM desk (the notebook is the audio device, wired to the soundbar).
// Core pads: /sfx/manifest.json (original sounds made by tools/gen_sfx.mjs). Packs add or override pads
// by id with sfx.json (view.gm.sfx: [{ id, label, url, hotkey?, volume? }]).
//
//   const board = createSfxBoard();   board.setPads(list); board.unlock(); board.play(id); board.stopAll();
//   board.setVolume(id, v) / board.setMaster(v) / board.duck(on) / board.onChange = () => {...}
// Graph: source → pad gain → master gain → duck gain → compressor → speakers.

const store = {
  get(k, d) { try { const v = localStorage.getItem(`system.sfx.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`system.sfx.${k}`, JSON.stringify(v)); } catch {} },
};

export const DUCK_LEVEL = 0.35;

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
    return (j.pads || []).map((p) => ({ id: p.id, label: p.label, url: `/sfx/${p.file}`, hotkey: p.hotkey || null, volume: p.volume ?? 1, duration: p.duration ?? null }));
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

  function ensure() {
    if (ctx) return ctx;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 4;
    duckGain = ctx.createGain();
    master = ctx.createGain();
    master.gain.value = masterVol;
    master.connect(duckGain).connect(comp).connect(ctx.destination);
    return ctx;
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
      src.connect(gain).connect(master);
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
