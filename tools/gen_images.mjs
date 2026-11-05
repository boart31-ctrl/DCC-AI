#!/usr/bin/env node
// Generate item art with the OpenAI Images API from a prompts CSV.
//
//   node tools/gen_images.mjs <prompts.csv> <raw_dir> [--pack dcc] [--limit 3] [--only id1,id2] [--dry-run]
//
// Needs OPENAI_API_KEY in .env (or the environment). Optional: OPENAI_IMAGE_MODEL (default gpt-image-1),
// OPENAI_IMAGE_QUALITY (low | medium | high, default medium).
// Writes <raw_dir>/<id>.png and skips ids that already have a raw or processed image, so it is safe to
// re-run after a failure. Then run tools/process_art.py on the pack to crop and convert.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const has = (n) => args.includes(n);
const [csvPath, rawDir] = args.filter((a, i) => !a.startsWith('--') && !['--pack', '--limit', '--only'].includes(args[i - 1]));
if (!csvPath || !rawDir) {
  console.error('usage: node tools/gen_images.mjs <prompts.csv> <raw_dir> [--pack dcc] [--limit N] [--only a,b] [--dry-run]');
  process.exit(1);
}

// Tiny .env reader (same rules as the server: KEY=value, # comments).
for (const f of ['.env', path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.env')]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  break;
}

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
}

let rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
if (flag('--pack')) rows = rows.filter((r) => r.pack === flag('--pack'));
if (flag('--only')) { const only = new Set(flag('--only').split(',')); rows = rows.filter((r) => only.has(r.id)); }

fs.mkdirSync(rawDir, { recursive: true });
const imagesDir = path.dirname(path.resolve(rawDir));
const done = (id) => ['png', 'jpg', 'webp'].some((e) => fs.existsSync(path.join(rawDir, `${id}.${e}`)))
  || fs.existsSync(path.join(imagesDir, `${id}.webp`));
const missing = rows.filter((r) => r.id && r.prompt && !done(r.id));
let todo = flag('--limit') ? missing.slice(0, Number(flag('--limit'))) : missing;

const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const quality = process.env.OPENAI_IMAGE_QUALITY || 'medium';
console.log(`${rows.length} prompts, ${rows.length - missing.length} already have art, generating ${todo.length} of ${missing.length} missing (model ${model}, quality ${quality}).`);
if (has('--dry-run') || !todo.length) process.exit(0);
const key = process.env.OPENAI_API_KEY;
if (!key) { console.error('OPENAI_API_KEY missing (put it in .env, never commit it).'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function generate(r) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, prompt: r.prompt, size: '1024x1024', quality, n: 1 }),
    });
    if (res.ok) {
      const data = await res.json();
      const b64 = data.data?.[0]?.b64_json;
      if (b64) { fs.writeFileSync(path.join(rawDir, `${r.id}.png`), Buffer.from(b64, 'base64')); return true; }
      const url = data.data?.[0]?.url;
      if (url) { fs.writeFileSync(path.join(rawDir, `${r.id}.png`), Buffer.from(await (await fetch(url)).arrayBuffer())); return true; }
      throw new Error('no image in response');
    }
    const body = await res.text();
    if (res.status === 429 || res.status >= 500) { await sleep(5000 * attempt); continue; }
    throw new Error(`${res.status} ${body.slice(0, 200)}`);
  }
  throw new Error('gave up after retries');
}

let ok = 0, fail = 0;
const queue = [...todo];
async function worker() {
  while (queue.length) {
    const r = queue.shift();
    try { await generate(r); ok++; console.log(`✓ ${r.id} (${ok + fail}/${todo.length})`); }
    catch (e) { fail++; console.log(`✗ ${r.id}: ${e.message}`); }
  }
}
await Promise.all([worker(), worker()]);
console.log(`Done: ${ok} generated, ${fail} failed. Next: python3 tools/process_art.py <pack_dir>`);
