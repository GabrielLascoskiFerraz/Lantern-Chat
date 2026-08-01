const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-calendar-persistence-'));
process.env.LANTERN_RELAY_DATA_DIR = root;
process.env.LANTERN_RELAY_ANNOUNCEMENTS_FILE = path.join(root, 'announcements.json');
process.env.LANTERN_RELAY_GROUPS_FILE = path.join(root, 'groups.json');
process.env.LANTERN_RELAY_GROUP_ATTACHMENTS_DIR = path.join(root, 'group-attachments');
process.env.LANTERN_RELAY_STICKERS_DIR = path.join(root, 'stickers');
process.env.LANTERN_RELAY_LOG_LEVEL = 'error';

const { LanternRelay } = require('../dist-relay/main.js');

test('anúncio automático do calendário usa uma conta existente e respeita a chave estrangeira', async () => {
  const relay = new LanternRelay({
    host: '127.0.0.1', port: 0, pingIntervalMs: 60_000, peerTimeoutMs: 120_000,
    presenceBroadcastIntervalMs: 60_000, maxPayloadBytes: 8 * 1024 * 1024,
    tlsCertFile: null, tlsKeyFile: null, externalMode: false
  });
  try {
    const publisher = relay.createManagedUser({
      username: 'calendar-publisher', displayName: 'Publicador', role: 'admin'
    });
    const created = await relay.publishCalendarEvent({
      id: 'calendar-regression-event', title: 'Evento persistente',
      description: '', location: '', allDay: true,
      start: Date.now(), end: Date.now() + 60_000
    });

    assert.equal(created, true);
    const frame = relay.listActiveAnnouncementFrames()
      .find((item) => item.messageId === 'calendar-calendar-regression-event');
    assert.equal(frame?.from, publisher.userId);
    assert.equal(frame?.payload.automated, true);
  } finally {
    await relay.stop('calendar-persistence-test');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
