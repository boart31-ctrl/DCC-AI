// Small helpers shared by the hosted-edition modules.
import { Emitter } from '../client.js';

/** Emitter + the transport surface page UIs expect (see TransportHub in client.js). */
export class BaseTransport extends Emitter {
  constructor() {
    super();
    this.status = 'idle';
  }
  setStatus(status, extra = {}) {
    this.status = status;
    this.emit('status', { status, attempt: 0, ...extra });
  }
  connect() {}
  retry() {}
  close() {}
  raw() { return false; }
  send() { return Promise.reject(new Error('Not available here')); }
}

/**
 * One db document written from in-memory state: debounced, one write in flight,
 * skipped when the JSON did not change. `get()` returns the body to write, or null to skip.
 */
export class DocWriter {
  constructor(ref, get, { delay = 250, onError } = {}) {
    this.ref = ref;
    this.get = get;
    this.delay = delay;
    this.onError = onError || (() => {});
    this.timer = null;
    this.inFlight = null;
    this.again = false;
    this.last = null;
  }
  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.delay);
  }
  async flush() {
    if (this.inFlight) { this.again = true; return this.inFlight; }
    const body = this.get();
    if (!body) return;
    const json = JSON.stringify(body);
    if (json === this.last) return;
    this.inFlight = (async () => {
      try {
        await this.ref.set(body);
        this.last = json;
      } catch (e) {
        if (e?.code === 'unavailable') {
          await sleep(400 + Math.random() * 600);
          try { await this.ref.set(body); this.last = json; } catch (e2) { this.onError(e2); }
        } else {
          this.onError(e);
        }
      } finally {
        this.inFlight = null;
        if (this.again) { this.again = false; this.schedule(); }
      }
    })();
    return this.inFlight;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Keeps the last `n` items, newest last. */
export function ring(list, item, n) {
  list.push(item);
  if (list.length > n) list.splice(0, list.length - n);
  return list;
}

export function bytes(obj) {
  try { return new TextEncoder().encode(JSON.stringify(obj)).length; } catch { return Infinity; }
}

/** Splits text into chunks of whole sentences, each at most `max` characters. */
export function sentenceChunks(text, max = 170) {
  const parts = String(text || '').replace(/\s+/g, ' ').trim().match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [];
  const out = [];
  let cur = '';
  for (const p0 of parts) {
    let p = p0.trim();
    while (p.length > max) {
      const cut = p.lastIndexOf(' ', max) > 40 ? p.lastIndexOf(' ', max) : max;
      if (cur) { out.push(cur); cur = ''; }
      out.push(p.slice(0, cut).trim());
      p = p.slice(cut).trim();
    }
    if (!p) continue;
    if ((cur + ' ' + p).trim().length > max) { if (cur) out.push(cur); cur = p; }
    else cur = (cur + ' ' + p).trim();
  }
  if (cur) out.push(cur);
  return out;
}

/** Friendly copy for sample errors; `hide` = the AI feature should disappear for this view. */
export function sampleProblem(e) {
  const code = e?.code || 'upstream_error';
  if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(code)) {
    return { hide: true, userMessage: 'Claude is not available on this page.' };
  }
  if (code === 'rate_limited') return { hide: false, userMessage: 'Claude is busy or your usage limit is reached. Try again in a minute.' };
  if (code === 'cancelled') return { hide: false, userMessage: 'Stopped.' };
  if (code === 'refused') return { hide: false, userMessage: 'Claude declined that one. Rephrase it.' };
  if (code === 'invalid_json') return { hide: false, userMessage: 'The answer came back in the wrong shape. Try again.' };
  if (code === 'session_expired') return { hide: false, userMessage: 'Sign in to claude.ai again.' };
  if (code === 'prompt_too_large') return { hide: false, userMessage: 'Too much context. Shorten the story so far.' };
  return { hide: false, userMessage: 'Claude could not answer. Try again.' };
}

export function tabId() {
  try {
    let id = sessionStorage.getItem('system.tab');
    if (!id) { id = 't' + Math.random().toString(36).slice(2, 10); sessionStorage.setItem('system.tab', id); }
    return id;
  } catch {
    return 't' + Math.random().toString(36).slice(2, 10);
  }
}
