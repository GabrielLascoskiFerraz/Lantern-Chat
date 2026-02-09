import { DbService } from '../db';
import { DbMessage, Peer, Profile, SyncMessagePayload } from '../types';

export class SyncService {
  constructor(private readonly db: DbService, private readonly profile: Profile) {}

  buildSyncMessages(peerId: string, limit: number, since?: number): SyncMessagePayload[] {
    return this.db
      .getSyncMessagesForPeer(peerId, limit, since)
      .filter((row) => row.type !== 'announcement')
      .map((row) => ({
        messageId: row.messageId,
        senderDeviceId: row.senderDeviceId,
        receiverDeviceId: row.receiverDeviceId,
        type: row.type,
        bodyText: row.bodyText,
        fileId: row.fileId,
        fileName: row.fileName,
        fileSize: row.fileSize,
        fileSha256: row.fileSha256,
        status: row.status,
        reaction: row.reaction,
        deletedAt: row.deletedAt,
        createdAt: row.createdAt
      }));
  }

  applySyncedMessage(
    message: SyncMessagePayload,
    peersById: Map<string, Peer>
  ): { inserted: boolean; row?: DbMessage } {
    // Anúncios são sincronizados exclusivamente pelo Relay (snapshot + expiry),
    // nunca por sync P2P entre clientes.
    if (message.type === 'announcement') {
      return { inserted: false };
    }

    const counterpartId =
      message.senderDeviceId === this.profile.deviceId
        ? message.receiverDeviceId
        : message.senderDeviceId;
    if (!counterpartId) {
      return { inserted: false };
    }
    const counterpartName = peersById.get(counterpartId)?.displayName || counterpartId;
    const conversationId = this.db.ensureDmConversation(counterpartId, counterpartName);

    const direction: 'in' | 'out' =
      message.senderDeviceId === this.profile.deviceId ? 'out' : 'in';
    const now = Date.now();
    const parsedCreatedAt =
      Number.isFinite(message.createdAt) && message.createdAt > 0
        ? Math.trunc(message.createdAt)
        : now;
    const normalizedCreatedAt =
      direction === 'in' && parsedCreatedAt > now ? now : parsedCreatedAt;

    const row: DbMessage = {
      messageId: message.messageId,
      conversationId,
      direction,
      senderDeviceId: message.senderDeviceId,
      receiverDeviceId: message.receiverDeviceId || this.profile.deviceId,
      type: message.type,
      bodyText: message.bodyText,
      fileId: message.fileId,
      fileName: message.fileName,
      fileSize: message.fileSize,
      fileSha256: message.fileSha256,
      filePath: null,
      status: message.status,
      reaction: message.reaction,
      deletedAt: message.deletedAt,
      createdAt: normalizedCreatedAt
    };

    const inserted = this.db.saveMessage(row);
    if (!inserted) {
      const merged = this.db.mergeMessageStateFromSync({
        messageId: message.messageId,
        bodyText: message.bodyText,
        fileId: message.fileId,
        fileName: message.fileName,
        fileSize: message.fileSize,
        fileSha256: message.fileSha256,
        status: message.status,
        reaction: message.reaction,
        deletedAt: message.deletedAt
      });
      return { inserted: false, row: merged };
    }

    return { inserted: true, row };
  }
}
