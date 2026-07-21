const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { CentralStore } = require('../dist-relay/centralStore.js');

const createTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-central-state-'));
const silentLog = () => undefined;
const createAdmin = (store) => store.createUser({
  username: 'admin-test', displayName: 'Admin Test', password: 'admin-test-password', role: 'admin'
});

test('credencial headless legada vira primeiro acesso sem senha apenas para a conta criada pelo bootstrap', () => {
  const root = createTempDir();
  try {
    const store = new CentralStore(path.join(root, 'central'), silentLog);
    const legacy = store.createUser({
      username: 'admin', displayName: 'Administrador', password: 'lantern-admin',
      role: 'admin', allowBootstrapPassword: true
    }, 'headless-bootstrap');
    assert.equal(store.migrateLegacyHeadlessAdministrator('admin', 'lantern-admin'), true);
    assert.equal(store.getUser(legacy.userId).passwordSetupRequired, true);
    assert.equal(store.login('admin', '', 'migrated-first-access').user.passwordSetupRequired, true);
    assert.equal(store.migrateLegacyHeadlessAdministrator('admin', 'lantern-admin'), false);
    store.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('um Relay novo começa sem conta administrativa padrão', () => {
  const root = createTempDir();
  try {
    const store = new CentralStore(path.join(root, 'central'), silentLog);
    assert.deepEqual(store.listUsers(), []);
    const user = store.createUser({ username: 'owner-test', displayName: 'Owner Test', password: 'owner-test-password' });
    assert.equal(user.role, 'user');
    assert.equal(store.setUserRole(user.userId, 'admin', 'relay-ui').role, 'admin');
    assert.equal(store.setUserRole(user.userId, 'user', 'relay-ui').role, 'user');
    store.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('estado canônico é cifrado e sobrevive à reabertura do SQLite', () => {
  const root = createTempDir();
  const dataDir = path.join(root, 'central');
  const previousPassword = process.env.LANTERN_RELAY_ADMIN_PASSWORD;
  process.env.LANTERN_RELAY_ADMIN_PASSWORD = 'admin-test-password';

  try {
    const first = new CentralStore(dataDir, silentLog);
    const expected = {
      version: 1,
      secretMarker: 'conteudo-que-nao-pode-ficar-em-texto-puro',
      rows: [{ id: 'one', value: 42 }]
    };
    first.writeCanonicalState('test-state', expected);
    const databaseFile = first.getDatabaseFile();
    first.close();

    const database = new Database(databaseFile, { readonly: true });
    const stored = database
      .prepare('SELECT version, valueCipher FROM canonical_state WHERE key = ?')
      .get('test-state');
    database.close();
    assert.equal(stored.version, 1);
    assert.match(stored.valueCipher, /^gcm-v1\./);
    assert.equal(stored.valueCipher.includes(expected.secretMarker), false);

    const reopened = new CentralStore(dataDir, silentLog);
    assert.deepEqual(reopened.readCanonicalState('test-state'), expected);
    assert.throws(
      () => reopened.readCanonicalState('test-state', 2),
      /Versão incompatível/
    );
    reopened.close();
  } finally {
    if (previousPassword === undefined) delete process.env.LANTERN_RELAY_ADMIN_PASSWORD;
    else process.env.LANTERN_RELAY_ADMIN_PASSWORD = previousPassword;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resultados idempotentes sobrevivem à reabertura sem expor o conteúdo no SQLite', () => {
  const root = createTempDir();
  const dataDir = path.join(root, 'central');
  try {
    const store = new CentralStore(dataDir, silentLog);
    const user = store.createUser({
      username: 'idempotent-user', displayName: 'Idempotent User', password: 'idempotent-password'
    });
    store.saveCanonicalRequestResult('request-one', user.userId, 'group.create', {
      response: { groupId: 'group-secret-marker' },
      events: []
    });
    const databaseFile = store.getDatabaseFile();
    store.close();

    const database = new Database(databaseFile, { readonly: true });
    const row = database.prepare(`
      SELECT action, resultCipher FROM canonical_request_results WHERE requestId = ?
    `).get('request-one');
    database.close();
    assert.equal(row.action, 'group.create');
    assert.match(row.resultCipher, /^gcm-v1\./);
    assert.equal(row.resultCipher.includes('group-secret-marker'), false);

    const reopened = new CentralStore(dataDir, silentLog);
    assert.deepEqual(
      reopened.getCanonicalRequestResult('request-one', user.userId),
      {
        action: 'group.create',
        result: { response: { groupId: 'group-secret-marker' }, events: [] }
      }
    );
    assert.equal(reopened.getCanonicalRequestResult('request-one', 'another-user'), null);
    reopened.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pesquisa, anexos, auditoria e backup permanecem canônicos e cifrados', async () => {
  const root = createTempDir();
  const dataDir = path.join(root, 'central');
  const previousPassword = process.env.LANTERN_RELAY_ADMIN_PASSWORD;
  process.env.LANTERN_RELAY_ADMIN_PASSWORD = 'admin-test-password';
  try {
    const store = new CentralStore(dataDir, silentLog);
    const admin = createAdmin(store);
    const peer = store.createUser({
      username: 'search-peer', displayName: 'Search Peer', password: 'search-peer-password'
    });
    store.saveFrame({
      messageId: 'search-message', type: 'chat:text', senderUserId: admin.userId,
      targetUserId: peer.userId, conversationId: `dm:${[admin.userId, peer.userId].sort().join(':')}`,
      createdAt: Date.now(), payload: { text: 'agulha canônica' }
    });
    assert.deepEqual(
      store.searchConversationMessageIds(admin.userId, peer.userId, 'AGULHA'),
      ['search-message']
    );

    const bytes = Buffer.from('conteudo-anexo-canonico');
    const sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    store.initAttachment({
      attachmentId: 'attachment-search', messageId: 'search-message', ownerUserId: admin.userId,
      conversationId: `dm:${[admin.userId, peer.userId].sort().join(':')}`,
      fileName: 'segredo.txt', mimeType: 'text/plain', size: bytes.length, sha256
    });
    store.appendAttachmentChunk('attachment-search', admin.userId, 0, bytes);
    store.completeAttachment('attachment-search', admin.userId);
    assert.deepEqual(store.readAttachmentChunk('attachment-search', peer.userId, 0), bytes);
    const rawChunk = fs.readFileSync(path.join(dataDir, 'attachments', 'attachment-search', '0.bin'));
    assert.equal(rawChunk.includes(bytes), false);

    const backup = await store.createBackup();
    assert.equal(fs.existsSync(backup.file), true);
    assert.equal(fs.existsSync(path.join(backup.file, 'central', 'master.key')), true);
    assert.equal(fs.existsSync(path.join(backup.file, 'central', 'attachments', 'attachment-search', '0.bin')), true);
    assert.equal(fs.existsSync(path.join(backup.file, 'manifest.json')), true);
    assert.equal(backup.size > 0, true);
    assert.equal(store.listAudit().some((entry) => entry.action === 'backup.created'), true);
    store.close();

    const restoredDir = path.join(root, 'restored-central');
    fs.cpSync(path.join(backup.file, 'central'), restoredDir, { recursive: true });
    const restored = new CentralStore(restoredDir, silentLog);
    assert.deepEqual(
      restored.searchConversationMessageIds(admin.userId, peer.userId, 'canônica'),
      ['search-message']
    );
    assert.deepEqual(restored.readAttachmentChunk('attachment-search', peer.userId, 0), bytes);
    restored.close();
  } finally {
    if (previousPassword === undefined) delete process.env.LANTERN_RELAY_ADMIN_PASSWORD;
    else process.env.LANTERN_RELAY_ADMIN_PASSWORD = previousPassword;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cursor do servidor pagina mensagens sem lacunas mesmo com timestamps iguais', () => {
  const root = createTempDir();
  const dataDir = path.join(root, 'central');
  const previousPassword = process.env.LANTERN_RELAY_ADMIN_PASSWORD;
  process.env.LANTERN_RELAY_ADMIN_PASSWORD = 'admin-test-password';
  try {
    const store = new CentralStore(dataDir, silentLog);
    const admin = createAdmin(store);
    const peer = store.createUser({
      username: 'cursor-peer', displayName: 'Cursor Peer', password: 'cursor-peer-password'
    });
    const createdAt = Date.now();
    for (const messageId of ['cursor-1', 'cursor-2', 'cursor-3']) {
      store.saveFrame({
        messageId, type: 'chat:text', senderUserId: admin.userId,
        targetUserId: peer.userId,
        conversationId: `dm:${[admin.userId, peer.userId].sort().join(':')}`,
        createdAt, payload: { text: messageId }
      });
    }
    const latest = store.listConversationFramesForUser(admin.userId, peer.userId, Number.MAX_SAFE_INTEGER, 2);
    assert.deepEqual(latest.map((frame) => frame.messageId), ['cursor-2', 'cursor-3']);
    const older = store.listConversationFramesForUser(
      admin.userId, peer.userId, createdAt, 2, latest[0].serverSeq
    );
    assert.deepEqual(older.map((frame) => frame.messageId), ['cursor-1']);
    store.close();
  } finally {
    if (previousPassword === undefined) delete process.env.LANTERN_RELAY_ADMIN_PASSWORD;
    else process.env.LANTERN_RELAY_ADMIN_PASSWORD = previousPassword;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sincronização incremental usa sequência canônica e deduplica reenvios', () => {
  const root = createTempDir();
  try {
    const store = new CentralStore(path.join(root, 'central'), silentLog);
    const first = createAdmin(store);
    const second = store.createUser({
      username: 'incremental-peer', displayName: 'Incremental Peer', password: 'incremental-peer-password'
    });
    const conversationId = `dm:${[first.userId, second.userId].sort().join(':')}`;
    const base = Date.now();
    for (let index = 1; index <= 3; index += 1) {
      const frame = {
        messageId: `incremental-${index}`,
        type: 'chat:text', senderUserId: first.userId, targetUserId: second.userId,
        conversationId, createdAt: base + index, payload: { text: `mensagem ${index}` }
      };
      assert.equal(store.saveFrame(frame), 'inserted');
      if (index === 2) assert.equal(store.saveFrame(frame), 'duplicate');
    }
    const firstPage = store.listFramesForUserAfterSeq(second.userId, 0, 2);
    assert.deepEqual(firstPage.map((frame) => frame.messageId), ['incremental-1', 'incremental-2']);
    const secondPage = store.listFramesForUserAfterSeq(
      second.userId,
      firstPage[firstPage.length - 1].serverSeq,
      2
    );
    assert.deepEqual(secondPage.map((frame) => frame.messageId), ['incremental-3']);
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('diretório só oculta contas desativadas e limpa estados antigos de contato esquecido', () => {
  const root = createTempDir();
  const dataDir = path.join(root, 'central');
  const previousPassword = process.env.LANTERN_RELAY_ADMIN_PASSWORD;
  process.env.LANTERN_RELAY_ADMIN_PASSWORD = 'admin-test-password';
  try {
    const store = new CentralStore(dataDir, silentLog);
    const admin = createAdmin(store);
    const peer = store.createUser({
      username: 'visible-peer', displayName: 'Visible Peer', department: 'Produto',
      password: 'visible-peer-password'
    });
    store.clearConversationForUser(admin.userId, peer.userId);
    const databaseFile = store.getDatabaseFile();
    store.close();

    const database = new Database(databaseFile);
    database.prepare(`
      UPDATE user_conversation_state SET forgotten = 1
      WHERE userId = ? AND peerUserId = ?
    `).run(admin.userId, peer.userId);
    database.close();

    const reopened = new CentralStore(dataDir, silentLog);
    assert.deepEqual(
      reopened.listVisibleUsersForUser(admin.userId).map((user) => user.userId),
      [peer.userId]
    );
    assert.equal(reopened.isUserVisibleTo(admin.userId, peer.userId), true);
    reopened.updateUser(peer.userId, { disabled: true });
    assert.deepEqual(reopened.listVisibleUsersForUser(admin.userId), []);
    assert.equal(reopened.isUserVisibleTo(admin.userId, peer.userId), false);
    reopened.updateUser(peer.userId, { disabled: false });
    assert.equal(reopened.listVisibleUsersForUser(admin.userId)[0].department, 'Produto');
    reopened.close();
  } finally {
    if (previousPassword === undefined) delete process.env.LANTERN_RELAY_ADMIN_PASSWORD;
    else process.env.LANTERN_RELAY_ADMIN_PASSWORD = previousPassword;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('onboarding e preferências do usuário persistem no Relay canônico', () => {
  const root = createTempDir();
  const dataDir = path.join(root, 'central');
  const previousPassword = process.env.LANTERN_RELAY_ADMIN_PASSWORD;
  process.env.LANTERN_RELAY_ADMIN_PASSWORD = 'admin-test-password';
  try {
    const store = new CentralStore(dataDir, silentLog);
    const user = store.createUser({
      username: 'first-login', displayName: 'Primeiro Login', password: 'first-login-password'
    });
    assert.equal(user.profileSetupCompleted, false);
    const configured = store.completeProfileSetup(user.userId, {
      avatarEmoji: '🦊', avatarBg: '#4f6bed'
    });
    assert.equal(configured.profileSetupCompleted, true);
    assert.equal(configured.avatarEmoji, '🦊');

    store.setUserConversationPreference(user.userId, {
      conversationId: 'dm:peer', pinned: true, archived: true, manualUnread: true
    });
    store.setUserMessagePreference(user.userId, {
      messageId: 'favorite-message', favorite: true, hidden: true
    });
    store.close();

    const reopened = new CentralStore(dataDir, silentLog);
    assert.equal(reopened.getUser(user.userId).profileSetupCompleted, true);
    const preferences = reopened.getUserPreferences(user.userId);
    assert.deepEqual(preferences.conversations[0], {
      conversationId: 'dm:peer', pinned: true, archived: true, manualUnread: true,
      readAt: 0, updatedAt: preferences.conversations[0].updatedAt
    });
    assert.deepEqual(preferences.messages[0], {
      messageId: 'favorite-message', favorite: true, hidden: true,
      updatedAt: preferences.messages[0].updatedAt
    });
    reopened.close();
  } finally {
    if (previousPassword === undefined) delete process.env.LANTERN_RELAY_ADMIN_PASSWORD;
    else process.env.LANTERN_RELAY_ADMIN_PASSWORD = previousPassword;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('conta administrativa cria a própria senha no primeiro acesso sem liberar sessão provisória', () => {
  const root = createTempDir();
  const dataDir = path.join(root, 'central');
  try {
    const store = new CentralStore(dataDir, silentLog);
    const user = store.createUser({
      username: 'first-password',
      displayName: 'Primeira Senha',
      role: 'admin',
      passwordSetupRequired: true
    }, 'relay-ui');
    assert.equal(user.passwordSetupRequired, true);
    assert.equal(user.profileSetupCompleted, false);
    assert.throws(() => store.login(user.username, 'qualquer-senha', 'wrong-device'), /inválidos/);
    assert.throws(() => store.createAdminSession(user.username, ''), /inválidos/);

    const firstSession = store.login(user.username, '', 'first-device');
    const competingSession = store.login(user.username, '', 'second-device');
    assert.equal(firstSession.user.passwordSetupRequired, true);
    assert.equal(store.authenticateReady(firstSession.token), null);

    const completed = store.completeInitialPassword(
      user.userId,
      'senha-definitiva-segura',
      firstSession.token
    );
    assert.equal(completed.passwordSetupRequired, false);
    assert.ok(store.authenticateReady(firstSession.token));
    assert.equal(store.authenticate(competingSession.token), null);
    assert.throws(() => store.login(user.username, '', 'empty-after-setup'), /inválidos/);
    assert.ok(store.login(user.username, 'senha-definitiva-segura', 'normal-device'));
    assert.ok(store.createAdminSession(user.username, 'senha-definitiva-segura').token);
    assert.throws(
      () => store.completeInitialPassword(user.userId, 'outra-senha-segura', firstSession.token),
      /não possui uma senha inicial pendente/
    );
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exportação canônica não depende do cache e respeita edições, exclusões e ocultações', () => {
  const root = createTempDir();
  const dataDir = path.join(root, 'central');
  const previousPassword = process.env.LANTERN_RELAY_ADMIN_PASSWORD;
  process.env.LANTERN_RELAY_ADMIN_PASSWORD = 'admin-test-password';
  try {
    const store = new CentralStore(dataDir, silentLog);
    const admin = createAdmin(store);
    const peer = store.createUser({ username: 'export-peer', displayName: 'Export Peer', password: 'export-peer-password' });
    const conversationId = `dm:${[admin.userId, peer.userId].sort().join(':')}`;
    const base = Date.now();
    store.saveFrame({ messageId: 'export-1', type: 'chat:text', senderUserId: admin.userId, targetUserId: peer.userId, conversationId, createdAt: base, payload: { text: 'original' } });
    store.saveFrame({ messageId: 'edit-1', type: 'chat:edit', senderUserId: admin.userId, targetUserId: peer.userId, conversationId, createdAt: base + 1, payload: { targetMessageId: 'export-1', text: 'editada', editedAt: base + 1 } });
    store.saveFrame({ messageId: 'export-2', type: 'chat:text', senderUserId: peer.userId, targetUserId: admin.userId, conversationId, createdAt: base + 2, payload: { text: 'oculta' } });
    store.saveFrame({ messageId: 'export-3', type: 'chat:text', senderUserId: peer.userId, targetUserId: admin.userId, conversationId, createdAt: base + 3, payload: { text: 'apagada' } });
    store.saveFrame({ messageId: 'delete-3', type: 'chat:delete', senderUserId: peer.userId, targetUserId: admin.userId, conversationId, createdAt: base + 4, payload: { targetMessageId: 'export-3' } });
    store.setUserMessagePreference(admin.userId, { messageId: 'export-2', hidden: true });
    assert.deepEqual(store.exportConversationMessages(admin.userId, peer.userId).map((message) => ({ id: message.messageId, text: message.text })), [
      { id: 'export-1', text: 'editada' }
    ]);
    store.close();
  } finally {
    if (previousPassword === undefined) delete process.env.LANTERN_RELAY_ADMIN_PASSWORD;
    else process.env.LANTERN_RELAY_ADMIN_PASSWORD = previousPassword;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('redefinição de senha exige aprovação e troca autenticada preserva apenas a sessão atual', () => {
  const root = createTempDir();
  const dataDir = path.join(root, 'central');
  const previousPassword = process.env.LANTERN_RELAY_ADMIN_PASSWORD;
  process.env.LANTERN_RELAY_ADMIN_PASSWORD = 'admin-test-password';
  try {
    const store = new CentralStore(dataDir, silentLog);
    const user = store.createUser({
      username: 'password-user', displayName: 'Password User', password: 'password-before'
    });
    const reset = store.requestPasswordReset(user.username);
    assert.ok(reset);
    assert.equal(store.getPasswordResetStatus(reset.token), 'pending');
    assert.throws(
      () => store.completePasswordReset(reset.token, user.username, 'password-after'),
      /não foi aprovada/
    );
    const pending = store.listPasswordResetRequests();
    assert.equal(pending.length, 1);
    store.reviewPasswordResetRequest(pending[0].requestId, true, 'admin-test');
    assert.equal(store.getPasswordResetStatus(reset.token), 'approved');
    store.completePasswordReset(reset.token, user.username, 'password-after');
    assert.equal(store.getPasswordResetStatus(reset.token), 'consumed');
    assert.throws(() => store.login(user.username, 'password-before', 'old-device'), /inválidos/);

    const current = store.login(user.username, 'password-after', 'current-device');
    const other = store.login(user.username, 'password-after', 'other-device');
    store.changePassword(user.userId, 'password-after', 'password-final', current.token);
    assert.ok(store.authenticate(current.token));
    assert.equal(store.authenticate(other.token), null);
    assert.throws(() => store.login(user.username, 'password-after', 'failed-device'), /inválidos/);
    assert.ok(store.login(user.username, 'password-final', 'new-device'));
    store.close();
  } finally {
    if (previousPassword === undefined) delete process.env.LANTERN_RELAY_ADMIN_PASSWORD;
    else process.env.LANTERN_RELAY_ADMIN_PASSWORD = previousPassword;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('usuário lista e revoga somente as próprias sessões', () => {
  const root = createTempDir();
  try {
    const store = new CentralStore(path.join(root, 'central'), silentLog);
    const firstUser = store.createUser({
      username: 'sessions-first', displayName: 'First User', password: 'sessions-first-password'
    });
    const secondUser = store.createUser({
      username: 'sessions-second', displayName: 'Second User', password: 'sessions-second-password'
    });
    const current = store.login(firstUser.username, 'sessions-first-password', 'first-current');
    const other = store.login(firstUser.username, 'sessions-first-password', 'first-other');
    const foreign = store.login(secondUser.username, 'sessions-second-password', 'second-device');

    const sessions = store.listUserSessions(firstUser.userId, current.token);
    assert.deepEqual(sessions.map((session) => session.deviceId).sort(), ['first-current', 'first-other']);
    assert.equal(sessions.filter((session) => session.current).length, 1);
    assert.equal(sessions.find((session) => session.current).deviceId, 'first-current');

    const otherId = sessions.find((session) => session.deviceId === 'first-other').sessionId;
    const foreignId = store.listUserSessions(secondUser.userId, foreign.token)[0].sessionId;
    assert.equal(store.revokeUserSession(firstUser.userId, foreignId), false);
    assert.ok(store.authenticate(foreign.token));
    assert.equal(store.revokeUserSession(firstUser.userId, otherId), true);
    assert.equal(store.authenticate(other.token), null);
    assert.ok(store.authenticate(current.token));
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
