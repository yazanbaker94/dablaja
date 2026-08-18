// Headless preview of the Plus library page over plain http (no extension
// load). Generates src/library/preview.html from library.html with a chrome
// mock injected, serves the repo root, and captures screenshots with Chrome.
//
// Usage: node scripts/preview-plus-http.mjs [--width=1440] [--height=2600] [--out=dir]

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const match = args.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : fallback;
};
const width = Number(opt('width', 1440));
const height = Number(opt('height', 2600));
const outDir = path.resolve(root, opt('out', `preview-plus-${width}`));

// 1. Generate preview.html (library.html + mock script before the module).
const html = readFileSync(path.join(root, 'src', 'library', 'library.html'), 'utf8');
const injected = html.replace(
  '<script type="module" src="library.js"></script>',
  '<script src="preview-mock.js"></script>\n    <script type="module" src="library.js"></script>'
);
if (injected === html) throw new Error('library.js script tag not found');
writeFileSync(path.join(root, 'src', 'library', 'preview.html'), injected);

// 2. Serve repo root.
const port = 8123;
const server = spawn('python', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
  cwd: root, stdio: 'ignore', detached: false
});
await new Promise((r) => setTimeout(r, 1200));

// 3. Screenshot with headless Chrome (tall window captures the whole page).
mkdirSync(outDir, { recursive: true });
const url = `http://127.0.0.1:${port}/src/library/preview.html`;
const shots = [
  { name: 'desktop.png', w: width, h: height },
  { name: 'mobile.png', w: 390, h: 2400 }
];
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
for (const shot of shots) {
  const proc = spawn(chromePath, [
    '--headless=new',
    `--screenshot=${path.join(outDir, shot.name)}`,
    `--window-size=${shot.w},${shot.h}`,
    '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    `--virtual-time-budget=9000`,
    url
  ], { stdio: 'ignore' });
  await new Promise((resolve) => proc.on('exit', resolve));
  console.log('saved', path.join(outDir, shot.name));
}
server.kill();
console.log('done ->', outDir);
