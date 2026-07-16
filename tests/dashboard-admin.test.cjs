const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createServer } = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-dashboard-admin-'));
process.env.LANTERN_RELAY_DATA_DIR = root;
process.env.LANTERN_RELAY_ANNOUNCEMENTS_FILE = path.join(root, 'announcements.json');
process.env.LANTERN_RELAY_GROUPS_FILE = path.join(root, 'groups.json');
process.env.LANTERN_RELAY_GROUP_ATTACHMENTS_DIR = path.join(root, 'group-attachments');
process.env.LANTERN_RELAY_STICKERS_DIR = path.join(root, 'stickers');
process.env.LANTERN_RELAY_ADMIN_PASSWORD = 'dashboard-test-password';
process.env.LANTERN_RELAY_LOG_LEVEL = 'error';

const { CentralStore } = require('../dist-relay/centralStore.js');
const { LanternRelay } = require('../dist-relay/main.js');

const relayConfig = (port) => ({
  host: '127.0.0.1', port, pingIntervalMs: 60_000, peerTimeoutMs: 120_000,
  presenceBroadcastIntervalMs: 60_000, maxPayloadBytes: 8 * 1024 * 1024,
  tlsCertFile: null, tlsKeyFile: null, externalMode: false
});

const getFreePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});

const login = async (baseUrl) => {
  const response = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'dashboard-admin', password: 'dashboard-test-password' })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  return {
    cookie: response.headers.get('set-cookie').split(';', 1)[0],
    csrfToken: body.csrfToken
  };
};

test('dashboard renova CSRF entre abas e persiste o setor no SQLite', async () => {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const bootstrap = new CentralStore(path.join(root, 'central'), () => undefined);
  const bootstrapAdmin = bootstrap.createUser({ username: 'dashboard-admin', displayName: 'Dashboard Admin', password: 'dashboard-test-password', role: 'admin' });
  bootstrap.completeProfileSetup(bootstrapAdmin.userId, { avatarEmoji: '🧪', avatarBg: '#147ad6' });
  bootstrap.close();
  const relay = new LanternRelay(relayConfig(port));
  try {
    await relay.start();

    const dashboardResponse = await fetch(`${baseUrl}/`);
    const dashboardHtml = await dashboardResponse.text();
    assert.match(dashboardHtml, /grid-template-columns:244px minmax\(0,1fr\)/);
    assert.match(dashboardHtml, /class="nav-icon"><svg/);
    assert.match(dashboardHtml, /--accent:\s*#5b5fc7/);
    assert.doesNotMatch(dashboardHtml, /Disponível somente no localhost/);
    assert.doesNotMatch(dashboardHtml, /id="new-password"/);
    assert.match(dashboardHtml, /entra com a senha vazia/);
    const script = dashboardHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';
    assert.ok(script.length > 0);
    assert.doesNotMatch(script, /\?\./, 'dashboard não deve exigir optional chaining no Safari');
    assert.doesNotThrow(() => new Function(script));
    assert.equal((await fetch(`${baseUrl}/api/status`)).status, 401);

    const firstTab = await login(baseUrl);
    const secondTab = await login(baseUrl);
    const usersResponse = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { cookie: secondTab.cookie }
    });
    assert.equal(usersResponse.status, 200);
    const users = (await usersResponse.json()).users;
    const admin = users.find((user) => user.username === 'dashboard-admin');
    assert.ok(admin);

    const staleCsrfResponse = await fetch(`${baseUrl}/api/admin/users/${admin.userId}`, {
      method: 'PATCH',
      headers: {
        cookie: secondTab.cookie,
        'content-type': 'application/json',
        'x-lantern-csrf': firstTab.csrfToken
      },
      body: JSON.stringify({ department: 'Incorreto' })
    });
    assert.equal(staleCsrfResponse.status, 401);

    const sessionResponse = await fetch(`${baseUrl}/api/admin/session`, {
      headers: { cookie: secondTab.cookie }
    });
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json();
    assert.equal(session.csrfToken, secondTab.csrfToken);
    const statusResponse = await fetch(`${baseUrl}/api/status`, { headers: { cookie: secondTab.cookie } });
    assert.equal(statusResponse.status, 200);
    assert.equal((await statusResponse.json()).ok, true);

    const temporaryAccountResponse = await fetch(`${baseUrl}/api/admin/users`, {
      method: 'POST',
      headers: {
        cookie: secondTab.cookie,
        'content-type': 'application/json',
        'x-lantern-csrf': session.csrfToken
      },
      body: JSON.stringify({ username: 'temporary-user', displayName: 'Temporary User', department: 'Teste' })
    });
    assert.equal(temporaryAccountResponse.status, 201);
    assert.equal((await temporaryAccountResponse.json()).user.passwordSetupRequired, true);
    const temporaryLogin = await fetch(`${baseUrl}/api/client/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'temporary-user', password: '', deviceId: 'temporary-first-access' })
    });
    assert.equal(temporaryLogin.status, 200);
    assert.equal((await temporaryLogin.json()).user.passwordSetupRequired, true);

    const updateResponse = await fetch(`${baseUrl}/api/admin/users/${admin.userId}`, {
      method: 'PATCH',
      headers: {
        cookie: secondTab.cookie,
        'content-type': 'application/json',
        'x-lantern-csrf': session.csrfToken
      },
      body: JSON.stringify({ department: 'Administração' })
    });
    assert.equal(updateResponse.status, 200);
    assert.equal((await updateResponse.json()).user.department, 'Administração');

    const installerBytes = Buffer.from('lantern-windows-installer-test');
    const installerUpload = await fetch(`${baseUrl}/api/admin/updates/win32`, {
      method: 'PUT',
      headers: {
        cookie: secondTab.cookie,
        'content-type': 'application/octet-stream',
        'content-length': String(installerBytes.length),
        'x-lantern-file-name': encodeURIComponent('Lantern-Setup-1.2.0.exe'),
        'x-lantern-csrf': session.csrfToken
      },
      body: installerBytes
    });
    assert.equal(installerUpload.status, 200);
    const managedUpdates = (await installerUpload.json()).updates;
    assert.equal(managedUpdates.installers.win32.fileName, 'Lantern-Setup-1.2.0.exe');

    const clientLogin = await fetch(`${baseUrl}/api/client/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'dashboard-admin', password: 'dashboard-test-password', deviceId: 'update-test-device' })
    });
    assert.equal(clientLogin.status, 200);
    const clientToken = (await clientLogin.json()).token;
    const updateManifestResponse = await fetch(`${baseUrl}/api/client/update?platform=win32`, {
      headers: { authorization: `Bearer ${clientToken}` }
    });
    assert.equal(updateManifestResponse.status, 200);
    const updateManifest = await updateManifestResponse.json();
    assert.equal(updateManifest.installer.sha256, managedUpdates.installers.win32.sha256);
    const installerDownload = await fetch(`${baseUrl}/api/client/update/download/win32`, {
      headers: { authorization: `Bearer ${clientToken}`, range: 'bytes=8-14' }
    });
    assert.equal(installerDownload.status, 206);
    assert.deepEqual(Buffer.from(await installerDownload.arrayBuffer()), installerBytes.subarray(8, 15));

    await Promise.all([relay.stop('dashboard-test'), relay.stop('dashboard-test-duplicate')]);
    const persisted = new CentralStore(path.join(root, 'central'), () => undefined);
    assert.equal(persisted.getUser(admin.userId).department, 'Administração');
    persisted.close();
  } finally {
    await relay.stop('dashboard-test-cleanup').catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
