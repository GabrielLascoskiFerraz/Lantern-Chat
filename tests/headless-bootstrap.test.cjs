const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createServer } = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-headless-bootstrap-'));
process.env.LANTERN_RELAY_DATA_DIR = root;
process.env.LANTERN_RELAY_LOG_LEVEL = 'error';
delete process.env.LANTERN_RELAY_ADMIN_USERNAME;
delete process.env.LANTERN_RELAY_ADMIN_PASSWORD;

const { LanternRelay } = require('../dist-relay/main.js');

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});

test('Relay headless cria uma única conta administrativa temporária em banco vazio', async () => {
  const port = await freePort();
  const relay = new LanternRelay({
    host: '127.0.0.1', port, pingIntervalMs: 60_000, peerTimeoutMs: 120_000,
    presenceBroadcastIntervalMs: 60_000, maxPayloadBytes: 8 * 1024 * 1024,
    tlsCertFile: null, tlsKeyFile: null, externalMode: false
  });
  relay.bootstrapHeadlessAdministrator();
  relay.bootstrapHeadlessAdministrator();
  const users = relay.getManagementSnapshot().users;
  assert.equal(users.length, 1);
  assert.equal(users[0].username, 'admin');
  assert.equal(users[0].role, 'admin');
  assert.equal(users[0].passwordSetupRequired, false);

  await relay.start();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'lantern-admin' })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  } finally {
    await relay.stop('headless-bootstrap-test');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
