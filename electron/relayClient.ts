import BonjourService, { Browser, Service } from 'bonjour-service';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { APP_VERSION } from './config';
import { Profile, ProtocolFrame } from './types';

interface RelayPeerSnapshot {
  deviceId: string;
  displayName: string;
  avatarEmoji: string;
  avatarBg: string;
  statusMessage: string;
  appVersion: string;
  connectedAt: number;
  lastSeenAt: number;
}

interface RelayPresencePayload {
  serverTime: number;
  revision?: number;
  peers: RelayPeerSnapshot[];
}

interface RelayPresenceDeltaPayload {
  serverTime: number;
  revision?: number;
  op: 'upsert' | 'remove';
  peer?: RelayPeerSnapshot;
  deviceId?: string;
}

interface RelaySendAckPayload {
  frameMessageId: string;
  deliveredTo: string[];
}

interface RelayErrorPayload {
  code?: string;
  message?: string;
}

interface RelayDeliverPayload {
  frame?: ProtocolFrame;
}

type RelayAnnouncementReactionValue = '👍' | '👎' | '❤️' | '😢' | '😊' | '😂';

type RelayAnnouncementReactionsByMessage = Record<
  string,
  Record<string, RelayAnnouncementReactionValue>
>;

interface RelayAnnouncementSnapshotPayload {
  serverTime: number;
  frames: ProtocolFrame[];
  reactions?: RelayAnnouncementReactionsByMessage;
}

interface RelayAnnouncementReactionsPayload {
  serverTime: number;
  messageId: string;
  reactions: Record<string, RelayAnnouncementReactionValue>;
}

interface RelayEnvelope {
  type: string;
  payload?: unknown;
}

interface RelaySendResult {
  deliveredTo: string[];
}

interface RelayConnectionState {
  connected: boolean;
  endpoint: string | null;
}

interface RelayEndpointSettings {
  automatic: boolean;
  host: string;
  port: number;
}

interface RelayClientCallbacks {
  onFrame: (frame: ProtocolFrame) => void;
  onPresence: (peers: RelayPeerSnapshot[]) => void;
  onAnnouncementExpired?: (messageIds: string[]) => void;
  onAnnouncementSnapshot?: (
    frames: ProtocolFrame[],
    reactions: RelayAnnouncementReactionsByMessage
  ) => void;
  onAnnouncementReactions?: (
    messageId: string,
    reactions: Record<string, RelayAnnouncementReactionValue>
  ) => void;
  onConnectionState?: (state: RelayConnectionState) => void;
  onWarning?: (message: string) => void;
}

interface PendingSendAck {
  resolve: (result: RelaySendResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface DiscoveredRelayEndpoint {
  url: string;
  observedAt: number;
}

const RELAY_MDNS_TYPE = 'lanternrelay';
const RELAY_MDNS_PROTOCOL = 'tcp';
const DEFAULT_RELAY_PORT = Number(process.env.LANTERN_RELAY_PORT || 43190);
const DEFAULT_RELAY_URL = `ws://127.0.0.1:${DEFAULT_RELAY_PORT}`;
const ACK_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_INITIAL_MS = 1_200;
const RECONNECT_DELAY_MAX_MS = 10_000;
const CONNECT_TIMEOUT_MS = 8_000;
const DISCOVERED_ENDPOINT_TTL_MS = 35_000;
const DISCOVERY_REFRESH_INTERVAL_MS = 12_000;
const LAST_HEALTHY_RETRY_WINDOW_MS = 14_000;

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const asString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const normalizeAddress = (value: string | undefined): string => {
  if (!value) return '';
  const cleaned = value.replace(/^::ffff:/, '').trim();
  if (cleaned === '::1' || cleaned.startsWith('127.')) return '';
  return cleaned;
};

const sanitizeHost = (value: string | undefined): string | null => {
  if (!value) return null;
  const cleaned = value.replace(/\.$/, '').trim();
  return cleaned || null;
};

const isIpv4 = (value: string): boolean => /^\d+\.\d+\.\d+\.\d+$/.test(value);
const isIpv6 = (value: string): boolean => value.includes(':');
const isIpv6LinkLocal = (value: string): boolean => /^fe80:/i.test(value);

const formatWsUrl = (host: string, port: number): string | null => {
  const normalized = host.trim();
  if (!normalized) return null;
  let safeHost = normalized;
  if (isIpv6(safeHost)) {
    if (isIpv6LinkLocal(safeHost)) {
      return null;
    }
    safeHost = safeHost.replace(/^\[|\]$/g, '');
    if (safeHost.includes('%')) {
      safeHost = safeHost.replace('%', '%25');
    }
    safeHost = `[${safeHost}]`;
  }
  const url = `ws://${safeHost}:${port}`;
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
};

const normalizeManualHostInput = (
  value: string | undefined
): { host: string; portFromHost: number | null } => {
  const raw = (value || '').trim();
  if (!raw) {
    return { host: '', portFromHost: null };
  }

  let work = raw.replace(/^wss?:\/\//i, '');
  const slashIndex = work.indexOf('/');
  if (slashIndex >= 0) {
    work = work.slice(0, slashIndex);
  }

  const ipv6Match = work.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (ipv6Match) {
    const host = ipv6Match[1] || '';
    const portFromHost = ipv6Match[2] ? Number.parseInt(ipv6Match[2], 10) : null;
    return { host, portFromHost: Number.isFinite(portFromHost || NaN) ? portFromHost : null };
  }

  const pieces = work.split(':');
  if (pieces.length === 2 && /^\d+$/.test(pieces[1])) {
    const parsedPort = Number.parseInt(pieces[1], 10);
    return {
      host: pieces[0],
      portFromHost: Number.isFinite(parsedPort) ? parsedPort : null
    };
  }

  return { host: work, portFromHost: null };
};

const scoreIpv4 = (value: string): number => {
  if (value.startsWith('127.')) return -1;
  if (value.startsWith('169.254.')) return -1;
  if (value.startsWith('192.168.')) return 100;
  if (value.startsWith('10.')) return 95;
  const octets = value.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length === 4 && octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
    return 90;
  }
  return 65;
};

const parseServiceToUrl = (service: Service): string | null => {
  const addresses = Array.from(
    new Set((service.addresses || []).map((addr) => normalizeAddress(addr)).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));

  const hostFromService = sanitizeHost(service.host);

  const txt = (service.txt || {}) as Record<string, unknown>;
  const txtPort = Number(asString(txt.port) || asString(txt.wsPort) || '');
  const port = Number.isFinite(txtPort) && txtPort > 0 ? txtPort : Number(service.port || 0);
  if (!Number.isFinite(port) || port <= 0) return null;

  const candidateHosts: Array<{ host: string; score: number }> = [];

  for (const addr of addresses) {
    if (isIpv4(addr)) {
      const score = scoreIpv4(addr);
      if (score >= 0) {
        candidateHosts.push({ host: addr, score });
      }
      continue;
    }
    if (isIpv6(addr) && !isIpv6LinkLocal(addr)) {
      candidateHosts.push({ host: addr, score: 45 });
    }
  }

  if (hostFromService) {
    const score = hostFromService.toLowerCase().endsWith('.local') ? 70 : 60;
    candidateHosts.push({ host: hostFromService, score });
  }

  const orderedHosts = candidateHosts
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.host.localeCompare(b.host);
    })
    .map((candidate) => candidate.host);

  for (const host of orderedHosts) {
    const url = formatWsUrl(host, port);
    if (url) return url;
  }

  return null;
};

const normalizeRelayPeer = (value: unknown): RelayPeerSnapshot | null => {
  const record = asRecord(value);
  if (!record) return null;

  const deviceId = asString(record.deviceId);
  const displayName = asString(record.displayName);
  const avatarEmoji = asString(record.avatarEmoji);
  const avatarBg = asString(record.avatarBg);
  const statusMessage = asString(record.statusMessage) || 'Disponível';
  const appVersion = asString(record.appVersion) || APP_VERSION;

  if (!deviceId || !displayName || !avatarEmoji || !avatarBg) {
    return null;
  }

  return {
    deviceId,
    displayName,
    avatarEmoji,
    avatarBg,
    statusMessage,
    appVersion,
    connectedAt:
      typeof record.connectedAt === 'number' && Number.isFinite(record.connectedAt)
        ? Math.trunc(record.connectedAt)
        : Date.now(),
    lastSeenAt:
      typeof record.lastSeenAt === 'number' && Number.isFinite(record.lastSeenAt)
        ? Math.trunc(record.lastSeenAt)
        : Date.now()
  };
};

const normalizeAnnouncementReactionsMap = (
  value: unknown
): RelayAnnouncementReactionsByMessage => {
  const record = asRecord(value);
  if (!record) return {};

  const result: RelayAnnouncementReactionsByMessage = {};
  for (const [messageId, rawByDevice] of Object.entries(record)) {
    if (typeof messageId !== 'string' || messageId.trim().length === 0) continue;
    const byDevice = asRecord(rawByDevice);
    if (!byDevice) continue;

    const normalizedByDevice: Record<string, RelayAnnouncementReactionValue> = {};
    for (const [deviceId, reaction] of Object.entries(byDevice)) {
      if (typeof deviceId !== 'string' || deviceId.trim().length === 0) continue;
      const reactionText = asString(reaction);
      if (
        reactionText === '👍' ||
        reactionText === '👎' ||
        reactionText === '❤️' ||
        reactionText === '😢' ||
        reactionText === '😊' ||
        reactionText === '😂'
      ) {
        normalizedByDevice[deviceId] = reactionText;
      }
    }

    result[messageId] = normalizedByDevice;
  }
  return result;
};

export class RelayClient {
  private readonly callbacks: RelayClientCallbacks;
  private socket: WebSocket | null = null;
  private started = false;
  private connecting = false;
  private ready = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private presenceStaleTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = RECONNECT_DELAY_INITIAL_MS;
  private readonly pendingAcks = new Map<string, PendingSendAck>();
  private readonly readyWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private readonly discoveredEndpoints = new Map<string, DiscoveredRelayEndpoint>();
  private readonly discoveredEndpointByServiceKey = new Map<string, string>();
  private readonly relayPeersById = new Map<string, RelayPeerSnapshot>();
  private bonjour: BonjourService | null = null;
  private browser: Browser | null = null;
  private manualRelayUrl: string | null = null;
  private endpointSettings: RelayEndpointSettings = {
    automatic: true,
    host: '',
    port: DEFAULT_RELAY_PORT
  };
  private readonly explicitRelayUrl: string | null;
  private selectedEndpoint: string | null = null;
  private lastHealthyEndpoint: string | null = null;
  private lastHealthyEndpointFailedAt = 0;
  private lastDiscoveryRefreshAt = 0;
  private profile: Profile;
  private lastPresenceAt = 0;
  private lastPresenceRevision = -1;

  constructor(profile: Profile, callbacks: RelayClientCallbacks) {
    this.profile = { ...profile };
    this.callbacks = callbacks;
    this.explicitRelayUrl = asString(process.env.LANTERN_RELAY_URL);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (!this.explicitRelayUrl) {
      this.startRelayDiscovery();
    }

    this.startHeartbeatLoop();
    await this.connectNow();
  }

  stop(): void {
    this.started = false;
    this.ready = false;
    this.connecting = false;
    this.lastPresenceRevision = -1;
    this.lastPresenceAt = 0;
    this.lastHealthyEndpointFailedAt = 0;
    this.lastDiscoveryRefreshAt = 0;
    this.relayPeersById.clear();
    this.discoveredEndpoints.clear();
    this.discoveredEndpointByServiceKey.clear();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.presenceStaleTimer) {
      clearTimeout(this.presenceStaleTimer);
      this.presenceStaleTimer = null;
    }

    this.rejectPendingAcks(new Error('Conexão do relay encerrada.'));
    this.rejectReadyWaiters(new Error('Conexão do relay encerrada.'));

    if (this.browser) {
      try {
        this.browser.stop();
      } catch {
        // ignore
      }
      this.browser = null;
    }

    if (this.bonjour) {
      try {
        this.bonjour.destroy();
      } catch {
        // ignore
      }
      this.bonjour = null;
    }

    if (this.socket) {
      try {
        this.socket.removeAllListeners();
      } catch {
        // ignore
      }
      try {
        this.socket.close();
      } catch {
        // ignore
      }
      this.socket = null;
    }
  }

  setManualRelayEndpoint(host: string, port: number): void {
    this.setEndpointSettings({
      automatic: false,
      host,
      port
    });
  }

  setEndpointSettings(input: {
    automatic: boolean;
    host?: string | null;
    port?: number | null;
  }): RelayEndpointSettings {
    const previousSettings = this.endpointSettings;
    const previousManualRelayUrl = this.manualRelayUrl;

    const automatic = Boolean(input.automatic);
    const manualInput = normalizeManualHostInput(input.host || undefined);
    const normalizedHost =
      normalizeAddress(manualInput.host || undefined) || sanitizeHost(manualInput.host || undefined) || '';
    const rawPort = Number(input.port || manualInput.portFromHost || 0);
    const normalizedPort =
      Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535
        ? Math.trunc(rawPort)
        : DEFAULT_RELAY_PORT;

    this.endpointSettings = {
      automatic,
      host: automatic ? '' : normalizedHost,
      port: normalizedPort
    };

    if (automatic) {
      this.manualRelayUrl = null;
    } else {
      this.manualRelayUrl =
        normalizedHost.length > 0 ? formatWsUrl(normalizedHost, normalizedPort) : null;
    }

    const endpointChanged =
      previousSettings.automatic !== this.endpointSettings.automatic ||
      previousSettings.host !== this.endpointSettings.host ||
      previousSettings.port !== this.endpointSettings.port ||
      previousManualRelayUrl !== this.manualRelayUrl;

    if (endpointChanged) {
      this.ready = false;
      this.connecting = false;
      this.lastPresenceRevision = -1;
      this.lastPresenceAt = 0;
      this.relayPeersById.clear();
      this.callbacks.onPresence([]);
      this.cancelPresenceStaleTimer();

      if (this.socket) {
        try {
          this.socket.terminate();
        } catch {
          try {
            this.socket.close();
          } catch {
            // ignore
          }
        }
        this.socket = null;
      }
      this.connectWithBackoff(true);
      return { ...this.endpointSettings };
    }

    // Evita reconectar desnecessariamente quando usuário salva configurações
    // sem alterar endpoint (ex.: apenas "iniciar com o sistema").
    if (this.started && !this.isConnected()) {
      this.connectWithBackoff(true);
    }
    return { ...this.endpointSettings };
  }

  getEndpointSettings(): RelayEndpointSettings {
    return { ...this.endpointSettings };
  }

  updateProfile(profile: Profile): void {
    this.profile = { ...profile };
    if (!this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.sendEnvelope({
      type: 'relay:updateProfile',
      payload: {
        deviceId: profile.deviceId,
        displayName: profile.displayName,
        avatarEmoji: profile.avatarEmoji,
        avatarBg: profile.avatarBg,
        statusMessage: profile.statusMessage,
        appVersion: APP_VERSION
      }
    });
  }

  isConnected(): boolean {
    return this.ready && Boolean(this.socket && this.socket.readyState === WebSocket.OPEN);
  }

  getCurrentEndpoint(): string | null {
    return this.selectedEndpoint;
  }

  async sendFrame(frame: ProtocolFrame): Promise<RelaySendResult> {
    await this.waitUntilReady(8_000);
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Relay indisponível.');
    }

    return new Promise<RelaySendResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingAcks.delete(frame.messageId);
        reject(new Error('Timeout aguardando confirmação do relay.'));
      }, ACK_TIMEOUT_MS);
      timeout.unref?.();

      this.pendingAcks.set(frame.messageId, {
        resolve,
        reject,
        timeout
      });

      this.sendEnvelope({
        type: 'relay:send',
        payload: {
          frame
        }
      }, (error) => {
        if (!error) return;
        const pending = this.pendingAcks.get(frame.messageId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pendingAcks.delete(frame.messageId);
        pending.reject(new Error('Falha ao enviar frame para o relay.'));
      });
    });
  }

  private chooseEndpoint(): string {
    if (!this.endpointSettings.automatic && this.manualRelayUrl) {
      return this.manualRelayUrl;
    }
    if (this.explicitRelayUrl) {
      return this.explicitRelayUrl;
    }

    this.pruneDiscoveredEndpoints();

    const discovered = Array.from(this.discoveredEndpoints.values()).sort((a, b) => {
      if (a.observedAt !== b.observedAt) return b.observedAt - a.observedAt;
      return a.url.localeCompare(b.url);
    });

    const now = Date.now();
    if (this.lastHealthyEndpoint) {
      const recentlyFailed =
        this.lastHealthyEndpointFailedAt > 0 &&
        now - this.lastHealthyEndpointFailedAt <= LAST_HEALTHY_RETRY_WINDOW_MS;
      if (!recentlyFailed || discovered.length === 0) {
        return this.lastHealthyEndpoint;
      }
      if (discovered.length > 0) {
        return discovered[0].url;
      }
      return this.lastHealthyEndpoint;
    }

    if (discovered.length > 0) {
      return discovered[0].url;
    }

    // Em rede real, a descoberta pode atrasar/oscilar. Se já havia endpoint
    // válido selecionado anteriormente, reutiliza para evitar fallback indevido
    // para localhost em clientes remotos.
    if (
      this.selectedEndpoint &&
      this.selectedEndpoint.length > 0 &&
      this.selectedEndpoint !== DEFAULT_RELAY_URL
    ) {
      return this.selectedEndpoint;
    }

    return DEFAULT_RELAY_URL;
  }

  private pruneDiscoveredEndpoints(): void {
    if (this.discoveredEndpoints.size === 0) return;
    const now = Date.now();
    for (const [url, endpoint] of Array.from(this.discoveredEndpoints.entries())) {
      if (now - endpoint.observedAt <= DISCOVERED_ENDPOINT_TTL_MS) {
        continue;
      }
      this.discoveredEndpoints.delete(url);
      for (const [serviceKey, mappedUrl] of Array.from(this.discoveredEndpointByServiceKey.entries())) {
        if (mappedUrl === url) {
          this.discoveredEndpointByServiceKey.delete(serviceKey);
        }
      }
    }
  }

  private connectWithBackoff(forceImmediate = false): void {
    if (!this.started) return;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const delay = forceImmediate ? 0 : this.reconnectDelayMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectNow();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async connectNow(): Promise<void> {
    if (!this.started || this.connecting) return;
    this.connecting = true;

    const endpoint = this.chooseEndpoint();
    const previousEndpoint = this.selectedEndpoint;
    if (previousEndpoint && previousEndpoint !== endpoint) {
      this.lastPresenceRevision = -1;
      this.lastPresenceAt = 0;
    }

    if (this.socket) {
      try {
        this.socket.removeAllListeners();
      } catch {
        // ignore
      }
      try {
        this.socket.close();
      } catch {
        // ignore
      }
      this.socket = null;
    }

    await new Promise<void>((resolve) => {
      const socket = new WebSocket(endpoint);
      this.socket = socket;
      this.selectedEndpoint = endpoint;
      let settled = false;
      let opened = false;

      const connectTimeout = setTimeout(() => {
        if (settled || opened) return;
        try {
          socket.terminate();
        } catch {
          try {
            socket.close();
          } catch {
            // ignore
          }
        }
      }, CONNECT_TIMEOUT_MS);
      connectTimeout.unref?.();

      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimeout);
        socket.removeAllListeners('open');
        socket.removeAllListeners('error');
        resolve();
      };

      socket.once('open', () => {
        opened = true;
        this.ready = true;
        this.connecting = false;
        this.reconnectDelayMs = RECONNECT_DELAY_INITIAL_MS;
        this.cancelPresenceStaleTimer();

        this.callbacks.onConnectionState?.({
          connected: true,
          endpoint
        });

        this.resolveReadyWaiters();

        this.sendEnvelope({
          type: 'relay:hello',
          payload: {
            deviceId: this.profile.deviceId,
            displayName: this.profile.displayName,
            avatarEmoji: this.profile.avatarEmoji,
            avatarBg: this.profile.avatarBg,
            statusMessage: this.profile.statusMessage,
            appVersion: APP_VERSION
          }
        });

        this.requestPresence();
        done();
      });

      socket.once('error', () => {
        done();
      });

      socket.on('message', (raw) => {
        this.handleRawMessage(raw);
      });

      socket.on('close', () => {
        if (!opened) {
          done();
        }
        if (this.socket !== socket) {
          return;
        }
        this.handleDisconnect(endpoint);
      });

      socket.on('error', () => {
        // close cobre reconexão
      });

      socket.on('pong', () => {
        this.lastPresenceAt = Date.now();
      });
    });

    if (!this.ready) {
      if (endpoint === this.lastHealthyEndpoint) {
        this.lastHealthyEndpointFailedAt = Date.now();
      }
      this.connecting = false;
      this.refreshRelayDiscoveryIfNeeded();
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.started) return;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_DELAY_MAX_MS);
    this.connectWithBackoff();
  }

  private handleDisconnect(endpoint: string): void {
    this.ready = false;
    this.connecting = false;
    this.lastPresenceRevision = -1;
    this.lastPresenceAt = 0;
    this.relayPeersById.clear();
    this.rejectPendingAcks(new Error('Conexão com relay perdida.'));
    this.rejectReadyWaiters(new Error('Conexão com relay perdida.'));

    this.callbacks.onPresence([]);

    this.callbacks.onConnectionState?.({
      connected: false,
      endpoint
    });

    if (endpoint === this.lastHealthyEndpoint) {
      this.lastHealthyEndpointFailedAt = Date.now();
    }
    this.refreshRelayDiscoveryIfNeeded(true);
    this.scheduleReconnect();
  }

  private cancelPresenceStaleTimer(): void {
    if (!this.presenceStaleTimer) return;
    clearTimeout(this.presenceStaleTimer);
    this.presenceStaleTimer = null;
  }

  private handleRawMessage(raw: WebSocket.RawData): void {
    const text = typeof raw === 'string' ? raw : raw.toString();
    let envelope: RelayEnvelope | null = null;

    try {
      const parsed = JSON.parse(text) as RelayEnvelope;
      if (!parsed || typeof parsed.type !== 'string') {
        return;
      }
      envelope = parsed;
    } catch {
      return;
    }

    switch (envelope.type) {
      case 'relay:welcome':
        return;
      case 'relay:hello:ok': {
        if (this.selectedEndpoint) {
          this.lastHealthyEndpoint = this.selectedEndpoint;
          this.lastHealthyEndpointFailedAt = 0;
        }
        this.requestPresence();
        return;
      }
      case 'relay:pong': {
        this.lastPresenceAt = Date.now();
        return;
      }
      case 'relay:presence': {
        const payload = asRecord(envelope.payload) as RelayPresencePayload | null;
        const revision =
          typeof payload?.revision === 'number' && Number.isFinite(payload.revision)
            ? Math.trunc(payload.revision)
            : null;
        if (revision !== null && revision < this.lastPresenceRevision) {
          return;
        }
        if (revision !== null) {
          this.lastPresenceRevision = revision;
        }
        this.relayPeersById.clear();
        if (Array.isArray(payload?.peers)) {
          for (const value of payload.peers) {
            const peer = normalizeRelayPeer(value);
            if (!peer) continue;
            this.relayPeersById.set(peer.deviceId, peer);
          }
        }
        this.lastPresenceAt = Date.now();
        this.callbacks.onPresence(Array.from(this.relayPeersById.values()));
        return;
      }
      case 'relay:presence:delta': {
        const payload = asRecord(envelope.payload) as RelayPresenceDeltaPayload | null;
        const revision =
          typeof payload?.revision === 'number' && Number.isFinite(payload.revision)
            ? Math.trunc(payload.revision)
            : null;
        if (revision !== null && revision < this.lastPresenceRevision) {
          return;
        }
        if (revision !== null) {
          this.lastPresenceRevision = revision;
        }

        if (payload?.op === 'upsert') {
          const peer = normalizeRelayPeer(payload.peer);
          if (peer) {
            this.relayPeersById.set(peer.deviceId, peer);
          }
        } else if (payload?.op === 'remove') {
          const deviceId = asString(payload.deviceId);
          if (deviceId) {
            this.relayPeersById.delete(deviceId);
          }
        } else {
          return;
        }

        this.lastPresenceAt = Date.now();
        this.callbacks.onPresence(Array.from(this.relayPeersById.values()));
        return;
      }
      case 'relay:deliver': {
        const payload = asRecord(envelope.payload) as RelayDeliverPayload | null;
        const frame = payload?.frame as ProtocolFrame | undefined;
        if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
          return;
        }
        this.callbacks.onFrame(frame);
        return;
      }
      case 'relay:announcement:expired': {
        const payload = asRecord(envelope.payload);
        const messageIds = Array.isArray(payload?.messageIds)
          ? payload!.messageIds.filter(
              (value): value is string => typeof value === 'string' && value.trim().length > 0
            )
          : [];
        if (messageIds.length > 0) {
          this.callbacks.onAnnouncementExpired?.(messageIds);
        }
        return;
      }
      case 'relay:announcement:snapshot': {
        const payload = asRecord(envelope.payload) as RelayAnnouncementSnapshotPayload | null;
        const frames = Array.isArray(payload?.frames)
          ? payload!.frames
              .filter((value): value is ProtocolFrame => Boolean(value && typeof value === 'object'))
              .filter(
                (frame) =>
                  typeof frame.type === 'string' &&
                  typeof frame.messageId === 'string' &&
                  typeof frame.from === 'string'
              )
          : [];
        const reactions = normalizeAnnouncementReactionsMap(payload?.reactions);
        this.callbacks.onAnnouncementSnapshot?.(frames, reactions);
        return;
      }
      case 'relay:announcement:reactions': {
        const payload = asRecord(envelope.payload) as RelayAnnouncementReactionsPayload | null;
        const messageId = asString(payload?.messageId);
        if (!messageId) return;
        const reactions = normalizeAnnouncementReactionsMap({
          [messageId]: payload?.reactions
        });
        this.callbacks.onAnnouncementReactions?.(messageId, reactions[messageId] || {});
        return;
      }
      case 'relay:send:ack': {
        const payload = asRecord(envelope.payload) as RelaySendAckPayload | null;
        const frameMessageId = asString(payload?.frameMessageId);
        if (!frameMessageId) return;

        const pending = this.pendingAcks.get(frameMessageId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pendingAcks.delete(frameMessageId);

        const deliveredTo = Array.isArray(payload?.deliveredTo)
          ? payload!.deliveredTo.filter((value): value is string => typeof value === 'string' && value.length > 0)
          : [];

        pending.resolve({ deliveredTo });
        return;
      }
      case 'relay:error': {
        const payload = asRecord(envelope.payload) as RelayErrorPayload | null;
        const code = asString(payload?.code) || 'UNKNOWN';
        const message = asString(payload?.message) || 'Erro no relay.';
        this.callbacks.onWarning?.(`[relay:${code}] ${message}`);
        return;
      }
      default:
        return;
    }
  }

  private startHeartbeatLoop(): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      if (!this.started) {
        return;
      }
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        this.refreshRelayDiscoveryIfNeeded();
        return;
      }

      this.sendEnvelope(
        { type: 'relay:heartbeat', payload: { id: randomUUID() } },
        (error) => {
          if (!error) return;
          this.forceSocketDisconnect();
        }
      );
      this.pruneDiscoveredEndpoints();
      if (this.lastPresenceAt > 0 && Date.now() - this.lastPresenceAt > 25_000) {
        this.requestPresence();
      }

      if (this.lastPresenceAt > 0 && Date.now() - this.lastPresenceAt > 45_000) {
        try {
          this.socket.close();
        } catch {
          // ignore
        }
      }
    }, HEARTBEAT_INTERVAL_MS);

    this.heartbeatTimer.unref?.();
  }

  private requestPresence(): void {
    this.sendEnvelope({ type: 'relay:presence:request', payload: {} }, (error) => {
      if (!error) return;
      this.forceSocketDisconnect();
    });
  }

  private forceSocketDisconnect(): void {
    const socket = this.socket;
    if (!socket) return;
    try {
      socket.terminate();
    } catch {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
  }

  private sendEnvelope(
    envelope: RelayEnvelope,
    callback?: (error?: Error) => void
  ): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      callback?.(new Error('Relay offline'));
      return;
    }

    socket.send(JSON.stringify(envelope), (error) => {
      if (error) {
        callback?.(new Error('Falha ao enviar envelope ao relay'));
        return;
      }
      callback?.();
    });
  }

  private getServiceKey(service: Service): string {
    const anyService = service as Service & { fqdn?: string; fullname?: string };
    const base =
      anyService.fqdn ||
      anyService.fullname ||
      service.name ||
      service.host ||
      `service-${service.port || 0}`;
    return `${base}|${service.port || 0}`;
  }

  private startRelayDiscovery(): void {
    if (this.bonjour || this.explicitRelayUrl) {
      return;
    }

    try {
      this.bonjour = new BonjourService();
      this.browser = this.bonjour.find({ type: RELAY_MDNS_TYPE, protocol: RELAY_MDNS_PROTOCOL });
      this.browser.on('up', (service: Service) => {
        const serviceKey = this.getServiceKey(service);
        const url = parseServiceToUrl(service);
        if (!url) {
          return;
        }
        this.discoveredEndpointByServiceKey.set(serviceKey, url);
        this.discoveredEndpoints.set(url, { url, observedAt: Date.now() });
        if (this.selectedEndpoint !== url && this.selectedEndpoint === DEFAULT_RELAY_URL) {
          this.connectWithBackoff(true);
        }
      });

      this.browser.on('down', (service: Service) => {
        const serviceKey = this.getServiceKey(service);
        const mappedUrl = this.discoveredEndpointByServiceKey.get(serviceKey) || null;
        const parsedUrl = parseServiceToUrl(service);
        const url = mappedUrl || parsedUrl;
        if (!url) return;
        this.discoveredEndpointByServiceKey.delete(serviceKey);
        this.discoveredEndpoints.delete(url);
        if (this.selectedEndpoint === url) {
          this.connectWithBackoff(true);
        }
      });
    } catch {
      this.callbacks.onWarning?.('Não foi possível usar descoberta automática do relay (mDNS).');
    }
  }

  private refreshRelayDiscoveryIfNeeded(force = false): void {
    if (!this.started) return;
    if (!this.endpointSettings.automatic) return;
    if (this.explicitRelayUrl) return;

    const now = Date.now();
    if (!force && now - this.lastDiscoveryRefreshAt < DISCOVERY_REFRESH_INTERVAL_MS) {
      return;
    }
    this.lastDiscoveryRefreshAt = now;

    if (this.browser) {
      try {
        this.browser.stop();
      } catch {
        // ignore
      }
      this.browser = null;
    }
    if (this.bonjour) {
      try {
        this.bonjour.destroy();
      } catch {
        // ignore
      }
      this.bonjour = null;
    }
    this.startRelayDiscovery();
  }

  private waitUntilReady(timeoutMs: number): Promise<void> {
    if (this.ready && this.socket && this.socket.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    this.connectWithBackoff(true);

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.readyWaiters.delete(waiter);
        reject(new Error('Relay indisponível no momento.'));
      }, timeoutMs);
      timeout.unref?.();

      const waiter = {
        resolve: () => {
          clearTimeout(timeout);
          this.readyWaiters.delete(waiter);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          this.readyWaiters.delete(waiter);
          reject(error);
        },
        timeout
      };

      this.readyWaiters.add(waiter);
    });
  }

  private resolveReadyWaiters(): void {
    for (const waiter of Array.from(this.readyWaiters)) {
      clearTimeout(waiter.timeout);
      this.readyWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  private rejectReadyWaiters(error: Error): void {
    for (const waiter of Array.from(this.readyWaiters)) {
      clearTimeout(waiter.timeout);
      this.readyWaiters.delete(waiter);
      waiter.reject(error);
    }
  }

  private rejectPendingAcks(error: Error): void {
    for (const [messageId, pending] of Array.from(this.pendingAcks.entries())) {
      clearTimeout(pending.timeout);
      this.pendingAcks.delete(messageId);
      pending.reject(error);
    }
  }
}

export type { RelayPeerSnapshot, RelaySendResult, RelayConnectionState, RelayEndpointSettings };
