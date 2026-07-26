import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CentralStore } from './centralStore';
import { EncryptedChunkStore } from './encryptedChunkStore';
import { RelayGroupAttachmentMetadata } from './groupTypes';
import {
  LEGACY_CONVERTED_BACKUP_KIND,
  RELAY_BACKUP_KIND,
  RELAY_BACKUP_VERSION,
  RelayBackupFile,
  RelayBackupManifest,
  readRelayBackupManifest,
  resolveBackupAppVersion,
  validateRelayBackup,
  writeRelayBackupManifest
} from './backupFormat';

// Nomes públicos mantidos para não quebrar integrações e scripts existentes.
export const CONVERTED_BACKUP_KIND = RELAY_BACKUP_KIND;
export const CONVERTED_BACKUP_VERSION = RELAY_BACKUP_VERSION;
export { LEGACY_CONVERTED_BACKUP_KIND };
export type ConvertedBackupFile = RelayBackupFile;
export type ConvertedBackupManifest = RelayBackupManifest;

export interface ConvertedBackupResult {
  file: string;
  createdAt: number;
  size: number;
  files: number;
  manifest: ConvertedBackupManifest;
}

export const createConvertedBackup = (input: {
  sourceRelayDataDir: string;
  outputDir: string;
  counts: Record<string, number>;
  warnings: string[];
  credentials: unknown[];
  appVersion?: string | null;
}): ConvertedBackupResult => {
  const source = path.resolve(input.sourceRelayDataDir);
  const output = path.resolve(input.outputDir);
  const centralSource = path.join(source, 'central');
  if (!fs.statSync(path.join(centralSource, 'lantern-relay.db'), { throwIfNoEntry: false })?.isFile()) {
    throw new Error('O banco canônico convertido não foi criado corretamente.');
  }
  if (!fs.statSync(path.join(centralSource, 'master.key'), { throwIfNoEntry: false })?.isFile()) {
    throw new Error('A chave mestra do backup convertido não foi criada.');
  }

  fs.mkdirSync(output, { recursive: true });
  const createdAt = Date.now();
  const stamp = new Date(createdAt).toISOString().replace(/[:.]/g, '-');
  const finalPath = path.join(output, `Lantern-Backup-Convertido-${stamp}`);
  const stagingPath = `${finalPath}.tmp`;
  fs.rmSync(stagingPath, { recursive: true, force: true });
  if (fs.existsSync(finalPath)) throw new Error(`Já existe um backup convertido em ${finalPath}.`);

  try {
    fs.mkdirSync(stagingPath, { recursive: true });
    fs.cpSync(centralSource, path.join(stagingPath, 'central'), {
      recursive: true,
      dereference: false
    });
    const groupAttachments = path.join(source, 'group-attachments');
    if (fs.existsSync(groupAttachments)) {
      fs.cpSync(groupAttachments, path.join(stagingPath, 'group-attachments'), {
        recursive: true,
        dereference: false
      });
    }
    const credentialsFile = 'contas-convertidas.json';
    fs.writeFileSync(
      path.join(stagingPath, credentialsFile),
      `${JSON.stringify({ createdAt, users: input.credentials }, null, 2)}\n`,
      { mode: 0o600 }
    );
    const manifest = writeRelayBackupManifest(stagingPath, {
      createdAt,
      source: 'lantern-local-backups',
      counts: input.counts,
      warnings: input.warnings,
      credentialsFile,
      appVersion: input.appVersion ?? resolveBackupAppVersion()
    });
    validateRelayBackup(stagingPath);
    fs.renameSync(stagingPath, finalPath);
    return {
      file: finalPath,
      createdAt,
      size: manifest.files.reduce((total, file) => total + file.size, 0),
      files: manifest.files.length,
      manifest
    };
  } catch (error) {
    fs.rmSync(stagingPath, { recursive: true, force: true });
    throw error;
  }
};

export const readConvertedBackupManifest = (bundlePath: string): ConvertedBackupManifest =>
  readRelayBackupManifest(bundlePath);

export const validateConvertedBackup = (bundlePath: string): ConvertedBackupManifest =>
  validateRelayBackup(bundlePath);

const validateGroupAttachments = (
  relayDataDir: string,
  store: CentralStore,
  attachments: RelayGroupAttachmentMetadata[]
): void => {
  const chunks = new EncryptedChunkStore(
    path.join(relayDataDir, 'group-attachments'),
    store.getEncryption()
  );
  for (const metadata of attachments) {
    if (!metadata || metadata.deletedAt || !metadata.uploadedAt) continue;
    const expectedChunks = Math.max(1, Math.ceil(metadata.fileSize / (64 * 1024)));
    const target = chunks.directory(metadata.groupId, metadata.fileId, 'chunks');
    const legacy = chunks.directory(metadata.fileId);
    if (!chunks.has(0, metadata.groupId, metadata.fileId, 'chunks') && fs.existsSync(legacy)) {
      fs.mkdirSync(target, { recursive: true });
      for (const entry of fs.readdirSync(legacy, { withFileTypes: true })) {
        if (entry.isFile() && /^\d+\.bin$/.test(entry.name)) {
          fs.copyFileSync(path.join(legacy, entry.name), path.join(target, entry.name));
        }
      }
    }
    const hash = createHash('sha256');
    let size = 0;
    for (let index = 0; index < expectedChunks; index += 1) {
      let chunk: Buffer;
      try {
        chunk = chunks.read(index, metadata.groupId, metadata.fileId, 'chunks');
      } catch {
        throw new Error(`Chunk ${index} ausente ou inválido no anexo de grupo ${metadata.fileId}.`);
      }
      hash.update(chunk);
      size += chunk.length;
    }
    if (size !== metadata.fileSize || hash.digest('hex') !== metadata.sha256) {
      throw new Error(`Integridade inválida no anexo de grupo ${metadata.fileId}.`);
    }
  }
};

export const importConvertedBackup = (input: {
  bundlePath: string;
  relayDataDir: string;
}): {
  importedAt: number;
  source: string;
  rollbackDir: string | null;
  manifest: ConvertedBackupManifest;
  stats: ReturnType<CentralStore['getStats']>;
} => {
  const source = path.resolve(input.bundlePath);
  const destination = path.resolve(input.relayDataDir);
  const manifest = validateRelayBackup(source);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const staging = `${destination}.import-staging-${stamp}`;
  const rollback = `${destination}.pre-import-${stamp}`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.rmSync(staging, { recursive: true, force: true });

  try {
    fs.mkdirSync(staging, { recursive: true });
    fs.cpSync(path.join(source, 'central'), path.join(staging, 'central'), {
      recursive: true,
      dereference: false
    });

    // Pacotes completos restauram seus próprios recursos. Pacotes convertidos
    // antigos não os possuíam, então preservamos o recurso já instalado.
    for (const resource of ['group-attachments', 'stickers', 'updates']) {
      const packaged = path.join(source, resource);
      const existing = path.join(destination, resource);
      const selected = fs.existsSync(packaged) ? packaged : fs.existsSync(existing) ? existing : null;
      if (selected) {
        fs.cpSync(selected, path.join(staging, resource), {
          recursive: true,
          dereference: false
        });
      }
    }

    let probe: CentralStore | null = null;
    let stats: ReturnType<CentralStore['getStats']>;
    try {
      probe = new CentralStore(path.join(staging, 'central'), () => undefined);
      const groupState = probe.readCanonicalState<{
        attachments?: RelayGroupAttachmentMetadata[];
      }>('groups', 1);
      validateGroupAttachments(staging, probe, groupState?.attachments || []);
      probe.verifyBackupIntegrity();
      stats = probe.getStats();
    } finally {
      probe?.close();
    }

    let originalMoved = false;
    try {
      if (fs.existsSync(destination)) {
        fs.renameSync(destination, rollback);
        originalMoved = true;
      }
      fs.renameSync(staging, destination);
    } catch (error) {
      if (originalMoved && !fs.existsSync(destination) && fs.existsSync(rollback)) {
        fs.renameSync(rollback, destination);
      }
      throw error;
    }
    return {
      importedAt: Date.now(),
      source,
      rollbackDir: fs.existsSync(rollback) ? rollback : null,
      manifest,
      stats
    };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
};
