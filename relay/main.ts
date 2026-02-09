import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer, IncomingMessage, Server as HttpServer } from 'node:http';
import path from 'node:path';
import BonjourService, { Service } from 'bonjour-service';
import { RawData, WebSocket, WebSocketServer } from 'ws';

const RELAY_VERSION = '1.0.0';
const RELAY_MDNS_TYPE = 'lanternrelay';
const RELAY_MDNS_PROTOCOL = 'tcp';
const ANNOUNCEMENT_TTL_MS = 24 * 60 * 60 * 1000;
const ANNOUNCEMENT_EXPIRED_RETENTION_MS = 12 * 60 * 60 * 1000;
const ANNOUNCEMENT_SWEEP_INTERVAL_MS = 15_000;
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
  frame: RelayTransportFrame;
}

const DEFAULT_CONFIG: RelayConfig = {
  host: '0.0.0.0',
  port: 43190,
  pingIntervalMs: 4_000,
  peerTimeoutMs: 12_000,
  presenceBroadcastIntervalMs: 25_000,
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

class LanternRelay {
  private readonly config: RelayConfig;
  private readonly httpServer: HttpServer;
  private readonly wsServer: WebSocketServer;
  private readonly sessionsBySocket = new Map<WebSocket, RelaySession>();
  private readonly sessionsByDeviceId = new Map<string, RelaySession>();
  private readonly announcementsById = new Map<string, RelayAnnouncementState>();
  private announcementPersistTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private presenceBroadcastTimer: NodeJS.Timeout | null = null;
  private announcementSweepTimer: NodeJS.Timeout | null = null;
  private bonjour: BonjourService | null = null;
  private published: Service | null = null;
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

  private handleHttpRequest(req: IncomingMessage, res: import('node:http').ServerResponse): void {
    if (req.url === '/health') {
      const body = JSON.stringify({
        ok: true,
        version: RELAY_VERSION,
        uptimeSec: Math.floor(process.uptime()),
        peersOnline: this.sessionsByDeviceId.size
      });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
      return;
    }

    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('LanternRelay online\n');
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
      this.handleMessage(session, raw);
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

  private handleMessage(session: RelaySession, raw: RawData): void {
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
      case 'relay:send':
        this.handleRelaySend(session, envelope.payload);
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
      this.dropSession(existing, 'session-replaced');
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

  private handleRelaySend(session: RelaySession, payload: unknown): void {
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

    const deliveredTo = this.routeFrame(frame, session.peer.deviceId);
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

  private routeFrame(frame: RelayTransportFrame, senderDeviceId: string | null): string[] {
    const deliveredTo: string[] = [];
    if (frame.to === null) {
      for (const [deviceId, recipient] of this.sessionsByDeviceId.entries()) {
        if (senderDeviceId && deviceId === senderDeviceId) continue;
        this.sendEnvelope(recipient.socket, {
          type: 'relay:deliver',
          payload: { frame }
        });
        deliveredTo.push(deviceId);
      }
      return deliveredTo;
    }

    const recipient = this.sessionsByDeviceId.get(frame.to);
    if (!recipient) {
      return deliveredTo;
    }

    this.sendEnvelope(recipient.socket, {
      type: 'relay:deliver',
      payload: { frame }
    });
    deliveredTo.push(frame.to);
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
    this.sendEnvelope(session.socket, {
      type: 'relay:announcement:snapshot',
      payload: {
        serverTime: Date.now(),
        frames,
        reactions
      }
    });
    logRelay(
      'announcement_snapshot_sent',
      {
        deviceId: session.peer?.deviceId || null,
        reason,
        count: frames.length,
        reactions: Object.keys(reactions).length
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
        const reactionsByDeviceId = Object.fromEntries(
          Object.entries(rawReactions).filter((entry) =>
            typeof entry[0] === 'string' &&
            ALLOWED_ANNOUNCEMENT_REACTIONS.has(entry[1] as AnnouncementReactionValue)
          )
        ) as Record<string, AnnouncementReactionValue>;
        if (!messageId || !frame || !createdAt || !expiresAt) continue;
        this.announcementsById.set(messageId, {
          messageId,
          frame,
          createdAt: Math.trunc(createdAt),
          expiresAt: Math.trunc(expiresAt),
          expiredAt: expiredAt ? Math.trunc(expiredAt) : null,
          deletedAt: deletedAt ? Math.trunc(deletedAt) : null,
          reactionsByDeviceId
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

  private dropSession(session: RelaySession, reason: string): void {
    const current = this.sessionsBySocket.get(session.socket);
    if (!current) return;

    this.sessionsBySocket.delete(session.socket);
    const peer = session.peer;
    if (peer) {
      const mapped = this.sessionsByDeviceId.get(peer.deviceId);
      if (mapped === session) {
        this.sessionsByDeviceId.delete(peer.deviceId);
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
