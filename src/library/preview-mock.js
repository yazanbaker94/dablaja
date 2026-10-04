// Preview-only shim: mocks the chrome.* APIs the session library page needs
// so it can run over plain http:// for design iteration. Only preview.html
// loads it; library.html (the page the extension opens) never does.

(() => {
  const STORAGE_KEY = 'dablaja-preview-store';

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

  if (!persisted.siteProfiles) persisted.siteProfiles = [];
  if (!persisted.extSettings) {
    persisted.extSettings = {
      originalVolume: 0.25,
      dubbedVolume: 1.0,
      autoDucking: true,
      uiLanguage: 'ar'
    };
  }
  if (!persisted.librarySettings) {
    persisted.librarySettings = {
      rememberVolumes: true,
      localSavingEnabled: true
    };
  }
  if (typeof persisted.librarySettings.localSavingEnabled !== 'boolean') persisted.librarySettings.localSavingEnabled = true;
  // Drop fields from older preview stores that the worker no longer returns.
  delete persisted.librarySettings.entitlement;
  delete persisted.extSettings.analyticsConsent;
  delete persisted.librarySettings.autosave;
  delete persisted.privacyConsentAt;

  if (!persisted.geminiApiKey) persisted.geminiApiKey = 'AIzaSyMockKeyForTesting12345';

  const extSettings = persisted.extSettings;
  const status = {
    ok: true,
    get librarySettings() {
      return {
        ...persisted.librarySettings,
        siteProfiles: persisted.siteProfiles
      };
    },
    draft: null,
    storageWarning: null
  };
  // Test/inspection hooks (preview only).
  window.__previewStatus = status;
  window.__previewMessages = [];

  const localStorageArea = makeArea(persisted);
  const sessionStorageArea = makeArea(sessionStore);

  window.chrome = {
    storage: {
      local: localStorageArea,
      session: sessionStorageArea
    },
    tabs: {
      query: () => Promise.resolve([{ id: 1, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'YouTube Video' }]),
      create: (props) => Promise.resolve({ id: 99, url: props?.url })
    },
    tabCapture: {
      getMediaStreamId: () => Promise.resolve('mock-tab-stream-id')
    },
    runtime: {
      lastError: null,
      sendMessage: (message) => {
        window.__previewMessages.push(message);
        if (message && message.type === 'GET_STATE') {
          return Promise.resolve({
            ok: true,
            state: { status: persisted.dubbingStatus || 'stopped' },
            settings: { ...extSettings, hasKey: true },
            librarySettings: status.librarySettings
          });
        }
        if (message && message.type === 'START_SESSION') {
          persisted.dubbingStatus = 'translating';
          persist();
          return Promise.resolve({ ok: true, state: { status: 'translating' } });
        }
        if (message && message.type === 'STOP_SESSION') {
          persisted.dubbingStatus = 'stopped';
          persist();
          return Promise.resolve({ ok: true, state: { status: 'stopped' } });
        }
        if (message && message.type === 'SET_VOLUME') {
          if (message.kind === 'original') extSettings.originalVolume = Number(message.value) || 0.25;
          if (message.kind === 'dubbed') extSettings.dubbedVolume = Number(message.value) || 1.0;
          if (message.origin && persisted.librarySettings.rememberVolumes) {
            const existing = persisted.siteProfiles.find((p) => p.origin === message.origin);
            const record = {
              origin: message.origin,
              originalVolume: message.kind === 'original' ? (Number(message.value) || 0.25) : (existing?.originalVolume ?? 0.25),
              dubbedVolume: message.kind === 'dubbed' ? (Number(message.value) || 1.0) : (existing?.dubbedVolume ?? 1.0),
              updatedAt: Date.now()
            };
            persisted.siteProfiles = existing
              ? persisted.siteProfiles.map((p) => (p.origin === message.origin ? record : p))
              : [...persisted.siteProfiles, record];
            persist();
            status.librarySettings.siteProfiles = persisted.siteProfiles;
          }
          persist();
          return Promise.resolve({ ok: true, value: message.value, librarySettings: status.librarySettings });
        }
        if (message && message.type === 'SET_AUTO_DUCKING') {
          extSettings.autoDucking = message.enabled === true;
          persist();
          return Promise.resolve({ ok: true, value: extSettings.autoDucking });
        }
        if (message && message.type === 'LIBRARY_GET_STATUS') return Promise.resolve({ ...status });
        if (message && message.type === 'LIBRARY_SET_LOCAL_SAVING') {
          persisted.librarySettings.localSavingEnabled = message.value === true;
          persist();
          return Promise.resolve({ ok: true, librarySettings: status.librarySettings });
        }
        if (message && message.type === 'LIBRARY_SET_REMEMBER_VOLUMES') {
          persisted.librarySettings.rememberVolumes = message.value === true;
          persist();
          return Promise.resolve({ ok: true, librarySettings: status.librarySettings });
        }
        if (message && message.type === 'LIBRARY_DELETE_SITE_PROFILE') {
          persisted.siteProfiles = persisted.siteProfiles.filter((p) => p.origin !== message.origin);
          persist();
          return Promise.resolve({ ok: true, librarySettings: status.librarySettings });
        }
        if (message && message.type === 'LIBRARY_UPDATE_SITE_PROFILE') {
          const existing = persisted.siteProfiles.find((p) => p.origin === message.origin);
          const record = {
            origin: message.origin,
            originalVolume: message.originalVolume ?? existing?.originalVolume ?? null,
            dubbedVolume: message.dubbedVolume ?? existing?.dubbedVolume ?? null,
            updatedAt: Date.now()
          };
          persisted.siteProfiles = existing
            ? persisted.siteProfiles.map((p) => (p.origin === message.origin ? record : p))
            : [...persisted.siteProfiles, record];
          persist();
          return Promise.resolve({ ok: true, librarySettings: status.librarySettings });
        }
        return Promise.resolve({ ok: true });
      },
      onMessage: { addListener() {}, removeListener() {} },
      getURL: (path) => new URL(path.replace(/^\//, ''), '../../').href
    }
  };

  // Local visual-QA fixture. It runs only when the explicit query parameter is
  // present and seeds two saved sessions, two site profiles and bookmarks so
  // the populated library can be checked without touching a user's real
  // extension data.
  if (new URLSearchParams(location.search).get('qa') === 'sample'
      && new URLSearchParams(location.search).get('seeded') !== '1') {
    const now = Date.now();
    persisted.librarySettings = {
      ...persisted.librarySettings,
      rememberVolumes: true,
      localSavingEnabled: true
    };
    persisted.siteProfiles = [
      {
        origin: 'youtube.com',
        originalVolume: 0.25,
        dubbedVolume: 1,
        updatedAt: now
      },
      {
        origin: 'ted.com',
        originalVolume: 0.2,
        dubbedVolume: 0.95,
        updatedAt: now - 1000
      }
    ];
    persist();

    const request = indexedDB.open('dablaja-plus', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('sessions')) {
        const store = db.createObjectStore('sessions', { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('sessions', 'readwrite');
      const store = tx.objectStore('sessions');
      store.clear();
      store.put({
        schemaVersion: 1,
        id: 'plussession_previewqa1',
        title: 'Inside the Mind of a Master Procrastinator',
        pageUrl: 'https://www.youtube.com/watch?v=arj7oStGLkU',
        siteOrigin: 'youtube.com',
        saveRequested: true,
        truncated: false,
        createdAt: now - 600000,
        updatedAt: now,
        startedAt: now - 600000,
        endedAt: now,
        durationMs: 600000,
        sourceSegments: [{
          id: 'seg_1',
          startMs: 0,
          endMs: 4000,
          text: 'The instant gratification monkey takes over.',
          speaker: '',
          turnId: ''
        }],
        targetSegments: [{
          id: 'seg_1',
          startMs: 0,
          endMs: 4000,
          text: 'يتولى قرد الإشباع الفوري زمام الأمور.',
          speaker: '',
          turnId: ''
        }],
        bookmarks: [{
          id: 'bmk_1',
          atMs: 120000,
          note: 'لحظة مهمة',
          createdAt: now,
          updatedAt: now
        }],
        bookmarkTombstones: {},
        notes: '',
        notesUpdatedAt: 0,
        originalVolume: 0.25,
        dubbedVolume: 1
      });
      store.put({
        schemaVersion: 1,
        id: 'plussession_previewqa2',
        title: 'جلسة دبلجة إضافية محفوظة',
        pageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        siteOrigin: 'youtube.com',
        saveRequested: true,
        truncated: false,
        createdAt: now - 1200000,
        updatedAt: now - 1000,
        startedAt: now - 1200000,
        endedAt: now - 600000,
        durationMs: 600000,
        sourceSegments: [{
          id: 'seg_2',
          startMs: 0,
          endMs: 4000,
          text: 'This is another genuinely saved local session.',
          speaker: '',
          turnId: ''
        }],
        targetSegments: [{
          id: 'seg_2',
          startMs: 0,
          endMs: 4000,
          text: 'هذه جلسة محلية إضافية محفوظة فعلياً.',
          speaker: '',
          turnId: ''
        }],
        bookmarks: [{
          id: 'bmk_2',
          atMs: 180000,
          note: 'لحظة إضافية محفوظة',
          createdAt: now - 1000,
          updatedAt: now - 1000
        }],
        bookmarkTombstones: {},
        notes: '',
        notesUpdatedAt: 0,
        originalVolume: 0.2,
        dubbedVolume: 0.95
      });
      tx.oncomplete = () => {
        db.close();
        const next = new URL(location.href);
        next.searchParams.set('seeded', '1');
        location.replace(next.href);
      };
    };
  }
})();
