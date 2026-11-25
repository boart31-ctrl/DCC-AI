import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTables, rollTable, TABLES_GM } from '../tables.js';
import { loadPack } from '../pack.js';
import { createState, reduce, viewFor } from '../state.js';
import { tmpDir, writePack } from './fixtures.js';

const seq = (vals) => { let i = 0; return (n) => vals[i++ % vals.length] % n; };

test('normalize: plain rows → dN, ranges validated, weights, hidden, bad nested reference warned', () => {
  const w = [];
  const T = normalizeTables({ tables: [
    { id: 'a', name: 'A', rows: ['one', 'two', 'three'] },
    { id: 'b', name: 'B', rows: [{ range: [1, 2], text: 'x' }, { range: [4, 6], text: 'y' }] },
    { id: 'c', name: 'C', rows: [{ text: 'rare', weight: 1 }, { text: 'common', weight: 9 }], hidden: true },
    { id: 'd', name: 'D', rows: ['[[nope]]'] },
    { id: 'Bad Id', rows: ['x'] },
  ] }, w);
  assert.deepEqual(T.tables.map((t) => [t.id, t.die]), [['a', 'd3'], ['b', 'd6'], ['c', 'weights'], ['d', 'd1']]);
  assert.ok(w.some((x) => x.includes('b: ranges')));
  assert.ok(w.some((x) => x.includes('[[nope]]')));
  assert.ok(w.some((x) => x.includes('valid id')));
});

test('roll: dice in braces, nested tables, vars, no repeat of the last rolls', () => {
  const pack = { tables: normalizeTables({ tables: [
    { id: 'n', name: 'N', rows: ['{2d6+1} rats near {name}'] },
    { id: 'outer', name: 'O', rows: ['It is [[n]]!'] },
    { id: 'four', name: 'F', rows: ['1', '2', '3', '4'] },
  ] }) };
  const st = {};
  const ctx = { pack, randInt: seq([2, 3]) };
  assert.equal(rollTable(st, ctx, 'outer', { name: 'Carl' }).text, 'It is 8 rats near Carl!'); // (2+1)+(3+1)+1
  const ctx2 = { pack, randInt: seq([0, 0, 0, 0, 1, 2, 3]) };
  const got = [];
  for (let i = 0; i < 4; i++) got.push(rollTable(st, ctx2, 'four').text);
  assert.equal(new Set(got).size, 4, 'no row repeats inside the window');
});

function demo() {
  const { pack } = loadPack(new URL('../../packs/demo', import.meta.url).pathname);
  let n = 0;
  const ctx = { pack, now: 1, rng: () => 0.3, genId: (p) => `${p}_${++n}` };
  let state = createState(pack, 0);
  const step = (a) => { const r = reduce(state, { role: 'gm', ...a }, ctx); state = r.state; return r; };
  return { pack, ctx, step, get state() { return state; } };
}

test('demo pack: 10+ visible tables, every one rolls', () => {
  const d = demo();
  const v = viewFor(d.state, d.pack, 'gm', d.ctx).gm.tables;
  assert.ok(v.catalog.length >= 10, `${v.catalog.length} tables`);
  assert.ok(!v.catalog.some((t) => t.id === 'crowd_look'), 'hidden building blocks are not listed');
  for (const t of v.catalog) {
    const r = d.step({ t: 'table.roll', id: t.id }).result;
    assert.ok(r.text && !/\{\d*d\d+|\[\[/.test(r.text), `${t.id}: ${r.text}`);
  }
  assert.equal(d.state.tableRecent.length, 10);
  assert.equal(d.step({ t: 'names.roll', list: 'goblin' }).result.names.length, 5);
});

test('crowd: 4 at a party, each exactly 3 sentences; reroll one; save 2 → campaign NPCs, same name merges', () => {
  const d = demo();
  d.step({ t: 'crowd.gen', place: 'party', n: 4 });
  const c = d.state.crowd;
  assert.equal(c.people.length, 4);
  for (const p of c.people) {
    assert.equal(p.lines.length, 3);
    for (const l of p.lines) assert.match(l, /^[A-Z"].*[.!?"]$/);
    assert.ok(p.lines[0].includes(p.name));
  }
  const keep = c.people.map((p) => p.id);
  d.step({ t: 'crowd.reroll', id: keep[1] });
  assert.equal(d.state.crowd.people[0].id, keep[0]);
  assert.notEqual(d.state.crowd.people[1].id, keep[1]);
  const [p0, p2] = [d.state.crowd.people[0], d.state.crowd.people[2]];
  d.step({ t: 'crowd.save', id: p0.id });
  d.step({ t: 'crowd.save', id: p2.id });
  const npcs = d.state.library.npc;
  assert.equal(npcs.length, p0.name === p2.name ? 1 : 2);
  const e = npcs.find((x) => x.name === p0.name);
  assert.ok(e.desc.includes(p0.lines[1]));
  assert.ok(e.role.includes('A party'));
  assert.ok(e.tags.includes('campaign'));
  d.step({ t: 'crowd.save', id: p0.id });
  assert.equal(d.state.library.npc.filter((x) => x.name === p0.name).length, 1, 'saving again merges by name');
  assert.throws(() => d.step({ t: 'crowd.gen', n: 7 }), /1–6/);
  d.step({ t: 'table.keep', table: 'X', text: 'kept line' });
  assert.equal(viewFor(d.state, d.pack, 'gm', d.ctx).gm.tables.kept[0].text, 'kept line');
});

test('crowd portraits: picked by species, saved onto the NPC', () => {
  const pack = { tables: normalizeTables({ tables: [{ id: 'sp', rows: [{ text: 'goblin' }] }, { id: 'l', rows: ['{name} looks'] }],
    names: [{ id: 'n', first: ['Gub'] }], crowd: { species: 'sp', look: 'l', portraits: [{ image: 'crowd/goblin_01.webp', species: 'goblin' }, { image: 'crowd/human_01.webp', species: 'human' }] } }) };
  let n = 0;
  const st = { crowd: null, library: { npc: [] } };
  const ctx = { pack, now: 1, randInt: (k) => 0, genId: (p) => `${p}${++n}` };
  TABLES_GM['crowd.gen'](st, { n: 1 }, ctx, {});
  assert.equal(st.crowd.people[0].image, '/pack/images/crowd/goblin_01.webp');
});

test('campaign editor preserves disabled rows, validates ranges and prevents stale edits; apply is idempotent', () => {
  const d = demo();
  const rows = [{text:'No',disabled:true}, {text:'A witness',make:'npc',weight:5}];
  const {id,revision} = d.step({t:'table.save',name:'Rumours',rows}).result;
  assert.equal(d.step({t:'table.read',id}).result.rows[0].disabled,true);
  assert.throws(()=>d.step({t:'table.save',id,name:'stale',revision:0,rows}),/changed/);
  assert.throws(()=>d.step({t:'table.save',name:'Bad',rows:[{text:'bad',range:[1,1000000000]}]}),/ranges/);
  assert.throws(()=>d.step({t:'table.save',name:'Bad',rows:['[[unknown]]']}),/nested/);
  for(let n=0;n<3;n++) assert.equal(d.step({t:'table.roll',id}).result.text,'A witness');
  const r=d.step({t:'table.roll',id}).result;
  d.step({t:'table.make',resultId:r.id});
  d.step({t:'table.make',resultId:r.id});
  assert.equal(d.state.library.npc.length,1);
  d.step({t:'table.save',id,name:'Evening',revision,rows:[{text:'A clue',make:'note'}]});
  const note=d.step({t:'table.roll',id}).result;
  d.step({t:'table.make',resultId:note.id});
  assert.equal(d.state.tableKept.at(-1).text,'A clue');
});

test('table actions attach trap checks and NPCs to tonight, send table text to TV and grant a picked item', () => {
  const d = demo();
  const {playerId} = d.step({t:'player.add',name:'Iris'}).result;
  const apply = (make, text) => {
    const {id} = d.step({t:'table.save',name:'Test',rows:[{text,make}]}).result;
    const resultId = d.step({t:'table.roll',id}).result.id;
    d.step({t:'table.make',resultId,playerId});
  };
  d.step({t:'prep.evening.build',title:'Tonight',recipe:['trap'],suggest:false});
  const scene = () => d.state.prep.docs.find(x=>x.id===d.state.prep.current).evening.scenes[0];
  apply('trap','Watch the pressure plate');
  assert.equal(scene().checks.at(-1).fail,'Watch the pressure plate');
  apply('npc','A witness to the trap');
  assert.equal(scene().npcs.at(-1),d.state.library.npc.at(-1).id);
  apply('tv','The room goes dark');
  assert.equal(d.state.messages.at(-1).text,'The room goes dark');
  apply('item:'+d.pack.items[0].id,'Found an item');
  assert.equal(d.state.players[0].inventory.at(-1).itemId,d.pack.items[0].id);
});
