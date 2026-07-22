const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PriorityTaskQueue, RelayOperationError, Semaphore } = require('../dist-electron/reliability.js');
const { DbService } = require('../dist-electron/db.js');
const { RELAY_ACCEPTED_MESSAGE_STATUS } = require('../dist-electron/messageStatus.js');
const { MessageService } = require('../dist-electron/services/MessageService.js');

test('fila prioriza mensagens persistentes que ainda não começaram', async () => {
  const queue = new PriorityTaskQueue(1);
  const order = [];
  let release;
  const blocker = queue.enqueue(() => new Promise((resolve) => {
    release = () => { order.push('blocker'); resolve(); };
  }), 0);
  const typing = queue.enqueue(async () => { order.push('typing'); }, -20);
  const message = queue.enqueue(async () => { order.push('message'); }, 100);
  release();
  await Promise.all([blocker, typing, message]);
  assert.deepEqual(order, ['blocker', 'message', 'typing']);
});

test('semáforo respeita limite de concorrência', async () => {
  const semaphore = new Semaphore(2);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 8 }, () => semaphore.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  })));
  assert.equal(peak, 2);
});

test('erros do Relay carregam código e recuperabilidade', () => {
  const error = new RelayOperationError('OPERATION_PENDING', 'pendente');
  assert.equal(error.code, 'OPERATION_PENDING');
  assert.equal(error.recoverable, true);
  assert.equal(error.name, 'RelayOperationError');
});

test('ACK do Relay promove mensagem pendente para entregue antes da leitura', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-message-status-'));
  try {
    const db = new DbService(root);
    const conversationId = db.ensureDmConversation('recipient', 'Destinatário');
    db.saveMessage({
      messageId: 'message-status', conversationId, direction: 'out',
      senderDeviceId: 'sender', receiverDeviceId: 'recipient', type: 'text',
      bodyText: 'teste', fileId: null, fileName: null, fileSize: null,
      fileSha256: null, filePath: null, status: 'sent', reaction: null,
      deletedAt: null, replyToMessageId: null, replyToSenderDeviceId: null,
      replyToType: null, replyToPreviewText: null, replyToFileName: null,
      forwardedFromMessageId: null, editedAt: null, createdAt: Date.now()
    });

    assert.equal(db.getMessageById('message-status').status, 'sent');
    assert.equal(RELAY_ACCEPTED_MESSAGE_STATUS, 'delivered');
    db.updateMessageStatus('message-status', RELAY_ACCEPTED_MESSAGE_STATUS);
    assert.equal(db.getMessageById('message-status').status, 'delivered');

    // Uma atualização atrasada nunca rebaixa o ACK canônico.
    db.updateMessageStatus('message-status', 'sent');
    assert.equal(db.getMessageById('message-status').status, 'delivered');

    db.updateMessageStatus('message-status', 'read');
    assert.equal(db.getMessageById('message-status').status, 'read');
    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('limpeza de anexos remove apenas caminhos locais recebidos e preserva as mensagens', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-attachment-cache-clear-'));
  try {
    const db = new DbService(root);
    const receivedPath = path.join(root, 'received.png');
    const originalPath = path.join(root, 'original.png');
    fs.writeFileSync(receivedPath, 'recebido');
    fs.writeFileSync(originalPath, 'original');
    const conversationId = db.ensureDmConversation('peer', 'Contato');
    const base = {
      conversationId, receiverDeviceId: null, type: 'file', bodyText: null,
      fileName: 'imagem.png', fileSize: 8, fileSha256: 'hash', status: 'delivered',
      reaction: null, deletedAt: null, replyToMessageId: null,
      replyToSenderDeviceId: null, replyToType: null, replyToPreviewText: null,
      replyToFileName: null, forwardedFromMessageId: null, editedAt: null,
      createdAt: Date.now()
    };
    db.saveMessage({
      ...base, messageId: 'received-file', direction: 'in', senderDeviceId: 'peer',
      fileId: 'received-id', filePath: receivedPath
    });
    db.saveMessage({
      ...base, messageId: 'sent-file', direction: 'out', senderDeviceId: 'self',
      receiverDeviceId: 'peer', fileId: 'sent-id', filePath: originalPath,
      createdAt: Date.now() + 1
    });

    assert.deepEqual(db.getDownloadedAttachmentCachePaths(), [receivedPath]);
    db.clearDownloadedAttachmentCache();
    assert.equal(db.getMessageById('received-file').filePath, null);
    assert.equal(db.getMessageById('sent-file').filePath, originalPath);
    assert.equal(db.getMessageById('received-file').messageId, 'received-file');
    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nova tentativa reutiliza o messageId e confirma entregue no ACK do Relay', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-message-retry-'));
  try {
    const db = new DbService(root);
    const conversationId = db.ensureDmConversation('recipient', 'Destinatário');
    const createdAt = Date.now();
    db.saveMessage({
      messageId: 'retry-same-id', conversationId, direction: 'out',
      senderDeviceId: 'sender', receiverDeviceId: 'recipient', type: 'text',
      bodyText: 'reenviar sem duplicar', fileId: null, fileName: null, fileSize: null,
      fileSha256: null, filePath: null, status: 'failed', reaction: null,
      deletedAt: null, replyToMessageId: null, replyToSenderDeviceId: null,
      replyToType: null, replyToPreviewText: null, replyToFileName: null,
      forwardedFromMessageId: null, editedAt: null, createdAt
    });
    const frames = [];
    const events = [];
    const service = new MessageService({
      db,
      profile: { deviceId: 'sender' },
      fileTransfer: {},
      getPeer: () => undefined,
      emitEvent: (event) => events.push(event),
      sendCanonicalFrame: async (frame) => frames.push(frame),
      uploadCanonicalAttachment: async () => undefined
    });

    const result = await service.retryFailedMessage('retry-same-id');
    assert.equal(frames.length, 1);
    assert.equal(frames[0].messageId, 'retry-same-id');
    assert.equal(frames[0].createdAt, createdAt);
    assert.equal(result.status, 'delivered');
    assert.equal(db.getMessageById('retry-same-id').status, 'delivered');
    assert.deepEqual(events.map((event) => event.message?.status), ['sent', 'delivered']);
    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('outbox persiste frames idempotentes entre reaberturas do cliente', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-outbox-'));
  const frame = {
    type: 'chat:text', messageId: 'outbox-message', from: 'sender', to: 'recipient',
    createdAt: Date.now(), payload: { text: 'persistente' }
  };
  try {
    const first = new DbService(root);
    first.enqueueOutboundFrame(frame);
    first.enqueueOutboundFrame(frame);
    assert.equal(first.getOutboundFrameCount(), 1);
    first.close();

    const reopened = new DbService(root);
    assert.equal(reopened.listOutboundFrames()[0].frame.messageId, frame.messageId);
    reopened.retryOutboundFrame(frame.messageId, 'offline', 1_000);
    assert.equal(reopened.listOutboundFrames()[0].attempts, 1);
    reopened.saveAttachmentDownloadCheckpoint({
      fileId: 'file-resume', messageId: frame.messageId,
      tempPath: path.join(root, 'partial.bin'), receivedBytes: 65_536, nextChunkIndex: 1
    });
    assert.equal(reopened.getAttachmentDownloadCheckpoint('file-resume').nextChunkIndex, 1);
    reopened.clearAttachmentDownloadCheckpoint('file-resume');
    assert.equal(reopened.getAttachmentDownloadCheckpoint('file-resume'), undefined);
    reopened.completeOutboundFrame(frame.messageId);
    assert.equal(reopened.getOutboundFrameCount(), 0);
    reopened.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
