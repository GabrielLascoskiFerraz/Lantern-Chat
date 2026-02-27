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
  FileChunkPayload,
  FileOfferPayload,
  Peer,
  Profile,
  ProtocolFrame
} from '../types';

interface MessageServiceDeps {
  db: DbService;
  profile: Profile;
  sendToPeer: (peer: Peer, frame: ProtocolFrame) => Promise<void>;
  sendBroadcast: (frame: ProtocolFrame) => Promise<string[]>;
  fileTransfer: FileTransferService;
  getPeer: (peerId: string) => Peer | undefined;
  getOnlinePeers: () => Peer[];
  onPeerUnreachable: (peerId: string) => void;
  emitEvent: (event: AppEvent) => void;
}

export class MessageService {
  private readonly db: DbService;
  private readonly profile: Profile;
  private readonly sendToPeer: (peer: Peer, frame: ProtocolFrame) => Promise<void>;
  private readonly sendBroadcast: (frame: ProtocolFrame) => Promise<string[]>;
  private readonly fileTransfer: FileTransferService;
  private readonly getPeer: (peerId: string) => Peer | undefined;
  private readonly getOnlinePeers: () => Peer[];
  private readonly onPeerUnreachable: (peerId: string) => void;
  private readonly emitEvent: (event: AppEvent) => void;

  constructor(deps: MessageServiceDeps) {
    this.db = deps.db;
    this.profile = deps.profile;
    this.sendToPeer = deps.sendToPeer;
    this.sendBroadcast = deps.sendBroadcast;
    this.fileTransfer = deps.fileTransfer;
    this.getPeer = deps.getPeer;
    this.getOnlinePeers = deps.getOnlinePeers;
    this.onPeerUnreachable = deps.onPeerUnreachable;
    this.emitEvent = deps.emitEvent;
  }

  private markUnreachable(peer: Peer): void {
    this.onPeerUnreachable(peer.deviceId);
  }

  private async sendFileFramesInBackground(
    peer: Peer,
    message: DbMessage,
    offer: FileOfferPayload,
    chunks: FileChunkPayload[]
  ): Promise<void> {
    try {
      await this.sendToPeer(peer, this.fileTransfer.buildOfferFrame(peer.deviceId, offer, message.createdAt));

      let transferred = 0;
      for (const chunk of chunks) {
        transferred += Buffer.byteLength(chunk.dataBase64, 'base64');
        await this.sendToPeer(peer, this.fileTransfer.buildChunkFrame(peer.deviceId, chunk));
        this.emitEvent({
          type: 'transfer:progress',
          direction: 'send',
          fileId: offer.fileId,
          messageId: message.messageId,
          peerId: peer.deviceId,
          transferred,
          total: offer.size
        });
      }

      await this.sendToPeer(peer, this.fileTransfer.buildCompleteFrame(peer.deviceId, offer.fileId));
      this.emitEvent({
        type: 'transfer:progress',
        direction: 'send',
        fileId: offer.fileId,
        messageId: message.messageId,
        peerId: peer.deviceId,
        transferred: offer.size,
        total: offer.size
      });
    } catch {
      this.markUnreachable(peer);
      this.db.updateMessageStatus(message.messageId, 'failed');
      this.emitEvent({
        type: 'message:status',
        messageId: message.messageId,
        conversationId: message.conversationId,
        status: 'failed'
      });
      this.emitEvent({
        type: 'ui:toast',
        level: 'warning',
        message: 'Falha no envio do anexo. Contato offline.'
      });
    }
  }

  async sendText(peerId: string, text: string): Promise<DbMessage> {
    const peer = this.getPeer(peerId);
    const conversationId = this.db.ensureDmConversation(
      peerId,
      peer?.displayName || `Contato ${peerId.slice(0, 6)}`
    );
    const createdAt = this.db.reserveConversationTimestamp(conversationId, Date.now());
    const frame: ProtocolFrame<ChatTextPayload> = {
      type: 'chat:text',
      messageId: randomUUID(),
      from: this.profile.deviceId,
      to: peerId,
      createdAt,
      payload: { text }
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
      createdAt
    };

    if (!peer) {
      throw new Error('Contato offline. Não foi possível enviar a mensagem.');
    }

    try {
      await this.sendToPeer(peer, frame);
    } catch {
      this.markUnreachable(peer);
      throw new Error('Contato offline. Não foi possível enviar a mensagem.');
    }

    this.db.saveMessage(message);
    return message;
  }

  async sendAnnouncement(text: string): Promise<DbMessage> {
    const createdAt = this.db.reserveConversationTimestamp(
      ANNOUNCEMENTS_CONVERSATION_ID,
      Date.now()
    );
    const frame: ProtocolFrame<AnnouncementPayload> = {
      type: 'announce',
      messageId: randomUUID(),
      from: this.profile.deviceId,
      to: null,
      createdAt,
      payload: { text }
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
      createdAt
    };

    try {
      await this.sendBroadcast(frame);
    } catch {
      throw new Error('Não foi possível publicar o anúncio no Relay.');
    }

    this.db.saveMessage(message);

    return message;
  }

  async sendFile(peerId: string, filePath: string): Promise<DbMessage> {
    const peer = this.getPeer(peerId);
    if (!peer) {
      throw new Error('Contato offline. Não foi possível enviar o anexo.');
    }

    const messageId = randomUUID();
    const conversationId = this.db.ensureDmConversation(
      peerId,
      peer?.displayName || `Contato ${peerId.slice(0, 6)}`
    );
    const createdAt = this.db.reserveConversationTimestamp(conversationId, Date.now());
    const managedFilePath = await this.ensureManagedOutgoingFileCopy(filePath, messageId);
    const { offer, chunks } = await this.fileTransfer.createOffer(peerId, managedFilePath, messageId);
    this.deleteClipboardTempFile(filePath);

    if (offer.size > MAX_FILE_SIZE_BYTES) {
      throw new Error('Arquivo acima do limite de 200MB');
    }

    const message: DbMessage = {
      messageId,
      conversationId,
      direction: 'out',
      senderDeviceId: this.profile.deviceId,
      receiverDeviceId: peerId,
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
      createdAt
    };

    this.db.saveMessage(message);
    this.emitEvent({
      type: 'transfer:progress',
      direction: 'send',
      fileId: offer.fileId,
      messageId,
      peerId,
      transferred: 0,
      total: offer.size
    });

    setImmediate(() => {
      void this.sendFileFramesInBackground(peer, message, offer, chunks);
    });

    return message;
  }

  async retryFailedMessagesForPeer(peer: Peer): Promise<void> {
    void peer;
  }

  private isClipboardTempFile(filePath: string): boolean {
    if (!filePath) return false;
    const tempDir = path.join(os.tmpdir(), 'lantern-paste');
    const resolvedFile = path.resolve(filePath);
    const resolvedTemp = path.resolve(tempDir) + path.sep;
    return resolvedFile.startsWith(resolvedTemp);
  }

  private deleteClipboardTempFile(filePath: string): void {
    if (!this.isClipboardTempFile(filePath)) return;
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

  async replayPendingFilesForPeer(peer: Peer): Promise<void> {
    const pendingFiles = this.db.getOutgoingFileMessagesForPeer(peer.deviceId, 20);
    for (const fileMessage of pendingFiles) {
      if (!fileMessage.filePath || !fileMessage.fileId) continue;
      if (!fs.existsSync(fileMessage.filePath)) continue;
      try {
        const { offer, chunks } = await this.fileTransfer.createOffer(
          peer.deviceId,
          fileMessage.filePath,
          fileMessage.messageId,
          fileMessage.fileId,
          fileMessage.fileName || undefined
        );

        await this.sendToPeer(
          peer,
          this.fileTransfer.buildOfferFrame(peer.deviceId, offer, fileMessage.createdAt)
        );
        let transferred = 0;
        for (const chunk of chunks) {
          transferred += Buffer.byteLength(chunk.dataBase64, 'base64');
          await this.sendToPeer(peer, this.fileTransfer.buildChunkFrame(peer.deviceId, chunk));
          this.emitEvent({
            type: 'transfer:progress',
            direction: 'send',
            fileId: offer.fileId,
            messageId: fileMessage.messageId,
            peerId: peer.deviceId,
            transferred,
            total: offer.size
          });
        }
        await this.sendToPeer(
          peer,
          this.fileTransfer.buildCompleteFrame(peer.deviceId, offer.fileId)
        );
      } catch {
        this.markUnreachable(peer);
        this.db.updateMessageStatus(fileMessage.messageId, 'failed');
        this.emitEvent({
          type: 'message:status',
          messageId: fileMessage.messageId,
          conversationId: fileMessage.conversationId,
          status: 'failed'
        });
      }
    }
  }

  async resumeFileFromIndex(peer: Peer, fileMessage: DbMessage, nextIndex: number): Promise<void> {
    if (!fileMessage.filePath || !fileMessage.fileId || !fs.existsSync(fileMessage.filePath)) {
      return;
    }

    const { offer, chunks } = await this.fileTransfer.createOffer(
      peer.deviceId,
      fileMessage.filePath,
      fileMessage.messageId,
      fileMessage.fileId,
      fileMessage.fileName || undefined
    );

    const startIndex = Math.max(0, Math.min(nextIndex, chunks.length));
    let transferred = 0;
    for (let i = startIndex; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      transferred += Buffer.byteLength(chunk.dataBase64, 'base64');
      await this.sendToPeer(peer, this.fileTransfer.buildChunkFrame(peer.deviceId, chunk));
      this.emitEvent({
        type: 'transfer:progress',
        direction: 'send',
        fileId: offer.fileId,
        messageId: fileMessage.messageId,
        peerId: peer.deviceId,
        transferred,
        total: offer.size
      });
    }

    await this.sendToPeer(peer, this.fileTransfer.buildCompleteFrame(peer.deviceId, offer.fileId));
  }
}
