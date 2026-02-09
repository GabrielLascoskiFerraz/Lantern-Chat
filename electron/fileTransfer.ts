import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { FILE_CHUNK_SIZE_BYTES, MAX_FILE_SIZE_BYTES, sanitizeFileName } from './config';
import { FileChunkPayload, FileOfferPayload, Profile, ProtocolFrame } from './types';

interface IncomingTransfer {
  fileId: string;
  messageId: string;
  peerId: string;
  totalBytes: number;
  expectedSha: string;
  totalChunks: number | null;
  receivedChunks: number;
  transferredBytes: number;
  hash: ReturnType<typeof createHash>;
  writeStream: fs.WriteStream;
  finalPath: string;
}

export class FileTransferService {
  private attachmentsDir: string;
  private readonly profile: Profile;
  private readonly incoming = new Map<string, IncomingTransfer>();

  constructor(attachmentsDir: string, profile: Profile) {
    this.attachmentsDir = path.resolve(attachmentsDir);
    this.profile = profile;
    fs.mkdirSync(this.attachmentsDir, { recursive: true });
  }

  getAttachmentsDir(): string {
    return this.attachmentsDir;
  }

  setAttachmentsDir(nextDir: string): string {
    const resolved = path.resolve(nextDir);
    fs.mkdirSync(resolved, { recursive: true });
    this.attachmentsDir = resolved;
    return this.attachmentsDir;
  }

  async createOffer(
    _peerId: string,
    filePath: string,
    messageId: string,
    preferredFileId?: string,
    preferredFileName?: string
  ): Promise<{ offer: FileOfferPayload; chunks: FileChunkPayload[] }> {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      throw new Error('Caminho inválido: não é arquivo');
    }
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      throw new Error('Arquivo excede o limite de 200MB');
    }

    const fileBuffer = await fs.promises.readFile(filePath);
    const hash = createHash('sha256').update(fileBuffer).digest('hex');
    const fileId = preferredFileId || randomUUID();
    const filename = preferredFileName || path.basename(filePath);

    const total = Math.ceil(fileBuffer.length / FILE_CHUNK_SIZE_BYTES);
    const chunks: FileChunkPayload[] = [];

    for (let i = 0; i < total; i += 1) {
      const start = i * FILE_CHUNK_SIZE_BYTES;
      const end = Math.min(start + FILE_CHUNK_SIZE_BYTES, fileBuffer.length);
      chunks.push({
        fileId,
        index: i,
        total,
        dataBase64: fileBuffer.subarray(start, end).toString('base64')
      });
    }

    return {
      offer: {
        fileId,
        messageId,
        filename,
        size: stat.size,
        sha256: hash
      },
      chunks
    };
  }

  startIncoming(fileOffer: FileOfferPayload, peerId: string): string {
    const safeName = sanitizeFileName(fileOffer.filename);
    const finalPath = path.join(this.attachmentsDir, `${fileOffer.messageId}_${safeName}`);
    const writeStream = fs.createWriteStream(finalPath, { flags: 'w' });

    this.incoming.set(fileOffer.fileId, {
      fileId: fileOffer.fileId,
      messageId: fileOffer.messageId,
      peerId,
      totalBytes: fileOffer.size,
      expectedSha: fileOffer.sha256,
      totalChunks: null,
      receivedChunks: 0,
      transferredBytes: 0,
      hash: createHash('sha256'),
      writeStream,
      finalPath
    });

    return finalPath;
  }

  onChunk(chunk: FileChunkPayload): { done: boolean; transferred: number; total: number } {
    const transfer = this.incoming.get(chunk.fileId);
    if (!transfer) {
      throw new Error('Transferência desconhecida');
    }

    transfer.totalChunks = chunk.total;
    const buffer = Buffer.from(chunk.dataBase64, 'base64');
    transfer.hash.update(buffer);
    transfer.writeStream.write(buffer);
    transfer.receivedChunks += 1;
    transfer.transferredBytes += buffer.length;

    return {
      done: transfer.totalChunks === transfer.receivedChunks,
      transferred: transfer.transferredBytes,
      total: transfer.totalBytes
    };
  }

  finalize(fileId: string): { ok: boolean; finalPath: string; messageId: string; peerId: string } {
    const transfer = this.incoming.get(fileId);
    if (!transfer) {
      throw new Error('Transferência não encontrada');
    }

    transfer.writeStream.end();
    const digest = transfer.hash.digest('hex');
    const ok =
      digest === transfer.expectedSha &&
      transfer.transferredBytes === transfer.totalBytes &&
      transfer.totalChunks === transfer.receivedChunks;

    if (!ok) {
      try {
        fs.unlinkSync(transfer.finalPath);
      } catch {
        // ignora
      }
    }

    this.incoming.delete(fileId);

    return {
      ok,
      finalPath: transfer.finalPath,
      messageId: transfer.messageId,
      peerId: transfer.peerId
    };
  }

  buildOfferFrame(
    to: string,
    offer: FileOfferPayload,
    createdAt: number = Date.now()
  ): ProtocolFrame<FileOfferPayload> {
    return {
      type: 'file:offer',
      messageId: offer.messageId,
      from: this.profile.deviceId,
      to,
      createdAt,
      payload: offer
    };
  }

  buildChunkFrame(to: string, chunk: FileChunkPayload): ProtocolFrame<FileChunkPayload> {
    return {
      type: 'file:chunk',
      messageId: randomUUID(),
      from: this.profile.deviceId,
      to,
      createdAt: Date.now(),
      payload: chunk
    };
  }

  buildCompleteFrame(to: string, fileId: string): ProtocolFrame<{ fileId: string }> {
    return {
      type: 'file:complete',
      messageId: randomUUID(),
      from: this.profile.deviceId,
      to,
      createdAt: Date.now(),
      payload: { fileId }
    };
  }
}
