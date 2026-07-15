const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createServer } = require('node:net');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-announcement-state-'));
const legacyFile = path.join(root, 'announcements.json');
process.env.LANTERN_RELAY_DATA_DIR = root;
process.env.LANTERN_RELAY_ANNOUNCEMENTS_FILE = legacyFile;
process.env.LANTERN_RELAY_GROUPS_FILE = path.join(root, 'groups.json');
process.env.LANTERN_RELAY_GROUP_ATTACHMENTS_DIR = path.join(root, 'group-attachments');
process.env.LANTERN_RELAY_STICKERS_DIR = path.join(root, 'stickers');
process.env.LANTERN_RELAY_ADMIN_PASSWORD = 'admin-test-password';
process.env.LANTERN_RELAY_LOG_LEVEL = 'error';

const { CentralStore } = require('../dist-relay/centralStore.js');
const { LanternRelay } = require('../dist-relay/main.js');

const silentLog = () => undefined;
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

const getFreePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

test('announcements.json cifrado é migrado e reaberto apenas pelo SQLite', async () => {
  const now = Date.now();
  const legacy = {
    version: 1,
    savedAt: now,
    announcements: [{
      messageId: 'announcement-one',
      createdAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000,
      expiredAt: null,
      deletedAt: null,
      reactionsByDeviceId: {},
      readByDeviceId: {},
      frame: {
        type: 'announce',
        messageId: 'announcement-one',
        from: 'author-one',
        to: null,
        createdAt: now,
        payload: { text: 'Anúncio persistente' }
      }
    }]
  };

  try {
    const port = await getFreePort();
    const bootstrap = new CentralStore(path.join(root, 'central'), silentLog);
    fs.writeFileSync(legacyFile, bootstrap.protectJson(legacy));
    bootstrap.close();

    const firstRelay = new LanternRelay(relayConfig(port));
    assert.equal(firstRelay.getDashboardSnapshot().announcementsActive, 1);
    await firstRelay.start();
    await firstRelay.stop('test-migration');

    fs.rmSync(legacyFile, { force: true });

    const persisted = new CentralStore(path.join(root, 'central'), silentLog);
    assert.equal(persisted.readCanonicalState('announcements').announcements.length, 1);
    persisted.close();

    const reopenedRelay = new LanternRelay(relayConfig(port));
    const snapshot = reopenedRelay.getDashboardSnapshot();
    assert.equal(snapshot.announcementsActive, 1);
    assert.equal(snapshot.announcements[0].text, 'Anúncio persistente');
    await reopenedRelay.start();

    const liveCreatedAt = Date.now();
    reopenedRelay.trackAnnouncement({
      type: 'announce',
      messageId: 'announcement-live',
      from: 'author-two',
      to: null,
      createdAt: liveCreatedAt,
      payload: { text: 'Anúncio gravado antes do ACK' }
    });

    // A gravação deve ser visível imediatamente, sem depender de debounce ou
    // de um encerramento gracioso do processo.
    const writeThroughStore = new CentralStore(path.join(root, 'central'), silentLog);
    assert.equal(writeThroughStore.readCanonicalState('announcements').announcements.length, 2);
    writeThroughStore.close();

    // Reinícios via npm/concurrently podem entregar mais de um sinal. Uma
    // segunda chamada de stop jamais pode persistir o mapa já esvaziado.
    await Promise.all([
      reopenedRelay.stop('test-reopen-first-signal'),
      reopenedRelay.stop('test-reopen-second-signal')
    ]);

    const afterRestartRelay = new LanternRelay(relayConfig(port));
    const afterRestartSnapshot = afterRestartRelay.getDashboardSnapshot();
    assert.equal(afterRestartSnapshot.announcementsActive, 2);
    assert.deepEqual(
      afterRestartSnapshot.announcements.map((item) => item.text).sort(),
      ['Anúncio gravado antes do ACK', 'Anúncio persistente'].sort()
    );
    await afterRestartRelay.start();
    await afterRestartRelay.stop('test-final-reopen');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
