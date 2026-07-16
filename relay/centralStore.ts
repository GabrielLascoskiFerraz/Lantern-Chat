import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  AuthSession,
  CanonicalFrame,
  CanonicalExportMessage,
  CentralUser,
  ConversationMediaCursor,
  ConversationMediaKind,
  ConversationMediaPage,
  PasswordResetRequest,
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
import { EncryptedChunkStore } from './encryptedChunkStore';
import { BackupService, BackupSource, CanonicalBackup } from './backupService';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,47}$/;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ATTACHMENT_CHUNK_BYTES = 64 * 1024;
const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;
const PASSWORD_RESET_APPROVAL_TTL_MS = 30 * 60 * 1000;
const IMAGE_FILE_RE = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i;

const mediaKindFor = (mimeType: string, fileName: string): ConversationMediaKind =>
  mimeType.toLowerCase().startsWith('image/') || IMAGE_FILE_RE.test(fileName) ? 'media' : 'document';

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
  profileSetupCompleted: number;
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

export interface AuditEntry {
  id: number;
  action: string;
  actor: string;
  target: string | null;
  details: Record<string, unknown>;
  createdAt: number;
}

export interface CentralSessionInfo {
  sessionId: string;
  userId: string;
  username: string;
  displayName: string;
  deviceId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

const normalizeLocale = (value: unknown): SupportedLocale =>
  value === 'en' || value === 'es' ? value : 'pt-BR';

const normalizeRetention = (value: unknown): RetentionPolicy =>
  value === '1_month' || value === '6_months' || value === '1_year' ? value : 'forever';

export class CentralStore {
  private readonly db: Database.Database;
  private readonly databaseFile: string;
  private readonly encrypted: EncryptedFields;
  private readonly attachmentsDir: string;
  private readonly chunks: EncryptedChunkStore;
  private lastRequestResultCleanupAt = 0;

  constructor(private readonly dataDir: string, private readonly log: (event: string, details?: Record<string, unknown>) => void) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.attachmentsDir = path.join(dataDir, 'attachments');
    fs.mkdirSync(this.attachmentsDir, { recursive: true });
    this.encrypted = new EncryptedFields(loadOrCreateMasterKey(dataDir));
    this.chunks = new EncryptedChunkStore(this.attachmentsDir, this.encrypted);
    this.databaseFile = path.join(dataDir, 'lantern-relay.db');
    this.db = new Database(this.databaseFile);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('wal_autocheckpoint = 1000');
    this.migrate();
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

      CREATE TABLE IF NOT EXISTS canonical_state (
        key TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        valueCipher TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS canonical_groups (
        groupId TEXT PRIMARY KEY,
        valueCipher TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS canonical_group_events (
        eventId TEXT PRIMARY KEY,
        groupId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        valueCipher TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        UNIQUE(groupId, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_group_events_sequence
        ON canonical_group_events(groupId, seq);
      CREATE TABLE IF NOT EXISTS canonical_group_attachments (
        fileId TEXT PRIMARY KEY,
        groupId TEXT NOT NULL,
        messageId TEXT NOT NULL,
        valueCipher TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_group_attachments_group
        ON canonical_group_attachments(groupId, messageId);
      CREATE TABLE IF NOT EXISTS canonical_announcements (
        messageId TEXT PRIMARY KEY,
        valueCipher TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
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
        profileSetupCompleted INTEGER NOT NULL DEFAULT 0,
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
      CREATE INDEX IF NOT EXISTS idx_frames_sender_time
        ON canonical_frames(senderUserId, createdAt, messageId);
      CREATE TABLE IF NOT EXISTS canonical_frame_sequence (
        serverSeq INTEGER PRIMARY KEY AUTOINCREMENT,
        messageId TEXT NOT NULL UNIQUE,
        FOREIGN KEY(messageId) REFERENCES canonical_frames(messageId) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS canonical_request_results (
        requestId TEXT NOT NULL,
        userId TEXT NOT NULL,
        action TEXT NOT NULL,
        resultCipher TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY(requestId, userId),
        FOREIGN KEY(userId) REFERENCES users(userId) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_request_results_created
        ON canonical_request_results(createdAt);

      CREATE TABLE IF NOT EXISTS canonical_search_documents (
        messageId TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        textCipher TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_search_documents_conversation
        ON canonical_search_documents(conversationId, createdAt, messageId);
      CREATE TABLE IF NOT EXISTS canonical_search_tokens (
        messageId TEXT NOT NULL,
        tokenHash TEXT NOT NULL,
        PRIMARY KEY(messageId, tokenHash),
        FOREIGN KEY(messageId) REFERENCES canonical_search_documents(messageId) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_search_tokens_hash
        ON canonical_search_tokens(tokenHash, messageId);

      CREATE TABLE IF NOT EXISTS user_conversation_state (
        userId TEXT NOT NULL,
        peerUserId TEXT NOT NULL,
        clearedAt INTEGER NOT NULL DEFAULT 0,
        forgotten INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY(userId, peerUserId),
        FOREIGN KEY(userId) REFERENCES users(userId) ON DELETE CASCADE,
        FOREIGN KEY(peerUserId) REFERENCES users(userId) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS user_conversation_preferences (
        userId TEXT NOT NULL,
        conversationId TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        manualUnread INTEGER NOT NULL DEFAULT 0,
        readAt INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY(userId, conversationId),
        FOREIGN KEY(userId) REFERENCES users(userId) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS user_message_preferences (
        userId TEXT NOT NULL,
        messageId TEXT NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY(userId, messageId),
        FOREIGN KEY(userId) REFERENCES users(userId) ON DELETE CASCADE
      );

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
        userId TEXT NOT NULL DEFAULT '',
        csrfToken TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS password_reset_requests (
        requestId TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        tokenHash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        requestedAt INTEGER NOT NULL,
        reviewedAt INTEGER,
        reviewedBy TEXT,
        expiresAt INTEGER,
        consumedAt INTEGER,
        FOREIGN KEY(userId) REFERENCES users(userId) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_password_reset_status
        ON password_reset_requests(status, requestedAt DESC);

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        target TEXT,
        detailsCipher TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(createdAt DESC, id DESC);
    `);
    // Versões anteriores permitiam ocultar contatos individualmente. O diretório atual é
    // definido exclusivamente pelo estado ativo/desativado da conta.
    this.db.prepare('UPDATE user_conversation_state SET forgotten = 0 WHERE forgotten != 0').run();
    const adminColumns = this.db.prepare('PRAGMA table_info(admin_sessions)').all() as Array<{ name: string }>;
    if (!adminColumns.some((column) => column.name === 'csrfToken')) {
      this.db.exec("ALTER TABLE admin_sessions ADD COLUMN csrfToken TEXT NOT NULL DEFAULT '';");
    }
    if (!adminColumns.some((column) => column.name === 'userId')) {
      this.db.exec("ALTER TABLE admin_sessions ADD COLUMN userId TEXT NOT NULL DEFAULT '';");
    }
    const userColumns = this.db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
    if (!userColumns.some((column) => column.name === 'profileSetupCompleted')) {
      this.db.exec('ALTER TABLE users ADD COLUMN profileSetupCompleted INTEGER NOT NULL DEFAULT 0;');
    }
    this.db.exec(`
      INSERT OR IGNORE INTO canonical_frame_sequence(messageId)
      SELECT messageId FROM canonical_frames ORDER BY createdAt, messageId;
    `);
    this.setSettingIfMissing('retention.policy', 'forever');
  }

  getDatabaseFile(): string {
    return this.databaseFile;
  }

  getCanonicalRequestResult<T>(requestId: string, userId: string): { action: string; result: T } | null {
    const row = this.db.prepare(`
      SELECT action, resultCipher
      FROM canonical_request_results
      WHERE requestId = ? AND userId = ?
    `).get(requestId, userId) as { action: string; resultCipher: string } | undefined;
    if (!row) return null;
    return {
      action: row.action,
      result: this.unprotectJson<T>(row.resultCipher)
    };
  }

  saveCanonicalRequestResult<T>(
    requestId: string,
    userId: string,
    action: string,
    result: T
  ): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO canonical_request_results(requestId, userId, action, resultCipher, createdAt)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(requestId, userId) DO NOTHING
    `).run(requestId, userId, action, this.protectJson(result), now);
    if (now - this.lastRequestResultCleanupAt >= 60 * 60 * 1_000) {
      this.db.prepare('DELETE FROM canonical_request_results WHERE createdAt < ?')
        .run(now - 7 * 24 * 60 * 60 * 1_000);
      this.lastRequestResultCleanupAt = now;
    }
  }

  readCanonicalState<T>(key: string, version = 1): T | null {
    const normalizedKey = key.trim();
    if (!normalizedKey) throw new Error('Chave de estado canônico obrigatória.');
    const relational = this.readRelationalCanonicalState<T>(normalizedKey, version);
    if (relational) return relational;
    const row = this.db.prepare(`
      SELECT version, valueCipher FROM canonical_state WHERE key = ?
    `).get(normalizedKey) as { version: number; valueCipher: string } | undefined;
    if (!row) return null;
    if (row.version !== version) {
      throw new Error(`Versão incompatível do estado canônico ${normalizedKey}.`);
    }
    const value = JSON.parse(this.encrypted.decrypt(row.valueCipher)) as T;
    if (normalizedKey === 'groups' || normalizedKey === 'announcements') {
      this.writeRelationalCanonicalState(normalizedKey, value, version);
      this.db.prepare('DELETE FROM canonical_state WHERE key = ?').run(normalizedKey);
    }
    return value;
  }

  writeCanonicalState<T>(key: string, value: T, version = 1): void {
    const normalizedKey = key.trim();
    if (!normalizedKey) throw new Error('Chave de estado canônico obrigatória.');
    if (this.writeRelationalCanonicalState(normalizedKey, value, version)) {
      this.db.prepare('DELETE FROM canonical_state WHERE key = ?').run(normalizedKey);
      return;
    }
    const valueCipher = this.encrypted.encrypt(JSON.stringify(value));
    this.db.prepare(`
      INSERT INTO canonical_state(key, version, valueCipher, updatedAt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        version = excluded.version,
        valueCipher = excluded.valueCipher,
        updatedAt = excluded.updatedAt
    `).run(normalizedKey, version, valueCipher, Date.now());
  }

  private readRelationalCanonicalState<T>(key: string, version: number): T | null {
    if (version !== 1) return null;
    if (key === 'groups') {
      const groups = this.db.prepare('SELECT valueCipher FROM canonical_groups ORDER BY updatedAt, groupId').all() as Array<{ valueCipher: string }>;
      const events = this.db.prepare('SELECT groupId, valueCipher FROM canonical_group_events ORDER BY groupId, seq').all() as Array<{ groupId: string; valueCipher: string }>;
      const attachments = this.db.prepare('SELECT valueCipher FROM canonical_group_attachments ORDER BY updatedAt, fileId').all() as Array<{ valueCipher: string }>;
      if (groups.length === 0 && events.length === 0 && attachments.length === 0) return null;
      const eventsByGroupId: Record<string, unknown[]> = {};
      for (const row of events) {
        (eventsByGroupId[row.groupId] ||= []).push(JSON.parse(this.encrypted.decrypt(row.valueCipher)));
      }
      return {
        version: 1,
        groups: groups.map((row) => JSON.parse(this.encrypted.decrypt(row.valueCipher))),
        eventsByGroupId,
        attachments: attachments.map((row) => JSON.parse(this.encrypted.decrypt(row.valueCipher)))
      } as T;
    }
    if (key === 'announcements') {
      const rows = this.db.prepare('SELECT valueCipher FROM canonical_announcements ORDER BY createdAt, messageId').all() as Array<{ valueCipher: string }>;
      if (rows.length === 0) return null;
      return {
        version: 1,
        savedAt: Date.now(),
        announcements: rows.map((row) => JSON.parse(this.encrypted.decrypt(row.valueCipher)))
      } as T;
    }
    return null;
  }

  private writeRelationalCanonicalState<T>(key: string, value: T, version: number): boolean {
    if (version !== 1 || !value || typeof value !== 'object') return false;
    const state = value as Record<string, unknown>;
    if (key === 'groups') {
      const groups = Array.isArray(state.groups) ? state.groups : [];
      const eventsByGroupId = state.eventsByGroupId && typeof state.eventsByGroupId === 'object'
        ? state.eventsByGroupId as Record<string, unknown>
        : {};
      const attachments = Array.isArray(state.attachments) ? state.attachments : [];
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM canonical_group_events').run();
        this.db.prepare('DELETE FROM canonical_group_attachments').run();
        this.db.prepare('DELETE FROM canonical_groups').run();
        const insertGroup = this.db.prepare('INSERT INTO canonical_groups(groupId, valueCipher, updatedAt) VALUES (?, ?, ?)');
        for (const raw of groups) {
          const group = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
          if (typeof group.groupId !== 'string') continue;
          insertGroup.run(group.groupId, this.encrypted.encrypt(JSON.stringify(raw)), Number(group.updatedAt) || Date.now());
        }
        const insertEvent = this.db.prepare('INSERT INTO canonical_group_events(eventId, groupId, seq, valueCipher, createdAt) VALUES (?, ?, ?, ?, ?)');
        for (const [groupId, rawEvents] of Object.entries(eventsByGroupId)) {
          if (!Array.isArray(rawEvents)) continue;
          for (const raw of rawEvents) {
            const event = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
            if (typeof event.eventId !== 'string') continue;
            insertEvent.run(event.eventId, groupId, Number(event.seq) || 0, this.encrypted.encrypt(JSON.stringify(raw)), Number(event.createdAt) || Date.now());
          }
        }
        const insertAttachment = this.db.prepare('INSERT INTO canonical_group_attachments(fileId, groupId, messageId, valueCipher, updatedAt) VALUES (?, ?, ?, ?, ?)');
        for (const raw of attachments) {
          const attachment = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
          if (typeof attachment.fileId !== 'string') continue;
          insertAttachment.run(
            attachment.fileId,
            typeof attachment.groupId === 'string' ? attachment.groupId : '',
            typeof attachment.messageId === 'string' ? attachment.messageId : '',
            this.encrypted.encrypt(JSON.stringify(raw)),
            Number(attachment.uploadedAt) || Number(attachment.createdAt) || Date.now()
          );
        }
        this.rebuildGroupSearchDocuments(eventsByGroupId);
      })();
      return true;
    }
    if (key === 'announcements') {
      const announcements = Array.isArray(state.announcements) ? state.announcements : [];
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM canonical_announcements').run();
        const insert = this.db.prepare('INSERT INTO canonical_announcements(messageId, valueCipher, createdAt, expiresAt, updatedAt) VALUES (?, ?, ?, ?, ?)');
        for (const raw of announcements) {
          const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
          if (typeof item.messageId !== 'string') continue;
          insert.run(
            item.messageId,
            this.encrypted.encrypt(JSON.stringify(raw)),
            Number(item.createdAt) || Date.now(),
            Number(item.expiresAt) || Number.MAX_SAFE_INTEGER,
            Date.now()
          );
        }
      })();
      return true;
    }
    return false;
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
      profileSetupCompleted: Boolean(row.profileSetupCompleted),
      disabled: Boolean(row.disabled),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  listUsers(): CentralUser[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY disabled ASC, department ASC, displayName ASC').all() as UserRow[];
    return rows.map((row) => this.toUser(row));
  }

  listVisibleUsersForUser(userId: string): CentralUser[] {
    const rows = this.db.prepare(`
      SELECT users.* FROM users
      WHERE users.userId != ? AND users.disabled = 0
      ORDER BY users.department ASC, users.displayName ASC
    `).all(userId) as UserRow[];
    return rows.map((row) => this.toUser(row));
  }

  isUserVisibleTo(userId: string, peerUserId: string): boolean {
    if (userId === peerUserId) return false;
    const peer = this.getUser(peerUserId);
    return Boolean(peer && !peer.disabled);
  }

  clearConversationForUser(userId: string, peerUserId: string): void {
    if (!this.getUser(userId) || !this.getUser(peerUserId)) throw new Error('Conversa canônica inválida.');
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO user_conversation_state(userId, peerUserId, clearedAt, forgotten, updatedAt)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(userId, peerUserId) DO UPDATE SET
        clearedAt = excluded.clearedAt,
        forgotten = 0,
        updatedAt = excluded.updatedAt
    `).run(userId, peerUserId, now, 0, now);
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
    allowBootstrapPassword?: boolean;
  }, actor = 'system'): CentralUser {
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
      profileSetupCompleted: 0,
      disabled: 0,
      passwordHash: hashPassword(input.password, input.allowBootstrapPassword === true),
      createdAt: now,
      updatedAt: now
    };
    this.db.prepare(`
      INSERT INTO users(userId, username, displayName, department, avatarEmoji, avatarBg,
        statusMessage, locale, role, profileSetupCompleted, disabled, passwordHash, createdAt, updatedAt)
      VALUES (@userId, @username, @displayName, @department, @avatarEmoji, @avatarBg,
        @statusMessage, @locale, @role, @profileSetupCompleted, @disabled, @passwordHash, @createdAt, @updatedAt)
    `).run(row);
    this.appendAudit('user.created', actor, row.userId, {
      username: row.username,
      role: row.role,
      bootstrap: input.allowBootstrapPassword === true
    });
    return this.toUser(row);
  }

  updateUser(userId: string, input: Partial<Pick<CentralUser, 'displayName' | 'department' | 'avatarEmoji' | 'avatarBg' | 'statusMessage' | 'locale' | 'disabled'>>, actor = 'admin'): CentralUser {
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
    if (updated.disabled) {
      this.revokeUserSessions(userId);
      this.db.prepare('DELETE FROM admin_sessions WHERE userId = ?').run(userId);
    }
    this.appendAudit('user.updated', actor, userId, {
      disabled: Boolean(updated.disabled),
      department: updated.department,
      locale: updated.locale
    });
    return this.toUser(updated);
  }

  updateManagedUserAtomic(
    userId: string,
    input: { displayName?: string; department?: string; disabled?: boolean; role?: 'admin' | 'user' },
    actor = 'relay-ui'
  ): CentralUser {
    return this.db.transaction(() => {
      const current = this.db.prepare('SELECT * FROM users WHERE userId = ?').get(userId) as UserRow | undefined;
      if (!current) throw new Error('Usuário não encontrado.');
      const displayName = input.displayName === undefined ? current.displayName : input.displayName.trim().slice(0, 80);
      if (!displayName) throw new Error('Nome de exibição obrigatório.');
      const updated: UserRow = {
        ...current,
        displayName,
        department: input.department === undefined ? current.department : input.department.trim().slice(0, 80),
        disabled: input.disabled === undefined ? current.disabled : input.disabled ? 1 : 0,
        role: input.role === undefined ? current.role : input.role,
        updatedAt: Date.now()
      };
      const result = this.db.prepare(`
        UPDATE users SET displayName=@displayName, department=@department, disabled=@disabled,
          role=@role, updatedAt=@updatedAt WHERE userId=@userId
      `).run(updated);
      if (result.changes !== 1) throw new Error('A conta não pôde ser atualizada.');
      if (updated.disabled) this.revokeUserSessions(userId);
      if (updated.disabled || updated.role !== 'admin') {
        this.db.prepare('DELETE FROM admin_sessions WHERE userId = ?').run(userId);
      }
      this.appendAudit('user.management_updated', actor, userId, {
        displayName: updated.displayName,
        department: updated.department,
        disabled: Boolean(updated.disabled),
        role: updated.role
      });
      const persisted = this.db.prepare('SELECT * FROM users WHERE userId = ?').get(userId) as UserRow | undefined;
      if (!persisted || persisted.displayName !== updated.displayName || persisted.department !== updated.department ||
          persisted.disabled !== updated.disabled || persisted.role !== updated.role) {
        throw new Error('O Relay não confirmou a persistência das alterações.');
      }
      return this.toUser(persisted);
    })();
  }

  setUserRole(userId: string, role: 'admin' | 'user', actor = 'relay-ui'): CentralUser {
    const result = this.db.prepare('UPDATE users SET role = ?, updatedAt = ? WHERE userId = ?')
      .run(role, Date.now(), userId);
    if (result.changes === 0) throw new Error('Usuário não encontrado.');
    if (role !== 'admin') this.db.prepare('DELETE FROM admin_sessions WHERE userId = ?').run(userId);
    this.appendAudit('user.role_changed', actor, userId, { role });
    return this.getUser(userId)!;
  }

  getAnnouncementTtlMs(): number {
    const configured = Number(this.getSetting('announcements.ttl_ms'));
    return Number.isFinite(configured) && configured >= 60_000
      ? Math.min(Math.trunc(configured), 365 * 24 * 60 * 60 * 1000)
      : 24 * 60 * 60 * 1000;
  }

  setAnnouncementTtlMs(ttlMs: number, actor = 'relay-ui'): number {
    const normalized = Math.trunc(Number(ttlMs));
    if (!Number.isFinite(normalized) || normalized < 60_000 || normalized > 365 * 24 * 60 * 60 * 1000) {
      throw new Error('A expiração deve ficar entre 1 minuto e 365 dias.');
    }
    this.setSetting('announcements.ttl_ms', String(normalized));
    this.appendAudit('announcements.ttl_changed', actor, null, { ttlMs: normalized });
    return normalized;
  }

  completeProfileSetup(userId: string, input: { avatarEmoji: string; avatarBg: string }): CentralUser {
    const avatarEmoji = input.avatarEmoji.trim().slice(0, 16);
    const avatarBg = input.avatarBg.trim();
    if (!avatarEmoji) throw new Error('Escolha um emoji para o perfil.');
    if (!/^#[0-9a-fA-F]{6}$/.test(avatarBg)) throw new Error('Escolha uma cor válida para o perfil.');
    const result = this.db.prepare(`
      UPDATE users
      SET avatarEmoji = ?, avatarBg = ?, profileSetupCompleted = 1, updatedAt = ?
      WHERE userId = ? AND disabled = 0
    `).run(avatarEmoji, avatarBg, Date.now(), userId);
    if (result.changes === 0) throw new Error('Usuário não encontrado.');
    this.appendAudit('user.profile_setup_completed', userId, userId);
    return this.getUser(userId)!;
  }

  getUserPreferences(userId: string): {
    conversations: Array<{ conversationId: string; pinned: boolean; archived: boolean; manualUnread: boolean; readAt: number; updatedAt: number }>;
    messages: Array<{ messageId: string; favorite: boolean; hidden: boolean; updatedAt: number }>;
  } {
    const conversations = this.db.prepare(`
      SELECT conversationId, pinned, archived, manualUnread, readAt, updatedAt
      FROM user_conversation_preferences WHERE userId = ? ORDER BY updatedAt DESC
    `).all(userId) as Array<{ conversationId: string; pinned: number; archived: number; manualUnread: number; readAt: number; updatedAt: number }>;
    const messages = this.db.prepare(`
      SELECT messageId, favorite, hidden, updatedAt
      FROM user_message_preferences WHERE userId = ? AND (favorite = 1 OR hidden = 1)
      ORDER BY updatedAt DESC
    `).all(userId) as Array<{ messageId: string; favorite: number; hidden: number; updatedAt: number }>;
    return {
      conversations: conversations.map((row) => ({ ...row, pinned: Boolean(row.pinned), archived: Boolean(row.archived), manualUnread: Boolean(row.manualUnread) })),
      messages: messages.map((row) => ({ ...row, favorite: Boolean(row.favorite), hidden: Boolean(row.hidden) }))
    };
  }

  setUserConversationPreference(userId: string, input: {
    conversationId: string;
    pinned?: boolean;
    archived?: boolean;
    manualUnread?: boolean;
    readAt?: number;
  }): void {
    const conversationId = input.conversationId.trim();
    if (!conversationId) throw new Error('Conversa inválida.');
    const current = this.db.prepare(`
      SELECT pinned, archived, manualUnread, readAt FROM user_conversation_preferences
      WHERE userId = ? AND conversationId = ?
    `).get(userId, conversationId) as { pinned: number; archived: number; manualUnread: number; readAt: number } | undefined;
    this.db.prepare(`
      INSERT INTO user_conversation_preferences(userId, conversationId, pinned, archived, manualUnread, readAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(userId, conversationId) DO UPDATE SET
        pinned=excluded.pinned, archived=excluded.archived, manualUnread=excluded.manualUnread,
        readAt=excluded.readAt, updatedAt=excluded.updatedAt
    `).run(
      userId,
      conversationId,
      input.pinned === undefined ? current?.pinned || 0 : input.pinned ? 1 : 0,
      input.archived === undefined ? current?.archived || 0 : input.archived ? 1 : 0,
      input.manualUnread === undefined ? current?.manualUnread || 0 : input.manualUnread ? 1 : 0,
      input.readAt === undefined ? current?.readAt || 0 : Math.max(0, Math.trunc(input.readAt)),
      Date.now()
    );
  }

  setUserMessagePreference(userId: string, input: { messageId: string; favorite?: boolean; hidden?: boolean }): void {
    const messageId = input.messageId.trim();
    if (!messageId) throw new Error('Mensagem inválida.');
    const current = this.db.prepare(`
      SELECT favorite, hidden FROM user_message_preferences WHERE userId = ? AND messageId = ?
    `).get(userId, messageId) as { favorite: number; hidden: number } | undefined;
    const favorite = input.favorite === undefined ? current?.favorite || 0 : input.favorite ? 1 : 0;
    const hidden = input.hidden === undefined ? current?.hidden || 0 : input.hidden ? 1 : 0;
    if (!favorite && !hidden) {
      this.db.prepare('DELETE FROM user_message_preferences WHERE userId = ? AND messageId = ?').run(userId, messageId);
      return;
    }
    this.db.prepare(`
      INSERT INTO user_message_preferences(userId, messageId, favorite, hidden, updatedAt)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(userId, messageId) DO UPDATE SET favorite=excluded.favorite, hidden=excluded.hidden, updatedAt=excluded.updatedAt
    `).run(userId, messageId, favorite, hidden, Date.now());
  }

  exportConversationMessages(userId: string, peerUserId: string): CanonicalExportMessage[] {
    if (!this.getUser(userId) || !this.getUser(peerUserId)) throw new Error('Conversa canônica inválida.');
    const hiddenRows = this.db.prepare(`
      SELECT messageId FROM user_message_preferences WHERE userId = ? AND hidden = 1
    `).all(userId) as Array<{ messageId: string }>;
    const hidden = new Set(hiddenRows.map((row) => row.messageId));
    const rows = this.db.prepare(`
      SELECT messageId, type, senderUserId, payloadCipher, createdAt
      FROM canonical_frames
      LEFT JOIN user_conversation_state state ON state.userId = ? AND state.peerUserId = ?
      WHERE deletedAt IS NULL AND createdAt > COALESCE(state.clearedAt, 0)
        AND ((senderUserId = ? AND targetUserId = ?) OR (senderUserId = ? AND targetUserId = ?))
      ORDER BY createdAt ASC, messageId ASC
    `).all(userId, peerUserId, userId, peerUserId, peerUserId, userId) as Array<{
      messageId: string; type: string; senderUserId: string; payloadCipher: string; createdAt: number;
    }>;
    const messages = new Map<string, CanonicalExportMessage>();
    for (const row of rows) {
      const payload = JSON.parse(this.encrypted.decrypt(row.payloadCipher)) as Record<string, unknown>;
      if (row.type === 'chat:text') {
        messages.set(row.messageId, {
          messageId: row.messageId,
          senderUserId: row.senderUserId,
          type: 'text',
          text: typeof payload.text === 'string' ? payload.text : '',
          fileName: '', fileSize: 0, createdAt: row.createdAt, editedAt: 0
        });
      } else if (row.type === 'file:offer') {
        messages.set(row.messageId, {
          messageId: row.messageId,
          senderUserId: row.senderUserId,
          type: 'file', text: '',
          fileName: typeof payload.filename === 'string' ? payload.filename : 'Arquivo',
          fileSize: typeof payload.size === 'number' ? payload.size : 0,
          createdAt: row.createdAt, editedAt: 0
        });
      } else if (row.type === 'chat:edit') {
        const target = typeof payload.targetMessageId === 'string' ? payload.targetMessageId : '';
        const message = messages.get(target);
        if (message && typeof payload.text === 'string') {
          message.text = payload.text;
          message.editedAt = typeof payload.editedAt === 'number' ? payload.editedAt : row.createdAt;
        }
      } else if (row.type === 'chat:delete') {
        const target = typeof payload.targetMessageId === 'string' ? payload.targetMessageId : '';
        messages.delete(target);
      }
    }
    return Array.from(messages.values()).filter((message) => !hidden.has(message.messageId));
  }

  resetPassword(userId: string, password: string, actor = 'admin'): void {
    const result = this.db.prepare('UPDATE users SET passwordHash = ?, updatedAt = ? WHERE userId = ?')
      .run(hashPassword(password), Date.now(), userId);
    if (result.changes === 0) throw new Error('Usuário não encontrado.');
    this.revokeUserSessions(userId);
    this.db.prepare('DELETE FROM admin_sessions WHERE userId = ?').run(userId);
    this.appendAudit('user.password_reset', actor, userId);
  }

  changePassword(userId: string, currentPassword: string, newPassword: string, currentToken: string): void {
    const row = this.db.prepare('SELECT passwordHash FROM users WHERE userId = ? AND disabled = 0')
      .get(userId) as { passwordHash: string } | undefined;
    if (!row || !verifyPassword(currentPassword, row.passwordHash)) {
      throw new Error('A senha atual está incorreta.');
    }
    this.db.prepare('UPDATE users SET passwordHash = ?, updatedAt = ? WHERE userId = ?')
      .run(hashPassword(newPassword), Date.now(), userId);
    this.db.prepare(`
      UPDATE sessions SET revokedAt = ?
      WHERE userId = ? AND tokenHash != ? AND revokedAt IS NULL
    `).run(Date.now(), userId, hashToken(currentToken));
    this.appendAudit('user.password_changed', userId, userId);
  }

  requestPasswordReset(usernameInput: string): { token: string; requestId: string } | null {
    const username = usernameInput.trim().toLowerCase();
    const user = this.db.prepare('SELECT userId FROM users WHERE username = ? COLLATE NOCASE AND disabled = 0')
      .get(username) as { userId: string } | undefined;
    if (!user) return null;
    const now = Date.now();
    this.db.prepare(`
      UPDATE password_reset_requests
      SET status = 'expired', reviewedAt = COALESCE(reviewedAt, ?)
      WHERE userId = ? AND status IN ('pending', 'approved')
    `).run(now, user.userId);
    const requestId = randomUUID();
    const token = createSessionToken();
    this.db.prepare(`
      INSERT INTO password_reset_requests(requestId, userId, tokenHash, status, requestedAt)
      VALUES (?, ?, ?, 'pending', ?)
    `).run(requestId, user.userId, hashToken(token), now);
    this.appendAudit('password_reset.requested', user.userId, requestId);
    return { token, requestId };
  }

  getPasswordResetStatus(token: string): 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired' | 'invalid' {
    if (!token) return 'invalid';
    const row = this.db.prepare(`
      SELECT requestId, status, expiresAt FROM password_reset_requests WHERE tokenHash = ?
    `).get(hashToken(token)) as { requestId: string; status: PasswordResetRequest['status']; expiresAt: number | null } | undefined;
    if (!row) return 'invalid';
    if (row.status === 'approved' && (!row.expiresAt || row.expiresAt <= Date.now())) {
      this.db.prepare("UPDATE password_reset_requests SET status = 'expired' WHERE requestId = ?")
        .run(row.requestId);
      return 'expired';
    }
    return row.status;
  }

  completePasswordReset(token: string, usernameInput: string, password: string): void {
    const username = usernameInput.trim().toLowerCase();
    const now = Date.now();
    const row = this.db.prepare(`
      SELECT requests.requestId, requests.userId, requests.status, requests.expiresAt, users.username
      FROM password_reset_requests requests
      JOIN users ON users.userId = requests.userId
      WHERE requests.tokenHash = ? AND users.disabled = 0
    `).get(hashToken(token)) as {
      requestId: string; userId: string; status: string; expiresAt: number | null; username: string;
    } | undefined;
    if (!row || row.username.toLowerCase() !== username || row.status !== 'approved' || !row.expiresAt || row.expiresAt <= now) {
      throw new Error('A solicitação não foi aprovada ou expirou.');
    }
    const transaction = this.db.transaction(() => {
      this.db.prepare('UPDATE users SET passwordHash = ?, updatedAt = ? WHERE userId = ?')
        .run(hashPassword(password), now, row.userId);
      this.db.prepare(`
        UPDATE password_reset_requests SET status = 'consumed', consumedAt = ? WHERE requestId = ?
      `).run(now, row.requestId);
      this.revokeUserSessions(row.userId);
    });
    transaction();
    this.appendAudit('password_reset.completed', row.userId, row.requestId);
  }

  listPasswordResetRequests(): PasswordResetRequest[] {
    const now = Date.now();
    this.db.prepare(`
      UPDATE password_reset_requests SET status = 'expired'
      WHERE status = 'approved' AND expiresAt IS NOT NULL AND expiresAt <= ?
    `).run(now);
    return this.db.prepare(`
      SELECT requests.requestId, requests.userId, users.username, users.displayName,
        requests.status, requests.requestedAt, requests.reviewedAt, requests.expiresAt, requests.consumedAt
      FROM password_reset_requests requests
      JOIN users ON users.userId = requests.userId
      WHERE requests.status IN ('pending', 'approved')
      ORDER BY requests.status = 'pending' DESC, requests.requestedAt ASC
    `).all() as PasswordResetRequest[];
  }

  reviewPasswordResetRequest(requestId: string, approve: boolean, actor: string): PasswordResetRequest {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE password_reset_requests
      SET status = ?, reviewedAt = ?, reviewedBy = ?, expiresAt = ?
      WHERE requestId = ? AND status = 'pending'
    `).run(approve ? 'approved' : 'rejected', now, actor, approve ? now + PASSWORD_RESET_APPROVAL_TTL_MS : null, requestId);
    if (result.changes === 0) throw new Error('Solicitação não encontrada ou já analisada.');
    this.appendAudit(approve ? 'password_reset.approved' : 'password_reset.rejected', actor, requestId);
    const request = this.listPasswordResetRequests().find((entry) => entry.requestId === requestId);
    if (request) return request;
    const fallback = this.db.prepare(`
      SELECT requests.requestId, requests.userId, users.username, users.displayName,
        requests.status, requests.requestedAt, requests.reviewedAt, requests.expiresAt, requests.consumedAt
      FROM password_reset_requests requests JOIN users ON users.userId = requests.userId
      WHERE requests.requestId = ?
    `).get(requestId) as PasswordResetRequest | undefined;
    if (!fallback) throw new Error('Solicitação não encontrada.');
    return fallback;
  }

  deleteUser(userId: string, actor = 'admin'): void {
    const user = this.getUser(userId);
    if (!user) return;
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
    this.db.prepare('DELETE FROM admin_sessions WHERE userId = ?').run(userId);
    this.appendAudit('user.deleted', actor, userId, { previousUsername: user.username });
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
    this.appendAudit('session.created', row.userId, deviceId.trim() || 'unknown');
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

  listSessions(includeRevoked = false): CentralSessionInfo[] {
    const rows = this.db.prepare(`
      SELECT sessions.tokenHash, sessions.userId, users.username, users.displayName,
        sessions.deviceId, sessions.createdAt, sessions.lastSeenAt,
        sessions.expiresAt, sessions.revokedAt
      FROM sessions JOIN users ON users.userId = sessions.userId
      WHERE (? = 1 OR sessions.revokedAt IS NULL)
      ORDER BY sessions.revokedAt IS NULL DESC, sessions.lastSeenAt DESC
      LIMIT 500
    `).all(includeRevoked ? 1 : 0) as Array<{
      tokenHash: string; userId: string; username: string; displayName: string;
      deviceId: string; createdAt: number; lastSeenAt: number; expiresAt: number;
      revokedAt: number | null;
    }>;
    return rows.map(({ tokenHash, ...row }) => ({ sessionId: tokenHash, ...row }));
  }

  revokeSession(sessionId: string, actor = 'admin'): boolean {
    const result = this.db.prepare(
      'UPDATE sessions SET revokedAt = ? WHERE tokenHash = ? AND revokedAt IS NULL'
    ).run(Date.now(), sessionId);
    if (result.changes > 0) this.appendAudit('session.revoked', actor, sessionId.slice(0, 16));
    return result.changes > 0;
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
    this.db.prepare('INSERT INTO admin_sessions(tokenHash, userId, csrfToken, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?)')
      .run(hashToken(adminToken), auth.user.userId, csrfToken, now, now + 8 * 60 * 60 * 1000);
    this.logout(auth.token);
    this.appendAudit('admin.login', auth.user.userId, 'relay-dashboard');
    return { token: adminToken, csrfToken };
  }

  validateAdminSession(token: string, csrfToken?: string): boolean {
    return Boolean(this.getAdminSession(token, csrfToken));
  }

  getAdminSession(token: string, csrfToken?: string): { userId: string; csrfToken: string } | null {
    if (!token) return null;
    const row = this.db.prepare('SELECT userId, csrfToken FROM admin_sessions WHERE tokenHash = ? AND expiresAt > ?')
      .get(hashToken(token), Date.now()) as { userId: string; csrfToken: string } | undefined;
    if (!row) return null;
    if (csrfToken !== undefined && !(csrfToken.length > 0 && row.csrfToken === csrfToken)) return null;
    return { userId: row.userId || 'admin', csrfToken: row.csrfToken };
  }

  getRetentionPolicy(): RetentionPolicy {
    return normalizeRetention(this.getSetting('retention.policy'));
  }

  getRetentionCutoff(now = Date.now()): number | null {
    const policy = this.getRetentionPolicy();
    if (policy === 'forever') return null;
    const ageMs = policy === '1_month'
      ? 30 * 86400000
      : policy === '6_months'
        ? 183 * 86400000
        : 365 * 86400000;
    return now - ageMs;
  }

  setRetentionPolicy(policy: RetentionPolicy, actor = 'admin'): RetentionPolicy {
    const normalized = normalizeRetention(policy);
    this.setSetting('retention.policy', normalized);
    this.appendAudit('retention.updated', actor, normalized);
    return normalized;
  }

  async createBackup(sources: BackupSource[] = [], actor = 'admin'): Promise<CanonicalBackup> {
    const backup = await new BackupService(
      this.dataDir,
      async (destination) => { await this.db.backup(destination); }
    ).create(sources);
    this.appendAudit('backup.created', actor, backup.file, {
      size: backup.size,
      files: backup.files
    });
    return backup;
  }

  listAudit(limit = 100): AuditEntry[] {
    const rows = this.db.prepare(`
      SELECT id, action, actor, target, detailsCipher, createdAt
      FROM audit_log ORDER BY createdAt DESC, id DESC LIMIT ?
    `).all(Math.max(1, Math.min(Math.trunc(limit) || 100, 500))) as Array<{
      id: number; action: string; actor: string; target: string | null;
      detailsCipher: string; createdAt: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      actor: row.actor,
      target: row.target,
      details: JSON.parse(this.encrypted.decrypt(row.detailsCipher)) as Record<string, unknown>,
      createdAt: row.createdAt
    }));
  }

  saveFrame(frame: CanonicalFrame): 'inserted' | 'duplicate' {
    const payloadCipher = this.encrypted.encrypt(JSON.stringify(frame.payload ?? null));
    const result = this.db.transaction(() => {
      const inserted = this.db.prepare(`
        INSERT INTO canonical_frames(messageId, type, senderUserId, targetUserId, conversationId,
          payloadCipher, createdAt, deletedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(messageId) DO NOTHING
      `).run(frame.messageId, frame.type, frame.senderUserId, frame.targetUserId, frame.conversationId, payloadCipher, frame.createdAt);
      if (inserted.changes > 0) {
        this.db.prepare('INSERT INTO canonical_frame_sequence(messageId) VALUES (?)').run(frame.messageId);
      }
      return inserted;
    })();
    if (result.changes > 0) {
      this.applyFrameSearchDocument(frame);
      return 'inserted';
    }

    const existing = this.db.prepare(`
      SELECT type, senderUserId, targetUserId, conversationId, payloadCipher, createdAt
      FROM canonical_frames WHERE messageId = ?
    `).get(frame.messageId) as Omit<CanonicalFrame, 'messageId' | 'payload'> & { payloadCipher: string } | undefined;
    const same = existing && existing.type === frame.type && existing.senderUserId === frame.senderUserId &&
      existing.targetUserId === frame.targetUserId && existing.conversationId === frame.conversationId &&
      existing.createdAt === frame.createdAt &&
      JSON.stringify(JSON.parse(this.encrypted.decrypt(existing.payloadCipher))) === JSON.stringify(frame.payload ?? null);
    if (!same) throw new Error('messageId já utilizado por outro frame canônico.');
    return 'duplicate';
  }

  getFrameServerSeq(messageId: string): number | null {
    const row = this.db.prepare(`
      SELECT serverSeq FROM canonical_frame_sequence WHERE messageId = ?
    `).get(messageId) as { serverSeq: number } | undefined;
    return row && Number.isFinite(row.serverSeq) ? row.serverSeq : null;
  }

  listFramesForUser(userId: string, after = 0, limit = 500): CanonicalFrame[] {
    const rows = this.db.prepare(`
      SELECT canonical_frames.messageId, canonical_frames.type, canonical_frames.senderUserId,
        canonical_frames.targetUserId, canonical_frames.conversationId,
        canonical_frames.payloadCipher, canonical_frames.createdAt
      FROM canonical_frames
      LEFT JOIN user_conversation_state state ON state.userId = ? AND state.peerUserId =
        CASE WHEN canonical_frames.senderUserId = ? THEN canonical_frames.targetUserId
             ELSE canonical_frames.senderUserId END
      WHERE deletedAt IS NULL AND createdAt > ?
        AND createdAt > COALESCE(state.clearedAt, 0)
        AND (senderUserId = ? OR targetUserId = ? OR targetUserId IS NULL)
      ORDER BY createdAt ASC, messageId ASC LIMIT ?
    `).all(userId, userId, Math.max(0, after), userId, userId, Math.max(1, Math.min(limit, 100_000))) as Array<{
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

  listFramesForUserAfterSeq(userId: string, afterSeq = 0, limit = 500): CanonicalFrame[] {
    const safeAfterSeq = Math.max(0, Math.trunc(afterSeq) || 0);
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 500, 1_000));
    const rows = this.db.prepare(`
      SELECT sequence.serverSeq, frame.messageId, frame.type, frame.senderUserId,
        frame.targetUserId, frame.conversationId, frame.payloadCipher, frame.createdAt
      FROM canonical_frame_sequence sequence
      JOIN canonical_frames frame ON frame.messageId = sequence.messageId
      LEFT JOIN user_conversation_state state ON state.userId = ? AND state.peerUserId =
        CASE WHEN frame.senderUserId = ? THEN frame.targetUserId ELSE frame.senderUserId END
      WHERE sequence.serverSeq > ?
        AND frame.deletedAt IS NULL
        AND frame.targetUserId IS NOT NULL
        AND frame.createdAt > COALESCE(state.clearedAt, 0)
        AND (frame.senderUserId = ? OR frame.targetUserId = ?)
      ORDER BY sequence.serverSeq ASC
      LIMIT ?
    `).all(userId, userId, safeAfterSeq, userId, userId, safeLimit) as Array<{
      serverSeq: number; messageId: string; type: string; senderUserId: string;
      targetUserId: string | null; conversationId: string; payloadCipher: string; createdAt: number;
    }>;
    return rows.map((row) => ({
      serverSeq: row.serverSeq,
      messageId: row.messageId,
      type: row.type,
      senderUserId: row.senderUserId,
      targetUserId: row.targetUserId,
      conversationId: row.conversationId,
      createdAt: row.createdAt,
      payload: JSON.parse(this.encrypted.decrypt(row.payloadCipher))
    }));
  }

  getFrameSequenceHighWaterMark(): number {
    const row = this.db.prepare('SELECT MAX(serverSeq) AS serverSeq FROM canonical_frame_sequence').get() as {
      serverSeq: number | null;
    };
    return typeof row.serverSeq === 'number' ? row.serverSeq : 0;
  }

  listAnnouncementFrames(): CanonicalFrame[] {
    const rows = this.db.prepare(`
      SELECT messageId, type, senderUserId, targetUserId, conversationId,
        payloadCipher, createdAt
      FROM canonical_frames
      WHERE deletedAt IS NULL
        AND conversationId = 'announcements'
        AND targetUserId IS NULL
        AND type IN ('announce', 'file:offer')
      ORDER BY createdAt ASC, messageId ASC
    `).all() as Array<{
      messageId: string;
      type: string;
      senderUserId: string;
      targetUserId: string | null;
      conversationId: string;
      payloadCipher: string;
      createdAt: number;
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

  listConversationFramesForUser(
    userId: string,
    peerUserId: string,
    before = Number.MAX_SAFE_INTEGER,
    limit = 100,
    beforeSeq = Number.MAX_SAFE_INTEGER
  ): CanonicalFrame[] {
    const safeBefore = Number.isFinite(before) ? Math.max(1, Math.trunc(before)) : Number.MAX_SAFE_INTEGER;
    const safeBeforeSeq = Number.isFinite(beforeSeq)
      ? Math.max(1, Math.trunc(beforeSeq))
      : Number.MAX_SAFE_INTEGER;
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 100, 500));
    const rows = this.db.prepare(`
      SELECT sequence.serverSeq, canonical_frames.messageId, canonical_frames.type, canonical_frames.senderUserId,
        canonical_frames.targetUserId, canonical_frames.conversationId,
        canonical_frames.payloadCipher, canonical_frames.createdAt
      FROM canonical_frames
      JOIN canonical_frame_sequence sequence ON sequence.messageId = canonical_frames.messageId
      LEFT JOIN user_conversation_state state
        ON state.userId = ? AND state.peerUserId = ?
      WHERE canonical_frames.deletedAt IS NULL
        AND (
          (? < ${Number.MAX_SAFE_INTEGER} AND sequence.serverSeq < ?)
          OR (? = ${Number.MAX_SAFE_INTEGER} AND canonical_frames.createdAt < ?)
        )
        AND canonical_frames.createdAt > COALESCE(state.clearedAt, 0)
        AND ((canonical_frames.senderUserId = ? AND canonical_frames.targetUserId = ?)
          OR (canonical_frames.senderUserId = ? AND canonical_frames.targetUserId = ?))
      ORDER BY sequence.serverSeq DESC
      LIMIT ?
    `).all(
      userId,
      peerUserId,
      safeBeforeSeq,
      safeBeforeSeq,
      safeBeforeSeq,
      safeBefore,
      userId,
      peerUserId,
      peerUserId,
      userId,
      safeLimit
    ) as Array<{
      serverSeq: number; messageId: string; type: string; senderUserId: string; targetUserId: string | null;
      conversationId: string; payloadCipher: string; createdAt: number;
    }>;
    return rows.reverse().map((row) => ({
      serverSeq: row.serverSeq,
      messageId: row.messageId,
      type: row.type,
      senderUserId: row.senderUserId,
      targetUserId: row.targetUserId,
      conversationId: row.conversationId,
      createdAt: row.createdAt,
      payload: JSON.parse(this.encrypted.decrypt(row.payloadCipher))
    }));
  }

  listLatestConversationFramesForUser(userId: string, limit = 500): CanonicalFrame[] {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 500, 1_000));
    const rows = this.db.prepare(`
      WITH visible AS (
        SELECT sequence.serverSeq, canonical_frames.messageId, canonical_frames.type,
          canonical_frames.senderUserId, canonical_frames.targetUserId,
          canonical_frames.conversationId, canonical_frames.payloadCipher,
          canonical_frames.createdAt,
          CASE WHEN canonical_frames.senderUserId = ? THEN canonical_frames.targetUserId
               ELSE canonical_frames.senderUserId END AS peerUserId
        FROM canonical_frames
        JOIN canonical_frame_sequence sequence ON sequence.messageId = canonical_frames.messageId
        LEFT JOIN user_conversation_state state ON state.userId = ? AND state.peerUserId =
          CASE WHEN canonical_frames.senderUserId = ? THEN canonical_frames.targetUserId
               ELSE canonical_frames.senderUserId END
        WHERE canonical_frames.deletedAt IS NULL
          AND canonical_frames.targetUserId IS NOT NULL
          AND canonical_frames.type IN ('chat:text', 'file:offer')
          AND canonical_frames.createdAt > COALESCE(state.clearedAt, 0)
          AND (canonical_frames.senderUserId = ? OR canonical_frames.targetUserId = ?)
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY peerUserId ORDER BY createdAt DESC, messageId DESC
        ) AS rowNumber
        FROM visible
      )
      SELECT serverSeq, messageId, type, senderUserId, targetUserId, conversationId, payloadCipher, createdAt
      FROM ranked
      WHERE rowNumber = 1
      ORDER BY createdAt DESC, messageId DESC
      LIMIT ?
    `).all(userId, userId, userId, userId, userId, safeLimit) as Array<{
      serverSeq: number; messageId: string; type: string; senderUserId: string; targetUserId: string | null;
      conversationId: string; payloadCipher: string; createdAt: number;
    }>;
    return rows.map((row) => ({
      serverSeq: row.serverSeq,
      messageId: row.messageId,
      type: row.type,
      senderUserId: row.senderUserId,
      targetUserId: row.targetUserId,
      conversationId: row.conversationId,
      createdAt: row.createdAt,
      payload: JSON.parse(this.encrypted.decrypt(row.payloadCipher))
    }));
  }

  searchConversationMessageIds(
    userId: string,
    peerUserId: string,
    query: string,
    limit = 500,
    offset = 0
  ): string[] {
    const needle = this.normalizeSearchText(query.trim());
    if (!needle) return [];
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 500, 2_000));
    const safeOffset = Math.max(0, Math.trunc(offset) || 0);
    const conversationId = `dm:${[userId, peerUserId].sort((a, b) => a.localeCompare(b)).join(':')}`;
    const grams = this.searchGrams(needle);
    const rows = grams.length > 0
      ? this.db.prepare(`
          SELECT document.messageId, document.textCipher
          FROM canonical_search_documents document
          JOIN canonical_search_tokens token ON token.messageId = document.messageId
          WHERE document.conversationId = ? AND token.tokenHash IN (${grams.map(() => '?').join(',')})
          GROUP BY document.messageId
          HAVING COUNT(DISTINCT token.tokenHash) = ?
          ORDER BY document.createdAt, document.messageId
        `).all(conversationId, ...grams.map((gram) => this.encrypted.blindIndex(gram)), grams.length)
      : this.db.prepare(`
          SELECT messageId, textCipher FROM canonical_search_documents
          WHERE conversationId = ? ORDER BY createdAt, messageId
        `).all(conversationId);
    const matches = (rows as Array<{ messageId: string; textCipher: string }>)
      .filter((row) => this.encrypted.decrypt(row.textCipher).includes(needle))
      .map((row) => row.messageId);
    return matches.slice(safeOffset, safeOffset + safeLimit);
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
    if (existing) {
      if (existing.ownerUserId !== input.ownerUserId || existing.messageId !== input.messageId ||
          existing.conversationId !== input.conversationId || existing.size !== input.size ||
          existing.sha256 !== input.sha256) {
        throw new Error('attachmentId já utilizado por outro anexo canônico.');
      }
      return { nextIndex: existing.receivedChunks, totalChunks: existing.totalChunks };
    }
    this.db.prepare(`
      INSERT INTO attachments(attachmentId, messageId, ownerUserId, conversationId, fileNameCipher,
        mimeType, size, sha256, totalChunks, receivedChunks, complete, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
    `).run(input.attachmentId, input.messageId, input.ownerUserId, input.conversationId,
      this.encrypted.encrypt(input.fileName), input.mimeType || 'application/octet-stream', input.size,
      input.sha256, totalChunks, Date.now());
    this.chunks.prepare(input.attachmentId);
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
    if (index < row.receivedChunks && this.chunks.has(index, attachmentId)) return;
    if (index !== row.receivedChunks) throw new Error('Chunk fora de ordem.');
    this.chunks.write(index, data, attachmentId);
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

  listConversationMedia(
    userId: string,
    peerUserId: string,
    kind: ConversationMediaKind,
    cursor: ConversationMediaCursor | null = null,
    limit = 40
  ): ConversationMediaPage {
    if (!this.getUser(userId) || !this.getUser(peerUserId)) {
      throw new Error('Conversa canônica inválida.');
    }
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 40, 100));
    const result: ConversationMediaPage['items'] = [];
    let beforeCreatedAt = cursor?.createdAt && Number.isFinite(cursor.createdAt)
      ? Math.max(1, Math.trunc(cursor.createdAt))
      : Number.MAX_SAFE_INTEGER;
    let beforeMessageId = cursor?.messageId?.trim() || '\uffff';
    let exhausted = false;

    while (result.length <= safeLimit && !exhausted) {
      const rows = this.db.prepare(`
        SELECT attachment.attachmentId, attachment.messageId, attachment.fileNameCipher,
          attachment.mimeType, attachment.size, frame.senderUserId, frame.createdAt
        FROM attachments attachment
        JOIN canonical_frames frame ON frame.messageId = attachment.messageId
        LEFT JOIN user_conversation_state state
          ON state.userId = ? AND state.peerUserId = ?
        LEFT JOIN user_message_preferences preference
          ON preference.userId = ? AND preference.messageId = frame.messageId
        WHERE attachment.complete = 1
          AND frame.deletedAt IS NULL
          AND frame.type = 'file:offer'
          AND frame.createdAt > COALESCE(state.clearedAt, 0)
          AND COALESCE(preference.hidden, 0) = 0
          AND ((frame.senderUserId = ? AND frame.targetUserId = ?)
            OR (frame.senderUserId = ? AND frame.targetUserId = ?))
          AND (frame.createdAt < ? OR (frame.createdAt = ? AND frame.messageId < ?))
        ORDER BY frame.createdAt DESC, frame.messageId DESC
        LIMIT 200
      `).all(
        userId, peerUserId, userId,
        userId, peerUserId, peerUserId, userId,
        beforeCreatedAt, beforeCreatedAt, beforeMessageId
      ) as Array<{
        attachmentId: string; messageId: string; fileNameCipher: string; mimeType: string;
        size: number; senderUserId: string; createdAt: number;
      }>;
      exhausted = rows.length < 200;
      if (rows.length === 0) {
        exhausted = true;
        break;
      }
      const oldest = rows[rows.length - 1];
      beforeCreatedAt = oldest.createdAt;
      beforeMessageId = oldest.messageId;
      for (const row of rows) {
        const fileName = this.encrypted.decrypt(row.fileNameCipher);
        const itemKind = mediaKindFor(row.mimeType, fileName);
        if (itemKind !== kind) continue;
        result.push({
          messageId: row.messageId,
          fileId: row.attachmentId,
          fileName,
          fileSize: row.size,
          mimeType: row.mimeType,
          senderUserId: row.senderUserId,
          createdAt: row.createdAt,
          kind: itemKind
        });
        if (result.length > safeLimit) break;
      }
    }

    const items = result.slice(0, safeLimit);
    const last = items[items.length - 1];
    return {
      items,
      hasMore: result.length > safeLimit || !exhausted,
      nextCursor: last ? { createdAt: last.createdAt, messageId: last.messageId } : null
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
    const cutoff = this.getRetentionCutoff();
    if (cutoff === null) return { framesDeleted: 0, attachmentsDeleted: 0 };
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
    for (const row of attachmentRows) this.chunks.remove(row.attachmentId);
    return { framesDeleted, attachmentsDeleted: attachmentRows.length };
  }

  purgeAnnouncementFrames(messageIds: string[]): { framesDeleted: number; attachmentsDeleted: number } {
    const ids = Array.from(new Set(messageIds.map((id) => id.trim()).filter(Boolean)));
    if (ids.length === 0) return { framesDeleted: 0, attachmentsDeleted: 0 };
    const placeholders = ids.map(() => '?').join(', ');
    const attachments = this.db.prepare(`
      SELECT attachmentId FROM attachments
      WHERE conversationId = 'announcements' AND messageId IN (${placeholders})
    `).all(...ids) as Array<{ attachmentId: string }>;
    const framesDeleted = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM attachments WHERE conversationId = 'announcements' AND messageId IN (${placeholders})`).run(...ids);
      this.db.prepare(`DELETE FROM canonical_search_documents WHERE messageId IN (${placeholders})`).run(...ids);
      return this.db.prepare(`DELETE FROM canonical_frames WHERE conversationId = 'announcements' AND messageId IN (${placeholders})`).run(...ids).changes;
    })();
    for (const attachment of attachments) this.chunks.remove(attachment.attachmentId);
    return { framesDeleted, attachmentsDeleted: attachments.length };
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
    return this.chunks.read(index, row.attachmentId);
  }

  private userCanAccessAttachment(userId: string, attachment: AttachmentRow): boolean {
    if (attachment.ownerUserId === userId || attachment.conversationId === 'announcements') return true;
    const frame = this.db.prepare(`
      SELECT senderUserId, targetUserId FROM canonical_frames WHERE messageId = ?
    `).get(attachment.messageId) as { senderUserId: string; targetUserId: string | null } | undefined;
    return Boolean(frame && (frame.senderUserId === userId || frame.targetUserId === userId));
  }

  private searchablePayloadText(value: unknown): string {
    if (typeof value === 'string') return value.toLocaleLowerCase('pt-BR');
    if (!value || typeof value !== 'object') return '';
    if (Array.isArray(value)) return value.map((item) => this.searchablePayloadText(item)).join('\n');
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => ['text', 'bodyText', 'filename', 'fileName'].includes(key))
      .map(([, item]) => this.searchablePayloadText(item))
      .join('\n');
  }

  private normalizeSearchText(value: string): string {
    return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  }

  private searchGrams(value: string): string[] {
    const normalized = this.normalizeSearchText(value).replace(/\s+/g, ' ').trim();
    if (normalized.length < 3) return [];
    return Array.from(new Set(Array.from({ length: normalized.length - 2 }, (_, index) => normalized.slice(index, index + 3))));
  }

  private writeSearchDocument(messageId: string, conversationId: string, text: string, createdAt: number): void {
    const normalized = this.normalizeSearchText(text);
    this.db.prepare(`
      INSERT INTO canonical_search_documents(messageId, conversationId, textCipher, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(messageId) DO UPDATE SET
        conversationId = excluded.conversationId,
        textCipher = excluded.textCipher,
        updatedAt = excluded.updatedAt
    `).run(messageId, conversationId, this.encrypted.encrypt(normalized), createdAt, Date.now());
    this.db.prepare('DELETE FROM canonical_search_tokens WHERE messageId = ?').run(messageId);
    const insert = this.db.prepare('INSERT OR IGNORE INTO canonical_search_tokens(messageId, tokenHash) VALUES (?, ?)');
    for (const gram of this.searchGrams(normalized)) insert.run(messageId, this.encrypted.blindIndex(gram));
  }

  private applyFrameSearchDocument(frame: CanonicalFrame): void {
    const payload = frame.payload && typeof frame.payload === 'object' && !Array.isArray(frame.payload)
      ? frame.payload as Record<string, unknown>
      : {};
    if (frame.type === 'chat:edit') {
      const target = typeof payload.targetMessageId === 'string' ? payload.targetMessageId : '';
      const text = typeof payload.text === 'string' ? payload.text : '';
      if (target) this.writeSearchDocument(target, frame.conversationId, text, frame.createdAt);
      return;
    }
    if (frame.type === 'chat:delete') {
      const target = typeof payload.targetMessageId === 'string' ? payload.targetMessageId : '';
      if (target) this.db.prepare('DELETE FROM canonical_search_documents WHERE messageId = ?').run(target);
      return;
    }
    if (frame.type === 'chat:text' || frame.type === 'file:offer') {
      this.writeSearchDocument(frame.messageId, frame.conversationId, this.searchablePayloadText(frame.payload), frame.createdAt);
    }
  }

  private rebuildGroupSearchDocuments(eventsByGroupId: Record<string, unknown>): void {
    this.db.prepare("DELETE FROM canonical_search_documents WHERE conversationId LIKE 'group:%'").run();
    for (const [groupId, rawEvents] of Object.entries(eventsByGroupId)) {
      if (!Array.isArray(rawEvents)) continue;
      const documents = new Map<string, { text: string; createdAt: number }>();
      for (const raw of rawEvents) {
        const event = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
        const payload = event.payload && typeof event.payload === 'object'
          ? event.payload as Record<string, unknown>
          : {};
        if (event.type === 'group.message.created') {
          const message = payload.message && typeof payload.message === 'object'
            ? payload.message as Record<string, unknown>
            : {};
          if (typeof message.messageId === 'string') {
            documents.set(message.messageId, {
              text: this.searchablePayloadText(message),
              createdAt: Number(message.createdAt) || Number(event.createdAt) || Date.now()
            });
          }
        } else if (event.type === 'group.message.edited') {
          const target = typeof payload.targetMessageId === 'string' ? payload.targetMessageId : '';
          if (target && documents.has(target)) {
            documents.set(target, { text: String(payload.text || ''), createdAt: documents.get(target)!.createdAt });
          }
        } else if (event.type === 'group.message.deletedForEveryone') {
          const target = typeof payload.targetMessageId === 'string' ? payload.targetMessageId : '';
          if (target) documents.delete(target);
        }
      }
      for (const [messageId, document] of documents) {
        this.writeSearchDocument(messageId, `group:${groupId}`, document.text, document.createdAt);
      }
    }
  }

  searchGroupMessageIds(groupId: string, query: string, limit = 500, offset = 0): string[] {
    const needle = this.normalizeSearchText(query.trim());
    if (!needle) return [];
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 500, 2_000));
    const safeOffset = Math.max(0, Math.trunc(offset) || 0);
    const grams = this.searchGrams(needle);
    const rows = grams.length > 0
      ? this.db.prepare(`
          SELECT document.messageId, document.textCipher
          FROM canonical_search_documents document
          JOIN canonical_search_tokens token ON token.messageId = document.messageId
          WHERE document.conversationId = ? AND token.tokenHash IN (${grams.map(() => '?').join(',')})
          GROUP BY document.messageId HAVING COUNT(DISTINCT token.tokenHash) = ?
          ORDER BY document.createdAt, document.messageId
        `).all(`group:${groupId}`, ...grams.map((gram) => this.encrypted.blindIndex(gram)), grams.length)
      : this.db.prepare('SELECT messageId, textCipher FROM canonical_search_documents WHERE conversationId = ? ORDER BY createdAt, messageId').all(`group:${groupId}`);
    return (rows as Array<{ messageId: string; textCipher: string }>)
      .filter((row) => this.encrypted.decrypt(row.textCipher).includes(needle))
      .map((row) => row.messageId)
      .slice(safeOffset, safeOffset + safeLimit);
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

  private appendAudit(
    action: string,
    actor: string,
    target: string | null = null,
    details: Record<string, unknown> = {}
  ): void {
    this.db.prepare(`
      INSERT INTO audit_log(action, actor, target, detailsCipher, createdAt)
      VALUES (?, ?, ?, ?, ?)
    `).run(action, actor, target, this.encrypted.encrypt(JSON.stringify(details)), Date.now());
  }
}
