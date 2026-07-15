export interface Profile {
  deviceId: string;
  displayName: string;
  avatarEmoji: string;
  avatarBg: string;
  statusMessage: string;
  username?: string;
  department?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Peer {
  deviceId: string;
  displayName: string;
  avatarEmoji: string;
  avatarBg: string;
  statusMessage: string;
  username?: string;
  department?: string;
  address: string;
  port: number;
  appVersion: string;
  lastSeenAt: number;
  source: 'relay' | 'mdns' | 'udp' | 'manual' | 'cache';
}

export type ClientLocale = 'pt-BR' | 'en' | 'es';
export type RelayConnectionMode = 'local-auto' | 'local-manual' | 'external-manual';
export interface ClientRelayConfig {
  mode: RelayConnectionMode;
  host: string;
  port: number;
  secure: boolean;
}
export interface AuthenticatedUser {
  userId: string;
  username: string;
  displayName: string;
  department: string;
  avatarEmoji: string;
  avatarBg: string;
  statusMessage: string;
  locale: ClientLocale;
  role: 'admin' | 'user';
  profileSetupCompleted: boolean;
}
export interface UserPreferencesSnapshot {
  conversations: Array<{ conversationId: string; pinned: boolean; archived: boolean; manualUnread: boolean; readAt: number; updatedAt: number }>;
  messages: Array<{ messageId: string; favorite: boolean; hidden: boolean; updatedAt: number }>;
}
export interface ClientAuthState {
  authenticated: boolean;
  relay: ClientRelayConfig;
  endpoint: string | null;
  user: AuthenticatedUser | null;
}

export interface GroupInfo {
  groupId: string;
  name: string;
  emoji: string;
  avatarBg: string;
  description: string;
  createdByDeviceId: string;
  createdAt: number;
  updatedAt: number;
  lastEventSeq: number;
  deletedAt: number | null;
  missingOnRelay?: boolean;
  settings: {
    allowMembersToPin: boolean;
    allowMembersToEditInfo: boolean;
  };
}

export interface StickerCatalogItem {
  id: string;
  label: string;
  fileName: string;
  relativePath: string;
  url: string;
  previewDataUrl: string | null;
  size: number;
  category: string;
  updatedAt: number;
}

export interface GroupMember {
  groupId: string;
  deviceId: string;
  role: 'owner' | 'admin' | 'member';
  status: 'active' | 'left' | 'removed';
  displayNameSnapshot: string | null;
  avatarEmojiSnapshot: string | null;
  avatarBgSnapshot: string | null;
  joinedAt: number;
  updatedAt: number;
}

export interface MessageRow {
  messageId: string;
  conversationId: string;
  direction: 'in' | 'out';
  senderDeviceId: string;
  receiverDeviceId: string | null;
  type: 'text' | 'file' | 'announcement';
  bodyText: string | null;
  fileId: string | null;
  fileName: string | null;
  fileSize: number | null;
  fileSha256: string | null;
  filePath: string | null;
  status: 'sent' | 'delivered' | 'read' | 'failed' | null;
  reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null;
  deletedAt: number | null;
  replyToMessageId: string | null;
  replyToSenderDeviceId: string | null;
  replyToType: 'text' | 'announcement' | 'file' | null;
  replyToPreviewText: string | null;
  replyToFileName: string | null;
  forwardedFromMessageId?: string | null;
  editedAt?: number | null;
  createdAt: number;
  localOnly?: boolean;
}

export type ConversationMediaKind = 'media' | 'document';

export interface ConversationMediaCursor {
  createdAt: number;
  messageId: string;
}

export interface ConversationMediaItem {
  messageId: string;
  fileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  senderUserId: string;
  createdAt: number;
  kind: ConversationMediaKind;
}

export interface ConversationMediaPage {
  items: ConversationMediaItem[];
  nextCursor: ConversationMediaCursor | null;
  hasMore: boolean;
}

export interface DocumentPreviewResult {
  kind: 'pdf' | 'text' | 'unsupported';
  mimeType: string;
  url: string | null;
  text: string | null;
  truncated: boolean;
  reason?: string | null;
}

export interface MessageReplyReference {
  messageId: string;
  senderDeviceId: string;
  type: 'text' | 'announcement' | 'file';
  previewText: string | null;
  fileName: string | null;
}

export interface AnnouncementReactionSummary {
  counts: Partial<Record<'👍' | '👎' | '❤️' | '😢' | '😊' | '😂', number>>;
  myReaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null;
}

export interface MessageReactionDetail {
  deviceId: string;
  displayName: string;
  avatarEmoji: string;
  avatarBg: string;
  reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂';
  updatedAt: number;
}

export interface AnnouncementReadSummary {
  count: number;
  readByMe: boolean;
}

export interface AnnouncementReadDetail {
  deviceId: string;
  displayName: string;
  avatarEmoji: string;
  avatarBg: string;
  readAt: number;
}

export interface RelaySettings {
  automatic: boolean;
  host: string;
  port: number;
  connected: boolean;
  endpoint: string | null;
}

export interface StartupSettings {
  supported: boolean;
  openAtLogin: boolean;
  downloadsDir: string;
  doNotDisturbUntil: number;
}

export type AppEvent =
  | { type: 'auth:changed'; state: ClientAuthState }
  | { type: 'peers:updated'; peers: Peer[] }
  | { type: 'groups:updated'; groups: GroupInfo[] }
  | { type: 'group:members'; groupId: string; members: GroupMember[] }
  | { type: 'group:pins'; groupId: string; messageIds: string[] }
  | { type: 'relay:connection'; connected: boolean; endpoint: string | null }
  | { type: 'sync:status'; active: boolean }
  | { type: 'message:received'; message: MessageRow }
  | { type: 'message:updated'; message: MessageRow }
  | { type: 'message:removed'; conversationId: string; messageId: string }
  | { type: 'message:favorite'; conversationId: string; messageId: string; favorite: boolean }
  | { type: 'conversation:cleared'; conversationId: string }
  | { type: 'conversation:unread'; conversationId: string; unreadCount: number }
  | {
      type: 'message:status';
      messageId: string;
      conversationId: string | null;
      status: 'delivered' | 'read' | 'failed';
    }
  | { type: 'typing:update'; conversationId: string; peerId: string; isTyping: boolean }
  | { type: 'ui:toast'; level: 'info' | 'success' | 'warning' | 'error'; message: string }
  | {
      type: 'transfer:progress';
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
  | { type: 'navigate'; conversationId: string }
  | { type: 'message:reactions'; messageId: string; summary: AnnouncementReactionSummary }
  | { type: 'announcement:reactions'; messageId: string; summary: AnnouncementReactionSummary }
  | { type: 'announcement:reads'; messageId: string; summary: AnnouncementReadSummary };

export interface LanternApi {
  getPlatform: () =>
    | 'aix'
    | 'android'
    | 'darwin'
    | 'freebsd'
    | 'haiku'
    | 'linux'
    | 'openbsd'
    | 'sunos'
    | 'win32'
    | 'cygwin'
    | 'netbsd';
  getAuthState: () => Promise<ClientAuthState>;
  discoverRelays: (port?: number) => Promise<Array<{ host: string; port: number; secure: boolean }>>;
  login: (input: { relay: ClientRelayConfig; username: string; password: string; rememberMe?: boolean }) => Promise<ClientAuthState>;
  requestPasswordReset: (input: { relay: ClientRelayConfig; username: string }) => Promise<{ requestToken: string }>;
  getPasswordResetStatus: (requestToken: string) => Promise<'pending' | 'approved' | 'rejected' | 'consumed' | 'expired' | 'invalid'>;
  completePasswordReset: (input: { username: string; requestToken: string; newPassword: string }) => Promise<void>;
  changePassword: (input: { currentPassword: string; newPassword: string }) => Promise<void>;
  register: (input: { relay: ClientRelayConfig; username: string; displayName: string; password: string; locale: ClientLocale }) => Promise<ClientAuthState>;
  completeFirstLoginSetup: (input: { avatarEmoji: string; avatarBg: string; openAtLogin: boolean }) => Promise<ClientAuthState>;
  logout: () => Promise<void>;
  getProfile: () => Promise<Profile>;
  updateProfile: (input: { displayName: string; avatarEmoji: string; avatarBg: string; statusMessage: string }) => Promise<Profile>;
  getKnownPeers: () => Promise<Peer[]>;
  getOnlinePeers: () => Promise<Peer[]>;
  getGroups: () => Promise<GroupInfo[]>;
  getGroupMembers: (groupId: string) => Promise<GroupMember[]>;
  getGroupPinnedMessageIds: (groupId: string) => Promise<string[]>;
  createGroup: (input: {
    name: string;
    emoji: string;
    avatarBg: string;
    description: string;
    memberDeviceIds: string[];
  }) => Promise<GroupInfo>;
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
  getRelaySettings: () => Promise<RelaySettings>;
  getStartupSettings: () => Promise<StartupSettings>;
  updateRelaySettings: (input: {
    automatic: boolean;
    host?: string;
    port?: number;
  }) => Promise<RelaySettings>;
  forceRelayRediscovery: () => Promise<RelaySettings>;
  updateStartupSettings: (input: { openAtLogin: boolean; downloadsDir?: string; doNotDisturbUntil?: number }) => Promise<StartupSettings>;
  sendText: (
    peerId: string,
    text: string,
    replyTo?: MessageReplyReference | null
  ) => Promise<MessageRow>;
  sendGroupText: (
    groupId: string,
    text: string,
    replyTo?: MessageReplyReference | null
  ) => Promise<MessageRow>;
  sendTyping: (peerId: string, isTyping: boolean) => Promise<void>;
  sendAnnouncement: (text: string, replyTo?: MessageReplyReference | null) => Promise<MessageRow>;
  sendAnnouncementFile: (
    filePath: string,
    replyTo?: MessageReplyReference | null
  ) => Promise<MessageRow>;
  sendFile: (
    peerId: string,
    filePath: string,
    replyTo?: MessageReplyReference | null
  ) => Promise<MessageRow>;
  sendGroupFile: (
    groupId: string,
    filePath: string,
    replyTo?: MessageReplyReference | null
  ) => Promise<MessageRow>;
  forwardMessageToPeer: (targetPeerId: string, sourceMessageId: string) => Promise<MessageRow>;
  editMessage: (conversationId: string, messageId: string, text: string) => Promise<MessageRow | null>;
  reactToMessage: (
    conversationId: string,
    messageId: string,
    reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null
  ) => Promise<MessageRow | null>;
  deleteMessageForEveryone: (conversationId: string, messageId: string) => Promise<MessageRow | null>;
  deleteMessageForMe: (conversationId: string, messageId: string) => Promise<MessageRow | null>;
  toggleMessageFavorite: (
    conversationId: string,
    messageId: string,
    favorite: boolean
  ) => Promise<boolean>;
  getMessageFavorites: (messageIds: string[]) => Promise<Record<string, boolean>>;
  getFavoriteMessages: (conversationId: string) => Promise<MessageRow[]>;
  resyncConversation: (conversationId: string) => Promise<void>;
  getMessages: (conversationId: string, limit: number, before?: number) => Promise<MessageRow[]>;
  getMessagesByIds: (messageIds: string[]) => Promise<MessageRow[]>;
  listConversationMedia: (
    conversationId: string,
    kind: ConversationMediaKind,
    cursor?: ConversationMediaCursor | null,
    limit?: number
  ) => Promise<ConversationMediaPage>;
  searchConversationMessageIds: (
    conversationId: string,
    query: string,
    limit?: number,
    offset?: number
  ) => Promise<string[]>;
  getConversationPreviews: (conversationIds: string[]) => Promise<Record<string, string>>;
  getMessageReactions: (messageIds: string[]) => Promise<Record<string, AnnouncementReactionSummary>>;
  getAnnouncementReactions: (messageIds: string[]) => Promise<Record<string, AnnouncementReactionSummary>>;
  getAnnouncementReactionDetails: (messageId: string) => Promise<MessageReactionDetail[]>;
  getMessageReactionDetails: (messageId: string) => Promise<MessageReactionDetail[]>;
  getAnnouncementReadSummary: (messageIds: string[]) => Promise<Record<string, AnnouncementReadSummary>>;
  getAnnouncementReadDetails: (messageId: string) => Promise<AnnouncementReadDetail[]>;
  exportConversation: (conversationId: string, format: 'txt' | 'html') => Promise<{ canceled: boolean; filePath: string | null }>;
  setActiveConversation: (conversationId: string) => Promise<void>;
  markConversationRead: (conversationId: string) => Promise<void>;
  markConversationUnread: (conversationId: string) => Promise<void>;
  archiveConversation: (conversationId: string) => Promise<number>;
  unarchiveConversation: (conversationId: string) => Promise<number>;
  clearConversation: (conversationId: string) => Promise<void>;
  getConversations: () => Promise<Record<string, number>>;
  getArchivedConversationIds: () => Promise<string[]>;
  getPinnedConversationIds: () => Promise<string[]>;
  setConversationPinned: (conversationId: string, pinned: boolean) => Promise<void>;
  pickFile: () => Promise<string | null>;
  pickFiles: () => Promise<string[]>;
  pickDirectory: (defaultPath?: string) => Promise<string | null>;
  openFile: (filePath: string) => Promise<void>;
  saveFileAs: (filePath: string, fileName?: string) => Promise<void>;
  openExternalUrl: (url: string) => Promise<void>;
  nativePaste: () => Promise<boolean>;
  getFilePreview: (filePath: string) => Promise<string | null>;
  getDocumentPreview: (filePath: string, fileName?: string | null) => Promise<DocumentPreviewResult>;
  getFileInfo: (filePath: string) => Promise<{
    name: string;
    size: number;
    ext: string;
    isImage: boolean;
  } | null>;
  getClipboardFilePaths: () => Promise<string[]>;
  clipboardHasFileLikeData: () => Promise<boolean>;
  saveClipboardImage: (dataUrl: string, extension?: string) => Promise<string | null>;
  saveClipboardFileData: (dataUrl: string, fileName?: string) => Promise<string | null>;
  getRelayStickers: () => Promise<StickerCatalogItem[]>;
  prepareRelayStickerFile: (relativePath: string) => Promise<string | null>;
  onEvent: (callback: (event: AppEvent) => void) => () => void;
}

declare global {
  interface Window {
    lantern: LanternApi;
  }
}

export const ipcClient = {
  getPlatform: () => window.lantern.getPlatform(),
  getAuthState: () => window.lantern.getAuthState(),
  discoverRelays: (port?: number) => window.lantern.discoverRelays(port),
  login: (input: { relay: ClientRelayConfig; username: string; password: string; rememberMe?: boolean }) =>
    window.lantern.login(input),
  requestPasswordReset: (input: { relay: ClientRelayConfig; username: string }) => window.lantern.requestPasswordReset(input),
  getPasswordResetStatus: (requestToken: string) => window.lantern.getPasswordResetStatus(requestToken),
  completePasswordReset: (input: { username: string; requestToken: string; newPassword: string }) => window.lantern.completePasswordReset(input),
  changePassword: (input: { currentPassword: string; newPassword: string }) => window.lantern.changePassword(input),
  register: (input: { relay: ClientRelayConfig; username: string; displayName: string; password: string; locale: ClientLocale }) =>
    window.lantern.register(input),
  completeFirstLoginSetup: (input: { avatarEmoji: string; avatarBg: string; openAtLogin: boolean }) =>
    window.lantern.completeFirstLoginSetup(input),
  logout: () => window.lantern.logout(),
  getProfile: () => window.lantern.getProfile(),
  updateProfile: (input: { displayName: string; avatarEmoji: string; avatarBg: string; statusMessage: string }) =>
    window.lantern.updateProfile(input),
  getKnownPeers: () => window.lantern.getKnownPeers(),
  getOnlinePeers: () => window.lantern.getOnlinePeers(),
  getGroups: () => window.lantern.getGroups(),
  getGroupMembers: (groupId: string) => window.lantern.getGroupMembers(groupId),
  getGroupPinnedMessageIds: (groupId: string) => window.lantern.getGroupPinnedMessageIds(groupId),
  createGroup: (input: {
    name: string;
    emoji: string;
    avatarBg: string;
    description: string;
    memberDeviceIds: string[];
  }) => window.lantern.createGroup(input),
  updateGroup: (
    groupId: string,
    input: {
      name?: string;
      emoji?: string;
      avatarBg?: string;
      description?: string;
      settings?: Record<string, boolean>;
    }
  ) => window.lantern.updateGroup(groupId, input),
  addGroupMembers: (groupId: string, memberDeviceIds: string[]) =>
    window.lantern.addGroupMembers(groupId, memberDeviceIds),
  removeGroupMember: (groupId: string, deviceId: string) =>
    window.lantern.removeGroupMember(groupId, deviceId),
  setGroupMemberRole: (groupId: string, deviceId: string, role: 'admin' | 'member') =>
    window.lantern.setGroupMemberRole(groupId, deviceId, role),
  transferGroupOwnership: (groupId: string, deviceId: string) =>
    window.lantern.transferGroupOwnership(groupId, deviceId),
  deleteGroup: (groupId: string) => window.lantern.deleteGroup(groupId),
  leaveGroup: (groupId: string) => window.lantern.leaveGroup(groupId),
  setGroupMessagePinned: (groupId: string, messageId: string, pinned: boolean) =>
    window.lantern.setGroupMessagePinned(groupId, messageId, pinned),
  getRelaySettings: () => window.lantern.getRelaySettings(),
  getStartupSettings: () => window.lantern.getStartupSettings(),
  updateRelaySettings: (input: { automatic: boolean; host?: string; port?: number }) =>
    window.lantern.updateRelaySettings(input),
  forceRelayRediscovery: () => window.lantern.forceRelayRediscovery(),
  updateStartupSettings: (input: { openAtLogin: boolean; downloadsDir?: string; doNotDisturbUntil?: number }) =>
    window.lantern.updateStartupSettings(input),
  sendText: (peerId: string, text: string, replyTo?: MessageReplyReference | null) =>
    window.lantern.sendText(peerId, text, replyTo),
  sendGroupText: (groupId: string, text: string, replyTo?: MessageReplyReference | null) =>
    window.lantern.sendGroupText(groupId, text, replyTo),
  sendTyping: (peerId: string, isTyping: boolean) => window.lantern.sendTyping(peerId, isTyping),
  sendAnnouncement: (text: string, replyTo?: MessageReplyReference | null) =>
    window.lantern.sendAnnouncement(text, replyTo),
  sendAnnouncementFile: (filePath: string, replyTo?: MessageReplyReference | null) =>
    window.lantern.sendAnnouncementFile(filePath, replyTo),
  sendFile: (peerId: string, filePath: string, replyTo?: MessageReplyReference | null) =>
    window.lantern.sendFile(peerId, filePath, replyTo),
  sendGroupFile: (groupId: string, filePath: string, replyTo?: MessageReplyReference | null) =>
    window.lantern.sendGroupFile(groupId, filePath, replyTo),
  forwardMessageToPeer: (targetPeerId: string, sourceMessageId: string) =>
    window.lantern.forwardMessageToPeer(targetPeerId, sourceMessageId),
  editMessage: (conversationId: string, messageId: string, text: string) =>
    window.lantern.editMessage(conversationId, messageId, text),
  reactToMessage: (
    conversationId: string,
    messageId: string,
    reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null
  ) => window.lantern.reactToMessage(conversationId, messageId, reaction),
  deleteMessageForEveryone: (conversationId: string, messageId: string) =>
    window.lantern.deleteMessageForEveryone(conversationId, messageId),
  deleteMessageForMe: (conversationId: string, messageId: string) =>
    window.lantern.deleteMessageForMe(conversationId, messageId),
  toggleMessageFavorite: (conversationId: string, messageId: string, favorite: boolean) =>
    window.lantern.toggleMessageFavorite(conversationId, messageId, favorite),
  getMessageFavorites: (messageIds: string[]) => window.lantern.getMessageFavorites(messageIds),
  getFavoriteMessages: (conversationId: string) =>
    window.lantern.getFavoriteMessages(conversationId),
  resyncConversation: (conversationId: string) =>
    window.lantern.resyncConversation(conversationId),
  getMessages: (conversationId: string, limit: number, before?: number) =>
    window.lantern.getMessages(conversationId, limit, before),
  getMessagesByIds: (messageIds: string[]) => window.lantern.getMessagesByIds(messageIds),
  listConversationMedia: (
    conversationId: string,
    kind: ConversationMediaKind,
    cursor?: ConversationMediaCursor | null,
    limit?: number
  ) =>
    window.lantern.listConversationMedia(conversationId, kind, cursor, limit),
  searchConversationMessageIds: (
    conversationId: string,
    query: string,
    limit?: number,
    offset?: number
  ) => window.lantern.searchConversationMessageIds(conversationId, query, limit, offset),
  getConversationPreviews: (conversationIds: string[]) =>
    window.lantern.getConversationPreviews(conversationIds),
  getMessageReactions: (messageIds: string[]) =>
    window.lantern.getMessageReactions(messageIds),
  getAnnouncementReactions: (messageIds: string[]) =>
    window.lantern.getAnnouncementReactions(messageIds),
  getAnnouncementReactionDetails: (messageId: string) =>
    window.lantern.getAnnouncementReactionDetails(messageId),
  getMessageReactionDetails: (messageId: string) =>
    window.lantern.getMessageReactionDetails(messageId),
  getAnnouncementReadSummary: (messageIds: string[]) =>
    window.lantern.getAnnouncementReadSummary(messageIds),
  getAnnouncementReadDetails: (messageId: string) =>
    window.lantern.getAnnouncementReadDetails(messageId),
  exportConversation: (conversationId: string, format: 'txt' | 'html') =>
    window.lantern.exportConversation(conversationId, format),
  setActiveConversation: (conversationId: string) => window.lantern.setActiveConversation(conversationId),
  markConversationRead: (conversationId: string) => window.lantern.markConversationRead(conversationId),
  markConversationUnread: (conversationId: string) => window.lantern.markConversationUnread(conversationId),
  archiveConversation: (conversationId: string) => window.lantern.archiveConversation(conversationId),
  unarchiveConversation: (conversationId: string) => window.lantern.unarchiveConversation(conversationId),
  clearConversation: (conversationId: string) => window.lantern.clearConversation(conversationId),
  getConversations: () => window.lantern.getConversations(),
  getArchivedConversationIds: () => window.lantern.getArchivedConversationIds(),
  getPinnedConversationIds: () => window.lantern.getPinnedConversationIds(),
  setConversationPinned: (conversationId: string, pinned: boolean) =>
    window.lantern.setConversationPinned(conversationId, pinned),
  pickFile: () => window.lantern.pickFile(),
  pickFiles: () => window.lantern.pickFiles(),
  pickDirectory: (defaultPath?: string) => window.lantern.pickDirectory(defaultPath),
  openFile: (filePath: string) => window.lantern.openFile(filePath),
  saveFileAs: (filePath: string, fileName?: string) => window.lantern.saveFileAs(filePath, fileName),
  openExternalUrl: (url: string) => window.lantern.openExternalUrl(url),
  nativePaste: () => window.lantern.nativePaste(),
  getFilePreview: (filePath: string) => window.lantern.getFilePreview(filePath),
  getDocumentPreview: (filePath: string, fileName?: string | null) =>
    window.lantern.getDocumentPreview(filePath, fileName),
  getFileInfo: (filePath: string) => window.lantern.getFileInfo(filePath),
  getClipboardFilePaths: () => window.lantern.getClipboardFilePaths(),
  clipboardHasFileLikeData: () => window.lantern.clipboardHasFileLikeData(),
  saveClipboardImage: (dataUrl: string, extension?: string) =>
    window.lantern.saveClipboardImage(dataUrl, extension),
  saveClipboardFileData: (dataUrl: string, fileName?: string) =>
    window.lantern.saveClipboardFileData(dataUrl, fileName),
  getRelayStickers: () => window.lantern.getRelayStickers(),
  prepareRelayStickerFile: (relativePath: string) => window.lantern.prepareRelayStickerFile(relativePath),
  onEvent: (callback: (event: AppEvent) => void) => window.lantern.onEvent(callback)
};
