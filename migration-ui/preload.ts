import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('migrationUi', {
  pickBackups: () => ipcRenderer.invoke('migration-ui:pickBackups'),
  pickOutput: () => ipcRenderer.invoke('migration-ui:pickOutput'),
  pickMapping: () => ipcRenderer.invoke('migration-ui:pickMapping'),
  pickReport: () => ipcRenderer.invoke('migration-ui:pickReport'),
  run: (input: unknown) => ipcRenderer.invoke('migration-ui:run', input),
  openPath: (target: string) => ipcRenderer.invoke('migration-ui:openPath', target),
  onOutput: (callback: (line: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, line: string) => callback(line);
    ipcRenderer.on('migration-ui:output', listener);
    return () => ipcRenderer.removeListener('migration-ui:output', listener);
  }
});
