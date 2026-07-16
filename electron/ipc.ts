import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron';
import {
  AnnouncementReactionSummary,
  AnnouncementReadDetail,
  AnnouncementReadSummary,
  AppEvent,
  AppUpdateState,
  ClientAuthState,
  ClientRelayConfig,
  ConversationMediaCursor,
  ConversationMediaKind,
  ConversationMediaPage,
  DbMessage,
  GroupInfo,
  GroupMember,
  MessageReplyPayload,
  MessageReactionDetail,
  Peer,
  Profile,
  StickerCatalogItem
} from './types';
import { createDocumentPreview } from './documentPreview';

export interface IpcBindings {
  getAuthState: () => ClientAuthState;
  discoverRelays: (port?: number) => Promise<Array<{ host: string; port: number; secure: boolean }>>;
  login: (input: { relay: ClientRelayConfig; username: string; password: string; rememberMe?: boolean }) => Promise<ClientAuthState>;
  requestPasswordReset: (input: { relay: ClientRelayConfig; username: string }) => Promise<{ requestToken: string }>;
  getPasswordResetStatus: (requestToken: string) => Promise<'pending' | 'approved' | 'rejected' | 'consumed' | 'expired' | 'invalid'>;
  completePasswordReset: (input: { username: string; requestToken: string; newPassword: string }) => Promise<void>;
  changePassword: (input: { currentPassword: string; newPassword: string }) => Promise<void>;
  completeInitialPassword: (newPassword: string) => Promise<ClientAuthState>;
  register: (input: { relay: ClientRelayConfig; username: string; displayName: string; password: string; locale: 'pt-BR' | 'en' | 'es' }) => Promise<ClientAuthState>;
  completeFirstLoginSetup: (input: { avatarEmoji: string; avatarBg: string; openAtLogin: boolean }) => Promise<ClientAuthState>;
  logout: () => Promise<void>;
  getProfile: () => Profile;
  updateProfile: (input: Pick<Profile, 'displayName' | 'avatarEmoji' | 'avatarBg' | 'statusMessage'>) => Profile;
  getKnownPeers: () => Peer[];
  getOnlinePeers: () => Peer[];
  getGroups: () => GroupInfo[];
  getGroupMembers: (groupId: string) => GroupMember[];
  getGroupPinnedMessageIds: (groupId: string) => string[];
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
  getRelaySettings: () => {
    automatic: boolean;
    host: string;
    port: number;
    connected: boolean;
    endpoint: string | null;
  };
  getStartupSettings: () => {
    supported: boolean;
    openAtLogin: boolean;
    downloadsDir: string;
    doNotDisturbUntil: number;
  };
  updateRelaySettings: (input: {
    automatic: boolean;
    host?: string;
    port?: number;
  }) => {
    automatic: boolean;
    host: string;
    port: number;
    connected: boolean;
    endpoint: string | null;
  };
  forceRelayRediscovery: () => {
    automatic: boolean;
    host: string;
    port: number;
    connected: boolean;
    endpoint: string | null;
  };
  updateStartupSettings: (input: { openAtLogin: boolean; downloadsDir?: string; doNotDisturbUntil?: number }) => {
    supported: boolean;
    openAtLogin: boolean;
    downloadsDir: string;
    doNotDisturbUntil: number;
  };
  sendText: (
    peerId: string,
    text: string,
    replyTo?: MessageReplyPayload | null
  ) => Promise<DbMessage>;
  sendGroupText: (
    groupId: string,
    text: string,
    replyTo?: MessageReplyPayload | null
  ) => Promise<DbMessage>;
  sendTyping: (peerId: string, isTyping: boolean) => Promise<void>;
  sendAnnouncement: (text: string, replyTo?: MessageReplyPayload | null) => Promise<DbMessage>;
  sendAnnouncementFile: (
    filePath: string,
    replyTo?: MessageReplyPayload | null
  ) => Promise<DbMessage>;
  sendFile: (
    peerId: string,
    filePath: string,
    replyTo?: MessageReplyPayload | null
  ) => Promise<DbMessage>;
  sendGroupFile: (
    groupId: string,
    filePath: string,
    replyTo?: MessageReplyPayload | null
  ) => Promise<DbMessage>;
  forwardMessageToPeer: (targetPeerId: string, sourceMessageId: string) => Promise<DbMessage>;
  editMessage: (conversationId: string, messageId: string, text: string) => Promise<DbMessage | null>;
  reactToMessage: (
    conversationId: string,
    messageId: string,
    reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null
  ) => Promise<DbMessage | null>;
  deleteMessageForEveryone: (conversationId: string, messageId: string) => Promise<DbMessage | null>;
  deleteMessageForMe: (conversationId: string, messageId: string) => Promise<DbMessage | null>;
  toggleMessageFavorite: (
    conversationId: string,
    messageId: string,
    favorite: boolean
  ) => Promise<boolean> | boolean;
  getMessageFavorites: (messageIds: string[]) => Record<string, boolean>;
  getFavoriteMessages: (conversationId: string) => DbMessage[];
  resyncConversation: (conversationId: string) => Promise<void>;
  getMessages: (
    conversationId: string,
    limit: number,
    before?: number
  ) => Promise<DbMessage[]> | DbMessage[];
  getMessagesByIds: (messageIds: string[]) => Promise<DbMessage[]> | DbMessage[];
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
  ) => Promise<string[]> | string[];
  getConversationPreviews: (conversationIds: string[]) => Record<string, string>;
  getMessageReactions: (messageIds: string[]) => Record<string, AnnouncementReactionSummary>;
  getAnnouncementReactions: (messageIds: string[]) => Record<string, AnnouncementReactionSummary>;
  getAnnouncementReactionDetails: (messageId: string) => MessageReactionDetail[];
  getMessageReactionDetails: (messageId: string) => MessageReactionDetail[];
  getAnnouncementReadSummary: (messageIds: string[]) => Record<string, AnnouncementReadSummary>;
  getAnnouncementReadDetails: (messageId: string) => AnnouncementReadDetail[];
  getRelayStickers: () => Promise<StickerCatalogItem[]>;
  prepareRelayStickerFile: (relativePath: string) => Promise<string | null>;
  exportConversation: (conversationId: string, format: 'txt' | 'html') => Promise<{ canceled: boolean; filePath: string | null }>;
  setActiveConversation: (conversationId: string) => Promise<void> | void;
  markConversationRead: (conversationId: string) => Promise<void>;
  markConversationUnread: (conversationId: string) => Promise<void>;
  archiveConversation: (conversationId: string) => Promise<number>;
  unarchiveConversation: (conversationId: string) => Promise<number>;
  getPinnedConversationIds: () => string[];
  setConversationPinned: (conversationId: string, pinned: boolean) => Promise<void>;
  clearConversation: (conversationId: string) => void;
  getConversations: () => Record<string, number>;
  getArchivedConversationIds: () => string[];
  saveFileAs: (filePath: string, fileName?: string) => Promise<void>;
  getUpdateState: () => AppUpdateState;
  forceUpdate: () => Promise<AppUpdateState>;
  installUpdate: () => Promise<void>;
}

export const registerIpc = (
  window: BrowserWindow,
  bindings: IpcBindings
): { emitEvent: (event: AppEvent) => void } => {
  const CLIPBOARD_TEMP_DIR = path.join(os.tmpdir(), 'lantern-paste');
  const CLIPBOARD_MAX_FILE_AGE_MS = 24 * 60 * 60 * 1000;
  const CLIPBOARD_MAX_FILES = 300;

  ipcMain.handle('lantern:getAuthState', () => bindings.getAuthState());
  ipcMain.handle('lantern:discoverRelays', (_event, port?: number) => bindings.discoverRelays(port));
  ipcMain.handle('lantern:completeFirstLoginSetup', (_event, input) =>
    bindings.completeFirstLoginSetup(input)
  );
  ipcMain.handle('lantern:login', (_event, input) => bindings.login(input));
  ipcMain.handle('lantern:requestPasswordReset', (_event, input) => bindings.requestPasswordReset(input));
  ipcMain.handle('lantern:getPasswordResetStatus', (_event, requestToken) => bindings.getPasswordResetStatus(requestToken));
  ipcMain.handle('lantern:completePasswordReset', (_event, input) => bindings.completePasswordReset(input));
  ipcMain.handle('lantern:changePassword', (_event, input) => bindings.changePassword(input));
  ipcMain.handle('lantern:completeInitialPassword', (_event, newPassword) =>
    bindings.completeInitialPassword(String(newPassword || ''))
  );
  ipcMain.handle('lantern:register', (_event, input) => bindings.register(input));
  ipcMain.handle('lantern:logout', () => bindings.logout());

  const cleanupClipboardTempDir = async (): Promise<void> => {
    try {
      await fs.promises.mkdir(CLIPBOARD_TEMP_DIR, { recursive: true });
      const names = await fs.promises.readdir(CLIPBOARD_TEMP_DIR);
      const now = Date.now();
      const files: Array<{ name: string; fullPath: string; mtimeMs: number }> = [];

      for (const name of names) {
        const fullPath = path.join(CLIPBOARD_TEMP_DIR, name);
        try {
          const stat = await fs.promises.stat(fullPath);
          if (!stat.isFile()) continue;
          files.push({ name, fullPath, mtimeMs: stat.mtimeMs });
        } catch {
          // ignora arquivo removido em paralelo
        }
      }

      const stale = files.filter((file) => now - file.mtimeMs > CLIPBOARD_MAX_FILE_AGE_MS);
      for (const file of stale) {
        await fs.promises.unlink(file.fullPath).catch(() => undefined);
      }

      const fresh = files
        .filter((file) => now - file.mtimeMs <= CLIPBOARD_MAX_FILE_AGE_MS)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (fresh.length > CLIPBOARD_MAX_FILES) {
        const overflow = fresh.slice(CLIPBOARD_MAX_FILES);
        for (const file of overflow) {
          await fs.promises.unlink(file.fullPath).catch(() => undefined);
        }
      }
    } catch {
      // cleanup best effort
    }
  };

  const sanitizeClipboardText = (value: string): string =>
    (value || '').split('\0').join('\n');

  const parseFileUri = (value: string): string | null => {
    const trimmed = sanitizeClipboardText(value)
      .trim()
      .replace(/^['"<(]+/, '')
      .replace(/[>'"),;]+$/, '');
    if (!trimmed.toLowerCase().startsWith('file://')) return null;
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'file:') return null;
      let pathname = decodeURIComponent(url.pathname || '');
      if (process.platform === 'win32' && /^\/[a-zA-Z]:\//.test(pathname)) {
        pathname = pathname.slice(1);
      }
      return pathname || null;
    } catch {
      return null;
    }
  };

  const parseUriList = (value: string): string[] => {
    const sanitized = sanitizeClipboardText(value);
    const fromLines = sanitized
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => parseFileUri(line))
      .filter((line): line is string => Boolean(line));

    const fromInlineMatches =
      sanitized
        .match(/file:\/\/[^\s<>"']+/gi)
        ?.map((match) => parseFileUri(match))
        .filter((line): line is string => Boolean(line)) || [];

    return [...fromLines, ...fromInlineMatches];
  };

  const parseAbsolutePathsFromText = (value: string): string[] => {
    const paths: string[] = [];
    const sanitized = sanitizeClipboardText(value);
    const lines = sanitized
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      if (line.startsWith('/')) {
        paths.push(line);
        continue;
      }
      if (/^[a-zA-Z]:[\\/]/.test(line)) {
        paths.push(line);
      }
    }

    const quotedPathMatches =
      sanitized.match(/["']((?:\/|[a-zA-Z]:[\\/])[^"']+)["']/g)?.map((match) => {
        const value = match.slice(1, -1).trim();
        return value;
      }) || [];
    for (const match of quotedPathMatches) {
      if (match.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(match)) {
        paths.push(match);
      }
    }

    const genericPathTokens =
      sanitized.match(/(?:\/|[a-zA-Z]:[\\/])[^\s<>"'`|*?]+/g)?.map((token) => token.trim()) || [];
    for (const token of genericPathTokens) {
      if (token.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(token)) {
        paths.push(token);
      }
    }

    return paths;
  };

  const parsePathsFromXmlLikeString = (value: string): string[] => {
    const paths: string[] = [];
    const sanitized = sanitizeClipboardText(value);
    const matches = sanitized.match(/<string>([^<]+)<\/string>/g) || [];
    for (const raw of matches) {
      const inner = raw.replace(/^<string>/, '').replace(/<\/string>$/, '').trim();
      if (!inner) continue;
      const uri = parseFileUri(inner);
      if (uri) {
        paths.push(uri);
        continue;
      }
      if (inner.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(inner)) {
        paths.push(inner);
      }
    }
    return paths;
  };

  const normalizeClipboardPaths = async (candidates: string[]): Promise<string[]> => {
    const dedupe = new Set<string>();
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate);
      try {
        const stat = await fs.promises.stat(resolved);
        if (stat.isFile()) dedupe.add(resolved);
      } catch {
        // ignora caminhos inválidos do clipboard
      }
    }
    return Array.from(dedupe);
  };

  const saveClipboardBufferToTemp = async (
    buffer: Buffer,
    extension: string,
    prefix = 'clipboard'
  ): Promise<string | null> => {
    if (!buffer || buffer.length === 0) return null;
    await cleanupClipboardTempDir();
    await fs.promises.mkdir(CLIPBOARD_TEMP_DIR, { recursive: true });
    const safeExt = (extension || 'bin').replace(/[^a-zA-Z0-9]/g, '') || 'bin';
    const filePath = path.join(
      CLIPBOARD_TEMP_DIR,
      `${prefix}-${Date.now()}-${randomUUID()}.${safeExt}`
    );
    await fs.promises.writeFile(filePath, buffer);
    return filePath;
  };

  const extractClipboardPathCandidates = (): string[] => {
    const candidates: string[] = [];
    const formats = clipboard.availableFormats();

    const collectFromText = (value: string) => {
      if (!value) return;
      candidates.push(...parseUriList(value));
      candidates.push(...parseAbsolutePathsFromText(value));
      candidates.push(...parsePathsFromXmlLikeString(value));
      const fromSingle = parseFileUri(value);
      if (fromSingle) candidates.push(fromSingle);
    };

    collectFromText(clipboard.readText());

    try {
      const bookmark = clipboard.readBookmark() as unknown;
      if (typeof bookmark === 'string') {
        collectFromText(bookmark);
      } else if (
        bookmark &&
        typeof bookmark === 'object' &&
        'url' in (bookmark as Record<string, unknown>)
      ) {
        const url = (bookmark as Record<string, unknown>).url;
        if (typeof url === 'string') {
          collectFromText(url);
        }
      }
    } catch {
      // bookmark opcional
    }

    for (const format of formats) {
      const lower = format.toLowerCase();
      if (!(lower.includes('file') || lower.includes('uri'))) continue;

      try {
        const typedText = clipboard.read(format);
        collectFromText(typedText);
      } catch {
        // alguns formatos não suportam read(string)
      }

      try {
        const raw = clipboard.readBuffer(format);
        if (raw.length <= 0) continue;
        const utf8 = raw.toString('utf8');
        const utf16 = raw.toString('utf16le');
        collectFromText(utf8);
        collectFromText(utf16);

        for (const part of sanitizeClipboardText(utf8).split(/\r?\n/)) {
          const trimmed = part.trim();
          if (!trimmed) continue;
          const fromSingle = parseFileUri(trimmed);
          if (fromSingle) candidates.push(fromSingle);
        }
      } catch {
        // ignora formatos sem buffer textual
      }
    }

    return candidates;
  };

  ipcMain.handle('lantern:getProfile', () => bindings.getProfile());
  ipcMain.handle('lantern:updateProfile', (_event, input) => bindings.updateProfile(input));
  ipcMain.handle('lantern:getKnownPeers', () => bindings.getKnownPeers());
  ipcMain.handle('lantern:getOnlinePeers', () => bindings.getOnlinePeers());
  ipcMain.handle('lantern:getGroups', () => bindings.getGroups());
  ipcMain.handle('lantern:getGroupMembers', (_event, groupId: string) =>
    bindings.getGroupMembers(groupId)
  );
  ipcMain.handle('lantern:getGroupPinnedMessageIds', (_event, groupId: string) =>
    bindings.getGroupPinnedMessageIds(groupId)
  );
  ipcMain.handle('lantern:createGroup', (_event, input) => bindings.createGroup(input));
  ipcMain.handle('lantern:updateGroup', (_event, groupId: string, input) =>
    bindings.updateGroup(groupId, input)
  );
  ipcMain.handle('lantern:addGroupMembers', (_event, groupId: string, memberDeviceIds: string[]) =>
    bindings.addGroupMembers(groupId, memberDeviceIds)
  );
  ipcMain.handle('lantern:removeGroupMember', (_event, groupId: string, deviceId: string) =>
    bindings.removeGroupMember(groupId, deviceId)
  );
  ipcMain.handle(
    'lantern:setGroupMemberRole',
    (_event, groupId: string, deviceId: string, role: 'admin' | 'member') =>
      bindings.setGroupMemberRole(groupId, deviceId, role)
  );
  ipcMain.handle('lantern:transferGroupOwnership', (_event, groupId: string, deviceId: string) =>
    bindings.transferGroupOwnership(groupId, deviceId)
  );
  ipcMain.handle('lantern:deleteGroup', (_event, groupId: string) => bindings.deleteGroup(groupId));
  ipcMain.handle('lantern:leaveGroup', (_event, groupId: string) => bindings.leaveGroup(groupId));
  ipcMain.handle(
    'lantern:setGroupMessagePinned',
    (_event, groupId: string, messageId: string, pinned: boolean) =>
      bindings.setGroupMessagePinned(groupId, messageId, pinned)
  );
  ipcMain.handle('lantern:getRelaySettings', () => bindings.getRelaySettings());
  ipcMain.handle('lantern:getStartupSettings', () => bindings.getStartupSettings());
  ipcMain.handle('lantern:updateRelaySettings', (_event, input) =>
    bindings.updateRelaySettings(input)
  );
  ipcMain.handle('lantern:forceRelayRediscovery', () => bindings.forceRelayRediscovery());
  ipcMain.handle('lantern:updateStartupSettings', (_event, input) =>
    bindings.updateStartupSettings(input)
  );
  ipcMain.handle('lantern:getUpdateState', () => bindings.getUpdateState());
  ipcMain.handle('lantern:forceUpdate', () => bindings.forceUpdate());
  ipcMain.handle('lantern:installUpdate', () => bindings.installUpdate());
  ipcMain.handle(
    'lantern:sendText',
    (_event, peerId: string, text: string, replyTo?: MessageReplyPayload | null) =>
      bindings.sendText(peerId, text, replyTo)
  );
  ipcMain.handle(
    'lantern:sendGroupText',
    (_event, groupId: string, text: string, replyTo?: MessageReplyPayload | null) =>
      bindings.sendGroupText(groupId, text, replyTo)
  );
  ipcMain.handle('lantern:sendTyping', (_event, peerId: string, isTyping: boolean) =>
    bindings.sendTyping(peerId, isTyping)
  );
  ipcMain.handle(
    'lantern:sendAnnouncement',
    (_event, text: string, replyTo?: MessageReplyPayload | null) =>
      bindings.sendAnnouncement(text, replyTo)
  );
  ipcMain.handle(
    'lantern:sendAnnouncementFile',
    (_event, filePath: string, replyTo?: MessageReplyPayload | null) =>
      bindings.sendAnnouncementFile(filePath, replyTo)
  );
  ipcMain.handle(
    'lantern:sendFile',
    (
      _event,
      peerId: string,
      filePath: string,
      replyTo?: MessageReplyPayload | null
    ) => bindings.sendFile(peerId, filePath, replyTo)
  );
  ipcMain.handle(
    'lantern:sendGroupFile',
    (
      _event,
      groupId: string,
      filePath: string,
      replyTo?: MessageReplyPayload | null
    ) => bindings.sendGroupFile(groupId, filePath, replyTo)
  );
  ipcMain.handle(
    'lantern:forwardMessageToPeer',
    (_event, targetPeerId: string, sourceMessageId: string) =>
      bindings.forwardMessageToPeer(targetPeerId, sourceMessageId)
  );
  ipcMain.handle(
    'lantern:editMessage',
    (_event, conversationId: string, messageId: string, text: string) =>
      bindings.editMessage(conversationId, messageId, text)
  );
  ipcMain.handle(
    'lantern:reactToMessage',
    (_event, conversationId: string, messageId: string, reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null) =>
      bindings.reactToMessage(conversationId, messageId, reaction)
  );
  ipcMain.handle(
    'lantern:deleteMessageForEveryone',
    (_event, conversationId: string, messageId: string) =>
      bindings.deleteMessageForEveryone(conversationId, messageId)
  );
  ipcMain.handle(
    'lantern:deleteMessageForMe',
    (_event, conversationId: string, messageId: string) =>
      bindings.deleteMessageForMe(conversationId, messageId)
  );
  ipcMain.handle(
    'lantern:toggleMessageFavorite',
    (_event, conversationId: string, messageId: string, favorite: boolean) =>
      bindings.toggleMessageFavorite(conversationId, messageId, favorite)
  );
  ipcMain.handle('lantern:getMessageFavorites', (_event, messageIds: string[]) =>
    bindings.getMessageFavorites(messageIds)
  );
  ipcMain.handle('lantern:getFavoriteMessages', (_event, conversationId: string) =>
    bindings.getFavoriteMessages(conversationId)
  );
  ipcMain.handle('lantern:resyncConversation', (_event, conversationId: string) =>
    bindings.resyncConversation(conversationId)
  );
  ipcMain.handle(
    'lantern:getMessages',
    (_event, conversationId: string, limit: number, before?: number) =>
      bindings.getMessages(conversationId, limit, before)
  );
  ipcMain.handle('lantern:getMessagesByIds', (_event, messageIds: string[]) =>
    bindings.getMessagesByIds(messageIds)
  );
  ipcMain.handle(
    'lantern:listConversationMedia',
    (_event, conversationId: string, kind: ConversationMediaKind, cursor?: ConversationMediaCursor | null, limit?: number) =>
      bindings.listConversationMedia(conversationId, kind, cursor, limit)
  );
  ipcMain.handle(
    'lantern:searchConversationMessageIds',
    (_event, conversationId: string, query: string, limit?: number, offset?: number) =>
      bindings.searchConversationMessageIds(conversationId, query, limit, offset)
  );
  ipcMain.handle('lantern:getConversationPreviews', (_event, conversationIds: string[]) =>
    bindings.getConversationPreviews(conversationIds)
  );
  ipcMain.handle('lantern:getMessageReactions', (_event, messageIds: string[]) =>
    bindings.getMessageReactions(messageIds)
  );
  ipcMain.handle('lantern:getAnnouncementReactions', (_event, messageIds: string[]) =>
    bindings.getAnnouncementReactions(messageIds)
  );
  ipcMain.handle('lantern:getAnnouncementReactionDetails', (_event, messageId: string) =>
    bindings.getAnnouncementReactionDetails(messageId)
  );
  ipcMain.handle('lantern:getMessageReactionDetails', (_event, messageId: string) =>
    bindings.getMessageReactionDetails(messageId)
  );
  ipcMain.handle('lantern:getAnnouncementReadSummary', (_event, messageIds: string[]) =>
    bindings.getAnnouncementReadSummary(messageIds)
  );
  ipcMain.handle('lantern:getAnnouncementReadDetails', (_event, messageId: string) =>
    bindings.getAnnouncementReadDetails(messageId)
  );
  ipcMain.handle('lantern:getRelayStickers', () => bindings.getRelayStickers());
  ipcMain.handle('lantern:prepareRelayStickerFile', (_event, relativePath: string) =>
    bindings.prepareRelayStickerFile(relativePath)
  );
  ipcMain.handle(
    'lantern:exportConversation',
    (_event, conversationId: string, format: 'txt' | 'html') =>
      bindings.exportConversation(conversationId, format)
  );
  ipcMain.handle('lantern:setActiveConversation', (_event, conversationId: string) =>
    bindings.setActiveConversation(conversationId)
  );
  ipcMain.handle('lantern:markConversationRead', (_event, conversationId: string) =>
    bindings.markConversationRead(conversationId)
  );
  ipcMain.handle('lantern:markConversationUnread', (_event, conversationId: string) =>
    bindings.markConversationUnread(conversationId)
  );
  ipcMain.handle('lantern:archiveConversation', (_event, conversationId: string) =>
    bindings.archiveConversation(conversationId)
  );
  ipcMain.handle('lantern:unarchiveConversation', (_event, conversationId: string) =>
    bindings.unarchiveConversation(conversationId)
  );
  ipcMain.handle('lantern:getPinnedConversationIds', () => bindings.getPinnedConversationIds());
  ipcMain.handle('lantern:setConversationPinned', (_event, conversationId: string, pinned: boolean) =>
    bindings.setConversationPinned(conversationId, pinned)
  );
  ipcMain.handle('lantern:clearConversation', (_event, conversationId: string) =>
    bindings.clearConversation(conversationId)
  );
  ipcMain.handle('lantern:getConversations', () => bindings.getConversations());
  ipcMain.handle('lantern:getArchivedConversationIds', () =>
    bindings.getArchivedConversationIds()
  );
  ipcMain.handle('lantern:saveFileAs', (_event, filePath: string, fileName?: string) =>
    bindings.saveFileAs(filePath, fileName)
  );

  ipcMain.handle('lantern:pickFile', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Selecionar arquivo',
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle('lantern:pickFiles', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Selecionar arquivos',
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled || result.filePaths.length === 0) {
      return [] as string[];
    }
    return result.filePaths;
  });

  ipcMain.handle('lantern:pickDirectory', async (_event, defaultPath?: string) => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Selecionar pasta de recebimento',
      defaultPath: (defaultPath || '').trim() || undefined,
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle('lantern:openFile', async (_event, filePath: string) => {
    if (!filePath) return;
    await shell.openPath(filePath);
  });

  ipcMain.handle('lantern:openExternalUrl', async (_event, url: string) => {
    if (!url) return;
    await shell.openExternal(url);
  });

  ipcMain.handle('lantern:nativePaste', () => {
    try {
      if (!window.isDestroyed()) {
        window.webContents.paste();
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  });

  ipcMain.handle('lantern:getFilePreview', async (_event, filePath: string) => {
    if (!filePath) return null;
    const resolved = path.resolve(filePath);
    try {
      const stat = await fs.promises.stat(resolved);
      if (!stat.isFile()) return null;
      const ext = path.extname(resolved).toLowerCase();
      const imageExt = new Set([
        '.jpg',
        '.jpeg',
        '.png',
        '.gif',
        '.webp',
        '.bmp',
        '.svg',
        '.avif',
        '.heic',
        '.heif',
        '.tif',
        '.tiff'
      ]);
      if (!imageExt.has(ext)) return null;

      // Evita estourar memória em arquivos muito grandes.
      if (stat.size > 80 * 1024 * 1024) return null;
      const mimeByExt: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.svg': 'image/svg+xml',
        '.avif': 'image/avif',
        '.heic': 'image/heic',
        '.heif': 'image/heif',
        '.tif': 'image/tiff',
        '.tiff': 'image/tiff'
      };

      if (ext === '.gif' && stat.size <= 20 * 1024 * 1024) {
        const file = await fs.promises.readFile(resolved);
        if (file.length > 0) {
          return `data:image/gif;base64,${file.toString('base64')}`;
        }
      }

      const image = nativeImage.createFromPath(resolved);
      if (!image.isEmpty()) {
        const size = image.getSize();
        const maxSide = 420;
        const width = Math.max(1, size.width || 1);
        const height = Math.max(1, size.height || 1);
        const scale = Math.min(1, maxSide / Math.max(width, height));
        const resized =
          scale < 1
            ? image.resize({
                width: Math.max(1, Math.round(width * scale)),
                height: Math.max(1, Math.round(height * scale)),
                quality: 'good'
              })
            : image;
        return resized.toDataURL();
      }

      // Fallback binário para formatos em que nativeImage pode falhar em alguns ambientes.
      if (stat.size <= 20 * 1024 * 1024) {
        const mimeType = mimeByExt[ext] || 'application/octet-stream';
        const file = await fs.promises.readFile(resolved);
        if (file.length > 0) {
          return `data:${mimeType};base64,${file.toString('base64')}`;
        }
      }

      // Fallback para alguns SVGs que podem não abrir com createFromPath.
      if (ext === '.svg' && stat.size <= 8 * 1024 * 1024) {
        const file = await fs.promises.readFile(resolved);
        return `data:image/svg+xml;base64,${file.toString('base64')}`;
      }
      return null;
    } catch {
      return null;
    }
  });

  ipcMain.handle('lantern:getDocumentPreview', async (_event, filePath: string, fileName?: string | null) => {
    return createDocumentPreview(filePath, fileName);
  });

  ipcMain.handle('lantern:getFileInfo', async (_event, filePath: string) => {
    if (!filePath) return null;
    const resolved = path.resolve(filePath);
    try {
      const stat = await fs.promises.stat(resolved);
      if (!stat.isFile()) return null;
      const ext = path.extname(resolved).toLowerCase();
      const name = path.basename(resolved);
      const isImage = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|tiff?)$/i.test(name);
      return {
        name,
        size: stat.size,
        ext,
        isImage
      };
    } catch {
      return null;
    }
  });

  ipcMain.handle('lantern:getClipboardFilePaths', async () => {
    await cleanupClipboardTempDir();
    const candidates = extractClipboardPathCandidates();
    return normalizeClipboardPaths(candidates);
  });

  ipcMain.handle('lantern:clipboardHasFileLikeData', async () => {
    const paths = await normalizeClipboardPaths(extractClipboardPathCandidates());
    if (paths.length > 0) {
      return true;
    }
    try {
      const image = clipboard.readImage();
      return !image.isEmpty();
    } catch {
      return false;
    }
  });

  ipcMain.handle(
    'lantern:saveClipboardImage',
    async (_event, dataUrl: string, extension?: string) => {
      if (!dataUrl || typeof dataUrl !== 'string') return null;
      const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (!match) return null;

      // Normaliza imagem de clipboard em PNG para manter preview consistente
      // (alguns caminhos de paste entregam tipos não suportados pelo preview, ex: tiff/heic).
      try {
        const image = nativeImage.createFromDataURL(dataUrl);
        if (!image.isEmpty()) {
          const png = image.toPNG();
          if (png.length > 0) {
            return saveClipboardBufferToTemp(png, 'png', 'clipboard-image');
          }
        }
      } catch {
        // fallback abaixo
      }

      const buffer = Buffer.from(match[2], 'base64');
      const requestedExt =
        (extension || match[1].split('/')[1] || 'png').replace(/[^a-zA-Z0-9]/g, '') || 'png';
      const safeExt = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(
        requestedExt.toLowerCase()
      )
        ? requestedExt
        : 'png';
      return saveClipboardBufferToTemp(buffer, safeExt, 'clipboard-image');
    }
  );

  ipcMain.handle('lantern:saveClipboardFileData', async (_event, dataUrl: string, fileName?: string) => {
    if (!dataUrl || typeof dataUrl !== 'string') return null;
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;

    await cleanupClipboardTempDir();
    await fs.promises.mkdir(CLIPBOARD_TEMP_DIR, { recursive: true });

    const rawName = (fileName || '').trim();
    const safeName = Array.from(rawName)
      .map((char) => {
        const code = char.charCodeAt(0);
        if (code < 32) return '_';
        if ('\\/:*?"<>|'.includes(char)) return '_';
        return char;
      })
      .join('')
      .slice(0, 180);
    const extFromName = path.extname(safeName).replace(/[^a-zA-Z0-9.]/g, '');
    const extFromMime = `.${(match[1].split('/')[1] || 'bin').replace(/[^a-zA-Z0-9]/g, '') || 'bin'}`;
    const ext = extFromName || extFromMime;
    const baseName = safeName ? path.basename(safeName, extFromName || undefined) : 'clipboard-file';
    const filePath = path.join(
      CLIPBOARD_TEMP_DIR,
      `${baseName}-${Date.now()}-${randomUUID()}${ext}`
    );
    const buffer = Buffer.from(match[2], 'base64');
    await fs.promises.writeFile(filePath, buffer);
    return filePath;
  });

  return {
    emitEvent: (event: AppEvent) => {
      window.webContents.send('lantern:event', event);
    }
  };
};
