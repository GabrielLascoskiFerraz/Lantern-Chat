import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { ANNOUNCEMENTS_CONVERSATION_ID } from './config';
import { runMigrations } from './migrations';
import {
  AnnouncementReactionSummary,
  ConversationRow,
  DbMessage,
  Peer,
  Profile,
  ReactPayload
} from './types';

type PendingPeerOperationType = 'chat:clear' | 'chat:forget' | 'chat:react';

type PendingPeerOperationPayload =
  | {
      scope: 'dm';
    }
  | {
      targetMessageId: string;
      reaction: ReactPayload['reaction'];
    };

interface PendingPeerOperation {
  id: string;
  peerId: string;
  type: PendingPeerOperationType;
  createdAt: number;
  payload: PendingPeerOperationPayload;
}

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

  markConversationUnread(conversationId: string): void {
    this.db
      .prepare(
        'UPDATE conversations SET unreadCount = CASE WHEN unreadCount < 1 THEN 1 ELSE unreadCount END, updatedAt = ? WHERE id = ?'
      )
      .run(Date.now(), conversationId);
  }

  saveMessage(message: DbMessage): boolean {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO messages
       (
         messageId,
         conversationId,
         direction,
         senderDeviceId,
         receiverDeviceId,
         type,
         bodyText,
         fileId,
         fileName,
         fileSize,
         fileSha256,
         filePath,
         status,
         reaction,
         deletedAt,
         replyToMessageId,
         replyToSenderDeviceId,
         replyToType,
         replyToPreviewText,
         replyToFileName,
         forwardedFromMessageId,
         createdAt
       )
       VALUES
       (
         @messageId,
         @conversationId,
         @direction,
         @senderDeviceId,
         @receiverDeviceId,
         @type,
         @bodyText,
         @fileId,
         @fileName,
         @fileSize,
         @fileSha256,
         @filePath,
         @status,
         @reaction,
         @deletedAt,
         @replyToMessageId,
         @replyToSenderDeviceId,
         @replyToType,
         @replyToPreviewText,
         @replyToFileName,
         @forwardedFromMessageId,
         @createdAt
       )`
    );

    const touchConversation = this.db.prepare(
      'UPDATE conversations SET updatedAt = ? WHERE id = ?'
    );

    const tx = this.db.transaction((row: DbMessage) => {
      // Normaliza campos opcionais para evitar falhas de named parameters
      // em fluxos legados (ex.: snapshots antigos).
      const normalizedRow: DbMessage = {
        ...row,
        bodyText: row.bodyText ?? null,
        fileId: row.fileId ?? null,
        fileName: row.fileName ?? null,
        fileSize: row.fileSize ?? null,
        fileSha256: row.fileSha256 ?? null,
        filePath: row.filePath ?? null,
        status: row.status ?? null,
        reaction: row.reaction ?? null,
        deletedAt: row.deletedAt ?? null,
        replyToMessageId: row.replyToMessageId ?? null,
        replyToSenderDeviceId: row.replyToSenderDeviceId ?? null,
        replyToType: row.replyToType ?? null,
        replyToPreviewText: row.replyToPreviewText ?? null,
        replyToFileName: row.replyToFileName ?? null,
        forwardedFromMessageId: row.forwardedFromMessageId ?? null
      };

      const result = insert.run(normalizedRow);
      if (result.changes > 0) {
        touchConversation.run(Date.now(), normalizedRow.conversationId);
      }
      return result.changes > 0;
    });

    return tx(message);
  }

  updateMessageStatus(
    messageId: string,
    status: 'sent' | 'delivered' | 'read' | 'failed'
  ): void {
    this.db
      .prepare(
        `UPDATE messages
         SET status = CASE
           WHEN COALESCE(status, '') = 'read' THEN 'read'
           WHEN ? = 'read' THEN 'read'
           WHEN COALESCE(status, '') = 'delivered' AND ? IN ('sent', 'failed') THEN 'delivered'
           WHEN ? = 'delivered' THEN 'delivered'
           ELSE ?
         END
         WHERE messageId = ?`
      )
      .run(status, status, status, status, messageId);
  }

  markIncomingMessagesRead(conversationId: string, limit = 500): string[] {
    const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 500;
    const candidateRows = this.db
      .prepare(
        `SELECT messageId
         FROM messages
         WHERE conversationId = ?
           AND direction = 'in'
           AND type IN ('text', 'file')
           AND deletedAt IS NULL
           AND status = 'delivered'
         ORDER BY createdAt ASC, messageId ASC
         LIMIT ?`
      )
      .all(conversationId, normalizedLimit) as Array<{ messageId: string }>;

    const ids = candidateRows.map((row) => row.messageId).filter((value) => value.length > 0);
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => '?').join(', ');
    this.db
      .prepare(`UPDATE messages SET status = 'read' WHERE messageId IN (${placeholders})`)
      .run(...ids);

    return ids;
  }

  updateFilePath(fileId: string, filePath: string, status: 'delivered' | 'failed'): void {
    this.db
      .prepare(
        `UPDATE messages
         SET
           filePath = CASE
             WHEN status = 'delivered' AND ? = 'failed' THEN filePath
             ELSE ?
           END,
           status = CASE
             WHEN status = 'read' THEN 'read'
             WHEN status = 'delivered' THEN 'delivered'
             WHEN ? = 'delivered' THEN 'delivered'
             ELSE ?
           END
         WHERE fileId = ?`
      )
      .run(status, filePath, status, status, fileId);
  }

  getSyncMessagesForPeer(peerId: string, limit = 1000, since?: number): DbMessage[] {
    const dmConversationId = `dm:${peerId}`;
    if (typeof since === 'number' && since > 0) {
      const changedRows = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE type IN ('text', 'file')
             AND conversationId = ?
             AND (
               createdAt > ?
               OR (deletedAt IS NOT NULL AND deletedAt > ?)
             )
           ORDER BY createdAt ASC, messageId ASC
           LIMIT ?`
        )
        .all(dmConversationId, since, since, limit) as DbMessage[];

      // Tombstones antigos também precisam ser reenviados para evitar divergência
      // quando o delete chegou fora de ordem em algum cliente.
      const tombstoneRows = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE type IN ('text', 'file')
             AND conversationId = ?
             AND deletedAt IS NOT NULL
             AND deletedAt <= ?
           ORDER BY deletedAt DESC, messageId DESC
           LIMIT ?`
        )
        .all(dmConversationId, since, 5000) as DbMessage[];

      const byId = new Map<string, DbMessage>();
      for (const row of changedRows) {
        byId.set(row.messageId, row);
      }
      for (const row of tombstoneRows) {
        if (!byId.has(row.messageId)) {
          byId.set(row.messageId, row);
        }
      }

      return Array.from(byId.values()).sort((left, right) => {
        const leftTime = Math.max(left.createdAt || 0, left.deletedAt || 0);
        const rightTime = Math.max(right.createdAt || 0, right.deletedAt || 0);
        if (leftTime !== rightTime) return leftTime - rightTime;
        return left.messageId.localeCompare(right.messageId);
      });
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
           MAX(
             CASE
               WHEN deletedAt IS NOT NULL AND deletedAt > createdAt THEN deletedAt
               ELSE createdAt
             END
           ) AS latestDm
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

  getOutgoingTextMessagesForPeer(peerId: string, limit = 50): DbMessage[] {
    const conversationId = `dm:${peerId}`;
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversationId = ?
           AND direction = 'out'
           AND type = 'text'
           AND deletedAt IS NULL
           AND COALESCE(status, 'sent') IN ('sent', 'failed')
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
           AND COALESCE(status, 'sent') IN ('sent', 'failed')
         ORDER BY createdAt ASC, messageId ASC
         LIMIT ?`
      )
      .all(conversationId, limit) as DbMessage[];
  }

  getIncomingFileMessagesWithoutPath(limit = 500): DbMessage[] {
    const normalizedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(Math.trunc(limit), 20_000))
      : 500;
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE direction = 'in'
           AND type = 'file'
           AND deletedAt IS NULL
           AND filePath IS NULL
           AND COALESCE(status, 'sent') IN ('delivered', 'read')
         ORDER BY createdAt ASC, messageId ASC
         LIMIT ?`
      )
      .all(normalizedLimit) as DbMessage[];
  }

  setMessageFavorite(messageId: string, favorite: boolean): boolean {
    const upsert = this.db.prepare(
      `INSERT INTO message_favorites (messageId, createdAt)
       VALUES (?, ?)
       ON CONFLICT(messageId) DO UPDATE SET createdAt = excluded.createdAt`
    );
    const remove = this.db.prepare('DELETE FROM message_favorites WHERE messageId = ?');
    const tx = this.db.transaction((id: string, setFavorite: boolean) => {
      if (setFavorite) {
        upsert.run(id, Date.now());
      } else {
        remove.run(id);
      }
    });
    tx(messageId, favorite);
    return this.db
      .prepare('SELECT 1 FROM message_favorites WHERE messageId = ? LIMIT 1')
      .get(messageId)
      ? true
      : false;
  }

  getMessageFavoritesMap(messageIds: string[]): Record<string, boolean> {
    if (messageIds.length === 0) {
      return {};
    }
    const uniqueIds = Array.from(
      new Set(messageIds.map((value) => value.trim()).filter((value) => value.length > 0))
    );
    if (uniqueIds.length === 0) {
      return {};
    }
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT messageId
         FROM message_favorites
         WHERE messageId IN (${placeholders})`
      )
      .all(...uniqueIds) as Array<{ messageId: string }>;
    const result: Record<string, boolean> = {};
    for (const row of rows) {
      result[row.messageId] = true;
    }
    return result;
  }

  getFavoriteMessages(conversationId: string, limit = 5000): DbMessage[] {
    const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 20_000)) : 5000;
    return this.db
      .prepare(
        `SELECT m.*
         FROM messages m
         INNER JOIN message_favorites f ON f.messageId = m.messageId
         WHERE m.conversationId = ?
           AND m.deletedAt IS NULL
         ORDER BY m.createdAt ASC, m.messageId ASC
         LIMIT ?`
      )
      .all(conversationId, normalizedLimit) as DbMessage[];
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
    this.db.prepare('DELETE FROM message_favorites WHERE messageId = ?').run(messageId);
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
    status: 'sent' | 'delivered' | 'read' | 'failed' | null;
    reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null;
    deletedAt: number | null;
    replyToMessageId: string | null;
    replyToSenderDeviceId: string | null;
    replyToType: 'text' | 'announcement' | 'file' | null;
    replyToPreviewText: string | null;
    replyToFileName: string | null;
    forwardedFromMessageId?: string | null;
  }): DbMessage | undefined {
    this.db
      .prepare(
        `UPDATE messages
         SET bodyText = ?,
             fileId = CASE WHEN ? IS NOT NULL THEN ? ELSE fileId END,
             fileName = CASE WHEN ? IS NOT NULL THEN ? ELSE fileName END,
             fileSize = CASE WHEN ? IS NOT NULL THEN ? ELSE fileSize END,
             fileSha256 = CASE WHEN ? IS NOT NULL THEN ? ELSE fileSha256 END,
             status = CASE
               WHEN COALESCE(status, '') = 'read' THEN 'read'
               WHEN COALESCE(?, '') = 'read' THEN 'read'
               WHEN COALESCE(status, '') = 'delivered' AND COALESCE(?, '') IN ('sent', 'failed') THEN 'delivered'
               WHEN COALESCE(?, '') = 'delivered' THEN 'delivered'
               ELSE COALESCE(?, status)
             END,
             reaction = ?,
             deletedAt = ?,
             replyToMessageId = COALESCE(?, replyToMessageId),
             replyToSenderDeviceId = COALESCE(?, replyToSenderDeviceId),
             replyToType = COALESCE(?, replyToType),
             replyToPreviewText = COALESCE(?, replyToPreviewText),
             replyToFileName = COALESCE(?, replyToFileName),
             forwardedFromMessageId = COALESCE(?, forwardedFromMessageId)
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
        input.status,
        input.status,
        input.status,
        input.reaction,
        input.deletedAt,
        input.replyToMessageId,
        input.replyToSenderDeviceId,
        input.replyToType,
        input.replyToPreviewText,
        input.replyToFileName,
        input.forwardedFromMessageId ?? null,
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

  searchConversationMessageIds(
    conversationId: string,
    query: string,
    limit = 500,
    offset = 0
  ): string[] {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    const normalizedLimit = Math.max(1, Math.min(limit, 2000));
    const normalizedOffset = Math.max(0, Math.trunc(offset));
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
         LIMIT ?
         OFFSET ?`
      )
      .all(conversationId, like, like, normalizedLimit, normalizedOffset) as Array<{
      messageId: string;
    }>;
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
    const deleteFavorites = this.db.prepare(
      `DELETE FROM message_favorites
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
      deleteFavorites.run(id);
      deleteMessages.run(id);
      resetConversation.run(Date.now(), id);
      return rows
        .map((row) => row.filePath)
        .filter((filePath): filePath is string => Boolean(filePath));
    });

    return tx(conversationId);
  }

  removeMessageById(messageId: string): void {
    this.db.prepare('DELETE FROM message_favorites WHERE messageId = ?').run(messageId);
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

  getPendingPeerOperations(peerId?: string): PendingPeerOperation[] {
    const cleanPeerId = (peerId || '').trim();
    const all = this.readPendingPeerOperations();
    const filtered = cleanPeerId ? all.filter((row) => row.peerId === cleanPeerId) : all;
    return filtered.sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
      return left.id.localeCompare(right.id);
    });
  }

  enqueuePendingPeerOperation(
    peerId: string,
    type: PendingPeerOperationType,
    payload: PendingPeerOperationPayload = { scope: 'dm' }
  ): PendingPeerOperation {
    const cleanPeerId = (peerId || '').trim();
    if (!cleanPeerId) {
      throw new Error('peerId inválido para enfileirar operação pendente.');
    }
    const now = Date.now();
    const normalizedPayload: PendingPeerOperationPayload =
      type === 'chat:react'
        ? {
            targetMessageId:
              'targetMessageId' in payload ? (payload.targetMessageId || '').trim() : '',
            reaction: 'reaction' in payload ? payload.reaction ?? null : null
          }
        : {
            scope: 'scope' in payload && payload.scope === 'dm' ? 'dm' : 'dm'
          };

    const targetMessageId =
      type === 'chat:react' && 'targetMessageId' in normalizedPayload
        ? normalizedPayload.targetMessageId
        : '';
    if (type === 'chat:react' && !targetMessageId) {
      throw new Error('targetMessageId inválido para reação pendente.');
    }

    const operation: PendingPeerOperation = {
      id: randomUUID(),
      peerId: cleanPeerId,
      type,
      createdAt: now,
      payload: normalizedPayload
    };

    const all = this.readPendingPeerOperations();
    const next =
      type === 'chat:react'
        ? all.filter(
            (row) =>
              !(
                row.peerId === cleanPeerId &&
                row.type === 'chat:react' &&
                'targetMessageId' in row.payload &&
                row.payload.targetMessageId === targetMessageId
              )
          )
        : all;
    next.push(operation);
    this.writePendingPeerOperations(next);
    return operation;
  }

  removePendingPeerOperation(operationId: string): void {
    const cleanId = (operationId || '').trim();
    if (!cleanId) return;
    const all = this.readPendingPeerOperations();
    const next = all.filter((row) => row.id !== cleanId);
    if (next.length === all.length) return;
    this.writePendingPeerOperations(next);
  }

  clearPendingPeerOperationsForPeer(peerId: string): void {
    const cleanPeerId = (peerId || '').trim();
    if (!cleanPeerId) return;
    const all = this.readPendingPeerOperations();
    const next = all.filter((row) => row.peerId !== cleanPeerId);
    if (next.length === all.length) return;
    this.writePendingPeerOperations(next);
  }

  removePendingReactionOperation(peerId: string, targetMessageId: string): void {
    const cleanPeerId = (peerId || '').trim();
    const cleanTargetMessageId = (targetMessageId || '').trim();
    if (!cleanPeerId || !cleanTargetMessageId) return;
    const all = this.readPendingPeerOperations();
    const next = all.filter(
      (row) =>
        !(
          row.peerId === cleanPeerId &&
          row.type === 'chat:react' &&
          'targetMessageId' in row.payload &&
          row.payload.targetMessageId === cleanTargetMessageId
        )
    );
    if (next.length === all.length) return;
    this.writePendingPeerOperations(next);
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

  private readPendingPeerOperations(): PendingPeerOperation[] {
    const raw = this.getAppSetting('pending.peerOps');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      const rows: PendingPeerOperation[] = [];
      for (const value of parsed) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const record = value as Record<string, unknown>;
        const id = typeof record.id === 'string' ? record.id.trim() : '';
        const peerId = typeof record.peerId === 'string' ? record.peerId.trim() : '';
        const type = record.type;
        const createdAt =
          typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
            ? Math.trunc(record.createdAt)
            : 0;
        const payloadRecord =
          record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
            ? (record.payload as Record<string, unknown>)
            : {};

        if (!id || !peerId || createdAt <= 0) continue;
        if (type === 'chat:clear' || type === 'chat:forget') {
          const scope = payloadRecord.scope === 'dm' ? 'dm' : 'dm';
          rows.push({
            id,
            peerId,
            type,
            createdAt,
            payload: { scope }
          });
          continue;
        }
        if (type === 'chat:react') {
          const targetMessageId =
            typeof payloadRecord.targetMessageId === 'string'
              ? payloadRecord.targetMessageId.trim()
              : '';
          const reaction =
            payloadRecord.reaction === '👍' ||
            payloadRecord.reaction === '👎' ||
            payloadRecord.reaction === '❤️' ||
            payloadRecord.reaction === '😢' ||
            payloadRecord.reaction === '😊' ||
            payloadRecord.reaction === '😂' ||
            payloadRecord.reaction === null
              ? payloadRecord.reaction
              : null;
          if (!targetMessageId) continue;
          rows.push({
            id,
            peerId,
            type,
            createdAt,
            payload: {
              targetMessageId,
              reaction
            }
          });
        }
      }
      return rows;
    } catch {
      return [];
    }
  }

  private writePendingPeerOperations(rows: PendingPeerOperation[]): void {
    if (!rows.length) {
      this.deleteAppSetting('pending.peerOps');
      return;
    }
    this.setAppSetting('pending.peerOps', JSON.stringify(rows));
  }
}
