#!/usr/bin/env node
// Offline generator for the GM desk's SFX pads (Show → Sound). Every sound is ORIGINAL and made here
// from scratch with plain JavaScript synthesis (oscillators, noise, filters, envelopes, a small
// reverb) — no samples, no downloads, no third-party audio. Deterministic (seeded RNG): running it
// twice gives the same files.
//
//   node tools/gen_sfx.mjs [outDir]        default outDir: web/sfx
//
// Output: <outDir>/<id>.mp3 (mono, 96 kb/s) when ffmpeg is on PATH, otherwise <id>.wav (16-bit mono),
// plus <outDir>/manifest.json: [{ id, label, file, hotkey, volume, duration }] — read by web/js/sfx.js.
// Packs add or override pads with their own sfx.json + audio/sfx/<file> (docs/CONTENT_PACKS.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SR = 44100;

/* ---------------- primitives ---------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOTE = (n) => 440 * 2 ** ((n - 69) / 12);
const lerp = (a, b, k) => a + (b - a) * k;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const expo = (a, b, k) => a * (b / a) ** clamp(k, 0, 1); // exponential sweep a→b

/** Envelope: attack (linear), hold, exponential-ish release to silence. Returns gain at local time t. */
const env = ({ a = 0.005, h = 0, d = 0.3, curve = 4 } = {}) => (t) => {
  if (t < 0) return 0;
  if (t < a) return t / a;
  if (t < a + h) return 1;
  const k = (t - a - h) / d;
  return k >= 1 ? 0 : Math.exp(-curve * k) * (1 - k);
};

function polyBlep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

/** Adds an oscillator into `out` starting at `at` seconds. f/amp may be numbers or fn(localT). */
function osc(out, { at = 0, dur, type = 'sine', f, amp = 1, gain = 0.3, phase = 0, pw = 0.5, fm = null }) {
  const s0 = Math.floor(at * SR);
  const n = Math.floor(dur * SR);
  let ph = phase;
  const fF = typeof f === 'function' ? f : () => f;
  const aF = typeof amp === 'function' ? amp : () => amp;
  for (let i = 0; i < n; i++) {
    const j = s0 + i;
    if (j < 0 || j >= out.length) continue;
    const t = i / SR;
    let freq = fF(t);
    if (fm) freq += fm(t);
    const dt = Math.min(0.45, Math.abs(freq) / SR);
    let v;
    if (type === 'sine') v = Math.sin(2 * Math.PI * ph);
    else if (type === 'tri') v = 1 - 4 * Math.abs(ph - 0.5);
    else if (type === 'saw') v = 2 * ph - 1 - polyBlep(ph, dt);
    else if (type === 'square' || type === 'pulse') {
      v = ph < pw ? 1 : -1;
      v += polyBlep(ph, dt);
      v -= polyBlep((ph + 1 - pw) % 1, dt);
    } else v = 0;
    out[j] += v * aF(t) * gain;
    ph += freq / SR;
    ph -= Math.floor(ph);
  }
}

/** FM bell / metallic tone: carrier f, modulator f*ratio, decaying index. */
function bell(out, { at = 0, dur = 2, f, ratio = 3.5, index = 4, gain = 0.25, decay = 2.5, a = 0.002 }) {
  const s0 = Math.floor(at * SR);
  const n = Math.floor(dur * SR);
  for (let i = 0; i < n; i++) {
    const j = s0 + i;
    if (j >= out.length) break;
    const t = i / SR;
    const e = (t < a ? t / a : 1) * Math.exp(-decay * t);
    const m = Math.sin(2 * Math.PI * f * ratio * t) * index * Math.exp(-decay * 1.6 * t);
    out[j] += Math.sin(2 * Math.PI * f * t + m) * e * gain;
  }
}

/** Biquad (RBJ cookbook). type: lp | hp | bp | peak. */
class Biquad {
  constructor(type = 'lp') { this.type = type; this.x1 = this.x2 = this.y1 = this.y2 = 0; this.set(1000, 0.707); }
  set(f, q = 0.707, gainDb = 0) {
    const w = (2 * Math.PI * clamp(f, 10, SR * 0.45)) / SR;
    const c = Math.cos(w);
    const s = Math.sin(w);
    const al = s / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    if (this.type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (this.type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (this.type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else {
      const A = 10 ** (gainDb / 40);
      b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/** Filters a fresh buffer in place; f may be fn(t) (coefficients updated every 32 samples). */
function filt(buf, type, f, q = 0.707, from = 0) {
  const bq = new Biquad(type);
  const fF = typeof f === 'function' ? f : () => f;
  for (let i = Math.floor(from * SR); i < buf.length; i++) {
    if ((i & 31) === 0) bq.set(fF(i / SR), q);
    buf[i] = bq.run(buf[i]);
  }
  return buf;
}

/** Noise burst into its own buffer (white or pink), shaped by amp(t), filtered, then mixed in. */
function noise(out, rng, { at = 0, dur, amp = 1, gain = 0.3, color = 'white', filters = [] }) {
  const n = Math.floor(dur * SR);
  const b = new Float32Array(n);
  let p0 = 0, p1 = 0, p2 = 0, br = 0;
  for (let i = 0; i < n; i++) {
    const w = rng() * 2 - 1;
    if (color === 'pink') {
      p0 = 0.99765 * p0 + w * 0.099046; p1 = 0.963 * p1 + w * 0.2965164; p2 = 0.57 * p2 + w * 1.0526913;
      b[i] = (p0 + p1 + p2 + w * 0.1848) * 0.2;
    } else if (color === 'brown') {
      br = (br + w * 0.02) / 1.002;
      b[i] = br * 3.5;
    } else b[i] = w;
  }
  for (const fl of filters) filt(b, fl.type, fl.f, fl.q ?? 0.707);
  mix(out, b, at, typeof amp === 'function' ? amp : () => amp, gain);
}

function mix(out, src, at = 0, amp = () => 1, gain = 1) {
  const s0 = Math.floor(at * SR);
  for (let i = 0; i < src.length; i++) {
    const j = s0 + i;
    if (j < 0) continue;
    if (j >= out.length) break;
    out[j] += src[i] * amp(i / SR) * gain;
  }
}

const drive = (buf, k = 2) => { const n = Math.tanh(k); for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * k) / n; return buf; };

/** Small Schroeder/Freeverb-style mono reverb, mixed back into the buffer. */
function reverb(buf, { wet = 0.25, size = 0.82, damp = 0.35 } = {}) {
  const combs = [1116, 1188, 1277, 1356, 1422, 1491].map((d) => ({ d: new Float32Array(d), i: 0, lp: 0 }));
  const aps = [556, 441, 341].map((d) => ({ d: new Float32Array(d), i: 0 }));
  const out = new Float32Array(buf.length);
  for (let n = 0; n < buf.length; n++) {
    const x = buf[n] * 0.12;
    let y = 0;
    for (const c of combs) {
      const v = c.d[c.i];
      c.lp = v * (1 - damp) + c.lp * damp;
      c.d[c.i] = x + c.lp * size;
      c.i = (c.i + 1) % c.d.length;
      y += v;
    }
    for (const a of aps) {
      const v = a.d[a.i];
      const o = -y + v;
      a.d[a.i] = y + v * 0.5;
      a.i = (a.i + 1) % a.d.length;
      y = o;
    }
    out[n] = y;
  }
  for (let n = 0; n < buf.length; n++) buf[n] = buf[n] * (1 - wet * 0.5) + out[n] * wet;
  return buf;
}

/** Loudness-ish normalisation: RMS of the loud part to a target, gentle tanh limiter, fades. */
function finish(buf, { rms = 0.14, peak = 0.95 } = {}) {
  filt(buf, 'hp', 25, 0.7); // DC / sub-rumble blocker (brown noise drifts)
  let sum = 0, cnt = 0;
  const win = 1024;
  const levels = [];
  for (let i = 0; i < buf.length; i += win) {
    let s = 0;
    for (let j = i; j < Math.min(buf.length, i + win); j++) s += buf[j] * buf[j];
    levels.push(s / win);
  }
  const loud = [...levels].sort((a, b) => b - a).slice(0, Math.max(4, Math.ceil(levels.length * 0.4)));
  for (const l of loud) { sum += l; cnt++; }
  const cur = Math.sqrt(sum / Math.max(1, cnt)) || 1e-6;
  const g = rms / cur;
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * g * 1.1) / 1.1;
  let mx = 0;
  for (const v of buf) mx = Math.max(mx, Math.abs(v));
  if (mx > peak) for (let i = 0; i < buf.length; i++) buf[i] *= peak / mx;
  const fade = Math.floor(0.004 * SR);
  for (let i = 0; i < fade && i < buf.length; i++) { buf[i] *= i / fade; buf[buf.length - 1 - i] *= i / fade; }
  // Trim trailing silence (below -60 dBFS), keep 50 ms of tail.
  let end = buf.length;
  while (end > SR * 0.2 && Math.abs(buf[end - 1]) < 0.001) end--;
  return buf.subarray(0, Math.min(buf.length, end + Math.floor(0.05 * SR)));
}

const make = (sec) => new Float32Array(Math.ceil(sec * SR));

/* ---------------- building blocks ---------------- */

function impact(out, rng, at, k = 1) {
  noise(out, rng, { at, dur: 0.9, gain: 0.7 * k, amp: env({ a: 0.001, d: 0.9, curve: 5 }), filters: [{ type: 'lp', f: (t) => expo(5000, 70, t / 0.6) }] });
  osc(out, { at, dur: 1.0, f: (t) => expo(95, 32, t / 0.7), amp: env({ a: 0.002, d: 1.0, curve: 3 }), gain: 0.9 * k });
}

function snare(out, rng, at, k = 1) {
  noise(out, rng, { at, dur: 0.12, gain: 0.5 * k, amp: env({ a: 0.0008, d: 0.12, curve: 6 }), filters: [{ type: 'hp', f: 1800 }, { type: 'peak', f: 4500, q: 0.8 }] });
  osc(out, { at, dur: 0.08, f: (t) => expo(240, 170, t / 0.08), amp: env({ a: 0.0008, d: 0.08, curve: 5 }), gain: 0.35 * k });
}

function cymbal(out, rng, at, dur = 1.8, k = 1) {
  const b = new Float32Array(Math.floor(dur * SR));
  for (const f of [205.3, 304.4, 369.6, 522.7, 540, 800]) osc(b, { dur, type: 'square', f: f * 1.7, gain: 0.12, amp: env({ a: 0.001, d: dur, curve: 4 }) });
  filt(b, 'hp', 6500, 0.7);
  mix(out, b, at, () => 1, k);
  noise(out, rng, { at, dur, gain: 0.25 * k, amp: env({ a: 0.001, d: dur, curve: 4.5 }), filters: [{ type: 'hp', f: 5000 }] });
}

/** A crowd "voice": a sawtooth with a vowel through two formant band-passes. */
function voice(out, { at, dur, f0, f1, f2, gain, attack = 0.15, glide = 1, vib = 5, rng }) {
  const b = make(dur);
  const vr = 4 + rng() * 3;
  osc(b, { dur, type: 'saw', f: (t) => f0 * lerp(1, glide, t / dur) * (1 + 0.012 * vib * Math.sin(2 * Math.PI * vr * t)), gain: 1, amp: env({ a: attack, h: dur * 0.45, d: dur * 0.55 - attack, curve: 2 }) });
  const x = Float32Array.from(b);
  filt(b, 'bp', f1, 6);
  filt(x, 'bp', f2, 8);
  for (let i = 0; i < b.length; i++) b[i] = b[i] + x[i] * 0.6;
  mix(out, b, at, () => 1, gain);
}

/* ---------------- the pads ---------------- */

export const PADS = [
  { id: 'boss_sting', label: 'Boss sting', seed: 11, sec: 3.2, build(o, r) {
    impact(o, r, 0.02, 1);
    const b = make(3);
    for (const [n, det] of [[26, -9], [38, 7], [45, -5], [50, 11], [38, -13]]) {
      osc(b, { dur: 2.8, type: 'saw', f: NOTE(n) * 2 ** (det / 1200), gain: 0.16, amp: env({ a: 0.03, h: 0.6, d: 2.1, curve: 2.5 }) });
    }
    filt(b, 'lp', (t) => (t < 0.25 ? expo(180, 2400, t / 0.25) : expo(2400, 320, (t - 0.25) / 1.8)), 1.4);
    drive(b, 2.5);
    mix(o, b, 0.02, () => 1, 0.8);
    reverb(o, { wet: 0.35, size: 0.86 });
  } },
  { id: 'phase_change', label: 'Phase change', seed: 12, sec: 3, build(o, r) {
    noise(o, r, { dur: 1.25, gain: 0.35, amp: (t) => (t / 1.25) ** 2, filters: [{ type: 'bp', f: (t) => expo(250, 7000, t / 1.25), q: 2.5 }] });
    osc(o, { dur: 1.25, type: 'saw', f: (t) => expo(80, 900, t / 1.25), amp: (t) => (t / 1.25) ** 2, gain: 0.12 });
    impact(o, r, 1.25, 0.9);
    const b = make(1.8);
    for (const n of [38, 50, 53, 57, 62]) osc(b, { dur: 1.7, type: 'saw', f: NOTE(n), gain: 0.12, amp: env({ a: 0.01, h: 0.25, d: 1.4, curve: 3 }) });
    filt(b, 'lp', (t) => expo(3000, 400, t / 1.4), 1);
    mix(o, b, 1.25, () => 1, 0.9);
    reverb(o, { wet: 0.3 });
  } },
  { id: 'victory_fanfare', label: 'Victory fanfare', seed: 13, sec: 3.6, build(o, r) {
    const brass = (at, n, dur, g = 0.14) => {
      const b = make(dur + 0.1);
      for (const det of [-6, 0, 7]) osc(b, { dur, type: 'saw', f: (t) => NOTE(n) * 2 ** (det / 1200) * (1 + (t > 0.25 ? 0.006 * Math.sin(2 * Math.PI * 5.5 * t) : 0)), gain: g, amp: env({ a: 0.025, h: dur * 0.6, d: dur * 0.4, curve: 3 }) });
      filt(b, 'lp', (t) => (t < 0.06 ? expo(400, 3800, t / 0.06) : expo(3800, 1800, (t - 0.06) / dur)), 0.9);
      mix(o, b, at);
    };
    const timp = (at, f, k = 1) => {
      osc(o, { at, dur: 0.9, f: (t) => expo(f * 1.15, f, t / 0.08), amp: env({ a: 0.002, d: 0.9, curve: 4 }), gain: 0.5 * k });
      noise(o, r, { at, dur: 0.12, gain: 0.15 * k, amp: env({ a: 0.001, d: 0.12 }), filters: [{ type: 'lp', f: 1200 }] });
    };
    timp(0, 98);
    brass(0, 67, 0.13); brass(0.15, 67, 0.13); brass(0.3, 67, 0.13);
    brass(0.45, 72, 0.5);
    brass(0.98, 70, 0.25); brass(1.25, 74, 0.25);
    timp(1.52, 65, 1.1);
    for (const n of [60, 64, 67, 72, 76]) brass(1.52, n, 1.7, 0.09);
    cymbal(o, r, 1.52, 2, 0.5);
    reverb(o, { wet: 0.3 });
  } },
  { id: 'death', label: 'Death', seed: 14, sec: 4.2, build(o, r) {
    bell(o, { f: 98, ratio: 1.4, index: 5, decay: 0.9, dur: 4, gain: 0.35 });
    bell(o, { at: 0.01, f: 196.5, ratio: 2.76, index: 2, decay: 1.4, dur: 3, gain: 0.12 });
    [64, 61, 57, 52].forEach((n, i) => osc(o, { at: 0.35 + i * 0.32, dur: 0.6, type: 'tri', f: NOTE(n), gain: 0.16, amp: env({ a: 0.01, h: 0.12, d: 0.45 }) }));
    osc(o, { at: 1.6, dur: 2, type: 'tri', f: (t) => expo(NOTE(45), NOTE(33), t / 2), gain: 0.18, amp: env({ a: 0.02, h: 0.4, d: 1.5, curve: 3 }) });
    noise(o, r, { at: 0.2, dur: 3.5, color: 'brown', gain: 0.4, amp: env({ a: 1, h: 0.5, d: 2, curve: 3 }), filters: [{ type: 'lp', f: 160 }] });
    reverb(o, { wet: 0.45, size: 0.88 });
  } },
  { id: 'loot_open', label: 'Loot box open', seed: 15, sec: 2.6, build(o, r) {
    creak(o, r, 0, 0.35, 0.5);
    noise(o, r, { at: 0.36, dur: 0.05, gain: 0.5, amp: env({ a: 0.0005, d: 0.05, curve: 6 }), filters: [{ type: 'bp', f: 2500, q: 3 }] });
    osc(o, { at: 0.36, dur: 0.12, f: (t) => expo(400, 120, t / 0.12), gain: 0.3, amp: env({ a: 0.001, d: 0.12 }) });
    [84, 88, 91, 96, 100, 103].forEach((n, i) => bell(o, { at: 0.45 + i * 0.07, f: NOTE(n), ratio: 2, index: 1.2, decay: 2.5, dur: 1.6, gain: 0.09 }));
    for (let i = 0; i < 40; i++) {
      const at = 0.5 + r() * 1.4;
      osc(o, { at, dur: 0.08, f: 3000 + r() * 4000, gain: 0.03 * (1 - (at - 0.5) / 1.6), amp: env({ a: 0.001, d: 0.08 }) });
    }
    noise(o, r, { at: 0.45, dur: 1.4, gain: 0.06, amp: env({ a: 0.3, d: 1.1 }), filters: [{ type: 'hp', f: 6000 }] });
    reverb(o, { wet: 0.35 });
  } },
  { id: 'achievement', label: 'Achievement chime', seed: 16, sec: 2.4, build(o) {
    bell(o, { f: NOTE(88), ratio: 3.5, index: 2.2, decay: 2.2, dur: 2.2, gain: 0.22 });
    bell(o, { at: 0.16, f: NOTE(95), ratio: 3.5, index: 2.2, decay: 1.8, dur: 2.2, gain: 0.22 });
    for (const n of [76, 83, 88]) osc(o, { at: 0.16, dur: 1.8, type: 'tri', f: NOTE(n), gain: 0.04, amp: env({ a: 0.08, h: 0.3, d: 1.3 }) });
    reverb(o, { wet: 0.35 });
  } },
  { id: 'crowd_cheer', label: 'Crowd cheer', seed: 17, sec: 3.8, build(o, r) {
    const shape = (t) => clamp(t / 0.35, 0, 1) * (t < 1.6 ? 1 : Math.exp(-(t - 1.6) * 1.6));
    noise(o, r, { dur: 3.6, color: 'pink', gain: 0.5, amp: shape, filters: [{ type: 'bp', f: 1100, q: 0.6 }, { type: 'lp', f: 5000 }] });
    const vowels = [[750, 1200], [650, 1700], [550, 1000], [800, 1350]];
    for (let i = 0; i < 34; i++) {
      const [f1, f2] = vowels[i % vowels.length];
      const dur = 1.2 + r() * 1.6;
      voice(o, { at: r() * 0.45, dur, f0: 200 + r() * 260, f1: f1 * (0.9 + r() * 0.2), f2: f2 * (0.9 + r() * 0.2), gain: 0.05, attack: 0.08 + r() * 0.15, glide: 1.05 + r() * 0.25, rng: r });
    }
    for (let i = 0; i < 70; i++) {
      const at = 0.15 + r() * 2.6;
      noise(o, r, { at, dur: 0.03, gain: 0.12 * shape(at), amp: env({ a: 0.0005, d: 0.03, curve: 6 }), filters: [{ type: 'bp', f: 1200 + r() * 1400, q: 1.5 }] });
    }
    for (let i = 0; i < 3; i++) {
      const at = 0.3 + r() * 1.2;
      const f = 1800 + r() * 900;
      osc(o, { at, dur: 0.6, f: (t) => f * (1 + 0.3 * Math.min(1, t / 0.2)) * (t > 0.3 ? 1 - 0.25 * (t - 0.3) : 1), gain: 0.035, amp: env({ a: 0.04, h: 0.25, d: 0.3 }) });
    }
    reverb(o, { wet: 0.3, size: 0.8 });
  } },
  { id: 'crowd_boo', label: 'Crowd boo', seed: 18, sec: 3.2, build(o, r) {
    for (let i = 0; i < 30; i++) {
      const dur = 1.6 + r() * 1.2;
      voice(o, { at: r() * 0.35, dur, f0: 95 + r() * 110, f1: 320 + r() * 60, f2: 780 + r() * 120, gain: 0.08, attack: 0.15 + r() * 0.2, glide: 0.82 + r() * 0.08, vib: 3, rng: r });
    }
    noise(o, r, { dur: 2.8, color: 'pink', gain: 0.18, amp: (t) => clamp(t / 0.4, 0, 1) * Math.exp(-Math.max(0, t - 1.4) * 1.4), filters: [{ type: 'lp', f: 600 }] });
    reverb(o, { wet: 0.25 });
  } },
  { id: 'crowd_gasp', label: 'Crowd gasp', seed: 19, sec: 1.8, build(o, r) {
    for (let i = 0; i < 26; i++) {
      const at = r() * 0.12;
      noise(o, r, { at, dur: 0.75, gain: 0.07, amp: env({ a: 0.09 + r() * 0.06, h: 0.08, d: 0.5, curve: 3 }), filters: [{ type: 'bp', f: (t) => expo(700 + r() * 300, 2000 + r() * 800, t / 0.3), q: 3 }] });
    }
    for (let i = 0; i < 12; i++) {
      voice(o, { at: 0.05 + r() * 0.1, dur: 0.55, f0: 260 + r() * 200, f1: 520, f2: 900, gain: 0.05, attack: 0.05, glide: 1.25, rng: r });
    }
    reverb(o, { wet: 0.3 });
  } },
  { id: 'hype_horn', label: 'Hype horn', seed: 20, sec: 2.6, build(o) {
    const blast = (at, dur) => {
      const b = make(dur + 0.05);
      for (const [f, g] of [[422, 0.18], [428, 0.16], [563, 0.1], [845, 0.06]]) {
        osc(b, { dur, type: 'saw', f: (t) => f * (t < 0.04 ? 0.94 + 1.5 * t : 1), gain: g, amp: env({ a: 0.012, h: dur - 0.06, d: 0.05, curve: 2 }) });
      }
      filt(b, 'lp', 3200, 1.2);
      filt(b, 'peak', 1400, 1.5);
      drive(b, 3);
      mix(o, b, at);
    };
    blast(0, 0.17); blast(0.26, 0.17); blast(0.52, 1.2);
    reverb(o, { wet: 0.25 });
  } },
  { id: 'drumroll', label: 'Drumroll', seed: 21, sec: 4.4, build(o, r) {
    const end = 2.6;
    for (let t = 0; t < end;) {
      const k = t / end;
      snare(o, r, t, 0.2 + 0.8 * k ** 1.5);
      t += 1 / (16 + 8 * k) + (r() - 0.5) * 0.006;
    }
    snare(o, r, end, 1.4);
    impact(o, r, end, 0.6);
    cymbal(o, r, end, 1.8, 1);
    reverb(o, { wet: 0.2 });
  } },
  { id: 'fail', label: 'Fail trombone', seed: 22, sec: 3.4, build(o, r) {
    const horn = (at, n, dur, wah = 0) => {
      const b = make(dur + 0.1);
      osc(b, { dur, type: 'saw', f: (t) => NOTE(n) * (t < 0.05 ? 0.97 + 0.6 * t : 1) * (wah ? 1 + 0.02 * Math.sin(2 * Math.PI * 5 * t) * Math.min(1, t / 0.4) : 1) * (wah ? 1 - 0.04 * Math.max(0, t - dur + 0.6) : 1), gain: 0.3, amp: env({ a: 0.04, h: dur * 0.7, d: dur * 0.3, curve: 2 }) });
      filt(b, 'lp', (t) => (wah ? 900 + 700 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 2.5 * t - 1.5)) : (t < 0.1 ? expo(400, 1500, t / 0.1) : 1200)), 2.5);
      mix(o, b, at);
      noise(o, r, { at, dur: 0.08, gain: 0.04, amp: env({ a: 0.01, d: 0.07 }), filters: [{ type: 'bp', f: 900, q: 2 }] });
    };
    horn(0, 62, 0.42); horn(0.5, 61, 0.42); horn(1.0, 60, 0.42); horn(1.5, 59, 1.6, 1);
    reverb(o, { wet: 0.22 });
  } },
  { id: 'alarm_collapse', label: 'Alarm / floor collapse', seed: 23, sec: 4.6, build(o, r) {
    const b = make(2.7);
    for (let i = 0; i < 8; i++) {
      const f = i % 2 ? NOTE(65) : NOTE(69);
      osc(b, { at: i * 0.32, dur: 0.3, type: 'saw', f, gain: 0.18, amp: env({ a: 0.01, h: 0.24, d: 0.05, curve: 2 }) });
      osc(b, { at: i * 0.32, dur: 0.3, type: 'square', f: f * 1.01, gain: 0.08, amp: env({ a: 0.01, h: 0.24, d: 0.05, curve: 2 }) });
    }
    filt(b, 'bp', 1100, 0.9);
    drive(b, 2);
    mix(o, b, 0, () => 1, 0.9);
    noise(o, r, { dur: 4.2, color: 'brown', gain: 0.9, amp: (t) => clamp(t / 2.4, 0, 1) ** 2 * (t > 2.6 ? Math.exp(-(t - 2.6) * 1.2) : 1), filters: [{ type: 'lp', f: 140 }] });
    for (let i = 0; i < 90; i++) {
      const at = 1 + (r() ** 0.6) * 2.8;
      noise(o, r, { at, dur: 0.05 + r() * 0.1, gain: 0.25 * r(), amp: env({ a: 0.001, d: 0.1, curve: 5 }), filters: [{ type: 'lp', f: 300 + r() * 2500 }] });
    }
    impact(o, r, 2.6, 1.2);
    reverb(o, { wet: 0.3, size: 0.86 });
  } },
  { id: 'door_creak', label: 'Door creak', seed: 24, sec: 2.4, build(o, r) { creak(o, r, 0, 2.1, 1); reverb(o, { wet: 0.3, size: 0.78 }); } },
  { id: 'magic_zap', label: 'Magic zap', seed: 25, sec: 1.8, build(o, r) {
    const n = Math.floor(0.4 * SR);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const fc = expo(2600, 180, t / 0.3);
      const m = Math.sin(2 * Math.PI * fc * 1.5 * t) * 6 * Math.exp(-4 * t);
      o[i] += Math.sin(2 * Math.PI * fc * t + m) * env({ a: 0.002, d: 0.4, curve: 3 })(t) * 0.35;
    }
    noise(o, r, { dur: 0.35, gain: 0.25, amp: env({ a: 0.002, d: 0.35, curve: 4 }), filters: [{ type: 'bp', f: (t) => expo(6000, 600, t / 0.3), q: 2 }] });
    for (let i = 0; i < 30; i++) {
      const at = 0.1 + r() * 0.9;
      bell(o, { at, f: 2200 + r() * 4500, ratio: 1.5, index: 0.8, decay: 9, dur: 0.3, gain: 0.04 });
    }
    reverb(o, { wet: 0.35 });
  } },
  { id: 'explosion', label: 'Explosion', seed: 26, sec: 4, build(o, r) {
    noise(o, r, { dur: 0.03, gain: 0.9, amp: env({ a: 0.0005, d: 0.03 }) });
    noise(o, r, { dur: 3.2, color: 'pink', gain: 1.4, amp: env({ a: 0.003, h: 0.05, d: 3, curve: 4 }), filters: [{ type: 'lp', f: (t) => expo(7000, 120, t / 1.6), q: 0.9 }] });
    osc(o, { dur: 1.2, f: (t) => expo(70, 28, t / 1.1), gain: 1, amp: env({ a: 0.003, d: 1.2, curve: 2.5 }) });
    for (let i = 0; i < 120; i++) {
      const at = 0.05 + (r() ** 1.8) * 2.4;
      noise(o, r, { at, dur: 0.012, gain: 0.35 * Math.exp(-at), amp: env({ a: 0.0005, d: 0.012 }), filters: [{ type: 'hp', f: 1500 }] });
    }
    drive(o, 1.8);
    reverb(o, { wet: 0.3, size: 0.85 });
  } },
  // ---- combat (auto mode cues on the GM desk) ----
  { id: 'swing', label: 'Swing / whoosh', seed: 31, sec: 0.7, build(o, r) {
    noise(o, r, { dur: 0.45, color: 'pink', gain: 0.9, amp: (t) => Math.sin(Math.PI * clamp(t / 0.42, 0, 1)) ** 2, filters: [{ type: 'bp', f: (t) => expo(380, 2600, t / 0.4), q: 1.6 }] });
    noise(o, r, { at: 0.05, dur: 0.3, gain: 0.25, amp: (t) => Math.sin(Math.PI * clamp(t / 0.3, 0, 1)), filters: [{ type: 'hp', f: 3000 }] });
  } },
  { id: 'whiff', label: 'Miss / whiff', seed: 32, sec: 1.1, build(o, r) {
    noise(o, r, { dur: 0.32, color: 'pink', gain: 0.7, amp: (t) => Math.sin(Math.PI * clamp(t / 0.3, 0, 1)) ** 2, filters: [{ type: 'bp', f: (t) => expo(2400, 500, t / 0.3), q: 2 }] });
    osc(o, { at: 0.28, dur: 0.5, type: 'tri', f: (t) => expo(NOTE(76), NOTE(64), t / 0.45), gain: 0.18, amp: env({ a: 0.01, d: 0.5, curve: 3 }) });
    osc(o, { at: 0.3, dur: 0.4, type: 'sine', f: (t) => expo(NOTE(88), NOTE(79), t / 0.4), gain: 0.07, amp: env({ a: 0.01, d: 0.4 }) });
    reverb(o, { wet: 0.2 });
  } },
  { id: 'impact', label: 'Hit / impact', seed: 33, sec: 0.9, build(o, r) {
    noise(o, r, { dur: 0.06, gain: 0.9, amp: env({ a: 0.0005, d: 0.06, curve: 5 }), filters: [{ type: 'lp', f: 4500 }] });
    osc(o, { dur: 0.35, f: (t) => expo(140, 48, t / 0.25), gain: 1.1, amp: env({ a: 0.001, d: 0.35, curve: 4 }) });
    noise(o, r, { at: 0.005, dur: 0.25, color: 'brown', gain: 0.8, amp: env({ a: 0.001, d: 0.25, curve: 5 }), filters: [{ type: 'lp', f: 900 }] });
    drive(o, 2.2);
  } },
  { id: 'crit_hit', label: 'Critical hit', seed: 34, sec: 1.8, build(o, r) {
    impact(o, r, 0, 0.8);
    noise(o, r, { dur: 0.05, gain: 0.8, amp: env({ a: 0.0005, d: 0.05 }), filters: [{ type: 'hp', f: 2000 }] });
    for (const [n, k] of [[84, 0], [91, 0.04], [96, 0.08]]) bell(o, { at: 0.03 + k, f: NOTE(n), ratio: 2.01, index: 1.5, decay: 3, dur: 1.4, gain: 0.12 });
    drive(o, 1.6);
    reverb(o, { wet: 0.3 });
  } },
  { id: 'ko', label: 'Crawler down (KO)', seed: 35, sec: 2.6, build(o, r) {
    impact(o, r, 0, 1.1);
    [76, 72, 67, 60].forEach((n, i) => osc(o, { at: 0.12 + i * 0.16, dur: 0.3, type: 'square', pw: 0.3, f: NOTE(n), gain: 0.09, amp: env({ a: 0.005, h: 0.08, d: 0.2 }) }));
    osc(o, { at: 0.8, dur: 1.4, type: 'tri', f: (t) => expo(NOTE(48), NOTE(36), t / 1.3), gain: 0.22, amp: env({ a: 0.01, h: 0.3, d: 1.1, curve: 3 }) });
    bell(o, { at: 0.75, f: 110, ratio: 1.41, index: 3, decay: 1.6, dur: 1.8, gain: 0.18 });
    reverb(o, { wet: 0.35, size: 0.85 });
  } },
  { id: 'shatter', label: 'Mob killed (shatter)', seed: 36, sec: 1.8, build(o, r) {
    osc(o, { dur: 0.3, f: (t) => expo(110, 40, t / 0.3), gain: 0.7, amp: env({ a: 0.001, d: 0.3, curve: 4 }) });
    noise(o, r, { dur: 0.5, gain: 0.5, amp: env({ a: 0.001, d: 0.5, curve: 4 }), filters: [{ type: 'hp', f: 2500 }] });
    for (let i = 0; i < 45; i++) {
      const at = 0.01 + (r() ** 1.6) * 0.9;
      bell(o, { at, f: 1800 + r() * 5200, ratio: 2.4 + r(), index: 1.2, decay: 14 + r() * 10, dur: 0.25, gain: 0.07 * (1 - at) });
    }
    reverb(o, { wet: 0.25 });
  } },
  { id: 'round_bell', label: 'Round start (bell)', seed: 37, sec: 2.6, build(o) {
    for (const at of [0, 0.32]) {
      bell(o, { at, f: 1180, ratio: 2.76, index: 2.2, decay: 1.6, dur: 2.2, gain: 0.3 });
      bell(o, { at, f: 1180 * 2.02, ratio: 1.5, index: 0.8, decay: 2.4, dur: 1.6, gain: 0.08 });
    }
    reverb(o, { wet: 0.3, size: 0.8 });
  } },
  { id: 'signal_lost', label: 'Signal lost (defeat)', seed: 38, sec: 3.4, build(o, r) {
    osc(o, { dur: 0.9, type: 'saw', f: (t) => expo(NOTE(57), NOTE(33), t / 0.9), gain: 0.25, amp: env({ a: 0.01, h: 0.3, d: 0.6 }) });
    noise(o, r, { at: 0.5, dur: 2.6, gain: 0.55, amp: (t) => (t < 0.05 ? t / 0.05 : 1) * (t > 2.1 ? Math.max(0, 1 - (t - 2.1) / 0.5) : 1) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 13 * t)), filters: [{ type: 'bp', f: 2600, q: 0.6 }] });
    osc(o, { at: 0.55, dur: 2.5, type: 'sine', f: 1000, gain: 0.12, amp: (t) => (t > 2.0 ? Math.max(0, 1 - (t - 2.0) / 0.5) : 1) });
    for (let i = 0; i < 12; i++) noise(o, r, { at: 0.6 + r() * 2, dur: 0.02, gain: 0.5, amp: env({ a: 0.001, d: 0.02 }) });
  } },
  { id: 'crowd_aww', label: 'Crowd aww (truce)', seed: 39, sec: 3, build(o, r) {
    for (let i = 0; i < 26; i++) {
      const f0 = 150 + r() * 220;
      voice(o, { at: r() * 0.25, dur: 2.2 + r() * 0.4, f0, f1: 700 + r() * 150, f2: 1100 + r() * 200, gain: 0.05, attack: 0.25, glide: 0.82 + r() * 0.05, vib: 3, rng: r });
    }
    reverb(o, { wet: 0.4, size: 0.86 });
  } },
  { id: 'sponsor_chime', label: 'Sponsor chime', seed: 40, sec: 2.8, build(o) {
    [72, 76, 79, 84].forEach((n, i) => bell(o, { at: i * 0.11, f: NOTE(n), ratio: 3.01, index: 1.8, decay: 2.2, dur: 2.2, gain: 0.16 }));
    osc(o, { at: 0.45, dur: 1.8, type: 'tri', f: NOTE(60), gain: 0.12, amp: env({ a: 0.05, h: 0.6, d: 1.1 }) });
    osc(o, { at: 0.45, dur: 1.8, type: 'tri', f: NOTE(67), gain: 0.08, amp: env({ a: 0.05, h: 0.6, d: 1.1 }) });
    reverb(o, { wet: 0.4 });
  } },
  { id: 'getaway', label: 'Getaway (they ran)', seed: 41, sec: 2.2, build(o, r) {
    for (let i = 0; i < 9; i++) osc(o, { at: i * 0.07, dur: 0.06, type: 'square', pw: 0.25, f: NOTE(72 + (i % 3) * 2), gain: 0.08, amp: env({ a: 0.002, d: 0.06 }) });
    osc(o, { at: 0.62, dur: 0.6, type: 'sine', f: (t) => expo(NOTE(60), NOTE(96), t / 0.55), gain: 0.25, amp: env({ a: 0.01, h: 0.4, d: 0.2 }) });
    noise(o, r, { at: 0.62, dur: 0.9, color: 'pink', gain: 0.7, amp: (t) => Math.sin(Math.PI * clamp(t / 0.9, 0, 1)) ** 2, filters: [{ type: 'bp', f: (t) => expo(400, 5000, t / 0.9), q: 1.4 }] });
    bell(o, { at: 1.35, f: NOTE(91), ratio: 2, index: 1, decay: 6, dur: 0.6, gain: 0.12 });
    reverb(o, { wet: 0.25 });
  } },
];

/** Stick-slip friction: an irregular impulse train exciting wood-like resonances. */
function creak(out, rng, at, dur, k) {
  const b = make(dur + 0.1);
  let t = 0;
  let rate = 28;
  while (t < dur) {
    const prog = t / dur;
    rate = clamp(rate + (rng() - 0.48) * 9, 18, 140) * (1 + 0.004 * Math.sin(prog * 9));
    const target = 30 + 90 * Math.sin(Math.PI * prog) ** 2;
    rate += (target - rate) * 0.08;
    const j = Math.floor(t * SR);
    if (j < b.length) b[j] += (0.4 + rng() * 0.6) * Math.sin(Math.PI * prog) ** 0.5;
    t += 1 / rate;
  }
  const out2 = new Float32Array(b.length);
  for (const [f, q, g] of [[520, 18, 1], [1130, 22, 0.7], [2350, 25, 0.4], [3900, 20, 0.2]]) {
    const x = Float32Array.from(b);
    filt(x, 'bp', f, q);
    for (let i = 0; i < x.length; i++) out2[i] += x[i] * g;
  }
  mix(out, out2, at, () => 1, 2.2 * k);
}

/* ---------------- output ---------------- */

export function render(pad) {
  const rng = mulberry32(pad.seed * 2654435761);
  const buf = make(pad.sec);
  pad.build(buf, rng);
  for (let i = 0; i < buf.length; i++) if (!Number.isFinite(buf[i])) buf[i] = 0;
  return finish(buf);
}

export function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(clamp(samples[i], -1, 1) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Default hotkeys: Shift + number row 1..0, then Shift + Q W E R T U I O P A S D F G H J K (physical keys, any layout). */
export const HOTKEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK'].map((c) => `Shift+${c}`);

function hasFfmpeg() {
  try { return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0; } catch { return false; }
}

export function generate(outDir, { log = console } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const ff = hasFfmpeg();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-'));
  const manifest = [];
  // Keep hand-set surround / grouping (route, sub, group) from the existing manifest across regenerations.
  let prevMeta = {};
  try { prevMeta = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8')).pads.map((p) => [p.id, { route: p.route, sub: p.sub, group: p.group }])); } catch {}
  let total = 0;
  for (const [i, pad] of PADS.entries()) {
    const s = render(pad);
    const w = wav(s);
    let file = `${pad.id}.wav`;
    if (ff) {
      const src = path.join(tmp, `${pad.id}.wav`);
      fs.writeFileSync(src, w);
      file = `${pad.id}.mp3`;
      const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', '96k', '-map_metadata', '-1', '-id3v2_version', '0', '-write_xing', '1', path.join(outDir, file)]);
      if (r.status !== 0) throw new Error(`ffmpeg failed for ${pad.id}: ${r.stderr}`);
    } else {
      fs.writeFileSync(path.join(outDir, file), w);
    }
    const size = fs.statSync(path.join(outDir, file)).size;
    total += size;
    manifest.push({ id: pad.id, label: pad.label, file, hotkey: HOTKEYS[i] ?? null, volume: 1, duration: Math.round((s.length / SR) * 100) / 100, ...(prevMeta[pad.id] ?? {}) });
    log.log(`  ${file.padEnd(22)} ${(s.length / SR).toFixed(2)} s  ${(size / 1024).toFixed(0)} KB`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of fs.readdirSync(outDir)) {
    if (/\.(mp3|wav|ogg)$/.test(f) && !manifest.some((m) => m.file === f)) fs.rmSync(path.join(outDir, f));
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ format: 'the-system-sfx/1', generator: 'tools/gen_sfx.mjs', pads: manifest }, null, 1) + '\n');
  log.log(`gen_sfx: ${manifest.length} pads, ${(total / 1024).toFixed(0)} KB total → ${outDir}${ff ? '' : ' (no ffmpeg: WAV)'}`);
  return { manifest, total };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  generate(path.resolve(process.argv[2] ?? path.join(ROOT, 'web', 'sfx')));
}
