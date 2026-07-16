import path from 'node:path';
import fs from 'node:fs';

export const APP_ID = 'com.lantern.central';
const resolveAppVersion = (): string => {
  for (const candidate of [path.resolve(__dirname, '..', 'package.json'), path.resolve(process.cwd(), 'package.json')]) {
    try {
      const value = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof value.version === 'string' && value.version.trim()) return value.version.trim();
    } catch {
      // Tenta a próxima localização do package.json.
    }
  }
  return String(process.env.npm_package_version || '0.0.0');
};
export const APP_VERSION = resolveAppVersion();
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
