import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Gemini tutorial uses the privacy-enhanced YouTube embed inside the page', async () => {
  const html = await readFile(path.join(root, 'landing', 'index.html'), 'utf8');
  assert.match(html, /data-src="https:\/\/www\.youtube-nocookie\.com\/embed\/Uyn-P2nRvDA\?start=14/);
  assert.match(html, /referrerpolicy="strict-origin-when-cross-origin"/);
  assert.doesNotMatch(html, /data-src="https:\/\/www\.youtube\.com\/embed\/Uyn-P2nRvDA/);
});

test('production CSP permits only the required tutorial frame origins plus Cloudflare', async () => {
  const caddy = await readFile(path.join(root, 'server', 'Caddyfile.audiofetcher.production'), 'utf8');
  const cspLine = caddy.split(/\r?\n/).find((line) => line.includes('Content-Security-Policy "default-src')) ?? '';
  assert.match(cspLine, /frame-src https:\/\/challenges\.cloudflare\.com https:\/\/www\.youtube-nocookie\.com https:\/\/www\.youtube\.com;/);
  assert.doesNotMatch(cspLine, /frame-src \*/);
  assert.doesNotMatch(cspLine, /googleusercontent/);
});

test('Caddy deployment refuses a partial site fragment', async () => {
  const deploy = await readFile(path.join(root, 'scripts', 'deploy-dablaja-caddy.sh'), 'utf8');
  assert.match(deploy, /import \/etc\/caddy\/sites\/\*\.caddy/);
  assert.match(deploy, /import rook-origin/);
  assert.match(deploy, /https:\/\/www\.youtube-nocookie\.com/);
  assert.match(deploy, /env_file="\/etc\/rook\/caddy\.env"/);
  assert.match(deploy, /test -n "\$\{ROOK_ORIGIN_TOKEN:-\}"/);
});

test('an open landing dialog locks both root and body scrolling', async () => {
  const css = await readFile(path.join(root, 'landing', 'styles.css'), 'utf8');
  assert.match(css, /html:has\(\.tutorial-dialog\[open\]\)[\s\S]*body:has\(\.tutorial-dialog\[open\]\)[^{]*\{\s*overflow:\s*hidden;/);
});
