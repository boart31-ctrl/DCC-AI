import { h, toast } from './client.js';
import { dieFaces, openDrawer } from './ui.js';

export function pendingLevelActions(grants = []) {
  return grants.reduce((n, grant) => n + grant.ranks.filter((row) => !row.result).length + (!grant.learned && grant.practice.length ? 1 : 0), 0);
}

export function openLevelUp({ getGrants, send, roll = 'd20' }) {
  const body = h('div.level-progress');
  const physicalD20 = /^(?:1)?d20$/i.test(roll);
  let selecting = null;
  let busy = false;
  let lastGrants;
  const local = new Map();
  const rowKey = (id, uid) => `${id}:${uid}`;
  const didRoll = (grant, row) => row.result ?? local.get(rowKey(grant.id, row.uid));
  const learned = (grant) => grant.learned ?? local.get(rowKey(grant.id, 'learn'));

  async function submit(a) {
    if (busy) return;
    busy = true;
    draw();
    try {
      const r = await send(a);
      local.set(rowKey(a.id, a.uid ?? 'learn'), r.result);
      selecting = null;
    } catch (error) { toast(error.message, { error: true }); }
    finally { busy = false; draw(); }
  }

  function rankRow(grant, row) {
    const result = didRoll(grant, row);
    const selected = selecting?.id === grant.id && selecting.uid === row.uid;
    const go = (entered) => submit({ t: 'level.advance', id: grant.id, uid: row.uid, ...(entered == null ? {} : { entered }) });
    const outcome = result?.skipped ?? (result && `Rolled ${result.roll} vs ${result.target} · ${result.from === result.to ? `Rank ${result.to}` : `Rank ${result.from} → ${result.to}`}`);
    return h('li.level-rank', h('div.row-start', h('b', row.name), h('span.dim', outcome || `Rank ${row.rank}`),
      !result && !selected ? h('button.btn.btn-sm', { type: 'button', disabled: busy,
        onclick: () => { selecting = { id: grant.id, uid: row.uid }; draw(); } }, `Roll ${row.name}`) : null),
    selected && !result ? h('div.level-dice',
      physicalD20 ? h('small.dim', 'Enter your d20 result') : null,
      physicalD20 ? dieFaces(20, go, { disabled: busy }) : null,
      h('button.btn.btn-primary', { type: 'button', disabled: busy, onclick: () => go() }, 'Roll digitally')) : null);
  }

  function draw() {
    const stored = getGrants();
    lastGrants = JSON.stringify(stored);
    const grants = [...stored].reverse();
    body.replaceChildren(...(grants.length ? grants.map((grant) => {
      const choice = learned(grant);
      return h('section.panel.level-grant', h('h3', `Level ${grant.from} → ${grant.to}`),
        grant.ranks.length ? h('div', h('h4', 'Skill advancement'), h('ul', grant.ranks.map((row) => rankRow(grant, row)))) : null,
        grant.practice.length ? h('div', h('h4', 'Learn one practiced skill'), choice ? h('p', `${choice.name} learned at Rank 1.`) :
          h('div.row-wrap', grant.practice.map((s) => h('button.btn.btn-sm', { type: 'button', disabled: busy,
            onclick: () => submit({ t: 'level.learn', id: grant.id, skillId: s.id }) }, `Learn ${s.name}`)))) : null,
        !grant.ranks.length && !grant.practice.length ? h('p.dim', 'Level recorded on your sheet.') : null);
    }) : [h('p.empty-s', 'Your GM awards levels. Any skill rolls and learning choices appear here.') ]));
  }

  draw();
  const drawer = openDrawer({ title: 'Level up', body });
  return () => {
    if (drawer.open && lastGrants !== JSON.stringify(getGrants())) draw();
  };
}
