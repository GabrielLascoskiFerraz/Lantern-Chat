const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { CentralStore } = require('../dist-relay/centralStore.js');

const createBackup = (root, profile, messages, configure) => {
  const backup = path.join(root, `LanternBackup-${profile.deviceId}`);
  fs.mkdirSync(path.join(backup, 'db'), { recursive: true });
  fs.mkdirSync(path.join(backup, 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify({ app: 'Lantern', version: '1.0.0', createdAt: 1000, profileDeviceId: profile.deviceId, profileName: profile.displayName, includesAttachments: true }));
  const db = new Database(path.join(backup, 'db', 'lantern.db'));
  db.exec(`
    CREATE TABLE profile(deviceId TEXT PRIMARY KEY, displayName TEXT, avatarEmoji TEXT, avatarBg TEXT, statusMessage TEXT, createdAt INTEGER, updatedAt INTEGER);
    CREATE TABLE messages(messageId TEXT PRIMARY KEY, conversationId TEXT, senderDeviceId TEXT, receiverDeviceId TEXT, type TEXT, bodyText TEXT, fileId TEXT, fileName TEXT, fileSize INTEGER, fileSha256 TEXT, filePath TEXT, deletedAt INTEGER, replyToMessageId TEXT, replyToSenderDeviceId TEXT, replyToType TEXT, replyToPreviewText TEXT, replyToFileName TEXT, forwardedFromMessageId TEXT, editedAt INTEGER, createdAt INTEGER);
    CREATE TABLE groups(groupId TEXT PRIMARY KEY, name TEXT, emoji TEXT, avatarBg TEXT, description TEXT, createdByDeviceId TEXT, createdAt INTEGER, updatedAt INTEGER, deletedAt INTEGER, allowMembersToPin INTEGER, allowMembersToEditInfo INTEGER);
    CREATE TABLE group_members(groupId TEXT, deviceId TEXT, role TEXT, status TEXT, displayNameSnapshot TEXT, avatarEmojiSnapshot TEXT, avatarBgSnapshot TEXT, joinedAt INTEGER, updatedAt INTEGER);
    CREATE TABLE group_pinned_messages(groupId TEXT, messageId TEXT, pinnedByDeviceId TEXT, pinnedAt INTEGER);
    CREATE TABLE conversations(id TEXT, kind TEXT, peerDeviceId TEXT, archivedAt INTEGER, lastReadAt INTEGER, unreadCount INTEGER);
    CREATE TABLE message_reactions(messageId TEXT, reactorDeviceId TEXT, reaction TEXT, updatedAt INTEGER, PRIMARY KEY(messageId, reactorDeviceId));
    CREATE TABLE announcement_reads(messageId TEXT, readerDeviceId TEXT, readAt INTEGER, PRIMARY KEY(messageId,readerDeviceId));
    CREATE TABLE message_favorites(messageId TEXT, createdAt INTEGER);
    CREATE TABLE hidden_messages(messageId TEXT, hiddenAt INTEGER);
  `);
  db.prepare('INSERT INTO profile VALUES (?, ?, ?, ?, ?, ?, ?)').run(profile.deviceId, profile.displayName, profile.avatarEmoji, profile.avatarBg, 'Disponível', 1000, 2000);
  const insert = db.prepare('INSERT INTO messages VALUES (@messageId,@conversationId,@senderDeviceId,@receiverDeviceId,@type,@bodyText,@fileId,@fileName,@fileSize,@fileSha256,@filePath,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,@createdAt)');
  for (const message of messages) insert.run(message);
  if (configure) configure(db, backup);
  db.close();
  return backup;
};

test('consolida backups locais em usuários, DMs, grupos e anexos canônicos', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-local-migration-'));
  const backups = path.join(root, 'backups');
  const relayData = path.join(root, 'relay-data');
  const report = path.join(root, 'report.json');
  fs.mkdirSync(backups, { recursive: true });
  const bytes = Buffer.from('anexo legado preservado');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const text = { messageId: 'message-text', conversationId: 'dm:device-b', senderDeviceId: 'device-a', receiverDeviceId: 'device-b', type: 'text', bodyText: 'Olá do histórico antigo', fileId: null, fileName: null, fileSize: null, fileSha256: null, filePath: null, createdAt: 3000 };
  const file = { messageId: 'message-file', conversationId: 'dm:device-a', senderDeviceId: 'device-b', receiverDeviceId: 'device-a', type: 'file', bodyText: null, fileId: 'file-legacy', fileName: 'foto.bin', fileSize: bytes.length, fileSha256: sha256, filePath: '/antigo/message-file_foto.bin', createdAt: 4000 };
  const groupMessage = { messageId: 'group-message', conversationId: 'group:group-one', senderDeviceId: 'device-a', receiverDeviceId: null, type: 'text', bodyText: 'Mensagem do grupo', fileId: null, fileName: null, fileSize: null, fileSha256: null, filePath: null, createdAt: 5000 };

  createBackup(backups, { deviceId: 'device-a', displayName: 'Alice', avatarEmoji: '🦊', avatarBg: '#147ad6' }, [text, groupMessage], (db) => {
    db.prepare('INSERT INTO groups VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('group-one', 'Equipe', '👥', '#5b5fc7', 'Grupo antigo', 'device-a', 2000, 5000, null, 1, 0);
    db.prepare('INSERT INTO group_members VALUES (?,?,?,?,?,?,?,?,?)').run('group-one', 'device-a', 'owner', 'active', 'Alice', '🦊', '#147ad6', 2000, 5000);
    db.prepare('INSERT INTO group_members VALUES (?,?,?,?,?,?,?,?,?)').run('group-one', 'device-b', 'member', 'active', 'Bob', '🐻', '#5b5fc7', 2000, 5000);
  });
  createBackup(backups, { deviceId: 'device-b', displayName: 'Bob', avatarEmoji: '🐻', avatarBg: '#5b5fc7' }, [{ ...text, conversationId: 'dm:device-a' }, file], (db, backup) => {
    db.prepare('INSERT INTO message_reactions VALUES (?,?,?,?)').run('message-text', 'device-b', '❤️', 3500);
    db.prepare('INSERT INTO message_reactions VALUES (?,?,?,?)').run('group-message', 'device-b', '👍', 5500);
    fs.writeFileSync(path.join(backup, 'attachments', 'message-file_foto.bin'), bytes);
  });

  const previousPassword = process.env.LANTERN_RELAY_ADMIN_PASSWORD;
  process.env.LANTERN_RELAY_ADMIN_PASSWORD = 'admin-test-password';
  try {
    const result = spawnSync(process.execPath, ['dist-relay/migrateLocalBackups.js', '--backups', backups, '--relay-data', relayData, '--report', report, '--apply'], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const migration = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(migration.applied, true);
    assert.equal(migration.counts.users, 2);
    assert.equal(migration.counts.directMessages, 2);
    assert.equal(migration.counts.reactions, 1);
    assert.equal(migration.counts.groups, 1);

    const store = new CentralStore(path.join(relayData, 'central'), () => undefined);
    const alice = store.listUsers().find((user) => user.username === 'alice');
    const bob = store.listUsers().find((user) => user.username === 'bob');
    assert.ok(alice && bob);
    const frames = store.listConversationFramesForUser(alice.userId, bob.userId, Number.MAX_SAFE_INTEGER, 100);
    assert.deepEqual(frames.map((frame) => frame.type), ['chat:text', 'chat:react', 'file:offer']);
    assert.equal(frames[1].payload.targetMessageId, 'message-text');
    assert.deepEqual(store.readAttachmentChunk('file-legacy', alice.userId, 0), bytes);
    const groups = store.readCanonicalState('groups');
    assert.equal(groups.groups.length, 1);
    assert.equal(groups.eventsByGroupId['group-one'].some((event) => event.payload?.message?.messageId === 'group-message'), true);
    assert.equal(groups.eventsByGroupId['group-one'].some((event) => event.type === 'group.message.reactionChanged' && event.payload?.targetMessageId === 'group-message'), true);
    store.close();
  } finally {
    if (previousPassword === undefined) delete process.env.LANTERN_RELAY_ADMIN_PASSWORD;
    else process.env.LANTERN_RELAY_ADMIN_PASSWORD = previousPassword;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
