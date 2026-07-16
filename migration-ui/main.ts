import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface MigrationInput {
  backupsDir?: string; outputDir?: string; mappingFile?: string; reportFile?: string;
  convert?: boolean; allowMissingUsers?: boolean; allowMissingAttachments?: boolean;
}

let mainWindow: BrowserWindow | null = null;
let running = false;
const clean = (value: unknown): string => String(value || '').trim();
const engineFile = (): string => {
  const candidates = [
    path.join(process.resourcesPath, 'app.asar', 'dist-relay', 'migrateLocalBackups.js'),
    path.join(process.resourcesPath, 'app', 'dist-relay', 'migrateLocalBackups.js'),
    path.resolve(__dirname, '..', '..', 'dist-relay', 'migrateLocalBackups.js')
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('O motor de migração não foi encontrado. Reinstale o Lantern Migration.');
  return found;
};
const chooseDirectory = async (title: string) => {
  const result = await dialog.showOpenDialog({ title, properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0] || null;
};
const chooseFile = async () => {
  const result = await dialog.showOpenDialog({ title: 'Selecionar mapeamento de contas', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  return result.canceled ? null : result.filePaths[0] || null;
};
const chooseReport = async () => {
  const result = await dialog.showSaveDialog({ title: 'Salvar relatório da migração', defaultPath: `lantern-migration-report-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
  return result.canceled ? null : result.filePath || null;
};

const runMigration = async (_event: Electron.IpcMainInvokeEvent, raw: MigrationInput) => {
  if (running) throw new Error('Já existe uma migração em andamento.');
  const input = raw || {};
  const backupsDir = path.resolve(clean(input.backupsDir));
  const outputDir = clean(input.outputDir) ? path.resolve(clean(input.outputDir)) : '';
  const reportFile = clean(input.reportFile) ? path.resolve(clean(input.reportFile)) : path.join(app.getPath('documents'), `lantern-migration-report-${Date.now()}.json`);
  if (!clean(input.backupsDir) || !fs.statSync(backupsDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Selecione uma pasta válida com os backups.');
  if (input.convert && !outputDir) {
    throw new Error('Selecione onde o backup convertido será salvo.');
  }
  const args = [engineFile(), '--backups', backupsDir, '--report', reportFile];
  if (input.convert) args.push('--output', outputDir, '--convert');
  const mapping = clean(input.mappingFile);
  if (mapping) args.push('--mapping', path.resolve(mapping));
  if (input.allowMissingUsers) args.push('--allow-missing-users');
  if (input.allowMissingAttachments) args.push('--allow-missing-attachments');
  running = true;
  mainWindow?.webContents.send(
    'migration-ui:output',
    `\n${input.convert ? 'Gerando backup convertido' : 'Analisando backups'}...\n`
  );
  try {
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk) => { const text = String(chunk); stdout += text; mainWindow?.webContents.send('migration-ui:output', text); });
      child.stderr.on('data', (chunk) => { const text = String(chunk); stderr += text; mainWindow?.webContents.send('migration-ui:output', text); });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
    let report: unknown = null;
    try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch { /* detailed process output remains visible */ }
    return { ...result, ok: result.code === 0, reportFile, report };
  } finally { running = false; }
};

const createWindow = () => {
  mainWindow = new BrowserWindow({ width: 1120, height: 820, minWidth: 680, minHeight: 620, title: 'Conversor de backups do Lantern', backgroundColor: '#f5f7fb', autoHideMenuBar: true, icon: path.join(__dirname, '..', '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  void mainWindow.loadFile(path.join(__dirname, '..', '..', 'migration-ui', 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
};

app.whenReady().then(() => { Menu.setApplicationMenu(null); createWindow(); });
app.on('window-all-closed', () => app.quit());
ipcMain.handle('migration-ui:pickBackups', () => chooseDirectory('Pasta que contém todos os backups'));
ipcMain.handle('migration-ui:pickOutput', () => chooseDirectory('Onde salvar o backup convertido'));
ipcMain.handle('migration-ui:pickMapping', chooseFile);
ipcMain.handle('migration-ui:pickReport', chooseReport);
ipcMain.handle('migration-ui:run', runMigration);
ipcMain.handle('migration-ui:openPath', async (_event, target) => { const value = clean(target); if (!value) return; const error = await shell.openPath(value); if (error) shell.showItemInFolder(value); });
