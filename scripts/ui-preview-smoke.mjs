import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// Use temporary directories outside repo
const tmpOut = await mkdtemp(path.join(tmpdir(), 'dablaja-smoke-'));
const tmpPreviewDir = await mkdtemp(path.join(tmpdir(), 'dablaja-preview-'));
const chromeProfileDir = await mkdtemp(path.join(tmpdir(), 'dablaja-chrome-'));

let server;
let chromeProc;
let httpPort = 0;
let debugPort = 0;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

try {
  httpPort = await getFreePort();
  debugPort = await getFreePort();
  // Prepare preview in temp dir, do not write to src/
  const html = await readFile(path.join(root, 'src/library/library.html'), 'utf8');
  const injected = html.replace(
    '<script type="module" src="library.js"></script>',
    '<script src="preview-mock.js"></script>\n    <script type="module" src="library.js"></script>'
  );
  await writeFile(path.join(tmpPreviewDir, 'preview.html'), injected, 'utf8');
  // Also copy needed assets? For smoke we just serve root via http
  server = createServer(async (req, res) => {
    // Simple static serve from root and tmpPreviewDir
    let filePath = req.url.split('?')[0].replace(/^\//, '');
    if (filePath === 'preview.html' || filePath === 'src/library/preview.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(injected);
      return;
    }
    // Fallback to root file
    try {
      const full = path.join(root, filePath);
      const data = await readFile(full);
      const ext = path.extname(full);
      const ct = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ct });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(httpPort, '127.0.0.1', resolve));
  console.log(`UI preview smoke: HTTP on ${httpPort}, Chrome debug on ${debugPort} (temp dirs)`);
  // Launch Chrome with temp profile outside repo
  chromeProc = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${chromeProfileDir}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check'
  ], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2000));
  // Get debugger URL without logging it
  const versionRes = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
  const versionJson = await versionRes.json();
  const wsUrl = versionJson.webSocketDebuggerUrl;
  // Not logging wsUrl for privacy
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve) => (ws.onopen = resolve));
  let idCounter = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(msg.error);
      else resolve(msg.result);
    }
  };
  function send(method, params = {}, sessionId) {
    const id = idCounter++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
    });
  }
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false
  }, sessionId);
  // Keep the real /src/library/ directory URL so every relative stylesheet,
  // script, and image resolves exactly as it does in the extension.
  await send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/src/library/preview.html` }, sessionId);
  await new Promise((r) => setTimeout(r, 1500));
  const evalRes = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId);
  console.log('Smoke preview title:', evalRes.result?.value);
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  // Write screenshot to ignored artifact dir (tmpOut)
  const outPath = path.join(tmpOut, 'library-desktop.png');
  const { writeFile: writeBin } = await import('node:fs/promises');
  await writeBin(outPath, Buffer.from(shot.data, 'base64'));
  console.log(`Desktop screenshot saved to ${outPath} (ignored)`);

  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true
  }, sessionId);
  await send('Page.reload', { ignoreCache: true }, sessionId);
  await new Promise((r) => setTimeout(r, 1000));
  const mobileShot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const mobilePath = path.join(tmpOut, 'library-mobile.png');
  await writeBin(mobilePath, Buffer.from(mobileShot.data, 'base64'));
  console.log(`Mobile screenshot saved to ${mobilePath} (ignored)`);
  ws.close();
  console.log('UI preview smoke test completed successfully');
} finally {
  try { if (server) server.close(); } catch {}
  try { if (chromeProc) chromeProc.kill(); } catch {}
  try { await rm(tmpPreviewDir, { recursive: true, force: true }); } catch {}
  // Keep tmpOut for artifact inspection but it's outside repo and ignored
  try { await rm(chromeProfileDir, { recursive: true, force: true }); } catch {}
}
