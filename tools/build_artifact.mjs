#!/usr/bin/env node
// Builds the hosted (claude.ai Artifact) edition into a folder ready to publish.
//
//   node tools/build_artifact.mjs <packDir> <outDir>
//
// Output:
//   <outDir>/index.html          artifact/index.html with the gm/play/stage page bodies inlined
//   <outDir>/css/*.css           web/css + artifact/css
//   <outDir>/js/*.js             web/js page modules (shared with the Node edition)
//   <outDir>/js/hosted/*.js      artifact/js/hosted (engine host, transports, campaign, boot)
//   <outDir>/engine/*.js         server/engine.js and its browser-safe import graph
//   <outDir>/pack.json           the pack, normalized and serialized (no images/audio yet)
//   <outDir>/capabilities.json   the capabilities object to declare when publishing
// Prints the publish file map and the capabilities object.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackFiles } from '../server/pack.js';
import { normalizePack, serializePack } from '../server/engine.js';
import { checkIsomorphic } from '../server/check-isomorphic.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CAPABILITIES = {
  db: {
    rules: [
      { path: '', read: 'owner', write: 'owner' },
      { path: 'public', read: 'view', write: 'owner' },
      { path: 'pv', read: 'owner', write: 'owner' },
      { path: 'pv/{self}', read: 'view', write: 'owner' },
      { path: 'data/users/{self}', read: 'view', write: 'interact' },
    ],
  },
  room: {},
  user: { scopes: ['profile'] },
  sample: {},
};

const fail = (msg) => { console.error(`build_artifact: ${msg}`); process.exit(1); };

function copy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

/** The <body> inner HTML of a web page, minus its own module script tag. */
function pageBody(file) {
  const html = fs.readFileSync(file, 'utf8');
  const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  if (!m) fail(`no <body> in ${file}`);
  return m[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').trim();
}

export function build(packDir, outDir) {
  const out = path.resolve(outDir);
  if (out === ROOT || out.startsWith(path.join(ROOT, 'web')) || out.startsWith(path.join(ROOT, 'server'))) fail('refusing to write into the source tree');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  // Pack: same loader rules as the Node server; images and audio are not shipped (placeholders + TTS).
  const { raw } = readPackFiles(packDir);
  const { pack, warnings } = normalizePack(raw, { assetExists: () => false });
  for (const w of warnings) if (!/not found/.test(w)) console.warn(`[pack] ${w}`);
  const ser = serializePack(pack);
  for (const it of ser.items) it.image = null;
  for (const q of ser.quips) { q.audio = null; q.audioByVoice = {}; }
  fs.writeFileSync(path.join(out, 'pack.json'), JSON.stringify(ser));

  // Engine: everything reachable from server/engine.js, verified browser-safe.
  const engineEntry = path.join(ROOT, 'server', 'engine.js');
  const { files, problems } = checkIsomorphic(engineEntry);
  if (problems.length) fail(`engine is not browser-safe: ${problems.map((p) => `${path.basename(p.file)} -> ${p.spec}`).join(', ')}`);
  for (const f of files) copy(f, path.join(out, 'engine', path.relative(path.join(ROOT, 'server'), f)));

  // Web UI shared with the Node edition.
  for (const f of ['base.css', 'gm.css', 'play.css', 'stage.css']) copy(path.join(ROOT, 'web', 'css', f), path.join(out, 'css', f));
  for (const f of ['client.js', 'gm.js', 'play.js', 'stage.js']) copy(path.join(ROOT, 'web', 'js', f), path.join(out, 'js', f));

  // Hosted-only files.
  const art = path.join(ROOT, 'artifact');
  for (const f of fs.readdirSync(path.join(art, 'css'))) copy(path.join(art, 'css', f), path.join(out, 'css', f));
  for (const f of fs.readdirSync(path.join(art, 'js', 'hosted'))) copy(path.join(art, 'js', 'hosted', f), path.join(out, 'js', 'hosted', f));

  // index.html with the three page bodies inlined as templates.
  let index = fs.readFileSync(path.join(art, 'index.html'), 'utf8');
  for (const page of ['gm', 'play', 'stage']) {
    const marker = `<!--TPL:${page}-->`;
    if (!index.includes(marker)) fail(`artifact/index.html lacks ${marker}`);
    index = index.replace(marker, () => pageBody(path.join(ROOT, 'web', `${page}.html`)));
  }
  // The hosted edition never loads the Node pages' /-rooted URLs.
  if (/\s(?:src|href)="\/(?!\/)/.test(index)) console.warn('[build] index.html still has /-rooted URLs; they will 404 in the artifact');
  fs.writeFileSync(path.join(out, 'index.html'), index);
  fs.writeFileSync(path.join(out, 'capabilities.json'), JSON.stringify(CAPABILITIES, null, 2) + '\n');

  // Sanity: every relative import in the copied JS resolves inside outDir.
  const missing = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
          const spec = m[1] || m[2];
          if (!fs.existsSync(path.resolve(path.dirname(p), spec))) missing.push(`${path.relative(out, p)} -> ${spec}`);
        }
      }
    }
  };
  walk(out);
  if (missing.length) fail(`unresolved imports:\n  ${missing.join('\n  ')}`);

  const listed = [];
  const list = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) list(p);
      else if (!['index.html', 'capabilities.json'].includes(path.relative(out, p))) listed.push(path.relative(out, p));
    }
  };
  list(out);
  return { out, pack, files: listed.sort() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [packDir, outDir] = process.argv.slice(2);
  if (!packDir || !outDir) fail('usage: node tools/build_artifact.mjs <packDir> <outDir>');
  const { out, pack, files } = build(packDir, outDir);
  console.log(`Built "${pack.name}" (${pack.achievements.length} achievements, ${pack.items.length} items, ${pack.quips.length} quips) into ${out}`);
  console.log(`\nPublish ${path.join(out, 'index.html')} with these supporting files (published path = source path relative to ${out}):`);
  for (const f of files) console.log(`  ${f}`);
  console.log('\ncapabilities:');
  console.log(JSON.stringify(CAPABILITIES, null, 2));
}
