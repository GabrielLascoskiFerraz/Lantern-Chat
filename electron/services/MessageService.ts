import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ANNOUNCEMENTS_CONVERSATION_ID,
  MAX_FILE_SIZE_BYTES,
  sanitizeFileName
} from '../config';
import { DbService } from '../db';
import { FileTransferService } from '../fileTransfer';
import {
  AnnouncementPayload,
  AppEvent,
  ChatTextPayload,
  DbMessage,
  FileOfferPayload,
  MessageReplyPayload,
  Peer,
  Profile,
  ProtocolFrame
} from '../types';

interface MessageServiceDeps {
  db: DbService;
  profile: Profile;
  fileTransfer: FileTransferService;
  getPeer: (peerId: string) => Peer | undefined;
  emitEvent: (event: AppEvent) => void;
  sendCanonicalFrame: (frame: ProtocolFrame) => Promise<void>;
  uploadCanonicalAttachment: (input: {
    message: DbMessage;
    offer: FileOfferPayload;
    filePath: string;
    onProgress: (transferred: number) => void;
  }) => Promise<void>;
}

export class MessageService {
  private readonly db: DbService;
  private readonly profile: Profile;
  private readonly fileTransfer: FileTransferService;
  private readonly getPeer: (peerId: string) => Peer | undefined;
  private readonly emitEvent: (event: AppEvent) => void;
  private readonly sendCanonicalFrame: (frame: ProtocolFrame) => Promise<void>;
  private readonly uploadCanonicalAttachment: MessageServiceDeps['uploadCanonicalAttachment'];

  constructor(deps: MessageServiceDeps) {
    this.db = deps.db;
    this.profile = deps.profile;
    this.fileTransfer = deps.fileTransfer;
    this.getPeer = deps.getPeer;
    this.emitEvent = deps.emitEvent;
    this.sendCanonicalFrame = deps.sendCanonicalFrame;
    this.uploadCanonicalAttachment = deps.uploadCanonicalAttachment;
  }

  private sanitizeReplyPayload(
    input: MessageReplyPayload | null | undefined
  ): MessageReplyPayload | null {
    if (!input) return null;
    const messageId = (input.messageId || '').trim();
    const senderDeviceId = (input.senderDeviceId || '').trim();
    const type = input.type;
    if (!messageId || !senderDeviceId) return null;
    if (type !== 'text' && type !== 'announcement' && type !== 'file') {
      return null;
    }
    const previewText = (input.previewText || '').trim();
    const fileName = (input.fileName || '').trim();
    return {
      messageId,
      senderDeviceId,
      type,
      previewText: previewText.length > 0 ? previewText.slice(0, 300) : null,
      fileName: fileName.length > 0 ? fileName.slice(0, 260) : null
    };
  }

  async sendText(
    peerId: string,
    text: string,
    replyTo?: MessageReplyPayload | null,
    options?: { forwardedFromMessageId?: string | null }
  ): Promise<DbMessage> {
    const peer = this.getPeer(peerId);
    const conversationId = this.db.ensureDmConversation(
      peerId,
      peer?.displayName || `Contato ${peerId.slice(0, 6)}`
    );
    const createdAt = this.db.reserveConversationTimestamp(conversationId, Date.now());
    const sanitizedReply = this.sanitizeReplyPayload(replyTo);
    const frame: ProtocolFrame<ChatTextPayload> = {
      type: 'chat:text',
      messageId: randomUUID(),
      from: this.profile.deviceId,
      to: peerId,
      createdAt,
      payload: {
        text,
        replyTo: sanitizedReply,
        forwardedFromMessageId: options?.forwardedFromMessageId || null
      }
    };

    const message: DbMessage = {
      messageId: frame.messageId,
      conversationId,
      direction: 'out',
      senderDeviceId: this.profile.deviceId,
      receiverDeviceId: peerId,
      type: 'text',
      bodyText: text,
      fileId: null,
      fileName: null,
      fileSize: null,
      fileSha256: null,
      filePath: null,
      status: 'sent',
      reaction: null,
      deletedAt: null,
      replyToMessageId: sanitizedReply?.messageId || null,
      replyToSenderDeviceId: sanitizedReply?.senderDeviceId || null,
      replyToType: sanitizedReply?.type || null,
      replyToPreviewText: sanitizedReply?.previewText || null,
      replyToFileName: sanitizedReply?.fileName || null,
      forwardedFromMessageId: options?.forwardedFromMessageId || null,
      editedAt: null,
      createdAt
    };

    await this.sendCanonicalFrame(frame);
    this.db.saveMessage(message);

    return message;
  }

  async sendAnnouncement(
    text: string,
    replyTo?: MessageReplyPayload | null
  ): Promise<DbMessage> {
    const createdAt = this.db.reserveConversationTimestamp(
      ANNOUNCEMENTS_CONVERSATION_ID,
      Date.now()
    );
    const sanitizedReply = this.sanitizeReplyPayload(replyTo);
    const frame: ProtocolFrame<AnnouncementPayload> = {
      type: 'announce',
      messageId: randomUUID(),
      from: this.profile.deviceId,
      to: null,
      createdAt,
      payload: {
        text,
        replyTo: sanitizedReply
      }
    };

    const message: DbMessage = {
      messageId: frame.messageId,
      conversationId: ANNOUNCEMENTS_CONVERSATION_ID,
      direction: 'out',
      senderDeviceId: this.profile.deviceId,
      receiverDeviceId: null,
      type: 'announcement',
      bodyText: text,
      fileId: null,
      fileName: null,
      fileSize: null,
      fileSha256: null,
      filePath: null,
      status: 'sent',
      reaction: null,
      deletedAt: null,
      replyToMessageId: sanitizedReply?.messageId || null,
      replyToSenderDeviceId: sanitizedReply?.senderDeviceId || null,
      replyToType: sanitizedReply?.type || null,
      replyToPreviewText: sanitizedReply?.previewText || null,
      replyToFileName: sanitizedReply?.fileName || null,
      forwardedFromMessageId: null,
      editedAt: null,
      createdAt
    };

    try {
      await this.sendCanonicalFrame(frame);
    } catch {
      throw new Error('Não foi possível publicar o anúncio no Relay.');
    }

    this.db.saveMessage(message);

    return message;
  }

  async sendFile(
    peerId: string,
    filePath: string,
    replyTo?: MessageReplyPayload | null,
    options?: { forwardedFromMessageId?: string | null }
  ): Promise<DbMessage> {
    const peer = this.getPeer(peerId);
    return this.sendFileToConversation({
      targetUserId: peerId,
      conversationId: this.db.ensureDmConversation(
        peerId,
        peer?.displayName || `Contato ${peerId.slice(0, 6)}`
      ),
      filePath,
      replyTo,
      forwardedFromMessageId: options?.forwardedFromMessageId || null
    });
  }

  async sendAnnouncementFile(
    filePath: string,
    replyTo?: MessageReplyPayload | null
  ): Promise<DbMessage> {
    return this.sendFileToConversation({
      targetUserId: null,
      conversationId: ANNOUNCEMENTS_CONVERSATION_ID,
      filePath,
      replyTo,
      forwardedFromMessageId: null
    });
  }

  private async sendFileToConversation(input: {
    targetUserId: string | null;
    conversationId: string;
    filePath: string;
    replyTo?: MessageReplyPayload | null;
    forwardedFromMessageId?: string | null;
  }): Promise<DbMessage> {
    const { targetUserId, conversationId, filePath, replyTo } = input;
    const sanitizedReply = this.sanitizeReplyPayload(replyTo);

    const messageId = randomUUID();
    const createdAt = this.db.reserveConversationTimestamp(conversationId, Date.now());
    const managedFilePath = await this.ensureManagedOutgoingFileCopy(filePath, messageId);
    const { offer } = await this.fileTransfer.createOffer(
      targetUserId || ANNOUNCEMENTS_CONVERSATION_ID,
      managedFilePath,
      messageId
    );
    this.deleteEphemeralOutgoingFile(filePath);

    if (offer.size > MAX_FILE_SIZE_BYTES) {
      throw new Error('Arquivo acima do limite de 200MB');
    }

    const message: DbMessage = {
      messageId,
      conversationId,
      direction: 'out',
      senderDeviceId: this.profile.deviceId,
      receiverDeviceId: targetUserId,
      type: 'file',
      bodyText: null,
      fileId: offer.fileId,
      fileName: offer.filename,
      fileSize: offer.size,
      fileSha256: offer.sha256,
      filePath: managedFilePath,
      status: 'sent',
      reaction: null,
      deletedAt: null,
      replyToMessageId: sanitizedReply?.messageId || null,
      replyToSenderDeviceId: sanitizedReply?.senderDeviceId || null,
      replyToType: sanitizedReply?.type || null,
      replyToPreviewText: sanitizedReply?.previewText || null,
      replyToFileName: sanitizedReply?.fileName || null,
      forwardedFromMessageId: input.forwardedFromMessageId || null,
      editedAt: null,
      createdAt
    };

    this.db.saveMessage(message);
    this.emitEvent({
      type: 'transfer:progress',
      direction: 'send',
      fileId: offer.fileId,
      messageId,
      peerId: targetUserId || ANNOUNCEMENTS_CONVERSATION_ID,
      transferred: 0,
      total: offer.size
    });

    setImmediate(() => {
      const offerWithReply = sanitizedReply ? { ...offer, replyTo: sanitizedReply } : offer;
      const offerWithMeta = message.forwardedFromMessageId
        ? { ...offerWithReply, forwardedFromMessageId: message.forwardedFromMessageId }
        : offerWithReply;
      void this.uploadCanonicalAttachment({
        message,
        offer,
        filePath: managedFilePath,
        onProgress: (transferred) => this.emitEvent({
          type: 'transfer:progress', direction: 'send', fileId: offer.fileId,
          messageId,
          peerId: targetUserId || ANNOUNCEMENTS_CONVERSATION_ID,
          transferred,
          total: offer.size
        })
      }).then(() => this.sendCanonicalFrame(
        this.fileTransfer.buildOfferFrame(targetUserId, offerWithMeta, message.createdAt)
      )).then(() => {
        this.db.updateMessageStatus(messageId, 'delivered');
        const updated = this.db.getMessageById(messageId);
        if (updated) this.emitEvent({ type: 'message:updated', message: updated });
      }).catch((error) => {
        this.emitEvent({
          type: 'ui:toast', level: 'warning',
          message: error instanceof Error ? error.message : 'Não foi possível armazenar o anexo no Relay.'
        });
      });
    });

    return message;
  }

  private isEphemeralOutgoingFile(filePath: string): boolean {
    if (!filePath) return false;
    const resolvedFile = path.resolve(filePath);
    const temporaryDirectories = ['lantern-paste', 'lantern-stickers'].map(
      (name) => path.resolve(os.tmpdir(), name) + path.sep
    );
    return temporaryDirectories.some((directory) => resolvedFile.startsWith(directory));
  }

  private deleteEphemeralOutgoingFile(filePath: string): void {
    if (!this.isEphemeralOutgoingFile(filePath)) return;
    fs.promises.unlink(filePath).catch(() => undefined);
  }

  private async ensureManagedOutgoingFileCopy(filePath: string, messageId: string): Promise<string> {
    const resolvedSource = path.resolve(filePath);
    const sourceStat = await fs.promises.stat(resolvedSource);
    if (!sourceStat.isFile()) {
      throw new Error('Caminho inválido: não é arquivo');
    }
    if (sourceStat.size > MAX_FILE_SIZE_BYTES) {
      throw new Error('Arquivo acima do limite de 200MB');
    }
    const attachmentsDir = this.fileTransfer.getAttachmentsDir();
    const resolvedAttachmentsDir = path.resolve(attachmentsDir);
    const normalizedAttachmentsPrefix = resolvedAttachmentsDir + path.sep;

    if (resolvedSource.startsWith(normalizedAttachmentsPrefix)) {
      return resolvedSource;
    }

    await fs.promises.mkdir(resolvedAttachmentsDir, { recursive: true });
    const safeName = sanitizeFileName(path.basename(resolvedSource) || 'arquivo');
    const managedPath = path.join(resolvedAttachmentsDir, `${messageId}_${safeName}`);
    await fs.promises.copyFile(resolvedSource, managedPath);
    return managedPath;
  }

}
