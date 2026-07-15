const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CentralStore } = require('../dist-relay/centralStore.js');

const createTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-media-'));
const silentLog = () => undefined;

const addAttachment = (store, owner, peer, input) => {
  const conversationId = `dm:${[owner.userId, peer.userId].sort().join(':')}`;
  const data = Buffer.from(input.contents);
  const attachmentId = `attachment-${input.messageId}`;
  store.initAttachment({
    attachmentId,
    messageId: input.messageId,
    ownerUserId: owner.userId,
    conversationId,
    fileName: input.fileName,
    mimeType: input.mimeType,
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex')
  });
  store.appendAttachmentChunk(attachmentId, owner.userId, 0, data);
  store.completeAttachment(attachmentId, owner.userId);
  store.saveFrame({
    messageId: input.messageId,
    type: 'file:offer',
    senderUserId: owner.userId,
    targetUserId: peer.userId,
    conversationId,
    createdAt: input.createdAt,
    payload: { fileId: attachmentId, fileName: input.fileName, mimeType: input.mimeType, fileSize: data.length }
  });
};

test('galeria canônica filtra, pagina e respeita preferências do usuário', () => {
  const root = createTempDir();
  try {
    const store = new CentralStore(path.join(root, 'central'), silentLog);
    const alice = store.createUser({ username: 'media-alice', displayName: 'Alice', password: 'media-alice-password' });
    const bob = store.createUser({ username: 'media-bob', displayName: 'Bob', password: 'media-bob-password' });
    const createdAt = Date.now();
    addAttachment(store, alice, bob, { messageId: 'media-1', fileName: 'primeira.png', mimeType: 'image/png', contents: 'one', createdAt });
    addAttachment(store, bob, alice, { messageId: 'media-2', fileName: 'segunda.gif', mimeType: 'image/gif', contents: 'two', createdAt });
    addAttachment(store, alice, bob, { messageId: 'media-3', fileName: 'contrato.pdf', mimeType: 'application/pdf', contents: 'three', createdAt: createdAt - 1 });

    const first = store.listConversationMedia(alice.userId, bob.userId, 'media', null, 1);
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].messageId, 'media-2');
    assert.equal(first.hasMore, true);
    assert.ok(first.nextCursor);
    const second = store.listConversationMedia(alice.userId, bob.userId, 'media', first.nextCursor, 1);
    assert.deepEqual(second.items.map((item) => item.messageId), ['media-1']);
    assert.equal(second.hasMore, false);

    assert.deepEqual(
      store.listConversationMedia(alice.userId, bob.userId, 'document').items.map((item) => item.fileName),
      ['contrato.pdf']
    );
    store.setUserMessagePreference(alice.userId, { messageId: 'media-2', hidden: true });
    assert.deepEqual(
      store.listConversationMedia(alice.userId, bob.userId, 'media').items.map((item) => item.messageId),
      ['media-1']
    );
    assert.deepEqual(
      store.listConversationMedia(bob.userId, alice.userId, 'media').items.map((item) => item.messageId),
      ['media-2', 'media-1']
    );
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('alteração feita pelo Relay UI é atômica e sobrevive à reabertura', () => {
  const root = createTempDir();
  const dataDir = path.join(root, 'central');
  try {
    const first = new CentralStore(dataDir, silentLog);
    const user = first.createUser({ username: 'managed-user', displayName: 'Managed User', password: 'managed-user-password' });
    const updated = first.updateManagedUserAtomic(user.userId, { department: 'Jurídico', role: 'admin' });
    assert.equal(updated.department, 'Jurídico');
    assert.equal(updated.role, 'admin');
    first.close();

    const reopened = new CentralStore(dataDir, silentLog);
    const persisted = reopened.getUser(user.userId);
    assert.equal(persisted.department, 'Jurídico');
    assert.equal(persisted.role, 'admin');
    assert.equal(reopened.listAudit().some((entry) => entry.action === 'user.management_updated'), true);
    reopened.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
