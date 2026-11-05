import {
  SystemClient, TransportHub, takeHashToken, buzz, h, toast, itemArt, fmtNum, timeAgo,
  rarityOf, statusText, registerSW, isHosted, ask,
} from './client.js';

const $ = (s, r = document) => r.querySelector(s);
// `client` is a hub: the Node boot attaches a WebSocket client, the hosted edition attaches its own transport.
const client = new TransportHub();
/** Hooks the hosted edition sets (lobby, prep cards, AI writer); all optional. */
export const ext = { afterRender: [], customAchievementWriter: null, hosted: false };

let view = null;
const openCards = new Set();
const shownPins = new Set();
const dirtyCards = new Set();

/* ---------- action helper: haptic + toast from ack ---------- */

async function act(action, okMsg) {
  buzz(10);
  try {
    await client.send(action);
    if (okMsg) toast(okMsg);
    return true;
  } catch (err) {
    toast(`${okMsg ? okMsg.replace(/\.$/, '') + ' failed: ' : ''}${err.message}`, { error: true, ms: 3500 });
    return false;
  }
}

/* ---------- connection status ---------- */

client.on('status', (s) => {
  const el = $('#conn');
  el.classList.toggle('ok', s.status === 'open');
  el.classList.toggle('bad', s.status === 'closed' || s.status === 'rejected' || (s.status === 'connecting' && s.attempt > 1));
  $('.conn-text', el).textContent = statusText(s);
  if (s.status === 'rejected') {
    $('#gate').hidden = false;
    $('#gate .sys-title').textContent = 'GM link refused.';
    $('#gate .sys-desc').textContent = 'The token in this link is not valid for the running host. Copy the GM link from the host terminal again.';
  }
});

client.on('view', (v) => { view = v; render(); });

client.on('event', (e) => {
  if (e.kind === 'secret') return;
  if (e.kind === 'viewers') return;
  if (e.kind === 'stat') return;
  const p = view?.players?.find((x) => x.id === e.playerId);
  if (e.kind === 'achievement') toast(`Achievement → ${p?.name || 'player'}: ${e.title}`);
  if (e.kind === 'loot') toast(`${p?.name || 'Player'} got ${e.item?.name || 'an item'} (${e.item?.rarity || '?'})`);
  if (e.kind === 'sponsor') toast(`${e.sponsor || 'Sponsor'} box → ${p?.name || 'player'}: ${e.item?.name || ''}`);
});

/* ---------- render ---------- */

function render() {
  if (!view) return;
  const s = view.session || {};
  const gm = view.gm || {};

  $('#room').textContent = view.room || '····';
  document.title = `GM ${view.room || ''} · The System`;

  const auto = $('#auto');
  auto.setAttribute('aria-checked', String(!!s.auto));
  $('.auto-state', auto).textContent = s.auto ? 'On' : 'Off';

  for (const b of document.querySelectorAll('#mode button')) {
    b.setAttribute('aria-checked', String(b.dataset.mode === s.mode));
  }
  $('#budget').textContent = s.budgetLeft ?? '–';

  renderVoices();
  renderQuips(gm.quipCategories || []);
  renderPending(gm.pendingAuto || []);
  renderPlayers();
  renderAudience();
  renderFeed();
  renderLinks();
  renderComms();
  renderPrep();
  const q = gm.queue || [];
  const bits = [];
  if (gm.playing) bits.push('speaking now');
  if (q.length) bits.push(`${q.length} queued`);
  if (!bits.length) bits.push(gm.aiAvailable ? `AI on, ${gm.aiCallsLeft ?? 0} calls left` : 'pack lines only');
  $('#queue-info').textContent = bits.join(', ');
  const sys = view.pack?.systemName;
  if (sys) $('.brand-name').textContent = sys;
  for (const fn of ext.afterRender) { try { fn(view); } catch (err) { console.error(err); } }
}

function renderVoices() {
  const sel = $('#voice');
  const voices = view.pack?.voices || [];
  sel.parentElement.hidden = voices.length === 0;
  const sig = voices.map((v) => v.id + v.label).join('|');
  if (sel.dataset.sig !== sig) {
    sel.replaceChildren(...voices.map((v) => h('option', { value: v.id }, v.label || v.id)));
    sel.dataset.sig = sig;
  }
  if (view.session?.voice && document.activeElement !== sel) sel.value = view.session.voice;
}

let quipSig = '';
function renderQuips(cats) {
  const sig = JSON.stringify(cats);
  if (sig === quipSig) return;
  quipSig = sig;
  const grid = $('#quips');
  if (!cats.length) {
    grid.replaceChildren(h('p.empty', 'The pack has no quip lines.'));
    return;
  }
  grid.replaceChildren(...cats.map((c, i) => h('button.quip', {
    type: 'button',
    'data-cat': c.id,
    class: c.left === 0 ? 'quip spent' : 'quip',
    disabled: c.total === 0,
    title: c.total === 0 ? `The pack has no ${c.label} lines` : `Play a ${c.label} line now${i < 9 ? ` (${i + 1})` : ''}`,
    onclick: (ev) => playQuip(c, ev.currentTarget),
  },
  i < 9 ? h('kbd', String(i + 1)) : null,
  h('span.ql', c.label || c.id),
  h('span.qm', h('span', c.total === 0 ? 'none in pack' : (c.total != null ? `of ${c.total} left` : 'left')), h('b', c.total === 0 ? '' : String(c.left ?? '∞'))),
  )));
}

function playQuip(c, el) {
  if (el) { el.classList.add('hit'); setTimeout(() => el.classList.remove('hit'), 150); }
  act({ t: 'quip.play', category: c.id }, `Playing ${c.label}.`);
}

/* pending auto lines with live countdown */
let pendingTimer = null;
function renderPending(list) {
  const wrap = $('#pending');
  const sig = list.map((p) => p.id).join(',');
  if (wrap.dataset.sig !== sig) {
    wrap.dataset.sig = sig;
    wrap.replaceChildren(...list.map((p) => h('div.sys.pend', { 'data-head': 'AUTO LINE INCOMING', 'data-id': p.id, 'data-at': p.playsAt || 0 },
      h('div',
        h('p.sys-desc', p.text),
        h('p.count.mono', ''),
      ),
      h('button.btn.btn-alarm.veto', { type: 'button', onclick: () => act({ t: 'auto.veto', id: p.id }, 'Vetoed.') }, 'Veto'),
      h('div.pend-bar'),
    )));
  }
  clearInterval(pendingTimer);
  if (list.length) {
    const tick = () => {
      for (const el of wrap.querySelectorAll('.pend')) {
        const at = Number(el.dataset.at) || 0;
        const left = Math.max(0, (at - Date.now()) / 1000);
        $('.count', el).textContent = left > 0 ? `plays in ${left.toFixed(1)} s` : 'playing at next pause';
        $('.pend-bar', el).style.width = `${Math.min(100, (left / 5) * 100)}%`;
      }
    };
    tick();
    pendingTimer = setInterval(tick, 100);
  }
}

/* ---------- players ---------- */

function fullPlayer(id) {
  return view.gm?.playersFull?.find((p) => p.id === id) || view.players?.find((p) => p.id === id) || { id };
}

function renderPlayers() {
  const wrap = $('#players');
  const list = view.players || [];
  $('#player-count').textContent = list.length ? `${list.filter((p) => p.connected).length}/${list.length} online` : '';
  if (!list.length) {
    wrap.replaceChildren(h('p.empty', 'No players yet. Add the first one below, then send them the join link and their PIN.'));
    return;
  }
  // remove cards for players that left
  for (const el of [...wrap.querySelectorAll('.pcard')]) {
    if (!list.some((p) => p.id === el.dataset.id)) el.remove();
  }
  wrap.querySelector('.empty')?.remove();
  list.forEach((summary, idx) => {
    const full = { ...fullPlayer(summary.id), connected: summary.connected, achievementCount: summary.achievementCount };
    const sig = JSON.stringify([full, view.gm?.pins?.[summary.id], openCards.has(summary.id), shownPins.has(summary.id), view.pack?.stats, view.pack?.resources]);
    let el = wrap.querySelector(`.pcard[data-id="${CSS.escape(summary.id)}"]`);
    if (el && el.dataset.sig === sig) { placeAt(wrap, el, idx); return; }
    if (el && el.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) {
      dirtyCards.add(summary.id); // re-render after the GM leaves the field
      return;
    }
    const fresh = playerCard(full);
    fresh.dataset.sig = sig;
    if (el) el.replaceWith(fresh); else wrap.append(fresh);
    placeAt(wrap, fresh, idx);
  });
}

function placeAt(parent, el, idx) {
  if (parent.children[idx] !== el) parent.insertBefore(el, parent.children[idx] || null);
}

document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (dirtyCards.size && !document.activeElement?.closest?.('.pcard')) {
      dirtyCards.clear();
      renderPlayers();
    }
  }, 0);
});

function playerCard(p) {
  const id = p.id;
  const pin = view.gm?.pins?.[id];
  const open = openCards.has(id);
  const subParts = [p.title, [p.race, p.klass].filter(Boolean).join(' '), `Lv ${p.level ?? 1}`].filter(Boolean);

  const card = h('article.pcard', { 'data-id': id, class: open ? 'pcard open' : 'pcard', style: { '--pc': p.color || 'var(--cyan)' } },
    h('div.pc-head',
      h('div.pc-name',
        h('span.dot', { class: p.connected ? 'dot on' : 'dot off', title: p.connected ? 'Connected' : 'Not connected' }),
        h('span.n', p.name || 'Unnamed'),
      ),
      h('button.pc-pin', {
        type: 'button',
        class: shownPins.has(id) ? 'pc-pin shown' : 'pc-pin',
        title: 'Tap to show or hide the PIN',
        onclick: () => { shownPins.has(id) ? shownPins.delete(id) : shownPins.add(id); buzz(10); renderPlayers(); },
      }, shownPins.has(id) ? (pin || '----') : 'PIN ••••'),
      h('div.pc-sub', subParts.join('  /  '), `  ·  ${p.achievementCount ?? p.achievements?.length ?? 0} ach  ·  ${fmtNum(p.gold ?? 0)} gold`),
    ),
    resourceBars(p),
    h('div.pc-actions',
      actionBtn('ach', '✦', 'Achieve', () => achievementSheet(p)),
      actionBtn('loot', '▣', 'Loot', () => lootSheet(p, false)),
      actionBtn('sponsor', '$', 'Sponsor', () => lootSheet(p, true)),
      actionBtn('secret', '✉', 'Message', () => openComms([p.id])),
    ),
    h('button.pc-more', {
      type: 'button',
      'aria-expanded': String(open),
      onclick: () => { open ? openCards.delete(id) : openCards.add(id); renderPlayers(); },
    }, open ? 'Hide sheet' : `Edit sheet · ${p.inventory?.length ?? 0} items`),
    open ? playerDetail(p) : null,
  );
  return card;
}

function actionBtn(act, glyph, label, fn) {
  return h('button', { type: 'button', 'data-act': act, onclick: () => { buzz(10); fn(); } },
    h('span.g', { 'aria-hidden': 'true' }, glyph), label);
}

function resourceBars(p) {
  const defs = view.pack?.resources || [];
  if (!defs.length) return null;
  return h('div.pc-res', defs.map((r) => {
    const v = p.resources?.[r.id] || { cur: 0, max: r.default ?? 0 };
    const pct = v.max > 0 ? Math.max(0, Math.min(100, (v.cur / v.max) * 100)) : 0;
    return h('div.res',
      h('span.res-label', { title: r.label }, (r.abbr || r.id).toUpperCase()),
      h('div.bar', { style: { '--c': r.color || 'var(--alarm)' }, role: 'meter', 'aria-label': r.label, 'aria-valuenow': v.cur, 'aria-valuemax': v.max, 'aria-valuemin': 0 },
        h('div.bar-fill', { style: { width: pct + '%' } }),
        h('span.bar-text', `${v.cur} / ${v.max}`),
      ),
      h('span.step',
        h('button', { type: 'button', 'aria-label': `${r.label} minus 1`, onclick: () => act({ t: 'player.resource', playerId: p.id, res: r.id, delta: -1 }) }, '−'),
        h('button', { type: 'button', 'aria-label': `${r.label} plus 1`, onclick: () => act({ t: 'player.resource', playerId: p.id, res: r.id, delta: 1 }) }, '+'),
      ),
    );
  }));
}

function stepper(value, onDelta, label) {
  return h('span.step',
    h('button', { type: 'button', 'aria-label': `${label} minus 1`, onclick: () => onDelta(-1) }, '−'),
    h('span.v', String(value ?? 0)),
    h('button', { type: 'button', 'aria-label': `${label} plus 1`, onclick: () => onDelta(1) }, '+'),
  );
}

function playerDetail(p) {
  const statDefs = view.pack?.stats || [];
  const resDefs = view.pack?.resources || [];
  const upd = (field, value) => act({ t: 'player.update', playerId: p.id, [field]: value }, 'Saved.');

  const fld = (label, field, attrs = {}) => h('label', { class: attrs.wide ? 'wide' : null },
    label,
    h('input.field', {
      value: p[field] ?? '',
      maxlength: 60,
      ...attrs,
      onchange: (e) => {
        let v = e.target.value;
        if (attrs.type === 'number') v = Number(v) || 0;
        upd(field, v);
      },
    }),
  );

  return h('div.pc-detail',
    statDefs.length ? h('div',
      h('h4', 'Stats'),
      h('div.stats-grid', statDefs.map((s) => h('div.stat-row',
        h('span.abbr', { title: s.label }, s.abbr || s.id),
        stepper(p.stats?.[s.id] ?? s.default ?? 0, (d) => act({ t: 'player.stat', playerId: p.id, stat: s.id, delta: d }), s.label),
      ))),
    ) : null,
    resDefs.length ? h('div',
      h('h4', 'Maximums'),
      h('div.stats-grid', resDefs.map((r) => {
        const v = p.resources?.[r.id] || { cur: 0, max: 0 };
        return h('div.stat-row',
          h('span.abbr', { title: r.label }, `${(r.abbr || r.id).toUpperCase()} max`),
          stepper(v.max, (d) => act({ t: 'player.resource', playerId: p.id, res: r.id, max: Math.max(0, (v.max || 0) + d) }), `${r.label} max`),
        );
      })),
    ) : null,
    h('div',
      h('h4', 'Identity'),
      h('div.ident-row',
        h('span', 'Level', stepper(p.level ?? 1, (d) => upd('level', Math.max(0, (p.level ?? 1) + d)), 'Level')),
        h('span', 'Gold', stepper(p.gold ?? 0, (d) => upd('gold', Math.max(0, (p.gold ?? 0) + d * 10)), 'Gold by 10')),
      ),
      h('div.ident', { style: { marginTop: '8px' } },
        fld('Name', 'name'),
        h('label', 'Color', h('input.field', { type: 'color', value: p.color || '#2ef2ff', onchange: (e) => upd('color', e.target.value) })),
        fld('Title', 'title', { wide: true }),
        fld('Class', 'klass'),
        fld('Race', 'race'),
        fld('Gold', 'gold', { type: 'number', min: 0, inputmode: 'numeric' }),
        fld('PIN', 'pin', { inputmode: 'numeric', pattern: '\\d{4}', maxlength: 4, value: view.gm?.pins?.[p.id] || '' }),
      ),
    ),
    h('div',
      h('h4', `Inventory (${p.inventory?.length ?? 0})`),
      p.inventory?.length
        ? h('ul.inv', p.inventory.map((it) => h('li', { class: `r-${rarityOf(it.rarity)}` },
          itemArt(it),
          h('span.nm', it.name, h('small', rarityOf(it.rarity))),
          h('button.rm', {
            type: 'button',
            title: `Remove ${it.name}`,
            'aria-label': `Remove ${it.name}`,
            onclick: async () => { if (await ask(`Remove ${it.name} from ${p.name}?`, { ok: 'Remove item', danger: true })) act({ t: 'item.remove', playerId: p.id, uid: it.uid }, 'Item removed.'); },
          }, '✕'),
        )))
        : h('p.empty', 'Empty. Open a loot box to fill it.'),
    ),
    p.notes ? h('div', h('h4', 'Player notes'), h('p.empty', { style: { whiteSpace: 'pre-wrap' } }, p.notes)) : null,
    h('div.pc-danger',
      h('button.linkish', {
        type: 'button',
        onclick: async () => { if (await ask(`Remove ${p.name} from the game? Their inventory goes too.`, { ok: 'Remove player', danger: true })) act({ t: 'player.remove', playerId: p.id }, 'Player removed.'); },
      }, 'Remove player'),
    ),
  );
}

/* ---------- sheets ---------- */

const sheet = $('#sheet');
function openSheet(title, body, accent) {
  $('#sheet-title').textContent = title;
  $('#sheet-body').replaceChildren(...[body].flat());
  sheet.style.borderColor = accent || '';
  sheet.style.boxShadow = accent ? `0 0 60px -10px ${accent}` : '';
  if (!sheet.open) sheet.showModal();
}
const closeSheet = () => sheet.open && sheet.close();

function achievementSheet(p) {
  const cat = view.gm?.achievementsCatalog || [];
  const list = h('div.cat-list');
  const search = h('input.field', { type: 'search', placeholder: `Search ${cat.length} achievements`, autocomplete: 'off' });
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const hits = cat
      .filter((a) => !q || `${a.title} ${a.desc || ''} ${a.group || ''}`.toLowerCase().includes(q))
      .sort((x, y) => (x.group || '').localeCompare(y.group || ''));
    const out = [];
    let lastGroup = null;
    for (const a of hits.slice(0, 80)) {
      if ((a.group || '') !== lastGroup) {
        lastGroup = a.group || '';
        if (lastGroup) out.push(h('div.divider', lastGroup));
      }
      out.push(a);
    }
    list.replaceChildren(...(hits.length ? out.map((a) => a instanceof Node ? a : h('button.cat-item', {
      type: 'button',
      onclick: async () => { if (await act({ t: 'ach.award', playerId: p.id, achId: a.id }, `Awarded ${a.title}.`)) closeSheet(); },
    }, h('b', a.title), h('span', a.desc), a.reward ? h('span.rw', `Reward: ${a.reward}`) : null)) : [h('p.empty', 'Nothing matches. Write a custom one below.')]));
  };
  search.addEventListener('input', draw);
  draw();

  const title = h('input.field', { placeholder: 'Custom title', maxlength: 80 });
  const desc = h('textarea.field', { placeholder: 'Description, in the System voice. A few sentences is fine.', maxlength: 1200, rows: 4 });
  const reward = h('input.field.reward-in', { placeholder: 'Reward (optional), e.g. a Bronze Box', maxlength: 160 });
  const award = h('button.btn.btn-cyan', {
    type: 'button',
    onclick: async () => {
      if (!title.value.trim()) { title.focus(); return; }
      const a = { t: 'ach.award', playerId: p.id, title: title.value.trim(), desc: desc.value.trim() };
      if (reward.value.trim()) a.reward = reward.value.trim();
      if (await act(a, 'Custom achievement awarded.')) closeSheet();
    },
  }, 'Award custom');

  let writer = null;
  if (ext.customAchievementWriter) {
    const brief = h('input.field', { placeholder: 'What happened, in a few words', maxlength: 300 });
    const status = h('p.ai-status.mono', { 'aria-live': 'polite' });
    const go = h('button.btn.btn-hot', {
      type: 'button',
      onclick: async () => {
        const what = brief.value.trim() || title.value.trim();
        if (!what) { brief.focus(); return; }
        go.disabled = true;
        status.textContent = 'Writing. This can take a few seconds.';
        try {
          const r = await ext.customAchievementWriter({ player: fullPlayer(p.id), brief: what, view });
          if (r) {
            title.value = r.title || title.value;
            desc.value = r.desc || '';
            reward.value = r.reward || '';
            status.textContent = 'Draft ready. Edit it, then award.';
          }
        } catch (err) {
          status.textContent = err?.userMessage || 'Could not write it. Type it yourself.';
          if (err?.hide) writer.hidden = true;
        } finally {
          go.disabled = false;
        }
      },
    }, 'Write it for me');
    writer = h('div.ai-writer', h('div.say-row', brief, go), status);
  }
  openSheet(`Achievement for ${p.name}`, [search, list, h('div.divider', 'or write one'), h('div.stack', writer, title, desc, reward, award)], 'var(--cyan)');
  setTimeout(() => search.focus(), 30);
}

function lootSheet(p, sponsor) {
  const tiers = view.pack?.lootTiers || [];
  const sponsorName = sponsor ? h('input.field', { placeholder: 'Sponsor name (optional)', maxlength: 40 }) : null;
  const grid = h('div.tier-grid', tiers.map((t) => h('button.tier', {
    type: 'button',
    style: { '--t': t.color || 'var(--acid)' },
    onclick: async () => {
      const a = sponsor
        ? { t: 'sponsor.box', playerId: p.id, tier: t.id, ...(sponsorName.value.trim() ? { sponsor: sponsorName.value.trim() } : {}) }
        : { t: 'loot.open', playerId: p.id, tier: t.id };
      if (await act(a, sponsor ? 'Sponsor box sent.' : `${t.name} opened.`)) closeSheet();
    },
  }, t.name || t.id)));
  const body = tiers.length ? [sponsorName, grid].filter(Boolean) : [h('p.empty', 'The pack defines no loot tiers.')];
  const catalog = view.gm?.itemsCatalog || [];
  if (!sponsor && catalog.length) {
    const sel = h('select.field', catalog.map((it) => h('option', { value: it.id }, `${it.name} (${rarityOf(it.rarity)})`)));
    body.push(
      h('div.divider', 'or give a specific item, no animation'),
      h('div.say-row', sel, h('button.btn.btn-ghost', {
        type: 'button',
        onclick: async () => {
          const it = catalog.find((x) => x.id === sel.value);
          if (await act({ t: 'item.give', playerId: p.id, itemId: sel.value }, `Gave ${it?.name || 'item'}.`)) closeSheet();
        },
      }, 'Give')),
    );
  }
  openSheet(sponsor ? `Sponsor box for ${p.name}` : `Loot box for ${p.name}`, body, sponsor ? 'var(--magenta)' : 'var(--acid)');
}

/* ---------- prepared cards (prep.card.*) ---------- */

const PREP_GLYPH = { achievement: '✦', loot: '▣', message: '✉', line: '❝' };
function cardNeedsPlayer(c) {
  return (c.kind === 'achievement' || c.kind === 'loot') && !c.payload?.playerId;
}
function cardDetail(c) {
  const p = c.payload || {};
  const who = p.playerId ? (view.players?.find((x) => x.id === p.playerId)?.name || 'someone') : null;
  if (c.kind === 'achievement') return [p.title || p.achId, who && `for ${who}`].filter(Boolean).join(' ');
  if (c.kind === 'loot') return [(view.pack?.lootTiers?.find((t) => t.id === p.tier)?.name || p.tier), who && `for ${who}`].filter(Boolean).join(' ');
  if (c.kind === 'message') return p.to === 'all' ? `To all: ${p.text}` : `${p.text}`;
  return p.text || '';
}
let prepSig = '';
function renderPrep() {
  const cards = view.gm?.prepCards || [];
  const wrap = $('#prep');
  wrap.hidden = !cards.length;
  const sig = JSON.stringify([cards, view.players?.map((p) => [p.id, p.name])]);
  if (sig === prepSig) return;
  prepSig = sig;
  const open = cards.filter((c) => !c.used).length;
  $('#prep-count').textContent = `${open} ready${cards.length > open ? `, ${cards.length - open} used` : ''}`;
  $('#prep-cards').replaceChildren(...[...cards].sort((a, b) => Number(a.used) - Number(b.used)).map((c) => h('div.pcardx', { class: `pcardx k-${c.kind}${c.used ? ' used' : ''}` },
    h('button.pc-fire', {
      type: 'button',
      title: c.used ? 'Already used. Tap to fire again.' : 'Fire this card',
      onclick: () => fireCard(c),
    },
    h('span.g', { 'aria-hidden': 'true' }, PREP_GLYPH[c.kind] || '•'),
    h('span.pl', c.label || c.kind),
    h('span.pd', cardDetail(c)),
    ),
    h('button.pc-x', {
      type: 'button',
      'aria-label': `Delete card ${c.label}`,
      onclick: async () => { if (await ask(`Delete the card "${c.label}"?`, { ok: 'Delete', danger: true })) act({ t: 'prep.card.remove', id: c.id }, 'Card deleted.'); },
    }, '✕'),
  )));
}
function fireCard(c) {
  if (!cardNeedsPlayer(c)) { act({ t: 'prep.card.fire', id: c.id }, `Fired: ${c.label}.`); return; }
  const players = view.players || [];
  openSheet(`Who gets "${c.label}"?`, h('div.tier-grid', players.map((p) => h('button.tier', {
    type: 'button',
    style: { '--t': p.color || 'var(--cyan)' },
    onclick: async () => { if (await act({ t: 'prep.card.fire', id: c.id, playerId: p.id }, `Fired: ${c.label} for ${p.name}.`)) closeSheet(); },
  }, p.name))), 'var(--acid)');
}

/* ---------- comms ---------- */

const selected = new Set(['all']);
const commsText = $('#comms-text');
const commsFrom = $('#comms-from');
const commsTv = $('#comms-tv');

function systemName() { return view?.pack?.systemName || 'The System'; }

function openComms(ids) {
  if (ids) {
    selected.clear();
    ids.forEach((id) => selected.add(id));
    renderChips();
  }
  const c = $('#comms');
  const col = c.closest('.col');
  if (col && getComputedStyle(col).overflowY === 'auto') {
    col.scrollTo({ top: c.offsetTop - col.offsetTop - 12, behavior: 'smooth' });
  } else {
    c.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash');
  setTimeout(() => commsText.focus({ preventScroll: true }), 250);
}

let chipSig = '';
function renderChips() {
  const ps = view?.players || [];
  for (const id of [...selected]) if (id !== 'all' && !ps.some((p) => p.id === id)) selected.delete(id);
  if (!selected.size) selected.add('all');
  const sig = JSON.stringify([ps.map((p) => [p.id, p.name, p.color]), [...selected]]);
  if (sig === chipSig) return;
  chipSig = sig;
  const chip = (id, label, color, cls = '') => h('button.chip', {
    type: 'button',
    class: `chip${cls}`,
    'aria-pressed': String(selected.has(id)),
    style: color ? { '--cc': color } : null,
    onclick: () => {
      buzz(8);
      if (id === 'all') { selected.clear(); selected.add('all'); }
      else {
        selected.delete('all');
        selected.has(id) ? selected.delete(id) : selected.add(id);
        if (!selected.size) selected.add('all');
      }
      renderChips();
    },
  }, label);
  $('#chips').replaceChildren(
    chip('all', 'All crawlers', null, ' all'),
    ...ps.map((p) => chip(p.id, p.name, p.color)),
  );
  // Server: a message to all, or to more than one player, is a group message; only those can go on the TV.
  const group = selected.has('all') || selected.size > 1;
  commsTv.disabled = !group;
  if (!group) commsTv.checked = false;
  $('#tv-wrap').classList.toggle('off', !group);
  $('#comms-send').textContent = selected.has('all') ? 'Send to all' : selected.size === 1 ? 'Send private' : `Send to ${selected.size}`;
}

function renderComms() {
  renderChips();
  if (!commsFrom.value && document.activeElement !== commsFrom) commsFrom.placeholder = `From: ${systemName()}`;
  const list = [...(view.gm?.messages || [])].reverse().slice(0, 40);
  const hist = $('#msg-history');
  const sig = JSON.stringify(list);
  if (hist.dataset.sig === sig) return;
  hist.dataset.sig = sig;
  const nameOf = (id) => view.players?.find((p) => p.id === id)?.name || 'someone';
  hist.replaceChildren(...(list.length ? list.map((m) => {
    const to = m.to;
    const group = m.group ?? (to === 'all' || (Array.isArray(to) && to.length > 1));
    const ids = Array.isArray(to) ? to : (typeof to === 'string' && to !== 'all' ? [to] : (m.playerId ? [m.playerId] : []));
    const readBy = Array.isArray(m.readBy) ? m.readBy.length : null;
    return h('li', { class: group ? 'grp' : 'prv' },
      h('div.mh',
        h('span.to', to === 'all' ? 'To all crawlers' : `To ${ids.map(nameOf).join(', ')}`),
        h('span', `from ${m.from || systemName()}`),
        m.onStage ? h('span.tvflag', 'on TV') : null,
        h('span', timeAgo(m.at)),
        readBy != null ? h('span.rd', `read ${readBy}/${to === 'all' ? (view.players?.length ?? 0) : ids.length}`) : null,
      ),
      h('div.tx', m.text),
    );
  }) : [h('li', h('div.tx.dim', 'No messages yet. Pick who gets it above.'))]));
}

$('#comms-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = commsText.value.trim();
  if (!text) { commsText.focus(); return; }
  const all = selected.has('all');
  const a = { t: 'msg.send', to: all ? 'all' : [...selected], text };
  if (commsFrom.value.trim()) a.from = commsFrom.value.trim();
  if (!commsTv.disabled && commsTv.checked) a.onStage = true;
  const who = all ? 'everyone' : [...selected].map((id) => view.players?.find((p) => p.id === id)?.name).join(', ');
  if (await act(a, `Sent to ${who}.`)) {
    commsText.value = '';
    commsTv.checked = false;
  }
});
commsText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#comms-form').requestSubmit(); }
});

/* ---------- audience / feed / links ---------- */

let shownViewers = 0;
let viewersRaf = 0;
function renderAudience() {
  const a = view.audience || {};
  const target = Number(a.viewers) || 0;
  cancelAnimationFrame(viewersRaf);
  const from = shownViewers;
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 700);
    shownViewers = Math.round(from + (target - from) * (1 - (1 - k) ** 3));
    $('#viewers').textContent = fmtNum(shownViewers);
    if (k < 1) viewersRaf = requestAnimationFrame(step);
  };
  viewersRaf = requestAnimationFrame(step);
  const hype = Math.max(0, Math.min(1, Number(a.hype) || 0));
  $('#hype').style.width = `${hype * 100}%`;
  $('#hype-label').textContent = `hype ${Math.round(hype * 100)}%`;
  $('#sponsor-ready').hidden = !(view.gm?.sponsorReady || a.sponsorReady);
}

const KIND_GLYPH = { achievement: '✦', loot: '▣', sponsor: '$', secret: '✉', stat: '±', level: '▲' };
function renderFeed() {
  const feed = [...(view.feed || [])].reverse().slice(0, 30);
  $('#feed').replaceChildren(...(feed.length ? feed.map((e) => h('li',
    h('span.k', { class: `k k-${e.kind}`, 'aria-hidden': 'true' }, KIND_GLYPH[e.kind] || '•'),
    h('div', e.text || e.kind, h('time', timeAgo(e.at))),
  )) : [h('li', h('span.k', '·'), h('div.dim', 'Nothing has happened yet. Award something.'))]));
}

function renderLinks() {
  const gm = view.gm || {};
  if (gm.joinUrl) {
    const a = $('#join-url');
    if (a.href !== gm.joinUrl) {
      a.href = gm.joinUrl;
      a.textContent = gm.joinUrl;
      $('#qr').src = `/qr?text=${encodeURIComponent(gm.joinUrl)}`;
    }
  }
  if (gm.stageUrl) $('#stage-url').href = gm.stageUrl;
}

/* ---------- top bar + forms ---------- */

function toggleAuto() {
  const on = !view?.session?.auto;
  act({ t: 'session.auto', on }, on ? 'AUTO is on.' : 'AUTO is off.');
}
function stopAll() {
  buzz([20, 30, 20]);
  act({ t: 'queue.clear' }, 'Stopped. Queue cleared.');
}

$('#auto').addEventListener('click', toggleAuto);
$('#stop').addEventListener('click', stopAll);
$('#mode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (b) act({ t: 'session.mode', mode: b.dataset.mode }, `Mode: ${b.textContent}.`);
});
$('#voice').addEventListener('change', (e) => {
  act({ t: 'session.voice', voice: e.target.value }, `Voice: ${e.target.selectedOptions[0]?.textContent}.`);
});
document.querySelectorAll('[data-budget]').forEach((b) => b.addEventListener('click', () => {
  const v = Math.max(0, (view?.session?.budgetLeft ?? 0) + Number(b.dataset.budget));
  act({ t: 'session.budget', value: v }, `Auto budget: ${v}.`);
}));
document.querySelectorAll('[data-bump]').forEach((b) => b.addEventListener('click', () => {
  act({ t: 'audience.bump', delta: Number(b.dataset.bump) });
}));

$('#add-player').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const a = { t: 'player.add', name: f.name.value.trim(), color: f.color.value };
  if (!a.name) return;
  if (f.pin.value.trim()) a.pin = f.pin.value.trim();
  buzz(10);
  let res;
  try { res = await client.send(a); } catch (err) { toast(`Add player failed: ${err.message}`, { error: true, ms: 3500 }); return; }
  {
    const pin = res?.result?.pin;
    toast(pin ? `Added ${a.name}. PIN ${pin}.` : `Added ${a.name}.`, { ms: 5000 });
    if (res?.result?.playerId) shownPins.add(res.result.playerId);
    f.name.value = '';
    f.pin.value = '';
    f.color.value = randomNeon();
  }
});
const NEONS = ['#2ef2ff', '#ff2fb9', '#e4ff2e', '#ff8a1c', '#3ddc5f', '#b44dff', '#3b8cff', '#ff2448'];
const randomNeon = () => NEONS[Math.floor(Math.random() * NEONS.length)];

const sayText = $('#say-text');
$('#say').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = sayText.value.trim();
  if (!text) return;
  if (await act({ t: 'say', text }, 'Saying it now.')) sayText.value = '';
});
sayText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#say').requestSubmit(); }
});

$('#copy-stage').addEventListener('click', async () => {
  const url = view?.gm?.stageUrl;
  if (!url) return;
  try { await navigator.clipboard.writeText(url); toast('Stage link copied.'); } catch { toast(url, { ms: 8000 }); }
});

$('#new-session').addEventListener('click', async () => {
  if (await ask('Start a new session? The current one is archived. Players and inventories stay.', { ok: 'Start new session' })) {
    act({ t: 'session.new' }, 'New session started.');
  }
});

/* ---------- keyboard ---------- */

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (sheet.open) return; // dialog closes itself first
    e.preventDefault();
    stopAll();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t.closest?.('input, textarea, select, [contenteditable]') || sheet.open) return;
  if (e.key === 'a' || e.key === 'A') { e.preventDefault(); toggleAuto(); return; }
  if (e.key === 'm' || e.key === 'M') { e.preventDefault(); openComms(); return; }
  if (/^[1-9]$/.test(e.key)) {
    const cats = view?.gm?.quipCategories || [];
    const c = cats[Number(e.key) - 1];
    if (c && c.total !== 0) {
      e.preventDefault();
      playQuip(c, document.querySelectorAll('#quips .quip')[Number(e.key) - 1]);
    }
  }
});

/* ---------- boot ---------- */

/** Attach a transport and start. Used by both editions. */
export function mountGm(transport, opts = {}) {
  ext.hosted = !!opts.hosted;
  document.body.classList.toggle('hosted', ext.hosted);
  client.attach(transport);
  transport.connect?.();
  return { client, render: () => render(), view: () => view };
}

if (!isHosted()) {
  const token = takeHashToken('system.gmToken');
  if (!token) {
    $('#gate').hidden = false;
  } else {
    mountGm(new SystemClient({ hello: () => ({ role: 'gm', token }) }));
  }
  registerSW();
}
