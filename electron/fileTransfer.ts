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
  writeQueue: Buffer[];
  queuedBytes: number;
  waitingDrain: boolean;
  drainListenerAttached: boolean;
  streamErrored: boolean;
  writableWaiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>;
}

export class FileTransferService {
  private static readonly MAX_PENDING_WRITE_QUEUE_BYTES = 24 * 1024 * 1024;
  private static readonly DRAIN_WAIT_TIMEOUT_MS = 20_000;
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
      if (
        existing.messageId === fileOffer.messageId &&
        existing.peerId === peerId &&
        existing.receivedChunks === 0
      ) {
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

    const transfer: IncomingTransfer = {
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
      finalPath,
      writeQueue: [],
      queuedBytes: 0,
      waitingDrain: false,
      drainListenerAttached: false,
      streamErrored: false,
      writableWaiters: []
    };
    writeStream.on('error', () => {
      transfer.streamErrored = true;
      this.rejectWritableWaiters(
        transfer,
        new Error('Falha de escrita durante recebimento de arquivo.')
      );
    });

    this.incoming.set(fileOffer.fileId, transfer);

    return finalPath;
  }

  private hasWriteBacklog(transfer: IncomingTransfer): boolean {
    return transfer.waitingDrain || transfer.writeQueue.length > 0;
  }

  private resolveWritableWaiters(transfer: IncomingTransfer): void {
    if (this.hasWriteBacklog(transfer) || transfer.streamErrored) {
      return;
    }
    const waiters = transfer.writableWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
  }

  private rejectWritableWaiters(transfer: IncomingTransfer, error: Error): void {
    if (transfer.writableWaiters.length === 0) return;
    const waiters = transfer.writableWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }

  private waitForWriteDrain(transfer: IncomingTransfer): Promise<void> {
    if (!this.hasWriteBacklog(transfer) && !transfer.streamErrored) {
      return Promise.resolve();
    }
    if (transfer.streamErrored) {
      return Promise.reject(new Error('Stream em erro durante drain.'));
    }

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = transfer.writableWaiters.findIndex((entry) => entry.resolve === resolve);
        if (index >= 0) {
          transfer.writableWaiters.splice(index, 1);
        }
        reject(new Error('Timeout aguardando drenagem de escrita.'));
      }, FileTransferService.DRAIN_WAIT_TIMEOUT_MS);
      timeout.unref?.();

      transfer.writableWaiters.push({
        resolve,
        reject,
        timeout
      });
    });
  }

  private failIncomingTransfer(transfer: IncomingTransfer): void {
    try {
      transfer.writeStream.destroy();
    } catch {
      // ignora
    }
    this.rejectWritableWaiters(transfer, new Error('Transferência interrompida por backpressure.'));
    this.incoming.delete(transfer.fileId);
    try {
      fs.unlinkSync(transfer.finalPath);
    } catch {
      // ignora
    }
  }

  private flushQueuedWrites(transfer: IncomingTransfer): void {
    if (transfer.streamErrored || transfer.waitingDrain) {
      return;
    }

    while (transfer.writeQueue.length > 0) {
      const nextBuffer = transfer.writeQueue.shift()!;
      transfer.queuedBytes = Math.max(0, transfer.queuedBytes - nextBuffer.length);
      const canContinue = transfer.writeStream.write(nextBuffer);
      if (!canContinue) {
        transfer.waitingDrain = true;
        this.attachDrainListener(transfer);
        return;
      }
    }

    this.resolveWritableWaiters(transfer);
  }

  private attachDrainListener(transfer: IncomingTransfer): void {
    if (transfer.drainListenerAttached) {
      return;
    }
    transfer.drainListenerAttached = true;
    transfer.writeStream.once('drain', () => {
      transfer.waitingDrain = false;
      transfer.drainListenerAttached = false;
      this.flushQueuedWrites(transfer);
    });
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
        done: transfer.totalChunks === transfer.receivedChunks && !this.hasWriteBacklog(transfer),
        transferred: transfer.transferredBytes,
        total: transfer.totalBytes
      };
    }

    const buffer = Buffer.from(chunk.dataBase64, 'base64');
    transfer.hash.update(buffer);
    if (transfer.waitingDrain) {
      const nextQueuedBytes = transfer.queuedBytes + buffer.length;
      if (nextQueuedBytes > FileTransferService.MAX_PENDING_WRITE_QUEUE_BYTES) {
        this.failIncomingTransfer(transfer);
        throw new Error('Fila de escrita excedeu limite de backpressure.');
      }
      transfer.writeQueue.push(buffer);
      transfer.queuedBytes = nextQueuedBytes;
    } else {
      const canContinue = transfer.writeStream.write(buffer);
      if (!canContinue) {
        transfer.waitingDrain = true;
        this.attachDrainListener(transfer);
      }
    }
    transfer.receivedIndices.add(chunk.index);
    transfer.receivedChunks = transfer.receivedIndices.size;
    transfer.transferredBytes += buffer.length;

    if (!this.hasWriteBacklog(transfer)) {
      this.resolveWritableWaiters(transfer);
    }

    return {
      done: transfer.totalChunks === transfer.receivedChunks && !this.hasWriteBacklog(transfer),
      transferred: transfer.transferredBytes,
      total: transfer.totalBytes
    };
  }

  async finalize(
    fileId: string
  ): Promise<{ ok: boolean; finalPath: string; messageId: string; peerId: string }> {
    const transfer = this.incoming.get(fileId);
    if (!transfer) {
      throw new Error('Transferência não encontrada');
    }

    let streamClosed = true;
    try {
      await this.waitForWriteDrain(transfer);
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const onFinish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const onError = (error: Error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        transfer.writeStream.once('finish', onFinish);
        transfer.writeStream.once('error', onError);
        transfer.writeStream.end();
      });
    } catch {
      streamClosed = false;
    }

    const digest = transfer.hash.digest('hex');
    const ok =
      streamClosed &&
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
