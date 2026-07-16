import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { AuthService } from './authService';
import { AppUpdateState, UpdateInstallerInfo } from './types';

const supportedPlatform = (): 'win32' | 'darwin' | 'linux' | null =>
  process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux'
    ? process.platform
    : null;

export class UpdateService {
  private state: AppUpdateState = { supported: true, status: 'idle', currentVersion: app.getVersion(), relayVersion: null, downloaded: 0, total: 0, error: null };
  private running: Promise<AppUpdateState> | null = null;

  constructor(
    private readonly auth: AuthService,
    private readonly emit: (state: AppUpdateState) => void
  ) {}

  getState(): AppUpdateState {
    return { ...this.state, installer: this.state.installer ? { ...this.state.installer } : undefined };
  }

  check(force = false): Promise<AppUpdateState> {
    if (this.running) return this.running;
    this.running = this.checkAndDownload(force).finally(() => { this.running = null; });
    return this.running;
  }

  async install(): Promise<void> {
    if (this.state.status !== 'ready' || !this.state.installer?.localPath) throw new Error('A atualização ainda não terminou de baixar.');
    const installer = this.state.installer;
    const installerPath = String(installer.localPath);
    if (!fs.existsSync(installerPath)) throw new Error('O instalador baixado não foi encontrado. Baixe novamente.');
    const launch = (command: string, args: string[], windowsHide = false): Promise<void> => new Promise((resolve, reject) => {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    if (installer.platform === 'win32') {
      await launch(installerPath, [], false);
    } else if (installer.platform === 'darwin') {
      await launch('open', [installerPath]);
    } else {
      fs.chmodSync(installerPath, 0o755);
      await launch(installerPath, []);
    }
    this.setState({ ...this.state, status: 'installing' });
    setTimeout(() => app.quit(), 250);
  }

  private async checkAndDownload(force: boolean): Promise<AppUpdateState> {
    const platform = supportedPlatform();
    const context = this.auth.getUpdateRequestContext();
    if (!platform || !context) return this.getState();
    this.setState({ ...this.state, status: 'checking', error: null });
    let relayVersion: string | null = null;
    let installer: UpdateInstallerInfo | null = null;
    try {
      const response = await fetch(`${context.baseUrl}/api/client/update?platform=${platform}`, {
        headers: { authorization: `Bearer ${context.token}` }, cache: 'no-store'
      });
      const body = await response.json().catch(() => ({})) as { version?: string; installer?: UpdateInstallerInfo | null; message?: string };
      if (!response.ok) throw new Error(body.message || 'Não foi possível consultar atualizações.');
      relayVersion = typeof body.version === 'string' ? body.version : null;
      installer = body.installer || null;
      if (installer && installer.platform !== platform) throw new Error('O Relay retornou um instalador de outra plataforma.');
      if (!relayVersion || !installer || (!force && relayVersion === app.getVersion())) {
        this.setState({ supported: true, status: 'idle', currentVersion: app.getVersion(), relayVersion, downloaded: 0, total: 0, error: null });
        return this.getState();
      }
      return await this.download(context.baseUrl, context.token, relayVersion, installer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (relayVersion && installer) {
        this.setState({ supported: true, status: 'error', currentVersion: app.getVersion(), relayVersion, installer, downloaded: 0, total: installer.size, error: message });
      } else {
        this.setState({ supported: true, status: 'idle', currentVersion: app.getVersion(), relayVersion, downloaded: 0, total: 0, error: null });
      }
      return this.getState();
    }
  }

  private async download(baseUrl: string, token: string, relayVersion: string, installer: UpdateInstallerInfo): Promise<AppUpdateState> {
    const directory = path.join(app.getPath('userData'), 'updates', relayVersion);
    fs.mkdirSync(directory, { recursive: true });
    const safeName = path.basename(installer.fileName);
    const temporary = path.join(directory, `${safeName}.download`);
    const target = path.join(directory, safeName);
    fs.rmSync(temporary, { force: true });
    this.setState({ supported: true, status: 'downloading', currentVersion: app.getVersion(), relayVersion, installer, downloaded: 0, total: installer.size, error: null });
    let output: fs.WriteStream | null = null;
    try {
      const response = await fetch(`${baseUrl}/api/client/update/download/${installer.platform}`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store'
      });
      if (!response.ok || !response.body) throw new Error(`O Relay recusou o download (${response.status}).`);
      output = fs.createWriteStream(temporary, { flags: 'w', mode: 0o600 });
      let outputError: Error | null = null;
      output.on('error', (error) => { outputError = error; });
      const reader = response.body.getReader();
      let downloaded = 0;
      let lastProgressAt = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const chunk = Buffer.from(value);
        downloaded += chunk.length;
        if (downloaded > installer.size) throw new Error('O instalador recebido excede o tamanho informado.');
        if (!output.write(chunk)) await new Promise<void>((resolve) => {
          output!.once('drain', resolve);
          output!.once('error', () => resolve());
        });
        if (outputError) throw outputError;
        if (Date.now() - lastProgressAt >= 100 || downloaded === installer.size) {
          lastProgressAt = Date.now();
          this.setState({ ...this.state, downloaded });
        }
      }
      await new Promise<void>((resolve) => {
        output!.once('error', () => resolve());
        output!.end(resolve);
      });
      if (outputError) throw outputError;
      output = null;
      if (downloaded !== installer.size) throw new Error('O download terminou incompleto.');
      const sha256 = await this.hashFile(temporary);
      if (sha256 !== installer.sha256) throw new Error('A verificação de integridade do instalador falhou.');
      fs.rmSync(target, { force: true });
      fs.renameSync(temporary, target);
      this.setState({ ...this.state, status: 'ready', installer: { ...installer, localPath: target }, downloaded, total: downloaded, error: null });
      return this.getState();
    } catch (error) {
      if (output) {
        const pendingOutput = output;
        await new Promise<void>((resolve) => {
          pendingOutput.once('close', resolve);
          pendingOutput.destroy();
        });
      }
      fs.rmSync(temporary, { force: true });
      this.setState({ ...this.state, status: 'error', error: error instanceof Error ? error.message : String(error) });
      return this.getState();
    }
  }

  private hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const input = fs.createReadStream(filePath);
      input.on('data', (chunk) => hash.update(chunk));
      input.once('error', reject);
      input.once('end', () => resolve(hash.digest('hex')));
    });
  }

  private setState(state: AppUpdateState): void {
    this.state = state;
    this.emit(this.getState());
  }
}
