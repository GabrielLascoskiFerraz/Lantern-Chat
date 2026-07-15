import type { MessageRow } from './ipcClient';

// O Relay usa blocos fixos de 64 KiB tanto para anexos canônicos quanto para grupos.
export const ATTACHMENT_CHUNK_SIZE_BYTES = 64 * 1024;

export const attachmentChunkCount = (size: number): number =>
  Math.max(1, Math.ceil(Math.max(0, size) / ATTACHMENT_CHUNK_SIZE_BYTES));

export const forEachFileChunk = async (
  file: File,
  startIndex: number,
  callback: (chunk: Uint8Array, index: number, total: number) => Promise<void>
): Promise<void> => {
  const total = attachmentChunkCount(file.size);
  const firstIndex = Math.max(0, Math.min(Math.trunc(startIndex) || 0, total));

  for (let index = firstIndex; index < total; index += 1) {
    const start = index * ATTACHMENT_CHUNK_SIZE_BYTES;
    const end = Math.min(file.size, start + ATTACHMENT_CHUNK_SIZE_BYTES);
    const chunk = new Uint8Array(await file.slice(start, end).arrayBuffer());
    await callback(chunk, index, total);
  }
};

// Frames e snapshots canônicos não carregam o caminho local/blob. Um frame
// repetido jamais pode apagar um anexo que o cliente já terminou de hidratar.
export const mergeAttachmentCache = (
  incoming: MessageRow,
  cached?: MessageRow
): MessageRow => {
  if (!cached || cached.messageId !== incoming.messageId) return incoming;
  return {
    ...incoming,
    filePath: incoming.filePath || cached.filePath,
    fileSize: incoming.fileSize ?? cached.fileSize,
    fileSha256: incoming.fileSha256 || cached.fileSha256,
    status: cached.filePath && !incoming.filePath ? cached.status : incoming.status
  };
};
