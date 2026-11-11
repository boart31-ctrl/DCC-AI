// Node edition: System voice cache on disk — data/tts/<hash>.mp3 + data/tts/index.json (size, last use,
// characters, short text). Same synchronous store interface as tts.js (memoryTtsStore / sqlTtsStore).
import fs from 'node:fs';
import path from 'node:path';
import { HASH_RE } from './tts.js';

export function fileTtsStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const indexFile = path.join(dir, 'index.json');
  let index = {};
  try {
    index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) ?? {};
  } catch {}
  // Drop index entries whose file vanished, and files the index does not know.
  for (const h of Object.keys(index)) if (!HASH_RE.test(h) || !fs.existsSync(path.join(dir, `${h}.mp3`))) delete index[h];
  for (const f of fs.readdirSync(dir)) {
    const m = /^([0-9a-f]{64})\.mp3$/.exec(f);
    if (m && !index[m[1]]) fs.rmSync(path.join(dir, f), { force: true });
  }
  let flushTimer = null;
  const flush = () => {
    clearTimeout(flushTimer);
    flushTimer = null;
    const tmp = `${indexFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index));
    fs.renameSync(tmp, indexFile);
  };
  const later = () => {
    if (!flushTimer) {
      flushTimer = setTimeout(flush, 2000);
      flushTimer.unref?.();
    }
  };
  const file = (h) => {
    if (!HASH_RE.test(h)) throw new Error('bad tts hash');
    return path.join(dir, `${h}.mp3`);
  };
  return {
    has: (h) => HASH_RE.test(h) && !!index[h],
    get(h) {
      if (!HASH_RE.test(h) || !index[h]) return null;
      try {
        return new Uint8Array(fs.readFileSync(file(h)));
      } catch {
        delete index[h];
        later();
        return null;
      }
    },
    put(h, bytes, meta = {}) {
      const f = file(h);
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, f);
      index[h] = { size: bytes.length, at: meta.at ?? Date.now(), chars: meta.chars ?? 0, voice: meta.voiceId ?? null, model: meta.modelId ?? null, text: String(meta.text ?? '').slice(0, 300) };
      flush();
    },
    delete(h) {
      if (!index[h]) return;
      fs.rmSync(file(h), { force: true });
      delete index[h];
      flush();
    },
    touch(h, at) {
      if (index[h]) {
        index[h].at = at;
        later();
      }
    },
    entries: () => Object.entries(index).map(([hash, e]) => ({ hash, size: e.size, at: e.at })),
    stats: () => ({ bytes: Object.values(index).reduce((s, e) => s + e.size, 0), count: Object.keys(index).length }),
    clear() {
      for (const h of Object.keys(index)) fs.rmSync(path.join(dir, `${h}.mp3`), { force: true });
      index = {};
      flush();
    },
    flush,
  };
}
