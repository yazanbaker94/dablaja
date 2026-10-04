// Static consistency check: every elements.X reference must exist as a key
// in the corresponding elements map. Catches dead/unbound DOM wiring.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const surfaces = [
  ['src/library/library.js', 'src/library/library.html'],
  ['src/popup/popup.js', 'src/popup/popup.html'],
  ['src/stats/stats.js', 'src/stats/stats.html'],
  ['src/diagnostics/diagnostics.js', 'src/diagnostics/diagnostics.html']
];

let bad = 0;
for (const [jsRel, htmlRel] of surfaces) {
  const [src, html] = await Promise.all([
    readFile(path.join(root, jsRel), 'utf8'),
    readFile(path.join(root, htmlRel), 'utf8')
  ]);

  const htmlIds = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
  const duplicateIds = [...new Set(htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index))];
  if (duplicateIds.length) {
    bad += duplicateIds.length;
    console.log(`FAIL ${htmlRel}: duplicate ids -> ${duplicateIds.join(', ')}`);
  }

  const htmlIdSet = new Set(htmlIds);
  const referencedIds = new Set([
    ...[...src.matchAll(/\$\(['"]([A-Za-z][\w:-]*)['"]\)/g)].map((match) => match[1]),
    ...[...src.matchAll(/getElementById\(\s*['"]([A-Za-z][\w:-]*)['"]\s*\)/g)].map((match) => match[1]),
    ...[...src.matchAll(/querySelector\(\s*['"]#([A-Za-z][\w:-]*)['"]\s*\)/g)].map((match) => match[1])
  ]);
  const missingDomIds = [...referencedIds].filter((id) => !htmlIdSet.has(id));
  if (missingDomIds.length) {
    bad += missingDomIds.length;
    console.log(`FAIL ${jsRel}: referenced ids missing from ${htmlRel} -> ${missingDomIds.join(', ')}`);
  }

  const mapMatch = src.match(/const elements = \{([\s\S]*?)\n\};/);
  if (mapMatch) {
    const keys = new Set([...mapMatch[1].matchAll(/^\s*([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]));
    const refs = new Set([...src.matchAll(/\belements\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
    const missing = [...refs].filter((r) => !keys.has(r));
    if (missing.length) {
      bad += missing.length;
      console.log(`FAIL ${jsRel}: references without binding -> ${missing.join(', ')}`);
    } else {
      console.log(`ok   ${jsRel}: all element refs bound (${keys.size} keys)`);
    }
  }

  const orphanedControls = [];
  for (const match of html.matchAll(/<(button|input|select|textarea|a)\b([^>]*)>/gi)) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    if (/\btype=["']hidden["']/i.test(attrs)) continue;
    const id = attrs.match(/\bid=["']([^"']+)["']/i)?.[1] || '';
    const href = attrs.match(/\bhref=["']([^"']*)["']/i)?.[1];
    const genericHandler = /\bdata-(?:nav|range|action)=["']/i.test(attrs);
    const nativeLink = tag === 'a' && href && href !== '#';
    if (genericHandler || nativeLink) continue;
    if (!id || !referencedIds.has(id)) {
      orphanedControls.push(id ? `${tag}#${id}` : `${tag}(no id)`);
    }
  }
  if (orphanedControls.length) {
    bad += orphanedControls.length;
    console.log(`FAIL ${htmlRel}: interactive controls without a static or generic handler -> ${orphanedControls.join(', ')}`);
  } else {
    console.log(`ok   ${htmlRel}: ids unique, JS ids exist, and static controls are wired (${htmlIds.length} ids)`);
  }
}
if (bad) process.exit(1);
