import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  AuthSession,
  CanonicalFrame,
  CentralUser,
  RetentionPolicy,
  SupportedLocale
} from './centralTypes';
import {
  createSessionToken,
  EncryptedFields,
  hashPassword,
  hashToken,
  loadOrCreateMasterKey,
  verifyPassword
} from './security';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,47}$/;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ATTACHMENT_CHUNK_BYTES = 64 * 1024;
const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;

interface UserRow {
  userId: string;
  username: string;
  displayName: string;
  department: string;
  avatarEmoji: string;
  avatarBg: string;
  statusMessage: string;
  locale: SupportedLocale;
  role: 'admin' | 'user';
  disabled: number;
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
}

interface AttachmentRow {
  attachmentId: string;
  messageId: string;
  ownerUserId: string;
  conversationId: string;
  fileNameCipher: string;
  mimeType: string;
  size: number;
  sha256: string;
  totalChunks: number;
  receivedChunks: number;
  complete: number;
  createdAt: number;
}

const normalizeLocale = (value: unknown): SupportedLocale =>
  value === 'en' || value === 'es' ? value : 'pt-BR';

const normalizeRetention = (value: unknown): RetentionPolicy =>
  value === '1_month' || value === '6_months' || value === '1_year' ? value : 'forever';

export class CentralStore {
  private readonly db: Database.Database;
  private readonly encrypted: EncryptedFields;
  private readonly attachmentsDir: string;

  constructor(private readonly dataDir: string, private readonly log: (event: string, details?: Record<string, unknown>) => void) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.attachmentsDir = path.join(dataDir, 'attachments');
    fs.mkdirSync(this.attachmentsDir, { recursive: true });
    this.encrypted = new EncryptedFields(loadOrCreateMasterKey(dataDir));
    this.db = new Database(path.join(dataDir, 'lantern-relay.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    this.ensureBootstrapAdmin();
  }

  close(): void {
    this.db.close();
  }

  protectJson(value: unknown): string {
    return this.encrypted.encrypt(JSON.stringify(value));
  }

  unprotectJson<T>(value: string): T {
    const plain = value.startsWith('gcm-v1.') ? this.encrypted.decrypt(value) : value;
    return JSON.parse(plain) as T;
  }

  getEncryption(): EncryptedFields {
    return this.encrypted;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        userId TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        displayName TEXT NOT NULL,
        department TEXT NOT NULL DEFAULT '',
        avatarEmoji TEXT NOT NULL DEFAULT '🙂',
        avatarBg TEXT NOT NULL DEFAULT '#147ad6',
        statusMessage TEXT NOT NULL DEFAULT 'Disponível',
        locale TEXT NOT NULL DEFAULT 'pt-BR',
        role TEXT NOT NULL DEFAULT 'user',
        disabled INTEGER NOT NULL DEFAULT 0,
        passwordHash TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        tokenHash TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        deviceId TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        lastSeenAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        revokedAt INTEGER,
        FOREIGN KEY(userId) REFERENCES users(userId) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(userId, expiresAt);

      CREATE TABLE IF NOT EXISTS canonical_frames (
        messageId TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        senderUserId TEXT NOT NULL,
        targetUserId TEXT,
        conversationId TEXT NOT NULL,
        payloadCipher TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        deletedAt INTEGER,
        FOREIGN KEY(senderUserId) REFERENCES users(userId)
      );
      CREATE INDEX IF NOT EXISTS idx_frames_conversation_time
        ON canonical_frames(conversationId, createdAt, messageId);
      CREATE INDEX IF NOT EXISTS idx_frames_target_time
        ON canonical_frames(targetUserId, createdAt);

      CREATE TABLE IF NOT EXISTS attachments (
        attachmentId TEXT PRIMARY KEY,
        messageId TEXT NOT NULL,
        ownerUserId TEXT NOT NULL,
        conversationId TEXT NOT NULL,
        fileNameCipher TEXT NOT NULL,
        mimeType TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        totalChunks INTEGER NOT NULL,
        receivedChunks INTEGER NOT NULL DEFAULT 0,
        complete INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY(ownerUserId) REFERENCES users(userId)
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(messageId);

      CREATE TABLE IF NOT EXISTS admin_sessions (
        tokenHash TEXT PRIMARY KEY,
        csrfToken TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL
      );
    `);
    const adminColumns = this.db.prepare('PRAGMA table_info(admin_sessions)').all() as Array<{ name: string }>;
    if (!adminColumns.some((column) => column.name === 'csrfToken')) {
      this.db.exec("ALTER TABLE admin_sessions ADD COLUMN csrfToken TEXT NOT NULL DEFAULT '';");
    }
    this.setSettingIfMissing('retention.policy', 'forever');
  }

  private ensureBootstrapAdmin(): void {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
    if (count.count > 0) return;
    const configured = (process.env.LANTERN_RELAY_ADMIN_PASSWORD || '').trim();
    const password = configured || randomBytes(18).toString('base64url');
    this.createUser({
      username: 'admin',
      displayName: 'Administrador',
      department: 'Administração',
      password,
      role: 'admin',
      locale: 'pt-BR'
    });
    this.log('bootstrap_admin_created', {
      username: 'admin',
      password: configured ? '(definida por LANTERN_RELAY_ADMIN_PASSWORD)' : password,
      warning: configured ? undefined : 'Troque esta senha após o primeiro acesso.'
    });
  }

  private toUser(row: UserRow): CentralUser {
    return {
      userId: row.userId,
      username: row.username,
      displayName: row.displayName,
      department: row.department,
      avatarEmoji: row.avatarEmoji,
      avatarBg: row.avatarBg,
      statusMessage: row.statusMessage,
      locale: normalizeLocale(row.locale),
      role: row.role === 'admin' ? 'admin' : 'user',
      disabled: Boolean(row.disabled),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  listUsers(): CentralUser[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY disabled ASC, department ASC, displayName ASC').all() as UserRow[];
    return rows.map((row) => this.toUser(row));
  }

  getUser(userId: string): CentralUser | null {
    const row = this.db.prepare('SELECT * FROM users WHERE userId = ?').get(userId) as UserRow | undefined;
    return row ? this.toUser(row) : null;
  }

  createUser(input: {
    username: string;
    displayName: string;
    department?: string;
    password: string;
    role?: 'admin' | 'user';
    locale?: SupportedLocale;
  }): CentralUser {
    const username = input.username.trim().toLowerCase();
    if (!USERNAME_RE.test(username)) throw new Error('Nome de usuário inválido.');
    const displayName = input.displayName.trim();
    if (!displayName) throw new Error('Nome de exibição obrigatório.');
    const now = Date.now();
    const row: UserRow = {
      userId: randomUUID(),
      username,
      displayName,
      department: (input.department || '').trim().slice(0, 80),
      avatarEmoji: '🙂',
      avatarBg: '#147ad6',
      statusMessage: 'Disponível',
      locale: normalizeLocale(input.locale),
      role: input.role === 'admin' ? 'admin' : 'user',
      disabled: 0,
      passwordHash: hashPassword(input.password),
      createdAt: now,
      updatedAt: now
    };
    this.db.prepare(`
      INSERT INTO users(userId, username, displayName, department, avatarEmoji, avatarBg,
        statusMessage, locale, role, disabled, passwordHash, createdAt, updatedAt)
      VALUES (@userId, @username, @displayName, @department, @avatarEmoji, @avatarBg,
        @statusMessage, @locale, @role, @disabled, @passwordHash, @createdAt, @updatedAt)
    `).run(row);
    return this.toUser(row);
  }

  updateUser(userId: string, input: Partial<Pick<CentralUser, 'displayName' | 'department' | 'avatarEmoji' | 'avatarBg' | 'statusMessage' | 'locale' | 'disabled'>>): CentralUser {
    const currentRow = this.db.prepare('SELECT * FROM users WHERE userId = ?').get(userId) as UserRow | undefined;
    if (!currentRow) throw new Error('Usuário não encontrado.');
    const updated: UserRow = {
      ...currentRow,
      displayName: input.displayName?.trim() || currentRow.displayName,
      department: input.department === undefined ? currentRow.department : input.department.trim().slice(0, 80),
      avatarEmoji: input.avatarEmoji?.trim() || currentRow.avatarEmoji,
      avatarBg: input.avatarBg?.trim() || currentRow.avatarBg,
      statusMessage: input.statusMessage === undefined ? currentRow.statusMessage : input.statusMessage.trim().slice(0, 140),
      locale: input.locale === undefined ? currentRow.locale : normalizeLocale(input.locale),
      disabled: input.disabled === undefined ? currentRow.disabled : input.disabled ? 1 : 0,
      updatedAt: Date.now()
    };
    this.db.prepare(`
      UPDATE users SET displayName=@displayName, department=@department, avatarEmoji=@avatarEmoji,
        avatarBg=@avatarBg, statusMessage=@statusMessage, locale=@locale, disabled=@disabled,
        updatedAt=@updatedAt WHERE userId=@userId
    `).run(updated);
    if (updated.disabled) this.revokeUserSessions(userId);
    return this.toUser(updated);
  }

  resetPassword(userId: string, password: string): void {
    const result = this.db.prepare('UPDATE users SET passwordHash = ?, updatedAt = ? WHERE userId = ?')
      .run(hashPassword(password), Date.now(), userId);
    if (result.changes === 0) throw new Error('Usuário não encontrado.');
    this.revokeUserSessions(userId);
  }

  deleteUser(userId: string): void {
    const user = this.getUser(userId);
    if (!user) return;
    if (user.role === 'admin') {
      const admins = this.listUsers().filter((entry) => entry.role === 'admin' && !entry.disabled);
      if (admins.length <= 1) throw new Error('Não é possível excluir o último administrador.');
    }
    // Preserva a integridade referencial do histórico, mas remove definitivamente
    // a capacidade de autenticação e os dados pessoais exibidos da conta.
    const now = Date.now();
    this.db.prepare(`
      UPDATE users
      SET username = ?, displayName = ?, department = '', statusMessage = '',
          avatarEmoji = '👤', avatarBg = '#69797e', passwordHash = ?, disabled = 1,
          updatedAt = ?
      WHERE userId = ?
    `).run(`deleted-${userId}`, 'Usuário excluído', hashPassword(createSessionToken()), now, userId);
    this.revokeUserSessions(userId);
  }

  login(usernameInput: string, password: string, deviceId: string): AuthSession {
    const username = usernameInput.trim().toLowerCase();
    const row = this.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) as UserRow | undefined;
    if (!row || row.disabled || !verifyPassword(password, row.passwordHash)) {
      throw new Error('Usuário ou senha inválidos.');
    }
    const token = createSessionToken();
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;
    this.db.prepare(`
      INSERT INTO sessions(tokenHash, userId, deviceId, createdAt, lastSeenAt, expiresAt, revokedAt)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(hashToken(token), row.userId, deviceId.trim() || randomUUID(), now, now, expiresAt);
    return { token, expiresAt, user: this.toUser(row) };
  }

  authenticate(token: string): CentralUser | null {
    const tokenHash = hashToken(token);
    const now = Date.now();
    const row = this.db.prepare(`
      SELECT users.* FROM sessions
      JOIN users ON users.userId = sessions.userId
      WHERE sessions.tokenHash = ? AND sessions.revokedAt IS NULL
        AND sessions.expiresAt > ? AND users.disabled = 0
    `).get(tokenHash, now) as UserRow | undefined;
    if (!row) return null;
    this.db.prepare('UPDATE sessions SET lastSeenAt = ? WHERE tokenHash = ?').run(now, tokenHash);
    return this.toUser(row);
  }

  logout(token: string): void {
    this.db.prepare('UPDATE sessions SET revokedAt = ? WHERE tokenHash = ?').run(Date.now(), hashToken(token));
  }

  private revokeUserSessions(userId: string): void {
    this.db.prepare('UPDATE sessions SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL').run(Date.now(), userId);
  }

  createAdminSession(username: string, password: string): { token: string; csrfToken: string } {
    const auth = this.login(username, password, 'relay-dashboard');
    if (auth.user.role !== 'admin') {
      this.logout(auth.token);
      throw new Error('Acesso administrativo necessário.');
    }
    const adminToken = createSessionToken();
    const csrfToken = createSessionToken();
    const now = Date.now();
    this.db.prepare('INSERT INTO admin_sessions(tokenHash, csrfToken, createdAt, expiresAt) VALUES (?, ?, ?, ?)')
      .run(hashToken(adminToken), csrfToken, now, now + 8 * 60 * 60 * 1000);
    this.logout(auth.token);
    return { token: adminToken, csrfToken };
  }

  validateAdminSession(token: string, csrfToken?: string): boolean {
    if (!token) return false;
    const row = this.db.prepare('SELECT csrfToken FROM admin_sessions WHERE tokenHash = ? AND expiresAt > ?')
      .get(hashToken(token), Date.now()) as { csrfToken: string } | undefined;
    if (!row) return false;
    return csrfToken === undefined || (csrfToken.length > 0 && row.csrfToken === csrfToken);
  }

  getRetentionPolicy(): RetentionPolicy {
    return normalizeRetention(this.getSetting('retention.policy'));
  }

  setRetentionPolicy(policy: RetentionPolicy): RetentionPolicy {
    const normalized = normalizeRetention(policy);
    this.setSetting('retention.policy', normalized);
    return normalized;
  }

  saveFrame(frame: CanonicalFrame): void {
    const payloadCipher = this.encrypted.encrypt(JSON.stringify(frame.payload ?? null));
    this.db.prepare(`
      INSERT INTO canonical_frames(messageId, type, senderUserId, targetUserId, conversationId,
        payloadCipher, createdAt, deletedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(messageId) DO NOTHING
    `).run(frame.messageId, frame.type, frame.senderUserId, frame.targetUserId, frame.conversationId, payloadCipher, frame.createdAt);
  }

  listFramesForUser(userId: string, after = 0, limit = 500): CanonicalFrame[] {
    const rows = this.db.prepare(`
      SELECT messageId, type, senderUserId, targetUserId, conversationId, payloadCipher, createdAt
      FROM canonical_frames
      WHERE deletedAt IS NULL AND createdAt > ?
        AND (senderUserId = ? OR targetUserId = ? OR targetUserId IS NULL)
      ORDER BY createdAt ASC, messageId ASC LIMIT ?
    `).all(Math.max(0, after), userId, userId, Math.max(1, Math.min(limit, 5000))) as Array<{
      messageId: string; type: string; senderUserId: string; targetUserId: string | null;
      conversationId: string; payloadCipher: string; createdAt: number;
    }>;
    return rows.map((row) => ({
      messageId: row.messageId,
      type: row.type,
      senderUserId: row.senderUserId,
      targetUserId: row.targetUserId,
      conversationId: row.conversationId,
      createdAt: row.createdAt,
      payload: JSON.parse(this.encrypted.decrypt(row.payloadCipher))
    }));
  }

  initAttachment(input: {
    attachmentId: string;
    messageId: string;
    ownerUserId: string;
    conversationId: string;
    fileName: string;
    mimeType: string;
    size: number;
    sha256: string;
  }): { nextIndex: number; totalChunks: number } {
    if (input.size < 0 || input.size > MAX_ATTACHMENT_BYTES) throw new Error('Tamanho de anexo inválido.');
    const totalChunks = Math.max(1, Math.ceil(input.size / ATTACHMENT_CHUNK_BYTES));
    const existing = this.db.prepare('SELECT * FROM attachments WHERE attachmentId = ?').get(input.attachmentId) as AttachmentRow | undefined;
    if (existing) return { nextIndex: existing.receivedChunks, totalChunks: existing.totalChunks };
    this.db.prepare(`
      INSERT INTO attachments(attachmentId, messageId, ownerUserId, conversationId, fileNameCipher,
        mimeType, size, sha256, totalChunks, receivedChunks, complete, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
    `).run(input.attachmentId, input.messageId, input.ownerUserId, input.conversationId,
      this.encrypted.encrypt(input.fileName), input.mimeType || 'application/octet-stream', input.size,
      input.sha256, totalChunks, Date.now());
    fs.mkdirSync(this.attachmentPath(input.attachmentId), { recursive: true });
    return { nextIndex: 0, totalChunks };
  }

  appendAttachmentChunk(attachmentId: string, ownerUserId: string, index: number, data: Buffer): void {
    const row = this.getAttachmentRow(attachmentId);
    if (row.ownerUserId !== ownerUserId) throw new Error('Anexo pertence a outro usuário.');
    if (row.complete) return;
    if (index < 0 || index >= row.totalChunks) throw new Error('Índice de chunk inválido.');
    const expectedSize = index === row.totalChunks - 1
      ? row.size - index * ATTACHMENT_CHUNK_BYTES
      : ATTACHMENT_CHUNK_BYTES;
    if (data.length !== Math.max(0, expectedSize)) throw new Error('Tamanho de chunk inválido.');
    const chunkPath = path.join(this.attachmentPath(attachmentId), `${index}.bin`);
    if (index < row.receivedChunks && fs.existsSync(chunkPath)) return;
    if (index !== row.receivedChunks) throw new Error('Chunk fora de ordem.');
    fs.writeFileSync(chunkPath, this.encrypted.encryptBytes(data));
    this.db.prepare('UPDATE attachments SET receivedChunks = receivedChunks + 1 WHERE attachmentId = ?').run(attachmentId);
  }

  completeAttachment(attachmentId: string, ownerUserId: string): void {
    const row = this.getAttachmentRow(attachmentId);
    if (row.ownerUserId !== ownerUserId) throw new Error('Anexo pertence a outro usuário.');
    if (row.receivedChunks !== row.totalChunks) throw new Error('Upload incompleto.');
    const hash = createHash('sha256');
    let size = 0;
    for (let index = 0; index < row.totalChunks; index += 1) {
      const chunk = this.readAttachmentChunkInternal(row, index);
      hash.update(chunk);
      size += chunk.length;
    }
    if (size !== row.size || hash.digest('hex') !== row.sha256) throw new Error('Integridade do anexo inválida.');
    this.db.prepare('UPDATE attachments SET complete = 1 WHERE attachmentId = ?').run(attachmentId);
  }

  getAttachmentMetadata(attachmentId: string, requesterUserId: string): {
    attachmentId: string; messageId: string; fileName: string; mimeType: string; size: number;
    sha256: string; totalChunks: number;
  } {
    const row = this.getAttachmentRow(attachmentId);
    if (!row.complete) throw new Error('Anexo ainda incompleto.');
    if (!this.userCanAccessAttachment(requesterUserId, row)) throw new Error('Acesso negado ao anexo.');
    return {
      attachmentId: row.attachmentId,
      messageId: row.messageId,
      fileName: this.encrypted.decrypt(row.fileNameCipher),
      mimeType: row.mimeType,
      size: row.size,
      sha256: row.sha256,
      totalChunks: row.totalChunks
    };
  }

  readAttachmentChunk(attachmentId: string, requesterUserId: string, index: number): Buffer {
    const row = this.getAttachmentRow(attachmentId);
    if (!row.complete || !this.userCanAccessAttachment(requesterUserId, row)) {
      throw new Error('Acesso negado ao anexo.');
    }
    return this.readAttachmentChunkInternal(row, index);
  }

  sweepRetention(): { framesDeleted: number; attachmentsDeleted: number } {
    const policy = this.getRetentionPolicy();
    if (policy === 'forever') return { framesDeleted: 0, attachmentsDeleted: 0 };
    const ageMs = policy === '1_month' ? 30 * 86400000 : policy === '6_months' ? 183 * 86400000 : 365 * 86400000;
    const cutoff = Date.now() - ageMs;
    const attachmentRows = this.db.prepare(`
      SELECT attachmentId FROM attachments WHERE messageId IN (
        SELECT messageId FROM canonical_frames WHERE createdAt < ?
      )
    `).all(cutoff) as Array<{ attachmentId: string }>;
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM attachments WHERE messageId IN (SELECT messageId FROM canonical_frames WHERE createdAt < ?)').run(cutoff);
      return this.db.prepare('DELETE FROM canonical_frames WHERE createdAt < ?').run(cutoff).changes;
    });
    const framesDeleted = tx();
    for (const row of attachmentRows) fs.rmSync(this.attachmentPath(row.attachmentId), { recursive: true, force: true });
    return { framesDeleted, attachmentsDeleted: attachmentRows.length };
  }

  getStats(): { users: number; sessions: number; frames: number; attachments: number; attachmentBytes: number; retentionPolicy: RetentionPolicy } {
    const now = Date.now();
    const users = (this.db.prepare('SELECT COUNT(*) AS count FROM users WHERE disabled = 0').get() as { count: number }).count;
    const sessions = (this.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE revokedAt IS NULL AND expiresAt > ?').get(now) as { count: number }).count;
    const frames = (this.db.prepare('SELECT COUNT(*) AS count FROM canonical_frames').get() as { count: number }).count;
    const attachment = this.db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM attachments WHERE complete = 1').get() as { count: number; bytes: number };
    return { users, sessions, frames, attachments: attachment.count, attachmentBytes: attachment.bytes, retentionPolicy: this.getRetentionPolicy() };
  }

  private getAttachmentRow(attachmentId: string): AttachmentRow {
    const row = this.db.prepare('SELECT * FROM attachments WHERE attachmentId = ?').get(attachmentId) as AttachmentRow | undefined;
    if (!row) throw new Error('Anexo não encontrado.');
    return row;
  }

  private readAttachmentChunkInternal(row: AttachmentRow, index: number): Buffer {
    if (index < 0 || index >= row.totalChunks) throw new Error('Índice de chunk inválido.');
    return this.encrypted.decryptBytes(fs.readFileSync(path.join(this.attachmentPath(row.attachmentId), `${index}.bin`)));
  }

  private attachmentPath(attachmentId: string): string {
    return path.join(this.attachmentsDir, attachmentId.replace(/[^a-zA-Z0-9-]/g, '_'));
  }

  private userCanAccessAttachment(userId: string, attachment: AttachmentRow): boolean {
    if (attachment.ownerUserId === userId || attachment.conversationId === 'announcements') return true;
    const frame = this.db.prepare(`
      SELECT senderUserId, targetUserId FROM canonical_frames WHERE messageId = ?
    `).get(attachment.messageId) as { senderUserId: string; targetUserId: string | null } | undefined;
    return Boolean(frame && (frame.senderUserId === userId || frame.targetUserId === userId));
  }

  private getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value || null;
  }

  private setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  private setSettingIfMissing(key: string, value: string): void {
    this.db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)').run(key, value);
  }
}
