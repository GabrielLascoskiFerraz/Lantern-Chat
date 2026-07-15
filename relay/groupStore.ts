import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EncryptedFields } from './security';
import { EncryptedChunkStore } from './encryptedChunkStore';
import {
  GroupReactionValue,
  RelayGroup,
  RelayGroupAttachmentMetadata,
  RelayGroupEvent,
  RelayGroupEventType,
  RelayGroupFileChunk,
  RelayGroupFileOffer,
  RelayGroupMember,
  RelayGroupSettings,
  RelayGroupSnapshot
} from './groupTypes';

const GROUP_UPLOAD_STALE_MS = 2 * 60 * 60 * 1000;
const GROUP_FILE_CHUNK_SIZE_BYTES = 64 * 1024;
const GROUP_FILE_MAX_BYTES = 200 * 1024 * 1024;
const GROUP_MESSAGE_EDIT_WINDOW_MS = 10 * 60 * 1000;

type GroupStoreLog = (
  event: string,
  details?: Record<string, unknown>,
  options?: { level?: 'debug' | 'info' | 'warn' | 'error'; rateKey?: string; rateLimitMs?: number }
) => void;

interface PersistedGroupStore {
  version: 1;
  groups: RelayGroup[];
  eventsByGroupId: Record<string, RelayGroupEvent[]>;
  attachments: RelayGroupAttachmentMetadata[];
}

export interface CanonicalStatePersistence {
  location: string;
  read<T>(key: string, version?: number): T | null;
  write<T>(key: string, value: T, version?: number): void;
}

const GROUP_STATE_KEY = 'groups';
const GROUP_STATE_VERSION = 1;

interface ActiveUpload {
  metadata: RelayGroupAttachmentMetadata;
  nextIndex: number;
  totalChunks: number;
  receivedBytes: number;
  hash: ReturnType<typeof createHash>;
  startedAt: number;
}

export interface RelayPeerProfileLike {
  deviceId: string;
  displayName: string;
  avatarEmoji: string;
  avatarBg: string;
}

export interface CreateGroupRequest {
  actor: RelayPeerProfileLike;
  name: string;
  emoji: string;
  avatarBg: string;
  description: string;
  memberDeviceIds: string[];
}

export interface UpdateGroupRequest {
  actorDeviceId: string;
  groupId: string;
  name?: string;
  emoji?: string;
  avatarBg?: string;
  description?: string;
  settings?: Partial<RelayGroupSettings>;
}

export interface GroupMessageRequest {
  actorDeviceId: string;
  groupId: string;
  messageId: string;
  createdAt: number;
  payload: unknown;
}

export interface InitGroupFileRequest {
  actorDeviceId: string;
  offer: RelayGroupFileOffer;
  createdAt: number;
}

export interface GroupFileInitResult {
  metadata: RelayGroupAttachmentMetadata;
  // Chunks abaixo deste índice já foram gravados e confirmados pelo Relay.
  nextIndex: number;
}

export class GroupStore {
  private readonly groupsById = new Map<string, RelayGroup>();
  private readonly eventsByGroupId = new Map<string, RelayGroupEvent[]>();
  private readonly attachmentsByFileId = new Map<string, RelayGroupAttachmentMetadata>();
  private readonly uploadsByFileId = new Map<string, ActiveUpload>();
  private readonly chunks: EncryptedChunkStore;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly legacyStoreFile: string,
    private readonly attachmentsDir: string,
    private readonly log: GroupStoreLog,
    private readonly encrypted?: EncryptedFields,
    private readonly canonicalState?: CanonicalStatePersistence
  ) {
    if (!encrypted) throw new Error('A persistência canônica de grupos exige criptografia.');
    this.chunks = new EncryptedChunkStore(attachmentsDir, encrypted);
    fs.mkdirSync(path.dirname(this.legacyStoreFile), { recursive: true });
    fs.mkdirSync(this.attachmentsDir, { recursive: true });
    this.load();
  }

  close(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.uploadsByFileId.clear();
    this.persist();
  }

  getStoreFile(): string {
    return this.canonicalState?.location || this.legacyStoreFile;
  }

  getAttachmentsDir(): string {
    return this.attachmentsDir;
  }

  private load(): void {
    try {
      let parsed = this.canonicalState?.read<Partial<PersistedGroupStore>>(
        GROUP_STATE_KEY,
        GROUP_STATE_VERSION
      ) || null;
      let importedLegacy = false;
      if (!parsed && fs.existsSync(this.legacyStoreFile)) {
        const stored = fs.readFileSync(this.legacyStoreFile, 'utf8');
        const plain = stored.startsWith('gcm-v1.') && this.encrypted
          ? this.encrypted.decrypt(stored)
          : stored;
        parsed = JSON.parse(plain) as Partial<PersistedGroupStore>;
        importedLegacy = Boolean(this.canonicalState);
      }
      if (!parsed) return;
      if (parsed.version !== 1) {
        return;
      }
      for (const group of parsed.groups || []) {
        const normalized = this.normalizeGroup(group);
        if (normalized) {
          this.groupsById.set(normalized.groupId, normalized);
        }
      }
      for (const [groupId, events] of Object.entries(parsed.eventsByGroupId || {})) {
        const normalizedEvents = (events || [])
          .map((event) => this.normalizeEvent(event))
          .filter((event): event is RelayGroupEvent => Boolean(event))
          .sort((a, b) => a.seq - b.seq || a.eventId.localeCompare(b.eventId));
        if (normalizedEvents.length > 0) {
          this.eventsByGroupId.set(groupId, normalizedEvents);
        }
      }
      for (const metadata of parsed.attachments || []) {
        const normalized = this.normalizeAttachment(metadata);
        if (normalized && !normalized.deletedAt) {
          this.attachmentsByFileId.set(normalized.fileId, normalized);
        }
      }
      this.log('group_store_loaded', {
        file: this.getStoreFile(),
        groups: this.groupsById.size,
        attachments: this.attachmentsByFileId.size,
        importedLegacy
      });
      if (importedLegacy) {
        this.persist();
        this.log('group_store_migrated_to_sqlite', {
          legacyFile: this.legacyStoreFile,
          databaseFile: this.canonicalState?.location
        });
      }
    } catch (error) {
      this.log(
        'group_store_load_failed',
        {
          file: this.getStoreFile(),
          message: error instanceof Error ? error.message : String(error)
        },
        { level: 'warn' }
      );
    }
  }

  private schedulePersist(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persist();
    }, 250);
    this.saveTimer.unref?.();
  }

  private persist(): void {
    try {
      const body: PersistedGroupStore = {
        version: 1,
        groups: Array.from(this.groupsById.values()),
        eventsByGroupId: Object.fromEntries(this.eventsByGroupId.entries()),
        attachments: Array.from(this.attachmentsByFileId.values())
      };
      if (this.canonicalState) {
        this.canonicalState.write(GROUP_STATE_KEY, body, GROUP_STATE_VERSION);
        return;
      }
      fs.mkdirSync(path.dirname(this.legacyStoreFile), { recursive: true });
      const tempFile = `${this.legacyStoreFile}.tmp`;
      const serialized = JSON.stringify(body);
      fs.writeFileSync(tempFile, this.encrypted ? this.encrypted.encrypt(serialized) : serialized);
      fs.renameSync(tempFile, this.legacyStoreFile);
    } catch (error) {
      this.log(
        'group_store_persist_failed',
        {
          file: this.getStoreFile(),
          message: error instanceof Error ? error.message : String(error)
        },
        { level: 'warn' }
      );
    }
  }

  private normalizeGroup(value: RelayGroup): RelayGroup | null {
    const groupId = (value.groupId || '').trim();
    if (!groupId) return null;
    const settings = value.settings || {
      allowMembersToPin: true,
      allowMembersToEditInfo: false
    };
    const members: Record<string, RelayGroupMember> = {};
    for (const [deviceId, member] of Object.entries(value.members || {})) {
      const normalized = this.normalizeMember(groupId, { ...member, deviceId });
      if (normalized) {
        members[normalized.deviceId] = normalized;
      }
    }
    return {
      groupId,
      name: (value.name || '').trim() || 'Grupo',
      emoji: (value.emoji || '').trim() || '👥',
      avatarBg: (value.avatarBg || '').trim() || '#147ad6',
      description: (value.description || '').trim(),
      createdByDeviceId: (value.createdByDeviceId || '').trim(),
      createdAt: this.safeTime(value.createdAt),
      updatedAt: this.safeTime(value.updatedAt),
      lastEventSeq: Math.max(0, Math.trunc(value.lastEventSeq || 0)),
      deletedAt: value.deletedAt && value.deletedAt > 0 ? Math.trunc(value.deletedAt) : null,
      settings: {
        allowMembersToPin: settings.allowMembersToPin !== false,
        allowMembersToEditInfo: settings.allowMembersToEditInfo === true
      },
      members,
      pinnedMessageIds: Array.isArray(value.pinnedMessageIds)
        ? Array.from(new Set(value.pinnedMessageIds.filter((item) => typeof item === 'string')))
        : []
    };
  }

  private normalizeMember(groupId: string, value: RelayGroupMember): RelayGroupMember | null {
    const deviceId = (value.deviceId || '').trim();
    if (!deviceId) return null;
    return {
      groupId,
      deviceId,
      role: value.role === 'owner' || value.role === 'admin' ? value.role : 'member',
      status: value.status === 'left' || value.status === 'removed' ? value.status : 'active',
      displayNameSnapshot: value.displayNameSnapshot || null,
      avatarEmojiSnapshot: value.avatarEmojiSnapshot || null,
      avatarBgSnapshot: value.avatarBgSnapshot || null,
      joinedAt: this.safeTime(value.joinedAt),
      updatedAt: this.safeTime(value.updatedAt)
    };
  }

  private normalizeEvent(value: RelayGroupEvent): RelayGroupEvent | null {
    const eventId = (value.eventId || '').trim();
    const groupId = (value.groupId || '').trim();
    if (!eventId || !groupId) return null;
    return {
      eventId,
      groupId,
      seq: Math.max(1, Math.trunc(value.seq || 0)),
      type: value.type,
      actorDeviceId: (value.actorDeviceId || '').trim(),
      createdAt: this.safeTime(value.createdAt),
      payload: value.payload
    };
  }

  private normalizeAttachment(value: RelayGroupAttachmentMetadata): RelayGroupAttachmentMetadata | null {
    const fileId = (value.fileId || '').trim();
    const groupId = (value.groupId || '').trim();
    const messageId = (value.messageId || '').trim();
    if (!fileId || !groupId || !messageId) return null;
    return {
      groupId,
      messageId,
      fileId,
      senderDeviceId: (value.senderDeviceId || '').trim(),
      fileName: (value.fileName || '').trim() || 'arquivo',
      fileSize: Math.max(0, Math.trunc(value.fileSize || 0)),
      sha256: (value.sha256 || '').trim(),
      createdAt: this.safeTime(value.createdAt),
      expiresAt: this.safeTime(value.expiresAt),
      recipients: Array.from(new Set((value.recipients || []).filter(Boolean))),
      receivedByDeviceId: value.receivedByDeviceId || {},
      replyTo: value.replyTo,
      forwardedFromMessageId:
        typeof value.forwardedFromMessageId === 'string' && value.forwardedFromMessageId.trim()
          ? value.forwardedFromMessageId.trim()
          : null,
      uploadedAt: value.uploadedAt && value.uploadedAt > 0 ? Math.trunc(value.uploadedAt) : null,
      deletedAt: value.deletedAt && value.deletedAt > 0 ? Math.trunc(value.deletedAt) : null
    };
  }

  private safeTime(value: number | null | undefined): number {
    return Number.isFinite(value || 0) && (value || 0) > 0 ? Math.trunc(value || 0) : Date.now();
  }

  private assertActiveMember(group: RelayGroup, deviceId: string): RelayGroupMember {
    const member = group.members[deviceId];
    if (!member || member.status !== 'active') {
      throw new Error('Usuário não é participante ativo do grupo.');
    }
    return member;
  }

  private assertCanManageMembers(group: RelayGroup, actorDeviceId: string): void {
    const member = this.assertActiveMember(group, actorDeviceId);
    if (member.role !== 'owner' && member.role !== 'admin') {
      throw new Error('Sem permissão para gerenciar participantes.');
    }
  }

  private assertCanUpdateInfo(group: RelayGroup, actorDeviceId: string): void {
    const member = this.assertActiveMember(group, actorDeviceId);
    if (
      member.role !== 'owner' &&
      member.role !== 'admin' &&
      !group.settings.allowMembersToEditInfo
    ) {
      throw new Error('Sem permissão para editar dados do grupo.');
    }
  }

  private assertCanPin(group: RelayGroup, actorDeviceId: string): void {
    const member = this.assertActiveMember(group, actorDeviceId);
    if (member.role !== 'owner' && member.role !== 'admin' && !group.settings.allowMembersToPin) {
      throw new Error('Sem permissão para fixar mensagens.');
    }
  }

  private assertOwner(group: RelayGroup, actorDeviceId: string): RelayGroupMember {
    const member = this.assertActiveMember(group, actorDeviceId);
    if (member.role !== 'owner') {
      throw new Error('Apenas o dono do grupo pode executar esta ação.');
    }
    return member;
  }

  private nextSeq(group: RelayGroup): number {
    group.lastEventSeq = Math.max(0, group.lastEventSeq || 0) + 1;
    return group.lastEventSeq;
  }

  private findGroupMessageEvent(groupId: string, messageId: string): RelayGroupEvent | null {
    const cleanMessageId = (messageId || '').trim();
    if (!cleanMessageId) return null;
    return (
      (this.eventsByGroupId.get(groupId) || []).find((event) => {
        if (event.type !== 'group.message.created' || !event.payload || typeof event.payload !== 'object') {
          return false;
        }
        const payload = event.payload as { message?: { messageId?: unknown } };
        return payload.message?.messageId === cleanMessageId;
      }) || null
    );
  }

  private appendEvent(
    group: RelayGroup,
    type: RelayGroupEventType,
    actorDeviceId: string,
    payload: unknown,
    createdAtInput?: number
  ): RelayGroupEvent {
    const createdAt = this.safeTime(createdAtInput);
    const event: RelayGroupEvent = {
      eventId: randomUUID(),
      groupId: group.groupId,
      seq: this.nextSeq(group),
      type,
      actorDeviceId,
      createdAt,
      payload
    };
    group.updatedAt = Math.max(group.updatedAt || 0, createdAt);
    this.groupsById.set(group.groupId, group);
    const list = this.eventsByGroupId.get(group.groupId) || [];
    list.push(event);
    this.eventsByGroupId.set(group.groupId, list);
    this.schedulePersist();
    return event;
  }

  getGroup(groupId: string): RelayGroup | null {
    return this.groupsById.get((groupId || '').trim()) || null;
  }

  listGroupsForDevice(deviceId: string): RelayGroup[] {
    const cleanDeviceId = (deviceId || '').trim();
    return Array.from(this.groupsById.values())
      .filter((group) => {
        const member = group.members[cleanDeviceId];
        return Boolean(member && member.status === 'active' && !group.deletedAt);
      })
      .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  }

  snapshotForDevice(deviceId: string, knownSeqByGroup?: Record<string, number>): RelayGroupSnapshot[] {
    const cleanDeviceId = (deviceId || '').trim();
    const groups = this.listGroupsForDevice(cleanDeviceId);
    const includedIds = new Set(groups.map((group) => group.groupId));
    for (const groupId of Object.keys(knownSeqByGroup || {})) {
      if (includedIds.has(groupId)) continue;
      const group = this.groupsById.get(groupId);
      const member = group?.members[cleanDeviceId];
      if (!group || group.deletedAt || !member || member.status === 'active') continue;
      const knownSeq = Math.max(0, Math.trunc(knownSeqByGroup?.[group.groupId] || 0));
      const hasPendingEvents = (this.eventsByGroupId.get(group.groupId) || []).some(
        (event) => event.seq > knownSeq
      );
      if (!hasPendingEvents) continue;
      groups.push(group);
      includedIds.add(group.groupId);
    }
    return groups.map((group) => {
      const knownSeq = Math.max(0, Math.trunc(knownSeqByGroup?.[group.groupId] || 0));
      const pendingEvents = (this.eventsByGroupId.get(group.groupId) || [])
        .filter((event) => event.seq > knownSeq);
      const latestMessage = [...pendingEvents]
        .reverse()
        .find((event) => event.type === 'group.message.created');
      const stateEvents = pendingEvents
        .filter(
          (event) =>
            event.type === 'group.created' ||
            event.type === 'group.updated' ||
            event.type === 'group.deleted' ||
            event.type.startsWith('group.member.')
        )
        .slice(-20);
      const events = [...stateEvents, ...(latestMessage ? [latestMessage] : [])]
        .sort((left, right) => left.seq - right.seq || left.eventId.localeCompare(right.eventId));
      return {
        group,
        members: Object.values(group.members),
        pinnedMessageIds: group.pinnedMessageIds,
        events
      };
    });
  }

  historyPageForDevice(
    groupId: string,
    deviceId: string,
    before = Number.MAX_SAFE_INTEGER,
    limit = 100
  ): { events: RelayGroupEvent[]; hasMore: boolean } {
    const group = this.getRequiredGroup(groupId);
    this.assertActiveMember(group, deviceId);
    const safeBefore = Number.isFinite(before) ? Math.max(1, Math.trunc(before)) : Number.MAX_SAFE_INTEGER;
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 100, 500));
    const allEvents = this.eventsByGroupId.get(group.groupId) || [];
    const createdCandidates = allEvents
      .filter((event) => event.type === 'group.message.created' && event.createdAt < safeBefore)
      .slice(-(safeLimit + 1));
    const hasMore = createdCandidates.length > safeLimit;
    const createdPage = createdCandidates.slice(-safeLimit);
    const messageIds = new Set(
      createdPage
        .map((event) => {
          const payload = event.payload && typeof event.payload === 'object'
            ? event.payload as Record<string, unknown>
            : {};
          const message = payload.message && typeof payload.message === 'object'
            ? payload.message as Record<string, unknown>
            : {};
          return typeof message.messageId === 'string' ? message.messageId : '';
        })
        .filter(Boolean)
    );
    if (messageIds.size === 0) return { events: [], hasMore: false };
    const events = allEvents.filter((event) => {
      if (createdPage.some((created) => created.eventId === event.eventId)) return true;
      const payload = event.payload && typeof event.payload === 'object'
        ? event.payload as Record<string, unknown>
        : {};
      const targetMessageId =
        typeof payload.targetMessageId === 'string'
          ? payload.targetMessageId
          : typeof payload.messageId === 'string'
            ? payload.messageId
            : '';
      if (targetMessageId && messageIds.has(targetMessageId)) return true;
      const metadata = payload.metadata && typeof payload.metadata === 'object'
        ? payload.metadata as Record<string, unknown>
        : {};
      return typeof metadata.messageId === 'string' && messageIds.has(metadata.messageId);
    });
    return { events, hasMore };
  }

  exportMessagesForDevice(groupId: string, deviceId: string): Array<{
    messageId: string; senderUserId: string; type: 'text' | 'file'; text: string;
    fileName: string; fileSize: number; createdAt: number; editedAt: number;
  }> {
    const group = this.getRequiredGroup(groupId);
    this.assertActiveMember(group, deviceId);
    const messages = new Map<string, {
      messageId: string; senderUserId: string; type: 'text' | 'file'; text: string;
      fileName: string; fileSize: number; createdAt: number; editedAt: number;
    }>();
    for (const event of this.eventsByGroupId.get(group.groupId) || []) {
      const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
      if (event.type === 'group.message.created') {
        const value = payload.message && typeof payload.message === 'object' ? payload.message as Record<string, unknown> : {};
        const messageId = typeof value.messageId === 'string' ? value.messageId : '';
        if (!messageId) continue;
        const isFile = value.type === 'file';
        messages.set(messageId, {
          messageId,
          senderUserId: typeof value.senderDeviceId === 'string' ? value.senderDeviceId : event.actorDeviceId,
          type: isFile ? 'file' : 'text',
          text: typeof value.bodyText === 'string' ? value.bodyText : typeof value.text === 'string' ? value.text : '',
          fileName: typeof value.fileName === 'string' ? value.fileName : '',
          fileSize: typeof value.fileSize === 'number' ? value.fileSize : 0,
          createdAt: typeof value.createdAt === 'number' ? value.createdAt : event.createdAt,
          editedAt: typeof value.editedAt === 'number' ? value.editedAt : 0
        });
      } else if (event.type === 'group.message.edited') {
        const target = typeof payload.targetMessageId === 'string' ? payload.targetMessageId : '';
        const message = messages.get(target);
        if (message && typeof payload.text === 'string') {
          message.text = payload.text;
          message.editedAt = typeof payload.editedAt === 'number' ? payload.editedAt : event.createdAt;
        }
      } else if (event.type === 'group.message.deletedForEveryone') {
        const target = typeof payload.targetMessageId === 'string' ? payload.targetMessageId : '';
        messages.delete(target);
      }
    }
    return Array.from(messages.values()).sort((a, b) => a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId));
  }

  searchMessageIdsForDevice(
    groupId: string,
    deviceId: string,
    query: string,
    limit = 500,
    offset = 0
  ): string[] {
    const group = this.getRequiredGroup(groupId);
    this.assertActiveMember(group, deviceId);
    const needle = query.trim().toLocaleLowerCase('pt-BR');
    if (!needle) return [];
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 500, 2_000));
    const safeOffset = Math.max(0, Math.trunc(offset) || 0);
    const messages = new Map<string, string>();
    for (const event of this.eventsByGroupId.get(group.groupId) || []) {
      const payload = event.payload && typeof event.payload === 'object'
        ? event.payload as Record<string, unknown>
        : {};
      if (event.type === 'group.message.created') {
        const message = payload.message && typeof payload.message === 'object'
          ? payload.message as Record<string, unknown>
          : {};
        const messageId = typeof message.messageId === 'string' ? message.messageId : '';
        const text = [message.bodyText, message.text, message.fileName, message.filename]
          .filter((item): item is string => typeof item === 'string')
          .join('\n');
        if (messageId) messages.set(messageId, text);
      } else if (event.type === 'group.message.edited') {
        const target = typeof payload.targetMessageId === 'string' ? payload.targetMessageId : '';
        if (target && typeof payload.text === 'string') messages.set(target, payload.text);
      } else if (event.type === 'group.message.deletedForEveryone') {
        const target = typeof payload.targetMessageId === 'string' ? payload.targetMessageId : '';
        if (target) messages.delete(target);
      }
    }
    return Array.from(messages.entries())
      .filter(([, text]) => text.toLocaleLowerCase('pt-BR').includes(needle))
      .map(([messageId]) => messageId)
      .slice(safeOffset, safeOffset + safeLimit);
  }

  getActiveRecipientIds(groupId: string, includeSender = false, senderDeviceId?: string): string[] {
    const group = this.groupsById.get(groupId);
    if (!group) return [];
    return Object.values(group.members)
      .filter((member) => member.status === 'active')
      .map((member) => member.deviceId)
      .filter((deviceId) => includeSender || deviceId !== senderDeviceId);
  }

  createGroup(input: CreateGroupRequest): { group: RelayGroup; events: RelayGroupEvent[] } {
    const now = Date.now();
    const actorDeviceId = input.actor.deviceId.trim();
    if (!actorDeviceId) {
      throw new Error('Criador inválido.');
    }
    const groupId = randomUUID();
    const memberIds = Array.from(new Set([actorDeviceId, ...input.memberDeviceIds.map((id) => id.trim()).filter(Boolean)]));
    const members: Record<string, RelayGroupMember> = {};
    for (const deviceId of memberIds) {
      members[deviceId] = {
        groupId,
        deviceId,
        role: deviceId === actorDeviceId ? 'owner' : 'member',
        status: 'active',
        displayNameSnapshot: deviceId === actorDeviceId ? input.actor.displayName : null,
        avatarEmojiSnapshot: deviceId === actorDeviceId ? input.actor.avatarEmoji : null,
        avatarBgSnapshot: deviceId === actorDeviceId ? input.actor.avatarBg : null,
        joinedAt: now,
        updatedAt: now
      };
    }

    const group: RelayGroup = {
      groupId,
      name: input.name.trim() || 'Grupo',
      emoji: input.emoji.trim() || '👥',
      avatarBg: input.avatarBg.trim() || '#147ad6',
      description: input.description.trim(),
      createdByDeviceId: actorDeviceId,
      createdAt: now,
      updatedAt: now,
      lastEventSeq: 0,
      deletedAt: null,
      settings: {
        allowMembersToPin: true,
        allowMembersToEditInfo: false
      },
      members,
      pinnedMessageIds: []
    };
    this.groupsById.set(groupId, group);
    const event = this.appendEvent(group, 'group.created', actorDeviceId, {
      group,
      members: Object.values(members),
      pinnedMessageIds: []
    }, now);
    return { group, events: [event] };
  }

  updateGroup(input: UpdateGroupRequest): RelayGroupEvent {
    const group = this.getRequiredGroup(input.groupId);
    if (input.settings && Object.keys(input.settings).length > 0) {
      this.assertCanManageMembers(group, input.actorDeviceId);
    } else {
      this.assertCanUpdateInfo(group, input.actorDeviceId);
    }
    const settings = input.settings || {};
    group.name = input.name !== undefined ? input.name.trim() || group.name : group.name;
    group.emoji = input.emoji !== undefined ? input.emoji.trim() || group.emoji : group.emoji;
    group.avatarBg = input.avatarBg !== undefined ? input.avatarBg.trim() || group.avatarBg : group.avatarBg;
    group.description = input.description !== undefined ? input.description.trim() : group.description;
    group.settings = {
      allowMembersToPin:
        settings.allowMembersToPin === undefined
          ? group.settings.allowMembersToPin
          : settings.allowMembersToPin !== false,
      allowMembersToEditInfo:
        settings.allowMembersToEditInfo === undefined
          ? group.settings.allowMembersToEditInfo
          : settings.allowMembersToEditInfo === true
    };
    return this.appendEvent(group, 'group.updated', input.actorDeviceId, {
      group
    });
  }

  deleteGroup(groupId: string, actorDeviceId: string): RelayGroupEvent {
    const group = this.getRequiredGroup(groupId);
    this.assertOwner(group, actorDeviceId);
    const now = Date.now();
    group.deletedAt = now;
    group.updatedAt = now;
    for (const metadata of Array.from(this.attachmentsByFileId.values())) {
      if (metadata.groupId === group.groupId && !metadata.deletedAt) {
        this.cleanupAttachment(metadata, true);
      }
    }
    return this.appendEvent(group, 'group.deleted', actorDeviceId, {
      group
    }, now);
  }

  addMembers(groupId: string, actorDeviceId: string, memberDeviceIds: string[]): RelayGroupEvent {
    const group = this.getRequiredGroup(groupId);
    this.assertCanManageMembers(group, actorDeviceId);
    const now = Date.now();
    const added: RelayGroupMember[] = [];
    for (const deviceId of Array.from(new Set(memberDeviceIds.map((id) => id.trim()).filter(Boolean)))) {
      const existing = group.members[deviceId];
      const member: RelayGroupMember = {
        groupId,
        deviceId,
        role: existing?.role || 'member',
        status: 'active',
        displayNameSnapshot: existing?.displayNameSnapshot || null,
        avatarEmojiSnapshot: existing?.avatarEmojiSnapshot || null,
        avatarBgSnapshot: existing?.avatarBgSnapshot || null,
        joinedAt: existing?.joinedAt || now,
        updatedAt: now
      };
      group.members[deviceId] = member;
      added.push(member);
    }
    return this.appendEvent(group, 'group.member.added', actorDeviceId, {
      group,
      members: added,
      pinnedMessageIds: group.pinnedMessageIds
    }, now);
  }

  removeMember(groupId: string, actorDeviceId: string, targetDeviceId: string): RelayGroupEvent {
    const group = this.getRequiredGroup(groupId);
    this.assertCanManageMembers(group, actorDeviceId);
    const target = this.assertActiveMember(group, targetDeviceId);
    if (target.role === 'owner') {
      throw new Error('Não é possível remover o dono do grupo.');
    }
    target.status = 'removed';
    target.updatedAt = Date.now();
    group.members[target.deviceId] = target;
    return this.appendEvent(group, 'group.member.removed', actorDeviceId, {
      deviceId: target.deviceId
    }, target.updatedAt);
  }

  changeMemberRole(
    groupId: string,
    actorDeviceId: string,
    targetDeviceId: string,
    role: 'admin' | 'member'
  ): RelayGroupEvent {
    const group = this.getRequiredGroup(groupId);
    this.assertOwner(group, actorDeviceId);
    const target = this.assertActiveMember(group, targetDeviceId);
    if (target.role === 'owner') {
      throw new Error('Não é possível alterar a função do dono.');
    }
    target.role = role;
    target.updatedAt = Date.now();
    group.members[target.deviceId] = target;
    return this.appendEvent(group, 'group.member.roleChanged', actorDeviceId, {
      member: target
    }, target.updatedAt);
  }

  transferOwnership(groupId: string, actorDeviceId: string, targetDeviceId: string): RelayGroupEvent {
    const group = this.getRequiredGroup(groupId);
    const owner = this.assertOwner(group, actorDeviceId);
    const target = this.assertActiveMember(group, targetDeviceId);
    if (target.deviceId === owner.deviceId) {
      throw new Error('Este usuário já é o dono do grupo.');
    }
    const now = Date.now();
    owner.role = 'admin';
    owner.updatedAt = now;
    target.role = 'owner';
    target.updatedAt = now;
    group.members[owner.deviceId] = owner;
    group.members[target.deviceId] = target;
    return this.appendEvent(group, 'group.member.roleChanged', actorDeviceId, {
      members: [owner, target],
      ownerDeviceId: target.deviceId
    }, now);
  }

  leaveGroup(groupId: string, actorDeviceId: string): RelayGroupEvent {
    const group = this.getRequiredGroup(groupId);
    const member = this.assertActiveMember(group, actorDeviceId);
    if (member.role === 'owner') {
      const activeAdmins = Object.values(group.members).filter(
        (candidate) => candidate.status === 'active' && candidate.role === 'admin'
      );
      if (activeAdmins.length === 0) {
        throw new Error('Transfira a propriedade antes de sair do grupo.');
      }
      activeAdmins[0].role = 'owner';
      activeAdmins[0].updatedAt = Date.now();
      group.members[activeAdmins[0].deviceId] = activeAdmins[0];
    }
    member.status = 'left';
    member.updatedAt = Date.now();
    group.members[actorDeviceId] = member;
    return this.appendEvent(group, 'group.member.left', actorDeviceId, {
      deviceId: actorDeviceId
    }, member.updatedAt);
  }

  appendGroupMessage(input: GroupMessageRequest): RelayGroupEvent {
    const group = this.getRequiredGroup(input.groupId);
    this.assertActiveMember(group, input.actorDeviceId);

    const messageId = (() => {
      if (!input.payload || typeof input.payload !== 'object') return '';
      const payload = input.payload as { message?: { messageId?: unknown } };
      return typeof payload.message?.messageId === 'string' ? payload.message.messageId.trim() : '';
    })();
    if (messageId) {
      const existing = (this.eventsByGroupId.get(group.groupId) || []).find((event) => {
        if (event.type !== 'group.message.created' || !event.payload || typeof event.payload !== 'object') {
          return false;
        }
        const payload = event.payload as { message?: { messageId?: unknown } };
        return payload.message?.messageId === messageId;
      });
      if (existing) return existing;
    }
    return this.appendEvent(group, 'group.message.created', input.actorDeviceId, input.payload, input.createdAt);
  }

  editGroupMessage(groupId: string, actorDeviceId: string, targetMessageId: string, text: string, editedAt: number): RelayGroupEvent {
    const group = this.getRequiredGroup(groupId);
    this.assertActiveMember(group, actorDeviceId);
    const original = this.findGroupMessageEvent(group.groupId, targetMessageId);
    if (!original) throw new Error('Mensagem não encontrada no grupo.');
    if (original.actorDeviceId !== actorDeviceId) {
      throw new Error('Você só pode editar suas próprias mensagens.');
    }
    if (Date.now() - original.createdAt > GROUP_MESSAGE_EDIT_WINDOW_MS) {
      throw new Error('O prazo de 10 minutos para editar esta mensagem expirou.');
    }
    return this.appendEvent(group, 'group.message.edited', actorDeviceId, {
      targetMessageId,
      text,
      editedAt
    }, editedAt);
  }

  deleteGroupMessage(groupId: string, actorDeviceId: string, targetMessageId: string, deletedAt: number): RelayGroupEvent {
    const group = this.getRequiredGroup(groupId);
    this.assertActiveMember(group, actorDeviceId);
    const original = this.findGroupMessageEvent(group.groupId, targetMessageId);
    if (!original) throw new Error('Mensagem não encontrada no grupo.');
    if (original.actorDeviceId !== actorDeviceId) {
      throw new Error('Você só pode apagar suas próprias mensagens para todos.');
    }
    return this.appendEvent(group, 'group.message.deletedForEveryone', actorDeviceId, {
      targetMessageId,
      deletedAt
    }, deletedAt);
  }

  reactToGroupMessage(
    groupId: string,
    actorDeviceId: string,
    targetMessageId: string,
    reaction: GroupReactionValue | null,
    updatedAt: number
  ): RelayGroupEvent {
    const group = this.getRequiredGroup(groupId);
    this.assertActiveMember(group, actorDeviceId);
    return this.appendEvent(group, 'group.message.reactionChanged', actorDeviceId, {
      targetMessageId,
      reaction,
      updatedAt
    }, updatedAt);
  }

  setGroupMessagePinned(groupId: string, actorDeviceId: string, messageId: string, pinned: boolean): RelayGroupEvent {
    const group = this.getRequiredGroup(groupId);
    this.assertCanPin(group, actorDeviceId);
    const cleanMessageId = messageId.trim();
    if (!cleanMessageId) {
      throw new Error('Mensagem inválida para fixar.');
    }
    if (pinned) {
      group.pinnedMessageIds = [cleanMessageId, ...group.pinnedMessageIds.filter((id) => id !== cleanMessageId)];
    } else {
      group.pinnedMessageIds = group.pinnedMessageIds.filter((id) => id !== cleanMessageId);
    }
    return this.appendEvent(group, pinned ? 'group.message.pinned' : 'group.message.unpinned', actorDeviceId, {
      messageId: cleanMessageId,
      pinnedMessageIds: group.pinnedMessageIds
    });
  }

  initGroupFile(input: InitGroupFileRequest): GroupFileInitResult {
    const group = this.getRequiredGroup(input.offer.groupId);
    this.assertActiveMember(group, input.actorDeviceId);
    const fileSize = Math.max(0, Math.trunc(input.offer.size || 0));
    if (fileSize > GROUP_FILE_MAX_BYTES) {
      throw new Error('Arquivo excede o limite permitido para grupos.');
    }

    const activeUpload = this.uploadsByFileId.get(input.offer.fileId);
    if (activeUpload) {
      const current = activeUpload.metadata;
      const matchesCurrentUpload =
        current.groupId === group.groupId &&
        current.messageId === input.offer.messageId &&
        current.senderDeviceId === input.actorDeviceId &&
        current.fileSize === fileSize &&
        current.sha256 === input.offer.sha256;
      if (!matchesCurrentUpload) {
        throw new Error('fileId já está associado a outro upload de grupo.');
      }
      return { metadata: current, nextIndex: activeUpload.nextIndex };
    }

    const completedAttachment = this.attachmentsByFileId.get(input.offer.fileId);
    if (completedAttachment?.uploadedAt && !completedAttachment.deletedAt) {
      const matchesCompletedAttachment =
        completedAttachment.groupId === group.groupId &&
        completedAttachment.messageId === input.offer.messageId &&
        completedAttachment.senderDeviceId === input.actorDeviceId &&
        completedAttachment.fileSize === fileSize &&
        completedAttachment.sha256 === input.offer.sha256;
      if (!matchesCompletedAttachment) {
        throw new Error('fileId já está associado a outro anexo de grupo.');
      }
      return {
        metadata: completedAttachment,
        nextIndex: Math.max(1, Math.ceil(completedAttachment.fileSize / GROUP_FILE_CHUNK_SIZE_BYTES))
      };
    }

    const recipients = this.getActiveRecipientIds(group.groupId, true);
    const now = this.safeTime(input.createdAt);
    const metadata: RelayGroupAttachmentMetadata = {
      groupId: group.groupId,
      messageId: input.offer.messageId,
      fileId: input.offer.fileId,
      senderDeviceId: input.actorDeviceId,
      fileName: input.offer.filename,
      fileSize,
      sha256: input.offer.sha256,
      createdAt: now,
      expiresAt: Number.MAX_SAFE_INTEGER,
      recipients,
      receivedByDeviceId: {
        [input.actorDeviceId]: now
      },
      replyTo: input.offer.replyTo,
      forwardedFromMessageId: input.offer.forwardedFromMessageId || null,
      uploadedAt: null,
      deletedAt: null
    };

    this.chunks.reset(metadata.groupId, metadata.fileId, 'chunks');
    const totalChunks = Math.max(1, Math.ceil(metadata.fileSize / GROUP_FILE_CHUNK_SIZE_BYTES));
    const upload: ActiveUpload = {
      metadata,
      nextIndex: 0,
      totalChunks,
      receivedBytes: 0,
      hash: createHash('sha256'),
      startedAt: Date.now()
    };
    this.uploadsByFileId.set(metadata.fileId, upload);
    this.attachmentsByFileId.set(metadata.fileId, metadata);
    this.writeAttachmentMetadata(metadata);
    this.schedulePersist();

    return { metadata, nextIndex: 0 };
  }

  getAttachmentMetadata(fileId: string): RelayGroupAttachmentMetadata | null {
    const metadata = this.attachmentsByFileId.get((fileId || '').trim());
    if (!metadata || metadata.deletedAt) return null;
    return metadata;
  }

  async appendGroupFileChunk(chunk: RelayGroupFileChunk, actorDeviceId: string): Promise<void> {
    const upload = this.uploadsByFileId.get(chunk.fileId);
    if (!upload) {
      throw new Error('Upload de grupo não iniciado.');
    }
    if (upload.metadata.senderDeviceId !== actorDeviceId) {
      throw new Error('Upload de grupo pertence a outro usuário.');
    }
    if (chunk.index < upload.nextIndex && this.chunks.has(
      chunk.index,
      upload.metadata.groupId,
      upload.metadata.fileId,
      'chunks'
    )) {
      return;
    }
    if (chunk.index !== upload.nextIndex) {
      throw new Error('Chunk fora de ordem no upload de grupo.');
    }
    if (chunk.total !== upload.totalChunks) {
      throw new Error('Total de chunks inconsistente.');
    }
    const buffer = Buffer.from(chunk.dataBase64 || '', 'base64');
    const expectedLength = chunk.index === upload.totalChunks - 1
      ? upload.metadata.fileSize - chunk.index * GROUP_FILE_CHUNK_SIZE_BYTES
      : GROUP_FILE_CHUNK_SIZE_BYTES;
    if (buffer.length !== Math.max(0, expectedLength)) {
      throw new Error('Tamanho de chunk inconsistente no upload de grupo.');
    }
    upload.receivedBytes += buffer.length;
    if (upload.receivedBytes > upload.metadata.fileSize) {
      this.cleanupAttachment(upload.metadata, true);
      this.uploadsByFileId.delete(chunk.fileId);
      throw new Error('Upload de grupo excedeu o tamanho esperado.');
    }
    upload.hash.update(buffer);
    this.chunks.write(
      chunk.index,
      buffer,
      upload.metadata.groupId,
      upload.metadata.fileId,
      'chunks'
    );
    upload.nextIndex += 1;
  }

  async completeGroupFile(fileId: string, actorDeviceId: string): Promise<RelayGroupAttachmentMetadata> {
    const upload = this.uploadsByFileId.get(fileId);
    if (!upload) {
      const completed = this.attachmentsByFileId.get(fileId);
      if (completed?.uploadedAt && !completed.deletedAt && completed.senderDeviceId === actorDeviceId) {
        return completed;
      }
      throw new Error('Upload de grupo não iniciado.');
    }
    if (upload.metadata.senderDeviceId !== actorDeviceId) {
      throw new Error('Upload de grupo pertence a outro usuário.');
    }
    if (upload.nextIndex !== upload.totalChunks) {
      throw new Error('Upload de grupo incompleto.');
    }
    const digest = upload.hash.digest('hex');
    if (digest !== upload.metadata.sha256) {
      this.cleanupAttachment(upload.metadata, true);
      this.uploadsByFileId.delete(fileId);
      throw new Error('SHA-256 inválido no upload de grupo.');
    }
    if (upload.receivedBytes !== upload.metadata.fileSize) {
      this.cleanupAttachment(upload.metadata, true);
      this.uploadsByFileId.delete(fileId);
      throw new Error('Tamanho inválido no upload de grupo.');
    }
    upload.metadata.uploadedAt = Date.now();
    this.attachmentsByFileId.set(fileId, upload.metadata);
    this.writeAttachmentMetadata(upload.metadata);
    this.uploadsByFileId.delete(fileId);
    this.schedulePersist();
    return upload.metadata;
  }

  async *createAttachmentChunkStream(
    fileId: string,
    requesterDeviceId: string,
    startIndex = 0
  ): AsyncGenerator<RelayGroupFileChunk, void, void> {
    const metadata = this.attachmentsByFileId.get(fileId);
    if (!metadata || metadata.deletedAt || !metadata.uploadedAt) {
      throw new Error('Anexo indisponível no Relay.');
    }
    const group = this.getRequiredGroup(metadata.groupId);
    this.assertActiveMember(group, requesterDeviceId);
    if (
      metadata.senderDeviceId !== requesterDeviceId &&
      !metadata.recipients.includes(requesterDeviceId)
    ) {
      throw new Error('Usuário não é destinatário deste anexo.');
    }
    const total = Math.max(1, Math.ceil(metadata.fileSize / GROUP_FILE_CHUNK_SIZE_BYTES));
    const normalizedStartIndex = Math.max(0, Math.min(Math.trunc(startIndex || 0), total));
    for (let index = normalizedStartIndex; index < total; index += 1) {
      const buffer = await this.chunks.readAsync(
        index,
        metadata.groupId,
        metadata.fileId,
        'chunks'
      );
      yield { fileId, index, total, dataBase64: buffer.toString('base64') };
    }
  }

  getAttachmentStats(): {
    retainedCount: number;
    retainedBytes: number;
    activeUploads: number;
    pendingRecipients: number;
  } {
    let retainedCount = 0;
    let retainedBytes = 0;
    let pendingRecipients = 0;
    for (const metadata of this.attachmentsByFileId.values()) {
      if (metadata.deletedAt || !metadata.uploadedAt || metadata.expiresAt <= Date.now()) continue;
      retainedCount += 1;
      retainedBytes += Math.max(0, metadata.fileSize || 0);
      pendingRecipients += metadata.recipients.filter(
        (deviceId) => !metadata.receivedByDeviceId[deviceId]
      ).length;
    }
    return {
      retainedCount,
      retainedBytes,
      activeUploads: this.uploadsByFileId.size,
      pendingRecipients
    };
  }

  markAttachmentReceived(fileId: string, deviceId: string): RelayGroupAttachmentMetadata | null {
    const metadata = this.attachmentsByFileId.get(fileId);
    if (!metadata || metadata.deletedAt) return null;
    const cleanDeviceId = deviceId.trim();
    if (!cleanDeviceId) return metadata;
    metadata.receivedByDeviceId[cleanDeviceId] = Date.now();
    this.attachmentsByFileId.set(fileId, metadata);
    this.writeAttachmentMetadata(metadata);
    this.schedulePersist();
    return metadata;
  }

  appendAttachmentAvailable(groupId: string, actorDeviceId: string, fileId: string): RelayGroupEvent {
    const group = this.getRequiredGroup(groupId);
    this.assertActiveMember(group, actorDeviceId);
    const metadata = this.attachmentsByFileId.get(fileId);
    if (!metadata || metadata.deletedAt || !metadata.uploadedAt) {
      throw new Error('Anexo de grupo indisponível.');
    }
    const existing = (this.eventsByGroupId.get(groupId) || []).find((event) => {
      if (event.type !== 'group.attachment.available' || !event.payload || typeof event.payload !== 'object') {
        return false;
      }
      const payload = event.payload as { metadata?: { fileId?: unknown } };
      return payload.metadata?.fileId === fileId;
    });
    if (existing) return existing;
    return this.appendEvent(group, 'group.attachment.available', actorDeviceId, {
      metadata
    }, metadata.uploadedAt);
  }

  sweepAttachments(retentionCutoff: number | null = null): { expired: number; completed: number; staleUploads: number } {
    const now = Date.now();
    let expired = 0;
    let completed = 0;
    let staleUploads = 0;
    for (const [fileId, upload] of Array.from(this.uploadsByFileId.entries())) {
      if (now - upload.startedAt <= GROUP_UPLOAD_STALE_MS) continue;
      this.cleanupAttachment(upload.metadata, true);
      this.uploadsByFileId.delete(fileId);
      staleUploads += 1;
    }
    for (const metadata of Array.from(this.attachmentsByFileId.values())) {
      if (metadata.deletedAt) continue;
      if (retentionCutoff !== null && metadata.createdAt < retentionCutoff) {
        this.cleanupAttachment(metadata, false);
        expired += 1;
      }
    }
    let contentRemoved = 0;
    if (retentionCutoff !== null) {
      for (const [groupId, events] of this.eventsByGroupId.entries()) {
        const retained = events.filter((event) => {
          const isContentEvent =
            event.type.startsWith('group.message.') ||
            event.type.startsWith('group.attachment.');
          if (isContentEvent && event.createdAt < retentionCutoff) {
            contentRemoved += 1;
            return false;
          }
          return true;
        });
        if (retained.length !== events.length) this.eventsByGroupId.set(groupId, retained);
      }
    }
    if (expired || completed || staleUploads || contentRemoved) {
      this.schedulePersist();
    }
    return { expired, completed, staleUploads };
  }

  private getRequiredGroup(groupId: string): RelayGroup {
    const group = this.groupsById.get((groupId || '').trim());
    if (!group || group.deletedAt) {
      throw new Error('Grupo não encontrado.');
    }
    return group;
  }

  private attachmentDirectory(groupId: string, fileId: string): string {
    return path.join(this.attachmentsDir, groupId, fileId);
  }

  private writeAttachmentMetadata(metadata: RelayGroupAttachmentMetadata): void {
    const dir = this.attachmentDirectory(metadata.groupId, metadata.fileId);
    fs.mkdirSync(dir, { recursive: true });
    const serialized = JSON.stringify(metadata);
    fs.writeFileSync(
      path.join(dir, 'metadata.json'),
      this.encrypted ? this.encrypted.encrypt(serialized) : serialized
    );
  }

  private cleanupAttachment(metadata: RelayGroupAttachmentMetadata, removeUpload: boolean): void {
    metadata.deletedAt = Date.now();
    this.attachmentsByFileId.set(metadata.fileId, metadata);
    const dir = this.attachmentDirectory(metadata.groupId, metadata.fileId);
    if (removeUpload) {
      this.uploadsByFileId.delete(metadata.fileId);
    }
    fs.rm(dir, { recursive: true, force: true }, () => undefined);
  }
}
