// Transport-agnostic session host: everything between "a socket sent a string" and the reducers.
// Used by the Node server (server/index.js, ws) and the Cloudflare Durable Object (cloud/worker.js).
// Browser-safe: no Node imports (server/test/host.test.js checks the import graph).
//
//   const host = createHost({ pack, state, send, close, persist, ... });
//   host.connect(conn, { ip, base })   new socket (false = refused: too many sockets)
//   host.restore(conn, meta)           socket that survived a restart (Durable Object hibernation)
//   host.message(conn, text)           one incoming frame (string; anything else is rejected)
//   host.disconnect(conn)              socket gone
//
// Adapters (all optional except send/close):
//   send(conn, string)                 write one frame
//   close(conn, code, reason)          close the socket; the host forgets it immediately
//   persist(state, entry)              called synchronously after every accepted change, BEFORE the
//                                      ack/events go out. entry = { at, by, action|null, system, prev }.
//                                      Throwing rejects the action and keeps the previous state.
//   snapshots { create(reason, state, at), list() -> [{id, at, reason}], load(id) -> state }
//   onArchive(session, log, state)     session.new archived the previous session
//   onMeta(conn, meta)                 per-socket auth/role changed (store it with the socket)
//   now(), rng(), timers { setTimeout, clearTimeout }, ai, log (console-like)
//   gmKey                              GM secret; hello {role:'gm', key}
//   legacy                             also accept the v1 hello forms (gm/stage token, room + PIN)
//   urls(base, state) -> { join, stage, gm }, playerUrl(base, token)
import { normalizeState, reduce, reducePlayerAction, viewFor, genId, ActionError } from './state.js';
import { VoiceQueue } from './quips.js';
import { voiceFor, recordedAudio } from './pack-core.js';
import { makeToken } from './random.js';
import { safeEqual, RateLimiter, TokenBucket, authenticate, makePairCode } from './access.js';
import { createTtsHost } from './tts-host.js';
import { createChat } from './chat.js';

export const LIMITS = {
  maxMessage: 16 * 1024,
  maxPortraitMessage: 256 * 1024, // GM / player sockets only: a sheet.set of a portrait (≤ 200 000-char data URL)
  maxSockets: 40,
  helloTimeoutMs: 10_000,
  pairTtlMs: 10 * 60_000,
  claimTtlMs: 10 * 60_000,
  maxTvs: 3,
  maxWaiting: 6, // TVs showing a code / players waiting for approval, each
  authFailures: 5,
  authWindowMs: 60_000,
  rate: { gm: [50, 120], stage: [20, 40], player: [10, 20], other: [10, 20] }, // [per second, burst]
  viewDebounceMs: 50,
  voiceTickMs: 250,
  audienceTickMs: 5_000,
  snapshotEveryMs: 10 * 60_000,
  idleMs: 30 * 60_000,
  logMax: 5000,
  tokenBytes: 24, // → 32 url-safe chars
};

export const CLOSE = { helloTimeout: 4000, auth: 4001, expired: 4002, removed: 4004, busy: 1013, tooBig: 1009 };

// Never written to the action log (only the GM export carries secrets, inside `state`).
const SECRET_KEYS = new Set(['token', 'pin', 'key', 'tvToken', 'code', 'rid']);
export function sanitizeAction(a) {
  const out = {};
  for (const [k, v] of Object.entries(a ?? {})) if (!SECRET_KEYS.has(k)) out[k] = v;
  return out;
}

const VIEW_ROLES = new Set(['gm', 'stage', 'player']);
const WAITING_ROLES = new Set(['pairing', 'claim']);
const NO_AI = { aiAvailable: false, callsLeft: 0, available: () => false, resetSession() {} };

const defaultUrls = (base) => ({ join: `${base}/join`, stage: `${base}/tv`, gm: `${base}/gm` });
const defaultPlayerUrl = (base, token) => `${base}/p/${token}`;

/** Gives every player a link token, drops tokens of removed players. Returns the same object if nothing changed. */
export function ensureAccess(st, tokenBytes = LIMITS.tokenBytes) {
  const h = st.host && typeof st.host === 'object' ? st.host : null;
  const old = h?.playerTokens && typeof h.playerTokens === 'object' ? h.playerTokens : {};
  let changed = !h || !Array.isArray(h.tvs) || h.playerTokens !== old;
  const tokens = {};
  for (const p of st.players) {
    if (typeof old[p.id] === 'string' && old[p.id].length >= 24) tokens[p.id] = old[p.id];
    else {
      tokens[p.id] = makeToken(tokenBytes);
      changed = true;
    }
  }
  if (Object.keys(old).length !== st.players.length) changed = true;
  if (!changed) return st;
  return { ...st, host: { lastActionAt: 0, lastSnapshotAt: 0, ...(h ?? {}), tvs: Array.isArray(h?.tvs) ? h.tvs : [], playerTokens: tokens } };
}

export function createHost(opts) {
  const {
    pack,
    send: rawSend,
    close: rawClose,
    persist = () => {},
    snapshots = null,
    onArchive = () => {},
    onMeta = () => {},
    now = Date.now,
    rng = Math.random,
    ai = NO_AI,
    log = console,
    legacy = false,
    edition = legacy ? 'node' : 'cloud',
    chat = true,
    urls: urlsFn = defaultUrls,
    playerUrl = defaultPlayerUrl,
  } = opts;
  const L = { ...LIMITS, ...(opts.limits ?? {}) };
  const T = opts.timers ?? { setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (t) => globalThis.clearTimeout(t) };
  let gmKey = typeof opts.gmKey === 'string' && opts.gmKey ? opts.gmKey : '';
  let base = opts.base ?? '';
  let state = ensureAccess(opts.state, L.tokenBytes);
  if (state !== opts.state) persist(state, { at: now(), by: 'system', action: null, system: true, prev: opts.state });
  // System voice (ElevenLabs, server side). opts.tts = { apiKey, voiceId, modelId, store, capBytes, fetch, baseUrl }.
  const tts = createTtsHost({
    config: opts.tts ?? {}, pack, now, log,
    getState: () => state,
    getTts: () => state.host?.tts ?? {},
    saveTts: (fn) => {
      try {
        commit({ ...state, host: { ...state.host, tts: fn(state.host?.tts ?? {}) } }, { at: now(), by: 'system', action: null, system: true });
      } catch (e) {
        log.warn?.(`[tts] could not save: ${e.message}`);
      }
      scheduleViews();
    },
  });
  const recentPlays = new Map(); // play id -> { text, ttsVoice, cue } (tts.line, audio.started)

  const conns = new Map(); // conn -> meta
  const authLimiter = new RateLimiter({ max: L.authFailures, windowMs: L.authWindowMs, now });
  const pinLimiter = new RateLimiter({ max: L.authFailures, windowMs: L.authWindowMs, now });
  let eventLog = [];
  let viewTimer = null;
  let voiceTimer = null;
  let audienceTimer = null;
  let chatTimer = null;
  let closed = false;

  // ---------- outbound ----------

  const send = (conn, msg) => {
    try {
      rawSend(conn, JSON.stringify(msg));
    } catch (e) {
      log.warn?.(`[host] send failed: ${e.message}`);
    }
  };

  function dropConn(conn, code, reason) {
    const meta = conns.get(conn);
    if (meta) forget(conn, meta);
    try {
      rawClose(conn, code, reason);
    } catch {}
  }

  const metaOut = (m) => {
    const { bucket, timer, limitedAt, ...rest } = m;
    return rest;
  };
  const saveMeta = (conn, meta) => {
    try {
      onMeta(conn, metaOut(meta));
    } catch (e) {
      log.warn?.(`[host] onMeta failed: ${e.message}`);
    }
  };

  const connectedPlayers = () => {
    const s = new Set();
    for (const m of conns.values()) if (m.role === 'player') s.add(m.playerId);
    return s;
  };

  const currentUrls = () => urlsFn(base, state);
  const viewOpts = () => ({
    now: now(),
    connected: connectedPlayers(),
    urls: currentUrls(),
    queue: voice.snapshot(),
    aiAvailable: ai.aiAvailable,
    aiCallsLeft: ai.callsLeft,
  });

  function gmExtras(v) {
    const g = v.gm;
    if (!g) return v;
    const tokens = state.host?.playerTokens ?? {};
    g.playersFull = (g.playersFull ?? []).map((p) => ({ ...p, joinUrl: tokens[p.id] ? playerUrl(base, tokens[p.id]) : '' }));
    const waiting = [...conns.values()];
    g.requests = waiting.filter((m) => m.role === 'claim').map((m) => ({ id: m.requestId, name: m.name, wants: m.wants ?? null, at: m.at }));
    g.tvs = (state.host?.tvs ?? []).map((tv) => ({
      id: tv.id, label: tv.label, at: tv.at,
      connected: waiting.filter((m) => m.role === 'stage' && m.tvId === tv.id).length,
    }));
    g.tvWaiting = waiting.filter((m) => m.role === 'pairing').length;
    g.stagesOn = waiting.filter((m) => m.role === 'stage').length; // any TV / stage page on air (paired or GM key)
    g.access = { edition, legacy, keyLogin: !!gmKey, backups: !!snapshots, maxTvs: L.maxTvs };
    g.tts = tts.gmView();
    g.sfx = pack.sfx ?? [];
    if (!legacy) {
      g.pins = {};
      g.stageUrl = currentUrls().stage;
    }
    return v;
  }

  const viewOf = (meta, o = viewOpts()) => {
    const v = viewFor(state, pack, meta.role, { ...o, playerId: meta.playerId });
    return meta.role === 'gm' ? gmExtras(v) : v;
  };

  // Portraits (data: URLs up to ~150 KB each) travel once per socket in a `portraits` frame; views carry
  // short "portrait:<hash>" refs instead, so a view with six crawlers stays small on every change.
  const portraitSent = new WeakMap(); // conn -> Set(ref)
  const refMemo = new Map();
  const portraitRef = (url) => {
    let ref = refMemo.get(url);
    if (ref) return ref;
    let x = 5381;
    let y = 0;
    for (let i = 0; i < url.length; i++) { x = ((x * 33) ^ url.charCodeAt(i)) >>> 0; y = (y * 31 + url.charCodeAt(i)) >>> 0; }
    ref = `portrait:${url.length.toString(36)}${x.toString(36)}${y.toString(36)}`;
    refMemo.set(url, ref);
    if (refMemo.size > 64) refMemo.delete(refMemo.keys().next().value);
    return ref;
  };
  /** Sends pictures one per frame; a ref counts as delivered only when its frame went out. */
  function sendPortraits(conn, refs, found) {
    let sent = portraitSent.get(conn);
    if (!sent) portraitSent.set(conn, (sent = new Set()));
    for (const r of refs) {
      if (!found[r]) continue;
      try {
        rawSend(conn, JSON.stringify({ t: 'portraits', portraits: { [r]: found[r] } }));
        sent.add(r);
      } catch (e) {
        log.warn?.(`[host] portrait send failed: ${e.message}`);
      }
    }
  }
  function withPortraits(conn, v) {
    const found = {};
    const swap = (url) => {
      if (typeof url !== 'string' || !url.startsWith('data:')) return url;
      const ref = portraitRef(url);
      found[ref] = url;
      return ref;
    };
    for (const p of v.players ?? []) p.portrait = swap(p.portrait);
    if (v.me?.sheet) v.me.sheet = { ...v.me.sheet, portrait: swap(v.me.sheet.portrait) };
    if (v.gm?.playersFull) v.gm.playersFull = v.gm.playersFull.map((p) => (p.sheet ? { ...p, sheet: { ...p.sheet, portrait: swap(p.sheet.portrait) } } : p));
    const sent = portraitSent.get(conn);
    sendPortraits(conn, Object.keys(found).filter((r) => !sent?.has(r)), found);
    return v;
  }
  /** A client is missing pictures (lost frame, cache cleared): send the ones the current state has. */
  function resendPortraits(conn, refs) {
    if (!Array.isArray(refs)) throw bad('refs must be an array');
    const found = {};
    for (const p of state.players) {
      const url = p.sheet?.portrait;
      if (typeof url === 'string' && url.startsWith('data:')) found[portraitRef(url)] = url;
    }
    const want = refs.filter((r) => typeof r === 'string' && Object.hasOwn(found, r)).slice(0, 12);
    sendPortraits(conn, want, found);
    return { sent: want.length };
  }
  const viewFrame = (conn, meta, o) => withPortraits(conn, viewOf(meta, o));

  function broadcastViews() {
    viewTimer = null;
    maybeAudienceTick();
    const o = viewOpts();
    for (const [c, m] of conns) if (VIEW_ROLES.has(m.role)) send(c, { t: 'view', view: viewFrame(c, m, o) });
  }
  const scheduleViews = () => {
    if (!viewTimer && !closed) viewTimer = T.setTimeout(broadcastViews, L.viewDebounceMs);
  };

  function deliver(event, to) {
    for (const [c, { role, playerId }] of conns) {
      if (!VIEW_ROLES.has(role)) continue;
      const ok =
        to === 'all' ||
        to.roles?.includes(role) ||
        (role === 'player' && ((to.playerId && to.playerId === playerId) || to.playerIds?.includes(playerId)));
      if (ok) send(c, { t: 'event', event });
    }
  }
  // Voice lines go to the stage AND the GM desk: whichever is view.show.audioDevice plays + acks (scenes.js).
  const toStage = (msg) => {
    for (const [c, m] of conns) if (m.role === 'stage' || m.role === 'gm') send(c, msg);
  };
  const toGm = (event) => deliver({ id: genId('e'), at: now(), ...event }, { roles: ['gm'] });

  const logEvent = (entry) => {
    eventLog.push(entry);
    if (eventLog.length > L.logMax) eventLog = eventLog.slice(-L.logMax);
  };

  // ---------- voice queue ----------

  const voiceBusy = () => voice.queue.length > 0 || voice.pending.length > 0 || !!voice.playing;
  function ensureVoiceTick() {
    if (!voiceTimer && !closed && voiceBusy()) {
      voiceTimer = T.setTimeout(() => {
        voiceTimer = null;
        voice.tick();
        ensureVoiceTick();
      }, L.voiceTickMs);
    }
  }

  const voice = new VoiceQueue({
    now,
    genId,
    getSession: () => state.session,
    consumeBudget: () => apply({ role: 'system', t: 'budget.consume' }),
    onPlay: (item) => {
      logEvent({ at: now(), kind: 'play', id: item.id, priority: item.priority, text: item.text, quipId: item.quipId });
      const silent = !!state.session.aiMute; // Mute AI: subtitle only, no audio / TTS / speech
      const audio = silent ? null : recordedAudio(pack, item, state.session.voice);
      recentPlays.set(item.id, { text: item.text, ttsVoice: item.ttsVoice ?? null, cue: item.cue ?? null });
      while (recentPlays.size > 50) recentPlays.delete(recentPlays.keys().next().value);
      toStage({
        t: 'play',
        id: item.id,
        priority: item.priority,
        text: item.text,
        audio,
        voice: voiceFor(pack, state.session.voice),
        cue: item.cue ?? null, // id of the event (achievement / announcement) this line belongs to
        sync: (state.show?.audioDevice ?? 'gm') === 'gm', // the TV waits for `audio.started` (max 3 s)
        tts: silent ? null : tts.playInfo(item, audio),
        ...(silent ? { silent: true } : {}),
      });
    },
    onStop: () => toStage({ t: 'stop' }),
    onChange: () => {
      scheduleViews();
      ensureVoiceTick();
    },
  });

  // ---------- show timers (only while a stage is connected, so idle campaigns can sleep) ----------

  function maybeAudienceTick() {
    const au = state.audience;
    const t = now();
    if (t - au.lastActivity < 60_000 || t - au.lastDecay < 60_000) return false;
    const r = reduce(state, { role: 'system', t: 'audience.tick' }, { now: t, pack });
    if (!r.changed) return false;
    commit(r.state, { at: t, by: 'system', action: null, system: true });
    return true;
  }

  function ensureShowTimers() {
    const stage = [...conns.values()].some((m) => m.role === 'stage');
    if (!stage || closed) {
      if (audienceTimer) T.clearTimeout(audienceTimer);
      if (chatTimer) T.clearTimeout(chatTimer);
      audienceTimer = chatTimer = null;
      return;
    }
    if (!audienceTimer) {
      const loop = () => {
        audienceTimer = T.setTimeout(() => {
          if (maybeAudienceTick()) scheduleViews();
          loop();
        }, L.audienceTickMs);
      };
      loop();
    }
    if (!chatTimer && chat && chatDirector.size) {
      const loop = (ms) => {
        chatTimer = T.setTimeout(() => {
          chatTimer = null;
          // A burst is running: calm chat waits for it to finish.
          if (chatBurst.length) return loop(4_000);
          const { line, delayMs } = chatDirector.ambient(state);
          if (line) sendChat(line);
          loop(delayMs);
        }, ms);
      };
      loop(2_000 + rng() * 4_000);
    }
  }

  // ---------- audience chat (chat.js): calm lines per scene + bursts after big moments ----------

  const chatDirector = createChat({ lines: pack.chat, rng, now });
  const chatBurst = []; // pending { line, at } of the current burst
  let chatBurstTimer = null;
  const MAX_BURST_QUEUE = 8;
  const stageOn = () => [...conns.values()].some((m) => m.role === 'stage');
  const sendChat = (line) => state.session.aiMute ? null : deliver({ id: genId('e'), at: now(), kind: 'chat', user: line.user, text: line.text, tag: line.tag }, { roles: ['stage'] });
  const stageSees = (to) => to === 'all' || !!to?.roles?.includes('stage');

  function pumpBurst() {
    chatBurstTimer = null;
    if (closed) { chatBurst.length = 0; return; }
    const t = now();
    while (chatBurst.length && chatBurst[0].at <= t) sendChat(chatBurst.shift().line);
    if (chatBurst.length) chatBurstTimer = T.setTimeout(pumpBurst, Math.max(0, chatBurst[0].at - t));
  }

  /** Big moments: a quick burst of chat lines and a viewer bump. Called after the events went out. */
  function reactTo(events, sceneBefore) {
    if (!chat || closed) return;
    // `chat.cue` events (combat-auto.js) reach no client; they only time a burst to the TV cinematic.
    const list = events.filter(({ event, to }) => event?.kind === 'chat.cue' || stageSees(to)).map(({ event }) => event);
    if (sceneBefore && state.scene && state.scene.kind !== sceneBefore.kind) list.push({ kind: 'scene', scene: state.scene.kind });
    let pct = 0;
    for (const e of list) {
      const r = chatDirector.react(e, state);
      if (!r) continue;
      if (r.viewers) pct += r.viewers;
      if (!stageOn() || !r.lines.length) continue;
      const delayed = r.delayMs > 0;
      let at = delayed ? now() + r.delayMs : Math.max(now(), chatBurst.length ? chatBurst[chatBurst.length - 1].at : 0);
      r.lines.forEach((line, k) => {
        at += r.gapsMs[k];
        chatBurst.push({ line, at });
      });
      if (delayed) chatBurst.sort((x, y) => x.at - y.at);
    }
    while (chatBurst.length > MAX_BURST_QUEUE) chatBurst.splice(MAX_BURST_QUEUE - 1, 1); // keep the newest moment's tail short
    if (chatBurst.length) {
      if (chatBurstTimer) T.clearTimeout(chatBurstTimer);
      chatBurstTimer = T.setTimeout(pumpBurst, Math.max(0, chatBurst[0].at - now()));
    }
    if (pct) {
      try {
        apply({ role: 'system', t: 'audience.react', pct: Math.min(0.3, pct) });
      } catch (e) {
        log.warn?.(`[chat] viewer bump failed: ${e.message}`);
      }
    }
  }

  // Voice lines with `delayMs` (combat auto mode: "<name> is down" lands on its TV step).
  const delayedLines = new Map(); // timer -> line
  function pushLine(line) {
    const { delayMs, ...l } = line;
    if (!(delayMs > 0) || closed) { voice.push(l); return; }
    const id = T.setTimeout(() => {
      delayedLines.delete(id);
      if (!closed) { voice.push(l); ensureVoiceTick(); }
    }, Math.min(30_000, delayMs));
    delayedLines.set(id, l);
  }
  /** GM skipped the cinematic: what was waiting for its moment plays now. */
  function flushDelayed() {
    for (const [id, l] of delayedLines) { T.clearTimeout(id); voice.push(l); }
    delayedLines.clear();
    ensureVoiceTick();
  }

  // ---------- state changes ----------

  /** Makes `next` the state and persists it. On a persist failure the previous state stays. */
  function commit(next, entry) {
    const prev = state;
    state = next;
    try {
      persist(state, { ...entry, prev });
    } catch (e) {
      state = prev;
      log.error?.(`[host] persist failed: ${e.message}`);
      throw new ActionError('internal', 'could not save the change, nothing happened');
    }
  }

  function snapshot(reason, st, at) {
    if (!snapshots) return null;
    try {
      return snapshots.create(reason, st, at);
    } catch (e) {
      log.error?.(`[host] snapshot failed: ${e.message}`);
      return null;
    }
  }

  /** Restore-point policy + activity bookkeeping for one accepted, non-system change. */
  function withActivity(next, prev, t, type) {
    const h = prev.host ?? {};
    let reason = null;
    if (type === 'session.new') reason = 'session.new';
    else if (h.lastActionAt && t - h.lastActionAt > L.idleMs) reason = 'idle';
    else if (!h.lastSnapshotAt || t - h.lastSnapshotAt >= L.snapshotEveryMs) reason = 'periodic';
    const host = { ...next.host, lastActionAt: t };
    if (reason && snapshots && snapshot(reason, prev, t) != null) host.lastSnapshotAt = t;
    return { ...next, host };
  }

  /** Commits a host-level change (tokens, TVs, restore) that is not a reducer action. */
  function commitAccess(next, action, by) {
    const t = now();
    commit(withActivity(ensureAccess(next, L.tokenBytes), state, t, action.t), { at: t, by, action: sanitizeAction(action), system: false });
    logEvent({ at: t, kind: 'action', action: sanitizeAction(action) });
  }

  /** Runs one action through the reducer and performs all side effects. Throws ActionError. */
  function apply(action, reducer = (st, a, ctx) => reduce(st, a, ctx), by = action.role) {
    const t = now();
    const sceneBefore = state.scene;
    const r = reducer(state, action, { now: t, rng, pack });
    if (!r.changed) return r;
    const system = action.role === 'system';
    let next = ensureAccess(r.state, L.tokenBytes);
    if (!system) next = withActivity(next, state, t, action.t);
    commit(next, { at: t, by, action: system ? null : sanitizeAction(action), system });
    if (!system) logEvent({ at: t, kind: 'action', action: sanitizeAction(action) });
    const lines = cueLines(r.events, tts.rewriteLines(r.events, r.lines));
    for (const { event, to } of r.events) {
      logEvent({ ...event, log: 'event' });
      deliver(event, to);
    }
    for (const fx of r.effects) {
      if (fx.type === 'archive') {
        try {
          onArchive(fx.session, eventLog, state);
        } catch (e) {
          log.error?.(`[session] archive failed: ${e.message}`);
        }
        eventLog = [];
        ai.resetSession();
      } else if (fx.type === 'clearPending') voice.clearPending();
      else if (fx.type === 'queueClear') voice.clear();
    }
    for (const line of lines) pushLine(line);
    if (r.events.some(({ event }) => event?.kind === 'combat.autoSkip')) flushDelayed();
    if (action.t === 'player.remove') closePlayer(action.playerId, CLOSE.removed, 'removed');
    if (!system) reactTo(r.events, sceneBefore);
    scheduleViews();
    return r;
  }

  /** Achievement + its voice line: the TV holds the takeover until the GM desk starts the audio. */
  function cueLines(events, lines) {
    const gmDevice = (state.show?.audioDevice ?? 'gm') === 'gm';
    if (!gmDevice || !lines.length) return lines;
    return lines.map((l) => {
      if (l.category !== 'achievement' && !/^New achievement/.test(l.text)) return l;
      const ev = events.map((x) => x.event).find((e) => e?.kind === 'achievement' && !e.voiceCue);
      if (!ev) return l;
      ev.voiceCue = true;
      return { ...l, cue: ev.id };
    });
  }

  function closePlayer(playerId, code, reason) {
    for (const [c, m] of [...conns]) if (m.role === 'player' && m.playerId === playerId) dropConn(c, code, reason);
  }

  /** Player-originated action: identity comes from the socket, never from the payload. */
  function applyPlayer(payload, playerId) {
    return apply({ ...payload, role: 'player', actorId: playerId }, (st, a, ctx) => reducePlayerAction(st, payload, { ...ctx, playerId }), playerId);
  }

  // ---------- auth ----------

  function armTimer(conn, meta, at, code, reason) {
    if (meta.timer) T.clearTimeout(meta.timer);
    meta.timer = T.setTimeout(() => {
      if (conns.get(conn) === meta) dropConn(conn, code, reason);
    }, Math.max(0, at - now()));
  }

  function bucketFor(role) {
    const [rate, burst] = L.rate[role] ?? L.rate.other;
    return new TokenBucket({ rate, burst, now });
  }

  function authed(conn, meta, role, extra = {}) {
    if (meta.timer) T.clearTimeout(meta.timer);
    meta.timer = null;
    for (const k of ['code', 'codeExpires', 'requestId', 'name', 'wants', 'helloBy']) delete meta[k];
    Object.assign(meta, { role, playerId: null, tvId: null, ...extra });
    meta.bucket = bucketFor(role);
    saveMeta(conn, meta);
    const welcome = { t: 'welcome', role, view: VIEW_ROLES.has(role) ? viewFrame(conn, meta) : viewOf(meta) };
    if (meta.playerId) welcome.playerId = meta.playerId;
    send(conn, welcome);
    ensureShowTimers();
    scheduleViews();
  }

  function refuse(conn, code, msg) {
    send(conn, { t: 'error', code, msg });
    if (code !== 'bad_request') dropConn(conn, CLOSE.auth, code);
  }

  const failMsg = (code) => (code === 'rate_limited' ? 'too many failed attempts, wait a minute' : 'authentication failed');

  /** Checks a credential against a limiter bucket. Returns 'ok' | 'bad_auth' | 'rate_limited'. */
  function check(bucket, good) {
    if (authLimiter.blocked(bucket)) return 'rate_limited';
    if (good()) return 'ok';
    authLimiter.fail(bucket);
    return 'bad_auth';
  }

  /** GM credential for HTTP routes (export): { key } or, with legacy, { token }. */
  function checkGm(cred, ip = '?') {
    return check(`gm:${ip}`, () =>
      (typeof cred?.key === 'string' && !!gmKey && safeEqual(cred.key, gmKey)) ||
      (legacy && typeof cred?.token === 'string' && safeEqual(cred.token, state.gmToken)),
    );
  }

  const findPlayerByToken = (token) => {
    let found = null;
    for (const [id, tok] of Object.entries(state.host?.playerTokens ?? {})) if (safeEqual(token, tok) && !found) found = id;
    return found;
  };
  const findTvByToken = (token) => {
    let found = null;
    for (const tv of state.host?.tvs ?? []) if (safeEqual(token, tv.token) && !found) found = tv.id;
    return found;
  };
  const waitingCount = (role) => [...conns.values()].filter((m) => m.role === role).length;

  function hello(conn, meta, msg) {
    const ip = meta.ip ?? '?';
    const role = msg.role;
    if (role === 'gm') {
      let r = 'bad_auth';
      if (typeof msg.key === 'string') r = check(`gm:${ip}`, () => !!gmKey && safeEqual(msg.key, gmKey));
      else if (legacy && typeof msg.token === 'string') r = check(`gm:${ip}`, () => safeEqual(msg.token, state.gmToken));
      else if (!legacy) r = check(`gm:${ip}`, () => false);
      if (r !== 'ok') return refuse(conn, r, !gmKey && typeof msg.key === 'string' ? 'GM_KEY is not set on the server' : failMsg(r));
      return authed(conn, meta, 'gm');
    }
    if (role === 'stage') {
      if (msg.pair === true) return startPairing(conn, meta);
      let r = 'bad_auth';
      let tvId = null;
      if (typeof msg.tvToken === 'string') r = check(`tok:${ip}`, () => !!(tvId = findTvByToken(msg.tvToken)));
      else if (typeof msg.key === 'string') r = check(`gm:${ip}`, () => !!gmKey && safeEqual(msg.key, gmKey)); // GM's own machine / preview
      else if (legacy && typeof msg.token === 'string') r = check(`tok:${ip}`, () => safeEqual(msg.token, state.stageToken));
      if (r !== 'ok') return refuse(conn, r, failMsg(r));
      return authed(conn, meta, 'stage', { tvId });
    }
    if (role === 'player') {
      if (msg.claim === true) return startClaim(conn, meta, msg);
      if (typeof msg.token === 'string') {
        let playerId = null;
        const r = check(`tok:${ip}`, () => !!(playerId = findPlayerByToken(msg.token)));
        if (r !== 'ok') return refuse(conn, r, failMsg(r));
        return authed(conn, meta, 'player', { playerId });
      }
      if (legacy) {
        const a = authenticate(state, msg, ip, pinLimiter);
        if (!a.ok) return refuse(conn, a.code, a.code === 'rate_limited' ? 'too many wrong PINs, wait a minute' : 'authentication failed');
        return authed(conn, meta, 'player', { playerId: a.playerId });
      }
      return refuse(conn, 'bad_auth', 'this server needs your personal link (ask the GM) or a join request');
    }
    return refuse(conn, 'bad_request', 'role must be gm, stage or player');
  }

  function startPairing(conn, meta) {
    if (waitingCount('pairing') >= L.maxWaiting) {
      send(conn, { t: 'error', code: 'busy', msg: 'too many screens waiting to pair' });
      return dropConn(conn, CLOSE.expired, 'busy');
    }
    const taken = new Set([...conns.values()].filter((m) => m.role === 'pairing').map((m) => m.code));
    Object.assign(meta, { role: 'pairing', code: makePairCode(taken), codeExpires: now() + L.pairTtlMs, at: now() });
    delete meta.helloBy;
    armTimer(conn, meta, meta.codeExpires, CLOSE.expired, 'pair_expired');
    saveMeta(conn, meta);
    send(conn, { t: 'pairing', code: meta.code, expiresAt: meta.codeExpires });
    scheduleViews();
  }

  function claimCharacters() {
    const on = connectedPlayers();
    return state.players.map((p) => ({ id: p.id, name: p.name, color: p.color, connected: on.has(p.id) }));
  }

  function startClaim(conn, meta, msg) {
    const name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 40) : '';
    if (!name) return send(conn, { t: 'error', code: 'bad_request', msg: 'name required' });
    if (waitingCount('claim') >= L.maxWaiting) {
      send(conn, { t: 'error', code: 'busy', msg: 'too many join requests waiting, try again in a minute' });
      return dropConn(conn, CLOSE.expired, 'busy');
    }
    Object.assign(meta, { role: 'claim', requestId: genId('rq'), name, wants: null, at: now(), codeExpires: now() + L.claimTtlMs });
    delete meta.helloBy;
    armTimer(conn, meta, meta.codeExpires, CLOSE.expired, 'request_expired');
    saveMeta(conn, meta);
    send(conn, { t: 'claim', requestId: meta.requestId, characters: claimCharacters() });
    toGm({ kind: 'joinRequest', requestId: meta.requestId, name });
    scheduleViews();
  }

  function findWaiting(role, pred) {
    for (const [c, m] of conns) if (m.role === role && pred(m)) return [c, m];
    return [null, null];
  }

  // ---------- host-level GM actions (access, devices, backups) ----------

  const playerExists = (id) => typeof id === 'string' && state.players.some((p) => p.id === id);
  const bad = (msg) => new ActionError('bad_request', msg);
  const notFound = (msg) => new ActionError('not_found', msg);

  function audioStarted(msg) {
    if (typeof msg.id !== 'string') throw bad('id required');
    const p = recentPlays.get(msg.id);
    for (const [c, m] of conns) if (m.role === 'stage') send(c, { t: 'audio.started', id: msg.id, cue: p?.cue ?? null });
  }

  const ttsCtx = { pushLine: (line) => voice.push(line), lineOf: (id) => recentPlays.get(id) ?? null };

  const HOST_GM = {
    ...Object.fromEntries(Object.entries(tts.handlers).map(([k, fn]) => [k, (msg) => fn(msg, ttsCtx)])),
    'audio.started': audioStarted,
    /** Free-text announcement: TV takeover + System voice (P0), in sync via `audio.started`. */
    announce(msg) {
      const text = typeof msg.text === 'string' ? msg.text.replace(/\s+/g, ' ').trim() : '';
      if (!text) throw bad('text required');
      if (text.length > 1000) throw bad('text too long (max 1000 characters)');
      const gmDevice = (state.show?.audioDevice ?? 'gm') === 'gm';
      const event = { id: genId('e'), at: now(), kind: 'announcement', from: pack.systemName || 'The System', text, voiceCue: gmDevice };
      logEvent({ ...event, log: 'event' });
      deliver(event, { roles: ['stage', 'gm'] });
      if (msg.voice !== false) voice.push({ priority: 0, text, quipId: null, crit: false, cue: event.id });
      return { eventId: event.id };
    },
    'audio.done'(msg) {
      // The GM desk is the audio device by default (show.audio).
      if (typeof msg.id !== 'string') throw bad('id required');
      voice.done(msg.id);
    },
    'auto.veto'(msg) {
      if (!voice.veto(msg.id)) throw notFound(`no pending line ${msg.id}`);
    },
    'queue.clear'() {
      voice.clear();
    },
    'player.relink'(msg) {
      if (!playerExists(msg.playerId)) throw notFound(`no player ${msg.playerId}`);
      const tokens = { ...state.host.playerTokens, [msg.playerId]: makeToken(L.tokenBytes) };
      commitAccess({ ...state, host: { ...state.host, playerTokens: tokens } }, msg, 'gm');
      closePlayer(msg.playerId, CLOSE.auth, 'relinked');
      scheduleViews();
      return { playerId: msg.playerId, joinUrl: playerUrl(base, tokens[msg.playerId]) };
    },
    'player.approve'(msg) {
      const [c, m] = findWaiting('claim', (x) => x.requestId === msg.requestId);
      if (!c) throw notFound(`no join request ${msg.requestId}`);
      const playerId = msg.playerId ?? m.wants;
      if (!playerExists(playerId)) throw notFound(`no player ${playerId}`);
      const at = now();
      commit(state, { at, by: 'gm', action: sanitizeAction({ ...msg, playerId, name: m.name }), system: false });
      logEvent({ at, kind: 'action', action: sanitizeAction({ ...msg, playerId, name: m.name }) });
      send(c, { t: 'token', token: state.host.playerTokens[playerId], playerId });
      authed(c, m, 'player', { playerId });
      return { playerId };
    },
    'player.deny'(msg) {
      const [c] = findWaiting('claim', (x) => x.requestId === msg.requestId);
      if (!c) throw notFound(`no join request ${msg.requestId}`);
      send(c, { t: 'error', code: 'denied', msg: 'The GM declined this request.' });
      dropConn(c, CLOSE.auth, 'denied');
      scheduleViews();
    },
    'tv.pair'(msg) {
      const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
      if (!/^[A-Z]{4}$/.test(code)) throw bad('code must be the 4 letters shown on the TV');
      const [c, m] = findWaiting('pairing', (x) => x.code === code && x.codeExpires > now());
      if (!c) throw notFound(`no screen is showing ${code}`);
      const tvs = state.host.tvs ?? [];
      if (tvs.length >= L.maxTvs) throw bad(`max ${L.maxTvs} TVs, unpair one first`);
      const label = typeof msg.label === 'string' && msg.label.trim() ? msg.label.trim().slice(0, 40) : `TV ${tvs.length + 1}`;
      const tv = { id: genId('tv'), token: makeToken(L.tokenBytes), label, at: now() };
      commitAccess({ ...state, host: { ...state.host, tvs: [...tvs, tv] } }, { t: 'tv.pair', tvId: tv.id, label }, 'gm');
      send(c, { t: 'paired', tvToken: tv.token, tvId: tv.id });
      authed(c, m, 'stage', { tvId: tv.id });
      return { tvId: tv.id };
    },
    'tv.unpair'(msg) {
      const tvs = state.host.tvs ?? [];
      if (!tvs.some((tv) => tv.id === msg.tvId)) throw notFound(`no TV ${msg.tvId}`);
      commitAccess({ ...state, host: { ...state.host, tvs: tvs.filter((tv) => tv.id !== msg.tvId) } }, msg, 'gm');
      for (const [c, m] of [...conns]) if (m.role === 'stage' && m.tvId === msg.tvId) dropConn(c, CLOSE.auth, 'revoked');
      scheduleViews();
    },
    'backup.list'() {
      if (!snapshots) throw bad('restore points are not available on this server');
      return { backups: snapshots.list() };
    },
    'backup.create'(msg) {
      if (!snapshots) throw bad('restore points are not available on this server');
      const id = snapshot('manual', state, now());
      if (id == null) throw new ActionError('internal', 'could not create the restore point');
      return { id };
    },
    'backup.restore'(msg) {
      if (!snapshots) throw bad('restore points are not available on this server');
      const raw = snapshots.load(msg.id);
      if (!raw) throw notFound(`no restore point ${msg.id}`);
      const t = now();
      const before = snapshot('before-restore', state, t);
      if (before == null) throw new ActionError('internal', 'could not save the current state first, nothing restored');
      const restored = normalizeState(JSON.parse(JSON.stringify(raw)), pack, t);
      // Access is about devices, not game history: keep today's links, TVs and secrets.
      const cur = state.host ?? {};
      const tokens = { ...(raw.host?.playerTokens ?? {}), ...(cur.playerTokens ?? {}) };
      const next = {
        ...restored,
        room: state.room, gmToken: state.gmToken, stageToken: state.stageToken,
        host: { ...cur, playerTokens: tokens, lastSnapshotAt: t },
      };
      commit(ensureAccess(next, L.tokenBytes), { at: t, by: 'gm', action: sanitizeAction(msg), system: false });
      logEvent({ at: t, kind: 'action', action: sanitizeAction(msg) });
      voice.clear();
      for (const [c, m] of [...conns]) if (m.role === 'player' && !playerExists(m.playerId)) dropConn(c, CLOSE.removed, 'removed');
      scheduleViews();
      return { restored: msg.id, backup: before };
    },
  };

  // ---------- incoming ----------

  const ridOf = (msg) => (typeof msg.rid === 'string' || typeof msg.rid === 'number' ? msg.rid : undefined);

  async function handleAction(conn, meta, msg) {
    const { role, playerId } = meta;
    const rid = ridOf(msg);
    try {
      let result;
      if (role === 'stage') {
        if (msg.t === 'audio.done') {
          if (typeof msg.id !== 'string') throw bad('id required');
          voice.done(msg.id);
        } else if (msg.t === 'audio.started') {
          audioStarted(msg);
        } else if (msg.t === 'audio.pause') {
          if (typeof msg.silent !== 'boolean') throw bad('silent must be a boolean');
          // Phase 1 treats the table as always silent; phase-3 hook: voice.setSilent(msg.silent)
        } else {
          throw bad(`unknown action ${msg.t} for role stage`);
        }
      } else if (role === 'gm') {
        if (Object.hasOwn(HOST_GM, msg.t)) {
          result = await HOST_GM[msg.t](msg);
        } else {
          let action = { ...msg, role: 'gm' };
          // Custom achievement without desc: let AI write one if available.
          if (msg.t === 'ach.award' && msg.achId === undefined && typeof msg.title === 'string' && !msg.desc && ai.available()) {
            const p = state.players.find((x) => x.id === msg.playerId);
            const desc = await ai.generateAchievementText({ title: msg.title, playerName: p?.name, klass: p?.klass, race: p?.race });
            if (desc) action = { ...action, desc: desc.slice(0, 300) };
          }
          result = apply(action).result;
        }
      } else if (role === 'player') {
        const { rid: _rid, ...payload } = msg;
        result = applyPlayer(payload, playerId).result;
      }
      if (rid !== undefined) send(conn, { t: 'ack', rid, ok: true, ...(result ? { result } : {}) });
    } catch (e) {
      const code = e instanceof ActionError ? e.code : 'bad_request';
      if (!(e instanceof ActionError)) log.error?.('[host] action failed:', e);
      if (rid !== undefined) send(conn, { t: 'ack', rid, ok: false, error: code, msg: e.message });
      else send(conn, { t: 'error', code, msg: e.message });
    }
  }

  function message(conn, data) {
    const meta = conns.get(conn);
    if (!meta || closed) return;
    if (typeof data !== 'string') return send(conn, { t: 'error', code: 'bad_request', msg: 'invalid JSON' });
    // Authenticated GM / player sockets may send one bigger frame kind: the portrait upload.
    const big = (meta.role === 'gm' || meta.role === 'player') && data.length <= L.maxPortraitMessage && /"t":"sheet\.set"/.test(data.slice(0, 300)) && /"path":"(identity\.)?portrait"/.test(data.slice(0, 300));
    if (data.length > L.maxMessage && !big) return dropConn(conn, CLOSE.tooBig, 'message too big');
    if (!meta.bucket) meta.bucket = bucketFor(VIEW_ROLES.has(meta.role) ? meta.role : 'other');
    if (!meta.bucket.take()) {
      const t = now();
      if (!meta.limitedAt || t - meta.limitedAt > 1000) {
        meta.limitedAt = t;
        send(conn, { t: 'error', code: 'rate_limited', msg: 'too many messages, slow down' });
      }
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return send(conn, { t: 'error', code: 'bad_request', msg: 'invalid JSON' });
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') {
      return send(conn, { t: 'error', code: 'bad_request', msg: 'message must be an object with string t' });
    }
    if (msg.t === 'ping') return send(conn, { t: 'pong', rid: ridOf(msg) });
    if (!meta.role) {
      if (msg.t !== 'hello') return send(conn, { t: 'error', code: 'bad_request', msg: 'send hello first' });
      return hello(conn, meta, msg);
    }
    if (msg.t === 'hello') return send(conn, { t: 'error', code: 'bad_request', msg: 'already authenticated' });
    if (meta.role === 'claim') {
      if (msg.t !== 'claim.pick') return send(conn, { t: 'error', code: 'bad_request', msg: 'waiting for the GM' });
      if (msg.playerId !== null && !playerExists(msg.playerId)) return send(conn, { t: 'ack', rid: ridOf(msg), ok: false, error: 'not_found', msg: 'no such character' });
      meta.wants = msg.playerId;
      saveMeta(conn, meta);
      scheduleViews();
      return send(conn, { t: 'ack', rid: ridOf(msg), ok: true });
    }
    if (meta.role === 'pairing') return send(conn, { t: 'error', code: 'bad_request', msg: 'waiting for the GM to pair this screen' });
    if (msg.t === 'portraits.want' && VIEW_ROLES.has(meta.role)) {
      try {
        const result = resendPortraits(conn, msg.refs);
        if (ridOf(msg) !== undefined) send(conn, { t: 'ack', rid: ridOf(msg), ok: true, result });
      } catch (e) {
        send(conn, { t: 'ack', rid: ridOf(msg), ok: false, error: 'bad_request', msg: e.message });
      }
      return;
    }
    return handleAction(conn, meta, msg);
  }

  function connect(conn, info = {}) {
    if (closed) return false;
    if (conns.size >= L.maxSockets) {
      try {
        rawClose(conn, CLOSE.busy, 'too many connections');
      } catch {}
      return false;
    }
    if (info.base) base = info.base;
    const meta = { role: null, playerId: null, tvId: null, ip: info.ip ?? '?', base: info.base ?? base, helloBy: now() + L.helloTimeoutMs };
    conns.set(conn, meta);
    armTimer(conn, meta, meta.helloBy, CLOSE.helloTimeout, 'hello timeout');
    saveMeta(conn, meta);
    return true;
  }

  /** Re-registers a socket after the host was rebuilt (hibernation wake). Never sends anything. */
  function restore(conn, saved) {
    if (closed) return;
    const meta = { role: null, playerId: null, tvId: null, ip: '?', ...(saved ?? {}) };
    if (meta.base && !base) base = meta.base;
    conns.set(conn, meta);
    const t = now();
    if (!meta.role) {
      const by = meta.helloBy ?? t;
      if (by <= t) return dropConn(conn, CLOSE.helloTimeout, 'hello timeout');
      armTimer(conn, meta, by, CLOSE.helloTimeout, 'hello timeout');
    } else if (WAITING_ROLES.has(meta.role)) {
      if (!(meta.codeExpires > t)) return dropConn(conn, CLOSE.expired, meta.role === 'pairing' ? 'pair_expired' : 'request_expired');
      armTimer(conn, meta, meta.codeExpires, CLOSE.expired, meta.role === 'pairing' ? 'pair_expired' : 'request_expired');
    } else if (meta.role === 'player' && !playerExists(meta.playerId)) {
      return dropConn(conn, CLOSE.removed, 'removed');
    } else if (meta.role === 'stage' && meta.tvId && !(state.host?.tvs ?? []).some((tv) => tv.id === meta.tvId)) {
      return dropConn(conn, CLOSE.auth, 'revoked');
    }
    ensureShowTimers();
  }

  function forget(conn, meta) {
    if (meta.timer) T.clearTimeout(meta.timer);
    conns.delete(conn);
    if (meta.role) {
      ensureShowTimers();
      scheduleViews();
    }
  }

  function disconnect(conn) {
    const meta = conns.get(conn);
    if (meta) forget(conn, meta);
  }

  function close() {
    closed = true;
    for (const t of [viewTimer, voiceTimer, audienceTimer, chatTimer, chatBurstTimer, ...delayedLines.keys()]) if (t) T.clearTimeout(t);
    delayedLines.clear();
    for (const m of conns.values()) if (m.timer) T.clearTimeout(m.timer);
    viewTimer = voiceTimer = audienceTimer = chatTimer = chatBurstTimer = null;
  }

  return {
    connect,
    restore,
    message,
    disconnect,
    close,
    checkGm,
    apply,
    has: (conn) => conns.has(conn),
    canAccept: () => conns.size < L.maxSockets,
    setBase(b) {
      if (b) base = b;
    },
    setGmKey(k) {
      gmKey = typeof k === 'string' ? k : '';
    },
    get base() {
      return base;
    },
    get urls() {
      return currentUrls();
    },
    get state() {
      return state;
    },
    get log() {
      return eventLog;
    },
    get conns() {
      return conns;
    },
    pack,
    voice,
    tts,
    limits: L,
  };
}
