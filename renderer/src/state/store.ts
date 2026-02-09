import { create } from 'zustand';
import {
  AnnouncementReactionSummary,
  ipcClient,
  MessageRow,
  Peer,
  Profile,
  RelaySettings,
  StartupSettings
} from '../api/ipcClient';

interface TransferProgress {
  direction: 'send' | 'receive';
  fileId: string;
  messageId: string;
  peerId: string;
  transferred: number;
  total: number;
}

interface UiToast {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

interface LanternState {
  profile: Profile | null;
  relaySettings: RelaySettings | null;
  startupSettings: StartupSettings | null;
  peers: Peer[];
  onlinePeerIds: string[];
  selectedConversationId: string;
  messagesByConversation: Record<string, MessageRow[]>;
  hasMoreHistoryByConversation: Record<string, boolean>;
  loadingOlderByConversation: Record<string, boolean>;
  announcementReactionsByMessage: Record<string, AnnouncementReactionSummary>;
  conversationPreviewById: Record<string, string>;
  unreadByConversation: Record<string, number>;
  typingByConversation: Record<string, boolean>;
  recentMessageIds: Record<string, number>;
  toasts: UiToast[];
  transfers: Record<string, TransferProgress>;
  search: string;
  settingsOpen: boolean;
  themeMode: 'system' | 'light' | 'dark';
  resolvedTheme: 'light' | 'dark';
  ready: boolean;
  syncActive: boolean;
  loadingConversationId: string | null;
  setSearch: (value: string) => void;
  setSettingsOpen: (open: boolean) => void;
  setThemeMode: (mode: 'system' | 'light' | 'dark') => void;
  setSystemDark: (isDark: boolean) => void;
  loadInitial: () => Promise<void>;
  selectConversation: (conversationId: string) => Promise<void>;
  loadOlderMessages: (conversationId: string, limit?: number) => Promise<number>;
  ensureConversationMessagesLoaded: (
    conversationId: string,
    messageIds: string[]
  ) => Promise<void>;
  sendText: (peerId: string, text: string) => Promise<void>;
  sendTyping: (peerId: string, isTyping: boolean) => Promise<void>;
  sendAnnouncement: (text: string) => Promise<void>;
  sendFile: (peerId: string, filePath: string) => Promise<void>;
  reactToMessage: (
    conversationId: string,
    messageId: string,
    reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null
  ) => Promise<void>;
  deleteMessageForEveryone: (conversationId: string, messageId: string) => Promise<void>;
  clearConversation: (conversationId: string) => Promise<void>;
  forgetContactConversation: (conversationId: string) => Promise<void>;
  updateProfile: (input: { displayName: string; avatarEmoji: string; avatarBg: string; statusMessage: string }) => Promise<void>;
  updateRelaySettings: (input: { automatic: boolean; host?: string; port?: number }) => Promise<void>;
  updateStartupSettings: (input: { openAtLogin: boolean; downloadsDir?: string }) => Promise<void>;
  addManualPeer: (address: string, port: number) => Promise<void>;
  openFile: (filePath: string) => Promise<void>;
  saveFileAs: (filePath: string, fileName?: string | null) => Promise<void>;
  dismissToast: (id: string) => void;
}

const ANNOUNCEMENTS_ID = 'announcements';
const THEME_KEY = 'lantern.theme';
const PROFILE_ONBOARDING_KEY_PREFIX = 'lantern.profile.onboarding.done';
const MESSAGES_PAGE_SIZE = 80;

const getInitialThemeMode = (): 'system' | 'light' | 'dark' => {
  if (typeof window === 'undefined') {
    return 'system';
  }
  const stored = window.localStorage.getItem(THEME_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
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
  profile: null,
  relaySettings: null,
  startupSettings: null,
  peers: [],
  onlinePeerIds: [],
  selectedConversationId: ANNOUNCEMENTS_ID,
  messagesByConversation: {},
  hasMoreHistoryByConversation: {},
  loadingOlderByConversation: {},
  announcementReactionsByMessage: {},
  conversationPreviewById: {},
  unreadByConversation: {},
  typingByConversation: {},
  recentMessageIds: {},
  toasts: [],
  transfers: {},
  search: '',
  settingsOpen: false,
  themeMode: initialThemeMode,
  resolvedTheme: resolveTheme(initialThemeMode, initialSystemDark),
  ready: false,
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
  setSystemDark: (isDark) => {
    const mode = get().themeMode;
    set({
      resolvedTheme: resolveTheme(mode, isDark)
    });
  },
  loadInitial: async () => {
    const [profile, relaySettings, startupSettings, peers, onlinePeers, unreadByConversation] =
      await Promise.all([
      ipcClient.getProfile(),
      ipcClient.getRelaySettings(),
      ipcClient.getStartupSettings(),
      ipcClient.getKnownPeers(),
      ipcClient.getOnlinePeers(),
      ipcClient.getConversations()
      ]);

    const conversationIds = [
      ANNOUNCEMENTS_ID,
      ...peers.map((peer) => `dm:${peer.deviceId}`)
    ];
    const conversationPreviewById = await ipcClient.getConversationPreviews(conversationIds);

    const onboardingKey = `${PROFILE_ONBOARDING_KEY_PREFIX}.${profile.deviceId}`;
    const onboardingDone =
      typeof window !== 'undefined' && window.localStorage.getItem(onboardingKey) === '1';
    const profileLooksPristine = profile.updatedAt <= profile.createdAt;
    const shouldOpenSettings = !onboardingDone || profileLooksPristine;

    set({
      profile,
      relaySettings,
      startupSettings,
      peers,
      onlinePeerIds: onlinePeers.map((peer) => peer.deviceId).sort((a, b) => a.localeCompare(b)),
      unreadByConversation,
      conversationPreviewById,
      settingsOpen: shouldOpenSettings,
      ready: true,
      loadingConversationId: get().selectedConversationId
    });

    const current = get().selectedConversationId;
    const initialMessages = normalizeMessageOrder(
      await ipcClient.getMessages(current, MESSAGES_PAGE_SIZE)
    );
    const hasMoreHistory = initialMessages.length === MESSAGES_PAGE_SIZE;
    const initialReactionMessageIds = initialMessages.map((row) => row.messageId);
    const initialMessageReactions =
      initialReactionMessageIds.length > 0
        ? current === ANNOUNCEMENTS_ID
          ? await ipcClient.getAnnouncementReactions(initialReactionMessageIds)
          : await ipcClient.getMessageReactions(initialReactionMessageIds)
        : {};
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
      loadingConversationId:
        state.loadingConversationId === current ? null : state.loadingConversationId
    }));

    await ipcClient.markConversationRead(current);
    await ipcClient.setActiveConversation(current);

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

      if (event.type === 'sync:status') {
        set((state) => (state.syncActive === event.active ? state : { syncActive: event.active }));
        return;
      }

      if (event.type === 'message:received') {
        set((state) => {
          const existing = state.messagesByConversation[event.message.conversationId] || [];
          if (existing.some((row) => row.messageId === event.message.messageId)) {
            return state;
          }

          const nextUnread = { ...state.unreadByConversation };
          if (state.selectedConversationId !== event.message.conversationId) {
            nextUnread[event.message.conversationId] =
              (nextUnread[event.message.conversationId] || 0) + 1;
          }

          const recent = pruneRecent(state.recentMessageIds);
          recent[event.message.messageId] = Date.now();

          return {
            messagesByConversation: {
              ...state.messagesByConversation,
              [event.message.conversationId]: normalizeMessageOrder([...existing, event.message])
            },
            conversationPreviewById: {
              ...state.conversationPreviewById,
              [event.message.conversationId]: previewFromMessage(event.message)
            },
            unreadByConversation: nextUnread,
            typingByConversation: {
              ...state.typingByConversation,
              [event.message.conversationId]: false
            },
            recentMessageIds: recent
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
        return;
      }

      if (event.type === 'message:updated') {
        set((state) => {
          const conversationId = event.message.conversationId;
          const rows = state.messagesByConversation[conversationId] || [];
          if (event.message.deletedAt) {
            const nextRows = rows.filter((row) => row.messageId !== event.message.messageId);
            const last = nextRows[nextRows.length - 1];
            return {
              messagesByConversation: {
                ...state.messagesByConversation,
                [conversationId]: nextRows
              },
              conversationPreviewById: {
                ...state.conversationPreviewById,
                [conversationId]: last ? previewFromMessage(last) : ''
              }
            };
          }

          const nextRows = updateExistingMessageOnly(rows, event.message);
          const exists = nextRows !== rows;
          if (!exists) {
            return state;
          }

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
          announcementReactionsByMessage: (() => {
            const next = { ...state.announcementReactionsByMessage };
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

      if (event.type === 'conversation:cleared') {
        set((state) => ({
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
          unreadByConversation: {
            ...state.unreadByConversation,
            [event.conversationId]: 0
          }
        }));
        return;
      }

      if (event.type === 'transfer:progress') {
        set((state) => ({
          transfers: {
            ...state.transfers,
            [event.fileId]: event
          }
        }));
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
  },
  selectConversation: async (conversationId) => {
    set((state) => ({
      selectedConversationId: conversationId,
      loadingConversationId: conversationId,
      unreadByConversation: {
        ...state.unreadByConversation,
        [conversationId]: 0
      }
    }));
    try {
      const rows = normalizeMessageOrder(
        await ipcClient.getMessages(conversationId, MESSAGES_PAGE_SIZE)
      );
      const hasMoreHistory = rows.length === MESSAGES_PAGE_SIZE;
      const reactionMessageIds = rows.map((row) => row.messageId);
      const messageReactions =
        reactionMessageIds.length > 0
          ? conversationId === ANNOUNCEMENTS_ID
            ? await ipcClient.getAnnouncementReactions(reactionMessageIds)
            : await ipcClient.getMessageReactions(reactionMessageIds)
          : {};
      await ipcClient.markConversationRead(conversationId);
      await ipcClient.setActiveConversation(conversationId);

      set((state) => ({
        messagesByConversation: {
          ...state.messagesByConversation,
          [conversationId]: rows
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
          [conversationId]: rows.length > 0 ? previewFromMessage(rows[rows.length - 1]) : ''
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
        loadingConversationId:
          state.loadingConversationId === conversationId ? null : state.loadingConversationId
      }));
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
      const reactionTargetIds = olderRows.map((row) => row.messageId);
      const reactionMap =
        reactionTargetIds.length > 0
          ? conversationId === ANNOUNCEMENTS_ID
            ? await ipcClient.getAnnouncementReactions(reactionTargetIds)
            : await ipcClient.getMessageReactions(reactionTargetIds)
          : {};

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
        }
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
    const reactionIds = incomingRows.map((row) => row.messageId);
    const reactionMap =
      reactionIds.length > 0
        ? conversationId === ANNOUNCEMENTS_ID
          ? await ipcClient.getAnnouncementReactions(reactionIds)
          : await ipcClient.getMessageReactions(reactionIds)
        : {};

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
        }
      };
    });
  },
  sendText: async (peerId, text) => {
    const conversationId = `dm:${peerId}`;
    try {
      const message = await ipcClient.sendText(peerId, text);
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
          : 'Contato offline. Não foi possível enviar a mensagem.';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const failedMessage: MessageRow = {
        messageId: `local-failed:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
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
        status: 'failed',
        reaction: null,
        deletedAt: null,
        createdAt: Date.now(),
        localOnly: true
      };

      set((state) => ({
        messagesByConversation: {
          ...state.messagesByConversation,
          [conversationId]: appendUniqueMessage(
            state.messagesByConversation[conversationId] || [],
            failedMessage
          )
        },
        conversationPreviewById: {
          ...state.conversationPreviewById,
          [conversationId]: previewFromMessage(failedMessage)
        },
        toasts: [...state.toasts, { id, level: 'error', message: toastMessage }]
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
  sendAnnouncement: async (text) => {
    try {
      const message = await ipcClient.sendAnnouncement(text);
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
        .then((reactionMap) => {
          set((state) => ({
            announcementReactionsByMessage: {
              ...state.announcementReactionsByMessage,
              ...reactionMap
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
  sendFile: async (peerId, filePath) => {
    const conversationId = `dm:${peerId}`;
    const fileName = filePath.split(/[\\/]/).pop() || 'Arquivo';
    try {
      const message = await ipcClient.sendFile(peerId, filePath);
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
          : 'Contato offline. Não foi possível enviar o anexo.';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const failedMessage: MessageRow = {
        messageId: `local-failed-file:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        conversationId,
        direction: 'out',
        senderDeviceId: get().profile?.deviceId || 'local',
        receiverDeviceId: peerId,
        type: 'file',
        bodyText: null,
        fileId: null,
        fileName,
        fileSize: null,
        fileSha256: null,
        filePath: null,
        status: 'failed',
        reaction: null,
        deletedAt: null,
        createdAt: Date.now(),
        localOnly: true
      };
      set((state) => ({
        messagesByConversation: {
          ...state.messagesByConversation,
          [conversationId]: appendUniqueMessage(
            state.messagesByConversation[conversationId] || [],
            failedMessage
          )
        },
        conversationPreviewById: {
          ...state.conversationPreviewById,
          [conversationId]: previewFromMessage(failedMessage)
        },
        toasts: [...state.toasts, { id, level: 'error', message: toastMessage }]
      }));
      window.setTimeout(() => get().dismissToast(id), 4200);
    }
  },
  reactToMessage: async (conversationId, messageId, reaction) => {
    await ipcClient.reactToMessage(conversationId, messageId, reaction);
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
      announcementReactionsByMessage: (() => {
        if (conversationId !== ANNOUNCEMENTS_ID) {
          return state.announcementReactionsByMessage;
        }
        const next = { ...state.announcementReactionsByMessage };
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
  clearConversation: async (conversationId) => {
    await ipcClient.clearConversation(conversationId);
    set((state) => ({
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
      conversationPreviewById: {
        ...state.conversationPreviewById,
        [conversationId]: ''
      },
      unreadByConversation: {
        ...state.unreadByConversation,
        [conversationId]: 0
      }
    }));
  },
  forgetContactConversation: async (conversationId) => {
    const wasSelected = get().selectedConversationId === conversationId;
    const peerId = conversationId.startsWith('dm:') ? conversationId.slice(3) : null;

    await ipcClient.forgetContactConversation(conversationId);

    set((state) => {
      const nextMessages = { ...state.messagesByConversation };
      delete nextMessages[conversationId];

      const nextHasMore = { ...state.hasMoreHistoryByConversation };
      delete nextHasMore[conversationId];

      const nextLoadingOlder = { ...state.loadingOlderByConversation };
      delete nextLoadingOlder[conversationId];

      const nextPreview = { ...state.conversationPreviewById };
      delete nextPreview[conversationId];

      const nextUnread = { ...state.unreadByConversation };
      delete nextUnread[conversationId];

      const nextTyping = { ...state.typingByConversation };
      delete nextTyping[conversationId];

      return {
        peers: peerId ? state.peers.filter((peer) => peer.deviceId !== peerId) : state.peers,
        onlinePeerIds: peerId
          ? state.onlinePeerIds.filter((id) => id !== peerId)
          : state.onlinePeerIds,
        selectedConversationId: wasSelected ? ANNOUNCEMENTS_ID : state.selectedConversationId,
        messagesByConversation: nextMessages,
        hasMoreHistoryByConversation: nextHasMore,
        loadingOlderByConversation: nextLoadingOlder,
        conversationPreviewById: nextPreview,
        unreadByConversation: nextUnread,
        typingByConversation: nextTyping
      };
    });

    if (wasSelected) {
      await get().selectConversation(ANNOUNCEMENTS_ID);
    }
  },
  updateProfile: async (input) => {
    const profile = await ipcClient.updateProfile(input);
    if (typeof window !== 'undefined') {
      const onboardingKey = `${PROFILE_ONBOARDING_KEY_PREFIX}.${profile.deviceId}`;
      window.localStorage.setItem(onboardingKey, '1');
    }
    set({ profile });
  },
  updateRelaySettings: async (input) => {
    const relaySettings = await ipcClient.updateRelaySettings(input);
    set({ relaySettings });
  },
  updateStartupSettings: async (input) => {
    const startupSettings = await ipcClient.updateStartupSettings(input);
    set({ startupSettings });
  },
  addManualPeer: async (address, port) => {
    await ipcClient.addManualPeer(address, port);
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
