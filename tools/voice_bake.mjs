#!/usr/bin/env node
// Renders a recording wave with ElevenLabs (e.g. a clone of the GM's own voice) and hands the files to
// tools/voice_ingest.py (single-file mode: trim, levelling, mp3, wiring into quips.json, WAVES.csv status).
//
//   ELEVENLABS_API_KEY=… ELEVENLABS_VOICE_ID=… node tools/voice_bake.mjs --pack packs/dcc --voice voice --wave V05
//       [--only id,id] [--force] [--dry-run] [--model eleven_multilingual_v2]
//
// Tagged lines (voice/tts.json) are rendered with eleven_v3 unless --model / ELEVENLABS_MODEL_ID says otherwise.
// Lines already recorded (status set and file present) are skipped unless --force (or listed in --only).
// --dry-run prints the lines and the character count (what it will cost) and calls nothing.
// Voice settings: ELEVENLABS_STABILITY / _SIMILARITY / _STYLE (0..1) optional.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createElevenLabs, DEFAULT_MODEL } from '../server/tts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return acc;
  }, []),
);
const die = (m) => { console.error(`error: ${m}`); process.exit(2); };
if (!args.pack || !args.voice || !args.wave) die('usage: --pack <dir> --voice <dir> --wave V05 [--only a,b] [--force] [--dry-run]');

function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const csvFile = path.join(args.voice, 'WAVES.csv');
if (!fs.existsSync(csvFile)) die(`${csvFile} missing: run voice_ingest.py plan first`);
const rows = readCsv(csvFile).filter((r) => r.wave.toUpperCase() === String(args.wave).toUpperCase());
if (!rows.length) die(`wave ${args.wave} not in WAVES.csv`);
const only = typeof args.only === 'string' ? args.only.split(',').map((s) => s.trim()).filter(Boolean) : null;
const audioDir = path.join(args.pack, 'audio');
const todo = rows.filter((r) => {
  if (only) return only.includes(r.id);
  const done = r.status && !r.status.startsWith('ZMĚNA') && fs.existsSync(path.join(audioDir, `${r.id}.mp3`));
  return args.force || !done;
});
// Tagged scripts for Eleven v3 (voice/tts.json: { id: "[excited] Twenty! ..." }) are spoken instead of the plain text.
const ttsFile = path.join(args.voice, 'tts.json');
const tagged = fs.existsSync(ttsFile) ? JSON.parse(fs.readFileSync(ttsFile, 'utf8')) : {};
for (const r of todo) r.say = tagged[r.id] || r.text;
const anyTagged = todo.some((r) => tagged[r.id]);
const chars = todo.reduce((n, r) => n + r.say.length, 0);
console.log(`${args.wave}: ${todo.length}/${rows.length} lines to render, ${chars} characters`);
for (const r of todo) console.log(`  ${r.order.padStart(3)}  ${r.id.padEnd(28)} ${r.say.slice(0, 70)}`);
if (args['dry-run'] || !todo.length) process.exit(0);

const apiKey = process.env.ELEVENLABS_API_KEY;
const voiceId = process.env.ELEVENLABS_VOICE_ID;
if (!apiKey || !voiceId) die('set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID');
const num = (v, d) => (v === undefined || v === '' ? d : Math.min(1, Math.max(0, Number(v))));
const voiceSettings = {
  stability: num(process.env.ELEVENLABS_STABILITY, 0.4),
  similarity_boost: num(process.env.ELEVENLABS_SIMILARITY, 0.8),
  style: num(process.env.ELEVENLABS_STYLE, 0.35),
  use_speaker_boost: true,
};
const el = createElevenLabs({ apiKey, timeoutMs: 60_000 });
const modelId = typeof args.model === 'string' ? args.model : process.env.ELEVENLABS_MODEL_ID || (anyTagged ? 'eleven_v3' : DEFAULT_MODEL);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bake-'));
const files = [];
for (const r of todo) {
  for (let attempt = 1; ; attempt++) {
    try {
      const bytes = await el.tts({ voiceId, modelId, text: r.say, voiceSettings, format: 'mp3_44100_128' });
      const f = path.join(tmp, `${r.id}.mp3`);
      fs.writeFileSync(f, bytes);
      files.push(f);
      console.log(`  ok ${r.id}`);
      break;
    } catch (e) {
      if (e.code === 'busy' && attempt < 4) { await new Promise((ok) => setTimeout(ok, 3000 * attempt)); continue; }
      console.error(`  FAILED ${r.id}: ${e.message}`);
      if (e.code === 'quota' || e.code === 'bad_key') { if (files.length) break; process.exit(1); }
      break;
    }
  }
}
if (!files.length) die('nothing rendered');
const res = spawnSync('python3', [path.join(HERE, 'voice_ingest.py'), 'ingest', ...files, '--pack', args.pack, '--voice', args.voice, '--who', 'klon'], { stdio: 'inherit' });
process.exit(res.status ?? 1);
