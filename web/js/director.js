// Director (railroad, 27 Nov): the GM plays tonight's evening one page at a time, like a gamebook.
// Each scene may carry `steps` (prep.js normalizeStep). The GM sees only the current page: the System reads
// its `say` (ElevenLabs through `say`, browser voice without a key), the page lists the tasks and the goal,
// a GM-only note, one-click buttons (`do`) and the page turns (`next`). Future pages stay hidden.
//
//   const director = createDirector({ act, getView, run, openCheck });
//   director.open(docId); director.refresh() after every view.
import { h, toast } from './client.js';
import { icon } from './ui.js';
import { untag } from './voice.js';

const KEY_AUTO = 'system.director.autoRead';
const DEGREE = { crit: 'Critical', amazing: 'Amazing', success: 'Success', near: 'Near miss', fail: 'Fail', major: 'Major fail', critfail: 'Critical fail' };

/** Every step of the evening in reading order, with its scene. */
export function stepsOf(evening) {
  const out = [];
  for (const scene of evening?.scenes ?? []) for (const step of scene.steps ?? []) out.push({ scene, step });
  return out;
}

/** Where a page turn leads: an explicit target (any scene), else the next page, else null (the end). */
export function turnTarget(evening, sceneId, stepId, to) {
  const all = stepsOf(evening);
  if (to) return all.find((x) => x.step.id === to) ?? null;
  const i = all.findIndex((x) => x.scene.id === sceneId && x.step.id === stepId);
  return i >= 0 ? all[i + 1] ?? null : null;
}

export function hasSteps(evening) {
  return (evening?.scenes ?? []).some((s) => s.steps?.length);
}

export function createDirector({ act, getView, run, openCheck }) {
  let docId = null;
  let picking = null; // { key, action } waiting for crawlers
  let picked = new Set();
  let lastRead = '';
  let autoRead = (() => { try { return localStorage.getItem(KEY_AUTO) !== 'off'; } catch { return true; } })();
  const body = h('div.dir-body');
  const dlg = h('dialog.dir', { 'aria-label': 'Director' }, body);
  document.body.append(dlg);
  dlg.addEventListener('close', () => { docId = null; picking = null; });
  dlg.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, select')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { const b = body.querySelector('.dir-turn'); if (b) { e.preventDefault(); b.click(); } }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { const b = body.querySelector('.dir-back'); if (b && !b.disabled) { e.preventDefault(); b.click(); } }
  });

  const doc = () => (getView()?.gm?.prep?.docs ?? []).find((d) => d.id === docId) ?? null;

  // D anywhere on the desk: tonight's evening as director (when it has pages).
  document.addEventListener('keydown', (e) => {
    if ((e.key !== 'd' && e.key !== 'D') || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.querySelector('dialog[open]')) return;
    const prep = getView()?.gm?.prep;
    const tonight = (prep?.docs ?? []).find((d) => d.id === prep?.current);
    if (!hasSteps(tonight?.evening)) return;
    e.preventDefault();
    open(tonight.id);
  });

  async function open(id) {
    docId = id;
    const d = doc();
    if (!d?.evening) return;
    if (!d.evening.director) {
      const first = stepsOf(d.evening)[0];
      if (!first) { toast('This evening has no director pages yet.', { error: true }); return; }
      await go(first.scene.id, first.step.id);
    } else draw();
    if (!dlg.open) dlg.showModal();
  }

  async function go(sceneId, stepId) {
    picking = null;
    const r = await act({ t: 'prep.director.go', id: docId, sceneId, stepId });
    if (!r) return;
    draw(true);
  }

  async function back() {
    picking = null;
    if (await act({ t: 'prep.director.go', id: docId, back: true })) draw();
  }

  async function read(step) {
    if (!step?.say) return;
    lastRead = `${docId}:${step.id}`;
    await act({ t: 'say', text: step.say });
  }

  async function doAction(scene, step, a) {
    const d = doc();
    const view = getView();
    const lib = view?.library ?? {};
    switch (a.kind) {
      case 'tv':
      case 'chase':
        return run(d, scene, {});
      case 'fight':
        return run(d, scene, { fight: true });
      case 'npc':
        return act({ t: 'scene.set', kind: 'npc', data: { npcId: a.ref } }, `${(lib.npc ?? []).find((n) => n.id === a.ref)?.name ?? 'NPC'} on the TV.`);
      case 'check': {
        const check = (scene.checks ?? []).find((c) => c.id === a.ref) ?? scene.checks?.[0];
        if (!check) { toast('This scene has no such check.', { error: true }); return; }
        return openCheck({ view, act, doc: d, scene, check });
      }
      case 'secret': {
        const secrets = (scene.secrets ?? []).map((x) => (x.id === a.ref ? { ...x, revealed: true } : x));
        return act({ t: 'prep.scene.update', id: d.id, sceneId: scene.id, patch: { secrets } }, 'Clue marked as found.');
      }
      case 'rest':
        return act({ t: 'rest.offer', kind: a.rest || 'short' }, 'Rest offered to the phones.');
      case 'give':
      case 'ach':
      case 'loot':
        picking = { key: `${step.id}:${a.kind}:${a.ref ?? a.tier}`, action: a, scene };
        picked = new Set();
        draw();
        return;
      default:
        return;
    }
  }

  async function award() {
    const { action: a } = picking;
    const view = getView();
    let ok = 0;
    for (const playerId of picked) {
      const done = a.kind === 'give' ? await act({ t: 'item.give', playerId, itemId: a.ref, qty: a.qty ?? 1 })
        : a.kind === 'ach' ? await act({ t: 'ach.award', playerId, achId: a.ref })
          : await act({ t: 'loot.pending.add', playerId, tier: a.tier ?? 'bronze', from: a.label ?? 'The System' });
      if (done) ok++;
    }
    if (!ok) toast('Nothing was given.', { error: true });
    picking = null;
    draw();
  }

  function actionLabel(a, view) {
    if (a.label) return a.label;
    const lib = view?.library ?? {};
    const name = (kind, id) => (lib[kind] ?? []).find((x) => x.id === id)?.name ?? id;
    switch (a.kind) {
      case 'tv': return 'Scene on the TV';
      case 'chase': return 'Chase on the TV';
      case 'fight': return 'Start the fight';
      case 'npc': return `${name('npc', a.ref)} on the TV`;
      case 'check': return 'Send the check';
      case 'secret': return 'Clue found';
      case 'rest': return 'Offer a rest';
      case 'give': return `Give ${name('item', a.ref)}`;
      case 'ach': return `Achievement: ${(view?.gm?.achievementsCatalog ?? []).find((x) => x.id === a.ref)?.title ?? a.ref}`;
      case 'loot': return `${a.tier ?? 'Bronze'} box`;
      default: return a.kind;
    }
  }

  const GLYPH = { tv: 'tv', chase: 'bolt', fight: 'swords', npc: 'users', check: 'dice', secret: 'eye', rest: 'moon', give: 'gift', ach: 'star', loot: 'gift' };

  function checkResults(view, d, scene, a) {
    if (a.kind !== 'check') return null;
    const check = (scene.checks ?? []).find((c) => c.id === a.ref) ?? scene.checks?.[0];
    const q = (view?.gm?.prepChecks ?? []).filter((x) => x.docId === d.id && x.sceneId === scene.id && x.checkId === check?.id).at(-1);
    if (!q) return null;
    const names = new Map((view?.players ?? []).map((p) => [p.id, p.name]));
    return h('ul.dir-results', q.recipients.map((r) => {
      const res = r.result;
      const text = !res ? null : res.degree === 'near' ? q.check.near || q.check.fail : ['crit', 'amazing', 'success'].includes(res.degree) ? q.check.success : q.check.fail;
      return h('li', h('b', names.get(r.playerId) ?? 'Crawler'), res ? h('span.dir-deg', `${DEGREE[res.degree] ?? res.degree} · ${res.total} vs DC ${q.dc}`) : h('span.dim', 'waiting'),
        text ? h('p.dir-say', text) : null);
    }));
  }

  function picker(view) {
    const players = view?.players ?? [];
    return h('div.dir-pick',
      h('b', `${actionLabel(picking.action, view)}: who gets it?`),
      h('div.dir-pick-row', players.map((p) => h('button.chip', { type: 'button', class: `chip${picked.has(p.id) ? ' on' : ''}`, 'aria-pressed': String(picked.has(p.id)),
        onclick: () => { picked.has(p.id) ? picked.delete(p.id) : picked.add(p.id); draw(); } }, p.name))),
      h('div.dir-pick-row',
        h('button.btn.btn-quiet', { type: 'button', onclick: () => { picking = null; draw(); } }, 'Cancel'),
        h('button.btn.btn-primary', { type: 'button', disabled: !picked.size, onclick: award }, picked.size ? `Give to ${picked.size}` : 'Pick a crawler')));
  }

  function draw(entered = false) {
    const d = doc();
    if (!d?.evening) { body.replaceChildren(h('p', 'This evening is gone.')); return; }
    const view = getView();
    const all = stepsOf(d.evening);
    const pos = d.evening.director;
    const at = all.findIndex((x) => x.scene.id === pos?.sceneId && x.step.id === pos?.stepId);
    const cur = all[at];
    if (!cur) { body.replaceChildren(h('p', 'No page.')); return; }
    const { scene, step } = cur;
    if (entered && autoRead && step.say && lastRead !== `${docId}:${step.id}`) read(step);
    const turns = step.end ? [] : step.next.length ? step.next : [{ label: 'Turn the page' }];
    body.replaceChildren(
      h('header.dir-head',
        h('span.dir-evening', d.title),
        h('span.dir-progress', { title: 'Pages read / pages tonight' }, `${at + 1} / ${all.length}`),
        h('progress', { max: all.length, value: at + 1, 'aria-hidden': 'true' }),
        h('label.dir-auto', h('input', { type: 'checkbox', checked: autoRead, onchange: (e) => { autoRead = e.target.checked; try { localStorage.setItem(KEY_AUTO, autoRead ? 'on' : 'off'); } catch { /* */ } } }), ' The System reads each page'),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x', { size: 18 }))),
      h('p.dir-scene', scene.title),
      h('h2.dir-title', step.title || scene.title),
      step.say ? h('section.dir-read',
        h('div.dir-read-top', h('span.dir-k', 'The System reads'),
          h('button.btn.btn-sm', { type: 'button', onclick: () => read(step) }, icon('speaker', { size: 14 }), 'Read again')),
        h('p.dir-say', untag(step.say))) : null,
      step.tasks.length ? h('section.dir-tasks', h('span.dir-k', 'What the crawlers can do'), h('ul', step.tasks.map((t) => h('li', t)))) : null,
      step.goal ? h('section.dir-goal', h('span.dir-k', 'Goal'), h('p', step.goal)) : null,
      step.gm ? h('details.dir-gm', { open: true }, h('summary', h('span.dir-k', 'Only you')), h('p', step.gm)) : null,
      step.do.length ? h('section.dir-do', step.do.map((a) => h('div.dir-act',
        h('button.btn.dir-act-btn', { type: 'button', onclick: () => doAction(scene, step, a) }, icon(GLYPH[a.kind] ?? 'bolt', { size: 16 }), actionLabel(a, view)),
        picking && picking.key === `${step.id}:${a.kind}:${a.ref ?? a.tier}` ? picker(view) : null,
        checkResults(view, d, scene, a)))) : null,
      h('footer.dir-foot',
        h('button.btn.dir-back', { type: 'button', disabled: !pos?.trail?.length, onclick: back }, icon('back', { size: 16 }), 'Back'),
        h('span.grow'),
        step.end ? h('button.btn.btn-primary.dir-turn', { type: 'button', onclick: async () => { await act({ t: 'prep.director.go', id: d.id, stop: true }); dlg.close(); } }, 'The end') : null,
        ...turns.map((n, i) => {
          const target = turnTarget(d.evening, scene.id, step.id, n.to);
          return h(`button.btn${i === turns.length - 1 ? '.btn-primary' : ''}.dir-turn`, { type: 'button', disabled: !target,
            title: target ? '' : 'No page after this one', onclick: () => target && go(target.scene.id, target.step.id) }, n.label, icon('skip', { size: 16 }));
        })));
  }

  return {
    open,
    refresh: () => { if (dlg.open && docId) draw(); },
    get isOpen() { return dlg.open; },
  };
}
