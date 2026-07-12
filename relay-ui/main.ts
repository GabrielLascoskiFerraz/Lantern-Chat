import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LanternRelay, RelayConfig } from '../relay/main';

interface RelayUiSettings {
  port: number;
  tlsCertFile: string;
  tlsKeyFile: string;
}

let mainWindow: BrowserWindow | null = null;
let relay: LanternRelay | null = null;

const settingsFile = (): string => path.join(app.getPath('userData'), 'relay-ui-settings.json');
const normalizeSettings = (value: Partial<RelayUiSettings>): RelayUiSettings => ({
  port: Number.isFinite(value.port) && Number(value.port) > 0 && Number(value.port) <= 65535
    ? Math.trunc(Number(value.port)) : 43190,
  tlsCertFile: String(value.tlsCertFile || '').trim(),
  tlsKeyFile: String(value.tlsKeyFile || '').trim()
});
const loadSettings = (): RelayUiSettings => {
  try { return normalizeSettings(JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); }
  catch { return normalizeSettings({}); }
};
const saveSettings = (value: Partial<RelayUiSettings>): RelayUiSettings => {
  const next = normalizeSettings({ ...loadSettings(), ...value });
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
};
const localAddresses = (): string[] => Object.values(os.networkInterfaces())
  .flatMap((entries) => entries || [])
  .filter((entry) => entry.family === 'IPv4' && !entry.internal)
  .map((entry) => entry.address)
  .sort();
const snapshot = () => {
  const settings = loadSettings();
  return relay
    ? { running: true, settings, localAddresses: localAddresses(), ...relay.getDashboardSnapshot() }
    : { running: false, settings, localAddresses: localAddresses(), port: settings.port,
        tls: Boolean(settings.tlsCertFile && settings.tlsKeyFile), peersOnline: 0,
        announcementsActive: 0, uptimeMs: 0, centralStore: {}, transferMetrics: null, peers: [] };
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
    width: 820, height: 760, minWidth: 620, minHeight: 600, title: 'Lantern Relay',
    backgroundColor: '#edf2fa', autoHideMenuBar: true,
    icon: path.join(__dirname, '..', '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  void mainWindow.loadFile(path.join(__dirname, '..', '..', 'relay-ui', 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
};

app.whenReady().then(() => { Menu.setApplicationMenu(null); createWindow(); });
app.on('window-all-closed', () => void stopRelay().finally(() => app.quit()));
ipcMain.handle('relay-ui:status', snapshot);
ipcMain.handle('relay-ui:start', startRelay);
ipcMain.handle('relay-ui:stop', stopRelay);
ipcMain.handle('relay-ui:restart', restartRelay);
ipcMain.handle('relay-ui:updateSettings', async (_event, value) => { saveSettings(value); return relay ? restartRelay() : snapshot(); });
const pickPem = async (title: string) => {
  const result = await dialog.showOpenDialog({ title, properties: ['openFile'], filters: [{ name: 'PEM', extensions: ['pem', 'crt', 'cer', 'key'] }] });
  return result.canceled ? null : result.filePaths[0] || null;
};
ipcMain.handle('relay-ui:pickCertificate', () => pickPem('Selecionar certificado TLS'));
ipcMain.handle('relay-ui:pickPrivateKey', () => pickPem('Selecionar chave privada TLS'));
