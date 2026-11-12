// Procedural show stingers (WebAudio, no files): boss intro, hit, heal, phase change, defeat
// fanfare, dice tumble, nat 20 / nat 1, countdown tick + klaxon, scene whoosh.
// Used by whichever page is the audio device (GM desk by default, or the stage).
//
//   const s = createStingers(); s.unlock() (inside a user gesture); s.play('bossIntro');

/** Pace of the boss intro (same factor as scenes/boss.js INTRO_PACE; kept here so this file has no imports). */
const INTRO_PACE = 1.5;

const NOTE = (n) => 440 * 2 ** ((n - 69) / 12); // MIDI → Hz

export function createStingers({ volume = 0.8 } = {}) {
  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let enabled = true;

  function ensure() {
    if (ctx) return ctx;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(comp).connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const ch = noiseBuf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    return ctx;
  }

  /* ---------- building blocks ---------- */

  function gainEnv(t, { a = 0.005, hold = 0, d = 0.3, peak = 0.5 }, dest = master) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.setValueAtTime(Math.max(0.0002, peak), t + a + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + d);
    g.connect(dest);
    return g;
  }

  function tone(t, { type = 'sine', f = 440, to = null, dur = 0.3, a = 0.005, peak = 0.3, hold = 0, detune = 0, filter = null }) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + a + hold + dur);
    o.detune.value = detune;
    const g = gainEnv(t, { a, hold, d: dur, peak });
    let head = g;
    if (filter) {
      const bq = ctx.createBiquadFilter();
      bq.type = filter.type || 'lowpass';
      bq.frequency.setValueAtTime(filter.f, t);
      if (filter.to) bq.frequency.exponentialRampToValueAtTime(filter.to, t + (filter.at ?? dur));
      if (filter.back) bq.frequency.exponentialRampToValueAtTime(filter.back, t + a + hold + dur);
      bq.Q.value = filter.q ?? 1;
      bq.connect(g);
      head = bq;
    }
    o.connect(head);
    o.start(t);
    o.stop(t + a + hold + dur + 0.05);
  }

  function noise(t, { dur = 0.3, a = 0.005, hold = 0, peak = 0.4, type = 'lowpass', f = 1000, to = null, q = 0.8 }) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const bq = ctx.createBiquadFilter();
    bq.type = type;
    bq.frequency.setValueAtTime(f, t);
    if (to) bq.frequency.exponentialRampToValueAtTime(to, t + a + hold + dur);
    bq.Q.value = q;
    src.connect(bq).connect(gainEnv(t, { a, hold, d: dur, peak }));
    src.start(t, Math.random());
    src.stop(t + a + hold + dur + 0.05);
  }

  function impact(t, peak = 0.9) {
    noise(t, { dur: 0.7, peak: peak * 0.8, f: 900, to: 80 });
    tone(t, { f: 90, to: 32, dur: 0.8, peak });
    tone(t, { type: 'square', f: 1800, to: 600, dur: 0.08, peak: peak * 0.12 });
  }

  function chord(t, notes, { type = 'sawtooth', dur = 1.2, a = 0.02, hold = 0.2, peak = 0.12, f = 500, to = 2600, back = 500 } = {}) {
    for (const [i, n] of notes.entries()) {
      tone(t, { type, f: NOTE(n), dur, a, hold, peak, detune: i % 2 ? 7 : -7, filter: { f, to, back, at: a + hold * 0.5 + 0.1, q: 0.7 } });
    }
  }

  /* ---------- the stingers ---------- */

  const S = {
    bossIntro(t) {
      // siren, sub drone, impact on the shake, swell, braam on the reveal, slam on the name card.
      // Paced with the TV cinematic (scenes/boss.js INTRO_PACE = 1.5).
      const P = INTRO_PACE;
      for (let i = 0; i < 9; i++) tone(t + i * 0.25, { type: 'square', f: i % 2 ? 880 : 660, dur: 0.2, a: 0.01, peak: 0.07, filter: { type: 'bandpass', f: 1200, q: 2 } });
      tone(t, { f: 55, to: 38, a: 1.2 * P, hold: 1.4 * P, dur: 1.2 * P, peak: 0.45 });
      impact(t + 1.6 * P, 0.8);
      noise(t + 2.4 * P, { a: 0.8 * P, dur: 0.05, peak: 0.25, type: 'highpass', f: 600, to: 5000 });
      impact(t + 3.2 * P, 1);
      chord(t + 3.2 * P, [33, 45, 52, 57], { dur: 2.2 * P, hold: 0.6 * P, peak: 0.14, f: 260, to: 2400, back: 380 });
      impact(t + 3.6 * P, 0.6);
    },
    hit(t) {
      noise(t, { dur: 0.16, peak: 0.6, f: 1600, to: 200 });
      tone(t, { f: 160, to: 48, dur: 0.22, peak: 0.7 });
    },
    heal(t) {
      [76, 80, 83, 88].forEach((n, i) => tone(t + i * 0.06, { type: 'triangle', f: NOTE(n), dur: 0.5, peak: 0.08 }));
    },
    phase(t) {
      noise(t, { a: 0.85, dur: 0.05, peak: 0.3, type: 'bandpass', f: 300, to: 5000, q: 3 });
      tone(t, { type: 'sawtooth', f: 110, to: 440, a: 0.85, dur: 0.05, peak: 0.06 });
      impact(t + 0.9, 0.9);
      chord(t + 0.9, [38, 50, 53, 57], { dur: 1.4, hold: 0.3, peak: 0.13, f: 300, to: 2200, back: 400 });
    },
    defeat(t) {
      noise(t, { dur: 1.8, peak: 1, f: 1400, to: 60 });
      tone(t, { f: 70, to: 25, dur: 1.4, peak: 0.9 });
      impact(t + 0.05, 0.7);
      const f = t + 1.3;
      [72, 76, 79, 84].forEach((n, i) => tone(f + i * 0.13, { type: 'square', f: NOTE(n), dur: 0.16, hold: 0.04, peak: 0.07, filter: { f: 3000 } }));
      chord(f + 0.6, [60, 64, 67, 72, 48], { type: 'sawtooth', dur: 1.8, hold: 0.7, peak: 0.1, f: 800, to: 3600, back: 900 });
      [84, 88, 91].forEach((n, i) => tone(f + 0.6 + i * 0.02, { type: 'triangle', f: NOTE(n), dur: 1.6, hold: 0.4, peak: 0.05 }));
    },
    tumble(t) {
      for (let i = 0; i < 12; i++) {
        const at = t + i * 0.14 + Math.random() * 0.05;
        noise(at, { dur: 0.04, peak: 0.25 - i * 0.012, type: 'bandpass', f: 2200 + Math.random() * 1800, q: 4 });
      }
      noise(t + 1.85, { dur: 0.09, peak: 0.45, type: 'bandpass', f: 1600, q: 3 });
    },
    nat20(t) {
      [67, 72, 76, 79].forEach((n, i) => tone(t + i * 0.09, { type: 'square', f: NOTE(n), dur: 0.14, hold: 0.03, peak: 0.07, filter: { f: 3500 } }));
      chord(t + 0.4, [67, 71, 74, 79], { dur: 1.4, hold: 0.4, peak: 0.09, f: 1000, to: 4200, back: 1200 });
    },
    nat1(t) {
      [[58, 0], [57, 0.35], [56, 0.7]].forEach(([n, at]) => tone(t + at, { type: 'sawtooth', f: NOTE(n), dur: 0.3, hold: 0.02, peak: 0.1, filter: { f: 900 } }));
      tone(t + 1.05, { type: 'sawtooth', f: NOTE(55), to: NOTE(50), hold: 0.5, dur: 0.6, peak: 0.1, filter: { f: 800 } });
    },
    tick(t) {
      tone(t, { type: 'square', f: 1400, dur: 0.03, peak: 0.08 });
    },
    klaxon(t) {
      for (let i = 0; i < 3; i++) {
        tone(t + i * 0.6, { type: 'sawtooth', f: 220, dur: 0.4, hold: 0.1, peak: 0.12, filter: { f: 1400 } });
        tone(t + i * 0.6, { type: 'sawtooth', f: 233, dur: 0.4, hold: 0.1, peak: 0.12, filter: { f: 1400 } });
      }
    },
    whoosh(t) {
      noise(t, { a: 0.18, dur: 0.35, peak: 0.16, type: 'bandpass', f: 400, to: 3000, q: 1.5 });
    },
  };

  return {
    names: Object.keys(S),
    /** Call from a click/keypress: browsers start audio only after a user gesture. */
    unlock() {
      const c = ensure();
      if (c && c.state === 'suspended') c.resume().catch(() => {});
      return !!c;
    },
    get ready() { return !!ctx && ctx.state === 'running'; },
    get enabled() { return enabled; },
    set enabled(v) { enabled = !!v; },
    setVolume(v) { volume = v; if (master) master.gain.value = v; },
    play(name) {
      if (!enabled || !S[name]) return false;
      const c = ensure();
      if (!c) return false;
      if (c.state === 'suspended') c.resume().catch(() => {});
      try { S[name](c.currentTime + 0.03); } catch (err) { console.error('[sting]', err); return false; }
      return true;
    },
  };
}

/** How long a stinger needs before the System voice may start (ms). */
export const VOICE_HOLD = { bossIntro: Math.round(3900 * INTRO_PACE), defeat: 2600, phase: 1200 };

/** Which stinger an event (or scene change) should fire. */
export function stingFor(e) {
  switch (e?.kind) {
    case 'boss.intro': return 'bossIntro';
    case 'boss.hit': return 'hit';
    case 'boss.heal': return 'heal';
    case 'boss.phase': return 'phase';
    case 'boss.defeat': return 'defeat';
    default: return null;
  }
}
