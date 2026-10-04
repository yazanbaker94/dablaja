import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sourceRoot = path.join(root, 'src');

async function walk(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await walk(full));
    else results.push(full);
  }
  return results;
}

const files = await walk(sourceRoot);
const jsFiles = files.filter((file) => file.endsWith('.js'));
for (const file of jsFiles) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });

const scanned = [path.join(root, 'manifest.json'), ...files.filter((file) => /\.(js|html|css)$/.test(file))];
const violations = [];
for (const file of scanned) {
  const text = await readFile(file, 'utf8');
  if (/AIza[0-9A-Za-z_-]{30,}/.test(text)) violations.push(`${file}: possible Google API key`);
  if (/\beval\s*\(|new\s+Function\s*\(/.test(text)) violations.push(`${file}: dynamic code execution`);
  if (/console\.(log|debug|info|warn|error)\s*\(/.test(text)) violations.push(`${file}: console output is forbidden`);
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(text)) violations.push(`${file}: inline script`);
  if (/<style\b/i.test(text)) violations.push(`${file}: inline style`);
}

if (violations.length) throw new Error(`Static policy checks failed:\n${violations.join('\n')}`);
process.stdout.write(`Syntax and security checks passed for ${jsFiles.length} JavaScript files.\n`);
