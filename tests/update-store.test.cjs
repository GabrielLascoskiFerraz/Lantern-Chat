const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { UpdateStore } = require('../dist-relay/updateStore.js');

test('instaladores de atualização são validados, persistidos e substituídos atomicamente', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-updates-'));
  try {
    const source = path.join(root, 'Lantern-Setup.exe');
    const contents = Buffer.from('instalador-de-teste');
    fs.writeFileSync(source, contents);
    const store = new UpdateStore(root, '1.2.0');
    const saved = store.importInstaller('win32', source);
    assert.equal(saved.fileName, 'Lantern-Setup.exe');
    assert.equal(saved.sha256, createHash('sha256').update(contents).digest('hex'));
    assert.equal(store.getInstaller('win32').metadata.size, contents.length);

    const reopened = new UpdateStore(root, '1.2.0');
    assert.equal(reopened.getManifest().installers.win32.sha256, saved.sha256);
    assert.throws(() => reopened.importInstaller('darwin', source), /\.dmg/);
    reopened.removeInstaller('win32');
    assert.equal(reopened.getInstaller('win32'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
