const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CentralStore } = require('../dist-relay/centralStore.js');
const { GroupStore } = require('../dist-relay/groupStore.js');

const createTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-group-state-'));
const silentLog = () => undefined;

const createPersistence = (centralStore) => ({
  location: centralStore.getDatabaseFile(),
  read: (key, version) => centralStore.readCanonicalState(key, version),
  write: (key, value, version) => centralStore.writeCanonicalState(key, value, version)
});

test('groups.json cifrado é importado uma vez e o SQLite vira a fonte ativa', () => {
  const root = createTempDir();
  const centralDir = path.join(root, 'central');
  const legacyFile = path.join(root, 'groups.json');
  const attachmentsDir = path.join(root, 'group-attachments');
  const previousPassword = process.env.LANTERN_RELAY_ADMIN_PASSWORD;
  process.env.LANTERN_RELAY_ADMIN_PASSWORD = 'admin-test-password';
  const now = Date.now();
  const legacy = {
    version: 1,
    groups: [{
      groupId: 'group-one',
      name: 'Grupo persistente',
      emoji: '🧪',
      avatarBg: '#147ad6',
      description: 'Migrado do arquivo legado',
      createdByDeviceId: 'owner-one',
      createdAt: now,
      updatedAt: now,
      lastEventSeq: 1,
      deletedAt: null,
      settings: { allowMembersToPin: true, allowMembersToEditInfo: false },
      members: {
        'owner-one': {
          groupId: 'group-one',
          deviceId: 'owner-one',
          role: 'owner',
          status: 'active',
          displayNameSnapshot: 'Owner',
          avatarEmojiSnapshot: '🙂',
          avatarBgSnapshot: '#147ad6',
          joinedAt: now,
          updatedAt: now
        }
      },
      pinnedMessageIds: []
    }],
    eventsByGroupId: {
      'group-one': [{
        eventId: 'event-one',
        groupId: 'group-one',
        seq: 1,
        type: 'group.created',
        actorDeviceId: 'owner-one',
        createdAt: now,
        payload: {}
      }]
    },
    attachments: []
  };

  try {
    const firstCentral = new CentralStore(centralDir, silentLog);
    fs.writeFileSync(legacyFile, firstCentral.protectJson(legacy));
    const firstGroups = new GroupStore(
      legacyFile,
      attachmentsDir,
      silentLog,
      firstCentral.getEncryption(),
      createPersistence(firstCentral)
    );
    assert.equal(firstGroups.getGroup('group-one')?.name, 'Grupo persistente');
    assert.deepEqual(firstCentral.readCanonicalState('groups'), legacy);
    for (let index = 1; index <= 3; index += 1) {
      firstGroups.appendGroupMessage({
        actorDeviceId: 'owner-one',
        groupId: 'group-one',
        messageId: `message-${index}`,
        createdAt: now + index,
        payload: { message: { messageId: `message-${index}`, text: `Mensagem ${index}` } }
      });
    }
    firstGroups.editGroupMessage(
      'group-one',
      'owner-one',
      'message-3',
      'Mensagem editada',
      now + 4
    );
    const page = firstGroups.historyPageForDevice(
      'group-one',
      'owner-one',
      Number.MAX_SAFE_INTEGER,
      2
    );
    assert.equal(page.hasMore, true);
    assert.equal(page.events.filter((event) => event.type === 'group.message.created').length, 2);
    assert.equal(page.events.some((event) => event.type === 'group.message.edited'), true);
    assert.deepEqual(
      firstGroups.searchMessageIdsForDevice('group-one', 'owner-one', 'editada'),
      ['message-3']
    );
    firstGroups.close();
    firstCentral.close();

    fs.rmSync(legacyFile, { force: true });

    const reopenedCentral = new CentralStore(centralDir, silentLog);
    const reopenedGroups = new GroupStore(
      legacyFile,
      attachmentsDir,
      silentLog,
      reopenedCentral.getEncryption(),
      createPersistence(reopenedCentral)
    );
    assert.equal(reopenedGroups.getGroup('group-one')?.description, 'Migrado do arquivo legado');
    assert.equal(reopenedGroups.listGroupsForDevice('owner-one').length, 1);
    reopenedGroups.close();
    reopenedCentral.close();
  } finally {
    if (previousPassword === undefined) delete process.env.LANTERN_RELAY_ADMIN_PASSWORD;
    else process.env.LANTERN_RELAY_ADMIN_PASSWORD = previousPassword;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
