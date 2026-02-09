import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { APP_VERSION } from './config';
import { Peer, Profile, ProtocolFrame } from './types';

type ConnectionState = 'idle' | 'connecting' | 'open';

interface ConnectionEntry {
  peer: Peer;
  socket: WebSocket | null;
  state: ConnectionState;
  connectPromise: Promise<WebSocket> | null;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectDelayMs: number;
  lastActivityAt: number;
}

interface ConnectionEvent {
  peerId: string;
  connected: boolean;
  remoteAddress?: string;
}

const INITIAL_RECONNECT_DELAY_MS = 1_200;
const MAX_RECONNECT_DELAY_MS = 12_000;
const HEARTBEAT_INTERVAL_MS = 8_000;
const HEARTBEAT_STALE_MS = 26_000;

export class WsClientManager {
  private readonly entries = new Map<string, ConnectionEntry>();
  private readonly profile: Profile;
  private readonly onFrame: (
    frame: ProtocolFrame,
    peerId: string,
    remoteAddress?: string
  ) => void;
  private readonly onConnectionEvent?: (event: ConnectionEvent) => void;
  private readonly localWsPort: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    profile: Profile,
    onFrame: (frame: ProtocolFrame, peerId: string, remoteAddress?: string) => void,
    localWsPort: number,
    onConnectionEvent?: (event: ConnectionEvent) => void
  ) {
    this.profile = profile;
    this.onFrame = onFrame;
    this.localWsPort = localWsPort;
    this.onConnectionEvent = onConnectionEvent;
    this.startHeartbeat();
  }

  upsertPeer(peer: Peer): void {
    if (!peer.deviceId) return;

    const existing = this.entries.get(peer.deviceId);
    if (!existing) {
      this.entries.set(peer.deviceId, {
        peer,
        socket: null,
        state: 'idle',
        connectPromise: null,
        reconnectTimer: null,
        reconnectDelayMs: INITIAL_RECONNECT_DELAY_MS,
        lastActivityAt: 0
      });
      return;
    }

    const endpointChanged =
      existing.peer.address !== peer.address ||
      existing.peer.port !== peer.port;

    existing.peer = {
      ...existing.peer,
      ...peer
    };

    if (endpointChanged && existing.socket) {
      try {
        existing.socket.close();
      } catch {
        // ignore
      }
    }
  }

  ensureConnected(peerId: string): void {
    const entry = this.entries.get(peerId);
    if (!entry) return;
    if (!entry.peer.address || !entry.peer.port) return;

    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }

    void this.connect(peerId).catch(() => {
      this.scheduleReconnect(peerId);
    });
  }

  disconnectPeer(peerId: string): void {
    const entry = this.entries.get(peerId);
    if (!entry) return;

    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }

    entry.connectPromise = null;
    entry.state = 'idle';

    if (entry.socket) {
      const socket = entry.socket;
      entry.socket = null;
      try {
        socket.removeAllListeners();
      } catch {
        // ignore
      }
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
  }

  isConnected(peerId: string): boolean {
    const entry = this.entries.get(peerId);
    return Boolean(entry && entry.socket && entry.socket.readyState === WebSocket.OPEN);
  }

  getConnectedPeerIds(): string[] {
    return Array.from(this.entries.entries())
      .filter(([, entry]) => entry.socket && entry.socket.readyState === WebSocket.OPEN)
      .map(([peerId]) => peerId);
  }

  async send(peer: Peer, frame: ProtocolFrame): Promise<void> {
    this.upsertPeer(peer);
    const socket = await this.connect(peer.deviceId);

    await new Promise<void>((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new Error('Socket não está aberto'));
        return;
      }
      socket.send(JSON.stringify(frame), (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    const entry = this.entries.get(peer.deviceId);
    if (entry) {
      entry.lastActivityAt = Date.now();
    }
  }

  async sendHello(peer: Peer): Promise<void> {
    await this.send(peer, this.buildHelloFrame(peer.deviceId));
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const [peerId, entry] of this.entries) {
      if (entry.reconnectTimer) {
        clearTimeout(entry.reconnectTimer);
      }
      if (entry.socket) {
        try {
          entry.socket.removeAllListeners();
          entry.socket.close();
        } catch {
          // ignore
        }
      }
      this.entries.delete(peerId);
    }
  }

  private buildHelloFrame(peerId: string): ProtocolFrame {
    return {
      type: 'hello',
      messageId: randomUUID(),
      from: this.profile.deviceId,
      to: peerId,
      createdAt: Date.now(),
      payload: {
        deviceId: this.profile.deviceId,
        displayName: this.profile.displayName,
        avatarEmoji: this.profile.avatarEmoji,
        avatarBg: this.profile.avatarBg,
        statusMessage: this.profile.statusMessage,
        appVersion: APP_VERSION,
        wsPort: this.localWsPort
      }
    };
  }

  private async connect(peerId: string): Promise<WebSocket> {
    const entry = this.entries.get(peerId);
    if (!entry) {
      throw new Error(`Peer ${peerId} não encontrado`);
    }
    if (!entry.peer.address || !entry.peer.port) {
      throw new Error(`Peer ${peerId} sem endpoint válido`);
    }

    if (entry.socket && entry.socket.readyState === WebSocket.OPEN) {
      return entry.socket;
    }

    if (entry.connectPromise) {
      return entry.connectPromise;
    }

    const endpoint = entry.peer;
    const url = `ws://${endpoint.address}:${endpoint.port}`;

    entry.state = 'connecting';
    entry.connectPromise = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url);
      entry.socket = socket;

      const cleanupConnect = (): void => {
        socket.removeListener('open', onOpen);
        socket.removeListener('error', onError);
      };

      const onOpen = (): void => {
        cleanupConnect();
        entry.state = 'open';
        entry.connectPromise = null;
        entry.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
        entry.lastActivityAt = Date.now();

        this.onConnectionEvent?.({
          peerId,
          connected: true,
          remoteAddress: endpoint.address
        });

        try {
          socket.send(JSON.stringify(this.buildHelloFrame(peerId)));
        } catch {
          // ignore
        }

        resolve(socket);
      };

      const onError = (error: Error): void => {
        cleanupConnect();
        if (entry.connectPromise) {
          entry.connectPromise = null;
          entry.state = 'idle';
          reject(error);
        }
      };

      socket.once('open', onOpen);
      socket.once('error', onError);

      socket.on('message', (raw) => {
        entry.lastActivityAt = Date.now();
        try {
          const text = typeof raw === 'string' ? raw : raw.toString();
          const frame = JSON.parse(text) as ProtocolFrame;
          this.onFrame(frame, peerId, endpoint.address);
        } catch {
          // ignora frame inválido
        }
      });

      socket.on('pong', () => {
        entry.lastActivityAt = Date.now();
      });

      socket.on('close', () => {
        const current = this.entries.get(peerId);
        if (!current) return;

        if (current.socket === socket) {
          current.socket = null;
          current.state = 'idle';
          current.connectPromise = null;
        }

        this.onConnectionEvent?.({
          peerId,
          connected: false,
          remoteAddress: endpoint.address
        });

        this.scheduleReconnect(peerId);
      });

      socket.on('error', () => {
        // close também será chamado; sem duplicar lógica aqui
      });
    });

    return entry.connectPromise;
  }

  private scheduleReconnect(peerId: string): void {
    const entry = this.entries.get(peerId);
    if (!entry) return;
    if (!entry.peer.address || !entry.peer.port) return;
    if (entry.reconnectTimer) return;

    const delay = Math.max(
      INITIAL_RECONNECT_DELAY_MS,
      Math.min(entry.reconnectDelayMs || INITIAL_RECONNECT_DELAY_MS, MAX_RECONNECT_DELAY_MS)
    );

    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      void this.connect(peerId).catch(() => {
        entry.reconnectDelayMs = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
        this.scheduleReconnect(peerId);
      });
    }, delay);

    entry.reconnectTimer.unref?.();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [peerId, entry] of this.entries) {
        const socket = entry.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          continue;
        }

        if (entry.lastActivityAt > 0 && now - entry.lastActivityAt > HEARTBEAT_STALE_MS) {
          try {
            socket.close();
          } catch {
            // ignore
          }
          continue;
        }

        try {
          socket.ping();
        } catch {
          try {
            socket.close();
          } catch {
            // ignore
          }
        }

        // garante reconexão se algum socket ficar preso em estado inválido.
        if (socket.readyState !== WebSocket.OPEN) {
          this.scheduleReconnect(peerId);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);

    this.heartbeatTimer.unref?.();
  }
}
