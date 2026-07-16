const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PriorityTaskQueue, RelayOperationError, Semaphore } = require('../dist-electron/reliability.js');
const { DbService } = require('../dist-electron/db.js');

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
