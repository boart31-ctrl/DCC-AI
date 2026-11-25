// GM-only review. Nothing reaches a crawler until the GM submits checked proposals.
import { h, toast } from './client.js';

export function createBatchAchievements({ getView, act }) {
  const notes = h('textarea.inp', { rows: 3, placeholder: 'Optional GM notes or transcript', 'aria-label': 'Notes or transcript' });
  const json = h('textarea.inp', { rows: 3, placeholder: 'Paste JSON proposals', 'aria-label': 'JSON proposals' });
  const list = h('div.ach-batch-list');
  const result = h('p.dim', { role: 'status' });
  const ceremony = h('div');
  const btn = (name, fn) => h('button.btn', { type: 'button', onclick: fn }, name);
  const rows = [];
  let busy = false;
  const view = () => getView();
  const catalog = () => view().gm.achievementsCatalog;
  const playerName = id => view().players.find(p => p.id === id)?.name ?? id;
  const sessionLog = () => [
    'Play clock: ' + view().gm.playClock.playMin + ' minutes',
    ...view().players.map(p => p.id + ' = ' + p.name),
    ...(view().gm.achLog ?? []).map(m => playerName(m.playerId) + ' · ' + [m.on, m.what, m.deg, m.mark, m.rarity, m.nat && 'die ' + m.nat, m.round && 'round ' + m.round].filter(Boolean).join(' · ')),
    ...(view().gm.combatLog ?? []).map(f => 'Fight: ' + JSON.stringify(f)),
    ...view().feed.map(e => e.text).filter(Boolean), notes.value.trim(),
  ].filter(Boolean).join('\n');

  function add(data) {
    if (rows.length >= 100) throw Error('Review the current 100 proposals first.');
    const p = view().players.find(x => x.id === data.playerId || x.name === data.name);
    if (!p) throw Error('Unknown recipient: ' + (data.playerId || data.name || '(missing)'));
    if (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 80) throw Error('Each title must have 1–80 characters.');
    if (rows.some(r => r.playerId === p.id && r.title === data.title.trim())) return;
    const box = data.box?.toLowerCase?.() || '';
    if (box && !view().pack.lootTiers.some(t => t.id === box)) throw Error('Unknown box: ' + box);
    rows.push({ playerId: p.id, title: data.title.trim(), desc: String(data.desc || ''), reward: String(data.reward || ''), voiceLine: String(data.voiceLine || ''), box, checked: false });
  }

  function generate() {
    const v = view();
    if (!v.players.length) { result.textContent = 'Add a crawler first.'; return; }
    const start = rows.length;
    const milestones = {
      kill: ['Final Signature', 'credited kills'], saved: ['Return Ticket', 'rescues from dying'],
      down: ['Floor Inspector', 'falls to zero HP'], evade: ['Missed Appointment', 'Evade rolls'],
      mark: ['Badge Collector', 'new marks'], loot: ['Parcel Inspector', 'opened boxes'],
      sponsor: ['Fan Mail', 'sponsor gifts'], roll: ['Dice Auditor', 'recorded rolls'],
    };
    const pool = catalog().filter(x => x.group === 'situational');
    for (const p of v.players) {
      const earned = v.gm.playersFull?.find(x => x.id === p.id)?.achievements ?? [];
      const seen = new Set([...earned, ...rows.filter(r => r.playerId === p.id)].map(a => a.title));
      const moments = (v.gm.achLog ?? v.gm.achRecent ?? []).filter(x => x.playerId === p.id);
      const latest = moments.at(-1);
      const event = [...moments].reverse().find(m => milestones[m.on] && !seen.has(milestones[m.on][0]));
      if (event && rows.length < 100) {
        const [title, unit] = milestones[event.on];
        const count = moments.filter(m => m.on === event.on).length;
        add({ playerId: p.id, title, desc: p.name + ' finished the session with ' + count + ' ' + unit + '. The clerk requests a recount.', reward: 'Audience recognition.' });
      }
      const choices = [...pool].filter(x => !seen.has(x.title)).map(x => ({ x, score: Math.random() + (latest && x.on === latest.on ? 1 : 0) })).sort((a,b) => b.score-a.score);
      for (const { x } of choices.slice(0, 3)) {
        if (rows.length >= 100) break;
        add({ ...x, playerId: p.id });
      }
      if (!pool.length && rows.length < 100) {
        const choices = catalog().filter(x => !seen.has(x.title) && (!x.on || moments.some(m => m.on === x.on)));
        for (const x of choices.slice(0, Math.min(3, 100-rows.length))) add({ ...x, playerId: p.id });
      }
    }
    draw();
    result.textContent = (rows.length - start) + ' new ideas. Check the ones that happened at your table.';
  }

  function draw() {
    list.replaceChildren(...rows.map(r => {
      const field = (key, label, max) => h('label.lbl', label, h('input.inp', { value: r[key], maxlength: max, oninput: e => { r[key] = e.target.value; } }));
      const select = (key, values) => {
        const el = h('select.inp', { 'aria-label': key === 'box' ? 'Box tier' : 'Recipient', onchange: e => { r[key] = e.target.value; } }, values.map(([id, label]) => h('option', { value: id }, label)));
        el.value = r[key]; return el;
      };
      return h('section.panel', h('label', h('input', { type: 'checkbox', checked: r.checked, onchange: e => { r.checked = e.target.checked; } }), ' ', r.title),
        select('playerId', view().players.map(p => [p.id,p.name])), h('details', h('summary', 'Edit award'), field('title','Title',80),field('desc','Description',300),field('reward','Reward',200),field('voiceLine','Spoken line',300),select('box',[['','No box'],...view().pack.lootTiers.map(t => [t.id,t.name])])) );
    }));
    drawCeremony();
  }

  function drawCeremony() {
    const q = view().gm.achCeremony || [];
    const next = q[0];
    ceremony.replaceChildren(...(next ? [btn('Previously on… · Present ' + (catalog().find(x => x.id === next.achId)?.title ?? 'award') + ' to ' + playerName(next.playerId) + ' (' + q.length + ' queued)', async () => {
      if (busy) return;
      busy = true;
      try { await act({ t:'ach.ceremony', ...next }); } finally { busy = false; drawCeremony(); }
    })] : []));
  }
  async function submit(mode) {
    if (busy) return;
    const selected = rows.filter(r => r.checked);
    if (!selected.length || selected.length > 30) { result.textContent = 'Check 1–30 proposals.'; return; }
    busy = true;
    try {
      const ack = await act({ t:'ach.batch', mode, rows:selected.map(({checked,...r}) => r) });
      if (!ack) return;
      for (const r of selected) rows.splice(rows.indexOf(r), 1);
      draw();
      result.textContent = ack.result.count + (mode === 'award' ? ' awarded.' : ' queued for the ceremony.');
    } finally { busy = false; }
  }
  function importJson() {
    const length = rows.length;
    try {
      const values = JSON.parse(json.value);
      if (!Array.isArray(values) || !values.length) throw Error('Expected an array of proposals.');
      values.forEach(add); json.value = ''; draw(); result.textContent = (rows.length-length) + ' imported.';
    } catch (e) { rows.splice(length); result.textContent = e.message; }
  }
  const file = h('input', { type:'file', accept:'.txt,text/plain', 'aria-label':'Load transcript', onchange: async e => { const f=e.target.files[0]; if (f) notes.value=await f.text(); } });
  const dlg = h('dialog.sheet-dlg.tool', { 'aria-label':'Custom achievements' }, h('div.sheet-inner',
    h('header.sheet-head', h('h3','Custom achievements'),btn('Close',()=>dlg.close())),
    h('div.sheet-body', btn('Generate proposals',generate), h('details',h('summary','Session log, transcript and JSON import'),notes,file,
      btn('Export session log',()=>{ const url=URL.createObjectURL(new Blob([sessionLog()],{type:'text/plain'})); const a=h('a',{href:url,download:'session-log.txt'}); a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); }),
      btn('Copy prompt',async()=>{try {await navigator.clipboard.writeText('Generate original tabletop achievements drawn from this session, up to three per crawler. Use short titles (six words maximum), a sentence describing the feat and one dry joke. Use small rewards, rarely silver. Return only a JSON array of {playerId,title,desc,reward,box,voiceLine}. Use an empty box or one of '+view().pack.lootTiers.map(t=>t.id).join(', ')+'.\n\n'+sessionLog());toast('Prompt copied.');}catch {result.textContent='Clipboard unavailable. Export the session log instead.';} }),json,btn('Import proposals',importJson)),result,list,btn('Award checked now',()=>submit('award')),btn('Queue checked for next session',()=>submit('queue')),ceremony)));
  document.body.append(dlg);
  return { open() { draw(); dlg.showModal(); }, update() { if (dlg.open) drawCeremony(); } };
}
