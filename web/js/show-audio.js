// Scene sound cues for whichever page is the audio device: boss stingers from events, the dice
// tumble + nat 20 / nat 1 for a roll on the TV, countdown ticks in the last 10 s and the klaxon at 0,
// and a whoosh on scene changes. Pure timing logic; sounds come from stingers.js.
import { createStingers, stingFor } from './stingers.js';

export function createShowAudio({ isDevice, stingers = createStingers() } = {}) {
  let sceneId = null;
  let rollId = null;
  let cd = null; // { endsAt, offset, lastSec }
  let offset = 0;
  let timer = null;
  const pending = new Set();

  const later = (ms, fn) => { const id = setTimeout(() => { pending.delete(id); fn(); }, ms); pending.add(id); };
  const on = () => { try { return !!isDevice(); } catch { return false; } };

  function cdTick() {
    if (!cd || !on()) return;
    const left = cd.endsAt - (Date.now() + offset);
    const sec = Math.ceil(left / 1000);
    if (sec !== cd.lastSec) {
      if (sec <= 10 && sec > 0) stingers.play('tick');
      if (sec <= 0 && cd.lastSec > 0) stingers.play('klaxon');
      cd.lastSec = sec;
    }
    if (sec <= 0) { clearInterval(timer); timer = null; cd = null; }
  }

  function view(v) {
    const sc = v?.scene;
    if (!sc) return;
    if (Number.isFinite(sc.now)) offset = sc.now - Date.now();
    const changed = sc.id !== sceneId;
    if (changed && sceneId !== null && on()) stingers.play('whoosh');
    sceneId = sc.id;
    if (sc.kind === 'roll' && sc.data?.rollId && sc.data.rollId !== rollId) {
      const fresh = rollId !== null || changed;
      rollId = sc.data.rollId;
      const age = (Date.now() + offset) - (sc.data.at || 0);
      if (fresh && age < 4000 && on()) {
        stingers.play('tumble');
        if (sc.data.nat20) later(2200, () => stingers.play('nat20'));
        else if (sc.data.nat1) later(2200, () => stingers.play('nat1'));
      }
    }
    if (sc.kind === 'countdown' && sc.data?.running && sc.data.endsAt) {
      cd = { endsAt: sc.data.endsAt, lastSec: cd?.lastSec ?? Math.ceil((sc.data.endsAt - sc.now) / 1000) };
      if (!timer) timer = setInterval(cdTick, 200);
    } else if (timer) { clearInterval(timer); timer = null; cd = null; }
  }

  function event(e) {
    const s = stingFor(e);
    if (s && on()) stingers.play(s);
  }

  return { view, event, stingers, stop() { for (const id of pending) clearTimeout(id); pending.clear(); } };
}
