import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('relayUi', {
  status: () => ipcRenderer.invoke('relay-ui:status'),
  start: () => ipcRenderer.invoke('relay-ui:start'),
  stop: () => ipcRenderer.invoke('relay-ui:stop'),
  restart: () => ipcRenderer.invoke('relay-ui:restart'),
  setAutoStart: (enabled: boolean) => ipcRenderer.invoke('relay-ui:setAutoStart', enabled),
  updateSettings: (input: { port?: number; announcementTtlHours?: number }) =>
    ipcRenderer.invoke('relay-ui:updateSettings', input)
});
