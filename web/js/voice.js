// System voice playback (moved out of stage.js so the GM desk can be the audio device).
// Strictly sequential: the server releases one line at a time; a new `play` preempts the current
// one (P0 interrupts). The player acks every line with `audio.done` (or after a safety timeout).
//
//   const vp = createVoicePlayer({ ack: (id) => client.raw({ t: 'audio.done', id }), onSub, onDuck });
//   vp.unlock() inside a user gesture; vp.play(msg); vp.stop();
//
// Optional (GM desk with ElevenLabs): resolveAudio(m) -> Promise<url|null> for lines whose `tts` hint asks
// for server audio (falls back to browser speech on null / error / RENDER_WAIT_MS); onStart(m) when sound
// actually starts (the desk then sends `audio.started` so the TV shows the subtitle in sync);
// onRender(bool) while a line is being rendered.

const RENDER_WAIT_MS = 7000;

export function createVoicePlayer({ ack, onSub = () => {}, onDuck = () => {}, resolveAudio = null, onStart = () => {}, onRender = () => {} } = {}) {
  let current = null; // { id, cancel() }
  let unlocked = false;
  let voicesCache = [];
  let holdUntil = 0; // a stinger is playing: start the next line after it (boss intro, defeat)
  let held = null;

  function loadVoices() {
    try { voicesCache = speechSynthesis.getVoices() || []; } catch { voicesCache = []; }
  }
  if (typeof speechSynthesis !== 'undefined') {
    loadVoices();
    try { speechSynthesis.addEventListener('voiceschanged', loadVoices); } catch {}
  }

  function pickVoice(v) {
    const list = voicesCache.length ? voicesCache : (loadVoices(), voicesCache);
    if (!list.length) return null;
    const prefer = Array.isArray(v?.prefer) ? v.prefer : [];
    for (const name of prefer) {
      const hit = list.find((x) => x.name.toLowerCase().includes(String(name).toLowerCase()));
      if (hit) return hit;
    }
    const lang = (v?.lang || 'en-US').toLowerCase();
    return list.find((x) => x.lang?.toLowerCase() === lang)
      || list.find((x) => x.lang?.toLowerCase().startsWith(lang.slice(0, 2)))
      || null;
  }

  function speak(m, done, isFinished) {
    if (isFinished()) return;
    if (typeof speechSynthesis === 'undefined' || !m.text) { onStart(m); setTimeout(done, Math.min(8000, 1500 + (m.text || '').length * 55)); return; }
    try {
      const v = typeof m.voice === 'object' && m.voice ? m.voice : {};
      const u = new SpeechSynthesisUtterance(m.text);
      const voice = pickVoice(v);
      if (voice) u.voice = voice;
      u.lang = voice?.lang || v.lang || 'en-US';
      u.rate = Number.isFinite(v.rate) ? v.rate : 1.0;
      u.pitch = Number.isFinite(v.pitch) ? v.pitch : 0.8;
      const t0 = performance.now();
      const readMs = Math.min(8000, 1200 + m.text.length * 50);
      // If speech fails or ends implausibly fast (no voices installed), keep the subtitle up for reading time.
      const finish = () => {
        const left = readMs - (performance.now() - t0);
        if (left > 300 && performance.now() - t0 < 400) setTimeout(() => { if (!isFinished()) done(); }, left);
        else done();
      };
      u.onend = finish;
      u.onerror = finish;
      let started = false;
      u.onstart = () => { if (!started) { started = true; onStart(m); } };
      setTimeout(() => { if (!started && !isFinished()) { started = true; onStart(m); } }, 400); // some engines never fire onstart
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch {
      setTimeout(done, 3000);
    }
  }

  function play(m) {
    const wait = holdUntil - Date.now();
    if (wait > 0) {
      clearTimeout(held);
      onSub('');
      held = setTimeout(() => { held = null; play(m); }, wait);
      return;
    }
    if (current) { const c = current; current = null; c.cancel(); }
    let finished = false;
    let audio = null;
    let safety = null;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(safety);
      ack?.(m.id);
      if (current?.id === m.id) { current = null; onSub(''); onDuck(false); }
    };
    const cancel = () => {
      finished = true;
      clearTimeout(safety);
      if (audio) { try { audio.pause(); audio.src = ''; } catch {} }
      try { speechSynthesis.cancel(); } catch {}
    };
    current = { id: m.id, cancel };
    // 12 s per protocol for normal lines; long read-alouds (recaps) get time proportional to length.
    const arm = () => {
      clearTimeout(safety);
      safety = setTimeout(() => { cancel(); finished = false; done(); }, Math.max(12000, (m.text || '').length * 85));
    };
    arm();
    onSub(m.text || '');
    onDuck(true);
    // Before the first user gesture audio is locked: show the subtitle for reading time, then release.
    if (!unlocked) { onStart(m); setTimeout(done, Math.min(8000, 1500 + (m.text || '').length * 50)); return; }
    const fallback = () => { if (!finished) speak(m, done, () => finished); };
    const playUrl = (url) => {
      if (finished) return;
      audio = new Audio(url);
      audio.onended = done;
      audio.onplaying = () => { arm(); onStart(m); };
      audio.onerror = fallback; // fall back to browser speech if the file is missing
      audio.play().catch(fallback);
    };
    if (m.audio) playUrl(m.audio);
    else if (m.tts && resolveAudio) {
      // ElevenLabs: cached → instant; otherwise the server renders it now (1–2 s).
      let settled = false;
      const settle = (url) => {
        if (settled) return;
        settled = true;
        clearTimeout(wait);
        onRender(false);
        if (url) playUrl(url); else fallback();
      };
      const wait = setTimeout(() => settle(null), RENDER_WAIT_MS);
      if (!m.tts.cached) onRender(true);
      Promise.resolve().then(() => resolveAudio(m)).then(settle, () => settle(null));
    } else {
      speak(m, done, () => finished);
    }
  }

  function stop() {
    clearTimeout(held);
    held = null;
    if (current) {
      const c = current;
      current = null;
      c.cancel();
      // Server already dropped its queue on queue.clear; acknowledge so it never waits on us.
      ack?.(c.id);
    }
    try { speechSynthesis.cancel(); } catch {}
    onSub('');
    onDuck(false);
  }

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch {}
    try {
      const a = new Audio();
      a.muted = true;
      a.play().catch(() => {});
    } catch {}
    loadVoices();
  }

  return { play, stop, unlock, holdFor(ms) { holdUntil = Date.now() + ms; }, get unlocked() { return unlocked; }, get playing() { return current?.id ?? null; } };
}

/** How long the TV waits for the GM desk's `audio.started` before showing a line anyway. */
export const SYNC_WAIT_MS = 3000;

/**
 * Reading-time subtitle only (the page that is NOT the audio device): no audio, no ack.
 * A `play` with `sync: true` waits until the audio device reports `audio.started` (or SYNC_WAIT_MS).
 */
export function createSubtitleOnly(onSub) {
  let t = null;
  let holdUntil = 0;
  let waiting = null; // { id, show }
  const api = {
    holdFor(ms) { holdUntil = Date.now() + ms; },
    play(m) {
      clearTimeout(t);
      const wait = holdUntil - Date.now();
      if (wait > 0) { t = setTimeout(() => api.play(m), wait); return; }
      const show = () => {
        waiting = null;
        clearTimeout(t);
        onSub(m.text || '');
        t = setTimeout(() => onSub(''), Math.min(12000, 1800 + (m.text || '').length * 60));
      };
      if (m.sync) {
        onSub('');
        waiting = { id: m.id, show };
        t = setTimeout(show, SYNC_WAIT_MS);
        return;
      }
      show();
    },
    /** The audio device started line `id`. */
    started(id) { if (waiting && waiting.id === id) waiting.show(); },
    stop() { clearTimeout(t); waiting = null; onSub(''); },
  };
  return api;
}

/** Holds TV moments (achievement / announcement takeovers) until their voice line starts. */
export function createCueGate({ wait = SYNC_WAIT_MS } = {}) {
  const pending = new Map();
  return {
    /** Runs fn now, or (for an event with voiceCue) once `release(eventId)` arrives or after `wait` ms. */
    hold(e, fn, enabled = true) {
      if (!enabled || !e?.voiceCue || !e.id) { fn(); return; }
      let done = false;
      const go = () => { if (done) return; done = true; clearTimeout(timer); pending.delete(e.id); fn(); };
      const timer = setTimeout(go, wait);
      pending.set(e.id, go);
    },
    release(cue) { if (cue) pending.get(cue)?.(); },
    get size() { return pending.size; },
  };
}
