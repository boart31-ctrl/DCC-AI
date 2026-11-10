// GM desk login with the GM key: asked once, kept in this browser's localStorage, sent as
// hello { role: 'gm', key }. A refused key is forgotten and asked for again.
import { store } from './client.js';

const KEY = 'system.gmKey';
const $ = (s) => document.querySelector(s);

export function bootKeyLogin({ ext, mountGm, SystemClient }) {
  const gate = $('#gate');
  const form = $('#gate-key');
  const input = $('#gate-key-input');
  const err = $('#gate-err');
  let transport = null;

  const start = (key) => {
    ext.credential = { key };
    if (!transport) {
      transport = new SystemClient({ hello: () => ({ role: 'gm', key: ext.credential.key }) });
      transport.on('welcome', () => {
        store.set('localStorage', KEY, ext.credential.key);
        gate.hidden = true;
      });
      mountGm(transport);
    } else {
      transport.retry();
    }
  };

  const askKey = (msg = '') => {
    gate.hidden = false;
    $('#gate .gate-title').textContent = 'Open the GM desk';
    $('#gate .gate-desc').textContent = 'Type the GM key. This browser remembers it, so you only do this once per device.';
    form.hidden = false;
    err.textContent = msg;
    setTimeout(() => input.focus(), 30);
  };

  ext.onKeyRejected = (s) => {
    store.del('localStorage', KEY);
    askKey(
      s.code === 'rate_limited' ? 'Too many wrong keys. Wait a minute, then try again.'
        : /GM_KEY/.test(s.msg || '') ? 'The server has no GM key yet. Set the GM_KEY secret first (see DEPLOY.md).'
          : 'That key is not right.',
    );
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const k = input.value.trim();
    if (!k) return;
    input.value = '';
    err.textContent = '';
    start(k);
  });

  const saved = store.get('localStorage', KEY);
  if (saved) start(saved);
  else askKey();
}
