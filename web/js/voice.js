// System voice playback (moved out of stage.js so the GM desk can be the audio device).
// Strictly sequential: the server releases one line at a time; a new `play` preempts the current
// one (P0 interrupts). The player acks every line with `audio.done` (or after a safety timeout).
//
//   const vp = createVoicePlayer({ ack: (id) => client.raw({ t: 'audio.done', id }), onSub, onDuck });
//   vp.unlock() inside a user gesture; vp.play(msg); vp.stop();

export function createVoicePlayer({ ack, onSub = () => {}, onDuck = () => {} } = {}) {
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
    if (typeof speechSynthesis === 'undefined' || !m.text) { setTimeout(done, Math.min(8000, 1500 + (m.text || '').length * 55)); return; }
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
    safety = setTimeout(() => { cancel(); finished = false; done(); }, Math.max(12000, (m.text || '').length * 85));
    onSub(m.text || '');
    onDuck(true);
    // Before the first user gesture audio is locked: show the subtitle for reading time, then release.
    if (!unlocked) { setTimeout(done, Math.min(8000, 1500 + (m.text || '').length * 50)); return; }
    if (m.audio) {
      audio = new Audio(m.audio);
      audio.onended = done;
      audio.onerror = () => speak(m, done, () => finished); // fall back to TTS if the file is missing
      audio.play().catch(() => speak(m, done, () => finished));
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

/** Reading-time subtitle only (the page that is NOT the audio device): no audio, no ack. */
export function createSubtitleOnly(onSub) {
  let t = null;
  let holdUntil = 0;
  return {
    holdFor(ms) { holdUntil = Date.now() + ms; },
    play(m) {
      clearTimeout(t);
      const wait = holdUntil - Date.now();
      if (wait > 0) { t = setTimeout(() => this.play(m), wait); return; }
      onSub(m.text || '');
      t = setTimeout(() => onSub(''), Math.min(12000, 1800 + (m.text || '').length * 60));
    },
    stop() { clearTimeout(t); onSub(''); },
  };
}
