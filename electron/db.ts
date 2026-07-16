import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { ANNOUNCEMENTS_CONVERSATION_ID } from './config';
import { runMigrations } from './migrations';
import {
  AnnouncementReadDetail,
  AnnouncementReadSummary,
  AnnouncementReactionSummary,
  ConversationRow,
  DbMessage,
  GroupAttachmentDownload,
  GroupEvent,
  GroupInfo,
  GroupMember,
  GroupSettings,
  MessageReactionDetail,
  Peer,
  Profile,
  ProtocolFrame,
  ReactPayload
} from './types';

interface PendingMessageReaction {
  messageId: string;
  reactorDeviceId: string;
  reaction: ReactPayload['reaction'];
  updatedAt: number;
}

interface GroupAttachmentUploadState {
  fileId: string;
  groupId: string;
  messageId: string;
  status: 'pending' | 'uploading' | 'retrying' | 'complete' | 'failed';
  totalBytes: number;
  sentBytes: number;
  nextChunkIndex: number;
  totalChunks: number;
  retryCount: number;
  lastError: string | null;
  lastAttemptAt: number | null;
  updatedAt: number;
}

const colorFromDeviceId = (deviceId: string): string => {
  const hex = createHash('sha256').update(deviceId).digest('hex').slice(0, 6);
  return `#${hex}`;
};

export class DbService {
  private readonly db: Database.Database;

  constructor(userDataPath: string) {
    fs.mkdirSync(userDataPath, { recursive: true });
    const dbPath = path.join(userDataPath, 'lantern.db');
    this.db = new Database(dbPath);
    runMigrations(this.db);
    this.ensureAnnouncementsConversation();
  }

  close(): void {
    this.db.close();
  }

  resetCacheForAuthenticatedProfile(profile: Profile): void {
    const clear = this.db.transaction(() => {
      this.db.exec(`
        DELETE FROM message_reactions;
        DELETE FROM pending_message_reactions;
        DELETE FROM message_favorites;
        DELETE FROM hidden_messages;
        DELETE FROM announcement_reads;
        DELETE FROM group_attachment_downloads;
        DELETE FROM group_attachment_uploads;
        DELETE FROM outbound_frames;
        DELETE FROM attachment_download_checkpoints;
        DELETE FROM canonical_sync_state;
        DELETE FROM group_pinned_messages;
        DELETE FROM group_events_applied;
        DELETE FROM group_members;
        DELETE FROM groups;
        DELETE FROM messages;
        DELETE FROM conversations;
        DELETE FROM peers_cache;
        DELETE FROM profile;
      `);
      this.db.prepare(`
        INSERT INTO profile(deviceId, displayName, avatarEmoji, avatarBg, statusMessage, createdAt, updatedAt)
        VALUES (@deviceId, @displayName, @avatarEmoji, @avatarBg, @statusMessage, @createdAt, @updatedAt)
      `).run(profile);
      this.ensureAnnouncementsConversation();
    });
    clear();
  }

  clearCachedUserData(): void {
    const placeholder: Profile = {
      deviceId: randomUUID(),
      displayName: 'Lantern',
      avatarEmoji: '🙂',
      avatarBg: '#147ad6',
      statusMessage: '',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.resetCacheForAuthenticatedProfile(placeholder);
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
      username: peer.username?.trim() || '',
      department: peer.department?.trim() || '',
      lastSeenAt: peer.lastSeenAt || Date.now(),
      lastAddress: peer.address?.trim() || null,
      lastPort: peer.port > 0 ? peer.port : null
    };

    this.db
      .prepare(
        `INSERT INTO peers_cache(deviceId, displayName, avatarEmoji, avatarBg, statusMessage, username, department, lastSeenAt, lastAddress, lastPort)
         VALUES (@deviceId, @displayName, @avatarEmoji, @avatarBg, @statusMessage, @username, @department, @lastSeenAt, @lastAddress, @lastPort)
         ON CONFLICT(deviceId) DO UPDATE SET
            displayName = COALESCE(NULLIF(excluded.displayName, ''), peers_cache.displayName),
            avatarEmoji = COALESCE(NULLIF(excluded.avatarEmoji, ''), peers_cache.avatarEmoji),
            avatarBg = COALESCE(NULLIF(excluded.avatarBg, ''), peers_cache.avatarBg),
            statusMessage = COALESCE(excluded.statusMessage, peers_cache.statusMessage),
            username = excluded.username,
            department = excluded.department,
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
           username,
           department,
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
      username: string | null;
      department: string | null;
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
           username,
           department,
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
          username: string | null;
          department: string | null;
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

  private groupConversationId(groupId: string): string {
    return `group:${groupId}`;
  }

  ensureGroupConversation(groupId: string, title: string): string {
    const cleanGroupId = (groupId || '').trim();
    if (!cleanGroupId) {
      throw new Error('groupId inválido.');
    }
    const id = this.groupConversationId(cleanGroupId);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO conversations(id, kind, peerDeviceId, title, createdAt, updatedAt, unreadCount)
         VALUES (?, 'group', NULL, ?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, updatedAt=excluded.updatedAt`
      )
      .run(id, title || 'Grupo', now, now);
    return id;
  }

  upsertGroup(group: GroupInfo): GroupInfo {
    const cleanGroupId = (group.groupId || '').trim();
    if (!cleanGroupId) {
      throw new Error('groupId inválido.');
    }
    const normalizedSettings: GroupSettings = {
      allowMembersToPin: group.settings?.allowMembersToPin !== false,
      allowMembersToEditInfo: group.settings?.allowMembersToEditInfo === true
    };
    const normalized: GroupInfo = {
      groupId: cleanGroupId,
      name: (group.name || '').trim() || 'Grupo',
      emoji: (group.emoji || '').trim() || '👥',
      avatarBg: (group.avatarBg || '').trim() || '#147ad6',
      description: (group.description || '').trim(),
      createdByDeviceId: (group.createdByDeviceId || '').trim(),
      createdAt:
        Number.isFinite(group.createdAt) && group.createdAt > 0
          ? Math.trunc(group.createdAt)
          : Date.now(),
      updatedAt:
        Number.isFinite(group.updatedAt) && group.updatedAt > 0
          ? Math.trunc(group.updatedAt)
          : Date.now(),
      lastEventSeq:
        Number.isFinite(group.lastEventSeq) && group.lastEventSeq > 0
          ? Math.trunc(group.lastEventSeq)
          : 0,
      deletedAt:
        Number.isFinite(group.deletedAt || 0) && (group.deletedAt || 0) > 0
          ? Math.trunc(group.deletedAt || 0)
          : null,
      missingOnRelay: Boolean(group.missingOnRelay),
      settings: normalizedSettings
    };

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO groups(
             groupId,
             name,
             emoji,
             avatarBg,
             description,
             createdByDeviceId,
             createdAt,
             updatedAt,
             lastEventSeq,
             deletedAt,
             missingOnRelay,
             allowMembersToPin,
             allowMembersToEditInfo
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(groupId) DO UPDATE SET
             name = excluded.name,
             emoji = excluded.emoji,
             avatarBg = excluded.avatarBg,
             description = excluded.description,
             createdByDeviceId = COALESCE(NULLIF(excluded.createdByDeviceId, ''), groups.createdByDeviceId),
             createdAt = CASE
               WHEN groups.createdAt IS NULL OR groups.createdAt <= 0 THEN excluded.createdAt
               ELSE groups.createdAt
             END,
             updatedAt = MAX(groups.updatedAt, excluded.updatedAt),
             lastEventSeq = MAX(groups.lastEventSeq, excluded.lastEventSeq),
             deletedAt = excluded.deletedAt,
             missingOnRelay = excluded.missingOnRelay,
             allowMembersToPin = excluded.allowMembersToPin,
             allowMembersToEditInfo = excluded.allowMembersToEditInfo`
        )
        .run(
          normalized.groupId,
          normalized.name,
          normalized.emoji,
          normalized.avatarBg,
          normalized.description,
          normalized.createdByDeviceId,
          normalized.createdAt,
          normalized.updatedAt,
          normalized.lastEventSeq,
          normalized.deletedAt,
          normalized.missingOnRelay ? 1 : 0,
          normalized.settings.allowMembersToPin ? 1 : 0,
          normalized.settings.allowMembersToEditInfo ? 1 : 0
        );
      this.ensureGroupConversation(normalized.groupId, normalized.name);
    });
    tx();
    return normalized;
  }

  getGroups(): GroupInfo[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM groups
         WHERE deletedAt IS NULL
         ORDER BY updatedAt DESC, name ASC`
      )
      .all() as Array<{
      groupId: string;
      name: string;
      emoji: string;
      avatarBg: string;
      description: string;
      createdByDeviceId: string;
      createdAt: number;
      updatedAt: number;
      lastEventSeq: number;
      deletedAt: number | null;
      missingOnRelay: number;
      allowMembersToPin: number;
      allowMembersToEditInfo: number;
    }>;
    return rows.map((row) => ({
      groupId: row.groupId,
      name: row.name,
      emoji: row.emoji,
      avatarBg: row.avatarBg,
      description: row.description || '',
      createdByDeviceId: row.createdByDeviceId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastEventSeq: row.lastEventSeq || 0,
      deletedAt: row.deletedAt || null,
      missingOnRelay: row.missingOnRelay === 1,
      settings: {
        allowMembersToPin: row.allowMembersToPin !== 0,
        allowMembersToEditInfo: row.allowMembersToEditInfo === 1
      }
    }));
  }

  markGroupMissingOnRelay(groupId: string, missing = true): void {
    const cleanGroupId = (groupId || '').trim();
    if (!cleanGroupId) return;
    this.db
      .prepare('UPDATE groups SET missingOnRelay = ?, updatedAt = ? WHERE groupId = ?')
      .run(missing ? 1 : 0, Date.now(), cleanGroupId);
  }

  deleteLocalGroup(groupId: string): string[] {
    const cleanGroupId = (groupId || '').trim();
    if (!cleanGroupId) return [];
    const conversationId = this.groupConversationId(cleanGroupId);
    const tx = this.db.transaction(() => {
      const filePaths = this.clearConversation(conversationId);
      const now = Date.now();
      this.db
        .prepare('UPDATE groups SET deletedAt = ?, missingOnRelay = 1, updatedAt = ? WHERE groupId = ?')
        .run(now, now, cleanGroupId);
      this.db
        .prepare('UPDATE group_members SET status = ?, updatedAt = ? WHERE groupId = ?')
        .run('removed', now, cleanGroupId);
      this.db.prepare('DELETE FROM group_pinned_messages WHERE groupId = ?').run(cleanGroupId);
      this.removeConversation(conversationId);
      return filePaths;
    });
    return tx();
  }

  getGroupById(groupId: string): GroupInfo | null {
    const cleanGroupId = (groupId || '').trim();
    if (!cleanGroupId) return null;
    return this.getGroups().find((group) => group.groupId === cleanGroupId) || null;
  }

  getGroupSeqMap(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT groupId, lastEventSeq FROM groups')
      .all() as Array<{ groupId: string; lastEventSeq: number | null }>;
    return Object.fromEntries(rows.map((row) => [row.groupId, row.lastEventSeq || 0]));
  }

  upsertGroupMembers(groupId: string, members: GroupMember[]): void {
    const cleanGroupId = (groupId || '').trim();
    if (!cleanGroupId || members.length === 0) return;
    const upsert = this.db.prepare(
      `INSERT INTO group_members(
         groupId,
         deviceId,
         role,
         status,
         displayNameSnapshot,
         avatarEmojiSnapshot,
         avatarBgSnapshot,
         joinedAt,
         updatedAt
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(groupId, deviceId) DO UPDATE SET
         role = excluded.role,
         status = excluded.status,
         displayNameSnapshot = COALESCE(excluded.displayNameSnapshot, group_members.displayNameSnapshot),
         avatarEmojiSnapshot = COALESCE(excluded.avatarEmojiSnapshot, group_members.avatarEmojiSnapshot),
         avatarBgSnapshot = COALESCE(excluded.avatarBgSnapshot, group_members.avatarBgSnapshot),
         joinedAt = CASE
           WHEN group_members.joinedAt IS NULL OR group_members.joinedAt <= 0 THEN excluded.joinedAt
           ELSE group_members.joinedAt
         END,
         updatedAt = MAX(group_members.updatedAt, excluded.updatedAt)`
    );
    const tx = this.db.transaction((rows: GroupMember[]) => {
      for (const member of rows) {
        const deviceId = (member.deviceId || '').trim();
        if (!deviceId) continue;
        upsert.run(
          cleanGroupId,
          deviceId,
          member.role === 'owner' || member.role === 'admin' ? member.role : 'member',
          member.status === 'left' || member.status === 'removed' ? member.status : 'active',
          member.displayNameSnapshot || null,
          member.avatarEmojiSnapshot || null,
          member.avatarBgSnapshot || null,
          Number.isFinite(member.joinedAt) && member.joinedAt > 0 ? Math.trunc(member.joinedAt) : Date.now(),
          Number.isFinite(member.updatedAt) && member.updatedAt > 0 ? Math.trunc(member.updatedAt) : Date.now()
        );
      }
    });
    tx(members);
  }

  getGroupMembers(groupId: string): GroupMember[] {
    const cleanGroupId = (groupId || '').trim();
    if (!cleanGroupId) return [];
    return this.db
      .prepare(
        `SELECT *
         FROM group_members
         WHERE groupId = ?
         ORDER BY
           CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
           COALESCE(displayNameSnapshot, deviceId) ASC`
      )
      .all(cleanGroupId) as GroupMember[];
  }

  replaceGroupPinnedMessages(
    groupId: string,
    messageIds: string[],
    pinnedByDeviceId: string,
    pinnedAt = Date.now()
  ): void {
    const cleanGroupId = (groupId || '').trim();
    if (!cleanGroupId) return;
    const uniqueIds = Array.from(new Set(messageIds.map((value) => value.trim()).filter(Boolean)));
    const deleteRows = this.db.prepare('DELETE FROM group_pinned_messages WHERE groupId = ?');
    const insertRow = this.db.prepare(
      `INSERT OR IGNORE INTO group_pinned_messages(groupId, messageId, pinnedByDeviceId, pinnedAt)
       VALUES (?, ?, ?, ?)`
    );
    const tx = this.db.transaction(() => {
      deleteRows.run(cleanGroupId);
      for (const messageId of uniqueIds) {
        insertRow.run(cleanGroupId, messageId, pinnedByDeviceId, pinnedAt);
      }
    });
    tx();
  }

  setGroupMessagePinned(
    groupId: string,
    messageId: string,
    pinned: boolean,
    pinnedByDeviceId: string,
    pinnedAt = Date.now()
  ): string[] {
    const cleanGroupId = (groupId || '').trim();
    const cleanMessageId = (messageId || '').trim();
    if (!cleanGroupId || !cleanMessageId) return this.getGroupPinnedMessageIds(cleanGroupId);
    if (pinned) {
      this.db
        .prepare(
          `INSERT INTO group_pinned_messages(groupId, messageId, pinnedByDeviceId, pinnedAt)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(groupId, messageId) DO UPDATE SET
             pinnedByDeviceId = excluded.pinnedByDeviceId,
             pinnedAt = excluded.pinnedAt`
        )
        .run(cleanGroupId, cleanMessageId, pinnedByDeviceId, pinnedAt);
    } else {
      this.db
        .prepare('DELETE FROM group_pinned_messages WHERE groupId = ? AND messageId = ?')
        .run(cleanGroupId, cleanMessageId);
    }
    return this.getGroupPinnedMessageIds(cleanGroupId);
  }

  getGroupPinnedMessageIds(groupId: string): string[] {
    const cleanGroupId = (groupId || '').trim();
    if (!cleanGroupId) return [];
    const rows = this.db
      .prepare(
        `SELECT messageId
         FROM group_pinned_messages
         WHERE groupId = ?
         ORDER BY pinnedAt DESC, messageId ASC`
      )
      .all(cleanGroupId) as Array<{ messageId: string }>;
    return rows.map((row) => row.messageId);
  }

  markGroupEventApplied(event: GroupEvent): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO group_events_applied(eventId, groupId, seq, type, createdAt)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(event.eventId, event.groupId, event.seq, event.type, event.createdAt);
    if (result.changes > 0) {
      this.db
        .prepare(
          `UPDATE groups
           SET lastEventSeq = CASE WHEN lastEventSeq < ? THEN ? ELSE lastEventSeq END,
               updatedAt = CASE WHEN updatedAt < ? THEN ? ELSE updatedAt END
           WHERE groupId = ?`
        )
        .run(event.seq, event.seq, event.createdAt, event.createdAt, event.groupId);
    }
    return result.changes > 0;
  }

  upsertGroupAttachmentDownload(input: GroupAttachmentDownload): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO group_attachment_downloads(
           fileId, groupId, messageId, status, localPath, tempPath, totalBytes,
           receivedBytes, nextChunkIndex, totalChunks, retryCount, lastError,
           lastAttemptAt, requestId, receivedAt, updatedAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(fileId) DO UPDATE SET
           groupId = excluded.groupId,
           messageId = excluded.messageId,
           status = excluded.status,
           localPath = CASE
             WHEN excluded.status IN ('failed', 'expired') THEN NULL
             WHEN excluded.status = 'complete' THEN excluded.localPath
             ELSE COALESCE(excluded.localPath, group_attachment_downloads.localPath)
           END,
           tempPath = CASE
             WHEN excluded.status IN ('complete', 'failed', 'expired') THEN NULL
             ELSE COALESCE(excluded.tempPath, group_attachment_downloads.tempPath)
           END,
           totalBytes = CASE
             WHEN excluded.totalBytes > 0 THEN excluded.totalBytes
             ELSE group_attachment_downloads.totalBytes
           END,
           receivedBytes = CASE
             WHEN excluded.status IN ('failed', 'expired') THEN 0
             WHEN excluded.receivedBytes > group_attachment_downloads.receivedBytes
               THEN excluded.receivedBytes
             ELSE group_attachment_downloads.receivedBytes
           END,
           nextChunkIndex = CASE
             WHEN excluded.status IN ('failed', 'expired') THEN 0
             WHEN excluded.nextChunkIndex > group_attachment_downloads.nextChunkIndex
               THEN excluded.nextChunkIndex
             ELSE group_attachment_downloads.nextChunkIndex
           END,
           totalChunks = CASE
             WHEN excluded.totalChunks > 0 THEN excluded.totalChunks
             ELSE group_attachment_downloads.totalChunks
           END,
           retryCount = CASE
             WHEN excluded.status = 'complete' THEN 0
             WHEN excluded.retryCount > group_attachment_downloads.retryCount
               THEN excluded.retryCount
             ELSE group_attachment_downloads.retryCount
           END,
           lastError = CASE
             WHEN excluded.status = 'complete' THEN NULL
             ELSE COALESCE(excluded.lastError, group_attachment_downloads.lastError)
           END,
           lastAttemptAt = COALESCE(excluded.lastAttemptAt, group_attachment_downloads.lastAttemptAt),
           requestId = CASE
             WHEN excluded.status = 'downloading' THEN excluded.requestId
             ELSE NULL
           END,
           receivedAt = CASE
             WHEN excluded.status IN ('pending', 'reconnecting', 'downloading', 'retrying', 'failed') THEN NULL
             ELSE COALESCE(excluded.receivedAt, group_attachment_downloads.receivedAt)
           END,
           updatedAt = excluded.updatedAt`
      )
      .run(
        input.fileId,
        input.groupId,
        input.messageId,
        input.status,
        input.localPath || null,
        input.tempPath || null,
        Math.max(0, Math.trunc(input.totalBytes || 0)),
        Math.max(0, Math.trunc(input.receivedBytes || 0)),
        Math.max(0, Math.trunc(input.nextChunkIndex || 0)),
        Math.max(0, Math.trunc(input.totalChunks || 0)),
        Math.max(0, Math.trunc(input.retryCount || 0)),
        input.lastError || null,
        input.lastAttemptAt || null,
        input.requestId || null,
        input.receivedAt || null,
        input.updatedAt || now
      );
  }

  getGroupAttachmentDownload(fileId: string): GroupAttachmentDownload | null {
    const cleanFileId = (fileId || '').trim();
    if (!cleanFileId) return null;
    const row = this.db
      .prepare(
        `SELECT fileId, groupId, messageId, status, localPath, tempPath, totalBytes,
                receivedBytes, nextChunkIndex, totalChunks, retryCount, lastError,
                lastAttemptAt, requestId, receivedAt, updatedAt
         FROM group_attachment_downloads
         WHERE fileId = ?`
      )
      .get(cleanFileId) as GroupAttachmentDownload | undefined;
    return row || null;
  }

  getPendingGroupAttachmentDownloads(limit = 100): GroupAttachmentDownload[] {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 100, 500));
    return this.db
      .prepare(
        `SELECT fileId, groupId, messageId, status, localPath, tempPath, totalBytes,
                receivedBytes, nextChunkIndex, totalChunks, retryCount, lastError,
                lastAttemptAt, requestId, receivedAt, updatedAt
         FROM group_attachment_downloads
         WHERE status IN ('pending', 'reconnecting', 'downloading', 'retrying', 'failed')
         ORDER BY updatedAt ASC, fileId ASC
         LIMIT ?`
      )
      .all(safeLimit) as GroupAttachmentDownload[];
  }

  getGroupAttachmentUpload(fileId: string): GroupAttachmentUploadState | null {
    const cleanFileId = (fileId || '').trim();
    if (!cleanFileId) return null;
    const row = this.db
      .prepare(
        `SELECT fileId, groupId, messageId, status, totalBytes, sentBytes,
                nextChunkIndex, totalChunks, retryCount, lastError, lastAttemptAt, updatedAt
         FROM group_attachment_uploads WHERE fileId = ?`
      )
      .get(cleanFileId) as GroupAttachmentUploadState | undefined;
    return row || null;
  }

  upsertGroupAttachmentUpload(input: GroupAttachmentUploadState): void {
    this.db
      .prepare(
        `INSERT INTO group_attachment_uploads(
           fileId, groupId, messageId, status, totalBytes, sentBytes,
           nextChunkIndex, totalChunks, retryCount, lastError, lastAttemptAt, updatedAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(fileId) DO UPDATE SET
           groupId = excluded.groupId,
           messageId = excluded.messageId,
           status = excluded.status,
           totalBytes = excluded.totalBytes,
           sentBytes = excluded.sentBytes,
           nextChunkIndex = excluded.nextChunkIndex,
           totalChunks = excluded.totalChunks,
           retryCount = excluded.retryCount,
           lastError = excluded.lastError,
           lastAttemptAt = excluded.lastAttemptAt,
           updatedAt = excluded.updatedAt`
      )
      .run(
        input.fileId,
        input.groupId,
        input.messageId,
        input.status,
        Math.max(0, Math.trunc(input.totalBytes || 0)),
        Math.max(0, Math.trunc(input.sentBytes || 0)),
        Math.max(0, Math.trunc(input.nextChunkIndex || 0)),
        Math.max(0, Math.trunc(input.totalChunks || 0)),
        Math.max(0, Math.trunc(input.retryCount || 0)),
        input.lastError || null,
        input.lastAttemptAt || null,
        input.updatedAt || Date.now()
      );
  }

  getPendingOutgoingGroupFiles(limit = 50): DbMessage[] {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 50, 200));
    return this.db
      .prepare(
        `SELECT *
         FROM messages
         WHERE conversationId LIKE 'group:%'
           AND direction = 'out'
           AND type = 'file'
           AND deletedAt IS NULL
           AND COALESCE(status, 'sent') IN ('sent', 'failed')
           AND filePath IS NOT NULL
           AND fileId IS NOT NULL
         ORDER BY createdAt ASC, messageId ASC
         LIMIT ?`
      )
      .all(safeLimit) as DbMessage[];
  }

  private hydrateGroupAttachmentPaths(rows: DbMessage[]): DbMessage[] {
    return rows.map((row) => {
      if (row.type !== 'file') {
        return row;
      }

      // Nunca devolve ao renderer uma referência local quebrada: isso evita
      // botões de abrir/salvar apontando para um arquivo que já não existe.
      const existingFilePath =
        row.filePath && fs.existsSync(row.filePath) ? row.filePath : null;
      if (existingFilePath) {
        return row;
      }

      const rowWithoutBrokenPath = row.filePath ? { ...row, filePath: null } : row;
      if (!row.fileId || !row.conversationId.startsWith('group:')) {
        return rowWithoutBrokenPath;
      }

      const download = this.getGroupAttachmentDownload(row.fileId);
      if (
        download?.status === 'complete' &&
        download.localPath &&
        fs.existsSync(download.localPath)
      ) {
        return {
          ...rowWithoutBrokenPath,
          filePath: download.localPath,
          status: rowWithoutBrokenPath.status === 'failed' ? 'delivered' : rowWithoutBrokenPath.status
        };
      }

      return rowWithoutBrokenPath;
    });
  }

  getConversations(): ConversationRow[] {
    return this.db
      .prepare('SELECT * FROM conversations ORDER BY updatedAt DESC')
      .all() as ConversationRow[];
  }

  getArchivedConversationIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT id
         FROM conversations
         WHERE kind = 'dm'
           AND COALESCE(archivedAt, 0) > 0
         ORDER BY archivedAt DESC`
      )
      .all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  setConversationArchived(conversationId: string, archived: boolean): number {
    if (!conversationId.startsWith('dm:')) {
      return 0;
    }
    const archivedAt = archived ? Date.now() : 0;
    const peerId = conversationId.slice(3);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO conversations(id, kind, peerDeviceId, title, createdAt, updatedAt, unreadCount, lastReadAt, archivedAt)
         VALUES (?, 'dm', ?, NULL, ?, ?, 0, 0, ?)
         ON CONFLICT(id) DO UPDATE SET archivedAt = excluded.archivedAt`
      )
      .run(conversationId, peerId, now, now, archivedAt);
    return archivedAt;
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
             AND NOT EXISTS (
               SELECT 1 FROM hidden_messages h WHERE h.messageId = m2.messageId
             )
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

  getConversationUnreadCount(conversationId: string): number {
    const row = this.db
      .prepare('SELECT unreadCount FROM conversations WHERE id = ?')
      .get(conversationId) as { unreadCount: number | null } | undefined;
    return Math.max(0, Number(row?.unreadCount || 0));
  }

  getConversationLastReadAt(conversationId: string): number {
    const row = this.db
      .prepare('SELECT lastReadAt FROM conversations WHERE id = ?')
      .get(conversationId) as { lastReadAt: number | null } | undefined;
    return Math.max(0, Number(row?.lastReadAt || 0));
  }

  incrementUnread(conversationId: string, messageCreatedAt?: number): number {
    const tx = this.db.transaction((id: string, createdAt?: number) => {
      const row = this.db
        .prepare('SELECT unreadCount, lastReadAt FROM conversations WHERE id = ?')
        .get(id) as { unreadCount: number | null; lastReadAt: number | null } | undefined;
      if (!row) return 0;

      const currentUnread = Math.max(0, Number(row.unreadCount || 0));
      const lastReadAt = Math.max(0, Number(row.lastReadAt || 0));
      const normalizedCreatedAt =
        typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt > 0
          ? Math.trunc(createdAt)
          : 0;

      if (normalizedCreatedAt > 0 && normalizedCreatedAt <= lastReadAt) {
        return currentUnread;
      }

      const nextUnread = currentUnread + 1;
      this.db
        .prepare('UPDATE conversations SET unreadCount = ?, updatedAt = ? WHERE id = ?')
        .run(nextUnread, Date.now(), id);
      return nextUnread;
    });

    return tx(conversationId, messageCreatedAt);
  }

  markConversationRead(conversationId: string): string[] {
    const tx = this.db.transaction((id: string) => {
      const previousLastReadAt = this.getConversationLastReadAt(id);
      const latestMessageAt = this.getLatestConversationTimestamp(id);
      const nextLastReadAt = Math.max(previousLastReadAt, latestMessageAt);
      this.db
        .prepare('UPDATE conversations SET unreadCount = 0, lastReadAt = ?, updatedAt = ? WHERE id = ?')
        .run(nextLastReadAt, Date.now(), id);
      return this.markIncomingMessagesRead(id);
    });

    return tx(conversationId);
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
         editedAt,
         serverSeq,
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
         @editedAt,
         @serverSeq,
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
        forwardedFromMessageId: row.forwardedFromMessageId ?? null,
        editedAt: row.editedAt ?? null,
        serverSeq: row.serverSeq ?? null
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

  markIncomingMessagesRead(conversationId: string, limit?: number): string[] {
    const hasLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0;
    const normalizedLimit = hasLimit ? Math.trunc(limit) : 0;
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
         ${hasLimit ? 'LIMIT ?' : ''}`
      )
      .all(...(hasLimit ? [conversationId, normalizedLimit] : [conversationId])) as Array<{ messageId: string }>;

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
             WHEN status IN ('delivered', 'read') AND ? = 'failed' THEN filePath
             WHEN ? = 'failed' THEN NULL
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
      .run(status, status, filePath, status, status, fileId);
  }

  markIncomingFileForRetry(messageId: string): DbMessage | undefined {
    this.db
      .prepare(
        `UPDATE messages
         SET filePath = NULL,
             status = 'sent'
         WHERE messageId = ?
           AND direction = 'in'
           AND type = 'file'
           AND deletedAt IS NULL`
      )
      .run(messageId);
    return this.getMessageById(messageId);
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

  getIncomingFileMessagesForPeer(peerId: string, limit = 100): DbMessage[] {
    const conversationId = `dm:${peerId}`;
    const normalizedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(Math.trunc(limit), 1_000))
      : 100;
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversationId = ?
           AND direction = 'in'
           AND type = 'file'
           AND deletedAt IS NULL
           AND fileId IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM hidden_messages h WHERE h.messageId = messages.messageId
           )
         ORDER BY createdAt ASC, messageId ASC
         LIMIT ?`
      )
      .all(conversationId, normalizedLimit) as DbMessage[];
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
           AND NOT EXISTS (
             SELECT 1 FROM hidden_messages h WHERE h.messageId = m.messageId
           )
         ORDER BY m.createdAt ASC, m.messageId ASC
         LIMIT ?`
      )
      .all(conversationId, normalizedLimit) as DbMessage[];
  }

  setMessageReaction(
    messageId: string,
    reactorDeviceId: string,
    reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null,
    localDeviceId: string,
    updatedAt = Date.now()
  ): AnnouncementReactionSummary {
    const now = Number.isFinite(updatedAt) && updatedAt > 0 ? Math.trunc(updatedAt) : Date.now();
    const upsert = this.db.prepare(
      `INSERT INTO message_reactions (messageId, reactorDeviceId, reaction, updatedAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(messageId, reactorDeviceId) DO UPDATE SET reaction = excluded.reaction, updatedAt = excluded.updatedAt
       WHERE excluded.updatedAt >= message_reactions.updatedAt`
    );
    const remove = this.db.prepare(
      'DELETE FROM message_reactions WHERE messageId = ? AND reactorDeviceId = ? AND updatedAt <= ?'
    );

    const tx = this.db.transaction(() => {
      if (reaction) {
        upsert.run(messageId, reactorDeviceId, reaction, now);
      } else {
        remove.run(messageId, reactorDeviceId, now);
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

  upsertPendingMessageReaction(
    messageId: string,
    reactorDeviceId: string,
    reaction: ReactPayload['reaction'],
    updatedAt = Date.now()
  ): void {
    const cleanMessageId = (messageId || '').trim();
    const cleanReactorDeviceId = (reactorDeviceId || '').trim();
    if (!cleanMessageId || !cleanReactorDeviceId) return;

    const normalizedUpdatedAt =
      Number.isFinite(updatedAt) && updatedAt > 0 ? Math.trunc(updatedAt) : Date.now();

    this.db
      .prepare(
        `INSERT INTO pending_message_reactions(messageId, reactorDeviceId, reaction, updatedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(messageId, reactorDeviceId) DO UPDATE SET
           reaction = excluded.reaction,
           updatedAt = excluded.updatedAt
         WHERE excluded.updatedAt >= pending_message_reactions.updatedAt`
      )
      .run(cleanMessageId, cleanReactorDeviceId, reaction, normalizedUpdatedAt);
  }

  consumePendingMessageReactions(messageId: string): PendingMessageReaction[] {
    const cleanMessageId = (messageId || '').trim();
    if (!cleanMessageId) return [];

    const selectRows = this.db.prepare(
      `SELECT messageId, reactorDeviceId, reaction, updatedAt
       FROM pending_message_reactions
       WHERE messageId = ?
       ORDER BY updatedAt ASC, reactorDeviceId ASC`
    );
    const deleteRows = this.db.prepare(
      'DELETE FROM pending_message_reactions WHERE messageId = ?'
    );

    const tx = this.db.transaction((targetMessageId: string) => {
      const rows = selectRows.all(targetMessageId) as PendingMessageReaction[];
      deleteRows.run(targetMessageId);
      return rows;
    });

    return tx(cleanMessageId);
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
       WHERE conversationId = 'announcements' AND deletedAt IS NULL`
    );
    const deleteAllAnnouncementReactions = this.db.prepare(
      `DELETE FROM message_reactions
       WHERE messageId IN (
         SELECT messageId
         FROM messages
         WHERE conversationId = 'announcements'
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
    this.db.prepare('DELETE FROM pending_message_reactions WHERE messageId = ?').run(messageId);
    this.db.prepare('DELETE FROM message_favorites WHERE messageId = ?').run(messageId);
    this.db.prepare('DELETE FROM hidden_messages WHERE messageId = ?').run(messageId);
    this.db.prepare('DELETE FROM announcement_reads WHERE messageId = ?').run(messageId);
    this.db
      .prepare(
        `UPDATE conversations
         SET updatedAt = ?
         WHERE id = (SELECT conversationId FROM messages WHERE messageId = ? LIMIT 1)`
      )
      .run(Date.now(), messageId);
    return this.getMessageById(messageId);
  }

  updateMessageText(messageId: string, text: string, editedAt = Date.now()): DbMessage | undefined {
    const cleanText = (text || '').trim();
    if (!cleanText) {
      throw new Error('A mensagem editada não pode ficar vazia.');
    }
    const normalizedEditedAt =
      Number.isFinite(editedAt) && editedAt > 0 ? Math.trunc(editedAt) : Date.now();
    this.db
      .prepare(
        `UPDATE messages
         SET bodyText = ?,
             editedAt = CASE
               WHEN editedAt IS NULL OR ? >= editedAt THEN ?
               ELSE editedAt
             END
         WHERE messageId = ?
           AND deletedAt IS NULL
           AND type IN ('text', 'announcement')`
      )
      .run(cleanText, normalizedEditedAt, normalizedEditedAt, messageId);
    this.db
      .prepare(
        `UPDATE conversations
         SET updatedAt = ?
         WHERE id = (SELECT conversationId FROM messages WHERE messageId = ? LIMIT 1)`
      )
      .run(normalizedEditedAt, messageId);
    return this.getMessageById(messageId);
  }

  hideMessageForMe(messageId: string, hiddenAt = Date.now()): DbMessage | undefined {
    const existing = this.getMessageById(messageId);
    if (!existing) return undefined;
    this.db
      .prepare(
        `INSERT INTO hidden_messages(messageId, hiddenAt)
         VALUES (?, ?)
         ON CONFLICT(messageId) DO UPDATE SET hiddenAt = excluded.hiddenAt`
      )
      .run(messageId, hiddenAt);
    this.db.prepare('DELETE FROM message_favorites WHERE messageId = ?').run(messageId);
    this.db
      .prepare(
        `UPDATE conversations
         SET updatedAt = ?
         WHERE id = ?`
      )
      .run(Date.now(), existing.conversationId);
    return existing;
  }

  getMessageReactionDetails(messageId: string): MessageReactionDetail[] {
    const rows = this.db
      .prepare(
        `SELECT
           r.reactorDeviceId,
           r.reaction,
           r.updatedAt,
           p.displayName AS peerDisplayName,
           p.avatarEmoji AS peerAvatarEmoji,
           p.avatarBg AS peerAvatarBg,
           local.displayName AS localDisplayName,
           local.avatarEmoji AS localAvatarEmoji,
           local.avatarBg AS localAvatarBg
         FROM message_reactions r
         LEFT JOIN peers_cache p ON p.deviceId = r.reactorDeviceId
         LEFT JOIN profile local ON local.deviceId = r.reactorDeviceId
         WHERE r.messageId = ?
         ORDER BY r.updatedAt ASC, r.reactorDeviceId ASC`
      )
      .all(messageId) as Array<{
      reactorDeviceId: string;
      reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂';
      updatedAt: number;
      peerDisplayName: string | null;
      peerAvatarEmoji: string | null;
      peerAvatarBg: string | null;
      localDisplayName: string | null;
      localAvatarEmoji: string | null;
      localAvatarBg: string | null;
    }>;

    return rows.map((row) => ({
      deviceId: row.reactorDeviceId,
      displayName: row.localDisplayName || row.peerDisplayName || `Contato ${row.reactorDeviceId.slice(0, 6)}`,
      avatarEmoji: row.localAvatarEmoji || row.peerAvatarEmoji || '🙂',
      avatarBg: row.localAvatarBg || row.peerAvatarBg || '#5b5fc7',
      reaction: row.reaction,
      updatedAt: row.updatedAt
    }));
  }

  markAnnouncementRead(messageIds: string[], readerDeviceId: string, readAt = Date.now()): string[] {
    const uniqueIds = Array.from(
      new Set(
        messageIds
          .map((value) => (value || '').trim())
          .filter((value) => value.length > 0)
      )
    );
    if (uniqueIds.length === 0) return [];

    const normalizedReadAt =
      Number.isFinite(readAt) && readAt > 0 ? Math.trunc(readAt) : Date.now();
    const upsert = this.db.prepare(
      `INSERT INTO announcement_reads(messageId, readerDeviceId, readAt)
       VALUES (?, ?, ?)
       ON CONFLICT(messageId, readerDeviceId) DO UPDATE SET
         readAt = CASE
           WHEN excluded.readAt >= announcement_reads.readAt THEN excluded.readAt
           ELSE announcement_reads.readAt
         END`
    );

    const tx = this.db.transaction(() => {
      for (const messageId of uniqueIds) {
        upsert.run(messageId, readerDeviceId, normalizedReadAt);
      }
      return uniqueIds;
    });

    return tx();
  }

  replaceAnnouncementReads(
    snapshot: Record<string, Record<string, number>>,
    options?: { replaceAll?: boolean }
  ): string[] {
    const listAnnouncementIds = this.db.prepare(
      `SELECT messageId
       FROM messages
       WHERE conversationId = 'announcements' AND deletedAt IS NULL`
    );
    const deleteAll = this.db.prepare(
      `DELETE FROM announcement_reads
       WHERE messageId IN (
         SELECT messageId FROM messages WHERE conversationId = 'announcements'
       )`
    );
    const deleteForMessage = this.db.prepare(
      'DELETE FROM announcement_reads WHERE messageId = ?'
    );
    const upsert = this.db.prepare(
      `INSERT INTO announcement_reads(messageId, readerDeviceId, readAt)
       VALUES (?, ?, ?)
       ON CONFLICT(messageId, readerDeviceId) DO UPDATE SET
         readAt = CASE
           WHEN excluded.readAt >= announcement_reads.readAt THEN excluded.readAt
           ELSE announcement_reads.readAt
         END`
    );

    const tx = this.db.transaction(() => {
      const replaceAll = options?.replaceAll !== false;
      const activeIds = new Set(
        (listAnnouncementIds.all() as Array<{ messageId: string }>).map((row) => row.messageId)
      );
      if (replaceAll) {
        deleteAll.run();
      }

      const touched = new Set<string>();
      for (const [messageId, byDevice] of Object.entries(snapshot)) {
        if (!activeIds.has(messageId)) continue;
        if (!replaceAll) {
          deleteForMessage.run(messageId);
        }
        for (const [deviceId, rawReadAt] of Object.entries(byDevice || {})) {
          const cleanDeviceId = (deviceId || '').trim();
          const readAt =
            Number.isFinite(rawReadAt) && rawReadAt > 0 ? Math.trunc(rawReadAt) : Date.now();
          if (!cleanDeviceId) continue;
          upsert.run(messageId, cleanDeviceId, readAt);
          touched.add(messageId);
        }
      }
      return Array.from(touched.values());
    });

    return tx();
  }

  getAnnouncementReadSummary(
    messageIds: string[],
    localDeviceId: string
  ): Record<string, AnnouncementReadSummary> {
    if (messageIds.length === 0) return {};
    const uniqueIds = Array.from(new Set(messageIds));
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT messageId, readerDeviceId
         FROM announcement_reads
         WHERE messageId IN (${placeholders})`
      )
      .all(...uniqueIds) as Array<{ messageId: string; readerDeviceId: string }>;
    const result: Record<string, AnnouncementReadSummary> = {};
    for (const messageId of uniqueIds) {
      result[messageId] = { count: 0, readByMe: false };
    }
    for (const row of rows) {
      const current = result[row.messageId] || { count: 0, readByMe: false };
      current.count += 1;
      if (row.readerDeviceId === localDeviceId) {
        current.readByMe = true;
      }
      result[row.messageId] = current;
    }
    return result;
  }

  getAnnouncementReadDetails(messageId: string): AnnouncementReadDetail[] {
    const rows = this.db
      .prepare(
        `SELECT
           r.readerDeviceId,
           r.readAt,
           p.displayName AS peerDisplayName,
           p.avatarEmoji AS peerAvatarEmoji,
           p.avatarBg AS peerAvatarBg,
           local.displayName AS localDisplayName,
           local.avatarEmoji AS localAvatarEmoji,
           local.avatarBg AS localAvatarBg
         FROM announcement_reads r
         LEFT JOIN peers_cache p ON p.deviceId = r.readerDeviceId
         LEFT JOIN profile local ON local.deviceId = r.readerDeviceId
         WHERE r.messageId = ?
         ORDER BY r.readAt ASC, r.readerDeviceId ASC`
      )
      .all(messageId) as Array<{
      readerDeviceId: string;
      readAt: number;
      peerDisplayName: string | null;
      peerAvatarEmoji: string | null;
      peerAvatarBg: string | null;
      localDisplayName: string | null;
      localAvatarEmoji: string | null;
      localAvatarBg: string | null;
    }>;

    return rows.map((row) => ({
      deviceId: row.readerDeviceId,
      displayName: row.localDisplayName || row.peerDisplayName || `Contato ${row.readerDeviceId.slice(0, 6)}`,
      avatarEmoji: row.localAvatarEmoji || row.peerAvatarEmoji || '🙂',
      avatarBg: row.localAvatarBg || row.peerAvatarBg || '#5b5fc7',
      readAt: row.readAt
    }));
  }

  getExportMessages(conversationId: string): DbMessage[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversationId = ?
           AND deletedAt IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM hidden_messages h WHERE h.messageId = messages.messageId
           )
         ORDER BY createdAt ASC, messageId ASC`
      )
      .all(conversationId) as DbMessage[];
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
    editedAt?: number | null;
  }): DbMessage | undefined {
    this.db
      .prepare(
        `UPDATE messages
         SET bodyText = CASE
               WHEN ? IS NULL AND editedAt IS NOT NULL THEN bodyText
               WHEN ? IS NOT NULL AND editedAt IS NOT NULL AND ? < editedAt THEN bodyText
               ELSE ?
             END,
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
             forwardedFromMessageId = COALESCE(?, forwardedFromMessageId),
             editedAt = CASE
               WHEN ? IS NULL THEN editedAt
               WHEN editedAt IS NULL OR ? >= editedAt THEN ?
               ELSE editedAt
             END
         WHERE messageId = ?`
      )
      .run(
        input.editedAt ?? null,
        input.editedAt ?? null,
        input.editedAt ?? null,
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
        input.editedAt ?? null,
        input.editedAt ?? null,
        input.editedAt ?? null,
        input.messageId
      );
    return this.getMessageById(input.messageId);
  }

  getMessageById(messageId: string): DbMessage | undefined {
    return this.db
      .prepare('SELECT * FROM messages WHERE messageId = ? LIMIT 1')
      .get(messageId) as DbMessage | undefined;
  }

  enqueueOutboundFrame(frame: ProtocolFrame): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO outbound_frames(messageId, frameJson, attempts, lastError, nextAttemptAt, createdAt, updatedAt)
      VALUES (?, ?, 0, NULL, 0, ?, ?)
      ON CONFLICT(messageId) DO UPDATE SET
        frameJson = excluded.frameJson,
        updatedAt = excluded.updatedAt
    `).run(frame.messageId, JSON.stringify(frame), now, now);
  }

  completeOutboundFrame(messageId: string): void {
    this.db.prepare('DELETE FROM outbound_frames WHERE messageId = ?').run(messageId);
  }

  retryOutboundFrame(messageId: string, error: string, delayMs: number): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE outbound_frames
      SET attempts = attempts + 1,
          lastError = ?,
          nextAttemptAt = ?,
          updatedAt = ?
      WHERE messageId = ?
    `).run(error.slice(0, 500), now + Math.max(0, Math.trunc(delayMs)), now, messageId);
  }

  listDueOutboundFrames(limit = 100): Array<{ frame: ProtocolFrame; attempts: number }> {
    const rows = this.db.prepare(`
      SELECT messageId, frameJson, attempts
      FROM outbound_frames
      WHERE nextAttemptAt <= ?
      ORDER BY createdAt, messageId
      LIMIT ?
    `).all(Date.now(), Math.max(1, Math.min(Math.trunc(limit) || 100, 500))) as Array<{
      messageId: string;
      frameJson: string;
      attempts: number;
    }>;
    const result: Array<{ frame: ProtocolFrame; attempts: number }> = [];
    for (const row of rows) {
      try {
        const frame = JSON.parse(row.frameJson) as ProtocolFrame;
        if (frame && typeof frame.messageId === 'string' && typeof frame.type === 'string') {
          result.push({ frame, attempts: Math.max(0, row.attempts || 0) });
        }
      } catch {
        this.completeOutboundFrame(row.messageId);
      }
    }
    return result;
  }

  listOutboundFrames(limit = 100): Array<{ frame: ProtocolFrame; attempts: number }> {
    const rows = this.db.prepare(`
      SELECT messageId, frameJson, attempts
      FROM outbound_frames
      ORDER BY nextAttemptAt, createdAt, messageId
      LIMIT ?
    `).all(Math.max(1, Math.min(Math.trunc(limit) || 100, 500))) as Array<{
      messageId: string;
      frameJson: string;
      attempts: number;
    }>;
    return rows.flatMap((row) => {
      try {
        const frame = JSON.parse(row.frameJson) as ProtocolFrame;
        return frame && typeof frame.messageId === 'string' ? [{ frame, attempts: row.attempts }] : [];
      } catch {
        this.completeOutboundFrame(row.messageId);
        return [];
      }
    });
  }

  getNextOutboundAttemptAt(): number | null {
    const row = this.db.prepare('SELECT MIN(nextAttemptAt) AS nextAttemptAt FROM outbound_frames')
      .get() as { nextAttemptAt: number | null };
    return typeof row.nextAttemptAt === 'number' ? Math.max(0, row.nextAttemptAt) : null;
  }

  getOutboundFrameCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM outbound_frames').get() as { count: number };
    return row.count;
  }

  getMaxServerSeq(): number {
    const row = this.db.prepare('SELECT MAX(serverSeq) AS serverSeq FROM messages').get() as {
      serverSeq: number | null;
    };
    return typeof row.serverSeq === 'number' ? row.serverSeq : 0;
  }

  getCanonicalSyncCursor(): number | null {
    const row = this.db.prepare('SELECT serverSeq FROM canonical_sync_state WHERE id = 1').get() as {
      serverSeq: number;
    } | undefined;
    return row && Number.isFinite(row.serverSeq) ? Math.max(0, Math.trunc(row.serverSeq)) : null;
  }

  setCanonicalSyncCursor(serverSeq: number): void {
    const normalized = Math.max(0, Math.trunc(serverSeq) || 0);
    this.db.prepare(`
      INSERT INTO canonical_sync_state(id, serverSeq, updatedAt) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        serverSeq = MAX(canonical_sync_state.serverSeq, excluded.serverSeq),
        updatedAt = excluded.updatedAt
    `).run(normalized, Date.now());
  }

  getAttachmentDownloadCheckpoint(fileId: string): {
    fileId: string;
    messageId: string;
    tempPath: string;
    receivedBytes: number;
    nextChunkIndex: number;
    updatedAt: number;
  } | undefined {
    return this.db.prepare(`
      SELECT fileId, messageId, tempPath, receivedBytes, nextChunkIndex, updatedAt
      FROM attachment_download_checkpoints WHERE fileId = ?
    `).get(fileId) as ReturnType<DbService['getAttachmentDownloadCheckpoint']>;
  }

  saveAttachmentDownloadCheckpoint(input: {
    fileId: string;
    messageId: string;
    tempPath: string;
    receivedBytes: number;
    nextChunkIndex: number;
  }): void {
    this.db.prepare(`
      INSERT INTO attachment_download_checkpoints(
        fileId, messageId, tempPath, receivedBytes, nextChunkIndex, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(fileId) DO UPDATE SET
        messageId = excluded.messageId,
        tempPath = excluded.tempPath,
        receivedBytes = excluded.receivedBytes,
        nextChunkIndex = excluded.nextChunkIndex,
        updatedAt = excluded.updatedAt
    `).run(
      input.fileId,
      input.messageId,
      input.tempPath,
      Math.max(0, Math.trunc(input.receivedBytes)),
      Math.max(0, Math.trunc(input.nextChunkIndex)),
      Date.now()
    );
  }

  clearAttachmentDownloadCheckpoint(fileId: string): void {
    this.db.prepare('DELETE FROM attachment_download_checkpoints WHERE fileId = ?').run(fileId);
  }

  getMessageByFileId(fileId: string): DbMessage | undefined {
    return this.db
      .prepare('SELECT * FROM messages WHERE fileId = ? LIMIT 1')
      .get(fileId) as DbMessage | undefined;
  }

  getConversationServerCursor(conversationId: string, beforeCreatedAt?: number): number | null {
    if (!beforeCreatedAt) return null;
    const row = this.db
      .prepare(
        `SELECT MIN(serverSeq) AS serverSeq
         FROM messages
         WHERE conversationId = ? AND createdAt = ? AND serverSeq IS NOT NULL`
      )
      .get(conversationId, beforeCreatedAt) as { serverSeq: number | null } | undefined;
    return typeof row?.serverSeq === 'number' ? row.serverSeq : null;
  }

  updateMessageServerSeq(messageId: string, serverSeq?: number): void {
    if (!Number.isFinite(serverSeq) || Number(serverSeq) <= 0) return;
    this.db
      .prepare('UPDATE messages SET serverSeq = COALESCE(serverSeq, ?) WHERE messageId = ?')
      .run(Math.trunc(Number(serverSeq)), messageId);
  }

  getMessages(conversationId: string, limit: number, before?: number): DbMessage[] {
    if (before) {
      const rows = this.db
        .prepare(
          `SELECT * FROM messages
          WHERE conversationId = ?
            AND deletedAt IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM hidden_messages h WHERE h.messageId = messages.messageId
            )
            AND createdAt < ?
          ORDER BY createdAt DESC, messageId DESC
          LIMIT ?`
        )
        .all(conversationId, before, limit)
        .reverse() as DbMessage[];
      return this.hydrateGroupAttachmentPaths(rows);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversationId = ?
           AND deletedAt IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM hidden_messages h WHERE h.messageId = messages.messageId
           )
         ORDER BY createdAt DESC, messageId DESC
         LIMIT ?`
      )
      .all(conversationId, limit)
      .reverse() as DbMessage[];
    return this.hydrateGroupAttachmentPaths(rows);
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
           AND messageId IN (${placeholders})
           AND NOT EXISTS (
             SELECT 1 FROM hidden_messages h WHERE h.messageId = messages.messageId
           )`
      )
      .all(...uniqueIds) as DbMessage[];

    rows.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.messageId.localeCompare(b.messageId);
    });
    return this.hydrateGroupAttachmentPaths(rows);
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
           AND NOT EXISTS (
             SELECT 1 FROM hidden_messages h WHERE h.messageId = messages.messageId
           )
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
    const deletePendingReactions = this.db.prepare(
      `DELETE FROM pending_message_reactions
       WHERE messageId IN (
         SELECT messageId
         FROM messages
         WHERE conversationId = ?
       )`
    );
    const deleteHiddenMessages = this.db.prepare(
      `DELETE FROM hidden_messages
       WHERE messageId IN (
         SELECT messageId
         FROM messages
         WHERE conversationId = ?
       )`
    );
    const deleteAnnouncementReads = this.db.prepare(
      `DELETE FROM announcement_reads
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
      deletePendingReactions.run(id);
      deleteFavorites.run(id);
      deleteHiddenMessages.run(id);
      deleteAnnouncementReads.run(id);
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
    this.db.prepare('DELETE FROM message_reactions WHERE messageId = ?').run(messageId);
    this.db.prepare('DELETE FROM pending_message_reactions WHERE messageId = ?').run(messageId);
    this.db.prepare('DELETE FROM hidden_messages WHERE messageId = ?').run(messageId);
    this.db.prepare('DELETE FROM announcement_reads WHERE messageId = ?').run(messageId);
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
    username: string | null;
    department: string | null;
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
      username: row.username || '',
      department: row.department || '',
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
       WHERE conversationId = 'announcements' AND createdAt <= ?`
    );
    const remove = this.db.prepare(
      `DELETE FROM messages
       WHERE conversationId = 'announcements' AND createdAt <= ?`
    );
    const removeReactions = this.db.prepare(
      `DELETE FROM message_reactions
       WHERE messageId IN (
         SELECT messageId FROM messages
         WHERE conversationId = 'announcements' AND createdAt <= ?
       )`
    );
    const removePendingReactions = this.db.prepare(
      `DELETE FROM pending_message_reactions
       WHERE messageId IN (
         SELECT messageId FROM messages
         WHERE conversationId = 'announcements' AND createdAt <= ?
       )`
    );
    const removeHidden = this.db.prepare(
      `DELETE FROM hidden_messages
       WHERE messageId IN (
         SELECT messageId FROM messages
         WHERE conversationId = 'announcements' AND createdAt <= ?
       )`
    );
    const removeReads = this.db.prepare(
      `DELETE FROM announcement_reads
       WHERE messageId IN (
         SELECT messageId FROM messages
         WHERE conversationId = 'announcements' AND createdAt <= ?
       )`
    );
    const touchConversation = this.db.prepare(
      'UPDATE conversations SET updatedAt = ? WHERE id = ?'
    );

    const tx = this.db.transaction((cutoff: number) => {
      const rows = list.all(cutoff) as Array<{ messageId: string }>;
      if (rows.length === 0) return [] as string[];
      removeReactions.run(cutoff);
      removePendingReactions.run(cutoff);
      removeHidden.run(cutoff);
      removeReads.run(cutoff);
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
       WHERE conversationId = 'announcements' AND messageId IN (${placeholders})`
    );
    const removeMessages = this.db.prepare(
      `DELETE FROM messages
       WHERE conversationId = 'announcements' AND messageId IN (${placeholders})`
    );
    const removeReactions = this.db.prepare(
      `DELETE FROM message_reactions
       WHERE messageId IN (${placeholders})`
    );
    const removePendingReactions = this.db.prepare(
      `DELETE FROM pending_message_reactions
       WHERE messageId IN (${placeholders})`
    );
    const removeHidden = this.db.prepare(
      `DELETE FROM hidden_messages
       WHERE messageId IN (${placeholders})`
    );
    const removeReads = this.db.prepare(
      `DELETE FROM announcement_reads
       WHERE messageId IN (${placeholders})`
    );
    const touchConversation = this.db.prepare(
      'UPDATE conversations SET updatedAt = ? WHERE id = ?'
    );

    const tx = this.db.transaction(() => {
      const rows = list.all(...uniqueIds) as Array<{ messageId: string }>;
      if (rows.length === 0) return [] as string[];
      removeReactions.run(...uniqueIds);
      removePendingReactions.run(...uniqueIds);
      removeHidden.run(...uniqueIds);
      removeReads.run(...uniqueIds);
      removeMessages.run(...uniqueIds);
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
         WHERE conversationId = 'announcements' AND deletedAt IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM hidden_messages h WHERE h.messageId = messages.messageId
           )`
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

  getDoNotDisturbUntil(): number {
    const raw = Number(this.getAppSetting('notifications.dndUntil') || 0);
    return Number.isFinite(raw) && raw > Date.now() ? Math.trunc(raw) : 0;
  }

  setDoNotDisturbUntil(value: number): number {
    const normalized = Number.isFinite(value) && value > Date.now() ? Math.trunc(value) : 0;
    if (normalized > 0) {
      this.setAppSetting('notifications.dndUntil', String(normalized));
    } else {
      this.deleteAppSetting('notifications.dndUntil');
    }
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
