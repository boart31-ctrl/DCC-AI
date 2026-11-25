import { h } from './client.js';

const columns = ['text','weight','from','to','make','enabled','names'];
function readCsv(text) {
  const records = [];
  let record = [], cell = '', quoted = false;
  for (let i=0; i<text.length; i++) {
    const c=text[i];
    if (c === '"') {
      if (quoted && text[i+1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && c === ',') { record.push(cell); cell=''; }
    else if (!quoted && c === '\n') { record.push(cell); records.push(record); record=[]; cell=''; }
    else if (c !== '\r') cell += c;
  }
  if (quoted) throw Error('Unclosed CSV quote.');
  record.push(cell); records.push(record);
  const header=records.shift().map(x=>x.trim().toLowerCase());
  if (!header.includes('text')) throw Error('CSV needs a text column.');
  return records.filter(r=>r.some(Boolean)).map(r=>{
    const get=k=>r[header.indexOf(k)] || '';
    return { text:get('text'), ...(get('weight') ? {weight:Number(get('weight'))}:{}),
      ...(get('from') || get('to') ? {range:[Number(get('from')),Number(get('to'))]}:{}),
      disabled:get('enabled').toLowerCase()==='false', make:get('make'), names:get('names') };
  });
}
function writeCsv(rows) {
  const quote=x=>'"'+String(x??'').replaceAll('"','""')+'"';
  return [columns.join(','), ...rows.map(r=>[r.text,r.weight,r.range?.[0],r.range?.[1],r.make,!r.disabled,r.names].map(quote).join(','))].join('\n');
}

export function createTableEditor({getView,act}) {
  let source = {}, own = false, busy = false;
  const name=h('input.inp',{maxlength:80,'aria-label':'Table name'});
  const group=h('input.inp',{maxlength:40,'aria-label':'Table group'});
  const data=h('textarea.inp',{rows:12,'aria-label':'Table rows'});
  const mode=h('select.inp',{'aria-label':'Row format'},h('option',{value:'lines'},'One result per line'),h('option',{value:'csv'},'CSV with row options'));
  const picker=h('select.inp',{'aria-label':'Existing table'});
  const status=h('p.dim',{role:'status'});
  const btn=(label,fn)=>h('button.btn',{type:'button',onclick:fn},label);
  const rows=()=>mode.value==='csv'?readCsv(data.value):data.value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean).map(text=>({text}));
  function reset() { source={}; own=false; name.value=''; group.value='Campaign'; mode.value='lines'; data.value=''; status.textContent=''; picker.value=''; }
  function options() {
    picker.replaceChildren(h('option',{value:''},'New table'),...getView().gm.tables.catalog.map(t=>h('option',{value:t.id},t.name+(t.own?' · campaign':''))));
  }
  picker.onchange=async()=>{
    const id=picker.value;
    if (!id) {reset();return;}
    const ack=await act({t:'table.read',id});
    if (!ack || picker.value!==id) return;
    source=ack.result; own=source.own; name.value=own?source.name:source.name+' (copy)'; group.value=source.group;
    data.value=writeCsv(source.rows); mode.value='csv'; status.textContent=own?'Editing campaign table.':'Saving creates a campaign copy.';
  };
  let previous='lines';
  mode.onfocus=()=>{previous=mode.value;};
  mode.onchange=()=>{
    if (mode.value==='lines' && data.value.trim()) { mode.value='csv'; status.textContent='Choose New table to paste plain lines. CSV preserves row options.';return; }
    if (mode.value==='csv' && previous==='lines') data.value=writeCsv(data.value.split(/\r?\n/).filter(Boolean).map(text=>({text})));
    previous=mode.value;
  };
  const file=h('input',{type:'file',accept:'.csv,text/csv','aria-label':'Import CSV',onchange:async e=>{ const f=e.target.files[0]; if (!f)return; try { const parsed=readCsv(await f.text()); data.value=writeCsv(parsed); mode.value='csv'; if(!name.value)name.value=f.name.replace(/\.csv$/i,''); } catch(err){status.textContent=err.message;} }});
  const dlg=h('dialog.sheet-dlg.tool',{'aria-label':'Campaign tables'},h('div.sheet-inner',
    h('header.sheet-head',h('h3','Campaign tables'),btn('Close',()=>dlg.close())),
    h('div.sheet-body',picker,h('label.lbl','Table name',name),h('label.lbl','Group',group),mode,data,
      h('p.dim','CSV supports text, weight, from, to, make, enabled and names. Set enabled to false to skip a row.'),
      file,btn('Export CSV',()=>{try {const url=URL.createObjectURL(new Blob([writeCsv(rows())],{type:'text/csv'}));h('a',{href:url,download:(name.value||'table')+'.csv'}).click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){status.textContent=e.message;}}),
      btn('Save campaign table',async()=>{
        if (busy) return;
        busy=true;
        try {
          const ack=await act({t:'table.save',...(own?{id:source.id,revision:source.revision}:{}),name:name.value,group:group.value,desc:source.desc,scope:source.scope,rows:rows()});
          if(ack){own=true;source={...source,...ack.result};options();picker.value=source.id;status.textContent='Saved '+name.value+'.';}
        } catch(e){status.textContent=e.message;} finally {busy=false;}
      }),status)));
  document.body.append(dlg);
  return {open(){options();reset();dlg.showModal();}};
}
