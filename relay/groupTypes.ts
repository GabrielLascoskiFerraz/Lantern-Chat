export type GroupRole = 'owner' | 'admin' | 'member';
export type GroupMemberStatus = 'active' | 'left' | 'removed';
export type GroupReactionValue = '👍' | '👎' | '❤️' | '😢' | '😊' | '😂';

export interface RelayGroupSettings {
  allowMembersToPin: boolean;
  allowMembersToEditInfo: boolean;
}

export interface RelayGroupMember {
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

export interface RelayGroup {
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
  settings: RelayGroupSettings;
  members: Record<string, RelayGroupMember>;
  pinnedMessageIds: string[];
}

export type RelayGroupEventType =
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

export interface RelayGroupEvent {
  eventId: string;
  groupId: string;
  seq: number;
  type: RelayGroupEventType;
  actorDeviceId: string;
  createdAt: number;
  payload: unknown;
}

export interface RelayGroupSnapshot {
  group: RelayGroup;
  members: RelayGroupMember[];
  pinnedMessageIds: string[];
  events: RelayGroupEvent[];
}

export interface RelayGroupAttachmentMetadata {
  groupId: string;
  messageId: string;
  fileId: string;
  senderDeviceId: string;
  fileName: string;
  fileSize: number;
  sha256: string;
  createdAt: number;
  expiresAt: number;
  recipients: string[];
  receivedByDeviceId: Record<string, number>;
  replyTo?: unknown;
  forwardedFromMessageId?: string | null;
  uploadedAt: number | null;
  deletedAt: number | null;
}

export interface RelayGroupFileChunk {
  fileId: string;
  index: number;
  total: number;
  dataBase64: string;
}

export interface RelayGroupFileOffer {
  groupId: string;
  messageId: string;
  fileId: string;
  filename: string;
  size: number;
  sha256: string;
  replyTo?: unknown;
  forwardedFromMessageId?: string | null;
}
