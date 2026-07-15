const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createServer } = require('node:net');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-multi-device-'));
process.env.LANTERN_RELAY_DATA_DIR = root;
process.env.LANTERN_RELAY_ANNOUNCEMENTS_FILE = path.join(root, 'announcements.json');
process.env.LANTERN_RELAY_GROUPS_FILE = path.join(root, 'groups.json');
process.env.LANTERN_RELAY_GROUP_ATTACHMENTS_DIR = path.join(root, 'group-attachments');
process.env.LANTERN_RELAY_STICKERS_DIR = path.join(root, 'stickers');
process.env.LANTERN_RELAY_ADMIN_PASSWORD = 'admin-test-password';
process.env.LANTERN_RELAY_LOG_LEVEL = 'error';

const { CentralStore } = require('../dist-relay/centralStore.js');
const { LanternRelay } = require('../dist-relay/main.js');

const getFreePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});

const config = (port) => ({
  host: '127.0.0.1', port, pingIntervalMs: 60_000, peerTimeoutMs: 120_000,
  presenceBroadcastIntervalMs: 60_000, maxPayloadBytes: 8 * 1024 * 1024,
  tlsCertFile: null, tlsKeyFile: null, externalMode: false
});

const connect = (port, token, user, clientDeviceId) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = [];
  const timeout = setTimeout(() => reject(new Error('Timeout no hello do teste.')), 5_000);
  socket.on('error', reject);
  socket.on('message', (raw) => {
    const envelope = JSON.parse(raw.toString());
    messages.push(envelope);
    if (envelope.type === 'relay:welcome') {
      socket.send(JSON.stringify({
        type: 'relay:hello',
        payload: {
          deviceId: clientDeviceId,
          displayName: user.displayName,
          avatarEmoji: user.avatarEmoji,
          avatarBg: user.avatarBg,
          appVersion: 'test',
          sessionToken: token
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
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timeout aguardando entrega do teste.');
};

test('um usuário mantém múltiplos dispositivos e recebe em todas as sessões', async () => {
  const port = await getFreePort();
  const store = new CentralStore(path.join(root, 'central'), () => undefined);
  const recipient = store.createUser({
    username: 'recipient', displayName: 'Recipient', password: 'recipient-password'
  });
  const senderAuth = store.login('admin', 'admin-test-password', 'sender-device');
  const senderAuthB = store.login('admin', 'admin-test-password', 'sender-device-b');
  const recipientAuthA = store.login('recipient', 'recipient-password', 'recipient-a');
  const recipientAuthB = store.login('recipient', 'recipient-password', 'recipient-b');
  store.close();

  const relay = new LanternRelay(config(port));
  const sockets = [];
  try {
    await relay.start();
    const sender = await connect(port, senderAuth.token, senderAuth.user, 'sender-device');
    const senderDeviceB = await connect(port, senderAuthB.token, senderAuthB.user, 'sender-device-b');
    const deviceA = await connect(port, recipientAuthA.token, recipient, 'recipient-a');
    const deviceB = await connect(port, recipientAuthB.token, recipient, 'recipient-b');
    sockets.push(sender.socket, senderDeviceB.socket, deviceA.socket, deviceB.socket);

    assert.equal(relay.getDashboardSnapshot().peersOnline, 2);
    assert.equal(relay.getDashboardSnapshot().sessionsOpen, 4);

    const messageId = randomUUID();
    sender.socket.send(JSON.stringify({
      type: 'relay:send',
      payload: {
        frame: {
          type: 'chat:text', messageId, from: senderAuth.user.userId,
          to: recipient.userId, createdAt: Date.now(), payload: { text: 'multi-device' }
        }
      }
    }));

    await waitFor(() => [deviceA, deviceB].every(({ messages }) =>
      messages.some((item) => item.type === 'relay:deliver' && item.payload?.frame?.messageId === messageId)
    ));
    await waitFor(() => senderDeviceB.messages.some((item) =>
      item.type === 'relay:deliver' && item.payload?.frame?.messageId === messageId
    ));
    await waitFor(() => sender.messages.some((item) =>
      item.type === 'relay:send:ack' && item.payload?.frameMessageId === messageId
    ));
    const ack = sender.messages.find((item) =>
      item.type === 'relay:send:ack' && item.payload?.frameMessageId === messageId
    );
    assert.deepEqual(ack.payload.deliveredTo, [recipient.userId]);
  } finally {
    for (const socket of sockets) socket.close();
    await relay.stop('test');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
