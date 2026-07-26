const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const { createServer } = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const WebSocket = require('ws');

const projectRoot = path.join(__dirname, '..');
const orderSource = path.join(
  projectRoot,
  'renderer',
  'src',
  'utils',
  'messageOrder.ts'
);
const compiledOrder = ts.transpileModule(fs.readFileSync(orderSource, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const orderModule = new Module(orderSource, module);
orderModule.filename = orderSource;
orderModule.paths = module.paths;
orderModule._compile(compiledOrder, orderSource);
const { sortCanonicalMessages } = orderModule.exports;

const { DbService } = require('../dist-electron/db.js');

const relayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-canonical-sync-'));
process.env.LANTERN_RELAY_DATA_DIR = relayRoot;
process.env.LANTERN_RELAY_ANNOUNCEMENTS_FILE = path.join(relayRoot, 'announcements.json');
process.env.LANTERN_RELAY_GROUPS_FILE = path.join(relayRoot, 'groups.json');
process.env.LANTERN_RELAY_GROUP_ATTACHMENTS_DIR = path.join(relayRoot, 'group-attachments');
process.env.LANTERN_RELAY_STICKERS_DIR = path.join(relayRoot, 'stickers');
process.env.LANTERN_RELAY_ADMIN_PASSWORD = 'canonical-sync-admin-password';
process.env.LANTERN_RELAY_LOG_LEVEL = 'error';

const { CentralStore } = require('../dist-relay/centralStore.js');
const { LanternRelay } = require('../dist-relay/main.js');

const message = (overrides = {}) => ({
  messageId: randomUUID(),
  conversationId: 'dm:peer',
  direction: 'in',
  senderDeviceId: 'peer',
  receiverDeviceId: 'self',
  type: 'text',
  bodyText: 'mensagem',
  fileId: null,
  fileName: null,
  fileSize: null,
  fileSha256: null,
  filePath: null,
  status: 'delivered',
  reaction: null,
  deletedAt: null,
  replyToMessageId: null,
  replyToSenderDeviceId: null,
  replyToType: null,
  replyToPreviewText: null,
  replyToFileName: null,
  forwardedFromMessageId: null,
  editedAt: null,
  createdAt: Date.now(),
  ...overrides
});

const getFreePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});

const relayConfig = (port) => ({
  host: '127.0.0.1',
  port,
  pingIntervalMs: 60_000,
  peerTimeoutMs: 120_000,
  presenceBroadcastIntervalMs: 60_000,
  maxPayloadBytes: 8 * 1024 * 1024,
  tlsCertFile: null,
  tlsKeyFile: null,
  externalMode: false
});

const connect = (port, auth, clientDeviceId) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = [];
  const timeout = setTimeout(
    () => reject(new Error('Timeout no hello do teste canônico.')),
    5_000
  );
  socket.on('error', reject);
  socket.on('message', (raw) => {
    const envelope = JSON.parse(raw.toString());
    messages.push(envelope);
    if (envelope.type === 'relay:welcome') {
      socket.send(JSON.stringify({
        type: 'relay:hello',
        payload: {
          deviceId: clientDeviceId,
          displayName: auth.user.displayName,
          avatarEmoji: auth.user.avatarEmoji,
          avatarBg: auth.user.avatarBg,
          appVersion: 'test',
          sessionToken: auth.token
        }
      }));
    }
    if (envelope.type === 'relay:hello:ok') {
      clearTimeout(timeout);
      resolve({ socket, messages });
    }
  });
});

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timeout aguardando sincronização canônica.');
};

const sendAndWaitForAck = async (client, frame) => {
  const previousCount = client.messages.filter(
    (envelope) =>
      envelope.type === 'relay:send:ack' &&
      envelope.payload?.frameMessageId === frame.messageId
  ).length;
  client.socket.send(JSON.stringify({
    type: 'relay:send',
    payload: { frame }
  }));
  return waitFor(() => {
    const matches = client.messages.filter(
      (envelope) =>
        envelope.type === 'relay:send:ack' &&
        envelope.payload?.frameMessageId === frame.messageId
    );
    return matches.length > previousCount ? matches[matches.length - 1] : null;
  });
};

test('clientes convergem para a mesma ordem por serverSeq apesar da ordem de chegada e dos relógios', () => {
  const canonical = [
    message({ messageId: 'message-1', serverSeq: 41, createdAt: 9_000_000 }),
    message({ messageId: 'message-2', serverSeq: 42, createdAt: 1 }),
    message({ messageId: 'message-3', serverSeq: 43, createdAt: 4_000 })
  ];
  const firstArrival = [canonical[2], canonical[0], canonical[1]];
  const secondArrival = [canonical[1], canonical[2], canonical[0]];

  const expected = ['message-1', 'message-2', 'message-3'];
  assert.deepEqual(
    sortCanonicalMessages(firstArrival).map((row) => row.messageId),
    expected
  );
  assert.deepEqual(
    sortCanonicalMessages(secondArrival).map((row) => row.messageId),
    expected
  );
});

test('ACK canônico reconcilia o placeholder otimista com sequência e horário do Relay', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-placeholder-ack-'));
  try {
    const db = new DbService(root);
    const conversationId = db.ensureDmConversation('peer', 'Contato');
    const localCreatedAt = Date.now() + 24 * 60 * 60 * 1_000;
    db.saveMessage(message({
      messageId: 'optimistic',
      conversationId,
      direction: 'out',
      senderDeviceId: 'self',
      receiverDeviceId: 'peer',
      status: 'sent',
      serverSeq: null,
      createdAt: localCreatedAt
    }));
    db.saveMessage(message({
      messageId: 'canonical-second',
      conversationId,
      serverSeq: 102,
      createdAt: 2_000
    }));

    const reconciled = db.applyCanonicalMessageMetadata('optimistic', 101, 1_000);
    assert.equal(reconciled.serverSeq, 101);
    assert.equal(reconciled.createdAt, 1_000);
    assert.notEqual(reconciled.createdAt, localCreatedAt);
    assert.deepEqual(
      db.getMessages(conversationId, 10).map((row) => row.messageId),
      ['optimistic', 'canonical-second']
    );
    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sequência própria de grupo não avança o cursor incremental global das conversas diretas', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-cursor-namespace-'));
  try {
    const db = new DbService(root);
    const directConversationId = db.ensureDmConversation('peer', 'Contato');
    const groupConversationId = db.ensureGroupConversation('group-one', 'Grupo');
    db.saveMessage(message({
      messageId: 'direct-sequence',
      conversationId: directConversationId,
      serverSeq: 21,
      createdAt: 21
    }));
    db.saveMessage(message({
      messageId: 'group-sequence',
      conversationId: groupConversationId,
      serverSeq: 9_000,
      createdAt: 22
    }));
    assert.equal(db.getMaxServerSeq(), 21);
    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('destinatário offline recupera a história na ordem do Relay e ACKs não ocupam a página', async () => {
  const port = await getFreePort();
  const store = new CentralStore(path.join(relayRoot, 'central'), () => undefined);
  const senderUser = store.createUser({
    username: 'canonical-sender',
    displayName: 'Canonical Sender',
    password: 'canonical-sender-password'
  });
  const recipientUser = store.createUser({
    username: 'canonical-recipient',
    displayName: 'Canonical Recipient',
    password: 'canonical-recipient-password'
  });
  const senderAuth = store.login(
    senderUser.username,
    'canonical-sender-password',
    'canonical-sender-device'
  );
  const recipientAuth = store.login(
    recipientUser.username,
    'canonical-recipient-password',
    'canonical-recipient-device'
  );
  store.close();

  const relay = new LanternRelay(relayConfig(port));
  const sockets = [];
  try {
    await relay.start();
    const sender = await connect(port, senderAuth, 'canonical-sender-device');
    sockets.push(sender.socket);

    const clientTimes = [
      Date.now() + 24 * 60 * 60 * 1_000,
      Date.now() - 14 * 24 * 60 * 60 * 1_000,
      Date.now() + 180 * 24 * 60 * 60 * 1_000
    ];
    const messageIds = ['offline-1', 'offline-2', 'offline-3'];
    const receipts = [];
    for (let index = 0; index < messageIds.length; index += 1) {
      const frame = {
        type: 'chat:text',
        messageId: messageIds[index],
        from: senderUser.userId,
        to: recipientUser.userId,
        createdAt: clientTimes[index],
        payload: { text: `Mensagem ${index + 1}` }
      };
      const acceptedAfter = Date.now();
      const ack = await sendAndWaitForAck(sender, frame);
      const acceptedBefore = Date.now();
      assert.equal(ack.payload.persisted, true);
      assert.equal(Number.isInteger(ack.payload.serverSeq), true);
      assert.equal(ack.payload.createdAt >= acceptedAfter, true);
      assert.equal(ack.payload.createdAt <= acceptedBefore, true);
      assert.notEqual(ack.payload.createdAt, frame.createdAt);
      receipts.push(ack.payload);

      // O ACK de leitura/recebimento continua roteável, mas não é histórico.
      const deliveryAck = await sendAndWaitForAck(sender, {
        type: 'chat:ack',
        messageId: `ack-${index + 1}`,
        from: senderUser.userId,
        to: recipientUser.userId,
        createdAt: Date.now(),
        payload: { ackMessageId: frame.messageId, status: 'delivered' }
      });
      assert.equal(deliveryAck.payload.persisted, false);
      assert.equal(deliveryAck.payload.serverSeq, null);
    }
    assert.deepEqual(
      receipts.map((receipt) => receipt.serverSeq),
      [...receipts]
        .map((receipt) => receipt.serverSeq)
        .sort((left, right) => left - right)
    );

    // O destinatário só entra depois de todas as gravações.
    const recipient = await connect(
      port,
      recipientAuth,
      'canonical-recipient-device'
    );
    sockets.push(recipient.socket);
    const requestId = randomUUID();
    recipient.socket.send(JSON.stringify({
      type: 'relay:history:request',
      payload: {
        requestId,
        peerUserId: senderUser.userId,
        before: Number.MAX_SAFE_INTEGER,
        beforeSeq: Number.MAX_SAFE_INTEGER,
        limit: 2
      }
    }));
    const latestPage = await waitFor(() => recipient.messages.find(
      (envelope) =>
        envelope.type === 'relay:history:page' &&
        envelope.payload?.requestId === requestId
    ));
    assert.deepEqual(
      latestPage.payload.frames.map((frame) => frame.messageId),
      ['offline-2', 'offline-3']
    );
    assert.deepEqual(
      latestPage.payload.frames.map((frame) => frame.serverSeq),
      receipts.slice(1).map((receipt) => receipt.serverSeq)
    );
    assert.equal(
      latestPage.payload.frames.some((frame) => frame.type === 'chat:ack'),
      false
    );

    const olderRequestId = randomUUID();
    recipient.socket.send(JSON.stringify({
      type: 'relay:history:request',
      payload: {
        requestId: olderRequestId,
        peerUserId: senderUser.userId,
        before: latestPage.payload.frames[0].createdAt,
        beforeSeq: latestPage.payload.frames[0].serverSeq,
        limit: 2
      }
    }));
    const olderPage = await waitFor(() => recipient.messages.find(
      (envelope) =>
        envelope.type === 'relay:history:page' &&
        envelope.payload?.requestId === olderRequestId
    ));
    assert.deepEqual(
      olderPage.payload.frames.map((frame) => frame.messageId),
      ['offline-1']
    );
    assert.equal(
      olderPage.payload.frames[0].createdAt,
      receipts[0].createdAt
    );

    // Reenvio idempotente recebe exatamente os mesmos metadados canônicos.
    const duplicate = await sendAndWaitForAck(sender, {
      type: 'chat:text',
      messageId: 'offline-1',
      from: senderUser.userId,
      to: recipientUser.userId,
      createdAt: clientTimes[0],
      payload: { text: 'Mensagem 1' }
    });
    assert.equal(duplicate.payload.duplicate, true);
    assert.equal(duplicate.payload.serverSeq, receipts[0].serverSeq);
    assert.equal(duplicate.payload.createdAt, receipts[0].createdAt);
  } finally {
    for (const socket of sockets) socket.close();
    await relay.stop('canonical-sync-test');
    fs.rmSync(relayRoot, { recursive: true, force: true });
  }
});
