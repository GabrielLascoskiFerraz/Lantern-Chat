const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createServer } = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const WebSocket = require('ws');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-initial-password-'));
process.env.LANTERN_RELAY_DATA_DIR = root;
process.env.LANTERN_RELAY_LOG_LEVEL = 'error';

const { CentralStore } = require('../dist-relay/centralStore.js');
const { LanternRelay } = require('../dist-relay/main.js');

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});

const json = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  return { response, body: await response.json() };
};

test('sessão sem senha só pode criar a senha antes de acessar HTTP ou WebSocket', async () => {
  const bootstrap = new CentralStore(path.join(root, 'central'), () => undefined);
  bootstrap.createUser({
    username: 'pending-user',
    displayName: 'Pending User',
    passwordSetupRequired: true
  }, 'relay-ui');
  bootstrap.close();

  const port = await freePort();
  const relay = new LanternRelay({
    host: '127.0.0.1', port, pingIntervalMs: 60_000, peerTimeoutMs: 120_000,
    presenceBroadcastIntervalMs: 60_000, maxPayloadBytes: 8 * 1024 * 1024,
    tlsCertFile: null, tlsKeyFile: null, externalMode: false
  });
  await relay.start();
  const base = `http://127.0.0.1:${port}`;
  try {
    const login = await json(`${base}/api/client/login`, {
      method: 'POST',
      body: JSON.stringify({ username: 'pending-user', password: '', deviceId: 'pending-device' })
    });
    assert.equal(login.response.status, 200);
    assert.equal(login.body.user.passwordSetupRequired, true);
    const token = login.body.token;

    const preferencesBefore = await json(`${base}/api/client/preferences`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(preferencesBefore.response.status, 401);

    const socketError = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      const timeout = setTimeout(() => reject(new Error('Timeout aguardando bloqueio do WebSocket.')), 3_000);
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'relay:welcome') {
          socket.send(JSON.stringify({
            type: 'relay:hello',
            payload: {
              deviceId: 'pending-device', displayName: 'Pending User', avatarEmoji: '🙂',
              avatarBg: '#147ad6', appVersion: 'test', sessionToken: token
            }
          }));
        }
        if (message.type === 'relay:error') {
          clearTimeout(timeout);
          resolve(message.payload);
          socket.close();
        }
      });
      socket.on('error', reject);
    });
    assert.equal(socketError.code, 'PASSWORD_SETUP_REQUIRED');

    const setup = await json(`${base}/api/client/initial-password`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ newPassword: 'senha-pessoal-segura' })
    });
    assert.equal(setup.response.status, 200);
    assert.equal(setup.body.user.passwordSetupRequired, false);

    const preferencesAfter = await json(`${base}/api/client/preferences`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(preferencesAfter.response.status, 200);

    const blankAfter = await json(`${base}/api/client/login`, {
      method: 'POST',
      body: JSON.stringify({ username: 'pending-user', password: '', deviceId: 'blank-after' })
    });
    assert.equal(blankAfter.response.status, 401);
    const normalLogin = await json(`${base}/api/client/login`, {
      method: 'POST',
      body: JSON.stringify({ username: 'pending-user', password: 'senha-pessoal-segura', deviceId: 'normal' })
    });
    assert.equal(normalLogin.response.status, 200);
  } finally {
    await relay.stop('initial-password-test');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
