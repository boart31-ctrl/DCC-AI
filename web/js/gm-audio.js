// The GM desk as the audio device (default): plays the System voice lines the host releases
// (`play` / `stop`, acks with `audio.done`) and the scene stingers, unless view.show.audioDevice
// is "stage". Browsers allow sound only after a gesture, so the first click or key unlocks it.
//
// System voice: a `play` with a `tts` hint is played from the server's ElevenLabs cache
// (GET /api/tts/<hash>.mp3 with the GM credential → blob URL); an uncached line is rendered on demand
// (`tts.line`, 1–2 s, "Rendering…" state). Anything failing falls back to the browser voice. When sound
// starts the desk sends `audio.started` so the TV shows the subtitle / takeover at the same moment.
import { createVoicePlayer } from './voice.js';
import { isHosted } from './client.js';
import { createShowAudio } from './show-audio.js';
import { VOICE_HOLD, stingFor } from './stingers.js';

const BLOB_KEEP = 40;

export function createGmAudio({ client, getView }) {
  // Hosted edition: the stage stays the audio device (its host never sends `play` to the GM).
  const isDevice = () => !isHosted() && (getView()?.show?.audioDevice || 'gm') === 'gm' && !!getView()?.show;
  let stingersOn = (() => { try { return localStorage.getItem('system.stingers') !== '0'; } catch { return true; } })();
  let speaking = false;
  let rendering = false;
  const duckFns = new Set();
  const unlockFns = new Set();
  const blobs = new Map(); // hash -> object URL (small LRU)

  const credHeaders = () => {
    const c = api.credential?.() || null;
    if (c?.key) return { 'X-GM-Key': c.key };
    if (c?.token) return { 'X-GM-Token': c.token };
    return {};
  };

  /** Cached System voice audio as a playable blob URL (GM credential in a header, never in the URL). */
  async function ttsUrl(hash) {
    if (blobs.has(hash)) {
      const u = blobs.get(hash);
      blobs.delete(hash);
      blobs.set(hash, u);
      return u;
    }
    const res = await fetch(`/api/tts/${hash}.mp3`, { headers: credHeaders(), cache: 'no-store' });
    if (!res.ok) throw new Error(`voice audio ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    blobs.set(hash, url);
    while (blobs.size > BLOB_KEEP) {
      const [k, u] = blobs.entries().next().value;
      blobs.delete(k);
      URL.revokeObjectURL(u);
    }
    return url;
  }

  async function resolveAudio(m) {
    let hash = m.tts?.cached ? m.tts.hash : null;
    if (!hash) {
      const r = await client.send({ t: 'tts.line', id: m.id });
      hash = r?.result?.hash;
    }
    return hash ? ttsUrl(hash) : null;
  }

  const voice = createVoicePlayer({
    ack: (id) => client.raw({ t: 'audio.done', id }),
    resolveAudio,
    onStart: (m) => client.raw({ t: 'audio.started', id: m.id }),
    onRender: (on) => { rendering = on; api.onChange?.(); },
    onDuck: (on) => {
      speaking = on;
      for (const fn of duckFns) { try { fn(on); } catch {} }
      api.onChange?.();
    },
  });
  const show = createShowAudio({ isDevice: () => isDevice() && stingersOn });
  const api = {
    onChange: null,
    /** () => { key } | { token } — set by gm.js (the desk's login). */
    credential: null,
    get unlocked() { return voice.unlocked; },
    get speaking() { return speaking; },
    get rendering() { return rendering; },
    get isDevice() { return isDevice(); },
    get stingersOn() { return stingersOn; },
    set stingersOn(v) {
      stingersOn = !!v;
      try { localStorage.setItem('system.stingers', stingersOn ? '1' : '0'); } catch {}
    },
    update(v) { show.view(v); },
    test() { unlock(); show.stingers.play('bossIntro'); },
    /** Called with true/false while the System speaks (the SFX board ducks). */
    onDuck(fn) { duckFns.add(fn); return () => duckFns.delete(fn); },
    onUnlock(fn) { unlockFns.add(fn); if (voice.unlocked) fn(); return () => unlockFns.delete(fn); },
    ttsUrl,
    voice,
    stingers: show.stingers,
  };

  function unlock() {
    if (voice.unlocked) return;
    voice.unlock();
    show.stingers.unlock();
    for (const fn of unlockFns) { try { fn(); } catch {} }
    api.onChange?.();
  }
  document.addEventListener('pointerdown', unlock, { capture: true });
  document.addEventListener('keydown', unlock, { capture: true });

  // Hosts older than the scene system never send `show`: then the stage stays the audio device.
  client.on('play', (m) => { if (isDevice()) voice.play(m); });
  client.on('stop', () => voice.stop());
  client.on('event', (e) => {
    if (!isDevice()) return;
    const s = stingFor(e);
    if (!s) return;
    show.event(e);
    if (stingersOn && VOICE_HOLD[s]) voice.holdFor(VOICE_HOLD[s]);
  });
  return api;
}
