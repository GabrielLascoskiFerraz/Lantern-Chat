import { contextBridge, ipcRenderer } from 'electron';
import { AppEvent } from './types';

type EventCallback = (event: AppEvent) => void;

const api = {
  getPlatform: () => process.platform,
  getProfile: () => ipcRenderer.invoke('lantern:getProfile'),
  updateProfile: (input: { displayName: string; avatarEmoji: string; avatarBg: string; statusMessage: string }) =>
    ipcRenderer.invoke('lantern:updateProfile', input),
  getKnownPeers: () => ipcRenderer.invoke('lantern:getKnownPeers'),
  getOnlinePeers: () => ipcRenderer.invoke('lantern:getOnlinePeers'),
  getRelaySettings: () => ipcRenderer.invoke('lantern:getRelaySettings'),
  getStartupSettings: () => ipcRenderer.invoke('lantern:getStartupSettings'),
  updateRelaySettings: (input: { automatic: boolean; host?: string; port?: number }) =>
    ipcRenderer.invoke('lantern:updateRelaySettings', input),
  updateStartupSettings: (input: { openAtLogin: boolean; downloadsDir?: string }) =>
    ipcRenderer.invoke('lantern:updateStartupSettings', input),
  sendText: (peerId: string, text: string) => ipcRenderer.invoke('lantern:sendText', peerId, text),
  sendTyping: (peerId: string, isTyping: boolean) =>
    ipcRenderer.invoke('lantern:sendTyping', peerId, isTyping),
  sendAnnouncement: (text: string) => ipcRenderer.invoke('lantern:sendAnnouncement', text),
  sendFile: (peerId: string, filePath: string) => ipcRenderer.invoke('lantern:sendFile', peerId, filePath),
  reactToMessage: (
    conversationId: string,
    messageId: string,
    reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null
  ) => ipcRenderer.invoke('lantern:reactToMessage', conversationId, messageId, reaction),
  deleteMessageForEveryone: (conversationId: string, messageId: string) =>
    ipcRenderer.invoke('lantern:deleteMessageForEveryone', conversationId, messageId),
  getMessages: (conversationId: string, limit: number, before?: number) =>
    ipcRenderer.invoke('lantern:getMessages', conversationId, limit, before),
  getMessagesByIds: (messageIds: string[]) =>
    ipcRenderer.invoke('lantern:getMessagesByIds', messageIds),
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
  setActiveConversation: (conversationId: string) =>
    ipcRenderer.invoke('lantern:setActiveConversation', conversationId),
  markConversationRead: (conversationId: string) =>
    ipcRenderer.invoke('lantern:markConversationRead', conversationId),
  markConversationUnread: (conversationId: string) =>
    ipcRenderer.invoke('lantern:markConversationUnread', conversationId),
  clearConversation: (conversationId: string) =>
    ipcRenderer.invoke('lantern:clearConversation', conversationId),
  forgetContactConversation: (conversationId: string) =>
    ipcRenderer.invoke('lantern:forgetContactConversation', conversationId),
  getConversations: () => ipcRenderer.invoke('lantern:getConversations'),
  addManualPeer: (address: string, port: number) =>
    ipcRenderer.invoke('lantern:addManualPeer', address, port),
  pickFile: (): Promise<string | null> => ipcRenderer.invoke('lantern:pickFile'),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('lantern:pickFiles'),
  pickDirectory: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('lantern:pickDirectory', defaultPath),
  openFile: (filePath: string): Promise<void> => ipcRenderer.invoke('lantern:openFile', filePath),
  saveFileAs: (filePath: string, fileName?: string): Promise<void> =>
    ipcRenderer.invoke('lantern:saveFileAs', filePath, fileName),
  openExternalUrl: (url: string): Promise<void> => ipcRenderer.invoke('lantern:openExternalUrl', url),
  getFilePreview: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke('lantern:getFilePreview', filePath),
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
  onEvent: (callback: EventCallback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AppEvent) => callback(payload);
    ipcRenderer.on('lantern:event', listener);
    return () => ipcRenderer.removeListener('lantern:event', listener);
  }
};

contextBridge.exposeInMainWorld('lantern', api);
