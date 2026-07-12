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
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AuthSession {
  token: string;
  expiresAt: number;
  user: CentralUser;
}

export interface CanonicalFrame {
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

