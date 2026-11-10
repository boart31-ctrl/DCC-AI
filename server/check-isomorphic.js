// Fails (exit 1) if any module reachable from server/engine.js imports a Node-only module.
// Usage: node server/check-isomorphic.js [entry]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FORBIDDEN = /^(node:|fs$|fs\/|path$|os$|crypto$|http$|https$|net$|url$|child_process$|worker_threads$|ws$|qrcode$)/;
const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s*(?:[\w*{}\s,$]+\s*from\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Returns { files: [...visited], problems: [{ file, spec }] }. */
export function checkIsomorphic(entry) {
  const seen = new Set();
  const problems = [];
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith('.')) {
        if (!spec.endsWith('.json')) visit(path.resolve(path.dirname(file), spec)); // JSON data modules have no imports
      }
      else if (FORBIDDEN.test(spec)) problems.push({ file, spec });
      else problems.push({ file, spec, note: 'bare package import (not available in the browser build)' });
    }
  };
  visit(path.resolve(entry));
  return { files: [...seen], problems };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const { files, problems } = checkIsomorphic(process.argv[2] ?? path.join(here, 'engine.js'));
  for (const p of problems) console.error(`NOT BROWSER-SAFE: ${path.relative(process.cwd(), p.file)} imports "${p.spec}"`);
  if (problems.length) process.exit(1);
  console.log(`ok: ${files.length} modules reachable from engine.js, no Node-only imports`);
}
