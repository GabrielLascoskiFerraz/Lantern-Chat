import fs from 'node:fs';
import path from 'node:path';
import {
  RelayBackupManifest,
  resolveBackupAppVersion,
  validateRelayBackup,
  writeRelayBackupManifest
} from './backupFormat';

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
  manifest: RelayBackupManifest;
}

export interface BackupMetadata {
  counts?: Record<string, number>;
  appVersion?: string | null;
}

const RESERVED_SOURCE_NAMES = new Set(['central', 'manifest.json']);

const normalizeBackupSources = (sources: BackupSource[]): BackupSource[] => {
  const names = new Set<string>();
  return sources.map((source) => {
    const name = source.name.trim();
    if (
      !name ||
      name === '.' ||
      name === '..' ||
      path.isAbsolute(name) ||
      name.includes('/') ||
      name.includes('\\') ||
      RESERVED_SOURCE_NAMES.has(name.toLowerCase())
    ) {
      throw new Error(`Nome de recurso inválido para backup: ${source.name || '(vazio)'}.`);
    }
    if (names.has(name.toLowerCase())) {
      throw new Error(`Recurso duplicado no backup: ${name}.`);
    }
    names.add(name.toLowerCase());
    const sourcePath = path.resolve(source.source);
    const stat = fs.statSync(sourcePath, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) {
      throw new Error(`O recurso ${name} não é uma pasta válida.`);
    }
    return { name, source: sourcePath };
  });
};

export class BackupService {
  constructor(
    private readonly centralDir: string,
    private readonly backupDatabase: (destination: string) => Promise<void>,
    private readonly writeMasterKey: (destination: string) => void
  ) {}

  async create(sources: BackupSource[] = [], metadata: BackupMetadata = {}): Promise<CanonicalBackup> {
    const createdAt = Date.now();
    const normalizedSources = normalizeBackupSources(sources);
    const backupRoot = path.join(this.centralDir, 'backups');
    const stamp = new Date(createdAt).toISOString().replace(/[:.]/g, '-');
    const bundle = path.join(backupRoot, `lantern-relay-${stamp}`);
    const staging = `${bundle}.tmp`;
    fs.mkdirSync(backupRoot, { recursive: true });
    fs.rmSync(staging, { recursive: true, force: true });
    if (fs.existsSync(bundle)) throw new Error(`Já existe um backup em ${bundle}.`);

    try {
      const centralTarget = path.join(staging, 'central');
      fs.mkdirSync(centralTarget, { recursive: true });
      const stagedDatabaseFile = path.join(centralTarget, 'lantern-relay.db');
      await this.backupDatabase(stagedDatabaseFile);
      this.writeMasterKey(path.join(centralTarget, 'master.key'));

      const centralAttachments = path.join(this.centralDir, 'attachments');
      if (fs.existsSync(centralAttachments)) {
        fs.cpSync(centralAttachments, path.join(centralTarget, 'attachments'), {
          recursive: true,
          dereference: false
        });
      }
      for (const source of normalizedSources) {
        if (!fs.existsSync(source.source)) continue;
        fs.cpSync(source.source, path.join(staging, source.name), {
          recursive: true,
          dereference: false
        });
      }

      const manifest = writeRelayBackupManifest(staging, {
        createdAt,
        source: 'lantern-relay',
        counts: metadata.counts,
        warnings: [],
        appVersion: metadata.appVersion ?? resolveBackupAppVersion()
      });
      validateRelayBackup(staging);
      fs.renameSync(staging, bundle);
      return {
        file: bundle,
        databaseFile: path.join(bundle, 'central', 'lantern-relay.db'),
        createdAt,
        size: manifest.files.reduce((total, entry) => total + entry.size, 0),
        files: manifest.files.length,
        manifest
      };
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
}
