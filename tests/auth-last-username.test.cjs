const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AuthService } = require('../dist-electron/authService.js');

test('último usuário digitado permanece disponível após falha de conexão no login', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-last-username-'));
  const originalFetch = global.fetch;
  global.fetch = async () => {
    const error = new Error('connection refused');
    error.code = 'ECONNREFUSED';
    throw error;
  };
  try {
    const auth = new AuthService(root);
    await assert.rejects(
      auth.login({
        relay: { mode: 'local-manual', host: '127.0.0.1', port: 43190, secure: false },
        username: '  gabriel  ', password: 'segredo', rememberMe: true
      })
    );

    assert.equal(auth.getState().lastUsername, 'gabriel');
    assert.equal(new AuthService(root).getState().lastUsername, 'gabriel');
    const persisted = JSON.parse(fs.readFileSync(path.join(root, 'client-config.json'), 'utf8'));
    assert.equal(persisted.lastUsername, 'gabriel');
    assert.equal(JSON.stringify(persisted).includes('segredo'), false);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
