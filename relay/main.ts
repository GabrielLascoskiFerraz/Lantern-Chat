import { randomUUID } from 'node:crypto';
import { createSocket, type RemoteInfo, type Socket as UdpSocket } from 'node:dgram';
import fs from 'node:fs';
import { createServer, IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { createServer as createHttpsServer, Server as HttpsServer } from 'node:https';
import { TLSSocket } from 'node:tls';
import path from 'node:path';
import BonjourService, { Service } from 'bonjour-service';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { GroupStore } from './groupStore';
import { RelayGroupEvent, RelayGroupFileChunk } from './groupTypes';
import { CentralStore } from './centralStore';
import { RetentionPolicy } from './centralTypes';

const RELAY_VERSION = '1.0.0';
const RELAY_MDNS_TYPE = 'lanternrelay';
const RELAY_MDNS_PROTOCOL = 'tcp';
const RELAY_DISCOVERY_UDP_QUERY = 'lantern:relay:discover';
const RELAY_DISCOVERY_UDP_RESPONSE = 'lantern:relay:announce';
const ANNOUNCEMENT_TTL_MS = 24 * 60 * 60 * 1000;
const ANNOUNCEMENT_EDIT_WINDOW_MS = 10 * 60 * 1000;
const ANNOUNCEMENT_EXPIRED_RETENTION_MS = 12 * 60 * 60 * 1000;
const ANNOUNCEMENT_SWEEP_INTERVAL_MS = 15_000;
const SEND_CALLBACK_TIMEOUT_MS = 10_000;
const resolveRelayDataDir = (): string => {
  const configured = String(process.env.LANTERN_RELAY_DATA_DIR || '').trim();
  if (configured) return path.resolve(configured);
  if ((process as NodeJS.Process & { pkg?: unknown }).pkg) {
    return path.dirname(process.execPath);
  }
  const entryFile = process.argv[1]
    ? path.resolve(process.argv[1])
    : path.resolve(process.cwd(), 'dist-relay', 'main.js');
  return path.dirname(entryFile);
};
const ANNOUNCEMENT_STORE_FILE = process.env.LANTERN_RELAY_ANNOUNCEMENTS_FILE
  ? path.resolve(process.env.LANTERN_RELAY_ANNOUNCEMENTS_FILE)
  : path.join(resolveRelayDataDir(), 'announcements.json');
const GROUP_STORE_FILE = process.env.LANTERN_RELAY_GROUPS_FILE
  ? path.resolve(process.env.LANTERN_RELAY_GROUPS_FILE)
  : path.join(resolveRelayDataDir(), 'groups.json');
const GROUP_ATTACHMENTS_DIR = process.env.LANTERN_RELAY_GROUP_ATTACHMENTS_DIR
  ? path.resolve(process.env.LANTERN_RELAY_GROUP_ATTACHMENTS_DIR)
  : path.join(resolveRelayDataDir(), 'group-attachments');
const RELAY_STICKERS_DIR = process.env.LANTERN_RELAY_STICKERS_DIR
  ? path.resolve(process.env.LANTERN_RELAY_STICKERS_DIR)
  : path.join(resolveRelayDataDir(), 'stickers');
// Optional protection for the browser dashboard when the Relay is exposed outside a trusted LAN.
const RELAY_DASHBOARD_TOKEN = String(process.env.LANTERN_RELAY_DASHBOARD_TOKEN || '').trim();
const RELAY_STICKER_CATEGORY_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const RELAY_STICKER_FILE_NAME_RE = /^[a-z0-9][a-z0-9._ -]*\.gif$/i;
const RELAY_STICKER_MAX_BYTES = 20 * 1024 * 1024;

const OPEN_READY_STATE = 1;
const GROUP_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

interface RelayConfig {
  host: string;
  port: number;
  pingIntervalMs: number;
  peerTimeoutMs: number;
  presenceBroadcastIntervalMs: number;
  maxPayloadBytes: number;
  tlsCertFile: string | null;
  tlsKeyFile: string | null;
  externalMode: boolean;
}

interface RelayPeerInfo {
  deviceId: string;
  displayName: string;
  avatarEmoji: string;
  avatarBg: string;
  statusMessage: string;
  appVersion: string;
  department: string;
  username: string;
  connectedAt: number;
  lastSeenAt: number;
}

interface RelayEnvelope {
  type: string;
  payload?: unknown;
}

interface RelayHelloPayload {
  deviceId: string;
  displayName: string;
  avatarEmoji: string;
  avatarBg: string;
  statusMessage: string;
  appVersion: string;
  sessionToken: string;
}

interface RelayTransportFrame {
  type: string;
  messageId: string;
  from: string;
  to: string | null;
  createdAt: number;
  payload: unknown;
}

type AnnouncementReactionValue = '👍' | '👎' | '❤️' | '😢' | '😊' | '😂';

interface RelayReactPayload {
  targetMessageId: string;
  reaction: AnnouncementReactionValue | null;
}

interface RelayAnnouncementEditPayload {
  targetMessageId: string;
  text: string;
}

interface RelaySession {
  sessionId: string;
  socket: WebSocket;
  peer: RelayPeerInfo | null;
  lastSeenAt: number;
  isAlive: boolean;
  messageQueue: Promise<void>;
  // Downloads stay ordered, but must not block this peer's commands while a
  // potentially large group attachment is being streamed.
  groupFileDownloadQueue: Promise<void>;
  authToken: string | null;
}

interface RelayAnnouncementState {
  messageId: string;
  createdAt: number;
  expiresAt: number;
  expiredAt: number | null;
  deletedAt: number | null;
  reactionsByDeviceId: Record<string, AnnouncementReactionValue>;
  readByDeviceId: Record<string, number>;
  frame: RelayTransportFrame;
}

interface RelayAnnouncementReadPayload {
  messageIds: string[];
  readAt?: number;
}

interface RelayDashboardPeer {
  deviceId: string;
  deviceShort: string;
  displayName: string;
  avatarEmoji: string;
  avatarBg: string;
  statusMessage: string;
  appVersion: string;
  connectedAt: number;
  lastSeenAt: number;
  onlineForMs: number;
  lastSeenAgoMs: number;
}

interface RelayDashboardAnnouncement {
  messageId: string;
  messageShort: string;
  authorDeviceId: string;
  authorName: string;
  authorAvatarEmoji: string;
  authorAvatarBg: string;
  text: string;
  createdAt: number;
  expiresAt: number;
  expiresInMs: number;
  reactionsCount: number;
  readsCount: number;
}

interface RelayDashboardSnapshot {
  ok: true;
  version: string;
  now: number;
  startedAt: number;
  uptimeMs: number;
  host: string;
  port: number;
  peersOnline: number;
  sessionsOpen: number;
  presenceRevision: number;
  announcementStoreFile: string;
  announcementsActive: number;
  stickersAvailable: number;
  centralStore: {
    users: number;
    sessions: number;
    frames: number;
    attachments: number;
    attachmentBytes: number;
    retentionPolicy: RetentionPolicy;
  };
  transferMetrics: {
    uploadAttempts: number;
    uploadsCompleted: number;
    uploadsFailed: number;
    downloadAttempts: number;
    downloadsResumed: number;
    downloadsCompleted: number;
    downloadsFailed: number;
    bytesUploaded: number;
    bytesDownloaded: number;
    retainedFiles: number;
    retainedBytes: number;
    activeUploads: number;
    pendingRecipients: number;
    averageSendLatencyMs: number;
    maxSendLatencyMs: number;
    sendFailures: number;
  };
  peers: RelayDashboardPeer[];
  announcements: RelayDashboardAnnouncement[];
}

interface RelayStickerItem {
  id: string;
  label: string;
  fileName: string;
  relativePath: string;
  size: number;
  category: string;
  updatedAt: number;
}

const DEFAULT_CONFIG: RelayConfig = {
  host: '0.0.0.0',
  port: 43190,
  pingIntervalMs: 5_000,
  peerTimeoutMs: 30_000,
  presenceBroadcastIntervalMs: 12_000,
  maxPayloadBytes: 8 * 1024 * 1024,
  tlsCertFile: null,
  tlsKeyFile: null,
  externalMode: false
};

const asRecord = (value: unknown): JsonRecord | null => {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) return null;
  return value as JsonRecord;
};

const asString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const asFiniteNumber = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
};

const normalizeHelloPayload = (value: unknown): RelayHelloPayload | null => {
  const record = asRecord(value);
  if (!record) return null;

  const deviceId = asString(record.deviceId);
  const displayName = asString(record.displayName);
  const avatarEmoji = asString(record.avatarEmoji);
  const avatarBg = asString(record.avatarBg);
  const statusMessage = asString(record.statusMessage) || 'Disponível';
  const appVersion = asString(record.appVersion) || 'unknown';
  const sessionToken = asString(record.sessionToken);

  if (!deviceId || !displayName || !avatarEmoji || !avatarBg || !sessionToken) {
    return null;
  }

  return {
    deviceId,
    displayName,
    avatarEmoji,
    avatarBg,
    statusMessage,
    appVersion,
    sessionToken
  };
};

const normalizeFrame = (value: unknown): RelayTransportFrame | null => {
  const record = asRecord(value);
  if (!record) return null;

  const type = asString(record.type);
  const messageId = asString(record.messageId);
  const from = asString(record.from);
  const createdAt = asFiniteNumber(record.createdAt);
  const toRaw = record.to;
  const to =
    typeof toRaw === 'string'
      ? toRaw.trim()
      : toRaw === null
      ? null
      : null;

  if (!type || !messageId || !from || !createdAt) {
    return null;
  }

  return {
    type,
    messageId,
    from,
    to,
    createdAt,
    payload: record.payload
  };
};

const parseInteger = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const extractDeleteTargetMessageId = (frame: RelayTransportFrame): string | null => {
  if (frame.type !== 'chat:delete') return null;
  const payload = asRecord(frame.payload);
  return asString(payload?.targetMessageId);
};

const extractAnnouncementEditPayload = (frame: RelayTransportFrame): RelayAnnouncementEditPayload | null => {
  if (frame.type !== 'chat:edit' || frame.to !== null) return null;
  const payload = asRecord(frame.payload);
  const targetMessageId = asString(payload?.targetMessageId);
  const text = asString(payload?.text);
  if (!targetMessageId || !text) return null;
  return { targetMessageId, text: text.slice(0, 12_000) };
};

const normalizeStickerRelativePath = (value: string): string | null => {
  const normalized = value.trim().replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.length === 1 && RELAY_STICKER_FILE_NAME_RE.test(segments[0])) {
    return segments[0];
  }
  if (
    segments.length === 2 &&
    RELAY_STICKER_CATEGORY_RE.test(segments[0]) &&
    RELAY_STICKER_FILE_NAME_RE.test(segments[1])
  ) {
    return `${segments[0]}/${segments[1]}`;
  }
  return null;
};

const ALLOWED_ANNOUNCEMENT_REACTIONS = new Set<AnnouncementReactionValue>([
  '👍',
  '👎',
  '❤️',
  '😢',
  '😊',
  '😂'
]);

const extractReactPayload = (frame: RelayTransportFrame): RelayReactPayload | null => {
  if (frame.type !== 'chat:react') return null;
  const payload = asRecord(frame.payload);
  const targetMessageId = asString(payload?.targetMessageId);
  if (!targetMessageId) return null;

  const rawReaction = payload?.reaction;
  if (rawReaction === null) {
    return { targetMessageId, reaction: null };
  }

  const reaction = asString(rawReaction);
  if (!reaction || !ALLOWED_ANNOUNCEMENT_REACTIONS.has(reaction as AnnouncementReactionValue)) {
    return null;
  }

  return {
    targetMessageId,
    reaction: reaction as AnnouncementReactionValue
  };
};

const normalizeAnnouncementReadPayload = (value: unknown): RelayAnnouncementReadPayload | null => {
  const record = asRecord(value);
  if (!record) return null;
  const messageIds = Array.isArray(record.messageIds)
    ? Array.from(
        new Set(
          record.messageIds
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
        )
      )
    : [];
  if (messageIds.length === 0) return null;
  const rawReadAt = asFiniteNumber(record.readAt);
  return {
    messageIds,
    readAt: rawReadAt && rawReadAt > 0 ? Math.trunc(rawReadAt) : Date.now()
  };
};

const parseCliArg = (name: '--host' | '--port'): string | undefined => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
};

type RelayLogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_WEIGHTS: Record<RelayLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const resolveLogLevel = (): RelayLogLevel => {
  const raw = String(process.env.LANTERN_RELAY_LOG_LEVEL || 'info')
    .trim()
    .toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'info';
};

const ACTIVE_LOG_LEVEL = resolveLogLevel();
const LOG_RATE_LIMIT_TS_BY_KEY = new Map<string, number>();

const shouldLog = (level: RelayLogLevel, rateKey?: string, rateLimitMs?: number): boolean => {
  if (LOG_LEVEL_WEIGHTS[level] < LOG_LEVEL_WEIGHTS[ACTIVE_LOG_LEVEL]) {
    return false;
  }
  if (!rateKey || !rateLimitMs || rateLimitMs <= 0) {
    return true;
  }
  const now = Date.now();
  const last = LOG_RATE_LIMIT_TS_BY_KEY.get(rateKey) || 0;
  if (now - last < rateLimitMs) {
    return false;
  }
  LOG_RATE_LIMIT_TS_BY_KEY.set(rateKey, now);
  return true;
};

const logRelay = (
  event: string,
  details?: Record<string, unknown>,
  options?: {
    level?: RelayLogLevel;
    rateKey?: string;
    rateLimitMs?: number;
  }
): void => {
  const level = options?.level || 'info';
  if (!shouldLog(level, options?.rateKey, options?.rateLimitMs)) {
    return;
  }
  const now = new Date().toISOString();
  const prefix = `[LanternRelay][${now}][${level.toUpperCase()}]`;
  if (!details) {
    if (level === 'error') {
      console.error(`${prefix} ${event}`);
    } else if (level === 'warn') {
      console.warn(`${prefix} ${event}`);
    } else {
      console.log(`${prefix} ${event}`);
    }
    return;
  }
  const line = `${prefix} ${event} ${JSON.stringify(details)}`;
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
};

const RELAY_DASHBOARD_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LanternRelay</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #eef3fb;
      --bg-strong: #dfe9f7;
      --surface: rgba(255, 255, 255, 0.82);
      --surface-strong: rgba(255, 255, 255, 0.94);
      --text: #142033;
      --muted: #637188;
      --line: rgba(88, 112, 146, 0.22);
      --accent: #147ad6;
      --accent-soft: rgba(20, 122, 214, 0.12);
      --good: #18a058;
      --warn: #d9822b;
      --shadow: 0 22px 60px rgba(41, 66, 105, 0.16);
      font-family: ui-rounded, "SF Pro Rounded", "Aptos", "Segoe UI", system-ui, sans-serif;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0d1420;
        --bg-strong: #111d2d;
        --surface: rgba(22, 34, 52, 0.78);
        --surface-strong: rgba(27, 41, 62, 0.92);
        --text: #edf4ff;
        --muted: #9ba8bd;
        --line: rgba(180, 202, 235, 0.16);
        --accent: #6bb6ff;
        --accent-soft: rgba(107, 182, 255, 0.13);
        --shadow: 0 28px 80px rgba(0, 0, 0, 0.34);
      }
    }

    * { box-sizing: border-box; }

    body {
      min-height: 100vh;
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(circle at 12% 4%, rgba(20, 122, 214, 0.20), transparent 30%),
        radial-gradient(circle at 90% 10%, rgba(24, 160, 88, 0.15), transparent 28%),
        linear-gradient(135deg, var(--bg), var(--bg-strong));
    }

    .page {
      width: min(1180px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 30px 0 42px;
    }

    .hero {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 22px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    }

    .mark {
      display: grid;
      width: 54px;
      height: 54px;
      place-items: center;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: linear-gradient(145deg, var(--surface-strong), var(--accent-soft));
      box-shadow: var(--shadow);
      font-size: 26px;
    }

    h1 {
      margin: 0;
      font-size: clamp(28px, 5vw, 44px);
      letter-spacing: -0.055em;
      line-height: 1;
    }

    .subtitle {
      margin: 7px 0 0;
      color: var(--muted);
      font-size: 14px;
    }

    .live-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 12px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--surface);
      color: var(--muted);
      box-shadow: 0 12px 30px rgba(20, 122, 214, 0.10);
      white-space: nowrap;
    }

    .dot {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: var(--good);
      box-shadow: 0 0 0 5px rgba(24, 160, 88, 0.12);
    }

    .dot.offline {
      background: #c43f3f;
      box-shadow: 0 0 0 5px rgba(196, 63, 63, 0.12);
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
      margin-bottom: 16px;
    }

    .card {
      border: 1px solid var(--line);
      border-radius: 24px;
      background: var(--surface);
      box-shadow: var(--shadow);
      backdrop-filter: blur(18px);
    }

    .metric {
      padding: 18px;
      min-height: 126px;
    }

    .metric-label {
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.045em;
      text-transform: uppercase;
    }

    .metric-value {
      margin-top: 12px;
      font-size: 31px;
      font-weight: 850;
      letter-spacing: -0.05em;
    }

    .metric-note {
      margin-top: 8px;
      color: var(--muted);
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .content {
      display: grid;
      grid-template-columns: minmax(0, 1.06fr) minmax(340px, 0.94fr);
      gap: 16px;
    }

    .section {
      overflow: hidden;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 18px 18px 10px;
    }

    .section-title {
      margin: 0;
      font-size: 18px;
      letter-spacing: -0.025em;
    }

    .section-meta {
      color: var(--muted);
      font-size: 13px;
    }

    .list {
      display: grid;
      gap: 10px;
      padding: 8px 12px 14px;
    }

    .peer,
    .announcement {
      display: grid;
      gap: 10px;
      padding: 13px;
      border: 1px solid var(--line);
      border-radius: 20px;
      background: rgba(255, 255, 255, 0.34);
      transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
    }

    @media (prefers-color-scheme: dark) {
      .peer,
      .announcement {
        background: rgba(255, 255, 255, 0.035);
      }
    }

    .peer:hover,
    .announcement:hover {
      transform: translateY(-1px);
      border-color: rgba(20, 122, 214, 0.34);
      background: var(--surface-strong);
    }

    .peer-main {
      display: grid;
      grid-template-columns: 46px minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
    }

    .avatar {
      display: grid;
      width: 46px;
      height: 46px;
      place-items: center;
      border-radius: 16px;
      color: #fff;
      font-size: 22px;
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35), 0 10px 22px rgba(0, 0, 0, 0.10);
    }

    .name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 800;
      letter-spacing: -0.02em;
    }

    .status {
      margin-top: 3px;
      overflow: hidden;
      color: var(--muted);
      font-size: 13px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .state {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 7px 10px;
      border-radius: 999px;
      background: rgba(24, 160, 88, 0.12);
      color: var(--good);
      font-size: 12px;
      font-weight: 800;
    }

    .details {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }

    .chip {
      max-width: 100%;
      overflow: hidden;
      padding: 6px 9px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--accent-soft);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .announcement-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
      font-size: 12px;
    }

    .announcement-author {
      display: inline-flex;
      min-width: 0;
      align-items: center;
      gap: 8px;
      font-weight: 800;
      color: var(--text);
    }

    .mini-avatar {
      display: grid;
      width: 28px;
      height: 28px;
      flex: 0 0 auto;
      place-items: center;
      border-radius: 10px;
      color: #fff;
      font-size: 15px;
    }

    .announcement-text {
      margin: 0;
      color: var(--text);
      line-height: 1.42;
      overflow-wrap: anywhere;
    }

    .empty {
      padding: 26px 18px 30px;
      color: var(--muted);
      text-align: center;
    }

    .footer {
      margin-top: 18px;
      color: var(--muted);
      font-size: 12px;
      text-align: center;
    }

    .admin-section { margin-top: 16px; padding: 18px; }
    .admin-grid { display: grid; grid-template-columns: minmax(280px, .72fr) minmax(0, 1.28fr); gap: 14px; }
    .admin-panel { padding: 14px; border: 1px solid var(--line); border-radius: 18px; background: rgba(255,255,255,.2); }
    .admin-panel h3 { margin: 0 0 12px; font-size: 15px; }
    .admin-form { display: grid; gap: 9px; }
    .admin-form.two { grid-template-columns: 1fr 1fr; }
    .admin-form input, .admin-form select {
      width: 100%; min-height: 40px; border: 1px solid var(--line); border-radius: 12px;
      padding: 0 11px; color: var(--text); background: var(--surface-strong); font: inherit;
    }
    .admin-form button, .admin-action {
      min-height: 38px; border: 1px solid var(--line); border-radius: 12px; padding: 0 13px;
      color: #fff; background: var(--accent); font: inherit; font-weight: 750; cursor: pointer;
    }
    .admin-action.secondary { color: var(--text); background: var(--surface-strong); }
    .admin-action.danger { color: #fff; background: #c43f3f; }
    .admin-users { display: grid; gap: 9px; max-height: 430px; overflow: auto; }
    .admin-user { display: grid; gap: 9px; padding: 12px; border: 1px solid var(--line); border-radius: 15px; }
    .admin-user-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .admin-user-fields { display: grid; grid-template-columns: minmax(120px,1fr) minmax(140px,1fr) repeat(3,auto); gap: 8px; }
    .admin-user-fields input { min-width: 0; min-height: 36px; border: 1px solid var(--line); border-radius: 10px; padding: 0 9px; background: var(--surface-strong); color: var(--text); }
    .admin-feedback { min-height: 18px; margin-top: 8px; color: var(--muted); font-size: 12px; }
    .hidden { display: none !important; }

    @media (max-width: 880px) {
      .hero {
        align-items: flex-start;
        flex-direction: column;
      }

      .grid,
      .content,
      .admin-grid,
      .admin-form.two,
      .admin-user-fields {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main class="page">
    <header class="hero">
      <div class="brand">
        <div class="mark" aria-hidden="true">✦</div>
        <div>
          <h1>LanternRelay</h1>
          <p class="subtitle">Painel em tempo real do servidor de ponte Lantern</p>
        </div>
      </div>
      <div class="live-pill" aria-live="polite">
        <span id="status-dot" class="dot"></span>
        <span id="status-text">Atualizando...</span>
      </div>
    </header>

    <section class="grid" aria-label="Resumo do Relay">
      <article class="card metric">
        <div class="metric-label">Usuários online</div>
        <div id="metric-peers" class="metric-value">--</div>
        <div id="metric-sessions" class="metric-note">sessões abertas</div>
      </article>
      <article class="card metric">
        <div class="metric-label">Tempo ativo</div>
        <div id="metric-uptime" class="metric-value">--</div>
        <div id="metric-started" class="metric-note">iniciado em --</div>
      </article>
      <article class="card metric">
        <div class="metric-label">Anúncios ativos</div>
        <div id="metric-announcements" class="metric-value">--</div>
        <div class="metric-note">expiram após 24h</div>
      </article>
      <article class="card metric">
        <div class="metric-label">Presença</div>
        <div id="metric-revision" class="metric-value">--</div>
        <div id="metric-endpoint" class="metric-note">endpoint --</div>
      </article>
      <article class="card metric">
        <div class="metric-label">Anexos retidos</div>
        <div id="metric-retained" class="metric-value">--</div>
        <div id="metric-retained-bytes" class="metric-note">-- armazenados</div>
      </article>
      <article class="card metric">
        <div class="metric-label">Transferências</div>
        <div id="metric-transfers" class="metric-value">--</div>
        <div id="metric-transfer-attempts" class="metric-note">-- tentativas</div>
      </article>
      <article class="card metric">
        <div class="metric-label">Retomadas</div>
        <div id="metric-resumes" class="metric-value">--</div>
        <div id="metric-transfer-failures" class="metric-note">-- falhas</div>
      </article>
      <article class="card metric">
        <div class="metric-label">Latência de envio</div>
        <div id="metric-latency" class="metric-value">--</div>
        <div id="metric-latency-max" class="metric-note">máxima --</div>
      </article>
    </section>

    <section class="content">
      <article class="card section">
        <div class="section-header">
          <h2 class="section-title">Usuários conectados</h2>
          <span id="peers-meta" class="section-meta">--</span>
        </div>
        <div id="peers-list" class="list"></div>
      </article>

      <article class="card section">
        <div class="section-header">
          <h2 class="section-title">Anúncios</h2>
          <span id="announcements-meta" class="section-meta">--</span>
        </div>
        <div id="announcements-list" class="list"></div>
      </article>
    </section>

    <section class="card admin-section" aria-label="Administração do Relay">
      <div class="section-header" style="padding:0 0 14px">
        <div>
          <h2 class="section-title">Administração</h2>
          <div class="section-meta">Disponível somente no localhost deste servidor</div>
        </div>
        <span id="admin-state" class="section-meta">Autenticação necessária</span>
      </div>

      <div id="admin-login" class="admin-panel">
        <form id="admin-login-form" class="admin-form two">
          <input id="admin-username" autocomplete="username" placeholder="Usuário administrador" value="admin" required>
          <input id="admin-password" type="password" autocomplete="current-password" placeholder="Senha" required>
          <button type="submit">Entrar na administração</button>
        </form>
      </div>

      <div id="admin-content" class="admin-grid hidden">
        <div style="display:grid;gap:14px;align-content:start">
          <div class="admin-panel">
            <h3>Criar conta</h3>
            <form id="admin-create-user" class="admin-form">
              <input id="new-username" placeholder="Usuário (ex.: maria.silva)" required>
              <input id="new-display-name" placeholder="Nome de exibição" required>
              <input id="new-department" placeholder="Setor (ex.: Financeiro)">
              <input id="new-password" type="password" minlength="10" placeholder="Senha inicial (mín. 10 caracteres)" required>
              <select id="new-locale">
                <option value="pt-BR">Português</option><option value="en">English</option><option value="es">Español</option>
              </select>
              <button type="submit">Criar usuário</button>
            </form>
          </div>
          <div class="admin-panel">
            <h3>Retenção de mensagens</h3>
            <form id="retention-form" class="admin-form">
              <select id="retention-policy">
                <option value="forever">Manter para sempre</option>
                <option value="1_month">Excluir após 1 mês</option>
                <option value="6_months">Excluir após 6 meses</option>
                <option value="1_year">Excluir após 1 ano</option>
              </select>
              <button type="submit">Salvar política</button>
            </form>
          </div>
        </div>
        <div class="admin-panel">
          <h3>Contas de usuário</h3>
          <div id="admin-users" class="admin-users"></div>
        </div>
      </div>
      <div id="admin-feedback" class="admin-feedback"></div>
    </section>

    <footer id="store-path" class="footer"></footer>
  </main>

  <script>
    const $ = (id) => document.getElementById(id);
    const dateTime = new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });

    const formatDuration = (ms) => {
      const safeMs = Math.max(0, Number(ms) || 0);
      const totalSeconds = Math.floor(safeMs / 1000);
      const days = Math.floor(totalSeconds / 86400);
      const hours = Math.floor((totalSeconds % 86400) / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      if (days > 0) return days + 'd ' + hours + 'h';
      if (hours > 0) return hours + 'h ' + minutes + 'm';
      if (minutes > 0) return minutes + 'm ' + seconds + 's';
      return seconds + 's';
    };

    const formatTime = (ts) => {
      if (!Number.isFinite(ts) || ts <= 0) return '--';
      return dateTime.format(new Date(ts));
    };

    const formatBytes = (bytes) => {
      const value = Math.max(0, Number(bytes) || 0);
      if (value < 1024) return value + ' B';
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
      if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB';
      return (value / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    };

    const setText = (id, value) => {
      const node = $(id);
      if (node) node.textContent = value;
    };

    const clear = (node) => {
      while (node.firstChild) node.removeChild(node.firstChild);
    };

    const make = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    const renderPeers = (peers) => {
      const list = $('peers-list');
      if (!list) return;
      clear(list);
      if (!peers.length) {
        list.appendChild(make('div', 'empty', 'Nenhum client conectado agora.'));
        return;
      }
      for (const peer of peers) {
        const item = make('article', 'peer');
        const main = make('div', 'peer-main');
        const avatar = make('div', 'avatar', peer.avatarEmoji || '🙂');
        avatar.style.background = peer.avatarBg || '#147ad6';

        const text = make('div');
        text.appendChild(make('div', 'name', peer.displayName || 'Usuário'));
        text.appendChild(make('div', 'status', peer.statusMessage || 'Disponível'));

        const state = make('div', 'state', 'Online');
        main.appendChild(avatar);
        main.appendChild(text);
        main.appendChild(state);

        const details = make('div', 'details');
        details.appendChild(make('span', 'chip', 'ID ' + peer.deviceShort));
        details.appendChild(make('span', 'chip', 'ativo há ' + formatDuration(peer.onlineForMs)));
        details.appendChild(make('span', 'chip', 'v' + (peer.appVersion || 'unknown')));
        details.appendChild(make('span', 'chip', 'último sinal ' + formatDuration(peer.lastSeenAgoMs)));

        item.appendChild(main);
        item.appendChild(details);
        list.appendChild(item);
      }
    };

    const renderAnnouncements = (announcements) => {
      const list = $('announcements-list');
      if (!list) return;
      clear(list);
      if (!announcements.length) {
        list.appendChild(make('div', 'empty', 'Nenhum anúncio ativo.'));
        return;
      }
      for (const announcement of announcements) {
        const item = make('article', 'announcement');
        const head = make('div', 'announcement-head');
        const author = make('div', 'announcement-author');
        const avatar = make('span', 'mini-avatar', announcement.authorAvatarEmoji || '✦');
        avatar.style.background = announcement.authorAvatarBg || '#147ad6';
        author.appendChild(avatar);
        author.appendChild(make('span', '', announcement.authorName || 'Usuário'));
        head.appendChild(author);
        head.appendChild(make('span', '', formatTime(announcement.createdAt)));

        const text = make('p', 'announcement-text', announcement.text || '(sem texto)');
        const details = make('div', 'details');
        details.appendChild(make('span', 'chip', 'expira em ' + formatDuration(announcement.expiresInMs)));
        details.appendChild(make('span', 'chip', announcement.reactionsCount + ' reações'));
        details.appendChild(make('span', 'chip', announcement.readsCount + ' leituras'));
        details.appendChild(make('span', 'chip', 'ID ' + announcement.messageShort));

        item.appendChild(head);
        item.appendChild(text);
        item.appendChild(details);
        list.appendChild(item);
      }
    };

    const applySnapshot = (data) => {
      setText('metric-peers', String(data.peersOnline));
      setText('metric-sessions', String(data.sessionsOpen) + ' sessões abertas');
      setText('metric-uptime', formatDuration(data.uptimeMs));
      setText('metric-started', 'iniciado em ' + formatTime(data.startedAt));
      setText('metric-announcements', String(data.announcementsActive));
      setText('metric-revision', '#' + data.presenceRevision);
      setText('metric-endpoint', 'ws://' + data.host + ':' + data.port);
      const transfers = data.transferMetrics || {};
      const completedTransfers = Number(transfers.uploadsCompleted || 0) + Number(transfers.downloadsCompleted || 0);
      const transferAttempts = Number(transfers.uploadAttempts || 0) + Number(transfers.downloadAttempts || 0);
      const transferFailures = Number(transfers.uploadsFailed || 0) + Number(transfers.downloadsFailed || 0);
      setText('metric-retained', String(transfers.retainedFiles || 0));
      setText('metric-retained-bytes', formatBytes(transfers.retainedBytes) + ' · ' + String(transfers.pendingRecipients || 0) + ' entregas pendentes');
      setText('metric-transfers', String(completedTransfers));
      setText('metric-transfer-attempts', String(transferAttempts) + ' tentativas · ' + formatBytes(Number(transfers.bytesUploaded || 0) + Number(transfers.bytesDownloaded || 0)));
      setText('metric-resumes', String(transfers.downloadsResumed || 0));
      setText('metric-transfer-failures', String(transferFailures) + ' falhas · ' + String(transfers.activeUploads || 0) + ' uploads ativos');
      setText('metric-latency', Number(transfers.averageSendLatencyMs || 0).toFixed(1) + ' ms');
      setText('metric-latency-max', 'máxima ' + Number(transfers.maxSendLatencyMs || 0).toFixed(1) + ' ms · ' + String(transfers.sendFailures || 0) + ' falhas de socket');
      setText('peers-meta', String(data.peers.length) + ' online');
      setText('announcements-meta', String(data.announcements.length) + ' ativos');
      setText('store-path', 'Dados de anúncios: ' + data.announcementStoreFile + ' · métricas reiniciam com o Relay');
      setText('status-text', 'Online · atualizado ' + new Date().toLocaleTimeString('pt-BR'));
      const dot = $('status-dot');
      if (dot) dot.classList.remove('offline');
      renderPeers(data.peers || []);
      renderAnnouncements(data.announcements || []);
    };

    const dashboardToken = new URLSearchParams(window.location.search).get('token');
    const dashboardApiUrl = dashboardToken
      ? '/api/status?token=' + encodeURIComponent(dashboardToken)
      : '/api/status';

    let adminCsrf = sessionStorage.getItem('lantern.admin.csrf') || '';
    const adminFetch = async (url, options = {}) => {
      const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
      if (adminCsrf && options.method && options.method !== 'GET') headers['x-lantern-csrf'] = adminCsrf;
      return fetch(url, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
    };

    const setAdminFeedback = (message) => setText('admin-feedback', message || '');

    const renderAdminUsers = (users) => {
      const list = $('admin-users');
      if (!list) return;
      clear(list);
      for (const user of users) {
        const item = make('div', 'admin-user');
        const head = make('div', 'admin-user-head');
        const identity = make('div');
        identity.appendChild(make('div', 'name', (user.avatarEmoji || '🙂') + ' ' + user.displayName));
        identity.appendChild(make('div', 'status', '@' + user.username + ' · ' + (user.role === 'admin' ? 'Administrador' : 'Usuário')));
        head.appendChild(identity);
        head.appendChild(make('span', 'chip', user.disabled ? 'Desativado' : 'Ativo'));

        const fields = make('div', 'admin-user-fields');
        const department = make('input');
        department.value = user.department || '';
        department.placeholder = 'Setor';
        const password = make('input');
        password.type = 'password';
        password.placeholder = 'Nova senha';
        const save = make('button', 'admin-action secondary', 'Salvar setor');
        save.addEventListener('click', async () => {
          const response = await adminFetch('/api/admin/users/' + encodeURIComponent(user.userId), {
            method: 'PATCH', body: JSON.stringify({ department: department.value })
          });
          setAdminFeedback(response.ok ? 'Setor atualizado.' : 'Não foi possível atualizar o setor.');
          if (response.ok) void loadAdmin();
        });
        const reset = make('button', 'admin-action secondary', 'Redefinir senha');
        reset.addEventListener('click', async () => {
          if (password.value.length < 10) { setAdminFeedback('A nova senha deve ter ao menos 10 caracteres.'); return; }
          const response = await adminFetch('/api/admin/users/' + encodeURIComponent(user.userId) + '/password', {
            method: 'POST', body: JSON.stringify({ password: password.value })
          });
          password.value = '';
          setAdminFeedback(response.ok ? 'Senha redefinida; sessões anteriores foram encerradas.' : 'Falha ao redefinir senha.');
        });
        const remove = make('button', 'admin-action danger', 'Excluir');
        remove.disabled = user.role === 'admin';
        remove.addEventListener('click', async () => {
          if (!confirm('Excluir permanentemente a conta de ' + user.displayName + '?')) return;
          const response = await adminFetch('/api/admin/users/' + encodeURIComponent(user.userId), { method: 'DELETE' });
          setAdminFeedback(response.ok ? 'Conta excluída.' : 'Não foi possível excluir a conta.');
          if (response.ok) void loadAdmin();
        });
        fields.appendChild(department);
        fields.appendChild(password);
        fields.appendChild(save);
        fields.appendChild(reset);
        fields.appendChild(remove);
        item.appendChild(head);
        item.appendChild(fields);
        list.appendChild(item);
      }
    };

    const loadAdmin = async () => {
      const usersResponse = await adminFetch('/api/admin/users', { method: 'GET' });
      if (!usersResponse.ok) {
        $('admin-login')?.classList.remove('hidden');
        $('admin-content')?.classList.add('hidden');
        setText('admin-state', 'Autenticação necessária');
        return;
      }
      const usersBody = await usersResponse.json();
      const retentionResponse = await adminFetch('/api/admin/retention', { method: 'GET' });
      const retentionBody = retentionResponse.ok ? await retentionResponse.json() : { policy: 'forever' };
      $('admin-login')?.classList.add('hidden');
      $('admin-content')?.classList.remove('hidden');
      setText('admin-state', 'Sessão administrativa ativa');
      const retention = $('retention-policy');
      if (retention) retention.value = retentionBody.policy || 'forever';
      renderAdminUsers(usersBody.users || []);
    };

    $('admin-login-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const response = await fetch('/api/admin/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: $('admin-username').value, password: $('admin-password').value })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setAdminFeedback(body.message || 'Credenciais inválidas.'); return; }
      adminCsrf = body.csrfToken || '';
      sessionStorage.setItem('lantern.admin.csrf', adminCsrf);
      $('admin-password').value = '';
      setAdminFeedback('Acesso administrativo liberado.');
      void loadAdmin();
    });

    $('admin-create-user')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const response = await adminFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username: $('new-username').value,
          displayName: $('new-display-name').value,
          department: $('new-department').value,
          password: $('new-password').value,
          locale: $('new-locale').value
        })
      });
      const body = await response.json().catch(() => ({}));
      setAdminFeedback(response.ok ? 'Usuário criado.' : (body.message || 'Falha ao criar usuário.'));
      if (response.ok) { event.target.reset(); void loadAdmin(); }
    });

    $('retention-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const response = await adminFetch('/api/admin/retention', {
        method: 'PUT', body: JSON.stringify({ policy: $('retention-policy').value })
      });
      setAdminFeedback(response.ok ? 'Política de retenção atualizada.' : 'Falha ao atualizar retenção.');
    });

    const load = async () => {
      try {
        const response = await fetch(dashboardApiUrl, { cache: 'no-store' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        applySnapshot(data);
      } catch (error) {
        setText('status-text', 'Sem conexão com o Relay');
        const dot = $('status-dot');
        if (dot) dot.classList.add('offline');
      }
    };

    void load();
    void loadAdmin();
    setInterval(load, 3000);
  </script>
</body>
</html>`;

class LanternRelay {
  private readonly config: RelayConfig;
  private readonly httpServer: HttpServer | HttpsServer;
  private readonly wsServer: WebSocketServer;
  private readonly startedAt = Date.now();
  private readonly groupStore: GroupStore;
  private readonly centralStore: CentralStore;
  private readonly sessionsBySocket = new Map<WebSocket, RelaySession>();
  private readonly sessionsByDeviceId = new Map<string, RelaySession>();
  private readonly announcementsById = new Map<string, RelayAnnouncementState>();
  private announcementPersistTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private presenceBroadcastTimer: NodeJS.Timeout | null = null;
  private announcementSweepTimer: NodeJS.Timeout | null = null;
  private groupSweepTimer: NodeJS.Timeout | null = null;
  private bonjour: BonjourService | null = null;
  private published: Service | null = null;
  private udpSocket: UdpSocket | null = null;
  private presenceRevision = 0;
  private readonly loginAttemptsByAddress = new Map<string, { failures: number; blockedUntil: number }>();
  private readonly transferMetrics = {
    uploadAttempts: 0,
    uploadsCompleted: 0,
    uploadsFailed: 0,
    downloadAttempts: 0,
    downloadsResumed: 0,
    downloadsCompleted: 0,
    downloadsFailed: 0,
    bytesUploaded: 0,
    bytesDownloaded: 0,
    sendLatencyTotalMs: 0,
    sendLatencyCount: 0,
    maxSendLatencyMs: 0,
    sendFailures: 0
  };

  constructor(config: RelayConfig) {
    this.config = config;
    const tlsEnabled = Boolean(config.tlsCertFile && config.tlsKeyFile);
    if (config.externalMode && !tlsEnabled) {
      throw new Error(
        'LANTERN_RELAY_EXTERNAL=1 exige LANTERN_RELAY_TLS_CERT e LANTERN_RELAY_TLS_KEY.'
      );
    }
    const requestHandler = (req: IncomingMessage, res: ServerResponse) => {
      void this.handleHttpRequest(req, res).catch((error) => {
        logRelay('http_handler_failed', {
          path: req.url || '/',
          message: error instanceof Error ? error.message : String(error)
        }, { level: 'warn' });
        if (!res.headersSent) {
          this.writeJson(res, req.method || 'GET', { ok: false, error: 'INTERNAL_ERROR' }, 500);
        } else {
          res.end();
        }
      });
    };
    this.httpServer = tlsEnabled
      ? createHttpsServer(
          {
            cert: fs.readFileSync(config.tlsCertFile!),
            key: fs.readFileSync(config.tlsKeyFile!),
            minVersion: 'TLSv1.2'
          },
          requestHandler
        )
      : createServer(requestHandler);
    this.wsServer = new WebSocketServer({
      server: this.httpServer,
      maxPayload: this.config.maxPayloadBytes
    });
    this.centralStore = new CentralStore(path.join(resolveRelayDataDir(), 'central'), logRelay);
    this.groupStore = new GroupStore(
      GROUP_STORE_FILE,
      GROUP_ATTACHMENTS_DIR,
      logRelay,
      this.centralStore.getEncryption()
    );
    this.wsServer.on('connection', (socket) => this.handleConnection(socket));
    this.ensureStickerDirectory();
    this.loadAnnouncementStore();
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.config.port, this.config.host, () => {
        this.httpServer.off('error', reject);
        resolve();
      });
    });

    this.startBonjour();
    this.startUdpDiscoveryResponder();
    this.startHeartbeatLoop();
    this.startPresenceBroadcastLoop();
    this.startAnnouncementSweepLoop();
    this.startGroupSweepLoop();

    logRelay('started', {
      endpoint: `${this.config.tlsCertFile ? 'wss' : 'ws'}://${this.config.host}:${this.config.port}`,
      version: RELAY_VERSION,
      mode: this.config.externalMode ? 'external' : 'local',
      tls: Boolean(this.config.tlsCertFile),
      announcementStoreFile: ANNOUNCEMENT_STORE_FILE,
      groupStoreFile: this.groupStore.getStoreFile(),
      groupAttachmentsDir: this.groupStore.getAttachmentsDir(),
      stickersDir: RELAY_STICKERS_DIR,
      stickersAvailable: this.listStickerCatalog().length,
      centralStore: this.centralStore.getStats()
    });
  }

  async stop(reason = 'shutdown'): Promise<void> {
    if (this.announcementPersistTimer) {
      clearTimeout(this.announcementPersistTimer);
      this.announcementPersistTimer = null;
    }
    this.persistAnnouncementStore();

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.presenceBroadcastTimer) {
      clearInterval(this.presenceBroadcastTimer);
      this.presenceBroadcastTimer = null;
    }
    if (this.announcementSweepTimer) {
      clearInterval(this.announcementSweepTimer);
      this.announcementSweepTimer = null;
    }
    if (this.groupSweepTimer) {
      clearInterval(this.groupSweepTimer);
      this.groupSweepTimer = null;
    }
    this.groupStore.close();
    this.centralStore.close();
    if (this.udpSocket) {
      try {
        this.udpSocket.close();
      } catch {
        // ignore
      }
      this.udpSocket = null;
    }

    for (const session of this.sessionsBySocket.values()) {
      try {
        session.socket.close(1001, reason);
      } catch {
        // ignore
      }
    }

    this.sessionsBySocket.clear();
    this.sessionsByDeviceId.clear();
    this.announcementsById.clear();

    await new Promise<void>((resolve) => {
      this.wsServer.close(() => resolve());
    });

    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve());
    });

    if (this.published) {
      try {
        this.published.stop?.();
      } catch {
        // ignore
      }
      this.published = null;
    }

    if (this.bonjour) {
      try {
        this.bonjour.destroy();
      } catch {
        // ignore
      }
      this.bonjour = null;
    }
  }

  private startBonjour(): void {
    try {
      this.bonjour = new BonjourService();
      this.published = this.bonjour.publish({
        name: `LanternRelay-${process.pid}`,
        type: RELAY_MDNS_TYPE,
        protocol: RELAY_MDNS_PROTOCOL,
        port: this.config.port,
        txt: {
          app: 'LanternRelay',
          version: RELAY_VERSION,
          port: String(this.config.port)
        }
      });
      this.published.on('error', (error: unknown) => {
        console.warn('[LanternRelay] aviso mDNS:', error);
      });
    } catch (error) {
      console.warn('[LanternRelay] mDNS indisponível, seguindo sem anúncio:', error);
    }
  }

  private startUdpDiscoveryResponder(): void {
    if (this.udpSocket) return;

    try {
      const socket = createSocket('udp4');
      this.udpSocket = socket;

      socket.on('error', (error) => {
        console.warn('[LanternRelay] aviso UDP discovery:', error);
        if (this.udpSocket === socket) {
          try {
            socket.close();
          } catch {
            // ignore
          }
          this.udpSocket = null;
        }
      });

      socket.on('message', (raw, remote) => this.handleUdpDiscoveryMessage(raw, remote));

      socket.bind(this.config.port, this.config.host, () => {
        try {
          socket.setBroadcast(true);
        } catch {
          // nem todo ambiente permite broadcast explicitamente
        }
        logRelay('udp_discovery_ready', {
          endpoint: `udp://${this.config.host}:${this.config.port}`
        });
      });
    } catch (error) {
      console.warn('[LanternRelay] UDP discovery indisponível:', error);
      this.udpSocket = null;
    }
  }

  private handleUdpDiscoveryMessage(raw: Buffer, remote: RemoteInfo): void {
    const socket = this.udpSocket;
    if (!socket) return;

    let message: JsonRecord | null = null;
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as unknown;
      message = asRecord(parsed);
    } catch {
      return;
    }

    if (message?.type !== RELAY_DISCOVERY_UDP_QUERY) {
      return;
    }

    const response = Buffer.from(
      JSON.stringify({
        type: RELAY_DISCOVERY_UDP_RESPONSE,
        version: RELAY_VERSION,
        port: this.config.port,
        secure: Boolean(this.config.tlsCertFile),
        serverTime: Date.now()
      })
    );

    socket.send(response, remote.port, remote.address, (error) => {
      if (!error) return;
      logRelay('udp_discovery_reply_failed', {
        remoteAddress: remote.address,
        remotePort: remote.port,
        message: error.message
      });
    });
  }

  private startHeartbeatLoop(): void {
    if (this.pingTimer) return;

    this.pingTimer = setInterval(() => {
      const now = Date.now();
      for (const session of Array.from(this.sessionsBySocket.values())) {
        const isStale = now - session.lastSeenAt > this.config.peerTimeoutMs;
        if (!session.isAlive || isStale) {
          this.dropSession(session, 'timeout');
          continue;
        }
        session.isAlive = false;
        try {
          session.socket.ping();
        } catch {
          this.dropSession(session, 'ping-failed');
        }
      }
    }, this.config.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private startPresenceBroadcastLoop(): void {
    if (this.presenceBroadcastTimer) return;
    this.presenceBroadcastTimer = setInterval(() => {
      this.broadcastPresence('periodic');
    }, this.config.presenceBroadcastIntervalMs);
    this.presenceBroadcastTimer.unref?.();
  }

  private startAnnouncementSweepLoop(): void {
    if (this.announcementSweepTimer) return;
    this.announcementSweepTimer = setInterval(() => {
      this.sweepAnnouncements('periodic');
    }, ANNOUNCEMENT_SWEEP_INTERVAL_MS);
    this.announcementSweepTimer.unref?.();
  }

  private startGroupSweepLoop(): void {
    if (this.groupSweepTimer) return;
    this.groupSweepTimer = setInterval(() => {
      const result = this.groupStore.sweepAttachments(this.centralStore.getRetentionCutoff());
      if (result.expired || result.completed || result.staleUploads) {
        logRelay('group_attachment_sweep', result, { level: 'info' });
      }
      const centralResult = this.centralStore.sweepRetention();
      if (centralResult.framesDeleted || centralResult.attachmentsDeleted) {
        logRelay('central_retention_sweep', centralResult, { level: 'info' });
      }
    }, GROUP_SWEEP_INTERVAL_MS);
    this.groupSweepTimer.unref?.();
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method || 'GET';
    if (!['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
      res.writeHead(405, {
        'content-type': 'application/json; charset=utf-8',
        allow: 'GET, HEAD, POST, PATCH, PUT, DELETE'
      });
      res.end(JSON.stringify({ ok: false, error: 'METHOD_NOT_ALLOWED' }));
      return;
    }

    let requestUrl: URL;
    try {
      requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    } catch {
      this.writeJson(res, method, {
        ok: false,
        error: 'BAD_REQUEST',
        message: 'URL inválida.'
      }, 400);
      return;
    }

    if (requestUrl.pathname === '/health') {
      this.writeJson(res, method, {
        ok: true,
        version: RELAY_VERSION,
        startedAt: this.startedAt,
        uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
        peersOnline: this.sessionsByDeviceId.size
      });
      return;
    }

    if (requestUrl.pathname === '/api/client/login' && method === 'POST') {
      if (!this.isClientTransportAllowed(req)) {
        this.writeJson(res, method, {
          ok: false,
          error: 'TLS_REQUIRED',
          message: 'Conexões externas exigem HTTPS/WSS.'
        }, 426);
        return;
      }
      const remoteAddress = this.normalizeRemoteAddress(req.socket.remoteAddress || 'unknown');
      const attempt = this.loginAttemptsByAddress.get(remoteAddress);
      if (attempt && attempt.blockedUntil > Date.now()) {
        this.writeJson(res, method, { ok: false, error: 'TOO_MANY_ATTEMPTS' }, 429);
        return;
      }
      const body = await this.readJsonBody(req);
      try {
        const auth = this.centralStore.login(
          asString(body.username) || '',
          typeof body.password === 'string' ? body.password : '',
          asString(body.deviceId) || randomUUID()
        );
        this.loginAttemptsByAddress.delete(remoteAddress);
        this.writeJson(res, method, { ok: true, ...auth });
      } catch (error) {
        const failures = (attempt?.failures || 0) + 1;
        this.loginAttemptsByAddress.set(remoteAddress, {
          failures,
          blockedUntil: failures >= 5 ? Date.now() + 60_000 : 0
        });
        this.writeJson(res, method, {
          ok: false,
          error: 'INVALID_CREDENTIALS',
          message: error instanceof Error ? error.message : String(error)
        }, 401);
      }
      return;
    }

    if (requestUrl.pathname === '/api/client/register' && method === 'POST') {
      if (!this.isClientTransportAllowed(req)) {
        this.writeJson(res, method, {
          ok: false,
          error: 'TLS_REQUIRED',
          message: 'Conexões externas exigem HTTPS/WSS.'
        }, 426);
        return;
      }
      const remoteAddress = this.normalizeRemoteAddress(req.socket.remoteAddress || 'unknown');
      const attempt = this.loginAttemptsByAddress.get(`register:${remoteAddress}`);
      if (attempt && attempt.blockedUntil > Date.now()) {
        this.writeJson(res, method, { ok: false, error: 'TOO_MANY_ATTEMPTS' }, 429);
        return;
      }
      const body = await this.readJsonBody(req);
      try {
        const user = this.centralStore.createUser({
          username: asString(body.username) || '',
          displayName: asString(body.displayName) || asString(body.username) || '',
          password: typeof body.password === 'string' ? body.password : '',
          role: 'user',
          locale: body.locale === 'en' || body.locale === 'es' ? body.locale : 'pt-BR'
        });
        this.loginAttemptsByAddress.delete(`register:${remoteAddress}`);
        logRelay('client_account_created', {
          userId: user.userId,
          username: user.username,
          remoteAddress
        });
        this.writeJson(res, method, { ok: true, user }, 201);
      } catch (error) {
        const failures = (attempt?.failures || 0) + 1;
        this.loginAttemptsByAddress.set(`register:${remoteAddress}`, {
          failures,
          blockedUntil: failures >= 5 ? Date.now() + 60_000 : 0
        });
        const message = error instanceof Error ? error.message : String(error);
        const conflict = /UNIQUE|já existe|constraint/i.test(message);
        this.writeJson(res, method, {
          ok: false,
          error: conflict ? 'USERNAME_TAKEN' : 'INVALID_ACCOUNT',
          message: conflict ? 'Este nome de usuário já está em uso.' : message
        }, conflict ? 409 : 400);
      }
      return;
    }

    if (requestUrl.pathname === '/api/client/session' && method === 'GET') {
      const token = this.getBearerToken(req);
      const user = token ? this.centralStore.authenticate(token) : null;
      this.writeJson(res, method, user ? { ok: true, user } : { ok: false, error: 'UNAUTHORIZED' }, user ? 200 : 401);
      return;
    }

    if (requestUrl.pathname === '/api/client/logout' && method === 'POST') {
      const token = this.getBearerToken(req);
      if (token) this.centralStore.logout(token);
      this.writeJson(res, method, { ok: true });
      return;
    }

    const isDashboardRoute =
      requestUrl.pathname === '/' ||
      requestUrl.pathname.startsWith('/dashboard') ||
      requestUrl.pathname.startsWith('/api/status') ||
      requestUrl.pathname.startsWith('/api/admin/');
    if (isDashboardRoute && !this.isLoopbackRequest(req)) {
      this.writeJson(res, method, {
        ok: false,
        error: 'LOCALHOST_ONLY',
        message: 'A administração do Relay só pode ser acessada no próprio servidor.'
      }, 403);
      return;
    }

    if (requestUrl.pathname === '/api/admin/login' && method === 'POST') {
      const body = await this.readJsonBody(req);
      try {
        const session = this.centralStore.createAdminSession(
          asString(body.username) || '',
          typeof body.password === 'string' ? body.password : ''
        );
        res.setHeader(
          'set-cookie',
          `lantern_admin=${encodeURIComponent(session.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${this.isTlsRequest(req) ? '; Secure' : ''}`
        );
        this.writeJson(res, method, { ok: true, csrfToken: session.csrfToken });
      } catch (error) {
        this.writeJson(res, method, {
          ok: false,
          error: 'UNAUTHORIZED',
          message: error instanceof Error ? error.message : String(error)
        }, 401);
      }
      return;
    }

    if (requestUrl.pathname.startsWith('/api/admin/')) {
      const adminToken = this.getCookie(req, 'lantern_admin');
      const needsCsrf = method !== 'GET' && method !== 'HEAD';
      const csrfToken = needsCsrf ? String(req.headers['x-lantern-csrf'] || '') : undefined;
      if (!this.centralStore.validateAdminSession(adminToken, csrfToken)) {
        this.writeJson(res, method, { ok: false, error: 'UNAUTHORIZED' }, 401);
        return;
      }

      if (requestUrl.pathname === '/api/admin/users' && method === 'GET') {
        this.writeJson(res, method, { ok: true, users: this.centralStore.listUsers() });
        return;
      }
      if (requestUrl.pathname === '/api/admin/users' && method === 'POST') {
        const body = await this.readJsonBody(req);
        try {
          const user = this.centralStore.createUser({
            username: asString(body.username) || '',
            displayName: asString(body.displayName) || '',
            department: asString(body.department) || '',
            password: typeof body.password === 'string' ? body.password : '',
            role: body.role === 'admin' ? 'admin' : 'user',
            locale: body.locale === 'en' || body.locale === 'es' ? body.locale : 'pt-BR'
          });
          this.writeJson(res, method, { ok: true, user }, 201);
        } catch (error) {
          this.writeJson(res, method, { ok: false, error: 'INVALID_USER', message: error instanceof Error ? error.message : String(error) }, 400);
        }
        return;
      }
      const userMatch = requestUrl.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (userMatch && method === 'PATCH') {
        const body = await this.readJsonBody(req);
        try {
          const user = this.centralStore.updateUser(decodeURIComponent(userMatch[1]), {
            displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
            department: typeof body.department === 'string' ? body.department : undefined,
            disabled: typeof body.disabled === 'boolean' ? body.disabled : undefined,
            locale: body.locale === 'en' || body.locale === 'es' || body.locale === 'pt-BR' ? body.locale : undefined
          });
          this.writeJson(res, method, { ok: true, user });
        } catch (error) {
          this.writeJson(res, method, { ok: false, error: 'UPDATE_FAILED', message: error instanceof Error ? error.message : String(error) }, 400);
        }
        return;
      }
      if (userMatch && method === 'DELETE') {
        try {
          this.centralStore.deleteUser(decodeURIComponent(userMatch[1]));
          this.writeJson(res, method, { ok: true });
        } catch (error) {
          this.writeJson(res, method, { ok: false, error: 'DELETE_FAILED', message: error instanceof Error ? error.message : String(error) }, 400);
        }
        return;
      }
      const resetMatch = requestUrl.pathname.match(/^\/api\/admin\/users\/([^/]+)\/password$/);
      if (resetMatch && method === 'POST') {
        const body = await this.readJsonBody(req);
        try {
          this.centralStore.resetPassword(
            decodeURIComponent(resetMatch[1]),
            typeof body.password === 'string' ? body.password : ''
          );
          this.writeJson(res, method, { ok: true });
        } catch (error) {
          this.writeJson(res, method, { ok: false, error: 'RESET_FAILED', message: error instanceof Error ? error.message : String(error) }, 400);
        }
        return;
      }
      if (requestUrl.pathname === '/api/admin/retention' && method === 'GET') {
        this.writeJson(res, method, { ok: true, policy: this.centralStore.getRetentionPolicy() });
        return;
      }
      if (requestUrl.pathname === '/api/admin/retention' && method === 'PUT') {
        const body = await this.readJsonBody(req);
        const policy = this.centralStore.setRetentionPolicy(body.policy as RetentionPolicy);
        this.writeJson(res, method, { ok: true, policy });
        return;
      }
    }

    if (requestUrl.pathname === '/api/status') {
      if (!this.isDashboardAuthorized(requestUrl)) {
        this.writeJson(res, method, {
          ok: false,
          error: 'UNAUTHORIZED',
          message: 'Informe o token do painel do Relay.'
        }, 401);
        return;
      }
      this.writeJson(res, method, this.getDashboardSnapshot());
      return;
    }

    if (requestUrl.pathname === '/stickers') {
      this.writeJson(res, method, {
        ok: true,
        stickers: this.listStickerCatalog()
      });
      return;
    }

    if (requestUrl.pathname.startsWith('/stickers/')) {
      this.serveStickerFile(requestUrl.pathname, method, res);
      return;
    }

    if (
      requestUrl.pathname === '/' ||
      requestUrl.pathname === '/dashboard' ||
      requestUrl.pathname === '/dashboard/'
    ) {
      if (!this.isDashboardAuthorized(requestUrl)) {
        this.writeJson(res, method, {
          ok: false,
          error: 'UNAUTHORIZED',
          message: 'Informe o token do painel do Relay.'
        }, 401);
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(method === 'HEAD' ? undefined : RELAY_DASHBOARD_HTML);
      return;
    }

    if (requestUrl.pathname === '/favicon.ico') {
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }

    this.writeJson(res, method, {
      ok: false,
      error: 'NOT_FOUND',
      message: 'Rota não encontrada.'
    }, 404);
  }

  private async readJsonBody(req: IncomingMessage): Promise<JsonRecord> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const raw of req) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error('Corpo da requisição excede 1 MB.');
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return asRecord(parsed) || {};
  }

  private normalizeRemoteAddress(value: string): string {
    return value.replace(/^::ffff:/, '');
  }

  private isLoopbackRequest(req: IncomingMessage): boolean {
    const address = this.normalizeRemoteAddress(req.socket.remoteAddress || '');
    return address === '127.0.0.1' || address === '::1' || address === 'localhost';
  }

  private isTlsRequest(req: IncomingMessage): boolean {
    return Boolean((req.socket as TLSSocket).encrypted);
  }

  private isClientTransportAllowed(req: IncomingMessage): boolean {
    if (this.isTlsRequest(req) || this.isLoopbackRequest(req)) return true;
    const address = this.normalizeRemoteAddress(req.socket.remoteAddress || '');
    const privateAddress =
      /^10\./.test(address) ||
      /^192\.168\./.test(address) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
      /^fd[0-9a-f]{2}:/i.test(address) ||
      /^fe80:/i.test(address);
    return !this.config.externalMode && privateAddress;
  }

  private getBearerToken(req: IncomingMessage): string {
    const authorization = String(req.headers.authorization || '');
    return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  }

  private getCookie(req: IncomingMessage, name: string): string {
    const cookies = String(req.headers.cookie || '').split(';');
    for (const cookie of cookies) {
      const [key, ...rest] = cookie.trim().split('=');
      if (key === name) return decodeURIComponent(rest.join('='));
    }
    return '';
  }

  private isDashboardAuthorized(requestUrl: URL): boolean {
    return !RELAY_DASHBOARD_TOKEN || requestUrl.searchParams.get('token') === RELAY_DASHBOARD_TOKEN;
  }

  private ensureStickerDirectory(): void {
    const targetDir = path.join(RELAY_STICKERS_DIR, 'cats');
    fs.mkdirSync(targetDir, { recursive: true });
    const existing = fs
      .readdirSync(targetDir)
      .filter((name) => RELAY_STICKER_FILE_NAME_RE.test(name));
    if (existing.length > 0) {
      return;
    }

    const seedDirs = [
      path.join(process.cwd(), 'assets', 'stickers', 'cats'),
      path.join(__dirname, '..', 'assets', 'stickers', 'cats'),
      path.join(resolveRelayDataDir(), 'assets', 'stickers', 'cats'),
      path.join(path.dirname(process.execPath), 'assets', 'stickers', 'cats')
    ];

    let copied = 0;
    for (const seedDir of seedDirs) {
      if (!fs.existsSync(seedDir)) continue;
      const names = fs
        .readdirSync(seedDir)
        .filter((name) => RELAY_STICKER_FILE_NAME_RE.test(name));
      for (const name of names) {
        try {
          fs.copyFileSync(path.join(seedDir, name), path.join(targetDir, name));
          copied += 1;
        } catch {
          // continua copiando os demais arquivos
        }
      }
      if (copied > 0) break;
    }

    logRelay('stickers_ready', {
      directory: targetDir,
      copied,
      available: this.listStickerCatalog().length
    });
  }

  private listStickerCatalog(): RelayStickerItem[] {
    try {
      fs.mkdirSync(RELAY_STICKERS_DIR, { recursive: true });
      const catalog: RelayStickerItem[] = [];
      const addSticker = (category: string, relativePath: string, filePath: string, fileName: string): void => {
        const stat = fs.statSync(filePath);
        if (!this.isValidStickerFile(filePath, stat.size)) return;

        const label = fileName
          .replace(/\.gif$/i, '')
          .replace(/^lantern-cat-sticker-/i, '')
          .replace(/^lantern-sticker-/i, '')
          .replace(/[-_]+/g, ' ')
          .replace(/\b\w/g, (letter) => letter.toUpperCase());
        catalog.push({
          id: relativePath,
          label,
          fileName,
          relativePath,
          size: stat.size,
          category,
          updatedAt: Math.max(0, Math.trunc(stat.mtimeMs))
        });
      };

      // GIFs diretamente em stickers/ são válidos e entram na categoria Geral.
      // As subpastas continuam sendo categorias opcionais para organização.
      const rootFiles = fs
        .readdirSync(RELAY_STICKERS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isFile() && RELAY_STICKER_FILE_NAME_RE.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name, 'pt-BR', { sensitivity: 'base' }));
      for (const entry of rootFiles) {
        addSticker('geral', entry.name, path.join(RELAY_STICKERS_DIR, entry.name), entry.name);
      }

      const categoryEntries = fs
        .readdirSync(RELAY_STICKERS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && RELAY_STICKER_CATEGORY_RE.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name, 'pt-BR', { sensitivity: 'base' }));

      for (const categoryEntry of categoryEntries) {
        const category = categoryEntry.name;
        const categoryDir = path.join(RELAY_STICKERS_DIR, category);
        const fileEntries = fs
          .readdirSync(categoryDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && RELAY_STICKER_FILE_NAME_RE.test(entry.name))
          .sort((left, right) => left.name.localeCompare(right.name, 'pt-BR', { sensitivity: 'base' }));

        for (const entry of fileEntries) {
          const filePath = path.join(categoryDir, entry.name);
          const relativePath = `${category}/${entry.name}`;
          addSticker(category, relativePath, filePath, entry.name);
        }
      }

      return catalog;
    } catch {
      return [];
    }
  }

  private isValidStickerFile(filePath: string, size: number): boolean {
    if (!Number.isFinite(size) || size <= 0 || size > RELAY_STICKER_MAX_BYTES) {
      return false;
    }
    let descriptor: number | null = null;
    try {
      descriptor = fs.openSync(filePath, 'r');
      const header = Buffer.alloc(6);
      const read = fs.readSync(descriptor, header, 0, header.length, 0);
      const signature = header.subarray(0, read).toString('ascii');
      return signature === 'GIF87a' || signature === 'GIF89a';
    } catch {
      return false;
    } finally {
      if (descriptor !== null) {
        try {
          fs.closeSync(descriptor);
        } catch {
          // ignore close failure
        }
      }
    }
  }

  private serveStickerFile(pathname: string, method: string, res: ServerResponse): void {
    const rawRelativePath = pathname.slice('/stickers/'.length);
    let relativePath = '';
    try {
      relativePath = normalizeStickerRelativePath(decodeURIComponent(rawRelativePath)) || '';
    } catch {
      relativePath = '';
    }
    if (!relativePath) {
      this.writeJson(res, method, {
        ok: false,
        error: 'BAD_STICKER',
        message: 'GIF inválida.'
      }, 400);
      return;
    }
    const filePath = path.join(RELAY_STICKERS_DIR, ...relativePath.split('/'));
    if (!fs.existsSync(filePath)) {
      this.writeJson(res, method, {
        ok: false,
        error: 'STICKER_NOT_FOUND',
        message: 'GIF não encontrada no Relay.'
      }, 404);
      return;
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || !this.isValidStickerFile(filePath, stat.size)) {
      this.writeJson(res, method, {
        ok: false,
        error: 'BAD_STICKER',
        message: 'GIF inválida.'
      }, 400);
      return;
    }
    res.writeHead(200, {
      'content-type': 'image/gif',
      'content-length': String(stat.size),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  }

  private writeJson(
    res: ServerResponse,
    method: string,
    body: unknown,
    statusCode = 200
  ): void {
    const json = JSON.stringify(body);
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end(method === 'HEAD' ? undefined : json);
  }

  private getDashboardSnapshot(): RelayDashboardSnapshot {
    this.sweepAnnouncements('dashboard_snapshot');
    const now = Date.now();
    const peers = this.listDashboardPeers(now);
    const announcements = this.listDashboardAnnouncements(peers, now);
    const attachmentStats = this.groupStore.getAttachmentStats();
    const averageSendLatencyMs =
      this.transferMetrics.sendLatencyCount > 0
        ? this.transferMetrics.sendLatencyTotalMs / this.transferMetrics.sendLatencyCount
        : 0;

    return {
      ok: true,
      version: RELAY_VERSION,
      now,
      startedAt: this.startedAt,
      uptimeMs: Math.max(0, now - this.startedAt),
      host: this.config.host,
      port: this.config.port,
      peersOnline: peers.length,
      sessionsOpen: this.sessionsBySocket.size,
      presenceRevision: this.presenceRevision,
      announcementStoreFile: ANNOUNCEMENT_STORE_FILE,
      announcementsActive: announcements.length,
      stickersAvailable: this.listStickerCatalog().length,
      centralStore: this.centralStore.getStats(),
      transferMetrics: {
        uploadAttempts: this.transferMetrics.uploadAttempts,
        uploadsCompleted: this.transferMetrics.uploadsCompleted,
        uploadsFailed: this.transferMetrics.uploadsFailed,
        downloadAttempts: this.transferMetrics.downloadAttempts,
        downloadsResumed: this.transferMetrics.downloadsResumed,
        downloadsCompleted: this.transferMetrics.downloadsCompleted,
        downloadsFailed: this.transferMetrics.downloadsFailed,
        bytesUploaded: this.transferMetrics.bytesUploaded,
        bytesDownloaded: this.transferMetrics.bytesDownloaded,
        retainedFiles: attachmentStats.retainedCount,
        retainedBytes: attachmentStats.retainedBytes,
        activeUploads: attachmentStats.activeUploads,
        pendingRecipients: attachmentStats.pendingRecipients,
        averageSendLatencyMs,
        maxSendLatencyMs: this.transferMetrics.maxSendLatencyMs,
        sendFailures: this.transferMetrics.sendFailures
      },
      peers,
      announcements
    };
  }

  private listDashboardPeers(now: number): RelayDashboardPeer[] {
    const peers: RelayDashboardPeer[] = [];
    for (const session of this.sessionsByDeviceId.values()) {
      const peer = session.peer;
      if (!peer) continue;
      const lastSeenAt = Math.max(peer.lastSeenAt || 0, session.lastSeenAt || 0);
      peers.push({
        deviceId: peer.deviceId,
        deviceShort: peer.deviceId.slice(0, 8),
        displayName: peer.displayName,
        avatarEmoji: peer.avatarEmoji,
        avatarBg: peer.avatarBg,
        statusMessage: peer.statusMessage || 'Disponível',
        appVersion: peer.appVersion || 'unknown',
        connectedAt: peer.connectedAt,
        lastSeenAt,
        onlineForMs: Math.max(0, now - peer.connectedAt),
        lastSeenAgoMs: Math.max(0, now - lastSeenAt)
      });
    }
    return peers.sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'));
  }

  private listDashboardAnnouncements(
    peers: RelayDashboardPeer[],
    now: number
  ): RelayDashboardAnnouncement[] {
    const peersById = new Map(peers.map((peer) => [peer.deviceId, peer]));
    return Array.from(this.announcementsById.values())
      .filter((state) => !state.deletedAt && !state.expiredAt && state.expiresAt > now)
      .map((state) => {
        const payload = asRecord(state.frame.payload);
        const text = asString(payload?.text) || asString(payload?.bodyText) || '(sem texto)';
        const author = peersById.get(state.frame.from);
        const reactionsCount = Object.entries(state.reactionsByDeviceId || {}).filter((entry) =>
          ALLOWED_ANNOUNCEMENT_REACTIONS.has(entry[1])
        ).length;
        const readsCount = Object.entries(state.readByDeviceId || {}).filter(
          ([deviceId, readAt]) => deviceId.trim().length > 0 && Number.isFinite(readAt) && readAt > 0
        ).length;

        return {
          messageId: state.messageId,
          messageShort: state.messageId.slice(0, 8),
          authorDeviceId: state.frame.from,
          authorName: author?.displayName || `Usuário ${state.frame.from.slice(0, 8)}`,
          authorAvatarEmoji: author?.avatarEmoji || '✦',
          authorAvatarBg: author?.avatarBg || '#147ad6',
          text,
          createdAt: state.createdAt,
          expiresAt: state.expiresAt,
          expiresInMs: Math.max(0, state.expiresAt - now),
          reactionsCount,
          readsCount
        };
      })
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
        return a.messageId.localeCompare(b.messageId);
      });
  }

  private handleConnection(socket: WebSocket): void {
    const session: RelaySession = {
      sessionId: randomUUID(),
      socket,
      peer: null,
      lastSeenAt: Date.now(),
      isAlive: true,
      messageQueue: Promise.resolve(),
      groupFileDownloadQueue: Promise.resolve(),
      authToken: null
    };

    this.sessionsBySocket.set(socket, session);

    const remoteAddress =
      (socket as unknown as { _socket?: { remoteAddress?: string; remotePort?: number } })._socket
        ?.remoteAddress || 'unknown';
    const remotePort =
      (socket as unknown as { _socket?: { remoteAddress?: string; remotePort?: number } })._socket
        ?.remotePort || 0;
    logRelay('socket_connected', {
      sessionId: session.sessionId,
      remoteAddress,
      remotePort
    });

    socket.on('pong', () => {
      session.isAlive = true;
      session.lastSeenAt = Date.now();
    });

    socket.on('message', (raw) => {
      session.messageQueue = session.messageQueue
        .catch(() => undefined)
        .then(() => this.handleMessage(session, raw))
        .catch((error) => {
        logRelay(
          'message_handler_failed',
          {
            sessionId: session.sessionId,
            deviceId: session.peer?.deviceId || null,
            message: error instanceof Error ? error.message : String(error)
          },
          { level: 'warn', rateKey: `message_handler_failed:${session.sessionId}`, rateLimitMs: 1_000 }
        );
      });
    });

    socket.on('close', () => {
      this.dropSession(session, 'socket-close');
    });

    socket.on('error', (error) => {
      logRelay('socket_error', {
        sessionId: session.sessionId,
        message: error?.message || 'socket error'
      }, { level: 'warn' });
      this.dropSession(session, 'socket-error');
    });

    this.sendEnvelope(socket, {
      type: 'relay:welcome',
      payload: {
        serverVersion: RELAY_VERSION,
        heartbeatIntervalMs: this.config.pingIntervalMs,
        peerTimeoutMs: this.config.peerTimeoutMs,
        serverTime: Date.now()
      }
    });
  }

  private async handleMessage(session: RelaySession, raw: RawData): Promise<void> {
    const data = (() => {
      if (typeof raw === 'string') return raw;
      if (Buffer.isBuffer(raw)) return raw.toString('utf8');
      return raw.toString();
    })();

    let envelope: RelayEnvelope | null = null;
    try {
      const parsed = JSON.parse(data) as unknown;
      const record = asRecord(parsed);
      if (record && typeof record.type === 'string') {
        envelope = {
          type: record.type,
          payload: record.payload
        };
      }
    } catch {
      // JSON inválido
    }

    if (!envelope) {
      this.sendError(session, 'BAD_JSON', 'Frame inválido.');
      return;
    }

    session.lastSeenAt = Date.now();
    session.isAlive = true;

    switch (envelope.type) {
      case 'relay:hello':
        this.handleHello(session, envelope.payload);
        return;
      case 'relay:updateProfile':
        this.handleUpdateProfile(session, envelope.payload);
        return;
      case 'relay:heartbeat':
        this.sendEnvelope(session.socket, {
          type: 'relay:pong',
          payload: { serverTime: Date.now() }
        });
        return;
      case 'relay:presence:request':
        if (session.peer) {
          logRelay('presence_requested', {
            from: session.peer.deviceId,
            displayName: session.peer.displayName
          }, { level: 'debug', rateKey: `presence_requested:${session.peer.deviceId}`, rateLimitMs: 4_000 });
        }
        this.sendPresenceSnapshot(session);
        this.sendAnnouncementSnapshot(session, 'presence_request');
        return;
      case 'relay:announcement:read':
        this.handleAnnouncementRead(session, envelope.payload);
        return;
      case 'relay:groups:sync':
        this.handleGroupSyncRequest(session, envelope.payload);
        return;
      case 'relay:group:request':
        await this.handleGroupRequest(session, envelope.payload);
        return;
      case 'relay:group:file:chunk':
        await this.handleGroupFileChunk(session, envelope.payload);
        return;
      case 'relay:group:file:complete':
        await this.handleGroupFileComplete(session, envelope.payload);
        return;
      case 'relay:group:file:request':
        session.groupFileDownloadQueue = session.groupFileDownloadQueue
          .catch(() => undefined)
          .then(() => this.handleGroupFileRequest(session, envelope.payload))
          .catch((error) => {
            logRelay(
              'group_file_download_queue_failed',
              {
                sessionId: session.sessionId,
                deviceId: session.peer?.deviceId || null,
                message: error instanceof Error ? error.message : String(error)
              },
              { level: 'warn', rateKey: `group_file_download_queue_failed:${session.sessionId}`, rateLimitMs: 1_000 }
            );
          });
        return;
      case 'relay:group:file:received':
        this.handleGroupFileReceived(session, envelope.payload);
        return;
      case 'relay:attachment:init':
        this.handleCentralAttachmentInit(session, envelope.payload);
        return;
      case 'relay:attachment:chunk':
        this.handleCentralAttachmentChunk(session, envelope.payload);
        return;
      case 'relay:attachment:complete':
        this.handleCentralAttachmentComplete(session, envelope.payload);
        return;
      case 'relay:attachment:request':
        this.handleCentralAttachmentRequest(session, envelope.payload);
        return;
      case 'relay:send':
        await this.handleRelaySend(session, envelope.payload);
        return;
      default:
        this.sendError(session, 'UNKNOWN_TYPE', `Tipo não suportado: ${envelope.type}`);
    }
  }

  private handleCentralAttachmentInit(session: RelaySession, payload: unknown): void {
    if (!session.peer) {
      this.sendError(session, 'NOT_AUTHENTICATED', 'Autenticação necessária.');
      return;
    }
    const record = asRecord(payload);
    const requestId = asString(record?.requestId);
    try {
      const result = this.centralStore.initAttachment({
        attachmentId: asString(record?.attachmentId) || '',
        messageId: asString(record?.messageId) || '',
        ownerUserId: session.peer.deviceId,
        conversationId: asString(record?.conversationId) || '',
        fileName: asString(record?.fileName) || 'arquivo',
        mimeType: asString(record?.mimeType) || 'application/octet-stream',
        size: Math.max(0, Math.trunc(asFiniteNumber(record?.size) || 0)),
        sha256: asString(record?.sha256) || ''
      });
      this.sendEnvelope(session.socket, {
        type: 'relay:attachment:ack',
        payload: { requestId, action: 'init', ...result }
      });
    } catch (error) {
      this.sendEnvelope(session.socket, {
        type: 'relay:attachment:error',
        payload: { requestId, message: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  private handleCentralAttachmentChunk(session: RelaySession, payload: unknown): void {
    if (!session.peer) return;
    const record = asRecord(payload);
    const requestId = asString(record?.requestId);
    try {
      const attachmentId = asString(record?.attachmentId) || '';
      const index = Math.trunc(asFiniteNumber(record?.index) || 0);
      const data = Buffer.from(typeof record?.dataBase64 === 'string' ? record.dataBase64 : '', 'base64');
      this.centralStore.appendAttachmentChunk(attachmentId, session.peer.deviceId, index, data);
      this.sendEnvelope(session.socket, {
        type: 'relay:attachment:ack',
        payload: { requestId, action: 'chunk', attachmentId, index }
      });
    } catch (error) {
      this.sendEnvelope(session.socket, {
        type: 'relay:attachment:error',
        payload: { requestId, message: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  private handleCentralAttachmentComplete(session: RelaySession, payload: unknown): void {
    if (!session.peer) return;
    const record = asRecord(payload);
    const requestId = asString(record?.requestId);
    try {
      const attachmentId = asString(record?.attachmentId) || '';
      this.centralStore.completeAttachment(attachmentId, session.peer.deviceId);
      this.sendEnvelope(session.socket, {
        type: 'relay:attachment:ack',
        payload: { requestId, action: 'complete', attachmentId }
      });
    } catch (error) {
      this.sendEnvelope(session.socket, {
        type: 'relay:attachment:error',
        payload: { requestId, message: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  private handleCentralAttachmentRequest(session: RelaySession, payload: unknown): void {
    if (!session.peer) return;
    const record = asRecord(payload);
    const requestId = asString(record?.requestId) || randomUUID();
    const attachmentId = asString(record?.attachmentId) || '';
    const startIndex = Math.max(0, Math.trunc(asFiniteNumber(record?.startIndex) || 0));
    try {
      const metadata = this.centralStore.getAttachmentMetadata(attachmentId, session.peer.deviceId);
      this.sendEnvelope(session.socket, {
        type: 'relay:attachment:start',
        payload: { requestId, ...metadata, startIndex }
      });
      for (let index = startIndex; index < metadata.totalChunks; index += 1) {
        this.sendEnvelope(session.socket, {
          type: 'relay:attachment:data',
          payload: {
            requestId,
            attachmentId,
            index,
            total: metadata.totalChunks,
            dataBase64: this.centralStore
              .readAttachmentChunk(attachmentId, session.peer.deviceId, index)
              .toString('base64')
          }
        });
      }
      this.sendEnvelope(session.socket, {
        type: 'relay:attachment:download:complete',
        payload: { requestId, attachmentId }
      });
    } catch (error) {
      this.sendEnvelope(session.socket, {
        type: 'relay:attachment:error',
        payload: { requestId, message: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  private handleHello(session: RelaySession, payload: unknown): void {
    const hello = normalizeHelloPayload(payload);
    if (!hello) {
      this.sendError(session, 'INVALID_HELLO', 'Payload relay:hello inválido.');
      return;
    }

    const account = this.centralStore.authenticate(hello.sessionToken);
    if (!account) {
      this.sendError(session, 'AUTH_REQUIRED', 'Sessão inválida ou expirada.');
      try {
        session.socket.close(4001, 'authentication required');
      } catch {
        // ignore
      }
      return;
    }
    session.authToken = hello.sessionToken;
    const canonicalDeviceId = account.userId;

    const existing = this.sessionsByDeviceId.get(canonicalDeviceId);
    if (existing && existing !== session) {
      this.sendEnvelope(existing.socket, {
        type: 'relay:error',
        payload: {
          code: 'SESSION_REPLACED',
          message: 'Sessão substituída por nova conexão.'
        }
      });
      this.dropSession(existing, 'session-replaced', { suppressPresence: true });
    }

    const now = Date.now();
    session.peer = {
      deviceId: canonicalDeviceId,
      username: account.username,
      displayName: account.displayName,
      department: account.department,
      avatarEmoji: account.avatarEmoji,
      avatarBg: account.avatarBg,
      statusMessage: account.statusMessage,
      appVersion: hello.appVersion,
      connectedAt: session.peer?.connectedAt || now,
      lastSeenAt: now
    };
    session.lastSeenAt = now;
    this.sessionsByDeviceId.set(canonicalDeviceId, session);

    this.sendEnvelope(session.socket, {
      type: 'relay:hello:ok',
      payload: {
        sessionId: session.sessionId,
        serverTime: now,
        user: account
      }
    });
    this.sendEnvelope(session.socket, {
      type: 'relay:history:snapshot',
      payload: {
        serverTime: now,
        frames: this.centralStore.listFramesForUser(canonicalDeviceId, 0, 5000).map((frame) => ({
          type: frame.type,
          messageId: frame.messageId,
          from: frame.senderUserId,
          to: frame.targetUserId,
          createdAt: frame.createdAt,
          payload: frame.payload
        }))
      }
    });
    this.sendEnvelope(session.socket, {
      type: 'relay:directory',
      payload: {
        users: this.centralStore.listUsers()
          .filter((user) => !user.disabled && user.userId !== canonicalDeviceId)
          .map((user) => ({
            deviceId: user.userId,
            username: user.username,
            displayName: user.displayName,
            department: user.department,
            avatarEmoji: user.avatarEmoji,
            avatarBg: user.avatarBg,
            statusMessage: user.statusMessage
          }))
      }
    });

    this.bumpPresenceRevision('peer_online');
    this.sendPresenceSnapshot(session);
    this.sendAnnouncementSnapshot(session, 'peer_online');
    this.sendGroupSnapshot(session, 'peer_online');
    this.sendKnownExpiredAnnouncements(session);
    this.broadcastPresenceDelta({
      op: 'upsert',
      peer: this.clonePeerWithLiveSeen(session.peer)
    }, 'peer_online');
    logRelay('peer_online', {
      deviceId: canonicalDeviceId,
      username: account.username,
      displayName: account.displayName,
      department: account.department,
      totalOnline: this.sessionsByDeviceId.size
    });
  }

  private handleUpdateProfile(session: RelaySession, payload: unknown): void {
    if (!session.peer) {
      this.sendError(session, 'NOT_AUTHENTICATED', 'Envie relay:hello antes de atualizar perfil.');
      return;
    }

    const record = asRecord(payload) || {};
    const account = this.centralStore.updateUser(session.peer.deviceId, {
      displayName: asString(record.displayName) || session.peer.displayName,
      avatarEmoji: asString(record.avatarEmoji) || session.peer.avatarEmoji,
      avatarBg: asString(record.avatarBg) || session.peer.avatarBg,
      statusMessage: asString(record.statusMessage) || ''
    });

    session.peer = {
      ...session.peer,
      displayName: account.displayName,
      department: account.department,
      avatarEmoji: account.avatarEmoji,
      avatarBg: account.avatarBg,
      statusMessage: account.statusMessage,
      lastSeenAt: Date.now()
    };
    this.sessionsByDeviceId.set(session.peer.deviceId, session);
    logRelay('peer_profile_updated', {
      deviceId: session.peer.deviceId,
      displayName: session.peer.displayName,
      statusMessage: session.peer.statusMessage
    });
    this.bumpPresenceRevision('peer_profile_updated');
    this.broadcastPresenceDelta({
      op: 'upsert',
      peer: this.clonePeerWithLiveSeen(session.peer)
    }, 'peer_profile_updated');
  }

  private sendGroupSnapshot(session: RelaySession, reason: string, knownSeqByGroup?: Record<string, number>): void {
    if (!session.peer) return;
    const snapshots = this.groupStore.snapshotForDevice(session.peer.deviceId, knownSeqByGroup);
    this.sendEnvelope(session.socket, {
      type: 'relay:groups:snapshot',
      payload: {
        serverTime: Date.now(),
        reason,
        snapshots
      }
    });
    logRelay(
      'group_snapshot_sent',
      {
        deviceId: session.peer.deviceId,
        reason,
        groups: snapshots.length
      },
      { level: 'debug' }
    );
  }

  private handleGroupSyncRequest(session: RelaySession, payload: unknown): void {
    if (!session.peer) {
      this.sendError(session, 'NOT_AUTHENTICATED', 'Envie relay:hello antes de sincronizar grupos.');
      return;
    }
    const record = asRecord(payload);
    const rawSeqMap = asRecord(record?.knownSeqByGroup);
    const knownSeqByGroup: Record<string, number> = {};
    for (const [groupId, seq] of Object.entries(rawSeqMap || {})) {
      if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) continue;
      knownSeqByGroup[groupId] = Math.trunc(seq);
    }
    this.sendGroupSnapshot(session, 'request', knownSeqByGroup);
  }

  private sendGroupAck(session: RelaySession, requestId: string | null, payload?: Record<string, unknown>): void {
    this.sendEnvelope(session.socket, {
      type: 'relay:group:ack',
      payload: {
        requestId,
        ok: true,
        ...(payload || {})
      }
    });
  }

  private sendGroupRequestError(
    session: RelaySession,
    requestId: string | null,
    code: string,
    message: string
  ): void {
    this.sendEnvelope(session.socket, {
      type: 'relay:group:ack',
      payload: {
        requestId,
        ok: false,
        code,
        message
      }
    });
  }

  private normalizeStringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return Array.from(
      new Set(
        value
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
      )
    );
  }

  private broadcastGroupEvents(events: RelayGroupEvent[]): void {
    for (const event of events) {
      const recipientSet = new Set(this.groupStore.getActiveRecipientIds(event.groupId, true));
      recipientSet.add(event.actorDeviceId);
      const payload =
        event.payload && typeof event.payload === 'object'
          ? (event.payload as Record<string, unknown>)
          : {};
      if (
        (event.type === 'group.member.removed' || event.type === 'group.member.left') &&
        typeof payload.deviceId === 'string'
      ) {
        recipientSet.add(payload.deviceId);
      }
      const recipients = Array.from(recipientSet).filter(Boolean);
      for (const deviceId of recipients) {
        const recipient = this.sessionsByDeviceId.get(deviceId);
        if (!recipient) continue;
        this.sendEnvelope(recipient.socket, {
          type: 'relay:group:event',
          payload: {
            serverTime: Date.now(),
            event
          }
        });
      }
      logRelay('group_event_broadcast', {
        groupId: event.groupId,
        seq: event.seq,
        type: event.type,
        recipients: recipients.length
      }, { level: 'debug' });
    }
  }

  private async handleGroupRequest(session: RelaySession, payload: unknown): Promise<void> {
    if (!session.peer) {
      this.sendError(session, 'NOT_AUTHENTICATED', 'Envie relay:hello antes de operar grupos.');
      return;
    }
    const record = asRecord(payload);
    const requestId = asString(record?.requestId);
    const action = asString(record?.action);
    const data = asRecord(record?.data) || {};

    if (!action) {
      this.sendGroupRequestError(session, requestId, 'INVALID_GROUP_ACTION', 'Ação de grupo inválida.');
      return;
    }

    try {
      let events: RelayGroupEvent[] = [];
      let response: Record<string, unknown> = {};
      switch (action) {
        case 'create': {
          const result = this.groupStore.createGroup({
            actor: session.peer,
            name: asString(data.name) || 'Grupo',
            emoji: asString(data.emoji) || '👥',
            avatarBg: asString(data.avatarBg) || '#147ad6',
            description: asString(data.description) || '',
            memberDeviceIds: this.normalizeStringList(data.memberDeviceIds)
          });
          events = result.events;
          response = { group: result.group };
          break;
        }
        case 'update': {
          const event = this.groupStore.updateGroup({
            actorDeviceId: session.peer.deviceId,
            groupId: asString(data.groupId) || '',
            name: typeof data.name === 'string' ? data.name : undefined,
            emoji: typeof data.emoji === 'string' ? data.emoji : undefined,
            avatarBg: typeof data.avatarBg === 'string' ? data.avatarBg : undefined,
            description: typeof data.description === 'string' ? data.description : undefined,
            settings: (() => {
              const settings = asRecord(data.settings);
              if (!settings) return undefined;
              return {
                allowMembersToPin:
                  settings.allowMembersToPin === undefined
                    ? undefined
                    : settings.allowMembersToPin !== false,
                allowMembersToEditInfo:
                  settings.allowMembersToEditInfo === undefined
                    ? undefined
                    : settings.allowMembersToEditInfo === true
              };
            })()
          });
          events = [event];
          break;
        }
        case 'deleteGroup': {
          const event = this.groupStore.deleteGroup(
            asString(data.groupId) || '',
            session.peer.deviceId
          );
          events = [event];
          break;
        }
        case 'addMembers': {
          const event = this.groupStore.addMembers(
            asString(data.groupId) || '',
            session.peer.deviceId,
            this.normalizeStringList(data.memberDeviceIds)
          );
          events = [event];
          break;
        }
        case 'removeMember': {
          const event = this.groupStore.removeMember(
            asString(data.groupId) || '',
            session.peer.deviceId,
            asString(data.deviceId) || ''
          );
          events = [event];
          break;
        }
        case 'changeRole': {
          const role = data.role === 'admin' ? 'admin' : 'member';
          const event = this.groupStore.changeMemberRole(
            asString(data.groupId) || '',
            session.peer.deviceId,
            asString(data.deviceId) || '',
            role
          );
          events = [event];
          break;
        }
        case 'transferOwnership': {
          const event = this.groupStore.transferOwnership(
            asString(data.groupId) || '',
            session.peer.deviceId,
            asString(data.deviceId) || ''
          );
          events = [event];
          break;
        }
        case 'leave': {
          const event = this.groupStore.leaveGroup(asString(data.groupId) || '', session.peer.deviceId);
          events = [event];
          break;
        }
        case 'sendText': {
          const groupId = asString(data.groupId) || '';
          const messageId = asString(data.messageId) || randomUUID();
          const createdAt = asFiniteNumber(data.createdAt) || Date.now();
          const text = asString(data.text) || '';
          if (!text) throw new Error('Mensagem vazia.');
          const event = this.groupStore.appendGroupMessage({
            actorDeviceId: session.peer.deviceId,
            groupId,
            messageId,
            createdAt,
            payload: {
              message: {
                messageId,
                groupId,
                type: 'text',
                senderDeviceId: session.peer.deviceId,
                bodyText: text,
                replyTo: data.replyTo || null,
                forwardedFromMessageId: asString(data.forwardedFromMessageId),
                createdAt
              }
            }
          });
          events = [event];
          break;
        }
        case 'editMessage': {
          const event = this.groupStore.editGroupMessage(
            asString(data.groupId) || '',
            session.peer.deviceId,
            asString(data.targetMessageId) || '',
            asString(data.text) || '',
            Date.now()
          );
          events = [event];
          break;
        }
        case 'deleteMessage': {
          const event = this.groupStore.deleteGroupMessage(
            asString(data.groupId) || '',
            session.peer.deviceId,
            asString(data.targetMessageId) || '',
            Date.now()
          );
          events = [event];
          break;
        }
        case 'react': {
          const rawReaction = data.reaction;
          const reaction =
            rawReaction === null
              ? null
              : rawReaction === '👍' ||
                rawReaction === '👎' ||
                rawReaction === '❤️' ||
                rawReaction === '😢' ||
                rawReaction === '😊' ||
                rawReaction === '😂'
              ? rawReaction
              : null;
          const event = this.groupStore.reactToGroupMessage(
            asString(data.groupId) || '',
            session.peer.deviceId,
            asString(data.targetMessageId) || '',
            reaction,
            Date.now()
          );
          events = [event];
          break;
        }
        case 'pin':
        case 'unpin': {
          const event = this.groupStore.setGroupMessagePinned(
            asString(data.groupId) || '',
            session.peer.deviceId,
            asString(data.messageId) || '',
            action === 'pin'
          );
          events = [event];
          break;
        }
        case 'file:init': {
          this.transferMetrics.uploadAttempts += 1;
          const offerRecord = asRecord(data.offer);
          const upload = this.groupStore.initGroupFile({
            actorDeviceId: session.peer.deviceId,
            createdAt: asFiniteNumber(data.createdAt) || Date.now(),
            offer: {
              groupId: asString(offerRecord?.groupId) || '',
              messageId: asString(offerRecord?.messageId) || '',
              fileId: asString(offerRecord?.fileId) || '',
              filename: asString(offerRecord?.filename) || 'arquivo',
              size: asFiniteNumber(offerRecord?.size) || 0,
              sha256: asString(offerRecord?.sha256) || '',
              replyTo: offerRecord?.replyTo || null,
              forwardedFromMessageId: asString(offerRecord?.forwardedFromMessageId)
            }
          });
          response = { metadata: upload.metadata, nextIndex: upload.nextIndex };
          break;
        }
        default:
          throw new Error(`Ação de grupo não suportada: ${action}`);
      }

      this.sendGroupAck(session, requestId, response);
      if (events.length > 0) {
        this.broadcastGroupEvents(events);
      }
    } catch (error) {
      this.sendGroupRequestError(
        session,
        requestId,
        'GROUP_REQUEST_FAILED',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private async handleGroupFileChunk(session: RelaySession, payload: unknown): Promise<void> {
    if (!session.peer) {
      this.sendError(session, 'NOT_AUTHENTICATED', 'Envie relay:hello antes de enviar chunks.');
      return;
    }
    const record = asRecord(payload);
    const chunk: RelayGroupFileChunk = {
      fileId: asString(record?.fileId) || '',
      index: Math.trunc(asFiniteNumber(record?.index) || 0),
      total: Math.trunc(asFiniteNumber(record?.total) || 0),
      dataBase64: typeof record?.dataBase64 === 'string' ? record.dataBase64 : ''
    };
    try {
      await this.groupStore.appendGroupFileChunk(chunk, session.peer.deviceId);
      this.transferMetrics.bytesUploaded += Buffer.byteLength(chunk.dataBase64 || '', 'base64');
      this.sendEnvelope(session.socket, {
        type: 'relay:group:file:chunk:ack',
        payload: { fileId: chunk.fileId, index: chunk.index }
      });
    } catch (error) {
      this.sendEnvelope(session.socket, {
        type: 'relay:group:file:chunk:error',
        payload: {
          fileId: chunk.fileId,
          index: chunk.index,
          code: 'GROUP_FILE_CHUNK_FAILED',
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  private async handleGroupFileComplete(session: RelaySession, payload: unknown): Promise<void> {
    if (!session.peer) {
      this.sendError(session, 'NOT_AUTHENTICATED', 'Envie relay:hello antes de finalizar upload.');
      return;
    }
    const record = asRecord(payload);
    const requestId = asString(record?.requestId);
    const fileId = asString(record?.fileId);
    if (!fileId) {
      this.sendGroupRequestError(session, requestId, 'INVALID_FILE_ID', 'fileId inválido.');
      return;
    }
    try {
      const metadata = await this.groupStore.completeGroupFile(fileId, session.peer.deviceId);
      const messageEvent = this.groupStore.appendGroupMessage({
        actorDeviceId: session.peer.deviceId,
        groupId: metadata.groupId,
        messageId: metadata.messageId,
        createdAt: metadata.createdAt,
        payload: {
          message: {
            messageId: metadata.messageId,
            groupId: metadata.groupId,
            type: 'file',
            senderDeviceId: session.peer.deviceId,
            fileId: metadata.fileId,
            fileName: metadata.fileName,
            fileSize: metadata.fileSize,
            fileSha256: metadata.sha256,
            replyTo: metadata.replyTo || null,
            forwardedFromMessageId: metadata.forwardedFromMessageId || null,
            createdAt: metadata.createdAt
          },
          attachment: metadata
        }
      });
      const attachmentEvent = this.groupStore.appendAttachmentAvailable(
        metadata.groupId,
        session.peer.deviceId,
        metadata.fileId
      );
      this.transferMetrics.uploadsCompleted += 1;
      this.sendGroupAck(session, requestId, { metadata });
      this.broadcastGroupEvents([messageEvent, attachmentEvent]);
    } catch (error) {
      this.transferMetrics.uploadsFailed += 1;
      this.sendGroupRequestError(
        session,
        requestId,
        'GROUP_FILE_COMPLETE_FAILED',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private async handleGroupFileRequest(session: RelaySession, payload: unknown): Promise<void> {
    if (!session.peer) {
      this.sendError(session, 'NOT_AUTHENTICATED', 'Envie relay:hello antes de baixar arquivo.');
      return;
    }
    const record = asRecord(payload);
    const requestId = asString(record?.requestId);
    const fileId = asString(record?.fileId);
    const startIndex = Math.max(0, Math.trunc(asFiniteNumber(record?.startIndex) || 0));
    if (!fileId) {
      this.sendGroupRequestError(session, requestId, 'INVALID_FILE_ID', 'fileId inválido.');
      return;
    }
    this.transferMetrics.downloadAttempts += 1;
    if (startIndex > 0) this.transferMetrics.downloadsResumed += 1;
    try {
      const metadata = this.groupStore.getAttachmentMetadata(fileId);
      if (!metadata) {
        throw new Error('Anexo indisponível no Relay.');
      }
      this.sendEnvelope(session.socket, {
        type: 'relay:group:file:start',
        payload: {
          requestId,
          fileId,
          metadata
        }
      });
      for await (const chunk of this.groupStore.createAttachmentChunkStream(
        fileId,
        session.peer.deviceId,
        startIndex
      )) {
        const delivered = await this.sendEnvelopeWithStatus(session.socket, {
          type: 'relay:group:file:chunk',
          payload: {
            requestId,
            ...chunk
          }
        });
        if (!delivered) {
          throw new Error('Conexão encerrada durante o download do anexo.');
        }
        this.transferMetrics.bytesDownloaded += Buffer.byteLength(chunk.dataBase64 || '', 'base64');
      }
      this.sendEnvelope(session.socket, {
        type: 'relay:group:file:complete',
        payload: {
          requestId,
          fileId
        }
      });
      this.transferMetrics.downloadsCompleted += 1;
    } catch (error) {
      this.transferMetrics.downloadsFailed += 1;
      this.sendGroupRequestError(
        session,
        requestId,
        'GROUP_FILE_REQUEST_FAILED',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private handleGroupFileReceived(session: RelaySession, payload: unknown): void {
    if (!session.peer) {
      this.sendError(session, 'NOT_AUTHENTICATED', 'Envie relay:hello antes de confirmar arquivo.');
      return;
    }
    const record = asRecord(payload);
    const fileId = asString(record?.fileId);
    if (!fileId) return;
    const metadata = this.groupStore.markAttachmentReceived(fileId, session.peer.deviceId);
    if (metadata) {
      logRelay('group_attachment_received', {
        groupId: metadata.groupId,
        fileId,
        deviceId: session.peer.deviceId
      }, { level: 'debug' });
    }
  }

  private async handleRelaySend(session: RelaySession, payload: unknown): Promise<void> {
    if (!session.peer) {
      this.sendError(session, 'NOT_AUTHENTICATED', 'Envie relay:hello antes de encaminhar mensagens.');
      return;
    }

    const record = asRecord(payload);
    const frame = normalizeFrame(record?.frame);
    if (!frame) {
      this.sendError(session, 'INVALID_FRAME', 'Frame relay:send inválido.');
      return;
    }

    if (frame.from !== session.peer.deviceId) {
      this.sendError(
        session,
        'FORBIDDEN_FROM',
        'O campo "from" precisa ser o deviceId da sessão.',
        frame.messageId
      );
      return;
    }

    if (frame.type !== 'typing' && frame.type !== 'file:chunk' && frame.type !== 'file:complete') {
      const conversationId =
        frame.to === null
          ? 'announcements'
          : `dm:${[frame.from, frame.to].sort((left, right) => left.localeCompare(right)).join(':')}`;
      this.centralStore.saveFrame({
        messageId: frame.messageId,
        type: frame.type,
        senderUserId: frame.from,
        targetUserId: frame.to,
        conversationId,
        createdAt: frame.createdAt,
        payload: frame.payload
      });
    }

    let outboundFrame = frame;
    if (frame.type === 'announce') {
      this.trackAnnouncement(frame);
    } else if (frame.type === 'chat:edit' && frame.to === null) {
      const result = this.applyAnnouncementEdit(frame);
      if (!result.ok) {
        this.sendError(session, result.code, result.message, frame.messageId);
        return;
      }
      outboundFrame = result.frame;
    } else if (frame.type === 'chat:react' && frame.to === null) {
      this.applyAnnouncementReaction(frame);
    } else if (frame.type === 'chat:delete') {
      const targetMessageId = extractDeleteTargetMessageId(frame);
      if (targetMessageId) {
        this.markAnnouncementDeleted(targetMessageId, frame.createdAt);
      }
    }

    const deliveredTo = await this.routeFrame(outboundFrame, session.peer.deviceId);

    logRelay('frame_routed', {
      type: outboundFrame.type,
      from: outboundFrame.from,
      to: outboundFrame.to,
      messageId: outboundFrame.messageId,
      deliveredCount: deliveredTo.length,
      deliveredTo
    }, { level: 'debug' });

    this.sendEnvelope(session.socket, {
      type: 'relay:send:ack',
      payload: {
        frameMessageId: frame.messageId,
        deliveredTo
      }
    });
  }

  private async routeFrame(frame: RelayTransportFrame, senderDeviceId: string | null): Promise<string[]> {
    const deliveredTo: string[] = [];
    if (frame.to === null) {
      const recipients = Array.from(this.sessionsByDeviceId.entries())
        .filter(([deviceId]) => !(senderDeviceId && deviceId === senderDeviceId));
      const results = await Promise.all(
        recipients.map(async ([deviceId, recipient]) => {
          const delivered = await this.sendEnvelopeWithStatus(recipient.socket, {
            type: 'relay:deliver',
            payload: { frame }
          });
          return { deviceId, recipient, delivered };
        })
      );

      for (const result of results) {
        const { deviceId, recipient, delivered } = result;
        if (delivered) {
          deliveredTo.push(deviceId);
          continue;
        }
        this.dropSession(recipient, 'send-failed');
      }
      return deliveredTo;
    }

    const recipient = this.sessionsByDeviceId.get(frame.to);
    if (!recipient) {
      return deliveredTo;
    }

    const delivered = await this.sendEnvelopeWithStatus(recipient.socket, {
      type: 'relay:deliver',
      payload: { frame }
    });
    if (delivered) {
      deliveredTo.push(frame.to);
    } else {
      this.dropSession(recipient, 'send-failed');
    }
    return deliveredTo;
  }

  private trackAnnouncement(frame: RelayTransportFrame): void {
    const createdAt =
      Number.isFinite(frame.createdAt) && frame.createdAt > 0
        ? Math.trunc(frame.createdAt)
        : Date.now();
    const expiresAt = createdAt + ANNOUNCEMENT_TTL_MS;
    const previous = this.announcementsById.get(frame.messageId);
    this.announcementsById.set(frame.messageId, {
      messageId: frame.messageId,
      createdAt,
      expiresAt,
      expiredAt: null,
      deletedAt: null,
      reactionsByDeviceId: previous?.reactionsByDeviceId || {},
      readByDeviceId: previous?.readByDeviceId || {},
      frame: {
        ...frame,
        createdAt
      }
    });
    this.scheduleAnnouncementPersist();
    this.sweepAnnouncements('announce_received');
  }

  private applyAnnouncementEdit(
    frame: RelayTransportFrame
  ):
    | { ok: true; frame: RelayTransportFrame }
    | { ok: false; code: string; message: string } {
    const payload = extractAnnouncementEditPayload(frame);
    if (!payload) {
      return {
        ok: false,
        code: 'INVALID_ANNOUNCEMENT_EDIT',
        message: 'Edição de anúncio inválida.'
      };
    }

    const state = this.announcementsById.get(payload.targetMessageId);
    if (!state || state.deletedAt || state.expiredAt || state.expiresAt <= Date.now()) {
      return {
        ok: false,
        code: 'ANNOUNCEMENT_NOT_FOUND',
        message: 'Este anúncio não está mais disponível.'
      };
    }
    if (state.frame.from !== frame.from) {
      return {
        ok: false,
        code: 'FORBIDDEN_ANNOUNCEMENT_EDIT',
        message: 'Somente o autor pode editar este anúncio.'
      };
    }

    const now = Date.now();
    if (now - state.createdAt > ANNOUNCEMENT_EDIT_WINDOW_MS) {
      return {
        ok: false,
        code: 'ANNOUNCEMENT_EDIT_WINDOW_EXPIRED',
        message: 'O prazo para editar este anúncio terminou.'
      };
    }

    const persistedPayload = {
      ...(asRecord(state.frame.payload) || {}),
      text: payload.text,
      editedAt: now
    };
    state.frame = {
      ...state.frame,
      payload: persistedPayload
    };
    this.announcementsById.set(state.messageId, state);
    this.scheduleAnnouncementPersist();

    return {
      ok: true,
      frame: {
        ...frame,
        createdAt: now,
        payload: {
          targetMessageId: payload.targetMessageId,
          text: payload.text,
          editedAt: now
        }
      }
    };
  }

  private markAnnouncementDeleted(messageId: string, deletedAtInput: number): void {
    const state = this.announcementsById.get(messageId);
    if (!state) return;
    const deletedAt =
      Number.isFinite(deletedAtInput) && deletedAtInput > 0
        ? Math.trunc(deletedAtInput)
        : Date.now();
    if (state.deletedAt && state.deletedAt <= deletedAt) {
      return;
    }
    state.deletedAt = deletedAt;
    state.expiredAt = state.expiredAt || deletedAt;
    state.reactionsByDeviceId = {};
    state.readByDeviceId = {};
    this.announcementsById.set(messageId, state);
    this.scheduleAnnouncementPersist();
    this.broadcastAnnouncementExpiry([messageId], 'announcement_deleted');
  }

  private applyAnnouncementReaction(frame: RelayTransportFrame): void {
    const payload = extractReactPayload(frame);
    if (!payload) {
      return;
    }

    const state = this.announcementsById.get(payload.targetMessageId);
    if (!state || state.deletedAt || state.expiredAt || state.expiresAt <= Date.now()) {
      return;
    }

    if (payload.reaction) {
      state.reactionsByDeviceId[frame.from] = payload.reaction;
    } else {
      delete state.reactionsByDeviceId[frame.from];
    }

    this.announcementsById.set(payload.targetMessageId, state);
    this.scheduleAnnouncementPersist();
    this.broadcastAnnouncementReactions(payload.targetMessageId, state.reactionsByDeviceId, 'reaction_update');
  }

  private handleAnnouncementRead(session: RelaySession, payload: unknown): void {
    if (!session.peer) {
      this.sendError(session, 'NOT_AUTHENTICATED', 'Envie relay:hello antes de marcar anúncio como lido.');
      return;
    }

    const normalized = normalizeAnnouncementReadPayload(payload);
    if (!normalized) {
      this.sendError(session, 'INVALID_ANNOUNCEMENT_READ', 'Payload relay:announcement:read inválido.');
      return;
    }

    const now = Date.now();
    const readAt = normalized.readAt && normalized.readAt > 0 ? Math.min(normalized.readAt, now) : now;
    const touched: string[] = [];
    for (const messageId of normalized.messageIds) {
      const state = this.announcementsById.get(messageId);
      if (!state || state.deletedAt || state.expiredAt || state.expiresAt <= now) {
        continue;
      }
      state.readByDeviceId = state.readByDeviceId || {};
      const previous = state.readByDeviceId[session.peer.deviceId] || 0;
      if (previous >= readAt) {
        continue;
      }
      state.readByDeviceId[session.peer.deviceId] = readAt;
      this.announcementsById.set(messageId, state);
      touched.push(messageId);
    }

    if (touched.length === 0) {
      return;
    }

    this.scheduleAnnouncementPersist();
    this.broadcastAnnouncementReads(touched, 'read_update');
  }

  private sweepAnnouncements(reason: string): void {
    const now = Date.now();
    const expiredNow: string[] = [];
    let changed = false;

    for (const [messageId, state] of this.announcementsById.entries()) {
      if (state.deletedAt && !state.expiredAt) {
        state.expiredAt = state.deletedAt;
        changed = true;
      }

      if (!state.expiredAt && state.expiresAt <= now) {
        state.expiredAt = now;
        expiredNow.push(messageId);
        changed = true;
      }

      if (state.expiredAt && now - state.expiredAt > ANNOUNCEMENT_EXPIRED_RETENTION_MS) {
        this.announcementsById.delete(messageId);
        changed = true;
      } else {
        this.announcementsById.set(messageId, state);
      }
    }

    if (changed) {
      this.scheduleAnnouncementPersist();
    }
    if (expiredNow.length > 0) {
      this.broadcastAnnouncementExpiry(expiredNow, reason);
    }
  }

  private listActiveAnnouncementFrames(now = Date.now()): RelayTransportFrame[] {
    return Array.from(this.announcementsById.values())
      .filter((state) => !state.deletedAt && !state.expiredAt && state.expiresAt > now)
      .map((state) => state.frame)
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return a.messageId.localeCompare(b.messageId);
      });
  }

  private sendAnnouncementSnapshot(session: RelaySession, reason: string): void {
    this.sweepAnnouncements(`snapshot:${reason}`);
    const frames = this.listActiveAnnouncementFrames();
    const reactions = this.listAnnouncementReactionsSnapshot();
    const reads = this.listAnnouncementReadsSnapshot();
    this.sendEnvelope(session.socket, {
      type: 'relay:announcement:snapshot',
      payload: {
        serverTime: Date.now(),
        frames,
        reactions,
        reads
      }
    });
    logRelay(
      'announcement_snapshot_sent',
      {
        deviceId: session.peer?.deviceId || null,
        reason,
        count: frames.length,
        reactions: Object.keys(reactions).length,
        reads: Object.keys(reads).length
      },
      { level: 'debug' }
    );
  }

  private listAnnouncementReactionsSnapshot(): Record<
    string,
    Record<string, AnnouncementReactionValue>
  > {
    const now = Date.now();
    const snapshot: Record<string, Record<string, AnnouncementReactionValue>> = {};
    for (const state of this.announcementsById.values()) {
      if (state.deletedAt || state.expiredAt || state.expiresAt <= now) {
        continue;
      }
      const entries = Object.entries(state.reactionsByDeviceId || {}).filter((entry) =>
        ALLOWED_ANNOUNCEMENT_REACTIONS.has(entry[1])
      );
      if (entries.length === 0) continue;
      snapshot[state.messageId] = Object.fromEntries(entries);
    }
    return snapshot;
  }

  private listAnnouncementReadsSnapshot(): Record<string, Record<string, number>> {
    const now = Date.now();
    const snapshot: Record<string, Record<string, number>> = {};
    for (const state of this.announcementsById.values()) {
      if (state.deletedAt || state.expiredAt || state.expiresAt <= now) {
        continue;
      }
      const entries = Object.entries(state.readByDeviceId || {}).filter(
        ([deviceId, readAt]) => deviceId.trim().length > 0 && Number.isFinite(readAt) && readAt > 0
      );
      if (entries.length === 0) continue;
      snapshot[state.messageId] = Object.fromEntries(entries);
    }
    return snapshot;
  }

  private sendKnownExpiredAnnouncements(session: RelaySession): void {
    const now = Date.now();
    const expiredIds = Array.from(this.announcementsById.values())
      .filter((state) => Boolean(state.deletedAt) || state.expiresAt <= now)
      .map((state) => state.messageId);
    if (expiredIds.length === 0) {
      return;
    }
    this.sendEnvelope(session.socket, {
      type: 'relay:announcement:expired',
      payload: {
        serverTime: now,
        messageIds: expiredIds
      }
    });
    logRelay('announcement_expiry_sent_to_peer', {
      deviceId: session.peer?.deviceId || null,
      count: expiredIds.length
    }, { level: 'debug' });
  }

  private broadcastAnnouncementExpiry(messageIds: string[], reason: string): void {
    const uniqueIds = Array.from(new Set(messageIds));
    if (uniqueIds.length === 0) {
      return;
    }
    const payload = {
      serverTime: Date.now(),
      messageIds: uniqueIds
    };
    logRelay('announcement_expired', {
      reason,
      count: uniqueIds.length,
      messageIds: uniqueIds
    });
    for (const session of this.sessionsBySocket.values()) {
      this.sendEnvelope(session.socket, {
        type: 'relay:announcement:expired',
        payload
      });
    }
  }

  private broadcastAnnouncementReactions(
    messageId: string,
    reactionsByDeviceId: Record<string, AnnouncementReactionValue>,
    reason: string
  ): void {
    const filtered = Object.fromEntries(
      Object.entries(reactionsByDeviceId).filter(([, reaction]) =>
        ALLOWED_ANNOUNCEMENT_REACTIONS.has(reaction)
      )
    ) as Record<string, AnnouncementReactionValue>;

    const payload = {
      serverTime: Date.now(),
      messageId,
      reactions: filtered
    };

    logRelay(
      'announcement_reactions_broadcast',
      {
        reason,
        messageId,
        reactors: Object.keys(filtered).length,
        recipients: this.sessionsBySocket.size
      },
      { level: 'debug' }
    );

    for (const session of this.sessionsBySocket.values()) {
      this.sendEnvelope(session.socket, {
        type: 'relay:announcement:reactions',
        payload
      });
    }
  }

  private broadcastAnnouncementReads(messageIds: string[], reason: string): void {
    const reads = this.listAnnouncementReadsSnapshot();
    const payloadReads = Object.fromEntries(
      Array.from(new Set(messageIds))
        .map((messageId) => [messageId, reads[messageId] || {}] as const)
        .filter(([, byDevice]) => Object.keys(byDevice).length > 0)
    );

    if (Object.keys(payloadReads).length === 0) {
      return;
    }

    const payload = {
      serverTime: Date.now(),
      reads: payloadReads
    };

    logRelay(
      'announcement_reads_broadcast',
      {
        reason,
        messageIds,
        recipients: this.sessionsBySocket.size
      },
      { level: 'debug' }
    );

    for (const session of this.sessionsBySocket.values()) {
      this.sendEnvelope(session.socket, {
        type: 'relay:announcement:reads',
        payload
      });
    }
  }

  private scheduleAnnouncementPersist(): void {
    if (this.announcementPersistTimer) return;
    this.announcementPersistTimer = setTimeout(() => {
      this.announcementPersistTimer = null;
      this.persistAnnouncementStore();
    }, 220);
    this.announcementPersistTimer.unref?.();
  }

  private persistAnnouncementStore(): void {
    try {
      const dir = path.dirname(ANNOUNCEMENT_STORE_FILE);
      fs.mkdirSync(dir, { recursive: true });
      const payload = {
        version: 1,
        savedAt: Date.now(),
        announcements: Array.from(this.announcementsById.values()).map((state) => ({
          messageId: state.messageId,
          createdAt: state.createdAt,
          expiresAt: state.expiresAt,
          expiredAt: state.expiredAt,
          deletedAt: state.deletedAt,
          reactionsByDeviceId: state.reactionsByDeviceId,
          readByDeviceId: state.readByDeviceId,
          frame: state.frame
        }))
      };
      const tmpFile = `${ANNOUNCEMENT_STORE_FILE}.tmp`;
      fs.writeFileSync(tmpFile, this.centralStore.protectJson(payload));
      fs.renameSync(tmpFile, ANNOUNCEMENT_STORE_FILE);
    } catch (error) {
      logRelay(
        'announcement_store_persist_failed',
        {
          file: ANNOUNCEMENT_STORE_FILE,
          message: error instanceof Error ? error.message : String(error)
        },
        { level: 'warn', rateKey: 'announcement_store_persist_failed', rateLimitMs: 20_000 }
      );
    }
  }

  private loadAnnouncementStore(): void {
    try {
      if (!fs.existsSync(ANNOUNCEMENT_STORE_FILE)) {
        return;
      }

      const raw = fs.readFileSync(ANNOUNCEMENT_STORE_FILE, 'utf8');
      const parsed = this.centralStore.unprotectJson<{ announcements?: unknown[] } | null>(raw);
      const list = Array.isArray(parsed?.announcements) ? parsed!.announcements : [];
      let loaded = 0;

      for (const item of list) {
        const record = asRecord(item);
        if (!record) continue;
        const messageId = asString(record.messageId);
        const frame = normalizeFrame(record.frame);
        const createdAt = asFiniteNumber(record.createdAt);
        const expiresAt = asFiniteNumber(record.expiresAt);
        const expiredAt = asFiniteNumber(record.expiredAt);
        const deletedAt = asFiniteNumber(record.deletedAt);
        const rawReactions = asRecord(record.reactionsByDeviceId) || {};
        const rawReads = asRecord(record.readByDeviceId) || {};
        const reactionsByDeviceId = Object.fromEntries(
          Object.entries(rawReactions).filter((entry) =>
            typeof entry[0] === 'string' &&
            ALLOWED_ANNOUNCEMENT_REACTIONS.has(entry[1] as AnnouncementReactionValue)
          )
        ) as Record<string, AnnouncementReactionValue>;
        const readByDeviceId = Object.fromEntries(
          Object.entries(rawReads).filter(
            (entry) =>
              typeof entry[0] === 'string' &&
              typeof entry[1] === 'number' &&
              Number.isFinite(entry[1]) &&
              entry[1] > 0
          )
        ) as Record<string, number>;
        if (!messageId || !frame || !createdAt || !expiresAt) continue;
        this.announcementsById.set(messageId, {
          messageId,
          frame,
          createdAt: Math.trunc(createdAt),
          expiresAt: Math.trunc(expiresAt),
          expiredAt: expiredAt ? Math.trunc(expiredAt) : null,
          deletedAt: deletedAt ? Math.trunc(deletedAt) : null,
          reactionsByDeviceId,
          readByDeviceId
        });
        loaded += 1;
      }

      this.sweepAnnouncements('store_load');
      logRelay('announcement_store_loaded', {
        file: ANNOUNCEMENT_STORE_FILE,
        loaded
      });
    } catch (error) {
      logRelay(
        'announcement_store_load_failed',
        {
          file: ANNOUNCEMENT_STORE_FILE,
          message: error instanceof Error ? error.message : String(error)
        },
        { level: 'warn' }
      );
    }
  }

  private dropSession(
    session: RelaySession,
    reason: string,
    options?: { suppressPresence?: boolean }
  ): void {
    const current = this.sessionsBySocket.get(session.socket);
    if (!current) return;
    const suppressPresence = Boolean(options?.suppressPresence);

    this.sessionsBySocket.delete(session.socket);
    const peer = session.peer;
    if (peer) {
      const mapped = this.sessionsByDeviceId.get(peer.deviceId);
      if (mapped === session) {
        this.sessionsByDeviceId.delete(peer.deviceId);
        if (!suppressPresence) {
          logRelay('peer_offline', {
            deviceId: peer.deviceId,
            displayName: peer.displayName,
            reason,
            totalOnline: this.sessionsByDeviceId.size
          });
          this.bumpPresenceRevision('peer_offline');
          this.broadcastPresenceDelta(
            {
              op: 'remove',
              deviceId: peer.deviceId
            },
            'peer_offline'
          );
        }
      }
    }

    try {
      if (session.socket.readyState === OPEN_READY_STATE) {
        session.socket.close(1000, reason);
      }
    } catch {
      // ignore
    }
  }

  private listPeers(): RelayPeerInfo[] {
    return Array.from(this.sessionsByDeviceId.values())
      .map((session) => session.peer)
      .filter((peer): peer is RelayPeerInfo => Boolean(peer))
      .map((peer) => this.clonePeerWithLiveSeen(peer))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'));
  }

  private clonePeerWithLiveSeen(peer: RelayPeerInfo): RelayPeerInfo {
    return {
      ...peer,
      lastSeenAt: Date.now()
    };
  }

  private sendPresenceSnapshot(session: RelaySession): void {
    this.sendEnvelope(session.socket, {
      type: 'relay:presence',
      payload: {
        serverTime: Date.now(),
        revision: this.presenceRevision,
        peers: this.listPeers()
      }
    });
  }

  private broadcastPresence(reason = 'update'): void {
    const payload = {
      serverTime: Date.now(),
      revision: this.presenceRevision,
      peers: this.listPeers()
    };
    const periodic = reason === 'periodic';
    logRelay('presence_broadcast', {
      reason,
      revision: this.presenceRevision,
      recipients: this.sessionsBySocket.size,
      peersOnline: payload.peers.length
    }, {
      level: periodic ? 'debug' : 'info',
      rateKey: periodic ? 'presence_broadcast_periodic' : undefined,
      rateLimitMs: periodic ? 20_000 : undefined
    });
    for (const session of this.sessionsBySocket.values()) {
      this.sendEnvelope(session.socket, {
        type: 'relay:presence',
        payload
      });
    }
  }

  private broadcastPresenceDelta(
    input:
      | { op: 'upsert'; peer: RelayPeerInfo }
      | { op: 'remove'; deviceId: string },
    reason: string
  ): void {
    const payload =
      input.op === 'upsert'
        ? {
            serverTime: Date.now(),
            revision: this.presenceRevision,
            op: 'upsert' as const,
            peer: input.peer
          }
        : {
            serverTime: Date.now(),
            revision: this.presenceRevision,
            op: 'remove' as const,
            deviceId: input.deviceId
          };

    logRelay(
      'presence_delta_broadcast',
      {
        reason,
        op: payload.op,
        revision: this.presenceRevision,
        recipients: this.sessionsBySocket.size,
        peer: input.op === 'upsert' ? input.peer.deviceId : input.deviceId
      },
      { level: 'debug' }
    );

    for (const session of this.sessionsBySocket.values()) {
      this.sendEnvelope(session.socket, {
        type: 'relay:presence:delta',
        payload
      });
    }
  }

  private bumpPresenceRevision(reason: string): void {
    this.presenceRevision += 1;
    logRelay('presence_revision', {
      reason,
      revision: this.presenceRevision
    }, { level: 'debug' });
  }

  private sendError(
    session: RelaySession,
    code: string,
    message: string,
    frameMessageId?: string
  ): void {
    logRelay('protocol_error', {
      sessionId: session.sessionId,
      deviceId: session.peer?.deviceId || null,
      code,
      message
    }, { level: 'warn' });
    this.sendEnvelope(session.socket, {
      type: 'relay:error',
      payload: { code, message, ...(frameMessageId ? { frameMessageId } : {}) }
    });
  }

  private sendEnvelope(socket: WebSocket, envelope: RelayEnvelope): void {
    if (socket.readyState !== OPEN_READY_STATE) return;
    try {
      socket.send(JSON.stringify(envelope));
    } catch {
      // ignore
    }
  }

  private async sendEnvelopeWithStatus(
    socket: WebSocket,
    envelope: RelayEnvelope
  ): Promise<boolean> {
    if (socket.readyState !== OPEN_READY_STATE) {
      this.transferMetrics.sendFailures += 1;
      return false;
    }
    const startedAt = Date.now();
    try {
      const payload = JSON.stringify(envelope);
      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          const latency = Math.max(0, Date.now() - startedAt);
          this.transferMetrics.sendLatencyTotalMs += latency;
          this.transferMetrics.sendLatencyCount += 1;
          this.transferMetrics.maxSendLatencyMs = Math.max(
            this.transferMetrics.maxSendLatencyMs,
            latency
          );
          this.transferMetrics.sendFailures += 1;
          resolve(false);
        }, SEND_CALLBACK_TIMEOUT_MS);
        timeout.unref?.();

        socket.send(payload, (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          const latency = Math.max(0, Date.now() - startedAt);
          this.transferMetrics.sendLatencyTotalMs += latency;
          this.transferMetrics.sendLatencyCount += 1;
          this.transferMetrics.maxSendLatencyMs = Math.max(
            this.transferMetrics.maxSendLatencyMs,
            latency
          );
          if (error) this.transferMetrics.sendFailures += 1;
          resolve(!error);
        });
      });
    } catch {
      this.transferMetrics.sendFailures += 1;
      return false;
    }
  }
}

const config: RelayConfig = {
  host: asString(parseCliArg('--host')) || asString(process.env.LANTERN_RELAY_HOST) || DEFAULT_CONFIG.host,
  port: parseInteger(parseCliArg('--port') || process.env.LANTERN_RELAY_PORT, DEFAULT_CONFIG.port),
  pingIntervalMs: parseInteger(process.env.LANTERN_RELAY_PING_INTERVAL_MS, DEFAULT_CONFIG.pingIntervalMs),
  peerTimeoutMs: parseInteger(process.env.LANTERN_RELAY_PEER_TIMEOUT_MS, DEFAULT_CONFIG.peerTimeoutMs),
  presenceBroadcastIntervalMs: parseInteger(
    process.env.LANTERN_RELAY_PRESENCE_BROADCAST_INTERVAL_MS,
    DEFAULT_CONFIG.presenceBroadcastIntervalMs
  ),
  maxPayloadBytes: parseInteger(process.env.LANTERN_RELAY_MAX_PAYLOAD_BYTES, DEFAULT_CONFIG.maxPayloadBytes),
  tlsCertFile: asString(process.env.LANTERN_RELAY_TLS_CERT),
  tlsKeyFile: asString(process.env.LANTERN_RELAY_TLS_KEY),
  externalMode: process.env.LANTERN_RELAY_EXTERNAL === '1'
};

const relay = new LanternRelay(config);

const shutdown = async (signal: string): Promise<void> => {
  logRelay('shutdown', { signal });
  try {
    await relay.stop(signal);
    process.exit(0);
  } catch (error) {
    console.error('[LanternRelay] erro ao encerrar:', error);
    process.exit(1);
  }
};

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('uncaughtException', (error) => {
  console.error('[LanternRelay] uncaughtException:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[LanternRelay] unhandledRejection:', reason);
});

void relay.start().catch((error) => {
  logRelay('startup_failed', {
    message: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
