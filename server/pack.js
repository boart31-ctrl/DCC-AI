// Node-side pack loader: reads the pack folder from disk, then validates via pack-core.js.
import fs from 'node:fs';
import path from 'node:path';
import { normalizePack, PackError, LIBRARY_FILES } from './pack-core.js';

export * from './pack-core.js';

function readJson(dir, file) {
  const p = path.join(dir, file);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw new PackError(`cannot read ${p}: ${e.message}`);
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new PackError(`${file}: invalid JSON (${e.message})`);
  }
}

/** Reads the raw JSON files of a pack folder (undefined for missing files). */
export function readPackFiles(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new PackError(`pack folder not found: ${abs}`);
  }
  const raw = {};
  for (const k of ['pack', 'achievements', 'items', 'loot', 'quips', 'chat', 'ruleset', ...LIBRARY_FILES]) raw[k] = readJson(abs, `${k}.json`);
  if (raw.pack === undefined) throw new PackError(`pack.json is missing (looked in ${abs})`);
  return { abs, raw };
}

/** Loads and validates a pack folder. Throws PackError on structural problems. */
export function loadPack(dir, opts = {}) {
  const { abs, raw } = readPackFiles(dir);
  const assetExists = (sub, rel) => {
    try {
      return fs.statSync(path.join(abs, sub, rel)).isFile();
    } catch {
      return false;
    }
  };
  return normalizePack(raw, { assetExists, baseUrl: opts.baseUrl, dir: abs });
}
