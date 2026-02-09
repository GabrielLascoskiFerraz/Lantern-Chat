export interface Profile {
  deviceId: string;
  displayName: string;
  avatarEmoji: string;
  avatarBg: string;
  statusMessage: string;
  createdAt: number;
  updatedAt: number;
}

export interface Peer {
  deviceId: string;
  displayName: string;
  avatarEmoji: string;
  avatarBg: string;
  statusMessage: string;
  address: string;
  port: number;
  appVersion: string;
  lastSeenAt: number;
  source: 'relay' | 'mdns' | 'udp' | 'manual' | 'cache';
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
  status: 'sent' | 'delivered' | 'failed' | null;
  reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null;
  deletedAt: number | null;
  createdAt: number;
  localOnly?: boolean;
}

export interface AnnouncementReactionSummary {
  counts: Partial<Record<'👍' | '👎' | '❤️' | '😢' | '😊' | '😂', number>>;
  myReaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null;
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
}

export type AppEvent =
  | { type: 'peers:updated'; peers: Peer[] }
  | { type: 'relay:connection'; connected: boolean; endpoint: string | null }
  | { type: 'sync:status'; active: boolean }
  | { type: 'message:received'; message: MessageRow }
  | { type: 'message:updated'; message: MessageRow }
  | { type: 'message:removed'; conversationId: string; messageId: string }
  | { type: 'conversation:cleared'; conversationId: string }
  | {
      type: 'message:status';
      messageId: string;
      conversationId: string | null;
      status: 'delivered' | 'failed';
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
    }
  | { type: 'navigate'; conversationId: string }
  | { type: 'message:reactions'; messageId: string; summary: AnnouncementReactionSummary }
  | { type: 'announcement:reactions'; messageId: string; summary: AnnouncementReactionSummary };

interface LanternApi {
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
  getProfile: () => Promise<Profile>;
  updateProfile: (input: { displayName: string; avatarEmoji: string; avatarBg: string; statusMessage: string }) => Promise<Profile>;
  getKnownPeers: () => Promise<Peer[]>;
  getOnlinePeers: () => Promise<Peer[]>;
  getRelaySettings: () => Promise<RelaySettings>;
  getStartupSettings: () => Promise<StartupSettings>;
  updateRelaySettings: (input: {
    automatic: boolean;
    host?: string;
    port?: number;
  }) => Promise<RelaySettings>;
  updateStartupSettings: (input: { openAtLogin: boolean; downloadsDir?: string }) => Promise<StartupSettings>;
  sendText: (peerId: string, text: string) => Promise<MessageRow>;
  sendTyping: (peerId: string, isTyping: boolean) => Promise<void>;
  sendAnnouncement: (text: string) => Promise<MessageRow>;
  sendFile: (peerId: string, filePath: string) => Promise<MessageRow>;
  reactToMessage: (
    conversationId: string,
    messageId: string,
    reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null
  ) => Promise<MessageRow | null>;
  deleteMessageForEveryone: (conversationId: string, messageId: string) => Promise<MessageRow | null>;
  getMessages: (conversationId: string, limit: number, before?: number) => Promise<MessageRow[]>;
  getMessagesByIds: (messageIds: string[]) => Promise<MessageRow[]>;
  searchConversationMessageIds: (
    conversationId: string,
    query: string,
    limit?: number,
    offset?: number
  ) => Promise<string[]>;
  getConversationPreviews: (conversationIds: string[]) => Promise<Record<string, string>>;
  getMessageReactions: (messageIds: string[]) => Promise<Record<string, AnnouncementReactionSummary>>;
  getAnnouncementReactions: (messageIds: string[]) => Promise<Record<string, AnnouncementReactionSummary>>;
  setActiveConversation: (conversationId: string) => Promise<void>;
  markConversationRead: (conversationId: string) => Promise<void>;
  clearConversation: (conversationId: string) => Promise<void>;
  forgetContactConversation: (conversationId: string) => Promise<void>;
  getConversations: () => Promise<Record<string, number>>;
  addManualPeer: (address: string, port: number) => Promise<void>;
  pickFile: () => Promise<string | null>;
  pickFiles: () => Promise<string[]>;
  pickDirectory: (defaultPath?: string) => Promise<string | null>;
  openFile: (filePath: string) => Promise<void>;
  saveFileAs: (filePath: string, fileName?: string) => Promise<void>;
  openExternalUrl: (url: string) => Promise<void>;
  getFilePreview: (filePath: string) => Promise<string | null>;
  getFileInfo: (filePath: string) => Promise<{
    name: string;
    size: number;
    ext: string;
    isImage: boolean;
  } | null>;
  saveClipboardImage: (dataUrl: string, extension?: string) => Promise<string | null>;
  onEvent: (callback: (event: AppEvent) => void) => () => void;
}

declare global {
  interface Window {
    lantern: LanternApi;
  }
}

export const ipcClient = {
  getPlatform: () => window.lantern.getPlatform(),
  getProfile: () => window.lantern.getProfile(),
  updateProfile: (input: { displayName: string; avatarEmoji: string; avatarBg: string; statusMessage: string }) =>
    window.lantern.updateProfile(input),
  getKnownPeers: () => window.lantern.getKnownPeers(),
  getOnlinePeers: () => window.lantern.getOnlinePeers(),
  getRelaySettings: () => window.lantern.getRelaySettings(),
  getStartupSettings: () => window.lantern.getStartupSettings(),
  updateRelaySettings: (input: { automatic: boolean; host?: string; port?: number }) =>
    window.lantern.updateRelaySettings(input),
  updateStartupSettings: (input: { openAtLogin: boolean; downloadsDir?: string }) =>
    window.lantern.updateStartupSettings(input),
  sendText: (peerId: string, text: string) => window.lantern.sendText(peerId, text),
  sendTyping: (peerId: string, isTyping: boolean) => window.lantern.sendTyping(peerId, isTyping),
  sendAnnouncement: (text: string) => window.lantern.sendAnnouncement(text),
  sendFile: (peerId: string, filePath: string) => window.lantern.sendFile(peerId, filePath),
  reactToMessage: (
    conversationId: string,
    messageId: string,
    reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null
  ) => window.lantern.reactToMessage(conversationId, messageId, reaction),
  deleteMessageForEveryone: (conversationId: string, messageId: string) =>
    window.lantern.deleteMessageForEveryone(conversationId, messageId),
  getMessages: (conversationId: string, limit: number, before?: number) =>
    window.lantern.getMessages(conversationId, limit, before),
  getMessagesByIds: (messageIds: string[]) => window.lantern.getMessagesByIds(messageIds),
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
  setActiveConversation: (conversationId: string) => window.lantern.setActiveConversation(conversationId),
  markConversationRead: (conversationId: string) => window.lantern.markConversationRead(conversationId),
  clearConversation: (conversationId: string) => window.lantern.clearConversation(conversationId),
  forgetContactConversation: (conversationId: string) =>
    window.lantern.forgetContactConversation(conversationId),
  getConversations: () => window.lantern.getConversations(),
  addManualPeer: (address: string, port: number) => window.lantern.addManualPeer(address, port),
  pickFile: () => window.lantern.pickFile(),
  pickFiles: () => window.lantern.pickFiles(),
  pickDirectory: (defaultPath?: string) => window.lantern.pickDirectory(defaultPath),
  openFile: (filePath: string) => window.lantern.openFile(filePath),
  saveFileAs: (filePath: string, fileName?: string) => window.lantern.saveFileAs(filePath, fileName),
  openExternalUrl: (url: string) => window.lantern.openExternalUrl(url),
  getFilePreview: (filePath: string) => window.lantern.getFilePreview(filePath),
  getFileInfo: (filePath: string) => window.lantern.getFileInfo(filePath),
  saveClipboardImage: (dataUrl: string, extension?: string) =>
    window.lantern.saveClipboardImage(dataUrl, extension),
  onEvent: (callback: (event: AppEvent) => void) => window.lantern.onEvent(callback)
};
