// Speaker test page (web/speaker-test.html): per-channel ping, sub drop, surround demos.
const NAMES = ['left', 'right', 'center', 'subwoofer', 'rear left', 'rear right', 'side left', 'side right'];
let ctx, out, merger, channels = 2;
const $ = (s) => document.querySelector(s);

function setup() {
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  const max = ctx.destination.maxChannelCount || 2;
  channels = Math.min(max, 8);
  try {
    ctx.destination.channelCount = channels;
    ctx.destination.channelCountMode = 'explicit';
    ctx.destination.channelInterpretation = 'discrete';
  } catch (e) { channels = 2; }
  merger = ctx.createChannelMerger(Math.max(channels, 2));
  merger.connect(ctx.destination);
  $('#max').textContent = max;
  const v = $('#verdict');
  if (max >= 6) { v.innerHTML = '<span class="ok">Prohlížeč vidí vícekanálový výstup.</span> Vyzkoušej každý reproduktor, jestli opravdu hraje ten správný.'; }
  else { v.innerHTML = '<span class="warn">Jen ' + max + ' kanály (stereo).</span> Zadní reproduktory a samostatný sub z prohlížeče teď nejdou. Bas varianta B funguje i tak. Viz tip dole.'; }
  document.querySelectorAll('button[data-ch]').forEach((b) => { b.disabled = +b.dataset.ch >= channels; });
  ['#subA'].forEach((s) => { $(s).disabled = channels < 4; });
  ['#subB', '#boss', '#flyby'].forEach((s) => { $(s).disabled = false; });
  $('#crowd').disabled = channels < 6;
}

function to(ch) { const g = ctx.createGain(); g.connect(merger, 0, ch); return g; }

function noise(sec) {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * sec), ctx.sampleRate);
  const d = b.getChannelData(0); let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < d.length; i++) { // pink-ish noise
    const w = Math.random() * 2 - 1; b0 = 0.997 * b0 + w * 0.029591; b1 = 0.985 * b1 + w * 0.032534; b2 = 0.95 * b2 + w * 0.048056;
    d[i] = (b0 + b1 + b2 + w * 0.05) * 0.9;
  }
  const s = ctx.createBufferSource(); s.buffer = b; return s;
}

function env(g, t0, a, hold, r, peak = 1) {
  g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(peak, t0 + a);
  g.gain.setValueAtTime(peak, t0 + a + hold); g.gain.linearRampToValueAtTime(0, t0 + a + hold + r);
}

function speak(text) {
  try { const u = new SpeechSynthesisUtterance(text); u.lang = 'en-US'; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch {}
}

function pingChannel(ch, btn) {
  const t = ctx.currentTime + 0.05;
  if (ch === 3) { subDrop(true); }
  else {
    const n = noise(1.2), g = ctx.createGain(); env(g, t, 0.02, 0.9, 0.2, 0.5);
    n.connect(g).connect(to(ch)); n.start(t); n.stop(t + 1.2);
  }
  speak(NAMES[ch]);
  btn.classList.add('on'); setTimeout(() => btn.classList.remove('on'), 1300);
}

function subDrop(lfe) {
  const t = ctx.currentTime + 0.05, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(25, t + 2.2);
  env(g, t, 0.05, 1.8, 0.6, 0.9);
  o.connect(g);
  if (lfe && channels >= 4) g.connect(to(3)); else { g.connect(to(0)); g.connect(to(1)); }
  o.start(t); o.stop(t + 2.6);
}

function crowd() { // murmur + cheer swell from the rear pair
  const t = ctx.currentTime + 0.05;
  for (const ch of [4, 5]) {
    const n = noise(3.5), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    bp.type = 'bandpass'; bp.frequency.value = 900 + (ch - 4) * 300; bp.Q.value = 0.6;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.25, t + 0.6); g.gain.linearRampToValueAtTime(0.7, t + 2.2); g.gain.linearRampToValueAtTime(0, t + 3.4);
    n.connect(bp).connect(g).connect(to(ch)); n.start(t); n.stop(t + 3.5);
  }
}

function boss() { // sub drop + low brass-ish swell on every speaker
  subDrop(channels >= 4);
  const t = ctx.currentTime + 0.05;
  const all = channels >= 6 ? [0, 1, 2, 4, 5] : [0, 1];
  for (const f of [55, 82.5, 110]) {
    const o = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'sawtooth'; o.frequency.value = f; lp.type = 'lowpass'; lp.frequency.setValueAtTime(200, t); lp.frequency.linearRampToValueAtTime(1400, t + 1.5);
    env(g, t, 0.8, 1.0, 1.0, 0.08);
    o.connect(lp).connect(g); for (const ch of all) g.connect(to(ch)); o.start(t); o.stop(t + 3);
  }
}

function flyby() { // whoosh panned front-left → rear-right (or left → right on stereo)
  const t = ctx.currentTime + 0.05, dur = 2.0;
  const path = channels >= 6 ? [0, 2, 1, 5, 4] : [0, 1];
  const n = noise(dur + 0.2), bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.Q.value = 2; bp.frequency.setValueAtTime(500, t); bp.frequency.linearRampToValueAtTime(2500, t + dur / 2); bp.frequency.linearRampToValueAtTime(400, t + dur);
  n.connect(bp);
  path.forEach((ch, i) => {
    const g = ctx.createGain(), seg = dur / (path.length - 1 || 1), c = t + i * seg;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0, Math.max(t, c - seg));
    g.gain.linearRampToValueAtTime(0.8, c); g.gain.linearRampToValueAtTime(0, c + seg);
    bp.connect(g).connect(to(ch));
  });
  n.start(t); n.stop(t + dur + 0.2);
}

$('#start').onclick = () => { if (!ctx) setup(); ctx.resume(); $('#start').textContent = 'Běží ✓'; };
document.querySelectorAll('button[data-ch]').forEach((b) => b.onclick = () => pingChannel(+b.dataset.ch, b));
$('#subA').onclick = () => subDrop(true);
$('#subB').onclick = () => subDrop(false);
$('#crowd').onclick = crowd;
$('#boss').onclick = boss;
$('#flyby').onclick = flyby;
