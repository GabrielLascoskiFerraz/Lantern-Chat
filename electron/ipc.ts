import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { AnnouncementReactionSummary, AppEvent, DbMessage, Peer, Profile } from './types';

export interface IpcBindings {
  getProfile: () => Profile;
  updateProfile: (input: Pick<Profile, 'displayName' | 'avatarEmoji' | 'avatarBg' | 'statusMessage'>) => Profile;
  getKnownPeers: () => Peer[];
  getOnlinePeers: () => Peer[];
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
  updateStartupSettings: (input: { openAtLogin: boolean; downloadsDir?: string }) => {
    supported: boolean;
    openAtLogin: boolean;
    downloadsDir: string;
  };
  sendText: (peerId: string, text: string) => Promise<DbMessage>;
  sendTyping: (peerId: string, isTyping: boolean) => Promise<void>;
  sendAnnouncement: (text: string) => Promise<DbMessage>;
  sendFile: (peerId: string, filePath: string) => Promise<DbMessage>;
  reactToMessage: (
    conversationId: string,
    messageId: string,
    reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null
  ) => Promise<DbMessage | null>;
  deleteMessageForEveryone: (conversationId: string, messageId: string) => Promise<DbMessage | null>;
  getMessages: (conversationId: string, limit: number, before?: number) => DbMessage[];
  getMessagesByIds: (messageIds: string[]) => DbMessage[];
  searchConversationMessageIds: (
    conversationId: string,
    query: string,
    limit?: number,
    offset?: number
  ) => string[];
  getConversationPreviews: (conversationIds: string[]) => Record<string, string>;
  getMessageReactions: (messageIds: string[]) => Record<string, AnnouncementReactionSummary>;
  getAnnouncementReactions: (messageIds: string[]) => Record<string, AnnouncementReactionSummary>;
  setActiveConversation: (conversationId: string) => void;
  markConversationRead: (conversationId: string) => void;
  markConversationUnread: (conversationId: string) => void;
  clearConversation: (conversationId: string) => void;
  forgetContactConversation: (conversationId: string) => Promise<void>;
  getConversations: () => Record<string, number>;
  addManualPeer: (address: string, port: number) => void;
  saveFileAs: (filePath: string, fileName?: string) => Promise<void>;
}

export const registerIpc = (
  window: BrowserWindow,
  bindings: IpcBindings
): { emitEvent: (event: AppEvent) => void } => {
  ipcMain.handle('lantern:getProfile', () => bindings.getProfile());
  ipcMain.handle('lantern:updateProfile', (_event, input) => bindings.updateProfile(input));
  ipcMain.handle('lantern:getKnownPeers', () => bindings.getKnownPeers());
  ipcMain.handle('lantern:getOnlinePeers', () => bindings.getOnlinePeers());
  ipcMain.handle('lantern:getRelaySettings', () => bindings.getRelaySettings());
  ipcMain.handle('lantern:getStartupSettings', () => bindings.getStartupSettings());
  ipcMain.handle('lantern:updateRelaySettings', (_event, input) =>
    bindings.updateRelaySettings(input)
  );
  ipcMain.handle('lantern:updateStartupSettings', (_event, input) =>
    bindings.updateStartupSettings(input)
  );
  ipcMain.handle('lantern:sendText', (_event, peerId: string, text: string) =>
    bindings.sendText(peerId, text)
  );
  ipcMain.handle('lantern:sendTyping', (_event, peerId: string, isTyping: boolean) =>
    bindings.sendTyping(peerId, isTyping)
  );
  ipcMain.handle('lantern:sendAnnouncement', (_event, text: string) => bindings.sendAnnouncement(text));
  ipcMain.handle('lantern:sendFile', (_event, peerId: string, filePath: string) =>
    bindings.sendFile(peerId, filePath)
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
    'lantern:getMessages',
    (_event, conversationId: string, limit: number, before?: number) =>
      bindings.getMessages(conversationId, limit, before)
  );
  ipcMain.handle('lantern:getMessagesByIds', (_event, messageIds: string[]) =>
    bindings.getMessagesByIds(messageIds)
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
  ipcMain.handle('lantern:setActiveConversation', (_event, conversationId: string) =>
    bindings.setActiveConversation(conversationId)
  );
  ipcMain.handle('lantern:markConversationRead', (_event, conversationId: string) =>
    bindings.markConversationRead(conversationId)
  );
  ipcMain.handle('lantern:markConversationUnread', (_event, conversationId: string) =>
    bindings.markConversationUnread(conversationId)
  );
  ipcMain.handle('lantern:clearConversation', (_event, conversationId: string) =>
    bindings.clearConversation(conversationId)
  );
  ipcMain.handle('lantern:forgetContactConversation', (_event, conversationId: string) =>
    bindings.forgetContactConversation(conversationId)
  );
  ipcMain.handle('lantern:getConversations', () => bindings.getConversations());
  ipcMain.handle('lantern:addManualPeer', (_event, address: string, port: number) =>
    bindings.addManualPeer(address, port)
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

  ipcMain.handle('lantern:getFilePreview', async (_event, filePath: string) => {
    if (!filePath) return null;
    const resolved = path.resolve(filePath);
    try {
      const stat = await fs.promises.stat(resolved);
      if (!stat.isFile()) return null;
      if (stat.size > 8 * 1024 * 1024) return null;

      const ext = path.extname(resolved).toLowerCase();
      const mimeByExt: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.svg': 'image/svg+xml'
      };
      const mime = mimeByExt[ext];
      if (!mime) return null;

      const file = await fs.promises.readFile(resolved);
      return `data:${mime};base64,${file.toString('base64')}`;
    } catch {
      return null;
    }
  });

  ipcMain.handle('lantern:getFileInfo', async (_event, filePath: string) => {
    if (!filePath) return null;
    const resolved = path.resolve(filePath);
    try {
      const stat = await fs.promises.stat(resolved);
      if (!stat.isFile()) return null;
      const ext = path.extname(resolved).toLowerCase();
      const name = path.basename(resolved);
      const isImage = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
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

  ipcMain.handle(
    'lantern:saveClipboardImage',
    async (_event, dataUrl: string, extension?: string) => {
      if (!dataUrl || typeof dataUrl !== 'string') return null;
      const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (!match) return null;

      const tempDir = path.join(os.tmpdir(), 'lantern-paste');
      await fs.promises.mkdir(tempDir, { recursive: true });
      const safeExt =
        (extension || match[1].split('/')[1] || 'png').replace(/[^a-zA-Z0-9]/g, '') || 'png';
      const filePath = path.join(tempDir, `clipboard-${Date.now()}-${randomUUID()}.${safeExt}`);
      const buffer = Buffer.from(match[2], 'base64');
      await fs.promises.writeFile(filePath, buffer);
      return filePath;
    }
  );

  return {
    emitEvent: (event: AppEvent) => {
      window.webContents.send('lantern:event', event);
    }
  };
};
