// Static consistency check: every elements.X reference must exist as a key
// in the corresponding elements map. Catches dead/unbound DOM wiring.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'src/library/library.js',
  'src/popup/popup.js',
  'src/stats/stats.js',
  'src/sidepanel/sidepanel.js'
];

let bad = 0;
for (const rel of files) {
  const src = await readFile(path.join(root, rel), 'utf8');
  const mapMatch = src.match(/const elements = \{([\s\S]*?)\n\};/);
  if (!mapMatch) continue;
  const keys = new Set([...mapMatch[1].matchAll(/^\s*([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]));
  const refs = new Set([...src.matchAll(/\belements\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  const missing = [...refs].filter((r) => !keys.has(r));
  if (missing.length) {
    bad += missing.length;
    console.log(`FAIL ${rel}: references without binding -> ${missing.join(', ')}`);
  } else {
    console.log(`ok   ${rel}: all element refs bound (${keys.size} keys)`);
  }
}
if (bad) process.exit(1);
