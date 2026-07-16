import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type UpdatePlatform = 'win32' | 'darwin' | 'linux';

export interface UpdateInstaller {
  platform: UpdatePlatform;
  fileName: string;
  size: number;
  sha256: string;
  updatedAt: number;
}

export interface UpdateManifest {
  version: string;
  installers: Partial<Record<UpdatePlatform, UpdateInstaller>>;
}

const EXTENSIONS: Record<UpdatePlatform, RegExp> = {
  win32: /\.exe$/i,
  darwin: /\.dmg$/i,
  linux: /\.appimage$/i
};

const normalizeFileName = (value: string): string =>
  Array.from(path.basename(String(value || '').trim()))
    .filter((character) => character.charCodeAt(0) >= 32)
    .join('')
    .slice(0, 240);

const hashFile = (filePath: string): string => {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read = 0;
    do {
      read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read > 0) hash.update(buffer.subarray(0, read));
    } while (read > 0);
    return hash.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
};

export class UpdateStore {
  private readonly directory: string;
  private readonly manifestFile: string;

  constructor(dataDirectory: string, private readonly version: string) {
    this.directory = path.join(dataDirectory, 'updates');
    this.manifestFile = path.join(this.directory, 'manifest.json');
    fs.mkdirSync(this.directory, { recursive: true });
    for (const name of fs.readdirSync(this.directory)) {
      if (name.startsWith('.') && (name.endsWith('.tmp') || name.endsWith('.previous'))) {
        fs.rmSync(path.join(this.directory, name), { force: true });
      }
    }
  }

  getManifest(): UpdateManifest {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.manifestFile, 'utf8')) as UpdateManifest;
      const installers: Partial<Record<UpdatePlatform, UpdateInstaller>> = {};
      for (const platform of ['win32', 'darwin', 'linux'] as const) {
        const item = parsed.installers?.[platform];
        if (!item || item.platform !== platform || !EXTENSIONS[platform].test(item.fileName)) continue;
        const filePath = this.getInstallerPath(platform, item.fileName);
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
        installers[platform] = item;
      }
      return { version: this.version, installers };
    } catch {
      return { version: this.version, installers: {} };
    }
  }

  importInstaller(platform: UpdatePlatform, sourcePath: string, requestedName?: string): UpdateInstaller {
    const fileName = normalizeFileName(requestedName || sourcePath);
    if (!fileName || !EXTENSIONS[platform].test(fileName)) {
      const expected = platform === 'win32' ? '.exe' : platform === 'darwin' ? '.dmg' : '.AppImage';
      throw new Error(`Selecione um instalador ${expected} válido.`);
    }
    const source = path.resolve(sourcePath);
    const sourceStat = fs.statSync(source);
    if (!sourceStat.isFile() || sourceStat.size <= 0 || sourceStat.size > 2 * 1024 * 1024 * 1024) {
      throw new Error('O instalador selecionado está vazio, é inválido ou excede 2 GB.');
    }

    fs.mkdirSync(this.directory, { recursive: true });
    const temporary = path.join(this.directory, `.${platform}-${randomUUID()}.tmp`);
    const targetName = `${platform}${path.extname(fileName)}`;
    const target = path.join(this.directory, targetName);
    const manifest = this.getManifest();
    const previous = manifest.installers[platform];
    const previousManifest: UpdateManifest = { version: manifest.version, installers: { ...manifest.installers } };
    const backup = `${target}.${randomUUID()}.previous`;
    let targetBackedUp = false;
    try {
      fs.copyFileSync(source, temporary);
      const sha256 = hashFile(temporary);
      const size = fs.statSync(temporary).size;
      if (fs.existsSync(target)) {
        fs.renameSync(target, backup);
        targetBackedUp = true;
      }
      fs.renameSync(temporary, target);
      const installer: UpdateInstaller = { platform, fileName, size, sha256, updatedAt: Date.now() };
      manifest.installers[platform] = installer;
      this.writeManifest(manifest);
      fs.rmSync(backup, { force: true });
      if (previous) {
        const oldPath = this.getInstallerPath(platform, previous.fileName);
        if (oldPath !== target) fs.rmSync(oldPath, { force: true });
      }
      return installer;
    } catch (error) {
      fs.rmSync(target, { force: true });
      if (targetBackedUp && fs.existsSync(backup)) fs.renameSync(backup, target);
      this.writeManifest(previousManifest);
      throw error;
    } finally {
      fs.rmSync(temporary, { force: true });
      fs.rmSync(backup, { force: true });
    }
  }

  removeInstaller(platform: UpdatePlatform): void {
    const manifest = this.getManifest();
    const existing = manifest.installers[platform];
    delete manifest.installers[platform];
    this.writeManifest(manifest);
    if (existing) fs.rmSync(this.getInstallerPath(platform, existing.fileName), { force: true });
  }

  getInstaller(platform: UpdatePlatform): { metadata: UpdateInstaller; filePath: string } | null {
    const metadata = this.getManifest().installers[platform];
    if (!metadata) return null;
    return { metadata, filePath: this.getInstallerPath(platform, metadata.fileName) };
  }

  private getInstallerPath(platform: UpdatePlatform, originalName: string): string {
    return path.join(this.directory, `${platform}${path.extname(originalName)}`);
  }

  private writeManifest(manifest: UpdateManifest): void {
    const temporary = `${this.manifestFile}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ version: this.version, installers: manifest.installers }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.manifestFile);
  }
}

export const isUpdatePlatform = (value: unknown): value is UpdatePlatform =>
  value === 'win32' || value === 'darwin' || value === 'linux';
