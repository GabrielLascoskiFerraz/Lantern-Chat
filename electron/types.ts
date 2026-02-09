export type MessageType =
  | 'hello'
  | 'chat:text'
  | 'chat:ack'
  | 'chat:react'
  | 'chat:delete'
  | 'chat:clear'
  | 'chat:forget'
  | 'chat:sync:request'
  | 'chat:sync:response'
  | 'announce'
  | 'file:offer'
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
}

export interface AckPayload {
  ackMessageId: string;
  status: 'delivered';
}

export interface ReactPayload {
  targetMessageId: string;
  reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null;
}

export interface DeletePayload {
  targetMessageId: string;
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
  status: 'sent' | 'delivered' | 'failed' | null;
  reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null;
  deletedAt: number | null;
  createdAt: number;
}

export interface SyncResponsePayload {
  messages: SyncMessagePayload[];
}

export interface AnnouncementPayload {
  text: string;
}

export interface FileOfferPayload {
  fileId: string;
  messageId: string;
  filename: string;
  size: number;
  sha256: string;
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
  status: 'sent' | 'delivered' | 'failed' | null;
  reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null;
  deletedAt: number | null;
  createdAt: number;
}

export interface ConversationRow {
  id: string;
  kind: 'dm' | 'announcements';
  peerDeviceId: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  unreadCount: number;
}

export interface AnnouncementReactionSummary {
  counts: Partial<Record<'👍' | '👎' | '❤️' | '😢' | '😊' | '😂', number>>;
  myReaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null;
}

export type AppEvent =
  | { type: 'peers:updated'; peers: Peer[] }
  | { type: 'relay:connection'; connected: boolean; endpoint: string | null }
  | { type: 'sync:status'; active: boolean }
  | { type: 'message:received'; message: DbMessage }
  | { type: 'message:updated'; message: DbMessage }
  | { type: 'message:removed'; conversationId: string; messageId: string }
  | { type: 'conversation:cleared'; conversationId: string }
  | {
      type: 'message:status';
      messageId: string;
      conversationId: string | null;
      status: 'delivered' | 'failed';
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
    }
  | { type: 'navigate'; conversationId: string }
  | { type: 'message:reactions'; messageId: string; summary: AnnouncementReactionSummary }
  | { type: 'announcement:reactions'; messageId: string; summary: AnnouncementReactionSummary };
