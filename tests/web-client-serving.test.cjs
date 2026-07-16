const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createServer } = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-web-client-'));
const webRoot = path.join(root, 'dist-renderer');
fs.mkdirSync(path.join(webRoot, 'assets'), { recursive: true });
fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Lantern Web Test</title>');
fs.writeFileSync(path.join(webRoot, 'assets', 'client.js'), 'globalThis.lanternWebTest = true;');
process.env.LANTERN_RELAY_DATA_DIR = path.join(root, 'relay-data');
process.env.LANTERN_WEB_CLIENT_DIR = webRoot;
process.env.LANTERN_RELAY_LOG_LEVEL = 'error';

const { LanternRelay, resolveWebClientRoot } = require('../dist-relay/main.js');

const getFreePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});

test('Relay serve o cliente Web pelo recurso configurado sem depender do cwd', async () => {
  const port = await getFreePort();
  const relay = new LanternRelay({
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
  try {
    assert.equal(resolveWebClientRoot(), webRoot);
    await relay.start();

    const appResponse = await fetch(`http://127.0.0.1:${port}/app/`);
    assert.equal(appResponse.status, 200);
    assert.match(await appResponse.text(), /Lantern Web Test/);
    assert.match(appResponse.headers.get('content-type') || '', /text\/html/);

    const assetResponse = await fetch(`http://127.0.0.1:${port}/app/assets/client.js`);
    assert.equal(assetResponse.status, 200);
    assert.match(await assetResponse.text(), /lanternWebTest/);
    assert.match(assetResponse.headers.get('content-type') || '', /text\/javascript/);
  } finally {
    await relay.stop('web-client-test');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
