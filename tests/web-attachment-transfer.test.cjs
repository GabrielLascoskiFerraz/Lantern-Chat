const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourceFile = path.join(__dirname, '..', 'renderer', 'src', 'api', 'attachmentTransfer.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const loaded = new Module(sourceFile, module);
loaded.filename = sourceFile;
loaded.paths = module.paths;
loaded._compile(compiled, sourceFile);
const {
  ATTACHMENT_CHUNK_SIZE_BYTES,
  attachmentChunkCount,
  forEachFileChunk,
  mergeAttachmentCache
} = loaded.exports;

const fileMessage = (overrides = {}) => ({
  messageId: 'file-1', conversationId: 'dm:peer', direction: 'in',
  senderDeviceId: 'peer', receiverDeviceId: 'me', type: 'file', bodyText: null,
  fileId: 'attachment-1', fileName: 'foto.gif', fileSize: 10, fileSha256: 'sha',
  filePath: null, status: 'delivered', reaction: null, deletedAt: null,
  replyToMessageId: null, replyToSenderDeviceId: null, replyToType: null,
  replyToPreviewText: null, replyToFileName: null, createdAt: 1, ...overrides
});

test('transporte Web usa os mesmos blocos de 64 KiB exigidos pelo Relay', async () => {
  assert.equal(ATTACHMENT_CHUNK_SIZE_BYTES, 64 * 1024);
  const bytes = new Uint8Array(ATTACHMENT_CHUNK_SIZE_BYTES * 2 + 17);
  const fakeFile = {
    size: bytes.length,
    slice: (start, end) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer })
  };
  const chunks = [];
  await forEachFileChunk(fakeFile, 0, async (chunk, index, total) => {
    chunks.push({ size: chunk.length, index, total });
  });
  assert.equal(attachmentChunkCount(bytes.length), 3);
  assert.deepEqual(chunks, [
    { size: 64 * 1024, index: 0, total: 3 },
    { size: 64 * 1024, index: 1, total: 3 },
    { size: 17, index: 2, total: 3 }
  ]);
});

test('upload retomado começa no índice confirmado pelo Relay', async () => {
  const bytes = new Uint8Array(ATTACHMENT_CHUNK_SIZE_BYTES * 3);
  const fakeFile = {
    size: bytes.length,
    slice: (start, end) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer })
  };
  const indexes = [];
  await forEachFileChunk(fakeFile, 2, async (_chunk, index) => indexes.push(index));
  assert.deepEqual(indexes, [2]);
});

test('snapshot repetido não apaga o blob já hidratado no navegador', () => {
  const cached = fileMessage({ filePath: 'blob:lantern-file', status: 'read' });
  const incoming = fileMessage({ filePath: null, status: 'delivered' });
  const merged = mergeAttachmentCache(incoming, cached);
  assert.equal(merged.filePath, 'blob:lantern-file');
  assert.equal(merged.status, 'read');
});
