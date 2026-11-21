import { h, toast } from './client.js';
import { closeDrawer, field, icon, openDrawer, select } from './ui.js';
import { libraryOf } from './rules.js';
import { CHECK_DC_TYPES, checkDC, checkDCPresets, checkFamily } from './check-dc.js';

const DEGREES = { crit: 'Critical success', amazing: 'Amazing success', success: 'Success', near: 'Near miss', fail: 'Failure', major: 'Major failure', critfail: 'Critical failure' };
const checkId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function openEveningCheck({ view, act, doc, scene, check }) {
  const players = view.players ?? [];
  const selected = new Set();
  const requestId = checkId();
  const send = h('button.btn.btn-primary', { type: 'button', disabled: true, onclick: async () => {
    send.disabled = true;
    const r = await act({ t: 'prep.check.send', docId: doc.id, sceneId: scene.id, checkId: check.id,
      playerIds: [...selected], requestId }, 'Check sent to the selected players.');
    if (r) closeDrawer();
    else send.disabled = !selected.size;
  } }, 'Send check');
  openDrawer({ title: 'Send check', sub: check.label,
    body: players.length ? h('div.prep-check-targets', players.map((p) => h('label', h('input', { type: 'checkbox', onchange: (e) => {
      if (e.currentTarget.checked) selected.add(p.id); else selected.delete(p.id);
      send.disabled = !selected.size;
    } }), p.name))) : h('p.empty-s', 'Add a crawler before sending a check.'),
    actions: [h('button.btn.btn-quiet', { type: 'button', onclick: () => closeDrawer() }, 'Cancel'), send],
  });
}

export function privateChecks({ view, act, doc, scene, patch }) {
  const ruleset = view.pack?.ruleset;
  const stats = ruleset?.stats ?? [];
  const skills = libraryOf(view).skill.filter((s) => s.checkType?.toLowerCase() !== 'passive');
  const isCrawler = checkFamily(ruleset) === 'crawler';
  const dcTypes = (isCrawler ? CHECK_DC_TYPES : [['fixed', 'Fixed']]).map(([value, label]) => ({ value, label }));
  const abilities = [
    { value: '', label: 'Choose a skill or stat' },
    { label: 'Skills', options: skills.map((s) => ({ value: `skill:${s.id}`, label: s.name })) },
    { label: 'Stats', options: stats.map((s) => ({ value: `stat:${s.id}`, label: s.label })) },
  ];
  const checks = scene.checks ?? [];
  const sent = (view.gm?.prepChecks ?? []).filter((q) => q.docId === doc.id && q.sceneId === scene.id);
  const players = new Map((view.players ?? []).map((p) => [p.id, p.name]));
  const update = (id, change) => patch({ checks: checks.map((row) => row.id === id ? { ...row, ...change } : row) });
  const add = () => patch({ checks: [...checks, { id: checkId(), label: 'Check', dcType: isCrawler ? 'stat' : 'fixed', dc: 15, mod: 0, near: '', fail: '', success: '' }] });
  const numeric = (value, label, min, max, commit) => field(value, { cls: 'inp-sm', attrs: { type: 'number', min, max, 'aria-label': label }, onCommit: (value) => {
    const n = Number(value);
    if (value.trim() && Number.isInteger(n) && n >= min && n <= max) commit(n);
    else toast(`Enter a whole number from ${min} to ${max}.`, { error: true });
  } });

  function resultRow(q, recipient) {
    const r = recipient.result;
    const note = r ? (r.degree === 'near' ? q.check.near : ['crit', 'amazing', 'success'].includes(r.degree) ? q.check.success : q.check.fail) : null;
    return h('li.prep-check-result', { 'data-player-id': recipient.playerId },
      h('b', players.get(recipient.playerId) ?? 'Crawler'),
      r ? h('span.prep-check-degree', DEGREES[r.degree] ?? r.degree) : h('span.dim', q.closed ? 'Closed' : 'Waiting'),
      r ? h('span.dim', `d20 ${r.die} ${(recipient.modifier ?? r.total - r.die) < 0 ? '−' : '+'} ${Math.abs(recipient.modifier ?? r.total - r.die)} = ${r.total} vs DC ${q.dc}`) : null,
      note ? h('span.prep-check-outcome', note) : null);
  }

  function row(check) {
    const dc = checkDC(check, ruleset, { floor: view.crawlers?.floor ?? 1 });
    const value = check.skillId ? `skill:${check.skillId}` : check.statId ? `stat:${check.statId}` : '';
    const valid = !!(check.skillId && skills.some((s) => s.id === check.skillId) || check.statId && stats.some((s) => s.id === check.statId));
    const change = (partial) => update(check.id, partial);
    const sendable = dc != null && valid && players.size > 0 && !!check.label.trim();
    const byCheck = sent.filter((q) => q.checkId === check.id).slice(-3).reverse();
    return h('article.prep-check', { 'data-check-id': check.id },
      h('div.prep-check-fields',
        field(check.label, { cls: 'inp-sm', attrs: { 'aria-label': 'Check name', maxlength: 80 }, placeholder: 'What to check', onCommit: (label) => change({ label }) }),
        select(abilities, value, { cls: 'inp-sm', label: 'Skill or stat', onChange: (v) => {
          const [kind, id] = v.split(':');
          const skill = skills.find((s) => s.id === id);
          const type = kind === 'stat' || !kind ? 'stat' : skill?.checkType === 'Opposed' ? 'opposed' : 'unopposed';
          change({ skillId: kind === 'skill' ? id : null, statId: kind === 'stat' ? id : null,
            dcType: !isCrawler || check.dcType === 'fixed' ? 'fixed' : type });
        } }),
        isCrawler ? select(dcTypes, check.dcType, { cls: 'inp-sm', label: 'DC type', onChange: (dcType) => change({ dcType }) }) : null,
        (check.dcType === 'fixed' || !isCrawler) ? numeric(check.dc, 'Fixed DC', 0, 999, (dc) => change({ dc })) : null,
        isCrawler && check.dcType === 'opposed' ? numeric(check.mod, 'Opponent modifier', -99, 99, (mod) => change({ mod })) : null,
        !isCrawler ? select([{ value: '', label: 'DC table' }, ...checkDCPresets(ruleset).map(({ dc, label }) => ({ value: String(dc), label: `${label} · DC ${dc}` }))], '',
          { cls: 'inp-sm', label: 'DC table', onChange: (v) => { if (v) change({ dc: Number(v), dcType: 'fixed' }); } }) : null,
        h('b.prep-check-dc', dc == null ? 'Set DC' : `DC ${dc}`),
        h('button.btn.btn-sm', { type: 'button', disabled: !sendable, onclick: () => openEveningCheck({ view, act, doc, scene, check }) }, 'Send to players'),
        h('button.icon-btn', { type: 'button', 'aria-label': `Remove ${check.label}`, onclick: () => patch({ checks: checks.filter((x) => x.id !== check.id) }) }, icon('trash', { size: 14 }))),
      h('details.prep-check-notes', h('summary', 'Check outcomes'),
        [['near', 'Near miss'], ['fail', 'Failure'], ['success', 'Success']].map(([key, name]) => h('label', h('span.dim', name),
          field(check[key], { cls: 'inp-sm', attrs: { maxlength: 240 }, onCommit: (text) => change({ [key]: text }) })))),
      byCheck.map((q) => h('div.prep-check-results', { 'aria-label': 'Check results' },
        h('ul', q.recipients.map((r) => resultRow(q, r))),
        !q.closed && q.recipients.some((r) => !r.result) ? h('button.btn.btn-sm.btn-quiet', { type: 'button', onclick: () => act({ t: 'prep.check.close', id: q.id }, 'Check closed.') }, 'Close check') : null)));
  }

  return h('section.prep-checks', { 'aria-label': 'Scene checks' }, checks.map(row),
    h('button.btn.btn-sm.btn-quiet', { type: 'button', disabled: checks.length >= 12, onclick: add }, icon('plus', { size: 14 }), 'Add check'));
}
