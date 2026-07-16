import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CentralStore } from './centralStore';

export const CONVERTED_BACKUP_KIND = 'lantern-relay-converted-backup';
export const CONVERTED_BACKUP_VERSION = 1;

export interface ConvertedBackupFile {
  path: string;
  size: number;
  sha256: string;
}

export interface ConvertedBackupManifest {
  kind: typeof CONVERTED_BACKUP_KIND;
  version: typeof CONVERTED_BACKUP_VERSION;
  createdAt: number;
  source: 'lantern-local-backups';
  counts: Record<string, number>;
  warnings: string[];
  credentialsFile: string;
  files: ConvertedBackupFile[];
}

export interface ConvertedBackupResult {
  file: string;
  createdAt: number;
  size: number;
  files: number;
  manifest: ConvertedBackupManifest;
}

const hashFile = (file: string): string => {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read = 0;
    do {
      read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read > 0) hash.update(buffer.subarray(0, read));
    } while (read > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
};

const walkRegularFiles = (root: string, current = root): string[] => {
  const result: string[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    const relative = path.relative(root, target);
    if (entry.isSymbolicLink()) throw new Error(`O backup contém um link simbólico não permitido: ${relative}.`);
    if (entry.isDirectory()) result.push(...walkRegularFiles(root, target));
    else if (entry.isFile()) result.push(target);
  }
  return result;
};

const safeManifestPath = (root: string, relativePath: string): string => {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error('O manifesto contém um caminho inválido.');
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.split('/').some((segment) => segment === '..' || segment === '')) {
    throw new Error(`O manifesto contém um caminho inseguro: ${relativePath}.`);
  }
  const resolved = path.resolve(root, ...normalized.split('/'));
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error(`O manifesto tenta acessar dados fora do backup: ${relativePath}.`);
  }
  return resolved;
};

export const createConvertedBackup = (input: {
  sourceRelayDataDir: string;
  outputDir: string;
  counts: Record<string, number>;
  warnings: string[];
  credentials: unknown[];
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
    fs.cpSync(centralSource, path.join(stagingPath, 'central'), { recursive: true, dereference: false });
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
    const files = walkRegularFiles(stagingPath)
      .map((file): ConvertedBackupFile => ({
        path: path.relative(stagingPath, file).split(path.sep).join('/'),
        size: fs.statSync(file).size,
        sha256: hashFile(file)
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const manifest: ConvertedBackupManifest = {
      kind: CONVERTED_BACKUP_KIND,
      version: CONVERTED_BACKUP_VERSION,
      createdAt,
      source: 'lantern-local-backups',
      counts: input.counts,
      warnings: input.warnings,
      credentialsFile,
      files
    };
    fs.writeFileSync(
      path.join(stagingPath, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 }
    );
    fs.renameSync(stagingPath, finalPath);
    return {
      file: finalPath,
      createdAt,
      size: files.reduce((total, file) => total + file.size, 0),
      files: files.length,
      manifest
    };
  } catch (error) {
    fs.rmSync(stagingPath, { recursive: true, force: true });
    throw error;
  }
};

export const readConvertedBackupManifest = (bundlePath: string): ConvertedBackupManifest => {
  const root = path.resolve(bundlePath);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('Selecione uma pasta de backup convertido válida.');
  }
  const manifestFile = path.join(root, 'manifest.json');
  if (!fs.statSync(manifestFile, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('O manifesto do backup convertido não foi encontrado.');
  }
  let manifest: ConvertedBackupManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as ConvertedBackupManifest;
  } catch {
    throw new Error('O manifesto do backup convertido está corrompido.');
  }
  if (manifest.kind !== CONVERTED_BACKUP_KIND || manifest.version !== CONVERTED_BACKUP_VERSION) {
    throw new Error('Este backup não é compatível com esta versão do Lantern Relay.');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('O backup convertido não possui inventário de arquivos.');
  }
  return manifest;
};

export const validateConvertedBackup = (bundlePath: string): ConvertedBackupManifest => {
  const root = path.resolve(bundlePath);
  const manifest = readConvertedBackupManifest(root);
  const declared = new Map<string, ConvertedBackupFile>();
  for (const entry of manifest.files) {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      !Number.isFinite(entry.size) ||
      !/^[a-f0-9]{64}$/i.test(entry.sha256)
    ) throw new Error('O inventário do backup convertido é inválido.');
    if (declared.has(entry.path)) throw new Error(`Arquivo duplicado no manifesto: ${entry.path}.`);
    declared.set(entry.path, entry);
    const file = safeManifestPath(root, entry.path);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size !== entry.size) {
      throw new Error(`O arquivo ${entry.path} está ausente ou possui tamanho incorreto.`);
    }
    if (hashFile(file) !== entry.sha256.toLowerCase()) {
      throw new Error(`A verificação de integridade falhou em ${entry.path}.`);
    }
  }
  const actual = walkRegularFiles(root)
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .filter((file) => file !== 'manifest.json');
  for (const file of actual) {
    if (!declared.has(file)) throw new Error(`O backup contém um arquivo não declarado: ${file}.`);
  }
  for (const required of ['central/lantern-relay.db', 'central/master.key', manifest.credentialsFile]) {
    if (!declared.has(required)) throw new Error(`O backup convertido não contém ${required}.`);
  }
  return manifest;
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
  const manifest = validateConvertedBackup(source);
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
    const groupAttachments = path.join(source, 'group-attachments');
    if (fs.existsSync(groupAttachments)) {
      fs.cpSync(groupAttachments, path.join(staging, 'group-attachments'), {
        recursive: true,
        dereference: false
      });
    }
    const existingStickers = path.join(destination, 'stickers');
    if (fs.existsSync(existingStickers)) {
      fs.cpSync(existingStickers, path.join(staging, 'stickers'), {
        recursive: true,
        dereference: false
      });
    }

    const probe = new CentralStore(path.join(staging, 'central'), () => undefined);
    const stats = probe.getStats();
    probe.close();

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
