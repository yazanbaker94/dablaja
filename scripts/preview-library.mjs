// Headless visual check for the dablaja Plus library page.
// Loads the packaged extension from dist/dablaja, finds its service-worker
// target to learn the extension id, opens library.html, optionally seeds
// demo sessions into IndexedDB, and captures screenshots.
//
// Usage: node scripts/preview-library.mjs [--seed] [--width=1440] [--height=900]
//         node scripts/preview-library.mjs --seed --width=390 --height=844 --out=mobile

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const match = args.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : fallback;
};

const width = Number(opt('width', 1440));
const height = Number(opt('height', 900));
const seed = flag('seed');
const outDir = opt('out', `preview-${width}`);
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const extensionPath = path.resolve(import.meta.dirname, '..', 'dist', 'dablaja');
const profileDir = path.join(tmpdir(), `dablaja-preview-${Date.now()}`);
const port = 9333 + Math.floor(Math.random() * 500);

mkdirSync(outDir, { recursive: true });

const chrome = spawn(chromePath, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--disable-extensions-except=${extensionPath}`,
  `--load-extension=${extensionPath}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--hide-scrollbars',
  'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 15000, label = 'condition') {
  const start = Date.now();
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await sleep(300);
  }
}

async function jsonList() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params = {}, sessionId) {
        const id = ++seq;
        return new Promise((res, rej) => {
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      },
      close: () => ws.close()
    });
    ws.onerror = () => reject(new Error('WebSocket connect failed'));
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) rej(new Error(message.error.message));
        else res(message.result);
      }
    };
  });
}

// --- Seed data (visual verification only, throwaway profile) ---------------
const SEED_EXPRESSION = `
(async () => {
  const now = Date.now();
  const seg = (start, end, text) => ({ id: 'seg_' + start + '_' + Math.random().toString(36).slice(2, 7), startMs: start, endMs: end, text, speaker: '', turnId: null });
  const mk = (over) => Object.assign({
    schemaVersion: 1,
    id: 'plussession_' + Math.random().toString(36).slice(2, 12),
    title: 'جلسة',
    pageUrl: '',
    siteOrigin: '',
    saveRequested: true,
    truncated: false,
    createdAt: now, updatedAt: now, startedAt: now, endedAt: null,
    durationMs: 0, sourceSegments: [], targetSegments: [],
    bookmarks: [], notes: '', originalVolume: null, dubbedVolume: null
  }, over);
  const sessions = [
    mk({
      title: 'The Solar System Explained — Space Documentary',
      siteOrigin: 'www.youtube.com',
      pageUrl: 'https://www.youtube.com/watch?v=demo1',
      durationMs: 3135000,
      updatedAt: now - 3600e3,
      sourceSegments: [seg(0, 15000, 'Our solar system began four and a half billion years ago.'), seg(15000, 42000, 'Gravity pulled dust and gas into the sun and the planets.'), seg(1180000, 1210000, 'Mars once had rivers and lakes on its surface.')],
      targetSegments: [seg(0, 15000, 'بدأ نظامنا الشمسي قبل أربعة مليارات ونصف المليار سنة.'), seg(15000, 42000, 'جذبت الجاذبية الغبار والغاز لتشكّل الشمس والكواكب.'), seg(1180000, 1210000, 'كان على المريخ أنهار وبحيرات في الماضي.')],
      bookmarks: [
        { id: 'bmk_a1', atMs: 1185000, note: 'قسم المريخ والأنهار القديمة', createdAt: now - 3600e3 },
        { id: 'bmk_a2', atMs: 2400000, note: 'حجم الأرض مقارنة بالمشتري', createdAt: now - 3400e3 }
      ],
      notes: 'أفضل وثائقي عن الكواكب — أكمل الباقي نهاية الأسبوع.'
    }),
    mk({
      title: 'Machine Learning Week 3 — Gradient Descent in Practice',
      siteOrigin: 'www.coursera.org',
      pageUrl: 'https://www.coursera.org/learn/machine-learning',
      durationMs: 1110000,
      updatedAt: now - 26 * 3600e3,
      sourceSegments: [seg(0, 20000, 'Learning rate controls how fast we move down the gradient.'), seg(900000, 940000, 'Feature scaling speeds up convergence dramatically.')],
      targetSegments: [seg(0, 20000, 'معدل التعلم يحدد سرعة التحرك نحو الحد الأدنى.'), seg(900000, 940000, 'تحجيم الخصائص يسرّع الوصول إلى التقارب بشكل كبير.')],
      bookmarks: [{ id: 'bmk_b1', atMs: 905000, note: 'مثال feature scaling', createdAt: now - 26 * 3600e3 }]
    }),
    mk({
      title: 'Lex Fridman Podcast #412 — Andrew Ng on the Future of AI',
      siteOrigin: 'open.spotify.com',
      pageUrl: 'https://open.spotify.com/episode/demo3',
      durationMs: 6300000,
      updatedAt: now - 2 * 864e5,
      sourceSegments: [seg(0, 30000, 'Welcome to the podcast, Andrew.'), seg(1800000, 1900000, 'Education will be transformed by large language models.')],
      targetSegments: [seg(0, 30000, 'أهلاً بك في البودكاست يا أندرو.'), seg(1800000, 1900000, 'ستتغير التعليم بفعل النماذج اللغوية الكبيرة.')],
      bookmarks: []
    }),
    mk({
      title: 'شرح الجافاسكربت للمبتدئين — الكورس الكامل',
      siteOrigin: 'www.youtube.com',
      pageUrl: 'https://www.youtube.com/watch?v=demo4',
      durationMs: 10800000,
      updatedAt: now - 4 * 864e5,
      sourceSegments: [seg(0, 25000, 'Variables let us store values in memory.'), seg(380000, 420000, 'Functions are reusable blocks of code.')],
      targetSegments: [seg(0, 25000, 'المتغيرات تتيح لنا تخزين القيم في الذاكرة.'), seg(380000, 420000, 'الدوال كتل قابلة لإعادة الاستخدام من الكود.')],
      bookmarks: [{ id: 'bmk_c1', atMs: 385000, note: 'شرح الدوال — أعد المشاهدة', createdAt: now - 4 * 864e5 }]
    }),
    mk({
      title: 'Vimeo Staff Picks: Animated Short Film',
      siteOrigin: 'vimeo.com',
      pageUrl: 'https://vimeo.com/demo5',
      durationMs: 480000,
      updatedAt: now - 8 * 864e5,
      sourceSegments: [seg(0, 12000, 'A quiet morning in the city.'), seg(300000, 360000, 'The film ends with a journey to the sea.')],
      targetSegments: [seg(0, 12000, 'صباح هادئ في المدينة.'), seg(300000, 360000, 'ينتهي الفيلم برحلة إلى البحر.')],
      bookmarks: []
    }),
    mk({
      title: 'Introduction to Algebra — Khan Academy',
      siteOrigin: 'www.khanacademy.org',
      pageUrl: 'https://www.khanacademy.org/math/algebra',
      durationMs: 855000,
      updatedAt: now - 15 * 864e5,
      sourceSegments: [seg(0, 18000, 'An equation is a statement that two expressions are equal.'), seg(700000, 740000, 'Practice makes the rules feel natural.')],
      targetSegments: [seg(0, 18000, 'المعادلة عبارة عن أن مقدارين متساويان.'), seg(700000, 740000, 'الممارسة تجعل القواعد طبيعية.')],
      bookmarks: [{ id: 'bmk_d1', atMs: 5000, note: 'تعريف المعادلة', createdAt: now - 15 * 864e5 }]
    })
  ];
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('dablaja-plus', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('sessions', { keyPath: 'id' });
      store.createIndex('updatedAt', 'updatedAt');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite');
    for (const record of sessions) tx.objectStore('sessions').put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return 'seeded ' + sessions.length;
})()
`;

try {
  // 1. Wait for DevTools + discover the extension id from its service worker.
  const targets = await waitFor(async () => {
    const list = await jsonList();
    return list.find((target) => target.url.startsWith('chrome-extension://') && target.url.includes('service-worker'))
      ? list
      : null;
  }, 20000, 'extension service worker target');
  const extensionId = targets
    .find((target) => target.url.startsWith('chrome-extension://') && target.url.includes('service-worker'))
    .url.split('/')[2];
  console.log('extension id:', extensionId);

  // 2. Open the library page in a new tab.
  const created = await fetch(`http://127.0.0.1:${port}/json/new?chrome-extension://${extensionId}/src/library/library.html`, { method: 'PUT' }).then((r) => r.json());
  const cdp = await connect(created.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });
  await sleep(2500);

  if (seed) {
    const seeded = await cdp.send('Runtime.evaluate', { expression: SEED_EXPRESSION, awaitPromise: true, returnByValue: true });
    console.log('seed:', seeded.result.value);
    await cdp.send('Page.reload');
    await sleep(2500);
  }

  // 3. Screenshot the initial view.
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !seed });
  writeFileSync(path.join(outDir, `library-${width}.png`), Buffer.from(shot.data, 'base64'));
  console.log('saved', path.join(outDir, `library-${width}.png`));

  if (seed) {
    // 4. Also capture the full page (scrolled content) and moments view.
    const full = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(path.join(outDir, `library-${width}-full.png`), Buffer.from(full.data, 'base64'));

    await cdp.send('Runtime.evaluate', { expression: `document.querySelector('[data-nav=moments]').click()` });
    await sleep(600);
    const moments = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(outDir, `moments-${width}.png`), Buffer.from(moments.data, 'base64'));

    await cdp.send('Runtime.evaluate', { expression: `document.querySelector('[data-nav=backup]').click()` });
    await sleep(600);
    const backup = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(outDir, `backup-${width}.png`), Buffer.from(backup.data, 'base64'));

    await cdp.send('Runtime.evaluate', { expression: `document.querySelector('.session-card .primary-button').click()` });
    await sleep(1200);
    const detail = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(outDir, `detail-${width}.png`), Buffer.from(detail.data, 'base64'));

    // Layout sanity: no horizontal overflow.
    const overflow = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth})',
      returnByValue: true
    });
    console.log('overflow check:', overflow.result.value);
    console.log('saved moments/backup/detail captures');
  }

  cdp.close();
} finally {
  chrome.kill();
}
