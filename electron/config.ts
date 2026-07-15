import path from 'node:path';

export const APP_ID = 'com.lantern.central';
export const APP_VERSION = '1.0.0';
export const ANNOUNCEMENTS_CONVERSATION_ID = 'announcements';
export const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024;
export const FILE_CHUNK_SIZE_BYTES = 64 * 1024;

export const getAttachmentsDir = (downloadsPath: string): string =>
  path.join(downloadsPath, 'Lantern Attachments');

export const sanitizeFileName = (name: string): string => {
  const withoutReserved = name.replace(/[<>:"/\\|?*]/g, '_');
  const withoutControlChars = Array.from(withoutReserved, (char) =>
    char.charCodeAt(0) < 32 ? '_' : char
  ).join('');
  return withoutControlChars.trim() || 'arquivo';
};
