import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('relayUi', {
  status: () => ipcRenderer.invoke('relay-ui:status'),
  start: () => ipcRenderer.invoke('relay-ui:start'),
  stop: () => ipcRenderer.invoke('relay-ui:stop'),
  restart: () => ipcRenderer.invoke('relay-ui:restart'),
  backup: () => ipcRenderer.invoke('relay-ui:backup'),
  management: () => ipcRenderer.invoke('relay-ui:management'),
  createUser: (input: unknown) => ipcRenderer.invoke('relay-ui:createUser', input),
  updateUser: (userId: string, input: unknown) => ipcRenderer.invoke('relay-ui:updateUser', userId, input),
  resetPassword: (userId: string, password: string) => ipcRenderer.invoke('relay-ui:resetPassword', userId, password),
  deleteUser: (userId: string) => ipcRenderer.invoke('relay-ui:deleteUser', userId),
  reviewPasswordReset: (requestId: string, approve: boolean) => ipcRenderer.invoke('relay-ui:reviewPasswordReset', requestId, approve),
  setAnnouncementTtl: (ttlMs: number) => ipcRenderer.invoke('relay-ui:setAnnouncementTtl', ttlMs),
  setAnnouncementExpiry: (messageId: string, expiresAt: number) => ipcRenderer.invoke('relay-ui:setAnnouncementExpiry', messageId, expiresAt),
  configureCalendar: (input: unknown) => ipcRenderer.invoke('relay-ui:configureCalendar', input),
  refreshCalendar: () => ipcRenderer.invoke('relay-ui:refreshCalendar'),
  importStickers: (input: { category?: string; replaceExisting?: boolean }) => ipcRenderer.invoke('relay-ui:importStickers', input),
  updateSticker: (relativePath: string, input: { label: string; category: string }) => ipcRenderer.invoke('relay-ui:updateSticker', relativePath, input),
  removeSticker: (relativePath: string) => ipcRenderer.invoke('relay-ui:removeSticker', relativePath),
  stickerPreview: (relativePath: string) => ipcRenderer.invoke('relay-ui:stickerPreview', relativePath),
  openDashboard: () => ipcRenderer.invoke('relay-ui:openDashboard'),
  updateSettings: (input: { port?: number; tlsCertFile?: string; tlsKeyFile?: string; startAtLogin?: boolean; startRelayOnLaunch?: boolean }) =>
    ipcRenderer.invoke('relay-ui:updateSettings', input),
  pickCertificate: () => ipcRenderer.invoke('relay-ui:pickCertificate'),
  pickPrivateKey: () => ipcRenderer.invoke('relay-ui:pickPrivateKey')
});
