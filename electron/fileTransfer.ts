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
  receivedIndices: Set<number>;
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

  private getChunkCount(totalBytes: number): number {
    return Math.max(1, Math.ceil(totalBytes / FILE_CHUNK_SIZE_BYTES));
  }

  getChunkCountForSize(totalBytes: number): number {
    return this.getChunkCount(totalBytes);
  }

  private async hashFileSha256(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = fs.createReadStream(filePath);

      stream.on('data', (chunk) => {
        hash.update(chunk);
      });
      stream.on('error', (error) => reject(error));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  async createOffer(
    _peerId: string,
    filePath: string,
    messageId: string,
    preferredFileId?: string,
    preferredFileName?: string
  ): Promise<{ offer: FileOfferPayload }> {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      throw new Error('Caminho inválido: não é arquivo');
    }
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      throw new Error('Arquivo excede o limite de 200MB');
    }

    const hash = await this.hashFileSha256(filePath);
    const fileId = preferredFileId || randomUUID();
    const filename = preferredFileName || path.basename(filePath);

    return {
      offer: {
        fileId,
        messageId,
        filename,
        size: stat.size,
        sha256: hash
      }
    };
  }

  async *createChunkStream(
    filePath: string,
    fileId: string,
    startIndex = 0
  ): AsyncGenerator<FileChunkPayload, void, void> {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      throw new Error('Caminho inválido: não é arquivo');
    }
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      throw new Error('Arquivo excede o limite de 200MB');
    }

    const total = this.getChunkCount(stat.size);
    const normalizedStart = Math.max(0, Math.min(startIndex, total));
    if (normalizedStart >= total) {
      return;
    }

    if (stat.size === 0) {
      yield {
        fileId,
        index: 0,
        total,
        dataBase64: ''
      };
      return;
    }

    const startOffset = normalizedStart * FILE_CHUNK_SIZE_BYTES;
    let index = normalizedStart;
    const stream = fs.createReadStream(filePath, {
      start: startOffset,
      highWaterMark: FILE_CHUNK_SIZE_BYTES
    });

    try {
      for await (const rawChunk of stream) {
        const buffer = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        yield {
          fileId,
          index,
          total,
          dataBase64: buffer.toString('base64')
        };
        index += 1;
      }
    } finally {
      stream.destroy();
    }
  }

  startIncoming(fileOffer: FileOfferPayload, peerId: string): string {
    const existing = this.incoming.get(fileOffer.fileId);
    if (existing) {
      if (existing.messageId === fileOffer.messageId && existing.peerId === peerId) {
        return existing.finalPath;
      }
      try {
        existing.writeStream.destroy();
      } catch {
        // ignora
      }
      try {
        fs.unlinkSync(existing.finalPath);
      } catch {
        // ignora
      }
      this.incoming.delete(fileOffer.fileId);
    }

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
      receivedIndices: new Set<number>(),
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

    if (!Number.isInteger(chunk.index) || !Number.isInteger(chunk.total)) {
      throw new Error('Chunk inválido');
    }
    if (chunk.total <= 0 || chunk.index < 0 || chunk.index >= chunk.total) {
      throw new Error('Índice de chunk inválido');
    }

    transfer.totalChunks = chunk.total;
    if (transfer.receivedIndices.has(chunk.index)) {
      return {
        done: transfer.totalChunks === transfer.receivedChunks,
        transferred: transfer.transferredBytes,
        total: transfer.totalBytes
      };
    }

    const buffer = Buffer.from(chunk.dataBase64, 'base64');
    transfer.hash.update(buffer);
    transfer.writeStream.write(buffer);
    transfer.receivedIndices.add(chunk.index);
    transfer.receivedChunks = transfer.receivedIndices.size;
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
