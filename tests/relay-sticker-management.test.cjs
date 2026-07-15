const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-sticker-management-'));
process.env.LANTERN_RELAY_DATA_DIR = root;
process.env.LANTERN_RELAY_ANNOUNCEMENTS_FILE = path.join(root, 'announcements.json');
process.env.LANTERN_RELAY_GROUPS_FILE = path.join(root, 'groups.json');
process.env.LANTERN_RELAY_GROUP_ATTACHMENTS_DIR = path.join(root, 'group-attachments');
process.env.LANTERN_RELAY_STICKERS_DIR = path.join(root, 'stickers');
process.env.LANTERN_RELAY_LOG_LEVEL = 'error';

const { LanternRelay } = require('../dist-relay/main.js');

const relayConfig = {
  host: '127.0.0.1', port: 0, pingIntervalMs: 60_000, peerTimeoutMs: 120_000,
  presenceBroadcastIntervalMs: 60_000, maxPayloadBytes: 8 * 1024 * 1024,
  tlsCertFile: null, tlsKeyFile: null, externalMode: false
};

test('Relay UI gerencia GIFs no catálogo persistente com validação', async () => {
  const sources = path.join(root, 'sources');
  fs.mkdirSync(sources, { recursive: true });
  const gifPath = path.join(sources, 'Gatinho Feliz.gif');
  const replacementPath = path.join(sources, 'replacement', 'Gatinho Feliz.gif');
  fs.mkdirSync(path.dirname(replacementPath), { recursive: true });
  fs.writeFileSync(gifPath, Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.from([1, 2, 3])]));
  fs.writeFileSync(replacementPath, Buffer.concat([Buffer.from('GIF87a', 'ascii'), Buffer.from([4, 5, 6, 7])]));
  const invalidPath = path.join(sources, 'falso.gif');
  fs.writeFileSync(invalidPath, 'não é gif');

  const relay = new LanternRelay(relayConfig);
  try {
    assert.throws(
      () => relay.addManagedStickers({ sourcePaths: [invalidPath], category: 'Animais' }),
      /não é uma GIF válida/
    );

    const imported = relay.addManagedStickers({ sourcePaths: [gifPath], category: 'Animais fofos' });
    assert.equal(imported.added.length, 1);
    assert.equal(imported.added[0].relativePath, 'animais-fofos/Gatinho Feliz.gif');
    assert.match(relay.getManagedStickerPreview(imported.added[0].relativePath), /^data:image\/gif;base64,/);
    assert.ok(fs.existsSync(path.join(root, 'stickers', imported.added[0].relativePath)));

    assert.throws(
      () => relay.addManagedStickers({ sourcePaths: [replacementPath], category: 'Animais fofos' }),
      /já existe/
    );
    const replaced = relay.addManagedStickers({
      sourcePaths: [replacementPath], category: 'Animais fofos', replaceExisting: true
    });
    assert.equal(replaced.replaced.length, 1);
    assert.equal(replaced.replaced[0].size, 10);

    const updated = relay.updateManagedSticker('animais-fofos/Gatinho Feliz.gif', {
      label: 'Gato dançando', category: 'Festas'
    });
    assert.equal(updated.relativePath, 'festas/Gato dancando.gif');
    assert.ok(fs.existsSync(path.join(root, 'stickers', 'festas', 'Gato dancando.gif')));
    assert.equal(fs.existsSync(path.join(root, 'stickers', 'animais-fofos', 'Gatinho Feliz.gif')), false);

    assert.deepEqual(relay.removeManagedSticker(updated.relativePath), { relativePath: updated.relativePath });
    assert.equal(relay.getManagedStickerPreview(updated.relativePath), null);
    assert.equal(relay.getManagementSnapshot().stickers.some((item) => item.relativePath === updated.relativePath), false);
  } finally {
    await relay.stop('sticker-management-test').catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
