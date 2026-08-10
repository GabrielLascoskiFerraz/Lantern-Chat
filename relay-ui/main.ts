import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type OpenDialogOptions } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LanternRelay, RelayConfig } from '../relay/main';
import { validateConvertedBackup } from '../relay/convertedBackup';
import { isUpdatePlatform } from '../relay/updateStore';
import { resolveSharedRelayDataDir } from '../relay/dataPaths';

interface RelayUiSettings {
  port: number;
  localHostname: string;
  tlsCertFile: string;
  tlsKeyFile: string;
  startAtLogin: boolean;
  startRelayOnLaunch: boolean;
}

let mainWindow: BrowserWindow | null = null;
let relay: LanternRelay | null = null;

const settingsFile = (): string => path.join(app.getPath('userData'), 'relay-ui-settings.json');
const relayDataDir = (): string => resolveSharedRelayDataDir();
const importEngineFile = (): string => {
  const candidates = [
    path.resolve(__dirname, '..', 'relay', 'importConvertedBackup.js'),
    path.resolve(__dirname, '..', '..', 'dist-relay', 'importConvertedBackup.js')
  ];
  const engine = candidates.find((candidate) => fs.existsSync(candidate));
  if (!engine) throw new Error('O mecanismo de importação não foi encontrado. Reinstale o Lantern Relay.');
  return engine;
};
const runConvertedBackupImport = (bundlePath: string): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      importEngineFile(),
      '--backup', bundlePath,
      '--relay-data', relayDataDir()
    ], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || 'O backup não pôde ser importado.'));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>);
      } catch {
        reject(new Error('O mecanismo de importação retornou uma resposta inválida.'));
      }
    });
  });
const normalizeSettings = (value: Partial<RelayUiSettings>): RelayUiSettings => ({
  port: Number.isFinite(value.port) && Number(value.port) > 0 && Number(value.port) <= 65535
    ? Math.trunc(Number(value.port)) : 43190,
  localHostname: (() => {
    const raw = String(value.localHostname || 'lantern-relay.local').trim().toLowerCase().replace(/\.+$/, '');
    const label = raw.endsWith('.local') ? raw.slice(0, -6) : raw;
    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ? `${label}.local` : 'lantern-relay.local';
  })(),
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
const directorySizeBytes = (root: string): number => {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) {
        try { total += fs.statSync(entryPath).size; }
        catch { /* Arquivo temporário removido durante a medição. */ }
      }
    }
  }
  return total;
};
const snapshot = () => {
  const settings = loadSettings();
  return relay
    ? { running: true, settings, loginItemSupported: loginItemSupported(), localAddresses: localAddresses(), ...relay.getDashboardSnapshot() }
    : { running: false, version: app.getVersion(), settings, loginItemSupported: loginItemSupported(), localAddresses: localAddresses(), port: settings.port,
        tls: Boolean(settings.tlsCertFile && settings.tlsKeyFile), peersOnline: 0,
        announcementsActive: 0, uptimeMs: 0, centralStore: {}, transferMetrics: null,
        reliabilityMetrics: null, peers: [], totalStorageBytes: directorySizeBytes(relayDataDir()) };
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
  process.env.LANTERN_RELAY_DATA_DIR = relayDataDir();
  // O renderer Web é distribuído como recurso externo para que o servidor HTTP
  // consiga transmiti-lo sem depender do cwd nem de caminhos internos do ASAR.
  process.env.LANTERN_WEB_CLIENT_DIR = path.join(process.resourcesPath, 'dist-renderer');
  const runtime = require('../relay/main') as typeof import('../relay/main');
  const config: RelayConfig = {
    host: '0.0.0.0', port: settings.port, localHostname: settings.localHostname, pingIntervalMs: 5_000, peerTimeoutMs: 30_000,
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
ipcMain.handle('relay-ui:selectConvertedBackup', async () => {
  const openOptions: OpenDialogOptions = {
    title: 'Selecionar backup do Lantern Relay',
    buttonLabel: 'Selecionar backup',
    properties: ['openDirectory']
  };
  const selection = mainWindow
    ? await dialog.showOpenDialog(mainWindow, openOptions)
    : await dialog.showOpenDialog(openOptions);
  if (selection.canceled || !selection.filePaths[0]) return { canceled: true };
  const bundlePath = selection.filePaths[0];
  const manifest = validateConvertedBackup(bundlePath);
  const counts = manifest.counts || {};
  return {
    canceled: false,
    bundlePath,
    name: path.basename(bundlePath),
    counts: {
      users: Number(counts.users || 0),
      directMessages: Number(counts.directMessages || 0),
      groups: Number(counts.groups || 0),
      directAttachments: Number(counts.directAttachments || 0),
      groupAttachments: Number(counts.groupAttachments || 0)
    }
  };
});

ipcMain.handle('relay-ui:importConvertedBackup', async (_event, rawBundlePath) => {
  const inputPath = String(rawBundlePath || '').trim();
  if (!inputPath) throw new Error('Selecione novamente a pasta do backup que será importado.');
  const bundlePath = path.resolve(inputPath);
  if (!fs.statSync(bundlePath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('A pasta do backup selecionado não está mais disponível.');
  }
  validateConvertedBackup(bundlePath);

  const wasRunning = Boolean(relay);
  if (wasRunning) await stopRelay();
  try {
    const result = await runConvertedBackupImport(bundlePath) as {
      manifest: ReturnType<typeof validateConvertedBackup>;
      stats: Record<string, unknown>;
      rollbackDir: string | null;
      importedAt: number;
      source: string;
    };
    // A restauração é feita com o Relay parado para liberar o banco, mas o
    // resultado precisa ser aberto imediatamente. Caso contrário, em uma
    // instalação nova o painel permanece com as métricas vazias e faz parecer
    // que a importação não teve efeito, embora os arquivos já estejam no disco.
    const state = await startRelay();
    return {
      canceled: false,
      stats: result.stats,
      rollbackDir: result.rollbackDir,
      importedAt: result.importedAt,
      source: result.source,
      credentialsFile: result.manifest.credentialsFile
        ? path.join(bundlePath, result.manifest.credentialsFile)
        : null,
      restarted: true,
      state
    };
  } catch (error) {
    if (wasRunning) await startRelay().catch(() => undefined);
    throw error;
  }
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
ipcMain.handle('relay-ui:selectUpdateInstaller', async (_event, rawPlatform) => {
  if (!isUpdatePlatform(rawPlatform)) throw new Error('Sistema operacional inválido.');
  const extensions = rawPlatform === 'win32' ? ['exe'] : rawPlatform === 'darwin' ? ['dmg'] : ['AppImage', 'appimage'];
  const result = await dialog.showOpenDialog({
    title: 'Selecionar instalador do Lantern',
    properties: ['openFile'],
    filters: [{ name: 'Instalador do Lantern', extensions }]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  return { canceled: false, updates: requireRelay().setManagedUpdateInstaller(rawPlatform, result.filePaths[0]) };
});
ipcMain.handle('relay-ui:removeUpdateInstaller', (_event, rawPlatform) => {
  if (!isUpdatePlatform(rawPlatform)) throw new Error('Sistema operacional inválido.');
  return requireRelay().removeManagedUpdateInstaller(rawPlatform);
});
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
  const connectionChanged = previous.port !== next.port || previous.localHostname !== next.localHostname || previous.tlsCertFile !== next.tlsCertFile || previous.tlsKeyFile !== next.tlsKeyFile;
  return relay && connectionChanged ? restartRelay() : snapshot();
});
const pickPem = async (title: string) => {
  const result = await dialog.showOpenDialog({ title, properties: ['openFile'], filters: [{ name: 'PEM', extensions: ['pem', 'crt', 'cer', 'key'] }] });
  return result.canceled ? null : result.filePaths[0] || null;
};
ipcMain.handle('relay-ui:pickCertificate', () => pickPem('Selecionar certificado TLS'));
ipcMain.handle('relay-ui:pickPrivateKey', () => pickPem('Selecionar chave privada TLS'));
