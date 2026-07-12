import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PASSWORD_KEY_BYTES = 64;
const MASTER_KEY_BYTES = 32;
const SCRYPT_OPTIONS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

const decodeConfiguredKey = (value: string): Buffer | null => {
  const clean = value.trim();
  if (!clean) return null;
  const candidates = [Buffer.from(clean, 'base64'), Buffer.from(clean, 'hex')];
  return candidates.find((candidate) => candidate.length === MASTER_KEY_BYTES) || null;
};

export const loadOrCreateMasterKey = (dataDir: string): Buffer => {
  const configured = decodeConfiguredKey(process.env.LANTERN_RELAY_MASTER_KEY || '');
  if (configured) return configured;

  fs.mkdirSync(dataDir, { recursive: true });
  const keyPath = path.join(dataDir, 'master.key');
  if (fs.existsSync(keyPath)) {
    const key = fs.readFileSync(keyPath);
    if (key.length !== MASTER_KEY_BYTES) {
      throw new Error('master.key inválida: esperado arquivo binário de 32 bytes.');
    }
    return key;
  }

  const key = randomBytes(MASTER_KEY_BYTES);
  fs.writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' });
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    // Windows não implementa permissões POSIX; ACLs do diretório continuam válidas.
  }
  return key;
};

export const hashPassword = (password: string, allowBootstrapPassword = false): string => {
  if (!allowBootstrapPassword && password.length < 10) {
    throw new Error('A senha deve ter pelo menos 10 caracteres.');
  }
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, PASSWORD_KEY_BYTES, SCRYPT_OPTIONS);
  return `scrypt-v1$${salt.toString('base64')}$${derived.toString('base64')}`;
};

export const verifyPassword = (password: string, encoded: string): boolean => {
  const [version, saltBase64, hashBase64] = encoded.split('$');
  if (version !== 'scrypt-v1' || !saltBase64 || !hashBase64) return false;
  try {
    const salt = Buffer.from(saltBase64, 'base64');
    const expected = Buffer.from(hashBase64, 'base64');
    const actual = scryptSync(password, salt, expected.length, SCRYPT_OPTIONS);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
};

export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export const createSessionToken = (): string => randomBytes(32).toString('base64url');

export class EncryptedFields {
  constructor(private readonly key: Buffer) {
    if (key.length !== MASTER_KEY_BYTES) throw new Error('Chave de criptografia inválida.');
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `gcm-v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
  }

  decrypt(value: string): string {
    const [version, ivValue, tagValue, encryptedValue] = value.split('.');
    if (version !== 'gcm-v1' || !ivValue || !tagValue || encryptedValue === undefined) {
      throw new Error('Conteúdo cifrado inválido.');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  }

  encryptBytes(value: Buffer): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  }

  decryptBytes(value: Buffer): Buffer {
    if (value.length < 28) throw new Error('Bloco cifrado inválido.');
    const iv = value.subarray(0, 12);
    const tag = value.subarray(12, 28);
    const encrypted = value.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }
}
