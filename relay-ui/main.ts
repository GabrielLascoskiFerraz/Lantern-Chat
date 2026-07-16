import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type OpenDialogOptions } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LanternRelay, RelayConfig } from '../relay/main';

interface RelayUiSettings {
  port: number;
  tlsCertFile: string;
  tlsKeyFile: string;
  startAtLogin: boolean;
  startRelayOnLaunch: boolean;
}

let mainWindow: BrowserWindow | null = null;
let relay: LanternRelay | null = null;

const settingsFile = (): string => path.join(app.getPath('userData'), 'relay-ui-settings.json');
const normalizeSettings = (value: Partial<RelayUiSettings>): RelayUiSettings => ({
  port: Number.isFinite(value.port) && Number(value.port) > 0 && Number(value.port) <= 65535
    ? Math.trunc(Number(value.port)) : 43190,
  tlsCertFile: String(value.tlsCertFile || '').trim(),
  tlsKeyFile: String(value.tlsKeyFile || '').trim(),
  startAtLogin: value.startAtLogin === true,
  startRelayOnLaunch: value.startRelayOnLaunch === true
});
const loadSettings = (): RelayUiSettings => {
  try { return normalizeSettings(JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); }
  catch { return normalizeSettings({}); }
};
const saveSettings = (value: Partial<RelayUiSettings>): RelayUiSettings => {
  const next = normalizeSettings({ ...loadSettings(), ...value });
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  applyLoginItemSettings(next);
  return next;
};
const loginItemSupported = (): boolean => process.platform === 'darwin' || process.platform === 'win32';
const applyLoginItemSettings = (settings: RelayUiSettings): void => {
  if (!loginItemSupported()) return;
  app.setLoginItemSettings({ openAtLogin: settings.startAtLogin, openAsHidden: false });
};
const localAddresses = (): string[] => Object.values(os.networkInterfaces())
  .flatMap((entries) => entries || [])
  .filter((entry) => entry.family === 'IPv4' && !entry.internal)
  .map((entry) => entry.address)
  .sort();
const snapshot = () => {
  const settings = loadSettings();
  return relay
    ? { running: true, settings, loginItemSupported: loginItemSupported(), localAddresses: localAddresses(), ...relay.getDashboardSnapshot() }
    : { running: false, settings, loginItemSupported: loginItemSupported(), localAddresses: localAddresses(), port: settings.port,
        tls: Boolean(settings.tlsCertFile && settings.tlsKeyFile), peersOnline: 0,
        announcementsActive: 0, uptimeMs: 0, centralStore: {}, transferMetrics: null,
        reliabilityMetrics: null, peers: [] };
};
const startRelay = async () => {
  if (relay) return snapshot();
  const settings = loadSettings();
  if (Boolean(settings.tlsCertFile) !== Boolean(settings.tlsKeyFile)) {
    throw new Error('Informe certificado TLS e chave privada juntos, ou deixe ambos vazios para WS local.');
  }
  if (settings.tlsCertFile && (!fs.existsSync(settings.tlsCertFile) || !fs.existsSync(settings.tlsKeyFile))) {
    throw new Error('O certificado TLS ou a chave privada não foi encontrado.');
  }
  process.env.LANTERN_RELAY_DATA_DIR = path.join(app.getPath('userData'), 'relay-data');
  const runtime = require('../relay/main') as typeof import('../relay/main');
  const config: RelayConfig = {
    host: '0.0.0.0', port: settings.port, pingIntervalMs: 5_000, peerTimeoutMs: 30_000,
    presenceBroadcastIntervalMs: 12_000, maxPayloadBytes: 8 * 1024 * 1024,
    tlsCertFile: settings.tlsCertFile || null, tlsKeyFile: settings.tlsKeyFile || null, externalMode: false
  };
  relay = new runtime.LanternRelay(config);
  try { await relay.start(); return snapshot(); }
  catch (error) { relay = null; throw error; }
};
const stopRelay = async () => {
  const current = relay;
  relay = null;
  if (current) await current.stop('relay-ui-stop');
  return snapshot();
};
const restartRelay = async () => { await stopRelay(); return startRelay(); };

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1120, height: 820, minWidth: 380, minHeight: 560, title: 'Lantern Relay',
    backgroundColor: '#edf1f7', autoHideMenuBar: true,
    icon: path.join(__dirname, '..', '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  void mainWindow.loadFile(path.join(__dirname, '..', '..', 'relay-ui', 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
};

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const settings = loadSettings();
  applyLoginItemSettings(settings);
  createWindow();
  if (settings.startRelayOnLaunch) {
    try { await startRelay(); }
    catch (error) {
      dialog.showErrorBox('Não foi possível iniciar o Lantern Relay', error instanceof Error ? error.message : String(error));
    }
  }
});
app.on('window-all-closed', () => void stopRelay().finally(() => app.quit()));
ipcMain.handle('relay-ui:status', snapshot);
ipcMain.handle('relay-ui:start', startRelay);
ipcMain.handle('relay-ui:stop', stopRelay);
ipcMain.handle('relay-ui:restart', restartRelay);
ipcMain.handle('relay-ui:backup', async () => {
  if (!relay) throw new Error('Inicie o Relay antes de criar um backup.');
  return relay.createCanonicalBackup();
});
const requireRelay = (): LanternRelay => {
  if (!relay) throw new Error('Inicie o Relay para acessar o gerenciamento.');
  return relay;
};
ipcMain.handle('relay-ui:management', () => requireRelay().getManagementSnapshot());
ipcMain.handle('relay-ui:createUser', (_event, input) => requireRelay().createManagedUser(input));
ipcMain.handle('relay-ui:updateUser', (_event, userId, rawInput) => {
  const source = rawInput && typeof rawInput === 'object' ? rawInput as Record<string, unknown> : {};
  const input: { displayName?: string; department?: string; disabled?: boolean; role?: 'admin' | 'user' } = {};
  if ('displayName' in source) input.displayName = String(source.displayName ?? '');
  if ('department' in source) input.department = String(source.department ?? '');
  if ('disabled' in source) {
    if (typeof source.disabled !== 'boolean') throw new Error('Estado da conta inválido.');
    input.disabled = source.disabled;
  }
  if ('role' in source) {
    if (source.role !== 'admin' && source.role !== 'user') throw new Error('Permissão da conta inválida.');
    input.role = source.role;
  }
  if (Object.keys(input).length === 0) throw new Error('Nenhuma alteração válida foi informada.');
  return requireRelay().updateManagedUser(String(userId), input);
});
ipcMain.handle('relay-ui:resetPassword', (_event, userId, password) => requireRelay().resetManagedUserPassword(String(userId), String(password)));
ipcMain.handle('relay-ui:deleteUser', (_event, userId) => requireRelay().deleteManagedUser(String(userId)));
ipcMain.handle('relay-ui:reviewPasswordReset', (_event, requestId, approve) => requireRelay().reviewManagedPasswordReset(String(requestId), Boolean(approve)));
ipcMain.handle('relay-ui:setAnnouncementTtl', (_event, ttlMs) => requireRelay().setAnnouncementExpiryPolicy(Number(ttlMs)));
ipcMain.handle('relay-ui:setAnnouncementExpiry', (_event, messageId, expiresAt) => requireRelay().setActiveAnnouncementExpiry(String(messageId), Number(expiresAt)));
ipcMain.handle('relay-ui:configureCalendar', (_event, input) => requireRelay().configureCalendarAutomation(input));
ipcMain.handle('relay-ui:refreshCalendar', () => requireRelay().runCalendarAutomationNow());
ipcMain.handle('relay-ui:importStickers', async (_event, rawInput) => {
  const source = rawInput && typeof rawInput === 'object' ? rawInput as Record<string, unknown> : {};
  const options: OpenDialogOptions = {
    title: 'Adicionar GIFs ao Relay',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Imagens GIF', extensions: ['gif'] }]
  };
  const selected = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (selected.canceled || selected.filePaths.length === 0) return { canceled: true, added: [], replaced: [] };
  return {
    canceled: false,
    ...requireRelay().addManagedStickers({
      sourcePaths: selected.filePaths,
      category: String(source.category || ''),
      replaceExisting: source.replaceExisting === true
    })
  };
});
ipcMain.handle('relay-ui:updateSticker', (_event, relativePath, input) =>
  requireRelay().updateManagedSticker(String(relativePath), input));
ipcMain.handle('relay-ui:removeSticker', (_event, relativePath) =>
  requireRelay().removeManagedSticker(String(relativePath)));
ipcMain.handle('relay-ui:stickerPreview', (_event, relativePath) =>
  requireRelay().getManagedStickerPreview(String(relativePath)));
ipcMain.handle('relay-ui:openDashboard', async () => {
  if (!relay) throw new Error('Inicie o Relay antes de abrir a administração.');
  const settings = loadSettings();
  const protocol = settings.tlsCertFile && settings.tlsKeyFile ? 'https' : 'http';
  await shell.openExternal(`${protocol}://127.0.0.1:${settings.port}/`);
});
ipcMain.handle('relay-ui:updateSettings', async (_event, value: Partial<RelayUiSettings>) => {
  const previous = loadSettings();
  const next = saveSettings(value);
  const connectionChanged = previous.port !== next.port || previous.tlsCertFile !== next.tlsCertFile || previous.tlsKeyFile !== next.tlsKeyFile;
  return relay && connectionChanged ? restartRelay() : snapshot();
});
const pickPem = async (title: string) => {
  const result = await dialog.showOpenDialog({ title, properties: ['openFile'], filters: [{ name: 'PEM', extensions: ['pem', 'crt', 'cer', 'key'] }] });
  return result.canceled ? null : result.filePaths[0] || null;
};
ipcMain.handle('relay-ui:pickCertificate', () => pickPem('Selecionar certificado TLS'));
ipcMain.handle('relay-ui:pickPrivateKey', () => pickPem('Selecionar chave privada TLS'));
