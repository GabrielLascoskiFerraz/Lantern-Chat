const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourceFile = path.resolve(__dirname, '../renderer/src/ui/platformEmojiUtils.ts');
const source = fs.readFileSync(sourceFile, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  },
  fileName: sourceFile
}).outputText;
const loadedModule = { exports: {} };
new Function('require', 'module', 'exports', '__filename', '__dirname', compiled)(
  require,
  loadedModule,
  loadedModule.exports,
  sourceFile,
  path.dirname(sourceFile)
);

const {
  emojiAssetCandidates,
  emojiAssetName,
  isEmojiGrapheme,
  shouldUseFluentEmoji,
  splitGraphemes
} = loadedModule.exports;

test('gera nomes de ativos Fluent para emojis simples e compostos', () => {
  assert.equal(emojiAssetName('😀'), '1f600.webp');
  assert.equal(emojiAssetName('❤️'), '2764-fe0f.webp');
  assert.equal(emojiAssetName('👩‍💻'), '1f469-200d-1f4bb.webp');
  assert.equal(emojiAssetName('👍🏽'), '1f44d-1f3fd.webp');
  assert.equal(emojiAssetName('🇧🇷'), '1f1e7-1f1f7.webp');
});

test('mantém uma alternativa sem seletor de variação para o fallback', () => {
  assert.deepEqual(emojiAssetCandidates('❤️'), ['2764-fe0f.webp', '2764.webp']);
  assert.deepEqual(emojiAssetCandidates('😀'), ['1f600.webp']);
});

test('segmenta sequências emoji sem separar ZWJ, tom de pele ou bandeira', () => {
  const parts = splitGraphemes('Oi 👩‍💻 👍🏽 🇧🇷!');
  assert.deepEqual(parts, ['O', 'i', ' ', '👩‍💻', ' ', '👍🏽', ' ', '🇧🇷', '!']);
  assert.equal(isEmojiGrapheme('👩‍💻'), true);
  assert.equal(isEmojiGrapheme('🇧🇷'), true);
  assert.equal(isEmojiGrapheme('A'), false);
});

test('ativa o catálogo 3D só no Windows e mantém o renderizador nativo do macOS', () => {
  const originalDocument = global.document;
  const originalWindow = global.window;
  try {
    global.document = { documentElement: { dataset: {} } };
    global.window = { lantern: { getPlatform: () => 'darwin' } };
    assert.equal(shouldUseFluentEmoji(), false);

    global.window = { lantern: { getPlatform: () => 'win32' } };
    assert.equal(shouldUseFluentEmoji(), true);
  } finally {
    global.document = originalDocument;
    global.window = originalWindow;
  }
});
