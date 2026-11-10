// System voice via ElevenLabs (server side only; the API key never reaches a browser).
// Browser-safe (no Node imports): used by host.js in both editions. Pieces:
//
//   sha256Hex(str)                       sync SHA-256 (cache keys must be computable inside onPlay)
//   ttsKey({voiceId, modelId, format, text})
//   chunkBytes / joinChunks              audio blobs split into ≤ 1 MB rows (Durable Object SQLite)
//   memoryTtsStore()                     store for tests / no persistence
//   sqlTtsStore(sql, txn)                Durable Object SQLite store (tts_meta + tts_chunk)
//   createTtsCache(store, {capBytes})    LRU on top of a store (evicts least recently used)
//   createElevenLabs({apiKey, fetch})    REST client: POST /v1/text-to-speech/{voice_id}, GET /v1/voices,
//                                        GET /v1/models, GET /v1/user/subscription (header xi-api-key)
//   createLimiter(n)                     at most n requests in flight, live lines before pre-renders
//   voiceLines(pack, state, settings)    every known line (quips, achievements, boss intros/defeats)
//   achievementText(pack, ach, settings) the spoken achievement announcement
//
// Store interface (all synchronous):
//   has(hash) get(hash) -> Uint8Array|null put(hash, bytes, meta) delete(hash) touch(hash, at)
//   entries() -> [{hash, size, at}] stats() -> {bytes, count} clear()

export const API_BASE = 'https://api.elevenlabs.io';
export const DEFAULT_MODEL = 'eleven_multilingual_v2'; // the API's own default model_id
export const DEFAULT_FORMAT = 'mp3_44100_96';
export const CHUNK_BYTES = 1_000_000; // DO SQLite: stay far below the per-row limit
export const MAX_TEXT = 1000;
// Only the account's stock voices and ones designed from a text prompt; never clones of real people.
export const ALLOWED_CATEGORIES = new Set(['premade', 'generated']);
export const DEFAULT_SETTINGS = Object.freeze({
  voiceId: null, modelId: null, stability: 0.5, similarity: 0.75,
  achievementLine: 'auto', // auto | announce | quip
  achievementDesc: true, achievementReward: true,
});

export class TtsError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/* ---------------- hashing ---------------- */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of a string (UTF-8) as 64 hex chars. Synchronous on purpose. */
export function sha256Hex(str) {
  const msg = new TextEncoder().encode(String(str));
  const len = msg.length;
  const total = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(len / 0x20000000), false);
  dv.setUint32(total - 4, (len * 8) >>> 0, false);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return [...H].map((x) => x.toString(16).padStart(8, '0')).join('');
}

/** Whitespace-normalised text: "Hello  world " and "Hello world" are the same line. */
export const normText = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

/** Cache key = hash(voice + model + output format + text). Voice settings (sliders) are not part of it. */
export function ttsKey({ voiceId, modelId, format = DEFAULT_FORMAT, text }) {
  return sha256Hex(`tts1\n${voiceId}\n${modelId}\n${format}\n${normText(text)}`);
}

export const HASH_RE = /^[0-9a-f]{64}$/;

/* ---------------- chunking ---------------- */

export function chunkBytes(bytes, size = CHUNK_BYTES) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!(size > 0)) throw new RangeError('chunk size must be > 0');
  const out = [];
  for (let i = 0; i < u8.length; i += size) out.push(u8.subarray(i, Math.min(u8.length, i + size)));
  if (!out.length) out.push(new Uint8Array(0));
  return out;
}

export function joinChunks(parts) {
  const list = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(list.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of list) { out.set(p, o); o += p.length; }
  return out;
}

/* ---------------- stores ---------------- */

export function memoryTtsStore() {
  const m = new Map();
  return {
    has: (h) => m.has(h),
    get: (h) => m.get(h)?.bytes ?? null,
    put(h, bytes, meta = {}) { m.set(h, { bytes: new Uint8Array(bytes), size: bytes.length, at: meta.at ?? 0, meta }); },
    delete: (h) => { m.delete(h); },
    touch(h, at) { const e = m.get(h); if (e) e.at = at; },
    entries: () => [...m].map(([hash, e]) => ({ hash, size: e.size, at: e.at })),
    stats: () => ({ bytes: [...m.values()].reduce((s, e) => s + e.size, 0), count: m.size }),
    clear: () => m.clear(),
  };
}

/** Durable Object SQLite store. `sql` = ctx.storage.sql; `txn(fn)` = ctx.storage.transactionSync. */
export function sqlTtsStore(sql, txn = (fn) => fn(), { chunk = CHUNK_BYTES } = {}) {
  sql.exec(`CREATE TABLE IF NOT EXISTS tts_meta (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, at INTEGER NOT NULL, chars INTEGER NOT NULL DEFAULT 0, parts INTEGER NOT NULL, voice TEXT, model TEXT, text TEXT)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS tts_chunk (hash TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (hash, part))`);
  const toBuf = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  return {
    has: (h) => sql.exec('SELECT 1 AS x FROM tts_meta WHERE hash = ?', h).toArray().length > 0,
    get(h) {
      const meta = sql.exec('SELECT parts FROM tts_meta WHERE hash = ?', h).toArray()[0];
      if (!meta) return null;
      const rows = sql.exec('SELECT data FROM tts_chunk WHERE hash = ? ORDER BY part', h).toArray();
      if (rows.length !== meta.parts) return null; // torn write: treat as missing
      return joinChunks(rows.map((r) => r.data));
    },
    put(h, bytes, meta = {}) {
      const parts = chunkBytes(bytes, chunk);
      txn(() => {
        sql.exec('DELETE FROM tts_chunk WHERE hash = ?', h);
        parts.forEach((p, i) => sql.exec('INSERT INTO tts_chunk (hash, part, data) VALUES (?, ?, ?)', h, i, toBuf(p)));
        sql.exec('INSERT OR REPLACE INTO tts_meta (hash, size, at, chars, parts, voice, model, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          h, bytes.length, meta.at ?? 0, meta.chars ?? 0, parts.length, meta.voiceId ?? null, meta.modelId ?? null, String(meta.text ?? '').slice(0, 300));
      });
    },
    delete(h) {
      txn(() => {
        sql.exec('DELETE FROM tts_chunk WHERE hash = ?', h);
        sql.exec('DELETE FROM tts_meta WHERE hash = ?', h);
      });
    },
    touch(h, at) { sql.exec('UPDATE tts_meta SET at = ? WHERE hash = ?', at, h); },
    entries: () => sql.exec('SELECT hash, size, at FROM tts_meta').toArray().map((r) => ({ hash: r.hash, size: r.size, at: r.at })),
    stats() {
      const r = sql.exec('SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS count FROM tts_meta').toArray()[0];
      return { bytes: Number(r?.bytes ?? 0), count: Number(r?.count ?? 0) };
    },
    clear() {
      txn(() => {
        sql.exec('DELETE FROM tts_chunk');
        sql.exec('DELETE FROM tts_meta');
      });
    },
  };
}

/* ---------------- LRU cache ---------------- */

export function createTtsCache(store, { capBytes = 50 * 1024 * 1024, now = Date.now } = {}) {
  function evict(keep) {
    let { bytes } = store.stats();
    if (bytes <= capBytes) return [];
    const gone = [];
    const list = store.entries().filter((e) => e.hash !== keep).sort((a, b) => a.at - b.at || a.hash.localeCompare(b.hash));
    for (const e of list) {
      if (bytes <= capBytes) break;
      store.delete(e.hash);
      bytes -= e.size;
      gone.push(e.hash);
    }
    return gone;
  }
  return {
    capBytes,
    has: (h) => store.has(h),
    /** Bytes or null; a hit counts as a use (LRU). */
    get(h) {
      const b = store.get(h);
      if (b) store.touch(h, now());
      return b;
    },
    /** Stores and evicts least-recently-used entries until under the cap. Returns evicted hashes. */
    put(h, bytes, meta = {}) {
      if (bytes.length > capBytes) throw new TtsError('too_big', 'audio is larger than the whole cache');
      store.put(h, bytes, { ...meta, at: now() });
      return evict(h);
    },
    delete: (h) => store.delete(h),
    stats: () => ({ ...store.stats(), cap: capBytes }),
    clear: () => store.clear(),
    evict: () => evict(null),
  };
}

/* ---------------- ElevenLabs REST client ---------------- */

async function errorOf(res) {
  let detail = '';
  let status = '';
  try {
    const j = await res.json();
    const d = j?.detail;
    if (typeof d === 'string') detail = d;
    else if (d && typeof d === 'object' && !Array.isArray(d)) { detail = d.message || ''; status = d.status || ''; }
    else if (Array.isArray(d)) detail = d.map((x) => x?.msg).filter(Boolean).join('; ');
  } catch {}
  const s = res.status;
  if (s === 401 || s === 403) return new TtsError('bad_key', `ElevenLabs refused the API key${detail ? `: ${detail}` : ''}`, s);
  if (s === 429) {
    const quota = /quota/i.test(status + detail);
    return new TtsError(quota ? 'quota' : 'busy', quota ? 'ElevenLabs character quota is used up' : 'ElevenLabs is busy (too many requests at once), try again', s);
  }
  if (s === 400 || s === 404 || s === 422) return new TtsError('bad_request', `ElevenLabs rejected the request${detail ? `: ${detail}` : ''}`, s);
  return new TtsError('upstream', `ElevenLabs error ${s}${detail ? `: ${detail}` : ''}`, s);
}

export function createElevenLabs({ apiKey, fetch: f = globalThis.fetch?.bind(globalThis), baseUrl = API_BASE, timeoutMs = 20_000 } = {}) {
  if (!apiKey) throw new TtsError('no_key', 'ELEVENLABS_API_KEY is not set');
  const base = String(baseUrl).replace(/\/+$/, '');
  async function call(path, init = {}) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    let res;
    try {
      res = await f(base + path, { ...init, headers: { 'xi-api-key': apiKey, ...(init.headers ?? {}) }, signal: ctl?.signal });
    } catch (e) {
      throw new TtsError('offline', `cannot reach ElevenLabs (${e?.name === 'AbortError' ? 'timeout' : e?.message || e})`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) throw await errorOf(res);
    return res;
  }
  return {
    /** Returns the audio bytes (mp3 for mp3_* formats). */
    async tts({ voiceId, modelId = DEFAULT_MODEL, text, voiceSettings = null, format = DEFAULT_FORMAT }) {
      const body = { text: normText(text), model_id: modelId };
      if (voiceSettings) body.voice_settings = voiceSettings;
      const res = await call(`/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(format)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify(body),
      });
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.length) throw new TtsError('upstream', 'ElevenLabs returned empty audio');
      return bytes;
    },
    async voices() {
      const j = await (await call('/v1/voices', { method: 'GET' })).json();
      return (Array.isArray(j?.voices) ? j.voices : []).filter((v) => v && typeof v.voice_id === 'string');
    },
    async models() {
      const j = await (await call('/v1/models', { method: 'GET' })).json();
      return (Array.isArray(j) ? j : []).filter((m) => m && typeof m.model_id === 'string');
    },
    async subscription() {
      return (await call('/v1/user/subscription', { method: 'GET' })).json();
    },
    /** Downloads a voice's preview_url (an https audio file ElevenLabs hosts). Costs no characters. */
    async fetchPreview(url) {
      if (!/^https:\/\//i.test(url)) throw new TtsError('bad_request', 'preview URL must be https');
      let res;
      try {
        res = await f(url, { method: 'GET' });
      } catch (e) {
        throw new TtsError('offline', `cannot download the preview (${e?.message || e})`);
      }
      if (!res.ok) throw new TtsError('upstream', `preview download failed (${res.status})`, res.status);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > 5 * 1024 * 1024) throw new TtsError('too_big', 'preview file is too large');
      return bytes;
    },
  };
}

/** Public, filtered voice entry (premade / generated only). */
export function publicVoice(v) {
  return {
    id: v.voice_id,
    name: String(v.name ?? v.voice_id).slice(0, 80),
    category: v.category ?? null,
    labels: v.labels && typeof v.labels === 'object' ? Object.fromEntries(Object.entries(v.labels).filter(([, x]) => typeof x === 'string').slice(0, 8)) : {},
    description: typeof v.description === 'string' ? v.description.slice(0, 200) : '',
    hasPreview: typeof v.preview_url === 'string' && /^https:\/\//.test(v.preview_url),
  };
}
export const allowedVoice = (v) => !!v && ALLOWED_CATEGORIES.has(v.category);

/* ---------------- concurrency ---------------- */

/** At most `n` tasks at once; priority 0 (live lines) jumps ahead of priority 1 (pre-render). */
export function createLimiter(n = 2) {
  let active = 0;
  const q = [];
  let seq = 0;
  const pump = () => {
    while (active < n && q.length) {
      q.sort((a, b) => a.p - b.p || a.s - b.s);
      const job = q.shift();
      active++;
      Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { active--; pump(); });
    }
  };
  return {
    run(fn, priority = 0) {
      return new Promise((resolve, reject) => { q.push({ fn, p: priority, s: seq++, resolve, reject }); pump(); });
    },
    get active() { return active; },
    get waiting() { return q.length; },
  };
}

/* ---------------- what the System says ---------------- */

const endPunct = (s) => (/[.!?…:]$/.test(s) ? s : `${s}.`);

/** The spoken achievement announcement: prefix + title + description + reward. */
export function achievementText(pack, ach, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const parts = [endPunct(normText(pack?.notifyPrefix || 'New achievement!')), endPunct(normText(ach.title))];
  if (s.achievementDesc && normText(ach.desc)) parts.push(endPunct(normText(ach.desc)));
  if (s.achievementReward && normText(ach.reward)) parts.push(endPunct(`Reward: ${normText(ach.reward)}`));
  return parts.join(' ').slice(0, MAX_TEXT);
}

/** 'announce' or 'quip' for the current settings (auto = announce when ElevenLabs is configured). */
export function achievementMode(settings, configured) {
  const m = settings?.achievementLine;
  if (m === 'announce' || m === 'quip') return m;
  return configured ? 'announce' : 'quip';
}

/**
 * Every line the System knows in advance, deduplicated by text:
 * [{ kind: 'quip'|'achievement'|'boss', ref, text }]. Quips with their own recorded audio are skipped.
 */
export function voiceLines(pack, state, settings = DEFAULT_SETTINGS, { configured = true, voiceId = null } = {}) {
  const out = [];
  const seen = new Set();
  const add = (kind, ref, text) => {
    const t = normText(text);
    if (!t || t.length > MAX_TEXT || seen.has(t)) return;
    seen.add(t);
    out.push({ kind, ref, text: t });
  };
  for (const q of pack?.quips ?? []) {
    const recorded = q.audioByVoice?.[voiceId] ?? q.audio ?? null;
    if (!recorded) add('quip', q.id, q.text);
  }
  if (achievementMode(settings, configured) === 'announce') {
    for (const a of pack?.achievements ?? []) add('achievement', a.id, achievementText(pack, a, settings));
  }
  const bosses = [...(pack?.library?.boss ?? []), ...(Array.isArray(state?.library?.boss) ? state.library.boss : [])];
  for (const b of bosses) {
    if (!b || typeof b !== 'object') continue;
    add('boss', `${b.id}:intro`, b.intro);
    add('boss', `${b.id}:defeat`, b.defeatLine);
  }
  return out;
}
