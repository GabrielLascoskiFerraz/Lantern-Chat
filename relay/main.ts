import { randomUUID } from 'node:crypto';
import { createSocket, type RemoteInfo, type Socket as UdpSocket } from 'node:dgram';
import fs from 'node:fs';
import { createServer, IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import path from 'node:path';
import BonjourService, { Service } from 'bonjour-service';
import { RawData, WebSocket, WebSocketServer } from 'ws';

const RELAY_VERSION = '1.0.0';
const RELAY_MDNS_TYPE = 'lanternrelay';
const RELAY_MDNS_PROTOCOL = 'tcp';
const RELAY_DISCOVERY_UDP_QUERY = 'lantern:relay:discover';
const RELAY_DISCOVERY_UDP_RESPONSE = 'lantern:relay:announce';
const ANNOUNCEMENT_TTL_MS = 24 * 60 * 60 * 1000;
const ANNOUNCEMENT_EXPIRED_RETENTION_MS = 12 * 60 * 60 * 1000;
const ANNOUNCEMENT_SWEEP_INTERVAL_MS = 15_000;
const SEND_CALLBACK_TIMEOUT_MS = 10_000;
const resolveRelayDataDir = (): string => {
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

const OPEN_READY_STATE = 1;

type JsonRecord = Record<string, unknown>;

interface RelayConfig {
  host: string;
  port: number;
  pingIntervalMs: number;
  peerTimeoutMs: number;
  presenceBroadcastIntervalMs: number;
  maxPayloadBytes: number;
}

interface RelayPeerInfo {
  deviceId: string;
  displayName: string;
  avatarEmoji: string;
  avatarBg: string;
  statusMessage: string;
  appVersion: string;
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

interface RelaySession {
  sessionId: string;
  socket: WebSocket;
  peer: RelayPeerInfo | null;
  lastSeenAt: number;
  isAlive: boolean;
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
  peers: RelayDashboardPeer[];
  announcements: RelayDashboardAnnouncement[];
}

const DEFAULT_CONFIG: RelayConfig = {
  host: '0.0.0.0',
  port: 43190,
  pingIntervalMs: 5_000,
  peerTimeoutMs: 30_000,
  presenceBroadcastIntervalMs: 12_000,
  maxPayloadBytes: 8 * 1024 * 1024
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

  if (!deviceId || !displayName || !avatarEmoji || !avatarBg) {
    return null;
  }

  return {
    deviceId,
    displayName,
    avatarEmoji,
    avatarBg,
    statusMessage,
    appVersion
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

    @media (max-width: 880px) {
      .hero {
        align-items: flex-start;
        flex-direction: column;
      }

      .grid,
      .content {
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
      setText('peers-meta', String(data.peers.length) + ' online');
      setText('announcements-meta', String(data.announcements.length) + ' ativos');
      setText('store-path', 'Dados de anúncios: ' + data.announcementStoreFile);
      setText('status-text', 'Online · atualizado ' + new Date().toLocaleTimeString('pt-BR'));
      const dot = $('status-dot');
      if (dot) dot.classList.remove('offline');
      renderPeers(data.peers || []);
      renderAnnouncements(data.announcements || []);
    };

    const load = async () => {
      try {
        const response = await fetch('/api/status', { cache: 'no-store' });
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
    setInterval(load, 3000);
  </script>
</body>
</html>`;

class LanternRelay {
  private readonly config: RelayConfig;
  private readonly httpServer: HttpServer;
  private readonly wsServer: WebSocketServer;
  private readonly startedAt = Date.now();
  private readonly sessionsBySocket = new Map<WebSocket, RelaySession>();
  private readonly sessionsByDeviceId = new Map<string, RelaySession>();
  private readonly announcementsById = new Map<string, RelayAnnouncementState>();
  private announcementPersistTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private presenceBroadcastTimer: NodeJS.Timeout | null = null;
  private announcementSweepTimer: NodeJS.Timeout | null = null;
  private bonjour: BonjourService | null = null;
  private published: Service | null = null;
  private udpSocket: UdpSocket | null = null;
  private presenceRevision = 0;

  constructor(config: RelayConfig) {
    this.config = config;
    this.httpServer = createServer((req, res) => this.handleHttpRequest(req, res));
    this.wsServer = new WebSocketServer({
      server: this.httpServer,
      maxPayload: this.config.maxPayloadBytes
    });
    this.wsServer.on('connection', (socket) => this.handleConnection(socket));
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

    logRelay('started', {
      endpoint: `ws://${this.config.host}:${this.config.port}`,
      version: RELAY_VERSION,
      announcementStoreFile: ANNOUNCEMENT_STORE_FILE
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

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, {
        'content-type': 'application/json; charset=utf-8',
        allow: 'GET, HEAD'
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

    if (requestUrl.pathname === '/api/status') {
      this.writeJson(res, method, this.getDashboardSnapshot());
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
      isAlive: true
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
      void this.handleMessage(session, raw).catch((error) => {
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
      case 'relay:send':
        await this.handleRelaySend(session, envelope.payload);
        return;
      default:
        this.sendError(session, 'UNKNOWN_TYPE', `Tipo não suportado: ${envelope.type}`);
    }
  }

  private handleHello(session: RelaySession, payload: unknown): void {
    const hello = normalizeHelloPayload(payload);
    if (!hello) {
      this.sendError(session, 'INVALID_HELLO', 'Payload relay:hello inválido.');
      return;
    }

    const existing = this.sessionsByDeviceId.get(hello.deviceId);
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
      ...hello,
      connectedAt: session.peer?.connectedAt || now,
      lastSeenAt: now
    };
    session.lastSeenAt = now;
    this.sessionsByDeviceId.set(hello.deviceId, session);

    this.sendEnvelope(session.socket, {
      type: 'relay:hello:ok',
      payload: {
        sessionId: session.sessionId,
        serverTime: now
      }
    });

    this.bumpPresenceRevision('peer_online');
    this.sendPresenceSnapshot(session);
    this.sendAnnouncementSnapshot(session, 'peer_online');
    this.sendKnownExpiredAnnouncements(session);
    this.broadcastPresenceDelta({
      op: 'upsert',
      peer: this.clonePeerWithLiveSeen(session.peer)
    }, 'peer_online');
    logRelay('peer_online', {
      deviceId: hello.deviceId,
      displayName: hello.displayName,
      totalOnline: this.sessionsByDeviceId.size
    });
  }

  private handleUpdateProfile(session: RelaySession, payload: unknown): void {
    if (!session.peer) {
      this.sendError(session, 'NOT_AUTHENTICATED', 'Envie relay:hello antes de atualizar perfil.');
      return;
    }

    const normalized = normalizeHelloPayload({
      ...session.peer,
      ...(asRecord(payload) || {})
    });
    if (!normalized) {
      this.sendError(session, 'INVALID_PROFILE', 'Payload relay:updateProfile inválido.');
      return;
    }

    session.peer = {
      ...session.peer,
      ...normalized,
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
      this.sendError(session, 'FORBIDDEN_FROM', 'O campo "from" precisa ser o deviceId da sessão.');
      return;
    }

    const deliveredTo = await this.routeFrame(frame, session.peer.deviceId);
    if (frame.type === 'announce') {
      this.trackAnnouncement(frame);
    } else if (frame.type === 'chat:react' && frame.to === null) {
      this.applyAnnouncementReaction(frame);
    } else if (frame.type === 'chat:delete') {
      const targetMessageId = extractDeleteTargetMessageId(frame);
      if (targetMessageId) {
        this.markAnnouncementDeleted(targetMessageId, frame.createdAt);
      }
    }

    logRelay('frame_routed', {
      type: frame.type,
      from: frame.from,
      to: frame.to,
      messageId: frame.messageId,
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
      fs.writeFileSync(tmpFile, JSON.stringify(payload));
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
      const parsed = JSON.parse(raw) as { announcements?: unknown[] } | null;
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

  private sendError(session: RelaySession, code: string, message: string): void {
    logRelay('protocol_error', {
      sessionId: session.sessionId,
      deviceId: session.peer?.deviceId || null,
      code,
      message
    }, { level: 'warn' });
    this.sendEnvelope(session.socket, {
      type: 'relay:error',
      payload: { code, message }
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
      return false;
    }
    try {
      const payload = JSON.stringify(envelope);
      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve(false);
        }, SEND_CALLBACK_TIMEOUT_MS);
        timeout.unref?.();

        socket.send(payload, (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(!error);
        });
      });
    } catch {
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
  maxPayloadBytes: parseInteger(process.env.LANTERN_RELAY_MAX_PAYLOAD_BYTES, DEFAULT_CONFIG.maxPayloadBytes)
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
