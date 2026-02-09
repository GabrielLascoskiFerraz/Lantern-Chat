import path from 'node:path';

export const APP_ID = 'Lantern';
export const APP_VERSION = '1.0.0';
export const MDNS_TYPE = 'lanternchat';
export const MDNS_PROTOCOL = 'tcp';
export const UDP_DISCOVERY_PORT = 43180;
export const UDP_DISCOVERY_MULTICAST_GROUP = '239.255.77.77';
export const UDP_DISCOVERY_MAGIC = 'lantern.beacon.v1';
export const UDP_BEACON_INTERVAL_MS = 4_000;
export const UDP_PEER_STALE_MS = 22_000;
export const WS_PORT_START = 43100;
export const WS_PORT_END = 43150;
export const ANNOUNCEMENTS_CONVERSATION_ID = 'announcements';
export const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024;
export const FILE_CHUNK_SIZE_BYTES = 64 * 1024;
export const WS_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
export const ANNOUNCEMENT_TTL_MS = 24 * 60 * 60 * 1000;
export const ANNOUNCEMENT_PURGE_INTERVAL_MS = 5 * 60 * 1000;

export const getAttachmentsDir = (downloadsPath: string): string =>
  path.join(downloadsPath, 'Lantern Attachments');

export const sanitizeFileName = (name: string): string => {
  const withoutReserved = name.replace(/[<>:"/\\|?*]/g, '_');
  const withoutControlChars = Array.from(withoutReserved, (char) =>
    char.charCodeAt(0) < 32 ? '_' : char
  ).join('');
  return withoutControlChars.trim() || 'arquivo';
};
