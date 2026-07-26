const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const compileTypescriptModule = (sourceFile) => {
  const compiled = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  const loaded = new Module(sourceFile, module);
  loaded.filename = sourceFile;
  loaded.paths = module.paths;
  loaded._compile(compiled, sourceFile);
  return loaded.exports;
};

test('store hidrata, apenas prevê ao editar e persiste somente ao confirmar aparência', async (t) => {
  const appearanceFile = path.join(
    __dirname,
    '..',
    'renderer',
    'src',
    'state',
    'appearancePersistence.ts'
  );
  const appearance = compileTypescriptModule(appearanceFile);
  const storeFile = path.join(__dirname, '..', 'renderer', 'src', 'state', 'store.ts');

  class MemoryStorage {
    constructor() {
      this.values = new Map();
    }
    getItem(key) {
      return this.values.has(key) ? this.values.get(key) : null;
    }
    setItem(key, value) {
      this.values.set(key, String(value));
    }
    removeItem(key) {
      this.values.delete(key);
    }
  }

  const storage = new MemoryStorage();
  let authState = {
    authenticated: true,
    endpoint: 'ws://192.168.1.10:43190',
    relay: { mode: 'local-auto', host: '', port: 43190, secure: false },
    user: {
      userId: 'account-a',
      profileSetupCompleted: false,
      passwordSetupRequired: false
    }
  };
  const accountAScope = {
    userId: 'account-a',
    relay: authState.relay,
    endpoint: authState.endpoint
  };
  appearance.persistAppearanceForAccount(storage, accountAScope, {
    themeMode: 'light',
    fontSizeMode: 'medium',
    densityMode: 'standard'
  });

  const ipcClient = new Proxy({
    getAuthState: async () => authState,
    getProfile: async () => ({ deviceId: authState.user.userId, displayName: 'Usuário' }),
    getRelaySettings: async () => ({
      automatic: true,
      host: '',
      port: 43190,
      connected: true,
      endpoint: authState.endpoint
    }),
    getStartupSettings: async () => ({
      supported: true,
      openAtLogin: true,
      downloadsDir: '/tmp',
      doNotDisturbUntil: 0
    })
  }, {
    get(target, property) {
      if (property in target) return target[property];
      return async () => undefined;
    }
  });

  const create = (initializer) => {
    let state;
    const set = (update) => {
      const patch = typeof update === 'function' ? update(state) : update;
      if (patch && patch !== state) state = { ...state, ...patch };
    };
    const get = () => state;
    state = initializer(set, get);
    const store = (selector = (value) => value) => selector(state);
    store.getState = get;
    store.setState = set;
    return store;
  };

  const previousWindow = global.window;
  global.window = {
    localStorage: storage,
    matchMedia: () => ({ matches: false }),
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => undefined
  };
  t.after(() => {
    global.window = previousWindow;
  });

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'zustand') return { create };
    if (request.endsWith('/api/ipcClient') || request === '../api/ipcClient') {
      return { ipcClient };
    }
    if (request.endsWith('/appearancePersistence') || request === './appearancePersistence') {
      return appearance;
    }
    if (request.endsWith('/messageMerge') || request === './messageMerge') {
      return {
        mergeFetchedMessagesWithLiveUpdates: (rows) => rows,
        mergeRepairedConversationPage: (rows) => rows
      };
    }
    if (request.endsWith('/utils/messageOrder') || request === '../utils/messageOrder') {
      return { sortCanonicalMessages: (rows) => [...rows] };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => {
    Module._load = originalLoad;
  });

  const storeModule = compileTypescriptModule(storeFile);
  const store = storeModule.useLanternStore;
  await store.getState().loadInitial();

  assert.equal(store.getState().themeMode, 'light');
  assert.equal(store.getState().fontSizeMode, 'medium');
  assert.equal(store.getState().densityMode, 'standard');

  const persistedBeforePreview = storage.getItem(appearance.appearanceStorageKey(accountAScope));
  store.getState().previewAppearance({
    themeMode: 'dark',
    fontSizeMode: 'large',
    densityMode: 'comfortable'
  });
  assert.equal(store.getState().themeMode, 'dark');
  assert.equal(
    storage.getItem(appearance.appearanceStorageKey(accountAScope)),
    persistedBeforePreview,
    'prévia não deve persistir'
  );

  // Cancelar restaura apenas o estado visual e mantém a preferência confirmada.
  store.getState().previewAppearance({
    themeMode: 'light',
    fontSizeMode: 'medium',
    densityMode: 'standard'
  });
  assert.equal(
    storage.getItem(appearance.appearanceStorageKey(accountAScope)),
    persistedBeforePreview
  );

  // O mesmo caminho usado pelo Shell ao salvar confirma o rascunho completo.
  store.getState().previewAppearance({
    themeMode: 'dark',
    fontSizeMode: 'large',
    densityMode: 'comfortable'
  });
  store.getState().setThemeMode('dark');
  store.getState().setFontSizeMode('large');
  store.getState().setDensityMode('comfortable');
  assert.deepEqual(JSON.parse(storage.getItem(appearance.appearanceStorageKey(accountAScope))), {
    themeMode: 'dark',
    fontSizeMode: 'large',
    densityMode: 'comfortable'
  });

  // Simula restart e mudança do endereço descoberto pelo mesmo Relay local.
  store.getState().previewAppearance({
    themeMode: 'system',
    fontSizeMode: 'small',
    densityMode: 'compact'
  });
  authState = {
    ...authState,
    endpoint: 'ws://192.168.1.99:43190'
  };
  await store.getState().loadInitial();
  assert.equal(store.getState().themeMode, 'dark');
  assert.equal(store.getState().fontSizeMode, 'large');
  assert.equal(store.getState().densityMode, 'comfortable');

  // Outra conta no mesmo Relay começa isolada.
  authState = {
    ...authState,
    user: {
      userId: 'account-b',
      profileSetupCompleted: false,
      passwordSetupRequired: false
    }
  };
  await store.getState().loadInitial();
  assert.equal(store.getState().themeMode, 'system');
  assert.equal(store.getState().fontSizeMode, 'medium');
  assert.equal(store.getState().densityMode, 'standard');
});
