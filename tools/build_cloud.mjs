#!/usr/bin/env node
// Builds the Cloudflare edition into a folder that `wrangler deploy` / `wrangler dev` can use as-is.
//
//   node tools/build_cloud.mjs <packDir> <outDir> [--name the-system]
//
// Works from a checkout of this repo and from node_modules/the-system (the private content repo
// installs this package from GitHub and runs this script at build time). Only Node built-ins are used.
//
// Output:
//   <outDir>/assets/                  Workers Static Assets: web/ (pages, css, js, fonts, icons, PWA files)
//                                     + pack images/audio under assets/pack/ (raw pack JSON is NOT served)
//   <outDir>/worker/cloud/worker.js   Worker entry + Durable Object class Campaign
//   <outDir>/worker/cloud/pack.json   the pack, normalized + serialized, compiled into the worker
//   <outDir>/worker/server/*.js       the isomorphic engine + host (browser-safe import graph)
//   <outDir>/worker/web/js/qr.js      QR encoder used by /qr
//   <outDir>/wrangler.jsonc           ready config (paths relative to <outDir>)
//   <outDir>/build-info.json          what was built
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPack } from '../server/pack.js';
import { serializePack } from '../server/pack-core.js';
import { checkIsomorphic } from '../server/check-isomorphic.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA = /\.(webp|png|jpe?g|gif|svg|avif|mp3|ogg|oga|wav|m4a|webm)$/i;
const MAX_ASSET = 25 * 1024 * 1024; // Workers Static Assets per-file limit

export const COMPATIBILITY_DATE = '2026-01-01';

/** wrangler config; `prefix` is the path from the config file to the build folder ('' or 'dist/'). */
export function wranglerConfig({ name = 'the-system', prefix = '' } = {}) {
  return {
    name,
    main: `${prefix}worker/cloud/worker.js`,
    compatibility_date: COMPATIBILITY_DATE,
    assets: {
      directory: `${prefix}assets`,
      binding: 'ASSETS',
      run_worker_first: true,
      html_handling: 'none',
      not_found_handling: 'none',
    },
    durable_objects: { bindings: [{ name: 'CAMPAIGNS', class_name: 'Campaign' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Campaign'] }],
    vars: { CAMPAIGN: 'main' },
    // Off on purpose: request logs would contain the personal player links (/p/<token>).
    observability: { enabled: false },
  };
}

const fail = (msg) => {
  throw new Error(`build_cloud: ${msg}`);
};

function copy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyTree(src, dst, filter = () => true) {
  if (!fs.existsSync(src)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) n += copyTree(s, d, filter);
    else if (e.isFile() && filter(s)) {
      if (fs.statSync(s).size > MAX_ASSET) {
        console.warn(`[assets] skipped ${s}: larger than 25 MiB`);
        continue;
      }
      copy(s, d);
      n++;
    }
  }
  return n;
}

export function build(packDir, outDir, { name = 'the-system', log = console } = {}) {
  const out = path.resolve(outDir);
  if (out === ROOT || ROOT.startsWith(out + path.sep)) fail(`refusing to replace ${out}`);
  for (const src of ['web', 'server', 'cloud', 'tools', 'packs', 'docs', 'node_modules'].map((d) => path.join(ROOT, d))) {
    if (out === src || out.startsWith(src + path.sep)) fail(`refusing to write into the source tree (${out})`);
  }
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  // ---- pack: same loader + validation as the Node server ----
  const { pack, warnings } = loadPack(packDir);
  const missing = warnings.filter((w) => /not found/.test(w));
  for (const w of warnings) if (!missing.includes(w)) log.warn(`[pack] ${w}`);
  if (missing.length) log.warn(`[pack] ${missing.length} image/audio files not found yet (placeholders used)`);
  const worker = path.join(out, 'worker');
  fs.mkdirSync(path.join(worker, 'cloud'), { recursive: true });
  fs.writeFileSync(path.join(worker, 'cloud', 'pack.json'), JSON.stringify(serializePack(pack)));

  // ---- worker: entry + everything it imports (must be browser-safe apart from cloudflare:workers) ----
  const entry = path.join(ROOT, 'cloud', 'worker.js');
  const { files, problems } = checkIsomorphic(entry);
  const real = problems.filter((p) => p.spec !== 'cloudflare:workers');
  if (real.length) fail(`worker imports are not Workers-safe: ${real.map((p) => `${path.relative(ROOT, p.file)} -> ${p.spec}`).join(', ')}`);
  for (const f of files) copy(f, path.join(worker, path.relative(ROOT, f)));

  // ---- static assets ----
  const assets = path.join(out, 'assets');
  const webCount = copyTree(path.join(ROOT, 'web'), assets);
  let packCount = 0;
  for (const sub of ['images', 'audio']) {
    packCount += copyTree(path.join(pack.dir, sub), path.join(assets, 'pack', sub), (f) => MEDIA.test(f) && !f.includes(`${path.sep}raw${path.sep}`));
  }

  // ---- config + info ----
  fs.writeFileSync(path.join(out, 'wrangler.jsonc'), `// Generated by tools/build_cloud.mjs — do not edit, rebuild instead.\n${JSON.stringify(wranglerConfig({ name }), null, 2)}\n`);
  let version = '0.0.0';
  try {
    version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {}
  const info = { builtAt: new Date().toISOString(), engine: version, pack: { id: pack.id, name: pack.name, version: pack.version }, files: { web: webCount, pack: packCount, worker: files.length } };
  fs.writeFileSync(path.join(out, 'build-info.json'), JSON.stringify(info, null, 2));
  log.log(`build_cloud: ${pack.name} ${pack.version} → ${out} (${webCount} web files, ${packCount} pack media files, ${files.length} worker modules)`);
  return info;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const ni = args.indexOf('--name');
  const name = ni >= 0 ? args.splice(ni, 2)[1] : undefined;
  const [packDir, outDir] = args;
  if (!packDir || !outDir) {
    console.error('usage: node tools/build_cloud.mjs <packDir> <outDir> [--name worker-name]');
    process.exit(2);
  }
  try {
    build(path.resolve(packDir), path.resolve(outDir), { name });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
