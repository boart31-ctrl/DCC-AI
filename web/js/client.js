// Shared WebSocket client for The System.
// - connects to ws(s)://<host>/ws, sends hello for the given role
// - auto-reconnects with exponential backoff (+jitter), re-sending hello
// - send(action) -> Promise resolved/rejected by the matching `ack` (via rid)
// - tiny event emitter: 'welcome', 'view', 'event', 'play', 'stop', 'error', 'status', 'pong', 'message'

export class Emitter {
  constructor() { this._h = new Map(); }
  on(type, fn) {
    if (!this._h.has(type)) this._h.set(type, new Set());
    this._h.get(type).add(fn);
    return () => this._h.get(type)?.delete(fn);
  }
  emit(type, data) {
    const set = this._h.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(data); } catch (err) { console.error(`[client] ${type} handler failed`, err); }
    }
  }
}

let ridSeq = 0;
const newRid = () => `r${Date.now().toString(36)}${(ridSeq++).toString(36)}`;

export class SystemClient extends Emitter {
  /**
   * @param {object} opts
   * @param {() => object} opts.hello  returns the hello payload (minus t) each (re)connect
   * @param {string} [opts.url]
   * @param {number} [opts.ackTimeout]
   */
  constructor({ hello, url, ackTimeout = 8000 } = {}) {
    super();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = url || `${proto}//${location.host}/ws`;
    this.hello = hello;
    this.ackTimeout = ackTimeout;
    this.ws = null;
    this.status = 'idle'; // idle | connecting | open | closed | rejected
    this.view = null;
    this.role = null;
    this.playerId = null;
    this.pending = new Map();
    this.attempt = 0;
    this.stopped = false;
    this._timer = null;
    this._ping = null;
    this._onVisible = () => {
      if (document.visibilityState === 'visible' && this.status !== 'open' && !this.stopped) {
        this._reconnectNow();
      }
    };
    document.addEventListener('visibilitychange', this._onVisible);
    window.addEventListener('online', this._onVisible);
  }

  _setStatus(s, detail) {
    this.status = s;
    this.emit('status', { status: s, attempt: this.attempt, ...detail });
  }

  connect() {
    this.stopped = false;
    clearTimeout(this._timer);
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this._setStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      try { ws.send(JSON.stringify({ t: 'hello', ...this.hello() })); } catch {}
      clearInterval(this._ping);
      this._ping = setInterval(() => this.raw({ t: 'ping' }), 25000);
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this._handle(msg);
    };
    ws.onclose = (ev) => {
      clearInterval(this._ping);
      if (this.ws !== ws) return;
      this.ws = null;
      this._failPending('disconnected');
      // 4001 = bad_auth / rate_limited, 4004 = player removed: never loop on these.
      if (ev.code === 4001 || ev.code === 4004) {
        this.stopped = true;
        if (this.status !== 'rejected') {
          const code = ev.code === 4004 ? 'removed' : (ev.reason || this._lastErr || 'bad_auth');
          this._setStatus('rejected', { code, msg: ev.code === 4004 ? 'You were removed from the game.' : undefined });
        }
        return;
      }
      if (this.status === 'rejected' || this.stopped) return;
      this._setStatus('closed');
      this._scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  _handle(msg) {
    switch (msg.t) {
      case 'welcome':
        this.role = msg.role;
        this.playerId = msg.playerId || null;
        this.view = msg.view || this.view;
        this._setStatus('open');
        this.emit('welcome', msg);
        if (msg.view) this.emit('view', msg.view);
        break;
      case 'view':
        this.view = msg.view;
        this.emit('view', msg.view);
        break;
      case 'event':
        this.emit('event', msg.event);
        break;
      case 'play':
        this.emit('play', msg);
        break;
      case 'stop':
        this.emit('stop', msg);
        break;
      case 'ack': {
        const p = this.pending.get(msg.rid);
        if (!p) break;
        this.pending.delete(msg.rid);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg);
        else p.reject(Object.assign(new Error(msg.msg || msg.error || 'Refused'), { code: msg.error, ack: msg }));
        break;
      }
      case 'error':
        this._lastErr = msg.code;
        // Errors before welcome are auth failures; the server closes after bad_auth.
        if (this.status !== 'open' && ['bad_auth', 'not_found', 'rate_limited'].includes(msg.code)) {
          this.stopped = true;
          this._setStatus('rejected', { code: msg.code, msg: msg.msg });
        }
        this.emit('error', msg);
        break;
      case 'pong':
        this.emit('pong', msg);
        break;
      case 'portraits':
        // Sent before the view that references them; views carry "portrait:<hash>" refs.
        for (const [ref, url] of Object.entries(msg.portraits || {})) PORTRAITS.set(ref, url);
        break;
      default:
        this.emit('message', msg);
    }
  }

  _scheduleReconnect() {
    clearTimeout(this._timer);
    const base = Math.min(15000, 500 * 2 ** this.attempt);
    const delay = base / 2 + Math.random() * base / 2;
    this.attempt++;
    this.emit('status', { status: this.status, attempt: this.attempt, retryIn: delay });
    this._timer = setTimeout(() => this.connect(), delay);
  }

  _reconnectNow() {
    clearTimeout(this._timer);
    this.attempt = 0;
    this.connect();
  }

  /** Retry after a rejection (e.g. player typed a new PIN). */
  retry() {
    this.stopped = false;
    this.attempt = 0;
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.connect();
  }

  close() {
    this.stopped = true;
    clearTimeout(this._timer);
    clearInterval(this._ping);
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this._setStatus('idle');
  }

  _failPending(reason) {
    for (const [rid, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(rid);
    }
  }

  /** Fire-and-forget (no rid). Returns false if not connected. */
  raw(msg) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(JSON.stringify(msg)); return true; } catch { return false; }
  }

  /** Send an action with a rid; resolves on ack ok, rejects on ack error/timeout/disconnect. */
  send(action) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1 || this.status !== 'open') {
        reject(new Error('Not connected'));
        return;
      }
      const rid = newRid();
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error('No answer from host'));
      }, this.ackTimeout);
      this.pending.set(rid, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ ...action, rid }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(rid);
        reject(err);
      }
    });
  }
}

/* ---------- small shared helpers ---------- */

export const store = {
  get(area, key) {
    try { return window[area].getItem(key); } catch { return null; }
  },
  set(area, key, val) {
    try { window[area].setItem(key, val); } catch {}
  },
  del(area, key) {
    try { window[area].removeItem(key); } catch {}
  },
};

/** Read a secret token from #hash, persist to sessionStorage, strip from URL bar. */
export function takeHashToken(key) {
  let token = location.hash.replace(/^#/, '').trim();
  if (token) {
    store.set('sessionStorage', key, token);
    try { history.replaceState(null, '', location.pathname + location.search); } catch {}
  } else {
    token = store.get('sessionStorage', key) || '';
  }
  return token;
}

export function buzz(pattern = 10) {
  try { navigator.vibrate?.(pattern); } catch {}
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** h('div.cls#id', {attrs}, ...children) — minimal DOM builder. */
export function h(tag, attrs, ...kids) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag) || [];
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    kids.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv);
        else el.style[sk] = sv;
      }
    }
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function toast(msg, { error = false, ms = 2200 } = {}) {
  let wrap = document.querySelector('.toasts');
  if (!wrap) {
    wrap = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.append(wrap);
  }
  const t = h('div.toast' + (error ? '.err' : ''), msg);
  wrap.append(t);
  while (wrap.children.length > 4) wrap.firstChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 350); }, ms);
}

const RARITY_GLYPH = { common: '◆', uncommon: '✚', rare: '★', epic: '✦', legendary: '✸' };
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
export const rarityOf = (r) => (RARITIES.includes(r) ? r : 'common');

/** Item art element: <img> with placeholder fallback on missing/error. */
export function itemArt(item, cls = '') {
  const r = rarityOf(item?.rarity);
  const wrap = h(`div.art.r-${r}${cls ? '.' + cls : ''}`);
  const glyph = RARITY_GLYPH[r];
  const ph = () => {
    wrap.classList.add('ph');
    wrap.replaceChildren(h('span', { 'aria-hidden': 'true' }, glyph));
  };
  const src = item?.image;
  if (src) {
    const img = h('img', { alt: item.name || '', loading: 'lazy', decoding: 'async' });
    img.onerror = ph;
    img.src = src.startsWith('/') || /^https?:/.test(src) ? src : `/pack/images/${src}`;
    wrap.append(img);
  } else {
    ph();
  }
  return wrap;
}

export function fmtNum(n) {
  n = Math.round(Number(n) || 0);
  return n.toLocaleString('en-US');
}

export function timeAgo(at) {
  if (!at) return '';
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

export function playerById(view, id) {
  return view?.players?.find((p) => p.id === id) || null;
}

export function prefersReducedMotion() {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

export function registerSW() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

/** Connection overlay text helper. */
export function statusText(s) {
  switch (s.status) {
    case 'connecting': return s.attempt > 1 ? `Reconnecting (try ${s.attempt})` : 'Connecting';
    case 'closed': return 'Signal lost. Reconnecting';
    case 'rejected': return s.msg || 'Access refused';
    case 'open': return 'Live';
    default: return '';
  }
}

/* ---------- portraits (host sends each picture once per connection) ---------- */

const PORTRAITS = new Map();
/** Image URL for a sheet / player portrait value: data/http URL as is, "portrait:<hash>" from the cache. */
export function portraitSrc(v) {
  if (typeof v !== 'string' || !v) return null;
  return v.startsWith('portrait:') ? PORTRAITS.get(v) || null : v;
}

/* ---------- transport hub ---------- */

const HUB_TYPES = ['welcome', 'view', 'event', 'play', 'stop', 'error', 'status', 'pong', 'message'];

/**
 * What the page UIs talk to. A hub forwards one attached transport (SystemClient over WebSocket for
 * the Node edition, or an Artifact transport for the hosted edition) so page modules can register
 * listeners at import time, before the transport exists.
 * Transport contract: on(type, fn), send(action) -> Promise<ack>, raw(msg) -> bool, optional
 * connect()/retry()/close(). Emits the HUB_TYPES above with the same payloads as SystemClient.
 */
export class TransportHub extends Emitter {
  constructor() {
    super();
    this.t = null;
    this.status = 'idle';
    this.view = null;
  }
  attach(t) {
    this.t = t;
    for (const type of HUB_TYPES) {
      t.on(type, (d) => {
        if (type === 'view') this.view = d;
        if (type === 'status') this.status = d.status;
        this.emit(type, d);
      });
    }
    return this;
  }
  send(action) { return this.t ? this.t.send(action) : Promise.reject(new Error('Not connected')); }
  raw(msg) { return this.t ? this.t.raw(msg) : false; }
  connect() { this.t?.connect?.(); }
  retry() { this.t?.retry?.(); }
  close() { this.t?.close?.(); }
}

/** True when the hosted (claude.ai Artifact) boot loaded the page modules. */
export const isHosted = () => !!globalThis.__SYSTEM_HOSTED__;

/**
 * In-page confirmation (window.confirm is unavailable inside an Artifact frame).
 * Resolves true when the person picks the confirm button.
 */
export function ask(message, { ok = 'Confirm', cancel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = h('dialog.ask-dlg');
    const done = (v) => { try { dlg.close(); } catch {} dlg.remove(); resolve(v); };
    dlg.append(h('form.ask-inner', { method: 'dialog' },
      h('p.ask-text', message),
      h('div.ask-row',
        h('button.btn.btn-ghost', { type: 'button', onclick: () => done(false) }, cancel),
        h(`button.btn.${danger ? 'btn-alarm' : 'btn-cyan'}`, { type: 'button', onclick: () => done(true) }, ok),
      ),
    ));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector('.btn-ghost')?.focus();
  });
}
