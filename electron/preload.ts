import { contextBridge, ipcRenderer } from 'electron';
import { AppEvent, ClientRelayConfig, DocumentPreviewResult, MessageReplyPayload } from './types';

type EventCallback = (event: AppEvent) => void;

const api = {
  getPlatform: () => process.platform,
  getAuthState: () => ipcRenderer.invoke('lantern:getAuthState'),
  discoverRelays: (port?: number) => ipcRenderer.invoke('lantern:discoverRelays', port),
  login: (input: { relay: ClientRelayConfig; username: string; password: string; rememberMe?: boolean }) =>
    ipcRenderer.invoke('lantern:login', input),
  requestPasswordReset: (input: { relay: ClientRelayConfig; username: string }) =>
    ipcRenderer.invoke('lantern:requestPasswordReset', input),
  getPasswordResetStatus: (requestToken: string) =>
    ipcRenderer.invoke('lantern:getPasswordResetStatus', requestToken),
  completePasswordReset: (input: { username: string; requestToken: string; newPassword: string }) =>
    ipcRenderer.invoke('lantern:completePasswordReset', input),
  changePassword: (input: { currentPassword: string; newPassword: string }) =>
    ipcRenderer.invoke('lantern:changePassword', input),
  register: (input: { relay: ClientRelayConfig; username: string; displayName: string; password: string; locale: 'pt-BR' | 'en' | 'es' }) =>
    ipcRenderer.invoke('lantern:register', input),
  completeFirstLoginSetup: (input: { avatarEmoji: string; avatarBg: string; openAtLogin: boolean }) =>
    ipcRenderer.invoke('lantern:completeFirstLoginSetup', input),
  logout: () => ipcRenderer.invoke('lantern:logout'),
  getProfile: () => ipcRenderer.invoke('lantern:getProfile'),
  updateProfile: (input: { displayName: string; avatarEmoji: string; avatarBg: string; statusMessage: string }) =>
    ipcRenderer.invoke('lantern:updateProfile', input),
  getKnownPeers: () => ipcRenderer.invoke('lantern:getKnownPeers'),
  getOnlinePeers: () => ipcRenderer.invoke('lantern:getOnlinePeers'),
  getGroups: () => ipcRenderer.invoke('lantern:getGroups'),
  getGroupMembers: (groupId: string) => ipcRenderer.invoke('lantern:getGroupMembers', groupId),
  getGroupPinnedMessageIds: (groupId: string) =>
    ipcRenderer.invoke('lantern:getGroupPinnedMessageIds', groupId),
  createGroup: (input: {
    name: string;
    emoji: string;
    avatarBg: string;
    description: string;
    memberDeviceIds: string[];
  }) => ipcRenderer.invoke('lantern:createGroup', input),
  updateGroup: (
    groupId: string,
    input: {
      name?: string;
      emoji?: string;
      avatarBg?: string;
      description?: string;
      settings?: Record<string, boolean>;
    }
  ) => ipcRenderer.invoke('lantern:updateGroup', groupId, input),
  addGroupMembers: (groupId: string, memberDeviceIds: string[]) =>
    ipcRenderer.invoke('lantern:addGroupMembers', groupId, memberDeviceIds),
  removeGroupMember: (groupId: string, deviceId: string) =>
    ipcRenderer.invoke('lantern:removeGroupMember', groupId, deviceId),
  setGroupMemberRole: (groupId: string, deviceId: string, role: 'admin' | 'member') =>
    ipcRenderer.invoke('lantern:setGroupMemberRole', groupId, deviceId, role),
  transferGroupOwnership: (groupId: string, deviceId: string) =>
    ipcRenderer.invoke('lantern:transferGroupOwnership', groupId, deviceId),
  deleteGroup: (groupId: string) => ipcRenderer.invoke('lantern:deleteGroup', groupId),
  leaveGroup: (groupId: string) => ipcRenderer.invoke('lantern:leaveGroup', groupId),
  setGroupMessagePinned: (groupId: string, messageId: string, pinned: boolean) =>
    ipcRenderer.invoke('lantern:setGroupMessagePinned', groupId, messageId, pinned),
  getRelaySettings: () => ipcRenderer.invoke('lantern:getRelaySettings'),
  getStartupSettings: () => ipcRenderer.invoke('lantern:getStartupSettings'),
  updateRelaySettings: (input: { automatic: boolean; host?: string; port?: number }) =>
    ipcRenderer.invoke('lantern:updateRelaySettings', input),
  forceRelayRediscovery: () => ipcRenderer.invoke('lantern:forceRelayRediscovery'),
  updateStartupSettings: (input: { openAtLogin: boolean; downloadsDir?: string; doNotDisturbUntil?: number }) =>
    ipcRenderer.invoke('lantern:updateStartupSettings', input),
  sendText: (peerId: string, text: string, replyTo?: MessageReplyPayload | null) =>
    ipcRenderer.invoke('lantern:sendText', peerId, text, replyTo),
  sendGroupText: (groupId: string, text: string, replyTo?: MessageReplyPayload | null) =>
    ipcRenderer.invoke('lantern:sendGroupText', groupId, text, replyTo),
  sendTyping: (peerId: string, isTyping: boolean) =>
    ipcRenderer.invoke('lantern:sendTyping', peerId, isTyping),
  sendAnnouncement: (text: string, replyTo?: MessageReplyPayload | null) =>
    ipcRenderer.invoke('lantern:sendAnnouncement', text, replyTo),
  sendAnnouncementFile: (filePath: string, replyTo?: MessageReplyPayload | null) =>
    ipcRenderer.invoke('lantern:sendAnnouncementFile', filePath, replyTo),
  sendFile: (peerId: string, filePath: string, replyTo?: MessageReplyPayload | null) =>
    ipcRenderer.invoke('lantern:sendFile', peerId, filePath, replyTo),
  sendGroupFile: (groupId: string, filePath: string, replyTo?: MessageReplyPayload | null) =>
    ipcRenderer.invoke('lantern:sendGroupFile', groupId, filePath, replyTo),
  forwardMessageToPeer: (targetPeerId: string, sourceMessageId: string) =>
    ipcRenderer.invoke('lantern:forwardMessageToPeer', targetPeerId, sourceMessageId),
  editMessage: (conversationId: string, messageId: string, text: string) =>
    ipcRenderer.invoke('lantern:editMessage', conversationId, messageId, text),
  reactToMessage: (
    conversationId: string,
    messageId: string,
    reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null
  ) => ipcRenderer.invoke('lantern:reactToMessage', conversationId, messageId, reaction),
  deleteMessageForEveryone: (conversationId: string, messageId: string) =>
    ipcRenderer.invoke('lantern:deleteMessageForEveryone', conversationId, messageId),
  deleteMessageForMe: (conversationId: string, messageId: string) =>
    ipcRenderer.invoke('lantern:deleteMessageForMe', conversationId, messageId),
  toggleMessageFavorite: (conversationId: string, messageId: string, favorite: boolean) =>
    ipcRenderer.invoke('lantern:toggleMessageFavorite', conversationId, messageId, favorite),
  getMessageFavorites: (messageIds: string[]) =>
    ipcRenderer.invoke('lantern:getMessageFavorites', messageIds),
  getFavoriteMessages: (conversationId: string) =>
    ipcRenderer.invoke('lantern:getFavoriteMessages', conversationId),
  resyncConversation: (conversationId: string) =>
    ipcRenderer.invoke('lantern:resyncConversation', conversationId),
  getMessages: (conversationId: string, limit: number, before?: number) =>
    ipcRenderer.invoke('lantern:getMessages', conversationId, limit, before),
  getMessagesByIds: (messageIds: string[]) =>
    ipcRenderer.invoke('lantern:getMessagesByIds', messageIds),
  listConversationMedia: (
    conversationId: string,
    kind: 'media' | 'document',
    cursor?: { createdAt: number; messageId: string } | null,
    limit?: number
  ) => ipcRenderer.invoke('lantern:listConversationMedia', conversationId, kind, cursor, limit),
  searchConversationMessageIds: (
    conversationId: string,
    query: string,
    limit?: number,
    offset?: number
  ) => ipcRenderer.invoke('lantern:searchConversationMessageIds', conversationId, query, limit, offset),
  getConversationPreviews: (conversationIds: string[]) =>
    ipcRenderer.invoke('lantern:getConversationPreviews', conversationIds),
  getMessageReactions: (messageIds: string[]) =>
    ipcRenderer.invoke('lantern:getMessageReactions', messageIds),
  getAnnouncementReactions: (messageIds: string[]) =>
    ipcRenderer.invoke('lantern:getAnnouncementReactions', messageIds),
  getAnnouncementReactionDetails: (messageId: string) =>
    ipcRenderer.invoke('lantern:getAnnouncementReactionDetails', messageId),
  getMessageReactionDetails: (messageId: string) =>
    ipcRenderer.invoke('lantern:getMessageReactionDetails', messageId),
  getAnnouncementReadSummary: (messageIds: string[]) =>
    ipcRenderer.invoke('lantern:getAnnouncementReadSummary', messageIds),
  getAnnouncementReadDetails: (messageId: string) =>
    ipcRenderer.invoke('lantern:getAnnouncementReadDetails', messageId),
  exportConversation: (conversationId: string, format: 'txt' | 'html') =>
    ipcRenderer.invoke('lantern:exportConversation', conversationId, format),
  setActiveConversation: (conversationId: string) =>
    ipcRenderer.invoke('lantern:setActiveConversation', conversationId),
  markConversationRead: (conversationId: string) =>
    ipcRenderer.invoke('lantern:markConversationRead', conversationId),
  markConversationUnread: (conversationId: string) =>
    ipcRenderer.invoke('lantern:markConversationUnread', conversationId),
  archiveConversation: (conversationId: string) =>
    ipcRenderer.invoke('lantern:archiveConversation', conversationId),
  unarchiveConversation: (conversationId: string) =>
    ipcRenderer.invoke('lantern:unarchiveConversation', conversationId),
  getPinnedConversationIds: () => ipcRenderer.invoke('lantern:getPinnedConversationIds'),
  setConversationPinned: (conversationId: string, pinned: boolean) =>
    ipcRenderer.invoke('lantern:setConversationPinned', conversationId, pinned),
  clearConversation: (conversationId: string) =>
    ipcRenderer.invoke('lantern:clearConversation', conversationId),
  getConversations: () => ipcRenderer.invoke('lantern:getConversations'),
  getArchivedConversationIds: () => ipcRenderer.invoke('lantern:getArchivedConversationIds'),
  pickFile: (): Promise<string | null> => ipcRenderer.invoke('lantern:pickFile'),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('lantern:pickFiles'),
  pickDirectory: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('lantern:pickDirectory', defaultPath),
  openFile: (filePath: string): Promise<void> => ipcRenderer.invoke('lantern:openFile', filePath),
  saveFileAs: (filePath: string, fileName?: string): Promise<void> =>
    ipcRenderer.invoke('lantern:saveFileAs', filePath, fileName),
  openExternalUrl: (url: string): Promise<void> => ipcRenderer.invoke('lantern:openExternalUrl', url),
  nativePaste: (): Promise<boolean> => ipcRenderer.invoke('lantern:nativePaste'),
  getFilePreview: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke('lantern:getFilePreview', filePath),
  getDocumentPreview: (filePath: string, fileName?: string | null): Promise<DocumentPreviewResult> =>
    ipcRenderer.invoke('lantern:getDocumentPreview', filePath, fileName),
  getFileInfo: (filePath: string): Promise<{
    name: string;
    size: number;
    ext: string;
    isImage: boolean;
  } | null> => ipcRenderer.invoke('lantern:getFileInfo', filePath),
  getClipboardFilePaths: (): Promise<string[]> => ipcRenderer.invoke('lantern:getClipboardFilePaths'),
  clipboardHasFileLikeData: (): Promise<boolean> =>
    ipcRenderer.invoke('lantern:clipboardHasFileLikeData'),
  saveClipboardImage: (dataUrl: string, extension?: string): Promise<string | null> =>
    ipcRenderer.invoke('lantern:saveClipboardImage', dataUrl, extension),
  saveClipboardFileData: (dataUrl: string, fileName?: string): Promise<string | null> =>
    ipcRenderer.invoke('lantern:saveClipboardFileData', dataUrl, fileName),
  getRelayStickers: () => ipcRenderer.invoke('lantern:getRelayStickers'),
  prepareRelayStickerFile: (relativePath: string): Promise<string | null> =>
    ipcRenderer.invoke('lantern:prepareRelayStickerFile', relativePath),
  onEvent: (callback: EventCallback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AppEvent) => callback(payload);
    ipcRenderer.on('lantern:event', listener);
    return () => ipcRenderer.removeListener('lantern:event', listener);
  }
};

contextBridge.exposeInMainWorld('lantern', api);
