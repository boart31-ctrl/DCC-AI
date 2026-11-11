// The System voice inside the session host: GM-only `tts.*` actions, the `tts` hint on `play`,
// achievement announcements, the free-text `announce`, and `gm.tts` in the GM view.
// Browser-safe (used by host.js in both editions). See docs/PROTOCOL.md §3b.
//
//   const tts = createTtsHost({ config, pack, getTts, saveTts, getState, now, log });
//   tts.handlers['tts.say'](msg, ctx)      ctx = { pushLine, lineOf(id) }
//   tts.playInfo(item)                     -> { hash, cached, url } | null   (attached to `play`)
//   tts.rewriteLines(events, lines, state) achievement lines become the full announcement
//   tts.gmView()                           -> gm.tts
//   tts.audio(hash)                        -> Uint8Array | null              (GET /api/tts/<hash>.mp3)
import { ActionError, bad } from './errors.js';
import {
  createElevenLabs, createTtsCache, createLimiter, ttsKey, normText, voiceLines, achievementText, achievementMode,
  publicVoice, allowedVoice, TtsError, DEFAULT_SETTINGS, DEFAULT_MODEL, DEFAULT_FORMAT, MAX_TEXT, HASH_RE,
} from './tts.js';

const VOICES_TTL = 10 * 60_000;
const PREVIEW_PREFIX = 'preview\n';
const PRERENDER_BATCH = 2; // one round of 2 parallel requests per step (also keeps Workers subrequests low)

const fail = (e) => (e instanceof TtsError ? new ActionError(`tts.${e.code}`, e.message) : e);
const unit = (v, name) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw bad(`${name} must be a number 0..1`);
  return Math.round(v * 100) / 100;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createTtsHost({ config = {}, pack, getTts, saveTts, getState, now = Date.now, log = console } = {}) {
  const format = config.format || DEFAULT_FORMAT;
  const envVoice = config.voiceId || null;
  const envModel = config.modelId || null;
  const configured = !!config.apiKey && !!config.store;
  const client = configured ? createElevenLabs({ apiKey: config.apiKey, fetch: config.fetch, baseUrl: config.baseUrl }) : null;
  const cache = config.store ? createTtsCache(config.store, { capBytes: config.capBytes ?? 50 * 1024 * 1024, now }) : null;
  const limiter = createLimiter(config.concurrency ?? 2);
  const inflight = new Map();
  let voices = null; // { at, list: raw voices, error }
  let models = null;
  let lastError = null;

  const settings = () => ({ ...DEFAULT_SETTINGS, ...(getTts()?.settings ?? {}) });
  const usage = () => ({ chars: 0, lines: 0, previews: 0, ...(getTts()?.usage ?? {}) });
  const model = () => settings().modelId || envModel || DEFAULT_MODEL;
  const firstAllowed = () => {
    const list = (voices?.list ?? []).filter(allowedVoice);
    return (list.find((v) => v.category === 'premade') ?? list[0])?.voice_id ?? null;
  };
  /** Voice used when nothing overrides it (sync: may be null until the voice list was loaded once). */
  const defaultVoice = () => settings().voiceId || envVoice || firstAllowed();
  const need = () => {
    if (!configured) throw new ActionError('tts.no_key', 'ElevenLabs is not configured (ELEVENLABS_API_KEY); the System uses the browser voice');
  };

  async function loadVoices(force = false) {
    need();
    if (!force && voices && !voices.error && now() - voices.at < VOICES_TTL) return voices.list;
    try {
      voices = { at: now(), list: await client.voices(), error: null };
    } catch (e) {
      voices = { at: now(), list: voices?.list ?? [], error: e };
      throw e;
    }
    return voices.list;
  }

  /** Checks that a voice id is an allowed (premade / generated) voice of this account. */
  async function checkVoice(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(id)) throw bad('voiceId is not a valid ElevenLabs voice id');
    let list;
    try {
      list = await loadVoices();
    } catch (e) {
      // The key may not be allowed to list voices: then only the voice set in ELEVENLABS_VOICE_ID is usable.
      if (id === envVoice) return id;
      throw new TtsError('no_voice', `cannot verify voice ${id}: ${e.message}`);
    }
    const v = list.find((x) => x.voice_id === id);
    if (!v) {
      if (id === envVoice && !list.length) return id;
      throw new TtsError('no_voice', `voice ${id} is not in this ElevenLabs account`);
    }
    if (!allowedVoice(v)) throw new TtsError('no_voice', `voice "${v.name}" is a ${v.category} voice; only premade or generated voices are allowed`);
    return id;
  }

  async function resolveVoice(override) {
    need();
    if (override) return checkVoice(override);
    const s = settings();
    if (s.voiceId) return checkVoice(s.voiceId);
    if (envVoice) return checkVoice(envVoice);
    await loadVoices().catch(() => {});
    const id = firstAllowed();
    if (!id) throw new TtsError('no_voice', 'no premade voice found in the ElevenLabs account; pick one in Settings → Voice');
    return id;
  }

  function addUsage(chars, field = 'lines') {
    const u = usage();
    saveTts((t) => ({ ...t, usage: { ...u, chars: u.chars + chars, [field]: (u[field] ?? 0) + 1, lastAt: now() } }));
  }

  async function render(text, voiceId, priority) {
    const modelId = model();
    const s = settings();
    const hash = ttsKey({ voiceId, modelId, format, text });
    if (cache.has(hash)) return { hash, cached: true, chars: 0 };
    if (inflight.has(hash)) return inflight.get(hash);
    const p = limiter.run(async () => {
      if (cache.has(hash)) return { hash, cached: true, chars: 0 };
      let bytes;
      for (let attempt = 0; ; attempt++) {
        try {
          bytes = await client.tts({ voiceId, modelId, text, format, voiceSettings: { stability: s.stability, similarity_boost: s.similarity } });
          break;
        } catch (e) {
          if (e instanceof TtsError && e.code === 'busy' && attempt < (priority ? 3 : 1)) { await sleep(600 * 2 ** attempt); continue; }
          throw e;
        }
      }
      cache.put(hash, bytes, { chars: text.length, voiceId, modelId, text });
      addUsage(text.length);
      return { hash, cached: false, chars: text.length };
    }, priority);
    inflight.set(hash, p);
    try {
      return await p;
    } catch (e) {
      lastError = { at: now(), code: e.code ?? 'error', msg: e.message };
      throw e;
    } finally {
      inflight.delete(hash);
    }
  }

  /** Synthesizes (or finds cached) audio for one line. Throws ActionError tts.* on failure. */
  async function synth(text, { voiceId = null, priority = 0 } = {}) {
    need();
    const t = normText(text);
    if (!t) throw bad('text required');
    if (t.length > MAX_TEXT) throw bad(`text too long (max ${MAX_TEXT} characters)`);
    try {
      const vid = await resolveVoice(voiceId);
      return { ...(await render(t, vid, priority)), url: null };
    } catch (e) {
      throw fail(e);
    }
  }

  function linesNow() {
    return voiceLines(pack, getState(), settings(), { configured, voiceId: getState()?.session?.voice ?? null });
  }

  function plan(voiceId) {
    const modelId = model();
    return linesNow().map((l) => {
      const hash = ttsKey({ voiceId, modelId, format, text: l.text });
      return { ...l, hash, cached: cache.has(hash) };
    });
  }

  const summary = (items) => {
    const todo = items.filter((x) => !x.cached);
    const byKind = {};
    for (const x of todo) byKind[x.kind] = (byKind[x.kind] ?? 0) + 1;
    return { total: items.length, cached: items.length - todo.length, remaining: todo.length, chars: todo.reduce((s, x) => s + x.text.length, 0), byKind };
  };

  const urlOf = (hash) => `/api/tts/${hash}.mp3`;

  const handlers = {
    'tts.status'() {
      return gmView();
    },
    async 'tts.voices'(msg) {
      need();
      try {
        const list = await loadVoices(msg.refresh === true);
        return { voices: list.filter(allowedVoice).map(publicVoice).sort((a, b) => a.name.localeCompare(b.name)), hidden: list.filter((v) => !allowedVoice(v)).length };
      } catch (e) {
        throw fail(e);
      }
    },
    async 'tts.models'() {
      need();
      try {
        if (!models || now() - models.at > VOICES_TTL) models = { at: now(), list: await client.models() };
      } catch (e) {
        throw fail(e);
      }
      return {
        models: models.list.filter((m) => m.can_do_text_to_speech !== false).map((m) => ({
          id: m.model_id, name: String(m.name ?? m.model_id).slice(0, 80),
          maxChars: Number.isFinite(m.maximum_text_length_per_request) ? m.maximum_text_length_per_request : null,
          costFactor: Number.isFinite(m.model_rates?.character_cost_multiplier) ? m.model_rates.character_cost_multiplier : (Number.isFinite(m.token_cost_factor) ? m.token_cost_factor : null),
          languages: Array.isArray(m.languages) ? m.languages.length : null,
          description: typeof m.description === 'string' ? m.description.slice(0, 200) : '',
        })),
      };
    },
    async 'tts.account'() {
      need();
      try {
        const s = await client.subscription();
        return { tier: s?.tier ?? null, used: s?.character_count ?? null, limit: s?.character_limit ?? null, resetsAt: s?.next_character_count_reset_unix ? s.next_character_count_reset_unix * 1000 : null };
      } catch (e) {
        throw fail(e);
      }
    },
    async 'tts.config'(msg) {
      const patch = {};
      if (msg.voiceId !== undefined) {
        if (msg.voiceId === null) patch.voiceId = null;
        else {
          need();
          try { patch.voiceId = await checkVoice(msg.voiceId); } catch (e) { throw fail(e); }
        }
      }
      if (msg.modelId !== undefined) {
        if (msg.modelId !== null && (typeof msg.modelId !== 'string' || !/^[a-z0-9_.-]{2,64}$/i.test(msg.modelId))) throw bad('modelId is not a valid model id');
        patch.modelId = msg.modelId;
      }
      if (msg.stability !== undefined) patch.stability = unit(msg.stability, 'stability');
      if (msg.similarity !== undefined) patch.similarity = unit(msg.similarity, 'similarity');
      if (msg.achievementLine !== undefined) {
        if (!['auto', 'announce', 'quip'].includes(msg.achievementLine)) throw bad('achievementLine must be auto, announce or quip');
        patch.achievementLine = msg.achievementLine;
      }
      for (const k of ['achievementDesc', 'achievementReward']) {
        if (msg[k] !== undefined) {
          if (typeof msg[k] !== 'boolean') throw bad(`${k} must be a boolean`);
          patch[k] = msg[k];
        }
      }
      if (!Object.keys(patch).length) throw bad('nothing to change');
      saveTts((t) => ({ ...t, settings: { ...(t?.settings ?? {}), ...patch } }));
      return { settings: settings() };
    },
    async 'tts.preview'(msg) {
      need();
      try {
        const id = await checkVoice(msg.voiceId ?? defaultVoice());
        const v = (voices?.list ?? []).find((x) => x.voice_id === id);
        const hash = ttsKey({ voiceId: id, modelId: PREVIEW_PREFIX, format: 'preview', text: id });
        if (!cache.has(hash)) {
          if (!v?.preview_url) throw new TtsError('bad_request', 'this voice has no preview sample');
          const bytes = await limiter.run(() => client.fetchPreview(v.preview_url), 0);
          cache.put(hash, bytes, { chars: 0, voiceId: id, modelId: 'preview', text: `preview ${v.name}` });
        }
        return { hash, url: urlOf(hash), chars: 0 };
      } catch (e) {
        throw fail(e);
      }
    },
    /** Speak arbitrary text now (P0). Synthesized first, so the GM desk can play it from the cache at once. */
    async 'tts.say'(msg, ctx) {
      const text = typeof msg.text === 'string' ? normText(msg.text) : '';
      if (!text) throw bad('text required');
      const r = await synth(text, { voiceId: msg.voiceId ?? null });
      ctx.pushLine({ priority: 0, text, quipId: null, crit: false, ttsVoice: msg.voiceId ?? null });
      return { hash: r.hash, url: urlOf(r.hash), cached: r.cached, chars: r.chars };
    },
    /** The GM desk got a `play` whose audio is not cached yet: render it now (1–2 s). */
    async 'tts.line'(msg, ctx) {
      if (typeof msg.id !== 'string') throw bad('id required');
      const line = ctx.lineOf(msg.id);
      if (!line) throw new ActionError('not_found', `no recent line ${msg.id}`);
      const r = await synth(line.text, { voiceId: line.ttsVoice ?? null });
      return { id: msg.id, hash: r.hash, url: urlOf(r.hash), cached: r.cached, chars: r.chars };
    },
    async 'tts.estimate'() {
      need();
      try {
        const vid = await resolveVoice(null);
        const items = plan(vid);
        return { ...summary(items), voiceId: vid, modelId: model() };
      } catch (e) {
        throw fail(e);
      }
    },
    /** One pre-render step: renders up to 2 uncached known lines. Stateless → resumable; the desk loops. */
    async 'tts.prerender.step'(msg) {
      need();
      if (msg.confirm !== true) throw bad('confirm: true required (pre-rendering costs ElevenLabs characters)');
      const exclude = new Set(Array.isArray(msg.exclude) ? msg.exclude.filter((x) => typeof x === 'string').slice(0, 1000) : []);
      let vid;
      try { vid = await resolveVoice(null); } catch (e) { throw fail(e); }
      const items = plan(vid);
      const todo = items.filter((x) => !x.cached && !exclude.has(x.hash)).slice(0, PRERENDER_BATCH);
      const results = await Promise.allSettled(todo.map((x) => render(x.text, vid, 1)));
      const done = [];
      const failed = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') done.push({ hash: todo[i].hash, kind: todo[i].kind, chars: r.value.chars });
        else failed.push({ hash: todo[i].hash, kind: todo[i].kind, text: todo[i].text.slice(0, 80), error: r.reason?.code ? `tts.${r.reason.code}` : 'error', msg: r.reason?.message ?? String(r.reason) });
      });
      const after = plan(vid);
      const left = after.filter((x) => !x.cached && !exclude.has(x.hash) && !failed.some((f) => f.hash === x.hash));
      // A fatal error (bad key, quota) stops the run instead of failing line after line.
      const fatal = failed.find((f) => ['tts.bad_key', 'tts.quota', 'tts.no_voice', 'tts.offline'].includes(f.error)) ?? null;
      return { ...summary(after), remaining: left.length, chars: left.reduce((s, x) => s + x.text.length, 0), done, failed, fatal };
    },
    'tts.cache.clear'() {
      if (!cache) throw new ActionError('tts.no_key', 'no voice cache on this server');
      const before = cache.stats();
      cache.clear();
      return { cleared: before.count, bytes: before.bytes };
    },
  };

  /** `tts` field of a `play` message (null when ElevenLabs is off or the line has recorded audio). */
  function playInfo(item, recordedAudio) {
    if (!configured || recordedAudio || !normText(item.text)) return null;
    const vid = item.ttsVoice || defaultVoice();
    if (!vid) return { hash: null, cached: false, url: null };
    const hash = ttsKey({ voiceId: vid, modelId: model(), format, text: normText(item.text) });
    const cached = cache.has(hash);
    return { hash, cached, url: cached ? urlOf(hash) : null };
  }

  /** In announce mode the achievement line becomes "New achievement! Title. Desc. Reward: …". */
  function rewriteLines(events, lines) {
    if (!lines.length) return lines;
    const ach = events.map((x) => x.event).filter((e) => e?.kind === 'achievement');
    if (!ach.length || achievementMode(settings(), configured) !== 'announce') return lines;
    return lines.map((l) => {
      const e = ach.find((a) => {
        const voiceQuip = a.achId ? pack.achievementsById?.get(a.achId)?.voice : null;
        return l.category === 'achievement' || (voiceQuip && l.quipId === voiceQuip) || /^New achievement\. /.test(l.text);
      });
      if (!e) return l;
      return { ...l, text: achievementText(pack, e, settings()), quipId: null, category: 'achievement', achId: e.achId ?? null };
    });
  }

  function gmView() {
    const s = settings();
    const st = cache?.stats() ?? { bytes: 0, count: 0, cap: 0 };
    const v = (voices?.list ?? []).find((x) => x.voice_id === defaultVoice());
    return {
      configured,
      voiceId: defaultVoice(),
      voiceName: v?.name ?? null,
      voiceFromEnv: !s.voiceId && !!envVoice,
      modelId: model(),
      format,
      stability: s.stability,
      similarity: s.similarity,
      achievementLine: s.achievementLine,
      achievementMode: achievementMode(s, configured),
      achievementDesc: s.achievementDesc,
      achievementReward: s.achievementReward,
      cache: { bytes: st.bytes, count: st.count, cap: st.cap ?? cache?.capBytes ?? 0 },
      usage: usage(),
      busy: limiter.active + limiter.waiting,
      lastError,
    };
  }

  return {
    configured,
    handlers,
    playInfo,
    rewriteLines,
    gmView,
    synth,
    audio: (hash) => (cache && HASH_RE.test(hash) ? cache.get(hash) : null),
    get cache() { return cache; },
  };
}
