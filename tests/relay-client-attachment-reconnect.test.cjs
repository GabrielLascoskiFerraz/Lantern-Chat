const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');
const { RelayClient } = require('../dist-electron/relayClient.js');

const waitFor = async (predicate, timeoutMs = 3_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timeout aguardando condição do teste.');
};

test('queda da conexão libera imediatamente download canônico pendente', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const previousEndpoint = process.env.LANTERN_RELAY_URL;
  process.env.LANTERN_RELAY_URL = `ws://127.0.0.1:${address.port}`;

  let connected = false;
  let attachmentRequested = false;
  let interruptNextDownload = true;
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const envelope = JSON.parse(raw.toString());
      if (envelope.type === 'relay:hello') {
        socket.send(JSON.stringify({ type: 'relay:hello:ok', payload: {} }));
        return;
      }
      if (envelope.type === 'relay:presence:request') return;
      if (envelope.type === 'relay:attachment:request') {
        attachmentRequested = true;
        if (interruptNextDownload) {
          interruptNextDownload = false;
          socket.close(1012, 'reinício simulado');
          return;
        }
        const { requestId, attachmentId } = envelope.payload;
        socket.send(JSON.stringify({
          type: 'relay:attachment:start',
          payload: { requestId, attachmentId, messageId: 'message-after-reconnect', size: 4, sha256: 'test', totalChunks: 1 }
        }));
        socket.send(JSON.stringify({
          type: 'relay:attachment:data',
          payload: { requestId, attachmentId, index: 0, total: 1, dataBase64: Buffer.from('okay').toString('base64') }
        }));
        socket.send(JSON.stringify({
          type: 'relay:attachment:download:complete',
          payload: { requestId, attachmentId }
        }));
      }
    });
  });

  const client = new RelayClient({
    deviceId: 'attachment-reconnect-user',
    displayName: 'Attachment Reconnect',
    avatarEmoji: '📎',
    avatarBg: '#5b5fc7',
    statusMessage: 'Disponível'
  }, {
    onFrame: () => undefined,
    onPresence: () => undefined,
    onConnectionState: (state) => { connected = state.connected; }
  }, 'test-session-token');

  try {
    await client.start();
    await waitFor(() => connected);
    const startedAt = Date.now();
    await assert.rejects(
      client.downloadCentralAttachment('attachment-reconnect-id', {
        onStart: () => undefined,
        onChunk: () => undefined
      }),
      /conexão com relay perdida|relay/i
    );
    assert.equal(attachmentRequested, true);
    assert.ok(Date.now() - startedAt < 3_000, 'download não foi liberado imediatamente');

    await waitFor(() => connected);
    const received = [];
    await client.downloadCentralAttachment('attachment-after-reconnect', {
      onStart: (metadata) => received.push(['start', metadata.attachmentId]),
      onChunk: (chunk) => received.push(['chunk', Buffer.from(chunk.dataBase64, 'base64').toString()])
    });
    assert.deepEqual(received, [
      ['start', 'attachment-after-reconnect'],
      ['chunk', 'okay']
    ]);
  } finally {
    client.stop();
    await new Promise((resolve) => server.close(resolve));
    if (previousEndpoint === undefined) delete process.env.LANTERN_RELAY_URL;
    else process.env.LANTERN_RELAY_URL = previousEndpoint;
  }
});

test('cliente não cria fila paralela incompatível com a entrega serial do Relay', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const previousEndpoint = process.env.LANTERN_RELAY_URL;
  process.env.LANTERN_RELAY_URL = `ws://127.0.0.1:${address.port}`;

  let connected = false;
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const envelope = JSON.parse(raw.toString());
      if (envelope.type === 'relay:hello') {
        socket.send(JSON.stringify({ type: 'relay:hello:ok', payload: {} }));
        return;
      }
      if (envelope.type !== 'relay:attachment:request') return;
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      const { requestId, attachmentId } = envelope.payload;
      setTimeout(() => {
        socket.send(JSON.stringify({
          type: 'relay:attachment:start',
          payload: { requestId, attachmentId, messageId: `message-${attachmentId}`, size: 1, sha256: 'test', totalChunks: 1 }
        }));
        socket.send(JSON.stringify({
          type: 'relay:attachment:data',
          payload: { requestId, attachmentId, index: 0, total: 1, dataBase64: Buffer.from('x').toString('base64') }
        }));
        socket.send(JSON.stringify({
          type: 'relay:attachment:download:complete',
          payload: { requestId, attachmentId }
        }));
        activeRequests -= 1;
      }, 40);
    });
  });

  const client = new RelayClient({
    deviceId: 'attachment-serial-user',
    displayName: 'Attachment Serial',
    avatarEmoji: '📎',
    avatarBg: '#5b5fc7',
    statusMessage: 'Disponível'
  }, {
    onFrame: () => undefined,
    onPresence: () => undefined,
    onConnectionState: (state) => { connected = state.connected; }
  }, 'test-session-token');

  try {
    await client.start();
    await waitFor(() => connected);
    await Promise.all(Array.from({ length: 5 }, (_, index) =>
      client.downloadCentralAttachment(`attachment-${index}`, {
        onStart: () => undefined,
        onChunk: () => undefined
      })
    ));
    assert.equal(maximumActiveRequests, 1);
  } finally {
    client.stop();
    await new Promise((resolve) => server.close(resolve));
    if (previousEndpoint === undefined) delete process.env.LANTERN_RELAY_URL;
    else process.env.LANTERN_RELAY_URL = previousEndpoint;
  }
});
