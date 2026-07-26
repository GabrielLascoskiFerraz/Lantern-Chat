import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

export const RELAY_BACKUP_KIND = 'lantern-relay-backup';
export const RELAY_BACKUP_VERSION = 2;
export const RELAY_SCHEMA_VERSION = 2;
export const LEGACY_CONVERTED_BACKUP_KIND = 'lantern-relay-converted-backup';

export const resolveBackupAppVersion = (): string | null => {
  for (const candidate of [
    path.resolve(__dirname, '..', 'package.json'),
    path.resolve(__dirname, '..', '..', 'package.json'),
    path.resolve(process.cwd(), 'package.json')
  ]) {
    try {
      const value = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof value.version === 'string' && value.version.trim()) return value.version.trim();
    } catch {
      // Pacotes e executáveis usam layouts diferentes; tenta a próxima localização.
    }
  }
  const configured = String(process.env.npm_package_version || '').trim();
  return configured || null;
};

export interface RelayBackupFile {
  path: string;
  size: number;
  sha256: string;
}

export interface RelayBackupManifest {
  kind: typeof RELAY_BACKUP_KIND | typeof LEGACY_CONVERTED_BACKUP_KIND | 'lantern-relay-backup-v1';
  version: 1 | typeof RELAY_BACKUP_VERSION;
  schemaVersion: number;
  appVersion: string | null;
  createdAt: number;
  source: 'lantern-relay' | 'lantern-local-backups';
  counts: Record<string, number>;
  warnings: string[];
  credentialsFile: string | null;
  files: RelayBackupFile[];
}

interface RawManifest {
  kind?: unknown;
  version?: unknown;
  schemaVersion?: unknown;
  appVersion?: unknown;
  createdAt?: unknown;
  source?: unknown;
  counts?: unknown;
  warnings?: unknown;
  credentialsFile?: unknown;
  files?: unknown;
}

const normalizeRelativePath = (value: string): string => value.replace(/\\/g, '/');

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

export const walkBackupFiles = (root: string, current = root): string[] => {
  const result: string[] = [];
  if (!fs.existsSync(current)) return result;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    const relative = normalizeRelativePath(path.relative(root, target));
    if (entry.isSymbolicLink()) {
      throw new Error(`O backup contém um link simbólico não permitido: ${relative}.`);
    }
    if (entry.isDirectory()) result.push(...walkBackupFiles(root, target));
    else if (entry.isFile()) result.push(target);
  }
  return result;
};

const safeBackupPath = (root: string, relativePath: string): string => {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error('O manifesto contém um caminho inválido.');
  }
  const normalized = normalizeRelativePath(relativePath);
  if (normalized.split('/').some((segment) => segment === '..' || segment === '')) {
    throw new Error(`O manifesto contém um caminho inseguro: ${relativePath}.`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...normalized.split('/'));
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`O manifesto tenta acessar dados fora do backup: ${relativePath}.`);
  }
  return resolved;
};

const normalizeCounts = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, count]) => key.trim() && Number.isFinite(Number(count)))
      .map(([key, count]) => [key, Math.max(0, Math.trunc(Number(count)))])
  );
};

const normalizeWarnings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const normalizeFiles = (value: unknown): RelayBackupFile[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('O backup não possui inventário de arquivos.');
  }
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('O inventário do backup é inválido.');
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.path !== 'string' ||
      !Number.isFinite(Number(entry.size)) ||
      Number(entry.size) < 0 ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(entry.sha256)
    ) {
      throw new Error('O inventário do backup é inválido.');
    }
    return {
      path: normalizeRelativePath(entry.path),
      size: Math.trunc(Number(entry.size)),
      sha256: entry.sha256.toLowerCase()
    };
  });
};

export const createBackupInventory = (root: string): RelayBackupFile[] =>
  walkBackupFiles(root)
    .filter((file) => normalizeRelativePath(path.relative(root, file)) !== 'manifest.json')
    .map((file) => ({
      path: normalizeRelativePath(path.relative(root, file)),
      size: fs.statSync(file).size,
      sha256: hashFile(file)
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

export const writeRelayBackupManifest = (
  bundlePath: string,
  input: {
    createdAt: number;
    source: RelayBackupManifest['source'];
    counts?: Record<string, number>;
    warnings?: string[];
    credentialsFile?: string | null;
    appVersion?: string | null;
  }
): RelayBackupManifest => {
  const files = createBackupInventory(bundlePath);
  const manifest: RelayBackupManifest = {
    kind: RELAY_BACKUP_KIND,
    version: RELAY_BACKUP_VERSION,
    schemaVersion: RELAY_SCHEMA_VERSION,
    appVersion: input.appVersion?.trim() || null,
    createdAt: input.createdAt,
    source: input.source,
    counts: normalizeCounts(input.counts),
    warnings: normalizeWarnings(input.warnings),
    credentialsFile: input.credentialsFile?.trim() || null,
    files
  };
  fs.writeFileSync(
    path.join(bundlePath, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 }
  );
  return manifest;
};

export const readRelayBackupManifest = (bundlePath: string): RelayBackupManifest => {
  const root = path.resolve(bundlePath);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('Selecione uma pasta de backup válida.');
  }
  const manifestFile = path.join(root, 'manifest.json');
  if (!fs.statSync(manifestFile, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('O manifesto do backup não foi encontrado.');
  }
  let raw: RawManifest;
  try {
    raw = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as RawManifest;
  } catch {
    throw new Error('O manifesto do backup está corrompido.');
  }

  const files = normalizeFiles(raw.files);
  const createdAt = Number(raw.createdAt);
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    throw new Error('O manifesto do backup não informa uma data válida.');
  }

  if (raw.kind === RELAY_BACKUP_KIND && raw.version === RELAY_BACKUP_VERSION) {
    const schemaVersion = Math.trunc(Number(raw.schemaVersion));
    if (!Number.isFinite(schemaVersion) || schemaVersion < 1) {
      throw new Error('O manifesto não informa uma versão válida do banco.');
    }
    if (schemaVersion > RELAY_SCHEMA_VERSION) {
      throw new Error('Este backup foi criado por uma versão mais nova do Lantern Relay.');
    }
    return {
      kind: RELAY_BACKUP_KIND,
      version: RELAY_BACKUP_VERSION,
      schemaVersion,
      appVersion: typeof raw.appVersion === 'string' && raw.appVersion.trim() ? raw.appVersion.trim() : null,
      createdAt: Math.trunc(createdAt),
      source: raw.source === 'lantern-local-backups' ? 'lantern-local-backups' : 'lantern-relay',
      counts: normalizeCounts(raw.counts),
      warnings: normalizeWarnings(raw.warnings),
      credentialsFile: typeof raw.credentialsFile === 'string' && raw.credentialsFile.trim()
        ? normalizeRelativePath(raw.credentialsFile.trim())
        : null,
      files
    };
  }

  if (raw.kind === LEGACY_CONVERTED_BACKUP_KIND && raw.version === 1) {
    return {
      kind: LEGACY_CONVERTED_BACKUP_KIND,
      version: 1,
      schemaVersion: 1,
      appVersion: null,
      createdAt: Math.trunc(createdAt),
      source: 'lantern-local-backups',
      counts: normalizeCounts(raw.counts),
      warnings: normalizeWarnings(raw.warnings),
      credentialsFile: typeof raw.credentialsFile === 'string' && raw.credentialsFile.trim()
        ? normalizeRelativePath(raw.credentialsFile.trim())
        : null,
      files
    };
  }

  if (raw.kind === undefined && raw.version === 1) {
    return {
      kind: 'lantern-relay-backup-v1',
      version: 1,
      schemaVersion: 1,
      appVersion: null,
      createdAt: Math.trunc(createdAt),
      source: 'lantern-relay',
      counts: {},
      warnings: [],
      credentialsFile: null,
      files
    };
  }

  throw new Error('Este backup não é compatível com esta versão do Lantern Relay.');
};

const verifySqlite = (databaseFile: string): number => {
  const validationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-relay-backup-check-'));
  const validationFile = path.join(validationDir, 'lantern-relay.db');
  let database: Database.Database | null = null;
  try {
    // Even a read-only SQLite connection may create -shm files beside a WAL
    // database. Validate an isolated copy so inspecting a backup never mutates it.
    fs.copyFileSync(databaseFile, validationFile);
    database = new Database(validationFile, { readonly: true, fileMustExist: true });
    const quickCheck = database.pragma('quick_check') as Array<Record<string, unknown>>;
    if (!quickCheck.some((row) => Object.values(row).includes('ok'))) {
      throw new Error('A verificação de integridade do SQLite falhou.');
    }
    const foreignKeyErrors = database.pragma('foreign_key_check') as unknown[];
    if (foreignKeyErrors.length > 0) {
      throw new Error('O banco do backup contém referências inválidas.');
    }
    return Number(database.pragma('user_version', { simple: true }));
  } catch (error) {
    if (error instanceof Error && /SQLite|referências inválidas/.test(error.message)) throw error;
    throw new Error(`O banco do backup não pôde ser validado: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    database?.close();
    fs.rmSync(validationDir, { recursive: true, force: true });
  }
};

export const validateRelayBackup = (bundlePath: string): RelayBackupManifest => {
  const root = path.resolve(bundlePath);
  const manifest = readRelayBackupManifest(root);
  const declared = new Map<string, RelayBackupFile>();
  for (const entry of manifest.files) {
    if (declared.has(entry.path)) throw new Error(`Arquivo duplicado no manifesto: ${entry.path}.`);
    declared.set(entry.path, entry);
    const file = safeBackupPath(root, entry.path);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size !== entry.size) {
      throw new Error(`O arquivo ${entry.path} está ausente ou possui tamanho incorreto.`);
    }
    if (hashFile(file) !== entry.sha256) {
      throw new Error(`A verificação de integridade falhou em ${entry.path}.`);
    }
  }

  const actual = walkBackupFiles(root)
    .map((file) => normalizeRelativePath(path.relative(root, file)))
    .filter((file) => file !== 'manifest.json');
  for (const file of actual) {
    if (!declared.has(file)) throw new Error(`O backup contém um arquivo não declarado: ${file}.`);
  }
  for (const required of ['central/lantern-relay.db', 'central/master.key']) {
    if (!declared.has(required)) throw new Error(`O backup não contém ${required}.`);
  }
  if (declared.get('central/master.key')?.size !== 32) {
    throw new Error('O backup contém uma chave mestra inválida.');
  }
  if (manifest.credentialsFile && !declared.has(manifest.credentialsFile)) {
    throw new Error(`O backup não contém ${manifest.credentialsFile}.`);
  }
  const databaseSchemaVersion = verifySqlite(safeBackupPath(root, 'central/lantern-relay.db'));
  if (
    manifest.kind === RELAY_BACKUP_KIND &&
    manifest.version === RELAY_BACKUP_VERSION &&
    databaseSchemaVersion !== manifest.schemaVersion
  ) {
    throw new Error(
      `A versão do schema no manifesto (${manifest.schemaVersion}) não corresponde ao banco (${databaseSchemaVersion}).`
    );
  }
  return manifest;
};
