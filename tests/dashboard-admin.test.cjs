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
    const sharedRenderer = fs.readFileSync(path.join(__dirname, '..', 'relay-ui', 'renderer', 'index.html'), 'utf8')
      .replace('../../assets/icon.png', '/lantern-icon.png')
      .replace('./styles.css', '/dashboard-assets/styles.css')
      .replace('./web-adapter.js', '/dashboard-assets/web-adapter.js')
      .replace('./app.js', '/dashboard-assets/app.js');
    assert.equal(dashboardHtml, sharedRenderer, 'a dashboard web deve usar exatamente o HTML do Relay UI');
    assert.match(dashboardHtml, /id="metric-accounts"/);
    assert.match(dashboardHtml, /id="metric-storage-total"/);
    assert.match(dashboardHtml, /class="page-section overview-section"/);
    assert.match(dashboardHtml, /href="#activity"/);
    assert.match(dashboardHtml, /href="#accounts"/);
    assert.match(dashboardHtml, /href="#password-resets"/);
    assert.match(dashboardHtml, /href="#client-updates"/);
    assert.match(dashboardHtml, /href="#connection"/);
    const styles = await (await fetch(`${baseUrl}/dashboard-assets/styles.css`)).text();
    const appScript = await (await fetch(`${baseUrl}/dashboard-assets/app.js`)).text();
    const adapterScript = await (await fetch(`${baseUrl}/dashboard-assets/web-adapter.js`)).text();
    assert.equal(styles, fs.readFileSync(path.join(__dirname, '..', 'relay-ui', 'renderer', 'styles.css'), 'utf8'));
    assert.equal(appScript, fs.readFileSync(path.join(__dirname, '..', 'relay-ui', 'renderer', 'app.js'), 'utf8'));
    assert.equal(adapterScript, fs.readFileSync(path.join(__dirname, '..', 'relay-ui', 'renderer', 'web-adapter.js'), 'utf8'));
    assert.doesNotThrow(() => new Function(appScript));
    assert.doesNotThrow(() => new Function(adapterScript));
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
    const status = await statusResponse.json();
    assert.equal(status.ok, true);
    assert.equal(Number.isFinite(status.totalStorageBytes), true);
    assert.equal(status.totalStorageBytes > 0, true);
    const relayUiStatusResponse = await fetch(`${baseUrl}/api/admin/relay-ui/status`, {
      headers: { cookie: secondTab.cookie }
    });
    assert.equal(relayUiStatusResponse.status, 200);
    const relayUiStatus = await relayUiStatusResponse.json();
    assert.equal(relayUiStatus.state.running, true);
    assert.equal(relayUiStatus.state.centralStore.users, 1);
    const relayUiManagementResponse = await fetch(`${baseUrl}/api/admin/relay-ui/management`, {
      headers: { cookie: secondTab.cookie }
    });
    assert.equal(relayUiManagementResponse.status, 200);
    assert.equal((await relayUiManagementResponse.json()).management.users.length, 1);

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
