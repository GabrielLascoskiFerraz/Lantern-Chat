const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DbService } = require('../dist-electron/db.js');
const { prepareLanternUserDataPath } = require('../dist-electron/userDataPath.js');

test('inicialização cria diretórios e mantém instâncias A/B isoladas', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-user-data-'));
  try {
    const instanceA = prepareLanternUserDataPath(root, 'A');
    const instanceB = prepareLanternUserDataPath(root, 'B');
    assert.notEqual(instanceA, instanceB);
    assert.equal(fs.existsSync(instanceA), true);
    assert.equal(fs.existsSync(instanceB), true);

    const nestedMissing = path.join(root, 'missing', 'nested');
    const db = new DbService(nestedMissing);
    db.upsertPeerCache({
      deviceId: 'peer-sector-test',
      username: 'maria',
      department: 'Financeiro',
      displayName: 'Maria',
      avatarEmoji: '🙂',
      avatarBg: '#147ad6',
      statusMessage: 'Disponível',
      address: '',
      port: 0,
      appVersion: 'test',
      lastSeenAt: Date.now(),
      source: 'relay'
    });
    const cachedPeer = db.getCachedPeerById('peer-sector-test');
    assert.equal(cachedPeer?.username, 'maria');
    assert.equal(cachedPeer?.department, 'Financeiro');
    db.close();
    assert.equal(fs.existsSync(path.join(nestedMissing, 'lantern.db')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
