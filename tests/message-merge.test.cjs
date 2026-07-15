const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourceFile = path.join(__dirname, '..', 'renderer', 'src', 'state', 'messageMerge.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const loaded = new Module(sourceFile, module);
loaded.filename = sourceFile;
loaded.paths = module.paths;
loaded._compile(compiled, sourceFile);
const {
  mergeFetchedMessagesWithLiveUpdates,
  mergeRepairedConversationPage
} = loaded.exports;

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
