const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourceFile = path.join(__dirname, '..', 'renderer', 'src', 'state', 'messageMerge.ts');
const previousTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (loadedModule, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  loadedModule._compile(compiled, filename);
};
const loaded = require(sourceFile);
if (previousTsLoader) Module._extensions['.ts'] = previousTsLoader;
else delete Module._extensions['.ts'];
const {
  mergeFetchedMessagesWithLiveUpdates,
  mergeRepairedConversationPage
} = loaded;

const fileMessage = (overrides = {}) => ({
  messageId: 'file-1', conversationId: 'dm:peer', direction: 'in',
  senderDeviceId: 'peer', receiverDeviceId: 'me', type: 'file', bodyText: null,
  fileId: 'attachment-1', fileName: 'foto.gif', fileSize: 10, fileSha256: 'sha',
  filePath: null, status: 'delivered', reaction: null, deletedAt: null,
  replyToMessageId: null, replyToSenderDeviceId: null, replyToType: null,
  replyToPreviewText: null, replyToFileName: null, forwardedFromMessageId: null,
  editedAt: null, createdAt: 1, ...overrides
});

test('snapshot atrasado não apaga anexo finalizado durante a abertura da conversa', () => {
  const stale = fileMessage();
  const live = fileMessage({ filePath: '/tmp/foto.gif', status: 'read' });
  const merged = mergeFetchedMessagesWithLiveUpdates([stale], [stale], [live]);
  assert.equal(merged[0].filePath, '/tmp/foto.gif');
  assert.equal(merged[0].status, 'read');
});

test('merge não ressuscita remoções nem perde mensagens recebidas durante o carregamento', () => {
  const removed = fileMessage();
  const arrived = fileMessage({ messageId: 'file-2', fileId: 'attachment-2', createdAt: 2 });
  const merged = mergeFetchedMessagesWithLiveUpdates([removed], [removed], [arrived]);
  assert.deepEqual(merged.map((message) => message.messageId), ['file-2']);
});

test('reparo atualiza a página recente sem apagar histórico antigo já carregado', () => {
  const older = fileMessage({ messageId: 'old', fileId: 'old-file', createdAt: 1 });
  const recent = fileMessage({ messageId: 'recent', fileId: 'recent-file', createdAt: 2 });
  const repaired = fileMessage({
    messageId: 'recent', fileId: 'recent-file', filePath: '/tmp/recent.gif', createdAt: 2
  });
  const merged = mergeRepairedConversationPage([repaired], [older, recent], [older, recent]);
  assert.deepEqual(merged.map((message) => message.messageId), ['old', 'recent']);
  assert.equal(merged[1].filePath, '/tmp/recent.gif');
});

test('merge converge por serverSeq mesmo quando snapshot e canal ao vivo chegam fora de ordem', () => {
  const first = fileMessage({
    messageId: 'canonical-1',
    fileId: 'canonical-file-1',
    serverSeq: 701,
    createdAt: 9_000
  });
  const second = fileMessage({
    messageId: 'canonical-2',
    fileId: 'canonical-file-2',
    serverSeq: 702,
    createdAt: 1
  });
  const third = fileMessage({
    messageId: 'canonical-3',
    fileId: 'canonical-file-3',
    serverSeq: 703,
    createdAt: 4_000
  });
  const merged = mergeFetchedMessagesWithLiveUpdates(
    [third, first],
    [],
    [second]
  );
  assert.deepEqual(
    merged.map((message) => message.messageId),
    ['canonical-1', 'canonical-2', 'canonical-3']
  );
});
