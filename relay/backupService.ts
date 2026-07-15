import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface BackupSource {
  name: string;
  source: string;
}

export interface CanonicalBackup {
  file: string;
  databaseFile: string;
  createdAt: number;
  size: number;
  files: number;
}

interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

const walkFiles = (root: string, current = root): string[] => {
  if (!fs.existsSync(current)) return [];
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(current, entry.name);
    return entry.isDirectory() ? walkFiles(root, fullPath) : [fullPath];
  });
};

export class BackupService {
  constructor(
    private readonly centralDir: string,
    private readonly backupDatabase: (destination: string) => Promise<void>
  ) {}

  async create(sources: BackupSource[] = []): Promise<CanonicalBackup> {
    const createdAt = Date.now();
    const backupRoot = path.join(this.centralDir, 'backups');
    const stamp = new Date(createdAt).toISOString().replace(/[:.]/g, '-');
    const bundle = path.join(backupRoot, `lantern-relay-${stamp}`);
    const centralTarget = path.join(bundle, 'central');
    fs.mkdirSync(centralTarget, { recursive: true });

    const databaseFile = path.join(centralTarget, 'lantern-relay.db');
    await this.backupDatabase(databaseFile);
    const masterKey = path.join(this.centralDir, 'master.key');
    if (!fs.existsSync(masterKey)) throw new Error('Chave mestra do Relay não encontrada.');
    fs.copyFileSync(masterKey, path.join(centralTarget, 'master.key'));

    const centralAttachments = path.join(this.centralDir, 'attachments');
    if (fs.existsSync(centralAttachments)) {
      fs.cpSync(centralAttachments, path.join(centralTarget, 'attachments'), { recursive: true });
    }
    for (const source of sources) {
      if (!source.name.trim() || !fs.existsSync(source.source)) continue;
      fs.cpSync(source.source, path.join(bundle, source.name), { recursive: true });
    }

    const manifestFiles: ManifestFile[] = walkFiles(bundle).map((file) => {
      const contents = fs.readFileSync(file);
      return {
        path: path.relative(bundle, file),
        size: contents.byteLength,
        sha256: createHash('sha256').update(contents).digest('hex')
      };
    });
    const size = manifestFiles.reduce((total, entry) => total + entry.size, 0);
    fs.writeFileSync(
      path.join(bundle, 'manifest.json'),
      `${JSON.stringify({ version: 1, createdAt, files: manifestFiles }, null, 2)}\n`,
      { mode: 0o600 }
    );
    return { file: bundle, databaseFile, createdAt, size, files: manifestFiles.length };
  }
}
