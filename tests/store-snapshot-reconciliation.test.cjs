const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

test('store reconcilia grupos e contatos depois de registrar o listener inicial', async (t) => {
  const sourceFile = path.join(__dirname, '..', 'renderer', 'src', 'state', 'store.ts');
  const compiled = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;

  const calls = [];
  let groupReads = 0;
  let peerReads = 0;
  const group = {
    groupId: 'group-after-listener',
    name: 'Grupo sincronizado',
    emoji: '👥',
    avatarBg: '#147ad6',
    description: '',
    createdByDeviceId: 'owner',
    createdAt: 1,
    updatedAt: 2,
    deletedAt: null,
    lastEventSeq: 1,
    settings: {}
  };
  const peer = {
    deviceId: 'peer-after-listener',
    username: 'peer',
    displayName: 'Contato sincronizado',
    avatarEmoji: '🙂',
    avatarBg: '#147ad6',
    statusMessage: 'Disponível',
    address: '',
    port: 0,
    appVersion: '1.2.0',
    lastSeenAt: 2,
    source: 'relay'
  };

  const ipcClient = new Proxy({
    getAuthState: async () => ({
      authenticated: true,
      endpoint: 'ws://relay',
      user: { passwordSetupRequired: false, profileSetupCompleted: true }
    }),
    getProfile: async () => ({ deviceId: 'me', displayName: 'Eu' }),
    getRelaySettings: async () => ({
      automatic: true, host: '', port: 43190, connected: true, endpoint: 'ws://relay'
    }),
    getStartupSettings: async () => ({
      supported: true, openAtLogin: false, downloadsDir: '/tmp', doNotDisturbUntil: 0
    }),
    getKnownPeers: async () => {
      peerReads += 1;
      calls.push(`getKnownPeers:${peerReads}`);
      return peerReads === 1 ? [] : [peer];
    },
    getGroups: async () => {
      groupReads += 1;
      calls.push(`getGroups:${groupReads}`);
      return groupReads === 1 ? [] : [group];
    },
    getOnlinePeers: async () => [],
    getConversations: async () => ({ announcements: 0 }),
    getArchivedConversationIds: async () => [],
    getPinnedConversationIds: async () => [],
    getConversationPreviews: async () => ({}),
    getMessages: async () => [],
    getMessageFavorites: async () => ({}),
    getAnnouncementReactions: async () => ({}),
    getMessageReactions: async () => ({}),
    getAnnouncementReadSummary: async () => ({}),
    markConversationRead: async () => undefined,
    setActiveConversation: async () => undefined,
    getGroupMembers: async () => [],
    getGroupPinnedMessageIds: async () => [],
    onEvent: () => {
      calls.push('onEvent');
      return () => undefined;
    }
  }, {
    get(target, property) {
      if (property in target) return target[property];
      return async () => undefined;
    }
  });

  const create = (initializer) => {
    let state;
    const set = (update) => {
      const patch = typeof update === 'function' ? update(state) : update;
      if (patch && patch !== state) state = { ...state, ...patch };
    };
    const get = () => state;
    state = initializer(set, get);
    const store = (selector = (value) => value) => selector(state);
    store.getState = get;
    store.setState = set;
    return store;
  };

  const previousWindow = global.window;
  global.window = {
    localStorage: { getItem: () => null, setItem: () => undefined },
    matchMedia: () => ({ matches: false }),
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => undefined
  };
  t.after(() => { global.window = previousWindow; });

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'zustand') return { create };
    if (request.endsWith('/api/ipcClient') || request === '../api/ipcClient') {
      return { ipcClient };
    }
    if (request.endsWith('/messageMerge') || request === './messageMerge') {
      return {
        mergeFetchedMessagesWithLiveUpdates: (rows) => rows,
        mergeRepairedConversationPage: (rows) => rows
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = originalLoad; });

  const loaded = new Module(sourceFile, module);
  loaded.filename = sourceFile;
  loaded.paths = module.paths;
  loaded._compile(compiled, sourceFile);

  await loaded.exports.useLanternStore.getState().loadInitial();
  await new Promise((resolve) => setImmediate(resolve));

  const state = loaded.exports.useLanternStore.getState();
  assert.equal(state.groups[0]?.groupId, group.groupId);
  assert.equal(state.peers[0]?.deviceId, peer.deviceId);
  assert.ok(calls.indexOf('onEvent') < calls.indexOf('getGroups:2'));
  assert.ok(calls.indexOf('onEvent') < calls.indexOf('getKnownPeers:2'));
});
