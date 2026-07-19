import {
  AnnouncementReactionSummary,
  AnnouncementReadDetail,
  AnnouncementReadSummary,
  AppEvent,
  AuthenticatedUser,
  ClientAuthState,
  ClientRelayConfig,
  ConversationMediaCursor,
  ConversationMediaKind,
  ConversationMediaPage,
  DocumentPreviewResult,
  GroupInfo,
  GroupMember,
  LanternApi,
  MessageReplyReference,
  MessageReactionDetail,
  MessageRow,
  Peer,
  Profile,
  StickerCatalogItem
} from './ipcClient';
import {
  attachmentChunkCount,
  forEachFileChunk,
  mergeAttachmentCache
} from './attachmentTransfer';

type Json = Record<string, any>;
type PendingRequest = { resolve: (value: Json) => void; reject: (error: Error) => void; timer: number };
type PendingAttachmentDownload = {
  chunks: Uint8Array[];
  resolve: (url: string) => void;
  reject: (error: Error) => void;
  timer: number;
};
type WebFile = { file: File; url: string | null };
type PendingGroupSync = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: number;
};
type ReactionValue = '👍' | '👎' | '❤️' | '😢' | '😊' | '😂';
type ReactionState = { reaction: ReactionValue; updatedAt: number };

const TOKEN_KEY = 'lantern.web.token';
const DEVICE_KEY = 'lantern.web.device';
const RELAY_PORT = Number(window.location.port || (window.location.protocol === 'https:' ? 443 : 80));
const relayConfig = (): ClientRelayConfig => ({
  // No Web, o Relay que serve /app já é o destino descoberto automaticamente.
  mode: 'local-auto',
  host: window.location.hostname,
  port: RELAY_PORT,
  secure: window.location.protocol === 'https:'
});
const endpoint = (): string => `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;
const uuid = (): string => {
  const browserCrypto = globalThis.crypto;
  if (browserCrypto && typeof browserCrypto.randomUUID === 'function') {
    return browserCrypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (browserCrypto && typeof browserCrypto.getRandomValues === 'function') {
    browserCrypto.getRandomValues(bytes);
  } else {
    // Compatibilidade final para WebViews/Safari antigos. O identificador serve
    // para correlação, enquanto autenticação e sessões continuam no Relay.
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
};

const sha256Bytes = (input: Uint8Array): string => {
  const constants = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = input.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const words = new Uint32Array(64);
  const rotateRight = (value: number, bits: number): number =>
    (value >>> bits) | (value << (32 - bits));

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15];
      const y = words[index - 2];
      const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + constants[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0;
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, '0')).join('');
};
const asRecord = (value: unknown): Json => value && typeof value === 'object' ? value as Json : {};

class WebLanternBridge {
  private token = window.localStorage.getItem(TOKEN_KEY) || window.sessionStorage.getItem(TOKEN_KEY) || '';
  private user: AuthenticatedUser | null = null;
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: number | null = null;
  private intentionalClose = false;
  private directory = new Map<string, Peer>();
  private online = new Set<string>();
  private groups = new Map<string, GroupInfo>();
  private groupMembers = new Map<string, GroupMember[]>();
  private groupPins = new Map<string, string[]>();
  private messages = new Map<string, MessageRow[]>();
  private beforeSeq = new Map<string, number>();
  private groupBefore = new Map<string, number>();
  private favorites = new Set<string>();
  private reactions = new Map<string, AnnouncementReactionSummary>();
  private reactionActors = new Map<string, Map<string, ReactionState>>();
  private announcementReads = new Map<string, AnnouncementReadSummary>();
  private announcementReaders = new Map<string, Map<string, number>>();
  private unread: Record<string, number> = {};
  private activeConversation = 'announcements';
  private events = new Set<(event: AppEvent) => void>();
  private pending = new Map<string, PendingRequest>();
  private pendingFrames = new Map<string, PendingRequest>();
  private groupChunkPending = new Map<string, PendingRequest>();
  private files = new Map<string, WebFile>();
  private mediaMessages = new Map<string, MessageRow>();
  private appVersion = 'web';
  private attachmentDownloads = new Map<string, PendingAttachmentDownload>();
  private attachmentDownloadByFileId = new Map<string, Promise<MessageRow>>();
  private attachmentDownloadQueue: Promise<void> = Promise.resolve();
  private pendingGroupSync: PendingGroupSync | null = null;

  private deviceId(): string {
    let value = window.localStorage.getItem(DEVICE_KEY);
    if (!value) {
      value = `web-${uuid()}`;
      window.localStorage.setItem(DEVICE_KEY, value);
    }
    return value;
  }

  private emit(event: AppEvent): void {
    for (const listener of this.events) listener(event);
  }

  private notifyIncoming(message: MessageRow): void {
    if (message.direction !== 'in' || message.conversationId === this.activeConversation && !document.hidden) return;
    if (Number(window.localStorage.getItem('lantern.web.dnd') || 0) > Date.now()) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const sender = this.directory.get(message.senderDeviceId);
    const title = message.type === 'announcement' ? '📢 Anúncio' : sender?.displayName || 'Nova mensagem';
    const body = message.type === 'file' ? `📎 ${message.fileName || 'Arquivo'}` : message.bodyText || 'Nova mensagem';
    try {
      const notification = new Notification(title, { body: body.slice(0, 120), tag: message.messageId });
      notification.onclick = () => {
        window.focus();
        this.emit({ type: 'navigate', conversationId: message.conversationId });
        notification.close();
      };
    } catch {
      // Alguns navegadores móveis exigem Service Worker para notificações.
    }
  }

  private requestNotificationPermission(): void {
    if (typeof Notification === 'undefined' || Notification.permission !== 'default') return;
    void Notification.requestPermission().catch(() => undefined);
  }

  private async http(path: string, init: RequestInit = {}, authenticated = true): Promise<Json> {
    const headers = new Headers(init.headers);
    if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');
    if (authenticated && this.token) headers.set('authorization', `Bearer ${this.token}`);
    let response: Response;
    try {
      response = await fetch(path, { ...init, headers, cache: 'no-store' });
    } catch {
      throw new Error('Não foi possível conectar ao Relay. Verifique sua rede e tente novamente.');
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (body.message) throw new Error(String(body.message));
      if (response.status === 404 || response.status === 405) {
        throw new Error('O endereço respondeu, mas não parece ser um Relay Lantern. Confira o endereço e a porta.');
      }
      if (response.status >= 500) {
        throw new Error('O Relay encontrou um problema temporário. Aguarde um instante e tente novamente.');
      }
      throw new Error(`O Relay recusou a operação (HTTP ${response.status}).`);
    }
    return body;
  }

  private saveToken(token: string, remember: boolean): void {
    window.localStorage.removeItem(TOKEN_KEY);
    window.sessionStorage.removeItem(TOKEN_KEY);
    (remember ? window.localStorage : window.sessionStorage).setItem(TOKEN_KEY, token);
  }

  private async loadPreferences(): Promise<void> {
    const body = await this.http('/api/client/preferences');
    const preferences = asRecord(body.preferences);
    this.favorites = new Set((Array.isArray(preferences.messages) ? preferences.messages : []).filter((item: Json) => item.favorite).map((item: Json) => String(item.messageId)));
    for (const item of Array.isArray(preferences.conversations) ? preferences.conversations : []) {
      if (item.manualUnread) this.unread[String(item.conversationId)] = Math.max(1, this.unread[String(item.conversationId)] || 0);
    }
  }

  private authState(): ClientAuthState {
    return {
      authenticated: Boolean(this.token && this.user),
      relay: relayConfig(),
      endpoint: this.socket?.readyState === WebSocket.OPEN ? endpoint() : null,
      user: this.user,
      connectionError: null
    };
  }

  private profile(): Profile {
    if (!this.user) throw new Error('Autenticação necessária.');
    return {
      deviceId: this.user.userId,
      displayName: this.user.displayName,
      avatarEmoji: this.user.avatarEmoji,
      avatarBg: this.user.avatarBg,
      statusMessage: this.user.statusMessage,
      username: this.user.username,
      department: this.user.department,
      createdAt: 0,
      updatedAt: Date.now()
    };
  }

  private async connect(): Promise<void> {
    if (!this.token || !this.user) return;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    try {
      const health = await fetch('/health', { cache: 'no-store' });
      const body = await health.json().catch(() => ({})) as { version?: string };
      if (health.ok && typeof body.version === 'string' && body.version) this.appVersion = body.version;
    } catch {
      // A conexão WebSocket ainda fornecerá o erro operacional apropriado.
    }
    this.intentionalClose = false;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(endpoint());
      this.socket = socket;
      const timeout = window.setTimeout(() => reject(new Error('Tempo de conexão com o Relay excedido.')), 10_000);
      socket.onopen = () => socket.send(JSON.stringify({
        type: 'relay:hello',
        payload: {
          deviceId: this.deviceId(),
          displayName: this.user!.displayName,
          avatarEmoji: this.user!.avatarEmoji,
          avatarBg: this.user!.avatarBg,
          statusMessage: this.user!.statusMessage,
          appVersion: this.appVersion,
          sessionToken: this.token
        }
      }));
      socket.onmessage = (event) => {
        const envelope = asRecord(JSON.parse(String(event.data)));
        if (envelope.type === 'relay:hello:ok') {
          window.clearTimeout(timeout);
          const nextUser = asRecord(envelope.payload).user as AuthenticatedUser | undefined;
          if (nextUser) this.user = nextUser;
          this.connecting = null;
          this.emit({ type: 'relay:connection', connected: true, endpoint: endpoint() });
          resolve();
          return;
        }
        void this.handleEnvelope(envelope);
      };
      socket.onerror = () => {
        window.clearTimeout(timeout);
        this.connecting = null;
        reject(new Error('Não foi possível conectar ao Relay.'));
      };
      socket.onclose = () => {
        window.clearTimeout(timeout);
        this.finishGroupSync(new Error('Conexão encerrada durante a sincronização dos grupos.'));
        this.socket = null;
        this.connecting = null;
        this.online.clear();
        const disconnectError = new Error('Conexão encerrada antes da resposta do Relay.');
        for (const pending of this.pending.values()) {
          window.clearTimeout(pending.timer);
          pending.reject(disconnectError);
        }
        this.pending.clear();
        for (const pending of this.pendingFrames.values()) {
          window.clearTimeout(pending.timer);
          pending.reject(disconnectError);
        }
        this.pendingFrames.clear();
        for (const pending of this.groupChunkPending.values()) {
          window.clearTimeout(pending.timer);
          pending.reject(disconnectError);
        }
        this.groupChunkPending.clear();
        for (const [requestId, download] of this.attachmentDownloads) {
          window.clearTimeout(download.timer);
          this.attachmentDownloads.delete(requestId);
          download.reject(disconnectError);
        }
        reject(disconnectError);
        this.emit({ type: 'relay:connection', connected: false, endpoint: null });
        if (!this.intentionalClose && this.token) {
          if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
          this.reconnectTimer = window.setTimeout(() => void this.connect(), 1_500);
        }
      };
    });
    return this.connecting;
  }

  private send(type: string, payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('Relay offline.');
    this.socket.send(JSON.stringify({ type, payload }));
  }

  private async request(type: string, payload: Json, timeoutMs = 15_000): Promise<Json> {
    await this.connect();
    const requestId = uuid();
    return new Promise<Json>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('O Relay não respondeu a tempo.'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.send(type, { requestId, ...payload });
      } catch (error) {
        window.clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error('Falha ao enviar a operação ao Relay.'));
      }
    });
  }

  private refreshAttachmentDownloadTimeout(
    requestId: string,
    download: PendingAttachmentDownload
  ): void {
    window.clearTimeout(download.timer);
    download.timer = window.setTimeout(() => {
      if (this.attachmentDownloads.get(requestId) !== download) return;
      this.attachmentDownloads.delete(requestId);
      download.reject(new Error('O download do anexo parou de responder.'));
    }, 30_000);
  }

  private runAttachmentDownload<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.attachmentDownloadQueue.then(operation, operation);
    this.attachmentDownloadQueue = running.then(() => undefined, () => undefined);
    return running;
  }

  private settle(payload: Json, error?: string): boolean {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    window.clearTimeout(pending.timer);
    this.pending.delete(requestId);
    if (error) pending.reject(new Error(error));
    else pending.resolve(payload);
    return true;
  }

  private finishGroupSync(error?: Error): void {
    const pending = this.pendingGroupSync;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    this.pendingGroupSync = null;
    if (error) pending.reject(error);
    else pending.resolve();
  }

  private async synchronizeGroups(): Promise<void> {
    await this.connect();
    if (this.pendingGroupSync) return this.pendingGroupSync.promise;

    let resolveSync!: () => void;
    let rejectSync!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveSync = resolve;
      rejectSync = reject;
    });
    const timer = window.setTimeout(() => {
      this.finishGroupSync(new Error('O Relay não confirmou a lista de grupos.'));
    }, 10_000);
    this.pendingGroupSync = { promise, resolve: resolveSync, reject: rejectSync, timer };
    try {
      this.send('relay:groups:sync', { knownSeqByGroup: {} });
    } catch (error) {
      this.finishGroupSync(error instanceof Error ? error : new Error('Falha ao sincronizar grupos.'));
    }
    return promise;
  }

  private peer(value: Json): Peer | null {
    if (!value.deviceId || !value.displayName) return null;
    return {
      deviceId: String(value.deviceId), username: String(value.username || ''), department: String(value.department || ''),
      displayName: String(value.displayName), avatarEmoji: String(value.avatarEmoji || '🙂'), avatarBg: String(value.avatarBg || '#147ad6'),
      statusMessage: String(value.statusMessage || 'Disponível'), address: '', port: 0, appVersion: String(value.appVersion || 'central'),
      lastSeenAt: Number(value.lastSeenAt || 0), source: 'relay'
    };
  }

  private messageFromFrame(frame: Json): MessageRow | null {
    const payload = asRecord(frame.payload);
    const conversationId = frame.to === null ? 'announcements' : `dm:${frame.from === this.user?.userId ? frame.to : frame.from}`;
    if (frame.type !== 'chat:text' && frame.type !== 'announce' && frame.type !== 'file:offer') return null;
    return {
      messageId: String(frame.messageId), conversationId,
      direction: frame.from === this.user?.userId ? 'out' : 'in', senderDeviceId: String(frame.from), receiverDeviceId: frame.to ? String(frame.to) : null,
      type: frame.type === 'announce' ? 'announcement' : frame.type === 'file:offer' ? 'file' : 'text',
      bodyText: typeof payload.text === 'string' ? payload.text : null,
      fileId: payload.fileId || null, fileName: payload.filename || null, fileSize: Number(payload.size || 0) || null,
      fileSha256: payload.sha256 || null, filePath: null, status: 'delivered', reaction: null, deletedAt: null,
      replyToMessageId: payload.replyTo?.messageId || null, replyToSenderDeviceId: payload.replyTo?.senderDeviceId || null,
      replyToType: payload.replyTo?.type || null, replyToPreviewText: payload.replyTo?.previewText || null,
      replyToFileName: payload.replyTo?.fileName || null, forwardedFromMessageId: payload.forwardedFromMessageId || null,
      editedAt: Number(payload.editedAt || 0) || null, createdAt: Number(frame.createdAt || Date.now())
    };
  }

  private groupMessageFromEvent(event: Json): MessageRow | null {
    if (event.type !== 'group.message.created') return null;
    const message = asRecord(asRecord(event.payload).message);
    if (!message.messageId) return null;
    const reply = asRecord(message.replyTo);
    return {
      messageId: String(message.messageId), conversationId: `group:${event.groupId}`,
      direction: message.senderDeviceId === this.user?.userId ? 'out' : 'in', senderDeviceId: String(message.senderDeviceId), receiverDeviceId: null,
      type: message.type === 'file' ? 'file' : 'text', bodyText: message.bodyText || null,
      fileId: message.fileId || null, fileName: message.fileName || null, fileSize: Number(message.fileSize || 0) || null,
      fileSha256: message.fileSha256 || null, filePath: null, status: 'delivered', reaction: null, deletedAt: null,
      replyToMessageId: reply.messageId || null, replyToSenderDeviceId: reply.senderDeviceId || null, replyToType: reply.type || null,
      replyToPreviewText: reply.previewText || null, replyToFileName: reply.fileName || null,
      forwardedFromMessageId: message.forwardedFromMessageId || null, editedAt: null, createdAt: Number(message.createdAt || event.createdAt || Date.now())
    };
  }

  private mergeMessage(row: MessageRow, emit = false): void {
    const rows = this.messages.get(row.conversationId) || [];
    const cached = rows.find((item) => item.messageId === row.messageId);
    const merged = mergeAttachmentCache(row, cached);
    const next = [...rows.filter((item) => item.messageId !== row.messageId), merged].sort((a, b) => a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId));
    this.messages.set(row.conversationId, next);
    if (emit) {
      if (merged.conversationId !== this.activeConversation && merged.direction === 'in') this.unread[merged.conversationId] = (this.unread[merged.conversationId] || 0) + 1;
      this.emit({ type: 'message:received', message: merged });
      this.notifyIncoming(merged);
    }
  }

  private isReaction(value: unknown): value is ReactionValue {
    return value === '👍' || value === '👎' || value === '❤️' || value === '😢' || value === '😊' || value === '😂';
  }

  private reactionSummary(messageId: string): AnnouncementReactionSummary {
    const counts: AnnouncementReactionSummary['counts'] = {};
    const actors = this.reactionActors.get(messageId);
    for (const state of actors?.values() || []) {
      counts[state.reaction] = (counts[state.reaction] || 0) + 1;
    }
    const mine = this.user ? actors?.get(this.user.userId)?.reaction || null : null;
    return { counts, myReaction: mine };
  }

  private applyReaction(
    messageId: string,
    actorDeviceId: string,
    reaction: unknown,
    updatedAt: number,
    announcement: boolean,
    emit = true
  ): void {
    if (!messageId || !actorDeviceId || (reaction !== null && !this.isReaction(reaction))) return;
    const actors = new Map(this.reactionActors.get(messageId) || []);
    if (reaction === null) actors.delete(actorDeviceId);
    else actors.set(actorDeviceId, { reaction, updatedAt });
    if (actors.size > 0) this.reactionActors.set(messageId, actors);
    else this.reactionActors.delete(messageId);
    const summary = this.reactionSummary(messageId);
    this.reactions.set(messageId, summary);
    if (emit) this.emit({ type: announcement ? 'announcement:reactions' : 'message:reactions', messageId, summary });
  }

  private replaceReactions(messageId: string, value: unknown, updatedAt: number, announcement: boolean): void {
    const actors = new Map<string, ReactionState>();
    for (const [actorDeviceId, reaction] of Object.entries(asRecord(value))) {
      if (this.isReaction(reaction)) actors.set(actorDeviceId, { reaction, updatedAt });
    }
    if (actors.size > 0) this.reactionActors.set(messageId, actors);
    else this.reactionActors.delete(messageId);
    const summary = this.reactionSummary(messageId);
    this.reactions.set(messageId, summary);
    this.emit({ type: announcement ? 'announcement:reactions' : 'message:reactions', messageId, summary });
  }

  private replaceAnnouncementReads(messageId: string, value: unknown): void {
    const readers = new Map<string, number>();
    for (const [deviceId, rawReadAt] of Object.entries(asRecord(value))) {
      const readAt = Number(rawReadAt);
      if (deviceId && Number.isFinite(readAt) && readAt > 0) readers.set(deviceId, readAt);
    }
    if (readers.size > 0) this.announcementReaders.set(messageId, readers);
    else this.announcementReaders.delete(messageId);
    const summary = { count: readers.size, readByMe: Boolean(this.user && readers.has(this.user.userId)) };
    this.announcementReads.set(messageId, summary);
    this.emit({ type: 'announcement:reads', messageId, summary });
  }

  private person(deviceId: string): Pick<MessageReactionDetail, 'displayName' | 'avatarEmoji' | 'avatarBg'> {
    if (this.user?.userId === deviceId) {
      return { displayName: this.user.displayName, avatarEmoji: this.user.avatarEmoji, avatarBg: this.user.avatarBg };
    }
    const peer = this.directory.get(deviceId);
    return {
      displayName: peer?.displayName || `Contato ${deviceId.slice(0, 6)}`,
      avatarEmoji: peer?.avatarEmoji || '🙂',
      avatarBg: peer?.avatarBg || '#5b5fc7'
    };
  }

  private reactionDetails(messageId: string): MessageReactionDetail[] {
    return Array.from(this.reactionActors.get(messageId)?.entries() || [])
      .map(([deviceId, state]) => ({ deviceId, ...this.person(deviceId), reaction: state.reaction, updatedAt: state.updatedAt }))
      .sort((left, right) => left.updatedAt - right.updatedAt || left.deviceId.localeCompare(right.deviceId));
  }

  private readDetails(messageId: string): AnnouncementReadDetail[] {
    return Array.from(this.announcementReaders.get(messageId)?.entries() || [])
      .map(([deviceId, readAt]) => ({ deviceId, ...this.person(deviceId), readAt }))
      .sort((left, right) => left.readAt - right.readAt || left.deviceId.localeCompare(right.deviceId));
  }

  private applyCanonicalFrame(frame: Json, emit = false): void {
    const payload = asRecord(frame.payload);
    const conversationId = frame.to === null ? 'announcements' : `dm:${frame.from === this.user?.userId ? frame.to : frame.from}`;
    if (frame.type === 'chat:edit') {
      const existing = (this.messages.get(conversationId) || []).find((item) => item.messageId === payload.targetMessageId);
      if (existing) {
        const updated = { ...existing, bodyText: String(payload.text || ''), editedAt: Number(payload.editedAt || frame.createdAt) };
        this.mergeMessage(updated);
        if (emit) this.emit({ type: 'message:updated', message: updated });
      }
      return;
    }
    if (frame.type === 'chat:delete') {
      const messageId = String(payload.targetMessageId || '');
      this.messages.set(conversationId, (this.messages.get(conversationId) || []).filter((item) => item.messageId !== messageId));
      this.reactions.delete(messageId);
      this.reactionActors.delete(messageId);
      if (emit) this.emit({ type: 'message:removed', conversationId, messageId });
      return;
    }
    if (frame.type === 'chat:react') {
      this.applyReaction(String(payload.targetMessageId || ''), String(frame.from || ''), payload.reaction ?? null, Number(frame.createdAt || Date.now()), frame.to === null, emit);
      return;
    }
    if (frame.type === 'chat:ack') {
      const messageId = String(payload.ackMessageId || '');
      const status = payload.status === 'read' ? 'read' : 'delivered';
      const row = (this.messages.get(conversationId) || []).find((item) => item.messageId === messageId);
      if (row) {
        this.mergeMessage({ ...row, status });
        if (emit) this.emit({ type: 'message:status', messageId, conversationId, status });
      }
      return;
    }
    if (frame.type === 'typing') {
      if (emit && frame.from !== this.user?.userId) this.emit({ type: 'typing:update', conversationId, peerId: String(frame.from || ''), isTyping: payload.isTyping === true });
      return;
    }
    const row = this.messageFromFrame(frame);
    if (row) this.mergeMessage(row, emit);
  }

  private applyGroupEvent(event: Json, emit = false): void {
    const row = this.groupMessageFromEvent(event);
    if (row) this.mergeMessage(row, emit);
    if (event.type === 'group.message.edited') {
      const payload = asRecord(event.payload);
      const id = String(payload.targetMessageId || '');
      const conversationId = `group:${event.groupId}`;
      const existing = (this.messages.get(conversationId) || []).find((item) => item.messageId === id);
      if (existing) {
        const updated = { ...existing, bodyText: String(payload.text || ''), editedAt: Number(payload.editedAt || event.createdAt) };
        this.mergeMessage(updated);
        this.emit({ type: 'message:updated', message: updated });
      }
    }
    if (event.type === 'group.message.deletedForEveryone') {
      const id = String(asRecord(event.payload).targetMessageId || '');
      const conversationId = `group:${event.groupId}`;
      this.messages.set(conversationId, (this.messages.get(conversationId) || []).filter((item) => item.messageId !== id));
      this.emit({ type: 'message:removed', conversationId, messageId: id });
    }
    if (event.type === 'group.message.reactionChanged') {
      const payload = asRecord(event.payload);
      this.applyReaction(
        String(payload.targetMessageId || ''),
        String(event.actorDeviceId || ''),
        payload.reaction ?? null,
        Number(payload.updatedAt || event.createdAt || Date.now()),
        false,
        emit
      );
    }
    if (event.type === 'group.message.pinned' || event.type === 'group.message.unpinned') {
      const payload = asRecord(event.payload);
      const groupId = String(event.groupId || '');
      const messageId = String(payload.messageId || '');
      const current = this.groupPins.get(groupId) || [];
      const next = Array.isArray(payload.pinnedMessageIds)
        ? payload.pinnedMessageIds.map(String)
        : event.type === 'group.message.pinned'
          ? [messageId, ...current.filter((id) => id !== messageId)]
          : current.filter((id) => id !== messageId);
      this.groupPins.set(groupId, next);
      if (emit) this.emit({ type: 'group:pins', groupId, messageIds: next });
    }
  }

  private applyGroupSnapshot(snapshots: Json[]): void {
    this.groups.clear();
    for (const snapshot of snapshots) {
      const group = asRecord(snapshot.group);
      const info: GroupInfo = {
        groupId: String(group.groupId), name: String(group.name), emoji: String(group.emoji || '👥'), avatarBg: String(group.avatarBg || '#147ad6'),
        description: String(group.description || ''), createdByDeviceId: String(group.createdByDeviceId || ''), createdAt: Number(group.createdAt || 0),
        updatedAt: Number(group.updatedAt || 0), lastEventSeq: Number(group.lastEventSeq || 0), deletedAt: group.deletedAt ? Number(group.deletedAt) : null,
        settings: { allowMembersToPin: group.settings?.allowMembersToPin !== false, allowMembersToEditInfo: group.settings?.allowMembersToEditInfo === true }
      };
      if (!info.deletedAt) this.groups.set(info.groupId, info);
      this.groupMembers.set(info.groupId, Array.isArray(snapshot.members) ? snapshot.members : []);
      this.groupPins.set(info.groupId, Array.isArray(snapshot.pinnedMessageIds) ? snapshot.pinnedMessageIds : []);
      for (const event of Array.isArray(snapshot.events) ? snapshot.events : []) this.applyGroupEvent(asRecord(event));
    }
    this.emit({ type: 'groups:updated', groups: Array.from(this.groups.values()) });
    for (const groupId of this.groups.keys()) {
      this.emit({ type: 'group:members', groupId, members: this.groupMembers.get(groupId) || [] });
      this.emit({ type: 'group:pins', groupId, messageIds: this.groupPins.get(groupId) || [] });
    }
  }

  private async handleEnvelope(envelope: Json): Promise<void> {
    const payload = asRecord(envelope.payload);
    switch (envelope.type) {
      case 'relay:directory': {
        const next = new Map<string, Peer>();
        for (const raw of Array.isArray(payload.users) ? payload.users : []) {
          const peer = this.peer(asRecord(raw));
          if (peer) next.set(peer.deviceId, peer);
        }
        this.directory = next;
        this.emit({ type: 'peers:updated', peers: this.getOnlinePeersSync() });
        return;
      }
      case 'relay:presence': {
        this.online = new Set((Array.isArray(payload.peers) ? payload.peers : []).map((item: Json) => String(item.deviceId)));
        this.emit({ type: 'peers:updated', peers: this.getOnlinePeersSync() });
        return;
      }
      case 'relay:presence:delta': {
        if (payload.op === 'upsert' && payload.peer?.deviceId) this.online.add(String(payload.peer.deviceId));
        if (payload.op === 'remove') this.online.delete(String(payload.deviceId));
        this.emit({ type: 'peers:updated', peers: this.getOnlinePeersSync() });
        return;
      }
      case 'relay:history:snapshot':
        for (const frame of Array.isArray(payload.frames) ? payload.frames : []) {
          this.applyCanonicalFrame(asRecord(frame));
        }
        return;
      case 'relay:history:page':
      case 'relay:search:results':
      case 'relay:media:list:results':
      case 'relay:attachment:ack':
        this.settle(payload, payload.ok === false ? String(payload.message || 'Falha na consulta ao Relay.') : undefined);
        return;
      case 'relay:send:ack':
        {
          const frameMessageId = String(payload.frameMessageId || '');
          const pending = this.pendingFrames.get(frameMessageId);
          if (pending) {
            window.clearTimeout(pending.timer);
            this.pendingFrames.delete(frameMessageId);
            pending.resolve(payload);
          }
        }
        return;
      case 'relay:deliver': {
        const frame = asRecord(payload.frame);
        this.applyCanonicalFrame(frame, true);
        if (frame.from !== this.user?.userId && frame.to === this.user?.userId && frame.type === 'chat:text') {
          void this.sendAck(String(frame.from || ''), String(frame.messageId || ''), 'delivered');
        }
        return;
      }
      case 'relay:announcement:snapshot': {
        for (const frame of Array.isArray(payload.frames) ? payload.frames : []) this.applyCanonicalFrame(asRecord(frame));
        const serverTime = Number(payload.serverTime || Date.now());
        const reactions = asRecord(payload.reactions);
        const reads = asRecord(payload.reads);
        const announcementIds = (this.messages.get('announcements') || []).map((item) => item.messageId);
        for (const messageId of announcementIds) {
          this.replaceReactions(messageId, reactions[messageId] || {}, serverTime, true);
          this.replaceAnnouncementReads(messageId, reads[messageId] || {});
        }
        this.emit({ type: 'conversation:synchronized', conversationId: 'announcements' });
        return;
      }
      case 'relay:announcement:reactions':
        this.replaceReactions(String(payload.messageId || ''), payload.reactions || {}, Number(payload.serverTime || Date.now()), true);
        return;
      case 'relay:announcement:reads':
        for (const [messageId, readers] of Object.entries(asRecord(payload.reads))) this.replaceAnnouncementReads(messageId, readers);
        return;
      case 'relay:announcement:expired':
        for (const messageId of Array.isArray(payload.messageIds) ? payload.messageIds.map(String) : []) {
          this.messages.set('announcements', (this.messages.get('announcements') || []).filter((item) => item.messageId !== messageId));
          this.reactions.delete(messageId);
          this.reactionActors.delete(messageId);
          this.announcementReads.delete(messageId);
          this.announcementReaders.delete(messageId);
          this.emit({ type: 'message:removed', conversationId: 'announcements', messageId });
        }
        return;
      case 'relay:groups:snapshot':
        this.applyGroupSnapshot(Array.isArray(payload.snapshots) ? payload.snapshots.map(asRecord) : []);
        this.finishGroupSync();
        return;
      case 'relay:group:event':
        this.applyGroupEvent(asRecord(payload.event), true);
        if (!String(asRecord(payload.event).type || '').startsWith('group.message.') && !String(asRecord(payload.event).type || '').startsWith('group.attachment.')) {
          this.send('relay:groups:sync', { knownSeqByGroup: {} });
        }
        return;
      case 'relay:group:ack': {
        const error = payload.ok === false ? String(payload.message || 'Falha na operação do grupo.') : undefined;
        if (!this.settle(payload, error) && error) {
          const download = this.attachmentDownloads.get(String(payload.requestId || ''));
          if (download) { window.clearTimeout(download.timer); this.attachmentDownloads.delete(String(payload.requestId)); download.reject(new Error(error)); }
        }
        return;
      }
      case 'relay:group:file:chunk:ack':
      case 'relay:group:file:chunk:error': {
        const key = `${payload.fileId}:${payload.index}`;
        const pending = this.groupChunkPending.get(key);
        if (!pending) return;
        window.clearTimeout(pending.timer); this.groupChunkPending.delete(key);
        if (envelope.type === 'relay:group:file:chunk:error') pending.reject(new Error(String(payload.message || 'Falha no envio do anexo.')));
        else pending.resolve(payload);
        return;
      }
      case 'relay:attachment:start': {
        const requestId = String(payload.requestId || '');
        const download = this.attachmentDownloads.get(requestId);
        if (download) {
          download.chunks = [];
          this.refreshAttachmentDownloadTimeout(requestId, download);
        }
        return;
      }
      case 'relay:group:file:start': {
        const requestId = String(payload.requestId || '');
        const download = this.attachmentDownloads.get(requestId);
        if (download) {
          download.chunks = [];
          this.refreshAttachmentDownloadTimeout(requestId, download);
        }
        return;
      }
      case 'relay:attachment:data': {
        const requestId = String(payload.requestId || '');
        const download = this.attachmentDownloads.get(requestId);
        if (download) {
          download.chunks.push(this.base64Bytes(String(payload.dataBase64 || '')));
          this.refreshAttachmentDownloadTimeout(requestId, download);
        }
        return;
      }
      case 'relay:group:file:chunk': {
        const requestId = String(payload.requestId || '');
        const download = this.attachmentDownloads.get(requestId);
        if (download) {
          download.chunks.push(this.base64Bytes(String(payload.dataBase64 || '')));
          this.refreshAttachmentDownloadTimeout(requestId, download);
        }
        return;
      }
      case 'relay:attachment:download:complete': {
        const requestId = String(payload.requestId || '');
        const download = this.attachmentDownloads.get(requestId);
        if (!download) return;
        window.clearTimeout(download.timer); this.attachmentDownloads.delete(requestId);
        download.resolve(URL.createObjectURL(new Blob(download.chunks.map((chunk) => chunk.slice().buffer as ArrayBuffer))));
        return;
      }
      case 'relay:group:file:complete': {
        const requestId = String(payload.requestId || '');
        const download = this.attachmentDownloads.get(requestId);
        if (!download) return;
        window.clearTimeout(download.timer); this.attachmentDownloads.delete(requestId);
        download.resolve(URL.createObjectURL(new Blob(download.chunks.map((chunk) => chunk.slice().buffer as ArrayBuffer))));
        return;
      }
      case 'relay:attachment:error': {
        const requestId = String(payload.requestId || '');
        if (this.settle(payload, String(payload.message || 'Falha no anexo.'))) return;
        const download = this.attachmentDownloads.get(requestId);
        if (download) { window.clearTimeout(download.timer); this.attachmentDownloads.delete(requestId); download.reject(new Error(String(payload.message || 'Falha no anexo.'))); }
        return;
      }
      case 'relay:error':
        {
          const frameMessageId = String(payload.frameMessageId || '');
          const pendingFrame = this.pendingFrames.get(frameMessageId);
          if (pendingFrame) {
            window.clearTimeout(pendingFrame.timer);
            this.pendingFrames.delete(frameMessageId);
            pendingFrame.reject(new Error(String(payload.message || 'O Relay rejeitou a operação.')));
            return;
          }
          if (payload.code === 'AUTH_REQUIRED' || payload.code === 'ACCOUNT_DISABLED') await this.logout();
          else this.emit({ type: 'ui:toast', level: 'error', message: String(payload.message || 'Erro do Relay.') });
        }
    }
  }

  private getOnlinePeersSync(): Peer[] {
    return Array.from(this.directory.values()).filter((peer) => this.online.has(peer.deviceId));
  }

  private base64Bytes(value: string): Uint8Array {
    const binary = atob(value); const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  private bytesBase64(bytes: Uint8Array): string {
    let binary = ''; for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  private async sha256(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (globalThis.crypto?.subtle) {
      const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(hash)).map((value) => value.toString(16).padStart(2, '0')).join('');
    }
    return sha256Bytes(bytes);
  }

  private async sendAck(to: string, ackMessageId: string, status: 'delivered' | 'read'): Promise<void> {
    if (!to || !ackMessageId || !this.user) return;
    try {
      await this.sendFrame({
        type: 'chat:ack', messageId: uuid(), from: this.user.userId, to,
        createdAt: Date.now(), payload: { ackMessageId, status }
      });
    } catch {
      // Confirmações são best-effort e convergem numa próxima leitura.
    }
  }

  private reply(replyTo?: MessageReplyReference | null): Json | null {
    return replyTo ? { ...replyTo } : null;
  }

  private async sendFrame(frame: Json): Promise<void> {
    await this.connect();
    const frameMessageId = String(frame.messageId || '');
    if (!frameMessageId) throw new Error('Mensagem sem identificador para confirmação.');
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingFrames.delete(frameMessageId);
        reject(new Error('O Relay não confirmou a operação.'));
      }, 15_000);
      this.pendingFrames.set(frameMessageId, { resolve: () => resolve(), reject, timer });
      try {
        this.send('relay:send', { frame });
      } catch (error) {
        window.clearTimeout(timer);
        this.pendingFrames.delete(frameMessageId);
        reject(error instanceof Error ? error : new Error('Falha ao enviar ao Relay.'));
      }
    });
  }

  private async dmText(peerId: string, text: string, replyTo?: MessageReplyReference | null): Promise<MessageRow> {
    const frame = { type: 'chat:text', messageId: uuid(), from: this.user!.userId, to: peerId, createdAt: Date.now(), payload: { text, replyTo: this.reply(replyTo), forwardedFromMessageId: null } };
    await this.sendFrame(frame); const row = this.messageFromFrame(frame)!; this.mergeMessage(row); return row;
  }

  private async groupAction(action: string, data: Json): Promise<Json> {
    return this.request('relay:group:request', { action, data });
  }

  private fileForKey(key: string): File {
    const file = this.files.get(key)?.file;
    if (!file) throw new Error('Arquivo não encontrado no navegador.');
    return file;
  }

  private async pick(multiple: boolean): Promise<string[]> {
    return new Promise((resolve) => {
      const input = document.createElement('input'); input.type = 'file'; input.multiple = multiple;
      input.onchange = () => {
        const keys = Array.from(input.files || []).map((file) => { const key = `webfile:${uuid()}`; this.files.set(key, { file, url: null }); return key; });
        resolve(keys);
      };
      input.click();
    });
  }

  private async downloadAttachment(row: MessageRow): Promise<MessageRow> {
    if (!row.fileId || row.filePath) return row;
    const inFlight = this.attachmentDownloadByFileId.get(row.fileId);
    if (inFlight) return inFlight;

    const operation = this.runAttachmentDownload(async (): Promise<MessageRow> => {
      await this.connect();
      const requestId = uuid();
      const url = await new Promise<string>((resolve, reject) => {
        const timer = window.setTimeout(() => { this.attachmentDownloads.delete(requestId); reject(new Error('O Relay não iniciou o download do anexo.')); }, 20_000);
        this.attachmentDownloads.set(requestId, { chunks: [], resolve, reject, timer });
        try {
          if (row.conversationId.startsWith('group:')) this.send('relay:group:file:request', { requestId, fileId: row.fileId, startIndex: 0 });
          else this.send('relay:attachment:request', { requestId, attachmentId: row.fileId, startIndex: 0 });
        } catch (error) {
          window.clearTimeout(timer);
          this.attachmentDownloads.delete(requestId);
          reject(error instanceof Error ? error : new Error('Falha ao solicitar o anexo ao Relay.'));
        }
      });
      const response = await fetch(url);
      if (!response.ok) throw new Error('O anexo baixado não pôde ser lido.');
      const blob = await response.blob();
      URL.revokeObjectURL(url);
      const file = new File([blob], row.fileName || 'arquivo', { type: blob.type || 'application/octet-stream' });
      if (row.fileSize !== null && row.fileSize !== undefined && file.size !== row.fileSize) {
        throw new Error('O tamanho do anexo recebido não confere com o Relay.');
      }
      if (row.fileSha256 && await this.sha256(file) !== row.fileSha256) {
        throw new Error('A integridade SHA-256 do anexo recebido é inválida.');
      }
      const key = `webfile:${uuid()}`;
      this.files.set(key, { file, url: null });
      const latest = (this.messages.get(row.conversationId) || []).find((item) => item.messageId === row.messageId) || row;
      const updated = { ...latest, filePath: key, status: 'delivered' as const };
      this.mergeMessage(updated);
      this.mediaMessages.set(updated.messageId, updated);
      this.emit({ type: 'message:updated', message: updated });
      if (updated.direction === 'in' && updated.conversationId.startsWith('dm:')) {
        void this.sendAck(updated.senderDeviceId, updated.messageId, 'delivered');
      }
      return updated;
    });
    this.attachmentDownloadByFileId.set(row.fileId, operation);
    try {
      return await operation;
    } finally {
      this.attachmentDownloadByFileId.delete(row.fileId);
    }
  }

  private async uploadCanonicalAttachment(input: {
    file: File;
    fileId: string;
    messageId: string;
    conversationId: string;
    sha256: string;
  }): Promise<void> {
    const initialized = await this.request('relay:attachment:init', {
      attachmentId: input.fileId,
      messageId: input.messageId,
      conversationId: input.conversationId,
      fileName: input.file.name,
      mimeType: input.file.type || 'application/octet-stream',
      size: input.file.size,
      sha256: input.sha256
    });
    await forEachFileChunk(input.file, Number(initialized.nextIndex || 0), async (chunk, index) => {
      await this.request('relay:attachment:chunk', {
        attachmentId: input.fileId,
        index,
        dataBase64: this.bytesBase64(chunk)
      });
    });
    await this.request('relay:attachment:complete', { attachmentId: input.fileId });
  }

  private async sendCanonicalFile(
    targetUserId: string | null,
    filePath: string,
    replyTo?: MessageReplyReference | null,
    forwardedFromMessageId?: string | null
  ): Promise<MessageRow> {
    const file = this.fileForKey(filePath);
    const fileId = uuid();
    const messageId = uuid();
    const sha256 = await this.sha256(file);
    const conversationId = targetUserId ? `dm:${targetUserId}` : 'announcements';
    await this.uploadCanonicalAttachment({ file, fileId, messageId, conversationId, sha256 });
    const frame = {
      type: 'file:offer', messageId, from: this.user!.userId, to: targetUserId,
      createdAt: Date.now(),
      payload: { fileId, messageId, filename: file.name, size: file.size, sha256, replyTo: this.reply(replyTo), forwardedFromMessageId: forwardedFromMessageId || null }
    };
    await this.sendFrame(frame);
    const row = { ...this.messageFromFrame(frame)!, filePath: URL.createObjectURL(file) };
    this.mergeMessage(row);
    return row;
  }

  api(): LanternApi {
    return {
      getPlatform: () => 'linux',
      getAuthState: async () => {
        if (!this.token) return this.authState();
        try {
          const body = await this.http('/api/client/session');
          this.user = body.user as AuthenticatedUser;
          if (!this.user.passwordSetupRequired) {
            await this.loadPreferences();
            await this.connect();
            this.requestNotificationPermission();
          }
        }
        catch { this.token = ''; window.localStorage.removeItem(TOKEN_KEY); window.sessionStorage.removeItem(TOKEN_KEY); this.user = null; }
        return this.authState();
      },
      discoverRelays: async () => [{ host: window.location.hostname, port: RELAY_PORT, secure: window.location.protocol === 'https:' }],
      login: async ({ username, password, rememberMe = true }) => {
        const body = await this.http('/api/client/login', { method: 'POST', body: JSON.stringify({ username, password, deviceId: this.deviceId() }) }, false);
        this.token = String(body.token); this.user = body.user as AuthenticatedUser; this.saveToken(this.token, rememberMe);
        if (!this.user.passwordSetupRequired) {
          await this.loadPreferences();
          await this.connect();
        }
        this.requestNotificationPermission();
        const state = this.authState(); this.emit({ type: 'auth:changed', state }); return state;
      },
      register: async ({ username, displayName, password, locale }) => {
        await this.http('/api/client/register', { method: 'POST', body: JSON.stringify({ username, displayName, password, locale }) }, false);
        return this.api().login({ relay: relayConfig(), username, password, rememberMe: true });
      },
      requestPasswordReset: async ({ username }) => this.http('/api/client/password-reset/request', { method: 'POST', body: JSON.stringify({ username }) }, false) as Promise<{ requestToken: string }>,
      getPasswordResetStatus: async (requestToken) => (await this.http(`/api/client/password-reset/status?token=${encodeURIComponent(requestToken)}`, {}, false)).status,
      completePasswordReset: async (input) => { await this.http('/api/client/password-reset/complete', { method: 'POST', body: JSON.stringify(input) }, false); },
      changePassword: async (input) => { await this.http('/api/client/password', { method: 'POST', body: JSON.stringify(input) }); },
      completeInitialPassword: async (newPassword) => {
        const body = await this.http('/api/client/initial-password', { method: 'POST', body: JSON.stringify({ newPassword }) });
        this.user = body.user as AuthenticatedUser;
        await this.loadPreferences();
        await this.connect();
        const state = this.authState();
        this.emit({ type: 'auth:changed', state });
        return state;
      },
      completeFirstLoginSetup: async ({ avatarEmoji, avatarBg }) => { const body = await this.http('/api/client/profile-setup', { method: 'PATCH', body: JSON.stringify({ avatarEmoji, avatarBg }) }); this.user = body.user as AuthenticatedUser; return this.authState(); },
      logout: () => this.logout(),
      getProfile: async () => this.profile(),
      updateProfile: async (input) => { await this.connect(); this.user = { ...this.user!, ...input }; this.send('relay:updateProfile', input); return this.profile(); },
      getKnownPeers: async () => Array.from(this.directory.values()),
      getOnlinePeers: async () => this.getOnlinePeersSync(),
      getGroups: async () => {
        await this.synchronizeGroups();
        return Array.from(this.groups.values());
      },
      getGroupMembers: async (groupId) => this.groupMembers.get(groupId) || [],
      getGroupPinnedMessageIds: async (groupId) => this.groupPins.get(groupId) || [],
      createGroup: async (input) => { const result = await this.groupAction('create', input); return result.group as GroupInfo; },
      updateGroup: async (groupId, input) => { await this.groupAction('update', { groupId, ...input }); },
      addGroupMembers: async (groupId, memberDeviceIds) => { await this.groupAction('addMembers', { groupId, memberDeviceIds }); },
      removeGroupMember: async (groupId, deviceId) => { await this.groupAction('removeMember', { groupId, deviceId }); },
      setGroupMemberRole: async (groupId, deviceId, role) => { await this.groupAction('changeRole', { groupId, deviceId, role }); },
      transferGroupOwnership: async (groupId, deviceId) => { await this.groupAction('transferOwnership', { groupId, deviceId }); },
      deleteGroup: async (groupId) => { await this.groupAction('deleteGroup', { groupId }); },
      leaveGroup: async (groupId) => { await this.groupAction('leave', { groupId }); },
      setGroupMessagePinned: async (groupId, messageId, pinned) => {
        await this.groupAction(pinned ? 'pin' : 'unpin', { groupId, messageId });
        const current = this.groupPins.get(groupId) || [];
        const next = pinned ? [messageId, ...current.filter((id) => id !== messageId)] : current.filter((id) => id !== messageId);
        this.groupPins.set(groupId, next);
        this.emit({ type: 'group:pins', groupId, messageIds: next });
      },
      getRelaySettings: async () => ({ automatic: false, host: window.location.hostname, port: RELAY_PORT, connected: this.socket?.readyState === WebSocket.OPEN, endpoint: this.socket?.readyState === WebSocket.OPEN ? endpoint() : null }),
      getStartupSettings: async () => ({ supported: false, openAtLogin: false, downloadsDir: '', doNotDisturbUntil: Number(window.localStorage.getItem('lantern.web.dnd') || 0) }),
      getUpdateState: async () => ({ supported: false, status: 'idle', currentVersion: 'web', relayVersion: null, downloaded: 0, total: 0, error: null }),
      forceUpdate: async () => ({ supported: false, status: 'idle', currentVersion: 'web', relayVersion: null, downloaded: 0, total: 0, error: null }),
      installUpdate: async () => undefined,
      updateRelaySettings: async () => this.api().getRelaySettings(),
      forceRelayRediscovery: async () => { await this.connect(); return this.api().getRelaySettings(); },
      updateStartupSettings: async (input) => { if (input.doNotDisturbUntil !== undefined) window.localStorage.setItem('lantern.web.dnd', String(input.doNotDisturbUntil)); return this.api().getStartupSettings(); },
      sendText: (peerId, text, replyTo) => this.dmText(peerId, text, replyTo),
      sendGroupText: async (groupId, text, replyTo) => { const messageId = uuid(); const createdAt = Date.now(); await this.groupAction('sendText', { groupId, messageId, createdAt, text, replyTo: this.reply(replyTo) }); const row = this.groupMessageFromEvent({ type: 'group.message.created', groupId, createdAt, payload: { message: { messageId, groupId, type: 'text', senderDeviceId: this.user!.userId, bodyText: text, replyTo, createdAt } } })!; this.mergeMessage(row); return row; },
      sendTyping: async (peerId, isTyping) => { await this.sendFrame({ type: 'typing', messageId: uuid(), from: this.user!.userId, to: peerId, createdAt: Date.now(), payload: { isTyping } }); },
      sendAnnouncement: async (text, replyTo) => { const frame = { type: 'announce', messageId: uuid(), from: this.user!.userId, to: null, createdAt: Date.now(), payload: { text, replyTo: this.reply(replyTo) } }; await this.sendFrame(frame); const row = this.messageFromFrame(frame)!; this.mergeMessage(row); return row; },
      sendAnnouncementFile: (filePath, replyTo) => this.sendCanonicalFile(null, filePath, replyTo),
      sendFile: (peerId, filePath, replyTo) => this.sendCanonicalFile(peerId, filePath, replyTo),
      sendGroupFile: async (groupId, filePath, replyTo) => {
        const file = this.fileForKey(filePath); const fileId = uuid(); const messageId = uuid(); const createdAt = Date.now(); const sha256 = await this.sha256(file); const total = attachmentChunkCount(file.size);
        const initialized = await this.groupAction('file:init', { groupId, createdAt, offer: { groupId, messageId, fileId, filename: file.name, size: file.size, sha256, replyTo: this.reply(replyTo) } });
        const startIndex = Math.max(0, Number(initialized.nextIndex || 0));
        await forEachFileChunk(file, startIndex, async (bytes, index) => {
          await new Promise<Json>((resolve, reject) => {
            const key = `${fileId}:${index}`;
            const timer = window.setTimeout(() => { this.groupChunkPending.delete(key); reject(new Error('O Relay não confirmou o bloco do anexo.')); }, 15_000);
            this.groupChunkPending.set(key, { resolve, reject, timer });
            this.send('relay:group:file:chunk', { fileId, index, total, dataBase64: this.bytesBase64(bytes) });
          });
        });
        await this.request('relay:group:file:complete', { fileId }, 30_000);
        const row = this.groupMessageFromEvent({ type: 'group.message.created', groupId, createdAt, payload: { message: { messageId, groupId, type: 'file', senderDeviceId: this.user!.userId, fileId, fileName: file.name, fileSize: file.size, fileSha256: sha256, replyTo, createdAt } } })!;
        const ready = { ...row, filePath: URL.createObjectURL(file) }; this.mergeMessage(ready); return ready;
      },
      forwardMessageToPeer: async (targetPeerId, sourceMessageId) => {
        const source = Array.from(this.messages.values()).flat().find((item) => item.messageId === sourceMessageId);
        if (!source) throw new Error('Mensagem não encontrada.');
        if (source.type !== 'file') {
          const frame = { type: 'chat:text', messageId: uuid(), from: this.user!.userId, to: targetPeerId, createdAt: Date.now(), payload: { text: source.bodyText || '', replyTo: null, forwardedFromMessageId: source.messageId } };
          await this.sendFrame(frame); const row = this.messageFromFrame(frame)!; this.mergeMessage(row); return row;
        }
        const available = source.filePath ? source : await this.downloadAttachment(source);
        if (!available.filePath) throw new Error('O anexo não pôde ser recuperado do Relay.');
        const blob = await fetch(available.filePath).then((response) => {
          if (!response.ok) throw new Error('O anexo não pôde ser lido para encaminhamento.');
          return response.blob();
        });
        const key = `webfile:${uuid()}`;
        this.files.set(key, { file: new File([blob], available.fileName || 'arquivo', { type: blob.type }), url: null });
        return this.sendCanonicalFile(targetPeerId, key, null, source.messageId);
      },
      editMessage: async (conversationId, messageId, text) => { if (conversationId.startsWith('group:')) await this.groupAction('editMessage', { groupId: conversationId.slice(6), targetMessageId: messageId, text }); else { const to = conversationId === 'announcements' ? null : conversationId.slice(3); await this.sendFrame({ type: 'chat:edit', messageId: uuid(), from: this.user!.userId, to, createdAt: Date.now(), payload: { targetMessageId: messageId, text, editedAt: Date.now() } }); } const existing = (this.messages.get(conversationId) || []).find((item) => item.messageId === messageId); if (!existing) return null; const updated = { ...existing, bodyText: text, editedAt: Date.now() }; this.mergeMessage(updated); return updated; },
      reactToMessage: async (conversationId, messageId, reaction) => {
        const updatedAt = Date.now();
        if (conversationId.startsWith('group:')) {
          await this.groupAction('react', { groupId: conversationId.slice(6), targetMessageId: messageId, reaction, updatedAt });
        } else {
          const to = conversationId === 'announcements' ? null : conversationId.slice(3);
          await this.sendFrame({ type: 'chat:react', messageId: uuid(), from: this.user!.userId, to, createdAt: updatedAt, payload: { targetMessageId: messageId, reaction } });
        }
        this.applyReaction(messageId, this.user!.userId, reaction, updatedAt, conversationId === 'announcements');
        return (this.messages.get(conversationId) || []).find((item) => item.messageId === messageId) || null;
      },
      deleteMessageForEveryone: async (conversationId, messageId) => { if (conversationId.startsWith('group:')) await this.groupAction('deleteMessage', { groupId: conversationId.slice(6), targetMessageId: messageId }); else { const to = conversationId === 'announcements' ? null : conversationId.slice(3); await this.sendFrame({ type: 'chat:delete', messageId: uuid(), from: this.user!.userId, to, createdAt: Date.now(), payload: { targetMessageId: messageId } }); } const existing = (this.messages.get(conversationId) || []).find((item) => item.messageId === messageId) || null; this.messages.set(conversationId, (this.messages.get(conversationId) || []).filter((item) => item.messageId !== messageId)); return existing; },
      deleteMessageForMe: async (conversationId, messageId) => { await this.http('/api/client/preferences/message', { method: 'PUT', body: JSON.stringify({ messageId, hidden: true }) }); const existing = (this.messages.get(conversationId) || []).find((item) => item.messageId === messageId) || null; this.messages.set(conversationId, (this.messages.get(conversationId) || []).filter((item) => item.messageId !== messageId)); return existing; },
      toggleMessageFavorite: async (_conversationId, messageId, favorite) => { await this.http('/api/client/preferences/message', { method: 'PUT', body: JSON.stringify({ messageId, favorite }) }); favorite ? this.favorites.add(messageId) : this.favorites.delete(messageId); return favorite; },
      getMessageFavorites: async (ids) => Object.fromEntries(ids.map((id) => [id, this.favorites.has(id)])),
      getFavoriteMessages: async (conversationId) => {
        const loaded = (this.messages.get(conversationId) || []).filter((item) => this.favorites.has(item.messageId));
        const missing = new Set([...this.favorites].filter((id) => !loaded.some((item) => item.messageId === id)));
        if (missing.size === 0 || conversationId === 'announcements') return loaded;
        const body = await this.http(`/api/client/export?conversationId=${encodeURIComponent(conversationId)}`);
        const rows = (Array.isArray(body.records) ? body.records : [])
          .filter((record: Json) => missing.has(String(record.messageId || '')))
          .map((record: Json): MessageRow => ({
            messageId: String(record.messageId), conversationId,
            direction: record.senderUserId === this.user?.userId ? 'out' : 'in', senderDeviceId: String(record.senderUserId || ''), receiverDeviceId: null,
            type: record.type === 'file' ? 'file' : 'text', bodyText: typeof record.text === 'string' ? record.text : null,
            fileId: null, fileName: typeof record.fileName === 'string' ? record.fileName : null, fileSize: Number(record.fileSize || 0) || null,
            fileSha256: null, filePath: null, status: 'delivered', reaction: null, deletedAt: null,
            replyToMessageId: null, replyToSenderDeviceId: null, replyToType: null, replyToPreviewText: null, replyToFileName: null,
            forwardedFromMessageId: null, editedAt: Number(record.editedAt || 0) || null, createdAt: Number(record.createdAt || 0)
          }));
        return [...loaded, ...rows];
      },
      resyncConversation: async (conversationId) => {
        // O cache atual continua utilizável até a página canônica ser confirmada.
        // Uma falha de rede nunca pode transformar reparo em limpeza de conversa.
        await this.api().getMessages(conversationId, 80);
      },
      getMessages: async (conversationId, limit, before) => {
        await this.connect();
        if (conversationId.startsWith('dm:')) { const result = await this.request('relay:history:request', { peerUserId: conversationId.slice(3), before: before || Number.MAX_SAFE_INTEGER, beforeSeq: this.beforeSeq.get(conversationId) || Number.MAX_SAFE_INTEGER, limit }); const frames = Array.isArray(result.frames) ? result.frames.map(asRecord) : []; const seqs = frames.map((frame) => Number(frame.serverSeq)).filter(Number.isFinite); if (seqs.length) this.beforeSeq.set(conversationId, Math.min(...seqs)); for (const frame of frames) this.applyCanonicalFrame(frame); }
        if (conversationId.startsWith('group:')) { const groupId = conversationId.slice(6); const result = await this.groupAction('history', { groupId, before: before || this.groupBefore.get(conversationId) || Number.MAX_SAFE_INTEGER, limit }); const events = Array.isArray(result.events) ? result.events.map(asRecord) : []; for (const event of events) this.applyGroupEvent(event); const times = events.map((event) => Number(event.createdAt)).filter(Number.isFinite); if (times.length) this.groupBefore.set(conversationId, Math.min(...times)); }
        const rows = (this.messages.get(conversationId) || []).filter((item) => !before || item.createdAt < before).slice(-limit);
        return (this.messages.get(conversationId) || []).filter((item) => rows.some((row) => row.messageId === item.messageId));
      },
      getMessagesByIds: async (ids) => {
        const rowsById = new Map(Array.from(this.messages.values()).flat().map((item) => [item.messageId, item]));
        for (const id of ids) if (!rowsById.has(id) && this.mediaMessages.has(id)) rowsById.set(id, this.mediaMessages.get(id)!);
        const rows = ids.map((id) => rowsById.get(id)).filter((item): item is MessageRow => Boolean(item));
        return Promise.all(rows.map((row) => row.type === 'file' && row.fileId && !row.filePath
          ? this.downloadAttachment(row).catch(() => row)
          : row));
      },
      retryMessage: async (messageId) => {
        const row = Array.from(this.messages.values()).flat()
          .find((candidate) => candidate.messageId === messageId);
        if (!row || row.direction !== 'out') throw new Error('Mensagem enviada não encontrada.');
        if (row.status !== 'failed') return row;
        const pending = { ...row, status: 'sent' as const };
        this.mergeMessage(pending);
        this.emit({ type: 'message:updated', message: pending });
        try {
          if (row.type === 'file') {
            throw new Error('O arquivo original não está mais disponível neste navegador. Selecione-o novamente.');
          }
          const replyTo = this.reply(row.replyToMessageId && row.replyToSenderDeviceId && row.replyToType ? {
            messageId: row.replyToMessageId,
            senderDeviceId: row.replyToSenderDeviceId,
            type: row.replyToType,
            previewText: row.replyToPreviewText,
            fileName: row.replyToFileName
          } : null);
          if (row.conversationId.startsWith('group:')) {
            await this.groupAction('sendText', {
              groupId: row.conversationId.slice(6), messageId: row.messageId,
              createdAt: row.createdAt, text: row.bodyText || '', replyTo
            });
          } else {
            const announcement = row.conversationId === 'announcements';
            await this.sendFrame({
              type: announcement ? 'announce' : 'chat:text',
              messageId: row.messageId,
              from: this.user!.userId,
              to: announcement ? null : row.receiverDeviceId || row.conversationId.slice(3),
              createdAt: row.createdAt,
              payload: announcement
                ? { text: row.bodyText || '', replyTo }
                : { text: row.bodyText || '', replyTo, forwardedFromMessageId: row.forwardedFromMessageId || null }
            });
          }
          const delivered = { ...row, status: 'delivered' as const };
          this.mergeMessage(delivered);
          this.emit({ type: 'message:updated', message: delivered });
          return delivered;
        } catch (error) {
          const failed = { ...row, status: 'failed' as const };
          this.mergeMessage(failed);
          this.emit({ type: 'message:updated', message: failed });
          throw error;
        }
      },
      retryAttachment: async (messageId) => {
        const row = Array.from(this.messages.values()).flat()
          .find((candidate) => candidate.messageId === messageId) || this.mediaMessages.get(messageId);
        if (!row || row.type !== 'file' || !row.fileId) {
          throw new Error('Anexo não encontrado.');
        }
        if (row.filePath) return row;
        const waiting = { ...row, status: 'sent' as const };
        this.mergeMessage(waiting);
        this.emit({ type: 'message:updated', message: waiting });
        try {
          return await this.downloadAttachment(waiting);
        } catch (error) {
          const failed = { ...waiting, status: 'failed' as const };
          this.mergeMessage(failed);
          this.emit({ type: 'message:updated', message: failed });
          throw error;
        }
      },
      listConversationMedia: async (
        conversationId: string,
        kind: ConversationMediaKind,
        cursor?: ConversationMediaCursor | null,
        limit = 40
      ): Promise<ConversationMediaPage> => {
        const result = conversationId.startsWith('group:')
          ? await this.groupAction('media', {
              groupId: conversationId.slice(6), kind, cursor: cursor || null, limit
            })
          : await this.request('relay:media:list:request', {
              peerUserId: conversationId.slice(3), kind, cursor: cursor || null, limit
            });
        const items = Array.isArray(result.items) ? result.items as ConversationMediaPage['items'] : [];
        for (const item of items) {
          const existing = (this.messages.get(conversationId) || []).find((message) => message.messageId === item.messageId);
          this.mediaMessages.set(item.messageId, existing || {
            messageId: item.messageId, conversationId,
            direction: item.senderUserId === this.user?.userId ? 'out' : 'in', senderDeviceId: item.senderUserId, receiverDeviceId: null,
            type: 'file', bodyText: null, fileId: item.fileId, fileName: item.fileName, fileSize: item.fileSize,
            fileSha256: null, filePath: null, status: 'delivered', reaction: null, deletedAt: null,
            replyToMessageId: null, replyToSenderDeviceId: null, replyToType: null, replyToPreviewText: null, replyToFileName: null,
            forwardedFromMessageId: null, editedAt: null, createdAt: item.createdAt
          });
        }
        return {
          items,
          nextCursor: result.nextCursor && typeof result.nextCursor === 'object'
            ? result.nextCursor as ConversationMediaCursor
            : null,
          hasMore: result.hasMore === true
        };
      },
      searchConversationMessageIds: async (conversationId, query, limit = 500, offset = 0) => { const result = conversationId.startsWith('group:') ? await this.groupAction('search', { groupId: conversationId.slice(6), query, limit, offset }) : await this.request('relay:search:request', { peerUserId: conversationId.slice(3), query, limit, offset }); return Array.isArray(result.messageIds) ? result.messageIds : []; },
      getConversationPreviews: async (ids) => Object.fromEntries(ids.map((id) => { const last = (this.messages.get(id) || []).at(-1); return [id, last?.type === 'file' ? `📎 ${last.fileName || 'Arquivo'}` : last?.bodyText || '']; })),
      getMessageReactions: async (ids) => Object.fromEntries(ids.map((id) => [id, this.reactions.get(id) || { counts: {}, myReaction: null }])),
      getAnnouncementReactions: async (ids) => Object.fromEntries(ids.map((id) => [id, this.reactions.get(id) || { counts: {}, myReaction: null }])),
      getAnnouncementReactionDetails: async (messageId) => this.reactionDetails(messageId),
      getMessageReactionDetails: async (messageId) => this.reactionDetails(messageId),
      getAnnouncementReadSummary: async (ids) => Object.fromEntries(ids.map((id) => [id, this.announcementReads.get(id) || { count: 0, readByMe: false }])),
      getAnnouncementReadDetails: async (messageId) => this.readDetails(messageId),
      exportConversation: async (conversationId, format) => {
        const body = await this.http(`/api/client/export?conversationId=${encodeURIComponent(conversationId)}`);
        const records = Array.isArray(body.records) ? body.records : [];
        const users = asRecord(body.users);
        const title = String(body.title || 'Conversa');
        const lines = records.map((row: Json) => {
          const sender = row.senderUserId === this.user?.userId ? 'Você' : String(users[String(row.senderUserId)] || `Contato ${String(row.senderUserId || '').slice(0, 6)}`);
          const content = row.type === 'file' ? `[arquivo] ${row.fileName || 'Arquivo'} (${Number(row.fileSize || 0)} bytes)` : String(row.text || '');
          return `[${new Date(Number(row.createdAt || 0)).toLocaleString('pt-BR')}] ${sender}${row.editedAt ? ' (editada)' : ''}: ${content}`;
        });
        const escape = (value: string) => value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] || char));
        const content = format === 'html'
          ? `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{max-width:900px;margin:40px auto;padding:0 20px;font:15px/1.55 system-ui;color:#1a2230}h1{font-size:24px}.message{padding:10px 0;border-bottom:1px solid #d4ddec;white-space:pre-wrap}</style><h1>${escape(title)}</h1><p>Exportado em ${escape(new Date().toLocaleString('pt-BR'))}</p>${lines.map((line) => `<div class="message">${escape(line)}</div>`).join('')}</html>`
          : [`Lantern - ${title}`, `Exportado em ${new Date().toLocaleString('pt-BR')}`, '', ...lines, ''].join('\n');
        const url = URL.createObjectURL(new Blob([content], { type: format === 'html' ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = `Lantern-${title.replace(/[^a-z0-9._-]+/gi, '-')}.${format}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        return { canceled: false, filePath: link.download };
      },
      setActiveConversation: async (id) => { this.activeConversation = id; },
      markConversationRead: async (id) => {
        this.unread[id] = 0;
        if (id === 'announcements') {
          const messageIds = (this.messages.get(id) || []).map((item) => item.messageId);
          if (messageIds.length) this.send('relay:announcement:read', { messageIds, readAt: Date.now() });
        } else if (id.startsWith('dm:')) {
          const peerId = id.slice(3);
          for (const message of (this.messages.get(id) || []).filter((item) => item.direction === 'in')) {
            void this.sendAck(peerId, message.messageId, 'read');
          }
        }
        await this.http('/api/client/preferences/conversation', { method: 'PUT', body: JSON.stringify({ conversationId: id, manualUnread: false, readAt: Date.now() }) });
      },
      markConversationUnread: async (id) => { this.unread[id] = Math.max(1, this.unread[id] || 0); await this.http('/api/client/preferences/conversation', { method: 'PUT', body: JSON.stringify({ conversationId: id, manualUnread: true }) }); },
      archiveConversation: async (id) => { await this.http('/api/client/preferences/conversation', { method: 'PUT', body: JSON.stringify({ conversationId: id, archived: true }) }); return 1; },
      unarchiveConversation: async (id) => { await this.http('/api/client/preferences/conversation', { method: 'PUT', body: JSON.stringify({ conversationId: id, archived: false }) }); return 1; },
      clearConversation: async (id) => { if (id.startsWith('dm:')) await this.sendFrame({ type: 'chat:clear', messageId: uuid(), from: this.user!.userId, to: id.slice(3), createdAt: Date.now(), payload: { scope: 'dm' } }); this.messages.set(id, []); this.emit({ type: 'conversation:cleared', conversationId: id }); },
      getConversations: async () => ({ ...this.unread }),
      getArchivedConversationIds: async () => { const body = await this.http('/api/client/preferences'); return (body.preferences?.conversations || []).filter((item: Json) => item.archived).map((item: Json) => item.conversationId); },
      getPinnedConversationIds: async () => { const body = await this.http('/api/client/preferences'); return (body.preferences?.conversations || []).filter((item: Json) => item.pinned).map((item: Json) => item.conversationId); },
      setConversationPinned: async (id, pinned) => { await this.http('/api/client/preferences/conversation', { method: 'PUT', body: JSON.stringify({ conversationId: id, pinned }) }); },
      pickFile: async () => (await this.pick(false))[0] || null,
      pickFiles: () => this.pick(true),
      pickDirectory: async () => null,
      openFile: async (key) => { const web = this.files.get(key); const url = web ? web.url || (web.url = URL.createObjectURL(web.file)) : key; window.open(url, '_blank', 'noopener,noreferrer'); },
      saveFileAs: async (key, name) => { const web = this.files.get(key); const url = web ? web.url || (web.url = URL.createObjectURL(web.file)) : key; const link = document.createElement('a'); link.href = url; link.download = name || web?.file.name || 'arquivo'; link.click(); },
      openExternalUrl: async (url) => { window.open(url, '_blank', 'noopener,noreferrer'); },
      nativePaste: async () => false,
      getFilePreview: async (key) => { const web = this.files.get(key); if (web) return web.url || (web.url = URL.createObjectURL(web.file)); return key.startsWith('blob:') ? key : null; },
      getDocumentPreview: async (key, fileName): Promise<DocumentPreviewResult> => {
        const web = this.files.get(key);
        if (!web) return { kind: 'unsupported', mimeType: 'application/octet-stream', url: null, text: null, truncated: false, reason: 'Arquivo indisponível.' };
        const effectiveName = (fileName || web.file.name || '').toLowerCase();
        const extension = effectiveName.includes('.') ? `.${effectiveName.split('.').pop()}` : '';
        if (extension === '.pdf' || web.file.type === 'application/pdf') {
          if (web.file.size > 20 * 1024 * 1024) return { kind: 'unsupported', mimeType: 'application/pdf', url: null, text: null, truncated: false, reason: 'Este PDF é grande demais para a prévia. Use Abrir para visualizá-lo.' };
          return { kind: 'pdf', mimeType: 'application/pdf', url: web.url || (web.url = URL.createObjectURL(web.file)), text: null, truncated: false, reason: null };
        }
        const textMimeByExt: Record<string, string> = {
          '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv',
          '.tsv': 'text/tab-separated-values', '.json': 'application/json', '.xml': 'application/xml',
          '.yaml': 'application/yaml', '.yml': 'application/yaml', '.log': 'text/plain', '.ini': 'text/plain',
          '.conf': 'text/plain', '.rtf': 'application/rtf'
        };
        const mimeType = textMimeByExt[extension];
        if (!mimeType) return { kind: 'unsupported', mimeType: web.file.type || 'application/octet-stream', url: null, text: null, truncated: false, reason: 'Este formato não possui prévia segura no Lantern.' };
        const maxBytes = 512 * 1024;
        const text = await web.file.slice(0, maxBytes).text();
        if (text.includes('\0')) return { kind: 'unsupported', mimeType, url: null, text: null, truncated: false, reason: 'O conteúdo deste arquivo não é texto legível.' };
        return { kind: 'text', mimeType, url: null, text, truncated: web.file.size > maxBytes, reason: null };
      },
      getFileInfo: async (key) => { const file = this.files.get(key)?.file; if (!file) return null; const ext = file.name.includes('.') ? file.name.split('.').pop() || '' : ''; return { name: file.name, size: file.size, ext, isImage: file.type.startsWith('image/') }; },
      getClipboardFilePaths: async () => [],
      clipboardHasFileLikeData: async () => false,
      saveClipboardImage: async (dataUrl, extension = 'png') => { const blob = await fetch(dataUrl).then((response) => response.blob()); const key = `webfile:${uuid()}`; this.files.set(key, { file: new File([blob], `imagem.${extension}`, { type: blob.type }), url: null }); return key; },
      saveClipboardFileData: async (dataUrl, fileName = 'arquivo') => { const blob = await fetch(dataUrl).then((response) => response.blob()); const key = `webfile:${uuid()}`; this.files.set(key, { file: new File([blob], fileName, { type: blob.type }), url: null }); return key; },
      getRelayStickers: async () => { const body = await this.http('/stickers', {}, false); return (body.stickers || []).map((item: StickerCatalogItem) => ({ ...item, url: `/stickers/${item.relativePath}`, previewDataUrl: `/stickers/${item.relativePath}` })); },
      prepareRelayStickerFile: async (relativePath) => { const response = await fetch(`/stickers/${relativePath}`); if (!response.ok) return null; const blob = await response.blob(); const key = `webfile:${uuid()}`; this.files.set(key, { file: new File([blob], relativePath.split('/').pop() || 'sticker.gif', { type: 'image/gif' }), url: null }); return key; },
      onEvent: (callback) => { this.events.add(callback); return () => this.events.delete(callback); }
    };
  }

  async logout(): Promise<void> {
    const token = this.token; this.intentionalClose = true; this.token = ''; this.user = null;
    window.localStorage.removeItem(TOKEN_KEY); window.sessionStorage.removeItem(TOKEN_KEY);
    if (this.socket) this.socket.close();
    if (token) await fetch('/api/client/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
    this.emit({ type: 'auth:changed', state: this.authState() });
  }
}

export const installWebLanternBridge = (): void => {
  if (window.lantern) return;
  window.lantern = new WebLanternBridge().api();
};
