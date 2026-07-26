const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourceFile = path.join(
  __dirname,
  '..',
  'renderer',
  'src',
  'state',
  'appearancePersistence.ts'
);
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

const {
  DEFAULT_APPEARANCE,
  appearanceStorageKey,
  persistAppearanceForAccount,
  readAppearanceForAccount
} = loaded.exports;

class MemoryStorage {
  constructor(entries = []) {
    this.values = new Map(entries);
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

const scope = (userId, overrides = {}) => ({
  userId,
  relay: {
    mode: 'local-auto',
    host: '',
    port: 43190,
    secure: false,
    ...(overrides.relay || {})
  },
  endpoint: overrides.endpoint || 'ws://192.168.1.10:43190'
});

test('chave isola usuário e Relay sem depender do IP descoberto no modo automático', () => {
  const account = scope('user-a');
  const afterDhcp = scope('user-a', { endpoint: 'ws://192.168.1.99:43190' });
  assert.equal(appearanceStorageKey(account), appearanceStorageKey(afterDhcp));
  assert.notEqual(appearanceStorageKey(account), appearanceStorageKey(scope('user-b')));
  assert.notEqual(
    appearanceStorageKey(account),
    appearanceStorageKey(scope('user-a', { relay: { mode: 'local-auto', port: 43191 } }))
  );
});

test('migra as chaves globais uma única vez e não vaza aparência para outra conta', () => {
  const storage = new MemoryStorage([
    ['lantern.theme', 'light'],
    ['lantern.font-size', 'large'],
    ['lantern.density', 'comfortable']
  ]);
  const accountA = scope('user-a');
  const accountB = scope('user-b');

  assert.deepEqual(readAppearanceForAccount(storage, accountA, { migrateLegacy: true }), {
    themeMode: 'light',
    fontSizeMode: 'large',
    densityMode: 'comfortable'
  });
  assert.equal(storage.getItem('lantern.theme'), null);
  assert.equal(storage.getItem('lantern.font-size'), null);
  assert.equal(storage.getItem('lantern.density'), null);
  assert.deepEqual(
    readAppearanceForAccount(storage, accountB, { migrateLegacy: true }),
    DEFAULT_APPEARANCE
  );
});

test('primeiro acesso usa padrões sem herdar legado e mantém escolhas após reiniciar', () => {
  const storage = new MemoryStorage([
    ['lantern.theme', 'dark'],
    ['lantern.font-size', 'large'],
    ['lantern.density', 'comfortable']
  ]);
  const account = scope('new-user');

  assert.deepEqual(
    readAppearanceForAccount(storage, account, { migrateLegacy: false }),
    DEFAULT_APPEARANCE
  );
  assert.equal(
    persistAppearanceForAccount(storage, account, {
      themeMode: 'light',
      fontSizeMode: 'medium',
      densityMode: 'compact'
    }),
    true
  );

  assert.deepEqual(
    readAppearanceForAccount(storage, account, { migrateLegacy: false }),
    {
      themeMode: 'light',
      fontSizeMode: 'medium',
      densityMode: 'compact'
    }
  );

  // Ao concluir o primeiro acesso, a preferência v2 já escolhida prevalece,
  // mas o legado é consumido para não vazar para uma segunda conta.
  assert.deepEqual(
    readAppearanceForAccount(storage, account, { migrateLegacy: true }),
    {
      themeMode: 'light',
      fontSizeMode: 'medium',
      densityMode: 'compact'
    }
  );
  assert.equal(storage.getItem('lantern.theme'), null);
  assert.deepEqual(
    readAppearanceForAccount(storage, scope('another-user'), { migrateLegacy: true }),
    DEFAULT_APPEARANCE
  );
});

test('preferências persistidas sobrevivem à reidratação e permanecem isoladas', () => {
  const storage = new MemoryStorage();
  const accountA = scope('user-a');
  const accountB = scope('user-b');
  const accountC = scope('user-a', {
    relay: { mode: 'external-manual', host: 'chat.example.com', port: 443, secure: true },
    endpoint: 'wss://chat.example.com'
  });

  persistAppearanceForAccount(storage, accountA, {
    themeMode: 'light',
    fontSizeMode: 'large',
    densityMode: 'comfortable'
  });
  persistAppearanceForAccount(storage, accountB, {
    themeMode: 'dark',
    fontSizeMode: 'small',
    densityMode: 'compact'
  });

  assert.equal(
    readAppearanceForAccount(storage, accountA, { migrateLegacy: true }).themeMode,
    'light'
  );
  assert.equal(
    readAppearanceForAccount(storage, accountB, { migrateLegacy: true }).themeMode,
    'dark'
  );
  assert.deepEqual(
    readAppearanceForAccount(storage, accountC, { migrateLegacy: true }),
    DEFAULT_APPEARANCE
  );
});

test('dados corrompidos ou armazenamento indisponível não impedem a inicialização', () => {
  const account = scope('user-a');
  const storage = new MemoryStorage();
  storage.setItem(appearanceStorageKey(account), '{not-json');
  storage.setItem('lantern.appearance.v2.migration-owner', 'already-migrated');
  assert.deepEqual(
    readAppearanceForAccount(storage, account, { migrateLegacy: true }),
    DEFAULT_APPEARANCE
  );

  const failingStorage = {
    getItem() {
      throw new Error('storage unavailable');
    },
    setItem() {
      throw new Error('storage unavailable');
    }
  };
  assert.deepEqual(
    readAppearanceForAccount(failingStorage, account, { migrateLegacy: true }),
    DEFAULT_APPEARANCE
  );
  assert.equal(
    persistAppearanceForAccount(failingStorage, account, DEFAULT_APPEARANCE),
    false
  );
});
