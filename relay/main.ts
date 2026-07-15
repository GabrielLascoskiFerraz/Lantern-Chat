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
import { SessionRegistry } from './sessionRegistry';
import { RelayGroupEvent, RelayGroupFileChunk } from './groupTypes';
import { CentralStore } from './centralStore';
import { RetentionPolicy } from './centralTypes';
import { createSessionToken, hashToken } from './security';
import { CalendarAutomationEvent, fetchCalendarEventsForDay } from './calendarAutomation';

const RELAY_VERSION = '1.0.0';
const RELAY_MDNS_TYPE = 'lanternrelay';
const RELAY_MDNS_PROTOCOL = 'tcp';
const RELAY_DISCOVERY_UDP_QUERY = 'lantern:relay:discover';
const RELAY_DISCOVERY_UDP_RESPONSE = 'lantern:relay:announce';
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
const LEGACY_ANNOUNCEMENT_STORE_FILE = process.env.LANTERN_RELAY_ANNOUNCEMENTS_FILE
  ? path.resolve(process.env.LANTERN_RELAY_ANNOUNCEMENTS_FILE)
  : path.join(resolveRelayDataDir(), 'announcements.json');
const LEGACY_GROUP_STORE_FILE = process.env.LANTERN_RELAY_GROUPS_FILE
  ? path.resolve(process.env.LANTERN_RELAY_GROUPS_FILE)
  : path.join(resolveRelayDataDir(), 'groups.json');
const GROUP_ATTACHMENTS_DIR = process.env.LANTERN_RELAY_GROUP_ATTACHMENTS_DIR
  ? path.resolve(process.env.LANTERN_RELAY_GROUP_ATTACHMENTS_DIR)
  : path.join(resolveRelayDataDir(), 'group-attachments');
const RELAY_STICKERS_DIR = process.env.LANTERN_RELAY_STICKERS_DIR
  ? path.resolve(process.env.LANTERN_RELAY_STICKERS_DIR)
  : path.join(resolveRelayDataDir(), 'stickers');
const RELAY_STICKER_CATEGORY_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const RELAY_STICKER_FILE_NAME_RE = /^[a-z0-9][a-z0-9._ -]*\.gif$/i;
const RELAY_STICKER_MAX_BYTES = 20 * 1024 * 1024;
const RELAY_STICKER_PREVIEW_MAX_BYTES = 4 * 1024 * 1024;

const OPEN_READY_STATE = 1;
const GROUP_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const ANNOUNCEMENT_STATE_KEY = 'announcements';
const ANNOUNCEMENT_STATE_VERSION = 1;

type JsonRecord = Record<string, unknown>;

export interface RelayConfig {
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
  serverSeq?: number;
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

interface CalendarAutomationState {
  version: 1;
  enabled: boolean;
  url: string;
  updateTime: string;
  lastRunDate: string;
  lastRunAt: number;
  lastError: string;
  seenEventIds: Record<string, number>;
}

interface RelayAnnouncementEditPayload {
  targetMessageId: string;
  text: string;
}

interface RelaySession {
  sessionId: string;
  socket: WebSocket;
  peer: RelayPeerInfo | null;
  clientDeviceId: string | null;
  lastSeenAt: number;
  isAlive: boolean;
  messageQueue: Promise<void>;
  // Downloads stay ordered, but must not block this peer's commands while a
  // potentially large group attachment is being streamed.
  groupFileDownloadQueue: Promise<void>;
  attachmentDownloadQueue: Promise<void>;
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
  tls: boolean;
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

export interface ManagedStickerUpdate {
  label: string;
  category: string;
}

export interface ManagedStickerImportResult {
  added: RelayStickerItem[];
  replaced: RelayStickerItem[];
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

const normalizeStickerCategory = (value: string): string => {
  const normalized = value.trim().toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (!normalized || normalized === 'geral') return '';
  if (!RELAY_STICKER_CATEGORY_RE.test(normalized)) {
    throw new Error('A categoria da GIF é inválida.');
  }
  return normalized;
};

const normalizeStickerFileName = (value: string): string => {
  const rawBase = value.replace(/\.gif$/i, '').trim();
  const base = rawBase
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._ -]+/gi, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[. _-]+|[. _-]+$/g, '')
    .slice(0, 96);
  const fileName = `${base || 'gif'}.gif`;
  if (!RELAY_STICKER_FILE_NAME_RE.test(fileName)) {
    throw new Error('O nome da GIF é inválido.');
  }
  return fileName;
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
  <title>Lantern Relay</title>
  <style>
    :root {
      color-scheme: light dark;
      --teams-bg: #edf1f7;
      --teams-surface: #ffffff;
      --teams-surface-2: #f4f7fd;
      --teams-header: #f8faff;
      --teams-border: #d4ddec;
      --teams-text: #1a2230;
      --teams-muted: #5e687c;
      --teams-accent: #5b5fc7;
      --teams-row-hover: #edf2ff;
      --teams-row-active: #e4eaff;
      --teams-shadow-soft: 0 8px 26px rgba(22, 39, 73, 0.07);
      --bg: var(--teams-bg);
      --bg-strong: var(--teams-surface-2);
      --surface: var(--teams-surface);
      --surface-strong: var(--teams-surface);
      --text: var(--teams-text);
      --muted: var(--teams-muted);
      --line: var(--teams-border);
      --accent: var(--teams-accent);
      --accent-soft: color-mix(in srgb, var(--teams-accent) 12%, transparent);
      --good: #18a058;
      --warn: #d9822b;
      --shadow: var(--teams-shadow-soft);
      font-family: "Segoe UI Variable Text", "Segoe UI", "Helvetica Neue", system-ui, sans-serif;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --teams-bg: #141a26;
        --teams-surface: #1c2433;
        --teams-surface-2: #222d40;
        --teams-header: #202a3b;
        --teams-border: #33435f;
        --teams-text: #f2f6ff;
        --teams-muted: #c3cee4;
        --teams-accent: #a4acff;
        --teams-row-hover: #2a3951;
        --teams-row-active: #324563;
        --teams-shadow-soft: 0 8px 26px rgba(0, 0, 0, 0.34);
      }
    }

    * { box-sizing: border-box; }

    body {
      min-height: 100vh;
      margin: 0;
      color: var(--text);
      background: var(--teams-bg);
      line-height: 1.35;
      -webkit-font-smoothing: antialiased;
    }

    .dashboard-shell {
      display: grid;
      min-height: 100vh;
      grid-template-columns: 360px minmax(0, 1fr);
    }

    .dashboard-nav {
      position: sticky;
      top: 0;
      display: flex;
      height: 100vh;
      flex-direction: column;
      gap: 0;
      padding: 0;
      border-right: 1px solid var(--line);
      background: var(--teams-surface);
      box-shadow: var(--teams-shadow-soft);
      z-index: 5;
    }

    .nav-brand { display: flex; min-height: 72px; align-items: center; gap: 11px; padding: 10px 14px; border-bottom: 1px solid var(--line); background: var(--teams-header); }
    .nav-logo { width: 44px; height: 44px; object-fit: contain; }
    .nav-brand strong { display: block; font-size: 17px; letter-spacing: -.02em; }
    .nav-brand span { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; }
    .dashboard-nav > div:nth-child(2) { min-height: 0; overflow: auto; }
    .nav-caption { padding: 14px 14px 7px; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .nav-links { display: grid; gap: 4px; }
    .nav-link {
      display: flex; min-height: 52px; align-items: center; gap: 10px; padding: 0 14px;
      border-bottom: 1px solid color-mix(in srgb, var(--line) 88%, transparent); color: var(--text); font-size: 14px; font-weight: 650; text-decoration: none;
    }
    .nav-link:hover { background: var(--teams-row-hover); }
    .nav-link.active { color: var(--text); background: var(--teams-row-active); box-shadow: inset 3px 0 0 var(--teams-accent); }
    .nav-icon { display: grid; width: 22px; place-items: center; font-size: 15px; }
    .nav-footer { display: grid; gap: 10px; margin-top: auto; padding: 12px 14px; border-top: 1px solid var(--line); background: var(--teams-header); }
    .nav-footer .web-link { justify-content: center; }
    .nav-version { color: var(--muted); font-size: 11px; line-height: 1.45; text-align: center; }

    .page {
      width: 100%;
      min-width: 0;
      padding: 0 0 32px;
    }

    .hero {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      min-height: 72px;
      margin-bottom: 0;
      padding: 10px 24px;
      border-bottom: 1px solid var(--line);
      background: var(--teams-header);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    }

    .hero-actions { display: flex; align-items: center; gap: 10px; }
    .web-link { display: inline-flex; min-height: 34px; align-items: center; padding: 0 12px; border: 1px solid var(--accent); border-radius: 6px; background: var(--accent); color: #fff; font-size: 13px; font-weight: 650; text-decoration: none; }

    .mark { display: none; }

    h1 {
      margin: 0;
      font-size: 22px;
      letter-spacing: -0.025em;
      line-height: 1.15;
    }

    .subtitle {
      margin: 3px 0 0;
      color: var(--muted);
      font-size: 12px;
    }

    .live-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 12px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--teams-surface);
      color: var(--muted);
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
      gap: 10px;
      margin: 0;
      padding: 18px 24px 10px;
    }

    .card {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: color-mix(in srgb, var(--teams-surface) 92%, var(--teams-surface-2));
    }

    .metric {
      padding: 14px;
      min-height: 104px;
    }

    .metric-label {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.045em;
      text-transform: uppercase;
    }

    .metric-value {
      margin-top: 9px;
      font-size: 25px;
      font-weight: 750;
      letter-spacing: -0.035em;
    }

    .metric-note {
      margin-top: 6px;
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
      padding: 6px 24px 0;
    }

    .section {
      overflow: hidden;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 52px;
      padding: 12px 14px 8px;
      border-bottom: 1px solid color-mix(in srgb, var(--line) 82%, transparent);
    }

    .section-title {
      margin: 0;
      font-size: 17px;
      letter-spacing: -0.025em;
    }

    .section-meta {
      color: var(--muted);
      font-size: 13px;
    }

    .list {
      display: grid;
      gap: 10px;
      gap: 0;
      padding: 0;
    }

    .peer,
    .announcement {
      display: grid;
      gap: 10px;
      padding: 12px 14px;
      border: 0;
      border-bottom: 1px solid color-mix(in srgb, var(--line) 88%, transparent);
      border-radius: 0;
      background: transparent;
      transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
    }

    .peer:hover,
    .announcement:hover {
      background: var(--teams-row-hover);
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
      border-radius: 50%;
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
      border-radius: 50%;
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
      padding: 34px 18px;
      color: var(--muted);
      text-align: center;
    }

    .footer {
      margin-top: 18px;
      color: var(--muted);
      font-size: 12px;
      text-align: center;
    }

    .admin-section { margin: 16px 24px 0; padding: 14px; }
    .admin-grid { display: grid; gap: 14px; }
    .admin-primary { display: grid; grid-template-columns: minmax(280px, .68fr) minmax(0, 1.32fr); gap: 14px; align-items: start; }
    .admin-operations { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; align-items: start; }
    .admin-panel { padding: 12px; border: 1px solid color-mix(in srgb, var(--line) 86%, transparent); border-radius: 12px; background: color-mix(in srgb, var(--teams-surface) 92%, var(--teams-surface-2)); }
    .admin-panel h3 { margin: 0 0 12px; font-size: 15px; }
    .admin-form { display: grid; gap: 9px; }
    .admin-form.two { grid-template-columns: 1fr 1fr; }
    .admin-form input, .admin-form select {
      width: 100%; min-height: 34px; border: 1px solid var(--line); border-radius: 5px;
      padding: 0 10px; color: var(--text); background: var(--teams-surface); font: inherit;
    }
    .admin-form button, .admin-action {
      min-height: 34px; border: 1px solid var(--line); border-radius: 6px; padding: 0 12px;
      color: #fff; background: var(--accent); font: inherit; font-weight: 650; cursor: pointer;
    }
    .admin-action.secondary { color: var(--text); background: var(--surface-strong); }
    .admin-action.danger { color: #fff; background: #c43f3f; }
    .admin-users { display: grid; gap: 9px; max-height: 520px; overflow: auto; padding-right: 2px; }
    .admin-user { display: grid; gap: 9px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--teams-surface); }
    .admin-user-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .admin-user-fields { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
    .admin-user-fields input { grid-column: span 2; }
    .admin-user-fields input { min-width: 0; min-height: 34px; border: 1px solid var(--line); border-radius: 5px; padding: 0 9px; background: var(--teams-surface); color: var(--text); }
    .admin-user-fields button { width: 100%; min-width: 0; padding: 0 8px; }
    .admin-sessions-list { max-height: 356px; }
    .admin-feedback { min-height: 18px; margin-top: 8px; color: var(--muted); font-size: 12px; }
    .admin-audit { display:grid; gap:7px; max-height:220px; overflow:auto; margin-top:10px; }
    .admin-audit-row { display:grid; gap:2px; padding:8px 9px; border-bottom:1px solid var(--line); font-size:11px; }
    .admin-audit-row span { color:var(--muted); }
    .dashboard-shell.auth-locked { display:block; min-height:100vh; }
    .dashboard-shell.auth-locked .dashboard-nav,
    .dashboard-shell.auth-locked .topbar,
    .dashboard-shell.auth-locked .page-section:not(#administration) { display:none; }
    .dashboard-shell.auth-locked #administration { width:min(720px, calc(100vw - 32px)); margin:48px auto 0; }
    .hidden { display: none !important; }

    @media (max-width: 880px) {
      .dashboard-shell { display: block; }
      .dashboard-nav { position: static; width: 100%; height: auto; border-right: 0; border-bottom: 1px solid var(--line); }
      .dashboard-nav .nav-caption, .dashboard-nav .nav-footer { display: none; }
      .dashboard-nav > div:nth-child(2) { overflow: hidden; }
      .nav-links { display: flex; overflow-x: auto; }
      .nav-link { flex: 0 0 auto; }
      .page { width: 100%; }
      .hero {
        align-items: flex-start;
        flex-direction: column;
        padding: 14px 16px;
      }
      .hero-actions { width: 100%; justify-content: space-between; }

      .content,
      .admin-grid,
      .admin-primary,
      .admin-operations,
      .admin-form.two,
      .admin-user-fields {
        grid-template-columns: 1fr;
      }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); padding-inline: 16px; }
      .content { padding-inline: 16px; }
      .admin-section { margin-inline: 16px; }
      .admin-user-fields input { grid-column: auto; }
    }

    @media (max-width: 560px) {
      .nav-brand { min-height: 64px; }
      .nav-link { min-height: 46px; padding-inline: 12px; font-size: 13px; }
      .grid { grid-template-columns: 1fr; }
      .hero-actions, .live-pill { width: 100%; }
      .admin-section { padding: 12px; }
    }
  </style>
</head>
<body>
  <div id="dashboard-shell" class="dashboard-shell auth-locked">
    <aside class="dashboard-nav" aria-label="Navegação administrativa">
      <div class="nav-brand">
        <img class="nav-logo" src="/lantern-icon.png" alt="">
        <div><strong>Lantern</strong><span>Administração do Relay</span></div>
      </div>
      <div>
        <div class="nav-caption">Painel</div>
        <nav class="nav-links">
          <a class="nav-link active" href="#overview"><span class="nav-icon">⌂</span>Visão geral</a>
          <a class="nav-link" href="#activity"><span class="nav-icon">◉</span>Atividade</a>
          <a class="nav-link" href="#administration"><span class="nav-icon">♙</span>Contas e acesso</a>
        </nav>
      </div>
      <div class="nav-footer">
        <a class="web-link" href="/app/">Abrir Lantern</a>
        <div class="nav-version">Relay local · dados persistidos neste servidor</div>
      </div>
    </aside>
  <main class="page" id="overview">
    <header class="hero">
      <div class="brand">
        <div class="mark" aria-hidden="true">L</div>
        <div>
          <h1>Visão geral</h1>
          <p class="subtitle">Saúde do Relay, atividade e administração do Lantern</p>
        </div>
      </div>
      <div class="hero-actions">
        <div class="live-pill" aria-live="polite">
          <span id="status-dot" class="dot"></span>
          <span id="status-text">Atualizando...</span>
        </div>
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

    <section class="content" id="activity">
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

    <section class="card admin-section" id="administration" aria-label="Administração do Relay">
      <div class="section-header" style="padding:0 0 14px">
        <div>
          <h2 class="section-title">Administração</h2>
          <div class="section-meta">Disponível somente no localhost deste servidor</div>
        </div>
        <span id="admin-state" class="section-meta">Autenticação necessária</span>
      </div>

      <div id="admin-login" class="admin-panel">
        <form id="admin-login-form" class="admin-form two">
          <input id="admin-username" autocomplete="username" placeholder="Usuário com acesso administrativo" required>
          <input id="admin-password" type="password" autocomplete="current-password" placeholder="Senha" required>
          <button type="submit">Entrar na administração</button>
        </form>
      </div>

      <div id="admin-content" class="admin-grid hidden">
        <div class="admin-primary">
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
            <h3>Contas de usuário</h3>
            <div id="admin-users" class="admin-users"></div>
          </div>
        </div>
        <div class="admin-operations">
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
          <div class="admin-panel">
            <h3>Operação e auditoria</h3>
            <button id="create-backup" class="admin-action secondary" type="button">Criar backup consistente</button>
            <div id="admin-audit" class="admin-audit"></div>
          </div>
          <div class="admin-panel">
            <h3>Sessões dos clientes</h3>
            <div class="section-meta">Revogue dispositivos perdidos ou acessos que não reconhece.</div>
            <div id="admin-sessions" class="admin-users admin-sessions-list"></div>
          </div>
          <div class="admin-panel">
            <h3>Redefinições de senha</h3>
            <div class="section-meta">Solicitações enviadas pela tela de acesso.</div>
            <div id="admin-password-resets" class="admin-users"></div>
          </div>
        </div>
      </div>
      <div id="admin-feedback" class="admin-feedback"></div>
    </section>

    <footer id="store-path" class="footer"></footer>
  </main>
  </div>

  <script>
    const $ = (id) => document.getElementById(id);
    const dashboardNavLinks = Array.from(document.querySelectorAll('.nav-link'));
    const setActiveDashboardSection = (hash) => {
      const target = hash || '#overview';
      for (const link of dashboardNavLinks) {
        link.classList.toggle('active', link.getAttribute('href') === target);
      }
    };
    for (const link of dashboardNavLinks) {
      link.addEventListener('click', () => setActiveDashboardSection(link.getAttribute('href')));
    }
    window.addEventListener('hashchange', () => setActiveDashboardSection(window.location.hash));
    setActiveDashboardSection(window.location.hash);
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
      setText('metric-endpoint', (data.tls ? 'wss://' : 'ws://') + data.host + ':' + data.port);
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

    const dashboardApiUrl = '/api/status';

    let adminCsrf = sessionStorage.getItem('lantern.admin.csrf') || '';
    const syncAdminSession = async () => {
      const response = await fetch('/api/admin/session', {
        method: 'GET', credentials: 'same-origin', cache: 'no-store'
      });
      if (!response.ok) {
        adminCsrf = '';
        sessionStorage.removeItem('lantern.admin.csrf');
        return false;
      }
      const body = await response.json().catch(() => ({}));
      adminCsrf = typeof body.csrfToken === 'string' ? body.csrfToken : '';
      if (adminCsrf) sessionStorage.setItem('lantern.admin.csrf', adminCsrf);
      return adminCsrf.length > 0;
    };
    const adminFetch = async (url, options = {}) => {
      const headers = Object.assign(
        { 'content-type': 'application/json' },
        options.headers || {}
      );
      const method = options.method || 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        const sessionReady = await syncAdminSession();
        if (!sessionReady) {
          return new Response(JSON.stringify({ ok: false, error: 'UNAUTHORIZED' }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          });
        }
        headers['x-lantern-csrf'] = adminCsrf;
      }
      const requestOptions = Object.assign({}, options, {
        headers,
        credentials: 'same-origin',
        cache: 'no-store'
      });
      const response = await fetch(url, requestOptions);
      if (response.status === 401) {
        adminCsrf = '';
        sessionStorage.removeItem('lantern.admin.csrf');
      }
      return response;
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
          save.disabled = true;
          save.textContent = 'Salvando…';
          const response = await adminFetch('/api/admin/users/' + encodeURIComponent(user.userId), {
            method: 'PATCH', body: JSON.stringify({ department: department.value })
          });
          const body = await response.json().catch(() => ({}));
          save.disabled = false;
          save.textContent = 'Salvar setor';
          setAdminFeedback(response.ok
            ? 'Setor de ' + user.displayName + ' atualizado.'
            : response.status === 401
              ? 'A sessão administrativa expirou. Entre novamente para salvar o setor.'
              : (body.message || 'Não foi possível atualizar o setor.'));
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
        const toggle = make('button', 'admin-action ' + (user.disabled ? 'secondary' : 'danger'), user.disabled ? 'Reativar' : 'Desativar');
        toggle.disabled = user.role === 'admin';
        toggle.addEventListener('click', async () => {
          const action = user.disabled ? 'reativar' : 'desativar';
          if (!confirm('Deseja ' + action + ' a conta de ' + user.displayName + '?')) return;
          const response = await adminFetch('/api/admin/users/' + encodeURIComponent(user.userId), {
            method: 'PATCH', body: JSON.stringify({ disabled: !user.disabled })
          });
          setAdminFeedback(response.ok ? (user.disabled ? 'Conta reativada.' : 'Conta desativada e removida das listas de contatos.') : 'Não foi possível alterar o estado da conta.');
          if (response.ok) void loadAdmin();
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
        fields.appendChild(toggle);
        fields.appendChild(remove);
        item.appendChild(head);
        item.appendChild(fields);
        list.appendChild(item);
      }
    };

    const renderAudit = (entries) => {
      const list = $('admin-audit');
      if (!list) return;
      clear(list);
      for (const entry of entries || []) {
        const item = make('div', 'admin-audit-row');
        item.appendChild(make('strong', '', entry.action || 'evento'));
        item.appendChild(make('span', '', formatTime(entry.createdAt) + ' · ' + (entry.actor || 'sistema')));
        list.appendChild(item);
      }
      if (!entries || entries.length === 0) list.appendChild(make('span', 'section-meta', 'Nenhum evento registrado.'));
    };

    const renderSessions = (sessions) => {
      const list = $('admin-sessions');
      if (!list) return;
      clear(list);
      for (const session of sessions || []) {
        const item = make('div', 'admin-user');
        const head = make('div', 'admin-user-head');
        const identity = make('div');
        identity.appendChild(make('div', 'name', session.displayName || session.username));
        identity.appendChild(make(
          'div',
          'status',
          '@' + session.username + ' · dispositivo ' + String(session.deviceId || '').slice(0, 12)
        ));
        head.appendChild(identity);
        head.appendChild(make('span', 'chip', 'Ativa'));
        const fields = make('div', 'admin-user-fields');
        fields.appendChild(make('span', 'section-meta', 'Último acesso: ' + formatTime(session.lastSeenAt)));
        const revoke = make('button', 'admin-action danger', 'Revogar sessão');
        revoke.addEventListener('click', async () => {
          if (!confirm('Revogar esta sessão de ' + (session.displayName || session.username) + '?')) return;
          const response = await adminFetch('/api/admin/sessions/' + encodeURIComponent(session.sessionId), {
            method: 'DELETE'
          });
          setAdminFeedback(response.ok ? 'Sessão revogada e conexão encerrada.' : 'Falha ao revogar sessão.');
          if (response.ok) void loadAdmin();
        });
        fields.appendChild(revoke);
        item.appendChild(head);
        item.appendChild(fields);
        list.appendChild(item);
      }
      if (!sessions || sessions.length === 0) list.appendChild(make('span', 'section-meta', 'Nenhuma sessão ativa.'));
    };

    const renderPasswordResetRequests = (requests) => {
      const list = $('admin-password-resets');
      if (!list) return;
      clear(list);
      for (const request of requests || []) {
        const item = make('div', 'admin-user');
        const head = make('div', 'admin-user-head');
        const identity = make('div');
        identity.appendChild(make('div', 'name', request.displayName || request.username));
        identity.appendChild(make('div', 'status', '@' + request.username + ' · solicitada em ' + formatTime(request.requestedAt)));
        head.appendChild(identity);
        head.appendChild(make('span', 'chip', request.status === 'approved' ? 'Aprovada' : 'Pendente'));
        const fields = make('div', 'admin-user-fields');
        if (request.status === 'pending') {
          const approve = make('button', 'admin-action secondary', 'Aprovar');
          approve.addEventListener('click', async () => {
            const response = await adminFetch('/api/admin/password-reset-requests/' + encodeURIComponent(request.requestId), {
              method: 'POST', body: JSON.stringify({ action: 'approve' })
            });
            setAdminFeedback(response.ok ? 'Redefinição aprovada por 30 minutos.' : 'Não foi possível aprovar a solicitação.');
            if (response.ok) void loadAdmin();
          });
          const reject = make('button', 'admin-action danger', 'Rejeitar');
          reject.addEventListener('click', async () => {
            const response = await adminFetch('/api/admin/password-reset-requests/' + encodeURIComponent(request.requestId), {
              method: 'POST', body: JSON.stringify({ action: 'reject' })
            });
            setAdminFeedback(response.ok ? 'Solicitação rejeitada.' : 'Não foi possível rejeitar a solicitação.');
            if (response.ok) void loadAdmin();
          });
          fields.appendChild(approve);
          fields.appendChild(reject);
        } else {
          fields.appendChild(make('span', 'section-meta', 'Válida até ' + formatTime(request.expiresAt)));
        }
        item.appendChild(head);
        item.appendChild(fields);
        list.appendChild(item);
      }
      if (!requests || requests.length === 0) list.appendChild(make('span', 'section-meta', 'Nenhuma solicitação pendente.'));
    };

    const loadAdmin = async () => {
      const sessionReady = await syncAdminSession();
      if (!sessionReady) {
        $('dashboard-shell').classList.add('auth-locked');
        $('admin-login').classList.remove('hidden');
        $('admin-content').classList.add('hidden');
        setText('admin-state', 'Autenticação necessária');
        return;
      }
      const usersResponse = await adminFetch('/api/admin/users', { method: 'GET' });
      if (!usersResponse.ok) {
        $('dashboard-shell').classList.add('auth-locked');
        $('admin-login').classList.remove('hidden');
        $('admin-content').classList.add('hidden');
        setText('admin-state', 'Autenticação necessária');
        return;
      }
      const usersBody = await usersResponse.json();
      const retentionResponse = await adminFetch('/api/admin/retention', { method: 'GET' });
      const retentionBody = retentionResponse.ok ? await retentionResponse.json() : { policy: 'forever' };
      const auditResponse = await adminFetch('/api/admin/audit?limit=50', { method: 'GET' });
      const auditBody = auditResponse.ok ? await auditResponse.json() : { entries: [] };
      const sessionsResponse = await adminFetch('/api/admin/sessions', { method: 'GET' });
      const sessionsBody = sessionsResponse.ok ? await sessionsResponse.json() : { sessions: [] };
      const resetRequestsResponse = await adminFetch('/api/admin/password-reset-requests', { method: 'GET' });
      const resetRequestsBody = resetRequestsResponse.ok ? await resetRequestsResponse.json() : { requests: [] };
      $('admin-login').classList.add('hidden');
      $('admin-content').classList.remove('hidden');
      $('dashboard-shell').classList.remove('auth-locked');
      setText('admin-state', 'Sessão administrativa ativa');
      const retention = $('retention-policy');
      if (retention) retention.value = retentionBody.policy || 'forever';
      renderAdminUsers(usersBody.users || []);
      renderAudit(auditBody.entries || []);
      renderSessions(sessionsBody.sessions || []);
      renderPasswordResetRequests(resetRequestsBody.requests || []);
    };

    $('admin-login-form').addEventListener('submit', async (event) => {
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

    $('admin-create-user').addEventListener('submit', async (event) => {
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

    $('retention-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const response = await adminFetch('/api/admin/retention', {
        method: 'PUT', body: JSON.stringify({ policy: $('retention-policy').value })
      });
      setAdminFeedback(response.ok ? 'Política de retenção atualizada.' : 'Falha ao atualizar retenção.');
    });

    $('create-backup').addEventListener('click', async () => {
      setAdminFeedback('Criando backup consistente do banco canônico…');
      const response = await adminFetch('/api/admin/backup', { method: 'POST', body: '{}' });
      const body = await response.json().catch(() => ({}));
      setAdminFeedback(response.ok
        ? 'Backup criado em ' + body.backup.file
        : (body.message || 'Falha ao criar backup.'));
      if (response.ok) void loadAdmin();
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
    setInterval(() => {
      const adminContent = $('admin-content');
      if (!adminContent.classList.contains('hidden') && !adminContent.contains(document.activeElement)) {
        void loadAdmin();
      }
    }, 30000);
  </script>
</body>
</html>`;

export class LanternRelay {
  private readonly config: RelayConfig;
  private readonly httpServer: HttpServer | HttpsServer;
  private readonly wsServer: WebSocketServer;
  private readonly startedAt = Date.now();
  private readonly groupStore: GroupStore;
  private readonly centralStore: CentralStore;
  private readonly sessionsBySocket = new Map<WebSocket, RelaySession>();
  private readonly userSessions = new SessionRegistry<RelaySession>();
  private readonly announcementsById = new Map<string, RelayAnnouncementState>();
  private stopPromise: Promise<void> | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private presenceBroadcastTimer: NodeJS.Timeout | null = null;
  private announcementSweepTimer: NodeJS.Timeout | null = null;
  private groupSweepTimer: NodeJS.Timeout | null = null;
  private calendarAutomationTimer: NodeJS.Timeout | null = null;
  private calendarAutomationRunning = false;
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
      LEGACY_GROUP_STORE_FILE,
      GROUP_ATTACHMENTS_DIR,
      logRelay,
      this.centralStore.getEncryption(),
      {
        location: this.centralStore.getDatabaseFile(),
        read: <T>(key: string, version?: number) =>
          this.centralStore.readCanonicalState<T>(key, version),
        write: <T>(key: string, value: T, version?: number) =>
          this.centralStore.writeCanonicalState(key, value, version)
      }
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
    this.startCalendarAutomationLoop();

    logRelay('started', {
      endpoint: `${this.config.tlsCertFile ? 'wss' : 'ws'}://${this.config.host}:${this.config.port}`,
      version: RELAY_VERSION,
      mode: this.config.externalMode ? 'external' : 'local',
      tls: Boolean(this.config.tlsCertFile),
      announcementStoreFile: this.centralStore.getDatabaseFile(),
      groupStoreFile: this.groupStore.getStoreFile(),
      groupAttachmentsDir: this.groupStore.getAttachmentsDir(),
      stickersDir: RELAY_STICKERS_DIR,
      stickersAvailable: this.listStickerCatalog().length,
      centralStore: this.centralStore.getStats()
    });
  }

  createCanonicalBackup() {
    return this.centralStore.createBackup([
      { name: 'group-attachments', source: GROUP_ATTACHMENTS_DIR },
      { name: 'stickers', source: RELAY_STICKERS_DIR }
    ], 'relay-ui');
  }

  getManagementSnapshot() {
    return {
      users: this.centralStore.listUsers(),
      passwordResetRequests: this.centralStore.listPasswordResetRequests(),
      announcementTtlMs: this.centralStore.getAnnouncementTtlMs(),
      announcements: this.listDashboardAnnouncements(this.listDashboardPeers(Date.now()), Date.now()),
      calendarAutomation: this.getCalendarAutomationSettings(),
      stickers: this.listStickerCatalog()
    };
  }

  addManagedStickers(input: { sourcePaths: string[]; category?: string; replaceExisting?: boolean }): ManagedStickerImportResult {
    const sourcePaths = Array.isArray(input?.sourcePaths)
      ? [...new Set(input.sourcePaths.map((value) => String(value || '').trim()).filter(Boolean))]
      : [];
    if (sourcePaths.length === 0) throw new Error('Selecione pelo menos uma GIF.');
    if (sourcePaths.length > 100) throw new Error('Importe no máximo 100 GIFs por vez.');
    const category = normalizeStickerCategory(String(input?.category || ''));
    const targetDir = category ? path.join(RELAY_STICKERS_DIR, category) : RELAY_STICKERS_DIR;
    fs.mkdirSync(targetDir, { recursive: true });
    const addedPaths = new Set<string>();
    const replacedPaths = new Set<string>();
    const imports = sourcePaths.map((sourcePath) => {
      if (!fs.existsSync(sourcePath)) throw new Error(`Arquivo não encontrado: ${path.basename(sourcePath)}`);
      const stat = fs.statSync(sourcePath);
      if (!stat.isFile() || !this.isValidStickerFile(sourcePath, stat.size)) {
        throw new Error(`${path.basename(sourcePath)} não é uma GIF válida ou excede 20 MB.`);
      }
      const fileName = normalizeStickerFileName(path.basename(sourcePath));
      const relativePath = category ? `${category}/${fileName}` : fileName;
      const targetPath = path.join(targetDir, fileName);
      const exists = fs.existsSync(targetPath);
      if (exists && !input.replaceExisting) {
        throw new Error(`${fileName} já existe em ${category || 'Geral'}. Marque a opção de substituir para continuar.`);
      }
      return { sourcePath, fileName, relativePath, targetPath, exists };
    });
    const uniqueTargets = new Set(imports.map((item) => item.targetPath.toLocaleLowerCase('pt-BR')));
    if (uniqueTargets.size !== imports.length) {
      throw new Error('A seleção contém GIFs diferentes que resultam no mesmo nome. Importe-as separadamente.');
    }

    for (const { sourcePath, fileName, relativePath, targetPath, exists } of imports) {
      const temporaryPath = path.join(targetDir, `.${fileName}.${randomUUID()}.tmp`);
      try {
        fs.copyFileSync(sourcePath, temporaryPath);
        if (!this.isValidStickerFile(temporaryPath, fs.statSync(temporaryPath).size)) {
          throw new Error(`${fileName} não pôde ser validada depois da cópia.`);
        }
        fs.copyFileSync(temporaryPath, targetPath);
      } finally {
        try { fs.unlinkSync(temporaryPath); } catch { /* arquivo temporário já removido */ }
      }
      (exists ? replacedPaths : addedPaths).add(relativePath);
    }

    const catalog = this.listStickerCatalog();
    return {
      added: catalog.filter((item) => addedPaths.has(item.relativePath)),
      replaced: catalog.filter((item) => replacedPaths.has(item.relativePath))
    };
  }

  updateManagedSticker(relativePathValue: string, input: ManagedStickerUpdate): RelayStickerItem {
    const relativePath = normalizeStickerRelativePath(String(relativePathValue || ''));
    if (!relativePath) throw new Error('GIF inválida.');
    const sourcePath = path.join(RELAY_STICKERS_DIR, ...relativePath.split('/'));
    if (!fs.existsSync(sourcePath)) throw new Error('GIF não encontrada no Relay.');
    const category = normalizeStickerCategory(String(input?.category || ''));
    const fileName = normalizeStickerFileName(String(input?.label || ''));
    const nextRelativePath = category ? `${category}/${fileName}` : fileName;
    const targetPath = path.join(RELAY_STICKERS_DIR, ...nextRelativePath.split('/'));
    if (path.resolve(sourcePath) !== path.resolve(targetPath) && fs.existsSync(targetPath)) {
      throw new Error('Já existe uma GIF com esse nome na categoria escolhida.');
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    if (path.resolve(sourcePath) !== path.resolve(targetPath)) {
      fs.renameSync(sourcePath, targetPath);
      const previousCategoryDir = path.dirname(sourcePath);
      if (previousCategoryDir !== RELAY_STICKERS_DIR) {
        try { if (fs.readdirSync(previousCategoryDir).length === 0) fs.rmdirSync(previousCategoryDir); } catch { /* mantém a pasta */ }
      }
    }
    const updated = this.listStickerCatalog().find((item) => item.relativePath === nextRelativePath);
    if (!updated) throw new Error('A GIF foi movida, mas não pôde ser validada no catálogo.');
    return updated;
  }

  removeManagedSticker(relativePathValue: string): { relativePath: string } {
    const relativePath = normalizeStickerRelativePath(String(relativePathValue || ''));
    if (!relativePath) throw new Error('GIF inválida.');
    const filePath = path.join(RELAY_STICKERS_DIR, ...relativePath.split('/'));
    if (!fs.existsSync(filePath)) throw new Error('GIF não encontrada no Relay.');
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('O item selecionado não é uma GIF.');
    fs.unlinkSync(filePath);
    const categoryDir = path.dirname(filePath);
    if (categoryDir !== RELAY_STICKERS_DIR) {
      try { if (fs.readdirSync(categoryDir).length === 0) fs.rmdirSync(categoryDir); } catch { /* mantém a pasta */ }
    }
    return { relativePath };
  }

  getManagedStickerPreview(relativePathValue: string): string | null {
    const relativePath = normalizeStickerRelativePath(String(relativePathValue || ''));
    if (!relativePath) return null;
    const filePath = path.join(RELAY_STICKERS_DIR, ...relativePath.split('/'));
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > RELAY_STICKER_PREVIEW_MAX_BYTES || !this.isValidStickerFile(filePath, stat.size)) return null;
    return `data:image/gif;base64,${fs.readFileSync(filePath).toString('base64')}`;
  }

  createManagedUser(input: { username: string; displayName: string; department?: string; password: string; role?: 'admin' | 'user' }) {
    const user = this.centralStore.createUser(input, 'relay-ui');
    this.broadcastDirectory();
    return user;
  }

  updateManagedUser(userId: string, input: { displayName?: string; department?: string; disabled?: boolean; role?: 'admin' | 'user' }) {
    const user = this.centralStore.updateManagedUserAtomic(userId, input, 'relay-ui');
    if (user.disabled) this.disconnectDisabledUser(userId);
    this.broadcastDirectory();
    this.bumpPresenceRevision('relay_ui_user_updated');
    this.broadcastPresence('relay_ui_user_updated');
    return user;
  }

  resetManagedUserPassword(userId: string, password: string): void {
    this.centralStore.resetPassword(userId, password, 'relay-ui');
  }

  deleteManagedUser(userId: string): void {
    this.disconnectDisabledUser(userId);
    this.centralStore.deleteUser(userId, 'relay-ui');
    this.broadcastDirectory();
    this.bumpPresenceRevision('relay_ui_user_deleted');
    this.broadcastPresence('relay_ui_user_deleted');
  }

  reviewManagedPasswordReset(requestId: string, approve: boolean) {
    return this.centralStore.reviewPasswordResetRequest(requestId, approve, 'relay-ui');
  }

  setAnnouncementExpiryPolicy(ttlMs: number): number {
    return this.centralStore.setAnnouncementTtlMs(ttlMs, 'relay-ui');
  }

  setActiveAnnouncementExpiry(messageId: string, expiresAt: number): void {
    const state = this.announcementsById.get(messageId);
    if (!state || state.deletedAt || state.expiredAt) throw new Error('Anúncio ativo não encontrado.');
    const normalized = Math.trunc(Number(expiresAt));
    if (!Number.isFinite(normalized) || normalized <= Date.now()) throw new Error('Informe uma expiração futura.');
    state.expiresAt = normalized;
    this.announcementsById.set(messageId, state);
    if (!this.persistAnnouncementStore()) throw new Error('Não foi possível persistir a nova expiração.');
  }

  async stop(reason = 'shutdown'): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStop(reason);
    return this.stopPromise;
  }

  private async performStop(reason: string): Promise<void> {
    if (!this.persistAnnouncementStore()) {
      throw new Error('Falha ao persistir anúncios durante o encerramento do Relay.');
    }

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
    if (this.calendarAutomationTimer) {
      clearInterval(this.calendarAutomationTimer);
      this.calendarAutomationTimer = null;
    }
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
    this.userSessions.clear();
    this.announcementsById.clear();

    await new Promise<void>((resolve) => {
      this.wsServer.close(() => resolve());
    });

    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve());
    });

    // Mantém a persistência disponível até que HTTP, WebSocket e callbacks de
    // encerramento não possam mais iniciar operações canônicas.
    this.groupStore.close();
    this.centralStore.close();

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
          port: String(this.config.port),
          secure: String(Boolean(this.config.tlsCertFile))
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

  private getCalendarAutomationState(): CalendarAutomationState {
    const stored = this.centralStore.readCanonicalState<Partial<CalendarAutomationState>>('calendar-automation', 1);
    return {
      version: 1,
      enabled: stored?.enabled === true,
      url: typeof stored?.url === 'string' ? stored.url : '',
      updateTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(stored?.updateTime || '')) ? String(stored?.updateTime) : '08:00',
      lastRunDate: typeof stored?.lastRunDate === 'string' ? stored.lastRunDate : '',
      lastRunAt: Number(stored?.lastRunAt) || 0,
      lastError: typeof stored?.lastError === 'string' ? stored.lastError : '',
      seenEventIds: stored?.seenEventIds && typeof stored.seenEventIds === 'object' ? stored.seenEventIds : {}
    };
  }

  private saveCalendarAutomationState(state: CalendarAutomationState): void {
    this.centralStore.writeCanonicalState('calendar-automation', state, 1);
  }

  getCalendarAutomationSettings() {
    const { seenEventIds, ...settings } = this.getCalendarAutomationState();
    return { ...settings, publishedEvents: Object.keys(seenEventIds).length };
  }

  configureCalendarAutomation(input: { enabled?: boolean; url?: string; updateTime?: string }) {
    const state = this.getCalendarAutomationState();
    const url = input.url === undefined ? state.url : String(input.url).trim();
    const updateTime = input.updateTime === undefined ? state.updateTime : String(input.updateTime).trim();
    if (url) {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('O calendário deve usar uma URL HTTP ou HTTPS.');
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(updateTime)) throw new Error('Informe um horário válido para atualização.');
    if (input.enabled === true && !url) throw new Error('Informe o link ICS antes de ativar a automação.');
    const next = { ...state, enabled: input.enabled === undefined ? state.enabled : input.enabled, url, updateTime, lastError: '' };
    this.saveCalendarAutomationState(next);
    return this.getCalendarAutomationSettings();
  }

  async runCalendarAutomationNow(): Promise<{ eventsFound: number; announcementsCreated: number }> {
    return this.runCalendarAutomation(true);
  }

  private startCalendarAutomationLoop(): void {
    if (this.calendarAutomationTimer) return;
    const check = () => { void this.runCalendarAutomation(false).catch((error) => logRelay('calendar_automation_failed', { message: error instanceof Error ? error.message : String(error) }, { level: 'warn' })); };
    this.calendarAutomationTimer = setInterval(check, 30_000);
    this.calendarAutomationTimer.unref?.();
    check();
  }

  private async runCalendarAutomation(force: boolean): Promise<{ eventsFound: number; announcementsCreated: number }> {
    if (this.calendarAutomationRunning) throw new Error('A atualização do calendário já está em andamento.');
    const state = this.getCalendarAutomationState();
    if (!state.url || (!force && !state.enabled)) return { eventsFound: 0, announcementsCreated: 0 };
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (!force && (state.lastRunDate === today || currentTime < state.updateTime || (state.lastRunAt > 0 && Date.now() - state.lastRunAt < 15 * 60_000))) return { eventsFound: 0, announcementsCreated: 0 };
    this.calendarAutomationRunning = true;
    try {
      const events = await fetchCalendarEventsForDay(state.url, now);
      let announcementsCreated = 0;
      for (const event of events) {
        if (state.seenEventIds[event.id]) continue;
        const published = await this.publishCalendarEvent(event);
        state.seenEventIds[event.id] = Date.now();
        if (published) announcementsCreated += 1;
      }
      state.seenEventIds = Object.fromEntries(Object.entries(state.seenEventIds).sort((a, b) => b[1] - a[1]).slice(0, 2000));
      state.lastRunDate = today; state.lastRunAt = Date.now(); state.lastError = '';
      this.saveCalendarAutomationState(state);
      logRelay('calendar_automation_completed', { eventsFound: events.length, announcementsCreated });
      return { eventsFound: events.length, announcementsCreated };
    } catch (error) {
      state.lastRunAt = Date.now(); state.lastError = error instanceof Error ? error.message : String(error);
      this.saveCalendarAutomationState(state);
      throw error;
    } finally { this.calendarAutomationRunning = false; }
  }

  private async publishCalendarEvent(event: CalendarAutomationEvent): Promise<boolean> {
    const formatTime = (value: number) => new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
    const lines = [`📅 ${event.title}`, event.allDay ? 'Evento de dia inteiro' : `${formatTime(event.start)} – ${formatTime(event.end)}`];
    if (event.location) lines.push(`📍 ${event.location}`);
    if (event.description) lines.push('', event.description.slice(0, 1200));
    const frame: RelayTransportFrame = { type: 'announce', messageId: `calendar-${event.id}`, from: 'relay-calendar', to: null, createdAt: Date.now(), payload: { text: lines.join('\n'), calendarEventId: event.id, calendarEventStart: event.start, automated: true } };
    const saved = this.centralStore.saveFrame({ messageId: frame.messageId, type: frame.type, senderUserId: frame.from, targetUserId: null, conversationId: 'announcements', createdAt: frame.createdAt, payload: frame.payload });
    if (saved !== 'inserted') return false;
    this.trackAnnouncement(frame);
    await this.routeFrame(frame, null);
    return true;
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
        peersOnline: this.userSessions.userCount
      });
      return;
    }

    if (requestUrl.pathname === '/lantern') {
      res.writeHead(302, { location: '/app/' });
      res.end();
      return;
    }

    if (requestUrl.pathname === '/lantern-icon.png') {
      this.serveDashboardIcon(method, res);
      return;
    }

    if (requestUrl.pathname === '/app') {
      res.writeHead(308, { location: '/app/' });
      res.end();
      return;
    }

    if (requestUrl.pathname.startsWith('/app/')) {
      this.serveWebClient(requestUrl.pathname, method, res);
      return;
    }

    // Compatibilidade com documentos abertos anteriormente em /app sem a
    // barra final, que podem resolver assets relativos a partir da raiz.
    if (requestUrl.pathname.startsWith('/assets/')) {
      this.serveWebClient(`/app${requestUrl.pathname}`, method, res);
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

    if (requestUrl.pathname.startsWith('/api/client/') && !this.isClientTransportAllowed(req)) {
      this.writeJson(res, method, {
        ok: false,
        error: 'TLS_REQUIRED',
        message: 'Conexões externas exigem HTTPS/WSS.'
      }, 426);
      return;
    }

    if (requestUrl.pathname === '/api/client/password-reset/request' && method === 'POST') {
      const remoteAddress = this.normalizeRemoteAddress(req.socket.remoteAddress || 'unknown');
      const rateLimitKey = `password-reset:${remoteAddress}`;
      const previousAttempt = this.loginAttemptsByAddress.get(rateLimitKey);
      if (previousAttempt && previousAttempt.blockedUntil > Date.now()) {
        this.writeJson(res, method, {
          ok: false,
          error: 'TOO_MANY_ATTEMPTS',
          message: 'Muitas solicitações. Aguarde um minuto e tente novamente.'
        }, 429);
        return;
      }
      const body = await this.readJsonBody(req);
      const request = this.centralStore.requestPasswordReset(asString(body.username) || '');
      const failures = previousAttempt && previousAttempt.blockedUntil === 0
        ? previousAttempt.failures + 1
        : 1;
      this.loginAttemptsByAddress.set(rateLimitKey, {
        failures,
        blockedUntil: failures >= 5 ? Date.now() + 60_000 : 0
      });
      this.writeJson(res, method, {
        ok: true,
        requestToken: request?.token || createSessionToken(),
        message: 'Se o usuário estiver ativo, a solicitação aparecerá para o administrador.'
      }, 202);
      return;
    }

    if (requestUrl.pathname === '/api/client/password-reset/status' && method === 'GET') {
      const token = requestUrl.searchParams.get('token') || '';
      this.writeJson(res, method, {
        ok: true,
        status: this.centralStore.getPasswordResetStatus(token)
      });
      return;
    }

    if (requestUrl.pathname === '/api/client/password-reset/complete' && method === 'POST') {
      const body = await this.readJsonBody(req);
      try {
        this.centralStore.completePasswordReset(
          asString(body.requestToken) || '',
          asString(body.username) || '',
          typeof body.newPassword === 'string' ? body.newPassword : ''
        );
        this.writeJson(res, method, { ok: true });
      } catch (error) {
        this.writeJson(res, method, {
          ok: false,
          error: 'PASSWORD_RESET_FAILED',
          message: error instanceof Error ? error.message : String(error)
        }, 400);
      }
      return;
    }

    if (requestUrl.pathname === '/api/client/password' && method === 'POST') {
      const token = this.getBearerToken(req);
      const account = token ? this.centralStore.authenticate(token) : null;
      if (!account || !token) {
        this.writeJson(res, method, { ok: false, error: 'UNAUTHORIZED' }, 401);
        return;
      }
      try {
        const body = await this.readJsonBody(req);
        this.centralStore.changePassword(
          account.userId,
          typeof body.currentPassword === 'string' ? body.currentPassword : '',
          typeof body.newPassword === 'string' ? body.newPassword : '',
          token
        );
        this.writeJson(res, method, { ok: true });
      } catch (error) {
        this.writeJson(res, method, {
          ok: false,
          error: 'PASSWORD_CHANGE_FAILED',
          message: error instanceof Error ? error.message : String(error)
        }, 400);
      }
      return;
    }

    if (requestUrl.pathname === '/api/client/profile-setup' && method === 'PATCH') {
      const token = this.getBearerToken(req);
      const account = token ? this.centralStore.authenticate(token) : null;
      if (!account) {
        this.writeJson(res, method, { ok: false, error: 'UNAUTHORIZED' }, 401);
        return;
      }
      try {
        const body = await this.readJsonBody(req);
        const user = this.centralStore.completeProfileSetup(account.userId, {
          avatarEmoji: asString(body.avatarEmoji) || '',
          avatarBg: asString(body.avatarBg) || ''
        });
        this.writeJson(res, method, { ok: true, user });
      } catch (error) {
        this.writeJson(res, method, {
          ok: false,
          error: 'INVALID_PROFILE_SETUP',
          message: error instanceof Error ? error.message : String(error)
        }, 400);
      }
      return;
    }

    if (requestUrl.pathname === '/api/client/preferences' && method === 'GET') {
      const token = this.getBearerToken(req);
      const account = token ? this.centralStore.authenticate(token) : null;
      this.writeJson(
        res,
        method,
        account
          ? { ok: true, preferences: this.centralStore.getUserPreferences(account.userId) }
          : { ok: false, error: 'UNAUTHORIZED' },
        account ? 200 : 401
      );
      return;
    }

    if (requestUrl.pathname === '/api/client/preferences/conversation' && method === 'PUT') {
      const token = this.getBearerToken(req);
      const account = token ? this.centralStore.authenticate(token) : null;
      if (!account) {
        this.writeJson(res, method, { ok: false, error: 'UNAUTHORIZED' }, 401);
        return;
      }
      try {
        const body = await this.readJsonBody(req);
        this.centralStore.setUserConversationPreference(account.userId, {
          conversationId: asString(body.conversationId) || '',
          pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
          archived: typeof body.archived === 'boolean' ? body.archived : undefined,
          manualUnread: typeof body.manualUnread === 'boolean' ? body.manualUnread : undefined,
          readAt: typeof body.readAt === 'number' ? body.readAt : undefined
        });
        this.writeJson(res, method, { ok: true });
      } catch (error) {
        this.writeJson(res, method, { ok: false, error: 'INVALID_PREFERENCE', message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (requestUrl.pathname === '/api/client/preferences/message' && method === 'PUT') {
      const token = this.getBearerToken(req);
      const account = token ? this.centralStore.authenticate(token) : null;
      if (!account) {
        this.writeJson(res, method, { ok: false, error: 'UNAUTHORIZED' }, 401);
        return;
      }
      try {
        const body = await this.readJsonBody(req);
        this.centralStore.setUserMessagePreference(account.userId, {
          messageId: asString(body.messageId) || '',
          favorite: typeof body.favorite === 'boolean' ? body.favorite : undefined,
          hidden: typeof body.hidden === 'boolean' ? body.hidden : undefined
        });
        this.writeJson(res, method, { ok: true });
      } catch (error) {
        this.writeJson(res, method, { ok: false, error: 'INVALID_PREFERENCE', message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (requestUrl.pathname === '/api/client/export' && method === 'GET') {
      const token = this.getBearerToken(req);
      const account = token ? this.centralStore.authenticate(token) : null;
      if (!account) {
        this.writeJson(res, method, { ok: false, error: 'UNAUTHORIZED' }, 401);
        return;
      }
      try {
        const conversationId = requestUrl.searchParams.get('conversationId') || '';
        const preferences = this.centralStore.getUserPreferences(account.userId);
        const hiddenIds = new Set(preferences.messages.filter((item) => item.hidden).map((item) => item.messageId));
        let title = 'Conversa';
        let records: Array<{ messageId: string; senderUserId: string; type: 'text' | 'file'; text: string; fileName: string; fileSize: number; createdAt: number; editedAt: number }>;
        if (conversationId.startsWith('dm:')) {
          const peerUserId = conversationId.slice(3).trim();
          const peer = this.centralStore.getUser(peerUserId);
          if (!peer) throw new Error('Contato não encontrado.');
          title = peer.displayName;
          records = this.centralStore.exportConversationMessages(account.userId, peerUserId);
        } else if (conversationId.startsWith('group:')) {
          const groupId = conversationId.slice('group:'.length).trim();
          const group = this.groupStore.getGroup(groupId);
          if (!group) throw new Error('Grupo não encontrado.');
          title = group.name;
          records = this.groupStore.exportMessagesForDevice(groupId, account.userId);
        } else {
          throw new Error('Esta conversa não pode ser exportada.');
        }
        const users = Object.fromEntries(
          this.centralStore.listUsers().map((user) => [user.userId, user.displayName])
        );
        this.writeJson(res, method, {
          ok: true,
          title,
          records: records.filter((record) => !hiddenIds.has(record.messageId)),
          users
        });
      } catch (error) {
        this.writeJson(res, method, { ok: false, error: 'EXPORT_FAILED', message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (requestUrl.pathname === '/api/client/logout' && method === 'POST') {
      const token = this.getBearerToken(req);
      if (token) this.centralStore.logout(token);
      this.writeJson(res, method, { ok: true });
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
      const adminSession = this.centralStore.getAdminSession(adminToken, csrfToken);
      if (!adminSession) {
        this.writeJson(res, method, { ok: false, error: 'UNAUTHORIZED' }, 401);
        return;
      }

      if (requestUrl.pathname === '/api/admin/session' && method === 'GET') {
        this.writeJson(res, method, {
          ok: true,
          csrfToken: adminSession.csrfToken
        });
        return;
      }

      if (requestUrl.pathname === '/api/admin/users' && method === 'GET') {
        this.writeJson(res, method, { ok: true, users: this.centralStore.listUsers() });
        return;
      }
      if (requestUrl.pathname === '/api/admin/password-reset-requests' && method === 'GET') {
        this.writeJson(res, method, {
          ok: true,
          requests: this.centralStore.listPasswordResetRequests()
        });
        return;
      }
      const passwordResetRequestMatch = requestUrl.pathname.match(/^\/api\/admin\/password-reset-requests\/([^/]+)$/);
      if (passwordResetRequestMatch && method === 'POST') {
        const body = await this.readJsonBody(req);
        try {
          const request = this.centralStore.reviewPasswordResetRequest(
            decodeURIComponent(passwordResetRequestMatch[1]),
            body.action === 'approve',
            adminSession.userId
          );
          this.writeJson(res, method, { ok: true, request });
        } catch (error) {
          this.writeJson(res, method, {
            ok: false,
            error: 'PASSWORD_RESET_REVIEW_FAILED',
            message: error instanceof Error ? error.message : String(error)
          }, 400);
        }
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
          }, adminSession.userId);
          this.broadcastDirectory();
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
          const userId = decodeURIComponent(userMatch[1]);
          let user = this.centralStore.updateUser(userId, {
            displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
            department: typeof body.department === 'string' ? body.department : undefined,
            disabled: typeof body.disabled === 'boolean' ? body.disabled : undefined,
            locale: body.locale === 'en' || body.locale === 'es' || body.locale === 'pt-BR' ? body.locale : undefined
          }, adminSession.userId);
          if (body.role === 'admin' || body.role === 'user') {
            user = this.centralStore.setUserRole(userId, body.role, adminSession.userId);
          }
          this.writeJson(res, method, { ok: true, user });
          if (user.disabled) this.disconnectDisabledUser(userId);
          this.broadcastDirectory();
          this.bumpPresenceRevision('directory_updated');
          this.broadcastPresence('directory_updated');
        } catch (error) {
          this.writeJson(res, method, { ok: false, error: 'UPDATE_FAILED', message: error instanceof Error ? error.message : String(error) }, 400);
        }
        return;
      }
      if (userMatch && method === 'DELETE') {
        try {
          const userId = decodeURIComponent(userMatch[1]);
          this.disconnectDisabledUser(userId);
          this.centralStore.deleteUser(userId, adminSession.userId);
          this.writeJson(res, method, { ok: true });
          this.broadcastDirectory();
          this.bumpPresenceRevision('directory_updated');
          this.broadcastPresence('directory_updated');
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
            typeof body.password === 'string' ? body.password : '',
            adminSession.userId
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
        const policy = this.centralStore.setRetentionPolicy(
          body.policy as RetentionPolicy,
          adminSession.userId
        );
        this.writeJson(res, method, { ok: true, policy });
        return;
      }
      if (requestUrl.pathname === '/api/admin/audit' && method === 'GET') {
        const limit = Math.max(1, Math.min(Number(requestUrl.searchParams.get('limit')) || 100, 500));
        this.writeJson(res, method, { ok: true, entries: this.centralStore.listAudit(limit) });
        return;
      }
      if (requestUrl.pathname === '/api/admin/sessions' && method === 'GET') {
        this.writeJson(res, method, { ok: true, sessions: this.centralStore.listSessions() });
        return;
      }
      const sessionMatch = requestUrl.pathname.match(/^\/api\/admin\/sessions\/([a-f0-9]{64})$/);
      if (sessionMatch && method === 'DELETE') {
        const sessionId = sessionMatch[1];
        const revoked = this.centralStore.revokeSession(sessionId, adminSession.userId);
        if (revoked) {
          for (const relaySession of Array.from(this.sessionsBySocket.values())) {
            if (relaySession.authToken && hashToken(relaySession.authToken) === sessionId) {
              this.dropSession(relaySession, 'session-revoked');
            }
          }
        }
        this.writeJson(res, method, { ok: true, revoked });
        return;
      }
      if (requestUrl.pathname === '/api/admin/backup' && method === 'POST') {
        try {
          const backup = await this.centralStore.createBackup([
            { name: 'group-attachments', source: GROUP_ATTACHMENTS_DIR },
            { name: 'stickers', source: RELAY_STICKERS_DIR }
          ], adminSession.userId);
          this.writeJson(res, method, { ok: true, backup }, 201);
        } catch (error) {
          this.writeJson(res, method, {
            ok: false,
            error: 'BACKUP_FAILED',
            message: error instanceof Error ? error.message : String(error)
          }, 500);
        }
        return;
      }
    }

    if (requestUrl.pathname === '/api/status') {
      const adminToken = this.getCookie(req, 'lantern_admin');
      if (!this.centralStore.getAdminSession(adminToken)) {
        this.writeJson(res, method, {
          ok: false,
          error: 'UNAUTHORIZED',
          message: 'Autenticação administrativa necessária.'
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
    const privateAddress = /^10\./.test(address) || /^192\.168\./.test(address) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(address) || /^fd[0-9a-f]{2}:/i.test(address) ||
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

  private serveWebClient(pathname: string, method: string, res: ServerResponse): void {
    if (method !== 'GET' && method !== 'HEAD') {
      this.writeJson(res, method, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
      return;
    }
    const rendererRoots = [
      path.resolve(__dirname, '..', 'dist-renderer'),
      path.resolve(process.cwd(), 'dist-renderer'),
      path.resolve(path.dirname(process.execPath), 'dist-renderer')
    ];
    const rendererRoot = rendererRoots.find((candidate) => fs.existsSync(path.join(candidate, 'index.html')));
    if (!rendererRoot) {
      this.writeJson(res, method, {
        ok: false,
        error: 'WEB_CLIENT_NOT_BUILT',
        message: 'O cliente web não foi encontrado. Execute npm run build:renderer.'
      }, 503);
      return;
    }
    let relativePath = pathname === '/app' || pathname === '/app/'
      ? 'index.html'
      : pathname.slice('/app/'.length);
    try {
      relativePath = decodeURIComponent(relativePath);
    } catch {
      relativePath = '';
    }
    const resolved = path.resolve(rendererRoot, relativePath || 'index.html');
    const insideRoot = resolved === rendererRoot || resolved.startsWith(`${rendererRoot}${path.sep}`);
    const filePath = insideRoot && fs.existsSync(resolved) && fs.statSync(resolved).isFile()
      ? resolved
      : path.join(rendererRoot, 'index.html');
    const extension = path.extname(filePath).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff2': 'font/woff2'
    };
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'content-type': contentTypes[extension] || 'application/octet-stream',
      'content-length': String(stat.size),
      'cache-control': extension === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; frame-src 'self' data: blob:; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  }

  private serveDashboardIcon(method: string, res: ServerResponse): void {
    const candidates = [
      path.resolve(__dirname, '..', 'assets', 'icon.png'),
      path.resolve(process.cwd(), 'assets', 'icon.png'),
      path.resolve(path.dirname(process.execPath), 'assets', 'icon.png')
    ];
    const iconFile = candidates.find((candidate) => fs.existsSync(candidate));
    if (!iconFile) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(method === 'HEAD' ? undefined : 'Ícone não encontrado.');
      return;
    }
    const stat = fs.statSync(iconFile);
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': stat.size,
      'cache-control': 'public, max-age=86400'
    });
    if (method === 'HEAD') res.end();
    else fs.createReadStream(iconFile).pipe(res);
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

  getDashboardSnapshot(): RelayDashboardSnapshot {
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
      tls: Boolean(this.config.tlsCertFile),
      peersOnline: peers.length,
      sessionsOpen: this.sessionsBySocket.size,
      presenceRevision: this.presenceRevision,
      announcementStoreFile: this.centralStore.getDatabaseFile(),
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
    for (const session of this.listPrimarySessions()) {
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
        const text = asString(payload?.text) || asString(payload?.bodyText) ||
          (asString(payload?.filename) ? `📎 ${asString(payload?.filename)}` : '(sem texto)');
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
      clientDeviceId: null,
      lastSeenAt: Date.now(),
      isAlive: true,
      messageQueue: Promise.resolve(),
      groupFileDownloadQueue: Promise.resolve(),
      attachmentDownloadQueue: Promise.resolve(),
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
      case 'relay:history:request':
        this.handleCanonicalHistoryRequest(session, envelope.payload);
        return;
      case 'relay:search:request':
        this.handleCanonicalSearchRequest(session, envelope.payload);
        return;
      case 'relay:media:list:request':
        this.handleCanonicalMediaListRequest(session, envelope.payload);
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
        session.attachmentDownloadQueue = session.attachmentDownloadQueue
          .catch(() => undefined)
          .then(() => this.handleCentralAttachmentRequest(session, envelope.payload))
          .catch((error) => {
            logRelay('attachment_download_queue_failed', {
              sessionId: session.sessionId,
              deviceId: session.peer?.deviceId || null,
              message: error instanceof Error ? error.message : String(error)
            }, { level: 'warn' });
          });
        return;
      case 'relay:send':
        await this.handleRelaySend(session, envelope.payload);
        return;
      default:
        this.sendError(session, 'UNKNOWN_TYPE', `Tipo não suportado: ${envelope.type}`);
    }
  }

  private handleCanonicalHistoryRequest(session: RelaySession, payload: unknown): void {
    if (!session.peer) {
      this.sendError(session, 'NOT_AUTHENTICATED', 'Autenticação necessária.');
      return;
    }
    const record = asRecord(payload);
    const requestId = asString(record?.requestId);
    const peerUserId = asString(record?.peerUserId);
    if (!requestId || !peerUserId) {
      this.sendError(session, 'INVALID_HISTORY_REQUEST', 'Página de histórico inválida.');
      return;
    }
    const before = asFiniteNumber(record?.before) || Number.MAX_SAFE_INTEGER;
    const beforeSeq = asFiniteNumber(record?.beforeSeq) || Number.MAX_SAFE_INTEGER;
    const limit = Math.max(1, Math.min(Math.trunc(asFiniteNumber(record?.limit) || 100), 500));
    const frames = this.centralStore
      .listConversationFramesForUser(session.peer.deviceId, peerUserId, before, limit, beforeSeq)
      .map((frame) => ({
        serverSeq: frame.serverSeq,
        type: frame.type,
        messageId: frame.messageId,
        from: frame.senderUserId,
        to: frame.targetUserId,
        createdAt: frame.createdAt,
        payload: frame.payload
      }));
    this.sendEnvelope(session.socket, {
      type: 'relay:history:page',
      payload: { requestId, frames, hasMore: frames.length === limit }
    });
  }

  private handleCanonicalSearchRequest(session: RelaySession, payload: unknown): void {
    if (!session.peer) {
      this.sendError(session, 'NOT_AUTHENTICATED', 'Autenticação necessária.');
      return;
    }
    const record = asRecord(payload);
    const requestId = asString(record?.requestId);
    const peerUserId = asString(record?.peerUserId);
    const query = asString(record?.query);
    if (!requestId || !peerUserId || !query) {
      this.sendError(session, 'INVALID_SEARCH_REQUEST', 'Pesquisa canônica inválida.');
      return;
    }
    const messageIds = this.centralStore.searchConversationMessageIds(
      session.peer.deviceId,
      peerUserId,
      query,
      asFiniteNumber(record?.limit) || 500,
      asFiniteNumber(record?.offset) || 0
    );
    this.sendEnvelope(session.socket, {
      type: 'relay:search:results',
      payload: { requestId, messageIds }
    });
  }

  private handleCanonicalMediaListRequest(session: RelaySession, payload: unknown): void {
    if (!session.peer) {
      this.sendError(session, 'NOT_AUTHENTICATED', 'Autenticação necessária.');
      return;
    }
    const record = asRecord(payload);
    const requestId = asString(record?.requestId);
    const peerUserId = asString(record?.peerUserId);
    const kind = record?.kind === 'media' ? 'media' : record?.kind === 'document' ? 'document' : null;
    const rawCursor = asRecord(record?.cursor);
    if (!requestId || !peerUserId || !kind) {
      this.sendError(session, 'INVALID_MEDIA_REQUEST', 'Consulta de mídia inválida.');
      return;
    }
    try {
      const page = this.centralStore.listConversationMedia(
        session.peer.deviceId,
        peerUserId,
        kind,
        rawCursor && typeof rawCursor.createdAt === 'number' && typeof rawCursor.messageId === 'string'
          ? { createdAt: rawCursor.createdAt, messageId: rawCursor.messageId }
          : null,
        asFiniteNumber(record?.limit) || 40
      );
      this.sendEnvelope(session.socket, {
        type: 'relay:media:list:results',
        payload: { requestId, ...page }
      });
    } catch (error) {
      this.sendEnvelope(session.socket, {
        type: 'relay:media:list:results',
        payload: {
          requestId,
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        }
      });
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

  private async handleCentralAttachmentRequest(session: RelaySession, payload: unknown): Promise<void> {
    if (!session.peer) return;
    const record = asRecord(payload);
    const requestId = asString(record?.requestId) || randomUUID();
    const attachmentId = asString(record?.attachmentId) || '';
    const startIndex = Math.max(0, Math.trunc(asFiniteNumber(record?.startIndex) || 0));
    try {
      const metadata = this.centralStore.getAttachmentMetadata(attachmentId, session.peer.deviceId);
      const started = await this.sendEnvelopeWithStatus(session.socket, {
        type: 'relay:attachment:start',
        payload: { requestId, ...metadata, startIndex }
      });
      if (!started) throw new Error('Conexão encerrada durante o início do download.');
      for (let index = startIndex; index < metadata.totalChunks; index += 1) {
        const delivered = await this.sendEnvelopeWithStatus(session.socket, {
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
        if (!delivered) throw new Error(`Conexão encerrada no bloco ${index}.`);
      }
      await this.sendEnvelopeWithStatus(session.socket, {
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

    const wasOnline = this.userSessions.hasUser(canonicalDeviceId);
    for (const existing of this.getSessionsForUser(canonicalDeviceId)) {
      if (existing !== session && existing.clientDeviceId === hello.deviceId) {
        this.sendEnvelope(existing.socket, {
          type: 'relay:error',
          payload: {
            code: 'SESSION_REPLACED',
            message: 'Esta conexão foi substituída por uma reconexão do mesmo dispositivo.'
          }
        });
        this.dropSession(existing, 'same-device-reconnected', { suppressPresence: true });
      }
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
    session.clientDeviceId = hello.deviceId;
    session.lastSeenAt = now;
    this.registerUserSession(canonicalDeviceId, session);

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
        // Apenas um índice leve (último frame por conversa); o histórico é paginado sob demanda.
        frames: this.centralStore.listLatestConversationFramesForUser(canonicalDeviceId).map((frame) => ({
          type: frame.type,
          messageId: frame.messageId,
          from: frame.senderUserId,
          to: frame.targetUserId,
          createdAt: frame.createdAt,
          payload: frame.payload
        }))
      }
    });
    this.sendDirectory(session);

    if (!wasOnline) this.bumpPresenceRevision('peer_online');
    this.sendPresenceSnapshot(session);
    this.sendAnnouncementSnapshot(session, 'peer_online');
    this.sendGroupSnapshot(session, 'peer_online');
    this.sendKnownExpiredAnnouncements(session);
    if (!wasOnline) {
      this.broadcastPresenceDelta({
        op: 'upsert',
        peer: this.clonePeerWithLiveSeen(session.peer)
      }, 'peer_online');
    }
    logRelay('peer_online', {
      deviceId: canonicalDeviceId,
      username: account.username,
      displayName: account.displayName,
      department: account.department,
      totalOnline: this.userSessions.userCount,
      sessionsForUser: this.getSessionsForUser(canonicalDeviceId).length
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
    for (const sibling of this.getSessionsForUser(session.peer.deviceId)) {
      if (!sibling.peer) continue;
      sibling.peer = {
        ...sibling.peer,
        displayName: account.displayName,
        department: account.department,
        avatarEmoji: account.avatarEmoji,
        avatarBg: account.avatarBg,
        statusMessage: account.statusMessage,
        lastSeenAt: Date.now()
      };
    }
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
        for (const recipient of this.getSessionsForUser(deviceId)) {
          this.sendEnvelope(recipient.socket, {
            type: 'relay:group:event',
            payload: {
              serverTime: Date.now(),
              event
            }
          });
        }
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
        case 'history': {
          const history = this.groupStore.historyPageForDevice(
            asString(data.groupId) || '',
            session.peer.deviceId,
            asFiniteNumber(data.before) || Number.MAX_SAFE_INTEGER,
            Math.max(1, Math.min(Math.trunc(asFiniteNumber(data.limit) || 100), 500))
          );
          response = history;
          break;
        }
        case 'search': {
          const groupId = asString(data.groupId) || '';
          // A consulta ao GroupStore valida que o solicitante continua membro.
          this.groupStore.searchMessageIdsForDevice(
            groupId,
            session.peer.deviceId,
            asString(data.query) || '',
            1,
            0
          );
          response = {
            messageIds: this.centralStore.searchGroupMessageIds(
              groupId,
              asString(data.query) || '',
              asFiniteNumber(data.limit) || 500,
              asFiniteNumber(data.offset) || 0
            )
          };
          break;
        }
        case 'media': {
          const groupId = asString(data.groupId) || '';
          const kind = data.kind === 'media' ? 'media' : data.kind === 'document' ? 'document' : null;
          if (!kind) throw new Error('Tipo de mídia inválido.');
          const rawCursor = asRecord(data.cursor);
          const hiddenMessageIds = new Set(
            this.centralStore.getUserPreferences(session.peer.deviceId).messages
              .filter((item) => item.hidden)
              .map((item) => item.messageId)
          );
          response = {
            ...this.groupStore.listMediaForDevice(
              groupId,
              session.peer.deviceId,
              kind,
              rawCursor && typeof rawCursor.createdAt === 'number' && typeof rawCursor.messageId === 'string'
                ? { createdAt: rawCursor.createdAt, messageId: rawCursor.messageId }
                : null,
              asFiniteNumber(data.limit) || 40,
              hiddenMessageIds
            )
          };
          break;
        }
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

    if (frame.to) {
      const target = this.centralStore.getUser(frame.to);
      if (!target || target.disabled) {
        this.sendError(session, 'UNKNOWN_TARGET', 'Destinatário canônico inexistente ou desativado.', frame.messageId);
        return;
      }
    }

    if (frame.type === 'chat:clear' && frame.to) {
      this.centralStore.clearConversationForUser(session.peer.deviceId, frame.to);
      this.sendEnvelope(session.socket, {
        type: 'relay:send:ack',
        payload: { frameMessageId: frame.messageId, deliveredTo: [] }
      });
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
    if (frame.type === 'announce' || (frame.type === 'file:offer' && frame.to === null)) {
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

    const deliveredTo = await this.routeFrame(outboundFrame, session);

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

  private async routeFrame(frame: RelayTransportFrame, senderSession: RelaySession | null): Promise<string[]> {
    const deliveredUsers = new Set<string>();
    if (frame.to === null) {
      const recipients = this.userSessions.entries()
        .map(([userId, recipient]) => ({ userId, recipient }))
        .filter(({ recipient }) => recipient !== senderSession);
      const results = await Promise.all(
        recipients.map(async ({ userId, recipient }) => {
          const delivered = await this.sendEnvelopeWithStatus(recipient.socket, {
            type: 'relay:deliver',
            payload: { frame }
          });
          return { userId, recipient, delivered };
        })
      );

      for (const result of results) {
        const { userId, recipient, delivered } = result;
        if (delivered) {
          if (userId !== senderSession?.peer?.deviceId) deliveredUsers.add(userId);
          continue;
        }
        this.dropSession(recipient, 'send-failed');
      }
      return Array.from(deliveredUsers);
    }

    for (const recipient of this.getSessionsForUser(frame.to)) {
      if (recipient === senderSession) continue;
      const delivered = await this.sendEnvelopeWithStatus(recipient.socket, {
        type: 'relay:deliver',
        payload: { frame }
      });
      if (delivered) deliveredUsers.add(frame.to);
      else this.dropSession(recipient, 'send-failed');
    }
    if (senderSession?.peer) {
      for (const sibling of this.getSessionsForUser(senderSession.peer.deviceId)) {
        if (sibling === senderSession) continue;
        const delivered = await this.sendEnvelopeWithStatus(sibling.socket, {
          type: 'relay:deliver',
          payload: { frame }
        });
        if (!delivered) this.dropSession(sibling, 'send-failed');
      }
    }
    return Array.from(deliveredUsers);
  }

  private trackAnnouncement(frame: RelayTransportFrame): void {
    const createdAt =
      Number.isFinite(frame.createdAt) && frame.createdAt > 0
        ? Math.trunc(frame.createdAt)
        : Date.now();
    const expiresAt = createdAt + this.centralStore.getAnnouncementTtlMs();
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
    // Persistência write-through: o ACK ao remetente só é enviado depois que
    // o anúncio está confirmado em uma transação do SQLite.
    if (!this.persistAnnouncementStore()) {
      throw new Error('O anúncio não pôde ser confirmado no armazenamento do Relay.');
    }
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
    if (state.frame.type !== 'announce') {
      return {
        ok: false,
        code: 'ANNOUNCEMENT_NOT_EDITABLE',
        message: 'Anexos de anúncios não podem ser editados.'
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
    if (!this.persistAnnouncementStore()) {
      throw new Error('A edição do anúncio não pôde ser persistida.');
    }

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
      if (!this.persistAnnouncementStore()) {
        throw new Error('A exclusão do anúncio não pôde ser persistida.');
      }
      return;
    }
    state.deletedAt = deletedAt;
    state.expiredAt = state.expiredAt || deletedAt;
    state.reactionsByDeviceId = {};
    state.readByDeviceId = {};
    this.announcementsById.set(messageId, state);
    if (!this.persistAnnouncementStore()) {
      throw new Error('A exclusão do anúncio não pôde ser persistida.');
    }
    this.broadcastAnnouncementExpiry([messageId], 'announcement_deleted');
    this.centralStore.purgeAnnouncementFrames([messageId]);
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
    if (!this.persistAnnouncementStore()) {
      throw new Error('A reação do anúncio não pôde ser persistida.');
    }
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

    if (!this.persistAnnouncementStore()) {
      throw new Error('A leitura do anúncio não pôde ser persistida.');
    }
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
      if (!this.persistAnnouncementStore()) return;
    }
    if (expiredNow.length > 0) {
      this.broadcastAnnouncementExpiry(expiredNow, reason);
      this.centralStore.purgeAnnouncementFrames(expiredNow);
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

  private persistAnnouncementStore(): boolean {
    try {
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
      this.centralStore.writeCanonicalState(
        ANNOUNCEMENT_STATE_KEY,
        payload,
        ANNOUNCEMENT_STATE_VERSION
      );
      return true;
    } catch (error) {
      logRelay(
        'announcement_store_persist_failed',
        {
          file: this.centralStore.getDatabaseFile(),
          message: error instanceof Error ? error.message : String(error)
        },
        { level: 'warn', rateKey: 'announcement_store_persist_failed', rateLimitMs: 20_000 }
      );
      return false;
    }
  }

  private loadAnnouncementStore(): void {
    try {
      let parsed = this.centralStore.readCanonicalState<{ announcements?: unknown[] }>(
        ANNOUNCEMENT_STATE_KEY,
        ANNOUNCEMENT_STATE_VERSION
      );
      let importedLegacy = false;
      if (!parsed && fs.existsSync(LEGACY_ANNOUNCEMENT_STORE_FILE)) {
        const raw = fs.readFileSync(LEGACY_ANNOUNCEMENT_STORE_FILE, 'utf8');
        parsed = this.centralStore.unprotectJson<{ announcements?: unknown[] } | null>(raw);
        importedLegacy = true;
      }
      const list = Array.isArray(parsed?.announcements) ? parsed!.announcements : [];
      let loaded = 0;
      let recoveredFromFrames = 0;

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

      // canonical_frames é uma segunda fonte durável. Ela permite reconstruir
      // anúncios cujo estado relacional tenha sido apagado por uma interrupção
      // ou por versões antigas do encerramento não idempotente.
      const now = Date.now();
      const staleFrameIds: string[] = [];
      for (const storedFrame of this.centralStore.listAnnouncementFrames()) {
        if (this.announcementsById.has(storedFrame.messageId)) continue;
        const createdAt = Math.trunc(storedFrame.createdAt);
        const expiresAt = createdAt + this.centralStore.getAnnouncementTtlMs();
        if (expiresAt <= now) {
          staleFrameIds.push(storedFrame.messageId);
          continue;
        }
        this.announcementsById.set(storedFrame.messageId, {
          messageId: storedFrame.messageId,
          createdAt,
          expiresAt,
          expiredAt: null,
          deletedAt: null,
          reactionsByDeviceId: {},
          readByDeviceId: {},
          frame: {
            type: storedFrame.type,
            messageId: storedFrame.messageId,
            from: storedFrame.senderUserId,
            to: null,
            createdAt,
            payload: storedFrame.payload
          }
        });
        recoveredFromFrames += 1;
      }
      if (staleFrameIds.length > 0) {
        this.centralStore.purgeAnnouncementFrames(staleFrameIds);
      }

      this.sweepAnnouncements('store_load');
      if (importedLegacy || recoveredFromFrames > 0) {
        this.persistAnnouncementStore();
        logRelay(importedLegacy ? 'announcement_store_migrated_to_sqlite' : 'announcement_store_recovered', {
          legacyFile: LEGACY_ANNOUNCEMENT_STORE_FILE,
          databaseFile: this.centralStore.getDatabaseFile(),
          recoveredFromFrames
        });
      }
      logRelay('announcement_store_loaded', {
        file: this.centralStore.getDatabaseFile(),
        loaded,
        recoveredFromFrames,
        importedLegacy
      });
    } catch (error) {
      logRelay(
        'announcement_store_load_failed',
        {
          file: this.centralStore.getDatabaseFile(),
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
      if (this.userSessions.remove(peer.deviceId, session)) {
        if (!suppressPresence) {
          logRelay('peer_offline', {
            deviceId: peer.deviceId,
            displayName: peer.displayName,
            reason,
            totalOnline: this.userSessions.userCount
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
    return this.listPrimarySessions()
      .map((session) => session.peer)
      .filter((peer): peer is RelayPeerInfo => Boolean(peer))
      .map((peer) => this.clonePeerWithLiveSeen(peer))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'));
  }

  private getSessionsForUser(userId: string): RelaySession[] {
    return this.userSessions.forUser(userId);
  }

  private registerUserSession(userId: string, session: RelaySession): void {
    this.userSessions.add(userId, session);
  }

  private listPrimarySessions(): RelaySession[] {
    return this.userSessions.primarySessions();
  }

  private clonePeerWithLiveSeen(peer: RelayPeerInfo): RelayPeerInfo {
    return {
      ...peer,
      lastSeenAt: Date.now()
    };
  }

  private sendDirectory(session: RelaySession): void {
    const viewerId = session.peer?.deviceId;
    if (!viewerId) return;
    this.sendEnvelope(session.socket, {
      type: 'relay:directory',
      payload: {
        users: this.centralStore.listVisibleUsersForUser(viewerId).map((user) => ({
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
  }

  private broadcastDirectory(): void {
    for (const session of this.sessionsBySocket.values()) {
      if (session.peer) this.sendDirectory(session);
    }
  }

  private disconnectDisabledUser(userId: string): void {
    for (const session of this.getSessionsForUser(userId)) {
      this.sendEnvelope(session.socket, {
        type: 'relay:error',
        payload: { code: 'ACCOUNT_DISABLED', message: 'Esta conta foi desativada pelo administrador.' }
      });
      this.dropSession(session, 'account-disabled');
    }
  }

  private sendPresenceSnapshot(session: RelaySession): void {
    const viewerId = session.peer?.deviceId || '';
    this.sendEnvelope(session.socket, {
      type: 'relay:presence',
      payload: {
        serverTime: Date.now(),
        revision: this.presenceRevision,
        peers: this.listPeers().filter((peer) =>
          peer.deviceId !== viewerId && this.centralStore.isUserVisibleTo(viewerId, peer.deviceId)
        )
      }
    });
  }

  private broadcastPresence(reason = 'update'): void {
    const peers = this.listPeers();
    const periodic = reason === 'periodic';
    logRelay('presence_broadcast', {
      reason,
      revision: this.presenceRevision,
      recipients: this.sessionsBySocket.size,
      peersOnline: peers.length
    }, {
      level: periodic ? 'debug' : 'info',
      rateKey: periodic ? 'presence_broadcast_periodic' : undefined,
      rateLimitMs: periodic ? 20_000 : undefined
    });
    for (const session of this.sessionsBySocket.values()) {
      const viewerId = session.peer?.deviceId || '';
      this.sendEnvelope(session.socket, {
        type: 'relay:presence',
        payload: {
          serverTime: Date.now(),
          revision: this.presenceRevision,
          peers: peers.filter((peer) =>
            peer.deviceId !== viewerId && this.centralStore.isUserVisibleTo(viewerId, peer.deviceId)
          )
        }
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
      const viewerId = session.peer?.deviceId || '';
      if (input.op === 'upsert' &&
          (input.peer.deviceId === viewerId || !this.centralStore.isUserVisibleTo(viewerId, input.peer.deviceId))) {
        continue;
      }
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

export const createRelayFromEnvironment = (): LanternRelay => new LanternRelay({ ...config });

if (require.main === module) {
  const relay = createRelayFromEnvironment();
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

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (error) => console.error('[LanternRelay] uncaughtException:', error));
  process.on('unhandledRejection', (reason) => console.error('[LanternRelay] unhandledRejection:', reason));

  void relay.start().catch((error) => {
    logRelay('startup_failed', {
      message: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
  });
}
