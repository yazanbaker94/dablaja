// Preview-only shim: mocks the chrome.* APIs the Plus library page needs so it
// can run over plain http:// for design iteration. Never shipped — excluded
// from the packaged extension by scripts/package.ps1 (dist copies only
// library.html/library.css/library.js/assets).

(() => {
  const STORAGE_KEY = 'dablaja-preview-store';
  const SEED_FLAG = 'dablaja-preview-seeded-v6';

  const persisted = (() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
    catch { return {}; }
  })();
  const sessionStore = {};
  const persist = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted)); } catch {} };

  function areaGet(store, keys) {
    if (keys === null || keys === undefined) return { ...store };
    if (typeof keys === 'string') return keys in store ? { [keys]: store[keys] } : {};
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) if (k in store) out[k] = store[k];
      return out;
    }
    const out = {};
    for (const k of Object.keys(keys || {})) out[k] = k in store ? store[k] : keys[k];
    return out;
  }

  const makeArea = (store) => ({
    get(keys, callback) {
      const result = areaGet(store, keys);
      if (typeof callback === 'function') setTimeout(() => callback(result), 0);
      return Promise.resolve(result);
    },
    set(items, callback) {
      Object.assign(store, items || {});
      persist();
      if (typeof callback === 'function') setTimeout(callback, 0);
      return Promise.resolve();
    },
    remove(keys, callback) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      persist();
      if (typeof callback === 'function') setTimeout(callback, 0);
      return Promise.resolve();
    },
    clear(callback) {
      for (const k of Object.keys(store)) delete store[k];
      persist();
      if (typeof callback === 'function') setTimeout(callback, 0);
      return Promise.resolve();
    }
  });

  const status = {
    ok: true,
    plus: {
      entitlement: {
        plusEnabled: true,
        state: 'active',
        label: 'مفعّل على هذا الجهاز'
      },
      settings: {
        autosave: true,
        rememberVolumes: true
      },
      siteProfiles: {
        'www.youtube.com': { origin: 'www.youtube.com', originalVolume: 20, dubbedVolume: 110, updatedAt: Date.now() - 36e5 },
        'open.spotify.com': { origin: 'open.spotify.com', originalVolume: 35, dubbedVolume: 100, updatedAt: Date.now() - 9e7 }
      }
    },
    draft: null,
    storageWarning: null
  };

  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message) => {
        if (message && message.type === 'PLUS_GET_STATUS') return Promise.resolve({ ...status });
        if (message && message.type === 'PLUS_SET_AUTOSAVE') {
          status.plus.settings.autosave = message.value;
          return Promise.resolve({ ok: true });
        }
        if (message && message.type === 'PLUS_SET_REMEMBER_VOLUMES') {
          status.plus.settings.rememberVolumes = message.value;
          return Promise.resolve({ ok: true });
        }
        if (message && message.type === 'PLUS_DELETE_SITE_PROFILE') {
          delete status.plus.siteProfiles[message.origin];
          return Promise.resolve({ ok: true });
        }
        return Promise.resolve({ ok: true });
      },
      onMessage: { addListener() {}, removeListener() {} },
      getURL: (path) => new URL(path.replace(/^\//, ''), '../../').href
    },
    storage: {
      local: makeArea(persisted),
      session: makeArea(sessionStore),
      sync: makeArea({})
    },
    tabs: { create: ({ url }) => { try { window.open(url, '_blank'); } catch {} return Promise.resolve(); } }
  };

  // ----- Demo data (mirrors the reference design: same shows/sites mix) -----
  const seg = (startMs, durMs, text) => ({
    id: 'seg_' + Math.random().toString(36).slice(2, 9),
    startMs,
    endMs: startMs + durMs,
    text
  });
  const mk = (over) => Object.assign({
    id: 'plussession_demo' + Math.random().toString(36).slice(2, 9),
    schemaVersion: 1,
    title: '', pageUrl: '', siteOrigin: '',
    saveRequested: true, truncated: false,
    createdAt: Date.now(), updatedAt: Date.now(), startedAt: Date.now(), endedAt: null,
    durationMs: 0, sourceSegments: [], targetSegments: [],
    bookmarks: [], notes: '', originalVolume: null, dubbedVolume: null
  }, over);

  const now = Date.now();
  const sessions = [
    mk({
      title: 'ماذا تعرف عن الكواكب خارج المجموعة الشمسية؟',
      siteOrigin: 'www.youtube.com', pageUrl: 'https://www.youtube.com/watch?v=demo1',
      durationMs: 4365000, updatedAt: now - 36e5,
      sourceSegments: [seg(0, 15000, 'Our solar system began four and a half billion years ago.'), seg(15000, 42000, 'Gravity pulled dust and gas into the sun and the planets.'), seg(2280000, 2301000, 'Mars once had rivers and lakes on its surface.')],
      targetSegments: [seg(0, 15000, 'بدأ نظامنا الشمسي قبل أربعة مليارات ونصف المليار سنة.'), seg(15000, 42000, 'جذبت الجاذبية الغبار والغاز لتشكّل الشمس والكواكب.'), seg(2280000, 2301000, 'كان على المريخ أنهار وبحيرات في الماضي.')],
      bookmarks: [
        { id: 'bmk_a1', atMs: 1185000, note: 'قسم المريخ والأنهار القديمة', createdAt: now - 36e5 },
        { id: 'bmk_a2', atMs: 2400000, note: 'حجم الأرض مقارنة بالمشتري', createdAt: now - 34e5 }
      ],
      notes: 'أفضل وثائقي عن الكواكب — أكمل الباقي نهاية الأسبوع.'
    }),
    mk({
      title: 'شرح JavaScript من الصفر للمبتدئين',
      siteOrigin: 'www.youtube.com', pageUrl: 'https://www.youtube.com/watch?v=demo4',
      durationMs: 3378000, updatedAt: now - 864e5,
      sourceSegments: [seg(0, 25000, 'Variables let us store values in memory.'), seg(920000, 947000, 'Functions are reusable blocks of code.')],
      targetSegments: [seg(0, 25000, 'المتغيرات تتيح لنا تخزين القيم في الذاكرة.'), seg(920000, 947000, 'الدوال كتل قابلة لإعادة الاستخدام من الكود.')],
      bookmarks: [{ id: 'bmk_c1', atMs: 385000, note: 'شرح الدوال — أعد المشاهدة', createdAt: now - 4 * 864e5 }]
    }),
    mk({
      title: 'Deep Learning Specialization – Andrew Ng',
      siteOrigin: 'www.coursera.org', pageUrl: 'https://www.coursera.org/learn/machine-learning',
      durationMs: 8133000, updatedAt: now - 2 * 864e5,
      sourceSegments: [seg(0, 20000, 'Learning rate controls how fast we move down the gradient.'), seg(3700000, 3731000, 'Feature scaling speeds up convergence dramatically.')],
      targetSegments: [seg(0, 20000, 'معدل التعلم يحدد سرعة التحرك نحو الحد الأدنى.'), seg(3700000, 3731000, 'تحجيم الخصائص يسرّع الوصول إلى التقارب بشكل كبير.')],
      bookmarks: [{ id: 'bmk_b1', atMs: 905000, note: 'مثال feature scaling', createdAt: now - 26 * 36e5 }]
    }),
    mk({
      title: 'بودكاست فنجان - هل الذكاء الاصطناعي يهدد وظائفنا؟',
      siteOrigin: 'open.spotify.com', pageUrl: 'https://open.spotify.com/episode/demo3',
      durationMs: 2709000, updatedAt: now - 3 * 864e5,
      sourceSegments: [seg(0, 30000, 'Welcome to the podcast.'), seg(720000, 750000, 'Education will be transformed by large language models.')],
      targetSegments: [seg(0, 30000, 'أهلاً بكم في الحلقة الجديدة.'), seg(720000, 750000, 'ستتغير التعليم بفعل النماذج اللغوية الكبيرة.')],
      bookmarks: []
    }),
    mk({
      title: 'مستقبل المدن الذكية',
      siteOrigin: 'www.youtube.com', pageUrl: 'https://www.youtube.com/watch?v=demo6',
      durationMs: 1994000, updatedAt: now - 4 * 864e5,
      sourceSegments: [seg(0, 12000, 'A quiet morning in the city.'), seg(1300000, 1330000, 'Sensors manage traffic in real time.')],
      targetSegments: [seg(0, 12000, 'صباح هادئ في المدينة.'), seg(1300000, 1330000, 'المستشعرات تدير حركة السير لحظياً.')],
      bookmarks: []
    }),
    mk({
      title: 'تعلم التصوير بالموبايل',
      siteOrigin: 'www.youtube.com', pageUrl: 'https://www.youtube.com/watch?v=demo5',
      durationMs: 1124000, updatedAt: now - 5 * 864e5,
      sourceSegments: [seg(0, 18000, 'Composition rules apply to phones too.')],
      targetSegments: [seg(0, 18000, 'قواعد التكوين تنطبق على الجوال أيضاً.')],
      bookmarks: [{ id: 'bmk_d1', atMs: 5000, note: 'قاعدة الأثلاث', createdAt: now - 15 * 864e5 }]
    })
  ];

  function seedAndReload() {
    const request = indexedDB.open('dablaja-plus', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('sessions', { keyPath: 'id' });
      store.createIndex('updatedAt', 'updatedAt');
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('sessions', 'readwrite');
      const store = tx.objectStore('sessions');
      store.clear();
      for (const record of sessions) store.put(record);
      tx.oncomplete = () => { localStorage.setItem(SEED_FLAG, '1'); location.reload(); };
      tx.onerror = () => { localStorage.setItem(SEED_FLAG, '1'); };
    };
    request.onerror = () => { localStorage.setItem(SEED_FLAG, '1'); };
  }

  if (!localStorage.getItem(SEED_FLAG)) seedAndReload();
})();
