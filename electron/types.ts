export type MessageType =
  | 'hello'
  | 'chat:text'
  | 'chat:ack'
  | 'chat:react'
  | 'chat:delete'
  | 'chat:edit'
  | 'chat:clear'
  | 'chat:forget'
  | 'chat:sync:request'
  | 'chat:sync:response'
  | 'group:event'
  | 'announce'
  | 'file:offer'
  | 'file:request'
  | 'file:chunk'
  | 'file:complete'
  | 'typing';

export interface Profile {
  deviceId: string;
  displayName: string;
  avatarEmoji: string;
  avatarBg: string;
  statusMessage: string;
  createdAt: number;
  updatedAt: number;
}

export interface Peer {
  deviceId: string;
  displayName: string;
  avatarEmoji: string;
  avatarBg: string;
  statusMessage: string;
  address: string;
  port: number;
  appVersion: string;
  lastSeenAt: number;
  source: 'relay' | 'mdns' | 'udp' | 'manual' | 'cache';
}

export interface ProtocolFrame<T = unknown> {
  type: MessageType;
  messageId: string;
  from: string;
  to: string | null;
  createdAt: number;
  payload: T;
}

export interface ChatTextPayload {
  text: string;
  replyTo?: MessageReplyPayload | null;
  forwardedFromMessageId?: string | null;
}

export interface AckPayload {
  ackMessageId: string;
  status: 'delivered' | 'read';
}

export interface ReactPayload {
  targetMessageId: string;
  reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null;
}

export interface DeletePayload {
  targetMessageId: string;
}

export interface EditMessagePayload {
  targetMessageId: string;
  text: string;
  editedAt: number;
}

export interface ClearConversationPayload {
  scope: 'dm';
}

export interface ForgetPeerPayload {
  scope: 'dm';
}

export interface TypingPayload {
  isTyping: boolean;
}

export interface SyncRequestPayload {
  since: number;
  limit: number;
  fullResync?: boolean;
}

export interface SyncMessagePayload {
  messageId: string;
  senderDeviceId: string;
  receiverDeviceId: string | null;
  type: 'text' | 'announcement' | 'file';
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
  createdAt: number;
}

export interface SyncResponsePayload {
  messages: SyncMessagePayload[];
}

export interface AnnouncementPayload {
  text: string;
  replyTo?: MessageReplyPayload | null;
  editedAt?: number | null;
}

export interface MessageReplyPayload {
  messageId: string;
  senderDeviceId: string;
  type: 'text' | 'announcement' | 'file';
  previewText: string | null;
  fileName: string | null;
}

export interface FileOfferPayload {
  fileId: string;
  messageId: string;
  filename: string;
  size: number;
  sha256: string;
  replyTo?: MessageReplyPayload | null;
  forwardedFromMessageId?: string | null;
}

/**
 * Pedido idempotente para que o remetente reenvie um anexo que existe no
 * histórico local, mas ainda não está disponível neste dispositivo.
 */
export interface FileRequestPayload {
  targetMessageId: string;
  fileId: string;
}

export interface FileChunkPayload {
  fileId: string;
  index: number;
  total: number;
  dataBase64: string;
}

export interface FileCompletePayload {
  fileId: string;
}

export interface DbMessage {
  messageId: string;
  conversationId: string;
  direction: 'in' | 'out';
  senderDeviceId: string;
  receiverDeviceId: string | null;
  type: 'text' | 'file' | 'announcement';
  bodyText: string | null;
  fileId: string | null;
  fileName: string | null;
  fileSize: number | null;
  fileSha256: string | null;
  filePath: string | null;
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
  createdAt: number;
}

export interface ConversationRow {
  id: string;
  kind: 'dm' | 'announcements' | 'group';
  peerDeviceId: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  unreadCount: number;
  lastReadAt: number;
  archivedAt: number;
}

export type GroupRole = 'owner' | 'admin' | 'member';
export type GroupMemberStatus = 'active' | 'left' | 'removed';

export interface GroupSettings {
  allowMembersToPin: boolean;
  allowMembersToEditInfo: boolean;
}

export interface GroupInfo {
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
  missingOnRelay?: boolean;
  settings: GroupSettings;
}

export interface StickerCatalogItem {
  id: string;
  label: string;
  fileName: string;
  relativePath: string;
  url: string;
  previewDataUrl: string | null;
  size: number;
  category: string;
  updatedAt: number;
}

export interface GroupMember {
  groupId: string;
  deviceId: string;
  role: GroupRole;
  status: GroupMemberStatus;
  displayNameSnapshot: string | null;
  avatarEmojiSnapshot: string | null;
  avatarBgSnapshot: string | null;
  joinedAt: number;
  updatedAt: number;
}

export type GroupEventType =
  | 'group.created'
  | 'group.updated'
  | 'group.deleted'
  | 'group.member.added'
  | 'group.member.removed'
  | 'group.member.left'
  | 'group.member.roleChanged'
  | 'group.message.created'
  | 'group.message.edited'
  | 'group.message.deletedForEveryone'
  | 'group.message.reactionChanged'
  | 'group.message.pinned'
  | 'group.message.unpinned'
  | 'group.attachment.available'
  | 'group.attachment.expired';

export interface GroupEvent {
  eventId: string;
  groupId: string;
  seq: number;
  type: GroupEventType;
  actorDeviceId: string;
  createdAt: number;
  payload: unknown;
}

export interface GroupSnapshot {
  group: GroupInfo;
  members: GroupMember[];
  pinnedMessageIds: string[];
  events: GroupEvent[];
}

export interface CreateGroupInput {
  name: string;
  emoji: string;
  avatarBg: string;
  description: string;
  memberDeviceIds: string[];
}

export interface UpdateGroupInput {
  name?: string;
  emoji?: string;
  avatarBg?: string;
  description?: string;
  settings?: Partial<GroupSettings>;
}

export interface GroupMessagePayload {
  groupId: string;
  text: string;
  replyTo?: MessageReplyPayload | null;
  forwardedFromMessageId?: string | null;
}

export interface GroupFileOfferPayload extends FileOfferPayload {
  groupId: string;
  replyTo?: MessageReplyPayload | null;
  forwardedFromMessageId?: string | null;
}

export interface GroupAttachmentDownload {
  fileId: string;
  groupId: string;
  messageId: string;
  status: 'pending' | 'reconnecting' | 'downloading' | 'retrying' | 'complete' | 'expired' | 'failed';
  localPath: string | null;
  tempPath?: string | null;
  totalBytes?: number;
  receivedBytes?: number;
  nextChunkIndex?: number;
  totalChunks?: number;
  retryCount?: number;
  lastError?: string | null;
  lastAttemptAt?: number | null;
  requestId?: string | null;
  receivedAt: number | null;
  updatedAt: number;
}

export interface AnnouncementReactionSummary {
  counts: Partial<Record<'👍' | '👎' | '❤️' | '😢' | '😊' | '😂', number>>;
  myReaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null;
}

export interface MessageReactionDetail {
  deviceId: string;
  displayName: string;
  avatarEmoji: string;
  avatarBg: string;
  reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂';
  updatedAt: number;
}

export interface AnnouncementReadSummary {
  count: number;
  readByMe: boolean;
}

export interface AnnouncementReadDetail {
  deviceId: string;
  displayName: string;
  avatarEmoji: string;
  avatarBg: string;
  readAt: number;
}

export type AppEvent =
  | { type: 'peers:updated'; peers: Peer[] }
  | { type: 'groups:updated'; groups: GroupInfo[] }
  | { type: 'group:members'; groupId: string; members: GroupMember[] }
  | { type: 'group:pins'; groupId: string; messageIds: string[] }
  | { type: 'relay:connection'; connected: boolean; endpoint: string | null }
  | { type: 'sync:status'; active: boolean }
  | { type: 'message:received'; message: DbMessage }
  | { type: 'message:updated'; message: DbMessage }
  | { type: 'message:removed'; conversationId: string; messageId: string }
  | { type: 'message:favorite'; conversationId: string; messageId: string; favorite: boolean }
  | { type: 'conversation:cleared'; conversationId: string }
  | { type: 'conversation:unread'; conversationId: string; unreadCount: number }
  | {
      type: 'message:status';
      messageId: string;
      conversationId: string | null;
      status: 'delivered' | 'read' | 'failed';
    }
  | { type: 'typing:update'; conversationId: string; peerId: string; isTyping: boolean }
  | { type: 'ui:toast'; level: 'info' | 'success' | 'warning' | 'error'; message: string }
  | {
      type: 'transfer:progress';
      direction: 'send' | 'receive';
      fileId: string;
      messageId: string;
      peerId: string;
      transferred: number;
      total: number;
      stage?: 'pending' | 'reconnecting' | 'uploading' | 'downloading' | 'retrying' | 'complete' | 'failed';
      attempt?: number;
      detail?: string | null;
    }
  | { type: 'navigate'; conversationId: string }
  | { type: 'message:reactions'; messageId: string; summary: AnnouncementReactionSummary }
  | { type: 'announcement:reactions'; messageId: string; summary: AnnouncementReactionSummary }
  | { type: 'announcement:reads'; messageId: string; summary: AnnouncementReadSummary };
