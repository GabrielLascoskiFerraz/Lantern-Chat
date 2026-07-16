export type SupportedLocale = 'pt-BR' | 'en' | 'es';
export type RetentionPolicy = 'forever' | '1_month' | '6_months' | '1_year';

export interface CentralUser {
  userId: string;
  username: string;
  displayName: string;
  department: string;
  avatarEmoji: string;
  avatarBg: string;
  statusMessage: string;
  locale: SupportedLocale;
  role: 'admin' | 'user';
  profileSetupCompleted: boolean;
  passwordSetupRequired: boolean;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface UserConversationPreference {
  conversationId: string;
  pinned: boolean;
  archived: boolean;
  manualUnread: boolean;
  readAt: number;
  updatedAt: number;
}

export interface UserMessagePreference {
  messageId: string;
  favorite: boolean;
  hidden: boolean;
  updatedAt: number;
}

export interface UserPreferencesSnapshot {
  conversations: UserConversationPreference[];
  messages: UserMessagePreference[];
}

export interface PasswordResetRequest {
  requestId: string;
  userId: string;
  username: string;
  displayName: string;
  status: 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired';
  requestedAt: number;
  reviewedAt: number | null;
  expiresAt: number | null;
  consumedAt: number | null;
}

export interface CanonicalExportMessage {
  messageId: string;
  senderUserId: string;
  type: 'text' | 'file';
  text: string;
  fileName: string;
  fileSize: number;
  createdAt: number;
  editedAt: number;
}

export interface AuthSession {
  token: string;
  expiresAt: number;
  user: CentralUser;
}

export interface CanonicalFrame {
  serverSeq?: number;
  messageId: string;
  type: string;
  senderUserId: string;
  targetUserId: string | null;
  conversationId: string;
  createdAt: number;
  payload: unknown;
}

export interface AttachmentRecord {
  attachmentId: string;
  messageId: string;
  ownerUserId: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  encryptedPath: string;
  createdAt: number;
}

export type ConversationMediaKind = 'media' | 'document';

export interface ConversationMediaCursor {
  createdAt: number;
  messageId: string;
}

export interface ConversationMediaItem {
  messageId: string;
  fileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  senderUserId: string;
  createdAt: number;
  kind: ConversationMediaKind;
}

export interface ConversationMediaPage {
  items: ConversationMediaItem[];
  nextCursor: ConversationMediaCursor | null;
  hasMore: boolean;
}
