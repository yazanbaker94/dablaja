// Preview-only shim: mocks the chrome.* APIs the Plus library page needs so it
// can run over plain http:// for design iteration. Never shipped — excluded
// from the packaged extension by scripts/package.ps1 (dist copies only
// library.html/library.css/library.js/assets).

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
      analyticsConsent: false
    };
  }
  if (!persisted.plus) {
    persisted.plus = {
      entitlement: {
        plusEnabled: false,
        state: 'free',
        label: 'الخطة المجانية (موقع واحد / جلسة واحدة)'
      },
      rememberVolumes: true,
      localSavingEnabled: true
    };
  }
  if (typeof persisted.plus.localSavingEnabled !== 'boolean') persisted.plus.localSavingEnabled = true;
  if (typeof persisted.extSettings.analyticsConsent !== 'boolean') persisted.extSettings.analyticsConsent = false;
  delete persisted.plus.autosave;
  delete persisted.privacyConsentAt;

  if (!persisted.geminiApiKey) persisted.geminiApiKey = 'AIzaSyMockKeyForTesting12345';

  const extSettings = persisted.extSettings;
  const status = {
    ok: true,
    get plus() {
      return {
        ...persisted.plus,
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
            plus: status.plus
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
        if (message && message.type === 'PLUS_SET_ENTITLEMENT') {
          persisted.plus.entitlement = message.entitlement;
          persist();
          return Promise.resolve({ ok: true, plus: status.plus });
        }
        if (message && message.type === 'SET_VOLUME') {
          if (message.kind === 'original') extSettings.originalVolume = Number(message.value) || 0.25;
          if (message.kind === 'dubbed') extSettings.dubbedVolume = Number(message.value) || 1.0;
          if (message.origin && persisted.plus.rememberVolumes) {
            const isFree = !persisted.plus.entitlement?.plusEnabled;
            const existing = persisted.siteProfiles.find((p) => p.origin === message.origin);
            if (!existing && isFree && persisted.siteProfiles.length >= 1) {
              persist();
              return Promise.resolve({ ok: true, value: message.value, plus: status.plus, upgradeRequired: true, limitReached: true });
            }
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
          }
          persist();
          return Promise.resolve({ ok: true, value: message.value, plus: status.plus });
        }
        if (message && message.type === 'SET_AUTO_DUCKING') {
          extSettings.autoDucking = message.enabled === true;
          persist();
          return Promise.resolve({ ok: true, value: extSettings.autoDucking });
        }
        if (message && message.type === 'PLUS_GET_STATUS') return Promise.resolve({ ...status });
        if (message && message.type === 'SET_ANALYTICS_CONSENT') {
          extSettings.analyticsConsent = message.value === true;
          persist();
          return Promise.resolve({ ok: true, settings: { ...extSettings, hasKey: true } });
        }
        if (message && message.type === 'PLUS_SET_LOCAL_SAVING') {
          persisted.plus.localSavingEnabled = message.value === true;
          persist();
          return Promise.resolve({ ok: true, plus: status.plus });
        }
        if (message && message.type === 'PLUS_SET_REMEMBER_VOLUMES') {
          persisted.plus.rememberVolumes = message.value === true;
          persist();
          return Promise.resolve({ ok: true, plus: status.plus });
        }
        if (message && message.type === 'PLUS_DELETE_SITE_PROFILE') {
          persisted.siteProfiles = persisted.siteProfiles.filter((p) => p.origin !== message.origin);
          persist();
          return Promise.resolve({ ok: true, plus: status.plus });
        }
        if (message && message.type === 'PLUS_UPDATE_SITE_PROFILE') {
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
          return Promise.resolve({ ok: true, plus: status.plus });
        }
        return Promise.resolve({ ok: true });
      },
      onMessage: { addListener() {}, removeListener() {} },
      getURL: (path) => new URL(path.replace(/^\//, ''), '../../').href
    }
  };
})();
