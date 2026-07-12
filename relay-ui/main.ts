import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

type RelayRuntime = typeof import('../relay/main');

interface RelayUiSettings {
  port: number;
  announcementTtlHours: number;
}

let mainWindow: BrowserWindow | null = null;
let relay: InstanceType<RelayRuntime['LanternRelay']> | null = null;
let relayModule: RelayRuntime | null = null;

const SETTINGS_FILE = (): string => path.join(app.getPath('userData'), 'relay-ui-settings.json');
const DATA_DIR = (): string => app.getPath('userData');

const normalizeSettings = (value: Partial<RelayUiSettings>): RelayUiSettings => ({
  port: Number.isFinite(value.port) && Number(value.port) > 0 && Number(value.port) <= 65535
    ? Math.trunc(Number(value.port))
    : 43190,
  announcementTtlHours: Number.isFinite(value.announcementTtlHours)
    ? Math.min(168, Math.max(1, Number(value.announcementTtlHours)))
    : 24
});

const loadSettings = (): RelayUiSettings => {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) as Partial<RelayUiSettings>);
  } catch {
    return { port: 43190, announcementTtlHours: 24 };
  }
};

const saveSettings = (settings: RelayUiSettings): RelayUiSettings => {
  const normalized = normalizeSettings(settings);
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(normalized, null, 2));
  return normalized;
};

const loadRelayModule = (): RelayRuntime => {
  if (relayModule) return relayModule;
  process.env.LANTERN_RELAY_ANNOUNCEMENTS_FILE = path.join(DATA_DIR(), 'announcements.json');
  process.env.LANTERN_RELAY_GROUPS_FILE = path.join(DATA_DIR(), 'groups.json');
  process.env.LANTERN_RELAY_GROUP_ATTACHMENTS_DIR = path.join(DATA_DIR(), 'group-attachments');
  process.env.LANTERN_RELAY_STICKERS_DIR = path.join(DATA_DIR(), 'stickers');
  // The Relay is loaded only after the data paths above are set.
  relayModule = require('../relay/main') as RelayRuntime;
  return relayModule;
};

const getSnapshot = () => {
  const settings = loadSettings();
  if (!relay) {
    return {
      running: false,
      settings,
      now: Date.now(),
      peers: [],
      peersOnline: 0,
      localAddresses: [],
      port: settings.port,
      announcementsActive: 0,
      stickersAvailable: 0,
      uptimeMs: 0,
      transferMetrics: null
    };
  }
  return { running: true, settings, ...relay.getDashboardSnapshot() };
};

const startRelay = async (): Promise<ReturnType<typeof getSnapshot>> => {
  if (relay) return getSnapshot();
  const settings = loadSettings();
  const runtime = loadRelayModule();
  relay = new runtime.LanternRelay({
    host: '0.0.0.0',
    port: settings.port,
    pingIntervalMs: 5_000,
    peerTimeoutMs: 30_000,
    presenceBroadcastIntervalMs: 12_000,
    maxPayloadBytes: 8 * 1024 * 1024,
    announcementTtlMs: settings.announcementTtlHours * 60 * 60 * 1000
  });
  try {
    await relay.start();
    return getSnapshot();
  } catch (error) {
    relay = null;
    throw error;
  }
};

const stopRelay = async (): Promise<ReturnType<typeof getSnapshot>> => {
  if (!relay) return getSnapshot();
  const current = relay;
  relay = null;
  await current.stop('relay-ui-stop');
  return getSnapshot();
};

const restartRelay = async (): Promise<ReturnType<typeof getSnapshot>> => {
  await stopRelay();
  return startRelay();
};

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 680,
    minWidth: 620,
    minHeight: 560,
    title: 'Lantern Relay',
    backgroundColor: '#edf2fa',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  if (process.platform === 'win32') mainWindow.setMenuBarVisibility(false);
  void mainWindow.loadFile(path.join(__dirname, '..', '..', 'relay-ui', 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  createWindow();
  try {
    await startRelay();
  } catch (error) {
    console.error('[LanternRelay UI] Failed to start Relay:', error);
  }
});

app.on('window-all-closed', () => {
  void stopRelay().finally(() => app.quit());
});

app.on('before-quit', (event) => {
  if (!relay) return;
  event.preventDefault();
  void stopRelay().finally(() => app.exit(0));
});

ipcMain.handle('relay-ui:status', () => getSnapshot());
ipcMain.handle('relay-ui:start', () => startRelay());
ipcMain.handle('relay-ui:stop', () => stopRelay());
ipcMain.handle('relay-ui:restart', () => restartRelay());
ipcMain.handle('relay-ui:updateSettings', async (_event, input: Partial<RelayUiSettings>) => {
  const next = saveSettings({ ...loadSettings(), ...input });
  if (relay && input.announcementTtlHours !== undefined) {
    relay.setAnnouncementTtlHours(next.announcementTtlHours);
  }
  if (relay && input.port !== undefined && next.port !== relay.getConfig().port) {
    return restartRelay();
  }
  return getSnapshot();
});
