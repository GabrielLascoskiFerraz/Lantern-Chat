import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('relayUi', {
  status: () => ipcRenderer.invoke('relay-ui:status'),
  start: () => ipcRenderer.invoke('relay-ui:start'),
  stop: () => ipcRenderer.invoke('relay-ui:stop'),
  restart: () => ipcRenderer.invoke('relay-ui:restart'),
  backup: () => ipcRenderer.invoke('relay-ui:backup'),
  openDashboard: () => ipcRenderer.invoke('relay-ui:openDashboard'),
  updateSettings: (input: { port?: number; tlsCertFile?: string; tlsKeyFile?: string }) =>
    ipcRenderer.invoke('relay-ui:updateSettings', input),
  pickCertificate: () => ipcRenderer.invoke('relay-ui:pickCertificate'),
  pickPrivateKey: () => ipcRenderer.invoke('relay-ui:pickPrivateKey')
});
