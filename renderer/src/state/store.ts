import { create } from 'zustand';
import {
  AnnouncementReadSummary,
  AnnouncementReactionSummary,
  ClientAuthState,
  ClientRelayConfig,
  GroupInfo,
  GroupMember,
  ipcClient,
  MessageReplyReference,
  MessageRow,
  Peer,
  Profile,
  RelaySettings,
  StartupSettings
} from '../api/ipcClient';
import {
  mergeFetchedMessagesWithLiveUpdates,
  mergeRepairedConversationPage
} from './messageMerge';

interface TransferProgress {
  direction: 'send' | 'receive';
  fileId: string;
  messageId: string;
  peerId: string;
  transferred: number;
  total: number;
  stage?: 'pending' | 'reconnecting' | 'uploading' | 'downloading' | 'retrying' | 'complete' | 'failed';
  attempt?: number;
  detail?: string | null;
}

interface UiToast {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

interface LanternState {
  authState: ClientAuthState | null;
  profile: Profile | null;
  relaySettings: RelaySettings | null;
  startupSettings: StartupSettings | null;
  peers: Peer[];
  groups: GroupInfo[];
  groupMembersById: Record<string, GroupMember[]>;
  groupPinnedMessageIdsById: Record<string, string[]>;
  onlinePeerIds: string[];
  selectedConversationId: string;
  messagesByConversation: Record<string, MessageRow[]>;
  hasMoreHistoryByConversation: Record<string, boolean>;
  loadingOlderByConversation: Record<string, boolean>;
  announcementReactionsByMessage: Record<string, AnnouncementReactionSummary>;
  announcementReadsByMessage: Record<string, AnnouncementReadSummary>;
  favoriteByMessageId: Record<string, boolean>;
  archivedConversationIds: string[];
  pinnedConversationIds: string[];
  conversationPreviewById: Record<string, string>;
  unreadByConversation: Record<string, number>;
  openedUnreadCountByConversation: Record<string, number>;
  unreadAnchorMessageIdByConversation: Record<string, string | null>;
  typingByConversation: Record<string, boolean>;
  recentMessageIds: Record<string, number>;
  toasts: UiToast[];
  transfers: Record<string, TransferProgress>;
  search: string;
  settingsOpen: boolean;
  themeMode: 'system' | 'light' | 'dark';
  resolvedTheme: 'light' | 'dark';
  fontSizeMode: 'small' | 'medium' | 'large';
  ready: boolean;
  startupError: string | null;
  syncActive: boolean;
  loadingConversationId: string | null;
  setSearch: (value: string) => void;
  setSettingsOpen: (open: boolean) => void;
  setThemeMode: (mode: 'system' | 'light' | 'dark') => void;
  setFontSizeMode: (mode: 'small' | 'medium' | 'large') => void;
  setSystemDark: (isDark: boolean) => void;
  loadInitial: () => Promise<void>;
  login: (input: { relay: ClientRelayConfig; username: string; password: string; rememberMe?: boolean }) => Promise<void>;
  register: (input: { relay: ClientRelayConfig; username: string; displayName: string; password: string; locale: 'pt-BR' | 'en' | 'es' }) => Promise<void>;
  completeFirstLoginSetup: (input: { avatarEmoji: string; avatarBg: string; openAtLogin: boolean }) => Promise<void>;
  logout: () => Promise<void>;
  selectConversation: (conversationId: string) => Promise<void>;
  closeConversation: () => Promise<void>;
  loadOlderMessages: (conversationId: string, limit?: number) => Promise<number>;
  ensureConversationMessagesLoaded: (
    conversationId: string,
    messageIds: string[]
  ) => Promise<void>;
  sendText: (
    peerId: string,
    text: string,
    replyTo?: MessageReplyReference | null
  ) => Promise<void>;
  sendGroupText: (
    groupId: string,
    text: string,
    replyTo?: MessageReplyReference | null
  ) => Promise<void>;
  sendTyping: (peerId: string, isTyping: boolean) => Promise<void>;
  sendAnnouncement: (text: string, replyTo?: MessageReplyReference | null) => Promise<void>;
  sendAnnouncementFile: (
    filePath: string,
    replyTo?: MessageReplyReference | null
  ) => Promise<void>;
  sendFile: (
    peerId: string,
    filePath: string,
    replyTo?: MessageReplyReference | null
  ) => Promise<void>;
  sendGroupFile: (
    groupId: string,
    filePath: string,
    replyTo?: MessageReplyReference | null
  ) => Promise<void>;
  createGroup: (input: {
    name: string;
    emoji: string;
    avatarBg: string;
    description: string;
    memberDeviceIds: string[];
  }) => Promise<void>;
  updateGroup: (
    groupId: string,
    input: {
      name?: string;
      emoji?: string;
      avatarBg?: string;
      description?: string;
      settings?: Record<string, boolean>;
    }
  ) => Promise<void>;
  addGroupMembers: (groupId: string, memberDeviceIds: string[]) => Promise<void>;
  removeGroupMember: (groupId: string, deviceId: string) => Promise<void>;
  setGroupMemberRole: (groupId: string, deviceId: string, role: 'admin' | 'member') => Promise<void>;
  transferGroupOwnership: (groupId: string, deviceId: string) => Promise<void>;
  deleteGroup: (groupId: string) => Promise<void>;
  leaveGroup: (groupId: string) => Promise<void>;
  setGroupMessagePinned: (groupId: string, messageId: string, pinned: boolean) => Promise<void>;
  forwardMessageToPeer: (targetPeerId: string, sourceMessageId: string) => Promise<void>;
  editMessage: (conversationId: string, messageId: string, text: string) => Promise<void>;
  reactToMessage: (
    conversationId: string,
    messageId: string,
    reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null
  ) => Promise<void>;
  toggleMessageFavorite: (
    conversationId: string,
    messageId: string,
    favorite: boolean
  ) => Promise<void>;
  getFavoriteMessages: (conversationId: string) => Promise<MessageRow[]>;
  deleteMessageForEveryone: (conversationId: string, messageId: string) => Promise<void>;
  deleteMessageForMe: (conversationId: string, messageId: string) => Promise<void>;
  exportConversation: (conversationId: string, format: 'txt' | 'html') => Promise<void>;
  resyncConversation: (conversationId: string) => Promise<void>;
  markConversationUnread: (conversationId: string) => Promise<void>;
  archiveConversation: (conversationId: string) => Promise<void>;
  unarchiveConversation: (conversationId: string) => Promise<void>;
  setConversationPinned: (conversationId: string, pinned: boolean) => Promise<void>;
  clearConversation: (conversationId: string) => Promise<void>;
  updateProfile: (input: { displayName: string; avatarEmoji: string; avatarBg: string; statusMessage: string }) => Promise<void>;
  updateRelaySettings: (input: { automatic: boolean; host?: string; port?: number }) => Promise<void>;
  forceRelayRediscovery: () => Promise<void>;
  updateStartupSettings: (input: {
    openAtLogin: boolean;
    downloadsDir?: string;
    doNotDisturbUntil?: number;
  }) => Promise<void>;
  openFile: (filePath: string) => Promise<void>;
  saveFileAs: (filePath: string, fileName?: string | null) => Promise<void>;
  dismissToast: (id: string) => void;
}

const ANNOUNCEMENTS_ID = 'announcements';
const THEME_KEY = 'lantern.theme';
const FONT_SIZE_KEY = 'lantern.font-size';
const MESSAGES_PAGE_SIZE = 80;
const TRANSFER_CLEANUP_DELAY_MS = 2600;

const getInitialThemeMode = (): 'system' | 'light' | 'dark' => {
  if (typeof window === 'undefined') {
    return 'system';
  }
  const stored = window.localStorage.getItem(THEME_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
};

const getInitialFontSizeMode = (): 'small' | 'medium' | 'large' => {
  if (typeof window === 'undefined') return 'medium';
  const stored = window.localStorage.getItem(FONT_SIZE_KEY);
  return stored === 'small' || stored === 'medium' || stored === 'large' ? stored : 'medium';
};

const getSystemDark = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;

const resolveTheme = (
  mode: 'system' | 'light' | 'dark',
  systemDark: boolean
): 'light' | 'dark' => {
  if (mode === 'system') {
    return systemDark ? 'dark' : 'light';
  }
  return mode;
};

const initialThemeMode = getInitialThemeMode();
const initialSystemDark = getSystemDark();
let unsubscribeEvents: (() => void) | null = null;
let previewRefreshTimer: number | null = null;
let peerRefreshTimer: number | null = null;
let peersUpdateSeq = 0;
let peerSnapshotSeq = 0;
const typingTimers = new Map<string, number>();
const transferCleanupTimers = new Map<string, number>();

const clearTransferCleanupTimer = (fileId: string): void => {
  const timer = transferCleanupTimers.get(fileId);
  if (timer && typeof window !== 'undefined') {
    window.clearTimeout(timer);
  }
  transferCleanupTimers.delete(fileId);
};

const areStringArraysEqual = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

const arePeersEqual = (a: Peer[], b: Peer[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.deviceId !== right.deviceId ||
      left.displayName !== right.displayName ||
      left.avatarEmoji !== right.avatarEmoji ||
      left.avatarBg !== right.avatarBg ||
      left.statusMessage !== right.statusMessage ||
      left.address !== right.address ||
      left.port !== right.port ||
      left.appVersion !== right.appVersion ||
      left.source !== right.source
    ) {
      return false;
    }
  }
  return true;
};

const mergePreviewMapIfChanged = (
  current: Record<string, string>,
  incoming: Record<string, string>
): Record<string, string> | null => {
  let changed = false;
  const next = { ...current };
  for (const [conversationId, value] of Object.entries(incoming)) {
    const normalized = value || '';
    if ((next[conversationId] || '') === normalized) continue;
    next[conversationId] = normalized;
    changed = true;
  }
  return changed ? next : null;
};

const mergeFavoriteMap = (
  current: Record<string, boolean>,
  incoming: Record<string, boolean>
): Record<string, boolean> => {
  const next = { ...current };
  for (const [messageId, favorite] of Object.entries(incoming)) {
    if (favorite) {
      next[messageId] = true;
    } else {
      delete next[messageId];
    }
  }
  return next;
};

const appendUniqueMessage = (rows: MessageRow[], incoming: MessageRow): MessageRow[] => {
  if (rows.some((row) => row.messageId === incoming.messageId)) {
    return rows;
  }
  return [...rows, incoming].sort((a, b) => {
    const at = Number(a.createdAt) || 0;
    const bt = Number(b.createdAt) || 0;
    if (at !== bt) return at - bt;
    return a.messageId.localeCompare(b.messageId);
  });
};

const normalizeMessageOrder = (rows: MessageRow[]): MessageRow[] =>
  [...rows].sort((a, b) => {
    const at = Number(a.createdAt) || 0;
    const bt = Number(b.createdAt) || 0;
    if (at !== bt) return at - bt;
    return a.messageId.localeCompare(b.messageId);
  });

const mergeOrderedMessages = (existing: MessageRow[], incoming: MessageRow[]): MessageRow[] => {
  if (incoming.length === 0) return existing;
  const byId = new Map(existing.map((row) => [row.messageId, row]));
  for (const row of incoming) {
    byId.set(row.messageId, row);
  }
  return normalizeMessageOrder(Array.from(byId.values()));
};

const updateExistingMessageOnly = (rows: MessageRow[], incoming: MessageRow): MessageRow[] => {
  let found = false;
  const next = rows.map((row) => {
    if (row.messageId !== incoming.messageId) return row;
    found = true;
    return incoming;
  });
  return found ? next : rows;
};

const previewFromMessage = (message: MessageRow): string => {
  if (message.type === 'file') return `📎 ${message.fileName || 'Arquivo'}`;
  const text = (message.bodyText || '').replace(/\s+/g, ' ').trim();
  return text.length > 90 ? `${text.slice(0, 87)}...` : text;
};

const pruneRecent = (current: Record<string, number>): Record<string, number> => {
  const threshold = Date.now() - 6000;
  return Object.fromEntries(
    Object.entries(current).filter(([, ts]) => ts >= threshold)
  );
};

const buildConversationIdsForPreview = (state: Pick<
  LanternState,
  'peers' | 'unreadByConversation' | 'messagesByConversation'
>): string[] => {
  const ids = new Set<string>();
  ids.add(ANNOUNCEMENTS_ID);
  for (const peer of state.peers) {
    ids.add(`dm:${peer.deviceId}`);
  }
  for (const id of Object.keys(state.unreadByConversation)) {
    ids.add(id);
  }
  for (const id of Object.keys(state.messagesByConversation)) {
    ids.add(id);
  }
  return Array.from(ids);
};

export const useLanternStore = create<LanternState>((set, get) => ({
  authState: null,
  profile: null,
  relaySettings: null,
  startupSettings: null,
  peers: [],
  groups: [],
  groupMembersById: {},
  groupPinnedMessageIdsById: {},
  onlinePeerIds: [],
  selectedConversationId: ANNOUNCEMENTS_ID,
  messagesByConversation: {},
  hasMoreHistoryByConversation: {},
  loadingOlderByConversation: {},
  announcementReactionsByMessage: {},
  announcementReadsByMessage: {},
  favoriteByMessageId: {},
  archivedConversationIds: [],
  pinnedConversationIds: [],
  conversationPreviewById: {},
  unreadByConversation: {},
  openedUnreadCountByConversation: {},
  unreadAnchorMessageIdByConversation: {},
  typingByConversation: {},
  recentMessageIds: {},
  toasts: [],
  transfers: {},
  search: '',
  settingsOpen: false,
  themeMode: initialThemeMode,
  resolvedTheme: resolveTheme(initialThemeMode, initialSystemDark),
  fontSizeMode: getInitialFontSizeMode(),
  ready: false,
  startupError: null,
  syncActive: false,
  loadingConversationId: null,
  setSearch: (value) => set({ search: value }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setThemeMode: (mode) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_KEY, mode);
    }
    const systemDark = getSystemDark();
    set({
      themeMode: mode,
      resolvedTheme: resolveTheme(mode, systemDark)
    });
  },
  setFontSizeMode: (mode) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(FONT_SIZE_KEY, mode);
    set({ fontSizeMode: mode });
  },
  setSystemDark: (isDark) => {
    const mode = get().themeMode;
    set({
      resolvedTheme: resolveTheme(mode, isDark)
    });
  },
  loadInitial: async () => {
    try {
      set({ startupError: null });
      const authState = await ipcClient.getAuthState();
      if (!authState.authenticated) {
        set({ authState, profile: null, ready: true, loadingConversationId: null });
        return;
      }
      const [
        profile,
        relaySettings,
        startupSettings,
        peers,
        groups,
        onlinePeers,
        unreadByConversation,
        archivedConversationIds,
        pinnedConversationIds
      ] =
        await Promise.all([
          ipcClient.getProfile(),
          ipcClient.getRelaySettings(),
          ipcClient.getStartupSettings(),
          ipcClient.getKnownPeers(),
          ipcClient.getGroups(),
          ipcClient.getOnlinePeers(),
          ipcClient.getConversations(),
          ipcClient.getArchivedConversationIds(),
          ipcClient.getPinnedConversationIds()
        ]);

      const [groupMembersEntries, groupPinnedEntries] = await Promise.all([
        Promise.all(
          groups.map(async (group) => [
            group.groupId,
            await ipcClient.getGroupMembers(group.groupId).catch(() => [])
          ] as const)
        ),
        Promise.all(
          groups.map(async (group) => [
            group.groupId,
            await ipcClient.getGroupPinnedMessageIds(group.groupId).catch(() => [])
          ] as const)
        )
      ]);

      const conversationIds = [
        ANNOUNCEMENTS_ID,
        ...groups.map((group) => `group:${group.groupId}`),
        ...peers.map((peer) => `dm:${peer.deviceId}`)
      ];
    const conversationPreviewById = await ipcClient.getConversationPreviews(conversationIds);

    const selectedAtLoad = get().selectedConversationId;
    const selectedUnreadAtLoad = unreadByConversation[selectedAtLoad] || 0;

    set({
      authState,
      profile,
      relaySettings,
      startupSettings,
      peers,
      groups,
      groupMembersById: Object.fromEntries(groupMembersEntries),
      groupPinnedMessageIdsById: Object.fromEntries(groupPinnedEntries),
      onlinePeerIds: onlinePeers.map((peer) => peer.deviceId).sort((a, b) => a.localeCompare(b)),
      archivedConversationIds,
      pinnedConversationIds,
      unreadByConversation,
      openedUnreadCountByConversation: {
        [selectedAtLoad]: selectedUnreadAtLoad
      },
      unreadAnchorMessageIdByConversation: {
        [selectedAtLoad]: null
      },
      conversationPreviewById,
      settingsOpen: false,
      ready: true,
      loadingConversationId: selectedAtLoad
    });

    const current = get().selectedConversationId;
    const initialMessages = normalizeMessageOrder(
      await ipcClient.getMessages(current, MESSAGES_PAGE_SIZE)
    );
    const hasMoreHistory = initialMessages.length === MESSAGES_PAGE_SIZE;
    const initialMessageIds = initialMessages.map((row) => row.messageId);
    const [initialMessageReactions, initialFavorites, initialAnnouncementReads] =
      initialMessageIds.length > 0
        ? await Promise.all([
            current === ANNOUNCEMENTS_ID
              ? ipcClient.getAnnouncementReactions(initialMessageIds)
              : ipcClient.getMessageReactions(initialMessageIds),
            ipcClient.getMessageFavorites(initialMessageIds),
            current === ANNOUNCEMENTS_ID
              ? ipcClient.getAnnouncementReadSummary(initialMessageIds)
              : Promise.resolve({})
          ])
        : [{}, {}, {}];
    const initialUnreadCount = selectedUnreadAtLoad;
    const initialUnreadAnchorMessageId =
      initialUnreadCount > 0 && initialMessages.length > 0
        ? initialMessages[Math.max(0, initialMessages.length - Math.min(initialUnreadCount, initialMessages.length))]
            ?.messageId || null
        : null;

    set((state) => ({
      messagesByConversation: {
        ...state.messagesByConversation,
        [current]: initialMessages
      },
      hasMoreHistoryByConversation: {
        ...state.hasMoreHistoryByConversation,
        [current]: hasMoreHistory
      },
      loadingOlderByConversation: {
        ...state.loadingOlderByConversation,
        [current]: false
      },
      announcementReactionsByMessage: {
        ...state.announcementReactionsByMessage,
        ...initialMessageReactions
      },
      announcementReadsByMessage: {
        ...state.announcementReadsByMessage,
        ...initialAnnouncementReads
      },
      favoriteByMessageId: mergeFavoriteMap(state.favoriteByMessageId, initialFavorites),
      unreadAnchorMessageIdByConversation: {
        ...state.unreadAnchorMessageIdByConversation,
        [current]: initialUnreadAnchorMessageId
      },
      loadingConversationId:
        state.loadingConversationId === current ? null : state.loadingConversationId
    }));

    await ipcClient.markConversationRead(current);
    await ipcClient.setActiveConversation(current);
    set((state) => ({
      unreadByConversation: {
        ...state.unreadByConversation,
        [current]: 0
      }
    }));

    if (unsubscribeEvents) {
      unsubscribeEvents();
      unsubscribeEvents = null;
    }
    if (previewRefreshTimer) {
      window.clearInterval(previewRefreshTimer);
      previewRefreshTimer = null;
    }
    if (peerRefreshTimer) {
      window.clearInterval(peerRefreshTimer);
      peerRefreshTimer = null;
    }

    const scheduleTransferCleanup = (fileId: string): void => {
      clearTransferCleanupTimer(fileId);
      if (typeof window === 'undefined') return;
      const timer = window.setTimeout(() => {
        transferCleanupTimers.delete(fileId);
        set((state) => {
          if (!state.transfers[fileId]) return state;
          const nextTransfers = { ...state.transfers };
          delete nextTransfers[fileId];
          return { transfers: nextTransfers };
        });
      }, TRANSFER_CLEANUP_DELAY_MS);
      transferCleanupTimers.set(fileId, timer);
    };

    const refreshPeersSnapshot = async (): Promise<void> => {
      const seq = ++peerSnapshotSeq;
      const [onlinePeers, knownPeers] = await Promise.all([
        ipcClient.getOnlinePeers(),
        ipcClient.getKnownPeers()
      ]);
      if (seq !== peerSnapshotSeq) return;

      const onlineMap = new Map(onlinePeers.map((peer) => [peer.deviceId, peer]));
      const onlinePeerIds = Array.from(onlineMap.keys()).sort((a, b) => a.localeCompare(b));
      const mergedPeers = knownPeers.map((peer) => {
        const live = onlineMap.get(peer.deviceId);
        if (!live) return peer;
        return {
          ...peer,
          displayName: live.displayName || peer.displayName,
          avatarEmoji: live.avatarEmoji || peer.avatarEmoji,
          avatarBg: live.avatarBg || peer.avatarBg,
          statusMessage: live.statusMessage || peer.statusMessage,
          address: live.address || peer.address,
          port: live.port || peer.port,
          appVersion: live.appVersion || peer.appVersion,
          lastSeenAt: live.lastSeenAt || peer.lastSeenAt,
          source: live.source
        };
      });

      const ids = [ANNOUNCEMENTS_ID, ...knownPeers.map((peer) => `dm:${peer.deviceId}`)];
      const previewMap = await ipcClient.getConversationPreviews(ids);
      if (seq !== peerSnapshotSeq) return;

      set((state) => {
        const previewMerged = mergePreviewMapIfChanged(state.conversationPreviewById, previewMap);
        const peersChanged = !arePeersEqual(state.peers, mergedPeers);
        const onlineChanged = !areStringArraysEqual(state.onlinePeerIds, onlinePeerIds);
        if (!previewMerged && !peersChanged && !onlineChanged) {
          return state;
        }
        return {
          ...(previewMerged ? { conversationPreviewById: previewMerged } : {}),
          ...(peersChanged ? { peers: mergedPeers } : {}),
          ...(onlineChanged ? { onlinePeerIds } : {})
        };
      });
    };

    unsubscribeEvents = ipcClient.onEvent((event) => {
      if (event.type === 'auth:changed') {
        set({ authState: event.state });
        return;
      }
      if (event.type === 'relay:connection') {
        set((state) => {
          if (!state.relaySettings) {
            return {
              relaySettings: {
                automatic: true,
                host: '',
                port: 43190,
                connected: event.connected,
                endpoint: event.endpoint
              }
            };
          }
          if (
            state.relaySettings.connected === event.connected &&
            state.relaySettings.endpoint === event.endpoint
          ) {
            return state;
          }
          return {
            relaySettings: {
              ...state.relaySettings,
              connected: event.connected,
              endpoint: event.endpoint
            }
          };
        });
        if (event.connected) {
          window.setTimeout(() => {
            void refreshPeersSnapshot();
          }, 120);
        } else {
          set((state) =>
            state.onlinePeerIds.length === 0 ? state : { onlinePeerIds: [] }
          );
        }
        return;
      }

      if (event.type === 'peers:updated') {
        const updateSeq = ++peersUpdateSeq;
        const onlineMap = new Map(event.peers.map((peer) => [peer.deviceId, peer]));
        const onlinePeerIds = Array.from(onlineMap.keys()).sort((a, b) => a.localeCompare(b));
        set((state) => (areStringArraysEqual(state.onlinePeerIds, onlinePeerIds) ? state : { onlinePeerIds }));
        void ipcClient.getKnownPeers().then((knownPeers) => {
          if (updateSeq !== peersUpdateSeq) return;
          const ids = [
            ANNOUNCEMENTS_ID,
            ...get().groups.map((group) => `group:${group.groupId}`),
            ...knownPeers.map((peer) => `dm:${peer.deviceId}`)
          ];
          void ipcClient.getConversationPreviews(ids).then((previewMap) => {
            if (updateSeq !== peersUpdateSeq) return;
            set((state) => {
              const merged = mergePreviewMapIfChanged(state.conversationPreviewById, previewMap);
              if (!merged) return state;
              return { conversationPreviewById: merged };
            });
          });
          const mergedPeers = knownPeers.map((peer) => {
            const live = onlineMap.get(peer.deviceId);
            if (!live) {
              return peer;
            }
            return {
              ...peer,
              displayName: live.displayName || peer.displayName,
              avatarEmoji: live.avatarEmoji || peer.avatarEmoji,
              avatarBg: live.avatarBg || peer.avatarBg,
              statusMessage: live.statusMessage || peer.statusMessage,
              address: live.address || peer.address,
              port: live.port || peer.port,
              appVersion: live.appVersion || peer.appVersion,
              lastSeenAt: live.lastSeenAt || peer.lastSeenAt,
              source: live.source
            };
          });
          if (updateSeq !== peersUpdateSeq) return;
          set((state) => (arePeersEqual(state.peers, mergedPeers) ? state : { peers: mergedPeers }));
        });
        return;
      }

      if (event.type === 'groups:updated') {
        const groups = [...event.groups].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
        const visibleGroupConversationIds = new Set(groups.map((group) => `group:${group.groupId}`));
        const selectedConversationId = get().selectedConversationId;
        const shouldCloseSelectedGroup =
          selectedConversationId.startsWith('group:') &&
          !visibleGroupConversationIds.has(selectedConversationId);
        const ids = [
          ANNOUNCEMENTS_ID,
          ...groups.map((group) => `group:${group.groupId}`),
          ...get().peers.map((peer) => `dm:${peer.deviceId}`)
        ];
        void ipcClient.getConversationPreviews(ids).then((previewMap) => {
          set((state) => ({
            groups,
            selectedConversationId: shouldCloseSelectedGroup ? '' : state.selectedConversationId,
            loadingConversationId: shouldCloseSelectedGroup ? null : state.loadingConversationId,
            conversationPreviewById:
              mergePreviewMapIfChanged(state.conversationPreviewById, previewMap) ||
              state.conversationPreviewById
          }));
        });
        if (shouldCloseSelectedGroup) {
          void ipcClient.setActiveConversation('');
        }
        return;
      }

      if (event.type === 'group:members') {
        set((state) => ({
          groupMembersById: {
            ...state.groupMembersById,
            [event.groupId]: event.members
          }
        }));
        return;
      }

      if (event.type === 'group:pins') {
        set((state) => ({
          groupPinnedMessageIdsById: {
            ...state.groupPinnedMessageIdsById,
            [event.groupId]: event.messageIds
          }
        }));
        return;
      }

      if (event.type === 'sync:status') {
        set((state) => (state.syncActive === event.active ? state : { syncActive: event.active }));
        return;
      }

      if (event.type === 'message:received') {
        const selectedAtReceive = get().selectedConversationId;
        set((state) => {
          const existing = state.messagesByConversation[event.message.conversationId] || [];
          if (existing.some((row) => row.messageId === event.message.messageId)) {
            return state;
          }

          const recent = pruneRecent(state.recentMessageIds);
          recent[event.message.messageId] = Date.now();

          return {
            messagesByConversation: {
              ...state.messagesByConversation,
              [event.message.conversationId]: normalizeMessageOrder([...existing, event.message])
            },
            ...(state.loadingConversationId === event.message.conversationId
              ? {}
              : {
                  conversationPreviewById: {
                    ...state.conversationPreviewById,
                    [event.message.conversationId]: previewFromMessage(event.message)
                  }
                }),
            unreadByConversation:
              selectedAtReceive === event.message.conversationId
                ? {
                    ...state.unreadByConversation,
                    [event.message.conversationId]: 0
                  }
                : state.unreadByConversation,
            typingByConversation: {
              ...state.typingByConversation,
              [event.message.conversationId]: false
            },
            recentMessageIds: recent
          };
        });
        if (selectedAtReceive === event.message.conversationId) {
          void ipcClient.markConversationRead(event.message.conversationId);
          void ipcClient.setActiveConversation(event.message.conversationId);
        }
        return;
      }

      if (event.type === 'conversation:unread') {
        const unreadCount = Math.max(0, Number(event.unreadCount) || 0);
        set((state) => {
          if ((state.unreadByConversation[event.conversationId] || 0) === unreadCount) {
            return state;
          }
          return {
            unreadByConversation: {
              ...state.unreadByConversation,
              [event.conversationId]: unreadCount
            }
          };
        });
        return;
      }

      if (event.type === 'message:status') {
        set((state) => {
          if (event.conversationId) {
            const rows = state.messagesByConversation[event.conversationId];
            if (!rows || rows.length === 0) {
              return state;
            }
            let changed = false;
            const nextRows = rows.map((row) => {
              if (row.messageId !== event.messageId) return row;
              if (row.status === event.status) return row;
              changed = true;
              return { ...row, status: event.status };
            });
            if (!changed) {
              return state;
            }
            return {
              messagesByConversation: {
                ...state.messagesByConversation,
                [event.conversationId]: nextRows
              }
            };
          }

          const updated: Record<string, MessageRow[]> = {};
          let changed = false;
          for (const [conversationId, rows] of Object.entries(state.messagesByConversation)) {
            updated[conversationId] = rows.map((row) => {
              if (row.messageId !== event.messageId) return row;
              if (row.status === event.status) return row;
              changed = true;
              return { ...row, status: event.status };
            });
          }
          return changed ? { messagesByConversation: updated } : state;
        });

        if (event.status === 'delivered' || event.status === 'read' || event.status === 'failed') {
          const completedFileIds = Object.values(get().transfers)
            .filter((transfer) => transfer.messageId === event.messageId)
            .map((transfer) => transfer.fileId);

          for (const fileId of completedFileIds) {
            scheduleTransferCleanup(fileId);
          }
        }
        return;
      }

      if (event.type === 'message:updated') {
        set((state) => {
          const conversationId = event.message.conversationId;
          const rows = state.messagesByConversation[conversationId] || [];
          if (event.message.deletedAt) {
            const nextRows = rows.filter((row) => row.messageId !== event.message.messageId);
            const last = nextRows[nextRows.length - 1];
            const nextFavorites = { ...state.favoriteByMessageId };
            delete nextFavorites[event.message.messageId];
            return {
              messagesByConversation: {
                ...state.messagesByConversation,
                [conversationId]: nextRows
              },
              favoriteByMessageId: nextFavorites,
              ...(state.loadingConversationId === conversationId
                ? {}
                : {
                    conversationPreviewById: {
                      ...state.conversationPreviewById,
                      [conversationId]: last ? previewFromMessage(last) : ''
                    }
                  })
            };
          }

          const updatedRows = updateExistingMessageOnly(rows, event.message);
          const nextRows = updatedRows !== rows
            ? updatedRows
            : state.selectedConversationId === conversationId
              ? appendUniqueMessage(rows, event.message)
              : rows;
          if (nextRows === rows) {
            return state;
          }

          const orderedRows = normalizeMessageOrder(nextRows);
          const last = orderedRows[orderedRows.length - 1];

          return {
            messagesByConversation: {
              ...state.messagesByConversation,
              [conversationId]: orderedRows
            },
            ...(state.loadingConversationId === conversationId
              ? {}
              : {
                  conversationPreviewById: {
                    ...state.conversationPreviewById,
                    [conversationId]: last ? previewFromMessage(last) : ''
                  }
                })
          };
        });
        return;
      }

      if (event.type === 'message:removed') {
        set((state) => ({
          messagesByConversation: {
            ...state.messagesByConversation,
            [event.conversationId]: (state.messagesByConversation[event.conversationId] || []).filter(
              (row) => row.messageId !== event.messageId
            )
          },
          favoriteByMessageId: (() => {
            const next = { ...state.favoriteByMessageId };
            delete next[event.messageId];
            return next;
          })(),
          announcementReactionsByMessage: (() => {
            const next = { ...state.announcementReactionsByMessage };
            delete next[event.messageId];
            return next;
          })(),
          announcementReadsByMessage: (() => {
            const next = { ...state.announcementReadsByMessage };
            delete next[event.messageId];
            return next;
          })()
        }));
        void ipcClient.getConversationPreviews([event.conversationId]).then((previewMap) => {
          set((state) => {
            const merged = mergePreviewMapIfChanged(state.conversationPreviewById, previewMap);
            if (!merged) return state;
            return { conversationPreviewById: merged };
          });
        });
        return;
      }

      if (event.type === 'message:favorite') {
        set((state) => ({
          favoriteByMessageId: mergeFavoriteMap(state.favoriteByMessageId, {
            [event.messageId]: event.favorite
          })
        }));
        return;
      }

      if (event.type === 'conversation:cleared') {
        set((state) => {
          const conversationMessageIds = (
            state.messagesByConversation[event.conversationId] || []
          ).map((row) => row.messageId);
          const nextFavorites = { ...state.favoriteByMessageId };
          const nextAnnouncementReactions = { ...state.announcementReactionsByMessage };
          const nextAnnouncementReads = { ...state.announcementReadsByMessage };
          for (const messageId of conversationMessageIds) {
            delete nextFavorites[messageId];
            delete nextAnnouncementReactions[messageId];
            delete nextAnnouncementReads[messageId];
          }
          return {
            messagesByConversation: {
              ...state.messagesByConversation,
              [event.conversationId]: []
            },
            hasMoreHistoryByConversation: {
              ...state.hasMoreHistoryByConversation,
              [event.conversationId]: false
            },
            loadingOlderByConversation: {
              ...state.loadingOlderByConversation,
              [event.conversationId]: false
            },
            conversationPreviewById: {
              ...state.conversationPreviewById,
              [event.conversationId]: ''
            },
            favoriteByMessageId: nextFavorites,
            announcementReactionsByMessage:
              event.conversationId === ANNOUNCEMENTS_ID
                ? nextAnnouncementReactions
                : state.announcementReactionsByMessage,
            announcementReadsByMessage:
              event.conversationId === ANNOUNCEMENTS_ID
                ? nextAnnouncementReads
                : state.announcementReadsByMessage,
            unreadByConversation: {
              ...state.unreadByConversation,
              [event.conversationId]: 0
            },
            unreadAnchorMessageIdByConversation: {
              ...state.unreadAnchorMessageIdByConversation,
              [event.conversationId]: null
            }
          };
        });
        return;
      }

      if (event.type === 'transfer:progress') {
        const completed =
          event.stage === 'complete' ||
          (!event.stage && event.total > 0 && event.transferred >= event.total);
        if (!completed) {
          clearTransferCleanupTimer(event.fileId);
        }

        set((state) => ({
          transfers: {
            ...state.transfers,
            [event.fileId]: event
          }
        }));

        if (completed && typeof window !== 'undefined') {
          scheduleTransferCleanup(event.fileId);
        }
        return;
      }

      if (event.type === 'navigate') {
        void get().selectConversation(event.conversationId);
        return;
      }

      if (event.type === 'typing:update') {
        const key = event.conversationId;
        const existingTimer = typingTimers.get(key);
        if (existingTimer) {
          window.clearTimeout(existingTimer);
          typingTimers.delete(key);
        }
        set((state) => ({
          typingByConversation: {
            ...state.typingByConversation,
            [key]: event.isTyping
          }
        }));

        if (event.isTyping) {
          const timeoutId = window.setTimeout(() => {
            typingTimers.delete(key);
            set((state) => ({
              typingByConversation: {
                ...state.typingByConversation,
                [key]: false
              }
            }));
          }, 3200);
          typingTimers.set(key, timeoutId);
        }
        return;
      }

      if (event.type === 'announcement:reactions') {
        set((state) => ({
          announcementReactionsByMessage: {
            ...state.announcementReactionsByMessage,
            [event.messageId]: event.summary
          }
        }));
        return;
      }

      if (event.type === 'announcement:reads') {
        set((state) => ({
          announcementReadsByMessage: {
            ...state.announcementReadsByMessage,
            [event.messageId]: event.summary
          }
        }));
        return;
      }

      if (event.type === 'message:reactions') {
        set((state) => ({
          announcementReactionsByMessage: {
            ...state.announcementReactionsByMessage,
            [event.messageId]: event.summary
          }
        }));
        return;
      }

      if (event.type === 'ui:toast') {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        set((state) => ({
          toasts: [...state.toasts, { id, level: event.level, message: event.message }]
        }));
        window.setTimeout(() => {
          get().dismissToast(id);
        }, 4200);
      }
    });

    void refreshPeersSnapshot();

    void ipcClient.getRelaySettings().then((latestRelaySettings) => {
      set((state) => {
        if (
          state.relaySettings &&
          state.relaySettings.automatic === latestRelaySettings.automatic &&
          state.relaySettings.host === latestRelaySettings.host &&
          state.relaySettings.port === latestRelaySettings.port &&
          state.relaySettings.connected === latestRelaySettings.connected &&
          state.relaySettings.endpoint === latestRelaySettings.endpoint
        ) {
          return state;
        }
        return { relaySettings: latestRelaySettings };
      });
    });

    previewRefreshTimer = window.setInterval(() => {
      const state = get();
      const ids = buildConversationIdsForPreview(state);
      void ipcClient.getConversationPreviews(ids).then((previewMap) => {
        set((current) => {
          const merged = mergePreviewMapIfChanged(current.conversationPreviewById, previewMap);
          if (!merged) return current;
          return { conversationPreviewById: merged };
        });
      });
    }, 15_000);

    peerRefreshTimer = window.setInterval(() => {
      void refreshPeersSnapshot();
    }, 10_000);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Não foi possível carregar o estado inicial do Lantern.';
      if (get().profile) {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        set((state) => ({
          ready: true,
          startupError: null,
          loadingConversationId: null,
          toasts: [...state.toasts, { id, level: 'warning', message }]
        }));
        window.setTimeout(() => get().dismissToast(id), 4200);
        return;
      }
      set((state) => ({
        ready: true,
        startupError: message,
        relaySettings:
          state.relaySettings || {
            automatic: true,
            host: '',
            port: 43190,
            connected: false,
            endpoint: null
          }
      }));
    }
  },
  login: async (input) => {
    set({ startupError: null });
    await ipcClient.login(input);
    await get().loadInitial();
  },
  register: async (input) => {
    set({ startupError: null });
    await ipcClient.register(input);
    await get().loadInitial();
  },
  completeFirstLoginSetup: async (input) => {
    const authState = await ipcClient.completeFirstLoginSetup(input);
    set({ authState });
    await get().loadInitial();
  },
  logout: async () => {
    await ipcClient.logout();
    const authState = await ipcClient.getAuthState();
    set({
      authState,
      profile: null,
      peers: [],
      groups: [],
      pinnedConversationIds: [],
      onlinePeerIds: [],
      messagesByConversation: {},
      unreadByConversation: {},
      conversationPreviewById: {},
      selectedConversationId: ANNOUNCEMENTS_ID,
      settingsOpen: false,
      ready: true
    });
  },
  selectConversation: async (conversationId) => {
    const preSelectState = get();
    const unreadCountAtOpen = preSelectState.unreadByConversation[conversationId] || 0;
    const existingRows = preSelectState.messagesByConversation[conversationId] || [];
    const existingAnchorMessageId =
      unreadCountAtOpen > 0 && existingRows.length > 0
        ? existingRows[
            Math.max(0, existingRows.length - Math.min(unreadCountAtOpen, existingRows.length))
          ]?.messageId || null
        : null;

    set((state) => ({
      selectedConversationId: conversationId,
      loadingConversationId: conversationId,
      openedUnreadCountByConversation: {
        ...state.openedUnreadCountByConversation,
        [conversationId]: unreadCountAtOpen
      },
      unreadAnchorMessageIdByConversation: {
        ...state.unreadAnchorMessageIdByConversation,
        [conversationId]: existingAnchorMessageId
      }
    }));
    try {
      // Ativa primeiro para que o processo principal possa iniciar a recuperação
      // sob demanda enquanto a página canônica é carregada.
      await ipcClient.setActiveConversation(conversationId);
      const rows = normalizeMessageOrder(
        await ipcClient.getMessages(conversationId, MESSAGES_PAGE_SIZE)
      );
      const hasMoreHistory = rows.length === MESSAGES_PAGE_SIZE;
      const messageIds = rows.map((row) => row.messageId);
      const [messageReactions, favoritesMap, announcementReads] =
        messageIds.length > 0
          ? await Promise.all([
              conversationId === ANNOUNCEMENTS_ID
                ? ipcClient.getAnnouncementReactions(messageIds)
                : ipcClient.getMessageReactions(messageIds),
              ipcClient.getMessageFavorites(messageIds),
              conversationId === ANNOUNCEMENTS_ID
                ? ipcClient.getAnnouncementReadSummary(messageIds)
                : Promise.resolve({})
            ])
          : [{}, {}, {}];
      await ipcClient.markConversationRead(conversationId);

      const fetchedAnchorMessageId =
        unreadCountAtOpen > 0 && rows.length > 0
          ? rows[Math.max(0, rows.length - Math.min(unreadCountAtOpen, rows.length))]
              ?.messageId || null
          : null;

      set((state) => {
        // Um download rápido pode emitir message:updated durante os awaits
        // acima. A resposta de getMessages é um snapshot anterior e nunca deve
        // apagar um filePath que já chegou pelo canal de eventos.
        const mergedRows = mergeFetchedMessagesWithLiveUpdates(
          rows,
          existingRows,
          state.messagesByConversation[conversationId] || []
        );
        return {
        messagesByConversation: {
          ...state.messagesByConversation,
          [conversationId]: mergedRows
        },
        hasMoreHistoryByConversation: {
          ...state.hasMoreHistoryByConversation,
          [conversationId]: hasMoreHistory
        },
        loadingOlderByConversation: {
          ...state.loadingOlderByConversation,
          [conversationId]: false
        },
        conversationPreviewById: {
          ...state.conversationPreviewById,
          [conversationId]: mergedRows.length > 0
            ? previewFromMessage(mergedRows[mergedRows.length - 1])
            : ''
        },
        unreadByConversation: {
          ...state.unreadByConversation,
          [conversationId]: 0
        },
        announcementReactionsByMessage:
          {
            ...state.announcementReactionsByMessage,
            ...messageReactions
          },
        announcementReadsByMessage: {
          ...state.announcementReadsByMessage,
          ...announcementReads
        },
        favoriteByMessageId: mergeFavoriteMap(state.favoriteByMessageId, favoritesMap),
        unreadAnchorMessageIdByConversation: {
          ...state.unreadAnchorMessageIdByConversation,
          [conversationId]: fetchedAnchorMessageId
        },
        loadingConversationId:
          state.loadingConversationId === conversationId ? null : state.loadingConversationId
        };
      });
    } catch {
      set((state) => ({
        loadingOlderByConversation: {
          ...state.loadingOlderByConversation,
          [conversationId]: false
        },
        loadingConversationId:
          state.loadingConversationId === conversationId ? null : state.loadingConversationId
      }));
    }
  },
  closeConversation: async () => {
    await ipcClient.setActiveConversation('');
    set({
      selectedConversationId: '',
      loadingConversationId: null
    });
  },
  markConversationUnread: async (conversationId) => {
    if (!conversationId) return;
    await ipcClient.markConversationUnread(conversationId);
    set((state) => ({
      unreadByConversation: {
        ...state.unreadByConversation,
        [conversationId]: Math.max(1, state.unreadByConversation[conversationId] || 0)
      }
    }));
  },
  archiveConversation: async (conversationId) => {
    if (!conversationId.startsWith('dm:')) return;
    await ipcClient.archiveConversation(conversationId);
    set((state) => {
      if (state.archivedConversationIds.includes(conversationId)) {
        return state;
      }
      return {
        archivedConversationIds: [conversationId, ...state.archivedConversationIds]
      };
    });
  },
  unarchiveConversation: async (conversationId) => {
    if (!conversationId.startsWith('dm:')) return;
    await ipcClient.unarchiveConversation(conversationId);
    set((state) => ({
      archivedConversationIds: state.archivedConversationIds.filter((id) => id !== conversationId)
    }));
  },
  setConversationPinned: async (conversationId, pinned) => {
    await ipcClient.setConversationPinned(conversationId, pinned);
    set((state) => ({
      pinnedConversationIds: pinned
        ? [conversationId, ...state.pinnedConversationIds.filter((id) => id !== conversationId)]
        : state.pinnedConversationIds.filter((id) => id !== conversationId)
    }));
  },
  loadOlderMessages: async (conversationId, limit = MESSAGES_PAGE_SIZE) => {
    const safeLimit = Number.isFinite(limit)
      ? Math.max(20, Math.min(Math.trunc(limit), 200))
      : MESSAGES_PAGE_SIZE;
    const snapshot = get();
    if (snapshot.loadingOlderByConversation[conversationId]) {
      return 0;
    }

    const currentRows = snapshot.messagesByConversation[conversationId] || [];
    if (snapshot.hasMoreHistoryByConversation[conversationId] === false && currentRows.length > 0) {
      return 0;
    }
    const oldest = currentRows[0];
    const before = oldest?.createdAt;

    set((state) => ({
      loadingOlderByConversation: {
        ...state.loadingOlderByConversation,
        [conversationId]: true
      }
    }));

    try {
      const olderRows = normalizeMessageOrder(
        await ipcClient.getMessages(conversationId, safeLimit, before)
      );

      if (olderRows.length === 0) {
        set((state) => ({
          hasMoreHistoryByConversation: {
            ...state.hasMoreHistoryByConversation,
            [conversationId]: false
          },
          loadingOlderByConversation: {
            ...state.loadingOlderByConversation,
            [conversationId]: false
          }
        }));
        return 0;
      }

      const knownIds = new Set(currentRows.map((row) => row.messageId));
      const newlyAddedRows = olderRows.filter((row) => !knownIds.has(row.messageId));
      const messageIds = olderRows.map((row) => row.messageId);
      const [reactionMap, favoritesMap, announcementReads] =
        messageIds.length > 0
          ? await Promise.all([
              conversationId === ANNOUNCEMENTS_ID
                ? ipcClient.getAnnouncementReactions(messageIds)
                : ipcClient.getMessageReactions(messageIds),
              ipcClient.getMessageFavorites(messageIds),
              conversationId === ANNOUNCEMENTS_ID
                ? ipcClient.getAnnouncementReadSummary(messageIds)
                : Promise.resolve({})
            ])
          : [{}, {}, {}];

      set((state) => ({
        messagesByConversation: {
          ...state.messagesByConversation,
          [conversationId]: mergeOrderedMessages(
            state.messagesByConversation[conversationId] || [],
            olderRows
          )
        },
        hasMoreHistoryByConversation: {
          ...state.hasMoreHistoryByConversation,
          [conversationId]: olderRows.length === safeLimit
        },
        loadingOlderByConversation: {
          ...state.loadingOlderByConversation,
          [conversationId]: false
        },
        announcementReactionsByMessage: {
          ...state.announcementReactionsByMessage,
          ...reactionMap
        },
        announcementReadsByMessage: {
          ...state.announcementReadsByMessage,
          ...announcementReads
        },
        favoriteByMessageId: mergeFavoriteMap(state.favoriteByMessageId, favoritesMap)
      }));
      return newlyAddedRows.length;
    } catch {
      set((state) => ({
        loadingOlderByConversation: {
          ...state.loadingOlderByConversation,
          [conversationId]: false
        }
      }));
      return 0;
    }
  },
  ensureConversationMessagesLoaded: async (conversationId, messageIds) => {
    const uniqueIds = Array.from(
      new Set(
        messageIds
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      )
    );
    if (uniqueIds.length === 0) {
      return;
    }

    const state = get();
    const existingIds = new Set(
      (state.messagesByConversation[conversationId] || []).map((row) => row.messageId)
    );
    const missing = uniqueIds.filter((messageId) => !existingIds.has(messageId));
    if (missing.length === 0) {
      return;
    }

    const incomingRows = normalizeMessageOrder(await ipcClient.getMessagesByIds(missing));
    if (incomingRows.length === 0) {
      return;
    }
    const incomingMessageIds = incomingRows.map((row) => row.messageId);
    const [reactionMap, favoritesMap, announcementReads] =
      incomingMessageIds.length > 0
        ? await Promise.all([
            conversationId === ANNOUNCEMENTS_ID
              ? ipcClient.getAnnouncementReactions(incomingMessageIds)
              : ipcClient.getMessageReactions(incomingMessageIds),
            ipcClient.getMessageFavorites(incomingMessageIds),
            conversationId === ANNOUNCEMENTS_ID
              ? ipcClient.getAnnouncementReadSummary(incomingMessageIds)
              : Promise.resolve({})
          ])
        : [{}, {}, {}];

    set((current) => {
      const rows = current.messagesByConversation[conversationId] || [];
      const byId = new Map(rows.map((row) => [row.messageId, row]));
      for (const row of incomingRows) {
        if (row.conversationId !== conversationId) continue;
        byId.set(row.messageId, row);
      }
      return {
        messagesByConversation: {
          ...current.messagesByConversation,
          [conversationId]: normalizeMessageOrder(Array.from(byId.values()))
        },
        announcementReactionsByMessage: {
          ...current.announcementReactionsByMessage,
          ...reactionMap
        },
        announcementReadsByMessage: {
          ...current.announcementReadsByMessage,
          ...announcementReads
        },
        favoriteByMessageId: mergeFavoriteMap(current.favoriteByMessageId, favoritesMap)
      };
    });
  },
  sendText: async (peerId, text, replyTo) => {
    const conversationId = `dm:${peerId}`;
    try {
      const message = await ipcClient.sendText(peerId, text, replyTo);
      set((state) => ({
        messagesByConversation: {
          ...state.messagesByConversation,
          [message.conversationId]: appendUniqueMessage(
            state.messagesByConversation[message.conversationId] || [],
            message
          )
        },
        conversationPreviewById: {
          ...state.conversationPreviewById,
          [message.conversationId]: previewFromMessage(message)
        }
      }));
    } catch {
      const pendingMessage: MessageRow = {
        messageId: `local-pending:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        conversationId,
        direction: 'out',
        senderDeviceId: get().profile?.deviceId || 'local',
        receiverDeviceId: peerId,
        type: 'text',
        bodyText: text,
        fileId: null,
        fileName: null,
        fileSize: null,
        fileSha256: null,
        filePath: null,
        status: 'sent',
        reaction: null,
        deletedAt: null,
        replyToMessageId: replyTo?.messageId || null,
        replyToSenderDeviceId: replyTo?.senderDeviceId || null,
        replyToType: replyTo?.type || null,
        replyToPreviewText: replyTo?.previewText || null,
        replyToFileName: replyTo?.fileName || null,
        forwardedFromMessageId: null,
        editedAt: null,
        createdAt: Date.now(),
        localOnly: true
      };

      set((state) => ({
        messagesByConversation: {
          ...state.messagesByConversation,
          [conversationId]: appendUniqueMessage(
            state.messagesByConversation[conversationId] || [],
            pendingMessage
          )
        },
        conversationPreviewById: {
          ...state.conversationPreviewById,
          [conversationId]: previewFromMessage(pendingMessage)
        }
      }));
    }
  },
  sendGroupText: async (groupId, text, replyTo) => {
    const conversationId = `group:${groupId}`;
    try {
      const message = await ipcClient.sendGroupText(groupId, text, replyTo);
      set((state) => ({
        messagesByConversation: {
          ...state.messagesByConversation,
          [message.conversationId]: appendUniqueMessage(
            state.messagesByConversation[message.conversationId] || [],
            message
          )
        },
        conversationPreviewById: {
          ...state.conversationPreviewById,
          [message.conversationId]: previewFromMessage(message)
        }
      }));
    } catch (error) {
      const toastMessage =
        error instanceof Error ? error.message : 'Não foi possível enviar mensagem no grupo.';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((state) => ({
        toasts: [...state.toasts, { id, level: 'error', message: toastMessage }],
        conversationPreviewById: {
          ...state.conversationPreviewById,
          [conversationId]: text
        }
      }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    }
  },
  sendTyping: async (peerId, isTyping) => {
    try {
      await ipcClient.sendTyping(peerId, isTyping);
    } catch {
      // ignora falhas silenciosamente
    }
  },
  sendAnnouncement: async (text, replyTo) => {
    try {
      const message = await ipcClient.sendAnnouncement(text, replyTo);
      set((state) => ({
        messagesByConversation: {
          ...state.messagesByConversation,
          [ANNOUNCEMENTS_ID]: appendUniqueMessage(
            state.messagesByConversation[ANNOUNCEMENTS_ID] || [],
            message
          )
        },
        conversationPreviewById: {
          ...state.conversationPreviewById,
          [ANNOUNCEMENTS_ID]: previewFromMessage(message)
        }
      }));

      void ipcClient
        .getAnnouncementReactions([message.messageId])
        .then(async (reactionMap) => {
          const readMap = await ipcClient.getAnnouncementReadSummary([message.messageId]);
          set((state) => ({
            announcementReactionsByMessage: {
              ...state.announcementReactionsByMessage,
              ...reactionMap
            },
            announcementReadsByMessage: {
              ...state.announcementReadsByMessage,
              ...readMap
            }
          }));
        })
        .catch(() => {
          // Não bloqueia UX do envio de anúncio se a consulta de reações falhar.
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao enviar anúncio.';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((state) => ({
        toasts: [...state.toasts, { id, level: 'error', message }]
      }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    }
  },
  sendAnnouncementFile: async (filePath, replyTo) => {
    try {
      const message = await ipcClient.sendAnnouncementFile(filePath, replyTo);
      set((state) => ({
        messagesByConversation: {
          ...state.messagesByConversation,
          [ANNOUNCEMENTS_ID]: appendUniqueMessage(
            state.messagesByConversation[ANNOUNCEMENTS_ID] || [],
            message
          )
        },
        conversationPreviewById: {
          ...state.conversationPreviewById,
          [ANNOUNCEMENTS_ID]: previewFromMessage(message)
        }
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao enviar anexo no anúncio.';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((state) => ({ toasts: [...state.toasts, { id, level: 'error', message }] }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    }
  },
  sendFile: async (peerId, filePath, replyTo) => {
    try {
      const message = await ipcClient.sendFile(peerId, filePath, replyTo);
      set((state) => ({
        messagesByConversation: {
          ...state.messagesByConversation,
          [message.conversationId]: appendUniqueMessage(
            state.messagesByConversation[message.conversationId] || [],
            message
          )
        },
        conversationPreviewById: {
          ...state.conversationPreviewById,
          [message.conversationId]: previewFromMessage(message)
        }
      }));
    } catch (error) {
      const toastMessage =
        error instanceof Error
          ? error.message
          : 'Não foi possível enviar o anexo.';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((state) => ({
        toasts: [...state.toasts, { id, level: 'error', message: toastMessage }]
      }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    }
  },
  sendGroupFile: async (groupId, filePath, replyTo) => {
    try {
      const message = await ipcClient.sendGroupFile(groupId, filePath, replyTo);
      set((state) => ({
        messagesByConversation: {
          ...state.messagesByConversation,
          [message.conversationId]: appendUniqueMessage(
            state.messagesByConversation[message.conversationId] || [],
            message
          )
        },
        conversationPreviewById: {
          ...state.conversationPreviewById,
          [message.conversationId]: previewFromMessage(message)
        }
      }));
    } catch (error) {
      const toastMessage =
        error instanceof Error ? error.message : 'Não foi possível enviar o anexo no grupo.';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((state) => ({
        toasts: [...state.toasts, { id, level: 'error', message: toastMessage }]
      }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    }
  },
  forwardMessageToPeer: async (targetPeerId, sourceMessageId) => {
    try {
      const message = await ipcClient.forwardMessageToPeer(targetPeerId, sourceMessageId);
      set((state) => ({
        messagesByConversation: {
          ...state.messagesByConversation,
          [message.conversationId]: appendUniqueMessage(
            state.messagesByConversation[message.conversationId] || [],
            message
          )
        },
        conversationPreviewById: {
          ...state.conversationPreviewById,
          [message.conversationId]: previewFromMessage(message)
        }
      }));
    } catch (error) {
      const toastMessage =
        error instanceof Error
          ? error.message
          : 'Não foi possível encaminhar a mensagem.';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((state) => ({
        toasts: [...state.toasts, { id, level: 'error', message: toastMessage }]
      }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    }
  },
  editMessage: async (conversationId, messageId, text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      const updated = await ipcClient.editMessage(conversationId, messageId, trimmed);
      if (!updated) return;
      set((state) => {
        const rows = state.messagesByConversation[conversationId] || [];
        const nextRows = updateExistingMessageOnly(rows, updated);
        if (nextRows === rows) return state;
        const orderedRows = normalizeMessageOrder(nextRows);
        const last = orderedRows[orderedRows.length - 1];
        return {
          messagesByConversation: {
            ...state.messagesByConversation,
            [conversationId]: orderedRows
          },
          conversationPreviewById: {
            ...state.conversationPreviewById,
            [conversationId]: last ? previewFromMessage(last) : ''
          }
        };
      });
    } catch (error) {
      const toastMessage =
        error instanceof Error ? error.message : 'Não foi possível editar a mensagem.';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((state) => ({
        toasts: [...state.toasts, { id, level: 'error', message: toastMessage }]
      }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    }
  },
  reactToMessage: async (conversationId, messageId, reaction) => {
    try {
      await ipcClient.reactToMessage(conversationId, messageId, reaction);
    } catch (error) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const message = error instanceof Error ? error.message : 'Não foi possível atualizar a reação.';
      set((state) => ({
        toasts: [...state.toasts, { id, level: 'error', message }]
      }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    }
  },
  toggleMessageFavorite: async (conversationId, messageId, favorite) => {
    const nextFavorite = await ipcClient.toggleMessageFavorite(
      conversationId,
      messageId,
      favorite
    );
    set((state) => ({
      favoriteByMessageId: mergeFavoriteMap(state.favoriteByMessageId, {
        [messageId]: nextFavorite
      })
    }));
  },
  getFavoriteMessages: async (conversationId) => {
    const rows = normalizeMessageOrder(await ipcClient.getFavoriteMessages(conversationId));
    const messageIds = rows.map((row) => row.messageId);
    const [reactionMap, favoritesMap, announcementReads] =
      messageIds.length > 0
        ? await Promise.all([
            conversationId === ANNOUNCEMENTS_ID
              ? ipcClient.getAnnouncementReactions(messageIds)
              : ipcClient.getMessageReactions(messageIds),
            ipcClient.getMessageFavorites(messageIds),
            conversationId === ANNOUNCEMENTS_ID
              ? ipcClient.getAnnouncementReadSummary(messageIds)
              : Promise.resolve({})
          ])
        : [{}, {}, {}];

    set((state) => ({
      messagesByConversation: {
        ...state.messagesByConversation,
        [conversationId]: mergeOrderedMessages(
          state.messagesByConversation[conversationId] || [],
          rows
        )
      },
      announcementReactionsByMessage: {
        ...state.announcementReactionsByMessage,
        ...reactionMap
      },
      announcementReadsByMessage: {
        ...state.announcementReadsByMessage,
        ...announcementReads
      },
      favoriteByMessageId: mergeFavoriteMap(state.favoriteByMessageId, favoritesMap)
    }));
    return rows;
  },
  deleteMessageForEveryone: async (conversationId, messageId) => {
    const updated = await ipcClient.deleteMessageForEveryone(conversationId, messageId);
    if (!updated) return;
    set((state) => ({
      messagesByConversation: {
        ...state.messagesByConversation,
        [conversationId]: (state.messagesByConversation[conversationId] || []).filter(
          (row) => row.messageId !== messageId
        )
      },
      favoriteByMessageId: (() => {
        const next = { ...state.favoriteByMessageId };
        delete next[messageId];
        return next;
      })(),
      announcementReactionsByMessage: (() => {
        if (conversationId !== ANNOUNCEMENTS_ID) {
          return state.announcementReactionsByMessage;
        }
        const next = { ...state.announcementReactionsByMessage };
        delete next[messageId];
        return next;
      })(),
      announcementReadsByMessage: (() => {
        if (conversationId !== ANNOUNCEMENTS_ID) {
          return state.announcementReadsByMessage;
        }
        const next = { ...state.announcementReadsByMessage };
        delete next[messageId];
        return next;
      })()
    }));
    void ipcClient.getConversationPreviews([conversationId]).then((previewMap) => {
      set((state) => {
        const merged = mergePreviewMapIfChanged(state.conversationPreviewById, previewMap);
        if (!merged) return state;
        return { conversationPreviewById: merged };
      });
    });
  },
  deleteMessageForMe: async (conversationId, messageId) => {
    const hidden = await ipcClient.deleteMessageForMe(conversationId, messageId);
    if (!hidden) return;
    set((state) => ({
      messagesByConversation: {
        ...state.messagesByConversation,
        [conversationId]: (state.messagesByConversation[conversationId] || []).filter(
          (row) => row.messageId !== messageId
        )
      },
      favoriteByMessageId: (() => {
        const next = { ...state.favoriteByMessageId };
        delete next[messageId];
        return next;
      })(),
      announcementReactionsByMessage: (() => {
        const next = { ...state.announcementReactionsByMessage };
        delete next[messageId];
        return next;
      })(),
      announcementReadsByMessage: (() => {
        const next = { ...state.announcementReadsByMessage };
        delete next[messageId];
        return next;
      })()
    }));
    void ipcClient.getConversationPreviews([conversationId]).then((previewMap) => {
      set((state) => {
        const merged = mergePreviewMapIfChanged(state.conversationPreviewById, previewMap);
        if (!merged) return state;
        return { conversationPreviewById: merged };
      });
    });
  },
  exportConversation: async (conversationId, format) => {
    try {
      const result = await ipcClient.exportConversation(conversationId, format);
      if (result.canceled) return;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((state) => ({
        toasts: [...state.toasts, { id, level: 'success', message: 'Conversa exportada.' }]
      }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    } catch (error) {
      const toastMessage =
        error instanceof Error ? error.message : 'Não foi possível exportar a conversa.';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((state) => ({
        toasts: [...state.toasts, { id, level: 'error', message: toastMessage }]
      }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    }
  },
  resyncConversation: async (conversationId) => {
    const baselineRows = get().messagesByConversation[conversationId] || [];
    try {
      await ipcClient.resyncConversation(conversationId);
      const rows = normalizeMessageOrder(
        await ipcClient.getMessages(conversationId, MESSAGES_PAGE_SIZE)
      );
      const messageIds = rows.map((row) => row.messageId);
      const [reactionMap, favoritesMap, announcementReads] = messageIds.length > 0
        ? await Promise.all([
            conversationId === ANNOUNCEMENTS_ID
              ? ipcClient.getAnnouncementReactions(messageIds)
              : ipcClient.getMessageReactions(messageIds),
            ipcClient.getMessageFavorites(messageIds),
            conversationId === ANNOUNCEMENTS_ID
              ? ipcClient.getAnnouncementReadSummary(messageIds)
              : Promise.resolve({})
          ])
        : [{}, {}, {}];
      set((state) => {
        const refreshedRows = mergeRepairedConversationPage(
          rows,
          baselineRows,
          state.messagesByConversation[conversationId] || []
        );
        return {
          messagesByConversation: {
            ...state.messagesByConversation,
            [conversationId]: refreshedRows
          },
          hasMoreHistoryByConversation: {
            ...state.hasMoreHistoryByConversation,
            [conversationId]: rows.length === MESSAGES_PAGE_SIZE
          },
          conversationPreviewById: {
            ...state.conversationPreviewById,
            [conversationId]: refreshedRows.length > 0
              ? previewFromMessage(refreshedRows[refreshedRows.length - 1])
              : ''
          },
          announcementReactionsByMessage: {
            ...state.announcementReactionsByMessage,
            ...reactionMap
          },
          announcementReadsByMessage: {
            ...state.announcementReadsByMessage,
            ...announcementReads
          },
          favoriteByMessageId: mergeFavoriteMap(state.favoriteByMessageId, favoritesMap)
        };
      });
    } catch (error) {
      const toastMessage =
        error instanceof Error ? error.message : 'Não foi possível reparar o cache da conversa.';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((state) => ({
        toasts: [...state.toasts, { id, level: 'error', message: toastMessage }]
      }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    }
  },
  clearConversation: async (conversationId) => {
    await ipcClient.clearConversation(conversationId);
    set((state) => {
      const conversationMessageIds = (state.messagesByConversation[conversationId] || []).map(
        (row) => row.messageId
      );
      const nextFavorites = { ...state.favoriteByMessageId };
      const nextAnnouncementReads = { ...state.announcementReadsByMessage };
      for (const messageId of conversationMessageIds) {
        delete nextFavorites[messageId];
        delete nextAnnouncementReads[messageId];
      }
      return {
        messagesByConversation: {
          ...state.messagesByConversation,
          [conversationId]: []
        },
        hasMoreHistoryByConversation: {
          ...state.hasMoreHistoryByConversation,
          [conversationId]: false
        },
        loadingOlderByConversation: {
          ...state.loadingOlderByConversation,
          [conversationId]: false
        },
        announcementReactionsByMessage:
          conversationId === ANNOUNCEMENTS_ID ? {} : state.announcementReactionsByMessage,
        announcementReadsByMessage:
          conversationId === ANNOUNCEMENTS_ID ? {} : nextAnnouncementReads,
        favoriteByMessageId: nextFavorites,
        conversationPreviewById: {
          ...state.conversationPreviewById,
          [conversationId]: ''
        },
        unreadByConversation: {
          ...state.unreadByConversation,
          [conversationId]: 0
        },
        unreadAnchorMessageIdByConversation: {
          ...state.unreadAnchorMessageIdByConversation,
          [conversationId]: null
        }
      };
    });
  },
  updateProfile: async (input) => {
    const profile = await ipcClient.updateProfile(input);
    set({ profile });
  },
  createGroup: async (input) => {
    try {
      const group = await ipcClient.createGroup(input);
      const members = await ipcClient.getGroupMembers(group.groupId).catch(() => []);
      const pinnedMessageIds = await ipcClient.getGroupPinnedMessageIds(group.groupId).catch(() => []);
      set((state) => ({
        groups: [group, ...state.groups.filter((existing) => existing.groupId !== group.groupId)],
        groupMembersById: {
          ...state.groupMembersById,
          [group.groupId]: members
        },
        groupPinnedMessageIdsById: {
          ...state.groupPinnedMessageIdsById,
          [group.groupId]: pinnedMessageIds
        }
      }));
      await get().selectConversation(`group:${group.groupId}`);
    } catch (error) {
      const toastMessage =
        error instanceof Error ? error.message : 'Não foi possível criar o grupo.';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((state) => ({
        toasts: [...state.toasts, { id, level: 'error', message: toastMessage }]
      }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    }
  },
  updateGroup: async (groupId, input) => {
    try {
      await ipcClient.updateGroup(groupId, input);
      const groups = await ipcClient.getGroups();
      set({ groups });
    } catch (error) {
      const toastMessage =
        error instanceof Error ? error.message : 'Não foi possível atualizar o grupo.';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((state) => ({
        toasts: [...state.toasts, { id, level: 'error', message: toastMessage }]
      }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    }
  },
  addGroupMembers: async (groupId, memberDeviceIds) => {
    try {
      await ipcClient.addGroupMembers(groupId, memberDeviceIds);
      const members = await ipcClient.getGroupMembers(groupId).catch(() => []);
      set((state) => ({
        groupMembersById: {
          ...state.groupMembersById,
          [groupId]: members
        }
      }));
    } catch (error) {
      const toastMessage =
        error instanceof Error ? error.message : 'Não foi possível adicionar participantes.';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((state) => ({
        toasts: [...state.toasts, { id, level: 'error', message: toastMessage }]
      }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    }
  },
  removeGroupMember: async (groupId, deviceId) => {
    try {
      await ipcClient.removeGroupMember(groupId, deviceId);
      const members = await ipcClient.getGroupMembers(groupId).catch(() => []);
      set((state) => ({
        groupMembersById: {
          ...state.groupMembersById,
          [groupId]: members
        }
      }));
    } catch (error) {
      const toastMessage =
        error instanceof Error ? error.message : 'Não foi possível remover o participante.';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((state) => ({
        toasts: [...state.toasts, { id, level: 'error', message: toastMessage }]
      }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    }
  },
  setGroupMemberRole: async (groupId, deviceId, role) => {
    try {
      await ipcClient.setGroupMemberRole(groupId, deviceId, role);
      const members = await ipcClient.getGroupMembers(groupId).catch(() => []);
      set((state) => ({
        groupMembersById: {
          ...state.groupMembersById,
          [groupId]: members
        }
      }));
    } catch (error) {
      const toastMessage =
        error instanceof Error ? error.message : 'Não foi possível alterar a função do participante.';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((state) => ({
        toasts: [...state.toasts, { id, level: 'error', message: toastMessage }]
      }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    }
  },
  transferGroupOwnership: async (groupId, deviceId) => {
    try {
      await ipcClient.transferGroupOwnership(groupId, deviceId);
      const members = await ipcClient.getGroupMembers(groupId).catch(() => []);
      set((state) => ({
        groupMembersById: {
          ...state.groupMembersById,
          [groupId]: members
        }
      }));
    } catch (error) {
      const toastMessage =
        error instanceof Error ? error.message : 'Não foi possível transferir a propriedade do grupo.';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((state) => ({
        toasts: [...state.toasts, { id, level: 'error', message: toastMessage }]
      }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    }
  },
  deleteGroup: async (groupId) => {
    try {
      await ipcClient.deleteGroup(groupId);
      const groups = await ipcClient.getGroups().catch(() => get().groups);
      set((state) => ({
        groups: groups.filter((group) => group.groupId !== groupId),
        groupMembersById: Object.fromEntries(
          Object.entries(state.groupMembersById).filter(([id]) => id !== groupId)
        ),
        groupPinnedMessageIdsById: Object.fromEntries(
          Object.entries(state.groupPinnedMessageIdsById).filter(([id]) => id !== groupId)
        )
      }));
      if (get().selectedConversationId === `group:${groupId}`) {
        await get().closeConversation();
      }
    } catch (error) {
      const toastMessage =
        error instanceof Error ? error.message : 'Não foi possível excluir o grupo.';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((state) => ({
        toasts: [...state.toasts, { id, level: 'error', message: toastMessage }]
      }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    }
  },
  leaveGroup: async (groupId) => {
    try {
      await ipcClient.leaveGroup(groupId);
      const groups = await ipcClient.getGroups().catch(() => get().groups);
      const members = await ipcClient.getGroupMembers(groupId).catch(() => []);
      set((state) => ({
        groups: groups.filter((group) => group.groupId !== groupId),
        groupMembersById: {
          ...state.groupMembersById,
          [groupId]: members
        }
      }));
      if (get().selectedConversationId === `group:${groupId}`) {
        await get().selectConversation(ANNOUNCEMENTS_ID);
      }
    } catch (error) {
      const toastMessage =
        error instanceof Error ? error.message : 'Não foi possível sair do grupo.';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((state) => ({
        toasts: [...state.toasts, { id, level: 'error', message: toastMessage }]
      }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    }
  },
  setGroupMessagePinned: async (groupId, messageId, pinned) => {
    try {
      const current = get().groupPinnedMessageIdsById[groupId] || [];
      const next = pinned
        ? Array.from(new Set([messageId, ...current]))
        : current.filter((id) => id !== messageId);
      set((state) => ({
        groupPinnedMessageIdsById: {
          ...state.groupPinnedMessageIdsById,
          [groupId]: next
        }
      }));
      await ipcClient.setGroupMessagePinned(groupId, messageId, pinned);
    } catch (error) {
      const pinnedMessageIds = await ipcClient.getGroupPinnedMessageIds(groupId).catch(() => []);
      const toastMessage =
        error instanceof Error ? error.message : 'Não foi possível atualizar o pino do grupo.';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((state) => ({
        groupPinnedMessageIdsById: {
          ...state.groupPinnedMessageIdsById,
          [groupId]: pinnedMessageIds
        },
        toasts: [...state.toasts, { id, level: 'error', message: toastMessage }]
      }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    }
  },
  updateRelaySettings: async (input) => {
    const relaySettings = await ipcClient.updateRelaySettings(input);
    set({ relaySettings });
  },
  forceRelayRediscovery: async () => {
    const relaySettings = await ipcClient.forceRelayRediscovery();
    set({ relaySettings });
  },
  updateStartupSettings: async (input) => {
    const startupSettings = await ipcClient.updateStartupSettings(input);
    set({ startupSettings });
  },
  openFile: async (filePath) => {
    await ipcClient.openFile(filePath);
  },
  saveFileAs: async (filePath, fileName) => {
    await ipcClient.saveFileAs(filePath, fileName || undefined);
  },
  dismissToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== id)
    }));
  }
}));
