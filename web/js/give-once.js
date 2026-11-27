// Playtest 26 Nov: the GM gave a feather, saw nothing happen, tapped again → two feathers.
// Same item to the same crawler within a few seconds needs a second tap after the warning.
import { toast } from './client.js';

const WINDOW_MS = 6000;
const recent = new Map();

/** true = go ahead and send item.give. */
export function giveGuard(playerId, itemId, name = 'this item', who = 'them') {
  const k = `${playerId}|${itemId}`;
  const now = Date.now();
  const last = recent.get(k);
  if (last && now - last.at < WINDOW_MS && !last.warned) {
    last.warned = true;
    toast(`${who} already got ${name} just now. Tap again to give a second one.`, { error: true, ms: 3500 });
    return false;
  }
  recent.set(k, { at: now, warned: false });
  return true;
}
