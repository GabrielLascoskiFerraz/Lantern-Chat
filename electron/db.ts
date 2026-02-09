import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { ANNOUNCEMENTS_CONVERSATION_ID } from './config';
import { runMigrations } from './migrations';
import { AnnouncementReactionSummary, ConversationRow, DbMessage, Peer, Profile } from './types';

const colorFromDeviceId = (deviceId: string): string => {
  const hex = createHash('sha256').update(deviceId).digest('hex').slice(0, 6);
  return `#${hex}`;
};

export class DbService {
  private readonly db: Database.Database;

  constructor(userDataPath: string) {
    const dbPath = path.join(userDataPath, 'lantern.db');
    this.db = new Database(dbPath);
    runMigrations(this.db);
    this.ensureAnnouncementsConversation();
  }

  close(): void {
    this.db.close();
  }

  getProfile(): Profile {
    const row = this.db.prepare('SELECT * FROM profile LIMIT 1').get() as Profile | undefined;
    if (row) {
      return {
        ...row,
        statusMessage: row.statusMessage || 'Disponível'
      };
    }

    const deviceId = randomUUID();
    const now = Date.now();
    const profile: Profile = {
      deviceId,
      displayName: `User ${deviceId.slice(0, 6)}`,
      avatarEmoji: '🙂',
      avatarBg: colorFromDeviceId(deviceId),
      statusMessage: 'Disponível',
      createdAt: now,
      updatedAt: now
    };

    this.db
      .prepare(
        `INSERT INTO profile (deviceId, displayName, avatarEmoji, avatarBg, statusMessage, createdAt, updatedAt)
         VALUES (@deviceId, @displayName, @avatarEmoji, @avatarBg, @statusMessage, @createdAt, @updatedAt)`
      )
      .run(profile);

    return profile;
  }

  updateProfile(input: Pick<Profile, 'displayName' | 'avatarEmoji' | 'avatarBg' | 'statusMessage'>): Profile {
    const profile = this.getProfile();
    const updated: Profile = {
      ...profile,
      ...input,
      updatedAt: Date.now()
    };

    this.db
      .prepare(
        `UPDATE profile
         SET displayName=@displayName, avatarEmoji=@avatarEmoji, avatarBg=@avatarBg, statusMessage=@statusMessage, updatedAt=@updatedAt
         WHERE deviceId=@deviceId`
      )
      .run(updated);

    return updated;
  }

  upsertPeerCache(peer: Peer): void {
    const params = {
      deviceId: peer.deviceId,
      displayName: peer.displayName,
      avatarEmoji: peer.avatarEmoji,
      avatarBg: peer.avatarBg,
      statusMessage: peer.statusMessage,
      lastSeenAt: peer.lastSeenAt || Date.now(),
      lastAddress: peer.address?.trim() || null,
      lastPort: peer.port > 0 ? peer.port : null
    };

    this.db
      .prepare(
        `INSERT INTO peers_cache(deviceId, displayName, avatarEmoji, avatarBg, statusMessage, lastSeenAt, lastAddress, lastPort)
         VALUES (@deviceId, @displayName, @avatarEmoji, @avatarBg, @statusMessage, @lastSeenAt, @lastAddress, @lastPort)
         ON CONFLICT(deviceId) DO UPDATE SET
            displayName = COALESCE(NULLIF(excluded.displayName, ''), peers_cache.displayName),
            avatarEmoji = COALESCE(NULLIF(excluded.avatarEmoji, ''), peers_cache.avatarEmoji),
            avatarBg = COALESCE(NULLIF(excluded.avatarBg, ''), peers_cache.avatarBg),
            statusMessage = COALESCE(excluded.statusMessage, peers_cache.statusMessage),
            lastSeenAt = CASE
              WHEN excluded.lastSeenAt IS NULL THEN peers_cache.lastSeenAt
              WHEN peers_cache.lastSeenAt IS NULL THEN excluded.lastSeenAt
              WHEN excluded.lastSeenAt > peers_cache.lastSeenAt THEN excluded.lastSeenAt
              ELSE peers_cache.lastSeenAt
            END,
            lastAddress = COALESCE(NULLIF(excluded.lastAddress, ''), peers_cache.lastAddress),
            lastPort = CASE
              WHEN excluded.lastPort IS NULL OR excluded.lastPort <= 0 THEN peers_cache.lastPort
              ELSE excluded.lastPort
            END`
      )
      .run(params);
  }

  getCachedPeers(): Peer[] {
    const rows = this.db
      .prepare(
        `SELECT
           deviceId,
           displayName,
           avatarEmoji,
           avatarBg,
           statusMessage,
           lastSeenAt,
           lastAddress,
           lastPort
         FROM peers_cache
         ORDER BY lastSeenAt DESC`
      )
      .all() as Array<{
      deviceId: string;
      displayName: string | null;
      avatarEmoji: string | null;
      avatarBg: string | null;
      statusMessage: string | null;
      lastSeenAt: number | null;
      lastAddress: string | null;
      lastPort: number | null;
    }>;

    return rows.map((row) => this.cachedPeerRowToPeer(row));
  }

  getCachedPeerById(deviceId: string): Peer | null {
    const row = this.db
      .prepare(
        `SELECT
           deviceId,
           displayName,
           avatarEmoji,
           avatarBg,
           statusMessage,
           lastSeenAt,
           lastAddress,
           lastPort
         FROM peers_cache
         WHERE deviceId = ?
         LIMIT 1`
      )
      .get(deviceId) as
      | {
          deviceId: string;
          displayName: string | null;
          avatarEmoji: string | null;
          avatarBg: string | null;
          statusMessage: string | null;
          lastSeenAt: number | null;
          lastAddress: string | null;
          lastPort: number | null;
        }
      | undefined;

    if (!row) {
      return null;
    }
    return this.cachedPeerRowToPeer(row);
  }

  removePeerCache(deviceId: string): void {
    this.db.prepare('DELETE FROM peers_cache WHERE deviceId = ?').run(deviceId);
  }

  ensureDmConversation(peerId: string, title: string): string {
    const id = `dm:${peerId}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO conversations(id, kind, peerDeviceId, title, createdAt, updatedAt, unreadCount)
         VALUES (?, 'dm', ?, ?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, updatedAt=excluded.updatedAt`
      )
      .run(id, peerId, title, now, now);
    return id;
  }

  ensureAnnouncementsConversation(): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO conversations(id, kind, peerDeviceId, title, createdAt, updatedAt, unreadCount)
         VALUES (?, 'announcements', NULL, 'Announcements', ?, ?, 0)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(ANNOUNCEMENTS_CONVERSATION_ID, now, now);
    this.db
      .prepare('UPDATE conversations SET title = ? WHERE id = ?')
      .run('Anúncios', ANNOUNCEMENTS_CONVERSATION_ID);
  }

  getConversations(): ConversationRow[] {
    return this.db
      .prepare('SELECT * FROM conversations ORDER BY updatedAt DESC')
      .all() as ConversationRow[];
  }

  getConversationPreviews(conversationIds: string[]): Record<string, string> {
    if (conversationIds.length === 0) {
      return {};
    }

    const uniqueIds = Array.from(new Set(conversationIds));
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT
           c.id AS conversationId,
           m.type AS type,
           m.bodyText AS bodyText,
           m.fileName AS fileName
         FROM conversations c
         LEFT JOIN messages m ON m.messageId = (
           SELECT m2.messageId
           FROM messages m2
           WHERE m2.conversationId = c.id
             AND m2.deletedAt IS NULL
           ORDER BY m2.createdAt DESC, m2.messageId DESC
           LIMIT 1
         )
         WHERE c.id IN (${placeholders})`
      )
      .all(...uniqueIds) as Array<{
      conversationId: string;
      type: 'text' | 'file' | 'announcement' | null;
      bodyText: string | null;
      fileName: string | null;
    }>;

    const result: Record<string, string> = {};
    for (const row of rows) {
      if (!row.type) {
        result[row.conversationId] = '';
        continue;
      }

      if (row.type === 'file') {
        result[row.conversationId] = `📎 ${row.fileName || 'Arquivo'}`;
        continue;
      }

      const body = (row.bodyText || '').replace(/\s+/g, ' ').trim();
      result[row.conversationId] =
        body.length > 90 ? `${body.slice(0, 87)}...` : body;
    }

    return result;
  }

  incrementUnread(conversationId: string): void {
    this.db
      .prepare(
        'UPDATE conversations SET unreadCount = unreadCount + 1, updatedAt = ? WHERE id = ?'
      )
      .run(Date.now(), conversationId);
  }

  markConversationRead(conversationId: string): void {
    this.db
      .prepare('UPDATE conversations SET unreadCount = 0, updatedAt = ? WHERE id = ?')
      .run(Date.now(), conversationId);
  }

  saveMessage(message: DbMessage): boolean {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO messages
       (messageId, conversationId, direction, senderDeviceId, receiverDeviceId, type, bodyText, fileId, fileName, fileSize, fileSha256, filePath, status, reaction, deletedAt, createdAt)
       VALUES
       (@messageId, @conversationId, @direction, @senderDeviceId, @receiverDeviceId, @type, @bodyText, @fileId, @fileName, @fileSize, @fileSha256, @filePath, @status, @reaction, @deletedAt, @createdAt)`
    );

    const touchConversation = this.db.prepare(
      'UPDATE conversations SET updatedAt = ? WHERE id = ?'
    );

    const tx = this.db.transaction((row: DbMessage) => {
      const result = insert.run(row);
      if (result.changes > 0) {
        touchConversation.run(Date.now(), row.conversationId);
      }
      return result.changes > 0;
    });

    return tx(message);
  }

  updateMessageStatus(messageId: string, status: 'sent' | 'delivered' | 'failed'): void {
    this.db.prepare('UPDATE messages SET status = ? WHERE messageId = ?').run(status, messageId);
  }

  updateFilePath(fileId: string, filePath: string, status: 'delivered' | 'failed'): void {
    this.db
      .prepare('UPDATE messages SET filePath = ?, status = ? WHERE fileId = ?')
      .run(filePath, status, fileId);
  }

  getSyncMessagesForPeer(peerId: string, limit = 1000, since?: number): DbMessage[] {
    const dmConversationId = `dm:${peerId}`;
    if (typeof since === 'number' && since > 0) {
      return this.db
        .prepare(
          `SELECT * FROM messages
           WHERE type IN ('text', 'file')
             AND conversationId = ?
             AND createdAt > ?
           ORDER BY createdAt ASC, messageId ASC
           LIMIT ?`
        )
        .all(dmConversationId, since, limit) as DbMessage[];
    }
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE type IN ('text', 'file')
           AND conversationId = ?
         ORDER BY createdAt ASC, messageId ASC
         LIMIT ?`
      )
      .all(dmConversationId, limit) as DbMessage[];
  }

  getLatestRelevantMessageTimestamp(peerId: string): number {
    const dmConversationId = `dm:${peerId}`;
    const row = this.db
      .prepare(
        `SELECT
           MAX(createdAt) AS latestDm
         FROM messages
         WHERE conversationId = ?
           AND type IN ('text', 'file')`
      )
      .get(dmConversationId) as
      | { latestDm: number | null }
      | undefined;
    return row?.latestDm || 0;
  }

  getRetryableFailedMessages(peerId: string, limit = 50): DbMessage[] {
    const conversationId = `dm:${peerId}`;
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversationId = ?
           AND direction = 'out'
           AND type = 'text'
           AND status = 'failed'
           AND deletedAt IS NULL
         ORDER BY createdAt ASC, messageId ASC
         LIMIT ?`
      )
      .all(conversationId, limit) as DbMessage[];
  }

  getOutgoingFileMessagesForPeer(peerId: string, limit = 50): DbMessage[] {
    const conversationId = `dm:${peerId}`;
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversationId = ?
           AND direction = 'out'
           AND type = 'file'
           AND deletedAt IS NULL
           AND (status IS NULL OR status != 'delivered')
         ORDER BY createdAt ASC, messageId ASC
         LIMIT ?`
      )
      .all(conversationId, limit) as DbMessage[];
  }

  setMessageReaction(
    messageId: string,
    reactorDeviceId: string,
    reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null,
    localDeviceId: string
  ): AnnouncementReactionSummary {
    const now = Date.now();
    const upsert = this.db.prepare(
      `INSERT INTO message_reactions (messageId, reactorDeviceId, reaction, updatedAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(messageId, reactorDeviceId) DO UPDATE SET reaction = excluded.reaction, updatedAt = excluded.updatedAt`
    );
    const remove = this.db.prepare(
      'DELETE FROM message_reactions WHERE messageId = ? AND reactorDeviceId = ?'
    );

    const tx = this.db.transaction(() => {
      if (reaction) {
        upsert.run(messageId, reactorDeviceId, reaction, now);
      } else {
        remove.run(messageId, reactorDeviceId);
      }
      this.db
        .prepare(
          `UPDATE conversations
           SET updatedAt = ?
           WHERE id = (SELECT conversationId FROM messages WHERE messageId = ? LIMIT 1)`
        )
        .run(now, messageId);
      return this.getMessageReactionSummary([messageId], localDeviceId)[messageId] || {
        counts: {},
        myReaction: null
      };
    });

    return tx();
  }

  setAnnouncementReaction(
    messageId: string,
    reactorDeviceId: string,
    reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null,
    localDeviceId: string
  ): AnnouncementReactionSummary {
    return this.setMessageReaction(messageId, reactorDeviceId, reaction, localDeviceId);
  }

  getMessageReactionSummary(
    messageIds: string[],
    localDeviceId: string
  ): Record<string, AnnouncementReactionSummary> {
    if (messageIds.length === 0) {
      return {};
    }
    const uniqueMessageIds = Array.from(new Set(messageIds));
    const placeholders = uniqueMessageIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT messageId, reactorDeviceId, reaction
         FROM message_reactions
         WHERE messageId IN (${placeholders})`
      )
      .all(...uniqueMessageIds) as Array<{
      messageId: string;
      reactorDeviceId: string;
      reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂';
    }>;

    const result: Record<string, AnnouncementReactionSummary> = {};
    for (const messageId of uniqueMessageIds) {
      result[messageId] = { counts: {}, myReaction: null };
    }

    for (const row of rows) {
      const current = result[row.messageId] || { counts: {}, myReaction: null };
      const currentCount = current.counts[row.reaction] || 0;
      current.counts[row.reaction] = currentCount + 1;
      if (row.reactorDeviceId === localDeviceId) {
        current.myReaction = row.reaction;
      }
      result[row.messageId] = current;
    }

    return result;
  }

  getAnnouncementReactionSummary(
    messageIds: string[],
    localDeviceId: string
  ): Record<string, AnnouncementReactionSummary> {
    return this.getMessageReactionSummary(messageIds, localDeviceId);
  }

  replaceAnnouncementReactions(
    snapshot: Record<string, Record<string, '👍' | '👎' | '❤️' | '😢' | '😊' | '😂'>>,
    options?: { replaceAll?: boolean }
  ): string[] {
    const now = Date.now();
    const listAnnouncementIds = this.db.prepare(
      `SELECT messageId
       FROM messages
       WHERE type = 'announcement' AND deletedAt IS NULL`
    );
    const deleteAllAnnouncementReactions = this.db.prepare(
      `DELETE FROM message_reactions
       WHERE messageId IN (
         SELECT messageId
         FROM messages
         WHERE type = 'announcement'
       )`
    );
    const deleteReactionsForMessage = this.db.prepare(
      'DELETE FROM message_reactions WHERE messageId = ?'
    );
    const upsertReaction = this.db.prepare(
      `INSERT INTO message_reactions (messageId, reactorDeviceId, reaction, updatedAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(messageId, reactorDeviceId) DO UPDATE SET reaction = excluded.reaction, updatedAt = excluded.updatedAt`
    );
    const touchConversation = this.db.prepare(
      'UPDATE conversations SET updatedAt = ? WHERE id = ?'
    );

    const tx = this.db.transaction(() => {
      const replaceAll = options?.replaceAll !== false;
      const activeAnnouncementIds = new Set(
        (listAnnouncementIds.all() as Array<{ messageId: string }>).map((row) => row.messageId)
      );
      if (replaceAll) {
        deleteAllAnnouncementReactions.run();
      }

      const touched = new Set<string>();
      for (const [messageId, byDevice] of Object.entries(snapshot)) {
        if (!activeAnnouncementIds.has(messageId)) {
          continue;
        }
        if (!replaceAll) {
          deleteReactionsForMessage.run(messageId);
        }
        for (const [deviceId, reaction] of Object.entries(byDevice || {})) {
          if (
            reaction !== '👍' &&
            reaction !== '👎' &&
            reaction !== '❤️' &&
            reaction !== '😢' &&
            reaction !== '😊' &&
            reaction !== '😂'
          ) {
            continue;
          }
          const cleanDeviceId = (deviceId || '').trim();
          if (!cleanDeviceId) continue;
          upsertReaction.run(messageId, cleanDeviceId, reaction, now);
          touched.add(messageId);
        }
      }

      touchConversation.run(now, ANNOUNCEMENTS_CONVERSATION_ID);
      return Array.from(touched.values());
    });

    return tx();
  }

  deleteMessageForEveryone(messageId: string, deletedAt = Date.now()): DbMessage | undefined {
    this.db
      .prepare(
        `UPDATE messages
         SET deletedAt = ?,
             bodyText = NULL,
             fileId = NULL,
             fileName = NULL,
             fileSize = NULL,
             fileSha256 = NULL,
             filePath = NULL,
             reaction = NULL
         WHERE messageId = ?`
      )
      .run(deletedAt, messageId);
    this.db.prepare('DELETE FROM message_reactions WHERE messageId = ?').run(messageId);
    this.db
      .prepare(
        `UPDATE conversations
         SET updatedAt = ?
         WHERE id = (SELECT conversationId FROM messages WHERE messageId = ? LIMIT 1)`
      )
      .run(Date.now(), messageId);
    return this.getMessageById(messageId);
  }

  mergeMessageStateFromSync(input: {
    messageId: string;
    bodyText: string | null;
    fileId: string | null;
    fileName: string | null;
    fileSize: number | null;
    fileSha256: string | null;
    status: 'sent' | 'delivered' | 'failed' | null;
    reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null;
    deletedAt: number | null;
  }): DbMessage | undefined {
    this.db
      .prepare(
        `UPDATE messages
         SET bodyText = ?,
             fileId = CASE WHEN ? IS NOT NULL THEN ? ELSE fileId END,
             fileName = CASE WHEN ? IS NOT NULL THEN ? ELSE fileName END,
             fileSize = CASE WHEN ? IS NOT NULL THEN ? ELSE fileSize END,
             fileSha256 = CASE WHEN ? IS NOT NULL THEN ? ELSE fileSha256 END,
             status = COALESCE(?, status),
             reaction = ?,
             deletedAt = ?
         WHERE messageId = ?`
      )
      .run(
        input.bodyText,
        input.fileId,
        input.fileId,
        input.fileName,
        input.fileName,
        input.fileSize,
        input.fileSize,
        input.fileSha256,
        input.fileSha256,
        input.status,
        input.reaction,
        input.deletedAt,
        input.messageId
      );
    return this.getMessageById(input.messageId);
  }

  getMessageById(messageId: string): DbMessage | undefined {
    return this.db
      .prepare('SELECT * FROM messages WHERE messageId = ? LIMIT 1')
      .get(messageId) as DbMessage | undefined;
  }

  getMessageByFileId(fileId: string): DbMessage | undefined {
    return this.db
      .prepare('SELECT * FROM messages WHERE fileId = ? LIMIT 1')
      .get(fileId) as DbMessage | undefined;
  }

  getMessages(conversationId: string, limit: number, before?: number): DbMessage[] {
    if (before) {
      return this.db
        .prepare(
          `SELECT * FROM messages
          WHERE conversationId = ?
            AND deletedAt IS NULL
            AND createdAt < ?
          ORDER BY createdAt DESC, messageId DESC
          LIMIT ?`
        )
        .all(conversationId, before, limit)
        .reverse() as DbMessage[];
    }

    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversationId = ?
           AND deletedAt IS NULL
         ORDER BY createdAt DESC, messageId DESC
         LIMIT ?`
      )
      .all(conversationId, limit)
      .reverse() as DbMessage[];
  }

  getMessagesByIds(messageIds: string[]): DbMessage[] {
    if (messageIds.length === 0) {
      return [];
    }
    const uniqueIds = Array.from(new Set(messageIds));
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE deletedAt IS NULL
           AND messageId IN (${placeholders})`
      )
      .all(...uniqueIds) as DbMessage[];

    rows.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.messageId.localeCompare(b.messageId);
    });
    return rows;
  }

  searchConversationMessageIds(conversationId: string, query: string, limit = 200): string[] {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    const normalizedLimit = Math.max(1, Math.min(limit, 1000));
    const escaped = trimmed.replace(/[\\%_]/g, (token) => `\\${token}`);
    const like = `%${escaped}%`;
    const rows = this.db
      .prepare(
        `SELECT messageId
         FROM messages
         WHERE conversationId = ?
           AND deletedAt IS NULL
           AND (
             COALESCE(bodyText, '') LIKE ? ESCAPE '\\'
             OR COALESCE(fileName, '') LIKE ? ESCAPE '\\'
           )
         ORDER BY createdAt ASC, messageId ASC
         LIMIT ?`
      )
      .all(conversationId, like, like, normalizedLimit) as Array<{ messageId: string }>;
    return rows.map((row) => row.messageId);
  }

  getLatestConversationTimestamp(conversationId: string): number {
    const row = this.db
      .prepare(
        `SELECT createdAt
         FROM messages
         WHERE conversationId = ?
         ORDER BY createdAt DESC, messageId DESC
         LIMIT 1`
      )
      .get(conversationId) as { createdAt: number } | undefined;
    return row?.createdAt || 0;
  }

  reserveConversationTimestamp(conversationId: string, proposedAt: number): number {
    const now = Date.now();
    const base =
      Number.isFinite(proposedAt) && proposedAt > 0 ? Math.trunc(proposedAt) : now;
    const latest = this.getLatestConversationTimestamp(conversationId);
    if (base <= latest) {
      return latest + 1;
    }
    return base;
  }

  clearConversation(conversationId: string): string[] {
    const listFiles = this.db.prepare(
      `SELECT filePath FROM messages
       WHERE conversationId = ? AND filePath IS NOT NULL`
    );
    const deleteReactions = this.db.prepare(
      `DELETE FROM message_reactions
       WHERE messageId IN (
         SELECT messageId
         FROM messages
         WHERE conversationId = ?
       )`
    );
    const deleteMessages = this.db.prepare('DELETE FROM messages WHERE conversationId = ?');
    const resetConversation = this.db.prepare(
      'UPDATE conversations SET unreadCount = 0, updatedAt = ? WHERE id = ?'
    );

    const tx = this.db.transaction((id: string) => {
      const rows = listFiles.all(id) as Array<{ filePath: string | null }>;
      deleteReactions.run(id);
      deleteMessages.run(id);
      resetConversation.run(Date.now(), id);
      return rows
        .map((row) => row.filePath)
        .filter((filePath): filePath is string => Boolean(filePath));
    });

    return tx(conversationId);
  }

  removeMessageById(messageId: string): void {
    this.db.prepare('DELETE FROM messages WHERE messageId = ?').run(messageId);
  }

  removeConversation(conversationId: string): void {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId);
  }

  private cachedPeerRowToPeer(row: {
    deviceId: string;
    displayName: string | null;
    avatarEmoji: string | null;
    avatarBg: string | null;
    statusMessage: string | null;
    lastSeenAt: number | null;
    lastAddress: string | null;
    lastPort: number | null;
  }): Peer {
    return {
      deviceId: row.deviceId,
      displayName: row.displayName || `Contato ${row.deviceId.slice(0, 6)}`,
      avatarEmoji: row.avatarEmoji || '🙂',
      avatarBg: row.avatarBg || '#5b5fc7',
      statusMessage: row.statusMessage || '',
      address: row.lastAddress || '',
      port: row.lastPort || 0,
      appVersion: 'unknown',
      lastSeenAt: row.lastSeenAt || 0,
      source: 'cache'
    };
  }

  purgeExpiredAnnouncements(cutoffMs: number): string[] {
    const list = this.db.prepare(
      `SELECT messageId FROM messages
       WHERE type = 'announcement' AND createdAt <= ?`
    );
    const remove = this.db.prepare(
      `DELETE FROM messages
       WHERE type = 'announcement' AND createdAt <= ?`
    );
    const touchConversation = this.db.prepare(
      'UPDATE conversations SET updatedAt = ? WHERE id = ?'
    );

    const tx = this.db.transaction((cutoff: number) => {
      const rows = list.all(cutoff) as Array<{ messageId: string }>;
      if (rows.length === 0) return [] as string[];
      remove.run(cutoff);
      touchConversation.run(Date.now(), ANNOUNCEMENTS_CONVERSATION_ID);
      return rows.map((row) => row.messageId);
    });

    return tx(cutoffMs);
  }

  purgeAnnouncementMessageIds(messageIds: string[]): string[] {
    if (messageIds.length === 0) {
      return [];
    }
    const uniqueIds = Array.from(new Set(messageIds));
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const list = this.db.prepare(
      `SELECT messageId FROM messages
       WHERE type = 'announcement' AND messageId IN (${placeholders})`
    );
    const removeMessages = this.db.prepare(
      `DELETE FROM messages
       WHERE type = 'announcement' AND messageId IN (${placeholders})`
    );
    const removeReactions = this.db.prepare(
      `DELETE FROM message_reactions
       WHERE messageId IN (${placeholders})`
    );
    const touchConversation = this.db.prepare(
      'UPDATE conversations SET updatedAt = ? WHERE id = ?'
    );

    const tx = this.db.transaction(() => {
      const rows = list.all(...uniqueIds) as Array<{ messageId: string }>;
      if (rows.length === 0) return [] as string[];
      removeMessages.run(...uniqueIds);
      removeReactions.run(...uniqueIds);
      touchConversation.run(Date.now(), ANNOUNCEMENTS_CONVERSATION_ID);
      return rows.map((row) => row.messageId);
    });

    return tx();
  }

  getActiveAnnouncementMessageIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT messageId
         FROM messages
         WHERE type = 'announcement' AND deletedAt IS NULL`
      )
      .all() as Array<{ messageId: string }>;
    return rows.map((row) => row.messageId);
  }

  getRelaySettings(): {
    automatic: boolean;
    host: string;
    port: number;
  } {
    const mode = this.getAppSetting('relay.mode');
    const automatic = mode !== 'manual';
    const host = this.getAppSetting('relay.host') || '';
    const rawPort = Number(this.getAppSetting('relay.port') || 0);
    const port =
      Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535
        ? Math.trunc(rawPort)
        : 43190;

    return {
      automatic,
      host,
      port
    };
  }

  setRelaySettings(input: {
    automatic: boolean;
    host?: string | null;
    port?: number | null;
  }): {
    automatic: boolean;
    host: string;
    port: number;
  } {
    const automatic = Boolean(input.automatic);
    const normalizedHost = (input.host || '').trim();
    const rawPort = Number(input.port || 0);
    const port =
      Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535
        ? Math.trunc(rawPort)
        : 43190;

    if (automatic) {
      this.setAppSetting('relay.mode', 'auto');
      this.deleteAppSetting('relay.host');
      this.deleteAppSetting('relay.port');
      return {
        automatic: true,
        host: '',
        port: 43190
      };
    }

    this.setAppSetting('relay.mode', 'manual');
    this.setAppSetting('relay.host', normalizedHost);
    this.setAppSetting('relay.port', String(port));
    return {
      automatic: false,
      host: normalizedHost,
      port
    };
  }

  getAttachmentsDirectory(defaultDir: string): string {
    const stored = (this.getAppSetting('attachments.dir') || '').trim();
    if (!stored) {
      return path.resolve(defaultDir);
    }
    return path.resolve(stored);
  }

  setAttachmentsDirectory(inputDir: string, defaultDir: string): string {
    const normalized = path.resolve((inputDir || '').trim() || defaultDir);
    this.setAppSetting('attachments.dir', normalized);
    return normalized;
  }

  private getAppSetting(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM app_settings WHERE key = ? LIMIT 1')
      .get(key) as { value: string } | undefined;
    return row?.value || null;
  }

  private setAppSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_settings(key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  private deleteAppSetting(key: string): void {
    this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  }
}
