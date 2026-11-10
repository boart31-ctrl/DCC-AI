// The GM desk as the audio device (default): plays the System voice lines the host releases
// (`play` / `stop`, acks with `audio.done`) and the scene stingers, unless view.show.audioDevice
// is "stage". Browsers allow sound only after a gesture, so the first click or key unlocks it.
import { createVoicePlayer } from './voice.js';
import { isHosted } from './client.js';
import { createShowAudio } from './show-audio.js';
import { VOICE_HOLD, stingFor } from './stingers.js';

export function createGmAudio({ client, getView }) {
  // Hosted edition: the stage stays the audio device (its host never sends `play` to the GM).
  const isDevice = () => !isHosted() && (getView()?.show?.audioDevice || 'gm') === 'gm' && !!getView()?.show;
  let stingersOn = (() => { try { return localStorage.getItem('system.stingers') !== '0'; } catch { return true; } })();
  const voice = createVoicePlayer({ ack: (id) => client.raw({ t: 'audio.done', id }) });
  const show = createShowAudio({ isDevice: () => isDevice() && stingersOn });
  const api = {
    onChange: null,
    get unlocked() { return voice.unlocked; },
    get stingersOn() { return stingersOn; },
    set stingersOn(v) {
      stingersOn = !!v;
      try { localStorage.setItem('system.stingers', stingersOn ? '1' : '0'); } catch {}
    },
    update(v) { show.view(v); },
    test() { unlock(); show.stingers.play('bossIntro'); },
    voice,
    stingers: show.stingers,
  };

  function unlock() {
    if (voice.unlocked) return;
    voice.unlock();
    show.stingers.unlock();
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
