// Stage login (Node + Cloudflare editions). Tries, in order:
//   1. #token in the URL (Node stage link)          hello { role:'stage', token }
//   2. a TV token this screen got when it was paired hello { role:'stage', tvToken }
//   3. the GM key, if this is the GM's own browser   hello { role:'stage', key }
//   4. pairing: the server shows a 4-letter code here, the GM types it on the desk (tv.pair)
import { store, h } from './client.js';

const TV_KEY = 'system.tvToken';
const GM_KEY = 'system.gmKey';

function ensureStyles() {
  if (document.querySelector('link[data-access-css]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = '/css/access.css';
  l.dataset.accessCss = '';
  document.head.append(l);
}

export function bootStage({ mountStage, SystemClient, takeHashToken }) {
  ensureStyles();
  const legacy = takeHashToken('system.stageToken');
  let tvToken = store.get('localStorage', TV_KEY) || '';
  let gmKey = store.get('localStorage', GM_KEY) || '';
  let usedKey = false;

  const overlay = h('div.pair', { hidden: true, role: 'dialog', 'aria-live': 'polite' },
    h('div.pair-box',
      h('p.pair-kicker.mono', 'Pair this screen'),
      h('p.pair-code.mono', { 'aria-label': 'Pairing code' }, '····'),
      h('p.pair-how', 'On the GM desk open ', h('b', 'Settings → Players & devices'), ' and type this code.'),
      h('p.pair-exp.mono'),
    ),
  );
  document.body.append(overlay);
  let expTimer = null;
  const showCode = (code, expiresAt) => {
    overlay.hidden = false;
    overlay.querySelector('.pair-code').textContent = code;
    clearInterval(expTimer);
    const tick = () => {
      const s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      overlay.querySelector('.pair-exp').textContent = s > 0 ? `New code in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'Getting a new code';
    };
    tick();
    expTimer = setInterval(tick, 1000);
  };
  const hideCode = () => {
    overlay.hidden = true;
    clearInterval(expTimer);
  };

  const hello = () => {
    usedKey = false;
    if (legacy) return { role: 'stage', token: legacy };
    if (tvToken) return { role: 'stage', tvToken };
    if (gmKey) {
      usedKey = true;
      return { role: 'stage', key: gmKey };
    }
    return { role: 'stage', pair: true };
  };
  const transport = new SystemClient({ hello });
  transport.on('message', (m) => {
    if (m.t === 'pairing') showCode(m.code, m.expiresAt);
    else if (m.t === 'paired') {
      tvToken = m.tvToken;
      store.set('localStorage', TV_KEY, tvToken);
      hideCode();
    }
  });
  transport.on('status', (s) => {
    if (s.status === 'open') hideCode();
    // A revoked TV token or a changed GM key: forget it and fall back to pairing.
    if (s.status === 'rejected' && !legacy && (tvToken || usedKey) && s.code !== 'rate_limited') {
      if (usedKey) gmKey = '';
      else {
        tvToken = '';
        store.del('localStorage', TV_KEY);
      }
      setTimeout(() => transport.retry(), 400);
    }
  });
  mountStage(transport);
  return transport;
}
