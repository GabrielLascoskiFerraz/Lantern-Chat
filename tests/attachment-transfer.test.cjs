const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { createServer } = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const WebSocket = require('ws');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-attachment-transfer-'));
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

const relayConfig = (port) => ({
  host: '127.0.0.1', port, pingIntervalMs: 60_000, peerTimeoutMs: 120_000,
  presenceBroadcastIntervalMs: 60_000, maxPayloadBytes: 8 * 1024 * 1024,
  tlsCertFile: null, tlsKeyFile: null, externalMode: false
});

const waitFor = async (predicate, timeoutMs = 6_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timeout aguardando transferência do anexo.');
};

const connect = (port, auth, clientDeviceId) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = [];
  const timeout = setTimeout(() => reject(new Error('Timeout no hello.')), 5_000);
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

const sendAndWait = async (client, envelope, predicate) => {
  client.socket.send(JSON.stringify(envelope));
  return waitFor(() => client.messages.find(predicate));
};

test('anexos diretos, de anúncios e de grupos baixam imediatamente do Relay', async () => {
  const port = await getFreePort();
  const bootstrap = new CentralStore(path.join(root, 'central'), () => undefined);
  bootstrap.createUser({ username: 'attachment-sender', displayName: 'Attachment Sender', password: 'attachment-sender-password' });
  const recipientUser = bootstrap.createUser({
    username: 'attachment-peer', displayName: 'Attachment Peer', password: 'attachment-peer-password'
  });
  const senderAuth = bootstrap.login('attachment-sender', 'attachment-sender-password', 'attachment-sender');
  const recipientAuth = bootstrap.login('attachment-peer', 'attachment-peer-password', 'attachment-recipient');
  bootstrap.close();

  const relay = new LanternRelay(relayConfig(port));
  const sockets = [];
  try {
    await relay.start();
    const sender = await connect(port, senderAuth, 'attachment-sender');
    const recipient = await connect(port, recipientAuth, 'attachment-recipient');
    sockets.push(sender.socket, recipient.socket);

    const bytes = Buffer.from('anexo direto recuperado sem trocar de conversa');
    const attachmentId = randomUUID();
    const messageId = randomUUID();
    const conversationId = `dm:${[senderAuth.user.userId, recipientUser.userId].sort().join(':')}`;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    for (const [action, payload] of [
      ['init', { attachmentId, messageId, conversationId, fileName: 'direto.txt', size: bytes.length, sha256 }],
      ['chunk', { attachmentId, index: 0, dataBase64: bytes.toString('base64') }],
      ['complete', { attachmentId }]
    ]) {
      const requestId = randomUUID();
      await sendAndWait(sender, {
        type: `relay:attachment:${action}`,
        payload: { requestId, ...payload }
      }, (item) => item.type === 'relay:attachment:ack' && item.payload?.requestId === requestId);
    }
    await sendAndWait(sender, {
      type: 'relay:send',
      payload: { frame: {
        type: 'file:offer', messageId, from: senderAuth.user.userId,
        to: recipientUser.userId, createdAt: Date.now(),
        payload: { fileId: attachmentId, messageId, filename: 'direto.txt', size: bytes.length, sha256 }
      } }
    }, (item) => item.type === 'relay:send:ack' && item.payload?.frameMessageId === messageId);
    await waitFor(() => recipient.messages.some((item) =>
      item.type === 'relay:deliver' && item.payload?.frame?.messageId === messageId
    ));

    const directRequestId = randomUUID();
    recipient.socket.send(JSON.stringify({
      type: 'relay:attachment:request',
      payload: { requestId: directRequestId, attachmentId, startIndex: 0 }
    }));
    await waitFor(() => recipient.messages.some((item) =>
      item.type === 'relay:attachment:download:complete' && item.payload?.requestId === directRequestId
    ));
    const directChunks = recipient.messages
      .filter((item) => item.type === 'relay:attachment:data' && item.payload?.requestId === directRequestId)
      .sort((left, right) => left.payload.index - right.payload.index)
      .map((item) => Buffer.from(item.payload.dataBase64, 'base64'));
    assert.deepEqual(Buffer.concat(directChunks), bytes);
    const directWebResponse = await fetch(
      `http://127.0.0.1:${port}/api/client/attachments/${attachmentId}`,
      { headers: { authorization: `Bearer ${recipientAuth.token}` } }
    );
    assert.equal(directWebResponse.status, 200);
    assert.deepEqual(Buffer.from(await directWebResponse.arrayBuffer()), bytes);

    const announcementBytes = Buffer.from('GIF canônico publicado para todos');
    const announcementAttachmentId = randomUUID();
    const announcementMessageId = randomUUID();
    const announcementSha = createHash('sha256').update(announcementBytes).digest('hex');
    for (const [action, payload] of [
      ['init', { attachmentId: announcementAttachmentId, messageId: announcementMessageId, conversationId: 'announcements', fileName: 'comunicado.gif', mimeType: 'image/gif', size: announcementBytes.length, sha256: announcementSha }],
      ['chunk', { attachmentId: announcementAttachmentId, index: 0, dataBase64: announcementBytes.toString('base64') }],
      ['complete', { attachmentId: announcementAttachmentId }]
    ]) {
      const requestId = randomUUID();
      await sendAndWait(sender, {
        type: `relay:attachment:${action}`,
        payload: { requestId, ...payload }
      }, (item) => item.type === 'relay:attachment:ack' && item.payload?.requestId === requestId);
    }
    await sendAndWait(sender, {
      type: 'relay:send',
      payload: { frame: {
        type: 'file:offer', messageId: announcementMessageId, from: senderAuth.user.userId,
        to: null, createdAt: Date.now(),
        payload: {
          fileId: announcementAttachmentId, messageId: announcementMessageId,
          filename: 'comunicado.gif', size: announcementBytes.length, sha256: announcementSha
        }
      } }
    }, (item) => item.type === 'relay:send:ack' && item.payload?.frameMessageId === announcementMessageId);
    await waitFor(() => recipient.messages.some((item) =>
      item.type === 'relay:deliver' && item.payload?.frame?.messageId === announcementMessageId
    ));

    const announcementRequestId = randomUUID();
    recipient.socket.send(JSON.stringify({
      type: 'relay:attachment:request',
      payload: { requestId: announcementRequestId, attachmentId: announcementAttachmentId, startIndex: 0 }
    }));
    await waitFor(() => recipient.messages.some((item) =>
      item.type === 'relay:attachment:download:complete' && item.payload?.requestId === announcementRequestId
    ));
    const announcementChunks = recipient.messages
      .filter((item) => item.type === 'relay:attachment:data' && item.payload?.requestId === announcementRequestId)
      .sort((left, right) => left.payload.index - right.payload.index)
      .map((item) => Buffer.from(item.payload.dataBase64, 'base64'));
    assert.deepEqual(Buffer.concat(announcementChunks), announcementBytes);

    const reconnect = await connect(port, recipientAuth, 'attachment-recipient-reconnect');
    sockets.push(reconnect.socket);
    await waitFor(() => reconnect.messages.some((item) =>
      item.type === 'relay:announcement:snapshot' &&
      item.payload?.frames?.some((frame) => frame.messageId === announcementMessageId && frame.type === 'file:offer')
    ));

    const createId = randomUUID();
    const createAck = await sendAndWait(sender, {
      type: 'relay:group:request',
      payload: {
        requestId: createId, action: 'create',
        data: { name: 'Grupo de anexos', memberDeviceIds: [recipientUser.userId] }
      }
    }, (item) => item.type === 'relay:group:ack' && item.payload?.requestId === createId);
    assert.equal(createAck.payload.ok, true);
    const groupId = createAck.payload.group.groupId;
    const createAckCount = sender.messages.filter((item) =>
      item.type === 'relay:group:ack' && item.payload?.requestId === createId
    ).length;
    sender.socket.send(JSON.stringify({
      type: 'relay:group:request',
      payload: {
        requestId: createId, action: 'create',
        data: { name: 'Grupo de anexos', memberDeviceIds: [recipientUser.userId] }
      }
    }));
    const replayedCreateAck = await waitFor(() => {
      const matches = sender.messages.filter((item) =>
        item.type === 'relay:group:ack' && item.payload?.requestId === createId
      );
      return matches.length > createAckCount ? matches.at(-1) : null;
    });
    assert.equal(replayedCreateAck.payload.group.groupId, groupId);
    const groupBytes = Buffer.from('anexo de grupo recuperado imediatamente do relay');
    const groupFileId = randomUUID();
    const groupMessageId = randomUUID();
    const groupSha = createHash('sha256').update(groupBytes).digest('hex');
    const groupInitId = randomUUID();
    await sendAndWait(sender, {
      type: 'relay:group:request',
      payload: {
        requestId: groupInitId, action: 'file:init', data: {
          createdAt: Date.now(),
          offer: {
            groupId, fileId: groupFileId, messageId: groupMessageId,
            filename: 'grupo.txt', size: groupBytes.length, sha256: groupSha
          }
        }
      }
    }, (item) => item.type === 'relay:group:ack' && item.payload?.requestId === groupInitId);
    await sendAndWait(sender, {
      type: 'relay:group:file:chunk',
      payload: { fileId: groupFileId, index: 0, total: 1, dataBase64: groupBytes.toString('base64') }
    }, (item) => item.type === 'relay:group:file:chunk:ack' && item.payload?.fileId === groupFileId);
    const completeId = randomUUID();
    await sendAndWait(sender, {
      type: 'relay:group:file:complete', payload: { requestId: completeId, fileId: groupFileId }
    }, (item) => item.type === 'relay:group:ack' && item.payload?.requestId === completeId);
    await waitFor(() => recipient.messages.some((item) =>
      item.type === 'relay:group:event' &&
      item.payload?.event?.type === 'group.attachment.available' &&
      item.payload?.event?.payload?.metadata?.fileId === groupFileId
    ));

    const groupRequestId = randomUUID();
    recipient.socket.send(JSON.stringify({
      type: 'relay:group:file:request',
      payload: { requestId: groupRequestId, fileId: groupFileId, startIndex: 0 }
    }));
    await waitFor(() => recipient.messages.some((item) =>
      item.type === 'relay:group:file:complete' && item.payload?.requestId === groupRequestId
    ));
    const groupChunks = recipient.messages
      .filter((item) => item.type === 'relay:group:file:chunk' && item.payload?.requestId === groupRequestId)
      .sort((left, right) => left.payload.index - right.payload.index)
      .map((item) => Buffer.from(item.payload.dataBase64, 'base64'));
    assert.deepEqual(Buffer.concat(groupChunks), groupBytes);
    const groupWebResponse = await fetch(
      `http://127.0.0.1:${port}/api/client/attachments/${groupFileId}?scope=group`,
      { headers: { authorization: `Bearer ${recipientAuth.token}` } }
    );
    assert.equal(groupWebResponse.status, 200);
    assert.deepEqual(Buffer.from(await groupWebResponse.arrayBuffer()), groupBytes);
    assert.equal(recipient.socket.readyState, WebSocket.OPEN);

    for (const socket of sockets.splice(0)) socket.close();
    await Promise.all([
      relay.stop('test-restart-first-signal'),
      relay.stop('test-restart-second-signal')
    ]);

    // Simula exatamente o estado deixado pela versão defeituosa: a tabela de
    // anúncios foi esvaziada, mas o frame canônico e o anexo continuam no DB.
    const damagedStateStore = new CentralStore(path.join(root, 'central'), () => undefined);
    damagedStateStore.writeCanonicalState('announcements', { version: 1, announcements: [] });
    damagedStateStore.close();

    const restartedRelay = new LanternRelay(relayConfig(port));
    try {
      assert.equal(
        restartedRelay.getDashboardSnapshot().announcements.some(
          (item) => item.messageId === announcementMessageId
        ),
        true
      );
      await restartedRelay.start();
      const afterRestart = await connect(port, recipientAuth, 'attachment-recipient-after-restart');
      sockets.push(afterRestart.socket);
      await waitFor(() => afterRestart.messages.some((item) =>
        item.type === 'relay:announcement:snapshot' &&
        item.payload?.frames?.some((frame) => frame.messageId === announcementMessageId)
      ));
      const restoredWebResponse = await fetch(
        `http://127.0.0.1:${port}/api/client/attachments/${announcementAttachmentId}`,
        { headers: { authorization: `Bearer ${recipientAuth.token}` } }
      );
      assert.equal(restoredWebResponse.status, 200);
      assert.deepEqual(Buffer.from(await restoredWebResponse.arrayBuffer()), announcementBytes);

      const afterRestartRequestId = randomUUID();
      afterRestart.socket.send(JSON.stringify({
        type: 'relay:attachment:request',
        payload: {
          requestId: afterRestartRequestId,
          attachmentId: announcementAttachmentId,
          startIndex: 0
        }
      }));
      await waitFor(() => afterRestart.messages.some((item) =>
        item.type === 'relay:attachment:download:complete' &&
        item.payload?.requestId === afterRestartRequestId
      ));
    } finally {
      await restartedRelay.stop('test-restart-complete');
    }
  } finally {
    for (const socket of sockets) socket.close();
    await relay.stop('test');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
