import { createSocket } from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  AuthenticatedUser,
  ClientAuthState,
  ClientRelayConfig,
  RelayConnectionMode,
  UserPreferencesSnapshot
} from './types';

export type { AuthenticatedUser, ClientAuthState, ClientRelayConfig, RelayConnectionMode } from './types';

interface StoredClientConfig {
  relay: ClientRelayConfig;
  encryptedToken?: string;
  endpoint?: string;
  deviceId: string;
  rememberMe: boolean;
}

const DEFAULT_CONFIG: ClientRelayConfig = {
  mode: 'local-auto',
  host: '',
  port: 43190,
  secure: false
};

const normalizePort = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 65535 ? Math.trunc(number) : 43190;
};

export class AuthService {
  private stored: StoredClientConfig;
  private token: string | null = null;
  private user: AuthenticatedUser | null = null;

  constructor(private readonly userDataDir: string) {
    this.stored = this.load();
    this.token = this.stored.rememberMe ? this.decryptToken(this.stored.encryptedToken || '') : null;
  }

  getState(): ClientAuthState {
    return {
      authenticated: Boolean(this.token && this.user),
      relay: { ...this.stored.relay },
      endpoint: this.stored.endpoint || null,
      user: this.user ? { ...this.user } : null
    };
  }

  getToken(): string | null {
    return this.token;
  }

  getDeviceId(): string {
    return this.stored.deviceId;
  }

  async restore(): Promise<ClientAuthState> {
    if (!this.token || !this.stored.endpoint) return this.getState();
    try {
      const response = await fetch(`${this.httpBase(this.stored.endpoint)}/api/client/session`, {
        headers: { authorization: `Bearer ${this.token}` }
      });
      if (!response.ok) throw new Error('Sessão expirada.');
      const body = (await response.json()) as { user?: AuthenticatedUser };
      if (!body.user) throw new Error('Sessão inválida.');
      this.user = body.user;
    } catch {
      this.clearSession();
    }
    return this.getState();
  }

  async login(input: {
    relay: ClientRelayConfig;
    username: string;
    password: string;
    rememberMe?: boolean;
  }): Promise<ClientAuthState> {
    const relay = this.normalizeRelay(input.relay);
    const endpoint = await this.resolveEndpoint(relay);
    const response = await fetch(`${this.httpBase(endpoint)}/api/client/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: input.username.trim(),
        password: input.password,
        deviceId: this.stored.deviceId
      })
    });
    const body = (await response.json().catch(() => ({}))) as {
      token?: string;
      user?: AuthenticatedUser;
      message?: string;
    };
    if (!response.ok || !body.token || !body.user) {
      throw new Error(body.message || 'Não foi possível entrar.');
    }
    this.stored.relay = relay;
    this.stored.endpoint = endpoint;
    this.stored.rememberMe = input.rememberMe !== false;
    this.token = body.token;
    this.user = body.user;
    this.persist();
    return this.getState();
  }

  async register(input: {
    relay: ClientRelayConfig;
    username: string;
    displayName: string;
    password: string;
    locale: 'pt-BR' | 'en' | 'es';
  }): Promise<ClientAuthState> {
    const relay = this.normalizeRelay(input.relay);
    const endpoint = await this.resolveEndpoint(relay);
    const response = await fetch(`${this.httpBase(endpoint)}/api/client/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: input.username.trim(),
        displayName: input.displayName.trim(),
        password: input.password,
        locale: input.locale
      })
    });
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    if (!response.ok) throw new Error(body.message || 'Não foi possível criar a conta.');
    return this.login({ relay, username: input.username, password: input.password, rememberMe: true });
  }

  async logout(): Promise<void> {
    if (this.token && this.stored.endpoint) {
      await fetch(`${this.httpBase(this.stored.endpoint)}/api/client/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}` }
      }).catch(() => undefined);
    }
    this.clearSession();
  }

  async completeProfileSetup(input: { avatarEmoji: string; avatarBg: string }): Promise<ClientAuthState> {
    const body = await this.authenticatedRequest<{ user?: AuthenticatedUser; message?: string }>(
      '/api/client/profile-setup',
      'PATCH',
      input
    );
    if (!body.user) throw new Error(body.message || 'O Relay não confirmou a configuração do perfil.');
    this.user = body.user;
    return this.getState();
  }

  async getUserPreferences(): Promise<UserPreferencesSnapshot> {
    const body = await this.authenticatedRequest<{ preferences?: UserPreferencesSnapshot }>(
      '/api/client/preferences',
      'GET'
    );
    return body.preferences || { conversations: [], messages: [] };
  }

  async updateConversationPreference(input: {
    conversationId: string;
    pinned?: boolean;
    archived?: boolean;
    manualUnread?: boolean;
    readAt?: number;
  }): Promise<void> {
    await this.authenticatedRequest('/api/client/preferences/conversation', 'PUT', input);
  }

  async updateMessagePreference(input: { messageId: string; favorite?: boolean; hidden?: boolean }): Promise<void> {
    await this.authenticatedRequest('/api/client/preferences/message', 'PUT', input);
  }

  async getConversationExport(conversationId: string): Promise<{
    title: string;
    records: Array<{ messageId: string; senderUserId: string; type: 'text' | 'file'; text: string; fileName: string; fileSize: number; createdAt: number; editedAt: number }>;
    users: Record<string, string>;
  }> {
    const query = encodeURIComponent(conversationId);
    const body = await this.authenticatedRequest<{
      title?: string;
      records?: Array<{ messageId: string; senderUserId: string; type: 'text' | 'file'; text: string; fileName: string; fileSize: number; createdAt: number; editedAt: number }>;
      users?: Record<string, string>;
    }>(`/api/client/export?conversationId=${query}`, 'GET');
    return {
      title: body.title || 'Conversa',
      records: Array.isArray(body.records) ? body.records : [],
      users: body.users || {}
    };
  }

  async changePassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
    await this.authenticatedRequest('/api/client/password', 'POST', input);
  }

  async requestPasswordReset(input: { relay: ClientRelayConfig; username: string }): Promise<{ requestToken: string }> {
    const relay = this.normalizeRelay(input.relay);
    const endpoint = await this.resolveEndpoint(relay);
    const response = await fetch(`${this.httpBase(endpoint)}/api/client/password-reset/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: input.username.trim() })
    });
    const body = (await response.json().catch(() => ({}))) as { requestToken?: string; message?: string };
    if (!response.ok || !body.requestToken) throw new Error(body.message || 'Não foi possível enviar a solicitação.');
    this.stored.relay = relay;
    this.stored.endpoint = endpoint;
    this.persist();
    return { requestToken: body.requestToken };
  }

  async getPasswordResetStatus(requestToken: string): Promise<'pending' | 'approved' | 'rejected' | 'consumed' | 'expired' | 'invalid'> {
    if (!this.stored.endpoint) throw new Error('Conexão com o servidor indisponível.');
    const query = encodeURIComponent(requestToken);
    const response = await fetch(`${this.httpBase(this.stored.endpoint)}/api/client/password-reset/status?token=${query}`);
    const body = (await response.json().catch(() => ({}))) as { status?: 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired' | 'invalid'; message?: string };
    if (!response.ok || !body.status) throw new Error(body.message || 'Não foi possível consultar a solicitação.');
    return body.status;
  }

  async completePasswordReset(input: { username: string; requestToken: string; newPassword: string }): Promise<void> {
    if (!this.stored.endpoint) throw new Error('Conexão com o servidor indisponível.');
    const response = await fetch(`${this.httpBase(this.stored.endpoint)}/api/client/password-reset/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input)
    });
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    if (!response.ok) throw new Error(body.message || 'Não foi possível redefinir a senha.');
  }

  async discover(port = 43190): Promise<Array<{ host: string; port: number; secure: boolean }>> {
    return new Promise((resolve) => {
      const socket = createSocket('udp4');
      const found = new Map<string, { host: string; port: number; secure: boolean }>();
      const finish = () => {
        try {
          socket.close();
        } catch {
          // ignore
        }
        resolve(Array.from(found.values()));
      };
      const timer = setTimeout(finish, 1400);
      timer.unref?.();
      socket.on('message', (raw, remote) => {
        try {
          const value = JSON.parse(raw.toString('utf8')) as {
            type?: string;
            port?: number;
            secure?: boolean;
          };
          if (value.type !== 'lantern:relay:announce') return;
          const relayPort = normalizePort(value.port);
          found.set(`${remote.address}:${relayPort}`, {
            host: remote.address,
            port: relayPort,
            secure: value.secure === true
          });
        } catch {
          // ignore invalid discovery datagram
        }
      });
      socket.bind(0, '0.0.0.0', () => {
        try {
          socket.setBroadcast(true);
          const body = Buffer.from(JSON.stringify({ type: 'lantern:relay:discover' }));
          socket.send(body, normalizePort(port), '255.255.255.255');
          socket.send(body, normalizePort(port), '127.0.0.1');
        } catch {
          clearTimeout(timer);
          finish();
        }
      });
      socket.on('error', () => {
        clearTimeout(timer);
        finish();
      });
    });
  }

  private async resolveEndpoint(relay: ClientRelayConfig): Promise<string> {
    if (relay.mode === 'local-auto') {
      const discovered = await this.discover(relay.port);
      const selected = discovered[0];
      if (selected) return `${selected.secure ? 'wss' : 'ws'}://${selected.host}:${selected.port}`;
      return `ws://127.0.0.1:${relay.port}`;
    }
    if (!relay.host.trim()) throw new Error('Informe o endereço do Relay.');
    if (relay.mode === 'external-manual' && !relay.secure) {
      throw new Error('Relay externo exige conexão segura (WSS).');
    }
    return `${relay.secure ? 'wss' : 'ws'}://${relay.host.trim()}:${relay.port}`;
  }

  private normalizeRelay(value: ClientRelayConfig): ClientRelayConfig {
    const mode: RelayConnectionMode =
      value.mode === 'local-manual' || value.mode === 'external-manual'
        ? value.mode
        : 'local-auto';
    return {
      mode,
      host: mode === 'local-auto' ? '' : value.host.trim(),
      port: normalizePort(value.port),
      secure: mode === 'external-manual' ? true : Boolean(value.secure)
    };
  }

  private httpBase(endpoint: string): string {
    return endpoint.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  }

  private async authenticatedRequest<T extends Record<string, unknown>>(
    pathname: string,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    body?: Record<string, unknown>
  ): Promise<T> {
    if (!this.token || !this.stored.endpoint) throw new Error('Sessão do Relay indisponível.');
    const response = await fetch(`${this.httpBase(this.stored.endpoint)}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) throw new Error(payload.message || 'O Relay recusou a operação.');
    return payload;
  }

  private clearSession(): void {
    this.token = null;
    this.user = null;
    delete this.stored.encryptedToken;
    this.persist();
  }

  private load(): StoredClientConfig {
    const configFile = this.configFile();
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Partial<StoredClientConfig>;
      return {
        relay: this.normalizeRelay(parsed.relay || DEFAULT_CONFIG),
        encryptedToken: parsed.encryptedToken,
        endpoint: parsed.endpoint,
        deviceId: parsed.deviceId || randomUUID(),
        rememberMe: parsed.rememberMe !== false
      };
    } catch {
      return { relay: { ...DEFAULT_CONFIG }, deviceId: randomUUID(), rememberMe: true };
    }
  }

  private persist(): void {
    fs.mkdirSync(this.userDataDir, { recursive: true });
    const body: StoredClientConfig = {
      ...this.stored,
      encryptedToken: this.token && this.stored.rememberMe ? this.encryptToken(this.token) : undefined
    };
    const target = this.configFile();
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(body, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, target);
  }

  private encryptToken(token: string): string | undefined {
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    return safeStorage.encryptString(token).toString('base64');
  }

  private decryptToken(value: string): string | null {
    if (!value || !safeStorage.isEncryptionAvailable()) return null;
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'));
    } catch {
      return null;
    }
  }

  private configFile(): string {
    return path.join(this.userDataDir, 'client-config.json');
  }
}
